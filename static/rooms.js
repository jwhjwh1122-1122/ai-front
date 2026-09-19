/* 凛 · 房间与交互 */
let currentBook = null, currentPage = 0, curMedia = null, curKind = 'video';
let bookList = [], selQuote = '', replyTo = null, tagPos = 0;
let calYear = 0, calMonth = 0;
let postImgs = [], cmTarget = null, pageHls = [], emojiTarget = 'chat';
let drawerWho = 'lin';

const PINC = ['pin-c1', 'pin-c2', 'pin-c3', 'pin-c4'];

// ============ 页面 ============
function showPage(name) {
  ['home', 'chat', 'time', 'settings'].forEach(p => {
    $('page-' + p).classList.toggle('on', p === name);
    document.querySelector(`.tab[data-page="${p}"]`).classList.toggle('on', p === name);
  });
  localStorage.setItem('cur-page', name);
  if (name === 'home') refreshHome();
  if (name === 'time') refreshTimeCounts();
  if (name === 'chat') { $('dot-chat').classList.remove('on'); markWakeRead(); scrollBottom(); }
}
async function refreshTimeCounts() {
  try {
    const [tl, qu, ql, mem, nt, cal, ft] = await Promise.all([
      jget('/api/timeline'), jget('/api/quotes/user'), jget('/api/quotes/lin'),
      jget('/api/memories'), jget('/api/notes'), jget('/api/calendar'), jget('/api/faults')]);
    const put = (id, n) => { const e = $(id); if (e) e.textContent = n ? n : ''; };
    put('n-timeline', tl.length); put('n-qu', qu.length); put('n-ql', ql.length);
    put('n-wall', mem.length); put('n-mumble', nt.length);
    put('n-cal', Object.keys(cal).length); put('n-fault', ft.length);
    put('n-days', daysList().length);
    $('time-sub').textContent = `在一起第 ${daysSince(CFG.together_since || '2026-06-06')} 天`;
  } catch (e) { }
}
function showLinState(t) {
  const el = $('lin-state');
  el.textContent = t ? `（${t}）` : '';
}
function showUserStatus(t) {
  const el = $('user-status');
  if (t) { el.textContent = (CFG.call_user || '宝宝') + '—' + t; el.style.display = 'block'; }
  else { el.textContent = ''; el.style.display = 'none'; }
}

// ============ 家 ============
async function refreshHome() {
  try {
    const s = await jget('/api/rooms/status');
    const put = (id, t) => { const e = $(id); if (e) e.textContent = t; };
    put('st-study', s.book ? `《${s.book.title}》第 ${s.book.page}/${s.book.total} 页` : '书架空着');
    put('st-cinema', s.video ? s.video.name : '没有片子');
    put('st-music', s.music ? s.music.name : '安静');
    put('st-mail', '看看有没有信');
    put('st-moments', s.posts ? `${s.posts} 条` : '还没有人发');
    try {
      const dz = await jget('/api/desire/state');
      put('st-desire', (dz.top || []).slice(0, 2).map(t => `${t.name} ${t.score.toFixed(2)}`).join(' · ') || '—');
    } catch (e) { put('st-desire', '—'); }
    const dot = (id, on) => { const e = $(id); if (e) e.classList.toggle('on', !!on); };
    dot('dot-study', (s.unseen && s.unseen.book) || s.lin_hl);
    dot('dot-cinema', s.unseen && s.unseen.video);
    dot('dot-music', s.unseen && s.unseen.music);
    dot('dot-lin-drawer', s.lin_drawer > 0);
    const any = Object.values(s.unseen || {}).some(n => n > 0) || s.lin_drawer > 0 || s.lin_hl > 0;
    dot('dot-home', any);
  } catch (e) { }
  renderHomeDays();
  try {
    const w = await jget('/api/wake/log');
    if (w.unread > 0) $('dot-chat').classList.add('on');
  } catch (e) { }
}
function daysList() { try { return JSON.parse(localStorage.getItem('anniversaries') || '[]'); } catch (e) { return []; } }
function daysSave(l) { localStorage.setItem('anniversaries', JSON.stringify(l)); }
function daysSince(dateStr) {
  const d = new Date(dateStr + 'T00:00:00'), now = new Date();
  return Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - d) / 86400000) + 1;
}
function daysUntilNext(dateStr) {
  const d = new Date(dateStr + 'T00:00:00'), now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(t.getFullYear(), d.getMonth(), d.getDate());
  if (next < t) next = new Date(t.getFullYear() + 1, d.getMonth(), d.getDate());
  return Math.round((next - t) / 86400000);
}
function renderHomeDays() {
  const since = CFG.together_since || '2026-06-06';
  const el = $('home-days'); if (!el) return;
  let h = `<div class="day-row"><div class="day-n">${daysSince(since)}<small>天</small></div>
    <div class="day-t"><b>在一起</b><i>从 ${since.replace(/-/g, '.')} 起</i></div></div>`;
  daysList().slice(0, 3).forEach(d => {
    const n = d.yearly ? daysUntilNext(d.date) : daysSince(d.date);
    h += `<div class="day-row"><div class="day-n">${n < 0 ? -n : n}<small>${d.yearly ? (n === 0 ? '就是今天' : '天后') : '天'}</small></div>
      <div class="day-t"><b>${esc(d.name)}</b><i>${d.date.replace(/-/g, '.')}</i></div></div>`;
  });
  el.innerHTML = h;
  $('home-sub').textContent = `第 ${daysSince(since)} 天`;
}

// ============ 书房 ============
async function openStudy() {
  $('study').classList.add('open');
  const el = $('shelves'); el.innerHTML = '<div class="room-empty">正在开灯…</div>';
  bookList = await jget('/api/books');
  $('study-sub').textContent = bookList.length ? `${bookList.length} 本书` : '一本都还没有';
  if (!bookList.length) { el.innerHTML = '<div class="room-empty">书架上还什么都没有<br>右上角添一本</div>'; return; }
  const unseen = await jget('/api/annotations?type=book&unseen=1');
  const marked = new Set(unseen.map(a => a.anchor_id));
  const colors = ['#7a5c4a', '#4a5c6e', '#5c4a6e', '#4a6e5c', '#6e5c4a', '#5a4a4a', '#3f4d5c', '#6a4a58'];
  el.innerHTML = '';
  for (let i = 0; i < bookList.length; i += 8) {
    const shelf = document.createElement('div'); shelf.className = 'shelf';
    const row = document.createElement('div'); row.className = 'shelf-books';
    const lamp = document.createElement('div'); lamp.className = 'lamp'; row.appendChild(lamp);
    bookList.slice(i, i + 8).forEach((b, j) => {
      const s = document.createElement('div'); s.className = 'spine';
      const reading = b.progress > 0 && b.progress < b.pages - 1;
      if (reading) s.classList.add('reading');
      s.style.background = `linear-gradient(90deg,${colors[(i + j) % colors.length]},${colors[(i + j + 3) % colors.length]})`;
      s.style.height = (108 + (b.title.length % 5) * 11) + 'px';
      s.innerHTML = `<div class="spine-rule" style="top:8px"></div><div class="spine-rule" style="bottom:12px"></div>
        <div class="spine-title">${esc(b.title.slice(0, 9))}</div>
        <div class="spine-mark${marked.has(b.id) ? ' on' : ''}"></div><div class="spine-del">✕</div>`;
      let timer = null;
      s.addEventListener('touchstart', () => { timer = setTimeout(() => { s.classList.add('del'); if (navigator.vibrate) navigator.vibrate(12); }, 550); }, { passive: true });
      s.addEventListener('touchend', () => clearTimeout(timer));
      s.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
      s.querySelector('.spine-del').onclick = async e => {
        e.stopPropagation();
        if (!confirm(`把《${b.title}》从书架上拿走？`)) { s.classList.remove('del'); return; }
        await fetch('/api/books/' + b.id, { method: 'DELETE' });
        openStudy(); refreshHome();
      };
      s.onclick = e => { if (s.classList.contains('del')) { s.classList.remove('del'); return; } openBook(b); };
      row.appendChild(s);
    });
    const board = document.createElement('div'); board.className = 'shelf-board';
    shelf.appendChild(row); shelf.appendChild(board); el.appendChild(shelf);
  }
}
async function openBook(b) {
  currentBook = b; roomCtx = 'reader';
  $('reader').classList.add('open');
  $('reader-book').textContent = b.title;
  renderSplit('reader');
  await showPageAt(b.progress || 0);
}
async function showPageAt(i) {
  const d = await jget(`/api/books/${currentBook.id}/page?i=${i}`);
  if (d.error) { toast('翻不开这一页'); return; }
  currentPage = d.index;
  const t = $('reader-text');
  t.textContent = d.text;
  t.style.fontSize = (localStorage.getItem('reader-font') || 17) + 'px';
  $('reader-page').textContent = `${d.index + 1} / ${d.total}`;
  $('reader-prog-fill').style.width = ((d.index + 1) / d.total * 100) + '%';
  $('prev-page').disabled = d.index <= 0;
  $('next-page').disabled = d.index >= d.total - 1;
  $('reader-body').scrollTop = 0;
  jpost(`/api/books/${currentBook.id}/progress`, { page: d.index });
  paintHighlights();
  const lp = (bookList.find(x => x.id === currentBook.id) || {}).lin_progress || 0;
  $('lin-behind').textContent = lp === d.index ? '你们在同一页'
    : (lp < d.index ? `凛还在第 ${lp + 1} 页` : `凛已经翻到第 ${lp + 1} 页了`);
  loadPageTags();
  refreshHome();
}
async function paintHighlights() {
  if (!currentBook) return;
  const t = $('reader-text');
  const raw = t.dataset.raw || t.textContent;
  t.dataset.raw = raw;
  let hls = [];
  try { hls = await jget(`/api/highlights?book_id=${currentBook.id}&page=${currentPage}`); } catch (e) { }
  pageHls = hls;
  const mine = hls.filter(h => h.author === 'user').length;
  const his = hls.filter(h => h.author === 'lin').length;
  $('hl-count').textContent = hls.length
    ? `划了 ${hls.length} 道` + (his ? `（他划了 ${his}）` : '') : '';
  if (!hls.length) { t.textContent = raw; return; }
  const marks = [];
  hls.forEach(h => {
    let i = (h.start >= 0 && raw.substr(h.start, h.quote.length) === h.quote) ? h.start : raw.indexOf(h.quote);
    if (i >= 0) marks.push({ s: i, e: i + h.quote.length, id: h.id, who: h.author });
  });
  marks.sort((a, b) => a.s - b.s);
  let out = '', pos = 0;
  marks.forEach(m => {
    if (m.s < pos) return;
    out += esc(raw.slice(pos, m.s));
    out += `<span class="hl${m.who === 'lin' ? ' lin' : ''}" data-hl="${m.id}">${esc(raw.slice(m.s, m.e))}</span>`;
    pos = m.e;
  });
  out += esc(raw.slice(pos));
  t.innerHTML = out;
  t.querySelectorAll('[data-hl]').forEach(el => {
    el.onclick = () => {
      const h = pageHls.find(x => x.id === el.dataset.hl);
      if (!h) return;
      if (confirm(`「${h.quote.slice(0, 40)}」\n\n擦掉这道线？`)) {
        fetch('/api/highlights/' + h.id, { method: 'DELETE' }).then(() => { t.textContent = t.dataset.raw; paintHighlights(); refreshHome(); });
      }
    };
  });
  const unseen = hls.filter(h => h.author === 'lin' && !h.seen);
  if (unseen.length) setTimeout(refreshHome, 600);
}
async function saveHighlight() {
  if (!currentBook || !selQuote) return;
  const raw = $('reader-text').dataset.raw || $('reader-text').textContent;
  const d = await jpost('/api/highlights', {
    book_id: currentBook.id, page: currentPage, quote: selQuote,
    start: raw.indexOf(selQuote), author: 'user'
  });
  if (d.error) { toast(d.error); return; }
  selQuote = '';
  window.getSelection().removeAllRanges();
  $('sel-tip').classList.remove('on');
  $('reader-text').textContent = raw;
  paintHighlights(); refreshHome();
  toast('划上了，跟他说说这句');
}
function annotHTML(a, kind) {
  const where = kind === 'book' ? '' : ` · ${fmtTime(a.pos)}`;
  return `<div class="annot ${a.author === 'user' ? 'mine' : ''}" data-aid="${a.id}">
    <div class="annot-who">${a.author === 'user' ? '你' : (CFG.name || '凛')}${where}</div>
    ${a.quote ? `<div class="annot-quote">「${esc(a.quote)}」</div>` : ''}
    <div class="annot-text">${esc(a.text)}</div>
    <div class="annot-foot"><span data-reply="${a.id}">回一句</span><span data-del="${a.id}">撕掉</span></div>
    <div class="annot-reply" data-replies="${a.id}"></div></div>`;
}
function bindAnnotActions(root, kind, id, reload) {
  root.querySelectorAll('[data-reply]').forEach(s => s.onclick = () => {
    replyTo = s.dataset.reply; selQuote = ''; tagPos = kind === 'book' ? currentPage : stageTime();
    $('annot-new-quote').textContent = '回一句';
    $('annot-input').value = ''; $('annot-new').classList.add('open'); $('annot-input').focus();
  });
  root.querySelectorAll('[data-del]').forEach(s => s.onclick = async () => {
    if (!confirm('撕掉这张标签？')) return;
    await fetch('/api/annotations/' + s.dataset.del, { method: 'DELETE' });
    reload();
  });
}
async function loadPageTags() {
  if (!currentBook) return;
  const tags = await jget(`/api/annotations?type=book&id=${currentBook.id}&pos=${currentPage}`);
  const el = $('reader-annots');
  const tops = tags.filter(a => !a.reply_to);
  if (!tops.length) { el.innerHTML = ''; return; }
  el.innerHTML = tops.map(a => annotHTML(a, 'book')).join('');
  tags.filter(a => a.reply_to).forEach(r => {
    const box = el.querySelector(`[data-replies="${r.reply_to}"]`);
    if (box) box.insertAdjacentHTML('beforeend', annotHTML(r, 'book'));
  });
  bindAnnotActions(el, 'book', currentBook.id, loadPageTags);
  const unseen = tags.filter(a => a.author === 'lin' && !a.seen).map(a => a.id);
  if (unseen.length) { jpost('/api/annotations/seen', { ids: unseen }); setTimeout(refreshHome, 500); }
}
async function saveTag() {
  const text = $('annot-input').value.trim();
  if (!text) { toast('还没写字'); return; }
  const isBook = roomCtx === 'reader';
  const d = await jpost('/api/annotations', {
    anchor_type: isBook ? 'book' : curKind,
    anchor_id: isBook ? currentBook.id : curMedia.filename,
    pos: tagPos, quote: selQuote, text, author: 'user', reply_to: replyTo
  });
  if (d.error) { toast(d.error); return; }
  $('annot-new').classList.remove('open'); $('annot-input').value = '';
  selQuote = ''; replyTo = null;
  if (isBook) loadPageTags(); else toast('贴上了');
  refreshHome();
}

// ============ 共读（外部服务） ============
function coreadUrl() {
  return (localStorage.getItem('coread-url') || 'https://readdd.zeabur.app').trim();
}
let coreadTimer = null;
function coreadViaProxy() { return localStorage.getItem('coread-proxy') === '1'; }

