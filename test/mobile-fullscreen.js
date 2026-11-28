'use strict';

/* =============================================================================
   📱 아이폰 전체화면(의사 전체화면) + 🧽 바닥 무광 검증 — 390×844
   -----------------------------------------------------------------------------
   아이폰 사파리처럼 요소 전체화면 API 가 아예 없는 환경을 흉내 낸다
   (iPhone UA · document.fullscreenEnabled = false · requestFullscreen 삭제).
   그 상태에서:
   1) 홈 상단 ⛶ — 누르면 의사 전체화면(html·body·#app.is-pseudo-fullscreen)으로 들어가고
      버튼이 aria-pressed=true 로 바뀐다. 다시 누르면 해제된다.
   2) PVP 대기실 ⛶ — 대기실 머리에도 버튼이 있고, 실제로 눌린다(가려지지 않는다).
   3) PVP 옥타곤 전투 HUD ⛶ — 같은 상태를 공유한다. 캔버스가 보이는 화면을 꽉 채운다.
   4) 🧽 바닥 무광 — 옥타곤 매트·지면·발디딤 돌의 roughness ≥ 0.9 · metalness ≤ 0.03 ·
      envMapIntensity ≤ 0.1, 바닥에 clearcoat(젖은 광택) 재질이 없다.
      매트 테두리 발광은 시간이 지나도 밝기가 변하지 않는다(깜박임 없음).
   5) 화면 픽셀 — 매트를 내려다본 화면의 아래쪽(바닥) 영역에서 하얗게 타 버린 픽셀 비율이
      낮다(반사로 번들거리지 않는다).
   실행: node test/mobile-fullscreen.js            (ARENA_ROOT 로 다른 사본 검증 가능)
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.FS_SHOTS || '/workspace/screenshots-battle-arena-2026-11-28-iphone-fullscreen';
const PORT = Number(process.env.FS_PORT || 3599);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const T0 = Date.now();
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)) + '  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { createServer, rooms } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  const stop = () => { try { server.close(); } catch (e) { /* noop */ } };
  process.on('exit', stop);

  const browser = await puppeteer.launch({
    headless: 'new', protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
      '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage']
  });
  const errors = [];
  const page = await browser.newPage();
  /* 🍎 아이폰 사파리 흉내 — UA + 전체화면 API 제거. 스크립트는 페이지 로드 전에 심는다 */
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
    errors.push('console: ' + t); console.log('  [console error] ' + t.slice(0, 200));
  });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.BA && window.BA.pvp)).catch(() => false)) break;
    await sleep(1000);
  }
  await page.evaluate(() => window.BA.redeem('2012'));
  await sleep(500);

  const shot = async (tag) => { await page.screenshot({ path: path.join(SHOTS, tag + '.png') }); };
  const fsState = () => page.evaluate(() => ({
    isOn: window.BA.fullscreen.isOn(),
    supported: window.BA.fullscreen.supported(),
    pseudo: !!document.documentElement.classList.contains('is-pseudo-fullscreen'),
    bodyPseudo: !!document.body.classList.contains('is-pseudo-fullscreen'),
    appPseudo: !!document.getElementById('app').classList.contains('is-pseudo-fullscreen'),
    appFs: !!document.getElementById('app').classList.contains('is-fullscreen'),
    homePressed: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'),
    lobbyPressed: document.getElementById('fsLobbyBtn') ? document.getElementById('fsLobbyBtn').getAttribute('aria-pressed') : null,
    battlePressed: document.getElementById('fsBtn').getAttribute('aria-pressed'),
    label: document.getElementById('fsHomeBtn').getAttribute('aria-label'),
    pos: getComputedStyle(document.documentElement).position,
    appH: Math.round(document.getElementById('app').getBoundingClientRect().height),
    appW: Math.round(document.getElementById('app').getBoundingClientRect().width),
    win: { w: window.innerWidth, h: window.innerHeight },
    canvas: (function () { const c = document.getElementById('gl'); const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: Math.round(r.width), ch: Math.round(r.height) }; })()
  }));

  console.log('▶ 📱 아이폰(전체화면 API 없음) — 의사 전체화면 · 바닥 무광 (390×844)');

  /* ===== 1. 홈 ===== */
  const home = await page.evaluate(() => {
    const b = document.getElementById('fsHomeBtn');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { exists: !!b, pushed: hit && (hit.closest('#fsHomeBtn') !== null), api: !!(Element.prototype.requestFullscreen) };
  });
  ok('🍎 전체화면 API 가 없는 아이폰 환경을 재현했다 (requestFullscreen 없음)', home.api === false, home);
  ok('홈 상단 ⛶ 전체화면 버튼이 있고 눌린다', home.exists && home.pushed);

  await page.click('#fsHomeBtn');
  await sleep(700);
  const on1 = await fsState();
  ok('📱 홈에서 ⛶ 를 누르면 의사 전체화면으로 들어간다 (html·body·#app)',
    on1.isOn === true && on1.pseudo && on1.bodyPseudo && on1.appPseudo && on1.pos === 'fixed',
    { isOn: on1.isOn, pseudo: on1.pseudo, pos: on1.pos });
  ok('📱 버튼이 전체화면과 똑같이 바뀐다 (aria-pressed=true · 라벨 · 아이콘 색)',
    on1.homePressed === 'true' && on1.battlePressed === 'true' && /끄기/.test(on1.label),
    { home: on1.homePressed, battle: on1.battlePressed, label: on1.label });
  ok('📱 의사 전체화면에서도 HUD 는 전체화면 상태로 커진다 (#app.is-fullscreen)', on1.appFs === true);
  ok('📱 화면이 보이는 영역을 꽉 채운다 (390×844)', on1.appW === 390 && on1.appH >= 800 && on1.win.w === 390,
    { appW: on1.appW, appH: on1.appH, win: on1.win });
  await shot('01-home-pseudo-fullscreen');

  await page.click('#fsHomeBtn');
  await sleep(600);
  const off1 = await fsState();
  ok('📱 다시 누르면 전체화면이 해제된다', off1.isOn === false && !off1.pseudo && !off1.appPseudo && off1.pos === 'static',
    { isOn: off1.isOn, pos: off1.pos });
  ok('📱 버튼도 원래대로 돌아온다', off1.homePressed === 'false' && off1.battlePressed === 'false' && /^전체화면$/.test(off1.label), off1.label);
  await shot('02-home-normal');

  /* ===== 2. PVP 대기실 ===== */
  await page.evaluate(() => window.BA.pvp.create('한윤'));
  await page.waitForFunction(() => {
    const l = document.getElementById('pvpLobby');
    return l && l.classList.contains('is-on') && window.BA.pvp.lobby();
  }, { timeout: 20000, polling: 150 });
  const lobby = await page.evaluate(() => {
    const b = document.getElementById('fsLobbyBtn');
    if (!b) return { exists: false };
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      exists: true, w: Math.round(r.width), h: Math.round(r.height),
      disp: cs.display, vis: cs.visibility, op: cs.opacity,
      pushed: !!(hit && hit.closest('#fsLobbyBtn')),
      inView: r.top >= 0 && r.bottom <= window.innerHeight,
      pressed: b.getAttribute('aria-pressed')
    };
  });
  ok('⚔️ PVP 대기실 머리에 ⛶ 전체화면 버튼이 보이고 가려지지 않는다',
    lobby.exists && lobby.w >= 24 && lobby.h >= 24 && lobby.disp !== 'none' && lobby.vis !== 'hidden' &&
    Number(lobby.op) > 0.3 && lobby.pushed && lobby.inView, lobby);

  await page.click('#fsLobbyBtn');
  await sleep(700);
  const on2 = await fsState();
  ok('📱 PVP 대기실에서 ⛶ → 의사 전체화면 (버튼 상태도 함께 바뀐다)',
    on2.isOn === true && on2.pseudo && on2.lobbyPressed === 'true' && on2.homePressed === 'true' && on2.battlePressed === 'true',
    { on: on2.isOn, lobby: on2.lobbyPressed, home: on2.homePressed });
  await shot('03-lobby-pseudo-fullscreen');

  /* ===== 3. PVP 옥타곤 전투 ===== */
  const code = await page.evaluate(() => window.BA.pvp.lobby().code);
  await page.evaluate(() => window.BA.pvp.team('ally'));
  await page.evaluate(() => window.BA.pvp.conf({ mode: 'kills', killTarget: 30, bots: { ally: 0, enemy: 1 } }));
  await sleep(500);
  await page.evaluate(() => window.BA.pvp.start());
  await page.waitForFunction(() => { const s = window.BA.pvp.state(); return s && s.inBattle; }, { timeout: 90000, polling: 200 });
  /* AI 가 때리기 전에 눕혀 두고, 체력은 서버에서 그대로 둔다 (연출 확인용) */
  const room = rooms.get(code);
  if (room && room.pvp) for (const b of room.pvp.bots) { b.dead = true; b.hp = 0; b.respawnAt = Date.now() + 600000; }
  await sleep(1500);

  const battle = await page.evaluate(() => {
    const b = document.getElementById('fsBtn');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const st = window.BA.pvp.state();
    return {
      cls: document.getElementById('battle').className,
      pushed: !!(hit && hit.closest('#fsBtn')),
      inView: r.top >= 0 && r.right <= window.innerWidth,
      pressed: b.getAttribute('aria-pressed'),
      on: window.BA.fullscreen.isOn(),
      pseudo: document.documentElement.classList.contains('is-pseudo-fullscreen'),
      inBattle: st.inBattle, oct: window.BA.oct()
    };
  });
  ok('🥊 PVP 옥타곤 전투에 들어왔다 (대기실 전체화면이 유지된다)',
    /is-active/.test(battle.cls) && /is-pvp/.test(battle.cls) && battle.inBattle && battle.oct && battle.oct.apothem === 15,
    { cls: battle.cls, oct: battle.oct });
  ok('📱 전장 HUD 의 ⛶ 도 전체화면 상태를 그대로 보여 준다 (aria-pressed=true)',
    battle.pushed && battle.inView && battle.pressed === 'true' && battle.on === true && battle.pseudo === true,
    { pressed: battle.pressed, on: battle.on, pushed: battle.pushed });

  /* 전장에서 껐다 켜기 */
  await page.click('#fsBtn');
  await sleep(600);
  const off3 = await fsState();
  ok('📱 전장에서 ⛶ 를 다시 누르면 전체화면이 해제된다', off3.isOn === false && !off3.pseudo && off3.battlePressed === 'false', { on: off3.isOn });
  await page.click('#fsBtn');
  await sleep(700);
  const on3 = await fsState();
  ok('📱 전장에서 다시 켜면 의사 전체화면으로 돌아오고 3D 캔버스가 화면을 꽉 채운다',
    on3.isOn === true && on3.pseudo && on3.battlePressed === 'true' &&
    on3.canvas.cw === 390 && on3.canvas.ch === 844 && on3.canvas.w === 390 && on3.canvas.h === 844,
    { on: on3.isOn, canvas: on3.canvas });

  /* ===== 4. 🧽 바닥 무광 (재질) ===== */
  const mats = await page.evaluate(() => {
    const app = window.BA.app;
    const g = app.octagon.group;
    const list = [];
    const floorNames = [];
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      /* 바닥 = 매트(8각 원기둥) · 받침 — octagon.js 가 이름을 붙여 둔다 */
      if (o.name !== 'octagonMat' && o.name !== 'octagonBase') return;
      const m = o.material;
      list.push({
        name: o.name, geo: o.geometry && o.geometry.type, type: m.type,
        rough: m.roughness, metal: m.metalness, env: m.envMapIntensity,
        clearcoat: m.clearcoat === undefined ? null : m.clearcoat, color: m.color ? m.color.getHexString() : null
      });
      floorNames.push(o.name);
    });
    const t = app.world && app.world.terrain;
    const terr = t ? { rough: t.material.roughness, metal: t.material.metalness, env: t.material.envMapIntensity, type: t.material.type } : null;
    /* 바닥에 clearcoat(젖은 광택) 재질이 남아 있는가 — 바닥 판·매트·받침·링만 검사 */
    let clearcoatFloors = 0;
    const floorLike = [];
    app.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const geo = (o.geometry && o.geometry.type) || '';
      if (!/CircleGeometry|RingGeometry|PlaneGeometry/.test(geo)) return;
      if (o.name && o.name !== 'floorDamp') return;
      const m = o.material;
      const p = new o.position.constructor();
      o.getWorldPosition(p);
      if (p.y > 1.5) return;
      if (m.clearcoat !== undefined && m.clearcoat > 0.01) clearcoatFloors++;
      floorLike.push({ name: o.name || geo, type: m.type, rough: m.roughness, metal: m.metalness, env: m.envMapIntensity, clearcoat: m.clearcoat === undefined ? null : m.clearcoat });
    });
    const damp = app.scene.getObjectByName('floorDamp');
    const dampInfo = damp ? { type: damp.material.type, rough: damp.material.roughness, clearcoat: damp.material.clearcoat === undefined ? null : damp.material.clearcoat, opacity: damp.material.opacity } : null;
    /* 매트 테두리 발광이 깜박이지 않는지 — update() 를 여러 번 불러도 불투명도가 그대로 */
    const edges = [];
    g.traverse((o) => {
      if (o.name === 'octagonEdge') edges.push(o);
    });
    const edgeOp = edges.map((o) => o.material.opacity);
    for (let i = 0; i < 6; i++) app.octagon.update(0.05, 0.3 + i * 0.45);
    const edgeOpAfter = edges.map((o) => o.material.opacity);
    return { list, terr, clearcoatFloors, floorLike, dampInfo, edgeOp, edgeOpAfter };
  });
  const badMat = mats.list.filter((m) => !((m.rough || 0) >= 0.9 && (m.metal || 0) <= 0.03 && (m.env || 0) <= 0.1));
  ok('🧽 옥타곤 매트·받침이 차분한 무광이다 (roughness ≥ 0.9 · metalness ≤ 0.03 · envMap ≤ 0.1)',
    mats.list.length === 2 && badMat.length === 0,
    badMat.length ? badMat : mats.list.map((m) => m.name + ' r' + m.rough + ' m' + m.metal + ' e' + m.env));
  ok('🧽 솔로 전장 지면도 무광이다 (roughness ≥ 0.95 · metalness 0 · envMap ≤ 0.1)',
    !!mats.terr && mats.terr.rough >= 0.95 && mats.terr.metal === 0 && mats.terr.env <= 0.1, mats.terr);
  ok('🧽 바닥에 젖은 광택(clearcoat) 재질이 남아 있지 않다',
    mats.clearcoatFloors === 0 && !!mats.dampInfo && mats.dampInfo.type === 'MeshLambertMaterial' && mats.dampInfo.clearcoat === null,
    { clearcoatFloors: mats.clearcoatFloors, damp: mats.dampInfo });
  ok('🧽 매트 테두리 발광이 깜박이지 않는다 (시간이 지나도 불투명도 그대로)',
    mats.edgeOp.length >= 1 && mats.edgeOp.every((v, i) => Math.abs(v - mats.edgeOpAfter[i]) < 1e-6),
    { before: mats.edgeOp, after: mats.edgeOpAfter });

  /* ===== 5. 바닥 픽셀 — 번들거림(하얗게 타는 픽셀) ===== */
  const floor = await page.evaluate(() => {
    const app = window.BA.app;
    const b = app.battle;
    b.playerInvuln = 1e9;
    b.player.hp = b.player.maxHp;
    b.player.dead = false;
    app.paused = true;
    app.debugCam = true;
    app.debugLock = null;
    app.vm.enabled = false;
    for (const u of b.units) u.hideModel = true;
    const v = document.getElementById('hitVignette'); if (v) v.style.opacity = '0';
    const pairs = document.querySelectorAll('#pvpNames .pn-plate'); pairs.forEach && pairs.forEach((p) => { p.style.display = 'none'; });
    /* 매트를 내려다보는 각도 (서서 바닥을 보는 시선) */
    app.cam.position.set(0, 1.65, 6.2);
    app.cam.lookAt(0, 0, -1.5);
    return true;
  });
  await sleep(400);
  await page.click('#fsBtn');            // 전체화면 상태 그대로 한 프레임 더
  await sleep(200);
  await page.click('#fsBtn');
  await sleep(900);
  const pixel = await page.evaluate(() => {
    const app = window.BA.app;
    const gl = document.getElementById('gl');
    app.renderer.render(app.scene, app.cam);
    const c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(gl, 0, 0, c.width, c.height);
    /* 화면 아래 45% = 바닥 — HUD 를 피해 가운데 60% 폭만 */
    const x0 = Math.floor(c.width * 0.2), w = Math.floor(c.width * 0.6);
    const y0 = Math.floor(c.height * 0.55), h = Math.floor(c.height * 0.42);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0, sum = 0, hot = 0, hot200 = 0, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++; sum += l;
      if (l > max) max = l;
      if (l > 235) hot++;          // 하얗게 타 버린 픽셀
      if (l > 200) hot200++;
    }
    return { n, mean: +(sum / n).toFixed(1), max: Math.round(max), hotPct: +((hot / n) * 100).toFixed(2), hot200Pct: +((hot200 / n) * 100).toFixed(2) };
  });
  console.log('  · 바닥 픽셀 ' + JSON.stringify(pixel));
  ok('🧽 바닥이 하얗게 번들거리지 않는다 (번쩍이는 픽셀 0.5% 미만 · 최고 밝기 245 이하)',
    pixel.hotPct < 0.5 && pixel.max <= 245, pixel);
  await page.screenshot({ path: path.join(SHOTS, '04-floor-matte.png') });

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 5));

  console.log('\n📱 아이폰 전체화면 · 🧽 바닥 무광 검증 통과 · ' + passed + '개');
  await browser.close();
  stop();
  process.exit(0);
})().catch((e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
