'use strict';

/* =============================================================================
   친구와 플레이 · 2~5인 실시간 국가전쟁 (성 · 성벽 · 병력 배분 · 외교 · 군사 파견)
   -----------------------------------------------------------------------------
   · 방장이 시작 → 참가자(2~5국)의 성과 성벽이 전장에 세워지고 '편성' 단계
   · 편성: 정해진 편성치(5,000) 안에서 병종별 병력·성벽·성 강화를 직접 배분
     - 기본 상한: 일반 병사 2,000 · 고급 병사 500 · 특수 유닛(기사/마법사/검객/광전사) 각 20
       (수치를 직접 입력해 상한을 넘겨 더 넣을 수 있다 — 예산이 남아 있을 때)
   · 전투: 상대 성으로 군사를 보내면 실제로 전장에 소환되어 진군 → 성벽 → 성 순으로 공격
   · 외교: 불가침 · 동맹 · 선전포고(적대)를 실시간으로 맺고 끊는다
   · 모든 성을 부순 마지막 한 나라가 승리, 성이 부서진 나라는 탈락(관전)
   ============================================================================= */

const UNIT_KEYS = ['soldier', 'elite', 'knight', 'wizard', 'blademaster', 'berserker'];

/* 병종 정보 — 클라이언트(public/friends/friends.js)와 같은 수치를 쓴다.
   hp/damage/cycle 은 배틀 아레나(config.js)의 병종 스펙에서 가져왔다. */
const UNITS = {
  soldier: {
    key: 'soldier', name: '일반 병사', icon: '⚔️',
    hp: 150, damage: 150, cycle: 0.82, maxTargets: 1,
    power: 1.0, siege: 0.18, speed: 4.15,
    cost: 1, cap: 2000, maxInput: 6000
  },
  elite: {
    key: 'elite', name: '고급 병사', icon: '🛡️',
    hp: 165, damage: 150, cycle: 0.745, maxTargets: 1,
    power: 1.15, siege: 0.30, speed: 4.57,
    cost: 1, cap: 500, maxInput: 1500
  },
  knight: {
    key: 'knight', name: '중갑 기사', icon: '🔨',
    hp: 2900, damage: 285, cycle: 1.03, maxTargets: 100,
    power: 10, siege: 4.0, speed: 3.3,
    cost: 25, cap: 20, maxInput: 60
  },
  wizard: {
    key: 'wizard', name: '대마법사', icon: '🔮',
    hp: 240, damage: 212, cycle: 1.2, maxTargets: 6,
    power: 5, siege: 2.0, speed: 3.5,
    cost: 12, cap: 20, maxInput: 60
  },
  blademaster: {
    key: 'blademaster', name: '매화 검객', icon: '🌸',
    hp: 1200, damage: 178, cycle: 0.30, maxTargets: 10,
    power: 5, siege: 1.5, speed: 5.4,
    cost: 20, cap: 20, maxInput: 60
  },
  berserker: {
    key: 'berserker', name: '단검 광전사', icon: '🩸',
    hp: 3600, damage: 18, cycle: 0.25, maxTargets: 1,
    power: 4, siege: 1.0, speed: 5.0,
    cost: 30, cap: 20, maxInput: 60
  }
};

const CFG = {
  minPlayers: 2,
  maxPlayers: 5,
  budget: 5000,             // 편성치
  wallBase: 3000,
  wallStep: 1000,
  wallCost: 40,
  wallMaxBonus: 6000,
  castleBase: 6000,
  castleStep: 1000,
  castleCost: 55,
  castleMaxBonus: 8000,
  setupSec: 60,             // 편성 제한 시간
  mapRadius: 64,            // 성이 놓이는 원 반지름 (2~5인에 따라 40~64)
  stepMs: 100,
  stateMs: 200,             // 상태 전송 주기
  dps: 6,                   // 병력 1 power 당 초당 피해
  wallDpsPerHp: 0.30,       // 남은 성벽 1 HP 당 초당 피해 (공성군에게)
  castleDpsPerHp: 0.10,     // 성벽이 뚫린 뒤 성(수비대)이 주는 초당 피해
  trainFrac: 0.010,         // 초당 초기 병력의 1% 재훈련 (포위 중에는 없음)
  marchSpeed: 18,           // 초당 이동 거리
  battleLimitSec: 20 * 60
};

