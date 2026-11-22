'use strict';

/* =============================================================================
   직접 참전 · 칼질 액션 아레나 (실시간 칼싸움)
   - 지도 게임(app.js)과 분리된 독립 모듈. window.TWArena.open(cfg, hooks) 로 연다.
   - 3D(1인칭)일 때: 왼쪽 드래그 = 시점 기준 이동, 오른쪽 드래그 = 시점 회전,
     오른쪽 짧은 탭 = 베기. 2D 폴백에서는 예전처럼 조이스틱 방향으로 몸이 돈다.
   - ⚔️ 베기 · 💨 돌진 베기 · 🛡️ 막기(패링) + 키보드 WASD, ←→ 시점, Space/Shift/L
   - 아레나 결과(킬)는 주기적으로 서버에 보고 → 서버가 검증해 지도 병력에 반영
   - cfg.solo = 지도 없이 바로 하는 대규모 1인칭 전장 (홈 화면 버튼)
   ============================================================================= */
(function () {
  var W = 280;              // 논리 좌표 (세로형 · 서버 설정으로 덮어쓴다)
  var H = 600;
  var PLAYER_SPEED = 158;
  var LOOK_SENS = 0.0072;       // 오른쪽 드래그 px → 회전 rad
  var LOOK_PITCH_SENS = 0.0055;
  var PITCH_MIN = -1.05, PITCH_MAX = 0.9;
  var TURN_KEY_SPEED = 2.6;     // ← → 초당 회전
  var PLAYER_R = 11;
  var SLASH_RANGE = 66;
  var SLASH_ARC = 1.3;      // 좌우 ±1.3rad
  var SLASH_CD = 330;
  var SLASH_DMG = 34;
  var DASH_MS = 190;
  var DASH_SPEED = 470;
  var DASH_CD = 1500;
  var DASH_DMG = 26;
  var GUARD_MUL = 0.25;
  var PARRY_MS = 260;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rndRange(r, a, b) { return a + r() * (b - a); }
  function angDiff(a, b) {
    var d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var S = null;             // 현재 세션

  /* ---------------------------------------------------------------------------
     사운드 (WebAudio 합성 · 외부 파일 없음)
     --------------------------------------------------------------------------- */
  var ac = null;
  function audio() {
    if (ac) return ac;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
    } catch (e) { ac = null; }
    return ac;
  }
  function sfx(kind) {
    if (!S || !S.sound) return;
    var a = audio();
    if (!a) return;
    try {
      if (a.state === 'suspended') a.resume();
      var t = a.currentTime;
      var o = a.createOscillator();
      var g = a.createGain();
      o.connect(g); g.connect(a.destination);
      if (kind === 'swing') {
        o.type = 'triangle';
        o.frequency.setValueAtTime(720, t);
        o.frequency.exponentialRampToValueAtTime(220, t + 0.14);
        g.gain.setValueAtTime(0.045, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.start(t); o.stop(t + 0.16);
      } else if (kind === 'hit') {
        o.type = 'square';
        o.frequency.setValueAtTime(180, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.09);
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.start(t); o.stop(t + 0.11);
      } else if (kind === 'kill') {
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(320, t);
        o.frequency.exponentialRampToValueAtTime(90, t + 0.22);
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        o.start(t); o.stop(t + 0.25);
      } else if (kind === 'parry') {
        o.type = 'sine';
        o.frequency.setValueAtTime(1180, t);
        o.frequency.exponentialRampToValueAtTime(1600, t + 0.12);
        g.gain.setValueAtTime(0.07, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t); o.stop(t + 0.19);
      } else if (kind === 'dash') {
        o.type = 'sine';
        o.frequency.setValueAtTime(240, t);
        o.frequency.exponentialRampToValueAtTime(520, t + 0.16);
        g.gain.setValueAtTime(0.04, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t); o.stop(t + 0.2);
      } else if (kind === 'down') {
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(55, t + 0.5);
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        o.start(t); o.stop(t + 0.56);
      }
    } catch (e) { /* 소리는 없어도 된다 */ }
  }

  /* ---------------------------------------------------------------------------
     DOM
     --------------------------------------------------------------------------- */
  var el = {};
  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    el.root = $('arena');
    el.canvas = $('arenaCanvas');
    el.canvas3d = $('arenaCanvas3d');
    el.hpFill = $('arHpFill');
    el.hpText = $('arHpText');
    el.kills = $('arKills');
    el.combo = $('arCombo');
    el.enemyLeft = $('arEnemyLeft');
    el.banner = $('arBanner');
    el.targetInfo = $('arTargetInfo');
    el.hint = $('arHint');
    el.joy = $('arJoy');
    el.joyKnob = $('arJoyKnob');
    el.btnSlash = $('arSlash');
    el.btnDash = $('arDash');
    el.btnGuard = $('arGuard');
    el.btnBack = $('arBack');
    el.btnRestart = $('arRestart');
    el.down = $('arDown');
    el.downSec = $('arDownSec');
    el.flash = $('arFlash');
    el.result = $('arResult');
    el.resultTitle = $('arResultTitle');
    el.resultLine = $('arResultLine');
  }

  /* ---------------------------------------------------------------------------
     열기 / 닫기
     --------------------------------------------------------------------------- */
  function open(cfg, hooks) {
    if (!cfg) return false;
    if (!el.root) cacheDom();
    if (!el.root) return false;
    if (S) closeLocal();

    var rand = mulberry32((cfg.seed || 1) >>> 0);
    S = {
      cfg: cfg,
      hooks: hooks || {},
      rand: rand,
      ctx: el.canvas.getContext('2d'),
      running: true,
      paused: false,
      lastT: 0,
      time: 0,
      sound: true,
      dpr: 1,
      scale: 1,
      offX: 0,
      offY: 0,
      pw: 0,
      ph: 0,
      player: null,
      allies: [],
      enemies: [],
      particles: [],
      floats: [],
      slashes: [],
      trails: [],
      corpses: [],
      cuts: [],
      obstacles: [],
      decor: [],
      kills: 0,
      defeated: 0,
      combo: 0,
      comboT: 0,
      hitstop: 0,
      shake: 0,
      spawnTimer: 900,
      enemySpawned: 0,
      enemyTotal: Math.max(1, cfg.enemyCount || 8),
      allyTotal: Math.max(0, cfg.allyCount == null ? 3 : cfg.allyCount),
      down: 0,
      respawns: 0,
      ended: false,
      endAt: 0,
      endReason: null,
      elapsed: 0,
      reported: 0,
      reportAt: 0,
      pendingSpawn: 0,
      input: {
        dx: 0, dy: 0, mag: 0, joyId: null, joyOX: 0, joyOY: 0, joyX: 0, joyY: 0,
        lookId: null, lookOX: 0, lookOY: 0, lookLX: 0, lookLY: 0, lookT: 0, lookDist: 0
      },
      keys: {},
      bound: [],
      bg: null,
      targetTroops: cfg.target ? cfg.target.troops : 0,
      solo: !!cfg.solo,
      big: !!cfg.big || !!cfg.solo,
      speedScale: clamp(cfg.speedScale || 1, 0.4, 3),
      maxAlive: cfg.maxAlive || 0,
      maxAlliesAlive: cfg.maxAlliesAlive || 0,
      spawnMs: cfg.spawnMs || 0,
      allyMs: cfg.allyMs || 0,
      allyTimer: 0,
      allySpawned: 0,
      allyStart: Math.max(1, cfg.allyStart || cfg.allyCount || 3),
      playerHp: Math.max(40, cfg.playerHp || 100),
      damageGiven: 0
    };

    buildWorld();
    spawnPlayer();
    spawnAllies();
    start3d(cfg);
    bindControls();
    if (el.banner) {
      el.banner.textContent = (cfg.region && cfg.region.name ? cfg.region.name : '전선') +
        ' ↔ ' + (cfg.target && cfg.target.name ? cfg.target.name : '적');
    }
    updateTargetInfo();
    el.root.classList.remove('hidden');
    el.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('arena-on');
    if (el.result) el.result.classList.add('hidden');
    if (el.down) el.down.classList.add('hidden');
    if (el.btnBack) el.btnBack.textContent = S.solo ? '🗺️ 홈으로' : '🗺️ 지도로 복귀';
    if (el.btnRestart) el.btnRestart.classList.toggle('hidden', !S.solo);
    updateHud();
    resize();
    S.lastT = 0;
    S.raf = requestAnimationFrame(frame);
    return true;
  }

  function closeLocal() {
    if (!S) return;
    S.running = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    if (S.r3d) {
      try { S.r3d.dispose(); } catch (e) { /* noop */ }
      S.r3d = null;
    }
    document.body.classList.remove('arena-3d');
    if (el.canvas3d) el.canvas3d.style.display = 'none';
    unbindControls();
    if (el.root) {
      el.root.classList.add('hidden');
      el.root.setAttribute('aria-hidden', 'true');
    }
    if (el.joy) el.joy.classList.add('hidden');
    if (el.result) el.result.classList.add('hidden');
    if (el.down) el.down.classList.add('hidden');
    document.body.classList.remove('arena-on');
    S = null;
  }

  function isOpen() { return !!(S && S.running); }

  /* ---------------------------------------------------------------------------
     월드 준비
     --------------------------------------------------------------------------- */
  function buildWorld() {
    var cfg = S.cfg;
    W = cfg.w || 280;
    H = cfg.h || 600;
    var r = S.rand;
    S.obstacles = [];
    // 바위 · 천막 · 수레 (플레이어 진영과 중앙을 비켜 배치)
    var spots = [
      { fx: 0.24, fy: 0.38, r: 19 }, { fx: 0.75, fy: 0.42, r: 16 },
      { fx: 0.17, fy: 0.60, r: 14 }, { fx: 0.81, fy: 0.61, r: 17 },
      { fx: 0.50, fy: 0.66, r: 20 }, { fx: 0.35, fy: 0.78, r: 15 },
      { fx: 0.68, fy: 0.79, r: 13 }
    ];
    // 대규모 전장은 넓은 땅에 장애물도 더 흩뿌린다
    if (W > 420 || H > 900) {
      for (var e = 0; e < 11; e++) {
        spots.push({ fx: 0.08 + r() * 0.84, fy: 0.2 + r() * 0.6, r: 12 + r() * 11 });
      }
    }
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      S.obstacles.push({
        x: s.fx * W + rndRange(r, -6, 6),
        y: s.fy * H + rndRange(r, -5, 5),
        r: s.r + rndRange(r, -2, 3),
        kind: i % 3 === 0 ? 'tent' : (i % 3 === 1 ? 'rock' : 'cart'),
        seed: r()
      });
    }
    S.decor = [];
    for (var k = 0; k < 70; k++) {
      S.decor.push({ x: r() * W, y: r() * H, s: 1 + r() * 2.4, a: r() * 6.28 });
    }
  }

  function spawnPlayer() {
    S.player = {
      x: W / 2,
      y: H * (S.cfg.playerY || 0.18),
      r: PLAYER_R,
      hp: S.playerHp,
      maxHp: S.playerHp,
      face: Math.PI / 2,
      pitch: 0,
      vx: 0,
      vy: 0,
      atk: 0,
      atkCd: 0,
      atkAnim: 0,
      dash: 0,
      dashCd: 0,
      dashDir: Math.PI / 2,
      guard: false,
      guardT: 0,
      hit: 0,
      parry: 0,
      kills: 0,
      alpha: 1
    };
  }

  function spawnAllies() {
    var r = S.rand;
    var n = Math.min(S.allyTotal, S.allyStart);
    var face = S.player ? S.player.face : Math.PI / 2;
    for (var i = 0; i < n; i++) {
      var a = S.big
        ? face + Math.PI + (r() - 0.5) * 2.4                    // 대규모: 내 뒤·옆에서 따라온다
        : rndRange(r, 0, Math.PI * 2);
      var d = S.big ? 70 + r() * 130 : rndRange(r, 78, 120);
      S.allies.push(makeUnit('ally', clamp(S.player.x + Math.cos(a) * d, W * 0.08, W * 0.92),
        clamp(S.player.y + Math.sin(a) * d * 0.85, H * 0.1, H * 0.9)));
      S.allySpawned++;
    }
  }

  function makeUnit(team, x, y) {
    var enemy = team === 'enemy';
    var lvl = enemy ? 1 + Math.min(1.2, S.targetTroops / 12) : 1;
    return {
      team: team,
      x: x, y: y,
      r: enemy ? 9.2 : 8.8,
      hp: enemy ? Math.round(76 * lvl) : (S.big ? 110 : 78),
      maxHp: enemy ? Math.round(76 * lvl) : (S.big ? 110 : 78),
      speed: (enemy ? (52 + Math.random() * 16) * (1 + Math.min(0.25, S.targetTroops / 40)) : 58) * S.speedScale,
      face: enemy ? -Math.PI / 2 : Math.PI / 2,
      cd: 200 + Math.random() * 500,
      wind: 0,
      swing: 0,
      hit: 0,
      stun: 0,
      dead: false,
      lastHitBy: null,
      dashHit: false,
      wob: Math.random() * 6.28
    };
  }

  /* ---------------------------------------------------------------------------
     3D 렌더러 (Three.js WebGL) — 없거나 실패하면 2D로 그대로 돌아간다
     --------------------------------------------------------------------------- */
  function start3d(cfg) {
    S.r3d = null;
    var ready = !!(window.TWArena3D && window.TWArena3D.supported());
    if (cfg && cfg.force2d) ready = false;
    if (ready) {
      // 매번 새 캔버스를 쓴다 (이전 WebGL 컨텍스트 재사용 문제 방지)
      var c3 = freshCanvas3d();
      if (c3) {
        try {
          S.r3d = window.TWArena3D.create({
            canvas: c3,
            cfg: cfg,
            obstacles: S.obstacles
          });
          S.bound.push([c3, 'webglcontextlost', on3dLost, false]);
          c3.addEventListener('webglcontextlost', on3dLost, false);
        } catch (e) {
          S.r3d = null;
          if (window.console) console.warn('[arena3d] 3D 초기화 실패 → 2D로 진행', e && e.message);
        }
      }
    }
    document.body.classList.toggle('arena-3d', !!S.r3d);
    if (el.canvas3d) el.canvas3d.style.display = S.r3d ? 'block' : 'none';
    return !!S.r3d;
  }

  /** 3D 캔버스를 새 것으로 교체 (컨텍스트가 죽은 캔버스를 다시 쓰지 않도록) */
  function freshCanvas3d() {
    var old = document.getElementById('arenaCanvas3d');
    if (!old || !old.parentNode) return null;
    var c = document.createElement('canvas');
    c.id = 'arenaCanvas3d';
    c.setAttribute('aria-hidden', 'true');
    old.parentNode.replaceChild(c, old);
    el.canvas3d = c;
    return c;
  }

  /** WebGL 컨텍스트를 잃으면 2D 렌더러로 자동 폴백 */
  function on3dLost(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!S) return;
    if (S.r3d) {
      try { S.r3d.dispose(); } catch (e) { /* noop */ }
      S.r3d = null;
    }
    document.body.classList.remove('arena-3d');
    if (el.canvas3d) el.canvas3d.style.display = 'none';
    try { resize(); } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------------------------
     크기 · 화면
     --------------------------------------------------------------------------- */
  function resize() {
    if (!S || !el.canvas) return;
    var rect = el.root.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    S.dpr = Math.min(window.devicePixelRatio || 1, 3);
    el.canvas.width = Math.round(w * S.dpr);
    el.canvas.height = Math.round(h * S.dpr);
    S.pw = w; S.ph = h;
    S.scale = Math.min(w / W, h / H);
    S.offX = (w - W * S.scale) / 2;
    S.offY = (h - H * S.scale) / 2;
    if (S.r3d) S.r3d.resize(w, h);
    else buildBackground();
  }

  function buildBackground() {
    if (!S) return;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(S.pw * S.dpr));
    c.height = Math.max(1, Math.round(S.ph * S.dpr));
    var b = c.getContext('2d');
    b.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    b.translate(S.offX, S.offY);
    b.scale(S.scale, S.scale);

    // 땅
    var g = b.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1b2a24');
    g.addColorStop(0.32, '#182521');
    g.addColorStop(0.68, '#1a211f');
    g.addColorStop(1, '#211a19');
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);

    // 흙길 (중앙 세로)
    b.globalAlpha = 0.18;
    b.fillStyle = '#6b5a42';
    for (var y = 90; y < H - 60; y += 18) {
      b.beginPath();
      b.ellipse(W / 2 + Math.sin(y * 0.03) * 26, y, 30 + Math.sin(y * 0.05) * 7, 13, 0, 0, Math.PI * 2);
      b.fill();
    }
    b.globalAlpha = 1;

    // 풀 · 자갈
    var r = mulberry32((S.cfg.seed || 1) >>> 0);
    for (var i = 0; i < 180; i++) {
      var x = r() * W, yy = r() * H;
      b.strokeStyle = 'rgba(120,160,120,' + (0.06 + r() * 0.1).toFixed(3) + ')';
      b.lineWidth = 1;
      b.beginPath();
      b.moveTo(x, yy);
      b.lineTo(x + (r() - 0.5) * 3, yy - 3 - r() * 3);
      b.stroke();
    }
    for (var k = 0; k < 40; k++) {
      b.fillStyle = 'rgba(160,150,130,' + (0.05 + r() * 0.09).toFixed(3) + ')';
      b.beginPath();
      b.arc(r() * W, r() * H, 0.8 + r() * 2, 0, Math.PI * 2);
      b.fill();
    }

    // 진영 표시
    var myColor = (S.cfg.me && S.cfg.me.color) || '#3b82f6';
    var enColor = (S.cfg.enemy && S.cfg.enemy.color) || '#ef4444';
    var band = H * 0.16;
    var top = b.createLinearGradient(0, 0, 0, band);
    top.addColorStop(0, hexA(myColor, 0.34));
    top.addColorStop(1, hexA(myColor, 0));
    b.fillStyle = top;
    b.fillRect(0, 0, W, band);
    var bot = b.createLinearGradient(0, H, 0, H - band);
    bot.addColorStop(0, hexA(enColor, 0.34));
    bot.addColorStop(1, hexA(enColor, 0));
    b.fillStyle = bot;
    b.fillRect(0, H - band, W, band);

    // 아군 진영 천막
    drawCamp(b, W * 0.18, H * 0.06, myColor, false);
    drawCamp(b, W * 0.82, H * 0.94, enColor, true);
    S.bg = c;
  }

  function drawCamp(b, x, y, color, enemy) {
    b.save();
    b.translate(x, y);
    // 깃발
    b.strokeStyle = 'rgba(230,240,255,0.5)';
    b.lineWidth = 2;
    b.beginPath();
    b.moveTo(-52, 18);
    b.lineTo(-52, -30);
    b.stroke();
    b.fillStyle = hexA(color, 0.9);
    b.beginPath();
    b.moveTo(-52, -30);
    b.lineTo(-22, -22);
    b.lineTo(-52, -12);
    b.closePath();
    b.fill();
    // 천막
    b.fillStyle = hexA(color, 0.22);
    b.strokeStyle = hexA(color, 0.55);
    b.lineWidth = 1.5;
    b.beginPath();
    b.moveTo(-18, 16);
    b.lineTo(0, -12);
    b.lineTo(18, 16);
    b.closePath();
    b.fill();
    b.stroke();
    b.restore();
  }

  function hexA(hex, a) {
    var h = String(hex || '#3b82f6').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(59,130,246,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------------------------------------------------------------------------
     조작
     --------------------------------------------------------------------------- */
  function bindControls() {
    var add = function (target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      S.bound.push([target, type, fn, opts]);
    };

    add(el.root, 'pointerdown', onPointerDown);
    add(window, 'pointermove', onPointerMove);
    add(window, 'pointerup', onPointerUp);
    add(window, 'pointercancel', onPointerUp);
    add(window, 'keydown', onKeyDown);
    add(window, 'keyup', onKeyUp);
    add(window, 'resize', resize);

    add(el.btnSlash, 'pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); doSlash(); });
    add(el.btnDash, 'pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); tapDash(e); });
    add(el.btnGuard, 'pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!S) return;
      S.player.guard = true;
      S.player.guardT = 0;
      el.btnGuard.classList.add('on');
    });
    var release = function (e) {
      if (!S) return;
      if (e) { e.preventDefault(); }
      S.player.guard = false;
      el.btnGuard.classList.remove('on');
    };
    add(el.btnGuard, 'pointerup', release);
    add(el.btnGuard, 'pointercancel', release);
    add(el.btnGuard, 'pointerleave', release);
    add(el.btnBack, 'click', function (e) {
      e.preventDefault();
      if (!S || S.ended) return;
      finish('return');
    });
    if (el.btnRestart) {
      add(el.btnRestart, 'click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        restartBattle();
      });
    }
  }

  function unbindControls() {
    if (!S) return;
    for (var i = 0; i < S.bound.length; i++) {
      var b = S.bound[i];
      try { b[0].removeEventListener(b[1], b[2], b[3]); } catch (e) { /* noop */ }
    }
    S.bound = [];
    if (el.btnGuard) el.btnGuard.classList.remove('on');
  }

  function localPoint(e) {
    var rect = el.root.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function onPointerDown(e) {
    if (!S || S.ended) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    var p = localPoint(e);
    if (p.x < p.w * 0.55) {
      if (S.input.joyId != null) return;
      S.input.joyId = e.pointerId;
      S.input.joyOX = p.x;
      S.input.joyOY = p.y;
      S.input.joyX = p.x;
      S.input.joyY = p.y;
      S.input.dx = 0;
      S.input.dy = 0;
      S.input.mag = 0;
      placeJoy();
      if (e.pointerType !== 'mouse') {
        try { el.root.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      }
      return;
    }
    if (S.r3d) {
      // 오른쪽 화면 드래그 = 시점 회전 (짧은 탭은 뗄 때 베기)
      if (S.input.lookId != null) return;
      S.input.lookId = e.pointerId;
      S.input.lookOX = p.x;
      S.input.lookOY = p.y;
      S.input.lookLX = p.x;
      S.input.lookLY = p.y;
      S.input.lookT = nowMs();
      S.input.lookDist = 0;
    } else {
      tapSlash(e);
    }
  }

  function onPointerMove(e) {
    if (!S) return;
    if (S.input.joyId != null && e.pointerId === S.input.joyId) {
      var p = localPoint(e);
      var dx = p.x - S.input.joyOX;
      var dy = p.y - S.input.joyOY;
      var R = 52;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      S.input.joyX = S.input.joyOX + dx;
      S.input.joyY = S.input.joyOY + dy;
      S.input.mag = clamp(d / R, 0, 1);
      S.input.dx = d > 0.001 ? dx / (d > R ? R : d) : 0;
      S.input.dy = d > 0.001 ? dy / (d > R ? R : d) : 0;
      // 2D 폴백에서만: 조이스틱 방향으로 몸을 돌린다 (시점이 곧 화면)
      if (!S.r3d && Math.abs(S.input.dx) + Math.abs(S.input.dy) > 0.2) {
        S.player.face = Math.atan2(S.input.dy, S.input.dx);
      }
      placeJoy();
      return;
    }
    if (S.r3d && S.input.lookId != null && e.pointerId === S.input.lookId) {
      var lp = localPoint(e);
      var mdx = lp.x - S.input.lookLX;
      var mdy = lp.y - S.input.lookLY;
      S.input.lookLX = lp.x;
      S.input.lookLY = lp.y;
      S.input.lookDist += Math.abs(mdx) + Math.abs(mdy);
      var pl = S.player;
      if (!pl) return;
      pl.face = normAngle(pl.face + mdx * LOOK_SENS);
      pl.pitch = clamp((pl.pitch || 0) - mdy * LOOK_PITCH_SENS, PITCH_MIN, PITCH_MAX);
    }
  }

  function onPointerUp(e) {
    if (!S) return;
    if (S.input.joyId != null && e && e.pointerId === S.input.joyId) {
      S.input.joyId = null;
      S.input.mag = 0;
      S.input.dx = 0;
      S.input.dy = 0;
      if (el.joy) el.joy.classList.add('hidden');
    }
    if (S.r3d && S.input.lookId != null && e && e.pointerId === S.input.lookId) {
      var quick = S.input.lookDist < 12 && (nowMs() - S.input.lookT) < 360;
      S.input.lookId = null;
      if (quick && !S.ended) doSlash();
    }
  }

  function placeJoy() {
    if (!el.joy || S.input.joyId == null) return;
    el.joy.classList.remove('hidden');
    el.joy.style.left = S.input.joyOX + 'px';
    el.joy.style.top = S.input.joyOY + 'px';
    if (el.joyKnob) {
      var dx = S.input.joyX - S.input.joyOX;
      var dy = S.input.joyY - S.input.joyOY;
      el.joyKnob.style.transform = 'translate(-50%, -50%) translate(' + dx + 'px,' + dy + 'px)';
    }
  }

  function tapSlash(e) {
    if (!S) return;
    if (e && e.clientX != null) {
      var p = localPoint(e);
      var wx = (p.x - S.offX) / S.scale;
      var wy = (p.y - S.offY) / S.scale;
      var pl = S.player;
      if (pl && Math.abs(wx - pl.x) > 18) S.player.face = Math.atan2(wy - pl.y, wx - pl.x);
    }
    doSlash();
  }

  /** 화면 기준 입력 (x 오른쪽, y 아래) — 키보드 우선, 없으면 조이스틱 */
  function moveVector() {
    var kv = keyVector();
    if (kv) return kv;
    if (S.input.mag > 0.08) return { sdx: S.input.dx, sdy: S.input.dy, mag: S.input.mag };
    return null;
  }

  /** 화면 기준 입력을 시점(face) 기준 월드 방향으로 */
  function worldMove(mv) {
    var f = S.player ? S.player.face : 0;
    var fx = Math.cos(f), fy = Math.sin(f);
    var wx = fx * (-mv.sdy) - fy * mv.sdx;
    var wy = fy * (-mv.sdy) + fx * mv.sdx;
    var d = Math.sqrt(wx * wx + wy * wy);
    if (d > 0.0001) { wx /= d; wy /= d; }
    return { x: wx, y: wy, mag: mv.mag };
  }

  function dashNow() {
    if (!S) return;
    var pl = S.player;
    var mv = moveVector();
    if (mv && mv.mag > 0.15) {
      var w = worldMove(mv);
      pl.dashDir = Math.atan2(w.y, w.x);
    } else {
      pl.dashDir = pl.face;
    }
    doDash();
  }

  function tapDash(e) {
    if (!S) return;
    var pl = S.player;
    if (!S.r3d) {
      if (S.input.mag > 0.15) pl.dashDir = Math.atan2(S.input.dy, S.input.dx);
      else pl.dashDir = pl.face;
      doDash();
      return;
    }
    dashNow();
  }

  function onKeyDown(e) {
    if (!S || S.ended) return;
    var k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(k) >= 0) e.preventDefault();
    S.keys[k] = true;
    if (k === ' ' || k === 'j') doSlash();
    if (k === 'k' || k === 'shift') dashNow();
    if (k === 'l') { S.player.guard = true; S.player.guardT = 0; el.btnGuard.classList.add('on'); }
    if (k === 'escape') finish('return');
  }

  function onKeyUp(e) {
    if (!S) return;
    var k = e.key.toLowerCase();
    S.keys[k] = false;
    if (k === 'l') { S.player.guard = false; el.btnGuard.classList.remove('on'); }
  }

  function keyVector() {
    var k = S.keys;
    var dx = 0, dy = 0;
    if (k['a']) dx -= 1;
    if (k['d']) dx += 1;
    if (k['w']) dy -= 1;
    if (k['s']) dy += 1;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.01) return null;
    return { sdx: dx / d, sdy: dy / d, mag: 1 };
  }

  /* ---------------------------------------------------------------------------
     액션
     --------------------------------------------------------------------------- */
  function doSlash() {
    if (!S || S.ended || S.down > 0) return;
    var pl = S.player;
    if (!pl || pl.atkCd > 0 || pl.dash > 0) return;
    pl.atkCd = SLASH_CD;
    pl.atkAnim = 260;

    var dmg = SLASH_DMG + Math.min(30, S.combo * 5);
    if (S.combo >= 5) dmg += 8;
    S.slashes.push({ x: pl.x, y: pl.y, face: pl.face, t: 0, dur: 220, r: SLASH_RANGE });
    sfx('swing');

    var hits = 0;
    for (var i = 0; i < S.enemies.length; i++) {
      var en = S.enemies[i];
      if (en.dead) continue;
      var dx = en.x - pl.x, dy = en.y - pl.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > SLASH_RANGE + en.r) continue;
      var a = Math.atan2(dy, dx);
      if (Math.abs(angDiff(a, pl.face)) > SLASH_ARC) continue;
      hurtEnemy(en, dmg, a, 30, pl.face);
      hits++;
    }
    if (hits > 0) {
      S.hitstop = Math.max(S.hitstop, 55);
      S.lastImpactAt = S.time;
      S.shake = Math.max(S.shake, 3.2);
      spawnSparks(pl.x + Math.cos(pl.face) * 30, pl.y + Math.sin(pl.face) * 30, 8);
      sfx('hit');
    }
  }

  function doDash() {
    if (!S || S.ended || S.down > 0) return;
    var pl = S.player;
    if (!pl || pl.dashCd > 0) return;
    pl.dash = DASH_MS;
    pl.dashCd = DASH_CD;
    pl.atkAnim = 0;
    resetDashHits();
    S.trails.push({ x: pl.x, y: pl.y, t: 0, dur: 240, face: pl.dashDir });
    sfx('dash');
  }

  function resetDashHits() {
    for (var i = 0; i < S.enemies.length; i++) S.enemies[i].dashHit = false;
  }

  function hurtEnemy(en, dmg, ang, kb, cutAngle) {
    if (en.dead) return;
    en.hp -= dmg;
    en.hit = 140;
    en.lastHitBy = 'player';
    en.x += Math.cos(ang) * (kb || 12) * 0.5;
    en.y += Math.sin(ang) * (kb || 12) * 0.5;
    en.stun = Math.max(en.stun, 220);
    addFloat(en.x, en.y - 14, '-' + Math.round(dmg), '#fde68a');
    spawnSparks(en.x, en.y, 5);
    if (en.hp <= 0) {
      killEnemy(en, true, cutAngle == null ? ang + Math.PI / 2 : cutAngle);
    }
  }

  function killEnemy(en, byPlayer, cutAngle) {
    if (en.dead) return;
    en.dead = true;
    S.defeated++;
    spawnSparks(en.x, en.y, 14);
    if (byPlayer) {
      // 칼이 지나간 각도 그대로 두 동강 — 조각이 칼날 수직 방향으로 갈라져 회전하며 날아간다
      spawnCorpse(en, cutAngle);
    } else {
      spawnBlood(en.x, en.y);
    }
    if (byPlayer) {
      S.kills++;
      S.combo++;
      S.comboT = 2200;
      S.player.kills = S.kills;
      addFloat(en.x, en.y - 22, S.combo > 1 ? '베기 +1 · ' + S.combo + '콤보' : '베기 +1', '#a7f3d0');
      if (S.combo > 0 && S.combo % 5 === 0) {
        addFloat(S.player.x, S.player.y - 30, S.combo + '콤보!', '#fbbf24');
        S.shake = Math.max(S.shake, 5);
      }
      sfx('kill');
      updateHud();
    }
    var idx = S.enemies.indexOf(en);
    if (idx >= 0) S.enemies.splice(idx, 1);
  }

  /** 칼이 지나간 각도 그대로 두 조각으로 가른다 (조각은 칼날 수직 방향으로 갈라져 회전) */
  function spawnCorpse(en, cutAngle) {
    var cut = Number.isFinite(cutAngle) ? cutAngle : -Math.PI / 2;
    var col = hexA((S.cfg.enemy && S.cfg.enemy.color) || '#ef4444', 0.95);
    var nx = Math.cos(cut), ny = Math.sin(cut);
    var px = -ny, py = nx;                     // 칼날에 수직인 방향
    for (var side = -1; side <= 1; side += 2) {
      var push = 42 + Math.random() * 54;
      S.corpses.push({
        x: en.x + px * side * 2.6,
        y: en.y + py * side * 2.6,
        cut: cut,
        side: side,
        r: en.r || 8.4,
        vx: px * side * push + nx * (Math.random() - 0.5) * 22,
        vy: py * side * push + ny * (Math.random() - 0.5) * 22,
        rot: 0,
        spin: side * (2.4 + Math.random() * 3.4),
        life: 950,
        max: 950,
        color: col
      });
    }
    S.cuts.push({ x: en.x, y: en.y, ang: cut, len: Math.max(24, (en.r || 8) * 3.4), t: 0, dur: 220 });
    S.hitstop = Math.max(S.hitstop, 45);
  }

  function hurtPlayer(dmg, from) {
    var pl = S.player;
    if (!pl || S.down > 0) return;
    if (pl.guard) {
      if (pl.guardT <= PARRY_MS) {
        // 패링: 데미지 0 · 상대 경직 + 넉백
        pl.parry++;
        addFloat(pl.x, pl.y - 28, '패링!', '#93c5fd');
        sfx('parry');
        S.hitstop = Math.max(S.hitstop, 90);
        S.shake = Math.max(S.shake, 5);
        if (from) {
          var a = Math.atan2(from.y - pl.y, from.x - pl.x);
          from.stun = Math.max(from.stun, 700);
          from.x += Math.cos(a) * 46;
          from.y += Math.sin(a) * 46;
          from.hp -= 6;
          spawnSparks(pl.x + Math.cos(a) * 16, pl.y + Math.sin(a) * 16, 10);
          if (from.hp <= 0) killEnemy(from, true, Math.atan2(from.y - pl.y, from.x - pl.x) + Math.PI / 2);
        }
        pl.guardT = 0;
        pl.atkCd = 120;
        return;
      }
      dmg *= GUARD_MUL;
      S.shake = Math.max(S.shake, 1.6);
    } else {
      S.shake = Math.max(S.shake, 3.4);
    }
    dmg = Math.max(1, Math.round(dmg));
    pl.hp -= dmg;
    pl.hit = 180;
    addFloat(pl.x, pl.y - 24, '-' + dmg, '#fca5a5');
    spawnSparks(pl.x, pl.y, 5);
    updateHud();
    if (pl.hp <= 0) {
      pl.hp = 0;
      S.down = 2000;
      S.combo = 0;
      S.deadAt = S.time;
      sfx('down');
      S.shake = 8;
      if (el.down) { el.down.classList.remove('hidden'); el.downSec.textContent = '2'; }
      updateHud();
    }
  }

  /* ---------------------------------------------------------------------------
     시뮬레이션
     --------------------------------------------------------------------------- */
  function frame(ts) {
    if (!S) return;
    S.raf = requestAnimationFrame(frame);
    if (!S.running) return;
    if (!S.lastT) S.lastT = ts;
    var dt = Math.min(50, ts - S.lastT);
    S.lastT = ts;
    if (dt <= 0) return;
    step(dt);
    draw(ts);
  }

  function step(dt) {
    S.time += dt;
    S.elapsed += dt;
    if (S.ended) {
      if (S.endAt && S.time - S.endAt > 60) { /* 결과 표시 중 */ }
      return;
    }
    if (S.hitstop > 0) {
      S.hitstop = Math.max(0, S.hitstop - dt);
      dt *= 0.18;
    }
    var pl = S.player;

    // 시간 초과
    if (S.elapsed >= 150000) { finish('timeout'); return; }

    // 다운 · 부활
    if (S.down > 0) {
      S.down -= dt;
      if (el.downSec) el.downSec.textContent = String(Math.max(0, Math.ceil(S.down / 1000)));
      if (S.down <= 0) respawn();
      stepUnits(dt * 0.5);
      stepEffects(dt);
      updateHud();
      return;
    }

    // 플레이어 이동 (시점 기준 · 시점은 사용자가 돌릴 때만 바뀐다)
    var mv = moveVector();
    var dx = 0, dy = 0, mag = 0;
    if (mv) {
      if (S.r3d) {
        var wm = worldMove(mv);
        dx = wm.x; dy = wm.y;
      } else {
        var dl = Math.sqrt(mv.sdx * mv.sdx + mv.sdy * mv.sdy) || 1;
        dx = mv.sdx / dl; dy = mv.sdy / dl;
      }
      mag = mv.mag;
    }

    // 키보드 ←→ 시점 회전 · ↑↓ 시점 상하 (3D)
    if (S.r3d) {
      var turn = (S.keys['arrowright'] ? 1 : 0) - (S.keys['arrowleft'] ? 1 : 0);
      if (turn) pl.face = normAngle(pl.face + turn * TURN_KEY_SPEED * (dt / 1000));
      var pit = (S.keys['arrowup'] ? 1 : 0) - (S.keys['arrowdown'] ? 1 : 0);
      if (pit) pl.pitch = clamp((pl.pitch || 0) + pit * 1.5 * (dt / 1000), PITCH_MIN, PITCH_MAX);
    }

    if (pl.dash > 0) {
      pl.dash -= dt;
      var dashStep = DASH_SPEED * S.speedScale * (dt / 1000);
      pl.x += Math.cos(pl.dashDir) * dashStep;
      pl.y += Math.sin(pl.dashDir) * dashStep;
      if (S.rand() < 0.7) {
        S.particles.push({
          x: pl.x - Math.cos(pl.dashDir) * 8, y: pl.y - Math.sin(pl.dashDir) * 8,
          vx: -Math.cos(pl.dashDir) * 20, vy: -Math.sin(pl.dashDir) * 20,
          life: 260, max: 260, color: hexA((S.cfg.me && S.cfg.me.color) || '#3b82f6', 0.7), size: 2.4
        });
      }
      // 돌진 중 베기
      for (var i = 0; i < S.enemies.length; i++) {
        var en = S.enemies[i];
        if (en.dead || en.dashHit) continue;
        var ddx = en.x - pl.x, ddy = en.y - pl.y;
        if (ddx * ddx + ddy * ddy < (pl.r + en.r + 16) * (pl.r + en.r + 16)) {
          en.dashHit = true;
          hurtEnemy(en, DASH_DMG, pl.dashDir, 26, pl.dashDir);
          S.shake = Math.max(S.shake, 2.4);
          sfx('hit');
        }
      }
    } else if (mag > 0.06) {
      var sp = PLAYER_SPEED * S.speedScale * (pl.guard ? 0.55 : 1) * clamp(mag * 1.15, 0.35, 1);
      pl.x += dx * sp * (dt / 1000);
      pl.y += dy * sp * (dt / 1000);
      // 2D 폴백에서만 이동 방향으로 몸이 돈다 (3D는 시점 고정)
      if (!S.r3d) pl.face = Math.atan2(dy, dx);
    }

    // 타이머
    if (pl.atkCd > 0) pl.atkCd -= dt;
    if (pl.atkAnim > 0) pl.atkAnim -= dt;
    if (pl.dashCd > 0) pl.dashCd -= dt;
    if (pl.hit > 0) pl.hit -= dt;
    if (pl.guard) pl.guardT += dt;

    collideWorld(pl);
    stepUnits(dt);
    stepSpawn(dt);
    stepEffects(dt);

    if (S.comboT > 0) {
      S.comboT -= dt;
      if (S.comboT <= 0) { S.combo = 0; updateHud(); }
    }

    // 승리 판정
    if (S.enemySpawned >= S.enemyTotal && S.enemies.length === 0) {
      if (!S.winAt) S.winAt = S.time;
      if (S.time - S.winAt > 900) { finish('win'); return; }
    }

    updateHud();
    report(false);
  }

  function respawn() {
    var pl = S.player;
    pl.hp = pl.maxHp;
    if (S.big) {
      // 대규모 전장: 쓰러진 자리에서 조금 뒤로 물러나 일어난다
      pl.x = clamp(pl.x - Math.cos(pl.face) * 90, W * 0.08, W * 0.92);
      pl.y = clamp(pl.y - Math.sin(pl.face) * 90, H * 0.12, H * 0.88);
    } else {
      pl.x = W / 2;
      pl.y = H * 0.2;
    }
    pl.atkCd = 0; pl.dash = 0; pl.dashCd = 0; pl.guard = false;
    S.respawns++;
    S.invuln = 1400;
    if (el.down) el.down.classList.add('hidden');
    addFloat(pl.x, pl.y - 28, '부활!', '#a7f3d0');
    updateHud();
  }

  function stepUnits(dt) {
    var pl = S.player;
    var i;

    // 아군
    for (i = 0; i < S.allies.length; i++) {
      var al = S.allies[i];
      if (al.dead) continue;
      var target = nearestEnemy(al.x, al.y, 460);
      aiUnit(al, target, dt, pl);
    }

    // 적
    for (i = 0; i < S.enemies.length; i++) {
      var en = S.enemies[i];
      if (en.dead) continue;
      var tgt = null;
      var best = Infinity;
      if (pl && S.down <= 0 && !pl.dead) {
        var d0 = (pl.x - en.x) * (pl.x - en.x) + (pl.y - en.y) * (pl.y - en.y);
        if (d0 < best) { best = d0; tgt = pl; }
      }
      for (var k = 0; k < S.allies.length; k++) {
        var a2 = S.allies[k];
        if (a2.dead) continue;
        var d1 = (a2.x - en.x) * (a2.x - en.x) + (a2.y - en.y) * (a2.y - en.y);
        if (d1 < best) { best = d1; tgt = a2; }
      }
      aiUnit(en, tgt, dt, pl);
    }

    // 아군 사망 정리
    for (i = S.allies.length - 1; i >= 0; i--) {
      if (S.allies[i].dead) S.allies.splice(i, 1);
    }
  }

  function nearestEnemy(x, y, maxD) {
    var best = null, bd = maxD * maxD;
    for (var i = 0; i < S.enemies.length; i++) {
      var e = S.enemies[i];
      if (e.dead) continue;
      var d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function aiUnit(u, target, dt, pl) {
    if (u.stun > 0) {
      u.stun -= dt;
      collideWorld(u);
      return;
    }
    if (u.hit > 0) u.hit -= dt;
    if (u.cd > 0) u.cd -= dt;
    if (u.swing > 0) u.swing -= dt;

    var tx, ty;
    if (u.team === 'ally' && (!target)) {
      // 적이 없으면 플레이어 주변을 지킨다 (1인칭 시야를 가리지 않게 조금 떨어져서)
      tx = pl.x + Math.cos(u.wob + S.time / 900) * (S.big ? 120 : 62);
      ty = pl.y + Math.sin(u.wob + S.time / 900) * (S.big ? 96 : 48) + 10;
    } else if (target) {
      tx = target.x; ty = target.y;
    } else {
      tx = W / 2; ty = H / 2;
    }
    var dx = tx - u.x, dy = ty - u.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    u.face = Math.atan2(dy, dx);

    var reach = (u.r + (target ? target.r : 0)) + 17;
    if (target && d > reach) {
      u.x += (dx / d) * u.speed * (dt / 1000);
      u.y += (dy / d) * u.speed * (dt / 1000);
    } else if (target && u.cd <= 0 && u.wind <= 0) {
      u.wind = 320;
      u.swing = 0;
    }

    if (u.wind > 0) {
      u.wind -= dt;
      if (u.wind <= 0) {
        // 빗나가도 칼을 휘두르는 동작·검기(3D 예고→휘두름)는 그대로 보여 준다
        u.swing = 180;
        if (target) {
          var rr = (u.r + target.r) + 24;
          var ddx = target.x - u.x, ddy = target.y - u.y;
          if (ddx * ddx + ddy * ddy <= rr * rr) {
            if (u.team === 'enemy') {
              if (target === pl) hurtPlayer(9 + Math.random() * 4, u);
              else {
                target.hp -= 10;
                target.hit = 140;
                spawnSparks(target.x, target.y, 4);
                if (target.hp <= 0) {
                  target.dead = true;
                  spawnBlood(target.x, target.y);
                }
              }
            } else {
              target.hp -= 11;
              target.hit = 140;
              spawnSparks(target.x, target.y, 4);
              if (target.hp <= 0) killEnemy(target, false);
            }
          }
        }
        u.cd = 760 + Math.random() * 320;
      }
    }
    collideWorld(u);
  }

  function stepSpawn(dt) {
    // ---- 적 증원 (파도) ----
    if (S.enemySpawned < S.enemyTotal) {
      S.spawnTimer -= dt;
      var cap = S.maxAlive || (4 + Math.round(S.enemyTotal / 5));
      if (S.enemies.length < cap && S.spawnTimer <= 0) {
        S.spawnTimer = S.spawnMs || Math.max(420, 1000 - S.enemyTotal * 16);
        var n = Math.min(S.big ? 3 : 2, S.enemyTotal - S.enemySpawned, cap - S.enemies.length);
        for (var i = 0; i < n; i++) {
          var en;
          if (S.big) {
            // 플레이어 앞쪽으로 파도처럼 몰려온다
            var a = (S.player ? S.player.face : Math.PI / 2) + (S.rand() - 0.5) * 2.8;
            var d = 240 + S.rand() * 200;
            en = makeUnit('enemy', clamp(S.player.x + Math.cos(a) * d, W * 0.05, W * 0.95),
              clamp(S.player.y + Math.sin(a) * d, H * 0.06, H * 0.94));
          } else {
            en = makeUnit('enemy', W * 0.18 + Math.random() * W * 0.64,
              H * 0.84 - Math.random() * H * 0.07);
          }
          en.wind = 0;
          S.enemies.push(en);
          S.enemySpawned++;
        }
      }
    }
    // ---- 아군 증원 (파도) ----
    if (S.allySpawned < S.allyTotal) {
      S.allyTimer -= dt;
      var acap = S.maxAlliesAlive || 999;
      if (S.allies.length < acap && S.allyTimer <= 0) {
        S.allyTimer = S.allyMs || 1500;
        var m = Math.min(S.big ? 2 : 1, S.allyTotal - S.allySpawned);
        for (var j = 0; j < m; j++) {
          var ang = (S.player ? S.player.face : Math.PI / 2) + Math.PI + (S.rand() - 0.5) * 1.8;
          var dd = 70 + S.rand() * 90;
          S.allies.push(makeUnit('ally', clamp(S.player.x + Math.cos(ang) * dd, W * 0.06, W * 0.94),
            clamp(S.player.y + Math.sin(ang) * dd, H * 0.08, H * 0.92)));
          S.allySpawned++;
        }
      }
    }
  }

  function stepEffects(dt) {
    var i;
    for (i = S.particles.length - 1; i >= 0; i--) {
      var p = S.particles[i];
      p.life -= dt;
      p.x += p.vx * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      p.vy += 120 * (dt / 1000);
      if (p.life <= 0) S.particles.splice(i, 1);
    }
    for (i = S.floats.length - 1; i >= 0; i--) {
      var f = S.floats[i];
      f.life -= dt;
      f.y -= 26 * (dt / 1000);
      if (f.life <= 0) S.floats.splice(i, 1);
    }
    for (i = S.slashes.length - 1; i >= 0; i--) {
      var sl = S.slashes[i];
      sl.t += dt;
      if (sl.t >= sl.dur) S.slashes.splice(i, 1);
    }
    for (i = S.trails.length - 1; i >= 0; i--) {
      var tr = S.trails[i];
      tr.t += dt;
      if (tr.t >= tr.dur) S.trails.splice(i, 1);
    }
    for (i = S.corpses.length - 1; i >= 0; i--) {
      var c = S.corpses[i];
      c.life -= dt;
      var f = Math.max(0, 1 - dt / 320);
      c.vx *= f;
      c.vy *= f;
      c.x += c.vx * (dt / 1000);
      c.y += c.vy * (dt / 1000);
      c.rot += c.spin * (dt / 1000);
      c.spin *= Math.max(0, 1 - dt / 700);
      if (c.life <= 0) S.corpses.splice(i, 1);
    }
    for (i = S.cuts.length - 1; i >= 0; i--) {
      S.cuts[i].t += dt;
      if (S.cuts[i].t >= S.cuts[i].dur) S.cuts.splice(i, 1);
    }
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 0.02);
    if (S.invuln > 0) S.invuln -= dt;
  }

  function collideWorld(u) {
    var margin = W * 0.06;
    if (u.x < margin) u.x = margin;
    if (u.x > W - margin) u.x = W - margin;
    if (u.y < H * 0.13) u.y = H * 0.13;
    if (u.y > H * 0.87) u.y = H * 0.87;
    // 1인칭 카메라 바로 앞을 아군이 막지 않도록
    if (S.r3d && S.player && u !== S.player && u.team === 'ally') {
      var pdx = u.x - S.player.x, pdy = u.y - S.player.y;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 48 && pd > 0.001) {
        u.x = S.player.x + (pdx / pd) * 48;
        u.y = S.player.y + (pdy / pd) * 48;
      }
    }
    for (var i = 0; i < S.obstacles.length; i++) {
      var o = S.obstacles[i];
      var dx = u.x - o.x, dy = u.y - o.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var min = o.r + u.r;
      if (d < min && d > 0.001) {
        u.x = o.x + (dx / d) * min;
        u.y = o.y + (dy / d) * min;
      }
    }
  }

  function spawnSparks(x, y, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 40 + Math.random() * 120;
      S.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30,
        life: 220 + Math.random() * 200, max: 400,
        color: Math.random() < 0.5 ? '#fde68a' : '#fca5a5',
        size: 1.4 + Math.random() * 1.8
      });
    }
  }

  function spawnBlood(x, y) {
    for (var i = 0; i < 6; i++) {
      var a = Math.random() * Math.PI * 2;
      S.particles.push({
        x: x, y: y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40 - 10,
        life: 600, max: 600, color: 'rgba(120,26,26,0.85)', size: 2.4
      });
    }
  }

  function addFloat(x, y, text, color) {
    S.floats.push({ x: x, y: y, text: text, color: color || '#fff', life: 900 });
  }

  /* ---------------------------------------------------------------------------
     그리기
     --------------------------------------------------------------------------- */
  function draw(ts) {
    if (!S) return;
    if (S.r3d) {
      try {
        S.r3d.render(S, ts);
      } catch (e) {
        on3dLost(null);
      }
      drawOverlay3d(ts);
      return;
    }
    var ctx = S.ctx;
    var dpr = S.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.shake > 0.05) {
      ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    }
    if (S.bg) ctx.drawImage(S.bg, 0, 0, S.pw, S.ph);
    else { ctx.fillStyle = '#101a16'; ctx.fillRect(0, 0, S.pw, S.ph); }

    ctx.save();
    ctx.translate(S.offX, S.offY);
    ctx.scale(S.scale, S.scale);

    drawDecor(ctx);
    drawObstacles(ctx);
    drawTrails(ctx);
    drawCorpses(ctx);

    // 유닛을 y 순으로 그린다
    var list = [];
    for (var i = 0; i < S.allies.length; i++) list.push(S.allies[i]);
    for (var j = 0; j < S.enemies.length; j++) list.push(S.enemies[j]);
    if (S.player) list.push(S.player);
    list.sort(function (a, b) { return a.y - b.y; });

    for (var k = 0; k < list.length; k++) {
      var u = list[k];
      if (u === S.player) drawPlayer(ctx, u);
      else drawUnit(ctx, u);
    }

    drawSlashes(ctx);
    drawCuts(ctx);
    drawParticles(ctx);
    drawFloats(ctx);
    ctx.restore();

    // 비네트
    var vg = ctx.createRadialGradient(S.pw / 2, S.ph / 2, Math.min(S.pw, S.ph) * 0.32,
      S.pw / 2, S.ph / 2, Math.max(S.pw, S.ph) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, S.pw, S.ph);
  }

  /* 3D 모드의 2D 오버레이 — 체력 바 · 데미지 숫자 · 화면 밖 적 방향 */
  function drawOverlay3d(ts) {
    if (!S || !S.r3d || !S.ctx || !el.canvas) return;
    var r = S.r3d;
    var ctx = S.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    var pw = S.pw, ph = S.ph;
    if (pw < 2 || ph < 2) return;
    var i, p;
    var cx = pw / 2, cy = ph / 2;

    // 조준선 · 적이 칼을 치켜들면 붉게 경고
    var danger = false;
    for (i = 0; i < S.enemies.length; i++) {
      var ew = S.enemies[i];
      if (ew.dead || !(ew.wind > 0)) continue;
      var edx = ew.x - S.player.x, edy = ew.y - S.player.y;
      if (edx * edx + edy * edy < 260 * 260) { danger = true; break; }
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = danger ? 'rgba(255,124,92,0.95)' : 'rgba(202,232,255,0.66)';
    ctx.lineWidth = danger ? 2.1 : 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, danger ? 10 : 7.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-14, 0); ctx.lineTo(-6, 0);
    ctx.moveTo(6, 0); ctx.lineTo(14, 0);
    ctx.moveTo(0, -14); ctx.lineTo(0, -6);
    ctx.moveTo(0, 6); ctx.lineTo(0, 14);
    ctx.stroke();
    ctx.fillStyle = danger ? '#ff9276' : '#e4f1ff';
    ctx.beginPath(); ctx.arc(0, 0, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // 화면 밖 적 → 가장자리 화살표
    var enCol = (S.cfg.enemy && S.cfg.enemy.color) || '#ef4444';
    for (i = 0; i < S.enemies.length; i++) {
      var en = S.enemies[i];
      if (en.dead) continue;
      p = r.project(en.x, en.y, 16);
      var inside = !p.behind && p.x > 18 && p.x < pw - 18 && p.y > 44 && p.y < ph - 96;
      if (inside) continue;
      var a = r.edgeAngle(en.x, en.y, 16);
      var ex = cx + Math.sin(a) * (pw / 2 - 18);
      var ey = cy - Math.cos(a) * (ph / 2 - 54);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = hexA(enCol, 0.95);
      ctx.strokeStyle = 'rgba(8,12,18,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(6.5, 6);
      ctx.lineTo(-6.5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // 체력 바 (다친 유닛만)
    for (i = 0; i < S.allies.length + S.enemies.length; i++) {
      var u = i < S.allies.length ? S.allies[i] : S.enemies[i - S.allies.length];
      if (!u || u.dead || u.hp >= u.maxHp) continue;
      p = r.project(u.x, u.y, 32);
      if (p.behind) continue;
      var bw = 24;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(p.x - bw / 2 - 1, p.y - 2.4, bw + 2, 5);
      ctx.fillStyle = u.team === 'enemy' ? '#f87171' : '#60a5fa';
      ctx.fillRect(p.x - bw / 2, p.y - 1.4, bw * clamp(u.hp / u.maxHp, 0, 1), 3);
    }

    // 데미지 · 콤보 숫자
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < S.floats.length; i++) {
      var f = S.floats[i];
      p = r.project(f.x, f.y, 38 + (900 - f.life) * 0.012);
      if (p.behind) continue;
      ctx.globalAlpha = clamp(f.life / 900, 0, 1);
      ctx.font = '800 12px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(4,8,14,0.9)';
      ctx.strokeText(f.text, p.x, p.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawDecor(ctx) {
    ctx.save();
    for (var i = 0; i < S.decor.length; i++) {
      var d = S.decor[i];
      ctx.strokeStyle = 'rgba(150,190,150,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + Math.cos(d.a) * d.s * 2, d.y - d.s * 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawObstacles(ctx) {
    for (var i = 0; i < S.obstacles.length; i++) {
      var o = S.obstacles[i];
      ctx.save();
      ctx.translate(o.x, o.y);
      // 그림자
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(2, o.r * 0.62, o.r * 1.02, o.r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();

      if (o.kind === 'rock') {
        var g = ctx.createLinearGradient(-o.r, -o.r, o.r, o.r);
        g.addColorStop(0, '#59626b');
        g.addColorStop(1, '#2c333a');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-o.r, o.r * 0.5);
        ctx.lineTo(-o.r * 0.6, -o.r * 0.8);
        ctx.lineTo(o.r * 0.25, -o.r);
        ctx.lineTo(o.r, -o.r * 0.1);
        ctx.lineTo(o.r * 0.7, o.r * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(180,195,210,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (o.kind === 'tent') {
        ctx.fillStyle = 'rgba(120,98,64,0.9)';
        ctx.beginPath();
        ctx.moveTo(-o.r, o.r * 0.7);
        ctx.lineTo(0, -o.r);
        ctx.lineTo(o.r, o.r * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(230,210,170,0.28)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -o.r);
        ctx.lineTo(0, o.r * 0.7);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(96,66,40,0.92)';
        ctx.fillRect(-o.r * 0.9, -o.r * 0.45, o.r * 1.8, o.r * 0.9);
        ctx.strokeStyle = 'rgba(220,190,140,0.3)';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(-o.r * 0.9, -o.r * 0.45, o.r * 1.8, o.r * 0.9);
        ctx.beginPath();
        ctx.arc(-o.r * 0.45, o.r * 0.55, o.r * 0.3, 0, Math.PI * 2);
        ctx.arc(o.r * 0.45, o.r * 0.55, o.r * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = '#2e2118';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawTrails(ctx) {
    for (var i = 0; i < S.trails.length; i++) {
      var t = S.trails[i];
      var a = 1 - t.t / t.dur;
      var col = (S.cfg.me && S.cfg.me.color) || '#3b82f6';
      ctx.save();
      ctx.globalAlpha = a * 0.45;
      var g = ctx.createLinearGradient(t.x, t.y, t.x - Math.cos(t.face) * 90, t.y - Math.sin(t.face) * 90);
      g.addColorStop(0, hexA(col, 0.9));
      g.addColorStop(1, hexA(col, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 9 * a + 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - Math.cos(t.face) * 90, t.y - Math.sin(t.face) * 90);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 베인 적: 칼날 각도 그대로 반쪽씩 갈라진 시체 */
  function drawCorpses(ctx) {
    for (var i = 0; i < S.corpses.length; i++) {
      var c = S.corpses[i];
      var a = clamp(c.life / c.max, 0, 1);
      var fade = a > 0.55 ? 1 : a / 0.55;
      var R = c.r + 10;
      ctx.save();
      ctx.globalAlpha = fade * 0.95;
      ctx.translate(c.x, c.y);

      // 그림자
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(0, c.r * 0.8, c.r * 0.9, c.r * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.rotate(c.cut);          // 칼날 각도 기준 좌표계
      ctx.beginPath();
      if (c.side < 0) ctx.rect(-R, -R, R * 2, R);
      else ctx.rect(-R, 0, R * 2, R);
      ctx.clip();                  // 칼날 한쪽만 남긴다

      // 잘린 단면
      ctx.strokeStyle = 'rgba(255,170,170,0.9)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-c.r * 1.1, c.side < 0 ? -0.6 : 0.6);
      ctx.lineTo(c.r * 1.1, c.side < 0 ? -0.6 : 0.6);
      ctx.stroke();

      ctx.rotate(c.rot);           // 조각이 회전하며 날아간다
      // 반쪽 몸통
      ctx.fillStyle = '#7f1d1d';
      ctx.beginPath();
      ctx.arc(0, 0, c.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.color;
      ctx.stroke();
      // 투구
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(0, -c.r * 0.25, c.r * 0.62, Math.PI, 0);
      ctx.fill();
      // 부러진 칼
      ctx.strokeStyle = '#dbeafe';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, c.r * 0.4);
      ctx.lineTo(c.r * 0.5, c.r * 0.95);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 칼이 지나간 자리의 섬광 선 */
  function drawCuts(ctx) {
    for (var i = 0; i < S.cuts.length; i++) {
      var c = S.cuts[i];
      var p = clamp(c.t / c.dur, 0, 1);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.ang);
      ctx.globalAlpha = 1 - p;
      var g = ctx.createLinearGradient(-c.len, 0, c.len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,240,240,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1 + 2.4 * (1 - p);
      ctx.beginPath();
      ctx.moveTo(-c.len, 0);
      ctx.lineTo(c.len, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawUnit(ctx, u) {    var meCol = (S.cfg.me && S.cfg.me.color) || '#3b82f6';
    var enCol = (S.cfg.enemy && S.cfg.enemy.color) || '#ef4444';
    var col = u.team === 'enemy' ? enCol : meCol;
    var body = u.team === 'enemy' ? '#7f1d1d' : '#1e3a8a';
    ctx.save();
    ctx.translate(u.x, u.y);

    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, u.r * 0.78, u.r * 0.95, u.r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // 몸통
    ctx.fillStyle = u.hit > 0 ? '#ffffff' : body;
    ctx.beginPath();
    ctx.arc(0, 0, u.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = hexA(col, 0.9);
    ctx.stroke();

    // 투구
    ctx.fillStyle = hexA(col, 0.85);
    ctx.beginPath();
    ctx.arc(0, -u.r * 0.25, u.r * 0.62, Math.PI, 0);
    ctx.fill();

    // 칼
    var sw = u.swing > 0 ? (1 - u.swing / 180) : 0;
    var a = u.face - 0.7 + sw * 1.5;
    ctx.strokeStyle = u.wind > 0 ? '#fca5a5' : '#dbeafe';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(Math.cos(u.face) * u.r * 0.5, Math.sin(u.face) * u.r * 0.5);
    ctx.lineTo(Math.cos(a) * (u.r + 11), Math.sin(a) * (u.r + 11));
    ctx.stroke();

    // 공격 예고
    if (u.wind > 0) {
      ctx.strokeStyle = 'rgba(248,113,113,' + (0.25 + 0.5 * (1 - u.wind / 320)) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, u.r + 14, u.face - 0.6, u.face + 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // 체력
    if (u.hp < u.maxHp) {
      var w = 18;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(u.x - w / 2, u.y - u.r - 9, w, 3);
      ctx.fillStyle = u.team === 'enemy' ? '#f87171' : '#60a5fa';
      ctx.fillRect(u.x - w / 2, u.y - u.r - 9, w * clamp(u.hp / u.maxHp, 0, 1), 3);
    }
  }

  function drawPlayer(ctx, pl) {
    var col = (S.cfg.me && S.cfg.me.color) || '#3b82f6';
    ctx.save();
    ctx.translate(pl.x, pl.y);

    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, pl.r * 0.8, pl.r * 1.05, pl.r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    // 후광
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, pl.r + 5, 0, Math.PI * 2);
    ctx.fillStyle = hexA(col, 0.18);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 망토
    ctx.fillStyle = hexA(col, 0.75);
    ctx.beginPath();
    ctx.moveTo(-pl.r * 0.9, -pl.r * 0.3);
    ctx.quadraticCurveTo(0, pl.r * 2.1, pl.r * 0.9, -pl.r * 0.3);
    ctx.closePath();
    ctx.fill();

    // 몸통
    ctx.fillStyle = pl.hit > 0 ? '#ffffff' : '#12233d';
    ctx.beginPath();
    ctx.arc(0, 0, pl.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = pl.guard ? '#93c5fd' : '#ffffff';
    ctx.stroke();

    // 투구
    ctx.fillStyle = hexA(col, 0.95);
    ctx.beginPath();
    ctx.arc(0, -pl.r * 0.28, pl.r * 0.66, Math.PI, 0);
    ctx.fill();

    // 방패 (막기)
    if (pl.guard) {
      ctx.save();
      ctx.rotate(pl.face);
      var fresh = pl.guardT <= PARRY_MS;
      ctx.strokeStyle = fresh ? '#fef08a' : 'rgba(147,197,253,0.85)';
      ctx.lineWidth = fresh ? 3.4 : 2.4;
      ctx.beginPath();
      ctx.arc(pl.r * 0.4, 0, pl.r + 9, -0.95, 0.95);
      ctx.stroke();
      ctx.restore();
    }

    // 칼
    var swingT = pl.atkAnim > 0 ? (1 - pl.atkAnim / 260) : 0;
    var ang = pl.face + (pl.atkAnim > 0 ? (-0.9 + swingT * 1.8) : 0.45);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(pl.face) * pl.r * 0.4, Math.sin(pl.face) * pl.r * 0.4);
    ctx.lineTo(Math.cos(ang) * (pl.r + 17), Math.sin(ang) * (pl.r + 17));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 무적 깜빡임
    if (S.invuln > 0) {
      ctx.strokeStyle = 'rgba(167,243,208,' + (0.3 + 0.3 * Math.sin(S.time / 90)) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, pl.r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSlashes(ctx) {
    for (var i = 0; i < S.slashes.length; i++) {
      var s = S.slashes[i];
      var p = s.t / s.dur;
      var r = s.r * (0.55 + p * 0.55);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.face);
      ctx.globalAlpha = 1 - p;
      var g = ctx.createLinearGradient(0, 0, r, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.05)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(191,219,254,0.05)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 8 * (1 - p) + 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, r, -SLASH_ARC, SLASH_ARC);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles(ctx) {
    for (var i = 0; i < S.particles.length; i++) {
      var p = S.particles[i];
      var a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloats(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < S.floats.length; i++) {
      var f = S.floats[i];
      var a = clamp(f.life / 900, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = '800 11px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,8,14,0.85)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------------------
     HUD · 서버 보고
     --------------------------------------------------------------------------- */
  function updateHud() {
    if (!S) return;
    var pl = S.player;
    var hpPct = clamp(pl.hp / pl.maxHp, 0, 1);
    if (el.hpFill) {
      el.hpFill.style.width = Math.round(hpPct * 100) + '%';
      el.hpFill.className = hpPct < 0.3 ? 'low' : (pl.guard ? 'guard' : '');
    }
    if (el.hpText) el.hpText.textContent = String(Math.max(0, Math.round(pl.hp)));
    if (el.kills) el.kills.textContent = String(S.kills);
    if (el.enemyLeft) el.enemyLeft.textContent = '적 ' + Math.max(0, S.enemyTotal - S.defeated);
    if (el.combo) {
      if (S.combo > 1) {
        el.combo.textContent = S.combo + ' 콤보';
        el.combo.classList.add('show');
      } else {
        el.combo.textContent = '';
        el.combo.classList.remove('show');
      }
    }
    if (el.hint) {
      if (pl.guard) el.hint.textContent = '막는 중 · 적이 휘두르기 직전에 누르면 패링';
      else if (pl.dashCd > 0) el.hint.textContent = '돌진 준비 ' + (pl.dashCd / 1000).toFixed(1) + '초';
      else if (S.r3d) el.hint.textContent = '왼쪽 드래그 이동 · 오른쪽 드래그 시점 · 오른쪽 탭/⚔️ 베기 · 🛡️ 막기';
      else el.hint.textContent = '왼쪽 드래그 이동 · 오른쪽 탭/⚔️ 베기 · 🛡️로 막고 패링';
    }
  }

  function report(force) {
    if (!S || S.ended) return;
    var now = S.time;
    if (!force && now - S.reportAt < 1000) return;
    S.reportAt = now;
    if (S.kills === S.reported) return;
    S.reported = S.kills;
    if (S.hooks.onReport) {
      try { S.hooks.onReport(S.kills); } catch (e) { /* noop */ }
    }
  }

  /** 서버가 검증해 적용한 결과를 화면에 보여준다 */
  function applyUpdate(payload) {
    if (!S || !payload) return;
    var d = payload.delta || {};
    var pl = S.player;
    if (payload.skirmish && payload.skirmish.target) {
      S.targetTroops = payload.skirmish.target.troops;
    }
    if (d.damage > 0) {
      addFloat(pl.x, pl.y - 44, '적 병력 -' + d.damage, '#86efac');
      S.shake = Math.max(S.shake, 4);
      flash('rgba(74,222,128,0.22)');
    }
    if (d.reinforce > 0) {
      addFloat(pl.x, pl.y - 58, '아군 +' + d.reinforce, '#93c5fd');
    }
    if (d.defenseBreak) {
      addFloat(W / 2, H * 0.22, '적 수비 약화!', '#fbbf24');
    }
    updateTargetInfo();
  }

  function updateTargetInfo() {
    if (!S || !el.targetInfo) return;
    var cfg = S.cfg;
    el.targetInfo.textContent = cfg.target.name + ' · 적 병력 ' + S.targetTroops;
  }

  function flash(color) {
    if (!el.flash) return;
    el.flash.style.background = color;
    el.flash.classList.add('show');
    setTimeout(function () { if (el.flash) el.flash.classList.remove('show'); }, 140);
  }

  /* ---------------------------------------------------------------------------
     종료
     --------------------------------------------------------------------------- */
  /** 같은 설정으로 새 판 (대규모 전장 · 다시 싸우기) */
  function restartBattle() {
    if (!S) return;
    var prev = S.cfg;
    var hooks = S.hooks;
    var next = {};
    for (var k in prev) next[k] = prev[k];
    next.seed = ((prev.seed || 1) * 7919 + 1013) % 2147483647;
    next.id = String(prev.id || 'arena') + '-r';
    closeLocal();
    open(next, hooks);
  }

  function finish(reason) {
    if (!S || S.ended) return;
    var kills = S.kills;
    S.ended = true;
    S.endReason = reason || 'return';
    report(true);
    if (S.hooks.onEnd) {
      try { S.hooks.onEnd(S.endReason, kills); } catch (e) { /* noop */ }
    }
    // 결과 배너를 잠깐 보여주고 닫는다
    if (el.result && el.resultTitle) {
      var title = reason === 'win' ? '전선 돌파!' : reason === 'timeout' ? '시간 종료' : '지도로 복귀';
      el.resultTitle.textContent = title;
      if (el.resultLine) el.resultLine.textContent = kills + '명 처치';
      el.result.classList.remove('hidden');
    }
    var closeAfter = reason === 'win' ? 1200 : 520;
    setTimeout(function () { closeLocal(); }, closeAfter);
  }

  /** 서버가 끝낸 참전(시간 초과·전선 상실·접속 끊김)을 화면에 알리고 닫는다 */
  function forceClose(summary) {
    if (!S || S.ended) return;
    var kills = S.kills;
    S.ended = true;
    if (S.hooks.onServerEnd) {
      try { S.hooks.onServerEnd(summary); } catch (e) { /* noop */ }
    }
    if (el.result && el.resultTitle) {
      el.resultTitle.textContent = summary && summary.reason === 'lost' ? '전선 상실' : '참전 종료';
      if (el.resultLine) el.resultLine.textContent = kills + '명 처치';
      el.result.classList.remove('hidden');
    }
    setTimeout(function () { closeLocal(); }, 700);
  }

  /** 결과 요약을 잠깐 띄운다 (지도 위 토스트로도 전달됨) */
  function summaryText(sum) {
    if (!sum) return '';
    var bits = [];
    if (sum.kills) bits.push(sum.kills + '명 처치');
    if (sum.damage) bits.push('적 병력 -' + sum.damage);
    if (sum.reinforce) bits.push('아군 +' + sum.reinforce);
    return bits.join(' · ');
  }

  window.TWArena = {
    open: open,
    close: closeLocal,
    restart: restartBattle,
    isOpen: isOpen,
    mode: function () { return S ? (S.r3d ? '3d' : '2d') : 'none'; },
    renderer3d: function () { return S ? S.r3d : null; },
    applyUpdate: applyUpdate,
    forceClose: forceClose,
    summaryText: summaryText,
    finish: finish,
    state: function () { return S; }
  };
})();