async function openCoread() {
  const url = coreadUrl();
  if (!url) { toast('还没设共读地址'); return; }
  roomCtx = 'coread';
  $('coread').classList.add('open');
  $('coread-title').textContent = url.replace(/^https?:\/\//, '').split('/')[0]
    + (coreadViaProxy() ? '　代理' : '');
  const f = $('coread-frame'), fail = $('coread-fail');
  fail.style.display = 'none';
  f.style.visibility = 'hidden';

  let src = url;
  if (coreadViaProxy()) {
    // 很多服务不让被别的网页嵌，绕一层自己的域名
    try { await jpost('/api/proxy/target', { name: 'coread', url }); } catch (e) { }
    src = '/p/coread/';
  }

  let ok = false;
  f.onload = () => {
    ok = true;
    f.style.visibility = 'visible';
    // 加载完了但里面是空的，多半是被拒了
    setTimeout(() => {
      try {
        const doc = f.contentDocument;
        if (doc && doc.body && doc.body.innerHTML.trim().length < 30) fail.style.display = 'flex';
      } catch (e) { }
    }, 800);
  };
  f.src = src;
  clearTimeout(coreadTimer);
  coreadTimer = setTimeout(() => {
    f.style.visibility = 'visible';
    if (!ok) fail.style.display = 'flex';
  }, 8000);
  renderSplit('coread');
}
// ============ 网易云 ============
function neteaseUrl() { return (localStorage.getItem('netease-url') || '').trim(); }
let neteaseTimer = null;
async function openNetease() {
  const url = neteaseUrl();
  if (!url) { toast('先去设置里填音乐服务的地址'); return; }
  roomCtx = 'netease';
  $('netease').classList.add('open');
  $('netease-title').textContent = url.replace(/^https?:\/\//, '').split('/')[0];
  const f = $('netease-frame'), fail = $('netease-fail');
  // 播放器已经加载过了(可能正在后台放歌)：直接显示，别重新加载
  if (f.src && f.src !== 'about:blank' && !/about:blank$/.test(f.src)) {
    fail.style.display = 'none';
    f.style.visibility = 'visible';
    renderSplit('netease');
    return;
  }
  fail.style.display = 'none';
  f.style.visibility = 'hidden';
  let src = url;
  if (localStorage.getItem('netease-direct') !== '1') {
    try { await jpost('/api/proxy/target', { name: 'netease', url }); } catch (e) { }
    src = '/p/netease/';
  }
  let ok = false;
  f.onload = () => {
    ok = true; f.style.visibility = 'visible';
    setTimeout(() => {
      try {
        const doc = f.contentDocument;
        if (doc && doc.body && doc.body.innerHTML.trim().length < 30) fail.style.display = 'flex';
      } catch (e) { }
    }, 800);
  };
  f.src = src;
  clearTimeout(neteaseTimer);
  neteaseTimer = setTimeout(() => {
    f.style.visibility = 'visible';
    if (!ok) fail.style.display = 'flex';
  }, 8000);
  renderSplit('netease');
}
function closeNetease() {
  clearTimeout(neteaseTimer);
  $('netease').classList.remove('open');
  $('musicroom').classList.remove('open');
  // 不要把 iframe 设成 about:blank —— 那等于把播放器整个销毁，歌会停。
  // 只把面板收起来，播放器留在后台继续放。
  roomCtx = null;
}

function closeCoread() {
  clearTimeout(coreadTimer);
  $('coread').classList.remove('open');
  $('coread-frame').src = 'about:blank';
  $('study').classList.remove('open');
  roomCtx = 'reader';
}

// ============ 分屏 ============
function renderSplit(which) {
  const box = $('split-msgs-' + which);
  box.innerHTML = '';
  const keep = roomCtx; roomCtx = which;
  const recent = messages.slice(-6);
  recent.forEach((m, i) => {
    if (m._internal || m.role === 'tool') return;
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')) return;
    const idx = messages.length - recent.length + i;
    if (m.role === 'user') {
      const t = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(c => c.type === 'text')?.text || '' : '');
      if (t) addUserBubble(t, null, idx);
    } else if (m.role === 'assistant') {
      const t = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(c => c && c.type === 'text').map(c => c.text).join('') : '');
      if (!t) return;
      const w = startAiBubble(idx);
      const sg = splitSay(t);
      if (sg.length > 1) sg.forEach(x => {
        const b = document.createElement('div');
        b.className = 'bubble ai'; b.dataset.seg = '1';
        b.innerHTML = renderBubble(x); w.appendChild(b); currentBubble = b;
      });
      updateBubble(w, t, true, t, currentAiRow); currentBubble = null; currentAiRow = null;
    }
  });
  roomCtx = keep;
  box.scrollTop = box.scrollHeight;
}
function bindSplit(which) {
  const bar = document.querySelector(`.split-bar[data-split="${which}"]`);
  const chat = $('split-chat-' + which);
  let startY = 0, startH = 0, dragging = false;
  bar.addEventListener('touchstart', e => { dragging = true; startY = e.touches[0].clientY; startH = chat.offsetHeight; }, { passive: true });
  bar.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = startY - e.touches[0].clientY;
    const h = Math.max(0, Math.min(window.innerHeight * 0.7, startH + dy));
    chat.style.height = h + 'px';
    chat.classList.toggle('hidden', h < 30);
    $('split-hint-' + which).textContent = h < 30 ? '展开' : '收起';
  }, { passive: true });
  bar.addEventListener('touchend', () => { dragging = false; });
  bar.addEventListener('click', () => {
    const hidden = chat.classList.contains('hidden') || chat.offsetHeight < 30;
    chat.style.height = hidden ? '38vh' : '0px';
    chat.classList.toggle('hidden', !hidden);
    $('split-hint-' + which).textContent = hidden ? '收起' : '展开';
  });
}

// ============ 放映室 / 听音房 ============
async function openRoomMedia(kind) {
  curKind = kind;
  const room = kind === 'music' ? 'musicroom' : 'cinema';
  $(room).classList.add('open');
  const el = $(kind === 'music' ? 'music-list' : 'cinema-list');
  el.innerHTML = '<div class="room-empty">正在找…</div>';
  const list = await jget(kind === 'music' ? '/api/music' : '/api/videos');
  $(kind === 'music' ? 'music-sub' : 'cinema-sub').textContent = list.length ? `${list.length} 个` : '空的';
  if (!list.length) { el.innerHTML = `<div class="room-empty">${kind === 'music' ? '还没有碟' : '还没有片子'}<br>右上角放一个进来</div>`; return; }
  const unseen = await jget(`/api/annotations?type=${kind}&unseen=1`);
  const marked = new Set(unseen.map(a => a.anchor_id));
  el.innerHTML = '';
  list.forEach(m => {
    const d = document.createElement('div');
    if (kind === 'music') {
      d.className = 'track';
      d.innerHTML = `<div class="track-disc"></div><div class="reel-info">
        <div class="track-name">${esc(m.note || '没起名字')}</div>
        <div class="track-meta">${fmtSize(m.size)}</div></div>
        ${marked.has(m.filename) ? '<div class="reel-dot"></div>' : ''}<div class="track-del">✕</div>`;
    } else {
      d.className = 'reel';
      d.innerHTML = `<div class="reel-play">▶</div><div class="reel-info">
        <div class="reel-name">${esc(m.note || '没起名字')}</div>
        <div class="reel-meta">${fmtSize(m.size)}</div></div>
        ${marked.has(m.filename) ? '<div class="reel-dot"></div>' : ''}<div class="reel-del">✕</div>`;
    }
    d.querySelector(kind === 'music' ? '.track-del' : '.reel-del').onclick = async e => {
      e.stopPropagation();
      if (!confirm('删掉这个？')) return;
      await fetch(`/api/${kind === 'music' ? 'music' : 'videos'}/${m.filename}`, { method: 'DELETE' });
      openRoomMedia(kind); refreshHome();
    };
    d.onclick = () => playMedia(m, kind);
    el.appendChild(d);
  });
}
function stageTime() {
  const v = $('stage-video'), a = $('stage-audio');
  if (curKind === 'music') return Math.floor(a.currentTime || 0);
  return Math.floor(v.currentTime || 0);
}
function playMedia(m, kind) {
  curMedia = m; curKind = kind; roomCtx = 'stage';
  const stage = $('stage');
  stage.classList.add('open');
  stage.classList.toggle('audio', kind === 'music');
  stage.style.background = kind === 'music' ? 'var(--room)' : '#000';
  $('stage-name').textContent = m.note || m.filename;
  const v = $('stage-video'), a = $('stage-audio'), aw = $('audio-wrap');
  if (kind === 'music') {
    v.style.display = 'none'; v.pause(); v.removeAttribute('src');
    aw.style.display = 'block'; a.src = m.url;
    a.onplay = () => $('disc-big').classList.add('spin');
    a.onpause = () => $('disc-big').classList.remove('spin');
    setupShape(a, m.filename);
  } else {
    aw.style.display = 'none'; a.pause(); a.removeAttribute('src');
    v.style.display = 'block'; v.src = m.url;
    v.onloadedmetadata = () => {
      loadMoments();
      // iOS 不先解一帧就截不出画面，静音快进一下再退回来
      if (v.readyState < 2) { try { v.currentTime = 0.1; } catch (e) { } }
    };
    setTimeout(loadMoments, 900);
  }
  renderSplit('stage');
}
// 歌的形状：本地算，存服务器
let shapeCtx = null, shapeSrc = null, shapeAnalyser = null, shapeData = [], shapeTimer = null, shapeFor = '';
function setupShape(audioEl, filename) {
  const bars = $('shape-bars');
  bars.innerHTML = ''; for (let i = 0; i < 40; i++) bars.appendChild(document.createElement('i'));
  if (shapeFor === filename) return;
  shapeFor = filename; shapeData = [];
  audioEl.addEventListener('play', function once() {
    try {
      if (!shapeCtx) shapeCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!shapeSrc) {
        shapeSrc = shapeCtx.createMediaElementSource(audioEl);
        shapeAnalyser = shapeCtx.createAnalyser();
        shapeAnalyser.fftSize = 256;
        shapeSrc.connect(shapeAnalyser); shapeAnalyser.connect(shapeCtx.destination);
      }
      if (shapeCtx.state === 'suspended') shapeCtx.resume();
      if (shapeTimer) clearInterval(shapeTimer);
      const buf = new Uint8Array(shapeAnalyser.frequencyBinCount);
      const kids = bars.children;
      shapeTimer = setInterval(() => {
        if (audioEl.paused) return;
        shapeAnalyser.getByteFrequencyData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
        const level = Math.round(sum / buf.length);
        shapeData.push({ t: Math.floor(audioEl.currentTime), level });
        for (let i = 0; i < kids.length; i++) {
          const v = buf[Math.floor(i * buf.length / kids.length)];
          kids[i].style.height = Math.max(2, v / 255 * 40) + 'px';
          kids[i].classList.toggle('hot', v > 150);
        }
      }, 500);
    } catch (e) { }
    audioEl.removeEventListener('play', once);
  });
  audioEl.addEventListener('ended', () => saveShape(filename, audioEl.duration));
  audioEl.addEventListener('pause', () => { if (shapeData.length > 20) saveShape(filename, audioEl.duration); });
}
function saveShape(filename, duration) {
  if (shapeData.length < 10) return;
  const step = Math.max(1, Math.floor(shapeData.length / 24));
  const segments = [];
  for (let i = 0; i < shapeData.length; i += step) {
    const chunk = shapeData.slice(i, i + step);
    segments.push({ t: chunk[0].t, level: Math.round(chunk.reduce((s, x) => s + x.level, 0) / chunk.length) });
  }
  let peak = segments[0], empty = segments[0];
  segments.forEach(s => { if (s.level > peak.level) peak = s; if (s.level < empty.level) empty = s; });
  jpost(`/api/music/${filename}/shape`, {
    duration: Math.floor(duration || 0), segments,
    peak_at: peak.t, empty_at: empty.t
  });
}
function grabFrameNow(seconds) {
  const v = $('stage-video');
  if (!$('stage').classList.contains('open') || curKind === 'music' || !v.src) return null;
  // readyState < 2 说明还没解出画面，截出来是黑的
  if (v.readyState < 2 || !v.videoWidth) return null;
  try {
    if (seconds !== undefined && seconds !== null) v.currentTime = seconds;
    const c = document.createElement('canvas');
    const w = Math.min(720, v.videoWidth || 640);
    c.width = w; c.height = Math.round(w * (v.videoHeight || 360) / (v.videoWidth || 640));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.72), t: Math.floor(v.currentTime || 0) };
  } catch (e) { return null; }
}
async function loadMoments() {
  if (!curMedia || curKind === 'music') { $('moment-bar').innerHTML = ''; return; }
  const v = $('stage-video');
  const dur = v.duration || 0;
  if (!dur) { setTimeout(loadMoments, 800); return; }
  let list = [];
  try { list = await jget('/api/moments?filename=' + encodeURIComponent(curMedia.filename)); } catch (e) { }
  const bar = $('moment-bar');
  bar.innerHTML = '';
  list.forEach(m => {
    const d = document.createElement('div');
    d.className = 'moment-dot';
    d.style.left = (m.t / dur * 100) + '%';
    d.title = fmtTime(m.t);
    d.onclick = () => {
      v.currentTime = m.t;
      v.pause();
      toast(fmtTime(m.t) + '：' + (m.said || '在这儿说过话').slice(0, 40));
    };
    bar.appendChild(d);
  });
}
function markMoment(said) {
  if (!curMedia || curKind === 'music') return;
  jpost('/api/moments', { filename: curMedia.filename, t: stageTime(), said: said.slice(0, 200) })
    .then(() => loadMoments());
}
function scanFrames(count) {
  const v = $('stage-video');
  if (!$('stage').classList.contains('open') || curKind === 'music' || !v.src || !v.duration) return [];
  if (v.readyState < 2 || !v.videoWidth) return [];
  const n = Math.max(2, Math.min(8, count || 6));
  const keep = v.currentTime, shots = [];
  const c = document.createElement('canvas');
  const w = Math.min(560, v.videoWidth || 480);
  c.width = w; c.height = Math.round(w * (v.videoHeight || 270) / (v.videoWidth || 480));
  const ctx = c.getContext('2d');
  for (let i = 1; i <= n; i++) {
    const t = v.duration * i / (n + 1);
    try {
      v.currentTime = t;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      shots.push({ t: Math.floor(t), data: c.toDataURL('image/jpeg', 0.6) });
    } catch (e) { }
  }
  v.currentTime = keep;
  return shots;
}
function askSeek(seconds, why) {
  const box = msgBox();
  const d = document.createElement('div');
  d.className = 'sys-msg';
  d.style.cssText = 'background:var(--bubble-ai);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin:8px 4px;text-align:left;font-size:13px;line-height:1.7;color:var(--text);';
  d.innerHTML = `他想看 <b>${fmtTime(seconds)}</b> 那里${why ? '：' + esc(why) : ''}
    <div style="display:flex;gap:8px;margin-top:9px;">
      <span class="post-btn" data-yes="1">倒回去</span>
      <span class="post-btn" data-no="1" style="color:var(--text-muted)">不用</span>
    </div>`;
  d.querySelector('[data-yes]').onclick = () => {
    const v = $('stage-video');
    if (v && v.src) { v.currentTime = seconds; v.pause(); }
    d.innerHTML = `<span style="color:var(--text-muted)">画面跳到了 ${fmtTime(seconds)}</span>`;
    sendComposed('好，跳过去了，你看吧。', []);
  };
  d.querySelector('[data-no]').onclick = () => {
    d.innerHTML = '<span style="color:var(--text-muted)">没跳</span>';
  };
  box.appendChild(d); scrollBottom();
}

