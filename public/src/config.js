/* =============================================================================
   config.js — 밸런스·스펙·성장 규칙 (DOM 없이도 돌아가는 순수 모듈 · npm test 대상)
   -----------------------------------------------------------------------------
   기준: ⚔️ 일반 병사 = 1.0x.  특수 유닛(기사·마법사)은 병사 대비 뚜렷한 2배 체급.
   아군·적군 스펙은 완전히 동일하다(진영은 색만 다르다).
   ============================================================================= */

export const MAX_SOLDIERS = 10000;
export const MAX_SPECIALS = 20;

/* 처치당 영구 누적 성장: +0.001% = +0.00001 배 */
export const GROWTH_PER_KILL = 0.00001;
/* 시체가 전장에 남아 있는 시간(초) */
export const CORPSE_TIME = 2.0;
/* 무릎 꿇는 시간 / 쓰러지는 시간(초) */
export const KNEEL_TIME = 0.52;
export const FALL_TIME = 0.42;

export const CLASSES = {
  soldier: {
    key: 'soldier',
    icon: '⚔️',
    name: '일반 병사',
    tag: 'BALANCED',
    blurb: '검과 방패, 민첩한 연속 베기. 모든 전장의 기준.',
    hp: 100,
    damage: 12,
    speed: 3.9,
    radius: 0.38,
    height: 1.72,
    reach: 2.05,
    arc: 1.95,          // 공격 판정 반각(rad)
    cycle: 0.48,        // 공격 1회 주기 = 공속 게이지가 차는 시간
    animDur: 0.92,      // 모션 키프레임 원본 길이 (실제로는 cycle 에 맞춰 재생)
    windup: 0.30,       // 예비동작
    impact: 0.42,       // 무기 접촉 프레임(animDur 기준)
    maxTargets: 1,
    aoe: 0,
    armor: 0.0,
    mass: 1.0,
    viewEye: 1.62
  },
  knight: {
    key: 'knight',
    icon: '🔨',
    name: '중갑 기사',
    tag: 'HEAVY · AOE',
    blurb: '큰 망치를 든 중갑 장군. 한 번의 내리치기로 최대 5명을 으스러뜨린다.',
    hp: 420,            // 무거운 망치 · 단단하다
    damage: 110,        // 일반 병사(100)를 한 번에 처치
    speed: 3.1,
    radius: 0.52,
    height: 1.94,
    reach: 2.75,
    arc: 2.35,
    cycle: 1.15,        // 묵직하고 느린 공속
    animDur: 1.72,
    windup: 0.60,
    impact: 0.80,
    maxTargets: 5,      // 광역 최대 5명
    aoe: 2.9,
    armor: 0.18,
    mass: 2.4,
    viewEye: 1.78
  },
  blademaster: {
    key: 'blademaster',
    icon: '🌸',
    name: '매화 검객',
    tag: 'SWIFT · DASH',
    blurb: '매화처럼 흩날리는 초고속 연속 베기. 스킬로 전방을 쓸어버리는 돌진 참격.',
    hp: 115,            // 가벼운 검 · 체력은 가볍게
    damage: 105,        // 일반 병사(100)를 한 번에 처치
    speed: 5.0,
    radius: 0.38,
    height: 1.76,
    reach: 2.35,
    arc: 2.25,
    cycle: 0.34,        // 가장 빠른 공속
    animDur: 0.80,
    windup: 0.22,
    impact: 0.34,
    maxTargets: 4,      // 한 번의 베기로 최대 4명
    aoe: 0,
    armor: 0.03,
    mass: 0.95,
    viewEye: 1.64
  },
  wizard: {
    key: 'wizard',
    icon: '🔮',
    name: '대마법사',
    tag: 'GLASS CANNON',
    blurb: '종이처럼 얇은 몸, 그러나 세 가지 마법으로 전장을 지운다.',
    hp: 80,             // 유리 대포
    damage: 9,          // 지팡이 근접(최후의 수단)
    speed: 3.6,
    radius: 0.36,
    height: 1.78,
    reach: 1.9,
    arc: 1.6,
    cycle: 0.75,        // 시전 공속
    animDur: 1.06,
    windup: 0.28,
    impact: 0.44,
    maxTargets: 1,
    aoe: 0,
    armor: 0.0,
    mass: 0.85,
    viewEye: 1.66
  }
};

/* 클래스별 공속/타격 시각 (모션 길이를 cycle 에 맞춰 재생) */
export function impactAt(cls) {
  const s = CLASSES[cls] || CLASSES.soldier;
  return s.cycle * (s.impact / (s.animDur || s.cycle));
}
export function animTimes(cls) {
  const s = CLASSES[cls] || CLASSES.soldier;
  return { cycle: s.cycle, animDur: s.animDur || s.cycle, impact: impactAt(cls) };
}

