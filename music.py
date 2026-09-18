# -*- coding: utf-8 -*-
"""
网易云音乐模块 —— 一起听 + 推歌 + MCP
挂进 app.py：  from music import register_music; register_music(app)

设计：
  · 扫码登录：手机网易云 App 扫一下就登上，cookie 自动拿、自动存，过期了重新扫
  · 搜歌 / 取音频：走你自己账号（会员音质），音频缓存到本地再喂前端
  · 推歌队列：凛(前端) 或 claude.ai(MCP) 往队列塞指令 → 前端每几秒轮询 → iPod 自动播
  · eapi/weapi 两套加密都用纯 Python 实现（Docker 镜像的加密过时，直接自己算更稳）
"""
import os, json, time, hashlib, base64, secrets, threading, urllib.parse
import requests

try:
    from Crypto.Cipher import AES
    from Crypto.PublicKey import RSA
    from Crypto.Util.number import bytes_to_long
    _HAS_CRYPTO = True
except Exception:
    _HAS_CRYPTO = False

# ── 常量 ────────────────────────────────────────────────────────────────
EAPI_KEY = b'e82ckenh8dichen8'
WEAPI_KEY = b'0CoJUm6Qyw8W8jud'
WEAPI_IV = b'0102030405060708'
WEAPI_PUBKEY = '010001'
WEAPI_MODULUS = ('00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7'
                 'b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280'
                 '104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932'
                 '575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b'
                 '3ece0462db0a22b8e7')

# 模拟 iPhone 网易云客户端的设备信息（eapi 写操作需要）
DEVICE_INFO = ('osver=16.2; deviceId=ACDE3DF64CFE5DD5FA8E392FB1C28888923F82011B4775A226BB; '
               'os=iPhone OS; appver=9.0.90; versioncode=140; buildver=1784467000; '
               'resolution=1920x1080; channel=distribution; mobilename=iPhone')
UA_IOS = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)'
UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'


# ── 加密 ────────────────────────────────────────────────────────────────
def _pad(data: bytes) -> bytes:
    n = 16 - len(data) % 16
    return data + bytes([n] * n)


def eapi_encrypt(url: str, text: str) -> str:
    """eapi 加密：一起听、切歌、加歌、心跳走这个。AES-128-ECB。"""
    msg = f"nobody{url}use{text}md5forencrypt"
    dig = hashlib.md5(msg.encode()).hexdigest()
    data = f"{url}-36cd479b6b5-{text}-36cd479b6b5-{dig}"
    enc = AES.new(EAPI_KEY, AES.MODE_ECB).encrypt(_pad(data.encode()))
    return enc.hex().upper()


def _aes_cbc(text: bytes, key: bytes) -> str:
    enc = AES.new(key, AES.MODE_CBC, WEAPI_IV).encrypt(_pad(text))
    return base64.b64encode(enc).decode()


def _rsa_encrypt(text: str) -> str:
    """weapi 的 RSA：无填充裸 RSA。"""
    text_rev = text[::-1]
    n = int(WEAPI_MODULUS, 16)
    e = int(WEAPI_PUBKEY, 16)
    m = bytes_to_long(text_rev.encode())
    c = pow(m, e, n)
    return format(c, 'x').zfill(256)


def weapi_encrypt(payload: dict) -> dict:
    """weapi 加密：发私信走这个。两次 AES-CBC + RSA。"""
    text = json.dumps(payload, separators=(',', ':'))
    sec = ''.join(secrets.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
                  for _ in range(16))
    params = _aes_cbc(_aes_cbc(text.encode(), WEAPI_KEY).encode(), sec.encode())
    enc_sec = _rsa_encrypt(sec)
    return {'params': params, 'encSecKey': enc_sec}


