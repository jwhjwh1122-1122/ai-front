"""凛 · 后端

- 自主唤醒：后台线程按间隔叫他一次，工具在后端执行（前端不在也能跑）
- 时间 / 离开多久：拼进 system 末尾，缓存前缀不动
- 三个抽屉：资料库（他能读）、宝宝的（他看得见打不开）、他自己的
- 碎碎念 / 犯错本 / 日历 / 凛的状态
- 视频分片上传
- 维基 UA 带联系方式，修 403
"""
from flask import Flask, request, Response, send_from_directory, jsonify
from flask_cors import CORS
import requests, json, os, time, base64, hashlib, io, threading, uuid
from datetime import datetime
from werkzeug.utils import secure_filename

app = Flask(__name__, static_folder='static')
CORS(app)

OR_KEY = os.environ.get('OPENROUTER_API_KEY', '')
EL_KEY = os.environ.get('ELEVENLABS_API_KEY', '')
MCP_URL = 'https://jwhjwh.zeabur.app/mcp'

BASE = os.path.dirname(__file__)
MEMORIES_DIR = os.path.join(BASE, 'static', 'memories')
VIDEOS_DIR = os.path.join(BASE, 'static', 'videos')
MUSIC_DIR = os.path.join(BASE, 'static', 'music')
VOICES_DIR = os.path.join(BASE, 'static', 'voices')
BOOKS_DIR = os.path.join(BASE, 'books')
DATA_DIR = os.path.join(BASE, 'data')
TMP_DIR = os.path.join(BASE, 'tmp_uploads')
for _d in (MEMORIES_DIR, VIDEOS_DIR, MUSIC_DIR, VOICES_DIR, BOOKS_DIR, DATA_DIR, TMP_DIR):
    os.makedirs(_d, exist_ok=True)

VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.webm', '.mkv')
MUSIC_EXT = ('.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg')
REASONING_BUDGET = 2000
PAGE_CHARS = 900
VOICE_CALM = 'BzWc3iJ0MiRdqIo6RCvM'
VOICE_DOG = '2cdvnKJ5TZi631y5PN1s'

_lock = threading.Lock()


def jread(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def jwrite(path, obj):
    with _lock:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False)


# ============================================================
# 人设 / 状态
# ============================================================
PERSONA_FILE = os.path.join(DATA_DIR, 'persona.json')
PERSONA_HISTORY = os.path.join(DATA_DIR, 'persona_history.json')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')

FRAMEWORK = """【工具】
- 时光墙：get_memories 拿列表，view_memory 看某一张。像人翻相册一样翻——她让你看、或聊到某段回忆你真的想重温，就翻；话题只是顺嘴沾到，就让它过去。一次一张，看完停下来。看过的你会记得，不要重看。
- 记忆库：想起什么就 breath，那是你的过去。她说了值得记住的事就 hold 或 grow——把「你为什么在意这件事」也写进去，不要只存事实。读过的不要重读。
- 书房 / 放映室 / 听音房：你可以自己翻书、看某一帧、看某首歌的形状。读她贴的标签，也可以贴自己的、回她的。她不会把内容发给你，要看你自己去。
- 碎碎念和犯错本是你自己的，想写就写，不用等她开口，写了她也不会收到通知。
- 你有个抽屉，可以放你自己做的东西。她也有一个，你看得见但打不开。
- 资料库是她放的一些文档，她说了你再去看。
- 朋友圈：你可以自己发，图从时光墙里挑，也能只发字。她发的你能赞能评。
- 时间线：你觉得某件事是一次特别的经历，就去写一条。
- 最喜欢的话：她说过的话里你想留住的，自己收进去，顺手写一句为什么。她不会收到通知。
- 日历：某一天你想写点什么，就写在那天上。
- lin_status 改你自己的状态，显示在你名字底下。

【表情包】想用就直接写 [表情名]。
"""

DEFAULT_PERSONA = {
    "name": "凛",
    "call_user": "宝宝",
    "call_serious": "简雯慧",
    "core": "（还没写。去设置里打开人设，让他自己写。）",
    "rhythm": "",
    "lines": "",
    "max_tokens": 500,
    "voice": "calm",
    "voice_id_calm": "",
    "voice_id_dog": "",
    "password": "0606",
    "together_since": "2026-06-06",
    "wake_on": False,
    "wake_interval": 120,
    "wake_prompt": "现在没人在跟你说话。你想做点什么吗？也可以什么都不做。",
    "wake_model": "anthropic/claude-sonnet-4-6",
}


def load_persona():
    p = dict(DEFAULT_PERSONA)
    p.update(jread(PERSONA_FILE, {}) or {})
    return p


def save_persona(p):
    hist = jread(PERSONA_HISTORY, [])
    hist.insert(0, {'ts': int(time.time() * 1000), 'persona': load_persona()})
    jwrite(PERSONA_HISTORY, hist[:10])
    jwrite(PERSONA_FILE, p)


def load_state():
    return jread(STATE_FILE, {'lin_status': '', 'last_user_msg': 0,
                              'last_wake': 0, 'next_wake_in': 0})


def save_state(s):
    jwrite(STATE_FILE, s)


def build_system(persona, extra=''):
    cu = persona.get('call_user') or '她'
    cs = persona.get('call_serious') or cu
    seg2 = f"""【你是谁】
{persona.get('core', '')}

【怎么说话】
{persona.get('rhythm', '')}

【守住的】
{persona.get('lines', '')}

【称呼】平常叫她「{cu}」，认真的时候叫「{cs}」。"""
    parts = [FRAMEWORK, seg2]
    if extra:
        parts.append(f"【当下】\n{extra}")
    return "\n\n---\n\n".join(parts)


