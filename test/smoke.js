'use strict';

/* 스모크 테스트
   - 엔진: 지도/전투/외교(관계·신뢰도·동맹·조공·할양·공동참전)/AI 전략
   - 네트워크: 실제 WebSocket 방 생성 → 시작 → 조작 → 재접속
   실행: npm test */

const assert = require('assert');
const WebSocket = require('ws');
const { createServer, Game } = require('../server');

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

function threeNationState() {
  const s = Game.newGame({ humans: 3, aiFill: false });
  s.human = [true, true, true, false];
  s.names = ['청룡', '적화', '녹림', '황금'];
  return s;
}

async function engineTests() {
  console.log('엔진 · 기본 규칙');
  const st = Game.newGame({ humans: 1, aiFill: true });
  st.names = ['나', '적화', '녹림', '황금'];
  ok('지도 28개 영토 생성', st.regions.length === 28, st.regions.length);
  ok('4개국 참전', st.activeCount === 4 && st.active.every(Boolean));
  ok('모든 참전국이 시작 영토 보유', [0, 1, 2, 3].every((i) => Game.countOwned(st, i) >= 3));
  ok('연결 그래프', st.regions.every((r) => r.neighbors.length >= 1));
  ok('첫 턴 보충 병력', st.reinforcements >= 3, st.reinforcements);

  const myRegion = st.regions.find((r) => r.owner === 0);
  const before = myRegion.troops;
  const placed = Game.deploy(st, myRegion.id, 2);
  ok('배치', placed === 2 && myRegion.troops === before + 2 && st.reinforcements >= 0);

  const own = st.regions.filter((r) => r.owner === 0);
  let movePair = null;
  for (const a of own) {
    for (const nb of a.neighbors) {
      if (st.regions[nb].owner === 0) movePair = [a, st.regions[nb]];
    }
  }
  if (movePair) {
    movePair[0].troops = 5;
    const moved = Game.transfer(st, movePair[0].id, movePair[1].id);
    ok('병력 이동', moved === 4 && movePair[0].troops === 1);
  }

  Game.createTreaty(st, 0, 1, 'truce', 4);
  const borderRegion = st.regions.find((r) => r.owner === 0);
  const enemyNb = st.regions[borderRegion.neighbors[0]];
  enemyNb.owner = 1;
  enemyNb.troops = 2;
  borderRegion.troops = 5;
  const blockedRes = Game.attack(st, borderRegion.id, enemyNb.id);
  ok('불가침 조약이 공격 차단', !blockedRes.ok && blockedRes.reason === 'treaty');
  Game.removeTreaty(st, 0, 1);

  Game.createTreaty(st, 0, 1, 'truce', 4);
  const tick = Game.tickTreaties(st);
  ok('조약 턴 감소', st.treaties['0-1'].turns === 3 && tick.expired.length === 0);

  console.log('엔진 · 관계 · 신뢰도');
  const relState = Game.newGame({ humans: 3, aiFill: false });
  relState.human = [true, true, true, false];
  relState.names = ['청룡', '적화', '녹림', '황금'];
  ok('초기 관계 0 · 신뢰도 60', relState.relations['0-1'] === 0 && relState.reputation[0] === 60);
  relState.reinforcements = 3;
  const rep0 = relState.reputation[0];
  const aid = Game.sendAid(relState, 0, 1);
  ok('병력 지원 + 관계/신뢰 상승', aid.ok && aid.amount === 3 &&
    relState.relations['0-1'] === 15 && relState.reputation[0] === rep0 + 3);
  ok('지원으로 동맹 5턴', relState.treaties['0-1'].type === 'ally' && relState.treaties['0-1'].turns === 5);
  const beforeBreak = relState.reputation[0];
  Game.breakPact(relState, 0, 1);
  ok('배신 시 신뢰도 급락', relState.reputation[0] === beforeBreak - 35, relState.reputation[0]);
  ok('배신 시 관계 급락', relState.relations['0-1'] <= -35, relState.relations['0-1']);
  ok('배신은 외교 로그에 기록', relState.diploLog.some((x) => x.kind === 'bad'));

  const betrayState = Game.newGame({ humans: 3, aiFill: false });
  betrayState.human = [true, true, true, false];
  betrayState.names = ['청룡', '적화', '녹림', '황금'];
  Game.createTreaty(betrayState, 0, 2, 'truce', 4);
  betrayState.relations['0-2'] = 60;
  betrayState.reputation[0] = 25;
  ok('배신자는 동맹 제안 거절', !Game.evaluateAlliance(betrayState, 2, 0));
  betrayState.reputation[0] = 80;
  ok('신뢰 회복 후 동맹 가능', Game.evaluateAlliance(betrayState, 2, 0));

  console.log('엔진 · 동맹 · 공동 참전');
  const allyState = threeNationState();
  Game.createTreaty(allyState, 0, 1, 'truce', 4);
  const allyProp = Game.proposeAlliance(allyState, 0, 1);
  ok('불가침 위에 동맹 제안', allyProp.status === 'queued' && allyProp.proposal.kind === 'ally');
  const allyRes = Game.resolveProposal(allyState, allyProp.proposal, true);
  ok('동맹 체결 5턴', allyRes.accepted && allyState.treaties['0-1'].type === 'ally' &&
    allyState.treaties['0-1'].turns === 5);
  const callRes = Game.callToArms(allyState, 0, 1, 2);
  ok('동맹에게 공동 참전 요청', callRes.status === 'queued' && callRes.proposal.kind === 'call');
  Game.resolveProposal(allyState, callRes.proposal, true);
  ok('공동 참전 성립', allyState.calls.length === 1 && allyState.calls[0].target === 2);
  ok('공동 참전은 관계 상승', allyState.relations['0-1'] >= 20, allyState.relations['0-1']);
  // 동맹 보너스: 0과 1이 동맹, 2와 교전 → 0이 2를 칠 때 +1
  allyState.relations['0-1'] = 40;
  const atkFrom = allyState.regions.find((r) => r.owner === 0);
  const target = allyState.regions[atkFrom.neighbors[0]];
  target.owner = 2;
  target.troops = 1;
  atkFrom.troops = 6;
  const battle = Game.attack(allyState, atkFrom.id, target.id);
  ok('공동의 적 공격에 동맹 +1', battle.allyBonus === true);

  console.log('엔진 · 조공 · 할양');
  const tribState = threeNationState();
  tribState.relations['0-2'] = 30;
  const tribProp = Game.proposeTribute(tribState, 0, 2, 1, 'offer');
  ok('조공 제안', tribProp.status === 'queued' && tribProp.proposal.kind === 'tribute');
  Game.resolveProposal(tribState, tribProp.proposal, true);
  const tribTr = tribState.treaties['0-2'];
  ok('조공 조약 체결', tribTr && tribTr.type === 'tribute' && tribTr.payer === 0 &&
    tribTr.payee === 2 && tribTr.amount === 1);
  const payerBefore = Game.totalTroops(tribState, 0);
  const payeeBefore = Game.totalTroops(tribState, 2);
  const tt = Game.tickTreaties(tribState);
  ok('라운드마다 조공 병력 이동', tt.tributes.length === 1 &&
    Game.totalTroops(tribState, 0) === payerBefore - 1 &&
    Game.totalTroops(tribState, 2) === payeeBefore + 1);

  const cedeState = threeNationState();
  const gift = cedeState.regions.find((r) => r.owner === 0);
  const cedeProp = Game.proposeCede(cedeState, 0, 1, gift.id, true);
  ok('영토 할양 제안', cedeProp.status === 'queued' && cedeProp.proposal.kind === 'cede');
  Game.resolveProposal(cedeState, cedeProp.proposal, true);
  ok('영토 소유권 이전', gift.owner === 1 && gift.troops === 1);
  ok('할양으로 관계 +25', cedeState.relations['0-1'] === 25, cedeState.relations['0-1']);
  ok('할양과 함께 불가침', cedeState.treaties['0-1'] && cedeState.treaties['0-1'].type === 'truce');

  console.log('엔진 · AI 전략');
  const aiState = Game.newGame({ humans: 1, aiFill: true });
  aiState.names = ['나', '적화', '녹림', '황금'];
  aiState.human = [true, false, false, false];
  const ai = 1;
  const aiOwn = aiState.regions.filter((r) => r.owner === ai);
  const interior = aiOwn[0];
  for (const nb of interior.neighbors) aiState.regions[nb].owner = ai;
  const itBefore = interior.troops;
  Game.aiReinforce(aiState, ai);
  ok('AI는 내부 영토에 배치하지 않음', interior.troops === itBefore);
  interior.troops = 6;
  for (const nb of interior.neighbors) aiState.regions[nb].troops = 1;
  const movedN = Game.aiShiftTroops(aiState, ai);
  ok('AI 후방 병력을 전선으로 이동', movedN >= 1 && interior.troops === 1, movedN);

  let violations = 0, checked = 0;
  for (let k = 0; k < 120; k++) {
    const mv = Game.aiPickAttack(aiState, ai);
    if (!mv) break;
    checked++;
    const diff = mv.from.troops - mv.to.troops;
    if (mv.to.owner >= 0 && diff < 2) violations++;
    if (mv.to.owner < 0 && diff < 1) violations++;
  }
  ok('AI는 유리할 때만 공격', checked > 0 && violations === 0, checked);

  // 공동 참전 목표를 우선 공격하는지
  const callState = Game.newGame({ humans: 1, aiFill: true });
  callState.names = ['나', '적화', '녹림', '황금'];
  callState.human = [true, false, false, false];
  const callAi = 1;
  let callFrom = null, callTarget = null;
  for (const r of callState.regions) {
    if (r.owner !== callAi) continue;
    const outs = r.neighbors.filter((nb) => callState.regions[nb].owner !== callAi);
    if (outs.length >= 2) { callFrom = r; callTarget = callState.regions[outs[0]]; break; }
  }
  if (callFrom) {
    callFrom.troops = 6;
    for (const nb of callFrom.neighbors) {
      const t = callState.regions[nb];
      if (t.owner === callAi) continue;
      t.troops = 1;
    }
    callTarget.owner = 2;
    callState.calls.push({ id: 1, from: 0, to: callAi, target: 2, turns: 2, at: Date.now() });
    const pick = Game.aiPickAttack(callState, callAi);
    ok('공동 참전 목표를 우선 공격', pick && pick.to.owner === 2, pick && pick.to.owner);
  }

  const leaderState = Game.newGame({ humans: 1, aiFill: true });
  leaderState.names = ['나', '적화', '녹림', '황금'];
  leaderState.human = [true, false, false, false];
  // 중립 영토를 1번에게 몰아 1위 국가(35%+)로 만든다
  let grabbed = 0;
  for (const r of leaderState.regions) {
    if (r.owner === -1 && grabbed < 8) { r.owner = 1; grabbed++; }
  }
  leaderState.relations['0-1'] = 60;
  leaderState.relations['0-2'] = 40;
  leaderState.relations['0-3'] = 40;
  const dip = Game.aiDiplomacy(leaderState, 2);
  ok('1위 국가 견제 외교', Array.isArray(dip) && dip.length > 0, dip.length);

  const st2 = Game.newGame({ humans: 2, aiFill: false });
  ok('AI 없이 2인', st2.activeCount === 2 && st2.active[2] === false);
  st2.everEliminated = true;
  for (const r of st2.regions) if (r.owner === 1) r.owner = 0;
  Game.checkOver(st2);
  ok('마지막 생존국 승리', st2.over && st2.over.type === 'lastStanding' && st2.over.winner === 0);
}

