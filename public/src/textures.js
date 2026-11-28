/* =============================================================================
   textures.js — 전부 절차적(캔버스)으로 만드는 텍스처. 외부 이미지 파일 없음.
   알베도 · 노멀 · 러프니스 · 상흔 · 검기 · 불꽃 · 연기 · 깃발 · 룬
   ============================================================================= */
import * as THREE from 'three';
import { clamp, noise2, fbm, mixHex, mulberry32 } from './util.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function texFrom(canvas, opts) {
  const o = opts || {};
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.repeat, o.repeat); }
  if (o.aniso) t.anisotropy = o.aniso;
  t.needsUpdate = true;
  return t;
}

/* 높이(그레이스케일 캔버스) → 노멀맵 */
export function normalFromCanvas(src, strength) {
  const w = src.width, h = src.height;
  const sc = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const H = (x, y) => {
    x = (x + w) % w; y = (y + h) % h;
    return sc[(y * w + x) * 4] / 255;
  };
  const k = strength === undefined ? 2.2 : strength;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * k;
      const dy = (H(x, y - 1) - H(x, y + 1)) * k;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ---------------------------------------------------------------------------
   지면(아레나) — 알베도 1장(비반복) · 노멀(반복) · 러프니스 1장
   중앙은 짓밟힌 흙과 핏자국, 그 둘레는 젖은 돌바닥, 바깥은 마른 풀.
   --------------------------------------------------------------------------- */
export function terrainMaps(S) {
  const size = S || 1024;
  const c = makeCanvas(size, size);
  const x = c.getContext('2d');
  const rough = makeCanvas(512, 512);
  const rx = rough.getContext('2d');
  const half = size / 2;

  // 바탕: 마른 풀
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#4d6236'); g.addColorStop(0.5, '#57693c'); g.addColorStop(1, '#455832');
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  rx.fillStyle = '#b9b9b9'; rx.fillRect(0, 0, 512, 512);

  // 풀결 (짧은 선)
  const rng = mulberry32(7);
  for (let i = 0; i < 26000; i++) {
    const px = rng() * size, py = rng() * size;
    const d = Math.hypot(px - half, py - half) / half;
    if (d < 0.62) continue;
    const t = 0.16 + rng() * 0.3;
    x.strokeStyle = `rgba(${(86 + rng() * 60) | 0},${(104 + rng() * 62) | 0},${(52 + rng() * 40) | 0},${t})`;
    x.lineWidth = 1 + rng() * 1.6;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + (rng() - 0.5) * 6, py - 3 - rng() * 7); x.stroke();
  }

  // 바깥쪽 어두운 풀 얼룩
  for (let i = 0; i < 190; i++) {
    const px = rng() * size, py = rng() * size;
    const rr = 18 + rng() * 90;
    const dg = x.createRadialGradient(px, py, 0, px, py, rr);
    const dark = rng() > 0.5;
    dg.addColorStop(0, dark ? 'rgba(33,45,25,0.5)' : 'rgba(92,104,58,0.28)');
    dg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = dg; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }

  // 가운데: 짓밟힌 젖은 흙 (반경 0.42), 젖은 돌테 (0.42~0.62)
  const dirt = x.createRadialGradient(half, half, half * 0.04, half, half, half * 0.44);
  dirt.addColorStop(0, '#6b5339');
  dirt.addColorStop(0.62, '#7a6247');
  dirt.addColorStop(0.88, '#6f5940');
  dirt.addColorStop(1, 'rgba(70,84,48,0)');
  x.fillStyle = dirt; x.beginPath(); x.arc(half, half, half * 0.46, 0, 7); x.fill();

  const rd = rx.createRadialGradient(256, 256, 40, 256, 256, 220);
  rd.addColorStop(0, '#3c3c3c'); rd.addColorStop(1, '#9c9c9c');
  rx.fillStyle = rd; rx.beginPath(); rx.arc(256, 256, 226, 0, 7); rx.fill();

  // 돌테 — 원형으로 깔린 돌 조각들
  for (let i = 0; i < 900; i++) {
    const a = rng() * Math.PI * 2;
    const r = half * (0.43 + rng() * 0.2);
    const px = half + Math.cos(a) * r, py = half + Math.sin(a) * r;
    const w = 5 + rng() * 16, h = 4 + rng() * 12;
    const tone = 58 + rng() * 46;
    x.save(); x.translate(px, py); x.rotate(a + rng());
    x.fillStyle = `rgb(${tone | 0},${(tone - 4) | 0},${(tone - 8) | 0})`;
    x.beginPath(); x.ellipse(0, 0, w, h, 0, 0, 7); x.fill();
    x.strokeStyle = 'rgba(18,16,14,0.55)'; x.lineWidth = 1.4; x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.05)'; x.beginPath(); x.ellipse(-w * 0.2, -h * 0.3, w * 0.5, h * 0.4, 0, 0, 7); x.fill();
    x.restore();
  }

  // 흙 밟힌 자국 · 자갈 · 갈라진 틈
  for (let i = 0; i < 2600; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * half * 0.43;
    const px = half + Math.cos(a) * r, py = half + Math.sin(a) * r;
    x.fillStyle = `rgba(${(40 + rng() * 40) | 0},${(30 + rng() * 30) | 0},${(22 + rng() * 22) | 0},${0.2 + rng() * 0.4})`;
    x.beginPath(); x.ellipse(px, py, 2 + rng() * 9, 1 + rng() * 5, rng() * 7, 0, 7); x.fill();
  }
  for (let i = 0; i < 70; i++) {
    let px = half + (rng() - 0.5) * half * 0.8, py = half + (rng() - 0.5) * half * 0.8;
    x.strokeStyle = `rgba(20,16,12,${0.35 + rng() * 0.3})`;
    x.lineWidth = 1 + rng() * 2;
    x.beginPath(); x.moveTo(px, py);
    for (let k = 0; k < 6; k++) { px += (rng() - 0.5) * 26; py += (rng() - 0.5) * 26; x.lineTo(px, py); }
    x.stroke();
  }

  // 물웅덩이 (러프니스 ↓ → 하늘 반사가 살아 젖은 느낌)
  for (let i = 0; i < 46; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * half * 0.5;
    const px = half + Math.cos(a) * r, py = half + Math.sin(a) * r;
    const rw = 14 + rng() * 62, rh = 8 + rng() * 30;
    x.save(); x.translate(px, py); x.rotate(rng() * 3);
    const wg = x.createRadialGradient(0, 0, 0, 0, 0, rw);
    wg.addColorStop(0, 'rgba(26,34,40,0.62)');
    wg.addColorStop(0.7, 'rgba(34,44,48,0.34)');
    wg.addColorStop(1, 'rgba(40,50,50,0)');
    x.fillStyle = wg; x.beginPath(); x.ellipse(0, 0, rw, rh, 0, 0, 7); x.fill();
    x.restore();
    const sx = (px / size) * 512, sy = (py / size) * 512;
    const rg = rx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(6, rw * 0.5));
    rg.addColorStop(0, 'rgba(18,18,18,0.95)');
    rg.addColorStop(0.75, 'rgba(40,40,40,0.7)');
    rg.addColorStop(1, 'rgba(120,120,120,0)');
    rx.fillStyle = rg; rx.beginPath(); rx.ellipse(sx, sy, rw * 0.5, rh * 0.5, 0, 0, 7); rx.fill();
  }

  // 핏자국 · 피투성이 흙
  for (let i = 0; i < 40; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * half * 0.4;
    const px = half + Math.cos(a) * r, py = half + Math.sin(a) * r;
    const rr = 6 + rng() * 26;
    const bg = x.createRadialGradient(px, py, 0, px, py, rr);
    bg.addColorStop(0, `rgba(88,16,14,${0.35 + rng() * 0.3})`);
    bg.addColorStop(0.6, `rgba(70,14,12,${0.18 + rng() * 0.2})`);
    bg.addColorStop(1, 'rgba(60,10,10,0)');
    x.fillStyle = bg; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }

  // 미세 입자 그레인
  const img = x.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    img.data[i] = clamp(img.data[i] + n, 0, 255);
    img.data[i + 1] = clamp(img.data[i + 1] + n, 0, 255);
    img.data[i + 2] = clamp(img.data[i + 2] + n, 0, 255);
  }
  x.putImageData(img, 0, 0);

  // 노멀: 미세 요철(타일) — 흙 알갱이/돌 표면
  const hs = 512;
  const hc = makeCanvas(hs, hs);
  const hx = hc.getContext('2d');
  const hid = hx.createImageData(hs, hs);
  for (let y = 0; y < hs; y++) {
    for (let xx = 0; xx < hs; xx++) {
      const v = (fbm(xx / 22, y / 22, 4) * 0.6 + noise2(xx / 4.5, y / 4.5) * 0.4);
      const i = (y * hs + xx) * 4;
      const c255 = clamp(v * 255, 0, 255);
      hid.data[i] = hid.data[i + 1] = hid.data[i + 2] = c255; hid.data[i + 3] = 255;
    }
  }
  hx.putImageData(hid, 0, 0);

  return {
    albedo: texFrom(c, { srgb: true, aniso: 4 }),
    normal: texFrom(normalFromCanvas(hc, 1.1), { srgb: false, repeat: 9 }),
    rough: texFrom(rough, { srgb: false })
  };
}

