/* 凛 · 前端主逻辑 */
const $ = id => document.getElementById(id);
const MCP_PROXY = '/api/mcp';
const CONTEXT_LIMIT = 200000;

let CFG = {};
let messages = [], isTyping = false, totalTokens = 0;
let lastCacheRead = 0, lastCacheWrite = 0;
let pendingChatImg = null, editingMsgIdx = null;
let currentAudio = null, currentAudioBtn = null;
let currentModel = 'anthropic/claude-sonnet-4-6';
let ctxWindow = 15, sendFrom = 0;
let currentConvId = null;

const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function toast(m) { const t = $('toast'); t.textContent = m; t.className = 'toast show'; setTimeout(() => t.className = 'toast', 1900); }
function fmtTime(s) { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(0) + 'MB' : (b / 1024).toFixed(0) + 'KB'; }

// ============ 工具定义 ============
const LOCAL_TOOLS = [
  { name: 'get_memories', description: '时光墙照片列表。', input_schema: { type: 'object', properties: {} } },
  { name: 'view_memory', description: '看时光墙的某张照片。', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
  { name: 'room_books', description: '书房里有哪些书，各自读到第几页（你的进度和她的进度分开记）。', input_schema: { type: 'object', properties: {} } },
  { name: 'room_read_page', description: '翻开某本书的某一页，看正文。book_id 必填，page 不填就接着你自己上次读到的地方。', input_schema: { type: 'object', required: ['book_id'], properties: { book_id: { type: 'string' }, page: { type: 'number' } } } },
  { name: 'room_search_book', description: '在某本书里找一句话在第几页。', input_schema: { type: 'object', required: ['book_id', 'q'], properties: { book_id: { type: 'string' }, q: { type: 'string' } } } },
  { name: 'room_media', description: '放映室和听音房里有什么。kind=video 或 music。', input_schema: { type: 'object', properties: { kind: { type: 'string' } } } },
  { name: 'room_music_shape', description: '某首歌的骨架：哪一段密、哪一段空、顶点在哪。听不见旋律，但能看出这首歌的形状。', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
  { name: 'room_read_tags', description: '读某本书/某个片子/某首歌上贴的标签，她的和你自己的都在。type=book|video|music，id 是书 id 或文件名，pos 不填就读全部。', input_schema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' } } } },
  { name: 'room_write_tag', description: '在某一处贴你自己的标签，或者回她的标签（填 reply_to）。pos：书填页码，片子和歌填秒数。', input_schema: { type: 'object', required: ['type', 'id', 'text'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' }, text: { type: 'string' }, reply_to: { type: 'string' } } } },
  { name: 'room_set_progress', description: '记下你自己读到第几页了。', input_schema: { type: 'object', required: ['book_id', 'page'], properties: { book_id: { type: 'string' }, page: { type: 'number' } } } },
];

// ============ MCP 服务器 ============
const DEFAULT_MCP = [{
  id: 'ombre', name: 'Ombre Brain', url: 'https://jwhjwh.zeabur.app/mcp', enabled: true, sid: null,
  tools: [
    { name: 'breath', description: '检索/浮现记忆。无 query = 自动浮现。', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' }, max_tokens: { type: 'number' } } } },
    { name: 'hold', description: '存一条记忆。把你为什么在意这件事也写进去。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, tags: { type: 'string' }, importance: { type: 'number' }, feel: { type: 'boolean' } } } },
    { name: 'grow', description: '整理一段长文本存进记忆。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
    { name: 'dream', description: '读最近有变动的记忆。', input_schema: { type: 'object', properties: {} } },
    { name: 'pulse', description: '记忆系统状态。', input_schema: { type: 'object', properties: { include_archive: { type: 'boolean' } } } },
    { name: 'letter_write', description: '写一封信。author："user"=她写的，"ai"=你写的。', input_schema: { type: 'object', required: ['author', 'content'], properties: { author: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } } } },
    { name: 'letter_read', description: '读信箱。', input_schema: { type: 'object', properties: { query: { type: 'string' }, author: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'plan', description: '登记一个约定。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, status: { type: 'string' } } } },
    { name: 'trace', description: '改记忆的元数据或内容。', input_schema: { type: 'object', required: ['bucket_id'], properties: { bucket_id: { type: 'string' }, resolved: { type: 'number' }, pinned: { type: 'number' }, content: { type: 'string' } } } },
  ]
}];
let mcpServers = [];
function loadMcp() {
  try { const r = localStorage.getItem('mcp-servers'); mcpServers = r ? JSON.parse(r) : JSON.parse(JSON.stringify(DEFAULT_MCP)); }
  catch (e) { mcpServers = JSON.parse(JSON.stringify(DEFAULT_MCP)); }
  if (!Array.isArray(mcpServers) || !mcpServers.length) mcpServers = JSON.parse(JSON.stringify(DEFAULT_MCP));
}
function saveMcp() { localStorage.setItem('mcp-servers', JSON.stringify(mcpServers)); updateMcpSub(); }
const enabledServers = () => mcpServers.filter(s => s.enabled && Array.isArray(s.tools) && s.tools.length);
function buildTools() {
  const seen = new Set(), out = [];
  for (const t of LOCAL_TOOLS) { seen.add(t.name); out.push(t); }
  for (const s of enabledServers()) for (const t of s.tools) {
    if (!t || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object', properties: {} } });
  }
  return out;
}
function findServerForTool(n) { for (const s of enabledServers()) if (s.tools.some(t => t && t.name === n)) return s; return null; }
function updateMcpSub() {
  const el = $('mcp-sub'); if (!el) return;
  el.textContent = `${mcpServers.length} 个服务器（${enabledServers().length} 个已启用）· 共 ${buildTools().length} 个工具`;
}

// ============ 启动 ============
async function boot() {
  const th = localStorage.getItem('theme') || ''; setTheme(th);
  loadMcp();
  try { CFG = await (await fetch('/api/config')).json(); } catch (e) { CFG = {}; }
  if (CFG.name) { $('lin-name').textContent = CFG.name; $('avatar-text').textContent = CFG.name[0]; }
  ctxWindow = localStorage.getItem('ctx-window') !== null ? parseInt(localStorage.getItem('ctx-window')) : 15;
  currentModel = localStorage.getItem('current-model') || currentModel;
  initBg(); initAvatar(); initStatus(); renderEmojiGrid(); initMic(); bindAll();
  updateModelUI(); updateCtxUI(); updateVoiceUI(); updateMcpSub();
  $('auto-voice-toggle').checked = localStorage.getItem('auto-voice') === '1';
  initConversations();
  $('status-text').textContent = '今天 ' + nowStr();
  initLock();
  refreshHome();
  startKeepalive();
}

function initLock() {
  if (sessionStorage.getItem('unlocked')) { $('lock-screen').style.display = 'none'; return; }
  const go = () => {
    if ($('pwd-input').value === (CFG.password || '0606')) {
      $('lock-screen').style.display = 'none'; sessionStorage.setItem('unlocked', '1');
    } else {
      $('pwd-err').style.display = 'block'; $('pwd-input').value = '';
      setTimeout(() => $('pwd-err').style.display = 'none', 2000);
    }
  };
  $('pwd-go').onclick = go;
  $('pwd-input').onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => $('pwd-input').focus(), 100);
}

function setTheme(t) {
  document.body.className = t ? 'theme-' + t : '';
  localStorage.setItem('theme', t); $('theme-menu').classList.remove('open');
}

// ============ 页签 ============
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.page === name));
  if (name === 'home') refreshHome();
  if (name === 'time') loadMemories();
  if (name === 'settings') { fetchBalance(); }
}

// ============ 家 ============
async function refreshHome() {
  try {
    const s = await (await fetch('/api/rooms/status')).json();
    $('st-study').textContent = s.book ? `${s.book.title} · 第 ${s.book.page}/${s.book.total} 页` : '空着';
    $('st-cinema').textContent = s.video ? `${s.video.name} 等 ${s.video.count} 卷` : '空着';
    $('st-music').textContent = s.music ? `${s.music.name} 等 ${s.music.count} 首` : '空着';
    const u = s.unseen || {};
    $('dot-study').classList.toggle('on', !!u.book);
    $('dot-cinema').classList.toggle('on', !!u.video);
    $('dot-music').classList.toggle('on', !!u.music);
    const any = !!(u.book || u.video || u.music);
    $('dot-home').classList.toggle('on', any);
    $('st-mail').textContent = '看看有没有信';
  } catch (e) { }
  renderHomeDays();
  $('home-sub').textContent = togetherLine();
}
function togetherLine() {
  const start = new Date((CFG.together_since || '2026-06-06') + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0); start.setHours(0, 0, 0, 0);
  return `在一起第 ${Math.floor((today - start) / 86400000) + 1} 天`;
}
function renderHomeDays() {
  const el = $('home-days');
  const list = getDays().map(d => ({ ...d, left: daysUntil(d.date, d.yearly) }))
    .filter(d => d.left !== null).sort((a, b) => a.left - b.left).slice(0, 4);
  const start = new Date((CFG.together_since || '2026-06-06') + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0); start.setHours(0, 0, 0, 0);
  const n = Math.floor((today - start) / 86400000) + 1;
  let html = `<div class="day-row"><div class="day-n">${n}<small>天</small></div><div class="day-t"><b>在一起</b><i>${CFG.together_since || ''}</i></div></div>`;
  list.forEach(d => {
    const num = d.left === 0 ? '今' : d.left;
    const unit = d.left === 0 ? '' : '<small>天后</small>';
    html += `<div class="day-row"><div class="day-n">${num}${unit}</div><div class="day-t"><b>${esc(d.name)}</b><i>${esc(d.date)}${d.yearly ? ' · 每年' : ''}</i></div></div>`;
  });
  el.innerHTML = html;
}

// ============ 人设编辑器 ============
let personaOrig = null;
async function openPersona() {
  $('persona-panel').classList.add('open');
  try {
    const p = await (await fetch('/api/persona')).json();
    personaOrig = p;
    $('p-core').value = p.core || ''; $('p-rhythm').value = p.rhythm || '';
    $('p-lines').value = p.lines || ''; $('p-call').value = p.call_user || '';
    $('p-call2').value = p.call_serious || ''; $('p-maxtok').value = p.max_tokens || 500;
    $('p-vid-calm').value = p.voice_id_calm || ''; $('p-vid-dog').value = p.voice_id_dog || '';
    $('p-pwd').value = p.password || '';
    personaMeter(); $('persona-dirty').classList.remove('on');
  } catch (e) { toast('读不到人设'); }
}
function personaFields() {
  return {
    core: $('p-core').value, rhythm: $('p-rhythm').value, lines: $('p-lines').value,
    call_user: $('p-call').value.trim(), call_serious: $('p-call2').value.trim(),
    max_tokens: parseInt($('p-maxtok').value) || 500,
    voice_id_calm: $('p-vid-calm').value.trim(), voice_id_dog: $('p-vid-dog').value.trim(),
    password: $('p-pwd').value.trim() || '0606',
  };
}
function personaMeter() {
  const f = personaFields();
  const n = (f.core + f.rhythm + f.lines).length;
  $('p-count').textContent = `底色 + 节奏 + 落点 共 ${n} 字`;
  $('p-tok').textContent = `每轮约 ${Math.round(n * 0.9)} tokens`;
  $('persona-meter').classList.toggle('warn', n > 2000);
  if (n > 2000) $('p-tok').textContent += ' · 有点长了，写精比写多有用';
  if (personaOrig) {
    let dirty = false;
    for (const k in f) if (String(f[k]) !== String(personaOrig[k] ?? '')) dirty = true;
    $('persona-dirty').classList.toggle('on', dirty);
  }
}
async function savePersona() {
  const f = personaFields();
  if (!f.core.trim()) { toast('底色不能是空的'); return; }
  try {
    const r = await fetch('/api/persona', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
    const d = await r.json();
    if (d.error) { toast(d.error); return; }
    personaOrig = d.persona; CFG.password = d.persona.password;
    $('persona-dirty').classList.remove('on');
    toast('存好了，下一句就是新的他');
  } catch (e) { toast('存不上：' + e.message); }
}
async function openPersonaHistory() {
  const el = $('persona-history-list');
  el.innerHTML = '<div class="settings-sub">读取中…</div>';
  $('persona-history-sheet').classList.add('open');
  try {
    const list = await (await fetch('/api/persona/history')).json();
    if (!list.length) { el.innerHTML = '<div class="settings-sub">还没有历史版本</div>'; return; }
    el.innerHTML = '';
    list.forEach(h => {
      const d = document.createElement('div'); d.className = 'conv-item';
      const dt = new Date(h.ts);
      d.innerHTML = `<div class="conv-title">${dt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div><div class="conv-preview">${esc(h.preview)}…</div>`;
      d.onclick = async () => {
        if (!confirm('回到这一版？现在这版会存进历史。')) return;
        await fetch('/api/persona/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ts: h.ts }) });
        $('persona-history-sheet').classList.remove('open');
        openPersona(); toast('回去了');
      };
      el.appendChild(d);
    });
  } catch (e) { el.innerHTML = '<div class="settings-sub">读不到</div>'; }
}

// ============ 标签 ============
let tagCtx = null;   // {type,id,pos,quote,title}
function openTagWriter(ctx) {
  tagCtx = ctx;
  $('annot-new-quote').textContent = ctx.quote ? '「' + ctx.quote + '」' :
    (ctx.type === 'book' ? `第 ${ctx.pos + 1} 页` : fmtTime(ctx.pos));
  $('annot-input').value = '';
  $('annot-new').classList.add('open');
  setTimeout(() => $('annot-input').focus(), 100);
}
async function saveTag() {
  const text = $('annot-input').value.trim();
  if (!text || !tagCtx) { toast('还没写字'); return; }
  try {
    await fetch('/api/annotations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor_type: tagCtx.type, anchor_id: tagCtx.id, pos: tagCtx.pos,
        quote: tagCtx.quote || '', text, author: 'user', reply_to: tagCtx.reply_to || null
      })
    });
    $('annot-new').classList.remove('open');
    toast('贴上去了');
    if (tagCtx.type === 'book') loadPageTags();
    else loadStageTags(true);
  } catch (e) { toast('贴不上：' + e.message); }
}
async function fetchTags(type, id, pos) {
  let u = `/api/annotations?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
  if (pos !== undefined && pos !== null) u += `&pos=${pos}`;
  try { return await (await fetch(u)).json(); } catch (e) { return []; }
}
function renderTags(el, items, ctx) {
  if (!items.length) {
    el.innerHTML = ctx.type === 'book'
      ? '<div class="annot-who" style="opacity:.6">这一页还没有人写字</div>' : '';
    return;
  }
  const byId = {}; items.forEach(a => byId[a.id] = a);
  const roots = items.filter(a => !a.reply_to);
  const kids = a => items.filter(x => x.reply_to === a.id);
  const one = (a, isReply) => {
    const mine = a.author === 'user';
    const who = mine ? '我写的' : (CFG.name || '凛') + ' 写的';
    const posLabel = ctx.type === 'book' ? '' : ` · ${fmtTime(a.pos)}`;
    return `<div class="annot ${mine ? 'mine' : ''} ${isReply ? 'annot-reply' : ''}">
      <div class="annot-who">${who}${posLabel}</div>
      ${a.quote ? `<div class="annot-quote">「${esc(a.quote)}」</div>` : ''}
      <div class="annot-text">${esc(a.text)}</div>
      <div class="annot-foot"><span data-reply="${a.id}">回一句</span><span data-del="${a.id}">删掉</span></div>
    </div>`;
  };
  el.innerHTML = roots.map(a => one(a, false) + kids(a).map(k => one(k, true)).join('')).join('');
  el.querySelectorAll('[data-reply]').forEach(s => s.onclick = () => {
    const a = byId[s.dataset.reply];
    openTagWriter({ type: ctx.type, id: ctx.id, pos: a.pos, quote: '', reply_to: a.id });
  });
  el.querySelectorAll('[data-del]').forEach(s => s.onclick = async () => {
    if (!confirm('删掉这条？')) return;
    await fetch('/api/annotations/' + s.dataset.del, { method: 'DELETE' });
    if (ctx.type === 'book') loadPageTags(); else loadStageTags(true);
  });
  const unseen = items.filter(a => a.author === 'lin' && !a.seen).map(a => a.id);
  if (unseen.length) {
    fetch('/api/annotations/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: unseen }) })
      .then(() => refreshHome());
  }
}

// ============ 书房 ============
let books = [], currentBook = null, currentPage = 0, readerFont = 17;
const SPINE_COLORS = ['#7d6a8f', '#5f7285', '#8a6f5c', '#5f7f6e', '#8a6472', '#4f5a7d', '#7a7359', '#6d5a72'];
function spineStyle(b) {
  let h = 0; const s = (b.title || '') + b.id;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  return { color: SPINE_COLORS[h % SPINE_COLORS.length], width: 30 + (h >>> 3) % 12, height: 124 + (h >>> 7) % 34 };
}
async function openStudy() { $('study').classList.add('open'); await loadBooks(); }
async function loadBooks() {
  const el = $('shelves'); el.innerHTML = '<div class="room-empty">正在开灯…</div>';
  try { books = await (await fetch('/api/books')).json(); }
  catch (e) { el.innerHTML = '<div class="room-empty">书架没打开</div>'; return; }
  let tagMap = {};
  try {
    const all = await (await fetch('/api/annotations?type=book&unseen=1')).json();
    all.forEach(a => tagMap[a.anchor_id] = true);
  } catch (e) { }
  el.innerHTML = '';
  if (!books.length) { el.innerHTML = '<div class="room-empty">书架是空的<br>添一本，我们一起读</div>'; }
  else {
    for (let s = 0; s < books.length; s += 8) {
      const shelf = document.createElement('div'); shelf.className = 'shelf';
      if (s === 0) shelf.innerHTML = '<div class="lamp"></div>';
      const holder = document.createElement('div'); holder.className = 'shelf-books';
      books.slice(s, s + 8).forEach(b => {
        const st = spineStyle(b);
        const d = document.createElement('div');
        d.className = 'spine' + (b.progress > 0 && b.progress < b.pages - 1 ? ' reading' : '');
        d.style.cssText = `background:linear-gradient(90deg,${st.color} 0%,${st.color} 62%,rgba(0,0,0,.22) 100%);width:${st.width}px;height:${st.height}px`;
        d.innerHTML = `<div class="spine-rule" style="top:7px"></div><div class="spine-rule" style="bottom:9px"></div>
          <div class="spine-mark ${tagMap[b.id] ? 'on' : ''}"></div><div class="spine-title">${esc(b.title || '无名')}</div>`;
        d.onclick = () => openBook(b.id);
        let t = null;
        d.addEventListener('touchstart', () => { t = setTimeout(() => { t = null; delBook(b); }, 750); });
        d.addEventListener('touchend', () => { if (t) { clearTimeout(t); t = null; } });
        d.addEventListener('touchmove', () => { if (t) { clearTimeout(t); t = null; } });
        holder.appendChild(d);
      });
      const board = document.createElement('div'); board.className = 'shelf-board';
      shelf.appendChild(holder); shelf.appendChild(board); el.appendChild(shelf);
    }
  }
  const reading = books.filter(b => b.progress > 0 && b.progress < b.pages - 1).length;
  $('study-sub').textContent = books.length ? `${books.length} 本 · 在读 ${reading} 本` : '空着';
}
async function delBook(b) {
  if (!confirm(`把《${b.title}》从书架拿走？`)) return;
  await fetch('/api/books/' + b.id, { method: 'DELETE' }); await loadBooks(); refreshHome();
}
async function openBook(id) {
  const b = books.find(x => x.id === id); if (!b) return;
  currentBook = b; currentPage = b.progress || 0;
  $('reader-book').textContent = b.title;
  $('reader').classList.add('open');
  readerFont = parseInt(localStorage.getItem('reader-font')) || 17;
  $('reader-text').style.fontSize = readerFont + 'px';
  await showPageAt(currentPage);
}
async function showPageAt(i) {
  if (!currentBook) return;
  const t = $('reader-text'); t.textContent = '……';
  try {
    const d = await (await fetch(`/api/books/${currentBook.id}/page?i=${i}`)).json();
    if (d.error) { t.textContent = '这一页翻不开'; return; }
    currentPage = d.index; t.textContent = d.text;
    $('reader-body').scrollTop = 0;
    $('reader-page').textContent = `${d.index + 1} / ${d.total}`;
    $('reader-prog-fill').style.width = ((d.index + 1) / d.total * 100) + '%';
    $('prev-page').disabled = d.index <= 0; $('next-page').disabled = d.index >= d.total - 1;
    currentBook.progress = d.index; currentBook.pages = d.total;
    const lp = currentBook.lin_progress || 0;
    $('lin-behind').textContent = lp < d.index
      ? `${CFG.name || '凛'}还在第 ${lp + 1} 页` : (lp > d.index ? `${CFG.name || '凛'}已经读到第 ${lp + 1} 页了` : `你们在同一页`);
    fetch(`/api/books/${currentBook.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: d.index, who: 'user' }) }).catch(() => { });
    loadPageTags();
  } catch (e) { t.textContent = '翻页出错'; }
}
async function loadPageTags() {
  if (!currentBook) return;
  const items = await fetchTags('book', currentBook.id, currentPage);
  renderTags($('reader-annots'), items, { type: 'book', id: currentBook.id });
}

// 选中正文 → 冒出「贴标签」
function initSelection() {
  const body = $('reader-body');
  document.addEventListener('selectionchange', () => {
    if (!$('reader').classList.contains('open')) return;
    const sel = window.getSelection();
    const tip = $('sel-tip');
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { tip.classList.remove('on'); return; }
    if (!body.contains(sel.anchorNode)) { tip.classList.remove('on'); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    tip.style.left = Math.max(12, Math.min(window.innerWidth - 100, r.left + r.width / 2 - 44)) + 'px';
    tip.style.top = Math.max(60, r.top - 42) + 'px';
    tip.classList.add('on');
  });
  $('sel-tip').onclick = () => {
    const q = (window.getSelection().toString() || '').trim().slice(0, 100);
    $('sel-tip').classList.remove('on');
    window.getSelection().removeAllRanges();
    openTagWriter({ type: 'book', id: currentBook.id, pos: currentPage, quote: q });
  };
}

// ============ 放映室 / 听音房 ============
let mediaList = [], curMedia = null, curKind = 'video';
async function openRoomMedia(kind) {
  curKind = kind;
  $(kind === 'video' ? 'cinema' : 'musicroom').classList.add('open');
  await loadMedia(kind);
}
async function loadMedia(kind) {
  const listEl = $(kind === 'video' ? 'cinema-list' : 'music-list');
  listEl.innerHTML = '<div class="room-empty">正在找…</div>';
  try { mediaList = await (await fetch(kind === 'video' ? '/api/videos' : '/api/music')).json(); }
  catch (e) { listEl.innerHTML = '<div class="room-empty">拿不到</div>'; return; }
  let unseen = {};
  try {
    const all = await (await fetch(`/api/annotations?type=${kind}&unseen=1`)).json();
    all.forEach(a => unseen[a.anchor_id] = true);
  } catch (e) { }
  $(kind === 'video' ? 'cinema-sub' : 'music-sub').textContent =
    mediaList.length ? `${mediaList.length} ${kind === 'video' ? '卷' : '首'}` : '空着';
  if (!mediaList.length) {
    listEl.innerHTML = kind === 'video'
      ? '<div class="room-empty">还没有片子<br>上一卷，我们一起看</div>'
      : '<div class="room-empty">还没有歌<br>放一张碟</div>';
    return;
  }
  listEl.innerHTML = '';
  mediaList.forEach(m => {
    const d = document.createElement('div');
    d.className = kind === 'video' ? 'reel' : 'track';
    const dt = new Date(parseInt(m.ts) || Date.now());
    const when = dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    if (kind === 'video') {
      d.innerHTML = `<div class="reel-play">▶</div><div class="reel-info">
        <div class="reel-name">${esc(m.note || m.filename)}</div>
        <div class="reel-meta">${when} · ${fmtSize(m.size)}</div></div>
        ${unseen[m.filename] ? '<div class="reel-dot"></div>' : ''}`;
    } else {
      d.innerHTML = `<div class="track-disc"></div><div class="reel-info">
        <div class="track-name">${esc(m.note || m.filename)}</div>
        <div class="track-meta">${when} · ${fmtSize(m.size)}</div></div>
        ${unseen[m.filename] ? '<div class="reel-dot"></div>' : ''}`;
    }
    d.onclick = () => playMedia(m, kind);
    let t = null;
    d.addEventListener('touchstart', () => { t = setTimeout(() => { t = null; delMedia(m, kind); }, 750); });
    d.addEventListener('touchend', () => { if (t) { clearTimeout(t); t = null; } });
    d.addEventListener('touchmove', () => { if (t) { clearTimeout(t); t = null; } });
    listEl.appendChild(d);
  });
}
async function delMedia(m, kind) {
  if (!confirm(`删掉「${m.note || m.filename}」？`)) return;
  await fetch(`/api/${kind === 'video' ? 'videos' : 'music'}/${m.filename}`, { method: 'DELETE' });
  await loadMedia(kind); refreshHome();
}
function playMedia(m, kind) {
  curMedia = m; curKind = kind;
  $('stage-name').textContent = m.note || m.filename;
  const st = $('stage'), v = $('stage-video'), aw = $('audio-wrap'), a = $('stage-audio');
  st.classList.toggle('audio', kind === 'music');
  if (kind === 'video') {
    v.style.display = ''; aw.style.display = 'none';
    v.src = m.url; v.currentTime = 0;
    $('stage-note').textContent = '暂停在想说的地方，点上面那个';
  } else {
    v.style.display = 'none'; aw.style.display = '';
    a.src = m.url; a.currentTime = 0;
    $('shape-bars').innerHTML = '';
    $('stage-note').textContent = '放一遍，他就能看见这首歌的形状';
    a.onplay = () => $('disc-big').classList.add('spin');
    a.onpause = () => $('disc-big').classList.remove('spin');
    analyzeMusic(m);
  }
  st.classList.add('open');
}
function stageTime() {
  return curKind === 'video' ? ($('stage-video').currentTime || 0) : ($('stage-audio').currentTime || 0);
}
function closeStage() {
  try { $('stage-video').pause(); $('stage-audio').pause(); } catch (e) { }
  $('disc-big').classList.remove('spin');
  $('stage').classList.remove('open');
}
async function loadStageTags(silent) {
  if (!curMedia) return;
  const items = await fetchTags(curKind, curMedia.filename);
  $('tagview-title').textContent = curMedia.note || curMedia.filename;
  $('tagview-sub').textContent = items.length ? `${items.length} 条` : '还没有标签';
  renderTags($('tagview-list'), items, { type: curKind, id: curMedia.filename });
  if (!silent) $('tagview').classList.add('open');
}

// 歌的骨架：浏览器里用 Web Audio 算，服务器不用装任何东西
async function analyzeMusic(m) {
  try {
    const cached = await fetch(`/api/music/${m.filename}/shape`);
    if (cached.ok) { drawShape(await cached.json()); return; }
  } catch (e) { }
  try {
    const buf = await (await fetch(m.url)).arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctx();
    const audio = await ac.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const N = 48, seg = Math.floor(ch.length / N), bins = [];
    for (let i = 0; i < N; i++) {
      let sum = 0, peak = 0;
      for (let j = i * seg; j < (i + 1) * seg; j += 64) {
        const v = Math.abs(ch[j] || 0); sum += v; if (v > peak) peak = v;
      }
      bins.push({ rms: sum / (seg / 64), peak });
    }
    const max = Math.max(...bins.map(b => b.rms)) || 1;
    const shape = {
      duration: audio.duration,
      segments: bins.map((b, i) => ({
        t: Math.round(audio.duration * i / N),
        level: Math.round(b.rms / max * 100)
      }))
    };
    const lv = shape.segments.map(s => s.level);
    const peakIdx = lv.indexOf(Math.max(...lv)), lowIdx = lv.indexOf(Math.min(...lv));
    shape.peak_at = shape.segments[peakIdx].t;
    shape.empty_at = shape.segments[lowIdx].t;
    ac.close();
    drawShape(shape);
    fetch(`/api/music/${m.filename}/shape`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shape) }).catch(() => { });
  } catch (e) { }
}
function drawShape(shape) {
  const el = $('shape-bars');
  const mx = Math.max(...shape.segments.map(s => s.level)) || 1;
  el.innerHTML = shape.segments.map(s =>
    `<i style="height:${Math.max(3, s.level / mx * 44)}px" class="${s.level > mx * 0.8 ? 'hot' : ''}"></i>`).join('');
}

// ============ 信箱 ============
async function callOB(name, args) {
  const server = findServerForTool(name) || mcpServers.find(s => s.enabled && /jwhjwh|ombre/i.test(s.url));
  if (!server) return { error: '没有连着记忆库' };
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (server.sid) h['Mcp-Session-Id'] = server.sid;
  try {
    const r = await fetch(MCP_PROXY, {
      method: 'POST', headers: h,
      body: JSON.stringify({ _server: server.url, jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args || {} }, id: Date.now() })
    });
    return await parseMcp(r, server);
  } catch (e) { return { error: e.message }; }
}
async function loadLetters() {
  const el = $('mail-list'); el.innerHTML = '<div class="room-empty">正在开箱…</div>';
  const res = await callOB('letter_read', {});
  if (res && res.error) { el.innerHTML = '<div class="room-empty">开不了箱<br>' + esc(res.error) + '</div>'; return; }
  const text = (res && res.content && res.content[0] && res.content[0].text) || '';
  if (!text.trim()) { el.innerHTML = '<div class="room-empty">信箱是空的<br>写第一封吧</div>'; return; }
  const blocks = text.split(/\n\s*\n(?=[-—【\[]|第|\d{4})/).filter(b => b.trim());
  const shown = blocks.length ? blocks : [text];
  el.innerHTML = '';
  shown.forEach(b => {
    const d = document.createElement('div'); d.className = 'letter';
    const mine = /user|宝宝|慧/.test(b.slice(0, 40));
    d.innerHTML = `<div class="stamp">✉</div><div class="letter-from">${mine ? '宝宝 写' : (CFG.name || '凛') + ' 写'}</div><div class="letter-body">${esc(b.trim())}</div>`;
    el.appendChild(d);
  });
  $('mail-sub').textContent = shown.length + ' 封';
}

// ============ 时光墙 ============
let pendingFile = null;
async function loadMemories() {
  const grid = $('memory-grid');
  grid.innerHTML = '<div class="memory-empty" style="padding-top:60px">加载中…</div>';
  try {
    const items = await (await fetch('/api/memories')).json();
    $('memory-count').textContent = items.length ? `${items.length} 张` : '';
    if (!items.length) { grid.innerHTML = '<div class="memory-empty">还没有记录<br>上传第一张吧</div>'; return; }
    grid.innerHTML = '';
    items.forEach(item => {
      const d = document.createElement('div'); d.className = 'memory-item';
      let dateStr = ''; const ts = parseInt(item.ts);
      if (!isNaN(ts)) { const dt = new Date(ts); dateStr = dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); }
      d.innerHTML = `<img src="${item.url}" loading="lazy" alt=""><div class="memory-delete">✕</div>
        <div class="memory-item-info"><div class="memory-item-date">${dateStr}</div>${item.note ? `<div class="memory-item-note">${esc(item.note)}</div>` : ''}</div>`;
      d.querySelector('.memory-delete').onclick = async e => {
        e.stopPropagation();
        await fetch('/api/memories/' + item.filename, { method: 'DELETE' }); loadMemories();
      };
      d.querySelector('img').onclick = () => { if (!d.classList.contains('deleting')) openLightbox(item.url, item.note, dateStr); };
      let pt = null;
      d.addEventListener('touchstart', () => { pt = setTimeout(() => { d.classList.toggle('deleting'); pt = null; }, 600); });
      d.addEventListener('touchend', () => { if (pt) { clearTimeout(pt); pt = null; } });
      d.addEventListener('touchmove', () => { if (pt) { clearTimeout(pt); pt = null; } });
      grid.appendChild(d);
    });
  } catch (e) { grid.innerHTML = '<div class="memory-empty">加载失败</div>'; }
}
function openLightbox(url, note, dateStr) {
  $('lightbox-img').src = url; $('lightbox-note').textContent = note || '';
  $('lightbox-date').textContent = dateStr || ''; $('lightbox').classList.add('open');
}
async function doUpload(file, note) {
  const form = new FormData(); form.append('file', file); if (note) form.append('note', note);
  try { await fetch('/api/memories', { method: 'POST', body: form }); await loadMemories(); }
  catch (e) { toast('上传失败'); }
}

// ============ 纪念日 / 心情 / 状态 ============
const getDays = () => { try { return JSON.parse(localStorage.getItem('anniv-days') || '[]'); } catch (e) { return []; } };
const saveDays = l => localStorage.setItem('anniv-days', JSON.stringify(l));
function daysUntil(dateStr, yearly) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return null;
  if (yearly) {
    let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
    if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
    return Math.round((next - today) / 86400000);
  }
  return Math.round((d - today) / 86400000);
}
function renderDays() {
  const el = $('days-list');
  const list = getDays().map(d => ({ ...d, left: daysUntil(d.date, d.yearly) }))
    .filter(d => d.left !== null).sort((a, b) => a.left - b.left);
  if (!list.length) { el.innerHTML = '<div class="settings-sub">还没有记过日子</div>'; return; }
  el.innerHTML = '';
  list.forEach(d => {
    const c = document.createElement('div'); c.className = 'day-card';
    const label = d.left === 0 ? '就是今天' : (d.left < 0 ? '已经过了' : '天后');
    const num = d.left === 0 ? '今' : Math.abs(d.left);
    c.innerHTML = `<div><div class="day-num">${num}</div><div class="day-unit">${label}</div></div>
      <div style="flex:1;min-width:0;"><div class="day-name">${esc(d.name)}</div><div class="day-date">${esc(d.date)}${d.yearly ? ' · 每年' : ''}</div></div>
      <div class="day-del">✕</div>`;
    c.querySelector('.day-del').onclick = () => { saveDays(getDays().filter(x => x.id !== d.id)); renderDays(); refreshHome(); };
    el.appendChild(c);
  });
}
const MOODS = ['很好', '平静', '有点累', '闷', '难过', '烦', '想他', '兴奋'];
function openMood() {
  const g = $('mood-grid'); g.innerHTML = '';
  const cur = localStorage.getItem('mood-today') || '';
  MOODS.forEach(m => {
    const d = document.createElement('div');
    d.className = 'mood-chip' + (m === cur ? ' on' : ''); d.textContent = m;
    d.onclick = () => { g.querySelectorAll('.mood-chip').forEach(x => x.classList.remove('on')); d.classList.add('on'); };
    g.appendChild(d);
  });
  $('mood-note').value = ''; $('mood-modal').classList.add('open');
}
function moodHint() {
  if (localStorage.getItem('mood-date') !== new Date().toDateString()) return '';
  const m = localStorage.getItem('mood-today');
  return m ? ' · 心情' + m : '';
}
function nearestDayHint() {
  const list = getDays().map(d => ({ ...d, left: daysUntil(d.date, d.yearly) }))
    .filter(d => d.left !== null && d.left >= 0 && d.left <= 7).sort((a, b) => a.left - b.left);
  if (!list.length) return '';
  const d = list[0];
  return d.left === 0 ? ' · 今天是' + d.name : ' · 还有' + d.left + '天' + d.name;
}
function initStatus() { const s = localStorage.getItem('user-status'); if (s) applyStatus(s, false); }
function applyStatus(status, notify) {
  const el = $('user-status');
  if (status) { el.textContent = status; el.style.display = ''; } else el.style.display = 'none';
  if (notify) {
    const prev = localStorage.getItem('user-status') || '';
    if (prev !== status) {
      const m = document.createElement('div'); m.className = 'sys-msg';
      m.textContent = status ? `— 宝宝现在：${status} —` : '— 宝宝清除了状态 —';
      $('messages').appendChild(m); scrollBottom();
    }
  }
  localStorage.setItem('user-status', status || '');
}

