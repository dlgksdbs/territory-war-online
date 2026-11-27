/* =============================================================================
   ground.js — 지면 높이 · 장애물 충돌 · 🥊 PVP 옥타곤 링 경계
   -----------------------------------------------------------------------------
   · groundY(x, z, pvp)  : 지형 높이 (솔로 전장은 world.js 의 terrainHeight)
   ·                       PVP 옥타곤 링 위에서는 매트 높이만큼 살짝 올라간다
   · clampOctagon(x, z)  : 정8각형 링 안으로 위치를 되돌린다 (서버 pvp.js 와 동일 식)
   · resolveObstacles()  : 바위·기둥·횃불 기둥 같은 지형물 밖으로 밀어낸다
   ============================================================================= */
import { terrainHeight } from './world.js';

/* 🥊 UFC 옥타곤 — 중심에서 각 변까지의 거리(apothem) 기준.
   fence(울타리 안쪽 면) 보다 안쪽으로만 설 수 있고, 매트는 top 만큼 올라와 있다. */
export const OCTAGON = {
  apothem: 15.0,        // 플레이어·AI 가 설 수 있는 경계 (중심→변)
  fence: 15.5,          // 케이지 안쪽 면
  top: 0.06,            // 매트 윗면 높이 (발이 정확히 매트에 닿는다)
  vertex: 15.5 / Math.cos(Math.PI / 8)   // 꼭짓점(기둥) 반지름 ≈ 16.78
};

const OCT_STEP = Math.PI / 4;

/* 방향(phi)별 정8각형 경계 반지름 */
export function octRadius(phi, apothem) {
  const a = apothem === undefined ? OCTAGON.apothem : apothem;
  const t = ((phi % OCT_STEP) + OCT_STEP) % OCT_STEP - OCT_STEP / 2;
  return a / Math.cos(t);
}

export function insideOctagon(x, z, apothem) {
  const r = Math.hypot(x, z);
  if (r < 1e-6) return true;
  return r <= octRadius(Math.atan2(x, z), apothem) + 1e-6;
}

/* 옥타곤 밖이면 경계 위로 되돌린다 */
export function clampOctagon(x, z, apothem) {
  const r = Math.hypot(x, z);
  if (r < 1e-6) return { x, z, hit: false };
  const R = octRadius(Math.atan2(x, z), apothem);
  if (r <= R) return { x, z, hit: false };
  const k = R / r;
  return { x: x * k, z: z * k, hit: true };
}

/* 지면 높이 — PVP 링 안쪽은 매트 두께만큼 올라간다 */
export function groundY(x, z, pvp) {
  const base = terrainHeight(x, z);
  if (!pvp) return base;
  return insideOctagon(x, z, OCTAGON.fence + 0.4) ? base + OCTAGON.top : base;
}

/* ------------------------------------------------------------------ 장애물
   world.js 가 모아 둔 원형 콜라이더 목록을 받아, 유닛을 밖으로 밀어낸다.
   (반환값: 밀려났는지 여부) */
export function resolveObstacles(u, colliders, pad) {
  if (!colliders || !colliders.length) return false;
  const pr = (u.radius || 0.4) + (pad || 0);
  let hit = false;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const dx = u.x - c.x, dz = u.z - c.z;
    const min = c.r + pr;
    if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 0.0001;
    const k = (min - d) / d;
    u.x += dx * k;
    u.z += dz * k;
    hit = true;
  }
  return hit;
}

/* 한 점이 장애물 안인지 (관전 카메라·이동 판단용) */
export function blockedAt(x, z, colliders, pad) {
  if (!colliders || !colliders.length) return false;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const dx = x - c.x, dz = z - c.z;
    const min = c.r + (pad || 0);
    if (dx * dx + dz * dz < min * min) return true;
  }
  return false;
}
