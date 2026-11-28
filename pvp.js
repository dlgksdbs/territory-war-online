'use strict';

/* =============================================================================
   플레이어 PVP · 실시간 1인칭 대전 (서버 권위)
   -----------------------------------------------------------------------------
   · 방 만들기 / 코드 입장 → 대기실에서 팀(아군·적군) 선택, 병종은 일반 병사 고정
   · 방장이 원하면 AI 병력을 팀마다 섞는다 (없으면 순수 1:1 ~ 다인 PVP)
   · 전투: 클라이언트가 위치·시선·행동을 보내고, 서버가 실제 타격을 판정한다
       - 근접: 사거리·부채꼴 안의 상대에게 실제 피해, 정면 검 막기는 피해 0
       - 검 막기: 최대 유지 시간 + 쿨타임 (무한 막기 금지) — PVP 전용
       - 막아내면 공격한 상대에게 원래 피해의 100%를 반사 (패링)
       - 무대는 UFC 옥타곤 링 — 8각형 경계 밖으로 나갈 수 없다
       - 💥 PVP 전용 밸런스: 최대 체력 1000 · 기본 공격력 100 · 회복 없음
         (자연 회복 0, 적중 흡혈 0 — 체력이 늘어나는 곳은 부활뿐이다)
   · 승리: 설정한 킬 수 도달 또는 전멸전 / 제한 시간 종료 시 킬 수 우세
   · 재대결: 방장이 다시 시작하면 같은 팀·병종으로 곧바로 새 라운드
   ============================================================================= */

const CLASS_KEYS = ['soldier', 'elite', 'knight', 'wizard', 'blademaster', 'berserker'];

/* ⚔️ 플레이어 근접 사거리 보정 — 클라이언트 public/src/config.js 의 PLAYER_REACH_BONUS 와
   반드시 같은 값이어야 한다 (빨간 조준점과 실제 타격 판정이 정확히 일치).
   2026-11-28 "닿는 범위 좀 더 넓히자" — 0.45 → 0.85 */
const PVP_REACH_BONUS = 0.85;
const PVP_ARC_BONUS = 0.3;

/* ⚔️ PVP 는 일반 병사 고정 — 순수 검술·막기 대전 (솔로 배틀 아레나는 6병종 그대로) */
const FIXED_CLASS = 'soldier';

/* 💥 PVP 전용 밸런스 (2026-11-28 사용자 지시: "체력 1000 공격 100 회복 없음. Pvp만")
   · 체력 1000 · 기본 공격력 100 → 열 대를 맞아야 쓰러지고, 막기 100% 반사도 100
   · 회복 없음: 자연 회복 0 · 적중 흡혈 0 (부활할 때만 최대 체력으로 돌아온다)
   · 솔로 배틀 아레나(6병종)와 /classic/ 은 이 값을 쓰지 않는다 */
const PVP_HP = 1000;
const PVP_DAMAGE = 100;
const PVP = {
  soldier: { key: 'soldier', name: '일반 병사', icon: '⚔️', hp: PVP_HP, damage: PVP_DAMAGE, cycle: 0.62, speed: 4.15, reach: 2.05, arc: 1.95, armor: 0, radius: 0.38, guard: true, maxTargets: 1, mass: 1 },
  elite: { key: 'elite', name: '고급 병사', icon: '🛡️', hp: 680, damage: 118, cycle: 0.56, speed: 4.57, reach: 2.12, arc: 1.95, armor: 0.04, radius: 0.39, guard: true, maxTargets: 1, mass: 1.06 },
  knight: { key: 'knight', name: '중갑 기사', icon: '🔨', hp: 1650, damage: 320, cycle: 1.0, speed: 3.3, reach: 2.9, arc: 2.35, armor: 0.15, radius: 0.52, guard: false, maxTargets: 100, mass: 2.4 },
  wizard: { key: 'wizard', name: '대마법사', icon: '🔮', hp: 540, damage: 30, cycle: 0.86, speed: 2.31, reach: 1.9, arc: 1.6, armor: 0, radius: 0.36, guard: false, maxTargets: 1, mass: 0.85 },
  blademaster: { key: 'blademaster', name: '매화 검객', icon: '🌸', hp: 820, damage: 90, cycle: 0.30, speed: 5.4, reach: 2.35, arc: 2.3, armor: 0.03, radius: 0.38, guard: true, maxTargets: 10, mass: 0.95 },
  berserker: { key: 'berserker', name: '단검 광전사', icon: '🩸', hp: 1500, damage: 55, cycle: 0.25, speed: 5.0, reach: 1.85, arc: 2.05, armor: 0.06, radius: 0.44, guard: false, maxTargets: 1, mass: 1.45 }
};

const SPELLS = {
  fire: { key: 'fire', name: '화염구', icon: '🔥', cooldown: 3.8, damage: 260, radius: 3.5, range: 19 },
  lightning: { key: 'lightning', name: '연쇄 번개', icon: '⚡', cooldown: 6.6, damage: 205, jumps: 4, falloff: 0.78, range: 17 },
  ice: { key: 'ice', name: '빙결 파동', icon: '❄️', cooldown: 8.6, damage: 190, radius: 7.4, halfAngle: Math.PI / 3.1, freeze: 1.2 }
};

const SKILL = { key: 'petal', name: '매화 일섬', cooldown: 5.0, damage: 300, radius: 2.8, dash: 7.2 };

