/* =============================================================================
   hud-custom.js — 🎮 전투 HUD 버튼 크기·위치 커스텀 (2026-11-26)
   -----------------------------------------------------------------------------
   · 홈 화면 「🎮 버튼 크기·위치 설정」 → 실제 전장 화면 비율 그대로의 편집기
   · 조이스틱 · 공격(베기) · 검 막기 · 특수 스킬 · 마법 버튼을 끌어서 옮기고
     슬라이더(70~160%)로 크기를 바꾼다. 화면 밖으로는 나가지 않게 클램프.
   · 저장은 localStorage — 새로고침해도 유지되고 「기본값 초기화」로 언제든 복구.
   · 저장값은 "화면 대비 비율(0~1) + 배율"이라 세로·가로·전체화면 어디서든 같은
     자리에 놓인다. 배율은 CSS 기본 크기에 곱해지므로 전체화면 1.1배 보정과도
     충돌하지 않는다.
   ============================================================================= */
import { clamp } from './util.js';

export const HUD_STORAGE_KEY = 'ba.hudLayout.v1';
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 1.6;

/* 편집 대상 — 실제 전장 HUD 와 편집기 미리보기가 같은 순서를 쓴다 */
export const HUD_SLOTS = [
  { id: 'joy', name: '조이스틱', chip: '🕹️ 조이스틱' },
  { id: 'attack', name: '공격(베기)', chip: '⚔️ 공격' },
  { id: 'guard', name: '검 막기', chip: '🛡️ 막기' },
  { id: 'skill', name: '특수 스킬', chip: '🌸 스킬' },
  { id: 'spells', name: '마법', chip: '🔥 마법' }
];
const SLOT_IDS = HUD_SLOTS.map((s) => s.id);
const REAL_SEL = { joy: '#joy', attack: '#attackBtn', guard: '#guardBtn', skill: '#skillBtn', spells: '#spellWheel' };
const PREVIEW_SEL = { joy: '#heJoy', attack: '#heAttack', guard: '#heGuard', skill: '#heSkill', spells: '#heSpells' };

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = (v, d) => clamp(num(v, d), 0.001, 0.999);

/* --------------------------------------------------------------- 저장소 */
export function loadHudLayout() {
  try {
    const raw = localStorage.getItem(HUD_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.slots) return null;
    const out = {};
    for (const id of SLOT_IDS) {
      const v = o.slots[id];
      if (!v || typeof v !== 'object') return null;
      out[id] = { x: norm(v.x, 0.5), y: norm(v.y, 0.5), s: clamp(num(v.s, 1), MIN_SCALE, MAX_SCALE) };
    }
    return out;
  } catch (err) {
    return null;
  }
}

export function saveHudLayout(slots) {
  try {
    localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), slots }));
    return true;
  } catch (err) {
    return false;
  }
}

export function clearHudLayout() {
  try { localStorage.removeItem(HUD_STORAGE_KEY); return true; } catch (err) { return false; }
}

function cloneSlots(slots) {
  const out = {};
  for (const id of SLOT_IDS) {
    const c = slots && slots[id];
    out[id] = c ? { x: c.x, y: c.y, s: c.s } : { x: 0.5, y: 0.5, s: 1 };
  }
  return out;
}

const hasLayout = (layout) => !!layout && SLOT_IDS.every((id) => {
  const c = layout[id];
  return c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.s);
});

/* --------------------------------------------------------------- 배치 적용 */
function placeItem(el, cfg) {
  if (!el || !cfg) return;
  el.classList.add('hud-item');
  el.style.position = 'absolute';
  el.style.left = (cfg.x * 100).toFixed(3) + '%';
  el.style.top = (cfg.y * 100).toFixed(3) + '%';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.margin = '0';
  el.style.setProperty('--hs', String(cfg.s));
}

function unplaceItem(el) {
  if (!el) return;
  el.classList.remove('hud-item');
  for (const k of ['position', 'left', 'top', 'right', 'bottom', 'margin']) el.style[k] = '';
  el.style.removeProperty('--hs');
}

/* .actions 는 기본이 flex 세로 정렬 — 커스텀 배치에서는 화면 전체를 덮는 판으로.
   display 는 인라인이 아니라 클래스로 바꿔야 관전 모드(`#battle.is-spectate … { display:none }`)가
   그대로 이긴다 (인라인이면 관전 중에도 액션 버튼이 남는다). */