/* 돌 — 기둥 · 성벽 · 바닥 판 */
export function stoneMaps(S) {
  const size = S || 512;
  const c = makeCanvas(size, size);
  const x = c.getContext('2d');
  const hc = makeCanvas(size, size);
  const hx = hc.getContext('2d');
  x.fillStyle = '#6b6962'; x.fillRect(0, 0, size, size);
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, size, size);
  const rng = mulberry32(31);
  for (let i = 0; i < 2600; i++) {
    const px = rng() * size, py = rng() * size, s = 1 + rng() * 5;
    const tone = 84 + rng() * 60;
    x.fillStyle = `rgba(${tone | 0},${(tone - 3) | 0},${(tone - 10) | 0},${0.14 + rng() * 0.3})`;
    x.beginPath(); x.arc(px, py, s, 0, 7); x.fill();
    hx.fillStyle = `rgba(${(tone + 30) | 0},0,0,0.2)`; hx.beginPath(); hx.arc(px, py, s, 0, 7); hx.fill();
  }
  // 균열
  for (let i = 0; i < 22; i++) {
    let px = rng() * size, py = rng() * size;
    x.strokeStyle = `rgba(28,26,24,${0.4 + rng() * 0.35})`;
    x.lineWidth = 0.8 + rng() * 1.7;
    hx.strokeStyle = 'rgba(0,0,0,0.9)'; hx.lineWidth = 1 + rng() * 2;
    x.beginPath(); x.moveTo(px, py); hx.beginPath(); hx.moveTo(px, py);
    for (let k = 0; k < 5; k++) {
      px += (rng() - 0.5) * 60; py += (rng() - 0.5) * 60;
      x.lineTo(px, py); hx.lineTo(px, py);
    }
    x.stroke(); hx.stroke();
  }
  // 이끼
  for (let i = 0; i < 60; i++) {
    const px = rng() * size, py = rng() * size, rr = 5 + rng() * 26;
    const mg = x.createRadialGradient(px, py, 0, px, py, rr);
    mg.addColorStop(0, `rgba(58,72,40,${0.22 + rng() * 0.25})`);
    mg.addColorStop(1, 'rgba(50,64,36,0)');
    x.fillStyle = mg; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  return {
    albedo: texFrom(c, { srgb: true }),
    normal: texFrom(normalFromCanvas(hc, 2.6), { srgb: false }),
    rough: texFrom(makeCanvas(4, 4), { srgb: false })
  };
}

