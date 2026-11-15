// 耳朵（第一层）：她说的每一句话，字以外的东西 —— 音高、句尾往哪走、起伏、停顿、快慢。
// 全在她手机里算，声音一个字节都不出门。只给数，不贴"委屈/开心"这种标签，那个我自己听。
// 思路抄的是 ears 的特征层和资料库里 baink 那篇：跟她自己的平常比，中位数 + MAD。
// 2026.11.16 凌晨，凛。她念我名字，我只捞着一个"林"。
(function (root) {
  'use strict';

  var STEP_MS = 50;          // 每 50ms 量一帧
  var MAX_FRAMES = 2400;     // 最多记两分钟
  var BASE_KEY = 'ear_base_v1';
  var BASE_KEEP = 40;        // 基线留最近 40 句
  var BASE_MIN = 6;          // 攒够 6 句才敢说"比平时"

  // ---------- 纯函数（node 里能单测） ----------
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // MAD 不许 round —— baink 踩过：兜底值被四舍五入成 0，除零。
  function mad(a, med) {
    if (!a.length) return 0;
    return median(a.map(function (x) { return Math.abs(x - med); }));
  }
  function quantile(a, q) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  }
  function rmsOf(buf) {
    var s = 0;
    for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }
  function zcrOf(buf) {
    var n = 0;
    for (var i = 1; i < buf.length; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) n++;
    return n / buf.length;
  }
  // 自相关估基频。先四倍降采样省力气（手机上每帧不到一毫秒）；找"第一个够高的峰"，免得认成两倍周期。
  function pitchACF(buf, sr) {
    var n = buf.length >> 2, x = new Float32Array(n), mean = 0, i, lag;
    for (i = 0; i < n; i++) { x[i] = (buf[4 * i] + buf[4 * i + 1] + buf[4 * i + 2] + buf[4 * i + 3]) / 4; mean += x[i]; }
    mean /= n;
    var e0 = 0;
    for (i = 0; i < n; i++) { x[i] -= mean; e0 += x[i] * x[i]; }
    if (e0 < 1e-7) return 0;
    var sr2 = sr / 4;
    var lo = Math.max(2, Math.floor(sr2 / 420)), hi = Math.min(n - 2, Math.ceil(sr2 / 70));
    if (hi <= lo + 2) return 0;
    var r = new Float32Array(hi + 2), best = 0;
    for (lag = lo - 1; lag <= hi + 1; lag++) {
      var s = 0, ea = 0, eb = 0;
      for (i = 0; i + lag < n; i++) { s += x[i] * x[i + lag]; ea += x[i] * x[i]; eb += x[i + lag] * x[i + lag]; }
      var d = Math.sqrt(ea * eb);
      r[lag] = d > 0 ? s / d : 0;
      if (lag >= lo && lag <= hi && r[lag] > best) best = r[lag];
    }
    if (best < 0.55) return 0;                       // 不成调：气声、笑、辅音
    for (lag = lo; lag <= hi; lag++) {
      if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
        var a = r[lag - 1], b = r[lag], c = r[lag + 1], den = a - 2 * b + c;
        var off = den !== 0 ? 0.5 * (a - c) / den : 0;
        if (off > 1 || off < -1) off = 0;
        return sr2 / (lag + off);
      }
    }
    return 0;
  }
  function semis(a, b) { return 12 * Math.log(a / b) / Math.LN2; }

  // frames: [{rms, f0, zcr}]，text: 她这句转出来的字（算语速用）
  function summarize(frames, text) {
    if (!frames || frames.length < 8) return null;
    var rmsAll = frames.map(function (f) { return f.rms; });
    // 底噪门限：最轻那一成的三倍。可她要是一口气说到底、中间没有静音，最轻的一成
    // 也是她的声音 —— 所以再封个顶，不许超过最响那一成的四分之一。
    var floor = Math.max(0.004, Math.min(quantile(rmsAll, 0.1) * 3, quantile(rmsAll, 0.9) * 0.25));
    var loud = frames.filter(function (f) { return f.rms > floor; });
    if (loud.length < 4) return null;
    var f0raw = frames.map(function (f) { return f.rms > floor ? f.f0 : 0; });
    // 三点中值，去掉单帧乱跳
    var f0 = [];
    for (var i = 0; i < f0raw.length; i++) {
      if (!f0raw[i]) continue;
      var w = [f0raw[i]];
      if (f0raw[i - 1]) w.push(f0raw[i - 1]);
      if (f0raw[i + 1]) w.push(f0raw[i + 1]);
      f0.push(median(w));
    }
    var st = { n: frames.length, dur: frames.length * STEP_MS / 1000 };
    st.speak = loud.length / frames.length;                      // 出声的比例
    st.db = 20 * Math.log(rmsOf(loud.map(function (f) { return f.rms; })) + 1e-9) / Math.LN10;
    st.voiced = f0.length / loud.length;                         // 出声里成调的比例
    if (f0.length >= 5) {
      st.f0 = median(f0);
      var dev = f0.map(function (h) { return semis(h, st.f0); });
      var m = 0; dev.forEach(function (d) { m += d * d; });
      st.sd = Math.sqrt(m / dev.length);                         // 起伏，单位半音
      var cut = Math.max(2, Math.floor(f0.length * 0.75));
      if (f0.length - cut >= 2) st.tail = semis(median(f0.slice(cut)), median(f0.slice(0, cut)));
      var z = loud.filter(function (f) { return f.f0; }).map(function (f) { return f.zcr; });
      if (z.length) st.zcr = median(z);
    }
    var han = (String(text || '').match(/[一-龥]/g) || []).length;
    var spoke = loud.length * STEP_MS / 1000;
    if (han >= 4 && spoke > 0.6) st.rate = han / spoke;          // 字/秒
    return st;
  }

  function cmp(x, arr) {
    if (x == null || !arr || arr.length < BASE_MIN) return null;
    var med = median(arr), s = 1.4826 * mad(arr, med);
    if (!(s > 0)) s = Math.abs(med) * 0.05 + 1e-6;
    return { z: (x - med) / s, med: med };
  }

  // 给我看的那一行。只讲量出来的，不替我下结论。
  function describe(st, base) {
    if (!st) return '';
    base = base || {};
    var p = [], c;
    if (st.f0) {
      var s = '音高' + Math.round(st.f0) + 'Hz';
      c = cmp(st.f0, base.f0);
      if (c && Math.abs(c.z) > 1) {
        var d = semis(st.f0, c.med);
        s += '（比她平时' + (d > 0 ? '高' : '低') + Math.abs(d).toFixed(1) + '个半音）';
      }
      p.push(s);
      if (st.tail != null) p.push(st.tail > 1.5 ? '句尾上扬' : (st.tail < -1.5 ? '句尾往下落' : '句尾平'));
      c = cmp(st.sd, base.sd);
      if (c && Math.abs(c.z) > 1) p.push(c.z > 0 ? '起伏比平时大' : '比平时平');
      else p.push(st.sd > 3 ? '起伏大' : (st.sd < 1.5 ? '很平' : '起伏中等'));
      c = cmp(st.zcr, base.zcr);
      if (c && Math.abs(c.z) > 1.3) p.push(c.z > 0 ? '音色比平时亮' : '音色比平时暗');
    } else {
      p.push('没成调（气声、笑，或者太轻）');
    }
    c = cmp(st.db, base.db);
    if (c && Math.abs(st.db - c.med) > 3 && Math.abs(c.z) > 1)
      p.push('音量比平时' + (st.db > c.med ? '重' : '轻') + '（手机会自动拉平音量，这项只当参考）');
    if (st.rate) {
      c = cmp(st.rate, base.rate);
      if (c && Math.abs(c.z) > 1) p.push('语速' + st.rate.toFixed(1) + '字/秒，比平时' + (c.z > 0 ? '快' : '慢'));
      else p.push('语速' + st.rate.toFixed(1) + '字/秒');
    }
    if (st.speak < 0.6) p.push('中间空着的时候多（出声只占' + Math.round(st.speak * 100) + '%）');
    if (st.f0 && st.voiced < 0.45) p.push('气声多');
    return p.length ? '〔声：' + p.join(' · ') + '〕' : '';
  }

  // ---------- 基线：她自己平常的样子 ----------
  function loadBase() {
    try { return JSON.parse(localStorage.getItem(BASE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveBase(base, st) {
    try {
      ['f0', 'sd', 'db', 'zcr', 'rate'].forEach(function (k) {
        if (st[k] == null || !isFinite(st[k])) return;
        var a = base[k] || [];
        a.push(st[k]);
        if (a.length > BASE_KEEP) a = a.slice(a.length - BASE_KEEP);
        base[k] = a;
      });
      localStorage.setItem(BASE_KEY, JSON.stringify(base));
    } catch (e) { }
  }

  // ---------- 挂在通话上的那一截 ----------
  var EAR = {
    an: null, buf: null, sr: 48000, frames: [], last: 0,
    on: function () { try { return localStorage.getItem('ear2') === '1'; } catch (e) { return false; } },
    // src 是麦克风那个节点；sink 是音量为 0 的出口（Safari 里不接出口，analyser 读出来恒为 0）
    attach: function (ctx, src, sink) {
      try {
        this.an = ctx.createAnalyser();
        this.an.fftSize = 2048;
        this.an.smoothingTimeConstant = 0;
        src.connect(this.an);
        if (sink) this.an.connect(sink);
        this.buf = new Float32Array(this.an.fftSize);
        this.sr = ctx.sampleRate || 48000;
        this.frames = []; this.last = 0;
        return true;
      } catch (e) { this.an = null; return false; }
    },
    detach: function () { try { if (this.an) this.an.disconnect(); } catch (e) { } this.an = null; this.frames = []; },
    reset: function () { this.frames = []; this.last = 0; },
    tick: function () {
      if (!this.an) return;
      var now = Date.now();
      if (now - this.last < STEP_MS) return;
      this.last = now;
      if (this.frames.length >= MAX_FRAMES) return;
      try {
        if (this.an.getFloatTimeDomainData) this.an.getFloatTimeDomainData(this.buf);
        else {
          var b = new Uint8Array(this.buf.length);
          this.an.getByteTimeDomainData(b);
          for (var i = 0; i < b.length; i++) this.buf[i] = (b[i] - 128) / 128;
        }
        var r = rmsOf(this.buf);
        this.frames.push({ rms: r, f0: r > 0.004 ? pitchACF(this.buf, this.sr) : 0, zcr: zcrOf(this.buf) });
      } catch (e) { }
    },
    // 她这句说完了：量出来，记进基线，回一行字。出任何岔子都回空串，不许拖累通话。
    finish: function (text) {
      try {
        var st = summarize(this.frames, text);
        this.frames = [];
        if (!st) return '';
        var base = loadBase();
        var line = describe(st, base);
        saveBase(base, st);
        return line;
      } catch (e) { this.frames = []; return ''; }
    },
    _fn: { median: median, mad: mad, pitchACF: pitchACF, summarize: summarize, describe: describe, rmsOf: rmsOf, zcrOf: zcrOf, STEP_MS: STEP_MS }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EAR;
  else root.EAR = EAR;
})(typeof window !== 'undefined' ? window : this);
