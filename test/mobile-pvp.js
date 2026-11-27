'use strict';

/* =============================================================================
   플레이어 PVP · 390×844 실브라우저 2인 동시 접속 검증
   -----------------------------------------------------------------------------
   1) 홈: 「⚔️ 플레이어 PVP」 패널(닉네임·방 만들기·방 코드 입장)이 보이고 눌린다
   2) 대기실: 방 만들기 → 코드 입장 → 두 사람 · 팀 선택 · 병종은 일반 병사 고정
   3) 전장: 🥊 UFC 옥타곤 링 위 1인칭 3D 전장, 상대가 모델 + 이름표로 보인다
   4) 실전: 걸어가서 근접 공격 → 양쪽 체력이 실제로 줄고 피격 연출이 뜬다
   5) 검 막기: 정면으로 막으면 피해 0 + 공격자에게 피해 100% 반사 · 최대 0.8초 유지 · 2초 쿨타임(HUD 표시)
   6) 🥊 옥타곤 링 밖으로 나갈 수 없다 (서버·클라이언트 경계)
   6) 상대 화면에서도 3D 전장·모델·이름표가 실제로 그려진다
   7) 전투 HUD(내 버튼 크기·위치) 유지 · 홈 복귀 · 콘솔 오류 0
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
  /* 이 검증은 소프트웨어 GL 로 두 탭을 동시에 돌려 탭 타이머가 1~2초씩 밀린다.
     기본 막기 유지(0.8초)는 test/pvp.js 가 서버 단위로 정확히 검증하고,
     여기서는 막기 창을 조금 넓혀(2.5초) '막힘 → 100% 반사 → HUD 쿨타임' 흐름을 실브라우저로 확인한다. */
  const PVP = require(path.join(ROOT, 'pvp.js'));
  const holdSaved = PVP.CFG.guardHold;
  PVP.CFG.guardHold = 2.5;
  process.on('exit', () => { PVP.CFG.guardHold = holdSaved; });
  const { createServer } = require(path.join(ROOT, 'server.js'));
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
      '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']
  });
  const errorsA = [];
  const errorsB = [];

  const openPage = async (errors) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/AudioContext/.test(m.text())) return;           // 헤드리스에는 오디오 장치가 없다
      if (/WebGLProgram|Shader Error|VALIDATE_STATUS|could not be created|Error creating WebGL/.test(m.text())) return;
      errors.push('console: ' + m.text());
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
  const B = await openPage(errorsB);
  const front = async (page, ms) => { await page.bringToFront(); await sleep(ms || 800); };
  const shot = async (page, name) => { try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch (e) { /* noop */ } };

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
  await A.evaluate((id) => window.BA.pvp.lookAt(id), battleB.you);
  await B.evaluate((id) => window.BA.pvp.lookAt(id), battleA.you);
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
  await shot(A, '04-battle-see-opponent.png');

  /* ===== 4. 걸어가서 근접전 ===== */
  const snapshot = () => A.evaluate(() => {
    const st = window.BA.pvp.state();
    return { me: st.me, other: st.others[0] };
  });
  const distOf = async () => { const s = await snapshot(); return Math.hypot(s.me.x - s.other.x, s.me.z - s.other.z); };
  const startDist = await distOf();
  await A.keyboard.down('KeyW');
  let reached = false;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (await distOf() < 2.2) { reached = true; break; }
  }
  await A.keyboard.up('KeyW');
  const endDist = await distOf();
  ok('이동이 서버에 동기화되어 상대에게 다가간다', reached || endDist < startDist - 3,
    { start: +startDist.toFixed(1), end: +endDist.toFixed(1), reached });

  /* 가까이 붙였으면 공격 → 상대 HP 감소 */
  await A.evaluate(() => window.BA.pvp.lookAt(window.BA.pvp.state().others[0].id));
  const hpB0 = await B.evaluate(() => window.BA.pvp.state().me.hp);
  let hpDrop = false;
  for (let i = 0; i < 8 && !hpDrop; i++) {
    await A.evaluate(() => window.BA.pvp.swing());
    await sleep(900);
    hpDrop = await A.evaluate((hp) => {
      const st = window.BA.pvp.state();
      return !!(st.others[0] && st.others[0].hp < hp);
    }, hpB0);
  }
  const hpB1 = await B.evaluate(() => window.BA.pvp.state().me.hp);
  const hpSeenByA = await A.evaluate(() => window.BA.pvp.state().others[0].hp);
  ok('내 공격이 상대에게 실제 피해를 준다 (양쪽 체력 일치)',
    hpB1 < hpB0 && Math.abs(hpB1 - hpSeenByA) < 1.5, { before: hpB0, after: hpB1, seen: hpSeenByA });
  ok('맞은 쪽은 피격 이벤트를 받는다', (await A.evaluate(() => window.BA.pvp.state().stats.hits)) >= 1);
  const ret = await A.evaluate(() => {
    const el = document.getElementById('reticle');
    return { hit: el.classList.contains('is-hit'), color: getComputedStyle(el.querySelector('i')).backgroundColor };
  });
  ok('지금 공격하면 맞는 상대에게 조준점이 붉게 바뀐다', ret.hit === true, ret);

  /* ===== 5. 검 막기 — 정면 방어 + 100% 반사 =====
     (소프트웨어 GL 에서는 rAF 가 느려 로컬 공격 애니메이션이 실시간보다 늦게 진행된다.
      판정 자체는 서버가 하므로, 확실한 검증은 서버 권위 메시지로 보낸다 — 화면 연출은 실제 스윙으로 따로 확인) */
  await front(A, 500);
  await A.waitForFunction(() => {
    const s = window.BA.pvp.state();
    return s && s.me && !s.me.dead && window.BA.battle.player.cooldown <= 0 && window.BA.battle.player.attackT < 0;
  }, { timeout: 12000, polling: 120 }).catch(() => null);
  let before = null, parry = null, hitThrough = false, armed = false, geo = null;
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
    if (!geo) { await sleep(400); continue; }
    await sleep(420);
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
    await B.evaluate(() => window.BA.pvp.guard(true));
    for (let k = 0; k < 5 && !parry; k++) {
      await A.evaluate((yaw) => window.BA.pvp.send({ type: 'pattack', yaw }), geo.yaw);
      await sleep(150);
    }
    armed = false;
    line.length = 0;
    for (let i = 0; i < 40 && !parry; i++) {
      await sleep(110);
      const st = await B.evaluate(() => {
        const s2 = window.BA.pvp.client.lastState || {};
        const you = window.BA.pvp.state().you;
        const foe = (s2.ents || []).find((e) => e.s !== you) || {};
        return {
          blocks: window.BA.pvp.state().stats.blocks,
          log: window.BA.pvp.state().blockLog,
          hp: window.BA.pvp.state().me.hp,
          g: !!(s2.me && s2.me.g),
          aFoe: foe.a || 0,
          t: s2.t || 0
        };
      });
      line.push({ g: st.g, a: st.aFoe, hp: Math.round(st.hp), t: st.t });
      if (st.g) armed = true;
      if (st.blocks > 0) { parry = st; break; }
      if (st.hp <= 0) break;
    }
    if (!parry) await sleep(2600);   // 막기 쿨타임이 지난 뒤 다시
  }
  const hpBk0 = before ? before.other.hp : 0;
  const hpAk0 = before ? before.me.hp : 0;
  const hpAafter = await A.evaluate(() => window.BA.pvp.state().me.hp);
  const lastBlock = parry && parry.log && parry.log.length ? parry.log[parry.log.length - 1] : null;
  const connA = await A.evaluate(() => { const s2 = window.BA.pvp.state(); return { inBattle: s2.inBattle, ws: s2.ws, phase: s2.phase }; });
  ok('서버 기준으로 상대 정면 1.5m 안에 섰다', !!before && before.d < 2.5 && before.d > 0.8, before && { d: before.d, me: before.me, foe: before.other });
  ok('검 막기 — 서버가 정면 공격을 막아내고 막힘(패링) 이벤트를 보낸다',
    !!parry && !!lastBlock && lastBlock.reflect === 115,
    parry ? { lastBlock, g: parry.g } : { hitThrough, before, geo, connA, line: line.slice(0, 16) });
  ok('막아낸 피해 100%가 공격자에게 그대로 반사된다 (115)',
    !!lastBlock && lastBlock.reflect === 115 && (hpAk0 - hpAafter) >= 100,
    lastBlock ? { reflect: lastBlock.reflect, before: hpAk0, after: hpAafter, reflected: +(hpAk0 - hpAafter).toFixed(1) } : null);
  /* 실제 스윙 연출(스크린샷용) */
  await A.evaluate(() => window.BA.pvp.swing());
  await sleep(260);
  await shot(A, '05-battle-parry-reflect.png');

  /* ===== 5b. 막기 유지 시간 + 쿨타임(HUD) ===== */
  await front(B, 2700);          // 막기 유지 시간이 지나면 자동으로 풀리고 쿨타임
  const guardCd = await B.evaluate(() => {
    const btn = document.getElementById('guardBtn');
    const num = btn.querySelector('.cd-num');
    return {
      on: !!window.BA.pvp.state().me.guard,
      active: !!window.BA.pvp.client.guardActive,
      cd: +(window.BA.pvp.client.guardCd || 0).toFixed(2),
      isCd: btn.classList.contains('is-cd'),
      num: num ? num.textContent : '',
      label: (btn.querySelector('.sk-label') || {}).textContent,
      mask: (btn.querySelector('.cd-mask') || { style: {} }).style.transform,
      again: window.BA.pvp.guard(true)
    };
  });
  ok('막기는 정해진 유지 시간이 지나면 자동으로 풀린다', guardCd.on === false && guardCd.active === false, guardCd);
  ok('쿨타임 중에는 막기 버튼이 잠기고 남은 초가 보인다',
    guardCd.cd > 0.2 && guardCd.isCd && /\d/.test(guardCd.num) && /scaleY\(/.test(guardCd.mask) && /재장전/.test(guardCd.label || ''),
    guardCd);
  const reguard = await B.evaluate(() => ({
    again: window.BA.pvp.guard(true),
    active: window.BA.pvp.client.guardActive,
    cd: +(window.BA.pvp.client.guardCd || 0).toFixed(2),
    me: !!window.BA.pvp.state().me.guard,
    srv: !!(window.BA.pvp.client.lastState && window.BA.pvp.client.lastState.me && window.BA.pvp.client.lastState.me.g)
  }));
  ok('쿨타임 중 다시 눌러도 막기가 켜지지 않는다', reguard.again === false && reguard.active === false && reguard.me === false && reguard.srv === false, reguard);
  const aGuardHud = await A.evaluate(() => ({
    isCd: document.getElementById('guardBtn').classList.contains('is-cd'),
    cd: +(window.BA.pvp.client.guardCd || 0).toFixed(2)
  }));
  ok('상대가 막기를 풀어도 내 막기 버튼은 쿨타임이 되지 않는다', aGuardHud.isCd === false && aGuardHud.cd < 0.05, aGuardHud);
  await shot(B, '05b-guard-cooldown-hud.png');

  /* ===== 5c. 🥊 옥타곤 링 경계 ===== */
  const octInfo = await A.evaluate(() => window.BA.oct());
  const ringMath = await A.evaluate(() => ({
    edge: window.BA.ring(40, 0),
    inside: window.BA.ring(3, 4)
  }));
  ok('8각 경계 — 변 밖 좌표는 경계(±16.2m 꼭짓점)로 되돌아온다',
    Math.abs(ringMath.edge.x - 16.2359) < 0.01 && ringMath.inside.x === 3 && ringMath.inside.z === 4,
    { edge: ringMath.edge });
  /* 서버 권위 이동으로 링 밖을 향해 걸어간다 (0.45m 씩) */
  await A.evaluate(() => {
    const st = window.BA.pvp.state();
    let x = st.me.x, z = st.me.z;
    for (let i = 0; i < 45; i++) {
      x += 0.45;
      window.BA.pvp.send({ type: 'pinput', x, z, yaw: st.me.yaw, pitch: 0 });
    }
  });
  await sleep(700);
  const ringA = await A.evaluate(() => {
    const st = window.BA.pvp.state();
    return { x: +st.me.x.toFixed(2), z: +st.me.z.toFixed(2), r: +Math.hypot(st.me.x, st.me.z).toFixed(2) };
  });
  ok('플레이어는 끝까지 걸어도 옥타곤 링 밖으로 나갈 수 없다',
    ringA.r <= 16.3 && ringA.r > 13, { ...ringA, oct: octInfo && octInfo.apothem });
  await front(A, 500);
  await shot(A, '06-octagon-cage.png');
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
  await front(B, 2500);
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
  ok('상대 화면에서도 3D 모델·이름표가 그려진다',
    lookB.other && lookB.other.drawn === true && lookB.platesOn >= 1 && lookB.plateOn && lookB.frames >= 2,
    { drawn: lookB.other && lookB.other.drawn, platesOn: lookB.platesOn, frames: lookB.frames, text: lookB.plateText.trim() });
  await shot(B, '06-opponent-view.png');
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