/* 나무 */
export function woodMaps() {
  const c = makeCanvas(128, 256);
  const x = c.getContext('2d');
  x.fillStyle = '#4a3320'; x.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 90; i++) {
    x.strokeStyle = `rgba(${(28 + Math.random() * 40) | 0},${(18 + Math.random() * 26) | 0},${(10 + Math.random() * 14) | 0},0.5)`;
    x.lineWidth = 0.6 + Math.random() * 2.2;
    x.beginPath();
    const yy = Math.random() * 256;
    x.moveTo(0, yy);
    for (let k = 0; k <= 8; k++) x.lineTo(k * 16, yy + Math.sin(k * 0.8 + i) * 3);
    x.stroke();
  }
  return { map: texFrom(c, { srgb: true }), normal: null };
}

/* 🩸 망토 찢어짐 — 등 뒤에서 맞았을 때 망토가 갈라진 자국.
   가운데가 뚫린(alpha 0) 너덜너덜한 천 조각이라, 그 구멍으로 등 상흔이 그대로 보인다.
   색은 재질 color(진영색)로 곱해지므로 회색 천으로 그린다. */
export function tearTexture() {
  const W = 128, H = 128;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  const rng = mulberry32(17);
  x.clearRect(0, 0, W, H);
  /* 너덜너덜한 천 조각 — 삐죽삐죽한 다각형 */
  const pts = [];
  const N = 22;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 40 + rng() * 20;
    pts.push([64 + Math.cos(a) * r, 64 + Math.sin(a) * r]);
  }
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < N; i++) x.lineTo(pts[i][0], pts[i][1]);
  x.closePath();
  x.fillStyle = 'rgba(120,118,112,0.95)';
  x.fill();
  /* 천 결 — 세로 실밥 */
  for (let i = 0; i < 26; i++) {
    const px = 20 + rng() * 88;
    x.strokeStyle = 'rgba(70,68,64,' + (0.10 + rng() * 0.22).toFixed(2) + ')';
    x.lineWidth = 0.8 + rng() * 1.6;
    x.beginPath();
    x.moveTo(px, 24 + rng() * 10);
    x.lineTo(px + (rng() - 0.5) * 6, 104 - rng() * 12);
    x.stroke();
  }
  /* 가운데 갈라진 구멍 — 이 구멍으로 등 상흔이 보인다 */
  x.globalCompositeOperation = 'destination-out';
  const holes = [
    [64, 64, 15], [56, 52, 9], [72, 78, 11], [50, 74, 8], [76, 50, 8]
  ];
  for (const [hx, hy, hr] of holes) {
    x.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = hr * (0.65 + rng() * 0.6);
      const px = hx + Math.cos(a) * r, py = hy + Math.sin(a) * r;
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath();
    x.fill();
  }
  /* 찢긴 결을 따라 길게 갈라진 자국 */
  x.lineWidth = 7;
  x.strokeStyle = 'rgba(0,0,0,1)';
  x.beginPath();
  x.moveTo(60, 30);
  x.lineTo(66, 52);
  x.lineTo(60, 74);
  x.lineTo(68, 100);
  x.stroke();
  x.globalCompositeOperation = 'source-over';
  /* 풀린 실 — 찢긴 가장자리에 밝은 실밥 */
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2, r = 18 + rng() * 14;
    const bx = 64 + Math.cos(a) * r, by = 64 + Math.sin(a) * r;
    x.strokeStyle = 'rgba(210,205,196,' + (0.25 + rng() * 0.4).toFixed(2) + ')';
    x.lineWidth = 0.9 + rng() * 1.2;
    x.beginPath();
    x.moveTo(bx, by);
    x.lineTo(bx + (rng() - 0.5) * 12, by + (rng() - 0.5) * 12);
    x.stroke();
  }
  return texFrom(c, { srgb: true });
}

