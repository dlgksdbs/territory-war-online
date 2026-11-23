/* =============================================================================
   battle.js — 전투 시뮬레이션
   -----------------------------------------------------------------------------
   · 아군/적군 동일 스펙, 병사·중갑 기사·대마법사 AI
   · 무기 접촉 판정: 공격 모션의 '접촉 프레임'에 실제 사거리·부채꼴 안의 적을 타격
   · 기사 광역 최대 5명, 마법사 3종 마법 + 쿨타임
   · 사망: 무릎 꿇고 쓰러진 뒤 2초 시체 유지
   · 플레이어: 클래스별 AI와 동일 기본 스펙 + 처치당 +0.001% 영구 성장
   ============================================================================= */
import { CLASSES, SPELLS, SPELL_ORDER, SKILL, CORPSE_TIME, KNEEL_TIME, FALL_TIME, GROWTH_PER_KILL, rosterOf, impactAt } from './config.js';
import { clamp, angDiff, angLerp, TAU, mulberry32, smoothstep } from './util.js';
import { makeUnitRig } from './rig.js';

const DEATH_DOWN = 0.20 + KNEEL_TIME + FALL_TIME; // 눕기까지 걸리는 시간
const DEATH_REMOVE = DEATH_DOWN + CORPSE_TIME;