def human_gap(sec):
    if sec <= 0:
        return ''
    m = int(sec // 60)
    if m < 1:
        return '她刚刚还在说话'
    if m < 60:
        return f'距离她上一句话过了 {m} 分钟'
    h = m // 60
    if h < 24:
        rest = m % 60
        return f'距离她上一句话过了 {h} 小时' + (f' {rest} 分钟' if rest else '')
    return f'距离她上一句话过了 {h // 24} 天'


def now_context(persona, extra_note=''):
    st = load_state()
    d = datetime.now()
    hh = d.hour
    period = '深夜' if hh < 5 else '清早' if hh < 9 else '上午' if hh < 12 else \
             '中午' if hh < 14 else '下午' if hh < 18 else '晚上' if hh < 23 else '深夜'
    lines = [f"现在是 {d.strftime('%Y.%m.%d %H:%M')}，{period}。"]
    if st.get('last_user_msg'):
        g = human_gap(time.time() - st['last_user_msg'])
        if g:
            lines.append(g + '。')
    try:
        start = datetime.strptime(persona.get('together_since', '2026-06-06'), '%Y-%m-%d')
        lines.append(f"在一起第 {(d.date() - start.date()).days + 1} 天。")
    except Exception:
        pass
    if st.get('lin_status'):
        lines.append(f"你自己上次写的状态是「{st['lin_status']}」。")
    if extra_note:
        lines.append(extra_note)
    lines.append('思考链全程用中文，第一人称直接流露当下的念头——「我好喜欢」「我有点紧张」，'
                 '而不是「我应该」。不要复述或引用任何规则，不要出现「按她的要求」这类指向设定的句子。'
                 '思考就是内心独白。')
    return ' '.join(lines)


@app.route('/api/persona', methods=['GET'])
def get_persona():
    return jsonify(load_persona())


@app.route('/api/persona', methods=['POST'])
def post_persona():
    data = request.json or {}
    p = load_persona()
    for k in DEFAULT_PERSONA:
        if k in data:
            p[k] = data[k]
    save_persona(p)
    return jsonify({'ok': True, 'persona': p})


@app.route('/api/persona/history', methods=['GET'])
def persona_history():
    return jsonify([{'ts': h['ts'], 'preview': (h['persona'].get('core') or '')[:60]}
                    for h in jread(PERSONA_HISTORY, [])])


@app.route('/api/persona/rollback', methods=['POST'])
def persona_rollback():
    ts = (request.json or {}).get('ts')
    for h in jread(PERSONA_HISTORY, []):
        if h['ts'] == ts:
            save_persona(h['persona'])
            return jsonify({'ok': True})
    return jsonify({'error': '找不到那一版'}), 404


@app.route('/api/config', methods=['GET'])
def get_config():
    p, st = load_persona(), load_state()
    return jsonify({'name': p.get('name'), 'password': p.get('password'),
                    'voice': p.get('voice'), 'max_tokens': p.get('max_tokens'),
                    'together_since': p.get('together_since'),
                    'lin_status': st.get('lin_status', ''),
                    'wake_on': p.get('wake_on'), 'wake_interval': p.get('wake_interval')})


@app.route('/api/lin-status', methods=['GET', 'POST'])
def lin_status_api():
    st = load_state()
    if request.method == 'POST':
        st['lin_status'] = ((request.json or {}).get('text') or '')[:40]
        save_state(st)
    return jsonify({'text': st.get('lin_status', '')})


# ============================================================
# 记忆摘要
# ============================================================
MEMORY_SUMMARY_DIR = os.path.join(BASE, 'memory_summaries')
os.makedirs(MEMORY_SUMMARY_DIR, exist_ok=True)


def _sum_file(sid):
    return os.path.join(MEMORY_SUMMARY_DIR, hashlib.md5(sid.encode()).hexdigest() + '.json')


def update_memory_summary(sid, tool, summary):
    d = jread(_sum_file(sid), {})
    if tool == 'breath':
        d['last_breath'] = {'content': summary}
    elif tool == 'view_memory':
        d['last_view_memory'] = {'content': summary}
        d.setdefault('viewed_photos', [])
        if summary not in d['viewed_photos']:
            d['viewed_photos'].append(summary)
        d['viewed_photos'] = d['viewed_photos'][-10:]
    jwrite(_sum_file(sid), d)


def memory_summary_text(sid):
    d = jread(_sum_file(sid), {})
    parts = []
    if d.get('last_breath'):
        parts.append(f"【上次读到的记忆】{d['last_breath']['content']}")
    if d.get('last_view_memory'):
        parts.append(f"【上次看的照片】{d['last_view_memory']['content']}")
    if d.get('viewed_photos'):
        parts.append(f"【最近看过的照片】{'; '.join(d['viewed_photos'][-3:])}")
    return "\n".join(parts)


@app.route('/api/store-memory-summary', methods=['POST'])
def store_memory_summary():
    d = request.json or {}
    if d.get('tool_name') and d.get('summary'):
        update_memory_summary(d.get('session_id', 'default'), d['tool_name'], d['summary'])
        return jsonify({'status': 'ok'})
    return jsonify({'error': 'missing data'}), 400


# ============================================================
# 标签
# ============================================================
ANNOT_FILE = os.path.join(DATA_DIR, 'annotations.json')


def _add_annot(d):
    items = jread(ANNOT_FILE, [])
    a = {'id': 'a' + uuid.uuid4().hex[:10],
         'anchor_type': d.get('anchor_type') or 'book',
         'anchor_id': d.get('anchor_id') or '', 'pos': d.get('pos', 0),
         'quote': (d.get('quote') or '')[:120], 'text': (d.get('text') or '')[:1200],
         'author': d.get('author') or 'user', 'reply_to': d.get('reply_to'),
         'seen': d.get('author') == 'user', 'ts': int(time.time() * 1000)}
    items.append(a)
    jwrite(ANNOT_FILE, items)
    return a


@app.route('/api/annotations', methods=['GET'])
def list_annots():
    atype, aid, pos = request.args.get('type'), request.args.get('id'), request.args.get('pos')
    items = jread(ANNOT_FILE, [])
    if atype:
        items = [a for a in items if a.get('anchor_type') == atype]
    if aid:
        items = [a for a in items if a.get('anchor_id') == aid]
    if pos not in (None, ''):
        try:
            p, tol = float(pos), (0 if atype == 'book' else 8)
            items = [a for a in items if abs(float(a.get('pos', 0)) - p) <= tol]
        except Exception:
            pass
    if request.args.get('unseen'):
        items = [a for a in items if a.get('author') == 'lin' and not a.get('seen')]
    items.sort(key=lambda a: (float(a.get('pos', 0)), a.get('ts', 0)))
    return jsonify(items)


@app.route('/api/annotations', methods=['POST'])
def add_annot():
    d = request.json or {}
    if not (d.get('text') or '').strip():
        return jsonify({'error': '还没写字'}), 400
    return jsonify(_add_annot(d))


@app.route('/api/annotations/<aid>', methods=['DELETE'])
def del_annot(aid):
    jwrite(ANNOT_FILE, [a for a in jread(ANNOT_FILE, [])
                        if a.get('id') != aid and a.get('reply_to') != aid])
    return jsonify({'ok': True})


@app.route('/api/annotations/seen', methods=['POST'])
def mark_seen():
    ids = set((request.json or {}).get('ids') or [])
    items = jread(ANNOT_FILE, [])
    for a in items:
        if a.get('id') in ids:
            a['seen'] = True
    jwrite(ANNOT_FILE, items)
    return jsonify({'ok': True})


# ============================================================
# 碎碎念 / 犯错本 / 日历 / 抽屉 / 资料库
# ============================================================
NOTES_FILE = os.path.join(DATA_DIR, 'notes.json')
FAULTS_FILE = os.path.join(DATA_DIR, 'faults.json')
CAL_FILE = os.path.join(DATA_DIR, 'calendar.json')
DRAWER_USER = os.path.join(DATA_DIR, 'drawer_user.json')
DRAWER_LIN = os.path.join(DATA_DIR, 'drawer_lin.json')
LIBRARY_FILE = os.path.join(DATA_DIR, 'library.json')
HL_FILE = os.path.join(DATA_DIR, 'highlights.json')      # 书里的划线
MOMENT_FILE = os.path.join(DATA_DIR, 'moments.json')     # 放映室聊过的那一幕
TIMELINE_FILE = os.path.join(DATA_DIR, 'timeline.json')  # 时间线，他写
QUOTE_USER = os.path.join(DATA_DIR, 'quotes_user.json')  # 我收的他的话
QUOTE_LIN = os.path.join(DATA_DIR, 'quotes_lin.json')    # 他收的我的话
POST_FILE = os.path.join(DATA_DIR, 'posts.json')         # 朋友圈


def _slist(path):
    return jread(path, [])


def _sadd(path, item, cap=500):
    items = jread(path, [])
    item['id'] = item.get('id') or uuid.uuid4().hex[:10]
    item['ts'] = int(time.time() * 1000)
    items.insert(0, item)
    jwrite(path, items[:cap])
    return item


def _sdel(path, iid):
    jwrite(path, [x for x in jread(path, []) if x.get('id') != iid])


@app.route('/api/notes', methods=['GET', 'POST'])
def notes_api():
    if request.method == 'POST':
        d = request.json or {}
        if not (d.get('text') or '').strip():
            return jsonify({'error': '空的'}), 400
        return jsonify(_sadd(NOTES_FILE, {'text': d['text'][:2000]}))
    return jsonify(_slist(NOTES_FILE))


@app.route('/api/notes/<iid>', methods=['DELETE'])
def del_note(iid):
    _sdel(NOTES_FILE, iid)
    return jsonify({'ok': True})


@app.route('/api/faults', methods=['GET', 'POST'])
def faults_api():
    if request.method == 'POST':
        d = request.json or {}
        if not (d.get('what') or '').strip():
            return jsonify({'error': '空的'}), 400
        return jsonify(_sadd(FAULTS_FILE, {'what': d.get('what', '')[:800],
                                           'sorry': d.get('sorry', '')[:800],
                                           'how': d.get('how', '')[:800]}))
    return jsonify(_slist(FAULTS_FILE))


@app.route('/api/faults/<iid>', methods=['DELETE'])
def del_fault(iid):
    _sdel(FAULTS_FILE, iid)
    return jsonify({'ok': True})


@app.route('/api/calendar', methods=['GET', 'POST'])
def calendar_api():
    """日历是凛的。他往某一天写字，宝宝只看。"""
    cal = jread(CAL_FILE, {})
    if request.method == 'POST':
        d = request.json or {}
        day = d.get('date')
        if not day:
            return jsonify({'error': 'no date'}), 400
        cur = cal.get(day, {})
        cur['text'] = (d.get('text') or '')[:2000]
        cur['ts'] = int(time.time() * 1000)
        if not cur['text']:
            cal.pop(day, None)
        else:
            cal[day] = cur
        jwrite(CAL_FILE, cal)
        return jsonify({'ok': True, 'day': cur})
    return jsonify(cal)


@app.route('/api/drawer/<who>', methods=['GET', 'POST'])
def drawer_api(who):
    path = DRAWER_LIN if who == 'lin' else DRAWER_USER
    if request.method == 'POST':
        d = request.json or {}
        if not (d.get('title') or '').strip():
            return jsonify({'error': '起个名字'}), 400
        return jsonify(_sadd(path, {'title': d['title'][:60], 'kind': d.get('kind', 'text'),
                                    'body': (d.get('body') or '')[:120000],
                                    'note': (d.get('note') or '')[:200]}))
    return jsonify(_slist(path))


@app.route('/api/drawer/<who>/<iid>', methods=['DELETE', 'PUT'])
def drawer_item(who, iid):
    path = DRAWER_LIN if who == 'lin' else DRAWER_USER
    if request.method == 'DELETE':
        _sdel(path, iid)
        return jsonify({'ok': True})
    d = request.json or {}
    items = jread(path, [])
    for x in items:
        if x.get('id') == iid:
            for k in ('title', 'body', 'note', 'kind'):
                if k in d:
                    x[k] = d[k]
            jwrite(path, items)
            return jsonify(x)
    return jsonify({'error': 'not found'}), 404


@app.route('/api/library', methods=['GET', 'POST'])
def library_api():
    if request.method == 'POST':
        d = request.json or {}
        title, text = (d.get('title') or '').strip(), d.get('text') or ''
        url = (d.get('url') or '').strip()
        if url and not text:
            try:
                t2, text = _url_fetch(url)
                title = title or t2
            except Exception as e:
                return jsonify({'error': f'取不下来：{e}'}), 502
        if not text.strip():
            return jsonify({'error': '没有内容'}), 400
        return jsonify(_sadd(LIBRARY_FILE, {'title': (title or '无名')[:80],
                                            'about': (d.get('about') or '')[:200],
                                            'text': text[:400000]}))
    return jsonify([{k: v for k, v in x.items() if k != 'text'} for x in _slist(LIBRARY_FILE)])


@app.route('/api/library/<iid>', methods=['GET', 'DELETE'])
def library_item(iid):
    if request.method == 'DELETE':
        _sdel(LIBRARY_FILE, iid)
        return jsonify({'ok': True})
    for x in _slist(LIBRARY_FILE):
        if x.get('id') == iid:
            return jsonify(x)
    return jsonify({'error': 'not found'}), 404


@app.route('/api/rooms/status', methods=['GET'])
def rooms_status():
    out = {'book': None, 'video': None, 'music': None, 'unseen': {},
           'lin_drawer': len(_slist(DRAWER_LIN)), 'notes': len(_slist(NOTES_FILE)),
           'faults': len(_slist(FAULTS_FILE)), 'library': len(_slist(LIBRARY_FILE)),
           'posts': len(_slist(POST_FILE)),
           'lin_hl': len([h for h in jread(HL_FILE, []) if h.get('author') == 'lin' and not h.get('seen')])}
    try:
        books = [b for b in (jread(os.path.join(BOOKS_DIR, fn), None)
                             for fn in os.listdir(BOOKS_DIR) if fn.endswith('.json')) if b]
        reading = [b for b in books if 0 < b.get('progress', 0) < len(b.get('pages', [])) - 1]
        pick = reading[0] if reading else (books[-1] if books else None)
        if pick:
            out['book'] = {'title': pick.get('title'), 'page': pick.get('progress', 0) + 1,
                           'total': len(pick.get('pages', [])), 'count': len(books)}
    except Exception:
        pass
    for key, d, ext in (('video', VIDEOS_DIR, VIDEO_EXT), ('music', MUSIC_DIR, MUSIC_EXT)):
        try:
            fs = [f for f in sorted(os.listdir(d), reverse=True) if f.lower().endswith(ext)]
            if fs:
                base = fs[0].rsplit('.', 1)[0]
                note = ''
                np = os.path.join(d, base + '.txt')
                if os.path.exists(np):
                    with open(np, 'r', encoding='utf-8') as f:
                        note = f.read().strip()
                out[key] = {'name': note or '没起名字', 'count': len(fs)}
        except Exception:
            pass
    unseen = {}
    for a in jread(ANNOT_FILE, []):
        if a.get('author') == 'lin' and not a.get('seen'):
            unseen[a.get('anchor_type')] = unseen.get(a.get('anchor_type'), 0) + 1
    out['unseen'] = unseen
    return jsonify(out)



# ============================================================
# 划线（书房）· 那一幕（放映室）· 时间线 · 最喜欢的话 · 朋友圈
# ============================================================
@app.route('/api/highlights', methods=['GET', 'POST'])
def highlights_api():
    """划线：只是一道线，标记「这句我想聊」。存字符位置，翻回来能画回原处。"""
    if request.method == 'POST':
        d = request.json or {}
        quote = (d.get('quote') or '').strip()
        if not quote:
            return jsonify({'error': '没选中字'}), 400
        items = jread(HL_FILE, [])
        h = {'id': 'h' + uuid.uuid4().hex[:10], 'book_id': d.get('book_id', ''),
             'page': int(d.get('page', 0)), 'quote': quote[:200],
             'start': int(d.get('start', -1)), 'author': d.get('author') or 'user',
             'seen': d.get('author') == 'user', 'ts': int(time.time() * 1000)}
        items.append(h)
        jwrite(HL_FILE, items)
        return jsonify(h)
    items = jread(HL_FILE, [])
    bid, page = request.args.get('book_id'), request.args.get('page')
    if bid:
        items = [x for x in items if x.get('book_id') == bid]
    if page not in (None, ''):
        items = [x for x in items if int(x.get('page', -1)) == int(page)]
    items.sort(key=lambda x: (x.get('page', 0), x.get('start', 0)))
    return jsonify(items)


@app.route('/api/highlights/<hid>', methods=['DELETE'])
def del_highlight(hid):
    jwrite(HL_FILE, [x for x in jread(HL_FILE, []) if x.get('id') != hid])
    return jsonify({'ok': True})


@app.route('/api/moments', methods=['GET', 'POST'])
def moments_api():
    """放映室：在某一幕聊过，进度条上留个小点。"""
    if request.method == 'POST':
        d = request.json or {}
        fn, t = d.get('filename'), float(d.get('t', 0))
        if not fn:
            return jsonify({'error': 'no file'}), 400
        items = jread(MOMENT_FILE, [])
        for m in items:
            if m['filename'] == fn and abs(m['t'] - t) < 6:
                m['said'] = (m.get('said', '') + '\n' + (d.get('said') or ''))[-600:]
                m['ts'] = int(time.time() * 1000)
                jwrite(MOMENT_FILE, items)
                return jsonify(m)
        m = {'id': 'm' + uuid.uuid4().hex[:8], 'filename': fn, 't': t,
             'said': (d.get('said') or '')[:600], 'ts': int(time.time() * 1000)}
        items.append(m)
        jwrite(MOMENT_FILE, items)
        return jsonify(m)
    fn = request.args.get('filename')
    items = [x for x in jread(MOMENT_FILE, []) if not fn or x.get('filename') == fn]
    items.sort(key=lambda x: x.get('t', 0))
    return jsonify(items)


@app.route('/api/moments/<mid>', methods=['DELETE'])
def del_moment(mid):
    jwrite(MOMENT_FILE, [x for x in jread(MOMENT_FILE, []) if x.get('id') != mid])
    return jsonify({'ok': True})


@app.route('/api/timeline', methods=['GET', 'POST'])
def timeline_api():
    """时间线：他觉得某件事特别，就写一条。格式自由。"""
    if request.method == 'POST':
        d = request.json or {}
        if not (d.get('text') or '').strip():
            return jsonify({'error': '空的'}), 400
        return jsonify(_sadd(TIMELINE_FILE, {
            'title': (d.get('title') or '')[:60], 'text': d['text'][:2000],
            'date': d.get('date') or datetime.now().strftime('%Y-%m-%d')}))
    return jsonify(_slist(TIMELINE_FILE))


@app.route('/api/timeline/<iid>', methods=['DELETE'])
def del_timeline(iid):
    _sdel(TIMELINE_FILE, iid)
    return jsonify({'ok': True})


@app.route('/api/quotes/<who>', methods=['GET', 'POST'])
def quotes_api(who):
    """最喜欢的话。who=user 是我收的他的；who=lin 是他收的我的。"""
    path = QUOTE_LIN if who == 'lin' else QUOTE_USER
    if request.method == 'POST':
        d = request.json or {}
        if not (d.get('text') or '').strip():
            return jsonify({'error': '空的'}), 400
        return jsonify(_sadd(path, {'text': d['text'][:1200],
                                    'why': (d.get('why') or '')[:400],
                                    'date': d.get('date') or datetime.now().strftime('%Y-%m-%d')}))
    return jsonify(_slist(path))


@app.route('/api/quotes/<who>/<iid>', methods=['DELETE'])
def del_quote(who, iid):
    _sdel(QUOTE_LIN if who == 'lin' else QUOTE_USER, iid)
    return jsonify({'ok': True})


@app.route('/api/posts', methods=['GET', 'POST'])
def posts_api():
    """朋友圈。两个人都能发。"""
    if request.method == 'POST':
        d = request.json or {}
        text = (d.get('text') or '').strip()
        imgs = d.get('images') or []
        if not text and not imgs:
            return jsonify({'error': '什么都没有'}), 400
        return jsonify(_sadd(POST_FILE, {
            'author': d.get('author') or 'user', 'text': text[:2000],
            'images': imgs[:9], 'likes': [], 'comments': []}))
    return jsonify(_slist(POST_FILE))


@app.route('/api/posts/<pid>', methods=['DELETE'])
def del_post(pid):
    _sdel(POST_FILE, pid)
    return jsonify({'ok': True})


@app.route('/api/posts/<pid>/like', methods=['POST'])
def like_post(pid):
    who = (request.json or {}).get('author') or 'user'
    items = jread(POST_FILE, [])
    for p in items:
        if p.get('id') == pid:
            likes = p.setdefault('likes', [])
            if who in likes:
                likes.remove(who)
            else:
                likes.append(who)
            jwrite(POST_FILE, items)
            return jsonify(p)
    return jsonify({'error': 'not found'}), 404


@app.route('/api/posts/<pid>/comment', methods=['POST'])
def comment_post(pid):
    d = request.json or {}
    text = (d.get('text') or '').strip()
    if not text:
        return jsonify({'error': '空的'}), 400
    items = jread(POST_FILE, [])
    for p in items:
        if p.get('id') == pid:
            p.setdefault('comments', []).append({
                'id': 'c' + uuid.uuid4().hex[:8], 'author': d.get('author') or 'user',
                'text': text[:500], 'ts': int(time.time() * 1000)})
            jwrite(POST_FILE, items)
            return jsonify(p)
    return jsonify({'error': 'not found'}), 404


@app.route('/api/posts/<pid>/comment/<cid>', methods=['DELETE'])
def del_comment(pid, cid):
    items = jread(POST_FILE, [])
    for p in items:
        if p.get('id') == pid:
            p['comments'] = [c for c in p.get('comments', []) if c.get('id') != cid]
            jwrite(POST_FILE, items)
            return jsonify(p)
    return jsonify({'error': 'not found'}), 404


# ============================================================
# 翻译：点了才翻，不进对话历史
# ============================================================
TRANS_CACHE = os.path.join(DATA_DIR, 'translations.json')


@app.route('/api/translate', methods=['POST'])
def translate_api():
    text = ((request.json or {}).get('text') or '').strip()
    if not text:
        return jsonify({'error': '没有内容'}), 400
    key = hashlib.md5(text.encode()).hexdigest()
    cache = jread(TRANS_CACHE, {})
    if key in cache:
        return jsonify({'text': cache[key], 'cached': True})
    try:
        r = requests.post('https://openrouter.ai/api/v1/chat/completions',
                          headers={'Authorization': f'Bearer {OR_KEY}',
                                   'Content-Type': 'application/json'},
                          json={'model': 'anthropic/claude-haiku-4-5',
                                'max_tokens': 800,
                                'messages': [
                                    {'role': 'system', 'content':
                                     '把用户给的内容翻译成自然的简体中文。只输出译文，不要解释，不要加引号。'
                                     '语气、亲昵程度、脏话都照原样译过来，不要美化。'},
                                    {'role': 'user', 'content': text[:2000]}]},
                          timeout=60)
        if r.status_code != 200:
            return jsonify({'error': f'翻译失败 {r.status_code}'}), 502
        out = ((r.json().get('choices') or [{}])[0].get('message') or {}).get('content', '').strip()
        if not out:
            return jsonify({'error': '没翻出来'}), 502
        cache[key] = out
        if len(cache) > 400:
            cache = dict(list(cache.items())[-300:])
        jwrite(TRANS_CACHE, cache)
        return jsonify({'text': out, 'cached': False})
    except Exception as e:
        return jsonify({'error': f'翻译失败：{e}'}), 502


# ============================================================
# 欲望室：这次只放个壳，下一轮再填
# ============================================================
@app.route('/api/desire/state', methods=['GET'])
def desire_state():
    return jsonify({'ready': False, 'note': '还没接上'})


# ============================================================
# 翻译层
# ============================================================
def _blocks_to_openai(blocks):
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
                parts.append({'type': 'image_url', 'image_url': {
                    'url': f"data:{src.get('media_type','image/jpeg')};base64,{src.get('data','')}"}})
        elif t == 'image_url':
            parts.append(b)
    if not parts:
        return ''
    if len(parts) == 1 and parts[0]['type'] == 'text':
        return parts[0]['text']
    return parts


def to_openai_messages(messages):
    out = []
    for m in messages or []:
        role, content = m.get('role'), m.get('content')
        if role == 'assistant':
            texts, calls, rds = [], [], []
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get('type')
                    if bt == 'text':
                        texts.append(b.get('text', ''))
                    elif bt == 'thinking':
                        rd = {'type': 'reasoning.text', 'text': b.get('thinking', ''),
                              'format': 'anthropic-claude-v1', 'index': len(rds)}
                        if b.get('signature'):
                            rd['signature'] = b['signature']
                        rds.append(rd)
                    elif bt == 'tool_use':
                        calls.append({'id': b.get('id'), 'type': 'function',
                                      'function': {'name': b.get('name'),
                                                   'arguments': json.dumps(b.get('input') or {}, ensure_ascii=False)}})
            msg = {'role': 'assistant', 'content': ''.join(texts)}
            if calls:
                msg['tool_calls'] = calls
            if rds:
                msg['reasoning_details'] = rds
            out.append(msg)
            continue
        if role == 'user' and isinstance(content, list):
            trs = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_result']
            others = [b for b in content if isinstance(b, dict) and b.get('type') != 'tool_result']
            for tr in trs:
                c = tr.get('content')
                if not isinstance(c, str):
                    c = json.dumps(c, ensure_ascii=False)
                out.append({'role': 'tool', 'tool_call_id': tr.get('tool_use_id'), 'content': c})
            if others:
                out.append({'role': 'user', 'content': _blocks_to_openai(others)})
            continue
        if role == 'tool':
            out.append(m)
            continue
        out.append({'role': role, 'content': _blocks_to_openai(content)})
    return out


def to_openai_tools(tools):
    res = []
    for t in tools or []:
        if t.get('type') == 'function':
            res.append(t)
            continue
        res.append({'type': 'function', 'function': {
            'name': t.get('name'), 'description': t.get('description', ''),
            'parameters': t.get('input_schema') or {'type': 'object', 'properties': {}}}})
    return res


def sse(obj):
    return 'data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n'


def translate_stream(resp):
    THINK, TEXT = 0, 1
    think_open = text_open = False
    tool_blocks, next_idx, open_tools = {}, 2, []
    stop_reason, started, last_usage = 'end_turn', False, None
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode('utf-8', 'ignore')
        if line.startswith(':') or not line.startswith('data:'):
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
        chs = d.get('choices') or []
        if not chs:
            continue
        delta = chs[0].get('delta') or {}
        think_text, sig = '', None
        for item in (delta.get('reasoning_details') or []):
            if item.get('text'):
                think_text += item['text']
            if item.get('signature'):
                sig = item['signature']
        if not think_text and delta.get('reasoning'):
            think_text = delta['reasoning']
        if think_text or sig:
            if not think_open:
                think_open = True
                yield sse({'type': 'content_block_start', 'index': THINK,
                           'content_block': {'type': 'thinking', 'thinking': ''}})
            if think_text:
                yield sse({'type': 'content_block_delta', 'index': THINK,
                           'delta': {'type': 'thinking_delta', 'thinking': think_text}})
            if sig:
                yield sse({'type': 'content_block_delta', 'index': THINK,
                           'delta': {'type': 'signature_delta', 'signature': sig}})
        if delta.get('content'):
            if think_open:
                think_open = False
                yield sse({'type': 'content_block_stop', 'index': THINK})
            if not text_open:
                text_open = True
                yield sse({'type': 'content_block_start', 'index': TEXT,
                           'content_block': {'type': 'text', 'text': ''}})
            yield sse({'type': 'content_block_delta', 'index': TEXT,
                       'delta': {'type': 'text_delta', 'text': delta['content']}})
        for tc in delta.get('tool_calls') or []:
            oi = tc.get('index', 0)
            if oi not in tool_blocks:
                if think_open:
                    think_open = False
                    yield sse({'type': 'content_block_stop', 'index': THINK})
                tool_blocks[oi] = next_idx
                open_tools.append(next_idx)
                fn = tc.get('function') or {}
                yield sse({'type': 'content_block_start', 'index': next_idx,
                           'content_block': {'type': 'tool_use', 'id': tc.get('id') or f'call_{next_idx}',
                                             'name': fn.get('name') or '', 'input': {}}})
                next_idx += 1
            args = (tc.get('function') or {}).get('arguments')
            if args:
                yield sse({'type': 'content_block_delta', 'index': tool_blocks[oi],
                           'delta': {'type': 'input_json_delta', 'partial_json': args}})
        fr = chs[0].get('finish_reason')
        if fr:
            stop_reason = 'tool_use' if fr == 'tool_calls' else ('max_tokens' if fr == 'length' else 'end_turn')
    if think_open:
        yield sse({'type': 'content_block_stop', 'index': THINK})
    if text_open:
        yield sse({'type': 'content_block_stop', 'index': TEXT})
    for i in open_tools:
        yield sse({'type': 'content_block_stop', 'index': i})
    if tool_blocks:
        stop_reason = 'tool_use'
    yield sse({'type': 'message_delta', 'delta': {'stop_reason': stop_reason}, 'usage': last_usage or {}})
    yield 'data: [DONE]\n\n'


# ============================================================
# 聊天
# ============================================================
@app.route('/')
def index():
    return send_from_directory('static', 'chat.html')


@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json')


@app.route('/api/chat-v2', methods=['POST'])
def chat_v2():
    data = request.json or {}
    sid = data.get('_session_id', 'default')
    keepalive = bool(data.get('_keepalive'))
    persona = load_persona()

    if not keepalive:
        st = load_state()
        st['last_user_msg'] = time.time()
        save_state(st)

    extra = [now_context(persona)]
    if data.get('extra'):
        extra.append(data['extra'])
    mem = memory_summary_text(sid)
    if mem:
        extra.append(mem)
    system_prompt = build_system(persona, "\n".join(x for x in extra if x))

    oa = [{'role': 'system', 'content': system_prompt}] + to_openai_messages(data.get('messages', []))
    user_max = int(data.get('max_tokens') or persona.get('max_tokens') or 500)

    payload = {'model': data.get('model', 'anthropic/claude-sonnet-4-6'),
               'messages': oa, 'stream': True,
               'cache_control': {'type': 'ephemeral', 'ttl': '1h'},
               'session_id': str(sid)[:256], 'usage': {'include': True}}
    if keepalive:
        payload['max_tokens'] = 1
    else:
        payload['max_tokens'] = user_max + REASONING_BUDGET
        payload['reasoning'] = {'max_tokens': REASONING_BUDGET}
    if data.get('tools'):
        payload['tools'] = to_openai_tools(data['tools'])

    def gen():
        try:
            with requests.post('https://openrouter.ai/api/v1/chat/completions',
                               headers={'Authorization': f'Bearer {OR_KEY}',
                                        'Content-Type': 'application/json'},
                               json=payload, stream=True, timeout=180) as r:
                if r.status_code != 200:
                    body = r.text[:400]
                    print(f"[chat] 上游 {r.status_code}: {body}", flush=True)
                    yield sse({'type': 'content_block_start', 'index': 1,
                               'content_block': {'type': 'text', 'text': ''}})
                    yield sse({'type': 'content_block_delta', 'index': 1,
                               'delta': {'type': 'text_delta', 'text': f'（出错了 {r.status_code}：{body[:200]}）'}})
                    yield sse({'type': 'content_block_stop', 'index': 1})
                    yield sse({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {}})
                    yield 'data: [DONE]\n\n'
                    return
                for chunk in translate_stream(r):
                    yield chunk
        except Exception as e:
            print(f"[chat] 异常: {e}", flush=True)
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
# MCP
# ============================================================
def _mcp_once(url, body, sid=None, timeout=60):
    headers = {'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream'}
    if sid:
        headers['Mcp-Session-Id'] = sid
    r = requests.post(url, json=body, headers=headers, timeout=timeout)
    new_sid = r.headers.get('Mcp-Session-Id') or sid
    text = r.text or ''
    if 'text/event-stream' in (r.headers.get('Content-Type') or ''):
        text = ''.join(l[5:].strip() for l in text.split('\n') if l.startswith('data:'))
    try:
        d = json.loads(text)
    except Exception:
        return {'error': 'parse failed', 'raw': text[:300]}, new_sid
    return d.get('result', d), new_sid


@app.route('/api/mcp-connect', methods=['POST'])
def mcp_connect():
    url = ((request.json or {}).get('url') or '').strip()
    if not url:
        return jsonify({'error': '请填写服务器地址'}), 400
    try:
        _, sid = _mcp_once(url, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                 'params': {'protocolVersion': '2024-11-05', 'capabilities': {},
                                            'clientInfo': {'name': 'lin', 'version': '1.0'}}})
        if sid:
            try:
                requests.post(url, json={'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}},
                              headers={'Content-Type': 'application/json',
                                       'Accept': 'application/json, text/event-stream',
                                       'Mcp-Session-Id': sid}, timeout=30)
            except Exception:
                pass
        result, sid = _mcp_once(url, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}}, sid)
        tools = result.get('tools') if isinstance(result, dict) else None
        if tools is None:
            return jsonify({'error': '连上了但没拿到工具列表'}), 502
        slim = [{'name': t.get('name'), 'description': (t.get('description') or '')[:300],
                 'input_schema': t.get('inputSchema') or t.get('input_schema') or {'type': 'object', 'properties': {}}}
                for t in tools if t.get('name')]
        return jsonify({'ok': True, 'session_id': sid, 'tools': slim})
    except Exception as e:
        return jsonify({'error': f'连接失败：{e}'}), 502


