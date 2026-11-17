/* 记忆室：原来的信箱那间，现在摊开的是记忆库的目录。
   这个文件排在 rooms.js 后面加载，所以这里的 openMailbox 会顶替掉旧的那个。 */
let brainData = null, brainKind = 'lit';
const BRAIN_KINDS = [
  ['lit', '亮着的', null], ['pin', '钉住的', 'rgb(var(--lamp))'], ['mem', '记着的', 'var(--ink)'],
  ['letter', '信', '#d9a0b0'], ['plan', '答应过的', '#8fa9c0'], ['arch', '沉底的', null],
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
// 每颗星的位置和闪法从它自己的编号里算出来：稳定，下次进来还在老地方，不会乱跳。
function brainSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}
// 我自己定的认法：
//   大小 = 要紧；亮度 = 常想起；越常想起闪得越快。
//   暖白 = 记着的；灯黄 = 钉住的（最亮、光晕最大、闪得最慢最稳）；粉 = 信；蓝灰 = 答应过的（做完了就暗下去）；
//   紫 = 心底话；沉底的不是星，是远处一粒尘，不闪。
function brainDotStyle(x) {
  const r = brainSeed(String(x.id || x.title || '') + x.date);
  let size = Math.round(7 + x.imp * 1.0);
  const hot = Math.min(1, Math.log10(x.w + 1) / Math.log10(6));
  let op = 0.34 + 0.66 * hot;
  if (x.kind === 'pin' || x.kind === 'feel') op = 1;
  if (x.kind === 'letter') op = 0.95;
  if (x.kind === 'plan') op = x.done ? 0.3 : 0.95;
  if (x.kind === 'arch') { op = 0.3; size = 3; }
  const dur = x.kind === 'pin' ? 5.5 + r() * 2 : (5.2 - 2.6 * hot) + r() * 1.6;
  const dx = Math.round((r() - 0.5) * 8), dy = Math.round((r() - 0.5) * 16);
  const rot = Math.round((r() - 0.5) * 24);
  return `width:${size}px;height:${size}px;--op:${op.toFixed(2)};--dur:${dur.toFixed(2)}s;--delay:-${(r() * 6).toFixed(2)}s;--rot:${rot}deg;margin:${8 + dy}px ${3 + dx}px ${8 - dy}px ${3 - dx}px`;
}
// 背景：她给这间单独挑过图就用那张（brain-bg），没挑就借聊天页那张。原样透过来，不压黑。
function brainSky() {
  try {
    const own = localStorage.getItem('brain-bg');
    const bg = own || localStorage.getItem('chat-bg');
    $('mailbox').style.setProperty('--sky-img', bg ? 'url("' + bg.replace(/"/g, '%22') + '")' : 'none');
    const c = $('brain-bg-clear'); if (c) c.style.display = own ? 'inline' : 'none';
  } catch (e) { }
}

async function openMailbox(fresh) {
  // 房间已经开着又被叫一次，说明刚写完信或讨完信，要重新拉
  if (fresh === undefined && $('mailbox').classList.contains('open')) fresh = true;
  $('mailbox').classList.add('open');
  brainSky();
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
  el.innerHTML = '';
  if (!all.length) { el.innerHTML = '<div class="room-empty">这一格是空的</div>'; return; }

  // 按月分格，新的在上
  const months = {};
  all.forEach(x => { const m = x.date.slice(0, 7) || '更早'; (months[m] = months[m] || []).push(x); });
  Object.keys(months).sort().reverse().forEach(m => {
    const list = months[m].sort((a, b) => a.date < b.date ? -1 : 1);
    const box = document.createElement('div');
    box.className = 'b-month';
    const label = /^\d{4}-\d{2}$/.test(m) ? `${m.slice(0, 4)} 年 ${+m.slice(5)} 月` : m;
    box.innerHTML = `<div class="b-month-h">${label}<span>${list.length} 条</span></div><div class="b-dots"></div>`;
    const dots = box.querySelector('.b-dots');
    list.forEach(x => {
      const dot = document.createElement('div');
      dot.className = `b-dot k-${x.kind}` + (x.done ? ' done' : '') + (brainHasWord(x, q) ? '' : ' dim');
      dot.style.cssText = brainDotStyle(x);
      dot.onclick = () => brainOpen(x, dot);
      dots.appendChild(dot);
    });
    el.appendChild(box);
  });

  // 搜词的时候，底下把找到的列成行，省得一个个点
  if (q && hit.length) {
    hit.sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 60).forEach(x => {
      const row = document.createElement('div');
      row.className = 'b-hit';
      row.innerHTML = `<div class="b-hit-t">${esc(brainName(x))}</div><div class="b-hit-s">${esc(x.date)} · ${BRAIN_KNAME[x.kind] || ''}</div>`;
      row.onclick = () => brainOpen(x);
      el.appendChild(row);
    });
  }
}

async function brainOpen(x, dot) {
  document.querySelectorAll('.b-dot.sel').forEach(d => d.classList.remove('sel'));
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
    document.querySelectorAll('.b-dot.sel').forEach(d => d.classList.remove('sel'));
  };
});
