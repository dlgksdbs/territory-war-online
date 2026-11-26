'use strict';

/* =============================================================================
   플레이어 PVP · 실시간 1인칭 대전 테스트
   -----------------------------------------------------------------------------
   1) 엔진: 방 상태 · 팀/병종 선택 · 시작 조건 · 근접 피해 · 정면 막기 ·
           흡혈 · 처치/점수 · 부활 · 킬 목표 승리 · 전멸전 승리 · 재대결
   2) AI 병력: 방장이 섞은 봇이 실제로 추격·공격하는지
   3) WebSocket: 2인 방 생성/입장/팀·병종/시작/이동/공격/막기/피해/킬/재대결
                 + 1인 + AI 병력으로도 시작 가능
   실행: node test/pvp.js
   ============================================================================= */

const assert = require('assert');
const WebSocket = require('ws');
const P = require('../pvp');
const { createServer } = require('../server');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRoom(n, opts) {
  const o = opts || {};
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      slot: i,
      controlSlot: i,
      name: i === 0 ? '한윤' : '친구' + i,
      token: 'tok' + i,
      ws: null,
      connected: true,
      isAI: false,
      abandoned: false,
      autoAI: false,
      disconnectedAt: null,
      dropTimer: null
    });
  }
  const room = {
    code: 'PVP1',
    mode: 'pvp',
    hostSlot: 0,
    capacity: o.capacity || 8,
    players,
    started: false,
    sim: false,
    aiFill: false,
    pvp: P.createState({ capacity: o.capacity || 8 })
  };
  return room;
}

async function stepFor(room, ms, step) {
  const dt = step || 30;
  let t = 0;
  while (t < ms) {
    t += dt;
    P.stepRoom(room);
    if (room.pvp.phase === 'over') break;
    await sleep(dt);
  }
  return t;
}

/* =========================================================================
   1. 엔진
   ========================================================================= */