function freeActions(el, on) {
  if (!el) return;
  if (on) {
    el.classList.add('hud-free');
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.right = '0';
    el.style.bottom = '0';
  } else {
    el.classList.remove('hud-free');
    for (const k of ['position', 'left', 'top', 'right', 'bottom']) el.style[k] = '';
  }
}

/* 화면 밖으로 나가지 않게 중심을 클램프 (보이는 크기 기준) */
function clampCfg(el, cfg, vw, vh) {
  const w = (el && el.offsetWidth ? el.offsetWidth : 0) * cfg.s;
  const h = (el && el.offsetHeight ? el.offsetHeight : 0) * cfg.s;
  const hx = w > 0 ? Math.min(0.5, w / 2 / Math.max(1, vw)) : 0;
  const hy = h > 0 ? Math.min(0.5, h / 2 / Math.max(1, vh)) : 0;
  return {
    x: clamp(cfg.x, hx, 1 - hx),
    y: clamp(cfg.y, hy, 1 - hy),
    s: cfg.s
  };
}

/* 실제 전장 HUD 에 적용 (layout 이 null 이면 기본 CSS 배치로 복귀) */
export function applyHudLayout(layout) {
  const battle = document.getElementById('battle');
  if (!battle) return false;
  const ok = hasLayout(layout);
  battle.classList.toggle('is-hud-custom', ok);
  freeActions(document.getElementById('actions'), ok);
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  /* 두 번 적는다 — 첫 번째는 자리만 잡고(폭이 auto 인 마법 휠은 이때 자연 폭이 된다),
     두 번째에서 보이는 크기 기준으로 화면 안으로 클램프한다. */
  for (const id of SLOT_IDS) {
    const el = document.querySelector(REAL_SEL[id]);
    if (!el) continue;
    if (!ok) { unplaceItem(el); continue; }
    placeItem(el, layout[id]);
  }
  if (ok) {
    for (const id of SLOT_IDS) {
      const el = document.querySelector(REAL_SEL[id]);
      if (el) placeItem(el, clampCfg(el, layout[id], vw, vh));
    }
  }
  return ok;
}

