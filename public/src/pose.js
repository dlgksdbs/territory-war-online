/* =============================================================================
   pose.js — 절차적 전투 모션
   -----------------------------------------------------------------------------
   · 대기: 호흡·무게 이동·무기 흔들림
   · 이동: 보폭·무릎 접힘·골반 흔들림·상체 반동 (달릴수록 앞으로 기움)
   · 공격: 예비동작(몸통 코일) → 몸통 회전 + 어깨→팔꿈치→손목 연동 →
           살짝 대각선으로 묵직하게 썰기/내리치기 → 팔로우스루 → 복귀
   · 피격: 순간 젖혀짐
   · 사망: 상흔과 함께 무릎 꿇고(체중이 무너지며) → 앞으로 쓰러져 → 시체 유지
   ============================================================================= */
import { clamp, lerp, smoothstep, easeOutCubic, easeInCubic, easeOutQuint, seg, TAU } from './util.js';
import { CLASSES, SKILL } from './config.js';
import { J, JOINT_COUNT } from './rig.js';

const R = (p, j, x, y, z, w) => {
  const i = j * 3, k = w === undefined ? 1 : w;
  p.rot[i] += x * k; p.rot[i + 1] += y * k; p.rot[i + 2] += z * k;
};
const ROT = (j, x, y, z) => [j, x, y, z];

/* ---------------------------------------------------------------------------
   기본 자세 (클래스별)
   --------------------------------------------------------------------------- */
const BASE = {
  soldier: [
    ROT('pelvis', 0.01, 0, 0),
    ROT('spine', 0.06, -0.04, 0),
    ROT('chest', -0.03, 0.03, 0),
    ROT('neck', 0.02, 0, 0),
    ROT('head', -0.05, 0.04, 0),
    ROT('shR', 0, 0, -0.06),
    ROT('armR', -0.20, 0, 0.17),
    ROT('elbR', -0.62, 0.10, 0),
    ROT('handR', 0.62, -0.12, 0.20),
    ROT('shL', 0, 0, 0.06),
    ROT('armL', -0.34, 0, -0.20),
    ROT('elbL', -1.02, 0, 0),
    ROT('handL', 0.10, 0, -0.10),
    ROT('thighR', -0.05, 0, 0.07),
    ROT('shinR', 0.16, 0, 0),
    ROT('footR', -0.11, 0, 0),
    ROT('thighL', 0.05, 0, -0.07),
    ROT('shinL', 0.14, 0, 0),
    ROT('footL', -0.10, 0, 0)
  ],
  elite: [
    ROT('pelvis', 0.01, 0, 0),
    ROT('spine', 0.07, -0.05, 0),
    ROT('chest', -0.02, 0.05, 0),
    ROT('neck', 0.02, 0, 0),
    ROT('head', -0.06, 0.05, 0),
    /* 오른손 장검은 살짝 앞으로, 왼팔은 방패를 세워 몸 앞을 가린다 */
    ROT('shR', 0, 0, -0.07),
    ROT('armR', -0.30, 0, 0.20),
    ROT('elbR', -0.72, 0.10, 0),
    ROT('handR', 0.66, -0.10, 0.18),
    ROT('shL', 0.02, 0.10, 0.10),
    ROT('armL', -0.68, -0.18, -0.16),
    ROT('elbL', -1.24, 0, 0),
    ROT('handL', 0.12, 0.30, -0.12),
    ROT('thighR', -0.07, 0, 0.10),
    ROT('shinR', 0.20, 0, 0),
    ROT('footR', -0.13, 0, 0),
    ROT('thighL', 0.07, 0, -0.10),
    ROT('shinL', 0.18, 0, 0),
    ROT('footL', -0.12, 0, 0)
  ],
  knight: [
    ROT('pelvis', 0.02, 0, 0),    ROT('spine', 0.08, 0.02, 0),
    ROT('chest', 0.02, -0.02, 0),
    ROT('neck', 0.03, 0, 0),
    ROT('head', -0.08, 0.02, 0),
    ROT('shR', 0, 0, -0.10),
    ROT('armR', -0.62, -0.15, 0.16),
    ROT('elbR', -1.05, 0.15, 0),
    ROT('handR', 1.02, 0.05, 0.10),
    ROT('shL', 0, 0, 0.10),
    ROT('armL', -0.95, 0.22, -0.34),
    ROT('elbL', -1.22, 0, 0),
    ROT('handL', 0.56, 0, -0.10),
    ROT('thighR', -0.04, 0, 0.16),
    ROT('shinR', 0.20, 0, 0),
    ROT('footR', -0.14, 0, 0),
    ROT('thighL', 0.04, 0, -0.16),
    ROT('shinL', 0.18, 0, 0),
    ROT('footL', -0.13, 0, 0)
  ],
  blademaster: [
    ROT('pelvis', 0.03, 0, 0),
    ROT('spine', 0.10, -0.12, 0),
    ROT('chest', -0.02, 0.10, 0),
    ROT('neck', 0.01, 0, 0),
    ROT('head', -0.04, 0.10, 0),
    ROT('shR', 0, 0, -0.08),
    ROT('armR', -0.42, -0.10, 0.30),
    ROT('elbR', -0.95, 0.10, 0),
    ROT('handR', 0.30, -0.55, 0.15),
    ROT('shL', 0, 0, 0.08),
    ROT('armL', -0.52, 0.10, -0.30),
    ROT('elbL', -1.15, 0, 0),
    ROT('handL', 0.20, 0, -0.10),
    ROT('thighR', -0.10, 0, 0.12),
    ROT('shinR', 0.24, 0, 0),
    ROT('footR', -0.16, 0, 0),
    ROT('thighL', 0.10, 0, -0.12),
    ROT('shinL', 0.20, 0, 0),
    ROT('footL', -0.14, 0, 0)
  ],
  wizard: [
    ROT('pelvis', 0.0, 0, 0),
    ROT('spine', 0.02, -0.02, 0),
    ROT('chest', -0.02, 0.02, 0),
    ROT('neck', 0.0, 0, 0),
    ROT('head', -0.02, 0.02, 0),
    ROT('shR', 0, 0, -0.05),
    ROT('armR', -0.88, -0.10, 0.26),
    ROT('elbR', -0.62, 0.05, 0),
    ROT('handR', -0.18, 0, 0.12),
    ROT('shL', 0, 0, 0.05),
    ROT('armL', -0.16, 0.12, -0.52),
    ROT('elbL', -0.42, 0, 0),
    ROT('handL', 0.10, 0, -0.10),
    ROT('thighR', -0.02, 0, 0.05),
    ROT('shinR', 0.08, 0, 0),
    ROT('footR', -0.05, 0, 0),
    ROT('thighL', 0.02, 0, -0.05),
    ROT('shinL', 0.07, 0, 0),
    ROT('footL', -0.04, 0, 0)
  ]
};

