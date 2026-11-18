/* 记忆室：原来的信箱那间，现在摊开的是记忆库的目录。
   这个文件排在 rooms.js 后面加载，所以这里的 openMailbox 会顶替掉旧的那个。 */
let brainData = null, brainKind = 'lit';
const BRAIN_KINDS = [
  ['lit', '亮着的', null], ['pin', '钉住的', '#ffd27a'], ['mem', '记着的', '#f3f0e6'],
  ['letter', '信', '#f3c9d4'], ['plan', '答应过的', '#bfd9f3'], ['arch', '沉底的', null],
];
const BRAIN_KNAME = { pin: '钉住的', mem: '记着的', letter: '信', plan: '答应过的事', feel: '心底话', arch: '沉底了' };

function brainInKind(x) {
  if (brainKind === 'lit') return x.kind !== 'arch';
  if (brainKind === 'pin') return x.kind === 'pin' || x.kind === 'feel';
  return x.kind === brainKind;
}
function brainHasWord(x, q) {
  if (!q) return true;
  const hay = [x.title, x.tags.join(' '), x.date, x.domain || '', x.extra || ''].join(' ').toLowerCase();
  return hay.includes(q);
}
function brainName(x) {
  if (x.title) return x.title;
  if (x.tags.length) return x.tags.slice(0, 4).join(' · ');
  return x.kind === 'plan' ? '一件答应过的事' : '没起名字的一条';
}
// 每朵花的位置和漂法从它自己的编号里算出来：稳定，下次进来还在老地方，不会乱跳。
function brainSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}
// 我自己定的认法：这间是一片雨夜的水面，一朵花是一件事。
//   大小 = 要紧；亮度 = 常想起。
//   白 = 记着的；蓝 = 答应过的（做完了就暗下去）；粉 = 信；带暖光的 = 钉住的；带紫光的 = 心底话；
//   沉底的是沉在水下的一小朵，暗的，不漂。
const POND_KIND = { mem: ['#f3f0e6', '#e6c56a'], plan: ['#bfd9f3', '#f1e6b0'], letter: ['#f3c9d4', '#f0dc9a'], pin: ['#fbf7ea', '#ffd27a'], feel: ['#e2d8f8', '#f1e6b0'], arch: ['#9a9ca6', '#8a8672'] };
function pondSvg(k) {
  let s = '<svg viewBox="-12 -12 24 24">';
  for (let i = 0; i < 5; i++) s += `<ellipse cx="0" cy="-5.9" rx="3.3" ry="5.3" fill="${k[0]}" transform="rotate(${i * 72})"/>`;
  return s + `<circle r="3.9" fill="${k[1]}" opacity=".38"/><circle r="2" fill="${k[1]}"/></svg>`;
}
function pondFlower(x, x0, y0, cw, rh, dim) {
  const r = brainSeed(String(x.id || x.title || '') + x.date);
  const sz = x.kind === 'arch' ? 20 : Math.round(17 + x.imp * 0.9);
  const hot = Math.min(1, Math.log10((x.w || 0) + 1) / Math.log10(6));
  let op = 0.62 + 0.38 * hot;
  if (x.kind === 'pin' || x.kind === 'feel' || x.kind === 'letter') op = 1;
  if (x.kind === 'plan') op = x.done ? 0.38 : 1;
  if (x.kind === 'arch') op = 1; // 宝宝说 0.28 太淡看不见，点开那朵（=1）刚好，就按点开的亮度来
  const f = document.createElement('div');
  f.className = 'p-f k-' + x.kind + (dim ? ' dim' : '');
  f.dataset.id = x.id || '';
  const h = n => ((r() - 0.5) * n).toFixed(1);
  f.style.cssText = `width:${sz}px;height:${Math.round(sz * 0.54)}px;left:${(x0 + 4 + r() * Math.max(0, cw - sz - 8)).toFixed(1)}px;top:${(y0 + r() * (rh - sz)).toFixed(1)}px;` +
    `--op:${op.toFixed(2)};--r:${Math.round(r() * 72)}deg;--d:${(15 + r() * 10).toFixed(1)}s;--d2:${(13 + r() * 9).toFixed(1)}s;--dl:-${(r() * 30).toFixed(1)}s;` +
    `--bx:${h(52)}px;--by:${h(18)}px;--cx:${h(52)}px;--cy:${h(18)}px`;
  f.innerHTML = `<div class="p-sq" style="width:${sz}px;height:${sz}px"><div class="p-rot">${pondSvg(POND_KIND[x.kind] || POND_KIND.mem)}</div></div>`;
  return f;
}