// ============ 分片上传 ============
let upQueue = [];
async function chunkUpload(file, kind, note) {
  const CH = 3 * 1024 * 1024;
  const ext = (file.name.split('.').pop() || (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase();
  const job = { name: note || file.name, pct: 0 };
  upQueue.push(job);
  drawUp();
  try {
    const b = await jpost('/api/upload/begin', { ext, note, kind });
    if (!b.upload_id) throw new Error('开不了头');
    const total = Math.ceil(file.size / CH);
    for (let i = 0; i < total; i++) {
      const part = file.slice(i * CH, (i + 1) * CH);
      const r = await fetch(`/api/upload/part?id=${b.upload_id}&i=${i}`, { method: 'POST', body: part });
      if (!r.ok) throw new Error('第 ' + (i + 1) + ' 块失败');
      job.pct = Math.round((i + 1) / total * 100);
      drawUp();
    }
    const d = await jpost('/api/upload/finish', { upload_id: b.upload_id });
    if (d.error) throw new Error(d.error);
    toast(kind === 'music' ? '碟放好了' : '片子放好了');
    const room = kind === 'music' ? 'musicroom' : 'cinema';
    if ($(room).classList.contains('open')) openRoomMedia(kind === 'music' ? 'music' : 'video');
    refreshHome();
    return d;
  } catch (e) { toast('上传失败：' + e.message); return null; }
  finally {
    upQueue = upQueue.filter(x => x !== job);
    drawUp();
  }
}
function drawUp() {
  const bar = $('up-bar');
  if (!upQueue.length) { bar.classList.remove('on'); return; }
  const j = upQueue[0];
  $('up-name').textContent = (upQueue.length > 1 ? `（还有 ${upQueue.length - 1} 个）` : '') + j.name;
  $('up-pct').textContent = j.pct + '%';
  $('up-fill').style.width = j.pct + '%';
  bar.classList.add('on');
}

// ============ 信箱 ============
async function openMailbox() {
  $('mailbox').classList.add('open');
  const el = $('mail-list');
  el.innerHTML = '<div class="room-empty">正在开信箱…</div>';
  const r = await callOB('letter_read', { limit: 30 });
  const text = r?.content?.[0]?.text || '';
  if (!text || r.error) { el.innerHTML = '<div class="room-empty">信箱还是空的<br>或者记忆库没连上</div>'; $('mail-sub').textContent = ''; return; }
  const parts = text.split(/\n(?=【|---|\d+\.)/).filter(s => s.trim().length > 8);
  $('mail-sub').textContent = `${parts.length} 封`;
  el.innerHTML = parts.map(p => {
    const mine = /user|简雯慧|宝宝/.test(p.slice(0, 40));
    return `<div class="letter"><div class="letter-from">${mine ? '你写的' : (CFG.name || '凛') + '写的'}</div>
      <div class="letter-body">${esc(p.trim())}</div><div class="stamp">✉</div></div>`;
  }).join('');
}

// ============ 抽屉 ============
async function openDrawer(who) {
  drawerWho = who;
  $('drawer-room').classList.add('open');
  const titles = { library: '资料库', user: '我的抽屉', lin: '凛的抽屉' };
  const subs = { library: '你放进来的东西，你说了他才会看', user: '你自己的。他看得见，打不开。', lin: '他做的东西' };
  $('drawer-title').textContent = titles[who];
  $('drawer-sub').textContent = subs[who];
  $('btn-drawer-add').style.display = who === 'lin' ? 'none' : '';
  const el = $('drawer-list');
  el.innerHTML = '<div class="room-empty">正在拉开…</div>';
  const items = await jget(who === 'library' ? '/api/library' : '/api/drawer/' + who);
  if (!items.length) { el.innerHTML = `<div class="room-empty">${who === 'lin' ? '他还没往里放东西' : '空的'}</div>`; return; }
  el.innerHTML = '';
  items.forEach(x => {
    const d = document.createElement('div'); d.className = 'd-item';
    const canPlay = x.kind === 'html';
    d.innerHTML = `<div class="d-item-title">${esc(x.title)}</div>
      ${x.note || x.about ? `<div class="d-item-note">${esc(x.note || x.about)}</div>` : ''}
      ${x.body ? `<div class="d-item-body">${esc(String(x.body).slice(0, 160))}</div>` : ''}
      ${canPlay ? '<div class="d-kind">能打开玩</div>' : ''}
      <div class="d-item-acts">${canPlay ? '<span data-play="1">▶</span>' : ''}<span data-del="1">✕</span></div>`;
    d.querySelector('[data-del]').onclick = async e => {
      e.stopPropagation();
      if (!confirm('扔掉？')) return;
      await fetch((who === 'library' ? '/api/library/' : `/api/drawer/${who}/`) + x.id, { method: 'DELETE' });
      openDrawer(who); refreshHome();
    };
    const pb = d.querySelector('[data-play]');
    if (pb) pb.onclick = e => { e.stopPropagation(); openPlay(x); };
    d.onclick = async () => {
      if (canPlay) { openPlay(x); return; }
      let body = x.body;
      if (who === 'library') { const full = await jget('/api/library/' + x.id); body = full.text || ''; }
      alert((x.title || '') + '\n\n' + String(body || '').slice(0, 3000));
    };
    el.appendChild(d);
  });
}
function openPlay(x) {
  $('play-box').classList.add('open');
  $('play-title').textContent = x.title;
  $('play-frame').srcdoc = x.body;
}



// ============ 欲望室 ============
const DGROUP = [
  ['朝 她', ['miss', 'lust', 'flutter', 'lean', 'tell', 'own', 'grip']],
  ['朝 自 己', ['curious', 'make', 'still', 'play']],
  ['关 于 她 怎 么 看 他', ['needed', 'seen']],
  ['疼 的 那 些', ['hurt', 'jeal', 'unsure', 'vex', 'worn']],
];
let dimEditing = null, desireData = null, dimViewing = null;

function DIMNAME(k) {
  const x = (desireData && desireData.dims || []).find(d => d.key === k);
  return x ? x.name : k;
}
function gapText(h) {
  if (h < 1) return Math.round(h * 60) + ' 分钟';
  if (h < 24) return h.toFixed(1) + ' 小时';
  return (h / 24).toFixed(1) + ' 天';
}
function radarSvg(dims, topKey) {
  const n = dims.length, R = 92, cx = 132, cy = 122;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  let g = '';
  [0.25, 0.5, 0.75, 1].forEach(f => {
    g += `<polygon class="rd-grid" points="${dims.map((_, i) => pt(i, R * f).map(v => v.toFixed(1)).join(',')).join(' ')}"/>`;
  });
  dims.forEach((_, i) => {
    const [x, y] = pt(i, R);
    g += `<line class="rd-axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  });
  g += `<polygon class="rd-area" points="${dims.map((d, i) => pt(i, R * Math.max(0.02, d.value / 100)).map(v => v.toFixed(1)).join(',')).join(' ')}"/>`;
  dims.forEach((d, i) => {
    if (d.key !== topKey) return;
    const [x, y] = pt(i, R * Math.max(0.02, d.value / 100));
    g += `<circle class="rd-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`;
  });
  dims.forEach((d, i) => {
    const [x, y] = pt(i, R + 14);
    const cos = Math.cos(-Math.PI / 2 + i * 2 * Math.PI / n);
    const anchor = Math.abs(cos) < 0.25 ? 'middle' : (cos > 0 ? 'start' : 'end');
    g += `<text class="rd-lab${d.key === topKey ? ' hot' : ''}" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}">${d.name}</text>`;
  });
  return `<svg viewBox="0 0 264 244" width="100%" style="max-width:340px">${g}</svg>`;
}

async function openDesire() {
  $('desireroom').classList.add('open');
  const el = $('desire-body');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">正在算…</div>';
  let d;
  try { d = await jget('/api/desire/state'); } catch (e) {
    el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">连不上</div>'; return;
  }
  desireData = d;
  const byKey = {}; d.dims.forEach(x => byKey[x.key] = x);
  const topKey = (d.top[0] || {}).key;
  const notes = d.notes || {};
  const edited = new Set((d.disputes || []).slice(0, 40).map(x => x.key));
  const og = (d.grudges || []).filter(g => !g.resolved_at);
  const vr = d.vent_ready || [];
  $('desire-sub').textContent = d.top.map(t => `${t.name} ${Math.round(t.score)}`).join(' · ');

  let h = `<div class="radar">${radarSvg(d.dims, topKey)}</div>
    <div class="d-idle">上次说话 ${gapText(d.idle_hours)}前　·　上次亲密 ${gapText(d.intimate_hours)}前</div>`;

  if (d.jeal && d.jeal.value >= 7) {
    const og2 = (d.grudges || []).filter(g => !g.resolved_at);
    h += `<div class="jeal-card">
      <div class="jeal-top"><span class="jeal-tier">${esc(d.jeal.tier)}</span><span class="jeal-v">${Math.round(d.jeal.value)}</span></div>
      <div class="jeal-how">${esc(d.jeal.how)}</div>
      <div class="jeal-floor">${esc(d.jeal.floor)}</div>
      <div class="jeal-floor" style="border:none;padding-top:4px;">${og2.length
        ? '还有 ' + og2.length + ' 笔没结的账，气消不下去。哄了才会降。'
        : '没有挂账，这股气会自己慢慢消。'}</div></div>`;
  }

  if (vr.length) {
    h += '<div class="d-sec">憋 到 头 了</div>';
    h += `<div class="vent-hint">${vr.map(x => `${x.name} <b>${x.value}</b>`).join('　')}
      <div class="vent-hint-s">系统提了一句，做不做他自己定。他扛完会写在「出口」里，不通知你。</div></div>`;
  }
  if ((d.impulses || []).length) {
    h += '<div class="d-sec">憋 着 想 说 的</div>';
    d.impulses.forEach(i => {
      h += `<div class="imp"><div class="imp-t">${esc(i.word || i.name)}</div>
        <div class="imp-r">${esc(i.name)} ${Math.round(i.value)}　最近涨了 ${Math.round(i.delta || 0)}</div></div>`;
    });
  }

  if (og.length) {
    const wm = { soothe: '想被哄', explain: '想要解释', apologize: '想要道歉', attention: '想被看见' };
    h += `<div class="d-sec">没 结 的 账<span class="d-more" id="btn-soothe-all">哄哄他</span></div>`;
    og.forEach(g => {
      const ago = gapText((Date.now() - g.ts) / 3600000);
      h += `<div class="grudge" data-gid="${g.id}">
        <div class="gr-top"><span class="gr-i">${g.intensity}</span><span class="gr-w">${wm[g.wants] || '想被哄'}</span></div>
        <div class="gr-r">${esc(g.reason)}</div>
        <div class="gr-t">${ago}前记的　<span class="gr-s" data-soothe="${g.id}">这笔哄了</span></div></div>`;
    });
  }

  DGROUP.forEach(([title, keys]) => {
    h += `<div class="d-sec">${title}</div>`;
    keys.forEach(k => {
      const x = byKey[k]; if (!x) return;
      const boost = Math.max(0, x.score - x.value);
      const rc = x.recent || 0;
      h += `<div class="dim${k === topKey ? ' hot' : ''}" data-dim="${k}">
        <div class="dim-top">
          <span class="dim-name">${x.name}${edited.has(k) ? '<span class="dim-edited">改过</span>' : ''}${notes[k] ? '<span class="dim-edited">✎</span>' : ''}</span>
          <span class="dim-v">${Math.round(x.value)}${rc >= 3 ? ` <b>↑${Math.round(rc)}</b>` : (rc <= -3 ? ` ↓${Math.round(-rc)}` : '')}</span>
        </div>
        <div class="dim-track">
          <div class="dim-base" style="left:${x.base}%"></div>
          <div class="dim-fill" style="width:${x.value}%"></div>
          ${boost > 1 ? `<div class="dim-boost" style="left:${x.value}%;width:${Math.min(100 - x.value, boost)}%"></div>` : ''}
        </div></div>`;
    });
  });

  const fixes = (d.thoughts || []).filter(t => t.kind === 'fix');
  const flits = (d.thoughts || []).filter(t => t.kind === 'flit');
  if (fixes.length) {
    h += '<div class="d-sec">反 复 在 想</div>';
    fixes.forEach(t => h += `<div class="d-thought fix"><div class="dt-text">${esc(t.text)}</div>
      <div class="dt-meta"><span class="dt-kind">执念 · ${DIMNAME(t.drive)}</span><span>${(t.strength * 100).toFixed(0)}</span></div></div>`);
  }
  if (flits.length) {
    h += '<div class="d-sec">刚 冒 出 来 的</div>';
    flits.slice(0, 6).forEach(t => h += `<div class="d-thought"><div class="dt-text">${esc(t.text)}</div>
      <div class="dt-meta"><span>${DIMNAME(t.drive)}</span><span>${(t.strength * 100).toFixed(0)}</span></div></div>`);
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-dim]').forEach(row => row.onclick = () => openDimPanel(row.dataset.dim));
  el.querySelectorAll('[data-soothe]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const note = prompt('跟他说句什么？（可以留空）', '') ;
    if (note === null) return;
    await jpost('/api/desire/soothe', { id: b.dataset.soothe, note });
    toast('哄好了'); openDesire(); refreshHome();
  });
  const all = $('btn-soothe-all');
  if (all) all.onclick = async () => {
    if (!confirm('把所有账都结了？')) return;
    await jpost('/api/desire/soothe', {});
    toast('都哄好了'); openDesire(); refreshHome();
  };
}

function curveSvg(hist, key, color) {
  const w = 300, ht = 110, pad = 5, n = hist.length;
  if (n < 2) return '<div class="settings-sub" style="text-align:center;padding:30px 0;">还没有几天的数据</div>';
  let g = '';
  [0, 50, 100].forEach(v => {
    const y = pad + (1 - v / 100) * (ht - pad * 2);
    g += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
  });
  const pts = hist.map((h, j) => [j / (n - 1) * w, pad + (1 - (h.drive[key] ?? 0) / 100) * (ht - pad * 2)]);
  g += `<polyline points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = pts[pts.length - 1];
  g += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="${color}"/>`;
  return `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none">${g}</svg>`;
}

async function openDimPanel(key) {
  dimViewing = key;
  if (!desireData) { try { desireData = await jget('/api/desire/state'); } catch (e) { return; } }
  const d = desireData;
  const x = d.dims.find(v => v.key === key); if (!x) return;
  $('dim-panel').classList.add('open');
  $('dp-name').textContent = x.name;
  const boost = Math.max(0, x.score - x.value);
  $('dp-sub').textContent = (boost > 1 ? `执念顶高了 ${Math.round(boost)}　` : '') + `基线 ${x.base}`;
  $('dp-big').textContent = Math.round(x.value);

  const hist = (d.history || []).filter(h => h.drive && h.drive[key] !== undefined);
  $('dp-curve').innerHTML = curveSvg(hist, key, 'var(--accent)');
  $('dp-range').innerHTML = hist.length > 1
    ? `<span>${hist[0].date.slice(5)}</span><span style="margin-left:auto">${hist[hist.length - 1].date.slice(5)}</span>` : '';

  const note = (d.notes || {})[key];
  const nb = $('dp-note');
  if (note) { nb.className = 'dp-note'; nb.textContent = note.text; }
  else { nb.className = 'dp-note empty'; nb.textContent = '他还没给这一维写过话。\n他想写的时候会自己写。'; }

  const mv = (d.moves || []).filter(m => (m.changes || []).some(c => c.key === key));
  $('dp-moves').innerHTML = mv.length ? mv.slice(0, 40).map(m => {
    const c = m.changes.find(c => c.key === key);
    const t = new Date(m.ts);
    return `<div class="mv">
      <div class="mv-t">${t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      <div class="mv-b"><div class="mv-why">${esc(m.why)}${m.who !== 'sys' ? `<span class="mv-who">${m.who === 'lin' ? (CFG.name || '凛') : (CFG.call_user || '宝宝')}改的</span>` : ''}</div>
        <div class="mv-d">${Math.round(c.from)} <b>${c.to > c.from ? '↑' : '↓'}</b> ${Math.round(c.to)}</div></div></div>`;
  }).join('') : '<div class="settings-sub">还没有变过</div>';
}

function openDim(x) {
  if (!x) return;
  dimEditing = x.key;
  $('dim-title').textContent = x.name;
  $('dim-now').textContent = `系统算出来是 ${Math.round(x.value)}。你觉得不对就改，改了要写一句为什么。`;
  $('dim-range').value = Math.round(x.value);
  $('dim-val').textContent = Math.round(x.value);
  $('dim-why').value = '';
  $('dim-modal').classList.add('open');
}

async function openVents() {
  $('vent-panel').classList.add('open');
  const el = $('vent-list');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">读一下…</div>';
  let list = [];
  try { list = await jget('/api/desire/vent'); } catch (e) { }
  $('vent-count').textContent = list.length ? `${list.length} 次` : '';
  if (!list.length) {
    el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">还是空的<br><br>他憋到头、又自己扛过去的时候<br>会写在这里</div>';
    return;
  }
  el.innerHTML = list.map(v => {
    const t = new Date(v.ts);
    return `<div class="vent">
      <div class="vent-top"><span class="vent-k">${esc(v.name)}</span>
        <span class="vent-n">${v.at} → ${v.to}</span></div>
      <div class="vent-b">${esc(v.text)}</div>
      ${v.said ? `<div class="vent-said"><div class="vent-said-h">没说出口的</div>${esc(v.said)}</div>` : ''}
      <div class="vent-t">${t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
    </div>`;
  }).join('');
}

async function openMoves() {
  $('dispute-panel').classList.add('open');
  const el = $('dispute-list');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">读一下…</div>';
  let d = desireData;
  if (!d) {
    try { d = await jget('/api/desire/state'); desireData = d; }
    catch (e) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">读不到</div>'; return; }
  }
  const list = d.moves || [];
  $('dispute-count').textContent = list.length ? `${list.length} 次` : '';
  if (!list.length) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">还没有动过</div>'; return; }
  el.innerHTML = list.map(m => {
    const t = new Date(m.ts);
    const who = m.who === 'lin' ? (CFG.name || '凛') : (m.who === 'user' ? (CFG.call_user || '宝宝') : '');
    return `<div class="dispute">
      <div class="dp-head">${t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}${who ? ` · ${who}改的` : ''}</div>
      <div class="dp-why" style="border:none;padding:0;margin:0;">${esc(m.why)}</div>
      <div class="mv-d" style="margin-top:7px;">${(m.changes || []).map(c =>
        `${c.name} ${Math.round(c.from)} <b>${c.to > c.from ? '↑' : '↓'}</b> ${Math.round(c.to)}`).join('　')}</div>
    </div>`;
  }).join('');
}



// ============ 电话 ============
// 一直听着：说完停顿一下就自动发过去，像真的打电话。
const CALL = {
  on: false, mini: false, muted: false,
  stream: null, ctx: null, analyser: null, rec: null,
  chunks: [], startAt: 0, turns: 0, timer: null, raf: null,
  speaking: false, silence: 0, heard: false, busy: false,
  speakingOut: false, cutOff: false, cutMs: 0, audio: null,
  endedBy: 'user', who: 'user',
};
const SIL_THRESHOLD = 12;      // 低于这个音量算没在说话
const SIL_MS = 1400;           // 停这么久就当说完了
const MIN_MS = 700;            // 太短的不发，多半是噪音
// 他说话时你插嘴要多大声才算数。太低会被自己的回声打断
const CUT_IN = 30;
const CUT_IN_MS = 260;         // 得持续这么久，防止一声咳嗽就打断
function canCutIn() { return localStorage.getItem('call-cutin') !== '0'; }

function csTime(s) {
  const m = Math.floor(s / 60), x = s % 60;
  return String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
}
function csState(t) { const e = $('cs-state'); if (e) e.textContent = t; }
function csCaption(t, mine) {
  const e = $('cs-caption'); if (!e) return;
  e.textContent = t || '';
  e.className = 'cs-caption' + (mine ? ' me' : '');
}
function csWave(n) {
  const w = $('cs-wave'); if (!w) return;
  if (!w.children.length) {
    for (let i = 0; i < 13; i++) w.appendChild(document.createElement('i'));
  }
  [...w.children].forEach((b, i) => {
    const k = Math.abs(i - 6) / 6;
    b.style.height = Math.max(6, n * (1 - k * 0.6) * 0.34) + 'px';
  });
  w.classList.toggle('on', n > SIL_THRESHOLD);
}

async function startCall(who) {
  if (CALL.on) { $('callscreen').classList.add('open'); CALL.mini = false; $('call-pill').classList.remove('on'); return; }
  if (!navigator.mediaDevices) { toast('这个浏览器用不了麦克风'); return; }
  CALL.who = who || 'user';
  $('callscreen').classList.add('open');
  $('call-pill').classList.remove('on');
  CALL.mini = false;
  $('cs-name').textContent = CFG.name || '凛';
  const av = localStorage.getItem('chat-avatar-ai');
  const ae = $('cs-avatar');
  if (av) { ae.classList.add('has-img'); ae.innerHTML = '<img src="' + av + '">'; }
  else { ae.classList.remove('has-img'); ae.innerHTML = '<span>' + (CFG.name || '凛')[0] + '</span>'; }
  ae.classList.add('ring');
  csState('正在接通…'); csCaption(''); $('cs-timer').textContent = '';
  csWave(0);

  try {
    CALL.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { toast('拿不到麦克风'); endCall('error'); return; }

  CALL.on = true; CALL.turns = 0; CALL.startAt = Date.now();
  CALL.endedBy = 'user'; CALL.muted = false; CALL.busy = false;
  try {
    CALL.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = CALL.ctx.createMediaStreamSource(CALL.stream);
    CALL.analyser = CALL.ctx.createAnalyser();
    CALL.analyser.fftSize = 512;
    src.connect(CALL.analyser);
  } catch (e) { }

  CALL.timer = setInterval(() => {
    const s = Math.floor((Date.now() - CALL.startAt) / 1000);
    $('cs-timer').textContent = csTime(s);
    const cp = $('cp-timer'); if (cp) cp.textContent = csTime(s);
  }, 500);

  // 接通：他先说一句
  await sleep(700);
  ae.classList.remove('ring');
  csState('通话中');
  await callTurn(CALL.who === 'lin' ? '（她接了你的电话）' : '（她给你打电话了）', true);
  listenLoop();
}

function listenLoop() {
  if (!CALL.on) return;
  const buf = new Uint8Array(CALL.analyser ? CALL.analyser.frequencyBinCount : 0);
  const tick = () => {
    if (!CALL.on) return;
    CALL.raf = requestAnimationFrame(tick);
    if (!CALL.analyser) return;
    CALL.analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const vol = sum / buf.length;
    if (!CALL.busy && !CALL.muted) csWave(vol);

    // 他正在说，你出声就掐掉他
    if (CALL.speakingOut && canCutIn() && !CALL.muted) {
      if (vol > CUT_IN) {
        CALL.cutMs += 16;
        if (CALL.cutMs > CUT_IN_MS) {
          CALL.cutMs = 0;
          cutHimOff();
        }
      } else CALL.cutMs = 0;
      return;
    }
    if (CALL.busy || CALL.muted) return;
    if (vol > SIL_THRESHOLD) {
      CALL.silence = 0;
      if (!CALL.speaking) { CALL.speaking = true; CALL.heard = false; recStart(); }
      if (Date.now() - CALL.recAt > MIN_MS) CALL.heard = true;
    } else if (CALL.speaking) {
      CALL.silence += 16;
      if (CALL.silence > SIL_MS) {
        CALL.speaking = false; CALL.silence = 0;
        recStop(CALL.heard);
      }
    }
  };
  tick();
}

function cutHimOff() {
  // 他说到一半被你打断——停掉声音，马上开始听你说
  try { if (CALL.audio) { CALL.audio.pause(); CALL.audio.currentTime = 0; } } catch (e) { }
  CALL.speakingOut = false;
  CALL.cutOff = true;
  const ae = $('cs-avatar'); if (ae) ae.classList.remove('speak');
  CALL.busy = false;
  csState('在听…');
  CALL.speaking = true; CALL.heard = false; CALL.silence = 0;
  recStart();
}

function recStart() {
  try {
    let mime = '';
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    CALL.rec = mime ? new MediaRecorder(CALL.stream, { mimeType: mime }) : new MediaRecorder(CALL.stream);
    CALL.chunks = [];
    CALL.rec.ondataavailable = e => { if (e.data && e.data.size) CALL.chunks.push(e.data); };
    CALL.rec.start();
    CALL.recAt = Date.now();
    csState('在听…');
  } catch (e) { }
}

function recStop(send) {
  if (!CALL.rec) return;
  const rec = CALL.rec; CALL.rec = null;
  rec.onstop = async () => {
    csWave(0);
    if (!send || !CALL.on) { csState('通话中'); return; }
    const blob = new Blob(CALL.chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size < 1500) { csState('通话中'); return; }
    CALL.busy = true;
    csState('正在听懂…');
    let text = '';
    try {
      const fd = new FormData();
      fd.append('file', blob, 'call.' + ((rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm'));
      const d = await (await fetch('/api/stt', { method: 'POST', body: fd })).json();
      text = (d.text || '').trim();
    } catch (e) { }
    if (!text) { CALL.busy = false; csState('通话中'); return; }
    csCaption(text, true);
    await callTurn(text, false);
    CALL.busy = false;
    if (CALL.on) csState('通话中');
  };
  try { rec.stop(); } catch (e) { csState('通话中'); }
}

// 一轮：把你说的发过去，他回，念出来
async function callTurn(text, silentUser) {
  if (!CALL.on) return;
  CALL.turns++;
  if (!silentUser) {
    messages.push({ role: 'user', content: text, _call: true });
    saveConv();
  } else {
    messages.push({ role: 'user', content: text, _internal: true, _call: true });
  }
  csState('他在想…');
  let reply = '';
  try {
    const hist = buildMsgs(messages);
    const r = await fetch('/api/chat-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: currentModel, messages: hist, tools: buildTools(),
        extra: '你们正在通电话。说话要像说话：短、有停顿、可以接不上茬。'
          + '不要写成书面语，不要用括号描写动作。想挂电话就在最后写 [[挂了]]。',
        _session_id: getSessionId(), _conv_id: currentConvId, max_tokens: 300
      })
    });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue;
        const raw = ln.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw);
          if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
            reply += d.delta.text;
            csCaption(reply.replace(/\[\[挂了\]\]/g, ''), false);
          }
        } catch (e) { }
      }
    }
  } catch (e) { csState('断了'); }

  const hang = /\[\[挂了\]\]/.test(reply);
  reply = reply.replace(/\[\[挂了\]\]/g, '').trim();
  if (reply) {
    messages.push({ role: 'assistant', content: reply, _call: true });
    saveConv();
    csCaption(reply, false);
    await speakOut(reply);
    if (CALL.cutOff) {
      // 被打断了，让他知道自己话没说完
      messages.push({ role: 'user', _internal: true, _call: true,
        content: '（你话说到一半，她插话了）' });
      CALL.cutOff = false;
    }
  }
  if (hang) { await sleep(500); endCall('lin'); }
}

