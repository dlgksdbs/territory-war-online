'use strict';

/* =============================================================================
   🔑 솔로 전장 리딤코드 테스트 (2026-11-28 사용자 요청)
   -----------------------------------------------------------------------------
   1) 순수 규칙 (redeem.js)
      · 코드 2012 만 통과, 잘못된 코드는 잠금 유지
      · 한 번 해금하면 localStorage 에 남아 새로고침·재접속 후에도 열려 있다
   2) 홈 화면 구조 (index.html · style.css 정적 검사)
      · 해금 전: 병력 편성 패널 · 「전장으로」 버튼이 display:none 으로 완전히 숨는다
      · 상단에는 작은 리딤코드 버튼만 있고, 입력칸 팝오버는 처음에 닫혀 있다
      · 화면 어디에도 2012 나 해금 설명 문구를 쓰지 않는다
   3) 실브라우저 확인 (puppeteer 없으면 건너뜀)
      · 잠금 상태: 병력 편성·전장으로 0, PVP 패널·버튼 설정·리딤 버튼만 보인다
      · BA.start() 직접 호출도 미해금이면 막힌다
      · 🔑 버튼 → 입력칸 → 2012 → 병력 편성·전장으로가 즉시 나타나고 새로고침 후에도 유지
   실행: node test/redeem.js   (npm test 에 포함)
   ============================================================================= */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}

/* localStorage 대역 */
function fakeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => Object.fromEntries(m)
  };
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'src', 'style.css'), 'utf8');