async function engineTests() {
  console.log('엔진 · 대기실과 시작');
  const room = fakeRoom(2);
  const st = room.pvp;
  ok('방 상태는 대기실에서 시작', st.phase === 'lobby' && st.capacity === 8);
  ok('팀 선택 · 자동 배정', P.handleMessage(room, room.players[0], 'pteam', { team: 'auto' }).ok &&
    P.entOf(st, room.players[0]).team === null);
  ok('병종 선택', P.handleMessage(room, room.players[0], 'pclass', { cls: 'knight' }).ok &&
    P.entOf(st, room.players[0]).cls === 'knight' &&
    P.entOf(st, room.players[0]).maxHp === P.PVP.knight.hp);
  ok('없는 병종은 거절', P.handleMessage(room, room.players[0], 'pclass', { cls: 'dragon' }).error[0] === 'BAD_CLASS');
  ok('방장이 아닌 사람은 설정 불가',
    P.handleMessage(room, room.players[1], 'pconf', { bots: { ally: 2, enemy: 2 } }).error[0] === 'HOST_ONLY');
  ok('방장은 설정 가능', P.handleMessage(room, room.players[0], 'pconf', { mode: 'kills', killTarget: 3, bots: { ally: 0, enemy: 0 } }).ok &&
    st.killTarget === 3 && st.botCfg.ally === 0);

  /* 1인 + AI 병력 없음 → 상대가 없어 시작 불가 */
  const solo = fakeRoom(1);
  ok('혼자서는 상대가 없으면 시작 불가', P.startBattle(solo, { bySlot: 0 }).error[0] === 'NEED_BOTH');
  P.handleMessage(solo, solo.players[0], 'pconf', { bots: { ally: 0, enemy: 2 } });
  ok('AI 병력을 섞으면 혼자서도 시작', P.startBattle(solo, { bySlot: 0 }).ok && solo.pvp.phase === 'battle');
  ok('AI 병력이 실제로 전장에 섰다', solo.pvp.bots.length === 2 && solo.pvp.bots.every((b) => b.team === 'enemy' && !b.dead),
    solo.pvp.bots.map((b) => b.name));

  /* 2인 시작 */
  P.handleMessage(room, room.players[0], 'pclass', { cls: 'soldier' });
  P.handleMessage(room, room.players[1], 'pclass', { cls: 'soldier' });
  P.handleMessage(room, room.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(room, room.players[1], 'pteam', { team: 'enemy' });
  ok('양 팀에 한 명씩이면 시작', P.startBattle(room, { bySlot: 0 }).ok && st.phase === 'battle');
  const me = P.entOf(st, room.players[0]);
  const foe = P.entOf(st, room.players[1]);
  ok('팀·병종이 그대로 전장에 반영', me.team === 'ally' && foe.team === 'enemy' && me.cls === 'soldier');
  ok('양 팀이 서로 마주 보고 스폰', me.z < 0 && foe.z > 0 && Math.abs(me.yaw) < 0.01 && Math.abs(foe.yaw - Math.PI) < 0.01,
    { me: [me.x, me.z], foe: [foe.x, foe.z] });

  console.log('전투 · 실제 피해와 막기');
  /* 서로 붙여 놓고 공격 */
  me.x = 0; me.z = 0; me.yaw = 0;
  foe.x = 0; foe.z = 1.6; foe.yaw = Math.PI;
  const hp0 = foe.hp;
  me.hp = me.maxHp;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('사거리 안의 상대에게 실제 피해가 들어간다', foe.hp < hp0, { before: hp0, after: foe.hp });
  const dealt = hp0 - foe.hp;
  ok('피해량은 병종 공격력 − 방어력', Math.abs(dealt - P.PVP.soldier.damage * (1 - P.PVP.soldier.armor)) < 0.6, dealt);
  me.hp = me.maxHp - 200;
  foe.hp = foe.maxHp; foe.guard = false; me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('적중하면 흡혈로 조금 회복한다', me.hp > me.maxHp - 200, { hp: me.hp });

  /* 같은 순간 연타는 쿨타임에 막힌다 */
  const hp1 = foe.hp;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('공속 주기 안의 연타는 서버가 막는다', Math.abs(foe.hp - hp1) < 0.001, { hp: foe.hp });

  /* 정면 막기 — 상대가 나를 보고 막으면 피해 0 */
  foe.hp = foe.maxHp;
  foe.guard = true;
  foe.yaw = Math.PI;                       // 나(0,0)를 바라본다
  me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('정면으로 검을 막으면 피해 0', foe.hp === foe.maxHp, { hp: foe.hp, mx: foe.maxHp });
  /* 뒤에서 치면 그대로 들어간다 */
  foe.yaw = 0;                             // 반대쪽을 봄
  me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('뒤에서 맞으면 막기 무시', foe.hp < foe.maxHp, { hp: foe.hp });

  console.log('전투 · 처치 · 점수 · 부활');
  foe.hp = 1; foe.guard = false;
  me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('체력이 0이 되면 쓰러진다', foe.dead && foe.hp === 0);
  ok('아군 킬 점수 +1', st.score.ally === 1, st.score);
  ok('킬 모드에서는 3초 뒤 부활 예약', foe.respawnAt > Date.now() - 10);
  await stepFor(room, 3400);
  ok('부활하면 체력이 가득 찬다', !foe.dead && foe.hp === foe.maxHp && st.score.ally === 1);

  /* 킬 목표 달성 → 라운드 종료 */
  st.score.ally = st.killTarget - 1;
  me.x = 0; me.z = 0; me.yaw = 0;
  foe.x = 0; foe.z = 1.6; foe.guard = false; foe.dead = false; foe.hp = 1;
  me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('킬 목표 달성 시 아군 승리', st.phase === 'over' && st.over.winner === 'ally' && st.over.reason === 'target',
    st.over);

  /* 재대결 — 같은 팀·병종으로 다시 */
  const out = P.handleMessage(room, room.players[0], 'prematch', {});
  ok('방장의 재대결로 새 라운드', out.ok && st.phase === 'battle' && st.score.ally === 0 && st.score.enemy === 0);
  ok('재대결은 같은 팀·병종 유지', P.entOf(st, room.players[0]).team === 'ally' &&
    P.entOf(st, room.players[1]).cls === 'soldier');
  ok('재대결 후 모두 만피로 스폰', P.entOf(st, room.players[0]).hp === P.entOf(st, room.players[0]).maxHp);

  console.log('전투 · 전멸전 승리');
  const elim = fakeRoom(2);
  P.handleMessage(elim, elim.players[0], 'pconf', { mode: 'elim', bots: { ally: 0, enemy: 0 } });
  P.handleMessage(elim, elim.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(elim, elim.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(elim, { bySlot: 0 });
  const a = P.entOf(elim.pvp, elim.players[0]);
  const b = P.entOf(elim.pvp, elim.players[1]);
  a.x = 0; a.z = 0; a.yaw = 0; b.x = 0; b.z = 1.5; b.hp = 1; b.guard = false;
  P.handleMessage(elim, elim.players[0], 'pattack', { yaw: 0 });
  ok('전멸전에서는 부활하지 않고 상대 팀 승리',
    elim.pvp.phase === 'over' && elim.pvp.over.winner === 'ally' && b.respawnAt === 0,
    elim.pvp.over);

  console.log('마법과 매화 일섬');
  const wiz = fakeRoom(2);
  P.handleMessage(wiz, wiz.players[0], 'pclass', { cls: 'wizard' });
  P.handleMessage(wiz, wiz.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(wiz, wiz.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(wiz, { bySlot: 0 });
  const w = P.entOf(wiz.pvp, wiz.players[0]);
  const t = P.entOf(wiz.pvp, wiz.players[1]);
  w.x = 0; w.z = 0; t.x = 0; t.z = 6; t.hp = t.maxHp;
  P.handleMessage(wiz, wiz.players[0], 'pspell', { key: 'fire', x: 0, z: 6 });
  ok('화염구는 날아간 뒤에 터진다 (즉시 피해 없음)', t.hp === t.maxHp);
  await stepFor(wiz, 400);
  ok('화염구가 도착하면 광역 피해', t.hp < t.maxHp, { hp: t.hp });
  const hpAfterFire = t.hp;
  P.handleMessage(wiz, wiz.players[0], 'pspell', { key: 'fire', x: 0, z: 6 });
  ok('마법 쿨타임 중에는 다시 시전되지 않는다', t.hp === hpAfterFire && wiz.pvp.pending.length === 0);
  w.nextSpellAt.lightning = 0;
  t.hp = t.maxHp;
  P.handleMessage(wiz, wiz.players[0], 'pspell', { key: 'lightning' });
  ok('연쇄 번개는 즉시 피해', t.hp < t.maxHp, { hp: t.hp });

  const bm = fakeRoom(2);
  P.handleMessage(bm, bm.players[0], 'pclass', { cls: 'blademaster' });
  P.handleMessage(bm, bm.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(bm, bm.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(bm, { bySlot: 0 });
  const s = P.entOf(bm.pvp, bm.players[0]);
  const v = P.entOf(bm.pvp, bm.players[1]);
  s.x = 0; s.z = 0; s.yaw = 0; v.x = 0; v.z = 4; v.hp = v.maxHp;
  P.handleMessage(bm, bm.players[0], 'pskill', { yaw: 0 });
  ok('매화 일섬 돌진 경로의 상대가 맞는다', v.hp < v.maxHp, { hp: v.hp });
  ok('일섬 쿨타임', s.nextSkillAt > Date.now() - 10);

  console.log('AI 병력 · 실제 전투');
  const botRoom = fakeRoom(1);
  P.handleMessage(botRoom, botRoom.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(botRoom, botRoom.players[0], 'pconf', { bots: { ally: 0, enemy: 1 } });
  P.startBattle(botRoom, { bySlot: 0 });
  const meb = P.entOf(botRoom.pvp, botRoom.players[0]);
  const bot = botRoom.pvp.bots[0];
  meb.x = 0; meb.z = 0; meb.yaw = 0;
  bot.x = 0; bot.z = 3; bot.yaw = Math.PI;
  await stepFor(botRoom, 2500);
  ok('AI 병력이 플레이어에게 다가와 공격한다', meb.hp < meb.maxHp, { hp: meb.hp, bot: [bot.x, bot.z] });
  ok('AI 병력도 플레이어 공격에 쓰러진다', (() => {
    meb.nextAttackAt = 0; meb.yaw = 0; bot.guard = false;
    bot.x = 0; bot.z = 1.6; bot.hp = 1;
    P.handleMessage(botRoom, botRoom.players[0], 'pattack', { yaw: 0 });
    return bot.dead && botRoom.pvp.score.ally === 1;
  })());
}

/* =========================================================================
   2. WebSocket 2인
   ========================================================================= */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.msgs = [];
    this.waiters = [];
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch (e) { return; }
      this.msgs.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.pred(m)) { this.waiters.splice(i, 1); w.resolve(m); }
      }
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  wait(pred, ms) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('메시지 대기 시간 초과')), ms || 4000);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(to); resolve(m); } });
    });
  }
  state() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === 'pstate') return this.msgs[i];
    return null;
  }
  clear() { this.msgs.length = 0; }
}

