/* =============================================================================
   config.js — 밸런스·스펙·성장 규칙 (DOM 없이도 돌아가는 순수 모듈 · npm test 대상)
   -----------------------------------------------------------------------------
   기준: ⚔️ 일반 병사 = 1.0x.
   · 고급 병사(ELITE) = 일반 병사의 체력·이속·공속 +10% · 5회 막기 후 19초 재충전
   · 특수 유닛(기사·마법사·검객)은 병사보다 뚜렷하게 강한 체급
   아군·적군 스펙은 완전히 동일하다(진영은 색만 다르다).
   ============================================================================= */

export const MAX_SOLDIERS = 10000;
export const MAX_ELITES = 1000;      // 고급 병사 상한
export const MAX_SPECIALS = 100;     // 기사·마법사·검객 상한

/* 처치당 영구 누적 성장: +0.001% = +0.00001 배 */
export const GROWTH_PER_KILL = 0.00001;
/* 시체가 전장에 남아 있는 시간(초) */
export const CORPSE_TIME = 2.0;
/* 무릎 꿇는 시간 / 쓰러지는 시간(초) */
export const KNEEL_TIME = 0.52;
export const FALL_TIME = 0.42;

/* 🩸 부위 절단 — 팔/다리가 잘리면 해당 능력이 30% 떨어진다 (양쪽 다 잃으면 사망) */
export const LIMB_LOSS = 0.30;
/* 정면 막기 판정 반각(rad) — 이 각도 안에서 날아온 공격은 종류를 가리지 않고 완전 방어 */
export const GUARD_FRONT_HALF = 1.35;   // ≈ ±77°
/* 🛡️ AI 막기 빈도 — 힘이 아니라 '막는 횟수' 기준.
   너프 전 병사 = 반응형 0.62 / 대치 중 0.35.
   · 일반 병사 = 그 90% (0.56 / 0.315) · 쿨타임도 짧게
   · 고급 병사 = 그 110% (0.68 / 0.385) · 횟수 제한 없음 */
export const GUARD_CHANCE = {
  soldier: { react: 0.56, hold: 0.315, cd: 0.9 },
  elite: { react: 0.68, hold: 0.385, cd: 0.7 }
};

/* 유닛별 증원(스폰) 간격 — 고급 병사·특수 유닛은 일반 병사보다 더 자주 들어온다 */
export const SPAWN_INTERVAL = {
  soldier: 0.14,
  elite: 0.07,
  blademaster: 0.085,
  knight: 0.10,
  wizard: 0.11
};
/* 전장에 동시에 서 있는 비율 (나머지는 예비 — 죽은 자리가 날 때마다 순차 투입) */
export const FIELD_RATIO = { soldier: 0.6, elite: 0.55, knight: 0.75, wizard: 0.75, blademaster: 0.75 };
/* 전장 동시 배치 상한 */
export const FIELD_MAX = { soldier: 160, elite: 400, knight: 60, wizard: 60, blademaster: 60 };

