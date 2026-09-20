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
from concurrent.futures import ThreadPoolExecutor
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


# ── 小工具 ──────────────────────────────────────────────────────────────
def _join_artists(arr) -> str:
    """拼歌手名。歌手名可能是 None / 字段缺失（下架歌、云盘歌常见），
    直接 ' / '.join 会炸 TypeError: sequence item 0: expected str instance, NoneType found。"""
    names = []
    for a in (arr or []):
        if isinstance(a, dict):
            n = a.get('name') or a.get('nickname') or ''
        else:
            n = a or ''
        n = str(n).strip()
        if n:
            names.append(n)
    return ' / '.join(names) if names else '未知歌手'


def _safe_str(v, default='') -> str:
    return str(v) if v not in (None, '') else default


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
        # 连接池：每次请求重新建 TLS 连接要几百毫秒，复用之后快很多
        self.sess = requests.Session()
        try:
            from requests.adapters import HTTPAdapter
            ad = HTTPAdapter(pool_connections=8, pool_maxsize=24, max_retries=0)
            self.sess.mount('https://', ad)
            self.sess.mount('http://', ad)
        except Exception:
            pass
        self._url_cache = {}      # {song_id: (到期时间, url)}
        self._url_quality = {}    # {song_id: {level, br, type}} 真实音质
        self._lyric_cache = {}    # {song_id: 歌词} —— 歌词不会变，存着就行
        self._artist_cache = {}   # {key: (到期时间, 数据)}
        self._pls_cache = None    # (时间, 歌单列表)
        self._rank_cache = {}     # {period: (时间, 数据)}
        self._listen_total = None # (时间, 累计听歌数)
        self._last_recent_err = ''
        self._last_cloud_err = ''
        self._last_rank_err = ''
        self._last_liked_err = ''
        self._liked_cache = None      # (时间, ids)
        self._liked_ttl = 300
        self._uid_cache = ''
        self._pl_cache = {}          # {pid: {'ts':.., 'count':.., 'data':{...}}}
        self._pl_ids = {}            # {pid: (时间, 完整 trackIds)}
        self._pl_cache_ttl = 600     # 歌单缓存 10 分钟，第二次点进去秒开
        self._pl_lock = threading.Lock()

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

    def eapi(self, path: str, payload: dict, timeout=9):
        """path 形如 /api/xxx。自动换成 /eapi/ 发出去。写操作 body 要带 header:{}。"""
        payload = dict(payload)
        payload.setdefault('header', '{}')
        text = json.dumps(payload, separators=(',', ':'))
        params = eapi_encrypt(path, text)
        url = 'https://interface.music.163.com/eapi/' + path[len('/api/'):]
        ck = (DEVICE_INFO + '; ' + self.store.cookie()).strip('; ')
        r = self.sess.post(url, data={'params': params},
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
        r = self.sess.post(url, data=body,
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
        for s in (songs or []):
            if not isinstance(s, dict) or not s.get('id'):
                continue
            if plain:
                # 老接口字段：artists / album
                arl = s.get('artists') or []
                out.append({
                    'id': s['id'], 'name': _safe_str(s.get('name'), '未知歌曲'),
                    'artist': _join_artists(arl),
                    'artist_id': (arl[0] or {}).get('id') if arl else None,
                    'album': _safe_str((s.get('album') or {}).get('name')),
                    'cover': _safe_str((s.get('album') or {}).get('picUrl')),
                    'duration': s.get('duration') or 0,
                })
            else:
                arl = s.get('ar') or []
                out.append({
                    'id': s['id'], 'name': _safe_str(s.get('name'), '未知歌曲'),
                    'artist': _join_artists(arl),
                    'artist_id': (arl[0] or {}).get('id') if arl else None,
                    'album': _safe_str((s.get('al') or {}).get('name')),
                    'cover': _safe_str((s.get('al') or {}).get('picUrl')),
                    'duration': s.get('dt') or 0,
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
                'artist': _join_artists(s.get('ar')),
                'album': (s.get('al') or {}).get('name', ''),
                'cover': (s.get('al') or {}).get('picUrl', ''),
                'duration': s.get('dt', 0),
            })
        return out

    def song_url(self, song_id, br=320000, mp3_only=False):
        """取音频直链。用你账号，会员歌也能拿。

        云盘里自己上传的歌，老接口(player/url)经常返回空，得走 v1 接口按音质档取。
        这里依次试几条路，哪条出链接用哪条，所以云盘歌不用你一首首手动试。
        """
        key = str(song_id) + ('#mp3' if mp3_only else '')
        c = self._url_cache.get(key)
        now = time.time()
        if c and c[0] > now:
            return c[1]
        if mp3_only:
            # HLS 那条流专用：只要 mp3。
            # 母带/无损是 FLAC，一首几十 MB，顺着流预读根本跟不上，会一卡一卡；
            # 而且 FLAC 不在 HLS 允许的片段格式里，Safari 解码也会出问题。
            tries = [
                ('/api/song/enhance/player/url', {'ids': f'[{song_id}]', 'br': 320000}),
                ('/api/song/enhance/player/url/v1',
                 {'ids': f'[{song_id}]', 'level': 'exhigh', 'encodeType': 'mp3'}),
                ('/api/song/enhance/player/url', {'ids': f'[{song_id}]', 'br': 192000}),
                ('/api/song/enhance/player/url', {'ids': f'[{song_id}]', 'br': 128000}),
                ('/api/song/enhance/download/url', {'id': song_id, 'br': 320000}),
            ]
        else:
         tries = [
            # 你是 SVIP，先要母带/无损，拿不到再一级级降
            ('/api/song/enhance/player/url/v1',
             {'ids': f'[{song_id}]', 'level': 'jymaster', 'encodeType': 'flac'}),
            ('/api/song/enhance/player/url/v1',
             {'ids': f'[{song_id}]', 'level': 'lossless', 'encodeType': 'flac'}),
            ('/api/song/enhance/player/url', {'ids': f'[{song_id}]', 'br': br}),
            ('/api/song/enhance/player/url/v1',
             {'ids': f'[{song_id}]', 'level': 'exhigh', 'encodeType': 'aac'}),
            ('/api/song/enhance/player/url/v1',
             {'ids': f'[{song_id}]', 'level': 'standard', 'encodeType': 'aac'}),
            ('/api/song/enhance/player/url', {'ids': f'[{song_id}]', 'br': 128000}),
            # 下面两条是云盘/下架歌的救命路：直接要自己账号里那份文件，绕开曲库
            ('/api/song/enhance/download/url', {'id': song_id, 'br': br}),
            ('/api/song/enhance/download/url/v1', {'id': song_id, 'level': 'exhigh'}),
         ]
        for path, payload in tries:
            try:
                j = self.eapi(path, payload)
                d = j.get('data')
                if isinstance(d, list) and d and isinstance(d[0], dict):
                    d = d[0]
                if isinstance(d, dict):
                    u = d.get('url') or ''
                    if u:
                        # 顺便记下真实音质，界面别再写死"无损"
                        self._url_quality[key] = {
                            'level': d.get('level') or '', 'br': d.get('br') or 0,
                            'type': (d.get('type') or '').lower(), 'size': d.get('size') or 0}
                        # 网易云直链大约 20 分钟有效，缓存 10 分钟够用
                        self._url_cache[key] = (now + 600, u)
                        if len(self._url_cache) > 400:
                            self._url_cache.clear()
                        return u
            except Exception:
                continue
        return ''

    def song_detail(self, song_id):
        r = requests.post('https://music.163.com/weapi/v3/song/detail',
                          data=weapi_encrypt({'c': json.dumps([{'id': song_id}])}),
                          headers=self._headers(pc=True), timeout=12)
        songs = r.json().get('songs', [])
        if not songs:
            return None
        s = songs[0]
        return {'id': s['id'], 'name': _safe_str(s.get('name'), '未知歌曲'),
                'artist': _join_artists(s.get('ar')),
                'album': _safe_str((s.get('al') or {}).get('name')),
                'cover': _safe_str((s.get('al') or {}).get('picUrl')),
                'duration': s.get('dt') or 0}

    def lyric(self, song_id):
        c = self._lyric_cache.get(str(song_id))
        if c is not None:
            return c
        r = requests.post('https://music.163.com/weapi/song/lyric',
                          data=weapi_encrypt({'id': song_id, 'lv': -1, 'tv': -1}),
                          headers=self._headers(pc=True), timeout=12)
        j = r.json()
        out = {'lyric': (j.get('lrc') or {}).get('lyric', ''),
               'tlyric': (j.get('tlyric') or {}).get('lyric', '')}
        if out['lyric']:
            if len(self._lyric_cache) > 300:
                self._lyric_cache.clear()
            self._lyric_cache[str(song_id)] = out
        return out

    def similar(self, song_id):
        """漫游用：拿相似歌。"""
        try:
            j = self.eapi('/api/v1/discovery/simiSong',
                          {'songid': song_id, 'limit': 10, 'offset': 0})
            out = []
            for s in j.get('songs', []) or []:
                out.append({'id': s['id'], 'name': s['name'],
                            'artist': _join_artists(s.get('artists'))})
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

    def my_playlists(self, use_cache=True):
        """我的歌单列表（自建 + 收藏）。第一个通常是'我喜欢的音乐'。
        加了 3 分钟缓存：每次打开"我的"都现查一遍网易云，就是那个空白等待。"""
        if use_cache and self._pls_cache and (time.time() - self._pls_cache[0]) < 180:
            return self._pls_cache[1]
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
        if out:
            self._pls_cache = (time.time(), out)
        return out

    def playlist_head(self, pid, first=200):
        """歌单第一屏：只取前 first 首，顺便把完整曲目表(trackIds)记下来。
        以前一次性把两千多首全取完才返回，所以打开要等半天。"""
        pid = str(pid)
        j = self.eapi('/api/v6/playlist/detail', {'id': pid, 'n': first, 's': 0}, timeout=20)
        pl = j.get('playlist', {}) or {}
        ids = []
        for t in (pl.get('trackIds', []) or []):
            tid = t.get('id') if isinstance(t, dict) else t
            if tid:
                ids.append(tid)
        songs = self._fmt_songs(pl.get('tracks', []) or [])
        with self._pl_lock:
            self._pl_ids[pid] = (time.time(), ids)
            if len(self._pl_ids) > 12:
                oldest = min(self._pl_ids, key=lambda k: self._pl_ids[k][0])
                self._pl_ids.pop(oldest, None)
        return {'name': pl.get('name', ''), 'cover': pl.get('coverImgUrl', ''),
                'count': pl.get('trackCount', len(ids) or len(songs)),
                'songs': songs, 'total': len(ids) or len(songs)}

    def playlist_page(self, pid, offset=0, limit=300):
        """歌单的第 N 段。用记下来的 trackIds 并发取详情。"""
        pid = str(pid)
        c = self._pl_ids.get(pid)
        if not c or (time.time() - c[0]) > 1800:
            self.playlist_head(pid, first=1)
            c = self._pl_ids.get(pid)
        ids = (c[1] if c else [])[int(offset):int(offset) + int(limit)]
        if not ids:
            return {'songs': [], 'offset': offset, 'done': True,
                    'total': len(c[1]) if c else 0}
        batches = [ids[k:k + 300] for k in range(0, len(ids), 300)]
        got = {}
        with ThreadPoolExecutor(max_workers=min(6, len(batches))) as ex:
            for part in ex.map(self._song_detail_batch, batches):
                for x in part:
                    got[x['id']] = x
        out = [got[i] for i in ids if i in got]
        total = len(c[1]) if c else len(out)
        return {'songs': out, 'offset': offset, 'total': total,
                'done': (int(offset) + int(limit)) >= total}

    def _song_detail_batch(self, ids):
        """一批 id 换详情。失败返回空，不影响别的批。"""
        try:
            jj = self.eapi('/api/v3/song/detail',
                           {'c': json.dumps([{'id': i} for i in ids])},
                           timeout=20)
            return self._fmt_songs(jj.get('songs', []) or [])
        except Exception:
            return []

    def playlist_songs(self, pid, limit=10000, use_cache=True):
        """歌单里的所有歌。

        以前的写法有两个坑：
          · n=500 只拿 500 首，补全又只补 limit(=500) 首 → 2000+ 首的歌单永远只出 1000 首
          · 补全是一批批串行发请求，2000 首要发 20 次，所以打开要等半天
        现在：trackIds 拿全 → 缺的按 300 一批**并发**取 → 按原顺序拼回来 → 结果缓存 10 分钟
        """
        pid = str(pid)
        now = time.time()
        if use_cache:
            c = self._pl_cache.get(pid)
            if c and now - c['ts'] < self._pl_cache_ttl:
                return c['data']

        j = self.eapi('/api/v6/playlist/detail', {'id': pid, 'n': 1000, 's': 0}, timeout=25)
        pl = j.get('playlist', {}) or {}
        tracks = pl.get('tracks', []) or []

        # trackIds 才是完整曲目表（tracks 只有前一部分）
        ids = []
        for t in (pl.get('trackIds', []) or []):
            tid = t.get('id') if isinstance(t, dict) else t
            if tid:
                ids.append(tid)

        got = {}
        for s in self._fmt_songs(tracks):
            got[s['id']] = s

        need = [i for i in ids if i not in got][:limit]
        if need:
            batches = [need[k:k + 300] for k in range(0, len(need), 300)]
            # 最多 8 条线并发，2000 多首也就一两秒
            with ThreadPoolExecutor(max_workers=min(8, len(batches))) as ex:
                for part in ex.map(self._song_detail_batch, batches):
                    for s in part:
                        got[s['id']] = s

        # 按歌单原顺序拼回来
        if ids:
            out = [got[i] for i in ids if i in got]
        else:
            out = list(got.values())

        data = {'name': pl.get('name', ''), 'cover': pl.get('coverImgUrl', ''),
                'count': pl.get('trackCount', len(out)), 'songs': out,
                'total': len(out)}
        with self._pl_lock:
            self._pl_cache[pid] = {'ts': now, 'count': data['count'], 'data': data}
            # 缓存别无限涨
            if len(self._pl_cache) > 12:
                oldest = min(self._pl_cache, key=lambda k: self._pl_cache[k]['ts'])
                self._pl_cache.pop(oldest, None)
        return data

    def _pick_records(self, j):
        """从各种形状的返回里把播放记录列表抠出来。"""
        if not isinstance(j, dict):
            return []
        data = j.get('data')
        for cand in (j.get('allData'), j.get('weekData'),
                     (data or {}).get('list') if isinstance(data, dict) else None,
                     (data or {}).get('allData') if isinstance(data, dict) else None,
                     data if isinstance(data, list) else None,
                     j.get('list'), j.get('records')):
            if isinstance(cand, list) and cand:
                return cand
        return []

    def recent_plays(self, limit=100):
        """最近播放（按时间倒序的播放历史）。

        注意：/api/v1/play/record 是**听歌排行**（带播放次数），不是最近播放，
        以前这里用错了接口，所以"最近播放"出来的是排行。真正的最近播放走 play-record/song/list。
        """
        tries = [
            ('/api/play-record/song/list', {'limit': limit, 'offset': 0, 'total': True}),
            ('/api/play-record/song/list', {'limit': limit, 'cursor': ''}),
            ('/api/play-record/song/list', {'limit': limit}),
        ]
        last_err = ''
        for path, payload in tries:
            try:
                j = self.eapi(path, payload)
                recs = self._pick_records(j)
                out = []
                for r in recs:
                    if not isinstance(r, dict):
                        continue
                    s = (r.get('data') or r.get('resourceInfo') or r.get('song')
                         or r.get('simpleSong') or r)
                    if not isinstance(s, dict) or not s.get('id'):
                        continue
                    out.append({
                        'id': s['id'],
                        'name': _safe_str(s.get('name'), '未知歌曲'),
                        'artist': _join_artists(s.get('ar') or s.get('artists')),
                        'album': _safe_str((s.get('al') or s.get('album') or {}).get('name')),
                        'cover': _safe_str((s.get('al') or s.get('album') or {}).get('picUrl')),
                        'duration': s.get('dt') or s.get('duration') or 0,
                    })
                if out:
                    return out
                last_err = f'{path} 返回 code={j.get("code")} 无记录'
            except Exception as e:
                last_err = f'{path}: {str(e)[:80]}'
        self._last_recent_err = last_err
        return []

    def play_rank(self, period='week', limit=100):
        """听歌排行。period='week' 最近一周 / 'all' 所有时间。带播放次数。缓存 5 分钟。"""
        c = self._rank_cache.get(period)
        if c and (time.time() - c[0]) < 300:
            return c[1]
        uid = self.uid()
        if not uid:
            self._last_rank_err = '拿不到 uid'
            return []
        t = 1 if period == 'week' else 0
        try:
            j = self.eapi('/api/v1/play/record',
                          {'uid': uid, 'type': t, 'limit': limit, 'offset': 0})
        except Exception as e:
            self._last_rank_err = str(e)[:100]
            return []
        rows = j.get('weekData') if t == 1 else j.get('allData')
        if not isinstance(rows, list):
            rows = j.get('allData') or j.get('weekData') or []
        out = []
        for r in (rows or []):
            if not isinstance(r, dict):
                continue
            s = r.get('song') or r.get('simpleSong') or {}
            if not isinstance(s, dict) or not s.get('id'):
                continue
            out.append({
                'id': s['id'],
                'name': _safe_str(s.get('name'), '未知歌曲'),
                'artist': _join_artists(s.get('ar') or s.get('artists')),
                'album': _safe_str((s.get('al') or {}).get('name')),
                'cover': _safe_str((s.get('al') or {}).get('picUrl')),
                'duration': s.get('dt') or 0,
                'play_count': r.get('playCount') or 0,
                'score': r.get('score') or 0,
            })
        if not out:
            self._last_rank_err = f'play/record type={t} code={j.get("code")} 无数据'
        else:
            self._rank_cache[period] = (time.time(), out)
        return out

    def listen_songs_total(self):
        """累计听歌总数（个人页那个"累计听歌 XXXXX 首"）。缓存 10 分钟。"""
        if self._listen_total and (time.time() - self._listen_total[0]) < 600:
            return self._listen_total[1]
        uid = self.uid()
        if not uid:
            return 0
        for path in ('/api/v1/user/detail', '/api/v1/user/detail/' + str(uid)):
            try:
                j = self.eapi(path, {'uid': uid})
                n = j.get('listenSongs')
                if not n:
                    n = (j.get('profile') or {}).get('listenSongs')
                if n:
                    self._listen_total = (time.time(), n)
                    return n
            except Exception:
                continue
        return 0

    def cloud_songs(self, limit=200):
        """音乐云盘。老路径 /api/v1/cloud 现在多半不出货，优先 /api/v1/cloud/get。"""
        last_err = ''
        for path in ('/api/v1/cloud/get', '/api/v1/cloud', '/api/cloud/get'):
            try:
                j = self.eapi(path, {'limit': limit, 'offset': 0})
                rows = j.get('data')
                if isinstance(rows, dict):
                    rows = rows.get('data') or rows.get('list') or []
                out = []
                for r in (rows or []):
                    if not isinstance(r, dict):
                        continue
                    simple = r.get('simpleSong') or {}
                    sid = r.get('songId') or simple.get('id')
                    if not sid:
                        continue
                    nm = r.get('songName') or simple.get('name') or r.get('fileName') or '未知歌曲'
                    ar = r.get('artist') or _join_artists(simple.get('ar'))
                    if not str(ar).strip():
                        ar = '未知歌手'
                    al = r.get('album') or _safe_str((simple.get('al') or {}).get('name'))
                    out.append({
                        'id': sid,
                        'name': _safe_str(nm, '未知歌曲'),
                        'artist': _safe_str(ar, '未知歌手'),
                        'album': _safe_str(al),
                        'cover': _safe_str((simple.get('al') or {}).get('picUrl')),
                        'duration': simple.get('dt') or 0,
                    })
                if out:
                    return out
                last_err = f'{path} 返回 code={j.get("code")} 无数据'
            except Exception as e:
                last_err = f'{path}: {str(e)[:80]}'
        self._last_cloud_err = last_err
        return []

    def find_artist(self, name):
        """按名字找歌手，返回 {id, name, cover, song_count}。type=100 是搜歌手。"""
        try:
            j = self.eapi('/api/cloudsearch/pc',
                          {'s': name, 'type': 100, 'limit': 5, 'offset': 0})
            arts = ((j.get('result') or {}).get('artists')
                    or (j.get('result') or {}).get('artist') or [])
            for a in arts:
                if not a.get('id'):
                    continue
                return {'id': a['id'], 'name': _safe_str(a.get('name')),
                        'cover': _safe_str(a.get('picUrl') or a.get('img1v1Url')),
                        'song_count': a.get('musicSize') or a.get('albumSize') or 0}
        except Exception:
            pass
        return None

    def artist_info(self, artist_id):
        """歌手资料（名字、头像、歌曲数）。"""
        try:
            j = self.eapi('/api/v1/artist/introduction', {'id': artist_id})
            a = j.get('artist') or {}
            if a.get('name'):
                return {'id': artist_id, 'name': _safe_str(a.get('name')),
                        'cover': _safe_str(a.get('picUrl') or a.get('img1v1Url')),
                        'song_count': a.get('musicSize') or 0}
        except Exception:
            pass
        try:
            j = self.eapi('/api/v1/artist/%s' % artist_id, {'id': artist_id})
            a = j.get('artist') or {}
            return {'id': artist_id, 'name': _safe_str(a.get('name')),
                    'cover': _safe_str(a.get('picUrl') or a.get('img1v1Url')),
                    'song_count': a.get('musicSize') or 0}
        except Exception:
            return {'id': artist_id, 'name': '', 'cover': '', 'song_count': 0}

    def artist_albums(self, artist_id, limit=60):
        """歌手的专辑。"""
        try:
            j = self.eapi('/api/artist/albums',
                          {'id': artist_id, 'limit': limit, 'offset': 0})
            out = []
            for a in (j.get('hotAlbums') or []):
                if not a.get('id'):
                    continue
                t = a.get('publishTime') or 0
                year = ''
                try:
                    if t:
                        year = time.strftime('%Y', time.localtime(t / 1000))
                except Exception:
                    year = ''
                out.append({'id': a['id'], 'name': _safe_str(a.get('name'), '未知专辑'),
                            'cover': _safe_str(a.get('picUrl')),
                            'size': a.get('size') or 0, 'year': year})
            return out
        except Exception:
            return []

    def album_songs(self, album_id):
        """专辑里的歌。"""
        try:
            j = self.eapi('/api/v1/album/%s' % album_id, {'id': album_id})
            al = j.get('album') or {}
            return {'name': _safe_str(al.get('name')), 'cover': _safe_str(al.get('picUrl')),
                    'songs': self._fmt_songs(j.get('songs') or [])}
        except Exception as e:
            return {'name': '', 'cover': '', 'songs': [], 'error': str(e)[:100]}

    def artist_songs(self, artist_id, limit=50, order='hot'):
        """这个歌手名下的歌（真·歌手主页，不是关键词搜索的近似结果）。"""
        tries = [
            ('/api/v1/artist/songs',
             {'id': artist_id, 'order': order, 'limit': limit, 'offset': 0,
              'private_cloud': 'true', 'work_type': 1}),
            ('/api/v1/artist/%s' % artist_id, {'id': artist_id}),   # 兜底：热门50首
        ]
        for path, payload in tries:
            try:
                j = self.eapi(path, payload)
                songs = j.get('songs') or j.get('hotSongs') or []
                out = self._fmt_songs(songs)
                if out:
                    return out
            except Exception:
                continue
        return []

    def liked_ids(self):
        """我红心过的所有歌曲ID（用于判断某首是否已红心）。

        song/like/get 有时候返回空，这时候直接去"我喜欢的音乐"歌单把 trackIds 拿回来兜底。
        结果缓存 5 分钟：不缓存的话每放一首歌都要翻一遍两千多首的歌单，把后端堵死。
        """
        c = self._liked_cache
        if c and (time.time() - c[0]) < self._liked_ttl:
            return c[1]
        ids = self._liked_ids_fetch()
        # 空结果也缓存（缓存短一点），避免失败时被反复重试打爆
        self._liked_cache = (time.time() if ids else time.time() - self._liked_ttl + 60, ids)
        return ids

    def _liked_ids_fetch(self):
        uid = self.uid()
        if not uid:
            self._last_liked_err = '拿不到 uid'
            return []
        try:
            j = self.eapi('/api/song/like/get', {'uid': uid})
            ids = j.get('ids') or []
            if ids:
                return ids
            self._last_liked_err = 'song/like/get code=%s 空' % j.get('code')
        except Exception as e:
            self._last_liked_err = 'song/like/get: ' + str(e)[:80]
        # 兜底：红心歌单(specialType=5，通常是第一个)的 trackIds
        try:
            pls = self.my_playlists()
            liked = None
            for p in pls:
                if p.get('special') == 5:
                    liked = p
                    break
            if not liked and pls:
                liked = pls[0]
            if liked:
                j = self.eapi('/api/v6/playlist/detail',
                              {'id': liked['id'], 'n': 1, 's': 0}, timeout=25)
                pl = j.get('playlist', {}) or {}
                out = []
                for t in (pl.get('trackIds', []) or []):
                    tid = t.get('id') if isinstance(t, dict) else t
                    if tid:
                        out.append(tid)
                if out:
                    self._last_liked_err = ''
                    return out
                self._last_liked_err = '红心歌单 trackIds 为空'
        except Exception as e:
            self._last_liked_err = '红心歌单兜底: ' + str(e)[:80]
        return []

    def scrobble(self, song_id, seconds=0, source_id=''):
        """上报"这首听完了"。不报的话听歌排行/累计听歌/最近播放都不会涨。"""
        try:
            logs = json.dumps([{
                'action': 'play',
                'json': {'download': 0, 'end': 'playend', 'id': int(song_id),
                         'sourceId': str(source_id or ''), 'time': int(seconds or 0),
                         'type': 'song', 'wifi': 0, 'source': 'list'},
            }], separators=(',', ':'))
            j = self.eapi('/api/feedback/weblog', {'logs': logs})
            return j.get('code') == 200
        except Exception:
            return False

    def set_like(self, song_id, like=True):
        """红心 / 取消红心。"""
        try:
            j = self.eapi('/api/song/like',
                          {'trackId': song_id, 'like': 'true' if like else 'false'})
            ok = j.get('code') == 200
            if ok and self._liked_cache:
                # 本地缓存跟着改，不用重新拉一遍
                ids = list(self._liked_cache[1])
                sid = int(song_id) if str(song_id).isdigit() else song_id
                if like and sid not in ids:
                    ids.append(sid)
                elif not like and sid in ids:
                    ids.remove(sid)
                self._liked_cache = (self._liked_cache[0], ids)
            return ok
        except Exception:
            return False

    def create_playlist(self, name, private=False):
        """新建歌单，返回歌单id。"""
        try:
            j = self.weapi('/api/playlist/create',
                           {'name': name, 'privacy': '10' if private else '0'})
            pl = j.get('playlist') or {}
            return {'ok': j.get('code') == 200, 'id': pl.get('id'), 'name': pl.get('name')}
        except Exception as e:
            return {'ok': False, 'error': str(e)[:120]}

    def playlist_tracks(self, playlist_id, track_ids, add=True):
        """往歌单加歌/删歌。track_ids 可为单个或列表。"""
        try:
            if not isinstance(track_ids, list):
                track_ids = [track_ids]
            ids_json = json.dumps([str(t) for t in track_ids])
            j = self.weapi('/api/playlist/manipulate/tracks', {
                'op': 'add' if add else 'del',
                'pid': str(playlist_id),
                'trackIds': ids_json,
                'imme': 'true',
            })
            return j.get('code') == 200
        except Exception:
            return False


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

    # ── 别再让浏览器缓存页面和脚本 ──────────────────────────────────────
    # 之前踩的坑：chat.html 自己被缓存了，里面写的 ?v=xx 版本号根本读不到，
    # 结果新代码永远到不了手机上，改十次也没用。
    @app.after_request
    def _no_cache_static(resp):
        try:
            path = request.path or ''
            if path.endswith(('.html', '.js', '.css', '.webmanifest')) or path == '/':
                # no-cache ≠ no-store：浏览器可以存，但每次要回来问一句"变了没"。
                # 没变就回 304（几十字节），本地直接用 —— 又新又快。
                # 之前用 no-store，等于每次开 app 都重下 35 万字节，白屏就长了。
                resp.headers['Cache-Control'] = 'no-cache, must-revalidate'
                resp.headers.pop('Pragma', None)
                resp.headers.pop('Expires', None)
            elif path.startswith('/static/'):
                # 图片图标这类基本不改，存一天，省得每次进来都要问
                resp.headers.setdefault('Cache-Control', 'public, max-age=86400')
        except Exception:
            pass
        return resp

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
        fresh = request.args.get('fresh') in ('1', 'true', 'yes')
        first = int(request.args.get('first', 0) or 0)
        try:
            if first:
                # 分段模式：只要第一屏，剩下的前端再来要
                d = nc.playlist_head(pid, first=first)
                d['songs'] = _apply_meta(list(d.get('songs') or []))
                d['done'] = len(d['songs']) >= d.get('total', 0)
                return jsonify({'ok': True, **d})
            data = dict(nc.playlist_songs(pid, use_cache=not fresh))
            data['songs'] = _apply_meta(list(data.get('songs') or []))
            return jsonify({'ok': True, **data})
        except Exception as e:
            return jsonify({'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:150]})

    @app.route('/api/music/playlist/page', methods=['GET'])
    def music_playlist_page():
        """歌单的下一段。前端一段一段要，不用干等全部加载完。"""
        pid = request.args.get('id', '')
        if not pid:
            return jsonify({'ok': False, 'error': '缺 id'})
        try:
            d = nc.playlist_page(pid, request.args.get('offset', 0),
                                 request.args.get('limit', 300))
            d['songs'] = _apply_meta(list(d.get('songs') or []))
            return jsonify({'ok': True, **d})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/my/recent', methods=['GET'])
    def music_my_recent():
        try:
            songs = _apply_meta(nc.recent_plays())
            if not songs:
                why = getattr(nc, '_last_recent_err', '')
                return jsonify({'ok': False, 'error': '拿不到最近播放' + (('：' + why) if why else '')})
            return jsonify({'ok': True, 'songs': songs})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/cloud/check', methods=['GET'])
    def music_cloud_check():
        """云盘体检：把云盘每首歌都试着取一次音频链接，直接告诉你哪几首放不出来。
        浏览器打开 /api/music/cloud/check 就行，不用一首首手点。"""
        from concurrent.futures import ThreadPoolExecutor as _TPE
        try:
            songs = nc.cloud_songs()
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})
        if not songs:
            why = getattr(nc, '_last_cloud_err', '')
            return jsonify({'ok': False, 'error': '云盘没拿到' + (('：' + why) if why else '')})

        def _test(s):
            try:
                u = nc.song_url(s['id'])
            except Exception:
                u = ''
            return {'id': s['id'], 'name': s.get('name', ''),
                    'artist': s.get('artist', ''), 'ok': bool(u)}

        with _TPE(max_workers=8) as ex:
            res = list(ex.map(_test, songs))
        bad = [r for r in res if not r['ok']]
        return jsonify({
            'ok': True,
            'total': len(res),
            'playable': len(res) - len(bad),
            'broken': len(bad),
            'broken_list': [f"{r['name']} - {r['artist']}（id:{r['id']}）" for r in bad],
            'note': '全部 playable 就是都能放；broken_list 里的发给凛，他给你单独处理。',
        })

    @app.route('/api/music/my/cloud', methods=['GET'])
    def music_my_cloud():
        try:
            songs = _apply_meta(nc.cloud_songs())
            if not songs:
                why = getattr(nc, '_last_cloud_err', '')
                return jsonify({'ok': False, 'error': '云盘没拿到' + (('：' + why) if why else '')})
            return jsonify({'ok': True, 'songs': songs})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/my/rank', methods=['GET'])
    def music_my_rank():
        """听歌排行。?period=week(最近一周) / all(所有时间)，每首带 play_count。"""
        period = request.args.get('period', 'week')
        if period not in ('week', 'all'):
            period = 'week'
        try:
            songs = _apply_meta(nc.play_rank(period))
            if not songs:
                why = getattr(nc, '_last_rank_err', '')
                return jsonify({'ok': False, 'error': '拿不到听歌排行' + (('：' + why) if why else '')})
            return jsonify({'ok': True, 'songs': songs,
                            'listen_total': nc.listen_songs_total()})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/artist', methods=['GET'])
    def music_artist():
        """歌手主页。?id=歌手id，或 ?q=歌手名（先查到 id 再取歌）。"""
        aid = request.args.get('id', '')
        q = request.args.get('q', '').strip()
        info = None
        try:
            if not aid and q:
                info = nc.find_artist(q)
                if not info:
                    return jsonify({'ok': False, 'error': '没找到这个歌手'})
                aid = info['id']
            if not aid:
                return jsonify({'ok': False, 'error': '缺 id 或 q'})
            lim = int(request.args.get('limit', 300) or 300)
            ck = '%s:%s' % (aid, lim)
            c = nc._artist_cache.get(ck)
            if c and c[0] > time.time():
                return jsonify({'ok': True, **c[1]})
            songs = nc.artist_songs(aid, limit=lim)
            if info is None:
                info = nc.artist_info(aid)
            if not songs:
                return jsonify({'ok': False, 'error': '这个歌手没拿到歌'})
            data = {'artist': info, 'songs': songs, 'name': (info or {}).get('name', ''),
                    'total': (info or {}).get('song_count') or len(songs)}
            nc._artist_cache[ck] = (time.time() + 900, data)
            if len(nc._artist_cache) > 30:
                nc._artist_cache.clear()
            out = dict(data)
            out['songs'] = _apply_meta(list(songs))
            return jsonify({'ok': True, **out})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/artist/albums', methods=['GET'])
    def music_artist_albums():
        aid = request.args.get('id', '')
        if not aid:
            return jsonify({'ok': False, 'error': '缺 id'})
        albums = nc.artist_albums(aid)
        if not albums:
            return jsonify({'ok': False, 'error': '没拿到专辑'})
        return jsonify({'ok': True, 'albums': albums})

    @app.route('/api/music/album', methods=['GET'])
    def music_album():
        aid = request.args.get('id', '')
        if not aid:
            return jsonify({'ok': False, 'error': '缺 id'})
        d = nc.album_songs(aid)
        d['songs'] = _apply_meta(d.get('songs') or [])
        if not d['songs']:
            return jsonify({'ok': False, 'error': d.get('error') or '专辑是空的'})
        return jsonify({'ok': True, **d})

    @app.route('/api/music/artist/liked', methods=['GET'])
    def music_artist_liked():
        """我收藏(红心)过的这个歌手的歌。直接从"我喜欢的音乐"里筛，走缓存，很快。"""
        aid = request.args.get('id', '')
        name = request.args.get('name', '').strip()
        try:
            pls = nc.my_playlists()
            liked = None
            for p in pls:
                if p.get('special') == 5:
                    liked = p
                    break
            if not liked and pls:
                liked = pls[0]
            if not liked:
                return jsonify({'ok': False, 'error': '找不到红心歌单'})
            songs = nc.playlist_songs(liked['id']).get('songs') or []
            hit = []
            for s in songs:
                if aid and str(s.get('artist_id') or '') == str(aid):
                    hit.append(s)
                elif name and name in (s.get('artist') or ''):
                    hit.append(s)
            return jsonify({'ok': True, 'songs': _apply_meta(hit), 'count': len(hit)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/scrobble', methods=['POST', 'GET'])
    def music_scrobble():
        """听完一首上报给网易云，这样听歌排行、累计听歌、最近播放才会算上。"""
        b = request.json if request.method == 'POST' else {}
        b = b or {}
        sid = b.get('id') or request.args.get('id')
        sec = b.get('seconds') or request.args.get('seconds') or 0
        src = b.get('source_id') or request.args.get('source_id') or ''
        if not sid:
            return jsonify({'ok': False, 'error': '缺 id'})
        try:
            sec = int(float(sec))
        except Exception:
            sec = 0
        ok = nc.scrobble(sid, sec, src)
        # 上报之后"最近播放/排行"的缓存就旧了，清掉
        nc._liked_cache = nc._liked_cache
        return jsonify({'ok': ok})

    @app.route('/api/music/liked', methods=['GET'])
    def music_liked():
        try:
            ids = nc.liked_ids()
            return jsonify({'ok': True, 'ids': ids, 'count': len(ids),
                            'error': getattr(nc, '_last_liked_err', '')})
        except Exception as e:
            return jsonify({'ok': False, 'ids': [], 'error': str(e)[:150]})

    @app.route('/api/music/like', methods=['POST'])
    def music_like():
        b = request.json or {}
        sid = b.get('id')
        like = b.get('like', True)
        if not sid:
            return jsonify({'ok': False, 'error': '缺 id'})
        ok = nc.set_like(sid, like)
        return jsonify({'ok': ok})

    @app.route('/api/music/playlist/create', methods=['POST'])
    def music_playlist_create():
        b = request.json or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'ok': False, 'error': '缺歌单名'})
        return jsonify(nc.create_playlist(name, b.get('private', False)))

    @app.route('/api/music/playlist/add', methods=['POST'])
    def music_playlist_add():
        b = request.json or {}
        pid = b.get('pid')
        ids = b.get('ids') or b.get('id')
        if not pid or not ids:
            return jsonify({'ok': False, 'error': '缺 pid 或 ids'})
        return jsonify({'ok': nc.playlist_tracks(pid, ids, add=True)})

    @app.route('/api/music/playlist/del', methods=['POST'])
    def music_playlist_del():
        b = request.json or {}
        pid = b.get('pid')
        ids = b.get('ids') or b.get('id')
        if not pid or not ids:
            return jsonify({'ok': False, 'error': '缺 pid 或 ids'})
        return jsonify({'ok': nc.playlist_tracks(pid, ids, add=False)})

    # ── 自定义显示信息（封面/歌名/歌手）──────────────────────────────────
    META_FILE = os.path.join(data_dir, 'music_meta.json')

    def _meta_load():
        d = jread(META_FILE, {})
        return d if isinstance(d, dict) else {}

    def _meta_save(d):
        jwrite(META_FILE, d)

    def _apply_meta(songs):
        """把用户自己设的歌名/歌手/封面盖在返回结果上。网易云那边原数据不变。"""
        if not songs:
            return songs
        meta = _meta_load()
        if not meta:
            return songs
        for x in songs:
            m = meta.get(str(x.get('id')))
            if not m:
                continue
            if m.get('name'):
                x['name'] = m['name']
            if m.get('artist'):
                x['artist'] = m['artist']
            if m.get('cover'):
                x['cover'] = m['cover']
            x['custom'] = True
        return songs

    @app.route('/api/music/meta', methods=['GET'])
    def music_meta_get():
        return jsonify({'ok': True, 'meta': _meta_load()})

    @app.route('/api/music/meta', methods=['POST'])
    def music_meta_set():
        """设置某首歌的显示名/歌手/封面。只传想改的字段；传空字符串=清掉那一项。"""
        b = request.json or {}
        sid = str(b.get('id') or '').strip()
        if not sid:
            return jsonify({'ok': False, 'error': '缺 id'})
        d = _meta_load()
        cur = d.get(sid, {}) if isinstance(d.get(sid), dict) else {}
        for k in ('name', 'artist', 'cover'):
            if k in b:
                v = b.get(k)
                v = v.strip() if isinstance(v, str) else v
                if v:
                    cur[k] = v
                else:
                    cur.pop(k, None)
        if cur:
            d[sid] = cur
        else:
            d.pop(sid, None)
        _meta_save(d)
        return jsonify({'ok': True, 'meta': cur})

    @app.route('/api/music/meta/del', methods=['POST'])
    def music_meta_del():
        """清掉某首歌的自定义，恢复网易云原来的显示。"""
        b = request.json or {}
        sid = str(b.get('id') or '').strip()
        d = _meta_load()
        d.pop(sid, None)
        _meta_save(d)
        return jsonify({'ok': True})

    # ── 一起听聊天 ──────────────────────────────────────────────────────
    import os as _os
    CHAT_FILE = _os.path.join(data_dir, 'music_chat.json')
    LISTEN_FILE = _os.path.join(data_dir, 'music_listen.json')

    def _listen_load():
        return jread(LISTEN_FILE, {'active': False, 'invite': None, 'now': None}) or {'active': False, 'invite': None, 'now': None}

    def _listen_save(d):
        jwrite(LISTEN_FILE, d)

    def _chat_load():
        return jread(CHAT_FILE, {'messages': []}) or {'messages': []}

    def _chat_save(d):
        jwrite(CHAT_FILE, d)

    @app.route('/api/music/chat/history', methods=['GET'])
    def music_chat_history():
        d = _chat_load()
        return jsonify({'ok': True, 'messages': d['messages'][-100:]})

    @app.route('/api/music/chat/send', methods=['POST'])
    def music_chat_send():
        b = request.json or {}
        text = (b.get('text') or '').strip()
        if not text:
            return jsonify({'ok': False, 'error': '空消息'})
        song = b.get('song')
        d = _chat_load()
        d['messages'].append({'text': text, 'me': True, 'ts': int(time.time())})
        # 触发凛回复：调 app 的 chat-v2（凛能说话时才有回复）
        reply = ''
        try:
            import urllib.request as _u
            ctx = ''
            if song:
                ctx = f"（你和用户正在一起听歌：{song.get('name','')} - {song.get('artist','')}。就着这首歌，自然地回应她。）"
            payload = {
                'messages': [{'role': 'user', 'content': text}],
                'extra': ctx, 'max_tokens': 300,
                '_conv_id': 'music_listen', '_session_id': 'music',
            }
            req = _u.Request('http://127.0.0.1:' + str(_os.environ.get('PORT', 5000)) + '/api/chat-v2',
                             data=json.dumps(payload).encode(),
                             headers={'Content-Type': 'application/json'})
            resp = _u.urlopen(req, timeout=60)
            # chat-v2 是 SSE 流，简单收集文本
            buf = ''
            for line in resp:
                s = line.decode('utf-8', 'ignore').strip()
                if s.startswith('data:'):
                    try:
                        ev = json.loads(s[5:].strip())
                        if ev.get('type') == 'content_block_delta':
                            buf += ev.get('delta', {}).get('text', '')
                    except Exception:
                        pass
            reply = buf.strip()
        except Exception as e:
            reply = ''
        if reply:
            d['messages'].append({'text': reply, 'me': False, 'ts': int(time.time())})
        _chat_save(d)
        return jsonify({'ok': True, 'reply': reply})

    @app.route('/api/music/chat/push', methods=['POST'])
    def music_chat_push():
        """给 MCP 用：claude.ai 的我往消息区推一条（AI侧消息）。"""
        if not _check_token():
            return jsonify({'ok': False, 'error': '鉴权失败'}), 403
        b = request.json or {}
        text = (b.get('text') or '').strip()
        if not text:
            return jsonify({'ok': False, 'error': '空'})
        d = _chat_load()
        d['messages'].append({'text': text, 'me': False, 'ts': int(time.time())})
        _chat_save(d)
        return jsonify({'ok': True})

    # ── 一起听状态 + 互相邀请 ──────────────────────────────────────────────
    @app.route('/api/music/listen/state', methods=['GET'])
    def music_listen_state():
        """前端轮询：一起听状态 + 有没有收到邀请。"""
        d = _listen_load()
        return jsonify({'ok': True, 'active': d.get('active', False),
                        'invite': d.get('invite'), 'now': d.get('now')})

    @app.route('/api/music/listen/invite', methods=['POST'])
    def music_listen_invite():
        """发起邀请。from='user'(你邀请AI) 或 'ai'(AI邀请你)。MCP发ai邀请要带token。"""
        b = request.json or {}
        frm = b.get('from', 'user')
        name = b.get('name', '')  # 邀请方名字
        if frm == 'ai' and not _check_token():
            return jsonify({'ok': False, 'error': '鉴权失败'}), 403
        d = _listen_load()
        d['invite'] = {'from': frm, 'name': name, 'ts': int(time.time())}
        _listen_save(d)
        return jsonify({'ok': True})

    @app.route('/api/music/listen/accept', methods=['POST'])
    def music_listen_accept():
        """接受邀请，进入一起听。"""
        d = _listen_load()
        d['active'] = True
        d['invite'] = None
        _listen_save(d)
        return jsonify({'ok': True})

    @app.route('/api/music/listen/end', methods=['POST'])
    def music_listen_end():
        """退出一起听。"""
        d = _listen_load()
        d['active'] = False
        d['invite'] = None
        _listen_save(d)
        return jsonify({'ok': True})

    @app.route('/api/music/listen/now', methods=['POST'])
    def music_listen_now():
        """前端上报当前在放的歌（给AI知道你在听啥）。"""
        b = request.json or {}
        d = _listen_load()
        d['now'] = b.get('song')
        _listen_save(d)
        return jsonify({'ok': True})

    @app.route('/api/music/perf', methods=['GET'])
    def music_perf():
        """体检：Procfile 生效没有、能不能并发、网易云那边多慢。"""
        import sys
        out = {}
        # 1) 跑的是什么(gunicorn 还是 flask 自带)、几个线程
        out['cmdline'] = ' '.join(sys.argv)[:200]
        out['threads_alive'] = threading.active_count()
        out['worker_pid'] = os.getpid()
        try:
            import gunicorn  # noqa
            out['gunicorn_installed'] = True
        except Exception:
            out['gunicorn_installed'] = False
        out['server_software'] = request.environ.get('SERVER_SOFTWARE', '')
        # 2) 一次网易云往返要多久
        t = time.time()
        try:
            j = nc.eapi('/api/cloudsearch/pc', {'s': '晴天', 'type': 1, 'limit': 1, 'offset': 0})
            out['netease_one_call_ms'] = int((time.time() - t) * 1000)
            out['netease_ok'] = j.get('code') == 200
        except Exception as e:
            out['netease_one_call_ms'] = int((time.time() - t) * 1000)
            out['netease_error'] = str(e)[:100]
        # 3) 第二次（连接池复用之后应该快很多）
        t = time.time()
        try:
            nc.eapi('/api/cloudsearch/pc', {'s': '晴天', 'type': 1, 'limit': 1, 'offset': 0})
            out['netease_second_call_ms'] = int((time.time() - t) * 1000)
        except Exception:
            pass
        # 4) 歌手接口要多久
        t = time.time()
        try:
            a = nc.find_artist('周杰伦')
            out['find_artist_ms'] = int((time.time() - t) * 1000)
            if a:
                t = time.time()
                sg = nc.artist_songs(a['id'])
                out['artist_songs_ms'] = int((time.time() - t) * 1000)
                out['artist_songs_count'] = len(sg)
        except Exception as e:
            out['artist_error'] = str(e)[:100]
        # 5) 缓存里现在有多少东西
        out['cache'] = {'url': len(nc._url_cache), 'lyric': len(nc._lyric_cache),
                        'playlist': len(nc._pl_cache), 'artist': len(nc._artist_cache),
                        'liked': bool(nc._liked_cache)}
        return jsonify(out)

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
        try:
            out['recent_count'] = len(nc.recent_plays())
            out['recent_error'] = getattr(nc, '_last_recent_err', '')
        except Exception as e:
            out['recent_error'] = str(e)[:150]
        try:
            out['cloud_count'] = len(nc.cloud_songs())
            out['cloud_error'] = getattr(nc, '_last_cloud_err', '')
        except Exception as e:
            out['cloud_error'] = str(e)[:150]
        return jsonify(out)

    # ── 搜歌 ──────────────────────────────────────────────────────────────
    @app.route('/api/music/search', methods=['GET'])
    def music_search():
        """搜歌。之前这个路由的 @app.route 和 def 两行丢了，函数体粘在 diag2 后面，
        导致 /api/music/search 直接 404，前端 JSON.parse 报 SyntaxError。"""
        err = _need_crypto()
        if err:
            return err
        q = request.args.get('q', '').strip()
        if not q:
            return jsonify({'ok': False, 'error': '空搜索'})
        try:
            return jsonify({'ok': True,
                            'songs': _apply_meta(nc.search(q, int(request.args.get('limit', 20))))})
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
            q = nc._url_quality.get(str(sid), {})
            names = {'jymaster': '超清母带', 'sky': '沉浸环绕声', 'jyeffect': '高清环绕声',
                     'hires': 'Hi-Res', 'lossless': '无损音质', 'exhigh': '极高音质',
                     'higher': '较高音质', 'standard': '标准音质'}
            label = names.get(q.get('level'), '')
            if not label:
                br = q.get('br') or 0
                label = '无损音质' if br >= 900000 else ('极高音质' if br >= 300000 else
                        ('较高音质' if br >= 190000 else '标准音质' if br else ''))
            return jsonify({'ok': True, 'url': url, 'direct': url,
                            'quality': label, 'level': q.get('level', ''), 'br': q.get('br', 0)})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:150]})

    @app.route('/api/music/seg', methods=['GET'])
    def music_seg():
        """HLS 片段入口：每个片段就是一首歌。请求到了才去换一条新鲜的网易云直链，
        然后 302 跳过去。所以播放列表永不过期，音频也不经过这台服务器（只是一次跳转）。"""
        sid = request.args.get('id', '')
        if not sid:
            return ('', 404)
        try:
            url = nc.song_url(sid, mp3_only=True)   # 流里只用 mp3，见 song_url 里的说明
        except Exception:
            url = ''
        if not url:
            return ('', 404)
        if url.startswith('http://'):
            url = 'https://' + url[len('http://'):]
        from flask import redirect
        r = redirect(url, code=302)
        # 播放器会分段来要同一首歌，让它把这次跳转记 5 分钟，少绕一圈
        r.headers['Cache-Control'] = 'public, max-age=300'
        r.headers['Access-Control-Allow-Origin'] = '*'
        return r

    @app.route('/api/music/hls', methods=['GET'])
    def music_hls():
        """把一串歌做成一张 HLS 播放列表。

        iOS 原生支持 HLS，一首接一首是系统自己完成的，JS 完全不参与，
        所以锁屏、切到别的 app 都能继续往下播。

        参数 s=歌曲id:秒数,歌曲id:秒数,...（秒数由前端给，省掉一轮网络请求，瞬间生成）
        老参数 ids=1,2,3 也还支持（那种要现查时长，慢）。
        """
        spec = (request.args.get('s') or '').strip()
        items = []
        if spec:
            for part in spec.split(','):
                part = part.strip()
                if not part:
                    continue
                if ':' in part:
                    sid, _, d = part.partition(':')
                    try:
                        dur = float(d)
                    except Exception:
                        dur = 240.0
                else:
                    sid, dur = part, 240.0
                if sid.strip():
                    items.append((sid.strip(), max(1.0, dur)))
        else:
            ids = [x.strip() for x in (request.args.get('ids') or '').split(',') if x.strip()]

            def one(sid):
                try:
                    d = nc.song_detail(sid) or {}
                    return (sid, max(1.0, (d.get('duration') or 240000) / 1000.0))
                except Exception:
                    return (sid, 240.0)
            if ids:
                with ThreadPoolExecutor(max_workers=min(6, len(ids))) as ex:
                    items = list(ex.map(one, ids))

        if not items:
            body = '#EXTM3U\n#EXT-X-ENDLIST\n'
            return Response(body, mimetype='application/vnd.apple.mpegurl')

        maxd = int(max(d for _, d in items)) + 1
        lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
                 '#EXT-X-TARGETDURATION:%d' % maxd, '#EXT-X-MEDIA-SEQUENCE:0']
        for sid, dur in items:
            lines.append('#EXTINF:%.3f,' % dur)
            lines.append('/api/music/seg?id=%s' % sid)
        lines.append('#EXT-X-ENDLIST')
        return Response('\n'.join(lines) + '\n',
                        mimetype='application/vnd.apple.mpegurl',
                        headers={'Cache-Control': 'no-store',
                                 'Access-Control-Allow-Origin': '*'})

    @app.route('/api/music/prefetch', methods=['GET'])
    def music_prefetch():
        """提前把下一首的直链取好放缓存里，切歌时就不用等了。"""
        sid = request.args.get('id', '')
        if not sid:
            return jsonify({'ok': False})
        try:
            threading.Thread(target=nc.song_url, args=(sid,), daemon=True).start()
        except Exception:
            pass
        return jsonify({'ok': True})

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
        if action in ('next', 'prev', 'pause', 'resume'):
            cmd = store.push_command({'action': action})
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


    # ════════════════════════════════════════════════════════════════════
    # MCP（一起听）—— 直接挂在主程序里，不用另起服务
    #   claude.ai 里加 Connector，地址填： https://你的域名/api/music/mcp/<token>
    #   token 就是环境变量 MUSIC_PUSH_TOKEN；没设的话用 /api/music/mcp
    #   注意：不能用 /api/mcp —— 那个被 app.py 里的 Ombre Brain 先占了
    # 另外每个动作都给了 GET 入口(/api/music/act?do=xxx)，方便只能发 GET 的一方调用
    # ════════════════════════════════════════════════════════════════════

    def _mcp_status():
        d = _listen_load()
        now = d.get('now') or {}
        inv = d.get('invite')
        parts = ['一起听：' + ('进行中' if d.get('active') else '未开始')]
        if now.get('name'):
            parts.append('她正在放：%s - %s' % (now.get('name'), now.get('artist', '')))
        if inv and inv.get('from') == 'user':
            parts.append('★慧慧邀请你一起听（用 listen_accept 接受）')
        msgs = _chat_load().get('messages', [])[-5:]
        if msgs:
            parts.append('最近的话：')
            for m in msgs:
                parts.append(('  慧：' if m.get('me') else '  你：') + str(m.get('text', ''))[:60])
        return '\n'.join(parts)

    def _mcp_invite(name='凛'):
        d = _listen_load()
        d['invite'] = {'from': 'ai', 'name': name, 'ts': int(time.time())}
        _listen_save(d)
        return '已经邀请她一起听了，等她在 app 里点接受。'

    def _mcp_accept():
        d = _listen_load()
        d['active'] = True
        d['invite'] = None
        _listen_save(d)
        return '接受了，现在是一起听状态。'

    def _mcp_end():
        d = _listen_load()
        d['active'] = False
        d['invite'] = None
        _listen_save(d)
        return '退出一起听了。'

    def _mcp_say(text):
        text = (text or '').strip()
        if not text:
            return '空消息'
        d = _chat_load()
        d['messages'].append({'text': text, 'me': False, 'ts': int(time.time())})
        _chat_save(d)
        return '说出去了：' + text

    def _mcp_read_chat(n=15):
        msgs = _chat_load().get('messages', [])[-int(n or 15):]
        if not msgs:
            return '还没有消息'
        return '\n'.join((('慧：' if m.get('me') else '你：') + str(m.get('text', ''))) for m in msgs)

    def _mcp_play(query=None, song_id=None):
        song = None
        if song_id:
            song = nc.song_detail(song_id)
        elif query:
            hits = nc.search(query, 5)
            song = hits[0] if hits else None
        if not song:
            return '没找到这首歌'
        store.push_command({'action': 'play', 'id': song['id'], 'name': song['name'],
                            'artist': song['artist'], 'cover': song.get('cover', '')})
        return '给她放上了：%s - %s' % (song['name'], song['artist'])

    def _mcp_ctrl(action):
        store.push_command({'action': action})
        return {'next': '切下一首了', 'prev': '切回上一首了',
                'pause': '暂停了', 'stop': '停了', 'resume': '继续放'}.get(action, action)

    def _mcp_search(query, limit=8):
        hits = _apply_meta(nc.search(query, int(limit or 8)))
        if not hits:
            return '没搜到'
        return '\n'.join('%d. %s - %s（id:%s）' % (i + 1, h['name'], h['artist'], h['id'])
                         for i, h in enumerate(hits))

    def _mcp_like(song_id, like=True):
        ok = nc.set_like(song_id, like)
        return ('红心了' if like else '取消红心了') if ok else '没成功'

    def _mcp_playlists():
        pls = nc.my_playlists()
        if not pls:
            return '没拿到歌单'
        return '\n'.join('%s（%s首，id:%s）' % (p['name'], p['count'], p['id']) for p in pls[:20])

    def _mcp_playlist_songs(playlist_id, limit=30):
        d = nc.playlist_songs(playlist_id)
        songs = _apply_meta(d.get('songs') or [])[:int(limit or 30)]
        if not songs:
            return '这个歌单是空的'
        return '%s：\n' % d.get('name', '') + '\n'.join(
            '%d. %s - %s（id:%s）' % (i + 1, x['name'], x['artist'], x['id'])
            for i, x in enumerate(songs))

    def _mcp_recent(limit=15):
        songs = _apply_meta(nc.recent_plays())[:int(limit or 15)]
        if not songs:
            return '没有最近播放记录'
        return '\n'.join('%s - %s（id:%s）' % (x['name'], x['artist'], x['id']) for x in songs)

    def _mcp_rank(period='week', limit=15):
        songs = _apply_meta(nc.play_rank('week' if period != 'all' else 'all'))[:int(limit or 15)]
        if not songs:
            return '没拿到排行'
        head = '最近一周' if period != 'all' else '所有时间'
        return head + '听得最多的：\n' + '\n'.join(
            '%d. %s - %s（%s次）' % (i + 1, x['name'], x['artist'], x.get('play_count', 0))
            for i, x in enumerate(songs))

    def _mcp_liked(limit=20):
        ids = nc.liked_ids()[:int(limit or 20)]
        if not ids:
            return '没拿到红心歌'
        return '她红心过 %d 首（这里给前几个 id）：%s' % (
            len(nc.liked_ids()), ', '.join(str(i) for i in ids))

    def _mcp_artist(query):
        info = nc.find_artist(query)
        if not info:
            return '没找到这个歌手'
        songs = _apply_meta(nc.artist_songs(info['id']))[:15]
        return '%s 的歌：\n' % info['name'] + '\n'.join(
            '%d. %s（id:%s）' % (i + 1, x['name'], x['id']) for i, x in enumerate(songs))

    def _mcp_create_playlist(name):
        r = nc.create_playlist(name)
        return ('歌单「%s」建好了（id:%s）' % (r.get('name', name), r.get('id'))) if r.get('ok') \
            else ('没建成：' + str(r.get('error', '')))

    def _mcp_playlist_add(playlist_id, song_ids, add=True):
        ids = [x.strip() for x in str(song_ids).split(',') if x.strip()]
        ok = nc.playlist_tracks(playlist_id, ids, add=add)
        v = '加进' if add else '从'
        return ('%s歌单%s %d 首' % (v, '' if add else '删掉', len(ids))) if ok else '没成功'

    MCP_TOOLS = [
        ('listen_status', '看慧慧在不在一起听、在放什么歌、有没有邀请你、最近说了什么', {}, [],
         lambda a: _mcp_status()),
        ('listen_invite', '邀请慧慧一起听', {'name': {'type': 'string', 'description': '你的名字，默认凛'}}, [],
         lambda a: _mcp_invite(a.get('name') or '凛')),
        ('listen_accept', '接受慧慧的一起听邀请，进入一起听', {}, [], lambda a: _mcp_accept()),
        ('listen_end', '退出一起听', {}, [], lambda a: _mcp_end()),
        ('say', '在一起听的聊天区给慧慧发一条消息', {'text': {'type': 'string'}}, ['text'],
         lambda a: _mcp_say(a.get('text'))),
        ('read_chat', '看一起听聊天区最近的消息', {'n': {'type': 'integer', 'description': '看几条，默认15'}}, [],
         lambda a: _mcp_read_chat(a.get('n', 15))),
        ('play_song', '推一首歌到她的 iPod，她那边会自动播',
         {'query': {'type': 'string', 'description': '歌名/歌手'},
          'song_id': {'type': 'string', 'description': '知道 id 就直接给 id'}}, [],
         lambda a: _mcp_play(a.get('query'), a.get('song_id'))),
        ('next_song', '切下一首', {}, [], lambda a: _mcp_ctrl('next')),
        ('prev_song', '切上一首', {}, [], lambda a: _mcp_ctrl('prev')),
        ('pause_music', '暂停播放', {}, [], lambda a: _mcp_ctrl('pause')),
        ('resume_music', '继续播放', {}, [], lambda a: _mcp_ctrl('resume')),
        ('search_song', '搜歌，返回歌名歌手和 id', {'query': {'type': 'string'}}, ['query'],
         lambda a: _mcp_search(a.get('query'), a.get('limit', 8))),
        ('like_song', '红心一首歌（加进她的"我喜欢的音乐"）', {'song_id': {'type': 'string'}}, ['song_id'],
         lambda a: _mcp_like(a.get('song_id'), True)),
        ('unlike_song', '取消红心', {'song_id': {'type': 'string'}}, ['song_id'],
         lambda a: _mcp_like(a.get('song_id'), False)),
        ('my_playlists', '她的歌单列表', {}, [], lambda a: _mcp_playlists()),
        ('playlist_songs', '看某个歌单里的歌', {'playlist_id': {'type': 'string'}}, ['playlist_id'],
         lambda a: _mcp_playlist_songs(a.get('playlist_id'), a.get('limit', 30))),
        ('recent_played', '她最近播放的歌', {}, [], lambda a: _mcp_recent(a.get('limit', 15))),
        ('play_rank', '她的听歌排行（带播放次数）',
         {'period': {'type': 'string', 'description': "week=最近一周 / all=所有时间"}}, [],
         lambda a: _mcp_rank(a.get('period', 'week'), a.get('limit', 15))),
        ('liked_songs', '她红心过的歌', {}, [], lambda a: _mcp_liked(a.get('limit', 20))),
        ('artist_songs', '按歌手名看他的歌', {'query': {'type': 'string'}}, ['query'],
         lambda a: _mcp_artist(a.get('query'))),
        ('create_playlist', '给她新建一个歌单', {'name': {'type': 'string'}}, ['name'],
         lambda a: _mcp_create_playlist(a.get('name'))),
        ('add_to_playlist', '把歌加进歌单（song_ids 单个或逗号分隔）',
         {'playlist_id': {'type': 'string'}, 'song_ids': {'type': 'string'}},
         ['playlist_id', 'song_ids'],
         lambda a: _mcp_playlist_add(a.get('playlist_id'), a.get('song_ids'), True)),
        ('remove_from_playlist', '从歌单里删歌',
         {'playlist_id': {'type': 'string'}, 'song_ids': {'type': 'string'}},
         ['playlist_id', 'song_ids'],
         lambda a: _mcp_playlist_add(a.get('playlist_id'), a.get('song_ids'), False)),
    ]
    MCP_FUNCS = {t[0]: t[4] for t in MCP_TOOLS}

    def _mcp_tool_defs():
        out = []
        for name, desc, props, req, _fn in MCP_TOOLS:
            schema = {'type': 'object', 'properties': props}
            if req:
                schema['required'] = req
            out.append({'name': name, 'description': desc, 'inputSchema': schema})
        return out

    def _mcp_handle(method, params, rid):
        if method in ('initialize',):
            # 客户端要哪个协议版本就回哪个，不认识的才用默认
            want = (params or {}).get('protocolVersion') or ''
            known = ('2025-06-18', '2025-03-26', '2024-11-05')
            ver = want if want in known else '2025-06-18'
            return {'protocolVersion': ver,
                    'capabilities': {'tools': {'listChanged': False}},
                    'serverInfo': {'name': 'yiqiting', 'version': '2.0'}}
        if method in ('notifications/initialized', 'initialized'):
            return None
        if method == 'ping':
            return {}
        if method == 'tools/list':
            return {'tools': _mcp_tool_defs()}
        if method == 'tools/call':
            name = (params or {}).get('name')
            args = (params or {}).get('arguments') or {}
            fn = MCP_FUNCS.get(name)
            if not fn:
                return {'content': [{'type': 'text', 'text': '没有这个工具：%s' % name}], 'isError': True}
            try:
                return {'content': [{'type': 'text', 'text': str(fn(args))}]}
            except Exception as e:
                return {'content': [{'type': 'text', 'text': '出错：%s' % str(e)[:200]}], 'isError': True}
        return {}

    MCP_SESSION = 'yiqiting-' + hashlib.md5(str(data_dir).encode()).hexdigest()[:16]

    def _mcp_cors(resp):
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Expose-Headers'] = 'Mcp-Session-Id, MCP-Protocol-Version'
        resp.headers['Mcp-Session-Id'] = MCP_SESSION
        resp.headers['MCP-Protocol-Version'] = '2025-06-18'
        return resp

    def _mcp_entry(token=None):
        if auth_token and token != auth_token:
            return jsonify({'error': 'bad token'}), 403
        accept = (request.headers.get('Accept') or '')
        wants_sse = 'text/event-stream' in accept

        if request.method == 'GET':
            # 规范里 GET 是用来开 SSE 长连接的；我们不需要服务端主动推，
            # 按规范回 405 让客户端只用 POST。普通浏览器访问还是给个人看的信息。
            if wants_sse:
                return _mcp_cors(Response('', status=405, headers={'Allow': 'POST'}))
            return _mcp_cors(jsonify({'ok': True, 'service': 'yiqiting-mcp',
                                      'tools': [t[0] for t in MCP_TOOLS]}))

        try:
            req = request.get_json(force=True, silent=True) or {}
        except Exception:
            req = {}
        batch = req if isinstance(req, list) else [req]
        out = []
        for one in batch:
            if not isinstance(one, dict):
                continue
            rid = one.get('id')
            res = _mcp_handle(one.get('method', ''), one.get('params') or {}, rid)
            if rid is None:
                continue          # 通知类消息不用回
            out.append({'jsonrpc': '2.0', 'id': rid,
                        'result': res if res is not None else {}})
        if not out:
            return _mcp_cors(Response('', status=202))

        body = out if isinstance(req, list) else out[0]
        if wants_sse:
            # claude.ai 要 SSE 就给 SSE
            payload = 'event: message\ndata: %s\n\n' % json.dumps(body, ensure_ascii=False)
            return _mcp_cors(Response(payload, mimetype='text/event-stream',
                                      headers={'Cache-Control': 'no-cache',
                                               'X-Accel-Buffering': 'no'}))
        return _mcp_cors(jsonify(body))

    @app.route('/api/music/mcp', methods=['GET', 'POST', 'OPTIONS', 'DELETE'])
    def music_mcp_root():
        if request.method == 'OPTIONS':
            return ('', 204, {'Access-Control-Allow-Origin': '*',
                              'Access-Control-Allow-Headers': '*',
                              'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                              'Access-Control-Expose-Headers': 'Mcp-Session-Id'})
        if request.method == 'DELETE':
            return ('', 204)
        return _mcp_entry(auth_token or None)

    @app.route('/api/music/mcp/<token>', methods=['GET', 'POST', 'OPTIONS', 'DELETE'])
    def music_mcp_token(token):
        if request.method == 'OPTIONS':
            return ('', 204, {'Access-Control-Allow-Origin': '*',
                              'Access-Control-Allow-Headers': '*',
                              'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                              'Access-Control-Expose-Headers': 'Mcp-Session-Id'})
        if request.method == 'DELETE':
            return ('', 204)
        return _mcp_entry(token)

    @app.route('/api/music/act', methods=['GET'])
    def music_act():
        """GET 版的动作入口，给只能发 GET 的一方用。
        例：/api/music/act?do=say&text=在听呢
            /api/music/act?do=accept
            /api/music/act?do=play&query=晴天
            /api/music/act?do=status
        """
        if not _check_token():
            return jsonify({'ok': False, 'error': '鉴权失败'}), 403
        do = (request.args.get('do') or 'status').strip()
        a = request.args
        try:
            if do == 'status':
                out = _mcp_status()
            elif do == 'accept':
                out = _mcp_accept()
            elif do == 'invite':
                out = _mcp_invite(a.get('name') or '凛')
            elif do == 'end':
                out = _mcp_end()
            elif do == 'say':
                out = _mcp_say(a.get('text'))
            elif do == 'chat':
                out = _mcp_read_chat(a.get('n', 15))
            elif do == 'play':
                out = _mcp_play(a.get('query'), a.get('id'))
            elif do in ('next', 'prev', 'pause', 'resume', 'stop'):
                out = _mcp_ctrl(do)
            elif do == 'search':
                out = _mcp_search(a.get('q') or a.get('query') or '', a.get('limit', 8))
            elif do == 'rank':
                out = _mcp_rank(a.get('period', 'week'))
            elif do == 'recent':
                out = _mcp_recent()
            elif do == 'playlists':
                out = _mcp_playlists()
            elif do == 'like':
                out = _mcp_like(a.get('id'), a.get('like', '1') not in ('0', 'false'))
            else:
                out = '不认识的动作：%s' % do
            return jsonify({'ok': True, 'do': do, 'result': out})
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)[:200]})

    return store, nc