const CFG = {
  minPlayers: 1,
  maxPlayers: 8,
  arenaR: 26,
  spawnBase: 4.5,
  spawnStep: 1.5,
  spawnMax: 16,
  stateMs: 50,
  respawnMs: 3000,
  roundMs: 180000,
  killTarget: 10,
  botMaxPerTeam: 4,
  botDamageMul: 0.75,        // AI 병력 공격력 배율
  botSpeedMul: 0.95,
  botNames: ['AI 병사', 'AI 창병', 'AI 궁병', 'AI 검병'],
  guardFront: 1.35,
  /* 🛡️ PVP 검 막기 — 최대 유지 + 쿨타임 (솔로 배틀 아레나의 막기에는 적용하지 않는다) */
  guardHold: 1.0,            // 한 번만 눌러도 유지되는 시간 (초) — 탭 한 번에 1초 막기
  guardCooldown: 2.0,        // 막기 해제·자동 종료 뒤 쿨타임 (초)
  guardReflect: 1.0,         // 막아내면 공격자에게 돌려주는 피해 비율 (100%)
  /* 🥊 UFC 옥타곤 링 — 중심에서 각 변까지의 거리 (m), 이동 가능 경계 */
  octApothem: 15.0,
  /* 💥 PVP 는 회복 없음 — 자연 회복·적중 흡혈 둘 다 0 (부활 말고는 체력이 차지 않는다) */
  regenFrac: 0,
  lifestealFrac: 0,
  lifestealMin: 0,
  lifestealCapFrac: 0,
  lifestealCapMin: 0
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const norm = (a) => {
  let x = Number(a) || 0;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};
const angDiff = (a, b) => norm(a - b);

/* ------------------------------------------------------------------ 옥타곤 링
   정8각형 경계 — 변의 법선이 45° 간격. apothem(중심→변) 기준으로 방향별 경계
   반지름을 구해 그 밖으로 나가면 경계 위로 되돌린다 (클라이언트 ground.js 와 동일). */
const OCT_STEP = Math.PI / 4;
function octRadius(phi, apothem) {
  const t = ((phi % OCT_STEP) + OCT_STEP) % OCT_STEP - OCT_STEP / 2;
  return apothem / Math.cos(t);
}
function clampOctagon(x, z, apothem) {
  const a = apothem === undefined ? CFG.octApothem : apothem;
  const r = Math.hypot(x, z);
  if (r < 1e-6) return { x: 0, z: 0, hit: false };
  const R = octRadius(Math.atan2(x, z), a);
  if (r <= R) return { x, z, hit: false };
  const k = R / r;
  return { x: x * k, z: z * k, hit: true };
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ }
}

function broadcastEvent(room, obj) {
  for (const p of room.players) {
    if (!p.ws || !p.connected) continue;
    send(p.ws, obj);
  }
}

function addLog(st, text, kind) {
  st.log.push({ at: Date.now(), text, kind: kind || 'info' });
  if (st.log.length > 30) st.log.splice(0, st.log.length - 30);
}

/* ------------------------------------------------------------------ 상태 */
function createState(opts) {
  const o = opts || {};
  return {
    capacity: clamp(Math.floor(Number(o.capacity) || CFG.maxPlayers) || CFG.maxPlayers, 1, CFG.maxPlayers),
    phase: 'lobby',                 // lobby | battle | over
    mode: 'kills',                  // kills | elim
    killTarget: CFG.killTarget,
    botCfg: { ally: 0, enemy: 0 },  // 대기실에서 방장이 정하는 AI 병력 수
    ents: new Map(),                // slot -> 참가자 전투 개체
    bots: [],                       // 전투 중 AI 병력 개체
    score: { ally: 0, enemy: 0 },
    over: null,
    roundEndsAt: 0,
    startedAt: 0,
    lastStateAt: 0,
    lastStepAt: 0,
    pending: [],                    // 날아가는 화염구 (도착 시점에 피해)
    log: []
  };
}

function makeEnt(player) {
  const spec = PVP.soldier;
  return {
    slot: player.slot,
    id: 'p' + player.slot,
    name: player.name,
    bot: false,
    team: null,
    cls: FIXED_CLASS,
    x: 0, z: 0, yaw: 0, pitch: 0,
    hp: spec.hp, maxHp: spec.hp,
    dead: false, deathAt: 0, respawnAt: 0,
    guard: false, guardAt: 0, guardUntil: 0, guardCdUntil: 0,
    kills: 0, deaths: 0,
    attackAt: 0,
    nextAttackAt: 0,
    nextSpellAt: { fire: 0, lightning: 0, ice: 0 },
    nextSkillAt: 0,
    freezeUntil: 0,
    lastInputAt: 0,
    lastSwing: 0,
    lsDone: 0,
    connected: !!player.connected
  };
}

function entOf(st, player) {
  let e = st.ents.get(player.slot);
  if (!e) {
    e = makeEnt(player);
    st.ents.set(player.slot, e);
  }
  e.name = player.name;
  e.connected = !!player.connected;
  return e;
}

/* PVP 참가자는 언제나 일반 병사 — 요청이 무엇이든 soldier 로 맞춘다 */
function applyClass(ent) {
  const spec = PVP[FIXED_CLASS] || PVP.soldier;
  ent.cls = spec.key;
  ent.maxHp = spec.hp;
  ent.hp = spec.hp;
}

function allFighters(st) {
  const list = [];
  for (const e of st.ents.values()) list.push(e);
  for (const b of st.bots) list.push(b);
  return list;
}

function aliveOf(st, team) {
  let n = 0;
  for (const e of st.ents.values()) if (e.team === team && !e.dead) n++;
  for (const b of st.bots) if (b.team === team && !b.dead) n++;
  return n;
}

function spawnPoint(st, team, index, count) {
  const d = clamp(CFG.spawnBase + Math.max(0, count - 1) * CFG.spawnStep, CFG.spawnBase, CFG.spawnMax);
  const span = Math.max(1, count - 1) * 1.7;
  const x = count > 1 ? (index - (count - 1) / 2) * (span / Math.max(1, count - 1)) : 0;
  const p = clampOctagon(x, team === 'ally' ? -d : d);   // 🥊 옥타곤 안쪽으로
  return { x: p.x, z: p.z };
}

/* ------------------------------------------------------------------ 로비 */
function lobbyPayload(room, player) {
  const st = room.pvp;
  const players = room.players.filter((p) => !p.isAI).map((p) => {
    const e = entOf(st, p);
    return {
      slot: p.slot, name: p.name, team: e.team, cls: FIXED_CLASS,
      host: p.slot === room.hostSlot, connected: !!p.connected
    };
  });
  return {
    type: 'plobby',
    code: room.code,
    host: room.hostSlot,
    you: player ? player.slot : -1,
    phase: st.phase,
    mode: st.mode,
    killTarget: st.killTarget,
    bots: { ...st.botCfg },
    minPlayers: CFG.minPlayers,
    maxPlayers: st.capacity,
    players,
    fixedClass: FIXED_CLASS,
    /* 💥 PVP 전용 밸런스 — 대기실 안내문이 이 값을 그대로 보여 준다 */
    rules: { hp: PVP_HP, damage: PVP_DAMAGE, regen: CFG.regenFrac, lifesteal: CFG.lifestealFrac, reflect: CFG.guardReflect },
    guard: { hold: CFG.guardHold * 1000, cooldown: CFG.guardCooldown * 1000, reflect: CFG.guardReflect },
    arena: { type: 'octagon', apothem: CFG.octApothem },
    classes: CLASS_KEYS.map((k) => ({ key: k, name: PVP[k].name, icon: PVP[k].icon, hp: PVP[k].hp, damage: PVP[k].damage, guard: PVP[k].guard !== false })),
    spells: Object.fromEntries(Object.keys(SPELLS).map((k) => [k, { name: SPELLS[k].name, icon: SPELLS[k].icon, cooldown: SPELLS[k].cooldown, damage: SPELLS[k].damage }])),
    skill: { name: SKILL.name, cooldown: SKILL.cooldown, damage: SKILL.damage }
  };
}