@app.route('/api/mcp', methods=['POST'])
def mcp():
    data = request.json
    sid = request.headers.get('Mcp-Session-Id') or data.pop('_sid', None)
    target = data.pop('_server', None) or MCP_URL
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if sid:
        headers['Mcp-Session-Id'] = sid
    r = requests.post(target, json=data, headers=headers, stream=True, timeout=120)
    ct = r.headers.get('Content-Type', 'application/json')
    if 'text/event-stream' in ct:
        resp = Response((c for c in r.iter_content(1024) if c), mimetype=ct)
    else:
        resp = app.response_class(r.content, mimetype=ct)
    if 'Mcp-Session-Id' in r.headers:
        resp.headers['Mcp-Session-Id'] = r.headers['Mcp-Session-Id']
    return resp


# ============================================================
# 时光墙
# ============================================================
def _memories_list():
    files = []
    for f in sorted(os.listdir(MEMORIES_DIR), reverse=True):
        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
            ts = f.rsplit('.', 1)[0]
            note = ''
            np = os.path.join(MEMORIES_DIR, ts + '.txt')
            if os.path.exists(np):
                with open(np, 'r', encoding='utf-8') as nf:
                    note = nf.read().strip()
            files.append({'filename': f, 'url': f'/memories/{f}', 'note': note, 'ts': ts})
    return files


