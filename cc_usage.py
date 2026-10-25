"""cc 模式的额度条和排查记录接口。

GET /api/cc/usage   额度：5 小时窗口、每周（全部模型 / 各模型）的已用百分比和重置时间，
                    外加这个窗口里实际耗了多少 token、当前上下文多大
GET /api/cc/runs    最近几次 Claude Code 运行记录（排查用：图片送没送进去、MCP 连没连上、报了什么错）

百分比从哪来：
  Claude Code 的无头模式（claude -p）不输出用量百分比（官方没打算加）。
  这里去问 Claude 官方 app 里「/usage」用的那个接口（api.anthropic.com/api/oauth/usage）。
  它不是公开文档里的接口，以后可能会变；拿不到时自动退回「只显示重置时间 + 自己记的 token 数」。
  它要用 Claude 登录凭据里带 user:profile 权限的令牌：
    - 在服务器终端里 `claude` 登录（凭据在 CLAUDE_CONFIG_DIR/.credentials.json）→ 一般能拿到
    - 只用 `claude setup-token` 生成的长期令牌 → 这种令牌只能聊天，多半拿不到百分比
  令牌只在服务器上用来发这一个请求，不会返回给网页，也不会写日志。

token 数从哪来：
  cc_mode 每次回复结束时把 Claude Code 报的用量记进 cc_usage.json，这里按窗口加起来。
"""
import os
import threading
import time
from datetime import datetime

import requests
from flask import jsonify

import cc_mode

USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
CACHE_OK_SEC = 90          # 成功结果缓存多久（这个接口频繁调会 429）
CACHE_FAIL_SEC = 300       # 失败后多久再试
LABELS = {
    'five_hour': '当前会话',
    'seven_day': '每周 · 全部模型',
    'seven_day_sonnet': '每周 · Sonnet',
    'seven_day_opus': '每周 · Opus',
}
ORDER = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']

_lock = threading.Lock()
_cache = {'at': 0, 'ok': False, 'data': None, 'error': '', 'wait_until': 0}