/* 편성 프리셋 — 예산 안에서 골고루 / 공격 몰빵 / 수비 몰빵 */
const PRESETS = {
  balanced: {
    label: '골고루', icon: '⚖️',
    units: { soldier: 2000, elite: 500, knight: 12, wizard: 15, blademaster: 10, berserker: 8 },
    wallBonus: 4000, castleBonus: 6000
  },
  attack: {
    label: '공격 몰빵', icon: '⚔️',
    units: { soldier: 2000, elite: 500, knight: 20, wizard: 20, blademaster: 20, berserker: 20 },
    wallBonus: 1000, castleBonus: 4000
  },
  defense: {
    label: '수비 몰빵', icon: '🛡️',
    units: { soldier: 2000, elite: 500, knight: 5, wizard: 5, blademaster: 5, berserker: 5 },
    wallBonus: 6000, castleBonus: 8000
  }
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (v) => Math.round(v * 10) / 10;

function emptyUnits() {
  const u = {};
  for (const k of UNIT_KEYS) u[k] = 0;
  return u;
}

function cloneUnits(u) {
  const out = {};
  for (const k of UNIT_KEYS) out[k] = Math.max(0, num(u && u[k]));
  return out;
}

function totalUnits(u) {
  let n = 0;
  for (const k of UNIT_KEYS) n += num(u && u[k]);
  return n;
}

function unitPower(u) {
  let p = 0;
  for (const k of UNIT_KEYS) p += num(u && u[k]) * UNITS[k].power;
  return p;
}

function unitSiege(u) {
  let p = 0;
  for (const k of UNIT_KEYS) p += num(u && u[k]) * UNITS[k].siege;
  return p;
}

function unitHp(u) {
  let p = 0;
  for (const k of UNIT_KEYS) p += num(u && u[k]) * UNITS[k].hp;
  return p;
}

/* hp 피해량을 병력 손실로 바꾼다 (체력 비중대로 골고루 잃는다) */
function applyLoss(u, hpLoss) {
  const pool = unitHp(u);
  if (pool <= 0) {
    for (const k of UNIT_KEYS) u[k] = 0;
    return;
  }
  const frac = Math.min(1, Math.max(0, hpLoss) / pool);
  for (const k of UNIT_KEYS) {
    const lose = num(u[k]) * frac;
    u[k] = Math.max(0, u[k] - lose);
  }
}

function unitsView(u) {
  const out = {};
  for (const k of UNIT_KEYS) out[k] = Math.round(num(u && u[k]));
  return out;
}

function setupCost(setup) {
  let cost = 0;
  if (!setup) return 0;
  for (const k of UNIT_KEYS) cost += num(setup.units && setup.units[k]) * UNITS[k].cost;
  cost += (num(setup.wallBonus) / CFG.wallStep) * CFG.wallCost;
  cost += (num(setup.castleBonus) / CFG.castleStep) * CFG.castleCost;
  return cost;
}

/* 들어온 편성을 예산·상한에 맞춰 정리한다. 예산을 넘으면 null */
function normalizeSetup(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const src = r.units && typeof r.units === 'object' ? r.units : {};
  const units = {};
  for (const k of UNIT_KEYS) {
    const n = Math.floor(clamp(num(src[k]), 0, UNITS[k].maxInput));
    units[k] = n;
  }
  const wallBonus = Math.round(clamp(num(r.wallBonus), 0, CFG.wallMaxBonus) / CFG.wallStep) * CFG.wallStep;
  const castleBonus = Math.round(clamp(num(r.castleBonus), 0, CFG.castleMaxBonus) / CFG.castleStep) * CFG.castleStep;
  const setup = {
    units,
    wallBonus,
    castleBonus,
    preset: typeof r.preset === 'string' ? r.preset.slice(0, 16) : 'custom'
  };
  const cost = setupCost(setup);
  if (cost > CFG.budget + 0.001) return null;
  if (totalUnits(units) <= 0) return null;
  setup.cost = cost;
  return setup;
}

function presetSetup(name) {
  const p = PRESETS[name] || PRESETS.balanced;
  const out = normalizeSetup({ units: p.units, wallBonus: p.wallBonus, castleBonus: p.castleBonus, preset: PRESETS[name] ? name : 'balanced' });
  return out || normalizeSetup({ units: PRESETS.balanced.units, wallBonus: 4000, castleBonus: 6000, preset: 'balanced' });
}

/* 인원이 적으면 성을 더 가깝게 — 2인전이 텅 빈 전장처럼 보이지 않게 */
const MAP_RADIUS = { 2: 40, 3: 50, 4: 58, 5: 64 };
function mapRadiusFor(count) {
  const n = Math.max(2, Math.min(5, Math.floor(count) || 2));
  return MAP_RADIUS[n] || CFG.mapRadius;
}

function castlePos(slot, count) {
  const n = Math.max(2, count);
  const a = -Math.PI / 2 + (slot % n) * (Math.PI * 2 / n);
  const r = mapRadiusFor(n);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, angle: a };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function makeRelations(n) {
  const rel = [];
  for (let i = 0; i < n; i++) {
    rel.push([]);
    for (let j = 0; j < n; j++) {
      rel[i].push({ type: i === j ? 'self' : 'war', until: 0, trust: i === j ? 100 : 40 });
    }
  }
  return rel;
}

function createState(opts) {
  const o = opts || {};
  return {
    capacity: clamp(Math.floor(num(o.capacity)) || CFG.maxPlayers, CFG.minPlayers, CFG.maxPlayers),
    aiFill: o.aiFill !== false,
    phase: 'lobby',             // lobby | setup | battle | over
    time: 0,
    speed: 1,
    names: [],
    nations: [],
    marches: [],
    sieges: {},                 // targetSlot -> { [attackerSlot]: { units } }
    rel: [],
    proposals: [],
    log: [],
    over: null,
    setupEnds: 0,
    seq: 1,
    nextStateAt: 0,
    lastTickAt: 0,
    aiFillDone: false
  };
}

function addLog(st, text, kind) {
  st.log.push({ at: Math.round(st.time * 10) / 10, text, kind: kind || 'info' });
  if (st.log.length > 30) st.log.splice(0, st.log.length - 30);
}

function nameOf(st, slot) {
  const n = st.nations[slot];
  return n ? n.name : '국가 ' + (slot + 1);
}

function aliveNations(st) {
  return st.nations.filter((n) => n && n.alive);
}

function relOf(st, a, b) {
  if (a === b) return { type: 'self', until: 0, trust: 100 };
  const row = st.rel[a];
  return (row && row[b]) || { type: 'war', until: 0, trust: 0 };
}

function setRel(st, a, b, type, until, trustDelta) {
  if (a === b) return;
  const now = st.time;
  for (const [x, y] of [[a, b], [b, a]]) {
    const r = st.rel[x][y];
    r.type = type;
    r.until = type === 'truce' || type === 'ally' ? until : 0;
    if (trustDelta) r.trust = clamp(r.trust + trustDelta, 0, 100);
  }
}

function relationExpire(st) {
  for (let a = 0; a < st.rel.length; a++) {
    for (let b = a + 1; b < st.rel.length; b++) {
      const r = st.rel[a][b];
      if ((r.type === 'truce' || r.type === 'ally') && r.until > 0 && st.time >= r.until) {
        const label = r.type === 'ally' ? '동맹' : '불가침';
        r.type = 'war';
        r.until = 0;
        const q = st.rel[b][a];
        q.type = 'war';
        q.until = 0;
        addLog(st, nameOf(st, a) + ' · ' + nameOf(st, b) + ' 사이의 ' + label + '이 만료됐습니다', 'warn');
        notifyAll(st, nameOf(st, a) + ' · ' + nameOf(st, b) + ' ' + label + ' 만료', 'warn');
      }
    }
  }
}

function canAttack(st, a, b) {
  if (a === b) return false;
  const na = st.nations[a], nb = st.nations[b];
  if (!na || !nb || !na.alive || !nb.alive) return false;
  const r = relOf(st, a, b);
  if (r.type === 'ally') return false;
  if (r.type === 'truce' && r.until > st.time) return false;
  return true;
}

/* ------------------------------------------------------------------ 방송 */
function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ }
}

function notifyAll(st, text, kind) {
  st.pendingEvents = st.pendingEvents || [];
  st.pendingEvents.push({ text, kind: kind || 'info', at: Date.now() });
  if (st.pendingEvents.length > 12) st.pendingEvents.shift();
}

