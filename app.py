from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time, base64, hashlib, io
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
EL_KEY = os.environ.get('ELEVENLABS_API_KEY', '')
MCP_URL = 'https://jwhjwh.zeabur.app/mcp'

MEMORIES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'memories')
os.makedirs(MEMORIES_DIR, exist_ok=True)

# 思考预算（tokens）。OpenRouter 规定：max_tokens 必须严格大于思考预算，
# 且思考预算最小 1024。所以最终发出去的 max_tokens = 用户设置 + REASONING_BUDGET。
REASONING_BUDGET = 2000

# ========== 记忆摘要存储 ==========
MEMORY_SUMMARY_DIR = os.path.join(os.path.dirname(__file__), 'memory_summaries')
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
        except Exception:
            return {}
    return {}

def save_memory_summary(session_id, memory_data):
    fpath = get_memory_summary_file(session_id)
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(memory_data, f)

def update_memory_summary(session_id, tool_name, summary_text):
    data = load_memory_summary(session_id)
    if tool_name == 'breath':
        data['last_breath'] = {'content': summary_text, 'timestamp': time.time()}
    elif tool_name == 'view_memory':
        data['last_view_memory'] = {'content': summary_text, 'timestamp': time.time()}
        if 'viewed_photos' not in data:
            data['viewed_photos'] = []
        if summary_text not in data['viewed_photos']:
            data['viewed_photos'].append(summary_text)
        if len(data['viewed_photos']) > 10:
            data['viewed_photos'] = data['viewed_photos'][-10:]
    save_memory_summary(session_id, data)
    return data

def get_memory_summary_text(session_id):
    data = load_memory_summary(session_id)
    parts = []
    if data.get('last_breath'):
        parts.append(f"【上次读取记忆】{data['last_breath']['content']}")
    if data.get('last_view_memory'):
        parts.append(f"【上次查看时光墙照片】{data['last_view_memory']['content']}")
    if data.get('viewed_photos'):
        recent = data['viewed_photos'][-3:]
        if recent:
            parts.append(f"【最近看过的时光墙照片】{'; '.join(recent)}")
    return "\n".join(parts) if parts else ""


# ============================================================
# 翻译层：前端说 Anthropic 原生格式，OpenRouter 说 OpenAI 格式
# ============================================================

def _blocks_to_openai_content(blocks):
    """Anthropic content 块数组 -> OpenAI content（字符串或 parts 数组）"""
    if not isinstance(blocks, list):
        return blocks
    parts = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get('type')
        if t == 'text':
            parts.append({'type': 'text', 'text': b.get('text', '')})
        elif t == 'image':
            src = b.get('source') or {}
            if src.get('type') == 'base64':
                url = f"data:{src.get('media_type','image/jpeg')};base64,{src.get('data','')}"
                parts.append({'type': 'image_url', 'image_url': {'url': url}})
        elif t == 'image_url':
            parts.append(b)
    if not parts:
        return ''
    if len(parts) == 1 and parts[0]['type'] == 'text':
        return parts[0]['text']
    return parts


def to_openai_messages(messages):
    """把前端的 Anthropic 风格消息数组翻译成 OpenAI 风格"""
    out = []
    for m in messages or []:
        role = m.get('role')
        content = m.get('content')

        if role == 'assistant':
            text_parts, tool_calls, reasoning_details = [], [], []
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get('type')
                    if bt == 'text':
                        text_parts.append(b.get('text', ''))
                    elif bt == 'thinking':
                        rd = {
                            'type': 'reasoning.text',
                            'text': b.get('thinking', ''),
                            'format': 'anthropic-claude-v1',
                            'index': len(reasoning_details),
                        }
                        if b.get('signature'):
                            rd['signature'] = b['signature']
                        reasoning_details.append(rd)
                    elif bt == 'tool_use':
                        tool_calls.append({
                            'id': b.get('id'),
                            'type': 'function',
                            'function': {
                                'name': b.get('name'),
                                'arguments': json.dumps(b.get('input') or {}, ensure_ascii=False),
                            },
                        })
            msg = {'role': 'assistant', 'content': ''.join(text_parts)}
            if tool_calls:
                msg['tool_calls'] = tool_calls
            if reasoning_details:
                msg['reasoning_details'] = reasoning_details
            out.append(msg)
            continue

        # user：可能混着 tool_result 块（要拆成独立的 tool 消息）
        if role == 'user' and isinstance(content, list):
            tool_results = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_result']
            others = [b for b in content if isinstance(b, dict) and b.get('type') != 'tool_result']
            for tr in tool_results:
                c = tr.get('content')
                if not isinstance(c, str):
                    c = json.dumps(c, ensure_ascii=False)
                out.append({'role': 'tool', 'tool_call_id': tr.get('tool_use_id'), 'content': c})
            if others:
                out.append({'role': 'user', 'content': _blocks_to_openai_content(others)})
            continue

        if role == 'tool':
            out.append(m)
            continue

        out.append({'role': role, 'content': _blocks_to_openai_content(content)})
    return out