/* 공격 키프레임 — [시간, {관절: [x,y,z], root:[y,z,x회전]} ...] */
const ATTACK = {
  soldier: {
    dur: 0.92,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.09, j: { spine: [0.12, 0.16, 0], chest: [0.04, 0.10, 0], armR: [-0.36, 0.14, 0.36], elbR: [-0.92, 0.1, 0], root: [-0.01, -0.02] }, ease: 'inout' },
      { t: 0.28, j: {
        spine: [-0.08, 0.72, 0.08], chest: [-0.05, 0.42, 0.08], neck: [0, -0.30, 0], head: [0.02, -0.44, 0.04],
        armR: [0.34, 0.34, 0.98], elbR: [-1.30, 0.1, 0], handR: [-0.55, -0.35, 0.40],
        armL: [-0.52, -0.12, -0.30], elbL: [-1.40, 0, 0],
        thighR: [0.22, 0, 0.09], shinR: [0.34, 0, 0], thighL: [-0.16, 0, -0.08], shinL: [0.26, 0, 0],
        root: [-0.055, -0.045]
      }, ease: 'out' },
      { t: 0.40, j: {
        spine: [0.34, -0.52, -0.06], chest: [0.18, -0.38, -0.06], neck: [0.04, 0.12, 0], head: [0.06, 0.08, 0],
        armR: [-1.16, -0.22, 0.02], elbR: [-0.10, 0, 0], handR: [1.00, 0.20, -0.12],
        armL: [-0.78, 0.06, -0.46], elbL: [-1.46, 0, 0],
        thighR: [-0.46, 0, 0.10], shinR: [0.52, 0, 0], thighL: [0.28, 0, -0.09], shinL: [0.34, 0, 0],
        root: [-0.085, 0.18]
      }, ease: 'out' },
      { t: 0.54, j: {
        spine: [0.24, -0.76, -0.04], chest: [0.08, -0.36, 0], head: [0.02, 0.14, 0],
        armR: [-0.48, -0.38, -0.30], elbR: [-0.62, 0, 0], handR: [0.42, 0.26, -0.24],
        armL: [-0.66, 0.06, -0.40], elbL: [-1.34, 0, 0],
        thighR: [-0.34, 0, 0.10], shinR: [0.40, 0, 0], thighL: [0.20, 0, -0.09],
        root: [-0.055, 0.20]
      }, ease: 'inout' },
      { t: 0.70, j: {
        spine: [0.10, -0.40, 0], chest: [0.02, -0.18, 0],
        armR: [-0.52, -0.14, 0.02], elbR: [-0.98, 0, 0], handR: [0.58, 0.02, 0.04],
        armL: [-0.46, 0, -0.28], elbL: [-1.18, 0, 0],
        root: [-0.02, 0.09]
      }, ease: 'inout' },
      { t: 0.92, j: {}, ease: 'inout' }
    ]
  },
  elite: {
    dur: 0.84,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.08, j: { spine: [0.14, 0.20, 0], chest: [0.05, 0.12, 0], armR: [-0.44, 0.16, 0.40], elbR: [-1.02, 0.1, 0], armL: [-0.52, -0.10, -0.24], root: [-0.012, -0.02] }, ease: 'inout' },
      { t: 0.26, j: {
        spine: [-0.10, 0.80, 0.09], chest: [-0.06, 0.46, 0.09], neck: [0, -0.32, 0], head: [0.02, -0.48, 0.04],
        armR: [0.38, 0.36, 1.02], elbR: [-1.36, 0.1, 0], handR: [-0.58, -0.38, 0.42],
        armL: [-0.62, -0.14, -0.34], elbL: [-1.48, 0, 0],
        thighR: [0.24, 0, 0.10], shinR: [0.36, 0, 0], thighL: [-0.18, 0, -0.09], shinL: [0.28, 0, 0],
        root: [-0.058, -0.05]
      }, ease: 'out' },
      { t: 0.38, j: {
        spine: [0.38, -0.58, -0.07], chest: [0.20, -0.42, -0.07], neck: [0.04, 0.14, 0], head: [0.06, 0.10, 0],
        armR: [-1.22, -0.24, 0.02], elbR: [-0.08, 0, 0], handR: [1.04, 0.22, -0.14],
        armL: [-0.86, 0.08, -0.50], elbL: [-1.52, 0, 0],
        thighR: [-0.50, 0, 0.11], shinR: [0.56, 0, 0], thighL: [0.30, 0, -0.10], shinL: [0.36, 0, 0],
        root: [-0.09, 0.20]
      }, ease: 'out' },
      { t: 0.52, j: {
        spine: [0.26, -0.82, -0.04], chest: [0.09, -0.40, 0], head: [0.02, 0.16, 0],
        armR: [-0.50, -0.40, -0.32], elbR: [-0.66, 0, 0], handR: [0.44, 0.28, -0.26],
        armL: [-0.72, 0.06, -0.44], elbL: [-1.40, 0, 0],
        thighR: [-0.36, 0, 0.11], shinR: [0.42, 0, 0], thighL: [0.22, 0, -0.10],
        root: [-0.058, 0.22]
      }, ease: 'inout' },
      { t: 0.66, j: {
        spine: [0.10, -0.44, 0], chest: [0.02, -0.20, 0],
        armR: [-0.54, -0.16, 0.02], elbR: [-1.02, 0, 0], handR: [0.60, 0.02, 0.04],
        armL: [-0.60, 0, -0.26], elbL: [-1.20, 0, 0],
        root: [-0.022, 0.10]
      }, ease: 'inout' },
      { t: 0.84, j: {}, ease: 'inout' }
    ]
  },
  knight: {
    dur: 1.72,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.16, j: { spine: [0.02, 0.10, 0], armR: [-0.85, -0.2, 0.20], elbR: [-1.20, 0, 0], root: [-0.02, -0.02] }, ease: 'inout' },
      { t: 0.60, j: {
        spine: [-0.34, 0.16, 0], chest: [-0.16, 0.06, 0], neck: [-0.06, 0, 0], head: [-0.18, -0.12, 0],
        armR: [-2.42, -0.25, 0.28], elbR: [-0.72, 0.05, 0], handR: [-0.40, 0.10, 0.05],
        armL: [-2.20, 0.20, -0.36], elbL: [-0.95, 0, 0], handL: [-0.15, 0, 0],
        thighR: [0.12, 0, 0.17], shinR: [0.22, 0, 0], thighL: [-0.18, 0, -0.17], shinL: [0.42, 0, 0],
        root: [0.06, -0.06]
      }, ease: 'out' },
      { t: 0.80, j: {
        spine: [0.66, -0.08, 0], chest: [0.26, -0.04, 0], neck: [0.10, 0, 0], head: [0.26, 0.06, 0],
        armR: [-0.58, -0.05, 0.14], elbR: [-0.06, 0, 0], handR: [1.02, 0.05, 0.02],
        armL: [-0.66, 0.08, -0.20], elbL: [-0.28, 0, 0], handL: [0.72, 0, 0],
        thighR: [-0.72, 0, 0.19], shinR: [1.06, 0, 0], footR: [-0.30, 0, 0],
        thighL: [-0.38, 0, -0.19], shinL: [0.92, 0, 0], footL: [-0.24, 0, 0],
        root: [-0.24, 0.30]
      }, ease: 'out' },
      { t: 0.98, j: {
        spine: [0.60, -0.06, 0], chest: [0.22, -0.02, 0], head: [0.20, 0.02, 0],
        armR: [-0.62, -0.06, 0.14], elbR: [-0.10, 0, 0], handR: [0.98, 0.05, 0.02],
        armL: [-0.70, 0.06, -0.22], elbL: [-0.32, 0, 0],
        thighR: [-0.68, 0, 0.19], shinR: [1.00, 0, 0], thighL: [-0.34, 0, -0.19], shinL: [0.86, 0, 0],
        root: [-0.22, 0.30]
      }, ease: 'inout' },
      { t: 1.16, j: {
        spine: [0.34, 0.02, 0], chest: [0.12, 0, 0], head: [0.06, 0, 0],
        armR: [-0.92, -0.10, 0.18], elbR: [-0.45, 0, 0], handR: [0.82, 0.05, 0],
        armL: [-0.90, 0.10, -0.28], elbL: [-0.62, 0, 0],
        thighR: [-0.34, 0, 0.18], shinR: [0.62, 0, 0], thighL: [-0.16, 0, -0.18], shinL: [0.48, 0, 0],
        root: [-0.10, 0.18]
      }, ease: 'inout' },
      { t: 1.42, j: {
        spine: [0.16, 0.04, 0], chest: [0.06, 0, 0], head: [0.02, 0, 0],
        armR: [-0.72, -0.12, 0.16], elbR: [-0.72, 0, 0], handR: [0.92, 0.05, 0.04],
        armL: [-0.94, 0.14, -0.31], elbL: [-0.94, 0, 0],
        thighR: [-0.16, 0, 0.17], shinR: [0.36, 0, 0], thighL: [-0.06, 0, -0.17], shinL: [0.30, 0, 0],
        root: [-0.04, 0.08]
      }, ease: 'inout' },
      { t: 1.72, j: {}, ease: 'inout' }
    ]
  },
  blademaster: {
    dur: 0.80,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.07, j: { spine: [0.14, 0.30, 0], armR: [-0.64, -0.34, 0.50], elbR: [-1.16, 0, 0], root: [-0.01, -0.02] }, ease: 'inout' },
      { t: 0.22, j: {
        spine: [-0.12, 0.76, 0.08], chest: [-0.07, 0.44, 0.08], neck: [0, -0.34, 0], head: [0, -0.40, 0.04],
        armR: [0.22, 0.26, 0.92], elbR: [-1.38, 0, 0], handR: [-0.48, -0.42, 0.40],
        armL: [-0.78, -0.14, -0.38], elbL: [-1.46, 0, 0],
        thighR: [0.16, 0, 0.13], shinR: [0.36, 0, 0], thighL: [-0.18, 0, -0.13], shinL: [0.32, 0, 0],
        root: [-0.07, -0.05]
      }, ease: 'out' },
      { t: 0.33, j: {
        spine: [0.38, -0.62, -0.08], chest: [0.20, -0.44, -0.06], head: [0.04, 0.12, 0],
        armR: [-1.30, -0.28, -0.12], elbR: [-0.08, 0, 0], handR: [1.02, 0.30, -0.20],
        armL: [-1.02, 0.06, -0.54], elbL: [-1.52, 0, 0],
        thighR: [-0.60, 0, 0.13], shinR: [0.66, 0, 0], thighL: [0.36, 0, -0.13], shinL: [0.42, 0, 0],
        root: [-0.11, 0.28]
      }, ease: 'out' },
      { t: 0.45, j: {
        spine: [0.28, -0.84, -0.05], chest: [0.12, -0.40, 0], head: [0.02, 0.14, 0],
        armR: [-0.60, -0.48, -0.40], elbR: [-0.66, 0, 0], handR: [0.50, 0.24, -0.26],
        armL: [-0.86, 0.05, -0.46], elbL: [-1.32, 0, 0],
        thighR: [-0.44, 0, 0.13], shinR: [0.54, 0, 0], thighL: [0.28, 0, -0.13],
        root: [-0.07, 0.32]
      }, ease: 'inout' },
      { t: 0.62, j: {
        spine: [0.14, -0.46, 0], chest: [0.04, -0.20, 0],
        armR: [-0.48, -0.28, 0.12], elbR: [-0.96, 0, 0], handR: [0.36, -0.32, 0.08],
        armL: [-0.66, 0.04, -0.36], elbL: [-1.20, 0, 0],
        root: [-0.03, 0.17]
      }, ease: 'inout' },
      { t: 0.80, j: {}, ease: 'inout' }
    ]
  },
  wizard: {
    dur: 1.06,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.18, j: {
        spine: [-0.06, -0.22, 0], chest: [-0.04, -0.16, 0], head: [0.02, 0.22, 0],
        armR: [-1.40, -0.30, 0.34], elbR: [-0.72, 0, 0], handR: [-0.42, 0, 0.1],
        armL: [-0.05, 0.12, -0.10], elbL: [-0.10, 0, 0],
        root: [-0.01, -0.03]
      }, ease: 'inout' },
      { t: 0.34, j: {
        spine: [0.16, 0.20, 0], chest: [0.10, 0.14, 0], neck: [0.02, -0.06, 0], head: [0.04, -0.14, 0],
        armR: [-1.52, 0.06, 0.06], elbR: [-0.06, 0, 0], handR: [-0.20, 0, 0.04],
        armL: [-0.34, 0.05, -0.22], elbL: [-0.34, 0, 0],
        root: [0.0, 0.05]
      }, ease: 'out' },
      { t: 0.56, j: {
        spine: [0.10, 0.16, 0], chest: [0.04, 0.10, 0],
        armR: [-1.34, 0.02, 0.10], elbR: [-0.34, 0, 0], handR: [-0.24, 0, 0.04],
        armL: [-0.30, 0.05, -0.20], elbL: [-0.30, 0, 0],
        root: [0.0, 0.04]
      }, ease: 'inout' },
      { t: 0.82, j: {
        spine: [0.05, 0.10, 0], chest: [0.02, 0.06, 0],
        armR: [-1.08, -0.02, 0.18], elbR: [-0.48, 0, 0], handR: [-0.22, 0, 0.06],
        armL: [-0.20, 0.05, -0.18], elbL: [-0.24, 0, 0],
        root: [0.0, 0.02]
      }, ease: 'inout' },
      { t: 1.06, j: {}, ease: 'inout' }
    ]
  }
};