function flushEvents(st, room) {
  if (!st.pendingEvents || !st.pendingEvents.length) return;
  const events = st.pendingEvents.splice(0, st.pendingEvents.length);
  for (const p of room.players) {
    if (!p.ws || !p.connected || p.isAI) continue;
    for (const e of events) send(p.ws, { type: 'fevent', text: e.text, kind: e.kind, at: e.at });
  }
}

/* ------------------------------------------------------------------ 로비 */
function lobbyPayload(room, player) {
  const st = room.friends;
  return {
    type: 'flobby',
    mode: 'castle',
    code: room.code,
    host: room.hostSlot,
    you: player ? player.slot : -1,
    started: st.phase !== 'lobby',
    phase: st.phase,
    capacity: st.capacity,
    aiFill: st.aiFill,
    minPlayers: CFG.minPlayers,
    maxPlayers: CFG.maxPlayers,
    budget: CFG.budget,
    units: Object.fromEntries(UNIT_KEYS.map((k) => [k, {
      name: UNITS[k].name, icon: UNITS[k].icon, cost: UNITS[k].cost, cap: UNITS[k].cap, maxInput: UNITS[k].maxInput
    }])),
    presets: PRESETS,
    players: room.players.filter((p) => !p.isAI).map((p) => ({
      slot: p.slot, name: p.name, host: p.slot === room.hostSlot, ai: false, connected: !!p.connected
    }))
  };
}

function broadcastLobby(room) {
  for (const p of room.players) {
    if (!p.ws || !p.connected || p.isAI) continue;
    send(p.ws, lobbyPayload(room, p));
  }
}

/* ------------------------------------------------------------------ 시작 */
function fillAI(room) {
  const st = room.friends;
  if (!st.aiFill) return;
  const used = new Set(room.players.map((p) => p.slot));
  let aiIndex = 1;
  for (let slot = 0; slot < st.capacity; slot++) {
    if (used.has(slot)) continue;
    room.players.push({
      slot,
      controlSlot: slot,
      name: 'AI 국가 ' + aiIndex,
      token: 'ai-' + slot + '-' + Math.random().toString(36).slice(2),
      ws: null,
      connected: false,
      isAI: true,
      abandoned: false,
      autoAI: true,
      lastDispatch: 0,
      disconnectedAt: null,
      dropTimer: null
    });
    aiIndex++;
  }
}

function startGame(room, bySlot) {
  const st = room.friends;
  if (!st) return { error: ['NO_STATE', '방 정보를 찾을 수 없어요.'] };
  if (st.phase !== 'lobby') return { error: ['ALREADY', '이미 시작했어요.'] };
  if (bySlot !== room.hostSlot) return { error: ['HOST_ONLY', '방장만 시작할 수 있어요.'] };
  fillAI(room);
  const humans = room.players.filter((p) => !p.isAI).length;
  if (humans < 1) return { error: ['NO_PLAYER', '플레이어가 없어요.'] };
  if (room.players.length < CFG.minPlayers) {
    return { error: ['NEED_MORE', '2명 이상이어야 시작할 수 있어요. (빈 자리를 AI로 채우면 혼자서도 가능)'] };
  }
  room.started = true;
  st.phase = 'setup';
  st.time = 0;
  st.setupEnds = CFG.setupSec;
  st.names = [];
  st.nations = [];
  st.marches = [];
  st.sieges = {};
  st.proposals = [];
  st.over = null;
  st.log = [];
  st.pendingEvents = [];
  const hostPlayer = room.players.find((p) => p.slot === room.hostSlot) || room.players[0];
  room.players.sort((a, b) => a.slot - b.slot);
  const count = room.players.length;
  st.mapRadius = mapRadiusFor(count);
  st.rel = makeRelations(count);
  let aiPick = 0;
  const presetNames = ['balanced', 'attack', 'defense'];
  for (let i = 0; i < count; i++) {
    const p = room.players[i];
    p.slot = i;
    p.controlSlot = i;
    if (p === hostPlayer) room.hostSlot = i;
    const pos = castlePos(i, count);
    const preset = p.isAI ? presetNames[(aiPick++) % presetNames.length] : 'balanced';
    const setup = presetSetup(preset);
    st.names[i] = p.name;
    st.nations.push({
      slot: i,
      name: p.name,
      ai: !!p.isAI,
      alive: true,
      ready: false,
      autoAI: !!p.isAI,
      pos,
      setup,
      applied: false,
      army: cloneUnits(setup.units),
      initial: cloneUnits(setup.units),
      initialTotal: totalUnits(setup.units),
      castle: { hp: CFG.castleBase + setup.castleBonus, max: CFG.castleBase + setup.castleBonus },
      wall: { hp: CFG.wallBase + setup.wallBonus, max: CFG.wallBase + setup.wallBonus },
      spawn: pos,
      underAttack: false,
      nextAiAt: 2 + Math.random() * 2,
      destroyedAt: 0,
      sentTotal: 0
    });
    addLog(st, st.names[i] + ' 님이 ' + (p.isAI ? 'AI 국가로 ' : '') + '참전했습니다', 'info');
  }
  notifyAll(st, '성과 성벽이 세워졌습니다 · 편성 단계 (' + CFG.setupSec + '초)', 'good');
  broadcastLobby(room);
  broadcastState(room, true);
  return { ok: true };
}

function beginBattle(st) {
  if (st.phase !== 'setup') return;
  st.phase = 'battle';
  st.time = 0;
  for (const n of st.nations) {
    if (!n) continue;
    n.ready = true;
    n.army = cloneUnits(n.setup.units);
    n.initial = cloneUnits(n.setup.units);
    n.initialTotal = totalUnits(n.setup.units);
    n.castle.max = CFG.castleBase + n.setup.castleBonus;
    n.castle.hp = n.castle.max;
    n.wall.max = CFG.wallBase + n.setup.wallBonus;
    n.wall.hp = n.wall.max;
    n.nextAiAt = 3 + Math.random() * 3;
  }
  addLog(st, '국가 전쟁이 시작됐습니다!', 'good');
  notifyAll(st, '⚔️ 국가 전쟁 시작!', 'good');
}