/* --------------------------------------------------------------- 편집기 */
export function initHudLayout(app) {
  const editor = document.getElementById('hudEditor');
  if (!editor) return null;
  const stage = document.getElementById('heStage');
  const frame = document.getElementById('heFrame');
  const wrap = document.getElementById('heStageWrap');
  const actions = document.getElementById('heActions');
  const chips = Array.from(document.querySelectorAll('#heChips button'));
  const sizeInput = document.getElementById('heSize');
  const sizeVal = document.getElementById('heSizeVal');
  const allBox = document.getElementById('heAll');
  const previewEl = (id) => document.querySelector(PREVIEW_SEL[id]);

  const ctl = {
    saved: loadHudLayout(),
    current: null,
    selected: 'joy',
    allMode: false,
    isOpen: false,
    drag: null,
    k: 1,
    apply() { return applyHudLayout(ctl.saved); },
    get() { return ctl.current ? cloneSlots(ctl.current) : null; },
    stored() { return ctl.saved ? cloneSlots(ctl.saved) : null; },
    isCustom() { return hasLayout(ctl.saved); },
    open, close, reset, save
  };

  const toast = (msg) => {
    if (app && typeof app._toast === 'function') app._toast(msg);
  };

  /* 편집기 스테이지 = 실제 화면과 같은 비율로 축소한 전장 */
  function layoutStage() {
    const wr = wrap.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    if (wr.width < 20 || wr.height < 20) return;
    const k = Math.min(wr.width / vw, wr.height / vh);
    ctl.k = k;
    frame.style.width = (vw * k).toFixed(1) + 'px';
    frame.style.height = (vh * k).toFixed(1) + 'px';
    stage.style.width = vw + 'px';
    stage.style.height = vh + 'px';
    stage.style.transform = 'scale(' + k.toFixed(4) + ')';
  }

  /* 기본 배치(CSS)에서 각 버튼의 중심을 화면 대비 비율로 잰다 */
  function measureDefaults() {
    const s = stage.getBoundingClientRect();
    const out = {};
    for (const id of SLOT_IDS) {
      const el = previewEl(id);
      if (!el) { out[id] = { x: 0.5, y: 0.5, s: 1 }; continue; }
      const r = el.getBoundingClientRect();
      out[id] = {
        x: clamp((r.left + r.width / 2 - s.left) / Math.max(1, s.width), 0.02, 0.98),
        y: clamp((r.top + r.height / 2 - s.top) / Math.max(1, s.height), 0.02, 0.98),
        s: 1
      };
    }
    return out;
  }

  const stageSize = () => ({
    vw: stage.offsetWidth || window.innerWidth || 1,
    vh: stage.offsetHeight || window.innerHeight || 1
  });

  function previewApply() {
    const ok = !!ctl.current;
    freeActions(actions, ok);
    /* 두 번 적기 — 마법 휠처럼 폭이 auto 인 요소는 먼저 자리를 잡아야 자연 폭이 나온다 */
    for (const id of SLOT_IDS) {
      const el = previewEl(id);
      if (!ok) { unplaceItem(el); continue; }
      placeItem(el, ctl.current[id]);
    }
    if (!ok) return;
    for (const id of SLOT_IDS) {
      const el = previewEl(id);
      if (!el) continue;
      const { vw, vh } = stageSize();
      placeItem(el, clampCfg(el, ctl.current[id], vw, vh));
    }
  }

  function syncChips() {
    for (const b of chips) {
      const id = b.dataset.slot;
      b.classList.toggle('is-on', id === ctl.selected);
      const em = b.querySelector('em');
      if (em) em.textContent = Math.round(((ctl.current && ctl.current[id] ? ctl.current[id].s : 1)) * 100) + '%';
    }
    for (const id of SLOT_IDS) {
      const el = previewEl(id);
      if (el) el.classList.toggle('is-selected', id === ctl.selected);
    }
    const c = ctl.current && ctl.current[ctl.selected];
    const pct = Math.round((c ? c.s : 1) * 100);
    if (sizeInput) sizeInput.value = String(pct);
    if (sizeVal) sizeVal.textContent = pct + '%';
  }

  function select(id) {
    if (SLOT_IDS.indexOf(id) < 0) return;
    ctl.selected = id;
    syncChips();
  }

  function moveTo(id, x, y) {
    const c = ctl.current && ctl.current[id];
    const el = previewEl(id);
    if (!c || !el) return;
    const { vw, vh } = stageSize();
    const box = clampCfg(el, { x, y, s: c.s }, vw, vh);
    c.x = box.x; c.y = box.y;
    placeItem(el, c);
  }

  function setScale(id, s) {
    const c = ctl.current && ctl.current[id];
    const el = previewEl(id);
    if (!c || !el) return;
    const { vw, vh } = stageSize();
    c.s = clamp(s, MIN_SCALE, MAX_SCALE);
    const box = clampCfg(el, c, vw, vh);
    c.x = box.x; c.y = box.y;
    placeItem(el, c);
  }

  function open() {
    ctl.isOpen = true;
    ctl.selected = 'joy';
    ctl.allMode = false;
    ctl.drag = null;
    if (allBox) allBox.checked = false;
    editor.classList.add('is-on');
    editor.setAttribute('aria-hidden', 'false');
    layoutStage();
    // 기본값이면 CSS 배치에서 재고, 저장값이 있으면 그대로 보여준다
    for (const id of SLOT_IDS) unplaceItem(previewEl(id));
    freeActions(actions, false);
    ctl.current = ctl.saved ? cloneSlots(ctl.saved) : measureDefaults();
    previewApply();
    syncChips();
  }

  function close() {
    ctl.isOpen = false;
    ctl.drag = null;
    editor.classList.remove('is-on');
    editor.setAttribute('aria-hidden', 'true');
    // 저장하지 않은 변경은 버린다
    ctl.current = ctl.saved ? cloneSlots(ctl.saved) : null;
    for (const id of SLOT_IDS) unplaceItem(previewEl(id));
    freeActions(actions, false);
    if (ctl.current) previewApply();
  }

  function save() {
    if (!ctl.current) ctl.current = measureDefaults();
    ctl.saved = cloneSlots(ctl.current);
    const okStore = saveHudLayout(ctl.saved);
    applyHudLayout(ctl.saved);
    close();
    toast(okStore ? '🎮 버튼 배치를 저장했어요' : '저장 공간이 없어 이번 판에만 적용돼요');
    return ctl.saved;
  }

  function reset() {
    clearHudLayout();
    ctl.saved = null;
    applyHudLayout(null);
    for (const id of SLOT_IDS) unplaceItem(previewEl(id));
    freeActions(actions, false);
    ctl.current = measureDefaults();
    ctl.allMode = false;
    if (allBox) allBox.checked = false;
    previewApply();
    select('joy');
    toast('기본 배치로 되돌렸어요');
    return ctl.current;
  }

  /* ---- 드래그로 위치 옮기기 ---- */
  stage.addEventListener('pointerdown', (e) => {
    const item = e.target.closest ? e.target.closest('.hud-item') : null;
    if (!item || !stage.contains(item)) return;
    e.preventDefault();
    const id = item.dataset.slot;
    if (!id || !ctl.current || !ctl.current[id]) return;
    select(id);
    const r = stage.getBoundingClientRect();
    const nx = (e.clientX - r.left) / Math.max(1, r.width);
    const ny = (e.clientY - r.top) / Math.max(1, r.height);
    ctl.drag = { id, pid: e.pointerId, dx: nx - ctl.current[id].x, dy: ny - ctl.current[id].y };
    item.classList.add('is-drag');
    try { item.setPointerCapture(e.pointerId); } catch (err) { /* 합성 이벤트 */ }
  }, { passive: false });

  const onMove = (e) => {
    const d = ctl.drag;
    if (!d) return;
    if (e.pointerId !== undefined && d.pid !== undefined && e.pointerId !== d.pid) return;
    if (e.cancelable) e.preventDefault();
    const r = stage.getBoundingClientRect();
    const nx = (e.clientX - r.left) / Math.max(1, r.width);
    const ny = (e.clientY - r.top) / Math.max(1, r.height);
    moveTo(d.id, nx - d.dx, ny - d.dy);
  };
  const onUp = (e) => {
    const d = ctl.drag;
    if (!d) return;
    if (e && e.pointerId !== undefined && d.pid !== undefined && e.pointerId !== d.pid) return;
    ctl.drag = null;
    for (const id of SLOT_IDS) {
      const el = previewEl(id);
      if (el) el.classList.remove('is-drag');
    }
  };
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  /* ---- 크기 슬라이더 ---- */
  if (sizeInput) {
    sizeInput.addEventListener('input', () => {
      if (!ctl.current) return;
      const s = clamp(num(sizeInput.value, 100) / 100, MIN_SCALE, MAX_SCALE);
      if (ctl.allMode) for (const id of SLOT_IDS) setScale(id, s);
      else setScale(ctl.selected, s);
      syncChips();
    });
  }
  if (allBox) {
    allBox.addEventListener('change', () => {
      ctl.allMode = !!allBox.checked;
    });
  }

  /* ---- 칩 · 버튼 ---- */
  for (const b of chips) {
    b.addEventListener('click', () => select(b.dataset.slot));
  }
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('heClose', close);
  on('heCancel', close);
  on('heSave', save);
  on('heReset', reset);

  /* ---- 바깥에서 여는 버튼 ---- */
  const openBtn = document.getElementById('hudCfgBtn');
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (app && app.sfx) { try { app.sfx.resume(); app.sfx.ui(); } catch (err) { /* 무음 */ } }
      open();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (ctl.isOpen && (e.key === 'Escape' || e.code === 'Escape')) { e.preventDefault(); close(); }
  });

  /* 화면이 바뀌면(회전·전체화면) 편집기 미리보기와 실제 HUD 를 다시 맞춘다 */
  let rzT = 0;
  const relayout = () => {
    if (ctl.isOpen) { layoutStage(); previewApply(); }
    applyHudLayout(ctl.saved);
  };
  window.addEventListener('resize', () => {
    clearTimeout(rzT);
    rzT = setTimeout(relayout, 60);
  });
  window.addEventListener('orientationchange', () => setTimeout(relayout, 240));

  /* 시작 시 저장된 배치를 실제 전장 HUD 에 적용 */
  applyHudLayout(ctl.saved);
  return ctl;
}