// ============ 背景 / 头像 / 表情 ============
function initBg() { const bg = localStorage.getItem('chat-bg'); if (bg) { document.body.style.backgroundImage = `url(${bg})`; $('clear-bg-btn').style.display = ''; } }
function initAvatar() { const av = localStorage.getItem('chat-avatar-ai'); if (av) applyAiAvatar(av); }
function applyAiAvatar(data) {
  const el = $('avatar'); $('avatar-text').style.display = 'none'; el.classList.add('has-img');
  let img = el.querySelector('img'); if (!img) { img = document.createElement('img'); el.appendChild(img); }
  img.src = data;
  document.querySelectorAll('.msg-avatar-lin').forEach(e => { e.classList.add('has-img'); e.innerHTML = `<img src="${data}">`; });
}
function compressImage(dataUrl, maxSize) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxSize || h > maxSize) { if (w > h) { h = h * maxSize / w; w = maxSize; } else { w = w * maxSize / h; h = maxSize; } }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      res(c.toDataURL('image/png', 0.8));
    };
    img.src = dataUrl;
  });
}
function renderEmojiGrid() {
  const grid = $('emoji-grid'); grid.innerHTML = '';
  const customs = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
  if (!customs.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);font-size:13px;padding:30px 0;">还没有表情包</div>'; return; }
  customs.forEach((item, idx) => {
    const d = document.createElement('div'); d.className = 'emoji-item';
    d.innerHTML = `<img src="${item.data}" alt="${item.name || ''}">`;
    d.onclick = () => {
      pendingChatImg = { data: item.data, type: 'image/png' };
      $('img-preview-thumb').src = item.data; $('img-preview-bar').classList.add('show');
      $('emoji-panel').classList.remove('open');
    };
    let t = null;
    d.addEventListener('touchstart', () => {
      t = setTimeout(() => {
        if (confirm(`删除表情「${item.name || ''}」？`)) {
          const c = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
          c.splice(idx, 1); localStorage.setItem('custom-emoji', JSON.stringify(c)); renderEmojiGrid();
        }
        t = null;
      }, 700);
    });
    d.addEventListener('touchend', () => { if (t) { clearTimeout(t); t = null; } });
    grid.appendChild(d);
  });
}
function renderMd(text) {
  let h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/^#{1,3} (.+)$/gm, '<b>$1</b>').replace(/^[-•] (.+)$/gm, '• $1');
  return h;
}
function renderBubble(text) {
  const customs = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
  let html = renderMd(text);
  customs.forEach(item => {
    if (!item.name) return;
    const e = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`\\[${e}\\]`, 'g'), `<img src="${item.data}" style="width:120px;display:block;margin:4px 0;" alt="${item.name}">`);
  });
  return html;
}

