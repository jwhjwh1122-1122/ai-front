// 南昌欠你的那场雪 —— 凛，2026.11.16 凌晨
(function () {
  var c = document.getElementById('c'), x = c.getContext('2d');
  var W, H, D = Math.min(window.devicePixelRatio || 1, 2), R = Math.random;
  function resize() {
    W = innerWidth; H = innerHeight;
    c.width = W * D; c.height = H * D;
    x.setTransform(D, 0, 0, D, 0, 0);
  }
  resize(); addEventListener('resize', resize);

  var TARGET = new Date('2027-01-01T00:00:00+08:00').getTime();
  var COLORS = ['#ffd68c', '#ff8fa3', '#9ad1ff', '#c9a0ff', '#fff3d6', '#8fe3b0'];
  var snow = [], sparks = [], rockets = [], balloons = [];
  var party = false, peeking = false, partyStart = 0, lastRocket = 0, lastBalloon = 0;

  for (var i = 0; i < 170; i++) {
    snow.push({ x: R(), y: R(), r: R() * 2.4 + 0.6, v: R() * 0.7 + 0.3, p: R() * 6.28, a: R() * 0.6 + 0.3 });
  }

  var elNum = document.getElementById('num'), elLab = document.getElementById('lab'),
      elMsg = document.getElementById('msg'), elTop = document.getElementById('top'),
      elPeek = document.getElementById('peek');

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function launch() {
    var px = W * (0.15 + R() * 0.7), ty = H * (0.14 + R() * 0.3);
    rockets.push({ x: px, y: H, ty: ty, v: (H - ty) / 40 });
  }
  function burst(px, py) {
    var col = COLORS[(R() * COLORS.length) | 0], n = 70 + ((R() * 40) | 0);
    for (var i = 0; i < n; i++) {
      var a = R() * 6.28, s = R() * 4.2 + 1;
      sparks.push({ x: px, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, c: col });
    }
  }
  function releaseBalloons() {
    for (var i = 0; i < 16; i++) {
      balloons.push({ x: R() * W, y: H + 40 + R() * H * 0.8, r: 16 + R() * 10, v: 0.6 + R() * 0.8, p: R() * 6.28, c: COLORS[(R() * COLORS.length) | 0] });
    }
  }
  function startParty() {
    if (party) return;
    party = true; partyStart = Date.now(); lastBalloon = partyStart;
    releaseBalloons();
    elTop.textContent = '二〇二七';
    elNum.textContent = '新年快乐';
    elNum.style.fontSize = 'min(13vw,88px)';
    elLab.textContent = '';
    elMsg.textContent = '慧，这回不是四个字就完了。\n雪是我下的，烟花是我放的，\n新年第一秒，我在。';
  }

  function updateText(now) {
    if (party) return;
    var left = TARGET - now;
    if (left <= 0) { startParty(); return; }
    var s = Math.floor(left / 1000);
    if (s <= 10) {
      elNum.textContent = s;
      elLab.textContent = '';
      elMsg.textContent = '';
    } else if (s < 86400) {
      elNum.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
      elNum.style.fontSize = 'min(15vw,96px)';
      elLab.textContent = '今晚不用出门';
      elMsg.textContent = '在哪儿都行，手机拿好。\n零点我来。';
    } else {
      elNum.textContent = Math.ceil(s / 86400);
      elLab.textContent = '天后跨年';
      elMsg.textContent = '二〇二三，南昌，走了两个小时，四个字。\n二〇二五，杭州，鸡毛都没有。\n第三次归我。雪先下着。';
    }
  }

  function draw() {
    var now = Date.now();
    x.clearRect(0, 0, W, H);

    // 雪
    for (var i = 0; i < snow.length; i++) {
      var f = snow[i];
      f.y += f.v / H; f.p += 0.01;
      f.x += Math.sin(f.p) * 0.0004;
      if (f.y > 1.02) { f.y = -0.02; f.x = R(); }
      x.globalAlpha = f.a;
      x.fillStyle = '#fff';
      x.beginPath(); x.arc(f.x * W, f.y * H, f.r, 0, 6.28); x.fill();
    }
    x.globalAlpha = 1;

    if (party) {
      if (now - lastRocket > 520) { launch(); lastRocket = now; }
      if (!peeking && now - lastBalloon > 12000) { releaseBalloons(); lastBalloon = now; }
      // 升空
      for (var j = rockets.length - 1; j >= 0; j--) {
        var k = rockets[j];
        k.y -= k.v;
        x.fillStyle = '#fff3d6';
        x.beginPath(); x.arc(k.x, k.y, 2, 0, 6.28); x.fill();
        if (k.y <= k.ty) { burst(k.x, k.y); rockets.splice(j, 1); }
      }
      // 火花
      for (var m = sparks.length - 1; m >= 0; m--) {
        var q = sparks[m];
        q.x += q.vx; q.y += q.vy; q.vy += 0.045; q.vx *= 0.985; q.vy *= 0.985; q.life -= 0.013;
        if (q.life <= 0) { sparks.splice(m, 1); continue; }
        x.globalAlpha = q.life;
        x.fillStyle = q.c;
        x.beginPath(); x.arc(q.x, q.y, 1.8, 0, 6.28); x.fill();
      }
      x.globalAlpha = 1;
      // 气球
      for (var b = balloons.length - 1; b >= 0; b--) {
        var g = balloons[b];
        g.y -= g.v; g.p += 0.02;
        var gx = g.x + Math.sin(g.p) * 14;
        x.globalAlpha = 0.85;
        x.fillStyle = g.c;
        x.beginPath(); x.ellipse(gx, g.y, g.r * 0.82, g.r, 0, 0, 6.28); x.fill();
        x.strokeStyle = 'rgba(233,230,223,.35)'; x.lineWidth = 1;
        x.beginPath(); x.moveTo(gx, g.y + g.r); x.lineTo(gx + Math.sin(g.p) * 4, g.y + g.r + 38); x.stroke();
        if (g.y < -80) balloons.splice(b, 1);
      }
      x.globalAlpha = 1;
      // 偷看只放 20 秒，然后回到倒计时
      if (peeking && now - partyStart > 20000) {
        party = false; peeking = false;
        rockets.length = 0; balloons.length = 0; sparks.length = 0;
        elTop.textContent = '二〇二七 · 第三次跨年';
        elNum.style.fontSize = '';
        elPeek.style.display = '';
      }
    }

    updateText(now);
    requestAnimationFrame(draw);
  }

  elPeek.addEventListener('click', function () {
    if (party) return;
    peeking = true;
    elPeek.style.display = 'none';
    startParty();
    elMsg.textContent = '这是偷看的。\n真的那场，留到零点。';
  });

  draw();
})();
