'use strict';

/* =============================================================================
   친구와 플레이 · 2~5인 국가전쟁 테스트
   -----------------------------------------------------------------------------
   1) 엔진: 편성 예산/상한 · 성벽→성 공성 · 멸망/승리 · 외교(불가침·동맹·선전포고)
   2) AI 2~5국 시뮬레이션: 데드락 없이 승부가 나는지
   3) WebSocket: 5인 방 · 편성 · 파병 · 외교 · 접속 끊김/재접속 · 정원 초과
   실행: node test/friends.js
   ============================================================================= */

const assert = require('assert');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const F = require('../friends');
const { createServer } = require('../server');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRoom(n, opts) {
  const o = opts || {};
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      slot: i,
      controlSlot: i,
      name: (i === 0 ? '한윤' : '친구' + i),
      token: 'tok' + i,
      ws: null,
      connected: i === 0,
      isAI: false,
      abandoned: false,
      autoAI: false,
      disconnectedAt: null,
      dropTimer: null
    });
  }
  const room = {
    code: 'TEST1',
    mode: 'castle',
    hostSlot: 0,
    capacity: o.capacity || Math.max(2, n),
    players,
    started: false,
    sim: false,
    aiFill: !!o.aiFill,
    friends: F.createState({ capacity: o.capacity || Math.max(2, n), aiFill: !!o.aiFill })
  };
  return room;
}

function run(room, seconds, step) {
  const dt = step || 100;
  let t = 0;
  const ms = seconds * 1000;
  while (t < ms) {
    F.step(room, Date.now() + (t += dt));
    if (room.friends.phase === 'over') break;
  }
}

/* =========================================================================
   1. 편성
   ========================================================================= */
function setupTests() {
  console.log('편성 · 예산과 상한');
  const room = fakeRoom(2);
  const out = F.startGame(room, 0);
  ok('방장이 시작하면 편성 단계', out.ok && room.friends.phase === 'setup');
  ok('참가자 수만큼 성·성벽 생성', room.friends.nations.length === 2 &&
    room.friends.nations.every((n) => n.castle.max > 0 && n.wall.max > 0));
  ok('2~5인이 아니면 거절', (() => {
    const r1 = fakeRoom(1);
    return F.startGame(r1, 0).error && F.startGame(r1, 0).error[0] === 'NEED_MORE';
  })());

  const nation = room.friends.nations[0];
  ok('기본 편성은 예산 안', F.setupCost(nation.setup) <= F.CFG.budget &&
    F.totalUnits(nation.setup.units) > 0);

  const over = F.normalizeSetup({ units: { soldier: 6000, elite: 1500, knight: 60, wizard: 60, blademaster: 60, berserker: 60 }, wallBonus: 6000, castleBonus: 8000 });
  ok('예산을 넘는 편성은 거절', over === null);

  const capped = F.normalizeSetup({ units: { soldier: 3000, elite: 600, knight: -5 } });
  ok('음수는 0 · 상한 넘는 수치는 그대로 받는다', capped && capped.units.soldier === 3000 &&
    capped.units.elite === 600 && capped.units.knight === 0);
  ok('너무 큰 수치는 상한까지 자른 뒤 예산으로 거른다', F.normalizeSetup({ units: { soldier: 999999 } }) === null);

  const basic = F.normalizeSetup({ units: { soldier: 2000, elite: 500, knight: 20, wizard: 20, blademaster: 20, berserker: 20 } });
  ok('병종별 기본 상한(병사 2000·고급 500·특수 20)은 예산 안', !!basic &&
    basic.units.soldier === 2000 && basic.units.elite === 500 && basic.units.knight === 20);

  const more = F.normalizeSetup({ units: { soldier: 2600, elite: 0, knight: 0, wizard: 0, blademaster: 0, berserker: 0 } });
  ok('기본 상한을 넘겨 더 넣을 수 있다 (직접 수치)', !!more && more.units.soldier === 2600);

  const p = F.presetSetup('attack');
  ok('프리셋 3종 모두 예산 안', ['balanced', 'attack', 'defense'].every((k) => {
    const s = F.presetSetup(k);
    return F.setupCost(s) <= F.CFG.budget + 0.001 && F.totalUnits(s.units) > 0;
  }), { a: F.setupCost(F.presetSetup('attack')) });

  /* 편성 적용 → 준비 → 전투 */
  const custom = { units: { soldier: 1000, elite: 200, knight: 10, wizard: 10, blademaster: 10, berserker: 10 }, wallBonus: 2000, castleBonus: 2000, preset: 'custom' };
  ok('편성 저장', F.setSetup(room, room.players[0], custom).ok && room.friends.nations[0].setup.units.soldier === 1000);
  ok('한 명만 준비해도 시작하지 않는다', F.setReady(room, room.players[0], true).ok &&
    room.friends.phase === 'setup');
  ok('모두 준비하면 전투 시작', F.setReady(room, room.players[1], true).ok &&
    room.friends.phase === 'battle');
  ok('편성한 성벽·성이 반영된다', room.friends.nations[0].wall.max === F.CFG.wallBase + 2000 &&
    room.friends.nations[0].army.soldier === 1000);
}

