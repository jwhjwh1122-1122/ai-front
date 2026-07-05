from flask import Flask, request, Response, send_from_directory
from flask_cors import CORS
import requests, json, os

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
MCP_URL = 'https://ombrebrain-jwh.zeabur.app/mcp'

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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
