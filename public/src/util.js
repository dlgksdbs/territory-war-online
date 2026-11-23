/* util.js — 수학 · 노이즈 · 색 도구 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack = (t) => { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
export const TAU = Math.PI * 2;

export function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export function angLerp(a, b, t) { return a + angDiff(b, a) * t; }
export function damp(cur, target, dt, ms) {
  const k = 1 - Math.exp(-Math.max(0.0001, dt) / Math.max(0.0001, ms));
  return cur + (target - cur) * k;
}
export function dampAngle(cur, target, dt, ms) { return angLerp(cur, target, 1 - Math.exp(-dt / Math.max(0.001, ms))); }

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HASH = new Uint8Array(256);
for (let i = 0; i < 256; i++) HASH[i] = (Math.sin(i * 127.1 + 311.7) * 43758.5453) & 255;
function h2(x, y) {
  const n = (x * 374761393 + y * 668265263) & 0xffff;
  return (HASH[n & 255] ^ HASH[(n >> 8) & 255]) / 255;
}
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
export function fbm(x, y, oct, gain) {
  let s = 0, amp = 0.5, f = 1;
  const g = gain === undefined ? 0.5 : gain;
  for (let i = 0; i < (oct || 4); i++) { s += noise2(x * f, y * f) * amp; amp *= g; f *= 2; }
  return s;
}

/* 0..1 사이 값을 어두운 색 → 밝은 색으로 */
export function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((Math.round(lerp(ar, br, t)) << 16) | (Math.round(lerp(ag, bg, t)) << 8) | Math.round(lerp(ab, bb, t))) >>> 0;
}
export function rgbOf(hex) { return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 }; }

/* 시작/끝 시각을 가진 스케줄을 진행도로 평가 */
export function seg(t, a, b) { return clamp((t - a) / Math.max(0.0001, b - a), 0, 1); }

/* 조이스틱 입력(nx=오른쪽, nz=앞) → 세계 좌표 이동 벡터
   yaw 는 '바라보는 방향'( sin(yaw), cos(yaw) = 정면 ). 화면 기준 전후좌우가
   그대로 월드에 대응하도록 오른쪽 축은 (-cos, sin) 이다. */
export function joyToWorld(yaw, nx, nz) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  return { x: s * (nz || 0) - c * (nx || 0), z: c * (nz || 0) + s * (nx || 0) };
}