export const CLASSES = {
  soldier: {
    key: 'soldier',
    icon: '⚔️',
    name: '일반 병사',
    tag: 'BALANCED',
    blurb: '검과 방패, 민첩한 연속 베기. 모든 전장의 기준.',
    hp: 120,
    damage: 120,        // 병사끼리도 한 방 — 검으로 막는 것이 핵심
    speed: 4.15,
    radius: 0.38,
    height: 1.72,
    reach: 2.05,
    arc: 1.95,          // 공격 판정 반각(rad)
    cycle: 0.82,        // 공격 1회 주기 = 공속 게이지가 차는 시간 (한 번 베고 다시 들기까지 여유)
    animDur: 0.92,      // 모션 키프레임 원본 길이 (실제로는 cycle 에 맞춰 재생)
    windup: 0.30,       // 예비동작
    impact: 0.42,       // 무기 접촉 프레임(animDur 기준)
    maxTargets: 1,
    aoe: 0,
    armor: 0.0,
    mass: 1.0,
    viewEye: 1.62,
    guard: true
  },
  elite: {
    key: 'elite',
    icon: '🛡️',
    name: '고급 병사',
    tag: 'VETERAN · GUARD',
    blurb: '금장 판금과 방패를 든 베테랑. 체력·이속·공속이 병사보다 10% 높고, 정면 공격을 병사보다 훨씬 잘 받아넘긴다.',
    hp: 132,            // 일반 병사(120) × 1.1
    damage: 120,
    speed: 4.57,        // 병사 4.15 × 1.1
    radius: 0.39,
    height: 1.78,
    reach: 2.12,
    arc: 1.95,
    cycle: 0.745,       // 병사 0.82 ÷ 1.1 (10% 빠른 공속)
    animDur: 0.84,
    windup: 0.27,
    impact: 0.40,
    maxTargets: 1,
    aoe: 0,
    armor: 0.05,
    mass: 1.06,
    viewEye: 1.66,
    guard: true
  },
  knight: {
    key: 'knight',
    icon: '🔨',
    name: '중갑 기사',
    tag: 'HEAVY · AOE 100',
    blurb: '큰 망치를 든 중갑 장군. 한 번의 내리치기로 전방의 적을 최대 100명까지 으스러뜨린다.',
    hp: 1200,           // 무거운 망치 · 단단하다 (병사의 10배)
    damage: 220,        // 일반 병사(120)를 한 번에 처치
    speed: 3.3,
    radius: 0.52,
    height: 1.94,
    reach: 2.9,
    arc: 2.35,
    cycle: 1.15,        // 묵직하고 느린 공속
    animDur: 1.72,
    windup: 0.60,
    impact: 0.80,
    maxTargets: 100,    // 광역 최대 100명
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
    hp: 650,            // 가벼운 검 · 단단한 수련 (병사의 5.4배)
    damage: 210,        // 일반 병사(120)를 한 번에 처치
    speed: 5.4,
    radius: 0.38,
    height: 1.76,
    reach: 2.35,
    arc: 2.3,
    cycle: 0.34,        // 가장 빠른 공속
    animDur: 0.80,
    windup: 0.22,
    impact: 0.34,
    maxTargets: 10,     // 한 번의 베기로 최대 10명
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
    hp: 240,            // 유리 대포 (병사의 4배)
    damage: 18,         // 지팡이 근접(최후의 수단)
    speed: 3.3,
    radius: 0.36,
    height: 1.78,
    reach: 1.9,
    arc: 1.6,
    cycle: 0.86,        // 시전 공속 (조금 느려졌다)
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

/* 마법 3종 — 쿨타임 · 위력 · 형태 (쿨타임 소폭 상향) */
export const SPELLS = {
  fire: {
    key: 'fire',
    name: '화염구',
    short: '화염',
    icon: '🔥',
    cooldown: 3.8,
    cast: 0.42,
    damage: 250,
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
    cooldown: 6.6,
    cast: 0.34,
    damage: 210,
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
    cooldown: 8.6,
    cast: 0.46,
    damage: 200,
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
  damage: 290,
  radius: 2.8,
  dash: 7.2,
  dashTime: 0.34,
  color: 0xff9ec8
};

/* 표시용 전투력 지수 (병사 = 1.00 기준) */
export const POWER_INDEX = { soldier: 1.0, elite: 1.12, knight: 2.6, wizard: 2.4, blademaster: 3.2 };
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

const STORE_KEY = 'ba3d.progress.v2';

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
      elite: pick(c.allyElites, MAX_ELITES),
      knight: pick(c.allyKnights, MAX_SPECIALS),
      wizard: pick(c.allyWizards, MAX_SPECIALS),
      blademaster: pick(c.allyBlademasters, MAX_SPECIALS)
    },
    enemy: {
      soldier: pick(c.enemySoldiers, MAX_SOLDIERS),
      elite: pick(c.enemyElites, MAX_ELITES),
      knight: pick(c.enemyKnights, MAX_SPECIALS),
      wizard: pick(c.enemyWizards, MAX_SPECIALS),
      blademaster: pick(c.enemyBlademasters, MAX_SPECIALS)
    }
  };
}

export function sideTotal(r) {
  return r.soldier + (r.elite || 0) + r.knight + r.wizard + (r.blademaster || 0);
}

export function rosterTotal(r) {
  return sideTotal(r.ally) + sideTotal(r.enemy);
}

export const TEAM = {
  ally: { key: 'ally', name: '아군', cloth: 0x2f6f9e, trim: 0x9fd8ff, banner: 0x2f7fc4, ui: '#5fb8ff' },
  enemy: { key: 'enemy', name: '적군', cloth: 0x8f2b2b, trim: 0xffc46b, banner: 0xc2402f, ui: '#ff6b5a' }
};
