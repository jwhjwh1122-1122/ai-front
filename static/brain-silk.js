/* 记忆室的丝线（2026-11-18，照宝宝给的图做的）
   平常一根都没有。点一朵花：跟它连着的那几朵先停下不漂，丝从它们之间浮出来，蝴蝶晚一点落上去。
   关上卡片、点别的花、换分类，丝就淡掉。
   丝：S 形，摆到头的地方摊开、亮；摆过中间收细、淡。远看一条，细看是好几根并着走。
   蝴蝶：从那张图里抠的（silk-sprites.js），粗处落大的、细处落小的，姿态各不一样。
   后来宝宝说要仙气飘飘：丝会慢慢地飘、里面的细丝慢慢拧，亮的地方往上冒一点光点；
   蝴蝶停着不走，翅膀慢慢合上、再慢慢张开，各扇各的，不齐。两头钉在花上不动。 */
const SILK = { cur: null, held: [], hideT: 0, imgs: {}, keys: [], tok: 0, stopAt: 0, scene: null };
(function () {
  const S = window.SILK_SPR || {};
  SILK.keys = Object.keys(S);
  SILK.keys.forEach(k => { const im = new Image(); im.src = S[k].src; SILK.imgs[k] = im; });
})();
const SILK_STILL = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function silkSeed(n) { let h = (2166136261 ^ n) >>> 0; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
function silkHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function silkBz(a, b, c, d, t) { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; }
function silkDbz(a, b, c, d, t) { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); }

// 亮度沿着丝走：两头散开，拐弯处亮，中间淡。q 会随时间挪一点，亮的地方跟着拐弯走
function silkVis(L, s) { const e = Math.min(1, s / 0.14, (1 - s) / 0.14), m = Math.pow(Math.abs(Math.sin(6.283 * L.k * s + L.qq)), 1.4) * (0.8 + 0.2 * Math.sin(s * 9 + L.jit)); return e * (0.13 + 0.87 * Math.max(0, m)); }

function silkRibbon(g, L, o, T) {
  const pts = L.pts, N = pts.length, p0 = pts[0], p1 = pts[N - 1], gr = g.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  for (let s = 0; s <= 1.0001; s += 0.025) gr.addColorStop(Math.min(1, s), 'rgba(246,248,252,' + silkVis(L, Math.min(1, s)).toFixed(3) + ')');
  g.strokeStyle = gr;
  for (const st of o.st) {
    g.beginPath();
    const ph = st.p + T * st.sp;
    for (let i = 0; i < N; i++) {
      const s = i / (N - 1), p = pts[i], hw = o.w * (0.12 + 0.88 * silkVis(L, s)), h = hw * (st.v + st.j * Math.sin(st.f * 6.283 * s + ph));
      i ? g.lineTo(p.x + p.nx * h, p.y + p.ny * h) : g.moveTo(p.x + p.nx * h, p.y + p.ny * h);
    }
    g.globalAlpha = o.a * st.a; g.lineWidth = st.w; g.stroke();
  }
}
// 亮处打卷的烟丝：形状固定（同一个种子），只是跟着慢慢摇、忽明忽暗
function silkWisp(g, p, r, T, ph) {
  const sway = 1 + 0.3 * Math.sin(T * 0.7 + ph);
  for (let k = 0; k < 4; k++) {
    const L = (8 + r() * 14) * (1 + 0.12 * Math.sin(T * 0.5 + ph + k)), side = r() < 0.5 ? -1 : 1, turn = (1.5 + r() * 2.5) * side * sway;
    let px = p.x + (r() - 0.5) * 4, py = p.y + (r() - 0.5) * 4, ang = Math.atan2(p.ny, p.nx) * (side > 0 ? 1 : -1) + (r() - 0.5) * 1.5;
    g.beginPath(); g.moveTo(px, py);
    for (let i = 1; i <= 14; i++) { ang += turn / 14; px += Math.cos(ang) * L / 14; py += Math.sin(ang) * L / 14; g.lineTo(px, py); }
    g.strokeStyle = 'rgba(240,244,252,1)'; g.globalAlpha = (0.12 + r() * 0.18) * (0.75 + 0.25 * Math.sin(T * 0.9 + ph * 2 + k)); g.lineWidth = 0.5; g.stroke();
  }
}