/* 마법 3종 — 쿨타임 · 위력 · 형태 */
export const SPELLS = {
  fire: {
    key: 'fire',
    name: '화염구',
    short: '화염',
    icon: '🔥',
    cooldown: 3.2,
    cast: 0.42,
    damage: 125,
    radius: 3.5,
    range: 19,
    color: 0xff7a24,
    glow: 0xffb257,
    desc: '전방 지점에 광역 화염 폭발'
  },
  lightning: {
    key: 'lightning',
    name: '연쇄 번개',
    short: '번개',
    icon: '⚡',
    cooldown: 5.6,
    cast: 0.34,
    damage: 105,
    jumps: 4,           // 최대 대상 수
    falloff: 0.78,      // 연쇄마다 위력 감소
    range: 17,
    color: 0x7fd8ff,
    glow: 0xd8f4ff,
    desc: '최대 4명을 연쇄 감전'
  },
  ice: {
    key: 'ice',
    name: '빙결 파동',
    short: '빙결',
    icon: '❄️',
    cooldown: 7.4,
    cast: 0.46,
    damage: 100,
    radius: 7.4,
    halfAngle: Math.PI / 3.1,   // 전방 약 58°
    freeze: 1.35,
    color: 0x8fdcff,
    glow: 0xe6fbff,
    desc: '전방 부채꼴 관통 빙결·강타'
  }
};
export const SPELL_ORDER = ['fire', 'lightning', 'ice'];

/* 매화 검객 고유 스킬 — 돌진 참격 */
export const SKILL = {
  key: 'petal',
  name: '매화 일섬',
  icon: '🌸',
  cooldown: 5.0,
  damage: 145,
  radius: 2.6,
  dash: 7.2,
  dashTime: 0.34,
  color: 0xff9ec8
};

/* 표시용 전투력 지수 (병사 = 1.00 기준 · 특수 유닛은 2배 체급) */
export const POWER_INDEX = { soldier: 1.0, knight: 2.0, wizard: 2.4, blademaster: 2.2 };
export function powerIndex(cls) {
  return POWER_INDEX[cls] || 1.0;
}

/* 플레이어 성장 배율 */
export function growthMult(kills) {
  return 1 + Math.max(0, kills | 0) * GROWTH_PER_KILL;
}

/* 성장은 피해량·최대 체력에 동일하게 곱해진다 (AI 기본 스펙 대비 누적 강화) */
export function playerSpec(cls, kills) {
  const base = CLASSES[cls] || CLASSES.soldier;
  const m = growthMult(kills);
  return { ...base, damage: base.damage * m, hp: base.hp * m, growth: m };
}

export function growthLabel(kills) {
  const pct = (Math.max(0, kills | 0) * GROWTH_PER_KILL) * 100;
  return '+' + pct.toFixed(3) + '%';
}

const STORE_KEY = 'ba3d.progress.v1';

export function loadProgress(store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return { kills: 0 };
  try {
    const raw = s.getItem(STORE_KEY);
    if (!raw) return { kills: 0 };
    const o = JSON.parse(raw);
    return { kills: Math.max(0, Number(o && o.kills) | 0) };
  } catch (e) { return { kills: 0 }; }
}

export function saveProgress(p, store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return false;
  try {
    s.setItem(STORE_KEY, JSON.stringify({ kills: Math.max(0, p.kills | 0), at: Date.now() }));
    return true;
  } catch (e) { return false; }
}

export function addKill(p, n) {
  p.kills = Math.max(0, (p.kills | 0) + (n === undefined ? 1 : n));
  return p;
}

/* 소환 조합 → 진영별 인원 */
export function rosterOf(cfg) {
  const c = cfg || {};
  const pick = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  return {
    ally: {
      soldier: pick(c.allySoldiers, MAX_SOLDIERS),
      knight: pick(c.allyKnights, MAX_SPECIALS),
      wizard: pick(c.allyWizards, MAX_SPECIALS),
      blademaster: pick(c.allyBlademasters, MAX_SPECIALS)
    },
    enemy: {
      soldier: pick(c.enemySoldiers, MAX_SOLDIERS),
      knight: pick(c.enemyKnights, MAX_SPECIALS),
      wizard: pick(c.enemyWizards, MAX_SPECIALS),
      blademaster: pick(c.enemyBlademasters, MAX_SPECIALS)
    }
  };
}

export function rosterTotal(r) {
  return r.ally.soldier + r.ally.knight + r.ally.wizard + (r.ally.blademaster || 0) +
         r.enemy.soldier + r.enemy.knight + r.enemy.wizard + (r.enemy.blademaster || 0);
}

export const TEAM = {
  ally: { key: 'ally', name: '아군', cloth: 0x2f6f9e, trim: 0x9fd8ff, banner: 0x2f7fc4, ui: '#5fb8ff' },
  enemy: { key: 'enemy', name: '적군', cloth: 0x8f2b2b, trim: 0xffc46b, banner: 0xc2402f, ui: '#ff6b5a' }
};