/* ---------------- 네트워크 ---------------- */
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
    }, ms || 8000);
    ws.waiters.push(w);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function hasProposal(stateMsg, kind) {
  return stateMsg.proposals && stateMsg.proposals.some((p) => p.kind === kind);
}

async function networkTests() {
  console.log('WebSocket · 방과 외교');
  const { server, wss } = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const a = await connect(port);
  const b = await connect(port);

  send(a, { type: 'create', name: '한윤', aiFill: true });
  const joinedA = await next(a, (m) => m.type === 'joined');
  ok('방 만들기 · 코드 발급', /^[A-Z0-9]{4}$/.test(joinedA.code), joinedA.code);
  const code = joinedA.code;
  const tokenA = joinedA.token;
  ok('방장 자리 0', joinedA.slot === 0);

  send(b, { type: 'join', code: code.toLowerCase(), name: '지우' });
  const joinedB = await next(b, (m) => m.type === 'joined');
  ok('방 참가 · 자리 1', joinedB.code === code && joinedB.slot === 1);
  const tokenB = joinedB.token;

  const lobbyB = await next(b, (m) => m.type === 'lobby');
  ok('로비 인원 2명', lobbyB.players.length === 2);

  send(a, { type: 'start' });
  const stateA = await next(a, (m) => m.type === 'state' && m.started && m.regions, 12000);
  ok('게임 시작 · 28영토', stateA.regions.length === 28);
  ok('2명 + AI 2', stateA.activeCount === 4 && stateA.players.length === 2);
  ok('내 차례 표시', stateA.you === 0 && stateA.cur === 0 && stateA.phase === 'player');
  ok('관계/신뢰도 동기화', stateA.relations.length === 6 && stateA.reputation[0] === 60);

  const target = stateA.regions.find((r) => r.owner === 0);
  const reinfBefore = stateA.reinforcements;
  a.inbox.length = 0;
  send(a, { type: 'action', action: { kind: 'deploy', idx: target.id, amount: 1 } });
  const afterDeploy = await next(a, (m) => m.type === 'state' &&
    m.regions.find((r) => r.id === target.id).troops === target.troops + 1);
  ok('배치 반영', afterDeploy.reinforcements === reinfBefore - 1);

  // AI 에게 조공 제안 (즉시 판정)
  a.inbox.length = 0;
  send(a, { type: 'action', action: { kind: 'tribute', to: 3, amount: 1, direction: 'offer' } });
  const afterTribute = await next(a, (m) => m.type === 'state' &&
    m.treaties.some((t) => t.type === 'tribute' && t.b === 3), 6000);
  ok('AI 조공 조약 성립', afterTribute.treaties.some((t) => t.type === 'tribute' && t.payer === 0));

  // 사람 → 사람 불가침
  send(a, { type: 'action', action: { kind: 'propose', to: 1 } });
  const truceArrived = await next(b, (m) => m.type === 'state' && hasProposal(m, 'truce'), 6000);
  const truceProp = truceArrived.proposals.find((p) => p.kind === 'truce' && p.to === 1);
  send(b, { type: 'action', action: { kind: 'respond', id: truceProp.id, accept: true } });
  const truceDone = await next(a, (m) => m.type === 'state' &&
    m.treaties.some((t) => t.a === 0 && t.b === 1 && t.type === 'truce'), 6000);
  ok('불가침 조약 체결', !!truceDone);

  // 불가침 → 동맹
  send(a, { type: 'action', action: { kind: 'alliance', to: 1 } });
  const allyArrived = await next(b, (m) => m.type === 'state' && hasProposal(m, 'ally'), 6000);
  const allyProp = allyArrived.proposals.find((p) => p.kind === 'ally');
  send(b, { type: 'action', action: { kind: 'respond', id: allyProp.id, accept: true } });
  const allyDone = await next(a, (m) => m.type === 'state' &&
    m.treaties.some((t) => t.a === 0 && t.b === 1 && t.type === 'ally' && t.turns === 5), 6000);
  ok('동맹으로 격상 (5턴)', !!allyDone);

  // 공동 참전 요청
  send(a, { type: 'action', action: { kind: 'call', to: 1, target: 2 } });
  const callArrived = await next(b, (m) => m.type === 'state' && hasProposal(m, 'call'), 6000);
  const callProp = callArrived.proposals.find((p) => p.kind === 'call');
  ok('공동 참전 요청 전달', callProp && callProp.target === 2);
  send(b, { type: 'action', action: { kind: 'respond', id: callProp.id, accept: true } });
  const callDone = await next(a, (m) => m.type === 'state' &&
    m.calls.some((c) => c.to === 1 && c.target === 2), 6000);
  ok('공동 참전 성립', !!callDone);

  // 영토 할양
  const gift = stateA.regions.filter((r) => r.owner === 0).find((r) => r.id !== target.id) || target;
  send(a, { type: 'action', action: { kind: 'cede', to: 1, regionId: gift.id, withTruce: false } });
  const cedeArrived = await next(b, (m) => m.type === 'state' && hasProposal(m, 'cede'), 6000);
  const cedeProp = cedeArrived.proposals.find((p) => p.kind === 'cede');
  send(b, { type: 'action', action: { kind: 'respond', id: cedeProp.id, accept: true } });
  const cedeDone = await next(a, (m) => m.type === 'state' &&
    m.regions.find((r) => r.id === gift.id).owner === 1, 6000);
  ok('영토 할양 반영', cedeDone.regions.find((r) => r.id === gift.id).owner === 1);

  // AI 는 사람 제안을 즉시 판정
  send(a, { type: 'action', action: { kind: 'propose', to: 2 } });
  const aiAnswer = await next(a, (m) => m.type === 'event' &&
    (m.text.indexOf('불가침') >= 0 || m.text.indexOf('거절') >= 0), 6000);
  ok('AI 제안 즉시 응답', !!aiAnswer.text);

  // 턴 종료 → AI 턴 진행
  a.inbox.length = 0;
  send(a, { type: 'action', action: { kind: 'end' } });
  const aiPhase = await next(a, (m) => m.type === 'state' && m.phase === 'ai', 8000);
  ok('턴 종료 후 AI 진행', aiPhase.cur !== 0 || aiPhase.phase === 'ai');

  // 재접속
  a.close();
  await wait(250);
  const a2 = await connect(port);
  send(a2, { type: 'resume', code: code, token: tokenA });
  const resumed = await next(a2, (m) => m.type === 'resumed', 6000);
  ok('토큰 재접속', resumed.code === code && resumed.slot === 0);
  const resumedState = await next(a2, (m) => m.type === 'state' && m.you === 0, 8000);
  ok('재접속 후 상태 동기화', resumedState.regions.length === 28);

  // 잘못된 토큰
  const c = await connect(port);
  send(c, { type: 'resume', code: code, token: 'nope' });
  const failed = await next(c, (m) => m.type === 'resume_failed', 4000);
  ok('잘못된 토큰 거절', failed.type === 'resume_failed');

  // 나가기
  send(b, { type: 'leave' });
  const left = await next(b, (m) => m.type === 'left', 4000);
  ok('나가기 응답', left.type === 'left');

  a2.close();
  c.close();
  for (const client of wss.clients) {
    try { client.terminate(); } catch (e) { /* noop */ }
  }
  wss.close();
  await new Promise((res) => server.close(res));
}

(async function main() {
  try {
    await engineTests();
    await networkTests();
    console.log('\n모든 테스트 통과 (' + passed + '개)');
    process.exit(0);
  } catch (e) {
    console.error('\n테스트 실패:', e && e.message);
    process.exit(1);
  }
})();
