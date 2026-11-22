/* =============================================================================
   직접 참전 · 3D 칼싸움 전장 (Three.js WebGL 렌더러)
   - 1인칭(FPS) 시점: 카메라는 병사 눈높이(≈20)에 있고, 오른손 검 하나만
     화면 앞에 그린다(별도 뷰모델 패스). 방패는 없다 — 막기는 검을 옆으로
     가로질러 세우는 자세로 한다. 내 3인칭 몸은 그리지 않는다.
   - 베기는 대각선으로 내려쳤다가 아래에서 다시 위로 매끄럽게 올라온다.
     스와이프 베기면 그 스와이프 방향(각도)을 그대로 따라간다.
   - 시점 회전은 오른쪽 화면을 천천히 드래그할 때 (pl.face / pl.pitch).
     오른쪽 빠른 스와이프 = 그 방향으로 베기. 조이스틱 이동은 카메라를 돌리지 않는다.
   - 시뮬레이션은 arena.js 가 그대로 담당하고, 이 모듈은 그 상태(S)를 3D로 그린다.
   - 병사는 InstancedMesh 로 그린다 (지오메트리·재질 공유 → 드로우콜 수십 개로
     수십~수백 명을 그린다).
   - three 는 public/vendor/three.module.min.js 로컬 서빙 (외부 CDN 없음)
   - WebGL 을 못 쓰면 window.TWArena3D.supported() === false → arena.js 가 2D로 폴백
   - 노출: window.TWArena3D.create({ canvas, cfg, obstacles }) → 렌더러 객체
   ============================================================================= */
import * as THREE from './vendor/three.module.min.js';

const REV = THREE.REVISION;

const HAS_WEBGL = (function () {
  try {
    if (!window.WebGLRenderingContext) return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) {
    return false;
  }
})();

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t) => t * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function colorOf(hex, fallback) {
  try { return new THREE.Color(hex || fallback); } catch (e) { return new THREE.Color(fallback); }
}

const EYE = 20.5;               // 병사 눈높이 (월드 단위)
const MAX_SOLDIERS = 260;       // 동시에 그리는 병사 상한 (인스턴스 버퍼 크기 · 최대 1000명 난전용)
const ATK_DUR = 420;            // 1인칭 검 궤적 길이(ms) — 내려치기 + 위로 복귀
const MAX_ARCS = 72;            // 적·아군 검기/예고 인스턴스 상한
const MAX_PIECES = 26;          // 동시에 굴리는 3D 두 동강 조각 상한

/* ---------------------------------------------------------------------------
   공용 지오메트리 · 텍스처
   --------------------------------------------------------------------------- */
const GEO = {
  leg: new THREE.BoxGeometry(2.0, 8.6, 2.3),
  boot: new THREE.BoxGeometry(2.3, 1.7, 3.4),
  torso: new THREE.CylinderGeometry(4.1, 3.15, 10.5, 12, 1),
  shoulder: new THREE.SphereGeometry(1.85, 10, 8),
  neck: new THREE.CylinderGeometry(1.25, 1.25, 2.2, 8),
  head: new THREE.SphereGeometry(2.45, 12, 10),
  helmet: new THREE.SphereGeometry(2.95, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.56),
  visor: new THREE.BoxGeometry(4.7, 0.7, 0.9),
  sash: new THREE.BoxGeometry(6.2, 5.0, 0.9),
  crest: new THREE.BoxGeometry(0.7, 3.4, 1.1),
  upperArm: new THREE.BoxGeometry(1.95, 6.4, 1.95),
  foreArm: new THREE.BoxGeometry(1.7, 5.4, 1.7),
  blade: new THREE.BoxGeometry(0.62, 0.46, 10.5),
  guard: new THREE.BoxGeometry(3.2, 0.65, 0.85),
  grip: new THREE.BoxGeometry(0.95, 0.95, 2.4),
  ring: new THREE.RingGeometry(13, 15.4, 28),
  shadow: new THREE.PlaneGeometry(19, 19)
};

function radialTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const s of stops) g.addColorStop(s[0], s[1]);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const TEX = {
  shadow: radialTexture(64, [[0, 'rgba(0,0,0,0.62)'], [0.62, 'rgba(0,0,0,0.28)'], [1, 'rgba(0,0,0,0)']]),
  glow: radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,240,210,0.65)'], [1, 'rgba(255,220,160,0)']]),
  slash: (function () {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 256, 128);
    // 휘두른 자국: 얇게 시작해 두꺼워졌다가 사라지는 초승달
    for (let i = 0; i < 3; i++) {
      const g = x.createLinearGradient(0, 0, 256, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.3, 'rgba(220,240,255,' + (0.55 - i * 0.14) + ')');
      g.addColorStop(0.62, 'rgba(255,255,255,' + (0.95 - i * 0.22) + ')');
      g.addColorStop(0.9, 'rgba(210,235,255,' + (0.35 - i * 0.1) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.strokeStyle = g;
      x.lineWidth = 14 - i * 4;
      x.lineCap = 'round';
      x.beginPath();
      x.ellipse(128, 168, 132 - i * 7, 128 - i * 5, 0, Math.PI * 1.18, Math.PI * 1.82);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })(),
  core: (function () {
    /* 잘린 단면 — 피 대신 깨끗한 검은 심 + 푸른 빛 절단면 */
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 128, 256);
    x.save();
    x.translate(64, 128);
    x.scale(0.42, 0.46);
    x.translate(-64, -128);
    const g = x.createRadialGradient(64, 128, 6, 64, 128, 118);
    g.addColorStop(0, '#0a1522');
    g.addColorStop(0.55, '#0d2030');
    g.addColorStop(0.9, '#173a52');
    g.addColorStop(1, 'rgba(23,58,82,0)');
    x.fillStyle = g;
    x.beginPath();
    x.arc(64, 128, 118, 0, Math.PI * 2);
    x.fill();
    x.restore();
    x.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 22; i++) {
      x.strokeStyle = 'rgba(150,225,255,' + (0.03 + Math.random() * 0.09).toFixed(3) + ')';
      x.lineWidth = 1 + Math.random() * 2;
      x.beginPath();
      const yy = 30 + Math.random() * 200;
      x.moveTo(20, yy);
      x.bezierCurveTo(50, yy + (Math.random() - 0.5) * 16, 80, yy + (Math.random() - 0.5) * 16, 108, yy);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })()
};

