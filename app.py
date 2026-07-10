from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time, base64, hashlib
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
EL_KEY = os.environ.get('ELEVENLABS_API_KEY', '')
MCP_URL = 'https://ombrebrain-jwh.zeabur.app/mcp'
MEMORIES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'memories')
os.makedirs(MEMORIES_DIR, exist_ok=True)

# ========== 摘要存储 ==========
SUMMARY_DIR = os.path.join(os.path.dirname(__file__), 'summaries')
os.makedirs(SUMMARY_DIR, exist_ok=True)

def get_summary_file(session_id):
    safe_id = hashlib.md5(session_id.encode()).hexdigest()
    return os.path.join(SUMMARY_DIR, f"{safe_id}.json")

def load_summary(session_id):
    fpath = get_summary_file(session_id)
    if os.path.exists(fpath):
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return None
    return None

def save_summary(session_id, summary_data):
    fpath = get_summary_file(session_id)
    with open(fpath, 'w', encoding='utf-8') as f:
        json.dump(summary_data, f)

def generate_summary(messages, system_prompt):
    if not messages:
        return ""
    to_compress = messages[:10]
    compress_prompt = f"""你是一个摘要生成器。请将以下对话压缩成一段简短的摘要，保留关键信息和人物关系（凛和宝宝）。
只输出摘要内容，不要加任何额外说明。

对话内容：
{json.dumps(to_compress, ensure_ascii=False, indent=2)}

摘要："""
    try:
        resp = requests.post(
            'https://openrouter.ai/api/v1/chat/completions',
            headers={
                'Authorization': f'Bearer {OR_KEY}',
                'Content-Type': 'application/json'
            },
            json={
                'model': 'anthropic/claude-haiku-4-5',
                'messages': [
                    {'role': 'system', 'content': '你是一个专业的对话摘要工具。'},
                    {'role': 'user', 'content': compress_prompt}
                ],
                'max_tokens': 500,
                'temperature': 0.3,
                'stream': False
            },
            timeout=30
        )
        if resp.status_code == 200:
            data = resp.json()
            summary = data['choices'][0]['message']['content'].strip()
            return summary
        else:
            print(f"[Summary] 压缩失败，状态码 {resp.status_code}")
            return ""
    except Exception as e:
        print(f"[Summary] 压缩异常: {e}")
        return ""

def compress_messages(messages, session_id, system_prompt):
    THRESHOLD = 15
    KEEP = 5
    if len(messages) <= THRESHOLD:
        return messages, None

    summary_data = load_summary(session_id) or {}
    old_summary = summary_data.get('summary', '')

    to_compress = messages[:len(messages)-KEEP]
    recent = messages[len(messages)-KEEP:]

    if old_summary:
        combined = [{'role': 'system', 'content': f"之前的摘要：{old_summary}"}] + to_compress
    else:
        combined = to_compress

    new_summary_text = generate_summary(combined, system_prompt)
    if not new_summary_text and old_summary:
        new_summary_text = old_summary

    summary_msg = {'role': 'system', 'content': f"【对话摘要】{new_summary_text}"}
    new_messages = [summary_msg] + recent

    save_summary(session_id, {'summary': new_summary_text})

    return new_messages, new_summary_text

@app.route('/')
def index():
    return send_from_directory('static', 'chat.html')

@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json')

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

@app.route('/api/chat-v2', methods=['POST'])
def chat_v2():
    data = request.json
    session_id = data.get('_session_id', 'default')
    raw_messages = data.get('messages', [])
    system_prompt = data.get('system', '')

    compressed_messages, new_summary = compress_messages(raw_messages, session_id, system_prompt)
    if new_summary:
        if system_prompt:
            system_prompt = f"{system_prompt}\n\n【对话摘要】{new_summary}"
        else:
            system_prompt = f"【对话摘要】{new_summary}"
        raw_messages = compressed_messages

    payload = {
        'model': data.get('model', 'anthropic/claude-sonnet-4-6'),
        'messages': raw_messages,
        'stream': True,
        'max_tokens': data.get('max_tokens', 8000),
        'thinking': {'type': 'enabled', 'budget_tokens': 5000},
        'system': system_prompt,
    }
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
