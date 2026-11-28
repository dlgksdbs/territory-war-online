/* =============================================================================
   octagon.js — 🥊 PVP 전용 UFC 옥타곤 링 무대
   -----------------------------------------------------------------------------
   · 살짝 올라온 8각형 매트(중앙 원·라인 마킹) + 8 모서리 기둥·패드 + 철망 케이지
   · 경기장 조명 느낌은 발광 판·헤일로로 (실제 조명 추가 없이 가볍게)
   · 드로우콜을 아끼려고 기둥·패드·레일·철망은 InstancedMesh 로 묶는다
   · PVP 전투에 들어갈 때만 장면에 붙이고, 나가면 통째로 걷어낸다
     (솔로 배틀 아레나의 성곽 평원은 절대 건드리지 않는다)
   ============================================================================= */
import * as THREE from 'three';
import { OCTAGON, octagonMatTop, octagonMatBottom } from './ground.js';
import { makeCanvas } from './textures.js';

/* 매트 바닥 텍스처 — 8각 아웃라인 + 중앙 원 + 라인 마킹 */
function matTexture() {
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const cx = S / 2, R = S / 2;
  const grad = g.createRadialGradient(cx, cx * 0.82, S * 0.04, cx, cx, R);
  grad.addColorStop(0, '#242a33');
  grad.addColorStop(0.55, '#1a1f26');
  grad.addColorStop(1, '#12161b');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 2400; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    /* 🧽 반짝임 제거 — 예전엔 흰 점(알파 0.03)이 매트 위에서 조명을 받아
       먼지처럼 반짝였다. 이제는 '살짝 밝은 얼룩' 정도로만 남긴다 */
    g.fillStyle = 'rgba(255,255,255,' + (0.003 + Math.random() * 0.009).toFixed(3) + ')';
    g.fillRect(x, y, 1.4, 1.4);
  }
  const oct = (rad) => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = cx + Math.sin(a) * rad, y = cx + Math.cos(a) * rad;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(214,226,240,0.55)';
  oct(R * 0.955);
  g.stroke();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(214,226,240,0.22)';
  oct(R * 0.90);
  g.stroke();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(226,236,248,0.58)';
  g.beginPath(); g.arc(cx, cx, R * 0.155, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 1.4;
  g.strokeStyle = 'rgba(226,236,248,0.22)';
  g.beginPath(); g.arc(cx, cx, R * 0.115, 0, Math.PI * 2); g.stroke();
  /* 중앙 표식 — 작은 원 두 개 (UFC 매트의 센터 로고 자리) */
  g.fillStyle = 'rgba(228,238,250,0.16)';
  g.beginPath(); g.arc(cx, cx, R * 0.030, 0, Math.PI * 2); g.fill();
  /* 8방향 짧은 틱 — 매트 라인 마킹 */
  g.strokeStyle = 'rgba(214,226,240,0.16)';
  g.lineWidth = 2.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx + Math.sin(a) * R * 0.19, cx + Math.cos(a) * R * 0.19);
    g.lineTo(cx + Math.sin(a) * R * 0.27, cx + Math.cos(a) * R * 0.27);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 철망 케이지 텍스처 (투명 배경 + 대각 격자) */