/* 편성 확정 — 한 명이 확정해도 남은 인원은 계속 조절할 수 있다 */
function setSetup(room, player, raw) {
  const st = room.friends;
  if (st.phase !== 'setup') return { error: ['PHASE', '지금은 편성 단계가 아니에요.'] };
  const nation = st.nations[player.slot];
  if (!nation || !nation.alive) return { error: ['NO_NATION', '참전 국가가 없어요.'] };
  const setup = normalizeSetup(raw);
  if (!setup) return { error: ['BUDGET', '편성치(' + CFG.budget + ')를 넘었거나 병력이 없어요.'] };
  nation.setup = setup;
  nation.ready = false;
  return { ok: true };
}

function setReady(room, player, value) {
  const st = room.friends;
  if (st.phase !== 'setup') return { error: ['PHASE', '지금은 편성 단계가 아니에요.'] };
  const nation = st.nations[player.slot];
  if (!nation) return { error: ['NO_NATION', '참전 국가가 없어요.'] };
  nation.ready = !!value;
  if (allHumansReady(room)) beginBattle(st);
  return { ok: true };
}

function allHumansReady(room) {
  const st = room.friends;
  const humans = room.players.filter((p) => !p.isAI);
  if (humans.length < 1) return false;
  return humans.every((p) => {
    const n = st.nations[p.slot];
    return n && (n.ready || !n.alive);
  });
}

/* ------------------------------------------------------------------ 전투 */
function marchTravel(from, to) {
  const d = dist(from, to);
  return clamp(d / CFG.marchSpeed, 3.2, 13);
}

function rebalanceUnits(u) {
  const out = cloneUnits(u);
  for (const k of UNIT_KEYS) out[k] = Math.max(0, Math.round(out[k] * 10) / 10);
  return out;
}

function sendMarch(room, player, toSlot, rawUnits, kind) {
  const st = room.friends;
  if (st.phase !== 'battle') return { error: ['PHASE', '전투 중에만 군사를 보낼 수 있어요.'] };
  const from = player.slot;
  const nation = st.nations[from];
  if (!nation || !nation.alive) return { error: ['DEAD', '이미 성이 무너졌어요.'] };
  const target = st.nations[toSlot];
  if (!target || !target.alive) return { error: ['NO_TARGET', '그 국가는 이미 무너졌어요.'] };
  if (!canAttack(st, from, toSlot)) {
    const r = relOf(st, from, toSlot);
    return {
      error: ['DIPLO', r.type === 'ally' ? '동맹국에는 군사를 보낼 수 없어요. 먼저 선전포고하세요.'
        : '불가침 중에는 군사를 보낼 수 없어요. 먼저 선전포고하세요.']
    };
  }
  const units = {};
  let total = 0;
  for (const k of UNIT_KEYS) {
    const have = Math.floor(num(nation.army[k]));
    const want = Math.floor(clamp(num(rawUnits && rawUnits[k]), 0, have));
    units[k] = want;
    total += want;
  }
  if (total <= 0) return { error: ['EMPTY', '보낼 군사가 없어요.'] };
  if (total > 12000) return { error: ['TOO_MANY', '한 번에 보낼 수 있는 군사가 너무 많아요.'] };
  const mine = st.marches.filter((m) => m.from === from && m.phase === 'march');
  if (mine.length >= 6) return { error: ['BUSY', '이미 진군 중인 부대가 너무 많아요 (최대 6).'] };
  for (const k of UNIT_KEYS) nation.army[k] = Math.max(0, nation.army[k] - units[k]);
  const travel = marchTravel(nation.pos, target.pos);
  const march = {
    id: st.seq++,
    from,
    to: toSlot,
    phase: 'march',
    units: rebalanceUnits(units),
    total,
    departAt: st.time,
    arriveAt: st.time + travel,
    travel,
    kind: kind === 'return' ? 'return' : 'attack'
  };
  nation.sentTotal += total;
  st.marches.push(march);
  addLog(st, nameOf(st, from) + ' → ' + nameOf(st, toSlot) + ' · 군사 ' + Math.round(total).toLocaleString('ko-KR') + '명 파견', 'info');
  notifyAll(st, '⚔️ ' + nameOf(st, from) + ' → ' + nameOf(st, toSlot) + ' 군사 ' + Math.round(total).toLocaleString('ko-KR') + '명 진군', 'warn');
  return { ok: true };
}

function arrive(room, march) {
  const st = room.friends;
  const nation = st.nations[march.from];
  const target = st.nations[march.to];
  if (march.phase === 'return') {
    if (nation && nation.alive) {
      for (const k of UNIT_KEYS) nation.army[k] = num(nation.army[k]) + num(march.units[k]);
    }
    march.done = true;
    return;
  }
  if (!nation || !nation.alive) { march.done = true; return; }
  if (!target || !target.alive) {
    /* 목표가 이미 무너졌으면 귀환 */
    march.phase = 'return';
    march.from = march.to;
    march.to = nation.slot;
    march.departAt = st.time;
    march.arriveAt = st.time + marchTravel(target ? target.pos : nation.pos, nation.pos);
    return;
  }
  if (!canAttack(st, march.from, march.to)) {
    march.phase = 'return';
    const home = st.nations[march.from];
    march.from = march.to;
    march.to = home.slot;
    march.departAt = st.time;
    march.arriveAt = st.time + marchTravel(target.pos, home.pos);
    return;
  }
  const siege = st.sieges[march.to] || (st.sieges[march.to] = {});
  const box = siege[march.from] || (siege[march.from] = { units: emptyUnits() });
  for (const k of UNIT_KEYS) box.units[k] = num(box.units[k]) + num(march.units[k]);
  march.done = true;
  addLog(st, nameOf(st, march.from) + ' 군대가 ' + nameOf(st, march.to) + '의 성벽에 도착', 'warn');
  notifyAll(st, '💥 ' + nameOf(st, march.to) + ' 성이 공격받고 있습니다', 'warn');
}

function countSiegeUnits(siege) {
  let total = 0;
  for (const slot of Object.keys(siege || {})) total += totalUnits(siege[slot].units);
  return total;
}