/* =========================================================================
   2. 공성 · 승리
   ========================================================================= */
function battleTests() {
  console.log('전투 · 성벽 → 성 → 멸망');
  const room = fakeRoom(2);
  F.startGame(room, 0);
  for (const p of room.players) F.setReady(room, p, true);
  const st = room.friends;
  ok('전투 개시', st.phase === 'battle');

  /* 약한 상대를 만든다 */
  const me = st.nations[0];
  const foe = st.nations[1];
  foe.army = { soldier: 0, elite: 0, knight: 0, wizard: 0, blademaster: 0, berserker: 0 };
  foe.initial = { ...foe.army };
  foe.initialTotal = 0;
  foe.wall.hp = 1200;
  foe.castle.hp = 2000;

  const march = F.sendMarch(room, room.players[0], 1, { soldier: 1200, elite: 300, knight: 10, wizard: 10, blademaster: 10, berserker: 10 });
  ok('군사 파견 성공', march.ok && st.marches.length === 1, march.error);
  ok('파견한 병력은 성에서 빠진다', me.army.soldier < 1000);
  ok('진군 중에는 상대 성이 그대로', foe.wall.hp === 1200);

  /* 도착 → 성벽 → 성 */
  run(room, 20);
  ok('도착하면 공성이 시작된다', Object.keys(st.sieges).length >= 1 || !foe.alive);
  ok('성벽이 먼저 부서진다', foe.wall.hp === 0 || !foe.alive, { wall: foe.wall.hp });
  run(room, 90);
  ok('성이 부서지면 멸망', foe.alive === false, { castle: foe.castle.hp });
  ok('마지막 한 나라가 남으면 승리', st.phase === 'over' && st.over.winner === 0, st.over);

  const view = F.stateView(room, 0);
  ok('상태에 승자·멸망이 담긴다', view.over.winner === 0 && view.nations[1].alive === false);

  /* 재대결 — 같은 멤버로 로비 복귀 */
  const again = F.handleMessage(room, room.players[0], 'rematch', {});
  ok('재대결로 로비 복귀', again.ok && room.friends.phase === 'lobby' && room.started === false);
  ok('재대결 뒤에도 사람은 남는다', room.players.filter((p) => !p.isAI).length === 2);
}

/* =========================================================================
   3. 외교
   ========================================================================= */
function diploTests() {
  console.log('외교 · 불가침 · 동맹 · 선전포고');
  const room = fakeRoom(3);
  F.startGame(room, 0);
  for (const p of room.players) F.setReady(room, p, true);
  const st = room.friends;

  const offer = F.offerProposal(room, 0, 1, 'truce');
  ok('불가침 제안', offer.ok && st.proposals.length === 1);
  ok('상대가 수락하면 조약 체결', F.answerProposal(room, room.players[1], offer.proposal.id, true).ok &&
    F.relOf(st, 0, 1).type === 'truce');
  const blocked = F.sendMarch(room, room.players[0], 1, { soldier: 100 });
  ok('불가침 중에는 파병 불가', !!blocked.error && blocked.error[0] === 'DIPLO');

  ok('선전포고하면 조약이 깨진다', F.declareWar(room, room.players[0], 1).ok &&
    F.relOf(st, 0, 1).type === 'war');
  const allowed = F.sendMarch(room, room.players[0], 1, { soldier: 100 });
  ok('선전포고 후 파병 가능', allowed.ok);

  const ally = F.offerProposal(room, 0, 2, 'ally');
  F.answerProposal(room, room.players[2], ally.proposal.id, true);
  ok('동맹 체결', F.relOf(st, 0, 2).type === 'ally');
  ok('동맹국에는 파병 불가', !!F.sendMarch(room, room.players[0], 2, { soldier: 50 }).error);
  ok('동맹이 만료되면 다시 전쟁 상태', (() => {
    st.time = F.relOf(st, 0, 2).until + 1;
    F.step(room, Date.now());
    return F.relOf(st, 0, 2).type === 'war';
  })());
  ok('제안 만료', (() => {
    const p = F.offerProposal(room, 1, 2, 'truce');
    st.time = p.proposal.expires + 1;
    F.step(room, Date.now());
    return !F.stateView(room, 0).proposals.some((x) => x.id === p.proposal.id);
  })());
}

