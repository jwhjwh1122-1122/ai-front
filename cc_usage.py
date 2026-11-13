"""cc 模式的额度条和排查记录接口。

GET /api/cc/usage   额度：5 小时窗口、每周（全部模型 / 各模型）的已用百分比和重置时间，
                    外加这个窗口里实际耗了多少 token、当前上下文多大
GET /api/cc/runs    最近几次 Claude Code 运行记录（排查用：图片送没送进去、MCP 连没连上、报了什么错）

百分比从哪来：
  Claude Code 的无头模式（claude -p）不输出用量百分比（官方没打算加）。
  这里去问 Claude 官方 app 里「/usage」用的那个接口（api.anthropic.com/api/oauth/usage），
  跟官方同一个接口、同一种请求方式（翻官方 CLI 自己的代码核对过）。
  它不是公开文档里的接口，以后可能会变；拿不到时自动退回「只显示重置时间 + 自己记的 token 数」。
  只用聊天正在用的那个令牌去问（顺序同 cc_mode.active_token：环境变量 → /cc-login → 登录凭据文件），
  问不到就显示查不到，不换别的令牌、不拿旧结果顶上。缓存和本地记录都按账号分开。
  它要用带 user:profile 权限的令牌：
    - 在服务器终端里 `claude` 登录（凭据在 CLAUDE_CONFIG_DIR/.credentials.json）→ 一般能拿到。
      这种登录凭据的 accessToken 几小时就过期，这里按官方同款接口自动刷新（见 ensure_fresh_credential_token），
      不用等服务器上有人手动跑一遍 `claude` 才续上。
    - 只用 `claude setup-token` 生成的长期令牌，或环境变量 CLAUDE_CODE_OAUTH_TOKEN
      → 这种令牌默认只有 user:inference 一个权限范围，天生查不了百分比（官方客户端一样查不到，
      不是这边的故障，也没有 refresh_token 能刷新出权限）。

响应里除了 five_hour / seven_day 这些扁平字段，还有一个 limits 数组，是服务器自己算好的展示行
（percent / resets_at / severity / scope，官方真正的 /usage 界面就是直接拿这个数组渲染的）。
这边优先用 limits 数组里的数；拿不到这个数组（老版本接口、或者这次请求没返回）才退回自己拼 five_hour/seven_day。

token 数从哪来：
  cc_mode 每次回复结束时把 Claude Code 报的用量记进 cc_usage.json，这里按窗口加起来。
"""
import fcntl
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
    'seven_day_fable': '每周 · Fable',
}
ORDER = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_fable']
SEV_CLASS = {'critical': 'full', 'warning': 'warn', 'normal': ''}   # 服务器给的 severity -> 前端的颜色 class

# 跟官方 CLI 同一套：登录凭据（.credentials.json）快过期/过期了，用 refresh_token 换新的再查用量。
# env 变量令牌、/cc-login 令牌没有 refresh_token，刷不了，不处理。
OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'   # 官方 CLI 的 prod client_id（代码里翻出来的）
REFRESH_MARGIN_MS = 5 * 60 * 1000   # 离过期不到 5 分钟就提前刷，别等它真过期

_lock = threading.Lock()
_cache = {'acct': None, 'at': 0, 'ok': False, 'data': None, 'error': '', 'wait_until': 0, 'scope_limited': False}


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


def _fetch_api(data_dir, src, tok, acct):
    """返回 (数据 or None, 错误说明, 是不是「这种令牌天生查不了」这种没救的权限不足)。
    只用聊天正在用的那一个令牌去问（cc_mode.active_token），问不到就是问不到，
    不换别的令牌兜底——别的令牌可能是旧账号的，查出来的是别人的额度。
    缓存按账号分开；查失败时返回 None，不拿上一次成功的旧结果顶上。"""
    now = time.time()
    with _lock:
        if _cache.get('acct') != acct:      # 换账号了：上一个账号的缓存一概不用
            _cache.clear()
            _cache.update(acct=acct, at=0, ok=False, data=None, error='', wait_until=0, scope_limited=False)
        age = now - _cache['at']
        if _cache['at'] and ((_cache['ok'] and age < CACHE_OK_SEC) or (not _cache['ok'] and age < CACHE_FAIL_SEC)):
            return (_cache['data'] if _cache['ok'] else None), _cache['error'], _cache.get('scope_limited', False)
        if now < _cache.get('wait_until', 0):
            # 刚被说「问得太勤」：先歇着，不然越问越被拒
            return None, '用量接口说问得太勤了，过几分钟再看', False
    data, err, scope_limited = None, '', False
    if not tok:
        err = f'{src}，查不了' if src else '服务器上没有找到 Claude 令牌'
    else:
        try:
            r = requests.get(USAGE_URL, timeout=10, headers={
                'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json', 'User-Agent': 'ai-front-usage/1.0'})
            if r.status_code == 200:
                try:
                    data = r.json()
                except Exception:
                    err = '用量接口返回的不是 JSON'
            elif r.status_code == 429:
                err = '用量接口说问得太勤了，过几分钟再看'
                with _lock:
                    _cache['wait_until'] = now + 300
            elif r.status_code in (401, 403):
                if src in ('环境变量令牌', '网页登录令牌'):
                    err = f'{src}只有聊天权限，查不了用量——这种令牌（setup-token / 环境变量）天生就没有查用量需要的权限范围，' \
                          f'不是故障；要查百分比得在服务器终端用 `claude` 交互式登录一次'
                    scope_limited = True
                else:
                    err = f'{src}没有查用量的权限'
            else:
                err = f'用量接口返回 {r.status_code}'
        except Exception as e:
            err = f'连不上用量接口（{type(e).__name__}）'
    with _lock:
        if _cache.get('acct') == acct:
            _cache.update(at=now, ok=data is not None, data=data, error=err, scope_limited=scope_limited)
    return data, err, scope_limited


