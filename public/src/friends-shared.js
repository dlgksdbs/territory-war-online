/* =============================================================================
   친구와 플레이 · 공용 상수와 소켓 (홈 화면 패널 + /friends/ 게임 페이지가 함께 쓴다)
   서버 friends.js 의 편성 규칙과 같은 수치를 유지한다.
   ============================================================================= */

export const UNIT_KEYS = ['soldier', 'elite', 'knight', 'wizard', 'blademaster', 'berserker'];

export const UNITS = {
  soldier: { key: 'soldier', name: '일반 병사', icon: '⚔️', cost: 1, cap: 2000, maxInput: 6000, hp: 150, power: 1, siege: 0.18 },
  elite: { key: 'elite', name: '고급 병사', icon: '🛡️', cost: 1, cap: 500, maxInput: 1500, hp: 165, power: 1.15, siege: 0.30 },
  knight: { key: 'knight', name: '중갑 기사', icon: '🔨', cost: 25, cap: 20, maxInput: 60, hp: 2900, power: 10, siege: 4.0 },
  wizard: { key: 'wizard', name: '대마법사', icon: '🔮', cost: 12, cap: 20, maxInput: 60, hp: 240, power: 5, siege: 2.0 },
  blademaster: { key: 'blademaster', name: '매화 검객', icon: '🌸', cost: 20, cap: 20, maxInput: 60, hp: 1200, power: 5, siege: 1.5 },
  berserker: { key: 'berserker', name: '단검 광전사', icon: '🩸', cost: 30, cap: 20, maxInput: 60, hp: 3600, power: 4, siege: 1.0 }
};

export const BUDGET = 5000;
export const WALL = { base: 3000, step: 1000, cost: 40, maxBonus: 6000 };
export const CASTLE = { base: 6000, step: 1000, cost: 55, maxBonus: 8000 };

export const PRESETS = {
  balanced: {
    label: '골고루', icon: '⚖️',
    units: { soldier: 2000, elite: 500, knight: 12, wizard: 15, blademaster: 10, berserker: 8 },
    wallBonus: 4000, castleBonus: 6000
  },
  attack: {
    label: '공격 몰빵', icon: '⚔️',
    units: { soldier: 2000, elite: 500, knight: 20, wizard: 20, blademaster: 20, berserker: 20 },
    wallBonus: 1000, castleBonus: 4000
  },
  defense: {
    label: '수비 몰빵', icon: '🛡️',
    units: { soldier: 2000, elite: 500, knight: 5, wizard: 5, blademaster: 5, berserker: 5 },
    wallBonus: 6000, castleBonus: 8000
  }
};

export const NATION_COLORS = ['#4aa3ff', '#ff5f5f', '#45d18a', '#ffc247', '#b07bff'];

export function setupCost(setup) {
  if (!setup) return 0;
  let cost = 0;
  for (const k of UNIT_KEYS) cost += (Number(setup.units && setup.units[k]) || 0) * UNITS[k].cost;
  cost += ((Number(setup.wallBonus) || 0) / WALL.step) * WALL.cost;
  cost += ((Number(setup.castleBonus) || 0) / CASTLE.step) * CASTLE.cost;
  return cost;
}

export function totalUnits(units) {
  let n = 0;
  for (const k of UNIT_KEYS) n += Number(units && units[k]) || 0;
  return n;
}

export function fmt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('ko-KR');
}

export function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

export function cloneSetup(setup) {
  const s = setup || PRESETS.balanced;
  const units = {};
  for (const k of UNIT_KEYS) units[k] = Math.max(0, Math.round(Number(s.units && s.units[k]) || 0));
  return {
    units,
    wallBonus: Math.max(0, Math.round((Number(s.wallBonus) || 0) / WALL.step) * WALL.step),
    castleBonus: Math.max(0, Math.round((Number(s.castleBonus) || 0) / CASTLE.step) * CASTLE.step),
    preset: s.preset || 'custom'
  };
}

export function presetSetup(name) {
  return cloneSetup(PRESETS[name] || PRESETS.balanced);
}

export function clampSetup(setup) {
  const s = cloneSetup(setup);
  for (const k of UNIT_KEYS) s.units[k] = Math.max(0, Math.min(UNITS[k].maxInput, Math.round(s.units[k])));
  s.wallBonus = Math.max(0, Math.min(WALL.maxBonus, s.wallBonus));
  s.castleBonus = Math.max(0, Math.min(CASTLE.maxBonus, s.castleBonus));
  return s;
}

/* 서버와 같은 주소(/ws)로 붙는 얇은 소켓 래퍼 */
export function connectFriends(handlers) {
  const h = handlers || {};
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const ws = new WebSocket(url);
  const queue = [];
  const flush = () => {
    while (queue.length && ws.readyState === 1) {
      try { ws.send(queue.shift()); } catch (e) { /* noop */ }
    }
  };
  ws.onopen = () => { flush(); if (h.onOpen) h.onOpen(); };
  ws.onclose = () => h.onClose && h.onClose();
  ws.onerror = () => h.onError && h.onError();
  ws.onmessage = (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw.data)); } catch (e) { return; }
    if (msg && h.onMessage) h.onMessage(msg);
  };
  return {
    ws,
    send(obj) {
      const raw = JSON.stringify(obj);
      if (ws.readyState === 1) { try { ws.send(raw); } catch (e) { /* noop */ } return; }
      if (ws.readyState === 0) queue.push(raw);
    },
    close() { try { ws.close(); } catch (e) { /* noop */ } },
    ready() { return ws.readyState === 1; }
  };
}
