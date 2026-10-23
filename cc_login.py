"""/cc-login：在网页里完成 `claude setup-token` 登录（不用 Zeabur 终端）。

只有设置了环境变量 CC_LOGIN_PASSWORD 才启用，否则这个地址返回 404。
每次请求都要带上这个密码。拿到的长期令牌存到 <数据目录>/.cc_oauth_token（权限 600），
cc 模式启动 claude 时会自动用它（环境变量 CLAUDE_CODE_OAUTH_TOKEN 优先）。
令牌不会完整显示在页面上，也不会写进日志。
"""
import fcntl, hmac, html, os, pty, re, select, signal, struct, termios, threading, time

from flask import request, abort

import cc_mode

SESSION_TTL = 600          # 10 分钟没完成就自动结束
COLS, ROWS = 2000, 50      # 很宽的终端，避免链接/令牌被折行

_lock = threading.Lock()
_sess = None               # {'pid','fd','buf','started','timer'}

_ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'   # OSC（含超链接）
                   r'|\x1b\[[0-?]*[ -/]*[@-~]'              # CSI
                   r'|\x1b[@-Z\\-_]'                        # 其他两字节转义
                   r'|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
_OSC8 = re.compile(r'\x1b\]8;[^;]*;(https://[^\x07\x1b]+)(?:\x07|\x1b\\)')
_URL = re.compile(r'https://[^\s\'"<>│]+')
_TOKEN = re.compile(r'sk-ant-oat[A-Za-z0-9_\-]+')
_TOKCH = re.compile(r'[A-Za-z0-9_\-]+')


def _clean(raw):
    t = _ANSI.sub('', raw.replace('\r\n', '\n').replace('\r', '\n'))
    return t


def _mask(t):
    return re.sub(r'sk-ant-[A-Za-z0-9_\-]*', lambda m: m.group()[:12] + '…', t)


def _find_url(raw):
    cands = _OSC8.findall(raw) + _URL.findall(_clean(raw))
    for u in cands:
        if 'oauth' in u or 'authorize' in u:
            return u.rstrip('.,)')
    return ''


def _find_token(raw):
    lines = _clean(raw).split('\n')
    for i, line in enumerate(lines):
        m = _TOKEN.search(line)
        if not m:
            continue
        tok = m.group()
        # 万一被折行：令牌写到了行尾、偏短，且下一行全是令牌字符，就接上
        rest = line[m.end():].strip(' │|')
        j = i + 1
        while not rest and len(tok) < 100 and j < len(lines):
            nxt = lines[j].strip().strip('│|').strip()
            if not nxt or not _TOKCH.fullmatch(nxt):
                break
            tok += nxt
            j += 1
        return tok
    return ''


def _kill_locked():
    global _sess
    s = _sess
    _sess = None
    if not s:
        return
    try:
        s['timer'].cancel()
    except Exception:
        pass
    try:
        os.kill(s['pid'], signal.SIGKILL)
    except OSError:
        pass
    try:
        os.close(s['fd'])
    except OSError:
        pass
    try:
        os.waitpid(s['pid'], 0)
    except OSError:
        pass


def _expire(pid):
    with _lock:
        if _sess and _sess['pid'] == pid:
            _kill_locked()


def _alive(s):
    try:
        pid, _ = os.waitpid(s['pid'], os.WNOHANG)
        return pid == 0
    except OSError:
        return False


def _pump(s, timeout, until):
    """读 PTY 输出，直到 until(buf) 为真、进程结束或超时。"""
    end = time.time() + timeout
    while True:
        if until(s['buf']):
            return True
        left = end - time.time()
        if left <= 0:
            return False
        try:
            r, _, _ = select.select([s['fd']], [], [], min(left, 0.5))
        except OSError:
            return until(s['buf'])
        if not r:
            if not _alive(s):
                return until(s['buf'])
            continue
        try:
            chunk = os.read(s['fd'], 65536)
        except OSError:          # 子进程退出后读 PTY 会报 EIO
            return until(s['buf'])
        if not chunk:
            return until(s['buf'])
        if b'\x1b[6n' in chunk:  # 终端界面询问光标位置，回一个，免得它卡住
            try:
                os.write(s['fd'], b'\x1b[1;1R')
            except OSError:
                pass
        s['buf'] = (s['buf'] + chunk.decode('utf-8', 'replace'))[-300000:]


def _start(data_dir):
    global _sess
    _kill_locked()
    env = cc_mode.child_env(data_dir)
    env.pop('CLAUDE_CODE_OAUTH_TOKEN', None)
    env.update(COLUMNS=str(COLS), LINES=str(ROWS), TERM='xterm-256color')
    binp = os.environ.get('CC_BIN') or 'claude'
    winsz = struct.pack('HHHH', ROWS, COLS, 0, 0)
    pid, fd = pty.fork()
    if pid == 0:  # 子进程
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, winsz)
            os.execvpe(binp, [binp, 'setup-token'], env)
        finally:
            os._exit(127)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)
    except OSError:
        pass
    t = threading.Timer(SESSION_TTL, _expire, args=(pid,))
    t.daemon = True
    t.start()
    _sess = {'pid': pid, 'fd': fd, 'buf': '', 'started': time.time(), 'timer': t}
    return _sess


def _save_token(data_dir, tok):
    path = os.path.join(data_dir, cc_mode.TOKEN_FILE_NAME)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(tok + '\n')
    os.chmod(path, 0o600)


def _tail(raw, n=3000):
    t = _clean(raw)
    t = re.sub(r'\n{3,}', '\n\n', '\n'.join(l.rstrip() for l in t.split('\n')))
    return _mask(t.strip())[-n:]