def to_openai_tools(tools):
    """Anthropic 工具定义 -> OpenAI function 定义"""
    result = []
    for t in tools or []:
        if t.get('type') == 'function':
            result.append(t)
            continue
        result.append({
            'type': 'function',
            'function': {
                'name': t.get('name'),
                'description': t.get('description', ''),
                'parameters': t.get('input_schema') or {'type': 'object', 'properties': {}},
            },
        })
    return result


def sse(obj):
    return 'data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n'


def translate_stream(resp):
    """OpenAI 风格 SSE -> Anthropic 风格 SSE（前端认识的那套）"""
    THINK_IDX, TEXT_IDX = 0, 1
    think_open = text_open = False
    tool_blocks = {}          # openai tool_call index -> our block index
    next_tool_idx = 2
    open_tool_indices = []
    stop_reason = 'end_turn'
    started = False
    last_usage = None

    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode('utf-8', 'ignore')
        if line.startswith(':'):          # OpenRouter 心跳，丢掉
            continue
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if not payload or payload == '[DONE]':
            continue
        try:
            d = json.loads(payload)
        except Exception:
            continue

        if not started:
            started = True
            yield sse({'type': 'message_start', 'message': {'usage': d.get('usage') or {}}})

        if d.get('usage'):
            last_usage = d['usage']

        choices = d.get('choices') or []
        if not choices:
            continue
        ch = choices[0]
        delta = ch.get('delta') or {}

        # ── 思考 ──
        think_text, think_sig = '', None
        rds = delta.get('reasoning_details')
        if rds:
            for item in rds:
                if item.get('text'):
                    think_text += item['text']
                if item.get('signature'):
                    think_sig = item['signature']
        elif delta.get('reasoning'):
            think_text = delta['reasoning']

        if think_text or think_sig:
            if not think_open:
                think_open = True
                yield sse({'type': 'content_block_start', 'index': THINK_IDX,
                           'content_block': {'type': 'thinking', 'thinking': ''}})
            if think_text:
                yield sse({'type': 'content_block_delta', 'index': THINK_IDX,
                           'delta': {'type': 'thinking_delta', 'thinking': think_text}})
            if think_sig:
                yield sse({'type': 'content_block_delta', 'index': THINK_IDX,
                           'delta': {'type': 'signature_delta', 'signature': think_sig}})

        # ── 正文 ──
        if delta.get('content'):
            if think_open:
                think_open = False
                yield sse({'type': 'content_block_stop', 'index': THINK_IDX})
            if not text_open:
                text_open = True
                yield sse({'type': 'content_block_start', 'index': TEXT_IDX,
                           'content_block': {'type': 'text', 'text': ''}})
            yield sse({'type': 'content_block_delta', 'index': TEXT_IDX,
                       'delta': {'type': 'text_delta', 'text': delta['content']}})

        # ── 工具调用 ──
        for tc in delta.get('tool_calls') or []:
            oi = tc.get('index', 0)
            if oi not in tool_blocks:
                if think_open:
                    think_open = False
                    yield sse({'type': 'content_block_stop', 'index': THINK_IDX})
                tool_blocks[oi] = next_tool_idx
                open_tool_indices.append(next_tool_idx)
                fn = tc.get('function') or {}
                yield sse({'type': 'content_block_start', 'index': next_tool_idx,
                           'content_block': {'type': 'tool_use',
                                             'id': tc.get('id') or f'call_{next_tool_idx}',
                                             'name': fn.get('name') or '',
                                             'input': {}}})
                next_tool_idx += 1
            args = (tc.get('function') or {}).get('arguments')
            if args:
                yield sse({'type': 'content_block_delta', 'index': tool_blocks[oi],
                           'delta': {'type': 'input_json_delta', 'partial_json': args}})

        fr = ch.get('finish_reason')
        if fr:
            stop_reason = 'tool_use' if fr == 'tool_calls' else ('max_tokens' if fr == 'length' else 'end_turn')

    if think_open:
        yield sse({'type': 'content_block_stop', 'index': THINK_IDX})
    if text_open:
        yield sse({'type': 'content_block_stop', 'index': TEXT_IDX})
    for idx in open_tool_indices:
        yield sse({'type': 'content_block_stop', 'index': idx})
    if tool_blocks:
        stop_reason = 'tool_use'
    yield sse({'type': 'message_delta', 'delta': {'stop_reason': stop_reason},
               'usage': last_usage or {}})
    yield 'data: [DONE]\n\n'


