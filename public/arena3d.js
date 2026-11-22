/* =============================================================================
   직접 참전 · 3D 칼싸움 전장 (Three.js WebGL 렌더러)
   - 시뮬레이션은 arena.js(2D)가 그대로 담당하고, 이 모듈은 그 상태(S)를 3D로 그린다.
   - three 는 public/vendor/three.module.min.js 로컬 서빙 (외부 CDN 없음)
   - WebGL 을 못 쓰면 window.TWArena3D.supported() === false → arena.js 가 2D로 폴백
   - 노출: window.TWArena3D.create({ canvas, cfg }) → 렌더러 객체
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

/* ---------------------------------------------------------------------------
   공용 지오메트리 · 텍스처 (모듈에 한 번만 만들어 공유)
   --------------------------------------------------------------------------- */
const GEO = {
  leg: new THREE.BoxGeometry(2.0, 8.6, 2.3),
  boot: new THREE.BoxGeometry(2.3, 1.7, 3.4),
  torso: new THREE.CylinderGeometry(4.35, 3.5, 10, 12, 1),
  shoulder: new THREE.SphereGeometry(2.55, 10, 8),
  neck: new THREE.CylinderGeometry(1.25, 1.25, 2.2, 8),
  head: new THREE.SphereGeometry(2.45, 12, 10),
  helmet: new THREE.SphereGeometry(2.95, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.56),
  visor: new THREE.BoxGeometry(4.7, 0.7, 0.9),
  crest: new THREE.BoxGeometry(0.9, 2.4, 3.8),
  upperArm: new THREE.BoxGeometry(1.95, 6.4, 1.95),
  foreArm: new THREE.BoxGeometry(1.7, 5.4, 1.7),
  blade: new THREE.BoxGeometry(0.7, 0.55, 13.5),
  guard: new THREE.BoxGeometry(3.2, 0.65, 0.85),
  grip: new THREE.BoxGeometry(0.95, 0.95, 2.4),
  shield: new THREE.CylinderGeometry(4.4, 4.4, 0.85, 16),
  boss: new THREE.SphereGeometry(1.5, 10, 8),
  ring: new THREE.RingGeometry(13, 15.4, 28),
  cape: new THREE.PlaneGeometry(9.5, 13, 4, 4)
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
    // 아래(플레이어)에서 바깥으로 휘어 나가는 칼자국
    for (let i = 0; i < 3; i++) {
      const g = x.createLinearGradient(0, 0, 256, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.18, 'rgba(214,236,255,' + (0.5 - i * 0.12) + ')');
      g.addColorStop(0.5, 'rgba(255,255,255,' + (0.95 - i * 0.2) + ')');
      g.addColorStop(0.82, 'rgba(214,236,255,' + (0.5 - i * 0.12) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.strokeStyle = g;
      x.lineWidth = 26 - i * 7;
      x.lineCap = 'round';
      x.beginPath();
      x.ellipse(128, 150, 116 - i * 9, 104 - i * 8, 0, Math.PI * 1.12, Math.PI * 1.88);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })(),
  flesh: (function () {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 128, 256);
    const g = x.createRadialGradient(64, 128, 6, 64, 128, 118);
    g.addColorStop(0, '#8e2626');
    g.addColorStop(0.55, '#6d1a1a');
    g.addColorStop(0.86, '#3d0d0d');
    g.addColorStop(1, 'rgba(61,13,13,0)');
    x.save();
    x.translate(64, 128);
    x.scale(0.42, 0.46);
    x.translate(-64, -128);
    x.fillStyle = g;
    x.beginPath();
    x.arc(64, 128, 118, 0, Math.PI * 2);
    x.fill();
    x.restore();
    // 결 (근육 다발)
    x.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 26; i++) {
      x.strokeStyle = 'rgba(200,70,70,' + (0.05 + Math.random() * 0.12).toFixed(3) + ')';
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

/* 전장 바닥 텍스처 — 흙 · 풀 · 길 · 진영 색 띠를 한 장에 그린다 */
function terrainTexture(w, h, seed, meColor, enemyColor) {
  const cw = 384;
  const ch = Math.round(cw * (h / w));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const b = c.getContext('2d');
  const r = mulberry32(seed >>> 0);

  const g = b.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, '#22322a');
  g.addColorStop(0.34, '#1d2a22');
  g.addColorStop(0.7, '#20241f');
  g.addColorStop(1, '#2b221c');
  b.fillStyle = g;
  b.fillRect(0, 0, cw, ch);

  // 흙길 (중앙 세로 · 부드러운 한 줄기)
  b.save();
  b.beginPath();
  const roadPts = [];
  for (let y = ch * 0.06; y <= ch * 0.95; y += 8) roadPts.push([cw / 2 + Math.sin(y * 0.012) * 30 + Math.sin(y * 0.004) * 16, y]);
  b.moveTo(roadPts[0][0] - 44, roadPts[0][1]);
  for (const [px, py] of roadPts) b.lineTo(px - 46 - Math.sin(py * 0.02) * 8, py);
  for (let i = roadPts.length - 1; i >= 0; i--) b.lineTo(roadPts[i][0] + 46 + Math.sin(roadPts[i][1] * 0.02) * 8, roadPts[i][1]);
  b.closePath();
  b.fillStyle = 'rgba(92,74,52,0.55)';
  b.fill();
  b.clip();
  for (let i = 0; i < 520; i++) {
    const x = cw / 2 + (r() - 0.5) * 120;
    const y = r() * ch;
    b.fillStyle = 'rgba(' + Math.round(70 + r() * 60) + ',' + Math.round(58 + r() * 44) + ',' + Math.round(40 + r() * 30) + ',' + (0.03 + r() * 0.1).toFixed(3) + ')';
    b.beginPath();
    b.ellipse(x, y, 2 + r() * 9, 1 + r() * 4, r() * 3, 0, Math.PI * 2);
    b.fill();
  }
  b.restore();

  // 흙 · 자갈 반점
  for (let i = 0; i < 2600; i++) {
    const x = r() * cw, y = r() * ch;
    const l = 16 + r() * 40;
    b.fillStyle = 'rgba(' + Math.round(l + 40) + ',' + Math.round(l + 30) + ',' + Math.round(l + 10) + ',' + (0.05 + r() * 0.14).toFixed(3) + ')';
    b.fillRect(x, y, 1 + r() * 3, 1 + r() * 2);
  }
  // 풀
  for (let i = 0; i < 900; i++) {
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
  vg.addColorStop(0, 'rgba(0,0,0,0.55)');
  vg.addColorStop(0.12, 'rgba(0,0,0,0)');
  vg.addColorStop(0.88, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  b.fillStyle = vg;
  b.fillRect(0, 0, cw, ch);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function hexA(hex, a) {
  const h = String(hex || '#3b82f6').replace('#', '');
  const n = parseInt(h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h, 16);
  if (!isFinite(n)) return 'rgba(59,130,246,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ---------------------------------------------------------------------------
   병사 모델 (절차적 3D 메시)
   --------------------------------------------------------------------------- */
function buildSoldier(color, opts) {
  const o = opts || {};
  const col = colorOf(color, '#3b82f6');
  const g = new THREE.Group();
  const mats = {
    armor: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.6), roughness: 0.52, metalness: 0.32 }),
    cloth: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.92), roughness: 0.88 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xe2ecf8, roughness: 0.28, metalness: 0.95, emissive: col.clone().multiplyScalar(0.18), emissiveIntensity: o.player ? 0.8 : 0.15 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc59066, roughness: 0.82 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1d2530, roughness: 0.9 }),
    shield: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.78), roughness: 0.55, metalness: 0.42 }),
    crest: new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.4), roughness: 0.6, emissive: col.clone(), emissiveIntensity: 0.5 })
  };

  // 다리 (관절 그룹)
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

  // 몸통 · 어깨 · 목
  const torso = new THREE.Mesh(GEO.torso, mats.armor);
  torso.position.y = 15.2;
  g.add(torso);
  // 가슴 장식 (진영 문양 느낌의 띠)
  const sash = new THREE.Mesh(new THREE.BoxGeometry(7.4, 1.5, 0.9), mats.cloth);
  sash.position.set(0, 16.4, 3.15);
  g.add(sash);
  for (const sx of [-1, 1]) {
    const sh = new THREE.Mesh(GEO.shoulder, mats.armor);
    sh.position.set(sx * 4.35, 19.2, 0);
    g.add(sh);
  }
  const neck = new THREE.Mesh(GEO.neck, mats.skin);
  neck.position.y = 20.5;
  g.add(neck);

  // 머리 · 투구
  const head = new THREE.Mesh(GEO.head, mats.skin);
  head.position.y = 23.2;
  g.add(head);
  const helmet = new THREE.Mesh(GEO.helmet, mats.steel);
  helmet.position.y = 23.55;
  g.add(helmet);
  const visor = new THREE.Mesh(GEO.visor, mats.dark);
  visor.position.set(0, 22.7, 2.35);
  g.add(visor);
  const crest = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 3.0), mats.crest);
  crest.position.set(0, 25.3, -0.4);
  g.add(crest);

  // 오른팔 (칼)
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
  blade.position.z = 7.4;
  sword.add(blade);
  armR.add(sword);
  g.add(armR);

  // 왼팔 (방패)
  const armL = new THREE.Group();
  armL.position.set(-4.75, 19.1, 0);
  const upL = new THREE.Mesh(GEO.upperArm, mats.armor);
  upL.position.y = -3.3;
  armL.add(upL);
  const foreL = new THREE.Mesh(GEO.foreArm, mats.skin);
  foreL.position.y = -8.1;
  armL.add(foreL);
  const shield = new THREE.Group();
  shield.position.set(-1.2, -9.4, 2.6);
  const shieldBody = new THREE.Mesh(GEO.shield, mats.shield);
  shieldBody.rotation.x = Math.PI / 2;
  shield.add(shieldBody);
  const boss = new THREE.Mesh(GEO.boss, mats.steel);
  boss.position.z = 0.5;
  shield.add(boss);
  armL.add(shield);
  g.add(armL);

  // 망토 (플레이어) — 등 뒤를 감싸는 반원뿔
  let cape = null;
  if (o.player) {
    cape = new THREE.Mesh(
      new THREE.CylinderGeometry(4.9, 6.6, 12.5, 14, 1, true, Math.PI * 0.6, Math.PI * 0.8),
      new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.85), roughness: 0.92, side: THREE.DoubleSide })
    );
    cape.position.set(0, 13.6, -0.6);
    g.add(cape);
    const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({
      color: col.clone().lerp(new THREE.Color(0xffffff), 0.65), transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.16;
    ring.userData.aura = true;
    g.add(ring);
    // 플레이어 표시 (머리 위 작은 표적)
    const marker = new THREE.Mesh(new THREE.ConeGeometry(1.05, 2.0, 4), new THREE.MeshBasicMaterial({
      color: 0xd6ecff, transparent: true, opacity: 0.42, depthWrite: false
    }));
    marker.rotation.x = Math.PI;
    marker.position.y = 33;
    marker.userData.marker = true;
    g.add(marker);
  }

  // 바닥 그림자
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(19, 19), new THREE.MeshBasicMaterial({
    map: TEX.shadow, transparent: true, depthWrite: false, opacity: 0.85
  }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.12;
  shadow.userData.shadow = true;
  g.add(shadow);

  return { group: g, mats: mats, parts: { legs: legs, torso: torso, head: head, armR: armR, armL: armL, sword: sword, shield: shield, crest: crest } };
}

/* ---------------------------------------------------------------------------
   렌더러 생성
   --------------------------------------------------------------------------- */
function create(opts) {
  const canvas = opts.canvas;
  const cfg = opts.cfg || {};
  const W = cfg.w || 280;
  const H = cfg.h || 600;
  if (!canvas) throw new Error('3D 캔버스가 없습니다');

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
  renderer.toneMappingExposure = 1.12;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1117);
  scene.fog = new THREE.Fog(0x0e1c24, 330, 900);

  const camera = new THREE.PerspectiveCamera(64, 0.46, 1, 1200);
  camera.position.set(0, 110, -150);

  const size = { w: 390, h: 844 };
  const colors = {
    me: colorOf(cfg.me && cfg.me.color, '#3b82f6'),
    enemy: colorOf(cfg.enemy && cfg.enemy.color, '#ef4444')
  };
  const meHex = '#' + colors.me.getHexString();
  const enemyHex = '#' + colors.enemy.getHexString();

  const rand = mulberry32(((cfg.seed || 1) ^ 0x3d7a1f) >>> 0);

  /* --- 조명 --- */
  const hemi = new THREE.HemisphereLight(0xa8c8ff, 0x322a1c, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe3b8, 1.95);
  sun.position.set(80, 165, -60);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x4b7fd8, 0.7);
  rim.position.set(-90, 90, 130);
  scene.add(rim);

  /* --- 땅 --- */
  // 하늘 (그라데이션 돔)
  (function addSky() {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#060a12');
    g.addColorStop(0.55, '#0b1622');
    g.addColorStop(0.82, '#152a3c');
    g.addColorStop(1, '#22384a');
    x.fillStyle = g;
    x.fillRect(0, 0, 8, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    dome.position.y = -30;
    scene.add(dome);
    // 먼 언덕 (전장 밖 실루엣)
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x2a3f4d, roughness: 1, flatShading: true });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rand() * 0.18;
      const rad = 620 + rand() * 130;
      const hgt = 40 + rand() * 55;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(130 + rand() * 90, hgt, 7), hillMat);
      hill.position.set(Math.cos(a) * rad, hgt * 0.4 - 22, Math.sin(a) * rad);
      hill.rotation.y = rand() * 3;
      scene.add(hill);
    }
  })();

  const groundTex = terrainTexture(W, H, cfg.seed || 1, meHex, enemyHex);
  groundTex.center.set(0.5, 0.5);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // 경계 (진영 땅 밖 어두운 테두리 · 말뚝)
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
  const posts = new THREE.InstancedMesh(postGeo, postMat, 22);
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (let k = 0; k < 11; k++) {
      const z = -H / 2 + 20 + (k * (H - 40)) / 10;
      for (const sx of [-1, 1]) {
        m.makeTranslation(sx * (W / 2 - 3), 5, z);
        posts.setMatrixAt(i++, m);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    scene.add(posts);
  }

  // 풀 · 돌 장식 (인스턴스)
  const grass = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.9, 3.4, 4),
    new THREE.MeshStandardMaterial({ color: 0x3c5a38, roughness: 1 }),
    90
  );
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
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
  const pebbles = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1.1, 0),
    new THREE.MeshStandardMaterial({ color: 0x55605e, roughness: 0.9, flatShading: true }),
    36
  );
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < 36; i++) {
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

  /* --- 장애물 (바위 · 천막 · 수레) --- */
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
      // 입구 (어두운 천)
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
  const obstacles = (opts.obstacles || []);
  for (const o of obstacles) {
    obstacleViews.push(addObstacle(o));
  }

  /* --- 진영 깃발 (펄럭이는 천) --- */
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

  // 화톳불 (따뜻한 빛 기둥)
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

  /* --- 유닛 뷰 --- */
  const units = new Map();
  const tmpV = new THREE.Vector3();

  function disposeMats(mats) {
    for (const k in mats) {
      if (mats[k] && mats[k].dispose) mats[k].dispose();
    }
  }

  function addUnit(u, team) {
    const isPlayer = team === 'player';
    const color = team === 'enemy' ? enemyHex : meHex;
    const built = buildSoldier(color, { player: isPlayer });
    built.group.scale.setScalar(isPlayer ? 1.06 : 1);
    scene.add(built.group);
    const view = {
      unit: u, team: team, group: built.group, mats: built.mats, parts: built.parts,
      marker: isPlayer ? built.group.children.filter(function (c) { return c.userData && c.userData.marker; })[0] : null,
      lx: u.x, ly: u.y, speed: 0, phase: rand() * 6.28, bobT: 0
    };
    units.set(u, view);
    return view;
  }

  function removeUnit(view) {
    scene.remove(view.group);
    disposeMats(view.mats);
    units.delete(view.unit);
  }

  const parryGlow = new THREE.Color(0xfff2a8);
  const noGlow = new THREE.Color(0x000000);

  function updateUnit(view, S, dt) {
    const u = view.unit;
    const g = view.group;
    g.position.x = u.x - W / 2;
    g.position.z = u.y - H / 2;
    const yaw = Math.PI / 2 - (u.face || 0);
    g.rotation.y = yaw;

    // 이동 속도 → 걷기/달리기
    const moved = Math.hypot(u.x - view.lx, u.y - view.ly);
    view.lx = u.x; view.ly = u.y;
    const spd = dt > 0 ? moved / (dt / 1000) : 0;
    view.speed = lerp(view.speed, spd, 0.25);
    const run = clamp(view.speed / 110, 0, 1);
    view.phase += (dt / 1000) * (3.6 + run * 10);
    const swing = Math.sin(view.phase) * (0.24 + run * 0.62);
    view.parts.legs[0].rotation.x = swing;
    view.parts.legs[1].rotation.x = -swing;
    g.position.y = Math.abs(Math.sin(view.phase)) * (0.25 + run * 1.1);

    // 부상 · 피격 (맞는 순간 몸이 하얗게 번쩍인다)
    const hurt = u.hit > 0 ? clamp(u.hit / 140, 0, 1) : 0;
    view.mats.armor.emissive.setRGB(hurt * 0.9, hurt * 0.85, hurt * 0.8);

    // 공격 모션
    const p = view.parts;
    let armX = -0.42, armY = 0.26, armLx = -0.12, armLy = -0.2;
    if (view.team === 'player') {
      const sp = S.player;
      if (sp.atkAnim > 0) {
        const t = 1 - clamp(sp.atkAnim / 260, 0, 1);       // 0 → 1
        const e = 1 - Math.pow(1 - t, 2.4);                // 빠르게 휘두르고 천천히 복귀
        armY = 1.45 - 2.95 * e;
        armX = -0.15 - Math.sin(clamp(t, 0, 1) * Math.PI) * 0.9;
      }
      if (sp.guard) {
        armLx = -1.55; armLy = -0.5;
      }
    } else {
      if (u.wind > 0) {
        const w = 1 - clamp(u.wind / 320, 0, 1);
        armX = -0.2 - 1.7 * w;
        armY = 0.9 - 0.5 * w;
      } else if (u.swing > 0) {
        const s = 1 - clamp(u.swing / 180, 0, 1);
        armY = 1.35 - 2.7 * s;
        armX = -0.5;
      }
    }
    p.armR.rotation.x = lerp(p.armR.rotation.x, armX, 0.45);
    p.armR.rotation.y = lerp(p.armR.rotation.y, armY, 0.45);
    p.armL.rotation.x = lerp(p.armL.rotation.x, armLx, 0.3);
    p.armL.rotation.y = lerp(p.armL.rotation.y, armLy, 0.3);

    // 방패 반짝 (패링 직후)
    if (view.team === 'player') {
      const fresh = S.player.guard && S.player.guardT <= 260;
      view.mats.shield.emissive.copy(fresh ? parryGlow : noGlow);
      view.mats.shield.emissiveIntensity = fresh ? 1.6 : 0;
    }

    // 무적 깜빡임
    if (view.team === 'player' && S.invuln > 0) {
      g.visible = Math.sin(S.time / 55) > -0.35;
    } else if (!g.visible) {
      g.visible = true;
    }
    if (view.marker) view.marker.position.y = 33 + Math.sin(S.time / 240) * 1.4;
  }

  /* --- 검기 · 돌진 잔상 · 절단 섬광 --- */
  const slashViews = new Map();
  const trailViews = new Map();
  const cutViews = new Map();

  const SLASH_ARC = 1.3;

  function syncSlashes(S) {
    const live = new Set(S.slashes);
    for (const [sl, v] of slashViews) {
      if (!live.has(sl)) {
        scene.remove(v.group); disposeGroup(v.group);
        if (v.ring) { scene.remove(v.ring); v.ring.geometry.dispose(); v.ring.material.dispose(); }
        slashViews.delete(sl);
      }
    }
    for (const sl of S.slashes) {
      let v = slashViews.get(sl);
      if (!v) {
        const group = new THREE.Group();
        group.position.set(sl.x - W / 2, 16.5, sl.y - H / 2);
        group.rotation.y = -sl.face;
        // 칼자국 크레센트 (가슴 높이에서 회전하며 지나간다)
        const mat = new THREE.MeshBasicMaterial({
          map: TEX.slash, transparent: true, opacity: 1, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        const arc = new THREE.Mesh(new THREE.PlaneGeometry(84, 52), mat);
        arc.rotation.x = -Math.PI / 2 + 0.45;   // 카메라 쪽으로 살짝 기울여 잘 보이게
        const glowMat = new THREE.MeshBasicMaterial({
          color: 0x7fb8ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        const glow = new THREE.Mesh(new THREE.RingGeometry(16, 40, 26, 1, -0.9, 1.8), glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = -0.4;
        const sweep = new THREE.Group();
        sweep.add(arc);
        sweep.add(glow);
        group.add(sweep);
        scene.add(group);
        // 지면을 타고 퍼지는 충격 링
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x9cc8ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(sl.x - W / 2, 0.7, sl.y - H / 2);
        ring.scale.setScalar(22);
        scene.add(ring);
        v = { group: group, sweep: sweep, mats: [mat, glowMat], ring: ring, ringMat: ringMat };
        slashViews.set(sl, v);
      }
      const p = clamp(sl.t / sl.dur, 0, 1);
      const e = 1 - Math.pow(1 - p, 1.8);
      v.sweep.rotation.y = -1.25 + e * 2.5;
      v.mats[0].opacity = (1 - p) * 0.95;
      v.mats[1].opacity = (1 - p) * 0.32;
      v.group.scale.setScalar(0.92 + p * 0.22);
      if (v.ring) {
        v.ring.scale.setScalar(20 + p * 16);
        v.ringMat.opacity = (1 - p) * 0.3;
      }
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

  /* --- 3D 두 동강 (칼 각도 그대로 반으로 자른 조각) --- */
  const pieces = new Map();

  function buildPiece(c) {
    const cut = Number.isFinite(c.cut) ? c.cut : -Math.PI / 2;
    const side = c.side < 0 ? -1 : 1;
    const built = buildSoldier(enemyHex, { player: false });
    const group = built.group;
    // 그림자 · 후광 제거 (조각에는 불필요)
    for (let i = group.children.length - 1; i >= 0; i--) {
      const ch = group.children[i];
      if (ch.userData && (ch.userData.shadow || ch.userData.aura)) {
        group.remove(ch);
        ch.geometry.dispose();
        ch.material.dispose();
      }
    }
    const localPlane = new THREE.Plane(new THREE.Vector3(0, 0, side), 0);
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

    // 잘린 단면 (조각에 붙어 함께 회전)
    const flesh = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 25),
      new THREE.MeshBasicMaterial({
        map: TEX.flesh, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false
      })
    );
    flesh.position.set(0, 12.5, -side * 0.1);
    group.add(flesh);

    // 절단 섬광 (칼날이 지나간 선)
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffe9e6, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(26, 1.4), flashMat);
    flash.position.set(0, 14, 0);
    group.add(flash);

    scene.add(group);
    return {
      obj: group, cut: cut, side: side, localPlane: localPlane, plane: worldPlane,
      mats: mats, flesh: flesh, flash: flash, flashMat: flashMat,
      ox: c.x, oy: c.y, k: 0.5,
      y: 12, vy: 62 + Math.random() * 46, parts: mats.length, opacity: 1
    };
  }

  function disposePiece(p) {
    scene.remove(p.obj);
    for (const m of p.mats) m.dispose();
    p.flesh.geometry.dispose();
    p.flesh.material.dispose();
    p.flash.geometry.dispose();
    p.flash.material.dispose();
  }

  function syncPieces(S, dt) {
    const live = new Set(S.corpses);
    for (const [c, p] of pieces) {
      if (!live.has(c)) { disposePiece(p); pieces.delete(c); }
    }
    for (const c of S.corpses) {
      let p = pieces.get(c);
      if (!p) { p = buildPiece(c); pieces.set(c, p); }
      // 위치 · 회전 (시뮬레이션이 x,y 를 밀어내고, 높이는 여기서 포물선으로)
      p.vy -= 330 * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      if (p.y <= 3.2) { p.y = 3.2; p.vy = Math.abs(p.vy) * 0.34; if (p.vy < 18) p.vy = 0; }
      p.obj.position.set(p.ox + (c.x - p.ox) * p.k - W / 2, p.y, p.oy + (c.y - p.oy) * p.k - H / 2);
      p.obj.rotation.x = c.rot * 0.62;
      p.obj.updateMatrixWorld(true);
      // 절단면은 조각의 로컬 좌표계를 따라간다
      p.plane.copy(p.localPlane).applyMatrix4(p.obj.matrixWorld);

      const left = clamp(c.life / 950, 0, 1);
      const fade = left > 0.72 ? 1 : left / 0.72;
      p.opacity = fade;
      for (const m of p.mats) m.opacity = fade;
      p.flesh.material.opacity = fade * 0.95;
      const flashP = clamp(1 - (950 - c.life) / 170, 0, 1);
      p.flashMat.opacity = flashP * 0.95;
      p.flash.visible = flashP > 0.01;
    }
  }

  /* --- 파티클 (불꽃 · 피) --- */
  const P_MAX = 320;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_MAX * 3);
  const pCol = new Float32Array(P_MAX * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 6, map: TEX.glow, transparent: true, vertexColors: true,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, opacity: 0.95
  });
  const pPoints = new THREE.Points(pGeo, pMat);
  pPoints.frustumCulled = false;
  scene.add(pPoints);
  const pState = new WeakMap();
  const tmpColor = new THREE.Color();

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
        else tmpColor.setRGB(1, 0.45, 0.35);
      } catch (e) { tmpColor.setRGB(1, 0.6, 0.4); }
      const k = a * (p.color && String(p.color).indexOf('120,26,26') >= 0 ? 0.45 : 1.15);
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

  /* --- 카메라 --- */
  let camYaw = (cfg.playerFace != null ? cfg.playerFace : Math.PI / 2);
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const lookNow = new THREE.Vector3();
  let camReady = false;

  function updateCamera(S, dt) {
    const pl = S.player;
    if (!pl) return;
    if (api.debugCamera) {
      camera.position.set(api.debugCamera.x, api.debugCamera.y, api.debugCamera.z);
      camera.lookAt(api.debugCamera.tx, api.debugCamera.ty, api.debugCamera.tz);
      return;
    }
    camYaw += angDiff(pl.face, camYaw) * Math.min(1, (dt / 1000) * 4.2);
    const fx = Math.cos(camYaw), fz = Math.sin(camYaw);
    const px = pl.x - W / 2, pz = pl.y - H / 2;
    const back = 104, up = 118;
    camPos.set(px - fx * back, up, pz - fz * back);
    lookAt.set(px + fx * 62, 4, pz + fz * 62);
    if (!camReady) {
      camera.position.copy(camPos);
      lookNow.copy(lookAt);
      camReady = true;
    } else {
      const k = 1 - Math.exp(-(dt / 1000) * 7.5);
      camera.position.lerp(camPos, k);
      lookNow.lerp(lookAt, k);
    }
    const sh = S.shake || 0;
    if (sh > 0.05) {
      camera.position.x += (Math.random() - 0.5) * sh * 0.35;
      camera.position.y += (Math.random() - 0.5) * sh * 0.35;
    }
    camera.lookAt(lookNow);
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
    // 세로 화면에서도 좌우 시야가 확보되도록 수직 화각 자동 조정
    const wantH = 0.33;                       // 원하는 수평 반각 탄젠트
    const vfov = 2 * Math.atan(wantH / camera.aspect) * 180 / Math.PI;
    camera.fov = clamp(vfov, 56, 84);
    camera.updateProjectionMatrix();
  }

  function render(S, ts) {
    let dt = lastTs ? Math.min(60, ts - lastTs) : 16;
    if (!(dt > 0)) dt = 16;
    lastTs = ts;
    timeSec += dt / 1000;

    // 유닛 동기화
    const seen = new Set();
    const addIfNew = (u, team) => {
      seen.add(u);
      let v = units.get(u);
      if (!v) v = addUnit(u, team);
      updateUnit(v, S, dt);
    };
    if (S.player) addIfNew(S.player, 'player');
    for (const a of S.allies) addIfNew(a, 'ally');
    for (const e of S.enemies) addIfNew(e, 'enemy');
    for (const [u, v] of [...units]) {
      if (!seen.has(u)) removeUnit(v);
    }

    syncSlashes(S);
    syncTrails(S);
    syncCuts(S);
    syncPieces(S, dt);
    syncParticles(S, dt);
    updateBanners(timeSec);
    updateCamera(S, dt);

    renderer.render(scene, camera);
    frames++;

    // 적응 해상도 (느린 기기 보호 · 테스트에서는 __TW_KEEP_RES__ 로 고정)
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
    for (const v of [...units.values()]) removeUnit(v);
    for (const [, v] of slashViews) disposeGroup(v.group);
    slashViews.clear();
    for (const [, v] of trailViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    trailViews.clear();
    for (const [, v] of cutViews) { v.mesh.geometry.dispose(); v.mesh.material.dispose(); }
    cutViews.clear();
    for (const [, p] of pieces) disposePiece(p);
    pieces.clear();
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
        units: units.size,
        pieces: pieces.size,
        slashes: slashViews.size,
        trails: trailViews.size,
        cuts: cutViews.size,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        pixelRatio: renderer.getPixelRatio(),
        canvas: { w: canvas.width, h: canvas.height, cw: size.w, ch: size.h },
        camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z, fov: camera.fov }
      };
    },
    piecesInfo: function () {
      const out = [];
      for (const [c, p] of pieces) {
        out.push({
          cut: p.cut,
          side: p.side,
          x: p.obj.position.x + W / 2,
          y: p.obj.position.z + H / 2,
          height: p.obj.position.y,
          opacity: p.opacity,
          parts: p.parts,
          rot: c.rot,
          plane: { nx: p.plane.normal.x, ny: p.plane.normal.y, nz: p.plane.normal.z, c: p.plane.constant }
        });
      }
      return out;
    },
    unitsInfo: function () {
      const out = [];
      for (const [u, v] of units) {
        out.push({ team: v.team, x: u.x, y: u.y, face: u.face, yaw: v.group.rotation.y, speed: v.speed });
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