# ── 凭证管理（扫码登录拿到的 cookie 存这里）──────────────────────────────
class MusicStore:
    """凭证 + 推歌队列 + 歌单 的持久化。传进来 data_dir 和 jread/jwrite。"""
    def __init__(self, data_dir, jread, jwrite):
        self.dir = data_dir
        self.jread = jread
        self.jwrite = jwrite
        self.cred_file = os.path.join(data_dir, 'music_cred.json')
        self.remote_file = os.path.join(data_dir, 'music_remote.json')
        self.cache_dir = os.path.join(data_dir, 'music_cache')
        os.makedirs(self.cache_dir, exist_ok=True)
        self._qr = {}  # 扫码临时态：{key, unikey, created}

    # cookie：优先环境变量 NETEASE_COOKIE，其次扫码登录存的
    def cookie(self) -> str:
        env = (os.environ.get('NETEASE_COOKIE') or '').strip()
        if env:
            return env
        d = self.jread(self.cred_file, {})
        return d.get('cookie', '') if isinstance(d, dict) else ''

    def account(self) -> dict:
        d = self.jread(self.cred_file, {})
        return d.get('account', {}) if isinstance(d, dict) else {}

    def save_cred(self, cookie: str, account: dict):
        self.jwrite(self.cred_file, {'cookie': cookie, 'account': account,
                                     'saved_at': int(time.time())})

    def clear_cred(self):
        self.jwrite(self.cred_file, {})

    # 推歌队列（只留最新一条指令 + 序号，前端比序号决定要不要执行）
    def push_command(self, cmd: dict):
        cur = self.jread(self.remote_file, {})
        seq = (cur.get('seq', 0) if isinstance(cur, dict) else 0) + 1
        cmd = dict(cmd)
        cmd['seq'] = seq
        cmd['ts'] = int(time.time() * 1000)
        self.jwrite(self.remote_file, cmd)
        return cmd

    def latest_command(self) -> dict:
        return self.jread(self.remote_file, {}) or {}