function broadcastLobby(room) {
  if (!room.pvp) return;
  for (const p of room.players) {
    if (!p.ws || !p.connected || p.isAI) continue;
    send(p.ws, lobbyPayload(room, p));
  }
}

function setTeam(room, player, raw) {
  const st = room.pvp;
  if (!st || st.phase !== 'lobby') return { error: ['PHASE', '지금은 팀을 바꿀 수 없어요.'] };
  const e = entOf(st, player);
  const t = String(raw || '');
  if (t !== 'ally' && t !== 'enemy' && t !== 'auto') return { error: ['BAD_TEAM', '팀을 다시 골라 주세요.'] };
  e.team = t === 'auto' ? null : t;
  broadcastLobby(room);
  return { ok: true };
}

/* ⚔️ PVP 병종은 일반 병사 고정 — 다른 병종을 보내도 soldier 로 되돌린다 */
function setClass(room, player, raw) {
  const st = room.pvp;
  if (!st) return { error: ['NO_STATE', '방 정보를 찾을 수 없어요.'] };
  if (st.phase !== 'lobby') return { error: ['PHASE', '병종은 대기실에서만 바꿀 수 있어요.'] };
  const cls = String(raw || '');
  if (!PVP[cls]) return { error: ['BAD_CLASS', '없는 병종이에요.'] };
  const e = entOf(st, player);
  applyClass(e, FIXED_CLASS);
  broadcastLobby(room);
  return { ok: true, cls: FIXED_CLASS, fixed: cls !== FIXED_CLASS };
}

function setConfig(room, player, msg) {
  const st = room.pvp;
  if (!st || st.phase !== 'lobby') return { error: ['PHASE', '지금은 설정을 바꿀 수 없어요.'] };
  if (player.slot !== room.hostSlot) return { error: ['HOST_ONLY', '방장만 설정을 바꿀 수 있어요.'] };
  if (msg.mode === 'kills' || msg.mode === 'elim') st.mode = msg.mode;
  if (msg.killTarget !== undefined) {
    const k = Math.floor(Number(msg.killTarget));
    /* ⚔️ 1킬부터 — 단판 승부도 고를 수 있다 (예전엔 3킬이 최소) */
    if (Number.isFinite(k)) st.killTarget = clamp(k, 1, 30);
  }
  if (msg.bots && typeof msg.bots === 'object') {
    for (const t of ['ally', 'enemy']) {
      const n = Math.floor(Number(msg.bots[t]));
      if (Number.isFinite(n)) st.botCfg[t] = clamp(n, 0, CFG.botMaxPerTeam);
    }
  }
  broadcastLobby(room);
  return { ok: true };
}

/* 자동 배정 — 팀을 고르지 않은 사람을 인원이 적은 쪽부터 채운다 */
function assignTeams(room) {
  const st = room.pvp;
  const humans = room.players.filter((p) => !p.isAI);
  for (const p of humans) {
    const e = entOf(st, p);
    if (e.team !== 'ally' && e.team !== 'enemy') e.team = null;
  }
  for (const p of humans) {
    const e = entOf(st, p);
    if (e.team) continue;
    const allyN = humans.filter((q) => entOf(st, q).team === 'ally').length + st.botCfg.ally;
    const enemyN = humans.filter((q) => entOf(st, q).team === 'enemy').length + st.botCfg.enemy;
    e.team = allyN <= enemyN ? 'ally' : 'enemy';
  }
}

function makeBots(st, team, n) {
  const at = st.bots.filter((b) => b.team === team).length;
  for (let i = 0; i < n; i++) {
    const spec = PVP.soldier;
    st.bots.push({
      slot: null,
      id: 'b' + team + (at + i),
      name: CFG.botNames[(at + i) % CFG.botNames.length] + ' ' + (at + i + 1),
      bot: true,
      team,
      cls: 'soldier',
      x: 0, z: 0, yaw: team === 'ally' ? 0 : Math.PI, pitch: 0,
      hp: spec.hp, maxHp: spec.hp,
      dead: false, deathAt: 0, respawnAt: 0,
      guard: false,
      kills: 0, deaths: 0,
      attackAt: 0, nextAttackAt: 0,
      freezeUntil: 0,
      nextSpellAt: { fire: 0, lightning: 0, ice: 0 }, nextSkillAt: 0,
      lastSwing: 0, lsDone: 0
    });
  }
}