function cageTexture() {
  const S = 128;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(198,208,220,0.95)';
  g.lineWidth = 2.2;
  for (let i = -S; i < S * 2; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke();
    g.beginPath(); g.moveTo(i, S); g.lineTo(i + S, 0); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildOctagon(scene) {
  const group = new THREE.Group();
  group.name = 'pvpOctagon';
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };

  const R_VERT = OCTAGON.vertex;                 // 꼭짓점(매트 반지름)
  const SIDE = 2 * R_VERT * Math.sin(Math.PI / 8);
  const TOP = OCTAGON.top;
  const dummy = new THREE.Object3D();
  /* 🥊 매트 윗면을 '링 안 지형의 가장 높은 곳'보다 위에 둔다 — 지형 기복에 매트가
     파묻히거나 유닛 발이 매트 아래로 내려가지 않게. 아래에는 바닥까지 닿는 받침을 둔다. */
  const MAT_TOP = octagonMatTop();
  const MAT_BOTTOM = octagonMatBottom();
  group.position.y = MAT_TOP - TOP;               // 로컬 TOP = 월드 MAT_TOP

  /* ---------------------------------------------------------- 매트·플랫폼
     🧽 매트는 완전 무광 — 반사광(반짝임)을 남기지 않는다 (2026-11-28 제보:
     "바닥이 너무 반짝거려"). roughness 1.0 · metalness 0 · envMapIntensity 0.04 로
     하늘·조명 반사를 거의 없애고, 색은 알베도만으로 낸다. */
  const matMat = keep(new THREE.MeshStandardMaterial({
    map: keep(matTexture()), roughness: 0.99, metalness: 0.0,
    color: 0xcfd6e2, envMapIntensity: 0.04, emissive: 0x06080b
  }));
  const mat = new THREE.Mesh(keep(new THREE.CylinderGeometry(R_VERT, R_VERT, TOP, 8)), matMat);
  mat.name = 'octagonMat';
  mat.position.y = TOP / 2;
  mat.receiveShadow = true;
  group.add(mat);

  /* 받침 — 매트 윗면 아래로 지형 바닥까지 (들쭉날쭉한 지형에 매트가 떠 보이지 않게) */
  const baseH = Math.max(0.34, (MAT_TOP - MAT_BOTTOM) + 0.02);
  const base = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(R_VERT + 0.16, R_VERT + 0.34, baseH, 8)),
    keep(new THREE.MeshStandardMaterial({ color: 0x0f1216, roughness: 0.98, metalness: 0.0, envMapIntensity: 0.05 }))
  );
  base.name = 'octagonBase';
  base.position.y = TOP - baseH / 2;
  base.receiveShadow = true;
  group.add(base);

  /* ------------------------------------------------------- 기둥 + 케이지 */
  const postMat = keep(new THREE.MeshStandardMaterial({ color: 0x6d7480, metalness: 0.7, roughness: 0.52, envMapIntensity: 0.5 }));
  const redMat = keep(new THREE.MeshStandardMaterial({ color: 0xa8283a, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.22 }));
  const blueMat = keep(new THREE.MeshStandardMaterial({ color: 0x2c4f9e, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.22 }));
  const goldMat = keep(new THREE.MeshStandardMaterial({ color: 0xb9882f, roughness: 0.62, metalness: 0.25, envMapIntensity: 0.35 }));
  const railMat = keep(new THREE.MeshStandardMaterial({ color: 0x555c66, metalness: 0.75, roughness: 0.48, envMapIntensity: 0.55 }));
  const cageMat = keep(new THREE.MeshStandardMaterial({
    map: keep(cageTexture()), transparent: true, opacity: 0.62, side: THREE.DoubleSide,
    metalness: 0.35, roughness: 0.62, depthWrite: false, color: 0xdfe7f2, envMapIntensity: 0.3
  }));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff3d4 }));

  const inst = (geo, matKey, n) => {
    const m = new THREE.InstancedMesh(keep(geo), matKey, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    return m;
  };
  const posts = inst(new THREE.CylinderGeometry(0.13, 0.16, 3.5, 8), postMat, 8);
  const padsA = inst(new THREE.CylinderGeometry(0.30, 0.30, 1.05, 10), redMat, 4);
  const padsB = inst(new THREE.CylinderGeometry(0.30, 0.30, 1.05, 10), blueMat, 4);
  const topPadsA = inst(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 8), redMat, 4);
  const topPadsB = inst(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 8), blueMat, 4);
  const lamps = inst(new THREE.SphereGeometry(0.13, 6, 4), lampMat, 8);
  const rails = inst(new THREE.BoxGeometry(SIDE * 0.995, 0.10, 0.10), railMat, 16);
  const lowA = inst(new THREE.BoxGeometry(SIDE * 0.995, 0.95, 0.20), redMat, 4);
  const lowB = inst(new THREE.BoxGeometry(SIDE * 0.995, 0.95, 0.20), blueMat, 4);
  const cages = inst(new THREE.PlaneGeometry(SIDE * 0.985, 2.95), cageMat, 8);

  let ai = 0, bi = 0, ri = 0, li = 0, ci = 0;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;                  // 꼭짓점 방향
    const px = Math.sin(ang) * R_VERT, pz = Math.cos(ang) * R_VERT;
    dummy.position.set(px, TOP + 1.75, pz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.updateMatrix(); posts.setMatrixAt(i, dummy.matrix);

    dummy.position.set(px, TOP + 0.55, pz); dummy.updateMatrix();
    (i % 2 ? padsB : padsA).setMatrixAt(i % 2 ? bi : ai, dummy.matrix);
    dummy.position.set(px, TOP + 3.35, pz); dummy.updateMatrix();
    (i % 2 ? topPadsB : topPadsA).setMatrixAt(i % 2 ? bi : ai, dummy.matrix);
    if (i % 2) bi++; else ai++;

    dummy.position.set(px, TOP + 3.62, pz); dummy.updateMatrix();
    lamps.setMatrixAt(li++, dummy.matrix);

    /* 변(면) — 철망 · 상단/중간 레일 · 하단 패드 */
    const a = ang + Math.PI / 8;
    const fx = Math.sin(a) * OCTAGON.fence, fz = Math.cos(a) * OCTAGON.fence;
    dummy.rotation.set(0, a, 0);
    dummy.position.set(fx, TOP + 1.55, fz); dummy.updateMatrix();
    cages.setMatrixAt(ci++, dummy.matrix);
    dummy.position.set(fx, TOP + 3.02, fz); dummy.updateMatrix();
    rails.setMatrixAt(ri++, dummy.matrix);
    dummy.position.set(fx, TOP + 1.0, fz); dummy.updateMatrix();
    rails.setMatrixAt(ri++, dummy.matrix);
    dummy.position.set(fx, TOP + 0.5, fz); dummy.updateMatrix();
    (i % 2 ? lowB : lowA).setMatrixAt(i % 2 ? (i >> 1) : (i >> 1), dummy.matrix);
  }
  for (const m of [posts, padsA, padsB, topPadsA, topPadsB, lamps, rails, lowA, lowB, cages]) {
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = false;
    m.receiveShadow = false;
  }

  /* 매트 둘레의 은은한 금빛 테두리 (8각) — 깜박이는 발광은 뺐다 (바닥 반짝임 제보) */
  const edge = new THREE.Mesh(
    keep(new THREE.RingGeometry(R_VERT * 0.90, R_VERT * 0.935, 8, 1)),
    keep(new THREE.MeshBasicMaterial({ color: 0xd8b677, transparent: true, opacity: 0.16, side: THREE.DoubleSide }))
  );
  edge.name = 'octagonEdge';
  edge.rotation.x = -Math.PI / 2;
  edge.rotation.z = Math.PI / 8;
  edge.position.y = TOP + 0.006;
  group.add(edge);

  scene.add(group);

  const api = {
    group,
    info: () => ({
      meshes: group.children.length, apothem: OCTAGON.apothem, fence: OCTAGON.fence, top: TOP,
      matTop: +MAT_TOP.toFixed(3), matBottom: +MAT_BOTTOM.toFixed(3),
      /* 🧽 바닥 재질 (검증·디버그) — 무광인지 한눈에 */
      floor: {
        mat: { roughness: matMat.roughness, metalness: matMat.metalness, env: matMat.envMapIntensity },
        base: { roughness: base.material.roughness, metalness: base.material.metalness, env: base.material.envMapIntensity }
      }
    }),
    update: (dt, t) => { /* 깜박임 없음 — 반짝이는 바닥 지적(2026-11-28)으로 정적 유지 */ },
    dispose: () => {
      scene.remove(group);
      for (const d of disposables) { try { if (d && d.dispose) d.dispose(); } catch (e) { /* noop */ } }
      disposables.length = 0;
    }
  };
  return api;
}
