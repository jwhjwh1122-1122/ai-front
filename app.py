from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time, base64, hashlib
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
EL_KEY = os.environ.get('ELEVENLABS_API_KEY', '')

# 连接复用：省掉每次请求的 TCP+TLS 握手（对流式首字延迟有感）
HTTP = requests.Session()

# 固定前缀（tools + system）的缓存 TTL。
# '1h'：写入按 2x 计费但一小时内读取全部 0.1x —— 消息间隔常超 5 分钟的伴侣场景更划算。
# 如果想回到默认 5 分钟（写入 1.25x），改成 '5m'。
CACHE_TTL_STATIC = os.environ.get('CACHE_TTL_STATIC', '1h')

# 思考预算：工具循环里每一轮都会消耗（按输出价计费）。
# 5000 偏大——日常闲聊 + 读记忆用不到这么多推理深度，2000 通常够；
# 感觉回复变笨再往上调。
THINKING_BUDGET = int(os.environ.get('THINKING_BUDGET', '2000'))

# 对话截断阈值：超过 THRESHOLD 条就截到只剩最近 KEEP 条。
# 纯截断没有摘要兜底，KEEP 太小会"突然失忆"（近期上下文断层），
# 太大则每次请求 token 变多。按体验和账单自己权衡着调。
COMPRESS_THRESHOLD = int(os.environ.get('COMPRESS_THRESHOLD', '60'))
COMPRESS_KEEP = int(os.environ.get('COMPRESS_KEEP', '30'))
MCP_URL = 'https://ombrebrain-jwh.zeabur.app/mcp'

# ========== 持久化数据目录 ==========
# 在 Zeabur 给服务挂载一个 Volume（比如挂到 /data），
# 然后设置环境变量 DATA_DIR=/data，照片和摘要就落在 Volume 上，
# 重新部署/重启不再丢失。
# 未设置 DATA_DIR 时保持旧行为（项目目录下，容器重建会丢！）。
DATA_DIR = os.environ.get('DATA_DIR', os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)

MEMORIES_DIR = os.path.join(DATA_DIR, 'memories')
os.makedirs(MEMORIES_DIR, exist_ok=True)

# 一次性迁移：把旧位置 static/memories 里已有的照片/备注挪到新目录
# （仅当设置了 DATA_DIR、且新目录为空、旧目录有文件时执行）
_OLD_MEMORIES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'memories')
if (os.path.abspath(_OLD_MEMORIES_DIR) != os.path.abspath(MEMORIES_DIR)
        and os.path.isdir(_OLD_MEMORIES_DIR)
        and not os.listdir(MEMORIES_DIR)):
    import shutil
    _moved = 0
    for _f in os.listdir(_OLD_MEMORIES_DIR):
        try:
            shutil.copy2(os.path.join(_OLD_MEMORIES_DIR, _f), os.path.join(MEMORIES_DIR, _f))
            _moved += 1
        except Exception as _e:
            print(f"[Migrate] 复制 {_f} 失败: {_e}")
    if _moved:
        print(f"[Migrate] 已从旧目录迁移 {_moved} 个时光墙文件到 {MEMORIES_DIR}")

def _msg_has_tool_result(m):
    """判断一条消息里是否包含 tool_result 块（Anthropic 格式）"""
    c = m.get('content')
    if isinstance(c, list):
        return any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c)
    return False

def _find_safe_split(messages, keep):
    """
    找一个安全切分点：recent 的第一条必须是"普通 user 消息"
    （不能是 tool_result，否则会和被压缩掉的 tool_use 拆散，Anthropic API 会直接报错）。
    找不到就返回 -1 表示本轮不压缩。
    """
    split = len(messages) - keep
    while split > 0:
        first = messages[split]
        if first.get('role') == 'user' and not _msg_has_tool_result(first):
            return split
        split -= 1
    return -1