function resolveSiege(room, targetSlot, dt) {
  const st = room.friends;
  const target = st.nations[targetSlot];
  const siege = st.sieges[targetSlot];
  if (!target || !target.alive || !siege) return;
  const attackers = Object.keys(siege)
    .map((k) => ({ slot: Number(k), box: siege[k] }))
    .filter((a) => {
      const n = st.nations[a.slot];
      return n && n.alive && totalUnits(a.box.units) > 0.01;
    });
  if (!attackers.length) {
    delete st.sieges[targetSlot];
    target.underAttack = false;
    return;
  }
  target.underAttack = true;
  const atkPower = attackers.reduce((s, a) => s + unitPower(a.box.units), 0);
  const atkHp = attackers.reduce((s, a) => s + unitHp(a.box.units), 0);
  const defPower = unitPower(target.army);
  const defHp = unitHp(target.army);
  const wallUp = target.wall.hp > 0;

  /* 공격군이 받는 피해 — 수비 병력 + 성벽(또는 성)의 반격 */
  const defDps = defPower * CFG.dps + (wallUp ? target.wall.hp * CFG.wallDpsPerHp : target.castle.hp * CFG.castleDpsPerHp);
  const incoming = Math.min(atkHp, defDps * dt);
  if (atkPower > 0) {
    for (const a of attackers) {
      const share = atkPower > 0 ? unitPower(a.box.units) / atkPower : 0;
      applyLoss(a.box.units, incoming * share);
    }
  }

  /* 수비 병력이 받는 피해 — 성벽이 무너진 뒤에는 사기가 꺾여 1.5배로 얻어맞는다 */
  if (defHp > 0) applyLoss(target.army, atkPower * CFG.dps * (wallUp ? 1 : 1.5) * dt);

  /* 공성 피해 — 성벽이 살아있는 동안은 성이 무적 */
  let siegeDmg = 0;
  for (const a of attackers) siegeDmg += unitSiege(a.box.units) * dt;
  if (wallUp) {
    target.wall.hp = Math.max(0, target.wall.hp - siegeDmg);
    if (target.wall.hp === 0) {
      addLog(st, nameOf(st, targetSlot) + '의 성벽이 무너졌습니다!', 'warn');
      notifyAll(st, '🧱 ' + nameOf(st, targetSlot) + ' 성벽 붕괴!', 'warn');
    }
  } else {
    const mult = defHp <= 0.01 ? 1.6 : 1;
    target.castle.hp = Math.max(0, target.castle.hp - siegeDmg * mult);
  }

  /* 병력 정리 */
  for (const a of attackers) {
    if (totalUnits(a.box.units) < 0.5) delete siege[a.slot];
  }
  for (const k of UNIT_KEYS) {
    if (target.army[k] < 0.5) target.army[k] = 0;
  }

  if (target.castle.hp <= 0) {
    /* 성을 부순 부대는 남은 병력을 이끌고 자기 성으로 귀환한다 */
    const survivors = attackers.map((a) => ({ slot: a.slot, box: { units: cloneUnits(a.box.units) } }))
      .filter((a) => totalUnits(a.box.units) >= 1);
    destroyNation(room, targetSlot);
    if (st.nations[targetSlot] && !st.nations[targetSlot].alive) returnSurvivors(room, targetSlot, survivors);
  }
}

function destroyNation(room, slot) {
  const st = room.friends;
  const n = st.nations[slot];
  if (!n || !n.alive) return;
  n.alive = false;
  n.castle.hp = 0;
  n.wall.hp = 0;
  n.army = emptyUnits();
  n.destroyedAt = st.time;
  delete st.sieges[slot];
  /* 이 성을 공격하던 부대는 귀환한다 */
  const siege = st.sieges;
  for (const targetId of Object.keys(siege)) {
    if (siege[targetId] && siege[targetId][slot]) delete siege[targetId][slot];
  }
  for (const m of st.marches) {
    if (m.to === slot && m.phase !== 'return') m.done = true;
    if (m.from === slot) m.done = true;
  }
  addLog(st, '🏰 ' + nameOf(st, slot) + '의 성이 무너졌습니다!', 'bad');
  notifyAll(st, '🏰 ' + nameOf(st, slot) + ' 멸망', 'bad');
  const alive = aliveNations(st);
  if (alive.length <= 1) {
    st.phase = 'over';
    st.over = {
      winner: alive.length === 1 ? alive[0].slot : -1,
      at: st.time,
      winnerName: alive.length === 1 ? alive[0].name : '무승부'
    };
    addLog(st, alive.length === 1 ? '👑 ' + alive[0].name + ' 님이 승리했습니다!' : '무승부', 'good');
    notifyAll(st, alive.length === 1 ? '👑 ' + alive[0].name + ' 승리!' : '무승부', 'good');
  }
}

/* 귀환 — 성을 부순 공격군은 남은 병력을 이끌고 자기 성으로 돌아온다 */
function returnSurvivors(room, targetSlot, attackers) {
  const st = room.friends;
  for (const a of attackers) {
    const home = st.nations[a.slot];
    if (!home || !home.alive) continue;
    const left = totalUnits(a.box.units);
    if (left < 1) continue;
    const travel = marchTravel(st.nations[targetSlot].pos, home.pos);
    st.marches.push({
      id: st.seq++,
      from: targetSlot,
      to: home.slot,
      phase: 'return',
      units: rebalanceUnits(a.box.units),
      total: left,
      departAt: st.time,
      arriveAt: st.time + travel,
      travel
    });
  }
}

function trainGarrison(nation, dt) {
  if (!nation.alive || nation.underAttack) return;
  if (nation.initialTotal <= 0) return;
  for (const k of UNIT_KEYS) {
    const target = num(nation.initial[k]);
    const cur = num(nation.army[k]);
    if (cur >= target) continue;
    const gain = target * CFG.trainFrac * dt;
    nation.army[k] = Math.min(target, cur + gain);
  }
}

/* ------------------------------------------------------------------ AI */
function aiSetup(nation) {
  const pool = ['balanced', 'attack', 'defense'];
  nation.setup = presetSetup(pool[Math.floor(Math.random() * pool.length)]);
  nation.ready = true;
}