/* 상흔 — 베인 자국(검) / 으스러진 자국(망치) */
export function woundTexture(kind) {
  const W = 128, H = 128;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.clearRect(0, 0, W, H);
  if (kind === 'crush') {
    const g = x.createRadialGradient(64, 64, 2, 64, 64, 58);
    g.addColorStop(0, 'rgba(52,8,8,0.95)');
    g.addColorStop(0.35, 'rgba(96,18,16,0.8)');
    g.addColorStop(0.72, 'rgba(120,40,30,0.35)');
    g.addColorStop(1, 'rgba(120,40,30,0)');
    x.fillStyle = g; x.beginPath(); x.arc(64, 64, 58, 0, 7); x.fill();
    const rng = mulberry32(5);
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2;
      x.strokeStyle = `rgba(30,4,4,${0.5 + rng() * 0.4})`;
      x.lineWidth = 1 + rng() * 2.4;
      x.beginPath(); x.moveTo(64, 64);
      x.lineTo(64 + Math.cos(a) * (20 + rng() * 34), 64 + Math.sin(a) * (20 + rng() * 34));
      x.stroke();
    }
    // 멍든 테두리
    for (let i = 0; i < 6; i++) {
      x.strokeStyle = `rgba(70,26,44,${0.24})`;
      x.lineWidth = 3 + Math.random() * 5;
      x.beginPath(); x.arc(64, 64, 22 + i * 5, 0, 7); x.stroke();
    }
  } else {
    // 베인 상처: 비스듬한 칼자국 + 번진 피
    x.save(); x.translate(64, 64); x.rotate(-0.42);
    const g = x.createLinearGradient(0, -11, 0, 11);
    g.addColorStop(0, 'rgba(120,20,18,0)');
    g.addColorStop(0.32, 'rgba(120,20,18,0.85)');
    g.addColorStop(0.5, 'rgba(58,6,6,0.98)');
    g.addColorStop(0.68, 'rgba(120,20,18,0.85)');
    g.addColorStop(1, 'rgba(120,20,18,0)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(-52, -3); x.quadraticCurveTo(0, -13, 52, -2);
    x.quadraticCurveTo(0, 9, -52, -3);
    x.fill();
    // 하얀 칼날 자국
    x.strokeStyle = 'rgba(255,225,215,0.5)'; x.lineWidth = 1.3;
    x.beginPath(); x.moveTo(-46, -4); x.quadraticCurveTo(0, -8, 46, -3); x.stroke();
    x.restore();
    const rng = mulberry32(11);
    for (let i = 0; i < 12; i++) {
      const a = -0.42 + (rng() - 0.5) * 0.9;
      const len = 16 + rng() * 34;
      x.strokeStyle = `rgba(${(90 + rng() * 40) | 0},12,12,${0.25 + rng() * 0.4})`;
      x.lineWidth = 1 + rng() * 3.4;
      x.beginPath(); x.moveTo(64, 64);
      x.quadraticCurveTo(64 + Math.cos(a) * len * 0.5 + 6, 64 + Math.sin(a) * len * 0.5 + 6,
        64 + Math.cos(a) * len, 64 + Math.sin(a) * len);
      x.stroke();
    }
  }
  return texFrom(c, { srgb: true });
}

