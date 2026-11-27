/* =============================================================================
   pose.js — 절차적 전투 모션
   -----------------------------------------------------------------------------
   · 대기: 호흡(가슴·어깨·목) + 느린 무게 이동(골반 롤·무릎) + 무기 끝 미세 흔들림
   · 이동: 보폭·무릎 접힘·골반 흔들림·어깨 반회전·팔 역위상·뒤꿈치→발끝 구름·상체 반동
   · 공격: 예비동작(몸통 코일 + 체중 뒤로) → 힙 드라이브 + 몸통 회전 +
           어깨→팔꿈치→손목 연동 → 임팩트 스냅(무기·머리 지연) → 팔로우스루 → 복귀
   · 피격: 맞은 방향으로 젖혀짐 + 무릎 풀림 + 무기 반동 + 머리 지연
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
   체형·무게 특성 — 대기 자세 높이, 호흡 속도, 좌우 무게 이동 폭
   --------------------------------------------------------------------------- */
const BODY = {
  soldier: { drop: 0.035, knee: 1.00, breath: 1.55, sway: 1.00, lean: 0.145, stride: 0.84, heavy: 1.00, armSwing: 0.52 },
  elite: { drop: 0.030, knee: 0.95, breath: 1.45, sway: 0.92, lean: 0.140, stride: 0.86, heavy: 1.02, armSwing: 0.50 },
  knight: { drop: 0.060, knee: 1.18, breath: 1.05, sway: 0.70, lean: 0.155, stride: 0.60, heavy: 0.80, armSwing: 0.20 },
  blademaster: { drop: 0.070, knee: 1.30, breath: 1.85, sway: 1.15, lean: 0.160, stride: 0.90, heavy: 1.06, armSwing: 0.46 },
  berserker: { drop: 0.055, knee: 1.35, breath: 2.25, sway: 1.30, lean: 0.200, stride: 0.88, heavy: 1.05, armSwing: 0.42 },
  wizard: { drop: 0.030, knee: 0.82, breath: 1.30, sway: 0.60, lean: 0.095, stride: 0.40, heavy: 0.55, armSwing: 0.16 }
};

/* 🎬 모션 세기 — 한 번에 조절하는 배율 (요청: "모션 빡세게") */
const MOTION = {
  attack: 1.24,      // 공격 키프레임 관절 회전 배율 (예비동작·임팩트·팔로우스루)
  lunge: 1.5,        // 공격할 때 몸이 실려 나가는 앞뒤 이동 배율
  stagger: 1.35,     // 피격으로 젖혀지는 세기
  guard: 1.0         // 막기 자세 (자세 자체를 아래 applyGuard 에서 직접 키웠다)
};

/* ---------------------------------------------------------------------------
   기본 자세 (클래스별) — 무게중심을 낮추고 무기를 든 팔을 크게 벌린 전투 자세
   --------------------------------------------------------------------------- */
