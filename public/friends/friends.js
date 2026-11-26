/* =============================================================================
   친구와 플레이 · 2~5인 국가전쟁 클라이언트
   -----------------------------------------------------------------------------
   로비(방 만들기/코드 입장/대기실) → 편성(예산 배분) → 국가전쟁(관전 카메라로 지휘)
   서버가 판정하고, 이 파일은 상태를 그리고 명령만 보낸다.
   ============================================================================= */

import { WarScene } from './scene.js';
import {
  UNIT_KEYS, UNITS, BUDGET, WALL, CASTLE, PRESETS, NATION_COLORS,
  setupCost, totalUnits, fmt, clock, cloneSetup, presetSetup, clampSetup, connectFriends
} from '/src/friends-shared.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'friends:room';

const app = {
  ws: null,
  code: '',
  token: '',
  name: '',
  slot: -1,
  host: -1,
  capacity: 5,
  aiFill: true,
  state: null,
  scene: null,
  setup: presetSetup('balanced'),
  setupOpen: false,
  setupSynced: false,
  marchTo: -1,
  marchRatio: 0.5,
  marchUnits: null,
  lastFrame: 0,
  joystick: { active: false, id: null },
  drag: { active: false, id: null, x: 0, y: 0 },
  reconnectAt: 0,
  reconnectTimer: null,
  wantResume: false
};

/* ------------------------------------------------------------------ 유틸 */
function toast(text, kind) {
  const t = $('toast');
  if (!t) return;
  t.textContent = text;
  t.className = 'on' + (kind === 'bad' ? ' bad' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = ''; }, 2400);
}

function pushEvent(text, kind) {
  const feed = $('eventFeed');
  if (!feed) return;
  const d = document.createElement('div');
  d.className = 'ev ' + (kind || 'info');
  d.textContent = text;
  feed.appendChild(d);
  while (feed.children.length > 3) feed.removeChild(feed.firstChild);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 7000);
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle('hidden', !on);
}

function storeSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: app.code, token: app.token, name: app.name }));
  } catch (e) { /* noop */ }
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ 소켓 */
function connect() {
  if (app.ws) return;
  app.ws = connectFriends({
    onOpen: () => {
      show($('connBar'), false);
      if (app.wantResume && app.code && app.token) {
        app.ws.send({ type: 'resume', code: app.code, token: app.token });
      }
    },
    onClose: () => {
      app.ws = null;
      show($('connBar'), true);
      clearTimeout(app.reconnectTimer);
      app.reconnectTimer = setTimeout(() => {
        if (app.wantResume || app.code) connect();
      }, 2500);
    },
    onMessage: handleMessage
  });
}

function send(obj) {
  if (!app.ws) connect();
  if (app.ws) app.ws.send(obj);
}

/* --------------------------------------------------------------- 메시지 */
function handleMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'joined':
      app.code = msg.code;
      app.token = msg.token;
      app.slot = msg.slot;
      app.name = msg.name;
      app.host = msg.slot === 0 ? msg.slot : app.host;
      storeSession();
      app.wantResume = true;
      showLobbyPanel('wait');
      break;
    case 'resumed':
      app.code = msg.code;
      app.token = msg.token;
      app.slot = msg.slot;
      app.name = msg.name;
      app.wantResume = true;
      storeSession();
      show($('connBar'), false);
      break;
    case 'resume_failed':
      app.wantResume = false;
      app.code = '';
      app.token = '';
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
      showLobbyPanel('home');
      toast('방을 찾을 수 없어요. 새로 만들거나 코드로 입장하세요.');
      break;
    case 'flobby':
      renderLobby(msg);
      break;
    case 'fstate':
      applyState(msg);
      break;
    case 'fevent':
      pushEvent(msg.text, msg.kind);
      if (msg.kind === 'bad') toast(msg.text, 'bad');
      break;
    case 'error':
      toast(msg.message || '요청을 처리하지 못했어요.', 'bad');
      break;
    case 'left':
      resetToLobby();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ 로비 */
function showLobbyPanel(which) {
  show($('lobby'), true);
  show($('homePanel'), which === 'home');
  show($('waitPanel'), which === 'wait');
}

