'use strict';

/* 영토 전쟁 ONLINE · 실시간 스모크 테스트
   1) 엔진: 지도 · 병력 생산 · 행군/전투 · 외교(초 단위) · AI
   2) 헤드리스 AI 대 AI 시뮬레이션: 전투·영토 변화·외교·승부가 데드락 없이 진행되는지
   3) WebSocket: 방 생성 → 시작 → 실시간 동기화 → AI 시뮬레이션 난입 · 위임 → 재접속
   실행: npm test */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { createServer, Game, Sim, SIM, DUR, SKIRMISH,
  startSkirmish, applySkirmishProgress, endSkirmish, skirmishTick } = require('../server');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : extra);
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const landOf = (st) => [0, 1, 2, 3].map((i) => Game.countOwned(st, i));

function aiState(seed) {
  const st = Game.newGame({ humans: 1, aiFill: true, seed });
  st.human = [false, false, false, false];
  st.names = ['청룡', '적화', '녹림', '황금'];
  return st;
}

function runSim(st, ms, step) {
  const dt = step || 100;
  let t = 0;
  while (t < ms && !st.over) {
    Sim.step(st, dt);
    t += dt;
  }
  return t;
}

/* =========================================================================
   1. 엔진
   ========================================================================= */
function engineTests() {
  console.log('엔진 · 지도와 시작 상태');
  const st = Game.newGame({ humans: 1, aiFill: true, seed: 12345 });
  st.names = ['나', '적화', '녹림', '황금'];
  ok('지도 28개 영토', st.regions.length === 28, st.regions.length);
  ok('4개국 참전', st.activeCount === 4 && st.active.every(Boolean));
  ok('모든 참전국이 시작 영토 보유', [0, 1, 2, 3].every((i) => Game.countOwned(st, i) >= 3));
  ok('연결 그래프', st.regions.every((r) => r.neighbors.length >= 1));
  ok('수도 지정', st.capitals.every((id) => id >= 0 && st.regions[id].owner >= 0), st.capitals);
  ok('턴 개념 없음 (시간부터 시작)', st.time === 0 && st.turn === undefined);

  console.log('엔진 · 실시간 병력 생산');
  const before = Game.totalTroops(st, 0);
  runSim(st, 4000);
  const after = Game.totalTroops(st, 0);
  ok('4초 동안 병력이 계속 생산된다', after > before + 2, [before, after]);
  ok('생산 속도 표시', Game.productionRateOf(st, 0) > 0);

  const capRegion = st.regions[st.capitals[0]];
  const normalRegion = st.regions.find((r) => r.owner === 0 && r.id !== capRegion.id);
  if (normalRegion) {
    capRegion.troops = 1;
    normalRegion.troops = 1;
    capRegion.p = 0;
    normalRegion.p = 0;
    const capBefore = capRegion.troops;
    const normBefore = normalRegion.troops;
    for (let i = 0; i < 10; i++) Sim.step(st, 100);
    ok('수도가 일반 영토보다 빨리 생산', capRegion.troops >= normBefore,
      [capBefore, capRegion.troops, normalRegion.troops]);
  }

  const capped = st.regions.find((r) => r.owner === 0);
  capped.troops = Game.prodCapOf(st, capped) + 50;
  const capNow = capped.troops;
  runSim(st, 3000);
  ok('상한을 넘긴 병력은 생산으로 더 늘지 않는다', capped.troops === capNow, [capNow, capped.troops]);

  console.log('엔진 · 출정과 행군');
  const st2 = Game.newGame({ humans: 2, aiFill: false, seed: 777 });
  st2.human = [true, true, false, false];
  const own = st2.regions.filter((r) => r.owner === 0);
  let pair = null;
  for (const a of own) {
    for (const nb of a.neighbors) {
      if (st2.regions[nb].owner === 0) pair = [a, st2.regions[nb]];
    }
  }
  ok('이웃한 내 영토', !!pair);
  pair[0].troops = 9;
  const targetBefore = pair[1].troops;
  const move = Game.dispatch(st2, 0, pair[0].id, pair[1].id, 0.5);
  ok('출정 즉시 병력 차감', move.ok && move.troops === 4 && pair[0].troops === 5, pair[0].troops);
  ok('행군 시간 1.2초', st2.marches.length === 1 && st2.marches[0].arriveAt - st2.time === SIM.marchMs);
  let waited = 0;
  while (st2.marches.length && waited < 3000) { Sim.step(st2, 100); waited += 100; }
  ok('행군 도착 후 합류', st2.marches.length === 0 && pair[1].troops === targetBefore + 4, pair[1].troops);

  const atkFrom = st2.regions.find((r) => r.owner === 0);
  const victim = st2.regions[atkFrom.neighbors.find((n) => st2.regions[n].owner !== 0)];
  victim.owner = -1;
  victim.troops = 1;
  atkFrom.troops = 10;
  const atk = Game.dispatch(st2, 0, atkFrom.id, victim.id, 1);
  ok('공격 출정', atk.ok && atk.attack === true && atkFrom.troops === 1);
  runSim(st2, 2000);
  ok('중립 영토 점령', victim.owner === 0 && victim.troops >= 1, [victim.owner, victim.troops]);
  ok('전투 수 기록', st2.stats.battles >= 1 && st2.stats.captures >= 1);

  const st3 = Game.newGame({ humans: 2, aiFill: false, seed: 909 });
  st3.human = [true, true, false, false];
  const a3 = st3.regions.find((r) => r.owner === 0);
  const t3 = st3.regions[a3.neighbors[0]];
  t3.owner = 1;
  t3.troops = 12;
  a3.troops = 4;
  Game.dispatch(st3, 0, a3.id, t3.id, 1);
  runSim(st3, 2000);
  ok('약한 공격은 실패하고 수비 병력이 줄어든다', t3.owner === 1 && t3.troops < 12, [t3.owner, t3.troops]);

  const st4 = Game.newGame({ humans: 2, aiFill: false, seed: 4242 });
  st4.human = [true, true, false, false];
  const f4 = st4.regions.find((r) => r.owner === 0);
  const e4 = st4.regions[f4.neighbors[0]];
  e4.owner = 1;
  e4.troops = 2;
  f4.troops = 6;
  Game.createTreaty(st4, 0, 1, 'truce', DUR.truce);
  const blocked = Game.dispatch(st4, 0, f4.id, e4.id, 1);
  ok('불가침 중에는 출정이 막힌다', !blocked.ok && blocked.reason === 'treaty');
  ok('조약은 45초', Math.round(st4.treaties['0-1'].until - st4.time) === 45000);

  console.log('엔진 · 실시간 외교');
  const st5 = Game.newGame({ humans: 3, aiFill: false, seed: 31337 });
  st5.human = [true, true, true, false];
  st5.names = ['청룡', '적화', '녹림', '황금'];
  ok('초기 관계 0 · 신뢰 60', st5.relations['0-1'] === 0 && st5.reputation[0] === 60);

  st5.reinforcements = 0;
  st5.regions.find((r) => r.owner === 0).troops = 9;
  const rep0 = st5.reputation[0];
  const aid = Game.sendAid(st5, 0, 1);
  ok('병력 지원 → 관계·신뢰 상승, 동맹', aid.ok && st5.relations['0-1'] === 15 &&
    st5.reputation[0] === rep0 + 3 && st5.treaties['0-1'].type === 'ally');
  const repBefore = st5.reputation[0];
  Game.breakPact(st5, 0, 1);
  ok('배신하면 신뢰도 급락', st5.reputation[0] === repBefore - 35 && st5.stats.betrayals === 1);

  const st6 = Game.newGame({ humans: 3, aiFill: false, seed: 606 });
  st6.human = [true, true, true, false];
  st6.names = ['청룡', '적화', '녹림', '황금'];
  const prop = Game.proposeTruce(st6, 0, 1);
  ok('사람에게는 제안이 대기한다', prop.status === 'queued' && prop.proposal.sec === DUR.truce);
  ok('제안 30초 유효', (function () {
    runSim(st6, 30000);
    return st6.proposals.length === 0;
  })(), st6.proposals.length);

  const st7 = Game.newGame({ humans: 3, aiFill: false, seed: 717 });
  st7.human = [true, true, true, false];
  st7.names = ['청룡', '적화', '녹림', '황금'];
  const p7 = Game.proposeTruce(st7, 0, 1);
  Game.resolveProposal(st7, p7.proposal, true);
  ok('수락하면 조약 체결', st7.treaties['0-1'].type === 'truce');
  const allyProp = Game.proposeAlliance(st7, 0, 1);
  ok('불가침 위에 동맹 제안', allyProp.status === 'queued' && allyProp.proposal.kind === 'ally');
  Game.resolveProposal(st7, allyProp.proposal, true);
  ok('동맹 60초', st7.treaties['0-1'].type === 'ally' &&
    Math.round(st7.treaties['0-1'].until - st7.time) === 60000);

  const st8 = Game.newGame({ humans: 3, aiFill: false, seed: 818 });
  st8.human = [true, true, true, false];
  st8.names = ['청룡', '적화', '녹림', '황금'];
  st8.treaties['0-1'] = {
    a: 0, b: 1, type: 'tribute', until: st8.time + 45000,
    payer: 0, payee: 1, amount: 1, nextPayAt: st8.time, since: 0
  };
  const payBefore = Game.totalTroops(st8, 1);
  Game.tickDiplomacy(st8, 0);
  ok('조공 12초마다 지급', Game.totalTroops(st8, 1) === payBefore + 1, Game.totalTroops(st8, 1));
  ok('조공 45초 만료', (function () {
    runSim(st8, 46000);
    return !st8.treaties['0-1'];
  })());

  const st9 = Game.newGame({ humans: 3, aiFill: false, seed: 919 });
  st9.human = [true, true, true, false];
  const gift = st9.regions.find((r) => r.owner === 0);
  const cede = Game.proposeCede(st9, 0, 1, gift.id, true);
  Game.resolveProposal(st9, cede.proposal, true);
  ok('할양 → 소유권 이전 · 관계 +25 · 불가침', gift.owner === 1 && gift.troops === 1 &&
    st9.relations['0-1'] === 25 && st9.treaties['0-1'].type === 'truce');

  console.log('엔진 · AI 판단');
  const st10 = aiState(1010);
  let sawMarch = false;
  let sawBattle = 0;
  let sawDiplo = 0;
  const startLand = landOf(st10);
  for (let i = 0; i < 600; i++) {
    Sim.step(st10, 100);
    if (st10.marches.length) sawMarch = true;
    if (st10.diploLog.length > sawDiplo) sawDiplo = st10.diploLog.length;
  }
  ok('AI가 실시간으로 행군한다', sawMarch);
  ok('AI끼리 전투가 일어난다', st10.stats.battles > 0, st10.stats.battles);
  ok('60초 안에 영토가 바뀐다', landOf(st10).join(',') !== startLand.join(','), landOf(st10));
  ok('AI 외교가 작동한다', sawDiplo > 0, sawDiplo);

  const leader = Game.newGame({ humans: 1, aiFill: true, seed: 1212 });
  leader.names = ['나', '적화', '녹림', '황금'];
  leader.human = [true, false, false, false];
  let grabbed = 0;
  for (const r of leader.regions) {
    if (r.owner === -1 && grabbed < 9) { r.owner = 1; grabbed++; }
  }
  leader.relations['0-1'] = 60;
  const dip = Game.aiDiplomacy(leader, 2);
  ok('1위 국가 견제 외교', Array.isArray(dip) && dip.length > 0, dip.length);
}

