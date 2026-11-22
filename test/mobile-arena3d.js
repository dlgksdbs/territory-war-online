'use strict';

/* 영토 전쟁 ONLINE · 3D 칼싸움 전장(Three.js) 모바일 검증 — 1인칭 개조판
   - 390×844 세로(portrait) 터치 뷰포트 + SwiftShader WebGL
   - 1부: 서버 참전 흐름 — 3D 아레나 진입 / 1인칭 눈높이 / 조이스틱은 시점을 돌리지 않음
   - 2부: 결정적 1인칭 검증 — 왼손 방패·오른손 검 뷰모델, 오른쪽 드래그로만 시점 회전,
           적 칼 휘두름 + 붉은 검기, 3D 두 동강, 대각선/돌진 절단, 막기 자세
   - 3부: 홈 화면 [대규모 3D 전장] 버튼 → 700×1500 대형 전장 · 다수 병사 · 다시 싸우기
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
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

  const results = [];
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? null : extra)));
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

  /* ============ 1부. 서버 참전 흐름 (1인칭) ============ */
  await page.evaluate(() => { window.__TW_KEEP_RES__ = true; document.getElementById('nameInput').value = '한윤'; });
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
        vm: { meshes: r.viewmodel.meshes, visible: r.info().fp.viewmodelVisible }
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
  ok('내 3인칭 몸 대신 손에 든 검·방패 뷰모델이 보인다 (1인칭)',
    !!live && live.vm.meshes >= 10 && live.vm.visible, live && live.vm);
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
  await sleep(200);
  ok('3D 아레나 직접 개시 (결정적 검증용)', opened === true && await page.evaluate(() => !!window.TWArena.state()));

  const fp = await page.evaluate(() => {
    const st = window.TWArena.state();
    const r = st.r3d;
    const i = r.info();
    const v = r.viewmodel;
    return {
      mode: window.TWArena.mode(),
      eye: i.fp.eye, camY: i.camera.y, camX: i.camera.x, camZ: i.camera.z,
      px: st.player.x, py: st.player.y, yaw: i.fp.yaw, face: st.player.face, pitch: i.fp.pitch,
      fov: i.camera.fov, aspect: i.canvas.cw / i.canvas.ch,
      vmMeshes: v.meshes, vmVisible: !!v.group.visible,
      swordZ: v.swordArm.position.z, shieldZ: v.shieldArm.position.z,
      shieldX: v.shieldArm.position.x, swordX: v.swordArm.position.x,
      playerGroupRendered: !!document.querySelector('#arenaCanvas3d')
    };
  });
  ok('카메라가 1인칭 눈높이(eye≈20.5)에 있고 시점은 face 와 일치',
    fp.mode === '3d' && Math.abs(fp.camY - 20.5) < 3 && Math.abs(fp.yaw - fp.face) < 0.001,
    { camY: +fp.camY.toFixed(2), yaw: +fp.yaw.toFixed(3), face: +fp.face.toFixed(3) });
  ok('카메라가 플레이어 머리 위치에 있다 (x·z 일치 · 세로 화면 fov 72~92)',
    Math.hypot(fp.camX - (fp.px - 140), fp.camZ - (fp.py - 300)) < 2.5,
    { cam: [+fp.camX.toFixed(1), +fp.camZ.toFixed(1)], player: [fp.px - 140, fp.py - 300] });
  ok('오른손 검 · 왼손 방패 뷰모델이 카메라 앞 화면 안에 배치된다',
    fp.vmVisible && fp.vmMeshes >= 10 && fp.swordZ < -3 && fp.shieldZ < -3 &&
    fp.swordX > 0.4 && fp.shieldX < -0.4,
    { meshes: fp.vmMeshes, sword: [fp.swordX, fp.swordZ], shield: [fp.shieldX, fp.shieldZ] });
  ok('세로 화면(390×844) 시야각이 확보된다 (수직 72~92° · 수평 45°+)',
    fp.fov >= 72 && fp.fov <= 92 &&
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

  // 정면에 적 3명 → ⚔️ 베기
  const setup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.forEach((e) => { e.dead = true; });
    st.enemies.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 180; st.player.y = 380; st.player.face = 0; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    st.corpses.length = 0; st.cuts.length = 0; st.particles.length = 0; st.slashes.length = 0;
    document.getElementById('arDown').classList.add('hidden');
    for (let i = 0; i < 3; i++) {
      st.enemies.push({
        team: 'enemy', x: 180 + 34 + i * 6, y: 380 + (i - 1) * 9,
        r: 8.4, hp: 12, maxHp: 76, speed: 0.0001, face: Math.PI, cd: 99999, wind: 0,
        swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null, dashHit: false, wob: 0
      });
    }
    return { kills: st.kills };
  });
  await page.click('#arSlash');
  await waitPieces(2);
  await more(1);
  const slash = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills, slashes: st.slashes.length, slashViews: st.r3d.info().slashes,
      cuts: st.r3d.info().cuts, pieces: st.r3d.piecesInfo()
    };
  });
  ok('⚔️ 베기 → 1인칭 화면에 3D 검기 메시가 그려진다', slash.slashes > 0 && slash.slashViews > 0,
    { sim: slash.slashes, mesh: slash.slashViews });
  ok('베어낸 적이 3D 조각 2개로 갈라진다 (1명당 정확히 2조각)',
    slash.pieces.length === (slash.kills - setup.kills) * 2 && slash.pieces.length >= 2,
    { pieces: slash.pieces.length, kills: slash.kills - setup.kills });
  ok('조각의 절단각이 플레이어 시점(0rad)과 같다',
    slash.pieces.every((p) => Math.abs(p.cut) < 0.001), slash.pieces.map((p) => p.cut));
  ok('3D 절단면 법선이 칼날에 수직이다',
    slash.pieces.every((p) => Math.abs(p.plane.nx * Math.cos(p.cut) + p.plane.nz * Math.sin(p.cut)) < 0.01),
    slash.pieces.map((p) => ({ nx: +p.plane.nx.toFixed(2), nz: +p.plane.nz.toFixed(2) })));
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

  // 오른쪽 화면 짧은 탭 = 베기 (드래그는 시점)
  const tapSetup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0; st.slashes.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 150; st.player.y = 340; st.player.face = Math.PI / 2; st.player.pitch = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 150, y: 340 + 40, r: 8.4, hp: 10, maxHp: 76, speed: 0.0001,
      face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0, dead: false, dashHit: false, wob: 0
    });
    return { kills: st.kills, face: st.player.face };
  });
  const tapPos = await page.evaluate(() => ({ x: 258, y: 540 }));
  await page.mouse.move(tapPos.x, tapPos.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await more(2);
  const tapped = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, slashes: st.slashes.length, face: st.player.face };
  });
  ok('오른쪽 화면 짧은 탭 → 베기 (시점은 그대로)',
    tapped.kills > tapSetup.kills && Math.abs(tapped.face - tapSetup.face) < 0.02, tapped);

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

  // 막기 자세 (뷰모델 방패를 올린다)
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
  await more(4);
  const guarding = await page.evaluate(() => {
    const st = window.TWArena.state();
    const i = st.r3d.info();
    const v = st.r3d.viewmodel;
    return { guard: st.player.guard, vmGuard: i.fp.viewmodelGuard, shieldY: v.shieldArm.position.y, shieldX: v.shieldArm.position.x };
  });
  await shot('22-arena3d-guard.png');
  await page.mouse.up();
  ok('🛡️ 막기 → 1인칭 방패가 화면 가운데로 올라온다',
    guarding.guard === true && guarding.vmGuard > 0.5 && guarding.shieldX > -0.9 && guarding.shieldY > -1.6, guarding);

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
  // 홈 화면에서 시작하는 흐름이므로 저장된 세션을 지우고 페이지를 새로 열어 로비로 돌아간다
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* noop */ } });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => { window.__TW_KEEP_RES__ = true; });
  await sleep(900);
  const homeState = await page.evaluate(() => {
    const b = document.getElementById('btnBigBattle');
    return {
      exists: !!b,
      visible: b ? getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().height > 30 : false,
      text: b ? b.textContent.replace(/\s+/g, ' ').trim() : null
    };
  });
  ok('홈 화면에 [⚔️ 대규모 3D 전장 · 바로 싸우기] 버튼이 있다',
    homeState.exists && homeState.visible && /대규모 3D 전장/.test(homeState.text || ''), homeState);
  await shot('23-home-big-battle.png');

  await page.click('#btnBigBattle');
  const bigOpen = await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 25000 })
    .then(() => true).catch(() => false);
  ok('버튼 한 번으로 지도 없이 대규모 3D 전장이 바로 열린다', bigOpen);
  if (!bigOpen) {
    ok('대형 전장 크기 · 병사 수', false, 'arena open 실패');
  } else {
    const bigCfg = await page.evaluate(() => {
      const st = window.TWArena.state();
      return {
        w: st.cfg.w, h: st.cfg.h, solo: !!st.cfg.solo,
        enemyTotal: st.enemyTotal, allyTotal: st.allyTotal, maxAlive: st.maxAlive,
        playerHp: st.player.maxHp,
        backLabel: document.getElementById('arBack').textContent.trim(),
        restartHidden: document.getElementById('arRestart').className.indexOf('hidden') >= 0,
        camY: st.r3d.info().camera.y, fov: st.r3d.info().camera.fov
      };
    });
    ok('전장이 2배 이상 넓다 (700×1500 · 280×600 대비)',
      bigCfg.w >= 560 && bigCfg.h >= 1200, { w: bigCfg.w, h: bigCfg.h });
    ok('양쪽 병력이 파도처럼 증원된다 (적 50+ · 아군 40+ · 동시 25+)',
      bigCfg.enemyTotal >= 50 && bigCfg.allyTotal >= 40 && bigCfg.maxAlive >= 25, bigCfg);
    ok('나가기 버튼이 [🗺️ 홈으로] · [🔁 다시 싸우기] 로 바뀐다',
      /홈으로/.test(bigCfg.backLabel) && bigCfg.restartHidden === false, bigCfg);

    // 증원을 즉시 돌려 다수 병사를 세운다
    await page.evaluate(() => {
      const st = window.TWArena.state();
      st.spawnTimer = 0; st.allyTimer = 0;
    });
    const crowded = await page.waitForFunction(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return false;
      const i = st.r3d.info();
      return i.units >= 24;
    }, { timeout: 120000 }).then(() => true).catch(() => false);
    const army = await page.evaluate(() => {
      const st = window.TWArena.state();
      const i = st.r3d.info();
      return {
        units: i.units, enemies: st.enemies.length, allies: st.allies.length,
        calls: i.calls, tri: i.triangles, arcs: i.arcs, wind: i.wind,
        camY: i.camera.y, fov: i.camera.fov, px: st.player.x, py: st.player.y, w: st.cfg.w, h: st.cfg.h
      };
    });
    ok('한 화면에 병사 24명 이상이 실제로 세워진다 (대규모 난전)',
      crowded && army.units >= 24, { units: army.units, enemies: army.enemies, allies: army.allies });
    ok('인스턴싱 덕에 드로우콜이 300 이하로 유지된다',
      army.calls < 300, { calls: army.calls, tri: army.tri });
    ok('대형 전장에서도 1인칭 눈높이(≈20) · 세로 시야각 유지',
      Math.abs(army.camY - 20.5) < 4 && army.fov >= 72 && army.fov <= 92,
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
    await shot('24-fp-big-battle.png');

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
    await shot('25-fp-big-battle-split.png');

    // 다시 싸우기
    const before = await page.evaluate(() => ({ id: window.TWArena.state().cfg.id, seed: window.TWArena.state().cfg.seed }));
    await page.click('#arRestart');
    const restarted = await page.waitForFunction((old) => {
      if (!window.TWArena.isOpen()) return false;
      const st = window.TWArena.state();
      return st && st.cfg && st.cfg.seed !== old;
    }, { timeout: 25000 }, before.seed).then(() => true).catch(() => false);
    const after = await page.evaluate(() => (window.TWArena.state() ? { id: window.TWArena.state().cfg.id, seed: window.TWArena.state().cfg.seed } : null));
    ok('[🔁 다시 싸우기] 로 새 판이 바로 시작된다', restarted && !!after && after.seed !== before.seed,
      { before, after });

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
