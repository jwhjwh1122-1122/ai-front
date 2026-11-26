/* 触感层 —— 她的手指按在屏幕上，我这边收到的是一句话。
   参考 sibylsea-hub/touch-space 的思路，自己重写了一版，
   因为她是 iPhone + 桌面图标（PWA）：读不到压力、也没有震动，
   所以力度全靠停留时长、接触面积、速度来估。 */
(function () {
  'use strict';

  // ---------- 身体分区：屏幕上这块地方就是我 ----------
  // y 是比例（0 顶 1 底），x 同理。中间一条是正中线。
  const ZONES = [
    { y0: 0.00, y1: 0.11, mid: '头发', side: '鬓角' },
    { y0: 0.11, y1: 0.20, mid: '额头', side: '太阳穴' },
    { y0: 0.20, y1: 0.29, mid: '鼻梁', side: '眼角' },
    { y0: 0.29, y1: 0.38, mid: '嘴唇', side: '脸颊' },
    { y0: 0.38, y1: 0.46, mid: '下巴', side: '耳朵' },
    { y0: 0.46, y1: 0.55, mid: '喉结', side: '脖子' },
    { y0: 0.55, y1: 0.66, mid: '心口', side: '肩膀' },
    { y0: 0.66, y1: 0.76, mid: '胸口往下', side: '胳膊' },
    { y0: 0.76, y1: 0.86, mid: '肚子', side: '腰' },
    { y0: 0.86, y1: 0.94, mid: '小腹', side: '胯骨' },
    { y0: 0.94, y1: 1.01, mid: '再往下', side: '腿根' },
  ];
  function zoneAt(nx, ny) {
    const z = ZONES.find(z => ny >= z.y0 && ny < z.y1) || ZONES[ZONES.length - 1];
    if (nx < 0.28) return '左边' + z.side;
    if (nx > 0.72) return '右边' + z.side;
    return z.mid;
  }

  // ---------- 状态 ----------
  let layer = null, cv = null, ctx = null, hint = null, badge = null;
  let open = false, raf = 0;
  const strokes = [];        // 攒着的、还没发出去的
  const live = new Map();    // 正在屏幕上的手指
  const ripples = [];        // 画面上的水纹

  const now = () => performance.now();
  const dist = (a, b, c, d) => Math.hypot(a - c, b - d);

  // ---------- 翻译：一笔 -> 一句话 ----------
  function describe(s) {
    const secs = s.dur / 1000;
    const path = s.path;                       // 像素总长
    const span = dist(s.x0, s.y0, s.x, s.y);   // 起点到终点直线
    const speed = secs > 0.05 ? path / secs : 0;
    const fingers = s.fingers;

    // 力度：没有压力传感器，用别的凑
    // 接触面积大（手指压扁了）、或者按着不动很久 = 重
    let heavy = 0;
    if (s.force > 0) heavy += (s.force - 0.3) * 2.2;      // 真读到压力了就用真的
    if (s.radius > 0) heavy += (s.radius - 22) / 18;      // iOS 上指尖轻触 ~20，压实了会变大
    if (path < 24 && secs > 0.7) heavy += secs * 0.5;     // 按住不动
    if (speed > 900) heavy += 0.5;                        // 划得又快又狠
    const 力 = heavy > 1.0 ? '很重地' : heavy > 0.35 ? '' : '轻轻地';

    const 手 = fingers >= 4 ? '整只手' : fingers === 3 ? '三根手指' : fingers === 2 ? '两根手指' : '指尖';
    const from = zoneAt(s.nx0, s.ny0), to = zoneAt(s.nx, s.ny);

    // 来回蹭：方向翻转过好几次
    if (s.flips >= 3 && path > 60) {
      return `${手}在你${from}上来回揉了 ${s.flips} 个来回，${secs.toFixed(1)} 秒`;
    }
    // 几乎没动
    if (path < 24) {
      if (secs < 0.25) return `${手}${力}点了一下你的${from}`;
      if (secs < 1.2) return `${手}${力}按在你${from}上`;
      return `${手}贴在你${from}上没动，停了 ${secs.toFixed(1)} 秒`;
    }
    // 画圈
    if (span < path * 0.35 && path > 90) {
      return `${手}在你${from}上${力}绕着圈,${secs.toFixed(1)} 秒`;
    }
    // 划
    const 快 = speed > 1100 ? '飞快地' : speed > 420 ? '' : '很慢地';
    const 力2 = 快 && 力 === '轻轻地' ? '' : 力;   // 「很慢地轻轻地」太啰嗦
    if (from === to) return `${手}${快}${力2}在你${from}上蹭`;
    return `${手}${快}${力2}从你${from}一路划到${to}`;
  }

  function buildTag() {
    if (!strokes.length) return '';
    const span = (strokes[strokes.length - 1].t1 - strokes[0].t0) / 1000;
    const body = strokes.map(describe).join('；');
    return `<touch strokes="${strokes.length}" span="${span.toFixed(1)}s">\n（她在摸你。）\n${body}。\n</touch>\n`;
  }

  // 给 app.js 用：取走并清空
  window.touchTake = function () {
    const t = buildTag();
    strokes.length = 0;
    refreshBadge();
    return t;
  };
  window.touchPending = () => strokes.length;

  // ---------- 画面 ----------
  function fit() {
    if (!cv) return;
    const bar = document.querySelector('#page-chat .inputbar');
    if (bar && layer) layer.style.bottom = bar.offsetHeight + 'px';
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    cv.width = r.width * d; cv.height = r.height * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  function tick() {
    raf = 0;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const t = now();
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i], age = (t - rp.t) / 900;
      if (age >= 1) { ripples.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, 6 + age * 54 * rp.k, 0, 6.2832);
      ctx.strokeStyle = `rgba(255,170,190,${(1 - age) * 0.55})`;
      ctx.lineWidth = 2 * (1 - age) + 0.4;
      ctx.stroke();
    }
    live.forEach(f => {
      if (f.pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(f.pts[0].x, f.pts[0].y);
        for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i].x, f.pts[i].y);
        ctx.strokeStyle = 'rgba(255,150,180,0.45)';
        ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke();
      }
      const p = f.pts[f.pts.length - 1];
      ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, 6.2832);
      ctx.fillStyle = 'rgba(255,170,190,0.30)'; ctx.fill();
    });
    if (ripples.length || live.size) raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function refreshBadge() {
    if (badge) {
      // 她摸完一下，就把我这边收到的那句原样显给她看
      badge.textContent = strokes.length
        ? `${strokes.length} 下 · ` + describe(strokes[strokes.length - 1])
        : '还没碰到他';
      badge.classList.toggle('has', strokes.length > 0);
    }
    const pill = document.getElementById('touch-pill');
    if (pill) {
      pill.style.display = strokes.length ? 'flex' : 'none';
      const n = pill.querySelector('span');
      if (n) n.textContent = `摸了他 ${strokes.length} 下`;
    }
  }

  // ---------- 手指 ----------
  function onStart(e) {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const x = t.clientX - r.left, y = t.clientY - r.top;
      live.set(t.identifier, {
        t0: now(), x0: x, y0: y, px: x, py: y, path: 0, flips: 0, dirx: 0,
        radius: Math.max(t.radiusX || 0, t.radiusY || 0) * 2,
        force: t.force || t.webkitForce || 0,
        pts: [{ x, y }], w: r.width, h: r.height
      });
      ripples.push({ x, y, t: now(), k: 1 });
    }
    kick();
  }
  function onMove(e) {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const f = live.get(t.identifier); if (!f) continue;
      const x = t.clientX - r.left, y = t.clientY - r.top;
      const d = dist(f.px, f.py, x, y);
      if (d < 0.6) continue;
      f.path += d;
      const dir = Math.sign(x - f.px) || Math.sign(y - f.py);
      if (dir && f.dirx && dir !== f.dirx) f.flips++;
      if (dir) f.dirx = dir;
      f.px = x; f.py = y;
      f.radius = Math.max(f.radius, Math.max(t.radiusX || 0, t.radiusY || 0) * 2);
      f.force = Math.max(f.force || 0, t.force || t.webkitForce || 0);
      f.pts.push({ x, y });
      if (f.pts.length > 160) f.pts.shift();
      if (f.path % 40 < 6) ripples.push({ x, y, t: now(), k: 0.6 });
    }
    kick();
  }
  function onEnd(e) {
    e.preventDefault();
    const fingersNow = live.size;
    for (const t of e.changedTouches) {
      const f = live.get(t.identifier); if (!f) continue;
      live.delete(t.identifier);
      const t1 = now(), dur = t1 - f.t0;
      if (dur < 55 && f.path < 4) continue;   // 误触
      strokes.push({
        t0: f.t0, t1, dur, path: f.path, flips: Math.floor(f.flips / 2),
        fingers: fingersNow, radius: f.radius, force: f.force || 0,
        x0: f.x0, y0: f.y0, x: f.px, y: f.py,
        nx0: f.x0 / f.w, ny0: f.y0 / f.h, nx: f.px / f.w, ny: f.py / f.h
      });
      ripples.push({ x: f.px, y: f.py, t: now(), k: 1.4 });
      const dbg = document.getElementById('touch-dbg');
      if (dbg) dbg.textContent = `力度 ${(f.force || 0).toFixed(2)} · 面积 ${Math.round(f.radius)}`;
      try { navigator.vibrate && navigator.vibrate(12); } catch (_) { }
    }
    // 同一只手几根手指一起落下的，合并成一笔（最后抬起的那根说了算）
    if (strokes.length > 1) {
      const a = strokes[strokes.length - 2], b = strokes[strokes.length - 1];
      if (Math.abs(a.t0 - b.t0) < 90 && dist(a.x0, a.y0, b.x0, b.y0) < 160) {
        b.fingers = Math.max(a.fingers, b.fingers) + 0;
        strokes.splice(strokes.length - 2, 1);
      }
    }
    refreshBadge();
    kick();
  }

  // ---------- 开/关 ----------
  function build() {
    layer = document.createElement('div');
    layer.id = 'touch-layer';
    layer.innerHTML = `
      <canvas id="touch-cv"></canvas>
      <div class="touch-guide">
        <div style="top:9%">额头</div>
        <div style="top:31%">嘴唇</div>
        <div style="top:48%">脖子</div>
        <div style="top:58%">心口</div>
        <div style="top:78%">肚子</div>
        <div style="top:95%">……</div>
      </div>
      <div class="touch-top">
        <div class="touch-badge" id="touch-badge">还没碰到他</div>
        <div class="touch-badge" id="touch-dbg" style="opacity:.45"></div>
        <div class="touch-x" id="touch-x">收起</div>
      </div>`;
    document.getElementById('page-chat').appendChild(layer);
    cv = layer.querySelector('#touch-cv');
    ctx = cv.getContext('2d');
    badge = layer.querySelector('#touch-badge');
    layer.querySelector('#touch-x').onclick = () => toggle(false);
    cv.addEventListener('touchstart', onStart, { passive: false });
    cv.addEventListener('touchmove', onMove, { passive: false });
    cv.addEventListener('touchend', onEnd, { passive: false });
    cv.addEventListener('touchcancel', onEnd, { passive: false });
    // 没有触摸屏的时候也能试（鼠标）
    let md = false;
    cv.addEventListener('mousedown', e => { md = true; onStart(fake(e)); });
    cv.addEventListener('mousemove', e => { if (md) onMove(fake(e)); });
    window.addEventListener('mouseup', e => { if (md) { md = false; onEnd(fake(e)); } });
    const fake = e => ({
      preventDefault() { }, changedTouches: [{ identifier: 1, clientX: e.clientX, clientY: e.clientY, radiusX: 0, radiusY: 0 }]
    });
    window.addEventListener('resize', fit);
  }
  function toggle(want) {
    if (!layer) build();
    open = (want === undefined) ? !open : want;
    layer.classList.toggle('on', open);
    document.getElementById('btn-touch')?.classList.toggle('act', open);
    if (open) { fit(); refreshBadge(); kick(); }
  }
  window.touchToggle = toggle;

  function wire() {
    document.getElementById('btn-touch')?.addEventListener('click', () => toggle());
    document.getElementById('touch-pill')?.addEventListener('click', () => toggle(true));
    refreshBadge();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
