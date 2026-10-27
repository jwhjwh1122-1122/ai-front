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
  CC_EFFORT            思考深度默认值（low / medium / high / xhigh / max），网页设置里选了就以网页为准；都没有就不传
  CC_SYSTEM_PROMPT_MODE=append  人设接在 Claude Code 默认系统提示后面（默认 replace：整个换掉，不当写代码助手）
  CC_THINK_ZH=0        不把非中文的思考翻成中文（默认会翻：模型思考用什么语言靠指令锁不住）
                       翻译默认只用 DeepSeek（DEEPSEEK_API_KEY）或「上游」小模型，不花 Claude 额度；
                       都没有就不显示这轮的外文思考
  CC_THINK_ZH_FALLBACK=haiku  上面两个都不行时，用一次小的 Claude Code 翻（会用一点订阅额度，默认关）
  CC_THINKING_DISPLAY  思考怎么显示，默认 summarized（能看到他的思考）。可选 summarized / highlights / omitted；
                       设成 off 就不传这个参数（新版 Claude Code 无头模式下默认不给思考文字）
  CC_WEB_MCP=0         不把网页「设置 → MCP」里自己加的服务器交给 Claude Code（默认会交）
  CC_LIN_MCP=0         不自动挂「家里的工具」（app 自带的本地 MCP：朋友圈、碎碎念、犯错本、书房……）。默认挂上
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
import uuid