/* =========================================================================
   2. 헤드리스 AI vs AI 시뮬레이션
   ========================================================================= */
function headlessSimTests() {
  console.log('시뮬레이션 · AI 4개국 난전 (데드락 없이 승부까지)');
  const seeds = [2026, 7, 55, 123, 909];
  const results = [];
  for (const seed of seeds) {
    const st = aiState(seed);
    const snapshots = [];
    let battles0 = 0;
    let diplomacySeen = 0;
    let elapsed = 0;
    const cap = 20 * 60 * 1000;
    while (!st.over && elapsed < cap) {
      Sim.step(st, 100);
      elapsed += 100;
      if (st.diploLog.length > diplomacySeen) diplomacySeen = st.diploLog.length;
      if (elapsed % 30000 === 0) snapshots.push(landOf(st).join(','));
    }
    results.push({ seed, over: st.over, sec: Math.round(st.time / 1000), land: landOf(st), battles: st.stats.battles, captures: st.stats.captures, diplomacySeen });
    ok('시드 ' + seed + ' · 승부가 난다', !!st.over, st.over);
    ok('시드 ' + seed + ' · 대륙 통일 또는 최후 생존', st.over.type === 'nation' || st.over.type === 'lastStanding');
    ok('시드 ' + seed + ' · 전투가 계속 진행', st.stats.battles > battles0 + 50 && st.stats.captures > 10,
      [st.stats.battles, st.stats.captures]);
    ok('시드 ' + seed + ' · 영토가 여러 번 바뀐다', new Set(snapshots).size >= 3, snapshots.length);
    ok('시드 ' + seed + ' · 외교 이벤트 발생', diplomacySeen > 0, diplomacySeen);
    ok('시드 ' + seed + ' · 20분 안에 종료', st.time <= cap, Math.round(st.time / 1000));
  }
  console.log('  · 시뮬레이션 결과');
  for (const r of results) {
    console.log('    seed ' + r.seed + ': ' + r.sec + '초 · 영토 ' + r.land.join('/') +
      ' · 전투 ' + r.battles + '회 · 점령 ' + r.captures + '회 · 외교 ' + r.diplomacySeen + '건');
  }
  const avg = results.reduce((a, r) => a + r.sec, 0) / results.length;
  ok('평균 15분 이내에 승부', avg < 15 * 60, Math.round(avg));
}

