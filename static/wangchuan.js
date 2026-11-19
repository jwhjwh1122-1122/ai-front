// ============ 忘川 ============
// 底图是宝宝自己合的那张（她去水印、拼的天和花田、挑的玻璃河），五盏灯是从图里一盏一盏抠出来的。
// 定稿是第十五版：灯在原地晃，底下荡涟漪。点一下出名字，再点一下进那盏灯里。
(function () {
  var IW = 551, IH = 1108;               // 坐标都按这个量的
  var room, stage, cv, ctx, hot, inner, W = 1, H = 1, running = false, built = false;
  function X(ix) { return ix / IW * W; } function Y(iy) { return iy / IH * H; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // 灯：远→近。名字从近往远起：镜子、欲望、祈愿；最远两盏还没名字
  var L = [
    { x: 406, y: 572, w: 32, t: '', bx: 369.35, by: 536.30, bw: 72.66, bh: 77.85, ph: 0.00 },
    { x: 361, y: 622, w: 50, t: '', bx: 306.21, by: 568.30, bw: 108.12, bh: 117.64, ph: 1.70 },
    { x: 243, y: 677, w: 70, t: '祈 愿', key: 'wish', bx: 169.54, by: 604.63, bw: 146.18, bh: 159.16, ph: 3.40 },
    { x: 115, y: 772, w: 95, t: '欲 望', key: 'desire', bx: 16.43, by: 675.56, bw: 196.35, bh: 212.79, ph: 5.10 },
    { x: 229, y: 955, w: 115, t: '镜 子', key: 'mirror', bx: 111.58, by: 839.04, bw: 234.41, bh: 255.17, ph: 6.80 }];
  var SPR = [];
  function drift(l, t) { var k = l.w / 115; return [Math.sin(t / 4300 + l.ph) * 15 * k + Math.sin(t / 9100 + l.ph * 2) * 8 * k, Math.sin(t / 2600 + l.ph) * 6 * k, Math.sin(t / 3300 + l.ph * 1.3) * 0.05]; }

  var R = [[262, 378], [300, 430], [330, 480], [390, 550], [370, 615], [260, 670], [170, 740], [150, 820], [200, 900], [230, 980], [240, 1108]];
  var BL = [[175, 448], [255, 480], [305, 515], [330, 555], [290, 600], [200, 640], [100, 675], [0, 708]];
  var BR = [[345, 405], [300, 430], [270, 455], [310, 475], [400, 505], [470, 530], [490, 570], [460, 630], [390, 680], [310, 720], [270, 780], [260, 830], [300, 870], [390, 920], [450, 990], [480, 1050]];
  var FALL = [[185, 170], [205, 200], [245, 150], [262, 120], [282, 95]];
  function on(P, u) { var n = P.length - 1, i = Math.min(n - 1, Math.floor(u * n)), f = u * n - i, a = P[i], b = P[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
  var motes = [], glints = [], drops = [], tw = [], ups = [], mist = [], RP = [], RPL = 0, i;
  for (i = 0; i < 34; i++) motes.push({ u: Math.random(), v: rnd(.00035, .0008), o: rnd(.25, .8), w: rnd(-14, 14), s: rnd(.5, 1.8) });
  for (i = 0; i < 26; i++) glints.push({ P: i % 2 ? BL : BR, u: Math.random(), v: rnd(.0004, .0009), s: rnd(.6, 1.6) });
  for (i = 0; i < 16; i++) { var f0 = FALL[i % FALL.length]; drops.push({ x: f0[0] + rnd(-6, 6), y: rnd(f0[1], 365), y0: f0[1], v: rnd(.25, .6), o: rnd(.3, .8) }); }
  for (i = 0; i < 60; i++) tw.push({ x: rnd(10, 540), y: rnd(10, 330), ph: rnd(0, 7), sp: rnd(.4, 1.4), s: rnd(.4, 1.1) });
  for (i = 0; i < 22; i++) ups.push({ x: rnd(0, IW), y: rnd(380, IH), v: rnd(.1, .3), o: rnd(.2, .65), ph: rnd(0, 7) });
  for (i = 0; i < 8; i++) mist.push({ x: Math.random(), y: [.38, .45, .52, .6, .68, .78, .87, .95][i], v: rnd(.0001, .0003), w: rnd(.25, .5), o: rnd(.025, .06), h: rnd(.02, .045) });

  // 铺满屏：手机竖着就按高撑满、左右切一点；屏幕太宽就按高放、两边留黑
  function fit() {
    var vw = room.clientWidth, vh = room.clientHeight, sc = vw / vh > 0.62 ? vh / 1280 : Math.max(vw / 637, vh / 1280);
    W = 637 * sc; H = 1280 * sc;
    stage.style.width = W + 'px'; stage.style.height = H + 'px';
    stage.style.left = (vw - W) / 2 + 'px'; stage.style.top = (vh - H) / 2 + 'px';
    var d = Math.min(2, window.devicePixelRatio || 1); cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    room._fw = vw; room._fh = vh;
  }

  function hideNames(except) { L.forEach(function (l) { if (l !== except && l.t) { l.on = false; l.tg.classList.remove('on'); } }); }
  function build() {
    built = true;
    room = document.getElementById('wcroom'); stage = document.getElementById('wc-stage');
    cv = document.getElementById('wc-cv'); ctx = cv.getContext('2d'); hot = document.getElementById('wc-hot'); inner = document.getElementById('wc-inner');
    SPR = L.map(function (_, k) { var im = new Image(); im.src = '/static/wangchuan/lamp' + k + '.png?v=2'; return im; });
    hot.onclick = function () { hideNames(); };
    L.forEach(function (l) {
      var hit = document.createElement('div'); hit.className = 'wc-hit';
      hit.style.left = (l.x / IW * 100) + '%'; hit.style.top = (l.y / IH * 100) + '%'; hit.style.width = Math.max(10, l.w / IW * 100 * 1.5) + '%';
      var tg = document.createElement('div'); tg.className = 'wc-name'; tg.textContent = l.t;
      tg.style.left = ((l.x + l.w * .62) / IW * 100) + '%'; tg.style.top = (l.y / IH * 100) + '%';
      hit.onclick = function (e) {
        e.stopPropagation();
        if (!l.t) { l.on = !l.on; return; }            // 没名字的灯：只亮一下
        if (l.on) { enter(l); return; }                 // 名字已经浮出来了：再点就进去
        hideNames(l); l.on = true; tg.classList.add('on');
      };
      l.hit = hit; l.tg = tg; hot.appendChild(hit); hot.appendChild(tg);
    });
    document.getElementById('wc-back').onclick = leave;
    window.addEventListener('resize', function () { if (running) fit(); });
  }

  // 进灯里：从那盏灯的位置开出去
  function enter(l) {
    var r = l.hit.getBoundingClientRect(), rr = room.getBoundingClientRect();
    inner.style.setProperty('--ox', (r.left + r.width / 2 - rr.left) + 'px');
    inner.style.setProperty('--oy', (r.top + r.height / 2 - rr.top) + 'px');
    document.getElementById('wc-in-title').textContent = l.t;
    var body = document.getElementById('wc-in-body');
    body.innerHTML = '<div class="wc-in-empty">这盏灯里还空着。<br>等我们一起来布置。</div>';
    if (l.key === 'desire') { openYuwang(); hideNames(); return; }
    inner.classList.add('open');
  }
  // 欲望那盏灯：里面就是那间蜘蛛网的屋子，铺满屏
  function openYuwang() {
    var ov = document.getElementById('yw-ov');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'yw-ov';
      ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#e9e6e0;opacity:0;transition:opacity .6s';
      ov.innerHTML = '<iframe style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>' +
        '<div id="yw-back" style="position:absolute;left:14px;top:calc(env(safe-area-inset-top) + 12px);padding:6px 12px;border-radius:14px;background:rgba(240,237,230,.85);color:#222;font-size:14px;font-family:Kaiti SC,STKaiti,serif;cursor:pointer">← 回到河上</div>' +
        '<div id="yw-old" style="position:absolute;right:14px;bottom:calc(env(safe-area-inset-bottom) + 10px);font-size:11px;color:#888;cursor:pointer">旧的仪表盘</div>';
      document.body.appendChild(ov);
      ov.querySelector('#yw-back').onclick = function () { ov.style.opacity = 0; setTimeout(function () { ov.style.display = 'none'; ov.querySelector('iframe').src = 'about:blank'; }, 600); };
      ov.querySelector('#yw-old').onclick = function () { if (typeof openDesire === 'function') { ov.querySelector('#yw-back').onclick(); openDesire(); } };
    }
    ov.style.display = 'block'; ov.querySelector('iframe').src = '/static/yuwang/room.html?v=' + Date.now();
    requestAnimationFrame(function () { ov.style.opacity = 1; });
  }
  function leave() { inner.classList.remove('open'); hideNames(); }

  function ripRing(x, y, rad, al, ph, wob, dark, w) {
    var ry = rad * .3, gr = ctx.createLinearGradient(0, y - ry, 0, y + ry);
    if (dark) { gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.55, 'rgba(0,0,0,' + (al * .4).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(0,0,0,' + (al * .95).toFixed(3) + ')'); }
    else { gr.addColorStop(0, 'rgba(232,234,244,' + al.toFixed(3) + ')'); gr.addColorStop(.5, 'rgba(218,220,232,' + (al * .42).toFixed(3) + ')'); gr.addColorStop(1, 'rgba(218,220,232,' + (al * .1).toFixed(3) + ')'); }
    ctx.strokeStyle = gr; ctx.beginPath();
    for (var i = 0; i < 32; i++) { var th = i / 32 * 6.2832, k = 1 + wob * (Math.sin(th * 3 + ph) * .6 + Math.sin(th * 5 + ph * 1.7) * .4), px = x + Math.cos(th) * rad * k, py = y + Math.sin(th) * ry * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); if (!dark) { ctx.lineWidth = w + 2.4; ctx.globalAlpha = .22; ctx.stroke(); ctx.globalAlpha = 1; } ctx.lineWidth = w; ctx.stroke();
  }
  function glow(x, y, r, a) {
    if (a <= 0 || r <= 0) return; var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,252,246,' + a + ')'); g.addColorStop(.3, 'rgba(255,228,214,' + a * .45 + ')');
    g.addColorStop(.65, 'rgba(214,120,110,' + a * .12 + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  function dot(x, y, r, a) { ctx.fillStyle = 'rgba(255,255,255,' + a + ')'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }

  function draw(t) {
    ctx.clearRect(0, 0, W, H); var sc = W / IW;
    ctx.globalCompositeOperation = 'source-over';
    L.forEach(function (l, k) {
      var o = drift(l, t), im = SPR[k]; l.dx = o[0]; l.dy = o[1]; if (!(im.complete && im.naturalWidth)) return;
      var px = X(l.x + o[0]), py = Y(l.y + l.w * .22 + o[1]); ctx.save(); ctx.translate(px, py); ctx.rotate(o[2]);
      ctx.drawImage(im, X(l.bx + o[0]) - px, Y(l.by + o[1]) - py, X(l.bw), Y(l.bh)); ctx.restore();
    });
    // 涟漪：照记忆室的写法，上弧亮下弧暗，边软，越散越不齐
    var dt = Math.min(.05, (t - (RPL || t)) / 1000); RPL = t;
    L.forEach(function (l) {
      l.nx = l.nx || t + rnd(0, 2500); if (t >= l.nx) {
        l.nx = t + rnd(5000, 7500);
        RP.push({ l: l, t: 0, max: l.w * rnd(.32, .45), life: rnd(5.5, 7), n: 3, a: rnd(.65, .85), ph: rnd(0, 6.28) });
      }
    });
    RP.forEach(function (r) {
      r.t += dt; var p = r.t / r.life, l = r.l, cx = X(l.x + l.dx), cy = Y(l.y + l.w * .22 + l.dy), r0 = X(l.w * .32);
      for (var j = 0; j < r.n; j++) {
        var q = p - j * .3; if (q <= 0 || q >= 1) continue;
        var rad = r0 + X(r.max) * (1 - Math.pow(1 - q, 2.4)), al = r.a * Math.pow(1 - q, 1.5) * (1 - j * .3), wob = .008 + .026 * q, lw = Math.max(.7, l.w / 115 * 1.3 * sc / .67);
        ripRing(cx, cy + lw, rad, al, r.ph, wob, true, lw * 1.1); ripRing(cx, cy, rad, al, r.ph, wob, false, q < .25 ? lw * 1.3 : lw);
      }
    });
    RP = RP.filter(function (r) { return r.t < r.life * 1.5; });
    ctx.globalCompositeOperation = 'lighter';
    tw.forEach(function (s) { var a = Math.pow(Math.max(0, Math.sin(t / 1000 * s.sp + s.ph)), 3) * .8; if (a > .02) dot(X(s.x), Y(s.y), s.s * sc * 1.6, a); });
    drops.forEach(function (d) {
      d.y += d.v; if (d.y > 365) { d.y = d.y0; d.x = d.x + rnd(-4, 4); } var f = Math.min(1, (d.y - d.y0) / 40) * Math.min(1, (365 - d.y) / 60);
      glow(X(d.x), Y(d.y), 5 * sc * 1.6, d.o * f * .35); dot(X(d.x), Y(d.y), .8, d.o * f);
    });
    motes.forEach(function (m) {
      m.u += m.v; if (m.u > 1) m.u = 0; var p = on(R, m.u), a = m.o * Math.min(1, m.u * 5) * Math.min(1, (1 - m.u) * 5), k = .4 + m.u * .9;
      var x = X(p[0] + m.w * k), y = Y(p[1]); glow(x, y, m.s * 6 * k, a * .4); dot(x, y, m.s * .75 * k, a * .85);
    });
    glints.forEach(function (g) {
      g.u += g.v; if (g.u > 1) g.u = 0; var p = on(g.P, g.u), a = Math.min(1, g.u * 6) * Math.min(1, (1 - g.u) * 6), k = .5 + g.u * .8;
      glow(X(p[0]), Y(p[1]), 9 * k * g.s * sc * 1.6, a * .35); dot(X(p[0]), Y(p[1]), 1 * k, a * .9);
    });
    ups.forEach(function (p) {
      p.y -= p.v; if (p.y < 380) p.y = IH; var a = p.o * (.5 + .5 * Math.sin(t / 700 + p.ph)) * Math.min(1, (p.y - 380) / 120);
      ctx.fillStyle = 'rgba(255,215,210,' + a + ')'; ctx.beginPath(); ctx.arc(X(p.x + Math.sin(t / 1400 + p.ph) * 10), Y(p.y), 1, 0, 7); ctx.fill();
    });
    L.forEach(function (l, k) {
      var b = .5 + .5 * Math.sin(t / 1400 + k * 2.1), r = l.w * sc * (1.05 + b * .15) * (l.on ? 1.35 : 1);
      glow(X(l.x + (l.dx || 0)), Y(l.y + (l.dy || 0)), r, (l.on ? .55 : .2) + b * .14);
    });
    ctx.globalCompositeOperation = 'screen';
    mist.forEach(function (m) {
      m.x += m.v; if (m.x > 1.4) m.x = -.4; var g = ctx.createLinearGradient((m.x - m.w) * W, 0, (m.x + m.w) * W, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(236,240,245,' + m.o + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect((m.x - m.w) * W, m.y * H - m.h * H / 2, m.w * 2 * W, m.h * H);
    });
    ctx.globalCompositeOperation = 'source-over';
  }
  function follow() { L.forEach(function (l) { var tr = X(l.dx || 0) + 'px ' + Y(l.dy || 0) + 'px'; l.hit.style.translate = tr; l.tg.style.translate = tr; }); }
  function loop(t) {
    if (!room.classList.contains('open')) { running = false; inner.classList.remove('open'); return; }
    if (room.clientWidth !== room._fw || room.clientHeight !== room._fh) fit();
    draw(t || 0); follow(); requestAnimationFrame(loop);
  }

  window.openWangchuan = function () {
    if (!built) build();
    room.classList.add('open'); hideNames(); inner.classList.remove('open');
    requestAnimationFrame(function () { fit(); if (!running) { running = true; RPL = 0; requestAnimationFrame(loop); } });
  };
})();