function aiThink(room, nation) {
  const st = room.friends;
  if (st.phase === 'setup') { aiSetup(nation); return; }  if (st.phase !== 'battle') return;
  const others = st.nations.filter((n) => n && n.alive && n.slot !== nation.slot);
  if (!others.length) return;

  /* 가끔 약한 나라와 불가침을 제안한다 */
  if (Math.random() < 0.10) {
    const leader = others.slice().sort((a, b) => (b.castle.hp + b.wall.hp) - (a.castle.hp + a.wall.hp))[0];
    const r = relOf(st, nation.slot, leader.slot);
    if (leader && r.type === 'war' && !st.proposals.some((p) => p.from === nation.slot && p.to === leader.slot && p.pending)) {
      offerProposal(room, nation.slot, leader.slot, Math.random() < 0.25 ? 'ally' : 'truce');
    }
  }

  /* 군사를 보낸다 — 너무 적게 남았거나 이미 공성 중이면 쉰다 */
  const mySend = st.marches.filter((m) => m.from === nation.slot && m.phase === 'march').length;
  let mySiege = 0;
  for (const t of Object.keys(st.sieges)) {
    const box = st.sieges[t] && st.sieges[t][nation.slot];
    if (box) mySiege += totalUnits(box.units);
  }
  const total = totalUnits(nation.army);
  if (mySend >= 2 || mySiege > 40 || total < nation.initialTotal * 0.22) return;

  const targets = others.filter((n) => canAttack(st, nation.slot, n.slot));
  if (!targets.length) return;
  /* 이미 다른 나라가 공격 중인 성을 우선 노려 함께 무너뜨린다 (약한 성·가까운 성 우선) */
  targets.sort((a, b) => {
    const underA = st.sieges[a.slot] ? 1 : 0;
    const underB = st.sieges[b.slot] ? 1 : 0;
    if (underA !== underB) return underB - underA;
    const sa = (a.castle.hp + a.wall.hp * 0.8) / Math.max(1, dist(nation.pos, a.pos));
    const sb = (b.castle.hp + b.wall.hp * 0.8) / Math.max(1, dist(nation.pos, b.pos));
    return sa - sb;
  });
  const target = targets[0];
  const ratio = total > nation.initialTotal * 0.6 ? 0.75 : 0.6;
  const units = {};
  for (const k of UNIT_KEYS) units[k] = Math.floor(num(nation.army[k]) * ratio);
  if (totalUnits(units) < 5) return;
  sendMarch(room, { slot: nation.slot }, target.slot, units, 'attack');
}

function aheadOf(st, slot) {
  const others = st.nations.filter((n) => n && n.alive && n.slot !== slot);
  return others.length ? others.slice().sort((a, b) => (b.castle.hp + b.wall.hp) - (a.castle.hp + a.wall.hp))[0] : null;
}

/* ------------------------------------------------------------------ 외교 */
function offerProposal(room, from, to, kind) {
  const st = room.friends;
  if (kind !== 'truce' && kind !== 'ally') return { error: ['KIND', '알 수 없는 제안이에요.'] };
  if (from === to) return { error: ['SELF', '자기 자신과는 외교할 수 없어요.'] };
  const a = st.nations[from], b = st.nations[to];
  if (!a || !b || !a.alive || !b.alive) return { error: ['DEAD', '그 국가는 이미 무너졌어요.'] };
  const r = relOf(st, from, to);
  if (kind === 'ally' && r.type === 'ally') return { error: ['ALREADY', '이미 동맹이에요.'] };
  if (kind === 'truce' && (r.type === 'truce' || r.type === 'ally')) return { error: ['ALREADY', '이미 조약이 있어요.'] };
  const pending = st.proposals.find((p) => p.from === from && p.to === to && p.kind === kind && p.pending);
  if (pending) return { error: ['PENDING', '이미 제안을 보냈어요.'] };
  const p = {
    id: st.seq++,
    from,
    to,
    kind,
    pending: true,
    at: st.time,
    expires: st.time + 30,
    auto: st.nations[to] && st.nations[to].ai
  };
  st.proposals.push(p);
  addLog(st, nameOf(st, from) + ' → ' + nameOf(st, to) + ' · ' + (kind === 'ally' ? '동맹' : '불가침') + ' 제안', 'info');
  notifyAll(st, '🤝 ' + nameOf(st, from) + ' 님이 ' + nameOf(st, to) + ' 님에게 ' + (kind === 'ally' ? '동맹' : '불가침') + '을 제안', 'info');
  return { ok: true, proposal: p };
}

function answerProposal(room, player, id, accept) {
  const st = room.friends;
  const p = st.proposals.find((x) => x.id === Number(id) && x.pending);
  if (!p) return { error: ['NO_PROPOSAL', '제안을 찾을 수 없어요 (만료됐을 수 있어요).'] };
  if (p.to !== player.slot) return { error: ['NOT_YOURS', '내게 온 제안이 아니에요.'] };
  p.pending = false;
  p.answered = true;
  if (!accept) {
    addLog(st, nameOf(st, p.to) + ' 님이 ' + (p.kind === 'ally' ? '동맹' : '불가침') + ' 제안을 거절했습니다', 'info');
    notifyAll(st, nameOf(st, p.to) + ' 제안 거절', 'warn');
    return { ok: true };
  }
  const until = st.time + (p.kind === 'ally' ? 120 : 60);
  setRel(st, p.from, p.to, p.kind, until, 12);
  addLog(st, '🤝 ' + nameOf(st, p.from) + ' · ' + nameOf(st, p.to) + ' ' + (p.kind === 'ally' ? '동맹 체결' : '불가침 체결'), 'good');
  notifyAll(st, '🤝 ' + nameOf(st, p.from) + ' · ' + nameOf(st, p.to) + ' ' + (p.kind === 'ally' ? '동맹' : '불가침') + ' 체결', 'good');
  return { ok: true };
}

function declareWar(room, player, toSlot) {
  const st = room.friends;
  if (st.phase !== 'battle') return { error: ['PHASE', '전투 중에만 선전포고할 수 있어요.'] };
  const a = player.slot;
  const b = st.nations[toSlot];
  if (!b || !b.alive) return { error: ['NO_TARGET', '그 국가는 이미 무너졌어요.'] };
  const r = relOf(st, a, toSlot);
  setRel(st, a, toSlot, 'war', 0, r.type === 'war' ? 0 : -35);
  st.proposals.forEach((p) => {
    if (p.pending && ((p.from === a && p.to === toSlot) || (p.from === toSlot && p.to === a))) p.pending = false;
  });
  addLog(st, '⚔️ ' + nameOf(st, a) + ' 님이 ' + nameOf(st, toSlot) + '에 선전포고했습니다', 'warn');
  notifyAll(st, '⚔️ ' + nameOf(st, a) + ' → ' + nameOf(st, toSlot) + ' 선전포고', 'warn');
  return { ok: true };
}

