"""cc 模式：聊天不走上游 API，改为在服务器上调用 Claude Code 无头模式（claude -p）。

开关（任一成立即开启，默认关闭，原有行为完全不变）：
  - upstream.json 里 "mode": "cc"
  - 环境变量 CHAT_BACKEND=cc

可选环境变量：
  CC_BIN               claude 可执行文件路径，默认 "claude"
  CC_MODEL             传给 --model（也可在 upstream.json 里写 "cc_model"）。
                       前端选了模型时优先用前端的（去掉 "anthropic/" 这类前缀）
  CC_MCP_CONFIG        MCP 配置文件路径。不设时自动生成一个，只挂记忆库 Ombre Brain
  CC_OB_URL            自动配置里记忆库的地址，默认 https://jwhjwh.zeabur.app/mcp
  CC_AUTO_MCP=0        关掉自动挂记忆库
  CC_ALLOWED_TOOLS     传给 --allowedTools，例如 "mcp__ob__*"（逗号或空格分隔）；
                       自动挂记忆库且没设这个时，默认放行 mcp__ob__*
  CC_PERMISSION_MODE   传给 --permission-mode
  CC_TIMEOUT           单次回复的超时秒数，默认 600（10 分钟）
  CC_CWD               claude 的工作目录，默认 <数据目录>/cc_workspace
  CC_KEEP_API_KEY=1    默认会把 ANTHROPIC_API_KEY 等从子进程环境里去掉，
                       保证走订阅登录；设为 1 则保留

省内存相关（2GB 小机器，防止容器被 Evicted）：
  CC_MAX_CONCURRENT    同时最多跑几个 claude，默认 1
  CC_QUEUE_WAIT        正在跑的时候，新请求最多排队等几秒，默认 20；等不到就返回 429「他还在回上一条」
  CC_LEAN_ENV=0        关掉下面这几个默认省资源开关（默认开）：
                         CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1（不自动更新/不上报/不拉实验开关）
                         CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1（不留后台 shell，聊天用不到）
                         CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1（不给文件改动做快照，聊天用不到）
                       这些都是「没设才补上」，在 Zeabur 里显式设了别的值会以你的为准
  CC_NODE_MAX_OLD_SPACE_MB  默认不设。设了才给 claude 加 --max-old-space-size=<值>；
                       删掉这个变量就恢复原样。太小会让长会话直接崩，不建议低于 768

输出：把 claude 的 stream-json 逐行翻译成前端已经在用的 Anthropic 风格 SSE
（message_start / content_block_* / message_delta / [DONE]），前端不用改。
"""
import glob
import hashlib
import json
import os
import queue
import re
import signal
import subprocess
import threading
import time

THINK, TEXT = 0, 1
PING_EVERY = 5           # 秒；没有输出时发 SSE 注释保活，也借此尽快发现客户端断开、早点收掉子进程
MEM_SAMPLE_EVERY = 5     # 秒；跑的时候多久量一次 claude 进程组的内存
HISTORY_MAX_MSGS = 30    # 第一次（没有 session）时带上的历史条数上限
HISTORY_MAX_CHARS = 12000
SYS_ARG_MAX = 100_000    # 系统提示超过这个字节数就改用 --append-system-prompt-file

_map_lock = threading.Lock()
_MODEL_RE = re.compile(r'^[A-Za-z0-9._:-]+$')


def clean_model(m):
    """'anthropic/claude-opus-4-7' -> 'claude-opus-4-7'；不像模型名的返回 ''。"""
    if not isinstance(m, str):
        return ''
    m = m.strip().rsplit('/', 1)[-1].strip()
    return m if m and len(m) <= 128 and _MODEL_RE.match(m) else ''


def pick_model(req_model, upstream_cfg):
    """顺序：前端选的 -> CC_MODEL -> upstream.json cc_model -> ''（不传 --model）。"""
    return (clean_model(req_model)
            or clean_model(os.environ.get('CC_MODEL') or '')
            or clean_model((upstream_cfg or {}).get('cc_model') or ''))


