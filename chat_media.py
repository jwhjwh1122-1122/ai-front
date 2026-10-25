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

from flask import Response, abort, jsonify, request
from werkzeug.utils import secure_filename

IMG_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'}
MAX_IMG_BYTES = 12 * 1024 * 1024        # 单张图片上限（前端会先压缩，正常远小于这个）
MAX_STICKER_BYTES = 10 * 1024 * 1024    # 静图前端会缩到 512px；主要是给动图 GIF 留余地
OWNERS = ('lin', 'user')
_DATA_URL = re.compile(r'^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$', re.S)
_lock = threading.Lock()


def sniff(raw):
    """按文件头认格式，不信文件名。认不出返回 ''。"""
    b = raw[:16]
    if b[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if b[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if b[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'webp'
    if raw[4:8] == b'ftyp' and raw[8:12] in (b'heic', b'heix', b'hevc', b'heim', b'heis', b'mif1', b'msf1'):
        return 'heic'
    return ''


SERVE_MIME = {'jpg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic'}
STICKER_URL_VER = '2'   # 表情地址带版本号：手机里要是缓存过半截的旧图，换了地址就会重新下载


def intact(raw):
    """文件是不是完整的（看文件尾）。返回 (是否完整, 格式)。"""
    kind = sniff(raw)
    tail = raw.rstrip(b'\x00\r\n\t ')
    if kind == 'jpg':
        return tail.endswith(b'\xff\xd9'), kind
    if kind == 'png':
        return raw.rstrip(b'\x00').endswith(b'IEND\xaeB`\x82'), kind
    if kind == 'gif':
        return tail.endswith(b';'), kind
    if kind == 'webp':
        return len(raw) >= 12 and int.from_bytes(raw[4:8], 'little') + 8 <= len(raw), kind
    return bool(kind), kind


def serve_file(folder, filename):
    """整个读出来再发，不走 sendfile：sendfile 在云盘挂载的 /data 上可能只发出半截文件，
    手机上就会看到图片下半截变成灰块。文件名唯一、内容不会变，所以可以长缓存。"""
    safe = secure_filename(filename)
    fp = os.path.join(folder, safe)
    try:
        with open(fp, 'rb') as f:
            raw = f.read()
    except OSError:
        abort(404)
    return Response(raw, mimetype=SERVE_MIME.get(sniff(raw), 'application/octet-stream'),
                    headers={'Cache-Control': 'public, max-age=2592000, immutable',
                             'Content-Length': str(len(raw))}, direct_passthrough=True)


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
                'url': '/stickers/' + x['file'] + '?v=' + STICKER_URL_VER,
                'note': x.get('note', ''), 'seen': bool(x.get('seen'))}

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
        raw = f.read(MAX_IMG_BYTES + 1)
        if len(raw) > MAX_IMG_BYTES:
            return jsonify({'error': '图片太大了'}), 413
        ext = sniff(raw)
        if not ext:
            return jsonify({'error': '只支持图片'}), 400
        fn = _new_name('ci', ext)
        with open(os.path.join(img_dir, fn), 'wb') as out:
            out.write(raw)
        return jsonify({'url': '/chatimg/' + fn, 'filename': fn,
                        'warn': '这个格式他可能看不了，最好换成截图或 JPG' if ext == 'heic' else ''})

    @app.route('/chatimg/<filename>')
    def chat_img_serve(filename):
        return serve_file(img_dir, filename)

    # ---------------- 表情包 ----------------
    @app.route('/stickers/<filename>')
    def sticker_serve(filename):
        return serve_file(stk_dir, filename)

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
        raw = f.read(MAX_STICKER_BYTES + 1)
        if len(raw) > MAX_STICKER_BYTES:
            return jsonify({'error': '这张太大了（动图最大 10MB）'}), 413
        ext = sniff(raw)
        if not ext or ext == 'heic':
            return jsonify({'error': '这个格式用不了，换成 PNG、JPG 或 GIF'}), 400
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
                try:
                    raw = base64.b64decode(m.group(2))
                except Exception:
                    continue
                ext = sniff(raw)
                if not raw or len(raw) > MAX_STICKER_BYTES or ext in ('', 'heic'):
                    continue
                items.append({'id': 'st' + uuid.uuid4().hex[:10], 'name': name, 'owner': owner,
                              'file': _save_bytes(raw, ext), 'ts': int(time.time() * 1000)})
                have.add((owner, name))
                added += 1
            if added:
                jwrite(stk_file, items)
        return jsonify({'ok': True, 'added': added})

    @app.route('/api/stickers/check', methods=['GET'])
    def stickers_check():
        """逐个检查表情文件在服务器上是不是完整的。"""
        out = []
        for x in _list():
            try:
                with open(os.path.join(stk_dir, secure_filename(x['file'])), 'rb') as f:
                    raw = f.read()
                ok, kind = intact(raw)
                out.append({'id': x['id'], 'name': x.get('name', ''), 'owner': x.get('owner'),
                            'ok': ok, 'kind': kind, 'size': len(raw)})
            except OSError:
                out.append({'id': x['id'], 'name': x.get('name', ''), 'owner': x.get('owner'),
                            'ok': False, 'kind': '', 'size': 0, 'missing': True})
        return jsonify({'ok': True, 'items': out, 'broken': sum(1 for x in out if not x['ok'])})

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