/* AI가 받은 제안에 답한다 */
function aiAnswer(room, proposal) {
  const st = room.friends;
  const r = relOf(st, proposal.from, proposal.to);
  const acceptChance = proposal.kind === 'ally' ? 0.45 : 0.7;
  const accept = Math.random() < acceptChance && r.trust > 10;
  proposal.pending = false;
  proposal.answered = true;
  if (!accept) return;
  const until = st.time + (proposal.kind === 'ally' ? 120 : 60);
  setRel(st, proposal.from, proposal.to, proposal.kind, until, 10);
  addLog(st, '🤝 ' + nameOf(st, proposal.to) + ' 가 ' + (proposal.kind === 'ally' ? '동맹' : '불가침') + '을 수락했습니다', 'good');
  notifyAll(st, '🤝 ' + nameOf(st, proposal.from) + ' · ' + nameOf(st, proposal.to) + ' ' + (proposal.kind === 'ally' ? '동맹' : '불가침') + ' 체결', 'good');
}

/* ------------------------------------------------------------------ 진행 */
function step(room, nowMs) {
  const st = room.friends;
  if (!st) return;
  const now = nowMs || Date.now();
  const dtReal = st.lastTickAt ? Math.min(500, Math.max(0, now - st.lastTickAt)) : CFG.stepMs;
  st.lastTickAt = now;
  const dt = (dtReal / 1000) * (st.speed || 1);
  if (st.phase === 'setup') {
    st.time += dt;
    if (allHumansReady(room) && room.players.filter((p) => !p.isAI).length >= 1) beginBattle(st);
    else if (st.time >= st.setupEnds) beginBattle(st);
    /* AI 편성 */
    for (const n of st.nations) {
      if (n && n.ai && !n.ready) aiSetup(n);
    }
  } else if (st.phase === 'battle') {
    st.time += dt;
    relationExpire(st);
    /* 접속이 끊긴 사람 자리는 잠시 뒤 AI가 대신 조종한다 */
    for (const p of room.players) {
      const n = st.nations[p.slot];
      if (!n || p.isAI) continue;
      if (!p.connected) {
        if (!p.disconnectedAt) p.disconnectedAt = Date.now();
        if (!n.autoAI && Date.now() - p.disconnectedAt > 15000) {
          n.autoAI = true;
          addLog(st, n.name + ' 연결 끊김 · AI가 대신 지휘합니다', 'warn');
          notifyAll(st, n.name + ' 연결 끊김 · AI 지휘', 'warn');
        }
      } else if (n.autoAI) {
        n.autoAI = false;
        addLog(st, n.name + ' 님이 다시 지휘합니다', 'info');
      }
    }
    /* 제안 만료 */
    for (const p of st.proposals) if (p.pending && st.time >= p.expires) p.pending = false;
    /* 도착 */
    for (const m of st.marches) {
      if (!m.done && m.arriveAt <= st.time) arrive(room, m);
    }
    st.marches = st.marches.filter((m) => !m.done);
    /* 공성 해결 */
    for (const targetKey of Object.keys(st.sieges)) {
      resolveSiege(room, Number(targetKey), dt);
    }
    for (const n of st.nations) if (n && n.alive) n.underAttack = false;
    for (const targetKey of Object.keys(st.sieges)) {
      const n = st.nations[Number(targetKey)];
      if (n) n.underAttack = true;
    }
    /* 훈련 */
    for (const n of st.nations) if (n && n.alive) trainGarrison(n, dt);
    /* AI */
    for (const n of st.nations) {
      if (!n || !n.alive || (!n.ai && !n.autoAI)) continue;
      if (st.time >= n.nextAiAt) {
        n.nextAiAt = st.time + 3.5 + Math.random() * 3;
        try { aiThink(room, n); } catch (e) { console.error('[friends ai]', e); }
      }
    }
    /* AI 제안 응답 */
    for (const p of st.proposals) {
      if (!p.pending || !p.auto) continue;
      if (!p.answerAt) p.answerAt = st.time + 1.5 + Math.random() * 2.5;
      if (st.time >= p.answerAt) aiAnswer(room, p);
    }
    /* 성이 부서진 나라의 공성 잔당 정리 */
    for (const targetKey of Object.keys(st.sieges)) {
      const t = st.nations[Number(targetKey)];
      if (!t || !t.alive) { delete st.sieges[targetKey]; continue; }
      const siege = st.sieges[targetKey];
      if (!countSiegeUnits(siege)) delete st.sieges[targetKey];
    }
    /* 제한 시간 */
    if (st.phase === 'battle' && st.time >= CFG.battleLimitSec) {
      const alive = aliveNations(st);
      alive.sort((a, b) => (b.castle.hp / Math.max(1, b.castle.max) + b.wall.hp / Math.max(1, b.wall.max)) -
        (a.castle.hp / Math.max(1, a.castle.max) + a.wall.hp / Math.max(1, a.wall.max)));
      st.phase = 'over';
      st.over = { winner: alive[0] ? alive[0].slot : -1, at: st.time, winnerName: alive[0] ? alive[0].name : '무승부', timeLimit: true };
      notifyAll(st, '⏱️ 제한 시간 종료 · ' + (alive[0] ? alive[0].name + ' 우세 승' : '무승부'), 'warn');
    }
  }
  flushEvents(st, room);
  if (now >= (st.nextStateAt || 0)) {
    st.nextStateAt = now + CFG.stateMs;
    broadcastState(room);
  }
}

function stepRoom(room) {
  if (!room || room.closed || !room.friends) return;
  try {
    step(room, Date.now());
  } catch (err) {
    console.error('[friends step]', err);
  }
}

/* ------------------------------------------------------------------ 상태 */
function nationView(st, n, you) {
  const rel = you >= 0 ? relOf(st, you, n.slot) : { type: 'war' };
  return {
    slot: n.slot,
    name: n.name,
    ai: !!n.ai,
    alive: !!n.alive,
    ready: !!n.ready,
    autoAI: !!n.autoAI,
    castle: { hp: Math.max(0, Math.round(n.castle.hp)), max: n.castle.max },
    wall: { hp: Math.max(0, Math.round(n.wall.hp)), max: n.wall.max },
    army: unitsView(n.army),
    total: Math.round(totalUnits(n.army)),
    initialTotal: n.initialTotal,
    setupCost: n.setup ? Math.round(setupCost(n.setup)) : 0,
    setup: n.setup ? {
      units: n.setup.units,
      wallBonus: n.setup.wallBonus,
      castleBonus: n.setup.castleBonus,
      preset: n.setup.preset
    } : null,
    pos: { x: Math.round(n.pos.x * 10) / 10, z: Math.round(n.pos.z * 10) / 10 },
    underAttack: !!n.underAttack,
    rel: rel.type,
    relUntil: rel.until > st.time ? Math.ceil(rel.until - st.time) : 0,
    isYou: n.slot === you
  };
}

