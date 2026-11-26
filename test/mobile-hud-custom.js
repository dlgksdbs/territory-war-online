'use strict';

/* =============================================================================
   BATTLE ARENA 3D · 🎮 전투 HUD 버튼 크기·위치 커스텀 (390×844 실렌더 검증)
   -----------------------------------------------------------------------------
   · 일반 병사 증원 0.12초 · FIELD_RATIO.soldier 0.6 (동시 96명) — 이번 판 기준
   · 홈 「🎮 버튼 크기·위치 설정」 버튼이 보이고 전장으로 버튼과 겹치지 않는다
   · 편집기: 실제 전장 화면 비율 그대로의 미리보기 · 버튼 5종 보임
   · 드래그로 옮기면 위치가 바뀌고, 화면 밖으로 나가지 않게 클램프된다
   · 크기 슬라이더 70~160% — 실제 버튼 크기가 배율대로 커진다
   · 저장 → localStorage · 새로고침 후에도 유지 · 전장(일반/전체화면) HUD 에 반영
   · 「기본값 초기화」 → 원래 배치·크기로 복구 · 콘솔 오류 0
   실행: node test/mobile-hud-custom.js
   ============================================================================= */

const puppeteer = require('/workspace/.cache/uitest/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ARENA_ROOT || path.join(__dirname, '..');
const SHOTS = process.env.HUD_SHOTS || '/workspace/tmp/hud-custom-shots';
const PORT = 3596;
const KEY = 'ba.hudLayout.v1';
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

  const boxOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const q = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return {
      l: +q.left.toFixed(1), t: +q.top.toFixed(1), r: +q.right.toFixed(1), b: +q.bottom.toFixed(1),
      w: +q.width.toFixed(1), h: +q.height.toFixed(1),
      cx: +(q.left + q.width / 2).toFixed(1), cy: +(q.top + q.height / 2).toFixed(1),
      nx: +((q.left + q.width / 2) / innerWidth).toFixed(4),
      ny: +((q.top + q.height / 2) / innerHeight).toFixed(4),
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && q.width > 0 && q.height > 0,
      hitOk: !!(hit && hit.closest && hit.closest(s)),
      vw: innerWidth, vh: innerHeight
    };
  }, sel);
  const overlaps = (a, b) => !(a.r <= b.l + 0.01 || b.r <= a.l + 0.01 || a.b <= b.t + 0.01 || b.b <= a.t + 0.01);

  console.log('▶ 🎮 전투 HUD 버튼 크기·위치 커스텀 검증 (390×844)');
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.BA && window.BA.app && window.BA.hudLayout, { timeout: 30000 });
  await sleep(700);

  /* ===== 1. 홈 — 설정 버튼 ===== */
  const cfgBtn = await boxOf('#hudCfgBtn');
  const startBtn = await boxOf('#startBtn');
  const footNote = await boxOf('.foot-note');
  const editorHidden = await page.evaluate(() => {
    const e = document.getElementById('hudEditor');
    return { display: getComputedStyle(e).display, aria: e.getAttribute('aria-hidden') };
  });
  ok('🎮 홈에 「버튼 크기·위치 설정」 버튼이 보이고 터치된다 (높이 30px 이상)',
    !!cfgBtn && cfgBtn.visible && cfgBtn.hitOk && cfgBtn.w >= 200 && cfgBtn.h >= 30 &&
    cfgBtn.l >= 0 && cfgBtn.t >= 0 && cfgBtn.b <= 844.5 && /버튼 크기·위치/.test(await page.$eval('#hudCfgBtn', (e) => e.textContent)),
    cfgBtn && { w: cfgBtn.w, h: cfgBtn.h, hitOk: cfgBtn.hitOk });
  ok('🎮 설정 버튼이 「전장으로」·발밑 안내와 겹치지 않는다',
    !!cfgBtn && !overlaps(cfgBtn, startBtn) && !overlaps(cfgBtn, footNote) && startBtn.t - cfgBtn.b >= 0,
    { gapToStart: +(startBtn.t - cfgBtn.b).toFixed(1) });
  ok('🎮 편집기는 평소에 숨어 있다', editorHidden.display === 'none' && editorHidden.aria === 'true', editorHidden);
  await shot('01-home-cfg-button.png');

  /* ===== 2. 편집기 열기 — 실제 전장 화면 비율 ===== */
  await page.click('#hudCfgBtn');
  await sleep(320);
  const open = await page.evaluate(() => {
    const ed = document.getElementById('hudEditor');
    const stage = document.getElementById('heStage');
    const wrap = document.getElementById('heStageWrap').getBoundingClientRect();
    const r = stage.getBoundingClientRect();
    const slots = ['joy', 'attack', 'guard', 'skill', 'spells'].map((id) => {
      const el = document.querySelector('#heStage [data-slot="' + id + '"]');
      if (!el) return { id, exists: false };
      const q = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        id, exists: true,
        visible: cs.display !== 'none' && q.width > 0 && q.height > 0,
        w: +q.width.toFixed(1), h: +q.height.toFixed(1),
        inside: q.left >= r.left - 0.5 && q.top >= r.top - 0.5 && q.right <= r.right + 0.5 && q.bottom <= r.bottom + 0.5,
        nx: +((q.left + q.width / 2 - r.left) / r.width).toFixed(4),
        ny: +((q.top + q.height / 2 - r.top) / r.height).toFixed(4)
      };
    });
    const chips = Array.from(document.querySelectorAll('#heChips button')).map((b) => ({
      slot: b.dataset.slot, on: b.classList.contains('is-on'), pct: b.querySelector('em').textContent
    }));
    return {
      on: ed.classList.contains('is-on'), aria: ed.getAttribute('aria-hidden'),
      stage: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), aspect: +(r.width / r.height).toFixed(4) },
      win: { w: innerWidth, h: innerHeight, aspect: +(innerWidth / innerHeight).toFixed(4) },
      wrap: { w: +wrap.width.toFixed(1), h: +wrap.height.toFixed(1) },
      insideWrap: r.left >= wrap.left - 0.5 && r.right <= wrap.right + 0.5 && r.top >= wrap.top - 0.5 && r.bottom <= wrap.bottom + 0.5,
      slots, chips,
      slider: { min: document.getElementById('heSize').min, max: document.getElementById('heSize').max, val: document.getElementById('heSize').value },
      stored: window.BA.hudLayout.stored()
    };
  });
  ok('🎮 설정 버튼을 누르면 편집기가 열린다', open.on === true && open.aria === 'false', { on: open.on });
  ok('🎮 편집기 미리보기가 실제 전장 화면과 같은 비율이다 (390×844)',
    Math.abs(open.stage.aspect - open.win.aspect) < 0.01 && open.stage.aspect < 0.6 && open.insideWrap,
    { stage: open.stage, win: open.win, insideWrap: open.insideWrap });
  ok('🎮 조이스틱·공격·막기·스킬·마법 5종 버튼이 미리보기 안에 모두 보인다',
    open.slots.length === 5 && open.slots.every((s) => s.exists && s.visible && s.inside),
    open.slots);
  ok('🎮 편집 대상 칩 5개 · 슬라이더 70~160% · 처음엔 조이스틱 선택',
    open.chips.length === 5 && open.chips[0].slot === 'joy' && open.chips[0].on &&
    open.chips.every((c) => c.pct === '100%') && open.slider.min === '70' && open.slider.max === '160',
    { chips: open.chips, slider: open.slider });
  ok('🎮 아직 저장 전이라 실제 HUD 는 기본 배치다', open.stored === null);
  await shot('02-editor-default.png');

  /* ===== 3. 드래그로 위치 옮기기 ===== */
  const dragPreview = (slot, nx, ny) => page.evaluate(({ slot, nx, ny }) => {
    const stage = document.getElementById('heStage');
    const el = document.querySelector('#heStage [data-slot="' + slot + '"]');
    const sr = stage.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const from = { x: er.left + er.width / 2, y: er.top + er.height / 2 };
    const to = { x: sr.left + sr.width * nx, y: sr.top + sr.height * ny };
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 91, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    el.dispatchEvent(mk('pointerdown', from.x, from.y));
    el.dispatchEvent(mk('pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2));
    el.dispatchEvent(mk('pointermove', to.x, to.y));
    window.dispatchEvent(mk('pointerup', to.x, to.y));
    const after = el.getBoundingClientRect();
    return {
      stage: { l: +sr.left.toFixed(1), t: +sr.top.toFixed(1), w: +sr.width.toFixed(1), h: +sr.height.toFixed(1) },
      center: { x: +(after.left + after.width / 2).toFixed(1), y: +(after.top + after.height / 2).toFixed(1) },
      w: +after.width.toFixed(1), h: +after.height.toFixed(1)
    };
  }, { slot, nx, ny });

  const joyDrag = await dragPreview('joy', 0.5, 0.4);
  const afterJoyDrag = await page.evaluate(() => ({
    slot: window.BA.hudLayout.get().joy,
    chip: document.querySelector('#heChips [data-slot="joy"]').classList.contains('is-on')
  }));
  ok('🎮 조이스틱을 드래그하면 그 자리(화면 50%·40%)로 옮겨진다',
    Math.abs(afterJoyDrag.slot.x - 0.5) < 0.012 && Math.abs(afterJoyDrag.slot.y - 0.4) < 0.012 && afterJoyDrag.chip,
    afterJoyDrag.slot);

  /* 화면 밖으로 끌어도 잘리지 않게 클램프 */
  const atkDrag = await dragPreview('attack', 1.6, 1.6);
  const clamped = await page.evaluate(() => {
    const stage = document.getElementById('heStage').getBoundingClientRect();
    const el = document.querySelector('#heStage [data-slot="attack"]');
    const r = el.getBoundingClientRect();
    const c = window.BA.hudLayout.get().attack;
    return {
      c,
      inside: r.right <= stage.right + 0.6 && r.bottom <= stage.bottom + 0.6 && r.left >= stage.left - 0.6 && r.top >= stage.top - 0.6,
      maxX: 1 - r.width / 2 / stage.width, maxY: 1 - r.height / 2 / stage.height,
      edge: { right: +(stage.right - r.right).toFixed(1), bottom: +(stage.bottom - r.bottom).toFixed(1) }
    };
  });
  ok('🎮 화면 밖으로 끌어도 버튼이 화면 안에 머문다 (클램프)',
    clamped.inside && clamped.c.x <= clamped.maxX + 0.002 && clamped.c.y <= clamped.maxY + 0.002 &&
    Math.abs(clamped.c.x - clamped.maxX) < 0.01 && Math.abs(clamped.c.y - clamped.maxY) < 0.01,
    { c: clamped.c, maxX: +clamped.maxX.toFixed(3), maxY: +clamped.maxY.toFixed(3), edge: clamped.edge });

  /* ===== 4. 크기 슬라이더 ===== */
  const beforeSize = await page.evaluate(() => {
    const el = document.querySelector('#heStage [data-slot="joy"]');
    return { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
  });
  const sized = await page.evaluate(() => {
    const chip = document.querySelector('#heChips [data-slot="joy"]');
    chip.click();
    const input = document.getElementById('heSize');
    input.value = '150';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const el = document.querySelector('#heStage [data-slot="joy"]');
    const r = el.getBoundingClientRect();
    const stage = document.getElementById('heStage').getBoundingClientRect();
    return {
      w: r.width, h: r.height, s: window.BA.hudLayout.get().joy.s,
      label: document.getElementById('heSizeVal').textContent,
      chipPct: chip.querySelector('em').textContent,
      inside: r.left >= stage.left - 0.6 && r.top >= stage.top - 0.6 && r.right <= stage.right + 0.6 && r.bottom <= stage.bottom + 0.6
    };
  });
  ok('🎮 크기 슬라이더 150% — 조이스틱이 1.5배로 커지고 표시도 150%',
    Math.abs(sized.s - 1.5) < 0.001 && Math.abs(sized.w / beforeSize.w - 1.5) < 0.02 && sized.label === '150%' && sized.chipPct === '150%',
    { ratio: +(sized.w / beforeSize.w).toFixed(3), s: sized.s, label: sized.label });
  ok('🎮 커진 버튼도 화면 안에 머문다', sized.inside === true, { inside: sized.inside });

  const allBtn = await page.evaluate(() => {
    const box = document.getElementById('heAll');
    box.click();
    const input = document.getElementById('heSize');
    input.value = '120';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const cfgs = window.BA.hudLayout.get();
    const pcts = Array.from(document.querySelectorAll('#heChips button em')).map((e) => e.textContent);
    box.click();     // 다시 해제
    return { pcts, s: Object.keys(cfgs).map((k) => cfgs[k].s) };
  });
  ok('🎮 「모든 버튼 함께 조절」로 다섯 버튼을 한 번에 120%로',
    allBtn.s.every((s) => Math.abs(s - 1.2) < 0.001) && allBtn.pcts.every((p) => p === '120%'),
    allBtn);
  // 조이스틱만 다시 150%로 (저장 후 검증하기 좋게)
  await page.evaluate(() => {
    document.querySelector('#heChips [data-slot="joy"]').click();
    const input = document.getElementById('heSize');
    input.value = '150';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await shot('03-editor-custom.png');

  /* ===== 5. 저장 ===== */
  const saved = await page.evaluate(() => {
    document.getElementById('heSave').click();
    const raw = localStorage.getItem('ba.hudLayout.v1');
    const ed = document.getElementById('hudEditor');
    const stored = window.BA.hudLayout.stored();
    return {
      raw: raw ? JSON.parse(raw) : null, stored,
      open: ed.classList.contains('is-on'), display: getComputedStyle(ed).display,
      toast: (document.getElementById('toast') || {}).textContent || '',
      custom: window.BA.hudLayout.isCustom()
    };
  });
  ok('🎮 저장하면 편집기가 닫히고 localStorage 에 5개 버튼 배치가 남는다',
    saved.open === false && saved.display === 'none' && !!saved.raw && !!saved.raw.slots &&
    Object.keys(saved.raw.slots).length === 5 && saved.custom === true && /저장/.test(saved.toast),
    { slots: saved.raw && Object.keys(saved.raw.slots), toast: saved.toast });
  const want = saved.stored;

  /* ===== 6. 실제 전장 HUD 반영 ===== */
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 30, enemy: 30 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && !!window.BA.battle, { timeout: 30000 });
  await sleep(900);
  const hud = await page.evaluate((want) => {
    const get = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        nx: +((r.left + r.width / 2) / innerWidth).toFixed(4),
        ny: +((r.top + r.height / 2) / innerHeight).toFixed(4),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1)
      };
    };
    return {
      custom: document.getElementById('battle').classList.contains('is-hud-custom'),
      free: document.getElementById('actions').classList.contains('hud-free'),
      attackStyle: document.querySelector('#attackBtn').style.cssText,
      attackOffset: document.querySelector('#attackBtn').offsetWidth,
      joy: get('#joy'), attack: get('#attackBtn'), guard: get('#guardBtn'),
      skill: get('#skillBtn'), spells: get('#spellWheel'),
      want, vw: innerWidth, vh: innerHeight,
      insideAll: ['#joy', '#attackBtn', '#spellWheel'].every((s) => {
        const q = document.querySelector(s).getBoundingClientRect();
        return q.left >= -0.5 && q.top >= -0.5 && q.right <= innerWidth + 0.5 && q.bottom <= innerHeight + 0.5;
      })
    };
  }, want);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  ok('🎮 저장한 배치가 실제 전장 HUD 에 적용된다 (조이스틱 50%·40%, 150%)',
    hud.custom && hud.free && near(hud.joy.nx, want.joy.x, 0.012) && near(hud.joy.ny, want.joy.y, 0.012) &&
    Math.abs(hud.joy.w / 112 - 1.5) < 0.03,
    { joy: hud.joy, want: want.joy });
  ok('🎮 공격·막기 버튼도 저장한 자리·크기 그대로',
    near(hud.attack.nx, want.attack.x, 0.012) && near(hud.attack.ny, want.attack.y, 0.012) &&
    Math.abs(hud.attack.w / 92 - want.attack.s) < 0.03 &&
    near(hud.guard.nx, want.guard.x, 0.015) && Math.abs(hud.guard.w / 60 - want.guard.s) < 0.04 &&
    hud.insideAll,
    { attack: hud.attack, guard: hud.guard, insideAll: hud.insideAll, want: { attack: want.attack, guard: want.guard }, attackStyle: hud.attackStyle, attackOffset: hud.attackOffset });
  const skillPlaced = await page.evaluate(() => {
    const el = document.getElementById('skillBtn');
    return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), hs: el.style.getPropertyValue('--hs') };
  });
  ok('🎮 특수 스킬 버튼도 저장한 자리에 놓인다 (이 병종에선 숨김 상태)',
    near(skillPlaced.left, want.skill.x * 100, 0.6) && near(skillPlaced.top, want.skill.y * 100, 0.6) &&
    Math.abs(Number(skillPlaced.hs) - want.skill.s) < 0.001,
    { skillPlaced, want: want.skill });
  await shot('04-battle-custom-hud.png');

  /* 커진 조이스틱도 손가락을 따라 움직인다 */
  const joyTouch = await page.evaluate(() => {
    const el = document.getElementById('joy');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 55, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true
    });
    el.dispatchEvent(mk('pointerdown', cx, cy));
    el.dispatchEvent(mk('pointermove', cx + r.width * 0.35, cy));
    const mx = window.BA.app.input.mx, mz = window.BA.app.input.mz;
    window.dispatchEvent(mk('pointerup', cx + r.width * 0.35, cy));
    return { mx, mz, after: window.BA.app.input.mx, w: r.width };
  });
  ok('🎮 커진 조이스틱도 손가락 이동을 그대로 먹는다 (반경도 같이 커짐)',
    joyTouch.mx > 0.55 && joyTouch.mz === 0 && joyTouch.after === 0 && joyTouch.w > 150,
    joyTouch);

  const atkPress = await page.evaluate(async () => {
    const el = document.getElementById('attackBtn');
    const r = el.getBoundingClientRect();
    const mk = (type) => new PointerEvent(type, {
      pointerId: 56, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true
    });
    el.dispatchEvent(mk('pointerdown'));
    const pressed = !!window.BA.app.input.attack;
    const f0 = window.BA.state().frames;
    window.dispatchEvent(mk('pointerup'));
    const heldAfter = !!window.BA.app.attackHeld;
    await new Promise((r2) => setTimeout(r2, 260));
    return { pressed, heldAfter, after: !!window.BA.app.input.attack, frames: window.BA.state().frames - f0 };
  });
  ok('🎮 옮긴 공격 버튼도 정상으로 베기를 누르고, 손을 떼면 멈춘다',
    atkPress.pressed && atkPress.heldAfter === false && atkPress.after === false, { atkPress, errors: errors.slice(0, 3) });

  /* 마법사로 참전 — 마법 버튼 묶음도 저장한 자리·크기 */
  await page.evaluate(() => window.BA.start({ cls: 'wizard', ally: 10, enemy: 10 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle' && window.BA.state().player.cls === 'wizard', { timeout: 30000 });
  await sleep(900);
  const wheel = await page.evaluate((want) => {
    const el = document.getElementById('spellWheel');
    const r = el.getBoundingClientRect();
    return {
      nx: +((r.left + r.width / 2) / innerWidth).toFixed(4),
      ny: +((r.top + r.height / 2) / innerHeight).toFixed(4),
      w: +r.width.toFixed(1), s: want.spells.s,
      inside: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
      btns: Array.from(el.querySelectorAll('.spell-btn')).filter((b) => getComputedStyle(b).display !== 'none').length
    };
  }, want);
  ok('🎮 마법사로 참전하면 마법 버튼 3개가 저장한 자리·크기로 모인다',
    wheel.btns === 3 && Math.abs(wheel.w / 170 - wheel.s) < 0.05 &&
    Math.abs(wheel.nx - want.spells.x) < 0.015 && Math.abs(wheel.ny - want.spells.y) < 0.015 && wheel.inside,
    { wheel, want: want.spells });
  await shot('04b-battle-spells.png');

  /* 🎬 관전 모드 — 커스텀 배치여도 액션 버튼은 숨고 조이스틱만 남는다 */
  const spec = await page.evaluate(async () => {
    const cam = document.getElementById('camBtn');
    cam.click();                       // 👁️ 1인칭 → 🎬 관전
    await new Promise((r) => setTimeout(r, 240));
    const a = getComputedStyle(document.getElementById('actions')).display;
    const joy = getComputedStyle(document.getElementById('joy')).display;
    const cls = document.getElementById('battle').classList.contains('is-spectate');
    cam.click();                       // 🎬 관전 → 👁️ 참전
    await new Promise((r) => setTimeout(r, 200));
    return { spectate: cls, spec: a, joy, fp: getComputedStyle(document.getElementById('actions')).display };
  });
  ok('🎬 관전 모드에서는 커스텀 배치여도 액션 버튼이 숨고 조이스틱은 남는다',
    spec.spectate && spec.spec === 'none' && spec.joy !== 'none' && spec.fp !== 'none', spec);

  /* ===== 7. 전체화면에서도 같은 자리 ===== */
  const fs = await page.evaluate(() => {
    const before = (() => {
      const r = document.getElementById('joy').getBoundingClientRect();
      return { nx: +((r.left + r.width / 2) / innerWidth).toFixed(4), w: +r.width.toFixed(1) };
    })();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
    document.dispatchEvent(new Event('fullscreenchange'));
    const r = document.getElementById('joy').getBoundingClientRect();
    const out = {
      appFs: document.getElementById('app').classList.contains('is-fullscreen'),
      nx: +((r.left + r.width / 2) / innerWidth).toFixed(4),
      ny: +((r.top + r.height / 2) / innerHeight).toFixed(4),
      w: +r.width.toFixed(1),
      inside: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      before
    };
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.dispatchEvent(new Event('fullscreenchange'));
    return out;
  });
  ok('🎮 전체화면에서도 저장한 자리·크기 그대로 (화면 안)',
    fs.appFs === true && Math.abs(fs.nx - want.joy.x) < 0.015 && Math.abs(fs.ny - want.joy.y) < 0.015 &&
    Math.abs(fs.w / 112 - 1.5) < 0.03 && fs.inside,
    fs);

  /* ===== 8. 새로고침해도 유지 ===== */
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.BA && window.BA.app && window.BA.hudLayout, { timeout: 30000 });
  await sleep(600);
  const afterReload = await page.evaluate(() => ({
    stored: window.BA.hudLayout.stored(),
    custom: document.getElementById('battle').classList.contains('is-hud-custom')
  }));
  ok('🎮 새로고침 후에도 저장한 배치가 남아 있다',
    !!afterReload.stored && Math.abs(afterReload.stored.joy.x - 0.5) < 0.02 &&
    Math.abs(afterReload.stored.joy.s - 1.5) < 0.001 && afterReload.custom === true,
    afterReload.stored && afterReload.stored.joy);
  await page.evaluate(() => window.BA.start({ cls: 'soldier', ally: 20, enemy: 20 }));
  await page.waitForFunction(() => window.BA.state().state === 'battle', { timeout: 30000 });
  await sleep(800);
  const reloadHud = await page.evaluate(() => {
    const r = document.getElementById('joy').getBoundingClientRect();
    return { nx: +((r.left + r.width / 2) / innerWidth).toFixed(4), w: +r.width.toFixed(1) };
  });
  ok('🎮 새로고침 뒤 전장에서도 같은 자리·크기로 서 있다',
    Math.abs(reloadHud.nx - 0.5) < 0.015 && Math.abs(reloadHud.w / 112 - 1.5) < 0.03, reloadHud);

  /* ===== 9. 기본값 초기화 ===== */
  await page.evaluate(() => window.BA.home());
  await sleep(300);
  await page.click('#hudCfgBtn');
  await sleep(300);
  const beforeReset = await page.evaluate(() => ({
    open: document.getElementById('hudEditor').classList.contains('is-on'),
    joyNx: window.BA.hudLayout.get().joy.x,
    s: window.BA.hudLayout.get().joy.s
  }));
  const reset = await page.evaluate(() => {
    document.getElementById('heReset').click();
    const stage = document.getElementById('heStage').getBoundingClientRect();
    const joy = document.querySelector('#heStage [data-slot="joy"]').getBoundingClientRect();
    return {
      raw: localStorage.getItem('ba.hudLayout.v1'),
      stored: window.BA.hudLayout.stored(),
      custom: document.getElementById('battle').classList.contains('is-hud-custom'),
      free: document.getElementById('actions').classList.contains('hud-free'),
      preview: {
        nx: +((joy.left + joy.width / 2 - stage.left) / stage.width).toFixed(4),
        s: window.BA.hudLayout.get().joy.s,
        label: document.getElementById('heSizeVal').textContent
      },
      toast: (document.getElementById('toast') || {}).textContent || '',
      open: document.getElementById('hudEditor').classList.contains('is-on')
    };
  });
  ok('🎮 편집기를 다시 열면 저장한 배치가 그대로 보인다',
    beforeReset.open && Math.abs(beforeReset.joyNx - 0.5) < 0.02 && Math.abs(beforeReset.s - 1.5) < 0.001, beforeReset);
  ok('🎮 「기본값 초기화」 — 저장값이 지워지고 실제 HUD 도 기본 배치로 돌아온다',
    reset.raw === null && reset.stored === null && reset.custom === false && reset.free === false &&
    reset.preview.s === 1 && reset.preview.label === '100%' && /기본/.test(reset.toast),
    { stored: reset.stored, custom: reset.custom, preview: reset.preview });
  ok('🎮 초기화된 미리보기 조이스틱은 원래 구석(왼쪽 아래)으로',
    reset.preview.nx < 0.22 && reset.open === true, reset.preview);
  await shot('05-editor-reset.png');
  await page.evaluate(() => document.getElementById('heClose').click());
  await sleep(200);

  const backToDefault = await page.evaluate(() => {
    window.BA.start({ cls: 'soldier', ally: 20, enemy: 20 });
    const r = document.getElementById('joy').getBoundingClientRect();
    const a = document.getElementById('attackBtn').getBoundingClientRect();
    return {
      joy: { nx: +((r.left + r.width / 2) / innerWidth).toFixed(4), ny: +((r.top + r.height / 2) / innerHeight).toFixed(4), w: +r.width.toFixed(1) },
      attack: { w: +a.width.toFixed(1) },
      custom: document.getElementById('battle').classList.contains('is-hud-custom')
    };
  });
  ok('🎮 초기화 뒤 전장 버튼은 원래 크기·자리 (조이스틱 112px 왼쪽 아래)',
    backToDefault.custom === false && backToDefault.joy.w === 112 &&
    backToDefault.joy.nx < 0.22 && backToDefault.joy.ny > 0.85 && backToDefault.attack.w === 92,
    backToDefault);
  await shot('06-battle-default-hud.png');

  /* ===== 10. 콘솔 오류 0 ===== */
  ok('🧯 콘솔 오류 0 (pageerror·requestfailed 포함)', errors.length === 0, errors.slice(0, 5));

  console.log('\n🎮 HUD 커스텀 테스트 통과 · ' + passed + '개');
  await browser.close();
  stop();
  process.exit(0);
})().catch(async (err) => {
  console.error('\n✗ 실패:', err && err.message ? err.message : err);
  try { process.exit(1); } catch (e) { /* noop */ }
});