/* ===== 水面：雨、涟漪。每滴雨先定好砸在哪儿，落到了才炸开 ===== */
const POND = { cv: null, g: null, W: 0, H: 0, rip: [], rain: [], mist: [], spl: [], live: new Set(), io: null, on: false, last: 0, acc: 0 };
function pondSize() {
  const P = POND, box = $('mailbox'); if (!P.cv) return;
  const d = Math.min(2, window.devicePixelRatio || 1);
  P.W = box.clientWidth; P.H = box.clientHeight;
  P.cv.width = P.W * d; P.cv.height = P.H * d; P.g.setTransform(d, 0, 0, d, 0, 0);
}
function pondFog(any) { const P = POND; return { x: Math.random() * (P.W + 80), y: any ? Math.random() * P.H : -30, l: 9 + Math.random() * 14, v: 560 + Math.random() * 280, a: 0.025 + Math.random() * 0.04 }; }
function pondRip(x, y, sz) { POND.rip.push({ x, y, t: 0, max: sz, life: sz > 44 ? 1.9 : 1.0 + Math.random() * 0.6, n: sz > 22 ? 3 : 2, a: sz > 44 ? 0.9 : 0.6 + Math.random() * 0.25, ph: Math.random() * 6.28 }); }
function pondStart() {
  const P = POND;
  if (!P.cv) { P.cv = $('pond-cv'); if (!P.cv) return; P.g = P.cv.getContext('2d'); window.addEventListener('resize', pondSize); }
  pondSize();
  if (!P.mist.length) for (let i = 0; i < 34; i++) P.mist.push(pondFog(true));
  if (P.on) return;
  P.on = true; P.last = performance.now(); requestAnimationFrame(pondTick);
}
function pondDrop(sc) {
  const P = POND; let tx, ty, fl = null;
  if (P.live.size && Math.random() < 0.13) {
    const arr = [...P.live], e = arr[(Math.random() * arr.length) | 0], b = e.getBoundingClientRect(), c = P.cv.getBoundingClientRect();
    if (b.bottom > c.top && b.top < c.bottom) { tx = b.left - c.left + b.width * (0.2 + Math.random() * 0.6); ty = b.top - c.top + b.height * 0.5; fl = e; }
  }
  if (tx === undefined) { tx = Math.random() * P.W; ty = Math.random() * P.H; }
  return { tx, ty, y: ty - (170 + Math.random() * 260), v: 1000 + Math.random() * 500, l: 14 + Math.random() * 14, a: 0.08 + Math.random() * 0.1, fl, s0: sc };
}
// 一道水波：上弧受光亮、下弧暗下去；边是软的；形状带一点不齐，越散开越不齐
function pondRing(x, y, rad, al, ph, wob, dark, w) {
  const g = POND.g, ry = rad * 0.42, gr = g.createLinearGradient(0, y - ry, 0, y + ry);
  if (dark) { gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.55, 'rgba(0,0,0,' + (al * 0.4).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(0,0,0,' + (al * 0.95).toFixed(3) + ')'); }
  else { gr.addColorStop(0, 'rgba(228,234,246,' + al.toFixed(3) + ')'); gr.addColorStop(0.5, 'rgba(214,220,232,' + (al * 0.42).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(214,220,232,' + (al * 0.1).toFixed(3) + ')'); }
  g.strokeStyle = gr; g.beginPath();
  for (let i = 0; i < 28; i++) {
    const th = i / 28 * 6.2832, k = 1 + wob * (Math.sin(th * 3 + ph) * 0.6 + Math.sin(th * 5 + ph * 1.7) * 0.4), px = x + Math.cos(th) * rad * k, py = y + Math.sin(th) * ry * k;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
  if (!dark) { g.lineWidth = w + 2.4; g.globalAlpha = 0.22; g.stroke(); g.globalAlpha = 1; }
  g.lineWidth = w; g.stroke();
}
function pondTick(now) {
  const P = POND, g = P.g;
  if (!$('mailbox').classList.contains('open')) { P.on = false; P.rip = []; P.rain = []; P.spl = []; return; }
  const dt = Math.min(0.05, (now - P.last) / 1000); P.last = now;
  const sc = $('mail-list').scrollTop;
  g.clearRect(0, 0, P.W, P.H);
  P.acc += dt * 9; while (P.acc > 1) { P.acc--; P.rain.push(pondDrop(sc)); }
  for (const r of P.rip) {
    r.t += dt; const p = r.t / r.life, y = r.y - sc;
    for (let k = 0; k < r.n; k++) {
      const q = p - k * 0.2; if (q <= 0 || q >= 1) continue;
      const rad = 2 + r.max * (1 - Math.pow(1 - q, 2.4)), al = r.a * Math.pow(1 - q, 1.5) * (1 - k * 0.3), wob = 0.008 + 0.026 * q;
      if (k === 0 && q < 0.35) { g.fillStyle = 'rgba(235,240,250,' + (0.06 * (1 - q / 0.35)).toFixed(3) + ')'; g.beginPath(); g.ellipse(r.x, y, rad, rad * 0.42, 0, 0, 6.2832); g.fill(); }
      pondRing(r.x, y + 1.4, rad, al, r.ph, wob, true, 1.2);
      pondRing(r.x, y, rad, al, r.ph, wob, false, q < 0.25 ? 1.5 : 1);
    }
  }
  P.rip = P.rip.filter(r => r.t < r.life * (1 + 0.2 * r.n));
  for (const o of P.spl) {
    o.t += dt; const p = o.t / 0.24; if (p >= 1) continue; const y = o.y - sc;
    g.fillStyle = 'rgba(236,241,250,' + (0.95 * (1 - p)).toFixed(3) + ')'; g.beginPath(); g.ellipse(o.x, y, 2.2 + p * 2.5, 1 + p, 0, 0, 6.2832); g.fill();
    const h = (o.s > 20 ? 10 : 5) * Math.sin(p * 3.1416);
    g.fillStyle = 'rgba(236,241,250,' + (0.85 * (1 - p * 0.6)).toFixed(3) + ')'; g.beginPath(); g.arc(o.x, y - 2 - h, 1, 0, 6.2832); g.fill();
  }
  P.spl = P.spl.filter(o => o.t < 0.24);
  g.lineWidth = 1;
  for (const d of P.mist) {
    d.y += d.v * dt; d.x -= d.v * dt * 0.12;
    g.strokeStyle = 'rgba(215,220,232,' + d.a.toFixed(3) + ')'; g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x + d.l * 0.12, d.y - d.l); g.stroke();
    if (d.y > P.H + 30) Object.assign(d, pondFog(false));
  }
  for (const d of P.rain) {
    d.y += d.v * dt; const ty = d.ty - (sc - d.s0);
    if (d.y >= ty) {
      d.dead = 1; const u = Math.random(), sz = u < 0.12 ? 48 + Math.random() * 30 : u < 0.5 ? 22 + Math.random() * 16 : 10 + Math.random() * 10;
      pondRip(d.tx, ty + sc, sz); P.spl.push({ x: d.tx, y: ty + sc, t: 0, s: sz });
      if (d.fl) { d.fl.classList.remove('hit'); void d.fl.offsetWidth; d.fl.classList.add('hit'); }
      continue;
    }
    const x = d.tx + (ty - d.y) * 0.12;
    g.strokeStyle = 'rgba(220,226,238,' + d.a.toFixed(3) + ')'; g.beginPath(); g.moveTo(x, d.y); g.lineTo(x + d.l * 0.12, d.y - d.l); g.stroke();
  }
  P.rain = P.rain.filter(d => !d.dead);
  requestAnimationFrame(pondTick);
}
// 背景：默认就是这片水。她给这间单独挑过图（brain-bg），就把图垫在水底下，雨和花照样在上面。
function brainSky() {
  try {
    const own = localStorage.getItem('brain-bg'), box = $('mailbox');
    box.style.setProperty('--sky-img', own ? 'url("' + own.replace(/"/g, '%22') + '")' : 'none');
    box.classList.toggle('has-bg', !!own);
    const c = $('brain-bg-clear'); if (c) c.style.display = own ? 'inline' : 'none';
  } catch (e) { }
}

async function openMailbox(fresh) {
  // 房间已经开着又被叫一次，说明刚写完信或讨完信，要重新拉
  if (fresh === undefined && $('mailbox').classList.contains('open')) fresh = true;
  $('mailbox').classList.add('open');
  brainSky();
  pondStart();
  const el = $('mail-list');
  if (!brainData || fresh) el.innerHTML = '<div class="room-empty">正在翻…</div>';
  let d;
  try { d = await jget('/api/brain' + (fresh ? '?fresh=1' : '')); } catch (e) { d = { error: '没连上' }; }
  if (!d || d.error) {
    el.innerHTML = `<div class="room-empty">${esc((d && d.error) || '没连上')}</div>`;
    $('mail-sub').textContent = '';
    return;
  }
  brainData = d;
  brainDrawChips();
  brainDraw();
}

function brainDrawChips() {
  const items = brainData.items;
  const box = $('brain-chips');
  box.innerHTML = '';
  BRAIN_KINDS.forEach(([k, name, color]) => {
    const n = items.filter(x => {
      if (k === 'lit') return x.kind !== 'arch';
      if (k === 'pin') return x.kind === 'pin' || x.kind === 'feel';
      return x.kind === k;
    }).length;
    const b = document.createElement('button');
    b.className = 'b-chip' + (k === brainKind ? ' on' : '');
    b.innerHTML = (color ? `<i style="background:${color}"></i>` : '') + `${name} ${n}`;
    b.onclick = () => { brainKind = k; brainDrawChips(); brainDraw(); };
    box.appendChild(b);
  });
}

function brainDraw() {
  const el = $('mail-list');
  const q = ($('brain-q').value || '').trim().toLowerCase();
  const all = brainData.items.filter(brainInKind);
  const hit = all.filter(x => brainHasWord(x, q));
  const size = (brainData.stats || {})['总占用'] || '';
  $('mail-sub').textContent = q ? `找到 ${hit.length} 条` : `${all.length} 条${size ? ' · ' + size : ''}`;
  silkHide(true);
  el.innerHTML = '';
  if (!all.length) { el.innerHTML = '<div class="room-empty">这一格是空的</div>'; return; }

  // 按月一段水面，新的在上。一屏三十来朵，疏着漂。
  const P = POND, W = el.clientWidth - 32, cols = 5, cw = W / cols, rh = Math.max(92, el.clientHeight / 6.2);
  if (P.io) P.io.disconnect();
  P.live.clear();
  // 只有看得见的花才漂，五百朵一起动手机吃不消
  P.io = new IntersectionObserver(es => es.forEach(e => {
    e.target.classList.toggle('live', e.isIntersecting);
    if (e.isIntersecting) P.live.add(e.target); else P.live.delete(e.target);
  }), { root: el, rootMargin: '80px' });
  const months = {};
  all.forEach(x => { const m = x.date.slice(0, 7) || '更早'; (months[m] = months[m] || []).push(x); });
  Object.keys(months).sort().reverse().forEach(m => {
    const list = months[m].sort((a, b) => a.date < b.date ? -1 : 1);
    const n = list.length, rows = Math.ceil(n / (cols * 0.85)), r = brainSeed('pond' + m), cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cells.push([x, y]);
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    const box = document.createElement('div');
    box.className = 'p-mon';
    const high = 50 + rows * rh;
    box.style.height = high + 'px';
    const label = /^\d{4}-\d{2}$/.test(m) ? `${m.slice(0, 4)} 年 ${+m.slice(5)} 月` : m;
    box.innerHTML = `<h4>${label}<span>${n} 朵</span></h4>`;
    for (let i = 0; i < n * 1.3; i++) {
      const sp = document.createElement('i');
      sp.className = 'p-sp' + (r() < 0.4 ? ' tw' : '');
      sp.style.cssText = `left:${(r() * W).toFixed(0)}px;top:${(r() * high).toFixed(0)}px;opacity:${(0.45 + r() * 0.55).toFixed(2)};--d:${(2.5 + r() * 3).toFixed(1)}s;--dl:-${(r() * 5).toFixed(1)}s`;
      box.appendChild(sp);
    }
    list.forEach((x, i) => {
      const [cx, cy] = cells[i];
      const f = pondFlower(x, cx * cw, 50 + cy * rh, cw, rh, !brainHasWord(x, q));
      f.onclick = () => {
        const b = f.getBoundingClientRect(), c = P.cv ? P.cv.getBoundingClientRect() : { left: 0, top: 0 };
        pondRip(b.left - c.left + b.width / 2, b.top - c.top + b.height / 2 + el.scrollTop, 64);
        brainOpen(x, f);
        // 它连着谁，丝就从它那儿浮出来
        const n = silkShow(x, f);
        if (n) $('bc-meta').textContent += ` · 连着 ${n} 条`;
      };
      box.appendChild(f);
      P.io.observe(f);
    });
    el.appendChild(box);
  });

  // 搜词的时候，底下把找到的列成行，省得一个个点
  if (q && hit.length) {
    hit.sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 60).forEach(x => {
      const row = document.createElement('div');
      row.className = 'b-hit';
      row.innerHTML = `<div class="b-hit-t">${esc(brainName(x))}</div><div class="b-hit-s">${esc(x.date)} · ${BRAIN_KNAME[x.kind] || ''}</div>`;
      row.onclick = () => { silkHide(); brainOpen(x); };
      el.appendChild(row);
    });
  }
}

async function brainOpen(x, dot) {
  document.querySelectorAll('.p-f.sel').forEach(d => d.classList.remove('sel'));
  if (dot) dot.classList.add('sel');
  $('bc-title').textContent = brainName(x);
  const meta = [x.date, BRAIN_KNAME[x.kind] || ''];
  if (x.kind === 'letter' && x.extra) meta.push(x.extra + ' 写的');
  if (x.kind === 'plan') meta.push(x.done || /resolved/.test(x.extra) ? '做完了' : (/abandon/.test(x.extra) ? '放下了' : '还挂着'));
  meta.push('要紧 ' + x.imp + '/10');
  if (x.domain) meta.push(x.domain);
  $('bc-meta').textContent = meta.filter(Boolean).join(' · ');
  $('bc-tags').innerHTML = x.tags.map(t => `<span>${esc(t)}</span>`).join('');
  const body = $('bc-body');
  body.className = 'bc-body soft';
  body.textContent = '正在翻这一条…';
  $('brain-card').classList.add('open');
  const want = x.id;
  $('brain-card').dataset.id = want;
  let r;
  try { r = await jget('/api/brain/one?id=' + encodeURIComponent(x.id)); } catch (e) { r = { error: '没连上' }; }
  if ($('brain-card').dataset.id !== want) return;   // 中途点了别的
  if (r && r.text) { body.className = 'bc-body'; body.textContent = r.text; body.scrollTop = 0; return; }
  body.textContent = (r && (r.error || r.why)) || '这一条的原话没翻出来，只剩上面的名字和标签。';
}

document.addEventListener('DOMContentLoaded', () => {
  const bb = $('btn-brain-bg'), bi = $('brain-bg-input'), bc = $('brain-bg-clear');
  if (bb && bi) {
    bb.onclick = () => bi.click();
    bi.onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      e.target.value = '';
      let url;
      try { url = await shrinkToDataUrl(f, 1280, 0.8); } catch (err) { toast('这张图打不开'); return; }
      try { localStorage.setItem('brain-bg', url); } catch (err) { toast('图片太大了，存不下'); return; }
      brainSky(); toast('换好了');
    };
  }
  if (bc) bc.onclick = () => { localStorage.removeItem('brain-bg'); brainSky(); toast('换回去了'); };
  const q = $('brain-q');
  if (q) q.oninput = () => { if (brainData) brainDraw(); };
  const x = $('bc-x');
  if (x) x.onclick = () => {
    $('brain-card').classList.remove('open');
    document.querySelectorAll('.p-f.sel').forEach(d => d.classList.remove('sel'));
    silkHide();
  };
});
