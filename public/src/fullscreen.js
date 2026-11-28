/* =============================================================================
   fullscreen.js — 🖥️ 전체화면 토글 (안드로이드 크롬 · 사파리 · 인앱 브라우저 · 📱 아이폰)
   -----------------------------------------------------------------------------
   · 표준 Fullscreen API 와 webkit 접두어 API 를 같은 코드로 다룬다.
   · 🍎 아이폰 사파리는 요소 전체화면(requestFullscreen / webkitRequestFullscreen)이
     아예 없다(fullscreenEnabled === false). 예전엔 여기서 토스트만 띄우고 끝나서
     폰에서는 전체화면 버튼이 아무 일도 하지 않았다 — 이제는 그런 환경에서
     '의사 전체화면(pseudo-fullscreen)'으로 바로 들어간다:
       html·body·#app 에 is-pseudo-fullscreen 클래스 → position:fixed; inset:0;
       높이 100dvh(주소창 실제 보이는 높이), 주소창을 위로 밀어 올린다.
   · 버튼 상태(aria-pressed · 아이콘 · 라벨)는 실제 전체화면과 똑같이 바뀌고,
     다시 누르면 해제된다. 전체화면·의사 전체화면 둘 다 '켜짐'으로 본다.
   · API 를 막는 환경(인앱 브라우저 · 헤드리스)에서도 예외를 던지지 않는다.
   ============================================================================= */

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
const ERROR_EVENTS = ['fullscreenerror', 'webkitfullscreenerror', 'mozfullscreenerror', 'MSFullscreenError'];
const PSEUDO_CLASS = 'is-pseudo-fullscreen';
const VH_VAR = '--ba-vh';

let pseudo = false;                    // 의사 전체화면 중인가
const syncers = new Set();             // 버튼 상태를 다시 칠할 토글들

function root() {
  return document.documentElement || document.body || null;
}

/* 실제(브라우저) 전체화면 안에 있는가 — 표준 + 접두어 + 구형 사파리 플래그 */
function nativeFullscreen() {
  const d = document;
  return !!(d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement ||
    d.webkitIsFullScreen === true || d.mozFullScreen === true || d.msFullscreen === true);
}

export function fullscreenElement() {
  const d = document;
  return d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement || null;
}

/* 화면이 '전체화면'인가 — 브라우저 전체화면 + 의사 전체화면 */
export function isFullscreen() {
  return nativeFullscreen() || pseudo;
}

/* 의사 전체화면(아이폰) 중인가 */
export function isPseudoFullscreen() {
  return pseudo;
}

/* 이 브라우저에서 '진짜' 전체화면을 켤 수 있는가 (아이폰 사파리는 false) */
export function fullscreenSupported() {
  if (typeof document === 'undefined') return false;
  const el = root();
  if (!el) return false;
  const enabled = document.fullscreenEnabled !== undefined ? document.fullscreenEnabled
    : document.webkitFullscreenEnabled !== undefined ? document.webkitFullscreenEnabled
      : document.mozFullScreenEnabled !== undefined ? document.mozFullScreenEnabled
        : document.msFullscreenEnabled;
  if (enabled === false) return false;      // 브라우저가 명시적으로 막은 경우 (아이폰 사파리 등)
  return typeof (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen) === 'function';
}

function callRequest(el) {
  if (typeof el.requestFullscreen === 'function') {
    try {
      return Promise.resolve(el.requestFullscreen({ navigationUI: 'hide' }));
    } catch (e) {
      /* 옵션 인자를 못 받는 구현 — 아래에서 인자 없이 한 번 더 시도한다 */
    }
  }
  const fn = el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (typeof fn !== 'function') return Promise.reject(new Error('unsupported'));
  try {
    return Promise.resolve(fn.call(el));
  } catch (e) {
    return Promise.reject(e);
  }
}

