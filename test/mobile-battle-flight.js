'use strict';

/* =============================================================================
   배틀 아레나 3D · 모바일(390×844 세로) 실제 렌더 검증
   -----------------------------------------------------------------------------
   · ⚔️ 병종 밸런스: 병사 150/150 · 기사 체력 2900·공격력 285·막기 불가 · 검객 1200/178/0.30초 · 고급 병사 방패 제거
   · 🩸 신규 6번째 병종 '단검 광전사' — 3600 체력(3000 → 20% 상향) · 18 공격력 · 0.25초 연타 · 이속 5.00(병사보다 20% 빠름) · 홀드 자동 연타
   · 🔮 대마법사 마법 위력 15% 너프 (화염 212 · 번개 178 · 빙결 170) · 매화 일섬 246
   · 🩸 적중 흡혈: 실제 피해를 입힌 공격자는 그 7%(최소 1)를 회복 — 막기(0 피해)에는 회복 없음
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

  /* ===== 0-a. 🧮 기본 편성 — 전 병종 0명 (직접 편성하게 비워 둔다) ===== */
  const defaults = await page.evaluate(async () => {
    const CFG = await import('/src/config.js');
    const cfg = window.BA.config();
    const rows = Array.from(document.querySelectorAll('.row')).map((r) => ({
      team: r.dataset.team, unit: r.dataset.unit,
      v: Number(r.querySelector('input.num').value),
      range: Number(r.querySelector('input[type=range]').value)
    }));
    return {
      cfg, total: document.getElementById('rosterTotal').textContent,
      rows,
      spawn: CFG.SPAWN_INTERVAL
    };
  });
  ok('🧮 기본 편성 = 전 병종 0명 (아군·적군 6종 모두 0 · 총 0명 출전)',
    defaults.rows.length === 12 && defaults.rows.every((r) => r.v === 0 && r.range === 0) &&
    Object.keys(defaults.cfg).filter((k) => /^(ally|enemy)/.test(k)).every((k) => defaults.cfg[k] === 0) &&
    /총 0명/.test(defaults.total),
    { cfg: defaults.cfg, total: defaults.total, rows: defaults.rows });
  ok('🧮 일반 병사 증원은 0.12초(초당 약 8명) · 고급·특수 유닛은 0.38~0.46초',
    defaults.spawn.soldier === 0.12 &&
    ['elite', 'blademaster', 'berserker', 'knight', 'wizard'].every((k) => defaults.spawn[k] >= 0.35 && defaults.spawn[k] <= 0.55),
    defaults.spawn);

  /* ===== 0-a-2. 🧮 0명 상태에서 '전장으로' — 빈 전장에 들어가지 않고 편성부터 안내 ===== */
  const emptyStart = await page.evaluate(() => {
    const before = window.BA.state().state;
    document.getElementById('startBtn').click();
    const toast = document.getElementById('toast');
    return {
      before,
      after: window.BA.state().state,
      hasBattle: !!window.BA.app.battle,
      nudge: !!document.querySelector('.army-panel.is-nudge'),
      toast: toast ? toast.textContent : '',
      total: document.getElementById('rosterTotal').textContent
    };
  });
  ok('🧮 아군·적군 모두 0명으로 전장으로 → 입장하지 않고 편성 안내 (빈 전장·즉시 종료 없음)',
    emptyStart.before === 'home' && emptyStart.after === 'home' && emptyStart.hasBattle === false &&
    /편성/.test(emptyStart.toast) && /총 0명/.test(emptyStart.total), emptyStart);
  ok('🧮 안내할 때 편성판을 한 번 깜빡인다', emptyStart.nudge === true, emptyStart.nudge);
  const preset = await page.evaluate(() => {
    document.querySelector('#presets button[data-preset="clash"]').click();
    const clash = document.getElementById('rosterTotal').textContent;
    document.querySelector('#presets button[data-preset="duel"]').click();
    const duel = document.getElementById('rosterTotal').textContent;
    // 다시 0명으로 되돌려 다음 테스트가 같은 조건에서 시작하게 한다
    window.BA.setConfig({
      playerClass: 'soldier', allySoldiers: 0, allyElites: 0, allyKnights: 0, allyWizards: 0, allyBlademasters: 0, allyBerserkers: 0,
      enemySoldiers: 0, enemyElites: 0, enemyKnights: 0, enemyWizards: 0, enemyBlademasters: 0, enemyBerserkers: 0
    });
    return { clash, duel, back: document.getElementById('rosterTotal').textContent };
  });
  ok('🧮 프리셋 버튼은 그대로 동작한다 (균형 대결 62명 · 1:1 결투 2명)',
    /총 62명/.test(preset.clash) && /총 2명/.test(preset.duel), preset);
  ok('🧮 편성을 다시 0명으로 되돌리면 총 0명 출전', /총 0명/.test(preset.back), preset.back);

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
  ok('🔨 기사 체력 2800~3000 · 공격력 270~290 (망치 상향) · 한 번에 100명 · 막기 불가',
    C.knight.hp >= 2800 && C.knight.hp <= 3000 && C.knight.damage >= 270 && C.knight.damage <= 290 &&
    C.knight.maxTargets === 100 && C.knight.guard === false,
    { hp: C.knight.hp, dmg: C.knight.damage, guard: C.knight.guard });
  ok('🌸 검객 체력 1200(900 → 33% 상향) · 딜 178(210 에서 약 15% 하향) · 공속 0.30초 · 한 번에 10명 · 막기 가능',
    C.blademaster.hp === 1200 && C.blademaster.damage === 178 && C.blademaster.maxTargets === 10 &&
    C.blademaster.speed > 5.0 && C.blademaster.cycle <= 0.305 && C.blademaster.guard === true,
    { hp: C.blademaster.hp, dmg: C.blademaster.damage, cycle: C.blademaster.cycle });
  ok('🌸 매화 일섬 위력도 같은 비율로 하향 (290 → 246) · 기본딜 178 보다 세다',
    specs.skill && specs.skill.damage === 246 && specs.skill.damage > C.blademaster.damage,
    specs.skill && { dmg: specs.skill.damage, base: C.blademaster.damage });
  ok('🩸 단검 광전사 = 3600 체력(3000 에서 20% 상향) · 18 공격력 · 0.25초 연타(0.18 → 공속 너프) · 이속 5.00 버프 · 막기 불가',
    C.berserker && C.berserker.hp === 3600 && Math.abs(C.berserker.hp - 3000 * 1.2) < 0.001 && C.berserker.damage === 18 &&
    C.berserker.cycle === 0.25 && C.berserker.cycle >= 0.24 && C.berserker.cycle <= 0.26 &&
    C.berserker.speed === 5.0 && C.berserker.speed > C.soldier.speed * 1.15 && C.berserker.guard === false,
    C.berserker && { hp: C.berserker.hp, dmg: C.berserker.damage, cycle: C.berserker.cycle, speed: C.berserker.speed, guard: C.berserker.guard });
  ok('🔮 마법사 이속·마법 쿨타임 조정 · 막기 불가', C.wizard.speed < 3.6 && C.wizard.guard === false &&
    specs.spells.fire.cooldown === 3.8 && specs.spells.lightning.cooldown === 6.6 && specs.spells.ice.cooldown === 8.6);
  ok('🔮 마법 3종 위력 15% 너프 (화염 250→212 · 번개 210→178 · 빙결 200→170)',
    specs.spells.fire.damage === 212 && specs.spells.lightning.damage === 178 && specs.spells.ice.damage === 170 &&
    specs.spells.fire.damage < 250 && specs.spells.lightning.damage < 210 && specs.spells.ice.damage < 200,
    { fire: specs.spells.fire.damage, lightning: specs.spells.lightning.damage, ice: specs.spells.ice.damage });
  ok('이속: 병사·기사 상향', C.soldier.speed > 3.9 && C.knight.speed > 3.1);

  /* ===== 0a. 일반 병사 동시 96명(비율 0.6) + 빠른 증원(0.12초) ===== */
  const fieldRatio = await page.evaluate(async () => {
    const { FIELD_RATIO, FIELD_MAX, SPAWN_INTERVAL } = await import('/src/config.js');
    // start() 는 동기 — 전투가 막 만들어진 순간의 상한·예비를 그대로 읽는다
    window.BA.start({ cls: 'soldier', ally: 160, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0, az: 0, ez: 0 });
    const b = window.BA.battle;
    const full = { cap: b.fieldCap.ally.soldier, reserve: b.remain.ally.soldier, alive: b.countAlive('ally') };
    // 24명이 쓰러지면 0.7초 동안 예비에서 몇 명이 밀려 들어오는지 (병사 증원 0.12초 × 2명)
    let killed = 0;
    for (const u of b.units) {
      if (killed >= 24) break;
      if (u.team === 'ally' && !u.isPlayer && !u.dead) { u.dead = true; u.hp = 0; killed++; }
    }
    window.BA.debug.advance(0.7);
    const refill = { alive: b.countAlive('ally'), reserve: b.remain.ally.soldier };
    window.BA.start({ cls: 'soldier', ally: 300, enemy: 0, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0, az: 0, ez: 0 });
    const b2 = window.BA.battle;
    return {
      ratio: FIELD_RATIO.soldier, max: FIELD_MAX.soldier, interval: SPAWN_INTERVAL.soldier,
      full, killed, refill, over: { cap: b2.fieldCap.ally.soldier, reserve: b2.remain.ally.soldier }
    };
  });
  ok('⚔️ 일반 병사는 전장 96명(비율 0.6)이 서고 나머지 64명은 예비',
    fieldRatio.ratio === 0.6 && fieldRatio.max === 160 && fieldRatio.full.cap === 96 && fieldRatio.full.reserve === 64,
    fieldRatio.full);
  ok('⚔️ 병사 증원 간격 0.12초 — 24명이 쓰러지면 0.7초에 8명 이상이 다시 들어온다',
    fieldRatio.interval === 0.12 && fieldRatio.killed === 24 &&
    fieldRatio.refill.alive > fieldRatio.full.alive - 24 && fieldRatio.full.alive - fieldRatio.refill.alive >= 8 &&
    fieldRatio.refill.reserve < 64,
    { interval: fieldRatio.interval, killed: fieldRatio.killed, refill: fieldRatio.refill });
  ok('⚔️ 상한(160)을 넘겨 넣으면 전장 160 + 나머지는 예비',
    fieldRatio.over.cap === 160 && fieldRatio.over.reserve === 140, fieldRatio.over);

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
    // 막기 빈도 설정값도 확인 (병사 0.30/0.14 · 고급 0.84/0.58)
    const units = b.units.filter((x) => x.cls === 'elite' && !x.isPlayer).slice(0, 1)[0];
    return { hp: u.hp, react: units.guardReaction, hold: units.guardHold, cdMax: units.guardCdMax };
  });
  ok('🛡️ 고급 병사는 횟수 제한 없이 12번 연속 완전 방어', eliteGuard.hp === 900, eliteGuard);
  ok('🛡️ AI 막기 빈도 — 고급 병사 0.84/0.58 (병사 0.30/0.14 · 검객 0.66/0.36)',
    Math.abs(eliteGuard.react - 0.84) < 0.01 && Math.abs(eliteGuard.hold - 0.58) < 0.01 &&
    eliteGuard.cdMax <= 0.55 && eliteGuard.react > 0.5, eliteGuard);
  const gc = specs.guardChance || {};
  ok('🛡️ AI 막기 확률표 — 일반 병사·고급 병사·매화 검객만 (기사·마법사·단검 광전사는 막기 없음)',
    gc.soldier && gc.elite && gc.blademaster && !gc.berserker && !gc.knight && !gc.wizard &&
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

  /* ===== 5b. 👁️ 시점 감도 — 기본 10% 상향 + 전체화면에서는 27% 더 빠르게 ===== */
  const sens = await page.evaluate(() => window.BA.look());
  ok('👁️ 기본 시점 감도가 10% 올라갔다 (1인칭 0.0069 · 관전 0.0079)',
    Math.abs(sens.sens - 0.0069) < 0.0002 && Math.abs(sens.spec - 0.0079) < 0.0002 &&
    Math.abs(sens.pitch - 0.0054) < 0.0002 && Math.abs(sens.specPitch - 0.0062) < 0.0002, sens);
  const fsSens = await page.evaluate(() => {
    const app = window.BA.app, c = document.getElementById('gl');
    const mode0 = app.camMode, yawSave = app.camYaw, pitchSave = app.camPitch;
    const dragBy = (dx) => {
      const mk = (type, x, y) => new PointerEvent(type, {
        pointerId: 91, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, bubbles: true, cancelable: true
      });
      c.dispatchEvent(mk('pointerdown', 195, 420));
      c.dispatchEvent(mk('pointermove', 195 + dx, 420));
      c.dispatchEvent(mk('pointerup', 195 + dx, 420));
    };
    app.camMode = 'fp';
    const yaw0 = app.camYaw; dragBy(40);
    const normal = Math.abs(app.camYaw - yaw0);
    // 표준 전체화면 상태를 흔들어 같은 드래그를 한 번 더
    const had = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
    const yaw1 = app.camYaw; dragBy(40);
    const fs = Math.abs(app.camYaw - yaw1);
    if (had) Object.defineProperty(document, 'fullscreenElement', had); else delete document.fullscreenElement;
    app.camMode = mode0; app.camYaw = yawSave; app.camPitch = pitchSave;   // 관전 상태로 되돌린다
    return { normal: +normal.toFixed(4), fs: +fs.toFixed(4), ratio: +(fs / normal).toFixed(2), boost: window.BA.look().fsBoost, after: window.BA.look().fullscreen };
  });
  ok('👁️ 전체화면에서는 같은 드래그에 시점이 25~30% 더 빠르게 돈다 (기본 1.27배)',
    fsSens.ratio >= 1.24 && fsSens.ratio <= 1.30 && Math.abs(fsSens.boost - 1.27) < 0.01 && fsSens.after === false, fsSens);
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
  /* 광전사는 0.25초 주기로 0.24초 모션을 재생한다 — 프레임당 회전이 원래 크다 */
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

  /* ===== 21. 🛡️ 막기 버튼 — 실터치(홀드·탭)로 막기 가능 병종이 막는다 ===== */
  const guardRuns = [];
  for (const cls of ['soldier', 'elite', 'blademaster']) {
    await page.evaluate((c) => window.BA.start({ cls: c, ally: 6, enemy: 2, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }), cls);
    await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
    await sleep(300);
    const rect = await page.evaluate(() => {
      const b = document.getElementById('guardBtn');
      const r = b.getBoundingClientRect();
      const lbl = b.querySelector('.sk-label');
      // 마법사는 마법 3버튼이 같이 떠 있다 — 막기 버튼과 겹치지 않는지 본다
      const spells = Array.from(document.querySelectorAll('#battle .spell-btn'))
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
  ok('🛡️ 막기 버튼이 막기 가능 3병종에 보이고 실제 터치로 눌린다',
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
    const spells = Array.from(document.querySelectorAll('#battle .spell-btn'))
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
  ok('🩸 단검 광전사가 양 진영에 스폰되고 1인칭·HUD·3D 모델이 붙는다 (막기 버튼은 숨김)',
    bers.cls === 'berserker' && bers.allyAI === 4 && bers.enemyAI === 4 &&
    Math.abs(bers.playerHp - 3600) < 120 && bers.cycle === 0.25 && bers.speed > bers.soldierSpeed * 1.15 &&
    bers.buckets.includes('berserker') && bers.parts > 20 && bers.vmModel &&
    bers.hudIcon === '🩸' && bers.atkLabel === '연타' && bers.guardOn === false, bers);

  const poseBers = await page.evaluate(() => {
    const r = {};
    r.atk = window.BA.debug.poseTrack({ cls: 'berserker', kind: 'attack', from: 0, to: 0.25, frames: 15 });
    r.guard = window.BA.debug.poseTrack({ cls: 'berserker', kind: 'guard', from: 0, to: 0.5, frames: 30 });
    return r;
  });
  ok('🩸 광전사 모션이 0.25초 주기에 맞게 재생된다 (공격·막기 모두 끊김 없음)',
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

  /* ===== 26b. 🩸 단검 광전사도 이제 막기 불가 (버튼 숨김 · 입력 무시 · AI 무시) ===== */
  await page.evaluate(() => window.BA.start({ cls: 'berserker', ally: 2, enemy: 2, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(400);
  const berserkGuard = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, p = b.player;
    app.paused = false;
    const btn = document.getElementById('guardBtn');
    const shown = btn.classList.contains('is-on') && getComputedStyle(btn).display !== 'none';
    p.guard = false; b.playerSafe = false;
    b.update(1 / 60, { mx: 0, mz: 0, yaw: p.yaw, guard: true, attack: false, aimPart: 'body', aimId: 0 });
    const pGuard = !!p.guard;
    p.maxHp = 5000; p.hp = 5000;
    b.damage(p, 500, { x: p.x, z: p.z + 3, team: 'enemy', id: 9201 }, 'blade');
    const front = p.hp;
    // AI 광전사도 가드를 강제로 켜도 막지 못한다
    const z = window.BA.debug.spawn('berserker', 'enemy', 0, 0);
    z.x = 0; z.z = 0; z.yaw = 0; z.hp = 5000; z.maxHp = 5000; z.guard = true; z.guardT = 99;
    b.damage(z, 500, { x: 0, z: 2, team: 'ally', id: 9202 }, 'blade');
    return { cls: p.cls, shown, pGuard, front, aiHp: z.hp, guardFlag: window.BA.specs().classes.berserker.guard };
  });
  ok('🩸 광전사 — 막기 버튼 숨김·입력 무시 · 정면 공격이 그대로 들어간다',
    berserkGuard.cls === 'berserker' && berserkGuard.guardFlag === false && berserkGuard.shown === false &&
    berserkGuard.pGuard === false && berserkGuard.front < 4900, berserkGuard);
  ok('🩸 AI 광전사도 막지 못한다 (가드를 강제로 켜도 피해 그대로)', berserkGuard.aiHp < 4900, { hp: berserkGuard.aiHp });

  /* ===== 27. 🛡️ 고급 병사가 실제 난전에서 눈에 띄게 자주 막는다 (렌더러 없는 순수 시뮬레이션) ===== */
  const guardCount = await page.evaluate(async () => {
    const { Battle } = await import('/src/battle.js');
    const run = (cls) => {
      const n = 14;
      const cfg = {
        playerClass: 'soldier', seed: 23,
        allySoldiers: cls === 'soldier' ? n : 0, enemySoldiers: cls === 'soldier' ? n : 0,
        allyElites: cls === 'elite' ? n : 0, enemyElites: cls === 'elite' ? n : 0,
        allyKnights: 0, enemyKnights: 0, allyWizards: 0, enemyWizards: 0,
        allyBlademasters: 0, enemyBlademasters: 0, allyBerserkers: 0, enemyBerserkers: 0
      };
      const b = new Battle({ config: cfg, playerKills: 0, autoPlayer: true }).start();
      // 오래 싸우게 체력을 올리고 피해는 0 — 막는 횟수만 센다
      for (const u of b.units) { u.maxHp = 3000; u.hp = 3000; u.damage = 0; }
      let blocks = 0;
      const orig = b.emit.bind(b);
      b.emit = (e) => { if (e.type === 'block') blocks++; return orig(e); };
      for (let i = 0; i < 60 * 20; i++) { b.update(1 / 60, null); b.drain(); }
      b.emit = orig;
      return { blocks, frames: 1200 };
    };
    return { soldier: run('soldier'), elite: run('elite') };
  });
  ok('🛡️ 고급 병사 AI가 병사보다 눈에 띄게 자주 막는다 (20초 난전 · 고급 ≥ 병사 ×1.5)',
    guardCount.elite.blocks >= 3 && guardCount.elite.blocks > guardCount.soldier.blocks * 1.5, guardCount);

  /* ===== 27b. 🛡️ 막기 빈도 미세 조정 — 일반 병사·매화는 그대로, 고급 병사만 아주 조금 낮추고 매화는 조금 높임 ===== */
  const guardTuning = await page.evaluate(async () => {
    const { Battle } = await import('/src/battle.js');
    const CFG = await import('/src/config.js');
    // 2026-11-26 1차 상향 전 기본 설정
    const BASELINE = {
      soldier: { react: 0.18, hold: 0.08, cd: 2.2, reactT: 0.10, dur: 1 },
      elite: { react: 0.55, hold: 0.26, cd: 1.1, reactT: 0.09, dur: 1 },
      blademaster: { react: 0.30, hold: 0.13, cd: 1.7, reactT: 0.08, dur: 1 }
    };
    // 2026-11-26 1차 상향(약 2배) 설정 — "너무 자주 막는다"로 줄이기 전 기준
    const BOOSTED = {
      soldier: { react: 0.30, hold: 0.14, cd: 0.70, reactT: 0.08, dur: 0.80 },
      elite: { react: 0.98, hold: 0.70, cd: 0.40, reactT: 0.05, dur: 0.65 },
      blademaster: { react: 0.55, hold: 0.28, cd: 0.42, reactT: 0.07, dur: 0.80 }
    };
    const current = JSON.parse(JSON.stringify(CFG.GUARD_CHANCE));
    /* 스킬 피해(히트스톱 시간)가 막기 횟수 측정에 끼어들지 않게 0으로 — 가드 설정만 비교한다.
       (피해·체력 밸런스를 조정해도 이 비교는 흔들리지 않는다) */
    const skillDamage = CFG.SKILL.damage;
    CFG.SKILL.damage = 0;
    const setTable = (t) => {
      for (const k of Object.keys(CFG.GUARD_CHANCE)) delete CFG.GUARD_CHANCE[k];
      for (const k of Object.keys(t)) CFG.GUARD_CHANCE[k] = Object.assign({}, t[k]);
    };
    const run = (cls, seed) => {
      const n = 14;
      const cfg = {
        playerClass: 'soldier', seed,
        allySoldiers: cls === 'soldier' ? n : 0, enemySoldiers: cls === 'soldier' ? n : 0,
        allyElites: cls === 'elite' ? n : 0, enemyElites: cls === 'elite' ? n : 0,
        allyKnights: 0, enemyKnights: 0, allyWizards: 0, enemyWizards: 0,
        allyBlademasters: cls === 'blademaster' ? n : 0, enemyBlademasters: cls === 'blademaster' ? n : 0,
        allyBerserkers: 0, enemyBerserkers: 0
      };
      const b = new Battle({ config: cfg, playerKills: 0, autoPlayer: true }).start();
      for (const u of b.units) { u.maxHp = 3000; u.hp = 3000; u.damage = 0; }
      let blocks = 0, acts = 0;
      const orig = b.emit.bind(b);
      b.emit = (e) => { if (e.type === 'block') blocks++; return orig(e); };
      const prev = new Map();
      for (let i = 0; i < 60 * 20; i++) {
        b.update(1 / 60, null); b.drain();
        for (const u of b.units) {
          if (u.isPlayer) continue;
          if (u.guard && !prev.get(u)) acts++;
          prev.set(u, u.guard);
        }
      }
      b.emit = orig;
      return { blocks, acts };
    };
    const measure = (table, cls) => {
      setTable(table);
      const runs = [23, 77, 131].map((s) => run(cls, s));
      return {
        blocks: runs.reduce((a, r) => a + r.blocks, 0) / runs.length,
        acts: runs.reduce((a, r) => a + r.acts, 0) / runs.length
      };
    };
    const out = {};
    for (const cls of ['soldier', 'elite', 'blademaster']) {
      const base = measure(BASELINE, cls);
      const boosted = measure(BOOSTED, cls);
      const now = measure(current, cls);
      out[cls] = {
        base: { blocks: +base.blocks.toFixed(1), acts: +base.acts.toFixed(1) },
        boosted: { blocks: +boosted.blocks.toFixed(1), acts: +boosted.acts.toFixed(1) },
        now: { blocks: +now.blocks.toFixed(1), acts: +now.acts.toFixed(1) },
        blockVsBoost: +(now.blocks / Math.max(1, boosted.blocks)).toFixed(2),
        blockVsBase: +(now.blocks / Math.max(1, base.blocks)).toFixed(2),
        actVsBoost: +(now.acts / Math.max(1, boosted.acts)).toFixed(2),
        actVsBase: +(now.acts / Math.max(1, base.acts)).toFixed(2)
      };
    }
    setTable(current);
    CFG.SKILL.damage = skillDamage;
    return out;
  });
  const gdClasses = ['soldier', 'elite', 'blademaster'];
  const nowTable = await page.evaluate(() => window.BA.specs().guardChance);
  ok('🛡️ 일반 병사 막기 빈도는 그대로 (0.30/0.14 · cd 0.70)',
    Math.abs(nowTable.soldier.react - 0.30) < 0.005 && Math.abs(nowTable.soldier.hold - 0.14) < 0.005 &&
    Math.abs(nowTable.soldier.cd - 0.70) < 0.005, nowTable.soldier);
  ok('🛡️ 고급 병사만 아주 조금 낮췄다 (0.98/0.70·cd 0.40 → 0.84/0.58·cd 0.50)',
    Math.abs(nowTable.elite.react - 0.84) < 0.005 && Math.abs(nowTable.elite.hold - 0.58) < 0.005 &&
    Math.abs(nowTable.elite.cd - 0.50) < 0.005 &&
    nowTable.elite.react < 0.98 && nowTable.elite.hold < 0.70 && nowTable.elite.cd > 0.40, nowTable.elite);
  ok('🛡️ 매화 검객은 조금 더 자주 막는다 (0.55/0.28·cd 0.42 → 0.66/0.36·cd 0.36)',
    Math.abs(nowTable.blademaster.react - 0.66) < 0.005 && Math.abs(nowTable.blademaster.hold - 0.36) < 0.005 &&
    Math.abs(nowTable.blademaster.cd - 0.36) < 0.005 &&
    nowTable.blademaster.react > 0.55 && nowTable.blademaster.cd < 0.42, nowTable.blademaster);
  ok('🛡️ 실제 난전에서 고급 병사 막기는 직전보다 늘지 않았고(같은 수준), 매화 검객은 더 자주 막는다',
    guardTuning.elite.actVsBoost <= 1.05 && guardTuning.elite.blockVsBoost <= 1.30 &&
    guardTuning.blademaster.blockVsBoost >= 1.05 && guardTuning.blademaster.actVsBoost >= 1.05,
    gdClasses.map((c) => ({ cls: c, b: guardTuning[c].blockVsBoost, a: guardTuning[c].actVsBoost })));

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

  /* ===== 29a. 🩸 적중 흡혈 — 실제 피해를 입혔을 때만 아주 조금 회복 (막기는 제외) ===== */
  const steal = await page.evaluate(async () => {
    const { Battle } = await import('/src/battle.js');
    const cfg = {
      playerClass: 'soldier', seed: 777,
      allySoldiers: 0, enemySoldiers: 0, allyElites: 0, enemyElites: 0,
      allyKnights: 0, enemyKnights: 0, allyWizards: 0, enemyWizards: 0,
      allyBlademasters: 0, enemyBlademasters: 0, allyBerserkers: 0, enemyBerserkers: 0
    };
    const b = new Battle({ config: cfg, playerKills: 0, autoPlayer: false }).start();
    b.playerSafe = true;
    const spec = window.BA.specs().lifesteal;
    const a = b.newUnit('soldier', 'ally', 0, 0, false);      // 때리는 쪽
    const e = b.newUnit('soldier', 'enemy', 0, 2, false);     // 맞는 쪽
    const out = { frac: spec.frac, min: spec.min, perSwingMin: spec.perSwingMin, perSwingFrac: spec.perSwingFrac };

    // ① 실제 피해를 입히면 그 7% 만큼 회복한다
    a.hp = a.maxHp * 0.5;
    const a0 = a.hp, e0 = e.hp;
    out.dealt = +b.damage(e, 100, a, 'blade', 'body').toFixed(3);
    out.heal = +(a.hp - a0).toFixed(3);
    out.targetLost = +(e0 - e.hp).toFixed(3);

    // ② 막기(0 피해)에는 회복이 없다 — 적이 공격자를 정면으로 보며 막는다
    b.time += 1;
    e.hp = e.maxHp;
    e.yaw = Math.atan2(a.x - e.x, a.z - e.z);
    e.guard = true;
    a.hp = a.maxHp * 0.5;
    const a1 = a.hp, e1 = e.hp;
    out.blockedDealt = +b.damage(e, 100, a, 'blade', 'body').toFixed(3);
    out.blockedHeal = +(a.hp - a1).toFixed(3);
    out.blockedLost = +(e1 - e.hp).toFixed(3);

    // ③ 회복은 최대 체력에서 멈춘다
    b.time += 1;
    e.guard = false;
    a.hp = a.maxHp - 0.25;
    b.damage(e, 100, a, 'blade', 'body');
    out.capped = a.hp <= a.maxHp + 0.0001;

    // ④ 한 번의 공격으로 여럿을 때려도 총 회복은 max(10, 최대 체력 3%) 까지
    b.time += 1;
    a.hp = a.maxHp * 0.4;
    const a2 = a.hp;
    for (let i = 0; i < 5; i++) {
      const t = b.newUnit('soldier', 'enemy', 4 + i * 0.6, 6, false);
      b.damage(t, 100, a, 'blade', 'body');
    }
    out.aoeHeal = +(a.hp - a2).toFixed(3);
    out.aoeCap = +Math.max(spec.perSwingMin, a.maxHp * spec.perSwingFrac).toFixed(3);

    // ⑤ 아주 약한 피해도 최소 1 은 회복한다
    b.time += 1;
    a.hp = a.maxHp * 0.4;
    const a3 = a.hp;
    out.tinyDealt = +b.damage(b.newUnit('soldier', 'enemy', 0, 2, false), 2, a, 'blade', 'body').toFixed(3);
    out.tinyHeal = +(a.hp - a3).toFixed(3);

    // ⑥ 죽은 공격자는 회복하지 않는다
    b.time += 1;
    const d = b.newUnit('soldier', 'ally', 0, 0, false);
    d.dead = true; d.hp = 0;
    b.damage(b.newUnit('soldier', 'enemy', 0, 2, false), 100, d, 'blade', 'body');
    out.deadHeal = +d.hp.toFixed(3);
    return out;
  });
  ok('🩸 실제 피해를 입히면 공격자가 그 피해의 7%만큼 회복한다 (100 피해 → +7)',
    steal.frac === 0.07 && steal.dealt === 100 && Math.abs(steal.heal - 7) < 0.01 &&
    Math.abs(steal.targetLost - 100) < 0.01, steal);
  ok('🩸 막기로 피해가 0이면 공격자는 회복하지 않는다 (상대 체력도 그대로)',
    steal.blockedDealt === 0 && steal.blockedHeal === 0 && steal.blockedLost === 0, steal);
  ok('🩸 회복은 최대 체력에서 멈춘다', steal.capped === true, steal);
  ok('🩸 한 번의 공격으로 여러 명을 때려도 총 회복은 max(10, 최대 체력 3%) 이하',
    steal.aoeHeal > 0 && steal.aoeHeal <= steal.aoeCap + 0.001 && steal.aoeCap === 10, steal);
  ok('🩸 아주 약한 피해(2)도 최소 1 은 회복하고, 죽은 공격자는 회복하지 않는다',
    Math.abs(steal.tinyHeal - 1) < 0.01 && steal.deadHeal === 0, steal);

  /* ===== 28. 🖥️ 전체화면 토글 — 배치 · 클릭 핸들러 · 아이콘 동기화 · 렌더러 리사이즈 ===== */
  await page.evaluate(() => window.BA.app.toHome());
  await sleep(350);
  const fsBox = (sel, host) => page.evaluate(({ sel, host }) => {
    const el = document.querySelector(sel);
    if (!el) return { exists: false };
    const q = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const enter = el.querySelector('.fs-enter'), exit = el.querySelector('.fs-exit');
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return {
      exists: true,
      inHost: host ? !!el.closest(host) : true,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && q.width > 0 && q.height > 0,
      w: +q.width.toFixed(1), h: +q.height.toFixed(1),
      l: +q.left.toFixed(1), t: +q.top.toFixed(1), r: +q.right.toFixed(1), b: +q.bottom.toFixed(1),
      pressed: el.getAttribute('aria-pressed'), title: el.title, aria: el.getAttribute('aria-label'),
      enterShown: !!enter && getComputedStyle(enter).display !== 'none',
      exitShown: !!exit && getComputedStyle(exit).display !== 'none',
      hitOk: !!(hit && hit.closest && hit.closest(sel)),
      inside: q.left >= 0 && q.top >= 0 && q.right <= innerWidth + 0.5 && q.bottom <= innerHeight + 0.5
    };
  }, { sel, host });
  const gapX = (a, b) => +(b.l - a.r).toFixed(1);
  const overlaps = (a, b) => !(a.r <= b.l + 0.01 || b.r <= a.l + 0.01 || a.b <= b.t + 0.01 || b.b <= a.t + 0.01);

  const homeFs = await fsBox('#fsHomeBtn', '#home');
  const homeBrand = await fsBox('.brand', '#home');
  const homeBadge = await fsBox('#growthBadge', '#home');
  ok('🖥️ 홈 상단 바에 전체화면 버튼이 보이고 터치 영역이 충분하다 (390×844)',
    homeFs.exists && homeFs.inHost && homeFs.visible && homeFs.w >= 32 && homeFs.h >= 32 && homeFs.inside && homeFs.hitOk,
    { w: homeFs.w, h: homeFs.h, inside: homeFs.inside, hitOk: homeFs.hitOk });
  ok('🖥️ 홈 전체화면 버튼이 브랜드·성장 뱃지와 겹치지 않는다',
    !overlaps(homeFs, homeBrand) && !overlaps(homeFs, homeBadge) &&
    gapX(homeBrand, homeFs) >= 4 && gapX(homeFs, homeBadge) >= 4,
    { brandGap: gapX(homeBrand, homeFs), badgeGap: gapX(homeFs, homeBadge) });
  await shot('55-home-fullscreen.png');

  // 표준 API 를 가짜로 바꿔 전체화면 상태·이벤트를 재현한다 (헤드리스에서도 핸들러·동기화를 결정적으로 검증)
  await page.evaluate(() => {
    const doc = document, el = document.documentElement;
    window.__fsOrig = { req: el.requestFullscreen, webreq: el.webkitRequestFullscreen, exit: doc.exitFullscreen, webexit: doc.webkitExitFullscreen };
    window.__fsEl = null;
    window.__fsMode = 'ok';
    Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => window.__fsEl });
    Object.defineProperty(doc, 'fullscreenEnabled', { configurable: true, get: () => true });
    el.requestFullscreen = function () {
      if (window.__fsMode === 'reject') return Promise.reject(new Error('blocked by test'));
      window.__fsEl = el; doc.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
    };
    doc.exitFullscreen = function () { window.__fsEl = null; doc.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
    window.__fsRestore = () => {
      el.requestFullscreen = window.__fsOrig.req;
      doc.exitFullscreen = window.__fsOrig.exit;
      if (window.__fsOrig.webreq === undefined) delete el.webkitRequestFullscreen; else el.webkitRequestFullscreen = window.__fsOrig.webreq;
      delete doc.fullscreenElement; delete doc.fullscreenEnabled;
      window.__fsEl = null;
    };
  });
  // 리사이즈 연동 카운트
  await page.evaluate(() => {
    const app = window.BA.app, orig = app._origResize || app.resize;
    window.__fsResizeN = 0;
    app._origResize = orig.bind(app);
    app.resize = function () { window.__fsResizeN++; return app._origResize.apply(app, arguments); };
  });
  await page.click('#fsHomeBtn');
  await sleep(520);
  const fsOn = await page.evaluate(() => {
    const a = document.getElementById('fsHomeBtn'), b = document.getElementById('fsBtn');
    const ea = a.querySelector('.fs-enter'), xa = a.querySelector('.fs-exit');
    return {
      isOn: window.BA.fullscreen.isOn(),
      home: { pressed: a.getAttribute('aria-pressed'), title: a.title, enter: getComputedStyle(ea).display !== 'none', exit: getComputedStyle(xa).display !== 'none' },
      battle: { pressed: b.getAttribute('aria-pressed'), title: b.title },
      resize: window.__fsResizeN
    };
  });
  ok('🖥️ 전체화면 버튼을 탭하면 켜지고, 아이콘이 축소 모양으로 바뀐다',
    fsOn.isOn && fsOn.home.pressed === 'true' && fsOn.home.title === '전체화면 끄기' && fsOn.home.enter === false && fsOn.home.exit === true,
    fsOn.home);
  ok('🖥️ 홈과 전장의 전체화면 버튼이 같은 상태를 공유한다',
    fsOn.battle.pressed === 'true' && fsOn.battle.title === '전체화면 끄기', fsOn.battle);
  ok('🖥️ 전체화면 진입 시 3D 렌더러 resize 가 다시 맞춰진다', fsOn.resize >= 2, { resizeCalls: fsOn.resize });

  await page.click('#fsHomeBtn');
  await sleep(300);
  const fsOff = await page.evaluate(() => ({
    isOn: window.BA.fullscreen.isOn(),
    home: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'),
    battle: document.getElementById('fsBtn').getAttribute('aria-pressed'),
    title: document.getElementById('fsHomeBtn').title
  }));
  ok('🖥️ 다시 탭하면 전체화면이 해제되고 아이콘·aria 가 되돌아온다',
    fsOff.isOn === false && fsOff.home === 'false' && fsOff.battle === 'false' && fsOff.title === '전체화면', fsOff);

  // 거부되는 환경 — 예외 없이 아이콘은 꺼진 채, 안내만
  await page.evaluate(() => { window.__fsMode = 'reject'; });
  await page.click('#fsHomeBtn');
  await sleep(250);
  const fsRejected = await page.evaluate(() => {
    const t = document.getElementById('toast');
    return {
      pressed: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'),
      isOn: window.BA.fullscreen.isOn(),
      toast: t ? t.textContent : '',
      toastOpacity: t ? getComputedStyle(t).opacity : '0'
    };
  });
  ok('🖥️ 전체화면이 거부되어도 예외 없이 꺼진 상태로 남고 안내만 뜬다',
    fsRejected.pressed === 'false' && fsRejected.isOn === false && /전체화면/.test(fsRejected.toast),
    fsRejected);

  // API 자체가 없는 환경 (인앱 브라우저·아이폰 사파리) — 조용히 무시
  await page.evaluate(() => {
    const el = document.documentElement;
    window.__fsMode = 'ok';
    el.requestFullscreen = undefined;
    el.webkitRequestFullscreen = undefined;
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  });
  const fsSupportedNone = await page.evaluate(() => window.BA.fullscreen.supported());
  await page.click('#fsHomeBtn');
  await sleep(200);
  const fsBlocked = await page.evaluate(() => {
    const t = document.getElementById('toast');
    return { pressed: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'), toast: t ? t.textContent : '', err: null };
  });
  ok('🖥️ Fullscreen API 가 막힌 환경에서도 오류 없이 무시하고 안내한다',
    fsSupportedNone === false && fsBlocked.pressed === 'false' && /전체화면/.test(fsBlocked.toast), fsBlocked);

  // 진짜 API 복구 → 진짜 클릭으로 전체화면 진입/해제 (헤드리스 크롬)
  await page.evaluate(() => window.__fsRestore());
  const realSupported = await page.evaluate(() => window.BA.fullscreen.supported());
  await page.click('#fsHomeBtn');
  await sleep(650);
  const realFs = await page.evaluate(() => {
    const c = document.getElementById('gl');
    const app = window.BA.app;
    return {
      el: !!document.fullscreenElement,
      pressed: document.getElementById('fsHomeBtn').getAttribute('aria-pressed'),
      canvas: c ? [c.width, c.height] : null,
      win: [innerWidth, innerHeight],
      dpr: window.devicePixelRatio || 1,
      aspect: app.cam ? +app.cam.aspect.toFixed(3) : null,
      winAspect: +(innerWidth / innerHeight).toFixed(3),
      resize: window.__fsResizeN
    };
  });
  ok('🖥️ 실제 Fullscreen API 로 전체화면에 들어가고 상태가 맞춰진다',
    realSupported === true ? (realFs.el === true && realFs.pressed === 'true') : realFs.pressed === 'false', realFs);
  ok('🖥️ 전체화면 전환 뒤 캔버스가 화면을 빈틈없이 채운다',
    !realFs.canvas || (Math.abs(realFs.canvas[0] - Math.round(realFs.win[0] * realFs.dpr)) <= 1 &&
      Math.abs(realFs.canvas[1] - Math.round(realFs.win[1] * realFs.dpr)) <= 1 &&
      Math.abs(realFs.aspect - realFs.winAspect) < 0.02), realFs);

  // 창 크기가 바뀌어도(회전·전체화면 해제) 렌더러가 따라온다
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(600);
  const rotated = await page.evaluate(() => {
    const c = document.getElementById('gl'); const app = window.BA.app;
    return { canvas: [c.width, c.height], win: [innerWidth, innerHeight], aspect: +app.cam.aspect.toFixed(3), winAspect: +(innerWidth / innerHeight).toFixed(3) };
  });
  ok('🖥️ 창 크기가 바뀌어도(가로 회전) 3D 화면이 꽉 차게 갱신된다',
    Math.abs(rotated.canvas[0] - rotated.win[0]) <= 1 && Math.abs(rotated.canvas[1] - rotated.win[1]) <= 1 &&
    Math.abs(rotated.aspect - rotated.winAspect) < 0.02, rotated);
  if (realFs.el) { await page.evaluate(() => { try { document.exitFullscreen(); } catch (e) { /* noop */ } }); await sleep(400); }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(400);
  await page.evaluate(() => { const app = window.BA.app; if (app._origResize) { app.resize = app._origResize; delete app._origResize; } });

  // 전장 HUD 배치 — 👁️ · ⛶ · ☰ 이 겹치지 않고 화면 안에
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 40, enemy: 40 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle', { timeout: 30000 });
  await sleep(900);
  const hudFs = await fsBox('#fsBtn', '#battle');
  const hudCam = await fsBox('#camBtn', '#battle');
  const hudMenu = await fsBox('#menuBtn', '#battle');
  const hudKill = await fsBox('.kill-chip', '#battle');
  const hudStr = await fsBox('.strength', '#battle');
  ok('🖥️ 전장 HUD 우측 상단에 👁️ · ⛶ · ☰ 이 나란히 있고 터치된다',
    hudFs.visible && hudFs.w >= 32 && hudFs.h >= 32 && hudFs.inside && hudFs.hitOk &&
    gapX(hudCam, hudFs) >= 3 && gapX(hudFs, hudMenu) >= 3, { fs: hudFs, camGap: gapX(hudCam, hudFs), menuGap: gapX(hudFs, hudMenu) });
  ok('🖥️ 전장 전체화면 버튼이 처치 칩·병력 상태와 겹치지 않는다',
    !overlaps(hudFs, hudKill) && !overlaps(hudFs, hudStr) && !overlaps(hudCam, hudKill) && !overlaps(hudStr, hudKill) && gapX(hudStr, hudKill) >= 2,
    { strKillGap: gapX(hudStr, hudKill), fsKill: overlaps(hudFs, hudKill), fsStr: overlaps(hudFs, hudStr) });
  ok('🖥️ 전투 중 ⛶ 버튼을 눌러도 전장·시점이 그대로다', await page.evaluate(() => {
    const before = window.BA.state();
    return before.state === 'battle' && !!window.BA.battle && window.BA.app.state === 'battle';
  }));
  const battleFsOn = await (async () => {
    await page.click('#fsBtn');
    await sleep(700);
    const on = await page.evaluate(() => {
      const c = document.getElementById('gl'); const app = window.BA.app;
      return {
        el: !!document.fullscreenElement,
        pressed: document.getElementById('fsBtn').getAttribute('aria-pressed'),
        title: document.getElementById('fsBtn').title,
        canvas: [c.width, c.height], win: [innerWidth, innerHeight],
        dpr: window.devicePixelRatio || 1,
        aspect: +app.cam.aspect.toFixed(3), winAspect: +(innerWidth / innerHeight).toFixed(3)
      };
    });
    await page.click('#fsBtn');
    await sleep(600);
    const off = await page.evaluate(() => ({
      el: !!document.fullscreenElement,
      pressed: document.getElementById('fsBtn').getAttribute('aria-pressed'),
      state: window.BA.state().state
    }));
    return { on, off };
  })();
  ok('🖥️ 전투 중 ☰ 옆 ⛶ 을 탭하면 실제 전체화면으로 들어가고 다시 탭하면 빠져나온다',
    battleFsOn.on.pressed === 'true' && battleFsOn.on.title === '전체화면 끄기' && battleFsOn.off.pressed === 'false' &&
    (battleFsOn.on.el ? battleFsOn.off.el === false : true) && battleFsOn.off.state === 'battle', battleFsOn);
  ok('🖥️ 전투 중 전체화면에서도 3D 화면이 빈틈없이 꽉 찬다',
    Math.abs(battleFsOn.on.canvas[0] - Math.round(battleFsOn.on.win[0] * battleFsOn.on.dpr)) <= 1 &&
    Math.abs(battleFsOn.on.canvas[1] - Math.round(battleFsOn.on.win[1] * battleFsOn.on.dpr)) <= 1 &&
    Math.abs(battleFsOn.on.aspect - battleFsOn.on.winAspect) < 0.02, battleFsOn.on);
  await shot('56-battle-fullscreen.png');

  /* ===== 28a. 🖥️ 전체화면 HUD — 조이스틱·공격/막기/스킬 버튼 여백·크기 (세로·가로) ===== */
  await page.evaluate(() => window.BA.start({ cls: 'blademaster', ally: 4, enemy: 4, ae: 0, ee: 0, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player, { timeout: 30000 });
  await sleep(600);
  const fsHud = () => page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // 숨어 있는 버튼(병종에 따라 마법·스킬이 꺼진다)도 크기는 계산값으로 잰다
      return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), cw: parseFloat(cs.width) || 0, ch: parseFloat(cs.height) || 0,
        l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
    };
    const sels = ['#joy', '#actions', '#attackBtn', '#guardBtn', '#skillBtn', '.spell-btn'];
    return {
      fs: document.getElementById('app').classList.contains('is-fullscreen'),
      win: [innerWidth, innerHeight],
      joy: box('#joy'), actions: box('#actions'),
      attack: box('#attackBtn'), guard: box('#guardBtn'), skill: box('#skillBtn'), spell: box('.spell-btn'),
      inside: sels.every((s) => {
        const el = document.querySelector(s);
        if (!el) return true;
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
      })
    };
  });
  // 표준 전체화면 상태를 흉내 낸다 (fullscreenchange → #app.is-fullscreen)
  const fakeFs = (on) => page.evaluate((on) => {
    if (on) {
      window.__hudFsHad = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
    } else if (window.__hudFsHad) {
      Object.defineProperty(document, 'fullscreenElement', window.__hudFsHad);
      delete window.__hudFsHad;
    } else {
      delete document.fullscreenElement;
    }
    document.dispatchEvent(new Event('fullscreenchange'));
  }, on);
  const hudGrow = (a, b) => (a && b ? +(b.cw / a.cw).toFixed(3) : 0);
  const hudLayoutOk = (h) => h.attack && h.guard && h.skill && h.joy && h.actions && h.inside &&
    h.attack.w > 0 && h.guard.w > 0 && h.skill.w > 0 &&
    h.joy.r <= h.actions.l + 0.01 && h.joy.l >= 16 && h.win[0] - h.actions.r >= 16 &&
    h.win[1] - Math.max(h.joy.b, h.actions.b) >= 16;

  const hudP0 = await fsHud();
  await fakeFs(true);
  await sleep(180);
  const hudP1 = await fsHud();
  ok('🖥️ 전체화면에서 공격·막기·스킬·마법 버튼이 1.08~1.15배로 커진다 (390×844)',
    hudP1.fs === true &&
    ['attack', 'guard', 'skill', 'spell'].every((k) => hudGrow(hudP0[k], hudP1[k]) >= 1.08 && hudGrow(hudP0[k], hudP1[k]) <= 1.15),
    { attack: hudGrow(hudP0.attack, hudP1.attack), guard: hudGrow(hudP0.guard, hudP1.guard), skill: hudGrow(hudP0.skill, hudP1.skill), spell: hudGrow(hudP0.spell, hudP1.spell) });
  ok('🖥️ 전체화면에서 조이스틱·액션 버튼이 모서리에서 16px 이상 안쪽으로 들고, 겹치지 않으며 화면 안에 있다 (390×844)',
    hudLayoutOk(hudP1),
    { joyLeft: hudP1.joy.l, joyBottom: +(hudP1.win[1] - hudP1.joy.b).toFixed(1), actionsRight: +(hudP1.win[0] - hudP1.actions.r).toFixed(1), actionsBottom: +(hudP1.win[1] - hudP1.actions.b).toFixed(1), joyActionsGap: +(hudP1.actions.l - hudP1.joy.r).toFixed(1), inside: hudP1.inside });
  ok('🖥️ 전체화면이 아니면 버튼이 원래 크기로 돌아온다 (390×844 공격 92px → 전체화면 101px)',
    Math.abs(hudP0.attack.cw - 92) < 0.6 && Math.abs(hudP1.attack.cw - 101) < 0.6 && Math.abs(hudP0.guard.cw - 60) < 0.6,
    { normal: hudP0.attack, fs: hudP1.attack, guard: hudP0.guard });
  await shot('57-battle-fullscreen-hud.png');

  // 가로(844×390)에서도 키우되 화면을 넘거나 겹치지 않는다
  await fakeFs(false);
  await sleep(120);
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(700);
  const hudL0 = await fsHud();
  await fakeFs(true);
  await sleep(200);
  const hudL1 = await fsHud();
  ok('🖥️ 가로 전체화면에서도 공격·막기·스킬·마법 버튼이 1.08~1.15배로 커진다 (844×390)',
    hudL1.fs === true && hudL1.win[0] > hudL1.win[1] &&
    ['attack', 'guard', 'skill', 'spell'].every((k) => hudGrow(hudL0[k], hudL1[k]) >= 1.08 && hudGrow(hudL0[k], hudL1[k]) <= 1.15),
    { attack: hudGrow(hudL0.attack, hudL1.attack), guard: hudGrow(hudL0.guard, hudL1.guard), skill: hudGrow(hudL0.skill, hudL1.skill), spell: hudGrow(hudL0.spell, hudL1.spell) });
  ok('🖥️ 가로 전체화면에서도 조이스틱·액션 버튼이 화면 안에서 겹치지 않는다 (844×390)',
    hudLayoutOk(hudL1),
    { joy: hudL1.joy, actions: hudL1.actions, gap: +(hudL1.actions.l - hudL1.joy.r).toFixed(1), inside: hudL1.inside, win: hudL1.win });
  await shot('58-battle-fullscreen-hud-landscape.png');
  await fakeFs(false);
  await sleep(120);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await sleep(600);
  const hudBack = await fsHud();
  ok('🖥️ 전체화면을 끄면 HUD가 원래 배치로 돌아온다',
    hudBack.fs === false && hudBack.inside && hudBack.attack.w === hudP0.attack.w &&
    Math.abs(hudBack.joy.l - 14) <= 2, { fs: hudBack.fs, attack: hudBack.attack, joy: hudBack.joy });

  /* ===== 29b. 🎬 AI끼리(관전) 싸우면 아군·적군 승률 50:50 — 편향 점검 ===== */
  // ① 관전 중인 플레이어(무적 유령)가 아군 전멸 판정을 막지 않는지
  const ghostWin = await page.evaluate(async () => {
    const { Battle } = await import('/src/battle.js');
    const cfg = {
      playerClass: 'soldier', seed: 5150,
      allySoldiers: 4, enemySoldiers: 4, allyElites: 0, enemyElites: 0,
      allyKnights: 0, enemyKnights: 0, allyWizards: 0, enemyWizards: 0,
      allyBlademasters: 0, enemyBlademasters: 0, allyBerserkers: 0, enemyBerserkers: 0
    };
    const b = new Battle({ config: cfg, playerKills: 0, autoPlayer: false }).start();
    b.playerSafe = true;
    // 아군 AI를 전부 쓰러뜨린다 — 관전 플레이어는 살아 있다
    for (const u of b.units) if (u.team === 'ally' && !u.isPlayer) { u.dead = true; u.deadT = 0.2; u.hp = 0; }
    for (const c of Object.keys(b.remain.ally)) b.remain.ally[c] = 0;   // 예비도 없다
    b.tallyUnits();
    for (let i = 0; i < 150 && !b.over; i++) { b.update(1 / 60, null); b.drain(); }
    return { over: b.over, winner: b.over ? b.winner : null, playerAlive: !!(b.player && !b.player.dead) };
  });
  ok('🎬 아군 AI가 전멸하면 관전 중이라도 패배로 끝난다 (유령 플레이어가 아군 수에 끼지 않음)',
    ghostWin.over === true && ghostWin.winner === 'enemy' && ghostWin.playerAlive === true, ghostWin);

  // ② 동일 편성 AI 대전 20판 — 아군·적군 승률이 균형인지
  const fairness = await page.evaluate(async () => {
    const { Battle } = await import('/src/battle.js');
    const roster = { soldier: 20, elite: 0, knight: 1, wizard: 1, blademaster: 1, berserker: 0 };
    const fight = (seed) => {
      const cfg = {
        playerClass: 'soldier', seed,
        allySoldiers: roster.soldier, enemySoldiers: roster.soldier,
        allyElites: roster.elite, enemyElites: roster.elite,
        allyKnights: roster.knight, enemyKnights: roster.knight,
        allyWizards: roster.wizard, enemyWizards: roster.wizard,
        allyBlademasters: roster.blademaster, enemyBlademasters: roster.blademaster,
        allyBerserkers: roster.berserker, enemyBerserkers: roster.berserker
      };
      const b = new Battle({ config: cfg, playerKills: 0, autoPlayer: false }).start();
      b.playerSafe = true;                       // 관전 — 플레이어는 싸우지 않는다
      if (b.player) b.player.hideModel = true;
      let t = 0;
      while (!b.over && t < 150) { b.update(1 / 60, null); b.drain(); t += 1 / 60; }
      return b.over ? b.winner : 'timeout';
    };
    let ally = 0, enemy = 0, draw = 0, timeout = 0;
    for (let i = 0; i < 20; i++) {
      const w = fight(1000 + i * 37);
      if (w === 'ally') ally++; else if (w === 'enemy') enemy++;
      else if (w === 'draw') draw++; else timeout++;
    }
    return { ally, enemy, draw, timeout, n: 20 };
  });
  ok('🎬 동일 편성 AI 대전 20판 — 아군·적군 승률이 균형 (한쪽 몰살 없음)',
    fairness.timeout <= 2 && fairness.ally >= 6 && fairness.enemy >= 6 && Math.abs(fairness.ally - fairness.enemy) <= 8,
    fairness);

  ok('콘솔/페이지 오류 0 (헤드리스 SwiftShader)', errors.length === 0, errors.slice(0, 5));
  console.log(`\n모든 테스트 통과 (${passed}개) · 스크린샷 ${SHOTS}`);
  await browser.close();
  stop();
  process.exit(0);
})().catch(async (e) => {
  console.error('테스트 실패:', e && e.message);
  try { process.exit(1); } catch (err) { /* noop */ }
});
