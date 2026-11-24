'use strict';

/* 배틀 아레나 3D · 모바일(390×844 세로) 실제 렌더 검증
   - 🎬 관전 자유 비행: 아래를 보고 조이스틱 앞으로 → 고도가 실제로 내려가 4m 아래(병사 눈높이 1.5m)까지,
     위를 보면 올라가고, 뒤로 당기면 반대로. 가로 이동이 카메라 시선 방향과 정확히 일치하는지(전진·우측).
   - ⚔️ 참전 복귀: 관전하던 그 지면으로 내려오고(전장 반경 클램프) 보던 방향 유지 · 0.9초 무적.
   - 화면 흔들림 0: 헤드밥·호흡·공격/피격 반동·롤·fov 출렁임이 없이 눈높이 고정.
   - 코앞 아군이 사라지지 않는다 (근접 시야 가림 제거), 1인칭에서 숨는 건 내 몸뿐.
   - 🌸 매화 검객 상향 스펙 (아군·적군 동일).
   실행: node test/mobile-battle-flight.js
*/

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = '/workspace/territory-war-online';
const SHOTS = '/workspace/tmp/spec-shots';
const PORT = 3591;
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
  // 조이스틱 실제 입력 — center 기준 (dx, dy) 픽셀로 민다 (dy 음수 = 위로 = 전진)
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

  console.log('▶ 배틀 아레나 3D · 관전 자유비행/화면 고정/근접 유닛/검객 상향 검증 (390×844)');
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.BA && window.BA.app, { timeout: 30000 });
  await sleep(500);

  /* ===== 0. 스펙: 특수 유닛 3종 ===== */
  const specs = await page.evaluate(() => window.BA.specs());
  const bm = specs.classes.blademaster, kn = specs.classes.knight, wz = specs.classes.wizard;
  const sol = specs.classes.soldier;
  ok('🌸 매화 검객 — hp 345 · damage 210 · speed 5.0 · 한 번에 5명',
    bm.hp === 345 && bm.damage === 210 && bm.speed === 5.0 && bm.maxTargets === 5,
    { hp: bm.hp, dmg: bm.damage, speed: bm.speed, maxTargets: bm.maxTargets });
  ok('🌸 매화 일섬 — 피해 290 · 쿨 5.0초 · 반경 2.6m',
    specs.skill.damage === 290 && specs.skill.cooldown === 5.0 && specs.skill.radius === 2.6,
    { dmg: specs.skill.damage, cd: specs.skill.cooldown, r: specs.skill.radius });
  ok('🔨 중갑 기사 — hp 800 · damage 220 · speed 3.1', kn.hp === 800 && kn.damage === 220 && kn.speed === 3.1,
    { hp: kn.hp, dmg: kn.damage, speed: kn.speed });
  ok('🔮 대마법사 — hp 240 (유리대포) · speed 3.6', wz.hp === 240 && wz.speed === 3.6, { hp: wz.hp, speed: wz.speed });
  ok('데미지 2배 — 병사 120 · 기사 220 · 검객 210 · 매화 일섬 290 · 마법 250/210/200',
    sol.damage === 120 && kn.damage === 220 && bm.damage === 210 && specs.skill.damage === 290 &&
    specs.spells.fire.damage === 250 && specs.spells.lightning.damage === 210 && specs.spells.ice.damage === 200,
    { soldier: sol.damage, knight: kn.damage, bm: bm.damage, skill: specs.skill.damage,
      fire: specs.spells.fire.damage, lightning: specs.spells.lightning.damage, ice: specs.spells.ice.damage });
  ok('이동속도 전반 상향 (병사 3.9 · 기사 3.1 · 검객 5.0 · 마법사 3.6)',
    sol.speed === 3.9 && kn.speed === 3.1 && bm.speed === 5.0 && wz.speed === 3.6,
    { soldier: sol.speed, knight: kn.speed, blademaster: bm.speed, wizard: wz.speed });
  ok('특수 유닛 3종 + 매화 일섬 + 마법 3종 모두 일반 병사를 한 방에 처치 (병사 hp 120)',
    sol.hp === 120 && sol.damage === 120 && kn.damage >= sol.hp && bm.damage >= sol.hp && specs.skill.damage >= sol.hp &&
    specs.spells.fire.damage >= sol.hp && specs.spells.lightning.damage >= sol.hp && specs.spells.ice.damage >= sol.hp,
    { soldierHp: sol.hp, knight: kn.damage, bm: bm.damage, skill: specs.skill.damage,
      fire: specs.spells.fire.damage, lightning: specs.spells.lightning.damage, ice: specs.spells.ice.damage });

  /* ===== 1. 전장 시작 (검객 · 소규모) ===== */
  await page.evaluate(() => {
    window.BA.setConfig({
      playerClass: 'blademaster', allySoldiers: 10, enemySoldiers: 10,
      ak: 0, ek: 0, aw: 0, ew: 0, ab: 2, eb: 2
    });
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.state === 'battle' && s.player && s.units > 0;
  }, { timeout: 30000 });
  await sleep(900);
  const begun = await st();
  ok('검객으로 1인칭 전장 진입', begun.camMode === 'fp' && begun.player.cls === 'blademaster', { cam: begun.camMode, cls: begun.player.cls });
  const bmSpec = await page.evaluate(() => {
    const b = window.BA.battle;
    const list = b.units.filter((u) => u.cls === 'blademaster');
    return list.map((u) => ({ team: u.team, hp: u.maxHp, dmg: u.damage }));
  });
  ok('아군·적군 검객 스펙이 같다 (345 / 210)',
    bmSpec.length >= 2 && bmSpec.every((u) => Math.abs(u.hp - 345) < 0.01 && Math.abs(u.dmg - 210) < 0.01), bmSpec);

  // 실제 전투 판정으로 확인 — 병사(100)가 특수 유닛 한 방에 쓰러진다
  const oneShot = await page.evaluate(() => {
    const b = window.BA.battle, S = window.BA.specs();
    const out = {};
    const hit = (key, dmg) => {
      const u = window.BA.debug.spawn('soldier', 'enemy', 120, 120);
      u.hp = S.classes.soldier.hp; u.maxHp = S.classes.soldier.hp; u.armor = 0; u.dead = false;
      b.damage(u, dmg, null, key);
      out[key] = { dead: u.dead, hp: +u.hp.toFixed(1) };
    };
    hit('knight', S.classes.knight.damage);
    hit('blademaster', S.classes.blademaster.damage);
    hit('wizardStaff', S.classes.wizard.damage);
    hit('petal', S.skill.damage);
    hit('fire', S.spells.fire.damage);
    hit('lightning', S.spells.lightning.damage);
    hit('ice', S.spells.ice.damage);
    return out;
  });
  ok('기사·검객·매화 일섬·화염·번개·빙결 한 방에 병사 처치',
    ['knight', 'blademaster', 'petal', 'fire', 'lightning', 'ice'].every((k) => oneShot[k].dead), oneShot);

  /* ===== 2. 화면 흔들림 0 ===== */
  await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.fx.shake = 1.4; app.fx.hitFlash = 1;
    b.hitStop = 0.09;
    b.player.attackT = 0.18; b.player.moveAmt = 1; b.player.walkPhase = 1.37;
  });
  await advance(0.4);
  const steady = await st();
  ok('흔들림 0 — 카메라가 플레이어 x·z 위에 정확히 있고 롤 0 · fov 62 고정',
    Math.abs(steady.cam.x - steady.player.x) < 1e-9 && Math.abs(steady.cam.z - steady.player.z) < 1e-9 &&
    steady.cam.roll === 0 && steady.cam.fov === 62 && steady.cam.pitch === steady.camPitch,
    { cam: steady.cam, p: { x: steady.player.x, z: steady.player.z }, camPitch: steady.camPitch });
  // 실제 프레임 루프에서도 세로 흔들림이 없다 (걸어가며 12프레임 샘플)
  await joy(0, -42, 'down');
  const eyeSamples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(70);
    eyeSamples.push(await page.evaluate(() => window.BA.state().cam.y));
  }
  await joy(0, -42, 'up');
  const eyeMin = Math.min(...eyeSamples), eyeMax = Math.max(...eyeSamples);
  ok('걸어도 카메라 높이가 흔들리지 않는다 (헤드밥·호흡 제거)',
    eyeMax - eyeMin < 1e-6 && Math.abs(eyeMin - 1.64) < 1e-6, { min: eyeMin, max: eyeMax });

  /* ===== 3. 코앞 아군이 사라지지 않는다 ===== */
  const near = await page.evaluate(() => {
    const b = window.BA.battle, p = b.player, app = window.BA.app;
    app.paused = true;
    const ally = b.units.find((u) => u.team === 'ally' && !u.isPlayer && !u.dead);
    ally.x = p.x + Math.sin(p.yaw) * 1.0;
    ally.z = p.z + Math.cos(p.yaw) * 1.0;
    ally.hideModel = false;
    const foe = b.units.find((u) => u.team === 'enemy' && !u.dead);
    foe.x = p.x + Math.sin(p.yaw + 0.6) * 1.2;
    foe.z = p.z + Math.cos(p.yaw + 0.6) * 1.2;
    foe.hideModel = false;
    return { ally: ally.id, foe: foe.id };
  });
  await sleep(500);   // 일시정지 상태로 실제 프레임만 돌려 렌더 티어를 갱신한다
  const seen = await page.evaluate((ids) => {
    const b = window.BA.battle, p = b.player;
    const pick = (id) => {
      const u = b.units.find((x) => x.id === id);
      return u ? { d: +Math.hypot(u.x - p.x, u.z - p.z).toFixed(2), tier: u._tier, dslot: u.dslot, slot: u.slot, hide: !!u.hideModel } : null;
    };
    return { ally: pick(ids.ally), foe: pick(ids.foe), selfHidden: !!b.player.hideModel, camMode: window.BA.app.camMode };
  }, near);
  ok('1m 앞 아군도 사라지지 않고 그려진다 (근접 시야 가림 제거)',
    seen.ally && seen.ally.d < 1.6 && seen.ally.tier !== -2 && !seen.ally.hide &&
    (seen.ally.dslot >= 0 || seen.ally.slot >= 0), seen.ally);
  ok('1.2m 앞 적도 사라지지 않는다', seen.foe && seen.foe.tier !== -2 && !seen.foe.hide, seen.foe);
  ok('1인칭에서 숨는 것은 내 몸뿐', seen.selfHidden === true && seen.camMode === 'fp', { selfHidden: seen.selfHidden, cam: seen.camMode });
  await page.evaluate(() => { window.BA.app.paused = false; });
  await shot('40-near-ally-visible.png');

  /* ===== 4. 🎬 관전 — 자유 비행 ===== */
  await page.click('#camBtn');
  await page.click('#camBtn');
  await page.waitForFunction(() => window.BA.state().camMode === 'spectate', { timeout: 15000 });
  await advance(0.2);
  const spec0 = await st();
  ok('🎬 관전 진입 — 공중(12m+) 자유 비행 · 전투 UI 숨김 · 피격 없음',
    spec0.playerSafe === true && spec0.spectate && spec0.spectate.y > 11 && spec0.cam.y > 11,
    { y: spec0.spectate && +spec0.spectate.y.toFixed(2), safe: spec0.playerSafe });
  const ui = await page.evaluate(() => ({
    hint: getComputedStyle(document.getElementById('specHint')).display,
    actions: getComputedStyle(document.querySelector('.hud-bottom .actions')).display,
    btns: getComputedStyle(document.getElementById('camBtn')).display
  }));
  ok('관전 중 안내 문구가 뜨고 공격 버튼은 사라진다 (참전 버튼은 유지)',
    ui.hint !== 'none' && ui.actions === 'none' && ui.btns !== 'none', ui);
  await shot('41-spectate-air.png');

  // 시선 아래로 (드래그) — pitch 감소
  const p0 = (await st()).spectate.pitch;
  await drag(0, 70);
  await advance(0.1);
  const p1 = (await st()).spectate.pitch;
  ok('드래그로 아래를 내려다본다 (pitch 감소 · 80° 이상 가능)',
    p1 < p0 - 0.3 && p1 <= -0.6, { before: +p0.toFixed(2), after: +p1.toFixed(2) });

  // 아래를 보고 조이스틱 앞으로 → 고도 하강
  await page.evaluate(() => { const s = window.BA.app.spectate; s.pitch = -1.05; s.yaw = 0; s.x = 0; s.z = 0; });
  await joy(0, -42, 'down');
  const ys = [(await st()).spectate.y];
  for (let i = 0; i < 8; i++) { await advance(0.25); ys.push((await st()).spectate.y); }
  await shot('42-spectate-ground.png');
  const descending = ys.every((y, i) => i === 0 || y <= ys[i - 1] + 1e-9);
  ok('아래를 보고 앞으로 밀면 고도가 실제로 내려간다', descending, ys.map((y) => +y.toFixed(2)));
  ok('4m 아래까지 내려가 병사 눈높이(1.5m)에서 멈춘다 (예전엔 4m에서 막혔다)',
    Math.min(...ys) <= 1.55 && Math.min(...ys) < 4, { min: +Math.min(...ys).toFixed(2) });

  // 앞으로 계속 밀어도 1.5m 아래로는 내려가지 않는다
  await advance(0.8);
  const floor = (await st()).spectate.y;
  ok('최저 고도 1.5m 고정 (땅에 박히지 않는다)', floor >= 1.49 && floor <= 1.55, { y: +floor.toFixed(2) });

  // 위를 보고 앞으로 → 상승
  await page.evaluate(() => { const s = window.BA.app.spectate; s.pitch = 0.8; });
  await advance(1.0);
  const upY = (await st()).spectate.y;
  ok('위를 보고 앞으로 밀면 하늘로 올라간다', upY > floor + 6, { from: +floor.toFixed(2), to: +upY.toFixed(2) });

  // 아래를 보고 뒤로 → 반대로 (상승)
  await page.evaluate(() => { const s = window.BA.app.spectate; s.pitch = -0.9; });
  const down0 = (await st()).spectate.y;
  await joy(0, 42, 'move');
  await advance(0.5);
  const backY = (await st()).spectate.y;
  ok('아래를 본 채 뒤로 당기면 반대로 올라간다', backY > down0 + 2, { from: +down0.toFixed(2), to: +backY.toFixed(2) });

  // 가로 이동이 카메라 시선과 일치 — 정면
  await joy(0, -42, 'move');
  const dir = await page.evaluate(() => {
    const app = window.BA.app, s = app.spectate;
    s.x = 0; s.z = 0; s.y = 30; s.yaw = 1.0; s.pitch = 0;
    app.updateCamera(1 / 60);
    const fwd = new window.__THREE.Vector3(0, 0, -1).applyQuaternion(app.cam.quaternion);
    const right = new window.__THREE.Vector3(1, 0, 0).applyQuaternion(app.cam.quaternion);
    return { fwd: { x: fwd.x, z: fwd.z }, right: { x: right.x, z: right.z }, from: { x: s.x, z: s.z } };
  });
  await advance(0.6);
  const fwdMove = await page.evaluate((from) => {
    const s = window.BA.app.spectate;
    return { dx: s.x - from.x, dz: s.z - from.z };
  }, dir.from);
  const fl = Math.hypot(fwdMove.dx, fwdMove.dz) || 1;
  const dotF = (fwdMove.dx / fl) * dir.fwd.x + (fwdMove.dz / fl) * dir.fwd.z;
  ok('조이스틱 전진 = 카메라가 보는 정면 (yaw 1.0rad에서도 일치)',
    fl > 4 && dotF > 0.98, { moved: +fl.toFixed(2), dot: +dotF.toFixed(3), fwd: dir.fwd, d: fwdMove });

  // 우측 이동 — 카메라 오른쪽
  const fromR = await page.evaluate(() => ({ x: window.BA.app.spectate.x, z: window.BA.app.spectate.z }));
  await joy(42, 0, 'move');
  await advance(0.5);
  const rightMove = await page.evaluate((from) => {
    const s = window.BA.app.spectate;
    return { dx: s.x - from.x, dz: s.z - from.z };
  }, fromR);
  const rl = Math.hypot(rightMove.dx, rightMove.dz) || 1;
  const dotR = (rightMove.dx / rl) * dir.right.x + (rightMove.dz / rl) * dir.right.z;
  ok('조이스틱 오른쪽 = 화면 오른쪽 (좌우 반전 없음)', rl > 3 && dotR > 0.98,
    { moved: +rl.toFixed(2), dot: +dotR.toFixed(3), right: dir.right });
  await joy(42, 0, 'up');

  /* ===== 5. ⚔️ 참전 복귀 — 관전하던 지면으로 ===== */
  const beforeExit = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle, s = app.spectate;
    s.x = 20; s.z = -15; s.yaw = 1.1; s.pitch = -0.6; s.y = 18;
    app.updateCamera(1 / 60);
    return { oldX: b.player.x, oldZ: b.player.z, arenaR: b.arenaR, yaw: s.yaw, pitch: s.pitch };
  });
  await page.evaluate(() => document.getElementById('camBtn').click());
  await advance(0.05);
  const landed = await st();
  const moveDist = Math.hypot(landed.player.x - beforeExit.oldX, landed.player.z - beforeExit.oldZ);
  ok('⚔️ 참전 → 관전하던 그 지면으로 내려온다 (예전 자리로 순간이동하지 않음)',
    landed.camMode === 'fp' && Math.abs(landed.player.x - 20) < 2.5 && Math.abs(landed.player.z + 15) < 2.5 && moveDist > 8,
    { x: +landed.player.x.toFixed(2), z: +landed.player.z.toFixed(2), moved: +moveDist.toFixed(1), old: [beforeExit.oldX, beforeExit.oldZ] });
  ok('내려와서도 보던 방향 그대로 · 0.9초 무적 · 관전 무적 해제',
    Math.abs(landed.player.yaw - beforeExit.yaw) < 0.001 && landed.playerInvuln > 0.5 && landed.playerSafe === false &&
    landed.cam.roll === 0, { yaw: +landed.player.yaw.toFixed(3), invuln: +landed.playerInvuln.toFixed(2), safe: landed.playerSafe });
  await shot('43-arena-landed.png');

  // 전장 밖에서 복귀하면 전장 반경 안으로 클램프
  await page.evaluate(() => document.getElementById('camBtn').click());  // fp → tp
  await page.evaluate(() => document.getElementById('camBtn').click());  // tp → spectate
  await page.evaluate(() => { const s = window.BA.app.spectate; s.x = 500; s.z = -500; s.y = 20; });
  await page.evaluate(() => document.getElementById('camBtn').click());  // spectate → fp
  await advance(0.05);
  const clamped = await st();
  ok('전장 밖에서 내려오면 전장 반경 안으로 들어온다',
    Math.hypot(clamped.player.x, clamped.player.z) <= clamped.arenaR + 0.5,
    { r: +Math.hypot(clamped.player.x, clamped.player.z).toFixed(2), arenaR: +clamped.arenaR.toFixed(2) });

  const camOk = await page.evaluate(() => ({ mode: window.BA.state().camMode, safe: window.BA.state().playerSafe }));
  ok('복귀 후 1인칭 참전 상태로 돌아온다', camOk.mode === 'fp' && camOk.safe === false, camOk);

  /* ===== 6. 🛡️ 일반 병사 방패 막기 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 10, enemy: 10, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.state === 'battle' && s.player && s.player.cls === 'soldier';
  }, { timeout: 30000 });
  await sleep(800);
  const gb = await page.evaluate(() => {
    const b = document.getElementById('guardBtn');
    return { display: getComputedStyle(b).display, label: b.textContent.trim() };
  });
  ok('일반 병사로 참전하면 🛡️ 막기 버튼이 보인다', gb.display !== 'none' && /막기/.test(gb.label), gb);
  await page.evaluate(() => {
    const b = document.getElementById('guardBtn');
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 91, pointerType: 'touch', isPrimary: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true
    }));
  });
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.player && s.player.guard === true;
  }, { timeout: 12000 }).catch(() => null);
  const held = await page.evaluate(() => ({
    guard: window.BA.state().player.guard, input: window.BA.app.input.guard,
    cls: document.getElementById('guardBtn').className
  }));
  ok('막기 버튼을 누르고 있는 동안 플레이어가 검을 들어 막는다',
    held.guard === true && held.input === true && /is-held/.test(held.cls), held);
  await shot('46-guard-first-person.png');

  // 이동속도 0.55배 — 같은 시간에 걸은 거리를 비교
  const walkDist = async (guard) => {
    await page.evaluate((g) => {
      const app = window.BA.app, b = window.BA.battle;
      app.input.guard = g; app.input.mx = 0; app.input.mz = 1;
      b.player.x = 0; b.player.z = -6; b.player.yaw = 0; app.camYaw = Math.PI;
    }, guard);
    await page.evaluate(() => window.BA.debug.advance(0.5));
    return page.evaluate(() => {
      const app = window.BA.app;
      app.input.mz = 0; app.input.mx = 0;
      const p = window.BA.state().player;
      return Math.abs(p.z + 6);
    });
  };
  const dWalk = await walkDist(false);
  const dGuardWalk = await walkDist(true);
  ok('막기 중에는 이동속도가 0.55배로 줄어든다',
    dGuardWalk < dWalk * 0.72 && dGuardWalk > 0.2, { walk: +dWalk.toFixed(2), guardWalk: +dGuardWalk.toFixed(2) });

  // 방어 판정 — 평타는 경감, 뒤는 그대로, 100+ 강타는 크게 경감 + 방패 파괴
  const dmgRes = await page.evaluate(() => {
    const b = window.BA.battle;
    const mk = (guard) => {
      const u = window.BA.debug.spawn('soldier', 'enemy', 60, 60);
      u.x = 0; u.z = 0; u.yaw = 0; u.hp = 120; u.maxHp = 120; u.armor = 0; u.dead = false;
      u.guard = guard; u.guardT = 1;
      return u;
    };
    const front = { x: 0, z: 2, team: 'ally', id: 901 };
    const back = { x: 0, z: -2, team: 'ally', id: 902 };
    const a = mk(false); b.damage(a, 120, front, 'blade');
    const c = mk(true); b.damage(c, 120, front, 'blade');
    const d = mk(true); b.damage(d, 220, front, 'hammer');
    const e = mk(true); b.damage(e, 120, back, 'blade');
    return { plainDead: a.dead, plainDmg: +(120 - a.hp).toFixed(1), blockedHp: +c.hp.toFixed(1),
      heavy: +(120 - d.hp).toFixed(2), heavyBreak: !d.guard, backDead: e.dead };
  });
  ok('검 막기 — 정면 평타(120)는 피해 0(완전 방어), 뒤에서 맞으면 그대로 죽는다',
    dmgRes.plainDead === true && dmgRes.blockedHp === 120 && dmgRes.backDead === true, dmgRes);
  ok('기사의 220 망치 강타는 75 정도만 관통하고 가드가 깨진다',
    dmgRes.heavy > 60 && dmgRes.heavy < 90 && dmgRes.heavyBreak === true, dmgRes);

  // AI 일반 병사도 검을 들어 막는다
  const aiGuard = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.input.guard = false; app.input.mx = 0; app.input.mz = 0;
    const teams = { ally: 0, enemy: 0 };
    let seen = 0, maxAtOnce = 0, blocks = 0, zeroBlocks = 0, hits = 0;
    const orig = b.emit.bind(b);
    b.emit = (e) => {
      if (e.type === 'block') { blocks++; if (e.dmg === 0) zeroBlocks++; }
      else if (e.type === 'hit') hits++;
      return orig(e);
    };
    for (let i = 0; i < 40; i++) {
      window.BA.debug.advance(0.2);
      let n = 0;
      for (const u of b.units) {
        if (u.isPlayer || u.cls !== 'soldier' || u.dead || !u.guard) continue;
        n++; teams[u.team] = 1;
      }
      if (n > 0) seen++;
      maxAtOnce = Math.max(maxAtOnce, n);
    }
    b.emit = orig;
    const soldiers = b.units.filter((u) => !u.isPlayer && u.cls === 'soldier').length;
    return { seen, maxAtOnce, teams, soldiers, blocks, zeroBlocks, hits };
  });
  ok('AI 일반 병사도 교전 중 검을 들어 막는다 (아군·적군 공통)',
    aiGuard.seen > 0 && aiGuard.teams.ally === 1 && aiGuard.teams.enemy === 1, aiGuard);
  ok('AI 병사가 실제로 막아 공격을 0 피해로 튕겨낸다', aiGuard.zeroBlocks > 0, aiGuard);

  // 방패 자세가 실제로 그려지는지 — 관전으로 아군 병사 앞에 서서 스크린샷
  await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = true;
    const u = b.units.find((x) => x.team === 'ally' && x.cls === 'soldier' && !x.isPlayer && !x.dead);
    for (const x of b.units) {
      if (x === u) continue;
      if (x.isPlayer) { x.guard = false; x.x = 0; x.z = -40; continue; }
      x.dead = true; x.removed = true; x.x = 60; x.z = 90; x.hideModel = true;
    }
    u.dead = false; u.removed = false; u.hideModel = false;
    u.x = 0; u.z = 0; u.yaw = Math.PI; u.guard = true; u.guardT = 99; u.attackT = -1; u.moveAmt = 0;
    app.camMode = 'spectate'; app.spectate = null; app._enterSpectate();
    const s = app.spectate;
    s.x = 1.5; s.z = -2.4; s.y = 1.45; s.yaw = Math.atan2(-1.5, 2.4); s.pitch = -0.08;
    app.updateCamera(1 / 60);
    document.getElementById('deadVeil').classList.remove('is-on');
  });
  await sleep(1200);
  await shot('45-guard-pose.png');

  /* ===== 6b. 시체가 남아 있어도 즉시 충원 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 200, enemy: 200, ak: 0, ek: 0, aw: 0, ew: 0, ab: 0, eb: 0 }));
  await page.waitForFunction(() => {
    const s = window.BA.state();
    return s && s.state === 'battle' && s.player && s.units > 100;
  }, { timeout: 60000 });
  await sleep(400);
  const reinf = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = true;
    app.input.guard = false;
    const before = b.countAlive('ally');
    const reserve0 = b.reserveTotal('ally');
    let killed = 0;
    for (const u of b.units) {
      if (u.team !== 'ally' || u.isPlayer || u.dead) continue;
      u.dead = true; u.hp = 0; u.deadT = 0; u.hitDone = true; u.attackT = -1;
      if (++killed >= 6) break;
    }
    const afterKill = b.countAlive('ally');
    const corpses0 = b.units.filter((u) => u.dead && !u.removed).length;
    window.BA.debug.advance(0.45);
    return {
      before, killed, afterKill, corpses0,
      after: b.countAlive('ally'), corpses1: b.units.filter((u) => u.dead && !u.removed).length,
      reserve0, reserve1: b.reserveTotal('ally')
    };
  });
  ok('병사가 죽으면 시체가 남아 있어도 즉시 충원된다 (0.45초 안에 6명 복귀)',
    reinf.after >= reinf.afterKill + 5 && reinf.reserve1 <= reinf.reserve0 - 5 && reinf.corpses1 > 0, reinf);

  /* ===== 6c. 상세 모델 슬롯 — 카메라 코앞 병사가 블록 실루엣으로 떨어지지 않는다 ===== */
  const lod = await page.evaluate(() => {
    const app = window.BA.app, b = window.BA.battle;
    app.paused = true;
    const p = b.player;
    p.x = 0; p.z = 0; p.yaw = 0; app.camYaw = Math.PI; app.camPitch = 0;
    const all = b.units.filter((u) => !u.isPlayer && !u.dead && u.cls === 'soldier');
    const near = all.slice(-12);          // 목록 맨 뒤(=예전엔 슬롯을 못 받던) 12명
    let k = 0;
    for (const u of all) {
      if (near.includes(u)) {
        const a = (k / near.length) * Math.PI * 2;
        u.x = Math.sin(a) * 5; u.z = Math.cos(a) * 5; k++;
        u.moveAmt = 0;
      } else { u.x = 300 + (k++ % 40) * 3; u.z = 300; }
    }
    const bucket = app.unitRenderer.buckets.soldier;
    const rest = bucket.filter((u) => !near.includes(u));
    app.unitRenderer.buckets.soldier = rest.concat(near);
    app.unitRenderer.classes.soldier.units = app.unitRenderer.buckets.soldier;
    app.updateCamera(1 / 60);
    app.unitRenderer.update(app.unitRenderer.buckets.soldier, app.cam.position, app.time, 1 / 60);
    const rows = near.map((u) => ({ id: u.id, d: +Math.hypot(u.x, u.z).toFixed(1), dslot: u.dslot, tier: u._tier }));
    return {
      total: bucket.length, dcap: app.unitRenderer.classes.soldier.dcap,
      near: rows.length, detailed: rows.filter((r) => r.dslot >= 0).length,
      blocks: rows.filter((r) => r.dslot < 0).length, rows
    };
  });
  ok('상세 예산이 꽉 차도 카메라 코앞 병사는 블록 실루엣이 아니라 상세 모델로 그려진다',
    lod.near === 12 && lod.detailed === 12 && lod.blocks === 0 && lod.total > lod.dcap,
    { total: lod.total, dcap: lod.dcap, detailed: lod.detailed, blocks: lod.blocks, rows: lod.rows.slice(0, 4) });

  /* ===== 7. 결과 미니 카드 ===== */
  await page.evaluate(() => window.BA.app._finish('ally'));
  await sleep(120);
  const resBox = await page.evaluate(() => {
    const r = document.getElementById('result');
    const c = r.querySelector('.result-card');
    const b = c.getBoundingClientRect();
    const cs = getComputedStyle(r);
    return {
      on: r.classList.contains('is-on'), w: Math.round(b.width), h: Math.round(b.height),
      x: Math.round(b.x), y: Math.round(b.y), bottom: Math.round(b.bottom),
      bg: cs.backgroundColor, blur: cs.backdropFilter, area: Math.round((b.width * b.height) / (390 * 844) * 100)
    };
  });
  ok('승리 결과는 화면을 가리지 않는 미니 카드 (딤드 없음 · 중앙 비움)'.replace('중앙 비움', '작은 크기'),
    resBox.on && resBox.w <= 310 && resBox.h < 210 && resBox.area < 13 &&
    (resBox.bg === 'rgba(0, 0, 0, 0)' || resBox.bg === 'transparent'), resBox);
  await shot('44-result-mini.png');
  const closed = await page.evaluate(() => {
    document.getElementById('resClose').click();
    const app = window.BA.app;
    return { on: document.getElementById('result').classList.contains('is-on'), mode: app.camMode, paused: app.paused };
  });
  ok('✕ 로 닫으면 결과창이 사라지고 전장을 자유롭게 구경한다',
    closed.on === false && closed.mode === 'spectate' && closed.paused === false, closed);
  await sleep(200);
  await shot('47-after-result-close.png');

  ok('콘솔/페이지 오류 0 (헤드리스 SwiftShader)', errors.length === 0, errors.slice(0, 5));
  console.log(`\n모든 테스트 통과 (${passed}개) · 스크린샷 ${SHOTS}`);
  await browser.close();
  stop();
  process.exit(0);
})().catch(async (e) => {
  console.error('테스트 실패:', e && e.message);
  try { process.exit(1); } catch (err) { /* noop */ }
});
