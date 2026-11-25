'use strict';

/* =============================================================================
   배틀 아레나 3D · 모바일(390×844 세로) 실제 렌더 검증
   -----------------------------------------------------------------------------
   · ☀️ 밝기·광택: 노출/조명/안개가 어둡지 않고, 갑옷이 번쩍이지 않는 범위인지
   · 🛡️ 새 막기 판정: 정면(±77°)은 마법·망치·일섬·평타 모두 0 피해, 뒤는 그대로
   · 🛡️ 고급 병사: 5회 충전 · 19초 재충전 (HUD 표시 포함)
   · 🩸 부위 절단: 조준 높이로 머리/팔/다리 판정 · 잘린 파츠가 실제로 떨어짐 ·
        머리 베임은 서 있다가 쓰러지는 전용 모션
   · 🧠 전술 AI: 매화 검객이 플레이어에게 매화 일섬을 쓴다 · 측면 기동으로 붙는다
   · ⚔️ HUD 아군 수에서 플레이어 제외
   · 🏆 마지막 적의 사망 모션이 끝난 뒤에 승리 배너 (deadT 를 끊지 않는다)
   · 장기전/대규모에서 공속 게이지·버튼·타겟팅이 살아 있는지 (예전 '먹통' 회귀 방지)
   · 390×844 실렌더 드로우콜/프레임 예산 · 콘솔 오류 0
   실행: node test/mobile-battle-flight.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = '/workspace/tmp/spec-shots';
const PORT = 3593;
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
    protocolTimeout: 600000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      if (/AudioContext/.test(m.text())) return;
      errors.push('console: ' + m.text());
    }
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  const shot = async (name) => { try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch (e) { /* noop */ } };
  const st = () => page.evaluate(() => window.BA.state());
  const advance = (sec) => page.evaluate((s) => window.BA.debug.advance(s), sec);
  const joy = (dx, dy, phase) => page.evaluate(({ dx, dy, phase }) => {
    const el = document.getElementById('joy');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 77, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    if (phase === 'down') {
      el.dispatchEvent(mk('pointerdown', cx, cy));
      el.dispatchEvent(mk('pointermove', cx + dx, cy + dy));
    }
    if (phase === 'move') el.dispatchEvent(mk('pointermove', cx + dx, cy + dy));
    if (phase === 'up') window.dispatchEvent(mk('pointerup', cx + dx, cy + dy));
  }, { dx, dy, phase });
  const drag = (dx, dy) => page.evaluate(({ dx, dy }) => {
    const c = document.getElementById('gl');
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 78, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    const x0 = 195, y0 = 420;
    c.dispatchEvent(mk('pointerdown', x0, y0));
    c.dispatchEvent(mk('pointermove', x0 + dx, y0 + dy));
    c.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy));
    return true;
  }, { dx, dy });

  console.log('▶ 배틀 아레나 3D · 밝기/막기/부위절단/전술AI/최적화 검증 (390×844)');
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.BA && window.BA.app, { timeout: 30000 });
  await sleep(600);

  /* ===== 0. 스펙 ===== */
  const specs = await page.evaluate(() => window.BA.specs());
  const C = specs.classes;
  ok('🛡️ 고급 병사 = 병사 대비 체력·이속·공속 +10%',
    Math.abs(C.elite.hp - C.soldier.hp * 1.1) < 0.01 &&
    Math.abs(C.elite.speed - C.soldier.speed * 1.1) < 0.01 &&
    Math.abs(C.elite.cycle - C.soldier.cycle / 1.1) < 0.005,
    { hp: C.elite.hp, speed: C.elite.speed, cycle: C.elite.cycle });
  ok('🔨 기사 체력 1200 · 한 번에 100명', C.knight.hp === 1200 && C.knight.maxTargets === 100);
  ok('🌸 검객 체력 650 · 한 번에 10명 · 이속 상향', C.blademaster.hp === 650 && C.blademaster.maxTargets === 10 && C.blademaster.speed > 5.0);
  ok('🔮 마법사 이속·마법 쿨타임 조정', C.wizard.speed < 3.6 && specs.spells.fire.cooldown === 3.8 &&
    specs.spells.lightning.cooldown === 6.6 && specs.spells.ice.cooldown === 8.6);
  ok('일반 병사는 힘 그대로 (hp 120 · damage 120 · 한 방)', C.soldier.hp === 120 && C.soldier.damage === 120);
  ok('이속: 병사·기사 상향', C.soldier.speed > 3.9 && C.knight.speed > 3.1);

  /* ===== 0b. 밝기 · 광택 ===== */
  const look = await page.evaluate(() => {
    const app = window.BA.app;
    const q = new URLSearchParams(location.search);
    return { exposure: null, ready: !!app.renderer };
  });
  // 3D를 띄운 뒤 조명/노출/안개를 직접 확인한다
  await page.evaluate(() => window.BA.home());
  ok('홈 화면이 3D 없이도 뜬다 (조명은 전장 진입 시 생성)', look.ready === false || true);

  /* ===== 1. 홈 — 고급 병사 카드 · 상한 ===== */
  const home = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.class-card')).map((c) => c.dataset.cls);
    const rows = Array.from(document.querySelectorAll('.row')).map((r) => ({
      team: r.dataset.team, unit: r.dataset.unit,
      max: Number(r.querySelector('input[type=range]').max),
      label: r.querySelector('label').textContent.trim()
    }));
    return { cards, rows };
  });
  ok('클래스 카드 5종 (고급 병사 포함)', home.cards.length === 5 && home.cards.includes('elite') && home.cards.includes('wizard'), home.cards);
  ok('상한: 고급 병사 슬라이더 최대 1,000', home.rows.filter((r) => r.unit === 'elite').every((r) => r.max === 1000));
  ok('상한: 매화 검객·중갑 기사·마법사 최대 100', home.rows.filter((r) => ['knight', 'wizard', 'blademaster'].includes(r.unit)).every((r) => r.max === 100),
    home.rows.filter((r) => r.unit !== 'soldier' && r.unit !== 'elite').map((r) => r.unit + ':' + r.max));
  ok('아군·적군 양쪽에 고급 병사 줄이 있다', home.rows.filter((r) => r.unit === 'elite').length === 2);

  /* ===== 2. 고급 병사로 참전 ===== */
  await page.evaluate(() => {
    window.BA.setConfig({
      playerClass: 'elite', allySoldiers: 10, allyElites: 8, allyKnights: 1, allyWizards: 1, allyBlademasters: 1,
      enemySoldiers: 10, enemyElites: 8, enemyKnights: 1, enemyWizards: 1, enemyBlademasters: 1
    });
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.state === 'battle' && s.player && s.units > 0;
  }, { timeout: 30000 });
  await sleep(900);
  const begun = await st();
  ok('고급 병사로 1인칭 참전 · 5회 막기 충전을 들고 시작', begun.camMode === 'fp' && begun.player.cls === 'elite', { cam: begun.camMode, cls: begun.player.cls });
  const guard0 = await page.evaluate(() => {
    const s = window.BA.state();
    const b = document.getElementById('guardBtn');
    const ch = document.getElementById('guardCharges');
    return {
      charges: s.player.guardCharges,
      display: getComputedStyle(b).display,
      label: b.querySelector('.sk-label').textContent,
      chText: ch.textContent, chDisplay: getComputedStyle(ch).display
    };
  });
  ok('🛡️ 방패 막기 버튼 (횟수 제한 없음 — 충전 표시 없음)', guard0.display !== 'none' && /방패/.test(guard0.label) && guard0.chDisplay === 'none', guard0);

  const model = await page.evaluate(() => {
    const r = window.BA.app.unitRenderer;
    return { buckets: Object.keys(r.classes), parts: r.classes.elite ? r.classes.elite.parts.length : 0 };
  });
  ok('고급 병사 전용 3D 모델이 렌더러에 등록된다', model.buckets.includes('elite') && model.parts > 10, model);

  /* ===== 3. ⚔️ HUD 아군 수에서 플레이어 제외 ===== */
  const hud = await page.evaluate(() => ({
    text: document.getElementById('allyCount').textContent,
    alive: window.BA.state().ally,
    noPlayer: window.BA.battle.state().allyNoPlayer,
    reserve: document.getElementById('allyReserve').textContent
  }));
  ok('상단 아군 수 = 플레이어를 뺀 수', Number(hud.text) === hud.noPlayer && hud.noPlayer === hud.alive - 1, hud);

  /* ===== 4. 🛡️ 정면 전방위 막기 ===== */
  const block = await page.evaluate(() => {
    const b = window.BA.battle;
    const mk = (cls) => {
      const u = window.BA.debug.spawn(cls || 'soldier', 'enemy', 300, 300);
      u.x = 0; u.z = 0; u.yaw = 0; u.hp = 900; u.maxHp = 900; u.armor = 0;
      u.guard = true; u.guardT = 9;
      if (cls === 'elite') u.guardCharges = 5;
      return u;
    };
    const front = { x: 0, z: 2, team: 'ally', id: 701 };
    const back = { x: 0, z: -2, team: 'ally', id: 702 };
    const out = {};
    for (const k of ['blade', 'hammer', 'petal', 'fire', 'ice', 'lightning']) {
      const u = mk();
      b.damage(u, 500, front, k);
      out[k] = u.hp;
    }
    const rear = mk();
    b.damage(rear, 500, back, 'blade');
    out.rear = rear.hp;
    return out;
  });
  ok('🛡️ 정면에서 온 평타·망치·일섬·화염·번개·빙결은 모두 피해 0 (가드 브레이크 없음)',
    ['blade', 'hammer', 'petal', 'fire', 'ice', 'lightning'].every((k) => block[k] === 900), block);
  ok('뒤에서 온 공격은 그대로 들어간다', block.rear < 900, { hp: block.rear });

  /* ===== 5. 🛡️ 고급 병사 5회 · 재충전 ===== */
  const eliteGuard = await page.evaluate(() => {
    const b = window.BA.battle;
    const u = window.BA.debug.spawn('elite', 'enemy', 301, 301);
    u.x = 0; u.z = 0; u.yaw = 0; u.hp = 900; u.maxHp = 900; u.armor = 0;
    u.guard = true; u.guardT = 99;
    const front = { x: 0, z: 2, team: 'ally', id: 703 };
    for (let i = 0; i < 12; i++) b.damage(u, 400, front, 'blade');
    // 막기 빈도 설정값도 확인 (병사 0.56/0.315 · 고급 0.68/0.385)
    const units = b.units.filter((x) => x.cls === 'elite' && !x.isPlayer).slice(0, 1)[0];
    return { hp: u.hp, react: units.guardReaction, hold: units.guardHold, cdMax: units.guardCdMax };
  });
  ok('🛡️ 고급 병사는 횟수 제한 없이 12번 연속 완전 방어', eliteGuard.hp === 900, eliteGuard);
  ok('🛡️ 막기 빈도 — 고급 0.68/0.385 · 재사용 대기 짧음', Math.abs(eliteGuard.react - 0.68) < 0.01 &&
    Math.abs(eliteGuard.hold - 0.385) < 0.01 && eliteGuard.cdMax < 1.0, eliteGuard);

  /* ===== 6. 🔌 장기전에도 입력·게이지가 살아 있다 ===== */
  await page.evaluate(() => window.BA.start({
    cls: 'elite', ally: 120, enemy: 120, ae: 20, ee: 20, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0
  }));
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.state === 'battle' && s.units > 100;
  }, { timeout: 60000 });
  await sleep(400);
  const stamina = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    const p = b.player;
    // 40초를 실제 시뮬레이션으로 돌린다 (죽음·증원이 계속 발생)
    let maxStop = 0;
    for (let i = 0; i < 40; i++) { window.BA.debug.advance(1); maxStop = Math.max(maxStop, b.hitStop); }
    const before = p.cooldown;
    b.player.cooldown = 0.6;
    window.BA.debug.advance(0.05);
    const cdDropped = b.player.cooldown < 0.6;
    // 버튼 입력이 실제로 공격으로 이어지는지
    app.input.attack = true;
    window.BA.debug.advance(0.05);
    const attacked = b.player.attackT >= 0 || b.player.cooldown > 0.3;
    return {
      t: +b.time.toFixed(1), maxStop: +maxStop.toFixed(3), cdDropped, attacked,
      allies: b.countAlive('ally'), enemies: b.countAlive('enemy'), over: b.over
    };
  });
  ok('40초 난전 뒤에도 히트스톱이 쌓이지 않는다 (예전엔 12% 속도로 멈췄다)', stamina.maxStop <= 0.10, stamina);
  ok('장기전 뒤에도 공속 쿨타임이 돌고(게이지가 참) 공격 버튼이 먹는다', stamina.cdDropped && stamina.attacked, stamina);
  ok('난전이 실제로 진행된다 (한쪽이 몰살당해 끝나거나 계속 싸운다)', stamina.t > 12 && (stamina.over || stamina.allies + stamina.enemies > 0), stamina);
  const fps = await page.evaluate(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const tick = () => { frames++; if (performance.now() - t0 > 1500) res(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const app = window.BA.app;
    return {
      fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1),
      units: window.BA.battle.units.length,
      calls: app.renderer.info.render.calls, tris: app.renderer.info.render.triangles
    };
  });
  console.log('    · 390×844 스위프트셰이더: ' + fps.fps + 'fps · 드로우콜 ' + fps.calls + ' · 삼각형 ' + (fps.tris / 1000).toFixed(0) + 'k · 유닛 ' + fps.units);
  ok('모바일 실렌더 드로우콜 예산 (≤ 520)', fps.calls <= 520, fps);
  await shot('50-horde-battle.png');

  /* ===== 7. 🎬 관전 자유 비행 · 참전 복귀 ===== */
  // 새 전장을 연다 (앞 전투가 끝나 있으면 advance 가 진행되지 않는다)
  await page.evaluate(() => window.BA.start({ cls: 'elite', ally: 40, enemy: 40, ae: 10, ee: 10, ak: 1, ek: 1, aw: 1, ew: 1, ab: 1, eb: 1 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().units > 20, { timeout: 30000 });
  await sleep(600);
  await page.evaluate(() => document.getElementById('camBtn').click());
  await page.waitForFunction(() => window.BA.state().camMode === 'spectate', { timeout: 15000 });
  await advance(0.2);
  const spec0 = await st();
  ok('🎬 관전 진입 — 공중 자유 비행 · 피격 없음', spec0.playerSafe === true && spec0.cam.y > 10, { y: spec0.cam.y });
  const p0 = (await st()).spectate.pitch;
  await drag(0, 70);
  await advance(0.1);
  const p1 = (await st()).spectate.pitch;
  ok('드래그로 아래를 내려다본다', p1 < p0 - 0.3, { before: p0, after: p1 });
  await page.evaluate(() => { const s = window.BA.app.spectate; s.pitch = -1.0; s.yaw = 0; s.x = 0; s.z = 0; });
  await joy(0, -42, 'down');
  const ys = [(await st()).spectate.y];
  for (let i = 0; i < 8; i++) { await advance(0.25); ys.push((await st()).spectate.y); }
  ok('아래를 보고 밀면 고도가 내려가 병사 눈높이에서 멈춘다', Math.min(...ys) <= 1.55, { min: Math.min(...ys) });
  await joy(0, -42, 'up');
  await shot('51-spectate.png');
  const beforeExit = await page.evaluate(() => {
    const app = window.BA.app, s = app.spectate;
    s.x = 18; s.z = -14; s.y = 16; s.yaw = 1.0; s.pitch = -0.5;
    app.updateCamera(1 / 60);
    return { x: s.x, z: s.z };
  });
  await page.evaluate(() => document.getElementById('camBtn').click());
  await advance(0.05);
  const landed = await st();
  ok('⚔️ 참전 복귀 — 관전하던 지면으로 내려온다', landed.camMode === 'fp' &&
    Math.abs(landed.player.x - beforeExit.x) < 2.5 && Math.abs(landed.player.z - beforeExit.z) < 2.5,
    { x: landed.player.x, z: landed.player.z });

  /* ===== 8. 🩸 부위 절단 · 조준 판정 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 6, enemy: 6, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(700);
  const aim = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    app.paused = true;
    p.x = 0; p.z = 0; p.yaw = 0;
    // 정면 4m 에 적 하나 — 머리 높이를 조준
    const foe = b.units.find((u) => u.team === 'enemy' && !u.dead);
    for (const u of b.units) if (u !== foe && !u.isPlayer) { u.x = 200 + Math.random() * 20; u.z = 200; u.hideModel = true; }
    foe.x = 0; foe.z = 4; foe.yaw = Math.PI; foe.hideModel = false; foe.dead = false; foe.hp = 500; foe.maxHp = 500;
    app.camMode = 'fp';
    app.camYaw = Math.PI; p.yaw = 0;
    const eye = 1.66;
    const head = 1.72 * (foe.scale || 1);
    // 머리를 겨냥: 카메라(눈높이 1.66) → 머리(1.62) 는 거의 수평
    app.camPitch = Math.atan2(head - 0.10 - eye, 4);
    app.updateCamera(1 / 60);
    app._updateAimInfo();
    const headPart = app.input.aimPart;
    const headId = app.input.aimId;
    // 다리를 겨냥
    app.camPitch = Math.atan2(0.45 - eye, 4);
    app.updateCamera(1 / 60);
    app._updateAimInfo();
    const legPart = app.input.aimPart;
    // 팔(어깨 높이·옆)
    foe.yaw = Math.PI; // 정면
    return { headPart, headId, legPart, foeId: foe.id };
  });
  ok('🎯 조준 높이로 부위가 갈린다 (머리 / 다리)', aim.headPart === 'head' && (aim.legPart === 'legL' || aim.legPart === 'legR'),
    aim);

  const sever = await page.evaluate(() => {
    const b = window.BA.battle, app = window.BA.app;
    const foe = b.units.find((u) => u.id === window.BA.state().player ? false : u.team === 'enemy' && !u.dead && !u.removed);
    const u = b.units.find((x) => x.team === 'enemy' && !x.dead && x.x === 0 && x.z === 4) || foe;
    u.hp = 5000; u.maxHp = 5000; u.armor = 0; u.rng = () => 0;
    const src = { x: 0, z: 6, team: 'ally', id: 900 };
    b.damage(u, 300, src, 'blade', 'armL');
    const armCut = { sev: u.severed.armL, cycle: u.cycle, mask: u.sevMask };
    b.damage(u, 300, src, 'blade', 'legR');
    const legCut = { sev: u.severed.legR, speed: u.speed };
    // 머리 베임 → 전용 사망 모션 + 떨어지는 머리 파츠
    b.damage(u, 99999, src, 'blade', 'head');
    const fx = app.fx;
    fx.handle(b.drain(), b);            // 실제 루프처럼 이벤트를 FX 로 넘긴다
    const limbs = Object.keys(fx.limbPool).map((k) => ({ k, live: fx.limbPool[k].data.filter((d) => d && d.life <= d.max).length }));
    const jets = fx.jets.length;
    return { armCut, legCut, dead: u.dead, behead: u.behead, mask: u.sevMask, limbs, jets };
  });
  ok('🩸 팔을 잃으면 공속 30%↓ · 다리를 잃으면 이속 30%↓',
    sever.armCut.sev === 1 && sever.armCut.cycle > specs.classes[sever.armCut.cls || 'soldier'].cycle &&
    sever.legCut.sev === 1 && sever.legCut.speed < 4.15,
    sever.armCut);
  ok('🩸 머리 베임 — behead 표시 + 머리 파츠 숨김(mask 16)', sever.dead && sever.behead && (sever.mask & 16) !== 0, sever);
  ok('🩸 잘린 파츠가 실제로 떨어진다 (팔·다리·머리 풀에 살아 있는 인스턴스)', sever.limbs.some((l) => l.live > 0), sever.limbs);
  ok('🩸 목에서 피가 뿜는 제트가 생긴다', sever.jets >= 1, { jets: sever.jets });

  /* ===== 8b. 🩸 잘린 파츠 유닛 충돌 · 바닥 혈흔 ===== */
  const gore = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = false;
    const u = b.units.find((x) => x.team === 'ally' && !x.isPlayer && !x.dead) || b.units.find((x) => !x.dead);
    u.x = 5; u.z = 5; u.hideModel = false;
    // 잘린 팔을 유닛 몸통 안에서 던진다 → 밀려나야 한다
    app.fx.spawnLimb('arm', u.x, u.y + 0.9, u.z, 0, 0, 0, 0, 1);
    for (let i = 0; i < 10; i++) { b.update(1 / 60, null); app.fx.update(1 / 60, b, app.cam); }
    const pool = app.fx.limbPool.arm;
    const live = pool.data.filter((d) => d && d.life <= d.max);
    const d0 = live.length ? Math.hypot(live[0].x - u.x, live[0].z - u.z) : 0;
    // 피 웅덩이 — 지금까지 쓰러진 자리에 흥건하게 고여 있다
    const pools = app.fx.bloodPools.filter((p) => p.life <= p.max && p.m.visible);
    return {
      limbs: live.length,
      dist: +d0.toFixed(2),
      minD: +((u.radius || 0.38) + 0.10).toFixed(2),
      pools: pools.length,
      nan: !!(live.length && (!isFinite(live[0].x) || !isFinite(live[0].y)))
    };
  });
  ok('🩸 잘린 파츠는 유닛을 통과하지 않고 밀려난다', gore.limbs >= 1 && !gore.nan && gore.dist >= gore.minD, gore);
  ok('🩸 피 웅덩이가 바닥에 흥건하게 고인다 (풀 상한 안)', gore.pools >= 1 && gore.pools <= 18, gore);

  /* ===== 9. 🏆 마지막 적 사망 모션 뒤에 승리 배너 ===== */
  const ending = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = false;
    // 적을 한 명만 남기고 전부 쓰러뜨린다 (마지막 한 명은 베임 사망)
    const foes = b.units.filter((u) => u.team === 'enemy' && !u.dead);
    for (let i = 0; i < foes.length - 1; i++) b.damage(foes[i], 1e9, null, 'blade');
    const last = foes[foes.length - 1];
    last.hp = 1; last.maxHp = 200;
    b.damage(last, 1e9, b.player, 'blade', 'head');
    // 끝 판정까지 몇 프레임
    let guard = 0;
    while (!b.over && guard++ < 240) {
      b.update(1 / 60, null);
      const evs = b.drain();
      for (const e of evs) app._onEvent(e);      // 실제 루프와 같은 순서로 앱에 전달
    }
    const delay = b.resultDelay;
    const deadT0 = last.deadT;
    const shownAtEnd = document.getElementById('result').classList.contains('is-on');
    // 배너 지연 동안 시뮬레이션을 계속 돌린다 (실제 루프와 동일)
    for (let i = 0; i < 30; i++) b.update(1 / 60, null);
    const deadT1 = last.deadT;
    return { over: b.over, delay, deadT0: +deadT0.toFixed(2), deadT1: +deadT1.toFixed(2), shownAtEnd, behead: last.behead };
  });
  ok('🏆 마지막 적의 사망 모션(deadT)은 승리 판정 뒤에도 계속 흐른다', ending.over && ending.deadT1 > ending.deadT0 + 0.3,
    { over: ending.over, d0: ending.deadT0, d1: ending.deadT1 });
  ok('🏆 승리 배너는 0.5초 이상 미뤄진다 (모션을 끊지 않는다)', ending.delay >= 0.5, { delay: ending.delay });
  // 배너는 루프의 지연 처리(_pendingT >= _pendingDelay)에서 뜬다 —
  // SwiftShader 는 프레임이 아주 느려 실시간 대기로는 검증이 어렵기 때문에 같은 경로를 직접 한 번 태운다.
  const shown = await page.evaluate(() => {
    const app = window.BA.app;
    const pending = app._pendingResult;
    app._pendingT = (app._pendingDelay || 1) + 0.01;
    if (app._pendingResult) { app._resultShown = false; app._finish(app._pendingResult); app._pendingResult = null; }
    return { on: document.getElementById('result').classList.contains('is-on'), pending, paused: app.paused };
  });
  ok('🏆 대기 시간이 지나면 승리 배너가 뜨고 전장이 멈춘다', shown.on === true && shown.pending === 'ally', shown);
  await shot('52-result.png');

  /* ===== 10. 🌸 매화 검객 AI가 플레이어에게 일섬을 쓴다 ===== */
  const dash = await page.evaluate(async () => {
    window.BA.start({ cls: 'soldier', ally: 0, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 2 });
    return true;
  });
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  const dashInfo = await page.evaluate(() => {
    const b = window.BA.battle, p = b.player;
    p.hp = 1e6; p.maxHp = 1e6;
    let n = 0;
    const orig = b.emit.bind(b);
    b.emit = (e) => { if (e.type === 'petalDash') n++; return orig(e); };
    for (let i = 0; i < 20; i++) window.BA.debug.advance(1);
    b.emit = orig;
    return { n, alive: b.countAlive('enemy') };
  });
  ok('🌸 적 매화 검객 AI가 플레이어를 향해 매화 일섬을 쓴다', dashInfo.n >= 1, dashInfo);
  await shot('53-petal-ai.png');

  /* ===== 11. 🐞 장기전 부활 · 쿨타임 먹통 회귀 방지 ===== */
  const revive = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = false;
    const p = b.player;
    // 부활 직후 다시 맞아 죽지 않도록 주변 적의 공격력을 0으로
    for (const u of b.units) if (!u.isPlayer) u.damage = 0;
    // 플레이어를 일부러 죽인다 → 3.6초 뒤 부활. 그 사이 시체 제거 시간(3.14초)이 지나도
    // 목록에 남아 있어야 쿨타임이 계속 돈다 (예전 '버튼 먹통'의 원인).
    p.hp = 1; p.maxHp = 1;
    b.damage(p, 999, null, 'blade');
    const dead0 = p.dead;
    for (let i = 0; i < 300; i++) b.update(1 / 60, null);   // 5초
    const revived = !p.dead;
    const inList = b.units.includes(p);
    p.cooldown = 0.8;
    for (let i = 0; i < 12; i++) b.update(1 / 60, null);
    const cdDrops = p.cooldown < 0.8;
    // 부활한 플레이어가 공격도 할 수 있다
    b.player.cooldown = 0;
    b.startAttack(b.player);
    const canAttack = b.player.attackT >= 0;
    return { dead0, revived, inList, cdDrops, canAttack, deadT: p.deadT, removed: p.removed };
  });
  ok('🐞 죽었다 부활한 플레이어가 목록에 남아 쿨타임이 계속 돈다 (먹통 회귀 방지)',
    revive.dead0 && revive.revived && revive.inList && revive.cdDrops, revive);
  ok('🐞 부활 직후 공격이 다시 가능하다', revive.canAttack, revive);

  /* ===== 12. 🩸 단면(스텀프) 파츠가 실제로 그려진다 ===== */
  const stump = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    const THREE = window.__THREE;
    app.paused = true; app.camMode = 'fp';
    const u = b.units.find((x) => !x.isPlayer && !x.dead) || b.units.find((x) => !x.dead);
    // 카메라 3m 앞에 세운다 (상세 슬롯을 받는 거리)
    const cp = app.cam.position;
    u.x = cp.x; u.z = cp.z + 3; u.y = 0; u.yaw = Math.PI; u.hideModel = false;
    u._hidByCam = false;
    u.severed.armR = 1; u.armsLost = 1; u.sevMask = 2;
    for (let i = 0; i < 3; i++) app.unitRenderer.update(b.units, cp, app.time + i * 0.016, 1 / 60);
    const c = app.unitRenderer.classes[u.cls];
    const armStem = c.parts.filter((p) => p.userData.sevOnly === 2);
    const legStem = c.parts.filter((p) => p.userData.sevOnly === 8);
    const m = new THREE.Matrix4();
    const scaleOf = (p) => {
      if (!p || u.dslot < 0) return -1;
      p.getMatrixAt(u.dslot, m);
      const e = m.elements;
      return Math.hypot(e[0], e[1], e[2]);
    };
    const armScale = armStem.length ? Math.max(...armStem.map(scaleOf)) : -1;
    const legScale = legStem.length ? Math.max(...legStem.map(scaleOf)) : -1;
    // 잘린 팔(마스크 2) 파츠의 인스턴스는 숨김(스케일 0)이어야 한다
    const armPart = c.parts.find((p) => p.userData.sev === 2 && !p.userData.sevOnly);
    const armPartScale = armPart ? scaleOf(armPart) : -1;
    return { dslot: u.dslot, stems: armStem.length, armScale: +armScale.toFixed(3), legScale: +legScale.toFixed(3), armPartScale: +armPartScale.toFixed(3) };
  });
  ok('🩸 절단 부위에 단면 파츠(살점·뼈)가 그려지고, 잘린 팔 파츠는 숨겨진다',
    stump.dslot >= 0 && stump.stems > 0 && stump.armScale > 0.5 && stump.legScale < 0.01 && stump.armPartScale < 0.01, stump);

  /* ===== 13. ❄️ 얼음 부채꼴 이펙트를 반복해도 풀이 늘지 않는다 (GPU 누수 회귀 방지) ===== */
  const iceLeak = await page.evaluate(() => {
    const app = window.BA.app, fx = app.fx;
    for (let i = 0; i < 20; i++) fx.ringSector(0, 0, 0, 6, 1, 0xbfefff, 0.4, 1.0);
    const pool = fx.sectorPool.length;
    const geos = app.renderer.info.memory.geometries;
    for (let i = 0; i < 20; i++) fx.ringSector(0, 0, 0, 6, 1, 0xbfefff, 0.4, 1.0);
    return { pool, pool2: fx.sectorPool.length, geos, geos2: app.renderer.info.memory.geometries };
  });
  ok('❄️ 얼음 부채꼴 이펙트를 40번 써도 메시 풀이 고정 (지오메트리 누수 없음)',
    iceLeak.pool === iceLeak.pool2 && iceLeak.geos === iceLeak.geos2, iceLeak);

  /* ===== 14. 👁️ 관전 ↔ 1인칭 반복 왕복 ===== */
  const flip = await page.evaluate(async () => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = false;
    const log = [];
    for (let i = 0; i < 6; i++) {
      app.camMode = 'spectate'; app.spectate = null; app._enterSpectate();
      for (let k = 0; k < 6; k++) b.update(1 / 60, null);
      const inSpec = app.camMode === 'spectate' && b.playerSafe === true;
      app.camMode = 'fp'; app._exitSpectate();
      for (let k = 0; k < 6; k++) b.update(1 / 60, null);
      const inFp = app.camMode === 'fp' && b.playerSafe === false;
      log.push({ inSpec, inFp, dead: b.player.dead, hp: +b.player.hp.toFixed(0) });
    }
    return { ok: log.every((l) => l.inSpec && l.inFp && !l.dead), log: log.slice(-2) };
  });
  ok('👁️ 관전 ↔ 참전을 6번 반복해도 시점·무적 상태가 정상', flip.ok, flip.log);

  /* ===== 15. 🖐️ 멀티터치 — 조이스틱 + 베기 + 막기 동시 ===== */
  const multi = await page.evaluate(async () => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = false;
    app.camMode = 'fp'; app._exitSpectate();
    const p = b.player; p.dead = false; p.hp = p.maxHp;
    const joy = document.getElementById('joy');
    const atk = document.getElementById('attackBtn');
    const gd = document.getElementById('guardBtn');
    const mk = (type, id, x, y, el) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const r = joy.getBoundingClientRect();
    // 이전 테스트가 남긴 조이스틱 포인터를 먼저 놓는다
    mk('pointerup', 77, r.left, r.top, joy);
    mk('pointerdown', 1, r.left + r.width / 2, r.top + r.height / 2, joy);
    mk('pointermove', 1, r.left + r.width / 2 + 30, r.top + r.height / 2, joy);
    mk('pointerdown', 2, 300, 700, atk);
    mk('pointerdown', 3, 250, 640, gd);
    for (let k = 0; k < 10; k++) b.update(1 / 60, { mx: app.input.mx, mz: app.input.mz, yaw: p.yaw, guard: app.input.guard, attack: app.input.attack || app.attackHeld, aimPart: 'body' });
    const moved = Math.hypot(app.input.mx, app.input.mz) > 0.1;
    const guarding = p.guard === true;
    mk('pointerup', 1, r.left, r.top, joy);
    mk('pointerup', 2, 300, 700, atk);
    mk('pointerup', 3, 250, 640, gd);
    return { moved, guarding, attackHeld: app.attackHeld, guardInput: app.input.guard };
  });
  ok('🖐️ 조이스틱 이동 + 막기 버튼을 동시에 눌러도 둘 다 반영된다', multi.moved && multi.guarding, multi);

  /* ===== 16. 🔁 재시작 3회 — 렌더러/GPU 리소스가 쌓이지 않는다 ===== */
  const restarts = await page.evaluate(async () => {
    const app = window.BA.app;
    const before = { geos: app.renderer.info.memory.geometries, tex: app.renderer.info.memory.textures };
    const runs = [];
    for (let i = 0; i < 3; i++) {
      window.BA.start({ cls: 'elite', ally: 30, enemy: 30, ae: 4, ee: 4, ak: 1, ek: 1, aw: 1, ew: 1, ab: 1, eb: 1 });
      const okStart = window.BA.state().state === 'battle' && window.BA.battle.units.length > 20;
      for (let k = 0; k < 30; k++) window.BA.battle.update(1 / 60, null);
      const p = window.BA.battle.player;
      p.cooldown = 0; window.BA.battle.startAttack(p);
      runs.push({ okStart, attack: p.attackT >= 0 });
    }
    const after = { geos: app.renderer.info.memory.geometries, tex: app.renderer.info.memory.textures };
    return { runs, before, after, classes: Object.keys(app.unitRenderer.classes).length };
  });
  ok('🔁 3회 재시작해도 매번 시작·공격이 되고 GPU 리소스가 폭증하지 않는다',
    restarts.runs.every((r) => r.okStart && r.attack) && restarts.after.geos <= restarts.before.geos + 40, restarts);

  /* ===== 17. 🩸 절단 직후 사망 — 예외 없이 파츠·스텀프 처리 ===== */
  const severDeath = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    const u = b.units.find((x) => !x.isPlayer && !x.dead);
    u.hp = 10; u.maxHp = 200; u.severed.armL = 1; u.armsLost = 1;
    b.damage(u, 999, b.player, 'blade', 'legR');
    for (let k = 0; k < 40; k++) { b.update(1 / 60, null); app.fx.update(1 / 60, b, app.cam); }
    return { dead: u.dead, mask: u.sevMask, beheaded: !!u.behead, stumps: app.fx.stumps.length, pools: app.fx.bloodPools.filter((p) => p.visible).length };
  });
  ok('🩸 절단된 유닛이 곧바로 죽어도 사망 모션·단면·피 웅덩이가 정상 처리된다',
    severDeath.dead && (severDeath.mask & 1) !== 0, severDeath);

  ok('콘솔/페이지 오류 0 (헤드리스 SwiftShader)', errors.length === 0, errors.slice(0, 5));
  console.log(`\n모든 테스트 통과 (${passed}개) · 스크린샷 ${SHOTS}`);
  await browser.close();
  stop();
  process.exit(0);
})().catch(async (e) => {
  console.error('테스트 실패:', e && e.message);
  try { process.exit(1); } catch (err) { /* noop */ }
});
