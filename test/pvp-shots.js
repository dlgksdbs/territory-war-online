'use strict';

/* =============================================================================
   ⚔️ PVP 화면 확인용 캡처 (한 탭 + AI 병력) — 390×844
   -----------------------------------------------------------------------------
   1) PVP 체력 표시 1000/1000 → AI 병력에게 맞은 뒤 900/1000
   2) 🥊 유닛·플레이어 발이 옥타곤 매트 위에 올라와 있는지 (파묻힘 0) — 낮은 카메라
   두 탭을 동시에 돌리면 이 환경(2GB·소프트웨어 GL)에서 렌더러가 죽어서,
   방은 혼자 만들고 적군은 AI 병력으로 세운다 (서버·클라이언트 경로는 동일).
   실행: node test/pvp-shots.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.PVP_SHOT_DIR || '/workspace/screenshots-battle-arena-2026-11-28-pvp';
const PORT = 3600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const PVP = require(path.join(ROOT, 'pvp.js'));
  const { createServer, rooms } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  process.on('exit', () => { try { server.close(); } catch (e) { /* noop */ } });

  const browser = await puppeteer.launch({
    headless: 'new', protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']
  });
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|Shader|AudioContext|GL_INVALID/.test(m.text())) { errors.push(m.text()); console.log('CONSOLE', m.text().slice(0, 200)); } });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) { try { ready = await page.evaluate(() => !!(window.BA && window.BA.pvp)); } catch (e) { /* noop */ } if (!ready) await sleep(1000); }
  if (!ready) throw new Error('페이지 준비 실패');
  await page.evaluate(() => window.BA.redeem('2012'));
  await sleep(500);

  const shot = async (name) => {
    const f = path.join(SHOTS, String(++n).padStart(2, '0') + '-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('  · ' + path.basename(f));
    return f;
  };

  /* 방 만들기 → 적군 AI 2명 → 시작 */
  await page.evaluate(() => window.BA.pvp.create('한윤'));
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(() => { const l = window.BA.pvp.lobby(); return !!(l && l.code); });
    if (ok) break;
    await sleep(400);
  }
  const code = await page.evaluate(() => window.BA.pvp.lobby().code);
  console.log('방 코드', code);
  await page.evaluate(() => window.BA.pvp.send({ type: 'pteam', team: 'ally' }));
  await page.evaluate(() => window.BA.pvp.send({ type: 'pconf', mode: 'kills', killTarget: 30, bots: { ally: 0, enemy: 1 } }));
  await sleep(600);
  await page.evaluate(() => window.BA.pvp.start());
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => (window.BA.pvp.state() || {}).inBattle);
    if (st) break;
    await sleep(400);
  }
  /* 전투가 시작되자마자 1000/1000 을 찍는다 (AI 병력이 닿기 전) */
  await sleep(250);

  const room = rooms.get(code);
  /* 이 환경은 프레임이 느려 AI 병력이 먼저 달려와 때린다 — 잠시 눕혀 두고
     체력 표시(1000/1000 → 900/1000)를 정확히 만든 뒤 찍는다 (부활은 10분 뒤로) */
  if (room && room.pvp) {
    for (const b of room.pvp.bots) { b.dead = true; b.hp = 0; b.respawnAt = Date.now() + 600000; }
    for (const e of room.pvp.ents.values()) { e.hp = e.maxHp; e.dead = false; e.deathAt = 0; e.respawnAt = 0; }
  }
  await sleep(1200);
  await page.evaluate(() => { try { window.BA.app._syncHUD(true); } catch (e) { /* noop */ } });
  await sleep(300);
  console.log('옥타곤', JSON.stringify(await page.evaluate(() => window.BA.oct())));

  /* 내 체력 표시 — 전장 HUD 의 체력바/숫자 */
  const hpShown = async () => page.evaluate(() => {
    const b = window.BA.battle;
    const p = b && b.player;
    const st = window.BA.pvp.state();
    return {
      hud: (document.getElementById('hpText') || {}).textContent || '',
      barW: (document.getElementById('hpBar') || { style: {} }).style.width || '',
      meHp: p ? Math.round(p.hp) : null, meMx: p ? Math.round(p.maxHp) : null,
      serverHp: st && st.me ? Math.round(st.me.hp) : null,
      serverMx: st && st.me ? Math.round(st.me.mx) : null
    };
  });
  const hp0 = await hpShown();
  console.log('시작 체력', JSON.stringify(hp0));
  await shot('pvp-hp-1000');

  /* 서버 권위로 정확히 한 대(100) 맞은 상태를 만든다 — AI 가 달려오기 전에 900/1000 확인 */
  {
    const r2 = rooms.get(code);
    const ent = r2.pvp.ents.values().next().value;   // 참가자는 나 한 명
    console.log('피해 대상', JSON.stringify({ slot: ent && ent.slot, hp: ent && ent.hp }));
    PVP.hurt(r2, r2.pvp, ent, 100, null, 'blade');
  }
  await sleep(1200);
  await page.evaluate(() => { try { window.BA.app._syncHUD(true); } catch (e) { /* noop */ } });
  await sleep(300);
  const hpAfter = await hpShown();
  console.log('피격 후', JSON.stringify(hpAfter));
  await shot('pvp-hp-900');

  /* 🥊 발이 매트 위인지 — 낮은 카메라로 상대 발끝을 본다 */
  const feet = await page.evaluate(() => {
    const app = window.BA.app;
    const b = window.BA.battle;
    const st = window.BA.pvp.client.lastState;
    const you = window.BA.pvp.state().you;
    const foeE = st && st.ents ? st.ents.find((e) => e.s !== you) : null;
    const me = b.player;
    const units = window.BA.pvp.state().others || [];
    const u = units[0];
    app.paused = true;
    app.debugCam = true;
    app.vm.enabled = false;
    me.hideModel = true;
    const tx = u ? u.x : (foeE ? foeE.x : 0);
    const tz = u ? u.z : (foeE ? foeE.z : 0);
    /* 발끝 높이만 보이게 카메라를 매트 높이에 가깝게 */
    const gy = window.BA.ground(tx, tz, true);
    app.cam.position.set(tx + 1.9, gy + 0.55, tz - 1.9);
    app.cam.lookAt(tx, gy + 0.30, tz);
    return { tx: +tx.toFixed(2), tz: +tz.toFixed(2), gy: +gy.toFixed(3), matTop: +(window.BA.oct().matTop || 0).toFixed(3) };
  });
  console.log('발 위치', JSON.stringify(feet));
  await sleep(600);
  await shot('pvp-feet-on-mat');
  /* 살짝 더 멀리서 무릎까지 */
  await page.evaluate((o) => {
    const app = window.BA.app;
    app.cam.position.set(o.tx + 2.6, o.gy + 1.15, o.tz - 2.8);
    app.cam.lookAt(o.tx, o.gy + 0.75, o.tz);
  }, feet);
  await sleep(500);
  await shot('pvp-feet-on-mat-wide');

  console.log('콘솔/페이지 오류: ' + (errors.length ? errors.slice(0, 4).join(' | ') : '없음'));
  await browser.close();
  try { server.close(); } catch (e) { /* noop */ }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