async function speakOut(text) {
  if (!CALL.on) return;
  const ae = $('cs-avatar');
  csState('说话中');
  ae.classList.add('speak');
  CALL.busy = true;
  CALL.speakingOut = true;
  CALL.cutOff = false;
  CALL.cutMs = 0;
  try {
    const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
    const r = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 500), voice })
    });
    if (r.ok) {
      const url = URL.createObjectURL(await r.blob());
      await new Promise(res => {
        const a = new Audio(url);
        CALL.audio = a;
        a.onended = a.onerror = () => { URL.revokeObjectURL(url); res(); };
        a.play().catch(() => res());
      });
    }
  } catch (e) { }
  if (!CALL.cutOff) {
    CALL.speakingOut = false;
    ae.classList.remove('speak');
    CALL.busy = false;
  }
}

async function endCall(by) {
  if (!CALL.on && by !== 'error') { $('callscreen').classList.remove('open'); return; }
  const secs = Math.floor((Date.now() - CALL.startAt) / 1000);
  CALL.on = false;
  CALL.endedBy = by || 'user';
  if (CALL.raf) cancelAnimationFrame(CALL.raf);
  if (CALL.timer) clearInterval(CALL.timer);
  try { if (CALL.rec && CALL.rec.state !== 'inactive') CALL.rec.stop(); } catch (e) { }
  try { if (CALL.audio) CALL.audio.pause(); } catch (e) { }
  try { if (CALL.stream) CALL.stream.getTracks().forEach(t => t.stop()); } catch (e) { }
  try { if (CALL.ctx) CALL.ctx.close(); } catch (e) { }
  CALL.stream = null; CALL.ctx = null; CALL.analyser = null;
  CALL.speakingOut = false; CALL.cutOff = false; CALL.busy = false;

  csState(by === 'lin' ? '他挂了' : '已挂断');
  $('call-pill').classList.remove('on');
  if (CALL.turns === 0 || secs <= 2) {
    // 没说上话就挂了，也留一条
    const nowT = Date.now();
    const info = {
      label: secs <= 2 ? '已取消' : '未接通',
      side: 'user', kind: 'missed',
      time: new Date(nowT).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    };
    messages.push({
      role: 'user', _internal: true, _callmark: true, _callinfo: info, _ts: nowT,
      content: '（打了电话，没说上话）'
    });
    saveConv();
    addCallBubble(info, messages.length - 1);
  }
  const now = Date.now();
  const hhmm = new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (CALL.turns > 0 && secs > 2) {
    // 通话记录进聊天，话题才接得上；顺便在聊天里留一条气泡
    const info = {
      label: '通话时长 ' + csTime(secs),
      side: by === 'lin' ? 'lin' : 'user',
      kind: 'call', time: hhmm
    };
    messages.push({
      role: 'user', _internal: true, _callmark: true, _callinfo: info, _ts: now,
      content: `（通话结束，聊了 ${csTime(secs)}，${by === 'lin' ? '他挂的' : '她挂的'}）`
    });
    saveConv();
    addCallBubble(info, messages.length - 1);
    jpost('/api/call/log', {
      who: CALL.who, secs, turns: CALL.turns,
      ended_by: CALL.endedBy, conv: currentConvId
    }).catch(() => { });
  }
  await sleep(900);
  $('callscreen').classList.remove('open');
  csCaption('');
  if (!roomCtx) showPage('chat');
}