function renderLobby(m) {
  app.code = m.code || app.code;
  app.host = m.host;
  app.capacity = m.capacity || app.capacity;
  app.aiFill = m.aiFill !== false;
  if (m.you >= 0) app.slot = m.you;
  if (m.phase && m.phase !== 'lobby') {
    show($('lobby'), false);
    show($('hud'), true);
    return;
  }
  if (!app.state || app.state.phase === 'lobby' || !app.state) showLobbyPanel('wait');
  $('waitCode').textContent = app.code || '----';
  $('waitAi').checked = app.aiFill;
  $('aiToggle').checked = app.aiFill;
  const list = $('waitPlayers');
  list.innerHTML = '';
  (m.players || []).forEach((p) => {
    const d = document.createElement('div');
    d.className = 'wp' + (p.host ? ' host' : '');
    d.innerHTML = '<i></i><b>' + escapeHtml(p.name) + '</b>' +
      (p.host ? '<span class="n-crown" style="margin-left:auto">👑 방장</span>' : '') +
      (p.connected === false ? '<span style="margin-left:auto;color:#ffb3b3">연결 끊김</span>' : '');
    list.appendChild(d);
  });
  const humans = (m.players || []).length;
  const isHost = app.slot === app.host;
  $('btnStart').disabled = !isHost;
  $('btnStart').textContent = isHost ? '게임 시작' : '방장이 시작하길 기다리는 중';
  $('waitHint').textContent = humans < 2
    ? '친구를 기다리는 중… 빈 자리를 AI로 채우면 혼자서도 시작할 수 있어요 (' + humans + '/' + app.capacity + ')'
    : humans + '명 입장 · AI를 채우면 ' + app.capacity + '개국 전쟁이 됩니다';
  $('waitAiNote').textContent = '남는 나라는 AI가 맡습니다 (정원 ' + app.capacity + '명)';
  $('waitAi').disabled = !isHost;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function bindLobby() {
  let cap = 5;
  document.querySelectorAll('#capBtns button').forEach((b) => {
    b.addEventListener('click', () => {
      cap = Number(b.dataset.cap) || 5;
      app.capacity = cap;
      document.querySelectorAll('#capBtns button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  app.capacity = cap;

  $('btnCreate').addEventListener('click', () => {
    const name = ($('nameInput').value || '').trim().slice(0, 12) || '지휘관';
    app.name = name;
    try { localStorage.setItem('friends:name', name); } catch (e) { /* noop */ }
    app.capacity = cap;
    app.aiFill = $('aiToggle').checked;
    send({ type: 'create', mode: 'castle', name, capacity: cap, aiFill: app.aiFill });
  });

  $('btnJoin').addEventListener('click', () => {
    const name = ($('nameInput').value || '').trim().slice(0, 12) || '지휘관';
    const code = ($('joinCode').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { toast('방 코드를 확인해 주세요.', 'bad'); return; }
    app.name = name;
    try { localStorage.setItem('friends:name', name); } catch (e) { /* noop */ }
    send({ type: 'join', code, name });
  });

  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  $('waitAi').addEventListener('change', () => {
    send({ type: 'aiFill', value: $('waitAi').checked });
  });
  $('btnStart').addEventListener('click', () => send({ type: 'start' }));
  $('btnLeave').addEventListener('click', () => {
    send({ type: 'leave' });
    resetToLobby(true);
  });
  $('btnCopyCode').addEventListener('click', copyCode);
  $('roomCodeBtn').addEventListener('click', copyCode);
}

function copyCode() {
  const code = app.code || '';
  if (!code) return;
  const done = () => toast('방 코드 ' + code + ' 복사됨');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(() => toast('코드: ' + code));
  } else {
    toast('코드: ' + code);
  }
}

function resetToLobby(keepSocket) {
  app.state = null;
  app.wantResume = false;
  app.code = '';
  app.token = '';
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
  show($('hud'), false);
  show($('resultOv'), false);
  show($('setupSheet'), false);
  show($('marchSheet'), false);
  show($('diploSheet'), false);
  show($('logSheet'), false);
  show($('menuSheet'), false);
  showLobbyPanel('home');
  app.setupSynced = false;
  app.setupOpen = false;
  if (!keepSocket && app.ws) { app.ws.close(); app.ws = null; }
}

/* ------------------------------------------------------------- 상태 반영 */
function applyState(s) {
  const prev = app.state;
  app.state = s;
  app.slot = s.you >= 0 ? s.you : app.slot;
  app.host = s.host;
  app.capacity = s.capacity;
  app.aiFill = s.aiFill;

  if (s.phase === 'lobby') {
    app.setupSynced = false;
    app.setupOpen = false;
    showLobbyPanel('wait');
    show($('hud'), false);
    return;
  }
  show($('lobby'), false);
  show($('hud'), true);
  ensureScene();
  app.scene.syncNations(s.nations);
  renderTop(s);
  renderNations(s);
  renderLog(s);

  const me = s.nations[s.you];
  const setupVisible = s.phase === 'setup';
  $('btnSetup').disabled = !setupVisible;
  $('btnMarch').disabled = s.phase !== 'battle' || !me || !me.alive;
  $('btnDiplo').disabled = s.phase !== 'battle';

  if (s.phase === 'setup') {
    if (!app.setupSynced && me && me.setup) {
      app.setup = cloneSetup(me.setup);
      app.setupSynced = true;
      buildSetupRows();
      updateSetupUI();
    }
    if (!app.setupOpen) openSheet('setup');
    show($('resultOv'), false);
  } else if (s.phase === 'battle') {
    if (app.setupOpen) closeSheet('setup');
    show($('resultOv'), false);
    if (me && !me.alive && (!prev || prev.nations[prev.you] && prev.nations[prev.you].alive)) {
      toast('내 성이 무너졌어요 · 관전 모드', 'bad');
    }
  } else if (s.phase === 'over') {
    closeSheet('setup');
    closeSheet('march');
    closeSheet('diplo');
    renderResult(s);
  }

  if (!$('marchSheet').classList.contains('hidden')) refreshMarchNumbers();
  if (!$('diploSheet').classList.contains('hidden')) renderDiplo();
}

function renderTop(s) {
  $('roomCode').textContent = app.code || '----';
  $('timer').textContent = clock(s.time);
  const label = s.phase === 'setup' ? '편성' : s.phase === 'battle' ? '국가전쟁' : '결과';
  $('phaseLabel').textContent = label;
  $('speedBtn').textContent = '×' + (s.speed || 1);
  $('menuSpeed').textContent = '⏩ 게임 속도 ×' + (s.speed || 1);
  $('setupLeft').textContent = s.phase === 'setup' ? s.setupLeft + '초' : '';
}

function renderNations(s) {
  const strip = $('nationStrip');
  if (!strip) return;
  const relLabel = { ally: '동맹', truce: '불가침', war: '전쟁', self: '나' };
  strip.innerHTML = '';
  s.nations.forEach((n) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'nchip' + (n.isYou ? ' me' : '') + (n.alive ? '' : ' dead') + (n.underAttack ? ' under' : '');
    d.style.borderLeftColor = NATION_COLORS[n.slot % NATION_COLORS.length];
    d.dataset.slot = n.slot;
    const wallPct = n.wall.max ? Math.max(0, Math.round(n.wall.hp / n.wall.max * 100)) : 0;
    const castlePct = n.castle.max ? Math.max(0, Math.round(n.castle.hp / n.castle.max * 100)) : 0;
    d.innerHTML =
      '<div class="n-top"><span class="n-name">' + escapeHtml(n.name) + '</span>' +
      '<span class="n-rel">' + (n.ai ? '🤖 ' : '') + (n.isYou ? '👑나' : (relLabel[n.rel] || '')) + '</span></div>' +
      '<div class="n-bar"><i style="width:' + castlePct + '%;background:' + (n.isYou ? '#4bdc9a' : '#ff6a6a') + '"></i></div>' +
      '<div class="n-wall"><i style="width:' + wallPct + '%"></i></div>' +
      '<div class="n-army">' + (n.alive ? '🏰 ' + fmt(n.castle.hp) + ' · ⚔️ ' + fmt(n.total) : '💀 멸망') + '</div>';
    d.addEventListener('click', () => {
      if (app.scene) {
        app.scene.focus(n.slot);
        toast(n.name + ' 성으로 이동');
      }
    });
    strip.appendChild(d);
  });
}

function renderLog(s) {
  const list = $('logList');
  if (!list) return;
  list.innerHTML = '';
  (s.log || []).slice().reverse().forEach((l) => {
    const d = document.createElement('div');
    d.className = 'li ' + (l.kind || '');
    d.innerHTML = '<em>' + clock(l.at) + '</em>' + escapeHtml(l.text);
    list.appendChild(d);
  });
  $('logTime').textContent = clock(s.time);
}

/* ------------------------------------------------------------------ 편성 */
function buildSetupRows() {
  const rows = $('setupRows');
  rows.innerHTML = '';
  UNIT_KEYS.forEach((k) => {
    const u = UNITS[k];
    const row = document.createElement('div');
    row.className = 'urow';
    row.innerHTML =
      '<div class="ul">' + u.icon + ' ' + u.name + '<span class="cap-note">기본 ' + fmt(u.cap) + '</span></div>' +
      '<input type="range" min="0" max="' + u.maxInput + '" step="1" value="' + (app.setup.units[k] || 0) + '" aria-label="' + u.name + '">' +
      '<input type="number" inputmode="numeric" min="0" max="' + u.maxInput + '" step="1" value="' + (app.setup.units[k] || 0) + '" aria-label="' + u.name + ' 직접 입력">';
    const range = row.querySelector('input[type=range]');
    const numIn = row.querySelector('input[type=number]');
    const apply = (v, from) => {
      const val = Math.max(0, Math.min(u.maxInput, Math.floor(Number(v) || 0)));
      app.setup.units[k] = val;
      app.setup.preset = 'custom';
      if (from !== 'range') range.value = String(val);
      if (from !== 'num') numIn.value = String(val);
      updateSetupUI();
      queueSetupSend();
    };
    range.addEventListener('input', () => apply(range.value, 'range'));
    numIn.addEventListener('input', () => apply(numIn.value, 'num'));
    row.dataset.unit = k;
    rows.appendChild(row);
  });

  const defs = $('defRows');
  defs.innerHTML = '';
  [['wall', '🧱 성벽', WALL], ['castle', '🏰 성', CASTLE]].forEach(([key, label, cfg]) => {
    const row = document.createElement('div');
    row.className = 'urow';
    row.innerHTML = '<div class="ul">' + label + '<span class="cap-note">기본 ' + fmt(cfg.base) + '</span></div>' +
      '<div class="stepper"><button type="button" data-d="-1">−</button><b data-v>0</b><button type="button" data-d="1">+</button></div>';
    row.dataset.def = key;
    defs.appendChild(row);
    row.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const dir = Number(b.dataset.d);
        const cur = key === 'wall' ? app.setup.wallBonus : app.setup.castleBonus;
        const next = Math.max(0, Math.min(cfg.maxBonus, cur + dir * cfg.step));
        if (key === 'wall') app.setup.wallBonus = next;
        else app.setup.castleBonus = next;
        app.setup.preset = 'custom';
        updateSetupUI();
        queueSetupSend();
      });
    });
  });

  const presets = $('setupPresets');
  presets.innerHTML = '';
  Object.keys(PRESETS).forEach((key) => {
    const p = PRESETS[key];
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = key;
    b.textContent = p.icon + ' ' + p.label;
    b.addEventListener('click', () => {
      app.setup = presetSetup(key);
      buildSetupRows();
      updateSetupUI();
      queueSetupSend();
      toast(p.label + ' 편성 적용');
    });
    presets.appendChild(b);
  });
}

let setupSendTimer = null;
function queueSetupSend() {
  clearTimeout(setupSendTimer);
  setupSendTimer = setTimeout(sendSetup, 180);
}
function sendSetup() {
  clearTimeout(setupSendTimer);
  const clean = clampSetup(app.setup);
  app.setup = clean;
  send({ type: 'setup', setup: { units: clean.units, wallBonus: clean.wallBonus, castleBonus: clean.castleBonus, preset: clean.preset } });
}

function updateSetupUI() {
  const cost = setupCost(app.setup);
  const over = cost > BUDGET + 0.001;
  $('budgetTxt').textContent = fmt(cost) + ' / ' + fmt(BUDGET) + (over ? ' · 초과!' : '');
  $('budgetBar').style.width = Math.min(100, (cost / BUDGET) * 100) + '%';
  document.querySelector('.budget').classList.toggle('over', over);
  const total = totalUnits(app.setup.units);
  $('setupSummary').textContent = '병력 ' + fmt(total) + ' · 성벽 ' + fmt(WALL.base + app.setup.wallBonus) +
    ' · 성 ' + fmt(CASTLE.base + app.setup.castleBonus);
  $('btnReady').disabled = over || total <= 0;
  $('btnReady').textContent = app.state && app.state.nations[app.slot] && app.state.nations[app.slot].ready ? '✅ 준비 완료 (수정하기)' : '준비 완료';

  document.querySelectorAll('#setupPresets button').forEach((b) => {
    b.classList.toggle('on', b.dataset.preset === app.setup.preset);
  });
  document.querySelectorAll('#setupRows .urow').forEach((row) => {
    const k = row.dataset.unit;
    if (!k) return;
    const v = app.setup.units[k] || 0;
    const range = row.querySelector('input[type=range]');
    const numIn = row.querySelector('input[type=number]');
    if (Number(range.value) !== v) range.value = String(v);
    if (Number(numIn.value) !== v) numIn.value = String(v);
  });
  document.querySelectorAll('#defRows .urow').forEach((row) => {
    const key = row.dataset.def;
    const bonus = key === 'wall' ? app.setup.wallBonus : app.setup.castleBonus;
    const cfg = key === 'wall' ? WALL : CASTLE;
    row.querySelector('[data-v]').textContent = '+' + fmt(bonus) + (bonus >= cfg.maxBonus ? ' MAX' : '');
  });
}

/* ------------------------------------------------------------------ 파병 */
function openMarch() {
  if (!app.state || app.state.phase !== 'battle') { toast('전투가 시작되면 파병할 수 있어요.'); return false; }
  app.marchUnits = null;
  app.marchTo = -1;
  updateMarchUI(true);
  return true;
}

function marchTargets() {
  const s = app.state;
  if (!s) return [];
  return s.nations.filter((n) => !n.isYou && n.alive);
}

function updateMarchUI(reset) {
  const s = app.state;
  const me = s && s.nations[s.you];
  if (!me) return;
  const targets = $('marchTargets');
  targets.innerHTML = '';
  marchTargets().forEach((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    const blocked = n.rel === 'ally' || n.rel === 'truce';
    b.disabled = blocked;
    b.className = app.marchTo === n.slot ? 'on' : '';
    b.innerHTML = '<b>' + escapeHtml(n.name) + '</b><small>' +
      (blocked ? (n.rel === 'ally' ? '동맹 — 선전포고 필요' : '불가침 — 선전포고 필요') : '성 ' + fmt(n.castle.hp) + ' · 성벽 ' + fmt(n.wall.hp)) + '</small>';
    b.addEventListener('click', () => {
      app.marchTo = n.slot;
      app.marchUnits = null;
      updateMarchUI(true);
    });
    targets.appendChild(b);
  });
  if (app.marchTo < 0) {
    $('marchHint').textContent = '보낼 상대를 고르세요';
  } else {
    const t = s.nations[app.marchTo];
    $('marchHint').textContent = '→ ' + t.name + ' · 성벽 ' + fmt(t.wall.hp) + ' / 성 ' + fmt(t.castle.hp);
  }

  const rows = $('marchRows');
  rows.innerHTML = '';
  const avail = me.army || {};
  if (!app.marchUnits) {
    app.marchUnits = {};
    for (const k of UNIT_KEYS) app.marchUnits[k] = Math.floor((avail[k] || 0) * app.marchRatio);
  }
  UNIT_KEYS.forEach((k) => {
    const u = UNITS[k];
    const have = Math.floor(avail[k] || 0);
    if (have <= 0) return;
    const row = document.createElement('div');
    row.className = 'urow';
    row.innerHTML =
      '<div class="ul">' + u.icon + ' ' + u.name + '<span class="cap-note">보유 ' + fmt(have) + '</span></div>' +
      '<input type="range" min="0" max="' + have + '" step="1" value="' + Math.min(have, app.marchUnits[k] || 0) + '">' +
      '<input type="number" inputmode="numeric" min="0" max="' + have + '" step="1" value="' + Math.min(have, app.marchUnits[k] || 0) + '">';
    const range = row.querySelector('input[type=range]');
    const numIn = row.querySelector('input[type=number]');
    const apply = (v, from) => {
      const val = Math.max(0, Math.min(have, Math.floor(Number(v) || 0)));
      app.marchUnits[k] = val;
      if (from !== 'range') range.value = String(val);
      if (from !== 'num') numIn.value = String(val);
      updateMarchTotal();
    };
    range.addEventListener('input', () => apply(range.value, 'range'));
    numIn.addEventListener('input', () => apply(numIn.value, 'num'));
    rows.appendChild(row);
  });
  for (const k of UNIT_KEYS) {
    const have = Math.floor(avail[k] || 0);
    if (app.marchUnits[k] > have) app.marchUnits[k] = have;
  }
  if (!rows.children.length) {
    rows.innerHTML = '<p class="note">보낼 병력이 없습니다. 훈련으로 병력이 다시 모일 때까지 기다리세요.</p>';
  }
  updateMarchTotal();
}

function updateMarchTotal() {
  const total = totalUnits(app.marchUnits || {});
  $('marchTotal').textContent = '파견 ' + fmt(total) + '명';
  $('btnSend').disabled = app.marchTo < 0 || total <= 0;
}

/* 시트를 연 채로 서버 상태가 갱신될 때 — 입력값은 건드리지 않고 숫자만 새로 고친다 */
function refreshMarchNumbers() {
  const s = app.state;
  if (!s) return;
  const me = s.nations[s.you];
  if (!me) return;
  document.querySelectorAll('#marchTargets button').forEach((b, i) => {
    const list = marchTargets();
    const n = list[i];
    if (!n) return;
    const blocked = n.rel === 'ally' || n.rel === 'truce';
    b.disabled = blocked;
    const small = b.querySelector('small');
    if (small) small.textContent = blocked
      ? (n.rel === 'ally' ? '동맹 — 선전포고 필요' : '불가침 — 선전포고 필요')
      : '성 ' + fmt(n.castle.hp) + ' · 성벽 ' + fmt(n.wall.hp);
  });
  if (app.marchTo >= 0) {
    const t = s.nations[app.marchTo];
    if (t) $('marchHint').textContent = '→ ' + t.name + ' · 성벽 ' + fmt(t.wall.hp) + ' / 성 ' + fmt(t.castle.hp);
  }
  updateMarchTotal();
}

function sendMarch() {
  if (app.marchTo < 0) { toast('보낼 상대를 고르세요.', 'bad'); return; }
  const units = {};
  for (const k of UNIT_KEYS) units[k] = Math.floor((app.marchUnits && app.marchUnits[k]) || 0);
  if (totalUnits(units) <= 0) { toast('보낼 병력이 없어요.', 'bad'); return; }
  send({ type: 'march', to: app.marchTo, units });
  closeSheet('march');
  toast('군사를 보냈습니다');
}

/* ------------------------------------------------------------------ 외교 */
function renderDiplo() {
  const s = app.state;
  if (!s) return;
  const me = s.nations[s.you];
  const props = $('propList');
  props.innerHTML = '';
  (s.proposals || []).filter((p) => p.to === s.you).forEach((p) => {
    const from = s.nations[p.from];
    const d = document.createElement('div');
    d.className = 'prop';
    d.innerHTML = '<span>🤝 <b>' + escapeHtml(from ? from.name : '?') + '</b> · ' +
      (p.kind === 'ally' ? '동맹' : '불가침') + ' 제안 <em style="color:#93a6bd">(' + p.left + '초)</em></span>' +
      '<span class="pbtns"><button class="yes" data-a="1">수락</button><button data-a="0">거절</button></span>';
    d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      send({ type: 'diplo', action: 'answer', id: p.id, accept: b.dataset.a === '1' });
    }));
    props.appendChild(d);
  });
  (s.proposals || []).filter((p) => p.from === s.you).forEach((p) => {
    const to = s.nations[p.to];
    const d = document.createElement('div');
    d.className = 'prop';
    d.innerHTML = '<span>보낸 제안 · <b>' + escapeHtml(to ? to.name : '?') + '</b> ' + (p.kind === 'ally' ? '동맹' : '불가침') + ' 응답 대기 (' + p.left + '초)</span>';
    props.appendChild(d);
  });

  const list = $('diploList');
  list.innerHTML = '';
  s.nations.forEach((n) => {
    if (n.isYou) return;
    const d = document.createElement('div');
    d.className = 'dip' + (n.alive ? '' : ' dead');
    const relText = { ally: '🤝 동맹', truce: '🕊️ 불가침', war: '⚔️ 전쟁', self: '나' }[n.rel] || '';
    d.innerHTML = '<div class="d-top"><b>' + escapeHtml(n.name) + '</b>' +
      '<span class="d-rel">' + relText + (n.relUntil ? ' · ' + n.relUntil + '초' : '') + (n.ai ? ' · 🤖 AI' : '') + '</span></div>' +
      '<div class="d-btns">' +
      '<button data-a="truce"' + (n.alive && n.rel === 'war' ? '' : ' disabled') + '>🕊️ 불가침 제안</button>' +
      '<button data-a="ally"' + (n.alive && n.rel !== 'ally' ? '' : ' disabled') + '>🤝 동맹 제안</button>' +
      '<button class="war" data-a="war"' + (n.alive && n.rel !== 'war' ? '' : ' disabled') + '>⚔️ 선전포고</button>' +
      '</div>';
    d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'war') {
        if (!b.dataset.armed) {
          b.dataset.armed = '1';
          b.textContent = '⚠️ 정말 선전포고?';
          setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = '⚔️ 선전포고'; } }, 2600);
          return;
        }
        delete b.dataset.armed;
        send({ type: 'diplo', action: 'war', to: n.slot });
        toast('선전포고했습니다');
      } else {
        send({ type: 'diplo', action: 'offer', to: n.slot, kind: a });
        toast('제안을 보냈습니다');
      }
    }));
    list.appendChild(d);
  });
  $('diploHint').textContent = me && me.total ? '내 병력 ' + fmt(me.total) : '동맹 · 불가침 · 선전포고';
}