// ============ 对话管理 ============
const getConvs = () => { try { return JSON.parse(localStorage.getItem('conversations') || '[]'); } catch (e) { return []; } };
const saveConvs = l => localStorage.setItem('conversations', JSON.stringify(l));
function saveConv() {
  if (!currentConvId || !messages.length) return;
  try { localStorage.setItem('conv-' + currentConvId, JSON.stringify(messages)); }
  catch (e) { toast('存储空间快满了'); return; }
  const list = getConvs();
  const idx = list.findIndex(c => c.id === currentConvId);
  const fu = messages.find(m => m.role === 'user' && !m._internal);
  const title = typeof fu?.content === 'string' ? fu.content.slice(0, 20)
    : (Array.isArray(fu?.content) ? (fu.content.find(c => c.type === 'text')?.text || '对话').slice(0, 20) : '对话');
  const lm = messages[messages.length - 1];
  const preview = typeof lm?.content === 'string' ? lm.content.slice(0, 30)
    : (Array.isArray(lm?.content) ? lm.content.filter(c => c && c.type === 'text').map(c => c.text).join('').slice(0, 30) : '');
  const entry = { id: currentConvId, title, preview, updatedAt: Date.now() };
  if (idx >= 0) list[idx] = entry; else list.unshift(entry);
  saveConvs(list);
}
function loadConv(id) {
  const saved = localStorage.getItem('conv-' + id); if (!saved) return;
  messages = JSON.parse(saved); currentConvId = id; sendFrom = 0;
  $('messages').innerHTML = '<div class="sys-msg">— 今天 —</div>';
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; currentAiRow = null;
  messages.forEach((msg, i) => {
    if (msg.role === 'tool' || msg._internal) return;
    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(c => c && c.type === 'tool_result')) return;
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text || '' : '');
      const img = Array.isArray(msg.content) ? msg.content.find(c => c.type === 'image_url') : null;
      addUserBubble(text, img?.image_url?.url || null, i, msg._audio ? { url: msg._audio, dur: msg._dur } : null);
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.filter(c => c && c.type === 'text').map(c => c.text).join('') : '');
      if (!text && !msg._thinking) return;
      const wrap = startAiBubble(i);
      if (msg._thinking) savedThinking(wrap, msg._thinking);
      if (msg._audio) wrap.appendChild(voiceBubble(msg._audio, msg._dur, ''));
      if (text) updateBubble(wrap, text, true, text, currentAiRow);
      currentBubble = null; currentAiRow = null;
    }
  });
  scrollBottom(); localStorage.setItem('current-conv-id', id);
}
function newConv() {
  if (messages.length) saveConv();
  currentConvId = genId(); messages = []; totalTokens = 0; editingMsgIdx = null; sendFrom = 0;
  currentBubble = null; currentThinkWrap = null; currentAiRow = null;
  $('messages').innerHTML = '<div class="sys-msg">— 今天 —</div>';
  localStorage.setItem('current-conv-id', currentConvId);
  $('conv-panel').classList.remove('open'); showPage('chat');
}
function renderConvs() {
  const list = getConvs(), el = $('conv-list');
  $('conv-count').textContent = list.length ? list.length + ' 段' : '';
  if (!list.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:60px 20px;">还没有对话记录</div>'; return; }
  el.innerHTML = '';
  list.sort((a, b) => b.updatedAt - a.updatedAt).forEach(c => {
    const d = document.createElement('div');
    d.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
    const dt = new Date(c.updatedAt);
    d.innerHTML = `<div class="conv-title">${esc(c.title || '新对话')}</div>${c.preview ? `<div class="conv-preview">${esc(c.preview)}</div>` : ''}
      <div class="conv-time">${dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
      <div class="conv-delete">✕</div>`;
    d.querySelector('.conv-delete').onclick = e => {
      e.stopPropagation();
      if (!confirm('删除这段对话？')) return;
      localStorage.removeItem('conv-' + c.id);
      const nl = getConvs().filter(x => x.id !== c.id); saveConvs(nl);
      if (currentConvId === c.id) { if (nl.length) loadConv(nl[0].id); else newConv(); }
      renderConvs();
    };
    d.onclick = () => { if (messages.length) saveConv(); loadConv(c.id); renderConvs(); $('conv-panel').classList.remove('open'); showPage('chat'); };
    el.appendChild(d);
  });
}
function initConversations() {
  const savedId = localStorage.getItem('current-conv-id'), list = getConvs();
  if (savedId && list.find(c => c.id === savedId)) { currentConvId = savedId; loadConv(savedId); }
  else if (list.length) { currentConvId = list[0].id; loadConv(list[0].id); }
  else { currentConvId = genId(); localStorage.setItem('current-conv-id', currentConvId); }
}

// ============ 气泡 ============
let currentBubble = null, currentThinkWrap = null, currentThinkContent = null, currentAiRow = null, turnThinking = '';
const scrollBottom = () => { const m = $('messages'); m.scrollTop = m.scrollHeight; };
function addUserBubble(text, imgData, idx, audio) {
  const row = document.createElement('div'); row.className = 'msg-row user';
  if (idx !== undefined) { row.dataset.msgIdx = idx; }
  const uav = localStorage.getItem('chat-avatar-user');
  const av = uav ? `<div class="msg-avatar has-img"><img src="${uav}"></div>` : '';
  let c = '';
  if (imgData) c += `<div class="bubble-img"><img src="${imgData}"></div>`;
  if (text && !(audio && audio.url)) c += `<div class="bubble user">${esc(text)}</div>`;
  row.innerHTML = `${av}<div class="bubble-wrap">${c}<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
    <span class="msg-action-btn" data-edit="1">改</span><span class="msg-action-btn" data-copy="1">复制</span>
    <span class="msg-time">${nowStr()}</span></div></div>`;
  if (audio && audio.url) {
    const w = row.querySelector('.bubble-wrap');
    w.insertBefore(voiceBubble(audio.url, audio.dur, (text || '').replace(/^\[[^\]]*\]\n/, '')), w.firstChild);
  }
  row.querySelector('[data-edit]').onclick = () => editMsg(row);
  row.querySelector('[data-copy]').onclick = () => {
    const b = row.querySelector('.bubble.user');
    copyText(b ? b.textContent.replace(/^\[[^\]]*\]\n/, '') : '');
  };
  const im = row.querySelector('.bubble-img img'); if (im) im.onclick = () => openLightbox(im.src, '', '');
  $('messages').appendChild(row); scrollBottom();
}
function copyText(t) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => fallbackCopy(t));
  else fallbackCopy(t);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('长按选择复制'); }
  document.body.removeChild(ta);
}
function editMsg(row) {
  const idx = parseInt(row.dataset.msgIdx), msg = messages[idx]; if (!msg) return;
  let raw = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? (msg.content.find(c => c.type === 'text')?.text || '') : '');
  raw = raw.replace(/^\[[^\]]*\]\n/, '');
  const inp = $('input'); inp.value = raw; autoResize(inp); inp.focus(); editingMsgIdx = idx;
}
function startAiBubble(idx) {
  const av = localStorage.getItem('chat-avatar-ai');
  const ah = av ? `<div class="msg-avatar msg-avatar-lin has-img"><img src="${av}"></div>`
    : `<div class="msg-avatar msg-avatar-lin">${(CFG.name || '凛')[0]}</div>`;
  const row = document.createElement('div'); row.className = 'msg-row';
  if (idx !== undefined) row.dataset.msgIdx = idx;
  row.innerHTML = `${ah}<div class="bubble-wrap"></div>`;
  $('messages').appendChild(row); currentAiRow = row;
  return row.querySelector('.bubble-wrap');
}
function addThinking(wrap) {
  const t = document.createElement('div'); t.className = 'thinking-wrap';
  t.innerHTML = `<div class="thinking-header"><div class="thinking-dot"></div><span>思考中</span><span class="thinking-arrow">▾</span></div><div class="thinking-content"></div>`;
  t.querySelector('.thinking-header').onclick = e => {
    const c = e.currentTarget.nextElementSibling; c.classList.toggle('open');
    e.currentTarget.querySelector('.thinking-arrow').classList.toggle('open');
  };
  wrap.appendChild(t); currentThinkWrap = t; currentThinkContent = t.querySelector('.thinking-content');
}
function savedThinking(wrap, text) {
  const t = document.createElement('div'); t.className = 'thinking-wrap';
  t.innerHTML = `<div class="thinking-header"><div class="thinking-dot" style="animation:none"></div><span>已思考</span><span class="thinking-arrow">▾</span></div><div class="thinking-content"></div>`;
  t.querySelector('.thinking-content').textContent = text;
  t.querySelector('.thinking-header').onclick = e => {
    const c = e.currentTarget.nextElementSibling; c.classList.toggle('open');
    e.currentTarget.querySelector('.thinking-arrow').classList.toggle('open');
  };
  wrap.appendChild(t);
}
function updateBubble(wrap, text, done, rawText, rowRef, tokens) {
  const w = $('waiting-bubble'); if (w) w.remove();
  if (!currentBubble) {
    const b = document.createElement('div'); b.className = 'bubble ai' + (done ? '' : ' typing-cursor');
    wrap.appendChild(b); currentBubble = b;
  }
  if (!done) { currentBubble.innerHTML = renderBubble(text); scrollBottom(); return; }
  const rendered = renderBubble(text);
  currentBubble.innerHTML = rendered;
  currentBubble.classList.remove('typing-cursor');
  if (!rendered.replace(/<img[^>]*>/g, '').replace(/\s/g, '').length) {
    currentBubble.style.cssText = 'background:transparent;border:none;box-shadow:none;padding:0';
  }
  const foot = document.createElement('div'); foot.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const time = document.createElement('span'); time.className = 'msg-time'; time.textContent = nowStr();
  foot.appendChild(time);
  if (tokens > 0) { const tk = document.createElement('span'); tk.className = 'msg-time'; tk.textContent = ` · ${tokens} tokens`; foot.appendChild(tk); }
  const cap = rawText || text;
  const mk = (label, fn) => { const s = document.createElement('span'); s.className = 'msg-action-btn'; s.textContent = label; s.onclick = fn; foot.appendChild(s); return s; };
  mk('重说', () => regenAt(rowRef || currentAiRow));
  const tb = mk('听', () => playTTS(cap, tb));
  mk('复制', () => copyText(cap));
  wrap.appendChild(foot); scrollBottom();
}