async function checkMissed() {
  try {
    const list = await jget('/api/call/missed');
    const dot = $('call-dot');
    if (dot) dot.classList.toggle('on', list.length > 0);
    // 他打来没接到的，在聊天里补一条，不然只有个红点太容易漏
    const shown = JSON.parse(localStorage.getItem('missed-shown') || '[]');
    const fresh = list.filter(m => !shown.includes(m.id));
    if (fresh.length && currentConvId) {
      fresh.reverse().forEach(mm => {
        const info = {
          label: '未接来电' + (mm.why ? '　' + mm.why.slice(0, 16) : ''),
          side: 'lin', kind: 'missed',
          time: new Date(mm.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        };
        messages.push({
          role: 'user', _internal: true, _callmark: true, _callinfo: info, _ts: mm.ts,
          content: `（他给你打过电话，你没接${mm.why ? '。他说：' + mm.why : ''}）`
        });
        if (!roomCtx) addCallBubble(info, messages.length - 1);
      });
      saveConv();
      localStorage.setItem('missed-shown',
        JSON.stringify([...shown, ...list.map(m => m.id)].slice(-60)));
    }
    return list;
  } catch (e) { return []; }
}

async function openCallLog() {
  $('calllog-panel').classList.add('open');
  const el = $('calllog-list');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">读一下…</div>';
  const [log, missed] = await Promise.all([
    jget('/api/call/log').catch(() => []),
    jget('/api/call/missed').catch(() => [])
  ]);
  $('calllog-sub').textContent = log.length ? `${log.length} 次` : '';
  let h = '';
  if (missed.length) {
    h += '<div class="d-sec">他 打 过 来 的</div>';
    missed.forEach(mm => {
      const t = new Date(mm.ts);
      h += `<div class="call-row"><div class="call-ico miss">☏</div>
        <div class="call-b"><div class="call-t">未接来电${mm.why ? '　' + esc(mm.why) : ''}</div>
        <div class="call-s">${t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div></div></div>`;
    });
    h += '<button class="btn-ghost" id="btn-clear-missed" style="width:100%;margin-top:10px;font-size:13px;padding:9px;">知道了</button>';
  }
  if (log.length) {
    h += '<div class="d-sec">通 话 记 录</div>';
    log.forEach(l => {
      const t = new Date(l.ts);
      h += `<div class="call-row"><div class="call-ico">☏</div>
        <div class="call-b"><div class="call-t">${l.who === 'lin' ? '他打来' : '打给他'}　${csTime(l.secs)}</div>
        <div class="call-s">${t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}　说了 ${l.turns} 轮　${l.ended_by === 'lin' ? '他挂的' : '你挂的'}</div></div></div>`;
    });
  }
  if (!h) h = '<div class="room-empty" style="color:var(--text-muted)">还没打过电话</div>';
  el.innerHTML = h;
  const cm = $('btn-clear-missed');
  if (cm) cm.onclick = async () => {
    await fetch('/api/call/missed', { method: 'DELETE' });
    checkMissed(); openCallLog();
  };
}

// ============ 额度 ============
function money(v) {
  const n = Number(v || 0);
  return (n < 0.01 && n > 0) ? '<$0.01' : '$' + n.toFixed(2);
}
function bigNum(v) {
  const n = Number(v || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function barsSvg(series, key, color) {
  if (!series.length) return '';
  const w = 300, h = 90, gap = 2;
  const max = Math.max.apply(null, series.map(s => Number(s[key]) || 0).concat([0.0001]));
  const bw = Math.max(2, (w - gap * (series.length - 1)) / series.length);
  let g = '';
  series.forEach((s, i) => {
    const v = Number(s[key]) || 0;
    const bh = Math.max(1, v / max * (h - 6));
    g += '<rect x="' + (i * (bw + gap)).toFixed(1) + '" y="' + (h - bh).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) +
      '" rx="1" fill="' + color + '" opacity="' + (i === series.length - 1 ? 1 : 0.55) + '"/>';
  });
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:90px;display:block;">' + g + '</svg>';
}
async function openUsage() {
  $('usage-panel').classList.add('open');
  const el = $('usage-body');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">算一下…</div>';
  let d;
  try { d = await jget('/api/ledger?n=30'); } catch (e) {
    el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">读不到</div>'; return;
  }
  const t = d.total || {}, today = d.today || {}, s = d.series || [];
  const up = d.upstream || {};
  const hit = t.in ? (t.cached / t.in * 100) : 0;
  $('usage-sub').textContent = d.upstream_name || '';
  let h = '';
  if (up.total_credits != null || up.total_usage != null) {
    const left = (Number(up.total_credits) || 0) - (Number(up.total_usage) || 0);
    h += '<div class="u-hero"><div class="u-hero-l">上游余额</div><div class="u-hero-v">' +
      money(left) + '</div><div class="u-hero-s">充了 ' + money(up.total_credits) +
      '　已用 ' + money(up.total_usage) + '</div></div>';
  }
  h += '<div class="u-grid">' +
    '<div class="u-card"><div class="u-l">今天花的</div><div class="u-v">' + money(today.cost) +
      '</div><div class="u-s">' + (today.req || 0) + ' 次</div></div>' +
    '<div class="u-card"><div class="u-l">一共花的</div><div class="u-v">' + money(t.cost) +
      '</div><div class="u-s">' + (t.req || 0) + ' 次</div></div>' +
    '<div class="u-card"><div class="u-l">Token 量</div><div class="u-v">' + bigNum((t.in || 0) + (t.out || 0)) +
      '</div><div class="u-s">进 ' + bigNum(t.in) + '　出 ' + bigNum(t.out) + '</div></div>' +
    '<div class="u-card"><div class="u-l">缓存命中</div><div class="u-v">' + hit.toFixed(0) +
      '%</div><div class="u-s">省下 ' + bigNum(t.cached) + '</div></div></div>';
  if (s.length) {
    h += '<div class="d-sec">每 天 花 了 多 少</div><div class="u-chart">' +
      barsSvg(s, 'cost', 'var(--accent)') + '</div>' +
      '<div class="u-x"><span>' + s[0].date.slice(5) + '</span><span>' +
      s[s.length - 1].date.slice(5) + '</span></div>';
    h += '<div class="d-sec">每 天 聊 了 几 次</div><div class="u-chart">' +
      barsSvg(s, 'req', 'var(--text-muted)') + '</div>';
    const last = s[s.length - 1];
    const bm = last.by_model || {}, bw = last.by_where || {};
    if (Object.keys(bm).length) {
      h += '<div class="d-sec">今 天 用 了 哪 些</div>';
      Object.entries(bm).sort((a, b) => b[1].cost - a[1].cost).forEach(([m, v]) => {
        h += '<div class="u-row"><span>' + esc(m.split('/').pop()) +
          '</span><span class="u-row-r">' + v.req + ' 次　' + money(v.cost) + '</span></div>';
      });
    }
    if (Object.keys(bw).length) {
      const wn = { chat: '聊天', room: '房间里', wake: '他自己醒来' };
      h += '<div class="d-sec">花 在 哪 儿</div>';
      Object.entries(bw).sort((a, b) => b[1].cost - a[1].cost).forEach(([k, v]) => {
        h += '<div class="u-row"><span>' + (wn[k] || k) +
          '</span><span class="u-row-r">' + v.req + ' 次　' + money(v.cost) + '</span></div>';
      });
    }
  } else {
    h += '<div class="settings-sub" style="text-align:center;padding:30px 0;">还没有记录。聊几句就有了。</div>';
  }
  h += '<div class="settings-sub" style="margin-top:20px;line-height:1.9;">' +
    '按每一轮真实用量自己算的，不依赖上游。缓存命中那部分按一折计价。<br>' +
    '单价是估的，看趋势准，看绝对值有偏差。</div>' +
    '<button class="btn-ghost" id="btn-ledger-clear" style="width:100%;margin-top:12px;font-size:13px;padding:9px;">清空记录</button>';
  el.innerHTML = h;
  const cb = $('btn-ledger-clear');
  if (cb) cb.onclick = async () => {
    if (!confirm('清空所有用量记录？')) return;
    await fetch('/api/ledger', { method: 'DELETE' });
    openUsage(); loadBalance();
  };
}

// ============ 搜聊天记录 ============
function allConvMessages() {
  const out = [];
  getConvs().forEach(c => {
    let msgs = [];
    try { msgs = JSON.parse(localStorage.getItem('conv-' + c.id) || '[]'); } catch (e) { }
    msgs.forEach((m, i) => {
      if (m._internal || m.role === 'tool') return;
      if (m.role === 'user' && Array.isArray(m.content) && m.content.some(x => x && x.type === 'tool_result')) return;
      const t = typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '');
      if (!t.trim()) return;
      out.push({ conv: c.id, title: c.title || '对话', idx: i, role: m.role, text: t });
    });
  });
  return out;
}
function hiWord(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text.slice(0, 60));
  const a = Math.max(0, i - 18), b = Math.min(text.length, i + q.length + 42);
  return (a > 0 ? '…' : '') + esc(text.slice(a, i)) +
    '<b class="hl-w">' + esc(text.slice(i, i + q.length)) + '</b>' +
    esc(text.slice(i + q.length, b)) + (b < text.length ? '…' : '');
}
let searchTimer = null;
function doSearch() {
  const q = $('search-input').value.trim();
  const el = $('search-result');
  if (!q) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">搜你们说过的话</div>'; return; }
  const hits = allConvMessages().filter(m => m.text.toLowerCase().includes(q.toLowerCase()));
  if (!hits.length) {
    el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">没找到「' + esc(q) + '」</div>';
    return;
  }
  const byConv = {};
  hits.forEach(m => { (byConv[m.conv] = byConv[m.conv] || []).push(m); });
  let h = '<div class="sr-total">共 <b>' + hits.length + '</b> 条相关聊天记录</div>';
  Object.entries(byConv).forEach(([cid, list]) => {
    h += '<div class="sr-conv">' + esc(list[0].title) + '　<span>' + list.length + ' 条</span></div>';
    list.slice(0, 40).forEach(m => {
      const who = m.role === 'user' ? (CFG.call_user || '宝宝') : (CFG.name || '凛');
      h += '<div class="sr-item" data-conv="' + cid + '" data-idx="' + m.idx + '">' +
        '<div class="sr-who">' + esc(who) + '</div>' +
        '<div class="sr-text">' + hiWord(m.text, q) + '</div></div>';
    });
  });
  el.innerHTML = h;
  el.querySelectorAll('[data-conv]').forEach(it => it.onclick = () => {
    const cid = it.dataset.conv, idx = parseInt(it.dataset.idx);
    $('search-panel').classList.remove('open');
    if (cid !== currentConvId) { if (messages.length) saveConv(); loadConv(cid); }
    showPage('chat');
    setTimeout(() => {
      const row = document.querySelector('#messages .msg-row[data-msg-idx="' + idx + '"]');
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('sr-flash');
        setTimeout(() => row.classList.remove('sr-flash'), 2200);
      }
    }, 320);
  });
}

// ============ 朋友圈 ============
function relTime(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 8) return d + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function emojiHtml(t) {
  const customs = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
  let h = esc(t);
  customs.forEach(it => {
    if (!it.name) return;
    const e = it.name;
    h = h.split('[' + e + ']').join(`<img src="${it.data}" alt="${it.name}">`);
  });
  return h;
}
async function openMoments() {
  $('momentsroom').classList.add('open');
  const el = $('post-list');
  el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">正在看…</div>';
  const items = await jget('/api/posts');
  $('moments-sub').textContent = items.length ? `${items.length} 条` : '还没有人发';
  if (!items.length) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">还没有人发过<br>右上角发一条</div>'; return; }
  const avU = localStorage.getItem('chat-avatar-user'), avL = localStorage.getItem('chat-avatar-ai');
  el.innerHTML = '';
  items.forEach(p => {
    const mine = p.author === 'user';
    const av = mine ? avU : avL;
    const nm = mine ? (CFG.call_user || '宝宝') : (CFG.name || '凛');
    const d = document.createElement('div');
    d.className = 'post';
    const liked = (p.likes || []).includes('user');
    const cms = (p.comments || []).map(c =>
      `<div class="post-cm" data-cid="${c.id}"><b>${c.author === 'user' ? esc(CFG.call_user || '宝宝') : esc(CFG.name || '凛')}</b>：${emojiHtml(c.text)}<span class="x" data-delcm="${c.id}">✕</span></div>`).join('');
    const likeTxt = (p.likes || []).map(x => x === 'user' ? (CFG.call_user || '宝宝') : (CFG.name || '凛')).join('、');
    d.innerHTML = `
      <div class="post-av${av ? ' has-img' : ''}">${av ? `<img src="${av}">` : esc(nm[0])}</div>
      <div class="post-main">
        <div class="post-who">${esc(nm)}</div>
        ${p.text ? `<div class="post-text">${emojiHtml(p.text)}</div>` : ''}
        ${(p.images || []).length ? `<div class="post-imgs n${p.images.length}">${p.images.map(u => `<img src="${u}" loading="lazy">`).join('')}</div>` : ''}
        <div class="post-foot">
          <span class="post-time">${relTime(p.ts)}</span>
          <div class="post-acts">
            <span class="post-btn" data-like="${p.id}">${liked ? '取消赞' : '赞'}</span>
            <span class="post-btn" data-cm="${p.id}">评论</span>
            <span class="post-del" data-del="${p.id}">删</span>
          </div>
        </div>
        ${(likeTxt || cms) ? `<div class="post-react">
          ${likeTxt ? `<div class="post-likes${cms ? ' has-cm' : ''}">♡ ${esc(likeTxt)}</div>` : ''}
          ${cms}</div>` : ''}
      </div>`;
    d.querySelector('[data-like]').onclick = async () => {
      await jpost(`/api/posts/${p.id}/like`, { author: 'user' }); openMoments();
    };
    d.querySelector('[data-cm]').onclick = () => {
      cmTarget = p.id;
      $('cm-bar').classList.add('open');
      $('cm-input').focus();
    };
    d.querySelector('[data-del]').onclick = async () => {
      if (!confirm('删掉这条？')) return;
      await fetch('/api/posts/' + p.id, { method: 'DELETE' }); openMoments(); refreshHome();
    };
    d.querySelectorAll('[data-delcm]').forEach(x => x.onclick = async () => {
      if (!confirm('删掉这条评论？')) return;
      await fetch(`/api/posts/${p.id}/comment/${x.dataset.delcm}`, { method: 'DELETE' }); openMoments();
    });
    d.querySelectorAll('.post-imgs img').forEach(im => im.onclick = () => openLightbox(im.src, '', ''));
    el.appendChild(d);
  });
}
function drawPostThumbs() {
  const box = $('post-thumbs');
  box.innerHTML = '';
  postImgs.forEach((u, i) => {
    const w = document.createElement('div'); w.className = 'pc-wrap';
    w.innerHTML = `<img class="pc-thumb" src="${u}"><div class="pc-x">✕</div>`;
    w.querySelector('.pc-x').onclick = () => { postImgs.splice(i, 1); drawPostThumbs(); };
    box.appendChild(w);
  });
}

// ============ 时光各页 ============
async function openTimeline() {
  $('tp-timeline').classList.add('open');
  const el = $('tl-list');
  const items = await jget('/api/timeline');
  $('tl-count').textContent = items.length ? `${items.length} 件` : '';
  if (!items.length) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">他还没写过<br>觉得某件事特别，他会自己写上来</div>'; return; }
  el.innerHTML = items.map(x => `<div class="tl-item">
    <div class="tl-date">${(x.date || '').replace(/-/g, ' · ')}</div>
    ${x.title ? `<div class="tl-title">${esc(x.title)}</div>` : ''}
    <div class="tl-text">${esc(x.text)}</div></div>`).join('');
}
let quoteWho = 'user';
async function openQuotes(who) {
  quoteWho = who;
  $('tp-quote').classList.add('open');
  $('q-title').textContent = who === 'user' ? '他说的话' : '我说的话';
  $('btn-add-quote').style.display = who === 'user' ? '' : 'none';
  const items = await jget('/api/quotes/' + who);
  $('q-count').textContent = items.length ? `${items.length} 句` : (who === 'user' ? '还没收过' : '他还没收过');
  const el = $('q-list');
  if (!items.length) {
    el.innerHTML = `<div class="room-empty" style="color:var(--text-muted)">${who === 'user' ? '他说的话里，你想留住的<br>在聊天里点 ❤ 就能收' : '他收着的，你说过的话<br>他自己判断要不要收'}</div>`;
    return;
  }
  el.innerHTML = items.map(x => `<div class="qcard">
    <div class="qmark">"</div>
    <div class="qdate">${(x.date || '').replace(/-/g, ' · ')}</div>
    <div class="qtext">${esc(x.text)}</div>
    ${x.why ? `<div class="qwhy">${esc(x.why)}</div>` : ''}
    <div class="qdel" data-del="${x.id}">✕</div></div>`).join('');
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('删掉？')) return;
    await fetch(`/api/quotes/${who}/${b.dataset.del}`, { method: 'DELETE' });
    openQuotes(who); refreshTimeCounts();
  });
}

// ============ 时光：照片墙 ============
async function renderMemories() {
  const grid = $('memory-grid');
  try {
    const items = await jget('/api/memories');
    $('memory-count').textContent = items.length ? `${items.length} 张` : '';
    if (!items.length) { grid.innerHTML = '<div class="memory-empty">还没有照片<br>上传一张开始吧</div>'; return; }
    grid.innerHTML = '';
    items.forEach(m => {
      const d = document.createElement('div'); d.className = 'memory-item';
      const dt = new Date(parseInt(m.ts));
      const ds = isNaN(dt) ? '' : dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      d.innerHTML = `<img src="${m.url}" loading="lazy"><div class="memory-item-info">
        <div class="memory-item-date">${ds}</div>
        ${m.note ? `<div class="memory-item-note">${esc(m.note)}</div>` : ''}</div>
        <div class="memory-delete">✕</div>`;
      d.querySelector('.memory-delete').onclick = async e => {
        e.stopPropagation();
        if (!confirm('删掉这张？')) return;
        await fetch('/api/memories/' + m.filename, { method: 'DELETE' });
        renderMemories();
      };
      d.querySelector('img').onclick = () => openLightbox(m.url, m.note, ds);
      grid.appendChild(d);
    });
  } catch (e) { grid.innerHTML = '<div class="memory-empty">加载失败</div>'; }
}