# ========== 路由 ==========

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

def _mcp_once(url, body, sid=None, timeout=60):
    """对任意 MCP 服务器发一次请求，返回 (解析后的 result, 会话id)"""
    headers = {'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream'}
    if sid:
        headers['Mcp-Session-Id'] = sid
    r = requests.post(url, json=body, headers=headers, timeout=timeout)
    new_sid = r.headers.get('Mcp-Session-Id') or sid
    text = r.text or ''
    ctype = r.headers.get('Content-Type', '')
    if 'text/event-stream' in ctype:
        buf = ''
        for line in text.split('\n'):
            if line.startswith('data:'):
                buf += line[5:].strip()
        text = buf
    try:
        d = json.loads(text)
    except Exception:
        return {'error': 'parse failed', 'raw': text[:300]}, new_sid
    return d.get('result', d), new_sid


@app.route('/api/mcp-connect', methods=['POST'])
def mcp_connect():
    """连一个 MCP 服务器，握手并把它的工具列表拉回来"""
    data = request.json or {}
    url = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': '请填写服务器地址'}), 400
    try:
        _, sid = _mcp_once(url, {
            'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
            'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
                       'clientInfo': {'name': 'ai-front', 'version': '1.0'}}
        })
        if sid:
            try:
                requests.post(url, json={'jsonrpc': '2.0', 'method': 'notifications/initialized',
                                         'params': {}},
                              headers={'Content-Type': 'application/json',
                                       'Accept': 'application/json, text/event-stream',
                                       'Mcp-Session-Id': sid}, timeout=30)
            except Exception:
                pass
        result, sid = _mcp_once(url, {'jsonrpc': '2.0', 'id': 2,
                                      'method': 'tools/list', 'params': {}}, sid)
        tools = result.get('tools') if isinstance(result, dict) else None
        if tools is None:
            return jsonify({'error': '连上了但没拿到工具列表', 'raw': str(result)[:300]}), 502
        slim = [{'name': t.get('name'),
                 'description': (t.get('description') or '')[:300],
                 'input_schema': t.get('inputSchema') or t.get('input_schema')
                                 or {'type': 'object', 'properties': {}}}
                for t in tools if t.get('name')]
        return jsonify({'ok': True, 'session_id': sid, 'tools': slim})
    except Exception as e:
        return jsonify({'error': f'连接失败：{e}'}), 502


@app.route('/api/mcp', methods=['POST'])
def mcp():
    data = request.json
    sid = request.headers.get('Mcp-Session-Id')
    if not sid:
        sid = data.pop('_sid', None)
    target = data.pop('_server', None) or MCP_URL
    headers = {'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream'}
    if sid:
        headers['Mcp-Session-Id'] = sid
    r = requests.post(target, json=data, headers=headers, stream=True, timeout=120)
    content_type = r.headers.get('Content-Type', 'application/json')
    if 'text/event-stream' in content_type:
        def generate():
            for chunk in r.iter_content(chunk_size=1024):
                if chunk:
                    yield chunk
        resp = Response(generate(), mimetype=content_type)
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


