'use strict';

/* 영토 전쟁 ONLINE · 3D 칼싸움 전장(Three.js) 모바일 검증
   - 390×844 터치 뷰포트 + SwiftShader WebGL
   - 1부: 서버 참전 흐름 — 3D 아레나 진입 / 조이스틱·카메라 / 지도 복귀 (짧게, 실패 시 재시도)
   - 2부: 결정적 3D 검증 — 검기 호, 두 동강 3D 조각(칼 각도·절단면·회전·소멸),
           대각선/돌진 절단, 막기 자세
   - 3부: Three.js/WebGL 이 없을 때 2D 자동 폴백
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
  const frames = (n) => page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.info().frames >= k;
  }, { timeout: 25000 }, n).catch(() => false);
  const waitPieces = (n) => page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.piecesInfo().length >= k;
  }, { timeout: 25000 }, n).catch(() => false);
  const waitNoPieces = () => page.waitForFunction(() => {
    const st = window.TWArena.state();
    return st && st.r3d && st.r3d.piecesInfo().length === 0;
  }, { timeout: 45000 }).catch(() => false);

  /* ============ 0. 모듈 ============ */
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(500);
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

  /* ============ 1부. 서버 참전 흐름 ============ */
  await page.evaluate(() => { window.__TW_KEEP_RES__ = true; document.getElementById('nameInput').value = '한윤'; });
  await page.click('#btnSim');
  await page.waitForFunction(() => window.__TW__ && window.__TW__.state(), { timeout: 15000 });
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
  await page.waitForFunction(() => window.__TW__.state() && window.__TW__.state().you >= 0, { timeout: 10000 });
  await sleep(900);

  // 서버 흐름은 실시간 전쟁 중이라 전선을 잃으면 아레나가 서버에서 닫힌다 → 짧게 재시도
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
    const opened = await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 12000 })
      .then(() => true).catch(() => false);
    if (!opened) { await sleep(1200); continue; }
    if (!(await frames(2))) { await sleep(800); continue; }
    const snap = await page.evaluate(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return null;
      const r = st.r3d;
      const c3 = document.getElementById('arenaCanvas3d');
      const gl = r.renderer.getContext();
      return {
        mode: window.TWArena.mode(), kind: r.kind, rev: r.rev,
        canvas3d: { w: c3.width, h: c3.height, cw: c3.clientWidth, ch: c3.clientHeight, display: c3.style.display },
        glVersion: gl.getParameter(gl.VERSION),
        info: r.info(), units: r.unitsInfo().length,
        sim: { enemies: st.enemies.length, allies: st.allies.length, obstacles: st.obstacles.length },
        px: st.player.x, py: st.player.y, cam: r.camera.position.toArray()
      };
    });
    if (!snap) { await sleep(800); continue; }
    live = snap;
    // 조이스틱 → 이동 + 카메라 추종
    await page.mouse.move(90, 640);
    await page.mouse.down();
    await page.mouse.move(120, 540, { steps: 10 });
    await sleep(1200);
    const moved = await page.evaluate(() => {
      const st = window.TWArena.state();
      if (!st || !st.r3d) return null;
      return {
        x: st.player.x, y: st.player.y, cam: st.r3d.camera.position.toArray(),
        joy: !document.getElementById('arJoy').className.includes('hidden')
      };
    });
    await page.mouse.up();
    if (moved) {
      live.walked = Math.hypot(moved.x - live.px, moved.y - live.py);
      live.camMoved = Math.hypot(moved.cam[0] - live.cam[0], moved.cam[2] - live.cam[2]);
      live.joy = moved.joy;
    }
    await page.screenshot({ path: path.join(SHOTS, '17-arena3d.png') }).catch(() => {});
    await page.evaluate(() => {
      const b = document.getElementById('arBack');
      if (b) b.click();
    }).catch(() => {});
    const closed = await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 10000 })
      .then(() => true).catch(() => false);
    live.back = await page.evaluate(() => ({
      mode: window.TWArena.mode(),
      canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display,
      arena3dClass: document.body.classList.contains('arena-3d'),
      map: !!window.__TW__.state()
    }));
    live.closed = closed;
  }

  ok('서버 참전 → 아레나가 3D(WebGL2)로 열린다',
    !!live && live.mode === '3d' && live.kind === 'three' && /WebGL/.test(live.glVersion),
    live && { mode: live.mode, gl: live.glVersion });
  ok('3D 캔버스가 390×844 화면을 꽉 채운다',
    !!live && live.canvas3d.display === 'block' && live.canvas3d.cw === 390 && live.canvas3d.ch === 844,
    live && live.canvas3d);
  ok('3D 병사(플레이어·아군·적)가 모두 세워진다',
    !!live && live.units === live.sim.enemies + live.sim.allies + 1 && live.units >= 5,
    live && { units: live.units, sim: live.sim });
  ok('3D 지형 · 장애물(바위/천막/수레) 배치', !!live && live.sim.obstacles === 7, live && live.sim.obstacles);
  ok('실제로 그려지고 있다 (삼각형 5천+ · 드로우콜 50+)',
    !!live && live.info.triangles > 5000 && live.info.calls > 50,
    live && { tri: live.info.triangles, calls: live.info.calls });
  ok('왼쪽 드래그 조이스틱으로 이동 · 3D 카메라가 따라온다',
    !!live && live.joy && live.walked > 10 && live.camMoved > 5,
    live && { walked: Math.round(live.walked || 0), cam: Math.round(live.camMoved || 0) });
  ok('🗺️ 지도로 복귀하면 3D 아레나가 닫히고 지도로 돌아온다',
    !!live && live.closed && live.back.mode === 'none' && live.back.canvas3d === 'none' &&
    !live.back.arena3dClass && live.back.map, live && live.back);

  /* ============ 2부. 결정적 3D 검증 ============ */
  // 지도 게임/서버 메시지가 검증용 아레나를 닫지 않도록 app.js 쪽 연결만 떼어 둔다
  await page.evaluate(() => {
    window.TWArena.forceClose = function () {};
    window.TWArena.applyUpdate = function () {};
    window.TWArena.finish = function () {};
  });
  const opened = await page.evaluate(() => window.TWArena.open({
    id: 't3d', seed: 90210, w: 280, h: 600, enemyCount: 10, allyCount: 3, maxKills: 10,
    me: { slot: 0, name: '한윤', color: '#3b82f6' },
    enemy: { slot: 1, name: '바람', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '바람', troops: 4 }
  }, {}));
  await frames(4);
  await sleep(300);
  ok('3D 아레나 직접 개시 (결정적 검증용)', opened === true && await page.evaluate(() => !!window.TWArena.state()));

  // 정면에 적 3명 → ⚔️ 베기
  const setup = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.forEach((e) => { e.dead = true; });
    st.enemies.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;   // 승리 판정·자동 스폰 정지
    st.player.x = 180; st.player.y = 380; st.player.face = 0;
    st.player.atkCd = 0; st.player.dash = 0; st.player.hp = st.player.maxHp; st.down = 0;
    st.corpses.length = 0; st.cuts.length = 0; st.particles.length = 0;
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
  await frames(1);
  const slash = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills, slashes: st.slashes.length, slashViews: st.r3d.info().slashes,
      cuts: st.r3d.info().cuts, pieces: st.r3d.piecesInfo()
    };
  });
  ok('⚔️ 베기 → 3D 검기 호 메시가 나타난다', slash.slashes > 0 && slash.slashViews > 0,
    { sim: slash.slashes, mesh: slash.slashViews });
  ok('베어낸 적이 3D 조각 2개로 갈라진다 (1명당 정확히 2조각)',
    slash.pieces.length === (slash.kills - setup.kills) * 2 && slash.pieces.length >= 2,
    { pieces: slash.pieces.length, kills: slash.kills - setup.kills });
  ok('조각의 절단각이 플레이어 칼 각도(0rad)와 같다',
    slash.pieces.every((p) => Math.abs(p.cut) < 0.001), slash.pieces.map((p) => p.cut));
  ok('3D 절단면 법선이 칼날에 수직이다',
    slash.pieces.every((p) => Math.abs(p.plane.nx * Math.cos(p.cut) + p.plane.nz * Math.sin(p.cut)) < 0.01),
    slash.pieces.map((p) => ({ nx: +p.plane.nx.toFixed(2), nz: +p.plane.nz.toFixed(2) })));
  ok('조각은 실제 잘린 병사 메시다 (조각당 파트 5개+)',
    slash.pieces.every((p) => p.parts >= 5), slash.pieces.map((p) => p.parts));
  ok('절단 섬광 판이 함께 그려진다', slash.cuts > 0, slash.cuts);
  await page.screenshot({ path: path.join(SHOTS, '18-arena3d-slash.png') });

  await sleep(600);
  const flying = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { pieces: st.r3d.piecesInfo() };
  });
  if (flying.pieces.length >= 2) {
    const a = flying.pieces[0], b = flying.pieces[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const alongCut = Math.abs((dx * Math.cos(a.cut) + dy * Math.sin(a.cut)) / Math.max(0.0001, dist));
    ok('두 조각이 칼날 수직 방향으로 벌어진다', dist > 4 && alongCut < 0.4,
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
  });

  ok('약 1초 뒤 3D 조각이 사라지고 메시가 정리된다', await waitNoPieces(),
    await page.evaluate(() => (window.TWArena.state() ? window.TWArena.state().r3d.piecesInfo().length : 'closed')));

  // 대각선 절단
  const diag = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0; st.cuts.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 140; st.player.y = 320; st.player.face = 0.62;
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
  await frames(1);
  const diagPieces = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { pieces: st.r3d.piecesInfo(), kills: st.kills };
  });
  ok('대각선(0.62rad) 베기에서도 3D 조각 2개', diagPieces.pieces.length === 2 && diagPieces.kills > diag.kills,
    diagPieces.pieces.length);
  ok('대각선 절단면도 칼 각도(0.62rad)를 따른다',
    diagPieces.pieces.every((p) => Math.abs(p.cut - 0.62) < 0.001), diagPieces.pieces.map((p) => p.cut));
  const dz = await page.evaluate(() => {
    const st = window.TWArena.state();
    return st.r3d.project(st.player.x + Math.cos(0.62) * 24, st.player.y + Math.sin(0.62) * 24, 16);
  });
  await page.screenshot({
    path: path.join(SHOTS, '20-arena3d-diagonal-split.png'),
    clip: {
      x: Math.max(0, Math.min(390 - 280, dz.x - 140)),
      y: Math.max(0, Math.min(844 - 260, dz.y - 130)),
      width: 280, height: 260
    }
  });

  // 돌진 베기
  const dashBefore = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.corpses.length = 0; st.cuts.length = 0; st.enemies.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.x = 140; st.player.y = 300; st.player.face = Math.PI / 2;
    st.player.atkCd = 0; st.player.dashCd = 0; st.player.hp = st.player.maxHp; st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 140, y: 300 + 34, r: 8.4, hp: 15, maxHp: 76,
      speed: 0.0001, face: -Math.PI / 2, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0,
      dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills };
  });
  await page.click('#arDash');
  await waitPieces(2);
  await frames(1);
  const dashAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, pieces: st.r3d.piecesInfo() };
  });
  ok('💨 돌진 베기로도 적이 3D 두 조각이 된다',
    dashAfter.kills > dashBefore.kills && dashAfter.pieces.length === 2,
    { kills: dashAfter.kills - dashBefore.kills, pieces: dashAfter.pieces.length });
  ok('돌진 방향(π/2)이 절단면 각도가 된다',
    dashAfter.pieces.length === 2 && dashAfter.pieces.every((p) => Math.abs(p.cut - Math.PI / 2) < 0.001),
    dashAfter.pieces.map((p) => p.cut));
  await waitNoPieces();

  // 막기 자세
  const gpos = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0; st.corpses.length = 0;
    st.enemySpawned = 0; st.spawnTimer = 9e9; st.winAt = 0;
    st.player.hp = st.player.maxHp; st.down = 0;
    const r = document.getElementById('arGuard').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(gpos.x, gpos.y);
  await page.mouse.down();
  await sleep(500);
  const guarding = await page.evaluate(() => ({ guard: window.TWArena.state().player.guard }));
  await page.screenshot({ path: path.join(SHOTS, '21-arena3d-guard.png') });
  await page.mouse.up();
  ok('🛡️ 막기 자세가 3D 병사에 반영된다', guarding.guard === true, guarding);

  await page.evaluate(() => window.TWArena.close());
  await sleep(400);
  const closed = await page.evaluate(() => ({
    mode: window.TWArena.mode(),
    canvas3d: getComputedStyle(document.getElementById('arenaCanvas3d')).display,
    arena3dClass: document.body.classList.contains('arena-3d')
  }));
  ok('아레나를 닫으면 3D 캔버스가 숨는다',
    closed.mode === 'none' && closed.canvas3d === 'none' && !closed.arena3dClass, closed);

  /* ============ 3부. 2D 폴백 ============ */
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
  await page.screenshot({ path: path.join(SHOTS, '23-arena3d-fallback-2d.png') });
  await page.evaluate(() => window.TWArena.close());

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 6));

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (failed.length ? '실패 ' + failed.length + '개 / ' : '') + '총 ' + results.length + '개 확인');
  await browser.close();
  stop();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