// ============ 日历 ============
let calData = {};
async function renderCalendar() {
  const now = new Date();
  if (!calYear) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  try { calData = await jget('/api/calendar'); } catch (e) { calData = {}; }
  $('cal-title').textContent = `${calYear} 年 ${calMonth + 1} 月`;
  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  const grid = $('cal-grid');
  grid.innerHTML = ['日', '一', '二', '三', '四', '五', '六'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < first; i++) grid.insertAdjacentHTML('beforeend', '<div class="cal-cell blank"></div>');
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (let d = 1; d <= days; d++) {
    const key = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const info = calData[key] || {};
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (key === todayKey ? ' today' : '') + (info.text ? ' has' : '');
    cell.innerHTML = `<div class="cal-day">${d}</div>${info.text ? '<div class="cal-txt"></div>' : ''}`;
    cell.onclick = () => {
      const box = $('day-read');
      if (!info.text) { box.style.display = 'none'; toast('这天他没写东西'); return; }
      $('day-read-d').textContent = key.replace(/-/g, ' · ');
      $('day-read-t').textContent = info.text;
      box.style.display = 'block';
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    grid.appendChild(cell);
  }
  $('day-read').style.display = 'none';
}

// ============ 碎碎念 / 犯错本 ============
async function renderMumbles() {
  const el = $('mumble-list');
  const items = await jget('/api/notes');
  $('mumble-count').textContent = items.length ? `${items.length} 条` : '';
  if (!items.length) { el.innerHTML = '<div class="room-empty" style="color:var(--text-muted)">他还没写过什么<br>这里是他自己的地方</div>'; return; }
  el.innerHTML = items.map((x, i) => {
    const d = new Date(x.ts);
    return `<div class="pin ${PINC[i % 4]}">
      <div class="pin-body">${esc(x.text)}</div>
      ${x.mood ? `<div class="pin-tag">${esc(x.mood)}</div>` : ''}
      <div class="pin-date">${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>`;
  }).join('');
}
async function renderFaults() {
  const el = $('fault-list');
  const items = await jget('/api/faults');
  if (!items.length) { el.innerHTML = '<div class="room-empty">还是空的<br>他觉得自己做错了才会写</div>'; return; }
  el.innerHTML = items.map(x => {
    const d = new Date(x.ts);
    return `<div class="fault">
      <div class="fault-h">错 在 哪</div><div class="fault-b">${esc(x.what)}</div>
      ${x.sorry ? `<div class="fault-h">对 不 起</div><div class="fault-b">${esc(x.sorry)}</div>` : ''}
      ${x.how ? `<div class="fault-h">以 后</div><div class="fault-b">${esc(x.how)}</div>` : ''}
      <div class="mumble-date">${d.toLocaleDateString('zh-CN')}</div></div>`;
  }).join('');
}

// ============ 唤醒 ============
async function markWakeRead() { try { await fetch('/api/wake/read', { method: 'POST' }); } catch (e) { } }
async function renderWakeLog() {
  $('wake-panel').classList.add('open');
  const el = $('wake-list');
  el.innerHTML = '<div class="room-empty">读取中…</div>';
  const d = await jget('/api/wake/log');
  $('wake-count').textContent = d.log.length ? `${d.log.length} 次` : '';
  if (!d.log.length) { el.innerHTML = '<div class="room-empty">他还没自己醒过</div>'; return; }
  el.innerHTML = d.log.map(x => {
    const t = new Date(x.ts);
    const did = (x.did || []).length ? `<div class="mumble-date" style="text-align:left;">做了：${x.did.join('、')}</div>` : '';
    return `<div class="mumble"><div class="mumble-body">${esc(x.said || '（这次什么都没说）')}</div>
      ${did}<div class="mumble-date">${t.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${x.manual ? ' · 你叫的' : ''}</div></div>`;
  }).join('');
  markWakeRead(); $('dot-chat').classList.remove('on');
}

// ============ 人设 ============
let personaOrig = {};
const PF = ['core', 'rhythm', 'lines', 'always'];
function personaRead() {
  return {
    core: $('p-core').value, rhythm: $('p-rhythm').value, lines: $('p-lines').value,
    always: $('p-always').value,
    call_user: $('p-call').value.trim(), call_serious: $('p-call2').value.trim(),
    max_tokens: parseInt($('p-maxtok').value) || 500,
    together_since: $('p-since').value,
    voice_id_calm: $('p-vid-calm').value.trim(), voice_id_dog: $('p-vid-dog').value.trim(),
    password: $('p-pwd').value.trim() || '0606',
  };
}
function personaFill(p) {
  $('p-core').value = p.core || ''; $('p-rhythm').value = p.rhythm || ''; $('p-lines').value = p.lines || '';
  $('p-always').value = p.always || '';
  $('p-call').value = p.call_user || ''; $('p-call2').value = p.call_serious || '';
  $('p-maxtok').value = p.max_tokens || 500; $('p-since').value = p.together_since || '2026-06-06';
  $('p-vid-calm').value = p.voice_id_calm || ''; $('p-vid-dog').value = p.voice_id_dog || '';
  $('p-pwd').value = p.password || '0606';
  personaMeter();
}
function personaMeter() {
  const n = PF.reduce((s, f) => s + $('p-' + f).value.length, 0);
  $('p-count').textContent = `${n} 字`;
  $('p-tok').textContent = `每轮约 ${Math.round(n * 1.4 + 380)} token`;
  $('persona-meter').classList.toggle('warn', n > 2600);
  const dirty = JSON.stringify(personaRead()) !== JSON.stringify(personaOrig);
  $('persona-dirty').classList.toggle('on', dirty);
}
async function openPersona() {
  $('persona-panel').classList.add('open');
  const p = await jget('/api/persona');
  personaFill(p); personaOrig = personaRead(); personaMeter();
}
async function savePersona() {
  const d = personaRead();
  const r = await jpost('/api/persona', d);
  if (r.error) { toast(r.error); return; }
  CFG = { ...CFG, ...d };
  personaOrig = personaRead(); personaMeter();
  toast('生效了，下一句就是新的他');
}

// ============ 启动 ============
async function boot() {
  try { CFG = await jget('/api/config'); } catch (e) { CFG = {}; }
  $('lin-name').textContent = CFG.name || '凛';
  showLinState(CFG.lin_status);
  const theme = localStorage.getItem('theme') || '';
  document.body.className = theme ? 'theme-' + theme : '';
  const bg = localStorage.getItem('chat-bg');
  if (bg) { document.body.style.backgroundImage = `url(${bg})`; $('clear-bg-btn').style.display = 'flex'; }
  const av = localStorage.getItem('chat-avatar-ai');
  if (av) { $('avatar').classList.add('has-img'); $('avatar').innerHTML = `<img src="${av}">`; }
  showUserStatus(localStorage.getItem('user-status'));
  currentModel = localStorage.getItem('model') || 'anthropic/claude-sonnet-4-6';
  ctxWindow = parseInt(localStorage.getItem('ctx-window') ?? '15');
  loadMcp(); updateMcpSub(); renderToolGroups();
  document.querySelectorAll('[data-val]').forEach(o => o.classList.toggle('active', parseInt(o.dataset.val) === ctxWindow));
  $('ctx-sub').textContent = ctxWindow ? `每次带最近 ${ctxWindow} 轮` : '带上全部（贵）';
  const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
  document.querySelectorAll('[data-voice]').forEach(o => o.classList.toggle('active', o.dataset.voice === voice));
  $('auto-voice-toggle').checked = localStorage.getItem('auto-voice') === '1';
  $('wake-on').checked = !!CFG.wake_on;
  const wi = CFG.wake_interval || 120;
  document.querySelectorAll('[data-wake]').forEach(o => o.classList.toggle('active', parseInt(o.dataset.wake) === wi));
  { const e = $('wake-cost'); if (e) e.textContent = wi <= 55 ? '这个间隔在缓存有效期（1 小时）内，每次醒来便宜。' : '超过 1 小时，缓存会过期，每次醒来要全价重建一次 system。想省就选 45 分以内。'; }
  try { const p = await jget('/api/persona'); $('wake-prompt').value = p.wake_prompt || ''; CFG.call_user = p.call_user; showUserStatus(localStorage.getItem('user-status')); } catch (e) { }
  const last = localStorage.getItem('current-conv-id'), convs = getConvs();
  if (last && localStorage.getItem('conv-' + last)) loadConv(last);
  else if (convs.length) loadConv(convs[0].id);
  else newConv();
  showPage(localStorage.getItem('cur-page') || 'chat');
  refreshHome();
  loadBalance();
  loadRecapCount();
  loadUpstream();
  checkMissed();
  loadBackupInfo();
  { const nb = $('btn-netease'); if (nb && !neteaseUrl()) nb.style.display = 'none'; }
  bindSplit('reader'); bindSplit('stage'); bindSplit('coread'); bindSplit('netease');
  startKeepalive();
}
async function loadUpstream() {
  try {
    const u = await jget('/api/upstream');
    $('up-name').value = u.name || '';
    $('up-base').value = u.base || '';
    $('up-key').placeholder = u.has_key ? `已存 …${u.key_tail}，留空不改` : 'sk-…';
    $('up-models').value = (u.models || []).join('\n');
    $('up-small').value = u.small_model || '';
    $('up-cache').checked = u.cache !== false;
    renderModels(u.models);
  } catch (e) { renderModels(null); }
}
function upstreamBody() {
  const models = $('up-models').value.split('\n').map(x => x.trim()).filter(Boolean);
  const b = {
    name: $('up-name').value.trim(), base: $('up-base').value.trim(),
    models, small_model: $('up-small').value.trim(), cache: $('up-cache').checked
  };
  const k = $('up-key').value.trim();
  if (k) b.key = k;
  return b;
}
async function loadBackupInfo() {
  const e = $('backup-info'); if (!e) return;
  try {
    const d = await jget('/api/backup/info');
    const mb = (d.size / 1048576).toFixed(1);
    e.innerHTML = `${d.files} 个文件　${mb} MB<br>存在 <b>${d.dir}</b>　`
      + (d.mounted
        ? '<span style="color:var(--accent)">挂载盘，重部署不会丢</span>'
        : '<span style="color:#e8506a">没挂盘！重部署会全没，去 Zeabur 挂个 Volume 到 /data</span>');
  } catch (err) { e.textContent = '—'; }
}
async function loadRecapCount() {
  const e = $('recap-n'); if (!e) return;
  try {
    const d = await jget('/api/recap?conv=' + encodeURIComponent(currentConvId || 'default'));
    e.textContent = (d.text || '').trim()
      ? `${d.text.length} 字 · 压了 ${d.covered || 0} 条` : '还没有';
  } catch (err) { e.textContent = '—'; }
}
async function loadBalance() {
  try {
    const d = await jget('/api/ledger?n=1');
    const up = d.upstream || {}, t = d.total || {}, today = d.today || {};
    if (up.total_credits != null || up.total_usage != null) {
      const left = (Number(up.total_credits) || 0) - (Number(up.total_usage) || 0);
      $('balance-val').textContent = money(left);
      $('balance-limit').textContent = '充了 ' + money(up.total_credits) + '　今天花了 ' + money(today.cost);
    } else {
      $('balance-val').textContent = money(t.cost);
      $('balance-limit').textContent = '一共 ' + (t.req || 0) + ' 次　今天 ' + money(today.cost) + '（自己算的）';
    }
  } catch (e) { $('balance-val').textContent = '—'; }
}

async function loadBackupInfo() {
  const e = $('backup-info'); if (!e) return;
  try {
    const d = await jget('/api/backup/info');
    const mb = (d.size / 1048576).toFixed(1);
    e.innerHTML = `${d.files} 个文件　${mb} MB<br>存在 <b>${d.dir}</b>　`
      + (d.mounted
        ? '<span style="color:var(--accent)">挂载盘，重部署不会丢</span>'
        : '<span style="color:#e8506a">没挂盘！重部署会全没，去 Zeabur 挂个 Volume 到 /data</span>');
  } catch (err) { e.textContent = '—'; }
}
async function loadRecapCount() {
  const e = $('recap-n'); if (!e) return;
  try {
    const d = await jget('/api/recap?conv=' + encodeURIComponent(currentConvId || 'default'));
    e.textContent = (d.text || '').trim()
      ? `${d.text.length} 字 · 压了 ${d.covered || 0} 条` : '还没有';
  } catch (err) { e.textContent = '—'; }
}
async function loadBalance() {
  try {
    const d = await jget('/api/key-info');
    const c = d.credits || {};
    const total = c.total_credits, used = c.total_usage;
    if (typeof total === 'number' && typeof used === 'number') {
      $('balance-val').textContent = `$${(total - used).toFixed(2)}`;
      $('balance-limit').textContent = `充了 $${total.toFixed(2)}，已用 $${used.toFixed(2)}`;
    } else {
      const k = (d.key || {}).data || {};
      const u = k.usage || 0, l = k.limit;
      $('balance-val').textContent = l ? `$${(l - u).toFixed(2)}` : `已用 $${u.toFixed(2)}`;
      $('balance-limit').textContent = l ? `额度 $${l.toFixed(2)}` : '不限额';
    }
  } catch (e) { $('balance-val').textContent = '—'; }
}

// ============ 事件 ============
document.addEventListener('DOMContentLoaded', () => {
  // 锁屏
  const th = localStorage.getItem('theme') || '';
  document.body.className = th ? 'theme-' + th : '';
  const bg0 = localStorage.getItem('chat-bg');
  if (bg0) document.body.style.backgroundImage = `url(${bg0})`;

  const unlock = async () => {
    let pwd = '0606';
    try { const c = await jget('/api/config'); pwd = c.password || '0606'; } catch (e) { }
    if ($('pwd-input').value === pwd) {
      sessionStorage.setItem('unlocked', '1');
      $('lock-screen').style.display = 'none'; boot();
    } else { $('pwd-err').style.display = 'block'; $('pwd-input').value = ''; }
  };
  $('pwd-go').onclick = unlock;
  $('pwd-input').onkeydown = e => { if (e.key === 'Enter') unlock(); };
  if (sessionStorage.getItem('unlocked')) { $('lock-screen').style.display = 'none'; boot(); }
  else $('pwd-input').focus();

  // 底栏
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showPage(t.dataset.page));
  document.querySelectorAll('.tcard').forEach(c => c.onclick = () => {
    const t = c.dataset.t;
    if (t === 'timeline') openTimeline();
    else if (t === 'quote-user') openQuotes('user');
    else if (t === 'quote-lin') openQuotes('lin');
    else if (t === 'wall') { $('tp-wall').classList.add('open'); renderMemories(); }
    else if (t === 'mumble') { $('tp-mumble').classList.add('open'); renderMumbles(); }
    else if (t === 'cal') { $('tp-cal').classList.add('open'); renderCalendar(); }
    else if (t === 'fault') { $('tp-fault').classList.add('open'); renderFaults(); }
    else if (t === 'days') { renderDaysModal(); $('days-modal').classList.add('open'); }
  });

  // 输入
  const inp = $('input');
  inp.addEventListener('input', () => autoResize(inp));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  $('send-btn').onclick = () => { if (isTyping && abortController) { abortController.abort(); endTurn(); } else sendMsg(); };
  document.querySelectorAll('.split-input').forEach(el => {
    el.addEventListener('input', () => autoResize(el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (el.dataset.ctx === 'stage' && el.value.trim()) markMoment(el.value.trim());
        sendMsg(el.dataset.ctx);
      }
    });
  });
  document.querySelectorAll('[data-splitsend]').forEach(b => b.onclick = () => {
    const ctx = b.dataset.splitsend;
    if (ctx === 'stage') {
      const t = document.querySelector('.split-input[data-ctx="stage"]').value.trim();
      if (t) markMoment(t);
    }
    sendMsg(ctx);
  });

  // 录音
  const mic = $('mic-btn');
  mic.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
  mic.addEventListener('touchend', e => { e.preventDefault(); stopRecording(); });
  mic.addEventListener('touchcancel', () => stopRecording());
  mic.addEventListener('mousedown', startRecording);
  mic.addEventListener('mouseup', stopRecording);
  mic.addEventListener('mouseleave', () => { if (recActive) stopRecording(); });

  // 顶栏
  $('btn-theme').onclick = e => { e.stopPropagation(); $('theme-menu').classList.toggle('open'); $('avatar-menu').classList.remove('open'); };
  $('avatar').onclick = e => { e.stopPropagation(); $('avatar-menu').classList.toggle('open'); $('theme-menu').classList.remove('open'); };
  $('btn-convs').onclick = () => { renderConvs(); $('conv-panel').classList.add('open'); };
  document.addEventListener('click', () => { $('theme-menu').classList.remove('open'); $('avatar-menu').classList.remove('open'); });
  document.querySelectorAll('.theme-option').forEach(o => o.onclick = () => {
    const t = o.dataset.theme;
    document.body.className = t ? 'theme-' + t : '';
    localStorage.setItem('theme', t); $('theme-menu').classList.remove('open');
  });
  let avatarTarget = 'ai';
  document.querySelectorAll('.avatar-menu-item').forEach(it => it.onclick = () => {
    const a = it.dataset.act;
    $('avatar-menu').classList.remove('open');
    if (a === 'av-ai') { avatarTarget = 'ai'; $('avatar-input').click(); }
    else if (a === 'av-user') { avatarTarget = 'user'; $('avatar-input').click(); }
    else if (a === 'status') $('status-modal').classList.add('open');
    else if (a === 'bg') $('bg-input').click();
    else if (a === 'bg-clear') {
      localStorage.removeItem('chat-bg'); document.body.style.backgroundImage = '';
      $('clear-bg-btn').style.display = 'none';
    }
  });
  $('avatar-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      const key = avatarTarget === 'user' ? 'chat-avatar-user' : 'chat-avatar-ai';
      try { localStorage.setItem(key, ev.target.result); } catch (err) { toast('图片太大了'); return; }
      if (avatarTarget === 'ai') {
        $('avatar').classList.add('has-img'); $('avatar').innerHTML = `<img src="${ev.target.result}">`;
        document.querySelectorAll('.msg-avatar-lin').forEach(a => { a.classList.add('has-img'); a.innerHTML = `<img src="${ev.target.result}">`; });
      }
      toast('换好了');
    };
    r.readAsDataURL(f); e.target.value = '';
  };
  $('bg-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try { localStorage.setItem('chat-bg', ev.target.result); } catch (err) { toast('图片太大了'); return; }
      document.body.style.backgroundImage = `url(${ev.target.result})`;
      $('clear-bg-btn').style.display = 'flex'; toast('换好了');
    };
    r.readAsDataURL(f); e.target.value = '';
  };
  document.querySelectorAll('#status-presets .status-preset').forEach(p => p.onclick = () => {
    if (p.dataset.clear) { localStorage.removeItem('user-status'); showUserStatus(''); }
    else { localStorage.setItem('user-status', p.textContent); showUserStatus(p.textContent); }
    $('status-modal').classList.remove('open');
  });
  $('status-ok').onclick = () => {
    const v = $('status-custom-input').value.trim();
    if (v) { localStorage.setItem('user-status', v); showUserStatus(v); }
    $('status-custom-input').value = ''; $('status-modal').classList.remove('open');
  };

  // 通用关闭
  document.querySelectorAll('[data-close-sheet]').forEach(b => b.onclick = () => $(b.dataset.closeSheet).classList.remove('open'));
  document.querySelectorAll('[data-close-full]').forEach(b => b.onclick = () => $(b.dataset.closeFull).classList.remove('open'));
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
    $(b.dataset.close).classList.remove('open');
    if (['cinema', 'musicroom', 'study'].includes(b.dataset.close)) roomCtx = null;
  });
  document.querySelectorAll('.sheet').forEach(s => s.onclick = e => { if (e.target === s) s.classList.remove('open'); });
  $('lightbox').onclick = () => $('lightbox').classList.remove('open');

  // 门 / 抽屉
  document.querySelectorAll('.room-card').forEach(d => d.onclick = () => {
    const r = d.dataset.room;
    // 房间点开就是那个页面本身：书房=共读，听音房=网易云播放器。
    // 底下的书架/碟片列表不再打开，✕ 直接退回主界面。
    // （地址没填时退回旧界面，免得点了没反应）
    if (r === 'study') { if (coreadUrl()) openCoread(); else openStudy(); }
    else if (r === 'cinema') openRoomMedia('video');
    else if (r === 'music') { if (neteaseUrl()) openNetease(); else openRoomMedia('music'); }
    else if (r === 'mailbox') openMailbox();
    else if (r === 'moments') openMoments();
    else if (r === 'desire') openDesire();
  });
  document.querySelectorAll('.drawer').forEach(d => d.onclick = () => openDrawer(d.dataset.drawer));

  // 书房
  $('btn-addbook').onclick = () => $('addbook-modal').classList.add('open');
  $('btn-coread').onclick = openCoread;
  $('btn-netease').onclick = openNetease;
  $('netease-close').onclick = closeNetease;
  $('netease-reload').onclick = () => { const u = neteaseUrl(); $('netease-frame').src = 'about:blank'; setTimeout(() => openNetease(), 60); };
  $('netease-open').onclick = () => window.open(neteaseUrl(), '_blank');
  $('netease-fallback').onclick = () => window.open(neteaseUrl(), '_blank');
  $('netease-switch').onclick = () => {
    const direct = localStorage.getItem('netease-direct') === '1';
    localStorage.setItem('netease-direct', direct ? '0' : '1');
    toast(direct ? '改回代理模式' : '改成直连');
    openNetease();
  };
  $('netease-url').value = localStorage.getItem('netease-url') || '';
  $('coread-close').onclick = closeCoread;
  $('coread-reload').onclick = () => { const u = coreadUrl(); $('coread-frame').src = 'about:blank'; setTimeout(() => $('coread-frame').src = u, 60); $('coread-fail').style.display = 'none'; };
  $('coread-open').onclick = () => window.open(coreadUrl(), '_blank');
  $('coread-fallback').onclick = () => window.open(coreadUrl(), '_blank');
  const sw = $('coread-switch');
  if (sw) sw.onclick = () => {
    const proxy = localStorage.getItem('coread-proxy') === '1';
    localStorage.setItem('coread-proxy', proxy ? '0' : '1');
    toast(proxy ? '改成直连' : '改回代理模式');
    $('coread-fail').style.display = 'none';
    openCoread();
  };
  $('coread-url').value = localStorage.getItem('coread-url') || '';
  $('btn-coread-save').onclick = () => {
    const v = $('coread-url').value.trim();
    if (v) localStorage.setItem('coread-url', v); else localStorage.removeItem('coread-url');
    const nv = $('netease-url').value.trim();
    if (nv) localStorage.setItem('netease-url', nv); else localStorage.removeItem('netease-url');
    const nb = $('btn-netease'); if (nb) nb.style.display = nv ? '' : 'none';
    toast('存好了');
  };
  $('btn-book-search').onclick = async () => {
    const q = $('book-search-input').value.trim(); if (!q) return;
    const box = $('book-results'); box.innerHTML = '<div class="settings-sub">找找看…</div>';
    const r = await jget('/api/books/search?q=' + encodeURIComponent(q));
    if (r.error || !r.length) { box.innerHTML = `<div class="settings-sub">${esc(r.error || '没找到')}</div>`; return; }
    box.innerHTML = '';
    r.forEach(it => {
      const d = document.createElement('div');
      d.className = 'conv-item';
      d.innerHTML = `<div class="conv-title">${esc(it.title)}</div><div class="conv-preview">${esc(it.author)}</div>`;
      d.onclick = async () => {
        d.querySelector('.conv-preview').textContent = '正在取…';
        const res = await jpost('/api/books/fetch', it);
        if (res.error) { d.querySelector('.conv-preview').textContent = res.error; return; }
        toast(`《${res.title}》放上书架了`);
        $('addbook-modal').classList.remove('open'); openStudy(); refreshHome();
      };
      box.appendChild(d);
    });
  };
  $('btn-book-url').onclick = async () => {
    const url = $('book-url-input').value.trim(); if (!url) return;
    toast('正在取…');
    const res = await jpost('/api/books/fetch', { source: 'url', ref: url });
    if (res.error) { toast(res.error); return; }
    toast(`《${res.title}》放上书架了`);
    $('book-url-input').value = ''; $('addbook-modal').classList.remove('open'); openStudy();
  };
  $('btn-book-file').onclick = () => $('book-file').click();
  $('book-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    toast('正在读…');
    const fd = new FormData(); fd.append('file', f);
    const res = await (await fetch('/api/books', { method: 'POST', body: fd })).json();
    if (res.error) toast(res.error);
    else { toast(`《${res.title}》放上书架了`); $('addbook-modal').classList.remove('open'); openStudy(); }
    e.target.value = '';
  };
  $('btn-book-paste').onclick = async () => {
    const title = $('book-title-input').value.trim(), text = $('book-text-input').value.trim();
    if (!text) { toast('还没有正文'); return; }
    const res = await jpost('/api/books', { title, text });
    if (res.error) { toast(res.error); return; }
    $('book-title-input').value = ''; $('book-text-input').value = '';
    $('addbook-modal').classList.remove('open'); toast('放上书架了'); openStudy();
  };
  $('reader-close').onclick = () => { $('reader').classList.remove('open'); roomCtx = null; refreshHome(); };
  $('prev-page').onclick = () => showPageAt(currentPage - 1);
  $('next-page').onclick = () => showPageAt(currentPage + 1);
  $('font-up').onclick = () => {
    const s = Math.min(24, (parseInt(localStorage.getItem('reader-font')) || 17) + 1);
    localStorage.setItem('reader-font', s); $('reader-text').style.fontSize = s + 'px';
  };
  $('font-down').onclick = () => {
    const s = Math.max(13, (parseInt(localStorage.getItem('reader-font')) || 17) - 1);
    localStorage.setItem('reader-font', s); $('reader-text').style.fontSize = s + 'px';
  };
  // 选中贴标签
  document.addEventListener('selectionchange', () => {
    const tip = $('sel-tip');
    if (!$('reader').classList.contains('open')) { tip.classList.remove('on'); return; }
    const sel = window.getSelection();
    const t = sel ? sel.toString().trim() : '';
    if (!t || t.length < 2 || !$('reader-text').contains(sel.anchorNode)) { tip.classList.remove('on'); return; }
    if (t.length > 120) { tip.classList.remove('on'); return; }
    try {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      tip.style.left = Math.max(10, Math.min(window.innerWidth - 110, r.left + r.width / 2 - 45)) + 'px';
      tip.style.top = Math.max(60, r.top - 42) + 'px';
      tip.classList.add('on'); selQuote = t.slice(0, 80);
    } catch (e) { }
  });
  $('sel-hl').onclick = e => { e.stopPropagation(); saveHighlight(); };
  $('sel-tag').onclick = e => {
    e.stopPropagation();
    replyTo = null; tagPos = currentPage;
    $('annot-new-quote').textContent = '「' + selQuote + '」';
    $('annot-input').value = ''; $('annot-new').classList.add('open');
    $('sel-tip').classList.remove('on'); $('annot-input').focus();
  };
  $('annot-cancel').onclick = () => { $('annot-new').classList.remove('open'); selQuote = ''; replyTo = null; };
  $('annot-save').onclick = saveTag;

  // 放映室 / 听音房
  $('btn-upload-video').onclick = () => $('video-file').click();
  $('btn-upload-music').onclick = () => $('music-file').click();
  const mediaUpload = (kind) => async e => {
    const f = e.target.files[0]; if (!f) return;
    const note = prompt('给它起个名字', f.name.replace(/\.[^.]+$/, '')) || '';
    const d = await chunkUpload(f, kind, note);
    if (d) openRoomMedia(kind === 'music' ? 'music' : 'video');
    refreshHome(); e.target.value = '';
  };
  $('video-file').onchange = mediaUpload('video');
  $('music-file').onchange = mediaUpload('music');
  $('stage-close').onclick = () => {
    $('stage').classList.remove('open'); roomCtx = null;
    $('stage-video').pause(); $('stage-audio').pause();
    refreshHome();
  };


  // 信箱
  $('btn-write-letter').onclick = () => $('write-letter-modal').classList.add('open');
  $('btn-send-letter').onclick = async () => {
    const t = $('letter-input').value.trim();
    if (!t) { toast('还没写字'); return; }
    const r = await callOB('letter_write', { author: 'user', content: t });
    if (r.error) { toast('寄不出去：' + r.error); return; }
    $('letter-input').value = ''; $('write-letter-modal').classList.remove('open');
    toast('寄出去了'); openMailbox();
  };
  $('btn-ask-letter').onclick = async () => {
    const el = $('mail-list');
    el.innerHTML = '<div class="room-empty" style="color:var(--ink-soft)">他在写…</div>';
    $('mail-sub').textContent = '等一下';
    try {
      const r = await jpost('/api/ask-letter', {});
      if (r.error) { toast(r.error); openMailbox(); return; }
      toast(r.wrote ? '他写好了' : '他这次没写');
      openMailbox();
    } catch (e) { toast('出错了'); openMailbox(); }
  };

  // 抽屉
  $('btn-drawer-add').onclick = () => {
    $('drawer-add-title').textContent = drawerWho === 'library' ? '放进资料库' : '放进我的抽屉';
    $('d-url').style.display = drawerWho === 'library' ? 'block' : 'none';
    $('d-title').value = ''; $('d-note').value = ''; $('d-body').value = ''; $('d-url').value = '';
    $('drawer-add-modal').classList.add('open');
  };
  $('btn-drawer-save').onclick = async () => {
    const title = $('d-title').value.trim();
    if (!title) { toast('起个名字'); return; }
    const body = { title, note: $('d-note').value.trim(), body: $('d-body').value };
    let r;
    if (drawerWho === 'library') {
      r = await jpost('/api/library', { title, about: $('d-note').value.trim(), text: $('d-body').value, url: $('d-url').value.trim() });
    } else {
      body.kind = /<[a-z][\s\S]*>/i.test(body.body) ? 'html' : 'text';
      r = await jpost('/api/drawer/user', body);
    }
    if (r.error) { toast(r.error); return; }
    $('drawer-add-modal').classList.remove('open'); toast('放进去了'); openDrawer(drawerWho);
  };
  $('play-close').onclick = () => { $('play-box').classList.remove('open'); $('play-frame').srcdoc = ''; };

  // 欲望室
  $('dim-range').addEventListener('input', e => {
    $('dim-val').textContent = (e.target.value / 100).toFixed(2);
  });
  $('btn-dim-save').onclick = async () => {
    const why = $('dim-why').value.trim();
    if (!why) { toast('要写一句为什么'); return; }
    const r = await jpost('/api/desire/adjust', {
      key: dimEditing, value: Number($('dim-range').value), why, who: 'user'
    });
    if (r.error) { toast(r.error); return; }
    $('dim-modal').classList.remove('open');
    desireData = null;
    await openDesire();
    if ($('dim-panel').classList.contains('open')) openDimPanel(dimEditing);
    toast('改了，记下来了');
  };
  $('btn-moves').onclick = openMoves;
  $('btn-vents').onclick = openVents;
  $('btn-dp-edit').onclick = () => {
    const x = (desireData.dims || []).find(v => v.key === dimViewing);
    if (x) openDim(x);
  };

  // 朋友圈
  $('btn-new-post').onclick = () => {
    postImgs = []; $('post-text').value = ''; drawPostThumbs();
    $('post-modal').classList.add('open');
  };
  $('btn-post-img').onclick = () => $('post-img-input').click();
  $('post-img-input').onchange = e => {
    [...e.target.files].slice(0, 9 - postImgs.length).forEach(f => {
      const r = new FileReader();
      r.onload = ev => { postImgs.push(ev.target.result); drawPostThumbs(); };
      r.readAsDataURL(f);
    });
    e.target.value = '';
  };
  $('btn-post-emoji').onclick = () => { emojiTarget = 'post'; renderEmoji(); $('emoji-panel').classList.add('open'); };
  $('btn-send-post').onclick = async () => {
    const text = $('post-text').value.trim();
    if (!text && !postImgs.length) { toast('什么都没写'); return; }
    const urls = [];
    for (const data of postImgs) {
      try {
        const blob = await (await fetch(data)).blob();
        const fd = new FormData(); fd.append('file', blob, 'p.jpg');
        const d = await (await fetch('/api/memories', { method: 'POST', body: fd })).json();
        if (d.url) urls.push(d.url);
      } catch (e) { }
    }
    const r = await jpost('/api/posts', { author: 'user', text, images: urls });
    if (r.error) { toast(r.error); return; }
    postImgs = []; $('post-text').value = '';
    $('post-modal').classList.remove('open');
    openMoments(); refreshHome();
  };
  $('cm-send').onclick = async () => {
    const t = $('cm-input').value.trim();
    if (!t || !cmTarget) return;
    await jpost(`/api/posts/${cmTarget}/comment`, { author: 'user', text: t });
    $('cm-input').value = ''; $('cm-bar').classList.remove('open'); cmTarget = null;
    openMoments();
  };
  $('cm-emoji').onclick = () => { emojiTarget = 'comment'; renderEmoji(); $('emoji-panel').classList.add('open'); };
  $('cm-input').addEventListener('input', () => autoResize($('cm-input')));

  // 收一句
  $('btn-add-quote').onclick = () => { $('q-text').value = ''; $('q-why').value = ''; $('quote-modal').classList.add('open'); };
  $('btn-save-quote').onclick = async () => {
    const text = $('q-text').value.trim();
    if (!text) { toast('还没写'); return; }
    const d = await jpost('/api/quotes/user', { text, why: $('q-why').value.trim() });
    if (d.error) { toast(d.error); return; }
    $('quote-modal').classList.remove('open'); openQuotes('user'); refreshTimeCounts();
  };

  // 时光墙
  $('btn-mem-upload').onclick = () => $('file-input').click();
  let pendingFile = null;
  $('file-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    pendingFile = f; $('note-input').value = ''; $('note-modal').classList.add('open');
    e.target.value = '';
  };
  const doUploadMem = async note => {
    $('note-modal').classList.remove('open');
    if (!pendingFile) return;
    toast('上传中…');
    const fd = new FormData(); fd.append('file', pendingFile);
    if (note) fd.append('note', note);
    try { await fetch('/api/memories', { method: 'POST', body: fd }); toast('放上去了'); renderMemories(); }
    catch (e) { toast('上传失败'); }
    pendingFile = null;
  };
  $('note-ok').onclick = () => doUploadMem($('note-input').value.trim());
  $('note-skip').onclick = () => doUploadMem('');

  // 日历
  $('cal-prev').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
  $('cal-next').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };
  $('cal-today').onclick = () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); renderCalendar(); };

  // 纪念日
  $('day-add').onclick = () => {
    const name = $('day-name-input').value.trim(), date = $('day-date-input').value;
    if (!name || !date) { toast('名字和日期都要填'); return; }
    const l = daysList(); l.push({ id: genId(), name, date, yearly: $('day-yearly').checked });
    daysSave(l); $('day-name-input').value = ''; $('day-date-input').value = '';
    renderDaysModal(); renderHomeDays(); renderCalendar();
  };

  // 人设
  $('btn-persona').onclick = openPersona;
  ['p-core', 'p-rhythm', 'p-lines', 'p-always', 'p-call', 'p-call2', 'p-maxtok', 'p-since', 'p-vid-calm', 'p-vid-dog', 'p-pwd']
    .forEach(id => $(id).addEventListener('input', personaMeter));
  $('btn-persona-save').onclick = savePersona;
  $('btn-persona-reset').onclick = () => { personaFill(personaOrig); personaMeter(); };
  $('btn-persona-history').onclick = async () => {
    const list = await jget('/api/persona/history');
    const el = $('persona-history-list');
    if (!list.length) el.innerHTML = '<div class="settings-sub">还没有旧版本</div>';
    else el.innerHTML = list.map(h => {
      const d = new Date(h.ts);
      return `<div class="conv-item" data-ts="${h.ts}"><div class="conv-title">${d.toLocaleString('zh-CN')}</div>
        <div class="conv-preview">${esc(h.preview)}…</div></div>`;
    }).join('');
    el.querySelectorAll('[data-ts]').forEach(d => d.onclick = async () => {
      if (!confirm('回到这一版？')) return;
      await jpost('/api/persona/rollback', { ts: parseInt(d.dataset.ts) });
      $('persona-history-sheet').classList.remove('open');
      openPersona(); toast('回来了');
    });
    $('persona-history-sheet').classList.add('open');
  };

  // 唤醒
  $('wake-on').onchange = async e => {
    await jpost('/api/persona', { wake_on: e.target.checked });
    toast(e.target.checked ? '他会自己醒了' : '关掉了');
  };
  const wakeCost = m => {
    const e = $('wake-cost'); if (!e) return;
    e.textContent = m <= 55
      ? '这个间隔在缓存有效期（1 小时）内，每次醒来便宜。'
      : '超过 1 小时，缓存会过期，每次醒来要全价重建一次 system。想省就选 45 分以内。';
  };
  document.querySelectorAll('[data-wake]').forEach(o => o.onclick = async () => {
    document.querySelectorAll('[data-wake]').forEach(x => x.classList.remove('active'));
    o.classList.add('active');
    const m = parseInt(o.dataset.wake);
    wakeCost(m);
    await jpost('/api/persona', { wake_interval: m });
  });
  $('wake-prompt').addEventListener('blur', () => jpost('/api/persona', { wake_prompt: $('wake-prompt').value }));
  $('btn-wake-log').onclick = renderWakeLog;
  $('btn-wake-now').onclick = async () => {
    $('wake-sub').textContent = '正在叫他…';
    const d = await jpost('/api/wake/now', {});
    $('wake-sub').textContent = d.error ? ('出错：' + d.error)
      : (d.said ? '他说了话，去看记录' : '他这次什么都没说');
    refreshHome();
  };
  $('btn-wake-clear').onclick = async () => {
    if (!confirm('清空记录？')) return;
    await fetch('/api/wake/log', { method: 'DELETE' }); renderWakeLog();
  };

  // 设置
  // 模型列表跟着上游配置走
  window.renderModels = (models) => {
    const el = $('model-list'); if (!el) return;
    const list = (models && models.length) ? models
      : ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-6', 'anthropic/claude-haiku-4-5'];
    if (!list.includes(currentModel)) { currentModel = list[0]; localStorage.setItem('model', currentModel); }
    el.innerHTML = '';
    list.forEach(mo => {
      const d = document.createElement('div');
      d.className = 'ctx-option' + (mo === currentModel ? ' active' : '');
      d.textContent = mo.split('/').pop();
      d.title = mo;
      d.onclick = () => {
        currentModel = mo; localStorage.setItem('model', mo);
        [...el.children].forEach(x => x.classList.remove('active'));
        d.classList.add('active');
        $('model-sub').textContent = '下一句用 ' + d.textContent;
      };
      el.appendChild(d);
    });
  };

  document.querySelectorAll('[data-val]').forEach(o => o.onclick = () => {
    document.querySelectorAll('[data-val]').forEach(x => x.classList.remove('active'));
    o.classList.add('active'); ctxWindow = parseInt(o.dataset.val);
    localStorage.setItem('ctx-window', ctxWindow);
    $('ctx-sub').textContent = ctxWindow ? `每次带最近 ${ctxWindow} 轮` : '带上全部（贵）';
  });
  document.querySelectorAll('[data-voice]').forEach(o => o.onclick = () => {
    document.querySelectorAll('[data-voice]').forEach(x => x.classList.remove('active'));
    o.classList.add('active'); localStorage.setItem('tts-voice', o.dataset.voice);
  });
  $('auto-voice-toggle').onchange = e => localStorage.setItem('auto-voice', e.target.checked ? '1' : '0');
  $('btn-clear-conv').onclick = () => { if (confirm('清空这段对话？')) newConv(); };
  $('btn-new-conv').onclick = newConv;
  $('btn-up-save').onclick = async () => {
    const r = await jpost('/api/upstream', upstreamBody());
    if (r.error) { toast(r.error); return; }
    $('up-key').value = '';
    await loadUpstream();
    $('up-result').textContent = '存好了，下一句就走新的';
    toast('存好了');
  };
  $('btn-up-test').onclick = async () => {
    const b = upstreamBody();
    $('up-result').textContent = '测试中…';
    const r = await jpost('/api/upstream/test', {
      base: b.base, key: $('up-key').value.trim(), model: (b.models[0] || '')
    });
    $('up-result').textContent = r.ok
      ? `通了：${r.reply || '(空回复)'}`
      : `不通${r.status ? ' ' + r.status : ''}：${(r.body || '').slice(0, 220)}`;
    $('up-result').style.color = r.ok ? 'var(--accent)' : '';
  };
  $('btn-recap').onclick = async () => {
    $('recap-panel').classList.add('open');
    $('recap-text').value = '读一下…';
    try {
      const d = await jget('/api/recap?conv=' + encodeURIComponent(currentConvId || 'default'));
      $('recap-text').value = d.text || '';
      $('recap-sub').textContent = d.covered ? `压了 ${d.covered} 条` : '还没压过';
    } catch (e) { $('recap-text').value = ''; }
  };
  $('btn-recap-save').onclick = async () => {
    const r = await jpost('/api/recap', { conv: currentConvId, text: $('recap-text').value }, 'PUT');
    if (r.error) { toast(r.error); return; }
    toast('存好了'); loadRecapCount();
  };
  $('btn-recap-clear').onclick = async () => {
    if (!confirm('清空前情提要？他就不记得更早的事了。')) return;
    await fetch('/api/recap?conv=' + encodeURIComponent(currentConvId || 'default'), { method: 'DELETE' });
    $('recap-text').value = ''; $('recap-sub').textContent = '还没压过';
    localStorage.removeItem('recap-done-' + currentConvId);
    loadRecapCount();
  };
  $('btn-call').onclick = async () => {
    const missed = await checkMissed();
    if (missed.length) { openCallLog(); return; }
    startCall('user');
  };
  $('cs-hang').onclick = () => endCall('user');
  $('cp-hang').onclick = e => { e.stopPropagation(); endCall('user'); };
  $('cs-mini').onclick = () => {
    CALL.mini = true;
    $('callscreen').classList.remove('open');
    $('call-pill').classList.add('on');
  };
  $('call-pill').onclick = () => {
    CALL.mini = false;
    $('call-pill').classList.remove('on');
    $('callscreen').classList.add('open');
  };
  $('cs-mute').onclick = () => {
    CALL.muted = !CALL.muted;
    $('cs-mute').classList.toggle('off', CALL.muted);
    $('cs-mute').querySelector('span').textContent = CALL.muted ? '▶' : '⏸';
    $('cs-mute').querySelector('i').textContent = CALL.muted ? '继续听' : '暂停听';
    csState(CALL.muted ? '暂停了' : '通话中');
    if (CALL.muted && CALL.rec) recStop(false);
  };
  // 插话开关
  const syncCutin = () => {
    const on = localStorage.getItem('call-cutin') !== '0';
    const b = $('cs-cutin'); if (!b) return;
    b.classList.toggle('off', !on);
    b.querySelector('i').textContent = on ? '能插话' : '轮流说';
  };
  syncCutin();
  $('cs-cutin').onclick = () => {
    const on = localStorage.getItem('call-cutin') !== '0';
    localStorage.setItem('call-cutin', on ? '0' : '1');
    syncCutin();
    toast(on ? '改成轮流说，他说完你再说' : '他说话时你出声就能打断他');
  };

  // 备份
  $('btn-backup').onclick = () => window.open('/api/backup', '_blank');
  $('btn-backup-all').onclick = () => window.open('/api/backup?media=1', '_blank');
  $('btn-restore').onclick = () => {
    if (!confirm('恢复会覆盖同名文件。继续？')) return;
    $('restore-input').click();
  };
  $('restore-input').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    toast('恢复中…');
    const fd = new FormData(); fd.append('file', f);
    try {
      const d = await (await fetch('/api/backup', { method: 'POST', body: fd })).json();
      if (d.error) { toast(d.error); return; }
      toast(`恢复了 ${d.files} 个文件，刷新一下`);
      loadBackupInfo();
  { const nb = $('btn-netease'); if (nb && !neteaseUrl()) nb.style.display = 'none'; }
    } catch (err) { toast('恢复失败'); }
    e.target.value = '';
  };

  $('btn-call-now').onclick = () => { $('calllog-panel').classList.remove('open'); startCall('user'); };
  $('btn-usage').onclick = openUsage;
  $('btn-usage-topup').onclick = () => window.open('https://openrouter.ai/settings/credits', '_blank');
  $('btn-search').onclick = () => {
    $('search-panel').classList.add('open');
    $('search-input').value = '';
    $('search-result').innerHTML = '<div class="room-empty" style="color:var(--text-muted)">搜你们说过的话</div>';
    setTimeout(() => $('search-input').focus(), 120);
  };
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 220);
  });
  $('btn-topup').onclick = () => window.open('https://openrouter.ai/settings/credits', '_blank');
  $('btn-mcp').onclick = () => { renderMcp(); $('mcp-panel').classList.add('open'); };
  $('mcp-add-btn').onclick = async () => {
    const url = $('mcp-url-input').value.trim(); if (!url) { toast('填个地址'); return; }
    const btn = $('mcp-add-btn'); btn.textContent = '连接中…'; btn.disabled = true;
    try {
      const d = await jpost('/api/mcp-connect', { url });
      if (d.error) { toast(d.error); return; }
      const tl = d.tools || [];
      mcpServers.push({
        id: genId(), name: $('mcp-name-input').value.trim() || new URL(url).hostname,
        url, enabled: true, sid: d.session_id || null, tools: tl,
        off: tl.length > 6 ? tl.slice(6).map(t => t.name) : []
      });
      saveMcp(); renderMcp();
      $('mcp-url-input').value = ''; $('mcp-name-input').value = '';
      toast(`连上了，${(d.tools || []).length} 个工具`);
    } catch (e) { toast('连接失败'); }
    finally { btn.textContent = '连接并添加'; btn.disabled = false; }
  };

  // 表情
  $('btn-emoji').onclick = () => { emojiTarget = 'chat'; renderEmoji(); $('emoji-panel').classList.add('open'); };
  $('btn-emoji-upload').onclick = () => $('emoji-input').click();
  let pendingEmoji = null;
  $('emoji-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => { pendingEmoji = ev.target.result; $('emoji-name-input').value = ''; $('emoji-name-modal').classList.add('open'); };
    r.readAsDataURL(f); e.target.value = '';
  };
  $('emoji-name-cancel').onclick = () => { pendingEmoji = null; $('emoji-name-modal').classList.remove('open'); };
  $('emoji-name-ok').onclick = () => {
    const name = $('emoji-name-input').value.trim();
    if (!name || !pendingEmoji) { toast('起个名字'); return; }
    const l = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
    l.push({ name, data: pendingEmoji });
    try { localStorage.setItem('custom-emoji', JSON.stringify(l)); }
    catch (err) { toast('存不下了，删几个'); return; }
    pendingEmoji = null; $('emoji-name-modal').classList.remove('open'); renderEmoji(); toast('加好了');
  };

  // 聊天配图
  $('btn-img').onclick = () => $('chat-img-input').click();
  $('chat-img-input').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      pendingChatImg = { data: ev.target.result };
      $('img-preview-thumb').src = ev.target.result;
      $('img-preview-bar').classList.add('show');
    };
    r.readAsDataURL(f); e.target.value = '';
  };
  $('img-preview-remove').onclick = () => { pendingChatImg = null; $('img-preview-bar').classList.remove('show'); };
});