_PAGE = '''<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>CC 登录</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px;line-height:1.6;background:#fff;color:#222}}
input[type=text],input[type=password],textarea{{width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin:6px 0}}
textarea{{height:110px;word-break:break-all;font-family:monospace;font-size:13px}}
button{{padding:10px 18px;font-size:16px;margin:6px 6px 6px 0}}
.msg{{padding:10px;border-radius:6px;background:#f3f3f3;margin:10px 0}}
.ok{{background:#e6f6e6}} .err{{background:#fdeaea}}
pre{{white-space:pre-wrap;word-break:break-all;background:#f6f6f6;padding:8px;font-size:12px;max-height:300px;overflow:auto}}
a{{word-break:break-all}}
</style></head><body><h2>Claude Code 网页登录</h2>{body}</body></html>'''


def _form(pw, action, label, extra=''):
    return (f'<form method="post">{extra}'
            f'<input type="hidden" name="pw" value="{html.escape(pw)}">'
            f'<input type="hidden" name="action" value="{action}">'
            f'<button type="submit">{label}</button></form>')


def register_cc_login(app, data_dir):
    @app.route('/cc-login', methods=['GET', 'POST'])
    def cc_login():
        want = os.environ.get('CC_LOGIN_PASSWORD') or ''
        if not want:
            abort(404)
        pw = request.form.get('pw', '') if request.method == 'POST' else ''
        ok = bool(pw) and hmac.compare_digest(pw.encode('utf-8'), want.encode('utf-8'))
        if not ok:
            if pw:
                time.sleep(1)
            msg = '<div class="msg err">密码不对。</div>' if pw else ''
            return _PAGE.format(body=msg + '<form method="post">'
                                '<input type="password" name="pw" placeholder="登录页密码（CC_LOGIN_PASSWORD）">'
                                '<input type="hidden" name="action" value="start">'
                                '<button type="submit">开始登录</button></form>')

        action = request.form.get('action', '')
        parts = []
        with _lock:
            s = _sess
            if action == 'cancel':
                _kill_locked()
                parts.append('<div class="msg">已取消。</div>' + _form(pw, 'start', '开始登录'))
                return _PAGE.format(body=''.join(parts))

            if action == 'start' or not s:
                try:
                    s = _start(data_dir)
                except Exception as e:
                    return _PAGE.format(body=f'<div class="msg err">启动失败：{html.escape(_mask(str(e)))}</div>'
                                        + _form(pw, 'start', '重试'))
                _pump(s, 30, lambda b: bool(_find_url(b)))

            elif action == 'code':
                code = (request.form.get('code') or '').strip()
                if code:
                    try:
                        os.write(s['fd'], code.encode('utf-8'))
                        time.sleep(0.3)
                        os.write(s['fd'], b'\r')
                    except OSError:
                        pass
                    _pump(s, 60, lambda b: bool(_find_token(b)))
                tok = _find_token(s['buf'])
                if tok:
                    try:
                        _save_token(data_dir, tok)
                    except Exception as e:
                        return _PAGE.format(body=f'<div class="msg err">拿到令牌但保存失败：'
                                            f'{html.escape(_mask(str(e)))}</div>')
                    _kill_locked()
                    print('[cc-login] 令牌已保存', flush=True)
                    return _PAGE.format(body='<div class="msg ok">已保存，cc模式会自动使用。<br>'
                                        f'令牌：<code>{html.escape(tok[:12])}…</code></div>'
                                        '<p>用完可以在 Zeabur 里删掉 CC_LOGIN_PASSWORD，关闭这个页面。</p>')
                parts.append('<div class="msg err">还没拿到令牌。看看下面的输出；'
                             '如果码贴错了可以再贴一次，或者重新开始。</div>')

            elif action == 'enter':
                # 命令行先问别的（比如让按回车/选主题）时，用这个按一下回车
                try:
                    os.write(s['fd'], b'\r')
                except OSError:
                    pass
                _pump(s, 15, lambda b: bool(_find_url(b)))

            else:  # refresh
                _pump(s, 3, lambda b: False)

            url = _find_url(s['buf'])
            alive = _alive(s)
            raw = s['buf']

        if url:
            parts.append('<p><b>第 1 步：</b>打开这个链接，登录并授权：</p>'
                         f'<p><a href="{html.escape(url)}" target="_blank" rel="noopener">{html.escape(url)}</a></p>'
                         f'<p>打不开就复制这里：</p><textarea readonly onclick="this.select()">{html.escape(url)}</textarea>')
        else:
            parts.append('<div class="msg err">没找到登录链接，看看下面的输出。</div>')
        if not alive:
            parts.append('<div class="msg err">登录进程已经结束了，需要重新开始。</div>')
        parts.append('<p><b>第 2 步：</b>把授权页给的码粘贴到这里：</p>'
                     '<form method="post">'
                     f'<input type="hidden" name="pw" value="{html.escape(pw)}">'
                     '<input type="hidden" name="action" value="code">'
                     '<input type="text" name="code" autocomplete="off" placeholder="把授权页给的码粘贴到这里">'
                     '<button type="submit">提交</button></form>')
        parts.append(_form(pw, 'refresh', '刷新输出') + _form(pw, 'enter', '按一下回车')
                     + _form(pw, 'start', '重新开始') + _form(pw, 'cancel', '取消'))
        parts.append('<details><summary>命令行输出（调试用）</summary>'
                     f'<pre>{html.escape(_tail(raw))}</pre></details>')
        return _PAGE.format(body=''.join(parts))
