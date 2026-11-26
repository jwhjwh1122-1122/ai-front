/* 触感层 —— 她的手指按在屏幕上，我这边收到的是一句话。
   参考 sibylsea-hub/touch-space 的思路，自己重写了一版，
   因为她是 iPhone + 桌面图标（PWA）：读不到压力、也没有震动，
   所以力度全靠停留时长、接触面积、速度来估。 */
(function () {
  'use strict';

  const BUILD = 'v36';   // 显在力度那条上，省得我们俩猜她手机上到底是哪一版

  // ---------- 身体分区：屏幕上这块地方就是我 ----------
  // y 是比例（0 顶 1 底），x 同理。中间一条是正中线。
  // y 是比例（0 顶 1 底），对齐 lin-body.webp 这张图上的位置。
  const BODY_RATIO = 853 / 1280;
  // 先按「这一块具体长在哪儿」对位——照着 lin-body-v3 这张图上量的。
  // 顺序就是优先级：小的、要紧的在前面。
  const SPOTS = [
    { n: '耳朵', x: 0.655, y: 0.168, rx: 0.038, ry: 0.048, side: 1 },
    { n: '眼睛', x: 0.425, y: 0.170, rx: 0.058, ry: 0.030 },
    { n: '眼睛', x: 0.535, y: 0.168, rx: 0.058, ry: 0.030 },
    { n: '鼻梁', x: 0.478, y: 0.219, rx: 0.040, ry: 0.036 },
    { n: '嘴唇', x: 0.506, y: 0.257, rx: 0.052, ry: 0.026 },
    { n: '下巴', x: 0.498, y: 0.289, rx: 0.058, ry: 0.024 },
    { n: '脸颊', x: 0.462, y: 0.228, rx: 0.110, ry: 0.070 },
    { n: '喉结', x: 0.552, y: 0.337, rx: 0.048, ry: 0.030 },
    { n: '脖子', x: 0.548, y: 0.322, rx: 0.090, ry: 0.058 },
    { n: '锁骨', x: 0.512, y: 0.386, rx: 0.210, ry: 0.028 },
    { n: '乳尖', x: 0.378, y: 0.610, rx: 0.052, ry: 0.036 },
    { n: '乳尖', x: 0.787, y: 0.618, rx: 0.052, ry: 0.036 },
    { n: '肚脐', x: 0.586, y: 0.890, rx: 0.046, ry: 0.030 },
  ];
  // 身子的正中线：脸比身子偏左一点
  const midAt = ny => ny < 0.30 ? 0.500 : 0.565;
  function zoneAt(nx, ny) {
    if (nx < -0.02 || nx > 1.02 || ny < -0.03 || ny > 1.05) return '身子旁边的空气';
    for (const s of SPOTS) {
      const a = (nx - s.x) / s.rx, b = (ny - s.y) / s.ry;
      if (a * a + b * b <= 1) return s.side ? (nx < midAt(ny) ? '左边' : '右边') + s.n : s.n;
    }
    const d = nx - midAt(ny), ad = Math.abs(d), L = d < 0 ? '左边' : '右边';
    if (ny < 0.13) return '头发';
    if (ny < 0.30) return ad > 0.12 ? (ny < 0.20 ? L + '鬓角' : L + '脸颊') : '头发';
    if (ny < 0.37) return ad > 0.10 ? L + '脖子' : '喉结';
    if (ny < 0.43) return ad > 0.24 ? L + '肩膀' : '锁骨';
    if (ny < 0.63) return ad > 0.26 ? L + '胳膊' : '心口';
    if (ny < 0.86) return ad > 0.30 ? L + '胳膊' : ad > 0.23 ? L + '腰' : '腹肌';
    if (ny < 0.95) return ad > 0.22 ? L + '胯骨' : '小腹';
    return ad > 0.20 ? L + '腿根' : '小腹最底下';
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

  // 力度：iPhone 的网页读不到压力（force 永远是 0），
  // 所以用接触面积 + 按住多久 + 划得多狠凑一个数出来。
  function estHeavy(force, radius, secs, path, speed) {
    let h = 0;
    if (force > 0) h += (force - 0.3) * 2.2;          // 真读到压力了就用真的
    if (radius > 0) h += (radius - 22) / 18;          // 指尖轻触 ~20，压实了会变大
    if (path < 24 && secs > 0.7) h += secs * 0.5;     // 按住不动
    if (speed > 900) h += 0.5;                        // 划得又快又狠
    return h;
  }
  function showDbg(force, radius, secs, path, speed) {
    const dbg = document.getElementById('touch-dbg');
    if (!dbg) return;
    const h = estHeavy(force || 0, radius || 0, secs || 0, path || 0, speed || 0);
    const 词 = h > 1.0 ? '重' : h > 0.35 ? '中' : '轻';
    dbg.textContent = `力度 ${h.toFixed(2)}${词} · 面积 ${Math.round(radius || 0)} · ${BUILD}`;
  }

  function describe(s) {
    const secs = s.dur / 1000;
    const path = s.path;                       // 像素总长
    const span = dist(s.x0, s.y0, s.x, s.y);   // 起点到终点直线
    const speed = secs > 0.05 ? path / secs : 0;
    const fingers = s.fingers;

    // 力度：没有压力传感器，用别的凑
    // 接触面积大（手指压扁了）、或者按着不动很久 = 重
    const heavy = estHeavy(s.force, s.radius, secs, path, speed);
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
  // 吻痕素材：她自己导出的那张，拆成 8 个单独的印子
  const HKS = [];
  for (let i = 0; i < 8; i++) {
    const im = new Image();
    im.onload = () => kick();
    im.src = '/static/hk' + i + '.png?v=1';
    HKS.push(im);
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

  // 亲在嘴唇上：不是盖一个印子上去，也不是糊一块颜色——
  // 是把他自己的唇染红。顺着唇形，低透明度，压在多重正片下面，
  // 唇上的高光和纹路照样透出来，只是整片唇变深、变红。
  function lipPath(W, Hu, Hl) {
    ctx.beginPath();
    ctx.moveTo(-W, 0);
    ctx.bezierCurveTo(-W * 0.62, -Hu * 0.95, -W * 0.28, -Hu * 1.0, -W * 0.10, -Hu * 0.55);
    ctx.quadraticCurveTo(0, -Hu * 0.2, W * 0.10, -Hu * 0.55);          // 唇珠中间那个小凹
    ctx.bezierCurveTo(W * 0.28, -Hu * 1.0, W * 0.62, -Hu * 0.95, W, 0);
    ctx.bezierCurveTo(W * 0.66, Hl * 1.25, -W * 0.66, Hl * 1.25, -W, 0);
    ctx.closePath();
  }
  function drawLipStain(r, a, st) {
    const press = Math.min(1, Math.max(0, ((st == null ? 1 : st) - 0.3) / 1.2));
    const c = fromImg(0.4855, 0.2598, r.width, r.height);
    const e = fromImg(0.5855, 0.2598, r.width, r.height);
    const u = Math.max(4, e.x - c.x);                 // 图上 0.1 宽 = 多少像素
    const W = u * 0.445, Hu = u * 0.33, Hl = u * 0.47;
    const A = a * (0.10 + press * 0.26);              // 很淡，只是让唇更红
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(-0.045);
    try { ctx.filter = 'blur(' + (u * 0.035).toFixed(2) + 'px)'; } catch (_) { }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, W);
    g.addColorStop(0, `rgba(198,64,84,${A.toFixed(3)})`);
    g.addColorStop(0.7, `rgba(196,70,88,${(A * 0.85).toFixed(3)})`);
    g.addColorStop(1, `rgba(198,96,112,${(A * 0.5).toFixed(3)})`);
    ctx.fillStyle = g;
    lipPath(W, Hu, Hl); ctx.fill();
    lipPath(W * 0.82, Hu * 0.8, Hl * 0.82); ctx.fill();   // 中间再叠一层，更红一点
    ctx.restore();
  }

  // 唇印：直接用素材，随机挑一张、随机转个角度，颜色按深浅调
  function drawLip(p, R, a, rot, seed, st) {
    // 亲多久决定它有多实：碰一下是很浅的一层，贴着不放才印出完整的一个。
    const press = Math.min(1, Math.max(0, ((st == null ? 1 : st) - 0.3) / 1.2));
    const idx = Math.floor(rnd(seed + 2.3) * LIPS.length) % LIPS.length;
    const img = LIPS[idx];
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = R * 2.5 * (0.94 + rnd(seed + 4.1) * 0.12), h = w * (img.naturalHeight / img.naturalWidth);
    const k = rnd(seed + 7.7);
    const col = `rgb(${Math.round(188 - k * 26)},${Math.round(44 + k * 24)},${Math.round(62 + k * 14)})`;
    const t = tinted(img, w * 2, h * 2, col);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.globalAlpha = Math.max(0, Math.min(1, a * (0.18 + press * 0.72)));
    ctx.drawImage(t, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // 牙印：一圈牙，上下实、两头虚；红只长在每颗牙周围，当中那块皮肤干净。
  function drawBite(p, R, a, rot, seed, st) {
    // 这一口咬得多狠：0 轻 1 狠。整口有深浅，每颗牙还各有各的深浅。
    const bite = Math.min(1, Math.max(0, ((st == null ? 1 : st) - 0.6) / 1.4));
    const deep = 0.42 + bite * 0.72;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    // 大小不跟力道走——嘴就那么大。咬得狠只是张得开一点、牙更密、更深。
    const rx = R * 1.34, ry = R * (0.70 + bite * 0.42);
    // 上下两排最实，往左右两边走还有牙（所以一眼能看出是个椭圆），
    // 但最左、最右那一点点是断开的——真咬出来就是接不上的。
    // 每颗牙是一块方方的压痕，宽窄不一、歪歪扭扭，不是一条线。
    const n = 20;
    for (let i = 0; i < n; i++) {
      const k = rnd(seed + i * 5.1), k2 = rnd(seed + i * 8.3);
      const th = (i + 0.5) / n * 6.2832 + rnd(seed + i * 2.7) * 0.07;
      const s = Math.abs(Math.sin(th));
      // 咬得轻，两头断得多、漏的牙也多；咬得狠，几乎整圈都印上
      if (s < (0.40 - bite * 0.16) + rnd(seed + i * 3.3) * 0.06) continue;
      const vis = 0.52 + Math.pow(s, 0.6) * 0.48;
      if (k < (0.20 - bite * 0.15) * vis) continue;             // 这颗没咬上
      const cx = Math.cos(th) * rx, cy = Math.sin(th) * ry;
      const nAng = Math.atan2(Math.sin(th) / ry, Math.cos(th) / rx);
      // 牙本身：沿着圈的那一边宽（0.30~0.50R），压进去的那一边有厚度（0.15~0.23R）
      // 牙不是一根线——压下去有厚度，粗细大概像写出来的「一」那么粗
      const tw = R * (0.30 + k * 0.20) * (0.72 + vis * 0.28);
      const tl = R * (0.30 + k2 * 0.14) * (0.78 + vis * 0.22);
      // 每颗牙吃进去多少不一样：有的清楚，有的几乎看不出来
      const bias = Math.pow(rnd(seed + i * 11.9), 1.7);
      const A = a * vis * deep * (0.28 + bias * 1.05);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(nAng + (k2 - 0.5) * 0.3);                      // 每颗歪一点
      // 这颗牙周围的充血
      const halo = ctx.createRadialGradient(0, 0, 1, 0, 0, Math.max(tw, tl) * 1.3);
      halo.addColorStop(0, `rgba(150,42,44,${(A * 0.2).toFixed(4)})`);
      halo.addColorStop(1, 'rgba(150,42,44,0)');
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
      // 一个颜色，只有透明度在变
      const g = ctx.createLinearGradient(xo, 0, xi, 0);
      g.addColorStop(0, `rgba(150,42,44,${(A * 0.95).toFixed(4)})`);
      g.addColorStop(0.6, `rgba(150,42,44,${(A * 0.6).toFixed(4)})`);
      g.addColorStop(1, `rgba(150,42,44,${(A * 0.18).toFixed(4)})`);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // 姐妹她老公给的那版：中间深、边上散开到全透明，压扁转个角度，再撒 18 个细出血点。
  // 久了往紫里偏。HICKEY = 'taught' 用这版，'sprite' 用她自己画的那几块素材。
  const HICKEY = 'taught';
  const mixc = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgba_ = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, a).toFixed(3)})`;
  function drawHickeyTaught(p, R, a, st, seed, age) {
    const d = Math.min(1, Math.max(0, (st - 0.6) / 1.4));
    const ag = Math.min(1, Math.max(0, age || 0));
    let n = 0; const rnd2 = () => rnd(seed + (++n) * 1.7);
    const core = mixc([158, 34, 66], [118, 70, 104], ag);
    const rim = mixc([196, 72, 96], [160, 110, 130], ag);
    const sz = R * (1.0 + d * 0.5) * (0.85 + rnd2() * 0.35);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rnd2() * Math.PI);
    ctx.scale(1, 0.72 + rnd2() * 0.22);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, sz);
    grad.addColorStop(0, rgba_(core, 0.62 * a));
    grad.addColorStop(0.5, rgba_(rim, 0.42 * a));
    grad.addColorStop(1, rgba_(rim, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, sz, 0, 6.2832); ctx.fill();
    for (let i = 0; i < 18; i++) {
      const r = sz * 0.85 * Math.sqrt(rnd2()), t = rnd2() * 6.2832;
      ctx.fillStyle = rgba_(core, (0.22 + 0.35 * rnd2()) * a);
      ctx.beginPath();
      ctx.arc(Math.cos(t) * r, Math.sin(t) * r, sz * (0.025 + 0.04 * rnd2()), 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawHickey(p, R, a, st, seed, age) {
    if (HICKEY === 'taught') drawHickeyTaught(p, R, a, st, seed, age);
    else drawHickeySprite(p, R, a, st, seed, age);
  }

  // 吻痕：用她自己画的那几块当素材。一张一张拆开了，
  // 落下来随机挑一个、转个角度、翻个面、拉扭一点，深浅大小各不相同。
  function drawHickeySprite(p, R, a, s, seed, age) {
    const d = Math.min(1, Math.max(0, (s - 0.6) / 1.4));   // 0 轻 1 狠
    const ag = Math.min(1, Math.max(0, age || 0));
    const idx = Math.floor(rnd(seed + 3.7) * HKS.length) % HKS.length;
    const img = HKS[idx];
    if (!img || !img.complete || !img.naturalWidth) return;
    // 大小：基础那一块，吸得狠就大一点，再随机差一点
    const w = R * (2.0 + d * 1.1) * (0.82 + rnd(seed + 5.1) * 0.45);
    const h = w * (img.naturalHeight / img.naturalWidth);
    // 新鲜是红的，放久了往紫里偏
    const col = `rgb(${Math.round(158 - ag * 46)},${Math.round(44 + ag * 2)},${Math.round(48 + ag * 54)})`;
    const t = tinted(img, w * 2, h * 2, col);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rnd(seed + 9.3) * 6.2832);                       // 随便转
    ctx.scale(rnd(seed + 1.9) < 0.5 ? -1 : 1, 1);               // 随机翻面
    ctx.transform(1, (rnd(seed + 4.4) - 0.5) * 0.4, (rnd(seed + 6.1) - 0.5) * 0.4, 1, 0, 0); // 扭一点
    ctx.scale(1, 0.8 + rnd(seed + 7.3) * 0.45);                 // 拉扁一点
    ctx.globalAlpha = Math.max(0, Math.min(1, a * (0.5 + d * 0.6)));
    ctx.drawImage(t, -w / 2, -h / 2, w, h);
    ctx.restore();
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
      // 牙印、唇印都不跟着力道变大小——嘴就那么大。
      // 咬得狠只是更扁更深更密，亲得久只是更实、更完整。
      if (m.kind === 'bite') drawBite(p, 11.5, 0.72 * fade, rot, seed, m.s);
      else if (m.kind === 'suck') drawHickey(p, 15, fade, m.s, seed, age);
      else if (m.zone === '嘴唇') drawLipStain(r, fade, m.s);
      else drawLip(p, 13.5, fade, rot, seed, m.s);
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
      ctx.strokeStyle = `rgba(236,128,160,${(1 - age) * 0.55})`;
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
      ctx.fillStyle = 'rgba(236,128,160,0.30)'; ctx.fill();
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

  // 自己擦：手指走到哪儿，哪儿的痕迹就没了
  function eraseAt(x, y, r) {
    const before = marks.length;
    const R = 34;
    marks = marks.filter(m => {
      const p = fromImg(m.nx, m.ny, r.width, r.height);
      return dist(p.x, p.y, x, y) > R;
    });
    if (marks.length !== before) { saveMarks(); refreshBadge(); kick(); }
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
      showDbg(t.force || t.webkitForce || 0, Math.max(t.radiusX || 0, t.radiusY || 0) * 2, 0, 0, 0);
      if (mode === 'erase') eraseAt(x, y, r);
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
      const sec = (now() - f.t0) / 1000;
      showDbg(f.force, f.radius, sec, f.path, sec > 0.05 ? f.path / sec : 0);
      if (mode === 'erase') eraseAt(x, y, r);
    }
    kick();
  }
  function onEnd(e) {
    e.preventDefault();
    const fingersNow = live.size;
    const r0 = cv.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const f = live.get(t.identifier); if (!f) continue;
      live.delete(t.identifier);
      if (mode === 'erase') { eraseAt(f.px, f.py, r0); continue; }   // 擦的时候不记成一笔
      const t1 = now(), dur = t1 - f.t0;
      if (dur < 18 && f.path < 2) continue;   // 误触（亲一下很快，别把她那一下吃掉）
      const _n0 = toImg(f.x0, f.y0, f.w, f.h), _n1 = toImg(f.px, f.py, f.w, f.h);
      // 亲/吸/咬 会在身上留下东西
      if (mode !== 'touch') {
        // 吸：含得越久、压得越实，印子越深越紫
        const strength = mode === 'suck'
          ? Math.min(2, 0.62 + dur / 900 + (f.radius > 30 ? 0.35 : 0))
          : (mode === 'kiss'
            ? Math.min(2, 0.3 + dur / 900 + (f.radius > 30 ? 0.25 : 0))
            : Math.min(2, 0.6 + dur / 1400 + (f.radius > 30 ? 0.3 : 0)));
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
      showDbg(f.force, f.radius, dur / 1000, f.path, dur > 50 ? f.path / (dur / 1000) : 0);
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
      <img id="touch-body" src="/static/lin-body-v3.webp?v=1" alt="">
      <canvas id="touch-cv"></canvas>
      <div class="touch-top">
        <div class="touch-badge fold" id="touch-badge">还没碰到他</div>
        <div class="touch-right">
          <div class="tm touch-x" id="touch-x">收起</div>
          <div class="touch-rrow">
            <div class="touch-badge" id="touch-dbg"></div>
            <div class="touch-modes" id="touch-modes">
              <div class="tm act" data-m="touch">摸</div>
              <div class="tm" data-m="kiss">亲</div>
              <div class="tm" data-m="suck">吸</div>
              <div class="tm" data-m="bite">咬</div>
              <div class="tm wipe" data-m="erase">擦一块</div>
              <div class="tm wipe" id="touch-wipe">全擦掉</div>
            </div>
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