const BASE = {
  soldier: [
    ROT('pelvis', 0.02, 0, 0),
    ROT('spine', 0.07, -0.05, 0),
    ROT('chest', -0.03, 0.04, 0),
    ROT('neck', 0.02, 0, 0),
    ROT('head', -0.06, 0.05, 0),
    /* 검을 든 오른팔은 어깨에서 살짝 벌리고 팔꿈치를 접어 검이 앞을 향한다 */
    ROT('shR', -0.02, 0, -0.10),
    ROT('armR', -0.26, 0, 0.20),
    ROT('elbR', -0.62, 0.12, 0),
    ROT('handR', 1.14, -0.30, 0.12),
    /* 왼팔은 살짝 앞·아래로 — 무게를 싣고 언제든 받쳐 들 수 있게 */
    ROT('shL', -0.02, 0, 0.10),
    ROT('armL', -0.34, -0.06, -0.22),
    ROT('elbL', -0.86, 0, 0),
    ROT('handL', 0.30, 0.20, -0.12),
    ROT('thighR', -0.09, 0, 0.10),
    ROT('shinR', 0.24, 0, 0),
    ROT('footR', -0.14, 0, 0),
    ROT('thighL', 0.07, 0, -0.10),
    ROT('shinL', 0.20, 0, 0),
    ROT('footL', -0.10, 0, 0)
  ],
  elite: [
    ROT('pelvis', 0.02, 0, 0),
    ROT('spine', 0.06, -0.06, 0),
    ROT('chest', -0.02, 0.05, 0),
    ROT('neck', 0.02, 0, 0),
    ROT('head', -0.06, 0.05, 0),
    /* 오른손 장검은 살짝 앞으로, 왼손은 검을 받쳐 잡을 수 있게 가슴 앞에 (방패 없음) */
    ROT('shR', -0.02, 0, -0.10),
    ROT('armR', -0.36, 0, 0.20),
    ROT('elbR', -0.72, 0.10, 0),
    ROT('handR', 1.16, -0.26, 0.10),
    ROT('shL', 0.02, 0.08, 0.08),
    ROT('armL', -0.40, -0.10, -0.22),
    ROT('elbL', -0.94, 0, 0),
    ROT('handL', 0.28, 0.24, -0.08),
    ROT('thighR', -0.11, 0, 0.12),
    ROT('shinR', 0.28, 0, 0),
    ROT('footR', -0.15, 0, 0),
    ROT('thighL', 0.09, 0, -0.12),
    ROT('shinL', 0.22, 0, 0),
    ROT('footL', -0.11, 0, 0)
  ],
  knight: [
    ROT('pelvis', 0.03, 0, 0), ROT('spine', 0.09, 0.02, 0),
    ROT('chest', 0.02, -0.02, 0),
    ROT('neck', 0.03, 0, 0),
    ROT('head', -0.10, 0.02, 0),
    ROT('shR', -0.02, 0, -0.14),
    ROT('armR', -0.56, -0.16, 0.22),
    ROT('elbR', -1.06, 0.15, 0),
    /* 망치는 가슴 앞 낮게 두 손으로 — 멀리서 머리통만 떠 보이지 않게 */
    ROT('handR', -0.66, 0.06, 0.10),
    ROT('shL', 0.02, 0, 0.14),
    ROT('armL', -0.96, 0.24, -0.40),
    ROT('elbL', -1.26, 0, 0),
    ROT('handL', 0.60, 0, -0.10),
    ROT('thighR', -0.06, 0, 0.20),
    ROT('shinR', 0.24, 0, 0),
    ROT('footR', -0.16, 0, 0),
    ROT('thighL', 0.06, 0, -0.20),
    ROT('shinL', 0.22, 0, 0),
    ROT('footL', -0.14, 0, 0)
  ],
  blademaster: [
    ROT('pelvis', 0.04, 0.10, 0),
    ROT('spine', 0.10, -0.14, 0),
    ROT('chest', -0.02, 0.12, 0),
    ROT('neck', 0.01, -0.04, 0),
    ROT('head', -0.05, 0.10, 0),
    /* 태도 — 오른팔은 낮게 늘어뜨리고 날을 뒤로 살짝 눕힌 검객의 정지 자세 */
    ROT('shR', 0, 0, -0.10),
    ROT('armR', -0.46, -0.12, 0.30),
    ROT('elbR', -1.00, 0.10, 0),
    ROT('handR', 0.34, -0.58, 0.18),
    ROT('shL', -0.02, 0, 0.10),
    ROT('armL', -0.58, 0.12, -0.32),
    ROT('elbL', -1.18, 0, 0),
    ROT('handL', 0.24, 0.10, -0.10),
    ROT('thighR', -0.14, 0, 0.14),
    ROT('shinR', 0.30, 0, 0),
    ROT('footR', -0.18, 0, 0),
    ROT('thighL', 0.12, 0, -0.14),
    ROT('shinL', 0.24, 0, 0),
    ROT('footL', -0.14, 0, 0)
  ],
  /* 🩸 쌍단검 광전사 — 어깨를 벌리고 팔꿈치를 굽힌 낮은 이도류 자세.
     두 단검은 몸 중앙으로 모이지 않고 각자 어깨 바깥에서 앞·바깥쪽으로 겨눈다. */
  berserker: [
    ROT('pelvis', 0.05, 0, 0),
    ROT('spine', 0.20, -0.04, 0),
    ROT('chest', -0.08, 0.03, 0),
    ROT('neck', 0.07, 0, 0),
    ROT('head', -0.20, 0.03, 0),
    /* 오른 어깨·팔 — 어깨를 앞으로 말고 팔꿈치를 굽혀 단검을 가슴 높이 앞으로 */
    ROT('shR', -0.08, -0.12, -0.16),
    ROT('armR', -0.45, 0.10, 0.42),
    ROT('elbR', -1.20, 0.12, 0),
    ROT('handR', 1.22, 0.62, 0.02),
    /* 왼 어깨·팔 — 대칭으로 바깥쪽 (손목만 조금 다르게) */
    ROT('shL', -0.08, 0.12, 0.18),
    ROT('armL', -0.41, -0.10, -0.46),
    ROT('elbL', -1.24, -0.12, 0),
    ROT('handL', 1.18, -0.62, -0.02),
    /* 넓게 벌린 낮은 다리 — 오른발을 뒤로 빼고 왼발을 앞에 */
    ROT('thighR', 0.10, 0, 0.22),
    ROT('shinR', 0.34, 0, 0),
    ROT('footR', -0.22, 0, 0),
    ROT('thighL', -0.20, 0, -0.20),
    ROT('shinL', 0.30, 0, 0),
    ROT('footL', -0.10, 0, 0)
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

/* ---------------------------------------------------------------------------
   대기 — 호흡·무게 이동·무기 흔들림·머리 살피기
   --------------------------------------------------------------------------- */
function applyIdle(p, cls, st, t, ph, move) {
  const k = 1 - clamp(move, 0, 1) * 0.82;       // 달리는 중엔 대기 흔들림을 거의 지운다
  if (k <= 0.02) return;
  const br = Math.sin(t * st.breath + ph);              // 호흡 (가슴·어깨)
  const br2 = Math.sin(t * st.breath * 0.47 + ph * 1.31); // 느린 들숨·날숨
  /* 가슴이 열리고 어깨가 살짝 들리며 목이 숙여진다 */
  R(p, J.chest, (-0.020 * br - 0.008 * br2) * st.knee, 0, 0, k);
  R(p, J.spine, (0.010 * br + 0.004 * br2) * st.knee, 0, 0, k);
  R(p, J.shR, -0.018 * br, 0, -0.022 * br, k);
  R(p, J.shL, -0.018 * br, 0, 0.022 * br, k);
  R(p, J.neck, 0.012 * br, 0, 0, k);
  R(p, J.head, -0.016 * br - 0.006 * br2, 0, 0, k);
  p.rootAdd[1] += (0.0055 * br + 0.0025 * br2) * k;

  /* 느린 무게 이동 — 골반이 한쪽으로 기울고 그쪽 무릎이 펴지며 반대쪽이 굽는다 */
  const sw = Math.sin(t * 0.57 + ph * 0.73) * st.sway * k;
  const sw2 = Math.sin(t * 0.31 + ph * 1.7) * k;
  R(p, J.pelvis, 0, sw * 0.045, -sw * 0.055);
  R(p, J.spine, 0, -sw * 0.060, sw * 0.030);
  R(p, J.chest, 0, -sw * 0.035, sw * 0.018);
  R(p, J.neck, 0, sw * 0.02, 0);
  R(p, J.thighR, 0, 0, -sw * 0.035);
  R(p, J.thighL, 0, 0, -sw * 0.035);
  R(p, J.shinR, Math.max(0, sw) * 0.05, 0, 0);
  R(p, J.shinL, Math.max(0, -sw) * 0.05, 0, 0);
  /* 가슴·어깨의 아주 느린 좌우 비틀림 (정지 자세가 '살아 있게') */
  R(p, J.chest, 0, 0, sw2 * 0.012);
  R(p, J.shR, sw2 * 0.010, 0, 0);
  R(p, J.shL, -sw2 * 0.010, 0, 0);

  /* 무기 끝 흔들림 — 손목에서 아주 작게 떨린다 */
  const wr = Math.sin(t * 1.13 + ph) * k;
  const wr2 = Math.sin(t * 0.79 + ph * 1.9) * k;
  R(p, J.handR, wr * 0.026, wr2 * 0.030, wr * 0.012);
  R(p, J.handL, -wr * 0.022, wr2 * 0.026, -wr * 0.010);
  R(p, J.armR, 0, wr2 * 0.014, wr * 0.008);
  R(p, J.armL, 0, -wr2 * 0.012, -wr * 0.008);

  /* 머리 — 느리게 좌우를 살피고 아주 작게 끄덕인다 */
  R(p, J.head, Math.sin(t * 0.63 + ph * 2) * 0.020, Math.sin(t * 0.29 + ph) * 0.075, Math.sin(t * 0.41 + ph) * 0.018);
  R(p, J.neck, 0, Math.sin(t * 0.29 + ph) * 0.030, 0);
}

/* ---------------------------------------------------------------------------
   이동 모션 — 보폭·무릎·발목·골반·어깨 반회전·팔 역위상
   --------------------------------------------------------------------------- */
function applyLocomotion(p, cls, phase, move, t) {
  if (move <= 0.001) return;
  const st = BODY[cls] || BODY.soldier;
  const amp = clamp(move, 0, 1);
  const A = amp * st.heavy;
  const s = Math.sin(phase), c = Math.cos(phase);

  /* 다리 — 뒤꿈치가 먼저 닿고 발끝으로 밀어내며, 차는 동안 무릎을 크게 접는다 */
  const step = (side, ph, rev) => {
    const sn = Math.sin(ph), cs = Math.cos(ph);
    const swing = Math.max(0, -sn);                 // 앞으로 차는 구간
    const stance = Math.max(0, sn);                 // 땅을 미는 구간
    const lift = Math.max(0, -cs);                  // 발이 완전히 떠 있는 구간
    /* 착지 직후(뒤꿈치) — 발이 앞으로 나와 막 닿는 순간 */
    const heel = Math.max(0, -sn) * Math.max(0, cs);
    const thigh = -sn * st.stride * A;
    /* 무릎: 차는 초반에 크게 접었다가 앞으로 뻗으며 펴지고, 디딤에서도 살짝 굽는다.
       완전히 편 자세(0.03)로 떨어져 '무릎이 자물쇠처럼 굳는' 느낌을 없앤다. */
    const knee = (0.07 + swing * (0.46 + 0.95 * lift) + stance * 0.17 + heel * 0.15) * A + 0.03;
    R(p, rev ? J.thighL : J.thighR, thigh - swing * 0.09 * A, 0, 0);
    R(p, rev ? J.shinL : J.shinR, knee, 0, 0);
    /* 발목: 착지에서는 발끝이 살짝 들리고(배측굴곡), 디딤 후반에는 발끝으로 밀어낸다(족저굴곡). */
    const ankle = -thigh * 0.46 - knee * 0.58 - heel * 0.36 + swing * 0.20 + stance * 0.24 + lift * 0.14;
    R(p, rev ? J.footL : J.footR, ankle, 0, 0);
    /* 다리가 몸 앞쪽으로 지나갈 때 골반이 살짝 좁아졌다 벌어진다 */
    R(p, rev ? J.hipL : J.hipR, 0, 0, (rev ? 1 : -1) * swing * 0.045 * A);
  };
  step('R', phase, false);
  step('L', phase + Math.PI, true);

  /* 골반 — 위아래 반동(두 걸음 주기) · 좌우 기울기 · 걸음마다 도는 요 */
  const bob = Math.abs(s) * (cls === 'knight' ? 0.056 : cls === 'wizard' ? 0.024 : 0.044) * A;
  p.rootAdd[1] -= bob + 0.005 * A;
  R(p, J.pelvis, 0.03 * A + 0.045 * Math.abs(c) * A, -s * 0.22 * A, -s * 0.11 * A);
  /* 체중이 실린 쪽으로 골반이 옆으로 밀린다 (사람처럼) */
  p.rootAdd[0] += s * 0.020 * A;

  /* 허리 — 속도에 비례해 앞으로 기울고 어깨는 골반과 반대로 크게 비틉린다 */
  const lean = st.lean * A;
  R(p, J.spine, lean + 0.03 * A, s * 0.24 * A, s * 0.040 * A);
  R(p, J.chest, 0.03 * A + lean * 0.18, s * 0.18 * A, -s * 0.030 * A);
  R(p, J.neck, -lean * 0.55, -s * 0.16 * A, 0);

  /* 팔 — 같은 쪽 다리와 반대로 크게 흔들리고, 앞으로 나갈 때 팔꿈치가 늦게 따라온다 */
  const swing = st.armSwing * A;
  const lat = cls === 'knight' ? 0.018 : cls === 'wizard' ? 0.014 : 0.038;
  R(p, J.shR, s * 0.090 * A, 0, -s * lat * 0.5);
  R(p, J.shL, -s * 0.120 * A, 0, s * lat * 0.5);
  R(p, J.armR, s * swing * 0.66, 0, s * lat);
  /* 팔이 앞으로 나갈 때 팔꿈치를 더 접고, 뒤로 갈 때 살짝 편다 (무기를 앞으로 내지르지 않게) */
  R(p, J.elbR, Math.max(0, -s) * 0.40 * A - Math.max(0, s) * 0.12 * A, 0, 0);
  R(p, J.handR, -s * 0.18 * A, 0, s * 0.03 * A);
  R(p, J.armL, -s * swing, 0, -lat * (0.6 + 0.4 * s) * A);
  R(p, J.elbL, Math.max(0, s) * 0.46 * A - Math.max(0, -s) * 0.12 * A, 0, 0);
  R(p, J.handL, s * 0.10 * A, 0, 0);
  /* 머리는 흔들림을 상쇄해 시선을 고정한다 */
  R(p, J.head, -bob * 0.65 - lean * 0.35, s * 0.08 * A, s * 0.02 * A);
}

/* 공격 키프레임 — [시간, {관절: [x,y,z], root:[y,z]} ...]
   · 예비: 몸통을 감고 체중을 뒤로 (root z 음수)
   · 임팩트: 힙·몸통이 먼저 돌고 어깨→팔→손목이 따라오며 무기가 앞으로 스냅
   · 팔로우스루: 지나쳐 돌아가며 어깨가 풀린다 → 복귀 */
const ATTACK = {
  soldier: {
    dur: 0.92,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.10, j: {
        spine: [0.13, 0.20, 0], chest: [0.05, 0.13, 0], neck: [0, -0.06, 0], head: [0.02, -0.10, 0],
        armR: [-0.44, 0.16, 0.40], elbR: [-1.10, 0.10, 0], handR: [-0.20, -0.30, 0.30],
        armL: [-0.58, -0.10, -0.34], elbL: [-1.20, 0, 0],
        thighR: [0.10, 0, 0.10], shinR: [0.34, 0, 0], thighL: [-0.06, 0, -0.10],
        root: [-0.022, -0.035]
      }, ease: 'inout' },
      { t: 0.28, j: {
        spine: [-0.08, 0.68, 0.08], chest: [-0.05, 0.40, 0.08], neck: [0, -0.28, 0], head: [0.02, -0.42, 0.04],
        armR: [0.30, 0.30, 0.94], elbR: [-1.26, 0.1, 0], handR: [-0.58, -0.36, 0.38],
        armL: [-0.56, -0.12, -0.32], elbL: [-1.44, 0, 0],
        thighR: [0.22, 0, 0.09], shinR: [0.36, 0, 0], thighL: [-0.16, 0, -0.08], shinL: [0.28, 0, 0],
        root: [-0.058, -0.055]
      }, ease: 'inout' },
      /* 힙 드라이브 시작 — 몸통이 먼저 돌기 시작한다 */
      { t: 0.35, j: {
        spine: [0.14, -0.10, 0.02], chest: [0.10, -0.12, 0], head: [0.04, 0.05, 0],
        armR: [-0.60, 0.10, 0.58], elbR: [-0.72, 0, 0], handR: [0.22, -0.10, 0.20],
        thighR: [-0.12, 0, 0.10], shinR: [0.40, 0, 0], thighL: [0.06, 0, -0.09],
        root: [-0.035, 0.05]
      }, ease: 'inout' },
      { t: 0.42, j: {
        spine: [0.34, -0.38, -0.06], chest: [0.18, -0.26, -0.06], neck: [0.04, 0.10, 0], head: [0.06, 0.08, 0],
        armR: [-1.02, -0.18, 0.22], elbR: [-0.16, 0, 0], handR: [0.82, 0.10, -0.10],
        armL: [-0.80, 0.06, -0.48], elbL: [-1.46, 0, 0],
        thighR: [-0.48, 0, 0.10], shinR: [0.54, 0, 0], thighL: [0.30, 0, -0.09], shinL: [0.34, 0, 0],
        root: [-0.088, 0.20]
      }, ease: 'out' },
      { t: 0.54, j: {
        spine: [0.26, -0.62, -0.04], chest: [0.10, -0.30, 0], head: [0.03, 0.14, 0],
        armR: [-0.46, -0.34, -0.18], elbR: [-0.60, 0, 0], handR: [0.52, 0.24, -0.22],
        armL: [-0.68, 0.06, -0.42], elbL: [-1.34, 0, 0],
        thighR: [-0.34, 0, 0.10], shinR: [0.42, 0, 0], thighL: [0.20, 0, -0.09],
        root: [-0.056, 0.22]
      }, ease: 'out' },
      { t: 0.70, j: {
        spine: [0.10, -0.42, 0], chest: [0.02, -0.18, 0],
        armR: [-0.52, -0.14, 0.02], elbR: [-0.98, 0, 0], handR: [0.20, 0.02, 0.06],
        armL: [-0.46, 0, -0.28], elbL: [-1.18, 0, 0],
        root: [-0.020, 0.08]
      }, ease: 'inout' },
      { t: 0.92, j: {}, ease: 'inout' }
    ]
  },
  elite: {
    dur: 0.84,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.09, j: {
        spine: [0.15, 0.24, 0], chest: [0.05, 0.14, 0], head: [0.02, -0.12, 0],
        armR: [-0.50, 0.18, 0.46], elbR: [-1.16, 0.1, 0], handR: [-0.16, -0.34, 0.34],
        armL: [-0.56, -0.10, -0.28], elbL: [-1.28, 0, 0],
        thighR: [0.10, 0, 0.11], shinR: [0.36, 0, 0], thighL: [-0.08, 0, -0.11],
        root: [-0.026, -0.040]
      }, ease: 'inout' },
      { t: 0.26, j: {
        spine: [-0.10, 0.76, 0.09], chest: [-0.06, 0.44, 0.09], neck: [0, -0.30, 0], head: [0.02, -0.46, 0.04],
        armR: [0.34, 0.34, 0.98], elbR: [-1.32, 0.1, 0], handR: [-0.76, -0.40, 0.42],
        armL: [-0.64, -0.14, -0.36], elbL: [-1.50, 0, 0],
        thighR: [0.24, 0, 0.10], shinR: [0.38, 0, 0], thighL: [-0.18, 0, -0.09], shinL: [0.30, 0, 0],
        root: [-0.060, -0.060]
      }, ease: 'inout' },
      { t: 0.33, j: {
        spine: [0.16, -0.12, 0.02], chest: [0.10, -0.14, 0], head: [0.04, 0.06, 0],
        armR: [-0.66, 0.10, 0.62], elbR: [-0.74, 0, 0], handR: [0.40, -0.10, 0.22],
        thighR: [-0.14, 0, 0.11], shinR: [0.42, 0, 0], thighL: [0.08, 0, -0.10],
        root: [-0.038, 0.05]
      }, ease: 'inout' },
      { t: 0.40, j: {
        spine: [0.38, -0.40, -0.07], chest: [0.20, -0.28, -0.07], neck: [0.04, 0.12, 0], head: [0.06, 0.10, 0],
        armR: [-1.05, -0.20, 0.20], elbR: [-0.14, 0, 0], handR: [0.96, 0.12, -0.12],
        armL: [-0.88, 0.08, -0.52], elbL: [-1.52, 0, 0],
        thighR: [-0.52, 0, 0.11], shinR: [0.58, 0, 0], thighL: [0.32, 0, -0.10], shinL: [0.36, 0, 0],
        root: [-0.092, 0.22]
      }, ease: 'out' },
      { t: 0.52, j: {
        spine: [0.28, -0.66, -0.04], chest: [0.10, -0.32, 0], head: [0.03, 0.16, 0],
        armR: [-0.48, -0.34, -0.18], elbR: [-0.64, 0, 0], handR: [0.52, 0.26, -0.24],
        armL: [-0.74, 0.06, -0.46], elbL: [-1.40, 0, 0],
        thighR: [-0.36, 0, 0.11], shinR: [0.44, 0, 0], thighL: [0.22, 0, -0.10],
        root: [-0.060, 0.24]
      }, ease: 'out' },
      { t: 0.66, j: {
        spine: [0.10, -0.46, 0], chest: [0.02, -0.20, 0],
        armR: [-0.56, -0.16, 0.04], elbR: [-1.02, 0, 0], handR: [0.34, 0.02, 0.06],
        armL: [-0.62, 0, -0.28], elbL: [-1.22, 0, 0],
        root: [-0.024, 0.10]
      }, ease: 'inout' },
      { t: 0.84, j: {}, ease: 'inout' }
    ]
  },
  knight: {
    dur: 1.72,
    keys: [
      { t: 0.00, j: {} },
      /* 두 손으로 망치를 들어 올린다 — 어깨·허리가 함께 감긴다 */
      { t: 0.18, j: {
        spine: [-0.04, 0.14, 0], chest: [-0.02, 0.08, 0], head: [-0.06, -0.10, 0],
        armR: [-1.05, -0.18, 0.26], elbR: [-1.20, 0, 0], handR: [-0.30, 0.04, 0.04],
        armL: [-1.30, 0.18, -0.34], elbL: [-1.10, 0, 0],
        thighR: [0.06, 0, 0.20], shinR: [0.24, 0, 0], thighL: [-0.08, 0, -0.20],
        root: [-0.030, -0.030]
      }, ease: 'inout' },
      { t: 0.56, j: {
        spine: [-0.40, 0.20, 0], chest: [-0.18, 0.08, 0], neck: [-0.06, 0, 0], head: [-0.22, -0.14, 0],
        armR: [-2.24, -0.26, 0.30], elbR: [-0.74, 0.05, 0], handR: [-0.40, 0.10, 0.05],
        armL: [-2.08, 0.22, -0.38], elbL: [-0.96, 0, 0], handL: [-0.16, 0, 0],
        thighR: [0.14, 0, 0.18], shinR: [0.24, 0, 0], thighL: [-0.20, 0, -0.18], shinL: [0.44, 0, 0],
        root: [0.070, -0.070]
      }, ease: 'inout' },
      /* 내리치기 — 골반부터 앞으로 밀고 두 팔이 따라 내려온다 */
      { t: 0.78, j: {
        spine: [0.72, -0.10, 0], chest: [0.28, -0.05, 0], neck: [0.10, 0, 0], head: [0.28, 0.08, 0],
        armR: [-0.54, -0.05, 0.12], elbR: [-0.04, 0, 0], handR: [1.06, 0.05, 0.02],
        armL: [-0.62, 0.08, -0.18], elbL: [-0.24, 0, 0], handL: [0.76, 0, 0],
        thighR: [-0.78, 0, 0.20], shinR: [1.10, 0, 0], footR: [-0.32, 0, 0],
        thighL: [-0.42, 0, -0.20], shinL: [0.94, 0, 0], footL: [-0.26, 0, 0],
        root: [-0.26, 0.32]
      }, ease: 'inout' },
      { t: 0.92, j: {
        spine: [0.70, -0.08, 0], chest: [0.24, -0.02, 0], head: [0.22, 0.02, 0],
        armR: [-0.58, -0.06, 0.12], elbR: [-0.08, 0, 0], handR: [1.00, 0.05, 0.02],
        armL: [-0.66, 0.06, -0.20], elbL: [-0.30, 0, 0],
        thighR: [-0.76, 0, 0.20], shinR: [1.06, 0, 0], thighL: [-0.38, 0, -0.20], shinL: [0.90, 0, 0],
        root: [-0.28, 0.33]
      }, ease: 'out' },
      /* 무게가 앞에 실린 채로 끌어올린다 */
      { t: 1.14, j: {
        spine: [0.40, 0.02, 0], chest: [0.14, 0, 0], head: [0.08, 0, 0],
        armR: [-0.96, -0.10, 0.20], elbR: [-0.42, 0, 0], handR: [0.86, 0.05, 0],
        armL: [-0.94, 0.10, -0.30], elbL: [-0.60, 0, 0],
        thighR: [-0.40, 0, 0.19], shinR: [0.66, 0, 0], thighL: [-0.18, 0, -0.19], shinL: [0.50, 0, 0],
        root: [-0.14, 0.18]
      }, ease: 'inout' },
      { t: 1.42, j: {
        spine: [0.18, 0.04, 0], chest: [0.06, 0, 0], head: [0.02, 0, 0],
        armR: [-0.76, -0.12, 0.18], elbR: [-0.70, 0, 0], handR: [0.94, 0.05, 0.04],
        armL: [-0.98, 0.14, -0.34], elbL: [-0.94, 0, 0],
        thighR: [-0.18, 0, 0.19], shinR: [0.40, 0, 0], thighL: [-0.06, 0, -0.19], shinL: [0.32, 0, 0],
        root: [-0.05, 0.08]
      }, ease: 'inout' },
      { t: 1.72, j: {}, ease: 'inout' }
    ]
  },
  blademaster: {
    dur: 0.80,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.10, j: {
        spine: [0.13, 0.28, 0], chest: [0.04, 0.17, 0], head: [0, -0.16, 0],
        armR: [-0.34, -0.24, 0.44], elbR: [-0.42, 0, 0], handR: [-0.04, -0.36, 0.26],
        armL: [-0.42, -0.08, -0.26], elbL: [-0.58, 0, 0],
        thighR: [0.08, 0, 0.14], shinR: [0.28, 0, 0], thighL: [-0.08, 0, -0.14],
        root: [-0.018, -0.026]
      }, ease: 'inout' },
      { t: 0.20, j: {
        spine: [-0.10, 0.66, 0.07], chest: [-0.06, 0.40, 0.07], neck: [0, -0.30, 0], head: [0, -0.38, 0.04],
        armR: [-0.26, 0.14, 0.72], elbR: [-1.32, 0, 0], handR: [-0.28, -0.44, 0.36],
        armL: [-0.80, -0.14, -0.40], elbL: [-1.46, 0, 0],
        thighR: [0.14, 0, 0.13], shinR: [0.38, 0, 0], thighL: [-0.18, 0, -0.13], shinL: [0.34, 0, 0],
        root: [-0.072, -0.055]
      }, ease: 'inout' },
      { t: 0.315, j: {
        spine: [0.40, -0.64, -0.08], chest: [0.20, -0.45, -0.06], head: [0.04, 0.14, 0],
        armR: [-1.14, -0.28, -0.10], elbR: [-0.10, 0, 0], handR: [0.56, 0.30, -0.20],
        armL: [-1.02, 0.06, -0.55], elbL: [-1.52, 0, 0],
        thighR: [-0.60, 0, 0.13], shinR: [0.66, 0, 0], thighL: [0.36, 0, -0.13], shinL: [0.44, 0, 0],
        root: [-0.112, 0.28]
      }, ease: 'inout' },
      { t: 0.45, j: {
        spine: [0.30, -0.86, -0.05], chest: [0.12, -0.42, 0], head: [0.02, 0.16, 0],
        armR: [-0.58, -0.50, -0.42], elbR: [-0.62, 0, 0], handR: [0.48, 0.26, -0.28],
        armL: [-0.88, 0.05, -0.48], elbL: [-1.32, 0, 0],
        thighR: [-0.46, 0, 0.13], shinR: [0.56, 0, 0], thighL: [0.30, 0, -0.13],
        root: [-0.072, 0.33]
      }, ease: 'out' },
      { t: 0.62, j: {
        spine: [0.16, -0.48, 0], chest: [0.04, -0.21, 0],
        armR: [-0.50, -0.30, 0.14], elbR: [-0.94, 0, 0], handR: [0.38, -0.30, 0.10],
        armL: [-0.68, 0.04, -0.38], elbL: [-1.20, 0, 0],
        root: [-0.030, 0.18]
      }, ease: 'inout' },
      { t: 0.80, j: {}, ease: 'inout' }
    ]
  },
  wizard: {
    dur: 1.06,
    keys: [
      { t: 0.00, j: {} },
      { t: 0.18, j: {
        spine: [-0.07, -0.26, 0], chest: [-0.05, -0.18, 0], head: [0.02, 0.24, 0],
        armR: [-1.44, -0.32, 0.36], elbR: [-0.74, 0, 0], handR: [-0.44, 0, 0.1],
        armL: [-0.05, 0.12, -0.10], elbL: [-0.10, 0, 0],
        thighR: [0.04, 0, 0.05], thighL: [-0.04, 0, -0.05],
        root: [-0.012, -0.032]
      }, ease: 'inout' },
      { t: 0.34, j: {
        spine: [0.18, 0.24, 0], chest: [0.12, 0.16, 0], neck: [0.02, -0.08, 0], head: [0.04, -0.16, 0],
        armR: [-1.56, 0.06, 0.04], elbR: [-0.04, 0, 0], handR: [-0.18, 0, 0.04],
        armL: [-0.36, 0.05, -0.24], elbL: [-0.34, 0, 0],
        thighR: [-0.06, 0, 0.05], shinR: [0.16, 0, 0], thighL: [0.05, 0, -0.05],
        root: [0.0, 0.05]
      }, ease: 'out' },
      { t: 0.56, j: {
        spine: [0.10, 0.17, 0], chest: [0.04, 0.10, 0],
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
  /* 🩸 단검 광전사 — 0.24초 동안 '오른단검 → 왼단검' 순서로 번갈아 그어내린다.
     · 두 손이 몸 중앙에서 만나지 않는다: 오른단검은 오른쪽 바깥에서 앞으로,
       왼단검은 왼쪽 바깥에서 앞으로 — 각자 어깨 선을 지킨다 (얼굴을 가로지르지 않음)
     · 검끝은 가슴 높이 앞에서 엇갈린다 (머리 위로 솟지 않게 피치를 누른다)
     · 실제 재생은 cycle 0.25초에 맞춰 재생되어 눈에는 '쉬지 않는 연타'로 보인다. */
  berserker: {
    dur: 0.24,
    abs: true,
    keys: [
      { t: 0.00, j: {} },
      /* 오른단검 — 어깨를 뒤로 감고 검이 몸 밖에서 앞으로 스냅 */
      { t: 0.035, j: {
        spine: [0.20, 0.22, -0.02], chest: [0.02, 0.14, 0], head: [-0.10, -0.12, 0],
        armR: [-0.60, 0.16, 0.64], elbR: [-1.34, 0.10, 0], handR: [1.30, 0.74, 0],
        armL: [-0.96, -0.10, -0.42], elbL: [-1.06, 0, 0], handL: [1.10, -0.62, 0],
        thighR: [0.06, 0, 0.22], shinR: [0.40, 0, 0], thighL: [-0.24, 0, -0.20], shinL: [0.26, 0, 0],
        root: [-0.014, -0.020]
      }, ease: 'out' },
      /* 오른단검 임팩트 — 힙·몸통이 먼저 돌고 팔이 앞으로 뻗어 그어낸다 */
      { t: 0.095, j: {
        spine: [0.10, -0.30, 0.03], chest: [-0.04, -0.18, 0], head: [-0.12, 0.20, 0],
        armR: [-1.16, -0.26, 0.50], elbR: [-0.16, 0, 0], handR: [1.34, 0.06, 0],
        armL: [-0.70, -0.10, -0.60], elbL: [-1.30, 0, 0], handL: [1.10, -0.66, 0],
        thighR: [0.02, 0, 0.22], shinR: [0.30, 0, 0], thighL: [-0.26, 0, -0.20], shinL: [0.30, 0, 0],
        root: [-0.026, 0.055]
      }, ease: 'out' },
      /* 오른단검 팔로우스루 — 왼다리로 체중을 옮기고 왼단검을 감는다 */
      { t: 0.135, j: {
        spine: [0.16, 0.30, -0.02], chest: [0.02, 0.18, 0], head: [-0.10, -0.16, 0],
        armR: [-1.02, 0.20, -0.08], elbR: [-0.24, 0, 0], handR: [1.26, -0.24, 0],
        armL: [-0.58, -0.10, -0.62], elbL: [-1.36, 0, 0], handL: [1.28, -0.72, 0],
        thighR: [0.10, 0, 0.22], shinR: [0.40, 0, 0], thighL: [-0.20, 0, -0.20], shinL: [0.28, 0, 0],
        root: [-0.016, 0.030]
      }, ease: 'out' },
      /* 왼단검 임팩트 — 반대로 몸통이 돌며 왼팔이 그어낸다 */
      { t: 0.180, j: {
        spine: [0.10, 0.30, -0.03], chest: [-0.04, 0.18, 0], head: [-0.12, -0.20, 0],
        armR: [-0.62, 0.16, 0.60], elbR: [-1.30, 0.10, 0], handR: [1.26, 0.72, 0],
        armL: [-1.10, 0.26, -0.56], elbL: [-0.14, 0, 0], handL: [1.30, -0.06, 0],
        thighR: [-0.24, 0, 0.22], shinR: [0.30, 0, 0], thighL: [0.02, 0, -0.20], shinL: [0.30, 0, 0],
        root: [-0.020, 0.045]
      }, ease: 'out' },
      { t: 0.215, j: {
        spine: [0.18, -0.12, 0.01], chest: [0.02, -0.06, 0], head: [-0.12, 0.08, 0],
        armR: [-0.94, 0.12, 0.42], elbR: [-1.16, 0, 0], handR: [1.22, 0.56, 0],
        armL: [-0.80, -0.10, -0.54], elbL: [-0.86, 0, 0], handL: [1.20, -0.50, 0],
        thighR: [-0.06, 0, 0.22], shinR: [0.26, 0, 0], thighL: [-0.10, 0, -0.20], shinL: [0.26, 0, 0],
        root: [-0.008, 0.018]
      }, ease: 'inout' },
      { t: 0.24, j: {}, ease: 'inout' }
    ]
  }
};

/* 기본 자세를 관절별 합계로 미리 계산 — 절대값 키프레임(abs)을 델타로 바꿀 때 쓴다 */
const BASE_SUM = {};
for (const k of Object.keys(BASE)) {
  const m = {};
  for (const b of BASE[k]) {
    const cur = m[b[0]] || (m[b[0]] = [0, 0, 0]);
    cur[0] += b[1]; cur[1] += b[2]; cur[2] += b[3];
  }
  BASE_SUM[k] = m;
}

/* 키프레임 보정 — 어떤 키에서 빠진 관절은 직전 키의 값을 이어받고(기본 자세로 튀지 않게),
   마지막 키는 모든 관절을 기본 자세로 되돌린다. 한 번만 계산해서 프레임 비용은 없다. */
for (const k of Object.keys(ATTACK)) {
  const def = ATTACK[k];
  const names = new Set();
  for (const key of def.keys) for (const n of Object.keys(key.j)) names.add(n);
  const prev = {};
  const zero = (n) => (def.abs && BASE_SUM[k][n] ? BASE_SUM[k][n].slice() : [0, 0, 0]);
  for (const key of def.keys) {
    const last = key.t >= def.dur - 1e-6;
    for (const n of names) {
      if (last) { key.j[n] = zero(n); continue; }
      if (key.j[n]) prev[n] = key.j[n];
      else key.j[n] = (prev[n] || zero(n)).slice();
    }
  }
  /* 첫 키도 기본 자세로 맞춘다 (관절이 하나씩만 지정된 키에서 0으로 튀지 않게) */
  const first = def.keys[0];
  if (first.t < 1e-6) for (const n of names) if (!prev[n] && !first.j[n]) first.j[n] = zero(n);
}

function applyKeys(p, cls, t) {
  const def = ATTACK[cls];
  if (!def) return;
  const keys = def.keys;
  const absMap = def.abs ? BASE_SUM[cls] : null;
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
  }
  let k = (t - a.t) / Math.max(0.0001, b.t - a.t);
  const ease = b.ease || 'inout';
  if (ease === 'out') k = easeOutCubic(k);
  else if (ease === 'quint') k = easeOutQuint(k);
  else if (ease === 'in') k = easeInCubic(k);
  else k = smoothstep(k);
  const names = new Set([...Object.keys(a.j), ...Object.keys(b.j)]);
  for (const name of names) {
    const off = absMap ? absMap[name] : null;
    /* 한쪽 키에만 있는 관절은 그 값을 유지한 채 넘어간다 (기본 자세로 튀어돌어오지 않게) */
    const hasA = !!a.j[name], hasB = !!b.j[name];
    const va0 = hasA ? a.j[name] : b.j[name];
    const vb0 = hasB ? b.j[name] : a.j[name];
    const va = off && hasA ? [va0[0] - off[0], va0[1] - off[1], va0[2] - off[2]] : va0;
    const vb = off && hasB ? [vb0[0] - off[0], vb0[1] - off[1], vb0[2] - off[2]] : vb0;
    if (name === 'root') {
      p.rootAdd[0] += lerp(va[0] || 0, vb[0] || 0, k) * MOTION.lunge;   // y 오프셋
      p.rootAdd[2] += lerp(va[1] || 0, vb[1] || 0, k) * MOTION.lunge;   // z(앞뒤) 오프셋
      continue;
    }
    const j = J[name];
    if (j === undefined) continue;
    for (let c = 0; c < 3; c++) p.rot[j * 3 + c] += lerp(va[c] || 0, vb[c] || 0, k) * MOTION.attack;
  }
}

/* ---------------------------------------------------------------------------
   피격 — 맞은 방향으로 상체가 젖혀지고 무릎이 풀리며 무기가 반동한다
   --------------------------------------------------------------------------- */
function applyStagger(p, cls, u) {
  const smax = Math.max(0.12, u.staggerMax || 0.28);
  const e = clamp(1 - u.staggerT / smax, 0, 1);
  /* 첫 타격은 빠르게 튀고(0.25) 이후 천천히 풀린다 */
  const k = Math.pow(Math.sin(Math.PI * Math.min(1, e * 1.02)), 0.60) * MOTION.stagger;
  const settle = Math.sin(clamp((e - 0.45) * 2.4, 0, 1) * Math.PI) * (1 - e);
  const side = u.staggerSide || 1;
  R(p, J.spine, 0.34 * k, side * 0.26 * k, -side * 0.04 * k);
  R(p, J.chest, 0.16 * k, side * 0.09 * k, -side * 0.02 * k);
  R(p, J.neck, 0.12 * k, 0, 0);
  R(p, J.head, 0.26 * k + 0.05 * settle, side * 0.12 * k, side * 0.06 * k);
  /* 어깨가 들리고 팔이 무게를 버티지 못한다 — 무기 팔이 더 크게 흔들린다 */
  R(p, J.shR, 0.10 * k, 0, -0.12 * k);
  R(p, J.shL, -0.06 * k, 0, 0.10 * k);
  R(p, J.armR, 0.34 * k, 0, 0.26 * k);
  R(p, J.armL, 0.30 * k, 0, -0.24 * k);
  R(p, J.elbR, 0.22 * k, 0, 0);
  R(p, J.elbL, 0.10 * k, 0, 0);
  R(p, J.handR, -0.10 * k, 0.14 * k * side, 0);
  R(p, J.thighR, 0.18 * k, 0, 0.04 * k);
  R(p, J.shinR, 0.28 * k, 0, 0);
  R(p, J.thighL, -0.12 * k, 0, 0);
  R(p, J.shinL, 0.10 * k, 0, 0);
  p.rootAdd[2] -= 0.075 * k;
  p.rootAdd[0] -= 0.035 * k;
}

/* ---------------------------------------------------------------------------
   막기 자세 — 상체를 숙이고 두 발을 벌려 버티며 무기를 대각선으로 세운다
   --------------------------------------------------------------------------- */
function applyGuard(p, cls, t, ph, u) {
  // 공통: 무게중심을 더 낮추고 두 발을 앞뒤로 크게 벌려 버틴다
  R(p, J.thighR, -0.40, 0, 0.20);
  R(p, J.shinR, 0.70, 0, 0);
  R(p, J.footR, -0.32, 0, 0);
  R(p, J.thighL, 0.28, 0, -0.20);
  R(p, J.shinL, 0.60, 0, 0);
  R(p, J.footL, -0.22, 0, 0);
  R(p, J.pelvis, 0.10, -0.14, 0);
  R(p, J.spine, 0.22, 0.18, 0);
  R(p, J.chest, 0.13, 0.20, 0);
  R(p, J.neck, -0.13, -0.15, 0);
  R(p, J.head, -0.08, -0.12, 0);
  p.rootAdd[0] -= 0.05;
  p.rootAdd[2] -= 0.08;
  /* 막고 있는 동안에도 숨을 쉬고 무게가 미세하게 오간다 (돌처럼 굳지 않게) */
  const gb = Math.sin((t || 0) * 2.3 + (ph || 0));
  const gw = Math.sin((t || 0) * 1.1 + (ph || 0) * 0.7);
  R(p, J.chest, -0.024 * gb, gw * 0.030, 0);
  R(p, J.shR, -0.018 * gb, 0, -0.015 * gb);
  R(p, J.shL, -0.018 * gb, 0, 0.015 * gb);
  R(p, J.head, -0.015 * gb, gw * 0.04, 0);
  R(p, J.spine, 0, gw * 0.026, gw * 0.014);
  R(p, J.pelvis, 0, gw * 0.018, -gw * 0.020);
  R(p, J.handR, gb * 0.030, gw * 0.038, 0);
  p.rootAdd[1] += 0.006 * gb;
  p.rootAdd[0] += 0.004 * gw;
  /* 🛡️ 패링 반동 — 막아낸 순간 어깨·팔·상체가 뒤로 튀고 발이 밀린다 (guardFlash 는 battle 이 깎는다) */
  const jolt = u && u.guardFlash > 0 ? Math.pow(clamp(u.guardFlash / 0.24, 0, 1), 1.5) : 0;
  if (jolt > 0.002) {
    R(p, J.spine, -0.34 * jolt, 0.12 * jolt, 0);
    R(p, J.chest, -0.20 * jolt, 0.06 * jolt, 0);
    R(p, J.neck, -0.10 * jolt, 0, 0);
    R(p, J.head, -0.22 * jolt, 0.08 * jolt, 0);
    R(p, J.shR, 0.24 * jolt, 0, 0.14 * jolt);
    R(p, J.armR, 0.34 * jolt, 0, 0.22 * jolt);
    R(p, J.elbR, -0.30 * jolt, 0, 0);
    R(p, J.shL, 0.18 * jolt, 0, -0.12 * jolt);
    R(p, J.armL, 0.26 * jolt, 0, -0.16 * jolt);
    R(p, J.thighR, -0.14 * jolt, 0, 0);
    R(p, J.shinR, 0.18 * jolt, 0, 0);
    p.rootAdd[2] -= 0.055 * jolt;
    p.rootAdd[1] -= 0.022 * jolt;
  }
  if (cls === 'soldier' || cls === 'blademaster') {
    // 검을 얼굴 앞 대각선으로 높이 세우고 왼손을 받쳐 든다 (칼이 시야를 가로지르게)
    R(p, J.shR, 0.16, -0.40, -0.30);
    R(p, J.armR, -1.24, -0.40, -0.60);
    R(p, J.elbR, -1.58, 0, 0);
    R(p, J.handR, 0.02, -1.30, 0.48);
    R(p, J.shL, 0.04, 0.26, 0.14);
    R(p, J.armL, -0.70, -0.40, 0.44);
    R(p, J.elbL, -1.46, 0, 0);
    R(p, J.handL, 0.10, 0.30, -0.20);
  } else if (cls === 'elite') {
    // ⚔️ 방패 없이 장검 하나로 — 날을 얼굴 앞 대각선으로 세우고 왼손은 검을 받쳐 든다
    R(p, J.shR, 0.16, -0.38, -0.28);
    R(p, J.armR, -1.28, -0.38, -0.56);
    R(p, J.elbR, -1.60, 0, 0);
    R(p, J.handR, 0.04, -1.26, 0.46);
    R(p, J.shL, 0.06, 0.32, 0.18);
    R(p, J.armL, -0.86, -0.34, 0.50);
    R(p, J.elbL, -1.42, 0, 0);
    R(p, J.handL, 0.16, 0.38, -0.22);
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
}

/* ---------------------------------------------------------------------------
   사망 모션 — 무릎 꿇고 쓰러진다 (모두 같은 기본 연출)
   --------------------------------------------------------------------------- */
const KNEEL_T = 0.60, FALL_T = 0.40;
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

  // 3-1) 꿇는 동안 팔이 무게를 못 이겨 흔들리고, 무기 손은 손끝부터 풀린다
  const flail = Math.sin(clamp((t - 0.18) * 6.2, 0, Math.PI)) * kneelP * (1 - fallP);
  R(p, J.armR, -0.16 * flail, 0, 0.20 * flail);
  R(p, J.armL, 0.14 * flail, 0, -0.18 * flail);
  R(p, J.handR, 0.30 * flail, 0, 0);
  R(p, J.head, -0.10 * flail, 0.06 * flail * side, 0);

  // 4) 안착 — 몸이 살짝 가라앉고 어깨가 풀린다
  const sk = settleP * (1 - fallP * 0.35);
  p.rot[1] += 0.06 * sk;
  p.rot[2] += 0.03 * sk * side;
  p.rootAdd[0] -= 0.022 * sk;
  p.rootAdd[2] += 0.055 * sk;
  R(p, J.armR, 0.10 * sk, 0, 0);
  R(p, J.armL, 0.08 * sk, 0, 0);
  R(p, J.head, 0.06 * sk, 0, 0);

  /* 4-1) 땅에 닿는 순간의 짧은 충격 — 어깨·머리가 한 번 튀고 잦아든다 */
  const landT = t - (0.20 + KNEEL_T * heavy + FALL_T);
  if (landT > 0) {
    const jolt = Math.exp(-landT * 8.5) * Math.sin(landT * 24);
    R(p, J.spine, 0.022 * jolt, 0, 0);
    R(p, J.chest, 0.014 * jolt, 0, 0);
    R(p, J.head, 0.030 * jolt, 0.014 * jolt * side, 0);
    R(p, J.armR, 0.020 * jolt, 0, 0);
    p.rootAdd[0] += 0.008 * jolt;
    /* 머리가 마지막으로 옆으로 늘어진다 */
    const loll = smoothstep(seg(t, 0.20 + KNEEL_T * heavy + FALL_T, 0.20 + KNEEL_T * heavy + FALL_T + 0.7));
    R(p, J.head, 0.05 * loll, 0.22 * loll * side, 0.10 * loll);
    R(p, J.neck, 0.03 * loll, 0.10 * loll * side, 0);
    /* 시체가 된 뒤 아주 작은 근육 경련 (1.6~2.3초) */
    if (t > 1.6) {
      const tw = Math.exp(-(t - 1.6) * 2.6) * Math.sin((t - 1.6) * 21) * 0.012;
      R(p, J.handR, tw * 2, 0, tw);
      R(p, J.handL, -tw * 1.4, 0, 0);
      R(p, J.shinR, tw * 1.2, 0, 0);
    }
  }
}

/* ---------------------------------------------------------------------------
   메인 포즈 계산
   --------------------------------------------------------------------------- */
/* 보폭에 맞춘 걸음 위상 — 이동한 거리로 위상을 올려 발이 미끄러지지 않는다.
   (같은 속도면 같은 주기 · 느리게 걸으면 천천히, 뛰면 빠르게) */
export function stepWalk(u, dist) {
  if (!u || !(dist > 1e-5)) return;
  const sp = u.speed || 4;
  const stride = (0.95 + 0.115 * sp) * (u.cls === 'knight' ? 1.10 : u.cls === 'wizard' ? 0.88 : 1);
  u.walkPhase = ((u.walkPhase || 0) + (dist / stride) * Math.PI) % (Math.PI * 2);
}

export function computePose(u, t, dt) {
  const p = u.pose;
  const cls = u.cls;
  const s = CLASSES[cls] || CLASSES.soldier;
  const st = BODY[cls] || BODY.soldier;
  p.rot.fill(0);
  p.rootAdd[0] = 0; p.rootAdd[1] = 0; p.rootAdd[2] = 0;

  // 기본 자세
  const base = BASE[cls] || BASE.soldier;
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    R(p, J[b[0]], b[1], b[2], b[3]);
  }

  // 대기 호흡 · 무게 이동 · 무기 흔들림 (유닛마다 위상 다르게)
  const ph = u.animPhase || 0;
  const move = clamp(u.moveAmt || 0, 0, 1);
  applyIdle(p, cls, st, t, ph, move);

  // 낮은 자세 — 무게중심을 내리고 그만큼 무릎을 굽혀 발이 땅에 붙는다
  if (!u.dead) p.rootAdd[1] -= st.drop * (1 - move * 0.45);

  // 이동
  applyLocomotion(p, cls, u.walkPhase || 0, move, t);

  // 공격
  const attacking = u.attackT !== undefined && u.attackT >= 0;
  if (attacking) {
    const def = ATTACK[cls] || ATTACK.soldier;
    const cyc = u.cycle || s.cycle;          // 병종 기본 주기
    const norm = (u.attackT / Math.max(0.001, cyc)) * def.dur;
    if (norm <= def.dur) applyKeys(p, cls, Math.min(norm, def.dur));
  }

  // 피격 경직
  if (u.staggerT > 0) applyStagger(p, cls, u);

  // 시선 목표 (머리만 살짝)
  if (u.lookYaw) R(p, J.head, 0, clamp(u.lookYaw, -0.6, 0.6) * 0.55, 0);

  // 🛡️ 막기 자세 — AI 가 켜고 끌 때 자세가 순간이동하지 않도록 짧게 섞는다
  const guardTarget = u.guard && !u.dead ? 1 : 0;
  u._guardK = u._guardK === undefined ? guardTarget : u._guardK + (guardTarget - u._guardK) * Math.min(1, dt * 11);
  if (u._guardK > 0.002) blendSection(p, u._guardK, () => applyGuard(p, cls, t, ph, u));

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