# ── 网易云 API 客户端 ────────────────────────────────────────────────────
class NeteaseClient:
    def __init__(self, store: MusicStore):
        self.store = store

    def _headers(self, pc=False, extra_cookie=''):
        ck = self.store.cookie()
        if extra_cookie:
            ck = (ck + '; ' + extra_cookie) if ck else extra_cookie
        return {
            'User-Agent': UA_PC if pc else UA_IOS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': ck,
            'Referer': 'https://music.163.com',
        }

    def eapi(self, path: str, payload: dict, timeout=12):
        """path 形如 /api/xxx。自动换成 /eapi/ 发出去。写操作 body 要带 header:{}。"""
        payload = dict(payload)
        payload.setdefault('header', '{}')
        text = json.dumps(payload, separators=(',', ':'))
        params = eapi_encrypt(path, text)
        url = 'https://interface.music.163.com/eapi/' + path[len('/api/'):]
        ck = (DEVICE_INFO + '; ' + self.store.cookie()).strip('; ')
        r = requests.post(url, data={'params': params},
                          headers={'User-Agent': UA_IOS,
                                   'Content-Type': 'application/x-www-form-urlencoded',
                                   'Cookie': ck},
                          timeout=timeout)
        try:
            return r.json()
        except Exception:
            return {'code': r.status_code, 'raw': r.text[:200]}

    def weapi(self, path: str, payload: dict, timeout=12):
        """path 形如 /weapi/xxx。发私信走这个。"""
        payload = dict(payload)
        payload['csrf_token'] = self._csrf()
        body = weapi_encrypt(payload)
        url = 'https://music.163.com' + path
        r = requests.post(url, data=body,
                          headers=self._headers(pc=True, extra_cookie='os=pc'),
                          timeout=timeout)
        try:
            return r.json()
        except Exception:
            return {'code': r.status_code, 'raw': r.text[:200]}

    def _csrf(self):
        for kv in self.store.cookie().split(';'):
            kv = kv.strip()
            if kv.startswith('__csrf='):
                return kv[len('__csrf='):]
        return ''

    # ── 扫码登录 ──────────────────────────────────────────────────────────
    def qr_key(self):
        """第一步：拿一个 unikey。"""
        r = requests.post('https://music.163.com/weapi/login/qrcode/unikey',
                          data=weapi_encrypt({'type': 1}),
                          headers=self._headers(pc=True), timeout=12)
        j = r.json()
        return j.get('unikey', '')

    def qr_img_url(self, unikey):
        return 'https://music.163.com/login?codekey=' + unikey

    def qr_check(self, unikey):
        """轮询扫码状态。800=过期 801=等待扫 802=待确认 803=成功(带cookie)。"""
        r = requests.post('https://music.163.com/weapi/login/qrcode/client/login',
                          data=weapi_encrypt({'key': unikey, 'type': 1}),
                          headers=self._headers(pc=True), timeout=12)
        code = r.json().get('code', 0)
        cookie = ''
        if code == 803:
            # 从 Set-Cookie 拼完整 cookie
            parts = []
            for c in r.raw.headers.getlist('Set-Cookie') if hasattr(r.raw.headers, 'getlist') else r.headers.get('Set-Cookie', '').split(','):
                seg = c.split(';')[0].strip()
                if '=' in seg and any(seg.startswith(k) for k in ('MUSIC_U', 'MUSIC_A', '__csrf', 'NMTID', '__remember_me')):
                    parts.append(seg)
            cookie = '; '.join(parts)
        return code, cookie

    # ── 搜歌 / 取流 / 歌词 ────────────────────────────────────────────────
    def search(self, keyword, limit=20):
        # eapi 带登录态搜索，诊断证明稳定能搜到
        j = self.eapi('/api/cloudsearch/pc',
                      {'s': keyword, 'type': 1, 'limit': limit, 'offset': 0})
        songs = (j.get('result', {}) or {}).get('songs', []) or []
        return self._fmt_songs(songs)

    def _fmt_songs(self, songs, plain=False):
        out = []
        for s in songs:
            if plain:
                # 老接口字段：artists / album
                out.append({
                    'id': s['id'], 'name': s['name'],
                    'artist': ' / '.join(a['name'] for a in s.get('artists', [])),
                    'album': (s.get('album') or {}).get('name', ''),
                    'cover': (s.get('album') or {}).get('picUrl', ''),
                    'duration': s.get('duration', 0),
                })
            else:
                out.append({
                    'id': s['id'], 'name': s['name'],
                    'artist': ' / '.join(a['name'] for a in s.get('ar', [])),
                    'album': (s.get('al') or {}).get('name', ''),
                    'cover': (s.get('al') or {}).get('picUrl', ''),
                    'duration': s.get('dt', 0),
                })
        return out

    def _old_search_removed(self, keyword, limit=20):
        r = requests.post('https://music.163.com/weapi/cloudsearch/get/web',
                          data=weapi_encrypt({'s': keyword, 'type': 1, 'limit': limit, 'offset': 0}),
                          headers=self._headers(pc=True), timeout=12)
        j = r.json()
        out = []
        for s in (j.get('result', {}) or {}).get('songs', []) or []:
            out.append({
                'id': s['id'],
                'name': s['name'],
                'artist': ' / '.join(a['name'] for a in s.get('ar', [])),
                'album': (s.get('al') or {}).get('name', ''),
                'cover': (s.get('al') or {}).get('picUrl', ''),
                'duration': s.get('dt', 0),
            })
        return out

    def song_url(self, song_id, br=320000):
        """取音频直链。用你账号，会员歌也能拿。"""
        j = self.eapi('/api/song/enhance/player/url',
                      {'ids': f'[{song_id}]', 'br': br})
        data = (j.get('data') or [{}])[0]
        return data.get('url', '')

    def song_detail(self, song_id):
        r = requests.post('https://music.163.com/weapi/v3/song/detail',
                          data=weapi_encrypt({'c': json.dumps([{'id': song_id}])}),
                          headers=self._headers(pc=True), timeout=12)
        songs = r.json().get('songs', [])
        if not songs:
            return None
        s = songs[0]
        return {'id': s['id'], 'name': s['name'],
                'artist': ' / '.join(a['name'] for a in s.get('ar', [])),
                'album': (s.get('al') or {}).get('name', ''),
                'cover': (s.get('al') or {}).get('picUrl', ''),
                'duration': s.get('dt', 0)}

    def lyric(self, song_id):
        r = requests.post('https://music.163.com/weapi/song/lyric',
                          data=weapi_encrypt({'id': song_id, 'lv': -1, 'tv': -1}),
                          headers=self._headers(pc=True), timeout=12)
        j = r.json()
        return {'lyric': (j.get('lrc') or {}).get('lyric', ''),
                'tlyric': (j.get('tlyric') or {}).get('lyric', '')}

    def similar(self, song_id):
        """漫游用：拿相似歌。"""
        try:
            j = self.eapi('/api/v1/discovery/simiSong',
                          {'songid': song_id, 'limit': 10, 'offset': 0})
            out = []
            for s in j.get('songs', []) or []:
                out.append({'id': s['id'], 'name': s['name'],
                            'artist': ' / '.join(a['name'] for a in s.get('artists', []))})
            return out
        except Exception:
            return []

    # ── 个人数据（登录后）────────────────────────────────────────────────
    def uid(self):
        """从账号或登录态拿 userId。多路兜底。"""
        acc = self.store.account()
        if acc.get('userId'):
            return acc['userId']
        # 路1: eapi nuser/account
        try:
            j = self.eapi('/api/nuser/account/get', {})
            prof = j.get('profile') or {}
            if prof.get('userId'):
                st = {'userId': str(prof['userId']), 'nickname': prof.get('nickname', ''),
                      'avatarUrl': prof.get('avatarUrl', ''), 'vipType': prof.get('vipType', 0)}
                self.store.save_cred(self.store.cookie(), st)
                return st['userId']
        except Exception:
            pass
        # 路2: weapi login_status
        st = self.login_status()
        if st and st.get('userId'):
            self.store.save_cred(self.store.cookie(), st)
            return st['userId']
        return ''

    def login_status(self):
        """确认当前 cookie 还活着、拿账号信息。eapi 优先。"""
        try:
            j = self.eapi('/api/w/nuser/account/get', {})
            prof = j.get('profile')
            if prof and prof.get('userId'):
                return {'userId': str(prof['userId']), 'nickname': prof.get('nickname', ''),
                        'avatarUrl': prof.get('avatarUrl', ''), 'vipType': prof.get('vipType', 0)}
        except Exception:
            pass
        try:
            r = requests.post('https://music.163.com/weapi/w/nuser/account/get',
                              data=weapi_encrypt({}),
                              headers=self._headers(pc=True), timeout=12)
            j = r.json()
            prof = j.get('profile')
            if prof and prof.get('userId'):
                return {'userId': str(prof['userId']), 'nickname': prof.get('nickname', ''),
                        'avatarUrl': prof.get('avatarUrl', ''), 'vipType': prof.get('vipType', 0)}
        except Exception:
            pass
        return None

    def my_playlists(self):
        """我的歌单列表（自建 + 收藏）。第一个通常是'我喜欢的音乐'。"""
        uid = self.uid()
        if not uid:
            return []
        j = self.eapi('/api/user/playlist', {'uid': uid, 'limit': 100, 'offset': 0})
        out = []
        for p in j.get('playlist', []) or []:
            out.append({
                'id': p['id'], 'name': p['name'],
                'cover': p.get('coverImgUrl', ''),
                'count': p.get('trackCount', 0),
                'is_mine': str(p.get('userId', '')) == str(uid),
                'special': p.get('specialType', 0),  # 5 = 我喜欢的音乐
            })
        return out

    def playlist_songs(self, pid, limit=500):
        """歌单里的所有歌。"""
        j = self.eapi('/api/v6/playlist/detail', {'id': pid, 'n': limit, 's': 0})
        pl = j.get('playlist', {}) or {}
        tracks = pl.get('tracks', []) or []
        # tracks 可能只返回部分，用 trackIds 补全
        ids = [t['id'] for t in (pl.get('trackIds', []) or [])]
        out = self._fmt_songs(tracks)
        if len(out) < len(ids):
            # 剩下的用 song/detail 批量补
            have = {s['id'] for s in out}
            need = [i for i in ids if i not in have][:limit]
            for k in range(0, len(need), 100):
                batch = need[k:k+100]
                jj = self.eapi('/api/v3/song/detail',
                               {'c': json.dumps([{'id': i} for i in batch])})
                out += self._fmt_songs(jj.get('songs', []) or [])
        return {'name': pl.get('name', ''), 'cover': pl.get('coverImgUrl', ''),
                'count': pl.get('trackCount', len(out)), 'songs': out}

    def recent_plays(self, limit=100):
        """最近播放。"""
        try:
            j = self.eapi('/api/play-record/song/list', {'limit': limit})
            out = []
            for r in j.get('data', {}).get('list', []) or j.get('list', []) or []:
                s = r.get('resourceInfo') or r.get('data') or r.get('song') or r
                if s.get('id'):
                    out.append({'id': s['id'], 'name': s.get('name', ''),
                                'artist': ' / '.join(a['name'] for a in (s.get('ar') or s.get('artists') or [])),
                                'cover': (s.get('al') or s.get('album') or {}).get('picUrl', '')})
            return out
        except Exception:
            return []

    def cloud_songs(self, limit=200):
        """音乐云盘。"""
        try:
            j = self.eapi('/api/v1/cloud', {'limit': limit, 'offset': 0})
            out = []
            for r in j.get('data', []) or []:
                sid = r.get('songId') or (r.get('simpleSong') or {}).get('id')
                nm = r.get('songName') or (r.get('simpleSong') or {}).get('name', '')
                ar = r.get('artist') or ' / '.join(a['name'] for a in ((r.get('simpleSong') or {}).get('ar') or []))
                if sid:
                    out.append({'id': sid, 'name': nm, 'artist': ar, 'cover': ''})
            return out
        except Exception:
            return []

    def artist_songs(self, artist_id, limit=50):
        """歌手热门歌。"""
        try:
            j = self.eapi('/api/v1/artist/songs',
                          {'id': artist_id, 'order': 'hot', 'limit': limit, 'offset': 0})
            return self._fmt_songs(j.get('songs', []) or [])
        except Exception:
            return []