def _ms(v):
    """ISO 时间 / 秒 / 毫秒 -> 毫秒。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v if v > 1e12 else v * 1000)
    try:
        return int(datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp() * 1000)
    except Exception:
        return None


def _tokens(data_dir):
    """依次试：登录凭据文件 -> 环境变量 -> /cc-login 存的令牌。返回 [(来源, 令牌)]。"""
    out = []
    base = (os.environ.get('CLAUDE_CONFIG_DIR') or '').strip() or os.path.expanduser('~/.claude')
    cred = cc_mode._jload(os.path.join(base, '.credentials.json'), {})
    oa = cred.get('claudeAiOauth') if isinstance(cred, dict) else None
    if isinstance(oa, dict) and oa.get('accessToken'):
        exp = oa.get('expiresAt')
        if not (isinstance(exp, (int, float)) and exp < time.time() * 1000):
            out.append(('登录凭据', oa['accessToken']))
    env_tok = (os.environ.get('CLAUDE_CODE_OAUTH_TOKEN') or '').strip()
    if env_tok:
        out.append(('环境变量令牌', env_tok))
    try:
        with open(os.path.join(data_dir, cc_mode.TOKEN_FILE_NAME), encoding='utf-8') as f:
            t = f.read().strip()
        if t and t != env_tok:
            out.append(('网页登录令牌', t))
    except OSError:
        pass
    return out


def _fetch_api(data_dir):
    """返回 (数据 or None, 错误说明)。带缓存。"""
    now = time.time()
    with _lock:
        age = now - _cache['at']
        if _cache['at'] and ((_cache['ok'] and age < CACHE_OK_SEC) or (not _cache['ok'] and age < CACHE_FAIL_SEC)):
            return _cache['data'], _cache['error']
        if now < _cache.get('wait_until', 0):
            # 刚被说「问得太勤」：先歇着，不然越问越被拒，一直卡在很久以前那份
            return (_cache['data'] if _cache['ok'] else None), '用量接口说问得太勤了，过几分钟再看'
    toks = _tokens(data_dir)
    data, err = None, ''
    if not toks:
        err = '服务器上没有找到 Claude 登录凭据'
    for src, tok in toks:
        try:
            r = requests.get(USAGE_URL, timeout=10, headers={
                'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json', 'User-Agent': 'ai-front-usage/1.0'})
        except Exception as e:
            err = f'连不上用量接口（{type(e).__name__}）'
            continue
        if r.status_code == 200:
            try:
                data, err = r.json(), ''
                break
            except Exception:
                err = '用量接口返回的不是 JSON'
                continue
        if r.status_code == 429:
            err = '用量接口说问得太勤了，过几分钟再看'
            with _lock:   # 429：歇 5 分钟再问，这期间沿用上一次的成功结果
                _cache['wait_until'] = now + 300
                if _cache['ok'] and _cache['data']:
                    return _cache['data'], err
        elif r.status_code in (401, 403):
            err = f'{src}没有查用量的权限（只能聊天的令牌查不了百分比）'
        else:
            err = f'用量接口返回 {r.status_code}'
    with _lock:
        _cache.update(at=now, ok=data is not None, data=data, error=err)
    return data, err


def _sum(items, since_ms):
    t = {'in': 0, 'out': 0, 'cr': 0, 'cw': 0, 'count': 0}
    for x in items:
        if x.get('ts', 0) >= since_ms:
            for k in ('in', 'out', 'cr', 'cw'):
                t[k] += int(x.get(k) or 0)
            t['count'] += 1
    t['total'] = t['in'] + t['out'] + t['cr'] + t['cw']
    return t


def build_usage(data_dir):
    api, api_err = _fetch_api(data_dir)
    events = cc_mode.load_rate_limits(data_dir)
    limits = {}
    if isinstance(api, dict):
        for k, v in api.items():
            if isinstance(v, dict) and v.get('utilization') is not None:
                try:
                    pct = float(v['utilization'])
                except (TypeError, ValueError):
                    continue
                limits[k] = {'key': k, 'label': LABELS.get(k, k), 'pct': max(0.0, min(100.0, pct)),
                             'resets_at': _ms(v.get('resets_at'))}
                # 这份数据是旧的、它的重置时间已经过了：那个百分比早就不对了，不显示
                ra = limits[k]['resets_at']
                if ra and ra < int(time.time() * 1000):
                    limits[k]['pct'] = None
                    limits[k]['stale'] = True
    # 接口没给的，用 Claude Code 自己报的限额事件补上重置时间（没有百分比）
    for k in ('five_hour', 'seven_day'):
        ev = events.get(k) or {}
        if k not in limits:
            limits[k] = {'key': k, 'label': LABELS[k], 'pct': ev.get('pct'), 'resets_at': ev.get('resets_at')}
        if ev.get('status'):
            limits[k]['status'] = ev['status']
    now_ms = int(time.time() * 1000)
    usage = cc_mode.load_usage(data_dir)
    windows = {}
    for k, span in (('five_hour', 5 * 3600 * 1000), ('seven_day', 7 * 86400 * 1000)):
        r = (limits.get(k) or {}).get('resets_at')
        since = (r - span) if (r and r > now_ms) else (now_ms - span)
        windows[k] = _sum(usage, since)
        windows[k]['since'] = since
    last = usage[-1] if usage else None
    ordered = [limits[k] for k in ORDER if k in limits] + \
              [v for k, v in limits.items() if k not in ORDER]
    return {
        'ok': True, 'cc_active': True, 'source': 'api' if api else 'local', 'api_error': '' if api else api_err,
        'updated': now_ms, 'limits': ordered, 'tokens': windows,
        'context': ({'tokens': int(last.get('in', 0)) + int(last.get('cr', 0)) + int(last.get('cw', 0)),
                     'out': int(last.get('out', 0)), 'ts': last.get('ts'), 'model': last.get('model')}
                    if last else None),
    }


def register_cc_usage(app, data_dir):
    @app.route('/api/cc/usage', methods=['GET'])
    def cc_usage():
        try:
            return jsonify(build_usage(data_dir))
        except Exception as e:
            return jsonify({'ok': False, 'error': f'读用量出错：{type(e).__name__}'})

    @app.route('/api/cc/runs', methods=['GET'])
    def cc_runs():
        return jsonify({'ok': True, 'runs': cc_mode.load_runs(data_dir)[:20]})
