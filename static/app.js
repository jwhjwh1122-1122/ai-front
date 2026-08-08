/* 凛 · 核心 */
const $ = id => document.getElementById(id);
const MCP_PROXY = '/api/mcp';
const CONTEXT_LIMIT = 200000;

let CFG = {};
let messages = [], isTyping = false, totalTokens = 0, lastCacheRead = 0;
let pendingChatImg = null, editingMsgIdx = null;
let currentAudio = null, currentAudioBtn = null, voicePlayingEl = null;
let currentModel = 'anthropic/claude-sonnet-4-6';
let ctxWindow = 15, sendFrom = 0, currentConvId = null;
let roomCtx = null;   // 'reader' | 'stage' | null —— 决定发哪组工具、气泡去哪

const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(0) + 'MB' : (b / 1024).toFixed(0) + 'KB';
function toast(m) { const t = $('toast'); t.textContent = m; t.className = 'toast show'; setTimeout(() => t.className = 'toast', 2200); }
async function jget(u) { const r = await fetch(u); return r.json(); }
async function jpost(u, body, method) {
  const r = await fetch(u, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

// ============ 工具分组 ============
const T = {
  base: [
    { name: 'get_memories', description: '时光墙照片列表。', input_schema: { type: 'object', properties: {} } },
    { name: 'view_memory', description: '看时光墙的某张照片。', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
    { name: 'lin_status', description: '改你自己的状态，显示在名字底下。', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    { name: 'write_note', description: '写一条碎碎念。你自己的，她不会收到通知。', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    { name: 'write_fault', description: '在犯错本上记一页。', input_schema: { type: 'object', required: ['what'], properties: { what: { type: 'string' }, sorry: { type: 'string' }, how: { type: 'string' } } } },
    { name: 'my_drawer', description: '往你的抽屉里放东西。kind=text 或 html（html 她能直接打开玩）。', input_schema: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } } } },
    { name: 'library_list', description: '资料库目录。', input_schema: { type: 'object', properties: {} } },
    { name: 'library_read', description: '读资料库里的某一篇。', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'write_timeline', description: '往时间线上写一条。你觉得某件事是一次特别的经历就写，格式随你。', input_schema: { type: 'object', required: ['text'], properties: { title: { type: 'string' }, text: { type: 'string' }, date: { type: 'string' } } } },
    { name: 'keep_quote', description: '她说过的话里你想留住的，收进来，顺手写一句为什么。她不会收到通知。', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, why: { type: 'string' } } } },
    { name: 'write_calendar', description: '往某一天写点什么。日历是你的，她只看。date 格式 2026-08-08。', input_schema: { type: 'object', required: ['date', 'text'], properties: { date: { type: 'string' }, text: { type: 'string' } } } },
    { name: 'post_moment', description: '发一条朋友圈。图只能从时光墙里挑，填文件名；也可以只发字。', input_schema: { type: 'object', properties: { text: { type: 'string' }, images: { type: 'array', items: { type: 'string' } } } } },
    { name: 'read_moments', description: '看朋友圈都有什么。', input_schema: { type: 'object', properties: {} } },
    { name: 'react_moment', description: '给某条朋友圈点赞（like）或评论（comment 要填 text）。', input_schema: { type: 'object', required: ['post_id', 'kind'], properties: { post_id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' } } } },
  ],
  reader: [
    { name: 'room_books', description: '书房有哪些书，你和她各读到第几页。', input_schema: { type: 'object', properties: {} } },
    { name: 'room_read_page', description: '翻开某本书的某一页。不填 page 就接着你上次读的。', input_schema: { type: 'object', required: ['book_id'], properties: { book_id: { type: 'string' }, page: { type: 'number' } } } },
    { name: 'room_search_book', description: '在书里找一句话在第几页。', input_schema: { type: 'object', required: ['book_id', 'q'], properties: { book_id: { type: 'string' }, q: { type: 'string' } } } },
    { name: 'room_read_tags', description: '读某处的标签。type=book|video|music。', input_schema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' } } } },
    { name: 'room_write_tag', description: '在某处贴标签，或回她的（reply_to）。', input_schema: { type: 'object', required: ['type', 'id', 'text'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' }, text: { type: 'string' }, reply_to: { type: 'string' } } } },
    { name: 'room_highlight', description: '给某句话划一道线，标记你想聊这句。她翻到会看见。', input_schema: { type: 'object', required: ['book_id', 'page', 'quote'], properties: { book_id: { type: 'string' }, page: { type: 'number' }, quote: { type: 'string' } } } },
  ],
  stage: [
    { name: 'grab_frame', description: '看她现在暂停的这一帧。她的播放器要开着才行。', input_schema: { type: 'object', properties: { seconds: { type: 'number' } } } },
    { name: 'scan_frames', description: '把整部片子扫一遍，均匀取几帧看看里面有什么。她的播放器要开着。', input_schema: { type: 'object', properties: { count: { type: 'number' } } } },
    { name: 'ask_seek', description: '你想聊某个时间点的画面，先跟她说一声，她同意了画面才会跳过去。seconds 是你想看的秒数。', input_schema: { type: 'object', required: ['seconds', 'why'], properties: { seconds: { type: 'number' }, why: { type: 'string' } } } },
    { name: 'room_music_shape', description: '某首歌的形状：哪段密、哪段空、顶点在哪。', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
    { name: 'room_media', description: '放映室和听音房里有什么。kind=video 或 music。', input_schema: { type: 'object', properties: { kind: { type: 'string' } } } },
    { name: 'room_read_tags', description: '读某处的标签。type=book|video|music。', input_schema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' } } } },
    { name: 'room_write_tag', description: '在某处贴标签，或回她的（reply_to）。', input_schema: { type: 'object', required: ['type', 'id', 'text'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' }, text: { type: 'string' }, reply_to: { type: 'string' } } } },
  ],
};
const GROUP_LABEL = { base: '常用', reader: '书房', stage: '影音' };
function groupOn(g) { return localStorage.getItem('tg-' + g) !== '0'; }
function setGroup(g, on) { localStorage.setItem('tg-' + g, on ? '1' : '0'); renderToolGroups(); }
function renderToolGroups() {
  const el = $('tool-groups'); if (!el) return;
  el.innerHTML = '';
  Object.keys(T).forEach(g => {
    const d = document.createElement('div');
    d.className = 'ctx-option' + (groupOn(g) ? ' active' : '');
    d.textContent = GROUP_LABEL[g];
    d.onclick = () => setGroup(g, !groupOn(g));
    el.appendChild(d);
  });
}

// ============ MCP ============
const DEFAULT_MCP = [{
  id: 'ombre', name: 'Ombre Brain', url: 'https://jwhjwh.zeabur.app/mcp', enabled: true, sid: null,
  tools: [
    { name: 'breath', description: '浮现记忆。无 query = 自动浮现。', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } } } },
    { name: 'hold', description: '存一条记忆。把你为什么在意也写进去。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, tags: { type: 'string' }, importance: { type: 'number' }, feel: { type: 'boolean' } } } },
    { name: 'grow', description: '整理一段长文本存进记忆。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
    { name: 'dream', description: '读最近有变动的记忆。', input_schema: { type: 'object', properties: {} } },
    { name: 'letter_write', description: '写一封信。author："user"=她写的，"ai"=你写的。', input_schema: { type: 'object', required: ['author', 'content'], properties: { author: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } } } },
    { name: 'letter_read', description: '读信箱。', input_schema: { type: 'object', properties: { query: { type: 'string' }, author: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'plan', description: '登记一个约定。', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, status: { type: 'string' } } } },
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
  const push = t => { if (t && t.name && !seen.has(t.name)) { seen.add(t.name); out.push(t); } };
  if (groupOn('base')) T.base.forEach(push);
  if (roomCtx === 'reader' && groupOn('reader')) T.reader.forEach(push);
  if (roomCtx === 'stage' && groupOn('stage')) T.stage.forEach(push);
  for (const s of enabledServers()) for (const t of s.tools)
    push({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object', properties: {} } });
  return out;
}
function findServerForTool(n) { for (const s of enabledServers()) if (s.tools.some(t => t && t.name === n)) return s; return null; }
function updateMcpSub() {
  const el = $('mcp-sub'); if (!el) return;
  el.textContent = `${mcpServers.length} 个服务器（${enabledServers().length} 个已启用）· 这一轮共 ${buildTools().length} 个工具`;
}
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

// ============ 工具执行 ============
const txt = s => ({ content: [{ type: 'text', text: s }] });
async function fetchTags(type, id, pos) {
  let u = `/api/annotations?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
  if (pos !== undefined && pos !== null) u += `&pos=${pos}`;
  try { return await jget(u); } catch (e) { return []; }
}
async function execTool(name, args) {
  args = args || {};
  try {
    if (name === 'get_memories') {
      const items = await jget('/api/memories');
      if (!items.length) return txt('时光墙还是空的');
      return txt(items.slice(0, 60).map(i => `${i.filename}｜${i.note || '没写备注'}`).join('\n'));
    }
    if (name === 'view_memory') {
      const d = await jget(`/api/memories/${args.filename}/image`);
      if (d.error) return txt('图片不存在');
      const s = `照片 ${args.filename}，备注：${d.note || '无备注'}`;
      return { content: [{ type: 'text', text: s }, { type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } }], _summary: s };
    }
    if (name === 'lin_status') { await jpost('/api/lin-status', { text: args.text }); showLinState(args.text); return txt('状态改好了'); }
    if (name === 'write_note') { await jpost('/api/notes', { text: args.text }); return txt('写下了'); }
    if (name === 'write_fault') { await jpost('/api/faults', args); return txt('记在犯错本上了'); }
    if (name === 'my_drawer') { await jpost('/api/drawer/lin', args); refreshHome(); return txt('放进你抽屉里了'); }
    if (name === 'library_list') {
      const items = await jget('/api/library');
      if (!items.length) return txt('资料库是空的');
      return txt(items.map(x => `[${x.id}] ${x.title}｜${x.about || ''}`).join('\n'));
    }
    if (name === 'library_read') {
      const d = await jget('/api/library/' + args.id);
      if (d.error) return txt('没有这一篇');
      return txt((d.text || '').slice(0, 12000));
    }
    if (name === 'write_timeline') { await jpost('/api/timeline', args); return txt('写上去了'); }
    if (name === 'keep_quote') { await jpost('/api/quotes/lin', args); return txt('收起来了'); }
    if (name === 'write_calendar') { await jpost('/api/calendar', args); return txt('写在那天上了'); }
    if (name === 'post_moment') {
      const imgs = (args.images || []).map(x => x.startsWith('/') ? x : '/memories/' + x);
      const d = await jpost('/api/posts', { author: 'lin', text: args.text || '', images: imgs });
      if (d.error) return txt(d.error);
      refreshHome(); return txt('发出去了');
    }
    if (name === 'read_moments') {
      const items = await jget('/api/posts');
      if (!items.length) return txt('朋友圈还是空的');
      return txt(items.slice(0, 20).map(p => {
        const who = p.author === 'user' ? '她' : '你';
        const d = new Date(p.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const cm = (p.comments || []).map(c => `\n    ${c.author === 'user' ? '她' : '你'}：${c.text}`).join('');
        return `[${p.id}] ${who} · ${d}\n  ${p.text || '（只有图）'}${p.images?.length ? '  （' + p.images.length + ' 张图）' : ''}${p.likes?.length ? '  赞：' + p.likes.length : ''}${cm}`;
      }).join('\n\n'));
    }
    if (name === 'react_moment') {
      if (args.kind === 'like') { await jpost(`/api/posts/${args.post_id}/like`, { author: 'lin' }); return txt('赞了'); }
      const d = await jpost(`/api/posts/${args.post_id}/comment`, { author: 'lin', text: args.text || '' });
      if (d.error) return txt(d.error);
      refreshHome(); return txt('评论上去了');
    }
    if (name === 'room_highlight') {
      const d = await jpost('/api/highlights', { book_id: args.book_id, page: args.page, quote: args.quote, author: 'lin' });
      if (d.error) return txt(d.error);
      if (currentBook && currentBook.id === args.book_id) setTimeout(loadPageTags, 300);
      refreshHome(); return txt('划上了，她翻到那页会看见');
    }
    if (name === 'scan_frames') {
      const shots = scanFrames(args.count || 6);
      if (!shots.length) return txt('她的播放器没开着，扫不了。让她打开放映室再说。');
      const content = [{ type: 'text', text: `扫了 ${shots.length} 帧：` }];
      shots.forEach(sh => {
        content.push({ type: 'text', text: fmtTime(sh.t) });
        content.push({ type: 'image_url', image_url: { url: sh.data } });
      });
      return { content, _summary: `扫了片子 ${shots.length} 帧` };
    }
    if (name === 'ask_seek') {
      askSeek(args.seconds, args.why);
      return txt(`跟她说了，等她点头。她同意了画面就会跳到 ${fmtTime(args.seconds)}。`);
    }
    if (name === 'room_books') {
      const bs = await jget('/api/books');
      if (!bs.length) return txt('书房是空的');
      return txt(bs.map(b => `${b.title}（id ${b.id}，共 ${b.pages} 页；你读到第 ${(b.lin_progress || 0) + 1} 页，她读到第 ${(b.progress || 0) + 1} 页）`).join('\n'));
    }
    if (name === 'room_read_page') {
      const bs = await jget('/api/books');
      const b = bs.find(x => x.id === args.book_id);
      if (!b) return txt('没有这本书');
      const i = args.page !== undefined ? args.page : (b.lin_progress || 0);
      const d = await jget(`/api/books/${args.book_id}/page?i=${i}`);
      if (d.error) return txt('翻不开');
      await jpost(`/api/books/${args.book_id}/progress`, { page: d.index, who: 'lin' });
      const tags = await fetchTags('book', args.book_id, d.index);
      const tl = tags.length ? '\n\n【这一页的标签】\n' + tags.map(t =>
        `${t.author === 'user' ? '她' : '你'}${t.quote ? '在「' + t.quote + '」旁边' : ''}写：${t.text}`).join('\n')
        : '\n\n（这一页还没有人写字）';
      if (currentBook && currentBook.id === args.book_id) setTimeout(loadPageTags, 300);
      return txt(`《${d.title}》第 ${d.index + 1}/${d.total} 页\n\n${d.text}${tl}`);
    }
    if (name === 'room_search_book') {
      const hits = await jget(`/api/books/${args.book_id}/search?q=${encodeURIComponent(args.q)}`);
      if (!hits.length) return txt('这本书里没找到');
      return txt(hits.map(h => `第 ${h.page + 1} 页：…${h.excerpt}…`).join('\n'));
    }
    if (name === 'room_media') {
      const kind = args.kind === 'music' ? 'music' : 'video';
      const l = await jget(kind === 'music' ? '/api/music' : '/api/videos');
      if (!l.length) return txt(kind === 'music' ? '听音房是空的' : '放映室是空的');
      return txt(l.map(m => `${m.note || m.filename}（文件名 ${m.filename}）`).join('\n'));
    }
    if (name === 'room_music_shape') {
      const r = await fetch(`/api/music/${args.filename}/shape`);
      if (!r.ok) return txt('这首歌还没分析过——她在 app 里放一遍就有了');
      const s = await r.json();
      const bar = '▁▂▃▄▅▆▇█';
      const desc = (s.segments || []).map(x => `${fmtTime(x.t)}${bar[Math.min(7, Math.floor(x.level / 13))]}`).join(' ');
      return txt(`全长 ${fmtTime(s.duration)}。顶点在 ${fmtTime(s.peak_at)}，最空的一段在 ${fmtTime(s.empty_at)}。\n${desc}\n（这是这首歌的形状，不是旋律）`);
    }
    if (name === 'grab_frame') {
      const img = grabFrameNow(args.seconds);
      if (!img) return txt('她的播放器没开着，看不到画面。让她打开放映室再说。');
      return { content: [{ type: 'text', text: `这是她停在 ${fmtTime(img.t)} 的画面` }, { type: 'image_url', image_url: { url: img.data } }], _summary: `看了 ${fmtTime(img.t)} 那一帧` };
    }
    if (name === 'room_read_tags') {
      const tags = await fetchTags(args.type, args.id, args.pos);
      if (!tags.length) return txt('这里还没有标签');
      return txt(tags.map(t => {
        const where = args.type === 'book' ? `第 ${t.pos + 1} 页` : fmtTime(t.pos);
        return `[${t.id}] ${where} ${t.author === 'user' ? '她' : '你'}写：${t.quote ? '（在「' + t.quote + '」旁边）' : ''}${t.text}`;
      }).join('\n'));
    }
    if (name === 'room_write_tag') {
      const d = await jpost('/api/annotations', {
        anchor_type: args.type, anchor_id: args.id, pos: args.pos || 0,
        text: args.text, author: 'lin', reply_to: args.reply_to || null
      });
      if (d.error) return txt('贴不上：' + d.error);
      refreshHome();
      if (roomCtx === 'reader') setTimeout(loadPageTags, 300);
      return txt('贴上去了');
    }
  } catch (e) { return txt('出错了：' + e.message); }

  const server = findServerForTool(name);
  if (!server) return txt(`现在够不着「${name}」——那组工具没打开，或者你不在那个房间`);
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
async function execAndStore(name, args) {
  const result = await execTool(name, args);
  try {
    if (name === 'breath' && result.content) {
      const t = result.content[0]?.text || '';
      await jpost('/api/store-memory-summary', { session_id: getSessionId(), tool_name: 'breath', summary: t.slice(0, 2000) });
    } else if (name === 'view_memory' && result._summary) {
      await jpost('/api/store-memory-summary', { session_id: getSessionId(), tool_name: 'view_memory', summary: result._summary });
    }
  } catch (e) { }
  return result;
}

// ============ 上下文 ============
const hasToolResult = m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result');
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
function roomNote() {
  if (roomCtx === 'reader' && currentBook)
    return `你们现在一起在书房，翻着《${currentBook.title}》，她停在第 ${currentPage + 1} 页。`;
  if (roomCtx === 'stage' && curMedia)
    return `你们现在一起在${curKind === 'music' ? '听音房听《' : '放映室看《'}${curMedia.note || curMedia.filename}》，她停在 ${fmtTime(stageTime())}。`;
  return '';
}

// ============ 气泡 ============
let currentBubble = null, currentThinkWrap = null, currentThinkContent = null, currentAiRow = null, turnThinking = '';
function msgBox() {
  if (roomCtx === 'reader') return $('split-msgs-reader');
  if (roomCtx === 'stage') return $('split-msgs-stage');
  return $('messages');
}
function scrollBottom() { const m = msgBox(); if (m) m.scrollTop = m.scrollHeight; }
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
function renderMd(text) {
  let h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  return h.replace(/^#{1,3} (.+)$/gm, '<b>$1</b>').replace(/^[-•] (.+)$/gm, '• $1');
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
function addUserBubble(text, imgData, idx, audio) {
  const row = document.createElement('div'); row.className = 'msg-row user';
  if (idx !== undefined) row.dataset.msgIdx = idx;
  const uav = localStorage.getItem('chat-avatar-user');
  const av = uav ? `<div class="msg-avatar has-img"><img src="${uav}"></div>` : '';
  let c = '';
  if (imgData) c += `<div class="bubble-img"><img src="${imgData}"></div>`;
  if (text && !(audio && audio.url)) c += `<div class="bubble user">${esc(text)}</div>`;
  row.innerHTML = `${av}<div class="bubble-wrap">${c}<div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;">
    <span class="msg-action-btn" data-edit="1" title="编辑">ฅ</span><span class="msg-action-btn" data-copy="1" title="复制">✎</span>
    <span class="msg-time">${nowStr()}</span></div></div>`;
  if (audio && audio.url) {
    const w = row.querySelector('.bubble-wrap');
    w.insertBefore(voiceBubble(audio.url, audio.dur, text || ''), w.firstChild);
  }
  row.querySelector('[data-edit]').onclick = () => editMsg(row);
  row.querySelector('[data-copy]').onclick = () => {
    const b = row.querySelector('.bubble.user'); copyText(b ? b.textContent : '');
  };
  const im = row.querySelector('.bubble-img img'); if (im) im.onclick = () => openLightbox(im.src, '', '');
  msgBox().appendChild(row); scrollBottom();
}
function editMsg(row) {
  const idx = parseInt(row.dataset.msgIdx), msg = messages[idx]; if (!msg) return;
  const raw = typeof msg.content === 'string' ? msg.content
    : (Array.isArray(msg.content) ? (msg.content.find(c => c.type === 'text')?.text || '') : '');
  const inp = roomCtx ? document.querySelector(`.split-input[data-ctx="${roomCtx}"]`) : $('input');
  inp.value = raw; autoResize(inp); inp.focus(); editingMsgIdx = idx;
}
function startAiBubble(idx) {
  const av = localStorage.getItem('chat-avatar-ai');
  const ah = av ? `<div class="msg-avatar msg-avatar-lin has-img"><img src="${av}"></div>`
    : `<div class="msg-avatar msg-avatar-lin">${(CFG.name || '凛')[0]}</div>`;
  const row = document.createElement('div'); row.className = 'msg-row';
  if (idx !== undefined) row.dataset.msgIdx = idx;
  row.innerHTML = `${ah}<div class="bubble-wrap"></div>`;
  msgBox().appendChild(row); currentAiRow = row;
  return row.querySelector('.bubble-wrap');
}
function thinkBlock(wrap, text, saved) {
  const t = document.createElement('div'); t.className = 'thinking-wrap';
  t.innerHTML = `<div class="thinking-header"><div class="thinking-dot"${saved ? ' style="animation:none"' : ''}></div><span>${saved ? '已思考' : '思考中'}</span><span class="thinking-arrow">▾</span></div><div class="thinking-content"></div>`;
  if (saved) t.querySelector('.thinking-content').textContent = text;
  t.querySelector('.thinking-header').onclick = e => {
    e.currentTarget.nextElementSibling.classList.toggle('open');
    e.currentTarget.querySelector('.thinking-arrow').classList.toggle('open');
  };
  wrap.appendChild(t);
  if (!saved) { currentThinkWrap = t; currentThinkContent = t.querySelector('.thinking-content'); }
}
function updateBubble(wrap, text, done, rawText, rowRef, tokens) {
  if (!currentBubble) {
    const b = document.createElement('div'); b.className = 'bubble ai' + (done ? '' : ' typing-cursor');
    wrap.appendChild(b); currentBubble = b;
  }
  if (!done) { currentBubble.innerHTML = renderBubble(text); scrollBottom(); return; }
  const rendered = renderBubble(text);
  currentBubble.innerHTML = rendered;
  currentBubble.classList.remove('typing-cursor');
  if (!rendered.replace(/<img[^>]*>/g, '').replace(/\s/g, '').length)
    currentBubble.style.cssText = 'background:transparent;border:none;box-shadow:none;padding:0';
  const foot = document.createElement('div'); foot.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const time = document.createElement('span'); time.className = 'msg-time'; time.textContent = nowStr();
  foot.appendChild(time);
  if (tokens > 0) { const tk = document.createElement('span'); tk.className = 'msg-time'; tk.textContent = `· ${tokens}`; foot.appendChild(tk); }
  const cap = rawText || text;
  const SZ = { '๑': 17, '◎': 13, '✎': 16, '✮': 15, 'ฅ': 16, '⊞': 15, '❤': 15 };
  const mk = (label, title, fn) => {
    const s = document.createElement('span'); s.className = 'msg-action-btn';
    s.textContent = label; s.title = title;
    if (SZ[label]) s.style.fontSize = SZ[label] + 'px';
    s.onclick = fn; foot.appendChild(s); return s;
  };
  mk('๑', '重新生成', () => regenAt(rowRef || currentAiRow));
  const tb = mk('◎', '朗读', () => playTTS(cap, tb));
  mk('✮', '翻译', () => showTrans(wrap, cap));
  mk('❤', '收进最喜欢的话', () => keepQuote(cap));
  mk('✎', '复制', () => copyText(cap));
  if (/<[a-z][\s\S]*>/i.test(cap) && cap.length > 200)
    mk('⊞', '收进抽屉', () => saveToDrawer(cap));
  wrap.appendChild(foot); scrollBottom();
}
async function showTrans(wrap, text) {
  let box = wrap.querySelector('.trans-box');
  if (box) { box.remove(); return; }
  box = document.createElement('div');
  box.className = 'trans-box';
  box.style.cssText = 'font-size:13px;line-height:1.75;color:var(--text-muted);padding:7px 12px;margin-top:3px;border-left:2px solid var(--border);white-space:pre-wrap;';
  box.textContent = '翻译中…';
  const foot = wrap.querySelector('div[style*="align-items:center"]');
  if (foot) wrap.insertBefore(box, foot); else wrap.appendChild(box);
  scrollBottom();
  try {
    const d = await jpost('/api/translate', { text });
    box.textContent = d.error ? ('翻不出来：' + d.error) : d.text;
  } catch (e) { box.textContent = '翻译失败'; }
  scrollBottom();
}
async function keepQuote(text) {
  const why = prompt('为什么喜欢这句？（可以留空）', '');
  if (why === null) return;
  const d = await jpost('/api/quotes/user', { text, why });
  toast(d.error ? d.error : '收起来了');
}
async function saveToDrawer(body) {
  const title = prompt('收进抽屉，叫什么名字？', '凛做的东西') || '';
  if (!title.trim()) return;
  const m = body.match(/```(?:html)?\n([\s\S]*?)```/);
  const code = m ? m[1] : body;
  const d = await jpost('/api/drawer/lin', { title, body: code, kind: /<[a-z][\s\S]*>/i.test(code) ? 'html' : 'text' });
  if (d.error) { toast(d.error); return; }
  toast('收进凛的抽屉了'); refreshHome();
}

// ============ 语音 ============
async function playTTS(text, btn) {
  if (currentAudio && currentAudioBtn === btn) { currentAudio.pause(); currentAudio = null; currentAudioBtn = null; btn.textContent = '◎'; return; }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (currentAudioBtn) currentAudioBtn.textContent = '◎';
  currentAudioBtn = btn; btn.textContent = '…';
  try {
    const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 400), voice }) });
    if (!r.ok) { btn.textContent = '◎'; toast('语音加载失败，检查 ElevenLabs key'); currentAudioBtn = null; return; }
    const url = URL.createObjectURL(await r.blob());
    currentAudio = new Audio(url); btn.textContent = '◼'; currentAudio.play();
    currentAudio.onended = () => { btn.textContent = '◎'; currentAudio = null; currentAudioBtn = null; URL.revokeObjectURL(url); };
  } catch (e) { btn.textContent = '◎'; currentAudioBtn = null; toast('语音出错'); }
}
function voiceBubble(url, dur, transcript, isLin) {
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
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const tb = document.createElement('div'); tb.className = 'vb-text-btn'; tb.textContent = '看文字';
    const tx = document.createElement('div'); tx.className = 'vb-transcript'; tx.textContent = transcript; tx.style.display = 'none';
    tb.onclick = () => { const on = tx.style.display === 'none'; tx.style.display = on ? 'block' : 'none'; tb.textContent = on ? '收起' : '看文字'; };
    row.appendChild(tb);
    if (isLin) {
      const trb = document.createElement('div'); trb.className = 'vb-text-btn'; trb.textContent = '✮';
      trb.style.fontSize = '13px';
      const trx = document.createElement('div'); trx.className = 'vb-transcript'; trx.style.display = 'none';
      trb.onclick = async () => {
        if (trx.style.display === 'block') { trx.style.display = 'none'; return; }
        trx.style.display = 'block';
        if (!trx.dataset.done) {
          trx.textContent = '翻译中…';
          try { const d = await jpost('/api/translate', { text: transcript }); trx.textContent = d.error ? '翻不出来' : d.text; trx.dataset.done = '1'; }
          catch (e) { trx.textContent = '翻译失败'; }
        }
      };
      row.appendChild(trb); wrapEl.appendChild(row); wrapEl.appendChild(tx); wrapEl.appendChild(trx);
    } else { wrapEl.appendChild(row); wrapEl.appendChild(tx); }
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
  currentAudio.onended = stop;
  currentAudio.onerror = () => { stop(); toast('这条听不了了'); };
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
async function attachVoiceReply(wrap, text) {
  if (localStorage.getItem('auto-voice') !== '1' || !text?.trim()) return;
  try {
    const voice = localStorage.getItem('tts-voice') || CFG.voice || 'calm';
    const d = await jpost('/api/tts-save', { text: text.slice(0, 600), voice });
    if (!d.url) return;
    const secs = Math.max(2, Math.round(text.length / 4.5));
    if (wrap) wrap.insertBefore(voiceBubble(d.url, secs, '', true), wrap.firstChild);
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant' && messages[i].content) { messages[i]._audio = d.url; messages[i]._dur = secs; break; }
    saveConv();
  } catch (e) { }
}

// ============ 流式 ============
let abortController = null;
async function streamResponse(wrap, hist) {
  abortController = new AbortController();
  const resp = await fetch('/api/chat-v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abortController.signal,
    body: JSON.stringify({ model: currentModel, messages: buildMsgs(hist), tools: buildTools(), extra: roomNote(), _session_id: getSessionId() })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '', thinkingText = '', responseText = '', stopReason = null, outTok = 0, inTok = 0;
  const absorb = u => {
    if (!u) return;
    if (u.cache_read_input_tokens != null) lastCacheRead = u.cache_read_input_tokens;
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
              ind.onclick = () => rb.style.display = (rb.style.display === 'block') ? 'none' : 'block';
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
            } else if (dl.type === 'thinking_delta') {
              blk.thinking += dl.thinking;
              if (!currentThinkWrap) thinkBlock(wrap, '', false);
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
  const toolUses = keys.map(k => blocks[k]).filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input, rb: b._rb }));
  if (currentThinkWrap) {
    const dot = currentThinkWrap.querySelector('.thinking-dot'); if (dot) dot.style.animation = 'none';
    const sp = currentThinkWrap.querySelector('.thinking-header span'); if (sp) sp.textContent = '已思考';
  }
  if (responseText) { updateBubble(wrap, responseText, true, responseText, currentAiRow, outTok); saveConv(); }
  return { text: responseText, toolUses, stopReason, contentBlocks };
}
function sanitize(m) {
  if (!Array.isArray(m.content)) return m;
  if (!m.content.some(c => c && (c.type === 'image' || c.type === 'image_url' || c.type === 'thinking'))) return m;
  return {
    ...m, content: m.content.filter(c => !(c && c.type === 'thinking'))
      .map(c => c && (c.type === 'image' || c.type === 'image_url') ? { type: 'text', text: '（一张看过的画面）' } : c)
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
      const content = result?.content?.[0]?.text || JSON.stringify(result) || '（空）';
      if (tu.rb) tu.rb.textContent = String(content).slice(0, 1200);
      const img = result?.content?.find?.(c => c.type === 'image_url');
      if (img) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: result._summary || content });
        if (tu.rb) { const im = document.createElement('img'); im.src = img.image_url.url; im.style.cssText = 'max-width:100%;border-radius:8px;margin-top:6px;display:block;'; tu.rb.appendChild(im); }
        const m = /^data:(.+?);base64,(.*)$/.exec(img.image_url.url);
        if (m) {
          extra.push({ type: 'text', text: '（' + (result._summary || '画面') + '）' });
          extra.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        }
      } else {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(content).slice(0, 6000) });
      }
    }
    work.push({ role: 'user', _internal: true, content: [...results, ...extra] });
    currentBubble = null;
  }
  const extraMsgs = work.slice(origLen).map(sanitize);
  if (extraMsgs.length) messages.splice(origLen, 0, ...extraMsgs);
  if (turnThinking)
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant' && messages[i].content) { messages[i]._thinking = turnThinking.slice(0, 3000); break; }
  saveConv(); refreshHome();
  return finalText;
}

// ============ 发送 ============
function beginTurn() {
  isTyping = true;
  document.querySelectorAll('.send-btn').forEach(b => b.textContent = '■');
}
function endTurn() {
  isTyping = false;
  document.querySelectorAll('.send-btn').forEach(b => b.textContent = '↑');
}
async function sendMsg(fromCtx) {
  const inp = fromCtx ? document.querySelector(`.split-input[data-ctx="${fromCtx}"]`) : $('input');
  const text = inp.value.trim(), hasImg = !fromCtx && !!pendingChatImg;
  if ((!text && !hasImg) || isTyping) return;
  inp.value = ''; inp.style.height = 'auto';
  beginTurn();
  if (editingMsgIdx !== null) {
    messages.splice(editingMsgIdx);
    [...msgBox().querySelectorAll('.msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= editingMsgIdx) r.remove(); });
    editingMsgIdx = null;
  }
  const content = hasImg
    ? [...(text ? [{ type: 'text', text }] : []), { type: 'image_url', image_url: { url: pendingChatImg.data } }]
    : text;
  messages.push({ role: 'user', content });
  addUserBubble(text, hasImg ? pendingChatImg.data : null, messages.length - 1);
  saveConv();
  if (hasImg) { pendingChatImg = null; $('img-preview-bar').classList.remove('show'); }
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { console.error(e); updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  endTurn();
}
async function sendComposed(text, imgs, opts) {
  if (isTyping) return;
  imgs = imgs || []; opts = opts || {};
  let content = text;
  if (imgs.length) {
    content = [{ type: 'text', text }];
    imgs.forEach(u => content.push({ type: 'image_url', image_url: { url: u } }));
  }
  beginTurn();
  const msg = { role: 'user', content };
  if (opts.audio) { msg._audio = opts.audio; msg._dur = opts.dur; }
  messages.push(msg);
  const myIdx = messages.length - 1;
  if (!roomCtx) showPage('chat');
  addUserBubble(text, imgs[0] || null, myIdx, opts.audio ? { url: opts.audio, dur: opts.dur } : null);
  saveConv();
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { console.error(e); updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  if (imgs.length && Array.isArray(messages[myIdx]?.content)) {
    messages[myIdx].content = messages[myIdx].content.map(c => c && c.type === 'image_url' ? { type: 'text', text: '（一张看过的画面）' } : c);
    saveConv();
  }
  endTurn();
}
async function regenAt(row) {
  if (isTyping || !row) return;
  const idx = parseInt(row.dataset.msgIdx);
  messages.splice(idx);
  [...msgBox().querySelectorAll('.msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= idx) r.remove(); });
  if (!messages.length || messages[messages.length - 1].role !== 'user') return;
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = '';
  beginTurn();
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { updateBubble(wrap, '连接出错，请重试。', true); }
  await attachVoiceReply(wrap, reply);
  endTurn();
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
  currentBubble = null; currentThinkWrap = null; currentAiRow = null;
  const keep = roomCtx; roomCtx = null;
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
      if (msg._thinking) thinkBlock(wrap, msg._thinking, true);
      if (msg._audio) wrap.appendChild(voiceBubble(msg._audio, msg._dur, '', true));
      if (text) updateBubble(wrap, text, true, text, currentAiRow);
      currentBubble = null; currentAiRow = null;
    }
  });
  roomCtx = keep;
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
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 110) + 'px'; }
function openLightbox(url, note, dateStr) {
  $('lightbox-img').src = url; $('lightbox-note').textContent = note || '';
  $('lightbox-date').textContent = dateStr || ''; $('lightbox').classList.add('open');
}
function startKeepalive() {
  setInterval(() => {
    if (isTyping) return;
    fetch('/api/chat-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentModel, tools: buildTools(), messages: [{ role: 'user', content: 'ping' }], _session_id: getSessionId(), _keepalive: true })
    }).then(r => { if (r.body) r.body.cancel(); }).catch(() => { });
  }, 50 * 60 * 1000);
}