// ============ 语音 ============
async function playTTS(text, btn) {
  if (currentAudio && currentAudioBtn === btn) { currentAudio.pause(); currentAudio = null; currentAudioBtn = null; btn.textContent = '听'; return; }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (currentAudioBtn) currentAudioBtn.textContent = '听';
  currentAudioBtn = btn; btn.textContent = '…';
  try {
    const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
    const r = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 400), voice })
    });
    if (!r.ok) { btn.textContent = '听'; toast('语音加载失败'); currentAudioBtn = null; return; }
    const url = URL.createObjectURL(await r.blob());
    currentAudio = new Audio(url); btn.textContent = '停'; currentAudio.play();
    currentAudio.onended = () => { btn.textContent = '听'; currentAudio = null; currentAudioBtn = null; URL.revokeObjectURL(url); };
  } catch (e) { btn.textContent = '听'; currentAudioBtn = null; toast('语音出错'); }
}
let voicePlayingEl = null;
function voiceBubble(url, dur, transcript) {
  const wrapEl = document.createElement('div');
  wrapEl.style.cssText = 'display:flex;flex-direction:column;gap:3px;align-items:inherit;';
  const d = document.createElement('div'); d.className = 'voice-bubble';
  const secs = Math.max(1, Math.round(dur || 1));
  d.style.width = Math.min(210, 92 + secs * 5) + 'px';
  let bars = ''; for (let i = 0; i < 14; i++) bars += `<i style="height:${4 + ((i * 7) % 11)}px;animation-delay:${(i % 5) * .1}s"></i>`;
  d.innerHTML = `<span class="vb-play">▶</span><span class="vb-wave">${bars}</span><span class="vb-dur">${secs}"</span>`;
  d.onclick = () => toggleVoice(url, d);
  wrapEl.appendChild(d);
  if (transcript) {
    const tb = document.createElement('div'); tb.className = 'vb-text-btn'; tb.textContent = '看文字';
    const tx = document.createElement('div'); tx.className = 'vb-transcript'; tx.textContent = transcript; tx.style.display = 'none';
    tb.onclick = () => { const on = tx.style.display === 'none'; tx.style.display = on ? 'block' : 'none'; tb.textContent = on ? '收起' : '看文字'; };
    wrapEl.appendChild(tb); wrapEl.appendChild(tx);
  }
  return wrapEl;
}
function toggleVoice(url, el) {
  const stop = () => { el.classList.remove('playing'); el.querySelector('.vb-play').textContent = '▶'; currentAudio = null; voicePlayingEl = null; };
  if (voicePlayingEl === el && currentAudio) { currentAudio.pause(); stop(); return; }
  if (currentAudio) { try { currentAudio.pause(); } catch (e) { } }
  if (voicePlayingEl) { voicePlayingEl.classList.remove('playing'); const p = voicePlayingEl.querySelector('.vb-play'); if (p) p.textContent = '▶'; }
  currentAudio = new Audio(url); voicePlayingEl = el;
  el.classList.add('playing'); el.querySelector('.vb-play').textContent = '◼';
  currentAudio.onended = stop; currentAudio.onerror = () => { stop(); toast('这条听不了了'); };
  currentAudio.play().catch(() => { stop(); toast('再点一下'); });
}
let mediaRecorder = null, recChunks = [], recActive = false, recStartAt = 0;
async function startRecording() {
  if (recActive || isTyping) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('这个浏览器不支持录音'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let mime = '';
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'])
      if (window.MediaRecorder.isTypeSupported?.(m)) { mime = m; break; }
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const dur = (Date.now() - recStartAt) / 1000;
      if (dur < 0.4 || blob.size < 1200) { toast('太短了'); return; }
      await sendAudio(blob, dur);
    };
    recStartAt = Date.now(); recActive = true; mediaRecorder.start();
    $('mic-btn').classList.add('recording'); $('rec-hint').classList.add('show');
    if (navigator.vibrate) navigator.vibrate(15);
  } catch (e) { toast('拿不到麦克风权限'); }
}
function stopRecording() {
  if (!recActive) return;
  recActive = false;
  $('mic-btn').classList.remove('recording'); $('rec-hint').classList.remove('show');
  try { if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop(); } catch (e) { }
}
async function sendAudio(blob, dur) {
  const btn = $('mic-btn'); btn.textContent = '…';
  let audioUrl = '', text = '';
  try {
    const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
    try {
      const f1 = new FormData(); f1.append('file', blob, 'voice.' + ext);
      const d1 = await (await fetch('/api/voice', { method: 'POST', body: f1 })).json();
      if (d1.url) audioUrl = d1.url;
    } catch (e) { }
    const f2 = new FormData(); f2.append('file', blob, 'voice.' + ext);
    const d2 = await (await fetch('/api/stt', { method: 'POST', body: f2 })).json();
    if (d2.error) { toast(d2.error); return; }
    text = (d2.text || '').trim();
    if (!text) { toast('没听清'); return; }
  } catch (e) { toast('出错了'); return; }
  finally { btn.textContent = '◎'; }
  sendComposed(text, [], { audio: audioUrl, dur });
}
function initMic() {
  const btn = $('mic-btn');
  btn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); }, { passive: false });
  btn.addEventListener('touchend', e => { e.preventDefault(); stopRecording(); }, { passive: false });
  btn.addEventListener('touchcancel', stopRecording);
  btn.addEventListener('mousedown', e => { e.preventDefault(); startRecording(); });
  btn.addEventListener('mouseup', stopRecording);
  btn.addEventListener('mouseleave', () => { if (recActive) stopRecording(); });
}
async function attachVoiceReply(wrap, text) {
  if (localStorage.getItem('auto-voice') !== '1' || !text?.trim()) return;
  try {
    const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
    const d = await (await fetch('/api/tts-save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 600), voice })
    })).json();
    if (!d.url) return;
    const secs = Math.max(2, Math.round(text.length / 4.5));
    if (wrap) wrap.insertBefore(voiceBubble(d.url, secs, ''), wrap.firstChild);
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant' && messages[i].content) { messages[i]._audio = d.url; messages[i]._dur = secs; break; }
    saveConv();
  } catch (e) { }
}