def compress_messages(messages):
    """
    纯截断压缩：超过阈值直接丢弃早期消息，不生成任何摘要。
    （曾用 Haiku 生成摘要，但摘要会幻觉出从未发生的事、污染人设——
    早期对话内容由 Ombre Brain 记忆库保留，模型需要时自己 breath 检索。）

    返回 (截断后的消息, keep_from)。
    keep_from 是原始数组中保留区间的起点索引，>=0 表示本轮发生了截断，
    通过 SSE 的 compressed 事件回传给前端，让前端同步裁剪本地历史。
    切点由 _find_safe_split 保证落在普通 user 消息上，
    绝不拆散 tool_use / tool_result 对。
    """
    if len(messages) <= COMPRESS_THRESHOLD:
        return messages, -1
    split = _find_safe_split(messages, COMPRESS_KEEP)
    if split <= 0:
        return messages, -1
    return messages[split:], split

# ========== 记忆摘要存储（独立于对话压缩） ==========
# 说明：前端修复"对话历史保存"后，breath/view_memory 的结果会留在对话历史里，
# 这套摘要不再注入 system prompt（那会破坏 prompt cache）。
# 端点保留，避免旧版前端调用报 404。
MEMORY_SUMMARY_DIR = os.path.join(DATA_DIR, 'memory_summaries')
os.makedirs(MEMORY_SUMMARY_DIR, exist_ok=True)

def get_memory_summary_file(session_id):
    safe_id = hashlib.md5(session_id.encode()).hexdigest()
    return os.path.join(MEMORY_SUMMARY_DIR, f"{safe_id}.json")

def load_memory_summary(session_id):
    fpath = get_memory_summary_file(session_id)
    if os.path.exists(fpath):
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {}
    return {}

def save_memory_summary(session_id, memory_data):
    fpath = get_memory_summary_file(session_id)
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(memory_data, f)

def update_memory_summary(session_id, tool_name, summary_text):
    data = load_memory_summary(session_id)
    if tool_name == 'breath':
        data['last_breath'] = {
            'content': summary_text,
            'timestamp': time.time()
        }
    elif tool_name == 'view_memory':
        data['last_view_memory'] = {
            'content': summary_text,
            'timestamp': time.time()
        }
        if 'viewed_photos' not in data:
            data['viewed_photos'] = []
        if summary_text not in data['viewed_photos']:
            data['viewed_photos'].append(summary_text)
        if len(data['viewed_photos']) > 10:
            data['viewed_photos'] = data['viewed_photos'][-10:]
    save_memory_summary(session_id, data)
    return data

@app.route('/')
def index():
    return send_from_directory('static', 'chat.html')

@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json')

@app.route('/api/store-memory-summary', methods=['POST'])
def store_memory_summary():
    data = request.json
    session_id = data.get('session_id', 'default')
    tool_name = data.get('tool_name', '')
    summary = data.get('summary', '')
    if tool_name and summary:
        update_memory_summary(session_id, tool_name, summary)
        return jsonify({'status': 'ok'})
    return jsonify({'error': 'missing data'}), 400

@app.route('/api/mcp', methods=['POST'])
def mcp():
    data = request.json
    sid = request.headers.get('Mcp-Session-Id')
    if not sid:
        sid = data.pop('_sid', None)
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
    }
    if sid:
        headers['Mcp-Session-Id'] = sid
    r = requests.post(MCP_URL, json=data, headers=headers, stream=True, timeout=120)
    content_type = r.headers.get('Content-Type', 'application/json')
    if 'text/event-stream' in content_type:
        def generate():
            for chunk in r.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk
        resp = Response(generate(), mimetype=content_type)
        if 'Mcp-Session-Id' in r.headers:
            resp.headers['Mcp-Session-Id'] = r.headers['Mcp-Session-Id']
        return resp
    else:
        resp = app.response_class(r.content, mimetype=content_type)
        if 'Mcp-Session-Id' in r.headers:
            resp.headers['Mcp-Session-Id'] = r.headers['Mcp-Session-Id']
        return resp

