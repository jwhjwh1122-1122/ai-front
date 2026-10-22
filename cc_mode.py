"""cc 模式：聊天不走上游 API，改为在服务器上调用 Claude Code 无头模式（claude -p）。

开关（任一成立即开启，默认关闭，原有行为完全不变）：
  - upstream.json 里 "mode": "cc"
  - 环境变量 CHAT_BACKEND=cc

可选环境变量：
  CC_BIN               claude 可执行文件路径，默认 "claude"
  CC_MODEL             传给 --model（也可在 upstream.json 里写 "cc_model"）
  CC_MCP_CONFIG        MCP 配置文件路径，设置了才加 --mcp-config
  CC_ALLOWED_TOOLS     传给 --allowedTools，例如 "mcp__lin__*"（逗号或空格分隔）
  CC_PERMISSION_MODE   传给 --permission-mode
  CC_TIMEOUT           单次回复的超时秒数，默认 600（10 分钟）
  CC_CWD               claude 的工作目录，默认 <数据目录>/cc_workspace
  CC_KEEP_API_KEY=1    默认会把 ANTHROPIC_API_KEY 等从子进程环境里去掉，
                       保证走订阅登录；设为 1 则保留

输出：把 claude 的 stream-json 逐行翻译成前端已经在用的 Anthropic 风格 SSE
（message_start / content_block_* / message_delta / [DONE]），前端不用改。
"""
import json
import os
import queue
import signal
import subprocess
import threading
import time

THINK, TEXT = 0, 1
PING_EVERY = 15          # 秒；没有输出时发 SSE 注释保活，也借此发现客户端断开
HISTORY_MAX_MSGS = 30    # 第一次（没有 session）时带上的历史条数上限
HISTORY_MAX_CHARS = 12000
SYS_ARG_MAX = 100_000    # 系统提示超过这个字节数就改用 --append-system-prompt-file

_map_lock = threading.Lock()


def sse(obj):
    return 'data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n'


def is_cc_mode(upstream_cfg):
    if (os.environ.get('CHAT_BACKEND') or '').strip().lower() == 'cc':
        return True
    return str((upstream_cfg or {}).get('mode') or '').strip().lower() == 'cc'


# ------------------------------------------------------------
# 前端会话 id  ->  claude session_id 的映射，存成 json 文件
# ------------------------------------------------------------
def _map_path(data_dir):
    return os.path.join(data_dir, 'cc_sessions.json')


def _map_load(data_dir):
    try:
        with open(_map_path(data_dir), 'r', encoding='utf-8') as f:
            return json.load(f) or {}
    except Exception:
        return {}


def get_session(data_dir, key):
    return (_map_load(data_dir).get(key) or {}).get('session_id')


def set_session(data_dir, key, session_id):
    with _map_lock:
        m = _map_load(data_dir)
        if session_id:
            m[key] = {'session_id': session_id, 'ts': int(time.time())}
        else:
            m.pop(key, None)
        tmp = _map_path(data_dir) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _map_path(data_dir))


# ------------------------------------------------------------
# 从前端发来的 messages 里取出这一轮要说的话
# ------------------------------------------------------------
def _text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if not isinstance(b, dict):
            continue
        t = b.get('type')
        if t == 'text':
            out.append(b.get('text', ''))
        elif t in ('image', 'image_url'):
            out.append('（发了一张图片，cc 模式下暂时看不到图片）')
        elif t == 'tool_result':
            c = b.get('content')
            out.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    return '\n'.join(x for x in out if x)


def split_messages(messages):
    """返回 (之前的历史, 本轮用户消息文本)。本轮 = 最后一条助手消息之后的所有用户消息。"""
    msgs = [m for m in (messages or []) if isinstance(m, dict)]
    i = len(msgs)
    while i > 0 and msgs[i - 1].get('role') != 'assistant':
        i -= 1
    tail = [m for m in msgs[i:] if m.get('role') == 'user']
    prompt = '\n\n'.join(t for t in (_text_of(m.get('content')).strip() for m in tail) if t)
    return msgs[:i], prompt


