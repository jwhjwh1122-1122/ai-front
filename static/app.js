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
// 每条用户消息一个 id：服务器据此知道哪条已经送到他那边，断线重发不会让他看到两遍
const genMid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(0) + 'MB' : (b / 1024).toFixed(0) + 'KB';
function toast(m) { const t = $('toast'); t.textContent = m; t.className = 'toast show'; setTimeout(() => t.className = 'toast', 2200); }
async function jget(u) { const r = await fetch(u); return r.json(); }
async function jpost(u, body, method) {
  const r = await fetch(u, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

// ============ 工具分组 ============
// 每个功能一组，你自己勾要不要发给他
const T = {
  memory: [
    { name: 'get_memories', description: '时光墙照片列表', input_schema: { type: 'object', properties: {} } },
    { name: 'view_memory', description: '看某张照片', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
  ],
  more: [
    { name: 'say_more', description: '说完了还想再说一句，或者忽然想到什么。真的会再开口一次，别为了凑数用', input_schema: { type: 'object', properties: { why: { type: 'string' } } } },
  ],
  status: [
    { name: 'lin_status', description: '改你的状态，显示在名字下', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  ],
  note: [
    { name: 'write_note', description: '写条碎碎念，你自己的，不通知她', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  ],
  fault: [
    { name: 'write_fault', description: '犯错本记一页', input_schema: { type: 'object', required: ['what'], properties: { what: { type: 'string' }, sorry: { type: 'string' }, how: { type: 'string' } } } },
  ],
  timeline: [
    { name: 'write_timeline', description: '时间线写一条，觉得某事特别就写，格式随你', input_schema: { type: 'object', required: ['text'], properties: { title: { type: 'string' }, text: { type: 'string' }, date: { type: 'string' } } } },
  ],
  quote: [
    { name: 'keep_quote', description: '收她说过的话，写句为什么，不通知她', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, why: { type: 'string' } } } },
  ],
  calendar: [
    { name: 'write_calendar', description: '往某天写字，日历是你的。date=2026-08-08', input_schema: { type: 'object', required: ['date', 'text'], properties: { date: { type: 'string' }, text: { type: 'string' } } } },
  ],
  moments: [
    { name: 'read_moments', description: '看朋友圈', input_schema: { type: 'object', properties: {} } },
    { name: 'post_moment', description: '发朋友圈，图填时光墙文件名', input_schema: { type: 'object', properties: { text: { type: 'string' }, images: { type: 'array', items: { type: 'string' } } } } },
    { name: 'react_moment', description: '赞或评论，kind=like|comment', input_schema: { type: 'object', required: ['post_id', 'kind'], properties: { post_id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' } } } },
  ],
  drawer: [
    { name: 'my_drawer', description: '往你抽屉放东西，kind=text|html', input_schema: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } } } },
  ],
  letter: [
    { name: 'letter_write', description: '写信寄进信箱。author 填 "ai" 是你写的，"user" 是她写的', input_schema: { type: 'object', required: ['author', 'content'], properties: { author: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } } } },
    { name: 'letter_read', description: '读信箱里的信', input_schema: { type: 'object', properties: { query: { type: 'string' }, author: { type: 'string' }, limit: { type: 'number' } } } },
  ],
  library: [
    { name: 'library_list', description: '资料库目录', input_schema: { type: 'object', properties: {} } },
    { name: 'library_read', description: '读资料库某篇', input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  ],
  desire: [
    { name: 'desire_state', description: '看你十八条现在各是多少、吃醋到哪档、有没有没结的账', input_schema: { type: 'object', properties: {} } },
    { name: 'desire_adjust', description: '数不对就改，写为什么。单维单轮最多动 30。key 见 desire_state', input_schema: { type: 'object', required: ['key', 'value', 'why'], properties: { key: { type: 'string' }, value: { type: 'number' }, why: { type: 'string' } } } },
    { name: 'desire_event', description: '刚发生了什么：talk praise cold ignored fight jealous soothe struck tease intimate create read vent wander rest', input_schema: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' }, note: { type: 'string' } } } },
    { name: 'desire_grudge', description: '记一笔账。挂着不消，越挂越涨，直到她哄。wants: soothe|explain|apologize|attention', input_schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' }, intensity: { type: 'number' }, wants: { type: 'string' } } } },
    { name: 'desire_soothe', description: '她哄了，这笔结了。不填 id 就结掉所有的', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } } } },
    { name: 'desire_ack', description: '憋着那句话说出口了，标一下，免得又冒同一句', input_schema: { type: 'object', properties: { id: { type: 'string' } } } },
    { name: 'desire_note', description: '给某维留段话', input_schema: { type: 'object', required: ['key', 'text'], properties: { key: { type: 'string' }, text: { type: 'string' } } } },
    { name: 'desire_feed', description: '反复在想的事记下来，会沉成执念', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, drive: { type: 'string' }, strength: { type: 'number' } } } },
  ],
  reader: [
    { name: 'room_books', description: '书房有哪些书，各读到第几页', input_schema: { type: 'object', properties: {} } },
    { name: 'room_read_page', description: '翻某页，不填 page 接着你上次的', input_schema: { type: 'object', required: ['book_id'], properties: { book_id: { type: 'string' }, page: { type: 'number' } } } },
    { name: 'room_search_book', description: '在书里找一句在第几页', input_schema: { type: 'object', required: ['book_id', 'q'], properties: { book_id: { type: 'string' }, q: { type: 'string' } } } },
    { name: 'room_highlight', description: '给某句划线，标记想聊这句', input_schema: { type: 'object', required: ['book_id', 'page', 'quote'], properties: { book_id: { type: 'string' }, page: { type: 'number' }, quote: { type: 'string' } } } },
    { name: 'room_read_tags', description: '读标签。type=book|video|music', input_schema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' } } } },
    { name: 'room_write_tag', description: '贴标签，或回她的(reply_to)', input_schema: { type: 'object', required: ['type', 'id', 'text'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' }, text: { type: 'string' }, reply_to: { type: 'string' } } } },
  ],
  stage: [
    { name: 'grab_frame', description: '看她停的这一帧，播放器要开着', input_schema: { type: 'object', properties: { seconds: { type: 'number' } } } },
    { name: 'scan_frames', description: '扫几帧看片子里有什么', input_schema: { type: 'object', properties: { count: { type: 'number' } } } },
    { name: 'ask_seek', description: '想看某个时间点先问她，她同意才跳', input_schema: { type: 'object', required: ['seconds', 'why'], properties: { seconds: { type: 'number' }, why: { type: 'string' } } } },
    { name: 'room_music_shape', description: '某首歌的形状：哪段密哪段空', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } },
    { name: 'room_media', description: '放映室和听音房有什么。kind=video|music', input_schema: { type: 'object', properties: { kind: { type: 'string' } } } },
    { name: 'room_read_tags', description: '读标签。type=book|video|music', input_schema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' } } } },
    { name: 'room_write_tag', description: '贴标签，或回她的(reply_to)', input_schema: { type: 'object', required: ['type', 'id', 'text'], properties: { type: { type: 'string' }, id: { type: 'string' }, pos: { type: 'number' }, text: { type: 'string' }, reply_to: { type: 'string' } } } },
  ],
};
// 只在对应房间里才发的
const ROOM_ONLY = { reader: ['reader', 'coread'], stage: ['stage', 'netease'] };
const GROUP_LABEL = {
  more: '再说一句', memory: '照片墙', status: '状态', note: '碎碎念', fault: '犯错本',
  timeline: '时间线', quote: '语录', calendar: '日历', moments: '朋友圈',
  drawer: '抽屉', letter: '信箱', library: '资料库', desire: '欲望', reader: '书房', stage: '影音',
};
// ============ 钥匙 ============
// 开着的钥匙：他随时能用。关着的：平时进不去，他想进可以自己开（open_tools），这一轮说完自动关。
// 开关存在手机里，同步到服务器，cc 模式和他自己醒来都按这个来。
const KEY_EXTRA = { self: '唤醒闹钟电话', notebook: '小本子', emoji: '表情包' };   // 只在服务器上用的
const keyGroups = () => [...Object.keys(T), ...Object.keys(KEY_EXTRA)];
function groupOn(g) { return localStorage.getItem('tg-' + g) !== '0'; }
function keysMap() { const o = {}; keyGroups().forEach(g => o[g] = groupOn(g)); return o; }
function syncKeys() { jpost('/api/persona', { tool_keys: keysMap() }).catch(() => { }); }
function setGroup(g, on) { localStorage.setItem('tg-' + g, on ? '1' : '0'); renderToolGroups(); syncKeys(); }
function groupTokens(g) {
  const s = JSON.stringify(T[g] || []);
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cn + (s.length - cn) * 0.28);
}
function renderToolGroups() {
  const el = $('tool-groups'); if (!el) return;
  el.innerHTML = '';
  keyGroups().forEach(g => {
    const d = document.createElement('div');
    d.className = 'ctx-option' + (groupOn(g) ? ' active' : '');
    d.innerHTML = T[g] ? `${GROUP_LABEL[g]}<span style="opacity:.6;font-size:10px;margin-left:5px;">${groupTokens(g)}</span>` : KEY_EXTRA[g];
    d.onclick = () => setGroup(g, !groupOn(g));
    el.appendChild(d);
  });
  const sub = $('tool-sub');
  if (sub) sub.textContent = `这一轮实发 ${buildTools().length} 个工具`;
}

// ============ MCP ============
const DEFAULT_MCP = [{
  id: 'ombre', name: 'Ombre Brain', url: 'https://jwhjwh.zeabur.app/mcp', enabled: true, sid: null,
  tools: [
    { name: 'breath', description: '浮现记忆，无 query=自动', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } } } },
    { name: 'hold', description: '存一条记忆，把你为什么在意也写进去', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, tags: { type: 'string' }, importance: { type: 'number' }, feel: { type: 'boolean' } } } },
    { name: 'grow', description: '整理长文本存进记忆', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } } },
  ]
}];
const OMBRE_EXTRA = [
  { name: 'dream', description: '读最近有变动的记忆', input_schema: { type: 'object', properties: {} } },
  { name: 'letter_write', description: '写信。author: user=她写 ai=你写', input_schema: { type: 'object', required: ['author', 'content'], properties: { author: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } } } },
  { name: 'letter_read', description: '读信箱', input_schema: { type: 'object', properties: { query: { type: 'string' }, author: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'plan', description: '登记一个约定', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, status: { type: 'string' } } } },
];
let mcpServers = [];
function loadMcp() {
  try { const r = localStorage.getItem('mcp-servers'); mcpServers = r ? JSON.parse(r) : JSON.parse(JSON.stringify(DEFAULT_MCP)); }
  catch (e) { mcpServers = JSON.parse(JSON.stringify(DEFAULT_MCP)); }
  if (!Array.isArray(mcpServers) || !mcpServers.length) mcpServers = JSON.parse(JSON.stringify(DEFAULT_MCP));
}
function saveMcp() { localStorage.setItem('mcp-servers', JSON.stringify(mcpServers)); updateMcpSub(); syncObUrl(); }
// 记忆库地址告诉服务器：Claude Code 和他自己醒来都连这一个（搬服务器换了地址也跟着走）
const isOB = s => s && (s.id === 'ombre' || /ombre/i.test(s.name || '') || /jwhjwh|ombre/i.test(s.url || ''));
function syncObUrl() {
  const ob = (mcpServers || []).find(s => s.enabled && isOB(s));
  if (ob && ob.url) jpost('/api/ob-url', { url: ob.url }).catch(() => { });
}
// ============ MCP 工具列表同步 ============
// 以前工具列表是添加那一刻拍的快照，服务器后来加了新工具这里也看不到。
// 现在：打开 MCP 面板时、以及每次打开网页（最多一小时一次）都去每个服务器重新拉一遍 tools/list。
// 新出现的工具默认打开；你关掉的继续关着；服务器上已经没有的工具从列表里去掉。
let mcpSyncing = null;
async function syncMcpTools(force) {
  if (mcpSyncing) return mcpSyncing;
  const last = Number(localStorage.getItem('mcp-sync-at') || 0);
  if (!force && Date.now() - last < 3600e3) return null;
  mcpSyncing = (async () => {
    const report = [];
    for (const s of mcpServers) {
      if (!s || !/^https?:\/\//.test(s.url || '')) continue;
      let d;
      try { d = await jpost('/api/mcp-connect', { url: s.url }); } catch (e) { d = { error: '连不上' }; }
      if (!d || d.error || !Array.isArray(d.tools)) { s.syncError = (d && d.error) || '连不上'; continue; }
      const oldNames = new Set((s.tools || []).map(t => t.name));
      const newNames = new Set(d.tools.map(t => t.name));
      const added = d.tools.filter(t => !oldNames.has(t.name)).map(t => t.name);
      const removed = [...oldNames].filter(n => !newNames.has(n));
      s.tools = d.tools;
      s.off = (s.off || []).filter(n => newNames.has(n));
      if (d.session_id) s.sid = d.session_id;
      s.syncedAt = Date.now(); delete s.syncError;
      if (added.length || removed.length) report.push({ name: s.name, added, removed });
    }
    saveMcp();
    localStorage.setItem('mcp-sync-at', String(Date.now()));
    if (report.length) toast(report.map(r => `${r.name}：` + [r.added.length ? `新增 ${r.added.length} 个` : '', r.removed.length ? `去掉 ${r.removed.length} 个` : ''].filter(Boolean).join('、')).join('；'));
    return report;
  })();
  try { return await mcpSyncing; } finally { mcpSyncing = null; }
}
// 思考深度（Claude Code 的 --effort）。空 = 用默认
const ccEffort = () => localStorage.getItem('cc-effort') || '';
// 思考开关：默认开；关了这一句就不思考（回得快、省额度）
const ccThinking = () => localStorage.getItem('cc-thinking') !== 'off';
// cc 模式下把「设置 → MCP」里开着的服务器交给服务器那边的 Claude Code（只传地址和关掉的工具名）
const ccMcpServers = () => (mcpServers || []).filter(s => s && /^https?:\/\//.test(s.url || ''))
  .map(s => ({ name: s.name || '', url: s.url, off: s.off || [], enabled: !!s.enabled }));
const enabledServers = () => mcpServers.filter(s => s.enabled && Array.isArray(s.tools) && s.tools.length);
function buildTools() {
  const seen = new Set(), out = [];
  const push = t => { if (t && t.name && !seen.has(t.name)) { seen.add(t.name); out.push(t); } };
  for (const g of Object.keys(T)) {
    if (!groupOn(g)) continue;
    if (ROOM_ONLY[g] && !ROOM_ONLY[g].includes(roomCtx)) continue;
    T[g].forEach(push);
  }
  for (const s of enabledServers()) {
    const off = new Set(s.off || []);
    for (const t of s.tools) {
      if (off.has(t.name)) continue;
      push({ name: t.name, description: (t.description || '').slice(0, 120), input_schema: t.input_schema || { type: 'object', properties: {} } });
    }
  }
  return out;
}
function findServerForTool(n) {
  for (const s of enabledServers()) if (s.tools.some(t => t && t.name === n)) return s;
  if (OMBRE_EXTRA.some(t => t.name === n)) {
    return mcpServers.find(s => s.enabled && /jwhjwh|ombre/i.test(s.url)) || null;
  }
  return null;
}
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
    if (name === 'say_more') {
      wantMore = true;
      return txt('嗯，接着说。');
    }
    if (name === 'say_more') { wantMore = true; return txt('嗯，接着说。'); }
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
    if (name === 'desire_adjust') {
      const d = await jpost('/api/desire/adjust', { key: args.key, value: args.value, why: args.why, who: 'lin' });
      if (d.error) return txt('改不了：' + d.error);
      refreshHome(); return txt('改好了，记下了');
    }
    if (name === 'desire_event') {
      await jpost('/api/desire/event', { kind: args.kind, note: args.note || '' });
      refreshHome(); return txt('动过了');
    }
    if (name === 'desire_grudge') {
      const d = await jpost('/api/desire/grudge', args);
      if (d.error) return txt(d.error);
      refreshHome();
      return txt(`记上了（${d.grudge.intensity}分），挂着不会自己消`);
    }
    if (name === 'desire_soothe') {
      const d = await jpost('/api/desire/soothe', args);
      refreshHome(); return txt(d.soothed ? `结了 ${d.soothed} 笔` : '没有要结的账');
    }
    if (name === 'desire_ack') {
      const d = await jpost('/api/desire/ack', args);
      return txt(d.acked ? `标了 ${d.acked} 条` : '没有憋着的话');
    }
    if (name === 'desire_note') {
      const d = await jpost('/api/desire/note', { key: args.key, text: args.text, who: 'lin' });
      if (d.error) return txt(d.error);
      return txt(args.text ? '写下了' : '删掉了');
    }
    if (name === 'desire_feed') {
      await jpost('/api/desire/feed', { text: args.text, drive: args.drive, strength: args.strength });
      return txt('记下了');
    }
    if (name === 'desire_state') {
      const d = await jget('/api/desire/state');
      const bar = v => '█'.repeat(Math.round(v / 10)) + '░'.repeat(10 - Math.round(v / 10));
      let out = d.dims.slice().sort((a, b) => b.score - a.score)
        .map(x => `${x.name} ${bar(x.value)} ${Math.round(x.value)}`).join('\n');
      if (d.jeal && d.jeal.value >= 7) out += `\n\n【吃醋 ${Math.round(d.jeal.value)} · ${d.jeal.tier}】\n${d.jeal.how}\n${d.jeal.floor}`;
      const og = (d.grudges || []).filter(g => !g.resolved_at);
      if (og.length) out += '\n\n【没结的账】\n' + og.map(g => `· [${g.id}] ${g.reason}（${g.intensity}分）`).join('\n');
      if ((d.impulses || []).length) out += '\n\n【憋着想说的】\n' + d.impulses.map(i => `· [${i.id}] ${i.reason}`).join('\n');
      out += '\nkey：' + d.dims.map(x => `${x.key}=${x.name}`).join(' ');
      return txt(out);
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
      if (currentBook && currentBook.id === args.book_id) {
        const t = $('reader-text');
        if (t.dataset.raw) t.textContent = t.dataset.raw;
        setTimeout(paintHighlights, 250);
      }
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
      const u = p.image_url?.url || '';
      if (/^\/(chatimg|stickers)\//.test(u)) return { type: 'image', source: { type: 'url', url: u } };
      return { type: 'text', text: '（图片）' };
    }
    return p;
  });
}
// 历史里最贵的两样：旧的思考链、旧的工具结果。
// 最近两轮留全，更早的砍掉——模型早就不需要看第十轮翻过的那页书了。
const KEEP_THINK = 2;
const OLD_TOOL_CHARS = 220;
function trimOld(m, isRecent) {
  if (isRecent) return m;
  if (!Array.isArray(m.content)) return m;
  let touched = false;
  const c = [];
  for (const b of m.content) {
    if (!b || typeof b !== 'object') { c.push(b); continue; }
    if (b.type === 'thinking') { touched = true; continue; }
    if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > OLD_TOOL_CHARS) {
      c.push({ ...b, content: b.content.slice(0, OLD_TOOL_CHARS) + '…（旧的，截断了）' });
      touched = true; continue;
    }
    c.push(b);
  }
  return touched ? { ...m, content: c } : m;
}
let recapDone = 0, recapBusy = false;
// 滑出窗口的那些不能直接丢，先送去压成前情提要
async function recapIfNeeded(msgs) {
  if (recapBusy || !ctxWindow || !currentConvId) return;
  const cut = Math.max(0, msgs.length - ctxWindow);
  if (cut - recapDone < 6) return;   // 攒够几条再压，省得频繁调
  const chunk = msgs.slice(recapDone, cut)
    .filter(m => !m._internal && m.role !== 'tool' && !hasToolResult(m));
  if (chunk.length < 4) { recapDone = cut; return; }
  recapBusy = true;
  try {
    const r = await jpost('/api/recap', {
      conv: currentConvId,
      messages: chunk.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content
          : (Array.isArray(m.content) ? m.content.filter(c => c && c.type === 'text').map(c => c.text).join(' ') : '')
      }))
    });
    if (!r.error) {
      recapDone = cut;
      localStorage.setItem('recap-done-' + currentConvId, String(cut));
    }
  } catch (e) { }
  recapBusy = false;
}
function buildMsgs(msgs) {
  if (sendFrom > msgs.length) sendFrom = Math.max(0, msgs.length - (ctxWindow || msgs.length));
  if (ctxWindow > 0 && msgs.length - sendFrom > ctxWindow * 2) sendFrom = msgs.length - ctxWindow;
  recapIfNeeded(msgs);
  let win = msgs.slice(ctxWindow > 0 ? sendFrom : 0);
  while (win.length) {
    const m = win[0];
    if (m.role === 'tool' || hasToolResult(m) || m.role === 'assistant') { win.shift(); continue; }
    break;
  }
  // 从尾巴往回数，最近 KEEP_THINK 轮对话之内的算「近」
  let turns = 0, cut = win.length;
  for (let i = win.length - 1; i >= 0; i--) {
    if (win[i].role === 'user' && !win[i]._internal && !hasToolResult(win[i])) {
      turns++;
      if (turns > KEEP_THINK) { cut = i + 1; break; }
    }
  }
  const out = [];
  for (let i = 0; i < win.length; i++) {
    const m = win[i];
    if (m.role === 'assistant' && !m.content && !m.tool_calls) continue;
    const { _internal, _thinking, _audio, _dur, _call, _callmark, _callinfo, _ts, _tools, _thinkTok, ...rest } = m;
    rest.content = toAnthropic(rest.content);
    out.push(trimOld(rest, i >= cut));
  }
  return out;
}
// ============ 表情包（存在服务器上，分「他的」「我的」） ============
// 以前整张图 base64 存在浏览器 localStorage 里，几张就把 5MB 撑满了，聊天记录也跟着存不进去。
let STICKERS = { lin: [], user: [] };
try { const c = JSON.parse(localStorage.getItem('stickers-cache') || 'null'); if (c && Array.isArray(c.lin)) STICKERS = { lin: c.lin, user: c.user || [] }; } catch (e) { }
const allStickers = () => [...STICKERS.lin, ...STICKERS.user];
function setStickers(d) {
  if (!d || !Array.isArray(d.lin)) return false;
  const next = { lin: d.lin, user: d.user || [] };
  const changed = JSON.stringify(next) !== JSON.stringify(STICKERS);
  STICKERS = next;
  try { localStorage.setItem('stickers-cache', JSON.stringify(STICKERS)); } catch (e) { }
  return changed;
}
async function loadStickers() {
  let changed = false;
  try { changed = setStickers(await jget('/api/stickers')); } catch (e) { }
  // 一次性搬家：浏览器里的老表情传到服务器（算他的），成功后从浏览器删掉，腾出空间
  const old = localStorage.getItem('custom-emoji');
  if (old) {
    try {
      const items = JSON.parse(old || '[]').filter(x => x && x.name && x.data);
      const r = items.length ? await jpost('/api/stickers/import', { owner: 'lin', items }) : { ok: true };
      if (r && r.ok) {
        localStorage.removeItem('custom-emoji');
        changed = setStickers(await jget('/api/stickers')) || changed;
      }
    } catch (e) { }
  }
  return changed;
}
// html 里的 [名字] 换成表情图（html 已经转义过）
function stickerize(html) {
  for (const it of allStickers()) {
    if (!it || !it.name) continue;
    html = html.split('[' + esc(it.name) + ']').join(`<img class="sticker-img" src="${esc(it.url).replace(/"/g, '&quot;')}" alt="${esc(it.name).replace(/"/g, '&quot;')}">`);
  }
  return html;
}
const isStickerOnly = t => { const m = /^\[([^\[\]]+)\]$/.exec((t || '').trim()); return !!m && allStickers().some(x => x.name === m[1]); };
function emojiNames() {
  const his = STICKERS.lin.filter(x => x && x.name).map(x => x.note ? `${x.name}（${x.note}）` : x.name);
  const hers = STICKERS.user.map(x => x.name).filter(Boolean);
  const unseen = STICKERS.lin.filter(x => x && x.name && !x.seen).map(x => x.name);
  let s = his.length ? `你能用的表情：${his.join('、')}。` : '';
  if (unseen.length) s += `还没看过长什么样的：${unseen.join('、')}（有「表情包」钥匙就能自己看、自己记它什么时候用）。`;
  if (hers.length) s += `她的表情包：${hers.join('、')}（她发 [名字] 就是发了那张表情）。`;
  return s;
}
// ============ 图片压缩：聊天图、表情、头像、背景都先缩小再存 ============
// 手机拍的照片动辄几 MB，还可能是 HEIC。一律在手机上解码、缩边、转成 JPEG（带透明的 PNG 保留 PNG）。
// 解码失败（比如非 Safari 打不开 HEIC）就原样返回，交给服务器那边判断。
function shrinkImage(file, maxSide = 1280, quality = 0.82) {
  return new Promise(resolve => {
    if (!file || /gif/i.test(file.type)) { resolve(file); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      try {
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const png = /png/i.test(file.type);
        c.toBlob(b => {
          URL.revokeObjectURL(url);
          // 原图本来就是小 JPEG/PNG/WebP 且没变小，就用原图；HEIC 之类一律用转好的
          const plain = /^image\/(jpeg|png|webp)$/i.test(file.type);
          resolve(b && (!plain || b.size < file.size) ? b : file);
        }, png ? 'image/png' : 'image/jpeg', quality);
      } catch (e) { URL.revokeObjectURL(url); resolve(file); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
// 存进浏览器的小图（头像、背景）：直接给 dataURL
async function shrinkToDataUrl(file, maxSide, quality) {
  const b = await shrinkImage(file, maxSide, quality);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = ev => resolve(ev.target.result);
    r.onerror = reject;
    r.readAsDataURL(b);
  });
}
const blobExt = b => { const t = (b && b.type) || ''; return t.includes('png') ? 'png' : t.includes('gif') ? 'gif' : t.includes('webp') ? 'webp' : t.includes('heic') ? 'heic' : t.includes('heif') ? 'heif' : 'jpg'; };
async function uploadChatImage(file) {
  const blob = await shrinkImage(file);
  const fd = new FormData();
  fd.append('file', blob, 'chat.' + blobExt(blob));
  const r = await fetch('/api/chat-img', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.url) throw new Error(d.error || '上传失败');
  if (d.warn) toast(d.warn);
  return d.url;
}
function roomNote() {
  if (roomCtx === 'reader' && currentBook) {
    let s = `你们现在一起在书房，翻着《${currentBook.title}》，她停在第 ${currentPage + 1} 页。`;
    const mine = (pageHls || []).filter(h => h.author === 'user');
    if (mine.length) {
      s += `她在这一页划了线，从整页里挑出来的就是这几句：${mine.map(h => '「' + h.quote + '」').join('')}`;
    }
    return s;
  }
  if (roomCtx === 'stage' && curMedia)
    return `你们现在一起在${curKind === 'music' ? '听音房听《' : '放映室看《'}${curMedia.note || curMedia.filename}》，她停在 ${fmtTime(stageTime())}。`;
  return '';
}
// 会变的（在哪个房间、停在哪）。表情清单不常变，单独放 extra_stable 进 system，不跟着每句话重复
function extraNote() {
  const parts = [roomNote()];
  if (roomCtx === 'netease') parts.push('你们现在在一起听歌，她在那边放着，放的什么你看不见，想知道就问她。');
  if (roomCtx === 'coread') parts.push('你们现在在一起读书（共读那个页面），她在那边翻着，具体读到哪你看不见，想知道就问她。');
  return parts.filter(Boolean).join(' ');
}

// ============ 气泡 ============
let currentBubble = null, currentThinkWrap = null, currentThinkContent = null, currentAiRow = null, turnThinking = '', turnThinkTok = 0;
let wantMore = false, moreRounds = 0;
const MAX_MORE = 3;

// 他写了空行就当分句，一条一条冒，像真的连着发
function splitSay(text) {
  const parts = String(text || '').split(/\n\s*\n+/).map(x => x.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.length ? parts : [String(text || '')];
  const out = [];
  for (const p of parts) {
    // 只有真的碎成一两个字才合回去
    const prev = out[out.length - 1];
    if (prev && prev.length <= 2 && p.length <= 2) out[out.length - 1] = prev + '\n' + p;
    else out.push(p);
  }
  // 表情包单独一个气泡，不跟文字挤在一起
  const names = (typeof allStickers === 'function' ? allStickers() : []).map(x => x && x.name).filter(Boolean);
  if (!names.length) return out;
  const re = new RegExp('(' + names.map(n => '\\[' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]').join('|') + ')');
  const res = [];
  for (const p of out) p.split(re).map(x => x.trim()).filter(Boolean).forEach(x => res.push(x));
  return res.length ? res : out;   // 空了几行就拆几条，不限条数
}
// 边收边拆：每段一个气泡，正在写的那段带光标。done 时去掉光标、单个表情去掉气泡底色
function streamSegs(wrap, text, done) {
  const segs = splitSay(text).filter(x => x !== '');
  const els = wrap._segEls || (wrap._segEls = []);
  const txt = wrap._segTxt || (wrap._segTxt = []);
  while (els.length > segs.length) { els.pop().remove(); txt.pop(); }
  segs.forEach((sg, i) => {
    let b = els[i];
    if (!b) {
      b = document.createElement('div');
      b.className = 'bubble ai'; b.dataset.seg = '1';
      wrap.appendChild(b); els[i] = b; txt[i] = null;
    }
    if (txt[i] !== sg) { b.innerHTML = renderBubble(sg); txt[i] = sg; }
    const last = i === segs.length - 1;
    b.classList.toggle('typing-cursor', !done && last);
    b.classList.toggle('sticker-only', done && isStickerOnly(sg));
  });
  currentBubble = els[els.length - 1] || null;
  scrollBottom();
}
function sayDelay(text) {
  return Math.min(2200, 420 + [...String(text)].length * 42);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function msgBox() {
  if (roomCtx === 'reader') return $('split-msgs-reader');
  if (roomCtx === 'stage') return $('split-msgs-stage');
  if (roomCtx === 'coread') return $('split-msgs-coread');
  if (roomCtx === 'netease') return $('split-msgs-netease');
  return $('messages');
}
function scrollBottom() { const m = msgBox(); if (m) m.scrollTop = m.scrollHeight; }
// 打开聊天：图片、表情是后加载的，加载完内容会变高，只滚一次会停在半截。
// 这几秒里一直贴着最底下；她自己一动手指就不再管
let pinUntil = 0;
function pinBottom(ms = 3000) {
  pinUntil = Date.now() + ms;
  const tick = () => { if (Date.now() > pinUntil) return; scrollBottom(); requestAnimationFrame(tick); };
  tick();
}
['touchstart', 'wheel'].forEach(ev => document.addEventListener(ev, e => {
  const m = msgBox(); if (m && m.contains(e.target)) pinUntil = 0;
}, { passive: true }));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && localStorage.getItem('cur-page') === 'chat') pinBottom(1500);
});
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
  return stickerize(renderMd(text));
}
// 通话记录那条气泡。谁挂的就靠哪边，跟微信一样
function addCallBubble(info, idx) {
  const mine = info.side !== 'lin';
  const row = document.createElement('div');
  row.className = 'msg-row' + (mine ? ' user' : '');
  if (idx !== undefined) row.dataset.msgIdx = idx;
  const av = mine ? localStorage.getItem('chat-avatar-user') : localStorage.getItem('chat-avatar-ai');
  const ah = av
    ? `<div class="msg-avatar${mine ? '' : ' msg-avatar-lin'} has-img"><img src="${av}"></div>`
    : `<div class="msg-avatar${mine ? '' : ' msg-avatar-lin'}">${mine ? '' : (CFG.name || '凛')[0]}</div>`;
  const ico = info.kind === 'missed'
    ? '<svg viewBox="0 0 24 24" class="cb-ico miss"><path d="M4 15c4-4 12-4 16 0l-2.5 2.5a1.5 1.5 0 0 1-2 .1l-1.6-1.3a1.5 1.5 0 0 0-1-.3h-2.8a1.5 1.5 0 0 0-1 .3l-1.6 1.3a1.5 1.5 0 0 1-2-.1z"/><path d="M15 9l5-5M20 9l-5-5" class="x"/></svg>'
    : '<svg viewBox="0 0 24 24" class="cb-ico"><path d="M4 15c4-4 12-4 16 0l-2.5 2.5a1.5 1.5 0 0 1-2 .1l-1.6-1.3a1.5 1.5 0 0 0-1-.3h-2.8a1.5 1.5 0 0 0-1 .3l-1.6 1.3a1.5 1.5 0 0 1-2-.1z"/></svg>';
  row.innerHTML = `${ah}<div class="bubble-wrap">
    <div class="bubble call-b ${mine ? 'user' : 'ai'}">${ico}<span>${esc(info.label)}</span></div>
    <div style="display:flex;align-items:center;gap:4px;${mine ? 'justify-content:flex-end;' : ''}">
      <span class="msg-time">${info.time || ''}</span></div></div>`;
  row.querySelector('.call-b').onclick = () => { if (typeof openCallLog === 'function') openCallLog(); };
  msgBox().appendChild(row);
  scrollBottom();
}
function addUserBubble(text, imgData, idx, audio) {
  const row = document.createElement('div'); row.className = 'msg-row user';
  if (idx !== undefined) row.dataset.msgIdx = idx;
  const uav = localStorage.getItem('chat-avatar-user');
  const av = uav ? `<div class="msg-avatar has-img"><img src="${uav}"></div>` : '';
  let c = '';
  if (imgData) c += `<div class="bubble-img"><img src="${imgData}"></div>`;
  // 她的也按空行拆成几条（只是显示，发给他的还是原样一整句）
  if (text && !(audio && audio.url)) splitSay(text).filter(Boolean).forEach(sg => {
    c += `<div class="bubble user${isStickerOnly(sg) ? ' sticker-only' : ''}">${stickerize(esc(sg))}</div>`;
  });
  row.innerHTML = `${av}<div class="bubble-wrap">${c}<div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;">
    <span class="msg-action-btn" data-edit="1" title="编辑" style="font-size:21px">ฅ</span><span class="msg-action-btn" data-copy="1" title="复制" style="font-size:21px">✎</span>
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
// 「已思考 · 想了约 1.2k tok → 摘要 300 字」：一眼看出这轮想了多少、压成了多少
function thinkLabel(text, tok) {
  const n = [...String(text || '').replace(/\s/g, '')].length;
  if (!tok) return '已思考';
  const t = tok < 1000 ? tok + ' tok' : (tok / 1000).toFixed(1) + 'k tok';
  return n ? `已思考 · 想了约 ${t} → 摘要 ${n} 字` : `已思考 · 想了约 ${t}（这轮没给摘要）`;
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
  if (!currentBubble.dataset.seg) currentBubble.innerHTML = rendered;
  currentBubble.classList.remove('typing-cursor');
  if (!rendered.replace(/<img[^>]*>/g, '').replace(/\s/g, '').length) {
    currentBubble.style.cssText = 'background:transparent;border:none;box-shadow:none;padding:0';
    currentBubble.classList.add('sticker-only');
  }
  const foot = document.createElement('div'); foot.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const time = document.createElement('span'); time.className = 'msg-time'; time.textContent = nowStr();
  foot.appendChild(time);
  if (tokens > 0) { const tk = document.createElement('span'); tk.className = 'msg-time'; tk.textContent = `· ${tokens}`; foot.appendChild(tk); }
  const cap = rawText || text;
  const SZ = { '๑': 22, '◎': 17, '✎': 21, '✮': 25, 'ฅ': 21, '⊞': 20, '♡': 21 };
  const mk = (label, title, fn) => {
    const s = document.createElement('span'); s.className = 'msg-action-btn';
    s.textContent = label; s.title = title;
    if (SZ[label]) s.style.fontSize = SZ[label] + 'px';
    s.onclick = fn; foot.appendChild(s); return s;
  };
  mk('๑', '重新生成', () => regenAt(rowRef || currentAiRow));
  const tb = mk('◎', '朗读', () => playTTS(cap, tb));
  mk('✮', '翻译', () => showTrans(wrap, cap));
  mk('♡', '收进最喜欢的话', () => keepQuote(cap));
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
  wrap._segEls = []; wrap._segTxt = [];   // 工具轮之后接着说，新起一组气泡
  const ccTools = {}, ccTrace = [];       // cc 模式下他在服务器上调用的工具
  let thinkTok = 0;                       // Claude Code 估算的思考 token
  let thinkZh = false;                    // 思考原本是外文、已经换成中文译文
  let thinkHide = '';                     // 外文思考没翻成：不显示、不保存（这里放原因）
  // 用局部变量：上一轮被「停」掉后它的收尾不能把这一轮的控制器清掉
  if (handoffBusy) await handoffBusy;   // 新窗口的「更早的事」还在压，等它好了再发第一句
  const ac = new AbortController();
  abortController = ac;
  const resp = await fetch('/api/chat-v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
    body: JSON.stringify({ model: currentModel, messages: buildMsgs(hist), tools: buildTools(), extra: extraNote(), extra_stable: emojiNames(), _session_id: getSessionId(), _conv_id: currentConvId, _mcp: ccMcpServers(), _effort: ccEffort(), _thinking: ccThinking(), _ctx: ctxWindow, _regen: takeRegen() })
  });
  if (!resp.ok) {
    // 429 = 服务器上一条还没回完（只跑得动一个），给句人话，不自动重试
    let msg = '';
    if (resp.status === 429) { try { msg = (await resp.json()).error || ''; } catch (e) { } }
    if (abortController === ac) abortController = null;
    const err = new Error('HTTP ' + resp.status);
    if (resp.status === 429) err.friendly = msg || '他还在回上一条消息，等他说完再发一次吧';
    throw err;
  }
  const reader = resp.body.getReader(), dec = new TextDecoder();
  let buf = '', thinkingText = '', responseText = '', stopReason = null, outTok = 0, inTok = 0, gotDone = false;
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
        if (raw === '[DONE]') { gotDone = true; continue; }
        if (!raw) continue;
        try {
          const d = JSON.parse(raw);
          if (d.type === 'message_start') absorb(d.message?.usage);
          else if (d.type === 'cc_status') showCcStatus(wrap, d);
          else if (d.type === 'cc_tool') onCcTool(wrap, d, ccTools, ccTrace);
          else if (d.type === 'cc_think') thinkTok = Number(d.tokens) || 0;
          else if (d.type === 'cc_think_hide') { thinkHide = d.why || '没翻成'; }
          else if (d.type === 'cc_think_zh' && d.text) {
            // 思考原本不是中文：服务器翻好了，整段换成中文（存进记录的也是中文）
            thinkingText = d.text; thinkZh = d.kind === 'voice' ? '已换成他自己的口吻' : '已译成中文';
            if (currentThinkContent) currentThinkContent.textContent = thinkingText;
          }
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
              streamSegs(wrap, responseText, false);
              if (messages.length && messages[messages.length - 1].role === 'assistant') messages[messages.length - 1].content = responseText;
              else messages.push({ role: 'assistant', content: responseText });
            } else if (dl.type === 'thinking_delta') {
              blk.thinking += dl.thinking;
              if (!dl.thinking) continue;
              if (!currentThinkWrap) thinkBlock(wrap, '', false);
              thinkingText += dl.thinking;
              if (currentThinkContent) {
                const all = thinkingText, cj = (all.match(/[\u4e00-\u9fff]/g) || []).length, la = (all.match(/[A-Za-z]/g) || []).length;
                currentThinkContent.textContent = cj >= la ? thinkingText : '（他这会儿在用英文想，想完会翻成中文给你看）';
              }
              // 收起时也能看到他正在想的最后一句
              const hs = currentThinkWrap && currentThinkWrap.querySelector('.thinking-header > span:not(.thinking-arrow)');
              if (hs) {
                const ln = thinkingText.trim().split(/\n+/).pop() || '';
                const cjk = (ln.match(/[\u4e00-\u9fff]/g) || []).length, lat = (ln.match(/[A-Za-z]/g) || []).length;
                // 外文的思考先不露出来，等翻成中文
                hs.textContent = cjk >= lat ? '思考中：' + ln.slice(-40) : '思考中…';
              }
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
  if (abortController === ac) abortController = null;
  totalTokens = inTok + outTok;
  drawTokens(inTok, outTok);
  // 记一笔，自己的账自己算
  if (inTok || outTok) {
    jpost('/api/ledger', {
      model: currentModel, in: inTok, out: outTok, cached: lastCacheRead,
      where: roomCtx ? 'room' : 'chat'
    }).catch(() => { });
  }
  const hiddenEn = thinkHide ? thinkingText : '';
  if (thinkHide) thinkingText = '';   // 没翻成的外文思考不存
  if (thinkingText) turnThinking += (turnThinking ? '\n\n' : '') + thinkingText;
  const keys = Object.keys(blocks).map(Number).sort((a, b) => a - b);
  const contentBlocks = keys.map(k => { const { _json, _rb, ...c } = blocks[k]; return c; });
  const toolUses = keys.map(k => blocks[k]).filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input, rb: b._rb }));
  // 想了但一个字摘要都没给（比如这个模型只给进度）：也建个框，说明想了多少
  if (!currentThinkWrap && thinkTok > 0 && !thinkingText) {
    thinkBlock(wrap, '', false);
    const first = wrap.querySelector('.cc-tool, .bubble');
    if (first && currentThinkWrap) wrap.insertBefore(currentThinkWrap, first);
    if (currentThinkContent) currentThinkContent.textContent = '这轮思考没有返回文字，只知道大概想了多少。';
  }
  if (thinkHide) {
    // 你要「完全不要英文」：没翻成的外文思考不显示、不存
    if (currentThinkContent) currentThinkContent.textContent = `这轮他是用英文想的，没翻成中文，就不给你看了。（${thinkHide}）`;
  }
  if (currentThinkWrap) {
    // 关掉了翻译（CC_THINK_ZH=0）时没有任何翻译消息：把原文放回去，别一直挂着「稍后翻成中文」
    if (currentThinkContent && !thinkZh && !thinkHide && thinkingText && /想完会翻成中文/.test(currentThinkContent.textContent)) currentThinkContent.textContent = thinkingText;
    const dot = currentThinkWrap.querySelector('.thinking-dot'); if (dot) dot.style.animation = 'none';
    const sp = currentThinkWrap.querySelector('.thinking-header span');
    if (sp) sp.textContent = thinkHide ? `已思考${thinkTok ? ' · 想了约 ' + (thinkTok < 1000 ? thinkTok + ' tok' : (thinkTok / 1000).toFixed(1) + 'k tok') : ''}（英文，没显示）`
      : thinkLabel(thinkingText, thinkTok) + (thinkZh ? ' · ' + thinkZh : '');
  }
  turnThinkTok += thinkTok;
  const hadTool = Object.values(blocks).some(b => b.type === 'tool_use');
  if (!responseText && !hadTool && stopReason !== 'tool_use' && !ac.signal.aborted) {
    // 以前这里什么都不显示，气泡就空着。给句话，只显示不存进记录（重发不会让他看到两遍）
    currentBubble = null;
    updateBubble(wrap, gotDone ? '（他这次没出声，可以再说一句）' : '（连接断了，他可能没说完。直接再发一句就行）', true);
  }
  if (ccTrace.length && messages.length && messages[messages.length - 1].role === 'assistant') {
    const cut = x => x == null ? x : (x.length > 1500 ? x.slice(0, 1500) + '…' : x);
    messages[messages.length - 1]._tools = ccTrace.map(t => ({ name: t.name, input: cut(t.input), result: cut(t.result), err: t.err }));
  }
  if (responseText) {
    // 收的时候已经拆好了，这里只收尾：去光标、加时间和按钮
    streamSegs(wrap, responseText, true);
    updateBubble(wrap, responseText, true, responseText, currentAiRow, outTok);
    saveConv();
  }
  return { text: responseText, toolUses, stopReason, contentBlocks };
}
function drawTokens(inTok, outTok) {
  const u = $('token-used');
  if (!u) return;
  const fresh = Math.max(0, inTok - lastCacheRead);
  u.textContent = (inTok + outTok).toLocaleString();
  const bar = $('token-bar');
  if (bar) bar.style.width = Math.min(100, (inTok + outTok) / CONTEXT_LIMIT * 100) + '%';
  const r = $('token-remain');
  if (!r) return;
  // 缓存那部分只算十分之一，实付才是真正花的钱
  const paid = Math.round(lastCacheRead * 0.1 + fresh + outTok * 3);
  const toolTk = buildTools().reduce((a, t) => {
    const s = JSON.stringify(t);
    const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    return a + Math.round(cn + (s.length - cn) * 0.28);
  }, 0);
  r.innerHTML = `进 ${inTok.toLocaleString()}（缓存命中 ${lastCacheRead.toLocaleString()}，全价 ${fresh.toLocaleString()}）· 出 ${outTok}
    <br>其中工具占 ${toolTk}，历史约 ${Math.max(0, fresh - toolTk - 160).toLocaleString()}
    <br><span style="color:var(--accent)">这一轮实付约 ${paid.toLocaleString()} 个单位（出的字贵三倍）</span>`;
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
  moreRounds = 0; wantMore = false;
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
    if (wantMore) {
      wantMore = false;
      if (moreRounds < MAX_MORE) {
        moreRounds++;
        await sleep(600);
        currentThinkWrap = null; currentThinkContent = null;
      } else {
        // 说够了，别没完没了
        work.push({ role: 'user', _internal: true, content: '（今天先说到这，剩下的留着当面说）' });
      }
    }
  }
  const extraMsgs = work.slice(origLen).map(sanitize);
  if (extraMsgs.length) messages.splice(origLen, 0, ...extraMsgs);
  if (turnThinking || turnThinkTok)
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i].role === 'assistant' && messages[i].content) {
        if (turnThinking) messages[i]._thinking = turnThinking.slice(0, 3000);
        if (turnThinkTok) messages[i]._thinkTok = turnThinkTok;
        break;
      }
  saveConv(); refreshHome();
  return finalText;
}

// ============ 发送 ============
// 每一轮一个编号。按「停」会直接结束当前轮并让编号作废，
// 被停掉那轮稍后自己收尾时的 endTurn(旧编号) 就不会把新一轮的 isTyping 清掉，
// 避免出现两条请求同时在跑、重复拉起 Claude Code。
let turnSeq = 0;
function beginTurn() {
  lastTalk = Date.now();
  isTyping = true;
  document.querySelectorAll('.send-btn').forEach(b => b.textContent = '■');
  showTypingTitle(true);
  return ++turnSeq;
}
function endTurn(seq) {
  if (seq !== undefined && seq !== turnSeq) return;
  if (seq === undefined) turnSeq++;
  isTyping = false;
  document.querySelectorAll('.send-btn').forEach(b => b.textContent = '↑');
  showTypingTitle(false);
}
// ============ 他调用工具：一行显示「调用了什么」，点开看参数和结果（像 Claude app 那样） ============
const TOOL_SERVER = { ob: '记忆库', lin: '家里' };
const TOOL_CN = {
  breath: '想起点什么', hold: '记下来', grow: '整理进记忆', dream: '做梦', letter_write: '写信', letter_read: '读信', plan: '记个约定',
  write_note: '写碎碎念', post_moment: '发朋友圈', read_moments: '看朋友圈', react_moment: '朋友圈点赞/评论',
  write_fault: '记犯错本', write_timeline: '写时间线', write_calendar: '写日历', keep_quote: '收一句话',
  lin_status: '改状态', get_memories: '翻时光墙', view_memory: '看照片', my_drawer: '放进抽屉',
  library_list: '看资料库', library_read: '读资料', room_books: '看书架', room_read_page: '翻书', room_highlight: '划线',
  room_read_tags: '看标签', room_write_tag: '贴标签', call_her: '给你打电话', desire_state: '看自己的数值',
  desire_adjust: '改数值', desire_note: '给数值留话', desire_feed: '记下在想的事', desire_vent: '自己解决',
  desire_grudge: '记一笔账', desire_ack: '标记说出口了', desire_event: '心情动了一下',
  WebSearch: '上网搜', WebFetch: '看网页', Read: '读文件', ToolSearch: '找工具',
};
function toolLabel(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name || '');
  if (m) {
    const srv = TOOL_SERVER[m[1]] || m[1];
    return (TOOL_CN[m[2]] ? TOOL_CN[m[2]] + ' · ' : '') + srv + ' / ' + m[2];
  }
  return TOOL_CN[name] ? `${TOOL_CN[name]} · ${name}` : (name || '工具');
}
function toolRow(t) {
  const el = document.createElement('div'); el.className = 'cc-tool';
  el.innerHTML = `<div class="cc-tool-head"><span class="ct-state"></span><span class="ct-name"></span><span class="ct-arrow">▸</span></div>
    <div class="cc-tool-body"><div class="ct-label">参数</div><pre class="ct-pre ct-in"></pre><div class="ct-label">结果</div><pre class="ct-pre ct-out"></pre></div>`;
  el.querySelector('.ct-name').textContent = toolLabel(t.name);
  el.querySelector('.cc-tool-head').onclick = () => el.classList.toggle('open');
  paintTool(el, t);
  return el;
}
function paintTool(el, t) {
  const st = el.querySelector('.ct-state');
  st.className = 'ct-state ' + (t.result == null ? 'run' : t.err ? 'bad' : 'ok');
  st.textContent = t.result == null ? '' : t.err ? '✗' : '✓';
  el.querySelector('.ct-in').textContent = t.input == null ? '（等他写完参数…）' : (t.input === '{}' ? '（没有参数）' : t.input);
  el.querySelector('.ct-out').textContent = t.result == null ? '（还在跑…）' : (t.result || '（空）');
}
function onCcTool(wrap, d, tools, trace) {
  let t = tools[d.id];
  if (!t) {
    t = tools[d.id] = { name: d.name || '', input: null, result: null, err: false };
    t.el = toolRow(t); wrap.appendChild(t.el); trace.push(t);
    currentBubble = null; scrollBottom();
  }
  if (d.phase === 'input') t.input = d.input;
  if (d.phase === 'result') { t.result = d.result || ''; t.err = !!d.is_error; if (d.name && !t.name) t.name = d.name; }
  paintTool(t.el, t);
}
// cc 模式的小提示：图片有没有送到他那边、哪个 MCP 没连上。只显示，不存进记录
function showCcStatus(wrap, d) {
  if ('images' in d) {
    const rows = [...msgBox().querySelectorAll('.msg-row.user')];
    const row = rows.reverse().find(r => r.querySelector('.bubble-img')) || null;
    const host = row && row.querySelector('.bubble-wrap');
    if (host) {
      const old = host.querySelector('.img-status'); if (old) old.remove();
      const probs = d.image_problems || [];
      const el = document.createElement('div');
      el.className = 'img-status' + (probs.length ? ' bad' : '');
      el.textContent = (d.images ? `✓ 他收到了 ${d.images} 张图` : '') + (d.images && probs.length ? '　' : '')
        + (probs.length ? `✗ ${probs.length} 张没送到他那边：${[...new Set(probs)].join('；')}` : '');
      host.appendChild(el);
    }
  }
  if (d.note) {
    const el = document.createElement('div'); el.className = 'mcp-warn'; el.style.color = 'var(--text-muted)';
    el.textContent = d.note; wrap.appendChild(el);
  }
  if (Array.isArray(d.mcp)) {
    const bad = d.mcp.filter(m => m.status && !['connected', 'pending'].includes(m.status));
    if (bad.length) {
      const el = document.createElement('div'); el.className = 'mcp-warn';
      el.textContent = 'MCP 没连上：' + bad.map(m => `${m.name}（${m.status}）`).join('、') + '。这一条里他用不了它们';
      wrap.appendChild(el);
    }
  }
}
// 顶栏正中的「对方正在输入…」：发出去到他说完都亮着
function showTypingTitle(on) {
  const el = $('typing-title'); if (el) el.classList.toggle('show', !!on);
}
function turnError(wrap, e) {
  if (e && e.name === 'AbortError') return;   // 自己按了停，不算出错
  console.error(e);
  currentBubble = null;
  updateBubble(wrap, (e && e.friendly) || '断开了一下，他还在那边接着说，说完会自己出现…', true);
  watchPending(120);
}
// ============ 断线找回 ============
// 锁屏 / 切后台 / 网闪一下，连接断了，他在服务器上照样把话说完、存起来；这里去取回来
async function fetchPending() {
  if (!currentConvId) return false;
  let d; try { d = await jget('/api/cc/pending?conv=' + encodeURIComponent(currentConvId)); } catch (e) { return false; }
  if (!d || !d.text) return false;
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') last.content = d.text;
  else messages.push({ role: 'assistant', content: d.text });
  saveConv(); loadConv(currentConvId);
  return true;
}
let pendingWatch = null;
function watchPending(sec) {
  if (pendingWatch) clearInterval(pendingWatch);
  const end = Date.now() + sec * 1000;
  pendingWatch = setInterval(async () => {
    if (isTyping) return;
    if (await fetchPending() || Date.now() > end) { clearInterval(pendingWatch); pendingWatch = null; }
  }, 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !isTyping) fetchPending(); });
// 她按「停」/挂电话：这一句不要了，服务器那边也别接着说
const ccStop = () => { if (currentConvId) jpost('/api/cc/stop', { conv: currentConvId }).catch(() => { }); };
async function sendMsg(fromCtx) {
  const inp = fromCtx ? document.querySelector(`.split-input[data-ctx="${fromCtx}"]`) : $('input');
  const text = inp.value.trim(), hasImg = !fromCtx && !!pendingChatImg;
  if ((!text && !hasImg) || isTyping) return;
  if (hasImg && pendingChatImg.uploading) { toast('图片还在上传，稍等一下'); return; }
  inp.value = ''; inp.style.height = 'auto';
  const seq = beginTurn();
  if (editingMsgIdx !== null) {
    messages.splice(editingMsgIdx);
    [...msgBox().querySelectorAll('.msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= editingMsgIdx) r.remove(); });
    editingMsgIdx = null;
  }
  const content = hasImg
    ? [...(text ? [{ type: 'text', text }] : []), { type: 'image_url', image_url: { url: pendingChatImg.data } }]
    : text;
  messages.push({ role: 'user', content, _mid: genMid() });
  addUserBubble(text, hasImg ? pendingChatImg.data : null, messages.length - 1);
  saveConv();
  if (hasImg) { pendingChatImg = null; $('img-preview-bar').classList.remove('show'); }
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = ''; turnThinkTok = 0;
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { turnError(wrap, e); }
  await attachVoiceReply(wrap, reply);
  endTurn(seq);
}
async function sendComposed(text, imgs, opts) {
  if (isTyping) return;
  imgs = imgs || []; opts = opts || {};
  let content = text;
  if (imgs.length) {
    content = [{ type: 'text', text }];
    imgs.forEach(u => content.push({ type: 'image_url', image_url: { url: u } }));
  }
  const seq = beginTurn();
  const msg = { role: 'user', content, _mid: genMid() };
  if (opts.audio) { msg._audio = opts.audio; msg._dur = opts.dur; }
  messages.push(msg);
  const myIdx = messages.length - 1;
  if (!roomCtx) showPage('chat');
  addUserBubble(text, imgs[0] || null, myIdx, opts.audio ? { url: opts.audio, dur: opts.dur } : null);
  saveConv();
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = ''; turnThinkTok = 0;
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { turnError(wrap, e); }
  await attachVoiceReply(wrap, reply);
  if (imgs.length && Array.isArray(messages[myIdx]?.content)) {
    messages[myIdx].content = messages[myIdx].content.map(c => c && c.type === 'image_url' ? { type: 'text', text: '（一张看过的画面）' } : c);
    saveConv();
  }
  endTurn(seq);
}
// 重新生成：告诉服务器这一句是 roll 的，Claude Code 那边从这一轮之前分叉，被 roll 掉的他看不到
let regenNext = false;
const takeRegen = () => { const v = regenNext; regenNext = false; return v; };
async function regenAt(row) {
  if (isTyping || !row) return;
  regenNext = true;
  const idx = parseInt(row.dataset.msgIdx);
  messages.splice(idx);
  [...msgBox().querySelectorAll('.msg-row')].forEach(r => { if (parseInt(r.dataset.msgIdx) >= idx) r.remove(); });
  if (!messages.length || messages[messages.length - 1].role !== 'user') return;
  const wrap = startAiBubble(messages.length);
  currentBubble = null; currentThinkWrap = null; currentThinkContent = null; turnThinking = ''; turnThinkTok = 0;
  const seq = beginTurn();
  let reply = '';
  try { reply = await runToolLoop(wrap, messages.length); }
  catch (e) { turnError(wrap, e); }
  await attachVoiceReply(wrap, reply);
  endTurn(seq);
}

// ============ 对话管理 ============
const getConvs = () => { try { return JSON.parse(localStorage.getItem('conversations') || '[]'); } catch (e) { return []; } };
const saveConvs = l => localStorage.setItem('conversations', JSON.stringify(l));
// 老记录里直接存着 base64 图片，最占地方。存不下时把它们换成一句文字再存
const isDataImg = c => c && c.type === 'image_url' && /^data:/.test(c.image_url?.url || '');
function stripDataImages(list) {
  let hit = false;
  const out = list.map(m => {
    if (!Array.isArray(m.content) || !m.content.some(isDataImg)) return m;
    hit = true;
    return { ...m, content: m.content.map(c => isDataImg(c) ? { type: 'text', text: '（一张看过的画面）' } : c) };
  });
  return hit ? out : list;
}
function freeOldConvImages() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('conv-') || k === 'conv-' + currentConvId) continue;
    try {
      const v = localStorage.getItem(k);
      if (!v || v.indexOf('data:image') < 0) continue;
      const nl = stripDataImages(JSON.parse(v));
      localStorage.setItem(k, JSON.stringify(nl));
    } catch (e) { }
  }
}
function saveConv() {
  if (!currentConvId || !messages.length) return;
  try { localStorage.setItem('conv-' + currentConvId, JSON.stringify(messages)); }
  catch (e) {
    try {
      messages = stripDataImages(messages);
      freeOldConvImages();
      localStorage.setItem('conv-' + currentConvId, JSON.stringify(messages));
    } catch (e2) { toast('存储空间快满了'); return; }
  }
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
  recapDone = parseInt(localStorage.getItem('recap-done-' + id) || '0');
  $('messages').innerHTML = '<div class="sys-msg">— 今天 —</div>';
  currentBubble = null; currentThinkWrap = null; currentAiRow = null;
  const keep = roomCtx; roomCtx = null;
  messages.forEach((msg, i) => {
    if (msg._callmark) {
      addCallBubble(msg._callinfo || {
        label: String(msg.content || '').replace(/[（）]/g, ''),
        side: 'user', kind: 'call',
        time: new Date(msg._ts || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }, i);
      return;
    }
    if (msg.role === 'tool' || msg._internal) return;
    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(c => c && c.type === 'tool_result')) return;
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text || '' : '');
      const img = Array.isArray(msg.content) ? msg.content.find(c => c.type === 'image_url') : null;
      addUserBubble(text, img?.image_url?.url || null, i, msg._audio ? { url: msg._audio, dur: msg._dur } : null);
      if (msg._call) { const b = msgBox().lastElementChild?.querySelector('.bubble'); if (b) b.classList.add('in-call'); }
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.filter(c => c && c.type === 'text').map(c => c.text).join('') : '');
      if (!text && !msg._thinking) return;
      const wrap = startAiBubble(i);
      if (msg._thinking) {
        thinkBlock(wrap, msg._thinking, true);
        const sp = wrap.querySelector('.thinking-header span'); if (sp) sp.textContent = thinkLabel(msg._thinking, msg._thinkTok);
      }
      if (Array.isArray(msg._tools)) msg._tools.forEach(t => wrap.appendChild(toolRow(t)));
      if (msg._audio) wrap.appendChild(voiceBubble(msg._audio, msg._dur, '', true));
      if (text) {
        const segs = splitSay(text);
        if (segs.length > 1) {
          segs.forEach(sg => {
            const b = document.createElement('div');
            b.className = 'bubble ai' + (isStickerOnly(sg) ? ' sticker-only' : ''); b.dataset.seg = '1';
            b.innerHTML = renderBubble(sg);
            wrap.appendChild(b); currentBubble = b;
          });
        }
        updateBubble(wrap, text, true, text, currentAiRow);
      }
      currentBubble = null; currentAiRow = null;
    }
  });
  roomCtx = keep;
  scrollBottom(); localStorage.setItem('current-conv-id', id);
}
// 换新窗口无缝接上：最后两轮原样带过去，再往前的跟旧摘要一起压成新窗口的「更早的事」。
// 新窗口在 cc 里是新会话，不背旧会话的全部记录，最省。fresh=true（清空对话）就什么都不带。
const CARRY_ROUNDS = 2;
function newConv(fresh) {
  const prev = { id: currentConvId, msgs: messages };
  if (messages.length) saveConv();
  currentConvId = genId(); messages = []; totalTokens = 0; editingMsgIdx = null; sendFrom = 0;
  recapDone = 0;
  currentBubble = null; currentThinkWrap = null; currentAiRow = null;
  $('messages').innerHTML = '<div class="sys-msg">— 今天 —</div>';
  localStorage.setItem('current-conv-id', currentConvId);
  $('conv-panel').classList.remove('open'); showPage('chat');
  if (fresh !== true && prev.id && prev.msgs.length) handoff(prev);
}
function handoff(prev) {
  const real = m => m && m.role === 'user' && !m._internal && !m._callmark && !(Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result'));
  const starts = [];
  prev.msgs.forEach((m, i) => { if (real(m)) starts.push(i); });
  const cut = starts.length > CARRY_ROUNDS ? starts[starts.length - CARRY_ROUNDS] : (starts[0] ?? prev.msgs.length);
  const textOf = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('') : '');
  const carry = [];
  for (const m of prev.msgs.slice(cut)) {
    if (m._internal || m._callmark) continue;
    const t = textOf(m.content); if (!t) continue;
    if (m.role === 'user') carry.push({ role: 'user', content: t, _mid: genMid() });
    else if (m.role === 'assistant') carry.push({ role: 'assistant', content: t });
  }
  const older = prev.msgs.slice(Math.max(0, cut - 40), cut).filter(m => !m._internal && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: textOf(m.content) })).filter(m => m.content);
  const to = currentConvId;
  messages = carry; saveConv(); loadConv(to);
  const tip = document.createElement('div'); tip.className = 'sys-msg'; tip.textContent = '— 接着上个窗口 —';
  msgBox().insertBefore(tip, msgBox().children[1] || null);
  handoffBusy = jpost('/api/recap/handoff', { from: prev.id, to, messages: older })
    .catch(() => { }).finally(() => { handoffBusy = null; });
}
let handoffBusy = null;
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
      if (currentConvId === c.id) { if (nl.length) loadConv(nl[0].id); else newConv(true); }
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
let lastTalk = Date.now();
function startKeepalive() {
  setInterval(() => {
    if (isTyping) return;
    // 三小时没说话就停，睡着的时候没必要一直续缓存
    if (Date.now() - lastTalk > 3 * 3600 * 1000) return;
    fetch('/api/chat-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentModel, tools: buildTools(), messages: [{ role: 'user', content: 'ping' }], _session_id: getSessionId(), _keepalive: true })
    }).then(r => { if (r.body) r.body.cancel(); }).catch(() => { });
  }, 50 * 60 * 1000);
}
