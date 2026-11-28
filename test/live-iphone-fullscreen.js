'use strict';

/* =============================================================================
   🌐 라이브 확인 — 📱 아이폰 전체화면(의사 전체화면) + 🧽 바닥 무광
   -----------------------------------------------------------------------------
   Railway 실서버(https://territory-war-online-production.up.railway.app)에 390×844
   아이폰 사파리 흉내(전체화면 API 제거)로 접속해:
   1) 홈 ⛶ → 의사 전체화면 · 다시 눌러 해제
   2) PVP 대기실 ⛶ (새 버튼) → 의사 전체화면
   3) 옥타곤 전투 HUD ⛶ 상태 공유 · 화면 꽉 채우기
   4) 🧽 매트를 내려다본 화면 — 하얗게 번들거리는 픽셀 비율
   실행: node test/live-iphone-fullscreen.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.LIVE_BASE || 'https://territory-war-online-production.up.railway.app';
const SHOTS = process.env.LIVE_SHOTS || '/workspace/screenshots-battle-arena-2026-11-28-iphone-live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const T0 = Date.now();
function ok(name, cond, extra) {
  if (!cond) { console.error('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)); throw new Error('테스트 실패: ' + name); }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)) + '  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new', protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
      '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage']
  });
  const errors = [];
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { get: () => false, configurable: true });
      const kill = (obj, key) => { try { delete obj[key]; } catch (e) { /* noop */ } try { Object.defineProperty(obj, key, { value: undefined, configurable: true }); } catch (e) { /* noop */ } };
      kill(Element.prototype, 'requestFullscreen');
      kill(Element.prototype, 'webkitRequestFullscreen');
      kill(HTMLElement.prototype, 'requestFullscreen');
      kill(HTMLElement.prototype, 'webkitRequestFullscreen');
    } catch (e) { /* noop */ }
  });
  page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('  [pageerror] ' + e.message); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/AudioContext|WebGLProgram|Shader Error|VALIDATE_STATUS|could not be created|Error creating WebGL/.test(t)) return;
    errors.push(t);
  });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(BASE + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 90; i++) { if (await page.evaluate(() => !!(window.BA && window.BA.pvp)).catch(() => false)) break; await sleep(1000); }
  console.log('라이브 접속', BASE);
  await page.evaluate(() => window.BA.redeem('2012'));
  await sleep(800);

  const state = () => page.evaluate(() => ({
    on: window.BA.fullscreen.isOn(),
    pseudo: document.documentElement.classList.contains('is-pseudo-fullscreen'),
    appPseudo: document.getElementById('app').classList.contains('is-pseudo-fullscreen'),
    appFs: document.getElementById('app').classList.contains('is-fullscreen'),
    home: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'),
    lobby: document.getElementById('fsLobbyBtn') ? document.getElementById('fsLobbyBtn').getAttribute('aria-pressed') : null,
    battle: document.getElementById('fsBtn').getAttribute('aria-pressed'),
    label: document.getElementById('fsHomeBtn').getAttribute('aria-label'),
    appH: Math.round(document.getElementById('app').getBoundingClientRect().height)
  }));

  /* 1. 홈 */
  await page.click('#fsHomeBtn');
  await sleep(700);
  const s1 = await state();
  ok('📱 라이브 홈 — ⛶ 를 누르면 아이폰에서도 전체화면(의사 전체화면)으로 들어간다',
    s1.on === true && s1.pseudo && s1.appPseudo && s1.appFs && s1.home === 'true' && /끄기/.test(s1.label) && s1.appH >= 800, s1);
  await page.screenshot({ path: path.join(SHOTS, '01-live-home-pseudo-fullscreen.png') });
  await page.click('#fsHomeBtn');
  await sleep(500);
  const s2 = await state();
  ok('📱 다시 누르면 해제된다', s2.on === false && !s2.pseudo && s2.home === 'false', s2);

  /* 2. PVP 대기실 */
  await page.evaluate(() => window.BA.pvp.create('한윤'));
  await page.waitForFunction(() => { const l = document.getElementById('pvpLobby'); return l && l.classList.contains('is-on') && window.BA.pvp.lobby(); }, { timeout: 25000, polling: 150 });
  const lobbyBtn = await page.evaluate(() => {
    const b = document.getElementById('fsLobbyBtn');
    if (!b) return { exists: false };
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { exists: true, w: Math.round(r.width), h: Math.round(r.height), pushed: !!(hit && hit.closest('#fsLobbyBtn')), inView: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  ok('⚔️ 라이브 PVP 대기실 머리에 ⛶ 버튼이 보이고 눌린다', lobbyBtn.exists && lobbyBtn.pushed && lobbyBtn.inView, lobbyBtn);
  await page.screenshot({ path: path.join(SHOTS, '02-live-lobby-fs-button.png') });
  await page.click('#fsLobbyBtn');
  await sleep(700);
  const s3 = await state();
  ok('📱 라이브 대기실에서 ⛶ → 전체화면 (세 버튼 상태가 함께 바뀐다)',
    s3.on === true && s3.pseudo && s3.lobby === 'true' && s3.home === 'true' && s3.battle === 'true', s3);
  await page.screenshot({ path: path.join(SHOTS, '03-live-lobby-pseudo-fullscreen.png') });

  /* 3. 옥타곤 전투 */
  await page.evaluate(() => window.BA.pvp.team('ally'));
  await page.evaluate(() => window.BA.pvp.conf({ mode: 'kills', killTarget: 30, bots: { ally: 0, enemy: 1 } }));
  await sleep(500);
  /* 전투가 시작되자마자 무적 — AI 에 맞아 눕기 전에 '서서 바닥을 보는' 화면을 찍기 위해 */
  await page.evaluate(() => {
    window.__invuln = setInterval(() => {
      const b = window.BA.app && window.BA.app.battle;
      if (b && b.pvp) { b.playerInvuln = 1e9; b.player.hp = b.player.maxHp; b.player.dead = false; }
    }, 40);
  });
  await page.evaluate(() => window.BA.pvp.start());
  await page.waitForFunction(() => { const s = window.BA.pvp.state(); return s && s.inBattle; }, { timeout: 90000, polling: 30 });
  /* 전투가 뜨자마자 멈춰 세운다 (AI 가 때리기 전에) — 피해·사망 연출이 끼지 않게 */
  const froze = await page.evaluate(() => {
    const app = window.BA.app;
    const b = app.battle;
    if (!b) return false;
    b.playerInvuln = 1e9;
    b.player.hp = b.player.maxHp;
    b.player.dead = false;
    app.paused = true;
    app.debugCam = true;
    app.debugLock = null;
    app.vm.enabled = false;
    b.player.hideModel = true;
    for (const u of b.units) u.hideModel = true;
    if (app.fx && app.fx.clear) app.fx.clear();
    app.cam.position.set(0, 1.62, 6.4);
    app.cam.lookAt(0, 0.02, -1.0);
    return true;
  });
  await sleep(1400);
  const s4 = await state();
  const oct = await page.evaluate(() => window.BA.oct());
  ok('🥊 라이브 옥타곤 전투 — 전체화면 상태가 그대로 유지된다 (HUD ⛶ 포함)',
    froze && s4.on === true && s4.pseudo && s4.battle === 'true' && oct && oct.apothem === 15, { oct: oct && oct.floor, s4: { on: s4.on, battle: s4.battle } });
  ok('🧽 라이브 매트·받침이 무광이다 (roughness 0.99/0.98 · metalness 0 · envMap ≤ 0.1)',
    oct && oct.floor && oct.floor.mat.roughness >= 0.95 && oct.floor.mat.metalness === 0 && oct.floor.mat.env <= 0.1 &&
    oct.floor.base.roughness >= 0.95 && oct.floor.base.metalness === 0 && oct.floor.base.env <= 0.1, oct && oct.floor);

  /* 매트를 내려다본 화면 — 유닛·이펙트·피격 연출만 걷어 낸다 (HUD 는 그대로) */
  await page.evaluate(() => {
    const app = window.BA.app;
    const b = app.battle;
    if (app.fx && app.fx.clear) app.fx.clear();
    for (const u of b.units) u.hideModel = true;
    b.player.hp = b.player.maxHp;
    b.player.dead = false;
    const names = document.getElementById('pvpNames'); if (names) names.style.display = 'none';
    /* 화면을 덮는 피격·사망 오버레이 숨김 (HUD·캔버스는 남긴다) */
    for (const el of document.querySelectorAll('#battle *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (el.id === 'gl' || el.classList.contains('hud') || el.classList.contains('hud-bottom')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      el.style.display = 'none';
    }
    app.fx && app.fx.clear && app.fx.clear();
    app.cam.position.set(0, 1.62, 6.4);
    app.cam.lookAt(0, 0.02, -1.0);
  });
  await sleep(1200);
  const pixel = await page.evaluate(() => {
    const app = window.BA.app;
    const gl = document.getElementById('gl');
    app.renderer.render(app.scene, app.cam);
    const c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(gl, 0, 0, c.width, c.height);
    const x0 = Math.floor(c.width * 0.2), w = Math.floor(c.width * 0.6);
    const y0 = Math.floor(c.height * 0.55), h = Math.floor(c.height * 0.42);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0, sum = 0, hot = 0, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++; sum += l; if (l > max) max = l;
      if (l > 235) hot++;
    }
    return { mean: +(sum / n).toFixed(1), max: Math.round(max), hotPct: +((hot / n) * 100).toFixed(2) };
  });
  console.log('  · 라이브 바닥 픽셀 ' + JSON.stringify(pixel));
  await page.screenshot({ path: path.join(SHOTS, '04-live-octagon-floor-matte.png') });
  ok('🧽 라이브 매트가 하얗게 번들거리지 않는다 (번쩍이는 픽셀 0.5% 미만 · 최고 밝기 245 이하)',
    pixel.hotPct < 0.5 && pixel.max <= 245, pixel);

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 4));
  console.log('\n🌐 라이브 📱 전체화면 · 🧽 바닥 무광 확인 통과 · ' + passed + '개  →  ' + SHOTS);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('라이브 확인 오류:', (e && e.stack) || e); process.exit(1); });