def reset_cache():
    """/cc-login 换了令牌后调用。别的 worker 进程里的缓存靠账号键对不上自动作废。"""
    with _lock:
        _cache.clear()
        _cache.update(acct=None, at=0, ok=False, data=None, error='', wait_until=0)


def _oauth_endpoints():
    """跟 cc_mode.active_token 一样认 CLAUDE_CODE_CUSTOM_OAUTH_URL / CLAUDE_CODE_OAUTH_CLIENT_ID 这两个环境变量，
    没设就用官方 prod 的地址。"""
    base = (os.environ.get('CLAUDE_CODE_CUSTOM_OAUTH_URL') or '').strip().rstrip('/')
    token_url = f'{base}/v1/oauth/token' if base else OAUTH_TOKEN_URL
    client_id = (os.environ.get('CLAUDE_CODE_OAUTH_CLIENT_ID') or '').strip() or OAUTH_CLIENT_ID
    return token_url, client_id


def _refresh_credentials_locked(path):
    """假定调用者已经拿到文件锁。没到期不用刷新直接返回现成的；到期/快到期了才真的发请求、写回。"""
    cred = cc_mode._jload(path, {})
    oa = cred.get('claudeAiOauth') if isinstance(cred, dict) else None
    if not isinstance(oa, dict) or not oa.get('accessToken'):
        return ''
    exp = oa.get('expiresAt')
    now_ms = time.time() * 1000
    if isinstance(exp, (int, float)) and exp - now_ms > REFRESH_MARGIN_MS:
        return oa['accessToken']   # 还没到要刷新的时候，不发请求
    rt = oa.get('refreshToken')
    expired = isinstance(exp, (int, float)) and exp < now_ms
    if not rt:
        return '' if expired else (oa.get('accessToken') or '')
    token_url, client_id = _oauth_endpoints()
    body = {'grant_type': 'refresh_token', 'refresh_token': rt, 'client_id': client_id}
    scopes = oa.get('scopes')
    if isinstance(scopes, list) and scopes:
        body['scope'] = ' '.join(str(s) for s in scopes)   # 原样续回原来那些权限范围，不多要也不少要
    try:
        r = requests.post(token_url, json=body, timeout=10, headers={'Content-Type': 'application/json'})
    except Exception as e:
        print(f'[cc_usage] 刷新登录令牌失败（连不上）: {type(e).__name__}', flush=True)
        return '' if expired else (oa.get('accessToken') or '')
    if r.status_code != 200:
        print(f'[cc_usage] 刷新登录令牌失败: {r.status_code}', flush=True)
        return '' if expired else (oa.get('accessToken') or '')
    try:
        data = r.json()
    except Exception:
        return '' if expired else (oa.get('accessToken') or '')
    new_access = data.get('access_token')
    if not new_access:
        return '' if expired else (oa.get('accessToken') or '')
    new_oa = dict(oa)
    new_oa['accessToken'] = new_access
    new_oa['refreshToken'] = data.get('refresh_token') or rt
    try:
        new_oa['expiresAt'] = now_ms + float(data.get('expires_in')) * 1000
    except (TypeError, ValueError):
        pass
    if data.get('scope'):
        new_oa['scopes'] = str(data['scope']).split(' ')
    new_cred = dict(cred)
    new_cred['claudeAiOauth'] = new_oa
    try:
        cc_mode._jsave(path, new_cred)
    except Exception as e:
        print(f'[cc_usage] 刷新后写回凭据失败: {type(e).__name__}', flush=True)
    return new_access