function startBattle(room, opts) {
  const st = room.pvp;
  if (!st) return { error: ['NO_STATE', '방 정보를 찾을 수 없어요.'] };
  const o = opts || {};
  if (!o.rematch && st.phase !== 'lobby') return { error: ['ALREADY', '이미 시작했어요.'] };
  if (o.rematch && st.phase !== 'over') return { error: ['PHASE', '아직 대전이 끝나지 않았어요.'] };
  const humans = room.players.filter((p) => !p.isAI);
  if (!o.rematch && o.bySlot !== undefined && o.bySlot !== room.hostSlot) {
    return { error: ['HOST_ONLY', '방장만 시작할 수 있어요.'] };
  }
  if (o.rematch && o.bySlot !== undefined && o.bySlot !== room.hostSlot) {
    return { error: ['HOST_ONLY', '방장만 다시 시작할 수 있어요.'] };
  }
  if (!humans.length) return { error: ['NO_PLAYER', '참가자가 없어요.'] };

  assignTeams(room);
  for (const p of humans) applyClass(entOf(st, p));   // ⚔️ 전원 일반 병사로 고정
  const allyHumans = humans.filter((p) => entOf(st, p).team === 'ally').length;
  const enemyHumans = humans.filter((p) => entOf(st, p).team === 'enemy').length;
  if (!(allyHumans + st.botCfg.ally) || !(enemyHumans + st.botCfg.enemy)) {
    return { error: ['NEED_BOTH', '양 팀에 각각 1명 이상 있어야 시작할 수 있어요. (AI 병력을 섞어도 됩니다)'] };
  }

  room.started = true;
  st.phase = 'battle';
  st.score = { ally: 0, enemy: 0 };
  st.over = null;
  st.pending = [];
  st.startedAt = Date.now();
  st.roundEndsAt = st.startedAt + CFG.roundMs;
  st.lastStateAt = 0;
  st.bots = [];
  for (const t of ['ally', 'enemy']) if (st.botCfg[t] > 0) makeBots(st, t, st.botCfg[t]);

  const allyList = humans.filter((p) => entOf(st, p).team === 'ally');
  const enemyList = humans.filter((p) => entOf(st, p).team === 'enemy');
  const allyCount = allyList.length + st.botCfg.ally;
  const enemyCount = enemyList.length + st.botCfg.enemy;
  let ai = 0;
  const place = (ent, team, index, count) => {
    const sp = spawnPoint(st, team, index, count);
    ent.x = sp.x; ent.z = sp.z;
    ent.yaw = team === 'ally' ? 0 : Math.PI;
    ent.pitch = 0;
    ent.hp = ent.maxHp;
    ent.dead = false; ent.deathAt = 0; ent.respawnAt = 0;
    ent.guard = false; ent.guardAt = 0; ent.guardUntil = 0; ent.guardCdUntil = 0;
    ent.attackAt = 0;
    ent.nextAttackAt = 0; ent.nextSkillAt = 0;
    ent.nextSpellAt = { fire: 0, lightning: 0, ice: 0 };
    ent.freezeUntil = 0;
    ent.kills = 0; ent.deaths = 0;
    ent.lastInputAt = 0; ent.lastSwing = 0; ent.lsDone = 0;
  };
  allyList.forEach((p, i) => place(entOf(st, p), 'ally', i, allyCount));
  enemyList.forEach((p, i) => place(entOf(st, p), 'enemy', i, enemyCount));
  for (const team of ['ally', 'enemy']) {
    const list = st.bots.filter((b) => b.team === team);
    const total = list.length + (team === 'ally' ? allyList.length : enemyList.length);
    list.forEach((b, i) => place(b, team, i + (team === 'ally' ? allyList.length : enemyList.length), total));
  }
  ai += st.bots.length;

  const roster = [
    ...humans.map((p) => {
      const e = entOf(st, p);
      return { s: e.slot, name: p.name, team: e.team, cls: e.cls, bot: false };
    }),
    ...st.bots.map((b) => ({ s: b.id, name: b.name, team: b.team, cls: b.cls, bot: true }))
  ];
  const payload = {
    type: 'pstart',
    code: room.code,
    you: null,
    rematch: !!o.rematch,
    mode: st.mode,
    killTarget: st.killTarget,
    roundMs: CFG.roundMs,
    rules: { hp: PVP_HP, damage: PVP_DAMAGE, regen: CFG.regenFrac, lifesteal: CFG.lifestealFrac, reflect: CFG.guardReflect },
    arenaR: CFG.arenaR,
    respawnMs: CFG.respawnMs,
    guard: { hold: CFG.guardHold * 1000, cooldown: CFG.guardCooldown * 1000, reflect: CFG.guardReflect },
    arena: { type: 'octagon', apothem: CFG.octApothem },
    roster
  };
  for (const p of humans) {
    const e = entOf(st, p);
    if (!p.ws || !p.connected) continue;
    send(p.ws, Object.assign({}, payload, { you: e.slot, team: e.team, cls: e.cls, spawn: { x: e.x, z: e.z, yaw: e.yaw } }));
  }
  addLog(st, '플레이어 PVP 시작 · ' + allyCount + ' vs ' + enemyCount + (ai ? ' (AI ' + ai + ')' : ''), 'good');
  broadcastState(room, true);
  return { ok: true };
}

/* ------------------------------------------------------------------ 전투 */
function healFromLifesteal(src, dealt, now) {
  /* 💥 PVP 는 흡혈 없음 — 배율이 0이면 회복 자체를 하지 않는다 */
  if (!(CFG.lifestealFrac > 0)) return 0;
  if (!src || !(dealt > 0) || src.dead) return 0;
  const maxHp = src.maxHp || 0;
  if (!(maxHp > 0) || !(src.hp > 0) || src.hp >= maxHp) return 0;
  if (src.lsAt !== src.attackAt) {
    src.lsAt = src.attackAt;
    src.lsDone = 0;
  }
  const cap = Math.max(CFG.lifestealCapMin, maxHp * CFG.lifestealCapFrac);
  const want = Math.max(CFG.lifestealMin, dealt * CFG.lifestealFrac);
  const heal = Math.min(want, cap - (src.lsDone || 0), maxHp - src.hp);
  if (!(heal > 0)) return 0;
  src.hp = Math.min(maxHp, src.hp + heal);
  src.lsDone = (src.lsDone || 0) + heal;
  return heal;
}

function targetRef(e) {
  return e.bot ? e.id : e.slot;
}