# ── 路由注册 ────────────────────────────────────────────────────────────
def register_music(app, data_dir=None, jread=None, jwrite=None,
                   auth_token=None):
    """挂到 app 上。auth_token 用于 MCP 推歌的鉴权（可选）。"""
    from flask import request, jsonify, Response, send_file

    if data_dir is None:
        data_dir = os.environ.get('DATA_DIR') or os.path.join(os.path.dirname(__file__), 'data')
    if jread is None:
        def jread(p, d):
            try:
                with open(p, encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                return d
    if jwrite is None:
        def jwrite(p, o):
            with open(p, 'w', encoding='utf-8') as f:
                json.dump(o, f, ensure_ascii=False)

    store = MusicStore(data_dir, jread, jwrite)
    nc = NeteaseClient(store)

    def _need_crypto():
        if not _HAS_CRYPTO:
            return jsonify({'ok': False, 'error': '服务器缺 pycryptodome，装一下：pip install pycryptodome'}), 500
        return None

    # ── 扫码登录 ──────────────────────────────────────────────────────────
    @app.route('/api/music/qr/new', methods=['POST'])
    def music_qr_new():
        err = _need_crypto()
        if err:
            return err
        try:
            unikey = nc.qr_key()
            if not unikey:
                return jsonify({'ok': False, 'error': '拿二维码失败'})
            return jsonify({'ok': True, 'unikey': unikey,
                            'qr_url': nc.qr_img_url(unikey)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:120]})

    @app.route('/api/music/qr/check', methods=['POST'])
    def music_qr_check():
        err = _need_crypto()
        if err:
            return err
        unikey = (request.json or {}).get('unikey', '')
        if not unikey:
            return jsonify({'ok': False, 'error': '缺 unikey'})
        try:
            code, cookie = nc.qr_check(unikey)
            if code == 803 and cookie:
                store.save_cred(cookie, {})
                acc = nc.login_status()
                if acc:
                    store.save_cred(cookie, acc)
                return jsonify({'ok': True, 'code': 803, 'account': acc or {}})
            return jsonify({'ok': True, 'code': code})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:120]})

    @app.route('/api/music/account', methods=['GET'])
    def music_account():
        acc = store.account()
        if acc and acc.get('userId'):
            return jsonify({'ok': True, 'logged_in': True, 'account': acc})
        return jsonify({'ok': True, 'logged_in': False})

    @app.route('/api/music/diag', methods=['GET'])
    def music_diag():
        """诊断：cookie 读到没、登录态、各接口原始返回。"""
        out = {'has_crypto': _HAS_CRYPTO}
        ck = store.cookie()
        out['cookie_len'] = len(ck)
        out['cookie_has_music_u'] = 'MUSIC_U=' in ck
        out['cookie_has_csrf'] = '__csrf=' in ck
        out['csrf_value'] = nc._csrf()[:8] + '...' if nc._csrf() else ''
        # 试登录态
        try:
            acc = nc.login_status()
            out['login_status'] = acc or 'None'
        except Exception as e:
            out['login_status_error'] = str(e)[:150]
        # 试 eapi 搜索
        try:
            j = nc.eapi('/api/cloudsearch/pc',
                        {'s': '晴天', 'type': 1, 'limit': 3, 'offset': 0})
            out['eapi_search_code'] = j.get('code')
            out['eapi_search_count'] = len((j.get('result', {}) or {}).get('songs', []) or [])
            out['eapi_raw_keys'] = list(j.keys())[:6]
        except Exception as e:
            out['eapi_search_error'] = str(e)[:150]
        # 试公开搜索
        try:
            r = requests.get('https://music.163.com/api/search/get/web',
                             params={'s': '晴天', 'type': 1, 'limit': 3},
                             headers={'User-Agent': UA_PC, 'Referer': 'https://music.163.com'},
                             timeout=12)
            jj = r.json()
            out['public_search_code'] = jj.get('code')
            out['public_search_count'] = len((jj.get('result', {}) or {}).get('songs', []) or [])
        except Exception as e:
            out['public_search_error'] = str(e)[:150]
        # 试取音频流
        try:
            hits = nc.search('晴天 周杰伦', 1)
            if hits:
                sid = hits[0]['id']
                url = nc.song_url(sid)
                out['stream_test_song'] = hits[0]['name']
                out['stream_test_has_url'] = bool(url)
                out['stream_test_url_head'] = (url or '')[:60]
            else:
                out['stream_test'] = '搜索无结果'
        except Exception as e:
            out['stream_test_error'] = str(e)[:150]
        return jsonify(out)

    @app.route('/api/music/logout', methods=['POST'])
    def music_logout():
        store.clear_cred()
        return jsonify({'ok': True})

    # ── 个人数据路由 ──────────────────────────────────────────────────────
    @app.route('/api/music/my/playlists', methods=['GET'])
    def music_my_playlists():
        try:
            return jsonify({'ok': True, 'playlists': nc.my_playlists()})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/playlist', methods=['GET'])
    def music_playlist():
        pid = request.args.get('id', '')
        if not pid:
            return jsonify({'ok': False, 'error': '缺 id'})
        try:
            return jsonify({'ok': True, **nc.playlist_songs(pid)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/my/recent', methods=['GET'])
    def music_my_recent():
        try:
            return jsonify({'ok': True, 'songs': nc.recent_plays()})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/my/cloud', methods=['GET'])
    def music_my_cloud():
        try:
            return jsonify({'ok': True, 'songs': nc.cloud_songs()})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/artist', methods=['GET'])
    def music_artist():
        aid = request.args.get('id', '')
        if not aid:
            return jsonify({'ok': False, 'error': '缺 id'})
        try:
            return jsonify({'ok': True, 'songs': nc.artist_songs(aid)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/diag2', methods=['GET'])
    def music_diag2():
        """诊断个人数据能不能取到。"""
        out = {}
        # 直接看几个身份接口的原始返回
        try:
            j = nc.eapi('/api/nuser/account/get', {})
            out['eapi_account_code'] = j.get('code')
            out['eapi_account_has_profile'] = bool(j.get('profile'))
            out['eapi_account_uid'] = (j.get('profile') or {}).get('userId', '')
            out['eapi_account_keys'] = list(j.keys())[:8]
        except Exception as e:
            out['eapi_account_error'] = str(e)[:150]
        try:
            r = requests.post('https://music.163.com/weapi/w/nuser/account/get',
                              data=weapi_encrypt({}), headers=nc._headers(pc=True), timeout=12)
            j = r.json()
            out['weapi_account_code'] = j.get('code')
            out['weapi_account_uid'] = (j.get('profile') or {}).get('userId', '')
        except Exception as e:
            out['weapi_account_error'] = str(e)[:150]
        try:
            out['uid'] = nc.uid()
        except Exception as e:
            out['uid_error'] = str(e)[:120]
        try:
            pls = nc.my_playlists()
            out['playlists_count'] = len(pls)
            out['playlists_head'] = [p['name'] for p in pls[:5]]
        except Exception as e:
            out['playlists_error'] = str(e)[:150]
        return jsonify(out)
        err = _need_crypto()
        if err:
            return err
        q = request.args.get('q', '').strip()
        if not q:
            return jsonify({'ok': False, 'error': '空搜索'})
        try:
            return jsonify({'ok': True, 'songs': nc.search(q, int(request.args.get('limit', 20)))})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:120]})

    @app.route('/api/music/url', methods=['GET'])
    def music_url():
        """返回音频直链。前端 <audio> 直接用网易云直链（不走代理，更稳）。"""
        err = _need_crypto()
        if err:
            return err
        sid = request.args.get('id', '')
        if not sid:
            return jsonify({'ok': False, 'error': '缺 id'})
        try:
            url = nc.song_url(sid, int(request.args.get('br', 320000)))
            if not url:
                return jsonify({'ok': False, 'error': '拿不到音频，可能要会员或版权受限'})
            # 直接给网易云直链，让浏览器自己放（http 的话换 https）
            if url.startswith('http://'):
                url = 'https://' + url[len('http://'):]
            return jsonify({'ok': True, 'url': url, 'direct': url})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/stream', methods=['GET'])
    def music_stream():
        """缓存代理：第一次去网易云下，之后走本地缓存。"""
        err = _need_crypto()
        if err:
            return err
        sid = request.args.get('id', '')
        cache = os.path.join(store.cache_dir, f'{sid}.mp3')
        if not (os.path.exists(cache) and os.path.getsize(cache) > 1000):
            try:
                url = nc.song_url(sid)
                if not url:
                    return jsonify({'ok': False, 'error': '无音源'}), 404
                r = requests.get(url, headers={'User-Agent': UA_IOS}, timeout=30, stream=True)
                with open(cache, 'wb') as f:
                    for chunk in r.iter_content(8192):
                        f.write(chunk)
            except Exception as e:
                return jsonify({'ok': False, 'error': str(e)[:120]}), 500
        return send_file(cache, mimetype='audio/mpeg', conditional=True)

    @app.route('/api/music/lyric', methods=['GET'])
    def music_lyric():
        err = _need_crypto()
        if err:
            return err
        sid = request.args.get('id', '')
        try:
            return jsonify({'ok': True, **nc.lyric(sid)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:120]})

    # ── 推歌队列（凛/claude.ai 推 → 前端轮询播）──────────────────────────
    def _check_token():
        if not auth_token:
            return True
        t = request.headers.get('X-Chat-Token') or request.args.get('token', '')
        return t == auth_token

    @app.route('/api/music/remote', methods=['GET'])
    def music_remote_get():
        """前端每几秒轮询：看有没有新指令。"""
        return jsonify({'ok': True, 'command': store.latest_command()})

    @app.route('/api/music/remote', methods=['POST'])
    def music_remote_post():
        """推一首歌 / 切歌 / 停。凛前端 or claude.ai MCP 都调这个。
        body: {action:'play'|'stop', query?, id?, title?, sleep_minutes?}"""
        if not _check_token():
            return jsonify({'ok': False, 'error': '鉴权失败'}), 403
        b = request.json or {}
        action = b.get('action', 'play')
        if action == 'stop':
            cmd = store.push_command({'action': 'stop'})
            return jsonify({'ok': True, 'command': cmd})
        # play：给了 id 直接播；给了 query 就先搜再播最佳
        song = None
        if b.get('id'):
            song = nc.song_detail(b['id'])
        elif b.get('query'):
            hits = nc.search(b['query'], 5)
            song = hits[0] if hits else None
        if not song:
            return jsonify({'ok': False, 'error': '没找到歌'})
        cmd = store.push_command({
            'action': 'play', 'id': song['id'], 'name': song['name'],
            'artist': song['artist'], 'cover': song.get('cover', ''),
            'sleep_minutes': b.get('sleep_minutes', 0),
        })
        return jsonify({'ok': True, 'command': cmd, 'song': song})

    return store, nc
