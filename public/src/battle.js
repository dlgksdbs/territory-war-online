/* =============================================================================
   battle.js — 전투 시뮬레이션
   -----------------------------------------------------------------------------
   · 아군/적군 동일 스펙, 병사·고급 병사·중갑 기사·대마법사·매화 검객 AI
   · 무기 접촉 판정: 공격 모션의 '접촉 프레임'에 실제 사거리·부채꼴 안의 적을 타격
   · 🛡️ 막기: 바라보는 정면(±77°)에서 날아온 공격은 마법·망치·일섬·평타 구분 없이
         피해 0으로 완전 방어. 뒤에서 맞으면 그대로 들어간다.
         고급 병사는 5회 막고 19초 재충전(게이지 관리).
   · 🩸 부위 절단: 머리(베임 사망 모션)·양팔(공속 -30%)·양다리(이속 -30%)
         AI 유닛끼리도 부위를 노리고, 양팔/양다리를 모두 잃으면 사망.
   · 🧠 전술 AI: 측면 포위(flank)·협공(집중)·라인 유지·마법사 거리 유지 — 후퇴 없음.
   · 사망: 무릎 꿇고 쓰러진 뒤 2초 시체 유지 (머리 베임은 목이 잘려 머리가 먼저 떨어진다)
   · 플레이어: 클래스별 AI와 동일 기본 스펙 + 처치당 +0.001% 영구 성장
   ============================================================================= */
import {
  CLASSES, SPELLS, SPELL_ORDER, SKILL, CORPSE_TIME, KNEEL_TIME, FALL_TIME, GROWTH_PER_KILL,
  rosterOf, impactAt, LIMB_LOSS, GUARD_FRONT_HALF, GUARD_CHANCE, SPAWN_INTERVAL, FIELD_RATIO, FIELD_MAX
} from './config.js';
import { clamp, angDiff, angLerp, TAU, mulberry32, smoothstep, joyToWorld } from './util.js';
import { makeUnitRig } from './rig.js';

const DEATH_DOWN = 0.20 + KNEEL_TIME + FALL_TIME; // 눕기까지 걸리는 시간
const DEATH_REMOVE = DEATH_DOWN + CORPSE_TIME;
/* 🛡️ AI 병사가 한 번 막고 나서 다시 막을 수 있을 때까지의 재사용 대기(초) */
const GUARD_COOLDOWN = 0.9;   // 막고 나서 다시 막기까지 (너프 전에 가깝게 짧게)
/* 증원 투입 순서 — 대형도 이 순서로 자리를 채운다 */
const REINF_ORDER = ['soldier', 'elite', 'blademaster', 'knight', 'wizard'];
const CLASS_LIST = ['soldier', 'elite', 'knight', 'wizard', 'blademaster'];
/* 부위 확률 (AI 근접) — 머리 6% · 팔 24% · 다리 28% · 몸통 42% */
const PART_TABLE = [
  [0.06, 'head'], [0.18, 'armL'], [0.30, 'armR'], [0.44, 'legL'], [0.58, 'legR']
];

/* 그리드 — 중심 셀에서 바깥 고리로 훑어 '가까운 유닛부터' 돌려준다.
   (예전엔 좌상단 셀부터 채우다 상한에 걸려, 붐비는 전장에서 코앞의 적을 못 찾았다) */
class Grid {
  constructor(cell) {
    this.cell = cell || 4;
    this.map = new Map();
    /* 셀 배열을 매 프레임 새로 만들면 GC 가 계속 돈다 — 빈 배열을 모아 재사용한다 */
    this.pool = [];
    this.cells = [];
  }
  key(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }
  build(units) {
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) { cells[i].length = 0; this.pool.push(cells[i]); }
    cells.length = 0;
    this.map.clear();
    const c = this.cell;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.removed) continue;
      const k = this.key(Math.floor(u.x / c), Math.floor(u.z / c));
      let arr = this.map.get(k);
      if (!arr) {
        arr = this.pool.length ? this.pool.pop() : [];
        this.map.set(k, arr);
        cells.push(arr);
      }
      arr.push(u);
    }
  }
  cellAt(x, z) {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  }
  query(x, z, r, out, cap) {
    out.length = 0;
    const c = this.cell;
    const lim = cap || 400;
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    const maxRing = Math.max(0, Math.ceil(r / c));
    const push = (ix, iz) => {
      const arr = this.map.get(this.key(ix, iz));
      if (!arr) return false;
      for (let i = 0; i < arr.length; i++) {
        if (out.length >= lim) return true;
        out.push(arr[i]);
      }
      return out.length >= lim;
    };
    if (push(cx, cz)) return out;
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        if (push(ix, cz - ring)) return out;
        if (push(ix, cz + ring)) return out;
      }
      for (let iz = cz - ring + 1; iz <= cz + ring - 1; iz++) {
        if (push(cx - ring, iz)) return out;
        if (push(cx + ring, iz)) return out;
      }
    }
    return out;
  }
}

export class Battle {
  constructor(opts) {
    this.opts = opts || {};
    this.cfg = this.opts.config || {};
    this.roster = rosterOf(this.cfg);
    this.units = [];
    this.byId = new Map();
    this.nextId = 1;
    this.grid = new Grid(3.6);
    this.events = [];
    this.time = 0;
    this.over = false;
    this.winner = null;
    this.endAt = -1;                 // 전투가 끝난 시각 (마지막 사망 모션을 기다린다)
    this.resultDelay = 1.5;          // 승패 배너를 띄우기까지 기다리는 시간(초)
    this.rng = mulberry32(this.cfg.seed || 12345);
    this.playerKills = this.opts.playerKills || 0;
    this.playerClass = this.cfg.playerClass || 'soldier';
    this.player = null;
    this.playerDeadT = 0;
    this.hitStop = 0;
    this.spawnPoint = { x: 0, z: -12 };
    this.total = 0;
    this.arenaR = 46;
    this.stats = { allyKills: 0, enemyKills: 0, playerDeaths: 0, startAt: 0 };
    this.tmp = [];
    this.impacts = [];
    this.pendingCasts = [];
    this.spells = [];   // 비행 중인 화염구
    this.spawned = false;
    this.autoPlayer = !!(opts && opts.autoPlayer);
    this.playerSafe = false;     // 관전 중 — 플레이어 무적
    this.playerInvuln = 0;       // 참전 직후 잠깐 무적
    this._separateT = 0;
    this.tally = { ally: this.zeroTally(), enemy: this.zeroTally() };
    this.engaged = new Map();       // 목표별로 몇 명이 붙었는지 (협공 분산 판단)
  }

  zeroTally() {
    const o = {};
    for (const c of CLASS_LIST) o[c] = 0;
    return o;
  }

  emit(e) { this.events.push(e); }
  drain() { const e = this.events; this.events = []; return e; }

  newUnit(cls, team, x, z, isPlayer, seed) {
    const spec = CLASSES[cls] || CLASSES.soldier;
    const id = this.nextId++;
    const rig = (this.rigPool && this.rigPool.length) ? this.rigPool.pop() : makeUnitRig();
    const sd = seed || this.unitSeed((this.nextId * 13) | 0);
    const elite = cls === 'elite';
    const u = {
      id, cls, team, isPlayer: !!isPlayer,
      x, y: 0, z, vx: 0, vz: 0, yaw: team === 'ally' ? 0 : Math.PI,
      hp: spec.hp, maxHp: spec.hp,
      speed: spec.speed, radius: spec.radius, reach: spec.reach, arc: spec.arc,
      cycle: spec.cycle,
      damage: spec.damage, armor: spec.armor, mass: spec.mass,
      /* 키·몸집에 자연스러운 편차를 준다 (같은 병종이 복제된 것처럼 보이지 않게, ±3%) */
      scale: (cls === 'knight' ? 1.04 : cls === 'elite' ? 1.03 : 1.0) * (0.955 + sd.r2 * 0.075),
      dead: false, deadT: 0, corpseT: 0, removed: false,
      attackT: -1, cooldown: sd.r0 * 0.5, hitDone: false,
      target: null, acquireT: sd.r1 * 0.6,
      moveAmt: 0, walkPhase: sd.r2 * TAU, animPhase: sd.r0 * TAU,
      mirror: 0,
      staggerT: 0, staggerMax: 0.28, staggerSide: 1, freezeT: 0, slowT: 0, _atkFreeze: -1, _guardK: undefined,
      guard: false, guardT: 0, guardCheckT: 0.9 + sd.r1 * 1.4, guardFlash: 0, guardCd: 0,
      guardReaction: (GUARD_CHANCE[cls] || GUARD_CHANCE.soldier).react,
      guardHold: (GUARD_CHANCE[cls] || GUARD_CHANCE.soldier).hold,
      guardCdMax: (GUARD_CHANCE[cls] || GUARD_CHANCE.soldier).cd,
      cd: { fire: 0, lightning: 0, ice: 0, petal: 0 },
      dashT: -1, dashHit: null, dashCount: 0,
      casts: 0, kills: 0, growl: 1,
      /* 🩸 절단 상태 — 팔·다리는 한 번 잘리면 되돌아오지 않는다 */
      severed: { armL: 0, armR: 0, legL: 0, legR: 0, head: 0 },
      armsLost: 0, legsLost: 0, behead: false, sevMask: 0, deathKind: null,
      /* 🧠 전술 */
      role: 'press', roleT: sd.r0 * 0.8, flankSign: sd.r1 < 0.5 ? -1 : 1, lane: (sd.r2 - 0.5) * 2,
      aimPart: 'body', aimId: 0,
      pose: rig.pose,
      joints: rig.joints,
      _jq: rig._jq,
      _jm: rig._jm,
      rootMat: rig.rootMat,
      painT: 0, lastHitBy: 0,
      rng: mulberry32((id * 7919 + (this.cfg.seed || 1)) | 0)
    };
    this.units.push(u);
    this.byId.set(id, u);
    return u;
  }