function hurt(room, st, target, amount, src, kind, from) {
  if (!target || target.dead || st.phase !== 'battle') return 0;
  /* 🛡️ NaN·음수 피해는 버린다 (클라이언트가 보낸 이상한 값으로 체력이 NaN 이 되면 방이 터진다) */
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(target.hp) || !Number.isFinite(target.maxHp)) { target.hp = target.maxHp = PVP_HP; }
  const spec = PVP[target.cls] || PVP.soldier;
  const sx = from && from.x !== undefined ? from.x : (src ? src.x : null);
  const sz = from && from.z !== undefined ? from.z : (src ? src.z : null);
  /* 반사 피해는 다시 막을 수 없다 (무한 되튀김 방지) */
  if (kind !== 'reflect' && target.guard && spec.guard !== false && sx !== null && sz !== null) {
    const a = Math.abs(angDiff(Math.atan2(sx - target.x, sz - target.z), target.yaw));
    if (a < CFG.guardFront) {
      /* 🛡️ 정면 검 막기 성공 — 수비자는 0, 공격자는 원래 피해의 100% 를 그대로 돌려받는다 */
      const reflect = src && src !== target && !src.dead ? Math.round(amount * CFG.guardReflect) : 0;
      broadcastEvent(room, {
        type: 'pblock',
        by: src ? targetRef(src) : null,
        to: targetRef(target),
        heavy: kind === 'hammer' || kind === 'petal' || kind === 'fire' || kind === 'ice' || kind === 'lightning',
        reflect,
        x: r2(target.x + Math.sin(target.yaw) * 0.45),
        z: r2(target.z + Math.cos(target.yaw) * 0.45),
        y: 1.2
      });
      if (reflect > 0) hurt(room, st, src, reflect, target, 'reflect');
      return 0;
    }
  }
  const dmg = amount * (1 - (spec.armor || 0));
  target.hp -= dmg;
  if (kind !== 'reflect') healFromLifesteal(src, dmg, Date.now());
  const lethal = target.hp <= 0;
  const hx = src ? (src.x + target.x) / 2 : target.x;
  const hz = src ? (src.z + target.z) / 2 : target.z;
  broadcastEvent(room, {
    type: 'phit',
    by: src ? targetRef(src) : null,
    to: targetRef(target),
    dmg: r2(dmg),
    kind: kind || 'blade',
    lethal,
    hp: Math.max(0, r2(target.hp)),
    mx: target.maxHp,
    hx: r2(hx), hz: r2(hz), hy: 1.1,
    angle: src ? Math.atan2(target.x - src.x, target.z - src.z) : target.yaw
  });
  if (lethal) killEnt(room, st, target, src, kind);
  return dmg;
}

function killEnt(room, st, target, src, kind) {
  const now = Date.now();
  target.hp = 0;
  target.dead = true;
  target.deathAt = now;
  target.guard = false;
  target.attackAt = 0;
  target.deaths = (target.deaths || 0) + 1;
  if (src) src.kills = (src.kills || 0) + 1;
  const winTeam = src && src.team ? src.team : (target.team === 'ally' ? 'enemy' : 'ally');
  if (src && src.team && src.team !== target.team) st.score[src.team] = (st.score[src.team] || 0) + 1;
  broadcastEvent(room, {
    type: 'pdeath',
    to: targetRef(target),
    by: src ? targetRef(src) : null,
    kind: kind || 'blade',
    x: r2(target.x), z: r2(target.z), team: target.team
  });
  addLog(st, (src ? src.name : '?') + ' → ' + target.name + ' 처치', 'warn');
  if (st.mode === 'kills') {
    target.respawnAt = now + CFG.respawnMs;
    if (st.score[winTeam] >= st.killTarget) endRound(room, st, winTeam, 'target');
  } else {
    target.respawnAt = 0;
    const a = aliveOf(st, 'ally'), b = aliveOf(st, 'enemy');
    if (a === 0 && b === 0) endRound(room, st, 'draw', 'wipe');
    else if (a === 0) endRound(room, st, 'enemy', 'wipe');
    else if (b === 0) endRound(room, st, 'ally', 'wipe');
  }
}

function endRound(room, st, winner, reason) {
  if (st.phase !== 'battle') return;
  st.phase = 'over';
  st.over = { winner, reason, at: Date.now(), score: { ...st.score } };
  st.pending = [];
  for (const e of allFighters(st)) {
    e.respawnAt = 0;
    e.guard = false;
    e.attackAt = 0;
  }
  addLog(st, '대전 종료 · ' + (winner === 'draw' ? '무승부' : winner === 'ally' ? '아군 승리' : '적군 승리'), 'good');
  broadcastEvent(room, {
    type: 'pover',
    winner,
    reason,
    score: { ...st.score },
    killTarget: st.killTarget,
    mode: st.mode
  });
  broadcastState(room, true);
}

function respawnEnt(room, st, e) {
  const team = e.team;
  const list = allFighters(st).filter((x) => x.team === team && x !== e && !x.dead);
  const sp = spawnPoint(st, team, list.length, list.length + 1);
  e.x = sp.x; e.z = sp.z;
  e.yaw = team === 'ally' ? 0 : Math.PI;
  e.pitch = 0;
  e.hp = e.maxHp;
  e.dead = false;
  e.deathAt = 0;
  e.respawnAt = 0;
  e.attackAt = 0;
  e.guard = false;
  e.guardAt = 0; e.guardUntil = 0; e.guardCdUntil = 0;
  e.nextAttackAt = 0;
  e.freezeUntil = 0;
  broadcastEvent(room, {
    type: 'prespawn',
    to: targetRef(e),
    x: r2(e.x), z: r2(e.z), yaw: r3(e.yaw), hp: e.maxHp, mx: e.maxHp
  });
}

/* ------------------------------------------------------------------ 검 막기 */
/* 🛡️ PVP 전용 막기 — 최대 유지(guardHold) 뒤 자동 해제 + 쿨타임(guardCooldown).
   쿨타임 중 다시 누르면 서버가 거절한다 (무한 막기·연타 막기 방지). */
function setGuard(room, player, on) {
  const st = room && room.pvp;
  if (!st || !player || st.phase !== 'battle') return { ok: false };
  const e = st.ents.get(player.slot);
  if (!e || e.dead) return { ok: false };
  const now = Date.now();
  if (on) {
    if (e.guard) return { ok: true, guard: true };
    const cd = Math.max(0, (e.guardCdUntil || 0) - now);
    if (cd > 0) return { ok: false, guard: false, cd: Math.ceil(cd) };
    const spec = PVP[e.cls] || PVP.soldier;
    if (spec.guard === false) return { ok: false, guard: false };
    e.guard = true;
    e.guardAt = now;
    e.guardUntil = now + CFG.guardHold * 1000;
    return { ok: true, guard: true };
  }
  if (e.guard) {
    e.guard = false;
    e.guardUntil = 0;
    e.guardCdUntil = now + CFG.guardCooldown * 1000;
    broadcastEvent(room, { type: 'pguardend', to: targetRef(e), cd: Math.round(CFG.guardCooldown * 1000), held: false });
  }
  return { ok: true, guard: false };
}