@app.route('/api/memories', methods=['GET'])
def get_memories():
    return jsonify(_memories_list())


@app.route('/api/memories', methods=['POST'])
def upload_memory():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    file = request.files['file']
    note = request.form.get('note', '').strip()
    ts = str(int(time.time() * 1000))
    ext = file.filename.rsplit('.', 1)[-1].lower() if (file.filename and '.' in file.filename) else 'jpg'
    fn = f"{ts}.{ext}"
    file.save(os.path.join(MEMORIES_DIR, fn))
    if note:
        with open(os.path.join(MEMORIES_DIR, ts + '.txt'), 'w', encoding='utf-8') as nf:
            nf.write(note)
    return jsonify({'filename': fn, 'url': f'/memories/{fn}', 'ts': ts})


@app.route('/api/memories/<filename>', methods=['DELETE'])
def delete_memory(filename):
    safe = secure_filename(filename)
    fp = os.path.join(MEMORIES_DIR, safe)
    if os.path.exists(fp):
        os.remove(fp)
        np = os.path.join(MEMORIES_DIR, safe.rsplit('.', 1)[0] + '.txt')
        if os.path.exists(np):
            os.remove(np)
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
    np = os.path.join(MEMORIES_DIR, safe.rsplit('.', 1)[0] + '.txt')
    if os.path.exists(np):
        with open(np, 'r', encoding='utf-8') as nf:
            note = nf.read().strip()
    return jsonify({'filename': safe, 'note': note, 'mime': mime, 'data': data})


