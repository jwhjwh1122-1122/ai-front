from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time, base64
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
EL_KEY = os.environ.get('ELEVENLABS_API_KEY', '')
MCP_URL = 'https://ombrebrain-jwh.zeabur.app/mcp'
MEMORIES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'memories')
os.makedirs(MEMORIES_DIR, exist_ok=True)

@app.route('/')
def index():
    return send_from_directory('static', 'chat.html')

@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json')

@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.json
    payload = {
        'model': 'anthropic/claude-sonnet-4-6',
        'messages': data.get('messages', []),
        'stream': True,
        'max_tokens': 8000,
    }
    if data.get('system'):
        payload['system'] = data['system']
    def gen():
        with requests.post(
            'https://openrouter.ai/api/v1/chat/completions',
            headers={'Authorization': f'Bearer {OR_KEY}', 'Content-Type': 'application/json'},
            json=payload, stream=True, timeout=120
        ) as r:
            for line in r.iter_lines():
                if line:
                    yield line.decode() + '\n\n'
    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== MCP 代理（支持 SSE 流式转发）====================
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

    r = requests.post(MCP_URL, json=data, headers=headers, stream=True, timeout=30)
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

# ── 时光墙 ──
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
    data = request.json
    payload = {
        'model': data.get('model', 'anthropic/claude-sonnet-4-6'),
        'messages': data.get('messages', []),
        'stream': True,
        'max_tokens': 8000,
        'thinking': {'type': 'enabled', 'budget_tokens': 5000},
    }
    if data.get('system'):
        payload['system'] = data['system']
    if data.get('tools'):
        payload['tools'] = data['tools']
    if data.get('tool_choice'):
        payload['tool_choice'] = data['tool_choice']
    def gen():
        with requests.post(
            'https://openrouter.ai/api/v1/chat/completions',
            headers={'Authorization': f'Bearer {OR_KEY}', 'Content-Type': 'application/json'},
            json=payload, stream=True, timeout=180
        ) as r:
            for line in r.iter_lines():
                if line:
                    yield line.decode() + '\n\n'
    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

VOICE_CALM = 'BzWc3iJ0MiRdqIo6RCvM'
VOICE_DOG  = '2cdvnKJ5TZi631y5PN1s'

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

# ==================== 增强版 test-ob（稳健 SSE 解析）====================
@app.route('/api/test-ob', methods=['GET'])
def test_ob():
    try:
        # 1. 初始化
        init_payload = {
            'jsonrpc': '2.0',
            'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'capabilities': {},
                'clientInfo': {'name': 'test', 'version': '1.0'}
            },
            'id': 1
        }
        r1 = requests.post(
            MCP_URL,
            json=init_payload,
            headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'},
            timeout=15
        )
        if r1.status_code != 200:
            return jsonify({'error': f'Initialize failed with status {r1.status_code}', 'response': r1.text}), 500
        try:
            init_json = r1.json()
            if 'error' in init_json:
                return jsonify({'error': 'Initialize returned error', 'details': init_json['error']}), 500
        except:
            init_json = None

        sid = r1.headers.get('Mcp-Session-Id', '')
        if not sid:
            return jsonify({'error': 'No Mcp-Session-Id in initialize response'}), 500

        # 2. 发送 notifications/initialized
        notify_headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Session-Id': sid
        }
        r2 = requests.post(
            MCP_URL,
            json={'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}},
            headers=notify_headers,
            timeout=10
        )
        if r2.status_code not in [200, 202]:
            return jsonify({'error': f'Initialized notification failed with status {r2.status_code}', 'response': r2.text}), 500

        # 3. 调用 breath
        breath_payload = {
            'jsonrpc': '2.0',
            'method': 'tools/call',
            'params': {
                'name': 'breath',
                'arguments': {'max_results': 5, 'max_tokens': 2000}
            },
            'id': 2
        }
        r3 = requests.post(
            MCP_URL,
            json=breath_payload,
            headers=notify_headers,
            timeout=30
        )

        if r3.status_code != 200:
            return jsonify({'error': f'Breath failed with status {r3.status_code}', 'response_text': r3.text[:500]}), 500

        content_type = r3.headers.get('Content-Type', '')
        # 解析响应
        if 'text/event-stream' in content_type:
            # 稳健的 SSE 解析：按事件分割
            lines = r3.text.splitlines()
            events = []
            current_data = []
            for line in lines:
                if line.startswith('data: '):
                    current_data.append(line[6:])
                elif line == '' and current_data:
                    # 空行表示事件结束
                    events.append(''.join(current_data))
                    current_data = []
            if current_data:  # 如果文件末尾没有空行，也加入
                events.append(''.join(current_data))

            if not events:
                return jsonify({'error': 'No SSE events found', 'raw': r3.text[:500]}), 500

            # 取第一个事件的数据
            data_str = events[0]
            try:
                breath_json = json.loads(data_str)
            except Exception as e:
                return jsonify({'error': f'Failed to parse JSON from SSE data: {e}', 'data_str': data_str}), 500
        else:
            try:
                breath_json = r3.json()
            except Exception as e:
                return jsonify({'error': f'Response is not valid JSON: {e}', 'raw': r3.text[:500]}), 500

        return jsonify({
            'session_id': sid,
            'initialize_response': init_json if init_json else r1.text[:200],
            'breath': breath_json
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

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