/* ------------------------------------------------------------------ 시트 */
const SHEETS = { setup: 'setupSheet', march: 'marchSheet', diplo: 'diploSheet', log: 'logSheet', menu: 'menuSheet' };

function openSheet(name) {
  if (name === 'march' && !openMarch()) return;
  Object.keys(SHEETS).forEach((k) => show($(SHEETS[k]), k === name));
  if (name === 'setup') { app.setupOpen = true; updateSetupUI(); }
  if (name === 'diplo') renderDiplo();
  if (name === 'log') renderLog(app.state || { log: [] });
  if (name === 'menu') { $('menuCode').textContent = app.code || '----'; }
}

function closeSheet(name) {
  if (name) { show($(SHEETS[name]), false); if (name === 'setup') app.setupOpen = false; return; }
  Object.keys(SHEETS).forEach((k) => show($(SHEETS[k]), false));
  app.setupOpen = false;
}

function bindSheets() {
  $('btnSetup').addEventListener('click', () => openSheet('setup'));
  $('btnDiplo').addEventListener('click', () => openSheet('diplo'));
  $('btnMarch').addEventListener('click', () => openSheet('march'));
  $('diploClose').addEventListener('click', () => closeSheet('diplo'));
  $('logClose').addEventListener('click', () => closeSheet('log'));
  $('menuClose').addEventListener('click', () => closeSheet('menu'));
  $('logBtn').addEventListener('click', () => openSheet('log'));
  $('menuBtn').addEventListener('click', () => openSheet('menu'));
  $('btnSend').addEventListener('click', sendMarch);
  $('btnReady').addEventListener('click', () => {
    sendSetup();
    send({ type: 'ready', value: true });
    toast('준비 완료! 남은 인원을 기다립니다');
  });
  $('speedBtn').addEventListener('click', () => {
    const cur = (app.state && app.state.speed) || 1;
    send({ type: 'speed', value: cur >= 2 ? 1 : 2 });
  });
  $('menuSpeed').addEventListener('click', () => {
    const cur = (app.state && app.state.speed) || 1;
    send({ type: 'speed', value: cur >= 2 ? 1 : 2 });
  });
  $('menuAll').addEventListener('click', () => { if (app.scene) app.scene.overview(); closeSheet('menu'); });
  $('camMine').addEventListener('click', () => { if (app.scene) app.scene.focus(app.slot); });
  $('camAll').addEventListener('click', () => { if (app.scene) app.scene.overview(); });
  $('menuLeave').addEventListener('click', () => { send({ type: 'leave' }); resetToLobby(true); });
  $('btnResultLeave').addEventListener('click', () => { send({ type: 'leave' }); resetToLobby(true); });
  $('btnRematch').addEventListener('click', () => send({ type: 'rematch' }));

  document.querySelectorAll('#marchRatio button').forEach((b) => {
    b.addEventListener('click', () => {
      app.marchRatio = Number(b.dataset.ratio) || 0.5;
      document.querySelectorAll('#marchRatio button').forEach((x) => x.classList.toggle('on', x === b));
      app.marchUnits = null;
      updateMarchUI(true);
    });
  });

  document.querySelectorAll('.sheet').forEach((sh) => {
    sh.addEventListener('click', (e) => {
      if (e.target !== sh) return;
      const id = sh.id;
      if (id === 'setupSheet') return;                 // 편성은 닫지 않는다 (버튼으로)
      sh.classList.add('hidden');
    });
  });
}