def sse(obj):
    return 'data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n'


def is_cc_mode(upstream_cfg):
    if (os.environ.get('CHAT_BACKEND') or '').strip().lower() == 'cc':
        return True
    return str((upstream_cfg or {}).get('mode') or '').strip().lower() == 'cc'


# ------------------------------------------------------------
# 全局并发限制：一台 2GB 的机器同时只跑一个 claude（Node 进程本身就要几百 MB）
# ------------------------------------------------------------
def _env_int(name, default, lo=None):
    try:
        v = int(float(os.environ.get(name) or default))
    except Exception:
        v = default
    return max(lo, v) if lo is not None else v


MAX_CONCURRENT = _env_int('CC_MAX_CONCURRENT', 1, lo=1)
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_stat_lock = threading.Lock()
_stat = {'running': 0, 'waiting': 0}
BUSY_TEXT = '他还在回上一条消息，等他说完再发一次吧'


def concurrency():
    with _stat_lock:
        return dict(_stat, max=MAX_CONCURRENT)


class Slot:
    """拿到的一个运行名额。release() 可以重复调用，只会真正还一次。"""

    def __init__(self, waited):
        self.waited = waited
        self._done = False
        self._lock = threading.Lock()

    def release(self):
        with self._lock:
            if self._done:
                return
            self._done = True
        with _stat_lock:
            _stat['running'] = max(0, _stat['running'] - 1)
        _slots.release()

    def __del__(self):
        # 兜底：万一响应对象没被正常关闭，被回收时也把名额还回去
        try:
            self.release()
        except Exception:
            pass


def acquire_slot(wait=None):
    """排队拿名额。最多等 CC_QUEUE_WAIT 秒，拿不到返回 None（调用方回 429）。"""
    if wait is None:
        wait = _env_int('CC_QUEUE_WAIT', 20, lo=0)
    t0 = time.time()
    ok = False
    with _stat_lock:
        _stat['waiting'] += 1
    try:
        ok = _slots.acquire(timeout=wait) if wait > 0 else _slots.acquire(blocking=False)
    finally:
        with _stat_lock:
            _stat['waiting'] -= 1
            if ok:
                _stat['running'] += 1
    waited = time.time() - t0
    st = concurrency()
    if not ok:
        print(f'[cc] 忙，排队 {waited:.1f}s 没等到，返回 429 '
              f'(running={st["running"]}/{st["max"]} waiting={st["waiting"]})', flush=True)
        return None
    if waited >= 0.5:
        print(f'[cc] 排队 {waited:.1f}s 后拿到名额 (running={st["running"]}/{st["max"]})', flush=True)
    return Slot(waited)


class GuardedStream:
    """包住 stream_chat 生成器：流结束、出错或客户端断开（WSGI 调 close）时，
    先关生成器（里面会收掉 claude 子进程），再把名额还回去。"""

    def __init__(self, gen, slot):
        self._gen, self._slot = gen, slot

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._gen)
        except BaseException:
            self._slot.release()
            raise

    def close(self):
        try:
            self._gen.close()
        finally:
            self._slot.release()


# ------------------------------------------------------------
# 内存 / 进程组工具（只读 /proc 和 cgroup，不记任何聊天内容）
# ------------------------------------------------------------
def _read_int(path):
    try:
        with open(path) as f:
            s = f.read().strip()
        return None if s == 'max' else int(s)
    except Exception:
        return None


def _mb(b):
    return '?' if b is None else f'{b / 1048576:.0f}MB'