function applyKeys(p, cls, t) {
  const def = ATTACK[cls];
  if (!def) return;
  const keys = def.keys;
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
  }
  let k = (t - a.t) / Math.max(0.0001, b.t - a.t);
  const ease = b.ease || 'inout';
  if (ease === 'out') k = easeOutCubic(k);
  else if (ease === 'quint') k = easeOutQuint(k);
  else k = smoothstep(k);
  const names = new Set([...Object.keys(a.j), ...Object.keys(b.j)]);
  for (const name of names) {
    const va = a.j[name] || [0, 0, 0];
    const vb = b.j[name] || [0, 0, 0];
    if (name === 'root') {
      p.rootAdd[0] += lerp(va[0] || 0, vb[0] || 0, k);   // y 오프셋
      p.rootAdd[2] += lerp(va[1] || 0, vb[1] || 0, k);   // z(앞뒤) 오프셋
      continue;
    }
    const j = J[name];
    if (j === undefined) continue;
    for (let c = 0; c < 3; c++) p.rot[j * 3 + c] += lerp(va[c] || 0, vb[c] || 0, k);
  }
}

/* ---------------------------------------------------------------------------
   이동 모션
   --------------------------------------------------------------------------- */
function applyLocomotion(p, cls, phase, move, t, u) {
  if (move <= 0.001) return;
  const heavy = cls === 'knight' ? 0.74 : cls === 'wizard' ? 0.46 : 1;
  const amp = clamp(move, 0, 1) * heavy;
  const s = Math.sin(phase), c = Math.cos(phase);
  const stride = cls === 'knight' ? 0.50 : cls === 'wizard' ? 0.33 : 0.68;
  const thighAmp = stride * amp;

  /* 다리: 앞으로 내딛는 동안 무릎을 접고, 뒤로 밀 때 다리를 편다 */
  const thR = -s * thighAmp;
  const thL = s * thighAmp;
  const swingR = Math.max(0, -c), swingL = Math.max(0, c);
  const kneeR = (0.14 + swingR * 1.32) * amp + 0.06;
  const kneeL = (0.14 + swingL * 1.32) * amp + 0.06;
  R(p, J.thighR, thR, 0, 0);
  R(p, J.thighL, thL, 0, 0);
  R(p, J.shinR, kneeR, 0, 0);
  R(p, J.shinL, kneeL, 0, 0);
  /* 발목: 차기 순간 발끝이 들리고, 디딤에서 발바닥이 땅에 붙는다 */
  R(p, J.footR, -thR * 0.55 - kneeR * 0.46 + swingR * 0.34, 0, 0);
  R(p, J.footL, -thL * 0.55 - kneeL * 0.46 + swingL * 0.34, 0, 0);

  /* 골반: 좌우 흔들림(롤) · 걸음마다 돌아가는 요 · 위아래 반동(2배 주기) */
  const bob = Math.abs(s) * (cls === 'knight' ? 0.06 : 0.038) * amp;
  p.rootAdd[1] -= bob + 0.008 * amp;
  R(p, J.pelvis, 0.02 * amp, -s * 0.12 * amp, -s * 0.055 * amp);
  /* 허리는 앞으로 기울고(속도 비례), 어깨는 골반과 반대로 비틀려 팔이 따라온다 */
  const lean = (cls === 'knight' ? 0.10 : cls === 'wizard' ? 0.05 : 0.085) * amp;
  R(p, J.spine, lean, s * 0.13 * amp, s * 0.03 * amp);
  R(p, J.chest, 0.02 * amp, s * 0.10 * amp, -s * 0.02 * amp);
  R(p, J.neck, -lean * 0.55, -s * 0.09 * amp, 0);

  /* 팔: 무기 팔은 무게 때문에 작게, 반대 팔은 크게 흔들린다 · 팔꿈치가 늦게 따라온다 */
  const armSwing = (cls === 'knight' ? 0.13 : cls === 'wizard' ? 0.09 : 0.30) * amp;
  R(p, J.shR, s * 0.05 * amp, 0, 0);
  R(p, J.shL, -s * 0.07 * amp, 0, 0);
  R(p, J.armR, s * armSwing * 0.62, 0, s * 0.03 * amp);
  R(p, J.armL, -s * armSwing, 0, -s * 0.03 * amp);
  R(p, J.elbR, Math.max(0, s) * 0.30 * amp + 0.06 * amp, 0, 0);
  R(p, J.elbL, Math.max(0, -s) * 0.34 * amp + 0.06 * amp, 0, 0);
  R(p, J.handR, -s * 0.10 * amp, 0, 0);
  R(p, J.handL, s * 0.06 * amp, 0, 0);
  /* 머리는 흔들림을 상쇄해 시선을 고정 */
  R(p, J.head, -bob * 0.7 - lean * 0.4, s * 0.05 * amp, 0);
}