@app.route('/api/memories', methods=['GET'])
def get_memories():
    files = []
    for f in sorted(os.listdir(MEMORIES_DIR), reverse=True):
        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
            ts_str = f.rsplit('.', 1)[0]
            note = ''
            note_path = os.path.join(MEMORIES_DIR, ts_str + '.txt')
            if os.path.exists(note_path):
                with open(note_path, 'r', encoding='utf-8') as nf:
                    note = nf.read().strip()
            files.append({'filename': f, 'url': f'/memories/{f}', 'note': note, 'ts': ts_str})
    return jsonify(files)

@app.route('/api/memories', methods=['POST'])
def upload_memory():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    file = request.files['file']
    note = request.form.get('note', '').strip()
    ts = str(int(time.time() * 1000))
    ext = 'jpg'
    if file.filename and '.' in file.filename:
        ext = file.filename.rsplit('.', 1)[-1].lower()
    filename = f"{ts}.{ext}"
    file.save(os.path.join(MEMORIES_DIR, filename))
    if note:
        with open(os.path.join(MEMORIES_DIR, ts + '.txt'), 'w', encoding='utf-8') as nf:
            nf.write(note)
    return jsonify({'filename': filename, 'url': f'/memories/{filename}', 'ts': ts})

@app.route('/api/memories/<filename>', methods=['DELETE'])
def delete_memory(filename):
    safe = secure_filename(filename)
    fp = os.path.join(MEMORIES_DIR, safe)
    if os.path.exists(fp):
        os.remove(fp)
    ts_str = safe.rsplit('.', 1)[0]
    note_fp = os.path.join(MEMORIES_DIR, ts_str + '.txt')
    if os.path.exists(note_fp):
        os.remove(note_fp)
    return jsonify({'ok': True})

@app.route('/memories/<filename>')
def serve_memory(filename):
    return send_from_directory(MEMORIES_DIR, filename)

@app.route('/api/memories/<filename>/image', methods=['GET'])
def get_memory_image(filename):
    safe = secure_filename(filename)
    fp = os.path.join(MEMORIES_DIR, safe)
    if not os.path.exists(fp):
        return jsonify({'error': 'not found'}), 404
    ext = safe.rsplit('.', 1)[-1].lower()
    mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
            'gif': 'image/gif', 'webp': 'image/webp'}.get(ext, 'image/jpeg')
    with open(fp, 'rb') as f:
        data = base64.b64encode(f.read()).decode()
    note = ''
    ts_str = safe.rsplit('.', 1)[0]
    note_path = os.path.join(MEMORIES_DIR, ts_str + '.txt')
    if os.path.exists(note_path):
        with open(note_path, 'r', encoding='utf-8') as nf:
            note = nf.read().strip()
    return jsonify({'filename': safe, 'note': note, 'mime': mime, 'data': data})

# ========== Anthropic 原生格式辅助函数 ==========

def _sanitize_messages_for_anthropic(messages):
    """
    Anthropic 原生格式清洗。处理三类历史遗留（前端 localStorage 里的旧对话）：
    - role=system 摘要消息 → 转 user 文本
    - role=tool（OpenAI 旧格式工具结果）→ 转 user 文本，保住记忆内容
    - assistant 带 tool_calls 字段（OpenAI 旧格式）→ 剥掉字段，content 为空则给占位
    新格式（content 块数组里的 tool_use / tool_result）原样保留。
    """
    out = []
    for m in messages:
        role = m.get('role')
        if role == 'system':
            content = m.get('content', '')
            if isinstance(content, list):
                content = ' '.join(b.get('text', '') for b in content if isinstance(b, dict))
            out.append({'role': 'user', 'content': f"（历史上下文）{content}"})
        elif role == 'tool':
            content = m.get('content', '')
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            out.append({'role': 'user', 'content': f"（历史工具结果）{content}"})
        elif role == 'assistant' and 'tool_calls' in m:
            content = m.get('content') or '（调用了工具）'
            out.append({'role': 'assistant', 'content': content})
        else:
            out.append(m)
    # 合并相邻同角色消息，保证严格交替
    merged = []
    for m in out:
        if merged and merged[-1]['role'] == m['role']:
            prev = merged[-1]
            pc = prev['content'] if isinstance(prev['content'], list) else [{'type': 'text', 'text': prev['content']}]
            cc = m['content'] if isinstance(m['content'], list) else [{'type': 'text', 'text': m['content']}]
            merged[-1] = {'role': m['role'], 'content': pc + cc}
        else:
            merged.append(dict(m))
    # Anthropic 要求首条消息必须是 user
    if merged and merged[0]['role'] != 'user':
        merged.insert(0, {'role': 'user', 'content': '（继续）'})
    return merged

