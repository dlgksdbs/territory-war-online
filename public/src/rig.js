/* =============================================================================
   rig.js — 유닛 3D 모델(병사·중갑 기사·대마법사) 과 InstancedMesh 렌더러
   -----------------------------------------------------------------------------
   · 관절 22개(골반·척추·가슴·목·머리·양팔 3관절·양다리 3관절) FK
   · 부위별 금속(강철·금장·흑철)·가죽·천(진영색)·로브·피부 재질 + PMREM 반사
   · 거리 3단 LOD: 근거리 전체 디테일 / 중거리 핵심 / 원거리 실루엣 1메시
   · 천(망토·로브·깃발)은 정점 셰이더 파형으로 살아있게 흔들린다
   ============================================================================= */
import * as THREE from 'three';
import { normalFromCanvas, makeCanvas, texFrom, woodMaps } from './textures.js';
import { clamp, lerp, mulberry32, TAU } from './util.js';
import { CLASSES, TEAM } from './config.js';

export const JOINT_NAMES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'shL', 'armL', 'elbL', 'handL',
  'shR', 'armR', 'elbR', 'handR',
  'hipL', 'thighL', 'shinL', 'footL',
  'hipR', 'thighR', 'shinR', 'footR'
];
export const J = JOINT_NAMES.reduce((o, n, i) => { o[n] = i; return o; }, {});
export const JOINT_COUNT = JOINT_NAMES.length;

/* 부모 · 관절 위치(부모 기준 로컬 오프셋) */
export const JOINTS = [
  { n: 'root', p: -1, o: [0, 0, 0] },
  { n: 'pelvis', p: 'root', o: [0, 0.92, 0] },
  { n: 'spine', p: 'pelvis', o: [0, 0.13, 0] },
  { n: 'chest', p: 'spine', o: [0, 0.17, 0] },
  { n: 'neck', p: 'chest', o: [0, 0.19, 0] },
  { n: 'head', p: 'neck', o: [0, 0.10, 0] },
  { n: 'shL', p: 'chest', o: [-0.185, 0.15, 0] },
  { n: 'armL', p: 'shL', o: [0, -0.02, 0] },
  { n: 'elbL', p: 'armL', o: [0, -0.29, 0] },
  { n: 'handL', p: 'elbL', o: [0, -0.27, 0] },
  { n: 'shR', p: 'chest', o: [0.185, 0.15, 0] },
  { n: 'armR', p: 'shR', o: [0, -0.02, 0] },
  { n: 'elbR', p: 'armR', o: [0, -0.29, 0] },
  { n: 'handR', p: 'elbR', o: [0, -0.27, 0] },
  { n: 'hipL', p: 'pelvis', o: [-0.105, -0.055, 0] },
  { n: 'thighL', p: 'hipL', o: [0, -0.02, 0] },
  { n: 'shinL', p: 'thighL', o: [0, -0.43, 0] },
  { n: 'footL', p: 'shinL', o: [0, -0.41, 0] },
  { n: 'hipR', p: 'pelvis', o: [0.105, -0.055, 0] },
  { n: 'thighR', p: 'hipR', o: [0, -0.02, 0] },
  { n: 'shinR', p: 'thighR', o: [0, -0.43, 0] },
  { n: 'footR', p: 'shinR', o: [0, -0.41, 0] }
];
export const JOINT_PARENT = JOINTS.map((j) => (j.p === -1 ? -1 : J[j.p]));
export const JOINT_OFFSET = JOINTS.map((j) => new THREE.Vector3(j.o[0], j.o[1], j.o[2]));

/* ---------------------------------------------------------------------------
   재질
   --------------------------------------------------------------------------- */
let MATS = null;
const clothShaders = [];

