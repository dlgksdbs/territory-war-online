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

  /* 구름 — 지평선에 낮게 깔린 구름층 + 높이 떠 있는 권운, 아주 느리게 흐른다 */
  const cloudMap = cloudTexture();
  const cloudMapHi = cloudTexture(true);
  const clouds = [];
  // 지평선 구름층: 크고 낮게, 노을빛을 받아 아래쪽이 붉게 물든다
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * TAU + rng() * 0.18;
    const r = 250 + rng() * 120;
    const low = rng() < 0.62;
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: low ? cloudMap : cloudMapHi, transparent: true,
      opacity: low ? 0.42 + rng() * 0.34 : 0.16 + rng() * 0.2,
      depthWrite: false, fog: false,
      color: low ? (rng() < 0.5 ? 0xffcfa8 : 0xf0c6bc) : 0xa9b8d4
    }));
    m.position.set(Math.cos(a) * r, low ? 22 + rng() * 26 : 78 + rng() * 70, Math.sin(a) * r);
    const s = low ? 150 + rng() * 210 : 190 + rng() * 260;
    m.scale.set(s, s * (low ? 0.4 : 0.28), 1);
    m.renderOrder = -8;
    scene.add(m);
    clouds.push({ m, speed: 0.35 + rng() * 0.7, a, r });
  }

  /* ------------------------------------------------------ 원경 산맥 */
  // 원기 원근: 먼 능선일수록 하늘색에 가깝게, 봉우리에는 눈·안개 하이라이트
  const ridgeShaders = [];
  const makeRidgeMat = (base, top, haze) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(base) },
        uTop: { value: new THREE.Color(top) },
        uHaze: { value: haze },
        uY0: { value: -10 }, uY1: { value: 120 }
      },
      vertexShader: `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
uniform vec3 uBase; uniform vec3 uTop; uniform float uHaze;
varying vec3 vW;
void main(){
  float h = clamp((vW.y + 6.0) / 96.0, 0.0, 1.0);
  vec3 col = mix(uBase, uTop, pow(h, 0.75));
  // 지평선 쪽은 더 뿌옇게(대기 원근)
  col = mix(col, vec3(0.86, 0.66, 0.55), clamp(uHaze * (1.0 - h * 0.85), 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`,
      fog: false,
      side: THREE.DoubleSide
    });
    ridgeShaders.push(mat);
    return mat;
  };
  const ridgeMats = [
    makeRidgeMat(0xa08d87, 0xd3b29a, 0.55),   // 가장 먼 능선 — 안개에 잠김
    makeRidgeMat(0x8a8195, 0xb99fa4, 0.32),   // 중간 능선
    makeRidgeMat(0x5b5470, 0x877a8f, 0.12)    // 가까운 능선
  ];
  // 봉우리 능선을 이어 붙인 한 장의 산맥 띠 — 종이 삼각형이 아니라 부드러운 실루엣
  const buildRidge = (layer) => {
    const R = 300 + layer * 62;
    const segs = 240;
    const pos = new Float32Array((segs + 1) * 2 * 3);
    const idx = [];
    const baseY = -26;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * TAU;
      const nx = Math.cos(a), nz = Math.sin(a);
      // 여러 주기의 fbm으로 봉우리·고개를 만든다
      const n1 = fbm(nx * 2.3 + layer * 7.1, nz * 2.3 - layer * 3.7, 4);
      const n2 = fbm(nx * 6.1 - layer * 2.3, nz * 6.1 + layer * 5.3, 3);
      const peak = Math.pow(clamp(n1 * 0.85 + n2 * 0.35, 0, 1), 1.15);
      const h = 20 + peak * (layer === 0 ? 128 : layer === 1 ? 104 : 78) + Math.sin(a * 3 + layer) * 5;
      const p0Y = layer === 2 ? baseY : baseY - layer * 6;
      pos[i * 6 + 0] = nx * R; pos[i * 6 + 1] = p0Y; pos[i * 6 + 2] = nz * R;
      pos[i * 6 + 3] = nx * R; pos[i * 6 + 4] = h; pos[i * 6 + 5] = nz * R;
      if (i < segs) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, ridgeMats[layer]);
    m.frustumCulled = false;
    m.renderOrder = -7 + layer;
    return m;
  };
  for (let layer = 0; layer < 3; layer++) scene.add(buildRidge(layer));

  /* 원경 성채 — 돌로 쌓은 성곽: 주성·원형 탑·성가퀴·불빛 창·횃불·깃발 */
  const castle = new THREE.Group();
  const castleStone = stoneMaps(512);
  const cTex = castleStone.albedo.clone();
  cTex.wrapS = cTex.wrapT = THREE.RepeatWrapping;
  cTex.repeat.set(7, 5);
  cTex.needsUpdate = true;
  const cNor = castleStone.normal.clone();
  cNor.wrapS = cNor.wrapT = THREE.RepeatWrapping;
  cNor.repeat.set(7, 5);
  cNor.needsUpdate = true;
  const castleMat = new THREE.MeshStandardMaterial({
    map: cTex, normalMap: cNor, normalScale: new THREE.Vector2(1.1, 1.1),
    color: 0xbdb0a1, emissive: 0x2e231b, emissiveIntensity: 0.9,
    roughness: 0.94, metalness: 0.02, envMapIntensity: 0.45
  });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x353039, roughness: 0.7, metalness: 0.1, envMapIntensity: 0.6 });
  const darkStoneMat = new THREE.MeshStandardMaterial({ map: cTex, color: 0x93887c, emissive: 0x201812, emissiveIntensity: 0.85, roughness: 0.95, metalness: 0.02 });

  // 성벽 + 성가퀴(흉벽)
  const curtain = new THREE.Mesh(new THREE.BoxGeometry(150, 24, 16), castleMat);
  curtain.position.set(0, 11, 0);
  castle.add(curtain);
  const merlonGeo = new THREE.BoxGeometry(3.0, 2.6, 17.6);
  const merlons = new THREE.InstancedMesh(merlonGeo, castleMat, 46);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < 46; i++) {
    mm.makeTranslation(-72 + i * 3.2, 24.2, 0);
    merlons.setMatrixAt(i, mm);
  }
  merlons.instanceMatrix.needsUpdate = true;
  castle.add(merlons);
  // 벽 하단 어깨(경사면)
  const batter = new THREE.Mesh(new THREE.BoxGeometry(154, 4.4, 20), darkStoneMat);
  batter.position.set(0, -0.2, 0);
  castle.add(batter);

  // 주성(키프)
  const keep = new THREE.Mesh(new THREE.BoxGeometry(46, 44, 38), castleMat);
  keep.position.set(-4, 21, -12);
  castle.add(keep);
  const keepMerlon = new THREE.InstancedMesh(new THREE.BoxGeometry(3.0, 2.8, 4.2), castleMat, 28);
  for (let i = 0; i < 28; i++) {
    if (i < 14) mm.makeTranslation(-26 + i * 3.4, 44, -12 + 17);   // 앞쪽 흉벽
    else mm.makeTranslation(-26 + (i - 14) * 3.4, 44, -12 - 17);   // 뒤쪽 흉벽
    keepMerlon.setMatrixAt(i, mm);
  }
  keepMerlon.instanceMatrix.needsUpdate = true;
  castle.add(keepMerlon);

  // 원형 탑 — 기단이 넓고 위로 좁아지는 성벽 탑
  const towerPos = [-78, -54, 46, 70, -4];
  towerPos.forEach((tx, ti) => {
    const zz = ti === 4 ? -34 : 2;
    const h = ti === 4 ? 72 : 50 + rng() * 12;
    const rad = ti === 4 ? 9.5 : 7 + rng() * 2;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.88, rad * 1.12, h, 12), castleMat);
    t.position.set(tx, h / 2 - 1, zz);
    castle.add(t);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.02, rad * 1.02, 1.8, 12), darkStoneMat);
    ring.position.set(tx, h - 4, zz);
    castle.add(ring);
    // 성가퀴
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU;
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 1.2), castleMat);
      b.position.set(tx + Math.cos(a) * rad * 1.05, h + 0.6, zz + Math.sin(a) * rad * 1.05);
      b.rotation.y = -a;
      castle.add(b);
    }
    // 뾰족 지붕 + 깃대
    const roof = new THREE.Mesh(new THREE.ConeGeometry(rad * 1.14, 26 + ti * 2, 12), roofMat);
    roof.position.set(tx, h + 14, zz);
    castle.add(roof);
    if (ti < 3) {
      const poleM = new THREE.MeshBasicMaterial({ color: 0x2a2622 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12, 6), poleM);
      pole.position.set(tx, h + 30, zz);
      castle.add(pole);
    }
  });
  // 성문 — 거대한 아치와 철문
  const gate = new THREE.Mesh(new THREE.BoxGeometry(18, 20, 3), new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.8, metalness: 0.35 }));
  gate.position.set(0, 8, 8.6);
  castle.add(gate);
  const gateArch = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 3, 16, 1, false, 0, Math.PI), castleMat);
  gateArch.rotation.z = 0; gateArch.rotation.x = Math.PI / 2;
  gateArch.position.set(0, 18, 8.6); castle.add(gateArch);

  // 불빛 창 (인스턴스) — 따뜻한 등불
  const winGeo = new THREE.PlaneGeometry(1.9, 3.0);
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffb469, transparent: true, opacity: 0.95 });
  const wins = new THREE.InstancedMesh(winGeo, winMat, 90);
  let wi = 0;
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 7; i++) {
      mm.makeTranslation(-24 + i * 6.4, 14 + row * 11, -12 + 19.1);
      if (wi < 90) wins.setMatrixAt(wi++, mm);
    }
  }
  for (let i = 0; i < 9; i++) {
    mm.makeTranslation(-66 + i * 15.5, 12 + (i % 3) * 4, 8.1);
    if (wi < 90) wins.setMatrixAt(wi++, mm);
  }
  for (; wi < 90; wi++) wins.setMatrixAt(wi, new THREE.Matrix4().makeScale(0, 0, 0));
  wins.instanceMatrix.needsUpdate = true;
  castle.add(wins);
  out.castleWindows = wins;
  out.castleWindowMat = winMat;

  // 성벽 위 횃불 불빛
  const cFlame = flameTexture();
  for (let i = 0; i < 8; i++) {
    const fx0 = -60 + i * 17;
    const f = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cFlame, color: 0xffa452, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.85, fog: false
    }));
    f.position.set(fx0, 26.6, 8.6);
    f.scale.set(3.4, 5.0, 1);
    castle.add(f);
    const gl = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff8b3a, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.34, fog: false
    }));
    gl.position.copy(f.position);
    gl.scale.set(13, 13, 1);
    castle.add(gl);
  }

  // 탑 위에 나부끼는 깃발
  const castleFlagTex = bannerTexture(0x8f2b2b, 'KING');
  out.castleFlags = [];
  [[-78, 52], [46, 56], [-4, 74]].forEach(([tx, ty], i) => {
    const fg = new THREE.PlaneGeometry(9, 14, 8, 10);
    const cloth = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({
      map: castleFlagTex, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.02, envMapIntensity: 0.3
    }));
    cloth.position.set(tx + 4.6, ty + 21, i === 2 ? -34 : 2);
    castle.add(cloth);
    out.castleFlags.push({ cloth, base: fg.attributes.position.array.slice(), ph: rng() * TAU });
  });

  castle.position.set(-26, -6, 232);
  castle.rotation.y = 0.04;
  castle.scale.setScalar(1.06);
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
  // 스폰 지점(0, -21.5) 정면 시야를 가리지 않도록 중앙 축에서 비켜 배치한다
  const torchSpots = [
    { x: 14.5, z: -10 }, { x: -14.5, z: -10 }, { x: 14.5, z: 10 }, { x: -14.5, z: 10 },
    { x: 9.5, z: -16.5 }, { x: -9.5, z: -16.5 }
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
    if (i < 1) {
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
    // 성벽 깃발도 같은 바람에 나부낀다
    if (out.castleFlags) {
      for (const b of out.castleFlags) {
        const arr = b.cloth.geometry.attributes.position.array;
        const base = b.base;
        const n = arr.length / 3;
        for (let i = 0; i < n; i++) {
          const x = base[i * 3], y = base[i * 3 + 1];
          const w = (x + 4.5) / 9;
          arr[i * 3 + 2] = (Math.sin(t * 2.1 + b.ph + y * 0.9 + w * 2.6) * 0.5 + Math.sin(t * 3.7 + b.ph + x * 1.7) * 0.16) * w;
          arr[i * 3 + 1] = y - w * w * 0.5;
        }
        b.cloth.geometry.attributes.position.needsUpdate = true;
        b.cloth.geometry.computeVertexNormals();
      }
    }
    // 창문 등불이 느리게 흔들린다
    if (out.castleWindowMat) {
      out.castleWindowMat.opacity = 0.82 + Math.sin(t * 1.7) * 0.07 + Math.sin(t * 3.9 + 1.2) * 0.05;
      if (out.castleWindows) out.castleWindows.material.color.setHSL(0.075, 0.85, 0.52 + Math.sin(t * 0.9) * 0.05);
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