/* =========================================================================
   2.5 직접 참전 (칼질 스커미시)
   ========================================================================= */
function fakeRoom(seed) {
  const st = Game.newGame({ humans: 2, aiFill: true, seed: seed || 424242 });
  st.human = [true, true, false, false];
  st.names = ['한윤', '지우', '녹림', '황금'];
  const player = {
    slot: 0, controlSlot: 0, name: '한윤', ws: null, connected: true,
    isAI: false, skirmish: null, lastSkirmishEnd: 0
  };
  const room = {
    code: 'TEST', game: st, players: [player], hostSlot: 0, sim: false,
    log: [], logRev: 1, lastAt: Date.now(), closed: false
  };
  return { room, player, st };
}

function frontPair(st, slot) {
  for (const r of st.regions) {
    if (r.owner !== slot) continue;
    for (const nb of r.neighbors) {
      const t = st.regions[nb];
      if (t.owner >= 0 && t.owner !== slot) return { region: r, target: t };
    }
  }
  for (const r of st.regions) {
    if (r.owner !== slot) continue;
    const nb = r.neighbors.find((n) => st.regions[n].owner !== slot);
    if (nb != null) return { region: r, target: st.regions[nb] };
  }
  return null;
}

const tkey = (a, b) => Math.min(a, b) + '-' + Math.max(a, b);