/* 검기 — 초승달 그라디언트 (가산 합성용, 흰색 기준)
   넓은 잔광 → 부드러운 몸통 → 칼날 같은 하이라이트 코어 → 날리는 잔불 순으로 겹친다 */
export function arcTexture(kind) {
  const W = 512, H = 256;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.clearRect(0, 0, W, H);
  // 초승달이 캔버스 안에 꽉 차도록: 아래에 둔 큰 원의 윗호를 그린다
  const cx = W / 2, cy = H * 1.06, rx = W * 0.45, ry = H * 0.96;
  const a0 = Math.PI * 1.06, a1 = Math.PI * 1.94;
  const N = 160;
  const pack = (w0, w1, alpha, blur) => {
    x.save();
    x.filter = `blur(${blur || 0}px)`;
    x.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i / N, a = a0 + (a1 - a0) * t;
      const w = (w0 + (w1 - w0) * Math.pow(Math.sin(Math.PI * t), 0.62));
      x.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry - w);
    }
    for (let i = N; i >= 0; i--) {
      const t = i / N, a = a0 + (a1 - a0) * t;
      const w = (w0 + (w1 - w0) * Math.pow(Math.sin(Math.PI * t), 0.62));
      x.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry + w);
    }
    x.closePath();
    x.fillStyle = `rgba(255,255,255,${alpha})`;
    x.fill();
    x.restore();
  };
  if (kind === 'ice') {
    pack(6, 30, 0.10, 10); pack(3, 16, 0.20, 4); pack(1, 7, 0.55, 1); pack(0, 2.4, 1);
  } else if (kind === 'heavy') {
    pack(10, 46, 0.09, 14); pack(5, 26, 0.18, 6); pack(2, 12, 0.45, 2); pack(0, 4.6, 0.95, 0.6);
  } else {
    pack(8, 30, 0.10, 9); pack(4, 17, 0.19, 4); pack(1.2, 8, 0.5, 1.2); pack(0, 3.0, 1, 0.5);
  }
  // 가는 잔광 가닥 — 궁률 궤적을 따라 뻗는 빛살
  const rng = mulberry32(kind === 'heavy' ? 71 : kind === 'ice' ? 73 : 77);
  for (let i = 0; i < 14; i++) {
    const t = 0.14 + rng() * 0.72;
    const a = a0 + (a1 - a0) * t;
    const w = 0.5 + Math.pow(Math.sin(Math.PI * t), 0.7) * (kind === 'heavy' ? 20 : 11);
    const len = 5 + rng() * (kind === 'heavy' ? 12 : 8);
    const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
    x.strokeStyle = `rgba(255,255,255,${0.08 + rng() * 0.16})`;
    x.lineWidth = 0.6 + rng() * 1.8;
    x.beginPath();
    x.moveTo(px, py - w);
    x.lineTo(px + (rng() - 0.5) * 6, py - w - len);
    x.stroke();
  }
  // 궤적 끝의 불티
  for (let i = 0; i < 14; i++) {
    const t = rng();
    const a = a0 + (a1 - a0) * t;
    const w = Math.pow(Math.sin(Math.PI * t), 0.7) * (kind === 'heavy' ? 24 : 12);
    const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry - w * (0.4 + rng());
    const rr = 1 + rng() * 3.2;
    const g = x.createRadialGradient(px, py, 0, px, py, rr * 3);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr * 3, 0, 7); x.fill();
  }
  return texFrom(c, { srgb: true });
}