def history_transcript(history):
    lines = []
    for m in history[-HISTORY_MAX_MSGS:]:
        t = _text_of(m.get('content')).strip()
        if not t:
            continue
        who = '你' if m.get('role') == 'assistant' else '对方'
        lines.append(f'{who}：{t}')
    s = '\n'.join(lines)
    if len(s) > HISTORY_MAX_CHARS:
        s = '……' + s[-HISTORY_MAX_CHARS:]
    return s


# ------------------------------------------------------------
# 组装命令
# ------------------------------------------------------------
def _split_list(s):
    return [x for x in s.replace(',', ' ').split() if x]


def build_cmd(system_prompt, resume_id, upstream_cfg, sys_file=None):
    cmd = [os.environ.get('CC_BIN') or 'claude', '-p',
           '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if resume_id:
        cmd += ['--resume', resume_id]
    if system_prompt:
        if sys_file:
            cmd += ['--append-system-prompt-file', sys_file]
        else:
            cmd += ['--append-system-prompt', system_prompt]
    model = (os.environ.get('CC_MODEL') or (upstream_cfg or {}).get('cc_model') or '').strip()
    if model:
        cmd += ['--model', model]
    mcp = (os.environ.get('CC_MCP_CONFIG') or '').strip()
    if mcp:
        # 用 = 的写法：--mcp-config 是可变参数，避免把后面的东西吞进去
        cmd.append('--mcp-config=' + mcp)
    allowed = _split_list(os.environ.get('CC_ALLOWED_TOOLS') or '')
    if allowed:
        cmd.append('--allowedTools=' + ','.join(allowed))
    pm = (os.environ.get('CC_PERMISSION_MODE') or '').strip()
    if pm:
        cmd += ['--permission-mode', pm]
    # 用户消息不放进命令行参数，而是从 stdin 喂进去（claude -p 无参数时读 stdin）：
    # 不经过 shell、没有注入问题，也不受单个参数 128KB 的长度限制。
    return cmd


def child_env():
    env = dict(os.environ)
    if os.environ.get('CC_KEEP_API_KEY') != '1':
        # 有这些变量时 claude 会改用 API 计费，而不是订阅登录
        for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'):
            env.pop(k, None)
    return env


def _kill(proc):
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


_RESUME_MISS = ('no conversation found', 'session not found', 'no session found')


# ------------------------------------------------------------
# 跑一次 claude，把输出翻成前端格式
# ------------------------------------------------------------
class _Run:
    def __init__(self, data_dir, key):
        self.data_dir, self.key = data_dir, key
        self.text_open = self.think_open = False
        self.text_emitted = False
        self.need_sep = False
        self.streamed_ids = set()
        self.cur_msg_id = None
        self.usage = {}
        self.result = None
        self.session_id = None

    def _open_text(self):
        if self.text_open:
            return []
        self.text_open = True
        return [sse({'type': 'content_block_start', 'index': TEXT,
                     'content_block': {'type': 'text', 'text': ''}})]

    def text(self, t):
        if not t:
            return []
        out = self._open_text()
        if self.need_sep and self.text_emitted:
            t = '\n\n' + t
        self.need_sep = False
        self.text_emitted = True
        out.append(sse({'type': 'content_block_delta', 'index': TEXT,
                        'delta': {'type': 'text_delta', 'text': t}}))
        return out

    def thinking(self, t):
        if not t:
            return []
        out = []
        if not self.think_open:
            self.think_open = True
            out.append(sse({'type': 'content_block_start', 'index': THINK,
                            'content_block': {'type': 'thinking', 'thinking': ''}}))
        out.append(sse({'type': 'content_block_delta', 'index': THINK,
                        'delta': {'type': 'thinking_delta', 'thinking': t}}))
        return out

    def _sid(self, d):
        sid = d.get('session_id')
        if sid and sid != self.session_id:
            self.session_id = sid
            try:
                set_session(self.data_dir, self.key, sid)
            except Exception as e:
                print(f'[cc] 保存 session 失败: {e}', flush=True)

    def handle(self, d):
        """处理 stream-json 的一行，返回要发给前端的 SSE 片段列表。"""
        t = d.get('type')
        if t == 'system':
            if d.get('subtype') == 'init':
                self._sid(d)
            return []
        if d.get('parent_tool_use_id'):
            return []   # 子代理的内部输出，不显示
        if t == 'stream_event':
            ev = d.get('event') or {}
            et = ev.get('type')
            if et == 'message_start':
                self.cur_msg_id = (ev.get('message') or {}).get('id')
                if self.text_emitted:
                    self.need_sep = True
                return []
            if et == 'content_block_delta':
                dl = ev.get('delta') or {}
                if dl.get('type') == 'text_delta':
                    if self.cur_msg_id:
                        self.streamed_ids.add(self.cur_msg_id)
                    return self.text(dl.get('text', ''))
                if dl.get('type') == 'thinking_delta':
                    if self.cur_msg_id:
                        self.streamed_ids.add(self.cur_msg_id)
                    return self.thinking(dl.get('thinking', ''))
            return []
        if t == 'assistant':
            # 兜底：如果这条消息没有逐字流（老版本 CLI 或没开 partial），就整段发
            msg = d.get('message') or {}
            if msg.get('id') and msg['id'] in self.streamed_ids:
                return []
            out = []
            for b in msg.get('content') or []:
                if b.get('type') == 'text':
                    out += self.text(b.get('text', ''))
                elif b.get('type') == 'thinking':
                    out += self.thinking(b.get('thinking', ''))
            if out and msg.get('id'):
                self.streamed_ids.add(msg['id'])
            if self.text_emitted:
                self.need_sep = True
            return out
        if t == 'result':
            self._sid(d)
            self.result = d
            u = d.get('usage') or {}
            self.usage = {k: u[k] for k in ('input_tokens', 'output_tokens',
                                            'cache_read_input_tokens',
                                            'cache_creation_input_tokens') if k in u}
            return []
        return []

    def close_blocks(self):
        out = []
        if self.think_open:
            out.append(sse({'type': 'content_block_stop', 'index': THINK}))
            self.think_open = False
        if self.text_open:
            out.append(sse({'type': 'content_block_stop', 'index': TEXT}))
            self.text_open = False
        return out


def _spawn(cmd, stdin_text, cwd):
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=child_env(),
                            start_new_session=True)   # 自成进程组，kill 时连 MCP 子进程一起收掉
    q = queue.Queue()
    err_tail = []

    def feed():
        try:
            proc.stdin.write(stdin_text.encode('utf-8'))
        except Exception:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    def read_out():
        try:
            for raw in proc.stdout:
                q.put(('line', raw))
        except Exception:
            pass
        q.put(('eof', None))

    def read_err():
        try:
            for raw in proc.stderr:
                err_tail.append(raw.decode('utf-8', 'ignore'))
                del err_tail[:-40]
        except Exception:
            pass

    for fn in (feed, read_out, read_err):
        threading.Thread(target=fn, daemon=True).start()
    return proc, q, err_tail


