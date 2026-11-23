/* =============================================================================
   viewmodel.js — 1인칭 플레이어 손·무기 (검 / 큰 망치 / 지팡이)
   -----------------------------------------------------------------------------
   · 별도 씬에 그려 화면 앞에 또렷하게 (무기 끝이 지형에 파묻히지 않는다)
   · 예비동작 → 어깨·팔꿈치·손목 연동 → 대각선으로 묵직하게 → 팔로우스루
   · 무기 끝의 실제 궤적을 검기 리본으로 전달한다
   ============================================================================= */
import * as THREE from 'three';
import { glowTexture, woodMaps } from './textures.js';
import { clamp, lerp, smoothstep, easeOutCubic, mulberry32, TAU } from './util.js';
import { CLASSES, impactAt } from './config.js';

function matSteel() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xd6dbe4, metalness: 1, roughness: 0.24, envMapIntensity: 1.7,
    clearcoat: 0.5, clearcoatRoughness: 0.16
  });
}
function matDark() {
  return new THREE.MeshStandardMaterial({ color: 0x535a66, metalness: 1, roughness: 0.36, envMapIntensity: 1.3 });
}
function matGold() {
  return new THREE.MeshPhysicalMaterial({ color: 0xe0b45c, metalness: 1, roughness: 0.2, envMapIntensity: 1.9 });
}
function matLeather() {
  return new THREE.MeshStandardMaterial({ color: 0x4a3222, roughness: 0.78, metalness: 0.06, envMapIntensity: 0.4 });
}
function matCloth(hex) {
  return new THREE.MeshPhysicalMaterial({
    color: hex, roughness: 0.9, metalness: 0.02, sheen: 0.7, sheenRoughness: 0.6, envMapIntensity: 0.4
  });
}
function matSkin() {
  return new THREE.MeshStandardMaterial({ color: 0xd6a582, roughness: 0.62, metalness: 0, envMapIntensity: 0.4 });
}
function orbMat(hex, intensity) {
  return new THREE.MeshStandardMaterial({
    color: 0x0e2436, emissive: hex, emissiveIntensity: intensity || 2.4, roughness: 0.15, metalness: 0.1
  });
}

function box(w, h, d, mat, p, r) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  return m;
}
function cyl(rt, rb, h, mat, p, r, seg) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 14), mat);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  return m;
}
function sph(r, mat, p, sc) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (sc) m.scale.set(sc[0], sc[1], sc[2]);
  return m;
}
function capsule(r, len, mat, p, r2) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), mat);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (r2) m.rotation.set(r2[0], r2[1], r2[2]);
  return m;
}

/* 무기 그룹 — 손과 팔뚝까지 함께 묶는다 */
function buildSword(env) {
  const g = new THREE.Group();
  const steel = matSteel(), gold = matGold(), leather = matLeather();
  const cloth = matCloth(0x2b4a63);
  const grip = cyl(0.023, 0.026, 0.19, leather, [0, -0.045, 0]);
  g.add(grip);
  for (let i = 0; i < 5; i++) g.add(cyl(0.029, 0.029, 0.012, gold, [0, -0.12 + i * 0.04, 0]));
  g.add(box(0.24, 0.032, 0.045, gold, [0, 0.058, 0]));
  g.add(box(0.30, 0.018, 0.02, gold, [0, 0.058, 0], [0, 0, 0]));
  const blade = box(0.062, 0.92, 0.014, steel, [0, 0.56, 0]);
  g.add(blade);
  g.add(box(0.018, 0.86, 0.016, matDark(), [0, 0.55, 0]));
  // 칼끝
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 4), steel);
  tip.position.set(0, 1.09, 0); tip.rotation.y = Math.PI / 4; tip.scale.z = 0.32;
  g.add(tip);
  g.add(sph(0.045, gold, [0, -0.155, 0], [1, 0.9, 1]));
  // 오른 손 (건틀릿) + 팔뚝
  const gaunt = g;
  gaunt.add(box(0.105, 0.13, 0.115, matDark(), [0.0, -0.045, 0.02]));
  gaunt.add(box(0.125, 0.05, 0.10, matSteel(), [0.0, -0.105, 0.02]));
  for (let i = 0; i < 3; i++) gaunt.add(box(0.035, 0.03, 0.05, matDark(), [0.025 - i * 0.03, -0.02 - i * 0.005, 0.065]));
  // 팔뚝은 손목에서 화면 오른쪽 아래로
  const arm = new THREE.Group();
  arm.position.set(0.02, -0.16, 0.02);
  arm.rotation.set(0.35, -0.25, -0.55);
  arm.add(capsule(0.062, 0.30, cloth, [0, -0.16, 0]));
  arm.add(cyl(0.072, 0.062, 0.10, matSteel(), [0, -0.03, 0]));
  g.add(arm);
  return g;
}