/* ---------------------------------------------------------------------------
   사망 모션 — 무릎 꿇고 쓰러진다 / 🩸 목이 베이면 잠시 서 있다가 머리 없이 쓰러진다
   --------------------------------------------------------------------------- */
const KNEEL_T = 0.62, FALL_T = 0.40;
export function applyDeath(p, cls, t, kind) {
  if (kind === 'behead') { applyBehead(p, cls, t); return; }
  if (kind === 'bleed') { applyBleed(p, cls, t); return; }
  // t: 사망 후 경과 시간(초)
  const heavy = cls === 'knight' ? 1.15 : cls === 'wizard' ? 0.92 : 1;
  const hitP = smoothstep(seg(t, 0, 0.16));
  const kneelP = smoothstep(seg(t, 0.14, 0.20 + KNEEL_T * heavy));
  const fallP = easeInCubic(seg(t, 0.20 + KNEEL_T * heavy, 0.20 + KNEEL_T * heavy + FALL_T));
  const settleP = smoothstep(seg(t, 0.20 + KNEEL_T * heavy + FALL_T * 0.6, 0.20 + KNEEL_T * heavy + FALL_T + 0.5));

  // 1) 맞은 순간 젖혀짐
  const hk = hitP * (1 - kneelP * 0.6);
  R(p, J.spine, -0.34 * hk, 0.12 * hk, 0);
  R(p, J.chest, -0.16 * hk, 0.08 * hk, 0);
  R(p, J.head, -0.40 * hk, -0.10 * hk, 0.06 * hk);
  R(p, J.armR, -0.45 * hk, 0, 0.5 * hk);
  R(p, J.armL, -0.55 * hk, 0, -0.55 * hk);
  R(p, J.elbR, -0.5 * hk, 0, 0);
  R(p, J.elbL, -0.6 * hk, 0, 0);
  p.rootAdd[0] -= 0.10 * hk;

  // 2) 무릎 꿇기
  const kk = kneelP * (1 - fallP);
  const drop = 0.50 * kneelP;
  p.rootAdd[0] -= drop;
  R(p, J.thighR, -1.20 * kk, 0, 0.10 * kk);
  R(p, J.thighL, -1.10 * kk, 0, -0.10 * kk);
  R(p, J.shinR, 2.05 * kk, 0, 0);
  R(p, J.shinL, 1.95 * kk, 0, 0);
  R(p, J.footR, -0.55 * kk, 0, 0);
  R(p, J.footL, -0.50 * kk, 0, 0);
  R(p, J.pelvis, 0.20 * kk, 0, 0);
  R(p, J.spine, 0.52 * kk, -0.10 * kk, 0.05 * kk);
  R(p, J.chest, 0.26 * kk, -0.06 * kk, 0);
  R(p, J.neck, 0.16 * kk, 0, 0);
  R(p, J.head, 0.30 * kk, 0.08 * kk, 0.08 * kk);
  // 팔은 무기력을 잃고 아래로
  R(p, J.armR, 0.30 * kk, 0, -0.10 * kk);
  R(p, J.elbR, 0.42 * kk, 0, 0);
  R(p, J.handR, 0.55 * kk, 0, -0.3 * kk);
  R(p, J.armL, 0.25 * kk, 0, 0.10 * kk);
  R(p, J.elbL, 0.35 * kk, 0, 0);
  // 바닥에 닿는 순간의 작은 반동
  const bounce = Math.sin(clamp((t - 0.14 - KNEEL_T * heavy * 0.75) * 9, 0, Math.PI)) * 0.022 * kneelP;
  p.rootAdd[0] += bounce;

  // 3) 앞으로 쓰러짐 (발목을 축으로 몸 전체 피치)
  p.rot[0] += fallP * 1.36;                 // root X 회전
  p.rootAdd[0] -= fallP * 0.09;
  R(p, J.spine, 0.25 * fallP, 0, 0);
  R(p, J.head, 0.20 * fallP, 0.10 * fallP, 0);
  R(p, J.armR, -0.25 * fallP, 0, -0.55 * fallP);
  R(p, J.armL, -0.20 * fallP, 0, 0.55 * fallP);
  R(p, J.elbR, -0.40 * fallP, 0, 0);
  R(p, J.elbL, -0.35 * fallP, 0, 0);
  R(p, J.thighR, 0.20 * fallP, 0, 0);
  R(p, J.thighL, 0.16 * fallP, 0, 0);

  // 4) 정지 후 미세한 안착
  const sk = settleP * (1 - fallP * 0.4);
  p.rot[1] += 0.06 * sk;
  p.rootAdd[0] -= 0.02 * sk;
  p.rootAdd[2] += 0.06 * sk;
}

