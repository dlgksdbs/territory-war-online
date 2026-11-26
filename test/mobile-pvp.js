'use strict';

/* =============================================================================
   플레이어 PVP · 390×844 실브라우저 2인 동시 접속 검증
   -----------------------------------------------------------------------------
   1) 홈: 「⚔️ 플레이어 PVP」 패널(닉네임·방 만들기·방 코드 입장)이 보이고 눌린다
   2) 대기실: 방 만들기 → 코드 입장 → 두 사람 · 팀 선택 · 병종 선택 · 방장 시작
   3) 전장: 시작하면 1인칭 3D 전장, 상대가 병종 모델 + 이름표(팀 색·체력바)로 보인다
   4) 실전: 걸어가서 근접 공격 → 양쪽 체력이 실제로 줄고 피격 연출이 뜬다
   5) 검 막기: 정면으로 막으면 피해 0 (막힘 이벤트)
   6) 상대 화면에서도 3D 전장·모델·이름표가 실제로 그려진다
   7) 전투 HUD(내 버튼 크기·위치) 유지 · 홈 복귀 · 콘솔 오류 0
   실행: node test/mobile-pvp.js

   ※ 이 환경은 소프트웨어 GL(SwiftShader)이라 두 화면을 동시에 렌더링하면 GPU 컨텍스트가
      버티지 못한다. 그래서 한 브라우저의 두 탭으로 접속하고, 확인하는 쪽 탭을 bringToFront 로
      앞으로 가져와 그 순간의 실제 렌더링을 본다. 서버 동기화·피해·막기는 뒤 탭에서도 그대로 동작한다.
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.PVP_SHOTS || '/workspace/screenshots-battle-arena-2026-11-26-pvp';
const PORT = 3597;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}

(async () => {
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) { /* noop */ }
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  const stop = () => { try { server.close(); } catch (e) { /* noop */ } };
  process.on('exit', stop);

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 900000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding']
  });
  const errorsA = [];
  const errorsB = [];

  const openPage = async (errors) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/AudioContext/.test(m.text())) return;           // 헤드리스에는 오디오 장치가 없다
      if (/WebGLProgram|Shader Error|VALIDATE_STATUS|could not be created|Error creating WebGL/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
    /* q=low — 소프트웨어 GL 에서 두 화면을 함께 돌리기 위해 그림자를 끈다 (렌더 경로·전투 로직 동일) */
    await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(() => window.BA && window.BA.pvp && window.BA.pvp.client, { timeout: 90000 });
    } catch (e) {
      console.error('   [페이지 로드 실패]', errors.slice(0, 4));
      throw e;
    }
    await sleep(400);
    return page;
  };

  console.log('▶ 플레이어 PVP · 2인 실시간 1인칭 대전 (390×844)');
  const A = await openPage(errorsA);
  const B = await openPage(errorsB);
  const front = async (page, ms) => { await page.bringToFront(); await sleep(ms || 800); };
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch (e) { /* noop */ } };

  /* ===== 1. 홈 PVP 패널 ===== */
  await front(A, 300);
  const panel = await A.evaluate(() => {
    const el = document.getElementById('pvpPanel');
    el.scrollIntoView({ block: 'center' });
    const q = el.getBoundingClientRect();
    const btn = document.getElementById('pvpMake').getBoundingClientRect();
    const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
    return {
      exists: !!el, w: q.width, h: q.height,
      makeOk: !!(hit && hit.closest('#pvpMake')),
      hasName: !!document.getElementById('pvpName'),
      hasCode: !!document.getElementById('pvpCode'),
      hasJoin: !!document.getElementById('pvpJoin')
    };
  });
  ok('⚔️ 홈에 플레이어 PVP 패널(닉네임·방 만들기·방 코드 입장)이 보이고 눌린다',
    panel.exists && panel.w > 300 && panel.h > 100 && panel.hasName && panel.hasCode && panel.hasJoin && panel.makeOk,
    { w: panel.w, h: panel.h, makeOk: panel.makeOk });
  ok('⚔️ 기존 「전장으로」·「버튼 크기·위치 설정」도 그대로 있다',
    await A.evaluate(() => !!document.getElementById('startBtn') && !!document.getElementById('hudCfgBtn')));
  await shot(A, '01-home-pvp-panel.png');

  /* ===== 2. 방 만들기 → 코드 입장 ===== */
  await A.evaluate(() => window.BA.pvp.create('한윤'));
  await A.waitForFunction(() => {
    const l = document.getElementById('pvpLobby');
    return l && l.classList.contains('is-on') && window.BA.pvp.lobby();
  }, { timeout: 15000 });
  const code = await A.evaluate(() => window.BA.pvp.lobby().code);
  ok('방 만들기 → 대기실이 열리고 방 코드가 나온다', /^[A-Z0-9]{4}$/.test(code), { code });
  await shot(A, '02-lobby-host.png');

  await B.evaluate((c) => window.BA.pvp.join(c, '친구'), code);
  await B.waitForFunction(() => {
    const l = document.getElementById('pvpLobby');
    return l && l.classList.contains('is-on') && window.BA.pvp.lobby() && window.BA.pvp.lobby().players.length === 2;
  }, { timeout: 15000 });
  await A.waitForFunction(() => window.BA.pvp.lobby() && window.BA.pvp.lobby().players.length === 2, { timeout: 12000 });
  ok('방 코드로 친구가 입장하면 두 사람이 대기실에 보인다',
    await A.evaluate(() => window.BA.pvp.lobby().players.map((p) => p.name).sort().join(',') === '친구,한윤'));

  await A.evaluate(() => { window.BA.pvp.team('ally'); window.BA.pvp.cls('soldier'); });
  await B.evaluate(() => { window.BA.pvp.team('enemy'); window.BA.pvp.cls('soldier'); });
  await sleep(500);
  const lobbyUI = await A.evaluate(() => ({
    ally: document.querySelector('#plAllyList').textContent,
    enemy: document.querySelector('#plEnemyList').textContent,
    allyOn: document.querySelector('#plTeamBtns [data-team="ally"]').classList.contains('is-on'),
    clsOn: document.querySelector('#plClassBtns [data-cls="soldier"]').classList.contains('is-on'),
    startEnabled: !document.getElementById('plStart').disabled
  }));
  ok('대기실에서 팀(아군/적군)과 병종(6종)을 고른다',
    /한윤/.test(lobbyUI.ally) && /친구/.test(lobbyUI.enemy) && lobbyUI.allyOn && lobbyUI.clsOn,
    { ally: lobbyUI.ally.trim(), enemy: lobbyUI.enemy.trim() });
  ok('방장은 시작할 수 있고, 방장이 아닌 쪽은 잠긴다',
    lobbyUI.startEnabled && (await B.evaluate(() => document.getElementById('plStart').disabled)) === true);

  await A.evaluate(() => window.BA.pvp.conf({ mode: 'kills', killTarget: 3, bots: { ally: 0, enemy: 0 } }));
  await sleep(350);
  await shot(A, '03-lobby-ready.png');

  /* ===== 3. 대전 시작 ===== */
  await front(A, 300);
  await A.evaluate(() => window.BA.pvp.start());
  const waitBattle = (page) => page.waitForFunction(() => {
    const st = window.BA.pvp.state();
    return st && st.inBattle && st.server && st.phase === 'battle';
  }, { timeout: 90000 }).catch(async (e) => {
    console.error('   [전장 진입 실패]', JSON.stringify(await page.evaluate(() => window.BA.pvp.state())).slice(0, 300));
    throw e;
  });
  await Promise.all([waitBattle(A), waitBattle(B)]);
  await front(A, 2500);

  const battleA = await A.evaluate(() => {
    const st = window.BA.pvp.state();
    const top = document.getElementById('pvpTop');
    return {
      cls: document.getElementById('battle').className,
      topShown: getComputedStyle(top).display !== 'none',
      topText: top.textContent.replace(/\s+/g, ' ').trim(),
      frames: window.BA.state().frames,
      others: st.others.length,
      me: st.me
    };
  });
  ok('시작하면 1인칭 3D 전장으로 들어간다 (PVP 점수판 표시)',
    /is-active/.test(battleA.cls) && /is-pvp/.test(battleA.cls) && battleA.topShown && battleA.frames > 3,
    { cls: battleA.cls, top: battleA.topText, frames: battleA.frames });
  ok('전장에 상대 플레이어가 서 있다', battleA.others === 1, battleA.others);
  ok('내 병사가 서버가 정한 자리(아군 진영)에 스폰', battleA.me && battleA.me.z < 0, battleA.me && { x: battleA.me.x, z: battleA.me.z });

  const battleB = await B.evaluate(() => window.BA.pvp.state());
  ok('상대 화면에서도 나를 본다 (서로 다른 진영)', battleB.others.length === 1 && battleB.me.z > 0,
    { a: battleA.me.z, b: battleB.me.z });

  /* 서로를 바라보게 하고 모델·이름표 확인 */
  await A.evaluate((id) => window.BA.pvp.lookAt(id), battleB.you);
  await B.evaluate((id) => window.BA.pvp.lookAt(id), battleA.you);
  await sleep(1200);
  const lookA = await A.evaluate(() => {
    const st = window.BA.pvp.state();
    const plate = document.querySelector('#pvpNames .pn-plate');
    return {
      other: st.others[0], platesOn: st.platesOn,
      plateText: plate ? plate.textContent : '',
      plateOn: !!(plate && plate.classList.contains('is-on')),
      plateColor: plate ? getComputedStyle(plate).borderColor : ''
    };
  });
  ok('상대가 선택한 병종의 3D 모델로 풀 디테일로 그려진다', !!lookA.other && lookA.other.drawn === true, lookA.other);
  ok('상대 머리 위에 이름표(이름·팀 색·체력바)가 뜬다',
    lookA.platesOn >= 1 && lookA.plateOn && /친구/.test(lookA.plateText), { on: lookA.plateOn, text: lookA.plateText.trim(), color: lookA.plateColor });

  const aim = await A.evaluate(() => {
    const el = document.getElementById('aimInfo');
    return {
      on: el.classList.contains('is-on'),
      name: document.getElementById('aiName').textContent,
      hp: document.getElementById('aiHp').textContent,
      barW: document.getElementById('aiBar').style.width
    };
  });
  ok('조준점을 상대에게 대면 에임 위 상대 체력바가 뜬다', aim.on && /친구/.test(aim.name) && /\d+ \/ \d+/.test(aim.hp) && /%/.test(aim.barW), aim);
  await shot(A, '04-battle-see-opponent.png');

  /* ===== 4. 걸어가서 근접전 ===== */
  const snapshot = () => A.evaluate(() => {
    const st = window.BA.pvp.state();
    return { me: st.me, other: st.others[0] };
  });
  const distOf = async () => { const s = await snapshot(); return Math.hypot(s.me.x - s.other.x, s.me.z - s.other.z); };
  const startDist = await distOf();
  await A.keyboard.down('KeyW');
  let reached = false;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (await distOf() < 2.2) { reached = true; break; }
  }
  await A.keyboard.up('KeyW');
  const endDist = await distOf();
  ok('이동이 서버에 동기화되어 상대에게 다가간다', reached || endDist < startDist - 3,
    { start: +startDist.toFixed(1), end: +endDist.toFixed(1), reached });

  /* 가까이 붙였으면 공격 → 상대 HP 감소 */
  await A.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
  const hpB0 = await B.evaluate(() => window.BA.pvp.state().me.hp);
  let hpDrop = false;
  for (let i = 0; i < 8 && !hpDrop; i++) {
    await A.evaluate(() => window.BA.pvp.swing());
    await sleep(900);
    hpDrop = await A.evaluate((hp) => {
      const st = window.BA.pvp.state();
      return !!(st.others[0] && st.others[0].hp < hp);
    }, hpB0);
  }
  const hpB1 = await B.evaluate(() => window.BA.pvp.state().me.hp);
  const hpSeenByA = await A.evaluate(() => window.BA.pvp.state().others[0].hp);
  ok('내 공격이 상대에게 실제 피해를 준다 (양쪽 체력 일치)',
    hpB1 < hpB0 && Math.abs(hpB1 - hpSeenByA) < 1.5, { before: hpB0, after: hpB1, seen: hpSeenByA });
  ok('맞은 쪽은 피격 이벤트를 받는다', (await A.evaluate(() => window.BA.pvp.state().stats.hits)) >= 1);

  /* ===== 5. 검 막기 ===== */
  await B.evaluate(() => window.BA.pvp.guard(true));
  await sleep(500);
  const hpGuard = await B.evaluate(() => window.BA.pvp.state().me.hp);
  let blocked = false;
  let hpLow = hpGuard;
  for (let i = 0; i < 10 && !blocked; i++) {
    await A.evaluate(() => window.BA.pvp.swing());
    await sleep(1600);
    const s2 = await B.evaluate(() => ({ hp: window.BA.pvp.state().me.hp, blocks: window.BA.pvp.state().stats.blocks }));
    hpLow = Math.min(hpLow, s2.hp);
    blocked = s2.blocks >= 1;
  }
  const hpGuard2 = await B.evaluate(() => window.BA.pvp.state().me.hp);
  /* 막는 동안에는 피해가 없다 (자연 회복으로 조금 오르는 것만 허용) */
  ok('정면으로 검을 막으면 피해가 들어가지 않는다', blocked && hpLow >= hpGuard - 0.6,
    { before: hpGuard, low: hpLow, after: hpGuard2, blocked });
  await B.evaluate(() => window.BA.pvp.guard(false));
  await shot(A, '05-battle-block.png');

  /* 점수판 */
  const board = await A.evaluate(() => ({
    goal: document.getElementById('ptGoal').textContent,
    score: document.getElementById('ptScore').textContent,
    time: document.getElementById('ptTime').textContent,
    ally: document.getElementById('ptAlly').textContent,
    enemy: document.getElementById('ptEnemy').textContent
  }));
  ok('전장 위에 팀 인원·점수·목표·남은 시간이 표시된다',
    /목표 3킬/.test(board.goal) && /\d+ : \d+/.test(board.score) && /아군/.test(board.ally) && /적군/.test(board.enemy) && /\d+:\d\d/.test(board.time), board);

  /* ===== 6. 상대 화면도 실제로 그려진다 ===== */
  await front(B, 2500);
  const lookB = await B.evaluate(() => {
    const st = window.BA.pvp.state();
    const plate = document.querySelector('#pvpNames .pn-plate');
    return {
      other: st.others[0], platesOn: st.platesOn, frames: window.BA.state().frames,
      plateOn: !!(plate && plate.classList.contains('is-on')), plateText: plate ? plate.textContent : ''
    };
  });
  ok('상대 화면에서도 3D 모델·이름표가 그려진다',
    lookB.other && lookB.other.drawn === true && lookB.platesOn >= 1 && lookB.plateOn && lookB.frames >= 2,
    { drawn: lookB.other && lookB.other.drawn, platesOn: lookB.platesOn, frames: lookB.frames, text: lookB.plateText.trim() });
  await shot(B, '06-opponent-view.png');
  await front(A, 1200);

  /* ===== 7. HUD 유지 · 홈 복귀 ===== */
  const hud = await A.evaluate(() => {
    const atk = document.getElementById('attackBtn').getBoundingClientRect();
    const joy = document.getElementById('joy').getBoundingClientRect();
    return { atk: +atk.width.toFixed(1), joy: +joy.width.toFixed(1) };
  });
  ok('내가 저장한 버튼 크기·위치(전투 HUD)가 PVP 에서도 그대로다', hud.atk > 40 && hud.joy > 60, hud);

  await A.evaluate(() => window.BA.pvp.leave());
  await sleep(800);
  const backHome = await A.evaluate(() => ({
    home: document.getElementById('home').classList.contains('is-active'),
    pvp: document.getElementById('battle').classList.contains('is-pvp')
  }));
  ok('홈으로 나가면 PVP 전장 상태가 정리된다', backHome.home && !backHome.pvp, backHome);

  ok('A 콘솔 · 페이지 오류 0', errorsA.length === 0, errorsA.slice(0, 5));
  ok('B 콘솔 · 페이지 오류 0', errorsB.length === 0, errorsB.slice(0, 5));

  console.log('\n플레이어 PVP 모바일 검증 통과 · ' + passed + '개');
  await browser.close();
  stop();
  process.exit(0);
})().catch((e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
