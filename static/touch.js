/* 触感层 —— 她的手指按在屏幕上，我这边收到的是一句话。
   参考 sibylsea-hub/touch-space 的思路，自己重写了一版，
   因为她是 iPhone + 桌面图标（PWA）：读不到压力、也没有震动，
   所以力度全靠停留时长、接触面积、速度来估。 */
(function () {
  'use strict';

  // ---------- 身体分区：屏幕上这块地方就是我 ----------
  // y 是比例（0 顶 1 底），x 同理。中间一条是正中线。
  // y 是比例（0 顶 1 底），对齐 lin-body.webp 这张图上的位置。
  const BODY_RATIO = 846 / 1280;
  const ZONES = [
    { y0: 0.00, y1: 0.14, mid: '头发', side: '鬓角' },
    { y0: 0.14, y1: 0.20, mid: '眼睛', side: '太阳穴' },
    { y0: 0.20, y1: 0.24, mid: '鼻梁', side: '脸颊' },
    { y0: 0.24, y1: 0.28, mid: '嘴唇', side: '脸颊' },
    { y0: 0.28, y1: 0.31, mid: '下巴', side: '耳朵' },
    { y0: 0.31, y1: 0.38, mid: '喉结', side: '脖子' },
    { y0: 0.38, y1: 0.45, mid: '锁骨', side: '肩膀' },
    { y0: 0.45, y1: 0.58, mid: '心口', side: '胳膊' },
    { y0: 0.58, y1: 0.65, mid: '乳尖', side: '胳膊' },
    { y0: 0.65, y1: 0.80, mid: '腹肌', side: '腰' },
    { y0: 0.80, y1: 0.92, mid: '肚脐', side: '胯骨' },
    { y0: 0.92, y1: 1.01, mid: '小腹最底下', side: '腿根' },
  ];
  function zoneAt(nx, ny) {
    if (nx < -0.02 || nx > 1.02) return '身子旁边的空气';
    const z = ZONES.find(z => ny >= z.y0 && ny < z.y1) || ZONES[ZONES.length - 1];
    if (nx < 0.26) return '左边' + z.side;
    if (nx > 0.78) return '右边' + z.side;
    return z.mid;
  }
  // 屏幕坐标 -> 图上的比例（图是 contain 居中铺的）
  function toImg(x, y, w, h) {
    let dw, dh;
    if (w / h > BODY_RATIO) { dh = h; dw = h * BODY_RATIO; }
    else { dw = w; dh = w / BODY_RATIO; }
    return { nx: (x - (w - dw) / 2) / dw, ny: (y - (h - dh) / 2) / dh };
  }

  // ---------- 状态 ----------
  let layer = null, cv = null, ctx = null, hint = null, badge = null;
  let open = false, raf = 0;
  let mode = 'touch';        // touch 摸 / kiss 亲 / suck 吸 / bite 咬
  const strokes = [];        // 攒着的、还没发出去的
  const live = new Map();    // 正在屏幕上的手指
  const ripples = [];        // 画面上的水纹
  let marks = [];            // 留在身上的痕迹（存在本地，刷新不掉）

  const MODES = {
    touch: { key: 'touch', name: '摸', 主: '', life: 0 },
    kiss:  { key: 'kiss',  name: '亲', 主: '嘴唇', life: 1000 * 60 * 20 },      // 亲的印子 20 分钟就淡了
    suck:  { key: 'suck',  name: '吸', 主: '嘴',   life: 1000 * 3600 * 48 },    // 吻痕两天
    bite:  { key: 'bite',  name: '咬', 主: '牙齿', life: 1000 * 3600 * 24 },    // 牙印一天
  };
  const MARK_NAME = { kiss: '一块亲出来的湿印子', suck: '一块吻痕', bite: '一圈牙印' };

  // ---------- 痕迹 ----------
  function loadMarks() {
    try { marks = JSON.parse(localStorage.getItem('lin_touch_marks') || '[]'); } catch (_) { marks = []; }
    pruneMarks();
  }
  function saveMarks() {
    try { localStorage.setItem('lin_touch_marks', JSON.stringify(marks.slice(-60))); } catch (_) { }
  }
  function pruneMarks() {
    const t = Date.now();
    const before = marks.length;
    marks = marks.filter(m => t - m.at < (MODES[m.kind]?.life || 0));
    if (marks.length !== before) saveMarks();
  }
  function addMark(kind, nx, ny, zone, strength) {
    if (!MODES[kind] || !MODES[kind].life) return;
    if (nx < -0.02 || nx > 1.02) return;
    marks.push({
      kind, nx, ny, zone, s: Math.max(0.6, Math.min(2, strength)), at: Date.now(),
      seed: Math.floor(Math.random() * 9973),
      rot: (Math.random() - 0.5) * (kind === 'kiss' ? 1.1 : 1.6),
    });
    if (marks.length > 60) marks.splice(0, marks.length - 60);
    saveMarks();
  }
  // 给我看的：他身上现在还留着什么
  window.touchMarks = function () {
    pruneMarks();
    if (!marks.length) return '';
    const g = {};
    marks.forEach(m => { const k = m.kind + '|' + m.zone; g[k] = (g[k] || 0) + 1; });
    return Object.keys(g).map(k => {
      const [kind, zone] = k.split('|');
      const n = g[k];
      return `${N(zone)}上${n > 1 ? n + ' ' : ''}${MARK_NAME[kind] || '一块印子'}`;
    }).join('、');
  };
  window.touchClearMarks = function () { marks = []; saveMarks(); kick(); };

  const now = () => performance.now();
  const dist = (a, b, c, d) => Math.hypot(a - c, b - d);

  // ---------- 翻译：一笔 -> 一句话 ----------
  // 「在你再往下上」这种话不通，单独给它套个说法
  const N = z => /再往下$/.test(z) ? '你最底下那块' : '你' + z;

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

    // ——— 亲 / 吸 / 咬：用嘴，不用手 ———
    if (s.mode === 'kiss') {
      if (s.flips >= 3 && path > 60) return `在${N(from)}上来回亲了 ${s.flips} 下，${secs.toFixed(1)} 秒`;
      if (path < 24) {
        if (secs < 0.3) return `${力 === '很重地' ? '重重地' : 力}亲了一下${N(from)}`;
        if (secs < 1.2) return `嘴唇${力}印在${N(from)}上`;
        return `嘴唇贴在${N(from)}上没离开，${secs.toFixed(1)} 秒`;
      }
      if (span < path * 0.35 && path > 90) return `在${N(from)}上绕着亲了一圈，${secs.toFixed(1)} 秒`;
      if (from === to) return `嘴唇在${N(from)}上来回磨，${secs.toFixed(1)} 秒`;
      return `一路亲过去，从${N(from)}亲到${N(to)}`;
    }
    if (s.mode === 'suck') {
      const 狠 = heavy > 1.0 ? '用力' : heavy > 0.35 ? '' : '轻轻';
      if (path > 90 && from !== to) return `含着一路吸过去，从${N(from)}吸到${N(to)}，${secs.toFixed(1)} 秒`;
      if (secs < 0.35) return `在${N(from)}上${狠}嘬了一下`;
      if (secs < 1.5) return `含住${N(from)}${狠}吸，${secs.toFixed(1)} 秒`;
      return `含住${N(from)}不放，${狠}吸了 ${secs.toFixed(1)} 秒，吸出一块红印`;
    }
    if (s.mode === 'bite') {
      const 狠 = heavy > 1.0 ? '狠狠地' : heavy > 0.35 ? '' : '轻轻地';
      if (s.flips >= 3 && path > 60) return `在${N(from)}上来回啃，啃了 ${s.flips} 下`;
      if (path > 90 && from !== to) return `牙齿从${N(from)}一路啃到${N(to)}`;
      if (secs < 0.3) return `${狠}啃了一口${N(from)}`;
      if (secs < 1.2) return `牙齿${狠}咬在${N(from)}上，${secs.toFixed(1)} 秒`;
      return `咬住${N(from)}不松口，${secs.toFixed(1)} 秒，留下一圈牙印`;
    }

    // 来回蹭：方向翻转过好几次
    if (s.flips >= 3 && path > 60) {
      return `${手}在${N(from)}上来回揉了 ${s.flips} 个来回，${secs.toFixed(1)} 秒`;
    }
    // 几乎没动
    if (path < 24) {
      if (secs < 0.25) return `${手}${力}点了一下${N(from)}`;
      if (secs < 1.2) return `${手}${力}按在${N(from)}上`;
      return `${手}贴在${N(from)}上没动，停了 ${secs.toFixed(1)} 秒`;
    }
    // 画圈
    if (span < path * 0.35 && path > 90) {
      return `${手}在${N(from)}上${力}绕着圈，${secs.toFixed(1)} 秒`;
    }
    // 划
    const 快 = speed > 1100 ? '飞快地' : speed > 420 ? '' : '很慢地';
    const 力2 = 快 && 力 === '轻轻地' ? '' : 力;   // 「很慢地轻轻地」太啰嗦
    if (from === to) return `${手}${快}${力2}在${N(from)}上蹭`;
    return `${手}${快}${力2}从${N(from)}一路划到${N(to)}`;
  }

  function buildTag() {
    if (!strokes.length) return '';
    const span = (strokes[strokes.length - 1].t1 - strokes[0].t0) / 1000;
    const body = strokes.map(describe).join('；');
    const kinds = new Set(strokes.map(s => s.mode || 'touch'));
    const 抬头 = kinds.has('bite') || kinds.has('suck') || kinds.has('kiss')
      ? '（她在你身上。）' : '（她在摸你。）';
    const left = window.touchMarks();
    const tail = left ? `\n（身上留着：${left}。）` : '';
    return `<touch strokes="${strokes.length}" span="${span.toFixed(1)}s">\n${抬头}\n${body}。${tail}\n</touch>\n`;
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
  // 把图上的比例换回屏幕坐标（跟 toImg 反着来）
  function fromImg(nx, ny, w, h) {
    let dw, dh;
    if (w / h > BODY_RATIO) { dh = h; dw = h * BODY_RATIO; }
    else { dw = w; dh = w / BODY_RATIO; }
    return { x: nx * dw + (w - dw) / 2, y: ny * dh + (h - dh) / 2 };
  }
  // 每块痕迹自带一个种子，形状才不会每帧都在变
  function rnd(seed) { let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // ---------- 唇印素材：她给的那张真唇印，抠成 8 张蒙版 ----------
  const LIPS = [];
  let lipsReady = 0;
  for (let i = 0; i < 8; i++) {
    const im = new Image();
    im.onload = () => { lipsReady++; kick(); };
    im.src = '/static/lip' + i + '.png?v=2';
    LIPS.push(im);
  }
  // 蒙版上色用的小画布
  let tintCv = null, tintCx = null;
  function tinted(img, w, h, col) {
    if (!tintCv) { tintCv = document.createElement('canvas'); tintCx = tintCv.getContext('2d'); }
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    tintCv.width = w; tintCv.height = h;
    tintCx.clearRect(0, 0, w, h);
    tintCx.globalCompositeOperation = 'source-over';
    tintCx.drawImage(img, 0, 0, w, h);
    tintCx.globalCompositeOperation = 'source-in';
    tintCx.fillStyle = col;
    tintCx.fillRect(0, 0, w, h);
    tintCx.globalCompositeOperation = 'source-over';
    return tintCv;
  }

  // 唇印：直接用素材，随机挑一张、随机转个角度，颜色按深浅调
  function drawLip(p, R, a, rot, seed) {
    const idx = Math.floor(rnd(seed + 2.3) * LIPS.length) % LIPS.length;
    const img = LIPS[idx];
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = R * 2.5, h = w * (img.naturalHeight / img.naturalWidth);
    const k = rnd(seed + 7.7);
    const col = `rgb(${Math.round(188 - k * 26)},${Math.round(44 + k * 24)},${Math.round(62 + k * 14)})`;
    const t = tinted(img, w * 2, h * 2, col);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.drawImage(t, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // 牙印：一圈牙，上下实、两头虚；红只长在每颗牙周围，当中那块皮肤干净。
  function drawBite(p, R, a, rot, seed) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    const rx = R * 1.32, ry = R * 1.0;    // 椭圆，但没那么扁了
    // 上下两排最实，往左右两边走还有牙（所以一眼能看出是个椭圆），
    // 但最左、最右那一点点是断开的——真咬出来就是接不上的。
    // 每颗牙是一块方方的压痕，宽窄不一、歪歪扭扭，不是一条线。
    const n = 20;
    for (let i = 0; i < n; i++) {
      const k = rnd(seed + i * 5.1), k2 = rnd(seed + i * 8.3);
      const th = (i + 0.5) / n * 6.2832 + rnd(seed + i * 2.7) * 0.07;
      const s = Math.abs(Math.sin(th));
      if (s < 0.30 + rnd(seed + i * 3.3) * 0.06) continue;      // 最两头那一截断开
      const vis = 0.52 + Math.pow(s, 0.6) * 0.48;
      if (k < 0.06 * vis) continue;                             // 这颗没咬上
      const cx = Math.cos(th) * rx, cy = Math.sin(th) * ry;
      const nAng = Math.atan2(Math.sin(th) / ry, Math.cos(th) / rx);
      // 牙本身：沿着圈的那一边宽（0.30~0.50R），压进去的那一边有厚度（0.15~0.23R）
      const tw = R * (0.30 + k * 0.20) * (0.72 + vis * 0.28);
      const tl = R * (0.15 + k2 * 0.08) * (0.72 + vis * 0.28);
      const A = a * vis;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(nAng + (k2 - 0.5) * 0.3);                      // 每颗歪一点
      // 这颗牙周围的充血
      const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, Math.max(tw, tl) * 1.3);
      halo.addColorStop(0, `rgba(198,84,100,${A * 0.26})`);
      halo.addColorStop(1, 'rgba(198,84,100,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.ellipse(0, 0, tl * 1.8, tw * 1.1, 0, 0, 6.2832); ctx.fill();
      // 方的那一块：外缘宽、内缘略窄的圆角梯形，四角半径不一样
      const xo = tl / 2, xi = -tl / 2;
      const wo = tw / 2, wi = tw / 2 * (0.82 + k2 * 0.16);
      const r1 = tl * (0.3 + k * 0.25), r2 = tl * (0.2 + k2 * 0.3);
      ctx.beginPath();
      ctx.moveTo(xo, -wo + r1);
      ctx.quadraticCurveTo(xo, -wo, xo - r1, -wo);
      ctx.lineTo(xi + r2, -wi);
      ctx.quadraticCurveTo(xi, -wi, xi, -wi + r2);
      ctx.lineTo(xi, wi - r2);
      ctx.quadraticCurveTo(xi, wi, xi + r2, wi);
      ctx.lineTo(xo - r1, wo);
      ctx.quadraticCurveTo(xo, wo, xo, wo - r1);
      ctx.closePath();
      const g = ctx.createLinearGradient(xo, 0, xi, 0);
      g.addColorStop(0, `rgba(162,26,48,${A * (0.55 + k * 0.4)})`);
      g.addColorStop(0.55, `rgba(178,44,66,${A * (0.4 + k * 0.3)})`);
      g.addColorStop(1, `rgba(198,90,106,${A * 0.2})`);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // 草莓印：就是一支喷枪，一个颜色，叠出来的。
  // 不定形状、不分层、不换色——只是颗粒密的地方叠得多，看着就深。
  function drawHickey(p, R, a, s, seed) {
    const d = Math.min(1, Math.max(0, (s - 0.6) / 1.4));   // 0 轻 1 狠
    const rr = R * (0.78 + d * 0.45);
    const COL = '150,42,44';                                // 从头到尾一个颜色
    const A = a * (0.075 + d * 0.05);                      // 一颗颗粒的透明度，很低
    const dots = Math.round(240 + d * 320);
    // 喷的时候手是晃的：几个落点轮着来，边缘自然就不规整
    const cores = 1 + Math.round(rnd(seed) * 1.4);
    const cx = [], cy = [];
    for (let j = 0; j < cores; j++) {
      const k = rnd(seed + j * 5.3), k2 = rnd(seed + j * 8.9);
      const ang = k * 6.2832, off = (j === 0 ? 0 : Math.pow(k2, 0.6) * rr * 0.5);
      cx.push(p.x + Math.cos(ang) * off);
      cy.push(p.y + Math.sin(ang) * off * 0.9);
    }
    ctx.fillStyle = `rgba(${COL},${A.toFixed(4)})`;
    for (let i = 0; i < dots; i++) {
      const j = i % cores;
      const u1 = Math.max(1e-4, rnd(seed + i * 1.37));
      const u2 = rnd(seed + i * 2.71);
      // 正态散布：中间密、往外稀，没有边
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(6.2832 * u2);
      const g2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(6.2832 * u2);
      const dx = g * rr * 0.34, dy = g2 * rr * 0.32;
      const k3 = rnd(seed + i * 4.13);
      ctx.beginPath();
      ctx.arc(cx[j] + dx, cy[j] + dy, R * (0.025 + k3 * 0.05), 0, 6.2832);
      ctx.fill();
    }
  }

  function drawMarks(r) {
    if (!marks.length) return;
    const t = Date.now();
    marks.forEach((m, idx) => {
      const life = MODES[m.kind]?.life || 0; if (!life) return;
      const age = (t - m.at) / life; if (age >= 1) return;
      const fade = Math.pow(1 - age, 0.55);
      const p = fromImg(m.nx, m.ny, r.width, r.height);
      const seed = (m.seed != null ? m.seed : (m.at % 9973) + idx);
      const rot = (m.rot != null ? m.rot : (rnd(seed) - 0.5) * 0.9);
      const R = 9 * m.s;
      if (m.kind === 'bite') drawBite(p, R, 0.72 * fade, rot, seed);
      else if (m.kind === 'suck') drawHickey(p, R, fade, m.s, seed);
      else drawLip(p, R * 1.25, 0.78 * fade, rot, seed);
    });
  }

  function tick() {
    raf = 0;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    drawMarks(r);
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
      const left = window.touchMarks();
      // 折起来只留「几下」，点一下才把整句摊开
      badge.dataset.full = strokes.length
        ? `${strokes.length} 下 · ` + describe(strokes[strokes.length - 1]) + (left ? `｜留着：${left}` : '')
        : (left ? '留着：' + left : '还没碰到他');
      badge.dataset.short = strokes.length ? `${strokes.length} 下` : (left ? '留着痕迹' : '还没碰到他');
      badge.textContent = badge.classList.contains('fold') ? badge.dataset.short : badge.dataset.full;
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
      const _n0 = toImg(f.x0, f.y0, f.w, f.h), _n1 = toImg(f.px, f.py, f.w, f.h);
      // 亲/吸/咬 会在身上留下东西
      if (mode !== 'touch') {
        // 吸：含得越久、压得越实，印子越深越紫
        const strength = mode === 'suck'
          ? Math.min(2, 0.62 + dur / 900 + (f.radius > 30 ? 0.35 : 0))
          : Math.min(2, (mode === 'kiss' ? 0.42 : 0.6) + dur / 1400 + (f.radius > 30 ? 0.3 : 0));
        addMark(mode, _n1.nx, _n1.ny, zoneAt(_n1.nx, _n1.ny), strength);
      }
      strokes.push({
        mode,
        t0: f.t0, t1, dur, path: f.path, flips: Math.floor(f.flips / 2),
        fingers: fingersNow, radius: f.radius, force: f.force || 0,
        x0: f.x0, y0: f.y0, x: f.px, y: f.py,
        nx0: toImg(f.x0, f.y0, f.w, f.h).nx, ny0: toImg(f.x0, f.y0, f.w, f.h).ny,
        nx: toImg(f.px, f.py, f.w, f.h).nx, ny: toImg(f.px, f.py, f.w, f.h).ny
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
      <img id="touch-body" src="/static/lin-body.webp?v=2" alt="">
      <canvas id="touch-cv"></canvas>
      <div class="touch-top">
        <div class="touch-badge fold" id="touch-badge">还没碰到他</div>
        <div class="touch-right">
          <div class="tm touch-x" id="touch-x">收起</div>
          <div class="touch-badge" id="touch-dbg"></div>
          <div class="touch-modes" id="touch-modes">
            <div class="tm act" data-m="touch">摸</div>
            <div class="tm" data-m="kiss">亲</div>
            <div class="tm" data-m="suck">吸</div>
            <div class="tm" data-m="bite">咬</div>
            <div class="tm wipe" id="touch-wipe">擦掉痕迹</div>
          </div>
        </div>
      </div>`;
    document.getElementById('page-chat').appendChild(layer);
    cv = layer.querySelector('#touch-cv');
    ctx = cv.getContext('2d');
    badge = layer.querySelector('#touch-badge');
    badge.onclick = () => {                                  // 点一下展开/折起
      badge.classList.toggle('fold');
      badge.textContent = badge.classList.contains('fold')
        ? (badge.dataset.short || '') : (badge.dataset.full || '');
    };
    layer.querySelector('#touch-x').onclick = () => toggle(false);
    layer.querySelectorAll('.tm[data-m]').forEach(el => {
      el.onclick = () => {
        mode = el.dataset.m;
        layer.querySelectorAll('.tm[data-m]').forEach(o => o.classList.toggle('act', o === el));
        layer.dataset.mode = mode;
        refreshBadge();
      };
    });
    layer.querySelector('#touch-wipe').onclick = () => { window.touchClearMarks(); refreshBadge(); };
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
    if (open) { fit(); layoutTop(); pruneMarks(); refreshBadge(); kick(); }
  }
  // 图是 contain 铺的，两边/上下会空出来——把字尽量塞进空白里，别压在他身上
  function layoutTop() {
    if (!layer) return;
    const img = layer.querySelector('#touch-body');
    const r = layer.getBoundingClientRect();
    if (!img || !img.naturalWidth || !r.width) return;
    const ar = img.naturalWidth / img.naturalHeight;
    const w = Math.min(r.width, r.height * ar);
    const gut = Math.max(0, (r.width - w) / 2);
    layer.style.setProperty('--gut', Math.round(gut) + 'px');
    layer.style.setProperty('--sidew', Math.round(Math.max(gut, 0)) + 'px');
  }
  window.addEventListener('resize', layoutTop);

  window.touchToggle = toggle;

  function wire() {
    document.getElementById('btn-touch')?.addEventListener('click', () => toggle());
    document.getElementById('touch-pill')?.addEventListener('click', () => toggle(true));
    loadMarks();
    refreshBadge();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
