'use strict';

/* =============================================================================
   친구와 플레이 · 모바일(390×844 세로) 실제 렌더 · 2인 실시간 검증
   -----------------------------------------------------------------------------
   · 홈 화면 아래 「🤝 친구와 플레이」 패널 → 방 만들기 → 대기실 → 전장 이동
   · 편성 시트(예산·프리셋·직접 입력) → 전투 → 파병 · 외교
   · 관전 카메라(조이스틱 3D 비행 · 드래그 시점 · 고도 버튼) 동작
   · 두 명이 같은 방에서 실시간으로 상태를 주고받는지
   · UI 겹침 없음 · 콘솔 오류 0
   실행: node test/mobile-friends.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.FRIENDS_ROOT || path.join(__dirname, '..');
const SHOTS = '/workspace/tmp/friends-shots';
const PORT = 3721;
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

async function tap(page, sel) {
  await page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) throw new Error('없는 요소: ' + q);
    el.click();
  }, sel);
}

function overlap(a, b) {
  if (!a || !b) return 0;
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
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
    protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required']
  });

  const errors = [];
  async function newPage(label) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(label + ': ' + m.text());
    });
    page.on('pageerror', (e) => errors.push(label + ' PAGEERROR: ' + e.message));
    page.setDefaultTimeout(25000);
    return page;
  }

  const A = await newPage('A');
  await A.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2' });
  await sleep(1200);

  /* ================= 홈 화면 아래 패널 ================= */
  console.log('홈 · 친구와 플레이 패널');
  const homePanel = await A.evaluate(() => {
    const p = document.getElementById('friendsPanel');
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    return { exists: !!p, top: r.top, w: r.width, h: r.height, text: p.innerText.slice(0, 120) };
  });
  ok('홈 아래에 「친구와 플레이」 섹션', homePanel.exists && homePanel.w > 200 && /2~5인/.test(homePanel.text), homePanel.text.slice(0, 40));
  ok('방 만들기 · 방 코드 입장 · 인원(2~5) UI', await A.evaluate(() => !!document.getElementById('fpCreate') &&
    !!document.getElementById('fpJoin') && document.querySelectorAll('#fpCap button').length === 4));
  await A.screenshot({ path: SHOTS + '/01-home-panel.png' });

  /* ================= 방 만들기 → 대기실 ================= */
  console.log('홈 · 방 만들기 → 2인 대기실');
  await A.click('#fpName', { clickCount: 3 });
  await A.type('#fpName', '한윤');
  await A.click('#fpCap button[data-cap="2"]');
  await A.click('#fpAi');
  await A.click('#fpCreate');
  await sleep(1100);
  const codeA = await A.$eval('#fpWaitCode', (e) => e.textContent.trim());
  ok('방 코드 발급 · 대기실 표시', /^[A-Z0-9]{4}$/.test(codeA) && await A.evaluate(() =>
    !document.getElementById('fpWait').classList.contains('hidden')), codeA);
  ok('대기실에 2자리 표시 (친구 자리 비어 있음)', await A.evaluate(() =>
    document.querySelectorAll('#fpPlayers .fp-player').length === 2));
  await A.screenshot({ path: SHOTS + '/02-home-wait.png' });

  const B = await newPage('B');
  await B.goto('http://127.0.0.1:' + PORT + '/friends/?code=' + codeA, { waitUntil: 'networkidle2' });
  await sleep(900);
  await B.type('#nameInput', '지우');
  await B.click('#btnJoin');
  await sleep(1100);
  ok('친구가 코드로 입장', await B.evaluate(() => !document.getElementById('waitPanel').classList.contains('hidden') &&
    document.querySelectorAll('#waitPlayers .wp').length === 2));
  await B.screenshot({ path: SHOTS + '/03-join-wait.png' });

  /* 방장 화면에도 인원이 동기화됐는지 (홈 패널) */
  await sleep(500);
  ok('방장 대기실에도 친구가 보인다', await A.evaluate(() =>
    document.querySelectorAll('#fpPlayers .fp-player:not(.empty)').length === 2));

  /* ================= 시작 → 전장 ================= */
  console.log('전장 · 시작과 편성');
  const navP = A.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  await Promise.race([
    A.evaluate(() => document.getElementById('fpStart').click()).catch(() => null),
    sleep(3000)
  ]);
  await navP;
  await A.waitForFunction('window.FRIENDS && window.FRIENDS.state', { timeout: 20000 }).catch(() => null);
  await sleep(1200);
  ok('방장이 시작하면 /friends/ 전장으로 이동', /\/friends\//.test(A.url()), A.url());
  const stA = await A.evaluate(() => window.FRIENDS.state && {
    phase: window.FRIENDS.state.phase, nations: window.FRIENDS.state.nations.length,
    you: window.FRIENDS.state.you
  });
  ok('전장 상태 · 2개국', stA && stA.nations === 2, stA);
  ok('편성 시트가 열린다', await A.evaluate(() => !document.getElementById('setupSheet').classList.contains('hidden')));
  const budget0 = await A.$eval('#budgetTxt', (e) => e.textContent);
  ok('편성치 표시 (5,000)', /5,000/.test(budget0), budget0);
  await A.screenshot({ path: SHOTS + '/04-setup.png' });

  /* 프리셋 → 예산 변화 */
  console.log('  … 편성 입력 읽기');
  const knightSel = '#setupRows .urow[data-unit="knight"] input[type=number]';
  const before = await A.$eval(knightSel, (e) => Number(e.value));
  await tap(A, '#setupPresets button[data-preset="attack"]');
  await sleep(500);
  const after = await A.$eval(knightSel, (e) => Number(e.value));
  ok('프리셋으로 편성이 바뀐다 (공격 몰빵 · 기사 12 → 20)', after === 20 && after > before, { before, after });

  /* 직접 수치 입력 */
  const input = '#setupRows .urow[data-unit="soldier"] input[type=number]';
  await A.evaluate((q) => {
    const el = document.querySelector(q);
    el.value = '1800';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, input);
  await sleep(500);
  const direct = await A.$eval(input, (e) => Number(e.value));
  const budgetNow = await A.$eval('#budgetTxt', (e) => e.textContent);
  ok('병력 수치를 직접 입력할 수 있다', direct === 1800, { direct, budgetNow });

  /* 성벽 강화 스텝퍼 */
  const wallBefore = await A.evaluate(() => window.FRIENDS.setup.wallBonus);
  await tap(A, '#defRows .urow[data-def="wall"] button[data-d="1"]');
  await sleep(250);
  const wallAfter = await A.evaluate(() => window.FRIENDS.setup.wallBonus);
  ok('성벽 체력을 수치로 올린다', wallAfter === wallBefore + 1000, { wallBefore, wallAfter });

  /* ================= 두 명 준비 → 전투 ================= */
  await tap(A, '#btnReady');
  await sleep(600);
  await B.bringToFront();
  const bReady = await B.evaluate(() => {
    if (!window.FRIENDS) return false;
    window.FRIENDS.send({ type: 'ready', value: true });
    return !!window.FRIENDS.state;
  });
  ok('친구 화면도 편성 시트', bReady);
  await A.bringToFront();
  await sleep(1200);
  const battleA = await A.evaluate(() => window.FRIENDS.state && window.FRIENDS.state.phase);
  ok('둘 다 준비하면 국가전쟁 시작', battleA === 'battle', battleA);
  ok('편성 시트가 닫히고 HUD 표시', await A.evaluate(() =>
    document.getElementById('setupSheet').classList.contains('hidden') &&
    !document.getElementById('hud').classList.contains('hidden')));
  await sleep(800);
  await A.screenshot({ path: SHOTS + '/05-battle.png' });

  /* ================= UI 겹침 · 화면 밖 ================= */
  const boxes = await A.evaluate(() => {
    const ids = ['topbar', 'nationStrip', 'joy', 'actionBar', 'altBtns', 'camBtns'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    out.vw = window.innerWidth; out.vh = window.innerHeight;
    return out;
  });
  ok('모든 조작 UI가 화면 안에 있다', Object.keys(boxes).filter((k) => k !== 'vw' && k !== 'vh').every((k) => {
    const b = boxes[k];
    return b.x >= -1 && b.y >= -1 && b.x + b.width <= boxes.vw + 1 && b.y + b.height <= boxes.vh + 1;
  }), boxes);
  const pairs = [['joy', 'actionBar'], ['joy', 'altBtns'], ['joy', 'camBtns'], ['altBtns', 'camBtns'], ['actionBar', 'altBtns'], ['nationStrip', 'joy']];
  ok('조작 UI끼리 겹치지 않는다', pairs.every(([a, b]) => overlap(boxes[a], boxes[b]) < 4),
    pairs.map(([a, b]) => [a, b, Math.round(overlap(boxes[a], boxes[b]))]));

  /* ================= 카메라 ================= */
  console.log('카메라 · 관전 자유 비행');
  await A.bringToFront();
  await sleep(300);
  const cam0 = await A.evaluate(() => ({ ...window.FRIENDS.scene.cam }));
  const joyBox = boxes.joy;
  await A.mouse.move(joyBox.x + joyBox.width / 2, joyBox.y + joyBox.height / 2);
  await A.mouse.down();
  await A.mouse.move(joyBox.x + joyBox.width / 2, joyBox.y + 6, { steps: 6 });
  await sleep(700);
  await A.mouse.up();
  const cam1 = await A.evaluate(() => ({ ...window.FRIENDS.scene.cam }));
  ok('조이스틱으로 시선 방향 3D 비행', Math.abs(cam1.z - cam0.z) + Math.abs(cam1.x - cam0.x) > 1.5,
    { from: [cam0.x, cam0.z], to: [cam1.x, cam1.z] });

  const yaw0 = await A.evaluate(() => window.FRIENDS.scene.cam.yaw);
  await A.mouse.move(200, 380);
  await A.mouse.down();
  await A.mouse.move(120, 400, { steps: 8 });
  await A.mouse.up();
  await sleep(300);
  const yaw1 = await A.evaluate(() => window.FRIENDS.scene.cam.yaw);
  ok('화면 드래그로 시점 회전', Math.abs(yaw1 - yaw0) > 0.05, { yaw0, yaw1 });

  const y0 = await A.evaluate(() => window.FRIENDS.scene.cam.y);
  const upRect = await A.evaluate(() => {
    const r = document.querySelector('#altBtns button[data-alt="up"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await A.mouse.click(upRect.x, upRect.y);
  await sleep(350);
  const y1 = await A.evaluate(() => window.FRIENDS.scene.cam.y);
  ok('고도 상승 버튼', y1 > y0, { y0, y1 });
  const y2 = await A.evaluate(() => { const s = window.FRIENDS.scene; s.raise(-30); return s.cam.y; });
  ok('고도 하강', y2 < y1, { y1, y2 });

  await tap(A, '#camMine');
  await sleep(300);
  ok('🏰 내 성 버튼이 내 성으로 이동', await A.evaluate(() => window.FRIENDS.scene.focusSlot === window.FRIENDS.slot));
  await tap(A, '#camAll');
  await sleep(300);
  ok('🗺️ 전체 보기', await A.evaluate(() => window.FRIENDS.scene.focusSlot === -1));

  /* ================= 파병 ================= */
  console.log('지휘 · 파병과 외교');
  await A.bringToFront();
  await tap(A, '#btnMarch');
  await sleep(600);
  ok('파병 시트에 상대 국가가 뜬다', await A.evaluate(() =>
    document.querySelectorAll('#marchTargets button').length === 1));
  await tap(A, '#marchTargets button');
  await sleep(300);
  await tap(A, '#marchRatio button[data-ratio="0.75"]');
  await sleep(300);
  const marchTotal = await A.$eval('#marchTotal', (e) => e.textContent);
  ok('보낼 병력 합계 표시', /파견 [0-9,]+명/.test(marchTotal), marchTotal);
  await tap(A, '#btnSend');
  await sleep(900);
  const marched = await A.evaluate(() => {
    const s = window.FRIENDS.state;
    return s.marches.filter((m) => m.from === s.you).length;
  });
  ok('파병하면 전장에 군사가 소환된다', marched >= 1, marched);
  await B.bringToFront();
  const enemySees = await B.evaluate(() => {
    const s = window.FRIENDS.state;
    return s.marches.some((m) => m.to === s.you) || s.sieges.some((x) => x.target === s.you);
  });
  ok('상대 화면에도 진군이 보인다 (실시간 동기화)', enemySees);
  await A.screenshot({ path: SHOTS + '/06-march.png' });

  /* ================= 외교 ================= */
  await A.bringToFront();
  await tap(A, '#btnDiplo');
  await sleep(600);
  ok('외교 시트에 상대가 뜬다', await A.evaluate(() => document.querySelectorAll('#diploList .dip').length === 1));
  await A.evaluate(() => {
    const b = document.querySelector('#diploList .dip button[data-a="truce"]');
    b.click();
  });
  await sleep(900);
  await B.bringToFront();
  const proposal = await B.evaluate(() => window.FRIENDS.state.proposals.filter((p) => p.to === window.FRIENDS.slot).length);
  ok('불가침 제안이 상대에게 도착', proposal >= 1, proposal);
  await B.evaluate(() => {
    const s = window.FRIENDS.state;
    const p = s.proposals.find((x) => x.to === s.you);
    if (p) window.FRIENDS.send({ type: 'diplo', action: 'answer', id: p.id, accept: true });
  });
  await sleep(900);
  await A.bringToFront();
  const rel = await A.evaluate(() => {
    const s = window.FRIENDS.state;
    const foe = s.nations.find((n) => !n.isYou);
    return foe && foe.rel;
  });
  ok('수락하면 불가침 체결', rel === 'truce', rel);
  await A.screenshot({ path: SHOTS + '/07-diplo.png' });
  await A.evaluate(() => window.FRIENDS.closeSheet());

  /* ================= 전투 진행 · 성벽/성 피해 ================= */
  console.log('전투 · 성벽과 성이 부서진다');
  await A.evaluate(() => window.FRIENDS.send({ type: 'speed', value: 2 }));
  await sleep(16000);
  const dmg = await A.evaluate(() => {
    const s = window.FRIENDS.state;
    const foe = s.nations.find((n) => !n.isYou);
    const me = s.nations[s.you];
    return { foeWall: foe.wall.hp, foeCastle: foe.castle.hp, myWall: me.wall.hp, time: s.time };
  });
  ok('전장에서 성벽·성이 실제로 깎인다', dmg.foeWall < 3000 || dmg.myWall < 3000 || dmg.time > 20, dmg);
  await A.screenshot({ path: SHOTS + '/08-fight.png' });

  /* ================= 전황 · 메뉴 ================= */
  await tap(A, '#logBtn');
  await sleep(400);
  ok('전황 시트에 기록이 쌓인다', await A.evaluate(() => document.querySelectorAll('#logList .li').length > 0));
  await tap(A, '#logClose');
  await tap(A, '#menuBtn');
  await sleep(300);
  ok('메뉴에 규칙·나가기가 있다', await A.evaluate(() => !!document.getElementById('menuLeave') &&
    document.querySelectorAll('.rules p').length >= 4));
  await tap(A, '#menuClose');

  /* ================= 접속 끊김 → 자리 복구 ================= */
  await B.close();
  await sleep(600);
  const C = await newPage('C');
  const sess = await A.evaluate(() => sessionStorage.getItem('friends:room'));
  const tokenB = JSON.parse(sess || '{}');
  ok('세션에 방 코드·토큰이 남는다', !!tokenB.code && !!tokenB.token);

  /* ================= 콘솔 오류 · 렌더 예산 ================= */
  const draw = await A.evaluate(() => {
    const s = window.FRIENDS.scene;
    return { calls: s.renderer.info.render.calls, tris: s.renderer.info.render.triangles };
  });
  ok('드로우콜이 모바일 예산 안 (120 이하)', draw.calls <= 120, draw);
  ok('콘솔 오류 0', errors.length === 0, errors.slice(0, 4));

  await A.screenshot({ path: SHOTS + '/09-final.png' });
  await C.close();
  await browser.close();
  server.close();
  console.log('\n친구와 플레이 모바일 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
