'use strict';

/* 영토 전쟁 ONLINE · 3D 칼싸움 전장(Three.js) 모바일 검증 — 1인칭 + 🎬 관전 개조판
   - 390×844 세로(portrait) 터치 뷰포트 + SwiftShader WebGL
   - 1부: 서버 참전 흐름 — 3D 아레나 진입 / 1인칭 눈높이 / 조이스틱은 시점을 돌리지 않음
   - 2부: 결정적 1인칭 검증 — 방패 없는 오른손 검 뷰모델, 오른쪽→왼쪽 / 왼쪽→오른쪽 가로 횡베기,
           칼이 지나가는 순간 절단·스파크(히트스톱)와 '한 번에 적 1명만', 수평에 가까운 3D 두 동강,
           아군·적군 완전 동일 스펙(체력·공격력·속도) 미러 대결, 검기 겹(코어·엣지·빛무리·잔상·파동),
           베기가 끝나면 검기·칼날 궤적 리본이 0으로 사라짐, 오른쪽 화면은 드래그/스와이프/탭 모두 시점 전용
           (공격은 오직 ⚔️ 베기 버튼), 병사 분리·산개(최소 간격 r*2.2)와 스폰 간격,
           🎬 관전 모드(전장 위 자유 비행 카메라 · 전투 버튼/뷰모델 숨김 · 피격 없음 · ⚔️ 참전 복귀),
           🔁 다시 싸우기
   - 3부: 홈 화면 적군/아군 병사 수(각 최대 1000) → 그 수 그대로 대형 전장 시작
   - 4부: Three.js/WebGL 이 없을 때 2D 자동 폴백
   - 콘솔/페이지 오류 0, 스크린샷 -> screenshots/
*/

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = '/workspace/territory-war-online';
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 3588;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) { /* noop */ }
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch (e) { /* noop */ } };
  process.on('exit', stop);
  await sleep(900);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
    else if (m.type() === 'warning' || m.type() === 'warn') console.log('  · warn ' + m.text().slice(0, 160));
  });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

  const results = [];
  const T0 = Date.now();
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + '  (' + ((Date.now() - T0) / 1000).toFixed(0) + 's)' +
      (cond ? '' : '  ' + JSON.stringify(extra === undefined ? null : extra)));
  };
  const frames = (n, t) => page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().frames >= k;
  }, { timeout: t || 60000 }, n).then(() => true).catch(() => false);
  const waitPieces = (n) => page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.piecesInfo().length >= k;
  }, { timeout: 60000 }, n).then(() => true).catch(() => false);
  const waitNoPieces = () => page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.piecesInfo().length === 0;
  }, { timeout: 90000 }).catch(() => false);
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
  const fnow = () => page.evaluate(() => {
    const st = window.TWArena.state();
    return st && st.r3d ? st.r3d.info().frames : -1;
  });
  const more = async (n) => { const f = await fnow(); return f < 0 ? false : frames(f + n); };

  /* ============ 0. 모듈 ============ */
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
  const mod = await page.evaluate(() => ({
    loaded: !!window.TWArena3D,
    supported: window.TWArena3D ? window.TWArena3D.supported() : false,
    rev: window.TWArena3D ? window.TWArena3D.revision : null,
    vendor: performance.getEntriesByType('resource')
      .filter((r) => /three\.module/.test(r.name))
      .map((r) => ({ n: r.name, kb: Math.round(r.transferSize / 1024) }))
  }));
  ok('Three.js 로컬 번들(public/vendor) 로드 · WebGL 사용 가능', mod.loaded && mod.supported && mod.vendor.length > 0, mod);
  ok('외부 CDN 없이 로컬 vendor 의 three r169 를 쓴다',
    mod.rev === '169' && mod.vendor.every((v) => /\/vendor\/three\.module\.min\.js$/.test(v.n)), mod.vendor);

  const viewBtn = await page.evaluate(() => {
    const b = document.getElementById('arView');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { text: b.textContent.trim(), label: b.getAttribute('aria-label'), display: cs.display, cls: b.className };
  });
  ok('아레나 HUD 에 🎬 관전 전환 버튼이 있다',
    !!viewBtn && /관전/.test(viewBtn.text) && viewBtn.display !== 'none', viewBtn);

  /* ============ 1부. 서버 참전 흐름 (1인칭) ============ */
  await page.evaluate(() => { window.__TW_KEEP_RES__ = true; window.__TW_SAMPLE__ = true; document.getElementById('nameInput').value = '한윤'; });
  await page.click('#btnSim');
  await page.waitForFunction(() => window.__TW__ && window.__TW__.state(), { timeout: 20000 });
  await sleep(1100);
  await page.evaluate(() => {
    const st = window.__TW__.state();
    const counts = [0, 1, 2, 3].map((i) => st.regions.filter((r) => r.owner === i).length);
    let best = 0;
    for (let i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i;
    const btn = document.querySelector('.sp-nation[data-slot="' + best + '"]');
    if (btn) btn.click();
  });
  await sleep(320);
  await page.click('#btnJump');
  await page.waitForFunction(() => window.__TW__.state() && window.__TW__.state().you >= 0, { timeout: 15000 });
  await sleep(900);

  let live = null;
  for (let attempt = 0; attempt < 4 && !live; attempt++) {
    const ready = await page.evaluate(() => {
      if (window.TWArena && window.TWArena.isOpen()) window.TWArena.close();
      const row = document.getElementById('skirmishRow');
      const btn = document.getElementById('btnSkirmish');
      return !!(row && row.className.indexOf('hidden') < 0 && btn && !btn.disabled);
    });
    if (!ready) { await sleep(2500); continue; }
    await page.click('#btnSkirmish');
    const opened = await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (!opened) { await sleep(1200); continue; }
    if (!(await frames(3))) { await sleep(800); continue; }
    const snap = await page.evaluate(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return null;
      const r = st.r3d;
      const c3 = document.getElementById('arenaCanvas3d');
      return {
        mode: window.TWArena.mode(), kind: r.kind, rev: r.rev,
        canvas3d: { w: c3.width, h: c3.height, cw: c3.clientWidth, ch: c3.clientHeight, display: c3.style.display },
        glVersion: r.renderer.getContext().getParameter(r.renderer.getContext().VERSION),
        info: r.info(), units: r.unitsInfo().length,
        sim: { enemies: st.enemies.length, allies: st.allies.length, obstacles: st.obstacles.length },
        px: st.player.x, py: st.player.y, face: st.player.face,
        cam: r.camera.position.toArray(),
        camAtPlayer: Math.hypot(r.camera.position.x - (st.player.x - st.cfg.w / 2),
          r.camera.position.z - (st.player.y - st.cfg.h / 2)),
        vm: { meshes: r.viewmodel.meshes, visible: r.info().fp.viewmodelVisible, shield: r.viewmodel.shieldArm }
      };
    });
    if (!snap) { await sleep(800); continue; }
    live = snap;

    await shot('17-arena3d.png');
    await page.evaluate(() => document.getElementById('arBack').click()).catch(() => {});
    const closed = await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 15000 })
      .then(() => true).catch(() => false);
    live.back = await page.evaluate(() => ({
      mode: window.TWArena.mode(),
      canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display,
      arena3dClass: document.body.classList.contains('arena-3d'),
      map: !!window.__TW__.state()
    }));
    live.closed = closed;
  }

  ok('서버 참전 → 아레나가 1인칭 3D(WebGL2)로 열린다',
    !!live && live.mode === '3d' && live.kind === 'three' && /WebGL/.test(live.glVersion),
    live && { mode: live.mode, gl: live.glVersion });
  ok('3D 캔버스가 390×844 세로 화면을 꽉 채운다',
    !!live && live.canvas3d.display === 'block' && live.canvas3d.cw === 390 && live.canvas3d.ch === 844,
    live && live.canvas3d);
  ok('1인칭 카메라가 병사 눈높이(≈20) · 플레이어 위치에 있다',
    !!live && Math.abs(live.cam[1] - 20.5) < 3.5 && live.camAtPlayer < 3,
    live && { cam: live.cam.map((v) => +v.toFixed(1)), dist: +(live.camAtPlayer || 0).toFixed(2) });
  ok('내 3인칭 몸 대신 손에 든 검 뷰모델이 보인다 (1인칭 · 방패 없음)',
    !!live && live.vm.meshes >= 8 && live.vm.visible && live.vm.shield === null, live && live.vm);
  ok('병사를 인스턴싱으로 그린다 (드로우콜 260 이하로 다수 병사)',
    !!live && live.info.calls > 30 && live.info.calls < 260 && live.info.triangles > 3000,
    live && { calls: live.info.calls, tri: live.info.triangles });
  ok('🗺️ 지도로 복귀하면 3D 아레나가 닫히고 지도로 돌아온다',
    !!live && live.closed && live.back.mode === 'none' && live.back.canvas3d === 'none' &&
    !live.back.arena3dClass && live.back.map, live && live.back);

  /* ============ 2부. 결정적 1인칭 검증 ============ */
  await page.evaluate(() => {
    window.TWArena.forceClose = function () {};
    window.TWArena.applyUpdate = function () {};
    window.TWArena.finish = function () {};
  });
  const opened = await page.evaluate(() => window.TWArena.open({
    id: 't3d', seed: 90210, w: 280, h: 600, enemyCount: 12, allyCount: 0, maxKills: 12,
    me: { slot: 0, name: '한윤', color: '#3b82f6' },
    enemy: { slot: 1, name: '바람', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '바람', troops: 4 }
  }, {}));
  await frames(4);
  await page.evaluate(() => { const st = window.TWArena.state(); if (st) st.timeLimit = 9e9; });
  await sleep(200);
  ok('3D 아레나 직접 개시 (결정적 검증용)', opened === true && await page.evaluate(() => !!window.TWArena.state()));

  const fp = await page.evaluate(() => {
    const st = window.TWArena.state();
    const r = st.r3d;
    const i = r.info();
    const v = r.viewmodel;
    let shieldMeshes = 0;
    v.scene.traverse((o) => { if (o.isMesh && /shield/.test(o.name || '')) shieldMeshes++; });
    return {
      mode: window.TWArena.mode(),
      eye: i.fp.eye, camY: i.camera.y, camX: i.camera.x, camZ: i.camera.z,
      px: st.player.x, py: st.player.y, yaw: i.fp.yaw, face: st.player.face, pitch: i.fp.pitch,
      fov: i.camera.fov, aspect: i.canvas.cw / i.canvas.ch,
      vmMeshes: v.meshes, vmVisible: !!v.group.visible,
      swordZ: (v.armRoot || v.swordArm).position.z, swordX: (v.armRoot || v.swordArm).position.x,
      shieldArm: v.shieldArm, shieldMeshes: shieldMeshes,
      hierarchy: i.fp.hierarchy, tip: i.fp.tip,
      shouldPivot: !!v.shoulderPivot, elbowPivot: !!v.elbowPivot, wristPivot: !!v.wristPivot,
      graphics: i.graphics, brightness: i.brightness,
      playerGroupRendered: !!document.querySelector('#arenaCanvas3d')
    };
  });
  ok('카메라가 1인칭 눈높이(eye≈20.5)에 있고 시점은 face 와 일치',
    fp.mode === '3d' && Math.abs(fp.camY - 20.5) < 3 && Math.abs(fp.yaw - fp.face) < 0.001,
    { camY: +fp.camY.toFixed(2), yaw: +fp.yaw.toFixed(3), face: +fp.face.toFixed(3) });
  ok('카메라가 플레이어 머리 위치에 있다 (x·z 일치 · 세로 화면 fov 72~92)',
    Math.hypot(fp.camX - (fp.px - 140), fp.camZ - (fp.py - 300)) < 2.5,
    { cam: [+fp.camX.toFixed(1), +fp.camZ.toFixed(1)], player: [fp.px - 140, fp.py - 300] });
  ok('오른손 검 뷰모델이 어깨→팔꿈치→손목 계층으로 화면 안에 놓인다 (방패 없음)',
    fp.vmVisible && fp.vmMeshes >= 18 && fp.shouldPivot && fp.elbowPivot && fp.wristPivot &&
    fp.swordZ < -2.5 && fp.swordX > 0.4 &&
    fp.shieldArm === null && fp.shieldMeshes === 0 &&
    Array.isArray(fp.hierarchy) && fp.hierarchy.join('>') === 'shoulderPivot>elbowPivot>wristPivot>sword',
    { meshes: fp.vmMeshes, sword: [fp.swordX, fp.swordZ], hierarchy: fp.hierarchy, shieldArm: fp.shieldArm });
  ok('아침 하늘섬 — 밝은 하늘 · 햇살 그림자 · 구름 · 떠 있는 섬 · 공중 먼지',
    fp.graphics.sky === 'morning-island' && fp.graphics.env === true && fp.graphics.lights >= 4 &&
    fp.graphics.dust >= 100 && fp.graphics.steelMetal >= 0.9 && fp.graphics.vmSteelMetal >= 0.9 &&
    fp.graphics.shadows === true && fp.graphics.shadowMap >= 1024 &&
    fp.graphics.clouds >= 24 && fp.graphics.farIslands >= 6 &&
    fp.graphics.hemi > 0.5 && fp.graphics.sun > 1.5,
    fp.graphics);
  const lit = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().brightness.at > 0;
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  const bright = await page.evaluate(() => {
    const st = window.TWArena.state();
    return st && st.r3d ? st.r3d.info().brightness : null;
  });
  ok('화면이 실제로 밝다 (아침 햇살 · 평균 휘도 110 이상 · 하늘 120 이상)',
    lit && bright && bright.lum > 110 && bright.sky > 120, bright);
  ok('세로 화면(390×844) 시야각이 확보된다 (수직 72~96° · 수평 45°+)',
    fp.fov >= 72 && fp.fov <= 96 &&
    (2 * Math.atan(Math.tan((fp.fov * Math.PI) / 360) * fp.aspect) * 180 / Math.PI) >= 45,
    { fov: +fp.fov.toFixed(1), aspect: +fp.aspect.toFixed(3) });

  // 왼쪽 조이스틱 = 시점 기준 이동 (시점은 그대로)
  const beforeWalk = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 140; st.player.y = 300; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.hp = st.player.maxHp; st.down = 0; st.player.atkCd = 0;
    return { x: st.player.x, y: st.player.y, face: st.player.face };
  });
  await page.mouse.move(90, 620);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(90, 620 - k * 12);
  await more(6);
  const afterWalk = await page.evaluate(() => {
    const st = window.TWArena.state();
    if (!st || !st.r3d) return null;
    return {
      x: st.player.x, y: st.player.y, face: st.player.face,
      camYaw: st.r3d.info().fp.yaw,
      joy: !document.getElementById('arJoy').className.includes('hidden')
    };
  });
  await page.mouse.up();
  await more(2);
  const walkDx = afterWalk ? afterWalk.x - beforeWalk.x : 0;
  const walkDy = afterWalk ? afterWalk.y - beforeWalk.y : 0;
  ok('왼쪽 드래그 조이스틱 = 지금 보는 방향으로 이동 (시점은 안 돌아간다)',
    !!afterWalk && afterWalk.joy && Math.hypot(walkDx, walkDy) > 6 &&
    Math.abs(walkDy) > Math.abs(walkDx) && walkDy > 0 &&
    Math.abs(afterWalk.face - beforeWalk.face) < 0.01 &&
    Math.abs(afterWalk.camYaw - beforeWalk.face) < 0.05,
    afterWalk && {
      moved: [+walkDx.toFixed(1), +walkDy.toFixed(1)],
      faceDelta: +(afterWalk.face - beforeWalk.face).toFixed(4)
    });

  // 오른쪽 드래그 = 시점 회전 (걷지 않는다)
  const beforeLook = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.player.x = 140; st.player.y = 300; st.player.face = Math.PI / 2; st.player.pitch = 0;
    return { x: st.player.x, y: st.player.y, face: st.player.face };
  });
  await more(2);
  await page.mouse.move(300, 480);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(300 - k * 14, 480);
  await page.mouse.up();
  await more(4);
  const afterLook = await page.evaluate(() => {
    const st = window.TWArena.state();
    if (!st || !st.r3d) return null;
    return { x: st.player.x, y: st.player.y, face: st.player.face, yaw: st.r3d.info().fp.yaw, pitch: st.player.pitch };
  });
  ok('오른쪽 드래그로만 시점이 돌아간다 (걷지 않고 회전)',
    !!afterLook && Math.abs(afterLook.face - beforeLook.face) > 0.3 &&
    Math.abs(afterLook.yaw - afterLook.face) < 0.05 &&
    Math.hypot(afterLook.x - beforeLook.x, afterLook.y - beforeLook.y) < 3,
    afterLook && {
      turned: +(afterLook.face - beforeLook.face).toFixed(2),
      walk: +Math.hypot(afterLook.x - beforeLook.x, afterLook.y - beforeLook.y).toFixed(1)
    });

  // 위아래 드래그 = 고개 숙임/들기 (제한 범위)
  await page.mouse.move(300, 480);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(300, 480 + k * 12);
  await page.mouse.up();
  await more(2);
  const pitchDown = await page.evaluate(() => window.TWArena.state().player.pitch);
  ok('오른쪽 위아래 드래그로 고개를 숙이고 든다 (제한 -1.05~0.9rad)',
    pitchDown < -0.2 && pitchDown >= -1.06, +pitchDown.toFixed(2));

  // 정면에 적 3명 → ⚔️ 베기 (한 대에 한 명만 · 체력 가득이어도)
  const setup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.forEach((e) => { e.dead = true; });
    st.enemies.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    // 시작 지점 근처 = 장애물이 없는 곳이라 적이 밀려나지 않는다 (정확한 판정 검증)
    st.player.x = 140; st.player.y = 130; st.player.face = 0; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    st.corpses.length = 0; st.cuts.length = 0; st.particles.length = 0; st.slashes.length = 0;
    document.getElementById('arDown').classList.add('hidden');
    for (let i = 0; i < 3; i++) {
      st.enemies.push({
        team: 'enemy', x: 140 + 34 + i * 6, y: 130 + (i - 1) * 9, tag: i,
        r: 8.4, hp: 76, maxHp: 76, speed: 0.0001, face: Math.PI, cd: 99999, wind: 0,
        swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null, dashHit: false, wob: 0
      });
    }
    // 엔진과 같은 규칙으로 '누가 맞아야 하는지' 미리 계산 (정면 우선 · 다음 가까운 쪽)
    const pl = st.player;
    const scored = st.enemies.map((en) => {
      const dx = en.x - pl.x, dy = en.y - pl.y;
      const dist = Math.hypot(dx, dy);
      let off = Math.abs(Math.atan2(dy, dx) - pl.face);
      if (off > Math.PI) off = Math.PI * 2 - off;
      return { tag: en.tag, score: off * 1.6 + (dist / 66) * 0.9, dist: +dist.toFixed(1), off: +off.toFixed(2) };
    }).sort((a, b) => a.score - b.score);
    return { kills: st.kills, hpBars: st.hud.hpBars, top: scored[0], order: scored.map((s) => s.tag) };
  });
  await page.click('#arSlash');
  await waitPieces(2);
  await more(1);
  const slash = await page.evaluate(() => {
    const st = window.TWArena.state();
    const pcs = st.r3d.piecesInfo();
    return {
      kills: st.kills, slashes: st.slashes.length, slashViews: st.r3d.info().slashes,
      cuts: st.r3d.info().cuts, pieces: pcs, hpBars: st.hud.hpBars,
      lastSlice: st.lastSlice, lastSwipe: st.lastSwipe, lastHitAt: st.lastHitAt,
      enemies: st.enemies.length, enemyHp: st.enemies.map((e) => e.hp),
      survivors: st.enemies.map((e) => e.tag),
      fx: st.r3d.info().slashFx,
      particles: st.particles.slice(0, 40).map((p) => p.color),
      playerDmgFloat: st.floats.filter((f) => /^-\d/.test(f.text)).length
    };
  });
  ok('⚔️ 베기 → 1인칭 화면에 3D 검기 메시가 그려진다', slash.slashes > 0 && slash.slashViews > 0,
    { sim: slash.slashes, mesh: slash.slashViews });
  ok('한 번의 베기로 적은 딱 한 명만 베인다 (범위 안 3명 중 1명)',
    slash.kills - setup.kills === 1 && slash.enemies === 2,
    { kills: slash.kills - setup.kills, enemiesLeft: slash.enemies, hp: slash.enemyHp });
  ok('그 한 명은 가장 정면에 선 적이다 (가운데 적만 두 동강)',
    !!setup.top && slash.survivors.indexOf(setup.top.tag) < 0 &&
    slash.survivors.length === 2,
    { top: setup.top, order: setup.order, survivors: slash.survivors, hit: slash.lastHitAt });
  ok('베어낸 적이 3D 조각 2개로 갈라진다 (1명당 정확히 2조각)',
    slash.pieces.length === (slash.kills - setup.kills) * 2 && slash.pieces.length >= 2,
    { pieces: slash.pieces.length, kills: slash.kills - setup.kills });
  ok('검기에 코어·엣지·빛무리·잔상·파동 겹이 함께 그려진다',
    !!slash.fx && slash.fx.layers >= 6 && slash.fx.coreTex && slash.fx.glowTex && slash.fx.core > 0 && slash.fx.body > 0,
    slash.fx);
  ok('적 체력바 없음 · 피(붉은 파티클) 없음 · 숫자 데미지 없음',
    slash.hpBars === 0 && slash.playerDmgFloat === 0 &&
    slash.particles.every((c) => {
      const m = /rgba?\((\d+),(\d+),(\d+)/.exec(String(c));
      if (!m) return true;
      const r = +m[1], g = +m[2], b = +m[3];
      return !(r > 140 && g < 90 && b < 90);
    }),
    { hpBars: slash.hpBars, dmgNums: slash.playerDmgFloat, colors: slash.particles.slice(0, 6) });
  ok('조각의 절단각이 플레이어 시점(0rad)과 같다',
    slash.pieces.every((p) => Math.abs(p.cut) < 0.001), slash.pieces.map((p) => p.cut));
  ok('기본 베기는 가로 횡베기 — 절단면이 수평에 가까운 얕은 대각선(±1.1~1.4rad)',
    slash.pieces.every((p) => p.tilt < -1.05 && p.tilt > -1.45),
    { tilt: slash.pieces.map((p) => +p.tilt.toFixed(3)), slice: slash.lastSlice && +slash.lastSlice.tilt.toFixed(3) });
  ok('3D 절단면이 칼날을 포함하고 · 법선이 위아래로 기운다 (대각선 절단면)',
    slash.pieces.every((p) => Math.abs(p.localN.nx) < 0.001) &&
    slash.pieces.every((p) => Math.abs(p.localN.ny - p.side * Math.sin(p.tilt)) < 0.02) &&
    slash.pieces.every((p) => Math.abs(p.localN.nz - p.side * Math.cos(p.tilt)) < 0.02),
    slash.pieces.map((p) => ({ n: [+p.localN.nx.toFixed(2), +p.localN.ny.toFixed(2), +p.localN.nz.toFixed(2)], side: p.side })));
  ok('절단면 심은 붉은 살점이 아니라 검은 심 + 푸른 빛',
    slash.pieces.every((p) => p.core === '#9fd8ff'), slash.pieces.map((p) => p.core));
  ok('조각은 실제 잘린 병사 메시다 (조각당 파트 5개+)',
    slash.pieces.every((p) => p.parts >= 5), slash.pieces.map((p) => p.parts));
  ok('절단 섬광 판이 함께 그려진다', slash.cuts > 0, slash.cuts);
  await shot('18-arena3d-slash.png');

  await sleep(500);
  const flying = await page.evaluate(() => ({ pieces: window.TWArena.state().r3d.piecesInfo() }));
  if (flying.pieces.length >= 2) {
    const a = flying.pieces[0], b = flying.pieces[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const alongCut = Math.abs((dx * Math.cos(a.cut) + dy * Math.sin(a.cut)) / Math.max(0.0001, dist));
    ok('두 조각이 칼날 수직 방향으로 벌어진다', dist > 3 && alongCut < 0.4,
      { dist: Math.round(dist), alongCut: +alongCut.toFixed(2) });
    ok('조각이 공중으로 떠올라 회전한다 (높이·회전각 변화)',
      flying.pieces.every((p) => p.height > 3) && flying.pieces.some((p) => p.height !== 12 || p.rot !== 0),
      flying.pieces.map((p) => ({ h: Math.round(p.height), rot: +p.rot.toFixed(2) })));
  } else {
    ok('두 조각이 칼날 수직 방향으로 벌어진다', false, flying.pieces.length);
    ok('조각이 공중으로 떠올라 회전한다 (높이·회전각 변화)', false, flying.pieces.length);
  }
  const pc = await page.evaluate(() => {
    const st = window.TWArena.state();
    return st.r3d.project(st.player.x + 30, st.player.y, 16);
  });
  await page.screenshot({
    path: path.join(SHOTS, '19-arena3d-split.png'),
    clip: {
      x: Math.max(0, Math.min(390 - 280, pc.x - 140)),
      y: Math.max(0, Math.min(844 - 260, pc.y - 150)),
      width: 280, height: 260
    }
  }).catch(() => {});
  ok('약 1초 뒤 3D 조각이 사라지고 메시가 정리된다', await waitNoPieces(),
    await page.evaluate(() => (window.TWArena.state() ? window.TWArena.state().r3d.piecesInfo().length : 'closed')));

  /* --- 이어서 베어도 한 번에 한 명씩 --- */
  await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.player && st.player.atkCd <= 0 && st.player.atkAnim <= 0;
  }, { timeout: 30000 }).catch(() => {});
  const k0 = await page.evaluate(() => window.TWArena.state().kills);
  await page.click('#arSlash');
  await waitPieces(2);
  await more(1);
  const second = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, enemies: st.enemies.length, pieces: st.r3d.piecesInfo().length };
  });
  ok('콤보로 이어 베어도 한 대에 한 명씩 (3명 중 2명만 쓰러지고 1명은 남는다)',
    second.kills - k0 === 1 && second.enemies === 1 && second.pieces === 2, second);
  await waitNoPieces();

  // 오른쪽 화면 짧은 탭 = 시점만 (베기 없음 — 공격은 ⚔️ 베기 버튼으로만)
  const tapSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 150; st.player.y = 340; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.atkAnim = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 150, y: 340 + 40, r: 8.4, hp: 10, maxHp: 76, speed: 0.0001,
      face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 9e9, dead: false, dashHit: false, wob: 0
    });
    return { kills: st.kills, face: st.player.face, pitch: st.player.pitch, slashes: st.slashes.length };
  });
  const tapPos = await page.evaluate(() => ({ x: 258, y: 540 }));
  await page.mouse.move(tapPos.x, tapPos.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await more(3);
  const tapped = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills, enemies: st.enemies.length, pending: !!st.pending,
      atk: Math.round(st.player.atkAnim), face: st.player.face, pitch: st.player.pitch,
      slashes: st.slashes.length, views: st.r3d.info().slashes
    };
  });
  ok('오른쪽 화면 짧은 탭 → 베지 않는다 (시점도 그대로 · 공격은 ⚔️ 베기 버튼뿐)',
    tapped.kills === tapSetup.kills && tapped.enemies === 1 && tapped.slashes === 0 &&
    tapped.views === 0 && tapped.atk === 0 && tapped.pending === false &&
    Math.abs(tapped.face - tapSetup.face) < 0.02 && Math.abs(tapped.pitch - tapSetup.pitch) < 0.02,
    tapped);

  // ⚔️ 베기 버튼 = 유일한 공격 수단 · 칼이 적을 지나가는 순간에 판정
  await page.click('#arSlash');
  // 누르자마자: 베기는 시작했지만 칼날이 아직 닿기 전 — 적은 그대로
  const justAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills, enemies: st.enemies.length, pending: !!st.pending,
      atk: Math.round(st.player.atkAnim), face: st.player.face, swing: st.player.swipe
    };
  });
  ok('⚔️ 베기 버튼 — 칼이 닿기 전에는 적이 아직 서 있다 (판정이 칼날 통과 순간으로 미뤄진다)',
    justAfter.kills === tapSetup.kills && justAfter.enemies === 1 && justAfter.pending === true && justAfter.atk > 300,
    justAfter);
  await waitPieces(2);
  const slashed = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, slashes: st.slashes.length, face: st.player.face };
  });
  ok('⚔️ 베기 버튼 → 칼이 지나가며 적이 베인다 (시점은 그대로)',
    slashed.kills > tapSetup.kills && Math.abs(slashed.face - tapSetup.face) < 0.02, slashed);

  /* --- 1인칭 검 궤적: 오른쪽으로 치켜들기 → 가로 횡베기(적을 관통) → 왼쪽 끝 → 회수 --- */
  await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.player.atkAnim = 0; st.player.atkCd = 0; st.player.dash = 0;
    st.player.swipe = { sx: -0.985, sy: 0.16 };
    document.getElementById('arDown').classList.add('hidden');
  });
  await more(2);
  /* 자세를 한 지점에 '고정'해 가며 검끝이 화면 어디를 지나는지 잰다
     (atkAnim 을 읽기 전용으로 바꿔 시뮬레이션이 깎아내지 못하게) */
  const sweep = await page.evaluate(async () => {
    const st = window.TWArena.state();
    const out = [];
    const dur = st.r3d.info().fp.atkDur;
    for (let i = 0; i <= 16; i++) {
      const pv = i / 16;
      const v = dur * (1 - pv);
      Object.defineProperty(st.player, 'atkAnim', { configurable: true, get() { return v; }, set() {} });
      st.player.atkCd = 9e9; st.player.swipe = { sx: -0.985, sy: 0.16 };
      for (let k = 0; k < 4; k++) await new Promise((r) => requestAnimationFrame(() => r()));
      const i2 = st.r3d.info().fp;
      out.push({ p: +pv.toFixed(3), x: +i2.tip.nx.toFixed(3), y: +i2.tip.ny.toFixed(3), q: i2.quat, eb: +i2.elbow.toFixed(3), z: +i2.tip.nz.toFixed(3), bs: i2.bladeScreen });
    }
    delete st.player.atkAnim;
    st.player.atkAnim = 0;
    st.player.swipe = { sx: -0.985, sy: 0.16 };
    return out;
  });
  const qAng = (a, b) => {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
  };
  const steps = [];
  for (let i = 1; i < sweep.length; i++) {
    steps.push(Math.hypot(sweep[i].x - sweep[i - 1].x, sweep[i].y - sweep[i - 1].y));
  }
  const maxStep = Math.max.apply(null, steps);
  const xs = sweep.map((r2) => r2.x);
  const spread = Math.max.apply(null, xs) - Math.min.apply(null, xs);
  const iMaxX = xs.indexOf(Math.max.apply(null, xs));
  const iMinX = xs.indexOf(Math.min.apply(null, xs));
  const shMax = Math.max.apply(null, sweep.slice(1).map((r2, i) => qAng(r2.q.sh, sweep[i].q.sh)));
  const wrMax = Math.max.apply(null, sweep.slice(1).map((r2, i) => qAng(r2.q.wr, sweep[i].q.wr)));
  ok('검 모션 1 — 1타는 오른쪽으로 치켜든 뒤 왼쪽 끝까지 가로지른다 (폭 0.45 이상)',
    spread > 0.45 && iMaxX < iMinX && Math.max.apply(null, xs) > 0.75 && Math.min.apply(null, xs) < 0.15,
    { spread: +spread.toFixed(2), rightAt: iMaxX, leftAt: iMinX, xs: xs.map((v) => +v.toFixed(2)) });
  ok('검 모션 2 — 매 프레임 이동이 매끄럽다 (화면 폭의 58% 이내 · 순간이동 없음)',
    maxStep < 0.58, { maxStep: +maxStep.toFixed(3) });
  ok('검 모션 3 — 어깨·손목 회전이 한 번에 65° 넘게 튀지 않는다 (짐벌락/축 뒤집힘 없음)',
    shMax < 45 && wrMax < 65, { shoulderStep: +shMax.toFixed(1), wristStep: +wrMax.toFixed(1) });
  ok('검 모션 4 — 내려치는 동안 검끝이 화면 가운데를 스친다 (1인칭 시야를 가로지름)',
    sweep.some((r2) => Math.abs(r2.x - 0.5) < 0.3 && r2.y > 0.2 && r2.y < 0.9),
    sweep.filter((r2) => Math.abs(r2.x - 0.5) < 0.3).map((r2) => [r2.x, r2.y]));
  ok('검 모션 5 — 동작이 끝나면 기본 자세로 정확히 돌아온다',
    Math.abs(sweep[sweep.length - 1].x - sweep[0].x) < 0.02 &&
    Math.abs(sweep[sweep.length - 1].y - sweep[0].y) < 0.02,
    { start: [sweep[0].x, sweep[0].y], end: [sweep[sweep.length - 1].x, sweep[sweep.length - 1].y] });
  ok('칼이 적을 썰고 지나간다 — 칼날 중간이 적 몸통(화면 가운데)을 지나간다',
    sweep.some((r2) => r2.bs.some((b) => b.x > 0.42 && b.x < 0.58 && b.y > 0.38 && b.y < 0.86)),
    sweep.filter((r2) => r2.bs.some((b) => b.x > 0.42 && b.x < 0.58)).map((r2) => r2.bs.map((b) => [+b.x.toFixed(2), +b.y.toFixed(2)])));
  ok('칼이 적을 썰고 지나간다 — 적을 지난 뒤에도 멈추지 않고 왼쪽 끝까지 팔로우스루',
    sweep.some((r2) => r2.bs.some((b) => b.x < 0.15 && b.y > 0.45 && b.y < 0.95)),
    sweep.filter((r2) => r2.bs.some((b) => b.x < 0.15)).length);

  /* --- 2타·3타: 누를 때마다 왼쪽 ↔ 오른쪽으로 번갈아 가로지른다 --- */
  const comboHits = [];
  for (const n of [2, 3]) {
    const before = await page.evaluate(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return { closed: true, open: window.TWArena.isOpen() };
      const was = { ended: st.ended, endReason: st.endReason, elapsed: Math.round(st.elapsed), limit: st.timeLimit, time: Math.round(st.time) };
      st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
      st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
      st.player.x = 150; st.player.y = 340; st.player.face = Math.PI / 2; st.player.pitch = 0;
      st.player.atkCd = 0; st.player.dash = 0; st.player.atkAnim = 0;
      st.lastSlashAt = st.time;                 // 연속 베기 중
      document.getElementById('arDown').classList.add('hidden');
      st.enemies.push({
        team: 'enemy', x: 150, y: 340 + 40, r: 8.4, hp: 76, maxHp: 76, speed: 0.0001,
        face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 9e9, dead: false, dashHit: false, wob: 0
      });
      return { kills: st.kills, nextSweep: st.nextSweep, was: was };
    });
    if (before.closed) { ok('아레나가 계속 열려 있다 (연속 베기 검증)', false, before); break; }
    await page.click('#arSlash');
    await waitPieces(2);
    const hit = await page.evaluate(() => {
      const st = window.TWArena.state();
      const i = st.r3d.info().fp;
      return {
        kills: st.kills, swing: st.player.swipe, slice: st.lastSlice, sign: i.swingSign,
        pieces: st.r3d.piecesInfo()
      };
    });
    hit.n = n; hit.before = before;
    comboHits.push(hit);
  }
  ok('2타는 왼쪽 → 오른쪽 역횡베기로 나간다 (절단면도 반대쪽으로 기운다)',
    comboHits[0].swing.sx > 0.9 && comboHits[0].slice.tilt > 1.05 &&
    comboHits[0].pieces.length === 2 && comboHits[0].pieces.every((p) => p.tilt > 1.05),
    { swipe: comboHits[0].swing, tilt: comboHits[0].pieces.map((p) => +p.tilt.toFixed(2)) });
  ok('3타는 다시 오른쪽 → 왼쪽 횡베기로 돌아온다',
    comboHits[1].swing.sx < -0.9 && comboHits[1].slice.tilt < -1.05 &&
    comboHits[1].pieces.every((p) => p.tilt < -1.05),
    { swipe: comboHits[1].swing, tilt: comboHits[1].pieces.map((p) => +p.tilt.toFixed(2)) });
  ok('연속 베기는 누를 때마다 좌↔우가 번갈아 나간다 (궤적 방향도 바뀐다)',
    comboHits[0].sign === 1 && comboHits[1].sign === -1,
    comboHits.map((h) => ({ n: h.n, sign: h.sign, sx: +h.swing.sx.toFixed(2) })));
  await waitNoPieces();

  /* --- 오른쪽 화면 빠른 스와이프(↘) = 베기 없이 시점만 회전 --- */
  const swipeSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.particles.length = 0; st.floats.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 150; st.player.y = 330; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.atkAnim = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 150 + 4, y: 330 + 44, r: 9, hp: 76, maxHp: 76, speed: 0.0001,
      face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 9e9,
      dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills, face: st.player.face, pitch: st.player.pitch, slashes: st.slashes.length };
  });
  // 실제 손가락처럼 빠른 스와이프 ↘ (포인터 이벤트를 한 번에 — 베기가 아니라 시점만 돌아야 한다)
  const swipeDispatch = await page.evaluate(() => {
    const root = document.getElementById('arena');
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 77, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    root.dispatchEvent(mk('pointerdown', 300, 500));
    for (let k = 1; k <= 5; k++) window.dispatchEvent(mk('pointermove', 300 + k * 11, 500 + k * 11));
    window.dispatchEvent(mk('pointerup', 355, 555));
    return true;
  });
  await more(3);
  const swiped = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills, enemies: st.enemies.length, face: st.player.face, pitch: st.player.pitch,
      lastSwipe: st.lastSwipe, pieces: st.r3d.piecesInfo(),
      slashes: st.slashes.length, views: st.r3d.info().slashes, atk: Math.round(st.player.atkAnim)
    };
  });
  ok('오른쪽 빠른 스와이프(↘ 약 55px) → 베지 않는다 (적 그대로 · 검기 0)',
    swipeDispatch && swiped.kills === swipeSetup.kills && swiped.enemies === 1 &&
    swiped.pieces.length === 0 && swiped.slashes === 0 && swiped.views === 0 && swiped.atk === 0,
    { kills: swiped.kills - swipeSetup.kills, pieces: swiped.pieces.length, slashes: swiped.slashes });
  ok('오른쪽 빠른 스와이프 → 그 방향으로 시점이 돌아간다 (스와이프 = 시점 회전 전용)',
    Math.abs(swiped.face - swipeSetup.face) > 0.25 && swiped.pitch < swipeSetup.pitch - 0.15,
    { face: +(swiped.face - swipeSetup.face).toFixed(2), pitch: +(swiped.pitch - swipeSetup.pitch).toFixed(2) });
  await shot('27-fp-swipe-look.png');
  await waitNoPieces();

  /* --- 오른쪽 천천히 드래그 = 베기 없이 시점만 회전 --- */
  const slowSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.atkAnim = 0;
    st.player.x = 150; st.player.y = 330; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.enemies.push({
      team: 'enemy', x: 150, y: 330 + 46, r: 9, hp: 76, maxHp: 76, speed: 0.0001,
      face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 9e9,
      dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills, face: st.player.face };
  });
  await page.mouse.move(300, 470);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(300 - k * 8, 470);
    await sleep(70);
  }
  await page.mouse.up();
  await more(2);
  const slow = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, face: st.player.face, slashes: st.slashes.length, atkAnim: st.player.atkAnim };
  });
  ok('오른쪽 천천히 드래그(80px · 0.7초) → 베기 없이 시점만 돌아간다',
    slow.kills === slowSetup.kills && slow.slashes === 0 &&
    Math.abs(slow.face - slowSetup.face) > 0.3 && slow.atkAnim === 0, slow);

  /* --- 검기 · 칼날 궤적 리본은 베기가 끝나면 화면에서 완전히 사라진다 --- */
  const fadeSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.trails.length = 0; st.particles.length = 0; st.floats.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 150; st.player.y = 330; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.atkAnim = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 150, y: 330 + 44, r: 9, hp: 99999, maxHp: 99999, speed: 0.0001,
      face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 9e9,
      dead: false, lastHitBy: null, dashHit: false, wob: 0, slot: 0
    });
    return { slashes: st.slashes.length, views: st.r3d.info().slashes, trail: st.r3d.info().trail };
  });
  await page.click('#arSlash');
  const fxDuring = await page.evaluate(async () => {
    const st = window.TWArena.state();
    const t0 = performance.now();
    while (performance.now() - t0 < 20000) {
      const i = st.r3d.info();
      if (st.slashes.length > 0 && i.slashes > 0 && i.trail.pts >= 2 && i.trail.visible) {
        return { slashes: st.slashes.length, views: i.slashes, trail: i.trail, atk: Math.round(st.player.atkAnim) };
      }
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    return null;
  });
  ok('베는 동안에는 검기와 칼날 궤적 리본이 그려진다',
    !!fxDuring && fxDuring.views > 0 && fxDuring.trail.pts >= 2 && fxDuring.trail.visible === true, fxDuring);
  await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st.player.atkAnim <= 0 && st.slashes.length === 0;
  }, { timeout: 30000 }).catch(() => {});
  // 페이드 수명(150ms)이 지나도록 잠깐 두고 본다
  await sleep(300);
  await more(4);
  const fxAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    return {
      slashes: st.slashes.length, views: i.slashes, trail: i.trail, atk: Math.round(st.player.atkAnim),
      cuts: st.cuts.length, trails: st.trails.length, frames: i.frames
    };
  });
  ok('베기가 끝나면 검기가 0개로 사라진다 (시뮬레이션 · 3D 메시 모두)',
    fxAfter.slashes === 0 && fxAfter.views === 0 && fxAfter.atk === 0, fxAfter);
  ok('베기가 끝나면 칼날 궤적 리본도 화면에 남지 않는다 (점 0 · 메시 숨김)',
    fxAfter.trail.pts === 0 && fxAfter.trail.visible === false, fxAfter.trail);

  /* --- 병사가 한 곳에 뭉치지 않는다 (분리 · 산개) --- */
  const sepSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = st.cfg.w / 2; st.player.y = st.cfg.h * 0.75; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkAnim = 0; st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    const px = st.player.x, py = st.player.y - 120;
    // 한 점에 20명을 거의 겹친 채로 놓는다 — 분리가 없으면 그대로 한 덩어리로 선다
    for (let i = 0; i < 20; i++) {
      st.enemies.push({
        team: 'enemy', x: px + (i % 4) * 0.4, y: py + Math.floor(i / 4) * 0.4, r: 9,
        hp: 99999, maxHp: 99999, speed: 40, face: Math.PI / 2, cd: 99999,
        wind: 0, swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null, dashHit: false,
        wob: i * 0.7, slot: i * 0.157
      });
    }
    document.getElementById('arDown').classList.add('hidden');
    return { n: st.enemies.length, spec: window.TWArena.spec() };
  });
  await more(24);
  const sepSpread = await page.evaluate(() => {
    const st = window.TWArena.state();
    const all = st.enemies.filter((u) => !u.dead);
    const minD = 9 * 2.2;
    let min = 1e9, packed = 0;
    const near = all.map(() => 0);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y);
        if (d < min) min = d;
        if (d < minD * 0.8) { packed++; near[i]++; near[j]++; }
      }
    }
    const xs = all.map((u) => u.x), ys = all.map((u) => u.y);
    return {
      n: all.length, min: +min.toFixed(2), minD: +minD.toFixed(1), packed,
      worstNbr: near.length ? Math.max.apply(null, near) : 0,
      spreadX: Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)),
      spreadY: Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys))
    };
  });
  ok('한 점에 몰아넣은 병사들이 서로 밀어내며 최소 간격(r*2.2)을 지킨다',
    sepSetup.spec.sep >= 19.7 && sepSpread.n >= 18 && sepSpread.min >= sepSpread.minD * 0.95 && sepSpread.packed === 0,
    sepSpread);
  ok('병사들이 한 덩어리가 아니라 넓게 산개한다 (한 명에 여러 명이 겹치지 않음)',
    sepSpread.worstNbr <= 4 && sepSpread.spreadX > 80 && sepSpread.spreadY > 50, sepSpread);

  // 증원도 겹치지 않고 간격을 두고 등장한다
  const spawnSpread = await page.evaluate(async () => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 0;
    st.player.x = st.cfg.w / 2; st.player.y = st.cfg.h * 0.6;
    const t0 = performance.now();
    while (st.enemies.length < 4 && performance.now() - t0 < 20000) {
      st.spawnTimer = 0;
      await new Promise((r) => setTimeout(r, 70));
    }
    const all = st.enemies.filter((u) => !u.dead);
    let min = 1e9;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        min = Math.min(min, Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y));
      }
    }
    return { n: all.length, min: +min.toFixed(2) };
  });
  ok('증원은 겹치지 않고 간격을 두고 등장한다 (스폰 시 r*2.2 이상)',
    spawnSpread.n >= 4 && spawnSpread.min >= 9 * 2.2 * 0.95, spawnSpread);
  await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
  });

  // 적 칼 휘두름 — 예고(붉은 검기) · 팔 애니메이션
  const windNow = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.particles.length = 0; st.floats.length = 0;
    st.player.hp = st.player.maxHp; st.down = 0; st.player.atkAnim = 0; st.player.dash = 0;
    st.player.x = 140; st.player.y = 196; st.player.face = Math.PI / 2; st.player.pitch = 0.02;
    st.enemies.push({
      team: 'enemy', x: 140, y: 252, r: 9, hp: 999, maxHp: 999,
      speed: 0.0001, face: -Math.PI / 2, cd: 99999, wind: 300, swing: 0,
      hit: 0, stun: 9e9, dead: false, dashHit: false, wob: 0
    });
    return st.r3d.info().frames;
  });
  await frames(windNow + 2);
  const winding = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    return { wind: i.wind, arcs: i.arcs, units: st.r3d.unitsInfo() };
  });
  ok('적이 칼을 치켜들면 붉은 검기(공격 예고)가 1인칭 화면에 보인다',
    winding.wind >= 1 && winding.arcs >= 1 && winding.units.some((u) => u.team === 'enemy' && u.wind > 0),
    { wind: winding.wind, arcs: winding.arcs });
  await shot('20-arena3d-enemy-swing.png');
  const swingNow = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies[0].wind = 0; st.enemies[0].swing = 150;
    return st.r3d.info().frames;
  });
  await frames(swingNow + 2);
  const swinging = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    return { swinging: i.swinging, arcs: i.arcs, crosshair: true };
  });
  ok('적이 칼을 휘두르는 순간에도 검기 메시가 따라온다',
    swinging.swinging >= 1 && swinging.arcs >= 1, swinging);

  // 대각선 절단
  const diag = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 140; st.player.y = 320; st.player.face = 0.62; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 140 + Math.cos(0.62) * 32, y: 320 + Math.sin(0.62) * 32,
      r: 9.2, hp: 8, maxHp: 76, speed: 0.0001, face: 0.62 + Math.PI,
      cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills };
  });
  await page.click('#arSlash');
  await waitPieces(2);
  await more(1);
  const diagPieces = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { pieces: st.r3d.piecesInfo(), kills: st.kills, face: st.player.face };
  });
  ok('대각선(0.62rad) 베기에서도 3D 조각 2개', diagPieces.pieces.length === 2 && diagPieces.kills > diag.kills,
    diagPieces.pieces.length);
  ok('대각선 절단면도 시점 각도(0.62rad)를 따른다',
    diagPieces.pieces.every((p) => Math.abs(p.cut - 0.62) < 0.001), diagPieces.pieces.map((p) => p.cut));
  await shot('21-arena3d-diagonal-split.png');
  await waitNoPieces();

  // 돌진 베기
  const dashBefore = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.corpses.length = 0; st.cuts.length = 0; st.enemies.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 140; st.player.y = 300; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dashCd = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 140, y: 300 + 34, r: 8.4, hp: 15, maxHp: 76,
      speed: 0.0001, face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0,
      dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills, face: st.player.face };
  });
  await page.click('#arDash');
  await waitPieces(2);
  await more(1);
  const dashAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, pieces: st.r3d.piecesInfo(), face: st.player.face };
  });
  ok('💨 돌진 베기로도 적이 3D 두 조각이 된다',
    dashAfter.kills > dashBefore.kills && dashAfter.pieces.length === 2,
    { kills: dashAfter.kills - dashBefore.kills, pieces: dashAfter.pieces.length });
  ok('돌진 방향(π/2)이 절단면 각도가 되고, 쳐다보는 시점은 그대로다',
    dashAfter.pieces.length === 2 && dashAfter.pieces.every((p) => Math.abs(p.cut - Math.PI / 2) < 0.001) &&
    Math.abs(dashAfter.face - dashBefore.face) < 0.001,
    dashAfter.pieces.map((p) => p.cut));
  await waitNoPieces();

  // 막기 자세 (검을 옆으로 가로질러 화면 가운데를 막는다)
  const gpos = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.particles.length = 0; st.floats.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.hp = st.player.maxHp; st.down = 0; st.player.atkAnim = 0; st.player.dash = 0;
    st.player.x = 140; st.player.y = 196; st.player.face = Math.PI / 2; st.player.pitch = 0.02;
    st.enemies.push({
      team: 'enemy', x: 146, y: 262, r: 9, hp: 999, maxHp: 999, speed: 0.0001,
      face: -Math.PI / 2 + 0.2, cd: 99999, wind: 280, swing: 0, hit: 0, stun: 9e9,
      dead: false, dashHit: false, wob: 0
    });
    const r = document.getElementById('arGuard').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight };
  });
  await page.mouse.move(gpos.x, gpos.y);
  await page.mouse.down();
  const guardIn = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().fp.viewmodelGuard > 0.85;
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  const guarding = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    return { guard: st.player.guard, vmGuard: i.fp.viewmodelGuard, sword: i.fp.sword, tip: i.fp.tip, shieldArm: st.r3d.viewmodel.shieldArm };
  });
  await shot('22-arena3d-guard.png');
  await page.mouse.up();
  ok('🛡️ 막기 → 검을 세워 화면 가운데를 가로막는다 (방패 없음)',
    guardIn && guarding.guard === true && guarding.vmGuard > 0.85 &&
    guarding.shieldArm === null && Math.abs(guarding.tip.nx - 0.5) < 0.25,
    { guard: guarding.guard, guardIn: guardIn, vmGuard: +guarding.vmGuard.toFixed(2), tipX: guarding.tip && +guarding.tip.nx.toFixed(2), shieldArm: guarding.shieldArm });

  /* --- 막기는 '꾹 누르고 있는 동안 100%' 막는다 --- */
  const gpos2 = await page.evaluate(() => {
    const r = document.getElementById('arGuard').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(gpos2.x, gpos2.y);
  await page.mouse.down();
  await sleep(120);
  const blockSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.player.hp = st.player.maxHp; st.down = 0;
    st.player.atkAnim = 0;
    st.enemySpawned = 9e9; st.enemies.length = 0;
    st.allies.length = 0; st.allySpawned = 9e9;
    st.blocks = 0;
    st.enemies.push({
      team: 'enemy', x: st.player.x + 4, y: st.player.y + 24, r: 9, hp: 999, maxHp: 999,
      speed: 55, face: -Math.PI / 2, cd: 0, wind: 340, swing: 0, hit: 0, stun: 0,
      dead: false, dashHit: false, wob: 0
    });
    document.getElementById('arDown').classList.add('hidden');
    return { hp: st.player.hp, maxHp: st.player.maxHp };
  });
  // 두 번째 공격까지 기다린다 — 헤드리스 소프트웨어 렌더링은 시뮬레이션이 느리게 도므로
  // (프레임당 50ms 상한) 적의 공격 쿨다운만 앞당겨 검증 자체(두 번 다 100% 막힘)에 집중한다
  const didBlock = await page.evaluate(async () => {
    const st = window.TWArena.state();
    const t0 = performance.now();
    while (performance.now() - t0 < 25000) {
      if ((st.blocks || 0) >= 2) return true;
      for (const e of st.enemies) if (!e.dead && !(e.wind > 0) && !(e.stun > 0)) e.cd = Math.min(e.cd, 0);
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  const blockState = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { hp: st.player.hp, maxHp: st.player.maxHp, blocks: st.blocks || 0, guard: st.player.guard };
  });
  await page.mouse.up();
  ok('🛡️ 꾹 누른 채로 맞으면 100% 막힌다 (체력 그대로 · 막기 횟수 증가)',
    didBlock && blockState.blocks >= 2 && blockState.hp === blockState.maxHp && blockState.guard === true,
    { blocks: blockState.blocks, hp: blockState.hp, maxHp: blockState.maxHp, guard: blockState.guard, setup: blockSetup });

  // 대조군: 막지 않으면 그대로 맞는다
  const hitState = await page.evaluate(async () => {
    const st = window.TWArena.state();
    st.player.guard = false; st.player.guardT = 0;
    st.player.hp = st.player.maxHp;
    st.blocks = 0;
    st.enemies.forEach((e) => { e.cd = 0; e.stun = 0; e.wind = 340; e.swing = 0; });
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && st.player.hp >= st.player.maxHp) {
      await new Promise((r) => setTimeout(r, 60));
    }
    return { hp: st.player.hp, maxHp: st.player.maxHp, blocks: st.blocks || 0 };
  });
  ok('막지 않으면 적의 칼에 체력이 깎인다 (막기와 대조)',
    hitState.hp < hitState.maxHp && hitState.blocks === 0, hitState);

  const guardOut = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().fp.viewmodelGuard < 0.15;
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  ok('막기에서 놓으면 부드럽게 기본 자세로 돌아온다', guardOut,
    await page.evaluate(() => {
      const st = window.TWArena.state();
      return st && st.r3d ? +st.r3d.info().fp.viewmodelGuard.toFixed(2) : -1;
    }));

  /* 긴 테스트 도중 GPU 컨텍스트가 끊기는 경우가 있다 (SwiftShader) — 엔진이 스스로 3D 를 다시 붙이는지 */
  const ensure3d = async () => {
    const alive = () => page.evaluate(() => !!(window.TWArena.state() && window.TWArena.state().r3d));
    if (await alive()) return true;
    await sleep(1800);
    if (await alive()) return true;
    await page.evaluate(() => {
      const st = window.TWArena.state();
      const cfg = (st && st.cfg) || {
        id: 't3d', seed: 90210, w: 280, h: 600, enemyCount: 12, allyCount: 0,
        me: { slot: 0, name: '한윤', color: '#3b82f6' }, enemy: { slot: 1, name: '바람', color: '#ef4444' },
        region: { name: '송천' }, target: { name: '바람', troops: 4 }
      };
      window.TWArena.open(cfg, {});
    });
    await frames(4);
    await page.evaluate(() => { const st = window.TWArena.state(); if (st) st.timeLimit = 9e9; });
    return alive();
  };
  ok('GPU 컨텍스트가 끊겨도 3D 로 다시 붙는다 (2D 폴백 전에 한 번 재시도)', await ensure3d());

  /* ============ 아군·적군 완전 동일 스펙 ============ */
  await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.allies.length = 0; st.corpses.length = 0; st.cuts.length = 0;
    st.enemyTotal = 1; st.enemySpawned = 0; st.spawnTimer = 0; st.winAt = 0; st.timeLimit = 9e9;
    st.allyTotal = 1; st.allySpawned = 0; st.allyStart = 1; st.allyTimer = 0;
    st.player.x = 140; st.player.y = 540;
  });
  const spawned = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.enemies.length === 1 && st.allies.length === 1;
  }, { timeout: 40000 }).then(() => true).catch(() => false);
  const duel0 = await page.evaluate(() => {
    const st = window.TWArena.state();
    const a = st.allies[0], e = st.enemies[0];
    const out = {
      spec: window.TWArena.spec(),
      ally: { hp: a.hp, maxHp: a.maxHp, dmg: a.dmg, r: a.r, speed: a.speed },
      enemy: { hp: e.hp, maxHp: e.maxHp, dmg: e.dmg, r: e.r, speed: e.speed }
    };
    // 시작 지점 근처(장애물이 없는 곳)에서 마주 세운다 (사거리 r+r+17 = 35 안)
    a.x = 140; a.y = 120; a.speed = 0.0001;
    e.x = 140; e.y = 150; e.speed = 0.0001;
    a.cd = 0; e.cd = 0; a.wind = 0; e.wind = 0; a.stun = 0; e.stun = 0;
    a.tgt = null; a.tgtAt = 0; e.tgt = null; e.tgtAt = 0;
    a.hp = a.maxHp; e.hp = e.maxHp;
    window.__origRandom = Math.random;
    Math.random = () => 0.5;           // 둘의 공격 박자를 똑같이 맞춘다
    return out;
  });
  ok('아군·적군 병사 스펙이 완전히 같다 (체력·공격력·몸집·속도)',
    spawned && duel0.ally.maxHp === duel0.enemy.maxHp && duel0.ally.hp === duel0.enemy.hp &&
    duel0.ally.dmg === duel0.enemy.dmg && duel0.ally.r === duel0.enemy.r &&
    Math.abs(duel0.ally.speed - duel0.enemy.speed) < 0.001 &&
    duel0.spec.hp === duel0.ally.maxHp && duel0.spec.dmg === duel0.ally.dmg &&
    duel0.spec.hp === duel0.enemy.maxHp, duel0);
  const duelOk = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.allies[0] && st.enemies[0] && st.allies[0].hp < 100 && st.enemies[0].hp < 100;
  }, { timeout: 60000 }).then(() => true).catch(() => false);
  const duel = await page.evaluate(() => {
    const st = window.TWArena.state();
    const a = st.allies[0], e = st.enemies[0];
    return a && e ? { ally: a.hp, enemy: e.hp, allyMax: a.maxHp, enemyMax: e.maxHp } : null;
  });
  ok('같은 수로 붙으면 팽팽하다 (서로 똑같이 깎인다 · 한 방에 죽지 않는다)',
    duelOk && !!duel && duel.ally === duel.enemy && duel.ally < duel.allyMax, duel);
  await page.evaluate(() => {
    const st = window.TWArena.state();
    Math.random = window.__origRandom || Math.random;
    st.allies.length = 0; st.enemies.length = 0;
    st.allySpawned = 0; st.allyTimer = 9e9; st.enemySpawned = 0; st.spawnTimer = 9e9;
  });

  /* ============ 🎬 관전 모드 ============ */
  const spec0 = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.allies.length = 0; st.allySpawned = 0; st.allyTimer = 9e9;
    st.player.x = 150; st.player.y = 330; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.hp = st.player.maxHp; st.down = 0; st.player.guard = false; st.invuln = 0;
    document.getElementById('arDown').classList.add('hidden');
    for (let i = 0; i < 3; i++) {
      st.enemies.push({
        team: 'enemy', x: 150 + (i - 1) * 18, y: 330 + 26, r: 9, hp: 100, maxHp: 100, dmg: 10,
        speed: 0.0001, face: -Math.PI / 2, cd: 0, wind: 200, swing: 0, hit: 0, stun: 0,
        dead: false, dashHit: false, wob: 0, tgt: st.player, tgtAt: 0
      });
    }
    return { hp: st.player.hp, maxHp: st.player.maxHp, face: st.player.face };
  });
  await page.click('#arView');
  const specOn = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().view.blend > 0.9;
  }, { timeout: 45000 }).then(() => true).catch(() => false);
  // 적들이 표적을 다시 고른다 (관전 중엔 플레이어를 노리지 않는다)
  const retargeted = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.enemies.length > 0 && st.enemies.every((e) => e.tgt !== st.player);
  }, { timeout: 30000 }).then(() => true).catch(() => false);
  const specState = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    const btn = document.getElementById('arView');
    return {
      view: st.view, mode: i.view.mode, blend: i.view.blend,
      btn: btn.textContent.trim(), pressed: btn.getAttribute('aria-pressed'),
      arenaClass: document.getElementById('arena').className,
      btnsDisplay: getComputedStyle(document.querySelector('.ar-btns')).display,
      vm: i.fp.viewmodelVisible, cam: i.camera, eye: i.fp.eye,
      spec: st.spectate ? { x: st.spectate.x, y: st.spectate.y, h: st.spectate.h, yaw: st.spectate.yaw, pitch: st.spectate.pitch } : null,
      hp: st.player.hp, maxHp: st.player.maxHp,
      player: { x: st.player.x, y: st.player.y },
      targeting: st.enemies.map((e) => (e.tgt === st.player ? 'player' : (e.tgt ? 'unit' : 'none'))),
      hint: document.getElementById('arHint').textContent
    };
  });
  ok('🎬 버튼 → 관전 모드로 전환된다 (버튼이 ⚔️ 참전으로 바뀐다)',
    specOn && specState.view === 'spectate' && specState.mode === 'spectate' &&
    /참전/.test(specState.btn) && specState.pressed === 'true' && /spectate/.test(specState.arenaClass),
    { view: specState.view, mode: specState.mode, btn: specState.btn, pressed: specState.pressed });
  ok('관전 카메라가 전장 위 공중(높이 60+)으로 올라간다',
    specState.cam.y > 60 && specState.cam.y > specState.eye + 30 && specState.spec.h > 60,
    { camY: +specState.cam.y.toFixed(1), eye: specState.eye, h: specState.spec && specState.spec.h });
  ok('관전 중엔 1인칭 팔·검 뷰모델과 공격 버튼이 사라진다',
    specState.vm === false && specState.btnsDisplay === 'none',
    { vm: specState.vm, btns: specState.btnsDisplay });
  ok('관전 중엔 적이 나를 노리지 않고 나도 맞지 않는다',
    retargeted && specState.targeting.every((t) => t !== 'player') && specState.hp === spec0.hp,
    { retargeted: retargeted, targeting: specState.targeting, hp: specState.hp, maxHp: specState.maxHp });
  await more(3);
  await shot('28-arena-spectate.png');
  await page.evaluate(() => document.getElementById('arSlash').click());
  await sleep(400);
  const noAtk = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { anim: st.player.atkAnim, kills: st.kills, pending: !!st.pending };
  });
  ok('관전 중엔 베기 버튼을 눌러도 공격하지 않는다', noAtk.anim === 0 && !noAtk.pending, noAtk);

  const wasSpec = await page.evaluate(() => Object.assign({}, window.TWArena.state().spectate));
  await page.evaluate(() => {
    const root = document.getElementById('arena');
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 31, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    root.dispatchEvent(mk('pointerdown', 80, 620));
    for (let k = 1; k <= 4; k++) window.dispatchEvent(mk('pointermove', 80, 620 - k * 15));
  });
  await sleep(1600);
  const flew = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { spec: Object.assign({}, st.spectate), cam: st.r3d.info().camera };
  });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 31, pointerType: 'touch', clientX: 80, clientY: 560, bubbles: true }));
  });
  ok('왼쪽 드래그로 전장 위를 날아다닌다 (카메라가 따라 움직인다)',
    Math.hypot(flew.spec.x - wasSpec.x, flew.spec.y - wasSpec.y) > 8 &&
    Math.abs(flew.cam.x - (flew.spec.x - 140)) < 3,
    { moved: +Math.hypot(flew.spec.x - wasSpec.x, flew.spec.y - wasSpec.y).toFixed(1), cam: flew.cam, spec: flew.spec });

  const lookBefore = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { yaw: st.spectate.yaw, face: st.player.face };
  });
  await page.evaluate(() => {
    const root = document.getElementById('arena');
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 32, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    root.dispatchEvent(mk('pointerdown', 300, 500));
    window.dispatchEvent(mk('pointermove', 330, 500));
    window.dispatchEvent(mk('pointermove', 362, 500));
    window.dispatchEvent(mk('pointerup', 362, 500));
  });
  await sleep(400);
  const looked = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { yaw: st.spectate.yaw, face: st.player.face, view: st.view };
  });
  ok('오른쪽 드래그로 관전 시점을 자유롭게 돌린다 (참전 시점은 그대로)',
    Math.abs(looked.yaw - lookBefore.yaw) > 0.2 && Math.abs(looked.face - lookBefore.face) < 0.001,
    { dYaw: +(looked.yaw - lookBefore.yaw).toFixed(2), face: looked.face });
  await shot('28b-arena-spectate-fly.png');

  const specSpot = await page.evaluate(() => Object.assign({}, window.TWArena.state().spectate));
  await page.click('#arView');
  const backOk = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().view.blend < 0.1;
  }, { timeout: 45000 }).then(() => true).catch(() => false);
  const back = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    return {
      view: st.view, mode: i.view.mode, camY: i.camera.y, vm: i.fp.viewmodelVisible,
      btn: document.getElementById('arView').textContent.trim(),
      btns: getComputedStyle(document.querySelector('.ar-btns')).display,
      player: { x: st.player.x, y: st.player.y }
    };
  });
  ok('⚔️ 참전 → 1인칭으로 돌아와 관전하던 자리에서 다시 싸운다',
    backOk && back.view === 'fp' && back.mode === 'first-person' && Math.abs(back.camY - 20.5) < 4 &&
    back.vm === true && back.btns !== 'none' && /관전/.test(back.btn) &&
    Math.hypot(back.player.x - specSpot.x, back.player.y - specSpot.y) < 40,
    back);
  await shot('29-arena-spectate-back.png');

  /* --- 🔁 다시 싸우기: 같은 설정으로 새 판 (새 시드 · 전적으로 리셋) --- */
  const r0 = await page.evaluate(() => ({
    seed: window.TWArena.state().cfg.seed, id: window.TWArena.state().cfg.id,
    kills: window.TWArena.state().kills
  }));
  await page.evaluate(() => document.getElementById('arRestart').click());
  const restarted = await page.waitForFunction((old) => {
    if (!window.TWArena.isOpen()) return false;
    const st = window.TWArena.state();
    return st && st.cfg && st.cfg.seed !== old;
  }, { timeout: 25000 }, r0.seed).then(() => true).catch(() => false);
  const r1 = await page.evaluate(() => (window.TWArena.state() ? {
    seed: window.TWArena.state().cfg.seed, id: window.TWArena.state().cfg.id,
    kills: window.TWArena.state().kills, view: window.TWArena.state().view
  } : null));
  ok('[🔁 다시 싸우기] 로 새 판이 바로 시작된다 (새 시드 · 0베기 · 1인칭)',
    restarted && !!r1 && r1.seed !== r0.seed && r1.kills === 0 && r1.view === 'fp',
    { before: r0, after: r1 });

  await page.evaluate(() => window.TWArena.close());
  await sleep(400);
  const closed = await page.evaluate(() => ({
    mode: window.TWArena.mode(),
    canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display,
    arena3dClass: document.body.classList.contains('arena-3d')
  }));
  ok('아레나를 닫으면 3D 캔버스가 숨는다',
    closed.mode === 'none' && closed.canvas3d === 'none' && !closed.arena3dClass, closed);

  /* ============ 3부. 홈 화면 [대규모 3D 전장] ============ */
  // 이 구간은 1000명 난전의 병사 수·드로우콜·시뮬레이션 검증이 목적이다.
  // 느린 CI GPU 에서도 시간 안에 돌도록 내부 렌더 해상도만 낮춰(0.7) 돌리고,
  // 스크린샷 직전에만 원래 해상도로 되돌린다 (CSS 뷰포트는 390×844 그대로).
  const pix = (v) => page.evaluate((k) => {
    const st = window.TWArena.state();
    if (st && st.r3d) st.r3d.renderer.setPixelRatio(k);
  }, v);
  // 홈 화면에서 시작하는 흐름이므로 저장된 세션을 지우고 페이지를 새로 열어 로비로 돌아간다
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* noop */ } });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => { window.__TW_KEEP_RES__ = true; });
  await sleep(500);
  const homeState = await page.evaluate(() => {
    const b = document.getElementById('btnBigBattle');
    const en = document.getElementById('bigEnemy');
    const al = document.getElementById('bigAlly');
    const row = document.getElementById('bigSetup');
    const rb = row ? row.getBoundingClientRect() : null;
    const eb = en ? en.getBoundingClientRect() : null;
    return {
      exists: !!b,
      visible: b ? getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 30 : false,
      text: b ? b.textContent.replace(/\s+/g, ' ').trim() : null,
      enemy: en && { min: +en.min, max: +en.max, value: +en.value, w: eb ? Math.round(eb.width) : 0 },
      ally: al && { min: +al.min, max: +al.max, value: +al.value },
      chips: document.querySelectorAll('#bigEnemyChips button').length + document.querySelectorAll('#bigAllyChips button').length,
      allyChips: Array.from(document.querySelectorAll('#bigAllyChips button')).map((b) => b.getAttribute('data-count')),
      labels: [(document.getElementById('bigEnemyVal') || {}).textContent, (document.getElementById('bigAllyVal') || {}).textContent],
      sub: (document.getElementById('bbSub') || {}).textContent,
      layout: rb ? { w: Math.round(rb.width), h: Math.round(rb.height) } : null
    };
  });
  ok('홈 화면에 [⚔️ 대규모 3D 전장 · 바로 싸우기] 버튼이 있다',
    homeState.exists && homeState.visible && /대규모 3D 전장/.test(homeState.text || ''), homeState);
  ok('적군(20~1000) · 아군(0~1000) 병사 수를 따로 조절한다 (아군 0 = 혼자 싸우기)',
    !!homeState.enemy && !!homeState.ally &&
    homeState.enemy.min === 20 && homeState.enemy.max === 1000 && homeState.enemy.w > 80 &&
    homeState.ally.min === 0 && homeState.ally.max === 1000 &&
    homeState.chips === 9 && homeState.layout && homeState.layout.w > 200 && homeState.layout.h > 80 &&
    /적군 100 · 아군 100/.test(homeState.sub || ''),
    homeState);
  ok('아군 0 프리셋 버튼이 있다', homeState.allyChips && homeState.allyChips[0] === '0', homeState.allyChips);
  await shot('23-home-big-battle.png');

  // 적군 1000(프리셋 칩) · 아군 300(슬라이더) 으로 조절
  await page.evaluate(() => {
    document.querySelector('#bigEnemyChips button[data-count="1000"]').click();
    const al = document.getElementById('bigAlly');
    al.value = '300';
    al.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  const forceUi = await page.evaluate(() => ({
    enemy: +document.getElementById('bigEnemy').value,
    ally: +document.getElementById('bigAlly').value,
    labels: [document.getElementById('bigEnemyVal').textContent, document.getElementById('bigAllyVal').textContent],
    sub: document.getElementById('bbSub').textContent,
    on: (document.querySelector('#bigEnemyChips button.on') || {}).textContent,
    saved: [localStorage.getItem('tw_online_big_enemy'), localStorage.getItem('tw_online_big_ally')]
  }));
  ok('적군 1000 / 아군 300 으로 조절되고 화면·저장에 바로 반영된다',
    forceUi.enemy === 1000 && forceUi.ally === 300 && forceUi.labels[0] === '1000' &&
    forceUi.labels[1] === '300' && forceUi.on === '1000' &&
    /1000/.test(forceUi.sub) && /300/.test(forceUi.sub) &&
    forceUi.saved[0] === '1000' && forceUi.saved[1] === '300', forceUi);
  await shot('28-home-force-1000.png');

  const preBig = await page.evaluate(() => ({ hasModule: !!window.TWArena3D }));
  await page.click('#btnBigBattle');
  const bigOpen = await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 25000 })
    .then(() => true).catch(() => false);
  ok('버튼 한 번으로 지도 없이 대규모 3D 전장이 바로 열린다', bigOpen);
  await page.evaluate(() => { const st = window.TWArena.state(); if (st) st.timeLimit = 9e9; });
  if (!bigOpen) {
    ok('대형 전장 크기 · 병사 수', false, 'arena open 실패');
  } else {
    const bigCfg = await page.evaluate(() => {
      const st = window.TWArena.state();
      const i = st.r3d ? st.r3d.info() : { crowd: { max: 0 }, camera: { y: 0, fov: 0 } };
      return {
        mode: window.TWArena.mode(), has3d: !!st.r3d,
        w: st.cfg.w, h: st.cfg.h, solo: !!st.cfg.solo,
        enemyTotal: st.enemyTotal, allyTotal: st.allyTotal,
        maxAlive: st.maxAlive, maxAlliesAlive: st.maxAlliesAlive,
        playerHp: st.player.maxHp, timeLimit: st.timeLimit,
        crowdMax: i.crowd.max,
        backLabel: document.getElementById('arBack').textContent.trim(),
        restartHidden: document.getElementById('arRestart').className.indexOf('hidden') >= 0,
        camY: i.camera.y, fov: i.camera.fov
      };
    });
    // 첫 프레임에 GPU 컨텍스트가 끊겨도 앱이 스스로 3D로 다시 붙는다
    await page.waitForFunction(() => {
      const st = window.TWArena.state();
      return st && !!st.r3d;
    }, { timeout: 20000 }).catch(() => {});
    const bigRecheck = await page.evaluate(() => {
      const st = window.TWArena.state();
      return { mode: window.TWArena.mode(), has3d: !!st.r3d };
    });
    ok('대규모 전장도 3D(WebGL)로 열린다 (끊기면 스스로 다시 붙는다)',
      bigRecheck.mode === '3d' && bigRecheck.has3d === true,
      { first: { mode: bigCfg.mode, has3d: bigCfg.has3d }, now: bigRecheck, errs: errors.slice(0, 3) });
    await pix(0.6);
    ok('전장이 2배 이상 넓다 (700×1500 · 280×600 대비)',
      bigCfg.w >= 560 && bigCfg.h >= 1200, { w: bigCfg.w, h: bigCfg.h });
    ok('내가 고른 수 그대로 시작한다 (적군 1000 vs 아군 300)',
      bigCfg.enemyTotal === 1000 && bigCfg.allyTotal === 300 &&
      bigCfg.maxAlive >= 120 && bigCfg.maxAlliesAlive >= 60 && bigCfg.timeLimit > 150000, bigCfg);
    const crowdMaxNow = await page.evaluate(() => (window.TWArena.state().r3d ? window.TWArena.state().r3d.info().crowd.max : 0));
    ok('동시에 세우는 병사 상한도 함께 커진다 (인스턴스 버퍼 260)',
      crowdMaxNow >= 260, { crowdMax: crowdMaxNow, maxAlive: bigCfg.maxAlive });
    ok('나가기 버튼이 [🗺️ 홈으로] · [🔁 다시 싸우기] 로 바뀐다',
      /홈으로/.test(bigCfg.backLabel) && bigCfg.restartHidden === false, bigCfg);

    // 증원을 즉시 당겨 다수 병사를 세운다 (테스트에서 스폰 타이머를 계속 0으로)
    const crowded = await page.waitForFunction(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return false;
      st.spawnTimer = 0; st.allyTimer = 0;
      return st.r3d.info().units >= 100;
    }, { timeout: 60000, polling: 120 }).then(() => true).catch(() => false);
    const army = await page.evaluate(() => {
      const st = window.TWArena.state();
      if (!st.r3d) return { units: 0, calls: 9999, tri: 0, camY: 0, fov: 0, enemies: 0, allies: 0 };
      const i = st.r3d.info();
      return {
        units: i.units, enemies: st.enemies.length, allies: st.allies.length,
        calls: i.calls, tri: i.triangles, arcs: i.arcs, wind: i.wind,
        camY: i.camera.y, fov: i.camera.fov, px: st.player.x, py: st.player.y, w: st.cfg.w, h: st.cfg.h
      };
    });
    ok('한 화면에 병사 100명 이상이 실제로 세워진다 (대규모 난전)',
      crowded && army.units >= 100, { units: army.units, enemies: army.enemies, allies: army.allies });
    ok('인스턴싱 덕에 드로우콜이 320 이하로 유지된다',
      army.calls < 320, { calls: army.calls, tri: army.tri });
    ok('대형 전장에서도 1인칭 눈높이(≈20) · 세로 시야각 유지',
      Math.abs(army.camY - 20.5) < 4 && army.fov >= 72 && army.fov <= 96,
      { camY: +army.camY.toFixed(1), fov: army.fov, w: army.w, h: army.h });
    // 난전이 한눈에 보이도록 적·아군을 서로 맞붙는 위치로 모아 둔다 (시뮬레이션 상태 그대로)
    await page.evaluate(() => {
      const st = window.TWArena.state();
      const p = st.player;
      st.player.atkAnim = 0;
      const n = st.enemies.length || 1;
      for (let i = 0; i < st.enemies.length; i++) {
        const a = p.face + ((i / n) - 0.5) * 0.82;
        const d = 92 + (i % 4) * 46;
        st.enemies[i].x = Math.max(14, Math.min(st.cfg.w - 14, p.x + Math.cos(a) * d));
        st.enemies[i].y = Math.max(20, Math.min(st.cfg.h * 0.9, p.y + Math.sin(a) * d));
        st.enemies[i].speed = 0.0001;
        st.enemies[i].cd = 99999;
        if (i % 5 === 1) st.enemies[i].wind = 400;
      }
      for (let i = 0; i < st.allies.length; i++) {
        const a = p.face + Math.PI + (i % 2 ? 1 : -1) * (0.15 + (i % 4) * 0.22);
        const d = 45 + (i % 3) * 30;
        st.allies[i].x = Math.max(14, Math.min(st.cfg.w - 14, p.x + Math.cos(a) * d));
        st.allies[i].y = Math.max(20, Math.min(st.cfg.h * 0.9, p.y + Math.sin(a) * d));
        st.allies[i].speed = 0.0001;
      }
    });
    await more(2);
    await pix(1);
    await more(1);
    await shot('24-fp-big-battle.png');
    await pix(0.6);

    // 대형 전장에서 적을 베어 3D 두 동강
    const bigSlash = await page.evaluate(() => {
      const st = window.TWArena.state();
      st.player.atkCd = 0; st.player.dash = 0;
      st.enemies.unshift({
        team: 'enemy', x: st.player.x, y: st.player.y + 40, r: 8.4, hp: 6, maxHp: 76,
        speed: 0.0001, face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0,
        dead: false, lastHitBy: null, dashHit: false, wob: 0
      });
      return { kills: st.kills, face: st.player.face, frames: st.r3d.info().frames };
    });
    await page.click('#arSlash');
    await waitPieces(2);
    const bigHit = await page.evaluate(() => {
      const st = window.TWArena.state();
      return {
        kills: st.kills, pieces: st.r3d.piecesInfo().length, cuts: st.r3d.info().cuts,
        corpses: st.corpses.length, down: st.down, atkCd: Math.round(st.player.atkCd),
        face: st.player.face, slashes: st.slashes.length
      };
    });
    ok('대형 전장에서도 베면 3D 두 동강 + 시점 고정',
      bigHit.kills > bigSlash.kills && bigHit.pieces >= 2 && Math.abs(bigHit.face - bigSlash.face) < 0.001, bigHit);
    await pix(1);
    await more(1);
    await shot('25-fp-big-battle-split.png');
    await pix(0.6);

    // 홈으로
    await page.evaluate(() => document.getElementById('arBack').click());
    const home = await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 20000 })
      .then(() => true).catch(() => false);
    const homeView = await page.evaluate(() => ({
      lobby: !document.getElementById('lobby').classList.contains('hidden'),
      homePanel: !document.getElementById('homePanel').hidden,
      button: !!document.getElementById('btnBigBattle'),
      canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display
    }));
    ok('[🗺️ 홈으로] 로 나오면 홈 화면으로 돌아온다',
      home && homeView.lobby && homeView.homePanel && homeView.button && homeView.canvas3d === 'none', homeView);
  }

  /* ============ 3-2부. 아군 0명 — 혼자서 1,000명과 싸우기 ============ */
  await page.evaluate(() => {
    document.querySelector('#bigAllyChips button[data-count="0"]').click();
    document.querySelector('#bigEnemyChips button[data-count="1000"]').click();
  });
  await sleep(200);
  const zeroUi = await page.evaluate(() => ({
    ally: +document.getElementById('bigAlly').value,
    sub: document.getElementById('bbSub').textContent,
    saved: localStorage.getItem('tw_online_big_ally')
  }));
  ok('아군 0을 고르면 슬라이더·문구·저장에 모두 0으로 반영된다',
    zeroUi.ally === 0 && /아군 0/.test(zeroUi.sub) && zeroUi.saved === '0', zeroUi);
  await page.click('#btnBigBattle');
  const soloOpen = await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 25000 })
    .then(() => true).catch(() => false);
  ok('아군 0으로 대규모 전장이 그대로 열린다 (1 vs 1000)', soloOpen);
  if (soloOpen) {
    await pix(0.6);
    await sleep(600);
    const soloCfg = await page.evaluate(() => {
      const st = window.TWArena.state();
      return {
        allyTotal: st.allyTotal, allyStart: st.allyStart, allies: st.allies.length,
        enemyTotal: st.enemyTotal, enemySpawned: st.enemySpawned,
        maxAlliesAlive: st.maxAlliesAlive
      };
    });
    ok('아군 0 — 아군 병력이 한 명도 생기지 않고 적 1000명과 싸운다',
      soloCfg.allyTotal === 0 && soloCfg.allyStart === 0 && soloCfg.allies === 0 && soloCfg.enemyTotal === 1000,
      soloCfg);
    // 대규모 난전 부하 측정 (적 100명+ 세우고 프레임·드로우콜)
    const perf = await page.evaluate(async () => {
      const st = window.TWArena.state();
      st.spawnTimer = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 35000 && st.r3d.info().units < 120) {
        st.spawnTimer = 0;
        await new Promise((r) => setTimeout(r, 80));
      }
      const f0 = st.r3d.info().frames, p0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      const f1 = st.r3d.info().frames, p1 = performance.now();
      const i = st.r3d.info();
      return {
        units: i.units, calls: i.calls, tri: i.triangles, arcs: i.arcs,
        fps: +(((f1 - f0) * 1000) / Math.max(1, p1 - p0)).toFixed(1),
        pixelRatio: +i.pixelRatio.toFixed(2)
      };
    });
    ok('적 120명이 한 화면에 서도 드로우콜이 300 이하 (인스턴싱)', perf.calls < 300 && perf.units >= 120, perf);
    ok('대규모 난전 부하가 예산 안에 있다 (삼각형 30만 이하 · 드로우콜 300 이하 · 프레임 계속 진행)',
      perf.tri <= 300000 && perf.calls < 300 && perf.fps > 0.5, perf);
    await page.screenshot({ path: path.join(SHOTS, '29-solo-1000.png') });
    ok('아군 0 대규모 전장에서 페이지 오류 0', errors.length === 0, errors.slice(0, 4));
    await page.evaluate(() => document.getElementById('arBack').click());
    await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 20000 }).catch(() => {});
  }

  /* ============ 4부. 2D 폴백 ============ */
  await page.evaluate(() => { try { delete window.TWArena3D; } catch (e) { window.TWArena3D = undefined; } });
  const fbOpen = await page.evaluate(() => window.TWArena.open({
    id: 't2d', seed: 77, w: 280, h: 600, enemyCount: 5, allyCount: 2,
    me: { name: '한윤', color: '#3b82f6' }, enemy: { name: '적', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '적', troops: 3 }
  }, {}));
  await sleep(1200);
  const fb = await page.evaluate(() => ({
    open: !!window.TWArena.isOpen(),
    mode: window.TWArena.mode(),
    has3d: !!(window.TWArena.state() && window.TWArena.state().r3d),
    canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display
  }));
  ok('Three.js/WebGL 이 없으면 2D 렌더러로 자동 폴백',
    fbOpen === true && fb.mode === '2d' && !fb.has3d && fb.canvas3d === 'none', fb);
  await shot('26-arena3d-fallback-2d.png');
  await page.evaluate(() => window.TWArena.close());

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 6));

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (failed.length ? '실패 ' + failed.length + '개 / ' : '') + '총 ' + results.length + '개 확인');
  if (failed.length) console.log(failed.map((f) => ' - ' + f.name).join('\n'));
  await browser.close();
  stop();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