def ensure_fresh_credential_token(base):
    """登录凭据（.credentials.json）快过期/过期了就刷新，跟官方 CLI 同一个刷新接口，写回原文件。
    服务器上的 `claude` 本体可能同时也在刷这份凭据，这里用一把文件锁跟它（以及我们自己的并发请求）错开，
    避免两边同时写坏这个文件、或者用同一个 refresh_token 刷两次。"""
    path = os.path.join(base, '.credentials.json')
    try:
        lf = open(path + '.refresh.lock', 'a+')
    except OSError:
        return ''
    try:
        try:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        except OSError:
            pass
        return _refresh_credentials_locked(path)
    finally:
        try:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        lf.close()


def _row_key(row, idx):
    """limits[] 里一行对应咱们哪个老 key；认不出的新种类给一个稳定的 key，不丢数据。"""
    kind = row.get('kind') or ''
    model = ((row.get('scope') or {}).get('model') or {}).get('display_name') \
        if isinstance(row.get('scope'), dict) else None
    if kind == 'session':
        return 'five_hour'
    if kind == 'weekly_all':
        return 'seven_day'
    if kind == 'weekly_scoped' and isinstance(model, str):
        low = model.lower()
        if 'opus' in low:
            return 'seven_day_opus'
        if 'sonnet' in low:
            return 'seven_day_sonnet'
        if 'fable' in low:
            return 'seven_day_fable'
        return 'seven_day_scoped_' + low.replace(' ', '_')
    return f'row_{idx}_{kind or "other"}'


def _row_label(row):
    """服务器没直接给整句标签，这里按它给的 kind/scope 拼一个；没见过的新种类也能拼出个说得过去的名字。"""
    kind = row.get('kind') or ''
    scope = row.get('scope') if isinstance(row.get('scope'), dict) else {}
    model = (scope.get('model') or {}).get('display_name') if isinstance(scope.get('model'), dict) else None
    surface = (scope.get('surface') or {}).get('display_name') if isinstance(scope.get('surface'), dict) else None
    if kind == 'session':
        return '当前会话'
    if kind == 'weekly_all':
        return '每周 · 全部模型'
    if model:
        return f'每周 · {model}'
    if surface:
        return f'每周 · {surface}'
    return f'用量 · {row.get("group") or kind or "其它"}'


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
    src, tok, acct = cc_mode.active_token(data_dir)
    if src.startswith('登录凭据'):
        # 这条路有 refresh_token，跟官方 CLI 一样先确保没过期，而不是过期了就放弃
        base = (os.environ.get('CLAUDE_CONFIG_DIR') or '').strip() or os.path.expanduser('~/.claude')
        refreshed = ensure_fresh_credential_token(base)
        if refreshed:
            tok, src = refreshed, '登录凭据'
    api, api_err, scope_limited = _fetch_api(data_dir, src, tok, acct)
    events = cc_mode.load_rate_limits(data_dir, acct)   # 只看当前账号的
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
        # limits 数组是服务器自己算好的展示行（官方 /usage 界面就是直接拿它渲染的），有就优先用它的
        # percent / severity，覆盖掉上面自己拼的那份；不是在猜，百分比本身应该一样，只是标签和颜色改成服务器的判断
        rows = api.get('limits')
        if isinstance(rows, list):
            for idx, row in enumerate(rows):
                if not isinstance(row, dict) or row.get('percent') is None:
                    continue
                try:
                    pct = float(row['percent'])
                except (TypeError, ValueError):
                    continue
                k = _row_key(row, idx)
                ra = _ms(row.get('resets_at'))
                stale = bool(ra and ra < int(time.time() * 1000))
                limits[k] = {
                    'key': k, 'label': LABELS.get(k) or _row_label(row),
                    'pct': None if stale else max(0.0, min(100.0, pct)),
                    'resets_at': ra, 'stale': stale,
                    'sev_cls': SEV_CLASS.get(row.get('severity'), ''),
                }
    # 接口没给的，用 Claude Code 自己报的限额事件补上重置时间（没有百分比）
    for k in ('five_hour', 'seven_day'):
        ev = events.get(k) or {}
        ev_ra = ev.get('resets_at')
        ev_old = bool(ev_ra and ev_ra < int(time.time() * 1000))   # 那个窗口已经重置过，事件里的数不作数
        if k not in limits:
            limits[k] = {'key': k, 'label': LABELS[k], 'pct': None if ev_old else ev.get('pct'),
                         'resets_at': ev_ra}
        if ev.get('status') and not ev_old:
            limits[k]['status'] = ev['status']
    now_ms = int(time.time() * 1000)
    usage = cc_mode.load_usage(data_dir, acct)   # 只算当前账号的，新旧账号不混在一起
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
        'scope_limited': scope_limited,
        'updated': now_ms, 'limits': ordered, 'tokens': windows, 'account': acct,
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