  /* 결정적 대형 — 양 팀이 완전히 같은 배치(좌우 대칭)로 스폰된다.
     전방(작은 z)에서 뒤로: 고급 병사 → 병사 → 기사 → 검객 → 마법사 */
  buildFormation(c) {
    const out = [];
    const j = (i, salt) => mulberry32(i * 7919 + salt * 104729 + 977)() - 0.5;
    const block = (cls, n, o) => {
      if (!n) return o.z + 1;
      const perRow = Math.max(2, Math.min(o.perRow, Math.ceil(Math.sqrt(n * o.factor))));
      const rows = Math.ceil(n / perRow);
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / perRow), col = i % perRow;
        out.push({
          cls,
          x: (col - (perRow - 1) / 2) * o.xGap + (row % 2) * o.offset + j(i, o.salt) * o.jitter,
          z: o.z + row * o.zGap + j(i, o.salt + 1) * (o.zGap * 0.7),
          k: i
        });
      }
      return o.z + rows * o.zGap;
    };
    let z = 10.5;
    z = block('elite', c.elite || 0, { perRow: 34, factor: 2.6, xGap: 1.35, offset: 0.5, zGap: 1.25, jitter: 0.6, salt: 11, z });
    block('soldier', c.soldier, { perRow: 120, factor: 2.2, xGap: 1.05, offset: 0.5, zGap: 0.92, jitter: 0.55, salt: 1, z: Math.max(z, 13.5) });
    block('knight', c.knight, { perRow: 16, factor: 3.4, xGap: 2.5, offset: 0.8, zGap: 2.1, jitter: 0.9, salt: 3, z: 16 });
    block('blademaster', c.blademaster || 0, { perRow: 20, factor: 3.2, xGap: 2.3, offset: 0.7, zGap: 1.9, jitter: 0.9, salt: 7, z: 20 });
    block('wizard', c.wizard, { perRow: 20, factor: 3.2, xGap: 2.6, offset: 0.7, zGap: 2.1, jitter: 1.0, salt: 5, z: 26 });
    return out;
  }

  unitSeed(index) {
    const rr = mulberry32(4242 + index * 977);
    return { r0: rr(), r1: rr(), r2: rr() };
  }

  start() {
    const r = this.roster;
    /* 편성 병력 = 전장 상한 + 예비. 예비는 앞 병사가 쓰러져 자리가 나면 진영 쪽에서 순차 소환된다. */
    const field = { ally: { ...r.ally }, enemy: { ...r.enemy } };
    this.remain = { ally: this.zeroTally(), enemy: this.zeroTally() };
    this.fieldCap = { ally: this.zeroTally(), enemy: this.zeroTally() };
    const capOf = (cls, n) => {
      if (!n) return 0;
      const floor = cls === 'soldier' ? 20 : cls === 'elite' ? 14 : 8;
      return Math.min(n, clamp(Math.ceil(n * (FIELD_RATIO[cls] || 0.75)), Math.min(n, floor), FIELD_MAX[cls] || 60));
    };
    for (const t of ['ally', 'enemy']) {
      for (const cls of CLASS_LIST) {
        const n = field[t][cls] || 0;
        const cap = capOf(cls, n);
        this.fieldCap[t][cls] = cap;
        this.remain[t][cls] = Math.max(0, n - cap);
        field[t][cls] = cap;
      }
    }
    this.reinT = { ally: this.zeroTally(), enemy: this.zeroTally() };
    this.totalRoster = {
      ally: r.ally.soldier + r.ally.elite + r.ally.knight + r.ally.wizard + r.ally.blademaster,
      enemy: r.enemy.soldier + r.enemy.elite + r.enemy.knight + r.enemy.wizard + r.enemy.blademaster
    };

    // 진영별 대형을 따로 만든다 — 적군 인원은 적군 설정(로스터)에서만 나온다
    const formA = this.buildFormation(field.ally);
    const formE = this.buildFormation(field.enemy);
    const form = formA;
    this.total = formA.length + formE.length;
    this.arenaR = clamp(42 + Math.sqrt(Math.max(0, this.total)) * 1.05, 46, 100);
    this.crowd = this.total > 900;
    this.grid = new Grid(this.crowd ? 4.2 : 3.6);
    // 아군: 플레이어가 선택 클래스 1자리를 대신한다 (양 팀 인원 완전 동일)
    let playerSlot = null;
    for (let i = 0; i < form.length; i++) {
      if (form[i].cls === this.playerClass) { playerSlot = i; break; }
    }
    if (!playerSlot && form.length) playerSlot = 0;
    const playerCarve = playerSlot !== null && form[playerSlot] ? form[playerSlot] : null;

    for (let i = 0; i < form.length; i++) {
      const f = form[i];
      const seed = this.unitSeed(i);
      if (f === playerCarve) continue;   // 플레이어 자리
      const u = this.newUnit(f.cls, 'ally', f.x, -f.z, false, seed);
      u.mirror = i;
    }
    for (let i = 0; i < formE.length; i++) {
      const f = formE[i];
      const seed = this.unitSeed(i);
      const u = this.newUnit(f.cls, 'enemy', f.x, f.z, false, seed);
      u.mirror = i;
      u.yaw = Math.PI;
    }

    // 플레이어 — 대형의 한 자리를 그대로 이어받는다 (인원 대칭 유지)
    //  · 직접 참전이면 아군 대열의 맨 앞(적 쪽)에 선다 — 시작부터 등짝이 시야를 가리지 않게
    let frontZ = -Infinity;
    for (const u of this.units) if (u.team === 'ally' && u.z > frontZ) frontZ = u.z;
    this.spawnPoint = { x: 0, z: (isFinite(frontZ) ? frontZ + 1.5 : -9.0) };
    const px = this.autoPlayer && playerCarve ? playerCarve.x : this.spawnPoint.x;
    const pz = this.autoPlayer && playerCarve ? -playerCarve.z : this.spawnPoint.z;
    const pseed = playerCarve ? this.unitSeed(form.indexOf(playerCarve)) : this.unitSeed(0);
    const pu = this.newUnit(this.playerClass, 'ally', px, pz, true, pseed);
    const mult = 1 + this.playerKills * GROWTH_PER_KILL;
    pu.hp = CLASSES[this.playerClass].hp * mult;
    pu.maxHp = pu.hp;
    pu.damage = CLASSES[this.playerClass].damage * mult;
    pu.growl = mult;
    pu.yaw = 0;
    pu.mirror = playerCarve ? form.indexOf(playerCarve) : 0;
    this.player = pu;

    /* 스폰 직후 코앞에 아군이 겹쳐 시야를 가리지 않도록 플레이어 주변을 살짝 비운다 */
    for (const u of this.units) {
      if (u === pu || u.dead) continue;
      const dx = u.x - pu.x, dz = u.z - pu.z;
      const d = Math.hypot(dx, dz);
      const clear = 3.0;
      if (d < clear) {
        const a = d > 0.001 ? Math.atan2(dx, dz) : u.rng() * TAU;
        u.x = pu.x + Math.sin(a) * clear;
        u.z = pu.z + Math.cos(a) * clear;
      }
    }

    this.spawned = true;
    this.stats.startAt = 0;
    this.rosterTotal = form.length;
    this.buildOrder();

    /* 승패 판정 기준값 — 스폰이 끝난 이 시점의 실제 인원을 기록한다.
       적군이 0명인 편성은 '연습 모드'로 두고 승리로 끝내지 않는다. */
    this.initialAlly = this.countAlive('ally');
    this.initialEnemy = this.countAlive('enemy');
    this.initialTotalAlly = this.totalRoster.ally === 0 ? 1 : this.totalRoster.ally;   // 플레이어가 한 자리를 차지
    this.initialTotalEnemy = this.totalRoster.enemy;
    this.practice = this.totalRoster.enemy === 0;
    this.endGraceT = 0.75;   // 스폰 직후 첫 프레임에 판정하지 않는다
    this.tallyUnits();
    return this;
  }

  /* 사라진 유닛 정리 */
  prune() {
    if (!this.units.some((u) => u.removed)) return;
    const pool = this.rigPool || (this.rigPool = []);
    this.units = this.units.filter((u) => {
      if (!u.removed) return true;
      /* 사라진 유닛의 관절·포즈 버퍼를 재사용 풀에 돌려준다 (장기전에서 매번 새로 만들지 않게)
         · 플레이어의 리그는 부활 때 그대로 쓰므로 절대 풀에 넣지 않는다 */
      if (!u.isPlayer && pool.length < 256 && u.pose && u.joints && u._jq && u._jm) {
        u.pose.rot.fill(0);
        u.pose.root[0] = u.pose.root[1] = u.pose.root[2] = 0;
        u.pose.rootAdd[0] = u.pose.rootAdd[1] = u.pose.rootAdd[2] = 0;
        pool.push({ pose: u.pose, joints: u.joints, _jq: u._jq, _jm: u._jm, rootMat: u.rootMat });
      }
      return false;
    });
    this.byId = new Map(this.units.map((u) => [u.id, u]));
    this.buildOrder();
  }

  /* 남은 예비 병력 (아직 전장에 나오지 않은 병사) */
  reserveTotal(team) {
    const r = this.remain && this.remain[team];
    if (!r) return 0;
    let n = 0;
    for (const cls of CLASS_LIST) n += r[cls] || 0;
    return n;
  }

  /* 전장에 남아 있는 병사 수 (살아 있거나 시체로 남아 있는 것 모두 = 자리 차지) */
  fieldCount(team) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.removed) n++;
    return n;
  }

  /* 전장에 살아 있는 병사 수 (시체는 자리를 차지하지 않는다) */
  aliveCount(team) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.dead && !u.removed) n++;
    return n;
  }

  /* 클래스별 생존 수를 한 번의 순회로 센다 (증원·HUD·승패 판정이 함께 쓴다) */
  tallyUnits() {
    const t = this.tally;
    for (const team of ['ally', 'enemy']) { const o = t[team]; for (const c of CLASS_LIST) o[c] = 0; }
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.removed) continue;
      const o = t[u.team];
      if (o) o[u.cls] = (o[u.cls] || 0) + 1;
    }
    return t;
  }

  countAlive(team) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.dead) n++;
    return n;
  }

  /* 빈자리만큼 진영 쪽에서 다음 병사를 순차 소환
     · 클래스마다 투입 간격이 다르다 — 고급 병사·특수 유닛이 일반 병사보다 빨리 들어온다.
     · 시체가 아직 남아 있어도 상관없다 — "살아 있는 병사"가 그 클래스 상한보다 적으면 바로 소환한다. */
  reinforce(dt) {
    if (!this.remain) return;
    let born = null;
    for (const team of ['ally', 'enemy']) {
      const rem = this.remain[team];
      if (!rem) continue;
      const alive = this.tally[team];
      for (const cls of REINF_ORDER) {
        if (!(rem[cls] > 0)) { this.reinT[team][cls] = 0; continue; }
        this.reinT[team][cls] += dt;
        const interval = SPAWN_INTERVAL[cls] * (this.crowd ? 0.85 : 1);
        if (this.reinT[team][cls] < interval) continue;
        this.reinT[team][cls] = 0;
        const cap = this.fieldCap[team][cls] || 0;
        const slots = cap - (alive[cls] || 0);
        if (slots <= 0) continue;
        const n = Math.min(slots, rem[cls], this.crowd ? 3 : 2);
        if (n <= 0) continue;
        rem[cls] -= n;
        alive[cls] = (alive[cls] || 0) + n;
        if (!born) born = [];
        const zSign = team === 'ally' ? -1 : 1;
        const span = 8 + Math.sqrt(Math.max(1, cap)) * 1.7;
        for (let k = 0; k < n; k++) {
          const x = (this.rng() - 0.5) * span;
          const z = zSign * (23 + this.rng() * 9);
          const u = this.newUnit(cls, team, x, z, false);
          u.yaw = team === 'ally' ? 0 : Math.PI;
          u.mirror = 0;
          born.push(u);
        }
      }
    }
    if (born) {
      for (const u of born) this.emit({ type: 'spawn', unit: u, cls: u.cls });
      this.buildOrder();
    }
  }

  /* 양 팀을 번갈아 처리하는 순서 — 한쪽이 먼저 때리는 편향을 없앤다 */
  buildOrder() {
    const byMirror = new Map();
    for (const u of this.units) {
      const k = u.mirror || 0;
      if (!byMirror.has(k)) byMirror.set(k, []);
      byMirror.get(k).push(u);
    }
    const keys = Array.from(byMirror.keys()).sort((a, b) => a - b);
    const order = [];
    for (const k of keys) {
      const arr = byMirror.get(k);
      // 같은 자리(거울)의 아군·적군을 붙여서 처리하되,
      // 매 자리마다 먼저 처리하는 진영을 번갈아 先手 이점을 없앤다.
      const allyFirst = k % 2 === 0;
      arr.sort((a, b) => {
        const av = a.team === 'ally' ? (allyFirst ? 0 : 1) : (allyFirst ? 1 : 0);
        const bv = b.team === 'ally' ? (allyFirst ? 0 : 1) : (allyFirst ? 1 : 0);
        return av - bv;
      });
      for (const u of arr) order.push(u);
    }
    this.order = order;
    return order;
  }

  /* 플레이어 부활 */
  respawnPlayer() {
    const p = this.player;
    if (!p) return;
    if (!this.units.includes(p)) {
      this.units.push(p);
      this.byId.set(p.id, p);
      this.buildOrder();
    }
    const mult = 1 + this.playerKills * GROWTH_PER_KILL;
    p.dead = false; p.deadT = 0; p.corpseT = 0; p.removed = false;
    p.hp = CLASSES[p.cls].hp * mult;
    p.maxHp = p.hp;
    p.damage = CLASSES[p.cls].damage * mult;
    p.x = this.spawnPoint.x; p.z = this.spawnPoint.z; p.vx = p.vz = 0;
    p.yaw = 0; p.attackT = -1; p.cooldown = 0.4; p.staggerT = 0; p.freezeT = 0;
    p.cd = { fire: 0, lightning: 0, ice: 0, petal: 0 };
    p._tier = -1;
    // 🩸 잘린 팔·다리도 되살아난다
    p.severed = { armL: 0, armR: 0, legL: 0, legR: 0, head: 0 };
    p.armsLost = 0; p.legsLost = 0; p.behead = false;
    p.speed = CLASSES[p.cls].speed;
    p.cycle = CLASSES[p.cls].cycle;
    p.sevMask = 0;
    p.deathKind = null;
    p.guard = false; p.guardT = 0; p.guardCd = 0; p._guardK = 0;
    p.staggerT = 0; p.staggerMax = 0.28; p._atkFreeze = -1; p.moveAmt = 0;
    p._tier = -1; p._hidByCam = false; p.hideModel = false;
    this.emit({ type: 'respawn', unit: p });
  }

  aliveEnemies(team) {
    const out = [];
    for (const u of this.units) {
      if (u.team !== team && !u.dead) out.push(u);
    }
    return out;
  }

  /* 🎬 관전 중인 플레이어는 유령 — AI의 시야·충돌·분리 어디에도 존재하지 않는다 */
  isGhost(o) {
    return !!(o && o.isPlayer && this.playerSafe);
  }

  /* 관전에 들어가는 순간, 플레이어를 노리던 적의 어그로를 즉시 풀어 다른 아군으로 돌린다 */
  releaseFromPlayer() {
    const p = this.player;
    if (!p) return 0;
    let n = 0;
    for (const u of this.units) {
      if (u === p) continue;
      if (u.target === p) {
        u.target = null;
        u.acquireT = 0;
        n++;
      }
      if (u.spellTarget === p) u.spellTarget = null;
    }
    return n;
  }

  /* 목표별 공격자 수를 다시 센다 (0.4초마다) — 협공 분산·집중 판단에 쓴다 */
  recountEngaged() {
    const m = this.engaged || (this.engaged = new Map());
    m.clear();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.dead || u.removed || !u.target) continue;
      m.set(u.target.id, (m.get(u.target.id) || 0) + 1);
    }
  }

  /* 가장 가까운 적 찾기 (그리드 · 가까운 셀부터 — 상한에 걸려도 코앞의 적을 놓치지 않는다)
     · 이미 3명 이상 달라붙은 적은 뒤로 미루고, 1~2명이 협공 중인 적을 우선한다 (집중 화력)
     · 마법사는 여럿이 모인 쪽을 노려 광역 피해를 극대화한다 */
  findTarget(u, range) {
    const r = range || 34;
    const list = this.grid.query(u.x, u.z, r, this.tmp, this.crowd ? 120 : 400);
    let best = null, bestScore = Infinity;
    const eng = this.engaged;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.team === u.team || o.dead) continue;
      if (this.isGhost(o)) continue;
      const dx = o.x - u.x, dz = o.z - u.z;
      let score = dx * dx + dz * dz;
      const n = eng ? (eng.get(o.id) || 0) : 0;
      if (n >= 3) score *= 2.2;                       // 이미 너무 붙었다 — 다른 적을 찾는다
      else if (n >= 1) score *= (u.cls === 'wizard' ? 0.8 : 0.92);   // 협공 중인 적 우선
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /* 이동을 막는 상대 판정 — 질량이 큰 상대일수록 확실히 막는다 */
  blockedBy(u, nx, nz) {
    const list = this.grid.query(nx, nz, 1.6, this._blockTmp || (this._blockTmp = []));
    for (const o of list) {
      if (o === u || o.dead || this.isGhost(o)) continue;
      const dx = nx - o.x, dz = nz - o.z;
      const d = Math.hypot(dx, dz) || 0.0001;
      const minD = (u.radius + o.radius) * 0.95;
      if (d < minD) {
        const ratio = (o.mass || 1) / (u.mass || 1);
        if (ratio < 0.45) continue;   // 가벼운 상대는 밀고 지나갈 수 있다
        return { nx: dx / d, nz: dz / d, o };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- 🩸 부위 */
  /* 이 유닛이 다음 일격에 노릴 부위 (AI). 플레이어는 조준점이 정한다.
     이미 잘려 나간 팔·다리는 노리지 않는다 (히트박스가 없다). */
  rollPart(u, target) {
    const sev = target && target.severed;
    for (let tries = 0; tries < 3; tries++) {
      const r = u.rng();
      let p = 'body';
      for (let i = 0; i < PART_TABLE.length; i++) if (r < PART_TABLE[i][0]) { p = PART_TABLE[i][1]; break; }
      if (!sev || p === 'body' || p === 'head' || !sev[p]) return p;
    }
    return 'body';
  }

  /* 팔·다리를 잃었을 때의 능력치 갱신 — 공속/이속 30% 감소 */
  refreshLimbs(u) {
    const spec = CLASSES[u.cls] || CLASSES.soldier;
    u.armsLost = (u.severed.armL ? 1 : 0) + (u.severed.armR ? 1 : 0);
    u.legsLost = (u.severed.legL ? 1 : 0) + (u.severed.legR ? 1 : 0);
    const armMul = Math.max(0.01, 1 - LIMB_LOSS * u.armsLost);
    const legMul = Math.max(0.01, 1 - LIMB_LOSS * u.legsLost);
    u.cycle = spec.cycle / armMul;          // 공속 30%↓ = 주기 ÷0.7
    u.speed = spec.speed * legMul;          // 이속 30%↓
    u.sevMask = (u.severed.armL ? 1 : 0) | (u.severed.armR ? 2 : 0) |
                (u.severed.legL ? 4 : 0) | (u.severed.legR ? 8 : 0) |
                (u.severed.head ? 16 : 0);
  }

  /* 부위 하나를 잃는다 — 잘린 파츠는 FX로 떨어지고, 양쪽 다 잃으면 죽는다 */
  severLimb(target, part, source, kind) {
    const key = part === 'head' ? 'head' : part;
    if (target.severed[key]) return false;
    target.severed[key] = 1;
    if (part === 'head') target.behead = true;
    this.refreshLimbs(target);
    const side = part === 'armL' || part === 'legL' ? -1 : 1;
    const h = part === 'head' ? 1.62 : (part === 'armL' || part === 'armR') ? 1.25 : 0.62;
    this.emit({
      type: 'sever', unit: target, part, side, kind,
      x: target.x, y: h * (target.scale || 1), z: target.z, yaw: target.yaw
    });
    const pairGone = (target.armsLost >= 2) || (target.legsLost >= 2);
    if (pairGone && !target.dead) {
      // 양팔 또는 양다리를 모두 잃으면 무릎을 꿇고 발악하다 과다출혈로 쓰러진다
      target.hp = 0;
      target.deathKind = 'bleed';
      this.kill(target, source, kind, { part: 'bleed', kind: 'bleed' });
    }
    return true;
  }

  damage(target, amount, source, kind, part) {
    if (target.dead) return 0;
    // 🎬 관전 중인 플레이어는 맞지 않는다 (관전하다 죽어서 리스폰되는 일 방지)
    if (target.isPlayer && (this.playerSafe || this.playerInvuln > 0)) return 0;

    /* 🛡️ 검 막기 — 바라보는 정면(±77°)에서 날아온 공격은 마법·망치·일섬·평타 구분 없이
       피해 0으로 완전히 막아낸다. 뒤에서 맞으면 그대로 들어간다. (가드 브레이크 없음) */
    const canGuard = target.guard && (target.cls === 'soldier' || target.cls === 'elite');
    if (canGuard) {
      let frontal = true;
      if (source && source.x !== undefined) {
        const a = Math.abs(angDiff(Math.atan2(source.x - target.x, source.z - target.z), target.yaw));
        frontal = a < GUARD_FRONT_HALF;
      }
      if (frontal) {
        const heavy = kind === 'hammer' || kind === 'petal' || kind === 'fire' || kind === 'ice' || kind === 'lightning';
        target.guardFlash = 0.24;
        this.emit({
          type: 'block', unit: target, source: source || null, heavy,
          x: target.x + Math.sin(target.yaw) * 0.45, z: target.z + Math.cos(target.yaw) * 0.45,
          y: (target.isPlayer ? 1.35 : 1.12), dmg: 0
        });
        return 0;               // 완전 방어 — 체력 변화 없음
      }
    }

    // 🩸 이미 잘려 나간 팔·다리에는 히트박스가 없다 — 그 자리를 베면 허공을 가른다
    const p = part || 'body';
    if (p !== 'body' && p !== 'head' && target.severed[p]) {
      this.emit({ type: 'miss', target, source, hx: target.x, hy: 1.0, hz: target.z, part: p });
      return 0;
    }
    const partMul = (p === 'armL' || p === 'armR' || p === 'legL' || p === 'legR') ? 0.8 : 1;
    const dmg = amount * partMul * (1 - target.armor);
    target.hp -= dmg;
    target.lastHitBy = source ? source.id : 0;
    const lethal = target.hp <= 0;

    // 부위 절단 판정 — 이미 잘린 부위를 또 맞으면 몸통 피해
    const limbKey = (p === 'armL' || p === 'armR' || p === 'legL' || p === 'legR') ? p : null;
    if (limbKey && !target.severed[limbKey]) {
      const ratio = clamp(dmg / Math.max(1, target.maxHp), 0, 1);
      let chance = ratio * 0.55 + 0.06;
      if (kind === 'petal') chance += 0.18;
      if (kind === 'hammer') chance += 0.22;
      if (lethal) chance = 1;
      if (target.rng() < chance) this.severLimb(target, limbKey, source, kind);
    }

    if (lethal) {
      this.kill(target, source, kind, { part: p });
    } else {
      const st = kind === 'hammer' || kind === 'ice' ? 0.40 : 0.22;
      target.staggerT = Math.max(target.staggerT, st);
      target.staggerMax = Math.max(target.staggerMax || 0, st);
      target.staggerSide = source && source.x < target.x ? 1 : -1;
    }
    return dmg;
  }

  kill(target, source, kind, info) {
    if (target.dead) return;
    // 이미 휘두르고 있던 일격은 죽는 순간에도 적중한다 (맞상대 = 서로 쓰러짐)
    if (!target.hitDone && target.attackT >= 0 && target.attackT < this.impactT(target) + 0.12) {
      target.hitDone = true;
      this.resolveMelee(target);
    }
    const part = info && info.part;
    if (info && info.kind) target.deathKind = info.kind;
    if (part === 'head') target.deathKind = 'behead';
    target.behead = part === 'head' || (target.severed.head === 1 && part !== 'bleed');
    if (target.behead && !target.severed.head) {
      target.severed.head = 1;
      this.refreshLimbs(target);
      this.emit({ type: 'sever', unit: target, part: 'head', side: 1, kind: kind || 'blade',
        x: target.x, y: 1.62 * (target.scale || 1), z: target.z, yaw: target.yaw });
    }
    this.lastDeathAt = this.time;
    // 죽는 순간 휘두르던 동작(접촉 프레임 전이면 그 자세)을 기억 — pose 가 0.2초 동안 겹쳐 준다
    target._atkFreeze = target.attackT >= 0 ? target.attackT : -1;
    target.dead = true;
    target.deadT = 0;
    target.corpseT = 0;
    target.hp = 0;
    target.staggerT = 0;
    target.attackT = -1;
    target.moveAmt = 0;
    target.guard = false; target.guardT = 0;
    target.vx = target.vz = 0;
    this.emit({ type: 'death', unit: target, by: source || null, kind, behead: target.behead });
    if (source) {
      source.kills = (source.kills || 0) + 1;
      if (source.isPlayer) {
        this.playerKills += 1;
        this.stats.allyKills += 1;
        const mult = 1 + this.playerKills * GROWTH_PER_KILL;
        const p = this.player;
        const ratio = p.hp / Math.max(0.001, p.maxHp);
        p.maxHp = CLASSES[p.cls].hp * mult;
        p.hp = Math.max(p.hp, p.maxHp * ratio) + 0.0001;
        p.damage = CLASSES[p.cls].damage * mult;
        p.growl = mult;
        this.emit({ type: 'levelUp', unit: p, kills: this.playerKills, mult });
      } else if (source.team === 'enemy') this.stats.enemyKills += 1;
    }
    if (target.isPlayer) {
      this.stats.playerDeaths += 1;
      this.playerDeadT = 0;
      this.emit({ type: 'playerDown' });
    }
  }

  /* 이 유닛의 접촉 프레임 시각 (팔을 잃으면 느려진 주기를 따라간다) */
  impactT(u) {
    const spec = CLASSES[u.cls] || CLASSES.soldier;
    return (u.cycle || spec.cycle) * (spec.impact / (spec.animDur || spec.cycle));
  }

  /* 근접 공격 개시 */
  startAttack(u) {
    if (u.dead || u.attackT >= 0 || u.cooldown > 0 || u.freezeT > 0) return false;
    u.attackT = 0;
    u.hitDone = false;
    const cyc = u.cycle || CLASSES[u.cls].cycle;
    u.cooldown = cyc * (0.97 + u.rng() * 0.06);
    if (u.isPlayer) this.emit({ type: 'attack', unit: u });
    return true;
  }

  /* 접촉 프레임 — 실제 사거리·부채꼴 안의 적을 벤다 */
  resolveMelee(u) {
    const spec = CLASSES[u.cls];
    // 플레이어의 손맛 — 화면에 보이는 칼끝이 닿았는데 안 들어가는 일이 없도록 사거리·각도 여유를 둔다
    const reach = spec.reach + (u.isPlayer ? 0.45 : 0);
    const arc = spec.arc + (u.isPlayer ? 0.3 : 0);
    const list = this.grid.query(u.x, u.z, reach + 1.2, this.tmp);
    const hits = [];
    for (const o of list) {
      if (o.team === u.team || o.dead || this.isGhost(o)) continue;
      const dx = o.x - u.x, dz = o.z - u.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + o.radius) continue;
      const ang = Math.atan2(dx, dz);
      if (Math.abs(angDiff(ang, u.yaw)) > arc) continue;
      hits.push({ o, d });
    }
    hits.sort((a, b) => a.d - b.d);
    const max = spec.maxTargets || 1;
    let applied = 0;
    for (let i = 0; i < hits.length && i < max; i++) {
      const o = hits[i].o;
      const hx = (u.x + o.x) / 2, hz = (u.z + o.z) / 2;
      // 부위: 플레이어는 조준점, AI는 근접 난전에서 자연스럽게 섞인다
      const part = u.isPlayer
        ? (o.id === u.aimId ? (u.aimPart || 'body') : 'body')
        : this.rollPart(u, o);
      const dmg = this.damage(o, u.damage, u, u.cls === 'knight' ? 'hammer' : 'blade', part);
      this.emit({
        type: 'hit', source: u, target: o, dmg, kind: u.cls === 'knight' ? 'hammer' : 'blade', part,
        lethal: o.dead, hx, hz, hy: 1.1 * (o.scale || 1), angle: Math.atan2(o.x - u.x, o.z - u.z)
      });
      applied++;
    }
    if (u.cls === 'knight') {
      this.emit({ type: 'slam', unit: u, x: u.x + Math.sin(u.yaw) * 1.8, z: u.z + Math.cos(u.yaw) * 1.8, hit: applied });
      // 히트스톱은 '내가 때렸을 때'만 — AI 100명의 타격이 겹치면 전장이 영원히 느려지던 원인
      if (u.isPlayer && !this.autoPlayer) this.hitStop = Math.max(this.hitStop, 0.085);
    } else if (applied && u.isPlayer && !this.autoPlayer) {
      this.hitStop = Math.max(this.hitStop, 0.055);
    }
    return applied;
  }

  /* 마법 — 시전을 예약한다 (모든 유닛의 판단이 끝난 뒤 같은 프레임에 터뜨린다) */
  castSpell(u, key, aim) {
    const sp = SPELLS[key];
    if (!sp || u.dead || u.cd[key] > 0) return false;
    u.cd[key] = sp.cooldown;
    u.casts = (u.casts || 0) + 1;
    if (u.cls === 'wizard') { u.attackT = 0; u.hitDone = true; u.cooldown = 0.4; }
    this.pendingCasts.push({ u, key, aim });
    this.emit({ type: 'castStart', unit: u, spell: key });
    return true;
  }

  executeCast(job) {
    const u = job.u, key = job.key, aim = job.aim;
    const sp = SPELLS[key];
    if (!sp || u.dead) return false;
    if (key === 'fire') {
      // 조준점: 플레이어는 카메라 방향, AI는 가장 밀집한 적 지점
      let tx = aim && aim.x !== undefined ? aim.x : null;
      let tz = aim && aim.z !== undefined ? aim.z : null;
      if (tx === null) {
        const t = u.target && !u.target.dead ? u.target : this.findTarget(u, sp.range);
        if (t) { tx = t.x; tz = t.z; } else return false;
      }
      const dx = tx - u.x, dz = tz - u.z;
      const dist = Math.min(sp.range, Math.hypot(dx, dz));
      const yaw = Math.atan2(dx, dz);
      u.yaw = yaw;
      const px = u.x + Math.sin(yaw) * 1.0;
      const pz = u.z + Math.cos(yaw) * 1.0;
      this.spells.push({
        kind: 'fire', src: u, team: u.team, key,
        x: px, z: pz, y: 1.35, vx: Math.sin(yaw) * 24, vz: Math.cos(yaw) * 24,
        life: Math.max(0.18, dist / 24), maxLife: Math.max(0.18, dist / 24),
        tx, tz
      });
      this.emit({ type: 'castStart', unit: u, spell: key });
    } else if (key === 'lightning') {
      const first = u.target && !u.target.dead && this.dist(u, u.target) < sp.range ? u.target : this.findTarget(u, sp.range);
      if (!first) return false;
      u.yaw = Math.atan2(first.x - u.x, first.z - u.z);
      const chain = [first];
      let cur = first;
      for (let i = 1; i < sp.jumps; i++) {
        let best = null, bd = 8 * 8;
        const near = this.grid.query(cur.x, cur.z, 8, this._chainTmp || (this._chainTmp = []));
        for (const o of near) {
          if (o.dead || o.team === u.team || chain.includes(o) || this.isGhost(o)) continue;
          const d = (o.x - cur.x) ** 2 + (o.z - cur.z) ** 2;
          if (d < bd) { bd = d; best = o; }
        }
        if (!best) break;
        chain.push(best); cur = best;
      }
      let mul = 1;
      const hitList = [];
      for (const o of chain) {
        const dmg = this.damage(o, sp.damage * mul, u, 'lightning');
        hitList.push({ o, dmg, lethal: o.dead });
        mul *= sp.falloff;
        if (o.freezeT > 0) o.freezeT = 0;
      }
      this.emit({ type: 'lightning', unit: u, targets: hitList });
    } else if (key === 'ice') {
      u.yaw = aim && aim.yaw !== undefined ? aim.yaw : u.yaw;
      const list = this.grid.query(u.x, u.z, sp.radius, this._iceTmp || (this._iceTmp = []));
      const hitList = [];
      for (const o of list) {
        if (o.team === u.team || o.dead || this.isGhost(o)) continue;
        const dx = o.x - u.x, dz = o.z - u.z;
        const d = Math.hypot(dx, dz);
        if (d > sp.radius) continue;
        const a = Math.abs(angDiff(Math.atan2(dx, dz), u.yaw));
        if (a > sp.halfAngle) continue;
        const dmg = this.damage(o, sp.damage, u, 'ice');
        o.freezeT = Math.max(o.freezeT, sp.freeze);
        hitList.push({ o, dmg, lethal: o.dead, d });
      }
      this.emit({ type: 'ice', unit: u, targets: hitList, radius: sp.radius, halfAngle: sp.halfAngle });
    }
    this.emit({ type: 'cast', unit: u, spell: key });
    return true;
  }

  dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

  /* 🧠 마법사 — 사거리 안에서 가장 밀집한 적 무리를 찾는다 (주변 5m 내 적 수가 최대) */
  clusterAim(u, range) {
    const list = this.grid.query(u.x, u.z, range, this._clTmp || (this._clTmp = []), 90);
    let best = null, bestN = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.dead || o.team === u.team) continue;
      let n = 0;
      const near = this.grid.query(o.x, o.z, 3.4, this._clTmp2 || (this._clTmp2 = []), 40);
      for (let k = 0; k < near.length; k++) {
        const q = near[k];
        if (!q.dead && q.team !== u.team) n++;
      }
      if (n > bestN) { bestN = n; best = o; }
    }
    return bestN >= 2 ? { x: best.x, z: best.z } : null;
  }

  /* 🌸 매화 일섬 — 전방 돌진 참격 */
  useSkill(u) {
    if (!u || u.dead || u.cls !== 'blademaster' || u.cd.petal > 0 || u.dashT >= 0) return false;
    u.cd.petal = SKILL.cooldown;
    u.dashT = 0;
    u.dashHit = [];
    u.dashCount = 0;
    u.attackT = -1;
    u.cooldown = 0;
    u.freezeT = 0;
    this.emit({ type: 'petalDash', unit: u, x: u.x, z: u.z, yaw: u.yaw });
    return true;
  }

  updateDash(u, dt) {
    const step = (SKILL.dash / SKILL.dashTime) * dt;
    u.x += Math.sin(u.yaw) * step;
    u.z += Math.cos(u.yaw) * step;
    u.moveAmt = 1;
    u.walkPhase += dt * 16;
    const list = this.grid.query(u.x, u.z, SKILL.radius, this._dashTmp || (this._dashTmp = []));
    for (const o of list) {
      if (o.dead || o.team === u.team || this.isGhost(o)) continue;
      if (u.dashHit.includes(o.id)) continue;
      if (Math.hypot(o.x - u.x, o.z - u.z) > SKILL.radius + o.radius) continue;
      u.dashHit.push(o.id);
      u.dashCount++;
      const dmg = this.damage(o, SKILL.damage, u, 'petal', 'body');
      this.emit({
        type: 'hit', source: u, target: o, dmg, kind: 'petal', lethal: o.dead,
        hx: (u.x + o.x) / 2, hz: (u.z + o.z) / 2, hy: 1.1, angle: u.yaw
      });
    }
    u.dashT += dt;
    if (u.dashT >= SKILL.dashTime) {
      u.dashT = -1;
      u.dashHit = null;
      u.attackT = 0;          // 마무리 베기 모션
      u.hitDone = true;
      u.cooldown = u.cycle || CLASSES[u.cls].cycle;
    }
  }

  /* 점 하나에 대한 광역 피해 */
  areaDamage(x, z, radius, damage, source, kind, opts) {
    const list = this.grid.query(x, z, radius, this._areaTmp || (this._areaTmp = []));
    let n = 0;
    const hitList = [];
    for (const o of list) {
      if (o.dead || this.isGhost(o)) continue;
      if (source && o.team === source.team) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d > radius + o.radius) continue;
      const falloff = opts && opts.falloff ? clamp(1 - (d / radius) * 0.55, 0.4, 1) : 1;
      const dmg = this.damage(o, damage * falloff, source, kind);
      hitList.push({ o, dmg, lethal: o.dead });
      n++;
    }
    return { n, hitList };
  }

  /* 🧠 전술 역할 — 도망은 없다. 측면 포위(flank) · 정면 압박(press) */
  assignRole(u) {
    if (u.cls === 'wizard') { u.role = 'support'; return; }
    // id 가 아니라 유닛 자신의 난수로 뽑는다 — 아군·적군이 완전히 같은 확률을 갖도록
    const r = u.rng();
    const flankP = u.cls === 'blademaster' ? 0.62 : u.cls === 'knight' ? 0.22 : 0.34;
    u.role = r < flankP ? 'flank' : 'press';
    if (u.role === 'flank') u.flankSign = u.rng() < 0.5 ? -1 : 1;
  }

  /* 목표를 향해 걸어갈 지점 — 측면 기동이면 목표의 옆·뒤로 돌아 들어가는 호를 그린다 */
  approachPoint(u, t, d) {
    if (u.role !== 'flank' || u.cls === 'wizard') return null;
    const spec = CLASSES[u.cls];
    if (d < spec.reach * 1.35) return null;                 // 이미 붙었으면 그냥 벤다
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);       // 목표가 바라보는 정면
    const rx = (u.x - t.x) / d, rz = (u.z - t.z) / d;       // 목표 → 나
    const facing = rx * fx + rz * fz;                       // 1 = 목표 정면, -1 = 목표 등 뒤
    const side = (rx * fz - rz * fx) >= 0 ? 1 : -1;         // 목표 기준 어느 쪽에 있는지
    const sign = side !== 0 ? side : u.flankSign;
    const rad = spec.reach + 2.4;
    if (facing > -0.1) {
      // 아직 앞/옆 — 목표의 옆구리로 붙는다
      return { x: t.x + fz * sign * rad, z: t.z - fx * sign * rad };
    }
    // 뒤쪽까지 돌았으면 등 뒤에서 찌른다
    return { x: t.x - fx * (rad * 0.75) + fz * sign * 0.9, z: t.z - fz * (rad * 0.75) - fx * sign * 0.9 };
  }

  /* 프레임 갱신 */
  update(dt, input) {
    this.time += dt;
    if (this.playerInvuln > 0) this.playerInvuln = Math.max(0, this.playerInvuln - dt);
    this.grid.build(this.units);
    this.tallyUnits();
    this._engT = (this._engT || 0) + dt;
    if (this._engT > 0.4) { this._engT = 0; this.recountEngaged(); }

    // 플레이어 입력 (카메라 기준 이동)
    const p = this.player;
    if (p && !p.dead && input && !this.autoPlayer) {
      const mx = input.mx || 0, mz = input.mz || 0;
      const len = Math.hypot(mx, mz);
      // 🛡️ 검·방패 막기 — 누르고 있는 동안 계속 (고급 병사도 횟수 제한 없음)
      const canGuardCls = p.cls === 'soldier' || p.cls === 'elite';
      p.guard = canGuardCls ? !!input.guard : false;
      p.aimPart = input.aimPart || 'body';
      p.aimId = input.aimId || 0;
      if (len > 0.04) {
        const nx = mx / Math.max(1, len), nz = mz / Math.max(1, len);
        const yaw = input.yaw || 0;
        // 조이스틱 방향 = 화면(시선) 기준 전후좌우
        const dir = joyToWorld(yaw, nx, nz);
        let wx = dir.x, wz = dir.z;
        const sp = (p.speed || CLASSES[p.cls].speed) * clamp(len, 0, 1) * (p.guard ? 0.55 : 1);
        // 앞을 막는 적/아군이 있으면 그 방향 성분을 지운다 (몸으로 밀고 들어가지 못함)
        const nx2 = p.x + wx * sp * dt, nz2 = p.z + wz * sp * dt;
        const blocked = this.blockedBy(p, nx2, nz2);
        if (blocked) {
          const dot = wx * blocked.nx + wz * blocked.nz;
          wx -= blocked.nx * dot;
          wz -= blocked.nz * dot;
          const l2 = Math.hypot(wx, wz);
          if (l2 > 0.001) { wx /= l2; wz /= l2; } else { wx = 0; wz = 0; }
        }
        p.x += wx * sp * dt;
        p.z += wz * sp * dt;
        p.moveAmt = Math.min(1, Math.hypot(wx, wz));
        p.walkPhase += dt * (6.4 * (p.cls === 'knight' ? 0.8 : 1));
      } else {
        p.moveAmt += (0 - p.moveAmt) * Math.min(1, dt * 9);
      }
      p.yaw = input.yaw || p.yaw;
      // 플레이어 공격 진행 (막고 있으면 베지 않는다)
      if (input.attack && !p.guard && p.cooldown <= 0 && p.attackT < 0) {
        this.startAttack(p);
      }
    }

    // 프레임 시작 위치를 스냅샷으로 남긴다 (이동 순서에 따른 비대칭 제거)
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      u.px = u.x; u.pz = u.z;
    }

    // 유닛 갱신 (양 팀 교차 순서 · 매 프레임 시작 지점을 돌려 先手 이점을 상쇄)
    const order = this.order && this.order.length === this.units.length ? this.order : this.units;
    this.frameNo = ((this.frameNo || 0) + 1) % Math.max(1, order.length);
    const startAt = this.frameNo;
    for (let oi = 0; oi < order.length; oi++) {
      const u = order[(startAt + oi) % order.length];
      // 타이머
      if (u.cooldown > 0) u.cooldown -= dt;
      if (u.guardT > 0) { u.guardT -= dt; if (u.guardT <= 0) { u.guardT = 0; if (!u.isPlayer || this.autoPlayer) { u.guard = false; u.guardCd = u.guardCdMax || GUARD_COOLDOWN; } } }
      if (u.guardCd > 0) u.guardCd = Math.max(0, u.guardCd - dt);
      if (u.guardFlash > 0) u.guardFlash = Math.max(0, u.guardFlash - dt);
      if (u.staggerT > 0) u.staggerT -= dt;
      if (u.freezeT > 0) {
        u.freezeT -= dt;
        u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 12);
      }
      for (const k of SPELL_ORDER) if (u.cd[k] > 0) u.cd[k] = Math.max(0, u.cd[k] - dt);
      if (u.cd.petal > 0) u.cd.petal = Math.max(0, u.cd.petal - dt);

      if (u.dead) {
        u.deadT += dt;
        /* 🐞 플레이어는 부활 대기 중에도 목록에 남긴다.
           (예전에는 3.14초 뒤 시체로 제거되고 부활은 3.6초라, 부활한 플레이어가 목록에 없어
            쿨타임이 영원히 돌지 않아 '공격 버튼이 먹통'이 됐다) */
        if (u.deadT > DEATH_REMOVE && !(u.isPlayer && !this.autoPlayer)) u.removed = true;
        continue;
      }
      if (u.removed) continue;
      if (u.freezeT > 0) continue;

      // 매화 일섬 돌진
      if (u.dashT >= 0) {
        this.updateDash(u, dt);
        continue;
      }

      // 공격 모션 진행 + 접촉 판정
      if (u.attackT >= 0) {
        u.attackT += dt;
        const cyc = u.cycle || CLASSES[u.cls].cycle;
        if (!u.hitDone && u.attackT >= this.impactT(u)) {
          u.hitDone = true;
          if (!u._impactQueued) { u._impactQueued = true; this.impacts.push(u); }
        }
        if (u.attackT > cyc) u.attackT = -1;
      }
      if (u.staggerT > 0) {
        u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 8);
        continue;
      }

      // 대규모 전투: 유닛별 AI 판단을 2프레임에 한 번 (타이머·공격 진행은 매 프레임)
      if (this.crowd && !u.isPlayer && ((oi + this.frameNo) & 1) === 1) continue;

      // 타겟 갱신
      u.acquireT -= dt;
      if (u.acquireT <= 0 || !u.target || u.target.dead) {
        u.target = this.findTarget(u, u.cls === 'wizard' ? 26 : 34);
        u.acquireT = 0.45 + this.rng() * 0.55;
      }
      if (u.isPlayer && !this.autoPlayer) {
        u.lookYaw = 0;
        continue;
      }
      const spec = CLASSES[u.cls];
      const t = u.target;
      if (!t) {
        // 사거리에 적이 없으면 전장 중앙으로 진군한다 (후퇴 없음)
        u.guard = false; u.guardT = 0;
        const gz = u.team === 'ally' ? 12 : -12;
        const dx2 = -u.x * 0.6, dz2 = gz - u.z;
        const dd = Math.hypot(dx2, dz2) || 1;
        if (dd > 1.2) {
          u.x += (dx2 / dd) * u.speed * 0.92 * dt;
          u.z += (dz2 / dd) * u.speed * 0.92 * dt;
          u.yaw = angLerp(u.yaw, Math.atan2(dx2, dz2), Math.min(1, dt * 5));
          u.moveAmt += (1 - u.moveAmt) * Math.min(1, dt * 6);
          u.walkPhase += dt * u.speed * 2.1;
        } else {
          u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 6);
        }
        continue;
      }

      // 🧠 전술 역할 갱신 (1.2~2.8초마다)
      u.roleT -= dt;
      if (u.roleT <= 0) { this.assignRole(u); u.roleT = 1.2 + u.rng() * 1.6; }

      const dx = (t.px === undefined ? t.x : t.px) - (u.px === undefined ? u.x : u.px);
      const dz = (t.pz === undefined ? t.z : t.pz) - (u.pz === undefined ? u.z : u.pz);
      const d = Math.hypot(dx, dz) || 0.0001;
      const desiredYaw = Math.atan2(dx, dz);

      if (u.cls === 'wizard') {
        // 쿨타임에 맞춰 전략적으로 마법 선택
        const canCast = u.cooldown <= 0;
        const inRange = d < SPELLS.fire.range;
        let cast = null;
        if (canCast && u.cd.ice <= 0 && d < 6.5) cast = 'ice';
        else if (canCast && u.cd.lightning <= 0 && inRange) cast = 'lightning';
        else if (canCast && u.cd.fire <= 0 && inRange) cast = 'fire';
        else if (canCast && d < 2.0) cast = null;
        if (cast) {
          // 화염은 '가장 뭉친 지점'에 떨어뜨린다 (한 발로 여러 명)
          let aim = null;
          if (cast === 'fire') {
            aim = this.clusterAim(u, SPELLS.fire.range);
            if (!aim && t) aim = { x: t.x, z: t.z };
          }
          if (this.castSpell(u, cast, aim)) {
            u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 8);
            continue;
          }
        }
        // 거리 유지 (카이팅) — 후퇴가 아니라 화력 지원을 위한 간격 조절
        const want = 9.5;
        let ax = 0, az = 0;
        if (d > want + 1.5) { ax = dx / d; az = dz / d; }
        else if (d < want - 2.5) { ax = -dx / d; az = -dz / d; }
        else {
          // 옆으로 살짝 흔들며 각도 유지
          ax = -dz / d * Math.sin(this.time * 0.7 + u.animPhase) * 0.6;
          az = dx / d * Math.sin(this.time * 0.7 + u.animPhase) * 0.6;
        }
        const speedMul = 0.92;
        u.x += ax * u.speed * speedMul * dt;
        u.z += az * u.speed * speedMul * dt;
        u.moveAmt += ((Math.hypot(ax, az) > 0.2 ? 1 : 0) - u.moveAmt) * Math.min(1, dt * 6);
        u.walkPhase += dt * 5.2 * (u.moveAmt);
        u.yaw = angLerp(u.yaw, desiredYaw, Math.min(1, dt * 5));
        continue;
      }

      // 🌸 매화 검객 — 적이 여럿 뭉쳐 있거나, 거리를 벌린 상대(특히 플레이어)에게 파고들 때 돌진 참격
      if (u.cls === 'blademaster' && u.cd.petal <= 0 && u.dashT < 0) {
        let near = 0;
        const nl = this.grid.query(u.x, u.z, 4.4, this._nearTmp || (this._nearTmp = []));
        for (const o of nl) if (!o.dead && o.team !== u.team) near++;
        const gapClose = d > 3.2 && d < 10.5;
        if (near >= 2 || gapClose) {
          u.yaw = desiredYaw;
          if (this.useSkill(u)) continue;
        }
      }

      // 🛡️ 검 막기 (AI) — 적이 검을 휘두르면 반응해서 막는다 (아군·적군 완전 동일 규칙)
      //    일반 병사: 반응 확률 24%, 대치 중 10%, 한 번 막고 1.4초 재사용 대기
      //    고급 병사: 반응 확률 42%, 충전(5회)이 남아 있을 때만
      if (u.cls === 'soldier' || u.cls === 'elite') {
        const elite = u.cls === 'elite';
        const ready = true;
        const windup = t && t.attackT >= 0 && t.attackT < this.impactT(t) + 0.06;
        const threat = windup && d < spec.reach + 3.2;
        u.guardRollT = (u.guardRollT || 0) - dt;
        const chance = u.guardReaction || 0.56;
        const holdChance = u.guardHold || 0.315;
        if (!u.guard && ready && u.guardCd <= 0 && threat && u.guardRollT <= 0) {
          u.guardRollT = 0.16;               // 한 번의 공격 동작에 한 번만 판단
          if (u.rng() < chance) {
            // 상대 칼이 실제로 닿는 순간까지 방패를 세운다 (타이밍 판단)
            const eta = Math.max(0.05, this.impactT(t) - (t.attackT >= 0 ? t.attackT : 0));
            u.guard = true; u.guardT = Math.min(1.1, eta + 0.20 + u.rng() * 0.12);
            u.attackT = -1;                  // 휘두르던 손을 거두고 막기로
          }
        } else if (!u.guard && ready && u.guardCd <= 0 && !threat) {
          u.guardCheckT = (u.guardCheckT || 0) - dt;
          if (u.guardCheckT <= 0) {
            u.guardCheckT = 1.1 + u.rng() * 1.1;
            if (d < spec.reach + 2.6 && u.rng() < holdChance) {
              u.guard = true; u.guardT = 0.45 + u.rng() * 0.30;
              u.attackT = -1;
            }
          }
        }
      }

      // 🧠 측면 기동 — 목표의 옆/뒤로 돌아 들어간다 (너무 오래 돌면 정면 압박으로 전환)
      let gx = t.x, gz = t.z;
      const ap = this.approachPoint(u, t, d);
      if (ap) {
        u.flankT = (u.flankT || 0) + dt;
        if (u.flankT > 4.5) { u.role = 'press'; u.flankT = 0; u.roleT = 2.0 + u.rng(); }
        else { gx = ap.x; gz = ap.z; }
      } else { u.flankT = 0; }
      let adx = gx - u.x, adz = gz - u.z;
      let ad = Math.hypot(adx, adz) || 0.0001;

      // 근접: 사거리까지 접근 후 공격
      const stopDist = spec.reach * 0.72 + t.radius * 0.5;
      const attacking = u.attackT >= 0;
      if (d > stopDist) {
        // 대열이 한 줄로 늘어서지 않도록 진행 방향의 수직으로 미세한 차선을 둔다
        const ux = adx / ad, uz = adz / ad;
        const lane = (u.lane || 0) * 0.55 + (((u.mirror || 0) % 7) - 3) * 0.05;
        const ax2 = ux - uz * lane * 0.5, az2 = uz + ux * lane * 0.5;
        const al = Math.hypot(ax2, az2) || 1;
        const close = clamp((ad - stopDist) / 2.2, 0, 1);
        const sp = u.speed * (0.55 + 0.45 * close) * (attacking ? 0.25 : 1) * (u.guard ? 0.55 : 1);
        const nx = u.x + (ax2 / al) * sp * dt, nz = u.z + (az2 / al) * sp * dt;
        const blocked = this.blockedBy(u, nx, nz);
        if (!blocked || blocked.o.team === u.team) {
          u.x = nx; u.z = nz;
        } else {
          // 막히면 접선으로 미끄러진다 (뭉쳐서 멈춰 서지 않게)
          const dot = (ax2 / al) * blocked.nx + (az2 / al) * blocked.nz;
          let sx = ax2 / al - blocked.nx * dot, sz = az2 / al - blocked.nz * dot;
          const sl = Math.hypot(sx, sz);
          if (sl > 0.001) { sx /= sl; sz /= sl; u.x += sx * sp * dt; u.z += sz * sp * dt; }
        }
        u.moveAmt += (1 - u.moveAmt) * Math.min(1, dt * 7);
        u.walkPhase += dt * (u.speed * 2.1);
      } else {
        u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 9);
        // 다음 일격을 기다리는 동안 굳어 있지 않고 옆으로 살짝 흘러 각을 만든다
        if (u.cooldown > 0.10 && !u.guard) {
          const side = u.flankSign || 1;
          const sx = Math.cos(desiredYaw) * side, sz = -Math.sin(desiredYaw) * side;
          const nx2 = u.x + sx * u.speed * 0.20 * dt, nz2 = u.z + sz * u.speed * 0.20 * dt;
          const blk = this.blockedBy(u, nx2, nz2);
          if (!blk) { u.x = nx2; u.z = nz2; u.walkPhase += dt * 2.2; }
        }
        if (!u.guard && u.cooldown <= 0 && u.attackT < 0) this.startAttack(u);
      }
      // 사거리 안이면 즉시 공격
      if (!u.guard && d <= spec.reach + t.radius && u.cooldown <= 0 && u.attackT < 0) this.startAttack(u);
      u.yaw = angLerp(u.yaw, desiredYaw, Math.min(1, dt * (attacking ? 3.2 : 7)));
      u.lookYaw = 0;
    }

    // 분리(겹침 방지) — 매 프레임
    this.separate(dt);

    // 예약된 마법을 한꺼번에 시전
    if (this.pendingCasts.length) {
      const jobs = this.pendingCasts.slice();
      this.pendingCasts.length = 0;
      for (const j of jobs) this.executeCast(j);
    }

    // 접촉 프레임을 모아 한꺼번에 판정 — 양 팀이 같은 프레임에 서로를 벤다
    if (this.impacts.length) {
      const list = this.impacts.slice();
      this.impacts.length = 0;
      for (const u of list) {
        u._impactQueued = false;
        if (u.dead) continue;
        this.resolveMelee(u);
      }
    }

    // 화염구 비행
    for (let i = this.spells.length - 1; i >= 0; i--) {
      const s = this.spells[i];
      s.life -= dt;
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      s.y = 1.35 + Math.sin((1 - s.life / s.maxLife) * Math.PI) * 0.6;
      // 명중 판정
      let hit = false;
      const near = this.grid.query(s.x, s.z, 1.6, this._spellTmp || (this._spellTmp = []));
      for (const o of near) {
        if (o.dead || o.team === s.team || this.isGhost(o)) continue;
        if (Math.hypot(o.x - s.x, o.z - s.z) < 1.3 + o.radius) { hit = true; break; }
      }
      if (hit || s.life <= 0) {
        const res = this.areaDamage(s.x, s.z, SPELLS.fire.radius, SPELLS.fire.damage, s.src, 'fire', { falloff: true });
        this.emit({ type: 'explode', x: s.x, z: s.z, radius: SPELLS.fire.radius, dmg: res.n, src: s.src, targets: res.hitList });
        if (s.src && s.src.isPlayer) this.hitStop = Math.max(this.hitStop, 0.07);
        this.spells.splice(i, 1);
      }
    }

    // 플레이어 부활
    if (p && p.dead && !this.autoPlayer) {
      this.playerDeadT += dt;
      if (this.playerDeadT > 3.6) this.respawnPlayer();
    }

    // 승패
    // · 스폰 직후(endGraceT)에는 판정하지 않는다 — 첫 프레임에 '적 0명'으로 읽혀 바로 승리가 뜨던 문제.
    // · 시작할 때 적이 0명이었으면 연습 모드: 아무리 시간이 지나도 승리/패배로 끝내지 않는다.
    // · 예비 병력이 남아 있으면 전멸이 아니다 (다음 병사가 계속 들어온다).
    this.reinforce(dt);
    // 가끔 시체로 끝난 유닛을 목록에서 덜어낸다 (장기전에서 루프가 길어지지 않게)
    this._pruneT = (this._pruneT || 0) + dt;
    if (this._pruneT > 4) { this._pruneT = 0; this.prune(); }
    const graceDone = this.spawned && (this.time || 0) >= (this.endGraceT || 0.75);
    if (!this.over && graceDone && !this.practice) {
      let allyAlive = 0, enemyAlive = 0;
      for (const c of CLASS_LIST) { allyAlive += this.tally.ally[c] || 0; enemyAlive += this.tally.enemy[c] || 0; }
      const playerBack = !!(p && p.dead && !p.removed && !this.autoPlayer);  // 부활 대기 중이면 아군 전멸이 아니다
      const allyUp = allyAlive > 0 || playerBack;
      const enemyWiped = enemyAlive === 0 && this.reserveTotal('enemy') === 0 && (this.initialTotalEnemy || 0) > 0;
      const allyWiped = !allyUp && this.reserveTotal('ally') === 0 && (this.initialTotalAlly || 0) > 0;
      if (enemyWiped || allyWiped) {
        this.over = true;
        this.endAt = this.time;
        this.winner = enemyWiped && allyWiped ? 'draw' : (enemyWiped ? 'ally' : 'enemy');
        // 마지막 적의 사망 모션이 끝날 시간을 준다 (배너가 deadT 를 끊지 않게)
        const since = this.time - (this.lastDeathAt === undefined ? this.time : this.lastDeathAt);
        this.resultDelay = clamp((DEATH_DOWN + 0.30) - since, 0.5, DEATH_DOWN + 0.4);
        this.emit({ type: 'end', winner: this.winner, delay: this.resultDelay });
        this.emit({ type: 'result', winner: this.winner, at: this.time + this.resultDelay });
      }
    }
    // 끝난 뒤에도 시체·잔여 모션이 계속 흐르도록 시간을 기록해 둔다
    if (this.over) this.afterEndT = (this.afterEndT || 0) + dt;
    return this;
  }

  separate(dt) {
    const grid = this.grid;
    const units = this.units;
    const tmp = this._sepTmp || (this._sepTmp = []);
    const stiff = Math.min(1, dt * 9);       // 프레임레이트 독립
    const stride = this.total > 6000 ? 4 : (this.crowd ? 2 : 1);
    const par = (this.frameNo || 0) & 1;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.removed || u.freezeT > 0) continue;
      if (this.isGhost(u)) continue;              // 관전 중 내 몸은 아무에게도 밀리지 않는다
      if (stride === 2 && (i & 1) !== par) continue;
      if (this.crowd) {
        const arr = grid.cellAt(u.x, u.z);
        tmp.length = 0;
        if (arr) for (let q = 0; q < arr.length; q++) tmp.push(arr[q]);
      } else {
        grid.query(u.x, u.z, 1.5, tmp);
      }
      let px = 0, pz = 0;
      const um = u.mass || 1;
      // 공격/경직 중인 유닛은 땅을 딛고 버틴다
      const brace = u.attackT >= 0 ? 0.35 : (u.staggerT > 0 ? 0.6 : 1);
      for (let k = 0; k < tmp.length; k++) {
        const o = tmp[k];
        if (o === u || o.dead || this.isGhost(o)) continue;
        const dx = u.x - o.x, dz = u.z - o.z;
        let d = Math.hypot(dx, dz);
        const om = o.mass || 1;
        const minD = (u.radius + o.radius) * 0.96;
        if (d >= minD) continue;
        let nx, nz;
        if (d < 0.0001) { const a = (u.id * 2.399) % TAU; nx = Math.cos(a); nz = Math.sin(a); d = 0.0001; }
        else { nx = dx / d; nz = dz / d; }
        const overlap = Math.min(minD - d, 0.45);
        // 질량 비율로 밀리는 양을 나눈다 (무거운 쪽은 덜 밀린다)
        const wSelf = 1 / um, wOther = 1 / om;
        let share = wSelf / (wSelf + wOther);
        // 상대가 버티고 있으면 이쪽이 더 밀린다
        const oBrace = o.attackT >= 0 ? 0.35 : 1;
        share = share * (oBrace < 1 ? 0.6 : 1);
        const push = overlap * share * brace * 0.85;
        px += nx * push;
        pz += nz * push;
      }
      if (px || pz) {
        const cap = 2.2 * stiff;
        const l = Math.hypot(px, pz);
        const sc = l > cap ? cap / l : 1;
        u._pushX = px * sc; u._pushZ = pz * sc;
      } else { u._pushX = 0; u._pushZ = 0; }
    }
    // 모든 밀어내기를 계산한 뒤 한꺼번에 적용 (순서 편향 제거)
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.removed) continue;
      u.x += u._pushX || 0;
      u.z += u._pushZ || 0;
      u._pushX = 0; u._pushZ = 0;
      /* 방어: 어떤 이유로든 좌표가 깨지면 전장 밖으로 튀지 않게 되돌린다 */
      if (!isFinite(u.x) || !isFinite(u.z)) {
        u.x = (u.team === 'ally' ? 0 : 0) + (this.rng() - 0.5) * 4;
        u.z = (u.team === 'ally' ? -14 : 14) + (this.rng() - 0.5) * 4;
        u.vx = 0; u.vz = 0; u.target = null;
      }
      const r = Math.hypot(u.x, u.z);
      if (r > this.arenaR) { u.x *= this.arenaR / r; u.z *= this.arenaR / r; }
    }
  }

  /* 진행 중 접촉 프레임에 맞춰 공격 타이밍을 시뮬레이션에 맡긴다 */
  state() {
    const p = this.player;
    this.tallyUnits();               // 디버그/HUD 조회 시점의 실제 생존 수
    const t = this.tally;
    const allyAlive = CLASS_LIST.reduce((n, c) => n + (t.ally[c] || 0), 0);
    const enemyAlive = CLASS_LIST.reduce((n, c) => n + (t.enemy[c] || 0), 0);
    const allyNoPlayer = allyAlive - (p && !p.dead ? 1 : 0);
    return {
      units: this.units.length,
      allyAlive, enemyAlive, allyNoPlayer,
      elite: { ally: t.ally.elite || 0, enemy: t.enemy.elite || 0 },
      playerKills: this.playerKills,
      over: this.over,
      winner: this.winner,
      resultIn: this.over ? Math.max(0, (this.endAt + this.resultDelay) - this.time) : null,
      practice: !!this.practice,
      field: { ally: allyAlive, enemy: enemyAlive },
      reserve: { ally: this.reserveTotal('ally'), enemy: this.reserveTotal('enemy') },
      player: p ? {
        x: p.x, z: p.z, yaw: p.yaw,
        hp: p.hp, maxHp: p.maxHp, cls: p.cls,
        dead: p.dead, cd: { ...p.cd }, kills: this.playerKills,
        dashT: p.dashT, severed: { ...p.severed }, speed: p.speed, cycle: p.cycle,
        deathKind: p.deathKind || null
      } : null
    };
  }
}
