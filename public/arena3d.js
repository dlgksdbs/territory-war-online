/* =============================================================================
   직접 참전 · 3D 칼싸움 전장 (Three.js WebGL 렌더러) — 아침 하늘섬 개조판
   -----------------------------------------------------------------------------
   - 무대: 허공에 떠 있는 '아침 섬' — 밝은 아침 하늘, 따뜻한 아침 햇살, 섬 절벽,
     섬 아래로 흐르는 구름 바다, 멀리 떠 있는 작은 섬들.
   - 1인칭(FPS): 카메라는 병사 눈높이(≈20.5). 오른손 검 하나만 화면 앞에 그린다.
     검은 어깨(shoulder) → 팔꿈치(elbow) → 손목(wrist) 관절 계층으로 움직인다.
     자세는 쿼터니언 slerp 로 이어 붙여 짐벌락·각도 튐 없이 자연스럽게 휘두른다.
     (예비동작 → 대각선 내려치기 → 팔로우스루 → 위로 매끄러운 복귀)
   - 병사: InstancedMesh (지오메트리·재질 공유). 걷기/달리기는 무릎·팔꿈치 관절이
     있는 3단 다리 + 2단 팔 리그로, 상체 기울기·골반 흔들림까지 부드럽게 잇는다.
   - 적의 공격은 붉은 기운의 예고 검기 + 검끝 발광 + 내려치는 궤적으로 읽힌다.
   - 시뮬레이션은 arena.js 가 담당하고, 이 모듈은 그 상태(S)를 3D로 그린다.
   - three 는 public/vendor/three.module.min.js 로컬 서빙 (외부 CDN 없음)
   - WebGL 을 못 쓰면 window.TWArena3D.supported() === false → arena.js 가 2D 폴백
   ============================================================================= */
import * as THREE from './vendor/three.module.min.js';

const REV = THREE.REVISION;

function probeWebGL() {
  try {
    if (!window.WebGLRenderingContext) return false;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) {
    return false;
  }
}
let webglOk = probeWebGL();

