/* =============================================================================
   world.js — 전장(아레나) 세계: 젖은 흙·돌바닥, 황혼의 하늘, 원경 성채·산맥,
   횃불·깃발·부서진 기둥, PMREM 환경 반사, 역동적 조명과 그림자.
   ============================================================================= */
import * as THREE from 'three';
import { terrainMaps, stoneMaps, woodMaps, bannerTexture, glowTexture, cloudTexture, runeTexture, blobTexture, flameTexture } from './textures.js';
import { mulberry32, clamp, lerp, fbm, noise2, TAU } from './util.js';

const SUN_DIR = new THREE.Vector3(-0.78, 0.42, 0.34).normalize();

function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  // 전투 공간(반경 46m)은 평평하게, 바깥은 완만한 둔덕과 언덕
  const flat = 1 - clamp((r - 42) / 26, 0, 1);
  const rim = Math.max(0, (r - 42)) * 0.055;
  const hills = fbm(x * 0.013 + 11, z * 0.013 - 7, 4) * 3.4;
  const bumps = (fbm(x * 0.11, z * 0.11, 3) - 0.5) * 0.34;
  return (hills + rim) * (1 - flat) + bumps * (0.35 + 0.65 * (1 - flat)) - 0.02;
}

/* 하늘 그라디언트 셰이더 */
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 sunColor;
uniform vec3 sunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  float t = pow(clamp((h - 0.5) * 2.0, 0.0, 1.0), 0.72);
  vec3 col = mix(horizonColor, topColor, t);
  // 지평선 근처 따뜻한 띠
  float band = exp(-pow(abs(d.y) * 7.0, 1.6));
  col += vec3(1.0, 0.46, 0.18) * band * 0.30;
  // 해 주변 광휘
  float sd = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * pow(sd, 22.0) * 0.95;
  col += sunColor * pow(sd, 4.0) * 0.18;
  // 지평선 아래는 어둡게
  col = mix(col, vec3(0.035, 0.045, 0.06), smoothstep(0.0, -0.14, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildWorld(scene, renderer) {
  const rng = mulberry32(2024);
  const out = { sun: null, key: null, torches: [], banners: [], flames: [], update: null, terrain: null };

  /* ---------------------------------------------------------------- 하늘 */
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x1d3557) },
      horizonColor: { value: new THREE.Color(0xe9a271) },
      sunColor: { value: new THREE.Color(0xffd39a) },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(430, 40, 24), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  /* 해 광휘 스프라이트 */
  const glowTex = glowTexture('rgba(255,255,245,1)', 'rgba(255,190,110,0.28)');
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, fog: false, opacity: 0.72
  }));
  sunSprite.scale.set(105, 105, 1);
  sunSprite.position.copy(SUN_DIR).multiplyScalar(360);
  sunSprite.renderOrder = -9;
  scene.add(sunSprite);

  /* 구름 — 하늘에 떠서 아주 느리게 흐른다 */
  const cloudMap = cloudTexture();
  const clouds = [];
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudMap, transparent: true, opacity: 0.25 + rng() * 0.4,
      depthWrite: false, fog: false, color: i % 3 === 0 ? 0xffd8b0 : 0xd8e4f4
    }));
    const a = rng() * TAU, r = 200 + rng() * 160;
    m.position.set(Math.cos(a) * r, 46 + rng() * 90, Math.sin(a) * r);
    const s = 90 + rng() * 170;
    m.scale.set(s, s * 0.55, 1);
    m.renderOrder = -8;
    scene.add(m);
    clouds.push({ m, speed: 0.55 + rng() * 0.9, a, r });
  }

  /* ------------------------------------------------------ 원경 산맥 */
  const ridgeMat = new THREE.MeshBasicMaterial({ color: 0x6a6f86, fog: true, transparent: true, opacity: 0.9 });
  const ridgeMat2 = new THREE.MeshBasicMaterial({ color: 0x4a5068, fog: true, transparent: true, opacity: 0.75 });
  for (let layer = 0; layer < 2; layer++) {
    const group = new THREE.Group();
    const R = 240 + layer * 90;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU + layer * 0.11;
      const h = 34 + rng() * 70 + layer * 26;
      const w = 40 + rng() * 70;
      const geo = new THREE.ConeGeometry(w, h, 4 + ((i + layer) % 3), 1);
      // 뾰족한 산이 아니라 봉우리 능선처럼: 윗부분을 눌러 비스듬히
      const m = new THREE.Mesh(geo, layer === 0 ? ridgeMat : ridgeMat2);
      m.position.set(Math.cos(a) * R, h * 0.5 - 8, Math.sin(a) * R);
      m.rotation.y = rng() * TAU;
      m.scale.z = 0.55 + rng() * 0.5;
      group.add(m);
    }
    scene.add(group);
  }

  /* 원경 성채 — 안개 속 실루엣 + 불빛 창 */
  const castle = new THREE.Group();
  const castleMat = new THREE.MeshBasicMaterial({ color: 0x3c3a4b, fog: true });
  const keep = new THREE.Mesh(new THREE.BoxGeometry(48, 54, 40), castleMat);
  keep.position.y = 27; castle.add(keep);
  for (let i = 0; i < 9; i++) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(6 + rng() * 4, 7 + rng() * 4, 40 + rng() * 46, 8), castleMat);
    t.position.set(-46 + i * 12 + rng() * 4, 26 + rng() * 16, (rng() - 0.5) * 28);
    castle.add(t);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(9, 22, 8), new THREE.MeshBasicMaterial({ color: 0x2a2738, fog: true }));
    roof.position.set(t.position.x, t.position.y + 20 + 11, t.position.z);
    castle.add(roof);
  }
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffb060, fog: true });
  for (let i = 0; i < 34; i++) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.6), winMat);
    w.position.set(-40 + rng() * 90, 10 + rng() * 52, 20.4);
    castle.add(w);
  }
  castle.position.set(-20, -3, 158);
  castle.rotation.y = 0.06;
  scene.add(castle);

  /* ---------------------------------------------- PMREM 환경 반사맵 */
  const envScene = new THREE.Scene();
  const envGeo = new THREE.SphereGeometry(60, 24, 16);
  const envMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x36567f) },
      horizonColor: { value: new THREE.Color(0xf0a878) },
      sunColor: { value: new THREE.Color(0xffe0b0) },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide
  });
  envScene.add(new THREE.Mesh(envGeo, envMat));
  const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(50, 24),
    new THREE.MeshBasicMaterial({ color: 0x4a3626 }));
  groundDisc.rotation.x = -Math.PI / 2; groundDisc.position.y = -1.2;
  envScene.add(groundDisc);
  const envSun = new THREE.Mesh(new THREE.SphereGeometry(4.5, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff0cc }));
  envSun.position.copy(SUN_DIR).multiplyScalar(48);
  envScene.add(envSun);
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  scene.environment = envRT.texture;
  pmrem.dispose();

  /* ------------------------------------------------------------- 안개 */
  scene.fog = new THREE.FogExp2(0xb69a86, 0.0022);

  /* ------------------------------------------------------------- 조명 */
  const hemi = new THREE.HemisphereLight(0xaec8ee, 0x6b4c30, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffd2a4, 2.9);
  key.position.copy(SUN_DIR).multiplyScalar(70);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 190;
  key.shadow.camera.left = -46;
  key.shadow.camera.right = 46;
  key.shadow.camera.top = 46;
  key.shadow.camera.bottom = -46;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.035;
  key.shadow.radius = 2.2;
  scene.add(key);
  scene.add(key.target);
  out.key = key;

  const fill = new THREE.DirectionalLight(0x8fb6e8, 0.75);
  fill.position.set(-40, 30, -50);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffa060, 0.8);
  rim.position.set(30, 12, -60);
  scene.add(rim);

  /* ------------------------------------------------------------ 지면 */
  const maps = terrainMaps(1024);
  maps.albedo.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const seg = 150;
  const tGeo = new THREE.PlaneGeometry(200, 200, seg, seg);
  tGeo.rotateX(-Math.PI / 2);
  const pos = tGeo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const cDirt = new THREE.Color(0xbfa88b);
  const cMud = new THREE.Color(0x8e7458);
  const cGrass = new THREE.Color(0xaab48c);
  const cStone = new THREE.Color(0xc0b8aa);
  const tmpC = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    const r = Math.hypot(x, z);
    const n = fbm(x * 0.07 + 3, z * 0.07 - 5, 3);
    if (r < 11) tmpC.copy(cMud).lerp(cDirt, n);
    else if (r < 40) tmpC.copy(cDirt).lerp(cMud, n * 0.8);
    else if (r < 51) tmpC.copy(cStone).lerp(cDirt, n * 0.7);
    else tmpC.copy(cGrass).lerp(cDirt, clamp(n * 0.7 + (r - 55) * 0.004, 0, 0.6));
    tmpC.offsetHSL(0, (n - 0.5) * 0.05, (n - 0.5) * 0.08);
    col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
  }
  tGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.32, 0.32),
    roughnessMap: maps.rough,
    roughness: 0.9,
    metalness: 0.04,
    vertexColors: true,
    envMapIntensity: 0.45,
    color: 0xffffff
  });
  const terrain = new THREE.Mesh(tGeo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);
  out.terrain = terrain;

  /* 아레나 바닥 원형 석판 테두리 (발디딤) */
  const stone = stoneMaps(512);
  const ringMat = new THREE.MeshStandardMaterial({
    map: stone.albedo, normalMap: stone.normal, roughness: 0.82, metalness: 0.08,
    color: 0x8b877e, envMapIntensity: 0.7
  });
  const dais = new THREE.Mesh(new THREE.RingGeometry(11.4, 12.6, 96, 2), ringMat);
  dais.rotation.x = -Math.PI / 2; dais.position.y = 0.015;
  dais.receiveShadow = true;
  scene.add(dais);

  /* ----------------------------------------------------- 기둥·폐허 */
  const ruinMat = new THREE.MeshStandardMaterial({
    map: stone.albedo, normalMap: stone.normal, roughness: 0.86, metalness: 0.06,
    color: 0x9a958b, envMapIntensity: 0.75
  });
  const pillarGeo = new THREE.CylinderGeometry(0.62, 0.74, 6.4, 12, 4);
  const capGeo = new THREE.BoxGeometry(1.5, 0.42, 1.5);
  const baseGeo = new THREE.BoxGeometry(1.8, 0.4, 1.8);
  const pillarPositions = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU + 0.12;
    const r = 33 + (i % 3) * 5.5;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 4 && z > 0) continue;
    pillarPositions.push({ x, z, a, broken: rng() < 0.45, h: 0.4 + rng() * 0.8 });
  }
  for (const p of pillarPositions) {
    const g = new THREE.Group();
    const h = p.broken ? 2.2 + rng() * 3.4 : 6.4;
    const shaft = new THREE.Mesh(pillarGeo, ruinMat);
    shaft.scale.y = h / 6.4;
    shaft.position.y = h / 2;
    shaft.castShadow = true; shaft.receiveShadow = true;
    g.add(shaft);
    if (!p.broken) {
      const cap = new THREE.Mesh(capGeo, ruinMat);
      cap.position.y = h + 0.16; cap.castShadow = true; cap.receiveShadow = true;
      g.add(cap);
    }
    const base = new THREE.Mesh(baseGeo, ruinMat);
    base.position.y = 0.2; base.castShadow = true; base.receiveShadow = true;
    g.add(base);
    g.position.set(p.x, terrainHeight(p.x, p.z), p.z);
    g.rotation.y = rng() * TAU;
    g.rotation.z = p.broken ? (rng() - 0.5) * 0.05 : 0;
    scene.add(g);
  }
  /* 쓰러진 기둥 조각들 */
  for (let i = 0; i < 12; i++) {
    const a = rng() * TAU, r = 30 + rng() * 22;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const g = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.64, 2 + rng() * 3, 10, 1, false), ruinMat);
    seg.rotation.z = Math.PI / 2;
    seg.position.y = 0.6;
    seg.castShadow = true; seg.receiveShadow = true;
    g.add(seg);
    g.position.set(x, terrainHeight(x, z), z);
    g.rotation.y = rng() * TAU;
    scene.add(g);
  }

  /* 성벽 파편 (양옆) */
  for (let side = -1; side <= 1; side += 2) {
    const wall = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const w = 4 + rng() * 3;
      const h = 2 + rng() * 4.5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.4), ruinMat);
      b.position.set(-22 + i * 5.4 + rng(), h / 2 - 0.2, (rng() - 0.5) * 1.6);
      b.rotation.y = (rng() - 0.5) * 0.12;
      b.castShadow = true; b.receiveShadow = true;
      wall.add(b);
    }
    wall.position.set(side * 3, 0, side * 56);
    wall.rotation.y = side * 0.04;
    scene.add(wall);
  }

  /* ------------------------------------------------------ 바위·풀 */
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x77716a, roughness: 0.95, metalness: 0.03, flatShading: true, envMapIntensity: 0.5 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 140);
  rocks.castShadow = true; rocks.receiveShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i < 140; i++) {
    const a = rng() * TAU, r = 8 + Math.pow(rng(), 0.6) * 62;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = 0.16 + Math.pow(rng(), 2) * 1.5;
    pv.set(x, terrainHeight(x, z) + s * 0.32, z);
    q.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
    sc.set(s * (0.8 + rng() * 0.7), s * (0.55 + rng() * 0.5), s * (0.8 + rng() * 0.7));
    m4.compose(pv, q, sc);
    rocks.setMatrixAt(i, m4);
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  /* 풀 포기 — 바깥 지역에만 */
  const bladeGeo = new THREE.PlaneGeometry(0.5, 0.62);
  bladeGeo.translate(0, 0.31, 0);
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0x6d7c46, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    alphaTest: 0.35, transparent: false, envMapIntensity: 0.4,
    map: (() => {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const cx = cv.getContext('2d'); cx.clearRect(0, 0, 64, 64);
      for (let i = 0; i < 22; i++) {
        cx.strokeStyle = `rgba(${(90 + Math.random() * 70) | 0},${(110 + Math.random() * 60) | 0},${(50 + Math.random() * 40) | 0},0.95)`;
        cx.lineWidth = 1 + Math.random() * 2;
        cx.beginPath();
        const bx = 8 + Math.random() * 48;
        cx.moveTo(bx, 64);
        cx.quadraticCurveTo(bx + (Math.random() - 0.5) * 20, 34, bx + (Math.random() - 0.5) * 30, 6 + Math.random() * 18);
        cx.stroke();
      }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
    })()
  });
  const tufts = new THREE.InstancedMesh(bladeGeo, grassMat, 420);
  const tuftData = [];
  for (let i = 0; i < 420; i++) {
    const a = rng() * TAU, r = 46 + rng() * 34;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pv.set(x, terrainHeight(x, z), z);
    q.setFromEuler(new THREE.Euler(0, rng() * TAU, 0));
    const s = 0.7 + rng() * 1.5;
    sc.set(s, s, s);
    m4.compose(pv, q, sc);
    tufts.setMatrixAt(i, m4);
    tuftData.push({ x, z, ph: rng() * TAU });
  }
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);

  /* ------------------------------------------------------- 깃발 */
  const bannerTexA = bannerTexture(0x2f6f9e, 'ALLY');
  const bannerTexB = bannerTexture(0x8f2b2b, 'ENEMY');
  for (let i = 0; i < 10; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const ang = (Math.floor(i / 2) / 5) * 1.5 - 0.75;
    const x = Math.sin(ang) * 46 * side;
    const z = side > 0 ? -42 + Math.abs(ang) * 6 : 42 - Math.abs(ang) * 6;
    const gy = terrainHeight(x, z);
    const grp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 6.6, 8),
      new THREE.MeshStandardMaterial({ map: woodMaps().map, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.4 }));
    pole.position.y = 3.3; pole.castShadow = true;
    grp.add(pole);
    const finial = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.6, 6),
      new THREE.MeshStandardMaterial({ color: 0xd8b056, metalness: 1, roughness: 0.28, envMapIntensity: 1.4 }));
    finial.position.y = 6.8; grp.add(finial);
    const bg = new THREE.PlaneGeometry(1.7, 2.5, 8, 10);
    const cloth = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({
      map: side > 0 ? bannerTexA : bannerTexB, side: THREE.DoubleSide, roughness: 0.92,
      metalness: 0.02, envMapIntensity: 0.35
    }));
    cloth.position.set(0.86, 5.2, 0);
    cloth.castShadow = true;
    grp.add(cloth);
    grp.position.set(x, gy, z);
    grp.rotation.y = side > 0 ? 0.2 : Math.PI - 0.2;
    scene.add(grp);
    out.banners.push({ cloth, base: bg.attributes.position.array.slice(), ph: rng() * TAU });
  }

  /* ------------------------------------------------------- 횃불 */
  const flameMap = flameTexture();
  const torchSpots = [
    { x: 14.5, z: -10 }, { x: -14.5, z: -10 }, { x: 14.5, z: 10 }, { x: -14.5, z: 10 },
    { x: 0, z: -17 }, { x: 0, z: 17 }
  ];
  torchSpots.forEach((t, i) => {
    const gy = terrainHeight(t.x, t.z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 1.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.9, metalness: 0.1 }));
    post.position.set(t.x, gy + 0.95, t.z);
    post.castShadow = true;
    scene.add(post);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.2, 0.34, 10),
      new THREE.MeshStandardMaterial({ color: 0x4a3a28, metalness: 0.85, roughness: 0.45, envMapIntensity: 1.1 }));
    bowl.position.set(t.x, gy + 1.9, t.z);
    bowl.castShadow = true;
    scene.add(bowl);

    for (let k = 0; k < 2; k++) {
      const f = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameMap, color: k === 0 ? 0xffb04a : 0xff6a1a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9
      }));
      f.position.set(t.x + (k - 0.5) * 0.1, gy + 2.15, t.z);
      const s = k === 0 ? 1.15 : 0.8;
      f.scale.set(s, s * 1.5, 1);
      f.renderOrder = 3;
      scene.add(f);
      out.flames.push({ s: f, base: s, ph: rng() * TAU, x: f.position.x, y: gy + 2.15, z: t.z });
    }
    if (i < 2) {
      const light = new THREE.PointLight(0xff8a3a, 22, 17, 2);
      light.position.set(t.x, gy + 2.3, t.z);
      scene.add(light);
      out.torches.push({ light, base: 22, ph: rng() * TAU });
    }
    // 불티
    if (i < 3) {
      const g = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xff7a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6
      }));
      g.position.set(t.x, gy + 2.1, t.z);
      g.scale.set(2.6, 2.6, 1);
      scene.add(g);
      out.flames.push({ s: g, base: 2.6, ph: rng() * TAU, x: t.x, y: gy + 2.1, z: t.z, glow: true });
    }
  });

  /* 룬 제단 (가운데) — 마법사 스폰 지점 장식 */
  const runeMat = new THREE.MeshBasicMaterial({
    map: runeTexture(), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.5, color: 0x9fdcff
  });
  const rune = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), runeMat);
  rune.rotation.x = -Math.PI / 2;
  rune.position.y = 0.03;
  scene.add(rune);
  out.rune = rune;

  /* 접지 그림자 (유닛용) — 별도 모듈에서 사용할 텍스처 */
  out.blobTex = blobTexture();

  /* 하늘 돔은 카메라를 따라온다 */
  const tmpV = new THREE.Vector3();
  out.update = (dt, t, camPos) => {
    sky.position.copy(camPos);
    sunSprite.position.copy(camPos).addScaledVector(SUN_DIR, 360);
    for (const cl of clouds) {
      cl.a += dt * 0.0022 * cl.speed;
      cl.m.position.x = camPos.x + Math.cos(cl.a) * cl.r;
      cl.m.position.z = camPos.z + Math.sin(cl.a) * cl.r;
    }
    for (const f of out.flames) {
      const fl = 0.82 + Math.sin(t * 9 + f.ph) * 0.1 + Math.sin(t * 21 + f.ph * 2) * 0.06;
      f.s.scale.set(f.base * fl, f.base * (f.glow ? fl : 1.5 * fl), 1);
      f.s.position.x = f.x + Math.sin(t * 3.1 + f.ph) * 0.05;
      f.s.position.y = f.y + (f.glow ? 0 : Math.sin(t * 6 + f.ph) * 0.05);
    }
    for (const tr of out.torches) {
      tr.light.intensity = tr.base * (0.82 + Math.sin(t * 11 + tr.ph) * 0.1 + Math.sin(t * 27 + tr.ph * 3) * 0.08);
    }
    for (const b of out.banners) {
      const arr = b.cloth.geometry.attributes.position.array;
      const base = b.base;
      const n = arr.length / 3;
      for (let i = 0; i < n; i++) {
        const x = base[i * 3], y = base[i * 3 + 1];
        const w = (x + 0.85) / 1.7;
        const wave = Math.sin(t * 2.4 + b.ph + y * 1.1 + w * 2.4) * 0.16 * w + Math.sin(t * 4.1 + b.ph + x * 3) * 0.04 * w;
        arr[i * 3 + 2] = wave;
        arr[i * 3] = x * (1 - w * 0.02) + w * 0.03;
      }
      b.cloth.geometry.attributes.position.needsUpdate = true;
      b.cloth.geometry.computeVertexNormals();
    }
    runeMat.opacity = 0.34 + Math.sin(t * 1.6) * 0.1;
    rune.rotation.z = t * 0.06;
    // 그림자 카메라를 플레이어 근처로 (원거리 해상도 확보)
    if (camPos) {
      key.target.position.set(camPos.x, 0, camPos.z);
      key.position.set(camPos.x + SUN_DIR.x * 70, SUN_DIR.y * 70, camPos.z + SUN_DIR.z * 70);
      key.target.updateMatrixWorld();
    }
    return { tmpV };
  };

  out.sunDir = SUN_DIR;
  return out;
}