function metalNormalMap() {
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
  const rng = mulberry32(91);
  // 단조 흔적(망치 자국)
  for (let i = 0; i < 900; i++) {
    const px = rng() * S, py = rng() * S, rr = 2 + rng() * 7;
    const g = x.createRadialGradient(px - rr * 0.3, py - rr * 0.3, 0, px, py, rr);
    g.addColorStop(0, 'rgba(190,190,190,0.5)');
    g.addColorStop(1, 'rgba(120,120,120,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  // 스크래치
  for (let i = 0; i < 260; i++) {
    x.strokeStyle = `rgba(${rng() > 0.5 ? 200 : 90},${rng() > 0.5 ? 200 : 90},${rng() > 0.5 ? 200 : 90},0.5)`;
    x.lineWidth = 0.5 + rng() * 1.2;
    const px = rng() * S, py = rng() * S;
    x.beginPath(); x.moveTo(px, py);
    x.lineTo(px + (rng() - 0.5) * 40, py + (rng() - 0.5) * 10);
    x.stroke();
  }
  return texFrom(normalFromCanvas(c, 1.6), { srgb: false, repeat: 1 });
}

/* 직조(천) 노멀 — 가로·세로 실의 결이 은은하게 살아나 평면 느낌을 없앤다 */
let CLOTH_NORMAL = null;
function clothNormalMap() {
  if (CLOTH_NORMAL) return CLOTH_NORMAL;
  const S = 128;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
  const rng = mulberry32(17);
  for (let i = 0; i < S; i += 4) {
    x.fillStyle = `rgba(${150 + (i % 8 ? 14 : -18)},${150 + (i % 8 ? 14 : -18)},${150 + (i % 8 ? 14 : -18)},0.55)`;
    x.fillRect(0, i, S, 2);
    x.fillStyle = `rgba(${132 + rng() * 26},${132 + rng() * 26},${132 + rng() * 26},0.42)`;
    x.fillRect(i, 0, 2, S);
  }
  for (let i = 0; i < 260; i++) {
    const px = rng() * S, py = rng() * S;
    x.fillStyle = `rgba(${120 + rng() * 70},${120 + rng() * 70},${120 + rng() * 70},0.25)`;
    x.fillRect(px, py, 1 + rng() * 2, 1 + rng() * 2);
  }
  CLOTH_NORMAL = texFrom(normalFromCanvas(c, 1.1), { srgb: false, repeat: 1 });
  return CLOTH_NORMAL;
}

/* 가죽 결 노멀 — 벨트·장갑·부츠가 딱딱한 판처럼 보이지 않게 */
let LEATHER_NORMAL = null;
function leatherNormalMap() {
  if (LEATHER_NORMAL) return LEATHER_NORMAL;
  const S = 128;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
  const rng = mulberry32(23);
  for (let i = 0; i < 520; i++) {
    const px = rng() * S, py = rng() * S, rr = 1 + rng() * 3.4;
    const g = x.createRadialGradient(px, py, 0, px, py, rr);
    g.addColorStop(0, `rgba(${112 + rng() * 60},${112 + rng() * 60},${112 + rng() * 60},0.7)`);
    g.addColorStop(1, 'rgba(128,128,128,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  for (let i = 0; i < 90; i++) {
    x.strokeStyle = `rgba(${100 + rng() * 50},${100 + rng() * 50},${100 + rng() * 50},0.35)`;
    x.lineWidth = 0.6 + rng();
    const px = rng() * S, py = rng() * S;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + (rng() - 0.5) * 16, py + (rng() - 0.5) * 16); x.stroke();
  }
  LEATHER_NORMAL = texFrom(normalFromCanvas(c, 1.4), { srgb: false, repeat: 1 });
  return LEATHER_NORMAL;
}

function clothMaterial(color, opts) {
  const o = opts || {};
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: o.roughness === undefined ? 0.86 : o.roughness,
    metalness: 0.02,
    sheen: o.sheen === undefined ? 0.42 : o.sheen,
    sheenRoughness: 0.62,
    sheenColor: new THREE.Color(o.sheenColor === undefined ? 0xffffff : o.sheenColor),
    envMapIntensity: 0.34,
    normalMap: clothNormalMap(),
    normalScale: new THREE.Vector2(o.normalScale === undefined ? 0.32 : o.normalScale, o.normalScale === undefined ? 0.32 : o.normalScale),
    side: o.side || THREE.FrontSide
  });
  const uniforms = { uTime: { value: 0 }, uAmp: { value: o.wave === undefined ? 0.02 : o.wave } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uAmp = uniforms.uAmp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uAmp;')
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.63 + instanceMatrix[3][2] * 1.31;
          float amp2 = clamp(-transformed.y * 0.55 + 0.10, 0.0, 1.0) * uAmp;
          transformed.z += sin(uTime * 2.1 + ph + transformed.y * 2.6) * amp2 * 8.0;
          transformed.x += cos(uTime * 1.7 + ph + transformed.y * 2.2) * amp2 * 2.2;
        #endif
      `);
    clothShaders.push(shader);
  };
  return m;
}

function armorNormalMap() {
  /* 판금 표면 — 테두리 상자 없이(UV가 판마다 반복되므로 프레임처럼 보인다) 단조 자국·미세 요철만 */
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
  const rng = mulberry32(41);
  // 부드러운 곡면 음영(테두리로 갈수록 살짝 가라앉음)
  const g0 = x.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.62);
  g0.addColorStop(0, 'rgba(150,150,150,0.28)');
  g0.addColorStop(0.7, 'rgba(126,126,126,0.10)');
  g0.addColorStop(1, 'rgba(104,104,104,0.20)');
  x.fillStyle = g0; x.fillRect(0, 0, S, S);
  // 단조 자국(망치 면)
  for (let i = 0; i < 420; i++) {
    const px = rng() * S, py = rng() * S, rr = 3 + rng() * 9;
    const g = x.createRadialGradient(px - rr * 0.25, py - rr * 0.25, 0, px, py, rr);
    g.addColorStop(0, `rgba(${168 + rng() * 30},${168 + rng() * 30},${168 + rng() * 30},0.14)`);
    g.addColorStop(1, 'rgba(120,120,120,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  // 가는 긁힘
  for (let i = 0; i < 160; i++) {
    x.strokeStyle = `rgba(${150 + rng() * 70},${150 + rng() * 70},${150 + rng() * 70},0.22)`;
    x.lineWidth = 0.5 + rng() * 0.8;
    const px = rng() * S, py = rng() * S;
    x.beginPath(); x.moveTo(px, py);
    x.lineTo(px + (rng() - 0.5) * 34, py + (rng() - 0.5) * 8);
    x.stroke();
  }
  return texFrom(normalFromCanvas(c, 1.15), { srgb: false });
}

/* 부위별로 숨길 관절 — 절단되면 해당 파트를 인스턴스에서 감춘다 */
export const LIMB_MASK = { armL: 1, armR: 2, legL: 4, legR: 8, head: 16 };
export const JOINT_LIMB = (() => {
  const m = new Array(JOINT_COUNT).fill(0);
  m[J.armL] = LIMB_MASK.armL; m[J.elbL] = LIMB_MASK.armL; m[J.handL] = LIMB_MASK.armL;
  m[J.armR] = LIMB_MASK.armR; m[J.elbR] = LIMB_MASK.armR; m[J.handR] = LIMB_MASK.armR;
  m[J.thighL] = LIMB_MASK.legL; m[J.shinL] = LIMB_MASK.legL; m[J.footL] = LIMB_MASK.legL;
  m[J.thighR] = LIMB_MASK.legR; m[J.shinR] = LIMB_MASK.legR; m[J.footR] = LIMB_MASK.legR;
  m[J.head] = LIMB_MASK.head; m[J.neck] = LIMB_MASK.head;
  return m;
})();

function buildMaterials() {
  const mn = metalNormalMap();
  const an = armorNormalMap();
  const wood = woodMaps().map;
  const ln = leatherNormalMap();
  const M = {
    steel: new THREE.MeshPhysicalMaterial({
      color: 0x93a0b0, metalness: 0.66, roughness: 0.44, normalMap: an,
      normalScale: new THREE.Vector2(0.78, 0.78), envMapIntensity: 0.80,
      clearcoat: 0.12, clearcoatRoughness: 0.38
    }),
    darkSteel: new THREE.MeshPhysicalMaterial({
      color: 0x3f4754, metalness: 0.62, roughness: 0.52, normalMap: mn,
      normalScale: new THREE.Vector2(0.72, 0.72), envMapIntensity: 0.72,
      clearcoat: 0.08, clearcoatRoughness: 0.44
    }),
    blackIron: new THREE.MeshStandardMaterial({
      color: 0x262a32, metalness: 0.5, roughness: 0.58, envMapIntensity: 0.7
    }),
    gold: new THREE.MeshPhysicalMaterial({
      color: 0xd8a94f, metalness: 0.9, roughness: 0.27, envMapIntensity: 1.08, normalMap: mn,
      normalScale: new THREE.Vector2(0.30, 0.30),
      clearcoat: 0.18, clearcoatRoughness: 0.28
    }),
    bronze: new THREE.MeshStandardMaterial({
      color: 0xab7b3d, metalness: 0.82, roughness: 0.38, envMapIntensity: 1.15
    }),
    leather: new THREE.MeshStandardMaterial({
      color: 0x513824, roughness: 0.74, metalness: 0.06, envMapIntensity: 0.5,
      normalMap: ln, normalScale: new THREE.Vector2(0.55, 0.55)
    }),
    darkLeather: new THREE.MeshStandardMaterial({
      color: 0x241a13, roughness: 0.66, metalness: 0.1, envMapIntensity: 0.5,
      normalMap: ln, normalScale: new THREE.Vector2(0.5, 0.5)
    }),
    skin: new THREE.MeshStandardMaterial({
      color: 0xa9785a, roughness: 0.66, metalness: 0.0, envMapIntensity: 0.38
    }),
    cloth: clothMaterial(0xffffff, { wave: 0.012, roughness: 0.9 }),
    clothHeavy: clothMaterial(0xffffff, { wave: 0.02, roughness: 0.86, sheenColor: 0xbfd8ff }),
    robe: clothMaterial(0xffffff, { wave: 0.026, roughness: 0.82, sheenColor: 0xa8d8ff }),
    kimono: clothMaterial(0xffffff, { wave: 0.02, roughness: 0.78, sheenColor: 0xffe6f2 }),
    cape: clothMaterial(0xffffff, { wave: 0.03, roughness: 0.85, side: THREE.DoubleSide }),
    plume: clothMaterial(0xffffff, { wave: 0.05, roughness: 0.9, sheenColor: 0xffffff }),
    wood: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.82, metalness: 0.06, envMapIntensity: 0.35 }),
    woodDark: new THREE.MeshStandardMaterial({ map: wood, color: 0x8a7360, roughness: 0.85, metalness: 0.05 }),
    eye: new THREE.MeshBasicMaterial({ color: 0xbfe9ff }),
    orb: new THREE.MeshStandardMaterial({
      color: 0x1a3a6a, emissive: 0x8fd8ff, emissiveIntensity: 2.6, roughness: 0.12,
      metalness: 0.1, envMapIntensity: 1.4
    }),
    orbFire: new THREE.MeshStandardMaterial({
      color: 0x3a1a08, emissive: 0xff9a40, emissiveIntensity: 2.4, roughness: 0.2, metalness: 0.1
    }),
    rune: new THREE.MeshBasicMaterial({
      color: 0x9fdcff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    }),
    silhouette: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.82, metalness: 0.04, envMapIntensity: 0.72
    }),
    /* 원거리 실루엣의 금속부(투구·견갑·무기) — 천과 다른 재질로 나눠 입체감을 준다 */
    silhouetteSteel: new THREE.MeshStandardMaterial({
      color: 0xc6cfda, roughness: 0.44, metalness: 0.52, envMapIntensity: 1.05
    }),
    /* 🩸 잘린 단면 — 젖은 살점·피 */
    blood: new THREE.MeshStandardMaterial({
      color: 0x5e0b10, roughness: 0.36, metalness: 0.05, envMapIntensity: 1.0,
      emissive: 0x2a0305, emissiveIntensity: 0.5
    }),
    /* 단면 가운데 비치는 뼈 */
    bone: new THREE.MeshStandardMaterial({ color: 0xd6c6a6, roughness: 0.72, metalness: 0.02, envMapIntensity: 0.5 })
  };
  return M;
}

/* ---------------------------------------------------------------------------
   지오메트리 조합 도구
   --------------------------------------------------------------------------- */
const GEO = {};
function unitGeo(kind) {
  if (GEO[kind]) return GEO[kind];
  let g;
  switch (kind) {
    case 'box': g = new THREE.BoxGeometry(1, 1, 1); break;
    case 'cyl': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1); break;
    case 'cyl6': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1); break;
    case 'cone': g = new THREE.ConeGeometry(0.5, 1, 10, 1); break;
    case 'cone6': g = new THREE.ConeGeometry(0.5, 1, 6, 1); break;
    case 'sph': g = new THREE.SphereGeometry(0.5, 12, 8); break;
    case 'sphLow': g = new THREE.SphereGeometry(0.5, 8, 6); break;
    case 'dome': g = new THREE.SphereGeometry(0.5, 12, 7, 0, TAU, 0, Math.PI * 0.55); break;
    case 'domeLow': g = new THREE.SphereGeometry(0.5, 8, 4, 0, TAU, 0, Math.PI * 0.55); break;
    case 'cap': g = new THREE.CapsuleGeometry(0.5, 1, 3, 8); break;
    case 'blimb': g = new THREE.CylinderGeometry(0.5, 0.5, 2, 6, 1); break;   // 실루엣 팔다리(저폴리)
    case 'torusLow': g = new THREE.TorusGeometry(0.5, 0.09, 4, 8); break;
    case 'plane': g = new THREE.PlaneGeometry(1, 1); break;
    case 'planeV': g = new THREE.PlaneGeometry(1, 1, 6, 8); break;
    case 'torus': g = new THREE.TorusGeometry(0.5, 0.09, 6, 12); break;
    default: g = new THREE.BoxGeometry(1, 1, 1);
  }
  GEO[kind] = g;
  return g;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

function shape(kind, p, r, s) {
  return { kind, p: p || [0, 0, 0], r: r || [0, 0, 0], s: s || [1, 1, 1] };
}

/* 모양들을 하나의 지오메트리로 합친다 (비인덱스 변환 후 정점 이어붙이기) */
function mergeShapes(shapes) {
  let total = 0;
  const parts = [];
  for (const sh of shapes) {
    const src = unitGeo(sh.kind);
    const g = src.clone();
    _e.set(sh.r[0], sh.r[1], sh.r[2]);
    _q.setFromEuler(_e);
    _v.set(sh.p[0], sh.p[1], sh.p[2]);
    _s.set(sh.s[0], sh.s[1], sh.s[2]);
    _m4.compose(_v, _q, _s);
    g.applyMatrix4(_m4);
    const ng = g.index ? g.toNonIndexed() : g;
    parts.push(ng);
    total += ng.attributes.position.count;
  }
  const posA = new Float32Array(total * 3);
  const norA = new Float32Array(total * 3);
  const uvA = new Float32Array(total * 2);
  let o3 = 0, o2 = 0;
  for (const g of parts) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal ? g.attributes.normal.array : null;
    const u = g.attributes.uv ? g.attributes.uv.array : null;
    posA.set(p, o3);
    if (n) norA.set(n, o3);
    if (u) uvA.set(u, o2);
    o3 += p.length; o2 += u ? u.length : (p.length / 3) * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norA, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
  out.computeBoundingSphere();
  return out;
}

/* ---------------------------------------------------------------------------
   클래스별 파츠 정의
   part: { joint, mat, lod, shapes, spin? }
   lod: 0 = 항상(근거리), 1 = 40m 이내, 2 = 16m 이내
   --------------------------------------------------------------------------- */
function soldierParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 몸통: 천 튜닉 위에 강철 흉갑을 겹쳐 입는다 ───────────────── */
  add('chest', 'clothHeavy', 1, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.40, 0.36, 0.245]),         // 둥근 튜닉
    shape('sph', [0, 0.15, 0], [0, 0, 0], [0.34, 0.17, 0.24]),          // 어깨 곡면
    shape('box', [0.195, 0.04, 0], [0, 0, -0.10], [0.09, 0.26, 0.23]),  // 옆구리 천
    shape('box', [-0.195, 0.04, 0], [0, 0, 0.10], [0.09, 0.26, 0.23])
  ]);
  add('chest', 'steel', 0, [
    shape('sph', [0, 0.05, 0.015], [0, 0, 0], [0.405, 0.345, 0.315]),    // 가슴 곡면(조금 납작하게)
    shape('sph', [0, -0.085, 0.005], [0, 0, 0], [0.365, 0.20, 0.30]),     // 아래 겹판(배)
    shape('cyl', [0, 0.185, 0.01], [0, 0, 0], [0.235, 0.065, 0.215]),     // 목 가드
    shape('box', [0, 0.06, 0.185], [0, 0, 0], [0.028, 0.20, 0.03]),       // 중앙 능선
    shape('box', [0, -0.185, 0.13], [0.10, 0, 0], [0.30, 0.05, 0.05]),    // 허리 판 테
    shape('box', [-0.178, 0.02, 0.01], [0, 0, 0.14], [0.062, 0.25, 0.31]), // 겨드랑이 판
    shape('box', [0.178, 0.02, 0.01], [0, 0, -0.14], [0.062, 0.25, 0.31])
  ]);
  add('chest', 'gold', 2, [
    shape('sphLow', [-0.125, 0.125, 0.19], [0, 0, 0], [0.026, 0.026, 0.016]),  // 리벳
    shape('sphLow', [0.125, 0.125, 0.19], [0, 0, 0], [0.026, 0.026, 0.016]),
    shape('sphLow', [-0.115, 0.01, 0.19], [0, 0, 0], [0.022, 0.022, 0.014]),
    shape('sphLow', [0.115, 0.01, 0.19], [0, 0, 0], [0.022, 0.022, 0.014]),
    shape('box', [0, 0.185, 0.13], [0.30, 0, 0], [0.24, 0.014, 0.02])       // 목 가드 금선
  ]);
  add('spine', 'steel', 1, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.35, 0.19, 0.25]),           // 복갑
  ]);
  add('spine', 'clothHeavy', 2, [
    shape('cyl', [0, -0.04, 0], [0, 0, 0], [0.38, 0.15, 0.27])
  ]);
  add('pelvis', 'steel', 1, [
    shape('cyl', [0, 0.08, 0.005], [0.03, 0, 0], [0.385, 0.055, 0.28]),   // 허리 겹판(상)
    shape('cyl', [0, 0.03, 0.008], [0.05, 0, 0], [0.40, 0.055, 0.295])    // 허리 겹판(하)
  ]);
  add('pelvis', 'leather', 1, [
    shape('box', [0, -0.012, 0], [0, 0, 0], [0.38, 0.075, 0.27]),         // 벨트
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [0, 0.02, 0.135], [0, 0, 0], [0.07, 0.07, 0.03]),       // 버클
  ]);
  add('pelvis', 'steel', 2, [
    shape('box', [-0.15, -0.09, 0.10], [0, 0, 0.12], [0.13, 0.18, 0.05]), // 허벅지 판
    shape('box', [0.15, -0.09, 0.10], [0, 0, -0.12], [0.13, 0.18, 0.05])
  ]);
  add('pelvis', 'clothHeavy', 0, [
    shape('box', [0, -0.14, 0.115], [0.06, 0, 0], [0.26, 0.28, 0.035]),   // 앞자락
    shape('box', [0, -0.14, -0.115], [-0.06, 0, 0], [0.26, 0.28, 0.035]), // 뒷자락
    shape('box', [-0.165, -0.13, 0], [0, 0, 0.10], [0.035, 0.26, 0.20]),  // 옆자락
    shape('box', [0.165, -0.13, 0], [0, 0, -0.10], [0.035, 0.26, 0.20])
  ]);

  /* ── 머리: 철 투구(챙 · 코가드 · 눈구멍) + 목덜미 천 ───────────── */
  add('head', 'skin', 1, [
    shape('sph', [0, 0.05, 0.008], [0, 0, 0], [0.185, 0.20, 0.185]),     // 얼굴
    shape('box', [0, -0.02, 0.075], [0, 0, 0], [0.085, 0.05, 0.03])       // 턱
  ]);
  /* 면갑 — 눈 틈만 남기고 아래 얼굴을 철판으로 덮는다 */
  add('head', 'steel', 0, [
    shape('box', [0, -0.005, 0.108], [0.06, 0, 0], [0.205, 0.115, 0.055]),
    shape('box', [0, -0.065, 0.09], [0.16, 0, 0], [0.185, 0.06, 0.05]),
    shape('box', [0, -0.02, 0.146], [0.06, 0, 0], [0.028, 0.16, 0.03])    // 코 능선
  ]);
  add('head', 'steel', 0, [
    shape('dome', [0, 0.082, -0.004], [0, 0, 0], [0.245, 0.285, 0.25]),   // 투구 통
    shape('cyl', [0, 0.148, 0.006], [0.06, 0, 0], [0.264, 0.02, 0.264]),  // 챙(투구 테)
    shape('cyl', [0, 0.048, 0], [0, 0, 0], [0.252, 0.026, 0.252]),        // 이마 굽은 테
    shape('box', [0, 0.0, 0.112], [0.06, 0, 0], [0.03, 0.15, 0.035]),     // 코가드
    shape('box', [-0.118, 0.03, 0.05], [0, 0.28, 0], [0.045, 0.15, 0.11]),// 볼가리개
    shape('box', [0.118, 0.03, 0.05], [0, -0.28, 0], [0.045, 0.15, 0.11]),
    shape('box', [0, 0.225, -0.012], [0.10, 0, 0], [0.028, 0.075, 0.13])  // 정수리 능선
  ]);
  add('head', 'blackIron', 1, [
    shape('box', [0, 0.085, 0.122], [0, 0, 0], [0.165, 0.032, 0.02]),         // 눈 슬릿
    shape('box', [0, 0.045, 0.126], [0.1, 0, 0], [0.13, 0.016, 0.016]),       // 콧등 그늘
    shape('box', [0, 0.03, 0.075], [0, 0, 0], [0.17, 0.14, 0.12])             // 투구 속 그늘
  ]);
  add('head', 'gold', 2, [
    shape('cyl', [0, 0.157, 0.006], [0.06, 0, 0], [0.266, 0.008, 0.266])  // 챙 금장 테
  ]);
  add('head', 'darkSteel', 1, [
    shape('box', [0, 0.255, -0.03], [0.22, 0, 0], [0.03, 0.06, 0.15])      // 볏등
  ]);
  add('head', 'cloth', 2, [
    shape('box', [0, 0.0, -0.10], [0.24, 0, 0], [0.20, 0.15, 0.06])       // 목덜미 천
  ]);

  /* ── 어깨·팔: 겹판 견갑 ──────────────────────────────────────── */
  add('armR', 'steel', 0, [
    shape('sph', [0.02, 0.02, 0], [0, 0, 0.1], [0.245, 0.20, 0.245]),      // 견갑(총)
    shape('sphLow', [0.028, -0.05, 0], [0, 0, 0.1], [0.215, 0.08, 0.22]),  // 2단 판
    shape('sphLow', [0.032, -0.11, 0], [0, 0, 0.08], [0.195, 0.065, 0.20]), // 3단 판
    shape('box', [0.015, -0.02, 0], [0, 0, 0.06], [0.19, 0.045, 0.20])      // 견갑 테
  ]);
  add('armR', 'gold', 2, [
    shape('sph', [0.02, 0.09, 0.02], [0, 0, 0], [0.05, 0.05, 0.04])        // 견갑 장식못
  ]);
  add('armR', 'cloth', 1, [
    shape('cap', [0, -0.15, 0], [0, 0, 0], [0.135, 0.26, 0.135])          // 상완 소매
  ]);
  add('armR', 'steel', 2, [
    shape('cyl', [0, -0.29, 0], [0, 0, 0], [0.13, 0.06, 0.13])            // 팔꿈치
  ]);
  add('elbR', 'steel', 0, [
    shape('cyl', [0, -0.115, 0], [0, 0, 0], [0.115, 0.24, 0.11]),         // 팔뚝 갑옷
    shape('cyl', [0, -0.235, 0], [0, 0, 0], [0.105, 0.04, 0.10])          // 손목 테
  ]);
  add('elbR', 'leather', 2, [
    shape('cyl', [0, 0.005, 0], [0, 0, 0], [0.12, 0.05, 0.115])
  ]);
  add('handR', 'leather', 1, [
    shape('box', [0, -0.05, 0.005], [0, 0, 0], [0.085, 0.105, 0.10])      // 장갑
  ]);
  add('handR', 'steel', 2, [
    shape('box', [0, -0.04, 0.05], [0, 0, 0], [0.075, 0.05, 0.03])
  ]);
  add('armL', 'steel', 0, [
    shape('sph', [-0.02, 0.02, 0], [0, 0, -0.1], [0.245, 0.20, 0.245]),
    shape('sphLow', [-0.028, -0.05, 0], [0, 0, -0.1], [0.215, 0.08, 0.22]),
    shape('sphLow', [-0.032, -0.11, 0], [0, 0, -0.08], [0.195, 0.065, 0.20]),
    shape('box', [-0.015, -0.02, 0], [0, 0, -0.06], [0.19, 0.045, 0.20])
  ]);
  add('armL', 'cloth', 1, [
    shape('cap', [0, -0.15, 0], [0, 0, 0], [0.135, 0.26, 0.135])
  ]);
  add('elbL', 'steel', 0, [
    shape('cyl', [0, -0.115, 0], [0, 0, 0], [0.115, 0.24, 0.11]),
    shape('cyl', [0, -0.235, 0], [0, 0, 0], [0.105, 0.04, 0.10])
  ]);
  add('handL', 'leather', 1, [
    shape('box', [0, -0.05, 0.005], [0, 0, 0], [0.085, 0.105, 0.10])
  ]);

  /* ── 다리 ────────────────────────────────────────────────────── */
  const leg = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('thigh' + side, 'cloth', 1, [
      shape('cap', [0, -0.20, 0], [0, 0, 0], [0.17, 0.34, 0.17])
    ]);
    add('thigh' + side, 'steel', 2, [
      shape('box', [0.02 * sx, -0.13, 0.05], [0, 0, 0.10 * sx], [0.12, 0.18, 0.05])
    ]);
    add('shin' + side, 'steel', 0, [
      shape('cyl', [0, -0.13, 0], [0, 0, 0], [0.135, 0.32, 0.125]),        // 정강이 갑옷
      shape('sph', [0, 0.015, 0.035], [0, 0, 0], [0.17, 0.13, 0.17])       // 무릎
    ]);
    add('shin' + side, 'leather', 2, [
      shape('cyl', [0, -0.28, 0], [0, 0, 0], [0.13, 0.05, 0.12])
    ]);
    add('shin' + side, 'leather', 0, [
      shape('cyl', [0, -0.36, 0.005], [0, 0, 0], [0.115, 0.14, 0.115]),      // 발목 통
      shape('cyl', [0, -0.40, 0.02], [0.35, 0, 0], [0.105, 0.07, 0.105])     // 복사뼈
    ]);
    add('foot' + side, 'leather', 1, [
      shape('box', [0, -0.01, 0.035], [0, 0, 0], [0.135, 0.115, 0.27]),       // 부츠
      shape('sph', [0, 0.045, -0.01], [0, 0, 0], [0.135, 0.10, 0.135]),       // 발등 곡면
      shape('box', [0, -0.055, 0.035], [0, 0, 0], [0.142, 0.03, 0.285])       // 밑창
    ]);
    add('foot' + side, 'steel', 2, [
      shape('box', [0, -0.03, 0.13], [0, 0, 0], [0.115, 0.07, 0.10])
    ]);
  };
  leg('R'); leg('L');

  /* ── 어깨 망토(짧은 어깨 천) — 실루엣에 진영색을 한 겹 더 ────── */
  add('chest', 'clothHeavy', 1, [
    shape('box', [0, 0.175, -0.02], [0.03, 0, 0], [0.46, 0.06, 0.30]),     // 어깨 덮개
    shape('planeV', [0, -0.10, -0.175], [0.12, 0, 0], [0.42, 0.46, 1])    // 등 망토 자락
  ]);

  /* ── 검 ──────────────────────────────────────────────────────── */
  add('handR', 'darkLeather', 1, [
    shape('cyl', [0, 0, -0.06], [Math.PI / 2, 0, 0], [0.052, 0.17, 0.052])  // 손잡이
  ]);
  add('handR', 'gold', 0, [
    shape('sph', [0, 0, -0.155], [0, 0, 0], [0.062, 0.062, 0.055]),        // 폼멜
    shape('box', [0, 0, 0.032], [0, 0, 0], [0.245, 0.032, 0.046]),          // 가드
    shape('cyl', [0, 0, 0.012], [Math.PI / 2, 0, 0], [0.05, 0.05, 0.02]),   // 가드 목
    shape('box', [-0.118, 0, 0.048], [0, 0, 0.42], [0.06, 0.028, 0.038]),   // 가드 끝 굽힘
    shape('box', [0.118, 0, 0.048], [0, 0, -0.42], [0.06, 0.028, 0.038]),
    shape('sphLow', [-0.145, 0, 0.058], [0, 0, 0], [0.032, 0.032, 0.024]), // 가드 끝 장식
    shape('sphLow', [0.145, 0, 0.058], [0, 0, 0], [0.032, 0.032, 0.024])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 0.21], [0, 0, 0], [0.068, 0.019, 0.36]),            // 날(뿌리)
    shape('box', [0, 0, 0.57], [0, 0, 0], [0.060, 0.017, 0.38]),            // 날(중간)
    shape('box', [0, 0, 0.86], [0, 0, 0], [0.048, 0.015, 0.24]),            // 날(끝)
    shape('cone6', [0, 0, 1.02], [Math.PI / 2, 0, 0], [0.054, 0.16, 0.032]) // 칼끝
  ]);
  add('handR', 'darkSteel', 2, [
    shape('box', [0, 0, 0.52], [0, 0, 0], [0.012, 0.024, 0.76]),            // 혈조
    shape('box', [0, -0.004, 0.20], [0, 0, 0], [0.043, 0.008, 0.16])        // 리카쏘
  ]);
  /* 칼집 — 왼쪽 허리에 납작하게 붙어 아래로 늘어진다 */
  add('pelvis', 'darkLeather', 1, [
    shape('box', [-0.225, -0.22, -0.03], [0.16, 0.10, 0.10], [0.034, 0.20, 0.045])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [-0.225, -0.38, -0.055], [0.16, 0.10, 0.10], [0.038, 0.05, 0.05])
  ]);
  return P;
}

function eliteParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 몸통: 진영색 군의(군복 자락) 위에 금장 흉갑 — 병사와 확실히 다른 중후한 상체 ── */
  add('chest', 'clothHeavy', 0, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.42, 0.38, 0.27]),
    shape('sph', [0, 0.16, 0], [0, 0, 0], [0.36, 0.19, 0.26]),
    shape('box', [0.2, 0.04, 0], [0, 0, -0.10], [0.10, 0.28, 0.25]),
    shape('box', [-0.2, 0.04, 0], [0, 0, 0.10], [0.10, 0.28, 0.25])
  ]);
  add('chest', 'steel', 0, [
    shape('sph', [0, 0.05, 0.02], [0, 0, 0], [0.425, 0.355, 0.325]),     // 둥근 흉갑
    shape('sph', [0, -0.09, 0.005], [0, 0, 0], [0.385, 0.21, 0.305]),    // 아래 겹판
    shape('cyl', [0, 0.195, 0.01], [0, 0, 0], [0.25, 0.075, 0.23]),      // 목 가드(지고)
    shape('box', [0, 0.05, 0.198], [0, 0, 0], [0.03, 0.20, 0.03]),       // 중앙 능선
    shape('box', [-0.185, 0.02, 0.01], [0, 0, 0.14], [0.065, 0.25, 0.31]), // 겨드랑이 판
    shape('box', [0.185, 0.02, 0.01], [0, 0, -0.14], [0.065, 0.25, 0.31]),
    shape('cyl', [0, -0.13, 0.005], [0.06, 0, 0], [0.40, 0.07, 0.30])     // 허리 겹판
  ]);
  add('chest', 'gold', 1, [
    shape('sph', [0, 0.10, 0.215], [0, 0, 0], [0.075, 0.085, 0.02]),     // 문장(메달)
    shape('box', [0, 0.10, 0.222], [0, 0, 0.5], [0.115, 0.022, 0.014]),
    shape('box', [0, 0.198, 0.14], [0.30, 0, 0], [0.26, 0.018, 0.022]),   // 지고 금선
    shape('sph', [-0.135, 0.14, 0.20], [0, 0, 0], [0.03, 0.03, 0.018]),
    shape('sph', [0.135, 0.14, 0.20], [0, 0, 0], [0.03, 0.03, 0.018]),
    shape('sph', [-0.12, 0.0, 0.20], [0, 0, 0], [0.024, 0.024, 0.016]),
    shape('sph', [0.12, 0.0, 0.20], [0, 0, 0], [0.024, 0.024, 0.016])
  ]);
  add('spine', 'steel', 1, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.37, 0.20, 0.26])
  ]);
  add('spine', 'gold', 2, [
    shape('box', [0, -0.05, 0.145], [0.1, 0, 0], [0.30, 0.02, 0.02])
  ]);
  add('pelvis', 'steel', 1, [
    shape('cyl', [0, 0.085, 0.005], [0.03, 0, 0], [0.40, 0.06, 0.29]),
    shape('cyl', [0, 0.03, 0.008], [0.05, 0, 0], [0.415, 0.06, 0.305]),
    shape('box', [-0.155, -0.10, 0.10], [0, 0, 0.12], [0.135, 0.19, 0.055]),  // 허벅지 판
    shape('box', [0.155, -0.10, 0.10], [0, 0, -0.12], [0.135, 0.19, 0.055])
  ]);
  add('pelvis', 'leather', 1, [
    shape('box', [0, -0.012, 0], [0, 0, 0], [0.395, 0.08, 0.28])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [0, 0.02, 0.142], [0, 0, 0], [0.08, 0.075, 0.032])       // 버클
  ]);
  add('pelvis', 'clothHeavy', 0, [
    shape('box', [0, -0.16, 0.118], [0.06, 0, 0], [0.28, 0.30, 0.035]),    // 앞자락
    shape('box', [0, -0.16, -0.118], [-0.06, 0, 0], [0.28, 0.30, 0.035]),  // 뒷자락
    shape('box', [-0.175, -0.15, 0], [0, 0, 0.10], [0.04, 0.28, 0.21]),
    shape('box', [0.175, -0.15, 0], [0, 0, -0.10], [0.04, 0.28, 0.21])
  ]);
  add('pelvis', 'gold', 1, [
    shape('box', [0, -0.30, 0.122], [0.06, 0, 0], [0.26, 0.018, 0.014]),  // 자락 금선
    shape('box', [0, -0.30, -0.122], [-0.06, 0, 0], [0.26, 0.018, 0.014])
  ]);

  /* ── 머리: 금장 투구 + 높은 볏(crest) — 멀리서도 고급 병사로 읽힌다 ── */
  add('head', 'skin', 1, [
    shape('sph', [0, 0.05, 0.008], [0, 0, 0], [0.185, 0.20, 0.185])
  ]);
  add('head', 'steel', 0, [
    shape('box', [0, -0.005, 0.112], [0.06, 0, 0], [0.21, 0.12, 0.055]),
    shape('box', [0, -0.07, 0.092], [0.16, 0, 0], [0.19, 0.06, 0.05])
  ]);
  add('head', 'steel', 0, [
    shape('dome', [0, 0.085, -0.004], [0, 0, 0], [0.255, 0.30, 0.26]),     // 투구 통
    shape('cyl', [0, 0.155, 0.006], [0.06, 0, 0], [0.272, 0.022, 0.272]),  // 챙
    shape('box', [0, 0.0, 0.118], [0.06, 0, 0], [0.032, 0.16, 0.04]),      // 코가드
    shape('box', [-0.122, 0.03, 0.05], [0, 0.3, 0], [0.05, 0.16, 0.12]),   // 볼가리개
    shape('box', [0.122, 0.03, 0.05], [0, -0.3, 0], [0.05, 0.16, 0.12]),
    shape('box', [0, 0.245, -0.02], [0.06, 0, 0], [0.026, 0.10, 0.20])     // 볏대
  ]);
  add('head', 'blackIron', 1, [
    shape('box', [0, 0.09, 0.128], [0, 0, 0], [0.17, 0.03, 0.02])          // 눈 슬릿
  ]);
  add('head', 'gold', 0, [
    shape('cyl', [0, 0.163, 0.006], [0.06, 0, 0], [0.274, 0.01, 0.274]),   // 챙 금장 테
    shape('box', [0, 0.30, -0.02], [0.06, 0, 0], [0.03, 0.09, 0.055]),     // 볏 고정쇠
    shape('box', [0, 0.035, 0.122], [0, 0, 0], [0.032, 0.10, 0.022])       // 코가드 금선
  ]);
  add('head', 'plume', 1, [
    shape('box', [0, 0.36, -0.06], [0.24, 0, 0], [0.065, 0.15, 0.22]),     // 볏 깃(진영색)
    shape('box', [0, 0.42, -0.19], [0.74, 0, 0], [0.05, 0.08, 0.16])
  ]);

  /* ── 어깨·팔: 3겹 견갑 + 금테 ── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'steel', 0, [
      shape('sph', [0.02 * sx, 0.03, 0], [0, 0, 0.1 * sx], [0.275, 0.23, 0.275]),
      shape('sphLow', [0.03 * sx, -0.045, 0], [0, 0, 0.1 * sx], [0.24, 0.09, 0.24]),
      shape('sphLow', [0.035 * sx, -0.11, 0], [0, 0, 0.08 * sx], [0.215, 0.07, 0.215]),
      shape('box', [0.015 * sx, -0.02, 0], [0, 0, 0.06 * sx], [0.21, 0.05, 0.22])
    ]);
    add('arm' + side, 'gold', 2, [
      shape('cyl', [0.02 * sx, 0.13, 0], [0, 0, 0.1 * sx], [0.24, 0.014, 0.24]),
      shape('sph', [0.02 * sx, 0.10, 0.03], [0, 0, 0], [0.055, 0.055, 0.04])
    ]);
    add('arm' + side, 'cloth', 1, [
      shape('cap', [0, -0.16, 0], [0, 0, 0], [0.14, 0.27, 0.14])
    ]);
    add('elb' + side, 'steel', 0, [
      shape('cyl', [0, -0.115, 0], [0, 0, 0], [0.12, 0.25, 0.115]),
      shape('cyl', [0, -0.24, 0], [0, 0, 0], [0.108, 0.045, 0.103])
    ]);
    add('hand' + side, 'darkSteel', 1, [
      shape('box', [0, -0.05, 0.005], [0, 0, 0], [0.095, 0.115, 0.11])
    ]);
    add('hand' + side, 'gold', 2, [
      shape('box', [0, -0.02, 0.045], [0, 0, 0], [0.085, 0.02, 0.028])
    ]);
  };
  arm('R'); arm('L');

  /* ── 다리 ── */
  const leg = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('thigh' + side, 'cloth', 1, [
      shape('cap', [0, -0.20, 0], [0, 0, 0], [0.175, 0.34, 0.175])
    ]);
    add('thigh' + side, 'steel', 1, [
      shape('box', [0.02 * sx, -0.13, 0.055], [0, 0, 0.10 * sx], [0.13, 0.19, 0.055])
    ]);
    add('shin' + side, 'steel', 0, [
      shape('cyl', [0, -0.135, 0], [0, 0, 0], [0.14, 0.33, 0.13]),
      shape('sph', [0, 0.015, 0.04], [0, 0, 0], [0.175, 0.135, 0.175])
    ]);
    add('shin' + side, 'gold', 2, [
      shape('cyl', [0, -0.29, 0], [0, 0, 0], [0.135, 0.014, 0.125])
    ]);
    add('shin' + side, 'leather', 0, [
      shape('cyl', [0, -0.365, 0.005], [0, 0, 0], [0.118, 0.15, 0.118])
    ]);
    add('foot' + side, 'darkSteel', 1, [
      shape('box', [0, -0.02, 0.035], [0, 0, 0], [0.125, 0.105, 0.25]),
      shape('sph', [0, 0.03, -0.01], [0, 0, 0], [0.125, 0.095, 0.125])
    ]);
    add('foot' + side, 'gold', 2, [
      shape('box', [0, -0.03, 0.135], [0, 0, 0], [0.12, 0.018, 0.10])
    ]);
  };
  leg('R'); leg('L');

  /* ── 어깨 망토 — 베테랑의 표식 ── */
  add('chest', 'clothHeavy', 1, [
    shape('box', [0, 0.185, -0.02], [0.03, 0, 0], [0.49, 0.065, 0.32]),
    shape('planeV', [0, -0.12, -0.185], [0.12, 0, 0], [0.44, 0.50, 1])
  ]);

  /* ── 장검 — 병사보다 길고 금장 가드 ── */
  add('handR', 'darkLeather', 0, [
    shape('cyl', [0, 0, -0.06], [Math.PI / 2, 0, 0], [0.054, 0.19, 0.054])
  ]);
  add('handR', 'gold', 0, [
    shape('sph', [0, 0, -0.17], [0, 0, 0], [0.066, 0.066, 0.06]),
    shape('box', [0, 0, 0.034], [0, 0, 0], [0.275, 0.034, 0.05]),
    shape('box', [-0.132, 0, 0.055], [0, 0, 0.45], [0.07, 0.03, 0.04]),
    shape('box', [0.132, 0, 0.055], [0, 0, -0.45], [0.07, 0.03, 0.04]),
    shape('sphLow', [-0.16, 0, 0.068], [0, 0, 0], [0.034, 0.034, 0.026]),
    shape('sphLow', [0.16, 0, 0.068], [0, 0, 0], [0.034, 0.034, 0.026])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 0.22], [0, 0, 0], [0.066, 0.017, 0.36]),
    shape('box', [0, 0, 0.58], [0, 0, 0], [0.057, 0.015, 0.36]),
    shape('box', [0, 0, 0.87], [0, 0, 0], [0.046, 0.013, 0.24]),
    shape('cone6', [0, 0, 1.03], [Math.PI / 2, 0, 0], [0.052, 0.16, 0.03])
  ]);
  add('handR', 'darkSteel', 2, [
    shape('box', [0, 0, 0.55], [0, 0, 0], [0.015, 0.02, 0.86]),
    shape('box', [0, 0, 0.22], [0, 0, 0], [0.023, 0.019, 0.10])
  ]);
  add('pelvis', 'blackIron', 1, [
    shape('box', [-0.23, -0.22, -0.03], [0.16, 0.1, 0.1], [0.036, 0.21, 0.048])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [-0.23, -0.39, -0.055], [0.16, 0.1, 0.1], [0.04, 0.05, 0.052])
  ]);
  return P;
}

function knightParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 중갑 몸통 ───────────────────────────────────────────────── */
  add('chest', 'steel', 0, [
    shape('cyl', [0, 0.03, 0], [0, 0, 0], [0.56, 0.38, 0.36]),              // 흉갑(둥근)
    shape('box', [0, 0.13, 0.175], [0.08, 0, 0], [0.34, 0.15, 0.05]),       // 가슴 판
    shape('box', [0, 0.20, 0], [0, 0, 0], [0.30, 0.10, 0.30]),              // 목 가드
    shape('box', [-0.235, 0.02, 0], [0, 0, 0.12], [0.09, 0.30, 0.30]),      // 겨드랑이
    shape('box', [0.235, 0.02, 0], [0, 0, -0.12], [0.09, 0.30, 0.30])
  ]);
  add('chest', 'darkSteel', 1, [
    shape('box', [0, -0.09, 0.196], [0.20, 0, 0], [0.42, 0.10, 0.05]),      // 배 판 겹
    shape('box', [0, 0.03, 0.185], [0, 0, 0], [0.02, 0.22, 0.02])
  ]);
  add('chest', 'gold', 1, [
    shape('box', [0, 0.10, 0.205], [0, 0, 0], [0.11, 0.11, 0.02]),          // 문장
    shape('box', [0, 0.10, 0.205], [0, 0, 0.5], [0.15, 0.03, 0.02]),
    shape('box', [0, 0.235, 0], [0, 0, 0], [0.26, 0.03, 0.03])              // 목 테
  ]);
  add('spine', 'steel', 1, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.46, 0.22, 0.32])
  ]);
  add('spine', 'darkSteel', 2, [
    shape('box', [0, -0.07, 0.10], [0.12, 0, 0], [0.36, 0.09, 0.16]),     // 복갑 겹판
    shape('box', [0, 0.06, 0.12], [0.06, 0, 0], [0.30, 0.05, 0.14])
  ]);
  add('pelvis', 'leather', 1, [
    shape('box', [0, 0.03, 0], [0, 0, 0], [0.47, 0.10, 0.33])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [0, 0.02, 0.175], [0, 0, 0], [0.10, 0.09, 0.03])
  ]);
  add('pelvis', 'steel', 0, [
    shape('box', [-0.19, -0.13, 0.02], [0, 0, 0.20], [0.24, 0.28, 0.30]),   // 허벅지 판
    shape('box', [0.19, -0.13, 0.02], [0, 0, -0.20], [0.24, 0.28, 0.30]),
    shape('box', [0, -0.10, 0.13], [0.10, 0, 0], [0.30, 0.16, 0.06]),        // 앞 허벅지 판
    shape('box', [0, -0.02, 0.02], [0.04, 0, 0], [0.48, 0.07, 0.34]),        // 허리 겹판
    shape('box', [0, -0.09, 0.01], [0.2, 0, 0], [0.46, 0.07, 0.33])
  ]);
  add('pelvis', 'clothHeavy', 1, [
    shape('box', [0, -0.20, 0], [0, 0, 0], [0.46, 0.20, 0.34])              // 군의
  ]);

  /* ── 대형 투구 ───────────────────────────────────────────────── */
  add('head', 'steel', 0, [
    shape('dome', [0, 0.075, 0], [0, 0, 0], [0.31, 0.36, 0.32]),           // 투구 통(둥근 정수리)
    shape('box', [0, 0.02, 0.132], [0, 0, 0], [0.245, 0.19, 0.09]),         // 면갑
    shape('box', [0, -0.045, 0.118], [0.3, 0, 0], [0.235, 0.085, 0.085]),    // 턱 가리개
    shape('box', [0, -0.105, 0.10], [0.16, 0, 0], [0.20, 0.07, 0.07]),       // 턱받침
    shape('cyl', [0, -0.03, 0], [0, 0, 0], [0.33, 0.06, 0.34]),             // 턱받이
    shape('cyl', [0, 0.105, 0], [0.05, 0, 0], [0.325, 0.03, 0.335]),        // 이마 테
    shape('box', [0, 0.235, 0], [0, 0, 0], [0.05, 0.07, 0.22]),             // 볏대
    shape('box', [0, 0.075, 0.163], [0, 0, 0], [0.03, 0.20, 0.03])          // 면갑 능선
  ]);
  add('head', 'blackIron', 1, [
    shape('box', [0, 0.075, 0.178], [0, 0, 0], [0.17, 0.022, 0.02]),        // 눈 틈
    shape('box', [-0.07, 0.075, 0.179], [0, 0, 0.35], [0.05, 0.018, 0.02]),
    shape('box', [0.07, 0.075, 0.179], [0, 0, -0.35], [0.05, 0.018, 0.02]),
    shape('box', [0, -0.02, 0.182], [0, 0, 0], [0.05, 0.09, 0.02])          // 숨구멍
  ]);
  add('head', 'gold', 1, [
    shape('box', [0, 0.205, 0.02], [0, 0, 0], [0.30, 0.035, 0.22]),        // 이마 금장
    shape('cyl', [0, 0.112, 0], [0.05, 0, 0], [0.332, 0.012, 0.342]),       // 이마 테 금선
    shape('box', [0, 0.27, 0], [0, 0, 0], [0.06, 0.06, 0.05])               // 볏대 고정쇠
  ]);
  add('head', 'plume', 0, [
    shape('box', [0, 0.29, -0.02], [0.22, 0, 0], [0.065, 0.13, 0.24]),      // 볏 깃
    shape('box', [0, 0.35, -0.15], [0.70, 0, 0], [0.05, 0.07, 0.16])
  ]);

  /* ── 어깨·팔 ─────────────────────────────────────────────────── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'steel', 0, [
      shape('dome', [0.02 * sx, 0.03, 0], [0, 0, 0.10 * sx], [0.43, 0.34, 0.43]),    // 견갑 통
      shape('domeLow', [0.03 * sx, -0.04, 0], [0, 0, 0.14 * sx], [0.39, 0.22, 0.39]),  // 1단 겹판
      shape('domeLow', [0.04 * sx, -0.10, 0], [0, 0, 0.18 * sx], [0.34, 0.17, 0.35]),  // 2단 겹판
      shape('domeLow', [0.05 * sx, -0.155, 0], [0, 0, 0.20 * sx], [0.30, 0.14, 0.31]), // 3단 겹판
      shape('cap', [0, -0.20, 0], [0, 0, 0], [0.185, 0.16, 0.185])
    ]);
    add('arm' + side, 'gold', 2, [
      shape('cyl', [0.02 * sx, 0.012, 0], [0, 0, 0.10 * sx], [0.436, 0.014, 0.436]),   // 견갑 테 금선
      shape('cyl', [0.04 * sx, -0.095, 0], [0, 0, 0.16 * sx], [0.352, 0.012, 0.36])    // 2단 테 금선
    ]);
    add('elb' + side, 'steel', 0, [
      shape('cap', [0, -0.12, 0], [0, 0, 0], [0.17, 0.26, 0.165]),
      shape('box', [0, -0.02, 0.065], [0, 0, 0], [0.14, 0.09, 0.07])
    ]);
    add('hand' + side, 'darkSteel', 1, [
      shape('box', [0, -0.05, 0.005], [0, 0, 0], [0.11, 0.13, 0.125])
    ]);
  };
  arm('R'); arm('L');

  /* 망토 */
  add('chest', 'cape', 0, [
    shape('planeV', [0, -0.42, -0.185], [0.10, 0, 0], [0.72, 1.10, 1])
  ]);
  add('chest', 'gold', 2, [
    shape('box', [-0.14, 0.235, -0.05], [0, 0, 0], [0.06, 0.05, 0.06]),
    shape('box', [0.14, 0.235, -0.05], [0, 0, 0], [0.06, 0.05, 0.06])
  ]);

  /* 다리 */
  const leg = (side) => {
    add('thigh' + side, 'steel', 1, [
      shape('cap', [0, -0.20, 0], [0, 0, 0], [0.22, 0.32, 0.21])
    ]);
    add('shin' + side, 'steel', 0, [
      shape('cap', [0, -0.14, 0], [0, 0, 0], [0.20, 0.32, 0.19]),
      shape('sph', [0, 0.02, 0.045], [0, 0, 0], [0.23, 0.17, 0.23])
    ]);
    add('shin' + side, 'steel', 1, [
      shape('cyl', [0, -0.36, 0.01], [0, 0, 0], [0.155, 0.16, 0.15])          // 발목 갑주
    ]);
    add('foot' + side, 'darkSteel', 1, [
      shape('box', [0, -0.02, 0.06], [0, 0, 0], [0.16, 0.12, 0.32])
    ]);
  };
  leg('R'); leg('L');

  /* ── 큰 망치 ─────────────────────────────────────────────────── */
  add('handR', 'woodDark', 0, [
    shape('cyl', [0, 0, 0.30], [Math.PI / 2, 0, 0], [0.125, 1.42, 0.125])
  ]);
  add('handR', 'darkLeather', 1, [
    shape('cyl', [0, 0, -0.02], [Math.PI / 2, 0, 0], [0.145, 0.34, 0.145]),
    shape('cyl', [0, 0, 0.36], [Math.PI / 2, 0, 0], [0.143, 0.20, 0.143])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 1.02], [0, 0, 0], [0.46, 0.32, 0.32]),              // 머리
    shape('box', [0, 0, 1.18], [0, 0, 0], [0.38, 0.26, 0.10]),              // 타격면
    shape('box', [0, 0, 0.84], [0, 0, 0], [0.34, 0.24, 0.10]),              // 뒤꽁무니
    shape('cone', [0, 0, 1.34], [0, 0, 0], [0.13, 0.28, 0.13]),             // 스파이크
    shape('box', [0, 0.17, 1.02], [0, 0, 0], [0.42, 0.04, 0.28])            // 상단 판
  ]);
  add('handR', 'gold', 1, [
    shape('box', [0, 0, 0.88], [0, 0, 0], [0.38, 0.28, 0.05]),
    shape('box', [0, 0, 1.16], [0, 0, 0], [0.40, 0.26, 0.05]),
    shape('box', [0, 0.165, 1.02], [0.18, 0, 0], [0.44, 0.03, 0.30]),       // 머리 테
    shape('sph', [0, 0, -0.21], [0, 0, 0], [0.10, 0.10, 0.10]),
    shape('box', [0, 0.165, 1.02], [0.18, 0, 0], [0.18, 0.035, 0.09]),      // 각인 판(중앙)
    shape('box', [0, -0.14, 1.02], [-0.1, 0, 0], [0.26, 0.03, 0.20])
  ]);
  add('handR', 'darkSteel', 2, [
    shape('cone6', [0.26, 0, 1.02], [0, 0, -Math.PI / 2], [0.10, 0.16, 0.10]),  // 옆 날개
    shape('cone6', [-0.26, 0, 1.02], [0, 0, Math.PI / 2], [0.10, 0.16, 0.10]),
    shape('box', [0, 0, 0.98], [0, 0, 0], [0.12, 0.36, 0.06])                    // 쐐기 고정
  ]);
  return P;
}

function wizardParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 로브: 어깨→바닥으로 퍼지는 실루엣 ───────────────────────── */
  add('spine', 'robe', 0, [
    shape('cyl', [0, 0.01, 0], [0, 0, 0], [0.44, 0.30, 0.40])
  ]);
  add('chest', 'robe', 0, [
    shape('box', [0, 0.03, 0], [0, 0, 0], [0.44, 0.34, 0.32]),
    shape('box', [0, 0.19, 0], [0, 0, 0], [0.50, 0.10, 0.36]),              // 어깨 망토
    shape('box', [0, -0.14, 0.14], [0, 0, 0], [0.10, 0.30, 0.03])           // 앞 여밈
  ]);
  add('chest', 'gold', 1, [
    shape('box', [0, 0.215, 0.14], [0, 0, 0], [0.16, 0.03, 0.02]),
    shape('box', [0.20, 0.19, 0], [0, 0, -0.12], [0.05, 0.12, 0.30]),
    shape('box', [0, -0.02, 0.163], [0, 0, 0], [0.035, 0.22, 0.012]),        // 앞자락 금선
    shape('sph', [0, 0.09, 0.166], [0, 0, 0], [0.035, 0.035, 0.014]),        // 매듭 장식
    shape('sph', [-0.13, -0.10, 0.158], [0, 0, 0], [0.02, 0.02, 0.01])
  ]);
  add('pelvis', 'robe', 0, [
    shape('cyl', [0, -0.34, 0], [0, 0, 0], [0.82, 0.86, 0.78]),             // 퍼지는 자락
    shape('cyl', [0, -0.62, 0], [0, 0, 0], [0.88, 0.26, 0.84]),             // 자락 주름
    shape('cyl', [0, -0.72, 0], [0, 0, 0], [0.94, 0.22, 0.90])              // 밑단
  ]);
  add('pelvis', 'gold', 1, [
    shape('cyl', [0, -0.80, 0], [0, 0, 0], [0.952, 0.022, 0.912]),          // 밑단 금장 띠
    shape('cyl', [0, -0.40, 0], [0, 0, 0], [0.842, 0.014, 0.802])           // 자락 금선
  ]);
  add('pelvis', 'clothHeavy', 2, [
    shape('box', [0, -0.04, 0], [0, 0, 0], [0.50, 0.12, 0.44])              // 허리띠
  ]);
  add('pelvis', 'rune', 1, [
    shape('plane', [0, -0.02, 0], [-Math.PI / 2, 0, 0], [1.6, 1.6, 1])      // 발밑 룬
  ], { spin: { axis: 'y', speed: 0.45 } });

  /* ── 머리: 후드 · 뾰족 모자 · 발광 눈 ───────────────────────── */
  add('head', 'robe', 0, [
    shape('sph', [0, 0.10, -0.03], [0, 0, 0], [0.34, 0.36, 0.34]),         // 후드
    shape('cone', [0, 0.46, -0.06], [0.16, 0, 0], [0.30, 0.72, 0.30]),      // 뾰족 모자
    shape('cyl', [0, 0.19, -0.03], [0, 0, 0], [0.72, 0.05, 0.68]),          // 모자 챙
    shape('box', [0, -0.04, -0.16], [0.3, 0, 0], [0.30, 0.26, 0.06]),       // 후드 뒤
    shape('cyl', [0, 0.30, -0.045], [0.05, 0, 0], [0.44, 0.30, 0.42])       // 모자 몸통 마디
  ]);
  add('head', 'blackIron', 1, [
    shape('sph', [0, 0.06, 0.075], [0, 0, 0], [0.22, 0.23, 0.14])           // 그림자 얼굴
  ]);
  add('head', 'eye', 1, [
    shape('sph', [0.05, 0.085, 0.128], [0, 0, 0], [0.036, 0.030, 0.02]),
    shape('sph', [-0.05, 0.085, 0.128], [0, 0, 0], [0.036, 0.030, 0.02])
  ]);
  add('head', 'gold', 2, [
    shape('cyl', [0, 0.196, -0.03], [0, 0, 0], [0.732, 0.012, 0.692]),      // 모자 테 금선
    shape('sph', [0, 0.83, -0.11], [0, 0, 0], [0.05, 0.05, 0.05])           // 모자 끝 장식
  ]);

  /* ── 팔: 넓은 소매 ───────────────────────────────────────────── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'robe', 0, [
      shape('cap', [0, -0.16, 0], [0, 0, 0], [0.19, 0.30, 0.19]),
      shape('sph', [0.01 * sx, 0.02, 0], [0, 0, 0], [0.24, 0.18, 0.24])     // 어깨 천
    ]);
    add('elb' + side, 'robe', 0, [
      shape('cyl', [0, -0.10, 0.01], [0, 0, 0], [0.22, 0.26, 0.22]),        // 나팔 소매
      shape('cyl', [0, -0.22, 0.01], [0, 0, 0], [0.17, 0.04, 0.17])
    ]);
    add('hand' + side, 'skin', 1, [
      shape('box', [0, -0.05, 0.01], [0, 0, 0], [0.08, 0.10, 0.10])
    ]);
  };
  arm('R'); arm('L');
  add('handR', 'orb', 1, [
    shape('sph', [0, -0.055, 0.115], [0, 0, 0], [0.11, 0.11, 0.11])        // 손바닥 오브
  ], { spin: { axis: 'y', speed: 1.3 } });


  /* ── 지팡이 ──────────────────────────────────────────────────── */
  add('handL', 'woodDark', 0, [
    shape('cyl', [0, -0.04, 0.02], [0, 0, 0], [0.062, 1.86, 0.062]),
    shape('cyl', [0, 0.79, 0.02], [0, 0, 0], [0.10, 0.10, 0.10])
  ]);
  add('handL', 'gold', 0, [
    shape('cyl', [0, 0.86, 0.02], [0, 0, 0], [0.14, 0.05, 0.14]),
    shape('cyl', [0, -0.60, 0.02], [0, 0, 0], [0.095, 0.06, 0.095]),
    shape('torus', [0, 0.74, 0.02], [Math.PI / 2, 0, 0], [0.26, 0.26, 0.26])
  ]);
  add('handL', 'orb', 0, [
    shape('sph', [0, 1.00, 0.02], [0, 0, 0], [0.21, 0.21, 0.21]),
    shape('sph', [0, 1.00, 0.02], [0, 0.6, 0], [0.29, 0.10, 0.29])          // 보석 고리빛
  ], { spin: { axis: 'y', speed: 0.8 } });


  /* 로브 밑으로 살짝 보이는 장화 */
  add('shinR', 'darkLeather', 1, [shape('box', [0, -0.30, 0.03], [0, 0, 0], [0.16, 0.28, 0.20])]);
  add('footR', 'darkLeather', 1, [shape('box', [0, -0.02, 0.06], [0, 0, 0], [0.14, 0.10, 0.26])]);
  add('shinL', 'darkLeather', 1, [shape('box', [0, -0.30, 0.03], [0, 0, 0], [0.16, 0.28, 0.20])]);
  add('footL', 'darkLeather', 1, [shape('box', [0, -0.02, 0.06], [0, 0, 0], [0.14, 0.10, 0.26])]);
  return P;
}

function blademasterParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 무사복: 기모노 상의 + 하오리 + 넓은 하카마 ─────────────── */
  add('chest', 'kimono', 0, [
    shape('box', [0, 0.04, 0], [0, 0, 0], [0.40, 0.36, 0.26]),              // 기모노
    shape('box', [0, 0.03, 0.135], [0, 0, 0.55], [0.16, 0.34, 0.03]),       // 여밈 깃
    shape('box', [0, 0.03, 0.135], [0, 0, -0.55], [0.16, 0.34, 0.03])
  ]);
  add('chest', 'darkSteel', 1, [
    shape('box', [0, 0.03, -0.145], [0, 0, 0], [0.36, 0.34, 0.03])          // 하오리 등판
  ]);
  add('chest', 'clothHeavy', 1, [
    shape('box', [-0.15, 0.0, 0.01], [0.02, 0, 0.03], [0.055, 0.40, 0.30]),  // 하오리 앞자락
    shape('box', [0.15, 0.0, 0.01], [0.02, 0, -0.03], [0.055, 0.40, 0.30]),
    shape('box', [0, -0.16, 0.02], [0, 0, 0], [0.38, 0.05, 0.27])           // 하오리 밑단
  ]);
  add('chest', 'gold', 2, [
    shape('box', [-0.15, 0.20, 0.08], [0, 0, 0], [0.05, 0.05, 0.03]),      // 매화 장식
    shape('box', [0, 0.19, 0.149], [0, 0, 0], [0.20, 0.012, 0.012])        // 깃 금선
  ]);
  add('spine', 'kimono', 0, [
    shape('box', [0, 0.02, 0], [0, 0, 0], [0.36, 0.22, 0.24])
  ]);
  add('spine', 'clothHeavy', 0, [
    shape('box', [0, -0.02, 0.0], [0, 0, 0], [0.40, 0.10, 0.27])            // 오비(허리띠)
  ]);
  add('pelvis', 'kimono', 0, [
    shape('cyl', [0, -0.24, 0], [0, 0, 0], [0.54, 0.56, 0.50]),             // 하카마
    shape('cyl', [0, -0.56, 0], [0, 0, 0], [0.64, 0.16, 0.60]),             // 밑단 주름
    shape('cyl', [0, -0.63, 0], [0, 0, 0], [0.58, 0.06, 0.54])
  ]);
  add('pelvis', 'clothHeavy', 1, [
    shape('box', [0, -0.04, 0.135], [0, 0, 0], [0.14, 0.16, 0.03])          // 오비 매듭
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [0, -0.04, 0.155], [0, 0, 0], [0.05, 0.05, 0.02])
  ]);

  /* ── 머리: 장식 머리띠 + 묶은 머리 ───────────────────────────── */
  add('head', 'skin', 0, [
    shape('sph', [0, 0.06, 0.005], [0, 0, 0], [0.19, 0.21, 0.19])
  ]);
  add('head', 'blackIron', 1, [
    shape('sph', [0, 0.10, -0.02], [0, 0, 0], [0.215, 0.20, 0.215])         // 머리카락
  ]);
  add('head', 'cloth', 0, [
    shape('box', [0, 0.155, 0], [0, 0, 0], [0.235, 0.045, 0.235]),          // 머리띠
    shape('box', [0, 0.10, -0.16], [0.5, 0, 0], [0.07, 0.10, 0.22]),        // 띠 끝
    shape('box', [0.05, 0.06, -0.21], [0.9, 0.2, 0], [0.05, 0.07, 0.18])
  ]);
  add('head', 'blackIron', 2, [
    shape('sph', [0.08, 0.02, 0.13], [0, 0, 0], [0.055, 0.028, 0.02]),       // 눈썹
    shape('sph', [-0.08, 0.02, 0.13], [0, 0, 0], [0.055, 0.028, 0.02])
  ]);
  add('head', 'gold', 2, [
    shape('sph', [0.10, 0.185, 0.05], [0, 0, 0], [0.045, 0.045, 0.02])      // 매화 핀
  ]);

  /* ── 팔 ──────────────────────────────────────────────────────── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'kimono', 0, [
      shape('cap', [0, -0.16, 0], [0, 0, 0], [0.17, 0.30, 0.17]),           // 넓은 소매
      shape('sph', [0.01 * sx, 0.02, 0], [0, 0, 0], [0.21, 0.17, 0.21])
    ]);
    add('elb' + side, 'kimono', 1, [
      shape('cyl', [0, -0.10, 0], [0, 0, 0], [0.17, 0.24, 0.17])
    ]);
    add('hand' + side, 'skin', 1, [
      shape('box', [0, -0.05, 0.01], [0, 0, 0], [0.075, 0.10, 0.10])
    ]);
  };
  arm('R'); arm('L');

  /* 다리 — 하카마 아래로 보이는 각반 */
  const leg = (side) => {
    add('thigh' + side, 'kimono', 1, [shape('cap', [0, -0.20, 0], [0, 0, 0], [0.20, 0.32, 0.20])]);
    add('shin' + side, 'darkLeather', 0, [
      shape('cyl', [0, -0.14, 0], [0, 0, 0], [0.145, 0.30, 0.135])
    ]);
    add('shin' + side, 'darkLeather', 1, [
      shape('cyl', [0, -0.36, 0.005], [0, 0, 0], [0.12, 0.14, 0.12])
    ]);
    add('foot' + side, 'darkLeather', 1, [
      shape('box', [0, -0.02, 0.05], [0, 0, 0], [0.12, 0.09, 0.24])
    ]);
  };
  leg('R'); leg('L');

  /* ── 태도(카타나) — 손 로컬 +Z, 살짝 휘어진 날 ───────────────── */
  add('handR', 'darkLeather', 0, [
    shape('cyl', [0, 0, -0.07], [Math.PI / 2, 0, 0], [0.048, 0.20, 0.048])   // 손잡이 감개
  ]);
  add('handR', 'gold', 0, [
    shape('cyl', [0, 0, 0.045], [Math.PI / 2, 0, 0], [0.115, 0.02, 0.115]),  // 츠바
    shape('sph', [0, 0, -0.185], [0, 0, 0], [0.05, 0.05, 0.04])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 0.28], [0, 0, 0], [0.046, 0.012, 0.44]),             // 날(뿌리)
    shape('box', [0, 0.006, 0.60], [0.02, 0, 0], [0.045, 0.012, 0.24]),      // 날(중간, 도리)
    shape('box', [0, 0.026, 0.82], [0.05, 0, 0], [0.043, 0.012, 0.22]),      // 날(끝, 도리)
    shape('box', [0, 0.062, 0.95], [0.09, 0, 0], [0.041, 0.011, 0.12]),      // 날 끝단
    shape('box', [0, 0.020, 0.55], [0.03, 0, 0], [0.013, 0.015, 0.70]),      // 혈조
    shape('box', [0.008, 0.008, 0.075], [0, 0, 0], [0.052, 0.022, 0.05])     // 하바키
  ]);
  add('handR', 'darkSteel', 2, [
    shape('box', [0.023, 0.013, 0.55], [0.03, 0, 0], [0.006, 0.007, 0.58])  // 하몬(날의 물결)
  ]);
  add('handR', 'gold', 1, [
    shape('torus', [0, 0.0, 0.035], [0, 0, 0], [0.14, 0.14, 0.14]),          // 츠바 테
    shape('box', [0, 0.0, 0.035], [0, 0, 0], [0.15, 0.012, 0.06]),            // 츠바 살
    shape('box', [0, 0.0, 0.035], [Math.PI / 2, 0, 0], [0.15, 0.012, 0.06])
  ]);
  add('handR', 'gold', 2, [
    shape('box', [0, 0, 0.055], [0, 0, 0], [0.13, 0.02, 0.02])
  ]);
  /* 사게오(술 장식) */
  add('handR', 'cloth', 2, [
    shape('box', [-0.03, -0.05, -0.02], [0.3, 0, 0.2], [0.02, 0.12, 0.02])
  ]);
  /* 칼집 — 왼쪽 허벅지에 수직으로 달랑거린다 */
  add('pelvis', 'blackIron', 1, [
    shape('box', [-0.30, -0.34, -0.02], [1.16, 0.12, 0.10], [0.045, 0.045, 0.80])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [-0.30, -0.02, -0.02], [1.16, 0.12, 0.10], [0.052, 0.052, 0.05])
  ]);
  return P;
}

/* 🩸 잘린 부위의 단면 — 팔·다리·목이 잘린 자리에 젖은 살점·뼈·핏물이 남는다.
   (sevOnly: 해당 부위가 잘렸을 때만 그린다 — 평상시에는 인스턴스를 숨겨 비용이 없다)
   · 단면은 잘린 면을 따라(관절 +Y) 만들고, 가운데에 뼈를 살짝 내밀게 둔다 */
function addStumpParts(P, cls) {
  const add = (joint, mat, shapes, sevOnly) => P.push({ joint, mat, lod: 1, shapes, sevOnly });
  const armStump = (side, bit) => {
    add('arm' + side, 'blood', [
      shape('cyl', [0, 0.005, 0], [0, 0, 0], [0.150, 0.022, 0.145]),      // 잘린 면(살점)
      shape('cyl', [0, -0.035, 0], [0, 0, 0], [0.118, 0.06, 0.112]),      // 살점 단면
      shape('sph', [side === 'R' ? 0.012 : -0.012, -0.02, 0.02], [0, 0, 0], [0.07, 0.04, 0.07])
    ], bit);
    add('arm' + side, 'bone', [shape('sph', [0.006, 0.012, 0], [0, 0, 0], [0.042, 0.02, 0.038])], bit);
  };
  const legStump = (side, bit) => {
    add('thigh' + side, 'blood', [
      shape('cyl', [0, 0.008, 0], [0, 0, 0], [0.185, 0.025, 0.175]),
      shape('cyl', [0, -0.045, 0], [0, 0, 0], [0.145, 0.07, 0.138]),
      shape('sph', [0, -0.025, 0.03], [0, 0, 0], [0.09, 0.05, 0.085])
    ], bit);
    add('thigh' + side, 'bone', [shape('sph', [0, 0.015, 0], [0, 0, 0], [0.055, 0.025, 0.05])], bit);
  };
  armStump('R', 2);
  armStump('L', 1);
  legStump('R', 8);
  legStump('L', 4);
  /* 목 — 머리가 베인 자리 (위를 향한 단면) */
  add('neck', 'blood', [
    shape('cyl', [0, 0.03, 0], [0, 0, 0], [0.185, 0.075, 0.165]),
    shape('sph', [0, 0.07, 0.005], [0, 0, 0], [0.14, 0.05, 0.13]),
    shape('sph', [0.02, 0.062, -0.03], [0, 0, 0], [0.05, 0.04, 0.05])
  ], 16);
  add('neck', 'bone', [shape('sph', [0.015, 0.095, -0.005], [0, 0, 0], [0.042, 0.028, 0.038])], 16);
}

function berserkerParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 몸통: 벗은 상체(근육) + 진영색 털 망토 + X자 가죽끈 — 한 눈에 '광전사'로 읽힌다 ── */
  add('chest', 'skin', 0, [
    shape('sph', [0, 0.03, 0], [0, 0, 0], [0.47, 0.37, 0.32]),             // 두툼한 가슴
    shape('sph', [0, -0.12, 0.01], [0, 0, 0], [0.41, 0.20, 0.29]),          // 복근
    shape('box', [0, 0.02, 0.158], [0, 0, 0], [0.05, 0.22, 0.04])           // 복근 홈
  ]);
  add('chest', 'leather', 0, [
    shape('box', [0.085, 0.10, 0.150], [0, 0, 0.62], [0.06, 0.34, 0.03]),   // X자 가죽끈
    shape('box', [-0.085, 0.10, 0.150], [0, 0, -0.62], [0.06, 0.34, 0.03])
  ]);
  add('chest', 'clothHeavy', 0, [
    /* 어깨를 덮는 털 갈기 — 네 덩어리로 나눠 털처럼 보이게 */
    shape('sph', [-0.21, 0.215, -0.03], [0, 0, 0.25], [0.23, 0.17, 0.30]),
    shape('sph', [0.21, 0.215, -0.03], [0, 0, -0.25], [0.23, 0.17, 0.30]),
    shape('sph', [0, 0.225, -0.06], [0.10, 0, 0], [0.30, 0.16, 0.28]),
    shape('planeV', [0, -0.10, -0.20], [0.16, 0, 0], [0.44, 0.52, 1])      // 등 망토
  ]);
  add('chest', 'bronze', 1, [
    shape('sph', [0.24, 0.145, 0], [0, 0, -0.18], [0.20, 0.15, 0.21]),      // 오른 견갑(청동)
    shape('sphLow', [0.248, 0.05, 0], [0, 0, -0.16], [0.17, 0.09, 0.18]),
    shape('sph', [-0.24, 0.145, 0], [0, 0, 0.18], [0.17, 0.13, 0.18])       // 왼 어깨 가죽받이
  ]);
  add('chest', 'gold', 2, [
    shape('sph', [0.24, 0.19, 0.03], [0, 0, 0], [0.045, 0.045, 0.045]),     // 견갑 못
    shape('sph', [0.24, 0.11, 0.03], [0, 0, 0], [0.034, 0.034, 0.034])
  ]);
  add('spine', 'skin', 0, [
    shape('cyl', [0, 0.02, 0], [0, 0, 0], [0.40, 0.20, 0.28])
  ]);
  add('pelvis', 'leather', 0, [
    shape('box', [0, -0.01, 0], [0, 0, 0], [0.41, 0.10, 0.29]),             // 가죽 벨트
    shape('box', [0, -0.17, 0.11], [0.05, 0, 0], [0.30, 0.30, 0.04]),       // 가죽 킬트
    shape('box', [0, -0.17, -0.11], [-0.05, 0, 0], [0.30, 0.30, 0.04])
  ]);
  add('pelvis', 'clothHeavy', 1, [
    shape('box', [0, -0.17, 0.128], [0.05, 0, 0], [0.19, 0.26, 0.02]),      // 진영색 천 자락
    shape('box', [0, -0.17, -0.128], [-0.05, 0, 0], [0.19, 0.26, 0.02])
  ]);
  add('pelvis', 'bronze', 2, [
    shape('box', [0, 0.0, 0.152], [0, 0, 0], [0.09, 0.08, 0.03])            // 버클
  ]);

  /* ── 머리: 반투구 + 사나운 갈기(진영색) — 얼굴이 보이게 털을 뒤로 넘긴다 ── */
  add('head', 'skin', 0, [
    shape('sph', [0, 0.045, 0.03], [0, 0, 0], [0.19, 0.195, 0.185]),
    shape('box', [0, -0.045, 0.105], [0.10, 0, 0], [0.10, 0.055, 0.03])      // 턱
  ]);
  add('head', 'blackIron', 1, [
    shape('sph', [0, 0.125, -0.085], [0, 0, 0], [0.205, 0.17, 0.185]),      // 뒤로 넘긴 머리
    shape('box', [0.072, 0.035, 0.175], [0, 0, 0.18], [0.052, 0.026, 0.02]), // 눈썹
    shape('box', [-0.072, 0.035, 0.175], [0, 0, -0.18], [0.052, 0.026, 0.02]),
    shape('box', [0, -0.005, 0.195], [0, 0, 0], [0.12, 0.014, 0.012])       // 입
  ]);
  add('head', 'blackIron', 2, [
    shape('box', [0.07, 0.075, 0.185], [0, 0, 0.16], [0.038, 0.014, 0.02]), // 전쟁칠 눈가
    shape('box', [-0.07, 0.075, 0.185], [0, 0, -0.16], [0.038, 0.014, 0.02])
  ]);
  add('head', 'darkSteel', 0, [
    shape('dome', [0, 0.175, -0.015], [0, 0, 0], [0.250, 0.215, 0.245]),   // 반투구(이마·정수리)
    shape('cyl', [0, 0.115, 0.005], [0.05, 0, 0], [0.256, 0.042, 0.256]),   // 이마 테
    shape('sph', [-0.135, 0.02, 0.02], [0, 0, 0.3], [0.07, 0.10, 0.07]),    // 귀가리개
    shape('sph', [0.135, 0.02, 0.02], [0, 0, -0.3], [0.07, 0.10, 0.07])
  ]);
  add('head', 'plume', 1, [
    shape('box', [0, 0.215, -0.115], [1.05, 0, 0], [0.085, 0.23, 0.105]),   // 세운 갈기(뒤로 눕힘)
    shape('box', [0, 0.135, -0.225], [1.32, 0, 0], [0.075, 0.21, 0.09])     // 뒤로 흐르는 갈기
  ]);

  /* ── 팔: 맨팔 근육 + 가죽 팔찌 ── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'skin', 0, [
      shape('sph', [0.015 * sx, 0.015, 0], [0, 0, 0.1 * sx], [0.245, 0.21, 0.245]),
      shape('cap', [0, -0.16, 0], [0, 0, 0], [0.155, 0.28, 0.155])
    ]);
    add('arm' + side, 'leather', 1, [
      shape('cyl', [0, -0.275, 0], [0, 0, 0], [0.15, 0.07, 0.15])           // 팔찌
    ]);
    add('elb' + side, 'skin', 0, [
      shape('cap', [0, -0.12, 0], [0, 0, 0], [0.13, 0.26, 0.13])
    ]);
    add('elb' + side, 'darkLeather', 1, [
      shape('cyl', [0, -0.24, 0], [0, 0, 0], [0.125, 0.05, 0.125])
    ]);
    add('hand' + side, 'leather', 1, [
      shape('box', [0, -0.05, 0.005], [0, 0, 0], [0.09, 0.11, 0.10])
    ]);
  };
  arm('R'); arm('L');

  /* ── 다리: 가죽 각반 + 사슬 부츠 ── */
  const leg = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('thigh' + side, 'skin', 1, [
      shape('cap', [0, -0.20, 0], [0, 0, 0], [0.19, 0.34, 0.19])
    ]);
    add('thigh' + side, 'leather', 0, [
      shape('box', [0.015 * sx, -0.16, 0.055], [0, 0, 0.08 * sx], [0.15, 0.22, 0.06]),
      shape('cyl', [0, -0.34, 0], [0, 0, 0], [0.19, 0.08, 0.19])
    ]);
    add('shin' + side, 'leather', 0, [
      shape('cyl', [0, -0.14, 0], [0, 0, 0], [0.15, 0.32, 0.14]),
      shape('sph', [0, 0.015, 0.03], [0, 0, 0], [0.175, 0.13, 0.175])
    ]);
    add('shin' + side, 'darkSteel', 1, [
      shape('cyl', [0, -0.30, 0], [0, 0, 0], [0.155, 0.10, 0.145])
    ]);
    add('foot' + side, 'darkLeather', 1, [
      shape('box', [0, -0.02, 0.045], [0, 0, 0], [0.145, 0.11, 0.28])
    ]);
    add('foot' + side, 'steel', 2, [
      shape('box', [0, -0.055, 0.14], [0, 0, 0], [0.125, 0.05, 0.09])
    ]);
  };
  leg('R'); leg('L');

  /* ── 쌍단검 — 양손에 하나씩 (짧고 두툼한 날) ── */
  const dagger = (side) => {
    add('hand' + side, 'darkLeather', 0, [
      shape('cyl', [0, 0, -0.055], [Math.PI / 2, 0, 0], [0.046, 0.14, 0.046])
    ]);
    add('hand' + side, 'bronze', 0, [
      shape('box', [0, 0, 0.028], [0, 0, 0], [0.165, 0.03, 0.04]),           // 가드
      shape('sph', [0, 0, -0.135], [0, 0, 0], [0.05, 0.05, 0.045])           // 폼멜
    ]);
    add('hand' + side, 'steel', 0, [
      shape('box', [0, 0, 0.20], [0, 0, 0], [0.062, 0.017, 0.30]),           // 날
      shape('cone6', [0, 0, 0.405], [Math.PI / 2, 0, 0], [0.048, 0.14, 0.03])// 칼끝
    ]);
    add('hand' + side, 'blackIron', 2, [
      shape('box', [0, 0, 0.20], [0, 0, 0], [0.012, 0.022, 0.24])            // 혈조
    ]);
  };
  dagger('R'); dagger('L');
  return P;
}

const PART_BUILDERS = { soldier: soldierParts, elite: eliteParts, knight: knightParts, wizard: wizardParts, blademaster: blademasterParts, berserker: berserkerParts };

/* 원거리 실루엣 — 근접 상세 모델과 같은 비례(어깨·허리·다리·무기)를 유지해
   거리로 인한 '블록 사람' 이질감을 없앤다. 천(진영색)과 금속(투구·견갑·무기)을 나눠
   두 재질로 그려 원거리에서도 병종이 읽힌다. (클래스당 인스턴스 2콜) */
function silhouetteShapes(cls) {
  const cloth = [], metal = [];
  const C = (kind, p, r, s) => cloth.push(shape(kind, p, r, s));
  const M = (kind, p, r, s) => metal.push(shape(kind, p, r, s));
  /* 공통 비례 — 발 y0, 골반 0.9, 가슴 1.2, 어깨 1.38, 머리 1.62 */
  const legs = (gap, w, boots) => {
    for (const sx of [-1, 1]) {
      C('blimb', [sx * gap, 0.66, 0.02], [0.16 * sx, 0, 0], [w, 0.40, w]);       // 허벅지
      C('blimb', [sx * gap, 0.32, 0.10], [-0.10, 0, 0], [w * 0.86, 0.34, w * 0.86]); // 정강이
      if (boots) M('box', [sx * gap, 0.06, 0.09], [0, 0, 0], [w * 1.05, 0.12, w * 1.9]);
    }
  };
  const arms = (gap, w, drop) => {
    for (const sx of [-1, 1]) {
      C('blimb', [sx * gap, 1.13, 0.02], [0, 0, sx * 0.14], [w, 0.30, w]);
      C('blimb', [sx * (gap + 0.03), 0.86, 0.10], [0.16, 0, sx * 0.05], [w * 0.88, 0.26, w * 0.88]);
      M('box', [sx * (gap + 0.04), 0.74 - (drop || 0), 0.14], [0, 0, 0], [w * 0.9, 0.11, w * 1.05]);
    }
  };

  if (cls === 'elite') {
    C('box', [0, 1.13, 0], [0, 0, 0], [0.42, 0.42, 0.28]);
    C('box', [0, 0.88, 0], [0.03, 0, 0], [0.38, 0.26, 0.28]);
    C('sphLow', [0, 1.34, 0], [0, 0, 0], [0.40, 0.18, 0.28]);
    legs(0.105, 0.155, true);
    arms(0.24, 0.145, 0);
    C('box', [0, 1.21, -0.20], [0.10, 0, 0], [0.48, 0.62, 0.05]);           // 등 망토
    C('box', [0, 1.74, -0.04], [0.18, 0, 0], [0.09, 0.20, 0.30]);           // 볏 깃
    /* 금속 — 투구·견갑·장검 (방패는 없다) */
    M('domeLow', [0, 1.56, 0], [0, 0, 0], [0.255, 0.30, 0.26]);
    M('cyl6', [0, 1.48, 0.006], [0.04, 0, 0], [0.272, 0.03, 0.272]);
    M('box', [0, 1.50, 0.105], [0, 0, 0], [0.17, 0.20, 0.05]);              // 면갑
    M('sphLow', [-0.235, 1.36, 0], [0, 0, 0.12], [0.235, 0.16, 0.235]);        // 견갑
    M('sphLow', [0.235, 1.36, 0], [0, 0, -0.12], [0.235, 0.16, 0.235]);
    M('box', [0, 0.97, 0.01], [0, 0, 0], [0.40, 0.075, 0.30]);              // 허리 겹판
    M('box', [0.30, 1.12, 0.36], [0.52, 0, 0], [0.06, 0.05, 1.15]);         // 장검
    M('box', [0.30, 1.08, 0.10], [0, 0, 0], [0.24, 0.04, 0.07]);            // 가드
    return { cloth, metal };
  }
  if (cls === 'knight') {
    C('box', [0, 1.18, 0], [0, 0, 0], [0.52, 0.44, 0.34]);
    C('box', [0, 0.92, 0], [0.02, 0, 0], [0.48, 0.26, 0.34]);
    C('box', [0, 1.32, 0], [0, 0, 0], [0.56, 0.16, 0.36]);
    legs(0.13, 0.20, true);
    arms(0.31, 0.19, 0.02);
    C('box', [0, 1.10, -0.26], [0.10, 0, 0], [0.70, 1.05, 0.05]);           // 큰 망토
    M('domeLow', [0, 1.60, 0], [0, 0, 0], [0.32, 0.36, 0.33]);
    M('box', [0, 1.55, 0.14], [0, 0, 0], [0.26, 0.20, 0.10]);
    M('box', [0, 1.62, 0.185], [0, 0, 0], [0.17, 0.03, 0.03]);              // 눈 틈
    M('domeLow', [-0.30, 1.38, 0], [0, 0, 0.14], [0.40, 0.30, 0.40]);          // 거대 견갑
    M('domeLow', [0.30, 1.38, 0], [0, 0, -0.14], [0.40, 0.30, 0.40]);
    M('box', [0, 1.80, -0.02], [0.14, 0, 0], [0.10, 0.22, 0.34]);           // 볏
    /* 망치 — 자루(금속 띠) + 큰 머리 */
    M('box', [0.34, 1.02, 0.40], [0.42, 0, 0], [0.12, 0.12, 1.30]);
    M('box', [0.34, 1.26, 0.78], [0.42, 0, 0], [0.46, 0.34, 0.34]);
    M('box', [0.34, 1.26, 0.94], [0.42, 0, 0], [0.38, 0.26, 0.12]);
    M('sphLow', [0.34, 1.26, 0.72], [0, 0, 0], [0.12, 0.12, 0.12]);
    return { cloth, metal };
  }
  if (cls === 'berserker') {
    /* 🩸 단검 광전사 — 넓은 어깨·두꺼운 몸통 + 양손 단검 */
    C('box', [0, 1.14, 0], [0, 0, 0], [0.52, 0.42, 0.34]);
    C('box', [0, 0.90, 0], [0.02, 0, 0], [0.44, 0.24, 0.30]);
    C('box', [0, 1.19, -0.20], [0.10, 0, 0], [0.50, 0.58, 0.05]);           // 등 망토
    C('box', [0, 1.74, -0.06], [0.26, 0, 0], [0.11, 0.18, 0.28]);           // 갈기
    legs(0.12, 0.19, true);
    arms(0.30, 0.185, 0);
    M('sphLow', [0, 1.44, 0.01], [0, 0, 0], [0.30, 0.26, 0.30]);              // 머리
    M('domeLow', [0, 1.58, 0], [0, 0, 0], [0.27, 0.22, 0.27]);                // 반투구
    M('sphLow', [0.26, 1.36, 0], [0, 0, 0.12], [0.22, 0.16, 0.22]);           // 견갑
    M('sphLow', [-0.26, 1.36, 0], [0, 0, -0.12], [0.21, 0.15, 0.21]);
    M('box', [0, 1.06, 0.01], [0, 0, 0], [0.42, 0.08, 0.30]);                // 허리 벨트
    /* 쌍단검 — 양손에 하나씩, 앞으로 짧게 */
    M('box', [0.31, 1.10, 0.30], [0.52, 0, 0], [0.06, 0.04, 0.62]);
    M('box', [-0.31, 1.10, 0.30], [0.52, 0, 0], [0.06, 0.04, 0.62]);
    return { cloth, metal };
  }
  if (cls === 'blademaster') {
    C('box', [0, 1.14, 0], [0, 0, 0], [0.38, 0.40, 0.27]);
    C('cyl6', [0, 0.78, 0], [0, 0, 0], [0.58, 0.44, 0.54]);                  // 하카마
    C('cyl6', [0, 0.56, 0], [0, 0, 0], [0.64, 0.12, 0.60]);
    legs(0.10, 0.15, true);
    arms(0.25, 0.155, 0);
    C('box', [0, 1.32, 0], [0, 0, 0], [0.40, 0.14, 0.26]);
    M('sphLow', [0, 1.62, 0.005], [0, 0, 0], [0.21, 0.23, 0.21]);              // 얼굴
    M('sphLow', [0, 1.66, -0.02], [0, 0, 0], [0.235, 0.22, 0.235]);            // 머리
    C('box', [0, 1.71, 0], [0, 0, 0], [0.245, 0.05, 0.245]);                // 머리띠
    /* 태도 — 살짝 휘어 오른쪽 위로 */
    M('box', [0.28, 1.26, 0.46], [0.34, 0, 0.10], [0.05, 0.04, 1.30]);
    M('box', [0.28, 1.22, 0.18], [0, 0, 0], [0.20, 0.03, 0.06]);
    M('sphLow', [0.28, 1.18, 0.03], [0, 0, 0], [0.06, 0.06, 0.06]);
    return { cloth, metal };
  }
  if (cls === 'wizard') {
    C('cyl6', [0, 1.10, 0], [0, 0, 0], [0.46, 0.46, 0.42]);
    C('cone6', [0, 0.62, 0], [0, 0, 0], [0.88, 1.10, 0.82]);                 // 로브 자락
    C('cyl6', [0, 1.32, 0], [0, 0, 0], [0.52, 0.14, 0.40]);
    C('sphLow', [0, 1.58, -0.02], [0, 0, 0], [0.34, 0.36, 0.34]);              // 후드
    C('cone6', [0, 1.92, -0.05], [0.14, 0, 0], [0.32, 0.66, 0.32]);          // 뾰족 모자
    C('cyl6', [0, 1.72, -0.03], [0, 0, 0], [0.72, 0.06, 0.68]);              // 모자 챙
    arms(0.26, 0.17, 0);
    M('box', [-0.34, 1.12, 0.16], [0.05, 0, 0.03], [0.055, 1.85, 0.055]);   // 지팡이
    M('sphLow', [-0.34, 2.10, 0.16], [0, 0, 0], [0.21, 0.21, 0.21]);           // 보석
    M('torusLow', [-0.34, 2.05, 0.16], [Math.PI / 2, 0, 0], [0.30, 0.30, 0.30]);
    M('box', [0, 1.56, 0.10], [0, 0, 0], [0.20, 0.16, 0.06]);              // 얼굴 그림자
    return { cloth, metal };
  }
  /* soldier */
  C('box', [0, 1.13, 0], [0, 0, 0], [0.40, 0.40, 0.26]);
  C('box', [0, 0.88, 0], [0.03, 0, 0], [0.36, 0.26, 0.26]);
  C('sphLow', [0, 1.33, 0], [0, 0, 0], [0.38, 0.16, 0.26]);
  legs(0.105, 0.15, true);
  arms(0.235, 0.14, 0);
  C('box', [0, 1.22, -0.19], [0.10, 0, 0], [0.44, 0.58, 0.05]);
  M('domeLow', [0, 1.55, 0], [0, 0, 0], [0.245, 0.28, 0.25]);
  M('cyl6', [0, 1.47, 0.006], [0.05, 0, 0], [0.262, 0.03, 0.262]);
  M('box', [0, 1.50, 0.10], [0, 0, 0], [0.16, 0.20, 0.05]);
  M('box', [0, 1.52, 0.108], [0, 0, 0], [0.15, 0.035, 0.02]);              // 눈 슬릿
  M('sphLow', [-0.20, 1.35, 0], [0, 0, 0.10], [0.21, 0.14, 0.21]);
  M('sphLow', [0.20, 1.35, 0], [0, 0, -0.10], [0.21, 0.14, 0.21]);
  M('box', [0, 0.97, 0.01], [0, 0, 0], [0.38, 0.07, 0.28]);
  M('box', [0.27, 1.10, 0.34], [0.50, 0, 0], [0.055, 0.045, 1.00]);       // 검
  M('box', [0.27, 1.07, 0.10], [0, 0, 0], [0.22, 0.035, 0.06]);
  M('sphLow', [0.27, 1.05, -0.02], [0, 0, 0], [0.055, 0.055, 0.055]);
  return { cloth, metal };
}

/* ---------------------------------------------------------------------------
   UnitRenderer — 클래스별 InstancedMesh 묶음
   --------------------------------------------------------------------------- */
export class UnitRenderer {
  constructor(scene, opts) {
    this.scene = scene;
    this.opts = opts || {};
    this.mats = MATS || (MATS = buildMaterials());
    this.classes = {};
    this.time = 0;
    this.frame = 0;
    this.shadowUnits = this.opts.shadowUnits !== false;
    this.buckets = { soldier: [], elite: [], knight: [], wizard: [], blademaster: [], berserker: [] };
    this.detailCap = this.opts.detailCap || 170;
    this.detailSet = null;
  }

  build(buckets, caps) {
    for (const cls of Object.keys(this.buckets)) {
      const units = buckets[cls] || [];
      const want = Math.max(units.length, (caps && caps[cls]) || 0);
      if (!want) continue;
      const cap = want;
      // 실제로 서 있는 수보다 훨씬 많은 상세 슬롯을 미리 잡으면 숨은 인스턴스까지 그려진다 — 필요한 만큼만
      const dcap = Math.min(cap, this.detailCap, Math.max(12, units.length + 24));
      this.buckets[cls] = units;
      const defs = PART_BUILDERS[cls]();
      addStumpParts(defs, cls);
      const groups = new Map();
      for (const d of defs) {
        const key = d.joint + '|' + d.mat + '|' + d.lod + '|' + (d.spin ? 'spin' : '') + '|' + (d.sevOnly || 0);
        if (!groups.has(key)) groups.set(key, { joint: d.joint, mat: d.mat, lod: d.lod, spin: d.spin, sevOnly: d.sevOnly || 0, shapes: [] });
        groups.get(key).shapes.push(...d.shapes);
      }
      const parts = [];
      for (const g of groups.values()) {
        if (!g.shapes.length) continue;
        const geo = mergeShapes(g.shapes);
        const mesh = new THREE.InstancedMesh(geo, this.mats[g.mat], dcap);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = this.shadowUnits && g.lod === 0;
        mesh.userData.lod = g.lod;
        mesh.userData.joint = J[g.joint];
        mesh.userData.sev = JOINT_LIMB[J[g.joint]] || 0;
        mesh.userData.sevOnly = g.sevOnly || 0;
        mesh.userData.spin = g.spin || null;
        mesh.userData.matKey = g.mat;
        for (let i = 0; i < dcap; i++) mesh.setMatrixAt(i, _hiddenM);
        mesh.instanceMatrix.needsUpdate = true;
        const tinted = ['cloth', 'clothHeavy', 'robe', 'cape', 'plume', 'silhouette', 'kimono'].includes(g.mat);
        if (tinted) {
          const c = new THREE.Color(1, 1, 1);
          for (let i = 0; i < dcap; i++) mesh.setColorAt(i, c);
          mesh.instanceColor.needsUpdate = true;
        }
        this.scene.add(mesh);
        parts.push(mesh);
      }
      /* 원거리 실루엣 — 천(진영색)과 금속(투구·견갑·무기) 두 겹 */
      const silShape = silhouetteShapes(cls);
      const mkSil = (geo, mat) => {
        const m = new THREE.InstancedMesh(geo, mat, cap);
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const cc = new THREE.Color(1, 1, 1);
        for (let i = 0; i < cap; i++) { m.setMatrixAt(i, _hiddenM); m.setColorAt(i, cc); }
        m.instanceColor.needsUpdate = true;
        this.scene.add(m);
        return m;
      };
      const sil = mkSil(mergeShapes(silShape.cloth), this.mats.silhouette);
      const silM = mkSil(mergeShapes(silShape.metal), this.mats.silhouetteSteel);
      const free = [];
      for (let i = dcap - 1; i >= 0; i--) free.push(i);
      // 예비 병력이 나중에 들어올 자리 (실루엣 슬롯)
      const freeSil = [];
      for (let i = cap - 1; i >= units.length; i--) freeSil.push(i);
      this.classes[cls] = { cap, dcap, parts, silhouette: sil, silhouetteM: silM, units, free, freeSil, next: 0 };
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        u.slot = i;
        u.dslot = -1;
        u._tier = -1;
        u.rootMat = u.rootMat || new THREE.Matrix4();
      }
      for (const u of units) this.paintSilhouette(u, cls);
    }
    return this;
  }

  addUnit(u, cls) {
    const c = this.classes[cls];
    if (!c) return false;
    u.slot = c.freeSil && c.freeSil.length ? c.freeSil.pop() : -1;   // 남은 실루엣 자리
    u.dslot = -1; u._tier = -1; u._slotFreed = false;
    u.rootMat = u.rootMat || new THREE.Matrix4();
    if (u.slot >= 0) { c.silhouette.setMatrixAt(u.slot, _hiddenM); c.silhouetteM.setMatrixAt(u.slot, _hiddenM); }
    c.units.push(u);
    this.buckets[cls].push(u);
    this.paintSilhouette(u, cls);
    return true;
  }

  teamColorFor(u, cls, kind) {
    const team = TEAM[u.team] || TEAM.ally;
    const rng = mulberry32((u.mirror || u.id || 1) * 977 + 13);
    const vary = 0.9 + rng() * 0.18;
    if (kind === 'cloth') return new THREE.Color(team.cloth).multiplyScalar(1.0 * vary);
    if (kind === 'robe') return new THREE.Color(u.team === 'enemy' ? 0x5a2440 : 0x2c4266).multiplyScalar(vary);
    if (kind === 'plume') return new THREE.Color(u.team === 'enemy' ? 0x7d1a1a : 0x35608a).multiplyScalar(vary);
    if (kind === 'trim') return new THREE.Color(u.team === 'enemy' ? 0xd8a24a : 0xcbbc93).multiplyScalar(vary);
    if (kind === 'steel') return new THREE.Color(0.9 + rng() * 0.18, 0.9 + rng() * 0.18, 0.94 + rng() * 0.14);
    return new THREE.Color(1, 1, 1);
  }

  paintSilhouette(u, cls) {
    const c = this.classes[cls];
    if (!c) return;
    /* 원거리에서도 진영색이 분명하고, 금속부는 조명을 받아 또렷하게 */
    const col = this.teamColorFor(u, cls, 'cloth').multiplyScalar(0.92);
    c.silhouette.setColorAt(u.slot, col);
    c.silhouette.instanceColor.needsUpdate = true;
    const met = this.teamColorFor(u, cls, 'steel');
    c.silhouetteM.setColorAt(u.slot, met);
    c.silhouetteM.instanceColor.needsUpdate = true;
  }

  paintDetail(u, cls, slot) {
    const c = this.classes[cls];
    const col = new THREE.Color(1, 1, 1);
    for (const p of c.parts) {
      const k = p.userData.matKey;
      if (k === 'cloth' || k === 'clothHeavy' || k === 'kimono' || k === 'cape' || k === 'silhouette') col.copy(this.teamColorFor(u, cls, 'cloth'));
      else if (k === 'robe') col.copy(this.teamColorFor(u, cls, 'robe'));
      else if (k === 'plume') col.copy(this.teamColorFor(u, cls, 'plume'));
      else if (k === 'gold' || k === 'bronze') col.copy(this.teamColorFor(u, cls, 'trim'));
      else if (k === 'steel' || k === 'darkSteel') col.copy(this.teamColorFor(u, cls, 'steel'));
      else col.setRGB(1, 1, 1);
      if (p.instanceColor) p.setColorAt(slot, col);
    }
    for (const p of c.parts) if (p.instanceColor) p.instanceColor.needsUpdate = true;
  }

  hideSlot(c, slot) {
    for (const p of c.parts) p.setMatrixAt(slot, _hiddenM);
    for (const p of c.parts) p.instanceMatrix.needsUpdate = true;
  }

  releaseDetail(u) {
    const c = this.classes[u.cls];
    if (!c || u.dslot < 0) return;
    this.hideSlot(c, u.dslot);
    c.free.push(u.dslot);
    u.dslot = -1;
    u._tier = -1;
  }

  hideUnit(u) {
    const c = this.classes[u.cls];
    if (!c) return;
    if (u.slot != null) { c.silhouette.setMatrixAt(u.slot, _hiddenM); c.silhouetteM.setMatrixAt(u.slot, _hiddenM); }
    this.releaseDetail(u);
    u._tier = -1;
  }

  solveFK(u) {
    const jm = u.joints;
    const q = u._jq;
    const m = u._jm;
    const sc = u.scale || 1;
    for (let i = 0; i < JOINT_COUNT; i++) {
      const par = JOINT_PARENT[i];
      const r = u.pose.rot;
      _e.set(r[i * 3], r[i * 3 + 1], r[i * 3 + 2], 'YXZ');
      q[i].setFromEuler(_e);
      if (par < 0) {
        _v.set(u.pose.root[0], u.pose.root[1], u.pose.root[2]);
        _s.set(sc, sc, sc);
        _m4.compose(_v, q[i], _s);
      } else {
        _v.copy(JOINT_OFFSET[i]);
        _m4.compose(_v, q[i], _one);
        _m4.premultiply(m[par]);
      }
      m[i].copy(_m4);
    }
    for (let i = 0; i < JOINT_COUNT; i++) jm[i].copy(m[i]);
  }

  writeParts(u, tier, time) {
    const c = this.classes[u.cls];
    const slot = u.dslot;
    /* 로드 상세 단계: 가까울수록 미세 장식(lod 2)까지, 중거리는 핵심(lod 1), 원거리는 몸통만(lod 0). */
    const maxLod = 2 - tier;
    const sev = u.sevMask || 0;      // 🩸 잘린 부위의 파트는 그리지 않는다
    for (const p of c.parts) {
      const lod = p.userData.lod;
      const sevOnly = p.userData.sevOnly;
      if (sevOnly) {
        /* 단면은 해당 부위가 잘렸을 때만 */
        if (!(sev & sevOnly)) { p.setMatrixAt(slot, _hiddenM); continue; }
      } else if (lod > maxLod || (sev && (p.userData.sev & sev))) { p.setMatrixAt(slot, _hiddenM); continue; }
      const jm = u.joints[p.userData.joint];
      const spin = p.userData.spin;
      if (spin) {
        _spinQ.setFromAxisAngle(_axisY, time * spin.speed + (u.id || 0) * 0.7);
        _m4.compose(_zero, _spinQ, _one);
        _outMat.multiplyMatrices(jm, _m4);
        p.setMatrixAt(slot, _outMat);
      } else {
        p.setMatrixAt(slot, jm);
      }
    }
  }

  update(units, camPos, time, dt) {
    this.time = time;
    this.frame++;
    const silHalf = this.frame % 2;
    for (const cls of Object.keys(this.buckets)) {
      const c = this.classes[cls];
      if (!c) continue;
      let list = this.buckets[cls];
      // 가끔 사라진 유닛을 목록에서 덜어낸다 (증원이 계속 들어와도 루프 길이 유지)
      if ((this.frame & 127) === 0 && list.length > 64) {
        list = list.filter((u) => !u.removed);
        this.buckets[cls] = list;
        c.units = list;
      }

      /* 1) 카메라 거리부터 잰다 — 상세 슬롯을 "가까운 순서"로 주려면 먼저 거리가 필요하다.
            (예전엔 목록(=스폰) 순서로 슬롯을 나눠 줘서, 멀리 있는 병사가 슬롯을 다 차지하고
             코앞의 병사가 파란 블록 실루엣으로 떨어졌다) */
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u.removed || u.hideModel) {
          u._d2 = Infinity;
          if (u._tier !== -2) {
            this.releaseDetail(u);
            if (u.slot != null && u.slot >= 0) { c.silhouette.setMatrixAt(u.slot, _hiddenM); c.silhouetteM.setMatrixAt(u.slot, _hiddenM); }
            u._tier = -2;
          }
          // 시체가 완전히 사라진 뒤에는 실루엣 자리를 다음 병사에게 넘긴다
          if (u.removed && !u._slotFreed) {
            u._slotFreed = true;
            if (u.slot != null && u.slot >= 0) { c.freeSil.push(u.slot); u.slot = -1; }
          }
          continue;
        }
        const dx = u.x - camPos.x, dz = u.z - camPos.z;
        u._d2 = dx * dx + dz * dz;
        // 숨겨졌던 유닛(디버그·관전 전환)이 다시 그려지도록 상세 배정을 되살린다
        if (u._tier === -2) u._tier = -1;
        const lodNear = this.lodNear || 15, lodFar = this.lodFar || 36;
        u._want = (u.isPlayer || u._d2 < lodNear * lodNear) ? 0 : (u._d2 < lodFar * lodFar ? 1 : 2);
      }

      /* 2) 상세 모델 슬롯 배정 — 카메라에서 가까운 유닛이 무조건 먼저.
            멀어진 유닛은 슬롯을 반납하고, 예산이 꽉 차면 아주 가까운(22m 이내) 유닛이
            가장 멀리 있는 보유자의 슬롯을 빼앗아 온다. */
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u._tier === -2) continue;
        if (u._want === 2 && u.dslot >= 0) this.releaseDetail(u);
      }
      c.want = c.want || [];
      c.want.length = 0;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u._tier === -2 || u._want === 2 || u.dslot >= 0) continue;
        c.want.push(u);
      }
      if (c.want.length) {
        c.want.sort((a, b) => a._d2 - b._d2);
        for (let k = 0; k < c.want.length; k++) {
          const u = c.want[k];
          if (u.dslot >= 0) continue;
          if (c.free.length) {
            u.dslot = c.free.pop();
            u._tier = -1;
            this.paintDetail(u, cls, u.dslot);
            continue;
          }
          if (u._d2 > 22 * 22) break;          // 22m 밖은 실루엣으로 둔다
          let far = null, farD = -1;
          for (let h = 0; h < list.length; h++) {
            const q = list[h];
            if (q.dslot < 0 || q === u || q._tier === -2) continue;
            if (q._d2 > farD) { farD = q._d2; far = q; }
          }
          if (!far || farD <= u._d2) break;
          const slot = far.dslot;
          far.dslot = -1; far._tier = -1;
          u.dslot = slot; u._tier = -1;
          this.paintDetail(u, cls, slot);
        }
      }

      /* 3) 그리기 — 상세 슬롯을 가진 유닛은 상세 모델, 나머지는 실루엣.
            이번 프레임에 실제로 쓰인 LOD(가장 가까운 단계)와 실루엣 유무를 모아
            쓰이지 않는 파츠 메시·실루엣의 드로우콜을 통째로 끈다. */
      let bestTier = 3, silUsed = false, sevBits = 0, detailUsed = false;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u._tier === -2) continue;
        if (u.dslot >= 0 && u._want < 2) {
          const tier = u._want;
          this.solveFK(u);
          this.writeParts(u, tier, time);
          if (u._tier !== tier) {
            for (const p of c.parts) p.instanceMatrix.needsUpdate = true;
            u._tier = tier;
          }
          if (u.slot != null && u.slot >= 0) { c.silhouette.setMatrixAt(u.slot, _hiddenM); c.silhouetteM.setMatrixAt(u.slot, _hiddenM); }
          if (tier < bestTier) bestTier = tier;
          if (u.sevMask) sevBits |= u.sevMask;
          detailUsed = true;
          continue;
        }
        // 실루엣 (2프레임 분산 업데이트) — 포즈를 계산하지 않으므로 yaw·사망 기울기만 쓴다
        u._tier = 2;
        if (u.slot != null && u.slot >= 0) {
          silUsed = true;
          if (((i + silHalf) & 1) === 0) {
            _e.set(u.dead ? 1.36 : 0, u.yaw || 0, 0, 'YXZ');
            _q.setFromEuler(_e);
            _v.set(u.x, u.y || 0, u.z);
            _s.set(u.scale || 1, u.scale || 1, u.scale || 1);
            u.rootMat.compose(_v, _q, _s);
            c.silhouette.setMatrixAt(u.slot, u.rootMat);
            c.silhouetteM.setMatrixAt(u.slot, u.rootMat);
          }
        }
      }
      /* 이번 프레임에 쓰이지 않은 파츠는 그리지 않는다 (인스턴스 행렬은 그대로 두고 visible 만 끈다) */
      const maxVisibleLod = bestTier >= 3 ? -1 : (2 - bestTier);
      for (const p of c.parts) {
        const so = p.userData.sevOnly;
        const want = so ? ((sevBits & so) !== 0) : (p.userData.lod <= maxVisibleLod);
        if (p.visible !== want) p.visible = want;
        if (want) p.instanceMatrix.needsUpdate = true;
      }
      if (c.silhouette.visible !== silUsed) c.silhouette.visible = silUsed;
      if (c.silhouetteM.visible !== silUsed) c.silhouetteM.visible = silUsed;
      if (silUsed) c.silhouette.instanceMatrix.needsUpdate = true;
      if (silUsed) c.silhouetteM.instanceMatrix.needsUpdate = true;
      c.detailUsed = detailUsed;
    }
    for (const sh of clothShaders) if (sh.uniforms && sh.uniforms.uTime) sh.uniforms.uTime.value = time;
  }

  dispose() {
    for (const k in this.classes) {
      const c = this.classes[k];
      for (const p of c.parts) {
        p.geometry.dispose();
        if (p.dispose) p.dispose();          // 인스턴스 버퍼(instanceMatrix/instanceColor)까지 GPU에서 해제
        this.scene.remove(p);
      }
      for (const m of [c.silhouette, c.silhouetteM]) {
        if (!m) continue;
        m.geometry.dispose();
        if (m.dispose) m.dispose();
        this.scene.remove(m);
      }
    }
    this.classes = {};
    this.buckets = { soldier: [], elite: [], knight: [], wizard: [], blademaster: [], berserker: [] };
  }
}

const _hiddenM = new THREE.Matrix4().makeScale(0, 0, 0);
const _spinQ = new THREE.Quaternion();
const _axisY = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _outMat = new THREE.Matrix4();
const _scaleM = new THREE.Matrix4();

export function makeUnitPoseBuffers() {
  return {
    rot: new Float32Array(JOINT_COUNT * 3),
    root: new Float32Array(3),
    rootAdd: new Float32Array(3)
  };
}

export function makeUnitJoints() {
  const joints = [];
  for (let i = 0; i < JOINT_COUNT; i++) joints.push(new THREE.Matrix4());
  return joints;
}

/* 유닛 하나가 쓰는 포즈/행렬/쿼터니언 버퍼 */
export function makeUnitRig() {
  const pose = makeUnitPoseBuffers();
  pose.root = new Float32Array(3);
  pose.rootAdd = new Float32Array(3);
  const q = [];
  for (let i = 0; i < JOINT_COUNT; i++) q.push(new THREE.Quaternion());
  return {
    pose,
    joints: makeUnitJoints(),
    _jq: q,
    _jm: makeUnitJoints(),
    rootMat: new THREE.Matrix4()
  };
}