function buildHammer(env) {
  const g = new THREE.Group();
  const steel = matSteel(), gold = matGold(), wood = new THREE.MeshStandardMaterial({ map: woodMaps().map, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.4 });
  const cloth = matCloth(0x5a2a28);
  g.add(cyl(0.036, 0.042, 1.78, wood, [0, 0.62, 0]));
  g.add(cyl(0.044, 0.044, 0.26, matLeather(), [0, 0.06, 0]));
  for (let i = 0; i < 6; i++) g.add(cyl(0.047, 0.047, 0.014, matDark(), [0, -0.05 + i * 0.05, 0]));
  // 머리
  const head = new THREE.Group();
  head.position.set(0, 1.52, 0);
  head.add(box(0.34, 0.30, 0.36, steel, [0, 0, 0]));
  head.add(box(0.40, 0.24, 0.10, steel, [0, 0, -0.22]));
  head.add(box(0.40, 0.24, 0.08, matDark(), [0, 0, 0.20]));
  head.add(box(0.10, 0.34, 0.40, gold, [0.18, 0, 0]));
  head.add(box(0.10, 0.34, 0.40, gold, [-0.18, 0, 0]));
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.34, 6), steel);
  spike.rotation.x = -Math.PI / 2; spike.position.set(0, 0, -0.42);
  head.add(spike);
  head.add(sph(0.06, gold, [0, 0.16, 0]));
  g.add(head);
  // 두 손
  g.add(box(0.13, 0.15, 0.14, matDark(), [0, 0.02, 0.01]));
  g.add(box(0.14, 0.05, 0.12, matSteel(), [0, -0.06, 0.01]));
  g.add(box(0.13, 0.15, 0.14, matDark(), [0, 0.36, 0.01]));
  g.add(box(0.14, 0.05, 0.12, matSteel(), [0, 0.29, 0.01]));
  const armR = new THREE.Group();
  armR.position.set(0.04, -0.08, 0.0);
  armR.rotation.set(0.4, -0.2, -0.6);
  armR.add(capsule(0.068, 0.30, cloth, [0, -0.17, 0]));
  g.add(armR);
  const armL = new THREE.Group();
  armL.position.set(-0.04, 0.28, 0.0);
  armL.rotation.set(0.25, 0.3, 0.8);
  armL.add(capsule(0.062, 0.26, cloth, [0, -0.15, 0]));
  g.add(armL);
  return g;
}

