/* =============================================================================
   fx.js — 타격·마법·상흔·파편·검기·연기·불빛
   -----------------------------------------------------------------------------
   · 무기 접촉 프레임에 맞춰 스파크/파편/상흔/히트스톱/카메라 흔들림
   · 화염 폭발 · 연쇄 번개 · 빙결 파동 전용 이펙트
   · 접지 그림자 · 피 묻은 자국 · 땅이 갈라지는 충격파
   ============================================================================= */
import * as THREE from 'three';
import { glowTexture, smokeTexture, arcTexture, woundTexture, flameTexture, blobTexture, petalTexture, scorchTexture } from './textures.js';
import { clamp, lerp, mulberry32, TAU, easeOutCubic } from './util.js';
import { CLASSES, SPELLS, SKILL, impactAt } from './config.js';
import { J } from './rig.js';

/* ---------------------------------------------------------------------------
   파티클 (가산 광 / 일반 합성 연기)
   --------------------------------------------------------------------------- */
const P_VERT = `
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
  gl_PointSize = clamp(aSize * uScale / max(0.6, -mv.z), 1.0, 110.0);
  gl_Position = projectionMatrix * mv;
}`;
const P_FRAG = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  if (t.a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
}`;
const P_FRAG_ADD = `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.rgb * vAlpha, t.a * vAlpha);
}`;

class Particles {
  constructor(scene, cap, map, additive, scale) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.fade = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: scale || 620 } },
      vertexShader: P_VERT,
      fragmentShader: additive ? P_FRAG_ADD : P_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  spawn(o) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else i = (Math.random() * this.cap) | 0;
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
    this.col[i3] = o.r === undefined ? 1 : o.r;
    this.col[i3 + 1] = o.g === undefined ? 1 : o.g;
    this.col[i3 + 2] = o.b === undefined ? 1 : o.b;
    this.size[i] = o.size || 0.2;
    this.life[i] = o.life || 0.5;
    this.maxLife[i] = this.life[i];
    this.alpha[i] = o.alpha === undefined ? 1 : o.alpha;
    this.grav[i] = o.gravity === undefined ? -6 : o.gravity;
    this.drag[i] = o.drag === undefined ? 1.5 : o.drag;
    this.grow[i] = o.grow === undefined ? 0 : o.grow;
    this.fade[i] = o.fade === undefined ? 1 : o.fade;
    return i;
  }

  update(dt) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) {
          const i3 = i * 3, l3 = last * 3;
          this.pos[i3] = this.pos[l3]; this.pos[i3 + 1] = this.pos[l3 + 1]; this.pos[i3 + 2] = this.pos[l3 + 2];
          this.vel[i3] = this.vel[l3]; this.vel[i3 + 1] = this.vel[l3 + 1]; this.vel[i3 + 2] = this.vel[l3 + 2];
          this.col[i3] = this.col[l3]; this.col[i3 + 1] = this.col[l3 + 1]; this.col[i3 + 2] = this.col[l3 + 2];
          this.size[i] = this.size[last]; this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
          this.alpha[i] = this.alpha[last]; this.grav[i] = this.grav[last]; this.drag[i] = this.drag[last];
          this.grow[i] = this.grow[last]; this.fade[i] = this.fade[last];
        }
        continue;
      }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dr + this.grav[i] * dt;
      this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.02) {
        this.pos[i3 + 1] = 0.02;
        this.vel[i3 + 1] *= -0.24;
        this.vel[i3] *= 0.62; this.vel[i3 + 2] *= 0.62;
      }
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.pow(clamp(t, 0, 1), this.fade[i]);
    }
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

/* ---------------------------------------------------------------------------
   검기 궤적 리본
   --------------------------------------------------------------------------- */
class Trail {
  constructor(scene, color, n) {
    this.n = n || 12;
    this.samples = [];
    this.color = new THREE.Color(color);
    const cap = this.n * 2;
    this.pos = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap);
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main(){ gl_FragColor = vec4(uColor * vA * 1.6, vA); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this.mesh.visible = false;
    this.active = false;
  }
  push(base, tip, dt, k) {
    this.samples.unshift({ b: base.clone(), t: tip.clone(), age: 0 });
    if (this.samples.length > this.n) this.samples.pop();
    this.active = true;
    this.k = k === undefined ? 1 : k;
  }
  update(dt) {
    if (!this.samples.length) { this.mesh.visible = false; return; }
    for (const s of this.samples) s.age += dt;
    // 수명 지난 샘플 제거
    while (this.samples.length && this.samples[this.samples.length - 1].age > 0.19) this.samples.pop();
    if (this.samples.length < 2) { this.samples.length = 0; this.mesh.visible = false; return; }
    const n = this.samples.length;
    for (let i = 0; i < this.n; i++) {
      const s = this.samples[Math.min(i, n - 1)];
      const a = i < n ? Math.pow(1 - s.age / 0.19, 1.6) * (this.k || 1) : 0;
      const i6 = i * 6;
      this.pos[i6] = s.b.x; this.pos[i6 + 1] = s.b.y; this.pos[i6 + 2] = s.b.z;
      this.pos[i6 + 3] = s.t.x; this.pos[i6 + 4] = s.t.y; this.pos[i6 + 5] = s.t.z;
      this.alpha[i * 2] = a * 0.15;
      this.alpha[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.mesh.visible = true;
  }
  clear() { this.samples.length = 0; this.mesh.visible = false; }
}

/* ---------------------------------------------------------------------------
   전장 이펙트 매니저
   --------------------------------------------------------------------------- */
export class FX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.rng = mulberry32(777);
    this.sparks = new Particles(scene, 1200, glowTexture('rgba(255,255,255,1)', 'rgba(255,190,80,0.35)'), true, 700);
    this.dust = new Particles(scene, 900, smokeTexture(), false, 900);
    this.mist = new Particles(scene, 500, glowTexture('rgba(255,255,255,1)', 'rgba(200,235,255,0.3)'), true, 620);
    this.petals = new Particles(scene, 700, petalTexture(), false, 520);
    this.time = 0;
    this.shake = 0;
    this.flashT = 0;
    this.hitFlash = 0;

    this.woundTex = { blade: woundTexture('blade'), crush: woundTexture('crush') };
    this.arcTex = { blade: arcTexture('blade'), heavy: arcTexture('heavy'), ice: arcTexture('ice') };
    this.flameTex = flameTexture();

    /* 상흔 데칼 풀 */
    this.wounds = [];
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
        map: this.woundTex.blade, transparent: true, opacity: 0, roughness: 0.72, metalness: 0.05,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide,
        color: 0xffffff
      }));
      m.matrixAutoUpdate = false;
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.wounds.push({ mesh: m, unit: null, life: 0, max: 4, local: new THREE.Matrix4() });
    }
    this.woundIdx = 0;

    /* 검기 섬광 (초승달) */
    this.arcs = [];
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.arcTex.blade, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, color: 0xffffff
      }));
      m.matrixAutoUpdate = true;   // 위치·회전·스케일이 매 프레임 반영되어야 검기가 제자리에 그려진다
      m.visible = false;
      m.renderOrder = 7;
      scene.add(m);
      this.arcs.push({ mesh: m, life: 0, max: 0.18, scale: 1 });
    }
    this.arcIdx = 0;

    /* 충격파 링 */
    this.rings = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.0, 56, 1), new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide
      }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 6;
      scene.add(m);
      this.rings.push({ mesh: m, life: 0, max: 0.5, r: 1 });
    }
    this.ringIdx = 0;

    /* 폭발 구체 */
    this.blasts = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({
        color: 0xffb070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      m.visible = false;
      m.renderOrder = 6;
      scene.add(m);
      this.blasts.push({ mesh: m, life: 0, max: 0.38, r: 2 });
    }
    this.blastIdx = 0;

    /* 화염구 */
    this.fireballs = [];
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffe0a0 }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flameTex, color: 0xff9a3c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      glow.scale.set(2.2, 2.6, 1);
      g.add(core); g.add(glow);
      g.visible = false;
      scene.add(g);
      this.fireballs.push({ g, light: null, used: false });
    }

    /* 번개 줄기 */
    this.bolts = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      g.visible = false;
      scene.add(g);
      this.bolts.push({ g, life: 0, max: 0.3 });
    }
    this.boltIdx = 0;

    /* 얼음 파편 (인스턴스) */
    const shardGeo = new THREE.ConeGeometry(0.16, 0.9, 5);
    shardGeo.translate(0, 0.45, 0);
    this.shardMesh = new THREE.InstancedMesh(shardGeo, new THREE.MeshPhysicalMaterial({
      color: 0xa8e4ff, metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.82,
      emissive: 0x2a6f9a, emissiveIntensity: 0.5, envMapIntensity: 1.8, clearcoat: 1
    }), 90);
    this.shardMesh.frustumCulled = false;
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 90; i++) this.shardMesh.setMatrixAt(i, hide);
    scene.add(this.shardMesh);
    this.shards = [];

    /* 얼어붙은 껍질 */
    this.shells = [];
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0), new THREE.MeshPhysicalMaterial({
        color: 0xbfefff, metalness: 0.05, roughness: 0.05, transparent: true, opacity: 0.32,
        emissive: 0x4a9ac8, emissiveIntensity: 0.35, envMapIntensity: 2.0, flatShading: true, depthWrite: false
      }));
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.shells.push({ mesh: m, unit: null, life: 0 });
    }

    /* 파편 (돌·재) */
    const dg = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    this.debris = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ color: 0x6a6156, roughness: 0.95, metalness: 0.05 }), 70);
    this.debris.frustumCulled = false;
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hid2 = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 70; i++) this.debris.setMatrixAt(i, hid2);
    scene.add(this.debris);
    this.debrisData = [];

    /* 불빛 번쩍임 */
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffb070, 0, 26, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push({ l, life: 0, max: 0.3, peak: 40 });
    }

    /* 검기 리본 (플레이어 + 근접 AI) */
    this.trailPool = [];
    for (let i = 0; i < 8; i++) {
      this.trailPool.push(new Trail(scene, 0x8fd0ff, 12));
    }
    this.trailIdx = 0;
    this.playerTrail = new Trail(scene, 0xbfe6ff, 14);
    this.playerTrail.k = 1.4;

    /* 불꽃 덩어리 · 연기 기둥 (폭발용 스프라이트 풀) */
    this.puffs = [];
    for (let i = 0; i < 46; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flameTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: 0, fog: false
      }));
      s.visible = false;
      s.renderOrder = 7;
      scene.add(s);
      this.puffs.push({ s, life: 0, max: 0.5, v: new THREE.Vector3(), grow: 1, spin: 0, a0: 1 });
    }
    this.puffIdx = 0;
    this.smokePuffs = [];
    for (let i = 0; i < 30; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokeTexture(), transparent: true, depthWrite: false, opacity: 0, fog: false
      }));
      s.visible = false;
      s.renderOrder = 5;
      scene.add(s);
      this.smokePuffs.push({ s, life: 0, max: 1.5, v: new THREE.Vector3(), grow: 1, a0: 0.5 });
    }
    this.smokeIdx = 0;

    /* 바닥 그을음 · 균열 데칼 */
    this.scorches = [];
    const scTex = scorchTexture();
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: scTex, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, color: 0xffffff, fog: true
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.035;
      m.renderOrder = 2;
      m.visible = false;
      scene.add(m);
      this.scorches.push({ m, life: 0, max: 9, r: 3 });
    }
    this.scorchIdx = 0;

    /* 접지 그림자 */
    this.shadowMesh = null;

    /* 먼지 발자국 타이머 */
    this.footT = 0;
  }

  buildShadows(units) {
    if (this.shadowMesh) { this.scene.remove(this.shadowMesh); this.shadowMesh.geometry.dispose(); this.shadowMesh = null; }
    if (!units || !units.length) { this.shadowUnits = null; return; }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, opacity: 0.55, depthWrite: false,
      color: 0x000000, blending: THREE.NormalBlending
    });
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, units.length));
    m.frustumCulled = false;
    m.renderOrder = 1;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < units.length; i++) m.setMatrixAt(i, hide);
    this.scene.add(m);
    this.shadowMesh = m;
    this.shadowUnits = units;
  }

  addShake(v) { this.shake = Math.min(1.4, this.shake + v); }

  /* --------------------------------------------------------------- 이벤트 */
  handle(events, battle) {
    for (const e of events) {
      switch (e.type) {
        case 'hit': this.onHit(e, battle); break;
        case 'death': this.onDeath(e, battle); break;
        case 'slam': this.onSlam(e, battle); break;
        case 'lightning': this.onLightning(e, battle); break;
        case 'ice': this.onIce(e, battle); break;
        case 'explode': this.onExplode(e, battle); break;
        case 'cast': this.onCast(e, battle); break;
        case 'playerDown': this.hitFlash = 1; break;
        case 'levelUp': this.onLevelUp(e, battle); break;
        case 'petalDash': this.onPetalDash(e, battle); break;
        default: break;
      }
    }
  }

  unitPoint(u, jname, lx, ly, lz, out) {
    const m = u.joints[J[jname]];
    out.set(lx, ly, lz).applyMatrix4(m);
    return out;
  }

  onHit(e, battle) {
    const s = e.source, t = e.target;
    const rng = this.rng;
    const px = e.hx, pz = e.hz, py = e.hy;
    const dist = this.camera.position.distanceTo(_v1.set(px, py, pz));
    const near = dist < 34;
    const heavy = e.kind === 'hammer';
    const petal = e.kind === 'petal';
    this.addShake(heavy ? 0.30 : 0.10);
    if (t.isPlayer) { this.hitFlash = Math.max(this.hitFlash, 0.6); this.addShake(0.22); }

    // 상흔
    this.spawnWound(t, heavy ? 'crush' : 'blade', e.angle);
    if (petal) {
      for (let i = 0; i < 22; i++) {
        const a2 = this.rng() * TAU;
        this.petals.spawn({
          x: px, y: py, z: pz,
          vx: Math.cos(a2) * (0.5 + this.rng() * 3.0), vy: 0.4 + this.rng() * 2.4, vz: Math.sin(a2) * (0.5 + this.rng() * 3.0),
          life: 0.7 + this.rng() * 0.9, size: 0.07 + this.rng() * 0.08,
          r: 1, g: 0.82, b: 0.92, alpha: 0.95, gravity: -3.2, drag: 1.4, grow: 0.05, fade: 1.1
        });
      }
      this.spawnArc(px, py, pz, e.angle || 0, 2.1, 'blade', 0.16, 0xffb4d8);
      this.flash(px, py, pz, 0.8, 0xffd0e8, 0.1);
    }
    // 불꽃
    const n = near ? (heavy ? 30 : 18) : (heavy ? 12 : 7);
    const ax = s ? s.x : px, az = s ? s.z : pz;
    const dirx = (px - ax), dirz = (pz - az);
    const dl = Math.hypot(dirx, dirz) || 1;
    for (let i = 0; i < n; i++) {
      const spread = heavy ? 1.5 : 1.0;
      const vx = (dirx / dl) * (2 + rng() * 4) + (rng() - 0.5) * 6 * spread;
      const vy = (0.4 + rng() * 1.6) * (heavy ? 1.3 : 1);
      const vz = (dirz / dl) * (2 + rng() * 4) + (rng() - 0.5) * 6 * spread;
      const hot = rng();
      this.sparks.spawn({
        x: px + (rng() - 0.5) * 0.18, y: py + (rng() - 0.5) * 0.3, z: pz + (rng() - 0.5) * 0.18,
        vx, vy, vz, life: 0.18 + rng() * 0.36,
        size: 0.05 + rng() * 0.10,
        r: 1, g: hot > 0.55 ? 0.85 : 0.6, b: hot > 0.55 ? 0.6 : 0.25,
        gravity: -12, drag: 2.2, fade: 1.4
      });
    }
    // 피 (어두운 붉은 mist)
    for (let i = 0; i < (near ? 7 : 3); i++) {
      const a = rng() * TAU;
      this.dust.spawn({
        x: px, y: py, z: pz,
        vx: Math.cos(a) * (0.5 + rng() * 2.2), vy: 0.3 + rng() * 1.7, vz: Math.sin(a) * (0.5 + rng() * 2.2),
        life: 0.28 + rng() * 0.35, size: 0.14 + rng() * 0.3,
        r: 0.34, g: 0.03, b: 0.03, alpha: 0.6, gravity: -5, drag: 2.6, grow: 0.6, fade: 1.5
      });
    }
    // 타격 섬광
    this.flash(px, py, pz, heavy ? 1.5 : 0.85, heavy ? 0xffcf80 : 0xffffff, 0.10);
    // 검기 섬광
    if (!heavy && near) {
      this.spawnArc(px, py, pz, e.angle || (s ? s.yaw : 0), 1.5 + rng() * 0.3, 'blade', 0.15, petal ? 0xffb4d8 : undefined);
    }
    if (heavy && near) {
      this.ring(px, 0.06, pz, 2.4, 0xc9a06a, 0.35);
    }
  }

  onDeath(e, battle) {
    const u = e.unit;
    // 사망 시 피가 튀는 연출 (모션 시작점)
    const px = u.x, pz = u.z;
    const dist = this.camera.position.distanceTo(_v1.set(px, 1.2, pz));
    if (dist < 45) {
      for (let i = 0; i < 12; i++) {
        const a = this.rng() * TAU;
        this.dust.spawn({
          x: px, y: 1.1, z: pz,
          vx: Math.cos(a) * (0.4 + this.rng() * 1.6), vy: 0.2 + this.rng() * 1.2, vz: Math.sin(a) * (0.4 + this.rng() * 1.6),
          life: 0.35 + this.rng() * 0.4, size: 0.2 + this.rng() * 0.35,
          r: 0.32, g: 0.02, b: 0.02, alpha: 0.55, gravity: -6, drag: 2.2, grow: 0.5
        });
      }
    }
    if (u.isPlayer) this.addShake(0.5);
  }

  onSlam(e, battle) {
    const u = e.unit;
    if (!u) return;
    const x = e.x, z = e.z;
    const dist = this.camera.position.distanceTo(_v1.set(x, 0, z));
    this.addShake(dist < 22 ? 0.55 : 0.2);
    if (dist > 60) return;
    // 땅 갈라짐 + 먼지
    this.ring(x, 0.05, z, 3.2, 0xd8b070, 0.45);
    for (let i = 0; i < 22; i++) {
      const a = this.rng() * TAU;
      const sp = 1.6 + this.rng() * 4.4;
      this.dust.spawn({
        x: x + Math.cos(a) * 0.3, y: 0.1, z: z + Math.sin(a) * 0.3,
        vx: Math.cos(a) * sp, vy: 0.6 + this.rng() * 1.6, vz: Math.sin(a) * sp,
        life: 0.45 + this.rng() * 0.6, size: 0.4 + this.rng() * 0.7,
        r: 0.62, g: 0.52, b: 0.4, alpha: 0.5, gravity: 0.6, drag: 1.8, grow: 1.2, fade: 1.4
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = this.rng() * TAU;
      this.spawnDebris(x, 0.1, z, Math.cos(a) * (2 + this.rng() * 4), 3 + this.rng() * 4, Math.sin(a) * (2 + this.rng() * 4), 1.0);
    }
    for (let i = 0; i < 14; i++) {
      const a = this.rng() * TAU;
      this.sparks.spawn({
        x: x, y: 0.1, z: z, vx: Math.cos(a) * (2 + this.rng() * 5), vy: 1 + this.rng() * 3,
        vz: Math.sin(a) * (2 + this.rng() * 5), life: 0.2 + this.rng() * 0.3,
        size: 0.06 + this.rng() * 0.08, r: 1, g: 0.7, b: 0.35, gravity: -14, drag: 1.5
      });
    }
    this.flash(x, 0.5, z, 2.4, 0xffc080, 0.2);
    if (dist < 30) this.flashGround(x, z, 2.2);
  }

  onCast(e, battle) {
    const u = e.unit;
    if (!u) return;
    const k = e.spell;
    const colors = { fire: [1, 0.55, 0.18], lightning: [0.6, 0.9, 1], ice: [0.7, 0.95, 1] };
    const c = colors[k] || [1, 1, 1];
    const m = u.joints[J.handL];
    _v1.set(0, 1.0, 0.02).applyMatrix4(m);
    if (u.isPlayer) this.addShake(0.06);
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * TAU;
      this.sparks.spawn({
        x: _v1.x + Math.cos(a) * 0.2, y: _v1.y + (this.rng() - 0.5) * 0.3, z: _v1.z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * 0.8, vy: 0.8 + this.rng(), vz: Math.sin(a) * 0.8,
        life: 0.25 + this.rng() * 0.3, size: 0.05 + this.rng() * 0.06,
        r: c[0], g: c[1], b: c[2], gravity: 1.2, drag: 2.5
      });
    }
  }

  onExplode(e, battle) {
    const x = e.x, z = e.z, r = e.radius || 3.5;
    const dist = this.camera.position.distanceTo(_v1.set(x, 0, z));
    const near = dist < 34;
    this.addShake(dist < 30 ? 0.72 : 0.22);

    /* 1) 충격 명편 — 바닥을 훑는 두 겹의 파동 + 밀려나는 먼지 */
    this.ring(x, 0.07, z, r * 1.75, 0xffd8a0, 0.5);
    this.ring(x, 0.11, z, r * 1.05, 0xfff4d0, 0.32);
    for (let i = 0; i < 30; i++) {
      const a = this.rng() * TAU;
      this.dust.spawn({
        x: x + Math.cos(a) * 0.5, y: 0.12, z: z + Math.sin(a) * 0.5,
        vx: Math.cos(a) * (3 + this.rng() * 5), vy: 0.3 + this.rng() * 1.2, vz: Math.sin(a) * (3 + this.rng() * 5),
        life: 0.55 + this.rng() * 0.7, size: 0.45 + this.rng() * 0.8,
        r: 0.66, g: 0.56, b: 0.44, alpha: 0.42, gravity: 0.3, drag: 2.2, grow: 1.3, fade: 1.2
      });
    }

    /* 2) 다층 발광 코어 — 흰 중심 → 주황 불기둥 → 붉은 잔열 */
    const b0 = this.blasts[this.blastIdx++ % this.blasts.length];
    b0.mesh.position.set(x, 1.05, z);
    b0.mesh.scale.setScalar(r * 0.32);
    b0.mesh.material.color.setHex(0xfff2d0);
    b0.mesh.material.opacity = 1;
    b0.mesh.visible = true;
    b0.life = 0; b0.max = 0.2; b0.r = r * 0.52;
    const b1 = this.blasts[this.blastIdx++ % this.blasts.length];
    b1.mesh.position.set(x, 1.25, z);
    b1.mesh.scale.setScalar(r * 0.28);
    b1.mesh.material.color.setHex(0xff8c2e);
    b1.mesh.material.opacity = 0.92;
    b1.mesh.visible = true;
    b1.life = 0; b1.max = 0.34; b1.r = r * 0.72;

    /* 3) 솟구치는 불꽃 덩어리 — 공 모양이 아니라 위로 피어오르는 혀 모양 */
    const tongues = near ? 16 : 8;
    for (let i = 0; i < tongues; i++) {
      const a = this.rng() * TAU;
      const rad = Math.pow(this.rng(), 0.6) * r * 0.75;
      const p = this.puffs[this.puffIdx++ % this.puffs.length];
      p.s.position.set(x + Math.cos(a) * rad, 0.35 + this.rng() * 0.7, z + Math.sin(a) * rad);
      const sc = 1.1 + this.rng() * 2.3;
      p.s.scale.set(sc * 0.9, sc * 1.35, 1);
      p.s.material.color.setHSL(0.045 + this.rng() * 0.045, 0.98, 0.46 + this.rng() * 0.1);
      p.s.material.rotation = this.rng() * TAU;
      p.s.visible = true;
      p.life = 0; p.max = 0.34 + this.rng() * 0.45;
      p.v.set(Math.cos(a) * (0.8 + this.rng() * 2.0), 1.4 + this.rng() * 3.4, Math.sin(a) * (0.8 + this.rng() * 2.0));
      p.grow = 2.6 + this.rng() * 2.4;
      p.a0 = 0.62;
    }

    /* 4) 불티 파티클 */
    for (let i = 0; i < 84; i++) {
      const a = this.rng() * TAU;
      const sp = 1.5 + this.rng() * 9;
      this.sparks.spawn({
        x: x + Math.cos(a) * 0.35, y: 0.5 + this.rng() * 1.0, z: z + Math.sin(a) * 0.35,
        vx: Math.cos(a) * sp, vy: 0.8 + this.rng() * 7, vz: Math.sin(a) * sp,
        life: 0.35 + this.rng() * 0.75, size: 0.05 + this.rng() * 0.14,
        r: 1, g: 0.45 + this.rng() * 0.5, b: 0.12, gravity: -6.5, drag: 1.35, fade: 1.25
      });
    }
    /* 타는 재 — 어둡게 날아 올랐다가 천천히 흩어진다 */
    for (let i = 0; i < 18; i++) {
      const a = this.rng() * TAU;
      this.dust.spawn({
        x: x + Math.cos(a) * 0.4, y: 1.2 + this.rng(), z: z + Math.sin(a) * 0.4,
        vx: Math.cos(a) * (1 + this.rng() * 2.6), vy: 1.4 + this.rng() * 3.4, vz: Math.sin(a) * (1 + this.rng() * 2.6),
        life: 0.9 + this.rng() * 1.1, size: 0.16 + this.rng() * 0.28,
        r: 0.16, g: 0.14, b: 0.13, alpha: 0.55, gravity: -0.4, drag: 1.1, grow: 0.6
      });
    }

    /* 5) 상승 연기 기둥 */
    const smokeN = near ? 16 : 8;
    for (let i = 0; i < smokeN; i++) {
      const sp = this.smokePuffs[this.smokeIdx++ % this.smokePuffs.length];
      const a = this.rng() * TAU, rad = Math.pow(this.rng(), 0.5) * r * 0.55;
      sp.s.position.set(x + Math.cos(a) * rad, 1.0 + this.rng() * 0.8, z + Math.sin(a) * rad);
      const sc = 1.4 + this.rng() * 2.2;
      sp.s.scale.set(sc, sc * 0.85, 1);
      sp.s.material.color.setHSL(0.05, 0.35, 0.10 + this.rng() * 0.07);
      sp.s.material.rotation = this.rng() * TAU;
      sp.s.material.opacity = 0;
      sp.s.visible = true;
      sp.life = 0; sp.max = 1.3 + this.rng() * 1.1;
      sp.v.set(Math.cos(a) * (0.5 + this.rng() * 1.2), 1.1 + this.rng() * 1.5, Math.sin(a) * (0.5 + this.rng() * 1.2));
      sp.grow = 1.5 + this.rng() * 1.1;
      sp.a0 = 0.34 + this.rng() * 0.16;
    }

    /* 6) 바닥 균열 · 그을음 데칼 */
    const sc = this.scorches[this.scorchIdx++ % this.scorches.length];
    sc.m.position.set(x, 0.035, z);
    sc.m.scale.setScalar(r * 2.3);
    sc.m.material.opacity = 0;
    sc.m.visible = true;
    sc.life = 0; sc.max = 9; sc.r = r;

    /* 7) 재 · 돌 조각 · 섬광 */
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * TAU;
      this.spawnDebris(x, 0.3, z, Math.cos(a) * (3 + this.rng() * 6), 4 + this.rng() * 5, Math.sin(a) * (3 + this.rng() * 6), 1.2);
    }
    this.flash(x, 1.1, z, r * 0.5, 0xffc07a, 0.12);
    this.flashGround(x, z, r * 0.95);
    this.lightFlash(x, 1.5, z, 0xff9a40, 0.42, 62);
  }

  onLightning(e, battle) {
    const targets = e.targets || [];
    const u = e.unit;
    if (!targets.length) return;
    const color = 0xbfe8ff;
    let prev = null;
    const from = this.unitPoint(u, 'handL', 0, 1.0, 0.02, new THREE.Vector3());
    const b = this.bolts[this.boltIdx++ % this.bolts.length];
    b.g.clear();
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const mat2 = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti].o;
      const tx = t.x, tz = t.z, ty = 1.15 * (t.scale || 1);
      // 하늘에서 내리꽂는 줄기
      const pts = [];
      const start = new THREE.Vector3(tx + (this.rng() - 0.5) * 3, 17 + this.rng() * 4, tz + (this.rng() - 0.5) * 3);
      const mid = new THREE.Vector3((start.x + tx) / 2, 8, (start.z + tz) / 2);
      const q0 = new THREE.QuadraticBezierCurve3(start, mid, new THREE.Vector3(tx, ty, tz));
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const p = q0.getPoint(i / N);
        p.x += (this.rng() - 0.5) * 0.9;
        p.z += (this.rng() - 0.5) * 0.9;
        pts.push(p);
      }
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(lg, mat);
      b.g.add(line);
      const line2 = new THREE.Line(lg, mat2);
      line2.scale.setScalar(1.0);
      b.g.add(line2);
      // 연쇄
      if (prev) {
        const cp = [];
        for (let i = 0; i <= 8; i++) {
          const k = i / 8;
          cp.push(new THREE.Vector3(
            lerp(prev.x, tx, k) + (this.rng() - 0.5) * 0.5,
            lerp(prev.y || 1.15, ty, k) + Math.sin(k * Math.PI) * 0.6,
            lerp(prev.z, tz, k) + (this.rng() - 0.5) * 0.5));
        }
        b.g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cp), mat));
      }
      prev = { x: tx, z: tz, y: ty };
      // 대상 주변 스파크
      for (let i = 0; i < 18; i++) {
        const a = this.rng() * TAU;
        this.sparks.spawn({
          x: tx, y: ty + (this.rng() - 0.5) * 0.8, z: tz,
          vx: Math.cos(a) * (1 + this.rng() * 4), vy: 0.3 + this.rng() * 3, vz: Math.sin(a) * (1 + this.rng() * 4),
          life: 0.2 + this.rng() * 0.35, size: 0.06 + this.rng() * 0.1,
          r: 0.7, g: 0.95, b: 1, gravity: -6, drag: 2.2
        });
      }
      this.flash(tx, ty, tz, 1.9, 0xcfefff, 0.18);
      this.flashGround(tx, tz, 1.0);
    }
    // 시작 손에서도
    b.g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      from, new THREE.Vector3(from.x, from.y + 3, from.z)]), mat));
    b.life = 0; b.max = 0.28;
    b.g.visible = true;
    this.addShake(0.22);
    this.lightFlash(prev.x, 2, prev.z, 0xaad8ff, 0.25, 55);
    // 다 쓴 지오메트리는 잠시 후 정리
    b.deadlines = b.deadlines || [];
    b.deadlines.push({ t: this.time + 1.2, g: b.g });
  }

  onIce(e, battle) {
    const u = e.unit;
    const radius = e.radius || 7.4;
    const targets = e.targets || [];
    const yaw = u ? u.yaw : 0;
    const ox = u ? u.x : 0, oz = u ? u.z : 0;
    this.addShake(0.3);
    // 부채꼴 서리 파동 (링 여러 겹)
    for (let i = 0; i < 4; i++) {
      const p = i / 4;
      const rr = 1.5 + p * radius;
      this.ringSector(ox, oz, yaw, rr, 0.6, 0xbfefff, 0.45, e.halfAngle || 1.0);
    }
    // 얼음 파편
    const n = 24 + Math.min(20, targets.length * 5);
    for (let i = 0; i < n; i++) {
      const a = yaw + (this.rng() - 0.5) * 2 * (e.halfAngle || 1.0);
      const d = 0.8 + Math.pow(this.rng(), 0.7) * radius;
      this.spawnShard(ox + Math.sin(a) * d, oz + Math.cos(a) * d, 0.7 + this.rng() * 1.8);
    }
    // 서리 안개
    for (let i = 0; i < 30; i++) {
      const a = yaw + (this.rng() - 0.5) * 2 * (e.halfAngle || 1.0);
      const d = this.rng() * radius;
      this.mist.spawn({
        x: ox + Math.sin(a) * d, y: 0.2 + this.rng() * 0.8, z: oz + Math.cos(a) * d,
        vx: Math.sin(a) * 1.4, vy: 0.3 + this.rng() * 0.6, vz: Math.cos(a) * 1.4,
        life: 0.5 + this.rng() * 0.7, size: 0.3 + this.rng() * 0.7,
        r: 0.7, g: 0.92, b: 1, gravity: 0.2, drag: 1.6, grow: 0.9, fade: 1.4
      });
    }
    for (const ht of targets) {
      const t = ht.o;
      this.attachShell(t, 3.0);
      for (let i = 0; i < 10; i++) {
        const a = this.rng() * TAU;
        this.sparks.spawn({
          x: t.x, y: 1.0, z: t.z, vx: Math.cos(a) * 2, vy: 0.5 + this.rng() * 2, vz: Math.sin(a) * 2,
          life: 0.3 + this.rng() * 0.3, size: 0.05 + this.rng() * 0.08,
          r: 0.75, g: 0.95, b: 1, gravity: -3, drag: 2
        });
      }
    }
    this.flash(ox + Math.sin(yaw) * 3, 1.1, oz + Math.cos(yaw) * 3, 2.2, 0xd8f4ff, 0.22);
    this.lightFlash(ox, 1.2, oz, 0x9fdcff, 0.2, 40);
  }

  onPetalDash(e, battle) {
    const u = e.unit;
    if (!u) return;
    this.addShake(u.isPlayer ? 0.18 : 0.08);
    for (let i = 0; i < 22; i++) {
      const a = this.rng() * TAU;
      this.petals.spawn({
        x: u.x + Math.cos(a) * 0.5, y: 0.5 + this.rng() * 1.0, z: u.z + Math.sin(a) * 0.5,
        vx: Math.cos(a) * (0.6 + this.rng() * 1.8) + Math.sin(u.yaw) * 2.2,
        vy: 0.6 + this.rng() * 2.0,
        vz: Math.sin(a) * (0.6 + this.rng() * 1.8) + Math.cos(u.yaw) * 2.2,
        life: 0.8 + this.rng() * 0.8, size: 0.07 + this.rng() * 0.08,
        r: 1, g: 0.8, b: 0.92, alpha: 0.95, gravity: -3.0, drag: 1.2, grow: 0.04, fade: 1.1
      });
    }
    this.ring(u.x, 0.06, u.z, 2.2, 0xff9ec8, 0.45);
    // 돌진 궤적을 따라 초승달 검기가 연달아 피어난다
    for (let i = 0; i < 3; i++) {
      const d = 0.9 + i * 1.5;
      this.spawnArc(u.x + Math.sin(u.yaw) * d, 0.75 + i * 0.12, u.z + Math.cos(u.yaw) * d, u.yaw, 1.9 + i * 0.35, 'blade', 0.2, 0xffb4d8);
    }
    this.flashGround(u.x + Math.sin(u.yaw) * 1.4, u.z + Math.cos(u.yaw) * 1.4, 2.4);
  }

  onLevelUp(e, battle) {
    const u = e.unit;
    if (!u) return;
    // 성장의 고리 — 발밑에서 금빛 룬이 퍼진다
    this.ring(u.x, 0.06, u.z, 1.2, 0xffd780, 0.5);
    for (let i = 0; i < 16; i++) {
      const a = this.rng() * TAU;
      this.sparks.spawn({
        x: u.x + Math.cos(a) * 0.3, y: 0.15, z: u.z + Math.sin(a) * 0.3,
        vx: Math.cos(a) * 0.7, vy: 1.2 + this.rng() * 1.2, vz: Math.sin(a) * 0.7,
        life: 0.5 + this.rng() * 0.4, size: 0.05 + this.rng() * 0.08,
        r: 1, g: 0.82, b: 0.4, gravity: 1.4, drag: 2.4
      });
    }
  }

  /* ------------------------------------------------------------- 스폰 도구 */
  flash(x, y, z, size, color, life) {
    const a = this.arcs[this.arcIdx++ % this.arcs.length];
    a.mesh.material.map = this.arcTex.blade;
    a.mesh.material.color.setHex(color);
    a.mesh.material.opacity = 0.9;
    a.mesh.position.set(x, y, z);
    a.mesh.scale.setScalar(size * 1.6);
    a.mesh.visible = true;
    a.life = 0; a.max = life; a.scale = size;
    a.mode = 'flash';
  }

  spawnArc(x, y, z, yaw, size, kind, life, colorHex, roll) {
    // 1) 칼날처럼 선명한 코어
    const a = this.arcs[this.arcIdx++ % this.arcs.length];
    a.mesh.material.map = this.arcTex[kind] || this.arcTex.blade;
    a.mesh.material.color.setHex(colorHex || (kind === 'ice' ? 0xbfefff : 0xf2fbff));
    a.mesh.material.opacity = 0.95;
    a.mesh.position.set(x, y, z);
    a.mesh.rotation.set(0, yaw, roll === undefined ? (this.rng() - 0.5) * 1.1 : roll, 'YXZ');
    a.mesh.scale.setScalar(size * 1.6);
    a.mesh.visible = true;
    a.life = 0; a.max = (life || 0.16) * 1.9; a.scale = size; a.mode = 'arc';
    // 2) 뒤로 번지는 빛무리 — 궤적이 공간에 남아 있게
    const gl = this.arcs[this.arcIdx++ % this.arcs.length];
    gl.mesh.material.map = this.arcTex[kind] || this.arcTex.blade;
    gl.mesh.material.color.setHex(colorHex || (kind === 'ice' ? 0x8fd6ff : 0xffe6b8));
    gl.mesh.material.opacity = 0.3;
    gl.mesh.position.set(x, y, z);
    gl.mesh.rotation.set(0, yaw, a.mesh.rotation.z + 0.1, 'YXZ');
    gl.mesh.scale.setScalar(size * 1.1);
    gl.mesh.visible = true;
    gl.life = 0; gl.max = (life || 0.16) * 3.4; gl.scale = size * 1.25; gl.mode = 'arcGlow';
  }

  /* 플레이어 베기 순간 — 칼날 끝에서 흩날리는 빛가루 */
  spawnBladeSparks(base, tip, cls) {
    const dx = tip.x - base.x, dy = tip.y - base.y, dz = tip.z - base.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const petal = cls === 'blademaster';
    for (let i = 0; i < 2; i++) {
      this.sparks.spawn({
        x: tip.x + (this.rng() - 0.5) * 0.1, y: tip.y + (this.rng() - 0.5) * 0.1, z: tip.z + (this.rng() - 0.5) * 0.1,
        vx: (dx / l) * (1.2 + this.rng() * 2.6) + (this.rng() - 0.5) * 1.2,
        vy: (dy / l) * (1.2 + this.rng() * 2.2) + 0.5,
        vz: (dz / l) * (1.2 + this.rng() * 2.6) + (this.rng() - 0.5) * 1.2,
        life: 0.14 + this.rng() * 0.2, size: 0.03 + this.rng() * 0.05,
        r: petal ? 1 : 0.85, g: petal ? 0.75 : 0.95, b: petal ? 0.9 : 1,
        gravity: -1.2, drag: 3.2, fade: 1.3
      });
    }
    if (petal && this.rng() < 0.7) {
      this.petals.spawn({
        x: tip.x, y: tip.y, z: tip.z,
        vx: (this.rng() - 0.5) * 2, vy: 0.3 + this.rng() * 1.2, vz: (this.rng() - 0.5) * 2,
        life: 0.6 + this.rng() * 0.5, size: 0.07 + this.rng() * 0.07,
        r: 1, g: 0.82, b: 0.94, alpha: 0.95, gravity: -3, drag: 1.4, grow: 0.02, fade: 1.1
      });
    }
  }

  ring(x, y, z, r, color, life) {
    const g = this.rings[this.ringIdx++ % this.rings.length];
    g.mesh.position.set(x, y, z);
    g.mesh.scale.setScalar(0.6);
    g.mesh.material.color.setHex(color);
    g.mesh.material.opacity = 0.85;
    g.mesh.visible = true;
    g.life = 0; g.max = life || 0.5; g.r = r; g.mode = 'ring';
  }

  ringSector(x, z, yaw, r, height, color, life, halfAngle) {
    // 부채꼴 충격파 — 링을 잘라 쓰지 않고 가는 원호 메시
    const segs = 24;
    const geo = new THREE.BufferGeometry();
    const arr = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const a = yaw - halfAngle + (i / segs) * halfAngle * 2;
      const w = (i / segs);
      arr.push(Math.sin(a) * (r - height), 0.06, Math.cos(a) * (r - height));
      arr.push(Math.sin(a) * r, 0.06, Math.cos(a) * r);
      if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    }));
    m.position.set(x, 0, z);
    m.visible = true;
    this.scene.add(m);
    this.sectorFades = this.sectorFades || [];
    this.sectorFades.push({ m, life: 0, max: life || 0.5 });
  }

  spawnWound(unit, kind, angle) {
    const w = this.wounds[this.woundIdx++ % this.wounds.length];
    w.unit = unit;
    w.life = 0;
    w.max = 5;
    w.mesh.material.map = this.woundTex[kind] || this.woundTex.blade;
    const s = kind === 'crush' ? 0.42 : 0.34;
    const px = (this.rng() - 0.5) * 0.16;
    const py = 0.04 + (this.rng() - 0.5) * 0.22;
    w.local.compose(
      new THREE.Vector3(px, py, 0.17),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((this.rng() - 0.5) * 0.3, 0, (angle || 0) + (this.rng() - 0.5) * 0.5)),
      new THREE.Vector3(s, s, s)
    );
    w.mesh.visible = true;
    w.mesh.material.opacity = 1;
  }

  attachShell(unit, duration) {
    let sh = this.shells.find((s) => !s.unit) || this.shells[0];
    sh.unit = unit;
    sh.life = 0;
    sh.max = duration || 1.4;
    sh.mesh.visible = true;
    sh.mesh.scale.setScalar(0.4);
    sh.mesh.material.opacity = 0.42;
  }

  spawnShard(x, z, h) {
    if (this.shards.length > 80) this.shards.shift();
    this.shards.push({ x, z, h, life: 0, max: 0.7 + this.rng() * 0.5, rot: this.rng() * TAU, tilt: (this.rng() - 0.5) * 0.4 });
  }

  spawnDebris(x, y, z, vx, vy, vz, scale) {
    if (this.debrisData.length > 60) this.debrisData.shift();
    this.debrisData.push({ x, y, z, vx, vy, vz, s: scale || 1, rot: this.rng() * TAU, rs: (this.rng() - 0.5) * 12, life: 0 });
  }

  flashGround(x, z, r) {
    // 지면이 밝게 물드는 짧은 데칼
    if (!this.groundFlashPool) {
      this.groundFlashPool = [];
      for (let i = 0; i < 8; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
          map: glowTexture('rgba(255,230,190,0.85)', 'rgba(255,160,70,0.2)'),
          transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
        }));
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.05;
        m.visible = false;
        this.scene.add(m);
        this.groundFlashPool.push({ m, life: 0, max: 0.5 });
      }
      this.groundFlashIdx = 0;
    }
    const g = this.groundFlashPool[this.groundFlashIdx++ % this.groundFlashPool.length];
    g.m.position.set(x, 0.05, z);
    g.m.scale.setScalar(r * 2.4);
    g.m.visible = true;
    g.m.material.opacity = 0.55;
    g.life = 0; g.max = 0.45;
  }

  lightFlash(x, y, z, color, life, peak) {
    const l = this.lights.find((o) => o.life <= 0) || this.lights[0];
    l.l.position.set(x, y, z);
    l.l.color.setHex(color);
    l.l.visible = true;
    l.life = 0; l.max = life; l.peak = peak;
  }

  /* ------------------------------------------------------------- 프레임 갱신 */
  update(dt, battle, camera) {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.4);

    this.sparks.update(dt);
    this.dust.update(dt);
    this.mist.update(dt);
    this.petals.update(dt);

    /* 상흔 — 유닛 관절을 따라간다 */
    for (const w of this.wounds) {
      if (!w.unit) continue;
      w.life += dt;
      const u = w.unit;
      if (!u || u.removed || w.life > w.max) {
        w.mesh.visible = false;
        if (u && (u.removed || w.life > w.max)) w.unit = null;
        continue;
      }
      const jm = u.joints[J.chest];
      _m1.multiplyMatrices(jm, w.local);
      w.mesh.matrix.copy(_m1);
      w.mesh.matrixWorldNeedsUpdate = true;
      const fade = clamp((w.max - w.life) / 0.8, 0, 1);
      w.mesh.material.opacity = u.dead ? Math.min(1, fade + 0.2) : fade;
      w.mesh.visible = true;
    }

    /* 섬광/검기 */
    for (const a of this.arcs) {
      if (a.life > a.max) { a.mesh.visible = false; continue; }
      a.life += dt;
      const k = clamp(1 - a.life / a.max, 0, 1);
      if (a.mode === 'flash') {
        a.mesh.material.opacity = 0.9 * k * k;
        const sc = a.scale * (0.4 + (1 - k) * 0.9);
        a.mesh.scale.set(sc * 1.6, sc * 1.6, 1);
      } else if (a.mode === 'arcGlow') {
        a.mesh.material.opacity = 0.3 * k * k;
        const sc = a.scale * (1.0 + (1 - k) * 0.55);
        a.mesh.scale.set(sc * 1.6, sc * 1.02, 1);
      } else {
        a.mesh.material.opacity = 0.95 * Math.pow(k, 0.6);
        const sc = a.scale * (1.0 + (1 - k) * 0.3);
        a.mesh.scale.set(sc * 1.6, sc * 0.92, 1);
      }
    }

    /* 링 */
    for (const g of this.rings) {
      if (g.life > g.max) { g.mesh.visible = false; continue; }
      g.life += dt;
      const k = clamp(g.life / g.max, 0, 1);
      g.mesh.scale.setScalar(0.6 + k * g.r * 1.8);
      g.mesh.material.opacity = 0.85 * (1 - k) * (1 - k);
    }
    if (this.sectorFades) {
      for (const s of this.sectorFades) {
        s.life += dt;
        const k = clamp(s.life / s.max, 0, 1);
        s.m.material.opacity = 0.7 * (1 - k) * (1 - k);
        if (s.life > s.max) { s.m.visible = false; }
      }
      this.sectorFades = this.sectorFades.filter((s) => s.life <= s.max + 0.2);
    }

    /* 폭발 구체 */
    for (const b of this.blasts) {
      if (b.life > b.max) { b.mesh.visible = false; continue; }
      b.life += dt;
      const k = clamp(b.life / b.max, 0, 1);
      b.mesh.scale.setScalar(b.r * (0.3 + easeOutCubic(k) * 1.05));
      b.mesh.material.opacity = 0.95 * (1 - k) * (1 - k);
    }

    /* 불꽃 덩어리 */
    for (const p of this.puffs) {
      if (p.life > p.max) { if (p.s.visible) p.s.visible = false; continue; }
      p.life += dt;
      const k = clamp(p.life / p.max, 0, 1);
      p.v.multiplyScalar(Math.max(0, 1 - dt * 2.4));
      p.v.y += dt * 2.6;
      p.s.position.addScaledVector(p.v, dt);
      const sc0 = p.s.scale.x;
      p.s.scale.set(sc0 + dt * p.grow * 0.35, sc0 * 1.06 + dt * p.grow * 0.6, 1);
      // 흰 중심 → 주황 → 검붉은 잔열
      const h = 0.09 - k * 0.06;
      p.s.material.color.setHSL(h, 0.95, 0.55 - k * 0.28);
      p.s.material.opacity = p.a0 * (1 - k) * (1 - k * 0.35);
      p.s.material.rotation += dt * 0.6 * (p.spin || 1);
    }
    /* 연기 기둥 */
    for (const sp of this.smokePuffs) {
      if (sp.life > sp.max) { if (sp.s.visible) sp.s.visible = false; continue; }
      sp.life += dt;
      const k = clamp(sp.life / sp.max, 0, 1);
      sp.v.multiplyScalar(Math.max(0, 1 - dt * 0.9));
      sp.v.y += dt * 0.5;
      sp.s.position.addScaledVector(sp.v, dt);
      const sc0 = sp.s.scale.x;
      sp.s.scale.set(sc0 + dt * sp.grow * 0.5, sc0 * 0.9 + dt * sp.grow * 0.4, 1);
      sp.s.material.rotation += dt * 0.18;
      sp.s.material.opacity = sp.a0 * Math.min(1, k * 5) * (1 - k);
    }
    /* 그을음 데칼 */
    for (const sc of this.scorches) {
      if (sc.life > sc.max) { if (sc.m.visible) sc.m.visible = false; continue; }
      sc.life += dt;
      const k = clamp(sc.life / sc.max, 0, 1);
      sc.m.material.opacity = Math.min(1, sc.life / 0.12) * (0.92 - k * 0.55) * clamp((1 - k) * 4, 0, 1);
    }

    /* 화염구 (전투 시뮬의 투사체를 그림) */
    let fi = 0;
    for (const s of (battle ? battle.spells : [])) {
      const f = this.fireballs[fi++ % this.fireballs.length];
      f.g.visible = true;
      f.g.position.set(s.x, s.y, s.z);
      f.g.rotation.y += dt * 8;
      // 꼬리 불티
      for (let i = 0; i < 2; i++) {
        this.sparks.spawn({
          x: s.x + (this.rng() - 0.5) * 0.3, y: s.y + (this.rng() - 0.5) * 0.3, z: s.z + (this.rng() - 0.5) * 0.3,
          vx: -s.vx * 0.06 + (this.rng() - 0.5) * 0.6, vy: (this.rng() - 0.3) * 0.8, vz: -s.vz * 0.06 + (this.rng() - 0.5) * 0.6,
          life: 0.2 + this.rng() * 0.3, size: 0.07 + this.rng() * 0.1,
          r: 1, g: 0.5 + this.rng() * 0.4, b: 0.1, gravity: 0.5, drag: 2.4
        });
      }
      for (let i = 0; i < 1; i++) {
        this.dust.spawn({
          x: s.x, y: s.y, z: s.z, vx: (this.rng() - 0.5) * 0.5, vy: 0.3, vz: (this.rng() - 0.5) * 0.5,
          life: 0.35, size: 0.4, r: 0.22, g: 0.18, b: 0.16, alpha: 0.4, gravity: 0.5, drag: 2, grow: 1.2
        });
      }
    }
    for (let i = fi; i < this.fireballs.length; i++) this.fireballs[i].g.visible = false;

    /* 번개 */
    for (const b of this.bolts) {
      if (b.life > b.max) { if (b.g.visible) b.g.visible = false; continue; }
      b.life += dt;
      const k = clamp(1 - b.life / b.max, 0, 1);
      b.g.traverse((o) => { if (o.isLine) o.material.opacity = k; });
      if (b.life > b.max) b.g.visible = false;
    }
    for (const b of this.bolts) {
      if (b.deadlines) {
        b.deadlines = b.deadlines.filter((d) => {
          if (this.time > d.t) {
            d.g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            d.g.clear();
            return false;
          }
          return true;
        });
      }
    }

    /* 얼음 파편 */
    if (this.shards.length) {
      let i = 0;
      const m4 = _m1, q = _q1, v = _v1, sc = _v2;
      for (const s of this.shards) {
        s.life += dt;
        const k = clamp(s.life / s.max, 0, 1);
        const grow = easeOutCubic(clamp(s.life / 0.12, 0, 1));
        const fade = k > 0.8 ? (1 - k) / 0.2 : 1;
        const hh = s.h * grow * (1 + k * 0.25);
        v.set(s.x, 0, s.z);
        q.setFromEuler(_e1.set(s.tilt * 0.4, s.rot, s.tilt));
        sc.set(1 * fade, hh, 1 * fade);
        m4.compose(v, q, sc);
        this.shardMesh.setMatrixAt(i++, m4);
      }
      for (; i < 90; i++) this.shardMesh.setMatrixAt(i, _hiddenM4);
      this.shardMesh.instanceMatrix.needsUpdate = true;
      this.shards = this.shards.filter((s) => s.life < s.max);
    }

    /* 얼어붙은 껍질 */
    for (const sh of this.shells) {
      if (!sh.unit) { sh.mesh.visible = false; continue; }
      sh.life += dt;
      const u = sh.unit;
      if (u.removed || sh.life > sh.max || (!u.dead && u.freezeT <= 0)) {
        sh.unit = null; sh.mesh.visible = false; continue;
      }
      const m = u.joints[J.chest];
      _m1.copy(m);
      _m1.scale(_v1.set(1.0, 1.15, 1.0));
      sh.mesh.matrix.copy(_m1);
      sh.mesh.matrixWorldNeedsUpdate = true;
      sh.mesh.material.opacity = 0.34 * Math.min(1, (sh.max - sh.life) / 0.4);
      sh.mesh.visible = true;
      sh.mesh.rotation.set(0, this.time * 0.5, 0);
    }

    /* 파편 */
    if (this.debrisData.length) {
      let i = 0;
      for (const d of this.debrisData) {
        d.life += dt;
        d.vy -= 18 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        if (d.y < 0.08) { d.y = 0.08; d.vy *= -0.38; d.vx *= 0.7; d.vz *= 0.7; }
        d.rot += d.rs * dt;
        const k = clamp(1 - d.life / 1.6, 0, 1);
        _v1.set(d.x, d.y, d.z);
        _q1.setFromEuler(_e1.set(d.rot, d.rot * 0.7, d.rot * 0.3));
        _v2.setScalar(d.s * (0.6 + k * 0.6));
        _m1.compose(_v1, _q1, _v2);
        this.debris.setMatrixAt(i++, _m1);
      }
      for (; i < 70; i++) this.debris.setMatrixAt(i, _hiddenM4);
      this.debris.instanceMatrix.needsUpdate = true;
      this.debrisData = this.debrisData.filter((d) => d.life < 1.6);
    }

    /* 지면 섬광 */
    if (this.groundFlashPool) {
      for (const g of this.groundFlashPool) {
        if (g.life > g.max) { g.m.visible = false; continue; }
        g.life += dt;
        const k = g.life / g.max;
        g.m.material.opacity = 0.8 * (1 - k) * (1 - k);
      }
    }

    /* 점광원 번쩍임 */
    for (const l of this.lights) {
      if (l.life > l.max) { l.l.visible = false; continue; }
      l.life += dt;
      const k = 1 - l.life / l.max;
      l.l.intensity = l.peak * k * k;
      if (l.life > l.max) l.l.visible = false;
    }

    /* 검기 리본 — 근접 공격 중인 유닛 */
    for (const tr of this.trailPool) tr.update(dt);
    this.playerTrail.update(dt);
    this.updateUnitTrails(battle, camera);

    /* 접지 그림자 */
    if (this.shadowMesh && this.shadowUnits) {
      let i = 0;
      for (const u of this.shadowUnits) {
        if (i >= this.shadowUnits.length) break;
        if (u.removed) { this.shadowMesh.setMatrixAt(i++, _hiddenM4); continue; }
        const s = u.radius * (u.dead ? 3.6 : 3.0) * (u.scale || 1);
        _v1.set(u.x, 0.045, u.z);
        _q1.setFromEuler(_e1.set(0, 0, 0));
        _v2.set(s, 1, s);
        _m1.compose(_v1, _q1, _v2);
        this.shadowMesh.setMatrixAt(i++, _m1);
      }
      this.shadowMesh.instanceMatrix.needsUpdate = true;
    }

    /* 매화 검객 돌진 중 꽃잎 */
    if (battle) {
      for (const u of battle.units) {
        if (u.cls !== 'blademaster' || u.dashT === undefined || u.dashT < 0) continue;
        for (let i = 0; i < 3; i++) {
          this.petals.spawn({
            x: u.x + (this.rng() - 0.5) * 1.2, y: 0.3 + this.rng() * 1.4, z: u.z + (this.rng() - 0.5) * 1.2,
            vx: (this.rng() - 0.5) * 2.4, vy: 0.4 + this.rng() * 1.4, vz: (this.rng() - 0.5) * 2.4,
            life: 0.6 + this.rng() * 0.7, size: 0.08 + this.rng() * 0.12,
            r: 1, g: 0.82, b: 0.93, alpha: 0.9, gravity: -3.5, drag: 1.3, grow: 0.03, fade: 1.1
          });
        }
      }
    }

    /* 발자국 먼지 */
    if (battle) {
      this.footT += dt;
      if (this.footT > 0.1) {
        this.footT = 0;
        const cam = camera.position;
        for (const u of battle.units) {
          if (u.dead || u.moveAmt < 0.55) continue;
          if (Math.hypot(u.x - cam.x, u.z - cam.z) > 26) continue;
          if (this.rng() > 0.35) continue;
          this.dust.spawn({
            x: u.x + (this.rng() - 0.5) * 0.3, y: 0.05, z: u.z + (this.rng() - 0.5) * 0.3,
            vx: (this.rng() - 0.5) * 0.5, vy: 0.25 + this.rng() * 0.4, vz: (this.rng() - 0.5) * 0.5,
            life: 0.4 + this.rng() * 0.4, size: 0.18 + this.rng() * 0.35,
            r: 0.55, g: 0.45, b: 0.34, alpha: 0.32, gravity: 0.2, drag: 1.6, grow: 0.9, fade: 1.6
          });
        }
      }
    }
  }

  updateUnitTrails(battle, camera) {
    if (!battle) return;
    const cam = camera.position;
    let poolI = 0;
    for (const u of battle.units) {
      if (u.dead || u.isPlayer || u.attackT < 0) continue;
      if (Math.hypot(u.x - cam.x, u.z - cam.z) > 26) continue;
      const spec = CLASSES[u.cls];
      const imp = impactAt(u.cls);
      const t0 = imp - 0.16, t1 = imp + 0.18;
      if (u.attackT < t0 || u.attackT > t1) continue;
      if (poolI >= this.trailPool.length) break;
      const tr = this.trailPool[poolI++];
      if (!tr.active && tr.samples.length === 0) {
        tr.mat.uniforms.uColor.value.setHex(u.team === 'enemy' ? 0xff7a6a : 0x8fd8ff);
      }
      const base = this.unitPoint(u, 'handR', 0, 0, 0.15, _v1).clone();
      const tip = this.unitPoint(u, 'handR', 0, 0, u.cls === 'knight' ? 1.55 : 1.0, _v2).clone();
      tr.push(base, tip, 0, u.cls === 'knight' ? 1.5 : 1.0);
    }
    // 남은 트레일은 자연 소멸
  }

  /* 플레이어 뷰모델 검기 — 뷰모델에서 매 프레임 호출 */
  playerBlade(base, tip, k) {
    this.playerTrail.push(base, tip, 0, k);
  }

  clear() {
    this.sparks.n = 0; this.dust.n = 0; this.mist.n = 0; this.petals.n = 0;
    for (const w of this.wounds) { w.unit = null; w.mesh.visible = false; }
    for (const a of this.arcs) a.mesh.visible = false;
    for (const g of this.rings) g.mesh.visible = false;
    for (const b of this.blasts) b.mesh.visible = false;
    for (const p of this.puffs) { p.life = p.max + 1; p.s.visible = false; }
    for (const p of this.smokePuffs) { p.life = p.max + 1; p.s.visible = false; }
    for (const s of this.scorches) { s.life = s.max + 1; s.m.visible = false; }
    for (const s of this.shells) { s.unit = null; s.mesh.visible = false; }
    this.shards.length = 0;
    this.debrisData.length = 0;
    this.playerTrail.clear();
    for (const t of this.trailPool) t.clear();
    for (const l of this.lights) { l.l.visible = false; l.life = 0; }
    this.shake = 0;
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _m1 = new THREE.Matrix4();
const _hiddenM4 = new THREE.Matrix4().makeScale(0, 0, 0);