// 一根丝：A 到 B。这里只定下它长什么样，每一帧再按时间算它飘到哪
function silkLink(A, B, li, r) {
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, o1 = (r() - 0.5) * len * 0.3, o2 = (r() - 0.5) * len * 0.3;
  const P = [[A.x, A.y], [A.x + dx * 0.3 + nx * o1, A.y + dy * 0.3 + ny * o1], [A.x + dx * 0.7 + nx * o2, A.y + dy * 0.7 + ny * o2], [B.x, B.y]];
  const N = Math.max(70, Math.min(480, Math.round(len / 2.2))), k = Math.max(1, Math.round(len / 150)), A0 = Math.min(30, len * 0.17) * (0.8 + r() * 0.4), q = r() < 0.5 ? 0 : Math.PI;
  const base = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), tx = silkDbz(P[0][0], P[1][0], P[2][0], P[3][0], t), ty = silkDbz(P[0][1], P[1][1], P[2][1], P[3][1], t), tl = Math.hypot(tx, ty) || 1;
    base.push({ t, x: silkBz(P[0][0], P[1][0], P[2][0], P[3][0], t), y: silkBz(P[0][1], P[1][1], P[2][1], P[3][1], t), nx: -ty / tl, ny: tx / tl, env: Math.pow(Math.sin(Math.PI * t), 0.9) });
  }
  const L = { li, N, k, A0, q, qq: q, jit: r() * 6.28, base, pts: null, ph: r() * 6.28, sp: 0.35 + r() * 0.3, len };
  const mk = (n, wide, al) => { const a = []; for (let j = 0; j < n; j++) { const v = -1 + 2 * j / (n - 1), edge = Math.pow(Math.abs(v), 3); a.push({ v, j: 0.15 + r() * 0.35, f: 1 + r() * 3, p: r() * 6.28, sp: (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.45), a: al * (0.1 + 0.8 * edge) * (0.7 + r() * 0.6), w: wide * (0.35 + 0.55 * edge) }); } return a; };
  L.layers = [{ w: 3.2 + r() * 1.6, a: 1, st: mk(9, 1, 1) }, { w: 5.5 + r() * 2, a: 0.5, st: mk(5, 0.7, 0.6) }];
  silkFrame(L, 0);
  // 烟丝的位置
  L.wisps = [];
  { const rr = silkSeed(li * 131 + 7); for (let j = 0; j < k * 2; j++) { const s = (j + 0.5) / (2 * k) + (rr() - 0.5) * 0.06, i = Math.round(Math.max(0, Math.min(1, s)) * (N - 1)); if (silkVis(L, s) > 0.7 && rr() < 0.6) L.wisps.push({ i, seed: li * 733 + j * 17 + 3, ph: rr() * 6.28 }); } }
  // 往上冒的小光点
  L.motes = [];
  for (let j = 0; j < 1 + k * 2; j++) L.motes.push({ s0: r(), v: (r() < 0.5 ? -1 : 1) * (0.008 + r() * 0.014), per: 4.5 + r() * 3.5, ph: r(), dx: (r() - 0.5) * 6, rise: 10 + r() * 14 });
  // 能落蝴蝶的地方
  L.perch = [];
  const cnt = len < 70 ? 0 : Math.max(1, Math.min(4, Math.round(len / 95 + r() * 0.6)));
  for (let j = 0; j < cnt; j++) {
    let bi = Math.round((0.14 + 0.72 * (j + 0.2 + r() * 0.6) / cnt) * (N - 1));
    if (r() < 0.6) { let best = bi; for (let d = -6; d <= 6; d++) { const t = Math.max(1, Math.min(N - 2, bi + d)); if (silkVis(L, t / (N - 1)) > silkVis(L, best / (N - 1))) best = t; } bi = best; }
    L.perch.push({ L, bi, x: L.pts[bi].x, y: L.pts[bi].y, v: silkVis(L, bi / (N - 1)), r: silkSeed(li * 977 + j * 31 + 5) });
  }
  return L;
}
// 这一刻丝飘到哪：S 弯的幅度轻轻呼吸，拐弯处沿着丝挪一点，再叠一道很慢、往前走的小波。两头 env=0，钉住不动
function silkFrame(L, T) {
  const { base, N, k, A0 } = L;
  L.qq = L.q + 0.32 * Math.sin(T * 0.42 + L.ph);
  const amp = A0 * (1 + 0.1 * Math.sin(T * 0.55 + L.ph * 1.7)), wav = Math.min(5, L.len * 0.03);
  const raw = new Array(N);
  for (let i = 0; i < N; i++) {
    const b = base[i], off = (amp * Math.sin(6.283 * k * b.t + L.qq) + wav * Math.sin(6.283 * 1.4 * b.t - T * L.sp + L.ph)) * b.env;
    raw[i] = [b.x + b.nx * off, b.y + b.ny * off];
  }
  const pts = L.pts && L.pts.length === N ? L.pts : new Array(N);
  for (let i = 0; i < N; i++) {
    const a = raw[Math.max(0, i - 1)], c = raw[Math.min(N - 1, i + 1)], tx = c[0] - a[0], ty = c[1] - a[1], tl = Math.hypot(tx, ty) || 1;
    pts[i] = { x: raw[i][0], y: raw[i][1], nx: -ty / tl, ny: tx / tl };
  }
  L.pts = pts;
}
// 选好哪些地方落蝴蝶、每只长什么样、扇多快。只算一次
function silkFlies(perch) {
  const S = window.SILK_SPR || {}, keys = SILK.keys; if (!keys.length) return [];
  const kept = [];
  perch.sort((a, c) => c.v - a.v).forEach(p => { if (kept.every(q => Math.hypot(q.x - p.x, q.y - p.y) > 24 + 12 * (p.v + q.v))) kept.push(p); });
  return kept.sort((a, c) => a.y - c.y).map(p => {
    const r = p.r, key = keys[Math.floor(r() * keys.length)], s = S[key];
    const tw = (9 + 19 * Math.pow(p.v, 1.1)) * (0.9 + r() * 0.25), w = tw * (0.75 + 0.25 * s.w / 200), h = w * s.h / s.w, flip = r() < 0.5;
    const lift = r() < 0.18 ? 3 + r() * 6 : 0;
    return {
      p, key, s, w, h, flip, lift, tk: 0.25 + r() * 0.2, tr: (r() - 0.5) * 0.35 + (lift ? (flip ? 1 : -1) * (0.15 + r() * 0.2) : 0),
      squash: 0.72 + r() * 0.28, al: lift ? 0.88 : (p.v < 0.4 ? 0.85 : 1),
      per: 3.4 + r() * 2.8, ph: r() * 6.283, deep: lift ? 0.7 : 0.5 + r() * 0.15
    };
  });
}
function silkFly(b, F, T) {
  const L = F.p.L, pts = L.pts, bi = F.p.bi, p = pts[bi], a0 = pts[Math.max(0, bi - 2)], c0 = pts[Math.min(L.N - 1, bi + 2)];
  let a = Math.atan2(c0.y - a0.y, c0.x - a0.x); while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI;
  // 扇翅：慢慢合上、慢慢张开，然后停一会儿再扇
  const g = Math.sin(6.283 * T / F.per + F.ph), c = g > 0 ? Math.pow(g, 1.5) : 0;
  const sx = F.squash * (1 - F.deep * c), bob = F.lift ? Math.sin(T * 1.1 + F.ph) * 1.2 : 0;
  const im = SILK.imgs[F.key];
  b.save(); b.translate(p.x, p.y - F.lift + bob); b.rotate(a * F.tk + F.tr); b.scale((F.flip ? -1 : 1) * sx, 1);
  b.globalAlpha = F.al;
  try { b.drawImage(im, -F.w * 0.5, -F.h * F.s.ay, F.w, F.h); } catch (e) { }
  b.restore();
}
function silkMotes(b, L, T) {
  const pts = L.pts, N = L.N;
  for (const m of L.motes) {
    let s = (m.s0 + T * m.v) % 1; if (s < 0) s += 1;
    s = 0.08 + 0.84 * s;
    const vis = silkVis(L, s); if (vis < 0.35) continue;
    const u = (T / m.per + m.ph) % 1, p = pts[Math.round(s * (N - 1))];
    const x = p.x + m.dx * u + Math.sin(u * 6 + m.ph * 6) * 2, y = p.y - m.rise * u, al = Math.sin(Math.PI * u) * 0.55 * vis;
    b.globalAlpha = al * 0.35; b.fillStyle = 'rgb(240,244,252)';
    b.beginPath(); b.arc(x, y, 2.4, 0, 6.283); b.fill();
    b.globalAlpha = al; b.beginPath(); b.arc(x, y, 0.8, 0, 6.283); b.fill();
  }
}
function silkWipe(c, g) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(0, 0, c.width, c.height); g.restore(); }
// 画一帧：丝画在最上面那层，再原样拷到两层糊开的光晕里
function silkPaint(T) {
  const S = SILK.scene; if (!S) return;
  const [c0, c1, c2] = S.cs, [g0, g1, g2] = S.gs, b = S.b;
  silkWipe(c0, g0);
  for (const L of S.links) {
    silkFrame(L, T);
    for (const o of L.layers) silkRibbon(g0, L, o, T);
    for (const w of L.wisps) silkWisp(g0, L.pts[w.i], silkSeed(w.seed), T, w.ph);
  }
  for (const [c, g] of [[c1, g1], [c2, g2]]) { silkWipe(c, g); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.drawImage(c0, 0, 0); g.restore(); }
  silkWipe(S.bc, b);
  for (const L of S.links) silkMotes(b, L, T);
  for (const F of S.flies) silkFly(b, F, T);
  b.globalAlpha = 1;
}
function silkLoop(tok) {
  if (SILK_STILL) return;
  let last = 0;
  const step = now => {
    if (SILK.tok !== tok || (SILK.stopAt && now > SILK.stopAt)) return;
    requestAnimationFrame(step);
    if (document.hidden || now - last < 33) return;   // 一秒三十帧就够飘了，省电
    last = now; silkPaint(now / 1000);
  };
  requestAnimationFrame(step);
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
  if (now) { SILK.tok++; SILK.scene = null; silkRelease(); if (web) web.remove(); if (fly) fly.remove(); return; }
  SILK.stopAt = performance.now() + 950;   // 淡出的时候还接着飘，淡完了再停
  SILK.hideT = setTimeout(() => { silkRelease(); if (!SILK.cur) SILK.scene = null; }, 900);
}
// 点了一朵：返回连着几条（画面上看得见的）
function silkShow(x, f) {
  clearTimeout(SILK.hideT); silkRelease();
  const tok = ++SILK.tok; SILK.stopAt = 0; SILK.scene = null;
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
  const cs = [web.querySelector('.sg0'), web.querySelector('.sg1'), web.querySelector('.sg2')], gs = cs.map(ctx), bc = fly.querySelector('canvas'), b = ctx(bc);
  const links = [], perch = [];
  tg.forEach((el, i) => {
    const id2 = el.dataset.id, li = silkHash(x.id < id2 ? x.id + id2 : id2 + x.id);
    // 同一对花，不管从哪头点，丝长得都一样
    const flipAB = x.id > id2, P = flipAB ? Bs[i] : A, Q = flipAB ? A : Bs[i];
    const L = silkLink(P, Q, li, silkSeed(li)); links.push(L); perch.push(...L.perch);
  });
  SILK.scene = { cs, gs, bc, b, links, flies: silkFlies(perch) };
  silkPaint(performance.now() / 1000);
  silkLoop(tok);
  void web.offsetWidth;
  requestAnimationFrame(() => { if (SILK.cur === x.id) { web.classList.add('on'); fly.classList.add('on'); } });
  return tg.length;
}