function buildStaff(env) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ map: woodMaps().map, color: 0x9a7a58, roughness: 0.85, metalness: 0.05, envMapIntensity: 0.4 });
  const gold = matGold();
  g.add(cyl(0.028, 0.036, 1.82, wood, [0, 0.35, 0]));
  // 덩굴 장식
  for (let i = 0; i < 6; i++) {
    const t = i / 6;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 14), gold);
    ring.position.set(0, -0.25 + t * 1.25, 0);
    ring.rotation.x = Math.PI / 2 + Math.sin(t * 6) * 0.2;
    g.add(ring);
  }
  const claw = new THREE.Group();
  claw.position.set(0, 1.24, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.26, 5), gold);
    c.position.set(Math.cos(a) * 0.10, 0.05, Math.sin(a) * 0.10);
    c.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    claw.add(c);
  }
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), orbMat(0x8fd8ff, 2.8));
  orb.position.y = 0.12;
  claw.add(orb);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255,255,255,1)', 'rgba(120,200,255,0.4)'),
    color: 0x9fdcff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9
  }));
  halo.scale.set(0.9, 0.9, 1);
  halo.position.y = 0.12;
  claw.add(halo);
  g.add(claw);
  g.userData.orb = orb;
  g.userData.halo = halo;
  // 왼 손
  g.add(box(0.115, 0.14, 0.12, matSkin(), [0, 0.02, 0.01]));
  const arm = new THREE.Group();
  arm.position.set(0.02, -0.09, 0.02);
  arm.rotation.set(0.4, 0.2, 0.75);
  arm.add(capsule(0.06, 0.30, matCloth(0x2a3f66), [0, -0.16, 0]));
  arm.add(cyl(0.075, 0.07, 0.16, matCloth(0x2a3f66), [0, 0.02, 0]));
  g.add(arm);
  return g;
}

function buildKatana() {
  const g = new THREE.Group();
  const steel = matSteel(), gold = matGold();
  const leather = matLeather();
  const cloth = matCloth(0x2a2f45);
  // 손잡이(감개)
  g.add(cyl(0.026, 0.028, 0.24, leather, [0, -0.06, 0]));
  for (let i = 0; i < 7; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 5, 10), matGold());
    r.position.set(0, -0.16 + i * 0.035, 0);
    r.rotation.x = Math.PI / 2;
    g.add(r);
  }
  // 츠바
  g.add(cyl(0.085, 0.085, 0.016, gold, [0, 0.068, 0]));
  // 날 (조금 휘어진 태도)
  const blade = new THREE.Group();
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const seg = box(0.042 - t * 0.008, 0.20, 0.010, steel, [0, 0.075 + 0.10 + i * 0.198, t * t * 0.02]);
    seg.rotation.z = 0.008 * i;
    blade.add(seg);
  }
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.13, 4), steel);
  tip.position.set(0, 1.12, 0.05); tip.rotation.y = Math.PI / 4; tip.scale.z = 0.3;
  blade.add(tip);
  g.add(blade);
  // 손 + 팔뚝
  g.add(box(0.10, 0.12, 0.11, matDark(), [0, -0.045, 0.01]));
  for (let i = 0; i < 3; i++) g.add(box(0.03, 0.028, 0.05, matDark(), [0.025 - i * 0.028, -0.02, 0.055]));
  const arm = new THREE.Group();
  arm.position.set(0.02, -0.14, 0.02);
  arm.rotation.set(0.35, -0.28, -0.6);
  arm.add(capsule(0.058, 0.30, cloth, [0, -0.16, 0]));
  arm.add(cyl(0.075, 0.07, 0.14, cloth, [0, 0.0, 0]));
  g.add(arm);
  return g;
}

function buildPalm() {
  const g = new THREE.Group();
  const skin = matSkin();
  g.add(box(0.13, 0.05, 0.16, skin, [0, 0, 0]));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.026, 0.035, 0.10, skin, [-0.042 + i * 0.028, 0.005, -0.11], [0.3, 0, 0]));
  }
  g.add(box(0.05, 0.035, 0.07, skin, [0.07, 0, -0.03], [0, 0.5, 0]));
  const arm = new THREE.Group();
  arm.position.set(0.02, -0.02, 0.05);
  arm.rotation.set(0.5, -0.3, -0.9);
  arm.add(capsule(0.058, 0.30, matCloth(0x2a3f66), [0, -0.16, 0]));
  arm.add(cyl(0.07, 0.065, 0.14, matCloth(0x2a3f66), [0, -0.02, 0]));
  g.add(arm);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), orbMat(0x8fd8ff, 2.6));
  orb.position.set(0, 0.03, -0.06);
  g.add(orb);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255,255,255,1)', 'rgba(130,205,255,0.42)'),
    color: 0xaee4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
  }));
  halo.scale.set(0.55, 0.55, 1);
  halo.position.copy(orb.position);
  g.add(halo);
  g.userData.orb = orb;
  g.userData.halo = halo;
  return g;
}