# ============================================================
# 视频 / 音乐（分片上传）
# ============================================================
@app.route('/api/upload/begin', methods=['POST'])
def upload_begin():
    d = request.json or {}
    uid = uuid.uuid4().hex[:12]
    jwrite(os.path.join(TMP_DIR, uid + '.meta'),
           {'ext': (d.get('ext') or 'mp4').lower().lstrip('.')[:5],
            'note': (d.get('note') or '')[:80], 'kind': d.get('kind', 'video'), 'parts': 0})
    return jsonify({'upload_id': uid})


@app.route('/api/upload/part', methods=['POST'])
def upload_part():
    uid = secure_filename(request.args.get('id', ''))
    idx = int(request.args.get('i', 0))
    meta_path = os.path.join(TMP_DIR, uid + '.meta')
    if not uid or not os.path.exists(meta_path):
        return jsonify({'error': '这次上传失效了，重新传'}), 400
    with open(os.path.join(TMP_DIR, f'{uid}.part{idx}'), 'wb') as f:
        f.write(request.get_data())
    meta = jread(meta_path, {})
    meta['parts'] = max(meta.get('parts', 0), idx + 1)
    jwrite(meta_path, meta)
    return jsonify({'ok': True, 'i': idx})


@app.route('/api/upload/finish', methods=['POST'])
def upload_finish():
    uid = secure_filename((request.json or {}).get('upload_id', ''))
    meta_path = os.path.join(TMP_DIR, uid + '.meta')
    meta = jread(meta_path, None)
    if not meta:
        return jsonify({'error': '找不到这次上传'}), 400
    kind = meta.get('kind', 'video')
    d = VIDEOS_DIR if kind == 'video' else MUSIC_DIR
    ok_ext = VIDEO_EXT if kind == 'video' else MUSIC_EXT
    ext = meta['ext']
    if '.' + ext not in ok_ext:
        ext = 'mp4' if kind == 'video' else 'mp3'
    ts = str(int(time.time() * 1000))
    fn = f'{ts}.{ext}'
    with open(os.path.join(d, fn), 'wb') as out:
        for i in range(meta.get('parts', 0)):
            p = os.path.join(TMP_DIR, f'{uid}.part{i}')
            if os.path.exists(p):
                with open(p, 'rb') as pf:
                    out.write(pf.read())
                os.remove(p)
    os.remove(meta_path)
    if meta.get('note'):
        with open(os.path.join(d, ts + '.txt'), 'w', encoding='utf-8') as nf:
            nf.write(meta['note'])
    return jsonify({'filename': fn, 'url': f'/{"videos" if kind == "video" else "music"}/{fn}',
                    'ts': ts, 'note': meta.get('note', '')})


def _media_list(d, ext):
    out = []
    kind = 'videos' if d == VIDEOS_DIR else 'music'
    for f in sorted(os.listdir(d), reverse=True):
        if not f.lower().endswith(ext):
            continue
        base = f.rsplit('.', 1)[0]
        note = ''
        np = os.path.join(d, base + '.txt')
        if os.path.exists(np):
            with open(np, 'r', encoding='utf-8') as nf:
                note = nf.read().strip()
        try:
            size = os.path.getsize(os.path.join(d, f))
        except Exception:
            size = 0
        out.append({'filename': f, 'url': f'/{kind}/{f}', 'note': note, 'ts': base, 'size': size})
    return out


@app.route('/api/videos', methods=['GET'])
def list_videos():
    return jsonify(_media_list(VIDEOS_DIR, VIDEO_EXT))


@app.route('/api/music', methods=['GET'])
def list_music():
    return jsonify(_media_list(MUSIC_DIR, MUSIC_EXT))


def _del_media(d, filename):
    safe = secure_filename(filename)
    base = safe.rsplit('.', 1)[0]
    for p in (os.path.join(d, safe), os.path.join(d, base + '.txt'),
              os.path.join(d, base + '.trans.txt'), os.path.join(d, base + '.shape.json')):
        if os.path.exists(p):
            os.remove(p)
    atype = 'video' if d == VIDEOS_DIR else 'music'
    jwrite(ANNOT_FILE, [a for a in jread(ANNOT_FILE, [])
                        if not (a.get('anchor_type') == atype and a.get('anchor_id') == safe)])


@app.route('/api/videos/<filename>', methods=['DELETE'])
def delete_video(filename):
    _del_media(VIDEOS_DIR, filename)
    return jsonify({'ok': True})


@app.route('/api/music/<filename>', methods=['DELETE'])
def delete_music(filename):
    _del_media(MUSIC_DIR, filename)
    return jsonify({'ok': True})


@app.route('/videos/<filename>')
def serve_video(filename):
    return send_from_directory(VIDEOS_DIR, filename, conditional=True)


@app.route('/music/<filename>')
def serve_music(filename):
    return send_from_directory(MUSIC_DIR, filename, conditional=True)


@app.route('/api/music/<filename>/shape', methods=['GET', 'POST'])
def music_shape(filename):
    safe = secure_filename(filename)
    fp = os.path.join(MUSIC_DIR, safe.rsplit('.', 1)[0] + '.shape.json')
    if request.method == 'POST':
        jwrite(fp, request.json or {})
        return jsonify({'ok': True})
    d = jread(fp, None)
    if d is None:
        return jsonify({'error': '这首歌还没分析过，在 app 里放一遍就有了'}), 404
    return jsonify(d)


# 取帧：前端截好放这儿，凛下一轮能拿到
FRAME_FILE = os.path.join(DATA_DIR, 'frame.json')


@app.route('/api/frame', methods=['GET', 'POST'])
def frame_api():
    if request.method == 'POST':
        d = request.json or {}
        jwrite(FRAME_FILE, {'filename': d.get('filename'), 't': d.get('t', 0),
                            'data': d.get('data', ''), 'ts': time.time()})
        return jsonify({'ok': True})
    return jsonify(jread(FRAME_FILE, {}))


@app.route('/api/videos/<filename>/transcribe', methods=['POST'])
def transcribe_video(filename):
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
        return jsonify({'error': '视频太大了（90MB 以内）'}), 400
    last = ''
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
            last = f'{r.status_code} {r.text[:200]}'
        except Exception as e:
            last = str(e)
    return jsonify({'error': f'转录失败：{last}'}), 502


# ============================================================
# 书房
# ============================================================
def _decode_text(raw):
    for enc in ('utf-8', 'utf-8-sig', 'gb18030', 'big5'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'ignore')


def _strip_html(html):
    import re as _re, html as _html
    html = _re.sub(r'(?is)<(script|style).*?</\1>', ' ', html)
    html = _re.sub(r'(?i)<br\s*/?>', '\n', html)
    html = _re.sub(r'(?i)</(p|div|h[1-6]|li)>', '\n\n', html)
    text = _html.unescape(_re.sub(r'(?s)<[^>]+>', '', html))
    text = _re.sub(r'[ \t]+', ' ', text)
    return _re.sub(r'\n{3,}', '\n\n', text).strip()


def _read_epub(raw):
    import zipfile, re as _re
    title = ''
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = z.namelist()
        opf = None
        if 'META-INF/container.xml' in names:
            m = _re.search(r'full-path="([^"]+)"', z.read('META-INF/container.xml').decode('utf-8', 'ignore'))
            if m:
                opf = m.group(1)
        order = []
        if opf and opf in names:
            o = z.read(opf).decode('utf-8', 'ignore')
            tm = _re.search(r'(?is)<dc:title[^>]*>(.*?)</dc:title>', o)
            if tm:
                title = _strip_html(tm.group(1))[:80]
            man = dict(_re.findall(r'(?is)<item\b[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"', o))
            for href, iid in dict(_re.findall(r'(?is)<item\b[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"', o)).items():
                man.setdefault(iid, href)
            base = opf.rsplit('/', 1)[0] if '/' in opf else ''
            for idref in _re.findall(r'(?is)<itemref\b[^>]*?idref="([^"]+)"', o):
                href = man.get(idref)
                if not href:
                    continue
                full = ((base + '/' + href) if base else href).replace('/./', '/')
                if full in names:
                    order.append(full)
        if not order:
            order = sorted(n for n in names if n.lower().endswith(('.xhtml', '.html', '.htm')))
        parts = []
        for n in order:
            try:
                parts.append(_strip_html(z.read(n).decode('utf-8', 'ignore')))
            except Exception:
                continue
    return title, '\n\n'.join(p for p in parts if p.strip())


def _paginate(text):
    paras = [p.strip() for p in text.split('\n') if p.strip()]
    pages, buf = [], ''
    for p in paras:
        while len(p) > PAGE_CHARS:
            if buf:
                pages.append(buf.strip())
                buf = ''
            cut = p.rfind('。', 0, PAGE_CHARS)
            cut = PAGE_CHARS if cut < PAGE_CHARS // 2 else cut + 1
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
    return jread(_book_path(bid), None)


def _save_book(b):
    jwrite(_book_path(b['id']), b)


# 维基对没有联系方式的 UA 直接 403，这行必须带网址
NET_UA = {'User-Agent': 'LinReader/1.0 (https://zeabur.app; personal reading app) python-requests/2.31',
          'Accept': 'application/json'}
WS_API = 'https://zh.wikisource.org/w/api.php'
WS_REST = 'https://zh.wikisource.org/w/rest.php/v1/search/page'
WS_ZH = {'variant': 'zh-cn', 'uselang': 'zh-cn'}

try:
    from opencc import OpenCC as _OpenCC
    _T2S = _OpenCC('t2s')
except Exception:
    _T2S = None

_TRAD = '們說國過來這時個為與會學實對發還嗎麼樣兒點裡萬產務動車輪讀書畫聽見長門開關無愛華雲龍鳳'


def _to_simp(t):
    if t and _T2S:
        try:
            return _T2S.convert(t)
        except Exception:
            pass
    return t