(async () => {
  const R = await import(pathToFileURL(path.join(ROOT, 'public', 'src', 'redeem.js')).href);

  /* ---------------------------------------------------------- 1) 순수 규칙 */
  console.log('🔑 리딤코드 — 솔로 전장 잠금');
  ok('리딤코드는 2012', R.SOLO_CODE === '2012', R.SOLO_CODE);
  ok('저장 키는 ba.soloUnlocked.v1', R.SOLO_UNLOCK_KEY === 'ba.soloUnlocked.v1', R.SOLO_UNLOCK_KEY);
  ok('2012 는 통과 (앞뒤 공백 무시)', R.isValidSoloCode('2012') && R.isValidSoloCode(' 2012 '));
  ok('다른 코드는 거절', ['201', '2013', '20120', 'code', '', null, undefined].every((v) => !R.isValidSoloCode(v)),
    ['201', '2013', '20120', 'code', '']);

  const st = fakeStorage();
  ok('처음에는 잠겨 있다', R.loadSoloUnlocked(st) === false);
  ok('해금 저장 → 새로고침 후에도 열려 있다', R.saveSoloUnlocked(st, true) === true &&
    st.getItem('ba.soloUnlocked.v1') === '1' && R.loadSoloUnlocked(st) === true, st._dump());
  ok('저장된 값이 1 이 아니면 잠금', R.loadSoloUnlocked(fakeStorage({ 'ba.soloUnlocked.v1': '0' })) === false);
  ok('해금을 지우면 다시 잠긴다', R.saveSoloUnlocked(st, false) === true && R.loadSoloUnlocked(st) === false);
  ok('저장소가 없어도 죽지 않는다', R.loadSoloUnlocked(null) === false || true);
  ok('저장소가 망가져도 잠금으로 안전하게', R.loadSoloUnlocked({ getItem() { throw new Error('quota'); } }) === false);

  /* ------------------------------------------------- 2) 홈 화면 구조 정적 검사 */
  console.log('\n🔒 해금 전 홈 화면 — 병력 편성·전장으로 숨김');
  ok('병력 편성 패널 id=armyPanel', /id="armyPanel"/.test(HTML));
  const classCards = (HTML.match(/class="class-card(?: is-on)?"/g) || []).length;
  ok('내 캐릭터(병종) 선택 패널 id=classPanel + 카드 6개',
    /id="classPanel"/.test(HTML) && classCards === 6, classCards);
  ok('「전장으로」 시작 버튼 id=startBtn', /id="startBtn"/.test(HTML));
  ok('작은 리딤코드 버튼 id=redeemOpen', /id="redeemOpen"/.test(HTML));
  ok('입력칸 팝오버(id=redeemPanel)는 처음에 닫혀 있다', /id="redeemPanel"[^>]*\bhidden\b/.test(HTML));
  ok('잠금 클래스에서 내 캐릭터·병력 편성·전장으로를 display:none 으로',
    ['classPanel', 'armyPanel', 'startBtn'].every((id) =>
      new RegExp('#home\\.is-solo-locked #' + id + ',[\\s\\S]{0,260}display:\\s*none\\s*!important').test(CSS)));
  ok('해금되면 리딤코드 버튼은 숨는다', /\.redeem-zone\.is-unlocked\s*\{\s*display:\s*none/.test(CSS));
  const HTML_TEXT = HTML.replace(/<!--[\s\S]*?-->/g, '');
  ok('홈 화면 어디에도 2012 · 해금 설명 문구 없음 (주석 제외)',
    !/2012/.test(HTML_TEXT) && !/리딤코드|해금|선착순/.test(HTML_TEXT));

  /* --------------------------------------------------- 3) 실브라우저 확인 */
  let puppeteer = null;
  try { puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer'); }
  catch (e) { console.log('\n(실브라우저 검증 건너뜀 — puppeteer 없음)'); }

  if (!puppeteer) {
    console.log('\n리딤코드 테스트 통과 · ' + passed + '개');
    process.exit(0);
  }

  const PORT = 3596;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  const stop = () => { try { server.close(); } catch (e) { /* noop */ } };
  process.on('exit', stop);

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 300000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox',
      '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 40000 });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { ready = await page.evaluate(() => !!(window.BA && window.BA.soloUi)); } catch (e) { ready = false; }
      if (!ready) await sleep(500);
    }
    ok('게임 페이지가 뜨고 BA.soloUi() 가 준비됐다', ready);

    await page.evaluate(() => localStorage.removeItem('ba.soloUnlocked.v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60; i++) {
      try { if (await page.evaluate(() => !!(window.BA && window.BA.soloUi))) break; } catch (e) { /* noop */ }
      await sleep(500);
    }
    await sleep(400);

    const locked = await page.evaluate(() => ({
      ui: window.BA.soloUi(),
      body: document.body.innerText
    }));
    ok('잠금 상태 — 내 캐릭터(병종) 선택 패널이 보이지 않는다', locked.ui.cls.found && !locked.ui.cls.shown, locked.ui.cls.display);
    ok('잠금 상태 — 병력 편성 패널이 보이지 않는다', locked.ui.army.found && !locked.ui.army.shown, locked.ui.army.display);
    ok('잠금 상태 — 「전장으로」 버튼이 보이지 않는다', locked.ui.start.found && !locked.ui.start.shown, locked.ui.start.display);
    ok('잠금 상태 — 출전 수 안내도 보이지 않는다', locked.ui.footNote.found && !locked.ui.footNote.shown, locked.ui.footNote.display);
    ok('잠금 상태 — 상단 작은 리딤코드 버튼은 보인다', locked.ui.key.shown);
    ok('잠금 상태 — 입력칸 팝오버는 닫혀 있다', locked.ui.popoverOpen === false);
    ok('잠금 상태 — PVP 패널은 그대로 보인다', locked.ui.pvp.shown);
    ok('잠금 상태 — 「버튼 크기·위치 설정」 버튼도 보인다', locked.ui.hudCfg.shown);
    ok('잠금 상태 화면에 2012 · 해금 설명 문구 없음',
      !/2012|리딤코드|해금|선착순/.test(locked.body), locked.body.replace(/\s+/g, ' ').slice(0, 120));

    /* 🔑 버튼 → 입력칸, 바깥/ESC → 닫힘 */
    await page.click('#redeemOpen');
    await sleep(300);
    ok('🔑 버튼을 누르면 입력칸이 열린다', await page.evaluate(() => !document.getElementById('redeemPanel').hidden));
    await page.keyboard.press('Escape');
    await sleep(200);
    ok('ESC 로 입력칸이 조용히 닫힌다', await page.evaluate(() => document.getElementById('redeemPanel').hidden));

    /* 미해금이면 BA.start() 로도 전장에 못 들어간다 (막히면 입력칸을 열어 준다) */
    const blocked = await page.evaluate(() => {
      window.BA.start({ cls: 'soldier', ally: 2, enemy: 2 });
      return { state: window.BA.state().state, open: !document.getElementById('redeemPanel').hidden };
    });
    ok('미해금 — BA.start() 직접 호출도 막힌다', blocked.state === 'home', blocked.state);
    ok('미해금 — 막힐 때 입력칸을 열어 준다', blocked.open === true);

    /* 열린 입력칸에 코드 입력 */
    await page.click('#redeemCode');
    await page.type('#redeemCode', '1234');
    await page.click('#redeemApply');
    await sleep(300);
    ok('틀린 코드 — 여전히 잠금', await page.evaluate(() => window.BA.solo().unlocked === false));

    await page.evaluate(() => { document.getElementById('redeemCode').value = '2012'; });
    await page.click('#redeemApply');
    await sleep(500);
    const open = await page.evaluate(() => ({
      ui: window.BA.soloUi(),
      stored: localStorage.getItem('ba.soloUnlocked.v1'),
      body: document.body.innerText
    }));
    ok('2012 입력 → 즉시 해금', open.ui.locked === false);
    ok('해금 직후 — 내 캐릭터(병종) 선택 패널이 나타난다', open.ui.cls.shown);
    ok('해금 직후 — 병력 편성 패널이 나타난다', open.ui.army.shown);
    ok('해금 직후 — 「전장으로」 버튼이 나타난다', open.ui.start.shown);
    ok('해금 직후 — 리딤코드 버튼은 사라진다', open.ui.key.found && !open.ui.key.shown, open.ui.key.display);
    ok('해금 상태가 localStorage(ba.soloUnlocked.v1)에 저장된다', open.stored === '1', open.stored);

    /* 해금 후에는 병종을 골라 바로 참전할 수 있다 */
    await page.click('.class-card[data-cls="knight"]');
    await sleep(250);
    const picked = await page.evaluate(() => ({
      cls: window.BA.config().playerClass,
      on: (document.querySelector('.class-card[data-cls="knight"]') || {}).className,
      note: (document.getElementById('classNote') || {}).textContent
    }));
    ok('해금 후 — 내 캐릭터(중갑 기사)를 골라 바꿀 수 있다', picked.cls === 'knight', picked.cls);
    ok('해금 후 — 고른 병종 카드가 선택 표시된다', /is-on/.test(picked.on || ''), picked.on);
    ok('해금 후 — 고른 병종 설명이 보인다', /망치/.test(picked.note || ''), (picked.note || '').slice(0, 30));

    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60; i++) {
      try { if (await page.evaluate(() => !!(window.BA && window.BA.soloUi))) break; } catch (e) { /* noop */ }
      await sleep(500);
    }
    await sleep(300);
    const again = await page.evaluate(() => ({ ui: window.BA.soloUi(), body: document.body.innerText }));
    ok('새로고침 후에도 해금 유지 — 내 캐릭터·병력 편성·전장으로가 보인다',
      again.ui.cls.shown && again.ui.army.shown && again.ui.start.shown);
    ok('새로고침 후 — 화면에 2012 가 다시 나오지는 않는다', !/2012/.test(again.body));

    ok('콘솔·페이지 오류 없음', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }

  console.log('\n리딤코드 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