/* 무기별 키프레임 — p: 위치(뷰 공간), r: 오일러 회전 */
const CURVES = {
  soldier: {
    idle: { p: [0.33, -0.40, -0.60], r: [-0.28, -0.48, 0.34] },
    dur: 0.92,
    keys: [
      { t: 0.00, p: [0.33, -0.40, -0.60], r: [-0.28, -0.48, 0.34] },
      { t: 0.12, p: [0.38, -0.42, -0.55], r: [-0.10, -0.60, 0.22], ease: 'inout' },
      { t: 0.30, p: [0.46, -0.30, -0.62], r: [0.30, -0.95, -0.30], ease: 'out' },
      { t: 0.42, p: [0.06, -0.42, -0.78], r: [-0.75, 0.30, 1.28], ease: 'out' },
      { t: 0.56, p: [-0.14, -0.52, -0.66], r: [-0.95, 0.62, 1.85], ease: 'inout' },
      { t: 0.62, p: [0.02, -0.55, -0.62], r: [-0.72, 0.35, 1.30], ease: 'inout' },
      { t: 0.80, p: [0.20, -0.48, -0.58], r: [-0.42, -0.12, 0.62], ease: 'inout' },
      { t: 0.92, p: [0.33, -0.40, -0.60], r: [-0.28, -0.48, 0.34], ease: 'inout' }
    ]
  },
  knight: {
    idle: { p: [0.26, -0.52, -0.70], r: [-0.42, 0.12, -0.30] },
    dur: 1.72,
    keys: [
      { t: 0.00, p: [0.26, -0.52, -0.70], r: [-0.42, 0.12, -0.30] },
      { t: 0.18, p: [0.30, -0.46, -0.66], r: [-0.70, 0.20, -0.22], ease: 'inout' },
      { t: 0.60, p: [0.20, -0.10, -0.54], r: [-1.65, 0.16, -0.10], ease: 'out' },
      { t: 0.80, p: [0.06, -0.58, -1.16], r: [0.95, -0.05, 0.16], ease: 'out' },
      { t: 1.00, p: [0.06, -0.64, -1.12], r: [1.12, -0.02, 0.18], ease: 'inout' },
      { t: 1.24, p: [0.16, -0.58, -0.78], r: [0.30, 0.05, -0.05], ease: 'inout' },
      { t: 1.46, p: [0.22, -0.54, -0.72], r: [-0.18, 0.12, -0.20], ease: 'inout' },
      { t: 1.72, p: [0.26, -0.52, -0.70], r: [-0.42, 0.12, -0.30], ease: 'inout' }
    ]
  },
  blademaster: {
    idle: { p: [0.30, -0.44, -0.62], r: [-0.20, -0.55, 0.55] },
    dur: 0.80,
    keys: [
      { t: 0.00, p: [0.30, -0.44, -0.62], r: [-0.20, -0.55, 0.55] },
      { t: 0.10, p: [0.36, -0.40, -0.58], r: [0.05, -0.80, 0.30], ease: 'inout' },
      { t: 0.24, p: [0.42, -0.26, -0.66], r: [0.35, -1.05, -0.25], ease: 'out' },
      { t: 0.34, p: [0.04, -0.40, -0.82], r: [-0.80, 0.35, 1.45], ease: 'out' },
      { t: 0.46, p: [-0.16, -0.52, -0.68], r: [-1.00, 0.70, 2.05], ease: 'inout' },
      { t: 0.62, p: [0.14, -0.50, -0.60], r: [-0.60, 0.05, 1.00], ease: 'inout' },
      { t: 0.80, p: [0.30, -0.44, -0.62], r: [-0.20, -0.55, 0.55], ease: 'inout' }
    ]
  },
  wizard: {
    idle: { p: [-0.30, -0.62, -0.60], r: [-0.06, 0.10, 0.10] },
    dur: 1.06,
    keys: [
      { t: 0.00, p: [-0.30, -0.62, -0.60], r: [-0.06, 0.10, 0.10] },
      { t: 0.18, p: [-0.34, -0.56, -0.56], r: [-0.20, 0.16, 0.22], ease: 'inout' },
      { t: 0.34, p: [-0.26, -0.58, -0.66], r: [0.16, 0.02, -0.02], ease: 'out' },
      { t: 0.56, p: [-0.28, -0.60, -0.62], r: [0.06, 0.06, 0.04], ease: 'inout' },
      { t: 0.86, p: [-0.29, -0.615, -0.605], r: [0.0, 0.09, 0.07], ease: 'inout' },
      { t: 1.06, p: [-0.30, -0.62, -0.60], r: [-0.06, 0.10, 0.10], ease: 'inout' }
    ]
  }
};