@app.route('/api/chat-v2', methods=['POST'])
def chat_v2():
    data = request.json or {}
    session_id = data.get('_session_id', 'default')
    keepalive = bool(data.get('_keepalive'))
    raw_messages = data.get('messages', [])
    system_prompt = data.get('system', '')

    # 记忆摘要附加到 system（放在末尾，前面的人设保持不变 → 缓存前缀稳定）
    memory_summary = get_memory_summary_text(session_id)
    if memory_summary:
        system_prompt = (system_prompt + "\n\n" if system_prompt else "") + \
                        f"【已读记忆/已看照片摘要】\n{memory_summary}"

    oa_messages = to_openai_messages(raw_messages)
    if system_prompt:
        oa_messages = [{'role': 'system', 'content': system_prompt}] + oa_messages

    user_max = int(data.get('max_tokens', 800) or 800)

    payload = {
        'model': data.get('model', 'anthropic/claude-sonnet-4-6'),
        'messages': oa_messages,
        'stream': True,
        # 自动缓存：OpenRouter 会把断点放在最后一个可缓存块并随对话前移
        'cache_control': {'type': 'ephemeral', 'ttl': '1h'},
        'session_id': str(session_id)[:256],   # 粘性路由，保证缓存命中同一家
        'usage': {'include': True},
    }

    if keepalive:
        payload['max_tokens'] = 1
    else:
        # OpenRouter 规定 max_tokens 必须严格大于思考预算
        payload['max_tokens'] = user_max + REASONING_BUDGET
        payload['reasoning'] = {'max_tokens': REASONING_BUDGET}

    if data.get('tools'):
        payload['tools'] = to_openai_tools(data['tools'])
    if data.get('tool_choice'):
        payload['tool_choice'] = data['tool_choice']

    def gen():
        try:
            with requests.post(
                'https://openrouter.ai/api/v1/chat/completions',
                headers={'Authorization': f'Bearer {OR_KEY}',
                         'Content-Type': 'application/json'},
                json=payload, stream=True, timeout=180
            ) as r:
                if r.status_code != 200:
                    body = r.text[:500]
                    print(f"[chat-v2] 上游 {r.status_code}: {body}", flush=True)
                    yield sse({'type': 'content_block_start', 'index': 1,
                               'content_block': {'type': 'text', 'text': ''}})
                    yield sse({'type': 'content_block_delta', 'index': 1,
                               'delta': {'type': 'text_delta',
                                         'text': f'（出错了 {r.status_code}：{body[:200]}）'}})
                    yield sse({'type': 'content_block_stop', 'index': 1})
                    yield sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {}})
                    yield 'data: [DONE]\n\n'
                    return
                for chunk in translate_stream(r):
                    yield chunk
        except Exception as e:
            print(f"[chat-v2] 异常: {e}", flush=True)
            yield sse({'type': 'content_block_start', 'index': 1,
                       'content_block': {'type': 'text', 'text': ''}})
            yield sse({'type': 'content_block_delta', 'index': 1,
                       'delta': {'type': 'text_delta', 'text': f'（连接出错：{e}）'}})
            yield sse({'type': 'content_block_stop', 'index': 1})
            yield sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {}})
            yield 'data: [DONE]\n\n'

    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


# ============================================================
# 放映室：存视频、转录台词
# ============================================================
VIDEOS_DIR = os.path.join(os.path.dirname(__file__), 'static', 'videos')
os.makedirs(VIDEOS_DIR, exist_ok=True)
VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.webm', '.mkv')


@app.route('/api/videos', methods=['GET'])
def list_videos():
    out = []
    for f in sorted(os.listdir(VIDEOS_DIR), reverse=True):
        if not f.lower().endswith(VIDEO_EXT):
            continue
        base = f.rsplit('.', 1)[0]
        note = ''
        np = os.path.join(VIDEOS_DIR, base + '.txt')
        if os.path.exists(np):
            with open(np, 'r', encoding='utf-8') as nf:
                note = nf.read().strip()
        has_tr = os.path.exists(os.path.join(VIDEOS_DIR, base + '.trans.txt'))
        try:
            size = os.path.getsize(os.path.join(VIDEOS_DIR, f))
        except Exception:
            size = 0
        out.append({'filename': f, 'url': f'/videos/{f}', 'note': note,
                    'ts': base, 'size': size, 'transcribed': has_tr})
    return jsonify(out)


@app.route('/api/videos', methods=['POST'])
def upload_video():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    note = (request.form.get('note') or '').strip()
    ext = 'mp4'
    if f.filename and '.' in f.filename:
        ext = f.filename.rsplit('.', 1)[-1].lower()
    if '.' + ext not in VIDEO_EXT:
        return jsonify({'error': '这个格式放不了，用 mp4 或 mov'}), 400
    ts = str(int(time.time() * 1000))
    fn = f'{ts}.{ext}'
    f.save(os.path.join(VIDEOS_DIR, fn))
    if note:
        with open(os.path.join(VIDEOS_DIR, ts + '.txt'), 'w', encoding='utf-8') as nf:
            nf.write(note)
    return jsonify({'filename': fn, 'url': f'/videos/{fn}', 'ts': ts})


@app.route('/api/videos/<filename>', methods=['DELETE'])
def delete_video(filename):
    safe = secure_filename(filename)
    base = safe.rsplit('.', 1)[0]
    for p in (os.path.join(VIDEOS_DIR, safe),
              os.path.join(VIDEOS_DIR, base + '.txt'),
              os.path.join(VIDEOS_DIR, base + '.trans.txt')):
        if os.path.exists(p):
            os.remove(p)
    return jsonify({'ok': True})


