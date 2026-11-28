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
  /* ⚔️ PVP 병종은 일반 병사 고정 */
  const picked = P.handleMessage(room, room.players[0], 'pclass', { cls: 'knight' });
  ok('PVP 병종은 일반 병사로 고정 (다른 병종 요청도 soldier)', picked.ok && picked.fixed === true &&
    P.entOf(st, room.players[0]).cls === 'soldier' &&
    P.entOf(st, room.players[0]).maxHp === P.PVP.soldier.hp,
    { cls: P.entOf(st, room.players[0]).cls });
  ok('없는 병종은 거절', P.handleMessage(room, room.players[0], 'pclass', { cls: 'dragon' }).error[0] === 'BAD_CLASS');
  ok('방장이 아닌 사람은 설정 불가',
    P.handleMessage(room, room.players[1], 'pconf', { bots: { ally: 2, enemy: 2 } }).error[0] === 'HOST_ONLY');
  ok('방장은 설정 가능', P.handleMessage(room, room.players[0], 'pconf', { mode: 'kills', killTarget: 3, bots: { ally: 0, enemy: 0 } }).ok &&
    st.killTarget === 3 && st.botCfg.ally === 0);
  /* ⚡ 1킬 — 단판 승부도 고를 수 있다 */
  ok('승리 조건 1킬도 허용된다',
    P.handleMessage(room, room.players[0], 'pconf', { mode: 'kills', killTarget: 1 }).ok && st.killTarget === 1,
    { killTarget: st.killTarget });
  P.handleMessage(room, room.players[0], 'pconf', { mode: 'kills', killTarget: 3 });

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

  console.log('💥 PVP 전용 밸런스 — 체력 1000 · 공격 100 · 회복 없음');
  ok('PVP 최대 체력은 1000', P.PVP.soldier.hp === 1000 && P.PVP_HP === 1000, { hp: P.PVP.soldier.hp });
  ok('PVP 기본 공격력은 100', P.PVP.soldier.damage === 100 && P.PVP_DAMAGE === 100, { dmg: P.PVP.soldier.damage });
  ok('대기실 규칙 값도 1000 · 100 · 회복 0', (() => {
    const lb = P.lobbyPayload(room, room.players[0]);
    return lb.rules && lb.rules.hp === 1000 && lb.rules.damage === 100 &&
      lb.rules.regen === 0 && lb.rules.lifesteal === 0;
  })(), P.lobbyPayload(room, room.players[0]).rules);
  ok('자연 회복 배율 0 · 적중 흡혈 배율 0', P.CFG.regenFrac === 0 && P.CFG.lifestealFrac === 0,
    { regen: P.CFG.regenFrac, lifesteal: P.CFG.lifestealFrac });
  const ent0 = P.entOf(st, room.players[0]);
  ok('참가자 엔트리도 1000/1000', ent0.maxHp === 1000 && ent0.hp === 1000, { hp: ent0.hp, mx: ent0.maxHp });

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
  ok('일반 병사 한 방 = 100 피해', Math.abs(dealt - 100) < 0.01, dealt);
  /* 💥 회복 없음 — 맞혀도 공격자는 차지 않는다 */
  me.hp = me.maxHp - 200;
  const hpBeforeHit = me.hp;
  foe.hp = foe.maxHp; foe.guard = false; me.nextAttackAt = 0;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('적중해도 흡혈하지 않는다 (회복 0)', me.hp === hpBeforeHit, { hp: me.hp, before: hpBeforeHit });
  ok('맞은 쪽은 정확히 100 이 줄어든다', Math.abs(foe.maxHp - foe.hp - 100) < 0.01, { hp: foe.hp, mx: foe.maxHp });

  /* 같은 순간 연타는 쿨타임에 막힌다 */
  const hp1 = foe.hp;
  P.handleMessage(room, room.players[0], 'pattack', { yaw: 0 });
  ok('공속 주기 안의 연타는 서버가 막는다', Math.abs(foe.hp - hp1) < 0.001, { hp: foe.hp });

  /* 💥 회복 없음 — 시간이 지나도 자연 회복이 없다 */
  const regenHp = me.hp;
  await stepFor(room, 1200);
  ok('1초 넘게 지나도 자연 회복이 없다', me.hp === regenHp, { hp: me.hp, before: regenHp });

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

  console.log('⚡ 1킬 단판 승리');
  {
    const one = fakeRoom(2);
    P.handleMessage(one, one.players[0], 'pconf', { mode: 'kills', killTarget: 1, bots: { ally: 0, enemy: 0 } });
    P.handleMessage(one, one.players[0], 'pteam', { team: 'ally' });
    P.handleMessage(one, one.players[1], 'pteam', { team: 'enemy' });
    P.startBattle(one, { bySlot: 0 });
    const o1 = P.entOf(one.pvp, one.players[0]);
    const o2 = P.entOf(one.pvp, one.players[1]);
    o1.x = 0; o1.z = 0; o1.yaw = 0; o2.x = 0; o2.z = 1.6; o2.hp = 1; o2.guard = false;
    P.handleMessage(one, one.players[0], 'pattack', { yaw: 0 });
    ok('1킬이면 한 명 쓰러지는 순간 라운드 종료(승리)',
      one.pvp.phase === 'over' && one.pvp.over.winner === 'ally' && one.pvp.over.reason === 'target' &&
      one.pvp.score.ally === 1, one.pvp.over);
  }

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

  console.log('🥊 PVP 일반 병사 고정 — 마법·일섬 없음');
  const wiz = fakeRoom(2);
  P.handleMessage(wiz, wiz.players[0], 'pclass', { cls: 'wizard' });
  P.handleMessage(wiz, wiz.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(wiz, wiz.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(wiz, { bySlot: 0 });
  const w = P.entOf(wiz.pvp, wiz.players[0]);
  const t = P.entOf(wiz.pvp, wiz.players[1]);
  ok('마법사로 신청해도 일반 병사로 참전', w.cls === 'soldier' && t.cls === 'soldier',
    { a: w.cls, b: t.cls });
  w.x = 0; w.z = 0; t.x = 0; t.z = 6; t.hp = t.maxHp;
  P.handleMessage(wiz, wiz.players[0], 'pspell', { key: 'fire', x: 0, z: 6 });
  await stepFor(wiz, 400);
  ok('PVP 에서는 마법을 쓸 수 없다 (화염구 무효)', t.hp === t.maxHp && wiz.pvp.pending.length === 0, { hp: t.hp });

  const bm = fakeRoom(2);
  P.handleMessage(bm, bm.players[0], 'pclass', { cls: 'blademaster' });
  P.handleMessage(bm, bm.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(bm, bm.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(bm, { bySlot: 0 });
  const s = P.entOf(bm.pvp, bm.players[0]);
  const v = P.entOf(bm.pvp, bm.players[1]);
  s.x = 0; s.z = 0; s.yaw = 0; v.x = 0; v.z = 4; v.hp = v.maxHp;
  P.handleMessage(bm, bm.players[0], 'pskill', { yaw: 0 });
  ok('PVP 에서는 매화 일섬도 쓸 수 없다', v.hp === v.maxHp && !s.nextSkillAt, { hp: v.hp });

  console.log('🛡️ PVP 검 막기 — 쿨타임·유지 시간·100% 반사');
  const g = fakeRoom(2);
  P.handleMessage(g, g.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(g, g.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(g, { bySlot: 0 });
  const atk = P.entOf(g.pvp, g.players[0]);
  const def = P.entOf(g.pvp, g.players[1]);
  atk.x = 0; atk.z = 0; atk.yaw = 0;
  def.x = 0; def.z = 1.6; def.yaw = Math.PI;
  ok('검 막기를 켜면 막기 상태', P.setGuard(g, g.players[1], true).ok && def.guard === true);
  ok('검 막기는 한 번 누르면 1.0초 동안 유지된다', P.CFG.guardHold === 1 &&
    def.guardUntil - def.guardAt === 1000, { hold: P.CFG.guardHold, ms: def.guardUntil - def.guardAt });
  ok('막기 유지 시간이 정해져 있다', def.guardUntil - def.guardAt === P.CFG.guardHold * 1000,
    { ms: def.guardUntil - def.guardAt });

  const hpAtk0 = atk.hp;
  P.handleMessage(g, g.players[0], 'pattack', { yaw: 0 });
  ok('정면으로 막으면 수비자는 피해 0', def.hp === def.maxHp, { hp: def.hp });
  const reflected = hpAtk0 - atk.hp;
  ok('막아낸 피해 100%가 공격자에게 반사된다',
    Math.abs(reflected - Math.round(P.PVP.soldier.damage * P.CFG.guardReflect)) < 1.2 &&
    Math.abs(reflected - P.PVP.soldier.damage) < 1.2, { reflected, dmg: P.PVP.soldier.damage });

  /* 막기 쿨타임 — 유지 시간이 끝나면 자동 해제 + 쿨타임 동안은 다시 못 켠다 */
  await stepFor(g, P.CFG.guardHold * 1000 + 220);
  ok('최대 유지 시간이 지나면 막기가 풀린다', def.guard === false);
  ok('막기가 풀리면 쿨타임이 시작된다', def.guardCdUntil > Date.now() - 50 &&
    def.guardCdUntil - Date.now() <= P.CFG.guardCooldown * 1000, { left: def.guardCdUntil - Date.now() });
  const denied = P.setGuard(g, g.players[1], true);
  ok('쿨타임 중에는 막기를 다시 켤 수 없다', denied.ok === false && def.guard === false && denied.cd > 0,
    { cd: denied.cd });
  /* 그동안 들어오는 공격은 그대로 맞는다 */
  def.hp = def.maxHp;
  atk.nextAttackAt = 0;
  atk.hp = atk.maxHp;
  P.handleMessage(g, g.players[0], 'pattack', { yaw: 0 });
  ok('쿨타임 중에는 막지 못해 피해가 들어간다', def.hp < def.maxHp, { hp: def.hp });

  await sleep(P.CFG.guardCooldown * 1000 + 260);
  ok('쿨타임이 끝나면 다시 막을 수 있다', P.setGuard(g, g.players[1], true).ok && def.guard === true);
  const beforeOff = Date.now();
  P.setGuard(g, g.players[1], false);
  ok('막기를 풀어도 쿨타임이 시작된다', def.guard === false && def.guardCdUntil - beforeOff >= P.CFG.guardCooldown * 1000 - 40);
  ok('풀자마자 다시 켜는 연타 막기도 막힌다', P.setGuard(g, g.players[1], true).ok === false);

  /* 반사 킬 — 반사 피해로 공격자가 쓰러지면 수비자 킬 */
  const gk = fakeRoom(2);
  P.handleMessage(gk, gk.players[0], 'pteam', { team: 'ally' });
  P.handleMessage(gk, gk.players[1], 'pteam', { team: 'enemy' });
  P.startBattle(gk, { bySlot: 0 });
  const a2 = P.entOf(gk.pvp, gk.players[0]);
  const d2 = P.entOf(gk.pvp, gk.players[1]);
  a2.x = 0; a2.z = 0; a2.yaw = 0; a2.hp = 60;
  d2.x = 0; d2.z = 1.6; d2.yaw = Math.PI;
  P.setGuard(gk, gk.players[1], true);
  P.handleMessage(gk, gk.players[0], 'pattack', { yaw: 0 });
  ok('반사 피해로 공격자가 쓰러진다', a2.dead && a2.hp === 0);
  ok('반사 킬은 수비자 킬로 정상 처리', d2.kills === 1 && gk.pvp.score.enemy === 1,
    { kills: d2.kills, score: gk.pvp.score });

  console.log('⚔️ 막기 유지 중 공격 — 즉시 해제 + 그때부터 쿨타임');
  {
    const gm = fakeRoom(2);
    P.handleMessage(gm, gm.players[0], 'pteam', { team: 'ally' });
    P.handleMessage(gm, gm.players[1], 'pteam', { team: 'enemy' });
    P.startBattle(gm, { bySlot: 0 });
    const aM = P.entOf(gm.pvp, gm.players[0]);
    const dM = P.entOf(gm.pvp, gm.players[1]);
    aM.x = 0; aM.z = 0; aM.yaw = 0;
    dM.x = 0; dM.z = 1.6; dM.yaw = Math.PI;
    P.setGuard(gm, gm.players[1], true);
    ok('막기 유지 중 (아직 안 풀렸다)', dM.guard === true && dM.guardUntil > Date.now());
    await sleep(140);
    const tSwing = Date.now();
    P.handleMessage(gm, gm.players[1], 'pattack', { yaw: Math.PI });
    ok('막기 중에 베면 막기가 즉시 해제된다', dM.guard === false && dM.guardUntil === 0, { guard: dM.guard });
    ok('해제 시점부터 막기 쿨타임이 시작된다',
      Math.abs(dM.guardCdUntil - tSwing - P.CFG.guardCooldown * 1000) < 40,
      { cdLeft: dM.guardCdUntil - tSwing, cdMax: P.CFG.guardCooldown * 1000 });
    ok('해제돼도 베기는 그대로 나간다 (상대 피해)', aM.hp < aM.maxHp, { hp: aM.hp, mx: aM.maxHp });
    ok('해제 직후 막기를 다시 켜는 연타는 막힌다', P.setGuard(gm, gm.players[1], true).ok === false && dM.guard === false);
  }

  console.log('🥊 UFC 옥타곤 링 경계');
  ok('8각형 링 밖 좌표는 경계로 되돌아온다', (() => {
    const c = P.clampOctagon(60, 0);
    return c.hit && Math.abs(c.x - P.CFG.octApothem / Math.cos(Math.PI / 8)) < 0.01;
  })(), P.clampOctagon(60, 0));
  const inside = P.entOf(gk.pvp, gk.players[1]);
  inside.x = 0; inside.z = 0; inside.lastInputAt = 0;
  for (let i = 0; i < 30; i++) {
    P.handleMessage(gk, gk.players[1], 'pinput', { x: 60, z: 0, yaw: 0, pitch: 0 });
    await sleep(28);
  }
  ok('플레이어는 옥타곤 링 밖으로 나갈 수 없다',
    inside.x <= P.CFG.octApothem / Math.cos(Math.PI / 8) + 0.02 && inside.x > 2, { x: inside.x });

  console.log('🛡️ 이상한 요청·끊긴 소켓에도 서버가 죽지 않는다');
  {
    const rb = fakeRoom(2);
    P.handleMessage(rb, rb.players[0], 'pteam', { team: 'ally' });
    P.handleMessage(rb, rb.players[1], 'pteam', { team: 'enemy' });
    P.startBattle(rb, { bySlot: 0 });
    const e0 = P.entOf(rb.pvp, rb.players[0]);
    const e1 = P.entOf(rb.pvp, rb.players[1]);
    const bad = [
      ['pinput', {}], ['pinput', { x: 'abc', z: null, yaw: NaN }], ['pinput', { x: 1e12, z: -1e12 }],
      ['pattack', {}], ['pattack', { yaw: 'left' }], ['pguard', {}], ['pguard', { on: 'yes' }],
      ['pspell', { key: 'fire' }], ['pskill', {}], ['pteam', {}], ['pclass', {}], ['pconf', {}]
    ];
    for (const [t, m] of bad) P.handleMessage(rb, rb.players[0], t, m);
    ok('NaN·누락 필드 요청이 와도 방과 체력이 멀쩡하다',
      rb.pvp.phase === 'battle' && Number.isFinite(e0.hp) && Number.isFinite(e1.hp) &&
      Number.isFinite(e0.x) && Number.isFinite(e1.z), { hp: [e0.hp, e1.hp], pos: [e0.x, e0.z] });
    ok('참가자 없는 요청도 에러만 돌려준다', P.handleMessage(rb, null, 'pinput', {}).error[0] === 'NO_PLAYER');
    ok('알 수 없는 타입은 BAD_TYPE', P.handleMessage(rb, rb.players[0], 'zzz', {}).error[0] === 'BAD_TYPE');
    ok('NaN 피해는 무시된다 (체력이 NaN 이 되지 않는다)',
      P.hurt(rb, rb.pvp, e1, NaN, e0, 'blade') === 0 && Number.isFinite(e1.hp), { hp: e1.hp });
    /* 끊긴 소켓(readyState 3)·null 소켓에 방송해도 예외가 없다 */
    rb.players[0].ws = { readyState: 3, send() { throw new Error('closed'); } };
    let threw = false;
    try { P.broadcastState(rb); P.handleDisconnect(rb, rb.players[0]); } catch (e) { threw = true; }
    ok('끊긴 소켓으로 방송·정리해도 예외가 없다', threw === false);
    rb.players[0].ws = null;
    threw = false;
    try { P.broadcastLobby(rb); P.sendState(rb, rb.players[0]); } catch (e) { threw = true; }
    ok('소켓이 없어도 대기실 방송이 죽지 않는다', threw === false);
  }

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
  /* 💥 체력 1000 · 공격 100 → 한 명 쓰러뜨리는 데 10대 (예전 620/115 = 6대) */
  for (let i = 0; i < 40; i++) {
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
  for (let i = 0; i < 64; i++) {
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