/* 오른손(마법사는 손바닥) 키프레임 */
const PALM_KEYS = [
  { t: 0.00, p: [0.30, -0.44, -0.52], r: [0.10, -0.25, 0.0] },
  { t: 0.18, p: [0.34, -0.40, -0.44], r: [0.25, -0.45, 0.25], ease: 'inout' },
  { t: 0.34, p: [0.10, -0.30, -0.78], r: [-0.35, 0.05, 0.05], ease: 'out' },
  { t: 0.56, p: [0.20, -0.38, -0.64], r: [-0.10, -0.10, 0.05], ease: 'inout' },
  { t: 1.06, p: [0.30, -0.44, -0.52], r: [0.10, -0.25, 0.0] }
];

function sample(keys, t, outP, outR) {
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
  }
  let k = (t - a.t) / Math.max(0.0001, b.t - a.t);
  const e = b.ease || 'inout';
  k = e === 'out' ? easeOutCubic(k) : smoothstep(k);
  for (let i = 0; i < 3; i++) {
    outP[i] = lerp(a.p[i], b.p[i], k);
    outR[i] = lerp(a.r[i], b.r[i], k);
  }
}

export class ViewModel {
  constructor(renderer, mainScene, camera) {
    this.renderer = renderer;
    this.mainScene = mainScene;
    this.camera = camera;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(58, 1, 0.01, 12);
    this.cam.position.set(0, 0, 0);

    this.scene.environment = mainScene.environment;
    this.key = new THREE.DirectionalLight(0xffe2bc, 2.6);
    this.key.position.set(0.6, 1.2, 0.8);
    this.scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    this.fill.position.set(-1.2, 0.2, 0.6);
    this.scene.add(this.fill);
    this.rim = new THREE.DirectionalLight(0xff9a5a, 1.2);
    this.rim.position.set(0.2, -0.4, -1);
    this.scene.add(this.rim);
    this.scene.add(new THREE.AmbientLight(0x8fa0b8, 1.1));

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.inner = new THREE.Group();
    this.inner.scale.setScalar(0.48);
    this.root.add(this.inner);
    this.className = 'soldier';
    this.models = {
      soldier: buildSword(),
      knight: buildHammer(),
      wizard: buildStaff(),
      blademaster: buildKatana()
    };
    for (const k in this.models) {
      this.models[k].visible = false;
      this.inner.add(this.models[k]);
    }
    this.palm = buildPalm();
    this.palm.visible = false;
    this.palm.scale.setScalar(0.66);
    this.root.add(this.palm);

    this.castGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture('rgba(255,255,255,1)', 'rgba(150,215,255,0.45)'),
      color: 0xbfe8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
    }));
    this.castGlow.scale.set(1.6, 1.6, 1);
    this.scene.add(this.castGlow);

    this.time = 0;
    this.kick = 0;
    this.roll = 0;
    this.bob = 0;
    this.swapT = 1;
    this.enabled = true;
    this._p = [0, 0, 0];
    this._r = [0, 0, 0];
    this._p2 = [0, 0, 0];
    this._r2 = [0, 0, 0];
    this._castT = -1;
  }

  setClass(cls) {
    for (const k in this.models) this.models[k].visible = k === cls;
    this.className = cls;
    this.palm.visible = cls === 'wizard';
    this.swapT = 0;
    const cur = CURVES[cls];
    this.root.position.set(cur.idle.p[0], cur.idle.p[1], cur.idle.p[2]);
    this.root.rotation.set(cur.idle.r[0], cur.idle.r[1], cur.idle.r[2]);
    if (cls === 'wizard') {
      this.palm.position.set(0.30, -0.44, -0.52);
      this.palm.rotation.set(0.10, -0.25, 0.0);
    }
  }

  triggerCast() { this._castT = 0; }
  impulse(k) { this._imp = (this._imp || 0) + (k === undefined ? 0.05 : k); }

  update(dt, player, input, time) {
    this.time = time;
    const cur = CURVES[this.className] || CURVES.soldier;
    this.swapT = Math.min(1, this.swapT + dt * 3.4);
    const swap = easeOutCubic(this.swapT);

    const spr = CLASSES[this.className] || CLASSES.soldier;
    const atk = player && player.attackT >= 0 ? player.attackT * ((cur.dur || spr.animDur) / Math.max(0.001, spr.cycle)) : -1;
    let p = this._p, r = this._r;
    if (atk >= 0 && atk < cur.dur) {
      sample(cur.keys, atk, p, r);
    } else {
      p[0] = cur.idle.p[0]; p[1] = cur.idle.p[1]; p[2] = cur.idle.p[2];
      r[0] = cur.idle.r[0]; r[1] = cur.idle.r[1]; r[2] = cur.idle.r[2];
    }

    // 대기 흔들림 + 이동 흔들림
    const mv = player ? (player.moveAmt || 0) : 0;
    const ph = (player && player.walkPhase) || this.time * 1.5;
    const sway = Math.sin(this.time * 0.9) * 0.006 + Math.sin(this.time * 1.7) * 0.003;
    const walkX = Math.sin(ph) * 0.016 * mv;
    const walkY = Math.abs(Math.cos(ph)) * 0.018 * mv;
    this.bob = lerp(this.bob, walkY, Math.min(1, dt * 8));

    this.root.position.set(
      p[0] + sway + walkX,
      p[1] - this.bob,
      p[2] - 0.34
    );
    this.root.rotation.set(
      r[0] + Math.sin(this.time * 1.1) * 0.006 + walkY * 0.6,
      r[1] + sway * 1.4,
      r[2] + Math.sin(this.time * 0.7) * 0.008
    );
    // 클래스 교체 시 살짝 아래에서 올라온다
    this.root.position.y -= (1 - swap) * 0.34;
    this.root.position.z -= (1 - swap) * 0.2;

    // 타격 순간의 반동 — 무기가 적을 맞고 살짝 밀려 돌아온다
    let recoil = 0;
    if (player && player.attackT >= 0) {
      const impT = impactAt(this.className);
      if (player.attackT >= impT) {
        const cyc = (CLASSES[this.className] || CLASSES.soldier).cycle;
        const k = (player.attackT - impT) / Math.max(0.001, cyc - impT);
        recoil = Math.exp(-k * 7.5) * (this.className === 'knight' ? 0.085 : this.className === 'blademaster' ? 0.035 : 0.045);
      }
    }
    if (this._imp) {
      this.root.position.z += this._imp;
      this.root.rotation.x -= this._imp * 2;
      this._imp *= Math.max(0, 1 - dt * 12);
      if (this._imp < 0.001) this._imp = 0;
    }
    this.root.position.z += recoil * 0.6;
    this.root.position.y -= recoil * 0.25;
    this.root.rotation.x -= recoil * 0.5;

    // 마법사 손바닥
    if (this.className === 'wizard') {
      if (this._castT >= 0) {
        this._castT += dt;
        const t = this._castT;
        const k = clamp(t / 1.0, 0, 1);
        const tS = t * (1.06 / Math.max(0.3, spr.cycle));
        if (tS < 1.06) sample(PALM_KEYS, tS, this._p2, this._r2);
        else { this._p2[0] = 0.30; this._p2[1] = -0.44; this._p2[2] = -0.52; this._r2[0] = 0.10; this._r2[1] = -0.25; this._r2[2] = 0; }
        this.palm.position.set(this._p2[0] + sway, this._p2[1] - this.bob, this._p2[2]);
        this.palm.rotation.set(this._r2[0], this._r2[1], this._r2[2]);
        if (t > 1.1) this._castT = -1;
      } else {
        this.palm.position.set(0.30 + sway * 1.4 + walkX, -0.44 - this.bob + Math.sin(this.time * 1.3) * 0.005, -0.52);
        this.palm.rotation.set(0.10 + Math.sin(this.time * 1.1) * 0.03, -0.25 + Math.sin(this.time * 0.8) * 0.04, 0);
      }
      const orb = this.palm.userData.orb;
      const halo = this.palm.userData.halo;
      const pulse = 1 + Math.sin(this.time * 3.2) * 0.12;
      if (orb) orb.scale.setScalar(pulse);
      if (halo) { halo.scale.set(0.55 * pulse, 0.55 * pulse, 1); halo.material.opacity = 0.6 + Math.sin(this.time * 3.2) * 0.12; }
      const staff = this.models.wizard;
      if (staff.userData.orb) {
        const sPulse = 1 + Math.sin(this.time * 2.3 + 1) * 0.08;
        staff.userData.orb.scale.setScalar(sPulse);
        staff.userData.halo.scale.set(0.9 * sPulse, 0.9 * sPulse, 1);
      }
      // 시전 시 손바닥 앞 빛무리
      if (this._castT >= 0) {
        const t = this._castT;
        const g = Math.sin(clamp(t / 0.42, 0, 1) * Math.PI);
        this.castGlow.material.opacity = g * 0.75;
        this.castGlow.position.set(0.06, -0.28, -0.95);
        this.castGlow.scale.setScalar(0.7 + g * 1.2);
      } else this.castGlow.material.opacity *= Math.max(0, 1 - dt * 8);
    } else {
      this.castGlow.material.opacity *= Math.max(0, 1 - dt * 8);
    }
  }

  /* 무기 끝 궤적(월드 좌표) — 검기 리본용 */
  bladePoints(baseOut, tipOut) {
    if (!this.enabled) return false;
    const model = this.models[this.className];
    if (!model) return false;
    const h = this.className === 'knight' ? 1.62 : this.className === 'wizard' ? 1.2 : this.className === 'blademaster' ? 1.12 : 1.02;
    const b = h * 0.12;
    _v1.set(0, b, 0); model.localToWorld(_v1);
    _v2.set(0, h, 0); model.localToWorld(_v2);
    baseOut.copy(_v1).applyMatrix4(this.camera.matrixWorld);
    tipOut.copy(_v2).applyMatrix4(this.camera.matrixWorld);
    return true;
  }

  render(renderer, width, height) {
    if (this.cam.aspect !== width / height) {
      this.cam.aspect = width / height;
      this.cam.updateProjectionMatrix();
    }
    this.scene.updateMatrixWorld(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.cam);
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
