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

/* 자세 블렌딩용 스크래치 (프레임마다 새 배열을 만들지 않는다) */
const _prevRot = new Float32Array(JOINT_COUNT * 3);
const _prevRoot = new Float32Array(3);
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
    /* 오른손 장검은 살짝 앞으로, 왼손은 검을 받쳐 잡을 수 있게 가슴 앞에 (방패 없음) */
    ROT('shR', 0, 0, -0.07),
    ROT('armR', -0.30, 0, 0.20),
    ROT('elbR', -0.72, 0.10, 0),
    ROT('handR', 0.66, -0.10, 0.18),
    ROT('shL', 0.02, 0.06, 0.06),
    ROT('armL', -0.22, -0.06, -0.20),
    ROT('elbL', -0.62, 0, 0),
    ROT('handL', 0.10, 0.14, -0.06),
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
    ROT('armR', -0.52, -0.15, 0.16),
    ROT('elbR', -1.02, 0.15, 0),
    /* 망치는 가슴 앞에 낮게 든다 — 멀리서 머리통만 위로 떠 보이지 않게 */
    ROT('handR', -0.72, 0.05, 0.10),
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
  berserker: [
    ROT('pelvis', 0.02, 0, 0),
    ROT('spine', 0.10, -0.06, 0),
    ROT('chest', -0.02, 0.04, 0),
    ROT('neck', 0.02, 0, 0),
    ROT('head', -0.08, 0.04, 0),
    /* 쌍단검 — 두 팔을 낮게 벌리고 날을 앞으로 겨누는 광전사 자세 (날이 얼굴을 가로지르지 않게) */
    ROT('shR', 0, 0, -0.12),
    ROT('armR', -0.34, 0, 0.30),
    ROT('elbR', -0.92, 0.10, 0),
    ROT('handR', 0.85, 0.30, 0.10),
    ROT('shL', 0, 0, 0.16),
    ROT('armL', -0.28, 0, -0.36),
    ROT('elbL', -1.00, 0, 0),
    ROT('handL', 0.79, -0.30, -0.10),
    ROT('thighR', -0.12, 0, 0.16),
    ROT('shinR', 0.26, 0, 0),
    ROT('footR', -0.16, 0, 0),
    ROT('thighL', 0.12, 0, -0.16),
    ROT('shinL', 0.22, 0, 0),
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

/* 자세 한 덩어리를 w 만큼 부드럽게 섞는다 (가드·돌진처럼 켜고 끄는 자세의 튐 방지) */
function blendSection(p, w, fn) {
  if (w <= 0.001) return;
  _prevRot.set(p.rot);
  _prevRoot[0] = p.rootAdd[0]; _prevRoot[1] = p.rootAdd[1]; _prevRoot[2] = p.rootAdd[2];
  fn();
  if (w >= 0.999) return;
  const rot = p.rot;
  for (let i = 0; i < rot.length; i++) rot[i] = _prevRot[i] + (rot[i] - _prevRot[i]) * w;
  for (let i = 0; i < 3; i++) p.rootAdd[i] = _prevRoot[i] + (p.rootAdd[i] - _prevRoot[i]) * w;
}

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
      }, ease: 'inout' },
      { t: 0.40, j: {
        spine: [0.34, -0.52, -0.06], chest: [0.18, -0.38, -0.06], neck: [0.04, 0.12, 0], head: [0.06, 0.08, 0],
        armR: [-1.16, -0.22, 0.02], elbR: [-0.10, 0, 0], handR: [1.00, 0.20, -0.12],
        armL: [-0.78, 0.06, -0.46], elbL: [-1.46, 0, 0],
        thighR: [-0.46, 0, 0.10], shinR: [0.52, 0, 0], thighL: [0.28, 0, -0.09], shinL: [0.34, 0, 0],
        root: [-0.085, 0.18]
      }, ease: 'inout' },
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
      }, ease: 'inout' },
      { t: 0.38, j: {
        spine: [0.38, -0.58, -0.07], chest: [0.20, -0.42, -0.07], neck: [0.04, 0.14, 0], head: [0.06, 0.10, 0],
        armR: [-1.22, -0.24, 0.02], elbR: [-0.08, 0, 0], handR: [1.04, 0.22, -0.14],
        armL: [-0.86, 0.08, -0.50], elbL: [-1.52, 0, 0],
        thighR: [-0.50, 0, 0.11], shinR: [0.56, 0, 0], thighL: [0.30, 0, -0.10], shinL: [0.36, 0, 0],
        root: [-0.09, 0.20]
      }, ease: 'inout' },
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
      }, ease: 'inout' },
      { t: 0.80, j: {
        spine: [0.66, -0.08, 0], chest: [0.26, -0.04, 0], neck: [0.10, 0, 0], head: [0.26, 0.06, 0],
        armR: [-0.58, -0.05, 0.14], elbR: [-0.06, 0, 0], handR: [1.02, 0.05, 0.02],
        armL: [-0.66, 0.08, -0.20], elbL: [-0.28, 0, 0], handL: [0.72, 0, 0],
        thighR: [-0.72, 0, 0.19], shinR: [1.06, 0, 0], footR: [-0.30, 0, 0],
        thighL: [-0.38, 0, -0.19], shinL: [0.92, 0, 0], footL: [-0.24, 0, 0],
        root: [-0.24, 0.30]
      }, ease: 'inout' },
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
      }, ease: 'inout' },
      { t: 0.33, j: {
        spine: [0.38, -0.62, -0.08], chest: [0.20, -0.44, -0.06], head: [0.04, 0.12, 0],
        armR: [-1.30, -0.28, -0.12], elbR: [-0.08, 0, 0], handR: [1.02, 0.30, -0.20],
        armL: [-1.02, 0.06, -0.54], elbL: [-1.52, 0, 0],
        thighR: [-0.60, 0, 0.13], shinR: [0.66, 0, 0], thighL: [0.36, 0, -0.13], shinL: [0.42, 0, 0],
        root: [-0.11, 0.28]
      }, ease: 'inout' },
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
      }, ease: 'inout' },
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
  },
  /* 🩸 단검 광전사 — 0.24초 안에 오른단검 → 왼단검으로 연달아 찌른다.
     실제 재생은 cycle 0.25초에 맞춰 재생되어 눈에는 '쉬지 않는 연타'로 보인다. */
  berserker: {
    dur: 0.24,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.045, j: {
        spine: [0.10, 0.16, 0], chest: [0.04, 0.10, 0],
        armR: [-0.26, 0.18, 0.44], elbR: [-1.12, 0, 0], handR: [0.10, -0.30, 0.20],
        root: [-0.008, -0.014]
      }, ease: 'out' },
      { t: 0.105, j: {
        spine: [-0.04, -0.30, 0.03], chest: [-0.02, -0.18, 0], head: [0.02, 0.18, 0],
        armR: [-1.30, -0.10, -0.06], elbR: [-0.12, 0, 0], handR: [0.86, 0.06, -0.06],
        armL: [-0.20, 0, -0.30], elbL: [-1.16, 0, 0],
        thighR: [-0.34, 0, 0.10], shinR: [0.42, 0, 0], thighL: [0.20, 0, -0.10],
        root: [-0.02, 0.05]
      }, ease: 'out' },
      { t: 0.160, j: {
        spine: [0.06, 0.34, -0.02], head: [0.02, -0.20, 0],
        armR: [-0.34, 0.10, 0.34], elbR: [-0.96, 0, 0], handR: [0.22, -0.10, 0.16],
        armL: [-1.28, 0.10, 0.06], elbL: [-0.14, 0, 0], handL: [0.84, -0.04, 0.06],
        thighR: [0.16, 0, 0.10], shinR: [0.24, 0, 0], thighL: [-0.26, 0, -0.10],
        root: [-0.012, 0.02]
      }, ease: 'out' },
      { t: 0.24, j: {}, ease: 'inout' }
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
  const heavy = cls === 'knight' ? 0.72 : cls === 'wizard' ? 0.44 : 1;
  const amp = clamp(move, 0, 1) * heavy;
  const s = Math.sin(phase), c = Math.cos(phase);
  const stride = cls === 'knight' ? 0.50 : cls === 'wizard' ? 0.33 : cls === 'blademaster' ? 0.74 : 0.70;
  const thighAmp = stride * amp;

  /* 다리: 앞으로 내딛는 동안 무릎을 접고, 뒤로 밀 때 다리를 편다.
     · 딛는 발은 발바닥이 지면을 훑고(무릎이 살짝 굽어 충격을 먹는다)
     · 뒤꿈치가 먼저 닿아 발끝으로 밀어내는 리듬을 넣는다 */
  const step = (side, ph, rev) => {
    const sn = Math.sin(ph), cs = Math.cos(ph);
    const swingW = Math.max(0, -cs);            // 다리를 앞으로 차는 구간
    const stanceW = Math.max(0, cs);            // 발이 땅을 미는 구간
    const thigh = -sn * thighAmp;
    const knee = (0.12 + swingW * 1.28 + stanceW * 0.22) * amp + 0.055;
    R(p, rev ? J.thighL : J.thighR, thigh, 0, 0);
    R(p, rev ? J.shinL : J.shinR, knee, 0, 0);
    /* 발목: 차는 동안 발끝이 들리고, 디딤에서는 뒤꿈치→발끝 순으로 구른다 */
    R(p, rev ? J.footL : J.footR,
      -thigh * 0.52 - knee * 0.62 + swingW * (0.42 + 0.10 * sn) - stanceW * 0.10, 0, 0);
  };
  step('R', phase, false);
  step('L', phase + Math.PI, true);

  /* 골반: 좌우 흔들림(롤) · 걸음마다 돌아가는 요 · 위아래 반동(2배 주기) */
  const bob = Math.abs(s) * (cls === 'knight' ? 0.058 : 0.036) * amp;
  p.rootAdd[1] -= bob + 0.006 * amp;
  R(p, J.pelvis, 0.02 * amp, -s * 0.13 * amp, -s * 0.062 * amp);
  /* 허리는 앞으로 기울고(속도 비례), 어깨는 골반과 반대로 비틀려 팔이 따라온다 */
  const lean = (cls === 'knight' ? 0.11 : cls === 'wizard' ? 0.05 : 0.092) * amp;
  R(p, J.spine, lean, s * 0.145 * amp, s * 0.032 * amp);
  R(p, J.chest, 0.02 * amp + lean * 0.18, s * 0.11 * amp, -s * 0.022 * amp);
  R(p, J.neck, -lean * 0.58, -s * 0.10 * amp, 0);

  /* 팔: 무기 팔은 무게 때문에 작게, 반대 팔은 크게 흔들린다 · 팔꿈치가 늦게 따라온다 */
  const armSwing = (cls === 'knight' ? 0.12 : cls === 'wizard' ? 0.09 : 0.31) * amp;
  R(p, J.shR, s * 0.05 * amp, 0, 0);
  R(p, J.shL, -s * 0.075 * amp, 0, 0);
  R(p, J.armR, s * armSwing * 0.62, 0, s * 0.03 * amp);
  R(p, J.elbR, Math.max(0, s) * 0.30 * amp + 0.06 * amp, 0, 0);
  R(p, J.handR, -s * 0.11 * amp, 0, 0);
  R(p, J.armL, -s * armSwing, 0, -s * 0.03 * amp);
  R(p, J.elbL, Math.max(0, -s) * 0.34 * amp + 0.06 * amp, 0, 0);
  R(p, J.handL, s * 0.06 * amp, 0, 0);
  /* 머리는 흔들림을 상쇄해 시선을 고정 */
  R(p, J.head, -bob * 0.7 - lean * 0.4, s * 0.05 * amp, 0);
}

