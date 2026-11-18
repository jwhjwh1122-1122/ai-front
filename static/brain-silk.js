/* 记忆室的丝线（2026-11-18，照宝宝给的图做的）
   平常一根都没有。点一朵花：跟它连着的那几朵先停下不漂，丝从它们之间浮出来，蝴蝶晚一点落上去。
   关上卡片、点别的花、换分类，丝就淡掉。
   丝：S 形，摆到头的地方摊开、亮；摆过中间收细、淡。远看一条，细看是好几根并着走。
   蝴蝶：从那张图里抠的（silk-sprites.js），粗处落大的、细处落小的，姿态各不一样，不动。 */
const SILK = { cur: null, held: [], hideT: 0, imgs: {}, keys: [] };
(function () {
  const S = window.SILK_SPR || {};
  SILK.keys = Object.keys(S);
  SILK.keys.forEach(k => { const im = new Image(); im.src = S[k].src; SILK.imgs[k] = im; });
})();
function silkSeed(n) { let h = (2166136261 ^ n) >>> 0; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
function silkHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function silkBz(a, b, c, d, t) { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; }
function silkDbz(a, b, c, d, t) { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); }

function silkRibbon(g, pts, o) {
  const N = pts.length, p0 = pts[0], p1 = pts[N - 1], gr = g.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  for (let s = 0; s <= 1.0001; s += 0.02) gr.addColorStop(Math.min(1, s), 'rgba(246,248,252,' + o.vis(Math.min(1, s)).toFixed(3) + ')');
  g.strokeStyle = gr;
  for (const st of o.st) {
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const s = i / (N - 1), p = pts[i], hw = o.w * (0.12 + 0.88 * o.vis(s)), h = hw * (st.v + st.j * Math.sin(st.f * 6.283 * s + st.p));
      i ? g.lineTo(p.x + p.nx * h, p.y + p.ny * h) : g.moveTo(p.x + p.nx * h, p.y + p.ny * h);
    }
    g.globalAlpha = o.a * st.a; g.lineWidth = st.w; g.stroke();
  }
}
function silkWisp(g, x, y, nx, ny, r) {
  for (let k = 0; k < 4; k++) {
    const L = 8 + r() * 14, side = r() < 0.5 ? -1 : 1, turn = (1.5 + r() * 2.5) * side;
    let px = x + (r() - 0.5) * 4, py = y + (r() - 0.5) * 4, ang = Math.atan2(ny, nx) * (side > 0 ? 1 : -1) + (r() - 0.5) * 1.5;
    g.beginPath(); g.moveTo(px, py);
    for (let i = 1; i <= 14; i++) { ang += turn / 14; px += Math.cos(ang) * L / 14; py += Math.sin(ang) * L / 14; g.lineTo(px, py); }
    g.strokeStyle = 'rgba(240,244,252,1)'; g.globalAlpha = 0.12 + r() * 0.18; g.lineWidth = 0.5; g.stroke();
  }
}
// 一根丝：A 到 B，画进三层（清楚的一层 + 两层糊开当光晕），顺手把能落蝴蝶的地方记下来
function silkLink(A, B, li, r, gs, perch) {
  const [g0, g1, g2] = gs;
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, o1 = (r() - 0.5) * len * 0.3, o2 = (r() - 0.5) * len * 0.3;
  const P = [[A.x, A.y], [A.x + dx * 0.3 + nx * o1, A.y + dy * 0.3 + ny * o1], [A.x + dx * 0.7 + nx * o2, A.y + dy * 0.7 + ny * o2], [B.x, B.y]];
  const N = Math.max(80, Math.min(900, Math.round(len / 1.5))), k = Math.max(1, Math.round(len / 150)), A0 = Math.min(30, len * 0.17) * (0.8 + r() * 0.4), q = r() < 0.5 ? 0 : Math.PI;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), x = silkBz(P[0][0], P[1][0], P[2][0], P[3][0], t), y = silkBz(P[0][1], P[1][1], P[2][1], P[3][1], t),
      tx = silkDbz(P[0][0], P[1][0], P[2][0], P[3][0], t), ty = silkDbz(P[0][1], P[1][1], P[2][1], P[3][1], t), tl = Math.hypot(tx, ty) || 1,
      off = A0 * Math.sin(6.283 * k * t + q) * Math.pow(Math.sin(Math.PI * t), 0.9);
    raw.push([x + (-ty / tl) * off, y + (tx / tl) * off]);
  }
  const pts = raw.map((p, i) => { const a = raw[Math.max(0, i - 1)], c = raw[Math.min(N - 1, i + 1)], tx = c[0] - a[0], ty = c[1] - a[1], tl = Math.hypot(tx, ty) || 1; return { x: p[0], y: p[1], nx: -ty / tl, ny: tx / tl }; });
  const jit = r() * 6.28;
  const vis = s => { const e = Math.min(1, s / 0.14, (1 - s) / 0.14), m = Math.pow(Math.abs(Math.sin(6.283 * k * s + q)), 1.4) * (0.8 + 0.2 * Math.sin(s * 9 + jit)); return e * (0.13 + 0.87 * Math.max(0, m)); };
  const mk = (n, wide, al) => { const a = []; for (let j = 0; j < n; j++) { const v = -1 + 2 * j / (n - 1), edge = Math.pow(Math.abs(v), 3); a.push({ v, j: 0.15 + r() * 0.35, f: 1 + r() * 3, p: r() * 6.28, a: al * (0.1 + 0.8 * edge) * (0.7 + r() * 0.6), w: wide * (0.35 + 0.55 * edge) }); } return a; };
  const layers = [{ w: 3.2 + r() * 1.6, a: 1, vis, st: mk(9, 1, 1) }, { w: 5.5 + r() * 2, a: 0.5, vis, st: mk(5, 0.7, 0.6) }];
  for (const o of layers) for (const g of [g0, g1, g2]) silkRibbon(g, pts, o);
  for (const g of [g0, g1]) { const rr = silkSeed(li * 131 + 7); for (let j = 0; j < k * 2; j++) { const s = (j + 0.5) / (2 * k) + (rr() - 0.5) * 0.06, i = Math.round(Math.max(0, Math.min(1, s)) * (N - 1)); if (vis(s) > 0.7 && rr() < 0.6) silkWisp(g, pts[i].x, pts[i].y, pts[i].nx, pts[i].ny, rr); } }
  const cnt = len < 70 ? 0 : Math.max(1, Math.min(4, Math.round(len / 95 + r() * 0.6)));
  for (let j = 0; j < cnt; j++) {
    let bi = Math.round((0.14 + 0.72 * (j + 0.2 + r() * 0.6) / cnt) * (N - 1));
    if (r() < 0.6) { let best = bi; for (let d = -6; d <= 6; d++) { const t = Math.max(1, Math.min(N - 2, bi + d)); if (vis(t / (N - 1)) > vis(best / (N - 1))) best = t; } bi = best; }
    const a = pts[Math.max(0, bi - 2)], c = pts[Math.min(N - 1, bi + 2)];
    perch.push({ x: pts[bi].x, y: pts[bi].y, v: vis(bi / (N - 1)), ang: Math.atan2(c.y - a.y, c.x - a.x), r: silkSeed(li * 977 + j * 31 + 5) });
  }
}
function silkFlies(b, perch) {
  const S = window.SILK_SPR || {}, keys = SILK.keys; if (!keys.length) return;
  const kept = [];
  perch.sort((a, c) => c.v - a.v).forEach(p => { if (kept.every(q => Math.hypot(q.x - p.x, q.y - p.y) > 24 + 12 * (p.v + q.v))) kept.push(p); });
  kept.sort((a, c) => a.y - c.y).forEach(p => {
    const r = p.r, key = keys[Math.floor(r() * keys.length)], s = S[key], im = SILK.imgs[key];
    const tw = (9 + 19 * Math.pow(p.v, 1.1)) * (0.9 + r() * 0.25), w = tw * (0.75 + 0.25 * s.w / 200), h = w * s.h / s.w, flip = r() < 0.5;
    let a = p.ang; while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI;
    const lift = r() < 0.18 ? 3 + r() * 6 : 0, tilt = a * (0.25 + r() * 0.2) + (r() - 0.5) * 0.35 + (lift ? (flip ? 1 : -1) * (0.15 + r() * 0.2) : 0), squash = 0.72 + r() * 0.28;
    b.save(); b.translate(p.x, p.y - lift); b.rotate(tilt); b.scale((flip ? -1 : 1) * squash, 1);
    b.globalAlpha = lift ? 0.88 : (p.v < 0.4 ? 0.85 : 1);
    try { b.drawImage(im, -w * 0.5, -h * s.ay, w, h); } catch (e) { }
    b.restore();
  });
}