async function networkTests() {
  console.log('WebSocket · 2인 PVP');
  const { server } = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const url = 'ws://127.0.0.1:' + port + '/ws';
  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(new Client(ws)));
    ws.on('error', reject);
  });

  const a = await open();
  const b = await open();
  a.send({ type: 'create', name: '한윤', mode: 'pvp' });
  const joined = await a.wait((m) => m.type === 'joined');
  ok('PVP 방 만들기', joined.mode === 'pvp' && /^[A-Z0-9]{4}$/.test(joined.code), joined);
  const lobbyA = await a.wait((m) => m.type === 'plobby');
  ok('대기실 정보(병종·설정)를 받는다', lobbyA.players.length === 1 && lobbyA.classes.length === 6 &&
    lobbyA.code === joined.code, { players: lobbyA.players.length });

  b.send({ type: 'join', name: '친구', code: joined.code });
  const joinedB = await b.wait((m) => m.type === 'joined');
  ok('방 코드로 입장', joinedB.mode === 'pvp' && joinedB.code === joined.code);
  const lobby2 = await b.wait((m) => m.type === 'plobby' && m.players.length === 2);
  ok('두 사람이 같은 대기실에 보인다', lobby2.players.length === 2 && lobby2.host === 0);

  a.send({ type: 'pteam', team: 'ally' });
  b.send({ type: 'pteam', team: 'enemy' });
  a.send({ type: 'pclass', cls: 'soldier' });
  b.send({ type: 'pclass', cls: 'soldier' });
  await sleep(120);
  a.send({ type: 'pconf', mode: 'kills', killTarget: 3, bots: { ally: 0, enemy: 0 } });
  await sleep(80);
  a.send({ type: 'pstart' });
  const startA = await a.wait((m) => m.type === 'pstart');
  const startB = await b.wait((m) => m.type === 'pstart');
  ok('방장이 시작하면 양쪽에 전장 정보', startA.roster.length === 2 && startB.roster.length === 2 &&
    startA.you !== startB.you, { a: startA.you, b: startB.you });
  ok('서로 다른 팀으로 배치', startA.team !== startB.team, { a: startA.team, b: startB.team });

  await sleep(160);
  const s0 = a.state();
  ok('실시간 상태를 받는다', !!s0 && s0.ents.length === 2, s0 && s0.ents.length);

  const myEnt = (c, slot) => {
    const st = c.state();
    return st ? st.ents.find((e) => e.s === slot) : null;
  };
  /* 걸어가기 — 서버가 속도·범위를 검증하므로 한 번에 순간이동하지 못한다 */
  async function walk(c, slot, tx, tz, yaw, steps) {
    for (let i = 0; i < (steps || 90); i++) {
      const e = myEnt(c, slot);
      if (!e) return null;
      const dx = tx - e.x, dz = tz - e.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) break;
      const step = Math.min(0.7, d);
      c.send({ type: 'pinput', x: e.x + (dx / d) * step, z: e.z + (dz / d) * step, yaw: yaw === undefined ? e.w : yaw, pitch: 0 });
      await sleep(50);
    }
    return myEnt(c, slot);
  }

  const entA = s0.ents.find((e) => e.s === startA.you);
  const entB = s0.ents.find((e) => e.s === startB.you);
  ok('두 사람은 서로 다른 진영에서 마주 보고 시작', (entA.z < 0) !== (entB.z < 0), { a: entA.z, b: entB.z });
  const walked = await walk(b, startB.you, entA.x, entA.z + 1.5, Math.PI, 90);
  ok('위치·시선이 서버에 동기화된다 (걸어서 접근)', !!walked && walked.z < entB.z,
    { before: entB.z, after: walked && walked.z });

  /* 막기 — B가 A를 바라보고 막으면 A의 공격이 막힌다 */
  b.send({ type: 'pguard', on: true });
  await sleep(140);
  const sBefore = a.state();
  const aNow = sBefore.ents.find((e) => e.s === startA.you);
  const bNow = sBefore.ents.find((e) => e.s === startB.you);
  ok('두 사람이 검 닿는 거리', Math.hypot(aNow.x - bNow.x, aNow.z - bNow.z) < 2.6,
    { d: Math.hypot(aNow.x - bNow.x, aNow.z - bNow.z) });
  a.send({ type: 'pattack', yaw: 0 });
  const block = await a.wait((m) => m.type === 'pblock' && m.to === startB.you, 2500).catch(() => null);
  ok('상대가 정면으로 막으면 막힘 이벤트가 온다', !!block, block && { to: block.to, heavy: block.heavy });

  /* 막기 해제 후 공격 → 실제 피해 */
  b.send({ type: 'pguard', on: false });
  await sleep(760);
  const hpBefore = (a.state().ents.find((e) => e.s === startB.you) || {}).hp;
  a.send({ type: 'pattack', yaw: 0 });
  const hit = await a.wait((m) => m.type === 'phit' && m.to === startB.you, 2500).catch(() => null);
  ok('실제 PVP 타격 — 상대 체력이 줄어든다', !!hit && hit.dmg > 0 && hit.hp < hpBefore,
    hit && { dmg: hit.dmg, hp: hit.hp, before: hpBefore });
  const stateB = await b.wait((m) => m.type === 'pstate' && m.ents.some((e) => e.s === startB.you && e.hp < hpBefore), 2500).catch(() => null);
  ok('맞은 쪽도 자기 체력 변화를 받는다', !!stateB);

  /* 킬 → 점수 */
  for (let i = 0; i < 24; i++) {
    const s = a.state();
    const foeNow = s.ents.find((e) => e.s === startB.you);
    if (!foeNow || foeNow.d) break;
    const meNow = s.ents.find((e) => e.s === startA.you);
    if (Math.hypot(meNow.x - foeNow.x, meNow.z - foeNow.z) > 2.4) {
      await walk(a, startA.you, foeNow.x, foeNow.z - 1.4, 0, 24);
    }
    a.send({ type: 'pattack', yaw: 0 });
    await sleep(700);
  }
  const death = await a.wait((m) => m.type === 'pdeath' && m.to === startB.you, 3000).catch(() => null);
  ok('상대를 쓰러뜨리면 킬 이벤트', !!death && death.by === startA.you, death && { by: death.by });
  const scoreState = await a.wait((m) => m.type === 'pstate' && m.score.ally + m.score.enemy >= 1, 3000);
  ok('점수가 실시간으로 오른다', scoreState.score.ally + scoreState.score.enemy >= 1, scoreState.score);

  const respawn = await b.wait((m) => m.type === 'prespawn' && m.to === startB.you, 5000).catch(() => null);
  ok('쓰러진 플레이어는 3초 뒤 부활한다', !!respawn && respawn.hp > 0, respawn && { hp: respawn.hp });

  /* 킬 목표(3킬)까지 마저 싸워 라운드를 끝낸다 */
  a.clear();
  for (let i = 0; i < 22; i++) {
    let s = a.state() || b.state();
    a.send({ type: 'psync' });
  await sleep(120);
    if (!s) break;
    if (s.phase === 'over') break;
    let foeNow = s.ents.find((e) => e.s === startB.you);
    let meNow = s.ents.find((e) => e.s === startA.you);
    if (!foeNow || !meNow) break;
    if (foeNow.d) { await sleep(400); continue; }
    if (Math.hypot(meNow.x - foeNow.x, meNow.z - foeNow.z) > 2.2) {
      await walk(a, startA.you, foeNow.x, foeNow.z - 1.4, 0, 90);
      s = a.state() || b.state();
      foeNow = s && s.ents.find((e) => e.s === startB.you);
      meNow = s && s.ents.find((e) => e.s === startA.you);
      if (!foeNow || !meNow || foeNow.d) continue;
      if (Math.hypot(meNow.x - foeNow.x, meNow.z - foeNow.z) > 2.6) continue;
    }
    a.send({ type: 'pattack', yaw: 0 });
    await sleep(680);
  }
  const over = await a.wait((m) => m.type === 'pover', 3000).catch(() => null);
  ok('킬 목표를 채우면 라운드 종료(승패)가 양쪽에 온다', !!over && over.winner === 'ally' && over.score.ally >= 3,
    over && { winner: over.winner, score: over.score });

  /* 방장 재대결 */
  a.send({ type: 'prematch' });
  const re = await b.wait((m) => m.type === 'pstart' && m.rematch, 3000).catch(() => null);
  ok('재대결이 양쪽에 전달된다', !!re && re.roster.length === 2, re && { rematch: re.rematch });

  /* 나가기 */
  a.send({ type: 'leave' });
  await sleep(200);
  a.ws.close();
  b.ws.close();
  server.close();
}

(async () => {
  await engineTests();
  await networkTests();
  console.log('\n플레이어 PVP 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