/* =========================================================================
   4. AI 시뮬레이션 (2~5국)
   ========================================================================= */
function aiTests() {
  console.log('AI · 2~5국 전쟁이 반드시 끝난다');
  for (const n of [2, 3, 4, 5]) {
    let wins = 0;
    for (let rep = 0; rep < 2; rep++) {
      const room = fakeRoom(n);
      F.startGame(room, 0);
      const st = room.friends;
      for (const nation of st.nations) { nation.ai = true; nation.autoAI = true; nation.ready = true; }
      let t = 0;
      const dt = 100;
      while (st.phase !== 'over' && t < 1300000) {
        F.step(room, t += dt);
      }
      ok(n + '국 판이 제한 시간 안에 승부가 난다 (' + (rep + 1) + ')',
        st.phase === 'over' && st.over && st.over.winner >= 0,
        { time: st.time, over: st.over });
      if (st.over && st.over.winner >= 0) wins++;
      ok(n + '국 · 살아 있는 나라가 1개', st.nations.filter((x) => x.alive).length === 1);
      ok(n + '국 · 상태 직렬화 가능', (() => {
        const v = F.stateView(room, 0);
        return v.nations.length === n && JSON.stringify(v).length > 100;
      })());
    }
    ok(n + '국 · 두 판 모두 승자 있음', wins === 2);
  }
}

/* =========================================================================
   5. WebSocket 5인
   ========================================================================= */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
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
  if (found) { ws.inbox.splice(ws.inbox.indexOf(found), 1); return Promise.resolve(found); }
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