/* 🩸 양팔·양다리를 잃은 사망 — 무릎을 꿇고 발악하다 과다출혈로 고꾸라진다 */
function applyBleed(p, cls, t) {
  const heavy = cls === 'knight' ? 1.12 : cls === 'wizard' ? 0.95 : 1;
  const kneel = smoothstep(seg(t, 0.02, 0.34 * heavy));
  R(p, J.pelvis, 0.26 * kneel, 0, 0);
  R(p, J.thighR, -1.35 * kneel, 0, 0.12 * kneel);
  R(p, J.thighL, -1.25 * kneel, 0, -0.12 * kneel);
  R(p, J.shinR, 2.15 * kneel, 0, 0);
  R(p, J.shinL, 2.05 * kneel, 0, 0);
  R(p, J.footR, -0.60 * kneel, 0, 0);
  R(p, J.footL, -0.55 * kneel, 0, 0);
  R(p, J.spine, 0.52 * kneel, 0, 0);
  R(p, J.chest, 0.24 * kneel, 0, 0);
  R(p, J.head, 0.30 * kneel, 0, 0);
  p.rootAdd[0] -= 0.62 * kneel;

  // 발악 — 무릎 꿇은 채 상체를 부르르 떨며 팔을 휘젓는다
  const th = seg(t, 0.18, 0.95 * heavy);
  const osc = Math.sin(th * 17) * (1 - th);
  const up = Math.max(0, osc), dn = Math.max(0, -osc);
  R(p, J.spine, 0.06 * Math.abs(osc), 0.20 * osc, 0.10 * osc);
  R(p, J.chest, 0, 0.10 * osc, 0);
  R(p, J.head, -0.10 * Math.abs(osc), -0.18 * osc, 0);
  R(p, J.armR, -0.90 * up, 0, 0.55 * up);
  R(p, J.armL, -0.85 * dn, 0, -0.55 * dn);
  R(p, J.elbR, -0.70 * Math.abs(osc), 0, 0);
  R(p, J.elbL, -0.70 * Math.abs(osc), 0, 0);

  // 앞으로 고꾸라진다
  const fall = easeInCubic(seg(t, 0.95 * heavy, 1.45 * heavy));
  p.rot[0] += fall * 1.25;
  p.rootAdd[0] -= 0.12 * fall;
  R(p, J.spine, 0.20 * fall, 0, 0);
  R(p, J.armR, -0.30 * fall, 0, -0.40 * fall);
  R(p, J.armL, -0.26 * fall, 0, 0.40 * fall);
}