function input(room, player, msg) {
  const st = room.pvp;
  if (!st || st.phase !== 'battle') return;
  const e = st.ents.get(player.slot);
  if (!e || e.dead) return;
  const now = Date.now();
  const yaw = num(msg.yaw);
  const pitch = num(msg.pitch);
  if (Number.isFinite(yaw)) e.yaw = norm(yaw);
  if (Number.isFinite(pitch)) e.pitch = clamp(pitch, -1.2, 0.9);
  if (e.freezeUntil > now) { e.lastInputAt = now; return; }
  let x = num(msg.x), z = num(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const rad = Math.hypot(x, z);
  if (rad > CFG.arenaR) { x *= CFG.arenaR / rad; z *= CFG.arenaR / rad; }
  const dt = clamp((now - (e.lastInputAt || now)) / 1000, 0.02, 0.6);
  const maxD = (PVP[e.cls] || PVP.soldier).speed * 1.45 * dt + 0.5;
  const d = Math.hypot(x - e.x, z - e.z);
  if (d > maxD) {
    const k = maxD / d;
    x = e.x + (x - e.x) * k;
    z = e.z + (z - e.z) * k;
  }
  e.x = x; e.z = z;
  /* 🥊 옥타곤 링 밖으로는 나갈 수 없다 */
  const c = clampOctagon(e.x, e.z);
  e.x = c.x; e.z = c.z;
  e.lastInputAt = now;
}

function attack(room, player, msg) {
  const st = room.pvp;
  if (!st || st.phase !== 'battle') return;
  const e = st.ents.get(player.slot);
  if (!e || e.dead) return;
  const now = Date.now();
  const spec = PVP[e.cls] || PVP.soldier;
  if (now < e.nextAttackAt) return;
  e.nextAttackAt = now + spec.cycle * 1000 * 0.9;
  /* ⚔️ 막기 유지 중에 베면 막기가 즉시 풀린다 — 해제 시점부터 쿨타임 시작 */
  if (e.guard) {
    e.guard = false;
    e.guardUntil = 0;
    e.guardCdUntil = now + CFG.guardCooldown * 1000;
    broadcastEvent(room, { type: 'pguardend', to: targetRef(e), cd: Math.round(CFG.guardCooldown * 1000), held: false });
  }
  e.attackAt = now;
  e.lsAt = -1;
  let yaw = num(msg.yaw);
  if (!Number.isFinite(yaw) || Math.abs(angDiff(yaw, e.yaw)) > 0.7) yaw = e.yaw;
  e.yaw = yaw;
  const reach = spec.reach + PVP_REACH_BONUS;
  const arc = spec.arc + PVP_ARC_BONUS;
  const hits = [];
  for (const o of allFighters(st)) {
    if (o === e || o.dead || o.team === e.team) continue;
    const dx = o.x - e.x, dz = o.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d > reach + (PVP[o.cls] || PVP.soldier).radius) continue;
    if (Math.abs(angDiff(Math.atan2(dx, dz), yaw)) > arc) continue;
    hits.push({ o, d });
  }
  hits.sort((a, b) => a.d - b.d);
  const max = spec.maxTargets || 1;
  for (let i = 0; i < hits.length && i < max; i++) {
    hurt(room, st, hits[i].o, spec.damage, e, e.cls === 'knight' ? 'hammer' : e.cls === 'berserker' ? 'stab' : 'blade');
  }
  broadcastEvent(room, { type: 'pswing', s: targetRef(e), a: now });
}

function castSpell(room, player, msg) {
  const st = room.pvp;
  if (!st || st.phase !== 'battle') return;
  const e = st.ents.get(player.slot);
  if (!e || e.dead || e.cls !== 'wizard') return;
  const key = String(msg.key || '');
  const sp = SPELLS[key];
  if (!sp) return;
  const now = Date.now();
  if (now < (e.nextSpellAt[key] || 0)) return;
  e.nextSpellAt[key] = now + sp.cooldown * 1000;
  e.attackAt = now;
  broadcastEvent(room, { type: 'pspellfx', spell: key, by: targetRef(e), x: r2(e.x), z: r2(e.z), yaw: r3(e.yaw) });

  if (key === 'fire') {
    let tx = num(msg.x), tz = num(msg.z);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) {
      tx = e.x + Math.sin(e.yaw) * 10;
      tz = e.z + Math.cos(e.yaw) * 10;
    }
    let dx = tx - e.x, dz = tz - e.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    if (dist > sp.range) { tx = e.x + (dx / dist) * sp.range; tz = e.z + (dz / dist) * sp.range; dx = tx - e.x; dz = tz - e.z; }
    e.yaw = Math.atan2(dx, dz);
    const travel = clamp(Math.hypot(tx - e.x, tz - e.z) / 24, 0.12, 0.8) * 1000;
    st.pending.push({ at: now + travel, kind: 'fire', src: e, x: tx, z: tz });
    broadcastEvent(room, { type: 'pfire', by: targetRef(e), x: r2(tx), z: r2(tz), ms: Math.round(travel) });
    return;
  }

  if (key === 'lightning') {
    const first = nearestEnemy(st, e, sp.range);
    if (!first) return;
    e.yaw = Math.atan2(first.x - e.x, first.z - e.z);
    const chain = [first];
    let cur = first;
    for (let i = 1; i < sp.jumps; i++) {
      let best = null, bd = 8 * 8;
      for (const o of allFighters(st)) {
        if (o.dead || o.team === e.team || chain.includes(o)) continue;
        const d = (o.x - cur.x) ** 2 + (o.z - cur.z) ** 2;
        if (d < bd) { bd = d; best = o; }
      }
      if (!best) break;
      chain.push(best);
      cur = best;
    }
    let mul = 1;
    const ids = [];
    for (const o of chain) {
      hurt(room, st, o, sp.damage * mul, e, 'lightning');
      ids.push(targetRef(o));
      mul *= sp.falloff;
    }
    broadcastEvent(room, { type: 'pbolt', by: targetRef(e), targets: ids });
    return;
  }

  if (key === 'ice') {
    const yaw = num(msg.yaw);
    if (Number.isFinite(yaw)) e.yaw = yaw;
    const ids = [];
    for (const o of allFighters(st)) {
      if (o.dead || o.team === e.team) continue;
      const dx = o.x - e.x, dz = o.z - e.z;
      const d = Math.hypot(dx, dz);
      if (d > sp.radius) continue;
      if (Math.abs(angDiff(Math.atan2(dx, dz), e.yaw)) > sp.halfAngle) continue;
      const dmg = hurt(room, st, o, sp.damage, e, 'ice');
      if (dmg > 0) o.freezeUntil = Math.max(o.freezeUntil, now + sp.freeze * 1000);
      ids.push(targetRef(o));
    }
    broadcastEvent(room, { type: 'pice', by: targetRef(e), yaw: r3(e.yaw), radius: sp.radius, halfAngle: sp.halfAngle, targets: ids });
  }
}

