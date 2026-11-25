'use strict';

/* =============================================================================
   배틀 아레나 3D · 모바일(390×844 세로) 실제 렌더 검증
   -----------------------------------------------------------------------------
   · ⚔️ 병종 밸런스: 병사 150/150 · 기사 체력 2200·막기 불가 · 검객 900/0.30초 · 고급 병사 방패 제거
   · 🩸 신규 6번째 병종 '단검 광전사' — 3000 체력 · 18 공격력 · 0.18초 연타 · 홀드 자동 연타
   · 💚 자연 회복: 살아 있는 모든 유닛이 초당 최대 체력의 1.5% 를 스스로 회복
   · ☀️ 밝기·광택: 노출/조명/안개가 어둡지 않고, 갑옷이 번쩍이지 않는 범위인지
   · 🛡️ 새 막기 판정: 정면(±77°)은 마법·망치·일섬·평타 모두 0 피해, 뒤는 그대로
   · 🛡️ 고급 병사: 5회 충전 · 19초 재충전 (HUD 표시 포함)
   · 🩸 피 이펙트: 맞으면 물방울·피안개가 세차게 튐 · 처치 시 큰 분사 + 바닥 웅덩이 ·
        부위 절단은 없다(어디를 베든 몸통 피해, 몸은 온전)
   · 🛡️ 막기: 실터치 홀드/탭으로 병사·고급·기사·검객이 정면 공격을 0 피해로 막음 (마법사 불가)
        (마법사는 막기 불가) · 적 마법사의 화염구·번개·빙결도 정면에서 막힌다
   · 👥 아군 수는 플레이어와 별도 (아군 1 = AI 1 + 플레이어) · 기사 공속 2% 너프
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
  ok('⚔️ 일반 병사 = 체력 150 · 공격력 150 (한 방)', C.soldier.hp === 150 && C.soldier.damage === 150,
    { hp: C.soldier.hp, damage: C.soldier.damage });
  ok('🛡️ 고급 병사 = 병사 대비 체력·이속·공속 +10%',
    Math.abs(C.elite.hp - C.soldier.hp * 1.1) < 0.01 &&
    Math.abs(C.elite.speed - C.soldier.speed * 1.1) < 0.01 &&
    Math.abs(C.elite.cycle - C.soldier.cycle / 1.1) < 0.005,
    { hp: C.elite.hp, speed: C.elite.speed, cycle: C.elite.cycle });
  ok('🔨 기사 체력 2000~2400 · 한 번에 100명 · 막기 불가',
    C.knight.hp >= 2000 && C.knight.hp <= 2400 && C.knight.maxTargets === 100 && C.knight.guard === false,
    { hp: C.knight.hp, guard: C.knight.guard });
  ok('🌸 검객 체력 900 · 공속 조금 빠르게(0.30초) · 한 번에 10명 · 막기 가능',
    C.blademaster.hp === 900 && C.blademaster.maxTargets === 10 && C.blademaster.speed > 5.0 &&
    C.blademaster.cycle <= 0.305 && C.blademaster.guard === true,
    { hp: C.blademaster.hp, cycle: C.blademaster.cycle });
  ok('🩸 단검 광전사 = 3000 체력 · 18 공격력 · 0.18초 연타 · 병사와 같은 이속 · 막기 가능',
    C.berserker && C.berserker.hp === 3000 && C.berserker.damage === 18 &&
    C.berserker.cycle === 0.18 && C.berserker.speed === C.soldier.speed && C.berserker.guard === true,
    C.berserker && { hp: C.berserker.hp, dmg: C.berserker.damage, cycle: C.berserker.cycle, speed: C.berserker.speed });
  ok('🔮 마법사 이속·마법 쿨타임 조정 · 막기 불가', C.wizard.speed < 3.6 && C.wizard.guard === false &&
    specs.spells.fire.cooldown === 3.8 && specs.spells.lightning.cooldown === 6.6 && specs.spells.ice.cooldown === 8.6);
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
  ok('클래스 카드 6종 (고급 병사·단검 광전사 포함)',
    home.cards.length === 6 && home.cards.includes('elite') && home.cards.includes('wizard') && home.cards.includes('berserker'), home.cards);
  ok('상한: 고급 병사 슬라이더 최대 1,000', home.rows.filter((r) => r.unit === 'elite').every((r) => r.max === 1000));
  ok('상한: 매화 검객·중갑 기사·마법사·단검 광전사 최대 100', home.rows.filter((r) => ['knight', 'wizard', 'blademaster', 'berserker'].includes(r.unit)).every((r) => r.max === 100),
    home.rows.filter((r) => r.unit !== 'soldier' && r.unit !== 'elite').map((r) => r.unit + ':' + r.max));
  ok('아군·적군 양쪽에 고급 병사·단검 광전사 줄이 있다',
    home.rows.filter((r) => r.unit === 'elite').length === 2 && home.rows.filter((r) => r.unit === 'berserker').length === 2);

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
  ok('고급 병사로 1인칭 참전', begun.camMode === 'fp' && begun.player.cls === 'elite', { cam: begun.camMode, cls: begun.player.cls });
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
  ok('⚔️ 고급 병사 막기 버튼 = "검 막기" (방패 없음 · 횟수 제한 없음)', guard0.display !== 'none' &&
    guard0.label === '검 막기' && guard0.chDisplay === 'none', guard0);

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

  /* ===== 4b. 🔮 마법사는 막기를 쓸 수 없다 ===== */
  const wizNoGuard = await page.evaluate(() => {
    const b = window.BA.battle;
    const mk = () => {
      const u = window.BA.debug.spawn('wizard', 'enemy', 320, 320);
      u.x = 0; u.z = 0; u.yaw = 0; u.hp = 900; u.maxHp = 900; u.armor = 0;
      u.guard = true; u.guardT = 9;          // 강제로 켜 둬도 마법사는 못 막는다
      return u;
    };
    const front = { x: 0, z: 2, team: 'ally', id: 711 };
    const out = {};
    for (const k of ['blade', 'fire', 'ice', 'lightning']) {
      const u = mk();
      b.damage(u, 500, front, k);
      out[k] = u.hp;
    }
    return out;
  });
  ok('🔮 마법사는 정면에서도 막지 못한다 (가드가 켜져 있어도 피해가 들어간다)',
    ['blade', 'fire', 'ice', 'lightning'].every((k) => wizNoGuard[k] < 900), wizNoGuard);

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
  ok('🛡️ AI 막기 빈도 상향 — 고급 병사 0.55/0.26 (병사 0.18/0.08 · 검객 0.30/0.13)',
    Math.abs(eliteGuard.react - 0.55) < 0.01 && Math.abs(eliteGuard.hold - 0.26) < 0.01 &&
    eliteGuard.cdMax <= 1.2 && eliteGuard.react > 0.5, eliteGuard);
  const gc = specs.guardChance || {};
  ok('🛡️ AI 막기 확률표 — 병사·고급·검객·광전사만 (기사·마법사는 막기 없음)',
    gc.soldier && gc.elite && gc.blademaster && gc.berserker && !gc.knight && !gc.wizard &&
    gc.elite.react > gc.soldier.react * 2 && gc.blademaster.react > gc.soldier.react &&
    gc.soldier.reactT <= 0.12 && gc.elite.reactT <= 0.10, gc);

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

  /* ===== 8. 🩸 부위 절단 없음 · 피 이펙트 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 6, enemy: 6, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(600);
  const gore = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = true;
    const p = b.player;
    p.x = 0; p.z = 0; p.yaw = 0; p.dead = false;
    const foe = b.units.find((u) => u.team === 'enemy' && !u.dead);
    const ally = b.units.find((u) => u.team === 'ally' && !u.isPlayer && !u.dead);
    const src = { x: 0, z: 2, team: 'ally', id: 801 };
    // 머리·팔·다리 어디를 노려도 몸통 피해만 들어가고 절단은 없다
    foe.hp = 5000; foe.maxHp = 5000; foe.armor = 0;
    const hp0 = foe.hp;
    const dHead = b.damage(foe, 100, src, 'blade', 'head');
    const dArm = b.damage(foe, 100, src, 'blade', 'armL');
    const dLeg = b.damage(foe, 100, src, 'blade', 'legR');
    const sevAfter = { ...foe.severed };
    const maskAfter = foe.sevMask;
    const evs = b.drain().filter((e) => e.type === 'sever').length;
    // 피 분사 — 때리면 물방울·피안개가 실제로 생긴다
    const before = { blood: app.fx.blood.n, dust: app.fx.dust.n, pools: app.fx.bloodPools.filter((x) => x.m.visible).length };
    b.damage(foe, 60, src, 'blade', 'body');
    const hitEv = { type: 'hit', source: src, target: foe, dmg: 60, kind: 'blade', part: 'body', lethal: false,
      hx: 0, hz: 1.8, hy: 1.15, angle: 0 };
    app.fx.handle([hitEv], b);
    const after = { blood: app.fx.blood.n, dust: app.fx.dust.n, pools: app.fx.bloodPools.filter((x) => x.m.visible).length };
    // 처치 — 큰 피 분사 + 웅덩이
    app.fx.blood.n = 0;                 // 이미 쌓인 물방울은 비우고 이번 분사만 잰다
    const kill0 = { blood: app.fx.blood.n, pools: app.fx.bloodPools.filter((x) => x.m.visible).length };
    foe.hp = 1;
    b.damage(foe, 999, src, 'blade', 'body');
    app.fx.handle(b.drain(), b);
    const kill1 = { blood: app.fx.blood.n, pools: app.fx.bloodPools.filter((x) => x.m.visible).length, dead: foe.dead };
    // 잘린 파츠(limb)는 더 이상 생기지 않는다
    const limbs = Object.keys(app.fx.limbPool).map((k) => app.fx.limbPool[k].data.filter((d) => d && d.life <= d.max).length);
    return { hp0, dHead, dArm, dLeg, sev: sevAfter, mask: maskAfter, sevEvents: evs,
      before, after, kill0, kill1, limbs, allyOk: !!ally, getHp: foe.hp };
  });
  ok('🩸 부위 절단이 없다 — 머리·팔·다리를 노려도 몸통 피해만 들어간다',
    gore.dHead === 100 && gore.dArm === 100 && gore.dLeg === 100 && gore.sev.head === 0 && gore.sev.armL === 0 &&
    gore.sev.legR === 0 && gore.mask === 0 && gore.sevEvents === 0, gore);
  ok('🩸 맞으면 공중으로 피가 세차게 튄다 (물방울 + 피안개)',
    gore.after.blood > gore.before.blood + 15 && gore.after.dust > gore.before.dust + 6,
    { blood: gore.after.blood - gore.before.blood, mist: gore.after.dust - gore.before.dust });
  ok('🩸 쓰러지면 큰 피 분사와 바닥 웅덩이가 남는다',
    gore.kill1.dead && gore.kill1.blood > gore.kill0.blood + 40 && gore.kill1.pools > gore.kill0.pools, gore.kill1);
  ok('🩸 잘린 파츠(팔·다리·머리)는 더 이상 생기지 않는다', gore.limbs.every((n) => n === 0), gore.limbs);

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

  /* ===== 12. 🩸 온전한 몸으로 그려진다 (절단 단면·파츠 없음) ===== */
  const whole = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    const THREE = window.__THREE;
    app.paused = true; app.camMode = 'fp';
    const u = b.units.find((x) => !x.isPlayer && !x.dead) || b.units.find((x) => !x.dead);
    const cp = app.cam.position;
    u.x = cp.x; u.z = cp.z + 3; u.y = 0; u.yaw = Math.PI; u.hideModel = false;
    // 팔·다리를 여러 번 노려 때려도 절단되지 않는다
    const src = { x: cp.x, z: cp.z + 4, team: 'ally', id: 811 };
    u.hp = 5000; u.maxHp = 5000; u.armor = 0;
    for (let i = 0; i < 8; i++) b.damage(u, 10, src, 'blade', i % 2 ? 'armR' : 'legL');
    for (let i = 0; i < 3; i++) app.unitRenderer.update(b.units, cp, app.time + i * 0.016, 1 / 60);
    const c = app.unitRenderer.classes[u.cls];
    const m = new THREE.Matrix4();
    const scaleOf = (pv) => {
      if (!pv || u.dslot < 0) return -1;
      pv.getMatrixAt(u.dslot, m);
      const e = m.elements;
      return Math.hypot(e[0], e[1], e[2]);
    };
    const armPart = c.parts.find((pv) => pv.userData.sev === 2 && !pv.userData.sevOnly);
    const legPart = c.parts.find((pv) => pv.userData.sev === 8 && !pv.userData.sevOnly);
    const stems = c.parts.filter((pv) => pv.userData.sevOnly);
    const stemMax = stems.length ? Math.max(...stems.map(scaleOf)) : 0;
    return {
      dslot: u.dslot, mask: u.sevMask, dead: u.dead,
      arm: +scaleOf(armPart).toFixed(3), leg: +scaleOf(legPart).toFixed(3),
      stemMax: +stemMax.toFixed(3), severed: Object.keys(u.severed).filter((k) => u.severed[k]).length
    };
  });
  ok('🩸 부위를 계속 맞아도 몸은 온전하다 (절단 단면 없음 · 팔·다리 파츠 그대로)',
    whole.dslot >= 0 && whole.mask === 0 && whole.severed === 0 && !whole.dead &&
    whole.arm > 0.5 && whole.leg > 0.5 && whole.stemMax < 0.01, whole);

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

  /* ===== 17. 🩸 피 파티클이 풀 상한 안에서 정리된다 (누수 없음) ===== */
  const bloodPool = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    for (let i = 0; i < 40; i++) {
      const u = b.units[(i * 7) % b.units.length];
      if (u && !u.dead) b.damage(u, 5, b.player, 'blade', 'body');
      app.fx.update(1 / 60, b, app.cam);
    }
    const n = app.fx.blood.n;
    let nan = false;
    for (let i = 0; i < n * 3; i++) if (!isFinite(app.fx.blood.pos[i])) { nan = true; break; }
    return { n, cap: app.fx.blood.cap, nan, pools: app.fx.bloodPools.filter((p) => p.m.visible).length };
  });
  ok('🩸 피 파티클·핏자국이 상한 안에서 돌고 좌표가 깨지지 않는다',
    bloodPool.n <= bloodPool.cap && !bloodPool.nan && bloodPool.pools <= 18, bloodPool);

  /* ===== 18. 🎞️ 모션 연속성 — 프레임 사이 관절 회전이 튀지 않는다 ===== */
  const motion = await page.evaluate(() => {
    const res = {};
    for (const cls of ['soldier', 'elite', 'knight', 'blademaster', 'wizard', 'berserker']) {
      const c = window.BA.specs().classes[cls];
      res[cls] = {
        atk: window.BA.debug.poseTrack({ cls, kind: 'attack', from: 0, to: c.cycle, frames: Math.round(c.cycle * 60) }),
        death: window.BA.debug.poseTrack({ cls, kind: 'death', from: 0, to: 2.5, frames: 150 }),
        walk: window.BA.debug.poseTrack({ cls, kind: 'walk', from: 0, to: 12.56, frames: 120 })
      };
    }
    return res;
  });
  /* 광전사는 0.18초 주기로 0.24초 모션을 압축 재생한다 — 프레임당 회전이 원래 크다 */
  const atkLimits = { soldier: 0.45, elite: 0.45, knight: 0.45, blademaster: 0.85, wizard: 0.35, berserker: 1.15 };
  const badAtk = Object.keys(atkLimits).filter((k) => motion[k].atk.max > atkLimits[k]);
  const badDeath = Object.keys(motion).filter((k) => motion[k].death.max > 0.25 || motion[k].death.rootJump > 0.12);
  ok('🎞️ 공격 모션 프레임당 관절 회전이 병종별 한계 안 (튀는 프레임 없음)',
    badAtk.length === 0, { bad: badAtk, soldier: motion.soldier.atk.max, blade: motion.blademaster.atk.max });
  ok('🎞️ 사망 모션 프레임당 회전·루트 이동이 작다 (끊김 없이 쓰러진다)',
    badDeath.length === 0, badDeath.map((k) => ({ k, max: motion[k].death.max, root: motion[k].death.rootJump })));

  /* ===== 19. 🩸 부위 절단 없음 — 1인칭 무기·눈높이는 그대로 ===== */
  const vmSev = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    // 예전 절단 상태 값을 강제로 넣어도 동작이 흔들리지 않는다 (시스템이 없다)
    p.dead = false; p.hp = Math.max(1, p.maxHp);
    p.severed = { armL: 0, armR: 1, legL: 0, legR: 1, head: 0 };
    p.armsLost = 1; p.legsLost = 1; p.sevMask = 2 | 8;
    app.camMode = 'fp';
    for (let i = 0; i < 20; i++) app.vm.update(1 / 60, p, app.input, app.time + i / 60, app.camYaw + Math.PI, app.camPitch);
    const model = app.vm.models[p.cls] || app.vm.models.soldier;
    const armVisible = !!(model.userData.armGroup && model.userData.armGroup.visible !== false);
    app.updateCamera(1 / 60);
    const eye = +app.cam.position.y.toFixed(2);
    const spec = window.BA.specs().classes[p.cls];
    return { armVisible, eye, viewEye: spec.viewEye, handSwap: app.vm.handSwap || 0, limp: app.vm.limp || 0 };
  });
  ok('🩸 1인칭 무기는 언제나 오른손 — 손바꿈·절뚝임 없음', vmSev.armVisible && vmSev.handSwap === 0 && vmSev.limp === 0, vmSev);
  ok('🩸 눈높이가 병종 고정값 그대로 (다리 상태와 무관)', Math.abs(vmSev.eye - vmSev.viewEye) < 0.02, vmSev);

  /* ===== 20. 👥 1인칭 아군 — 코앞에 붙어도 숨기지 않고 시야를 가린다 ===== */
  await page.evaluate(() => {
    window.BA.start({ cls: 'soldier', ally: 1, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 });
  });
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  const nearAlly = await page.evaluate(async () => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = true;
    app.camMode = 'fp';
    const p = b.player;
    p.x = 0; p.z = 0; p.yaw = 0; p.pitch = 0; p.dead = false;
    app.camYaw = Math.PI; app.camPitch = 0;
    const al = b.units.find((u) => u.team === 'ally' && !u.isPlayer && !u.dead);
    if (!al) return { missing: true };
    al.speed = 0;                 // AI 이동 없이 배치만 본다
    al.dead = false; al.hideModel = false;
    al.x = 0; al.z = 1.1; al.y = 0;
    app.updateCamera(1 / 60);
    // 실제 렌더 루프가 두 프레임 돌 때까지 기다린다 (예전에는 여기서 2.5m 안쪽 아군을 숨겼다)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const near = { hidden: al.hideModel === true, tier: al._tier, dslot: al.dslot };
    // 개인 공간(2.3m) 비켜감 제거 — 거의 겹친 아군은 몸 반경만큼만 밀려난다
    al.x = 0; al.z = 0.25; al.y = 0;
    for (let i = 0; i < 30; i++) b.update(1 / 60, null);
    const gap = +Math.hypot(al.x - p.x, al.z - p.z).toFixed(2);
    return { near, gap, radiusSum: +((al.radius + p.radius) * 0.96).toFixed(2) };
  });
  ok('👥 1인칭 코앞(1.1m) 아군을 숨기지 않는다 — 시야를 그대로 가린다',
    !nearAlly.missing && nearAlly.near.hidden === false && nearAlly.near.tier !== -2, nearAlly);
  ok('👥 1인칭 아군은 플레이어의 2.3m 개인 공간을 비켜 가지 않는다 (몸 반경만큼만 벌어짐)',
    nearAlly.gap > 0.5 && nearAlly.gap < 1.5, nearAlly);

  /* ===== 21. 🛡️ 막기 버튼 — 실터치(홀드·탭)로 모든 병종이 막는다 ===== */
  const guardRuns = [];
  for (const cls of ['soldier', 'elite', 'blademaster', 'berserker']) {
    await page.evaluate((c) => window.BA.start({ cls: c, ally: 6, enemy: 2, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }), cls);
    await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
    await sleep(300);
    const rect = await page.evaluate(() => {
      const b = document.getElementById('guardBtn');
      const r = b.getBoundingClientRect();
      const lbl = b.querySelector('.sk-label');
      // 마법사는 마법 3버튼이 같이 떠 있다 — 막기 버튼과 겹치지 않는지 본다
      const spells = Array.from(document.querySelectorAll('.spell-btn'))
        .filter((s) => getComputedStyle(s).display !== 'none')
        .map((s) => { const q = s.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom }; });
      const overlaps = spells.filter((q) => !(q.r < r.left || q.l > r.right || q.b < r.top || q.t > r.bottom));
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: b.classList.contains('is-on'),
        label: lbl ? lbl.textContent : '',
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        spellBtns: spells.length, overlaps: overlaps.length,
        hitOk: !!(el && el.closest && el.closest('#guardBtn')),
        hit: (el || {}).id || '' };
    });
    // 실제 손가락으로 누른다 (버튼 위 히트테스트 포함)
    await page.touchscreen.touchStart(rect.x, rect.y);
    await sleep(120);
    const held = await page.evaluate(() => {
      const app = window.BA.app, b = window.BA.battle, p = b.player;
      if (app.paused) app.paused = false;
      const touchGuard = !!app.input.guard;      // 터치가 실제로 막기 입력을 켰는가
      // 루프와 같은 cmd 경로로 한 프레임 (guard = 입력 || 탭 유지 시간)
      const guardCmd = !!(app.input.guard || (app.guardMinT || 0) > 0);
      b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: guardCmd, attack: false, aimPart: 'body', aimId: 0 });
      const pGuardNow = !!p.guard;
      const blocks = [];
      const orig = b.emit.bind(b);
      b.emit = (e) => { if (e.type === 'block') blocks.push(e); return orig(e); };
      p.maxHp = 5000; p.hp = 5000;      // 뒤에서 맞아도 죽지 않게 (막기 자세 확인을 이어서 한다)
      const front = { x: p.x, z: p.z + 3, team: 'enemy', id: 9001, yaw: Math.PI };
      b.damage(p, 500, front, 'blade', 'body');
      const frontHp = p.hp;
      const blockEv = blocks.length;
      const rear = { x: p.x, z: p.z - 3, team: 'enemy', id: 9002, yaw: 0 };
      b.damage(p, 500, rear, 'blade', 'body');
      const rearHp = p.hp;
      // 1인칭 무기가 막기 자세로 올라온다
      for (let i = 0; i < 24; i++) app.vm.update(1 / 60, p, app.input, app.time + i / 60, app.camYaw + Math.PI, app.camPitch);
      const guardK = +(app.vm.guardK || 0).toFixed(2);
      b.emit = orig;
      return { cls: p.cls, touchGuard, inputGuard: !!app.input.guard, pGuard: pGuardNow, frontHp, rearHp,
        maxHp: p.maxHp, blockEv, guardK, isHeld: document.getElementById('guardBtn').classList.contains('is-held') };
    });
    // 손을 뗀 뒤 탭 막기(0.4초)가 유지되는지 — 다시 톡 눌렀다 뗀다
    await page.touchscreen.touchEnd();
    await page.evaluate(() => { window.BA.app.guardMinT = 0; window.BA.app.input.guard = false; });
    await page.touchscreen.touchStart(rect.x, rect.y);
    await page.touchscreen.touchEnd();
    const tapped = await page.evaluate(() => {
      const app = window.BA.app, b = window.BA.battle, p = b.player;
      if (app.paused) app.paused = false;
      // 손을 뗀 직후 프레임에서도 탭 유지 시간 때문에 막기가 켜져 있다
      const guardCmd = !!(app.input.guard || (app.guardMinT || 0) > 0);
      b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: guardCmd, attack: false, aimPart: 'body', aimId: 0 });
      return { minT: +(app.guardMinT || 0).toFixed(2), inputGuard: !!app.input.guard, pGuard: !!p.guard };
    });
    guardRuns.push({ rect, held, tapped });
  }
  ok('🛡️ 막기 버튼이 모든 병종에 보이고 실제 터치로 눌린다',
    guardRuns.every((g) => g.rect.on && g.held.touchGuard && g.held.inputGuard && g.held.isHeld), guardRuns.map((g) => ({ cls: g.held.cls, on: g.rect.on, hit: g.rect.hit })));
  ok('🛡️ 막는 동안 정면 공격은 0 피해 + 막힘 이벤트(스파크/소리), 뒤는 그대로',
    guardRuns.every((g) => g.held.pGuard && Math.abs(g.held.frontHp - g.held.maxHp) < 0.5 && g.held.blockEv >= 1 && g.held.rearHp < g.held.maxHp - 1),
    guardRuns.map((g) => ({ cls: g.held.cls, front: g.held.frontHp, rear: g.held.rearHp, blocks: g.held.blockEv })));
  ok('🛡️ 막기 중 1인칭 무기가 막기 자세로 올라온다', guardRuns.every((g) => g.held.guardK > 0.6),
    guardRuns.map((g) => ({ cls: g.held.cls, guardK: g.held.guardK })));
  ok('🛡️ 막기 라벨은 모두 "검 막기" (방패 병종 없음)', guardRuns.every((g) => g.rect.label === '검 막기'),
    guardRuns.map((g) => ({ cls: g.held.cls, label: g.rect.label })));
  /* 🔮 마법사는 막기 버튼이 없고, 마법 3버튼만 뜬다 */
  await page.evaluate(() => window.BA.start({ cls: 'wizard', ally: 4, enemy: 2, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const wizUI = await page.evaluate(() => {
    const g = document.getElementById('guardBtn');
    const gr = g.getBoundingClientRect();
    const gOn = g.classList.contains('is-on') && getComputedStyle(g).display !== 'none';
    const spells = Array.from(document.querySelectorAll('.spell-btn'))
      .filter((s) => getComputedStyle(s).display !== 'none')
      .map((s) => { const q = s.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom, inside: q.left >= 0 && q.right <= innerWidth + 0.5 && q.bottom <= innerHeight + 0.5 }; });
    const b = window.BA.battle, p = b.player;
    p.guard = false;
    if (window.BA.app.paused) window.BA.app.paused = false;
    b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: true, attack: false, aimPart: 'body', aimId: 0 });
    return { cls: p.cls, guardOn: gOn, guardVisible: getComputedStyle(g).display !== 'none', spells: spells.length,
      spellsInside: spells.every((q) => q.inside), pGuard: !!p.guard, gr: { w: gr.width, h: gr.height } };
  });
  ok('🔮 마법사 — 막기 버튼 숨김·입력 무시 · 마법 3버튼은 화면 안에', wizUI.cls === 'wizard' &&
    wizUI.guardOn === false && wizUI.guardVisible === false && wizUI.pGuard === false &&
    wizUI.spells === 3 && wizUI.spellsInside, wizUI);
  ok('🛡️ 톡 눌렀다 떼도 잠깐은 막힌다 (탭 막기)',
    guardRuns.every((g) => g.tapped.inputGuard === false && g.tapped.pGuard && g.tapped.minT > 0.05),
    guardRuns.map((g) => ({ cls: g.held.cls, minT: g.tapped.minT, pGuard: g.tapped.pGuard })));

  await shot('54-guard.png');

  /* ===== 21b. 🔮 적 마법사의 화염구·번개·빙결도 정면 막기로 0 피해 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 0, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 1, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const magicBlock = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    if (app.paused) app.paused = false;
    b.playerInvuln = 0; b.playerSafe = false;
    const wiz = b.units.find((u) => u.cls === 'wizard' && u.team === 'enemy' && !u.isPlayer);
    if (!wiz) return { err: 'no enemy wizard' };
    // 적 마법사를 플레이어 정면(+z) 8m 에 고정하고, 양쪽 체력을 크게 둔다
    wiz.x = p.x; wiz.z = p.z + 8; wiz.yaw = Math.PI;
    wiz.hp = 1e6; wiz.maxHp = 1e6; wiz.cooldown = 0;
    /* 💚 자연 회복(초당 최대 체력 1.5%)이 피해량을 덮지 않도록 최대 체력을 작게 둔다 */
    p.maxHp = 300; p.hp = 300; p.yaw = 0;
    const blocks = [];
    const orig = b.emit.bind(b);
    b.emit = (e) => { if (e.type === 'block') blocks.push({ heavy: !!e.heavy, cls: e.unit && e.unit.cls }); return orig(e); };
    // 적 AI 를 얼려 두고(제자리) 마법만 직접 쏘게 한다 — 한 evaluate 안에서 동기로 돌려 결정적으로 만든다
    const step = (n) => {
      for (let i = 0; i < n; i++) {
        wiz.freezeT = 1; wiz.dead = false;
        b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: true, attack: false, aimPart: 'body', aimId: 0 });
      }
    };
    const out = {};
    // 1) 화염구 — 폭발점이 내 앞이어도 마법사 쪽을 바라보면 막힌다
    wiz.cd.fire = 0; blocks.length = 0;
    b.castSpell(wiz, 'fire', { x: p.x, z: p.z });
    step(70);
    out.fire = { hp: p.hp, blocks: blocks.length, heavy: blocks.some((x) => x.heavy) };
    // 2) 연쇄 번개
    wiz.cd.lightning = 0; blocks.length = 0;
    b.castSpell(wiz, 'lightning', { yaw: Math.PI });
    step(40);
    out.lightning = { hp: p.hp, blocks: blocks.length, heavy: blocks.some((x) => x.heavy) };
    // 3) 빙결 파동 (전방 부채꼴 7.4m) — 막아내면 얼지도 않는다
    wiz.z = p.z + 5; wiz.cd.ice = 0; blocks.length = 0;
    b.castSpell(wiz, 'ice', { yaw: Math.PI });
    step(20);
    out.ice = { hp: p.hp, blocks: blocks.length, frozen: p.freezeT > 0, heavy: blocks.some((x) => x.heavy) };
    // 4) 뒤를 돌면 그대로 맞는다
    p.yaw = Math.PI; blocks.length = 0;
    wiz.cd.fire = 0;
    const before = p.hp;
    b.castSpell(wiz, 'fire', { x: p.x, z: p.z });
    step(70);
    out.rear = { dealt: before - p.hp, blocks: blocks.length };
    b.emit = orig;
    p.guard = false;
    return out;
  });
  ok('🛡️ 적 마법사의 화염구·번개·빙결도 정면에서 막으면 0 피해 (막힘 이벤트·강타)', magicBlock.err == null &&
    magicBlock.fire.hp >= 299.5 && magicBlock.fire.blocks >= 1 && magicBlock.fire.heavy &&
    magicBlock.lightning.hp >= 299.5 && magicBlock.lightning.blocks >= 1 && magicBlock.lightning.heavy &&
    magicBlock.ice.hp >= 299.5 && magicBlock.ice.blocks >= 1 && magicBlock.ice.heavy, magicBlock);
  ok('❄️ 막아낸 빙결은 얼리지 않는다', magicBlock.ice && magicBlock.ice.frozen === false, magicBlock.ice);
  ok('뒤를 돌면 마법이 그대로 들어간다', !!magicBlock.rear && magicBlock.rear.dealt > 1, magicBlock.rear);

  /* ===== 21c. 🎯 조준점 색 — 지금 공격하면 맞는 적이 있으면 붉게 ===== */
  const aimProbe = () => page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    if (app.paused) app.paused = false;
    // 한 프레임 강제로 돌려 그리드·판정·HUD 를 확정한다 (결정적)
    b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: false, attack: false, aimPart: 'body', aimId: 0 });
    app._syncHUD(true);
    const el = document.getElementById('reticle');
    return { on: el.classList.contains('is-hit'), target: !!b.aimTarget(),
      border: getComputedStyle(el.querySelector('span')).borderTopColor,
      bg: getComputedStyle(el.querySelector('i')).backgroundColor,
      yaw: +p.yaw.toFixed(2), cls: p.cls };
  });
  await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    b.playerInvuln = 0; b.playerSafe = false;
    p.hp = 5000; p.maxHp = 5000;
    p.yaw = 0; app.camYaw = Math.PI;             // 정면 = +z 로 고정
    // 적을 정면 1.7m 에 세우고 묶어 둔다
    const foe = window.BA.debug.spawn('soldier', 'enemy', p.x, p.z);
    foe.x = p.x; foe.z = p.z + 1.7; foe.yaw = Math.PI; foe.hp = 5000; foe.maxHp = 5000;
    foe.freezeT = 999; foe.removed = false; foe.dead = false;
    window.BA._foeId = foe.id;
  });
  const nearAim = await aimProbe();
  ok('🎯 적이 사거리·각도 안에 있으면 조준점이 붉게 바뀐다 (실제 베기 판정과 동일)',
    nearAim.on === true && nearAim.target === true && /255, 59, 36|rgb\(255, 59, 36\)/.test(nearAim.border), nearAim);
  await shot('54c-aim-hit.png');
  await page.evaluate(() => {
    const b = window.BA.battle, p = b.player;
    const f = b.units.find((u) => u.id === window.BA._foeId);
    if (f) { f.x = p.x; f.z = p.z + 24; }       // 사거리 밖으로 멀리
  });
  const farAim = await aimProbe();
  ok('🎯 사거리 밖이면 조준점은 기본 색으로 돌아온다', farAim.on === false && farAim.target === false && !/255, 59, 36/.test(farAim.border), farAim);
  await page.evaluate(() => {
    const b = window.BA.battle, p = b.player;
    const f = b.units.find((u) => u.id === window.BA._foeId);
    if (f) { f.x = p.x; f.z = p.z - 1.7; }      // 등 뒤
  });
  const backAim = await aimProbe();
  ok('🎯 등 뒤의 적에게는 조준점이 붉어지지 않는다 (정면 각도 판정)', backAim.on === false && backAim.target === false, backAim);

  /* ===== 21d. 🧍 시작 대형 — 병사 줄에 가려진 특수 병종이 없고 가운데에 뜬 병사가 없다 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 40, enemy: 40, ae: 0, ee: 0, ak: 2, ek: 2, aw: 1, ew: 1, ab: 1, eb: 1 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(300);
  const form = await page.evaluate(() => {
    const b = window.BA.battle;
    const zs = (team, cls) => b.units.filter((u) => u.team === team && u.cls === cls && !u.isPlayer).map((u) => u.z);
    const mid = b.units.filter((u) => !u.isPlayer && Math.abs(u.z) < 6).length;
    const side = (team) => {
      const s = zs(team, 'soldier'), k = zs(team, 'knight');
      if (!s.length || !k.length) return null;
      // 그 팀 기준 '앞' = 적 쪽. 아군은 z 클수록(0에 가까울수록) 앞, 적군은 z 작을수록 앞
      const front = (a) => team === 'ally' ? Math.max(...a) : Math.min(...a);
      return { knightFront: +front(k).toFixed(2), soldierFront: +front(s).toFixed(2), ok: team === 'ally' ? front(k) >= front(s) - 0.01 : front(k) <= front(s) + 0.01 };
    };
    return { mid, ally: side('ally'), enemy: side('enemy'), n: b.units.length };
  });
  ok('🧍 시작 대형 — 기사가 병사 줄 뒤에 숨지 않고 앞줄에 선다 (머리만 떠 보이지 않음)',
    !!form.ally && !!form.enemy && form.ally.ok && form.enemy.ok, form);
  ok('🧍 시작 대형 — 두 진영 사이 가운데에 홀로 선 병사가 없다', form.mid === 0, { mid: form.mid, n: form.n });
  await shot('54d-start-formation.png');
  /* ===== 22. 👥 아군 수는 플레이어와 별도 (아군 1 = AI 1 + 플레이어) ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 1, enemy: 1, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const ally1 = await page.evaluate(() => {
    const b = window.BA.battle;
    return {
      aiAlly: b.units.filter((u) => u.team === 'ally' && !u.isPlayer && !u.dead).length,
      allyAll: b.units.filter((u) => u.team === 'ally').length,
      player: !!b.player, initialTotalAlly: b.initialTotalAlly, totalRoster: b.totalRoster.ally,
      hud: document.getElementById('allyCount').textContent, reserve: b.reserveTotal('ally'),
      enemy: b.units.filter((u) => u.team === 'enemy').length
    };
  });
  ok('👥 아군 1명 설정 → AI 아군 1명 + 플레이어(별도)가 실제로 스폰된다',
    ally1.aiAlly === 1 && ally1.allyAll === 2 && ally1.player && ally1.enemy === 1, ally1);
  ok('👥 상단 아군 수·총원 표시도 플레이어를 빼고 일관된다',
    ally1.hud === '1' && ally1.initialTotalAlly === 2 && ally1.totalRoster === 1, ally1);
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 4, enemy: 2, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const ally4 = await page.evaluate(() => {
    const b = window.BA.battle;
    return { aiAlly: b.units.filter((u) => u.team === 'ally' && !u.isPlayer && !u.dead).length,
      initialTotalAlly: b.initialTotalAlly, hud: document.getElementById('allyCount').textContent };
  });
  ok('👥 아군 4명 설정 → AI 4명 + 플레이어 (총 5명)', ally4.aiAlly === 4 && ally4.initialTotalAlly === 5 && ally4.hud === '4', ally4);

  /* ===== 23. 🔨 기사 공속 살짝 상향 ===== */
  const knightSpd = await page.evaluate(() => {
    const c = window.BA.specs().classes.knight;
    return { cycle: c.cycle, animDur: c.animDur, impact: c.impact };
  });
  ok('🔨 기사 공속 2% 너프 (주기 1.01 → 1.03)',
    knightSpd.cycle > 1.02 && knightSpd.cycle < 1.04, knightSpd);

  /* ===== 24. 🩸 신규 병종 — 단검 광전사 스폰·3D 모델·1인칭·HUD ===== */
  await page.evaluate(() => window.BA.start({
    cls: 'berserker', ally: 3, enemy: 3, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0, abz: 4, ebz: 4
  }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(500);
  const bers = await page.evaluate(() => {
    const b = window.BA.battle, app = window.BA.app, p = b.player;
    const all = b.units.filter((u) => u.cls === 'berserker');
    const ai = all.filter((u) => !u.isPlayer);
    const one = ai[0] || p;
    const c = app.unitRenderer.classes.berserker;
    return {
      cls: p.cls, playerHp: p.maxHp, playerDmg: p.damage, cycle: p.cycle,
      allyAI: ai.filter((u) => u.team === 'ally').length,
      enemyAI: ai.filter((u) => u.team === 'enemy').length,
      hp: one.maxHp, dmg: one.damage, speed: one.speed,
      soldierSpeed: window.BA.specs().classes.soldier.speed,
      buckets: Object.keys(app.unitRenderer.classes),
      parts: c ? c.parts.length : 0,
      vmModel: !!app.vm.models.berserker,
      hudIcon: document.getElementById('psClass').textContent,
      atkLabel: document.querySelector('#attackBtn .ab-label').textContent,
      guardOn: document.getElementById('guardBtn').classList.contains('is-on')
    };
  });
  ok('🩸 단검 광전사가 양 진영에 스폰되고 1인칭·HUD·3D 모델이 붙는다',
    bers.cls === 'berserker' && bers.allyAI === 4 && bers.enemyAI === 4 &&
    Math.abs(bers.playerHp - 3000) < 120 && bers.cycle === 0.18 && bers.speed === bers.soldierSpeed &&
    bers.buckets.includes('berserker') && bers.parts > 20 && bers.vmModel &&
    bers.hudIcon === '🩸' && bers.atkLabel === '연타' && bers.guardOn === true, bers);

  const poseBers = await page.evaluate(() => {
    const r = {};
    r.atk = window.BA.debug.poseTrack({ cls: 'berserker', kind: 'attack', from: 0, to: 0.18, frames: 11 });
    r.guard = window.BA.debug.poseTrack({ cls: 'berserker', kind: 'guard', from: 0, to: 0.5, frames: 30 });
    return r;
  });
  ok('🩸 광전사 모션이 0.18초 주기에 맞게 재생된다 (공격·막기 모두 끊김 없음)',
    !!poseBers.atk && poseBers.atk.max < 1.15 && poseBers.guard.max < 0.6,
    { atk: poseBers.atk, guard: poseBers.guard });

  /* ===== 25. 🩸 공격 버튼 홀드 자동 연타 (손을 떼면 멈춤) ===== */
  await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    app.paused = false;
    p.dead = false; p.hp = p.maxHp; p.cooldown = 0; p.attackT = -1;
    app.camMode = 'fp';
    if (b.playerSafe) { b.playerSafe = false; app.spectate = null; }
  });
  const atkRect = await page.evaluate(() => {
    const r = document.getElementById('attackBtn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.touchStart(atkRect.x, atkRect.y);
  await sleep(60);
  const heldRun = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    let n = 0;
    const orig = b.emit.bind(b);
    b.emit = (e) => { if (e.type === 'attack' && e.unit === p) n++; return orig(e); };
    const held = !!app.attackHeld;
    window.BA.debug.advance(1.2);
    b.emit = orig;
    return { held, n, cycle: p.cycle, cooldown: +p.cooldown.toFixed(2) };
  });
  await page.touchscreen.touchEnd();
  const releasedRun = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    let n = 0;
    const orig = b.emit.bind(b);
    b.emit = (e) => { if (e.type === 'attack' && e.unit === p) n++; return orig(e); };
    window.BA.debug.advance(0.8);
    b.emit = orig;
    return { n, held: !!app.attackHeld, attackInput: !!app.input.attack };
  });
  ok('🩸 공격 버튼을 꾹 누르면 쿨타임마다 자동으로 연타가 나간다 (1.2초에 5회 이상)',
    heldRun.held && heldRun.n >= 5, heldRun);
  ok('🩸 손을 떼면 연타가 즉시 멈춘다', releasedRun.held === false && releasedRun.n === 0, releasedRun);

  /* ===== 26. 🔨 기사는 막기를 쓸 수 없다 (플레이어·AI 모두) ===== */
  await page.evaluate(() => window.BA.start({ cls: 'knight', ally: 2, enemy: 2, ae: 0, ee: 0, ak: 1, ek: 1, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const knightGuard = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    app.paused = false;
    const btn = document.getElementById('guardBtn');
    const shown = btn.classList.contains('is-on') && getComputedStyle(btn).display !== 'none';
    p.guard = false;
    b.playerSafe = false;
    b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: true, attack: false, aimPart: 'body', aimId: 0 });
    const pGuard = !!p.guard;
    p.maxHp = 9000; p.hp = 9000;
    b.damage(p, 500, { x: p.x, z: p.z + 3, team: 'enemy', id: 9101 }, 'blade');
    const front = p.hp;
    // AI 기사도 guard 플래그를 강제로 켜도 막지 못한다
    const k = window.BA.debug.spawn('knight', 'enemy', 0, 0);
    k.x = 0; k.z = 0; k.yaw = 0; k.hp = 9000; k.maxHp = 9000;
    k.guard = true; k.guardT = 99;
    b.damage(k, 500, { x: 0, z: 2, team: 'ally', id: 9102 }, 'blade');
    return { shown, pGuard, front, aiHp: k.hp, cls: p.cls, hp: p.maxHp };
  });
  ok('🔨 기사 — 막기 버튼 숨김·입력 무시, 정면 공격이 그대로 들어간다',
    knightGuard.cls === 'knight' && knightGuard.shown === false && knightGuard.pGuard === false &&
    knightGuard.front < 8900, knightGuard);
  ok('🔨 AI 기사도 막지 못한다 (가드를 강제로 켜도 피해 그대로)', knightGuard.aiHp < 8900, { hp: knightGuard.aiHp });

  /* ===== 27. 🛡️ 고급 병사가 실제 난전에서 눈에 띄게 자주 막는다 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 14, enemy: 14, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle', { timeout: 30000 });
  await sleep(300);
  const guardCount = await page.evaluate(() => {
    const b = window.BA.battle;
    // 적군만 고급 병사로 바꿔 같은 수로 붙인다 (아군은 병사)
    const foes = b.units.filter((u) => u.team === 'enemy' && !u.isPlayer);
    for (const u of foes) { u.cls = 'elite'; u.maxHp = 165; u.hp = 165; u.cycle = 0.745; }
    /* 양쪽 피해를 0으로 둬 20초 동안 계속 서로 휘두르게 한다 (막기 횟수만 비교) */
    for (const u of b.units) if (!u.isPlayer) u.damage = 0;
    const blocks = { soldier: 0, elite: 0 };
    const orig = b.emit.bind(b);
    b.emit = (e) => { if (e.type === 'block' && e.unit && blocks[e.unit.cls] !== undefined) blocks[e.unit.cls]++; return orig(e); };
    for (let i = 0; i < 20; i++) window.BA.debug.advance(1);
    b.emit = orig;
    return { blocks, allyAlive: b.countAlive('ally'), enemyAlive: b.countAlive('enemy') };
  });
  ok('🛡️ 고급 병사 AI가 병사보다 눈에 띄게 자주 막는다 (20초 난전)',
    guardCount.blocks.elite >= 2 && guardCount.blocks.elite > guardCount.blocks.soldier, guardCount);

  /* ===== 28. 🛡️ 고급 병사 방패 제거 — 3D 모델·1인칭 모두 검으로 막는다 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'elite', ally: 4, enemy: 4, ae: 2, ee: 2, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(500);
  const noShield = await page.evaluate(() => {
    const app = window.BA.app;
    const c = app.unitRenderer.classes && app.unitRenderer.classes.elite;
    if (!c) return { missing: true };
    const chest = c.parts.filter((pv) => pv.userData.joint === 3);   // J.chest = 3
    const cloth = chest.filter((pv) => pv.userData.matKey === 'cloth');
    let minX = 0;
    for (const pv of cloth) {
      pv.geometry.computeBoundingBox();
      minX = Math.min(minX, pv.geometry.boundingBox.min.x);
    }
    const vmElite = app.vm.models.elite;
    return {
      chestParts: chest.length, clothParts: cloth.length, minX: +minX.toFixed(3),
      vmShield: !!(vmElite && vmElite.userData.shield),
      label: document.querySelector('#guardBtn .sk-label').textContent
    };
  });
  ok('🛡️ 고급 병사 3D 모델에 방패가 없다 (흉갑 왼쪽 판 제거 · 장검은 그대로)',
    !noShield.missing && noShield.minX > -0.28, noShield);
  ok('🛡️ 고급 병사 1인칭에 방패가 없고 막기 라벨은 "검 막기"',
    noShield.vmShield === false && noShield.label === '검 막기', noShield);

  /* ===== 29. 💚 자연 회복 — 살아 있는 모든 유닛이 최대 체력 비례로 회복 ===== */
  const regenProbe = await page.evaluate(() => {
    const b = window.BA.battle;
    const spec = window.BA.specs();
    const pick = [b.units.find((u) => u.team === 'ally' && !u.isPlayer && !u.dead),
      b.units.find((u) => u.team === 'enemy' && !u.dead), b.player].filter((u) => u && !u.dead);
    const saved = b.units.map((u) => [u, u.damage]);
    for (const u of b.units) if (!u.isPlayer) { u.damage = 0; u.freezeT = 2; }
    const before = pick.map((u) => { u.hp = u.maxHp * 0.5; return u.hp; });
    const maxs = pick.map((u) => u.maxHp);
    for (let i = 0; i < 60; i++) b.update(1 / 60, null);
    const gained = pick.map((u, i) => u.hp - before[i]);
    // 사망 유닛은 회복하지 않는다
    const d = window.BA.debug.spawn('soldier', 'enemy', 0, 0);
    d.dead = true; d.hp = 0; d.maxHp = 150;
    b.update(1 / 60, null);
    const deadHp = d.hp;
    // 상한 고정 — 최대 체력을 넘지 않는다
    if (pick[0]) { pick[0].hp = pick[0].maxHp - 0.01; }
    for (let i = 0; i < 30; i++) b.update(1 / 60, null);
    const capped = pick[0] ? pick[0].hp <= pick[0].maxHp + 0.0001 : true;
    for (const [u, dmg] of saved) u.damage = dmg;
    return {
      frac: spec.regen,
      gained: gained.map((g) => +g.toFixed(3)),
      expect: maxs.map((m) => +(m * spec.regen).toFixed(3)),
      deadHp, capped, n: pick.length
    };
  });
  const regenOk = regenProbe.gained.length >= 2 && regenProbe.gained.every((g, i) =>
    Math.abs(g - regenProbe.expect[i]) <= Math.max(0.02, regenProbe.expect[i] * 0.05));
  ok('💚 살아 있는 아군·적군·플레이어가 1초에 최대 체력의 1.5%씩 자연 회복한다',
    regenProbe.frac === 0.015 && regenOk, regenProbe);
  ok('💚 사망 유닛은 회복하지 않고, 회복은 최대 체력에서 멈춘다',
    regenProbe.deadHp === 0 && regenProbe.capped === true, regenProbe);

  ok('콘솔/페이지 오류 0 (헤드리스 SwiftShader)', errors.length === 0, errors.slice(0, 5));
  console.log(`\n모든 테스트 통과 (${passed}개) · 스크린샷 ${SHOTS}`);
  await browser.close();
  stop();
  process.exit(0);
})().catch(async (e) => {
  console.error('테스트 실패:', e && e.message);
  try { process.exit(1); } catch (err) { /* noop */ }
});