/* ---------------------------------------------------------------------------
   작은 수학 도구들
   --------------------------------------------------------------------------- */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const easeInQuad = (t) => t * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const easeOutBack = (t) => {
  const c = 1.42;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
function damp(cur, target, dt, ms) {
  // 프레임레이트와 무관한 지수 감쇠 (관절이 툭 튀지 않고 부드럽게 따라간다)
  const k = 1 - Math.exp(-Math.max(1, dt) / Math.max(1, ms));
  return cur + (target - cur) * k;
}
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
function hexA(hex, a) {
  const h = String(hex || '#3b82f6').replace('#', '');
  const n = parseInt(h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16);
  if (!isFinite(n)) return 'rgba(59,130,246,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

const EYE = 20.5;               // 병사 눈높이 (월드 단위)
const MAX_SOLDIERS = 260;       // 동시에 그리는 병사 상한 (인스턴스 버퍼 크기 · 최대 1000명 난전용)
const ATK_DUR = 480;            // 1인칭 검 궤적 길이(ms)
const MAX_ARCS = 160;           // 검기/예고/검끝 발광 인스턴스 상한
const MAX_PIECES = 26;          // 동시에 굴리는 3D 두 동강 조각 상한

/* 아침 햇살 방향 (왼쪽 앞 위) — 그림자가 오른쪽 뒤로 길게 진다 */
const SUN_DIR = new THREE.Vector3(-0.42, 0.72, 0.55).normalize();
const SKY_TOP = 0x4f9fe0;
const SKY_MID = 0x9fd2f4;
const SKY_HORIZON = 0xffe9c2;
const FOG_COLOR = 0xd7ecfb;

/* ---------------------------------------------------------------------------
   공용 지오메트리 (병사 · 검 · 조각)
   --------------------------------------------------------------------------- */
const GEO = {
  leg: new THREE.BoxGeometry(2.05, 7.0, 2.3),
  shin: new THREE.BoxGeometry(1.8, 6.0, 2.0),
  boot: new THREE.BoxGeometry(2.4, 1.7, 3.5),
  torso: new THREE.CylinderGeometry(4.2, 3.15, 10.4, 12, 1),
  plate: new THREE.BoxGeometry(7.4, 5.0, 1.15),
  shoulder: new THREE.SphereGeometry(1.95, 12, 9),
  neck: new THREE.CylinderGeometry(1.3, 1.3, 2.2, 8),
  head: new THREE.SphereGeometry(2.45, 14, 11),
  helmet: new THREE.SphereGeometry(2.95, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
  visor: new THREE.BoxGeometry(4.7, 0.7, 0.95),
  sash: new THREE.BoxGeometry(6.2, 5.0, 0.9),
  tabard: new THREE.BoxGeometry(3.1, 8.6, 0.42),
  cape: new THREE.PlaneGeometry(5.4, 12.2),
  shield: new THREE.CylinderGeometry(2.9, 2.9, 0.5, 14),
  greave: new THREE.BoxGeometry(1.9, 2.9, 2.15),
  brim: new THREE.CylinderGeometry(3.15, 3.15, 0.26, 12),
  plume: new THREE.BoxGeometry(0.48, 4.4, 1.15),
  belt: new THREE.BoxGeometry(8.0, 1.4, 7.4),
  crest: new THREE.BoxGeometry(0.7, 3.4, 1.1),
  upperArm: new THREE.BoxGeometry(1.95, 5.1, 1.95),
  foreArm: new THREE.BoxGeometry(1.7, 4.6, 1.7),
  hand: new THREE.BoxGeometry(1.55, 1.5, 1.6),
  blade: new THREE.BoxGeometry(0.62, 0.46, 10.5),
  guard: new THREE.BoxGeometry(3.2, 0.65, 0.85),
  grip: new THREE.BoxGeometry(0.95, 0.95, 2.4),
  shadow: new THREE.PlaneGeometry(19, 19)
};

/* 큰 망치 중갑 장군 전용 지오메트리 — 병사 부품을 1.45배로 키우고, 뿔 달린 투구·
   덧댄 견갑·금장 흉갑·거대한 양손 워해머를 더한다 (지오메트리는 공유, 판마다 만들지 않는다) */
const GGEO = {
  torso: new THREE.CylinderGeometry(4.9, 3.9, 11.4, 12, 1),
  chest: new THREE.BoxGeometry(9.2, 6.4, 1.8),
  backPlate: new THREE.BoxGeometry(8.4, 5.4, 1.1),
  pauldron: new THREE.SphereGeometry(3.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
  pauldronRim: new THREE.CylinderGeometry(3.4, 3.1, 1.0, 14),
  pauldronSpike: new THREE.ConeGeometry(0.72, 2.8, 5),
  tasset: new THREE.BoxGeometry(3.9, 4.6, 0.8),
  gorget: new THREE.CylinderGeometry(2.9, 3.4, 1.6, 12),
  helmet: new THREE.SphereGeometry(3.25, 16, 11, 0, Math.PI * 2, 0, Math.PI * 0.6),
  horn: new THREE.ConeGeometry(0.9, 5.0, 6),
  crest: new THREE.BoxGeometry(0.55, 3.2, 1.6),
  belt: new THREE.BoxGeometry(9.8, 1.9, 8.8),
  buckle: new THREE.BoxGeometry(3.0, 2.3, 0.9),
  tabard: new THREE.BoxGeometry(3.9, 10.6, 0.5),
  cape: new THREE.PlaneGeometry(7.2, 14.6),
  emblem: new THREE.CylinderGeometry(2.0, 2.0, 0.5, 16),
  emblemBar: new THREE.BoxGeometry(3.6, 0.6, 0.62),
  leg: new THREE.BoxGeometry(3.3, 7.6, 3.3),
  shin: new THREE.BoxGeometry(3.0, 6.4, 3.0),
  boot: new THREE.BoxGeometry(3.6, 2.2, 4.8),
  greave: new THREE.BoxGeometry(3.2, 3.4, 3.2),
  upperArm: new THREE.BoxGeometry(2.9, 5.5, 2.9),
  foreArm: new THREE.BoxGeometry(2.6, 4.8, 2.6),
  hand: new THREE.BoxGeometry(2.3, 2.1, 2.3),
  // 워해머 — 자루는 +Z 방향, 머리는 끝에
  haft: new THREE.CylinderGeometry(0.78, 0.86, 17.0, 10),
  haftWrap: new THREE.CylinderGeometry(0.95, 0.95, 2.6, 10),
  haftCap: new THREE.SphereGeometry(1.15, 10, 8),
  headCore: new THREE.BoxGeometry(5.2, 4.8, 6.4),
  headBand: new THREE.BoxGeometry(5.6, 0.9, 6.8),
  headFace: new THREE.BoxGeometry(4.4, 4.2, 2.2),
  headSpike: new THREE.ConeGeometry(1.05, 3.4, 4),
  rune: new THREE.BoxGeometry(0.5, 0.9, 3.2)
};

/* ---------------------------------------------------------------------------
   텍스처 (모두 절차적 캔버스 · 한 번만 만들어 공유)
   --------------------------------------------------------------------------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function radialTexture(size, stops) {
  return canvasTex(size, size, (x) => {
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const s of stops) g.addColorStop(s[0], s[1]);
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
  });
}

/* 뭉게구름 — 부드러운 원 여러 개를 겹쳐 그린다 */
function cloudTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 160);
  const puffs = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    puffs.push({
      x: 128 + Math.cos(a) * (26 + (i % 5) * 9) * (0.7 + (i % 3) * 0.22),
      y: 92 + Math.sin(a) * (18 + (i % 4) * 5),
      r: 26 + (i % 6) * 7
    });
  }
  puffs.push({ x: 128, y: 84, r: 46 }, { x: 74, y: 96, r: 30 }, { x: 186, y: 98, r: 28 });
  for (const p of puffs) {
    const g = x.createRadialGradient(p.x, p.y - p.r * 0.18, p.r * 0.1, p.x, p.y, p.r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.55, 'rgba(252,254,255,0.62)');
    g.addColorStop(0.86, 'rgba(238,246,255,0.22)');
    g.addColorStop(1, 'rgba(232,242,255,0)');
    x.fillStyle = g;
    x.beginPath();
    x.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 초승달 검기 — 양 끝이 뾰족하게 사라지는 띠를 그린다 (중심이 아래, 호가 위로 뜬다) */
function crescentPath(x, cw, ch, width, pow, a0, a1, N) {
  const cx = cw / 2, cy = ch * 1.34;
  const rx = cw * 0.545, ry = ch * 1.06;
  const n = N || 72;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    pts.push({
      x: cx + Math.cos(a) * rx,
      y: cy + Math.sin(a) * ry,
      w: Math.pow(Math.sin(Math.PI * t), pow || 0.8)
    });
  }
  x.beginPath();
  for (let i = 0; i <= n; i++) {
    const p = pts[i], w = width * p.w;
    if (i === 0) x.moveTo(p.x, p.y - w); else x.lineTo(p.x, p.y - w);
  }
  for (let i = n; i >= 0; i--) {
    const p = pts[i], w = width * p.w;
    x.lineTo(p.x, p.y + w);
  }
  x.closePath();
}

function slashTexture(kind) {
  const W0 = 256, H0 = 128;
  const A0 = Math.PI * 1.115, A1 = Math.PI * 1.885;
  return canvasTex(W0, H0, (x) => {
    x.clearRect(0, 0, W0, H0);
    x.lineJoin = 'round';
    if (kind === 'glow') {
      // 부드러운 빛무리 — 넓게 번지고 낮은 알파 (흰색으로 뭉개지지 않게)
      for (let i = 4; i >= 1; i--) {
        const g = x.createLinearGradient(0, 0, W0, 0);
        g.addColorStop(0, 'rgba(90,180,255,0)');
        g.addColorStop(0.22, 'rgba(110,200,255,' + (0.05 * i) + ')');
        g.addColorStop(0.5, 'rgba(150,225,255,' + (0.10 * i) + ')');
        g.addColorStop(0.78, 'rgba(110,200,255,' + (0.05 * i) + ')');
        g.addColorStop(1, 'rgba(90,180,255,0)');
        crescentPath(x, W0, H0, 7 + i * 8, 0.95, A0, A1);
        x.fillStyle = g;
        x.fill();
      }
      return;
    }
    if (kind === 'core') {
      // 칼날이 지나간 자리의 하얀 심 — 가늘고 날카롭다
      const g = x.createLinearGradient(0, 0, W0, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.16, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(0.84, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      crescentPath(x, W0, H0, 4.2, 0.62, A0, A1);
      x.fillStyle = g;
      x.fill();
      // 끝으로 갈수록 뾰족하게 빠지는 잔날
      crescentPath(x, W0, H0, 2.2, 1.5, A0 + 0.12, A1 - 0.12);
      x.fillStyle = 'rgba(255,255,255,0.9)';
      x.fill();
      return;
    }
    // 본체 — 시안빛 코어에서 푸른 엣지로 번지는 초승달
    const g = x.createLinearGradient(0, 0, W0, 0);
    g.addColorStop(0, 'rgba(120,205,255,0)');
    g.addColorStop(0.14, 'rgba(140,215,255,0.30)');
    g.addColorStop(0.42, 'rgba(196,240,255,0.88)');
    g.addColorStop(0.5, 'rgba(226,248,255,0.98)');
    g.addColorStop(0.58, 'rgba(196,240,255,0.88)');
    g.addColorStop(0.86, 'rgba(140,215,255,0.30)');
    g.addColorStop(1, 'rgba(120,205,255,0)');
    crescentPath(x, W0, H0, 15, 0.8, A0, A1);
    x.fillStyle = g;
    x.fill();
    // 엣지 라인 — 초승달 바깥쪽을 따라 얇게 빛나는 선
    const e = x.createLinearGradient(0, 0, W0, 0);
    e.addColorStop(0, 'rgba(180,235,255,0)');
    e.addColorStop(0.3, 'rgba(210,245,255,0.55)');
    e.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    e.addColorStop(0.7, 'rgba(210,245,255,0.55)');
    e.addColorStop(1, 'rgba(180,235,255,0)');
    crescentPath(x, W0, H0, 3.4, 0.55, A0 - 0.02, A1 + 0.02);
    x.fillStyle = e;
    x.fill();
  });
}

const TEX = {
  shadow: radialTexture(64, [[0, 'rgba(0,0,0,0.55)'], [0.6, 'rgba(0,0,0,0.24)'], [1, 'rgba(0,0,0,0)']]),
  glow: radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,244,214,0.62)'], [1, 'rgba(255,226,170,0)']]),
  sun: radialTexture(128, [[0, 'rgba(255,255,255,1)'], [0.16, 'rgba(255,250,225,0.95)'], [0.5, 'rgba(255,236,180,0.34)'], [1, 'rgba(255,224,150,0)']]),
  cloud: cloudTexture(),
  slash: slashTexture('body'),
  slashCore: slashTexture('core'),
  slashGlow: slashTexture('glow'),
  core: canvasTex(128, 256, (x) => {
    /* 잘린 단면 — 피 대신 깨끗한 검은 심 + 푸른 빛 절단면 */
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
  })
};

/* ---------------------------------------------------------------------------
   전장 바닥 텍스처 — 아침 햇살 아래의 풀 · 흙길 · 돌바닥 · 진영 색 띠
   --------------------------------------------------------------------------- */
function terrainTexture(w, h, seed, meColor, enemyColor) {
  const areaK = clamp((w * h) / (280 * 600), 0.6, 4);
  const cw = clamp(Math.round(420 * Math.sqrt(areaK)), 420, 1024);
  const ch = Math.round(cw * (h / w));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const b = c.getContext('2d');
  const r = mulberry32(seed >>> 0);

  // 바탕: 아침 햇살을 받은 풀밭 (진한 초록 → 햇빛 받은 연둣빛)
  const g = b.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, '#5d8c40');
  g.addColorStop(0.28, '#6a9c48');
  g.addColorStop(0.62, '#659545');
  g.addColorStop(1, '#5a8a3f');
  b.fillStyle = g;
  b.fillRect(0, 0, cw, ch);

  // 큰 얼룩 — 숲 그늘과 햇빛 받은 마른 풀
  for (let i = 0; i < 90 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    const rad = 30 + r() * 130;
    const lg = b.createRadialGradient(x, y, 0, x, y, rad);
    const warm = r() < 0.45;
    lg.addColorStop(0, warm ? 'rgba(178,186,92,0.3)' : 'rgba(48,82,44,0.28)');
    lg.addColorStop(1, warm ? 'rgba(178,186,92,0)' : 'rgba(48,82,44,0)');
    b.fillStyle = lg;
    b.beginPath(); b.arc(x, y, rad, 0, Math.PI * 2); b.fill();
  }

  // 가운데 흙길 (중앙 세로 · 부드러운 한 줄기)
  b.save();
  b.beginPath();
  const roadPts = [];
  for (let y = ch * 0.03; y <= ch * 0.98; y += 10) {
    roadPts.push([cw / 2 + Math.sin(y * 0.009) * 34 + Math.sin(y * 0.003) * 20, y]);
  }
  b.moveTo(roadPts[0][0] - 40, roadPts[0][1]);
  for (const [px, py] of roadPts) b.lineTo(px - 42 - Math.sin(py * 0.02) * 8, py);
  for (let i = roadPts.length - 1; i >= 0; i--) b.lineTo(roadPts[i][0] + 42 + Math.sin(roadPts[i][1] * 0.02) * 8, roadPts[i][1]);
  b.closePath();
  b.fillStyle = 'rgba(178,148,104,0.72)';
  b.fill();
  b.clip();
  for (let i = 0; i < 900 * areaK; i++) {
    const x = cw / 2 + (r() - 0.5) * 140;
    const y = r() * ch;
    b.fillStyle = 'rgba(' + Math.round(120 + r() * 70) + ',' + Math.round(100 + r() * 55) + ',' + Math.round(68 + r() * 40) + ',' + (0.05 + r() * 0.16).toFixed(3) + ')';
    b.beginPath();
    b.ellipse(x, y, 2 + r() * 11, 1 + r() * 5, r() * 3, 0, Math.PI * 2);
    b.fill();
  }
  // 길 가장자리 자갈
  for (let i = 0; i < 240 * areaK; i++) {
    const side = r() < 0.5 ? -1 : 1;
    const x = cw / 2 + side * (44 + r() * 22);
    const y = r() * ch;
    b.fillStyle = 'rgba(196,190,178,' + (0.2 + r() * 0.35).toFixed(3) + ')';
    b.beginPath(); b.ellipse(x, y, 1.4 + r() * 3.2, 1 + r() * 2.4, r() * 3, 0, Math.PI * 2); b.fill();
  }
  b.restore();

  // 중앙 광장 — 밟혀서 흙이 드러난 넓은 타원
  const plaza = b.createRadialGradient(cw * 0.5, ch * 0.5, 8, cw * 0.5, ch * 0.5, cw * 0.3);
  plaza.addColorStop(0, 'rgba(176,150,106,0.4)');
  plaza.addColorStop(0.6, 'rgba(168,144,102,0.18)');
  plaza.addColorStop(1, 'rgba(168,144,102,0)');
  b.fillStyle = plaza;
  b.beginPath();
  b.ellipse(cw * 0.5, ch * 0.5, cw * 0.32, ch * 0.2, 0, 0, Math.PI * 2);
  b.fill();

  // 풀 더미 — 크고 작은 초록 얼룩 (가까이서도 바닥이 살아 있게)
  for (let i = 0; i < 700 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    const rr = 4 + r() * 16;
    const dark = r() < 0.5;
    b.fillStyle = dark
      ? 'rgba(' + (52 + Math.round(r() * 30)) + ',' + (92 + Math.round(r() * 34)) + ',' + (44 + Math.round(r() * 22)) + ',' + (0.1 + r() * 0.18).toFixed(3) + ')'
      : 'rgba(' + (128 + Math.round(r() * 44)) + ',' + (166 + Math.round(r() * 40)) + ',' + (76 + Math.round(r() * 30)) + ',' + (0.08 + r() * 0.16).toFixed(3) + ')';
    b.beginPath();
    b.ellipse(x, y, rr, rr * (0.6 + r() * 0.7), r() * 3, 0, Math.PI * 2);
    b.fill();
  }
  // 작은 돌 — 그림자까지 그려 바닥에 박힌 느낌
  for (let i = 0; i < 220 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    const rr = 1.6 + r() * 3.4;
    b.fillStyle = 'rgba(60,64,58,0.25)';
    b.beginPath(); b.ellipse(x + rr * 0.4, y + rr * 0.5, rr * 1.1, rr * 0.7, 0, 0, Math.PI * 2); b.fill();
    b.fillStyle = 'rgba(' + (150 + Math.round(r() * 40)) + ',' + (144 + Math.round(r() * 40)) + ',' + (128 + Math.round(r() * 36)) + ',0.85)';
    b.beginPath(); b.ellipse(x, y, rr, rr * 0.78, r() * 3, 0, Math.PI * 2); b.fill();
  }

  // 흙 · 자갈 반점
  for (let i = 0; i < 2600 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    const l = 70 + r() * 90;
    b.fillStyle = 'rgba(' + Math.round(l) + ',' + Math.round(l * 0.94) + ',' + Math.round(l * 0.8) + ',' + (0.04 + r() * 0.12).toFixed(3) + ')';
    b.fillRect(x, y, 1 + r() * 3, 1 + r() * 2);
  }
  // 풀잎 (햇살에 밝게)
  for (let i = 0; i < 2200 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    b.strokeStyle = 'rgba(' + (110 + Math.round(r() * 70)) + ',' + (160 + Math.round(r() * 70)) + ',' + (80 + Math.round(r() * 50)) + ',' + (0.16 + r() * 0.3).toFixed(3) + ')';
    b.lineWidth = 1 + r();
    b.beginPath();
    b.moveTo(x, y);
    b.lineTo(x + (r() - 0.5) * 6, y - 4 - r() * 9);
    b.stroke();
  }
  // 아주 작은 들꽃 (아침 빛)
  for (let i = 0; i < 220 * areaK; i++) {
    const x = r() * cw, y = r() * ch;
    b.fillStyle = r() < 0.5 ? 'rgba(255,252,214,0.75)' : 'rgba(252,226,150,0.7)';
    b.beginPath(); b.arc(x, y, 0.9 + r() * 1.2, 0, Math.PI * 2); b.fill();
  }

  // 진영 색 띠 (위 = 아군, 아래 = 적군) — 낮이라 옅게
  const me = colorOf(meColor, '#3b82f6');
  const en = colorOf(enemyColor, '#ef4444');
  const meCss = '#' + me.getHexString();
  const enCss = '#' + en.getHexString();
  const bandTop = ch * 0.17;
  const top = b.createLinearGradient(0, 0, 0, bandTop);
  top.addColorStop(0, hexA(meCss, 0.2));
  top.addColorStop(1, hexA(meCss, 0));
  b.fillStyle = top;
  b.fillRect(0, 0, cw, bandTop);
  const bot = b.createLinearGradient(0, ch, 0, ch - bandTop);
  bot.addColorStop(0, hexA(enCss, 0.2));
  bot.addColorStop(1, hexA(enCss, 0));
  b.fillStyle = bot;
  b.fillRect(0, ch - bandTop, cw, bandTop);
  // 진영 흙 마당
  b.fillStyle = 'rgba(160,142,104,0.16)';
  b.beginPath(); b.ellipse(cw * 0.22, ch * 0.06, cw * 0.15, ch * 0.028, 0, 0, Math.PI * 2); b.fill();
  b.beginPath(); b.ellipse(cw * 0.78, ch * 0.94, cw * 0.15, ch * 0.028, 0, 0, Math.PI * 2); b.fill();
  // 가장자리는 살짝만 어둡게 (낮의 노을 느낌)
  const vg = b.createLinearGradient(0, 0, cw, 0);
  vg.addColorStop(0, 'rgba(74,86,52,0.34)');
  vg.addColorStop(0.16, 'rgba(74,86,52,0)');
  vg.addColorStop(0.84, 'rgba(74,86,52,0)');
  vg.addColorStop(1, 'rgba(74,86,52,0.34)');
  b.fillStyle = vg;
  b.fillRect(0, 0, cw, ch);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* ---------------------------------------------------------------------------
   병사 모델 (절차적 3D 메시) — 3D 두 동강 조각용
   --------------------------------------------------------------------------- */
function buildSoldier(color, opts) {
  const o = opts || {};
  const col = colorOf(color, '#3b82f6');
  const g = new THREE.Group();
  const mats = {
    armor: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.52), roughness: 0.42, metalness: 0.4, envMapIntensity: 1.0 }),
    plate: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.68).lerp(new THREE.Color(0xd9e2ee), 0.3), roughness: 0.34, metalness: 0.55, envMapIntensity: 1.2 }),
    cloth: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(1.0), roughness: 0.88, envMapIntensity: 0.7 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xeaf2ff, roughness: 0.16, metalness: 0.97, emissive: col.clone().multiplyScalar(0.1), emissiveIntensity: 0.4, envMapIntensity: 1.6 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd09a6c, roughness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9 }),
    crest: new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.5), roughness: 0.45, emissive: col.clone(), emissiveIntensity: 0.5, envMapIntensity: 0.8 }),
    capeM: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.7), roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.5 })
  };

  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 2.05, 9.6, 0);
    const thigh = new THREE.Mesh(GEO.leg, mats.dark);
    thigh.position.y = -3.4;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -6.9;
    hip.add(knee);
    const shin = new THREE.Mesh(GEO.shin, mats.dark);
    shin.position.y = -3.0;
    knee.add(shin);
    const greave = new THREE.Mesh(GEO.greave, mats.steel);
    greave.position.set(0, -3.2, 0.12);
    knee.add(greave);
    const boot = new THREE.Mesh(GEO.boot, mats.dark);
    boot.position.set(0, -6.2, 0.55);
    knee.add(boot);
    g.add(hip);
    legs.push(hip);
  }

  const torso = new THREE.Mesh(GEO.torso, mats.armor);
  torso.position.y = 15.2;
  g.add(torso);
  const plate = new THREE.Mesh(GEO.plate, mats.plate);
  plate.position.set(0, 16.1, 2.5);
  g.add(plate);
  const belt = new THREE.Mesh(GEO.belt, mats.dark);
  belt.position.y = 10.4;
  g.add(belt);
  const tabard = new THREE.Mesh(GEO.tabard, mats.cloth);
  tabard.position.set(0, 13.6, 2.55);
  g.add(tabard);
  const cape = new THREE.Mesh(GEO.cape, mats.capeM);
  cape.position.set(0, 15.4, -2.5);
  cape.rotation.x = 0.12;
  g.add(cape);
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
  const brim = new THREE.Mesh(GEO.brim, mats.steel);
  brim.position.y = 23.1;
  g.add(brim);
  const visor = new THREE.Mesh(GEO.visor, mats.dark);
  visor.position.set(0, 22.7, 2.35);
  g.add(visor);
  const crest = new THREE.Mesh(GEO.crest, mats.crest);
  crest.position.set(0, 26.1, -1.5);
  crest.rotation.x = -0.16;
  g.add(crest);
  const plume = new THREE.Mesh(GEO.plume, mats.crest);
  plume.position.set(0, 26.6, -0.4);
  plume.rotation.x = -0.22;
  g.add(plume);

  const armR = new THREE.Group();
  armR.position.set(4.75, 19.1, 0);
  const upR = new THREE.Mesh(GEO.upperArm, mats.armor);
  upR.position.y = -2.6;
  armR.add(upR);
  const elbowR = new THREE.Group();
  elbowR.position.y = -5.2;
  armR.add(elbowR);
  const foreR = new THREE.Mesh(GEO.foreArm, mats.skin);
  foreR.position.y = -2.4;
  elbowR.add(foreR);
  const handR = new THREE.Mesh(GEO.hand, mats.dark);
  handR.position.y = -5.0;
  elbowR.add(handR);
  const sword = new THREE.Group();
  sword.position.set(0, -5.3, 0);
  const grip = new THREE.Mesh(GEO.grip, mats.dark);
  grip.position.z = -1.1;
  sword.add(grip);
  const guard = new THREE.Mesh(GEO.guard, mats.steel);
  guard.position.z = 0.6;
  sword.add(guard);
  const blade = new THREE.Mesh(GEO.blade, mats.steel);
  blade.position.z = 5.9;
  sword.add(blade);
  elbowR.add(sword);
  g.add(armR);

  const armL = new THREE.Group();
  armL.position.set(-4.75, 19.1, 0);
  const upL = new THREE.Mesh(GEO.upperArm, mats.armor);
  upL.position.y = -2.6;
  armL.add(upL);
  const elbowL = new THREE.Group();
  elbowL.position.y = -5.2;
  armL.add(elbowL);
  const foreL = new THREE.Mesh(GEO.foreArm, mats.skin);
  foreL.position.y = -2.4;
  elbowL.add(foreL);
  const handL = new THREE.Mesh(GEO.hand, mats.dark);
  handL.position.y = -5.0;
  elbowL.add(handL);
  const shieldL = new THREE.Mesh(GEO.shield, mats.cloth);
  shieldL.position.set(0, -3.2, 1.3);
  shieldL.rotation.x = Math.PI / 2;
  elbowL.add(shieldL);
  g.add(armL);

  const shadow = new THREE.Mesh(GEO.shadow, new THREE.MeshBasicMaterial({
    map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.7
  }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.14;
  shadow.userData.shadow = true;
  g.add(shadow);

  return {
    group: g, mats: mats,
    parts: { legs: legs, torso: torso, head: head, armR: armR, armL: armL, sword: sword, crest: crest }
  };
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
  const worldDiag = Math.hypot(W, H);
  const skyR = Math.max(maxD * 2.4, worldDiag * 1.05);

  /* ---------- 렌더러 ---------- */
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.setClearColor(FOG_COLOR, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = true;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.Fog(FOG_COLOR, maxD * 1.7, maxD * 4.4);

  const camera = new THREE.PerspectiveCamera(68, 0.46, 0.6, Math.max(maxD * 3.6, worldDiag * 2.4));
  scene.add(camera);

  /* ---------- 환경 반사 (아침 하늘 + 햇살) — 검날·투구의 광택 ---------- */
  let envTexture = null;
  try {
    const ec = document.createElement('canvas');
    ec.width = 256; ec.height = 128;
    const ex = ec.getContext('2d');
    const eg = ex.createLinearGradient(0, 0, 0, 128);
    eg.addColorStop(0, '#3f8fd4');
    eg.addColorStop(0.36, '#8ec6ee');
    eg.addColorStop(0.52, '#dceefb');
    eg.addColorStop(0.6, '#ffe9c4');
    eg.addColorStop(0.72, '#a9c98c');
    eg.addColorStop(1, '#6f8a52');
    ex.fillStyle = eg;
    ex.fillRect(0, 0, 256, 128);
    const sunGlow = ex.createRadialGradient(58, 40, 0, 58, 40, 46);
    sunGlow.addColorStop(0, 'rgba(255,255,250,1)');
    sunGlow.addColorStop(0.22, 'rgba(255,246,214,0.9)');
    sunGlow.addColorStop(1, 'rgba(255,236,190,0)');
    ex.fillStyle = sunGlow;
    ex.fillRect(0, 0, 256, 128);
    const envSrc = new THREE.CanvasTexture(ec);
    envSrc.mapping = THREE.EquirectangularReflectionMapping;
    envSrc.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(envSrc);
    envTexture = envRT.texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.42;
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

  /* ---------- 조명 (아침 햇살 + 하늘 채움광) ---------- */
  const hemi = new THREE.HemisphereLight(0xbfdcff, 0x46512a, 0.7);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xfff2da, 0.08));

  const sun = new THREE.DirectionalLight(0xfff1d0, 2.0);
  sun.position.copy(SUN_DIR).multiplyScalar(520);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 40;
  sun.shadow.camera.far = 1400;
  sun.shadow.camera.left = -190;
  sun.shadow.camera.right = 190;
  sun.shadow.camera.top = 190;
  sun.shadow.camera.bottom = -190;
  sun.shadow.bias = -0.0015;
  sun.shadow.normalBias = 0.9;
  scene.add(sun);
  scene.add(sun.target);

  const rim = new THREE.DirectionalLight(0x9dc9ff, 0.55);
  rim.position.set(220, 160, -260);
  scene.add(rim);
  const bounce = new THREE.DirectionalLight(0xffe3b8, 0.35);
  bounce.position.set(40, -40, 200);
  scene.add(bounce);

  /* ---------- 하늘 돔 · 해 · 먼 섬 · 구름 ---------- */
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);
  (function addSky() {
    const tex = canvasTex(8, 512, (x) => {
      const g = x.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0, '#2b6fb8');
      g.addColorStop(0.3, '#4d94d8');
      g.addColorStop(0.55, '#8dc2ec');
      g.addColorStop(0.66, '#c4e0f6');
      g.addColorStop(0.73, '#ffe0b0');
      g.addColorStop(0.82, '#f2f6f2');
      g.addColorStop(1, '#dcebf6');
      x.fillStyle = g;
      x.fillRect(0, 0, 8, 512);
    });
    tex.wrapS = THREE.ClampToEdgeWrapping;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(skyR, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.72),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    dome.position.y = -skyR * 0.1;
    skyGroup.add(dome);

    // 해 — 아침 햇살 덩어리
    const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.sun, color: 0xfff6dd, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    sunSprite.scale.set(skyR * 0.15, skyR * 0.15, 1);
    sunSprite.position.copy(SUN_DIR).multiplyScalar(skyR * 0.82);
    skyGroup.add(sunSprite);

    // 햇살 기둥 (넓고 옅은 빛무리)
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.sun, color: 0xffe9b8, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    halo.scale.set(skyR * 0.4, skyR * 0.4, 1);
    halo.position.copy(SUN_DIR).multiplyScalar(skyR * 0.8);
    skyGroup.add(halo);
  })();

  /* 멀리 떠 있는 작은 섬들 */
  const farIslands = [];
  (function addFarIslands() {
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8577, roughness: 1, flatShading: true });
    const farRockMat = new THREE.MeshStandardMaterial({ color: 0xa9b4b8, roughness: 1, flatShading: true });
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x7fae57, roughness: 0.95 });
    const n = 8;
    for (let i = 0; i < n; i++) {
      const far = i % 2 === 0;
      const a = (i / n) * Math.PI * 2 + rand() * 0.5;
      const dist = skyR * (far ? 0.44 + rand() * 0.12 : 0.3 + rand() * 0.08);
      const sc = (far ? 2.3 : 1.5) * (0.8 + rand() * 0.6);
      const grp = new THREE.Group();
      const rock = new THREE.Mesh(new THREE.ConeGeometry(46 * sc, 92 * sc, 7, 1), far ? farRockMat : rockMat);
      rock.rotation.x = Math.PI;              // 뾰족한 끝이 아래로
      rock.position.y = -44 * sc;
      grp.add(rock);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(46 * sc, 40 * sc, 8 * sc, 9), grassMat);
      top.position.y = 2 * sc;
      grp.add(top);
      const knoll = new THREE.Mesh(new THREE.ConeGeometry(16 * sc, 26 * sc, 6), grassMat);
      knoll.position.set(12 * sc, 16 * sc, -8 * sc);
      grp.add(knoll);
      grp.position.set(Math.cos(a) * dist, 60 + rand() * 190, Math.sin(a) * dist);
      grp.userData.bob = rand() * 6.28;
      grp.userData.baseY = grp.position.y;
      scene.add(grp);
      farIslands.push(grp);
    }
  })();

  /* 가까이 떠 있는 큰 섬 3개 — '허공에 떠 있는 섬'이라는 느낌을 확실히 */
  const heroIslands = [];
  (function addHeroIslands() {
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8f8778, roughness: 1, flatShading: true });
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x74a54c, roughness: 0.95, flatShading: true });
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x39682f, roughness: 0.95, flatShading: true });
    const defs = [
      { a: Math.PI * 0.86, d: 470, y: 96, r: 150 },
      { a: Math.PI * 1.55, d: 520, y: 52, r: 185 },
      { a: Math.PI * 0.28, d: 430, y: 168, r: 118 }
    ];
    for (const d of defs) {
      const grp = new THREE.Group();
      const rock = new THREE.Mesh(new THREE.ConeGeometry(d.r, d.r * 1.3, 10, 1), rockMat);
      rock.rotation.x = Math.PI;
      rock.position.y = -d.r * 0.62;
      grp.add(rock);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 1.02, d.r * 0.94, d.r * 0.1, 12), grassMat);
      cap.position.y = 0.02;
      grp.add(cap);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 1.04, d.r * 1.02, d.r * 0.045, 12), rockMat);
      rim.position.y = -d.r * 0.05;
      grp.add(rim);
      // 위에 작은 나무 몇 그루 + 바위
      for (let i = 0; i < 4; i++) {
        const tree = new THREE.Mesh(new THREE.ConeGeometry(d.r * 0.045, d.r * 0.17, 6), treeMat);
        const ang = rand() * 6.28, rr = d.r * (0.1 + rand() * 0.55);
        tree.position.set(Math.cos(ang) * rr, d.r * 0.12, Math.sin(ang) * rr);
        grp.add(tree);
      }
      const boulder = new THREE.Mesh(new THREE.DodecahedronGeometry(d.r * 0.1, 0), rockMat);
      boulder.position.set(-d.r * 0.4, d.r * 0.11, d.r * 0.2);
      grp.add(boulder);
      grp.position.set(Math.cos(d.a) * d.d, d.y, Math.sin(d.a) * d.d);
      grp.userData.baseY = d.y;
      grp.userData.bob = rand() * 6.28;
      scene.add(grp);
      heroIslands.push(grp);
    }
  })();

  /* 3D 구름 — 섬 주변과 아래를 떠다닌다 */
  const clouds = [];
  (function addClouds() {
    const n = 42;
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: TEX.cloud, transparent: true, opacity: 0.8, depthWrite: false,
        color: i % 4 === 0 ? 0xe8f1fb : 0xfbfdff
      });
      const s = new THREE.Sprite(mat);
      const ang = rand() * Math.PI * 2;
      const layer = i % 3;                        // 0: 섬 아래 구름바다 / 1: 먼 지평선 / 2: 높은 하늘 (멀리)
      const dist = skyR * (layer === 0 ? (0.26 + rand() * 0.5) : layer === 1 ? (0.48 + rand() * 0.25) : (0.55 + rand() * 0.25));
      const yy = layer === 0 ? (-50 - rand() * 130) : layer === 1 ? (10 + rand() * 60) : (130 + rand() * 200);
      const sc = (layer === 2 ? 150 + rand() * 170 : 110 + rand() * 150);
      s.scale.set(sc, sc * 0.52, 1);
      s.position.set(Math.cos(ang) * dist, yy, Math.sin(ang) * dist);
      s.material.opacity = 0.78 + rand() * 0.2;
      s.material.rotation = (rand() - 0.5) * 0.35;
      scene.add(s);
      clouds.push({ sprite: s, ang: ang, dist: dist, y: yy, spd: (rand() < 0.5 ? -1 : 1) * (0.005 + rand() * 0.01), bob: rand() * 6.28 });
    }
  })();

  /* 섬 아래 구름 바다 */
  (function addCloudSea() {
    const tex = TEX.cloud.clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(7, 7);
    tex.needsUpdate = true;
    const sea = new THREE.Mesh(
      new THREE.CircleGeometry(skyR * 2.6, 36),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92, depthWrite: false, color: 0xffffff })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -210;
    scene.add(sea);
  })();

  /* ---------- 떠 있는 섬 본체 ---------- */
  const island = new THREE.Group();
  scene.add(island);

  // 섬 아래 절벽 몸통 — 위는 전장 크기 그대로, 아래로 갈수록 좁아지며 뾰족해진다
  (function addIslandBody() {
    const segs = 72;
    const rings = [
      [0.6, 1.0], [-8, 0.985], [-24, 0.93], [-48, 0.82],
      [-78, 0.64], [-112, 0.42], [-146, 0.2], [-172, 0.03]
    ];
    const jit = [];
    for (let i = 0; i < segs; i++) jit.push(1 + rand() * 0.022);   // 바깥으로만 부풀려 땅이 절대 밖으로 삐져나오지 않게
    const pos = [];
    const col = [];
    const idx = [];
    const c = new THREE.Color();
    for (let r2 = 0; r2 < rings.length; r2++) {
      const y = rings[r2][0], k = rings[r2][1];
      for (let i = 0; i < segs; i++) {
        const t = (i / segs) * Math.PI * 2;
        const ca = Math.cos(t), sa = Math.sin(t);
        const kk = k * jit[i] * (1 + Math.sin(t * 3.1 + r2) * 0.012);
        const x = (W / 2) * kk * Math.sign(ca) * Math.pow(Math.abs(ca), 0.06);
        const z = (H / 2) * kk * Math.sign(sa) * Math.pow(Math.abs(sa), 0.06);
        pos.push(x, y + Math.sin(t * 5.3 + r2 * 1.7) * (r2 === 0 ? 0.4 : 2.6), z);
        if (r2 === 0) c.setHex(0x8fae62);
        else if (r2 === 1) c.setHex(0xa79a86);
        else if (r2 === 2) c.setHex(0x998d7b);
        else if (r2 === 3) c.setHex(0x86796a);
        else if (r2 === 4) c.setHex(0x6d6357);
        else c.setHex(0x574f46);
        const shade = 0.9 + ((i * 37 + r2 * 13) % 7) * 0.028;
        col.push(c.r * shade, c.g * shade, c.b * shade);
      }
    }
    for (let r2 = 0; r2 < rings.length - 1; r2++) {
      for (let i = 0; i < segs; i++) {
        const a = r2 * segs + i;
        const b = r2 * segs + (i + 1) % segs;
        const cIdx = (r2 + 1) * segs + i;
        const d = (r2 + 1) * segs + (i + 1) % segs;
        idx.push(a, cIdx, b, b, cIdx, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0.02, flatShading: true });
    const body = new THREE.Mesh(geo, mat);
    body.receiveShadow = true;
    island.add(body);

    // 절벽에 붙은 바위 덩어리 (실루엣을 거칠게)
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a8f7f, roughness: 1, flatShading: true });
    const nR = clamp(Math.round((W + H) / 34), 28, 74);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, nR);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s3 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    for (let i = 0; i < nR; i++) {
      const t = rand() * Math.PI * 2;
      const ca = Math.cos(t), sa = Math.sin(t);
      const x = (W / 2) * Math.sign(ca) * Math.pow(Math.abs(ca), 0.06) * 1.01;
      const z = (H / 2) * Math.sign(sa) * Math.pow(Math.abs(sa), 0.06) * 1.01;
      const k = 7 + rand() * 17;
      p3.set(x, -4 - rand() * 34, z);
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      s3.set(k, k * (0.7 + rand() * 0.7), k * (0.7 + rand() * 0.6));
      m.compose(p3, q, s3);
      rocks.setMatrixAt(i, m);
    }
    rocks.instanceMatrix.needsUpdate = true;
    rocks.castShadow = true;
    island.add(rocks);

    // 섬 밖으로 떠 있는 작은 바위들
    const chunkN = 11;
    const chunks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x9c9384, roughness: 1, flatShading: true }), chunkN);
    const chunkData = [];
    for (let i = 0; i < chunkN; i++) {
      const a = rand() * Math.PI * 2;
      const d = (W / 2) * (1.02 + rand() * 0.26);
      const sc = 3 + rand() * 8;
      const p = new THREE.Vector3(Math.cos(a) * d, -14 - rand() * 70, Math.sin(a) * d * (H / W) * 0.6);
      chunkData.push({ p: p, sc: sc, ph: rand() * 6.28 });
      s3.set(sc, sc * 0.8, sc);
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      m.compose(p, q, s3);
      chunks.setMatrixAt(i, m);
    }
    chunks.instanceMatrix.needsUpdate = true;
    island.add(chunks);
    island.userData.chunks = chunks;
    island.userData.chunkData = chunkData;
    island.userData.body = body;
  })();

  /* ---------- 전장 바닥 ---------- */
  const groundTex = terrainTexture(W, H, cfg.seed || 1, meHex, enemyHex);
  groundTex.center.set(0.5, 0.5);
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.94, metalness: 0.0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  /* ---------- 섬 가장자리 — 낮은 돌담 + 나무 말뚝 (경계) ---------- */
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xb3ab9b, roughness: 0.95, flatShading: true });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x9a7047, roughness: 0.88 });
  const woodDarkMat = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.9 });
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s3 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    // 섬 가장자리 성벽 — 허공으로 떨어지는 절벽 위에 세워진 낮은 성곽
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(5.5, 12.0, H + 6), stoneMat);
      wall.position.set(sx * (W / 2 - 1), 5.0, 0);
      wall.castShadow = true; wall.receiveShadow = true;
      scene.add(wall);
    }
    for (const sz of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(W + 6, 12.0, 5.5), stoneMat);
      wall.position.set(0, 5.0, sz * (H / 2 - 1));
      wall.castShadow = true; wall.receiveShadow = true;
      scene.add(wall);
    }
    // 총안(crenellation)
    const merlonN = clamp(Math.round((W + H) / 15), 60, 190);
    const merlonGeo = new THREE.BoxGeometry(5.6, 2.6, 5.6);
    const merlons = new THREE.InstancedMesh(merlonGeo, stoneMat, merlonN);
    {
      let i = 0;
      const half = Math.floor(merlonN / 2);
      for (let k = 0; k < half && i < merlonN; k++) {
        const z = -H / 2 + 8 + (k * (H - 16)) / Math.max(1, half - 1);
        for (const sx of [-1, 1]) {
          if (i >= merlonN) break;
          p3.set(sx * (W / 2 - 1), 12.2, z);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
          s3.set(1, 1, 0.9);
          m.compose(p3, q, s3);
          merlons.setMatrixAt(i++, m);
        }
      }
      merlons.count = i;
      merlons.instanceMatrix.needsUpdate = true;
      merlons.castShadow = true;
      scene.add(merlons);
    }
    // 성벽 위 깃발 몇 개
    for (let k = 0; k < 6; k++) {
      const sz2 = (k % 2 ? 1 : -1);
      const zz = -H * 0.4 + (k * H * 0.14);
      const sx2 = sz2 * (W / 2 - 3);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 14, 5), woodMat);
      pole.position.set(sx2, 20, zz);
      scene.add(pole);
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(5, 3.2), new THREE.MeshStandardMaterial({
        color: sz2 > 0 ? meHex : enemyHex, roughness: 0.9, side: THREE.DoubleSide,
        emissive: sz2 > 0 ? meHex : enemyHex, emissiveIntensity: 0.2
      }));
      fl.position.set(sx2 - sz2 * 2.6, 24, zz);
      scene.add(fl);
    }
    // 절벽 위 바위 능선 — 가장자리 실루엣을 거칠게
    const rimRockN = clamp(Math.round((W + H) / 26), 26, 110);
    const rimRocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x9d9484, roughness: 1, flatShading: true }), rimRockN);
    for (let i = 0; i < rimRockN; i++) {
      const side = i % 4;
      let x = 0, z = 0;
      const t = rand();
      if (side === 0) { x = -W / 2 + 6; z = -H / 2 + t * H; }
      else if (side === 1) { x = W / 2 - 6; z = -H / 2 + t * H; }
      else if (side === 2) { x = -W / 2 + t * W; z = -H / 2 + 6; }
      else { x = -W / 2 + t * W; z = H / 2 - 6; }
      const k2 = 4 + rand() * 9;
      p3.set(x + (rand() - 0.5) * 8, 1.5 + rand() * 2, z + (rand() - 0.5) * 8);
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      s3.set(k2, k2 * (0.6 + rand() * 0.5), k2 * (0.8 + rand() * 0.4));
      m.compose(p3, q, s3);
      rimRocks.setMatrixAt(i, m);
    }
    rimRocks.instanceMatrix.needsUpdate = true;
    rimRocks.castShadow = true;
    scene.add(rimRocks);
    // 나무 말뚝 (깎은 끝)
    const postN = clamp(Math.round((W + H) / 26), 20, 90);
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.65, 0.85, 13, 6), woodMat, postN);
    let i = 0;
    for (let k = 0; k < postN / 2 && i < postN; k++) {
      const z = -H / 2 + 26 + (k * (H - 52)) / Math.max(1, postN / 2 - 1);
      for (const sx of [-1, 1]) {
        p3.set(sx * (W / 2 - 4.5), 8.5, z);
        q.setFromEuler(new THREE.Euler(0, rand(), (rand() - 0.5) * 0.06));
        s3.set(1, 0.85 + rand() * 0.3, 1);
        m.compose(p3, q, s3);
        posts.setMatrixAt(i++, m);
      }
    }
    posts.count = i;
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    scene.add(posts);
    // 가로대
    for (const sx of [-1, 1]) {
      for (const yy of [6.5, 10.5]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, H - 40), woodDarkMat);
        rail.position.set(sx * (W / 2 - 4.6), yy, 0);
        scene.add(rail);
      }
    }
  }

  /* ---------- 풀 · 꽃 · 돌 장식 ---------- */
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const grassN = clamp(Math.round(520 * areaK), 260, 900);
    const grass = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.38, 1.15, 4),
      new THREE.MeshStandardMaterial({ color: 0x6fa348, roughness: 1, flatShading: true }),
      grassN
    );
    for (let i = 0; i < grassN; i++) {
      p.set((rand() - 0.5) * (W - 26), 0.55, (rand() - 0.5) * (H - 26));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
      const k = 0.55 + rand() * 0.8;
      s.set(k, k * (0.7 + rand() * 0.9), k);
      m.compose(p, q, s);
      grass.setMatrixAt(i, m);
    }
    grass.instanceMatrix.needsUpdate = true;
    scene.add(grass);

    const flowerN = clamp(Math.round(90 * areaK), 40, 180);
    const flowers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.36, 5, 4),
      new THREE.MeshStandardMaterial({ color: 0xfff3c4, roughness: 0.7, emissive: 0xffe7a0, emissiveIntensity: 0.25 }),
      flowerN
    );
    for (let i = 0; i < flowerN; i++) {
      p.set((rand() - 0.5) * (W - 30), 1.3 + rand() * 0.5, (rand() - 0.5) * (H - 30));
      const k = 0.8 + rand() * 0.7;
      s.set(k, k, k);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
      m.compose(p, q, s);
      flowers.setMatrixAt(i, m);
    }
    flowers.instanceMatrix.needsUpdate = true;
    scene.add(flowers);

    const pebbleN = clamp(Math.round(90 * areaK), 60, 220);
    const pebbles = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1.1, 0),
      new THREE.MeshStandardMaterial({ color: 0xa8a396, roughness: 0.92, flatShading: true }),
      pebbleN
    );
    for (let i = 0; i < pebbleN; i++) {
      p.set((rand() - 0.5) * (W - 18), 0.5, (rand() - 0.5) * (H - 18));
      q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      const k = 0.5 + rand() * 1.15;
      s.set(k, k * 0.45, k);
      m.compose(p, q, s);
      pebbles.setMatrixAt(i, m);
    }
    pebbles.instanceMatrix.needsUpdate = true;
    scene.add(pebbles);
  }

  /* ---------- 장애물 (바위 · 천막 · 수레) ---------- */
  const obstacleMat = {
    rock: new THREE.MeshStandardMaterial({ color: 0xa79d8c, roughness: 0.94, metalness: 0.04, flatShading: true }),
    rockDark: new THREE.MeshStandardMaterial({ color: 0x8b8272, roughness: 0.96, flatShading: true }),
    tent: new THREE.MeshStandardMaterial({ color: 0xefe0bb, roughness: 0.95, side: THREE.DoubleSide }),
    tentAlt: new THREE.MeshStandardMaterial({ color: 0xd8c49c, roughness: 0.95, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ color: 0xa87a4c, roughness: 0.88 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x6c7683, roughness: 0.5, metalness: 0.65 })
  };

  function shadowBlob(scale) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale), new THREE.MeshBasicMaterial({
      map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.55
    }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.12;
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
      tent.castShadow = true;
      g.add(tent);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.72, r * 0.9), new THREE.MeshBasicMaterial({
        color: 0x59452c, transparent: true, opacity: 0.9, side: THREE.DoubleSide
      }));
      door.position.set(0, r * 0.45, r * 0.92);
      door.rotation.x = -0.12;
      g.add(door);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, r * 2.4, 5), obstacleMat.wood);
      pole.position.y = r * 1.2;
      g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.2, 4, 1), new THREE.MeshStandardMaterial({
        color: o.team === 'enemy' ? enemyHex : meHex, roughness: 0.9, side: THREE.DoubleSide,
        emissive: o.team === 'enemy' ? enemyHex : meHex, emissiveIntensity: 0.14
      }));
      flag.position.set(1.6, r * 2.15, 0);
      g.add(flag);
      const flagBar = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.24, 0.24), obstacleMat.wood);
      flagBar.position.set(1.6, r * 2.3, 0);
      g.add(flagBar);
    } else if (o.kind === 'cart') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(r * 1.9, r * 0.75, r * 1.05), obstacleMat.wood);
      body.position.y = r * 0.75;
      body.castShadow = true;
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
      rock.castShadow = true;
      rock.receiveShadow = true;
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

  /* ---------- 진영 깃발 · 화톳불 ---------- */
  const banners = [];
  function addBanner(x, z, colorHex, flip) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.95, 44, 7), woodMat);
    pole.position.y = 22;
    pole.castShadow = true;
    g.add(pole);
    const clothGeo = new THREE.PlaneGeometry(26, 15, 12, 6);
    const cloth = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial({
      color: colorHex, roughness: 0.9, side: THREE.DoubleSide,
      emissive: colorHex, emissiveIntensity: 0.18
    }));
    cloth.position.set(flip ? -13.4 : 13.4, 35, 0);
    cloth.castShadow = true;
    g.add(cloth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(26, 1.2, 0.4), new THREE.MeshStandardMaterial({
      color: 0xefe0b0, roughness: 0.5, metalness: 0.55
    }));
    trim.position.copy(cloth.position);
    trim.position.y = 27.6;
    g.add(trim);
    const finial = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), new THREE.MeshStandardMaterial({
      color: 0xe8d59a, roughness: 0.35, metalness: 0.85
    }));
    finial.position.y = 45;
    g.add(finial);
    scene.add(g);
    const base = clothGeo.attributes.position.array.slice();
    banners.push({ cloth: clothGeo, base: base, dir: flip ? -1 : 1, phase: rand() * 6 });
  }
  addBanner(-W * 0.34, -H * 0.4, meHex, false);
  addBanner(W * 0.34, H * 0.4, enemyHex, true);

  function addBrazier(x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.7, 6, 8), obstacleMat.iron);
    stand.position.y = 3;
    stand.castShadow = true;
    g.add(stand);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.6, 8), new THREE.MeshBasicMaterial({
      color: 0xffa845, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    flame.position.y = 7.6;
    g.add(flame);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xffb060, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo.scale.set(7, 7, 1);
    halo.position.y = 8;
    g.add(halo);
    scene.add(g);
    return flame;
  }
  const flames = [addBrazier(-W * 0.34, -H * 0.4 + 12), addBrazier(W * 0.34, H * 0.4 - 12)];

  /* ===========================================================================
     병사 인스턴스 (InstancedMesh) — 지오메트리·재질 공유로 드로우콜 최소화
     =========================================================================== */
  const skinColor = new THREE.Color(0xd39b6c);
  const darkColor = new THREE.Color(0x2c323c);
  const whiteColor = new THREE.Color(0xffffff);
  const crowdMat = {
    armor: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0.42, envMapIntensity: 1.0 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.6, envMapIntensity: 1.25 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, envMapIntensity: 0.7 }),
    cape: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide, envMapIntensity: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0.96, emissive: 0x20304a, emissiveIntensity: 0.25, envMapIntensity: 1.7 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, envMapIntensity: 0.55 }),
    dark: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, envMapIntensity: 0.4 }),
    crest: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1, emissive: 0x2a3646, emissiveIntensity: 0.35, envMapIntensity: 0.8 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 1.0, envMapIntensity: 1.5 }),
    rune: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.2, emissive: 0xffb24a, emissiveIntensity: 0.9, envMapIntensity: 0.6 })
  };

  // 파트 정의 — rig: 어느 관절을 따라가는지, pos: 그 관절 기준 로컬 위치
  const PARTS = [
    { key: 'torso', geo: GEO.torso, mat: 'armor', rig: 'body', pos: [0, 15.2, 0] },
    { key: 'plate', geo: GEO.plate, mat: 'plate', rig: 'body', pos: [0, 16.1, 2.5] },
    { key: 'belt', geo: GEO.belt, mat: 'dark', rig: 'body', pos: [0, 10.4, 0] },
    { key: 'tabard', geo: GEO.tabard, mat: 'cloth', rig: 'body', pos: [0, 13.6, 2.55] },
    { key: 'cape', geo: GEO.cape, mat: 'cape', rig: 'body', pos: [0, 15.4, -2.5], rot: [0.12, 0, 0] },
    { key: 'shoulderL', geo: GEO.shoulder, mat: 'armor', rig: 'body', pos: [-4.3, 19.1, 0] },
    { key: 'shoulderR', geo: GEO.shoulder, mat: 'armor', rig: 'body', pos: [4.3, 19.1, 0] },
    { key: 'neck', geo: GEO.neck, mat: 'skin', rig: 'body', pos: [0, 20.5, 0] },
    { key: 'head', geo: GEO.head, mat: 'skin', rig: 'body', pos: [0, 23.2, 0] },
    { key: 'helmet', geo: GEO.helmet, mat: 'plate', rig: 'body', pos: [0, 23.55, 0] },
    { key: 'brim', geo: GEO.brim, mat: 'steel', rig: 'body', pos: [0, 23.1, 0] },
    { key: 'visor', geo: GEO.visor, mat: 'dark', rig: 'body', pos: [0, 22.7, 2.35] },
    { key: 'crest', geo: GEO.crest, mat: 'crest', rig: 'body', pos: [0, 26.1, -1.5], rot: [-0.16, 0, 0] },
    { key: 'plume', geo: GEO.plume, mat: 'crest', rig: 'body', pos: [0, 26.6, -0.4], rot: [-0.22, 0, 0] },
    { key: 'legL', geo: GEO.leg, mat: 'dark', rig: 'legL', pos: [0, -3.4, 0] },
    { key: 'shinL', geo: GEO.shin, mat: 'dark', rig: 'kneeL', pos: [0, -3.0, 0] },
    { key: 'greaveL', geo: GEO.greave, mat: 'plate', rig: 'kneeL', pos: [0, -3.2, 0.12] },
    { key: 'bootL', geo: GEO.boot, mat: 'dark', rig: 'kneeL', pos: [0, -6.2, 0.55] },
    { key: 'legR', geo: GEO.leg, mat: 'dark', rig: 'legR', pos: [0, -3.4, 0] },
    { key: 'shinR', geo: GEO.shin, mat: 'dark', rig: 'kneeR', pos: [0, -3.0, 0] },
    { key: 'greaveR', geo: GEO.greave, mat: 'plate', rig: 'kneeR', pos: [0, -3.2, 0.12] },
    { key: 'bootR', geo: GEO.boot, mat: 'dark', rig: 'kneeR', pos: [0, -6.2, 0.55] },
    { key: 'upArmL', geo: GEO.upperArm, mat: 'armor', rig: 'armL', pos: [0, -2.6, 0] },
    { key: 'foreArmL', geo: GEO.foreArm, mat: 'skin', rig: 'elbowL', pos: [0, -2.4, 0] },
    { key: 'handL', geo: GEO.hand, mat: 'dark', rig: 'elbowL', pos: [0, -5.0, 0] },
    { key: 'upArmR', geo: GEO.upperArm, mat: 'armor', rig: 'armR', pos: [0, -2.6, 0] },
    { key: 'foreArmR', geo: GEO.foreArm, mat: 'skin', rig: 'elbowR', pos: [0, -2.4, 0] },
    { key: 'handR', geo: GEO.hand, mat: 'dark', rig: 'elbowR', pos: [0, -5.0, 0] },
    { key: 'shield', geo: GEO.shield, mat: 'cloth', rig: 'elbowL', pos: [0, -3.2, 1.3], rot: [Math.PI / 2, 0, 0] },
    { key: 'grip', geo: GEO.grip, mat: 'dark', rig: 'wristR', pos: [0, 0, -1.1] },
    { key: 'guard', geo: GEO.guard, mat: 'steel', rig: 'wristR', pos: [0, 0, 0.6] },
    { key: 'blade', geo: GEO.blade, mat: 'steel', rig: 'wristR', pos: [0, 0, 5.9] },
    { key: 'shadow', geo: GEO.shadow, mat: 'shadow', rig: 'body', pos: [0, 0.14, 0], rot: [-Math.PI / 2, 0, 0] }
  ];
  const shadowMat = new THREE.MeshBasicMaterial({ map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.62 });

  /** 파트 정의 → InstancedMesh 한 벌 (병사·장군이 같은 공정을 쓴다) */
  function buildPartSet(defs, cap) {
    return defs.map((def) => {
      const mat = def.mat === 'shadow' ? shadowMat : crowdMat[def.mat];
      const mesh = new THREE.InstancedMesh(def.geo, mat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.part = def.key;
      if (def.mat !== 'shadow' && (def.key === 'torso' || def.key === 'head' || def.key === 'helmet' || def.key === 'legL' || def.key === 'legR')) {
        mesh.castShadow = true; mesh.receiveShadow = false; mesh.userData.shadowPart = true;
      }
      scene.add(mesh);
      const local = new THREE.Matrix4();
      const e = new THREE.Euler(def.rot ? def.rot[0] : 0, def.rot ? def.rot[1] : 0, def.rot ? def.rot[2] : 0, 'XYZ');
      const sc = def.scale ? new THREE.Vector3(def.scale[0], def.scale[1], def.scale[2]) : new THREE.Vector3(1, 1, 1);
      local.compose(new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]), new THREE.Quaternion().setFromEuler(e), sc);
      return { def: def, mesh: mesh, local: local };
    });
  }

  const parts = buildPartSet(PARTS, MAX_SOLDIERS);

  /* ===========================================================================
     큰 망치 중갑 장군 — 병사와 같은 관절 리그를 1.45배로 키우고, 뿔 투구·큰 견갑·
     금장 흉갑·망토·문양과 거대한 양손 워해머를 더한 40여 개 파트 (인스턴스 공유)
     =========================================================================== */
  const MAX_GENERALS = 48;
  const GENERAL_PARTS = [
    { key: 'gTorso', geo: GGEO.torso, mat: 'armor', rig: 'body', pos: [0, 15.2, 0] },
    { key: 'gChest', geo: GGEO.chest, mat: 'plate', rig: 'body', pos: [0, 16.4, 5.1] },
    { key: 'gBack', geo: GGEO.backPlate, mat: 'plate', rig: 'body', pos: [0, 16.2, -2.6] },
    { key: 'gGorget', geo: GGEO.gorget, mat: 'steel', rig: 'body', pos: [0, 19.8, 0] },
    { key: 'gBelt', geo: GGEO.belt, mat: 'dark', rig: 'body', pos: [0, 10.2, 0] },
    { key: 'gBuckle', geo: GGEO.buckle, mat: 'gold', rig: 'body', pos: [0, 10.2, 5.2] },
    { key: 'gTassetL', geo: GGEO.tasset, mat: 'plate', rig: 'body', pos: [-3.4, 8.6, 4.4], rot: [0.12, 0, 0.16] },
    { key: 'gTassetR', geo: GGEO.tasset, mat: 'plate', rig: 'body', pos: [3.4, 8.6, 4.4], rot: [0.12, 0, -0.16] },
    { key: 'gTabard', geo: GGEO.tabard, mat: 'cloth', rig: 'body', pos: [0, 13.3, 4.9] },
    { key: 'gEmblem', geo: GGEO.emblem, mat: 'gold', rig: 'body', pos: [0, 17.2, 6.1], rot: [Math.PI / 2, 0, 0] },
    { key: 'gEmblemBar', geo: GGEO.emblemBar, mat: 'gold', rig: 'body', pos: [0, 17.2, 6.4] },
    { key: 'gCape', geo: GGEO.cape, mat: 'cape', rig: 'body', pos: [0, 15.2, -2.8], rot: [0.16, 0, 0] },
    { key: 'gNeck', geo: GEO.neck, mat: 'skin', rig: 'body', pos: [0, 20.5, 0] },
    { key: 'gHead', geo: GEO.head, mat: 'skin', rig: 'body', pos: [0, 23.2, 0] },
    { key: 'gHelmet', geo: GGEO.helmet, mat: 'steel', rig: 'body', pos: [0, 23.4, 0], scale: [1.04, 1.0, 1.06] },
    { key: 'gBrim', geo: GEO.brim, mat: 'steel', rig: 'body', pos: [0, 22.9, 0], scale: [1.1, 1.0, 1.1] },
    { key: 'gVisor', geo: GEO.visor, mat: 'dark', rig: 'body', pos: [0, 22.8, 2.8], scale: [1.1, 1.1, 1.0] },
    { key: 'gCrest', geo: GGEO.crest, mat: 'steel', rig: 'body', pos: [0, 26.2, -0.9], rot: [-0.14, 0, 0] },
    { key: 'gPlume', geo: GEO.plume, mat: 'crest', rig: 'body', pos: [0, 26.6, -0.1], rot: [-0.24, 0, 0] },
    { key: 'gHornL', geo: GGEO.horn, mat: 'gold', rig: 'body', pos: [-2.6, 24.6, 0.3], rot: [0.22, 0, 1.0] },
    { key: 'gHornR', geo: GGEO.horn, mat: 'gold', rig: 'body', pos: [2.6, 24.6, 0.3], rot: [0.22, 0, -1.0] },
    { key: 'gPaulL', geo: GGEO.pauldron, mat: 'armor', rig: 'body', pos: [-4.95, 19.2, 0], scale: [1.12, 0.78, 1.12] },
    { key: 'gPaulR', geo: GGEO.pauldron, mat: 'armor', rig: 'body', pos: [4.95, 19.2, 0], scale: [1.12, 0.78, 1.12] },
    { key: 'gPaulRimL', geo: GGEO.pauldronRim, mat: 'gold', rig: 'body', pos: [-4.95, 17.9, 0] },
    { key: 'gPaulRimR', geo: GGEO.pauldronRim, mat: 'gold', rig: 'body', pos: [4.95, 17.9, 0] },
    { key: 'gSpikeL', geo: GGEO.pauldronSpike, mat: 'steel', rig: 'body', pos: [-6.5, 20.6, 0], rot: [0, 0, -0.62] },
    { key: 'gSpikeR', geo: GGEO.pauldronSpike, mat: 'steel', rig: 'body', pos: [6.5, 20.6, 0], rot: [0, 0, 0.62] },
    { key: 'gLegL', geo: GGEO.leg, mat: 'dark', rig: 'legL', pos: [0, -3.4, 0] },
    { key: 'gShinL', geo: GGEO.shin, mat: 'dark', rig: 'kneeL', pos: [0, -3.0, 0] },
    { key: 'gGreaveL', geo: GGEO.greave, mat: 'plate', rig: 'kneeL', pos: [0, -3.2, 0.16] },
    { key: 'gBootL', geo: GGEO.boot, mat: 'dark', rig: 'kneeL', pos: [0, -6.2, 0.6] },
    { key: 'gLegR', geo: GGEO.leg, mat: 'dark', rig: 'legR', pos: [0, -3.4, 0] },
    { key: 'gShinR', geo: GGEO.shin, mat: 'dark', rig: 'kneeR', pos: [0, -3.0, 0] },
    { key: 'gGreaveR', geo: GGEO.greave, mat: 'plate', rig: 'kneeR', pos: [0, -3.2, 0.16] },
    { key: 'gBootR', geo: GGEO.boot, mat: 'dark', rig: 'kneeR', pos: [0, -6.2, 0.6] },
    { key: 'gUpArmL', geo: GGEO.upperArm, mat: 'armor', rig: 'armL', pos: [0, -2.6, 0] },
    { key: 'gForeArmL', geo: GGEO.foreArm, mat: 'armor', rig: 'elbowL', pos: [0, -2.4, 0] },
    { key: 'gHandL', geo: GGEO.hand, mat: 'dark', rig: 'elbowL', pos: [0, -5.0, 0] },
    { key: 'gUpArmR', geo: GGEO.upperArm, mat: 'armor', rig: 'armR', pos: [0, -2.6, 0] },
    { key: 'gForeArmR', geo: GGEO.foreArm, mat: 'armor', rig: 'elbowR', pos: [0, -2.4, 0] },
    { key: 'gHandR', geo: GGEO.hand, mat: 'dark', rig: 'elbowR', pos: [0, -5.0, 0] },
    // 워해머 (rig 'hammer' — 손 앞에서 통째로 돈다. 자루는 +Z, 머리는 끝)
    { key: 'gHaft', geo: GGEO.haft, mat: 'dark', rig: 'hammer', pos: [0, 0, 3.6], rot: [Math.PI / 2, 0, 0] },
    { key: 'gWrapA', geo: GGEO.haftWrap, mat: 'cloth', rig: 'hammer', pos: [0, 0, -1.1], rot: [Math.PI / 2, 0, 0] },
    { key: 'gWrapB', geo: GGEO.haftWrap, mat: 'cloth', rig: 'hammer', pos: [0, 0, 0.6], rot: [Math.PI / 2, 0, 0] },
    { key: 'gCap', geo: GGEO.haftCap, mat: 'steel', rig: 'hammer', pos: [0, 0, -4.6] },
    { key: 'gRingA', geo: GGEO.haftWrap, mat: 'gold', rig: 'hammer', pos: [0, 0, 9.4], rot: [Math.PI / 2, 0, 0], scale: [1.12, 0.38, 1.12] },
    { key: 'gHeadCore', geo: GGEO.headCore, mat: 'steel', rig: 'hammer', pos: [0, 0, 13.6] },
    { key: 'gBandA', geo: GGEO.headBand, mat: 'gold', rig: 'hammer', pos: [0, 0, 11.4] },
    { key: 'gBandB', geo: GGEO.headBand, mat: 'gold', rig: 'hammer', pos: [0, 0, 15.8] },
    { key: 'gFaceF', geo: GGEO.headFace, mat: 'plate', rig: 'hammer', pos: [0, 0, 17.1] },
    { key: 'gFaceB', geo: GGEO.headFace, mat: 'plate', rig: 'hammer', pos: [0, 0, 10.1] },
    { key: 'gHeadSpike', geo: GGEO.headSpike, mat: 'steel', rig: 'hammer', pos: [0, 0, 18.9], rot: [Math.PI / 2, 0, 0] },
    { key: 'gRuneL', geo: GGEO.rune, mat: 'rune', rig: 'hammer', pos: [-2.55, 0, 13.6] },
    { key: 'gRuneR', geo: GGEO.rune, mat: 'rune', rig: 'hammer', pos: [2.55, 0, 13.6] },
    { key: 'gShadow', geo: GEO.shadow, mat: 'shadow', rig: 'body', pos: [0, 0.1, 0], rot: [-Math.PI / 2, 0, 0], scale: [1.5, 1.5, 1.5] }
  ];
  const genParts = buildPartSet(GENERAL_PARTS, MAX_GENERALS);

  function partColor(def, team, out) {
    if (def.mat === 'skin') return out.copy(skinColor);
    if (def.mat === 'dark') return out.copy(darkColor);
    if (def.mat === 'steel') return out.copy(team).lerp(whiteColor, 0.92);
    if (def.mat === 'armor') return out.copy(team).multiplyScalar(0.5).lerp(whiteColor, 0.06);
    if (def.mat === 'plate') return out.copy(team).multiplyScalar(0.72).lerp(whiteColor, 0.34);
    if (def.mat === 'cloth') return out.copy(team).lerp(whiteColor, 0.14);
    if (def.mat === 'cape') return out.copy(team).multiplyScalar(0.5);
    if (def.mat === 'crest') return out.copy(team).lerp(whiteColor, 0.56);
    if (def.mat === 'gold') return out.setRGB(0.86, 0.71, 0.36).lerp(team, 0.18);
    if (def.mat === 'rune') return out.setRGB(1.0, 0.76, 0.34);
    if (def.mat === 'shadow') return out.setRGB(1, 1, 1);
    return out.setRGB(1, 1, 1);
  }

  /* ---------- 적·아군 검기 / 공격 예고 인스턴스 ---------- */
  const arcGeo = new THREE.PlaneGeometry(1, 1);
  const arcMat = new THREE.MeshBasicMaterial({
    map: TEX.slash, transparent: true, opacity: 0.92, side: THREE.DoubleSide,
    blending: THREE.NormalBlending, depthWrite: false, depthTest: true
  });
  const arcMesh = new THREE.InstancedMesh(arcGeo, arcMat, MAX_ARCS);
  arcMesh.count = 0;
  arcMesh.frustumCulled = false;
  arcMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  arcMesh.renderOrder = 4;
  scene.add(arcMesh);

  /* ---------- 유닛 뷰 ---------- */
  const units = new Map();
  const tmpV = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const tmpColor2 = new THREE.Color();

  function addView(u, team) {
    const v = {
      unit: u, team: team,
      phase: rand() * 6.28, speed: 0, lx: u.x, ly: u.y,
      hurtPrev: -1, color: team === 'enemy' ? colors.enemy : colors.me,
      // 관절 상태 (부드럽게 따라가기 위한 현재값)
      legL: 0, legR: 0, kneeL: 0, kneeR: 0,
      armLx: -0.1, armLz: -0.12, elbowL: 0.35,
      armRx: 0.24, armRz: 0.16, elbowR: 0.5, wristR: 0,
      torsoYaw: 0, lean: 0, roll: 0, headYaw: 0,
      windK: 0, swingK: 0, atkK: 0,
      scale: 0.93 + rand() * 0.14
    };
    units.set(u, v);
    return v;
  }

  function updateUnitView(v, dt) {
    const u = v.unit;
    const moved = Math.hypot(u.x - v.lx, u.y - v.ly);
    v.lx = u.x; v.ly = u.y;
    const spd = dt > 0 ? moved / (dt / 1000) : 0;
    v.speed = lerp(v.speed, spd, 0.22);
    const run = clamp(v.speed / 105, 0, 1);
    // 보폭 주기 — 걸을 때는 느긋하게, 달릴 때는 빠르게 (발이 미끄러지지 않게 속도에 비례)
    v.phase += (dt / 1000) * (0.9 + run * 9.2);
    v.run = run;
  }

  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _rigLegL = new THREE.Matrix4();
  const _rigKneeL = new THREE.Matrix4();
  const _rigLegR = new THREE.Matrix4();
  const _rigKneeR = new THREE.Matrix4();
  const _rigArmL = new THREE.Matrix4();
  const _rigElbowL = new THREE.Matrix4();
  const _rigArmR = new THREE.Matrix4();
  const _rigElbowR = new THREE.Matrix4();
  const _rigWristR = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _quat2 = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _eul = new THREE.Euler();
  const _one = new THREE.Vector3(1, 1, 1);

  const _tr = new THREE.Matrix4();
  const _ro = new THREE.Matrix4();

  /** out = parent * T(tx,ty,tz) * R(rx,ry,rz) */
  function joint(out, parent, tx, ty, tz, rx, ry, rz) {
    out.copy(parent);
    _tr.makeTranslation(tx || 0, ty || 0, tz || 0);
    out.multiply(_tr);
    _eul.set(rx || 0, ry || 0, rz || 0, 'XYZ');
    _quat2.setFromEuler(_eul);
    _ro.makeRotationFromQuaternion(_quat2);
    out.multiply(_ro);
    return out;
  }

  let aliveCount = 0;
  let windCount = 0;
  let swingCount = 0;
  let arcCountNow = 0;
  let crowdShadowOff = false;

  /* ===========================================================================
     큰 망치 중갑 장군 — 1.45배 몸집 · 뿔 투구 · 큰 견갑 · 거대 양손 워해머
     병사와 같은 관절 리그를 쓰되, 망치는 손 앞(hammar rig)에서 통째로 돌아간다.
     =========================================================================== */
  const genViews = new Map();
  const GEN_WIND_MS = 620;          // arena.js GEN_WIND 와 같은 박자
  const GEN_SWING_MS = 300;         // arena.js GEN_SWING
  const _gBody = new THREE.Matrix4();
  const _gLegL = new THREE.Matrix4();
  const _gKneeL = new THREE.Matrix4();
  const _gLegR = new THREE.Matrix4();
  const _gKneeR = new THREE.Matrix4();
  const _gArmL = new THREE.Matrix4();
  const _gElbowL = new THREE.Matrix4();
  const _gArmR = new THREE.Matrix4();
  const _gElbowR = new THREE.Matrix4();
  const _gHammer = new THREE.Matrix4();
  let genAlive = 0, genAllyN = 0, genEnemyN = 0;

  function buildGenerals(S, dt, list, camX, camZ, arcStart) {
    let arcN = arcStart || 0;
    const live = new Set();
    for (const [u] of list) live.add(u);
    for (const u of [...genViews.keys()]) if (!live.has(u)) genViews.delete(u);

    const n = Math.min(list.length, MAX_GENERALS);
    genAlive = n;
    genAllyN = 0; genEnemyN = 0;
    for (let i = 0; i < n; i++) {
      const u = list[i][0];
      const team = list[i][1];
      if (team === 'ally') genAllyN++; else genEnemyN++;
      let v = genViews.get(u);
      if (!v) {
        v = { phase: rand() * 6.28, lx: u.x, ly: u.y, speed: 0, run: 0, hamK: -0.58, yawK: -1.0, leanK: 0, legL: 0, legR: 0, kneeL: 0, kneeR: 0 };
        genViews.set(u, v);
      }
      const moved = Math.hypot(u.x - v.lx, u.y - v.ly);
      v.lx = u.x; v.ly = u.y;
      const spd = dt > 0 ? moved / (dt / 1000) : 0;
      v.speed = lerp(v.speed, spd, 0.2);
      const run = clamp(v.speed / 70, 0, 1);
      v.run = run;
      v.phase += (dt / 1000) * (0.7 + run * 5.2);
      const ph = v.phase;
      const sL = Math.sin(ph), sR = Math.sin(ph + Math.PI);
      const walk = clamp(run * 1.7, 0, 1);
      const breath = Math.sin(S.time / 1100 + v.phase * 0.3);

      // ---- 망치 자세 : 오른어깨에 얹었다가 치켜들기(예고) → 내려찍기 ----
      let hamT = -0.58 + breath * 0.02, yawT = -1.0, leanT = walk * 0.1 + breath * 0.01;
      let armT = -0.86, elbowT = 0.95;
      let telegraph = 0;
      if (u.wind > 0) {
        telegraph = smoothstep(clamp(1 - u.wind / GEN_WIND_MS, 0, 1));
        hamT = lerp(-0.58, -1.55, telegraph);
        yawT = lerp(-1.0, 0.10, telegraph);
        leanT = lerp(leanT, -0.2, telegraph);
        armT = lerp(-0.86, -1.8, telegraph);
        elbowT = lerp(0.95, 0.5, telegraph);
      } else if (u.swing > 0) {
        const s = clamp(1 - u.swing / GEN_SWING_MS, 0, 1);
        const k = smoothstep(clamp((s - 0.08) / 0.5, 0, 1));
        hamT = lerp(-1.62, 1.0, k);
        yawT = lerp(0.42, -0.04, k);
        leanT = lerp(-0.2, 0.34, k);
        armT = lerp(-1.8, 0.05, k);
        elbowT = lerp(0.5, 1.15, k);
      }
      v.hamK = damp(v.hamK, hamT, dt, u.swing > 0 ? 26 : 55);
      v.yawK = damp(v.yawK, yawT, dt, 60);
      v.leanK = damp(v.leanK, leanT, dt, 70);
      const hamA = v.hamK, hamYaw = v.yawK;

      // ---- 다리 · 팔 관절 ----
      const ampG = 0.02 + walk * 0.5;
      const legLT = sL * ampG, legRT = sR * ampG;
      const kneeLT = Math.max(0, sL) * (0.05 + walk * 0.8) + 0.04;
      const kneeRT = Math.max(0, sR) * (0.05 + walk * 0.8) + 0.04;
      v.legL = damp(v.legL, legLT, dt, 60);
      v.legR = damp(v.legR, legRT, dt, 60);
      v.kneeL = damp(v.kneeL, kneeLT, dt, 65);
      v.kneeR = damp(v.kneeR, kneeRT, dt, 65);
      const armRx = damp(v.armRx == null ? -0.9 : v.armRx, armT + sL * walk * 0.08, dt, u.swing > 0 ? 32 : 60);
      const armLx = damp(v.armLx == null ? -0.9 : v.armLx, armT - sL * walk * 0.08, dt, u.swing > 0 ? 32 : 60);
      const elbowR = damp(v.elbowR == null ? 1.0 : v.elbowR, elbowT + Math.abs(sL) * walk * 0.2, dt, 55);
      const elbowL = damp(v.elbowL == null ? 1.0 : v.elbowL, elbowT + Math.abs(sR) * walk * 0.2, dt, 55);
      v.armRx = armRx; v.armLx = armLx; v.elbowR = elbowR; v.elbowL = elbowL;

      const bobY = Math.abs(Math.sin(ph)) * (0.14 + walk * 0.9) + breath * 0.08;
      const lfx = Math.cos(u.face || 0), lfz = Math.sin(u.face || 0);
      const lunge = u.swing > 0 ? smoothstep(clamp(1 - u.swing / GEN_SWING_MS, 0, 1)) * 2.2 : 0;
      _pos.set(u.x - W / 2 + lfx * lunge, bobY, u.y - H / 2 + lfz * lunge);
      _eul.set(v.leanK, Math.PI / 2 - (u.face || 0), Math.sin(ph) * (0.01 + walk * 0.02), 'YXZ');
      _quat.setFromEuler(_eul);
      const GS = 1.45;                 // 병사보다 1.45배 덩치
      _scl.set(GS, GS, GS);
      _gBody.compose(_pos, _quat, _scl);

      const rigs = {
        body: _gBody,
        legL: joint(_gLegL, _gBody, -2.05, 9.6, 0, v.legL, 0, -0.03),
        kneeL: joint(_gKneeL, _gLegL, 0, -6.9, 0, v.kneeL, 0, 0),
        legR: joint(_gLegR, _gBody, 2.05, 9.6, 0, v.legR, 0, 0.03),
        kneeR: joint(_gKneeR, _gLegR, 0, -6.9, 0, v.kneeR, 0, 0),
        armL: joint(_gArmL, _gBody, -4.75, 19.1, 0, v.armLx, 0, 0.62),
        elbowL: joint(_gElbowL, _gArmL, 0, -5.2, 0, v.elbowL, 0, 0),
        armR: joint(_gArmR, _gBody, 4.75, 19.1, 0, v.armRx, 0, -0.62),
        elbowR: joint(_gElbowR, _gArmR, 0, -5.2, 0, v.elbowR, 0, 0),
        hammer: joint(_gHammer, _gBody, 0, 17.4, 3.4, hamA, hamYaw, 0)
      };

      const hurt = u.hit > 0 ? clamp(u.hit / 150, 0, 1) * 0.75 : 0;
      const color = team === 'enemy' ? colors.enemy : colors.me;
      for (let p = 0; p < genParts.length; p++) {
        const P = genParts[p];
        const base = rigs[P.def.rig] || _gBody;
        _m2.copy(base).multiply(P.local);
        P.mesh.setMatrixAt(i, _m2);
        if (P.def.mat !== 'shadow') {
          partColor(P.def, color, tmpColor2);
          if (hurt > 0) tmpColor2.lerp(whiteColor, hurt);
          P.mesh.setColorAt(i, tmpColor2);
        }
      }

      // ---- 장군의 느린 치켜들기 예고 — 병사의 검기보다 크고 묵직하게 (보고 피할 수 있게) ----
      if (telegraph > 0.02 && arcN < MAX_ARCS) {
        const ux = u.x - W / 2, uz = u.y - H / 2;
        const faceCam = Math.atan2(camX - ux, camZ - uz);
        _m2.makeRotationY(faceCam);
        _m.makeRotationX(-0.1);
        _m2.multiply(_m);
        const w = 15 + telegraph * 7;
        const h = 10 + telegraph * 5;
        _m.makeScale(w, h, 1);
        _m2.multiply(_m);
        _m2.setPosition(ux, 44 + telegraph * 12, uz);
        arcMesh.setMatrixAt(arcN, _m2);
        const pulse = 0.6 + 0.4 * Math.sin(S.time / 54);
        if (team === 'enemy') tmpColor.setRGB(1.0, 0.22, 0.08);
        else tmpColor.setRGB(0.5, 0.82, 1.0);
        tmpColor.multiplyScalar(0.6 + telegraph * 0.5 + pulse * 0.12);
        arcMesh.setColorAt(arcN, tmpColor);
        arcN++;
      }
    }

    for (let p = 0; p < genParts.length; p++) {
      genParts[p].mesh.count = n;
      genParts[p].mesh.instanceMatrix.needsUpdate = true;
      if (genParts[p].mesh.instanceColor) genParts[p].mesh.instanceColor.needsUpdate = true;
    }
    return arcN;
  }

  function buildCrowd(S, dt) {
    const list = [];
    const gens = [];
    for (const a of S.allies) {
      if (a.dead) continue;
      if (a.kind === 'general') gens.push([a, 'ally']); else list.push([a, 'ally']);
    }
    for (const e of S.enemies) {
      if (e.dead) continue;
      if (e.kind === 'general') gens.push([e, 'enemy']); else list.push([e, 'enemy']);
    }

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
    const camX = camera.position.x, camZ = camera.position.z;

    for (let i = 0; i < n; i++) {
      const u = list[i][0];
      const team = list[i][1];
      let v = units.get(u);
      if (!v) v = addView(u, team);
      updateUnitView(v, dt);

      const run = v.run || 0;
      const ph = v.phase;
      const sL = Math.sin(ph), sR = Math.sin(ph + Math.PI);

      /* ---- 목표 자세 (관절이 부드럽게 따라간다) ---- */
      const walk = clamp(run * 1.8, 0, 1);            // 0 = 서 있음, 1 = 달리기
      const breath = Math.sin(S.time / 900 + v.phase * 0.37);
      const amp = 0.03 + walk * 0.62;
      let legLT = sL * amp;
      let legRT = sR * amp;
      let kneeLT = Math.max(0, sL) * (0.08 + walk * 0.95) + 0.05;
      let kneeRT = Math.max(0, sR) * (0.08 + walk * 0.95) + 0.05;
      let armLxT = sR * (0.10 + walk * 0.5) - 0.05;
      let armLzT = -0.1 - walk * 0.05;
      let elbowLT = 0.34 + walk * 0.45 + Math.max(0, -sR) * 0.28;
      let armRxT = 0.24 + sL * (0.06 + walk * 0.3);
      let armRzT = 0.16 + walk * 0.05;
      let elbowRT = 0.5 - walk * 0.1;
      let wristT = 0;
      let torsoYawT = Math.sin(ph) * (0.010 + walk * 0.05) + breath * 0.012;
      let leanT = walk * 0.17 + breath * 0.010;       // 달릴 때 앞으로 기운다
      let rollT = Math.sin(ph) * (0.008 + walk * 0.03);
      let headYawT = Math.sin(ph * 0.5 + v.phase) * 0.06 * (1 - walk * 0.7);
      let bobY = Math.abs(Math.sin(ph)) * (0.2 + walk * 1.35) + breath * 0.12;
      let lunge = 0;                                   // 베기 때 앞으로 파고드는 발

      // 공격 — 예비동작은 빠르게 들고 잠깐 멈추며, 내려치기는 가속 후 끝까지 지나간다
      let sw = 0;                                      // 음수 = 치켜듬, 양수 = 내려침
      if (u.wind > 0) {
        windCount++;
        const t = clamp((320 - u.wind) / 185, 0, 1);
        sw = -smoothstep(t);
        v.windK = damp(v.windK, 1, dt, 55);
        v.swingK = damp(v.swingK, 0, dt, 60);
      } else if (u.swing > 0) {
        swingCount++;
        const s = clamp(1 - u.swing / 180, 0, 1);
        sw = s < 0.62 ? easeInQuad(s / 0.62) : 1 + 0.10 * smoothstep((s - 0.62) / 0.38);
        v.windK = damp(v.windK, 0, dt, 45);
        v.swingK = damp(v.swingK, 1, dt, 45);
      }
      // 공격이 끝나면 여운을 두고 기본 자세로 돌아간다 (뚝 끊기지 않게)
      if (sw === 0) v.atkK = damp(v.atkK || 0, 0, dt, 190);
      else v.atkK = sw;
      const atk = v.atkK || 0;

      if (atk < 0) {
        // 예비동작 — 검을 머리 위로 치켜들며 상체를 비튼다
        const k = -atk;
        armRxT = lerp(armRxT, -2.30, k);
        armRzT = lerp(armRzT, 0.42, k);
        elbowRT = lerp(elbowRT, 0.90, k);
        wristT = lerp(wristT, -0.55, k);
        torsoYawT = lerp(torsoYawT, -0.34, k);
        leanT = lerp(leanT, -0.10, k);
        armLxT = lerp(armLxT, -0.78, k);
        elbowLT = lerp(elbowLT, 0.72, k);
        headYawT = lerp(headYawT, -0.12, k);
      } else if (atk > 0) {
        // 내려치기 — 칼이 앞아래까지 끝까지 지나가고 상체가 실린다
        const k = Math.min(1.1, atk);
        armRxT = lerp(-2.30, 0.86, k);
        armRzT = lerp(0.42, -0.26, k);
        elbowRT = lerp(0.90, 0.10, k);
        wristT = lerp(-0.55, 0.45, k);
        torsoYawT = lerp(-0.34, 0.38, k);
        leanT = lerp(-0.10, 0.26, k);
        armLxT = lerp(-0.78, 0.46, k);
        elbowLT = lerp(elbowLT, 0.50, k);
        headYawT = lerp(-0.12, 0.08, k);
        lunge = clamp(atk, 0, 1);
        kneeLT = lerp(kneeLT, 0.42, lunge * 0.6);
      }
      if (u.stun > 0) {
        // 맞으면 뒤로 젖혀진다
        leanT -= 0.28;
        torsoYawT += 0.1;
      }

      /* ---- 관절 추적 (프레임 독립 지수 감쇠) ---- */
      v.legL = damp(v.legL, legLT, dt, 55);
      v.legR = damp(v.legR, legRT, dt, 55);
      v.kneeL = damp(v.kneeL, kneeLT, dt, 60);
      v.kneeR = damp(v.kneeR, kneeRT, dt, 60);
      v.armLx = damp(v.armLx, armLxT, dt, 70);
      v.armLz = damp(v.armLz, armLzT, dt, 80);
      v.elbowL = damp(v.elbowL, elbowLT, dt, 80);
      v.armRx = damp(v.armRx, armRxT, dt, u.swing > 0 ? 34 : 60);
      v.armRz = damp(v.armRz, armRzT, dt, 60);
      v.elbowR = damp(v.elbowR, elbowRT, dt, u.swing > 0 ? 40 : 70);
      v.wristR = damp(v.wristR, wristT, dt, 60);
      v.torsoYaw = damp(v.torsoYaw, torsoYawT, dt, 80);
      v.lean = damp(v.lean, leanT, dt, 90);
      v.roll = damp(v.roll, rollT, dt, 90);
      v.headYaw = damp(v.headYaw, headYawT, dt, 120);

      /* ---- 월드 행렬 ---- */
      const lfx = Math.cos(u.face || 0), lfz = Math.sin(u.face || 0);
      _pos.set(u.x - W / 2 + lfx * lunge * 2.4, bobY, u.y - H / 2 + lfz * lunge * 2.4);
      _eul.set(v.lean, Math.PI / 2 - (u.face || 0), v.roll, 'YXZ');
      _quat.setFromEuler(_eul);
      const vs = v.scale || 1;
      _scl.set(vs, vs, vs);
      _m.compose(_pos, _quat, _scl);

      // 다리 (골반 → 무릎) · 팔 (어깨 → 팔꿈치 → 손목) 관절 행렬
      const rigs = {
        body: _m,
        legL: joint(_rigLegL, _m, -2.05, 9.6, 0, v.legL, 0, -0.03),
        kneeL: joint(_rigKneeL, _rigLegL, 0, -6.9, 0, v.kneeL, 0, 0),
        legR: joint(_rigLegR, _m, 2.05, 9.6, 0, v.legR, 0, 0.03),
        kneeR: joint(_rigKneeR, _rigLegR, 0, -6.9, 0, v.kneeR, 0, 0),
        armL: joint(_rigArmL, _m, -4.75, 19.1, 0, v.armLx, 0, v.armLz),
        elbowL: joint(_rigElbowL, _rigArmL, 0, -5.2, 0, v.elbowL, 0, 0),
        armR: joint(_rigArmR, _m, 4.75, 19.1, 0, v.armRx, 0, v.armRz),
        elbowR: joint(_rigElbowR, _rigArmR, 0, -5.2, 0, v.elbowR, 0, 0),
        wristR: joint(_rigWristR, _rigElbowR, 0, -5.3, 0, v.wristR, 0, 0)
      };

      /* ---- 피격 섬광 ---- */
      const hurt = u.hit > 0 ? clamp(u.hit / 140, 0, 1) * 0.8 : 0;
      v.hurtPrev = hurt;

      for (let p = 0; p < parts.length; p++) {
        const P = parts[p];
        const base = rigs[P.def.rig] || _m;
        _m2.copy(base).multiply(P.local);
        P.mesh.setMatrixAt(i, _m2);
        if (P.def.mat !== 'shadow') {
          partColor(P.def, v.color, tmpColor2);
          if (hurt > 0) tmpColor2.lerp(whiteColor, hurt);
          P.mesh.setColorAt(i, tmpColor2);
        }
      }

      /* ---- 적 검기 · 예고 (1인칭에서도 또렷하게) ---- */
      if (arcN < MAX_ARCS) {
        const fx = Math.cos(u.face || 0), fz = Math.sin(u.face || 0);
        const ux = u.x - W / 2, uz = u.y - H / 2;
        // 카메라를 바라보게 (1인칭에서 납작한 판이 사라지지 않도록)
        const faceCam = Math.atan2(camX - ux, camZ - uz);
        if (u.wind > 0) {
          const k = smoothstep(clamp(1 - u.wind / 320, 0, 1));
          // 1) 머리 위로 올라가는 붉은 검기 (예고)
          _m2.makeRotationY(faceCam);
          _m.makeRotationX(-0.16);
          _m2.multiply(_m);
          const w = 9 + k * 3.5;
          const h = 6 + k * 2.6;
          _m.makeScale(w, h, 1);
          _m2.multiply(_m);
          _m2.setPosition(ux + fx * 7, 30 + k * 8, uz + fz * 7);
          arcMesh.setMatrixAt(arcN, _m2);
          const pulse = 0.55 + 0.45 * Math.sin(S.time / 60);
          if (team === 'enemy') tmpColor.setRGB(0.98, 0.26, 0.1);
          else tmpColor.setRGB(0.42, 0.78, 1.0);
          tmpColor.multiplyScalar(0.78 + k * 0.35 + pulse * 0.1);
          arcMesh.setColorAt(arcN, tmpColor);
          arcN++;

          // 2) 검끝 발광 — 어디서 칼이 올라오는지 한눈에
          if (arcN < MAX_ARCS) {
            const tw = 3.4 + k * 2;
            _m2.makeRotationY(faceCam);
            _m.makeRotationX(-0.1);
            _m2.multiply(_m);
            _m.makeScale(tw, tw, 1);
            _m2.multiply(_m);
            _m2.setPosition(ux + fx * 4 + Math.cos(faceCam) * 6, 33 + k * 11, uz + fz * 4 + Math.sin(faceCam) * 6);
            arcMesh.setMatrixAt(arcN, _m2);
            if (team === 'enemy') tmpColor.setRGB(1.0, 0.55, 0.22);
            else tmpColor.setRGB(0.62, 0.9, 1.0);
            tmpColor.multiplyScalar(0.9 + pulse * 0.25);
            arcMesh.setColorAt(arcN, tmpColor);
            arcN++;
          }
        } else if (u.swing > 0) {
          // 내려치는 궤적 — 크고 밝게, 위에서 아래로 쓸어진다
          const s = 1 - clamp(u.swing / 180, 0, 1);
          _m2.makeRotationY(faceCam);
          _m.makeRotationZ(1.15 - s * 2.3);
          _m2.multiply(_m);
          const w2 = 11 + s * 5;
          const h2 = 7.5 + s * 3;
          _m.makeScale(w2, h2, 1);
          _m2.multiply(_m);
          _m2.setPosition(ux + fx * 6, 27 - s * 5, uz + fz * 6);
          arcMesh.setMatrixAt(arcN, _m2);
          if (team === 'enemy') tmpColor.setRGB(1.0, 0.32, 0.12);
          else tmpColor.setRGB(0.48, 0.84, 1.0);
          tmpColor.multiplyScalar(1 - s * 0.45);
          arcMesh.setColorAt(arcN, tmpColor);
          arcN++;
        }
      }
    }

    // 사람이 아주 많을 때는 병사 그림자를 끈다 (휴대폰 프레임 보호 · 발밑 그림자는 그대로)
    if (n > 70 !== crowdShadowOff) {
      crowdShadowOff = n > 70;
      for (let p = 0; p < parts.length; p++) {
        const P = parts[p];
        if (P.mesh.userData.shadowPart) P.mesh.castShadow = !crowdShadowOff;
      }
    }
    // ── 큰 망치 중갑 장군 (병사와 별도 인스턴스 묶음) ──
    arcN = buildGenerals(S, dt, gens, camX, camZ, arcN);
    for (let p = 0; p < parts.length; p++) {
      const P = parts[p];
      P.mesh.count = n;
      P.mesh.instanceMatrix.needsUpdate = true;
      if (P.mesh.instanceColor) P.mesh.instanceColor.needsUpdate = true;
    }
    arcMesh.count = arcN;
    arcCountNow = arcN;
    arcMesh.instanceMatrix.needsUpdate = true;
    if (arcMesh.instanceColor) arcMesh.instanceColor.needsUpdate = true;

    // 해 그림자 — 플레이어 주변만 촘촘하게 따라다닌다
    if (S.player) {
      sun.target.position.set(S.player.x - W / 2, 0, S.player.y - H / 2);
      sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 420);
      sun.target.updateMatrixWorld();
    }
  }

  /* --- 남은 효과들 --- */
  const slashViews = new Map();
  const trailViews = new Map();
  const cutViews = new Map();

  function syncSlashes(S) {
    const live = new Set(S.slashes);
    for (const [sl, v] of slashViews) {
      if (!live.has(sl)) {
        camera.remove(v.group);
        for (const m of v.mats) m.dispose();
        for (const g of v.geos) g.dispose();
        slashViews.delete(sl);
      }
    }
    for (const sl of S.slashes) {
      let v = slashViews.get(sl);
      if (!v) {
        const group = new THREE.Group();
        camera.add(group);
        const mats = [], geos = [];
        const mk = (w, h, map, color, z) => {
          const geo = new THREE.PlaneGeometry(w, h);
          const mat = new THREE.MeshBasicMaterial({
            map: map, color: color, transparent: true, opacity: 0, side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = z;
          group.add(mesh);
          mats.push(mat); geos.push(geo);
          return mesh;
        };
        // 겹으로 쌓아 '선명한 코어 → 시안 엣지 → 부드러운 빛무리' 그라데이션을 만든다
        v = {
          group: group, mats: mats, geos: geos,
          halo: mk(17.0, 7.4, TEX.slashGlow, 0x8fd4ff, -26.5),
          body: mk(13.4, 5.4, TEX.slash, 0xd8f2ff, -26.0),
          core: mk(12.8, 4.9, TEX.slashCore, 0xffffff, -25.8),
          echo1: mk(12.9, 5.2, TEX.slash, 0x9ddcff, -26.2),
          echo2: mk(12.2, 5.0, TEX.slash, 0x8ecdff, -26.3),
          wave: mk(10.5, 4.2, TEX.slash, 0xcdeeff, -27.2),
          shown: 0
        };
        slashViews.set(sl, v);
      }
      const p = clamp(sl.t / sl.dur, 0, 1);
      const e = 1 - Math.pow(1 - p, 1.9);
      // 가로 횡베기 — 오른쪽에서 왼쪽(또는 반대)으로 화면을 가로지르는 호
      const sgn = sl.sx >= 0 ? 1 : -1;
      // 세로로 그은 스와이프는 호가 기울어진다
      const tilt = clamp((sl.sy || 0) * 0.55, -0.4, 0.4);
      const rise = -1.02 + e * 0.26 + tilt * 0.32;
      const arc = (pp) => ({
        x: -sgn * (0.44 - 0.88 * (1 - Math.pow(1 - pp, 1.9))),
        rz: sgn * (0.36 - 0.72 * (1 - Math.pow(1 - pp, 1.9))) - tilt
      });
      const grow = 0.8 + p * 0.62;
      const here = arc(p);
      v.group.position.set(here.x, rise, 0);
      v.group.rotation.z = here.rz;
      v.group.scale.setScalar(grow);

      const fadeIn = Math.min(1, p / 0.1);
      v.body.material.opacity = 0.68 * Math.pow(1 - p, 1.15) * fadeIn;
      v.core.material.opacity = 0.95 * Math.pow(1 - p, 1.75) * fadeIn;
      v.halo.material.opacity = 0.42 * Math.pow(1 - p, 1.5) * fadeIn;

      // 잔상 트레일 — 칼이 지나간 자리에 호가 살짝 남는다
      const p1 = Math.max(0, p - 0.09), p2 = Math.max(0, p - 0.18);
      const a1 = arc(p1), a2 = arc(p2);
      v.echo1.position.set(a1.x - here.x, -0.03, 0);
      v.echo1.rotation.z = a1.rz - here.rz;
      v.echo1.material.opacity = 0.26 * Math.pow(1 - p1, 2) * fadeIn;
      v.echo2.position.set(a2.x - here.x, -0.06, 0);
      v.echo2.rotation.z = a2.rz - here.rz;
      v.echo2.material.opacity = 0.16 * Math.pow(1 - p2, 2) * fadeIn;

      // 검기 파동 — 칼이 적을 지나가는 순간 칼날 앞으로 날아가며 커지는 초승달
      const pw = clamp((p - 0.24) / 0.5, 0, 1);
      const wOn = p > 0.24 ? 1 : 0;
      v.wave.position.z = -26.7 - pw * 11;
      v.wave.scale.setScalar(0.46 + pw * 1.55);
      v.wave.material.opacity = wOn * 0.62 * Math.pow(1 - pw, 2.1);
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
          color: colors.me.clone().lerp(new THREE.Color(0xffffff), 0.4),
          transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        scene.add(mesh);
        v = { mesh: mesh };
        trailViews.set(tr, v);
      }
      const p = clamp(tr.t / tr.dur, 0, 1);
      v.mesh.position.set(tr.x - W / 2, 1.6 + p * 2, tr.y - H / 2);
      v.mesh.rotation.z = -tr.face;
      v.mesh.material.opacity = (1 - p) * 0.45;
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
        const geo = new THREE.PlaneGeometry(Math.max(18, c.len * 1.5), 0.7);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xfff6f2, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = 15;
        mesh.rotation.order = 'YXZ';
        mesh.rotation.y = -c.ang;
        mesh.rotation.x = -(c.tilt || 0);      // 절단면 기울기 그대로 — 가로 횡베기면 수평으로 누운 섬광
        mesh.rotation.z = 0.05;
        scene.add(mesh);
        v = { mesh: mesh };
        cutViews.set(c, v);
      }
      const p = clamp(c.t / c.dur, 0, 1);
      v.mesh.position.x = c.x - W / 2;
      v.mesh.position.z = c.y - H / 2;
      v.mesh.material.opacity = (1 - p) * 0.55;
      v.mesh.scale.set(0.75 + p * 0.35, 1 + p * 0.45, 1);
    }
  }

  /* --- 3D 두 동강 --- */
  const pieces = new Map();

  function buildPiece(c) {
    const cut = Number.isFinite(c.cut) ? c.cut : 0;
    const tilt = Number.isFinite(c.tilt) ? clamp(c.tilt, -1.5, 1.5) : 0;
    const side = c.side < 0 ? -1 : 1;
    const built = buildSoldier(teamHexOf(c), { player: false });
    const group = built.group;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const ch = group.children[i];
      if (ch.userData && ch.userData.shadow) {
        group.remove(ch);
        ch.geometry.dispose();
        ch.material.dispose();
      }
    }
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
      color: 0xdff3ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(15, 0.8), flashMat);
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

  function teamHexOf(c) {
    return c && c.team === 'ally' ? meHex : enemyHex;
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
      p.flashMat.opacity = flashP * 0.6;
      p.flash.visible = flashP > 0.01;
    }
  }

  /* --- 파티클 (불티 · 섬광) --- */
  const P_MAX = 420;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_MAX * 3);
  const pCol = new Float32Array(P_MAX * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 3.0, map: TEX.glow, transparent: true, vertexColors: true,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, opacity: 0.9
  });
  const pPoints = new THREE.Points(pGeo, pMat);
  pPoints.frustumCulled = false;
  scene.add(pPoints);
  const pState = new WeakMap();

  /* --- 공중 먼지 · 꽃가루 (아침 빛) --- */
  const DUST_N = 130;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST_N * 3);
  const dustSeed = [];
  for (let i = 0; i < DUST_N; i++) {
    dustSeed.push({
      x: (rand() - 0.5) * 540, y: 3 + rand() * 90, z: (rand() - 0.5) * 540,
      ph: rand() * 6.28, sp: 0.18 + rand() * 0.4
    });
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0xfff4d6, size: 1.4, map: TEX.glow, transparent: true, opacity: 0.34,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  scene.add(dustPoints);

  function updateDust(t, cx, cz) {
    for (let i = 0; i < DUST_N; i++) {
      const d = dustSeed[i];
      dustPos[i * 3] = cx + d.x + Math.sin(t * d.sp + d.ph) * 14;
      dustPos[i * 3 + 1] = d.y + Math.sin(t * 0.7 + d.ph) * 4.5 + ((t * (3 + d.sp * 4)) % 12);
      dustPos[i * 3 + 2] = cz + d.z + Math.cos(t * d.sp * 0.9 + d.ph) * 14;
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
        else tmpColor.setRGB(0.75, 0.88, 1.0);
      } catch (e) { tmpColor.setRGB(0.75, 0.88, 1.0); }
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
     바닥 충격파 링 · 망치가 꽂힌 자리의 균열 (장군 강타의 묵직함)
     =========================================================================== */
  const SHOCK_MAX = 16;
  const shockGeo = new THREE.RingGeometry(0.9, 1.0, 64);
  const shockPool = [];
  for (let si = 0; si < SHOCK_MAX; si++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe0a0, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    const m = new THREE.Mesh(shockGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.7;
    m.visible = false;
    m.renderOrder = 3;
    scene.add(m);
    shockPool.push({ mesh: m, mat });
  }

  const crackTex = canvasTex(256, 256, (x) => {
    x.clearRect(0, 0, 256, 256);
    x.translate(128, 128);
    x.lineCap = 'round';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + (i % 3) * 0.19;
      x.strokeStyle = i % 2 ? 'rgba(26,17,8,0.95)' : 'rgba(58,38,18,0.85)';
      x.lineWidth = 5.5 - (i % 3) * 1.4;
      x.beginPath();
      x.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
      for (let sgn = 1; sgn <= 4; sgn++) {
        const rr = sgn * 27 + (i % 2) * 7;
        const aa = a + Math.sin(i * 3.1 + sgn) * 0.15;
        x.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
      }
      x.stroke();
    }
    const g = x.createRadialGradient(0, 0, 2, 0, 0, 30);
    g.addColorStop(0, 'rgba(18,11,4,0.75)');
    g.addColorStop(1, 'rgba(18,11,4,0)');
    x.fillStyle = g;
    x.beginPath(); x.arc(0, 0, 30, 0, Math.PI * 2); x.fill();
  });
  const CRACK_MAX = 6;
  const crackGeo = new THREE.PlaneGeometry(1, 1);
  const crackPool = [];
  for (let ci = 0; ci < CRACK_MAX; ci++) {
    const mat = new THREE.MeshBasicMaterial({
      map: crackTex, transparent: true, opacity: 0, depthWrite: false, color: 0xffffff
    });
    const m = new THREE.Mesh(crackGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.55;
    m.visible = false;
    scene.add(m);
    crackPool.push({ mesh: m, mat });
  }

  function syncShocks(S) {
    const shocks = S.shocks || [];
    for (let i = 0; i < shockPool.length; i++) {
      const p = shockPool[i];
      const s = shocks[i];
      if (!s) { p.mesh.visible = false; continue; }
      const k = clamp(s.t / s.dur, 0, 1);
      const r = Math.max(2, s.r * (0.16 + k * 0.95));
      p.mesh.visible = true;
      p.mesh.scale.set(r, r, 1);
      p.mesh.position.set(s.x - W / 2, 0.7, s.y - H / 2);
      p.mat.color.setHex(s.team === 'enemy' ? 0xff6b52 : 0xffe2a6);
      p.mat.opacity = (1 - k) * 0.9;
    }
    const cracks = S.cracks || [];
    for (let i = 0; i < crackPool.length; i++) {
      const p = crackPool[i];
      const c = cracks[i];
      if (!c) { p.mesh.visible = false; continue; }
      const k = clamp(c.t / c.dur, 0, 1);
      const size = c.len * 1.55;
      p.mesh.visible = true;
      p.mesh.scale.set(size, size, 1);
      p.mesh.position.set(c.x - W / 2, 0.55, c.y - H / 2);
      p.mesh.rotation.z = -c.rot;
      p.mat.opacity = (1 - k) * 0.62;
    }
  }

  /* ===========================================================================
     1인칭 카메라 (수동 회전 전용 · 아주 미세한 무게감)
     =========================================================================== */
  let camYaw = (cfg.playerFace != null ? cfg.playerFace : Math.PI / 2);
  let camPitch = 0;
  const lookNow = new THREE.Vector3();
  let bobT = 0;
  let plSpeed = 0;
  let plLX = 0, plLY = 0, plInit = false;
  let camRoll = 0;
  let camKickZX = 0, camKickZY = 0;
  let prevAtkForCam = 0;

  let viewK = 0;                 // 0 = 1인칭 참전 · 1 = 🎬 관전
  let viewMode = 'first-person';
  const fpPos = new THREE.Vector3();
  const fpLook = new THREE.Vector3();
  const spPos = new THREE.Vector3(0, 150, 0);
  const spLook = new THREE.Vector3(0, 0, 0);
  let spReady = false;

  function updateCamera(S, dt) {
    const pl = S.player;
    if (!pl) return;
    if (api.debugCamera) {
      camera.position.set(api.debugCamera.x, api.debugCamera.y, api.debugCamera.z);
      camera.lookAt(api.debugCamera.tx, api.debugCamera.ty, api.debugCamera.tz);
      viewK = 1;                       // 자유 카메라에서는 1인칭 손·검을 그리지 않는다
      viewMode = 'spectate';
      return;
    }
    camYaw = pl.face;
    camPitch = clamp(pl.pitch || 0, -1.15, 0.95);

    if (!plInit) { plLX = pl.x; plLY = pl.y; plInit = true; }
    const dist = Math.hypot(pl.x - plLX, pl.y - plLY);
    plLX = pl.x; plLY = pl.y;
    const spd = dt > 0 ? dist / (dt / 1000) : 0;
    plSpeed = lerp(plSpeed, spd, 0.2);
    const run = clamp(plSpeed / 120, 0, 1);
    bobT += (dt / 1000) * (2.0 + run * 8.6);
    // 걸음 — 위아래 + 좌우로 살짝 흔들린다 (사람이 걷는 무게감)
    const bob = Math.sin(bobT) * (0.1 + run * 0.5);
    const sway = Math.sin(bobT * 0.5) * (0.05 + run * 0.28);

    const px = pl.x - W / 2, pz = pl.y - H / 2;
    const isGen = pl.kind === 'general';
    const eyeH = isGen ? EYE * 1.45 : EYE;       // 중갑 장군은 눈높이도 높다

    // 베기 반동 — 팔과 몸이 함께 실린다 (장군은 망치 강타의 묵직한 반동)
    const ap = pl.atkAnim > 0 ? 1 - clamp(pl.atkAnim / (isGen ? 620 : ATK_DUR), 0, 1) : 0;
    const strike = !isGen && ap > 0.16 && ap < 0.66 ? Math.sin(((ap - 0.16) / 0.5) * Math.PI) : 0;
    // 망치가 바닥에 꽂히는 순간(궤적 55%)에 화면이 쾅 내려앉는다
    const slamK = isGen && ap > 0.38 && ap < 0.72 ? Math.sin(((ap - 0.38) / 0.34) * Math.PI) : 0;
    const sw = pl.swipe || { sx: -1, sy: 0.16 };
    const brace = vmGuard * 0.5;
    const breath = Math.sin(timeSec * 1.25) * 0.03;

    // 반동·막기 충격은 지수 감쇠로 부드럽게
    camKickZX = damp(camKickZX, strike * 0.55 * clamp(sw.sx, -1, 1), dt, 90);
    camKickZY = damp(camKickZY, -strike * 0.2 - brace * 0.12 - slamK * 0.9, dt, slamK > 0.05 ? 34 : 120);

    // ---- 1인칭 자리 (병사 눈높이) ----
    fpPos.set(
      px + Math.cos(camYaw) * camKickZX * 0.22 - Math.sin(camYaw) * sway * 0.1,
      eyeH + bob + camKickZY + breath,
      pz + Math.sin(camYaw) * camKickZX * 0.22 + Math.cos(camYaw) * sway * 0.1
    );
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    const fx = Math.cos(camYaw), fz = Math.sin(camYaw);
    // 휘두르는 방향으로 시선이 아주 살짝 따라간다
    const lookSide = strike * 0.9 * clamp(sw.sx, -1, 1);
    fpLook.set(
      px + fx * cp * 120 - fz * lookSide,
      eyeH + bob + sp * 120 + camKickZY * 1.4 + breath,
      pz + fz * cp * 120 + fx * lookSide
    );

    // ---- 🎬 관전 자리 (전장 위 자유 시점) ----
    const spec = (S.view === 'spectate' && S.spectate) ? S.spectate : null;
    if (spec) {
      const sscp = Math.cos(spec.pitch), sssp = Math.sin(spec.pitch);
      spPos.set(spec.x - W / 2, spec.h, spec.y - H / 2);
      spLook.set(
        spPos.x + Math.cos(spec.yaw) * sscp * 160,
        spPos.y + sssp * 160,
        spPos.z + Math.sin(spec.yaw) * sscp * 160
      );
      spReady = true;
    }
    viewK = damp(viewK, spec ? 1 : 0, dt, 165);
    if (viewK < 0.0015) viewK = 0;
    if (viewK > 0.9985) viewK = 1;
    viewMode = viewK > 0.5 ? 'spectate' : 'first-person';
    api.viewpoint = viewMode === 'spectate' ? 'spectate' : 'first-person';
    const ke = spReady ? smoothstep(clamp(viewK, 0, 1)) : 0;

    camera.position.copy(fpPos);
    if (ke > 0) camera.position.lerp(spPos, ke);
    lookNow.copy(fpLook);
    if (ke > 0) lookNow.lerp(spLook, ke);

    // 머리를 기울이는 롤 (휘두를 때 · 옆으로 걸을 때) — 관전으로 갈수록 곧게
    camRoll = damp(camRoll, strike * 0.05 * clamp(sw.sx, -1, 1) + sway * 0.004, dt, 110);
    const rollNow = camRoll * (1 - ke);
    camera.up.set(Math.sin(rollNow), Math.cos(rollNow), 0);
    camera.lookAt(lookNow);

    const sh = (S.shake || 0) * 0.2 * (1 - ke * 0.5);
    if (sh > 0.05) {
      camera.position.x += (Math.random() - 0.5) * sh;
      camera.position.y += (Math.random() - 0.5) * sh;
      camera.lookAt(lookNow);
    }
    prevAtkForCam = ap;
  }

  /* ===========================================================================
     1인칭 뷰모델 — 어깨(shoulder) → 팔꿈치(elbow) → 손목(wrist) → 검
     자세는 쿼터니언으로 slerp 해서 짐벌락·각도 튐 없이 자연스럽게 잇는다.
     =========================================================================== */
  const vmScene = new THREE.Scene();
  if (envTexture) {
    vmScene.environment = envTexture;
    vmScene.environmentIntensity = 0.95;
  }
  const vmCam = new THREE.PerspectiveCamera(58, 0.46, 0.05, 40);
  if (typeof window !== 'undefined') window.__vmCam = vmCam;
  vmScene.add(new THREE.HemisphereLight(0xdcefff, 0x8a7a58, 2.3));
  const vmKey = new THREE.DirectionalLight(0xfff0d0, 2.7);
  vmKey.position.set(-1.6, 2.4, 2.2);
  vmScene.add(vmKey);
  const vmRim = new THREE.DirectionalLight(0x9dc9ff, 1.35);
  vmRim.position.set(2.4, 0.8, -1.8);
  vmScene.add(vmRim);
  const vmBounce = new THREE.DirectionalLight(0xffe0b0, 0.55);
  vmBounce.position.set(0.4, -1.8, 1.2);
  vmScene.add(vmBounce);

  const vm = new THREE.Group();
  vmScene.add(vm);

  const vmMats = {
    steel: new THREE.MeshStandardMaterial({ color: 0xdde8f4, roughness: 0.1, metalness: 1.0, emissive: 0x16202e, emissiveIntensity: 0.3, envMapIntensity: 1.9 }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0xb9c6d6, roughness: 0.26, metalness: 0.82, envMapIntensity: 1.4 }),
    fuller: new THREE.MeshStandardMaterial({ color: 0x8fa0b4, roughness: 0.34, metalness: 0.9, envMapIntensity: 1.1 }),
    edge: new THREE.MeshStandardMaterial({ color: 0xf6fbff, roughness: 0.05, metalness: 1.0, emissive: 0x9dbcd6, emissiveIntensity: 0.35, envMapIntensity: 2.1 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe8cf8f, roughness: 0.24, metalness: 1.0, envMapIntensity: 1.7 }),
    goldDark: new THREE.MeshStandardMaterial({ color: 0xc0a463, roughness: 0.34, metalness: 0.95, envMapIntensity: 1.4 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x4a2f22, roughness: 0.85 }),
    leatherDark: new THREE.MeshStandardMaterial({ color: 0x33211a, roughness: 0.9 }),
    sleeve: new THREE.MeshStandardMaterial({ color: colors.me.clone().multiplyScalar(0.46), roughness: 0.92 }),
    sleeveLight: new THREE.MeshStandardMaterial({ color: 0x533726, roughness: 0.94 }),
    mail: new THREE.MeshStandardMaterial({ color: 0x8e99a8, roughness: 0.44, metalness: 0.8, envMapIntensity: 1.2 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x58412f, roughness: 0.86 })
  };

  /* --- 계층: armRoot → shoulderPivot → (upperArm) → elbowPivot → (foreArm) → wristPivot → sword ---
     자세는 '손목 위치 + 칼날 방향'으로 저작하고, 2뼈 IK 로 어깨·팔꿈치·손목을 역산한다.
     쿼터니언 기반이라 짐벌락·축 뒤집힘 없이 자세 사이가 매끄럽게 이어진다. */
  const ARM = { root: new THREE.Vector3(1.25, -1.95, -2.85), l1: 1.0, l2: 0.86, blade: 2.2 };

  const armRoot = new THREE.Group();
  armRoot.position.copy(ARM.root);
  vm.add(armRoot);

  const shoulderPivot = new THREE.Group();
  armRoot.add(shoulderPivot);

  const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, ARM.l1 - 0.36, 6, 10), vmMats.sleeve);
  upperArm.position.y = -ARM.l1 * 0.5;
  shoulderPivot.add(upperArm);
  const shoulderPad = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 9), vmMats.sleeveLight);
  shoulderPad.position.set(0.01, 0.02, 0);
  shoulderPad.scale.set(1.06, 0.92, 1.06);
  shoulderPivot.add(shoulderPad);
  const upperMail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.19, 0.26, 10), vmMats.mail);
  upperMail.position.y = -ARM.l1 + 0.16;
  shoulderPivot.add(upperMail);

  const elbowPivot = new THREE.Group();
  elbowPivot.position.y = -ARM.l1;
  shoulderPivot.add(elbowPivot);

  const foreArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, ARM.l2 - 0.34, 6, 10), vmMats.sleeveLight);
  foreArm.position.y = -ARM.l2 * 0.5;
  elbowPivot.add(foreArm);
  const bracer = new THREE.Mesh(new THREE.CylinderGeometry(0.182, 0.166, 0.36, 10), vmMats.mail);
  bracer.position.y = -ARM.l2 * 0.62;
  elbowPivot.add(bracer);
  const bracerRim = new THREE.Mesh(new THREE.TorusGeometry(0.175, 0.022, 6, 14), vmMats.goldDark);
  bracerRim.rotation.x = Math.PI / 2;
  bracerRim.position.y = -ARM.l2 * 0.62 - 0.17;
  elbowPivot.add(bracerRim);

  const wristPivot = new THREE.Group();
  wristPivot.position.y = -ARM.l2;
  elbowPivot.add(wristPivot);

  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.25, 0.26), vmMats.glove);
  hand.position.y = -0.03;
  wristPivot.add(hand);
  for (let i = 0; i < 3; i++) {
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.14, 0.072), vmMats.glove);
    finger.position.set(-0.07 + i * 0.068, -0.13, 0.09);
    finger.rotation.x = 0.55;
    wristPivot.add(finger);
  }
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.12, 0.068), vmMats.glove);
  thumb.position.set(-0.115, -0.05, 0.055);
  thumb.rotation.z = 0.7;
  wristPivot.add(thumb);

  /* --- 검: 광택 나는 강철 날 + 홈(fuller) + 날 끝, 놋쇠 십자코등, 가죽 손잡이, 폼멜 --- */
  const sword = new THREE.Group();
  sword.position.set(0, -0.05, 0.02);
  sword.rotation.set(-0.34, 0.1, 0.78);      // 손에 쥔 각도 — 칼날이 팔 축과 겹치지 않는다
  wristPivot.add(sword);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.068, 0.36, 10), vmMats.leather);
  grip.position.y = -0.16;
  sword.add(grip);
  for (let i = 0; i < 6; i++) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.008, 4, 12), vmMats.leatherDark);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = -0.02 - i * 0.058;
    sword.add(wrap);
  }
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.078, 12, 9), vmMats.gold);
  pommel.position.y = -0.37;
  pommel.scale.set(1, 0.84, 1);
  sword.add(pommel);
  const pommelRing = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 12), vmMats.goldDark);
  pommelRing.position.y = -0.4;
  pommelRing.rotation.x = Math.PI / 2;
  sword.add(pommelRing);
  const ricasso = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.14, 0.05), vmMats.steelDark);
  ricasso.position.y = 0.06;
  sword.add(ricasso);
  const crossGuard = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.11), vmMats.gold);
  crossGuard.position.y = 0.14;
  sword.add(crossGuard);
  const guardBallL = new THREE.Mesh(new THREE.SphereGeometry(0.042, 8, 6), vmMats.gold);
  guardBallL.position.set(-0.32, 0.15, 0);
  sword.add(guardBallL);
  const guardBallR = guardBallL.clone();
  guardBallR.position.x = 0.32;
  sword.add(guardBallR);
  const quillonL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.07), vmMats.goldDark);
  quillonL.position.set(-0.24, 0.115, 0);
  quillonL.rotation.z = 0.3;
  sword.add(quillonL);
  const quillonR = quillonL.clone();
  quillonR.position.x = 0.24;
  quillonR.rotation.z = -0.3;
  sword.add(quillonR);

  // 날 — 밑동 → 끝으로 좁아지고 두께도 줄어든다
  const BLADE_LEN = 1.78;
  const bladeGeo = new THREE.BoxGeometry(0.19, BLADE_LEN, 0.045, 1, 6, 1);
  {
    const pos = bladeGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = (y + BLADE_LEN / 2) / BLADE_LEN;
      pos.setX(i, pos.getX(i) * (1 - 0.36 * t));
      pos.setZ(i, pos.getZ(i) * (1 - 0.26 * t));
    }
    pos.needsUpdate = true;
    bladeGeo.computeVertexNormals();
  }
  const blade = new THREE.Mesh(bladeGeo, vmMats.steel);
  blade.position.y = 0.2 + BLADE_LEN / 2;
  sword.add(blade);
  for (const sgn of [1, -1]) {
    const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.06, BLADE_LEN * 0.78, 0.052), vmMats.fuller);
    fuller.position.set(0, 0.2 + BLADE_LEN * 0.45, sgn * 0.002);
    sword.add(fuller);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.02, BLADE_LEN * 0.94, 0.032), vmMats.edge);
    edge.position.set(sgn * 0.082, 0.2 + BLADE_LEN * 0.47, 0);
    sword.add(edge);
  }
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.056, 0.3, 4), vmMats.steel);
  tip.position.y = 0.2 + BLADE_LEN + 0.13;
  tip.rotation.y = Math.PI / 4;
  sword.add(tip);
  const tipEdge = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.24, 4), vmMats.edge);
  tipEdge.position.y = 0.2 + BLADE_LEN + 0.15;
  tipEdge.rotation.y = Math.PI / 4;
  tipEdge.scale.set(0.9, 1, 0.5);
  sword.add(tipEdge);

  const tipMarker = new THREE.Object3D();
  tipMarker.position.y = 0.2 + BLADE_LEN + 0.28;
  sword.add(tipMarker);

  /* --- 막기 충돌 섬광 --- */
  const guardSpark = new THREE.Sprite(new THREE.SpriteMaterial({
    map: TEX.glow, color: 0xe4f4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false
  }));
  guardSpark.scale.set(0.9, 0.9, 1);
  sword.add(guardSpark);

  /* ===========================================================================
     1인칭 검 자세 — 가로 횡베기 아크 (오른쪽 → 왼쪽 / 왼쪽 → 오른쪽)
     자세는 '손목 위치(w) + 칼날 방향(b) + 칼날 면 법선(n)'으로 저작하고,
     키 사이는 C1 연속 에르미트 곡선으로 이어 검끝이 부드러운 호를 그린다.
     =========================================================================== */
  const VM_SWING_KEYS = {
    // 오른쪽 → 왼쪽 횡베기 (1타·3타) — 깊게 감아 올린 뒤 가로로 찢고 낮게 빠진다
    left: [
      { p: 0.00, w: [0.70, -1.05, -2.65], b: [-0.45, 0.89, 0.05], n: [0, 0, 1] },       // 기본 자세
      { p: 0.10, w: [0.92, -0.86, -2.50], b: [0.12, 0.84, -0.36], n: [0, 0.15, 0.99] },  // 힘을 모은다 (몸을 오른쪽으로 감는다)
      { p: 0.20, w: [1.12, -0.68, -2.36], b: [0.54, 0.72, -0.44], n: [0, 0.26, 0.97] },  // 예비동작 꼭대기 (오른쪽 위로 치켜듦)
      { p: 0.30, w: [0.96, -0.80, -2.60], b: [-0.05, 0.74, -0.66], n: [0.05, 0.22, 0.97] }, // 손목이 돌기 시작 (가속)
      { p: 0.42, w: [0.52, -0.93, -2.92], b: [-0.74, 0.48, -0.46], n: [0, 0.35, 0.94] },  // 적을 가로지른다
      { p: 0.50, w: [0.30, -0.98, -2.98], b: [-0.95, 0.20, -0.24], n: [0, 0.45, 0.89] },  // 팔로우스루 (왼쪽으로 빠진다)
      { p: 0.62, w: [0.14, -1.06, -2.80], b: [-0.90, -0.12, -0.42], n: [0, 0.55, 0.84] }, // 칼끝이 낮게 떨어지며 빠진다
      { p: 0.74, w: [0.24, -1.18, -2.58], b: [-0.68, -0.36, -0.62], n: [0.05, 0.40, 0.90] },// 왼쪽 아래 끝
      { p: 0.88, w: [0.64, -1.10, -2.60], b: [-0.52, 0.28, -0.78], n: [0, 0.15, 0.99] },  // 회수 (몸 앞으로 당긴다)
      { p: 1.00, w: [0.70, -1.05, -2.65], b: [-0.45, 0.89, 0.05], n: [0, 0, 1] }        // 기본 자세
    ],
    // 왼쪽 → 오른쪽 횡베기 (2타) — 반대쪽으로 감아 올려 반대로 찢는다
    right: [
      { p: 0.00, w: [0.70, -1.05, -2.65], b: [-0.45, 0.89, 0.05], n: [0, 0, 1] },
      { p: 0.10, w: [0.40, -1.02, -2.62], b: [-0.80, -0.10, -0.44], n: [0, 0.30, 0.92] },  // 왼쪽으로 감아 쥔다
      { p: 0.20, w: [0.22, -1.12, -2.46], b: [-0.92, -0.30, -0.28], n: [0, 0.35, 0.90] },  // 낮게 감긴 예비동작
      { p: 0.30, w: [0.34, -0.95, -2.84], b: [-0.28, 0.58, -0.70], n: [0, 0.14, 0.99] },  // 훑고 올라온다
      { p: 0.42, w: [0.58, -0.92, -2.98], b: [0.62, 0.46, -0.50], n: [0, 0.30, 0.95] },   // 적을 가로지른다 (오른쪽)
      { p: 0.50, w: [0.80, -0.96, -2.98], b: [0.93, 0.18, -0.26], n: [0, 0.42, 0.90] },
      { p: 0.62, w: [1.04, -1.04, -2.80], b: [0.90, -0.12, -0.42], n: [0, 0.52, 0.85] },
      { p: 0.74, w: [1.14, -1.14, -2.60], b: [0.68, -0.36, -0.60], n: [0.05, 0.40, 0.90] }, // 오른쪽 아래 끝
      { p: 0.88, w: [0.82, -1.10, -2.60], b: [-0.10, 0.52, -0.80], n: [0, 0.15, 0.99] },   // 회수
      { p: 1.00, w: [0.70, -1.05, -2.65], b: [-0.45, 0.89, 0.05], n: [0, 0, 1] }
    ]
  };
  const GUARD_POSE = { w: [0.34, -0.96, -2.86], b: [-0.20, 0.94, 0.16], n: [0, 0, 1] };

  /* ===========================================================================
     🔨 큰 망치 장군의 1인칭 워해머 — 두 손으로 자루를 쥐고, 치켜들었다가
     바닥으로 내려찍는다. 자루·가죽 감김·금장 띠·강철 쌍날 머리·룬 발광.
     (자세는 '자루 방향 + 손 위치'로 저작해 쿼터니언으로 이어 붙인다)
     =========================================================================== */
  const genVm = new THREE.Group();
  genVm.visible = false;
  vm.add(genVm);

  const vmHammerMats = {
    haft: new THREE.MeshStandardMaterial({ color: 0x4b3324, roughness: 0.82, metalness: 0.08 }),
    wrap: new THREE.MeshStandardMaterial({ color: 0x2c1c13, roughness: 0.94 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xccd7e4, roughness: 0.22, metalness: 0.96, envMapIntensity: 1.7 }),
    face: new THREE.MeshStandardMaterial({ color: 0xe6eef8, roughness: 0.14, metalness: 1.0, envMapIntensity: 2.0 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe8c877, roughness: 0.24, metalness: 1.0, envMapIntensity: 1.6 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x54382a, roughness: 0.88 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x9aa8ba, roughness: 0.34, metalness: 0.86, envMapIntensity: 1.3 }),
    rune: new THREE.MeshStandardMaterial({ color: 0xffc766, emissive: 0xff9a1e, emissiveIntensity: 1.5, roughness: 0.4, metalness: 0.3 })
  };

  const ham = new THREE.Group();
  genVm.add(ham);

  // 자루 (아래 끝 → 머리)
  const haftMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 1.24, 10), vmHammerMats.haft);
  haftMesh.position.y = 0.44;
  ham.add(haftMesh);
  const buttCap = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), vmHammerMats.gold);
  buttCap.position.y = -0.18;
  ham.add(buttCap);
  for (let i = 0; i < 6; i++) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.006, 5, 12), vmHammerMats.wrap);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = -0.06 + i * 0.052;
    ham.add(wrap);
  }
  // 자루 금장 띠 · 날개
  for (const gy of [0.74, 0.86]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.009, 5, 14), vmHammerMats.gold);
    band.rotation.x = Math.PI / 2;
    band.position.y = gy;
    ham.add(band);
  }
  const langetF = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.22, 0.012), vmHammerMats.plate);
  langetF.position.set(0, 0.94, 0.03);
  ham.add(langetF);
  const langetB = langetF.clone();
  langetB.position.z = -0.03;
  ham.add(langetB);

  // 망치 머리 — 강철 몸통 + 양쪽 타격면 + 금장 고정 띠 + 룬 홈
  const headCore = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.24, 0.22), vmHammerMats.steel);
  headCore.position.y = 1.06;
  ham.add(headCore);
  for (const sx of [1, -1]) {
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.265, 0.245), vmHammerMats.face);
    face.position.set(sx * 0.235, 1.06, 0);
    ham.add(face);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.28, 0.26), vmHammerMats.gold);
    rim.position.set(sx * 0.19, 1.06, 0);
    ham.add(rim);
  }
  const headCollar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.27, 0.25), vmHammerMats.gold);
  headCollar.position.y = 1.06;
  ham.add(headCollar);
  const headTop = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.15, 4), vmHammerMats.steel);
  headTop.position.y = 1.27;
  headTop.rotation.y = Math.PI / 4;
  ham.add(headTop);
  const headButt = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4), vmHammerMats.steel);
  headButt.position.y = 0.84;
  headButt.rotation.x = Math.PI;
  headButt.rotation.y = Math.PI / 4;
  ham.add(headButt);
  for (const sz of [1, -1]) {
    const rune = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.055, 0.012), vmHammerMats.rune);
    rune.position.set(0, 1.06, sz * 0.115);
    ham.add(rune);
  }

  // 두 주먹 + 팔뚝 (자루에 붙어 함께 움직인다 — 아래에서 올라와 쥔 모양)
  const hamFists = [];
  for (const fy of [0.0, 0.215]) {
    const fist = new THREE.Group();
    fist.position.y = fy;
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.115, 0.115), vmHammerMats.leather);
    fist.add(glove);
    for (let f = 0; f < 4; f++) {
      const fing = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.05, 0.10), vmHammerMats.leather);
      fing.position.set(-0.036 + f * 0.024, 0.05, 0.0);
      fist.add(fing);
    }
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.056, 0.10, 10), vmHammerMats.plate);
    wrist.position.y = -0.10;
    fist.add(wrist);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.26, 4, 10), vmHammerMats.plate);
    fore.position.set(0.012, -0.30, 0.035);
    fore.rotation.set(0.14, 0, -0.06);
    fist.add(fore);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.058, 0.08, 10), vmHammerMats.gold);
    cuff.position.y = -0.475;
    fist.add(cuff);
    ham.add(fist);
    hamFists.push(fist);
  }

  // 망치 자세 키 — 손(그립) 위치 + 머리 방향 (카메라 공간)
  const HAM_KEYS = [
    { p: 0.00, pos: [0.02, -0.92, -1.32], dir: [0.30, 0.93, 0.20], roll: 0.42 },   // 어깨에 얹고 있다
    { p: 0.12, pos: [0.06, -1.00, -1.26], dir: [0.22, 0.95, 0.16], roll: 0.32 },   // 힘을 모으며 내린다
    { p: 0.40, pos: [0.10, -0.46, -1.30], dir: [0.05, 0.86, 0.50], roll: 0.08 },   // 머리 위로 치켜듦
    { p: 0.50, pos: [0.08, -0.56, -1.24], dir: [0.03, 0.28, 0.96], roll: 0.04 },   // 가속하며 돌린다
    { p: 0.55, pos: [0.06, -0.66, -1.16], dir: [0.02, -0.92, -0.38], roll: 0.0 },   // 바닥에 꼽히는 순간
    { p: 0.66, pos: [0.05, -0.82, -1.10], dir: [0.02, -0.98, -0.16], roll: -0.06 },// 팔로우스루
    { p: 0.86, pos: [0.02, -0.90, -1.26], dir: [0.26, 0.74, 0.30], roll: 0.28 },   // 다시 들어올리며
    { p: 1.00, pos: [0.02, -0.92, -1.32], dir: [0.30, 0.93, 0.20], roll: 0.42 }
  ];
  const _hkPos = new THREE.Vector3();
  const _hkDir = new THREE.Vector3();
  const _hkQ = new THREE.Quaternion();
  const _hkUp = new THREE.Vector3(0, 1, 0);
  let hamPhase = 0;
  let hamImpactK = 0;
  const hamVmState = { visible: false, phase: 0, head: { x: 0.5, y: 0.5 }, roll: 0, impact: 0 };

  /** 카메라 공간 자세 키를 부드럽게 이어(스무스스텝) 망치를 놓는다 */
  function poseHammer(p) {
    let i = 0;
    while (i < HAM_KEYS.length - 2 && p > HAM_KEYS[i + 1].p) i++;
    const a = HAM_KEYS[i], b = HAM_KEYS[i + 1];
    const t = clamp((p - a.p) / Math.max(1e-4, b.p - a.p), 0, 1);
    const k = t * t * (3 - 2 * t);
    _hkPos.set(
      lerp(a.pos[0], b.pos[0], k),
      lerp(a.pos[1], b.pos[1], k),
      lerp(a.pos[2], b.pos[2], k)
    );
    _hkDir.set(
      lerp(a.dir[0], b.dir[0], k),
      lerp(a.dir[1], b.dir[1], k),
      lerp(a.dir[2], b.dir[2], k)
    ).normalize();
    ham.position.copy(_hkPos);
    _hkQ.setFromUnitVectors(_hkUp, _hkDir);
    ham.quaternion.copy(_hkQ);
    // 자루 축 둘레로 살짝 돌려 타격면이 화면을 향하게
    const roll = lerp(a.roll, b.roll, k);
    ham.rotateY(roll * 0.35);
    return 0;
  }

  function updateHammerVm(S, dt) {
    const pl = S.player;
    const isGen = !!pl && pl.kind === 'general';
    const show = isGen && viewK < 0.55 && !S.ended;
    genVm.visible = show;
    hamVmState.visible = show;
    if (!isGen) return;
    const u = pl.atkAnim > 0 ? clamp(1 - pl.atkAnim / 620, 0, 1) : 0;
    hamPhase = u;
    const breathe = Math.sin(timeSec * 1.6) * 0.008;
    poseHammer(u);
    ham.position.y += breathe;
    // 걸을 때·맞을 때 묵직하게 흔들린다
    const run = clamp(plSpeed / 90, 0, 1);
    ham.position.y += Math.sin(bobT * 1.0) * (0.006 + run * 0.03);
    ham.position.x += Math.sin(bobT * 0.5) * (0.005 + run * 0.014);
    if (pl.hit > 0) {
      const hk = clamp(pl.hit / 180, 0, 1);
      ham.position.x -= hk * 0.03;
      ham.position.y -= hk * 0.02;
    }
    // 꼭대기 정점의 화면 좌표 (검증·연출 기준)
    ham.updateWorldMatrix(true, true);
    headCore.getWorldPosition(_tipV);
    _tipV.project(vmCam);
    hamVmState.head.x = _tipV.x * 0.5 + 0.5;
    hamVmState.head.y = -_tipV.y * 0.5 + 0.5;
    hamVmState.phase = u;
    hamImpactK = (u > 0.52 && u < 0.62) ? 1 : Math.max(0, hamImpactK - dt / 220);
    hamVmState.impact = hamImpactK;
    hamVmState.roll = ham.quaternion.y;
  }

  const _kW = new THREE.Vector3();
  const _kB = new THREE.Vector3();
  const _kN = new THREE.Vector3();
  const _gW = new THREE.Vector3();
  const _gB = new THREE.Vector3();
  const _gN = new THREE.Vector3();
  const _tipV = new THREE.Vector3();
  const _tipP = new THREE.Vector3();
  const _bladeLocal = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(-0.34, 0.1, 0.78, 'XYZ')).normalize();
  const _flatLocal = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(-0.34, 0.1, 0.78, 'XYZ')).normalize();
  const _ikU = new THREE.Vector3();
  const _ikAxis = new THREE.Vector3();
  const _ikPole = new THREE.Vector3(0.62, -0.62, 0.48).normalize();
  const _ikE = new THREE.Vector3();
  const _ikF = new THREE.Vector3();
  const _ikX = new THREE.Vector3();
  const _ikY = new THREE.Vector3();
  const _ikZ = new THREE.Vector3();
  const _ikM = new THREE.Matrix4();
  const _qShoulder = new THREE.Quaternion();
  const _qWrist = new THREE.Quaternion();
  const _qElbow = new THREE.Quaternion();
  const _qSolvedSh = new THREE.Quaternion();
  const _qSolvedWr = new THREE.Quaternion();
  const _mHand = new THREE.Matrix4();
  const _mHandT = new THREE.Matrix4();
  const _tmpV3 = new THREE.Vector3();

  /** 에르미트 보간 (키 p 간격이 달라도 C1 연속 · 키에서 속도가 끊기지 않는다) */
  function hermite(keys, idx, p, ch, out) {
    const n = keys.length;
    let i = 0;
    while (i < n - 2 && p > keys[i + 1].p) i++;
    const a = keys[i], b = keys[Math.min(n - 1, i + 1)];
    const pa = a.p, pb = b.p;
    const dt = Math.max(1e-5, pb - pa);
    const t = clamp((p - pa) / dt, 0, 1);
    const am = keys[Math.max(0, i - 1)], bm = keys[Math.min(n - 1, i + 2)];
    const dp = Math.max(1e-5, bm.p - am.p);
    // 탄젠트(기울기) — 양옆 키를 잇는 방향
    const m0 = [0, 0, 0], m1 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      m0[k] = (b[ch][k] - am[ch][k]) / dp;
      m1[k] = (bm[ch][k] - a[ch][k]) / dp;
    }
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out.set(
      h00 * a[ch][0] + h10 * dt * m0[0] + h01 * b[ch][0] + h11 * dt * m1[0],
      h00 * a[ch][1] + h10 * dt * m0[1] + h01 * b[ch][1] + h11 * dt * m1[1],
      h00 * a[ch][2] + h10 * dt * m0[2] + h01 * b[ch][2] + h11 * dt * m1[2]
    );
    return out;
  }

  /** 자세(손목·칼날·칼날면) 샘플 */
  function samplePose(keys, p) {
    hermite(keys, 0, p, 'w', _kW);
    hermite(keys, 0, p, 'b', _kB);
    hermite(keys, 0, p, 'n', _kN);
    _kB.normalize();
    _kN.addScaledVector(_kB, -_kN.dot(_kB));
    if (_kN.lengthSq() < 1e-5) {
      _kN.set(0, 0, 1).addScaledVector(_kB, -_kB.z);
      if (_kN.lengthSq() < 1e-5) _kN.set(1, 0, 0);
    }
    _kN.normalize();
  }

  /** 시간 → 자세 파라미터 (예비동작 → 가속 횡베기 → 팔로우스루 → 회수) */
  function swingPhase(u) {
    const t = clamp(u, 0, 1);
    if (t < 0.24) { const k = t / 0.24; return 0.20 * (k * k * (3 - 2 * k)); }
    if (t < 0.64) { const k = (t - 0.24) / 0.40; return 0.20 + 0.56 * (k * k * (3 - 2 * k)); }
    const k = (t - 0.64) / 0.36;
    return 0.76 + 0.24 * (k * k * (3 - 2 * k));
  }

  /** 2뼈 IK — 손목 위치 · 칼날 방향 · 칼날 면 법선 → 어깨/팔꿈치/손목 쿼터니언 */
  function solveArm(Wc, Bc, Nc) {
    const W = _ikU.copy(Wc).sub(ARM.root);
    let d = W.length();
    const maxD = ARM.l1 + ARM.l2 - 0.02;
    if (d > maxD) { W.multiplyScalar(maxD / d); d = maxD; }
    if (d < 0.3) { W.setLength(0.3); d = 0.3; }
    const u = W.clone().normalize();
    const cosA = (ARM.l1 * ARM.l1 + d * d - ARM.l2 * ARM.l2) / (2 * ARM.l1 * d);
    const A = Math.acos(clamp(cosA, -1, 1));
    _ikAxis.crossVectors(u, _ikPole);
    if (_ikAxis.lengthSq() < 1e-6) _ikAxis.set(1, 0, 0);
    _ikAxis.normalize();
    const uArm = u.clone().applyAxisAngle(_ikAxis, -A).normalize();
    _ikE.copy(uArm).multiplyScalar(ARM.l1);
    _ikF.copy(W).sub(_ikE).normalize();

    _ikY.copy(uArm).negate();
    _ikX.crossVectors(uArm, _ikF);
    if (_ikX.lengthSq() < 1e-6) _ikX.set(1, 0, 0);
    _ikX.normalize();
    _ikZ.crossVectors(_ikX, _ikY).normalize();
    _ikM.makeBasis(_ikX, _ikY, _ikZ);
    _qSolvedSh.setFromRotationMatrix(_ikM);

    const fY = _ikF.dot(_ikY), fZ = _ikF.dot(_ikZ);
    const theta = Math.atan2(-fZ, -fY);

    _qElbow.copy(_qSolvedSh).multiply(new THREE.Quaternion().setFromAxisAngle(_ikX.set(1, 0, 0), theta));

    // 손목 — 칼날 방향만 맞추면 칼이 축 둘레로 뒤틀린다. 칼날 면 법선까지 맞춰 축을 고정한다.
    const qElInv = _qElbow.clone().invert();
    const dLocal = _tmpV3.copy(Bc).normalize().applyQuaternion(qElInv).normalize();
    const nLocal = _ikZ.copy(Nc).normalize().applyQuaternion(qElInv);
    nLocal.addScaledVector(dLocal, -nLocal.dot(dLocal));
    if (nLocal.lengthSq() < 1e-6) nLocal.set(1, 0, 0).addScaledVector(dLocal, -dLocal.x);
    nLocal.normalize();
    const tY = dLocal, tZ = nLocal, tX = new THREE.Vector3().crossVectors(tY, tZ).normalize();
    tZ.crossVectors(tX, tY).normalize();
    _mHand.makeBasis(tX, tY, tZ);
    // 손(칼자루) 프레임: 칼날 = _bladeLocal, 날면 법선 = _flatLocal
    const sY = _bladeLocal, sZ = _flatLocal.clone().addScaledVector(sY, -_flatLocal.dot(sY)).normalize();
    const sX = new THREE.Vector3().crossVectors(sY, sZ).normalize();
    sZ.crossVectors(sX, sY).normalize();
    _mHandT.makeBasis(sX, sY, sZ).transpose();
    _mHand.multiply(_mHandT);
    _qSolvedWr.setFromRotationMatrix(_mHand);
    return { sh: _qSolvedSh, wr: _qSolvedWr, elbow: theta };
  }

  /* ===========================================================================
     칼날 궤적 리본 — 칼이 실제로 지나간 자리를 따라 그리는 가로 호
     =========================================================================== */
  const TRAIL_N = 11;
  const trailGeo = new THREE.BufferGeometry();
  const trailPos = new Float32Array(TRAIL_N * 2 * 3);
  const trailColA = new Float32Array(TRAIL_N * 2 * 3);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColA, 3));
  {
    const idx = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    trailGeo.setIndex(idx);
  }
  const trailMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide
  });
  const trailMesh = new THREE.Mesh(trailGeo, trailMat);
  trailMesh.frustumCulled = false;
  trailMesh.visible = false;
  trailMesh.renderOrder = 6;
  vmScene.add(trailMesh);
  const TRAIL_LIFE = 150;      // ms — 베기가 끝난 뒤 칼날 궤적이 흐려져 사라지는 시간
  const trailPts = [];         // { tip, mid } — 마지막 점이 가장 오래된 점
  let trailFade = 0;           // 1 = 베는 중(선명) → 0 = 완전히 사라짐
  const _trailTip = new THREE.Vector3();
  const _trailMid = new THREE.Vector3();
  const _bladeBaseV = new THREE.Vector3();
  const _bladeMidV = new THREE.Vector3();
  const _bladePt = new THREE.Vector3();

  function clearTrail() {
    trailPts.length = 0;
    trailFade = 0;
    trailMesh.visible = false;
  }

  /* 칼날 궤적 리본 — 베는 동안 칼이 지나간 자리에 점이 쌓이고,
     베기가 끝나면 새 점 없이 150ms 동안 흐려지다 완전히 사라진다 (화면에 얼어붙지 않는다).
     프레임률이 낮아도 베는 동안은 보이도록, 점 수명이 아니라 페이드로 정리한다. */
  function pushTrail(tip, mid, on, dt) {
    const step = dt > 0 ? dt : 16;
    if (on) {
      trailFade = 1;
      const head = trailPts[0];
      // 같은 자리에 머무는 프레임은 쌓지 않는다 (멈춘 칼날이 두꺼운 띠를 만들지 않게)
      if (!head || Math.abs(head.tip.x - tip.x) + Math.abs(head.tip.y - tip.y) + Math.abs(head.tip.z - tip.z) > 0.006) {
        trailPts.unshift({ tip: tip.clone(), mid: mid.clone() });
      }
      while (trailPts.length > TRAIL_N) trailPts.pop();
    } else {
      // 베기가 끝났다 — 더 쌓지 않고 빠르게 흐려져 사라진다
      trailFade = Math.max(0, trailFade - step / TRAIL_LIFE);
      if (trailFade <= 0) {
        if (trailPts.length) trailPts.length = 0;
        trailMesh.visible = false;
        return;
      }
    }
    const n = trailPts.length;
    if (n < 2) {
      trailMesh.visible = false;
      return;
    }
    trailMesh.visible = true;
    for (let i = 0; i < TRAIL_N; i++) {
      const p = trailPts[Math.min(n - 1, i)];
      trailPos[i * 6 + 0] = p.tip.x; trailPos[i * 6 + 1] = p.tip.y; trailPos[i * 6 + 2] = p.tip.z;
      trailPos[i * 6 + 3] = p.mid.x; trailPos[i * 6 + 4] = p.mid.y; trailPos[i * 6 + 5] = p.mid.z;
      const k = Math.pow(1 - i / Math.max(1, TRAIL_N - 1), 1.7) * trailFade;
      // 끝은 하얀 심, 뒤로 갈수록 푸른 잔광 (가산 혼합이라 겹쳐도 뭉개지지 않게 낮게)
      const kk = Math.pow(k, 0.85);
      trailColA[i * 6 + 0] = 0.52 * kk; trailColA[i * 6 + 1] = 0.80 * kk; trailColA[i * 6 + 2] = 1.0 * kk;
      trailColA[i * 6 + 3] = 0.10 * kk; trailColA[i * 6 + 4] = 0.30 * kk; trailColA[i * 6 + 5] = 0.58 * kk;
    }
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
  }

  let vmEb = 0.5;
  let vmGuard = 0;
  let vmMeshes = 0;  vm.traverse((o) => { if (o.isMesh) { vmMeshes++; o.name = 'vm-' + (o.geometry ? o.geometry.type : 'mesh'); } });
  const _eSh = new THREE.Euler(0, 0, 0, 'YXZ');
  const _eWr = new THREE.Euler(0, 0, 0, 'YXZ');
  let vmRootX = ARM.root.x, vmRootY = ARM.root.y, vmRootZ = ARM.root.z;
  let lastIkGuard = 0;

  function updateViewModel(S, dt) {
    const pl = S.player;
    if (!pl) return;
    const isGen = pl.kind === 'general';
    const run = clamp(plSpeed / 120, 0, 1);
    vmBob += (dt / 1000) * (2.0 + run * 7.5);
    const bob = Math.sin(vmBob) * (0.014 + run * 0.04);
    const sway = Math.sin(vmBob * 0.5) * (0.016 + run * 0.045);
    const dashK = pl.dash > 0 ? clamp(pl.dash / 190, 0, 1) : 0;
    const hitK = pl.hit > 0 ? clamp(pl.hit / 180, 0, 1) : 0;

    vm.position.set(sway * 0.7, bob - 0.008, dashK * 0.6);
    vm.rotation.set(-run * 0.02 - dashK * 0.1 + hitK * 0.03, 0, Math.sin(vmBob * 0.5) * 0.018 * run);
    // 🎬 관전으로 넘어가면 1인칭 팔·검은 사라진다 (전장을 가리지 않게)
    vm.visible = viewK < 0.55;
    // 장군은 검 대신 큰 망치를 든다 (팔·검 모델은 숨김)
    armRoot.visible = !isGen;
    if (isGen) { if (trailMesh.visible) clearTrail(); }

    /* --- 막기 자세 가중치 --- */
    const gTarget = pl.guard ? 1 : 0;
    vmGuard = damp(vmGuard, gTarget, dt, 60);

    /* --- 검 궤적: 예비동작 → 가로 횡베기(적을 관통) → 팔로우스루 → 회수 --- */
    const sw = pl.swipe || { sx: -1, sy: 0.16 };
    const dx = clamp(sw.sx, -1, 1), dy = clamp(sw.sy, -1, 1);
    const u = pl.atkAnim > 0 ? 1 - clamp(pl.atkAnim / ATK_DUR, 0, 1) : 0;
    const keys = dx >= 0 ? VM_SWING_KEYS.right : VM_SWING_KEYS.left;
    const p = swingPhase(u);
    samplePose(keys, p);
    // 스와이프의 세로 성분은 살짝만 — 아래로 그으면 검끝이 조금 더 내려간다
    const swayK = Math.sin(Math.PI * clamp(u, 0, 1));
    _kW.y -= dy * 0.07 * swayK;
    _kW.x -= dx * 0.03 * swayK * (u < 0.3 ? 1 : -0.5);

    // 막기 자세로 부드럽게 섞는다 (같은 IK 로 풀어서 어색한 각이 없다)
    _gW.set(GUARD_POSE.w[0], GUARD_POSE.w[1], GUARD_POSE.w[2]);
    _gB.set(GUARD_POSE.b[0], GUARD_POSE.b[1], GUARD_POSE.b[2]).normalize();
    _gN.set(GUARD_POSE.n[0], GUARD_POSE.n[1], GUARD_POSE.n[2]);
    if (vmGuard > 0.001) {
      _kW.lerp(_gW, vmGuard);
      _kB.lerp(_gB, vmGuard).normalize();
      _kN.lerp(_gN, vmGuard).normalize();
    }

    // IK 풀이 → 관절 쿼터니언 (관성 있게 따라가도록 slerp)
    const sol = solveArm(_kW, _kB, _kN);
    _qShoulder.slerp(sol.sh, 1 - Math.exp(-Math.max(1, dt) / 24));
    _qWrist.slerp(sol.wr, 1 - Math.exp(-Math.max(1, dt) / 20));
    shoulderPivot.quaternion.copy(_qShoulder);
    wristPivot.quaternion.copy(_qWrist);
    vmEb = damp(vmEb, sol.elbow, dt, 22);
    elbowPivot.rotation.set(vmEb, 0, 0);

    // 막기 충격 — 검을 받아내면 팔이 뒤로 밀리고 섬광이 터진다
    const gflash = S.guardFlash || 0;
    if (gflash > 0) {
      const k = clamp(gflash / 300, 0, 1);
      armRoot.position.set(vmRootX - 0.07 * k, vmRootY - 0.04 * k, vmRootZ + 0.18 * k);
      armRoot.rotation.set(-0.06 * k, 0.04 * k, 0.05 * k);
      guardSpark.material.opacity = k * 0.95;
      guardSpark.scale.setScalar(0.7 + (1 - k) * 0.9);
    } else {
      armRoot.position.set(vmRootX, vmRootY + bob * 0.5, vmRootZ + dashK * 0.28);
      armRoot.rotation.set(0, 0, 0);
      guardSpark.material.opacity = 0;
    }
    guardSpark.position.set(0, 1.35, -0.02);
    lastIkGuard = vmGuard;

    // 자세 기록 (검증용)
    vmState.phase = u; vmState.poseP = p; vmState.dx = dx; vmState.dy = dy;
    _eSh.setFromQuaternion(shoulderPivot.quaternion, 'YXZ');
    _eWr.setFromQuaternion(wristPivot.quaternion, 'YXZ');
    vmState.sx = _eSh.x; vmState.sy = _eSh.y; vmState.sz = _eSh.z;
    vmState.wx = _eWr.x; vmState.wy = _eWr.y; vmState.wz = _eWr.z;
    vmState.eb = elbowPivot.rotation.x;
    vmState.px = armRoot.position.x; vmState.py = armRoot.position.y; vmState.pz = armRoot.position.z;

    // 검끝이 화면 어디를 지나는지
    sword.updateWorldMatrix(true, false);
    tipMarker.getWorldPosition(_tipV);
    _tipP.copy(_tipV).project(vmCam);
    vmState.tipX = _tipP.x * 0.5 + 0.5;
    vmState.tipY = -_tipP.y * 0.5 + 0.5;
    vmState.tipZ = _tipP.z;
    vmState.tipWorld = { x: _tipV.x, y: _tipV.y, z: _tipV.z };
    vmState.targetB = { x: _kB.x, y: _kB.y, z: _kB.z };
    wristPivot.getWorldPosition(_tipP);
    vmState.wristWorld = { x: _tipP.x, y: _tipP.y, z: _tipP.z };

    // 칼날의 세 지점(밑동·중간·끝) 화면 좌표 — 검끝이 적 몸통을 지나는지 검증용
    sword.localToWorld(_bladeBaseV.set(0, 0.22, 0));
    sword.localToWorld(_bladeMidV.set(0, 2.16, 0));  // 검끝 바로 안쪽 — 궤적 리본의 폭
    vmState.bladeBase = { x: _bladeBaseV.x, y: _bladeBaseV.y, z: _bladeBaseV.z };
    for (let i = 0; i < 3; i++) {
      _bladePt.copy(_bladeBaseV).lerp(_tipV, i * 0.5).project(vmCam);
      const bp = vmState.bladeScreen[i];
      bp[0] = _bladePt.x * 0.5 + 0.5;
      bp[1] = -_bladePt.y * 0.5 + 0.5;
    }

    // 칼날 궤적 리본 — 베는 동안 칼이 지나간 자리를 따라 그리고, 다 베면 흔적 없이 사라진다
    const swinging = pl.atkAnim > 0 && vm.visible && !isGen;
    if (vm.visible && !isGen) pushTrail(_tipV, _bladeMidV, swinging && p > 0.19 && p < 0.80, dt);
    else clearTrail();
  }

  const vmState = {
    phase: 0, poseP: 0, dx: 0, dy: 0,
    px: 0.98, py: -1.34, pz: -4.8,
    sx: 0, sy: 0, sz: 0, wx: 0, wy: 0, wz: 0, eb: 0.5,
    tipX: 0.5, tipY: 0.5, tipZ: 0, tipWorld: { x: 0, y: 0, z: 0 }, guardBase: { x: 0, y: 0, z: 0 },
    bladeBase: { x: 0, y: 0, z: 0 }, bladeScreen: [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]
  };
  let vmBob = 0;

  /* --- 깃발 · 불 애니메이션 --- */
  function updateBanners(t) {
    for (const b of banners) {
      const pos = b.cloth.attributes.position;
      const base = b.base;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const y = base[i * 3 + 1];
        const k = (x / 13 + 0.5);
        pos.array[i * 3 + 2] = Math.sin(x * 0.4 + t * 3.0 + b.phase) * 1.6 * k + Math.cos(y * 0.3 + t * 2.1) * 0.5 * k;
      }
      pos.needsUpdate = true;
    }
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const k = 0.85 + Math.sin(t * 7 + i * 2) * 0.13;
      f.scale.set(k, 0.9 + Math.sin(t * 9 + i) * 0.16, k);
      f.material.opacity = 0.7 + Math.sin(t * 11 + i) * 0.16;
    }
  }

  /* --- 구름 · 먼 섬 · 떠 있는 바위 --- */
  function updateAtmosphere(t, dt) {
    const sec = dt / 1000;
    for (const c of clouds) {
      c.ang += c.spd * sec;
      c.sprite.position.x = Math.cos(c.ang) * c.dist;
      c.sprite.position.z = Math.sin(c.ang) * c.dist;
      c.sprite.position.y = c.y + Math.sin(t * 0.25 + c.bob) * 4;
    }
    for (const f of farIslands) {
      f.position.y = f.userData.baseY + Math.sin(t * 0.18 + f.userData.bob) * 5;
    }
    for (const h of heroIslands) {
      h.position.y = h.userData.baseY + Math.sin(t * 0.22 + h.userData.bob) * 3.5;
    }
    const chunks = island.userData.chunks;
    if (chunks) {
      const data = island.userData.chunkData;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        q.setFromEuler(new THREE.Euler(t * 0.1 + i, t * 0.13 + i * 2, 0));
        s.set(d.sc, d.sc * 0.8, d.sc);
        m.compose(d.p, q, s);
        chunks.setMatrixAt(i, m);
      }
      chunks.instanceMatrix.needsUpdate = true;
    }
  }

  /* --- 프레임 --- */
  let lastTs = 0;
  let frames = 0;
  let timeSec = 0;
  let lastS = null;
  let fpsAcc = 0, fpsN = 0;
  let pixelScale = 1;
  const stats = { lum: 0, sky: 0, ground: 0, at: 0 };

  function resize(w, h) {
    size.w = Math.max(1, Math.round(w));
    size.h = Math.max(1, Math.round(h));
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * pixelScale;
    renderer.setPixelRatio(dpr);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    // 세로(portrait) 화면에서 좌우 시야가 좁아 답답하지 않도록 수평 화각을 확보한다
    const halfH = Math.tan(30 * Math.PI / 180);        // 목표 수평 반화각 30° (hfov 60°)
    const vfov = 2 * Math.atan(halfH / camera.aspect) * 180 / Math.PI;
    camera.fov = clamp(vfov, 74, 94);
    camera.updateProjectionMatrix();
    vmCam.aspect = camera.aspect;
    vmCam.fov = camera.fov;
    vmCam.updateProjectionMatrix();
  }

  function sampleBrightness() {
    try {
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * 4);
      const rows = [0.06, 0.16, 0.26, 0.36, 0.5, 0.64, 0.76, 0.88, 0.96];
      let sum = 0, n = 0, skySum = 0, skyN = 0, groundSum = 0, groundN = 0;
      for (const ry of rows) {
        const y = Math.max(0, Math.min(h - 1, Math.floor(h * (1 - ry))));
        gl.readPixels(0, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        for (let i = 0; i < w; i += 6) {
          const l = 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
          sum += l; n++;
          if (ry < 0.3) { skySum += l; skyN++; } else if (ry > 0.62) { groundSum += l; groundN++; }
        }
      }
      stats.lum = sum / Math.max(1, n);
      stats.sky = skySum / Math.max(1, skyN);
      stats.ground = groundSum / Math.max(1, groundN);
      stats.at = frames;
    } catch (e) { /* 샘플 실패는 무시 */ }
  }

  function render(S, ts) {
    let dt = lastTs ? Math.min(60, ts - lastTs) : 16;
    if (!(dt > 0)) dt = 16;
    lastTs = ts;
    lastS = S;
    timeSec += dt / 1000;

    buildCrowd(S, dt);
    syncSlashes(S);
    syncTrails(S);
    syncCuts(S);
    syncPieces(S, dt);
    syncParticles(S, dt);
    syncShocks(S);
    updateBanners(timeSec);
    updateCamera(S, dt);
    updateViewModel(S, dt);
    updateHammerVm(S, dt);
    updateAtmosphere(timeSec, dt);
    updateDust(timeSec, camera.position.x, camera.position.z);

    renderer.autoClear = true;
    renderer.info.reset();
    if (!window.__TW_VM_ONLY__) renderer.render(scene, camera);
    renderer.autoClear = false;
    if (vm.visible) {
      renderer.clearDepth();
      renderer.render(vmScene, vmCam);
    }
    renderer.autoClear = true;
    frames++;

    if (window.__TW_SAMPLE__ && (frames % 6) === 0) sampleBrightness();

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

  /* 공용 지오메트리·텍스처는 모듈 공용이라 절대 버리지 않는다 (다음 판이 그대로 쓴다) */
  const SHARED_GEO = new Set(Object.keys(GEO).map((k) => GEO[k]).concat(Object.keys(GGEO).map((k) => GGEO[k])));
  const SHARED_TEX = new Set(Object.keys(TEX).map((k) => TEX[k]));

  function disposeScene(root) {
    const mats = new Set();
    const texs = new Set();
    const geos = new Set();
    root.traverse((o) => {
      if (o.geometry && !SHARED_GEO.has(o.geometry)) geos.add(o.geometry);
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mm of list) {
        mats.add(mm);
        for (const key in mm) {
          const v = mm[key];
          if (v && v.isTexture && !SHARED_TEX.has(v)) texs.add(v);
        }
      }
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    root.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }

  function dispose() {
    for (const [, v] of slashViews) {
      camera.remove(v.group);
      for (const m of v.mats) m.dispose();
      for (const g of v.geos) g.dispose();
    }
    slashViews.clear();
    clearTrail();
    for (const [, v] of trailViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    trailViews.clear();
    for (const [, v] of cutViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    cutViews.clear();
    for (const [, p] of pieces) disposePiece(p);
    pieces.clear();
    for (const P of parts) { P.mesh.dispose(); }
    for (const P of genParts) { P.mesh.dispose(); }
    arcMesh.dispose();
    for (const k in vmMats) vmMats[k].dispose();
    pGeo.dispose(); pMat.dispose();
    dustGeo.dispose(); dustMat.dispose();
    // 판마다 만든 지오메트리·재질·텍스처를 전부 돌려준다 (폰 메모리·GPU 누수 방지)
    disposeScene(scene);
    disposeScene(vmScene);
    if (envTexture) { try { envTexture.dispose(); } catch (e) { /* noop */ } }
    if (sun.shadow && sun.shadow.map) { try { sun.shadow.map.dispose(); } catch (e) { /* noop */ } }
    groundTex.dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) { /* noop */ }
  }

  /* --- 화면 투영 (2D 오버레이) --- */
  function project(x, y, h) {
    tmpV.set(x - W / 2, h || 0, y - H / 2).project(camera);
    return {
      x: (tmpV.x * 0.5 + 0.5) * size.w,
      y: (-tmpV.y * 0.5 + 0.5) * size.h,
      z: tmpV.z,
      behind: tmpV.z > 1
    };
  }

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
    viewmodel: {
      group: vm, armRoot: armRoot, swordArm: shoulderPivot, shieldArm: null, sword: sword,
      shoulderPivot: shoulderPivot, elbowPivot: elbowPivot, wristPivot: wristPivot,
      meshes: vmMeshes, scene: vmScene
    },
    debugCamera: null,
    render: render,
    resize: resize,
    dispose: dispose,
    project: project,
    edgeAngle: edgeAngle,
    W: W,
    H: H,
    stats: stats,
    clouds: clouds,
    heroIslands: heroIslands,
    skyGroup: skyGroup,
    farIslands: farIslands,
    island: island,
    arcMesh: arcMesh,
    info: function () {
      const eSh = new THREE.Euler().setFromQuaternion(shoulderPivot.quaternion, 'YXZ');
      const eWr = new THREE.Euler().setFromQuaternion(wristPivot.quaternion, 'YXZ');
      return {
        frames: frames,
        units: aliveCount,
        unitsTotal: units.size,
        pieces: pieces.size,
        slashes: slashViews.size,
        // 칼날 궤적 리본 상태 — 베기가 끝나면 점이 0개, 메시도 사라져야 한다 (잔상 검증용)
        trail: { pts: trailPts.length, visible: !!trailMesh.visible, life: TRAIL_LIFE },
        slashFx: (function () {
          const it = slashViews.values().next();
          if (it.done || !it.value) return null;
          const v = it.value;
          return {
            layers: v.mats.length,
            body: v.body.material.opacity,
            core: v.core.material.opacity,
            halo: v.halo.material.opacity,
            echo: Math.max(v.echo1.material.opacity, v.echo2.material.opacity),
            wave: v.wave.material.opacity,
            waveZ: v.wave.position.z,
            coreTex: !!TEX.slashCore,
            glowTex: !!TEX.slashGlow,
            trail: trailPts.length,
            trailGeo: trailMesh.visible
          };
        })(),
        trails: trailViews.size,
        cuts: cutViews.size,
        arcs: arcCountNow,
        wind: windCount,
        swinging: swingCount,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        pixelRatio: renderer.getPixelRatio(),
        canvas: { w: canvas.width, h: canvas.height, cw: size.w, ch: size.h },
        camera: {
          x: camera.position.x, y: camera.position.y, z: camera.position.z,
          fov: camera.fov, yaw: camYaw, pitch: camPitch, roll: camRoll
        },
        fp: {
          eye: EYE,
          yaw: camYaw,
          pitch: camPitch,
          viewmodelMeshes: vmMeshes,
          viewmodelVisible: !!(vm.visible && shoulderPivot.visible && armRoot.visible),
          viewmodelGuard: vmGuard,
          shield: false,
          swordPhase: vmState.phase,
          poseP: vmState.poseP,
          swingSign: vmState.dx >= 0 ? 1 : -1,
          trail: trailPts.length,
          bladeBase: vmState.bladeBase,
          bladeScreen: vmState.bladeScreen.map((p) => ({ x: p[0], y: p[1] })),
          slashDir: { x: vmState.dx, y: vmState.dy },
          atkDur: ATK_DUR,
          sword: {
            x: armRoot.position.x, y: armRoot.position.y, z: armRoot.position.z,
            rx: eSh.x, ry: eSh.y, rz: eSh.z,
            sx: eSh.x, sy: eSh.y, sz: eSh.z,
            wx: eWr.x, wy: eWr.y, wz: eWr.z,
            eb: elbowPivot.rotation.x
          },
          shoulder: { x: eSh.x, y: eSh.y, z: eSh.z },
          wrist: { x: eWr.x, y: eWr.y, z: eWr.z },
          elbow: elbowPivot.rotation.x,
          tip: { nx: vmState.tipX, ny: vmState.tipY, nz: vmState.tipZ, world: vmState.tipWorld },
          targetB: vmState.targetB || null,
          bladeDir: vmState.tipWorld && vmState.wristWorld ? {
            x: vmState.tipWorld.x - vmState.wristWorld.x,
            y: vmState.tipWorld.y - vmState.wristWorld.y,
            z: vmState.tipWorld.z - vmState.wristWorld.z
          } : null,
          hierarchy: ['shoulderPivot', 'elbowPivot', 'wristPivot', 'sword'],
          quat: {
            sh: [shoulderPivot.quaternion.x, shoulderPivot.quaternion.y, shoulderPivot.quaternion.z, shoulderPivot.quaternion.w],
            wr: [wristPivot.quaternion.x, wristPivot.quaternion.y, wristPivot.quaternion.z, wristPivot.quaternion.w]
          },
          guardSpark: guardSpark.material.opacity
        },
        view: {
          mode: viewMode,
          blend: +viewK.toFixed(3),
          camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          spectate: lastS && lastS.spectate ? {
            x: lastS.spectate.x, y: lastS.spectate.y, h: lastS.spectate.h,
            yaw: lastS.spectate.yaw, pitch: lastS.spectate.pitch
          } : null,
          simView: lastS ? lastS.view : 'none',
          fov: camera.fov
        },
        crowd: { parts: parts.length, max: MAX_SOLDIERS },
        generals: {
          alive: genAlive, ally: genAllyN, enemy: genEnemyN, max: MAX_GENERALS,
          parts: genParts.length,
          shocks: lastS && lastS.shocks ? lastS.shocks.length : 0,
          cracks: lastS && lastS.cracks ? lastS.cracks.length : 0,
          visibleShocks: shockPool.filter((p) => p.mesh.visible).length
        },
        hammer: {
          visible: hamVmState.visible,
          phase: +hamVmState.phase.toFixed(3),
          head: { x: +hamVmState.head.x.toFixed(3), y: +hamVmState.head.y.toFixed(3) },
          impact: +hamVmState.impact.toFixed(2),
          fists: hamFists.length,
          group: !!genVm,
          swordHidden: !armRoot.visible
        },
        graphics: {
          env: !!scene.environment,
          lights: scene.children.filter((o) => !!o.isLight).length,
          dust: DUST_N,
          steelMetal: crowdMat.steel.metalness,
          steelRough: crowdMat.steel.roughness,
          vmSteelMetal: vmMats.steel.metalness,
          vmEnv: !!vmScene.environment,
          rim: rim.intensity,
          sun: sun.intensity,
          hemi: hemi.intensity,
          exposure: renderer.toneMappingExposure,
          shadows: renderer.shadowMap.enabled && sun.castShadow,
          shadowMap: sun.shadow.mapSize.width,
          sky: 'morning-island',
          clouds: clouds.length,
          farIslands: farIslands.length,
          fog: scene.fog ? { near: scene.fog.near, far: scene.fog.far, color: '#' + scene.fog.color.getHexString() } : null,
          background: '#' + scene.background.getHexString(),
          islandRings: 8
        },
        brightness: { lum: stats.lum, sky: stats.sky, ground: stats.ground, at: stats.at }
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
        out.push({
          team: v.team, x: u.x, y: u.y, face: u.face, yaw: Math.PI / 2 - (u.face || 0),
          speed: v.speed, wind: u.wind || 0, swing: u.swing || 0,
          windK: v.windK || 0, swingK: v.swingK || 0,
          armRaise: v.armRx || 0, elbow: v.elbowR || 0, torsoYaw: v.torsoYaw || 0, lean: v.lean || 0,
          legL: v.legL || 0, legR: v.legR || 0, kneeL: v.kneeL || 0, run: v.run || 0
        });
      }
      return out;
    }
  };
  return api;
}

window.TWArena3D = {
  // 페이지 로드 시점에 GPU가 잠깐 바빠 실패했을 수 있다 → 호출할 때 한 번 더 확인한다
  supported: function () { if (!webglOk) webglOk = probeWebGL(); return webglOk; },
  create: create,
  revision: REV
};

export default window.TWArena3D;