function renderDaysModal() {
  const l = daysList(), el = $('days-list');
  if (!l.length) { el.innerHTML = '<div class="settings-sub">还没有记下什么日子</div>'; return; }
  el.innerHTML = '';
  l.forEach(d => {
    const n = d.yearly ? daysUntilNext(d.date) : daysSince(d.date);
    const box = document.createElement('div'); box.className = 'day-card';
    box.innerHTML = `<div><div class="day-num">${n < 0 ? -n : n}</div><div class="day-unit">${d.yearly ? (n === 0 ? '就是今天' : '天后') : '天'}</div></div>
      <div style="flex:1"><div class="day-name">${esc(d.name)}</div><div class="day-date">${d.date}</div></div>
      <div class="day-del">✕</div>`;
    box.querySelector('.day-del').onclick = () => {
      if (!confirm('删掉？')) return;
      daysSave(daysList().filter(x => x.id !== d.id));
      renderDaysModal(); renderHomeDays(); renderCalendar();
    };
    el.appendChild(box);
  });
}
function renderEmoji() {
  const l = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
  const g = $('emoji-grid');
  if (!l.length) { g.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:30px;font-size:13px;">还没有表情<br>点右上角上传</div>'; return; }
  g.innerHTML = '';
  l.forEach((item, i) => {
    const d = document.createElement('div'); d.className = 'emoji-item';
    d.innerHTML = `<img src="${item.data}" alt="${esc(item.name)}">`;
    d.onclick = () => {
      let inp;
      if (emojiTarget === 'post') inp = $('post-text');
      else if (emojiTarget === 'comment') inp = $('cm-input');
      else inp = roomCtx ? document.querySelector(`.split-input[data-ctx="${roomCtx}"]`) : $('input');
      inp.value += `[${item.name}]`; autoResize(inp);
      $('emoji-panel').classList.remove('open'); inp.focus();
      emojiTarget = 'chat';
    };
    let timer = null;
    d.addEventListener('touchstart', () => {
      timer = setTimeout(() => {
        if (confirm(`删掉「${item.name}」？`)) {
          const nl = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
          nl.splice(i, 1); localStorage.setItem('custom-emoji', JSON.stringify(nl)); renderEmoji();
        }
      }, 600);
    }, { passive: true });
    d.addEventListener('touchend', () => clearTimeout(timer));
    d.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
    g.appendChild(d);
  });
}
function renderMcp() {
  const el = $('mcp-list');
  $('mcp-count').textContent = `${mcpServers.length} 个 · 这一轮实发 ${buildTools().length} 个工具`;
  if (!mcpServers.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:50px 20px;">还没有添加服务器</div>'; return; }
  el.innerHTML = '';
  mcpServers.forEach(s => {
    const off = new Set(s.off || []);
    const tools = s.tools || [];
    const on = tools.filter(t => !off.has(t.name)).length;
    const d = document.createElement('div');
    d.className = 'mcp-server' + (s.enabled ? '' : ' off');
    d.innerHTML = `<div class="mcp-name">${esc(s.name)}</div><div class="mcp-url">${esc(s.url)}</div>
      <div class="mcp-tools"><span class="mt-count">${on} / ${tools.length} 个工具在发</span><span class="mcp-more">展开 ▾</span></div>
      <div class="mcp-tool-list"></div>
      <div class="mcp-actions"><div class="mcp-toggle${s.enabled ? ' on' : ''}"></div><div class="mcp-del">✕</div></div>`;
    d.querySelector('.mcp-toggle').onclick = () => { s.enabled = !s.enabled; saveMcp(); renderMcp(); };
    d.querySelector('.mcp-del').onclick = () => {
      if (!confirm(`删掉「${s.name}」？`)) return;
      mcpServers = mcpServers.filter(x => x.id !== s.id); saveMcp(); renderMcp();
    };
    const box = d.querySelector('.mcp-tool-list');
    const more = d.querySelector('.mcp-more');
    more.onclick = () => {
      const open = box.classList.toggle('open');
      more.textContent = open ? '收起 ▴' : '展开 ▾';
      if (open && !box.dataset.done) { drawToolRows(box, s, d); box.dataset.done = '1'; }
    };
    el.appendChild(d);
  });
}
function drawToolRows(box, s, card) {
  const refresh = () => {
    const off = new Set(s.off || []);
    const on = (s.tools || []).filter(x => !off.has(x.name)).length;
    card.querySelector('.mt-count').textContent = `${on} / ${(s.tools || []).length} 个工具在发`;
    $('mcp-count').textContent = `${mcpServers.length} 个 · 这一轮实发 ${buildTools().length} 个工具`;
  };
  box.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'mt-bar';
  bar.innerHTML = '<span data-all="1">全开</span><span data-none="1">全关</span>';
  bar.querySelector('[data-all]').onclick = () => { s.off = []; saveMcp(); drawToolRows(box, s, card); refresh(); };
  bar.querySelector('[data-none]').onclick = () => { s.off = (s.tools || []).map(t => t.name); saveMcp(); drawToolRows(box, s, card); refresh(); };
  box.appendChild(bar);
  (s.tools || []).forEach(t => {
    const isOff = (s.off || []).includes(t.name);
    const row = document.createElement('div');
    row.className = 'mt-row' + (isOff ? ' off' : '');
    row.innerHTML = `<div class="mt-n">${esc(t.name)}<div class="mt-d">${esc((t.description || '').slice(0, 56))}</div></div>
      <div class="mt-sw${isOff ? '' : ' on'}"></div>`;
    row.querySelector('.mt-sw').onclick = () => {
      const cur = new Set(s.off || []);
      cur.has(t.name) ? cur.delete(t.name) : cur.add(t.name);
      s.off = [...cur]; saveMcp();
      const nowOff = cur.has(t.name);
      row.classList.toggle('off', nowOff);
      row.querySelector('.mt-sw').classList.toggle('on', !nowOff);
      refresh();
    };
    box.appendChild(row);
  });
}
