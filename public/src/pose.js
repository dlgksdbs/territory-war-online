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
  knight: [
    ROT('pelvis', 0.02, 0, 0),
    ROT('spine', 0.08, 0.02, 0),
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
    ROT('armL', -0.10, 0.05, -0.16),
    ROT('elbL', -0.20, 0, 0),
    ROT('handL', 0.04, 0, -0.08),
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
      { t: 0.10, j: { spine: [0.10, 0.10, 0], armR: [-0.30, 0.10, 0.32], elbR: [-0.85, 0.1, 0] }, ease: 'inout' },
      { t: 0.30, j: {
        spine: [-0.10, 0.58, 0.05], chest: [-0.06, 0.34, 0.06], neck: [0, -0.25, 0], head: [0.02, -0.38, 0],
        armR: [0.52, 0.30, 0.88], elbR: [-1.18, 0.1, 0], handR: [-0.62, -0.30, 0.32],
        armL: [-0.48, -0.1, -0.28], elbL: [-1.30, 0, 0],
        thighR: [0.20, 0, 0.09], shinR: [0.30, 0, 0], thighL: [-0.14, 0, -0.08], shinL: [0.24, 0, 0],
        root: [-0.045, -0.035]
      }, ease: 'out' },
      { t: 0.42, j: {
        spine: [0.30, -0.46, -0.04], chest: [0.16, -0.34, -0.05], neck: [0.04, 0.10, 0], head: [0.06, 0.06, 0],
        armR: [-1.08, -0.18, 0.04], elbR: [-0.14, 0, 0], handR: [0.92, 0.16, -0.10],
        armL: [-0.72, 0.05, -0.42], elbL: [-1.42, 0, 0],
        thighR: [-0.42, 0, 0.10], shinR: [0.48, 0, 0], thighL: [0.26, 0, -0.09], shinL: [0.32, 0, 0],
        root: [-0.075, 0.16]
      }, ease: 'out' },
      { t: 0.56, j: {
        spine: [0.22, -0.62, -0.03], chest: [0.06, -0.30, 0], head: [0.02, 0.10, 0],
        armR: [-0.58, -0.30, -0.24], elbR: [-0.78, 0, 0], handR: [0.52, 0.20, -0.18],
        armL: [-0.60, 0.05, -0.36], elbL: [-1.30, 0, 0],
        thighR: [-0.30, 0, 0.10], shinR: [0.36, 0, 0], thighL: [0.18, 0, -0.09],
        root: [-0.05, 0.18]
      }, ease: 'inout' },
      { t: 0.72, j: {
        spine: [0.12, -0.34, 0], chest: [0.02, -0.16, 0],
        armR: [-0.44, -0.12, 0.02], elbR: [-0.92, 0, 0], handR: [0.62, 0.0, 0.05],
        armL: [-0.42, 0, -0.26], elbL: [-1.16, 0, 0],
        root: [-0.02, 0.08]
      }, ease: 'inout' },
      { t: 0.92, j: {}, ease: 'inout' }
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
      { t: 0.08, j: { spine: [0.12, 0.24, 0], armR: [-0.60, -0.30, 0.44], elbR: [-1.10, 0, 0] }, ease: 'inout' },
      { t: 0.24, j: {
        spine: [-0.10, 0.62, 0.06], chest: [-0.06, 0.36, 0.06], neck: [0, -0.3, 0], head: [0, -0.34, 0],
        armR: [0.34, 0.20, 0.80], elbR: [-1.26, 0, 0], handR: [-0.55, -0.35, 0.30],
        armL: [-0.70, -0.10, -0.34], elbL: [-1.40, 0, 0],
        thighR: [0.14, 0, 0.13], shinR: [0.34, 0, 0], thighL: [-0.16, 0, -0.13], shinL: [0.30, 0, 0],
        root: [-0.06, -0.04]
      }, ease: 'out' },
      { t: 0.34, j: {
        spine: [0.34, -0.55, -0.06], chest: [0.18, -0.40, -0.05], head: [0.04, 0.10, 0],
        armR: [-1.20, -0.25, -0.10], elbR: [-0.10, 0, 0], handR: [0.95, 0.25, -0.18],
        armL: [-0.95, 0.05, -0.50], elbL: [-1.50, 0, 0],
        thighR: [-0.55, 0, 0.13], shinR: [0.62, 0, 0], thighL: [0.34, 0, -0.13], shinL: [0.40, 0, 0],
        root: [-0.10, 0.26]
      }, ease: 'out' },
      { t: 0.46, j: {
        spine: [0.26, -0.70, -0.04], chest: [0.10, -0.34, 0], head: [0.02, 0.12, 0],
        armR: [-0.62, -0.42, -0.34], elbR: [-0.70, 0, 0], handR: [0.55, 0.20, -0.22],
        armL: [-0.80, 0.05, -0.42], elbL: [-1.30, 0, 0],
        thighR: [-0.40, 0, 0.13], shinR: [0.50, 0, 0], thighL: [0.26, 0, -0.13],
        root: [-0.06, 0.30]
      }, ease: 'inout' },
      { t: 0.62, j: {
        spine: [0.16, -0.40, 0], chest: [0.04, -0.18, 0],
        armR: [-0.50, -0.24, 0.10], elbR: [-0.92, 0, 0], handR: [0.40, -0.30, 0.06],
        armL: [-0.62, 0.04, -0.34], elbL: [-1.18, 0, 0],
        root: [-0.03, 0.16]
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
  const heavy = cls === 'knight' ? 0.78 : cls === 'wizard' ? 0.42 : 1;
  const amp = clamp(move, 0, 1) * heavy;
  const s = Math.sin(phase), c = Math.cos(phase);
  const stride = cls === 'knight' ? 0.52 : cls === 'wizard' ? 0.34 : 0.66;
  const thighAmp = stride * amp;

  const thR = -s * thighAmp;
  const thL = s * thighAmp;
  const kneeR = (0.16 + Math.max(0, -c) * 1.05) * amp + 0.10;
  const kneeL = (0.16 + Math.max(0, c) * 1.05) * amp + 0.10;
  R(p, J.thighR, thR, 0, 0);
  R(p, J.thighL, thL, 0, 0);
  R(p, J.shinR, kneeR, 0, 0);
  R(p, J.shinL, kneeL, 0, 0);
  R(p, J.footR, -thR * 0.42 - kneeR * 0.35, 0, 0);
  R(p, J.footL, -thL * 0.42 - kneeL * 0.35, 0, 0);

  // 골반 상하 · 좌우 흔들림
  const bob = Math.abs(Math.sin(phase)) * (cls === 'knight' ? 0.055 : 0.035) * amp;
  p.rootAdd[1] -= bob + 0.01 * amp;
  R(p, J.pelvis, 0, s * 0.07 * amp, -s * 0.045 * amp);
  R(p, J.spine, (cls === 'knight' ? 0.06 : 0.03) * amp, -s * 0.06 * amp, s * 0.02 * amp);
  R(p, J.chest, 0, -s * 0.05 * amp, 0);

  // 팔 반동 (오른팔은 무기 무게로 조금 덜)
  const armSwing = (cls === 'knight' ? 0.16 : cls === 'wizard' ? 0.10 : 0.26) * amp;
  R(p, J.armR, s * armSwing * 0.7, 0, 0);
  R(p, J.armL, -s * armSwing, 0, 0);
  R(p, J.elbR, Math.max(0, s) * 0.22 * amp, 0, 0);
  R(p, J.elbL, Math.max(0, -s) * 0.18 * amp, 0, 0);
  // 머리는 흔들림을 상쇄해 시선 고정
  R(p, J.head, -bob * 0.6, s * 0.03 * amp, 0);
}

/* ---------------------------------------------------------------------------
   사망 모션 — 무릎 꿇고 쓰러진다
   --------------------------------------------------------------------------- */
const KNEEL_T = 0.62, FALL_T = 0.40;
export function applyDeath(p, cls, t) {
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
    const s = CLASSES[cls] || CLASSES.soldier;
    const norm = (u.attackT / Math.max(0.001, s.cycle)) * def.dur;
    if (norm <= def.dur) applyKeys(p, cls, Math.min(norm, def.dur));
  }

  // 피격 경직
  if (u.staggerT > 0) {
    const k = smoothstep(Math.min(1, u.staggerT / 0.28));
    R(p, J.spine, 0.24 * k, (u.staggerSide || 1) * 0.18 * k, 0);
    R(p, J.chest, 0.12 * k, 0, 0);
    R(p, J.head, 0.18 * k, 0, 0);
    R(p, J.armR, 0.22 * k, 0, 0.18 * k);
    R(p, J.armL, 0.22 * k, 0, -0.18 * k);
    p.rootAdd[2] -= 0.05 * k;
  }

  // 시선 목표 (머리만 살짝)
  if (u.lookYaw) R(p, J.head, 0, clamp(u.lookYaw, -0.6, 0.6) * 0.55, 0);

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

  // 사망
  if (u.dead) {
    applyDeath(p, cls, u.deadT || 0);
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