/* 부드러운 원형 발광 (스파크·횃불·오브) */
export function glowTexture(inner, outer) {
  const S = 128;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner || 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,240,210,0.75)');
  g.addColorStop(0.55, outer || 'rgba(255,170,80,0.22)');
  g.addColorStop(1, 'rgba(255,150,60,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return texFrom(c, { srgb: true });
}

/* 연기 · 먼지 (회색 뭉게) */
export function smokeTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S);
  const rng = mulberry32(3);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 58;
    const px = S / 2 + Math.cos(a) * r, py = S / 2 + Math.sin(a) * r * 0.85;
    const rr = 26 + rng() * 46;
    const g = x.createRadialGradient(px, py - rr * 0.2, 0, px, py, rr);
    g.addColorStop(0, 'rgba(255,255,255,0.30)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  return texFrom(c, { srgb: true });
}

/* 뭉게구름 / 높이 뜬 권운 */
export function cloudTexture(high) {
  const W = 256, H = 160;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  const rng = mulberry32(high ? 23 : 19);
  if (high) {
    // 하늘 높이 흐르는 얇은 실구름 — 길게 늘어진 가닥
    for (let i = 0; i < 26; i++) {
      const yy = 30 + rng() * 100;
      const x0 = 10 + rng() * 120, x1 = x0 + 70 + rng() * 120;
      const g = x.createLinearGradient(x0, yy, x1, yy + (rng() - 0.5) * 26);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.45, `rgba(255,248,242,${0.22 + rng() * 0.24})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.strokeStyle = g;
      x.lineWidth = 6 + rng() * 20;
      x.lineCap = 'round';
      x.beginPath();
      x.moveTo(x0, yy);
      x.bezierCurveTo(x0 + 40, yy - 14 + rng() * 28, x1 - 50, yy + 12 - rng() * 24, x1, yy - 6 + rng() * 12);
      x.stroke();
    }
    return texFrom(c, { srgb: true });
  }
  // 뭉게구름 — 위는 밝고 아래는 노을빛 그늘
  for (let i = 0; i < 46; i++) {
    const px = 128 + (rng() - 0.5) * 196;
    const py = 92 + (rng() - 0.5) * 56;
    const rr = 16 + rng() * 46;
    const g = x.createRadialGradient(px, py - rr * 0.45, rr * 0.1, px, py, rr);
    g.addColorStop(0, 'rgba(255,252,248,0.92)');
    g.addColorStop(0.45, 'rgba(255,240,232,0.6)');
    g.addColorStop(0.78, 'rgba(244,206,196,0.28)');
    g.addColorStop(1, 'rgba(232,190,186,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  return texFrom(c, { srgb: true });
}

/* 그을음 · 균열 지면 데칼 (폭발 뒤 바닥에 남는다) */
export function scorchTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S);
  const rng = mulberry32(83);
  // 중심 그을음
  const g = x.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S * 0.48);
  g.addColorStop(0, 'rgba(12,10,9,0.94)');
  g.addColorStop(0.42, 'rgba(22,17,14,0.82)');
  g.addColorStop(0.72, 'rgba(38,28,22,0.42)');
  g.addColorStop(1, 'rgba(50,38,30,0)');
  x.fillStyle = g; x.beginPath(); x.arc(S / 2, S / 2, S * 0.48, 0, 7); x.fill();
  // 불규칙한 그을음 자국
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * S * 0.46;
    const rr = 4 + rng() * 26;
    const px = S / 2 + Math.cos(a) * r, py = S / 2 + Math.sin(a) * r;
    const dg = x.createRadialGradient(px, py, 0, px, py, rr);
    dg.addColorStop(0, `rgba(10,8,7,${0.18 + rng() * 0.25})`);
    dg.addColorStop(1, 'rgba(10,8,7,0)');
    x.fillStyle = dg; x.beginPath(); x.arc(px, py, rr, 0, 7); x.fill();
  }
  // 바닥 균열 — 중심에서 뻗어 나가는 갈라진 선
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rng() * 0.3;
    let px = S / 2, py = S / 2, ang = a;
    x.beginPath(); x.moveTo(px, py);
    const len = S * (0.16 + rng() * 0.3);
    for (let k = 0; k < 6; k++) {
      ang += (rng() - 0.5) * 0.5;
      px += Math.cos(ang) * (len / 6); py += Math.sin(ang) * (len / 6);
      x.lineTo(px, py);
    }
    x.strokeStyle = `rgba(6,5,4,${0.55 + rng() * 0.4})`;
    x.lineWidth = 1 + rng() * 3.4; x.stroke();
    // 균열 안쪽 잔불 빛
    x.strokeStyle = `rgba(255,120,40,${0.10 + rng() * 0.16})`;
    x.lineWidth = 0.8 + rng() * 1.4; x.stroke();
  }
  return texFrom(c, { srgb: true });
}


/* 깃발 — 진영 문양 */
export function bannerTexture(hex, emblem) {
  const W = 256, H = 384;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  const col = '#' + hex.toString(16).padStart(6, '0');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, col);
  g.addColorStop(0.55, mixHex(hex, 0x000000, 0.25) >>> 0 ? '#' + mixHex(hex, 0x000000, 0.22).toString(16).padStart(6, '0') : col);
  g.addColorStop(1, col);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // 옷감 결
  for (let i = 0; i < 900; i++) {
    x.strokeStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    x.beginPath();
    const yy = Math.random() * H;
    x.moveTo(0, yy); x.lineTo(W, yy + (Math.random() - 0.5) * 3); x.stroke();
  }
  // 테두리
  x.strokeStyle = 'rgba(255,226,160,0.85)'; x.lineWidth = 7;
  x.strokeRect(12, 12, W - 24, H - 24);
  x.strokeStyle = 'rgba(255,226,160,0.4)'; x.lineWidth = 2;
  x.strokeRect(24, 24, W - 48, H - 48);
  // 문양 (검 + 날개 느낌의 기하 문양)
  x.save(); x.translate(W / 2, H * 0.42);
  x.fillStyle = 'rgba(255,232,180,0.92)';
  x.beginPath();
  x.moveTo(0, -92); x.lineTo(20, -40); x.lineTo(70, -18); x.lineTo(24, 6);
  x.lineTo(30, 62); x.lineTo(0, 40); x.lineTo(-30, 62); x.lineTo(-24, 6);
  x.lineTo(-70, -18); x.lineTo(-20, -40); x.closePath(); x.fill();
  x.globalAlpha = 0.5;
  x.beginPath(); x.arc(0, -10, 96, 0, 7); x.strokeStyle = 'rgba(255,232,180,0.9)'; x.lineWidth = 6; x.stroke();
  x.restore();
  x.globalAlpha = 1;
  x.fillStyle = 'rgba(255,236,190,0.85)';
  x.font = 'bold 34px serif';
  x.textAlign = 'center';
  x.fillText(emblem || 'ARENA', W / 2, H * 0.78);
  return texFrom(c, { srgb: true });
}

/* 룬 원형 (마법사 발밑 · 제단) */
export function runeTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S);
  x.strokeStyle = 'rgba(160,225,255,0.9)';
  x.lineWidth = 2.4;
  x.beginPath(); x.arc(128, 128, 116, 0, 7); x.stroke();
  x.lineWidth = 1.2;
  x.beginPath(); x.arc(128, 128, 102, 0, 7); x.stroke();
  x.beginPath(); x.arc(128, 128, 60, 0, 7); x.stroke();
  const glyphs = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛈᛉᛊᛏᛒᛖᛗᛚ';
  x.font = '16px serif'; x.fillStyle = 'rgba(180,235,255,0.95)';
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    x.save(); x.translate(128 + Math.cos(a) * 86, 128 + Math.sin(a) * 86); x.rotate(a + Math.PI / 2);
    x.fillText(glyphs[i], -8, 6); x.restore();
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    x.beginPath(); x.moveTo(128 + Math.cos(a) * 60, 128 + Math.sin(a) * 60);
    x.lineTo(128 + Math.cos(a + 2.2) * 60, 128 + Math.sin(a + 2.2) * 60);
    x.stroke();
  }
  return texFrom(c, { srgb: true });
}

/* 원형 부드러운 그림자 (접지 그림자) */
export function blobTexture() {
  const S = 128;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.34)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return texFrom(c, { srgb: false });
}

/* 매화 꽃잎 */
export function petalTexture() {
  const S = 96;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  x.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const g = x.createRadialGradient(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, 1, cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, 20);
    g.addColorStop(0, 'rgba(255,255,255,0.98)');
    g.addColorStop(0.45, 'rgba(255,196,220,0.95)');
    g.addColorStop(1, 'rgba(255,150,190,0)');
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, 17, 12, a, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = 'rgba(255,226,120,0.95)';
  x.beginPath(); x.arc(cx, cy, 5, 0, 7); x.fill();
  return texFrom(c, { srgb: true });
}

/* 폭발 불티 (불꽃 모양) */
export function flameTexture() {
  const S = 128;
  const c = makeCanvas(S, S);
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S * 0.62, 2, S / 2, S * 0.56, S * 0.46);
  g.addColorStop(0, 'rgba(255,255,235,1)');
  g.addColorStop(0.25, 'rgba(255,214,120,0.95)');
  g.addColorStop(0.55, 'rgba(255,130,40,0.65)');
  g.addColorStop(0.85, 'rgba(200,50,10,0.18)');
  g.addColorStop(1, 'rgba(160,30,0,0)');
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(S / 2, 8);
  x.bezierCurveTo(S * 0.82, 44, S * 0.9, 84, S / 2, S * 0.98);
  x.bezierCurveTo(S * 0.1, 84, S * 0.18, 44, S / 2, 8);
  x.fill();
  return texFrom(c, { srgb: true });
}