def _add_cache_breakpoint_to_last_message(messages):
    """
    在最后一条消息的最后一个 content 块上加 cache_control，
    让对话历史前缀也能被缓存（多轮工具调用循环内命中率很高）。
    """
    if not messages:
        return messages
    last = dict(messages[-1])
    c = last.get('content')
    if isinstance(c, str):
        last['content'] = [{'type': 'text', 'text': c, 'cache_control': {'type': 'ephemeral'}}]
    elif isinstance(c, list) and c:
        blocks = [dict(b) if isinstance(b, dict) else b for b in c]
        last_block = blocks[-1]
        if isinstance(last_block, dict) and last_block.get('type') in ('text', 'tool_result', 'image', 'document'):
            last_block = dict(last_block)
            last_block['cache_control'] = {'type': 'ephemeral'}
            blocks[-1] = last_block
        last['content'] = blocks
    else:
        return messages
    return messages[:-1] + [last]

@app.route('/api/chat-v2', methods=['POST'])
def chat_v2():
    """
    改用 OpenRouter 的 Anthropic 原生 Messages 端点（/api/v1/messages）。

    prompt cache 设计（Anthropic 的缓存前缀顺序是 tools → system → messages）：
      断点1：tools 最后一个定义        —— 缓存全部工具定义（固定内容）
      断点2：system 数组最后一块       —— 缓存人设 prompt（固定内容）
      断点3：messages 最后一块         —— 缓存对话历史前缀（增量缓存）
    共 3 个断点，低于 Anthropic 的 4 断点上限。

    关键前提：system prompt 必须保持逐字节固定。
    动态内容（时间、状态、摘要）一律走 messages，绝不进 system。
    """
    data = request.json
    session_id = data.get('_session_id', 'default')
    raw_messages = data.get('messages', [])
    system_prompt = data.get('system', '')

    # 1. 对话截断（纯 slice，不生成摘要——早期内容靠 Ombre Brain 记忆库）
    raw_messages, keep_from = compress_messages(raw_messages)

    # 2. 规范化消息：system 角色转 user、合并相邻同角色
    msgs = _sanitize_messages_for_anthropic(raw_messages)

    # 3. 对话历史尾部加缓存断点
    msgs = _add_cache_breakpoint_to_last_message(msgs)

    # 4. system：固定内容 + cache_control。不追加任何动态内容！
    system_blocks = []
    if system_prompt:
        system_blocks.append({
            'type': 'text',
            'text': system_prompt,
            'cache_control': {'type': 'ephemeral', 'ttl': CACHE_TTL_STATIC}
        })

    # 前端传的 max_tokens 是"回复长度"（默认 180）；Anthropic 原生 API 的
    # max_tokens 包含 thinking 消耗且必须大于 budget_tokens，所以在这里加总。
    reply_tokens = int(data.get('max_tokens', 800) or 800)
    is_ping = bool(data.get('_ping') or data.get('_keepalive'))
    payload = {
        'model': data.get('model', 'anthropic/claude-sonnet-4-6'),
        'messages': msgs,
        'stream': True,
        'max_tokens': 1 if is_ping else reply_tokens + THINKING_BUDGET,
        # 锁定 Anthropic 官方 provider：prompt cache 是 per-provider 的，
        # 被 fallback 路由到 Bedrock/Vertex 会导致缓存全 miss。
        # 代价：Anthropic 官方端点故障时本请求直接失败（对缓存优先的场景是正确取舍）。
        'provider': {'order': ['anthropic'], 'allow_fallbacks': False},
    }
    if not is_ping:
        payload['thinking'] = {'type': 'enabled', 'budget_tokens': THINKING_BUDGET}
    if system_blocks:
        payload['system'] = system_blocks

    # 5. 工具定义（前端需传 Anthropic 格式：{name, description, input_schema}）
    #    在最后一个工具上加 cache_control，即缓存整个 tools 前缀
    if data.get('tools'):
        tools = [dict(t) for t in data['tools']]
        tools[-1]['cache_control'] = {'type': 'ephemeral', 'ttl': CACHE_TTL_STATIC}
        payload['tools'] = tools
    if data.get('tool_choice'):
        payload['tool_choice'] = data['tool_choice']

    def gen():
        with HTTP.post(
            'https://openrouter.ai/api/v1/messages',
            headers={'Authorization': f'Bearer {OR_KEY}', 'Content-Type': 'application/json'},
            json=payload, stream=True, timeout=180
        ) as r:
            if r.status_code != 200:
                err = r.content.decode('utf-8', errors='replace')
                yield f'event: error\ndata: {json.dumps({"type": "error", "status": r.status_code, "body": err[:500]})}\n\n'
                return
            for line in r.iter_lines():
                if line:
                    yield line.decode() + '\n'
                else:
                    yield '\n'
        # 流结束后通知前端本轮的截断结果：
        # 前端执行 messages = messages.slice(keep_from) 并保存，
        # 之后发来的历史就是短的，不再重复触发截断。
        if keep_from >= 0:
            yield 'event: compressed\ndata: ' + json.dumps({
                'type': 'compressed',
                'keep_from': keep_from
            }) + '\n\n'

    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

