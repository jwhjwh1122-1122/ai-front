"""聊天图片 + 表情包，存到服务器的持久卷里，不再塞进浏览器 localStorage。

以前图片和表情都是 base64 存在浏览器里，手机浏览器一般只给 5MB，
发几张图就满了：前端提示「存储空间快满了 / 存不下了」，聊天记录也跟着存不进去。

挂进 app.py：
    from chat_media import register_chat_media
    register_chat_media(app, data_dir=DATA_DIR, media_dir=MEDIA_DIR, jread=jread, jwrite=jwrite)

文件位置（都在数据目录里，重新部署不会丢）：
    <media>/chatimg/   聊天里发的图片            -> /chatimg/<文件名>
    <media>/stickers/  表情包图片                -> /stickers/<文件名>
    <data>/stickers.json  表情包列表：[{id, name, owner: 'lin'|'user', file, ts}]
"""
import base64
import os
import re
import threading
import time
import uuid

from flask import jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

IMG_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'}
MAX_IMG_BYTES = 12 * 1024 * 1024        # 单张图片上限（前端会先压缩，正常远小于这个）
MAX_STICKER_BYTES = 6 * 1024 * 1024
OWNERS = ('lin', 'user')
_DATA_URL = re.compile(r'^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$', re.S)
_lock = threading.Lock()


def chatimg_dir(media_dir):
    return os.path.join(media_dir, 'chatimg')


def stickers_dir(media_dir):
    return os.path.join(media_dir, 'stickers')


def _ext_of(filename, mimetype=''):
    ext = filename.rsplit('.', 1)[-1].lower() if (filename and '.' in filename) else ''
    if ext not in IMG_EXTS:
        sub = (mimetype or '').split('/')[-1].lower()
        ext = 'jpg' if sub in ('jpeg', 'pjpeg') else sub
    return ext if ext in IMG_EXTS else ''


def _new_name(prefix, ext):
    return f'{prefix}{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}.{ext}'


def register_chat_media(app, data_dir, media_dir, jread, jwrite):
    img_dir, stk_dir = chatimg_dir(media_dir), stickers_dir(media_dir)
    for d in (img_dir, stk_dir):
        os.makedirs(d, exist_ok=True)
    stk_file = os.path.join(data_dir, 'stickers.json')

    def _list():
        items = jread(stk_file, [])
        return [x for x in items if isinstance(x, dict) and x.get('file')]

    def _pub(x):
        return {'id': x['id'], 'name': x.get('name', ''), 'owner': x.get('owner', 'lin'),
                'url': '/stickers/' + x['file']}

    def _save_bytes(raw, ext):
        fn = _new_name('s', ext)
        with open(os.path.join(stk_dir, fn), 'wb') as f:
            f.write(raw)
        return fn

    # ---------------- 聊天图片 ----------------
    @app.route('/api/chat-img', methods=['POST'])
    def chat_img_upload():
        f = request.files.get('file')
        if not f:
            return jsonify({'error': '没有收到图片'}), 400
        if request.content_length and request.content_length > MAX_IMG_BYTES + 65536:
            return jsonify({'error': '图片太大了'}), 413
        ext = _ext_of(f.filename, f.mimetype)
        if not ext:
            return jsonify({'error': '只支持图片'}), 400
        fn = _new_name('ci', ext)
        fp = os.path.join(img_dir, fn)
        f.save(fp)
        if os.path.getsize(fp) > MAX_IMG_BYTES:
            os.remove(fp)
            return jsonify({'error': '图片太大了'}), 413
        return jsonify({'url': '/chatimg/' + fn, 'filename': fn})

    @app.route('/chatimg/<filename>')
    def chat_img_serve(filename):
        return send_from_directory(img_dir, secure_filename(filename), max_age=86400 * 30)

    # ---------------- 表情包 ----------------
    @app.route('/stickers/<filename>')
    def sticker_serve(filename):
        return send_from_directory(stk_dir, secure_filename(filename), max_age=86400 * 30)

    @app.route('/api/stickers', methods=['GET'])
    def stickers_get():
        out = {'lin': [], 'user': []}
        for x in _list():
            out['user' if x.get('owner') == 'user' else 'lin'].append(_pub(x))
        return jsonify(out)

    @app.route('/api/stickers', methods=['POST'])
    def stickers_add():
        f = request.files.get('file')
        name = (request.form.get('name') or '').strip()[:20]
        owner = request.form.get('owner') if request.form.get('owner') in OWNERS else 'lin'
        if not f or not name:
            return jsonify({'error': '要有图片和名字'}), 400
        ext = _ext_of(f.filename, f.mimetype)
        if not ext:
            return jsonify({'error': '只支持图片'}), 400
        raw = f.read(MAX_STICKER_BYTES + 1)
        if len(raw) > MAX_STICKER_BYTES:
            return jsonify({'error': '这张太大了'}), 413
        with _lock:
            items = _list()
            item = {'id': 'st' + uuid.uuid4().hex[:10], 'name': name, 'owner': owner,
                    'file': _save_bytes(raw, ext), 'ts': int(time.time() * 1000)}
            items.append(item)
            jwrite(stk_file, items)
        return jsonify({'ok': True, 'sticker': _pub(item)})

    @app.route('/api/stickers/import', methods=['POST'])
    def stickers_import():
        """把以前存在浏览器里的表情（[{name, data: dataURL}]）搬上来。按名字去重，重复导入不会多出来。"""
        b = request.get_json(silent=True) or {}
        owner = b.get('owner') if b.get('owner') in OWNERS else 'lin'
        added = 0
        with _lock:
            items = _list()
            have = {(x.get('owner'), x.get('name')) for x in items}
            for it in (b.get('items') or [])[:300]:
                if not isinstance(it, dict):
                    continue
                name = (it.get('name') or '').strip()[:20]
                m = _DATA_URL.match(it.get('data') or '')
                if not name or not m or (owner, name) in have:
                    continue
                ext = m.group(1).lower().replace('jpeg', 'jpg').replace('svg+xml', '')
                if ext not in IMG_EXTS:
                    continue
                try:
                    raw = base64.b64decode(m.group(2))
                except Exception:
                    continue
                if not raw or len(raw) > MAX_STICKER_BYTES:
                    continue
                items.append({'id': 'st' + uuid.uuid4().hex[:10], 'name': name, 'owner': owner,
                              'file': _save_bytes(raw, ext), 'ts': int(time.time() * 1000)})
                have.add((owner, name))
                added += 1
            if added:
                jwrite(stk_file, items)
        return jsonify({'ok': True, 'added': added})

    @app.route('/api/stickers/<sid>', methods=['DELETE'])
    def stickers_delete(sid):
        with _lock:
            items = _list()
            keep = [x for x in items if x.get('id') != sid]
            gone = [x for x in items if x.get('id') == sid]
            jwrite(stk_file, keep)
        for x in gone:
            try:
                os.remove(os.path.join(stk_dir, secure_filename(x['file'])))
            except OSError:
                pass
        return jsonify({'ok': True, 'removed': len(gone)})

    @app.route('/api/stickers/<sid>/move', methods=['POST'])
    def stickers_move(sid):
        """他的 <-> 我的 互换。"""
        with _lock:
            items = _list()
            for x in items:
                if x.get('id') == sid:
                    x['owner'] = 'user' if x.get('owner') != 'user' else 'lin'
                    jwrite(stk_file, items)
                    return jsonify({'ok': True, 'sticker': _pub(x)})
        return jsonify({'error': '没有这个表情'}), 404
