'use strict';

/* 영토 전쟁 ONLINE · 직접 참전(칼질 아레나) 모바일 뷰포트 검증
   - 390×844 터치 뷰포트에서 참전 버튼 → 아레나 진입 → 조이스틱/버튼/베기
   - 베인 적이 칼 각도대로 두 조각으로 갈라지는지(corpses) 프로그램 검증
   - 콘솔/페이지 오류 0, 캔버스 크기, 스크린샷 저장 */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = '/workspace/territory-war-online';
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 3577;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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

  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle2', timeout: 60000 });
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
  await sleep(120);
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
  await sleep(70);
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
  ok('대각선(0.62rad) 베기에서도 두 조각', diagAfter.pieces.length === 2 && diagAfter.kills > diag.kills,
    diagAfter.pieces.length);
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
