// 手机里存的东西（聊天记录、设置、头像……）自动在服务器上留一份。
// 删了桌面 app 再装回来、换手机、清了浏览器数据：一打开就从服务器拉回来，什么都不丢。
// 这个文件必须在 app.js 之前加载（同步），先恢复完别的代码才开始读。
(function () {
  var MARK = '__srv-store-ok';          // 这份手机存储已经跟服务器对过一次了
  var SKIP = /^(__srv-|stickers-cache$|mcp-sync-at$)/;   // 不用同步的：内部标记、缓存
  var ls;
  try { ls = window.localStorage; } catch (e) { return; }
  if (!ls) return;

  var proto = Storage.prototype, origSet = proto.setItem, origRemove = proto.removeItem, origClear = proto.clear;
  var server = null;

  // 1. 第一次打开（或者存储被清空了）：先把服务器那份拉下来，手机上没有的补回去
  if (!ls.getItem(MARK)) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/store', false);   // 同步：恢复完了才往下跑，不然别的代码会先写一堆默认值
      x.send();
      if (x.status === 200) {
        server = (JSON.parse(x.responseText) || {}).data || {};
        var n = 0;
        for (var k in server) {
          if (!Object.prototype.hasOwnProperty.call(server, k) || SKIP.test(k)) continue;
          if (ls.getItem(k) === null) {
            try { origSet.call(ls, k, server[k]); n++; } catch (e) { }
          }
        }
        origSet.call(ls, MARK, String(Date.now()));
        if (n) window.__storeRestored = n;
      }
    } catch (e) { }
  }
  // 没跟服务器对上（服务器连不上）：这次不上传，免得一个空手机把服务器上的好数据盖掉
  if (!ls.getItem(MARK)) return;

  // 2. 之后手机上每改一样东西，过一会儿就同步上去
  var pendSet = {}, pendDel = {}, timer = null;
  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(flush, ms); }
  function flush(useBeacon) {
    timer = null;
    var set = {}, del = [], has = false, k;
    for (k in pendSet) { var v = ls.getItem(k); if (v !== null) { set[k] = v; has = true; } }
    for (k in pendDel) { del.push(k); has = true; }
    if (!has) return;
    var body = JSON.stringify({ set: set, del: del });
    var keepSet = pendSet, keepDel = pendDel;
    pendSet = {}; pendDel = {};
    var retry = function () {   // 没传上去：放回队列，过会儿再试
      for (var a in keepSet) if (!(a in pendDel)) pendSet[a] = 1;
      for (var b in keepDel) if (!(b in pendSet)) pendDel[b] = 1;
      schedule(15000);
    };
    try {
      if (useBeacon && body.length < 60000 && navigator.sendBeacon) {
        if (navigator.sendBeacon('/api/store', new Blob([body], { type: 'application/json' }))) return;
      }
      fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: body.length < 60000 })
        .then(function (r) { if (!r.ok) retry(); }, retry);
    } catch (e) { retry(); }
  }
  proto.setItem = function (k, v) {
    var r = origSet.apply(this, arguments);
    if (this === ls && !SKIP.test(String(k))) { k = String(k); pendSet[k] = 1; delete pendDel[k]; schedule(1500); }
    return r;
  };
  proto.removeItem = function (k) {
    var r = origRemove.apply(this, arguments);
    if (this === ls && !SKIP.test(String(k))) { k = String(k); pendDel[k] = 1; delete pendSet[k]; schedule(1500); }
    return r;
  };
  proto.clear = function () {
    // 整个清空不往服务器同步（多半是出问题了），服务器那份留着当后路
    var r = origClear.apply(this, arguments);
    if (this === ls) { pendSet = {}; pendDel = {}; }
    return r;
  };
  // 切到后台 / 关掉前把没传的赶紧传上去
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', function () { flush(true); });

  // 3. 第一次对上之后，把手机上已有、服务器上没有或不一样的都传一遍（老数据先备份上去）
  if (server) {
    for (var i = 0; i < ls.length; i++) {
      var key = ls.key(i);
      if (key && !SKIP.test(key) && server[key] !== ls.getItem(key)) pendSet[key] = 1;
    }
    schedule(3000);
  }
})();