function nearestEnemy(st, e, range) {
  let best = null, bd = range * range;
  for (const o of allFighters(st)) {
    if (o === e || o.dead || o.team === e.team) continue;
    const d = (o.x - e.x) ** 2 + (o.z - e.z) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function useSkill(room, player, msg) {
  const st = room.pvp;
  if (!st || st.phase !== 'battle') return;
  const e = st.ents.get(player.slot);
  if (!e || e.dead || e.cls !== 'blademaster') return;
  const now = Date.now();
  if (now < (e.nextSkillAt || 0)) return;
  e.nextSkillAt = now + SKILL.cooldown * 1000;
  e.attackAt = now;
  let yaw = num(msg.yaw);
  if (!Number.isFinite(yaw) || Math.abs(angDiff(yaw, e.yaw)) > 0.8) yaw = e.yaw;
  e.yaw = yaw;
  const sx = e.x, sz = e.z;
  const steps = 5;
  const hitSet = new Set();
  const ids = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = sx + Math.sin(yaw) * SKILL.dash * t;
    const pz = sz + Math.cos(yaw) * SKILL.dash * t;
    for (const o of allFighters(st)) {
      if (o === e || o.dead || o.team === e.team || hitSet.has(o.id || o.slot)) continue;
      if (Math.hypot(o.x - px, o.z - pz) > SKILL.radius) continue;
      hitSet.add(o.id || o.slot);
      hurt(room, st, o, SKILL.damage, e, 'petal');
      ids.push(targetRef(o));
    }
  }
  broadcastEvent(room, {
    type: 'pskill', by: targetRef(e), x: r2(sx), z: r2(sz), yaw: r3(yaw),
    x2: r2(sx + Math.sin(yaw) * SKILL.dash), z2: r2(sz + Math.cos(yaw) * SKILL.dash), targets: ids
  });
}

/* ------------------------------------------------------------------ 봇 */
function stepBots(room, st, now, dt) {
  for (const b of st.bots) {
    if (b.dead) continue;
    const spec = PVP[b.cls] || PVP.soldier;
    const t = nearestEnemy(st, b, 60);
    if (!t) continue;
    const dx = t.x - b.x, dz = t.z - b.z;
    const d = Math.hypot(dx, dz) || 0.001;
    const stop = spec.reach * 0.82 + (PVP[t.cls] || PVP.soldier).radius * 0.6;
    b.yaw = Math.atan2(dx, dz);
    if (d > stop) {
      const sp = spec.speed * CFG.botSpeedMul * dt;
      b.x += (dx / d) * sp;
      b.z += (dz / d) * sp;
      const c = clampOctagon(b.x, b.z);   // 🥊 옥타곤 안에서만
      b.x = c.x; b.z = c.z;
    } else if (now >= b.nextAttackAt) {
      b.nextAttackAt = now + spec.cycle * 1000;
      b.attackAt = now;
      const inFront = Math.abs(angDiff(Math.atan2(dx, dz), b.yaw)) < spec.arc;
      /* AI 병력은 '함께 싸우는 병사' — 플레이어와 같은 스펙으로 맞붙으면 너무 세다 */
      if (inFront) hurt(room, st, t, spec.damage * CFG.botDamageMul, b, 'blade');
    }
  }
  /* 봇끼리 겹치지 않게 (플레이어 위치는 클라이언트가 보내므로 서버는 봇만 민다) */
  for (let i = 0; i < st.bots.length; i++) {
    const a = st.bots[i];
    if (a.dead) continue;
    for (let j = i + 1; j < st.bots.length; j++) {
      const b = st.bots[j];
      if (b.dead || a.team !== b.team) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const min = (PVP[a.cls].radius + PVP[b.cls].radius) * 1.1;
      if (d > 0.001 && d < min) {
        const k = (min - d) / 2;
        a.x -= (dx / d) * k; a.z -= (dz / d) * k;
        b.x += (dx / d) * k; b.z += (dz / d) * k;
        const ca = clampOctagon(a.x, a.z), cb = clampOctagon(b.x, b.z);
        a.x = ca.x; a.z = ca.z; b.x = cb.x; b.z = cb.z;
      }
    }
  }
}

/* ------------------------------------------------------------------ 스텝 */
function stepRoom(room) {
  const st = room.pvp;
  if (!st) return;
  const now = Date.now();
  const dt = clamp((now - (st.lastStepAt || now)) / 1000, 0.02, 0.4);
  st.lastStepAt = now;
  if (st.phase !== 'battle') return;

  for (const e of allFighters(st)) {
    if (e.dead) {
      if (e.respawnAt && now >= e.respawnAt) respawnEnt(room, st, e);
      continue;
    }
    /* 🛡️ 막기 최대 유지 시간이 끝나면 자동으로 내리고 쿨타임에 들어간다 */
    if (e.guard && e.guardUntil && now >= e.guardUntil) {
      e.guard = false;
      e.guardUntil = 0;
      e.guardCdUntil = now + CFG.guardCooldown * 1000;
      broadcastEvent(room, { type: 'pguardend', to: targetRef(e), cd: Math.round(CFG.guardCooldown * 1000), held: true });
    }
    /* 💥 PVP 는 자연 회복 없음 (regenFrac = 0) — 부활 전에는 체력이 차오르지 않는다 */
    if (CFG.regenFrac > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * CFG.regenFrac * dt);
    if (e.freezeUntil && e.freezeUntil < now) e.freezeUntil = 0;
  }

  for (let i = st.pending.length - 1; i >= 0; i--) {
    const job = st.pending[i];
    if (now < job.at) continue;
    st.pending.splice(i, 1);
    if (job.kind === 'fire') {
      let n = 0;
      const ids = [];
      for (const o of allFighters(st)) {
        if (o.dead || o.team === job.src.team) continue;
        const d = Math.hypot(o.x - job.x, o.z - job.z);
        if (d > SPELLS.fire.radius + (PVP[o.cls] || PVP.soldier).radius) continue;
        const falloff = clamp(1 - (d / SPELLS.fire.radius) * 0.55, 0.4, 1);
        const from = { x: job.x - Math.sin(job.src.yaw) * 0.6, z: job.z - Math.cos(job.src.yaw) * 0.6 };
        hurt(room, st, o, SPELLS.fire.damage * falloff, job.src, 'fire', from);
        ids.push(targetRef(o));
        n++;
      }
      broadcastEvent(room, { type: 'pboom', by: targetRef(job.src), x: r2(job.x), z: r2(job.z), radius: SPELLS.fire.radius, n });
    }
  }

  stepBots(room, st, now, dt);

  if (now >= st.roundEndsAt) {
    const a = st.score.ally || 0, b = st.score.enemy || 0;
    const winner = a > b ? 'ally' : b > a ? 'enemy' : 'draw';
    endRound(room, st, winner, 'time');
    return;
  }

  if (now - st.lastStateAt >= CFG.stateMs) broadcastState(room);
}

/* ------------------------------------------------------------------ 상태 방송 */
function entState(e, now) {
  return {
    s: e.bot ? e.id : e.slot,
    x: r2(e.x), z: r2(e.z),
    w: r3(e.yaw), p: r2(e.pitch || 0),
    c: e.cls, tm: e.team,
    hp: Math.max(0, r2(e.hp)), mx: e.maxHp,
    d: !!e.dead,
    r: e.dead && e.respawnAt ? Math.max(0, Math.ceil((e.respawnAt - now) / 100) / 10) : 0,
    g: !!e.guard,
    a: e.attackAt || 0,
    k: e.kills || 0, dt: e.deaths || 0,
    gc: e.guardCdUntil && e.guardCdUntil > now ? Math.round(e.guardCdUntil - now) : 0,
    gl: e.guard && e.guardUntil ? Math.max(0, Math.round(e.guardUntil - now)) : 0,
    fz: e.freezeUntil && e.freezeUntil > now ? Math.round(e.freezeUntil - now) : 0,
    dd: e.dead ? e.deathAt : 0
  };
}

function statePayload(room, player) {
  const st = room.pvp;
  const now = Date.now();
  const e = player ? st.ents.get(player.slot) : null;
  return {
    type: 'pstate',
    t: now,
    phase: st.phase,
    mode: st.mode,
    killTarget: st.killTarget,
    left: Math.max(0, Math.round((st.roundEndsAt - now) / 1000)),
    score: { ...st.score },
    you: player ? player.slot : -1,
    me: e ? entState(e, now) : null,
    ents: allFighters(st).map((x) => entState(x, now)),
    over: st.over ? { winner: st.over.winner, reason: st.over.reason } : null
  };
}

function broadcastState(room, force) {
  const st = room.pvp;
  if (!st) return;
  st.lastStateAt = Date.now();
  for (const p of room.players) {
    if (!p.ws || !p.connected || p.isAI) continue;
    send(p.ws, statePayload(room, p));
  }
}

function sendState(room, player) {
  if (!room.pvp || !player || !player.ws) return;
  send(player.ws, statePayload(room, player));
}

function handleMessage(room, player, type, msg) {
  const st = room && room.pvp;
  if (!st) return { error: ['NO_STATE', '방 정보를 찾을 수 없어요.'] };
  if (!player) return { error: ['NO_PLAYER', '참가자를 찾을 수 없어요.'] };
  /* 🛡️ 어떤 요청이 와도 방·서버가 죽지 않게 — 처리 중 예외는 그 요청만 실패시킨다 */
  try {
    return routeMessage(room, player, type, msg || {});
  } catch (err) {
    console.error('[pvp]', type, err);
    return { error: ['SERVER', '요청을 처리하지 못했어요.'] };
  }
}

function routeMessage(room, player, type, msg) {
  const st = room.pvp;
  switch (type) {
    case 'pteam': return setTeam(room, player, msg.team);
    case 'pclass': return setClass(room, player, msg.cls);
    case 'pconf': return setConfig(room, player, msg);
    case 'pstart': return startBattle(room, { bySlot: player.slot });
    case 'prematch': return startBattle(room, { rematch: true, bySlot: player.slot });
    case 'pinput': input(room, player, msg); return { ok: true };
    case 'pguard': {
      const out = setGuard(room, player, !!msg.on);
      if (!out.ok && out.cd) {
        const e = st.ents.get(player.slot);
        if (e) sendState(room, player);
      }
      return out.ok ? { ok: true } : { ok: false, cd: out.cd || 0 };
    }
    case 'pattack': attack(room, player, msg); return { ok: true };
    case 'pspell': castSpell(room, player, msg); return { ok: true };
    case 'pskill': useSkill(room, player, msg); return { ok: true };
    case 'psync': sendState(room, player); return { ok: true };
    default: return { error: ['BAD_TYPE', '알 수 없는 요청이에요.'] };
  }
}

function handleDisconnect(room, player) {
  const st = room.pvp;
  if (!st) return;
  const e = st.ents.get(player.slot);
  if (!e) return;
  e.connected = false;
  e.guard = false;
  if (st.phase === 'lobby') {
    /* 대기실이면 자리를 정리한다 (45초 유예는 server.js 가 관리) */
    broadcastLobby(room);
  }
}

module.exports = {
  CFG,
  PVP,
  PVP_HP,
  PVP_DAMAGE,
  PVP_REACH_BONUS,
  SPELLS,
  SKILL,
  CLASS_KEYS,
  createState,
  makeEnt,
  entOf,
  lobbyPayload,
  broadcastLobby,
  broadcastState,
  sendState,
  startBattle,
  handleMessage,
  handleDisconnect,
  stepRoom,
  endRound,
  hurt,
  attack,
  castSpell,
  useSkill,
  setGuard,
  clampOctagon,
  FIXED_CLASS,
  assignTeams,
  allFighters,
  aliveOf
};