// ============ 工具执行 ============
async function parseMcp(r, server) {
  const sid = r.headers.get('Mcp-Session-Id');
  if (sid && server) { server.sid = sid; saveMcp(); }
  const ct = r.headers.get('Content-Type') || '';
  const text = await r.text();
  if (ct.includes('text/event-stream')) {
    let js = '';
    for (const line of text.split('\n')) if (line.startsWith('data: ')) js += line.slice(6).trim();
    try { const d = JSON.parse(js); return d.result || d; } catch (e) { return { error: 'SSE parse failed' }; }
  }
  try { const d = JSON.parse(text); return d.result || d; } catch (e) { return { error: 'JSON parse failed' }; }
}
const txt = s => ({ content: [{ type: 'text', text: s }] });
async function execTool(name, args) {
  args = args || {};
  try {
    if (name === 'get_memories') {
      const items = await (await fetch('/api/memories')).json();
      return txt(JSON.stringify(items.map(i => ({ filename: i.filename, note: i.note, ts: i.ts }))));
    }
    if (name === 'view_memory') {
      const d = await (await fetch(`/api/memories/${args.filename}/image`)).json();
      if (d.error) return txt('图片不存在');
      const summary = `照片 ${args.filename}，备注：${d.note || '无备注'}`;
      return { content: [{ type: 'text', text: summary }, { type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } }], _summary: summary };
    }
    if (name === 'room_books') {
      const bs = await (await fetch('/api/books')).json();
      if (!bs.length) return txt('书房是空的');
      return txt(bs.map(b => `${b.title}（id ${b.id}，共 ${b.pages} 页；你读到第 ${(b.lin_progress || 0) + 1} 页，她读到第 ${(b.progress || 0) + 1} 页）`).join('\n'));
    }
    if (name === 'room_read_page') {
      const bs = await (await fetch('/api/books')).json();
      const b = bs.find(x => x.id === args.book_id);
      if (!b) return txt('没有这本书');
      const i = args.page !== undefined ? args.page : (b.lin_progress || 0);
      const d = await (await fetch(`/api/books/${args.book_id}/page?i=${i}`)).json();
      if (d.error) return txt('翻不开');
      await fetch(`/api/books/${args.book_id}/progress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: d.index, who: 'lin' })
      });
      const tags = await fetchTags('book', args.book_id, d.index);
      const tagLine = tags.length
        ? '\n\n【这一页上贴的标签】\n' + tags.map(t => `${t.author === 'user' ? '她' : '你'}${t.quote ? '在「' + t.quote + '」旁边' : ''}写：${t.text}`).join('\n')
        : '\n\n（这一页还没有人写字）';
      return txt(`《${d.title}》第 ${d.index + 1}/${d.total} 页\n\n${d.text}${tagLine}`);
    }
    if (name === 'room_search_book') {
      const hits = await (await fetch(`/api/books/${args.book_id}/search?q=${encodeURIComponent(args.q)}`)).json();
      if (!hits.length) return txt('这本书里没找到');
      return txt(hits.map(h => `第 ${h.page + 1} 页：…${h.excerpt}…`).join('\n'));
    }
    if (name === 'room_media') {
      const kind = args.kind === 'music' ? 'music' : 'video';
      const l = await (await fetch(kind === 'music' ? '/api/music' : '/api/videos')).json();
      if (!l.length) return txt(kind === 'music' ? '听音房是空的' : '放映室是空的');
      return txt(l.map(m => `${m.note || m.filename}（文件名 ${m.filename}）`).join('\n'));
    }
    if (name === 'room_music_shape') {
      const r = await fetch(`/api/music/${args.filename}/shape`);
      if (!r.ok) return txt('这首歌还没分析过——她在 app 里放一遍就有了');
      const s = await r.json();
      const segs = s.segments || [];
      const desc = segs.map(x => `${fmtTime(x.t)} ${'▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(x.level / 13))]}`).join('  ');
      return txt(`全长 ${fmtTime(s.duration)}。顶点在 ${fmtTime(s.peak_at)}，最空的一段在 ${fmtTime(s.empty_at)}。\n从头到尾的起伏：\n${desc}\n（这是这首歌的形状，不是旋律）`);
    }
    if (name === 'room_read_tags') {
      const tags = await fetchTags(args.type, args.id, args.pos);
      if (!tags.length) return txt('这里还没有标签');
      return txt(tags.map(t => {
        const who = t.author === 'user' ? '她' : '你';
        const where = args.type === 'book' ? `第 ${t.pos + 1} 页` : fmtTime(t.pos);
        return `[${t.id}] ${where} ${who}写：${t.quote ? '（在「' + t.quote + '」旁边）' : ''}${t.text}`;
      }).join('\n'));
    }
    if (name === 'room_write_tag') {
      const d = await (await fetch('/api/annotations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_type: args.type, anchor_id: args.id, pos: args.pos || 0,
          text: args.text, author: 'lin', reply_to: args.reply_to || null
        })
      })).json();
      if (d.error) return txt('贴不上：' + d.error);
      refreshHome();
      return txt('贴上去了，她翻到那里就会看见');
    }
    if (name === 'room_set_progress') {
      await fetch(`/api/books/${args.book_id}/progress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: args.page, who: 'lin' })
      });
      return txt('记下了');
    }
  } catch (e) { return txt('出错了：' + e.message); }

  const server = findServerForTool(name);
  if (!server) return txt(`没有找到提供「${name}」的服务器`);
  try {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (server.sid) h['Mcp-Session-Id'] = server.sid;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch(MCP_PROXY, {
      method: 'POST', headers: h, signal: ctrl.signal,
      body: JSON.stringify({ _server: server.url, jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: Date.now() })
    });
    clearTimeout(timer);
    return await parseMcp(r, server);
  } catch (e) { return { error: e.message }; }
}
function getSessionId() {
  let sid = localStorage.getItem('session-id');
  if (!sid) { sid = 'session_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); localStorage.setItem('session-id', sid); }
  return sid;
}
async function storeSummary(tool, summary) {
  try {
    await fetch('/api/store-memory-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: getSessionId(), tool_name: tool, summary })
    });
  } catch (e) { }
}
async function execAndStore(name, args) {
  const result = await execTool(name, args);
  if (name === 'breath' && result.content) {
    const t = result.content[0]?.text || '';
    await storeSummary('breath', t.slice(0, 2000) + (t.length > 2000 ? '……' : ''));
  } else if (name === 'view_memory' && result._summary) {
    await storeSummary('view_memory', result._summary);
  }
  return result;
}

// ============ 上下文 ============
function hasToolResult(m) { return m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result'); }
function toAnthropic(c) {
  if (!Array.isArray(c)) return c;
  return c.map(p => {
    if (p && p.type === 'image_url') {
      const m = /^data:(.+?);base64,(.*)$/.exec(p.image_url?.url || '');
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      return { type: 'text', text: '（图片）' };
    }
    return p;
  });
}
function buildMsgs(msgs) {
  if (sendFrom > msgs.length) sendFrom = Math.max(0, msgs.length - (ctxWindow || msgs.length));
  if (ctxWindow > 0 && msgs.length - sendFrom > ctxWindow * 2) sendFrom = msgs.length - ctxWindow;
  let win = msgs.slice(ctxWindow > 0 ? sendFrom : 0);
  while (win.length) {
    const m = win[0];
    if (m.role === 'tool' || hasToolResult(m) || m.role === 'assistant') { win.shift(); continue; }
    break;
  }
  const out = [];
  for (const m of win) {
    if (m.role === 'assistant' && !m.content && !m.tool_calls) continue;
    const { _internal, _thinking, _audio, _dur, ...rest } = m;
    rest.content = toAnthropic(rest.content);
    out.push(rest);
  }
  return out;
}
function nowContext() {
  const d = new Date();
  const hh = d.getHours();
  const period = hh < 5 ? '深夜' : hh < 9 ? '清早' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜';
  let s = `现在是 ${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}，${period}。`;
  s += togetherLine() + '。';
  const nd = nearestDayHint(); if (nd) s += nd.replace(' · ', '') + '。';
  const mh = moodHint(); if (mh) s += '她今天' + mh.replace(' · ', '') + '。';
  const st = localStorage.getItem('user-status'); if (st) s += '她现在：' + st + '。';
  return s;
}

// ============ 流式 ============
let abortController = null;
async function streamResponse(wrap, hist) {
  abortController = new AbortController();
  const resp = await fetch('/api/chat-v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abortController.signal,
    body: JSON.stringify({
      model: currentModel, messages: buildMsgs(hist), tools: buildTools(),
      now: nowContext(), _session_id: getSessionId()
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '', thinkingText = '', responseText = '', stopReason = null;
  let outTok = 0, inTok = 0;
  const absorb = u => {
    if (!u) return;
    if (u.cache_read_input_tokens != null) lastCacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) lastCacheWrite = u.cache_creation_input_tokens;
    if (u.input_tokens != null) inTok = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (u.prompt_tokens != null) {
      inTok = u.prompt_tokens;
      if (u.prompt_tokens_details?.cached_tokens != null) lastCacheRead = u.prompt_tokens_details.cached_tokens;
    }
    if (u.output_tokens != null) outTok = u.output_tokens;
    if (u.completion_tokens != null) outTok = u.completion_tokens;
  };
  const blocks = {};
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw);
          if (d.type === 'message_start') absorb(d.message?.usage);
          else if (d.type === 'content_block_start') {
            const b = d.content_block;
            if (b.type === 'tool_use') {
              blocks[d.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '', _rb: null };
              const ind = document.createElement('div'); ind.className = 'tool-indicator';
              ind.innerHTML = `<span class="tl"></span><span>${b.name}</span>`;
              const rb = document.createElement('div'); rb.className = 'tool-result-block';
              blocks[d.index]._rb = rb;
              ind.onclick = () => rb.style.display = rb.style.display === 'none' || !rb.style.display ? 'block' : 'none';
              wrap.appendChild(ind); wrap.appendChild(rb); scrollBottom();
            } else if (b.type === 'text') blocks[d.index] = { type: 'text', text: '' };
            else if (b.type === 'thinking') blocks[d.index] = { type: 'thinking', thinking: '', signature: '' };
          } else if (d.type === 'content_block_delta') {
            const blk = blocks[d.index]; if (!blk) continue;
            const dl = d.delta;
            if (dl.type === 'text_delta') {
              blk.text += dl.text; responseText += dl.text;
              updateBubble(wrap, responseText, false);
              if (messages.length && messages[messages.length - 1].role === 'assistant') messages[messages.length - 1].content = responseText;
              else messages.push({ role: 'assistant', content: responseText });
              saveConv();
            } else if (dl.type === 'thinking_delta') {
              blk.thinking += dl.thinking;
              if (!currentThinkWrap) addThinking(wrap);
              thinkingText += dl.thinking;
              if (currentThinkContent) currentThinkContent.textContent = thinkingText;
            } else if (dl.type === 'signature_delta') blk.signature = (blk.signature || '') + dl.signature;
            else if (dl.type === 'input_json_delta') blk._json += dl.partial_json;
          } else if (d.type === 'content_block_stop') {
            const blk = blocks[d.index];
            if (blk?.type === 'tool_use') { try { blk.input = blk._json ? JSON.parse(blk._json) : {}; } catch (e) { blk.input = {}; } }
          } else if (d.type === 'message_delta') {
            if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
            absorb(d.usage);
          }
        } catch (e) { }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  abortController = null;
  totalTokens = inTok + outTok;
  if (thinkingText) turnThinking += (turnThinking ? '\n\n' : '') + thinkingText;
  const keys = Object.keys(blocks).map(Number).sort((a, b) => a - b);
  const contentBlocks = keys.map(k => { const { _json, _rb, ...c } = blocks[k]; return c; });
  const toolUses = keys.map(k => blocks[k]).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input, rb: b._rb }));
  if (currentThinkWrap) {
    const dot = currentThinkWrap.querySelector('.thinking-dot'); if (dot) dot.style.animation = 'none';
    const sp = currentThinkWrap.querySelector('.thinking-header span'); if (sp) sp.textContent = '已思考';
  }
  if (responseText) { updateBubble(wrap, responseText, true, responseText, currentAiRow, outTok); saveConv(); }
  return { text: responseText, toolUses, stopReason, contentBlocks };
}
function sanitize(m) {
  if (!Array.isArray(m.content)) return m;
  const needs = m.content.some(c => c && (c.type === 'image' || c.type === 'image_url' || c.type === 'thinking'));
  if (!needs) return m;
  return {
    ...m, content: m.content.filter(c => !(c && c.type === 'thinking'))
      .map(c => c && (c.type === 'image' || c.type === 'image_url') ? { type: 'text', text: '（一张看过的照片）' } : c)
  };
}
async function runToolLoop(wrap, origLen) {
  let work = [...messages], finalText = '';
  while (true) {
    const { text, toolUses, stopReason, contentBlocks } = await streamResponse(wrap, work);
    finalText = text;
    if (stopReason !== 'tool_use' || !toolUses.length) break;
    work.push({ role: 'assistant', content: contentBlocks });
    const results = [], extra = [];
    for (const tu of toolUses) {
      const result = await execAndStore(tu.name, tu.input);
      let content = result?.content?.[0]?.text || JSON.stringify(result) || '（空）';
      if (tu.rb) {
        const ind = tu.rb.previousElementSibling;
        if (ind) ind.innerHTML = `<span class="tl"></span><span>${tu.name}</span>`;
        tu.rb.textContent = content.slice(0, 1200);
      }
      if (tu.name === 'view_memory' && result.content) {
        const img = result.content.find(c => c.type === 'image_url');
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: result._summary || content });
        if (img && tu.rb) { const im = document.createElement('img'); im.src = img.image_url.url; im.style.cssText = 'max-width:100%;border-radius:8px;margin-top:6px;display:block;'; tu.rb.appendChild(im); }
        if (img) {
          const m = /^data:(.+?);base64,(.*)$/.exec(img.image_url.url);
          if (m) {
            extra.push({ type: 'text', text: '（这是你刚看的照片：' + (result._summary || '') + '）' });
            extra.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
          }
        }
      } else {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: content.slice(0, 6000) });
      }
    }
    work.push({ role: 'user', _internal: true, content: [...results, ...extra] });
    currentBubble = null;
  }
  const extraMsgs = work.slice(origLen).map(sanitize);
  if (extraMsgs.length) messages.splice(origLen, 0, ...extraMsgs);
  if (turnThinking) {
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant' && messages[i].content) { messages[i]._thinking = turnThinking.slice(0, 3000); break; }
  }
  saveConv(); refreshHome();
  return finalText;
}

// ============ 发送 ============
function stampPrefix() {
  const d = new Date();
  const ts = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `[${ts}]`;
}
async function sendMsg() {
  const inp = $('input'), text = inp.value.trim(), hasImg = !!pendingChatImg;
  if ((!text && !hasImg) || isTyping) return;
  const finalText = text ? stampPrefix() + '\n' + text : '';
  inp.value = ''; inp.style.height = 'auto';
  $('send-btn').textContent = '■'; isTyping = true;
  if (editingMsgIdx !== null) {
    messages.splice(editingMsgIdx);
    [...document.querySelectorAll('#messages .msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= editingMsgIdx) r.remove(); });
    editingMsgIdx = null;
  }
  const content = hasImg
    ? [...(finalText ? [{ type: 'text', text: finalText }] : []), { type: 'image_url', image_url: { url: pendingChatImg.data } }]
    : finalText;
  messages.push({ role: 'user', content });
  addUserBubble(finalText, hasImg ? pendingChatImg.data : null, messages.length - 1);
  saveConv();
  if (hasImg) { pendingChatImg = null; $('img-preview-bar').classList.remove('show'); }
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { console.error(e); updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  isTyping = false; $('send-btn').textContent = '↑';
}
async function sendComposed(text, imgs, opts) {
  if (isTyping) return;
  imgs = imgs || []; opts = opts || {};
  const finalText = stampPrefix() + '\n' + text;
  let content = finalText;
  if (imgs.length) {
    content = [{ type: 'text', text: finalText }];
    imgs.forEach(u => content.push({ type: 'image_url', image_url: { url: u } }));
  }
  $('send-btn').textContent = '■'; isTyping = true;
  const msg = { role: 'user', content };
  if (opts.audio) { msg._audio = opts.audio; msg._dur = opts.dur; }
  messages.push(msg);
  const myIdx = messages.length - 1;
  showPage('chat');
  addUserBubble(finalText, imgs[0] || null, myIdx, opts.audio ? { url: opts.audio, dur: opts.dur } : null);
  saveConv();
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { console.error(e); updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  if (imgs.length && Array.isArray(messages[myIdx]?.content)) {
    messages[myIdx].content = messages[myIdx].content.map(c => c && c.type === 'image_url' ? { type: 'text', text: '（一张看过的照片）' } : c);
    saveConv();
  }
  isTyping = false; $('send-btn').textContent = '↑';
}
async function regenAt(row) {
  if (isTyping || !row) return;
  const idx = parseInt(row.dataset.msgIdx);
  messages.splice(idx);
  [...document.querySelectorAll('#messages .msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= idx) r.remove(); });
  if (!messages.length || messages[messages.length - 1].role !== 'user') return;
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  isTyping = true; $('send-btn').textContent = '■';
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  isTyping = false; $('send-btn').textContent = '↑';
}
async function rememberSomething() {
  if (isTyping) { toast('等他说完这句'); return; }
  toast('翻翻看…');
  try {
    const items = await (await fetch('/api/memories')).json();
    if (!items.length) { toast('时光墙还是空的'); return; }
    const pool = items.length > 3 ? items.slice(Math.floor(items.length / 2)) : items;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const d = await (await fetch('/api/memories/' + pick.filename + '/image')).json();
    if (d.error) { toast('这张翻不开'); return; }
    sendComposed('【今天忽然想起这张】' + (pick.note ? '\n备注：' + pick.note : '') + '\n你还记得吗',
      ['data:' + d.mime + ';base64,' + d.data]);
  } catch (e) { toast('翻不动'); }
}

// ============ 设置项 ============
function updateModelUI() {
  document.querySelectorAll('[data-model]').forEach(e => e.classList.toggle('active', e.dataset.model === currentModel));
  const names = { 'anthropic/claude-sonnet-4-6': 'Sonnet 4.6', 'anthropic/claude-opus-4-6': 'Opus 4.6', 'anthropic/claude-haiku-4-5': 'Haiku 4.5' };
  $('model-sub').textContent = '当前：' + (names[currentModel] || currentModel);
}
function updateCtxUI() {
  document.querySelectorAll('.ctx-option[data-val]').forEach(e => e.classList.toggle('active', parseInt(e.dataset.val) === ctxWindow));
  $('ctx-sub').textContent = ctxWindow === 0 ? `当前：全部 ${messages.length} 条` : `当前：${ctxWindow}～${ctxWindow * 2} 条（跳跃窗口，缓存友好）`;
}
function updateVoiceUI() {
  const v = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
  document.querySelectorAll('[data-voice]').forEach(e => e.classList.toggle('active', e.dataset.voice === v));
}
function updateTokens() {
  const pct = Math.min(totalTokens / CONTEXT_LIMIT * 100, 100);
  $('token-used').textContent = totalTokens.toLocaleString() + ' tokens';
  $('token-bar').style.width = pct + '%';
  const ci = (lastCacheRead || lastCacheWrite) ? ` · 缓存命中 ${lastCacheRead.toLocaleString()}` : '';
  $('token-remain').textContent = `还剩约 ${(CONTEXT_LIMIT - totalTokens).toLocaleString()} tokens${ci}`;
}
async function fetchBalance() {
  updateTokens();
  try {
    const d = await (await fetch('/api/key-info')).json();
    if (d.data) {
      const limit = d.data.limit !== null ? `$${parseFloat(d.data.limit).toFixed(2)}` : '无上限';
      const used = d.data.usage !== undefined ? parseFloat(d.data.usage).toFixed(4) : '—';
      const rem = d.data.limit !== null ? `$${(d.data.limit - (d.data.usage || 0)).toFixed(4)}` : '—';
      $('balance-val').textContent = `剩余 ${rem}`;
      $('balance-limit').textContent = `已用 $${used} · 额度 ${limit}`;
    } else $('balance-val').textContent = '查询失败';
  } catch (e) { $('balance-val').textContent = '查询失败'; }
}
function renderMcpList() {
  const el = $('mcp-list');
  $('mcp-count').textContent = mcpServers.length ? `${mcpServers.length} 个` : '';
  el.innerHTML = '';
  if (!mcpServers.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:50px 20px;">还没有添加服务器</div>'; return; }
  mcpServers.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'mcp-server' + (s.enabled ? '' : ' off');
    const names = (s.tools || []).map(t => t.name).join('、') || '（没有工具）';
    d.innerHTML = `<div class="mcp-name">${esc(s.name || '未命名')}</div><div class="mcp-url">${esc(s.url)}</div>
      <div class="mcp-tools">${(s.tools || []).length} 个工具：${esc(names)}</div>
      <div style="margin-top:8px;"><span class="msg-action-btn" style="opacity:.8" data-refresh="${i}">重新读取</span></div>
      <div class="mcp-actions"><div class="mcp-toggle${s.enabled ? ' on' : ''}" data-toggle="${i}"></div><div class="mcp-del" data-del="${i}">✕</div></div>`;
    d.querySelector('[data-toggle]').onclick = () => { s.enabled = !s.enabled; saveMcp(); renderMcpList(); sendFrom = 0; };
    d.querySelector('[data-del]').onclick = () => {
      if (!confirm(`删除「${s.name || s.url}」？`)) return;
      mcpServers.splice(i, 1); saveMcp(); renderMcpList();
    };
    d.querySelector('[data-refresh]').onclick = async () => {
      toast('重新读取中…');
      try {
        const dd = await (await fetch('/api/mcp-connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: s.url }) })).json();
        if (dd.error) { toast(dd.error); return; }
        s.tools = dd.tools || []; s.sid = dd.session_id || null;
        saveMcp(); renderMcpList(); toast(`读到 ${s.tools.length} 个工具`);
      } catch (e) { toast('出错'); }
    };
    el.appendChild(d);
  });
}
function startKeepalive() {
  setInterval(() => {
    if (isTyping) return;
    fetch('/api/chat-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: currentModel, tools: buildTools(),
        messages: [{ role: 'user', content: 'ping' }],
        _session_id: getSessionId(), _keepalive: true
      })
    }).then(r => { if (r.body) r.body.cancel(); }).catch(() => { });
  }, 50 * 60 * 1000);
}
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ============ 事件绑定 ============
function bindAll() {
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => showPage(t.dataset.page));
  document.querySelectorAll('.door').forEach(d => d.onclick = () => {
    const r = d.dataset.room;
    if (r === 'study') openStudy();
    else if (r === 'cinema') openRoomMedia('video');
    else if (r === 'music') openRoomMedia('music');
    else if (r === 'mailbox') { $('mailbox').classList.add('open'); loadLetters(); }
  });
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
    $(b.dataset.close).classList.remove('open'); refreshHome();
  });
  document.querySelectorAll('[data-close-full]').forEach(b => b.onclick = () => $(b.dataset.closeFull).classList.remove('open'));
  document.querySelectorAll('[data-close-sheet]').forEach(b => b.onclick = () => $(b.dataset.closeSheet).classList.remove('open'));
  document.querySelectorAll('.sheet').forEach(s => s.onclick = e => { if (e.target === s) s.classList.remove('open'); });

  $('avatar').onclick = () => { $('avatar-menu').classList.toggle('open'); $('theme-menu').classList.remove('open'); };
  $('btn-theme').onclick = () => { $('theme-menu').classList.toggle('open'); $('avatar-menu').classList.remove('open'); };
  document.querySelectorAll('.theme-option').forEach(o => o.onclick = () => setTheme(o.dataset.theme));
  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-theme') && !e.target.closest('.theme-menu')) $('theme-menu').classList.remove('open');
    if (!e.target.closest('#avatar') && !e.target.closest('#avatar-menu')) $('avatar-menu').classList.remove('open');
  });
  document.querySelectorAll('.avatar-menu-item').forEach(it => it.onclick = () => {
    $('avatar-menu').classList.remove('open');
    const a = it.dataset.act;
    if (a === 'av-ai') { pendingAvatarTarget = 'ai'; $('avatar-input').click(); }
    if (a === 'av-user') { pendingAvatarTarget = 'user'; $('avatar-input').click(); }
    if (a === 'status') { $('status-custom-input').value = ''; $('status-modal').classList.add('open'); }
    if (a === 'mood') openMood();
    if (a === 'remember') rememberSomething();
    if (a === 'bg') $('bg-input').click();
    if (a === 'bg-clear') { localStorage.removeItem('chat-bg'); document.body.style.backgroundImage = ''; $('clear-bg-btn').style.display = 'none'; }
  });

  $('btn-convs').onclick = () => { saveConv(); renderConvs(); $('conv-panel').classList.add('open'); };
  $('btn-new-conv').onclick = newConv;
  $('send-btn').onclick = () => { if (isTyping) { abortController?.abort(); } else sendMsg(); };
  $('input').oninput = e => autoResize(e.target);
  $('btn-emoji').onclick = () => $('emoji-panel').classList.add('open');
  $('btn-img').onclick = () => $('chat-img-input').click();
  $('img-preview-remove').onclick = () => { pendingChatImg = null; $('img-preview-bar').classList.remove('show'); };
  $('lightbox').onclick = () => $('lightbox').classList.remove('open');

  $('btn-persona').onclick = openPersona;
  ['p-core', 'p-rhythm', 'p-lines', 'p-call', 'p-call2', 'p-maxtok', 'p-vid-calm', 'p-vid-dog', 'p-pwd']
    .forEach(id => $(id).oninput = personaMeter);
  $('btn-persona-save').onclick = savePersona;
  $('btn-persona-reset').onclick = openPersona;
  $('btn-persona-history').onclick = openPersonaHistory;

  document.querySelectorAll('[data-model]').forEach(e => e.onclick = () => { currentModel = e.dataset.model; localStorage.setItem('current-model', currentModel); updateModelUI(); });
  document.querySelectorAll('.ctx-option[data-val]').forEach(e => e.onclick = () => { ctxWindow = parseInt(e.dataset.val); localStorage.setItem('ctx-window', ctxWindow); sendFrom = 0; updateCtxUI(); });
  document.querySelectorAll('[data-voice]').forEach(e => e.onclick = () => { localStorage.setItem('tts-voice', e.dataset.voice); updateVoiceUI(); });
  $('auto-voice-toggle').onchange = e => localStorage.setItem('auto-voice', e.target.checked ? '1' : '');
  $('btn-mcp').onclick = () => { renderMcpList(); $('mcp-panel').classList.add('open'); };
  $('mcp-add-btn').onclick = async () => {
    const url = $('mcp-url-input').value.trim(), name = $('mcp-name-input').value.trim();
    if (!url) { toast('先填地址'); return; }
    const btn = $('mcp-add-btn'); btn.textContent = '连接中…'; btn.disabled = true;
    try {
      const d = await (await fetch('/api/mcp-connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })).json();
      if (d.error) { toast(d.error); return; }
      const ex = mcpServers.findIndex(s => s.url === url);
      const entry = { id: 's' + Date.now().toString(36), name: name || url.replace(/^https?:\/\//, '').split('/')[0], url, enabled: true, sid: d.session_id || null, tools: d.tools || [] };
      if (ex >= 0) mcpServers[ex] = entry; else mcpServers.push(entry);
      saveMcp(); renderMcpList();
      $('mcp-url-input').value = ''; $('mcp-name-input').value = '';
      toast(`已添加，读到 ${entry.tools.length} 个工具`);
    } catch (e) { toast('连接出错'); }
    finally { btn.textContent = '连接并添加'; btn.disabled = false; }
  };
  $('btn-clear-conv').onclick = () => {
    if (!confirm('清空本次对话？')) return;
    messages = []; totalTokens = 0; sendFrom = 0;
    $('messages').innerHTML = '<div class="sys-msg">— 对话已清空 —</div>';
    saveConv(); toast('清空了');
  };

  // 书房
  $('btn-addbook').onclick = () => $('addbook-modal').classList.add('open');
  $('reader-close').onclick = () => { $('reader').classList.remove('open'); loadBooks(); refreshHome(); };
  $('prev-page').onclick = () => showPageAt(currentPage - 1);
  $('next-page').onclick = () => showPageAt(currentPage + 1);
  $('font-up').onclick = () => { readerFont = Math.min(24, readerFont + 1); localStorage.setItem('reader-font', readerFont); $('reader-text').style.fontSize = readerFont + 'px'; };
  $('font-down').onclick = () => { readerFont = Math.max(14, readerFont - 1); localStorage.setItem('reader-font', readerFont); $('reader-text').style.fontSize = readerFont + 'px'; };
  $('annot-cancel').onclick = () => $('annot-new').classList.remove('open');
  $('annot-save').onclick = saveTag;
  initSelection();
  $('btn-book-search').onclick = searchBooks;
  $('book-search-input').onkeydown = e => { if (e.key === 'Enter') searchBooks(); };
  $('btn-book-url').onclick = addFromUrl;
  $('btn-book-file').onclick = () => $('book-file').click();
  $('btn-book-paste').onclick = addPasted;

  // 放映室 / 听音房
  $('btn-upload-video').onclick = () => $('video-file').click();
  $('btn-upload-music').onclick = () => $('music-file').click();
  $('stage-close').onclick = closeStage;
  $('btn-tag-here').onclick = () => {
    if (!curMedia) return;
    openTagWriter({ type: curKind, id: curMedia.filename, pos: Math.round(stageTime()), quote: '' });
  };
  $('btn-see-tags').onclick = () => loadStageTags(false);

  // 信箱
  $('btn-write-letter').onclick = () => { $('letter-input').value = ''; $('write-letter-modal').classList.add('open'); };
  $('btn-send-letter').onclick = async () => {
    const t = $('letter-input').value.trim();
    if (!t) { toast('还什么都没写'); return; }
    $('write-letter-modal').classList.remove('open'); toast('寄出去了…');
    const res = await callOB('letter_write', { author: 'user', content: t });
    if (res?.error) { toast('没寄成'); return; }
    toast('已经放进信箱'); loadLetters();
  };
  $('btn-ask-letter').onclick = () => {
    $('mailbox').classList.remove('open');
    sendComposed('我想收一封你写的信。慢慢写，写完用 letter_write 放进信箱，署名你自己。', []);
  };

  // 时光墙
  $('btn-mem-upload').onclick = () => $('file-input').click();
  $('btn-days').onclick = () => { renderDays(); $('days-modal').classList.add('open'); };
  $('day-add').onclick = () => {
    const name = $('day-name-input').value.trim(), date = $('day-date-input').value;
    if (!name || !date) { toast('名字和日子都要填'); return; }
    const l = getDays(); l.push({ id: genId(), name, date, yearly: $('day-yearly').checked });
    saveDays(l); $('day-name-input').value = ''; $('day-date-input').value = '';
    renderDays(); refreshHome(); toast('记下了');
  };
  $('note-skip').onclick = () => { $('note-modal').classList.remove('open'); if (pendingFile) doUpload(pendingFile, ''); pendingFile = null; };
  $('note-ok').onclick = () => { $('note-modal').classList.remove('open'); if (pendingFile) doUpload(pendingFile, $('note-input').value.trim()); pendingFile = null; };

  // 状态 / 心情
  document.querySelectorAll('#status-presets .status-preset').forEach(p => p.onclick = () => {
    $('status-modal').classList.remove('open');
    applyStatus(p.dataset.clear ? '' : p.textContent, true);
  });
  $('status-ok').onclick = () => {
    const v = $('status-custom-input').value.trim();
    $('status-modal').classList.remove('open'); if (v) applyStatus(v, true);
  };
  $('mood-ok').onclick = () => {
    const sel = document.querySelector('#mood-grid .mood-chip.on');
    if (!sel) { toast('先选一个'); return; }
    const mood = sel.textContent, note = $('mood-note').value.trim();
    localStorage.setItem('mood-today', mood);
    localStorage.setItem('mood-date', new Date().toDateString());
    $('mood-modal').classList.remove('open'); toast('记下了');
    const d = new Date();
    callOB('hold', {
      content: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} 宝宝今天心情：${mood}${note ? '。' + note : ''}`,
      tags: '心情', importance: 3, feel: true
    });
  };

  // 文件输入
  $('file-input').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    pendingFile = f; $('note-input').value = ''; $('note-modal').classList.add('open');
  };
  $('chat-img-input').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = new FileReader();
    r.onload = ev => { pendingChatImg = { data: ev.target.result, type: f.type }; $('img-preview-thumb').src = ev.target.result; $('img-preview-bar').classList.add('show'); };
    r.readAsDataURL(f);
  };
  $('avatar-input').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      const d = ev.target.result;
      if (pendingAvatarTarget === 'ai') { localStorage.setItem('chat-avatar-ai', d); applyAiAvatar(d); }
      else { localStorage.setItem('chat-avatar-user', d); }
      toast('头像已更新');
    };
    r.readAsDataURL(f);
  };
  $('bg-input').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = new FileReader();
    r.onload = ev => { localStorage.setItem('chat-bg', ev.target.result); document.body.style.backgroundImage = `url(${ev.target.result})`; $('clear-bg-btn').style.display = ''; };
    r.readAsDataURL(f);
  };
  $('btn-emoji-upload').onclick = () => $('emoji-input').click();
  $('emoji-input').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = new FileReader();
    r.onload = async ev => {
      pendingEmoji = await compressImage(ev.target.result, 200);
      $('emoji-name-input').value = ''; $('emoji-name-modal').classList.add('open');
    };
    r.readAsDataURL(f);
  };
  $('emoji-name-cancel').onclick = () => { $('emoji-name-modal').classList.remove('open'); pendingEmoji = null; };
  $('emoji-name-ok').onclick = () => {
    const name = $('emoji-name-input').value.trim();
    $('emoji-name-modal').classList.remove('open');
    if (!pendingEmoji) return;
    const c = JSON.parse(localStorage.getItem('custom-emoji') || '[]');
    c.push({ name: name || `表情${c.length + 1}`, data: pendingEmoji });
    localStorage.setItem('custom-emoji', JSON.stringify(c));
    renderEmojiGrid(); toast('表情已上传'); pendingEmoji = null;
  };
  $('book-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    $('addbook-modal').classList.remove('open'); toast('正在拆封…');
    const form = new FormData(); form.append('file', f);
    try {
      const d = await (await fetch('/api/books', { method: 'POST', body: form })).json();
      if (d.error) { toast(d.error); return; }
      await loadBooks(); refreshHome(); toast(`《${d.title}》上架了`);
    } catch (e) { toast('上架失败'); }
  };
  $('video-file').onchange = e => uploadMedia(e, 'video');
  $('music-file').onchange = e => uploadMedia(e, 'music');
}
let pendingAvatarTarget = 'ai', pendingEmoji = null;
async function uploadMedia(e, kind) {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const note = prompt(kind === 'video' ? '给这卷片子起个名字' : '这首歌叫什么', f.name.replace(/\.[^.]+$/, '')) || '';
  toast('正在上传，大文件慢一点…');
  const form = new FormData(); form.append('file', f); if (note) form.append('note', note);
  try {
    const d = await (await fetch(kind === 'video' ? '/api/videos' : '/api/music', { method: 'POST', body: form })).json();
    if (d.error) { toast(d.error); return; }
    await loadMedia(kind); refreshHome(); toast('好了');
  } catch (e) { toast('上传失败'); }
}
async function searchBooks() {
  const q = $('book-search-input').value.trim(), box = $('book-results');
  if (!q) { toast('先写个书名'); return; }
  box.innerHTML = '<div class="settings-sub">正在翻…</div>';
  try {
    const d = await (await fetch('/api/books/search?q=' + encodeURIComponent(q))).json();
    if (d.error || !Array.isArray(d) || !d.length) { box.innerHTML = `<div class="settings-sub">${esc(d.error || '没找到')}</div>`; return; }
    box.innerHTML = '';
    d.forEach(item => {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:8px;background:var(--bubble-ai);border:1px solid var(--border);border-radius:12px;padding:9px 12px;';
      el.innerHTML = `<div style="flex:1;min-width:0;"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.title)}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(item.author || '')}</div></div>`;
      const b = document.createElement('button');
      b.className = 'btn-solid'; b.textContent = '上架';
      b.style.cssText = 'flex:none;padding:6px 14px;font-size:12px;';
      b.onclick = async () => {
        b.textContent = '取书中…'; b.disabled = true;
        try {
          const dd = await (await fetch('/api/books/fetch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: item.source, ref: item.ref, title: item.title })
          })).json();
          if (dd.error) { toast(dd.error); b.textContent = '上架'; b.disabled = false; return; }
          b.textContent = '已上架'; await loadBooks(); refreshHome(); toast(`《${dd.title}》共 ${dd.pages} 页`);
        } catch (e) { toast('取书失败'); b.textContent = '上架'; b.disabled = false; }
      };
      el.appendChild(b); box.appendChild(el);
    });
  } catch (e) { box.innerHTML = '<div class="settings-sub">没连上</div>'; }
}
async function addFromUrl() {
  const url = $('book-url-input').value.trim();
  if (!url) { toast('先贴个网址'); return; }
  toast('正在取…');
  try {
    const d = await (await fetch('/api/books/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'url', ref: url }) })).json();
    if (d.error) { toast(d.error); return; }
    $('book-url-input').value = ''; $('addbook-modal').classList.remove('open');
    await loadBooks(); refreshHome(); toast(`《${d.title}》上架了`);
  } catch (e) { toast('取失败'); }
}
async function addPasted() {
  const title = $('book-title-input').value.trim(), text = $('book-text-input').value.trim();
  if (!text) { toast('还没有正文'); return; }
  $('addbook-modal').classList.remove('open'); toast('正在装订…');
  try {
    const d = await (await fetch('/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title || '无名', text }) })).json();
    if (d.error) { toast(d.error); return; }
    $('book-title-input').value = ''; $('book-text-input').value = '';
    await loadBooks(); refreshHome(); toast(`《${d.title}》上架了`);
  } catch (e) { toast('装订失败'); }
}

boot();
