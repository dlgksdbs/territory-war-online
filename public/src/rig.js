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

function clothMaterial(color, opts) {
  const o = opts || {};
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: o.roughness === undefined ? 0.88 : o.roughness,
    metalness: 0.02,
    sheen: o.sheen === undefined ? 0.85 : o.sheen,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(o.sheenColor === undefined ? 0xffffff : o.sheenColor),
    envMapIntensity: 0.35,
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
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
  // 판금 이음매(테두리 함몰)
  x.strokeStyle = 'rgba(40,40,40,0.9)'; x.lineWidth = 7;
  x.strokeRect(6, 6, S - 12, S - 12);
  x.strokeStyle = 'rgba(190,190,190,0.55)'; x.lineWidth = 3;
  x.strokeRect(12, 12, S - 24, S - 24);
  // 중앙 능선
  x.strokeStyle = 'rgba(210,210,210,0.65)'; x.lineWidth = 5;
  x.beginPath(); x.moveTo(S / 2, 24); x.lineTo(S / 2, S - 24); x.stroke();
  x.strokeStyle = 'rgba(50,50,50,0.55)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(S / 2 + 4, 24); x.lineTo(S / 2 + 4, S - 24); x.stroke();
  // 리벳
  const rng = mulberry32(41);
  for (let i = 0; i < 10; i++) {
    const px = 26 + rng() * (S - 52), py = 26 + rng() * (S - 52);
    const g = x.createRadialGradient(px - 1, py - 1, 0, px, py, 5);
    g.addColorStop(0, 'rgba(240,240,240,0.95)');
    g.addColorStop(0.65, 'rgba(120,120,120,0.6)');
    g.addColorStop(1, 'rgba(90,90,90,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, 5, 0, 7); x.fill();
  }
  // 단조 자국
  for (let i = 0; i < 260; i++) {
    const px = rng() * S, py = rng() * S, rr = 2 + rng() * 6;
    x.fillStyle = `rgba(${110 + rng() * 60},${110 + rng() * 60},${110 + rng() * 60},0.22)`;
    x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  return texFrom(normalFromCanvas(c, 2.4), { srgb: false });
}

function buildMaterials() {
  const mn = metalNormalMap();
  const an = armorNormalMap();
  const wood = woodMaps().map;
  const M = {
    steel: new THREE.MeshPhysicalMaterial({
      color: 0xb4bdc9, metalness: 0.62, roughness: 0.40, normalMap: an,
      normalScale: new THREE.Vector2(0.85, 0.85), envMapIntensity: 0.8,
      clearcoat: 0.22, clearcoatRoughness: 0.3
    }),
    darkSteel: new THREE.MeshPhysicalMaterial({
      color: 0x4e5763, metalness: 0.62, roughness: 0.48, normalMap: mn,
      normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.75
    }),
    blackIron: new THREE.MeshStandardMaterial({
      color: 0x24262c, metalness: 0.55, roughness: 0.58, envMapIntensity: 0.6
    }),
    gold: new THREE.MeshPhysicalMaterial({
      color: 0xd2a249, metalness: 0.82, roughness: 0.30, envMapIntensity: 1.1, normalMap: mn,
      normalScale: new THREE.Vector2(0.4, 0.4),
      clearcoat: 0.35, clearcoatRoughness: 0.2
    }),
    bronze: new THREE.MeshStandardMaterial({
      color: 0xa9763c, metalness: 1.0, roughness: 0.34, envMapIntensity: 1.3
    }),
    leather: new THREE.MeshStandardMaterial({
      color: 0x4e3624, roughness: 0.78, metalness: 0.05, envMapIntensity: 0.4
    }),
    darkLeather: new THREE.MeshStandardMaterial({
      color: 0x2e2119, roughness: 0.7, metalness: 0.08, envMapIntensity: 0.4
    }),
    skin: new THREE.MeshStandardMaterial({
      color: 0xd3a184, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.4
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
      color: 0xffffff, roughness: 0.9, metalness: 0.1, envMapIntensity: 0.5
    })
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
    case 'cap': g = new THREE.CapsuleGeometry(0.5, 1, 3, 8); break;
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
    shape('box', [0, 0.02, 0], [0, 0, 0], [0.40, 0.34, 0.25]),          // 튜닉
    shape('box', [0.20, 0.06, 0], [0, 0, -0.10], [0.10, 0.28, 0.22]),    // 옆구리 천
    shape('box', [-0.20, 0.06, 0], [0, 0, 0.10], [0.10, 0.28, 0.22])
  ]);
  add('chest', 'steel', 0, [
    shape('sph', [0, 0.045, 0.02], [0, 0, 0], [0.40, 0.35, 0.30]),       // 둥근 흉갑(가슴 곡면)
    shape('box', [0, 0.11, 0.132], [0.10, 0, 0], [0.26, 0.14, 0.03]),    // 가슴 판
    shape('box', [0, -0.055, 0.125], [0.16, 0, 0], [0.28, 0.09, 0.035]), // 배 판
    shape('cyl', [0, 0.19, 0], [0, 0, 0], [0.22, 0.055, 0.20]),          // 목 가드
    shape('box', [0, 0.06, 0.175], [0, 0, 0], [0.028, 0.17, 0.02]),      // 중앙 능선
    shape('box', [-0.175, 0.02, 0], [0, 0, 0.16], [0.055, 0.22, 0.22]),  // 겨드랑이 판
    shape('box', [0.175, 0.02, 0], [0, 0, -0.16], [0.055, 0.22, 0.22])
  ]);
  add('chest', 'gold', 2, [
    shape('sph', [-0.135, 0.115, 0.128], [0, 0, 0], [0.026, 0.026, 0.014]),  // 리벳
    shape('sph', [0.135, 0.115, 0.128], [0, 0, 0], [0.026, 0.026, 0.014]),
    shape('sph', [-0.115, 0.0, 0.142], [0, 0, 0], [0.022, 0.022, 0.012]),
    shape('sph', [0.115, 0.0, 0.142], [0, 0, 0], [0.022, 0.022, 0.012]),
    shape('box', [0, -0.012, 0.148], [0, 0, 0], [0.05, 0.02, 0.012])          // 버클 판
  ]);
  add('chest', 'leather', 2, [
    shape('box', [0.13, 0.06, 0.145], [0, 0, -0.62], [0.045, 0.26, 0.02]),  // 가죽끈 X
    shape('box', [-0.13, 0.06, 0.145], [0, 0, 0.62], [0.045, 0.26, 0.02])
  ]);
  add('chest', 'gold', 2, [
    shape('box', [0, 0.20, 0.10], [0.2, 0, 0], [0.05, 0.05, 0.03])
  ]);
  add('spine', 'steel', 1, [
    shape('box', [0, 0.02, 0], [0, 0, 0], [0.34, 0.18, 0.23]),           // 복갑
  ]);
  add('spine', 'clothHeavy', 2, [
    shape('box', [0, -0.03, 0], [0, 0, 0], [0.37, 0.14, 0.25])
  ]);
  add('pelvis', 'leather', 1, [
    shape('box', [0, 0.03, 0], [0, 0, 0], [0.37, 0.09, 0.26]),           // 벨트
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

  /* ── 머리: 철 투구 + 코가드 ──────────────────────────────────── */
  add('head', 'skin', 1, [
    shape('sph', [0, 0.055, 0.005], [0, 0, 0], [0.19, 0.21, 0.19]),      // 얼굴
    shape('box', [0, -0.015, 0.09], [0, 0, 0], [0.09, 0.06, 0.03])        // 턱
  ]);
  add('head', 'steel', 0, [
    shape('dome', [0, 0.075, -0.002], [0, 0, 0], [0.245, 0.27, 0.245]),   // 투구
    shape('cyl', [0, 0.045, 0], [0, 0, 0], [0.255, 0.028, 0.255]),        // 투구 테
    shape('box', [0, 0.0, 0.105], [0.05, 0, 0], [0.026, 0.13, 0.03]),     // 코가드
    shape('box', [-0.115, 0.02, 0.055], [0, 0.25, 0], [0.04, 0.13, 0.10]),// 볼가리개
    shape('box', [0.115, 0.02, 0.055], [0, -0.25, 0], [0.04, 0.13, 0.10])
  ]);
  add('head', 'darkSteel', 1, [
    shape('box', [0, 0.225, -0.01], [0, 0, 0], [0.035, 0.09, 0.17])       // 볏등
  ]);
  add('head', 'cloth', 2, [
    shape('box', [0, 0.02, -0.10], [0.2, 0, 0], [0.18, 0.12, 0.06])       // 목덜미 천
  ]);

  /* ── 어깨·팔 ─────────────────────────────────────────────────── */
  add('armR', 'steel', 0, [
    shape('sph', [0.02, 0.02, 0], [0, 0, 0.1], [0.21, 0.17, 0.21]),       // 견갑
    shape('box', [0.015, -0.02, 0], [0, 0, 0.06], [0.19, 0.05, 0.20])     // 견갑 테
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
    shape('sph', [-0.02, 0.02, 0], [0, 0, -0.1], [0.21, 0.17, 0.21]),
    shape('box', [-0.015, -0.02, 0], [0, 0, -0.06], [0.19, 0.05, 0.20])
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
    add('foot' + side, 'leather', 1, [
      shape('box', [0, -0.02, 0.03], [0, 0, 0], [0.12, 0.10, 0.24])        // 부츠
    ]);
    add('foot' + side, 'steel', 2, [
      shape('box', [0, -0.03, 0.13], [0, 0, 0], [0.115, 0.07, 0.10])
    ]);
  };
  leg('R'); leg('L');

  /* ── 검 ──────────────────────────────────────────────────────── */
  add('handR', 'darkLeather', 1, [
    shape('cyl', [0, 0, -0.06], [Math.PI / 2, 0, 0], [0.052, 0.17, 0.052])  // 손잡이
  ]);
  add('handR', 'gold', 0, [
    shape('sph', [0, 0, -0.155], [0, 0, 0], [0.062, 0.062, 0.055]),        // 폼멜
    shape('box', [0, 0, 0.032], [0, 0, 0], [0.235, 0.034, 0.048]),          // 가드
    shape('cyl', [0, 0, 0.012], [Math.PI / 2, 0, 0], [0.05, 0.05, 0.02]),   // 가드 목
    shape('box', [-0.115, 0, 0.045], [0, 0, 0.35], [0.05, 0.03, 0.04]),     // 가드 끝 굽힘
    shape('box', [0.115, 0, 0.045], [0, 0, -0.35], [0.05, 0.03, 0.04])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 0.48], [0, 0, 0], [0.058, 0.016, 0.80]),            // 날
    shape('cone6', [0, 0, 0.94], [Math.PI / 2, 0, 0], [0.058, 0.16, 0.032]) // 칼끝
  ]);
  add('handR', 'darkSteel', 2, [
    shape('box', [0, 0, 0.47], [0, 0, 0], [0.016, 0.019, 0.72])             // 홈
  ]);
  return P;
}

function knightParts() {
  const P = [];
  const add = (joint, mat, lod, shapes, extra) => P.push(Object.assign({ joint, mat, lod, shapes }, extra || {}));

  /* ── 중갑 몸통 ───────────────────────────────────────────────── */
  add('chest', 'steel', 0, [
    shape('box', [0, 0.03, 0], [0, 0, 0], [0.54, 0.36, 0.34]),              // 흉갑
    shape('box', [0, 0.13, 0.175], [0.08, 0, 0], [0.34, 0.15, 0.05]),       // 가슴 판
    shape('box', [0, 0.20, 0], [0, 0, 0], [0.30, 0.10, 0.30]),              // 목 가드
    shape('box', [-0.235, 0.02, 0], [0, 0, 0.12], [0.09, 0.30, 0.30]),      // 겨드랑이
    shape('box', [0.235, 0.02, 0], [0, 0, -0.12], [0.09, 0.30, 0.30])
  ]);
  add('chest', 'darkSteel', 1, [
    shape('box', [0, -0.09, 0.155], [0.20, 0, 0], [0.42, 0.10, 0.05]),      // 배 판 겹
    shape('box', [0, 0.03, 0.185], [0, 0, 0], [0.02, 0.22, 0.02])
  ]);
  add('chest', 'gold', 1, [
    shape('box', [0, 0.10, 0.205], [0, 0, 0], [0.11, 0.11, 0.02]),          // 문장
    shape('box', [0, 0.10, 0.205], [0, 0, 0.5], [0.15, 0.03, 0.02]),
    shape('box', [0, 0.235, 0], [0, 0, 0], [0.26, 0.03, 0.03])              // 목 테
  ]);
  add('spine', 'steel', 1, [
    shape('box', [0, 0.02, 0], [0, 0, 0], [0.44, 0.20, 0.30])
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
    shape('box', [0, -0.10, 0.13], [0.10, 0, 0], [0.30, 0.16, 0.06])        // 앞 허벅지 판
  ]);
  add('pelvis', 'clothHeavy', 1, [
    shape('box', [0, -0.20, 0], [0, 0, 0], [0.46, 0.20, 0.34])              // 군의
  ]);

  /* ── 대형 투구 ───────────────────────────────────────────────── */
  add('head', 'steel', 0, [
    shape('dome', [0, 0.075, 0], [0, 0, 0], [0.31, 0.36, 0.32]),           // 투구 통(둥근 정수리)
    shape('box', [0, 0.02, 0.132], [0, 0, 0], [0.245, 0.19, 0.09]),         // 면갑
    shape('box', [0, -0.045, 0.115], [0.3, 0, 0], [0.22, 0.07, 0.08]),      // 턱 가리개
    shape('cyl', [0, -0.03, 0], [0, 0, 0], [0.33, 0.06, 0.34]),             // 턱받이
    shape('box', [0, 0.235, 0], [0, 0, 0], [0.05, 0.07, 0.22]),             // 볏대
    shape('box', [0, 0.075, 0.16], [0, 0, 0], [0.03, 0.20, 0.03])           // 면갑 능선
  ]);
  add('head', 'blackIron', 1, [
    shape('box', [0, 0.075, 0.178], [0, 0, 0], [0.17, 0.022, 0.02]),        // 눈 틈
    shape('box', [-0.07, 0.075, 0.179], [0, 0, 0.35], [0.05, 0.018, 0.02]),
    shape('box', [0.07, 0.075, 0.179], [0, 0, -0.35], [0.05, 0.018, 0.02]),
    shape('box', [0, -0.02, 0.182], [0, 0, 0], [0.05, 0.09, 0.02])          // 숨구멍
  ]);
  add('head', 'gold', 1, [
    shape('box', [0, 0.205, 0.02], [0, 0, 0], [0.30, 0.035, 0.22])          // 이마 금장
  ]);
  add('head', 'plume', 0, [
    shape('box', [0, 0.33, -0.03], [0.24, 0, 0], [0.09, 0.18, 0.40]),       // 볏 깃
    shape('box', [0, 0.40, -0.24], [0.75, 0, 0], [0.07, 0.10, 0.28])
  ]);

  /* ── 어깨·팔 ─────────────────────────────────────────────────── */
  const arm = (side) => {
    const sx = side === 'R' ? 1 : -1;
    add('arm' + side, 'steel', 0, [
      shape('sph', [0.025 * sx, 0.03, 0], [0, 0, 0.12 * sx], [0.40, 0.26, 0.40]),  // 대형 견갑
      shape('sph', [0.035 * sx, -0.07, 0], [0, 0, 0.1 * sx], [0.34, 0.16, 0.34]),  // 2단
      shape('sph', [0.045 * sx, -0.135, 0], [0, 0, 0.08 * sx], [0.29, 0.11, 0.29]),// 3단 겹판
      shape('cap', [0, -0.19, 0], [0, 0, 0], [0.185, 0.22, 0.185])
    ]);
    add('arm' + side, 'gold', 2, [
      shape('torus', [0.035 * sx, -0.10, 0], [0, 0, 0.1 * sx], [0.35, 0.17, 0.35])
    ]);
    add('arm' + side, 'gold', 2, [
      shape('torus', [0.025 * sx, 0.03, 0], [0, 0, 0.12 * sx], [0.42, 0.28, 0.42])
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
    add('foot' + side, 'darkSteel', 1, [
      shape('box', [0, -0.02, 0.06], [0, 0, 0], [0.16, 0.12, 0.32])
    ]);
  };
  leg('R'); leg('L');

  /* ── 큰 망치 ─────────────────────────────────────────────────── */
  add('handR', 'woodDark', 0, [
    shape('cyl', [0, 0, 0.44], [Math.PI / 2, 0, 0], [0.08, 1.78, 0.08])
  ]);
  add('handR', 'darkLeather', 1, [
    shape('cyl', [0, 0, -0.02], [Math.PI / 2, 0, 0], [0.10, 0.34, 0.10]),
    shape('cyl', [0, 0, 0.36], [Math.PI / 2, 0, 0], [0.098, 0.20, 0.098])
  ]);
  add('handR', 'steel', 0, [
    shape('box', [0, 0, 1.36], [0, 0, 0], [0.56, 0.36, 0.36]),              // 머리
    shape('box', [0, 0, 1.56], [0, 0, 0], [0.46, 0.28, 0.10]),              // 타격면
    shape('box', [0, 0, 1.15], [0, 0, 0], [0.40, 0.26, 0.10]),              // 뒤꽁무니
    shape('cone', [0, 0, 1.72], [0, 0, 0], [0.14, 0.30, 0.14]),             // 스파이크
    shape('box', [0, 0.19, 1.36], [0, 0, 0], [0.50, 0.04, 0.30])            // 상단 판
  ]);
  add('handR', 'gold', 1, [
    shape('box', [0, 0, 1.19], [0, 0, 0], [0.44, 0.30, 0.05]),
    shape('box', [0, 0, 1.53], [0, 0, 0], [0.46, 0.28, 0.05]),
    shape('box', [0, 0.185, 1.36], [0.18, 0, 0], [0.52, 0.03, 0.34]),       // 머리 테
    shape('sph', [0, 0, -0.21], [0, 0, 0], [0.10, 0.10, 0.10])
  ]);
  add('handR', 'darkSteel', 2, [
    shape('cone6', [0.30, 0, 1.36], [0, 0, -Math.PI / 2], [0.10, 0.16, 0.10]),  // 옆 날개
    shape('cone6', [-0.30, 0, 1.36], [0, 0, Math.PI / 2], [0.10, 0.16, 0.10]),
    shape('box', [0, 0, 1.30], [0, 0, 0], [0.12, 0.40, 0.06])                    // 쐐기 고정
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
    shape('cyl', [0, -0.72, 0], [0, 0, 0], [0.94, 0.22, 0.90])              // 밑단
  ]);
  add('pelvis', 'gold', 1, [
    shape('torus', [0, -0.84, 0], [Math.PI / 2, 0, 0], [0.98, 0.98, 0.98])  // 밑단 금장
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
    shape('box', [0, -0.04, -0.16], [0.3, 0, 0], [0.30, 0.26, 0.06])        // 후드 뒤
  ]);
  add('head', 'blackIron', 1, [
    shape('sph', [0, 0.06, 0.075], [0, 0, 0], [0.22, 0.23, 0.14])           // 그림자 얼굴
  ]);
  add('head', 'eye', 1, [
    shape('sph', [0.05, 0.085, 0.128], [0, 0, 0], [0.036, 0.030, 0.02]),
    shape('sph', [-0.05, 0.085, 0.128], [0, 0, 0], [0.036, 0.030, 0.02])
  ]);
  add('head', 'gold', 2, [
    shape('torus', [0, 0.19, -0.03], [Math.PI / 2, 0, 0], [0.73, 0.73, 0.73]),
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
  add('handR', 'rune', 2, [
    shape('plane', [0, -0.055, 0.145], [0, 0, 0], [0.42, 0.42, 1])
  ], { spin: { axis: 'z', speed: -0.8 } });

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
    shape('sph', [0, 1.00, 0.02], [0, 0, 0], [0.21, 0.21, 0.21])
  ], { spin: { axis: 'y', speed: 0.8 } });
  add('handL', 'rune', 1, [
    shape('plane', [0, 1.00, 0.02], [-Math.PI / 2, 0, 0], [0.66, 0.66, 1])
  ], { spin: { axis: 'y', speed: -1.5 } });

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
  add('chest', 'gold', 2, [
    shape('box', [-0.15, 0.20, 0.08], [0, 0, 0], [0.05, 0.05, 0.03])        // 매화 장식
  ]);
  add('spine', 'kimono', 0, [
    shape('box', [0, 0.02, 0], [0, 0, 0], [0.36, 0.22, 0.24])
  ]);
  add('spine', 'clothHeavy', 0, [
    shape('box', [0, -0.02, 0.0], [0, 0, 0], [0.40, 0.10, 0.27])            // 오비(허리띠)
  ]);
  add('pelvis', 'kimono', 0, [
    shape('cyl', [0, -0.26, 0], [0, 0, 0], [0.66, 0.62, 0.60]),             // 하카마
    shape('cyl', [0, -0.62, 0], [0, 0, 0], [0.78, 0.18, 0.72])
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
  /* 칼집 — 왼쪽 허리 */
  add('pelvis', 'blackIron', 1, [
    shape('box', [-0.26, -0.10, -0.02], [0.42, 0.10, 0.30], [0.05, 0.05, 0.86])
  ]);
  add('pelvis', 'gold', 2, [
    shape('box', [-0.26, -0.055, 0.30], [0.42, 0.10, 0.30], [0.055, 0.055, 0.03])
  ]);
  return P;
}

const PART_BUILDERS = { soldier: soldierParts, knight: knightParts, wizard: wizardParts, blademaster: blademasterParts };

function silhouetteShapes(cls, parts) {
  // 원거리용: 실루엣만 남긴 단순 형상 (몸통·머리·다리·무기)
  if (cls === 'knight') {
    return [
      shape('box', [0, 1.25, 0], [0, 0, 0], [0.55, 0.62, 0.38]),
      shape('sph', [0, 1.68, 0], [0, 0, 0], [0.30, 0.32, 0.30]),
      shape('box', [0, 0.62, -0.06], [0, 0, 0], [0.50, 0.28, 0.44]),
      shape('cap', [-0.13, 0.42, 0], [0, 0, 0], [0.20, 0.55, 0.20]),
      shape('cap', [0.13, 0.42, 0], [0, 0, 0], [0.20, 0.55, 0.20]),
      shape('box', [0, 1.18, -0.30], [0.1, 0, 0], [0.64, 1.05, 0.05]),
      shape('box', [0.34, 1.15, 0.30], [0.5, 0, 0], [0.16, 0.16, 1.65])
    ];
  }
  if (cls === 'blademaster') {
    return [
      shape('box', [0, 1.18, 0], [0, 0, 0], [0.40, 0.52, 0.28]),
      shape('sph', [0, 1.60, 0], [0, 0, 0], [0.22, 0.24, 0.22]),
      shape('cyl', [0, 0.62, 0], [0, 0, 0], [0.62, 0.62, 0.56]),
      shape('cap', [-0.10, 0.38, 0], [0, 0, 0], [0.17, 0.50, 0.17]),
      shape('cap', [0.10, 0.38, 0], [0, 0, 0], [0.17, 0.50, 0.17]),
      shape('box', [0.30, 1.15, 0.34], [0.35, 0, 0], [0.05, 0.05, 1.25])
    ];
  }
  if (cls === 'wizard') {
    return [
      shape('cyl', [0, 1.15, 0], [0, 0, 0], [0.46, 0.62, 0.44]),
      shape('cone', [0, 0.55, 0], [0, 0, 0], [0.86, 1.10, 0.80]),
      shape('sph', [0, 1.66, 0], [0, 0, 0], [0.30, 0.34, 0.30]),
      shape('cone', [0, 1.92, -0.03], [0.12, 0, 0], [0.36, 0.6, 0.36]),
      shape('cyl', [-0.32, 1.10, 0.16], [0.08, 0, 0], [0.055, 1.9, 0.055]),
      shape('sph', [-0.32, 2.04, 0.16], [0, 0, 0], [0.20, 0.20, 0.20])
    ];
  }
  return [
    shape('box', [0, 1.20, 0], [0, 0, 0], [0.42, 0.56, 0.28]),
    shape('sph', [0, 1.60, 0], [0, 0, 0], [0.22, 0.24, 0.22]),
    shape('box', [0, 0.52, 0], [0, 0, 0], [0.36, 0.20, 0.26]),
    shape('cap', [-0.10, 0.40, 0], [0, 0, 0], [0.15, 0.62, 0.15]),
    shape('cap', [0.10, 0.40, 0], [0, 0, 0], [0.15, 0.62, 0.15]),
    shape('box', [0.26, 1.05, 0.12], [0.5, 0, 0], [0.06, 0.06, 1.0])
  ];
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
    this.buckets = { soldier: [], knight: [], wizard: [], blademaster: [] };
    this.detailCap = this.opts.detailCap || 170;
    this.detailSet = null;
  }

  build(buckets, caps) {
    for (const cls of Object.keys(this.buckets)) {
      const units = buckets[cls] || [];
      const want = Math.max(units.length, (caps && caps[cls]) || 0);
      if (!want) continue;
      const cap = want;
      const dcap = Math.min(cap, this.detailCap);
      this.buckets[cls] = units;
      const defs = PART_BUILDERS[cls]();
      const groups = new Map();
      for (const d of defs) {
        const key = d.joint + '|' + d.mat + '|' + d.lod + '|' + (d.spin ? 'spin' : '');
        if (!groups.has(key)) groups.set(key, { joint: d.joint, mat: d.mat, lod: d.lod, spin: d.spin, shapes: [] });
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
      const silGeo = mergeShapes(silhouetteShapes(cls));
      const sil = new THREE.InstancedMesh(silGeo, this.mats.silhouette, cap);
      sil.frustumCulled = false;
      sil.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < cap; i++) sil.setMatrixAt(i, _hiddenM);
      const cc = new THREE.Color(1, 1, 1);
      for (let i = 0; i < cap; i++) sil.setColorAt(i, cc);
      sil.instanceColor.needsUpdate = true;
      this.scene.add(sil);
      const free = [];
      for (let i = dcap - 1; i >= 0; i--) free.push(i);
      // 예비 병력이 나중에 들어올 자리 (실루엣 슬롯)
      const freeSil = [];
      for (let i = cap - 1; i >= units.length; i--) freeSil.push(i);
      this.classes[cls] = { cap, dcap, parts, silhouette: sil, units, free, freeSil, next: 0 };
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
    if (u.slot >= 0) c.silhouette.setMatrixAt(u.slot, _hiddenM);
    c.units.push(u);
    this.buckets[cls].push(u);
    this.paintSilhouette(u, cls);
    return true;
  }

  teamColorFor(u, cls, kind) {
    const team = TEAM[u.team] || TEAM.ally;
    const rng = mulberry32((u.mirror || u.id || 1) * 977 + 13);
    const vary = 0.86 + rng() * 0.26;
    if (kind === 'cloth') return new THREE.Color(team.cloth).multiplyScalar(vary);
    if (kind === 'robe') return new THREE.Color(u.team === 'enemy' ? 0x5c2440 : 0x2a3f66).multiplyScalar(vary);
    if (kind === 'plume') return new THREE.Color(u.team === 'enemy' ? 0x8a1d1d : 0x3f6f9c);
    if (kind === 'trim') return new THREE.Color(u.team === 'enemy' ? 0xc08a3a : 0xb9cfe8);
    if (kind === 'steel') return new THREE.Color(0.86 + rng() * 0.2, 0.86 + rng() * 0.2, 0.9 + rng() * 0.18);
    return new THREE.Color(1, 1, 1);
  }

  paintSilhouette(u, cls) {
    const c = this.classes[cls];
    if (!c) return;
    const col = this.teamColorFor(u, cls, 'cloth').multiplyScalar(0.9);
    c.silhouette.setColorAt(u.slot, col);
    c.silhouette.instanceColor.needsUpdate = true;
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
    if (u.slot != null) c.silhouette.setMatrixAt(u.slot, _hiddenM);
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
    for (const p of c.parts) {
      const lod = p.userData.lod;
      if (lod > tier + 1) { p.setMatrixAt(slot, _hiddenM); continue; }
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
            if (u.slot != null && u.slot >= 0) c.silhouette.setMatrixAt(u.slot, _hiddenM);
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
        u._want = (u.isPlayer || u._d2 < 15 * 15) ? 0 : (u._d2 < 36 * 36 ? 1 : 2);
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

      /* 3) 그리기 — 상세 슬롯을 가진 유닛은 상세 모델, 나머지는 실루엣 */
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
          if (u.slot != null && u.slot >= 0) c.silhouette.setMatrixAt(u.slot, _hiddenM);
          continue;
        }
        // 실루엣 (2프레임 분산 업데이트)
        u._tier = 2;
        if (u.slot != null && u.slot >= 0 && ((i + silHalf) & 1) === 0) {
          _e.set(u.pose.rot[0], u.pose.rot[1], u.pose.rot[2], 'YXZ');
          _q.setFromEuler(_e);
          _v.set(u.x, u.y || 0, u.z);
          _s.set(u.scale || 1, u.scale || 1, u.scale || 1);
          u.rootMat.compose(_v, _q, _s);
          c.silhouette.setMatrixAt(u.slot, u.rootMat);
        }
      }
      for (const p of c.parts) p.instanceMatrix.needsUpdate = true;
      c.silhouette.instanceMatrix.needsUpdate = true;
    }
    for (const sh of clothShaders) if (sh.uniforms && sh.uniforms.uTime) sh.uniforms.uTime.value = time;
  }

  dispose() {
    for (const k in this.classes) {
      const c = this.classes[k];
      for (const p of c.parts) { p.geometry.dispose(); this.scene.remove(p); }
      c.silhouette.geometry.dispose(); this.scene.remove(c.silhouette);
    }
    this.classes = {};
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
