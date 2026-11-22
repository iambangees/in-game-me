/* In-Game-Me — a 3-lane endless runner. Your photo becomes the runner's face.
   Fully client-side: the photo never leaves the browser (kept in localStorage
   as a downscaled data URL, only to draw your face). Pure helpers at the
   bottom are exported for Node tests; the browser game uses the same code. */
(function () {
  "use strict";

  /* ---------- pure helpers (also used by the Node test harness) ---------- */
  var LANES = 3;
  var SLIDE_MS = 620;        // how long a slide lasts
  var PLAYER_Z = 0;          // player sits at z = 0; obstacles travel z: 1 -> 0

  function clampLane(lane) { return Math.max(0, Math.min(LANES - 1, lane)); }
  function moveLane(lane, dir) { return clampLane(lane + dir); }

  // Jump physics: height(t) in "player heights". Tuned so the jump peaks at
  // 1.0 height after 400 ms and lands after 800 ms — comfortably above the
  // 0.55 a barrier needs, with ~540 ms of clearance inside the ~370 ms
  // collision window an obstacle spends at the player's depth.
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

  // Speed (world units per ms) ramps with distance so the run gets harder.
  function speedFor(distanceM) { return 0.00062 + Math.min(0.00055, distanceM * 0.00000045); }
  function scoreFor(distanceM, coins) { return Math.floor(distanceM) + coins * 5; }

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
    spawnRow: spawnRow, rowIsPassable: rowIsPassable, SLIDE_MS: SLIDE_MS
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
  var scoreEl = document.getElementById("score");
  var coinsEl = document.getElementById("coins");
  var bestEl = document.getElementById("best");
  var overlay = document.getElementById("overlay");
  var overlayTitle = document.getElementById("overlay-title");
  var overlayText = document.getElementById("overlay-text");
  var startBtn = document.getElementById("start-btn");
  var photoInput = document.getElementById("photo-input");
  var photoPreview = document.getElementById("photo-preview");
  var removePhotoBtn = document.getElementById("remove-photo");
  var pauseBtn = document.getElementById("pause-btn");

  var W = 0, H = 0, CX = 0, HORIZON = 0, GROUND_Y = 0;
  function resize() {
    var rect = canvas.parentElement.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(320, Math.min(560, rect.width));
    H = Math.round(W * 1.5);
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = W / 2; HORIZON = Math.round(H * 0.22); GROUND_Y = H;
  }
  window.addEventListener("resize", resize);

  // Perspective: lane centre x at depth z (z=1 far, z=0 at player).
  function laneX(lane, z) {
    var spreadFar = W * 0.10, spreadNear = W * 0.34;
    var spread = spreadFar + (spreadNear - spreadFar) * (1 - z);
    return CX + (lane - 1) * spread;
  }
  function laneY(z) { return HORIZON + (GROUND_Y - HORIZON) * (1 - z); }
  function scaleAt(z) { return 0.12 + 0.88 * (1 - z); }

  var state = "menu"; // menu | running | paused | over
  var player = { lane: 1, jumpStart: 0, jumpH: 0, sliding: false, slideUntil: 0, x: 0 };
  var obstacles = [];   // {type, lane, z, air, passed}
  var distanceM = 0, coins = 0, best = 0, spawnIn = 0, lastT = 0, speed = 0;
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
    obstacles = []; distanceM = 0; coins = 0; spawnIn = 300;
    scoreEl.textContent = "0"; coinsEl.textContent = "0";
  }

  function startGame() {
    reset();
    state = "running";
    overlay.style.display = "none";
    lastT = performance.now();
    requestAnimationFrame(tick);
  }

  function gameOver() {
    state = "over";
    var score = scoreFor(distanceM, coins);
    if (score > best) { best = score; try { localStorage.setItem("igm-best", String(best)); } catch (e) {} bestEl.textContent = best; }
    overlayTitle.textContent = "Wipeout!";
    overlayText.innerHTML = "Score <b>" + score + "</b> · " + Math.floor(distanceM) + " m · " + coins + " coins.<br>Best: <b>" + best + "</b>";
    startBtn.textContent = "Run again";
    overlay.style.display = "block";
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
    else if (e.key === "Enter" && state !== "running") { startGame(); }
  });
  startBtn.addEventListener("click", startGame);
  pauseBtn.addEventListener("click", togglePause);
  function togglePause() {
    if (state === "running") { state = "paused"; overlayTitle.textContent = "Paused"; overlayText.textContent = "Take a breather — the track waits."; startBtn.textContent = "Keep running"; overlay.style.display = "block"; }
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

  function tick(now) {
    if (state !== "running") return;
    var dt = Math.min(50, now - lastT); lastT = now;
    speed = speedFor(distanceM);
    distanceM += speed * dt * 1000 / 100; // ~metres
    spawnIn -= dt;
    if (spawnIn <= 0) {
      var row = spawnRow(Math.random);
      row.forEach(function (o) { obstacles.push({ type: o.type, lane: o.lane, z: 1.05, air: !!o.air, passed: false }); });
      spawnIn = 620 + Math.random() * 420;
    }
    // Player physics
    if (player.jumpStart) {
      player.jumpH = jumpHeight(now - player.jumpStart);
      if (jumpDone(now - player.jumpStart)) { player.jumpH = 0; player.jumpStart = 0; }
    }
    if (player.sliding && now > player.slideUntil) player.sliding = false;
    // Smooth lane glide
    var targetX = laneX(player.lane, 0);
    player.x += (targetX - player.x) * Math.min(1, dt / 90);

    obstacles.forEach(function (o) { o.z -= speed * dt * 1.05; });
    obstacles = obstacles.filter(function (o) { return o.z > -0.25; });
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (collides(o, player)) { draw(); gameOver(); return; }
      if (!o.passed && collectCoin(o, player)) { o.passed = true; coins++; coinsEl.textContent = coins; }
    }
    scoreEl.textContent = scoreFor(distanceM, coins);
    draw();
    requestAnimationFrame(tick);
  }

  function drawRunner(x, y, s) {
    // Body
    ctx.fillStyle = "#f59e0b";
    var bw = 26 * s, bh = 34 * s;
    if (player.sliding) { bh = 16 * s; y += 18 * s; }
    ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh, bw, bh, 8 * s); ctx.fill();
    // Legs
    ctx.fillStyle = "#1e3a5f";
    var legSwing = player.sliding ? 0 : Math.sin(distanceM * 0.35) * 6 * s;
    ctx.fillRect(x - bw / 2 + 2 * s, y - 2, 9 * s, 14 * s + legSwing);
    ctx.fillRect(x + bw / 2 - 11 * s, y - 2, 9 * s, 14 * s - legSwing);
    // Head: your photo, circular-cropped — or a default face.
    var hr = 17 * s, hy = y - bh - hr + 4 * s;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, hy, hr, 0, Math.PI * 2); ctx.clip();
    if (faceLoaded && faceImg) { ctx.drawImage(faceImg, x - hr, hy - hr, hr * 2, hr * 2); }
    else {
      ctx.fillStyle = "#ffd9b3"; ctx.fillRect(x - hr, hy - hr, hr * 2, hr * 2);
      ctx.fillStyle = "#1e293b";
      ctx.beginPath(); ctx.arc(x - 6 * s, hy - 3 * s, 1.8 * s, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 6 * s, hy - 3 * s, 1.8 * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#1e293b"; ctx.lineWidth = 1.6 * s;
      ctx.beginPath(); ctx.arc(x, hy + 3 * s, 6 * s, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = "#0b1e2e"; ctx.lineWidth = 2.5 * s;
    ctx.beginPath(); ctx.arc(x, hy, hr, 0, Math.PI * 2); ctx.stroke();
  }

  function draw() {
    // Sky
    var sky = ctx.createLinearGradient(0, 0, 0, HORIZON);
    sky.addColorStop(0, "#7dd3fc"); sky.addColorStop(1, "#e0f2fe");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, HORIZON);
    ctx.fillStyle = "#fde68a"; ctx.beginPath(); ctx.arc(W * 0.82, HORIZON * 0.45, 22, 0, Math.PI * 2); ctx.fill();
    // Ground / track
    var g = ctx.createLinearGradient(0, HORIZON, 0, GROUND_Y);
    g.addColorStop(0, "#94a3b8"); g.addColorStop(1, "#475569");
    ctx.fillStyle = g; ctx.fillRect(0, HORIZON, W, GROUND_Y - HORIZON);
    // Lane separators converging to the horizon
    ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 2;
    [-0.5, 0.5].forEach(function (off) {
      ctx.beginPath(); ctx.moveTo(CX + off * W * 0.10, HORIZON); ctx.lineTo(CX + off * W * 0.34, GROUND_Y); ctx.stroke();
    });
    // Sleepers rushing past
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    for (var i = 0; i < 8; i++) {
      var z = ((i / 8 + (distanceM % 10) / 10) % 1);
      var y = laneY(z), w = W * (0.12 + 0.5 * (1 - z));
      ctx.fillRect(CX - w / 2, y, w, 3 + 5 * (1 - z));
    }
    // Obstacles, far to near
    var sorted = obstacles.slice().sort(function (a, b) { return b.z - a.z; });
    sorted.forEach(function (o) {
      var x = laneX(o.lane, o.z), y = laneY(o.z), s = scaleAt(o.z);
      if (o.type === "coin") {
        var cy = y - (o.air ? 95 * s : 34 * s);
        ctx.fillStyle = "#facc15"; ctx.strokeStyle = "#a16207"; ctx.lineWidth = 2 * s;
        ctx.beginPath(); ctx.arc(x, cy, 13 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#a16207"; ctx.font = "bold " + Math.round(16 * s) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("₦", x, cy + 1);
      } else if (o.type === "barrier") {
        ctx.fillStyle = "#f97316";
        ctx.fillRect(x - 26 * s, y - 34 * s, 52 * s, 34 * s);
        ctx.fillStyle = "#fff"; ctx.fillRect(x - 26 * s, y - 26 * s, 52 * s, 6 * s);
        ctx.fillStyle = "#1e293b"; ctx.font = "bold " + Math.round(11 * s) + "px sans-serif";
        ctx.textAlign = "center"; ctx.fillText("JUMP", x, y - 38 * s);
      } else if (o.type === "overhead") {
        ctx.fillStyle = "#7c3aed";
        ctx.fillRect(x - 30 * s, y - 78 * s, 60 * s, 26 * s);
        ctx.fillRect(x - 30 * s, y - 78 * s, 6 * s, 78 * s);
        ctx.fillRect(x + 24 * s, y - 78 * s, 6 * s, 78 * s);
        ctx.fillStyle = "#fff"; ctx.font = "bold " + Math.round(11 * s) + "px sans-serif";
        ctx.textAlign = "center"; ctx.fillText("SLIDE", x, y - 82 * s);
      } else if (o.type === "train") {
        ctx.fillStyle = "#dc2626";
        ctx.fillRect(x - 30 * s, y - 92 * s, 60 * s, 92 * s);
        ctx.fillStyle = "#7f1d1d"; ctx.fillRect(x - 30 * s, y - 92 * s, 60 * s, 14 * s);
        ctx.fillStyle = "#fef3c7";
        ctx.fillRect(x - 22 * s, y - 72 * s, 18 * s, 14 * s);
        ctx.fillRect(x + 4 * s, y - 72 * s, 18 * s, 14 * s);
      }
    });
    // Player
    var py = GROUND_Y - 14 - player.jumpH * 150;
    drawRunner(player.x || laneX(player.lane, 0), py, 1);
  }

  resize();
  loadFace();
  draw();
  if (player) player.x = laneX(1, 0);
})();
