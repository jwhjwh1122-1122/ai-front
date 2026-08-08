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
    put('st-desire', '还没接上');
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
      const w = startAiBubble(idx); updateBubble(w, t, true, t, currentAiRow); currentBubble = null; currentAiRow = null;
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
    v.onloadedmetadata = loadMoments;
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
    const e = it.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    h = h.replace(new RegExp(`\\[${e}\\]`, 'g'), `<img src="${it.data}" alt="${it.name}">`);
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
const PF = ['core', 'rhythm', 'lines'];
function personaRead() {
  return {
    core: $('p-core').value, rhythm: $('p-rhythm').value, lines: $('p-lines').value,
    call_user: $('p-call').value.trim(), call_serious: $('p-call2').value.trim(),
    max_tokens: parseInt($('p-maxtok').value) || 500,
    together_since: $('p-since').value,
    voice_id_calm: $('p-vid-calm').value.trim(), voice_id_dog: $('p-vid-dog').value.trim(),
    password: $('p-pwd').value.trim() || '0606',
  };
}
function personaFill(p) {
  $('p-core').value = p.core || ''; $('p-rhythm').value = p.rhythm || ''; $('p-lines').value = p.lines || '';
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
  document.querySelectorAll('[data-model]').forEach(o => o.classList.toggle('active', o.dataset.model === currentModel));
  document.querySelectorAll('[data-val]').forEach(o => o.classList.toggle('active', parseInt(o.dataset.val) === ctxWindow));
  $('ctx-sub').textContent = ctxWindow ? `每次带最近 ${ctxWindow} 轮` : '带上全部（贵）';
  const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
  document.querySelectorAll('[data-voice]').forEach(o => o.classList.toggle('active', o.dataset.voice === voice));
  $('auto-voice-toggle').checked = localStorage.getItem('auto-voice') === '1';
  $('wake-on').checked = !!CFG.wake_on;
  const wi = CFG.wake_interval || 120;
  document.querySelectorAll('[data-wake]').forEach(o => o.classList.toggle('active', parseInt(o.dataset.wake) === wi));
  try { const p = await jget('/api/persona'); $('wake-prompt').value = p.wake_prompt || ''; CFG.call_user = p.call_user; showUserStatus(localStorage.getItem('user-status')); } catch (e) { }
  const last = localStorage.getItem('current-conv-id'), convs = getConvs();
  if (last && localStorage.getItem('conv-' + last)) loadConv(last);
  else if (convs.length) loadConv(convs[0].id);
  else newConv();
  showPage(localStorage.getItem('cur-page') || 'chat');
  refreshHome();
  loadBalance();
  bindSplit('reader'); bindSplit('stage');
  startKeepalive();
}
async function loadBalance() {
  try {
    const d = await jget('/api/key-info');
    if (d.data) {
      const u = d.data.usage || 0, l = d.data.limit;
      $('balance-val').textContent = l ? `$${(l - u).toFixed(2)}` : `已用 $${u.toFixed(2)}`;
      $('balance-limit').textContent = l ? `额度 $${l.toFixed(2)}，已用 $${u.toFixed(2)}` : '不限额';
    } else $('balance-val').textContent = '—';
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
    if (r === 'study') openStudy();
    else if (r === 'cinema') openRoomMedia('video');
    else if (r === 'music') openRoomMedia('music');
    else if (r === 'mailbox') openMailbox();
    else if (r === 'moments') openMoments();
    else if (r === 'desire') $('desireroom').classList.add('open');
  });
  document.querySelectorAll('.drawer').forEach(d => d.onclick = () => openDrawer(d.dataset.drawer));

  // 书房
  $('btn-addbook').onclick = () => $('addbook-modal').classList.add('open');
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
  $('btn-ask-letter').onclick = () => {
    $('mailbox').classList.remove('open');
    sendComposed('给我写一封信吧，写完寄到信箱里。', []);
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
  ['p-core', 'p-rhythm', 'p-lines', 'p-call', 'p-call2', 'p-maxtok', 'p-since', 'p-vid-calm', 'p-vid-dog', 'p-pwd']
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
  document.querySelectorAll('[data-wake]').forEach(o => o.onclick = async () => {
    document.querySelectorAll('[data-wake]').forEach(x => x.classList.remove('active'));
    o.classList.add('active');
    await jpost('/api/persona', { wake_interval: parseInt(o.dataset.wake) });
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
  document.querySelectorAll('[data-model]').forEach(o => o.onclick = () => {
    document.querySelectorAll('[data-model]').forEach(x => x.classList.remove('active'));
    o.classList.add('active'); currentModel = o.dataset.model;
    localStorage.setItem('model', currentModel);
    $('model-sub').textContent = '下一句用 ' + o.textContent;
  });
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
  $('btn-mcp').onclick = () => { renderMcp(); $('mcp-panel').classList.add('open'); };
  $('mcp-add-btn').onclick = async () => {
    const url = $('mcp-url-input').value.trim(); if (!url) { toast('填个地址'); return; }
    const btn = $('mcp-add-btn'); btn.textContent = '连接中…'; btn.disabled = true;
    try {
      const d = await jpost('/api/mcp-connect', { url });
      if (d.error) { toast(d.error); return; }
      mcpServers.push({
        id: genId(), name: $('mcp-name-input').value.trim() || new URL(url).hostname,
        url, enabled: true, sid: d.session_id || null, tools: d.tools || []
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
  $('mcp-count').textContent = `${mcpServers.length} 个 · ${buildTools().length} 个工具`;
  if (!mcpServers.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:50px 20px;">还没有添加服务器</div>'; return; }
  el.innerHTML = '';
  mcpServers.forEach(s => {
    const d = document.createElement('div');
    d.className = 'mcp-server' + (s.enabled ? '' : ' off');
    d.innerHTML = `<div class="mcp-name">${esc(s.name)}</div><div class="mcp-url">${esc(s.url)}</div>
      <div class="mcp-tools">${(s.tools || []).length} 个工具：${(s.tools || []).map(t => t.name).join(', ') || '无'}</div>
      <div class="mcp-actions"><div class="mcp-toggle${s.enabled ? ' on' : ''}"></div><div class="mcp-del">✕</div></div>`;
    d.querySelector('.mcp-toggle').onclick = () => { s.enabled = !s.enabled; saveMcp(); renderMcp(); };
    d.querySelector('.mcp-del').onclick = () => {
      if (!confirm(`删掉「${s.name}」？`)) return;
      mcpServers = mcpServers.filter(x => x.id !== s.id); saveMcp(); renderMcp();
    };
    el.appendChild(d);
  });
}