THINK, TEXT = 0, 1
PING_EVERY = 5           # 秒；没有输出时发 SSE 注释保活，也借此尽快发现客户端断开、早点收掉子进程
MEM_SAMPLE_EVERY = 5     # 秒；跑的时候多久量一次 claude 进程组的内存
# 开新会话时把网页带来的历史（已经按上下文设置裁好）原样垫进去。以前卡 30 条 / 1.2 万字，设成「全部」也只看得到一截
HISTORY_MAX_MSGS = int(os.environ.get('CC_HISTORY_MAX_MSGS') or 0)        # 0 = 网页给多少带多少
HISTORY_MAX_CHARS = int(os.environ.get('CC_HISTORY_MAX_CHARS') or 150000)
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
    先关生成器，再把名额还回去。
    客户端断开时如果 claude 还在说，生成器会把它交给后台把话说完（holder['detached']），
    这时名额由后台说完再还，免得同时跑两个 claude。"""

    def __init__(self, gen, slot, holder=None):
        self._gen, self._slot = gen, slot
        self._holder = holder if holder is not None else {}
        self._holder['slot'] = slot

    def __iter__(self):
        return self

    def _release(self):
        if not self._holder.get('detached'):
            self._slot.release()

    def __next__(self):
        try:
            return next(self._gen)
        except BaseException:
            self._release()
            raise

    def close(self):
        try:
            self._gen.close()
        finally:
            self._release()


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
# 排查和额度用的小记录（只有元数据：时间、数字、状态，没有聊天内容和令牌）
#   cc_runs.json       最近 40 次运行：结果、耗时、图片送没送进去、各 MCP 连没连上
#   cc_usage.json      每次回复的 token 用量（保留 8 天），算 5 小时窗口 / 一周用了多少
#   cc_ratelimit.json  Claude Code 报出来的限额状态（什么时候重置、是否快到了）
# ------------------------------------------------------------
_rec_lock = threading.Lock()
RUNS_MAX = 40
USAGE_KEEP_SEC = 8 * 86400


def _jload(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _jsave(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def _pick(d, *keys):
    for k in keys:
        if d.get(k) is not None:
            return d.get(k)
    return None


def note_rate_limit(data_dir, info):
    """stream-json 里的 rate_limit_event。字段名有驼峰也有下划线，两种都认。没有百分比。"""
    kind = str(_pick(info, 'rateLimitType', 'rate_limit_type') or 'unknown')[:30]
    resets = _pick(info, 'resetsAt', 'resets_at')
    try:
        resets = float(resets)
        if resets < 1e12:      # 秒 -> 毫秒
            resets *= 1000
    except (TypeError, ValueError):
        resets = None
    util = _pick(info, 'utilization', 'used_percentage')
    item = {'status': str(info.get('status') or '')[:30], 'resets_at': resets, 'ts': int(time.time() * 1000)}
    if isinstance(util, (int, float)):
        item['pct'] = float(util) * 100 if util <= 1 else float(util)
    path = os.path.join(data_dir, 'cc_ratelimit.json')
    with _rec_lock:
        d = _jload(path, {})
        d[kind] = item
        _jsave(path, d)


def record_usage(data_dir, usage, model, tag):
    if not usage:
        return
    now = time.time()
    path = os.path.join(data_dir, 'cc_usage.json')
    item = {'ts': int(now * 1000), 'model': (model or '')[:60], 'conv': tag,
            'in': int(usage.get('input_tokens') or 0), 'out': int(usage.get('output_tokens') or 0),
            'cr': int(usage.get('cache_read_input_tokens') or 0),
            'cw': int(usage.get('cache_creation_input_tokens') or 0)}
    with _rec_lock:
        items = [x for x in _jload(path, []) if x.get('ts', 0) >= (now - USAGE_KEEP_SEC) * 1000]
        items.append(item)
        _jsave(path, items[-5000:])


def record_run(data_dir, run):
    path = os.path.join(data_dir, 'cc_runs.json')
    with _rec_lock:
        items = _jload(path, [])
        items.append(run)
        _jsave(path, items[-RUNS_MAX:])


def load_runs(data_dir):
    return list(reversed(_jload(os.path.join(data_dir, 'cc_runs.json'), [])))


def load_usage(data_dir):
    return _jload(os.path.join(data_dir, 'cc_usage.json'), [])


def load_rate_limits(data_dir):
    return _jload(os.path.join(data_dir, 'cc_ratelimit.json'), {})


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


DELIVERED_MAX = 80   # 每个会话记住最近多少条已经送到 claude 的消息 id


def get_session(data_dir, key):
    return (_map_load(data_dir).get(key) or {}).get('session_id')


def get_delivered(data_dir, key):
    """这个对话里已经送进当前 claude 会话的消息 id（前端给每条消息的 _mid）。"""
    return set((_map_load(data_dir).get(key) or {}).get('delivered') or [])


def session_turns(data_dir, key):
    """这个对话当前的 Claude Code 会话里已经聊了几轮。"""
    return int((_map_load(data_dir).get(key) or {}).get('turns') or 0)


def bump_turns(data_dir, key, session_id):
    with _map_lock:
        m = _map_load(data_dir)
        v = m.get(key) or {}
        if v.get('session_id') != session_id:
            return
        v['turns'] = int(v.get('turns') or 0) + 1
        m[key] = v
        tmp = _map_path(data_dir) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _map_path(data_dir))


def set_session(data_dir, key, session_id, add_mids=None):
    with _map_lock:
        m = _map_load(data_dir)
        if session_id:
            old = m.get(key) or {}
            # 换了新会话，旧会话里送过什么就不作数了
            same = old.get('session_id') == session_id
            dl = list(old.get('delivered') or []) if same else []
            for mid in add_mids or []:
                if mid and mid not in dl:
                    dl.append(mid)
            # seen：这个对话里送进过 claude 的所有消息 id，换会话也不清（用来认出「重新生成」）
            seen = list(old.get('seen') or old.get('delivered') or [])
            for mid in add_mids or []:
                if mid and mid not in seen:
                    seen.append(mid)
            m[key] = {'session_id': session_id, 'ts': int(time.time()),
                      'delivered': dl[-DELIVERED_MAX:], 'turns': int(old.get('turns') or 0) if same else 0,
                      'seen': seen[-400:]}
        else:
            # 换新会话：会话号清掉，但 seen 留着
            old = m.get(key) or {}
            seen = old.get('seen') or old.get('delivered') or []
            if seen:
                m[key] = {'seen': seen[-400:], 'ts': int(time.time())}
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
            out.append('（发了一张图片）')
        elif t == 'tool_result':
            c = b.get('content')
            out.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
    return '\n'.join(x for x in out if x)


def split_turn(messages):
    """返回 (之前的历史, 本轮的用户消息列表)。本轮 = 最后一条助手消息之后的所有用户消息。"""
    msgs = [m for m in (messages or []) if isinstance(m, dict)]
    i = len(msgs)
    while i > 0 and msgs[i - 1].get('role') != 'assistant':
        i -= 1
    return msgs[:i], [m for m in msgs[i:] if m.get('role') == 'user']


def split_messages(messages):
    """返回 (之前的历史, 本轮用户消息文本)。"""
    history, tail = split_turn(messages)
    prompt = '\n\n'.join(t for t in (_text_of(m.get('content')).strip() for m in tail) if t)
    return history, prompt


def _mid(m):
    v = m.get('_mid')
    return str(v)[:64] if v else ''


# ------------------------------------------------------------
# 图片：前端存在服务器上的 /chatimg/xxx、/stickers/xxx，或老的 data: URL
# ------------------------------------------------------------
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TURN_IMAGES = 4   # 一轮最多送几张图进去（每张都会写进会话记录，越多越占内存）
_MEDIA_PREFIX = {'/chatimg/': 'chatimg', '/stickers/': 'stickers'}
_DATA_URL = re.compile(r'^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$', re.S)
_MIME = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
         'gif': 'image/gif', 'webp': 'image/webp'}


_SNIFF_MIME = {'jpg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp'}


def _sniff(raw):
    b = raw[:16]
    if b[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if b[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'webp'
    if raw[4:8] == b'ftyp':
        return 'heic'
    return ''


def load_image(url, data_dir):
    """返回 (media_type, base64, 问题)。成功时问题为 ''；失败时前两项为 None，问题写原因。
    格式按文件头认，不信扩展名：HEIC 被当成 JPEG 发给模型会让整条回复报错。"""
    import base64
    url = (url or '').strip()
    raw = None
    m = _DATA_URL.match(url)
    if m:
        if len(m.group(2)) * 3 // 4 > MAX_IMAGE_BYTES:
            return None, None, '图片太大'
        try:
            raw = base64.b64decode(m.group(2))
        except Exception:
            return None, None, '图片数据坏了'
    else:
        for prefix, sub in _MEDIA_PREFIX.items():
            if url.startswith(prefix):
                name = os.path.basename(url[len(prefix):].split('?', 1)[0])
                if not re.match(r'^[A-Za-z0-9._-]+$', name):
                    return None, None, '地址不对'
                fp = os.path.join(data_dir, 'media', sub, name)
                try:
                    if os.path.getsize(fp) > MAX_IMAGE_BYTES:
                        return None, None, '图片太大'
                    with open(fp, 'rb') as f:
                        raw = f.read()
                except OSError:
                    return None, None, '服务器上找不到这张图了'
                break
        else:
            return None, None, '不是这里存的图片'
    kind = _sniff(raw or b'')
    if kind == 'heic':
        return None, None, 'HEIC 格式（苹果原图），你这边看不了'
    if kind not in _SNIFF_MIME:
        return None, None, '格式认不出来'
    return _SNIFF_MIME[kind], base64.b64encode(raw).decode('ascii'), ''


def load_local_image(url, data_dir):
    """返回 (media_type, base64)；不认识、太大或找不到返回 None。"""
    mt, b64, _ = load_image(url, data_dir)
    return (mt, b64) if mt else None


def turn_content(tail, data_dir):
    """本轮要说的：(文字, [图片 block, ...], [没送进去的原因, ...])。图片用 Anthropic 的 image block 格式。"""
    texts, images, problems = [], [], []
    for m in tail:
        c = m.get('content')
        if isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                url = ''
                if b.get('type') == 'image_url':
                    url = (b.get('image_url') or {}).get('url') or ''
                elif b.get('type') == 'image':
                    src = b.get('source') or {}
                    if src.get('type') == 'base64':
                        url = f"data:{src.get('media_type', 'image/jpeg')};base64,{src.get('data', '')}"
                    elif src.get('type') == 'url':
                        url = src.get('url') or ''
                if url:
                    mt, b64, why = load_image(url, data_dir)
                    if mt and len(images) < MAX_TURN_IMAGES:
                        images.append({'type': 'image', 'source': {
                            'type': 'base64', 'media_type': mt, 'data': b64}})
                    else:
                        why = why or f'一次最多看 {MAX_TURN_IMAGES} 张'
                        problems.append(why)
                        print(f'[cc] 有一张图没送进去：{why}', flush=True)
        t = _text_of(c).strip()
        if m.get('_note'):
            t = f"〔{m['_note']}〕" + ('\n' + t if t else '')
        if t:
            texts.append(t)
    if problems:
        # 明确告诉他哪张没看到、为什么，免得他瞎猜图里是什么
        texts.append('（系统提示：她发的图里有 %d 张你这次看不到（%s）。如实告诉她看不到、请她换成截图或 JPG 再发，不要猜图片内容）'
                     % (len(problems), '；'.join(dict.fromkeys(problems))))
    return '\n\n'.join(texts), images, problems


def history_transcript(history):
    lines = []
    for m in (history[-HISTORY_MAX_MSGS:] if HISTORY_MAX_MSGS > 0 else history):
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
_OB_URL_FILE = None   # app.py 启动时设成 数据目录/ob_url.json（网页设置里的记忆库地址会同步进来）


def ob_url():
    """记忆库地址：环境变量 CC_OB_URL / OB_MCP_URL 优先，其次网页设置里同步过来的，最后才是老地址。"""
    for k in ('CC_OB_URL', 'OB_MCP_URL'):
        v = (os.environ.get(k) or '').strip()
        if v:
            return v
    if _OB_URL_FILE:
        try:
            with open(_OB_URL_FILE, encoding='utf-8') as f:
                v = (json.load(f) or {}).get('url') or ''
            if v.startswith('http'):
                return v
        except Exception:
            pass
    return DEFAULT_OB_URL


def _write_if_changed(path, text, private=False):
    try:
        old = open(path, encoding='utf-8').read()
    except Exception:
        old = None
    if old != text:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(text)
        if private:
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
        os.replace(tmp, path)


def auto_mcp_config(cwd):
    """没设 CC_MCP_CONFIG 时，自动写一份只挂记忆库的 MCP 配置，返回路径；关掉了返回空。"""
    if os.environ.get('CC_AUTO_MCP') == '0':
        return ''
    url = ob_url().strip()
    if not url:
        return ''
    path = os.path.join(cwd, '.mcp_auto.json')
    cfg = {'mcpServers': {'ob': {'type': 'http', 'url': url}}}
    _write_if_changed(path, json.dumps(cfg, ensure_ascii=False))
    return path


# app.py 自己提供的本地 MCP（朋友圈、碎碎念、犯错本、书房……），名字 -> {url, headers}
_LOCAL_MCP = {}


def register_local_mcp(name, url, headers=None):
    _LOCAL_MCP[name] = {'type': 'http', 'url': url, 'headers': dict(headers or {})}


def local_mcp_config(cwd):
    """写本地 MCP 的配置文件（里面有访问令牌，权限 600），返回 (路径, [名字])；关掉了返回 ('', [])。"""
    if os.environ.get('CC_LIN_MCP') == '0' or not _LOCAL_MCP:
        return '', []
    path = os.path.join(cwd, '.mcp_local.json')
    _write_if_changed(path, json.dumps({'mcpServers': _LOCAL_MCP}, ensure_ascii=False), private=True)
    return path, list(_LOCAL_MCP)


def _norm_url(u):
    return (u or '').strip().rstrip('/').lower()


def web_mcp_config(cwd, servers):
    """网页「设置 → MCP」里自己加的服务器，也交给 Claude Code。
    返回 (配置文件路径, [名字], [要禁用的工具全名])；没有就返回 ('', [], [])。
    跟自动挂的记忆库是同一个地址的会跳过，免得同一套工具出现两遍。"""
    if os.environ.get('CC_WEB_MCP') == '0' or not isinstance(servers, list):
        return '', [], []
    skip = set()
    ob_url = ''
    if os.environ.get('CC_AUTO_MCP') != '0':
        ob_url = _norm_url(globals()['ob_url']())
    cfg, names, off = {}, [], []
    taken = {'ob'} | set(_LOCAL_MCP)
    tool_ok = lambda t: isinstance(t, str) and re.match(r'^[A-Za-z0-9_.-]{1,80}$', t)
    for sv in servers[:8]:
        if not isinstance(sv, dict):
            continue
        url = str(sv.get('url') or '').strip()
        if not re.match(r'^https?://[^\s]+$', url) or len(url) > 500:
            continue
        enabled = sv.get('enabled', True) is not False
        if ob_url and _norm_url(url) == ob_url:
            # 记忆库已经自动挂上了（名字 ob）：网页里的开关照样生效
            if not enabled:
                off.append('mcp__ob')          # 整个记忆库关掉
            else:
                off += [f'mcp__ob__{t}' for t in (sv.get('off') or [])[:200] if tool_ok(t)]
            continue
        if not enabled or _norm_url(url) in skip or '/api/lin-mcp' in url:
            continue
        skip.add(_norm_url(url))
        base = re.sub(r'[^a-z0-9_-]+', '_', str(sv.get('name') or '').lower()).strip('_-')[:24] or 'web'
        name, i = base, 2
        while name in taken:
            name, i = f'{base}{i}', i + 1
        taken.add(name)
        cfg[name] = {'type': 'http', 'url': url}
        names.append(name)
        off += [f'mcp__{name}__{t}' for t in (sv.get('off') or [])[:200] if tool_ok(t)]
    if not cfg:
        return '', [], off
    path = os.path.join(cwd, '.mcp_web.json')
    _write_if_changed(path, json.dumps({'mcpServers': cfg}, ensure_ascii=False), private=True)
    return path, names, off


# 新版 Claude Code 在 -p 模式下默认只给「思考进度」，思考文字是空的；
# 加 --thinking-display summarized 才有思考内容（这是隐藏参数，以后版本不认的话会自动去掉重试）。
_THINK_FLAG_BROKEN = False


def thinking_display():
    v = (os.environ.get('CC_THINKING_DISPLAY') or 'summarized').strip().lower()
    if _THINK_FLAG_BROKEN or v in ('off', '0', 'none', ''):
        return ''
    return v if v in ('summarized', 'highlights', 'omitted') else 'summarized'


EFFORT_LEVELS = ('low', 'medium', 'high', 'xhigh', 'max')


def pick_effort(req_effort):
    """网页选的 -> 环境变量 CC_EFFORT -> ''（不传，用 Claude Code 默认）。"""
    for v in (req_effort, os.environ.get('CC_EFFORT')):
        v = str(v or '').strip().lower()
        if v in EFFORT_LEVELS:
            return v
    return ''


def _session_path(session_id):
    if not session_id or not re.match(r'^[A-Za-z0-9-]+$', session_id):
        return None
    base = (os.environ.get('CLAUDE_CONFIG_DIR') or '').strip() or os.path.expanduser('~/.claude')
    for p in glob.glob(os.path.join(base, 'projects', '*', session_id + '.jsonl')):
        return p
    return None


def _is_real_user(entry):
    """会话记录里「她说的一句话」（不是工具结果、不是系统塞的）。"""
    if entry.get('type') != 'user' or entry.get('isMeta') or entry.get('isSidechain'):
        return False
    c = (entry.get('message') or {}).get('content')
    if isinstance(c, str):
        return bool(c.strip())
    if isinstance(c, list):
        return any(isinstance(b, dict) and b.get('type') in ('text', 'image') for b in c) and \
            not any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c)
    return False


_NOTE_HEAD = re.compile(r'^\s*〔[^〕]*〕\s*')


def _entry_text(entry):
    """她那句话本身（第一段文字，去掉开头盖的〔当下〕；后面附的表情说明不算）。"""
    c = (entry.get('message') or {}).get('content')
    if isinstance(c, str):
        t = c
    else:
        t = next((b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text'), '')
    t = re.split(r'\n\n〔(?:附图：|她发的表情\[|你刚才发的表情\[)', t or '', maxsplit=1)[0]
    return _NOTE_HEAD.sub('', t).strip()


def strip_sticker_images(session_id):
    """（停用：改了旧记录会让 Claude Code 的缓存每句都断，整段会话按全价重算，反而更费。
    小图本身只有约 50 token、走缓存，留着更省；换新会话时自然就没了。）
    他看过的表情图，在会话记录里换成「〔表情[名字]〕」几个字：当下看见，之后不再每句背着图。"""
    p = _session_path(session_id)
    if not p:
        return 0
    try:
        with open(p, encoding='utf-8') as f:
            lines = f.read().split('\n')
    except Exception:
        return 0
    n = 0
    for i, l in enumerate(lines):
        if '〔' not in l or '"image"' not in l:
            continue
        try:
            d = json.loads(l)
        except Exception:
            continue
        c = (d.get('message') or {}).get('content')
        if d.get('type') != 'user' or not isinstance(c, list):
            continue
        # 发给 claude 时图片在前、文字合成一段在后；表情图是附在最后的那几张，按说明的个数从后往前去掉
        alltext = ''.join(str(b.get('text', '')) for b in c if isinstance(b, dict) and b.get('type') == 'text')
        k = alltext.count('〔她发的表情[') + alltext.count('〔你刚才发的表情[')
        if not k:
            continue
        img_idx = [j for j, b in enumerate(c) if isinstance(b, dict) and b.get('type') == 'image']
        gone = set(img_idx[-k:])
        out = [b for j, b in enumerate(c) if j not in gone]
        n += len(gone)
        if len(out) != len(c):
            d['message']['content'] = out
            lines[i] = json.dumps(d, ensure_ascii=False)
    if n:
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        os.replace(tmp, p)
    return n


def regen_fork(session_id, target_text):
    """重新生成：在会话记录里找到她要重来的那句话（按内容找，不管是不是最后一句），
    把它之前的记录复制成一份新会话，返回新会话号。找不到就返回 None（调用方开新会话）。
    不靠 Claude Code 的隐藏参数，自己切，稳。"""
    p = _session_path(session_id)
    if not p:
        return None, 'no-file'
    try:
        with open(p, encoding='utf-8') as f:
            raw = [l for l in f.read().split('\n') if l.strip()]
    except Exception:
        return None, 'read-fail'
    rows = []
    for l in raw:
        try:
            rows.append(json.loads(l))
        except Exception:
            rows.append(None)
    target = _NOTE_HEAD.sub('', target_text or '').strip()
    hit = None
    for i in range(len(rows) - 1, -1, -1):
        d = rows[i]
        if isinstance(d, dict) and _is_real_user(d) and target and _entry_text(d) == target:
            hit = i
            break
    if hit is None:
        return None, 'not-found'
    # 切在那句话之前；前面得有他说过的话，不然就是第一轮，直接开新会话
    if not any(isinstance(d, dict) and d.get('type') == 'assistant' for d in rows[:hit]):
        return None, 'first-turn'
    new_id = str(uuid.uuid4())
    out = []
    for d, l in zip(rows[:hit], raw[:hit]):
        if isinstance(d, dict):
            if d.get('sessionId'):
                d['sessionId'] = new_id
            out.append(json.dumps(d, ensure_ascii=False))
    try:
        with open(os.path.join(os.path.dirname(p), new_id + '.jsonl'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(out) + '\n')
    except Exception:
        return None, 'write-fail'
    return new_id, 'ok'


_FORK_FLAG_BROKEN = False
_TOOLS_FLAG_BROKEN = False   # 这个版本不认 --tools 就记住，以后不加


def build_cmd(system_prompt, resume_id, upstream_cfg, sys_file=None, auto_mcp='', req_model=None,
              local_mcp=('', []), image_input=False, web_mcp=('', [], []), effort='', thinking=True,
              resume_at=None):
    cmd = [os.environ.get('CC_BIN') or 'claude', '-p',
           '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if effort:
        cmd.append('--effort=' + effort)
    if not thinking:
        # 网页上把「思考」关了：这一句不想，回得快、省额度
        cmd.append('--settings=' + json.dumps({'alwaysThinkingEnabled': False}))
    td = thinking_display() if thinking else ''
    if td:
        cmd.append('--thinking-display=' + td)
    # Claude Code 自带的写代码工具（Bash、读写文件、Task……）说明书很长，每句都要背着，
    # 他是陪你的不是写代码的，默认只留查网页的两个。CC_BUILTIN_TOOLS 可以改（填 none 全关）。
    bt = (os.environ.get('CC_BUILTIN_TOOLS') or 'WebSearch,WebFetch').strip()
    if not _TOOLS_FLAG_BROKEN:
        cmd += ['--tools', '' if bt.lower() == 'none' else bt]
    if image_input:
        # 这一轮有图片：stdin 改喂一行 stream-json（带图片 block），他就能真的看到图
        cmd += ['--input-format', 'stream-json']
    if resume_id:
        cmd += ['--resume', resume_id]
        if resume_at:
            # 重新生成：接着那个会话，但只接到被 roll 那一轮之前，另起一个新会话号，旧的不动
            cmd += ['--resume-session-at', resume_at, '--fork-session']
    if system_prompt:
        # 默认整个换掉 Claude Code 自带的系统提示（"你是写代码的助手"那一套），
        # 不然他总把自己当助手在"扮演角色"，思考里冒出"保持人设""她们俩在调情"这种旁观话。
        # 想恢复成"接在默认提示后面"，设 CC_SYSTEM_PROMPT_MODE=append。
        replace = (os.environ.get('CC_SYSTEM_PROMPT_MODE') or 'replace').strip().lower() != 'append'
        if sys_file:
            cmd += ['--system-prompt-file' if replace else '--append-system-prompt-file', sys_file]
        else:
            cmd += ['--system-prompt' if replace else '--append-system-prompt', system_prompt]
    # 每次调用都带上（包括 --resume 续会话），这样中途换模型也能生效
    model = pick_model(req_model, upstream_cfg)
    if model:
        cmd += ['--model', model]
    user_mcp = (os.environ.get('CC_MCP_CONFIG') or '').strip()
    mcp = user_mcp or auto_mcp
    if mcp:
        # 用 = 的写法：--mcp-config 是可变参数，避免把后面的东西吞进去
        cmd.append('--mcp-config=' + mcp)
    local_path, local_names = local_mcp
    if local_path:
        cmd.append('--mcp-config=' + local_path)
    web_path, web_names, web_off = web_mcp
    if web_path:
        cmd.append('--mcp-config=' + web_path)
        local_names = list(local_names) + list(web_names)   # 网页里加的也一并放行
    allowed = _split_list(os.environ.get('CC_ALLOWED_TOOLS') or '')
    if not allowed and auto_mcp and not user_mcp:
        allowed = ['mcp__ob__*']
    # 查网页的工具（WebSearch / WebFetch）也得放行，不然 -p 模式下他一上网就被自动拒绝，等于没网
    if bt.lower() != 'none':
        for t in _split_list(bt):
            if re.match(r'^[A-Za-z]+$', t) and t not in allowed:
                allowed.append(t)
    for n in local_names:
        # 本地这组是 app 自己的工具，不放行的话 -p 模式下一用就被拒，所以总是放行
        if not any(a.startswith(f'mcp__{n}__') or a == f'mcp__{n}' for a in allowed):
            allowed.append(f'mcp__{n}__*')
    if allowed:
        cmd.append('--allowedTools=' + ','.join(allowed))
    # 记忆库只留常用的：读、搜、存、整理、改、信、约定。不常用的说明书很长，每句都背着太费。
    # CC_OB_OFF 可以改（逗号分隔工具名；填 none 全留）。
    ob_off = (os.environ.get('CC_OB_OFF') or 'I,anchor,breath_advanced,feel,letter_lock_update,pulse,release').strip()
    if auto_mcp and not user_mcp and ob_off.lower() != 'none':
        web_off = list(web_off) + [f'mcp__ob__{t}' for t in _split_list(ob_off)
                                   if re.match(r'^[A-Za-z0-9_.-]{1,80}$', t)]
    if web_off:
        # 网页里关掉的那几个工具，Claude Code 这边也不给用
        cmd.append('--disallowedTools=' + ','.join(web_off))
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
# 「整个脑子看一遍」：他读 OB 读回来一大份（按量算，不按时间），这份单独存着，
# 上下文窗口滑过去、换新会话都不丢；为了某一两条去查的小量结果照常跟着聊天走。
# 后来又整个看了一遍，就换成新的那份。
# ------------------------------------------------------------
BRAIN_MIN_CHARS = int(os.environ.get('CC_BRAIN_MIN_CHARS') or 3000)
BRAIN_MAX_CHARS = int(os.environ.get('CC_BRAIN_MAX_CHARS') or 60000)
_brain_lock = threading.Lock()


def _is_ob_read(name):
    if not name.startswith('mcp__'):
        return False
    parts = name.split('__')
    return (len(parts) >= 3 and parts[1] == 'ob') or parts[-1] in ('breath', 'dream', 'breath_search', 'breath_advanced')


def brain_path(data_dir):
    return os.path.join(data_dir, 'cc_brain.json')


def save_brain(data_dir, key, name, text):
    text = (text or '').strip()
    if not key or len(text) < BRAIN_MIN_CHARS or not _is_ob_read(name or ''):
        return
    with _brain_lock:
        m = _jload(brain_path(data_dir), {})
        m[key] = {'text': text[:BRAIN_MAX_CHARS], 'tool': name, 'ts': int(time.time())}
        _jsave(brain_path(data_dir), m)
    print(f'[cc] 记下整份记忆 #{_short(key)}（{name}，{len(text)} 字）', flush=True)


def load_brain(data_dir, key):
    return ((_jload(brain_path(data_dir), {}) or {}).get(key) or {}).get('text') or ''


# ------------------------------------------------------------
class _Run:
    def __init__(self, data_dir, key, mids=None):
        self.data_dir, self.key = data_dir, key
        self.mids = list(mids or [])   # 这一轮送进去的消息 id，会话建好后记为「已送达」
        self.text_open = self.think_open = False
        self.text_emitted = False
        self.need_sep = False
        self.streamed_ids = set()
        self.cur_msg_id = None
        self.usage = {}
        self.result = None
        self.session_id = None
        self.mcp = []          # [{name, status}]，来自 init
        self.tools = {}        # 工具调用 id -> {'name', 'input_sent'}，给网页显示「调用了什么、结果是什么」
        self.think_tokens = 0  # Claude Code 估算的思考 token（这一轮累计），网页拿来和摘要字数对比
        self.think_text = ''   # 这一轮的思考原文（用来判断要不要翻成中文）
        self._think_sent = 0
        self.all_text = ''     # 这一轮说出口的全部文字（断线后在后台说完时，存起来等她回来拿）

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
        self.all_text += t
        out.append(sse({'type': 'content_block_delta', 'index': TEXT,
                        'delta': {'type': 'text_delta', 'text': t}}))
        return out

    def thinking(self, t):
        if not t:
            return []
        self.think_text += t
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
                set_session(self.data_dir, self.key, sid, add_mids=self.mids)
            except Exception as e:
                print(f'[cc] 保存 session 失败: {e}', flush=True)

    # ---------- 工具调用：只给网页看，网页不会自己去执行 ----------
    TOOL_TEXT_MAX = 4000

    def _tool_start(self, tid, name):
        if not tid or tid in self.tools:
            return []
        self.tools[tid] = {'name': name, 'input_sent': False}
        return [sse({'type': 'cc_tool', 'phase': 'start', 'id': tid, 'name': name})]

    def _tool_input(self, tid, name, inp):
        out = self._tool_start(tid, name)
        rec = self.tools.get(tid)
        if rec is None or rec['input_sent']:
            return out
        rec['input_sent'] = True
        try:
            txt = json.dumps(inp if inp is not None else {}, ensure_ascii=False, indent=1)
        except Exception:
            txt = str(inp)
        if len(txt) > self.TOOL_TEXT_MAX:
            txt = txt[:self.TOOL_TEXT_MAX] + '\n…（太长，截断了）'
        return out + [sse({'type': 'cc_tool', 'phase': 'input', 'id': tid, 'input': txt})]

    def _tool_result(self, tid, content, is_error):
        if isinstance(content, str):
            txt = content
        else:
            parts = []
            for b in content or []:
                if isinstance(b, dict):
                    if b.get('type') == 'text':
                        parts.append(b.get('text', ''))
                    elif b.get('type') == 'image':
                        parts.append('[图片]')
            txt = '\n'.join(parts)
        name = (self.tools.get(tid) or {}).get('name', '')
        if not is_error:
            try:
                save_brain(self.data_dir, self.key, name, txt)
            except Exception as e:
                print(f'[cc] 存整份记忆失败: {e}', flush=True)
        if len(txt) > self.TOOL_TEXT_MAX:
            txt = txt[:self.TOOL_TEXT_MAX] + '\n…（太长，截断了）'
        return [sse({'type': 'cc_tool', 'phase': 'result', 'id': tid, 'name': name,
                     'result': txt, 'is_error': bool(is_error)})]

    def handle(self, d):
        """处理 stream-json 的一行，返回要发给前端的 SSE 片段列表。"""
        t = d.get('type')
        if t == 'system' and d.get('subtype') == 'thinking_tokens':
            dl_tok = d.get('estimated_tokens_delta')
            if isinstance(dl_tok, (int, float)):
                self.think_tokens += int(dl_tok)
            elif isinstance(d.get('estimated_tokens'), (int, float)):
                self.think_tokens = max(self.think_tokens, int(d['estimated_tokens']))
            if self.think_tokens - self._think_sent >= 40:
                self._think_sent = self.think_tokens
                return [sse({'type': 'cc_think', 'tokens': self.think_tokens})]
            return []
        if t == 'system':
            if d.get('subtype') == 'init':
                self._sid(d)
                self.mcp = [{'name': str(x.get('name', ''))[:40], 'status': str(x.get('status', ''))[:20]}
                            for x in (d.get('mcp_servers') or []) if isinstance(x, dict)]
                # 告诉网页各个 MCP 有没有连上（没连上的会在他回复下面提示）
                return [sse({'type': 'cc_status', 'mcp': self.mcp})]
            return []
        if t == 'rate_limit_event':
            try:
                note_rate_limit(self.data_dir, d.get('rate_limit_info') or {})
            except Exception:
                pass
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
            if et == 'content_block_start':
                cb = ev.get('content_block') or {}
                if cb.get('type') == 'tool_use':
                    if self.text_emitted:
                        self.need_sep = True   # 工具后面再说的话另起一个气泡
                    return self._tool_start(cb.get('id'), cb.get('name') or '')
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
            tool_out = []
            for b in msg.get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    tool_out += self._tool_input(b.get('id'), b.get('name') or '', b.get('input'))
            if msg.get('id') and msg['id'] in self.streamed_ids:
                if self.text_emitted:
                    self.need_sep = True
                return tool_out
            out = tool_out
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
        if t == 'user':
            out = []
            for b in (d.get('message') or {}).get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_result':
                    out += self._tool_result(b.get('tool_use_id'), b.get('content'), b.get('is_error'))
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
        if self.think_tokens and self.think_tokens != self._think_sent:
            self._think_sent = self.think_tokens
            out.append(sse({'type': 'cc_think', 'tokens': self.think_tokens}))
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


# ------------------------------------------------------------
# 思考固定成中文：模型想用什么语言靠指令锁不住（实测加了「思考用中文」照样会用英文想），
# 所以思考结束后检查一下，中文占比不到一半就翻成中文再给网页。
# 翻译优先用 app 提供的上游小模型（有 key 时），没有就在回复结束后跑一次小的 Claude Code（haiku）。
# ------------------------------------------------------------
_TRANSLATOR = None


def set_translator(fn):
    """app.py 注册：fn(text) -> 中文 or None。"""
    global _TRANSLATOR
    _TRANSLATOR = fn


def cjk_ratio(text):
    cjk = len(re.findall(r'[\u4e00-\u9fff]', text or ''))
    lat = len(re.findall(r'[A-Za-z]', text or ''))
    return cjk / max(1, cjk + lat)


THINK_ZH_PROMPT = ('下面是「他」这一刻心里在想什么的一段记录（这段记录是另一个模型概括出来的），可能是英文，'
                   '也可能写成了旁观者在分析的口吻（比如“保持角色/in character/扮演/两个人之间/以某某的身份”）。'
                   '把它改写成他本人当下的内心独白：简体中文，第一人称“我”就是他，“她”就是她；'
                   '去掉所有出戏的说法（角色、扮演、人设、in character、roleplay、两人之间）；'
                   '意思照原样保留，不添加原文没有的内容，也别写成给自己布置任务的计划口吻。'
                   '只输出改写后的内容，不要解释，不要加引号。')
# 中文思考里出现这些词，说明是旁观者口吻，也要过一遍
_THINK_META = re.compile(r'角色|扮演|人设|出戏|戏里|in[ -]?character|role-?play|character|persona', re.I)


def oneshot(prompt, *, system, data_dir, model='haiku', timeout=90):
    """跑一次最简单的 Claude Code（不挂 MCP、不给工具、不续会话），返回输出文字；失败返回 ''。
    调用方要保证此时没有别的 claude 在跑（这里用在主回复结束、进程已经收掉之后）。"""
    cmd = [os.environ.get('CC_BIN') or 'claude', '-p', '--output-format', 'text', '--model', model,
           '--system-prompt', system, '--strict-mcp-config', '--tools', '',
           '--thinking-display=omitted'] if not _THINK_FLAG_BROKEN else \
          [os.environ.get('CC_BIN') or 'claude', '-p', '--output-format', 'text', '--model', model,
           '--system-prompt', system, '--strict-mcp-config', '--tools', '']
    cwd = os.path.join(data_dir, 'cc_workspace')
    os.makedirs(cwd, exist_ok=True)
    try:
        proc, q, err_tail = _spawn(cmd, prompt, cwd, data_dir)
    except Exception:
        return ''
    out, deadline = [], time.time() + timeout
    try:
        while time.time() < deadline:
            try:
                kind, raw = q.get(timeout=1)
            except queue.Empty:
                continue
            if kind == 'eof':
                break
            out.append(raw.decode('utf-8', 'ignore'))
    finally:
        _cleanup(proc, graceful=True)
    return ''.join(out).strip()


def think_to_zh(text, data_dir):
    """返回 (改好的中文 or None, 说明, 是否该藏起来)。
    - 外文思考：翻成中文并改成他自己的口吻；翻不了就藏起来（你要的是完全不要英文）
    - 中文但带着「角色/扮演/人设」这种旁观者口吻：改成他自己的口吻；改不了就原样给
    - 本来就好好的中文：不动
    只用不花 Claude 额度的方式（DeepSeek / 上游小模型）；CC_THINK_ZH_FALLBACK=haiku 才会用 Claude 兜底。"""
    if os.environ.get('CC_THINK_ZH') == '0' or not text:
        return None, '', False
    foreign = cjk_ratio(text) < 0.5
    meta = bool(_THINK_META.search(text))
    if not foreign and not meta:
        return None, '', False
    t0 = time.time()
    zh, how = None, ''
    if _TRANSLATOR:
        try:
            zh, how = _TRANSLATOR(text)
        except Exception as e:
            how = f'翻译出错（{type(e).__name__}）'
    if not zh and (os.environ.get('CC_THINK_ZH_FALLBACK') or '').strip().lower() == 'haiku':
        zh, how = oneshot(text[:8000], system=THINK_ZH_PROMPT, data_dir=data_dir), 'haiku'
    why = '外文' if foreign else '旁观者口吻'
    if zh and cjk_ratio(zh) >= 0.5:
        print(f'[cc] 思考是{why}，已用{how}改成他自己的中文，用时 {time.time() - t0:.1f}s', flush=True)
        return zh, how, False
    if foreign:
        print(f'[cc] 思考是外文，没翻成（{how}），这轮思考不显示', flush=True)
        return None, how or '没翻成', True
    return None, '', False


# ------------------------------------------------------------
# 断线后在后台把话说完
# 以前：她锁屏 / 切后台 / 网闪一下 → 连接断了 → 直接把 claude 掐死 → 会话记录没写完
#       → 下一句接不上（No conversation found）→ 重开会话把历史重喂一遍 → 「链接出错」+ 回复两遍。
# 现在：连接断了 claude 照样说完、把会话写完；说出口的话存起来，她回来网页自己取。
# ------------------------------------------------------------
_pending_lock = threading.Lock()
_DETACHED = {}      # key -> proc：断线后还在后台说的
_STOP_REQ = {}      # key -> 时间：她按了「停」/挂了电话，这一句不要了


def stop_detached(key):
    """她主动按停：后台那个也收掉，不存回复。"""
    _STOP_REQ[key] = time.time()
    proc = _DETACHED.get(key)
    if proc is not None and proc.poll() is None:
        _signal_group(proc.pid, signal.SIGTERM)
        return True
    return False


def _pending_path(data_dir):
    return os.path.join(data_dir, 'cc_pending.json')


def save_pending(data_dir, key, text, mids):
    with _pending_lock:
        d = _jload(_pending_path(data_dir), {})
        d[key] = {'text': text, 'ts': int(time.time() * 1000), 'mids': list(mids or [])}
        _jsave(_pending_path(data_dir), d)


def take_pending(data_dir, key):
    with _pending_lock:
        d = _jload(_pending_path(data_dir), {})
        v = d.pop(key, None)
        if v is not None:
            _jsave(_pending_path(data_dir), d)
    return v


def _finish_detached(proc, q, run, deadline, t_start, tag, meta, holder, data_dir):
    peak, outcome = 0, 'detached_done'
    _DETACHED[run.key] = proc
    if time.time() - _STOP_REQ.get(run.key, 0) < 15:
        _signal_group(proc.pid, signal.SIGTERM)   # 她按的是「停」，不是断线
    try:
        while True:
            left = deadline - time.time()
            if left <= 0:
                outcome = 'detached_timeout'
                break
            try:
                kind, raw = q.get(timeout=min(PING_EVERY, left))
            except queue.Empty:
                peak = max(peak, group_rss(proc.pid))
                continue
            if kind == 'eof':
                break
            try:
                d = json.loads(raw.decode('utf-8', 'ignore').strip() or 'null')
            except Exception:
                continue
            if isinstance(d, dict):
                run.handle(d)
    except Exception as e:
        outcome = 'detached_error'
        print(f'[cc] 后台说完时出错 #{tag}: {type(e).__name__}', flush=True)
    finally:
        _DETACHED.pop(run.key, None)
        if time.time() - _STOP_REQ.get(run.key, 0) < 600 and _STOP_REQ.get(run.key, 0) >= t_start:
            outcome = 'stopped'
        peak = max(peak, group_rss(proc.pid))
        leftover = _cleanup(proc, graceful=outcome == 'detached_done')
        res = run.result or {}
        text = run.all_text.strip()
        if outcome == 'detached_done' and run.session_id:
            try:
                bump_turns(data_dir, run.key, run.session_id)
            except Exception:
                pass
        if text and outcome == 'detached_done':
            try:
                save_pending(data_dir, run.key, text, run.mids)
            except Exception as e:
                print(f'[cc] 存后台回复失败: {e}', flush=True)
        dur = time.time() - t_start
        print(f'[cc] 结束 #{tag} outcome={outcome} exit={proc.returncode} dur={dur:.1f}s '
              f'api_ms={res.get("duration_api_ms", "?")} saved_chars={len(text)} peak_rss={_mb(peak)} '
              f'cleaned={leftover} {mem_line()}', flush=True)
        try:
            u = run.usage or {}
            record_run(data_dir, dict(meta, outcome=outcome, dur=round(dur, 1),
                                      tools=[v['name'] for v in run.tools.values()][:30],
                                      peak_mb=round(peak / 1048576), mcp=run.mcp,
                                      tokens={'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
                                              'cr': u.get('cache_read_input_tokens', 0),
                                              'cw': u.get('cache_creation_input_tokens', 0)}))
            record_usage(data_dir, u, meta.get('model'), tag)
        except Exception:
            pass
        slot = holder.get('slot')
        if slot is not None:
            slot.release()


def stream_chat(*, messages, system_prompt, key, data_dir, upstream_cfg, model=None, web_mcp=None, effort=None,
                thinking=True, holder=None, regen=False, regen_target=''):
    """生成器：产出前端格式的 SSE。
    holder：传了的话，客户端断开时 claude 不掐死，交给后台说完（见 _finish_detached）。
    regen：重新生成——从被 roll 的那一轮之前分叉，被 roll 掉的回复他看不到。"""
    global _FORK_FLAG_BROKEN
    timeout = float(os.environ.get('CC_TIMEOUT') or 600)
    cwd = (os.environ.get('CC_CWD') or '').strip() or os.path.join(data_dir, 'cc_workspace')
    os.makedirs(cwd, exist_ok=True)

    history, tail = split_turn(messages)

    sys_file = None
    if system_prompt and len(system_prompt.encode('utf-8')) > SYS_ARG_MAX:
        sys_file = os.path.join(cwd, f'.sys_{os.getpid()}_{threading.get_ident()}.txt')
        with open(sys_file, 'w', encoding='utf-8') as f:
            f.write(system_prompt)

    yield sse({'type': 'message_start', 'message': {'usage': {}}})

    resume_id = get_session(data_dir, key)
    resume_at = None
    if not regen and resume_id and tail:
        # 这一轮她的话全都已经送进过会话（网页把他那条回复删了又发一遍 = 重新生成，
        # 或者上次没收到回复又发了一遍）：都当重新生成，从这一轮之前重来，不让他看到之前的版本
        m0 = _map_load(data_dir).get(key) or {}
        seen = set(m0.get('seen') or []) | set(m0.get('delivered') or [])
        if all(_mid(m) and _mid(m) in seen for m in tail):
            regen = True
    if regen and resume_id:
        # 编辑重发：按原来那句找；普通重新生成：按这一轮的话找
        target = regen_target.strip() or '\n\n'.join(t for t in (_text_of(m.get('content')).strip() for m in tail) if t)
        new_id, why = regen_fork(resume_id, target)
        # 切好了就接新那份；切不了（第一轮、找不到）：开新会话，只带网页里剩下的历史（已经去掉 roll 的那些）
        resume_id = new_id
        print(f'[cc] 重新生成 #{_short(key)} fork={"yes" if new_id else "no"} ({why})', flush=True)
    eff = pick_effort(effort)
    attempt = 0
    run = None
    tag = _short(key)
    try:
        while True:
            attempt += 1
            # 续会话时，上次已经送进 claude 会话里的消息（比如上次等太久、断了、没回上）不再重复送，
            # 不然重发几遍他就会看到几遍。新会话（没有 resume）则全部带上。
            this_turn, skipped = tail, 0
            if resume_id and not regen:
                dl = get_delivered(data_dir, key)
                this_turn = [m for m in tail if not (_mid(m) and _mid(m) in dl)]
                skipped = len(tail) - len(this_turn)
            prompt, images, img_problems = turn_content(this_turn, data_dir)
            web = web_mcp_config(cwd, web_mcp)
            if not prompt and not images:
                prompt = ('（她刚才那条你已经收到了，但你的回复没送到她那边。接着回她就行，不用提这件事）'
                          if skipped else '（对方没有说话）')
            stdin_text = prompt
            if not resume_id and history:
                tr = history_transcript(history)
                if tr:
                    stdin_text = ('（下面是你们之前的聊天记录，供你接上话，不用复述）\n'
                                  f'{tr}\n（记录结束）\n\n{prompt}')
            if images:
                content = images + ([{'type': 'text', 'text': stdin_text}] if stdin_text else [])
                stdin_text = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}},
                                        ensure_ascii=False) + '\n'
            cmd = build_cmd(system_prompt, resume_id, upstream_cfg, sys_file,
                            auto_mcp=auto_mcp_config(cwd), req_model=model,
                            local_mcp=local_mcp_config(cwd), image_input=bool(images),
                            web_mcp=web, effort=eff, thinking=thinking is not False, resume_at=resume_at)
            run = _Run(data_dir, key, mids=[_mid(m) for m in this_turn if _mid(m)])
            sf =_session_file_size(resume_id)
            st = concurrency()
            # 只记元数据：不记提示词、聊天内容、令牌
            print(f'[cc] 启动 #{tag} attempt={attempt} model={pick_model(model, upstream_cfg) or "default"} '
                  f'resume={"yes" if resume_id else "no"}'
                  + (f' session_file={_mb(sf)}' if sf is not None else '')
                  + (f' effort={eff}' if eff else '')
                  + (f' images={len(images)}' if images else '')
                  + (f' web_mcp={",".join(web[1])}' if web[1] else '')
                  + (f' skipped_dup={skipped}' if skipped else '')
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

            if images or img_problems:
                # 网页据此在你那张图下面标「他收到了 / 没送到：原因」
                yield sse({'type': 'cc_status', 'images': len(images), 'image_problems': img_problems})

            deadline = time.time() + timeout
            timed_out = False
            got_eof = False
            detached = False
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
                # 客户端断开（锁屏、切后台、网闪）：claude 还在说的话交给后台说完，不掐死；
                # 超时：收掉整个进程组
                if (outcome == 'client_gone' and holder is not None and not got_eof
                        and proc.poll() is None):
                    detached = True
                    holder['detached'] = True
                    meta = {'ts': int(t_start * 1000), 'conv': tag, 'model': pick_model(model, upstream_cfg) or 'default',
                            'resume': bool(resume_id), 'images': len(images), 'image_problems': img_problems,
                            'skipped_dup': skipped, 'error': ''}
                    print(f'[cc] 她那边断开了 #{tag}，让他在后台说完', flush=True)
                    threading.Thread(target=_finish_detached, daemon=True,
                                     args=(proc, q, run, deadline, t_start, tag, meta, holder, data_dir)).start()
                else:
                    peak = max(peak, group_rss(proc.pid))
                    leftover = _cleanup(proc, graceful=got_eof)
                    res = run.result or {}
                    dur = time.time() - t_start
                    print(f'[cc] 结束 #{tag} outcome={outcome} exit={proc.returncode} '
                          f'dur={dur:.1f}s api_ms={res.get("duration_api_ms", "?")} '
                          f'turns={res.get("num_turns", "?")} peak_rss={_mb(peak)} '
                          f'cleaned={leftover} {mem_line()}', flush=True)
                    # 排查记录 + 用量记录（只有元数据）
                    err_short = ''
                    if res and (res.get('is_error') or res.get('subtype') not in (None, 'success')):
                        err_short = str(res.get('result') or res.get('subtype') or '')[:160]
                    elif not res and outcome == 'done':
                        err_short = (''.join(err_tail).strip()[-160:] or f'退出码 {proc.returncode}')
                    try:
                        u = run.usage or {}
                        record_run(data_dir, {
                            'ts': int(t_start * 1000), 'conv': tag, 'outcome': outcome,
                            'dur': round(dur, 1), 'model': pick_model(model, upstream_cfg) or 'default',
                            'resume': bool(resume_id), 'images': len(images), 'image_problems': img_problems,
                            'skipped_dup': skipped, 'mcp': run.mcp, 'error': err_short,
                            'tools': [v['name'] for v in run.tools.values()][:30],
                            'peak_mb': round(peak / 1048576), 'tokens': {
                                'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
                                'cr': u.get('cache_read_input_tokens', 0),
                                'cw': u.get('cache_creation_input_tokens', 0)}})
                        record_usage(data_dir, u, pick_model(model, upstream_cfg), tag)
                    except Exception as e:
                        print(f'[cc] 写排查记录失败: {e}', flush=True)

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
                # 这个模型 / 版本不支持选的思考深度：这一条去掉 --effort 重试一次，并在回复里说明
                if eff and not run.text_emitted and 'effort' in low and attempt <= 3:
                    print(f'[cc] 思考深度 {eff} 不被接受，去掉后重试：{detail[:160]}', flush=True)
                    yield sse({'type': 'cc_status', 'note': '这个模型不支持「%s」思考深度，这条先用了默认深度' % eff})
                    eff = ''
                    continue
                # 这个版本的 Claude Code 不认 --thinking-display：记住，去掉它马上重试一次
                if (not run.text_emitted and 'thinking-display' in low
                        and ('unknown option' in low or 'invalid' in low)):
                    global _THINK_FLAG_BROKEN
                    _THINK_FLAG_BROKEN = True
                    print('[cc] 这个版本不支持 --thinking-display，去掉后重试', flush=True)
                    continue
                # 这个版本不认 --tools：记住，去掉马上重试
                if not run.text_emitted and '--tools' in low and ('unknown' in low or 'invalid' in low):
                    global _TOOLS_FLAG_BROKEN
                    _TOOLS_FLAG_BROKEN = True
                    print('[cc] 这个版本不支持 --tools，去掉后重试', flush=True)
                    continue
                # 重新生成的分叉参数这个版本不认，或者分叉失败：记住，改成开新会话（只带剩下的历史）再来一次
                if resume_at and not run.text_emitted and attempt <= 3 and (
                        'resume-session-at' in low or 'fork-session' in low or 'unknown option' in low
                        or any(s in low for s in _RESUME_MISS)):
                    if 'resume-session-at' in low or 'fork-session' in low or 'unknown option' in low:
                        _FORK_FLAG_BROKEN = True
                    print(f'[cc] 重新生成分叉失败，改开新会话：{detail[:200]}', flush=True)
                    resume_id, resume_at = None, None
                    continue
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
            if not failed and run.session_id:
                bump_turns(data_dir, key, run.session_id)
            break
    finally:
        if sys_file and not (holder or {}).get('detached'):
            try:
                os.remove(sys_file)
            except Exception:
                pass

    if run is not None:
        # 思考不是中文 → 翻成中文再给网页（主回复已经结束、进程已收掉，这里再跑翻译不会两个 claude 同时占内存）
        if run.think_text:
            zh, how, hide = think_to_zh(run.think_text, data_dir)
            if zh:
                yield sse({'type': 'cc_think_zh', 'text': zh,
                           'kind': 'translate' if cjk_ratio(run.think_text) < 0.5 else 'voice'})
            elif hide:
                # 外文思考又没翻成：不给网页看、也不存（你要的是「完全不要英文」）
                yield sse({'type': 'cc_think_hide', 'why': how[:120]})
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