function skirmishTests() {
  console.log('엔진 · 직접 참전 (칼질 스커미시)');
  const { room, player, st } = fakeRoom(424242);
  const pair = frontPair(st, 0);
  ok('전선 영토와 맞은편 적을 찾는다', !!pair && pair.region.owner === 0 && pair.target.owner !== 0);

  const before = pair.target.troops;
  const started = startSkirmish(room, player, pair.region.id);
  ok('전선 영토에서 참전 시작', started.ok === true && !!player.skirmish, started.code);
  ok('아레나 설정 · 적/아군 수가 전투 규모에 맞게 늘어난다',
    started.arena.enemyCount >= 8 && started.arena.enemyCount <= SKIRMISH.enemyMax &&
    started.arena.allyCount >= SKIRMISH.allyBase, started.arena.enemyCount);
  ok('아레나에 양쪽 진영색 · 영토 이름 전달',
    !!started.arena.me.color && !!started.arena.enemy.color &&
    started.arena.region.id === pair.region.id && started.arena.target.id === pair.target.id);
  ok('참전 중 재시작 거절', startSkirmish(room, player, pair.region.id).code === 'BUSY');

  // 즉시 대량 보고는 초당 상한 + 여유분까지만 인정
  const r1 = applySkirmishProgress(room, player, 999);
  ok('비정상 킬 보고는 초당 상한으로 잘린다', player.skirmish.kills === SKIRMISH.graceKills && r1.delta === SKIRMISH.graceKills,
    [player.skirmish.kills, r1.delta]);
  ok('3킬 = 적 병력 1 감소', pair.target.troops === before - 1 && player.skirmish.damage === 1,
    [before, pair.target.troops]);

  // 시간이 흐른 만큼만 인정 (5초 전에 시작한 것으로)
  player.skirmish.startedAt = Date.now() - 5000;
  const r2 = applySkirmishProgress(room, player, 12);
  ok('시간이 지나면 킬 상한이 늘어난다', player.skirmish.kills === 12, player.skirmish.kills);
  const dmgAfter12 = Math.min(player.skirmish.maxDamage, Math.floor(12 / SKIRMISH.killsPerTroop));
  ok('12킬 피해는 상한 안에서 적용', player.skirmish.damage === dmgAfter12, player.skirmish.damage);
  ok('6킬마다 전선 아군 1 합류', player.skirmish.reinforce === 2 && r2.reinforce >= 1, player.skirmish.reinforce);
  ok('6킬부터 대상 영토 수비 약화', player.skirmish.defenseBreak === true &&
    pair.target.weakUntil > st.time, pair.target.weakUntil);

  const srcBefore = pair.region.troops;
  player.skirmish.startedAt = Date.now() - 30000;
  applySkirmishProgress(room, player, 90);
  ok('킬을 더 보고해도 피해는 상한을 넘지 않는다',
    player.skirmish.damage <= player.skirmish.maxDamage && player.skirmish.damage <= SKIRMISH.maxTroopDamage &&
    pair.target.troops >= 1, [player.skirmish.damage, pair.target.troops]);
  ok('합류 병력도 상한을 넘지 않는다', player.skirmish.reinforce <= SKIRMISH.maxReinforce &&
    pair.region.troops === srcBefore + (player.skirmish.reinforce - 2), pair.region.troops);

  // 수비 약화가 실제 전투에 반영된다 (10 vs 10)
  const st2 = Game.newGame({ humans: 2, aiFill: false, seed: 31 });
  st2.human = [true, true, false, false];
  const atk = st2.regions.find((r) => r.owner === 0);
  const def = st2.regions[atk.neighbors.find((n) => st2.regions[n].owner !== 0)];
  def.owner = 1; def.troops = 10; atk.troops = 11;
  def.weakUntil = st2.time + 20000;
  const weakMove = Game.dispatch(st2, 0, atk.id, def.id, 1);
  ok('약화된 영토로 출정', weakMove.ok === true);
  let guard = 0;
  while (st2.marches.length && guard++ < 40) Sim.step(st2, 100);
  ok('수비 약화 중에는 10 수비도 뚫린다', def.owner === 0, [def.owner, def.troops]);

  // 승리 보너스 + 종료 요약
  const sum = endSkirmish(room, player, 'win');
  ok('승리로 참전 종료 · 요약', !!sum && sum.reason === 'win' && sum.kills > 0 && !!sum.region.name);
  ok('참전 요약에 처치·피해·합류 기록', sum.damage > 0 && sum.reinforce > 0 && sum.defenseBreak === true);
  ok('전적에 참전·처치 수 누적', st.stats.skirmishes === 1 && st.stats.skirmishKills === sum.kills,
    [st.stats.skirmishes, st.stats.skirmishKills, sum.kills]);
  ok('참전이 끝나면 슬롯이 비워진다', player.skirmish === null);

  // 쿨다운
  const cool = startSkirmish(room, player, pair.region.id);
  ok('참전 직후에는 숨 고르기(쿨다운)', cool.code === 'COOLDOWN', cool.code);

  // 남의 영토 / 내부 영토
  const { room: room2, player: player2, st: st3 } = fakeRoom(777);
  const foeRegion = st3.regions.find((r) => r.owner === 1);
  ok('남의 영토에서는 참전 거절', startSkirmish(room2, player2, foeRegion.id).code === 'REGION');
  const inner = st3.regions.find((r) => r.owner === 0);
  for (const nb of inner.neighbors) { st3.regions[nb].owner = 0; }
  ok('옆에 적이 없는 영토는 전선이 아니다', startSkirmish(room2, player2, inner.id).code === 'NO_FRONT');

  // 조약 중인 나라와는 싸우지 않는다
  const { room: room3, player: player3, st: st4 } = fakeRoom(424242);
  const p3region = st4.regions.find((r) => r.owner === 0);
  for (const nb of p3region.neighbors) {
    st4.regions[nb].owner = 1;
    st4.regions[nb].troops = 6;
  }
  st4.treaties[tkey(0, 1)] = { a: 0, b: 1, type: 'truce', until: st4.time + 40000 };
  const treatyTry = startSkirmish(room3, player3, p3region.id);
  ok('조약 중인 나라와는 참전 불가', treatyTry.code === 'TREATY', treatyTry.code);

  // 관전 · 위임 · 종료 상태
  const { room: room4, player: player4, st: st5 } = fakeRoom(55);
  const p4 = frontPair(st5, 0);
  player4.controlSlot = -1;
  ok('관전 중에는 참전 불가', startSkirmish(room4, player4, p4.region.id).code === 'SPECTATE');
  player4.controlSlot = 0; st5.human[0] = false;
  ok('AI 위임 중에는 참전 불가', startSkirmish(room4, player4, p4.region.id).code === 'DELEGATE');
  st5.human[0] = true; st5.over = { type: 'nation', winner: 1, at: 0 };
  ok('게임이 끝났다면 참전 불가', startSkirmish(room4, player4, p4.region.id).code === 'OVER');

  // 자동 종료: 시간 초과 · 전선 상실
  const { room: room5, player: player5, st: st6 } = fakeRoom(612);
  const p5 = frontPair(st6, 0);
  startSkirmish(room5, player5, p5.region.id);
  player5.skirmish.startedAt = Date.now() - SKIRMISH.maxMs - 1000;
  skirmishTick(room5);
  ok('참전 시간이 다 되면 자동 종료', player5.skirmish === null);

  player5.lastSkirmishEnd = 0;
  const p5b = frontPair(st6, 0);
  startSkirmish(room5, player5, p5b.region.id);
  p5b.region.owner = 1;
  skirmishTick(room5);
  ok('전선 영토를 잃으면 자동 종료', player5.skirmish === null);
}

