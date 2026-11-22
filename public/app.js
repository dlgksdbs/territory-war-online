/* =============================================================================
   영토 전쟁 ONLINE · 실시간 클라이언트
   - 서버가 보내는 권위 상태(state · tick)를 그리기만 한다.
   - 모든 조작은 WebSocket 메시지로 서버에 요청한다.
   ============================================================================= */
(function () {
  'use strict';

  /* ---------------- 상수 ---------------- */
  var NATIONS = [
    { id: 0, name: '청룡 왕국', short: '청룡', color: '#3b82f6', fill: '#1d4fd8' },
    { id: 1, name: '적화 연방', short: '적화', color: '#ef4444', fill: '#b91c1c' },
    { id: 2, name: '녹림 동맹', short: '녹림', color: '#22c55e', fill: '#15803d' },
    { id: 3, name: '황금 제국', short: '황금', color: '#f59e0b', fill: '#b45309' }
  ];
  var NEUTRAL = { id: -1, name: '중립 세력', short: '중립', color: '#94a3b8', fill: '#334155' };
  var SPEEDS = [1, 2, 4];

  var SESSION_KEY = 'tw_online_session_v1';
  var NAME_KEY = 'tw_online_name';
  var RATIO_KEY = 'tw_online_ratio';

  /* ---------------- 런타임 상태 ---------------- */
  var els = {};
  var ws = null;
  var connected = false;
  var reconnectAttempt = 0;
  var reconnectTimer = null;

  var me = { code: null, token: null, slot: null, control: null, name: '' };
  var room = null;
  var state = null;
  var selected = null;
  var ratio = 0.5;
  var spectatePick = null;
  var toastTimer = null;
  var propShowing = null;
  var resultShown = false;
  var elimShown = false;
  var confirmLeaveAt = 0;
  var confirmBreak = { slot: null, at: 0 };
  var lastDiploRender = 0;

  var marches = {};          // id -> { id, owner, from, to, n, dur, startLocal }
  var flashes = {};          // regionId -> { at, kind }

  var canvas = null, ctx = null, mapWrap = null;
  var dpr = 1, scale = 1, offX = 0, offY = 0;
  var VW = 1000, VH = 1400;
  var bgCanvas = null, lightGrad = null;
  var mapBox = { x: 0, y: 0, w: VW, h: VH };

  /* =========================================================================
     공통 유틸
     ========================================================================= */
  function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* 무시 */ }
  }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  }

  function addPoly(c, poly) {
    if (!poly || poly.length < 3) return;
    c.moveTo(poly[0].x, poly[0].y);
    for (var i = 1; i < poly.length; i++) c.lineTo(poly[i].x, poly[i].y);
    c.closePath();
  }

  function mmss(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + ('0' + s).slice(-2);
  }

  function toast(msg, kind) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = 'show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = ''; }, 2200);
  }

  function copyText(text, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        toast(ok ? okMsg : '길게 눌러 복사해 주세요', ok ? 'good' : 'warn');
      } catch (e) {
        toast('길게 눌러 복사해 주세요', 'warn');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg, 'good');
        vibrate(8);
      }, fallback);
    } else {
      fallback();
    }
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 무시 */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 무시 */ }
  }

  function saveSession() {
    if (!me.code || !me.token) return;
    storageSet(SESSION_KEY, JSON.stringify({ code: me.code, token: me.token, name: me.name }));
    storageSet(NAME_KEY, me.name);
  }
  function clearSession() {
    storageRemove(SESSION_KEY);
    me.code = null;
    me.token = null;
    me.slot = null;
    me.control = null;
  }

  /* =========================================================================
     표시용 이름/색
     ========================================================================= */
  function mySlot() { return state && state.you != null ? state.you : (me.control == null ? -1 : me.control); }

  function playerOf(slot) {
    if (!state || !state.players) return null;
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].control === slot || (state.players[i].slot === slot && state.players[i].control == null)) {
        return state.players[i];
      }
    }
    return null;
  }

  function colorOf(owner) {
    return owner < 0 ? NEUTRAL.color : NATIONS[owner].color;
  }

  function longName(slot) {
    if (slot == null || slot < 0) return NEUTRAL.name;
    if (state && state.names && state.names[slot]) {
      var base = NATIONS[slot] ? NATIONS[slot].name : '';
      return state.names[slot] === base ? base : state.names[slot] + ' · ' + NATIONS[slot].short;
    }
    return NATIONS[slot] ? NATIONS[slot].name : '?';
  }

  function shortName(slot) {
    if (slot == null || slot < 0) return NEUTRAL.short;
    if (state && state.names && state.names[slot]) {
      var base = NATIONS[slot] ? NATIONS[slot].name : '';
      if (state.names[slot] !== base) return truncate(state.names[slot], 4);
    }
    return NATIONS[slot] ? NATIONS[slot].short : '?';
  }

  function countOwned(owner) {
    if (!state) return 0;
    var c = 0;
    for (var i = 0; i < state.regions.length; i++) if (state.regions[i].owner === owner) c++;
    return c;
  }

  function totalTroops(owner) {
    if (!state) return 0;
    var t = 0;
    for (var i = 0; i < state.regions.length; i++) if (state.regions[i].owner === owner) t += state.regions[i].troops;
    return t;
  }

  function armyOf(slot) {
    if (!state || !state.army) return null;
    for (var i = 0; i < state.army.length; i++) if (state.army[i].slot === slot) return state.army[i];
    return null;
  }

  function pactBetween(a, b) {
    if (!state || a == null || b == null || a === b || a < 0 || b < 0) return null;
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = 0; i < state.treaties.length; i++) {
      var t = state.treaties[i];
      if (t.a === lo && t.b === hi) return t;
    }
    return null;
  }

  function slotTitle(slot) {
    var n = longName(slot);
    var nat = NATIONS[slot] ? NATIONS[slot].name : '';
    return (nat && n !== nat) ? n + ' · ' + nat : n;
  }

  function relationWith(slot) {
    if (!state || !state.relations) return 0;
    var lo = Math.min(mySlot(), slot), hi = Math.max(mySlot(), slot);
    for (var i = 0; i < state.relations.length; i++) {
      var r = state.relations[i];
      if (r.a === lo && r.b === hi) return r.value;
    }
    return 0;
  }

  function reputationOf(slot) {
    if (!state || !state.reputation) return 60;
    return typeof state.reputation[slot] === 'number' ? state.reputation[slot] : 60;
  }

  function relationInfo(v) {
    if (v <= -35) return { cls: 'hostile', label: '적대 ' + v };
    if (v < 0) return { cls: 'cold', label: '냉랭 ' + v };
    if (v < 30) return { cls: 'neutral', label: '중립 +' + v };
    if (v < 60) return { cls: 'friendly', label: '우호 +' + v };
    return { cls: 'trusted', label: '신뢰 +' + v };
  }

  function secLeft(t) {
    return Math.max(0, Math.ceil((t.left || 0) / 1000));
  }

  function treatyLabel(t) {
    if (!t) return '교전 중';
    if (t.type === 'ally') return '동맹 ' + secLeft(t) + '초';
    if (t.type === 'tribute') return '조공 ' + secLeft(t) + '초';
    return '불가침 ' + secLeft(t) + '초';
  }

  function treatyPillClass(t) {
    if (!t) return 'war';
    if (t.type === 'ally') return 'ally';
    return 'truce';
  }

  function callForMe() {
    if (!state || !state.calls) return null;
    var s = mySlot();
    for (var i = 0; i < state.calls.length; i++) {
      if (state.calls[i].to === s && state.calls[i].left > 0) return state.calls[i];
    }
    return null;
  }

  function isEnemyOfMe(slot) {
    if (!state) return false;
    return slot !== mySlot() && state.active[slot] && countOwned(slot) > 0 && !pactBetween(mySlot(), slot);
  }

  function hasCallTarget(allySlot) {
    for (var i = 0; i < NATIONS.length; i++) {
      if (!isEnemyOfMe(i)) continue;
      if (i === allySlot) continue;
      if (!pactBetween(allySlot, i)) return true;
    }
    return false;
  }

  function canAct() {
    var s = mySlot();
    return !!(state && !state.over && s >= 0 && !state.delegate && countOwned(s) > 0);
  }

  function canAidNow() {
    var s = mySlot();
    if (!state || s < 0) return false;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].owner === s && state.regions[i].troops >= 6) return true;
    }
    return false;
  }

  function pendingForMe() {
    if (!state) return [];
    var out = [];
    var s = mySlot();
    for (var i = 0; i < state.proposals.length; i++) {
      if (state.proposals[i].to === s) out.push(state.proposals[i]);
    }
    return out;
  }

  function soloGame() {
    if (!state) return false;
    var humans = 0;
    for (var i = 0; i < state.players.length; i++) if (!state.players[i].isAI) humans++;
    return humans <= 1;
  }

  function isHost() {
    return !!(state && state.host === me.slot);
  }

  /* =========================================================================
     WebSocket
     ========================================================================= */
  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', function () { /* close 가 이어서 처리 */ });
  }

  function onOpen() {
    connected = true;
    reconnectAttempt = 0;
    hideNet();
    if (me.code && me.token) {
      sendRaw({ type: 'resume', code: me.code, token: me.token });
    }
  }

  function onClose() {
    connected = false;
    showNet(me.code ? '연결이 끊겼어요 · 자리를 지키는 중' : '연결이 끊겼어요 · 다시 연결 중');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(8000, 600 * Math.pow(2, Math.min(reconnectAttempt, 4)));
    reconnectAttempt++;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function send(obj) {
    if (!connected) {
      toast('연결 중이에요 · 잠시 후 다시 시도해 주세요', 'warn');
      connect();
      return false;
    }
    return sendRaw(obj);
  }

  function onMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'joined' || msg.type === 'resumed') {
      me.code = msg.code;
      me.token = msg.token;
      me.slot = msg.slot;
      me.name = msg.name;
      me.control = msg.slot;
      saveSession();
      if (msg.type === 'resumed') {
        hideBoot();
        toast('자리로 돌아왔습니다', 'good');
      }
      return;
    }

    if (msg.type === 'lobby') {
      room = msg;
      hideBoot();
      if (msg.started && !state) return;
      if (state) {
        state = null;
        selected = null;
        spectatePick = null;
        resultShown = false;
        elimShown = false;
        marches = {};
        closeDiplo();
        hideResult();
        hideElim();
        hideGame();
      }
      showRoom();
      renderRoom();
      return;
    }

    if (msg.type === 'started') {
      hideBoot();
      showGame();
      if (msg.sim) toast('AI 시뮬레이션 · 나라를 탭해 난입!', 'good');
      return;
    }

    if (msg.type === 'state') { onState(msg); return; }
    if (msg.type === 'tick') { onTick(msg); return; }

    if (msg.type === 'event') {
      if (msg.at != null) flashes[msg.at] = { at: Date.now(), kind: msg.kind === 'good' ? 'good' : 'bad' };
      var kind = msg.kind || 'info';
      var sNow = mySlot();
      var mineHere = sNow >= 0 && (msg.attacker === sNow || msg.defender === sNow);
      if (msg.text && (!msg.battle || mineHere)) {
        if (kind === 'move') {
          if (els.toast && els.toast.className.indexOf('show') < 0) toast(msg.text, 'info');
        } else {
          toast(msg.text, kind);
        }
      }
      if (kind === 'bad' && mineHere) vibrate(16);
      return;
    }

    if (msg.type === 'error') {
      toast(msg.message || '문제가 생겼어요', 'bad');
      return;
    }

    if (msg.type === 'resume_failed') {
      clearSession();
      state = null;
      room = null;
      hideBoot();
      hideGame();
      closeDiplo();
      showHome();
      toast(msg.message || '방을 찾을 수 없어요', 'warn');
      return;
    }

    if (msg.type === 'left') {
      clearSession();
      state = null;
      room = null;
      marches = {};
      hideBoot();
      hideGame();
      closeDiplo();
      hideResult();
      hideElim();
      showHome();
      toast('방에서 나왔습니다');
      return;
    }

    if (msg.type === 'pong') return;
  }

  /* =========================================================================
     상태 반영
     ========================================================================= */
  function syncMarches(list, reset) {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    var seen = {};
    if (reset) marches = {};
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      seen[m.id] = true;
      var cur = marches[m.id];
      if (!cur) {
        cur = { id: m.id, owner: m.owner, from: m.from, to: m.to, n: m.n, dur: m.dur || 1200 };
        cur.startLocal = now - ((m.dur || 1200) - (m.left || 0));
        marches[m.id] = cur;
      } else {
        cur.owner = m.owner; cur.from = m.from; cur.to = m.to; cur.n = m.n;
        cur.dur = m.dur || cur.dur;
        cur.startLocal = now - ((m.dur || cur.dur) - (m.left || 0));
      }
    }
    for (var id in marches) if (!seen[id]) delete marches[id];
  }

  function onState(s) {
    var first = !state;
    state = s;
    hideBoot();
    hideNet();
    showGame();
    if (s.you != null) me.control = s.you;
    if (s.code) me.code = s.code;
    computeMapBox();
    syncMarches(s.marches || [], true);

    if (first) {
      selected = null;
      resultShown = false;
      elimShown = false;
    }
    if (mySlot() >= 0) spectatePick = null;

    if (selected != null) {
      var sr = s.regions[selected];
      if (!sr || sr.owner !== mySlot()) selected = null;
    }

    updateHUD();
    updateBanner();
    renderSpectate();
    renderMenuPlayers();
    renderRatio();
    maybeShowProposal();
    requestAnimationFrame(function () { resizeCanvas(); });

    if (s.over) showResult();
    else if (!first) hideResult();
    maybeShowElim();
  }

  function onTick(t) {
    if (!state) return;
    state.time = t.time;
    state.over = t.over;
    state.speed = t.speed;
    state.sim = t.sim;
    state.delegate = t.delegate;
    if (t.you != null) state.you = t.you;
    if (t.regions) {
      for (var i = 0; i < state.regions.length && i < t.regions.length; i++) {
        state.regions[i].owner = t.regions[i][0];
        state.regions[i].troops = t.regions[i][1];
      }
    }
    syncMarches(t.marches || [], false);
    state.treaties = t.treaties || [];
    state.proposals = t.proposals || [];
    state.relations = t.relations || [];
    state.reputation = t.reputation || {};
    state.calls = t.calls || [];
    state.army = t.army || [];
    state.leader = t.leader || null;
    state.players = t.players || state.players;
    state.stats = t.stats || state.stats;
    if (t.diploLog) state.diploLog = t.diploLog;
    if (t.log) state.log = t.log;

    if (selected != null) {
      var sr = state.regions[selected];
      if (!sr || sr.owner !== mySlot()) selected = null;
    }
    updateHUD();
    updateBanner();
    renderSpectate();
    renderMenuPlayers();

    var now = Date.now();
    if (els.diploModal.classList.contains('show') && now - lastDiploRender > 900) {
      lastDiploRender = now;
      renderDiplo();
    }
    maybeShowProposal();

    if (t.over) showResult();
    else {
      if (resultShown) hideResult();
      maybeShowElim();
    }
  }

  /* =========================================================================
     화면 전환
     ========================================================================= */
  function showGame() {
    els.lobby.classList.add('hidden');
    els.app.classList.remove('hidden');
    requestAnimationFrame(function () {
      resizeCanvas();
      updateHUD();
    });
  }

  function hideGame() {
    els.app.classList.add('hidden');
  }

  function showHome() {
    els.lobby.classList.remove('hidden');
    els.homePanel.hidden = false;
    els.roomPanel.hidden = true;
  }

  function showRoom() {
    els.lobby.classList.remove('hidden');
    els.homePanel.hidden = true;
    els.roomPanel.hidden = false;
    renderRoom();
  }

  function showBoot(text) {
    if (!els.boot) return;
    els.bootText.textContent = text || '연결 중…';
    els.boot.classList.add('show');
  }
  function hideBoot() { if (els.boot) els.boot.classList.remove('show'); }

  function showNet(text) {
    if (els.netText && text) els.netText.textContent = text;
    if (els.netBar) els.netBar.classList.add('show');
  }
  function hideNet() {
    if (els.netBar && connected) els.netBar.classList.remove('show');
  }

  /* =========================================================================
     로비
     ========================================================================= */
  function renderRoom() {
    if (!room) return;
    els.roomCode.textContent = room.code;
    els.menuCode.textContent = room.code;

    var host = room.host === (me.slot == null ? -1 : me.slot);
    var players = room.players || [];
    var html = '';
    for (var i = 0; i < 4; i++) {
      var p = null;
      for (var k = 0; k < players.length; k++) if (players[k].slot === i) p = players[k];
      var nat = NATIONS[i];
      if (p) {
        var isMe = p.slot === me.slot;
        html += '<div class="room-p' + (isMe ? ' me' : '') + (p.isAI ? ' ai' : '') + '">' +
          '<i class="dot" style="color:' + nat.color + '"></i>' +
          '<span class="pname">' + esc(p.name) + '</span>' +
          '<span class="pnation">' + nat.short + (p.host ? ' · 방장' : '') + '</span>' +
          (isMe ? '<span class="crown">나</span>' : '') +
          '<span class="seat">' + (p.isAI ? '<span class="ai-tag">AI</span>' : '') +
          '<i class="live' + (p.connected ? '' : ' off') + '"></i></span>' +
        '</div>';
      } else if (room.aiFill) {
        html += '<div class="room-p ai">' +
          '<i class="dot" style="color:' + nat.color + ';opacity:.5"></i>' +
          '<span class="pname" style="color:#8fa3c2">AI ' + nat.name + '</span>' +
          '<span class="seat"><span class="ai-tag">AI</span></span>' +
        '</div>';
      } else {
        html += '<div class="room-p empty">' +
          '<i class="dot" style="color:#475569"></i>' +
          '<span class="pname">빈 자리 · 중립</span>' +
          '<span class="seat">' + nat.short + '</span>' +
        '</div>';
      }
    }
    els.roomPlayers.innerHTML = html;

    els.aiToggle.checked = !!room.aiFill;
    els.aiRow.classList.toggle('disabled', !host);
    els.aiToggle.disabled = !host;

    var speedBtns = els.roomSpeed.getElementsByTagName('button');
    for (var s = 0; s < speedBtns.length; s++) {
      speedBtns[s].className = 'seg-btn' + (Number(speedBtns[s].getAttribute('data-speed')) === (room.speed || 1) ? ' on' : '');
      speedBtns[s].disabled = !host;
    }

    var humanCount = players.filter(function (p) { return !p.isAI; }).length;
    var canStart = host && (humanCount >= 2 || room.aiFill);
    els.btnStart.hidden = !host;
    els.btnStart.disabled = !canStart;
    els.waitHost.hidden = host;

    var note;
    if (host) {
      if (humanCount >= 2) {
        note = humanCount + '명이 함께합니다' + (room.aiFill && humanCount < 4 ? ' · 남는 ' + (4 - humanCount) + '자리는 AI' : '') + '.';
      } else if (room.aiFill) {
        note = '혼자 시작하면 AI 3개국과 실시간으로 겨룹니다. 친구가 들어오면 그 자리는 사람이 맡아요.';
      } else {
        note = '친구가 최소 한 명 더 들어와야 시작할 수 있어요.';
      }
    } else {
      note = '방장이 시작하면 게임이 열립니다. (지금 ' + humanCount + '명 대기 중)';
    }
    els.roomNote.textContent = note;
  }

  /* =========================================================================
     HUD · 배너
     ========================================================================= */
  function updateHUD() {
    if (!state) return;
    var s = mySlot();
    var owned = s >= 0 ? countOwned(s) : 0;
    var total = state.regions.length;
    var pct = total ? Math.round((owned / total) * 100) : 0;
    var army = s >= 0 ? armyOf(s) : null;

    els.statTime.textContent = mmss(state.time);
    els.statLand.textContent = s >= 0 ? owned + '/' + total : total - countOwned(-1) + '/' + total;
    els.statTroops.textContent = s >= 0 ? String(totalTroops(s)) : '—';
    els.statProd.textContent = army ? (army.prod || 0).toFixed(1) + '/s' : '—';
    els.btnSpeed.textContent = '×' + (state.speed || 1);

    var html = '';
    for (var i = 0; i < NATIONS.length; i++) {
      if (state.active && !state.active[i]) continue;
      var c = countOwned(i);
      var isLeader = state.leader && state.leader.slot === i;
      html += '<span class="leg' + (i === s ? ' cur' : '') + (c === 0 ? ' dead' : '') +
        '" style="color:' + NATIONS[i].color + '">' +
        (isLeader ? '<b class="crown-ico">♛</b>' : '') +
        '<i class="dot"></i>' + esc(shortName(i)) +
        ' <span class="n">' + c + '</span></span>';
    }
    html += '<span class="leg' + (countOwned(-1) === 0 ? ' dead' : '') +
      '" style="color:#8fa0b8"><i class="dot"></i>중립 <span class="n">' + countOwned(-1) + '</span></span>';
    els.legend.innerHTML = html;

    // AI 위임 표시
    var delegated = s >= 0 && state.delegate;
    els.delegateBar.classList.toggle('hidden', !delegated);
    els.ratioRow.classList.toggle('hidden', s < 0 || delegated || state.over);
    var deadNow = s >= 0 && !state.over && countOwned(s) === 0 && !delegated;
    els.specChip.classList.toggle('hidden', !deadNow);
    if (deadNow) els.specChip.textContent = state.sim ? '탈락 · 관전 중 (다른 나라 참전 가능)' : '탈락 · 관전 중';

    // 속도 버튼은 호스트 + 혼자/시뮬레이션일 때만
    var showSpeed = isHost() && soloGame();
    els.btnSpeed.classList.toggle('hidden', !showSpeed);

    // 외교 버튼 알림
    var pend = pendingForMe().length;
    els.btnDiplo.className = pend > 0 ? 'has' : '';
    els.btnDiplo.innerHTML = pend > 0 ? '외교<i class="dotb"></i>' : '외교';

    renderHint();
  }

  function renderHint() {
    if (!state) return;
    var s = mySlot();
    var hint = '';
    if (state.over) {
      hint = '게임이 끝났습니다';
    } else if (s < 0) {
      hint = '관전 중 · 참전할 나라를 탭하세요 (' + (state.speed || 1) + '배속)';
    } else if (state.delegate) {
      hint = '🤖 AI가 대신 싸우는 중 · [조종 가져오기]로 직접 지휘';
    } else if (countOwned(s) === 0) {
      hint = '영토를 모두 잃었습니다 · 관전 중';
    } else if (selected != null) {
      var sel = state.regions[selected];
      var send = Math.max(1, Math.min(sel.troops - 1, Math.floor(sel.troops * ratio)));
      hint = '<b>' + esc(sel.name) + '</b> 병력 ' + sel.troops + ' · 보낼 <b>' + send +
        '</b> · 옆 영토를 탭해 출정';
    } else {
      hint = '내 영토를 탭하고 옆 영토를 탭하면 바로 출정 · 보낼 병력 ' +
        Math.round(ratio * 100) + '%';
    }
    var call = callForMe();
    if (call && s >= 0) hint += ' · 🤝 ' + esc(shortName(call.target)) + ' 공동 참전';
    els.hint.innerHTML = hint;
  }

  function updateBanner() {
    if (!state) { els.liveBanner.className = ''; return; }
    var s = mySlot();
    var text = '';
    var cls = '';
    if (state.over) {
      var w = state.over.winner;
      text = w < 0 ? '무승부' : '<b style="color:' + colorOf(w) + '">' + esc(longName(w)) + '</b> 승리';
      cls = 'show';
    } else if (s < 0) {
      var lead = state.leader;
      text = '관전 중 · ' + (lead ? '1위 <b style="color:' + colorOf(lead.slot) + '">' +
        esc(shortName(lead.slot)) + '</b> ' + lead.share + '%' : '난전 중');
      cls = 'show';
    } else if (state.delegate) {
      text = '';
      cls = '';
    } else if (countOwned(s) === 0) {
      text = '탈락 · 관전 중';
      cls = 'show';
    } else {
      text = '';
      cls = '';
    }
    els.liveBanner.innerHTML = text;
    els.liveBanner.className = cls;
  }

  /* =========================================================================
     관전 · 난입
     ========================================================================= */
  function renderSpectate() {
    if (!state) return;
    var s = mySlot();
    var show = s < 0 && !state.over;
    els.spectateBar.classList.toggle('hidden', !show);
    if (!show) return;

    var html = '';
    for (var i = 0; i < NATIONS.length; i++) {
      if (state.active && !state.active[i]) continue;
      var c = countOwned(i);
      if (c === 0) continue;
      var a = armyOf(i);
      html += '<button class="sp-nation' + (spectatePick === i ? ' on' : '') + '" type="button" data-slot="' + i + '">' +
        '<i class="dot" style="color:' + NATIONS[i].color + '"></i>' +
        '<span class="sp-nm">' + esc(shortName(i)) + '</span>' +
        '<span class="sp-n">' + c + ' · ' + (a ? a.troops : 0) + '</span>' +
      '</button>';
    }
    els.spNations.innerHTML = html;
    els.btnJump.disabled = spectatePick == null;
    if (spectatePick == null) {
      els.spPick.textContent = '참전할 나라를 탭하세요';
    } else {
      els.spPick.textContent = NATIONS[spectatePick].name + ' 로 참전합니다';
    }
  }

  function pickNation(slot) {
    if (slot == null || slot < 0) return;
    if (!state || !state.active[slot] || countOwned(slot) === 0) {
      toast('그 나라는 참전할 수 없어요', 'warn');
      return;
    }
    spectatePick = slot;
    renderSpectate();
    vibrate(8);
  }

  /* =========================================================================
     캔버스 렌더
     ========================================================================= */
  function buildBackground() {
    var w = canvas.width, h = canvas.height;
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = w;
    bgCanvas.height = h;
    var b = bgCanvas.getContext('2d');
    var g = b.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1828');
    g.addColorStop(0.45, '#08101c');
    g.addColorStop(1, '#04070e');
    b.fillStyle = g;
    b.fillRect(0, 0, w, h);

    var dots = Math.round((w * h) / 9000);
    for (var i = 0; i < dots; i++) {
      var x = Math.random() * w, y = Math.random() * h;
      var r = (0.6 + Math.random() * 1.5) * dpr;
      b.beginPath();
      b.arc(x, y, r, 0, Math.PI * 2);
      b.fillStyle = 'rgba(120,170,255,' + (0.02 + Math.random() * 0.05).toFixed(3) + ')';
      b.fill();
    }

    var rg = b.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.15, w / 2, h / 2, Math.max(w, h) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, 'rgba(0,0,0,0.6)');
    b.fillStyle = rg;
    b.fillRect(0, 0, w, h);
  }

  function buildLightGradient() {
    lightGrad = ctx.createLinearGradient(0, 0, 0, VH);
    lightGrad.addColorStop(0, 'rgba(255,255,255,0.10)');
    lightGrad.addColorStop(0.35, 'rgba(255,255,255,0.015)');
    lightGrad.addColorStop(1, 'rgba(0,0,0,0.22)');
  }

  function computeMapBox() {
    if (!state) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < state.regions.length; i++) {
      var poly = state.regions[i].poly;
      for (var k = 0; k < poly.length; k++) {
        var p = poly[k];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return;
    var pad = 34;
    mapBox = {
      x: minX - pad,
      y: minY - pad,
      w: (maxX - minX) + pad * 2,
      h: (maxY - minY) + pad * 2
    };
  }

  function resizeCanvas() {
    if (!canvas || !mapWrap) return;
    var rect = mapWrap.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scale = Math.min(w / mapBox.w, h / mapBox.h);
    offX = (w - mapBox.w * scale) / 2 - mapBox.x * scale;
    offY = (h - mapBox.h * scale) / 2 - mapBox.y * scale;
    buildBackground();
    buildLightGradient();
    render();
  }

  function drawMarches(ts) {
    var ids = Object.keys(marches);
    for (var k = 0; k < ids.length; k++) {
      var m = marches[ids[k]];
      var from = state.regions[m.from];
      var to = state.regions[m.to];
      if (!from || !to) continue;
      var prog = clampNum((ts - m.startLocal) / (m.dur || 1200), 0, 1);
      var x = from.cx + (to.cx - from.cx) * prog;
      var y = from.cy + (to.cy - from.cy) * prog;
      var col = colorOf(m.owner);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(from.cx, from.cy);
      ctx.lineTo(to.cx, to.cy);
      ctx.setLineDash([6 / scale, 7 / scale]);
      ctx.lineWidth = 1.6 / scale;
      ctx.strokeStyle = hexA(col, 0.28 + 0.2 * (1 - prog));
      ctx.stroke();
      ctx.restore();

      // 이동 부대 표식
      ctx.beginPath();
      ctx.arc(x, y, 9 / scale, 0, Math.PI * 2);
      ctx.fillStyle = hexA(col, 0.92);
      ctx.fill();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
  }

  function drawMarchesLabels() {
    var ids = Object.keys(marches);
    var ts = (window.performance && performance.now) ? performance.now() : Date.now();
    for (var k = 0; k < ids.length; k++) {
      var m = marches[ids[k]];
      var from = state.regions[m.from];
      var to = state.regions[m.to];
      if (!from || !to) continue;
      var prog = clampNum((ts - m.startLocal) / (m.dur || 1200), 0, 1);
      var x = (from.cx + (to.cx - from.cx) * prog) * scale + offX;
      var y = (from.cy + (to.cy - from.cy) * prog) * scale + offY;
      var px = clampNum(9 * scale * 0.9, 8, 13);
      ctx.font = '800 ' + px.toFixed(1) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = px * 0.32;
      ctx.strokeStyle = 'rgba(3,7,14,0.9)';
      ctx.strokeText(String(m.n), x, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(m.n), x, y);
    }
  }

  function render(now) {
    if (!ctx || !state) return;
    var t = now || ((window.performance && performance.now) ? performance.now() : Date.now());
    var s = mySlot();
    var regions = state.regions;
    var i;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);

    ctx.save();
    ctx.beginPath();
    for (i = 0; i < regions.length; i++) addPoly(ctx, regions[i].poly);
    ctx.fillStyle = '#091120';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 5 / scale;
    ctx.fill();
    ctx.restore();

    for (i = 0; i < regions.length; i++) {
      var r = regions[i];
      ctx.beginPath();
      addPoly(ctx, r.poly);
      ctx.fillStyle = r.owner === -1 ? NEUTRAL.fill : NATIONS[r.owner].fill;
      ctx.fill();
    }

    if (lightGrad) {
      ctx.beginPath();
      for (i = 0; i < regions.length; i++) addPoly(ctx, regions[i].poly);
      ctx.fillStyle = lightGrad;
      ctx.fill();
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.7 / scale;
    ctx.strokeStyle = 'rgba(5,10,18,0.92)';
    for (i = 0; i < regions.length; i++) {
      ctx.beginPath();
      addPoly(ctx, regions[i].poly);
      ctx.stroke();
    }

    ctx.lineWidth = 0.85 / scale;
    for (i = 0; i < regions.length; i++) {
      var rr = regions[i];
      ctx.beginPath();
      addPoly(ctx, rr.poly);
      ctx.strokeStyle = hexA(colorOf(rr.owner), 0.42);
      ctx.stroke();
    }

    // 공격 · 합류 섬광
    var nowMs = Date.now();
    for (var fid in flashes) {
      var f = flashes[fid];
      var age = nowMs - f.at;
      if (age > 900) { delete flashes[fid]; continue; }
      var fr = regions[fid];
      if (!fr) continue;
      var ph = age / 900;
      ctx.beginPath();
      addPoly(ctx, fr.poly);
      ctx.fillStyle = (f.kind === 'good' ? 'rgba(74,222,128,' : 'rgba(248,113,113,') +
        (0.3 * (1 - ph)).toFixed(3) + ')';
      ctx.fill();
      ctx.lineWidth = (3 * (1 - ph)) / scale;
      ctx.strokeStyle = (f.kind === 'good' ? 'rgba(134,239,172,' : 'rgba(252,165,165,') +
        (0.85 * (1 - ph)).toFixed(3) + ')';
      ctx.stroke();
    }

    var pulse = 0.5 + 0.5 * Math.sin(t / 260);
    if (selected != null && canAct()) {
      var sel = regions[selected];
      if (sel) {
        for (i = 0; i < sel.neighbors.length; i++) {
          var nb = regions[sel.neighbors[i]];
          var pact = (nb.owner >= 0 && nb.owner !== s) ? pactBetween(s, nb.owner) : null;
          ctx.beginPath();
          addPoly(ctx, nb.poly);
          if (pact) {
            ctx.fillStyle = 'rgba(251,191,36,' + (0.09 + 0.08 * pulse).toFixed(3) + ')';
            ctx.fill();
            ctx.lineWidth = 2.2 / scale;
            ctx.strokeStyle = 'rgba(251,191,36,' + (0.5 + 0.32 * pulse).toFixed(3) + ')';
            ctx.stroke();
            continue;
          }
          var isEnemy = nb.owner !== s;
          ctx.fillStyle = isEnemy
            ? 'rgba(248,113,113,' + (0.14 + 0.14 * pulse).toFixed(3) + ')'
            : 'rgba(74,222,128,' + (0.12 + 0.12 * pulse).toFixed(3) + ')';
          ctx.fill();
          ctx.lineWidth = 2.4 / scale;
          ctx.strokeStyle = isEnemy
            ? 'rgba(248,113,113,' + (0.6 + 0.4 * pulse).toFixed(3) + ')'
            : 'rgba(74,222,128,' + (0.55 + 0.35 * pulse).toFixed(3) + ')';
          ctx.stroke();
        }
        ctx.beginPath();
        addPoly(ctx, sel.poly);
        ctx.lineWidth = (2.2 + pulse * 1.4) / scale;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.6 + 0.35 * pulse).toFixed(3) + ')';
        ctx.shadowColor = 'rgba(147,197,253,0.9)';
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // 관전 중 고른 나라 테두리
    if (mySlot() < 0 && spectatePick != null) {
      for (i = 0; i < regions.length; i++) {
        if (regions[i].owner !== spectatePick) continue;
        ctx.beginPath();
        addPoly(ctx, regions[i].poly);
        ctx.lineWidth = (2.4 + pulse * 1.2) / scale;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 + 0.4 * pulse).toFixed(3) + ')';
        ctx.stroke();
      }
    }

    drawMarches(t);
    drawMarchesLabels();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (i = 0; i < regions.length; i++) {
      var reg = regions[i];
      var x = reg.cx * scale + offX;
      var y = reg.cy * scale + offY;
      var rad = reg.r * scale;
      var numPx = clampNum(rad * 0.68, 12, 22);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '800 ' + numPx.toFixed(1) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.lineWidth = numPx * 0.3;
      ctx.strokeStyle = 'rgba(3,7,14,0.9)';
      ctx.fillStyle = '#ffffff';
      ctx.strokeText(String(reg.troops), x, y - rad * 0.1);
      ctx.fillText(String(reg.troops), x, y - rad * 0.1);

      if (reg.cap) {
        ctx.font = '700 ' + clampNum(rad * 0.26, 8, 11).toFixed(1) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,236,170,0.95)';
        ctx.fillText('♛', x, y - rad * 0.62);
      }

      if (rad >= 23) {
        var namePx = clampNum(rad * 0.3, 8, 11);
        var ny = y + rad * 0.6;
        ctx.font = '700 ' + namePx.toFixed(1) + 'px -apple-system, "Segoe UI", system-ui, sans-serif';
        ctx.lineWidth = namePx * 0.34;
        ctx.strokeStyle = 'rgba(3,7,14,0.75)';
        ctx.fillStyle = 'rgba(232,240,255,0.85)';
        ctx.strokeText(reg.name, x, ny);
        ctx.fillText(reg.name, x, ny);
      }
    }
  }

  /* =========================================================================
     지도 터치 → 출정
     ========================================================================= */
  function hitRegion(v) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (!inPoly(v, r.poly)) continue;
      var dx = v.x - r.cx, dy = v.y - r.cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function inPoly(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  function onTap(clientX, clientY) {
    if (!state) return;
    var rect = canvas.getBoundingClientRect();
    var v = {
      x: (clientX - rect.left - offX) / scale,
      y: (clientY - rect.top - offY) / scale
    };
    var idx = hitRegion(v);
    if (idx < 0) {
      if (selected != null) { selected = null; render(); renderHint(); }
      return;
    }
    var r = state.regions[idx];
    var s = mySlot();

    // 관전 중: 나라 고르기
    if (s < 0) {
      if (r.owner >= 0) pickNation(r.owner);
      else toast(r.name + ' · 중립 · 병력 ' + r.troops, 'info');
      return;
    }

    if (!canAct()) {
      if (state.over) return;
      if (state.delegate) toast('AI가 대신 싸우는 중 · [조종 가져오기]를 누르세요', 'warn');
      else if (countOwned(s) === 0) toast(r.name + ' · ' + longName(r.owner) + ' · 병력 ' + r.troops, 'info');
      return;
    }

    if (r.owner === s) {
      if (selected === idx) {
        selected = null;
        render();
        renderHint();
        return;
      }
      if (selected != null) {
        var prev = state.regions[selected];
        if (prev && prev.owner === s && prev.neighbors.indexOf(idx) >= 0) {
          sendMove(selected, idx);
          return;
        }
      }
      selected = idx;
      vibrate(6);
      render();
      renderHint();
      return;
    }

    if (selected == null) {
      toast(r.name + ' · ' + longName(r.owner) + ' · 병력 ' + r.troops, 'info');
      return;
    }
    var src = state.regions[selected];
    if (!src || src.owner !== s) { selected = null; return; }
    if (src.neighbors.indexOf(idx) < 0) {
      toast('인접한 영토로만 보낼 수 있어요', 'warn');
      return;
    }
    if (r.owner >= 0) {
      var pact = pactBetween(s, r.owner);
      if (pact) {
        toast((pact.type === 'ally' ? '동맹' : '조약') + ' 중 · ' + secLeft(pact) + '초 남음 · 먼저 파기하세요', 'warn');
        vibrate(16);
        return;
      }
    }
    sendMove(selected, idx);
  }

  function sendMove(from, to) {
    if (!state || !canAct()) return;
    var src = state.regions[from];
    if (!src || src.owner !== mySlot() || src.troops < 2) {
      selected = null;
      render();
      return;
    }
    var n = Math.max(1, Math.min(src.troops - 1, Math.floor(src.troops * ratio)));
    var ok = send({ type: 'action', action: { kind: 'send', from: from, to: to, ratio: ratio } });
    if (!ok) return;
    src.troops = Math.max(1, src.troops - n);
    var target = state.regions[to];
    vibrate(target && target.owner === mySlot() ? 5 : 12);
    if (src.troops < 2) selected = null;
    updateHUD();
    render();
  }

  /* =========================================================================
     비율 · 속도
     ========================================================================= */
  function renderRatio() {
    var btns = els.ratioRow.getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) {
      var v = Number(btns[i].getAttribute('data-ratio'));
      btns[i].className = 'ratio-btn' + (Math.abs(v - ratio) < 0.01 ? ' on' : '');
    }
    renderHint();
  }

  function setRatio(v) {
    ratio = clampNum(v, 0.1, 1);
    storageSet(RATIO_KEY, String(ratio));
    renderRatio();
    render();
    vibrate(5);
  }

  function cycleSpeed() {
    if (!state) return;
    var cur = state.speed || 1;
    var idx = SPEEDS.indexOf(cur);
    var next = SPEEDS[(idx + 1) % SPEEDS.length];
    send({ type: 'speed', value: next });
    toast('속도 ×' + next, 'info');
  }

  function setSpeed(v) {
    if (state) state.speed = v;
    updateHUD();
    var segs = [els.menuSpeed, els.roomSpeed];
    for (var k = 0; k < segs.length; k++) {
      if (!segs[k]) continue;
      var btns = segs[k].getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) {
        btns[i].className = 'seg-btn' + (Number(btns[i].getAttribute('data-speed')) === v ? ' on' : '');
      }
    }
  }

  /* =========================================================================
     외교
     ========================================================================= */
  function openDiplo() {
    if (!state) return;
    renderDiplo();
    els.diploModal.classList.add('show');
    els.diploModal.setAttribute('aria-hidden', 'false');
  }
  function closeDiplo() {
    closeTribute();
    closeCede();
    closeCall();
    els.diploModal.classList.remove('show');
    els.diploModal.setAttribute('aria-hidden', 'true');
  }

  function renderDiplo() {
    if (!state) return;
    lastDiploRender = Date.now();
    var scrollTop = els.diploList.scrollTop;
    var pacts = 0, pend = pendingForMe().length;
    var html = '';
    var others = 0;
    var s = mySlot();
    var act = canAct();
    var canAid = canAidNow();

    for (var i = 0; i < NATIONS.length; i++) {
      if (state.active && !state.active[i]) continue;
      if (i === s) continue;
      if (countOwned(i) === 0) continue;
      others++;
      var n = NATIONS[i];
      var tr = pactBetween(s, i);
      var rel = relationWith(i);
      var info = relationInfo(rel);
      var rep = reputationOf(i);
      var isHuman = state.human && state.human[i];
      if (tr) pacts++;
      var relWidth = Math.min(50, Math.abs(rel) / 2);
      var relLeft = rel >= 0 ? 50 : 50 - relWidth;
      var canAlly = !!tr && tr.type === 'truce' && act;
      var canCall = !!tr && tr.type === 'ally' && hasCallTarget(i) && act;

      html += '<div class="diplo-item">' +
        '<div class="diplo-head">' +
          '<i class="dot" style="color:' + n.color + '"></i>' +
          '<span class="nm" style="color:' + hexA(n.color, 0.95) + '">' +
            esc(longName(i)) + '</span>' +
          '<span class="rel-pill ' + info.cls + '">' + esc(info.label) + '</span>' +
          '<span class="pill ' + treatyPillClass(tr) + '">' + treatyLabel(tr) + '</span>' +
        '</div>' +
        '<div class="diplo-meta">영토 ' + countOwned(i) + ' · 병력 ' + totalTroops(i) +
          ' · ' + (isHuman ? '사람' : 'AI') +
          '<span class="rep">신뢰 ' + rep + '</span>' +
        '</div>' +
        '<div class="relation-bar"><i class="' + (rel >= 0 ? 'pos' : 'neg') +
          '" style="left:' + relLeft + '%;width:' + relWidth + '%"></i></div>' +
        '<div class="diplo-btns">' +
          '<button class="dbtn" type="button" data-act="truce" data-id="' + i + '"' +
            (tr || !act ? ' disabled' : '') + '>불가침</button>' +
          '<button class="dbtn ally" type="button" data-act="ally" data-id="' + i + '"' +
            (canAlly ? '' : ' disabled') + '>동맹</button>' +
          '<button class="dbtn" type="button" data-act="aid" data-id="' + i + '"' +
            (!canAid || !act ? ' disabled' : '') + '>지원 +3</button>' +
          '<button class="dbtn gold" type="button" data-act="tribute" data-id="' + i + '"' +
            (tr || !act ? ' disabled' : '') + '>조공</button>' +
          '<button class="dbtn" type="button" data-act="cede" data-id="' + i + '"' +
            (!act || countOwned(s) === 0 ? ' disabled' : '') + '>영토</button>' +
          '<button class="dbtn warn" type="button" data-act="break" data-id="' + i + '"' +
            (!tr || !act ? ' disabled' : '') + '>파기</button>' +
          (canCall ? '<button class="dbtn call" type="button" data-act="call" data-id="' + i +
            '">공동 참전 요청</button>' : '') +
        '</div>' +
      '</div>';
    }
    if (!others) html = '<p class="empty-note">지금은 외교할 상대국이 없습니다.</p>';
    els.diploList.innerHTML = html;
    els.diploList.scrollTop = scrollTop;
    els.diploSub.textContent = (s >= 0 ? '신뢰 ' + reputationOf(s) : '관전') +
      ' · 조약 ' + pacts + '건' + (pend ? ' · 제안 ' + pend + '건 대기' : '');
    var myCall = callForMe();
    if (myCall) els.diploSub.textContent += ' · 🤝 ' + shortName(myCall.target) +
      ' ' + Math.ceil(myCall.left / 1000) + '초';
    renderDiploFeed();
  }

  function renderDiploFeed() {
    if (!els.diploFeed) return;
    var log = (state && state.diploLog) || [];
    if (!log.length) {
      els.diploFeed.innerHTML = '<p class="empty-log">아직 외교 소식이 없습니다.</p>';
      return;
    }
    var html = '';
    for (var i = log.length - 1; i >= 0 && i >= log.length - 8; i--) {
      var e = log[i];
      var d = new Date(e.at || Date.now());
      var hh = ('0' + d.getHours()).slice(-2);
      var mm = ('0' + d.getMinutes()).slice(-2);
      html += '<div class="feed-item ' + esc(e.kind || 'info') + '">' +
        '<time>' + hh + ':' + mm + '</time><span>' + esc(e.text) + '</span></div>';
    }
    els.diploFeed.innerHTML = html;
  }

  function doDiploAction(act, id) {
    if (!state || !canAct()) {
      toast(state && state.delegate ? 'AI가 대신 싸우는 중 · 조종을 가져오세요' : '지금은 외교할 수 없어요', 'warn');
      return;
    }
    if (id === mySlot()) return;

    if (act === 'truce') {
      send({ type: 'action', action: { kind: 'propose', to: id } });
    } else if (act === 'ally') {
      send({ type: 'action', action: { kind: 'alliance', to: id } });
    } else if (act === 'aid') {
      send({ type: 'action', action: { kind: 'aid', to: id } });
    } else if (act === 'tribute') {
      openTribute(id);
      return;
    } else if (act === 'cede') {
      openCede(id);
      return;
    } else if (act === 'call') {
      openCall(id);
      return;
    } else if (act === 'break') {
      var now = Date.now();
      if (confirmBreak.slot === id && now - confirmBreak.at < 3200) {
        confirmBreak = { slot: null, at: 0 };
        send({ type: 'action', action: { kind: 'break', to: id } });
      } else {
        confirmBreak = { slot: id, at: now };
        toast(longName(id) + ' 와의 조약을 파기할까요? 신뢰도 -35 · 한 번 더 누르세요', 'warn');
        return;
      }
    }
    setTimeout(function () { if (els.diploModal.classList.contains('show')) renderDiplo(); }, 260);
  }

  /* =========================================================================
     조공 · 영토 할양 · 공동 참전
     ========================================================================= */
  var tributeCtx = { to: null, mode: 'demand', amount: 1 };
  var cedeCtx = { to: null, regionId: null };
  var callCtx = { to: null, target: null };

  function openTribute(to) {
    tributeCtx = { to: to, mode: 'demand', amount: 1 };
    els.tributeTo.textContent = slotTitle(to);
    els.tributeTo.style.color = colorOf(to);
    syncTribute();
    els.tributeModal.classList.add('show');
    els.tributeModal.setAttribute('aria-hidden', 'false');
  }
  function syncTribute() {
    var btns = els.tributeModeRow.getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = 'seg-btn' + (btns[i].getAttribute('data-mode') === tributeCtx.mode ? ' on' : '');
    }
    var amt = els.tributeAmountRow.getElementsByTagName('button');
    for (var k = 0; k < amt.length; k++) {
      amt[k].className = 'count-btn' + (Number(amt[k].getAttribute('data-amount')) === tributeCtx.amount ? ' on' : '');
    }
    els.tributeNote.textContent = tributeCtx.mode === 'demand'
      ? '상대가 12초마다 ' + tributeCtx.amount + '개를 나에게 바칩니다. 수락하면 45초간 서로 공격할 수 없습니다.'
      : '내가 12초마다 ' + tributeCtx.amount + '개를 상대에게 바칩니다. 45초 휴전과 관계 개선을 얻습니다.';
  }
  function closeTribute() {
    els.tributeModal.classList.remove('show');
    els.tributeModal.setAttribute('aria-hidden', 'true');
  }
  function sendTribute() {
    if (tributeCtx.to == null) return;
    send({
      type: 'action',
      action: {
        kind: 'tribute', to: tributeCtx.to,
        amount: tributeCtx.amount, direction: tributeCtx.mode === 'offer' ? 'offer' : 'demand'
      }
    });
    closeTribute();
    setTimeout(function () { if (els.diploModal.classList.contains('show')) renderDiplo(); }, 300);
  }

  function openCede(to) {
    cedeCtx = { to: to, regionId: null };
    els.cedeTo.textContent = slotTitle(to);
    els.cedeTo.style.color = colorOf(to);
    var list = [];
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (r.owner !== mySlot()) continue;
      var adjacent = false;
      for (var k = 0; k < r.neighbors.length; k++) {
        if (state.regions[r.neighbors[k]].owner === to) { adjacent = true; break; }
      }
      list.push({ r: r, adjacent: adjacent });
    }
    list.sort(function (a, b) {
      if (a.adjacent !== b.adjacent) return a.adjacent ? -1 : 1;
      return b.r.troops - a.r.troops;
    });
    var html = '';
    for (var q = 0; q < list.length; q++) {
      var it = list[q];
      html += '<button class="cede-row" type="button" data-id="' + it.r.id + '">' +
        '<span class="rname">' + esc(it.r.name) + '</span>' +
        (it.adjacent ? '<span class="radj">국경</span>' : '') +
        '<span class="rtroops">병력 ' + it.r.troops + '</span>' +
      '</button>';
    }
    els.cedeList.innerHTML = html || '<p class="empty-note">할양할 영토가 없습니다.</p>';
    cedeCtx.regionId = list.length ? list[0].r.id : null;
    syncCede();
    els.cedeModal.classList.add('show');
    els.cedeModal.setAttribute('aria-hidden', 'false');
  }
  function syncCede() {
    var rows = els.cedeList.getElementsByClassName('cede-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].className = 'cede-row' + (Number(rows[i].getAttribute('data-id')) === cedeCtx.regionId ? ' on' : '');
    }
  }
  function closeCede() {
    els.cedeModal.classList.remove('show');
    els.cedeModal.setAttribute('aria-hidden', 'true');
  }
  function sendCede() {
    if (cedeCtx.regionId == null) { toast('넘길 영토를 선택해 주세요', 'warn'); return; }
    send({
      type: 'action',
      action: {
        kind: 'cede', to: cedeCtx.to, regionId: cedeCtx.regionId,
        withTruce: !!els.cedeTruce.checked
      }
    });
    closeCede();
    setTimeout(function () { if (els.diploModal.classList.contains('show')) renderDiplo(); }, 300);
  }

  function openCall(to) {
    callCtx = { to: to, target: null };
    els.callTo.textContent = slotTitle(to);
    els.callTo.style.color = colorOf(to);
    var list = [];
    for (var i = 0; i < NATIONS.length; i++) {
      if (i === mySlot() || i === to) continue;
      if (!isEnemyOfMe(i)) continue;
      if (pactBetween(to, i)) continue;
      list.push(i);
    }
    list.sort(function (a, b) { return totalTroops(b) - totalTroops(a); });
    var html = '';
    for (var q = 0; q < list.length; q++) {
      var t = list[q];
      html += '<button class="cede-row" type="button" data-id="' + t + '">' +
        '<i class="dot" style="color:' + NATIONS[t].color + '"></i>' +
        '<span class="rname">' + esc(longName(t)) + '</span>' +
        '<span class="rpow">영토 ' + countOwned(t) + ' · 병력 ' + totalTroops(t) + '</span>' +
      '</button>';
    }
    els.callList.innerHTML = html || '<p class="empty-note">함께 공격할 적이 없습니다.</p>';
    callCtx.target = list.length ? list[0] : null;
    syncCall();
    els.callModal.classList.add('show');
    els.callModal.setAttribute('aria-hidden', 'false');
  }
  function syncCall() {
    var rows = els.callList.getElementsByClassName('cede-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].className = 'cede-row' + (Number(rows[i].getAttribute('data-id')) === callCtx.target ? ' on' : '');
    }
  }
  function closeCall() {
    els.callModal.classList.remove('show');
    els.callModal.setAttribute('aria-hidden', 'true');
  }
  function sendCall() {
    if (callCtx.target == null) { toast('공격할 적을 선택해 주세요', 'warn'); return; }
    send({ type: 'action', action: { kind: 'call', to: callCtx.to, target: callCtx.target } });
    closeCall();
    setTimeout(function () { if (els.diploModal.classList.contains('show')) renderDiplo(); }, 300);
  }

  /* =========================================================================
     외교 제안 (실시간)
     ========================================================================= */
  function maybeShowProposal() {
    if (!state) return;
    var list = pendingForMe();
    if (propShowing) {
      var still = false;
      for (var i = 0; i < list.length; i++) if (list[i].id === propShowing.id) still = true;
      if (still) return;
      closeProposal();
    }
    if (!list.length) {
      if (els.propModal.classList.contains('show')) closeProposal();
      return;
    }
    showProposal(list[0]);
  }

  function showProposal(p) {
    propShowing = p;
    var kind = p.kind || 'truce';
    var from = longName(p.from);
    var title = '불가침 조약 제안';
    var body = '';
    if (kind === 'ally') {
      title = '동맹 제안';
      body = '<b>' + esc(from) + '</b> 님이 <b>정식 동맹</b>을 제안했습니다.<br>' +
        '<b>' + (p.sec || 60) + '초</b> 동맹: 공동의 적 공격 시 공격력 상승, 공동 참전 요청 가능.';
    } else if (kind === 'tribute') {
      var payer = p.direction === 'demand' ? longName(mySlot()) : from;
      var payee = p.direction === 'demand' ? from : longName(mySlot());
      title = p.direction === 'demand' ? '조공 요구' : '조공 제안';
      body = '<b>' + esc(from) + '</b> 님이 조공 조약을 제안했습니다.<br>' +
        '<b>' + esc(payer) + ' → ' + esc(payee) + '</b> 12초마다 <b>' + p.amount + '개</b>씩, ' +
        (p.sec || 45) + '초간. 수락하면 서로 공격할 수 없습니다.';
    } else if (kind === 'cede') {
      title = '영토 할양 제안';
      body = '<b>' + esc(from) + '</b> 님이 <b>' + esc(p.regionName || '영토') + '</b> 를 넘기겠다고 합니다.<br>' +
        '관계 <b>+25</b>' + (p.withTruce ? ' 와 함께 <b>불가침 45초</b>' : '') + '을 얻습니다.';
    } else if (kind === 'call') {
      title = '공동 참전 요청';
      body = '<b>' + esc(from) + '</b> 님이 <b>' + esc(p.targetName || '적국') +
        '</b> 에 대한 공동 참전을 요청합니다.<br>수락하면 관계가 오르고, 동맹은 그 나라를 우선 공격합니다.';
    } else {
      title = '불가침 조약 제안';
      body = '<b>' + esc(from) + '</b> 님이 <b>불가침 조약</b>을 제안했습니다.<br>' +
        '수락하면 <b>' + (p.sec || 45) + '초</b> 동안 서로 공격할 수 없습니다.';
    }
    els.propFrom.textContent = from + ' · 관계 ' + relationWith(p.from) + ' · 신뢰 ' + reputationOf(p.from);
    els.propFrom.style.color = colorOf(p.from);
    var titleEl = els.propModal.querySelector('.prop-title');
    if (titleEl) titleEl.textContent = title;
    els.propBody.innerHTML = body;
    els.propModal.classList.add('show', 'peek');
    els.propModal.setAttribute('aria-hidden', 'false');
    vibrate([10, 26, 10]);
  }

  function closeProposal() {
    propShowing = null;
    els.propModal.classList.remove('show', 'peek');
    els.propModal.setAttribute('aria-hidden', 'true');
  }

  function answerProposal(accept) {
    var p = propShowing;
    closeProposal();
    if (!p) return;
    send({ type: 'action', action: { kind: 'respond', id: p.id, accept: !!accept } });
    setTimeout(maybeShowProposal, 420);
  }

  /* =========================================================================
     결과 · 탈락
     ========================================================================= */
  function showResult() {
    if (!state || !state.over || resultShown) return;
    resultShown = true;
    var o = state.over;
    var s = mySlot();
    var win = o.winner === s && s >= 0;
    var mine = s >= 0 ? countOwned(s) : 0;

    els.resultTitle.textContent = s < 0 ? '시뮬레이션 종료' : (win ? '승리!' : '패배…');
    els.resultTitle.className = 'result-title ' + (win ? 'win' : 'lose');
    els.resultSub.textContent = mmss(state.time) + ' · ' +
      (o.winner < 0 ? '무승부' : longName(o.winner) +
        (o.type === 'nation' ? '이(가) 대륙을 통일했습니다.' : '이(가) 마지막까지 살아남았습니다.'));

    els.resultLine.textContent = '내 영토 ' + mine + '/' + state.regions.length +
      ' · 전투 ' + (state.stats ? state.stats.battles : 0) + '회';
    els.rLand.textContent = String(mine);
    els.rTroops.textContent = String(s >= 0 ? totalTroops(s) : 0);
    els.rTime.textContent = mmss(state.time);

    var host = isHost();
    els.btnRematch.hidden = !host;
    els.rematchNote.hidden = host;

    els.resultOverlay.classList.add('show');
    els.resultOverlay.setAttribute('aria-hidden', 'false');
    if (win) vibrate([18, 60, 18, 60, 30]); else vibrate(30);
  }

  function hideResult() {
    els.resultOverlay.classList.remove('show');
    els.resultOverlay.setAttribute('aria-hidden', 'true');
  }

  function maybeShowElim() {
    if (elimShown || !state || state.over) return;
    var s = mySlot();
    if (s < 0 || (state.active && !state.active[s])) return;
    if (countOwned(s) > 0) return;
    if (state.sim) {
      // 시뮬레이션에서는 다른 나라로 다시 참전할 수 있다
      elimShown = true;
      els.elimSub.textContent = mmss(state.time) + ' 만에 영토를 모두 잃었습니다.';
      els.elimNote.textContent = '이 나라는 AI에게 맡기고, 관전하다 다른 나라를 골라 다시 참전할 수 있어요.';
      els.spectateBar.classList.remove('hidden');
      els.elimModal.classList.add('show');
      els.elimModal.setAttribute('aria-hidden', 'false');
      vibrate([20, 40, 20]);
      return;
    }
    elimShown = true;
    els.elimSub.textContent = mmss(state.time) + ' 만에 모든 영토를 잃었습니다.';
    els.elimNote.textContent = '관전 모드로 남아 게임이 끝나는 모습을 볼 수 있어요.';
    els.elimModal.classList.add('show');
    els.elimModal.setAttribute('aria-hidden', 'false');
    vibrate([20, 40, 20]);
  }

  function hideElim() {
    els.elimModal.classList.remove('show');
    els.elimModal.setAttribute('aria-hidden', 'true');
  }

  /* =========================================================================
     메뉴 · 전황
     ========================================================================= */
  function renderMenuPlayers() {
    if (!els.menuPlayers || !state) return;
    var html = '';
    var s = mySlot();
    for (var i = 0; i < 4; i++) {
      if (state.active && !state.active[i]) continue;
      var p = playerOf(i);
      var nat = NATIONS[i];
      html += '<div class="room-p' + (i === s ? ' me' : '') + (p && p.isAI ? ' ai' : '') + '">' +
        '<i class="dot" style="color:' + nat.color + '"></i>' +
        '<span class="pname">' + esc(p ? p.name : nat.name) + '</span>' +
        '<span class="pnation">' + nat.short + '</span>' +
        (i === state.host ? '<span class="crown">방장</span>' : '') +
        '<span class="seat">' + (p && p.isAI ? '<span class="ai-tag">AI</span>' : '') +
        '<i class="live' + (p && p.connected ? '' : ' off') + '"></i></span>' +
      '</div>';
    }
    els.menuPlayers.innerHTML = html;

    var s2 = mySlot();
    var delegated = s2 >= 0 && state.delegate;
    els.btnDelegate.classList.toggle('hidden', !soloGame() || s2 < 0);
    els.btnDelegate.textContent = delegated ? '🎮 조종 가져오기' : '🤖 AI 위임 (자동 전투)';
    els.btnSpectateBack.classList.toggle('hidden', !state.sim || s2 < 0);
    els.menuSpeedRow.classList.toggle('hidden', !isHost() || !soloGame());
  }

  function openMenu() {
    if (!state) return;
    els.menuCode.textContent = state.code || me.code || '----';
    renderMenuPlayers();
    setSpeed(state.speed || 1);
    els.menuModal.classList.add('show');
    els.menuModal.setAttribute('aria-hidden', 'false');
  }
  function closeMenu() {
    els.menuModal.classList.remove('show');
    els.menuModal.setAttribute('aria-hidden', 'true');
  }

  function openLog() {
    if (!state) return;
    renderLog();
    els.logModal.classList.add('show');
    els.logModal.setAttribute('aria-hidden', 'false');
  }
  function closeLog() {
    els.logModal.classList.remove('show');
    els.logModal.setAttribute('aria-hidden', 'true');
  }

  function renderLog() {
    var log = (state && state.log) || [];
    if (!log.length) {
      els.logList.innerHTML = '<p class="empty-log">아직 기록이 없습니다.</p>';
    } else {
      var html = '';
      for (var i = log.length - 1; i >= 0; i--) {
        var e = log[i];
        var d = new Date(e.at || Date.now());
        var hh = ('0' + d.getHours()).slice(-2);
        var mm = ('0' + d.getMinutes()).slice(-2);
        html += '<div class="log-item ' + esc(e.kind || 'info') + '">' +
          '<time>' + hh + ':' + mm + '</time><span>' + esc(e.text) + '</span></div>';
      }
      els.logList.innerHTML = html;
    }
    els.logSub.textContent = state ? (mmss(state.time) + ' · 영토 ' + state.regions.length + '개 · 행군 ' +
      (state.marches ? state.marches.length : 0)) : '';
  }

  /* =========================================================================
     이벤트 바인딩
     ========================================================================= */
  function currentName() {
    var v = (els.nameInput.value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    if (!v) {
      toast('이름을 먼저 입력해 주세요', 'warn');
      try { els.nameInput.focus(); } catch (e) { /* 무시 */ }
      return null;
    }
    storageSet(NAME_KEY, v);
    return v;
  }

  function doCreate() {
    var name = currentName();
    if (!name) return;
    me.name = name;
    els.btnCreate.disabled = true;
    var ok = send({ type: 'create', name: name, aiFill: true });
    setTimeout(function () { els.btnCreate.disabled = false; }, 900);
    if (!ok) els.btnCreate.disabled = false;
  }

  function doSim() {
    var name = currentName();
    if (!name) return;
    me.name = name;
    els.btnSim.disabled = true;
    var ok = send({ type: 'create', name: name, sim: true });
    setTimeout(function () { els.btnSim.disabled = false; }, 900);
    if (!ok) els.btnSim.disabled = false;
  }

  function doJoin() {
    var name = currentName();
    if (!name) return;
    var code = (els.joinCode.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      toast('방 코드 4자리를 입력해 주세요', 'warn');
      try { els.joinCode.focus(); } catch (e) { /* 무시 */ }
      return;
    }
    me.name = name;
    send({ type: 'join', code: code, name: name });
  }

  function leaveRoom(btn) {
    var now = Date.now();
    if (!state || state.over) {
      send({ type: 'leave' });
      return;
    }
    if (confirmLeaveAt && now - confirmLeaveAt < 3500) {
      confirmLeaveAt = 0;
      send({ type: 'leave' });
      return;
    }
    confirmLeaveAt = now;
    var old = btn.textContent;
    btn.textContent = '한 번 더 누르면 나갑니다';
    toast('진행 중인 게임에서 나가면 그 나라는 AI가 이어받습니다', 'warn');
    setTimeout(function () {
      btn.textContent = old;
      confirmLeaveAt = 0;
    }, 3500);
  }

  function bindUI() {
    els.btnCreate.addEventListener('click', doCreate);
    els.btnSim.addEventListener('click', doSim);
    els.btnJoin.addEventListener('click', doJoin);
    els.joinCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
    els.nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if ((els.joinCode.value || '').trim()) doJoin(); else doCreate();
      }
    });
    els.joinCode.addEventListener('input', function () {
      els.joinCode.value = els.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    els.btnCopyCode.addEventListener('click', function () {
      var code = (room && room.code) || me.code || '';
      if (code) copyText(code, '방 코드 복사 완료 · 친구에게 보내세요');
    });
    els.roomCode.addEventListener('click', function () {
      var code = (room && room.code) || me.code || '';
      if (code) copyText(code, '방 코드 복사 완료');
    });
    els.btnShare.addEventListener('click', shareRoom);
    els.btnMenuCopy.addEventListener('click', function () {
      var code = (state && state.code) || me.code || '';
      if (code) copyText(code, '방 코드 복사 완료');
    });

    els.aiToggle.addEventListener('change', function () {
      send({ type: 'aiFill', value: els.aiToggle.checked });
    });

    els.btnStart.addEventListener('click', function () {
      send({ type: 'start' });
      els.btnStart.disabled = true;
      setTimeout(function () { if (state == null) els.btnStart.disabled = false; }, 1200);
    });
    els.btnLeaveLobby.addEventListener('click', function () { send({ type: 'leave' }); });

    els.roomSpeed.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.roomSpeed) {
        if (t.getAttribute && t.getAttribute('data-speed')) {
          send({ type: 'speed', value: Number(t.getAttribute('data-speed')) });
          return;
        }
        t = t.parentNode;
      }
    });

    els.ratioRow.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.ratioRow) {
        if (t.getAttribute && t.getAttribute('data-ratio')) {
          setRatio(Number(t.getAttribute('data-ratio')));
          return;
        }
        t = t.parentNode;
      }
    });

    els.btnSpeed.addEventListener('click', cycleSpeed);
    els.btnDiplo.addEventListener('click', openDiplo);
    els.btnLog.addEventListener('click', openLog);
    els.btnMenu.addEventListener('click', openMenu);
    els.btnMenu2.addEventListener('click', openMenu);

    els.btnTakeBack.addEventListener('click', function () {
      send({ type: 'delegate', value: false });
    });

    els.spNations.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.spNations) {
        if (t.getAttribute && t.getAttribute('data-slot') != null) {
          pickNation(Number(t.getAttribute('data-slot')));
          return;
        }
        t = t.parentNode;
      }
    });
    els.btnJump.addEventListener('click', function () {
      if (spectatePick == null) return;
      send({ type: 'takeover', slot: spectatePick });
      toast(NATIONS[spectatePick].name + ' 참전! 영토를 탭해 지휘하세요', 'good');
      vibrate([14, 30, 14]);
      spectatePick = null;
    });

    els.btnCloseRules.addEventListener('click', closeRules);
    els.btnCloseDiplo.addEventListener('click', closeDiplo);
    els.btnCloseMenu.addEventListener('click', closeMenu);
    els.btnCloseLog.addEventListener('click', closeLog);
    els.btnRules.addEventListener('click', function () { closeMenu(); openRules(); });
    els.btnLeaveGame.addEventListener('click', function () { leaveRoom(els.btnLeaveGame); });
    els.btnResultLeave.addEventListener('click', function () { send({ type: 'leave' }); });
    els.btnElimLeave.addEventListener('click', function () { send({ type: 'leave' }); });
    els.btnSpectate.addEventListener('click', function () {
      hideElim();
      if (state && state.sim && mySlot() >= 0 && countOwned(mySlot()) === 0) {
        send({ type: 'spectate' });
        spectatePick = null;
      }
      updateHUD();
      updateBanner();
      renderSpectate();
      toast(state && state.sim ? '관전 모드 · 다른 나라를 탭해 다시 참전' : '관전 모드 · 지도를 탭해 상황을 볼 수 있어요');
    });
    els.btnRematch.addEventListener('click', function () {
      send({ type: 'rematch' });
      hideResult();
    });
    els.btnDelegate.addEventListener('click', function () {
      var delegated = state && mySlot() >= 0 && state.delegate;
      send({ type: 'delegate', value: !delegated });
      closeMenu();
    });
    els.btnSpectateBack.addEventListener('click', function () {
      send({ type: 'spectate' });
      closeMenu();
      selected = null;
    });

    els.menuSpeed.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.menuSpeed) {
        if (t.getAttribute && t.getAttribute('data-speed')) {
          send({ type: 'speed', value: Number(t.getAttribute('data-speed')) });
          setSpeed(Number(t.getAttribute('data-speed')));
          return;
        }
        t = t.parentNode;
      }
    });

    els.diploModal.addEventListener('click', function (ev) { if (ev.target === els.diploModal) closeDiplo(); });
    els.menuModal.addEventListener('click', function (ev) { if (ev.target === els.menuModal) closeMenu(); });
    els.logModal.addEventListener('click', function (ev) { if (ev.target === els.logModal) closeLog(); });
    els.rulesModal.addEventListener('click', function (ev) { if (ev.target === els.rulesModal) closeRules(); });

    els.diploList.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.diploList) {
        if (t.getAttribute && t.getAttribute('data-act')) {
          doDiploAction(t.getAttribute('data-act'), Number(t.getAttribute('data-id')));
          return;
        }
        t = t.parentNode;
      }
    });

    els.propAccept.addEventListener('click', function () { answerProposal(true); });
    els.propDecline.addEventListener('click', function () { answerProposal(false); });

    els.tributeModeRow.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.tributeModeRow) {
        if (t.getAttribute && t.getAttribute('data-mode')) {
          tributeCtx.mode = t.getAttribute('data-mode');
          syncTribute();
          return;
        }
        t = t.parentNode;
      }
    });
    els.tributeAmountRow.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.tributeAmountRow) {
        if (t.getAttribute && t.getAttribute('data-amount')) {
          tributeCtx.amount = Number(t.getAttribute('data-amount'));
          syncTribute();
          return;
        }
        t = t.parentNode;
      }
    });
    els.tributeSend.addEventListener('click', sendTribute);
    els.tributeClose.addEventListener('click', closeTribute);
    els.tributeModal.addEventListener('click', function (ev) { if (ev.target === els.tributeModal) closeTribute(); });

    els.cedeList.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.cedeList) {
        if (t.getAttribute && t.getAttribute('data-id')) {
          cedeCtx.regionId = Number(t.getAttribute('data-id'));
          syncCede();
          return;
        }
        t = t.parentNode;
      }
    });
    els.cedeSend.addEventListener('click', sendCede);
    els.cedeClose.addEventListener('click', closeCede);
    els.cedeModal.addEventListener('click', function (ev) { if (ev.target === els.cedeModal) closeCede(); });

    els.callList.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== els.callList) {
        if (t.getAttribute && t.getAttribute('data-id')) {
          callCtx.target = Number(t.getAttribute('data-id'));
          syncCall();
          return;
        }
        t = t.parentNode;
      }
    });
    els.callSend.addEventListener('click', sendCall);
    els.callClose.addEventListener('click', closeCall);
    els.callModal.addEventListener('click', function (ev) { if (ev.target === els.callModal) closeCall(); });

    var downX = 0, downY = 0, downAt = 0, tracking = false;
    canvas.addEventListener('pointerdown', function (ev) {
      tracking = true;
      downX = ev.clientX;
      downY = ev.clientY;
      downAt = Date.now();
      if (ev.cancelable) ev.preventDefault();
    }, { passive: false });
    canvas.addEventListener('pointerup', function (ev) {
      if (!tracking) return;
      tracking = false;
      var dx = ev.clientX - downX, dy = ev.clientY - downY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 18 && Date.now() - downAt < 700) {
        if (ev.cancelable) ev.preventDefault();
        onTap(ev.clientX, ev.clientY);
      }
    }, { passive: false });
    canvas.addEventListener('pointercancel', function () { tracking = false; });
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    var resizeTimer = null;
    function onResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!state) return;
        resizeCanvas();
        updateHUD();
      }, 150);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', function () { setTimeout(onResize, 240); });
    document.addEventListener('gesturestart', function (ev) { ev.preventDefault(); });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !connected) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
      }
    });
    window.addEventListener('online', function () {
      if (!connected) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
      }
    });
  }

  function shareRoom() {
    var code = (room && room.code) || me.code || '';
    if (!code) return;
    var url = location.origin + '/?code=' + encodeURIComponent(code);
    var text = '영토 전쟁 ONLINE 같이 해요! 방 코드 ' + code;
    if (navigator.share) {
      navigator.share({ title: '영토 전쟁 ONLINE', text: text, url: url }).catch(function () { /* 취소 */ });
    } else {
      copyText(text + ' ' + url, '초대 문구 복사 완료 · 붙여넣어 보내세요');
    }
  }

  function openRules() {
    els.rulesModal.classList.add('show');
    els.rulesModal.setAttribute('aria-hidden', 'false');
  }
  function closeRules() {
    els.rulesModal.classList.remove('show');
    els.rulesModal.setAttribute('aria-hidden', 'true');
  }

  /* =========================================================================
     시작
     ========================================================================= */
  function cacheEls() {
    var ids = [
      'app', 'lobby', 'homePanel', 'roomPanel', 'nameInput', 'joinCode', 'homeNote',
      'btnCreate', 'btnSim', 'btnJoin', 'roomCode', 'btnCopyCode', 'btnShare', 'roomPlayers',
      'aiToggle', 'aiRow', 'roomSpeedRow', 'roomSpeed', 'roomNote', 'btnStart', 'waitHost', 'btnLeaveLobby',
      'netBar', 'netText', 'boot', 'bootText',
      'statTime', 'statLand', 'statTroops', 'statProd', 'btnSpeed', 'legend',
      'map', 'mapWrap', 'toast', 'liveBanner', 'specChip', 'delegateBar', 'btnTakeBack',
      'spectateBar', 'spPick', 'spNations', 'btnJump',
      'ratioRow', 'hint', 'btnDiplo', 'btnLog', 'btnMenu', 'btnMenu2',
      'rulesModal', 'btnRules', 'btnCloseRules',
      'diploModal', 'diploList', 'diploSub', 'diploFeed', 'btnCloseDiplo',
      'tributeModal', 'tributeTo', 'tributeModeRow', 'tributeNote', 'tributeAmountRow', 'tributeSend', 'tributeClose',
      'cedeModal', 'cedeTo', 'cedeList', 'cedeTruce', 'cedeSend', 'cedeClose',
      'callModal', 'callTo', 'callList', 'callSend', 'callClose',
      'propModal', 'propFrom', 'propBody', 'propAccept', 'propDecline',
      'menuModal', 'menuCode', 'menuPlayers', 'btnCloseMenu', 'btnMenuCopy',
      'menuSpeedRow', 'menuSpeed', 'btnDelegate', 'btnSpectateBack',
      'btnLeaveGame', 'logModal', 'logList', 'logSub', 'btnCloseLog',
      'elimModal', 'elimSub', 'elimNote', 'btnSpectate', 'btnElimLeave',
      'resultOverlay', 'resultTitle', 'resultSub', 'resultLine', 'resultStats',
      'rLand', 'rTroops', 'rTime', 'btnRematch', 'rematchNote', 'btnResultLeave'
    ];
    for (var i = 0; i < ids.length; i++) els[ids[i]] = document.getElementById(ids[i]);
  }

  function loadSaved() {
    var savedName = storageGet(NAME_KEY);
    if (savedName) els.nameInput.value = savedName;
    var savedRatio = Number(storageGet(RATIO_KEY));
    if (savedRatio && savedRatio > 0 && savedRatio <= 1) ratio = savedRatio;
    var raw = storageGet(SESSION_KEY);
    if (!raw) return false;
    try {
      var s = JSON.parse(raw);
      if (s && s.code && s.token) {
        me.code = s.code;
        me.token = s.token;
        me.name = s.name || savedName || '';
        return true;
      }
    } catch (e) { /* 무시 */ }
    return false;
  }

  function init() {
    cacheEls();
    canvas = els.map;
    mapWrap = els.mapWrap;
    if (canvas) ctx = canvas.getContext('2d');

    bindUI();
    renderRatio();

    try {
      var q = new URLSearchParams(location.search);
      var code = q.get('code');
      if (code) els.joinCode.value = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    } catch (e) { /* 무시 */ }

    var saved = loadSaved();
    if (saved) {
      showBoot('자리로 돌아가는 중…');
      setTimeout(hideBoot, 7000);
    }
    connect();

    var last = 0;
    function tick(ts) {
      requestAnimationFrame(tick);
      if (!state) return;
      if (ts - last < 33) return;
      last = ts;
      render(ts);
    }
    requestAnimationFrame(tick);

    setInterval(function () {
      if (!state) return;
      updateHUD();
      if (els.diploModal.classList.contains('show')) renderDiplo();
    }, 1000);
  }

  // 디버깅 · 확인용 최소 훅 (게임 동작에는 관여하지 않음)
  try {
    window.__TW__ = {
      state: function () { return state; },
      me: function () { return me; },
      ratio: function () { return ratio; },
      selected: function () { return selected; },
      marches: function () { return marches; }
    };
  } catch (e) { /* 무시 */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
