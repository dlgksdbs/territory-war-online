/* =============================================================================
   world.js — 전장(아레나) 세계: 젖은 흙·돌바닥, 황혼의 하늘, 원경 성채·산맥,
   횃불·깃발·부서진 기둥, PMREM 환경 반사, 역동적 조명과 그림자.
   ============================================================================= */
import * as THREE from 'three';
import { terrainMaps, stoneMaps, woodMaps, bannerTexture, glowTexture, cloudTexture, runeTexture, blobTexture, flameTexture, smokeTexture, makeCanvas } from './textures.js';
import { mulberry32, clamp, lerp, fbm, noise2, TAU } from './util.js';

const SUN_DIR = new THREE.Vector3(-0.62, 0.72, 0.36).normalize();   // 해를 조금 더 높여 그림자를 줄이고 전장을 밝게

function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  // 전투 공간(반경 46m)은 평평하게, 바깥은 완만한 둔덕과 언덕
  const flat = 1 - clamp((r - 42) / 26, 0, 1);
  const rim = Math.max(0, (r - 42)) * 0.055;
  const hills = fbm(x * 0.013 + 11, z * 0.013 - 7, 4) * 3.4;
  /* 전투장(반경 ~28m)은 거의 평평하게 — 병사 발·피 웅덩이·접지 그림자가 땅에 파묻히지 않게 */
  const bumpAmp = 0.10 + 0.90 * clamp((r - 10) / 26, 0, 1);
  const bumps = (fbm(x * 0.11, z * 0.11, 3) - 0.5) * 0.34 * bumpAmp;
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
  float t = pow(clamp((h - 0.5) * 2.0, 0.0, 1.0), 0.80);
  vec3 col = mix(horizonColor, topColor, t);
  col *= 1.02;
  // 지평선 근처 따뜻한 띠
  float band = exp(-pow(abs(d.y) * 7.0, 1.6));
  col += vec3(1.0, 0.62, 0.36) * band * 0.12;
  // 해 주변 광휘
  float sd = max(dot(d, normalize(sunDir)), 0.0);
  col += sunColor * pow(sd, 22.0) * 1.05;
  col += sunColor * pow(sd, 4.0) * 0.22;
  // 지평선 아래는 어둡게
  col = mix(col, vec3(0.10, 0.12, 0.15), smoothstep(0.0, -0.14, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildWorld(scene, renderer) {
  const rng = mulberry32(2024);
  const out = { sun: null, key: null, torches: [], banners: [], flames: [], update: null, terrain: null };

  /* ---------------------------------------------------------------- 하늘 */
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x2c63ad) },
      horizonColor: { value: new THREE.Color(0xf4c79b) },
      sunColor: { value: new THREE.Color(0xffe9c4) },
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
  for (let i = 0; i < 17; i++) {
    const a = (i / 17) * TAU + rng() * 0.18;
    const r = 250 + rng() * 120;
    const low = rng() < 0.62;
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: low ? cloudMap : cloudMapHi, transparent: true,
      opacity: low ? 0.42 + rng() * 0.34 : 0.16 + rng() * 0.2,
      depthWrite: false, fog: false,
      color: low ? (rng() < 0.5 ? 0xffb98c : 0xe8a99e) : 0x93a6c8
    }));
    m.position.set(Math.cos(a) * r, low ? 22 + rng() * 26 : 78 + rng() * 70, Math.sin(a) * r);
    const s = low ? 130 + rng() * 190 : 170 + rng() * 240;
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
  col = mix(col, vec3(0.90, 0.85, 0.78), clamp(uHaze * (1.0 - h * 0.85), 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`,
      fog: false,
      side: THREE.DoubleSide
    });
    ridgeShaders.push(mat);
    return mat;
  };
  const ridgeMats = [
    makeRidgeMat(0xa8aebb, 0xdcd6cb, 0.50),   // 가장 먼 능선 — 안개에 잠김
    makeRidgeMat(0x939aab, 0xc3bcb8, 0.30),   // 중간 능선
    makeRidgeMat(0x66698a, 0x93899a, 0.10)    // 가까운 능선
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
    color: 0xb8a996, emissive: 0x2e231a, emissiveIntensity: 0.75,
    roughness: 0.96, metalness: 0.02, envMapIntensity: 0.48
  });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x2a2731, roughness: 0.6, metalness: 0.22, envMapIntensity: 0.8 });
  const darkStoneMat = new THREE.MeshStandardMaterial({ map: cTex, color: 0x6f6355, emissive: 0x191109, emissiveIntensity: 0.7, roughness: 0.96, metalness: 0.02 });

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

  // 원형 탑 — 기단이 넓고 위로 좁아지는 성벽 탑 (탑 5기를 인스턴스로 묶어 드로우콜 절약)
  {
    const towerPos = [-78, -54, 46, 70, -4];
    const towers = towerPos.map((tx, ti) => {
      const zz = ti === 4 ? -34 : 2;
      const h = ti === 4 ? 72 : 50 + rng() * 12;
      const rad = ti === 4 ? 9.5 : 7 + rng() * 2;
      return { tx, zz, h, rad, ti, roofH: 26 + ti * 2 };
    });
    const dummy = new THREE.Object3D();
    const unitCyl = new THREE.CylinderGeometry(0.88, 1.12, 1, 12);
    const body = new THREE.InstancedMesh(unitCyl, castleMat, towers.length);
    const ringGeo = new THREE.CylinderGeometry(1.02, 1.02, 1, 12);
    const rings = new THREE.InstancedMesh(ringGeo, darkStoneMat, towers.length);
    const unitCone = new THREE.ConeGeometry(1.14, 1, 12);
    const roofs = new THREE.InstancedMesh(unitCone, roofMat, towers.length);
    const poleGeo = new THREE.CylinderGeometry(0.28, 0.28, 12, 6);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshBasicMaterial({ color: 0x2a2622 }), 3);
    const merlonN = towers.length * 10;
    const merons = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 2.2, 1.2), castleMat, merlonN);
    let mi = 0, pi = 0;
    towers.forEach((t, i) => {
      dummy.position.set(t.tx, t.h / 2 - 1, t.zz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(t.rad, t.h, t.rad);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.tx, t.h - 4, t.zz);
      dummy.scale.set(1, 1.8, 1);
      dummy.updateMatrix();
      rings.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.tx, t.h + 14, t.zz);
      dummy.scale.set(t.rad * 1.14, t.roofH, t.rad * 1.14);
      dummy.updateMatrix();
      roofs.setMatrixAt(i, dummy.matrix);
      if (t.ti < 3) {
        dummy.position.set(t.tx, t.h + 30, t.zz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(pi++, dummy.matrix);
      }
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * TAU;
        dummy.position.set(t.tx + Math.cos(a) * t.rad * 1.05, t.h + 0.6, t.zz + Math.sin(a) * t.rad * 1.05);
        dummy.rotation.set(0, -a, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        merons.setMatrixAt(mi++, dummy.matrix);
      }
    });
    for (const m of [body, rings, roofs, poles, merons]) {
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true; m.receiveShadow = true;
      castle.add(m);
    }
  }
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
    if (i % 2 === 0) {
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xff8b3a, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0.34, fog: false
      }));
      gl.position.copy(f.position);
      gl.scale.set(13, 13, 1);
      castle.add(gl);
    }
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
      topColor: { value: new THREE.Color(0x4a7bb0) },
      horizonColor: { value: new THREE.Color(0xf8bd93) },
      sunColor: { value: new THREE.Color(0xfff0cc) },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide
  });
  envScene.add(new THREE.Mesh(envGeo, envMat));
  const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(50, 24),
    new THREE.MeshBasicMaterial({ color: 0x6a5140 }));
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
  scene.fog = new THREE.FogExp2(0xd9d4c8, 0.0011);

  /* ------------------------------------------------------------- 조명 */
  const hemi = new THREE.HemisphereLight(0xcfe7ff, 0x64563f, 0.99);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2da, 3.55);
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

  const fill = new THREE.DirectionalLight(0xa8c8f2, 0.84);
  fill.position.set(-40, 30, -50);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffa468, 0.72);
  rim.position.set(30, 12, -60);
  scene.add(rim);

  /* 정면 아래에서 부드럽게 받쳐 주는 빛 — 그림자 쪽이 탁해지지 않게 */
  const bounce = new THREE.DirectionalLight(0xd2e2f6, 0.40);
  bounce.position.set(6, 7, -34);
  scene.add(bounce);

  /* ------------------------------------------------------------ 지면 */
  const maps = terrainMaps(1024);
  maps.albedo.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const seg = 150;
  const tGeo = new THREE.PlaneGeometry(200, 200, seg, seg);
  tGeo.rotateX(-Math.PI / 2);
  const pos = tGeo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const cDirt = new THREE.Color(0xb59a78);
  const cMud = new THREE.Color(0x7f6549);
  const cGrass = new THREE.Color(0x8f9a6c);
  const cStone = new THREE.Color(0xa9a08e);
  const tmpC = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    const r = Math.hypot(x, z);
    const n = fbm(x * 0.07 + 3, z * 0.07 - 5, 3);
    if (r < 11) tmpC.copy(cMud).lerp(cDirt, n);
    else if (r < 38) tmpC.copy(cDirt).lerp(cMud, n * 0.8);
    else {
      /* 돌테 → 풀밭으로 넓게 섞어 띠 경계가 보이지 않게 */
      const k = clamp((r - 38) / 26, 0, 1);
      tmpC.copy(cStone).lerp(cGrass, k).lerp(cDirt, n * 0.32 * (1 - k * 0.5));
    }
    tmpC.offsetHSL(0, (n - 0.5) * 0.05, (n - 0.5) * 0.08);
    col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
  }
  tGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.62, 0.62),
    roughnessMap: maps.rough,
    roughness: 0.96,
    metalness: 0.0,
    vertexColors: true,
    envMapIntensity: 0.34,
    color: 0xffffff
  });
  /* 가까이 봐도 흐릿하지 않도록 타일링되는 미세 알베도(자갈·마른 풀·흙 알갱이)를 곱한다 */
  const detTex = (() => {
    const S = 256;
    const cv = makeCanvas(S, S);
    const dx = cv.getContext('2d');
    dx.fillStyle = '#9a9a9a'; dx.fillRect(0, 0, S, S);
    const r2 = mulberry32(97);
    for (let i = 0; i < 5200; i++) {
      const px = r2() * S, py = r2() * S, rr = 0.6 + r2() * 2.6;
      const t = 118 + r2() * 80;
      dx.fillStyle = `rgba(${t | 0},${(t * 0.97) | 0},${(t * 0.92) | 0},0.5)`;
      dx.beginPath(); dx.arc(px, py, rr, 0, 7); dx.fill();
    }
    for (let i = 0; i < 380; i++) {
      const px = r2() * S, py = r2() * S;
      dx.strokeStyle = `rgba(${(96 + r2() * 40) | 0},${(104 + r2() * 44) | 0},${(72 + r2() * 26) | 0},0.42)`;
      dx.lineWidth = 0.7 + r2();
      dx.beginPath(); dx.moveTo(px, py); dx.lineTo(px + (r2() - 0.5) * 7, py - 1 - r2() * 5); dx.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  })();
  const detUniforms = { value: detTex };
  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = detUniforms;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;')
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        vec3 dcol = texture2D(uDetail, vMapUv * 26.0).rgb;
        float dlum = dot(dcol, vec3(0.3333));
        diffuseColor.rgb *= (0.905 + dlum * 0.19);
        diffuseColor.rgb *= (0.972 + 0.056 * texture2D(uDetail, vMapUv * 3.1).g);
      `);
  };
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
  dais.rotation.x = -Math.PI / 2; dais.position.y = 0.03;
  dais.receiveShadow = true;
  scene.add(dais);

  /* 젖은 진흙의 은은한 광택 — 바닥이 플라스틱처럼 보이지 않게 하늘 반사를 머금는다 */
  const wetMat = new THREE.MeshPhysicalMaterial({
    color: 0x4a3a2a, roughness: 0.34, metalness: 0.0, transparent: true, opacity: 0.20,
    envMapIntensity: 0.9, clearcoat: 0.6, clearcoatRoughness: 0.35,
    normalMap: maps.normal, normalScale: new THREE.Vector2(0.22, 0.22),
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1
  });
  const wet = new THREE.Mesh(new THREE.CircleGeometry(17.5, 64), wetMat);
  wet.rotation.x = -Math.PI / 2;
  wet.position.y = 0.042;
  wet.renderOrder = 1;
  scene.add(wet);

  /* ----------------------------------------------------- 기둥·폐허 */
  const ruinMat = new THREE.MeshStandardMaterial({
    map: stone.albedo, normalMap: stone.normal, roughness: 0.86, metalness: 0.06,
    color: 0xb3ada2, envMapIntensity: 0.85
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
  /* 기둥 — 서 있는 기둥과 부러진 기둥을 인스턴스 3콜로 */
  {
    const dummy = new THREE.Object3D();
    const shafts = new THREE.InstancedMesh(pillarGeo, ruinMat, pillarPositions.length);
    const caps = new THREE.InstancedMesh(capGeo, ruinMat, Math.max(1, pillarPositions.filter((p) => !p.broken).length));
    const bases = new THREE.InstancedMesh(baseGeo, ruinMat, pillarPositions.length);
    let ci = 0;
    pillarPositions.forEach((p, i) => {
      const h = p.broken ? 2.2 + rng() * 3.4 : 6.4;
      const gy = terrainHeight(p.x, p.z);
      const yaw = rng() * TAU;
      const tilt = p.broken ? (rng() - 0.5) * 0.05 : 0;
      dummy.rotation.set(0, yaw, tilt);
      dummy.position.set(p.x, gy + h / 2, p.z);
      dummy.scale.set(1, h / 6.4, 1);
      dummy.updateMatrix();
      shafts.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, gy + 0.2, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      bases.setMatrixAt(i, dummy.matrix);
      if (!p.broken) {
        dummy.position.set(p.x, gy + h + 0.16, p.z);
        dummy.updateMatrix();
        caps.setMatrixAt(ci++, dummy.matrix);
      }
    });
    for (const m of [shafts, caps, bases]) {
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    }
  }
  /* 쓰러진 기둥 조각들 — 인스턴스 1콜 */
  {
    const dummy = new THREE.Object3D();
    const segs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.6, 0.64, 1, 10, 1, false), ruinMat, 12);
    for (let i = 0; i < 12; i++) {
      const a = rng() * TAU, r = 30 + rng() * 22;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      dummy.position.set(x, terrainHeight(x, z) + 0.6, z);
      dummy.rotation.set(0, rng() * TAU, Math.PI / 2);
      dummy.scale.set(1, 2 + rng() * 3, 1);
      dummy.updateMatrix();
      segs.setMatrixAt(i, dummy.matrix);
    }
    segs.instanceMatrix.needsUpdate = true;
    segs.castShadow = true; segs.receiveShadow = true;
    scene.add(segs);
  }

  /* 성벽 파편 (양옆) — 인스턴스 1콜 */
  {
    const dummy = new THREE.Object3D();
    const wallN = 18;
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1.4), ruinMat, wallN);
    let wi2 = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 9; i++) {
        const w = 4 + rng() * 3, h = 2 + rng() * 4.5;
        dummy.position.set(-22 + i * 5.4 + rng(), h / 2 - 0.2, (rng() - 0.5) * 1.6);
        dummy.rotation.set(0, (rng() - 0.5) * 0.12, 0);
        dummy.scale.set(w, h, 1);
        dummy.updateMatrix();
        const m = new THREE.Matrix4().makeTranslation(side * 3, 0, side * 56)
          .multiply(new THREE.Matrix4().makeRotationY(side * 0.04))
          .multiply(dummy.matrix);
        walls.setMatrixAt(wi2++, m);
      }
    }
    walls.instanceMatrix.needsUpdate = true;
    walls.castShadow = true; walls.receiveShadow = true;
    scene.add(walls);
  }

  /* ------------------------------------------------------ 바위·풀 */
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5b564d, roughness: 0.98, metalness: 0.02, envMapIntensity: 0.3 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 140);
  rocks.castShadow = true; rocks.receiveShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i < 140; i++) {
    let x = 0, z = 0, s = 0.3;
    // 중앙 전투로(폭 9m)와 양쪽 진영 스폰 지점 근처에는 바위를 두지 않는다 — 시야 가림 방지
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng() * TAU, r = 8 + Math.pow(rng(), 0.6) * 62;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      s = 0.16 + Math.pow(rng(), 2) * 1.5;
      const inLane = Math.abs(x) < 4.6 && Math.abs(z) < 42;
      const nearSpawn = Math.hypot(x, Math.abs(z) - 12) < 8;
      const inArena = Math.hypot(x, z) < 15 && s > 0.5;   // 전투 한복판의 큰 돌은 시야를 가린다
      if (!inLane && !nearSpawn && !inArena) break;
      x = 0; z = 0; s = 0;     // 자리를 못 찾으면 안 보이게
    }
    pv.set(x, terrainHeight(x, z) + s * 0.32, z);
    q.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
    sc.set(s * (0.8 + rng() * 0.7), s * (0.55 + rng() * 0.5), s * (0.8 + rng() * 0.7));
    m4.compose(pv, q, sc);
    rocks.setMatrixAt(i, m4);
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  /* --------------------------------------------------- 전장의 흔적 */
  /* 꿍힌 창 · 부러진 방패 · 떨어진 판금 — 지면에 이야기를 더한다 (인스턴스 3콜) */
  const deadWood = new THREE.MeshStandardMaterial({ map: woodMaps().map, color: 0x8a7562, roughness: 0.9, metalness: 0.06 });
  const deadSteel = new THREE.MeshStandardMaterial({ color: 0x6d7278, metalness: 0.75, roughness: 0.55, envMapIntensity: 0.9 });
  const spearGeo = new THREE.CylinderGeometry(0.028, 0.036, 2.3, 6);
  spearGeo.translate(0, 1.15, 0);
  const spears = new THREE.InstancedMesh(spearGeo, deadWood, 9);
  const shieldGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.06, 8);
  const shields = new THREE.InstancedMesh(shieldGeo, deadSteel, 6);
  const plankGeo = new THREE.BoxGeometry(1.5, 0.09, 0.3);
  const planks = new THREE.InstancedMesh(plankGeo, deadWood, 7);
  for (const m of [spears, shields, planks]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
  {
    const placeFlat = (mesh, idx, s) => {
      let x = 0, z = 0;
      for (let a = 0; a < 10; a++) {
        const ang = rng() * TAU, r = 7 + Math.pow(rng(), 0.7) * 34;
        x = Math.cos(ang) * r; z = Math.sin(ang) * r;
        if (!(Math.abs(x) < 5 && Math.abs(z) < 30)) break;
      }
      pv.set(x, terrainHeight(x, z) + (s.y || 0), z);
      q.setFromEuler(new THREE.Euler(s.rx || 0, rng() * TAU, s.rz || 0));
      sc.set(s.sx || 1, s.sy || 1, s.sz || 1);
      m4.compose(pv, q, sc);
      mesh.setMatrixAt(idx, m4);
    };
    for (let i = 0; i < 9; i++) placeFlat(spears, i, { rx: (rng() - 0.5) * 0.5, rz: (rng() - 0.5) * 0.45, sy: 0.9 + rng() * 0.25 });
    for (let i = 0; i < 6; i++) placeFlat(shields, i, { rx: Math.PI / 2 + (rng() - 0.5) * 0.8, y: 0.05, sz: 0.9 + rng() * 0.2 });
    for (let i = 0; i < 7; i++) placeFlat(planks, i, { y: 0.06, rz: (rng() - 0.5) * 0.3 });
    spears.instanceMatrix.needsUpdate = true;
    shields.instanceMatrix.needsUpdate = true;
    planks.instanceMatrix.needsUpdate = true;
  }

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
  {
    const dummy = new THREE.Object3D();
    const poleMat = new THREE.MeshStandardMaterial({ map: woodMaps().map, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.4 });
    const finialMat = new THREE.MeshStandardMaterial({ color: 0xd8b056, metalness: 1, roughness: 0.28, envMapIntensity: 1.4 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.095, 6.6, 8), poleMat, 10);
    const finials = new THREE.InstancedMesh(new THREE.ConeGeometry(0.16, 0.6, 6), finialMat, 10);
    poles.castShadow = true;
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const ang = (Math.floor(i / 2) / 5) * 1.5 - 0.75;
      const x = Math.sin(ang) * 46 * side;
      const z = side > 0 ? -42 + Math.abs(ang) * 6 : 42 - Math.abs(ang) * 6;
      const gy = terrainHeight(x, z);
      const yaw = side > 0 ? 0.2 : Math.PI - 0.2;
      dummy.position.set(x, gy + 3.3, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, gy + 6.8, z);
      dummy.updateMatrix();
      finials.setMatrixAt(i, dummy.matrix);
      /* 천은 정점 셰이더로 나부끼므로 개별 메시로 둔다 */
      const bg = new THREE.PlaneGeometry(1.7, 2.5, 8, 10);
      const cloth = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({
        map: side > 0 ? bannerTexA : bannerTexB, side: THREE.DoubleSide, roughness: 0.92,
        metalness: 0.02, envMapIntensity: 0.35
      }));
      cloth.position.set(x + Math.cos(yaw) * 0.86, gy + 5.2, z - Math.sin(yaw) * 0.86);
      cloth.rotation.y = yaw;
      cloth.castShadow = true;
      scene.add(cloth);
      out.banners.push({ cloth, base: bg.attributes.position.array.slice(), ph: rng() * TAU });
    }
    poles.instanceMatrix.needsUpdate = true;
    finials.instanceMatrix.needsUpdate = true;
    scene.add(poles);
    scene.add(finials);
  }

  /* ------------------------------------------------------- 횃불 */
  const flameMap = flameTexture();  // 스폰 지점(0, -21.5) 정면 시야를 가리지 않도록 중앙 축에서 비켜 배치한다
  const torchSpots = [
    { x: 14.5, z: -10 }, { x: -14.5, z: -10 }, { x: 14.5, z: 10 }, { x: -14.5, z: 10 },
    { x: 9.5, z: -16.5 }, { x: -9.5, z: -16.5 }
  ];
  const torchPosts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 1.9, 8),
    new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.9, metalness: 0.1 }), torchSpots.length);
  const torchBowls = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.34, 0.2, 0.34, 10),
    new THREE.MeshStandardMaterial({ color: 0x4a3a28, metalness: 0.85, roughness: 0.45, envMapIntensity: 1.1 }), torchSpots.length);
  torchPosts.castShadow = true; torchBowls.castShadow = true;
  const _td = new THREE.Object3D();
  torchSpots.forEach((t, i) => {
    const gy = terrainHeight(t.x, t.z);
    _td.position.set(t.x, gy + 0.95, t.z);
    _td.rotation.set(0, 0, 0); _td.scale.set(1, 1, 1); _td.updateMatrix();
    torchPosts.setMatrixAt(i, _td.matrix);
    _td.position.set(t.x, gy + 1.9, t.z); _td.updateMatrix();
    torchBowls.setMatrixAt(i, _td.matrix);

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
  torchPosts.instanceMatrix.needsUpdate = true;
  torchBowls.instanceMatrix.needsUpdate = true;
  scene.add(torchPosts);
  scene.add(torchBowls);

  /* -------------------------------------------- 부유 먼지 · 불티(엠버) */
  /* 전장 공기에 떠 있는 것들 — 유닛이 또렷하게 보이도록 옅게, 대신 공간감을 만든다. */
  const ATMO_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.8, -mv.z), 1.0, 42.0);
  gl_Position = projectionMatrix * mv;
}`;
  const ATMO_FRAG = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  if (t.a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb * vAlpha, t.a * vAlpha);
}`;
  const makeMotes = (count, map, baseSize, spread, yMin, yMax, warm) => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    const seed = [];
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU, r = Math.pow(rng(), 0.55) * spread;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = yMin + rng() * (yMax - yMin);
      pos[i * 3 + 2] = Math.sin(a) * r;
      size[i] = baseSize * (0.5 + rng() * 1.1);
      alpha[i] = 0.35 + rng() * 0.65;
      seed.push({ sp: 0.08 + rng() * 0.4, ph: rng() * TAU, wob: 0.2 + rng() * 0.8 });
      const t2 = rng();
      if (warm) {
        col[i * 3] = 1; col[i * 3 + 1] = 0.45 + t2 * 0.4; col[i * 3 + 2] = 0.12 + t2 * 0.2;
      } else {
        col[i * 3] = 0.86 + t2 * 0.1; col[i * 3 + 1] = 0.8 + t2 * 0.1; col[i * 3 + 2] = 0.7 + t2 * 0.08;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 640 } },
      vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    scene.add(pts);
    return { pts, pos, size, alpha, seed, count, spread, yMin, yMax };
  };
  const embers = makeMotes(96, glowTex, 0.085, 42, 0.05, 9, true);
  const motes = makeMotes(84, glowTex, 0.05, 34, 0.4, 14);
  // 불티는 주황빛으로, 먼지는 옅은 빛가루로
  {
    const c = embers.pts.geometry.attributes.aColor.array;
    for (let i = 0; i < embers.count; i++) { c[i * 3] = 1; c[i * 3 + 1] = 0.42 + rng() * 0.34; c[i * 3 + 2] = 0.1 + rng() * 0.14; }
    embers.pts.geometry.attributes.aColor.needsUpdate = true;
  }

  /* ------------------------------------------------ 전장 바닥 안개 자락 */
  const groundMist = [];
  const mistTex = smokeTexture();
  const mistMat = () => new THREE.SpriteMaterial({
    map: mistTex, color: 0xcfbca6, transparent: true, opacity: 0.1,
    depthWrite: false, fog: true
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + rng() * 0.3;
    const r = 16 + rng() * 30;
    const sm = new THREE.Sprite(mistMat());
    sm.position.set(Math.cos(a) * r, 0.55 + rng() * 0.5, Math.sin(a) * r);
    const sc = 12 + rng() * 16;
    sm.scale.set(sc, sc * 0.42, 1);
    sm.material.opacity = 0.04 + rng() * 0.05;
    sm.renderOrder = 2;
    scene.add(sm);
    groundMist.push({ s: sm, ph: rng() * TAU, x: sm.position.x, z: sm.position.z, sc });
  }

  /* 룬 제단 (가운데) — 마법사 스폰 지점 장식 */
  const runeMat = new THREE.MeshBasicMaterial({
    map: runeTexture(), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.5, color: 0x9fdcff
  });
  const rune = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), runeMat);
  rune.rotation.x = -Math.PI / 2;
  rune.position.y = 0.055;
  scene.add(rune);
  out.rune = rune;

  /* 접지 그림자 (유닛용) — 별도 모듈에서 사용할 텍스처 */
  out.blobTex = blobTexture();

  /* 하늘 돔은 카메라를 따라온다 */
  const tmpV = new THREE.Vector3();
  const updateMotes = (m, dt, t, camPos, rise) => {
    const p = m.pos, n = m.count;
    for (let i = 0; i < n; i++) {
      const s = m.seed[i], i3 = i * 3;
      p[i3 + 1] += (rise + s.sp * 0.35) * dt;
      p[i3] += Math.sin(t * 0.7 * s.wob + s.ph) * dt * 0.22;
      p[i3 + 2] += Math.cos(t * 0.6 * s.wob + s.ph * 1.3) * dt * 0.22;
      if (p[i3 + 1] > m.yMax) {
        // 카메라 주변 반경 안에서 새로 태어난다
        const a = rng() * TAU, r = Math.pow(rng(), 0.55) * m.spread;
        p[i3] = camPos.x + Math.cos(a) * r;
        p[i3 + 1] = m.yMin + rng() * 0.6;
        p[i3 + 2] = camPos.z + Math.sin(a) * r;
      }
    }
    // 카메라에서 너무 멀어진 입자는 카메라 근처로 되돌린다
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const dx = p[i3] - camPos.x, dz = p[i3 + 2] - camPos.z;
      if (dx * dx + dz * dz > (m.spread + 18) * (m.spread + 18)) {
        const a = rng() * TAU, r = Math.pow(rng(), 0.6) * m.spread * 0.6;
        p[i3] = camPos.x + Math.cos(a) * r;
        p[i3 + 2] = camPos.z + Math.sin(a) * r;
        p[i3 + 1] = m.yMin + rng() * (m.yMax - m.yMin);
      }
    }
    m.pts.geometry.attributes.position.needsUpdate = true;
  };
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
    const normFrame = ((out.updateN = (out.updateN || 0) + 1) & 1) === 0;
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
      if (normFrame) b.cloth.geometry.computeVertexNormals();
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
        if (normFrame) b.cloth.geometry.computeVertexNormals();
      }
    }
    // 창문 등불이 느리게 흔들린다
    if (out.castleWindowMat) {
      out.castleWindowMat.opacity = 0.82 + Math.sin(t * 1.7) * 0.07 + Math.sin(t * 3.9 + 1.2) * 0.05;
      if (out.castleWindows) out.castleWindows.material.color.setHSL(0.075, 0.85, 0.52 + Math.sin(t * 0.9) * 0.05);
    }
    runeMat.opacity = 0.20 + Math.sin(t * 1.6) * 0.06;
    rune.rotation.z = t * 0.06;
    // 공기 중 먼지 · 불티 · 바닥 안개
    updateMotes(embers, dt, t, camPos, 0.55);
    updateMotes(motes, dt, t, camPos, 0.05);
    for (const gm of groundMist) {
      gm.s.position.x = gm.x + Math.sin(t * 0.12 + gm.ph) * 1.6;
      gm.s.position.z = gm.z + Math.cos(t * 0.1 + gm.ph) * 1.6;
      gm.s.material.opacity = 0.035 + Math.sin(t * 0.35 + gm.ph) * 0.02;
    }
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