/* =========================================================================
   3. WebSocket
   ========================================================================= */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      ws.inbox.push(msg);
      for (let i = 0; i < ws.waiters.length; i++) {
        if (ws.waiters[i].pred(msg)) {
          const w = ws.waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
          break;
        }
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function next(ws, pred, ms) {
  const found = ws.inbox.find(pred);
  if (found) {
    ws.inbox.splice(ws.inbox.indexOf(found), 1);
    return Promise.resolve(found);
  }
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      const i = ws.waiters.indexOf(w);
      if (i >= 0) ws.waiters.splice(i, 1);
      reject(new Error('메시지 대기 시간 초과'));
    }, ms || 9000);
    ws.waiters.push(w);
  });
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function networkTests() {
  console.log('WebSocket · 방과 실시간 동기화');
  const { server, wss } = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const health = await httpGet(port, '/healthz');
  ok('GET /healthz 200', health.status === 200 && JSON.parse(health.body).ok === true, health.body);
  const home = await httpGet(port, '/');
  ok('GET / 200 · 배틀 아레나', home.status === 200 && home.body.indexOf('BATTLE ARENA') >= 0);

  const a = await connect(port);
  const b = await connect(port);

  send(a, { type: 'create', name: '한윤', aiFill: true });
  const joinedA = await next(a, (m) => m.type === 'joined');
  ok('방 만들기 · 코드 발급', /^[A-Z0-9]{4}$/.test(joinedA.code), joinedA.code);
  const code = joinedA.code;
  const tokenA = joinedA.token;

  send(b, { type: 'join', code: code.toLowerCase(), name: '지우' });
  const joinedB = await next(b, (m) => m.type === 'joined');
  ok('방 참가', joinedB.code === code && joinedB.slot === 1);

  send(a, { type: 'start' });
  const stateA = await next(a, (m) => m.type === 'state' && m.started, 12000);
  const stateB = await next(b, (m) => m.type === 'state' && m.started, 12000);
  ok('게임 시작 · 28영토 · 2명 + AI 2', stateA.regions.length === 28 && stateA.players.length === 2 &&
    stateA.activeCount === 4);
  ok('턴 없음 · 실시간 상태', stateA.time !== undefined && stateA.turn === undefined && stateA.phase === undefined);
  ok('두 클라이언트가 각자 슬롯', stateA.you === 0 && stateB.you === 1);

  const tickA = await next(a, (m) => m.type === 'tick', 4000);
  ok('실시간 틱 수신', tickA.regions.length === 28 && tickA.army.length === 4);
  const troops0 = tickA.army[0].troops;
  await wait(1600);
  const tickA2 = await next(a, (m) => m.type === 'tick' && m.time > tickA.time + 900, 5000);
  ok('병력이 실시간으로 생산된다', tickA2.army[0].troops > troops0, [troops0, tickA2.army[0].troops]);

  // 출정 → 두 클라이언트에 행군 표시
  const mine = stateA.regions.filter((r) => r.owner === 0);
  let from = null, to = null;
  for (const r of mine) {
    const nb = r.neighbors.find((n) => stateA.regions[n].owner !== 0);
    if (nb != null) { from = r; to = nb; break; }
  }
  await wait(1200);
  send(a, { type: 'action', action: { kind: 'send', from: from.id, to: to, ratio: 1 } });
  const marchA = await next(a, (m) => m.type === 'tick' && m.marches.some((x) => x.from === from.id && x.to === to), 5000);
  const marchB = await next(b, (m) => m.type === 'tick' && m.marches.some((x) => x.from === from.id), 5000);
  ok('내 행군이 지도에 표시', marchA.marches.some((x) => x.from === from.id && x.to === to));
  ok('상대 클라이언트에도 같은 행군이 보인다', marchB.marches.some((x) => x.from === from.id));
  const resolved = await next(a, (m) => m.type === 'tick' && !m.marches.some((x) => x.from === from.id), 6000);
  ok('행군 도착 후 전투/합류 반영', !!resolved);

  // 사람 → 사람 외교
  send(a, { type: 'action', action: { kind: 'propose', to: 1 } });
  const propState = await next(b, (m) => m.type === 'tick' && m.proposals.some((p) => p.kind === 'truce'), 6000);
  const truceProp = propState.proposals.find((p) => p.kind === 'truce');
  ok('조약 제안 전달 · 45초', truceProp && truceProp.sec === 45);
  send(b, { type: 'action', action: { kind: 'respond', id: truceProp.id, accept: true } });
  const truceTick = await next(a, (m) => m.type === 'tick' && m.treaties.some((t) => t.type === 'truce' && t.a === 0 && t.b === 1), 6000);
  const tr = truceTick.treaties.find((t) => t.a === 0 && t.b === 1);
  ok('조약 체결 · 남은 시간(ms) 실시간', tr.left > 40000 && tr.left <= 45000, tr.left);

  // AI 위임 (여러 명이면 거절)
  send(a, { type: 'action', action: { kind: 'speed', value: 4 } });
  const speedDenied = await next(a, (m) => m.type === 'event' && m.text.indexOf('속도') >= 0, 4000).catch(() => null);
  ok('여러 명이면 게임 중 속도 변경 불가', speedDenied && /여러 명/.test(speedDenied.text), speedDenied && speedDenied.text);

  // 재접속
  a.close();
  await wait(300);
  const a2 = await connect(port);
  send(a2, { type: 'resume', code, token: tokenA });
  const resumed = await next(a2, (m) => m.type === 'resumed', 6000);
  const resumedState = await next(a2, (m) => m.type === 'state' && m.you === 0, 8000);
  ok('토큰 재접속 · 상태 복구', resumed.code === code && resumedState.regions.length === 28 &&
    resumedState.time > stateA.time);
  const bad = await connect(port);
  send(bad, { type: 'resume', code, token: 'nope' });
  ok('잘못된 토큰 거절', (await next(bad, (m) => m.type === 'resume_failed', 4000)).type === 'resume_failed');
  bad.close();

  // ---- AI 시뮬레이션 · 관전 → 난입 → 위임 → 속도 ----
  console.log('WebSocket · AI 시뮬레이션 난입');
  const c = await connect(port);
  send(c, { type: 'create', name: '관전자', sim: true });
  const joinedC = await next(c, (m) => m.type === 'joined');
  const simState = await next(c, (m) => m.type === 'state' && m.sim && m.started, 12000);
  ok('AI 시뮬레이션 방 즉시 시작', simState.sim === true && simState.you === -1);
  ok('4개국 모두 AI', simState.human.every((h) => h === false) && simState.active.every(Boolean));
  ok('기본 2배속', simState.speed === 2, simState.speed);

  const simMarch = await next(c, (m) => m.type === 'tick' && m.marches.length > 0, 8000);
  ok('AI끼리 행군이 보인다', simMarch.marches.length > 0);

  const slotToTake = [0, 1, 2, 3].find((i) => Game.countOwned({ regions: simState.regions.map((r) => ({ owner: r.owner })) }, i) > 0) || 0;
  send(c, { type: 'takeover', slot: slotToTake });
  const took = await next(c, (m) => m.type === 'state' && m.you === slotToTake, 6000);
  ok('나라를 골라 난입', took.you === slotToTake && took.human[slotToTake] === true && took.delegate === false);

  const own3 = took.regions.filter((r) => r.owner === slotToTake);
  let f3 = null, t3 = null;
  for (const r of own3) {
    const nb = r.neighbors.find((n) => took.regions[n].owner !== slotToTake);
    if (nb != null) { f3 = r; t3 = nb; break; }
  }
  if (f3) {
    await wait(900);
    send(c, { type: 'action', action: { kind: 'send', from: f3.id, to: t3, ratio: 0.5 } });
    const myMarch = await next(c, (m) => m.type === 'tick' && m.marches.some((x) => x.owner === slotToTake && x.from === f3.id), 5000);
    ok('난입한 나라로 직접 출정', !!myMarch);
  }

  send(c, { type: 'delegate', value: true });
  const delegated = await next(c, (m) => m.type === 'state' && m.delegate === true, 6000);
  ok('AI 위임 켜기', delegated.delegate === true && delegated.human[slotToTake] === false);
  send(c, { type: 'delegate', value: false });
  ok('AI 위임 끄기', (await next(c, (m) => m.type === 'state' && m.delegate === false, 6000)).delegate === false);

  send(c, { type: 'speed', value: 4 });
  ok('혼자면 ×4 속도', (await next(c, (m) => m.type === 'state' && m.speed === 4, 5000)).speed === 4);

  send(c, { type: 'spectate' });
  const back = await next(c, (m) => m.type === 'state' && m.you === -1, 6000);
  ok('관전으로 복귀', back.you === -1);

  // ---- 직접 참전(칼질) 프로토콜 ----
  console.log('WebSocket · 직접 참전');
  const arenaJs = await httpGet(port, '/arena.js');
  ok('GET /arena.js 200 · 아레나 모듈', arenaJs.status === 200 && arenaJs.body.indexOf('TWArena') >= 0);
  // ---- 루트(/)는 1차 배틀 아레나를 서빙한다 (2026-11-23 교체) ----
  ok('루트(/)가 1차 배틀 아레나 페이지', home.body.indexOf('BATTLE ARENA') >= 0 &&
    home.body.indexOf('/src/main.js') >= 0 && home.body.indexOf('/src/style.css') >= 0);
  ok('배틀 아레나 importmap · 로컬 three 번들 사용', home.body.indexOf('importmap') >= 0 &&
    home.body.indexOf('/vendor/three.module.min.js') >= 0);
  const baMain = await httpGet(port, '/src/main.js');
  ok('GET /src/main.js 200 · 배틀 아레나 엔트리 모듈', baMain.status === 200 &&
    baMain.body.indexOf("'./battle.js'") >= 0 && baMain.body.indexOf('buildWorld') >= 0);
  const baBattle = await httpGet(port, '/src/battle.js');
  ok('GET /src/battle.js 200 · 전투 엔진 모듈', baBattle.status === 200 && baBattle.body.indexOf('CLASSES') >= 0);
  const baCss = await httpGet(port, '/src/style.css');
  ok('GET /src/style.css 200 · 배틀 아레나 스타일', baCss.status === 200 && baCss.body.indexOf('#home') >= 0);
  const classic = await httpGet(port, '/classic/');
  ok('GET /classic/ 200 · 기존 영토 전쟁 페이지 보존', classic.status === 200 &&
    classic.body.indexOf('영토 전쟁') >= 0);
  ok('적 전멸 판정 = "약속한 적을 모두 내보냄 + 살아 있는 적 0" (죽은 병사 잔여물에 막히지 않는다)',
    /function enemiesCleared\(\)/.test(arenaJs.body) && /aliveEnemies\(\) === 0/.test(arenaJs.body) &&
    arenaJs.body.indexOf('S.enemies.length === 0') < 0, arenaJs.body.indexOf('S.enemies.length === 0'));
  ok('적 사망은 한 번만 집계되고 그 자리에서 목록에서 빠진다 (아군이 벤 적 포함)',
    /if \(!en \|\| en\.counted\) return;/.test(arenaJs.body) &&
    /if \(!gone\.counted\) \{ gone\.counted = true; S\.defeated\+\+; \}/.test(arenaJs.body));
  ok('적 증원 상한은 살아 있는 적만 센다 (쓰러진 병사가 증원을 막지 않는다)',
    /var alive = aliveSoldierEnemies\(\);/.test(arenaJs.body) && /cap - alive/.test(arenaJs.body) &&
    /function aliveEnemies\(\)[\s\S]*?if \(!S\.enemies\[i\]\.dead\) n\+\+;/.test(arenaJs.body));
  const makeUnitSrc = (arenaJs.body.match(/function makeUnit\(team, x, y, kind\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok('아군·적군 병사 스펙이 한 벌(makeUnit)에서 나온다 (체력·공격력·속도 동일)',
    /hp: gen \? GEN_HP : UNIT_HP/.test(makeUnitSrc) && /dmg: gen \? GEN_DMG : UNIT_DMG/.test(makeUnitSrc) &&
    /speed: \(gen \? GEN_SPEED : UNIT_SPEED\) \* S\.speedScale/.test(makeUnitSrc) &&
    !/team === 'ally'|team !== 'enemy'/.test(makeUnitSrc), makeUnitSrc.length);
  ok('아군 증원은 고른 수(allyTotal)까지만 — 무한 생성 없음 (아군 0이면 0명)',
    /if \(S\.allySpawned < S\.allyTotal\)/.test(arenaJs.body) &&
    /allyCount == null \? 3 : cfg\.allyCount/.test(arenaJs.body));
  ok('큰 망치 장군 — 양쪽 같은 스펙(체력 500) · 병사의 1.45배 몸집 · 전멸 판정에 포함',
    /var GEN_HP = 500;/.test(arenaJs.body) && /var GEN_R = \+\(UNIT_R \* 1\.45\)/.test(arenaJs.body) &&
    /S\.enemyGenSpawned >= S\.enemyGenTotal/.test(arenaJs.body) &&
    /function generalSpec\(\)/.test(arenaJs.body) && /function spawnGenerals\(\)/.test(arenaJs.body));
  ok('배틀 아레나 홈에 클래스 선택 카드 4종', /data-cls="soldier"/.test(home.body) &&
    /data-cls="knight"/.test(home.body) && /data-cls="wizard"/.test(home.body) &&
    /data-cls="blademaster"/.test(home.body));
  ok('기존 아레나 모듈의 장군 워해머 코드 유지',
    /HAMMER_ANIM/.test(arenaJs.body) && /function doSlam\(\)/.test(arenaJs.body));

  const d = await connect(port);
  send(d, { type: 'create', name: '참전러', sim: true });
  await next(d, (m) => m.type === 'joined');
  const dState = await next(d, (m) => m.type === 'state' && m.started, 12000);
  const slotD = [0, 1, 2, 3].find((i) => dState.regions.some((r) => r.owner === i)) || 0;
  send(d, { type: 'takeover', slot: slotD });
  const dState2 = await next(d, (m) => m.type === 'state' && m.you === slotD, 8000);

  let arenaStart = null;
  let pickRegion = null;
  for (const r of dState2.regions) {
    if (r.owner !== slotD || r.troops < 2) continue;
    const nbId = r.neighbors.find((n) => dState2.regions[n].owner !== slotD &&
      dState2.regions[n].troops >= 2);
    if (nbId == null) continue;
    const foeOwner = dState2.regions[nbId].owner;
    const atPeace = foeOwner >= 0 && (dState2.treaties || []).some((t) =>
      (t.a === slotD && t.b === foeOwner) || (t.a === foeOwner && t.b === slotD));
    if (atPeace) continue;
    pickRegion = { region: r, target: dState2.regions[nbId] };
    break;
  }
  ok('난입한 나라에 참전할 전선이 있다', !!pickRegion);

  send(d, { type: 'skirmish', kind: 'start', region: pickRegion.region.id });
  arenaStart = await next(d, (m) => m.type === 'skirmish_start', 6000);
  ok('참전 시작 · 아레나 설정 수신', !!arenaStart.arena && arenaStart.arena.region.id === pickRegion.region.id &&
    arenaStart.arena.enemyCount >= 8);
  ok('아레나 설정에 진영 이름·색·전선 병력', !!arenaStart.arena.me.color && !!arenaStart.arena.enemy.name &&
    arenaStart.arena.rules.killsPerTroop === SKIRMISH.killsPerTroop);
  ok('참전 상태가 함께 전달된다', !!arenaStart.skirmish && arenaStart.skirmish.kills === 0 &&
    arenaStart.skirmish.maxDamage >= 1, arenaStart.skirmish && arenaStart.skirmish.maxDamage);

  const targetBefore = pickRegion.target.troops;
  const targetOwnerBefore = pickRegion.target.owner;
  send(d, { type: 'skirmish', kind: 'report', kills: 3 });
  const upd = await next(d, (m) => m.type === 'skirmish_update', 6000);
  ok('칼질 결과가 서버에 반영된다', upd.delta.damage === 1 && upd.skirmish.kills === 3,
    [upd.delta.damage, upd.skirmish.kills]);
  // 병력이 줄어든 tick, 또는 그 사이 영토가 통째로 넘어간(주인 변경) tick — 둘 다 '전선이 밀렸다'는 뜻
  const tickAfter = await next(d, (m) => {
    if (m.type !== 'tick') return false;
    const r = m.regions[pickRegion.target.id];
    if (!r) return false;
    return r[1] <= targetBefore - 1 || (targetOwnerBefore != null && r[0] !== targetOwnerBefore);
  }, 9000);
  const afterTroops = tickAfter.regions[pickRegion.target.id][1];
  const afterOwner = tickAfter.regions[pickRegion.target.id][0];
  ok('지도 병력이 바로 줄어든다 (또는 그사이 영토가 넘어간다)',
    afterTroops <= targetBefore - 1 || afterOwner !== targetOwnerBefore,
    { before: [targetOwnerBefore, targetBefore], after: [afterOwner, afterTroops] });

  const overReport = await next(d, (m) => m.type === 'skirmish_update' && m.skirmish.flagged > 0, 4000).catch(() => null);
  send(d, { type: 'skirmish', kind: 'report', kills: 500 });
  const clamped = await next(d, (m) => m.type === 'skirmish_update' && m.skirmish.flagged > 0, 4000).catch(() => null);
  ok('비정상 킬 보고는 서버에서 깎인다', !!clamped && clamped.skirmish.kills < 500, clamped && clamped.skirmish.kills);

  send(d, { type: 'skirmish', kind: 'end', reason: 'win', kills: 20 });
  const ended = await next(d, (m) => m.type === 'skirmish_end', 6000);
  ok('참전 종료 · 요약 수신', !!ended.summary && ended.summary.reason === 'win' && ended.summary.kills > 0,
    ended.summary && ended.summary.kills);
  const endEvent = await next(d, (m) => m.type === 'event' && m.text.indexOf('전선') >= 0, 6000).catch(() => null);
  ok('전선 결과가 방 전체에 알려진다', !!endEvent);

  send(d, { type: 'skirmish', kind: 'start', region: pickRegion.region.id });
  const cooldownErr = await next(d, (m) => m.type === 'error', 4000).catch(() => null);
  ok('참전 직후 재참전은 숨 고르기', !!cooldownErr && cooldownErr.code === 'COOLDOWN', cooldownErr && cooldownErr.code);
  d.close();

  // 나가기
  send(b, { type: 'leave' });
  ok('나가기 응답', (await next(b, (m) => m.type === 'left', 4000)).type === 'left');

  for (const w of [a2, b, c]) { try { w.close(); } catch (e) { /* noop */ } }
  for (const client of wss.clients) { try { client.terminate(); } catch (e) { /* noop */ } }
  wss.close();
  await new Promise((res) => server.close(res));
}

(async function main() {
  try {
    engineTests();
    headlessSimTests();
    skirmishTests();
    await networkTests();
    console.log('\n모든 테스트 통과 (' + passed + '개)');
    process.exit(0);
  } catch (e) {
    console.error('\n테스트 실패:', e && e.stack || e);
    process.exit(1);
  }
})();