def _error_text(msg):
    # 以「（出错了」开头：music.py 会据此把它过滤掉，不当成聊天气泡
    return f'（出错了 cc：{msg}）'


def stream_chat(*, messages, system_prompt, key, data_dir, upstream_cfg):
    """生成器：产出前端格式的 SSE。"""
    timeout = float(os.environ.get('CC_TIMEOUT') or 600)
    cwd = (os.environ.get('CC_CWD') or '').strip() or os.path.join(data_dir, 'cc_workspace')
    os.makedirs(cwd, exist_ok=True)

    history, prompt = split_messages(messages)
    if not prompt:
        prompt = '（对方没有说话）'

    sys_file = None
    if system_prompt and len(system_prompt.encode('utf-8')) > SYS_ARG_MAX:
        sys_file = os.path.join(cwd, f'.sys_{os.getpid()}_{threading.get_ident()}.txt')
        with open(sys_file, 'w', encoding='utf-8') as f:
            f.write(system_prompt)

    yield sse({'type': 'message_start', 'message': {'usage': {}}})

    resume_id = get_session(data_dir, key)
    attempt = 0
    run = None
    try:
        while True:
            attempt += 1
            stdin_text = prompt
            if not resume_id and history:
                tr = history_transcript(history)
                if tr:
                    stdin_text = ('（下面是你们之前的聊天记录，供你接上话，不用复述）\n'
                                  f'{tr}\n（记录结束）\n\n{prompt}')
            cmd = build_cmd(system_prompt, resume_id, upstream_cfg, sys_file)
            run = _Run(data_dir, key)
            try:
                proc, q, err_tail = _spawn(cmd, stdin_text, cwd)
            except FileNotFoundError:
                for c in run.text(_error_text('服务器上找不到 claude 命令，请确认镜像里装了 @anthropic-ai/claude-code')):
                    yield c
                break
            except Exception as e:
                for c in run.text(_error_text(f'启动 claude 失败：{e}')):
                    yield c
                break

            deadline = time.time() + timeout
            timed_out = False
            try:
                while True:
                    left = deadline - time.time()
                    if left <= 0:
                        timed_out = True
                        break
                    try:
                        kind, raw = q.get(timeout=min(PING_EVERY, left))
                    except queue.Empty:
                        yield ': ping\n\n'   # 前端只认 data: 行，注释会被忽略
                        continue
                    if kind == 'eof':
                        break
                    line = raw.decode('utf-8', 'ignore').strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    for c in run.handle(d):
                        yield c
            finally:
                # 客户端断开时 Flask 会关闭这个生成器（GeneratorExit），这里把子进程杀掉
                _kill(proc)

            if timed_out:
                print(f'[cc] 超时 {timeout:.0f}s，已结束子进程', flush=True)
                for c in run.text(_error_text(f'超过 {int(timeout)} 秒没说完，已中断')):
                    yield c
                break

            res = run.result
            err = ''.join(err_tail).strip()
            failed = res is None or res.get('is_error') or (res.get('subtype') not in (None, 'success'))
            if failed:
                detail = ''
                if res is not None:
                    detail = str(res.get('result') or res.get('subtype') or '')
                    errs = res.get('errors')
                    if errs:
                        detail += ' ' + json.dumps(errs, ensure_ascii=False)[:300]
                if not detail:
                    detail = err[-400:] or f'claude 退出码 {proc.returncode}'
                low = (detail + ' ' + err).lower()
                # 续会话失败（比如凭据目录没持久化，旧会话文件没了）：丢掉映射，重开一次
                if (resume_id and attempt == 1 and not run.text_emitted
                        and any(s in low for s in _RESUME_MISS)):
                    print(f'[cc] 续会话 {resume_id} 失败，重开新会话：{detail[:200]}', flush=True)
                    set_session(data_dir, key, None)
                    resume_id = None
                    continue
                print(f'[cc] 出错：{detail[:400]}', flush=True)
                for c in run.text(_error_text(detail[:300])):
                    yield c
            elif not run.text_emitted and res.get('result'):
                # 兜底：没收到任何增量，就用 result 里的全文
                for c in run.text(res['result']):
                    yield c
            break
    finally:
        if sys_file:
            try:
                os.remove(sys_file)
            except Exception:
                pass

    if run is not None:
        for c in run.close_blocks():
            yield c
        usage = run.usage
    else:
        usage = {}
    yield sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': usage})
    yield 'data: [DONE]\n\n'


def keepalive_stream():
    """cc 模式下前端的「续缓存」心跳没有意义，直接空回复，不消耗额度。"""
    yield sse({'type': 'message_start', 'message': {'usage': {}}})
    yield sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {}})
    yield 'data: [DONE]\n\n'