/* 🩸 목이 대각선으로 베인 사망 — 몸이 잠시 서서 휘청이다가 머리 없이 쓰러진다 */
function applyBehead(p, cls, t) {
  const heavy = cls === 'knight' ? 1.16 : cls === 'wizard' ? 0.94 : 1;
  const hitP = smoothstep(seg(t, 0, 0.15));
  // 베인 순간 — 목이 젖혀지고 몸이 굳는다
  R(p, J.spine, -0.30 * hitP, 0.12 * hitP, 0.07 * hitP);
  R(p, J.chest, -0.14 * hitP, 0.07 * hitP, 0);
  R(p, J.pelvis, 0.05 * hitP, 0, 0);
  R(p, J.armR, -0.34 * hitP, 0, 0.42 * hitP);
  R(p, J.armL, -0.42 * hitP, 0, -0.46 * hitP);
  R(p, J.elbR, -0.40 * hitP, 0, 0);
  R(p, J.elbL, -0.46 * hitP, 0, 0);
  R(p, J.handR, 0.30 * hitP, 0, 0);
  R(p, J.handL, 0.30 * hitP, 0, 0);
  p.rootAdd[0] -= 0.03 * hitP;

  // 서 있는 동안의 휘청임 (0.15~0.85초)
  const swayT = seg(t, 0.15, 0.85 * heavy);
  const sway = Math.sin(swayT * 5.4) * 0.055 * (1 - swayT * 0.7);
  R(p, J.spine, 0.10 * swayT + sway * 0.8, sway * 1.6, sway * 0.6);
  R(p, J.chest, 0.05 * swayT, sway * 0.7, 0);
  R(p, J.pelvis, 0, sway * 0.9, -sway * 0.4);
  R(p, J.armR, 0.20 * swayT + sway * 2.0, 0, -0.10 * swayT);
  R(p, J.armL, 0.24 * swayT - sway * 2.0, 0, 0.10 * swayT);
  p.rootAdd[0] -= 0.035 * swayT;
  p.rootAdd[2] += sway * 0.30;

  // 무릎이 풀리며 앞으로 꺾어지고, 머리 없는 몸이 바닥에 내려앉는다
  const collapse = easeInCubic(seg(t, 0.70 * heavy, 1.16 * heavy));
  const kneeB = smoothstep(seg(t, 0.60 * heavy, 0.92 * heavy));
  R(p, J.thighR, -1.05 * kneeB, 0, 0.12 * kneeB);
  R(p, J.thighL, -0.92 * kneeB, 0, -0.12 * kneeB);
  R(p, J.shinR, 1.85 * kneeB, 0, 0);
  R(p, J.shinL, 1.70 * kneeB, 0, 0);
  R(p, J.footR, -0.50 * kneeB, 0, 0);
  R(p, J.footL, -0.44 * kneeB, 0, 0);
  p.rootAdd[0] -= 0.46 * kneeB;
  p.rot[0] += collapse * 1.52;
  R(p, J.spine, 0.30 * collapse, 0.10 * collapse, 0);
  R(p, J.armR, -0.30 * collapse, 0, -0.60 * collapse);
  R(p, J.armL, -0.26 * collapse, 0, 0.60 * collapse);
  R(p, J.elbR, -0.44 * collapse, 0, 0);
  R(p, J.elbL, -0.40 * collapse, 0, 0);
  p.rootAdd[0] -= 0.05 * collapse;
  p.rootAdd[2] += 0.10 * collapse;
}