function callExit() {
  const d = document;
  const fn = d.exitFullscreen || d.webkitExitFullscreen || d.mozCancelFullScreen || d.msExitFullscreen;
  if (typeof fn !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(fn.call(d));
  } catch (e) {
    return Promise.reject(e);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 브라우저 주소창이 접힌 뒤 실제로 보이는 높이를 CSS 변수로 넘긴다 */
function syncViewportVar() {
  if (typeof document === 'undefined') return;
  const vv = window.visualViewport;
  const h = Math.round((vv && vv.height) || window.innerHeight || 0);
  if (h > 0) {
    try { document.documentElement.style.setProperty(VH_VAR, h + 'px'); } catch (e) { /* noop */ }
  }
}

function paintAll() {
  for (const fn of syncers) {
    try { fn(); } catch (e) { /* 한 토글이 실패해도 다른 버튼은 맞춘다 */ }
  }
}

/* 사파리 주소창을 위로 밀어 화면을 넓게 쓴다 (주소창은 스크롤할 때만 접힌다) */
function nudgeAddressBar() {
  try { window.scrollTo(0, 1); } catch (e) { /* noop */ }
  try { window.scrollTo({ top: 1, left: 0, behavior: 'instant' }); } catch (e) { /* noop */ }
}

function enterPseudo() {
  if (typeof document === 'undefined') return;
  pseudo = true;
  const targets = [document.documentElement, document.body, document.getElementById('app')];
  for (const el of targets) {
    if (!el) continue;
    el.classList.add(PSEUDO_CLASS);
  }
  syncViewportVar();
  nudgeAddressBar();
  /* 주소창이 접히거나 돌려 볼 때 높이가 달라지면 캔버스를 다시 맞춘다 */
  setTimeout(() => { syncViewportVar(); nudgeAddressBar(); paintAll(); }, 260);
  setTimeout(() => { syncViewportVar(); paintAll(); }, 620);
  paintAll();
}

function exitPseudo() {
  if (typeof document === 'undefined') return;
  pseudo = false;
  const targets = [document.documentElement, document.body, document.getElementById('app')];
  for (const el of targets) {
    if (!el) continue;
    el.classList.remove(PSEUDO_CLASS);
  }
  try { window.scrollTo(0, 0); } catch (e) { /* noop */ }
  paintAll();
}

/* 창 크기·회전·주소창 변화 — 의사 전체화면 중이면 높이 변수를 갱신하고 버튼도 다시 칠한다 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const onResize = () => {
    if (!pseudo) return;
    syncViewportVar();
    paintAll();
  };
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onResize, { passive: true });
    window.visualViewport.addEventListener('scroll', onResize, { passive: true });
  }
  /* 브라우저 전체화면이 끝나면 의사 전체화면도 남기지 않는다 */
  for (const ev of CHANGE_EVENTS) {
    document.addEventListener(ev, () => {
      if (!nativeFullscreen() && pseudo) exitPseudo();
      paintAll();
    });
  }
}

/* 진짜 전체화면을 시도하고, 실제로 들어갔는지까지 확인한다 */
async function tryNative() {
  if (!fullscreenSupported()) return false;
  try {
    await callRequest(root());
  } catch (e) {
    return false;
  }
  if (nativeFullscreen()) return true;
  /* 이벤트가 늦게 오는 구현(iPad) — 잠깐 기다려 본다 */
  for (let i = 0; i < 6; i++) {
    await wait(60);
    if (nativeFullscreen()) return true;
  }
  return false;
}

/* 버튼(들)을 전체화면 토글로 묶는다. 홈 · PVP 대기실 · 전장 HUD 의 버튼이 같은 상태를 쓴다. */
export function createFullscreenToggle(options) {
  const opts = options || {};
  const buttons = (opts.buttons || []).filter(Boolean);
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  let busy = false;
  let lastErrorAt = 0;

  function paint(active) {
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.classList.toggle('is-on', active);
      const label = active ? '전체화면 끄기' : '전체화면';
      b.title = label;
      b.setAttribute('aria-label', label);
    }
  }

  function sync() {
    const active = isFullscreen();
    paint(active);
    try { onChange(active); } catch (e) { /* 화면 갱신 실패가 토글을 막지 않게 */ }
    return active;
  }

  async function toggle() {
    if (busy) return isFullscreen();     // 연타로 요청이 겹치지 않게
    busy = true;
    try {
      if (isFullscreen()) {
        if (pseudo) exitPseudo();
        else await callExit();
        return sync();
      }
      const native = await tryNative();
      /* 🍎 아이폰 사파리처럼 진짜 전체화면이 없는 환경 — 바로 의사 전체화면으로 */
      if (!native) enterPseudo();
      return sync();
    } catch (e) {
      /* 거부·미지원 — 그래도 의사 전체화면으로 한 번 더 시도한다 (게임 루프는 계속 돈다) */
      if (!isFullscreen()) enterPseudo();
      if (!isFullscreen()) onError('failed', e);
      return sync();
    } finally {
      busy = false;
    }
  }

  for (const ev of CHANGE_EVENTS) document.addEventListener(ev, () => sync());
  for (const ev of ERROR_EVENTS) {
    document.addEventListener(ev, () => {
      const now = Date.now();
      paint(isFullscreen());
      if (now - lastErrorAt < 400) return;   // 표준·접두어 이벤트가 겹쳐 와도 한 번만 알린다
      lastErrorAt = now;
      onError('denied');
    });
  }
  syncers.add(sync);
  sync();

  return {
    toggle, sync, paint, isFullscreen, supported: fullscreenSupported,
    pseudo: isPseudoFullscreen
  };
}
