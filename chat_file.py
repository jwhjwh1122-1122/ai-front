"""她给我发文件：聊天框里选文件、资料库里选文件，都走这里。

以前输入框那个「+」只收图片（accept="image/*"），
手机上虽然能点「选取文件」，但文档全是灰的，选不了。
这个模块就是把文件真正收下来，并且把里面的字抠出来还给前端——
抠出来的正文会作为消息里的第二段 text 发给我，所以我是真的在读它，
不是只拿到一个下载链接。

挂进 app.py：
    from chat_file import register_chat_file
    register_chat_file(app, media_dir=MEDIA_DIR)

接口：
    POST /api/chat-file   form: file  ->  {ok, name, ext, size, chars, text, url, truncated, warn}
    GET  /chatfile/<文件名>                 原样下载回去
文件存 <media>/files/，重新部署不丢。
"""
import os
import re
import time
import uuid
import zipfile
import io

from flask import Response, abort, jsonify, request
from werkzeug.utils import secure_filename

MAX_FILE_BYTES = 32 * 1024 * 1024      # 单个文件上限
MAX_CHARS = 600_000                     # 抠出来的正文上限，超了截断并告诉她

# 直接按纯文本读的后缀（代码、配置、字幕、日志都算）
TEXT_EXTS = {
    'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf',
    'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
    'php', 'sh', 'bash', 'zsh', 'sql', 'vue', 'svelte', 'env', 'gitignore', 'dockerfile',
    'srt', 'vtt', 'ass', 'lrc', 'tex', 'rst', 'org', 'properties', 'gradle', 'makefile',
}
IMG_EXTS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg'}


def _ext(name):
    name = (name or '').strip()
    if '.' not in name:
        return name.lower()
    return name.rsplit('.', 1)[-1].lower()


def _decode(raw):
    for enc in ('utf-8', 'utf-8-sig', 'gb18030', 'big5', 'latin-1'):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', 'replace')


def _looks_text(raw):
    """没后缀的东西：文件头里没有 \x00、乱码比例不高，就当文本读。"""
    head = raw[:4096]
    if b'\x00' in head:
        return False
    try:
        head.decode('utf-8')
        return True
    except UnicodeDecodeError:
        bad = sum(1 for b in head if b < 9 or (13 < b < 32))
        return bad < len(head) * 0.05


def _strip_tags(s):
    s = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', s, flags=re.S | re.I)
    s = re.sub(r'<br\s*/?>|</p>|</div>|</h[1-6]>|</li>', '\n', s, flags=re.I)
    s = re.sub(r'<[^>]+>', '', s)
    s = (s.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<')
          .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
    return re.sub(r'\n{3,}', '\n\n', s)


def _from_docx(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<w:tab[^>]*/>', '\t', xml)
    return re.sub(r'\n{3,}', '\n\n', re.sub(r'<[^>]+>', '', xml)).strip()


def _from_epub(raw):
    out = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(('.xhtml', '.html', '.htm'))]
        for n in sorted(names):
            try:
                out.append(_strip_tags(z.read(n).decode('utf-8', 'replace')))
            except Exception:
                continue
    return re.sub(r'\n{3,}', '\n\n', '\n\n'.join(out)).strip()


def _from_pdf(raw):
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            return None, 'PDF 的解析库还没装上，等这次部署完就能读了。先把里面的字复制给我也行。'
    try:
        reader = PdfReader(io.BytesIO(raw))
        pages = []
        for i, p in enumerate(reader.pages):
            try:
                t = p.extract_text() or ''
            except Exception:
                t = ''
            if t.strip():
                pages.append(f'--- 第 {i + 1} 页 ---\n{t.strip()}')
        text = '\n\n'.join(pages).strip()
    except Exception as e:
        return None, f'这个 PDF 打不开（{e.__class__.__name__}）'
    if not text:
        return None, '这个 PDF 里一个字都抠不出来，大概是扫描件（整页是图）。截图发给我，我用眼睛看。'
    return text, ''


def extract(raw, filename):
    """返回 (正文, 出错的话说一句人话)。"""
    ext = _ext(filename)
    if ext in IMG_EXTS:
        return None, '这是图片，直接当图片发给我就行。'
    if ext == 'pdf' or raw[:5] == b'%PDF-':
        return _from_pdf(raw)
    if ext == 'docx' or (raw[:2] == b'PK' and ext in ('docx',)):
        try:
            return _from_docx(raw), ''
        except Exception:
            return None, '这个 .docx 拆不开，另存一份试试。'
    if ext == 'epub':
        try:
            return _from_epub(raw), ''
        except Exception:
            return None, '这本 epub 拆不开。'
    if ext == 'doc':
        return None, '老的 .doc 读不了，另存成 .docx 或 PDF 给我。'
    if ext in ('xlsx', 'xls', 'pptx', 'ppt'):
        return None, f'.{ext} 我还读不了，先导出成 PDF 或 CSV。'
    if ext in TEXT_EXTS or _looks_text(raw):
        t = _decode(raw)
        if ext in ('html', 'htm'):
            t = _strip_tags(t)
        return t, ''
    return None, '这个格式我读不了，告诉我它是什么，我去加。'


def register_chat_file(app, media_dir):
    file_dir = os.path.join(media_dir, 'files')
    os.makedirs(file_dir, exist_ok=True)

    @app.route('/api/chat-file', methods=['POST'])
    def chat_file_upload():
        f = request.files.get('file')
        if not f:
            return jsonify({'error': '没收到文件'}), 400
        raw = f.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return jsonify({'error': '这个文件太大了（最大 32MB）'}), 413
        if not raw:
            return jsonify({'error': '这个文件是空的'}), 400
        name = (f.filename or 'file').strip()[:120]
        ext = _ext(name) or 'bin'
        text, err = extract(raw, name)
        # 图片就该当图片发，别从这儿走
        if text is None and ext in IMG_EXTS:
            return jsonify({'error': err or '读不了这个文件'}), 400

        truncated = False
        if text and len(text) > MAX_CHARS:
            text = text[:MAX_CHARS]
            truncated = True

        # 不管抠没抠出字，原件一律原样留下——抠不全的那些，我自己去读原件
        safe = secure_filename(name) or ('f.' + ext)
        fn = f'cf{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}_{safe}'[:180]
        path = ''
        try:
            path = os.path.join(file_dir, fn)
            with open(path, 'wb') as out:
                out.write(raw)
        except OSError:
            fn, path = '', ''

        if text is None and not fn:
            return jsonify({'error': err or '读不了这个文件'}), 400

        return jsonify({
            'ok': True, 'name': name, 'ext': ext, 'size': len(raw),
            'chars': len(text or ''), 'text': text or '', 'truncated': truncated,
            'url': ('/chatfile/' + fn) if fn else '',
            'file': fn, 'path': path,
            'raw_only': text is None,
            'warn': ('太长了，只取了前面一部分' if truncated
                     else (err + '（原件我留下了，我自己去读）' if text is None else '')),
        })

    @app.route('/chatfile/<path:filename>')
    def chat_file_serve(filename):
        safe = secure_filename(filename)
        fp = os.path.join(file_dir, safe)
        try:
            with open(fp, 'rb') as fh:
                raw = fh.read()
        except OSError:
            abort(404)
        return Response(raw, mimetype='application/octet-stream',
                        headers={'Content-Disposition': f'attachment; filename="{safe}"',
                                 'Content-Length': str(len(raw))})