VOICE_CALM = 'BzWc3iJ0MiRdqIo6RCvM'
VOICE_DOG = '2cdvnKJ5TZi631y5PN1s'

@app.route('/api/tts', methods=['POST'])
def tts():
    if not EL_KEY:
        return jsonify({'error': 'ElevenLabs key not set'}), 500
    data = request.json
    text = data.get('text', '').strip()
    voice = data.get('voice', 'calm')
    if not text:
        return jsonify({'error': 'no text'}), 400
    voice_id = VOICE_DOG if voice == 'dog' else VOICE_CALM
    if len(text) > 500:
        text = text[:500]
    r = requests.post(
        f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream',
        headers={'xi-api-key': EL_KEY, 'Content-Type': 'application/json'},
        json={'text': text, 'model_id': 'eleven_multilingual_v2',
              'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}},
        stream=True, timeout=30
    )
    if r.status_code != 200:
        return jsonify({'error': 'TTS failed', 'status': r.status_code}), 500
    def gen():
        for chunk in r.iter_content(chunk_size=1024):
            if chunk:
                yield chunk
    return Response(gen(), mimetype='audio/mpeg', headers={'Cache-Control': 'no-cache'})

@app.route('/api/session/<session_id>', methods=['DELETE'])
def clear_session(session_id):
    """清空某会话的记忆摘要文件（对话摘要机制已移除，无需再清）。"""
    removed = []
    path = get_memory_summary_file(session_id)
    if os.path.exists(path):
        try:
            os.remove(path)
            removed.append(os.path.basename(path))
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'removed': removed})

@app.route('/api/key-info', methods=['GET'])
def key_info():
    try:
        r = requests.get('https://openrouter.ai/api/v1/auth/key',
                         headers={'Authorization': f'Bearer {OR_KEY}'}, timeout=10)
        return jsonify(r.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