function silkBoxes() {
  const list = $('mail-list');
  let web = $('silk-web'), fly = $('silk-fly');
  if (!web || web.parentNode !== list) {
    web = document.createElement('div'); web.id = 'silk-web'; web.className = 'silk-layer';
    web.innerHTML = '<canvas class="sg2"></canvas><canvas class="sg1"></canvas><canvas class="sg0"></canvas>';
    fly = document.createElement('div'); fly.id = 'silk-fly'; fly.className = 'silk-layer';
    fly.innerHTML = '<canvas></canvas>';
    list.appendChild(web); list.appendChild(fly);
  }
  return [web, fly];
}
function silkRelease() { SILK.held.forEach(el => el.classList.remove('hold')); SILK.held = []; }
// 收起来：now=true 是内容要重画了，直接撤掉不等它淡
function silkHide(now) {
  SILK.cur = null; clearTimeout(SILK.hideT);
  const web = $('silk-web'), fly = $('silk-fly');
  if (web) web.classList.remove('on'); if (fly) fly.classList.remove('on');
  if (now) { silkRelease(); if (web) web.remove(); if (fly) fly.remove(); return; }
  SILK.hideT = setTimeout(silkRelease, 900);
}
// 点了一朵：返回连着几条（画面上看得见的）
function silkShow(x, f) {
  clearTimeout(SILK.hideT); silkRelease();
  const rel = ((brainData && brainData.rel) || {})[x.id] || [];
  const list = $('mail-list');
  const tg = [...new Set(rel)].map(id => list.querySelector('.p-f[data-id="' + id + '"]')).filter(e => e && e !== f);
  SILK.cur = x.id;
  const [web, fly] = silkBoxes();
  web.classList.remove('on'); fly.classList.remove('on');
  if (!tg.length) return 0;
  [f, ...tg].forEach(el => { el.classList.add('hold'); SILK.held.push(el); });
  const lr = list.getBoundingClientRect();
  const pos = el => { const b = el.getBoundingClientRect(); return { x: b.left - lr.left + b.width / 2 + list.scrollLeft, y: b.top - lr.top + b.height / 2 + list.scrollTop }; };
  const A = pos(f), Bs = tg.map(pos);
  // 画布只铺丝经过的那一截；太远的（隔了好几个月）上下各留两千像素，再远的就让它出画
  let y0 = Math.min(A.y, ...Bs.map(p => p.y)) - 70, y1 = Math.max(A.y, ...Bs.map(p => p.y)) + 70;
  y0 = Math.max(y0, A.y - 2000); y1 = Math.min(y1, A.y + 2000);
  const W = list.clientWidth, H = Math.max(10, y1 - y0), d = Math.min(H > 2200 ? 1.5 : 2, window.devicePixelRatio || 1);
  for (const box of [web, fly]) { box.style.top = y0 + 'px'; box.style.height = H + 'px'; box.style.width = W + 'px'; }
  const ctx = c => { c.width = Math.round(W * d); c.height = Math.round(H * d); const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, -y0 * d); g.lineCap = 'round'; g.lineJoin = 'round'; return g; };
  const gs = [web.querySelector('.sg0'), web.querySelector('.sg1'), web.querySelector('.sg2')].map(ctx), b = ctx(fly.querySelector('canvas'));
  const perch = [];
  tg.forEach((el, i) => {
    const id2 = el.dataset.id, li = silkHash(x.id < id2 ? x.id + id2 : id2 + x.id);
    // 同一对花，不管从哪头点，丝长得都一样
    const flipAB = x.id > id2, P = flipAB ? Bs[i] : A, Q = flipAB ? A : Bs[i];
    silkLink(P, Q, li, silkSeed(li), gs, perch);
  });
  gs.forEach(g => g.globalAlpha = 1);
  silkFlies(b, perch);
  void web.offsetWidth;
  requestAnimationFrame(() => { if (SILK.cur === x.id) { web.classList.add('on'); fly.classList.add('on'); } });
  return tg.length;
}