@app.route('/videos/<filename>')
def serve_video(filename):
    # conditional=True 让浏览器能拖进度条（Range 请求）
    return send_from_directory(VIDEOS_DIR, filename, conditional=True)


@app.route('/api/videos/<filename>/transcribe', methods=['POST'])
def transcribe_video(filename):
    """把视频里的话转成文字，转过一次就存下来，不重复花钱"""
    safe = secure_filename(filename)
    fp = os.path.join(VIDEOS_DIR, safe)
    if not os.path.exists(fp):
        return jsonify({'error': '视频不在了'}), 404
    cache = os.path.join(VIDEOS_DIR, safe.rsplit('.', 1)[0] + '.trans.txt')
    if os.path.exists(cache):
        with open(cache, 'r', encoding='utf-8') as f:
            return jsonify({'text': f.read(), 'cached': True})
    if not EL_KEY:
        return jsonify({'error': '语音识别未配置'}), 500
    if os.path.getsize(fp) > 90 * 1024 * 1024:
        return jsonify({'error': '视频太大了，转录不了（90MB 以内）'}), 400
    last_err = ''
    for model_id in ('scribe_v2', 'scribe_v1'):
        try:
            with open(fp, 'rb') as vf:
                r = requests.post('https://api.elevenlabs.io/v1/speech-to-text',
                                  headers={'xi-api-key': EL_KEY},
                                  files={'file': (safe, vf, 'video/mp4')},
                                  data={'model_id': model_id}, timeout=300)
            if r.status_code == 200:
                text = ((r.json() or {}).get('text') or '').strip()
                with open(cache, 'w', encoding='utf-8') as f:
                    f.write(text)
                return jsonify({'text': text, 'cached': False})
            last_err = f'{r.status_code} {r.text[:200]}'
        except Exception as e:
            last_err = str(e)
    return jsonify({'error': f'转录失败：{last_err}'}), 502


VOICE_CALM = 'BzWc3iJ0MiRdqIo6RCvM'
VOICE_DOG = '2cdvnKJ5TZi631y5PN1s'


# ============================================================
# 书房：存书、拆页、记进度
# ============================================================
BOOKS_DIR = os.path.join(os.path.dirname(__file__), 'books')
os.makedirs(BOOKS_DIR, exist_ok=True)
PAGE_CHARS = 900          # 一页约 900 字，手机上一屏多一点


def _decode_text(raw):
    for enc in ('utf-8', 'utf-8-sig', 'gb18030', 'big5'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'ignore')


def _strip_html(html):
    import re as _re
    html = _re.sub(r'(?is)<(script|style).*?</\1>', ' ', html)
    html = _re.sub(r'(?i)<br\s*/?>', '\n', html)
    html = _re.sub(r'(?i)</(p|div|h[1-6]|li)>', '\n\n', html)
    text = _re.sub(r'(?s)<[^>]+>', '', html)
    import html as _html
    text = _html.unescape(text)
    text = _re.sub(r'[ \t]+', ' ', text)
    text = _re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _read_epub(raw):
    """不装额外依赖，epub 本质就是个 zip"""
    import zipfile, re as _re
    title = ''
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = z.namelist()
        opf_path = None
        if 'META-INF/container.xml' in names:
            c = z.read('META-INF/container.xml').decode('utf-8', 'ignore')
            m = _re.search(r'full-path="([^"]+)"', c)
            if m:
                opf_path = m.group(1)
        order = []
        if opf_path and opf_path in names:
            opf = z.read(opf_path).decode('utf-8', 'ignore')
            tm = _re.search(r'(?is)<dc:title[^>]*>(.*?)</dc:title>', opf)
            if tm:
                title = _strip_html(tm.group(1))[:80]
            manifest = dict(_re.findall(r'(?is)<item\b[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"', opf))
            manifest2 = dict(_re.findall(r'(?is)<item\b[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"', opf))
            for href, iid in manifest2.items():
                manifest.setdefault(iid, href)
            base = opf_path.rsplit('/', 1)[0] if '/' in opf_path else ''
            for idref in _re.findall(r'(?is)<itemref\b[^>]*?idref="([^"]+)"', opf):
                href = manifest.get(idref)
                if not href:
                    continue
                full = (base + '/' + href) if base else href
                full = full.replace('/./', '/')
                if full in names:
                    order.append(full)
        if not order:
            order = sorted(n for n in names
                           if n.lower().endswith(('.xhtml', '.html', '.htm')))
        parts = []
        for n in order:
            try:
                parts.append(_strip_html(z.read(n).decode('utf-8', 'ignore')))
            except Exception:
                continue
    return title, '\n\n'.join(p for p in parts if p.strip())