function renderResult(s) {
  const over = s.over || {};
  const me = s.nations[s.you];
  const win = over.winner === s.you;
  show($('resultOv'), true);
  $('resultMark').textContent = win ? '👑' : (me && me.alive ? '⚔️' : '💀');
  $('resultTitle').textContent = win ? '승리!' : (over.winner === -1 ? '무승부' : (me && me.alive ? '전쟁 종료' : '패배'));
  $('resultSub').textContent = over.winnerName ? over.winnerName + ' 님이 마지막까지 살아남았습니다.' : '';
  $('resTime').textContent = clock(over.at || s.time);
  $('resLeft').textContent = fmt(s.nations.filter((n) => n.alive).length);
  $('resSent').textContent = fmt(me ? (me.initialTotal || 0) : 0);
  const isHost = s.you === s.host;
  $('btnRematch').disabled = !isHost;
  $('btnRematch').textContent = isHost ? '같은 멤버로 다시' : '방장이 다시 시작할 수 있어요';
}

/* ------------------------------------------------------------- 카메라 조작 */
function bindCamera() {
  const joy = $('joy');
  const knob = $('joyKnob');
  const setJoy = (e) => {
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = (e.clientX - cx) / (r.width / 2);
    let dy = (e.clientY - cy) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    if (app.scene) app.scene.setJoy(dx, -dy);
    knob.style.transform = 'translate(' + dx * 26 + 'px,' + dy * 26 + 'px)';
  };
  joy.addEventListener('pointerdown', (e) => {
    app.joystick.active = true;
    app.joystick.id = e.pointerId;
    try { joy.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    setJoy(e);
    e.preventDefault();
  });
  joy.addEventListener('pointermove', (e) => {
    if (app.joystick.active && e.pointerId === app.joystick.id) { setJoy(e); e.preventDefault(); }
  });
  const endJoy = (e) => {
    if (app.joystick.id != null && e.pointerId !== app.joystick.id) return;
    app.joystick.active = false;
    app.joystick.id = null;
    knob.style.transform = 'translate(0,0)';
    if (app.scene) app.scene.setJoy(0, 0);
  };
  joy.addEventListener('pointerup', endJoy);
  joy.addEventListener('pointercancel', endJoy);
  joy.addEventListener('lostpointercapture', endJoy);

  const canvas = $('gl');
  canvas.addEventListener('pointerdown', (e) => {
    app.drag.active = true;
    app.drag.id = e.pointerId;
    app.drag.x = e.clientX;
    app.drag.y = e.clientY;
    app.drag.moved = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!app.drag.active || e.pointerId !== app.drag.id) return;
    const dx = e.clientX - app.drag.x;
    const dy = e.clientY - app.drag.y;
    app.drag.x = e.clientX;
    app.drag.y = e.clientY;
    app.drag.moved += Math.abs(dx) + Math.abs(dy);
    if (app.scene) app.scene.look(dx, dy);
  });
  const endDrag = (e) => {
    if (app.drag.id != null && e.pointerId !== app.drag.id) return;
    app.drag.active = false;
    app.drag.id = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* 마우스 휠 = 고도 */
  canvas.addEventListener('wheel', (e) => {
    if (app.scene) app.scene.raise(e.deltaY > 0 ? 6 : -6);
    e.preventDefault();
  }, { passive: false });

  let altTimer = null;
  document.querySelectorAll('#altBtns button').forEach((b) => {
    const dir = b.dataset.alt === 'up' ? 1 : -1;
    const start = (e) => {
      e.preventDefault();
      if (app.scene) app.scene.raise(dir * 5);
      clearInterval(altTimer);
      altTimer = setInterval(() => { if (app.scene) app.scene.raise(dir * 3); }, 70);
    };
    const stop = () => clearInterval(altTimer);
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('pointerleave', stop);
  });
}

/* ------------------------------------------------------------------ 시작 */
function ensureScene() {
  if (!app.scene) {
    app.scene = new WarScene($('gl'));
    if (app.state) app.scene.syncNations(app.state.nations || []);
  }
  return app.scene;
}

function boot() {
  bindLobby();
  bindSheets();
  bindCamera();

  let savedName = '';
  try { savedName = localStorage.getItem('friends:name') || ''; } catch (e) { /* noop */ }
  if (savedName) $('nameInput').value = savedName;

  const params = new URLSearchParams(location.search);
  const codeParam = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sess = readSession();
  if (sess && sess.code && sess.token) app.name = sess.name || '';

  if (codeParam) $('joinCode').value = codeParam;

  connect();

  if (sess && sess.code && sess.token) {
    app.code = sess.code;
    app.token = sess.token;
    app.wantResume = true;
  } else if (codeParam) {
    showLobbyPanel('home');
    if (!$('nameInput').value) $('nameInput').focus();
    toast('방 코드 ' + codeParam + ' · 이름을 넣고 입장하세요');
  } else {
    showLobbyPanel('home');
  }

  $('lobby').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'lobby') { /* 빈 곳 탭은 무시 */ }
  });

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    /* 로비에서는 그리지 않는다 (폰 배터리·발열) */
    if (app.scene && app.state && app.state.nations && app.state.nations.length) {
      app.scene.update(app.state, dt);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => { if (app.ws) app.ws.close(); });

  /* 테스트/디버그용 — 헤드리스 검증에서 상태를 읽는다 */
  window.FRIENDS = {
    get state() { return app.state; },
    get code() { return app.code; },
    get slot() { return app.slot; },
    get setup() { return app.setup; },
    get scene() { return app.scene; },
    send,
    openSheet,
    closeSheet
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