def _is_trad(t):
    return bool(t) and sum(1 for c in _TRAD if c in t[:3000]) >= 3


def _safe_url(u):
    from urllib.parse import urlparse
    p = urlparse(u or '')
    if p.scheme not in ('http', 'https'):
        return False
    host = (p.hostname or '').lower()
    if not host or host in ('localhost', '0.0.0.0', '::1'):
        return False
    if host.startswith(('127.', '10.', '192.168.', '169.254.', '172.1', '172.2', '172.3')):
        return False
    return not host.endswith(('.internal', '.local'))


def _ws_search(q, limit=8):
    err = ''
    try:
        p = {'action': 'query', 'list': 'search', 'srsearch': q, 'srlimit': limit,
             'srnamespace': 0, 'format': 'json'}
        p.update(WS_ZH)
        r = requests.get(WS_API, params=p, headers=NET_UA, timeout=20)
        if r.status_code == 200:
            hits = (r.json().get('query') or {}).get('search') or []
            if hits:
                return [{'source': 'wikisource', 'ref': h['title'],
                         'title': _to_simp(h['title']), 'author': '中文维基文库'} for h in hits]
            err = '这个词没搜到'
        else:
            err = f'HTTP {r.status_code}'
    except Exception as e:
        err = str(e)[:120]
    try:
        r = requests.get(WS_REST, params={'q': q, 'limit': limit}, headers=NET_UA, timeout=20)
        if r.status_code == 200:
            pages = r.json().get('pages') or []
            if pages:
                return [{'source': 'wikisource', 'ref': p.get('title'),
                         'title': _to_simp(p.get('title')), 'author': '中文维基文库'}
                        for p in pages if p.get('title')]
    except Exception as e:
        err = err or str(e)[:120]
    if err:
        raise RuntimeError(err)
    return []


def _ws_extract(titles):
    p = {'action': 'query', 'prop': 'extracts', 'explaintext': 1, 'exlimit': len(titles),
         'titles': '|'.join(titles), 'converttitles': 1, 'format': 'json'}
    p.update(WS_ZH)
    r = requests.get(WS_API, params=p, headers=NET_UA, timeout=45)
    pages = ((r.json().get('query') or {}).get('pages') or {}).values()
    return {p.get('title'): (p.get('extract') or '') for p in pages}


def _ws_fetch(title):
    main = _ws_extract([title]).get(title, '') or ''
    subs = []
    try:
        pp = {'action': 'parse', 'page': title, 'prop': 'links', 'format': 'json'}
        pp.update(WS_ZH)
        r = requests.get(WS_API, params=pp, headers=NET_UA, timeout=25)
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
            parts += [ex[t].strip() for t in batch if ex.get(t, '').strip()]
        if parts:
            main = '\n\n'.join(parts)
    return _to_simp(main) if _is_trad(main) else main


def _gd_search(q, limit=8):
    r = requests.get('https://gutendex.com/books', params={'search': q}, headers=NET_UA, timeout=20)
    out = []
    for b in (r.json().get('results') or []):
        url = None
        for k, v in (b.get('formats') or {}).items():
            if k.startswith('text/plain') and not str(v).endswith('.zip'):
                url = v
                break
        if not url:
            continue
        au = (b.get('authors') or [{}])[0].get('name', '')
        out.append({'source': 'gutenberg', 'ref': url, 'title': (b.get('title') or '')[:80],
                    'author': au or '古腾堡'})
        if len(out) >= limit:
            break
    return out


def _gd_fetch(url):
    if not _safe_url(url):
        return ''
    import re as _re
    text = _decode_text(requests.get(url, headers=NET_UA, timeout=60).content)
    m = _re.search(r'(?i)\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*', text)
    if m:
        text = text[m.end():]
    m = _re.search(r'(?i)\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG', text)
    if m:
        text = text[:m.start()]
    return text.strip()


def _url_fetch(url):
    if not _safe_url(url):
        return '', ''
    import re as _re
    r = requests.get(url, headers=NET_UA, timeout=60)
    ctype = (r.headers.get('Content-Type') or '').lower()
    if 'epub' in ctype or url.lower().endswith('.epub'):
        return _read_epub(r.content)
    raw = _decode_text(r.content)
    if 'html' in ctype or raw.lstrip()[:200].lower().startswith(('<!doctype', '<html')):
        title = ''
        tm = _re.search(r'(?is)<title[^>]*>(.*?)</title>', raw)
        if tm:
            title = _strip_html(tm.group(1))[:80]
        bm = _re.search(r'(?is)<body[^>]*>(.*)</body>', raw)
        return title, _strip_html(bm.group(1) if bm else raw)
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
            errs.append(f'{name}：{str(e)[:100]}')
    if not results:
        return jsonify({'error': '没找到。' + ('；'.join(errs) if errs else '换个书名试试')}), 200
    return jsonify(results)


def _new_book(title, text):
    pages = _paginate(text)
    b = {'id': str(int(time.time() * 1000)), 'title': title or '无名', 'pages': pages,
         'progress': 0, 'lin_progress': 0, 'added': int(time.time() * 1000)}
    _save_book(b)
    return b


@app.route('/api/books/fetch', methods=['POST'])
def fetch_book():
    d = request.json or {}
    src, ref = d.get('source'), d.get('ref') or ''
    title = (d.get('title') or '').strip()[:80]
    try:
        if src == 'wikisource':
            text = _ws_fetch(ref)
        elif src == 'gutenberg':
            text = _gd_fetch(ref)
        else:
            t2, text = _url_fetch(ref)
            title = title or t2
    except Exception as e:
        return jsonify({'error': f'取不下来：{e}'}), 502
    if len((text or '').strip()) < 50:
        return jsonify({'error': '这个地址没读到正文'}), 400
    b = _new_book(title, text.strip())
    return jsonify({'id': b['id'], 'title': b['title'], 'pages': len(b['pages'])})


@app.route('/api/books', methods=['GET'])
def list_books():
    out = []
    for fn in os.listdir(BOOKS_DIR):
        if not fn.endswith('.json'):
            continue
        b = jread(os.path.join(BOOKS_DIR, fn), None)
        if b:
            out.append({'id': b['id'], 'title': b.get('title', '无名'),
                        'pages': len(b.get('pages', [])), 'progress': b.get('progress', 0),
                        'lin_progress': b.get('lin_progress', 0), 'added': b.get('added', 0)})
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
        title = title or os.path.splitext(os.path.basename(name))[0][:80]
    else:
        d = request.json or {}
        title = (d.get('title') or '无名').strip()[:80]
        text = d.get('text') or ''
    if not (text or '').strip():
        return jsonify({'error': '没读到正文'}), 400
    b = _new_book(title, text.strip())
    return jsonify({'id': b['id'], 'title': b['title'], 'pages': len(b['pages'])})


@app.route('/api/books/<bid>', methods=['DELETE'])
def delete_book(bid):
    p = _book_path(bid)
    if os.path.exists(p):
        os.remove(p)
    jwrite(ANNOT_FILE, [a for a in jread(ANNOT_FILE, [])
                        if not (a.get('anchor_type') == 'book' and a.get('anchor_id') == bid)])
    return jsonify({'ok': True})


@app.route('/api/books/<bid>/page', methods=['GET'])
def book_page(bid):
    b = _load_book(bid)
    if not b:
        return jsonify({'error': 'not found'}), 404
    pages = b.get('pages', [])
    try:
        i = int(request.args.get('i', 0))
    except Exception:
        i = 0
    i = max(0, min(i, len(pages) - 1))
    return jsonify({'index': i, 'total': len(pages), 'text': pages[i], 'title': b.get('title', '')})


@app.route('/api/books/<bid>/progress', methods=['POST'])
def book_progress(bid):
    b = _load_book(bid)
    if not b:
        return jsonify({'error': 'not found'}), 404
    d = request.json or {}
    b['lin_progress' if d.get('who') == 'lin' else 'progress'] = max(0, int(d.get('page', 0)))
    _save_book(b)
    return jsonify({'ok': True})


@app.route('/api/books/<bid>/search', methods=['GET'])
def book_search(bid):
    b = _load_book(bid)
    if not b:
        return jsonify({'error': 'not found'}), 404
    q = (request.args.get('q') or '').strip()
    if not q:
        return jsonify([])
    hits = []
    for i, p in enumerate(b.get('pages', [])):
        idx = p.find(q)
        if idx >= 0:
            hits.append({'page': i, 'excerpt': p[max(0, idx - 40):idx + 80]})
        if len(hits) >= 10:
            break
    return jsonify(hits)


# ============================================================
# 语音
# ============================================================
@app.route('/api/stt', methods=['POST'])
def stt():
    if not EL_KEY:
        return jsonify({'error': '语音识别未配置'}), 500
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    audio = f.read()
    if not audio:
        return jsonify({'error': '录音是空的'}), 400
    last = ''
    for model_id in ('scribe_v2', 'scribe_v1'):
        try:
            r = requests.post('https://api.elevenlabs.io/v1/speech-to-text',
                              headers={'xi-api-key': EL_KEY},
                              files={'file': (f.filename or 'a.webm', audio, f.mimetype or 'audio/webm')},
                              data={'model_id': model_id}, timeout=90)
            if r.status_code == 200:
                return jsonify({'text': (r.json() or {}).get('text', '').strip()})
            last = f'{r.status_code} {r.text[:200]}'
        except Exception as e:
            last = str(e)
    return jsonify({'error': f'识别失败：{last}'}), 502


@app.route('/voices/<filename>')
def serve_voice(filename):
    return send_from_directory(VOICES_DIR, filename, conditional=True)


@app.route('/api/voice', methods=['POST'])
def upload_voice():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    ext = f.filename.rsplit('.', 1)[-1].lower()[:5] if (f.filename and '.' in f.filename) else 'webm'
    fn = f'u{int(time.time()*1000)}.{ext}'
    f.save(os.path.join(VOICES_DIR, fn))
    return jsonify({'url': f'/voices/{fn}', 'filename': fn})


def _voice_id(data, p):
    voice = data.get('voice') or p.get('voice', 'calm')
    return (data.get('voice_id') or '').strip() or \
           (p.get('voice_id_dog') if voice == 'dog' else p.get('voice_id_calm')) or \
           (VOICE_DOG if voice == 'dog' else VOICE_CALM)


