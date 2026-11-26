/* =============================================================================
   친구와 플레이 · 전장 3D (성 · 성벽 · 소환된 군사 · 관전 카메라)
   -----------------------------------------------------------------------------
   · 카메라는 배틀 아레나의 '관전 모드'와 같다:
     왼쪽 조이스틱 = 시선 방향 3D 자유 비행(위를 보며 앞으로 = 상승),
     화면 드래그 = 시점 회전. 직접 참전·무기 휘두르기는 없다.
   · 서버 상태(fstate)만 보고 그리므로 클라이언트는 판정을 하지 않는다.
   ============================================================================= */

import * as THREE from '/vendor/three.module.min.js';

const NATION_COLORS = ['#4aa3ff', '#ff5f5f', '#45d18a', '#ffc247', '#b07bff'];
const TYPE_TINT = {
  soldier: '#ffffff',
  elite: '#dfe9ff',
  knight: '#cfd6e8',
  wizard: '#b9a4ff',
  blademaster: '#ffb9d6',
  berserker: '#ff9a8a'
};
const TYPE_SCALE = { soldier: 1, elite: 1.08, knight: 1.45, wizard: 1.05, blademaster: 1.02, berserker: 1.2 };
const TYPE_KEYS = ['soldier', 'elite', 'knight', 'wizard', 'blademaster', 'berserker'];
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class WarScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1017');
    this.scene.fog = new THREE.Fog('#0d1622', 320, 900);
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.5, 1200);
    this.cam = { x: 0, y: 160, z: 132, yaw: Math.PI, pitch: -0.90 };
    this.joy = { x: 0, z: 0 };
    this.alt = 0;
    this.time = 0;
    this.nations = new Map();      // slot -> { group, wallSegs, keep, flag, label, mesh, figures }
    this.colors = NATION_COLORS;
    this.lastState = null;
    this.focusSlot = -1;
    this.autoSpin = 0;
    this._buildWorld();
    this._bindSize();
  }

  /* ---------------------------------------------------------------- 월드 */
  _buildWorld() {
    const hemi = new THREE.HemisphereLight('#cfe6ff', '#3a3422', 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff2d0', 1.35);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#6fa8ff', 0.45);
    rim.position.set(-80, 40, -60);
    this.scene.add(rim);

    /* 하늘 — 위아래 그라데이션 구 */
    const skyGeo = new THREE.SphereGeometry(600, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color('#1b3b63') }, bot: { value: new THREE.Color('#0a1017') } },
      vertexShader: 'varying float h; void main(){ vec4 p = modelMatrix * vec4(position,1.0); h = normalize(p.xyz).y; gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying float h; void main(){ gl_FragColor = vec4(mix(bot, top, smoothstep(-0.15, 0.55, h)), 1.0); }'
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    /* 땅 */
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(210, 72),
      new THREE.MeshStandardMaterial({ color: '#37452c', roughness: 0.95, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    /* 전장 중앙 링 */
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(20, 21.2, 64),
      new THREE.MeshBasicMaterial({ color: '#5a6b45', transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.scene.add(ring);

    /* 성들 사이를 잇는 흐린 길 */
    this.pathLines = new THREE.Group();
    this.scene.add(this.pathLines);
    /* 진군 중인 부대 표시 (줄 + 깃발 마커) */
    this.marchGroup = new THREE.Group();
    this.scene.add(this.marchGroup);

    /* 짧은 풀 — 인스턴스 */
    const grassGeo = new THREE.ConeGeometry(0.28, 1.1, 4);
    const grassMat = new THREE.MeshStandardMaterial({ color: '#4c6134', roughness: 1 });
    const grass = new THREE.InstancedMesh(grassGeo, grassMat, 420);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < 420; i++) {
      const a = hash(i * 3.1) * TAU;
      const r = 22 + hash(i * 7.7) * 150;
      const s = 0.7 + hash(i * 2.3) * 1.2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(i) * TAU);
      m.compose(new THREE.Vector3(Math.cos(a) * r, 0.35 * s, Math.sin(a) * r), q, new THREE.Vector3(s, s, s));
      grass.setMatrixAt(i, m);
    }
    grass.instanceMatrix.needsUpdate = true;
    this.scene.add(grass);

    this.unitGeo = new THREE.CapsuleGeometry(0.52, 1.35, 3, 7);
    this.unitGeo.translate(0, 1.22, 0);
  }

  _bindSize() {
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    this._resize = resize;
  }

  colorOf(slot) {
    return this.colors[slot % this.colors.length];
  }

  /* -------------------------------------------------------------- 성 생성 */
  _makeLabel(text, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.font = 'bold 30px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(4,8,14,0.85)';
    g.strokeText(text, 128, 34);
    g.fillStyle = color;
    g.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(10.5, 2.7, 1);
    return sprite;
  }

  _buildCastle(nation) {
    const color = new THREE.Color(this.colorOf(nation.slot));
    const group = new THREE.Group();
    const stoneColor = new THREE.Color('#7b786e').lerp(color, 0.28);
    const stone = new THREE.MeshStandardMaterial({ color: stoneColor, roughness: 0.95, metalness: 0.04 });
    const stoneDark = new THREE.MeshStandardMaterial({ color: '#5f5d57', roughness: 1 });
    const banner = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
    const glow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 });

    /* 기단 */
    const base = new THREE.Mesh(new THREE.CylinderGeometry(11, 12.4, 1.6, 24), stoneDark);
    base.position.y = 0.8;
    group.add(base);

    /* 성벽 — 앞쪽 반원 9조각 (체력에 따라 낮아진다) */
    const wallGroup = new THREE.Group();
    const segs = [];
    const SEG = 9;
    const R = 13.6;
    const face = Math.atan2(-nation.pos.z, -nation.pos.x);
    for (let i = 0; i < SEG; i++) {
      const t = (i + 0.5) / SEG;
      const a = face - 0.95 + t * 1.9;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(3.1, 3.4, 1.3), stone);
      seg.position.set(Math.cos(a) * R, 1.7, Math.sin(a) * R);
      seg.rotation.y = -a;
      wallGroup.add(seg);
      /* 총안(위쪽 작은 상자) — 한 칸 걸러 */
      if (i % 2 === 0) {
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.45), stone);
        top.position.set(Math.cos(a) * R, 3.65, Math.sin(a) * R);
        top.rotation.y = -a;
        wallGroup.add(top);
        segs.push(top);
      }
    }
    group.add(wallGroup);

    /* 성벽 양 끝 탑 */
    const towers = [];
    for (const side of [-1, 1]) {
      const a = face + side * 1.05;
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.0, 6.2, 12), stone);
      tw.position.set(Math.cos(a) * R * 0.95, 3.1, Math.sin(a) * R * 0.95);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 2.0, 12), banner);
      roof.position.set(tw.position.x, 7.1, tw.position.z);
      group.add(tw, roof);
      towers.push(tw, roof);
      segs.push(tw, roof);
    }

    /* 본성 */
    const keep = new THREE.Mesh(new THREE.BoxGeometry(6.8, 8.2, 6.8), stone);
    keep.position.y = 5.7;
    group.add(keep);
    const keepTop = new THREE.Mesh(new THREE.BoxGeometry(7.8, 1.1, 7.8), stoneDark);
    keepTop.position.y = 10.3;
    group.add(keepTop);
    for (const [dx, dz] of [[-3.7, -3.7], [3.7, -3.7], [-3.7, 3.7], [3.7, 3.7]]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.45, 6.6, 10), stone);
      t.position.set(dx, 6.8, dz);
      const r2 = new THREE.Mesh(new THREE.ConeGeometry(1.8, 2.0, 10), banner);
      r2.position.set(dx, 11.1, dz);
      group.add(t, r2);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.4, 0.4), stoneDark);
    door.position.set(0, 2.0, 3.45);
    group.add(door);

    /* 깃발 */
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 8, 6), stoneDark);
    pole.position.set(0, 15.2, 0);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.6), banner);
    flag.position.set(2.3, 17.6, 0);
    group.add(pole, flag);

    /* 나라 색 발광 링 */
    const halo = new THREE.Mesh(new THREE.RingGeometry(12.6, 14.4, 40), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.42, side: THREE.DoubleSide
    }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.09;
    group.add(halo);

    /* 피해 연기 */
    const smoke = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1.6, 6, 5), new THREE.MeshBasicMaterial({
        color: '#3a3a3a', transparent: true, opacity: 0
      }));
      s.position.set((hash(i) - 0.5) * 6, 11 + i * 1.2, (hash(i + 9) - 0.5) * 6);
      smoke.add(s);
    }
    group.add(smoke);

    const label = this._makeLabel(nation.name, this.colorOf(nation.slot));
    label.position.set(0, 31, 0);
    label.userData.name = nation.name;
    group.add(label);

    group.position.set(nation.pos.x, 0, nation.pos.z);
    group.scale.setScalar(1.2);
    this.scene.add(group);
    return { group, segs, keep, keepTop, flag, halo, smoke, label, wallGroup, towers, base, material: stone };
  }

  /* ---------------------------------------------------------- 상태 반영 */
  syncNations(nations) {
    const count = nations.length;
    for (const n of nations) {
      let entry = this.nations.get(n.slot);
      if (!entry) {
        entry = this._buildCastle(n);
        const mesh = new THREE.InstancedMesh(
          this.unitGeo,
          new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1 }),
          170
        );
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(170 * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(mesh);
        entry.mesh = mesh;
        entry.figures = [];
        entry.color = new THREE.Color(this.colorOf(n.slot));
        this.nations.set(n.slot, entry);
      }
      entry.nation = n;
    }
    /* 나라 수가 줄었거나(재대결) 이전 성이 남아 있으면 정리 */
    for (const [slot, entry] of this.nations) {
      const live = nations.find((x) => x.slot === slot);
      if (!live) {
        this.scene.remove(entry.group);
        this.scene.remove(entry.mesh);
        this.nations.delete(slot);
        continue;
      }
      entry.group.position.set(live.pos.x, 0, live.pos.z);
      entry.nation = live;
      if (entry.label && entry.label.userData.name !== live.name) {
        entry.group.remove(entry.label);
        entry.label = this._makeLabel(live.name, this.colorOf(slot));
        entry.label.position.set(0, 23, 0);
        entry.label.userData.name = live.name;
        entry.group.add(entry.label);
      }
    }
    this.nationCount = count;
  }

  _castleDestroyedFx(entry, alive, now) {
    const keepVisible = alive;
    if (entry.keep) {
      entry.keep.visible = keepVisible;
      entry.keepTop.visible = keepVisible;
      entry.flag.visible = keepVisible;
    }
    if (entry.wallGroup) entry.wallGroup.visible = alive;
    if (entry.towers) for (const t of entry.towers) t.visible = alive;
    if (entry.halo) entry.halo.material.opacity = alive ? 0.42 : 0.08;
    if (entry.smoke) {
      for (let i = 0; i < entry.smoke.children.length; i++) {
        const s = entry.smoke.children[i];
        s.material.opacity = alive ? 0 : 0.32 + Math.sin(now * 2 + i) * 0.1;
        s.position.y = 8 + ((now * 1.6 + i * 2) % 8);
        s.scale.setScalar(1 + (i % 3) * 0.4);
      }
    }
  }

  _applyDamageVisual(entry, nation, now) {
    const alive = nation.alive;
    const wallRatio = nation.wall.max > 0 ? nation.wall.hp / nation.wall.max : 0;
    const castleRatio = nation.castle.max > 0 ? nation.castle.hp / nation.castle.max : 0;
    if (entry.wallGroup) {
      entry.wallGroup.visible = alive;
      entry.wallGroup.children.forEach((seg, i) => {
        const segRatio = (i / Math.max(1, entry.wallGroup.children.length)) * 0.9 + 0.1;
        seg.visible = wallRatio > (1 - segRatio) * 0.95 || wallRatio > 0.95;
        if (seg.material && seg.material.color) seg.material.color.setScalar(0.55 + wallRatio * 0.45);
      });
      /* 체력이 낮을수록 낮아진다 */
      const h = 0.15 + wallRatio * 0.85;
      entry.wallGroup.scale.y = h;
      entry.wallGroup.position.y = 0;
    }
    if (entry.keep) {
      const k = 0.75 + castleRatio * 0.25;
      entry.keep.scale.set(1, k, 1);
      entry.keep.position.y = 5.7 * k;
      entry.keepTop.position.y = 10.3 * k;
      entry.keep.material.emissive = entry.keep.material.emissive || new THREE.Color('#000000');
      entry.keep.material.emissive.setRGB((1 - castleRatio) * 0.34, (1 - castleRatio) * 0.05, 0);
      entry.material.emissive.setRGB((1 - castleRatio) * 0.22, 0, 0);
    }
    if (entry.halo) {
      entry.halo.material.opacity = alive ? 0.28 + Math.sin(now * 2.2) * 0.06 : 0.06;
    }
    this._castleDestroyedFx(entry, alive, now);
  }

  /* ---------------------------------------------------------- 유닛 배치 */
  _figureTargets(nation, state, out) {
    const slot = nation.slot;
    const pos = nation.pos;
    const time = state.time;
    const now = performance.now() / 1000;

    /* 수비 병력 — 성벽 안쪽에 진형 */
    const total = nation.total;
    if (nation.alive && total > 0) {
      const count = clamp(Math.ceil(total / 40), total > 0 ? 1 : 0, 54);
      for (let i = 0; i < count; i++) {
        const a = hash(slot * 31 + i * 1.7) * TAU;
        const r = 9.5 + hash(slot * 7 + i * 3.3) * 5.5;
        out.push({
          x: pos.x + Math.cos(a) * r,
          z: pos.z + Math.sin(a) * r,
          tint: this.colorOf(slot),
          h: 0.9 + hash(i + slot * 5) * 0.25,
          phase: hash(i * 9.1) * TAU
        });
      }
    }

    /* 진군 중인 부대 */
    for (const m of state.marches) {
      if (m.from !== slot) continue;
      const from = state.nations[m.from];
      const to = state.nations[m.to];
      if (!from || !to) continue;
      const p = clamp((time - m.departAt) / Math.max(0.1, m.travel), 0, 1);
      const count = clamp(Math.ceil(m.total / 70), 1, 22);
      for (let i = 0; i < count; i++) {
        const jx = (hash(m.id * 13 + i) - 0.5) * 5;
        const jz = (hash(m.id * 17 + i) - 0.5) * 5;
        const x = lerp(from.pos.x, to.pos.x, p) + jx;
        const z = lerp(from.pos.z, to.pos.z, p) + jz;
        out.push({
          x, z,
          tint: this.colorOf(slot),
          h: 1.0,
          phase: hash(i * 3.7 + m.id) * TAU,
          march: true
        });
      }
    }

    /* 공성 중인 부대 — 목표 성벽 앞 */
    for (const s of state.sieges) {
      const atk = s.attackers.find((a) => a.slot === slot);
      if (!atk) continue;
      const target = state.nations[s.target];
      if (!target) continue;
      const count = clamp(Math.ceil(atk.total / 60), 1, 26);
      const face = Math.atan2(target.pos.z - nation.pos.z, target.pos.x - nation.pos.x);
      for (let i = 0; i < count; i++) {
        const spread = (hash(s.target * 11 + i * 2.1) - 0.5) * 16;
        const depth = 1 + hash(i * 5.3) * 4;
        const x = target.pos.x + Math.cos(face) * (13.5 + depth) - Math.sin(face) * spread;
        const z = target.pos.z + Math.sin(face) * (13.5 + depth) + Math.cos(face) * spread;
        out.push({
          x, z,
          tint: this.colorOf(slot),
          h: 1.0,
          phase: hash(i * 7.9) * TAU,
          siege: true
        });
      }
    }
  }

  _updateUnits(state, dt, now) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scale = new THREE.Vector3();
    const posV = new THREE.Vector3();
    const color = new THREE.Color();
    for (const entry of this.nations.values()) {
      const nation = state.nations.find((n) => n.slot === entry.nation.slot) || entry.nation;
      entry.nation = nation;
      const targets = [];
      this._figureTargets(nation, state, targets);
      const figures = entry.figures;
      while (figures.length < targets.length) figures.push({ x: 0, z: 0, init: false });
      if (figures.length > targets.length) figures.length = targets.length;
      entry.mesh.count = Math.min(figures.length, 170);
      for (let i = 0; i < entry.mesh.count; i++) {
        const f = figures[i];
        const t = targets[i];
        if (!f.init) {
          f.x = t.x; f.z = t.z; f.init = true;
        } else {
          const k = 1 - Math.pow(0.0025, dt);
          f.x = lerp(f.x, t.x, k);
          f.z = lerp(f.z, t.z, k);
        }
        const moving = Math.abs(f.x - t.x) + Math.abs(f.z - t.z) > 0.35;
        const bob = moving
          ? Math.abs(Math.sin(now * 8 + t.phase)) * 0.5
          : Math.sin(now * 2.2 + t.phase) * 0.09;
        const lunge = t.siege ? Math.max(0, Math.sin(now * 5 + t.phase)) * 0.25 : 0;
        posV.set(f.x, 0.1 + bob, f.z);
        q.setFromAxisAngle(up, t.phase + Math.sin(now * 2 + t.phase) * 0.2);
        const s = t.h;
        scale.set(s, s, s);
        m.compose(posV, q, scale);
        entry.mesh.setMatrixAt(i, m);
        color.set(t.tint);
        color.offsetHSL(0, 0, (t.siege ? 0.02 : 0) + Math.sin(t.phase * 5) * 0.03);
        entry.mesh.setColorAt(i, color);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
    }
  }

  _updateMarches(state) {
    const marks = this.marchGroup;
    const marches = state.marches || [];
    while (marks.children.length < marches.length) {
      const g = new THREE.Group();
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 }));
      const dot = new THREE.Mesh(new THREE.OctahedronGeometry(1.6, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      const glow = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.4, 16), new THREE.MeshBasicMaterial({
        color: '#ffffff', transparent: true, opacity: 0.35, side: THREE.DoubleSide
      }));
      glow.rotation.x = -Math.PI / 2;
      g.add(line, dot, glow);
      marks.add(g);
    }
    for (let i = 0; i < marks.children.length; i++) {
      const g = marks.children[i];
      const m = marches[i];
      if (!m) { g.visible = false; continue; }
      const from = state.nations[m.from];
      const to = state.nations[m.to];
      if (!from || !to) { g.visible = false; continue; }
      g.visible = true;
      const color = this.colorOf(m.from);
      const p = clamp((state.time - m.departAt) / Math.max(0.1, m.travel), 0, 1);
      const x = lerp(from.pos.x, to.pos.x, p);
      const z = lerp(from.pos.z, to.pos.z, p);
      const line = g.children[0];
      const arr = line.geometry.attributes.position.array;
      arr[0] = from.pos.x; arr[1] = 1.4; arr[2] = from.pos.z;
      arr[3] = to.pos.x; arr[4] = 1.4; arr[5] = to.pos.z;
      line.geometry.attributes.position.needsUpdate = true;
      line.material.color.set(color);
      line.material.opacity = m.phase === 'return' ? 0.18 : 0.32;
      const dot = g.children[1];
      dot.position.set(x, 3.4 + Math.sin(this.time * 6 + i) * 0.5, z);
      dot.material.color.set(color);
      dot.rotation.y = this.time * 2;
      const glow = g.children[2];
      glow.position.set(x, 0.25, z);
      glow.material.color.set(color);
      glow.material.opacity = 0.3 + Math.sin(this.time * 4 + i) * 0.12;
    }
  }

  _updatePaths(state) {
    /* 공성 중인 성으로 향하는 붉은 선 */
    const lines = [];
    for (const s of state.sieges) {
      const target = state.nations[s.target];
      if (!target) continue;
      for (const a of s.attackers) {
        const from = state.nations[a.slot];
        if (!from) continue;
        lines.push({ from: from.pos, to: target.pos, total: a.total });
      }
    }
    while (this.pathLines.children.length < lines.length) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color: '#ff6a6a', transparent: true, opacity: 0.5 });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.pathLines.add(line);
    }
    for (let i = 0; i < this.pathLines.children.length; i++) {
      const line = this.pathLines.children[i];
      if (i >= lines.length) { line.visible = false; continue; }
      line.visible = true;
      const { from, to } = lines[i];
      const arr = line.geometry.attributes.position.array;
      arr[0] = from.x; arr[1] = 1.2; arr[2] = from.z;
      arr[3] = to.x; arr[4] = 1.2; arr[5] = to.z;
      line.geometry.attributes.position.needsUpdate = true;
      line.material.opacity = 0.28 + Math.sin(this.time * 3 + i) * 0.12;
    }
  }

  /* ------------------------------------------------------------ 카메라 */
  setJoy(x, z) {
    this.joy.x = clamp(x, -1, 1);
    this.joy.z = clamp(z, -1, 1);
  }

  look(dx, dy) {
    const sens = 0.0055;
    this.cam.yaw -= dx * sens;
    this.cam.pitch = clamp(this.cam.pitch - dy * sens, -1.5, 0.72);
    this.autoSpin = 0;
  }

  raise(d) {
    this.cam.y = clamp(this.cam.y + d, 3, 400);
  }

  focus(slot) {
    const entry = this.nations.get(slot);
    if (!entry) return;
    const p = entry.group.position;
    /* 성 바깥쪽에서 성을 내려다본다 */
    const a = Math.atan2(p.z, p.x);
    this.cam.x = p.x + Math.cos(a) * 30;
    this.cam.z = p.z + Math.sin(a) * 30;
    this.cam.y = 44;
    this.cam.yaw = Math.atan2(p.x - this.cam.x, p.z - this.cam.z);
    this.cam.pitch = -0.62;
    this.focusSlot = slot;
  }

  overview() {
    this.cam.x = 0;
    this.cam.z = 132;
    this.cam.y = 160;
    this.cam.yaw = Math.PI;
    this.cam.pitch = -0.90;
    this.focusSlot = -1;
  }

  _updateCamera(dt) {
    const s = this.cam;
    const mag = Math.min(1, Math.hypot(this.joy.x, this.joy.z));
    if (mag > 0.08) {
      const speed = 46 * mag;
      const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
      const dx = sinY * this.joy.z - cosY * this.joy.x;
      const dz = cosY * this.joy.z + sinY * this.joy.x;
      s.x += dx * speed * dt;
      s.z += dz * speed * dt;
      s.y = clamp(s.y + Math.sin(s.pitch) * this.joy.z * speed * dt, 3, 400);
    }
    s.x = clamp(s.x, -230, 230);
    s.z = clamp(s.z, -230, 230);
    s.y = clamp(s.y, 2.5, 400);
    const cp = Math.cos(s.pitch), sp = Math.sin(s.pitch);
    this.camera.position.set(s.x, s.y, s.z);
    this.camera.lookAt(s.x + Math.sin(s.yaw) * cp * 80, s.y + sp * 80, s.z + Math.cos(s.yaw) * cp * 80);
  }

  resize() {
    if (this._resize) this._resize();
  }

  /* -------------------------------------------------------------- 프레임 */
  update(state, dt) {
    this.time += dt;
    const now = performance.now() / 1000;
    this.lastState = state;
    this.syncNations(state.nations);
    for (const n of state.nations) {
      const entry = this.nations.get(n.slot);
      if (!entry) continue;
      this._applyDamageVisual(entry, n, now);
      if (entry.label) {
        const d = Math.hypot(this.cam.x - n.pos.x, this.cam.z - n.pos.z, this.cam.y);
        entry.label.material.opacity = n.alive ? clamp((d - 28) / 30, 0, 1) : 0.35;
      }
    }
    this._updateUnits(state, dt, now);
    this._updateMarches(state);
    this._updatePaths(state);
    this._updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
  }
}

export { NATION_COLORS, TYPE_KEYS, TYPE_TINT, TYPE_SCALE };