def container_mem():
    """容器（cgroup）已用/上限，读不到的写 ?。"""
    used = _read_int('/sys/fs/cgroup/memory.current')
    limit = _read_int('/sys/fs/cgroup/memory.max')
    if used is None:   # cgroup v1
        used = _read_int('/sys/fs/cgroup/memory/memory.usage_in_bytes')
        limit = _read_int('/sys/fs/cgroup/memory/memory.limit_in_bytes')
        if limit and limit > (1 << 60):
            limit = None
    avail = None
    try:
        with open('/proc/meminfo') as f:
            for ln in f:
                if ln.startswith('MemAvailable:'):
                    avail = int(ln.split()[1]) * 1024
                    break
    except Exception:
        pass
    return used, limit, avail


def _rss(pid):
    try:
        with open(f'/proc/{pid}/status') as f:
            for ln in f:
                if ln.startswith('VmRSS:'):
                    return int(ln.split()[1]) * 1024
    except Exception:
        pass
    return 0


def group_pids(pgid):
    """进程组 pgid 里还活着的进程（不含僵尸）。"""
    out = []
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open(f'/proc/{d}/stat') as f:
                s = f.read()
            rest = s[s.rindex(')') + 2:].split()
            # rest[0]=state, rest[2]=pgrp
            if int(rest[2]) == pgid and rest[0] != 'Z':
                out.append(int(d))
        except Exception:
            continue
    return out


def group_rss(pgid):
    return sum(_rss(p) for p in group_pids(pgid))


def mem_line():
    used, limit, avail = container_mem()
    return (f'container={_mb(used)}/{_mb(limit)} gunicorn_rss={_mb(_rss(os.getpid()))} '
            f'host_avail={_mb(avail)}')


def _short(key):
    return hashlib.sha1(str(key).encode('utf-8', 'ignore')).hexdigest()[:8]


def _session_file_size(session_id):
    """续会话时 claude 要把整份会话记录读进内存，记录越长越吃内存，记一下大小方便排查。"""
    if not session_id or not re.match(r'^[A-Za-z0-9-]+$', session_id):
        return None
    base = (os.environ.get('CLAUDE_CONFIG_DIR') or '').strip() or os.path.expanduser('~/.claude')
    try:
        for p in glob.glob(os.path.join(base, 'projects', '*', session_id + '.jsonl')):
            return os.path.getsize(p)
    except Exception:
        pass
    return None


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


DEFAULT_OB_URL = 'https://jwhjwh.zeabur.app/mcp'


def auto_mcp_config(cwd):
    """没设 CC_MCP_CONFIG 时，自动写一份只挂记忆库的 MCP 配置，返回路径；关掉了返回空。"""
    if os.environ.get('CC_AUTO_MCP') == '0':
        return ''
    url = (os.environ.get('CC_OB_URL') or DEFAULT_OB_URL).strip()
    if not url:
        return ''
    path = os.path.join(cwd, '.mcp_auto.json')
    cfg = {'mcpServers': {'ob': {'type': 'http', 'url': url}}}
    try:
        old = open(path, encoding='utf-8').read()
    except Exception:
        old = ''
    new = json.dumps(cfg, ensure_ascii=False)
    if old != new:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(new)
        os.replace(tmp, path)
    return path