def _paginate(text):
    """按段落攒页，尽量不把一段话拦腰截断"""
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    pages, buf = [], ''
    for p in paras:
        while len(p) > PAGE_CHARS:
            if buf:
                pages.append(buf.strip())
                buf = ''
            cut = p.rfind('。', 0, PAGE_CHARS)
            if cut < PAGE_CHARS // 2:
                cut = PAGE_CHARS
            else:
                cut += 1
            pages.append(p[:cut].strip())
            p = p[cut:]
        if len(buf) + len(p) + 1 > PAGE_CHARS and buf:
            pages.append(buf.strip())
            buf = p
        else:
            buf = (buf + '\n' + p) if buf else p
    if buf.strip():
        pages.append(buf.strip())
    return pages or ['（这本书是空的）']


def _book_path(bid):
    return os.path.join(BOOKS_DIR, secure_filename(bid) + '.json')


def _load_book(bid):
    p = _book_path(bid)
    if not os.path.exists(p):
        return None
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def _save_book(book):
    with open(_book_path(book['id']), 'w', encoding='utf-8') as f:
        json.dump(book, f, ensure_ascii=False)


# ---- 网上找书：中文维基文库（古籍/公版）+ 古腾堡（外文公版）----
NET_UA = {'User-Agent': 'LinStudy/1.0 (https://jwh.zeabur.app; personal reading app) python-requests',
          'Accept': 'application/json'}
WS_API = 'https://zh.wikisource.org/w/api.php'
WS_REST = 'https://zh.wikisource.org/w/rest.php/v1/search/page'


def _safe_url(u):
    from urllib.parse import urlparse
    p = urlparse(u or '')
    if p.scheme not in ('http', 'https'):
        return False
    host = (p.hostname or '').lower()
    if not host or host in ('localhost', '0.0.0.0', '::1'):
        return False
    if host.startswith(('127.', '10.', '192.168.', '169.254.', '172.16.',
                        '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.')):
        return False
    if host.endswith(('.internal', '.local')):
        return False
    return True


def _ws_search(q, limit=8):
    err = ''
    # 先走标准 API
    try:
        r = requests.get(WS_API, params={'action': 'query', 'list': 'search',
                                         'srsearch': q, 'srlimit': limit,
                                         'srnamespace': 0, 'format': 'json'},
                         headers=NET_UA, timeout=20)
        if r.status_code == 200:
            hits = (r.json().get('query') or {}).get('search') or []
            if hits:
                return [{'source': 'wikisource', 'ref': h['title'],
                         'title': h['title'], 'author': '中文维基文库'} for h in hits]
            err = '这个词没搜到'
        else:
            err = f'HTTP {r.status_code}'
    except Exception as e:
        err = str(e)[:120]
    # 备用：新版 REST 接口
    try:
        r = requests.get(WS_REST, params={'q': q, 'limit': limit},
                         headers=NET_UA, timeout=20)
        if r.status_code == 200:
            pages = r.json().get('pages') or []
            if pages:
                return [{'source': 'wikisource', 'ref': p.get('title'),
                         'title': p.get('title'), 'author': '中文维基文库'}
                        for p in pages if p.get('title')]
        else:
            err = err or f'REST HTTP {r.status_code}'
    except Exception as e:
        err = err or str(e)[:120]
    if err:
        raise RuntimeError(err)
    return []


def _ws_extract(titles):
    r = requests.get(WS_API, params={'action': 'query', 'prop': 'extracts',
                                     'explaintext': 1, 'exlimit': len(titles),
                                     'titles': '|'.join(titles), 'format': 'json'},
                     headers=NET_UA, timeout=45)
    pages = ((r.json().get('query') or {}).get('pages') or {}).values()
    return {p.get('title'): (p.get('extract') or '') for p in pages}