/* ---------------------------------------------------------------------------
   사망 모션 — 무릎 꿇고 쓰러진다 (모두 같은 기본 연출)
   --------------------------------------------------------------------------- */
const KNEEL_T = 0.62, FALL_T = 0.40;
export function applyDeath(p, cls, t, kind, dir) {
  // t: 사망 후 경과 시간(초)
  const heavy = cls === 'knight' ? 1.16 : cls === 'wizard' ? 0.92 : 1;
  const side = (dir || 0) >= 0 ? 1 : -1;
  const hitP = smoothstep(seg(t, 0, 0.15));
  /* 무릎이 먼저 풀리고(0.10~0.16) 체중이 앞으로 실리며 천천히 꿇는다 */
  const kneeDrop = smoothstep(seg(t, 0.10, 0.26));
  const kneelP = smoothstep(seg(t, 0.16, 0.20 + KNEEL_T * heavy));
  const fallP = easeInCubic(seg(t, 0.20 + KNEEL_T * heavy, 0.20 + KNEEL_T * heavy + FALL_T));
  const settleP = smoothstep(seg(t, 0.20 + KNEEL_T * heavy + FALL_T * 0.6, 0.20 + KNEEL_T * heavy + FALL_T + 0.55));

  // 1) 맞은 순간 젖혀짐 — 어깨가 먼저 돌고 머리가 늦게 따라온다
  const hk = hitP * (1 - kneelP * 0.55);
  R(p, J.spine, -0.30 * hk, 0.13 * hk, 0.04 * hk);
  R(p, J.chest, -0.16 * hk, 0.09 * hk, 0.02 * hk);
  R(p, J.neck, -0.12 * hk, 0, 0);
  R(p, J.head, -0.34 * hk, -0.12 * hk, 0.07 * hk);
  R(p, J.armR, -0.40 * hk, 0, 0.46 * hk);
  R(p, J.armL, -0.52 * hk, 0, -0.52 * hk);
  R(p, J.elbR, -0.46 * hk, 0, 0);
  R(p, J.elbL, -0.58 * hk, 0, 0);
  p.rootAdd[0] -= 0.09 * hk;
  p.rootAdd[2] -= 0.05 * hk;

  // 2) 무릎 풀림 → 꿇기 (골반이 뒤로 빠지고 상체는 앞으로)
  const drop = 0.52 * kneelP;
  p.rootAdd[0] -= drop;
  R(p, J.pelvis, 0.24 * kneelP, side * 0.05 * kneelP, side * 0.03 * kneelP);
  R(p, J.thighR, -1.22 * kneelP, 0, 0.10 * kneelP);
  R(p, J.thighL, -1.10 * kneelP, 0, -0.10 * kneelP);
  R(p, J.shinR, 2.08 * kneelP, 0, 0);
  R(p, J.shinL, 1.96 * kneelP, 0, 0);
  R(p, J.footR, -0.58 * kneelP, 0, 0);
  R(p, J.footL, -0.52 * kneelP, 0, 0);
  R(p, J.spine, 0.50 * kneelP + 0.10 * kneeDrop, -0.10 * kneelP, 0.05 * kneelP);
  R(p, J.chest, 0.24 * kneelP, -0.06 * kneelP, 0);
  R(p, J.neck, 0.18 * kneelP, 0, 0);
  R(p, J.head, 0.26 * kneelP, 0.08 * kneelP, 0.08 * kneelP * side);
  // 팔은 무기력을 잃고 아래로 — 검을 쥔 팔이 먼저 떨어진다
  R(p, J.shR, 0.12 * kneelP, 0, -0.05 * kneelP);
  R(p, J.armR, 0.34 * kneelP, 0, -0.12 * kneelP);
  R(p, J.elbR, 0.46 * kneelP, 0, 0);
  R(p, J.handR, 0.58 * kneelP, 0, -0.30 * kneelP);
  R(p, J.shL, 0.06 * kneelP, 0, 0.05 * kneelP);
  R(p, J.armL, 0.22 * kneelP, 0, 0.14 * kneelP);
  R(p, J.elbL, 0.30 * kneelP, 0, 0);
  // 바닥에 닿는 순간의 작은 반동
  const bounce = Math.sin(clamp((t - 0.14 - KNEEL_T * heavy * 0.75) * 9, 0, Math.PI)) * 0.024 * kneelP;
  p.rootAdd[0] += bounce;

  // 3) 앞으로 고꾸라짐 (발목을 축으로 몸 전체 피치) — 맞은 쪽으로 살짝 비틀어진다
  p.rot[0] += fallP * 1.34;
  p.rot[2] += fallP * 0.10 * side;
  p.rootAdd[0] -= fallP * 0.10;
  R(p, J.spine, 0.26 * fallP, 0, -0.06 * fallP * side);
  R(p, J.head, 0.18 * fallP, 0.10 * fallP, 0.04 * fallP);
  // 쓰러지며 팔이 앞으로 뻗어 바닥을 짚으려 한다
  R(p, J.armR, -0.30 * fallP, 0, -0.52 * fallP);
  R(p, J.armL, -0.26 * fallP, 0, 0.52 * fallP);
  R(p, J.elbR, -0.44 * fallP, 0, 0);
  R(p, J.elbL, -0.38 * fallP, 0, 0);
  R(p, J.thighR, 0.22 * fallP, 0, 0);
  R(p, J.thighL, 0.18 * fallP, 0, 0);

  // 4) 안착 — 몸이 살짝 가라앉고 어깨가 풀린다
  const sk = settleP * (1 - fallP * 0.35);
  p.rot[1] += 0.06 * sk;
  p.rot[2] += 0.03 * sk * side;
  p.rootAdd[0] -= 0.022 * sk;
  p.rootAdd[2] += 0.055 * sk;
  R(p, J.armR, 0.10 * sk, 0, 0);
  R(p, J.armL, 0.08 * sk, 0, 0);
  R(p, J.head, 0.06 * sk, 0, 0);
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
    const cyc = u.cycle || s.cycle;          // 병종 기본 주기
    const norm = (u.attackT / Math.max(0.001, cyc)) * def.dur;
    if (norm <= def.dur) applyKeys(p, cls, Math.min(norm, def.dur));
  }

  // 피격 경직 — 맞은 방향으로 젖혀지고 무릎이 꿇리는 반동
  //  (맞은 프레임에 k 가 0.78 로 튀던 것을 sin 충격 곡선으로 바꿔 '툭' 끊기는 느낌을 없앤다)
  if (u.staggerT > 0) {
    const smax = Math.max(0.12, u.staggerMax || 0.28);
    const e = clamp(1 - u.staggerT / smax, 0, 1);
    const k = Math.pow(Math.sin(Math.PI * Math.min(1, e * 1.04)), 0.66);
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
  //  (AI 가 막기를 켜고 끌 때 자세가 순간이동하지 않도록 0.1초 동안 섞는다)
  const guardTarget = u.guard && !u.dead ? 1 : 0;
  u._guardK = u._guardK === undefined ? guardTarget : u._guardK + (guardTarget - u._guardK) * Math.min(1, dt * 11);
  if (u._guardK > 0.002) blendSection(p, u._guardK, () => {
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
      // ⚔️ 방패 없이 장검 하나로 — 날을 얼굴 앞 대각선으로 세우고 왼손은 검을 받쳐 든다
      R(p, J.shR, 0.10, -0.32, -0.20);
      R(p, J.armR, -1.06, -0.32, -0.48);
      R(p, J.elbR, -1.44, 0, 0);
      R(p, J.handR, 0.08, -1.14, 0.40);
      R(p, J.shL, 0.04, 0.26, 0.14);
      R(p, J.armL, -0.70, -0.28, 0.40);
      R(p, J.elbL, -1.26, 0, 0);
      R(p, J.handL, 0.14, 0.32, -0.18);
    } else if (cls === 'berserker') {
      // 🩸 두 단검을 가슴 앞에서 X자로 교차시켜 막는다
      R(p, J.shR, 0.10, -0.30, -0.18);
      R(p, J.armR, -1.10, -0.30, -0.50);
      R(p, J.elbR, -1.40, 0, 0);
      R(p, J.handR, 0.10, -1.10, 0.38);
      R(p, J.shL, 0.10, 0.30, 0.18);
      R(p, J.armL, -1.10, 0.30, 0.50);
      R(p, J.elbL, -1.40, 0, 0);
      R(p, J.handL, 0.10, 1.10, -0.38);
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
  });

  // 🌸 매화 일섬 돌진 자세
  if (u.dashT !== undefined && u.dashT >= 0) {
    const k = clamp(u.dashT / SKILL.dashTime, 0, 1);
    const lunge = Math.sin(Math.min(1, k * 1.3) * Math.PI);
    const wDash = smoothstep(clamp(u.dashT / 0.07, 0, 1)) * smoothstep(clamp((SKILL.dashTime - u.dashT) / 0.09, 0, 1));
    if (wDash > 0.002) blendSection(p, wDash, () => {
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
    });
  }

  // 사망
  if (u.dead) {
    applyDeath(p, cls, u.deadT || 0, null, u.staggerSide || 1);
    // 죽는 순간 휘두르던 팔 자세를 0.2초 동안 겹쳐 준다 (팔이 순간이동하던 문제)
    if (u._atkFreeze !== undefined && u._atkFreeze >= 0 && (u.deadT || 0) < 0.22) {
      const w = 1 - clamp((u.deadT || 0) / 0.20, 0, 1);
      const def = ATTACK[cls] || ATTACK.soldier;
      blendSection(p, w, () => applyKeys(p, cls, Math.min(def.dur, u._atkFreeze)));
    }
  } else if (u.freezeT > 0) {
    /* 얼어붙은 동안의 미세한 떨림 (움직임은 battle 에서 멈춘다) */
    const fk = clamp(u.freezeT / 0.3, 0, 1);
    const shiver = Math.sin(t * 31 + ph) * 0.014 * fk;
    R(p, J.spine, shiver, 0, shiver * 0.7);
    R(p, J.chest, shiver * 0.7, 0, 0);
    R(p, J.head, shiver * 0.9, 0, 0);
  }

  /* 🩸 시체는 툭 사라지지 않고 마지막 0.45초 동안 땅으로 가라앉는다 (DEATH_REMOVE 3.14 - 0.45) */
  if (u.dead && u.deadT > 2.69) {
    const k = clamp((u.deadT - 2.69) / 0.45, 0, 1);
    p.rootAdd[1] -= k * k * 0.45;
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