function stateView(room, slot) {
  const st = room.friends;
  const nations = st.nations.map((n) => nationView(st, n, slot));
  return {
    type: 'fstate',
    mode: 'castle',
    phase: st.phase,
    time: Math.round(st.time * 10) / 10,
    speed: st.speed,
    you: slot,
    host: room.hostSlot,
    capacity: st.capacity,
    aiFill: st.aiFill,
    budget: CFG.budget,
    setupLeft: st.phase === 'setup' ? Math.max(0, Math.ceil(st.setupEnds - st.time)) : 0,
    map: { radius: st.mapRadius || CFG.mapRadius },
    nations,
    marches: st.marches.map((m) => ({
      id: m.id, from: m.from, to: m.to, phase: m.phase,
      units: unitsView(m.units), total: Math.round(m.total),
      departAt: Math.round(m.departAt * 100) / 100,
      arriveAt: Math.round(m.arriveAt * 100) / 100,
      travel: Math.round(m.travel * 100) / 100
    })),
    sieges: Object.keys(st.sieges).map((t) => ({
      target: Number(t),
      attackers: Object.keys(st.sieges[t]).map((a) => ({
        slot: Number(a),
        units: unitsView(st.sieges[t][a].units),
        total: Math.round(totalUnits(st.sieges[t][a].units))
      }))
    })),
    proposals: st.proposals.filter((p) => p.pending).map((p) => ({
      id: p.id, from: p.from, to: p.to, kind: p.kind, auto: !!p.auto,
      left: Math.max(0, Math.ceil(p.expires - st.time))
    })),
    log: st.log.slice(-12),
    over: st.over
  };
}

function broadcastState(room, force) {
  const st = room.friends;
  if (!st) return;
  for (const p of room.players) {
    if (!p.ws || !p.connected || p.isAI) continue;
    send(p.ws, stateView(room, p.slot));
  }
}

/* ------------------------------------------------------------------ 메시지 */
function handleMessage(room, player, type, msg) {
  const st = room.friends;
  if (!st) return { error: ['NO_STATE', '방 정보를 찾을 수 없어요.'] };
  const host = player.slot === room.hostSlot;

  if (type === 'start') return startGame(room, player.slot);

  if (type === 'aiFill') {
    if (!host) return { error: ['HOST_ONLY', '방장만 바꿀 수 있어요.'] };
    if (st.phase !== 'lobby') return { error: ['PHASE', '이미 시작했어요.'] };
    st.aiFill = !!msg.value;
    broadcastLobby(room);
    return { ok: true };
  }

  if (type === 'capacity') {
    if (!host) return { error: ['HOST_ONLY', '방장만 바꿀 수 있어요.'] };
    if (st.phase !== 'lobby') return { error: ['PHASE', '이미 시작했어요.'] };
    const humans = room.players.filter((p) => !p.isAI).length;
    st.capacity = clamp(Math.floor(num(msg.value)) || st.capacity, Math.max(CFG.minPlayers, humans), CFG.maxPlayers);
    broadcastLobby(room);
    return { ok: true };
  }

  if (type === 'speed') {
    const v = num(msg.value);
    st.speed = v >= 2 ? 2 : 1;
    broadcastState(room, true);
    return { ok: true };
  }

  if (type === 'setup') {
    const out = setSetup(room, player, msg.setup || msg);
    broadcastState(room, true);
    return out;
  }

  if (type === 'ready') {
    const out = setReady(room, player, msg.value !== false);
    broadcastState(room, true);
    return out;
  }

  if (type === 'march') {
    const out = sendMarch(room, player, Number(msg.to), msg.units, msg.kind);
    broadcastState(room, true);
    return out;
  }

  if (type === 'diplo') {
    const action = msg.action;
    let out = { ok: true };
    if (action === 'offer') out = offerProposal(room, player.slot, Number(msg.to), msg.kind);
    else if (action === 'answer') out = answerProposal(room, player, msg.id, !!msg.accept);
    else if (action === 'war') out = declareWar(room, player, Number(msg.to));
    else out = { error: ['ACTION', '알 수 없는 외교 요청이에요.'] };
    broadcastState(room, true);
    return out;
  }

  if (type === 'rematch') {
    if (!host) return { error: ['HOST_ONLY', '방장만 다시 시작할 수 있어요.'] };
    if (st.phase !== 'over') return { error: ['PHASE', '아직 끝나지 않았어요.'] };
    /* 남은 사람들로 로비 복귀 */
    room.players = room.players.filter((p) => !p.isAI);
    room.players.sort((a, b) => a.slot - b.slot);
    room.players.forEach((p, i) => { p.slot = i; p.controlSlot = i; });
    room.hostSlot = room.players[0] ? room.players[0].slot : 0;
    room.started = false;
    room.friends = createState({ capacity: st.capacity, aiFill: st.aiFill });
    broadcastLobby(room);
    return { ok: true };
  }

  return { error: ['UNKNOWN', '알 수 없는 요청이에요.'] };
}

function sendState(room, player) {
  const st = room.friends;
  if (!st || !player) return;
  send(player.ws, stateView(room, player.slot));
  send(player.ws, lobbyPayload(room, player));
}

module.exports = {
  CFG,
  UNITS,
  UNIT_KEYS,
  PRESETS,
  addLog,
  notifyAll,
  createState,
  startGame,
  beginBattle,
  setSetup,
  setReady,
  sendMarch,
  offerProposal,
  answerProposal,
  declareWar,
  step,
  stepRoom,
  stateView,
  lobbyPayload,
  broadcastState,
  broadcastLobby,
  handleMessage,
  sendState,
  presetSetup,
  normalizeSetup,
  setupCost,
  totalUnits,
  canAttack,
  relOf,
  castlePos,
  mapRadiusFor,
  destroyNation,
  aliveNations
};