def _ws_fetch(title):
    """维基文库很多书是目录页 + 分章子页面，要按目录顺序拼起来"""
    main = _ws_extract([title]).get(title, '') or ''
    subs = []
    try:  # 先按目录页里的链接顺序取，章节次序才对
        r = requests.get(WS_API, params={'action': 'parse', 'page': title,
                                         'prop': 'links', 'format': 'json'},
                         headers=NET_UA, timeout=25)
        for l in ((r.json().get('parse') or {}).get('links') or []):
            t = l.get('*', '')
            if l.get('ns') == 0 and t.startswith(title + '/') and t not in subs:
                subs.append(t)
    except Exception:
        pass
    if not subs:
        try:
            r = requests.get(WS_API, params={'action': 'query', 'list': 'allpages',
                                             'apprefix': title + '/', 'apnamespace': 0,
                                             'aplimit': 300, 'format': 'json'},
                             headers=NET_UA, timeout=25)
            subs = [p['title'] for p in ((r.json().get('query') or {}).get('allpages') or [])]
        except Exception:
            subs = []
    if len(main) < 1200 and subs:
        parts = []
        for i in range(0, min(len(subs), 300), 20):
            batch = subs[i:i + 20]
            try:
                ex = _ws_extract(batch)
            except Exception:
                continue
            for t in batch:
                if ex.get(t, '').strip():
                    parts.append(ex[t].strip())
        if parts:
            return '\n\n'.join(parts)
    return main


def _gd_search(q, limit=8):
    r = requests.get('https://gutendex.com/books', params={'search': q},
                     headers=NET_UA, timeout=20)
    out = []
    for b in (r.json().get('results') or []):
        fmts = b.get('formats') or {}
        url = None
        for k, v in fmts.items():
            if k.startswith('text/plain') and not str(v).endswith('.zip'):
                url = v
                break
        if not url:
            continue
        au = (b.get('authors') or [{}])[0].get('name', '')
        out.append({'source': 'gutenberg', 'ref': url,
                    'title': (b.get('title') or '')[:80], 'author': au or '古腾堡'})
        if len(out) >= limit:
            break
    return out


def _gd_fetch(url):
    if not _safe_url(url):
        return ''
    r = requests.get(url, headers=NET_UA, timeout=60)
    text = _decode_text(r.content)
    import re as _re
    m = _re.search(r'(?i)\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*', text)
    if m:
        text = text[m.end():]
    m = _re.search(r'(?i)\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG', text)
    if m:
        text = text[:m.start()]
    return text.strip()


def _url_fetch(url):
    """贴任意网址：txt 直接读，网页去标签，epub 当书拆"""
    if not _safe_url(url):
        return '', ''
    r = requests.get(url, headers=NET_UA, timeout=60)
    ctype = (r.headers.get('Content-Type') or '').lower()
    if 'epub' in ctype or url.lower().endswith('.epub'):
        return _read_epub(r.content)
    raw = _decode_text(r.content)
    if 'html' in ctype or raw.lstrip()[:200].lower().startswith(('<!doctype', '<html')):
        import re as _re
        title = ''
        tm = _re.search(r'(?is)<title[^>]*>(.*?)</title>', raw)
        if tm:
            title = _strip_html(tm.group(1))[:80]
        body = raw
        bm = _re.search(r'(?is)<body[^>]*>(.*)</body>', raw)
        if bm:
            body = bm.group(1)
        return title, _strip_html(body)
    return '', raw


@app.route('/api/books/search', methods=['GET'])
def search_books():
    q = (request.args.get('q') or '').strip()
    if not q:
        return jsonify([])
    results, errs = [], []
    for fn, name in ((_ws_search, '维基文库'), (_gd_search, '古腾堡')):
        try:
            results += fn(q)
        except Exception as e:
            msg = str(e)[:120]
            errs.append(f'{name}：{msg}')
            print(f'[books/search] {name} 失败 q={q} err={msg}', flush=True)
    if not results:
        return jsonify({'error': '没找到。' + ('；'.join(errs) if errs else '换个书名试试')}), 200
    return jsonify(results)


@app.route('/api/books/fetch', methods=['POST'])
def fetch_book():
    data = request.json or {}
    src = data.get('source')
    ref = data.get('ref') or ''
    title = (data.get('title') or '').strip()[:80]
    try:
        if src == 'wikisource':
            text = _ws_fetch(ref)
        elif src == 'gutenberg':
            text = _gd_fetch(ref)
        else:
            t2, text = _url_fetch(ref)
            if not title:
                title = t2
    except Exception as e:
        return jsonify({'error': f'取不下来：{e}'}), 502
    text = (text or '').strip()
    if len(text) < 50:
        return jsonify({'error': '这个地址没读到正文'}), 400
    pages = _paginate(text)
    book = {'id': str(int(time.time() * 1000)), 'title': title or '无名',
            'pages': pages, 'progress': 0, 'added': int(time.time() * 1000)}
    _save_book(book)
    return jsonify({'id': book['id'], 'title': book['title'], 'pages': len(pages)})