def build_cmd(system_prompt, resume_id, upstream_cfg, sys_file=None, auto_mcp='', req_model=None):
    cmd = [os.environ.get('CC_BIN') or 'claude', '-p',
           '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if resume_id:
        cmd += ['--resume', resume_id]
    if system_prompt:
        if sys_file:
            cmd += ['--append-system-prompt-file', sys_file]
        else:
            cmd += ['--append-system-prompt', system_prompt]
    # 每次调用都带上（包括 --resume 续会话），这样中途换模型也能生效
    model = pick_model(req_model, upstream_cfg)
    if model:
        cmd += ['--model', model]
    mcp = (os.environ.get('CC_MCP_CONFIG') or '').strip() or auto_mcp
    if mcp:
        # 用 = 的写法：--mcp-config 是可变参数，避免把后面的东西吞进去
        cmd.append('--mcp-config=' + mcp)
    allowed = _split_list(os.environ.get('CC_ALLOWED_TOOLS') or '')
    if not allowed and auto_mcp and not (os.environ.get('CC_MCP_CONFIG') or '').strip():
        allowed = ['mcp__ob__*']
    if allowed:
        cmd.append('--allowedTools=' + ','.join(allowed))
    pm = (os.environ.get('CC_PERMISSION_MODE') or '').strip()
    if pm:
        cmd += ['--permission-mode', pm]
    # 用户消息不放进命令行参数，而是从 stdin 喂进去（claude -p 无参数时读 stdin）：
    # 不经过 shell、没有注入问题，也不受单个参数 128KB 的长度限制。
    return cmd


TOKEN_FILE_NAME = '.cc_oauth_token'   # /cc-login 网页登录后存的长期令牌（在数据目录里）


def _file_token(data_dir):
    if not data_dir:
        return ''
    try:
        with open(os.path.join(data_dir, TOKEN_FILE_NAME), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


def child_env(data_dir=None):
    env = dict(os.environ)
    if not (os.environ.get('CLAUDE_CODE_OAUTH_TOKEN') or '').strip():
        # 环境变量优先；没设时用 /cc-login 存下的令牌
        tok = _file_token(data_dir)
        if tok:
            env['CLAUDE_CODE_OAUTH_TOKEN'] = tok
    if os.environ.get('CC_KEEP_API_KEY') != '1':
        # 有这些变量时 claude 会改用 API 计费，而不是订阅登录
        for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'):
            env.pop(k, None)
    if os.environ.get('CC_LEAN_ENV') != '0':
        # 只在没设的时候补上；Zeabur 里显式设了的值优先
        env.setdefault('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
        env.setdefault('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1')
        env.setdefault('CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING', '1')
    heap = (os.environ.get('CC_NODE_MAX_OLD_SPACE_MB') or '').strip()
    if heap.isdigit() and int(heap) > 0:
        opts = env.get('NODE_OPTIONS') or ''
        if '--max-old-space-size' not in opts:
            env['NODE_OPTIONS'] = (opts + f' --max-old-space-size={int(heap)}').strip()
    return env


def _signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass
    except Exception:
        pass


def _kill(proc, graceful=False):
    """收掉 claude 以及它在同一进程组里拉起的所有子进程（MCP、shell 等）。

    graceful=True：claude 已经正常输出完（stdout 到头了），先给它最多 5 秒自己退出，
    让它把会话记录写完，保证下次 --resume 能接上；超时才发信号。
    返回清理时还残留的进程数（用于日志）。
    """
    pgid = proc.pid   # start_new_session=True，所以进程组号 = claude 的 pid
    if graceful and proc.poll() is None:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    # 组长退出了，组里也可能还有孙子进程占着内存，所以不管组长在不在都检查整组
    left = group_pids(pgid)
    if proc.poll() is None or left:
        _signal_group(pgid, signal.SIGTERM)
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        end = time.time() + 3
        while time.time() < end:
            if proc.poll() is not None and not group_pids(pgid):
                break
            time.sleep(0.1)
        if proc.poll() is None or group_pids(pgid):
            _signal_group(pgid, signal.SIGKILL)
            try:
                proc.kill()
            except Exception:
                pass
    try:
        proc.wait(timeout=5)   # 回收，避免僵尸
    except Exception:
        pass
    return len(left)


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
                if self.text_emitted:
                    self.need_sep = True
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


def _spawn(cmd, stdin_text, cwd, data_dir=None):
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=child_env(data_dir),
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

    threads = []
    for fn in (feed, read_out, read_err):
        th = threading.Thread(target=fn, daemon=True)
        th.start()
        threads.append(th)
    proc._cc_threads = threads
    return proc, q, err_tail


def _cleanup(proc, graceful=False):
    """杀进程组 + 等读线程结束 + 关管道，避免残留进程和文件句柄。返回残留进程数。"""
    left = _kill(proc, graceful=graceful)
    for th in getattr(proc, '_cc_threads', []):
        th.join(timeout=2)
    for p in (proc.stdin, proc.stdout, proc.stderr):
        try:
            if p:
                p.close()
        except Exception:
            pass
    return left


def _error_text(msg):
    # 以「（出错了」开头：music.py 会据此把它过滤掉，不当成聊天气泡
    return f'（出错了 cc：{msg}）'


def stream_chat(*, messages, system_prompt, key, data_dir, upstream_cfg, model=None):
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
    tag = _short(key)
    try:
        while True:
            attempt += 1
            stdin_text = prompt
            if not resume_id and history:
                tr = history_transcript(history)
                if tr:
                    stdin_text = ('（下面是你们之前的聊天记录，供你接上话，不用复述）\n'
                                  f'{tr}\n（记录结束）\n\n{prompt}')
            cmd = build_cmd(system_prompt, resume_id, upstream_cfg, sys_file,
                            auto_mcp=auto_mcp_config(cwd), req_model=model)
            run = _Run(data_dir, key)
            sf =_session_file_size(resume_id)
            st = concurrency()
            # 只记元数据：不记提示词、聊天内容、令牌
            print(f'[cc] 启动 #{tag} attempt={attempt} model={pick_model(model, upstream_cfg) or "default"} '
                  f'resume={"yes" if resume_id else "no"}'
                  + (f' session_file={_mb(sf)}' if sf is not None else '')
                  + f' running={st["running"]}/{st["max"]} waiting={st["waiting"]} {mem_line()}',
                  flush=True)
            t_start = time.time()
            try:
                proc, q, err_tail = _spawn(cmd, stdin_text, cwd, data_dir)
            except FileNotFoundError:
                print(f'[cc] 启动失败 #{tag}：找不到 claude 命令', flush=True)
                for c in run.text(_error_text('服务器上找不到 claude 命令，请确认镜像里装了 @anthropic-ai/claude-code')):
                    yield c
                break
            except Exception as e:
                print(f'[cc] 启动失败 #{tag}：{type(e).__name__}', flush=True)
                for c in run.text(_error_text(f'启动 claude 失败：{e}')):
                    yield c
                break

            deadline = time.time() + timeout
            timed_out = False
            got_eof = False
            outcome = 'client_gone'   # 没正常走完就是前端断开了（GeneratorExit）
            peak = 0
            next_sample = 0.0
            try:
                while True:
                    now = time.time()
                    if now >= next_sample:
                        next_sample = now + MEM_SAMPLE_EVERY
                        peak = max(peak, group_rss(proc.pid))
                    left = deadline - now
                    if left <= 0:
                        timed_out = True
                        break
                    try:
                        kind, raw = q.get(timeout=min(PING_EVERY, left))
                    except queue.Empty:
                        yield ': ping\n\n'   # 前端只认 data: 行，注释会被忽略
                        continue
                    if kind == 'eof':
                        got_eof = True
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
                outcome = 'timeout' if timed_out else 'done'
            except Exception:
                outcome = 'error'
                raise
            finally:
                # 正常结束：给 claude 几秒自己退出、写完会话记录；
                # 超时或客户端断开（Flask 关闭生成器 -> GeneratorExit）：直接收掉整个进程组
                peak = max(peak, group_rss(proc.pid))
                leftover = _cleanup(proc, graceful=got_eof)
                res = run.result or {}
                print(f'[cc] 结束 #{tag} outcome={outcome} exit={proc.returncode} '
                      f'dur={time.time() - t_start:.1f}s api_ms={res.get("duration_api_ms", "?")} '
                      f'turns={res.get("num_turns", "?")} peak_rss={_mb(peak)} '
                      f'cleaned={leftover} {mem_line()}', flush=True)

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