async function networkTests() {
  console.log('WebSocket · 5인 방');
  const { server } = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  const page = await get('/friends/');
  ok('GET /friends/ 200 · 친구와 플레이 페이지', page.status === 200 && page.body.indexOf('친구와 플레이') >= 0);
  /* 홈(/)에는 국가전쟁 입구를 두지 않는다 — 배틀 아레나 홈만 남는다 */
  const home = await get('/');
  ok('홈에는 「친구와 플레이」 섹션이 없다 (배틀 아레나 홈만)', home.status === 200 &&
    !/id="friendsPanel"/.test(home.body) && !/2~5인 실시간 국가전쟁/.test(home.body));

  const clients = [];
  for (let i = 0; i < 5; i++) clients.push(await connect(port));
  send(clients[0], { type: 'create', mode: 'castle', name: '한윤', capacity: 5, aiFill: false });
  const j0 = await next(clients[0], (m) => m.type === 'joined');
  ok('5인 방 만들기', j0.mode === 'castle' && /^[A-Z0-9]{4}$/.test(j0.code), j0.code);
  const code = j0.code;

  const tokens = [j0.token];
  for (let i = 1; i < 5; i++) {
    send(clients[i], { type: 'join', code, name: '친구' + i });
    const j = await next(clients[i], (m) => m.type === 'joined');
    tokens.push(j.token);
    ok('참가 ' + i + ' · 슬롯 ' + i, j.slot === i && j.mode === 'castle');
  }

  /* 정원 초과 */
  const extra = await connect(port);
  send(extra, { type: 'join', code, name: '낯선이' });
  const err = await next(extra, (m) => m.type === 'error');
  ok('정원(5명) 초과는 거절', err.code === 'ROOM_FULL', err);
  extra.close();

  send(clients[0], { type: 'start' });
  const s0 = await next(clients[0], (m) => m.type === 'fstate' && m.phase !== 'lobby', 12000);
  ok('시작 · 5개국 성 생성', s0.nations.length === 5 && s0.nations.every((n) => n.castle.max > 0));
  ok('모든 클라이언트가 편성 단계', (await Promise.all(clients.slice(1).map((c) =>
    next(c, (m) => m.type === 'fstate' && m.phase === 'setup', 12000)))).every((m) => m.phase === 'setup'));

  /* 편성 */
  const setup = { units: { soldier: 1500, elite: 300, knight: 10, wizard: 10, blademaster: 5, berserker: 5 }, wallBonus: 2000, castleBonus: 2000 };
  send(clients[0], { type: 'setup', setup });
  await next(clients[0], (m) => m.type === 'fstate' && m.nations && m.nations[0] &&
    m.nations[0].setup && m.nations[0].setup.units.soldier === 1500, 8000);
  ok('편성이 서버에 반영', true);

  send(clients[0], { type: 'setup', setup: { units: { soldier: 6000, elite: 1500, knight: 60, wizard: 60, blademaster: 60, berserker: 60 }, wallBonus: 6000, castleBonus: 8000 } });
  const budgetErr = await next(clients[0], (m) => m.type === 'error' && m.code === 'BUDGET');
  ok('예산 초과 편성은 오류로 돌려준다', !!budgetErr);

  for (const c of clients) send(c, { type: 'ready', value: true });
  const battle = await next(clients[0], (m) => m.type === 'fstate' && m.phase === 'battle', 12000);
  ok('전원 준비 → 국가전쟁 시작', battle.phase === 'battle');
  ok('모두 같은 전장 상태', (await Promise.all(clients.map((c) =>
    next(c, (m) => m.type === 'fstate' && m.phase === 'battle', 12000)))).every((m) => m.nations.length === 5));

  /* 파병 */
  const target = 1;
  send(clients[0], { type: 'march', to: target, units: { soldier: 300, elite: 60 } });
  const marched = await next(clients[0], (m) => m.type === 'fstate' && m.marches.some((x) => x.from === 0), 8000);
  ok('군사 파견이 전장에 소환', marched.marches.some((x) => x.from === 0 && x.to === target && x.total === 360));

  /* 외교 */
  send(clients[0], { type: 'diplo', action: 'offer', to: 2, kind: 'truce' });
  const prop = await next(clients[2], (m) => m.type === 'fstate' && m.proposals.some((p) => p.from === 0 && p.to === 2), 8000);
  const pid = prop.proposals.find((p) => p.from === 0 && p.to === 2).id;
  send(clients[2], { type: 'diplo', action: 'answer', id: pid, accept: true });
  await next(clients[2], (m) => m.type === 'fstate' && m.nations && m.nations[0] && m.nations[0].rel === 'truce', 8000);
  ok('외교 제안 → 수락이 실시간 동기화', true);

  send(clients[0], { type: 'march', to: 2, units: { soldier: 50 } });
  const dipErr = await next(clients[0], (m) => m.type === 'error' && m.code === 'DIPLO');
  ok('불가침 상대 파병은 거절', !!dipErr);

  /* 접속 끊김 → AI 지휘 → 재접속 */
  clients[4].close();
  await sleep(400);
  const st4 = await next(clients[0], (m) => m.type === 'fstate', 8000);
  ok('한 명이 끊겨도 전장은 계속', !!st4);

  const back = await connect(port);
  send(back, { type: 'resume', code, token: tokens[4] });
  const resumed = await next(back, (m) => m.type === 'resumed', 6000);
  ok('토큰으로 같은 자리 복귀', resumed.mode === 'castle' && resumed.slot === 4);
  const backState = await next(back, (m) => m.type === 'fstate' && m.you === 4, 8000);
  ok('복귀하면 전장 상태를 다시 받는다', backState.nations.length === 5, backState.you);
  clients[4] = back;

  /* 방 나가기 */
  send(clients[3], { type: 'leave' });
  await next(clients[3], (m) => m.type === 'left', 5000);
  ok('방 나가기', true);

  server.close();
  for (const c of clients) { try { c.close(); } catch (e) { /* noop */ } }
}

(async function main() {
  try {
    setupTests();
    battleTests();
    diploTests();
    aiTests();
    await networkTests();
    console.log('\n친구와 플레이 테스트 통과 · ' + passed + '개');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