@app.route('/api/books', methods=['GET'])
def list_books():
    out = []
    for fn in os.listdir(BOOKS_DIR):
        if not fn.endswith('.json'):
            continue
        try:
            with open(os.path.join(BOOKS_DIR, fn), 'r', encoding='utf-8') as f:
                b = json.load(f)
            out.append({'id': b['id'], 'title': b.get('title', '无名'),
                        'pages': len(b.get('pages', [])),
                        'progress': b.get('progress', 0),
                        'added': b.get('added', 0)})
        except Exception:
            continue
    out.sort(key=lambda x: x.get('added', 0))
    return jsonify(out)


@app.route('/api/books', methods=['POST'])
def add_book():
    title, text = '', ''
    if 'file' in request.files:
        f = request.files['file']
        raw = f.read()
        name = f.filename or 'book'
        if name.lower().endswith('.epub'):
            try:
                title, text = _read_epub(raw)
            except Exception as e:
                return jsonify({'error': f'epub 打不开：{e}'}), 400
        else:
            text = _decode_text(raw)
        if not title:
            title = os.path.splitext(os.path.basename(name))[0][:80]
    else:
        data = request.json or {}
        title = (data.get('title') or '无名').strip()[:80]
        text = data.get('text') or ''
    text = (text or '').strip()
    if not text:
        return jsonify({'error': '没读到正文'}), 400
    pages = _paginate(text)
    book = {'id': str(int(time.time() * 1000)), 'title': title or '无名',
            'pages': pages, 'progress': 0, 'added': int(time.time() * 1000)}
    _save_book(book)
    return jsonify({'id': book['id'], 'title': book['title'], 'pages': len(pages)})


@app.route('/api/books/<bid>', methods=['DELETE'])
def delete_book(bid):
    p = _book_path(bid)
    if os.path.exists(p):
        os.remove(p)
    return jsonify({'ok': True})


@app.route('/api/books/<bid>/page', methods=['GET'])
def book_page(bid):
    book = _load_book(bid)
    if not book:
        return jsonify({'error': 'not found'}), 404
    pages = book.get('pages', [])
    total = len(pages)
    try:
        i = int(request.args.get('i', 0))
    except Exception:
        i = 0
    i = max(0, min(i, total - 1))
    return jsonify({'index': i, 'total': total, 'text': pages[i],
                    'title': book.get('title', '')})


@app.route('/api/books/<bid>/progress', methods=['POST'])
def book_progress(bid):
    book = _load_book(bid)
    if not book:
        return jsonify({'error': 'not found'}), 404
    data = request.json or {}
    book['progress'] = max(0, int(data.get('page', 0)))
    _save_book(book)
    return jsonify({'ok': True})



@app.route('/api/stt', methods=['POST'])
def stt():
    """语音转文字：前端按住说话，录音传上来，转成文字返回"""
    if not EL_KEY:
        return jsonify({'error': '语音识别未配置'}), 500
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    audio = f.read()
    if not audio:
        return jsonify({'error': '录音是空的'}), 400
    last_err = ''
    for model_id in ('scribe_v2', 'scribe_v1'):
        try:
            r = requests.post(
                'https://api.elevenlabs.io/v1/speech-to-text',
                headers={'xi-api-key': EL_KEY},
                files={'file': (f.filename or 'audio.webm', audio,
                                f.mimetype or 'audio/webm')},
                data={'model_id': model_id},
                timeout=90)
            if r.status_code == 200:
                return jsonify({'text': (r.json() or {}).get('text', '').strip()})
            last_err = f'{r.status_code} {r.text[:200]}'
        except Exception as e:
            last_err = str(e)
    print(f'[stt] 失败: {last_err}', flush=True)
    return jsonify({'error': f'识别失败：{last_err}'}), 502


@app.route('/api/tts', methods=['POST'])
def tts():
    if not EL_KEY:
        return jsonify({'error': 'ElevenLabs key not set'}), 500
    data = request.json
    text = data.get('text', '').strip()
    voice = data.get('voice', 'calm')
    if not text:
        return jsonify({'error': 'no text'}), 400
    # 前端可以直接指定音色 ID（设置里填的），没填才用默认的
    voice_id = (data.get('voice_id') or '').strip() or \
               (VOICE_DOG if voice == 'dog' else VOICE_CALM)
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