class Grid {
  constructor(cell) {
    this.cell = cell || 4;
    this.map = new Map();
  }
  key(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }
  build(units) {
    this.map.clear();
    const c = this.cell;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead) continue;
      const k = this.key(Math.floor(u.x / c), Math.floor(u.z / c));
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push(u);
    }
  }
  cellAt(x, z) {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  }
  query(x, z, r, out, cap) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    const lim = cap || 400;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.map.get(this.key(cx, cz));
        if (arr) {
          for (let i = 0; i < arr.length; i++) {
            out.push(arr[i]);
            if (out.length >= lim) return out;
          }
        }
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
    this.rng = mulberry32(this.cfg.seed || 12345);
    this.playerKills = this.opts.playerKills || 0;
    this.playerClass = this.cfg.playerClass || 'soldier';
    this.player = null;
    this.playerDeadT = 0;
    this.hitStop = 0;
    this.spawnPoint = { x: 0, z: -21.5 };
    this.total = 0;
    this.arenaR = 46;
    this.stats = { allyKills: 0, enemyKills: 0, playerDeaths: 0, startAt: 0 };
    this.tmp = [];
    this.impacts = [];
    this.pendingCasts = [];
    this.spells = [];   // 비행 중인 화염구
    this.spawned = false;
    this.autoPlayer = !!(opts && opts.autoPlayer);
    this._acquireT = new Map();
    this._separateT = 0;
    this._idleT = 0;
  }

  emit(e) { this.events.push(e); }
  drain() { const e = this.events; this.events = []; return e; }

  newUnit(cls, team, x, z, isPlayer, seed) {
    const spec = CLASSES[cls];
    const id = this.nextId++;
    const rig = makeUnitRig();
    const sd = seed || this.unitSeed((this.nextId * 13) | 0);
    const u = {
      id, cls, team, isPlayer: !!isPlayer,
      x, y: 0, z, vx: 0, vz: 0, yaw: team === 'ally' ? 0 : Math.PI,
      hp: spec.hp, maxHp: spec.hp,
      speed: spec.speed, radius: spec.radius, reach: spec.reach, arc: spec.arc,
      damage: spec.damage, armor: spec.armor, mass: spec.mass,
      scale: cls === 'knight' ? 1.04 : cls === 'wizard' ? 1.0 : 1.0,
      dead: false, deadT: 0, corpseT: 0, removed: false,
      attackT: -1, cooldown: sd.r0 * 0.5, hitDone: false,
      target: null, acquireT: sd.r1 * 0.6,
      moveAmt: 0, walkPhase: sd.r2 * TAU, animPhase: sd.r0 * TAU,
      mirror: 0,
      staggerT: 0, staggerSide: 1, freezeT: 0, slowT: 0,
      cd: { fire: 0, lightning: 0, ice: 0, petal: 0 },
      dashT: -1, dashHit: null, dashCount: 0,
      casts: 0, kills: 0, growl: 1,
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

  /* 결정적 대형 — 양 팀이 완전히 같은 배치(좌우 대칭)로 스폰된다 */
  buildFormation(c) {
      const out = [];
      const j = (i, salt) => mulberry32(i * 7919 + salt * 104729 + 977)() - 0.5;
      const sN = c.soldier;
      const perRow = Math.min(120, Math.max(4, Math.ceil(Math.sqrt(Math.max(1, sN) * 2.2))));
      for (let i = 0; i < sN; i++) {
        const row = Math.floor(i / perRow), col = i % perRow;
        const x = (col - (perRow - 1) / 2) * 1.05 + (row % 2) * 0.5 + j(i, 1) * 0.55;
        const z = 26 + row * 0.92 + j(i, 2) * 0.7;
        out.push({ cls: 'soldier', x, z, k: i });
      }
      for (let i = 0; i < c.knight; i++) {
        const x = (i - (c.knight - 1) / 2) * 2.6 + j(i, 3) * 1.2;
        const z = 24 + (i % 3) * 2.4 + j(i, 4) * 1.6;
        out.push({ cls: 'knight', x, z, k: i });
      }
      for (let i = 0; i < (c.blademaster || 0); i++) {
        const x = (i - (c.blademaster - 1) / 2) * 2.8 + j(i, 7) * 1.3;
        const z = 29 + (i % 4) * 2.2 + j(i, 8) * 1.6;
        out.push({ cls: 'blademaster', x, z, k: i });
      }
      for (let i = 0; i < c.wizard; i++) {
        const x = (i - (c.wizard - 1) / 2) * 3.0 + j(i, 5) * 1.4;
        const z = 33 + (i % 4) * 2.4 + j(i, 6) * 1.8;
        out.push({ cls: 'wizard', x, z, k: i });
      }
      return out;
  }

  unitSeed(index) {
      const rr = mulberry32(4242 + index * 977);
      return { r0: rr(), r1: rr(), r2: rr() };
  }

  start() {
    const r = this.roster;
    const form = this.buildFormation(r.ally);
    this.total = form.length * 2;
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
    for (let i = 0; i < form.length; i++) {
      const f = form[i];
      const seed = this.unitSeed(i);
      const u = this.newUnit(f.cls, 'enemy', f.x, f.z, false, seed);
      u.mirror = i;
      u.yaw = Math.PI;
    }

    // 플레이어 — 대형의 한 자리를 그대로 이어받는다 (인원 대칭 유지)
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

    this.spawned = true;
    this.stats.startAt = 0;
    this.rosterTotal = form.length;
    this.buildOrder();
    return this;
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
    const mult = 1 + this.playerKills * GROWTH_PER_KILL;
    p.dead = false; p.deadT = 0; p.corpseT = 0; p.removed = false;
    p.hp = CLASSES[p.cls].hp * mult;
    p.maxHp = p.hp;
    p.damage = CLASSES[p.cls].damage * mult;
    p.x = this.spawnPoint.x; p.z = this.spawnPoint.z; p.vx = p.vz = 0;
    p.yaw = 0; p.attackT = -1; p.cooldown = 0.4; p.staggerT = 0; p.freezeT = 0;
    p.cd = { fire: 0, lightning: 0, ice: 0 };
    p._tier = -1;
    this.emit({ type: 'respawn', unit: p });
  }

  aliveEnemies(team) {
    const out = [];
    for (const u of this.units) {
      if (u.team !== team && !u.dead) out.push(u);
    }
    return out;
  }

  countAlive(team) {
    let n = 0;
    for (const u of this.units) if (u.team === team && !u.dead) n++;
    return n;
  }

  /* 가장 가까운 적 찾기 (그리드) */
  findTarget(u, range) {
    const r = range || 34;
    const list = this.grid.query(u.x, u.z, r, this.tmp, this.crowd ? 70 : 400);
    let best = null, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.team === u.team || o.dead) continue;
      const dx = o.x - u.x, dz = o.z - u.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /* 이동을 막는 상대 판정 — 질량이 큰 상대일수록 확실히 막는다 */
  blockedBy(u, nx, nz) {
    const list = this.grid.query(nx, nz, 1.6, this._blockTmp || (this._blockTmp = []));
    for (const o of list) {
      if (o === u || o.dead) continue;
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

  damage(target, amount, source, kind) {
    if (target.dead) return 0;
    const dmg = amount * (1 - target.armor);
    target.hp -= dmg;
    target.lastHitBy = source ? source.id : 0;
    const lethal = target.hp <= 0;
    if (lethal) {
      this.kill(target, source, kind);
    } else {
      target.staggerT = Math.max(target.staggerT, kind === 'hammer' ? 0.34 : 0.22);
      target.staggerSide = source && source.x < target.x ? 1 : -1;
      if (kind === 'hammer' || kind === 'ice') target.staggerT = Math.max(target.staggerT, 0.4);
    }
    return dmg;
  }

  kill(target, source, kind) {
    if (target.dead) return;
    // 이미 휘두르고 있던 일격은 죽는 순간에도 적중한다 (맞상대 = 서로 쓰러짐)
    if (!target.hitDone && target.attackT >= 0 && target.attackT < impactAt(target.cls) + 0.12) {
      target.hitDone = true;
      this.resolveMelee(target);
    }
    target.dead = true;
    target.deadT = 0;
    target.corpseT = 0;
    target.hp = 0;
    target.staggerT = 0;
    target.attackT = -1;
    target.moveAmt = 0;
    target.vx = target.vz = 0;
    this.emit({ type: 'death', unit: target, by: source || null, kind });
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

  /* 근접 공격 개시 */
  startAttack(u) {
    if (u.dead || u.attackT >= 0 || u.cooldown > 0 || u.freezeT > 0) return false;
    u.attackT = 0;
    u.hitDone = false;
    const cyc = CLASSES[u.cls].cycle;
    u.cooldown = cyc * (0.97 + u.rng() * 0.06);
    if (u.isPlayer) this.emit({ type: 'attack', unit: u });
    return true;
  }

  /* 접촉 프레임 — 실제 사거리·부채꼴 안의 적을 벤다 */
  resolveMelee(u) {
    const spec = CLASSES[u.cls];
    const list = this.grid.query(u.x, u.z, spec.reach + 1.2, this.tmp);
    const hits = [];
    for (const o of list) {
      if (o.team === u.team || o.dead) continue;
      const dx = o.x - u.x, dz = o.z - u.z;
      const d = Math.hypot(dx, dz);
      if (d > spec.reach + o.radius) continue;
      const ang = Math.atan2(dx, dz);
      if (Math.abs(angDiff(ang, u.yaw)) > spec.arc) continue;
      hits.push({ o, d });
    }
    hits.sort((a, b) => a.d - b.d);
    const max = spec.maxTargets || 1;
    let applied = 0;
    for (let i = 0; i < hits.length && i < max; i++) {
      const o = hits[i].o;
      const hx = (u.x + o.x) / 2, hz = (u.z + o.z) / 2;
      const dmg = this.damage(o, u.damage, u, u.cls === 'knight' ? 'hammer' : 'blade');
      this.emit({
        type: 'hit', source: u, target: o, dmg, kind: u.cls === 'knight' ? 'hammer' : 'blade',
        lethal: o.dead, hx, hz, hy: 1.1 * (o.scale || 1), angle: Math.atan2(o.x - u.x, o.z - u.z)
      });
      applied++;
    }
    if (u.cls === 'knight') {
      this.emit({ type: 'slam', unit: u, x: u.x + Math.sin(u.yaw) * 1.8, z: u.z + Math.cos(u.yaw) * 1.8, hit: applied });
      this.hitStop = Math.max(this.hitStop, u.isPlayer ? 0.085 : 0.03);
    } else if (applied && u.isPlayer) {
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
        const near = this.grid.query(cur.x, cur.z, 8, this.tmp);
        for (const o of near) {
          if (o.dead || o.team === u.team || chain.includes(o)) continue;
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
      const list = this.grid.query(u.x, u.z, sp.radius, this.tmp);
      const hitList = [];
      for (const o of list) {
        if (o.team === u.team || o.dead) continue;
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
    const k = u.dashT / SKILL.dashTime;
    const step = (SKILL.dash / SKILL.dashTime) * dt;
    u.x += Math.sin(u.yaw) * step;
    u.z += Math.cos(u.yaw) * step;
    u.moveAmt = 1;
    u.walkPhase += dt * 16;
    const list = this.grid.query(u.x, u.z, SKILL.radius, this.tmp);
    for (const o of list) {
      if (o.dead || o.team === u.team) continue;
      if (u.dashHit.includes(o.id)) continue;
      if (Math.hypot(o.x - u.x, o.z - u.z) > SKILL.radius + o.radius) continue;
      u.dashHit.push(o.id);
      u.dashCount++;
      const dmg = this.damage(o, SKILL.damage, u, 'petal');
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
      u.cooldown = CLASSES[u.cls].cycle;
    }
  }

  /* 점 하나에 대한 광역 피해 */
  areaDamage(x, z, radius, damage, source, kind, opts) {
    const list = this.grid.query(x, z, radius, this.tmp);
    let n = 0;
    const hitList = [];
    for (const o of list) {
      if (o.dead) continue;
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

  /* 프레임 갱신 */
  update(dt, input) {
    this.time += dt;
    this.grid.build(this.units);

    // 플레이어 입력 (카메라 기준 이동)
    const p = this.player;
    if (p && !p.dead && input && !this.autoPlayer) {
      const mx = input.mx || 0, mz = input.mz || 0;
      const len = Math.hypot(mx, mz);
      if (len > 0.04) {
        const nx = mx / Math.max(1, len), nz = mz / Math.max(1, len);
        const yaw = input.yaw || 0;
        let wx = Math.sin(yaw) * nz + Math.cos(yaw) * nx;
        let wz = Math.cos(yaw) * nz - Math.sin(yaw) * nx;
        const sp = CLASSES[p.cls].speed * clamp(len, 0, 1);
        // 앞을 막는 적/아군이 있으면 그 방향 성분을 지운다 (몸으로 밀고 들어가지 못함)
        const nx2 = p.x + wx * sp * dt, nz2 = p.z + wz * sp * dt;
        const blocked = this.blockedBy(p, nx2, nz2);
        if (blocked) {
          // 접선 방향으로만 미끄러진다
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
      // 플레이어 공격 진행
      if (input.attack && p.cooldown <= 0 && p.attackT < 0) {
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
      if (u.staggerT > 0) u.staggerT -= dt;
      if (u.freezeT > 0) {
        u.freezeT -= dt;
        u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 12);
      }
      for (const k of SPELL_ORDER) if (u.cd[k] > 0) u.cd[k] = Math.max(0, u.cd[k] - dt);
      if (u.cd.petal > 0) u.cd.petal = Math.max(0, u.cd.petal - dt);

      if (u.dead) {
        u.deadT += dt;
        // 시체 유지 후 사라짐
        if (u.deadT > DEATH_REMOVE) {
          u.removed = true;
        }
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
        const spec = CLASSES[u.cls];
        if (!u.hitDone && u.attackT >= impactAt(u.cls)) {
          u.hitDone = true;
          if (!u._impactQueued) { u._impactQueued = true; this.impacts.push(u); }
        }
        if (u.attackT > spec.cycle) u.attackT = -1;
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
      const t = u.target;
      if (u.isPlayer && !this.autoPlayer) {
        u.lookYaw = 0;
        continue;
      }
      const spec = CLASSES[u.cls];
      if (!t) {
        // 사거리에 적이 없으면 전장 중앙으로 진군한다
        const gz = u.team === 'ally' ? 12 : -12;
        const dx2 = -u.x * 0.6, dz2 = gz - u.z;
        const dd = Math.hypot(dx2, dz2) || 1;
        if (dd > 1.2) {
          u.x += (dx2 / dd) * spec.speed * 0.92 * dt;
          u.z += (dz2 / dd) * spec.speed * 0.92 * dt;
          u.yaw = angLerp(u.yaw, Math.atan2(dx2, dz2), Math.min(1, dt * 5));
          u.moveAmt += (1 - u.moveAmt) * Math.min(1, dt * 6);
          u.walkPhase += dt * spec.speed * 2.1;
        } else {
          u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 6);
        }
        continue;
      }

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
          if (this.castSpell(u, cast)) {
            u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 8);
            continue;
          }
        }
        // 거리 유지 (카이팅)
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
        u.x += ax * spec.speed * speedMul * dt;
        u.z += az * spec.speed * speedMul * dt;
        u.moveAmt += ((Math.hypot(ax, az) > 0.2 ? 1 : 0) - u.moveAmt) * Math.min(1, dt * 6);
        u.walkPhase += dt * 5.2 * (u.moveAmt);
        u.yaw = angLerp(u.yaw, desiredYaw, Math.min(1, dt * 5));
        continue;
      }

      // 매화 검객 — 적이 여럿 뭉쳐 있으면 돌진 참격
      if (u.cls === 'blademaster' && u.cd.petal <= 0 && d < 9) {
        let near = 0;
        const nl = this.grid.query(u.x, u.z, 4.2, this.tmp);
        for (const o of nl) if (!o.dead && o.team !== u.team) near++;
        if (near >= 2) {
          u.yaw = desiredYaw;
          if (this.useSkill(u)) continue;
        }
      }

      // 근접: 사거리까지 접근 후 공격
      const stopDist = spec.reach * 0.72 + t.radius * 0.5;
      const attacking = u.attackT >= 0;
      if (d > stopDist) {
        const close = clamp((d - stopDist) / 2.2, 0, 1);
        const sp = spec.speed * (0.55 + 0.45 * close) * (attacking ? 0.25 : 1);
        // 접근 방향에 약간의 회전(대형이 뭉치지 않게)
        const ux = dx / d, uz = dz / d;
        const side = (((u.mirror || 0) % 7) - 3) * 0.06 * (u.team === 'ally' ? 1 : -1);
        const cs = Math.cos(side), sn = Math.sin(side);
        const ax = ux * cs - uz * sn;
        const az = ux * sn + uz * cs;
        u.x += ax * sp * dt;
        u.z += az * sp * dt;
        u.moveAmt += (1 - u.moveAmt) * Math.min(1, dt * 7);
        u.walkPhase += dt * (spec.speed * 2.1);
      } else {
        u.moveAmt += (0 - u.moveAmt) * Math.min(1, dt * 9);
        if (u.cooldown <= 0 && u.attackT < 0) this.startAttack(u);
      }
      // 사거리 안이면 즉시 공격
      if (d <= spec.reach + t.radius && u.cooldown <= 0 && u.attackT < 0) this.startAttack(u);
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
        if (u.isPlayer && !this.autoPlayer && u.dead) continue;
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
      const near = this.grid.query(s.x, s.z, 1.6, this.tmp);
      for (const o of near) {
        if (o.dead || o.team === s.team) continue;
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
    const allyAlive = this.countAlive('ally');
    const enemyAlive = this.countAlive('enemy');
    if (!this.over && (enemyAlive === 0 || allyAlive === 0)) {
      this.over = true;
      this.winner = enemyAlive === 0 && allyAlive === 0 ? 'draw' : (enemyAlive === 0 ? 'ally' : 'enemy');
      this.emit({ type: 'end', winner: this.winner });
    }
    return this;
  }

  separate(dt) {
    const grid = this.grid;
    const units = this.units;
    const tmp = [];
    const stiff = Math.min(1, dt * 9);       // 프레임레이트 독립
    const stride = this.total > 6000 ? 4 : (this.crowd ? 2 : 1);
    const par = (this.frameNo || 0) & 1;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.dead || u.removed || u.freezeT > 0) continue;
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
        if (o === u || o.dead) continue;
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
      const r = Math.hypot(u.x, u.z);
      if (r > this.arenaR) { u.x *= this.arenaR / r; u.z *= this.arenaR / r; }
    }
  }

  /* 진행 중 접촉 프레임에 맞춰 공격 타이밍을 시뮬레이션에 맡긴다 */
  state() {
    return {
      units: this.units.length,
      allyAlive: this.countAlive('ally'),
      enemyAlive: this.countAlive('enemy'),
      playerKills: this.playerKills,
      over: this.over,
      winner: this.winner,
      player: this.player ? {
        x: this.player.x, z: this.player.z, yaw: this.player.yaw,
        hp: this.player.hp, maxHp: this.player.maxHp, cls: this.player.cls,
        dead: this.player.dead, cd: { ...this.player.cd }, kills: this.playerKills,
        dashT: this.player.dashT
      } : null
    };
  }
}