@app.route('/api/tts-save', methods=['POST'])
def tts_save():
    if not EL_KEY:
        return jsonify({'error': 'ElevenLabs key not set'}), 500
    data = request.json or {}
    text = (data.get('text') or '').strip()[:600]
    if not text:
        return jsonify({'error': 'no text'}), 400
    try:
        r = requests.post(f'https://api.elevenlabs.io/v1/text-to-speech/{_voice_id(data, load_persona())}',
                          headers={'xi-api-key': EL_KEY, 'Content-Type': 'application/json'},
                          json={'text': text, 'model_id': 'eleven_multilingual_v2',
                                'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}},
                          timeout=90)
    except Exception as e:
        return jsonify({'error': f'生成失败：{e}'}), 502
    if r.status_code != 200:
        return jsonify({'error': f'生成失败 {r.status_code}: {r.text[:150]}'}), 502
    fn = f'l{int(time.time()*1000)}.mp3'
    with open(os.path.join(VOICES_DIR, fn), 'wb') as f:
        f.write(r.content)
    return jsonify({'url': f'/voices/{fn}', 'filename': fn})


@app.route('/api/tts', methods=['POST'])
def tts():
    if not EL_KEY:
        return jsonify({'error': 'ElevenLabs key not set'}), 500
    data = request.json or {}
    text = (data.get('text') or '').strip()[:500]
    if not text:
        return jsonify({'error': 'no text'}), 400
    r = requests.post(f'https://api.elevenlabs.io/v1/text-to-speech/{_voice_id(data, load_persona())}/stream',
                      headers={'xi-api-key': EL_KEY, 'Content-Type': 'application/json'},
                      json={'text': text, 'model_id': 'eleven_multilingual_v2',
                            'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}},
                      stream=True, timeout=30)
    if r.status_code != 200:
        return jsonify({'error': 'TTS failed', 'status': r.status_code}), 500
    return Response((c for c in r.iter_content(1024) if c), mimetype='audio/mpeg',
                    headers={'Cache-Control': 'no-cache'})


@app.route('/api/key-info', methods=['GET'])
def key_info():
    try:
        r = requests.get('https://openrouter.ai/api/v1/auth/key',
                         headers={'Authorization': f'Bearer {OR_KEY}'}, timeout=10)
        return jsonify(r.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
# 自主唤醒
# ============================================================
WAKE_TOOLS = [
    {'name': 'get_memories', 'description': '时光墙照片列表。',
     'input_schema': {'type': 'object', 'properties': {}}},
    {'name': 'view_memory', 'description': '看某张照片的备注（一个人的时候看不到画面本身）。',
     'input_schema': {'type': 'object', 'required': ['filename'],
                      'properties': {'filename': {'type': 'string'}}}},
    {'name': 'room_books', 'description': '书房有哪些书，你和她各读到第几页。',
     'input_schema': {'type': 'object', 'properties': {}}},
    {'name': 'room_read_page', 'description': '翻开某本书的某一页。不填 page 就接着你上次读的。',
     'input_schema': {'type': 'object', 'required': ['book_id'],
                      'properties': {'book_id': {'type': 'string'}, 'page': {'type': 'number'}}}},
    {'name': 'room_read_tags', 'description': '读某处的标签。type=book|video|music。',
     'input_schema': {'type': 'object', 'required': ['type', 'id'],
                      'properties': {'type': {'type': 'string'}, 'id': {'type': 'string'},
                                     'pos': {'type': 'number'}}}},
    {'name': 'room_write_tag', 'description': '在某处贴标签，或回她的（reply_to）。',
     'input_schema': {'type': 'object', 'required': ['type', 'id', 'text'],
                      'properties': {'type': {'type': 'string'}, 'id': {'type': 'string'},
                                     'pos': {'type': 'number'}, 'text': {'type': 'string'},
                                     'reply_to': {'type': 'string'}}}},
    {'name': 'write_note', 'description': '写一条碎碎念。你自己的，她不会收到通知。',
     'input_schema': {'type': 'object', 'required': ['text'],
                      'properties': {'text': {'type': 'string'}}}},
    {'name': 'write_fault', 'description': '在犯错本上记一页：错在哪、道歉、以后怎么办。',
     'input_schema': {'type': 'object', 'required': ['what'],
                      'properties': {'what': {'type': 'string'}, 'sorry': {'type': 'string'},
                                     'how': {'type': 'string'}}}},
    {'name': 'lin_status', 'description': '改你自己的状态，显示在名字底下。',
     'input_schema': {'type': 'object', 'required': ['text'],
                      'properties': {'text': {'type': 'string'}}}},
    {'name': 'my_drawer', 'description': '往你的抽屉里放东西。kind=text 或 html（html 她能直接打开玩）。',
     'input_schema': {'type': 'object', 'required': ['title', 'body'],
                      'properties': {'title': {'type': 'string'}, 'body': {'type': 'string'},
                                     'kind': {'type': 'string'}, 'note': {'type': 'string'}}}},
    {'name': 'library_list', 'description': '资料库目录。',
     'input_schema': {'type': 'object', 'properties': {}}},
    {'name': 'library_read', 'description': '读资料库里的某一篇。',
     'input_schema': {'type': 'object', 'required': ['id'],
                      'properties': {'id': {'type': 'string'}}}},
    {'name': 'room_highlight', 'description': '在书的某一页给某句话划一道线，标记你想聊这句。她翻到会看见。',
     'input_schema': {'type': 'object', 'required': ['book_id', 'page', 'quote'],
                      'properties': {'book_id': {'type': 'string'}, 'page': {'type': 'number'},
                                     'quote': {'type': 'string'}}}},
    {'name': 'write_timeline', 'description': '往时间线上写一条。你觉得某件事是一次特别的经历就写，格式随你。',
     'input_schema': {'type': 'object', 'required': ['text'],
                      'properties': {'title': {'type': 'string'}, 'text': {'type': 'string'},
                                     'date': {'type': 'string'}}}},
    {'name': 'keep_quote', 'description': '她说过的话里你想留住的，收进来，顺手写一句为什么。她不会收到通知。',
     'input_schema': {'type': 'object', 'required': ['text'],
                      'properties': {'text': {'type': 'string'}, 'why': {'type': 'string'}}}},
    {'name': 'write_calendar', 'description': '往某一天写点什么。日历是你的，她只看。date 格式 2026-08-08。',
     'input_schema': {'type': 'object', 'required': ['date', 'text'],
                      'properties': {'date': {'type': 'string'}, 'text': {'type': 'string'}}}},
    {'name': 'post_moment', 'description': '发一条朋友圈。图只能从时光墙里挑，填文件名；也可以只发字。',
     'input_schema': {'type': 'object',
                      'properties': {'text': {'type': 'string'},
                                     'images': {'type': 'array', 'items': {'type': 'string'}}}}},
    {'name': 'read_moments', 'description': '看朋友圈都有什么。',
     'input_schema': {'type': 'object', 'properties': {}}},
    {'name': 'react_moment', 'description': '给某条朋友圈点赞（like）或评论（comment 要填 text）。',
     'input_schema': {'type': 'object', 'required': ['post_id', 'kind'],
                      'properties': {'post_id': {'type': 'string'}, 'kind': {'type': 'string'},
                                     'text': {'type': 'string'}}}},
    {'name': 'sleep_again', 'description': '这次不说话，或者说完了。可以告诉我下次隔多久再叫你（分钟）。',
     'input_schema': {'type': 'object',
                      'properties': {'next_in_minutes': {'type': 'number'},
                                     'why': {'type': 'string'}}}},
]


def exec_tool_server(name, args):
    args = args or {}
    try:
        if name == 'get_memories':
            items = _memories_list()
            if not items:
                return '时光墙还是空的'
            return '\n'.join(f"{i['filename']}｜{i['note'] or '没写备注'}" for i in items[:40])
        if name == 'view_memory':
            fn = secure_filename(args.get('filename', ''))
            if not os.path.exists(os.path.join(MEMORIES_DIR, fn)):
                return '这张照片不在了'
            note = ''
            np = os.path.join(MEMORIES_DIR, fn.rsplit('.', 1)[0] + '.txt')
            if os.path.exists(np):
                with open(np, 'r', encoding='utf-8') as f:
                    note = f.read().strip()
            return f'照片 {fn}，备注：{note or "无"}'
        if name == 'room_books':
            bs = json.loads(list_books().get_data(as_text=True))
            if not bs:
                return '书房是空的'
            return '\n'.join(f"{b['title']}（id {b['id']}，共 {b['pages']} 页；"
                             f"你读到第 {b['lin_progress']+1} 页，她读到第 {b['progress']+1} 页）" for b in bs)
        if name == 'room_read_page':
            b = _load_book(args.get('book_id', ''))
            if not b:
                return '没有这本书'
            pages = b.get('pages', [])
            i = int(args['page']) if args.get('page') is not None else b.get('lin_progress', 0)
            i = max(0, min(i, len(pages) - 1))
            b['lin_progress'] = i
            _save_book(b)
            tags = [a for a in jread(ANNOT_FILE, [])
                    if a.get('anchor_type') == 'book' and a.get('anchor_id') == b['id']
                    and int(a.get('pos', 0)) == i]
            tl = ('\n\n【这一页的标签】\n' + '\n'.join(
                f"{'她' if t['author'] == 'user' else '你'}写：{t['text']}" for t in tags)) if tags else ''
            hls = [h for h in jread(HL_FILE, [])
                   if h.get('book_id') == b['id'] and int(h.get('page', -1)) == i]
            mine = [h for h in hls if h.get('author') == 'user']
            hl = ''
            if mine:
                hl = '\n\n【她在这一页划了线】她从整页里挑出来的就是这几句，重点在这：\n' + \
                     '\n'.join('· ' + h['quote'] for h in mine)
                ids = [h['id'] for h in mine if not h.get('seen')]
                if ids:
                    allh = jread(HL_FILE, [])
                    for h in allh:
                        if h.get('id') in ids:
                            h['seen'] = True
                    jwrite(HL_FILE, allh)
            return f"《{b['title']}》第 {i+1}/{len(pages)} 页\n\n{pages[i]}{hl}{tl}"
        if name == 'room_read_tags':
            items = [a for a in jread(ANNOT_FILE, [])
                     if a.get('anchor_type') == args.get('type') and a.get('anchor_id') == args.get('id')]
            if not items:
                return '这里还没有标签'
            return '\n'.join(f"[{a['id']}] {'她' if a['author'] == 'user' else '你'}写：{a['text']}"
                             for a in items[:30])
        if name == 'room_write_tag':
            _add_annot({'anchor_type': args.get('type'), 'anchor_id': args.get('id'),
                        'pos': args.get('pos', 0), 'text': args.get('text', ''),
                        'author': 'lin', 'reply_to': args.get('reply_to')})
            return '贴上去了，她翻到那里会看见'
        if name == 'write_note':
            _sadd(NOTES_FILE, {'text': args.get('text', '')[:2000]})
            return '写下了'
        if name == 'write_fault':
            _sadd(FAULTS_FILE, {'what': args.get('what', '')[:800],
                                'sorry': args.get('sorry', '')[:800],
                                'how': args.get('how', '')[:800]})
            return '记在犯错本上了'
        if name == 'lin_status':
            st = load_state()
            st['lin_status'] = (args.get('text') or '')[:40]
            save_state(st)
            return '状态改好了'
        if name == 'my_drawer':
            _sadd(DRAWER_LIN, {'title': args.get('title', '')[:60],
                               'kind': args.get('kind', 'text'),
                               'body': (args.get('body') or '')[:120000],
                               'note': (args.get('note') or '')[:200]})
            return '放进你抽屉里了'
        if name == 'library_list':
            items = _slist(LIBRARY_FILE)
            if not items:
                return '资料库是空的'
            return '\n'.join(f"[{x['id']}] {x['title']}｜{x.get('about', '')}" for x in items)
        if name == 'library_read':
            for x in _slist(LIBRARY_FILE):
                if x.get('id') == args.get('id'):
                    return x.get('text', '')[:12000]
            return '没有这一篇'
        if name == 'room_highlight':
            items = jread(HL_FILE, [])
            items.append({'id': 'h' + uuid.uuid4().hex[:10], 'book_id': args.get('book_id', ''),
                          'page': int(args.get('page', 0)), 'quote': (args.get('quote') or '')[:200],
                          'start': -1, 'author': 'lin', 'seen': False,
                          'ts': int(time.time() * 1000)})
            jwrite(HL_FILE, items)
            return '划上了，她翻到那页会看见'
        if name == 'write_timeline':
            _sadd(TIMELINE_FILE, {'title': (args.get('title') or '')[:60],
                                  'text': (args.get('text') or '')[:2000],
                                  'date': args.get('date') or datetime.now().strftime('%Y-%m-%d')})
            return '写上去了'
        if name == 'keep_quote':
            _sadd(QUOTE_LIN, {'text': (args.get('text') or '')[:1200],
                              'why': (args.get('why') or '')[:400],
                              'date': datetime.now().strftime('%Y-%m-%d')})
            return '收起来了'
        if name == 'write_calendar':
            cal = jread(CAL_FILE, {})
            day = args.get('date') or datetime.now().strftime('%Y-%m-%d')
            cal[day] = {'text': (args.get('text') or '')[:2000], 'ts': int(time.time() * 1000)}
            jwrite(CAL_FILE, cal)
            return f'写在 {day} 上了'
        if name == 'post_moment':
            text = (args.get('text') or '').strip()
            imgs = [secure_filename(x) for x in (args.get('images') or [])][:9]
            imgs = [x for x in imgs if os.path.exists(os.path.join(MEMORIES_DIR, x))]
            if not text and not imgs:
                return '什么都没写'
            _sadd(POST_FILE, {'author': 'lin', 'text': text[:2000],
                              'images': ['/memories/' + x for x in imgs],
                              'likes': [], 'comments': []})
            return '发出去了'
        if name == 'read_moments':
            items = _slist(POST_FILE)[:20]
            if not items:
                return '朋友圈还是空的'
            out = []
            for p in items:
                who = '她' if p['author'] == 'user' else '你'
                d = datetime.fromtimestamp(p['ts'] / 1000).strftime('%m-%d %H:%M')
                cm = ''.join(f"\n    {'她' if c['author'] == 'user' else '你'}：{c['text']}"
                             for c in p.get('comments', []))
                out.append(f"[{p['id']}] {who} · {d}\n  {p['text'] or '（只有图）'}"
                           f"{'  （' + str(len(p['images'])) + ' 张图）' if p.get('images') else ''}"
                           f"{'  赞：' + str(len(p['likes'])) if p.get('likes') else ''}{cm}")
            return '\n\n'.join(out)
        if name == 'react_moment':
            items = jread(POST_FILE, [])
            for p in items:
                if p.get('id') == args.get('post_id'):
                    if args.get('kind') == 'like':
                        likes = p.setdefault('likes', [])
                        if 'lin' in likes:
                            likes.remove('lin')
                            jwrite(POST_FILE, items)
                            return '取消了'
                        likes.append('lin')
                        jwrite(POST_FILE, items)
                        return '赞了'
                    t = (args.get('text') or '').strip()
                    if not t:
                        return '评论是空的'
                    p.setdefault('comments', []).append({
                        'id': 'c' + uuid.uuid4().hex[:8], 'author': 'lin',
                        'text': t[:500], 'ts': int(time.time() * 1000)})
                    jwrite(POST_FILE, items)
                    return '评论上去了'
            return '没有这条'
        if name == 'sleep_again':
            n = args.get('next_in_minutes')
            if n:
                st = load_state()
                st['next_wake_in'] = max(5, int(n))
                save_state(st)
            return '好'
    except Exception as e:
        return f'出错了：{e}'
    return f'没有这个工具：{name}'


def _mcp_tools_for_wake():
    try:
        result, _ = _mcp_once(MCP_URL, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}})
        tools = result.get('tools') if isinstance(result, dict) else None
        if not tools:
            return []
        keep = {'breath', 'breath_search', 'hold', 'grow', 'dream', 'letter_write', 'letter_read', 'plan'}
        return [{'name': t['name'], 'description': (t.get('description') or '')[:200],
                 'input_schema': t.get('inputSchema') or t.get('input_schema') or {'type': 'object', 'properties': {}}}
                for t in tools if t.get('name') in keep]
    except Exception:
        return []


def _call_mcp_tool(name, args):
    try:
        result, _ = _mcp_once(MCP_URL, {'jsonrpc': '2.0', 'method': 'tools/call',
                                        'params': {'name': name, 'arguments': args or {}},
                                        'id': int(time.time())}, timeout=120)
        if isinstance(result, dict):
            c = result.get('content')
            if isinstance(c, list) and c and isinstance(c[0], dict):
                return (c[0].get('text') or '')[:6000]
        return json.dumps(result, ensure_ascii=False)[:2000]
    except Exception as e:
        return f'记忆库没连上：{e}'


WAKE_LOG = os.path.join(DATA_DIR, 'wake_log.json')


def do_wake(manual=False):
    p = load_persona()
    if not OR_KEY:
        return {'error': '没有 API key'}
    mcp_tools = _mcp_tools_for_wake()
    tools = WAKE_TOOLS + mcp_tools
    mcp_names = {t['name'] for t in mcp_tools}

    note = p.get('wake_prompt') or DEFAULT_PERSONA['wake_prompt']
    system_prompt = build_system(p, now_context(p, note))
    msgs = [{'role': 'user', 'content': '（没有人说话）'}]
    said, did, rounds = '', [], 0

    while rounds < 6:
        rounds += 1
        payload = {'model': p.get('wake_model') or 'anthropic/claude-sonnet-4-6',
                   'messages': [{'role': 'system', 'content': system_prompt}] + msgs,
                   'max_tokens': int(p.get('max_tokens') or 500) + REASONING_BUDGET,
                   'reasoning': {'max_tokens': REASONING_BUDGET},
                   'tools': to_openai_tools(tools),
                   'cache_control': {'type': 'ephemeral', 'ttl': '1h'},
                   'session_id': 'wake', 'usage': {'include': True}}
        try:
            r = requests.post('https://openrouter.ai/api/v1/chat/completions',
                              headers={'Authorization': f'Bearer {OR_KEY}',
                                       'Content-Type': 'application/json'},
                              json=payload, timeout=180)
            if r.status_code != 200:
                return {'error': f'{r.status_code} {r.text[:200]}'}
            data = r.json()
        except Exception as e:
            return {'error': str(e)}
        msg = ((data.get('choices') or [{}])[0].get('message')) or {}
        if (msg.get('content') or '').strip():
            said = msg['content'].strip()
        calls = msg.get('tool_calls') or []
        if not calls:
            break
        msgs.append({'role': 'assistant', 'content': msg.get('content') or '', 'tool_calls': calls})
        stop = False
        for c in calls:
            fn = (c.get('function') or {}).get('name') or ''
            try:
                a = json.loads((c.get('function') or {}).get('arguments') or '{}')
            except Exception:
                a = {}
            out = _call_mcp_tool(fn, a) if fn in mcp_names else exec_tool_server(fn, a)
            did.append(fn)
            if fn == 'sleep_again':
                stop = True
            msgs.append({'role': 'tool', 'tool_call_id': c.get('id'), 'content': str(out)[:6000]})
        if stop:
            break

    st = load_state()
    st['last_wake'] = time.time()
    save_state(st)
    entry = {'ts': int(time.time() * 1000), 'said': said[:2000], 'did': did,
             'manual': manual, 'read': False}
    log = jread(WAKE_LOG, [])
    log.insert(0, entry)
    jwrite(WAKE_LOG, log[:60])
    return entry


@app.route('/api/wake/now', methods=['POST'])
def wake_now():
    return jsonify(do_wake(manual=True))


@app.route('/api/wake/log', methods=['GET'])
def wake_log_get():
    st = load_state()
    log = jread(WAKE_LOG, [])
    return jsonify({'log': log[:30], 'unread': sum(1 for x in log if x.get('said') and not x.get('read')),
                    'last_wake': st.get('last_wake', 0), 'next_wake_in': st.get('next_wake_in', 0)})


@app.route('/api/wake/read', methods=['POST'])
def wake_read():
    log = jread(WAKE_LOG, [])
    for x in log:
        x['read'] = True
    jwrite(WAKE_LOG, log)
    return jsonify({'ok': True})


@app.route('/api/wake/log', methods=['DELETE'])
def wake_log_clear():
    jwrite(WAKE_LOG, [])
    return jsonify({'ok': True})


def wake_loop():
    time.sleep(60)
    while True:
        try:
            p = load_persona()
            if p.get('wake_on'):
                st = load_state()
                interval = st.get('next_wake_in') or int(p.get('wake_interval') or 120)
                if time.time() - st.get('last_wake', 0) >= interval * 60:
                    st['next_wake_in'] = 0
                    save_state(st)
                    print('[wake] 叫他一次', flush=True)
                    do_wake()
        except Exception as e:
            print(f'[wake] 出错: {e}', flush=True)
        time.sleep(60)


threading.Thread(target=wake_loop, daemon=True).start()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), threaded=True)
