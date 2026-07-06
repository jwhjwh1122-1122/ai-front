from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
MCP_URL = 'https://ombrebrain-jwh.zeabur.app/mcp'
MEMORIES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'memories')
os.makedirs(MEMORIES_DIR, exist_ok=True)

@app.route('/')
def index():
    return send_from_directory('static', 'chat.html')

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

@app.route('/api/mcp', methods=['POST'])
def mcp():
    data = request.json
    sid = data.pop('_sid', None)
    h = {'Content-Type': 'application/json'}
    if sid:
        h['Mcp-Session-Id'] = sid
    r = requests.post(MCP_URL, json=data, headers=h, timeout=30)
    resp = app.response_class(r.content, mimetype='application/json')
    if 'Mcp-Session-Id' in r.headers:
        resp.headers['Mcp-Session-Id'] = r.headers['Mcp-Session-Id']
    return resp

# ── 时光墙 ──────────────────────────────────────────

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

# ────────────────────────────────────────────────────

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
