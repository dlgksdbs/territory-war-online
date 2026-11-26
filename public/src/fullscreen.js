/* =============================================================================
   fullscreen.js — 🖥️ 전체화면 토글 (안드로이드 크롬 · 사파리 · 인앱 브라우저)
   -----------------------------------------------------------------------------
   · 표준 Fullscreen API 와 webkit 접두어 API 를 같은 코드로 다룬다.
   · fullscreenchange / webkitfullscreenchange 로 버튼 아이콘·aria 상태를 맞춘다.
   · API 를 막는 환경(인앱 브라우저 · 헤드리스 · 아이폰 사파리)에서는 예외를
     밖으로 던지지 않고 'unsupported' 로 조용히 돌려준다 — 게임은 그대로 돈다.
   ============================================================================= */

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
const ERROR_EVENTS = ['fullscreenerror', 'webkitfullscreenerror', 'mozfullscreenerror', 'MSFullscreenError'];

function root() {
  return document.documentElement || document.body || null;
}

/* 지금 전체화면 안에 있는가 (표준 + 접두어 + 구형 사파리 플래그) */
export function fullscreenElement() {
  const d = document;
  return d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement || null;
}

export function isFullscreen() {
  const d = document;
  return !!(fullscreenElement() || d.webkitIsFullScreen === true || d.mozFullScreen === true || d.msFullscreen === true);
}

/* 이 브라우저에서 전체화면을 켤 수 있는가 */
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

/* 버튼(들)을 전체화면 토글로 묶는다. 두 화면(홈 · 전장)의 버튼이 같은 상태를 쓴다. */
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
        await callExit();
        return sync();
      }
      if (!fullscreenSupported()) {
        paint(false);
        onError('unsupported');
        return false;
      }
      await callRequest(root());
      /* 크롬은 성공 시 fullscreenchange 를 곧 보낸다. 이벤트 전에 눌린
         아이콘이 그대로 남지 않도록 여기서도 한 번 맞춘다. */
      return sync();
    } catch (e) {
      /* 거부·미지원 — 예외는 여기서 끝낸다 (게임 루프는 계속 돈다) */
      paint(isFullscreen());
      onError('failed', e);
      return false;
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
  sync();

  return { toggle, sync, paint, isFullscreen, supported: fullscreenSupported };
}
