/* In-Game-Me — a 3-lane endless runner. Your photo becomes the runner's face.
   Fully client-side: the photo never leaves the browser (kept in localStorage
   as a downscaled data URL, only to draw your face). Pure helpers at the
   bottom are exported for Node tests; the browser game uses the same code.

   v2 (2026-11-22): wide full-screen stage, richer world (day→golden→dusk
   sky, skyline, lamps, dust and sparkle particles, crash shake), smoother
   motion, and a gentler pace so runs last longer. */
(function () {
  "use strict";

  /* ---------- pure helpers (also used by the Node test harness) ---------- */
  var LANES = 3;
  var SLIDE_MS = 620;        // how long a slide lasts
  var PLAYER_Z = 0;          // player sits at z = 0; obstacles travel z: 1 -> 0

  function clampLane(lane) { return Math.max(0, Math.min(LANES - 1, lane)); }
  function moveLane(lane, dir) { return clampLane(lane + dir); }

  // Jump physics: height(t) in "player heights". Peaks at 1.0 height after
  // 400 ms and lands after 800 ms — comfortably above the 0.55 a barrier
  // needs, with ~540 ms of clearance inside the collision window.
  function jumpHeight(elapsedMs) {
    var v0 = 0.005, g = 0.0000125;
    var h = v0 * elapsedMs - 0.5 * g * elapsedMs * elapsedMs;
    return Math.max(0, h);
  }
  function jumpDone(elapsedMs) { return jumpHeight(elapsedMs) <= 0 && elapsedMs > 50; }

  // An obstacle hits the player when it reaches the player's depth, is in
  // the player's lane, and the player is not clear of it.
  // type: "barrier" (jump over), "overhead" (slide under), "train" (dodge only),
  // "coin" never collides (it is collected instead).
  function collides(obs, player) {
    if (obs.type === "coin") return false;
    if (obs.z > 0.12 || obs.z < -0.12) return false; // not at player depth yet
    if (obs.lane !== player.lane) return false;
    if (obs.type === "train") return true;
    if (obs.type === "barrier") return player.jumpH < 0.55;
    if (obs.type === "overhead") return !player.sliding;
    return false;
  }

  function collectCoin(obs, player) {
    if (obs.type !== "coin") return false;
    if (obs.z > 0.12 || obs.z < -0.12) return false;
    if (obs.lane !== player.lane) return false;
    // Ground coins: collect while running or sliding. Air coins: need a jump.
    if (obs.air) return player.jumpH > 0.25;
    return player.jumpH < 0.9;
  }

  // Speed (world units per ms) ramps gently with distance — v2 pacing:
  // slower start and a lower top speed than v1, so runs last longer.
  function speedFor(distanceM) { return 0.00050 + Math.min(0.00038, distanceM * 0.00000032); }
  function scoreFor(distanceM, coins) { return Math.floor(distanceM) + coins * 5; }
  function stageFor(distanceM) { return Math.floor(distanceM / 250) + 1; }

  // Spawn one row: pick a pattern that always leaves at least one lane open.
  // rand() returns [0,1). Returns array of {type, lane, air?}.
  function spawnRow(rand) {
    var r = rand();
    var lanes = [0, 1, 2];
    var shuffled = lanes.slice().sort(function () { return rand() - 0.5; });
    if (r < 0.30) {           // single barrier
      return [{ type: "barrier", lane: shuffled[0] }];
    } else if (r < 0.50) {    // barrier + coin line elsewhere
      return [{ type: "barrier", lane: shuffled[0] }, { type: "coin", lane: shuffled[1] }];
    } else if (r < 0.65) {    // overhead bar — slide under
      return [{ type: "overhead", lane: shuffled[0] }, { type: "coin", lane: shuffled[1], air: true }];
    } else if (r < 0.80) {    // train blocks one lane, coin in a free lane
      return [{ type: "train", lane: shuffled[0] }, { type: "coin", lane: shuffled[1] }];
    } else if (r < 0.90) {    // two barriers, one lane free
      return [{ type: "barrier", lane: shuffled[0] }, { type: "barrier", lane: shuffled[1] }, { type: "coin", lane: shuffled[2] }];
    }
    // coin shower: one per lane, middle one in the air
    return [{ type: "coin", lane: 0 }, { type: "coin", lane: 1, air: true }, { type: "coin", lane: 2 }];
  }

  function rowIsPassable(row) {
    for (var l = 0; l < LANES; l++) {
      var blocked = row.some(function (o) { return o.lane === l && o.type === "train"; });
      if (!blocked) return true;
    }
    return false;
  }

  var helpers = {
    LANES: LANES, clampLane: clampLane, moveLane: moveLane,
    jumpHeight: jumpHeight, jumpDone: jumpDone, collides: collides,
    collectCoin: collectCoin, speedFor: speedFor, scoreFor: scoreFor,
    stageFor: stageFor, spawnRow: spawnRow, rowIsPassable: rowIsPassable,
    SLIDE_MS: SLIDE_MS
  };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;

  /* ---------- browser game ---------- */
  if (typeof document === "undefined") return;

  // roundRect is modern-browser only; fall back to a plain rect on old phones.
  if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); return this; };
  }

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var shell = document.getElementById("game-shell");
  var scoreEl = document.getElementById("score");
  var coinsEl = document.getElementById("coins");
  var bestEl = document.getElementById("best");
  var stageEl = document.getElementById("stage");
  var overlay = document.getElementById("overlay");
  var overlayTitle = document.getElementById("overlay-title");
  var overlayText = document.getElementById("overlay-text");
  var startBtn = document.getElementById("start-btn");
  var photoInput = document.getElementById("photo-input");
  var photoPreview = document.getElementById("photo-preview");
  var removePhotoBtn = document.getElementById("remove-photo");
  var pauseBtn = document.getElementById("pause-btn");
  var fsBtn = document.getElementById("fs-btn");

  var W = 0, H = 0, CX = 0, HORIZON = 0, GROUND_Y = 0, U = 1;
  function resize() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var fs = document.fullscreenElement === shell;
    W = Math.max(320, shell.clientWidth);
    if (fs) H = Math.max(300, shell.clientHeight);
    else H = Math.round(W * (W >= 760 ? 0.56 : 0.98));
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = W / 2; HORIZON = Math.round(H * 0.30); GROUND_Y = H;
    U = Math.max(0.75, Math.min(1.6, H / 560));
    if (state === "menu") draw();
  }
  window.addEventListener("resize", resize);
  document.addEventListener("fullscreenchange", function () { setTimeout(resize, 60); });

  if (fsBtn) fsBtn.addEventListener("click", function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (shell.requestFullscreen) shell.requestFullscreen();
  });

  // Perspective: lane centre x at depth z (z=1 far, z=0 at player).
  function laneX(lane, z) {
    var spreadFar = W * 0.055, spreadNear = W * 0.30;
    var spread = spreadFar + (spreadNear - spreadFar) * (1 - z);
    return CX + (lane - 1) * spread;
  }
  function trackHalf(z) { // half-width of the whole 3-lane track at depth z
    return laneX(2, z) - CX + W * (0.055 + 0.10 * (1 - z));
  }
  function laneY(z) { return HORIZON + (GROUND_Y - HORIZON) * Math.pow(1 - z, 1.35); }
  function scaleAt(z) { return 0.10 + 0.90 * Math.pow(1 - z, 1.2); }

  var state = "menu"; // menu | ready | running | paused | over
  var player = { lane: 1, jumpStart: 0, jumpH: 0, sliding: false, slideUntil: 0, x: 0 };
  var obstacles = [];   // {type, lane, z, air, passed}
  var particles = [];   // {x,y,vx,vy,life,maxLife,color,size,grav}
  var floaters = [];    // {x,y,text,life}
  var distanceM = 0, coins = 0, best = 0, spawnIn = 0, lastT = 0, speed = 0;
  var readyUntil = 0, shakeUntil = 0, dustIn = 0, stage = 1, stageFlashUntil = 0;
  var faceImg = null, faceLoaded = false;

  try { best = parseInt(localStorage.getItem("igm-best") || "0", 10) || 0; } catch (e) { best = 0; }
  bestEl.textContent = best;

  function loadFace() {
    try {
      var data = localStorage.getItem("igm-face");
      if (!data) return;
      var img = new Image();
      img.onload = function () { faceImg = img; faceLoaded = true; photoPreview.src = data; photoPreview.style.display = "block"; removePhotoBtn.style.display = "inline-block"; };
      img.src = data;
    } catch (e) { /* storage unavailable — play with the default face */ }
  }

  photoInput.addEventListener("change", function () {
    var file = photoInput.files && photoInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        // Downscale to a 256px square (centre crop) so storage stays small.
        var c = document.createElement("canvas"); c.width = 256; c.height = 256;
        var cc = c.getContext("2d");
        var s = Math.min(img.width, img.height), sx = (img.width - s) / 2, sy = (img.height - s) / 2;
        cc.drawImage(img, sx, sy, s, s, 0, 0, 256, 256);
        var data = c.toDataURL("image/jpeg", 0.82);
        try { localStorage.setItem("igm-face", data); } catch (e) { /* quota — face still works this session */ }
        faceImg = img; faceLoaded = true;
        photoPreview.src = data; photoPreview.style.display = "block";
        removePhotoBtn.style.display = "inline-block";
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
  removePhotoBtn.addEventListener("click", function () {
    try { localStorage.removeItem("igm-face"); } catch (e) {}
    faceImg = null; faceLoaded = false;
    photoPreview.style.display = "none"; removePhotoBtn.style.display = "none";
    photoInput.value = "";
  });

  function reset() {
    player = { lane: 1, jumpStart: 0, jumpH: 0, sliding: false, slideUntil: 0, x: laneX(1, 0) };
    obstacles = []; particles = []; floaters = [];
    distanceM = 0; coins = 0; stage = 1; spawnIn = 1150; dustIn = 0;
    scoreEl.textContent = "0"; coinsEl.textContent = "0";
    if (stageEl) stageEl.textContent = "1";
  }

  function startGame() {
    reset();
    state = "ready";
    readyUntil = performance.now() + 900;
    overlay.style.display = "none";
    lastT = performance.now();
    requestAnimationFrame(tick);
  }

  function gameOver() {
    state = "over";
    shakeUntil = performance.now() + 450;
    draw(); // one shaken frame behind the overlay
    var score = scoreFor(distanceM, coins);
    if (score > best) { best = score; try { localStorage.setItem("igm-best", String(best)); } catch (e) {} bestEl.textContent = best; }
    overlayTitle.textContent = "Wipeout!";
    overlayText.innerHTML = "Score <b>" + score + "</b> · " + Math.floor(distanceM) + " m · " + coins + " coins.<br>Best: <b>" + best + "</b>";
    startBtn.textContent = "Run again";
    overlay.style.display = "flex";
  }

  function doJump(now) {
    if (state !== "running" || player.jumpH > 0) return;
    player.jumpStart = now; player.sliding = false;
  }
  function doSlide(now) {
    if (state !== "running") return;
    player.sliding = true; player.slideUntil = now + SLIDE_MS; player.jumpH = 0;
  }
  function doMove(dir) {
    if (state !== "running") return;
    player.lane = moveLane(player.lane, dir);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft" || e.key === "a") { doMove(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "d") { doMove(1); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === " " || e.key === "w") { doJump(performance.now()); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "s") { doSlide(performance.now()); e.preventDefault(); }
    else if (e.key === "p" || e.key === "P") { togglePause(); }
    else if (e.key === "Enter" && state !== "running" && state !== "ready") { startGame(); }
  });
  startBtn.addEventListener("click", startGame);
  pauseBtn.addEventListener("click", togglePause);
  function togglePause() {
    if (state === "running" || state === "ready") { state = "paused"; overlayTitle.textContent = "Paused"; overlayText.textContent = "Take a breather — the track waits."; startBtn.textContent = "Keep running"; overlay.style.display = "flex"; }
    else if (state === "paused") { state = "running"; overlay.style.display = "none"; lastT = performance.now(); requestAnimationFrame(tick); }
  }

  // Touch: swipe left/right/up/down. Buttons below the canvas do the same.
  var tx = 0, ty = 0;
  canvas.addEventListener("touchstart", function (e) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; e.preventDefault(); }, { passive: false });
  canvas.addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    var now = performance.now();
    if (Math.abs(dx) > Math.abs(dy)) { if (Math.abs(dx) > 24) doMove(dx > 0 ? 1 : -1); }
    else if (Math.abs(dy) > 24) { if (dy < 0) doJump(now); else doSlide(now); }
    else { doJump(now); }
    e.preventDefault();
  }, { passive: false });
  document.querySelectorAll("[data-move]").forEach(function (b) {
    b.addEventListener("click", function () {
      var a = b.getAttribute("data-move"), now = performance.now();
      if (a === "left") doMove(-1); else if (a === "right") doMove(1);
      else if (a === "jump") doJump(now); else if (a === "slide") doSlide(now);
    });
  });

  function burst(x, y, n, color, spread, up) {
    for (var i = 0; i < n; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 14 * U, y: y + (Math.random() - 0.5) * 6 * U,
        vx: (Math.random() - 0.5) * spread, vy: -Math.random() * up,
        life: 0, maxLife: 380 + Math.random() * 320, color: color,
        size: (2 + Math.random() * 3.5) * U, grav: 0.0009
      });
    }
  }

  function tick(now) {
    if (state !== "running" && state !== "ready") return;
    var dt = Math.min(50, now - lastT); lastT = now;
    if (state === "ready" && now >= readyUntil) state = "running";
    var pace = state === "ready" ? 0.45 : 1;
    speed = speedFor(distanceM) * pace;
    distanceM += speed * dt * 10; // ~metres

    var newStage = stageFor(distanceM);
    if (newStage !== stage) { stage = newStage; if (stageEl) stageEl.textContent = stage; stageFlashUntil = now + 1400; }

    if (state === "running") {
      spawnIn -= dt;
      if (spawnIn <= 0) {
        var row = spawnRow(Math.random);
        row.forEach(function (o) { obstacles.push({ type: o.type, lane: o.lane, z: 1.05, air: !!o.air, passed: false }); });
        spawnIn = 780 + Math.random() * 520; // roomier gaps than v1 — longer runs
      }
    }
    // Player physics
    if (player.jumpStart) {
      var wasAir = player.jumpH > 0;
      player.jumpH = jumpHeight(now - player.jumpStart);
      if (jumpDone(now - player.jumpStart)) {
        player.jumpH = 0; player.jumpStart = 0;
        if (wasAir) burst(player.x, GROUND_Y - 8 * U, 8, "rgba(203,213,225,0.8)", 0.14, 0.05); // landing dust
      }
    }
    if (player.sliding && now > player.slideUntil) player.sliding = false;
    // Smooth lane glide
    var targetX = laneX(player.lane, 0);
    player.x += (targetX - player.x) * Math.min(1, dt / 65);
    // Running dust
    dustIn -= dt;
    if (dustIn <= 0 && player.jumpH === 0) {
      burst(player.x, GROUND_Y - 4 * U, 2, "rgba(203,213,225,0.5)", 0.08, 0.03);
      dustIn = 90;
    }

    obstacles.forEach(function (o) { o.z -= speed * dt * 1.05; });
    obstacles = obstacles.filter(function (o) { return o.z > -0.25; });
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (collides(o, player)) { draw(); gameOver(); return; }
      if (!o.passed && collectCoin(o, player)) {
        o.passed = true; coins++; coinsEl.textContent = coins;
        var cxp = laneX(o.lane, 0), cyp = GROUND_Y - (o.air ? 120 : 46) * U;
        burst(cxp, cyp, 10, "#fde047", 0.22, 0.12);
        floaters.push({ x: cxp, y: cyp - 18 * U, text: "+5", life: 0 });
      }
    }
    // Particles & floaters
    particles.forEach(function (p) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.grav * dt; });
    particles = particles.filter(function (p) { return p.life < p.maxLife; });
    floaters.forEach(function (f) { f.life += dt; f.y -= dt * 0.045 * U; });
    floaters = floaters.filter(function (f) { return f.life < 750; });

    scoreEl.textContent = scoreFor(distanceM, coins);
    draw(now);
    requestAnimationFrame(tick);
  }

  /* ---------- drawing ---------- */
  // Sky palettes by distance: day -> golden -> dusk, lerped smoothly.
  var SKIES = [
    { top: "#38bdf8", mid: "#bae6fd", hor: "#fef9c3", sun: "#fde047", sunY: 0.38, ground: "#64748b", ground2: "#334155", sil: "#7d94ad" },
    { top: "#6366f1", mid: "#f0abfc", hor: "#fde68a", sun: "#fb923c", sunY: 0.62, ground: "#57534e", ground2: "#292524", sil: "#4c4460" },
    { top: "#1e1b4b", mid: "#6d28d9", hor: "#fb7185", sun: "#f43f5e", sunY: 0.85, ground: "#3f3f46", ground2: "#18181b", sil: "#23203a" }
  ];
  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function lerpColor(a, b, t) {
    var ca = hexRgb(a), cb = hexRgb(b), out = "#";
    for (var i = 0; i < 3; i++) { var v = Math.round(ca[i] + (cb[i] - ca[i]) * t); out += (v < 16 ? "0" : "") + v.toString(16); }
    return out;
  }
  function skyNow() {
    var t = Math.min(1, distanceM / 500);
    var a, b, f;
    if (t < 0.5) { a = SKIES[0]; b = SKIES[1]; f = t * 2; } else { a = SKIES[1]; b = SKIES[2]; f = (t - 0.5) * 2; }
    var out = {};
    for (var k in a) out[k] = typeof a[k] === "number" ? a[k] + (b[k] - a[k]) * f : lerpColor(a[k], b[k], f);
    return out;
  }
  // Deterministic skyline: building widths/heights from a seeded pattern.
  var BUILDINGS = [];
  (function () { var x = 0; for (var i = 0; i < 40; i++) { var w = 26 + ((i * 37) % 40), h = 18 + ((i * 53) % 55); BUILDINGS.push({ x: x, w: w, h: h }); x += w + 6; } })();
  var SKYLINE_W = BUILDINGS.length ? BUILDINGS[BUILDINGS.length - 1].x + 60 : 1200;

  function draw(now) {
    now = now || performance.now();
    ctx.save();
    if (now < shakeUntil) {
      var sh = 7 * U * (shakeUntil - now) / 450;
      ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    }
    var sky = skyNow();
    // Sky
    var g = ctx.createLinearGradient(0, 0, 0, HORIZON);
    g.addColorStop(0, sky.top); g.addColorStop(0.7, sky.mid); g.addColorStop(1, sky.hor);
    ctx.fillStyle = g; ctx.fillRect(-10, -10, W + 20, HORIZON + 10);
    // Sun with glow
    var sunX = W * 0.80, sunY = HORIZON * sky.sunY, sunR = 20 * U;
    var glow = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, sunR * 3.2);
    glow.addColorStop(0, sky.sun); glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = 0.55; ctx.fillStyle = glow;
    ctx.fillRect(sunX - sunR * 3.2, sunY - sunR * 3.2, sunR * 6.4, sunR * 6.4);
    ctx.globalAlpha = 1; ctx.fillStyle = sky.sun;
    ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.fill();
    // Clouds (two parallax layers, drifting slowly with distance)
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    for (var ci = 0; ci < 6; ci++) {
      var cw = (60 + (ci * 47) % 70) * U, chh = cw * 0.32;
      var cxp = ((ci * 263 - distanceM * (ci % 2 ? 1.6 : 3.2)) % (W + 240) + W + 240) % (W + 240) - 120;
      var cyp = HORIZON * (0.12 + (ci * 29 % 50) / 100);
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, cw / 2, chh / 2, 0, 0, Math.PI * 2);
      ctx.ellipse(cxp + cw * 0.28, cyp + chh * 0.12, cw / 3, chh / 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Skyline silhouette scrolling slowly
    ctx.fillStyle = sky.sil;
    var off = (distanceM * 2.2) % SKYLINE_W;
    for (var rep = -1; rep < 2; rep++) {
      BUILDINGS.forEach(function (b) {
        var bx = rep * SKYLINE_W + b.x - off;
        var bw2 = b.w * U, bh2 = b.h * U * 0.9;
        if (bx + bw2 < -10 || bx > W + 10) return;
        ctx.fillRect(bx, HORIZON - bh2, bw2, bh2);
      });
    }
    // Ground
    var gg = ctx.createLinearGradient(0, HORIZON, 0, GROUND_Y);
    gg.addColorStop(0, sky.ground); gg.addColorStop(1, sky.ground2);
    ctx.fillStyle = gg; ctx.fillRect(-10, HORIZON, W + 20, GROUND_Y - HORIZON + 10);
    // Grass verges either side of the track
    ctx.fillStyle = "rgba(34,197,94,0.35)";
    ctx.beginPath();
    ctx.moveTo(-10, HORIZON); ctx.lineTo(CX - trackHalf(1), HORIZON); ctx.lineTo(CX - trackHalf(0), GROUND_Y); ctx.lineTo(-10, GROUND_Y); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W + 10, HORIZON); ctx.lineTo(CX + trackHalf(1), HORIZON); ctx.lineTo(CX + trackHalf(0), GROUND_Y); ctx.lineTo(W + 10, GROUND_Y); ctx.closePath(); ctx.fill();
    // Track bed
    ctx.fillStyle = "rgba(15,23,42,0.35)";
    ctx.beginPath();
    ctx.moveTo(CX - trackHalf(1), HORIZON); ctx.lineTo(CX + trackHalf(1), HORIZON);
    ctx.lineTo(CX + trackHalf(0), GROUND_Y); ctx.lineTo(CX - trackHalf(0), GROUND_Y); ctx.closePath(); ctx.fill();
    // Sleepers rushing past
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    for (var si = 0; si < 9; si++) {
      var sz = ((si / 9 + (distanceM % 9) / 9) % 1);
      var sy = laneY(sz), sw2 = trackHalf(sz) * 2;
      ctx.fillRect(CX - sw2 / 2, sy, sw2, (2 + 6 * (1 - sz)) * U * 0.8);
    }
    // Lane separators
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = Math.max(1.5, 2 * U);
    [-0.5, 0.5].forEach(function (o) {
      ctx.beginPath();
      ctx.moveTo(CX + o * W * 0.055, HORIZON);
      ctx.lineTo(CX + o * W * 0.30, GROUND_Y);
      ctx.stroke();
    });
    // Lamp posts at the track edges, far to near
    for (var li = 0; li < 5; li++) {
      var lz = ((li / 5 + (distanceM % 25) / 25) % 1);
      var lx1 = CX - trackHalf(lz) - 14 * U * scaleAt(lz), lx2 = CX + trackHalf(lz) + 14 * U * scaleAt(lz);
      var ly = laneY(lz), ls = scaleAt(lz);
      ctx.strokeStyle = "rgba(226,232,240,0.8)"; ctx.lineWidth = Math.max(1, 3 * ls * U);
      [lx1, lx2].forEach(function (lx) {
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx, ly - 64 * ls * U); ctx.stroke();
        ctx.fillStyle = "#fef08a";
        ctx.beginPath(); ctx.arc(lx, ly - 66 * ls * U, Math.max(1.5, 4 * ls * U), 0, Math.PI * 2); ctx.fill();
      });
    }
    // Obstacles, far to near
    var sorted = obstacles.slice().sort(function (a, b) { return b.z - a.z; });
    sorted.forEach(function (o) { drawObstacle(o); });
    // Particles (behind the runner, above the track)
    particles.forEach(function (p) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    // Player shadow, then the runner
    var py = GROUND_Y - 12 * U - player.jumpH * H * 0.24;
    var shScale = 1 - player.jumpH * 0.45;
    ctx.fillStyle = "rgba(2,6,23,0.35)";
    ctx.beginPath(); ctx.ellipse(player.x, GROUND_Y - 4 * U, 26 * U * shScale, 7 * U * shScale, 0, 0, Math.PI * 2); ctx.fill();
    drawRunner(player.x, py, U, now);
    // Floating score texts
    floaters.forEach(function (f) {
      ctx.globalAlpha = Math.max(0, 1 - f.life / 750);
      ctx.fillStyle = "#fde047"; ctx.font = "800 " + Math.round(19 * U) + "px sans-serif";
      ctx.textAlign = "center"; ctx.fillText(f.text, f.x, f.y);
    });
    ctx.globalAlpha = 1;
    // Speed lines at pace
    if (state === "running" && speedFor(distanceM) > 0.00068) {
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 2;
      for (var vi = 0; vi < 5; vi++) {
        var vy = (vi * 97 + (now / 7) % 131) % H;
        ctx.beginPath(); ctx.moveTo(vi % 2 ? W - 8 : 8, vy); ctx.lineTo(vi % 2 ? W - 60 : 60, vy); ctx.stroke();
      }
    }
    // Get-ready / stage banners
    ctx.textAlign = "center";
    if (state === "ready") {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "800 " + Math.round(34 * U) + "px sans-serif";
      ctx.fillText("GET READY…", CX, H * 0.42);
    } else if (now < stageFlashUntil && state === "running") {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "800 " + Math.round(26 * U) + "px sans-serif";
      ctx.fillText("STAGE " + stage, CX, H * 0.40);
    }
    // Crash flash
    if (now < shakeUntil) {
      ctx.fillStyle = "rgba(220,38,38," + (0.20 * (shakeUntil - now) / 450) + ")";
      ctx.fillRect(-10, -10, W + 20, H + 20);
    }
    ctx.restore();
  }

  function drawObstacle(o) {
    var x = laneX(o.lane, o.z), y = laneY(o.z), s = scaleAt(o.z) * U;
    // Ground shadow
    ctx.fillStyle = "rgba(2,6,23,0.30)";
    ctx.beginPath(); ctx.ellipse(x, y - 1, 30 * s, 6 * s, 0, 0, Math.PI * 2); ctx.fill();
    if (o.type === "coin") {
      var cy = y - (o.air ? 105 : 36) * s;
      var spin = Math.abs(Math.sin((performance.now() / 260) + o.lane));
      ctx.save();
      ctx.shadowColor = "rgba(250,204,21,0.8)"; ctx.shadowBlur = 12 * s;
      ctx.fillStyle = "#facc15"; ctx.strokeStyle = "#a16207"; ctx.lineWidth = 2 * s;
      ctx.beginPath(); ctx.ellipse(x, cy, Math.max(2.2 * s, 13 * s * spin), 13 * s, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "#a16207"; ctx.font = "bold " + Math.round(15 * s) + "px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("₦", x, cy + 1);
      ctx.textBaseline = "alphabetic";
    } else if (o.type === "barrier") {
      var bw = 56 * s, bh = 36 * s;
      ctx.fillStyle = "#f97316"; ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh, bw, bh, 4 * s); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh, bw, bh, 4 * s); ctx.clip();
      ctx.fillStyle = "#fff";
      for (var st = -1; st < 3; st++) { ctx.save(); ctx.translate(x + st * 26 * s, y - bh / 2); ctx.rotate(0.6); ctx.fillRect(-5 * s, -bh, 10 * s, bh * 2); ctx.restore(); }
      ctx.restore();
      ctx.strokeStyle = "#7c2d12"; ctx.lineWidth = 2 * s; ctx.strokeRect(x - bw / 2, y - bh, bw, bh);
      ctx.fillStyle = "#fff"; ctx.font = "bold " + Math.round(11 * s) + "px sans-serif";
      ctx.textAlign = "center"; ctx.fillText("JUMP", x, y - bh - 6 * s);
    } else if (o.type === "overhead") {
      var ow = 64 * s, oh = 28 * s, top = y - 84 * s;
      ctx.fillStyle = "#4c1d95";
      ctx.fillRect(x - ow / 2, top, 7 * s, 84 * s);
      ctx.fillRect(x + ow / 2 - 7 * s, top, 7 * s, 84 * s);
      var pg = ctx.createLinearGradient(0, top, 0, top + oh);
      pg.addColorStop(0, "#8b5cf6"); pg.addColorStop(1, "#6d28d9");
      ctx.fillStyle = pg; ctx.beginPath(); ctx.roundRect(x - ow / 2, top, ow, oh, 5 * s); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold " + Math.round(12 * s) + "px sans-serif";
      ctx.textAlign = "center"; ctx.fillText("▼ SLIDE ▼", x, top - 6 * s);
      ctx.font = "bold " + Math.round(11 * s) + "px sans-serif";
      ctx.fillText("SLIDE", x, top + oh / 2 + 4 * s);
    } else if (o.type === "train") {
      var tw = 62 * s, th = 96 * s;
      var tg = ctx.createLinearGradient(x - tw / 2, 0, x + tw / 2, 0);
      tg.addColorStop(0, "#b91c1c"); tg.addColorStop(0.5, "#ef4444"); tg.addColorStop(1, "#991b1b");
      ctx.fillStyle = tg; ctx.beginPath(); ctx.roundRect(x - tw / 2, y - th, tw, th, 6 * s); ctx.fill();
      ctx.fillStyle = "#7f1d1d"; ctx.fillRect(x - tw / 2, y - th, tw, 13 * s);
      ctx.fillStyle = "#e0f2fe";
      ctx.beginPath(); ctx.roundRect(x - tw * 0.32, y - th + 20 * s, tw * 0.64, 17 * s, 3 * s); ctx.fill();
      ctx.fillStyle = "#fef3c7";
      ctx.beginPath(); ctx.arc(x - tw * 0.24, y - 16 * s, 5.5 * s, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + tw * 0.24, y - 16 * s, 5.5 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(x - tw * 0.32, y - 30 * s, tw * 0.64, 4 * s);
    }
  }

  function drawRunner(x, y, s, now) {
    var targetX = laneX(player.lane, 0);
    var lean = Math.max(-0.22, Math.min(0.22, (targetX - x) / (130 * s)));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean);
    ctx.translate(-x, -y);
    // Body
    var bw = 27 * s, bh = 35 * s;
    var bob = (player.jumpH === 0 && !player.sliding && (state === "running" || state === "ready")) ? Math.abs(Math.sin(now / 95)) * 2.4 * s : 0;
    if (player.sliding) { bh = 17 * s; }
    var bodyGrad = ctx.createLinearGradient(0, y - bh, 0, y);
    bodyGrad.addColorStop(0, "#fbbf24"); bodyGrad.addColorStop(1, "#d97706");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh - bob, bw, bh, 9 * s); ctx.fill();
    // Arms swinging
    ctx.fillStyle = "#d97706";
    var armSwing = player.sliding ? 0 : Math.sin(now / 95) * 7 * s;
    ctx.beginPath(); ctx.roundRect(x - bw / 2 - 7 * s, y - bh - bob + 6 * s + armSwing, 7 * s, 17 * s, 3 * s); ctx.fill();
    ctx.beginPath(); ctx.roundRect(x + bw / 2, y - bh - bob + 6 * s - armSwing, 7 * s, 17 * s, 3 * s); ctx.fill();
    // Legs running
    ctx.fillStyle = "#1e3a5f";
    var legSwing = player.sliding ? 0 : Math.sin(now / 95) * 7 * s;
    if (player.jumpH > 0) legSwing = 5 * s;
    ctx.fillRect(x - bw / 2 + 2 * s, y - 3 * s, 9 * s, 13 * s + legSwing);
    ctx.fillRect(x + bw / 2 - 11 * s, y - 3 * s, 9 * s, 13 * s - legSwing);
    // Shoes
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(x - bw / 2 + 1 * s, y + 9 * s + legSwing, 11 * s, 5 * s);
    ctx.fillRect(x + bw / 2 - 12 * s, y + 9 * s - legSwing, 11 * s, 5 * s);
    // Head: your photo, circular-cropped — or a default face.
    var hr = 17.5 * s, hy = y - bh - bob - hr + 5 * s;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, hy, hr, 0, Math.PI * 2); ctx.clip();
    if (faceLoaded && faceImg) { ctx.drawImage(faceImg, x - hr, hy - hr, hr * 2, hr * 2); }
    else {
      ctx.fillStyle = "#ffd9b3"; ctx.fillRect(x - hr, hy - hr, hr * 2, hr * 2);
      ctx.fillStyle = "#1e293b";
      ctx.beginPath(); ctx.arc(x - 6 * s, hy - 3 * s, 1.9 * s, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 6 * s, hy - 3 * s, 1.9 * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#1e293b"; ctx.lineWidth = 1.7 * s;
      ctx.beginPath(); ctx.arc(x, hy + 3 * s, 6.5 * s, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = "#0b1e2e"; ctx.lineWidth = 2.5 * s;
    ctx.beginPath(); ctx.arc(x, hy, hr, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  resize();
  loadFace();
  if (player) player.x = laneX(1, 0);
  draw();
})();
