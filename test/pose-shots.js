'use strict';

/* =============================================================================
   🎬 모션 연속 프레임 + 🔑 리딤코드 화면 캡처 (눈으로 확인용)
   -----------------------------------------------------------------------------
   2026-11-28 "모션 더 열심히 깎아" / "솔로전장 리딤코드 2012" 확인용 스크린샷.
   1) 홈: 잠금 상태 → 2012 입력 → 해금 상태
   2) 모션: 걷기·공격·막기·피격·대기 연속 프레임(3인칭 유닛), 1인칭 뷰모델 스윙
   실행: node test/pose-shots.js  (npm test 아님 · 확인용)
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.SHOT_DIR || '/workspace/screenshots-battle-arena-2026-11-28-motion';
const PORT = 3599;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  process.on('exit', () => { try { server.close(); } catch (e) { /* noop */ } });

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']
  });
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|Shader|AudioContext|GL_INVALID/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 40000 });
  /* 페이지 준비 — waitForFunction 대신 직접 폴링 (이 환경에서 간헐적으로 대기가 멈추는 일이 있어) */
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    try { ready = await page.evaluate(() => !!(window.BA && window.BA.solo)); } catch (e) { ready = false; }
    if (!ready) await sleep(1000);
  }
  if (!ready) { console.log('페이지 준비 실패:' + errors.slice(0, 3).join(' | ')); await browser.close(); process.exit(1); }
  console.log('페이지 준비 완료');
  await sleep(700);

  const shot = async (name, el) => {
    const f = path.join(SHOTS, String(++n).padStart(2, '0') + '-' + name + '.png');
    if (el) {
      const h = await page.$(el);
      if (h) { await h.screenshot({ path: f }); console.log('  · ' + path.basename(f)); return f; }
    }
    await page.screenshot({ path: f });
    console.log('  · ' + path.basename(f));
    return f;
  };

  /* ===== 1. 리딤코드 화면 ===== */
  console.log('🔑 리딤코드 홈 화면');
  await page.evaluate(() => {
    document.getElementById('redeemPanel').scrollIntoView({ block: 'center' });
  });
  await sleep(500);
  await shot('home-locked-redeem');
  const lockedInfo = await page.evaluate(() => ({
    unlocked: window.BA.solo().unlocked,
    btn: document.querySelector('#startBtn .sb-text strong').textContent,
    note: document.getElementById('redeemNote').textContent
  }));
  console.log('   잠금 상태:', JSON.stringify(lockedInfo));

  await page.evaluate(() => {
    document.getElementById('redeemCode').value = '1234';
    document.getElementById('redeemApply').click();
  });
  await sleep(400);
  await shot('home-wrong-code');
  console.log('   잘못된 코드 안내:', await page.evaluate(() => document.getElementById('redeemNote').textContent));

  await page.evaluate(() => {
    document.getElementById('redeemCode').value = '2012';
    document.getElementById('redeemApply').click();
  });
  await sleep(600);
  await shot('home-unlocked');
  console.log('   해금 상태:', JSON.stringify(await page.evaluate(() => ({
    unlocked: window.BA.solo().unlocked, stored: localStorage.getItem('ba.soloUnlocked.v1'),
    btn: document.querySelector('#startBtn .sb-text strong').textContent
  }))));

  /* ===== 2. 모션 연속 프레임 ===== */
  console.log('🎬 모션 연속 프레임 (3인칭 유닛)');
  await page.evaluate(() => window.BA.start({
    cls: 'blademaster', ally: 3, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0
  }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().units > 0, { timeout: 40000 });
  await sleep(1200);

  const frameSet = async (label, kind, cls, times) => {
    for (const t of times) {
      const good = await page.evaluate((o) => window.BA.debug.solo(o.cls, o.kind, o.t), { cls, kind, t });
      if (!good) { console.log('   (포즈 대상 없음: ' + cls + ')'); return; }
      await sleep(220);
      await shot(label + '-' + String(t).replace('.', 'p'));
    }
  };

  /* 매화 검객을 전장에 세우고 걷기 → 공격 → 막기 → 피격 */
  await page.evaluate(() => { window.BA.debug.spawn('blademaster', 'ally', 0, 2); window.BA.debug.spawn('knight', 'ally', 3, 2); });
  await sleep(600);
  await frameSet('walk-blademaster', 'walk', 'blademaster', [0, 1.05, 2.1, 3.14, 4.19, 5.24]);
  await frameSet('attack-blademaster', 'attack', 'blademaster', [0.04, 0.12, 0.22, 0.31, 0.42, 0.60]);
  await frameSet('guard-blademaster', 'guard', 'blademaster', [0]);
  await frameSet('stagger-blademaster', 'stagger', 'blademaster', [0.06, 0.16, 0.26]);

  /* 일반 병사 공격 (PVP 와 같은 클래스) */
  await frameSet('walk-soldier', 'walk', 'soldier', [0, 1.6, 3.14, 4.7]);
  await frameSet('attack-soldier', 'attack', 'soldier', [0.06, 0.2, 0.3, 0.42, 0.56, 0.74]);
  /* 중갑 기사 내리치기 — 무게감 */
  await frameSet('attack-knight', 'attack', 'knight', [0.3, 0.56, 0.8, 0.95, 1.2]);

  /* ===== 2b. 🩸 상흔 앞/뒤 + 망토 찢어짐 ===== */
  console.log('🩸 상흔 앞/뒤 · 망토 찢어짐');
  const scarShot = async (label, yaw, srcZ) => {
    await page.evaluate((o) => {
      const app = window.BA.app;
      const b = window.BA.battle;
      const u = b.units.find((x) => x.cls === 'soldier' && !x.isPlayer) || b.units.find((x) => !x.isPlayer);
      if (!u) return false;
      app.debugLock = null;
      app.paused = true;
      app.debugCam = true;
      app.vm.enabled = false;
      b.player.hideModel = true;
      for (const x of b.units) if (x !== u && !x.isPlayer) x.hideModel = true;
      u.hideModel = false; u.dead = false; u.deadT = 0; u.removed = false;
      u.attackT = -1; u.moveAmt = 0; u.guard = false; u._guardK = 0;
      u.x = 0; u.z = 0; u.y = 0; u.yaw = o.yaw;
      app.cam.position.set(0.55, 1.35, -2.7);
      app.cam.lookAt(0, 1.02, 0);
      /* 실제 피격 경로 그대로 — 앞/뒤 판정은 fx.onHit 이 한다 */
      window.BA.app.fx.handle([{
        type: 'hit', source: { x: 0, z: o.srcZ, yaw: 0 }, target: u, dmg: 12, kind: 'blade',
        part: 'body', lethal: false, hx: 0, hz: 0, hy: 1.1, angle: 0
      }], b);
      for (let i = 0; i < 8; i++) window.BA.app.fx.update(1 / 60, b, app.cam);
      return true;
    }, { yaw, srcZ });
    await sleep(340);
    await shot(label);
  };
  await scarShot('scar-front', Math.PI, -1.4);   // 정면을 보고 서 있고 공격자는 앞
  await scarShot('scar-back', 0, -1.4);          // 등을 보이고 있고 공격자는 뒤

  /* ===== 3. 1인칭 뷰모델 스윙 ===== */
  console.log('🗡️ 1인칭 뷰모델 스윙');
  await page.evaluate(() => {
    window.BA.debug.lockFree();
    const b = window.BA.battle;
    const p = b.player;
    b.player.hideModel = true;
    window.BA.app.vm.enabled = true;
    window.BA.app.debugLock = null;
    window.BA.app.paused = true;
    window.BA.app.camMode = 'fp';
    p.dead = false; p.attackT = -1;
    p.x = 0; p.z = 0; p.yaw = 0;
    window.BA.app.camYaw = Math.PI;
  });
  await sleep(300);
  for (const t of [0.02, 0.12, 0.22, 0.3, 0.4, 0.52]) {
    await page.evaluate((tt) => {
      const app = window.BA.app;
      const b = app.battle;
      b.player.attackT = tt;
      b.player.hitDone = true;
      app.paused = true;
      for (let i = 0; i < 3; i++) app.vm.update(1 / 60, b.player, app.input, app.time + i / 60, app.camYaw + Math.PI, app.camPitch);
    }, t);
    await sleep(180);
    await shot('viewmodel-swing-' + String(t).replace('.', 'p'));
  }

  console.log('\\n콘솔/페이지 오류: ' + (errors.length ? errors.slice(0, 5).join(' | ') : '없음'));
  console.log('스크린샷 폴더: ' + SHOTS);
  await browser.close();
  try { server.close(); } catch (e) { /* noop */ }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