/* 전장 바닥 텍스처 — 흙 · 풀 · 길 · 진영 색 띠 */
function terrainTexture(w, h, seed, meColor, enemyColor) {
  const areaK = clamp((w * h) / (280 * 600), 0.6, 4);
  const cw = clamp(Math.round(384 * Math.sqrt(areaK)), 384, 768);
  const ch = Math.round(cw * (h / w));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const b = c.getContext('2d');
  const r = mulberry32(seed >>> 0);

  const g = b.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, '#2f4438');
  g.addColorStop(0.3, '#293930');
  g.addColorStop(0.68, '#313a31');
  g.addColorStop(1, '#443224');
  b.fillStyle = g;
  b.fillRect(0, 0, cw, ch);

  // 가운데 흙바닥은 살짝 밝게 — 시선이 전장 안쪽으로 들어가며 깊어진다
  const cg = b.createRadialGradient(cw * 0.5, ch * 0.52, 20, cw * 0.5, ch * 0.52, cw * 0.78);
  cg.addColorStop(0, 'rgba(150,136,104,0.1)');
  cg.addColorStop(1, 'rgba(150,136,104,0)');
  b.fillStyle = cg;
  b.fillRect(0, 0, cw, ch);

  // 흙길 (중앙 세로 · 부드러운 한 줄기)
  b.save();
  b.beginPath();
  const roadPts = [];
  for (let y = ch * 0.06; y <= ch * 0.95; y += 10) roadPts.push([cw / 2 + Math.sin(y * 0.012) * 30 + Math.sin(y * 0.004) * 16, y]);
  b.moveTo(roadPts[0][0] - 44, roadPts[0][1]);
  for (const [px, py] of roadPts) b.lineTo(px - 46 - Math.sin(py * 0.02) * 8, py);
  for (let i = roadPts.length - 1; i >= 0; i--) b.lineTo(roadPts[i][0] + 46 + Math.sin(roadPts[i][1] * 0.02) * 8, roadPts[i][1]);
  b.closePath();
  b.fillStyle = 'rgba(126,102,72,0.55)';
  b.fill();
  b.clip();
  for (let i = 0; i < 520 * areaK; i++) {
    const x = cw / 2 + (r() - 0.5) * 120;
    const y = r() * ch;
    b.fillStyle = 'rgba(' + Math.round(70 + r() * 60) + ',' + Math.round(58 + r() * 44) + ',' + Math.round(40 + r() * 30) + ',' + (0.03 + r() * 0.1).toFixed(3) + ')';
    b.beginPath();
    b.ellipse(x, y, 2 + r() * 9, 1 + r() * 4, r() * 3, 0, Math.PI * 2);
    b.fill();
  }
  b.restore();

  // 흙 · 자갈 반점
  for (let i = 0; i < 2600 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    const l = 16 + r() * 40;
    b.fillStyle = 'rgba(' + Math.round(l + 40) + ',' + Math.round(l + 30) + ',' + Math.round(l + 10) + ',' + (0.05 + r() * 0.14).toFixed(3) + ')';
    b.fillRect(x, y, 1 + r() * 3, 1 + r() * 2);
  }
  // 풀
  for (let i = 0; i < 900 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    b.strokeStyle = 'rgba(' + (86 + Math.round(r() * 60)) + ',' + (130 + Math.round(r() * 60)) + ',' + (80 + Math.round(r() * 40)) + ',' + (0.10 + r() * 0.22).toFixed(3) + ')';
    b.lineWidth = 1 + r();
    b.beginPath();
    b.moveTo(x, y);
    b.lineTo(x + (r() - 0.5) * 5, y - 4 - r() * 7);
    b.stroke();
  }
  // 진영 색 띠 (위 = 아군, 아래 = 적군)
  const me = colorOf(meColor, '#3b82f6');
  const en = colorOf(enemyColor, '#ef4444');
  const meCss = '#' + me.getHexString();
  const enCss = '#' + en.getHexString();
  const bandTop = ch * 0.2;
  const top = b.createLinearGradient(0, 0, 0, bandTop);
  top.addColorStop(0, hexA(meCss, 0.42));
  top.addColorStop(1, hexA(meCss, 0));
  b.fillStyle = top;
  b.fillRect(0, 0, cw, bandTop);
  const bot = b.createLinearGradient(0, ch, 0, ch - bandTop);
  bot.addColorStop(0, hexA(enCss, 0.42));
  bot.addColorStop(1, hexA(enCss, 0));
  b.fillStyle = bot;
  b.fillRect(0, ch - bandTop, cw, bandTop);
  // 진영 흙 마당
  b.fillStyle = 'rgba(20,26,22,0.35)';
  b.beginPath(); b.ellipse(cw * 0.2, ch * 0.07, cw * 0.2, ch * 0.04, 0, 0, Math.PI * 2); b.fill();
  b.beginPath(); b.ellipse(cw * 0.8, ch * 0.93, cw * 0.2, ch * 0.04, 0, 0, Math.PI * 2); b.fill();
  // 가장자리 어둡게
  const vg = b.createLinearGradient(0, 0, cw, 0);
  vg.addColorStop(0, 'rgba(0,0,0,0.66)');
  vg.addColorStop(0.14, 'rgba(0,0,0,0)');
  vg.addColorStop(0.86, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.66)');
  b.fillStyle = vg;
  b.fillRect(0, 0, cw, ch);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function hexA(hex, a) {
  const h = String(hex || '#3b82f6').replace('#', '');
  const n = parseInt(h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16);
  if (!isFinite(n)) return 'rgba(59,130,246,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ---------------------------------------------------------------------------
   병사 모델 (절차적 3D 메시) — 3D 두 동강 조각용
   --------------------------------------------------------------------------- */
function buildSoldier(color, opts) {
  const o = opts || {};
  const col = colorOf(color, '#3b82f6');
  const g = new THREE.Group();
  const mats = {
    armor: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.58), roughness: 0.4, metalness: 0.42, envMapIntensity: 1.05 }),
    cloth: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.95), roughness: 0.85, envMapIntensity: 0.7 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xe6f0fd, roughness: 0.18, metalness: 0.98, emissive: col.clone().multiplyScalar(0.16), emissiveIntensity: o.player ? 0.9 : 0.2, envMapIntensity: 1.55 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc59066, roughness: 0.82 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a222c, roughness: 0.9 }),
    crest: new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.55), roughness: 0.45, emissive: col.clone(), emissiveIntensity: 0.55, envMapIntensity: 0.8 })
  };

  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 2.05, 9.4, 0);
    const thigh = new THREE.Mesh(GEO.leg, mats.dark);
    thigh.position.y = -4.5;
    hip.add(thigh);
    const boot = new THREE.Mesh(GEO.boot, mats.dark);
    boot.position.set(0, -8.9, 0.55);
    hip.add(boot);
    g.add(hip);
    legs.push(hip);
  }

  const torso = new THREE.Mesh(GEO.torso, mats.armor);
  torso.position.y = 15.2;
  g.add(torso);
  const sash = new THREE.Mesh(GEO.sash, mats.cloth);
  sash.position.set(0, 15.0, 3.05);
  g.add(sash);
  for (const sx of [-1, 1]) {
    const sh = new THREE.Mesh(GEO.shoulder, mats.armor);
    sh.position.set(sx * 4.3, 19.1, 0);
    g.add(sh);
  }
  const neck = new THREE.Mesh(GEO.neck, mats.skin);
  neck.position.y = 20.5;
  g.add(neck);

  const head = new THREE.Mesh(GEO.head, mats.skin);
  head.position.y = 23.2;
  g.add(head);
  const helmet = new THREE.Mesh(GEO.helmet, mats.steel);
  helmet.position.y = 23.55;
  g.add(helmet);
  const visor = new THREE.Mesh(GEO.visor, mats.dark);
  visor.position.set(0, 22.7, 2.35);
  g.add(visor);
  const crest = new THREE.Mesh(GEO.crest, mats.crest);
  crest.position.set(0, 26.1, -1.5);
  crest.rotation.x = -0.16;
  g.add(crest);

  const armR = new THREE.Group();
  armR.position.set(4.75, 19.1, 0);
  const upR = new THREE.Mesh(GEO.upperArm, mats.armor);
  upR.position.y = -3.3;
  armR.add(upR);
  const foreR = new THREE.Mesh(GEO.foreArm, mats.skin);
  foreR.position.y = -8.1;
  armR.add(foreR);
  const sword = new THREE.Group();
  sword.position.set(0, -10.6, 0);
  const grip = new THREE.Mesh(GEO.grip, mats.dark);
  grip.position.z = -1.1;
  sword.add(grip);
  const guard = new THREE.Mesh(GEO.guard, mats.steel);
  guard.position.z = 0.6;
  sword.add(guard);
  const blade = new THREE.Mesh(GEO.blade, mats.steel);
  blade.position.z = 5.9;
  sword.add(blade);
  armR.add(sword);
  g.add(armR);

  const armL = new THREE.Group();
  armL.position.set(-4.75, 19.1, 0);
  const upL = new THREE.Mesh(GEO.upperArm, mats.armor);
  upL.position.y = -3.3;
  armL.add(upL);
  const foreL = new THREE.Mesh(GEO.foreArm, mats.skin);
  foreL.position.y = -8.1;
  armL.add(foreL);
  g.add(armL);

  const shadow = new THREE.Mesh(GEO.shadow, new THREE.MeshBasicMaterial({
    map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.85
  }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.12;
  shadow.userData.shadow = true;
  g.add(shadow);

  return { group: g, mats: mats, parts: { legs: legs, torso: torso, head: head, armR: armR, armL: armL, sword: sword, crest: crest } };
}

/* ---------------------------------------------------------------------------
   렌더러 생성
   --------------------------------------------------------------------------- */
function create(opts) {
  const canvas = opts.canvas;
  const cfg = opts.cfg || {};
  const W = Math.max(140, cfg.w || 280);
  const H = Math.max(240, cfg.h || 600);
  if (!canvas) throw new Error('3D 캔버스가 없습니다');

  const maxD = Math.hypot(W, H) / 2;
  const areaK = clamp((W * H) / (280 * 600), 0.6, 4.5);

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.setClearColor(0x0a1117, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = false;
  renderer.autoClear = true;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1117);
  scene.fog = new THREE.Fog(0x0e1c24, maxD * 0.55, maxD * 1.18);

  const camera = new THREE.PerspectiveCamera(68, 0.46, 0.6, maxD * 3.4);
  scene.add(camera);                      // 뷰모델·검기 자식 메시를 위해

  /* --- 환경 반사 (금속 검날의 광택) — 한 번만 만들어 모든 재질이 공유 --- */
  let envTexture = null;
  try {
    const ec = document.createElement('canvas');
    ec.width = 128; ec.height = 64;
    const ex = ec.getContext('2d');
    const eg = ex.createLinearGradient(0, 0, 0, 64);
    eg.addColorStop(0, '#0b1a2c');
    eg.addColorStop(0.42, '#2b567a');
    eg.addColorStop(0.56, '#5f7f92');
    eg.addColorStop(0.64, '#2a2a26');
    eg.addColorStop(1, '#0d0f10');
    ex.fillStyle = eg;
    ex.fillRect(0, 0, 128, 64);
    const moonGlow = ex.createRadialGradient(96, 12, 0, 96, 12, 22);
    moonGlow.addColorStop(0, 'rgba(255,247,230,1)');
    moonGlow.addColorStop(0.25, 'rgba(226,238,255,0.75)');
    moonGlow.addColorStop(1, 'rgba(180,210,255,0)');
    ex.fillStyle = moonGlow;
    ex.fillRect(0, 0, 128, 64);
    const envSrc = new THREE.CanvasTexture(ec);
    envSrc.mapping = THREE.EquirectangularReflectionMapping;
    envSrc.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(envSrc);
    envTexture = envRT.texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.6;
    envSrc.dispose();
    pmrem.dispose();
  } catch (e) {
    envTexture = null;      // 환경 반사 없이도 그대로 돈다
  }

  const size = { w: 390, h: 844 };
  const colors = {
    me: colorOf(cfg.me && cfg.me.color, '#3b82f6'),
    enemy: colorOf(cfg.enemy && cfg.enemy.color, '#ef4444')
  };
  const meHex = '#' + colors.me.getHexString();
  const enemyHex = '#' + colors.enemy.getHexString();

  const rand = mulberry32(((cfg.seed || 1) ^ 0x3d7a1f) >>> 0);

  /* --- 조명 (대비를 살린 3점 조명 + 달빛 채움광) --- */
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1d1c14, 0.82));
  scene.add(new THREE.AmbientLight(0x7f97b8, 0.16));
  const sun = new THREE.DirectionalLight(0xffe6c2, 1.55);
  sun.position.set(80, 165, -60);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x5b8fe0, 0.72);
  rim.position.set(-90, 90, 130);
  scene.add(rim);
  const moonFill = new THREE.DirectionalLight(0xa8c8ff, 0.32);
  moonFill.position.set(40, 110, 170);
  scene.add(moonFill);

  /* --- 하늘 · 먼 언덕 · 달 --- */
  (function addSky() {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#04070f');
    g.addColorStop(0.42, '#0a1626');
    g.addColorStop(0.72, '#16304a');
    g.addColorStop(0.9, '#2b4c66');
    g.addColorStop(1, '#3b5c72');
    x.fillStyle = g;
    x.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(maxD * 2.35, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.6),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    dome.position.y = -maxD * 0.06;
    scene.add(dome);

    // 달 + 빛무리 (깊이감)
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xe8f2ff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    moon.scale.set(maxD * 0.5, maxD * 0.5, 1);
    moon.position.set(-maxD * 0.55, maxD * 0.72, -maxD * 1.35);
    scene.add(moon);

    // 별 (아주 옅게)
    const starGeo = new THREE.BufferGeometry();
    const starN = 90;
    const sp = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const a = rand() * Math.PI * 2;
      const el2 = 0.18 + rand() * 0.62;
      const r2 = maxD * 1.7;
      sp[i * 3] = Math.cos(a) * Math.cos(el2) * r2;
      sp[i * 3 + 1] = Math.sin(el2) * r2 * 0.9;
      sp[i * 3 + 2] = Math.sin(a) * Math.cos(el2) * r2;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xdce9ff, size: 2.4, sizeAttenuation: false, transparent: true,
      opacity: 0.55, depthWrite: false, fog: false, blending: THREE.AdditiveBlending
    }));
    stars.frustumCulled = false;
    scene.add(stars);

    const hillMat = new THREE.MeshStandardMaterial({ color: 0x24384a, roughness: 1, flatShading: true });
    const hillFarMat = new THREE.MeshStandardMaterial({ color: 0x2c4256, roughness: 1, flatShading: true });
    const hk = clamp(maxD / 310, 1, 3.2);
    const n = Math.round(20 + areaK * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.18;
      const far = i % 3 === 0;
      const rad = maxD * (far ? 1.28 + rand() * 0.18 : 1.02 + rand() * 0.16);
      const hgt = (40 + rand() * 55) * hk * (far ? 1.35 : 1);
      const hill = new THREE.Mesh(new THREE.ConeGeometry((130 + rand() * 90) * hk, hgt, 7), far ? hillFarMat : hillMat);
      hill.position.set(Math.cos(a) * rad, hgt * 0.4 - 22 * hk, Math.sin(a) * rad);
      hill.rotation.y = rand() * 3;
      scene.add(hill);
    }
  })();

  /* --- 땅 --- */
  const groundTex = terrainTexture(W, H, cfg.seed || 1, meHex, enemyHex);
  groundTex.center.set(0.5, 0.5);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  /* --- 경계 · 말뚝 --- */
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x24302c, roughness: 1 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95 });
  const postGeo = new THREE.CylinderGeometry(0.75, 0.95, 11, 6);
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 4.5, H + 6), edgeMat);
    wall.position.set(sx * (W / 2 + 1.5), 1.2, 0);
    scene.add(wall);
  }
  for (const sz of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(W + 6, 4.5, 3), edgeMat);
    wall.position.set(0, 1.2, sz * (H / 2 + 1.5));
    scene.add(wall);
  }
  const postN = clamp(Math.round((W + H) / 22), 22, 96);
  const posts = new THREE.InstancedMesh(postGeo, postMat, postN);
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (let k = 0; k < postN / 2 && i < postN - 1; k++) {
      const z = -H / 2 + 20 + (k * (H - 40)) / Math.max(1, postN / 2 - 1);
      for (const sx of [-1, 1]) {
        m.makeTranslation(sx * (W / 2 - 3), 5, z);
        posts.setMatrixAt(i++, m);
      }
    }
    posts.count = i;
    posts.instanceMatrix.needsUpdate = true;
    scene.add(posts);
  }

  /* --- 풀 · 돌 장식 --- */
  const grassN = clamp(Math.round(90 * areaK), 90, 300);
  const grass = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.9, 3.4, 4),
    new THREE.MeshStandardMaterial({ color: 0x3c5a38, roughness: 1 }),
    grassN
  );
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < grassN; i++) {
      p.set((rand() - 0.5) * (W - 26), 1.6, (rand() - 0.5) * (H - 26));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
      const k = 0.7 + rand() * 1.1;
      s.set(k, k * (0.8 + rand() * 0.7), k);
      m.compose(p, q, s);
      grass.setMatrixAt(i, m);
    }
    grass.instanceMatrix.needsUpdate = true;
    scene.add(grass);
  }
  const pebbleN = clamp(Math.round(36 * areaK), 36, 110);
  const pebbles = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1.1, 0),
    new THREE.MeshStandardMaterial({ color: 0x55605e, roughness: 0.9, flatShading: true }),
    pebbleN
  );
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < pebbleN; i++) {
      p.set((rand() - 0.5) * (W - 18), 0.4, (rand() - 0.5) * (H - 18));
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      const k = 0.6 + rand() * 1.2;
      s.set(k, k * 0.5, k);
      m.compose(p, q, s);
      pebbles.setMatrixAt(i, m);
    }
    pebbles.instanceMatrix.needsUpdate = true;
    scene.add(pebbles);
  }

  /* --- 장애물 --- */
  const obstacleMat = {
    rock: new THREE.MeshStandardMaterial({ color: 0x5d6771, roughness: 0.92, metalness: 0.06, flatShading: true }),
    rockDark: new THREE.MeshStandardMaterial({ color: 0x3a444d, roughness: 0.95, flatShading: true }),
    tent: new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.9, side: THREE.DoubleSide }),
    tentAlt: new THREE.MeshStandardMaterial({ color: 0x6f5438, roughness: 0.95, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.88 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x39414c, roughness: 0.6, metalness: 0.6 })
  };

  function shadowBlob(scale) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale), new THREE.MeshBasicMaterial({
      map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.8
    }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.1;
    return m;
  }

  function addObstacle(o) {
    const g = new THREE.Group();
    g.position.set(o.x - W / 2, 0, o.y - H / 2);
    const r = o.r || 15;
    if (o.kind === 'tent') {
      const tent = new THREE.Mesh(new THREE.ConeGeometry(r * 1.05, r * 1.55, 6), o.seed > 0.5 ? obstacleMat.tent : obstacleMat.tentAlt);
      tent.position.y = r * 0.78;
      tent.rotation.y = o.seed * 3;
      g.add(tent);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.72, r * 0.9), new THREE.MeshBasicMaterial({
        color: 0x1b140d, transparent: true, opacity: 0.85, side: THREE.DoubleSide
      }));
      door.position.set(0, r * 0.45, r * 0.92);
      door.rotation.x = -0.12;
      g.add(door);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, r * 2.4, 5), obstacleMat.wood);
      pole.position.y = r * 1.2;
      g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), new THREE.MeshStandardMaterial({
        color: o.team === 'enemy' ? enemyHex : meHex, roughness: 0.9, side: THREE.DoubleSide, emissive: o.team === 'enemy' ? enemyHex : meHex, emissiveIntensity: 0.12
      }));
      flag.position.set(3, r * 2.1, 0);
      g.add(flag);
    } else if (o.kind === 'cart') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(r * 1.9, r * 0.75, r * 1.05), obstacleMat.wood);
      body.position.y = r * 0.75;
      g.add(body);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(r * 2.0, 0.5, 0.5), obstacleMat.iron);
      rail.position.set(0, r * 1.15, r * 0.5);
      g.add(rail);
      const wheelGeo = new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.5, 10);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const wh = new THREE.Mesh(wheelGeo, obstacleMat.iron);
          wh.rotation.z = Math.PI / 2;
          wh.position.set(sx * r * 0.62, r * 0.42, sz * r * 0.6);
          g.add(wh);
        }
      }
      const load = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.45, 0), obstacleMat.tent);
      load.position.set(0, r * 1.15, 0);
      g.add(load);
    } else {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 0.95, 0), o.seed > 0.45 ? obstacleMat.rock : obstacleMat.rockDark);
      rock.position.y = r * 0.52;
      rock.scale.set(1, 0.72 + o.seed * 0.3, 0.92);
      rock.rotation.set(o.seed * 2, o.seed * 5, o.seed);
      g.add(rock);
      const chip = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 0.42, 0), obstacleMat.rockDark);
      chip.position.set(r * 0.75, r * 0.24, -r * 0.4);
      chip.rotation.set(o.seed * 3, o.seed * 2, 0);
      g.add(chip);
    }
    g.add(shadowBlob(r * 3.2));
    scene.add(g);
    return g;
  }

  const obstacleViews = [];
  for (const o of (opts.obstacles || [])) obstacleViews.push(addObstacle(o));

  /* --- 진영 깃발 · 화톳불 --- */
  const banners = [];
  function addBanner(x, z, colorHex, flip) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 42, 7), obstacleMat.wood);
    pole.position.y = 21;
    g.add(pole);
    const clothGeo = new THREE.PlaneGeometry(24, 14, 10, 6);
    const cloth = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial({
      color: colorHex, roughness: 0.92, side: THREE.DoubleSide,
      emissive: colorHex, emissiveIntensity: 0.16
    }));
    cloth.position.set(flip ? -12.4 : 12.4, 33, 0);
    g.add(cloth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(24, 1.1, 0.4), new THREE.MeshStandardMaterial({
      color: 0xd9c48a, roughness: 0.6, metalness: 0.5
    }));
    trim.position.copy(cloth.position);
    trim.position.y = 26.2;
    g.add(trim);
    scene.add(g);
    const base = clothGeo.attributes.position.array.slice();
    banners.push({ cloth: clothGeo, base: base, dir: flip ? -1 : 1, phase: rand() * 6 });
  }
  addBanner(-W * 0.34, -H * 0.4, meHex, false);
  addBanner(W * 0.34, H * 0.4, enemyHex, true);

  function addBrazier(x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 6, 8), obstacleMat.iron);
    stand.position.y = 3;
    g.add(stand);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.2, 8), new THREE.MeshBasicMaterial({
      color: 0xffb257, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    flame.position.y = 7.6;
    g.add(flame);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xffc070, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo.scale.set(18, 18, 1);
    halo.position.y = 8;
    g.add(halo);
    scene.add(g);
    return flame;
  }
  const flames = [addBrazier(-W * 0.34, -H * 0.4 + 10), addBrazier(W * 0.34, H * 0.4 - 10)];

  /* ===========================================================================
     병사 인스턴스 (InstancedMesh) — 지오메트리·재질 공유로 드로우콜 최소화
     =========================================================================== */
  const skinColor = new THREE.Color(0xc59066);
  const darkColor = new THREE.Color(0x1d2530);
  const whiteColor = new THREE.Color(0xffffff);
  const crowdMat = {
    armor: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.42, envMapIntensity: 1.05 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, envMapIntensity: 0.7 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.95, emissive: 0x1b2c44, emissiveIntensity: 0.5, envMapIntensity: 1.5 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, envMapIntensity: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, envMapIntensity: 0.4 }),
    crest: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1, emissive: 0x223040, emissiveIntensity: 0.4, envMapIntensity: 0.8 })
  };

  // 파트 정의 — rig: 어느 관절을 따라가는지, pos: 관절 기준 로컬 위치
  const PARTS = [
    { key: 'torso', geo: GEO.torso, mat: 'armor', rig: 'body', pos: [0, 15.2, 0] },
    { key: 'sash', geo: GEO.sash, mat: 'cloth', rig: 'body', pos: [0, 15.0, 3.05] },
    { key: 'shoulderL', geo: GEO.shoulder, mat: 'armor', rig: 'body', pos: [-4.3, 19.1, 0] },
    { key: 'shoulderR', geo: GEO.shoulder, mat: 'armor', rig: 'body', pos: [4.3, 19.1, 0] },
    { key: 'neck', geo: GEO.neck, mat: 'skin', rig: 'body', pos: [0, 20.5, 0] },
    { key: 'head', geo: GEO.head, mat: 'skin', rig: 'body', pos: [0, 23.2, 0] },
    { key: 'helmet', geo: GEO.helmet, mat: 'steel', rig: 'body', pos: [0, 23.55, 0] },
    { key: 'visor', geo: GEO.visor, mat: 'dark', rig: 'body', pos: [0, 22.7, 2.35] },
    { key: 'crest', geo: GEO.crest, mat: 'crest', rig: 'body', pos: [0, 26.1, -1.5], rot: [-0.16, 0, 0] },
    { key: 'legL', geo: GEO.leg, mat: 'dark', rig: 'legL', pos: [0, -4.5, 0] },
    { key: 'bootL', geo: GEO.boot, mat: 'dark', rig: 'legL', pos: [0, -8.9, 0.55] },
    { key: 'legR', geo: GEO.leg, mat: 'dark', rig: 'legR', pos: [0, -4.5, 0] },
    { key: 'bootR', geo: GEO.boot, mat: 'dark', rig: 'legR', pos: [0, -8.9, 0.55] },
    { key: 'upArmL', geo: GEO.upperArm, mat: 'armor', rig: 'armL', pos: [0, -3.3, 0] },
    { key: 'foreArmL', geo: GEO.foreArm, mat: 'skin', rig: 'armL', pos: [0, -8.1, 0] },
    { key: 'upArmR', geo: GEO.upperArm, mat: 'armor', rig: 'armR', pos: [0, -3.3, 0] },
    { key: 'foreArmR', geo: GEO.foreArm, mat: 'skin', rig: 'armR', pos: [0, -8.1, 0] },
    { key: 'grip', geo: GEO.grip, mat: 'dark', rig: 'armR', pos: [0, -10.6, -1.1] },
    { key: 'guard', geo: GEO.guard, mat: 'steel', rig: 'armR', pos: [0, -10.6, 0.6] },
    { key: 'blade', geo: GEO.blade, mat: 'steel', rig: 'armR', pos: [0, -10.6, 5.9] },
    { key: 'shadow', geo: GEO.shadow, mat: 'shadow', rig: 'body', pos: [0, 0.12, 0], rot: [-Math.PI / 2, 0, 0] }
  ];
  const shadowMat = new THREE.MeshBasicMaterial({ map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.62 });

  const parts = PARTS.map((def) => {
    const mat = def.mat === 'shadow' ? shadowMat : crowdMat[def.mat];
    const mesh = new THREE.InstancedMesh(def.geo, mat, MAX_SOLDIERS);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.part = def.key;
    scene.add(mesh);
    const local = new THREE.Matrix4();
    const e = new THREE.Euler(def.rot ? def.rot[0] : 0, def.rot ? def.rot[1] : 0, def.rot ? def.rot[2] : 0, 'XYZ');
    local.compose(new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1));
    return { def: def, mesh: mesh, local: local };
  });

  function partColor(def, team, out) {
    if (def.mat === 'skin') return out.copy(skinColor);
    if (def.mat === 'dark') return out.copy(darkColor);
    if (def.mat === 'steel') return out.copy(team).lerp(whiteColor, 0.9);
    if (def.mat === 'armor') return out.copy(team).multiplyScalar(0.52).lerp(whiteColor, 0.05);
    if (def.mat === 'cloth') return out.copy(team).lerp(whiteColor, 0.12);
    if (def.mat === 'crest') return out.copy(team).lerp(whiteColor, 0.58);
    if (def.mat === 'shadow') return out.setRGB(1, 1, 1);
    return out.setRGB(1, 1, 1);
  }

  /* --- 적·아군 검기 / 공격 예고 인스턴스 --- */
  const arcGeo = new THREE.PlaneGeometry(1, 1);
  const arcMat = new THREE.MeshBasicMaterial({
    map: TEX.slash, transparent: true, opacity: 1, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  const arcMesh = new THREE.InstancedMesh(arcGeo, arcMat, MAX_ARCS);
  arcMesh.count = 0;
  arcMesh.frustumCulled = false;
  arcMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(arcMesh);

  /* --- 유닛 뷰 --- */
  const units = new Map();
  const tmpV = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const tmpColor2 = new THREE.Color();

  function addView(u, team) {
    const v = {
      unit: u, team: team,
      phase: rand() * 6.28, speed: 0, lx: u.x, ly: u.y,
      hurtPrev: -1, color: team === 'enemy' ? colors.enemy : colors.me
    };
    units.set(u, v);
    return v;
  }

  function updateUnitView(v, dt) {
    const u = v.unit;
    const moved = Math.hypot(u.x - v.lx, u.y - v.ly);
    v.lx = u.x; v.ly = u.y;
    const spd = dt > 0 ? moved / (dt / 1000) : 0;
    v.speed = lerp(v.speed, spd, 0.25);
    const run = clamp(v.speed / 110, 0, 1);
    v.phase += (dt / 1000) * (3.6 + run * 10);
    v.run = run;
    v.swing = Math.sin(v.phase) * (0.24 + run * 0.62);
    v.bob = Math.abs(Math.sin(v.phase)) * (0.25 + run * 1.1);
  }

  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _rigBody = new THREE.Matrix4();
  const _rigLegL = new THREE.Matrix4();
  const _rigLegR = new THREE.Matrix4();
  const _rigArmL = new THREE.Matrix4();
  const _rigArmR = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _eul = new THREE.Euler();
  const _one = new THREE.Vector3(1, 1, 1);

  function rigT(out, x, y, z, rx, ry, rz) {
    _pos.set(x, y, z);
    _eul.set(rx || 0, ry || 0, rz || 0, 'XYZ');
    _quat.setFromEuler(_eul);
    out.compose(_pos, _quat, _one);
    return out;
  }

  let aliveCount = 0;
  let windCount = 0;
  let swingCount = 0;

  function buildCrowd(S, dt) {
    const list = [];
    for (const a of S.allies) if (!a.dead) list.push([a, 'ally']);
    for (const e of S.enemies) if (!e.dead) list.push([e, 'enemy']);

    // 사라진 유닛 정리
    const seen = new Set();
    for (const [u] of list) seen.add(u);
    for (const [u] of [...units]) {
      if (u === S.player || seen.has(u)) continue;
      units.delete(u);
    }

    const n = Math.min(list.length, MAX_SOLDIERS);
    aliveCount = n;
    windCount = 0;
    swingCount = 0;
    let arcN = 0;

    for (let i = 0; i < n; i++) {
      const u = list[i][0];
      const team = list[i][1];
      let v = units.get(u);
      if (!v) v = addView(u, team);
      updateUnitView(v, dt);

      // 병사 월드 행렬
      _pos.set(u.x - W / 2, v.bob, u.y - H / 2);
      _eul.set(0, Math.PI / 2 - (u.face || 0), 0, 'YXZ');
      _quat.setFromEuler(_eul);
      _scl.set(1, 1, 1);
      _m.compose(_pos, _quat, _scl);

      // 관절 — 걷기·달리기·공격이 이어지는 부드러운 모션
      rigT(_rigLegL, -2.05, 9.4, 0, v.swing, 0, 0);
      rigT(_rigLegR, 2.05, 9.4, 0, -v.swing, 0, 0);

      const step = Math.sin(v.phase);
      const runr = v.run || 0;
      const swingAmp = 0.14 + runr * 0.95;
      let armX = -0.72 + step * swingAmp;
      let armY = 0.24 + runr * 0.12;
      let armLx = -0.2 - step * swingAmp;
      let armLy = -0.22 - runr * 0.1;
      let torsoYaw = 0;
      let torsoPitch = Math.sin(v.phase * 2) * (0.02 + runr * 0.05);
      if (u.wind > 0) {
        // 예고 — 검을 위로 천천히 치켜들며 상체를 튼다 (ease-out)
        const w = easeOutCubic(clamp(1 - u.wind / 320, 0, 1));
        armX = -0.55 - 1.3 * w;
        armY = 0.85 - 0.42 * w;
        torsoYaw = -0.14 * w;
        torsoPitch = -0.06 * w;
        windCount++;
      } else if (u.swing > 0) {
        // 내려치기(빠르게) → 다시 위로 복귀(부드럽게)
        const s = 1 - clamp(u.swing / 180, 0, 1);
        const strike = s < 0.62 ? smoothstep(s / 0.62) : 1 - smoothstep((s - 0.62) / 0.38);
        armY = 1.35 - 2.7 * strike;
        armX = -0.5 - 0.16 * strike;
        torsoYaw = 0.22 * strike - 0.05;
        torsoPitch = 0.09 * strike;
        swingCount++;
      }
      rigT(_rigBody, 0, 0, 0, torsoPitch, torsoYaw, 0);
      rigT(_rigArmR, 4.75, 19.1, 0, armX, armY, 0);
      rigT(_rigArmL, -4.75, 19.1, 0, armLx, armLy, 0);

      // 피격 섬광 (색을 흰색 쪽으로)
      const hurt = u.hit > 0 ? clamp(u.hit / 140, 0, 1) * 0.85 : 0;
      v.hurtPrev = hurt;

      for (let p = 0; p < parts.length; p++) {
        const P = parts[p];
        const rig = P.def.rig;
        const base = rig === 'legL' ? _rigLegL : rig === 'legR' ? _rigLegR :
          rig === 'armL' ? _rigArmL : rig === 'armR' ? _rigArmR : _rigBody;
        _m2.copy(_m).multiply(base).multiply(P.local);
        P.mesh.setMatrixAt(i, _m2);
        if (P.def.mat !== 'shadow') {
          partColor(P.def, v.color, tmpColor2);
          if (hurt > 0) tmpColor2.lerp(whiteColor, hurt);
          P.mesh.setColorAt(i, tmpColor2);
        }
      }

      // 적/아군 검기 · 공격 예고
      if (arcN < MAX_ARCS) {
        const fx = Math.cos(u.face || 0), fz = Math.sin(u.face || 0);
        let mx = 0, vis = 0, w = 54, h = 32, bright = 1;
        if (u.wind > 0) {
          const k = 1 - clamp(u.wind / 320, 0, 1);
          mx = 24;
          vis = 1;
          w = 28 + k * 8;
          h = 17 + k * 6;
          bright = 0.34 + k * 0.5 + Math.sin(S.time / 28) * 0.1;
        } else if (u.swing > 0) {
          const k = 1 - clamp(u.swing / 180, 0, 1);
          mx = 26;
          vis = 1;
          w = 36 + k * 14;
          h = 21 + k * 8;
          bright = (1 - k) * 1.15;
        }
        if (vis > 0) {
          // 1인칭에서는 수평으로 누운 검기는 거의 보이지 않는다 → 세로로 세워 적을 향해
          _m2.makeRotationY(-(u.face || 0));
          _m.makeRotationX(-0.34);
          _m2.multiply(_m);
          _m.makeScale(w, h, 1);
          _m2.multiply(_m);
          _m2.setPosition(u.x - W / 2 + fx * mx * 0.55, 18.5, u.y - H / 2 + fz * mx * 0.55);
          arcMesh.setMatrixAt(arcN, _m2);
          if (team === 'enemy') tmpColor.setRGB(1.0, 0.36, 0.22);
          else tmpColor.setRGB(0.44, 0.82, 1.0);
          tmpColor.multiplyScalar(bright);
          arcMesh.setColorAt(arcN, tmpColor);
          arcN++;
        }
      }
    }

    for (let p = 0; p < parts.length; p++) {
      const P = parts[p];
      P.mesh.count = n;
      P.mesh.instanceMatrix.needsUpdate = true;
      if (P.mesh.instanceColor) P.mesh.instanceColor.needsUpdate = true;
    }
    arcMesh.count = arcN;
    arcMesh.instanceMatrix.needsUpdate = true;
    if (arcMesh.instanceColor) arcMesh.instanceColor.needsUpdate = true;
  }

  /* --- 검기 · 돌진 잔상 · 절단 섬광 --- */
  const slashViews = new Map();
  const trailViews = new Map();
  const cutViews = new Map();

  /* 1인칭 검기 — 카메라 앞에 붙어 화면을 가로지른다 */
  function syncSlashes(S) {
    const live = new Set(S.slashes);
    for (const [sl, v] of slashViews) {
      if (!live.has(sl)) {
        camera.remove(v.group);
        v.mat.dispose(); v.glowMat.dispose();
        v.arc.geometry.dispose(); v.glow.geometry.dispose();
        slashViews.delete(sl);
      }
    }
    for (const sl of S.slashes) {
      let v = slashViews.get(sl);
      if (!v) {
        const group = new THREE.Group();
        camera.add(group);
        const mat = new THREE.MeshBasicMaterial({
          map: TEX.slash, transparent: true, opacity: 1, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
        });
        const arc = new THREE.Mesh(new THREE.PlaneGeometry(30, 17), mat);
        arc.position.set(0, 0, -26);
        group.add(arc);
        const glowMat = new THREE.MeshBasicMaterial({
          color: 0x8ec8ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
        });
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(40, 6), glowMat);
        glow.position.set(0, 0, -26.4);
        group.add(glow);
        v = { group: group, arc: arc, glow: glow, mat: mat, glowMat: glowMat };
        slashViews.set(sl, v);
      }
      const p = clamp(sl.t / sl.dur, 0, 1);
      const e = 1 - Math.pow(1 - p, 1.7);
      v.group.position.set(0, -2.0 + e * 0.6, 0);
      v.group.rotation.z = 1.15 - e * 2.3;
      v.mat.opacity = (1 - p) * 0.95;
      v.glowMat.opacity = (1 - p) * 0.34;
      v.arc.scale.set(0.9 + p * 0.35, 0.9 + p * 0.25, 1);
    }
  }

  function syncTrails(S) {
    const live = new Set(S.trails);
    for (const [tr, v] of trailViews) {
      if (!live.has(tr)) { scene.remove(v.mesh); v.mesh.geometry.dispose(); v.mesh.material.dispose(); trailViews.delete(tr); }
    }
    for (const tr of S.trails) {
      let v = trailViews.get(tr);
      if (!v) {
        const geo = new THREE.PlaneGeometry(46, 10, 1, 1);
        const mat = new THREE.MeshBasicMaterial({
          color: colors.me.clone().lerp(new THREE.Color(0xffffff), 0.35),
          transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        scene.add(mesh);
        v = { mesh: mesh };
        trailViews.set(tr, v);
      }
      const p = clamp(tr.t / tr.dur, 0, 1);
      v.mesh.position.set(tr.x - W / 2, 1.5 + p * 2, tr.y - H / 2);
      v.mesh.rotation.z = -tr.face;
      v.mesh.material.opacity = (1 - p) * 0.5;
      v.mesh.scale.set(1, 1 + p * 1.6, 1);
    }
  }

  function syncCuts(S) {
    const live = new Set(S.cuts);
    for (const [c, v] of cutViews) {
      if (!live.has(c)) { scene.remove(v.mesh); v.mesh.geometry.dispose(); v.mesh.material.dispose(); cutViews.delete(c); }
    }
    for (const c of S.cuts) {
      let v = cutViews.get(c);
      if (!v) {
        const geo = new THREE.PlaneGeometry(Math.max(40, c.len * 2.2), 1.6);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xfff3f0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = 15;
        mesh.rotation.y = -c.ang;
        mesh.rotation.z = 0.12;
        scene.add(mesh);
        v = { mesh: mesh };
        cutViews.set(c, v);
      }
      const p = clamp(c.t / c.dur, 0, 1);
      v.mesh.position.x = c.x - W / 2;
      v.mesh.position.z = c.y - H / 2;
      v.mesh.material.opacity = (1 - p) * 0.95;
      v.mesh.scale.set(0.75 + p * 0.45, 1 + p * 0.9, 1);
    }
  }

  /* --- 3D 두 동강 --- */
  const pieces = new Map();

  function buildPiece(c) {
    const cut = Number.isFinite(c.cut) ? c.cut : 0;
    const tilt = Number.isFinite(c.tilt) ? clamp(c.tilt, -1.5, 1.5) : 0;
    const side = c.side < 0 ? -1 : 1;
    const built = buildSoldier(enemyHex, { player: false });
    const group = built.group;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const ch = group.children[i];
      if (ch.userData && ch.userData.shadow) {
        group.remove(ch);
        ch.geometry.dispose();
        ch.material.dispose();
      }
    }
    // 절단면: 시선 방향으로 기울어진 면 — tilt 가 0이면 수직, ±90°면 수평으로 잘린다
    const nLocal = new THREE.Vector3(0, side * Math.sin(tilt), side * Math.cos(tilt));
    const localPlane = new THREE.Plane(nLocal.clone(), -14 * nLocal.y);
    const worldPlane = new THREE.Plane();
    const mats = [];
    group.traverse((o) => {
      if (o.isMesh) {
        const m = o.material.clone();
        m.clippingPlanes = [worldPlane];
        m.clipIntersection = false;
        m.transparent = true;
        m.opacity = 1;
        o.material = m;
        mats.push(m);
      }
    });
    group.rotation.order = 'YXZ';
    group.rotation.y = -cut;
    group.position.set(c.x - W / 2, 12, c.y - H / 2);
    group.scale.setScalar(1.0);

    // 잘린 단면 — 피가 아니라 검은 심 + 푸른 빛 절단면
    const core = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 25),
      new THREE.MeshBasicMaterial({
        color: 0x9fd8ff, map: TEX.core, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false
      })
    );
    core.position.set(0, 14, 0).addScaledVector(nLocal, -side * 0.08);
    core.rotation.x = -tilt;
    group.add(core);

    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xdff3ff, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(26, 1.4), flashMat);
    flash.position.set(0, 16.2, 0);
    flash.rotation.x = -tilt;
    group.add(flash);

    scene.add(group);
    return {
      obj: group, cut: cut, tilt: tilt, side: side, localPlane: localPlane, plane: worldPlane,
      mats: mats, core: core, coreColor: '#9fd8ff', flash: flash, flashMat: flashMat,
      ox: c.x, oy: c.y, k: 0.5,
      y: 12, vy: 62 + Math.random() * 46 + side * Math.sin(tilt) * 96, parts: mats.length, opacity: 1
    };
  }

  function disposePiece(p) {
    scene.remove(p.obj);
    for (const m of p.mats) m.dispose();
    p.core.geometry.dispose();
    p.core.material.dispose();
    p.flash.geometry.dispose();
    p.flash.material.dispose();
  }

  function syncPieces(S, dt) {
    const live = new Set(S.corpses);
    for (const [c, p] of pieces) {
      if (!live.has(c)) { disposePiece(p); pieces.delete(c); }
    }
    // 너무 많으면 오래된 조각부터 정리 (모바일 보호)
    while (pieces.size > MAX_PIECES) {
      const first = pieces.keys().next().value;
      const p = pieces.get(first);
      disposePiece(p);
      pieces.delete(first);
    }
    for (const c of S.corpses) {
      let p = pieces.get(c);
      if (!p) { p = buildPiece(c); pieces.set(c, p); }
      p.vy -= 330 * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      if (p.y <= 3.2) { p.y = 3.2; p.vy = Math.abs(p.vy) * 0.34; if (p.vy < 18) p.vy = 0; }
      p.obj.position.set(p.ox + (c.x - p.ox) * p.k - W / 2, p.y, p.oy + (c.y - p.oy) * p.k - H / 2);
      p.obj.rotation.x = c.rot * 0.62;
      p.obj.updateMatrixWorld(true);
      p.plane.copy(p.localPlane).applyMatrix4(p.obj.matrixWorld);

      const left = clamp(c.life / 950, 0, 1);
      const fade = left > 0.72 ? 1 : left / 0.72;
      p.opacity = fade;
      for (const m of p.mats) m.opacity = fade;
      p.core.material.opacity = fade * 0.95;
      const flashP = clamp(1 - (950 - c.life) / 170, 0, 1);
      p.flashMat.opacity = flashP * 0.95;
      p.flash.visible = flashP > 0.01;
    }
  }

  /* --- 파티클 (불꽃 · 피) --- */
  const P_MAX = 420;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_MAX * 3);
  const pCol = new Float32Array(P_MAX * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 2.8, map: TEX.glow, transparent: true, vertexColors: true,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, opacity: 0.85
  });
  const pPoints = new THREE.Points(pGeo, pMat);
  pPoints.frustumCulled = false;
  scene.add(pPoints);
  const pState = new WeakMap();

  /* --- 공중 먼지 · 불티 (분위기 · 카메라를 따라다닌다) --- */
  const DUST_N = 150;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST_N * 3);
  const dustSeed = [];
  for (let i = 0; i < DUST_N; i++) {
    dustSeed.push({
      x: (rand() - 0.5) * 540, y: 3 + rand() * 86, z: (rand() - 0.5) * 540,
      ph: rand() * 6.28, sp: 0.25 + rand() * 0.5
    });
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0xd6e6ff, size: 2.4, map: TEX.glow, transparent: true, opacity: 0.3,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  scene.add(dustPoints);

  function updateDust(t, cx, cz) {
    for (let i = 0; i < DUST_N; i++) {
      const d = dustSeed[i];
      dustPos[i * 3] = cx + d.x + Math.sin(t * d.sp + d.ph) * 16;
      dustPos[i * 3 + 1] = d.y + Math.sin(t * 0.85 + d.ph) * 5;
      dustPos[i * 3 + 2] = cz + d.z + Math.cos(t * d.sp * 0.9 + d.ph) * 16;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  function syncParticles(S, dt) {
    let n = 0;
    const arr = S.particles;
    for (let i = 0; i < arr.length && n < P_MAX; i++) {
      const p = arr[i];
      let st = pState.get(p);
      if (!st) { st = { h: 6 + Math.random() * 8, vh: 40 + Math.random() * 90 }; pState.set(p, st); }
      st.vh -= 300 * (dt / 1000);
      st.h += st.vh * (dt / 1000);
      if (st.h < 1.2) { st.h = 1.2; st.vh = Math.abs(st.vh) * 0.35; }
      pPos[n * 3] = p.x - W / 2;
      pPos[n * 3 + 1] = st.h;
      pPos[n * 3 + 2] = p.y - H / 2;
      const a = clamp(p.life / (p.max || 400), 0, 1);
      try {
        if (String(p.color).charAt(0) === '#') tmpColor.set(p.color);
        else tmpColor.setRGB(0.55, 0.85, 1.0);
      } catch (e) { tmpColor.setRGB(0.55, 0.85, 1.0); }
      const k = a * 1.15;
      pCol[n * 3] = tmpColor.r * k;
      pCol[n * 3 + 1] = tmpColor.g * k;
      pCol[n * 3 + 2] = tmpColor.b * k;
      n++;
    }
    pGeo.setDrawRange(0, n);
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
    pPoints.visible = n > 0;
  }

  /* ===========================================================================
     1인칭 카메라 (수동 회전 전용)
     =========================================================================== */
  let camYaw = (cfg.playerFace != null ? cfg.playerFace : Math.PI / 2);
  let camPitch = 0;
  const lookNow = new THREE.Vector3();
  let bobT = 0;
  let plSpeed = 0;
  let plLX = 0, plLY = 0, plInit = false;

  function updateCamera(S, dt) {
    const pl = S.player;
    if (!pl) return;
    if (api.debugCamera) {
      camera.position.set(api.debugCamera.x, api.debugCamera.y, api.debugCamera.z);
      camera.lookAt(api.debugCamera.tx, api.debugCamera.ty, api.debugCamera.tz);
      return;
    }
    // 시점은 오로지 시뮬레이션의 face/pitch (사용자 드래그로만 바뀐다)
    camYaw = pl.face;
    camPitch = clamp(pl.pitch || 0, -1.15, 0.95);

    if (!plInit) { plLX = pl.x; plLY = pl.y; plInit = true; }
    const dist = Math.hypot(pl.x - plLX, pl.y - plLY);
    plLX = pl.x; plLY = pl.y;
    const spd = dt > 0 ? dist / (dt / 1000) : 0;
    plSpeed = lerp(plSpeed, spd, 0.2);
    const run = clamp(plSpeed / 120, 0, 1);
    bobT += (dt / 1000) * (2.0 + run * 9.5);
    const bob = Math.sin(bobT) * (0.12 + run * 0.55);

    const px = pl.x - W / 2, pz = pl.y - H / 2;

    // 베기 반동 · 막기 브레이스 · 숨쉬기 (카메라가 살짝 따라 움직인다)
    const ap = pl.atkAnim > 0 ? 1 - clamp(pl.atkAnim / ATK_DUR, 0, 1) : 0;
    const kick = ap > 0 && ap < 0.62 ? Math.sin((ap / 0.62) * Math.PI) : 0;
    const brace = vmGuard * 0.55;
    const breath = Math.sin(timeSec * 1.35) * 0.035;

    camera.position.set(px, EYE + bob - kick * 0.22 - brace * 0.1 + breath, pz + kick * 0.4);
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    const fx = Math.cos(camYaw), fz = Math.sin(camYaw);
    const side = Math.sin(Math.PI * clamp(ap, 0, 1)) * 0.9;
    lookNow.set(
      px + fx * cp * 120 - fz * side,
      EYE + bob + sp * 120 - kick * 1.5 + breath,
      pz + fz * cp * 120 + fx * side
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(lookNow);

    const sh = (S.shake || 0) * 0.22;
    if (sh > 0.05) {
      camera.position.x += (Math.random() - 0.5) * sh;
      camera.position.y += (Math.random() - 0.5) * sh;
      camera.lookAt(lookNow);
    }
  }

  /* ===========================================================================
     1인칭 뷰모델 (오른손 검 · 왼손 방패) — 별도 씬/카메라로 깊이 클리어 후 렌더
     =========================================================================== */
  const vmScene = new THREE.Scene();
  if (envTexture) {
    vmScene.environment = envTexture;
    vmScene.environmentIntensity = 0.75;
  }
  const vmCam = new THREE.PerspectiveCamera(58, 0.46, 0.05, 40);
  if (typeof window !== 'undefined') window.__vmCam = vmCam;
  vmScene.add(new THREE.HemisphereLight(0xbcd6ff, 0x2a2218, 2.0));
  const vmKey = new THREE.DirectionalLight(0xffe8c8, 2.5);
  vmKey.position.set(-1.4, 2.2, 2.4);
  vmScene.add(vmKey);
  const vmRim = new THREE.DirectionalLight(0x8fc4ff, 1.5);
  vmRim.position.set(2.2, 0.6, -1.6);
  vmScene.add(vmRim);

  const vm = new THREE.Group();
  vmScene.add(vm);
  const vmMats = {
    steel: new THREE.MeshStandardMaterial({ color: 0xeef5ff, roughness: 0.16, metalness: 0.96, emissive: 0x1a2a3e, emissiveIntensity: 1.1, envMapIntensity: 1.8 }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0xaebdd0, roughness: 0.3, metalness: 0.6, emissive: 0x0d141c, envMapIntensity: 1.2 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc08a5e, roughness: 0.8 }),
    cloth: new THREE.MeshStandardMaterial({ color: colors.me.clone().multiplyScalar(0.9), roughness: 0.82 }),
    clothDark: new THREE.MeshStandardMaterial({ color: colors.me.clone().multiplyScalar(0.5), roughness: 0.88 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe3cd92, roughness: 0.3, metalness: 0.9, envMapIntensity: 1.4 })
  };

  const swordArm = new THREE.Group();
  vm.add(swordArm);
  swordArm.position.set(1.04, -1.42, -4.95);
  swordArm.rotation.set(-0.05, 0.1, -0.12);
  const fore = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.0, 0.26), vmMats.clothDark);
  fore.position.set(-0.05, -0.52, 0.1);
  fore.rotation.x = 0.26;
  swordArm.add(fore);
  const bracer = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.34), vmMats.steelDark);
  bracer.position.set(-0.02, -0.14, 0.01);
  swordArm.add(bracer);
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.29, 0.31), vmMats.skin);
  swordArm.add(hand);

  const sword = new THREE.Group();
  swordArm.add(sword);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.08, 0.46, 8), vmMats.clothDark);
  grip.position.y = -0.16;
  sword.add(grip);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), vmMats.gold);
  pommel.position.y = -0.42;
  sword.add(pommel);
  const crossGuard = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.085, 0.15), vmMats.gold);
  crossGuard.position.y = 0.1;
  sword.add(crossGuard);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.175, 2.4, 0.05), vmMats.steel);
  blade.position.y = 1.36;
  sword.add(blade);
  const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.1, 0.062), vmMats.steelDark);
  fuller.position.y = 1.3;
  sword.add(fuller);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.108, 0.32, 4), vmMats.steel);
  tip.position.y = 2.72;
  tip.rotation.y = Math.PI / 4;
  sword.add(tip);
  sword.position.set(0, 0.02, 0);
  sword.rotation.set(-0.5, 0.1, -0.14);

  /* --- 자세 키프레임 (방패 없음 · 검 하나) ----------------------------------
     READY  = 오른손 검을 살짝 든 기본 자세
     GUARD  = 검을 화면 가운데로 옆으로 가로질러 세운 막기 자세
     WIND   = 내려치기 전에 검을 반대편 위로 치켜든 자세
     END    = 대각선 아래까지 내려간 자세 (여기서 위로 매끄럽게 복귀)
     ------------------------------------------------------------------------ */
  const POSE_READY = { px: 1.04, py: -1.42, pz: -4.95, rx: -0.05, ry: 0.1, rz: -0.12, sx: -0.5, sy: 0.1, sz: -0.14 };
  const POSE_GUARD = { px: 0.1, py: -0.62, pz: -3.3, rx: -0.16, ry: 0.02, rz: -1.36, sx: -0.12, sy: 0.02, sz: 0.02 };
  const _windPose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 };
  const _endPose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 };
  const _pose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 };

  function poseLerp(a, b, t) {
    _pose.px = a.px + (b.px - a.px) * t;
    _pose.py = a.py + (b.py - a.py) * t;
    _pose.pz = a.pz + (b.pz - a.pz) * t;
    _pose.rx = a.rx + (b.rx - a.rx) * t;
    _pose.ry = a.ry + (b.ry - a.ry) * t;
    _pose.rz = a.rz + (b.rz - a.rz) * t;
    _pose.sx = a.sx + (b.sx - a.sx) * t;
    _pose.sy = a.sy + (b.sy - a.sy) * t;
    _pose.sz = a.sz + (b.sz - a.sz) * t;
    return _pose;
  }

  /* 스와이프 방향(dx 오른쪽+, dy 아래+)에 맞춘 검 궤적 */
  function slashPoses(dx, dy) {
    const R = POSE_READY;
    _windPose.px = R.px + 0.32 * dx; _windPose.py = R.py + 0.52; _windPose.pz = R.pz + 0.2;
    _windPose.rx = R.rx - 0.55 * dy; _windPose.ry = R.ry; _windPose.rz = R.rz + 0.95 * dx;
    _windPose.sx = -0.72; _windPose.sy = 0.1; _windPose.sz = R.sz + 0.5 * dx;
    _endPose.px = R.px - 0.58 * dx; _endPose.py = R.py - 0.52 * dy; _endPose.pz = R.pz + 0.5;
    _endPose.rx = R.rx + 0.72 * dy; _endPose.ry = R.ry - 0.3 * dx; _endPose.rz = R.rz - 2.15 * dx;
    _endPose.sx = R.sx + 0.3 * dy; _endPose.sy = 0.1; _endPose.sz = R.sz - 0.35 * dx;
  }


  // 뷰모델 메시 수 (테스트용)
  let vmMeshes = 0;
  vm.traverse((o) => { if (o.isMesh) { vmMeshes++; o.name = 'vm-' + (o.geometry ? o.geometry.type : 'mesh'); } });

  let vmGuard = 0;
  let vmBob = 0;
  let vmHit = 0;
  const vmState = { phase: 0, dx: 0, dy: 0, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 };

  function updateViewModel(S, dt) {
    const pl = S.player;
    if (!pl) return;
    const run = clamp(plSpeed / 120, 0, 1);
    vmBob += (dt / 1000) * (2.0 + run * 9.0);
    const bob = Math.sin(vmBob) * (0.02 + run * 0.055);
    const sway = Math.sin(vmBob * 0.5) * (0.02 + run * 0.05);

    const dashK = pl.dash > 0 ? clamp(pl.dash / 190, 0, 1) : 0;
    vmHit = pl.hit > 0 ? clamp(pl.hit / 180, 0, 1) : 0;

    vm.position.set(sway, bob - 0.01, dashK * 0.62);
    vm.rotation.set(-run * 0.02 - dashK * 0.11 + vmHit * 0.02, 0, Math.sin(vmBob * 0.5) * 0.02 * run);

    /* --- 대각선 내려치기 → 위로 매끄러운 복귀 --- */
    const sw = pl.swipe || { sx: 0.7, sy: 0.72 };
    const dx = clamp(sw.sx, -1, 1), dy = clamp(sw.sy, -1, 1);
    const p = pl.atkAnim > 0 ? 1 - clamp(pl.atkAnim / ATK_DUR, 0, 1) : 0;
    let pose = POSE_READY;
    if (p > 0.0001) {
      slashPoses(dx, dy);
      if (p < 0.16) pose = poseLerp(POSE_READY, _windPose, easeOutCubic(p / 0.16));
      else if (p < 0.44) pose = poseLerp(_windPose, _endPose, easeInQuad((p - 0.16) / 0.28));
      else pose = poseLerp(_endPose, POSE_READY, smoothstep(clamp((p - 0.44) / 0.56, 0, 1)));
    }

    /* --- 막기: 검을 옆으로 가로질러 화면 가운데를 가로막는다 --- */
    const gTarget = pl.guard ? 1 : 0;
    vmGuard += (gTarget - vmGuard) * Math.min(1, dt / 70);
    let px = pose.px, py = pose.py, pz = pose.pz;
    let rx = pose.rx, ry = pose.ry, rz = pose.rz;
    let sx = pose.sx, sy = pose.sy, sz = pose.sz;
    if (vmGuard > 0.001) {
      const G = POSE_GUARD, g = vmGuard;
      px += (G.px - px) * g; py += (G.py - py) * g; pz += (G.pz - pz) * g;
      rx += (G.rx - rx) * g; ry += (G.ry - ry) * g; rz += (G.rz - rz) * g;
      sx += (G.sx - sx) * g; sy += (G.sy - sy) * g; sz += (G.sz - sz) * g;
    }

    swordArm.position.set(px, py + bob * 0.5, pz + dashK * 0.3);
    swordArm.rotation.set(rx, ry, rz);
    sword.rotation.set(sx, sy, sz);

    vmState.phase = p; vmState.dx = dx; vmState.dy = dy;
    vmState.px = swordArm.position.x; vmState.py = swordArm.position.y; vmState.pz = swordArm.position.z;
    vmState.rx = swordArm.rotation.x; vmState.ry = swordArm.rotation.y; vmState.rz = swordArm.rotation.z;
    vmState.sx = sword.rotation.x; vmState.sy = sword.rotation.y; vmState.sz = sword.rotation.z;
  }

  /* --- 깃발 · 불 애니메이션 --- */
  function updateBanners(t) {
    for (const b of banners) {
      const pos = b.cloth.attributes.position;
      const base = b.base;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const y = base[i * 3 + 1];
        const k = (x / 12 + 0.5);
        pos.array[i * 3 + 2] = Math.sin(x * 0.42 + t * 3.1 + b.phase) * 1.5 * k + Math.cos(y * 0.3 + t * 2.2) * 0.5 * k;
      }
      pos.needsUpdate = true;
    }
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const k = 0.85 + Math.sin(t * 7 + i * 2) * 0.13;
      f.scale.set(k, 0.9 + Math.sin(t * 9 + i) * 0.16, k);
      f.material.opacity = 0.75 + Math.sin(t * 11 + i) * 0.18;
    }
  }

  /* --- 프레임 --- */
  let lastTs = 0;
  let frames = 0;
  let timeSec = 0;
  let fpsAcc = 0, fpsN = 0, fpsLow = 0;
  let pixelScale = 1;

  function resize(w, h) {
    size.w = Math.max(1, Math.round(w));
    size.h = Math.max(1, Math.round(h));
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * pixelScale;
    renderer.setPixelRatio(dpr);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    // 세로(portrait) 화면에서 좌우 시야가 좁아 답답하지 않도록 수평 화각을 확보한다
    const halfH = Math.tan(28 * Math.PI / 180);        // 목표 수평 반화각 28° (hfov 56°)
    const vfov = 2 * Math.atan(halfH / camera.aspect) * 180 / Math.PI;
    camera.fov = clamp(vfov, 72, 92);
    camera.updateProjectionMatrix();
    vmCam.aspect = camera.aspect;
    vmCam.fov = camera.fov;
    vmCam.updateProjectionMatrix();
  }

  function render(S, ts) {
    let dt = lastTs ? Math.min(60, ts - lastTs) : 16;
    if (!(dt > 0)) dt = 16;
    lastTs = ts;
    timeSec += dt / 1000;

    buildCrowd(S, dt);
    syncSlashes(S);
    syncTrails(S);
    syncCuts(S);
    syncPieces(S, dt);
    syncParticles(S, dt);
    updateBanners(timeSec);
    updateCamera(S, dt);
    updateViewModel(S, dt);
    updateDust(timeSec, camera.position.x, camera.position.z);

    renderer.autoClear = true;
    renderer.info.reset();
    if (!window.__TW_VM_ONLY__) renderer.render(scene, camera);
    // 1인칭 손·검·방패는 월드 위에 깨끗하게 (깊이만 지우고 다시)
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(vmScene, vmCam);
    renderer.autoClear = true;
    frames++;

    if (!window.__TW_KEEP_RES__) {
      fpsAcc += 1000 / Math.max(1, dt);
      fpsN++;
      if (fpsN >= 120) {
        const fps = fpsAcc / fpsN;
        fpsAcc = 0; fpsN = 0;
        if (fps < 34 && pixelScale > 0.72) {
          pixelScale = Math.max(0.72, pixelScale - 0.16);
          resize(size.w, size.h);
        } else if (fps > 55 && pixelScale < 1) {
          pixelScale = Math.min(1, pixelScale + 0.1);
          resize(size.w, size.h);
        }
      }
    }
  }

  function disposeGroup(g) {
    g.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      }
    });
  }

  function dispose() {
    for (const [, v] of slashViews) { camera.remove(v.group); v.mat.dispose(); v.glowMat.dispose(); }
    slashViews.clear();
    for (const [, v] of trailViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    trailViews.clear();
    for (const [, v] of cutViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    cutViews.clear();
    for (const [, p] of pieces) disposePiece(p);
    pieces.clear();
    for (const P of parts) { P.mesh.dispose(); }
    arcMesh.dispose();
    for (const k in vmMats) vmMats[k].dispose();
    pGeo.dispose(); pMat.dispose();
    groundTex.dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) { /* noop */ }
  }

  /* --- 화면 투영 (2D 오버레이: 체력바 · 데미지 숫자) --- */
  function project(x, y, h) {
    tmpV.set(x - W / 2, h || 0, y - H / 2).project(camera);
    return {
      x: (tmpV.x * 0.5 + 0.5) * size.w,
      y: (-tmpV.y * 0.5 + 0.5) * size.h,
      z: tmpV.z,
      behind: tmpV.z > 1
    };
  }

  /** 화면 밖 적의 방향 (0 = 위, 시계방향) */
  function edgeAngle(x, y, h) {
    tmpV.set(x - W / 2, h || 0, y - H / 2);
    tmpV.applyMatrix4(camera.matrixWorldInverse);
    let sx = tmpV.x, sy = -tmpV.y;
    if (tmpV.z > 0) { sx = -sx || 0.0001; sy = -sy; }
    return Math.atan2(sx, sy);
  }

  const api = {
    kind: 'three',
    rev: REV,
    canvas: canvas,
    renderer: renderer,
    scene: scene,
    camera: camera,
    viewpoint: 'first-person',
    eye: EYE,
    viewmodel: { group: vm, swordArm: swordArm, shieldArm: null, sword: sword, meshes: vmMeshes, scene: vmScene },
    debugCamera: null,
    render: render,
    resize: resize,
    dispose: dispose,
    project: project,
    edgeAngle: edgeAngle,
    W: W,
    H: H,
    info: function () {
      return {
        frames: frames,
        units: aliveCount,
        unitsTotal: units.size,
        pieces: pieces.size,
        slashes: slashViews.size,
        trails: trailViews.size,
        cuts: cutViews.size,
        arcs: arcMesh.count,
        wind: windCount,
        swinging: swingCount,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        pixelRatio: renderer.getPixelRatio(),
        canvas: { w: canvas.width, h: canvas.height, cw: size.w, ch: size.h },
        camera: {
          x: camera.position.x, y: camera.position.y, z: camera.position.z,
          fov: camera.fov, yaw: camYaw, pitch: camPitch
        },
        fp: {
          eye: EYE,
          yaw: camYaw,
          pitch: camPitch,
          viewmodelMeshes: vmMeshes,
          viewmodelVisible: !!(vm.visible && swordArm.visible),
          viewmodelGuard: vmGuard,
          shield: false,
          swordPhase: vmState.phase,
          slashDir: { x: vmState.dx, y: vmState.dy },
          atkDur: ATK_DUR,
          sword: {
            x: vmState.px, y: vmState.py, z: vmState.pz,
            rx: vmState.rx, ry: vmState.ry, rz: vmState.rz,
            sx: vmState.sx, sy: vmState.sy, sz: vmState.sz
          }
        },
        crowd: { parts: parts.length, max: MAX_SOLDIERS },
        graphics: {
          env: !!scene.environment,
          lights: scene.children.filter((o) => !!o.isLight).length,
          dust: DUST_N,
          steelMetal: crowdMat.steel.metalness,
          steelRough: crowdMat.steel.roughness,
          vmSteelMetal: vmMats.steel.metalness,
          vmEnv: !!vmScene.environment,
          rim: rim.intensity,
          sun: sun.intensity
        },
        perspective: camera.isPerspectiveCamera
      };
    },
    piecesInfo: function () {
      const out = [];
      for (const [c, p] of pieces) {
        out.push({
          cut: p.cut,
          tilt: p.tilt,
          side: p.side,
          x: p.obj.position.x + W / 2,
          y: p.obj.position.z + H / 2,
          height: p.obj.position.y,
          opacity: p.opacity,
          parts: p.parts,
          core: p.coreColor,
          rot: c.rot,
          localN: { nx: p.localPlane.normal.x, ny: p.localPlane.normal.y, nz: p.localPlane.normal.z },
          plane: { nx: p.plane.normal.x, ny: p.plane.normal.y, nz: p.plane.normal.z, c: p.plane.constant }
        });
      }
      return out;
    },
    unitsInfo: function () {
      const out = [];
      for (const [u, v] of units) {
        out.push({ team: v.team, x: u.x, y: u.y, face: u.face, yaw: Math.PI / 2 - (u.face || 0), speed: v.speed, wind: u.wind || 0, swing: u.swing || 0 });
      }
      return out;
    }
  };
  return api;
}

window.TWArena3D = {
  supported: function () { return HAS_WEBGL; },
  create: create,
  revision: REV
};

export default window.TWArena3D;
