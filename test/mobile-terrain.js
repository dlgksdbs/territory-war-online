'use strict';

/* =============================================================================
   ⛰️ 지면 높이 추종 · 🪨 지형물(장애물) 충돌 — 390×844 실브라우저 검증
   -----------------------------------------------------------------------------
   1) 지형 높이 함수가 전장 안에서도 오르내린다 (언덕·기복)
   2) 모든 AI 유닛의 y 가 자기 자리의 지면 높이와 같다 (발이 땅에 붙는다)
   3) 1인칭 카메라(눈높이)도 지면을 따라 오르내린다
   4) 바위·기둥·횃불 같은 지형물을 뚫고 지나갈 수 없다 (밀려난다)
   5) 관전 카메라는 지면 아래로 파고들지 않는다
   6) 🚶 걷기 위상이 실제 이동 거리에 맞춰 오른다 (발 미끄러짐 방지)
   실행: node test/mobile-terrain.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.TERRAIN_SHOTS || '/workspace/screenshots-battle-arena-2026-11-27-terrain';
const PORT = 3599;
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
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/AudioContext/.test(m.text())) return;
    if (/WebGLProgram|Shader Error|VALIDATE_STATUS|could not be created|Error creating WebGL/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.BA && window.BA.start, { timeout: 90000, polling: 150 });
  await sleep(400);

  console.log('▶ 지면 추종 · 지형물 충돌 (390×844)');
  /* 작은 전장 하나 — 병사 12 vs 12 */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 6, enemy: 6 }));
  await page.waitForFunction(() => {
    const st = window.BA.state();
    return st && st.state === 'battle' && st.frames > 4;
  }, { timeout: 60000, polling: 150 }).catch(async (e) => {
    console.error('   [전장 진입 실패]', JSON.stringify(await page.evaluate(() => window.BA.state())).slice(0, 300));
    throw e;
  });
  await sleep(1800);

  /* 1) 지형 높이 기복 */
  const heights = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = (i % 5) * 8 + 4;
      out.push(+window.BA.ground(Math.cos(a) * r, Math.sin(a) * r).toFixed(3));
    }
    return out;
  });
  const hMin = Math.min(...heights), hMax = Math.max(...heights);
  ok('지형이 전장 안에서도 오르내린다 (높이 차 > 0.3m)', hMax - hMin > 0.3, { min: hMin, max: hMax });

  /* 2) 모든 AI 유닛이 지면 높이를 따라간다 */
  const unitGround = await page.evaluate(() => {
    const b = window.BA.battle;
    let worst = 0, n = 0;
    for (const u of b.units) {
      if (u.dead || u.isPlayer) continue;
      const g = window.BA.ground(u.x, u.z);
      worst = Math.max(worst, Math.abs((u.y || 0) - g));
      n++;
    }
    return { worst: +worst.toFixed(4), n };
  });
  ok('모든 병사의 y 가 자기 자리의 지면 높이와 같다', unitGround.n > 6 && unitGround.worst < 0.02, unitGround);

  /* 3) 1인칭 카메라 눈높이가 지면을 따라간다 */
  const camFollow = await page.evaluate(() => {
    const app = window.BA.app;
    const p = app.battle.player;
    /* 높은 지점과 낮은 지점을 찾는다 */
    let hi = null, lo = null;
    for (let x = -34; x <= 34; x += 3) {
      for (let z = -34; z <= 34; z += 3) {
        const g = window.BA.ground(x, z);
        if (!hi || g > hi.g) hi = { x, z, g };
        if (!lo || g < lo.g) lo = { x, z, g };
      }
    }
    return { hi, lo, eye: +app.cam.position.y.toFixed(2) };
  });
  ok('높은 곳·낮은 곳의 차이를 확인할 수 있다', camFollow.hi.g - camFollow.lo.g > 0.5, camFollow);
  await page.evaluate((hi) => {
    const p = window.BA.app.battle.player;
    p.x = hi.x; p.z = hi.z;
  }, camFollow.hi);
  await sleep(500);
  const camHi = await page.evaluate(() => {
    const app = window.BA.app;
    const p = app.battle.player;
    return { cam: +app.cam.position.y.toFixed(2), ground: +window.BA.ground(p.x, p.z).toFixed(2), p: +p.y.toFixed(2) };
  });
  ok('높은 지면 위에서는 카메라(눈높이)도 같이 올라간다',
    Math.abs(camHi.cam - (camHi.ground + 1.65)) < 0.12 && Math.abs(camHi.p - camHi.ground) < 0.02, camHi);
  await page.screenshot({ path: path.join(SHOTS, '01-terrain-high.png') });

  await page.evaluate((lo) => {
    const p = window.BA.app.battle.player;
    p.x = lo.x; p.z = lo.z;
  }, camFollow.lo);
  await sleep(400);
  const camLo = await page.evaluate(() => {
    const app = window.BA.app;
    const p = app.battle.player;
    return { cam: +app.cam.position.y.toFixed(2), ground: +window.BA.ground(p.x, p.z).toFixed(2) };
  });
  ok('낮은 지면으로 내려가면 카메라도 내려온다',
    Math.abs(camLo.cam - (camLo.ground + 1.65)) < 0.12 && camLo.cam < camHi.cam - 0.2,
    { high: camHi, low: camLo });
  await page.screenshot({ path: path.join(SHOTS, '02-terrain-low.png') });

  /* 4) 지형물(바위·기둥·횃불) 통과 금지 */
  const cols = await page.evaluate(() => {
    const c = (window.BA.app.world.colliders || []).slice();
    return { n: c.length, sample: c.sort((a, b) => b.r - a.r).slice(0, 4) };
  });
  ok('전장 지형물 콜라이더가 모여 있다 (바위·기둥·횃불·깃대)', cols.n >= 20, { n: cols.n });
  const push = await page.evaluate((c) => {
    const app = window.BA.app;
    const p = app.battle.player;
    p.x = c.x + 0.05; p.z = c.z + 0.05;
    const u = app.battle.units.find((x) => !x.isPlayer && !x.dead && !x.net);
    if (u) { u.x = c.x - 0.05; u.z = c.z - 0.05; }
    return { target: c, hasUnit: !!u };
  }, cols.sample[0]);
  await sleep(350);
  const pushed = await page.evaluate((c) => {
    const app = window.BA.app;
    const p = app.battle.player;
    const u = app.battle.units.find((x) => !x.isPlayer && !x.dead && !x.net);
    const dp = Math.hypot(p.x - c.x, p.z - c.z);
    const du = u ? Math.hypot(u.x - c.x, u.z - c.z) : 0;
    return { dp: +dp.toFixed(3), du: +du.toFixed(3), r: c.r, prad: p.radius, urad: u ? u.radius : 0 };
  }, push.target);
  ok('플레이어가 지형물 안으로 들어가면 밀려난다',
    pushed.dp >= pushed.r + pushed.prad * 0.85, pushed);
  ok('AI 병사도 지형물을 뚫지 못한다',
    !push.hasUnit || pushed.du >= pushed.r + pushed.urad * 0.85, pushed);

  /* 걸어가며 지형물을 통과하지 않는지 — 지형물 정면으로 계속 걸어간다 */
  const walkBlock = await page.evaluate((c) => {
    const app = window.BA.app;
    const p = app.battle.player;
    /* 지형물 남쪽 3m 지점에서 지형물 쪽(+z)을 보게 */
    p.x = c.x; p.z = c.z - Math.max(2.4, c.r + 1.6);
    p.yaw = 0; app.camYaw = p.yaw + Math.PI;
    return { from: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } };
  }, cols.sample[0]);
  await page.keyboard.down('KeyW');
  await sleep(1800);
  await page.keyboard.up('KeyW');
  await sleep(150);
  const walkedInto = await page.evaluate((c) => {
    const p = window.BA.app.battle.player;
    return {
      d: +Math.hypot(p.x - c.x, p.z - c.z).toFixed(2),
      r: c.r,
      z: +p.z.toFixed(2), cz: +c.z.toFixed(2)
    };
  }, cols.sample[0]);
  ok('지형물 쪽으로 계속 걸어도 안을 통과하지 못한다 (앞에서 막힘)',
    walkedInto.d >= walkedInto.r + 0.2, { ...walkedInto, from: walkBlock.from });
  await page.screenshot({ path: path.join(SHOTS, '03-obstacle-block.png') });

  /* 5) 관전 카메라가 지면 아래로 파고들지 않는다 */
  await page.evaluate(() => window.BA.setCameraMode('spectate'));
  await sleep(300);
  const spec = await page.evaluate(() => {
    const app = window.BA.app;
    if (!app.spectate) return null;
    app.spectate.y = -20;
    return { g: window.BA.ground(app.spectate.x, app.spectate.z) };
  });
  await sleep(400);
  const specY = await page.evaluate(() => {
    const app = window.BA.app;
    return { cam: +app.cam.position.y.toFixed(2), g: +window.BA.ground(app.cam.position.x, app.cam.position.z).toFixed(2) };
  });
  ok('관전 카메라는 지면 아래로 내려가지 않는다', specY.cam >= specY.g + 0.5, { ...specY, g0: spec && spec.g });
  await page.screenshot({ path: path.join(SHOTS, '04-spectate-ground.png') });
  await page.evaluate(() => window.BA.setCameraMode('fp'));
  await sleep(200);

  /* 6) 걷기 위상이 이동 거리에 맞춰 오른다 */
  const walk0 = await page.evaluate(() => {
    const b = window.BA.battle;
    const u = b.units.find((x) => !x.isPlayer && !x.dead && !x.net) || null;
    return u ? { id: u.id, ph: +u.walkPhase.toFixed(3), x: +u.x.toFixed(2), z: +u.z.toFixed(2) } : null;
  });
  await sleep(700);
  const walk1 = await page.evaluate((id) => {
    const u = window.BA.battle.units.find((x) => x.id === id);
    if (!u) return null;
    return { ph: +u.walkPhase.toFixed(3), x: +u.x.toFixed(2), z: +u.z.toFixed(2), move: +u.moveAmt.toFixed(2) };
  }, walk0 && walk0.id);
  ok('걷는 병사의 걸음 위상이 실제 이동에 맞춰 계속 오른다',
    !!walk1 && Number.isFinite(walk1.ph) && walk1.ph !== walk0.ph, { before: walk0, after: walk1 });

  /* 걸어가는 연속 프레임(시각 확인용) */
  for (let i = 0; i < 3; i++) {
    await page.screenshot({ path: path.join(SHOTS, '05-walk-' + i + '.png') });
    await sleep(260);
  }

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 5));

  console.log('\n지면 추종 · 지형물 충돌 검증 통과 · ' + passed + '개');
  await browser.close();
  stop();
  process.exit(0);
})().catch((e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