/* ---------------------------------------------------------------------------
   메인 포즈 계산
   --------------------------------------------------------------------------- */
export function computePose(u, t, dt) {
  const p = u.pose;
  const cls = u.cls;
  const s = CLASSES[cls] || CLASSES.soldier;
  p.rot.fill(0);
  p.rootAdd[0] = 0; p.rootAdd[1] = 0; p.rootAdd[2] = 0;

  // 기본 자세
  const base = BASE[cls] || BASE.soldier;
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    R(p, J[b[0]], b[1], b[2], b[3]);
  }

  // 호흡 · 무게 이동 (유닛마다 위상 다르게)
  const ph = u.animPhase || 0;
  const breathe = Math.sin(t * 1.75 + ph) * 0.5 + 0.5;
  R(p, J.chest, -0.022 * breathe, 0, 0);
  R(p, J.spine, 0.012 * breathe, 0, Math.sin(t * 0.6 + ph) * 0.012);
  p.rootAdd[1] += Math.sin(t * 0.9 + ph) * 0.006;
  R(p, J.head, Math.sin(t * 0.47 + ph * 2) * 0.03, Math.sin(t * 0.31 + ph) * 0.06, 0);
  R(p, J.pelvis, 0, Math.sin(t * 0.5 + ph) * 0.02, Math.sin(t * 0.7 + ph) * 0.01);

  // 이동
  const move = clamp(u.moveAmt || 0, 0, 1);
  applyLocomotion(p, cls, u.walkPhase || 0, move, t, u);

  // 공격
  if (u.attackT !== undefined && u.attackT >= 0) {
    const def = ATTACK[cls] || ATTACK.soldier;
    const cyc = u.cycle || s.cycle;          // 팔을 잃으면 주기가 길어진다
    const norm = (u.attackT / Math.max(0.001, cyc)) * def.dur;
    if (norm <= def.dur) applyKeys(p, cls, Math.min(norm, def.dur));
    // 🩸 오른팔을 잃었으면 남은 왼팔로 크게 가로지르며 몸을 비튼다
    if (u.severed && u.severed.armR) {
      const k = clamp(norm / def.dur, 0, 1);
      const sw = Math.sin(k * Math.PI);
      R(p, J.shL, -0.20 * sw, 0.55 * sw, 0.10 * sw);
      R(p, J.armL, -1.35 * sw, -0.55 * sw, 0.45 * sw);
      R(p, J.elbL, -0.85 * sw, 0, 0);
      R(p, J.handL, 0.30 * sw, -0.20 * sw, 0);
      R(p, J.spine, 0, -0.24 * sw, 0.06 * sw);
      R(p, J.chest, 0, -0.13 * sw, 0);
    }
  }

  // 피격 경직 — 맞은 방향으로 젖혀지고 무릎이 꿇리는 반동
  if (u.staggerT > 0) {
    const k = smoothstep(Math.min(1, u.staggerT / 0.28));
    const side = u.staggerSide || 1;
    R(p, J.spine, 0.30 * k, side * 0.22 * k, 0);
    R(p, J.chest, 0.14 * k, side * 0.07 * k, 0);
    R(p, J.neck, 0.10 * k, 0, 0);
    R(p, J.head, 0.22 * k, side * 0.09 * k, side * 0.05 * k);
    R(p, J.armR, 0.30 * k, 0, 0.22 * k);
    R(p, J.armL, 0.28 * k, 0, -0.22 * k);
    R(p, J.elbR, 0.20 * k, 0, 0);
    R(p, J.thighR, 0.16 * k, 0, 0);
    R(p, J.shinR, 0.24 * k, 0, 0);
    R(p, J.thighL, -0.10 * k, 0, 0);
    p.rootAdd[2] -= 0.07 * k;
    p.rootAdd[0] -= 0.03 * k;
  }

  // 시선 목표 (머리만 살짝)
  if (u.lookYaw) R(p, J.head, 0, clamp(u.lookYaw, -0.6, 0.6) * 0.55, 0);

  // 🛡️ 막기 자세 — 상체를 살짝 숙이고 두 발을 벌려 버티며 무기를 대각선으로 세운다
  if (u.guard) {
    // 공통: 무게중심을 낮추고 두 발을 앞뒤로 벌린 안정된 자세
    R(p, J.thighR, -0.30, 0, 0.16);
    R(p, J.shinR, 0.54, 0, 0);
    R(p, J.footR, -0.26, 0, 0);
    R(p, J.thighL, 0.20, 0, -0.16);
    R(p, J.shinL, 0.46, 0, 0);
    R(p, J.footL, -0.18, 0, 0);
    R(p, J.pelvis, 0.08, -0.10, 0);
    R(p, J.spine, 0.16, 0.14, 0);
    R(p, J.chest, 0.10, 0.16, 0);
    R(p, J.neck, -0.10, -0.12, 0);
    R(p, J.head, -0.06, -0.10, 0);
    p.rootAdd[0] -= 0.045;
    p.rootAdd[2] -= 0.06;
    if (cls === 'soldier' || cls === 'blademaster') {
      // 검을 얼굴 앞 대각선으로 세우고 왼손을 받쳐 든다
      R(p, J.shR, 0.10, -0.34, -0.22);
      R(p, J.armR, -1.02, -0.34, -0.52);
      R(p, J.elbR, -1.42, 0, 0);
      R(p, J.handR, 0.06, -1.18, 0.42);
      R(p, J.shL, 0.02, 0.20, 0.10);
      R(p, J.armL, -0.52, -0.34, 0.34);
      R(p, J.elbL, -1.30, 0, 0);
      R(p, J.handL, 0.10, 0.24, -0.16);
    } else if (cls === 'elite') {
      // 🛡️ 방패를 얼굴 앞으로 당겨 세우고 장검을 방패 위에 얹는다
      R(p, J.shL, 0.06, 0.34, 0.06);
      R(p, J.armL, -1.34, -0.30, 0.10);
      R(p, J.elbL, -1.72, 0, 0);
      R(p, J.handL, 0.0, 0.55, -0.10);
      R(p, J.shR, 0.10, -0.22, -0.16);
      R(p, J.armR, -1.16, -0.26, -0.44);
      R(p, J.elbR, -1.32, 0, 0);
      R(p, J.handR, 0.10, -1.02, 0.36);
    } else if (cls === 'knight') {
      // 망치 자루를 가슴 앞에 비스듬히 받치고 어깨로 밀어내는 자세
      R(p, J.shR, 0.14, -0.30, -0.20);
      R(p, J.armR, -0.62, -0.42, -0.34);
      R(p, J.elbR, -1.50, 0, 0);
      R(p, J.handR, -0.40, -0.75, 0.30);
      R(p, J.shL, 0.04, 0.24, 0.12);
      R(p, J.armL, -1.35, -0.20, 0.42);
      R(p, J.elbL, -0.90, 0, 0);
      R(p, J.handL, 0.30, 0.30, -0.20);
    } else {
      // 지팡이를 몸 앞으로 세워 막는다
      R(p, J.shL, 0.02, 0.28, 0.14);
      R(p, J.armL, -1.30, -0.10, 0.48);
      R(p, J.elbL, -1.10, 0, 0);
      R(p, J.handL, 0.20, -0.55, -0.20);
      R(p, J.armR, -0.95, -0.20, -0.30);
      R(p, J.elbR, -1.15, 0, 0);
    }
  }

  // 🌸 매화 일섬 돌진 자세
  if (u.dashT !== undefined && u.dashT >= 0) {
    const k = clamp(u.dashT / SKILL.dashTime, 0, 1);
    const lunge = Math.sin(Math.min(1, k * 1.3) * Math.PI);
    R(p, J.spine, 0.55 + 0.2 * lunge, -0.75, 0.10);
    R(p, J.chest, 0.15, -0.45, 0.05);
    R(p, J.head, -0.15, 0.45, 0);
    R(p, J.armR, -1.45, -0.35, -0.15);
    R(p, J.elbR, -0.10, 0, 0);
    R(p, J.handR, 0.55, 0.35, -0.25);
    R(p, J.armL, -0.55, 0.1, -0.65);
    R(p, J.elbL, -1.30, 0, 0);
    R(p, J.thighR, -0.95, 0, 0.12);
    R(p, J.shinR, 0.85, 0, 0);
    R(p, J.thighL, 0.55, 0, -0.12);
    R(p, J.shinL, 0.95, 0, 0);
    p.rootAdd[0] -= 0.12 * lunge;
  }

  // 🩸 한쪽 팔을 잃은 전용 자세 — 어깨를 말고 몸을 비틀어 균형을 잡는다
  if (u.armsLost === 1) {
    const lostR = !!u.severed.armR;
    R(p, lostR ? J.shR : J.shL, 0.12, lostR ? 0.26 : -0.26, lostR ? 0.34 : -0.34);
    R(p, lostR ? J.armR : J.armL, 0.34, 0, lostR ? 0.26 : -0.26);
    R(p, lostR ? J.elbR : J.elbL, 0.30, 0, 0);
    R(p, J.pelvis, 0, lostR ? -0.06 : 0.06, lostR ? 0.04 : -0.04);
    R(p, J.spine, 0.04, lostR ? -0.17 : 0.17, lostR ? -0.05 : 0.05);
    R(p, J.chest, 0, lostR ? 0.10 : -0.10, 0);
    R(p, J.neck, 0, lostR ? 0.08 : -0.08, 0);
    R(p, J.head, 0, lostR ? 0.12 : -0.12, 0);
  }
  // 🩸 한쪽 다리를 잃은 전용 모션 — 남은 다리로 깡충 뛰며 절뚝인다
  if (u.legsLost === 1) {
    const lostR = !!u.severed.legR;
    const ph = u.walkPhase || 0;
    const bob = Math.abs(Math.sin(ph * 0.5)) * clamp(move, 0, 1);
    const sway = Math.sin(ph * 0.5) * clamp(move, 0, 1);
    R(p, J.pelvis, 0.10 * move, sway * 0.10, (lostR ? -0.26 : 0.26) * move);
    R(p, J.spine, 0.10 * move, -sway * 0.12, (lostR ? 0.16 : -0.16) * move);
    R(p, J.chest, 0.03 * move, 0, (lostR ? 0.10 : -0.10) * move);
    R(p, J.neck, -0.06 * move, 0, 0);
    R(p, J.head, -0.05 * move - bob * 0.06, sway * 0.10, (lostR ? -0.10 : 0.10) * move);
    // 남은 다리를 크게 접었다 편다
    R(p, lostR ? J.thighL : J.thighR, -0.80 * bob, 0, 0);
    R(p, lostR ? J.shinL : J.shinR, 1.15 * bob, 0, 0);
    R(p, lostR ? J.footL : J.footR, -0.40 * bob, 0, 0);
    // 잘린 쪽 어깨·몸이 그쪽으로 흘러내린다
    p.rootAdd[0] += bob * 0.11 - 0.13;
    p.rootAdd[2] += (lostR ? 0.02 : -0.02) * move;
  }

  // 사망
  if (u.dead) {
    const kind = u.behead ? 'behead' : (u.deathKind === 'bleed' ? 'bleed' : null);
    applyDeath(p, cls, u.deadT || 0, kind);
  }

  // 루트 위치·회전
  p.root[0] = u.x;
  p.root[1] = (u.y || 0) + p.rootAdd[1] + p.rootAdd[0];
  p.root[2] = u.z;
  p.rot[1] += u.yaw || 0;
  p.rot[0] += 0; // 사망 피치는 applyDeath에서 누적
  // 앞뒤 미세 이동은 월드 방향으로
  if (p.rootAdd[2]) {
    const yaw = u.yaw || 0;
    p.root[0] += Math.sin(yaw) * p.rootAdd[2];
    p.root[2] += Math.cos(yaw) * p.rootAdd[2];
  }
  return p;
}

export function attackDuration(cls) {
  return (CLASSES[cls] || CLASSES.soldier).cycle;
}
