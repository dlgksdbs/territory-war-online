'use strict';

/* 영토 전쟁 ONLINE · 직접 참전(칼질 아레나) 모바일 뷰포트 검증
   - 390×844 터치 뷰포트에서 참전 버튼 → 아레나 진입 → 조이스틱/버튼/베기
   - 베인 적이 칼 각도대로 두 조각으로 갈라지는지(corpses) 프로그램 검증
   - 콘솔/페이지 오류 0, 캔버스 크기, 스크린샷 저장 */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = '/workspace/territory-war-online';
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 3577;
process.env.PORT = String(PORT);   // 서버를 같은 프로세스에서 띄운다 (자식 프로세스 없이 안정적으로)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  const stop = () => { try { server.close(); } catch (e) { /* noop */ } };
  process.on('exit', stop);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required']
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

  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(700);

  // 로비에서 AI 시뮬레이션으로 바로 시작
  await page.evaluate(() => { document.getElementById('nameInput').value = '한윤'; });
  await page.click('#btnSim');
  await page.waitForFunction(() => {
    const b = document.getElementById('specChip');
    return window.__TW__ && window.__TW__.state();
  }, { timeout: 15000 });
  await sleep(1200);

  // 나라 하나 잡기
  await page.evaluate(() => {
    const st = window.__TW__.state();
    const counts = [0, 1, 2, 3].map((i) => st.regions.filter((r) => r.owner === i).length);
    let best = 0;
    for (let i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i;
    const btn = document.querySelector('.sp-nation[data-slot="' + best + '"]');
    if (btn) btn.click();
    return counts;
  });
  await sleep(400);
  await page.click('#btnJump');
  await page.waitForFunction(() => window.__TW__.state() && window.__TW__.state().you >= 0, { timeout: 10000 });
  await sleep(1200);

  const ui = await page.evaluate(() => {
    const row = document.getElementById('skirmishRow');
    const btn = document.getElementById('btnSkirmish');
    const rect = btn.getBoundingClientRect();
    const pick = window.__TW__.frontline();
    return {
      rowHidden: row.className.indexOf('hidden') >= 0,
      rowShown: window.__TW__.skirmishRowShown(),
      label: btn.innerText.replace(/\s+/g, ' ').trim(),
      sub: document.getElementById('skirmishSub').textContent,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      pick: pick ? { region: pick.region.name, target: pick.target.name, troops: pick.target.troops } : null
    };
  });
  ok('지도 화면에 ⚔️ 칼들고 참전 버튼 표시', ui.rowShown && ui.label.indexOf('칼들고 참전') >= 0, ui);
  ok('전선 요약(영토 ↔ 적 · 병력) 표시', !!ui.pick && ui.sub.indexOf('↔') >= 0 && ui.sub.indexOf('병력') >= 0, ui.sub);
  ok('버튼 터치 영역 충분(≥40px)', ui.rect.w > 200 && ui.rect.h >= 40, ui.rect);

  await page.screenshot({ path: path.join(SHOTS, '12-skirmish-button.png') });

  // 참전
  const targetBefore = ui.pick ? ui.pick.troops : null;
  await page.click('#btnSkirmish');
  await page.waitForFunction(() => window.TWArena && window.TWArena.isOpen(), { timeout: 10000 });
  await sleep(1400);

  const ar = await page.evaluate(() => {
    const c = document.getElementById('arenaCanvas');
    const b = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const st = window.TWArena.state();
    return {
      open: window.TWArena.isOpen(),
      canvas: { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight },
      slash: b('arSlash'), dash: b('arDash'), guard: b('arGuard'), back: b('arBack'),
      kills: st.kills, enemies: st.enemies.length, allies: st.allies.length,
      hp: st.player.hp, enemyTotal: st.enemyTotal,      banner: document.getElementById('arBanner').textContent,
      targetInfo: document.getElementById('arTargetInfo').textContent,
      hint: document.getElementById('arHint').textContent
    };
  });
  ok('아레나가 열리고 캔버스가 화면을 채운다', ar.open && ar.canvas.cw > 300 && ar.canvas.ch > 700,
    ar.canvas);
  ok('⚔️ 베기 버튼이 크게(≥80px) 보인다', ar.slash.w >= 80 && ar.slash.h >= 80 && ar.slash.y > 500, ar.slash);
  ok('💨 돌진 · 🛡️ 막기 버튼도 터치 가능한 크기(≥60px)',
    ar.dash.w >= 60 && ar.dash.h >= 60 && ar.guard.w >= 60 && ar.guard.h >= 60, [ar.dash, ar.guard]);
  ok('🗺️ 지도로 복귀 버튼이 화면 안에 있다', ar.back.w > 60 && ar.back.y < 60, ar.back);
  ok('아군·적 병사가 아레나에 존재', ar.allies >= 3 && ar.enemies >= 1, [ar.allies, ar.enemies]);
  ok('전선 이름·적 병력 표시', ar.banner.length > 2 && ar.targetInfo.indexOf('적 병력') >= 0, [ar.banner, ar.targetInfo]);

  // 조이스틱: 왼쪽 절반 드래그
  const p0 = await page.evaluate(() => ({ x: window.TWArena.state().player.x, y: window.TWArena.state().player.y }));
  await page.mouse.move(90, 640);
  await page.mouse.down();
  await page.mouse.move(150, 560, { steps: 8 });
  await sleep(650);
  const joy = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      joyShown: !document.getElementById('arJoy').className.includes('hidden'),
      mag: st.input.mag,
      x: st.player.x, y: st.player.y
    };
  });
  await page.mouse.up();
  const moved = Math.hypot(joy.x - p0.x, joy.y - p0.y);
  ok('왼쪽 드래그로 조이스틱이 뜨고 병사가 움직인다', joy.joyShown && joy.mag > 0.2 && moved > 12,
    { joy, moved: Math.round(moved) });

  // 적을 플레이어 앞으로 끌어와 연속 베기 → 두 동강 조각 검증
  const cut = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.forEach((e) => { e.dead = true; });
    st.enemies.length = 0;
    st.enemySpawned = st.enemyTotal; // 추가 스폰 멈춤
    st.enemyTotal = st.enemySpawned + 9999; // 한 방에 다 베어도 승리로 끝나지 않게 (수정판은 전멸하면 정말 끝난다)
    st.spawnTimer = 9e9; st.spawnMs = 9e9;
    st.winAt = 0;
    st.player.x = 180; st.player.y = 380;
    st.player.face = 0;
    st.player.atkCd = 0;
    st.player.dash = 0;
    st.player.hp = st.player.maxHp;
    st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    // 정면에 체력 낮은 적 4명 배치
    for (let i = 0; i < 4; i++) {
      st.enemies.push({
        team: 'enemy', x: 180 + 30 + i * 8, y: 380 + (i - 1.5) * 10,
        r: 8.4, hp: 20, maxHp: 76, speed: 0.0001, face: Math.PI, cd: 99999, wind: 0,
        swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null, dashHit: false, wob: 0
      });
    }
    return { kills: st.kills, corpses: st.corpses.length };
  });
  await page.click('#arSlash');
  // 칼날이 적을 지나가는 순간 판정된다 — 고정 시간 대신 '베임'을 기다린다 (느린 2D 캔버스에서도 안정적)
  await page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.kills > k;
  }, { timeout: 5000, polling: 16 }, cut.kills).catch(() => {});
  await sleep(40);
  const afterSlash = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills,
      corpses: st.corpses.map((c) => ({ side: c.side, cut: c.cut, life: c.life, r: c.r })),
      cuts: st.cuts.length,
      lastImpactAt: st.lastImpactAt,
      shake: st.shake,
      slashes: st.slashes.length
    };
  });
  ok('⚔️ 베기 한 번에 정면 적이 베인다', afterSlash.kills > cut.kills, [cut.kills, afterSlash.kills]);
  ok('베인 적은 정확히 두 조각으로 갈라진다 (2조각/1명)', afterSlash.corpses.length === (afterSlash.kills - cut.kills) * 2,
    afterSlash.corpses.length);
  ok('두 조각의 절단각이 같고 플레이어 칼 각도(0rad)와 일치한다',
    afterSlash.corpses.length > 0 && afterSlash.corpses.every((c) => Math.abs(c.cut) < 0.001),
    afterSlash.corpses.map((c) => c.cut));
  ok('조각이 좌/우 반쪽으로 하나씩 생긴다',
    afterSlash.corpses.length % 2 === 0 &&
    new Set(afterSlash.corpses.map((c) => c.side)).size === 2, afterSlash.corpses.map((c) => c.side));
  ok('절단 섬광선이 그려진다', afterSlash.cuts > 0, afterSlash.cuts);
  ok('타격감(히트스톱)이 발생한다', typeof afterSlash.lastImpactAt === 'number' && afterSlash.lastImpactAt > 0,
    afterSlash.lastImpactAt);

  await page.screenshot({ path: path.join(SHOTS, '13-arena-slash.png') });

  // 두 동강 장면 확대 컷
  const zoomBox = await page.evaluate(() => {
    const st = window.TWArena.state();
    const c = st.corpses[0];
    const x = st.offX + c.x * st.scale;
    const y = st.offY + c.y * st.scale;
    return { x: Math.max(0, x - 110), y: Math.max(0, y - 95), width: 220, height: 190 };
  });
  await page.screenshot({ path: path.join(SHOTS, '15-arena-split-zoom.png'), clip: zoomBox });

  // 조각이 갈라져 날아가고 0.8~1초 뒤 사라지는지
  await sleep(260);
  const mid = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { corpses: st.corpses.map((c) => ({ x: c.x, y: c.y, rot: c.rot, life: c.life })) };
  });
  ok('조각이 서로 반대 방향으로 벌어진다',
    mid.corpses.length >= 2 && (mid.corpses[0].x !== mid.corpses[1].x || mid.corpses[0].y !== mid.corpses[1].y),
    mid.corpses.slice(0, 2));
  ok('조각이 회전하며 날아간다', mid.corpses.every((c) => c.rot !== 0), mid.corpses.map((c) => c.rot));
  await sleep(1000);
  const gone = await page.evaluate(() => window.TWArena.state().corpses.length);
  ok('0.95초 뒤 조각이 사라진다', gone === 0, gone);

  // 돌진 베기
  const dashBefore = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.player.atkCd = 0; st.player.dashCd = 0; st.player.face = Math.PI / 2;
    st.enemies.push({
      team: 'enemy', x: st.player.x, y: st.player.y + 34, r: 8.4, hp: 15, maxHp: 76,
      speed: 0.0001, face: Math.PI, cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0,
      dead: false, lastHitBy: null, dashHit: false, wob: 0
    });
    return { kills: st.kills };
  });
  await page.click('#arDash');
  await sleep(260);
  const dashAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { kills: st.kills, corpses: st.corpses.length, cuts: st.cuts.map((c) => c.ang) };
  });
  ok('💨 돌진 베기로도 적이 베인다', dashAfter.kills > dashBefore.kills, [dashBefore.kills, dashAfter.kills]);
  ok('돌진으로 베인 적도 두 동강 · 돌진 방향으로 절단',
    dashAfter.corpses >= 2 && dashAfter.cuts.every((a) => Math.abs(a - Math.PI / 2) < 0.001),
    dashAfter.cuts);

  // 대각선 베기 — 두 조각이 칼날 수직으로 갈라지는지 (증거 컷)
  const diag = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0;
    st.corpses.length = 0;
    st.cuts.length = 0;
    st.player.x = 140; st.player.y = 320;
    st.player.face = 0.62;
    st.player.atkCd = 0;
    st.player.dash = 0;
    st.player.hp = st.player.maxHp;
    st.down = 0;
    document.getElementById('arDown').classList.add('hidden');
    st.enemies.push({
      team: 'enemy', x: 140 + Math.cos(0.62) * 30, y: 320 + Math.sin(0.62) * 30,
      r: 9.2, hp: 8, maxHp: 76, speed: 0.0001, face: 0.62 + Math.PI,
      cd: 99999, wind: 0, swing: 0, hit: 0, stun: 0, dead: false, lastHitBy: null,
      dashHit: false, wob: 0
    });
    return { kills: st.kills };
  });
  await page.click('#arSlash');
  // 베기는 칼날이 적을 지나가는 순간 판정된다 — 느린 환경에서도 확실히 기다린다
  const diagHit = await page.waitForFunction((k) => {
    const st = window.TWArena.state();
    return st && st.kills > k && st.corpses.length >= 2;
  }, { timeout: 5000, polling: 16 }, diag.kills).then(() => true).catch(() => false);
  const diagAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return {
      kills: st.kills,
      pieces: st.corpses.map((c) => ({ side: c.side, cut: c.cut, x: c.x, y: c.y, rot: c.rot })),
      cuts: st.cuts.map((c) => c.ang),
      scale: st.scale, offX: st.offX, offY: st.offY,
      px: st.player.x, py: st.player.y
    };
  });
  ok('대각선(0.62rad) 베기에서도 두 조각', diagHit && diagAfter.pieces.length === 2 && diagAfter.kills > diag.kills,
    { pieces: diagAfter.pieces.length, hit: diagHit });
  const cutAng = 0.62;
  ok('조각의 절단각이 칼 각도와 같다',
    diagAfter.pieces.every((c) => Math.abs(c.cut - cutAng) < 0.001),
    diagAfter.pieces.map((c) => c.cut));
  if (diagAfter.pieces.length === 2) {
    const a = diagAfter.pieces[0], b = diagAfter.pieces[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const perp = Math.abs((dx * Math.cos(cutAng) + dy * Math.sin(cutAng)) /
      Math.max(0.0001, Math.hypot(dx, dy)));
    ok('두 조각이 칼날 수직 방향으로 갈라진다', Math.abs(perp) < 0.35, perp);
  }
  const zx = diagAfter.offX + diagAfter.px * diagAfter.scale;
  const zy = diagAfter.offY + diagAfter.py * diagAfter.scale;
  await page.screenshot({
    path: path.join(SHOTS, '16-arena-diagonal-split.png'),
    clip: { x: Math.max(0, zx - 105), y: Math.max(0, zy - 105), width: 210, height: 210 }
  });

  // 막기 · 패링
  const guardInfo = await page.evaluate(() => {
    const st = window.TWArena.state();
    st.enemies.length = 0;
    st.player.guard = false;
    return { hp: st.player.hp };
  });
  const gbox = await page.evaluate(() => {
    const r = document.getElementById('arGuard').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(gbox.x, gbox.y);
  await page.mouse.down();
  await sleep(60);
  const guarding = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { guard: st.player.guard, cls: document.getElementById('arGuard').className };
  });
  await page.mouse.up();
  ok('🛡️ 막기 버튼으로 방어 자세', guarding.guard === true && guarding.cls.indexOf('on') >= 0, guarding);

  // 지도 복귀
  await page.click('#arBack');
  await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 6000 });
  const toastOk = await page.waitForFunction(() =>
    (document.getElementById('toast') || {}).textContent.indexOf('전선 결과') >= 0, { timeout: 4000 })
    .then(() => true).catch(() => false);
  await sleep(700);
  const back = await page.evaluate(() => ({
    open: window.TWArena.isOpen(),
    state: !!window.__TW__.state(),
    toast: (document.getElementById('toast') || {}).textContent || ''
  }));
  ok('🗺️ 지도로 복귀하면 아레나가 닫히고 지도로 돌아온다', !back.open && back.state, back);
  ok('복귀 후 전선 결과 토스트가 뜬다', toastOk, back.toast);

  const killsNow = await page.evaluate(() => {
    const s = window.__TW__.state();
    return { stats: s.stats, troops: s.regions.map((r) => r.troops) };
  });
  ok('지도 상태에 참전 전적(킬)이 기록된다', killsNow.stats.skirmishKills >= 2, killsNow.stats);

  await page.screenshot({ path: path.join(SHOTS, '14-back-to-map.png') });

  /* ============ 아레나 HUD·판정 수정 검증 (2D) ============ */
  // 🔁 다시 싸우기가 보이는 혼자 싸우기 판으로 열어 두 버튼의 실제 좌표를 본다
  await page.evaluate(() => { window.__endReason = null; window.__clearInfo = null; window.__deadResidue = false; });
  const soloOpen = await page.evaluate(() => window.TWArena.open({
    id: 'fix2d', seed: 5150, solo: true, w: 280, h: 600, enemyCount: 10, allyCount: 6, allyStart: 6,
    allyMs: 300, spawnMs: 300, timeLimit: 9e9, maxKills: 10, force2d: true,
    me: { name: '한윤', color: '#3b82f6' }, enemy: { name: '적', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '적', troops: 10 }
  }, { onEnd: function (reason) { window.__endReason = reason; } }));
  await sleep(600);
  ok('[수정판] 혼자 싸우기 판 개시 (🎬 관전 · 🔁 다시 싸우기 둘 다 보이는 상태)',
    soloOpen === true && await page.evaluate(() => {
      const a = document.getElementById('arView'), b = document.getElementById('arRestart');
      return !!(a && b) && a.getBoundingClientRect().height > 20 &&
        getComputedStyle(b).display !== 'none';
    }));

  const measure = () => page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hitEl = document.elementFromPoint(cx, cy);
      return {
        id: id, text: el.textContent.trim(),
        x: +b.left.toFixed(1), y: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
        visible: cs.display !== 'none' && b.width > 20 && b.height > 20,
        hit: !!hitEl && (hitEl === el || el.contains(hitEl))
      };
    };
    const overlapOf = (a, b) => {
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return (ox > 0.5 && oy > 0.5) ? Math.round(ox * oy) : 0;
    };
    const view = box('arView'), again = box('arRestart'), back = box('arBack');
    return {
      view: view, again: again, back: back, vw: innerWidth, vh: innerHeight,
      overlap: overlapOf(view, again) + overlapOf(view, back) + overlapOf(again, back),
      inside: [view, again].every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= innerWidth && b.y + b.h <= innerHeight)
    };
  });
  const wide = await measure();
  ok('[🎬 관전] · [🔁 다시 싸우기] 버튼이 겹치지 않고 각자 눌린다 (390×844)',
    wide.view.visible && wide.again.visible && wide.view.hit && wide.again.hit &&
    wide.overlap === 0 && wide.inside && wide.again.y >= wide.view.y + wide.view.h - 0.5, wide);
  await page.screenshot({ path: path.join(SHOTS, '18-fix-buttons-portrait.png') });

  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(500);
  const narrow = await measure();
  ok('좀은 화면(320×568)에서도 두 버튼이 겹치지 않는다',
    narrow.view.visible && narrow.again.visible && narrow.overlap === 0 && narrow.inside &&
    narrow.again.y >= narrow.view.y + narrow.view.h - 0.5, narrow);
  await page.screenshot({ path: path.join(SHOTS, '19-fix-buttons-narrow.png') });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(400);

  // 아군은 고른 수(6)까지만 — 다 죽어도 새로 생기지 않는다
  const allyCounted = await page.evaluate(() => {
    const st = window.TWArena.state();
    for (let i = 0; i < st.allies.length; i++) st.allies[i].dead = true;   // 아군 전멸
    return { spawned: st.allySpawned, total: st.allyTotal, alive: st.allies.length };
  });
  await sleep(2000);
  const allyAfter = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { spawned: st.allySpawned, total: st.allyTotal, alive: st.allies.length };
  });
  ok('아군은 고른 수(6)까지만 증원되고, 전멸해도 그 이상 새로 생기지 않는다',
    allyCounted.total === 6 && allyAfter.spawned === 6 && allyAfter.alive === 0,
    { before: allyCounted, after: allyAfter });

  // 같은 판을 다시 열어, 살아 있는 아군 손으로 적을 전멸시킨다
  await page.evaluate(() => { window.__endReason = null; window.__clearInfo = null; window.__deadResidue = false; });
  await page.evaluate(() => window.TWArena.open({
    id: 'fix2d-win', seed: 5151, solo: true, w: 280, h: 600, enemyCount: 10, allyCount: 6, allyStart: 6,
    allyMs: 300, spawnMs: 300, timeLimit: 9e9, maxKills: 10, force2d: true,
    me: { name: '한윤', color: '#3b82f6' }, enemy: { name: '적', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '적', troops: 10 }
  }, { onEnd: function (reason) { window.__endReason = reason; } }));
  await sleep(500);

  // 적을 아군 없이 플레이어가 아닌 아군 손으로 전멸시킨다
  const cleared = await page.waitForFunction(() => {
    const st = window.TWArena.state();
    if (!st) return true;
    if (st.enemies.some((e) => e.dead)) window.__deadResidue = true;
    st.spawnTimer = 0; st.allyTimer = 0;
    st.player.hp = st.player.maxHp; st.invuln = 9e9;
    for (const e of st.enemies) {
      e.hp = 1; e.stun = 99999; e.speed = 0.0001;
      if (Math.hypot(e.x - st.player.x, e.y - st.player.y) > 150) {
        e.x = st.player.x + (Math.random() - 0.5) * 100;
        e.y = st.player.y + (Math.random() - 0.5) * 100;
      }
    }
    const done = st.enemySpawned >= st.enemyTotal && st.defeated >= st.enemyTotal && st.enemies.length === 0;
    if (done && !window.__clearInfo) {
      window.__clearInfo = { defeated: st.defeated, killed: st.kills,
        enemyLeft: (document.getElementById('arEnemyLeft') || {}).textContent };
    }
    return done;
  }, { timeout: 120000, polling: 120 }).then(() => true).catch(() => false);
  const winOk = await page.waitForFunction(() => !!window.__endReason, { timeout: 20000, polling: 50 })
    .then(() => true).catch(() => false);
  const winInfo = await page.evaluate(() => ({
    reason: window.__endReason, clear: window.__clearInfo, residue: window.__deadResidue,
    title: (document.getElementById('arResultTitle') || {}).textContent
  }));
  ok('적을 모두 쓰러뜨리면 게임이 승리로 끝난다 — 플레이어 0베기여도 끝난다',
    cleared && winOk && winInfo.reason === 'win' && winInfo.clear && winInfo.clear.killed === 0, winInfo);
  ok('전멸 순간 남은 적 표시 “적 0” · 쓰러진 병사가 목록에 남지 않는다',
    !!winInfo.clear && winInfo.clear.enemyLeft === '적 0' && winInfo.residue === false, winInfo);
  await page.screenshot({ path: path.join(SHOTS, '20-fix-win-result.png') }).catch(() => {});
  await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 15000 }).catch(() => {});

  /* ============ 큰 망치 중갑 장군 (2D 폴백) ============ */
  console.log('큰 망치 장군 · 2D');
  await page.evaluate(() => { try { window.TWArena.close(); } catch (e) {} window.__endReason = null; });
  await sleep(900);
  await page.evaluate(() => window.TWArena.open({
    id: 'gen2d', seed: 8181, solo: true, w: 280, h: 600, enemyCount: 12, allyCount: 4, allyStart: 4,
    allyGenerals: 3, enemyGenerals: 2, playerClass: 'general', playerHpGeneral: 500,
    spawnMs: 400, allyMs: 500, timeLimit: 9e9, maxKills: 12, force2d: true,
    me: { name: '한윤', color: '#3b82f6' }, enemy: { name: '적', color: '#ef4444' },
    region: { name: '송천' }, target: { name: '적', troops: 12 }
  }, { onEnd: function (r) { window.__endReason = r; } }));
  await sleep(700);
  const gen2d = await page.evaluate(() => {
    const g = window.TWArena.general();
    const st = window.TWArena.state();
    return {
      g: g, hp: st.player.hp, maxHp: st.player.maxHp, kind: st.player.kind,
      cls: document.getElementById('arena').className,
      guard: getComputedStyle(document.getElementById('arGuard')).display,
      dash: getComputedStyle(document.getElementById('arDash')).display,
      btn: document.getElementById('arSlash').textContent.replace(/\s+/g, '')
    };
  });
  ok('아군·적군 큰 망치 장군이 고른 수(3·2)만큼 서고 스펙이 완전히 같다 (체력 500)',
    gen2d.g.allyTotal === 3 && gen2d.g.enemyTotal === 2 && gen2d.g.allyAlive === 3 && gen2d.g.enemyAlive === 2 &&
    gen2d.g.spec.hp === 500 && gen2d.g.spec.dmg === 100 && gen2d.g.spec.scale === 1.45, gen2d.g);
  ok('🔨 장군으로 참전 — 피통 500 · 내려치기 버튼 · 막기/돌진 버튼 숨김',
    gen2d.kind === 'general' && gen2d.hp === 500 && gen2d.maxHp === 500 &&
    gen2d.cls.indexOf('arena-general') >= 0 && gen2d.guard === 'none' && gen2d.dash === 'none' &&
    gen2d.btn.indexOf('내려치기') >= 0 && gen2d.btn.indexOf('🔨') >= 0, gen2d);

  // 앞쪽에 적 병사 5명 + 적 장군을 세우고 망치 내려치기 한 방
  await page.evaluate(() => {
    const st = window.TWArena.state();
    const mk = (kind, x, y) => ({
      team: 'enemy', kind: kind, x: x, y: y, r: kind === 'general' ? 13.05 : 9,
      hp: kind === 'general' ? 500 : 100, maxHp: kind === 'general' ? 500 : 100,
      dmg: kind === 'general' ? 100 : 10, speed: 40, face: -Math.PI / 2, cd: 400, wind: 0, swing: 0,
      hit: 0, stun: 0, dead: false, counted: false, wob: 0, slot: 0, dashHit: false
    });
    st.enemies.length = 0;
    for (let i = 0; i < 5; i++) st.enemies.push(mk('soldier', st.player.x + (i - 2) * 20, st.player.y + 48));
    st.enemies.push(mk('general', st.player.x, st.player.y + 60));
    st.enemySpawned = st.enemyTotal; st.enemyGenSpawned = st.enemyGenTotal;
    st.player.face = Math.PI / 2; st.player.atkCd = 0; st.invuln = 9e9;
  });
  await sleep(120);
  await page.evaluate(() => {
    document.getElementById('arSlash').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await sleep(500);
  const slam2d = await page.evaluate(() => {
    const st = window.TWArena.state();
    const gen = st.enemies.find((e) => e.kind === 'general');
    return {
      defeated: st.defeated, shocks: st.shocks.length, cracks: st.cracks.length,
      left: document.getElementById('arEnemyLeft').textContent,
      genHp: gen ? gen.hp : null, enemies: st.enemies.length,
      cleared: window.TWArena.general().cleared
    };
  });
  ok('한 번 내려치면 앞쪽 적 병사들이 한꺼번에 날아간다 (광역 강타 · 다수 처치)',
    slam2d.defeated >= 4, slam2d);
  ok('망치 강타에 바닥 충격파 링·균열이 터진다', slam2d.shocks >= 1 && slam2d.cracks >= 1, slam2d);
  ok('적 장군은 한 방에 죽지 않고 피통이 100 깎인다 (500→400)', slam2d.genHp === 400, slam2d);
  ok('적 병사가 다 죽어도 적 장군이 살아 있으면 승리(전멸)가 아니다', slam2d.cleared === false, slam2d);
  await page.screenshot({ path: path.join(SHOTS, '21-general-2d.png') }).catch(() => {});

  // 적 장군을 마저 쓰러뜨리면 전멸 → 승리 판정
  await page.evaluate(() => {
    const st = window.TWArena.state();
    const gen = st.enemies.find((e) => e.kind === 'general');
    if (gen) {
      gen.hp = 100; gen.stun = 9e9; gen.cd = 9e9;
      gen.x = st.player.x; gen.y = st.player.y + 60;
    }
    st.player.face = Math.PI / 2; st.player.atkCd = 0;
    st.player.x = gen ? gen.x : st.player.x;
    st.player.y = gen ? gen.y - 60 : st.player.y;
    st.enemies.forEach((e) => { if (e.kind !== 'general') { e.dead = true; e.counted = true; } });
  });
  await sleep(120);
  await page.evaluate(() => {
    document.getElementById('arSlash').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await sleep(900);
  const killGen = await page.evaluate(() => {
    const st = window.TWArena.state();
    return { enemies: st.enemies.length, defeated: st.defeated, cleared: window.TWArena.general().cleared,
      wins: window.__endReason };
  });
  ok('적 장군까지 쓰러뜨리면 전멸 판정이 서고 승리로 끝난다 (적 일반 병사 + 적 장군 모두)',
    killGen.enemies === 0 && killGen.cleared === true, killGen);
  await page.waitForFunction(() => !window.TWArena.isOpen(), { timeout: 15000 }).catch(() => {});

  ok('콘솔 · 페이지 오류 0', errors.length === 0, errors.slice(0, 5));

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (failed.length ? '실패 ' + failed.length + '개 / ' : '') + '총 ' + results.length + '개 확인');
  await browser.close();
  stop();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('검증 스크립트 오류:', e && e.stack || e);
  process.exit(1);
});
