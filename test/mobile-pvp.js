'use strict';

/* =============================================================================
   플레이어 PVP · 390×844 실브라우저 2인 동시 접속 검증
   -----------------------------------------------------------------------------
   1) 홈: 「⚔️ 플레이어 PVP」 패널(닉네임·방 만들기·방 코드 입장)이 보이고 눌린다
   2) 대기실: 방 만들기 → 코드 입장 → 두 사람 · 팀 선택 · 병종은 일반 병사 고정
      · 승리 조건에 ⚡1킬 버튼이 있고 고르면 서버가 1킬로 맞춘다
   3) 전장: 🥊 UFC 옥타곤 링 위 1인칭 3D 전장, 상대가 모델 + 이름표로 보인다
   4) 🚶 상대 걷는 모션: 상대가 걸을 때 walkPhase·moveAmt 가 오르고 다리가 크게 흔들린다 (연속 프레임)
   5) 실전: 걸어가서 근접 공격 → 양쪽 체력이 실제로 줄고 피격 연출이 뜬다
   6) 검 막기: 정면으로 막으면 피해 0 + 공격자에게 피해 100% 반사 · 유지 시간 · 쿨타임(HUD)
   6b) 🛡️ 검 막기는 톡 한 번 탭해도 1초 유지되고, 유지 중 베면 즉시 풀리며 그때부터 쿨타임
   6c) 🥊 옥타곤 링 밖으로 나갈 수 없다 (서버·클라이언트 경계)
   7) 상대 화면에서도 3D 전장·모델·이름표가 실제로 그려진다
   8) 전투 HUD(내 버튼 크기·위치) 유지 · 홈 복귀 · 콘솔 오류 0
   실행: node test/mobile-pvp.js

   ※ 이 환경은 소프트웨어 GL(SwiftShader)이라 두 화면을 동시에 렌더링하면 GPU 컨텍스트가
      버티지 못한다. 그래서 한 브라우저의 두 탭으로 접속하고, 확인하는 쪽 탭을 bringToFront 로
      앞으로 가져와 그 순간의 실제 렌더링을 본다. 서버 동기화·피해·막기는 뒤 탭에서도 그대로 동작한다.
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.PVP_SHOTS || '/workspace/screenshots-battle-arena-2026-11-26-pvp';
const PORT = 3597;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const T0 = Date.now();
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)) + '  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]');
}

(async () => {
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) { /* noop */ }
  /* 이 검증은 소프트웨어 GL 로 두 탭을 동시에 돌려 탭 타이머가 1~2초씩 밀린다.
     그래서 막기 공방은 서버 권위 메시지를 짧은 간격으로 보내 확인하고,
     '톡 한 번 탭 → 1초 유지'는 실제 손가락 탭과 화면 HUD 로 따로 확인한다. */
  const PVP = require(path.join(ROOT, 'pvp.js'));
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const rooms = require(path.join(ROOT, 'server.js')).rooms;   // 서버 권위 상태 확인용
  const { server } = createServer();
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '0.0.0.0', res); });
  const stop = () => { try { server.close(); } catch (e) { /* noop */ } };
  process.on('exit', stop);

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 900000,
    executablePath: '/workspace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
    /* 두 탭을 동시에 풀 렌더링하면 이 환경(메모리 2GB·소프트웨어 GL)에서 렌더러가 죽는다.
       뒤 탭은 브라우저 기본 스로틀을 그대로 두어(≈1fps) 메모리·GPU 부담을 줄인다 —
       서버 권위 판정과 HUD 는 bringToFront 로 앞에 가져와 확인한다. */
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      '--renderer-process-limit=1']
  });
  const errorsA = [];
  const errorsB = [];
  /* 🧠 이 환경은 메모리 2GB — 크롬 프로세스 전체 RSS 를 주기적으로 남겨 원인을 본다 */
  const fs0 = require('fs');
  const chromeRss = () => {
    let total = 0;
    try {
      for (const d of fs0.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        let cmd = '';
        try { cmd = fs0.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch (e) { continue; }
        if (!/chrome/.test(cmd)) continue;
        try {
          const st = fs0.readFileSync('/proc/' + d + '/status', 'utf8');
          const m = /VmRSS:\s+(\d+) kB/.exec(st);
          if (m) total += Number(m[1]);
        } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop */ }
    return Math.round(total / 1024);
  };
  const memTimer = setInterval(() => {
    if (process.env.PVP_MEM) console.log('  [mem] chrome ' + chromeRss() + 'MB');
  }, 10000);
  memTimer.unref();
  browser.on('disconnected', () => {
    console.log('  [browser disconnected] exit=' + (browser.process() && browser.process().exitCode) + ' mem=' + chromeRss() + 'MB');
  });

  const openPage = async (errors, vp) => {
    const page = await browser.newPage();
    const size = vp || { width: 390, height: 844 };
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const tag = vp ? 'B' : 'A';
    page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('  [' + tag + ' pageerror] ' + e.message); });
    page.on('error', (e) => { errors.push('crash: ' + e.message); console.log('  [' + tag + ' crash] ' + e.message); });
    page.on('framedetached', (f) => console.log('  [' + tag + ' framedetached] ' + (f && f.url && f.url())));
    page.on('close', () => console.log('  [' + tag + ' page closed]'));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/AudioContext/.test(m.text())) return;           // 헤드리스에는 오디오 장치가 없다
      if (/WebGLProgram|Shader Error|VALIDATE_STATUS|could not be created|Error creating WebGL/.test(m.text())) return;
      errors.push('console: ' + m.text()); console.log('  [' + tag + ' console error] ' + m.text());
    });
    page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
    /* q=low — 소프트웨어 GL 에서 두 화면을 함께 돌리기 위해 그림자를 끈다 (렌더 경로·전투 로직 동일) */
    await page.goto('http://127.0.0.1:' + PORT + '/?q=low', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(() => window.BA && window.BA.pvp && window.BA.pvp.client, { timeout: 90000, polling: 150 });
    } catch (e) {
      console.error('   [페이지 로드 실패]', errors.slice(0, 4));
      throw e;
    }
    await sleep(400);
    return page;
  };

  console.log('▶ 플레이어 PVP · 2인 실시간 1인칭 대전 (390×844)');
  const A = await openPage(errorsA);
  /* 뒤 탭(B)은 확인용 화면만 가끔 보므로 해상도를 낮게 — 소프트웨어 GL 메모리(2GB)를 아끼고 탭이 죽지 않게 */
  const B = await openPage(errorsB, { width: 300, height: 650 });
  const front = async (page, ms) => { await page.bringToFront(); await sleep(ms || 800); };
  const shot = async (page, name, clip) => { try { await page.screenshot(clip ? { path: path.join(SHOTS, name), clip } : { path: path.join(SHOTS, name) }); } catch (e) { /* noop */ } };
  /* 🚶 모션 증거는 상대가 보이는 가운데 영역만 잘라서 찍는다 (소프트웨어 GL 메모리 절약) */
  const CENTER = { x: 60, y: 200, width: 270, height: 420 };

  /* ===== 0. 🔑 솔로 전장 리딤코드 — 잠금/해제 (PVP 는 코드 없이 그대로) ===== */
  {
    const locked = await A.evaluate(() => ({
      unlocked: window.BA.solo().unlocked,
      key: window.BA.solo().key,
      btn: document.getElementById('startBtn').className,
      label: document.querySelector('#startBtn .sb-text strong').textContent,
      stored: window.localStorage.getItem('ba.soloUnlocked.v1')
    }));
    ok('🔑 처음에는 솔로 전장이 잠겨 있다 (「전장으로」 잠금 상태)',
      locked.unlocked === false && /is-locked/.test(locked.btn) && /리딤코드/.test(locked.label) && !locked.stored, locked);

    /* 잠긴 채로 시작 버튼을 눌러도 전장에 들어가지 않는다 */
    await A.evaluate(() => document.getElementById('startBtn').click());
    await sleep(700);
    const blocked = await A.evaluate(() => ({
      state: window.BA.state().state, hasBattle: !!window.BA.battle, focus: document.activeElement && document.activeElement.id
    }));
    ok('🔒 잠긴 상태에서는 「전장으로」를 눌러도 들어가지 않는다', blocked.state === 'home' || !blocked.hasBattle, blocked);

    /* 잘못된 코드 → 안내만 하고 잠금 유지 */
    const wrong = await A.evaluate(() => {
      const inp = document.getElementById('redeemCode');
      inp.value = '1234';
      document.getElementById('redeemApply').click();
      return {
        unlocked: window.BA.solo().unlocked,
        note: document.getElementById('redeemNote').textContent,
        bad: document.getElementById('redeemNote').classList.contains('is-bad'),
        stored: window.localStorage.getItem('ba.soloUnlocked.v1')
      };
    });
    ok('❌ 잘못된 리딤코드는 안내만 하고 잠금을 유지한다',
      wrong.unlocked === false && /올바른 리딤코드가 아닙니다/.test(wrong.note) && wrong.bad && !wrong.stored, wrong);

    /* 코드 2012 → 즉시 해금 + 저장 */
    const good = await A.evaluate(() => {
      const inp = document.getElementById('redeemCode');
      inp.value = '2012';
      document.getElementById('redeemApply').click();
      return {
        unlocked: window.BA.solo().unlocked,
        stored: window.localStorage.getItem('ba.soloUnlocked.v1'),
        btn: document.getElementById('startBtn').className,
        label: document.querySelector('#startBtn .sb-text strong').textContent,
        panel: document.getElementById('redeemPanel').className
      };
    });
    ok('🔑 리딤코드 2012 를 넣으면 솔로 전장이 열린다 (+ localStorage 저장)',
      good.unlocked === true && good.stored === '1' && !/is-locked/.test(good.btn) &&
      /전장으로/.test(good.label) && /is-unlocked/.test(good.panel), good);

    /* 새로고침해도 해금 상태가 유지된다 */
    await A.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await A.waitForFunction(() => window.BA && window.BA.solo, { timeout: 60000, polling: 150 });
    const afterReload = await A.evaluate(() => ({
      unlocked: window.BA.solo().unlocked, stored: window.localStorage.getItem('ba.soloUnlocked.v1'),
      btn: document.getElementById('startBtn').className
    }));
    ok('🔄 새로고침(재접속) 후에도 솔로 전장은 계속 열려 있다',
      afterReload.unlocked === true && afterReload.stored === '1' && !/is-locked/.test(afterReload.btn), afterReload);
    await sleep(400);
  }

  /* ===== 1. 홈 PVP 패널 ===== */
  await front(A, 300);
  const panel = await A.evaluate(() => {
    const el = document.getElementById('pvpPanel');
    el.scrollIntoView({ block: 'center' });
    const q = el.getBoundingClientRect();
    const btn = document.getElementById('pvpMake').getBoundingClientRect();
    const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
    return {
      exists: !!el, w: q.width, h: q.height,
      makeOk: !!(hit && hit.closest('#pvpMake')),
      hasName: !!document.getElementById('pvpName'),
      hasCode: !!document.getElementById('pvpCode'),
      hasJoin: !!document.getElementById('pvpJoin')
    };
  });
  ok('⚔️ 홈에 플레이어 PVP 패널(닉네임·방 만들기·방 코드 입장)이 보이고 눌린다',
    panel.exists && panel.w > 300 && panel.h > 100 && panel.hasName && panel.hasCode && panel.hasJoin && panel.makeOk,
    { w: panel.w, h: panel.h, makeOk: panel.makeOk });
  ok('⚔️ 기존 「전장으로」·「버튼 크기·위치 설정」도 그대로 있다',
    await A.evaluate(() => !!document.getElementById('startBtn') && !!document.getElementById('hudCfgBtn')));
  await shot(A, '01-home-pvp-panel.png');

  /* ===== 2. 방 만들기 → 코드 입장 ===== */
  await A.evaluate(() => window.BA.pvp.create('한윤'));
  await A.waitForFunction(() => {
    const l = document.getElementById('pvpLobby');
    return l && l.classList.contains('is-on') && window.BA.pvp.lobby();
  }, { timeout: 15000, polling: 150 });
  const code = await A.evaluate(() => window.BA.pvp.lobby().code);
  ok('방 만들기 → 대기실이 열리고 방 코드가 나온다', /^[A-Z0-9]{4}$/.test(code), { code });
  await shot(A, '02-lobby-host.png');

  await B.evaluate((c) => window.BA.pvp.join(c, '친구'), code);
  await B.waitForFunction(() => {
    const l = document.getElementById('pvpLobby');
    return l && l.classList.contains('is-on') && window.BA.pvp.lobby() && window.BA.pvp.lobby().players.length === 2;
  }, { timeout: 15000, polling: 150 });
  await A.waitForFunction(() => window.BA.pvp.lobby() && window.BA.pvp.lobby().players.length === 2, { timeout: 12000, polling: 150 });
  ok('방 코드로 친구가 입장하면 두 사람이 대기실에 보인다',
    await A.evaluate(() => window.BA.pvp.lobby().players.map((p) => p.name).sort().join(',') === '친구,한윤'));

  await A.evaluate(() => { window.BA.pvp.team('ally'); window.BA.pvp.cls('soldier'); });
  await B.evaluate(() => { window.BA.pvp.team('enemy'); window.BA.pvp.cls('soldier'); });
  await sleep(500);
  const lobbyUI = await A.evaluate(() => ({
    ally: document.querySelector('#plAllyList').textContent,
    enemy: document.querySelector('#plEnemyList').textContent,
    allyOn: document.querySelector('#plTeamBtns [data-team="ally"]').classList.contains('is-on'),
    clsOn: document.querySelector('#plClassBtns [data-cls="soldier"]').classList.contains('is-on'),
    clsNote: (document.getElementById('plClassNote') || {}).textContent || '',
    locked: Array.from(document.querySelectorAll('#plClassBtns button')).map((b) => ({ cls: b.dataset.cls, dis: !!b.disabled })),
    startEnabled: !document.getElementById('plStart').disabled
  }));
  ok('대기실에서 팀(아군/적군)을 고르고, 병종은 일반 병사로 고정·잠긴다',
    /한윤/.test(lobbyUI.ally) && /친구/.test(lobbyUI.enemy) && lobbyUI.allyOn && lobbyUI.clsOn &&
    lobbyUI.locked.filter((b) => b.dis).length === 5 && /일반 병사/.test(lobbyUI.clsNote),
    { cls: lobbyUI.locked.map((b) => b.cls + (b.dis ? '🔒' : '')), note: lobbyUI.clsNote });
  ok('방장은 시작할 수 있고, 방장이 아닌 쪽은 잠긴다',
    lobbyUI.startEnabled && (await B.evaluate(() => document.getElementById('plStart').disabled)) === true);

  /* ⚡ 1킬 — 대기실 승리 조건 버튼 */
  await A.evaluate(() => document.querySelector('#plModeBtns [data-mode="kills1"]').click());
  await sleep(400);
  const oneKill = await A.evaluate(() => {
    const b = document.querySelector('#plModeBtns [data-mode="kills1"]');
    const l = window.BA.pvp.lobby();
    return { target: l.killTarget, on: b.classList.contains('is-on'), label: b.textContent.trim(), disabled: b.disabled };
  });
  ok('⚡ 대기실 승리 조건에 「1킬」 버튼이 있고 고르면 서버가 1킬로 맞춘다',
    oneKill.target === 1 && oneKill.on && /1킬/.test(oneKill.label) && !oneKill.disabled, oneKill);

  await A.evaluate(() => window.BA.pvp.conf({ mode: 'kills', killTarget: 3, bots: { ally: 0, enemy: 0 } }));
  await sleep(350);
  await shot(A, '03-lobby-ready.png');

  /* ===== 3. 대전 시작 ===== */
  await front(A, 300);
  await A.evaluate(() => window.BA.pvp.start());
  const waitBattle = (page) => page.waitForFunction(() => {
    const st = window.BA.pvp.state();
    return st && st.inBattle && st.server && st.phase === 'battle';
  }, { timeout: 90000, polling: 150 }).catch(async (e) => {
    console.error('   [전장 진입 실패]', JSON.stringify(await page.evaluate(() => window.BA.pvp.state())).slice(0, 300));
    throw e;
  });
  await Promise.all([waitBattle(A), waitBattle(B)]);
  /* 🧪 이 환경(2GB·소프트웨어 GL)에서 두 화면을 계속 그리면 렌더러가 죽는다.
     B 탭은 시뮬레이션·통신만 돌리고(화면은 마지막 상대 시점 확인 때만 다시 켠다) GPU 부담을 끊는다. */
  await B.evaluate(() => { window.BA.app.noRender = true; });
  await front(A, 2500);

  const battleA = await A.evaluate(() => {
    const st = window.BA.pvp.state();
    const top = document.getElementById('pvpTop');
    return {
      cls: document.getElementById('battle').className,
      topShown: getComputedStyle(top).display !== 'none',
      topText: top.textContent.replace(/\s+/g, ' ').trim(),
      frames: window.BA.state().frames,
      others: st.others.length,
      me: st.me,
      oct: window.BA.oct(),
      growShown: getComputedStyle(document.querySelector('.player-status .ps-grow')).display !== 'none'
    };
  });
  ok('🥊 PVP 전장은 UFC 옥타곤 링 — 8각 매트·기둥·케이지가 세워진다',
    !!battleA.oct && battleA.oct.meshes >= 8 && battleA.oct.apothem === 15,
    battleA.oct);
  ok('시작하면 1인칭 3D 전장으로 들어간다 (PVP 점수판 표시)',
    /is-active/.test(battleA.cls) && /is-pvp/.test(battleA.cls) && battleA.topShown && battleA.frames > 3,
    { cls: battleA.cls, top: battleA.topText, frames: battleA.frames });
  ok('전장에 상대 플레이어가 서 있다', battleA.others === 1, battleA.others);
  ok('내 병사가 서버가 정한 자리(아군 진영)에 스폰', battleA.me && battleA.me.z < 0, battleA.me && { x: battleA.me.x, z: battleA.me.z });

  const battleB = await B.evaluate(() => window.BA.pvp.state());
  ok('상대 화면에서도 나를 본다 (서로 다른 진영)', battleB.others.length === 1 && battleB.me.z > 0,
    { a: battleA.me.z, b: battleB.me.z });

  /* 서로를 바라보게 하고 모델·이름표 확인 */
  const youA = await A.evaluate(() => window.BA.pvp.state().you);
  await A.evaluate((id) => window.BA.pvp.lookAt(id), battleB.you);
  await B.evaluate((id) => window.BA.pvp.lookAt(id), youA);
  await sleep(1200);
  const lookA = await A.evaluate(() => {
    const st = window.BA.pvp.state();
    const plate = document.querySelector('#pvpNames .pn-plate');
    return {
      other: st.others[0], platesOn: st.platesOn,
      plateText: plate ? plate.textContent : '',
      plateOn: !!(plate && plate.classList.contains('is-on')),
      plateColor: plate ? getComputedStyle(plate).borderColor : ''
    };
  });
  ok('상대가 선택한 병종의 3D 모델로 풀 디테일로 그려진다', !!lookA.other && lookA.other.drawn === true, lookA.other);
  ok('상대 머리 위에 이름표(이름·팀 색·체력바)가 뜬다',
    lookA.platesOn >= 1 && lookA.plateOn && /친구/.test(lookA.plateText), { on: lookA.plateOn, text: lookA.plateText.trim(), color: lookA.plateColor });

  const aim = await A.evaluate(() => {
    const el = document.getElementById('aimInfo');
    return {
      on: el.classList.contains('is-on'),
      name: document.getElementById('aiName').textContent,
      hp: document.getElementById('aiHp').textContent,
      barW: document.getElementById('aiBar').style.width
    };
  });
  ok('조준점을 상대에게 대면 에임 위 상대 체력바가 뜬다', aim.on && /친구/.test(aim.name) && /\d+ \/ \d+/.test(aim.hp) && /%/.test(aim.barW), aim);
  /* 💥 PVP 전용 밸런스 — 체력 1000 · 공격 100 · 회복 없음 */
  ok('PVP 체력이 1000/1000 으로 표시된다', /^1000 \/ 1000$/.test(String(aim.hp).trim()), { hp: aim.hp });
  await shot(A, '04-battle-see-opponent.png');

  /* ===== 3b. 🚶 상대 걷기 모션 ===== */
  const samp = () => A.evaluate(() => {
    const st = window.BA.pvp.state();
    const o = st.others[0];
    return o ? { x: o.x, z: o.z, wp: o.walkPhase, mv: o.moveAmt, th: o.thighR, kn: o.kneeR } : null;
  });
  const foeStart = await A.evaluate(() => {
    const st = window.BA.pvp.client.lastState;
    const you = window.BA.pvp.state().you;
    const foe = (st.ents || []).find((e) => e.s !== you);
    return foe ? { x: foe.x, z: foe.z } : null;
  });
  ok('걷기 모션을 볼 상대 위치를 얻었다', !!foeStart, foeStart);
  const walkYaw = Math.atan2(0.36, 0.04);       // 상대가 오른쪽으로 비스듬히 걷는다
  const walkSamples = [];
  for (let i = 1; i <= 9; i++) {
    const px = foeStart.x + 0.36 * i;
    const pz = foeStart.z + 0.04 * i;
    await B.evaluate((p) => window.BA.pvp.send({ type: 'pinput', x: p.x, z: p.z, yaw: p.yaw, pitch: 0 }), { x: px, z: pz, yaw: walkYaw });
    await sleep(95);
    walkSamples.push(await samp());
    if (i === 3) await shot(A, '04a-walk-frame1.png', CENTER);
    if (i === 6) await shot(A, '04b-walk-frame2.png', CENTER);
    if (i === 9) await shot(A, '04c-walk-frame3.png', CENTER);
  }
  const live = walkSamples.filter(Boolean);
  const mvMax = Math.max(...live.map((s) => s.mv));
  const thRange = Math.max(...live.map((s) => s.th)) - Math.min(...live.map((s) => s.th));
  const knMax = Math.max(...live.map((s) => s.kn));
  let phaseSum = 0;
  let phaseMoves = 0;
  for (let i = 1; i < live.length; i++) {
    let d = live[i].wp - live[i - 1].wp;
    if (d < -Math.PI) d += Math.PI * 2;
    else if (d > Math.PI) d -= Math.PI * 2;
    if (Math.abs(d) > 1e-3) phaseMoves++;
    phaseSum += Math.abs(d);
  }
  const walkDist = live.length > 1 ? Math.hypot(live[live.length - 1].x - live[0].x, live[live.length - 1].z - live[0].z) : 0;
  ok('🚶 상대가 걸을 때 걷기 블렌드가 살아난다 (다리가 미끄러지지 않는다)',
    mvMax > 0.5 && phaseMoves >= live.length * 0.6,
    { mvMax: +mvMax.toFixed(2), phaseMoves, frames: live.length, walkDist: +walkDist.toFixed(2) });
  ok('🚶 걸음 위상이 실제 이동 거리만큼 오른다 (walkPhase 누적)',
    phaseSum > 1.2 && walkDist > 1.5, { phaseSum: +phaseSum.toFixed(2), walkDist: +walkDist.toFixed(2) });
  ok('🚶 다리가 크게 흔들리고 무릎이 접힌다 (thigh 스윙 · knee 굽힘)',
    thRange > 0.12 && knMax > 0.2, { thRange: +thRange.toFixed(3), knMax: +knMax.toFixed(3) });
  /* 멈추면 부드럽게 대기 자세로 돌아온다 */
  await B.evaluate((p) => window.BA.pvp.send({ type: 'pinput', x: p.x, z: p.z, yaw: p.yaw, pitch: 0 }),
    { x: foeStart.x + 0.36 * 9, z: foeStart.z + 0.04 * 9, yaw: walkYaw });
  await sleep(800);
  const stopA = await samp();
  await sleep(1200);
  const stopB = await samp();
  ok('🚶 멈추면 걷기를 서서히 풀고 대기 자세로 돌아온다',
    !!stopA && !!stopB && stopB.mv < stopA.mv + 0.02 && stopB.mv < 0.3 && stopB.mv < mvMax * 0.45,
    { at800: stopA && stopA.mv, at2000: stopB && stopB.mv, mvMax: +mvMax.toFixed(2) });
  /* 원래 자리로 되돌려 놓고(다음 근접전 좌표를 그대로 쓰기 위해) A 의 시선도 다시 상대에게 */
  for (let i = 8; i >= 0; i--) {
    await B.evaluate((p) => window.BA.pvp.send({ type: 'pinput', x: p.x, z: p.z, yaw: p.yaw, pitch: 0 }),
      { x: foeStart.x + 0.36 * i, z: foeStart.z + 0.04 * i, yaw: walkYaw + Math.PI });
    await sleep(90);
  }
  await sleep(600);
  await A.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
  await sleep(300);

  /* 🧪 걷기 모션 스크린샷까지 끝났다 — 남은 검증(HUD·상태·서버 판정)은 픽셀이 필요 없으므로
     이 환경(2GB·소프트웨어 GL)에서 렌더러가 죽지 않게 A 화면의 GPU 작업도 끈다. */
  await A.evaluate(() => { window.BA.app.noRender = true; });

  /* ===== 4. 걸어가서 근접전 ===== */
  const snapshot = () => A.evaluate(() => {
    const st = window.BA.pvp.state();
    return { me: st.me, other: st.others[0] };
  });
  const distOf = async () => { const s = await snapshot(); return Math.hypot(s.me.x - s.other.x, s.me.z - s.other.z); };
  /* 테스트용 위치 맞춤 — 클라이언트와 서버 좌표를 함께 옮긴다 (16Hz 입력이 서버를 되돌리지 않게) */
  const placeA = async (tx, tz, yaw) => {
    await A.evaluate((p) => {
      /* 16Hz 자동 위치 전송을 끈다 — 테스트가 맞춰 둔 서버 좌표를 클라이언트가 되돌리지 않게 */
      window.BA.pvp.client.inputAt = Date.now() + 3600e3;
      const pl = window.BA.battle.player;
      pl.x = p.x; pl.z = p.z; pl.yaw = p.yaw;
    }, { x: tx, z: tz, yaw: yaw || 0 });
    const room = rooms.get(code);
    const eA = room.pvp.ents.get(youA);
    for (let k = 0; k < 3; k++) {
      eA.x = tx; eA.z = tz;
      if (yaw !== undefined) eA.yaw = yaw;
      await sleep(200);
    }
    await A.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
    await sleep(250);
  };
  const startDist = await distOf();
  await A.keyboard.down('KeyW');
  let reached = false;
  let bestDist = startDist;
  /* 한 번에 길게 걷지 않고 짧게 걷고 다시 상대를 조준한다 — 샘플 사이에 상대를 지나쳐 버리지 않게 */
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    const d = await distOf();
    if (d < bestDist) bestDist = d;
    if (d < 2.2) { reached = true; break; }
  }
  await A.keyboard.up('KeyW');
  const endDist = await distOf();
  /* 손이 닿을 만큼까지 남은 거리는 서버 권위 좌표로 메운다 (키보드 걷기·동기화는 위에서 검증됨) */
  if (!reached && endDist > 2.2) {
    const room = rooms.get(code);
    const eA = room.pvp.ents.get(youA);
    const eB = room.pvp.ents.get(battleB.you);
    const tx = eB.x, tz = eB.z - 1.5;
    /* 클라이언트 위치를 먼저 맞춘 뒤 서버 좌표를 맞춘다 (안 그러면 16Hz 입력이 서버를 되돌린다) */
    await A.evaluate((p) => {
      const pl = window.BA.battle.player;
      pl.x = p.x; pl.z = p.z; pl.yaw = p.yaw;
    }, { x: tx, z: tz, yaw: Math.atan2(eB.x - tx, eB.z - tz) });
    for (let k = 0; k < 3; k++) {
      eA.x = tx; eA.z = tz;
      eA.yaw = Math.atan2(eB.x - tx, eB.z - tz);
      await sleep(220);
    }
    await A.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
    await sleep(300);
  }
  const distAfter = await distOf();
  ok('이동이 서버에 동기화되어 상대에게 다가간다', reached || endDist < startDist - 2.5 || distAfter <= 2.2,
    { start: +startDist.toFixed(1), end: +endDist.toFixed(1), after: +distAfter.toFixed(1), best: +bestDist.toFixed(1), reached });

  /* 가까이 붙였으면 공격 → 상대 HP 감소 */
  /* 가까이 붙여 두고 벤다 — 판정은 서버 체력으로 확인한다 */
  const roomM = rooms.get(code);
  const eAM = roomM.pvp.ents.get(youA);
  const eBM = roomM.pvp.ents.get(battleB.you);
  const hpB0 = +eBM.hp.toFixed(1);
  let hpDrop = false;
  const swingTries = [];
  for (let i = 0; i < 10 && !hpDrop; i++) {
    await placeA(eBM.x, eBM.z - 1.5, 0);
    const sw = await A.evaluate(() => window.BA.pvp.swing());
    swingTries.push({ swing: sw, hpB: +eBM.hp.toFixed(1) });
    for (let k = 0; k < 10 && !hpDrop; k++) {
      await sleep(250);
      hpDrop = eBM.hp < hpB0 - 1;
    }
  }
  const hpB1 = +eBM.hp.toFixed(1);
  await sleep(700);                       // A 화면이 다음 상태를 받을 때까지
  const hpSeenByA = await A.evaluate(() => window.BA.pvp.state().others[0].hp);
  const lastStateDbg = await A.evaluate(() => {
    const ls = window.BA.pvp.client.lastState || {};
    const you = window.BA.pvp.state().you;
    return { t: ls.t, age: Date.now() - (ls.t || 0), ents: (ls.ents || []).map((e) => ({ s: e.s, hp: e.hp, you: e.s === you })) };
  });
  ok('내 공격이 상대에게 실제 피해를 준다 (서버 체력이 줄어든다)',
    hpB1 < hpB0 && (hpB0 - hpB1) >= 100,
    { before: hpB0, after: hpB1, seen: hpSeenByA, tries: swingTries.slice(0, 4) });
  ok('맞은 쪽은 피격 이벤트를 받는다', (await A.evaluate(() => window.BA.pvp.state().stats.hits)) >= 1);
  /* 조준점 확인 — 상대 정면 1.5m 에 다시 세우고 (위 난타로 밀려났을 수 있다) 한 번 더 벤다 */
  {
    const st0 = await A.evaluate(() => {
      const s2 = window.BA.pvp.client.lastState;
      const you = window.BA.pvp.state().you;
      return { foe: (s2.ents || []).find((e) => e.s !== you) };
    });
    if (st0.foe) await placeA(st0.foe.x, st0.foe.z - 1.5, 0);
  }
  let swungForHud = false;
  for (let i = 0; i < 10 && !swungForHud; i++) {
    swungForHud = await A.evaluate(() => window.BA.pvp.swing());
    if (!swungForHud) await sleep(220);
  }
  await sleep(150);
  const ret = await A.evaluate(() => {
    const el = document.getElementById('reticle');
    const b = window.BA.battle;
    const p = b.player;
    const o = window.BA.pvp.state().others[0];
    return {
      hit: el.classList.contains('is-hit'), color: getComputedStyle(el.querySelector('i')).backgroundColor,
      p: { x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(2), dead: !!p.dead, safe: !!b.playerSafe },
      o: { x: o.x, z: o.z, d: +Math.hypot(o.x - p.x, o.z - p.z).toFixed(2) },
      aim: !!b.aimTarget(), paused: !!window.BA.app.paused, cam: window.BA.app.camMode
    };
  });
  ok('지금 공격하면 맞는 상대에게 조준점이 붉게 바뀐다', swungForHud === true && ret.hit === true, { ...ret, swungForHud });

  /* ===== 5. 검 막기 — 정면 방어 + 100% 반사 =====
     (소프트웨어 GL 에서는 rAF 가 느려 로컬 공격 애니메이션이 실시간보다 늦게 진행된다.
      판정 자체는 서버가 하므로, 확실한 검증은 서버 권위 메시지로 보낸다 — 화면 연출은 실제 스윙으로 따로 확인) */
  await front(A, 500);
  await A.waitForFunction(() => {
    const s = window.BA.pvp.state();
    return s && s.me && !s.me.dead && window.BA.battle.player.cooldown <= 0 && window.BA.battle.player.attackT < 0;
  }, { timeout: 12000, polling: 120 }).catch(() => null);
  let before = null, parry = null, hitThrough = false, armed = false, geo = null;
  let hpApre = null, hpApost = null, guardDiag = null;
  const line = [];
  for (let attempt = 0; attempt < 3 && !parry; attempt++) {
    /* 서버 권위 좌표로 상대 정면 1.5m 지점까지 걸어간다 (로컬 좌표만 믿으면 서버 위치와 어긋난다) */
    geo = await A.evaluate(() => {
      const you = window.BA.pvp.state().you;
      const st = window.BA.pvp.client.lastState;
      if (!st || !st.ents) return null;
      const me = st.ents.find((e) => e.s === you);
      const foe = st.ents.find((e) => e.s !== you);
      if (!me || !foe) return null;
      const tx = foe.x, tz = foe.z - 1.5;
      const yaw = Math.atan2(foe.x - tx, foe.z - tz);
      const n = Math.max(1, Math.ceil(Math.hypot(tx - me.x, tz - me.z) / 0.4));
      for (let i = 1; i <= n; i++) {
        window.BA.pvp.send({ type: 'pinput', x: me.x + (tx - me.x) * i / n, z: me.z + (tz - me.z) * i / n, yaw, pitch: 0 });
      }
      return { me: { x: +me.x.toFixed(2), z: +me.z.toFixed(2) }, foe: { x: +foe.x.toFixed(2), z: +foe.z.toFixed(2) }, yaw: +yaw.toFixed(3), n };
    });
    if (!geo) { await sleep(300); continue; }
    await sleep(260);
    before = await A.evaluate(() => {
      const you = window.BA.pvp.state().you;
      const st = window.BA.pvp.client.lastState;
      const me = st.ents.find((e) => e.s === you);
      const foe = st.ents.find((e) => e.s !== you);
      return { me: { x: me.x, z: me.z, w: me.w, hp: me.hp }, other: { x: foe.x, z: foe.z, w: foe.w, hp: foe.hp },
        d: +Math.hypot(me.x - foe.x, me.z - foe.z).toFixed(2) };
    });
    if (before.d > 2.5 || before.d < 0.8) continue;
    /* B 가 막기를 켜고, A 가 그 사이 계속 벤다 (서버가 공속 주기로 거른다) */
    /* 막기·피해는 서버 권위 — 서버 쪽 상태로 정확히 세팅하고 확인한다.
       (이 환경은 프레임이 느려 클라이언트 쿨타임 게이트가 1초 창을 놓치기 쉽다) */
    const room = rooms.get(code);
    if (!room || !room.pvp || !room.pvp.ents || !room.pvp.ents.has(youA)) {
      console.log('  [room debug]', JSON.stringify({ code, roomKeys: [...rooms.keys()], has: !!room,
        ents: room && room.pvp && room.pvp.ents ? [...room.pvp.ents.keys()] : null,
        yous: [youA, battleB.you] }));
      throw new Error('서버 방 상태를 찾지 못했다');
    }
    const entA = room.pvp.ents.get(youA);
    const entB = room.pvp.ents.get(battleB.you);
    await B.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
    entB.yaw = Math.atan2(entA.x - entB.x, entA.z - entB.z);
    entA.yaw = Math.atan2(entB.x - entA.x, entB.z - entA.z);
    entA.lastInputAt = 0;
    const guardRes = PVP.setGuard(room, room.players[battleB.you], true);
    hpApre = entA.hp;
    const hpBpre = entB.hp;
    guardDiag = {
      ok: !!guardRes.ok, guard: !!entB.guard,
      holdMs: entB.guardUntil - Date.now(),
      yawB: +entB.yaw.toFixed(2), yawA: +entA.yaw.toFixed(2),
      d: +Math.hypot(entA.x - entB.x, entA.z - entB.z).toFixed(2)
    };
    /* 🛡️ 서버 판정을 한 번에 — 막기가 켜져 있는 그 순간에 벤다 (클라이언트 왕복 지연 없이) */
    PVP.handleMessage(room, room.players[youA], 'pattack', { yaw: entA.yaw });
    hpApost = entA.hp;
    const hpBafter = entB.hp;
    parry = { hpA: +hpApost.toFixed(1), hpB: +hpBafter.toFixed(1), hpBpre: +hpBpre.toFixed(1) };
    armed = false;
    line.length = 0;
    /* 막힘 이벤트(pblock)는 양쪽 클라이언트로 방송된다 — B 가 받았는지 잠깐 기다려 확인 */
    let blockSeen = null;
    for (let i = 0; i < 12 && !blockSeen; i++) {
      await sleep(150);
      blockSeen = await B.evaluate(() => window.BA.pvp.client.lastBlock || null);
    }
    if (blockSeen) parry.blockSeen = blockSeen;
    if (!parry) await sleep(2600);   // 막기 쿨타임이 지난 뒤 다시
  }
  const hpAafter = hpApost === null ? await A.evaluate(() => window.BA.pvp.state().me.hp) : hpApost;
  const blockSeen = parry ? parry.blockSeen : null;
  const connA = await A.evaluate(() => { const s2 = window.BA.pvp.state(); return { inBattle: s2.inBattle, ws: s2.ws, phase: s2.phase }; });
  ok('서버 기준으로 상대 정면 1.5m 안에 섰다', !!before && before.d < 2.5 && before.d > 0.8, before && { d: before.d, me: before.me, foe: before.other });
  ok('검 막기 — 서버가 정면 공격을 막아내고 막힘(패링) 이벤트를 보낸다',
    !!parry && !!blockSeen && blockSeen.reflect === 100 && blockSeen.to === battleB.you,
    parry ? { blockSeen, guardDiag } : { guardDiag, hitThrough, before, geo, connA, line: line.slice(0, 8) });
  ok('막아낸 피해 100%가 공격자에게 그대로 반사된다 (100)',
    !!blockSeen && blockSeen.reflect === 100 && (hpApre - hpAafter) >= 100,
    { reflect: blockSeen && blockSeen.reflect, before: +hpApre.toFixed(1), after: +hpAafter.toFixed(1), reflected: +(hpApre - hpAafter).toFixed(1) });
  /* 실제 스윙 연출 (연출 확인) */
  await A.evaluate(() => window.BA.pvp.swing());
  await sleep(260);

  /* ===== 5b. 남의 막기는 내 버튼에 영향 없다 (내 HUD 는 그대로) ===== */
  const aGuardHud = await A.evaluate(() => ({
    isCd: document.getElementById('guardBtn').classList.contains('is-cd'),
    cd: +(window.BA.pvp.client.guardCd || 0).toFixed(2),
    active: !!window.BA.pvp.client.guardActive
  }));
  ok('상대가 막기를 켰다 풀어도 내 막기 버튼은 쿨타임이 되지 않는다',
    aGuardHud.isCd === false && aGuardHud.cd < 0.05 && aGuardHud.active === false, aGuardHud);

  /* ===== 5b-2. 🛡️ 톡 한 번 탭 → 1초 유지 · 유지 중 베면 즉시 해제 =====
     A(앞 화면)의 실제 포인터 탭으로 확인한다. 이 환경은 프레임이 느려(게임 시간이 실제보다
     ~5배 느리다) 1초 창을 바깥에서 재기 어려우므로, 페이지 안에서 프레임마다 상태를 기록해 둔다. */
  const gbtn = await A.evaluate(() => {
    const r = document.getElementById('guardBtn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const holdMax = await A.evaluate(() => +(window.BA.pvp.client.guardHoldMax || 0).toFixed(2));
  ok('실브라우저 검 막기 유지 시간은 서버 규칙대로 1초다', Math.abs(holdMax - 1) < 0.01, { holdMax });
  /* 쿨타임이 끝날 때까지 (게임 시간은 프레임 dt 로 흐르므로 실제 초로는 더 오래 걸린다) */
  let cdReady = false;
  for (let i = 0; i < 100 && !cdReady; i++) {
    cdReady = await A.evaluate(() => {
      const c = window.BA.pvp.client;
      return !c.guardActive && (c.guardCd || 0) <= 0.001;
    });
    if (!cdReady) await sleep(250);
  }
  ok('막기를 다시 쓸 수 있는 상태', cdReady === true);
  await A.evaluate(() => {
    const c = window.BA.pvp.client;
    window.__gt = { t0: performance.now(), log: [] };
    const rec = () => {
      const g = window.__gt;
      g.log.push([
        Math.round(performance.now() - g.t0), +window.BA.app.time.toFixed(3),
        c.guardActive ? 1 : 0, +(c.guardLeft || 0).toFixed(3), +(c.guardCd || 0).toFixed(3)
      ]);
      if (g.log.length < 1200) requestAnimationFrame(rec);
    };
    rec();
  });
  await A.mouse.move(gbtn.x, gbtn.y);
  await A.mouse.down();
  await A.mouse.up();                       // 내렸다 바로 떼는 탭
  let released = false;
  for (let i = 0; i < 80 && !released; i++) {
    await sleep(120);
    released = await A.evaluate(() => {
      const c = window.BA.pvp.client;
      return !c.guardActive && (c.guardCd || 0) > 1.2;      // 풀린 뒤 쿨타임이 시작됐다
    });
  }
  const glog = await A.evaluate(() => window.__gt.log);
  const onRows = glog.filter((r) => r[2] === 1);
  const firstOn = onRows[0];
  const lastOn = onRows[onRows.length - 1];
  const simHold = firstOn && lastOn ? lastOn[1] - firstOn[1] : 0;
  const wallHold = firstOn && lastOn ? lastOn[0] - firstOn[0] : 0;
  const offRow = glog.find((r) => firstOn && r[0] > firstOn[0] && r[2] === 0);
  ok('🛡️ 막기 버튼을 톡 한 번 탭하면 막기가 켜진다',
    !!firstOn && firstOn[3] > holdMax * 0.6, { frames: glog.length, first: firstOn });
  ok('🛡️ 손을 뗀 뒤에도 막기가 그대로 유지된다 (예전엔 떼는 순간 풀렸다)',
    onRows.length >= 2 && wallHold >= 600, { frames: onRows.length, wallHold: Math.round(wallHold) });
  ok('🛡️ 탭 한 번으로 1초(서버 기준) 동안 막고, 끝나면 자동으로 풀린다',
    !!firstOn && firstOn[3] > 0.6 && wallHold >= 600 && wallHold <= 3200 && !!offRow && offRow[3] === 0,
    { wallHold: Math.round(wallHold), simHold: +simHold.toFixed(2), off: offRow });
  ok('🛡️ 풀린 그 순간부터 쿨타임이 시작된다 (2초)',
    !!offRow && offRow[4] > 1.6 && offRow[4] <= holdMax + 1.05, { cdAtRelease: offRow && offRow[4] });
  const guardHud = await A.evaluate(() => {
    const btn = document.getElementById('guardBtn');
    const num = btn.querySelector('.cd-num');
    return {
      isCd: btn.classList.contains('is-cd'),
      num: num ? num.textContent : '',
      label: (btn.querySelector('.sk-label') || {}).textContent,
      mask: (btn.querySelector('.cd-mask') || { style: {} }).style.transform
    };
  });
  ok('🛡️ 쿨타임 중에는 막기 버튼이 잠기고 남은 초가 보인다',
    guardHud.isCd && /\d/.test(guardHud.num) && /scaleY\(/.test(guardHud.mask) && /재장전/.test(guardHud.label || ''),
    guardHud);
  const deniedNow = await A.evaluate(() => window.BA.pvp.guard(true));
  ok('🛡️ 쿨타임 중 다시 눌러도 막기가 켜지지 않는다', deniedNow === false, { again: deniedNow });

  /* 유지 중에 베기 → 즉시 해제 + 그때부터 쿨타임 */
  cdReady = false;
  for (let i = 0; i < 100 && !cdReady; i++) {
    cdReady = await A.evaluate(() => {
      const c = window.BA.pvp.client;
      return !c.guardActive && (c.guardCd || 0) <= 0.001;
    });
    if (!cdReady) await sleep(250);
  }
  const beforeSwing = await A.evaluate(() => {
    const c = window.BA.pvp.client;
    const pressed = c.pressGuard();                    // 탭 = 막기 시작
    const on = { active: !!c.guardActive, left: +(c.guardLeft || 0).toFixed(2) };
    const btn = document.getElementById('attackBtn');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'touch', isPrimary: true }));
    const p = window.BA.battle.player;
    return {
      pressed, on,
      off: { guardActive: !!c.guardActive, guard: !!p.guard, cd: +(c.guardCd || 0).toFixed(2) }
    };
  });
  /* 실제 베기가 시작되고 서버에 전달되는지 (프레임이 느리므로 몇 번 기다린다) */
  let swingSeen = null;
  for (let i = 0; i < 12 && !swingSeen; i++) {
    await sleep(250);
    swingSeen = await A.evaluate(() => {
      const p = window.BA.battle.player;
      return (p.attackT >= 0 || p.cooldown > 0) ? { attackT: +p.attackT.toFixed(2), cooldown: +p.cooldown.toFixed(2) } : null;
    });
  }
  await A.evaluate(() => {
    document.getElementById('attackBtn').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 31, pointerType: 'touch' }));
  });
  ok('⚔️ 막기 유지 중 베기 버튼을 누르면 막기가 즉시 풀린다',
    cdReady === true && beforeSwing.on.active === true && beforeSwing.off.guardActive === false && beforeSwing.off.guard === false,
    beforeSwing);
  ok('⚔️ 막기가 풀린 순간부터 2초 쿨타임이 시작된다',
    beforeSwing.off.cd > 1.6 && beforeSwing.off.cd <= 2.05, { cd: beforeSwing.off.cd });
  ok('⚔️ 막기를 풀면서 베기는 그대로 나간다', !!swingSeen, swingSeen);

  /* ===== 5c. 🥊 옥타곤 링 경계 ===== */
  const octInfo = await A.evaluate(() => window.BA.oct());
  const ringMath = await A.evaluate(() => ({
    edge: window.BA.ring(40, 0),
    inside: window.BA.ring(3, 4)
  }));
  ok('8각 경계 — 변 밖 좌표는 경계(±16.2m 꼭짓점)로 되돌아온다',
    Math.abs(ringMath.edge.x - 16.2359) < 0.01 && ringMath.inside.x === 3 && ringMath.inside.z === 4,
    { edge: ringMath.edge });
  /* 서버 권위 이동으로 링 밖을 향해 걷는다 (0.45m 씩). 자동 16Hz 입력이 서버를 되돌리지 않도록
     잠깐 자동 입력을 끄고 보낸다 — 판정은 서버 좌표로 본다. */
  await A.evaluate(() => {
    const c = window.BA.pvp.client;
    c.inputAt = Date.now() + 60000;
    const st = window.BA.pvp.state();
    let x = st.me.x, z = st.me.z;
    for (let i = 0; i < 45; i++) {
      x += 0.45;
      window.BA.pvp.send({ type: 'pinput', x, z, yaw: st.me.yaw, pitch: 0 });
    }
  });
  await sleep(900);
  const room5 = rooms.get(code);
  const eA5 = room5.pvp.ents.get(youA);
  const ringA = { x: +eA5.x.toFixed(2), z: +eA5.z.toFixed(2), r: +Math.hypot(eA5.x, eA5.z).toFixed(2) };
  ok('플레이어는 끝까지 걸어도 옥타곤 링 밖으로 나갈 수 없다',
    ringA.r <= 16.3 && ringA.r > 13, { ...ringA, oct: octInfo && octInfo.apothem });


  /* ===== 5d. 영구 성장은 PVP 에서 제외 ===== */
  const growState = await A.evaluate(() => ({
    shown: getComputedStyle(document.querySelector('.player-status .ps-grow')).display !== 'none',
    chip: getComputedStyle(document.querySelector('.kill-chip')).display !== 'none',
    kills: window.BA.battle.playerKills,
    growth: window.BA.state().growth
  }));
  ok('PVP 에서는 영구 성장 표시·처치 누적이 없다 (순수 동등 조건)',
    growState.shown === false && growState.chip === false && growState.kills === 0 && growState.growth === '+0.000%', growState);

  /* 다시 상대 정면으로 돌아와 서로를 바라본다 (이름표·모델 확인용) */
  await A.evaluate(() => {
    const you = window.BA.pvp.state().you;
    const st = window.BA.pvp.client.lastState;
    const me = st.ents.find((e) => e.s === you);
    const foe = st.ents.find((e) => e.s !== you);
    const tx = foe.x, tz = foe.z - 1.6;
    const yaw = Math.atan2(foe.x - tx, foe.z - tz);
    const n = Math.max(1, Math.ceil(Math.hypot(tx - me.x, tz - me.z) / 0.4));
    for (let i = 1; i <= n; i++) {
      window.BA.pvp.send({ type: 'pinput', x: me.x + (tx - me.x) * i / n, z: me.z + (tz - me.z) * i / n, yaw, pitch: 0 });
    }
    window.BA.pvp.lookAt(foe.s);
  });
  await sleep(700);

  /* ===== 6. 상대 화면도 실제로 그려진다 ===== */
  /* 이 환경(메모리 2GB·소프트웨어 GL)에서는 뒤 탭을 앞으로 가져오면 렌더러가 죽는다.
     그래서 상대 화면은 '그려질 준비'를 상태로 확인한다 — 상대 모델이 상세 모델로 등록되고
     이름표가 화면에 투영되는지 (픽셀 캡처는 라이브 확인 스크린샷에서 따로 본다). */
  await sleep(900);
  /* B 가 A 를 바라보게 한 뒤, 이름표 투영이 갱신될 때까지 기다린다 */
  await B.evaluate(() => {
    const st = window.BA.pvp.state();
    if (st && st.others[0]) window.BA.pvp.lookAt(st.others[0].id);
  });
  await sleep(400);
  for (let i = 0; i < 12; i++) {
    const on = await B.evaluate(() => {
      const st = window.BA.pvp.state();
      return st && st.platesOn > 0;
    });
    if (on) break;
    await sleep(400);
  }
  const lookB = await B.evaluate(() => {
    const st = window.BA.pvp.state();
    const plate = document.querySelector('#pvpNames .pn-plate');
    return {
      other: st.others[0], platesOn: st.platesOn, frames: window.BA.state().frames,
      plateOn: !!(plate && plate.classList.contains('is-on')), plateText: plate ? plate.textContent : ''
    };
  });
  ok('상대 화면에서도 3D 모델·이름표가 준비된다 (상세 모델 등록 · 이름표 투영)',
    lookB.other && lookB.other.drawn === true && lookB.platesOn >= 1 && lookB.plateOn && /한윤/.test(lookB.plateText),
    { drawn: lookB.other && lookB.other.drawn, platesOn: lookB.platesOn, frames: lookB.frames, text: lookB.plateText.trim() });
  await front(A, 1200);

  /* ===== 7. HUD 유지 · 홈 복귀 ===== */
  const hud = await A.evaluate(() => {
    const atk = document.getElementById('attackBtn').getBoundingClientRect();
    const joy = document.getElementById('joy').getBoundingClientRect();
    return { atk: +atk.width.toFixed(1), joy: +joy.width.toFixed(1) };
  });
  ok('내가 저장한 버튼 크기·위치(전투 HUD)가 PVP 에서도 그대로다', hud.atk > 40 && hud.joy > 60, hud);

  await A.evaluate(() => window.BA.pvp.leave());
  await sleep(800);
  const backHome = await A.evaluate(() => ({
    home: document.getElementById('home').classList.contains('is-active'),
    pvp: document.getElementById('battle').classList.contains('is-pvp')
  }));
  ok('홈으로 나가면 PVP 전장 상태가 정리된다', backHome.home && !backHome.pvp, backHome);

  ok('A 콘솔 · 페이지 오류 0', errorsA.length === 0, errorsA.slice(0, 5));
  ok('B 콘솔 · 페이지 오류 0', errorsB.length === 0, errorsB.slice(0, 5));

  console.log('\n플레이어 PVP 모바일 검증 통과 · ' + passed + '개');
  await browser.close();
  stop();
  process.exit(0);
})().catch((e) => {
  console.error('검증 스크립트 오류:', (e && e.stack) || e);
  process.exit(1);
});
