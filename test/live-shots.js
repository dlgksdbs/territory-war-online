'use strict';

/* =============================================================================
   🌐 라이브 화면 확인 (Railway 실서버 · 390×844)
   -----------------------------------------------------------------------------
   1) 홈: 🔑 리딤코드 잠금 상태 → 2012 입력 → 해금
   2) PVP: 체력 1000/1000 → AI 병력에게 한 대 맞은 뒤 900/1000
   3) 🥊 옥타곤: 유닛 발이 매트 위에 올라와 있는지 (낮은 카메라)
   실행: node test/live-shots.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.LIVE_BASE || 'https://territory-war-online-production.up.railway.app';
const SHOTS = process.env.LIVE_SHOTS || '/workspace/screenshots-battle-arena-2026-11-28-live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
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
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|Shader|AudioContext|GL_INVALID/.test(m.text())) { errors.push(m.text()); console.log('CONSOLE', m.text().slice(0, 160)); } });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(BASE + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) { try { ready = await page.evaluate(() => !!(window.BA && window.BA.pvp)); } catch (e) { /* noop */ } if (!ready) await sleep(1000); }
  if (!ready) throw new Error('라이브 페이지 준비 실패');
  console.log('라이브 접속', BASE);
  await sleep(800);

  const shot = async (name) => {
    const f = path.join(SHOTS, String(++n).padStart(2, '0') + '-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('  · ' + path.basename(f));
    return f;
  };

  /* ===== 1. 리딤코드 ===== */
  await page.evaluate(() => { document.getElementById('redeemPanel').scrollIntoView({ block: 'center' }); });
  await sleep(500);
  await shot('home-locked');
  console.log('잠금:', JSON.stringify(await page.evaluate(() => ({
    unlocked: window.BA.solo().unlocked,
    btn: document.querySelector('#startBtn .sb-text strong').textContent,
    note: document.getElementById('redeemNote').textContent
  }))));
  await page.evaluate(() => { document.getElementById('redeemCode').value = '2012'; document.getElementById('redeemApply').click(); });
  await sleep(700);
  await shot('home-unlocked');
  console.log('해금:', JSON.stringify(await page.evaluate(() => ({
    unlocked: window.BA.solo().unlocked, stored: localStorage.getItem('ba.soloUnlocked.v1'),
    btn: document.querySelector('#startBtn .sb-text strong').textContent
  }))));

  /* ===== 2. PVP 체력 ===== */
  await page.evaluate(() => window.BA.pvp.create('한윤'));
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(() => { const l = window.BA.pvp.lobby(); return !!(l && l.code); });
    if (ok) break;
    await sleep(400);
  }
  console.log('방 코드', await page.evaluate(() => window.BA.pvp.lobby().code));
  await page.evaluate(() => window.BA.pvp.send({ type: 'pteam', team: 'ally' }));
  await page.evaluate(() => window.BA.pvp.send({ type: 'pconf', mode: 'kills', killTarget: 30, bots: { ally: 0, enemy: 1 } }));
  await sleep(700);
  await page.evaluate(() => window.BA.pvp.start());
  let inBattle = false;
  for (let i = 0; i < 40 && !inBattle; i++) {
    inBattle = await page.evaluate(() => !!(window.BA.pvp.state() || {}).inBattle);
    if (!inBattle) await sleep(400);
  }
  await sleep(300);
  const hpShown = async () => page.evaluate(() => ({
    hud: (document.getElementById('hpText') || {}).textContent || '',
    barW: (document.getElementById('hpBar') || { style: {} }).style.width || '',
    meHp: window.BA.battle && window.BA.battle.player ? Math.round(window.BA.battle.player.hp) : null
  }));
  /* 부활하면 체력이 1000/1000 으로 가득 찬다 — 그 순간을 잡는다 (AI 가 다시 닿기 전) */
  let hpFull = await hpShown();
  for (let i = 0; i < 120; i++) {
    hpFull = await page.evaluate(() => {
      const p = window.BA.battle && window.BA.battle.player;
      return { hud: (document.getElementById('hpText') || {}).textContent || '', meHp: p ? Math.round(p.hp) : null, dead: !!(p && p.dead) };
    });
    if (hpFull.meHp === 1000 && !hpFull.dead) break;
    await sleep(160);
  }
  await page.evaluate(() => { try { window.BA.app._syncHUD(true); } catch (e) { /* noop */ } });
  await sleep(120);
  console.log('만피 상태', JSON.stringify(await hpShown()));
  await shot('pvp-hp-1000');

  /* AI 병력이 때리면 900 이 되는 즉시 찍는다 */
  let hpAfter = await hpShown();
  for (let i = 0; i < 90; i++) {
    await sleep(140);
    hpAfter = await hpShown();
    if (hpAfter.meHp !== null && hpAfter.meHp <= 900) break;
  }
  await page.evaluate(() => { try { window.BA.app._syncHUD(true); } catch (e) { /* noop */ } });
  await sleep(200);
  hpAfter = await hpShown();
  console.log('피격 후', JSON.stringify(hpAfter));
  await shot('pvp-hp-900');

  /* ===== 3. 옥타곤 발 위치 ===== */
  const feet = await page.evaluate(() => {
    const app = window.BA.app;
    const b = window.BA.battle;
    const u = (window.BA.pvp.state().others || [])[0];
    app.paused = true;
    app.debugCam = true;
    app.vm.enabled = false;
    if (b.player) b.player.hideModel = true;
    const tx = u ? u.x : 0, tz = u ? u.z : 0;
    const gy = window.BA.ground(tx, tz, true);
    app.cam.position.set(tx + 2.0, gy + 0.60, tz - 2.0);
    app.cam.lookAt(tx, gy + 0.32, tz);
    return { tx: +tx.toFixed(2), tz: +tz.toFixed(2), gy: +gy.toFixed(3), matTop: +(window.BA.oct().matTop || 0).toFixed(3), top: window.BA.oct().top };
  });
  console.log('발 위치', JSON.stringify(feet));
  await sleep(700);
  await shot('pvp-feet-on-mat');
  await page.evaluate((o) => {
    const app = window.BA.app;
    app.cam.position.set(o.tx + 2.8, o.gy + 1.25, o.tz - 3.0);
    app.cam.lookAt(o.tx, o.gy + 0.8, o.tz);
  }, feet);
  await sleep(600);
  await shot('pvp-feet-on-mat-wide');

  console.log('콘솔/페이지 오류: ' + (errors.length ? errors.slice(0, 4).join(' | ') : '없음'));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
