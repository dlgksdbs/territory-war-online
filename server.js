'use strict';

/* =============================================================================
   영토 전쟁 ONLINE · 실시간(RTS) 웹소켓 멀티플레이 서버
   - 의존성: ws (WebSocket) 만 사용
   - 같은 포트에서 public/index.html (HTTP) 과 /ws (WebSocket) 를 함께 서비스
   - 지도 생성·병력 생산·행군·전투·외교·AI 는 모두 서버가 권위를 가진다
   - 턴 개념 없음: 100ms 시뮬레이션 스텝이 끊임없이 돌아간다
   ============================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const NATION_COUNT = 4;
const ROOM_IDLE_MS = 30 * 60 * 1000;      // 접속자가 모두 없는 방은 30분 뒤 정리
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ROOMS = 800;
const MAX_PLAYERS = NATION_COUNT;
const WS_MAX_PAYLOAD = 16 * 1024;
const AUTO_AI_MS = 25 * 1000;             // 접속이 이만큼 끊기면 AI 가 잠시 대신 조종한다

/* 실시간 시뮬레이션 상수 */
const SIM = {
  stepMs: 100,              // 서버 시뮬레이션 스텝
  tickMs: 400,              // 클라이언트 동기화 주기
  prodMs: 1700,             // 일반 영토 1개 병력 생산 시간
  capitalProdMul: 1.75,     // 수도 생산 속도 배수
  capBase: 9,               // 병력 상한(기본)
  capNeighbor: 0.35,        // 이웃 수에 따른 상한 보너스
  capCapital: 4,            // 수도 상한 보너스
  slowAbove: 0.75,          // 상한의 75%를 넘으면 생산 속도
  slowMul: 0.45,
  marchMs: 1200,            // 행군 시간 (출정 → 도착)
  defBonus: 1.15,           // 수비 보너스
  capitalDefBonus: 1.3,     // 수도 수비 보너스
  allyAttackBonus: 0.12,    // 공동의 적 공격 시 공격력 보너스
  dispatchCooldownMs: 260,  // 연타 방지
  ratioDefault: 0.5,
  maxMarches: 160,          // 방 전체 동시 행군 상한
  aiMinMs: 1800,            // AI 판단 간격
  aiMaxMs: 3200,
  aiDiploMinMs: 6500,
  aiDiploMaxMs: 11000,
  overtimeAfterMs: 6 * 60 * 1000,   // 6분 이후부터 생산 가속 (결말 유도)
  overtimeStepMs: 60 * 1000,
  overtimeGain: 0.25,
  speeds: [1, 2, 4]
};

/* 외교 지속 시간 (초) */
const DUR = {
  truce: 45,
  ally: 60,
  tribute: 45,
  tributePay: 12,     // 조공 지급 주기
  call: 30,
  grudge: 60,
  proposal: 30        // 제안 유효 시간
};

/* =============================================================================
   0. 공통 유틸 · 시드 난수
   ============================================================================= */

const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);

let rand = Math.random;

function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function setSeed(seed) { rand = mulberry32(seed); }
const rndInt = (a, b) => a + Math.floor(rand() * (b - a + 1));

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

const REGION_NAMES = [
  '가람', '나린', '다온', '라온', '마루', '바람', '새벽', '여울', '이슬', '조은',
  '하람', '도담', '보람', '사랑', '아라', '자람', '차오', '초롱', '한결', '해든',
  '가온', '나래', '다래', '미르', '별참', '슬기', '윤슬', '온새'
];

/* =============================================================================
   1. 기하 · 보로노이 지도 생성 (single-file 버전과 동일한 지도 느낌)
   ============================================================================= */

const Geo = {
  area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  },
  centroid(poly) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const f = p.x * q.y - q.x * p.y;
      a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-7) {
      let sx = 0, sy = 0;
      for (let k = 0; k < poly.length; k++) { sx += poly[k].x; sy += poly[k].y; }
      return { x: sx / poly.length, y: sy / poly.length };
    }
    return { x: cx / (6 * a), y: cy / (6 * a) };
  },
  bounds(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  },
  inPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  },
  clip(poly, f) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a);
      if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
        const t = fa / (fa - fb);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  },
  dedupe(poly, eps) {
    const e = eps == null ? 1e-6 : eps;
    const out = [];
    for (const p of poly) {
      const l = out[out.length - 1];
      if (!l || Math.hypot(p.x - l.x, p.y - l.y) > e) out.push(p);
    }
    while (out.length > 1) {
      const f = out[0], z = out[out.length - 1];
      if (Math.hypot(f.x - z.x, f.y - z.y) <= e) out.pop(); else break;
    }
    return out;
  }
};

function ellipsePoly(cx, cy, rx, ry, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function makeLand(W, H) {
  const pad = Math.min(W, H) * 0.045;
  const cx = W / 2, cy = H / 2;
  const rx = W / 2 - pad, ry = H / 2 - pad;
  const base = ellipsePoly(cx, cy, rx, ry, 72);
  const baseArea = Math.abs(Geo.area(base));
  let land = base;
  const cuts = 6 + rndInt(0, 4);
  for (let i = 0; i < cuts; i++) {
    const ang = (i / cuts) * Math.PI * 2 + rand() * 0.6;
    const d = 0.74 + rand() * 0.18;
    const nx = Math.cos(ang), ny = Math.sin(ang);
    const px = cx + nx * rx * d, py = cy + ny * ry * d;
    const next = Geo.dedupe(Geo.clip(land, (p) => (p.x - px) * nx + (p.y - py) * ny));
    if (next.length >= 3 && Math.abs(Geo.area(next)) > Math.abs(Geo.area(land)) * 0.9) {
      land = next;
    }
  }
  if (Math.abs(Geo.area(land)) < baseArea * 0.5) land = base;
  return land;
}

function voronoiCells(seeds, boundary) {
  const cells = [];
  const n = seeds.length;
  for (let i = 0; i < n; i++) {
    let poly = boundary;
    const si = seeds[i];
    for (let j = 0; j < n; j++) {
      if (i === j || poly.length < 3) continue;
      const sj = seeds[j];
      const mx = (si.x + sj.x) / 2, my = (si.y + sj.y) / 2;
      const dx = sj.x - si.x, dy = sj.y - si.y;
      poly = Geo.clip(poly, (p) => (p.x - mx) * dx + (p.y - my) * dy);
    }
    cells.push(Geo.dedupe(poly));
  }
  return cells;
}

function placeSeeds(land, count, W, H) {
  const landArea = Math.abs(Geo.area(land));
  let minDist = Math.sqrt(landArea / count) * 0.86;
  let seeds = [];
  for (let pass = 0; pass < 40; pass++) {
    seeds = [];
    const tries = 900 + count * 260;
    for (let t = 0; t < tries && seeds.length < count; t++) {
      const p = { x: rand() * W, y: rand() * H };
      if (!Geo.inPoly(p, land)) continue;
      let ok = true;
      for (const s of seeds) {
        const dx = s.x - p.x, dy = s.y - p.y;
        if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
      }
      if (ok) seeds.push(p);
    }
    if (seeds.length === count) return seeds;
    minDist *= 0.88;
  }
  return seeds;
}

function gridSeeds(land, count, W, H) {
  const b = Geo.bounds(land);
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const cols = Math.max(2, Math.round(Math.sqrt(count * (bw / bh))));
  const rows = Math.max(2, Math.ceil(count / cols));
  const seeds = [];
  for (let r = 0; r < rows && seeds.length < count; r++) {
    for (let c = 0; c < cols && seeds.length < count; c++) {
      const x = b.minX + (c + 0.5) * bw / cols + (rand() - 0.5) * (bw / cols) * 0.5;
      const y = b.minY + (r + 0.5) * bh / rows + (rand() - 0.5) * (bh / rows) * 0.5;
      const p = { x, y };
      if (Geo.inPoly(p, land)) seeds.push(p);
    }
  }
  let guard = 0;
  while (seeds.length < count && guard++ < count * 30) {
    let best = null, bestD = -1;
    for (let s = 0; s < 220; s++) {
      const cand = { x: rand() * W, y: rand() * H };
      if (!Geo.inPoly(cand, land)) continue;
      let dmin = Infinity;
      for (const q of seeds) {
        const ddx = q.x - cand.x, ddy = q.y - cand.y;
        const d = ddx * ddx + ddy * ddy;
        if (d < dmin) dmin = d;
      }
      if (dmin > bestD) { bestD = dmin; best = cand; }
    }
    if (!best) break;
    seeds.push(best);
  }
  return seeds;
}

function relaxSeeds(seeds, land) {
  const cells = voronoiCells(seeds, land);
  const next = [];
  for (let i = 0; i < seeds.length; i++) {
    const c = cells[i];
    if (!c || c.length < 3) { next.push(seeds[i]); continue; }
    let p = Geo.centroid(c);
    if (!Geo.inPoly(p, land)) p = seeds[i];
    next.push(p);
  }
  return next;
}

function bisectorShare(polyA, sa, sb) {
  const eps = 0.02;
  const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
  let dx = sb.x - sa.x, dy = sb.y - sa.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  let total = 0;
  for (let k = 0; k < polyA.length; k++) {
    const a = polyA[k], b = polyA[(k + 1) % polyA.length];
    const da = Math.abs((a.x - mx) * dx + (a.y - my) * dy);
    const db = Math.abs((b.x - mx) * dx + (b.y - my) * dy);
    if (da < eps && db < eps) {
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > eps * 2) total += l;
    }
  }
  return total;
}

function buildAdjacency(cells, seeds, W) {
  const n = cells.length;
  const adj = Array.from({ length: n }, () => []);
  const minShare = W * 0.0012;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const share = bisectorShare(cells[a], seeds[a], seeds[b]);
      if (share > minShare) { adj[a].push(b); adj[b].push(a); }
    }
  }
  return adj;
}

function isConnected(adj) {
  if (!adj.length) return false;
  const seen = new Array(adj.length);
  const q = [0];
  seen[0] = true;
  let count = 1;
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (const nb of adj[v]) {
      if (!seen[nb]) { seen[nb] = true; count++; q.push(nb); }
    }
  }
  return count === adj.length;
}

function bfsDistances(adj, sources) {
  const dist = new Array(adj.length).fill(Infinity);
  const q = [];
  for (const s of sources) {
    if (dist[s] !== 0) { dist[s] = 0; q.push(s); }
  }
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (const nb of adj[v]) {
      if (dist[nb] === Infinity) { dist[nb] = dist[v] + 1; q.push(nb); }
    }
  }
  return dist;
}

function generateMap(W, H, count) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const land = makeLand(W, H);
    const loose = attempt >= 22;
    let seeds = attempt >= 12 ? gridSeeds(land, count, W, H) : placeSeeds(land, count, W, H);
    if (seeds.length !== count) continue;
    for (let it = 0; it < 4; it++) seeds = relaxSeeds(seeds, land);
    const cells = voronoiCells(seeds, land);
    let bad = false;
    for (const cell of cells) {
      if (cell.length < 3 || Math.abs(Geo.area(cell)) < 1) { bad = true; break; }
    }
    if (bad) continue;
    const areas = cells.map((c) => Math.abs(Geo.area(c)));
    const sum = areas.reduce((a, b) => a + b, 0);
    const avg = sum / areas.length;
    const mn = Math.min(...areas), mx = Math.max(...areas);
    if (!loose && (mn < avg * 0.18 || mx > avg * 2.6)) continue;
    const adj = buildAdjacency(cells, seeds, W);
    if (!isConnected(adj)) continue;
    return { land, seeds, cells, adj };
  }
  return null;
}

/* =============================================================================
   2. 실시간 게임 규칙 (DOM 과 무관 · 서버 권위)
   - 턴 없음: 병력 생산 · 행군 · 전투 · 외교가 모두 초 단위로 흐른다
   ============================================================================= */

const NATIONS = [
  { id: 0, name: '청룡 왕국', short: '청룡', color: '#3b82f6' },
  { id: 1, name: '적화 연방', short: '적화', color: '#ef4444' },
  { id: 2, name: '녹림 동맹', short: '녹림', color: '#22c55e' },
  { id: 3, name: '황금 제국', short: '황금', color: '#f59e0b' }
];
const NEUTRAL_NAME = '중립 세력';

const tkey = (a, b) => Math.min(a, b) + '-' + Math.max(a, b);

function treatyOf(state, a, b) {
  if (a === b || a < 0 || b < 0 || a == null || b == null) return null;
  return state.treaties[tkey(a, b)] || null;
}

/* ---------------- 외교 상태 도우미 ---------------- */
function nationName(state, slot) {
  if (slot == null || slot < 0) return NEUTRAL_NAME;
  if (state && state.names && state.names[slot]) return state.names[slot];
  return NATIONS[slot] ? NATIONS[slot].name : '?';
}

function relationOf(state, a, b) {
  if (a == null || b == null || a === b || a < 0 || b < 0) return 0;
  const v = state.relations[tkey(a, b)];
  return typeof v === 'number' ? v : 0;
}

function addRelation(state, a, b, delta) {
  if (a == null || b == null || a === b || a < 0 || b < 0) return 0;
  const k = tkey(a, b);
  const before = typeof state.relations[k] === 'number' ? state.relations[k] : 0;
  const after = clampNum(before + delta, -100, 100);
  state.relations[k] = after;
  return after;
}

function reputationOf(state, slot) {
  if (slot == null || slot < 0) return 50;
  const v = state.reputation[slot];
  return typeof v === 'number' ? v : 60;
}

function addReputation(state, slot, delta) {
  if (slot == null || slot < 0) return 50;
  const before = reputationOf(state, slot);
  state.reputation[slot] = clampNum(before + delta, 0, 100);
  return state.reputation[slot];
}

/* 한국어 조사 다듬기: "지우이(가)" → "지우가", "왕국이(가)" → "왕국이" */
function josaFor(word, pair) {
  const str = String(word || '').trim();
  const ch = str.charAt(str.length - 1);
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return pair[1];
  const hasBatchim = (code - 0xac00) % 28 !== 0;
  return hasBatchim ? pair[0] : pair[1];
}

function polishKo(text) {
  if (!text) return text;
  return String(text)
    .replace(/([가-힣]+)이\(가\)/g, (m, w) => w + josaFor(w, ['이', '가']))
    .replace(/([가-힣]+)을\(를\)/g, (m, w) => w + josaFor(w, ['을', '를']))
    .replace(/([가-힣]+)은\(는\)/g, (m, w) => w + josaFor(w, ['은', '는']))
    .replace(/([가-힣]+)와\(과\)/g, (m, w) => w + josaFor(w, ['과', '와']));
}

function diploNote(state, text, kind, slots) {
  const clean = polishKo(text);
  state.diploLog.push({ at: Date.now(), text: clean, kind: kind || 'info', slots: slots || [] });
  if (state.diploLog.length > 30) state.diploLog.splice(0, state.diploLog.length - 30);
  state.logRev = (state.logRev || 0) + 1;
  return clean;
}

function leaderOf(state) {
  let best = -1, bestC = 0, total = state.regions.length;
  for (let i = 0; i < NATION_COUNT; i++) {
    if (!state.active[i]) continue;
    const c = Game.countOwned(state, i);
    if (c > bestC) { bestC = c; best = i; }
  }
  if (best < 0) return -1;
  return bestC / Math.max(1, total) >= 0.32 ? best : -1;
}

function twoFrontCount(state, ai) {
  let fronts = 0;
  for (let i = 0; i < NATION_COUNT; i++) {
    if (i === ai || !state.active[i]) continue;
    if (Game.countOwned(state, i) === 0) continue;
    if (treatyOf(state, ai, i)) continue;
    if (Game.borderThreat(state, ai, i) > 0) fronts++;
  }
  return fronts;
}

function callTargetsFor(state, ai) {
  const set = new Set();
  if (!state.calls) return set;
  for (const c of state.calls) {
    if (c.to === ai && c.until > state.time) set.add(c.target);
  }
  if (state.grudge && state.grudge[ai]) set.add(state.grudge[ai].at);
  return set;
}

function activeCallFor(state, ai) {
  if (!state.calls) return null;
  return state.calls.find((c) => c.to === ai && c.until > state.time) || null;
}

function atWar(state, a, b) {
  if (a < 0 || b < 0 || a === b) return false;
  if (!state.active[a] || !state.active[b]) return false;
  return !treatyOf(state, a, b);
}

function hasAllyAgainst(state, owner, defender) {
  if (defender == null || defender < 0) return false;
  for (let al = 0; al < NATION_COUNT; al++) {
    if (al === owner || !state.active[al]) continue;
    const tr = treatyOf(state, owner, al);
    if (!tr || tr.type !== 'ally') continue;
    if (relationOf(state, owner, al) < 25) continue;
    if (!atWar(state, al, defender)) continue;
    if (Game.countOwned(state, al) === 0) continue;
    return true;
  }
  return false;
}

function buildRegionsFrom(generated) {
  const regions = [];
  for (let i = 0; i < generated.cells.length; i++) {
    const poly = generated.cells[i];
    const c = Geo.centroid(poly);
    const area = Math.abs(Geo.area(poly));
    regions.push({
      id: i,
      name: '',
      poly,
      cx: c.x,
      cy: c.y,
      area,
      r: Math.sqrt(area / Math.PI),
      neighbors: generated.adj[i].slice(),
      owner: -1,
      troops: 1,
      p: 0
    });
  }
  return regions;
}

/**
 * 참전하는 나라(activeCount)에게만 시작 영지를 나눠 준다.
 * 남는 나라는 영토 없이 중립으로 남는다. (AI 채우기 끔)
 */
function assignOwners(regions, activeCount) {
  const n = regions.length;
  const adj = regions.map((r) => r.neighbors);
  const taken = {};

  function grow(start, size) {
    const cluster = [start];
    taken[start] = true;
    while (cluster.length < size) {
      const cands = [];
      const seen = {};
      for (const ci of cluster) {
        for (const nb of regions[ci].neighbors) {
          if (taken[nb] || seen[nb]) continue;
          seen[nb] = true;
          cands.push(nb);
        }
      }
      if (!cands.length) break;
      cands.sort((a, b) => regions[b].neighbors.length - regions[a].neighbors.length);
      const chosen = rand() < 0.65 ? cands[0] : cands[Math.floor(rand() * cands.length)];
      taken[chosen] = true;
      cluster.push(chosen);
    }
    return cluster;
  }

  const pool = [];
  for (let p = 0; p < n; p++) {
    if (regions[p].neighbors.length >= 2) pool.push(p);
  }
  const pStart = pool.length ? pool[Math.floor(rand() * pool.length)] : 0;
  const zone0 = grow(pStart, 3);
  const ht = [3, 2, 2];
  for (let a = 0; a < zone0.length; a++) {
    regions[zone0[a]].owner = 0;
    regions[zone0[a]].troops = ht[a] || 2;
  }

  for (let ai = 1; ai < activeCount; ai++) {
    const sources = Object.keys(taken).map(Number);
    const dist = bfsDistances(adj, sources);
    let best = [], bestD = -3;
    for (let q = 0; q < n; q++) {
      if (taken[q]) continue;
      const d = dist[q] === Infinity ? -2 : dist[q];
      if (d > bestD) { bestD = d; best = [q]; }
      else if (d === bestD) best.push(q);
    }
    if (!best.length) break;
    const startId = best[Math.floor(rand() * best.length)];
    const zone = grow(startId, 3);
    const at = [4, 3, 3];
    for (let z = 0; z < zone.length; z++) {
      regions[zone[z]].owner = ai;
      regions[zone[z]].troops = at[z] || 2;
    }
  }

  for (let r = 0; r < n; r++) {
    if (regions[r].owner === -1) {
      regions[r].troops = rand() < 0.72 ? 1 : 2;
    }
  }
}

const Game = {
  TUNING: SIM,
  SIM,
  DUR,

  newGame(opts) {
    opts = opts || {};
    const W = opts.vw || 1000;
    const H = opts.vh || 1400;
    const want = opts.count || 28;
    const seed = opts.seed == null ? Math.floor(Math.random() * 2147483000) : (opts.seed | 0);
    setSeed(seed);

    let generated = null;
    for (let tryI = 0; tryI < 3 && !generated; tryI++) {
      generated = generateMap(W, H, want);
    }
    if (!generated) generated = generateMap(W, H, Math.max(12, want - 5));
    if (!generated) throw new Error('지도 생성 실패');

    const regions = buildRegionsFrom(generated);
    const names = shuffleArr(REGION_NAMES.slice()).slice(0, regions.length);
    for (let i = 0; i < regions.length; i++) regions[i].name = names[i];

    const humans = clampNum(opts.humans || 1, 1, NATION_COUNT);
    const aiFill = opts.aiFill !== false;
    const activeCount = clampNum(aiFill ? NATION_COUNT : humans, 1, NATION_COUNT);

    const active = [false, false, false, false];
    const human = [false, false, false, false];
    for (let h = 0; h < humans; h++) { active[h] = true; human[h] = true; }
    for (let a = humans; a < activeCount; a++) active[a] = true;

    assignOwners(regions, activeCount);

    const state = {
      seed,
      want,
      vw: W,
      vh: H,
      humans,
      activeCount,
      active,
      human,
      regions,
      total: regions.length,
      time: 0,
      over: null,
      capitals: [-1, -1, -1, -1],
      marches: [],
      nextMarchId: 1,
      treaties: {},
      proposals: [],
      nextProposalId: 1,
      grudge: {},
      relations: {},
      reputation: {},
      diploLog: [],
      calls: [],
      nextCallId: 1,
      names: NATIONS.map((n) => n.name),
      everEliminated: false,
      repTimer: 0,
      logRev: 0,
      overtimeAnnounced: false,
      ai: [
        { nextAt: 2200, nextDiploAt: 7000 },
        { nextAt: 2600, nextDiploAt: 9000 },
        { nextAt: 3000, nextDiploAt: 8000 },
        { nextAt: 3400, nextDiploAt: 10000 }
      ],
      stats: { battles: 0, captures: 0, dispatches: 0, betrayals: 0 }
    };
    for (let i = 0; i < NATION_COUNT; i++) {
      if (!active[i]) continue;
      state.reputation[i] = 60;
      for (let j = i + 1; j < NATION_COUNT; j++) {
        if (!active[j]) continue;
        state.relations[tkey(i, j)] = 0;
      }
    }
    // 수도: 시작 영토 중 병력이 가장 많은 곳
    for (let s = 0; s < NATION_COUNT; s++) {
      if (!active[s]) continue;
      let best = null;
      for (const r of regions) {
        if (r.owner !== s) continue;
        if (!best || r.troops > best.troops || (r.troops === best.troops && r.neighbors.length > best.neighbors.length)) best = r;
      }
      if (best) state.capitals[s] = best.id;
    }
    return state;
  },

  countOwned(state, owner) {
    let c = 0;
    for (const r of state.regions) if (r.owner === owner) c++;
    return c;
  },

  totalTroops(state, owner) {
    let t = 0;
    for (const r of state.regions) if (r.owner === owner) t += r.troops;
    return t;
  },

  strength(state, owner) {
    return Game.countOwned(state, owner) * 1.6 + Game.totalTroops(state, owner);
  },

  borderThreat(state, defender, attacker) {
    let t = 0;
    for (const r of state.regions) {
      if (r.owner !== attacker) continue;
      for (const nb of r.neighbors) {
        if (state.regions[nb].owner === defender) { t += r.troops; break; }
      }
    }
    return t;
  },

  /* ---------------- 실시간 병력 생산 ---------------- */

  overtimeMult(state) {
    if (state.time <= SIM.overtimeAfterMs) return 1;
    const steps = Math.floor((state.time - SIM.overtimeAfterMs) / SIM.overtimeStepMs);
    return Math.min(2, 1 + SIM.overtimeGain * steps);
  },

  prodCapOf(state, r) {
    const capBonus = Math.min(4, Math.round(r.neighbors.length * SIM.capNeighbor));
    const capHome = state.capitals[r.owner] === r.id ? SIM.capCapital : 0;
    return Math.round((SIM.capBase + capBonus + capHome) * Game.overtimeMult(state));
  },

  productionRateOf(state, owner) {
    let perSec = 0;
    const mul = Game.overtimeMult(state);
    for (const r of state.regions) {
      if (r.owner !== owner) continue;
      const cap = Game.prodCapOf(state, r);
      if (r.troops >= cap) continue;
      const period = SIM.prodMs / (state.capitals[owner] === r.id ? SIM.capitalProdMul : 1);
      const slow = r.troops >= cap * SIM.slowAbove ? SIM.slowMul : 1;
      perSec += (1000 / period) * slow * mul;
    }
    return Math.round(perSec * 10) / 10;
  },

  tickProduction(state, dt) {
    const mul = Game.overtimeMult(state);
    for (const r of state.regions) {
      if (r.owner < 0) { r.p = 0; continue; }
      const cap = Game.prodCapOf(state, r);
      if (r.troops >= cap) { r.p = 0; continue; }
      const period = SIM.prodMs / (state.capitals[r.owner] === r.id ? SIM.capitalProdMul : 1);
      const slow = r.troops >= cap * SIM.slowAbove ? SIM.slowMul : 1;
      r.p += (dt / period) * slow * mul;
      let guard = 0;
      while (r.p >= 1 && r.troops < cap && guard++ < 200) {
        r.p -= 1;
        r.troops += 1;
      }
      if (r.troops >= cap || r.p >= 1) r.p = 0;
    }
  },

  /* ---------------- 출정 · 행군 · 전투 ---------------- */

  dispatch(state, slot, fromIdx, toIdx, ratio) {
    const from = state.regions[fromIdx];
    const to = state.regions[toIdx];
    if (!from || !to) return { ok: false, reason: 'missing' };
    if (fromIdx === toIdx) return { ok: false, reason: 'same' };
    if (from.neighbors.indexOf(toIdx) < 0) return { ok: false, reason: 'far' };
    if (from.owner !== slot) return { ok: false, reason: 'owner' };
    if (from.troops < 2) return { ok: false, reason: 'weak' };
    if (state.over) return { ok: false, reason: 'over' };
    if (state.marches.length >= SIM.maxMarches) return { ok: false, reason: 'busy' };
    const isOwn = to.owner === slot;
    if (to.owner >= 0 && !isOwn) {
      const pact = treatyOf(state, slot, to.owner);
      if (pact) return { ok: false, reason: 'treaty', treaty: pact };
    }
    let r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0) r = SIM.ratioDefault;
    r = clampNum(r, 0.1, 1);
    let n = Math.floor(from.troops * r);
    if (r >= 0.999) n = from.troops - 1;
    n = clampNum(n, 1, from.troops - 1);

    from.troops -= n;
    const march = {
      id: state.nextMarchId++,
      owner: slot,
      from: fromIdx,
      to: toIdx,
      troops: n,
      startAt: state.time,
      arriveAt: state.time + SIM.marchMs,
      dur: SIM.marchMs
    };
    state.marches.push(march);
    state.stats.dispatches++;
    return {
      ok: true,
      march,
      troops: n,
      attack: !isOwn,
      fromName: from.name,
      toName: to.name,
      fromLeft: from.troops
    };
  },

  /** 행군 도착 처리: 같은 편이면 합류, 아니면 전투 */
  resolveMarch(state, m) {
    const to = state.regions[m.to];
    const from = state.regions[m.from];
    if (!to) return null;
    const attacker = nationName(state, m.owner);
    const atkAlive = m.owner >= 0 && state.active[m.owner] &&
      Game.countOwned(state, m.owner) > 0;

    if (to.owner === m.owner) {
      to.troops += m.troops;
      return {
        kind: 'reinforce',
        text: attacker + ' 병력 ' + m.troops + ' → ' + to.name + ' 합류 (' + to.troops + ')',
        silent: true,
        at: m.to, troops: m.troops
      };
    }

    const defOwner = to.owner;
    // 행군 중 휴전이 맺어졌다면 회군
    if (defOwner >= 0 && treatyOf(state, m.owner, defOwner)) {
      if (from && from.owner === m.owner) from.troops += m.troops;
      return {
        kind: 'info',
        text: '휴전 성립 · ' + attacker + ' 행군 회군 (' + to.name + ')',
        silent: false
      };
    }

    if (!atkAlive) {
      return { kind: 'fade', text: attacker + ' 행군 소멸 (' + to.name + ')', silent: true };
    }

    const isCap = defOwner >= 0 && state.capitals[defOwner] === to.id;
    const defPower = to.troops * (isCap ? SIM.capitalDefBonus : SIM.defBonus);
    const allyBonus = defOwner >= 0 && hasAllyAgainst(state, m.owner, defOwner);
    const atkPower = m.troops * (1 + (allyBonus ? SIM.allyAttackBonus : 0)) * (0.92 + rand() * 0.16);

    state.stats.battles++;
    let captured = false;
    let aLoss = 0;
    let dLoss = 0;

    if (atkPower > defPower) {
      const share = defPower / Math.max(0.001, atkPower);
      aLoss = Math.min(m.troops - 1, Math.round(m.troops * share * 0.6));
      dLoss = to.troops;
      captured = true;
    } else {
      aLoss = m.troops;
      dLoss = Math.min(to.troops, Math.round(to.troops * (atkPower / Math.max(0.001, defPower)) * 0.75));
    }

    if (captured) {
      const survivors = clampNum(m.troops - aLoss, 1, m.troops);
      const wasCapital = isCap && defOwner >= 0;
      to.owner = m.owner;
      to.troops = survivors;
      to.p = 0;
      if (wasCapital) state.capitals[defOwner] = -1;
      state.stats.captures++;
      if (defOwner >= 0) {
        addRelation(state, m.owner, defOwner, -12);
        if (allyBonus) {
          for (let al = 0; al < NATION_COUNT; al++) {
            if (al === m.owner || !state.active[al]) continue;
            const at = treatyOf(state, m.owner, al);
            if (at && at.type === 'ally' && relationOf(state, m.owner, al) >= 25 && atWar(state, al, defOwner)) {
              addRelation(state, m.owner, al, 4);
            }
          }
        }
      }
      let text = attacker + ' ✦ ' + to.name + ' 점령 · 병력 ' + survivors + ' 주둔' +
        (defOwner >= 0 ? ' · ' + nationName(state, defOwner) + ' -' + dLoss : '');
      if (wasCapital) text += ' · 수도 함락!';
      return {
        kind: captured ? 'good' : 'info',
        text,
        battle: true,
        captured: true,
        at: to.id,
        region: to.name,
        attacker: m.owner,
        defender: defOwner,
        troops: survivors,
        capital: wasCapital
      };
    }

    to.troops = Math.max(1, to.troops - dLoss);
    return {
      kind: 'warn',
      text: attacker + ' 공격 실패 · ' + to.name + ' · 아군 -' + aLoss + ' / 적 -' + dLoss +
        (allyBonus ? ' [동맹 +]' : ''),
      battle: true,
      captured: false,
      at: to.id,
      region: to.name,
      attacker: m.owner,
      defender: defOwner
    };
  },

  checkOver(state) {
    if (state.over) return state.over;
    const total = state.regions.length;
    for (let i = 0; i < NATION_COUNT; i++) {
      if (state.active[i] && Game.countOwned(state, i) === total) {
        state.over = { type: 'nation', winner: i, at: state.time };
        return state.over;
      }
    }
    let alive = 0, last = -1;
    for (let i = 0; i < NATION_COUNT; i++) {
      if (!state.active[i]) continue;
      const c = Game.countOwned(state, i);
      if (c > 0) { alive++; last = i; }
      else state.everEliminated = true;
    }
    if (alive === 1 && state.everEliminated) {
      state.over = { type: 'lastStanding', winner: last, at: state.time };
    } else if (alive === 0) {
      state.over = { type: 'draw', winner: -1, at: state.time };
    }
    return state.over;
  },

  /* ---------------- 외교: 조약 · 제안 · 평판 ---------------- */

  createTreaty(state, a, b, type, sec, extra) {
    const k = tkey(a, b);
    const prev = state.treaties[k];
    const use = type || 'truce';
    const durMs = Math.max(5, (sec || DUR[use] || 45)) * 1000;
    const tr = {
      a: Math.min(a, b),
      b: Math.max(a, b),
      type: use,
      until: state.time + durMs,
      since: prev ? prev.since : state.time,
      nextPayAt: state.time + DUR.tributePay * 1000
    };
    if (extra) Object.assign(tr, extra);
    state.treaties[k] = tr;
    state.proposals = state.proposals.filter(
      (p) => !((p.from === a && p.to === b) || (p.from === b && p.to === a))
    );
    return tr;
  },

  removeTreaty(state, a, b) {
    const k = tkey(a, b);
    const tr = state.treaties[k];
    if (!tr) return null;
    delete state.treaties[k];
    return tr;
  },

  breakPact(state, from, to) {
    const tr = Game.removeTreaty(state, from, to);
    if (!tr) return null;
    if (to >= 0) state.grudge[to] = { at: from, until: state.time + DUR.grudge * 1000 };
    addRelation(state, from, to, -55);
    addReputation(state, from, -35);
    state.stats.betrayals++;
    for (let i = 0; i < NATION_COUNT; i++) {
      if (i === from || i === to || !state.active[i]) continue;
      addRelation(state, from, i, -8);
    }
    state.calls = state.calls.filter(
      (c) => !((c.from === from && c.to === to) || (c.from === to && c.to === from))
    );
    state.proposals = state.proposals.filter(
      (p) => !((p.from === from && p.to === to) || (p.from === to && p.to === from))
    );
    diploNote(state, nationName(state, from) + '이(가) ' + nationName(state, to) +
      '와(과)의 ' + treatyLabel(tr) + '을(를) 파기했습니다 · 신뢰도 -35',
      'bad', [from, to]);
    return tr;
  },

  payTribute(state, tr) {
    const payer = tr.payer, payee = tr.payee;
    if (payer == null || payee == null) return { ok: false };
    const amount = Math.max(1, tr.amount || 1);
    let source = null;
    for (const r of state.regions) {
      if (r.owner !== payer || r.troops < amount + 1) continue;
      if (!source || r.troops > source.troops) source = r;
    }
    if (!source) return { ok: false };
    let target = null;
    for (const q of state.regions) {
      if (q.owner !== payee) continue;
      if (!q.neighbors.some((nb) => state.regions[nb].owner === payer)) continue;
      if (!target || q.troops < target.troops) target = q;
    }
    if (!target) {
      for (const q of state.regions) {
        if (q.owner === payee && (!target || q.troops < target.troops)) target = q;
      }
    }
    if (!target) return { ok: false };
    source.troops -= amount;
    target.troops += amount;
    addRelation(state, payer, payee, 4);
    addReputation(state, payer, 2);
    return { ok: true, from: payer, to: payee, amount, region: target.name };
  },

  /** 매 스텝 호출: 조공 지급 · 조약 만료 · 제안 만료 · 신뢰 회복 */
  tickDiplomacy(state, dt) {
    const events = [];
    for (const k of Object.keys(state.treaties)) {
      const tr = state.treaties[k];
      if (!tr) continue;
      if (tr.type === 'tribute' && state.time >= tr.nextPayAt) {
        tr.nextPayAt = state.time + DUR.tributePay * 1000;
        const paid = Game.payTribute(state, tr);
        if (paid.ok) {
          diploNote(state, nationName(state, tr.payer) + ' → ' + nationName(state, tr.payee) +
            ' 조공 ' + paid.amount + ' (' + paid.region + ')', 'tribute', [tr.payer, tr.payee]);
          events.push({
            kind: 'tribute',
            text: '조공 · ' + nationName(state, tr.payer) + ' → ' + nationName(state, tr.payee) +
              ' ' + paid.amount + '개',
            silent: true
          });
        } else {
          delete state.treaties[k];
          addReputation(state, tr.payer, -10);
          addRelation(state, tr.payer, tr.payee, -15);
          diploNote(state, nationName(state, tr.payer) + '이(가) 조공을 이행하지 못해 조약이 깨졌습니다',
            'bad', [tr.payer, tr.payee]);
          events.push({
            kind: 'bad',
            text: '조공 미이행 · ' + nationName(state, tr.payer) + ' ↔ ' + nationName(state, tr.payee) + ' 조약 파기'
          });
          continue;
        }
      }
      if (state.time >= tr.until) {
        const label = treatyLabel(tr);
        delete state.treaties[k];
        diploNote(state, label + ' 만료 · ' + nationName(state, tr.a) + ' ↔ ' + nationName(state, tr.b),
          'warn', [tr.a, tr.b]);
        events.push({
          kind: 'warn',
          text: label + ' 만료 · ' + nationName(state, tr.a) + ' ↔ ' + nationName(state, tr.b)
        });
      }
    }

    for (const c of state.calls.slice()) {
      if (state.time >= c.until) {
        state.calls = state.calls.filter((x) => x !== c);
        events.push({
          kind: 'info', silent: true,
          text: '공동 참전 종료 · ' + nationName(state, c.to) + ' → ' + nationName(state, c.target)
        });
      }
    }

    for (const k of Object.keys(state.grudge)) {
      const gr = state.grudge[k];
      if (!gr) continue;
      if (state.time >= gr.until) delete state.grudge[k];
    }

    for (const p of state.proposals.slice()) {
      if (state.time - p.at >= DUR.proposal * 1000) {
        state.proposals = state.proposals.filter((x) => x !== p);
        events.push({
          kind: 'info', silent: true,
          text: nationName(state, p.from) + '의 제안이 만료되었습니다'
        });
      }
    }

    state.repTimer += dt;
    while (state.repTimer >= 10000) {
      state.repTimer -= 10000;
      for (let i = 0; i < NATION_COUNT; i++) {
        if (state.active[i] && Game.countOwned(state, i) > 0) addReputation(state, i, 1);
      }
    }

    if (!state.overtimeAnnounced && state.time >= SIM.overtimeAfterMs) {
      state.overtimeAnnounced = true;
      events.push({
        kind: 'warn',
        text: '⏱ 6분 경과 · 병력 생산이 빨라집니다 (결전 모드)'
      });
    }
    return events;
  },

  evaluateTruce(state, ai, other) {
    const mine = Game.strength(state, ai);
    const theirs = Game.strength(state, other);
    let score = relationOf(state, ai, other) / 25 + (reputationOf(state, other) - 50) / 28;

    if (theirs > mine * 1.2) score += 2.0;
    else if (theirs > mine * 0.95) score += 0.8;
    else if (theirs < mine * 0.72) score -= 1.5;

    const pressure = Game.borderThreat(state, ai, other);
    score += clampNum(pressure / Math.max(5, mine * 0.4), 0, 2.0);

    const two = twoFrontCount(state, ai);
    score += Math.min(1.0, two * 0.5);

    const leader = leaderOf(state);
    if (leader >= 0 && leader !== ai && leader !== other) score += 1.1;
    if (leader === other) score += 0.5;

    if (reputationOf(state, other) < 30) score -= 1.8;
    else if (reputationOf(state, other) < 45) score -= 0.8;
    if (relationOf(state, ai, other) < -35) score -= 1.0;

    score += rand() * 1.0 - 0.4;
    return score >= 1.0;
  },

  evaluateAlliance(state, ai, other) {
    const tr = treatyOf(state, ai, other);
    if (!tr || tr.type !== 'truce') return false;
    if (relationOf(state, ai, other) < 18) return false;
    if (reputationOf(state, other) < 35) return false;
    let score = relationOf(state, ai, other) / 22 + (reputationOf(state, other) - 50) / 30 + 1.0;
    const leader = leaderOf(state);
    if (leader >= 0 && leader !== ai && leader !== other) score += 1.2;
    if (twoFrontCount(state, ai) >= 2) score += 0.8;
    if (Game.strength(state, other) > Game.strength(state, ai) * 0.9) score += 0.4;
    score += rand() * 1.1 - 0.4;
    return score >= 2.4;
  },

  evaluateTributeDemand(state, ai, demander, amount) {
    const mine = Game.strength(state, ai);
    const theirs = Game.strength(state, demander);
    let score = 0;
    if (theirs > mine * 1.25) score += 1.5;
    else if (theirs > mine) score += 0.5;
    else score -= 1.1;
    if (twoFrontCount(state, ai) >= 2) score += 1.0;
    score += relationOf(state, ai, demander) / 40;
    score += (reputationOf(state, demander) - 50) / 40;
    if (amount >= 2) score -= 0.6;
    if (reputationOf(state, demander) < 25) score -= 0.8;
    score += rand() * 0.8 - 0.3;
    return score >= 1.0;
  },

  evaluateTributeOffer(state, ai, payer, amount) {
    if (reputationOf(state, payer) < 20) return false;
    const score = 0.8 + amount * 0.4 + relationOf(state, ai, payer) / 40 +
      (reputationOf(state, payer) - 50) / 40;
    return score >= 0.9;
  },

  evaluateCede(state, ai, other, region, withTruce) {
    if (!region) return false;
    let score = 0;
    if (region.neighbors.some((nb) => state.regions[nb].owner === ai)) score += 2.2;
    score += relationOf(state, ai, other) >= 0 ? 1.0 : relationOf(state, ai, other) / 30;
    if (withTruce) score += 1.2;
    if (Game.strength(state, other) > Game.strength(state, ai) * 1.2) score += 0.8;
    if (reputationOf(state, other) < 25) score -= 1.0;
    score += rand() * 0.8 - 0.3;
    return score >= 1.4;
  },

  queueProposal(state, from, to, fields) {
    const kind = fields.kind || 'truce';
    if (state.proposals.some((p) => p.from === from && p.to === to && p.kind === kind)) return null;
    const p = Object.assign({ id: state.nextProposalId++, from, to, at: state.time }, fields);
    p.kind = kind;
    state.proposals.push(p);
    return p;
  },

  proposeTruce(state, from, to, sec) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    if (treatyOf(state, from, to)) return { status: 'none', reason: 'already' };
    const t = sec || DUR.truce;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'truce');
      const p = Game.queueProposal(state, from, to, { kind: 'truce', sec: t });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '불가침 조약을 제안했습니다' };
    }
    if (Game.evaluateTruce(state, to, from)) {
      Game.createTreaty(state, from, to, 'truce', t);
      addRelation(state, from, to, 5);
      addReputation(state, from, 2);
      const text = nationName(state, from) + ' ↔ ' + nationName(state, to) +
        ' 불가침 조약 체결 (' + t + '초)';
      diploNote(state, text, 'good', [from, to]);
      return { status: 'accepted', sec: t, text };
    }
    const text = nationName(state, to) + '이(가) 불가침 제안을 거절했습니다';
    diploNote(state, text, 'warn', [from, to]);
    return { status: 'declined', text };
  },

  proposeAlliance(state, from, to, sec) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    const tr = treatyOf(state, from, to);
    if (!tr || tr.type === 'ally') return { status: 'none', reason: 'need_truce' };
    if (tr.type === 'tribute') return { status: 'none', reason: 'need_truce' };
    const t = sec || DUR.ally;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'ally');
      const p = Game.queueProposal(state, from, to, { kind: 'ally', sec: t });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '동맹을 제안했습니다' };
    }
    if (Game.evaluateAlliance(state, to, from)) {
      Game.createTreaty(state, from, to, 'ally', t);
      addRelation(state, from, to, 10);
      addReputation(state, from, 4);
      const text = nationName(state, from) + ' ↔ ' + nationName(state, to) +
        ' 정식 동맹 체결 (' + t + '초 · 공동 참전 가능)';
      diploNote(state, text, 'good', [from, to]);
      return { status: 'accepted', sec: t, text };
    }
    const text = nationName(state, to) + '이(가) 동맹 제안을 거절했습니다';
    diploNote(state, text, 'warn', [from, to]);
    return { status: 'declined', text };
  },

  proposeTribute(state, from, to, amount, direction) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    if (treatyOf(state, from, to)) return { status: 'none', reason: 'already' };
    const amt = clampNum(Math.floor(Number(amount) || 1), 1, 2);
    const dir = direction === 'offer' ? 'offer' : 'demand';
    const t = DUR.tribute;
    const payer = dir === 'demand' ? to : from;
    const payee = dir === 'demand' ? from : to;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'tribute');
      const p = Game.queueProposal(state, from, to, {
        kind: 'tribute', sec: t, amount: amt, direction: dir,
        payer, payee
      });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '조공을 제안했습니다' };
    }

    const accepted = dir === 'demand'
      ? Game.evaluateTributeDemand(state, to, from, amt)
      : Game.evaluateTributeOffer(state, to, from, amt);
    if (!accepted) {
      const text = nationName(state, to) + '이(가) 조공 ' +
        (dir === 'demand' ? '요구' : '제안') + '을 거절했습니다';
      addRelation(state, from, to, -3);
      diploNote(state, text, 'warn', [from, to]);
      return { status: 'declined', text };
    }
    Game.createTreaty(state, from, to, 'tribute', t, { payer, payee, amount: amt });
    addRelation(state, from, to, 3);
    if (dir === 'offer') addReputation(state, payer, 3); else addReputation(state, payer, -2);
    const text = nationName(state, payer) + ' → ' + nationName(state, payee) + ' 조공 ' +
      amt + '개씩 ' + t + '초 조약 체결';
    diploNote(state, text, 'tribute', [from, to]);
    return { status: 'accepted', sec: t, text };
  },

  proposeCede(state, from, to, regionId, withTruce) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    const region = state.regions[regionId];
    if (!region || region.owner !== from) return { status: 'none', reason: 'region' };

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'cede');
      const p = Game.queueProposal(state, from, to, {
        kind: 'cede', regionId, regionName: region.name,
        withTruce: !!withTruce, sec: withTruce ? DUR.truce : 0
      });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '영토 할양을 제안했습니다' };
    }
    if (Game.evaluateCede(state, to, from, region, withTruce)) {
      Game.applyCede(state, from, to, regionId, withTruce);
      const text = nationName(state, from) + '이(가) ' + nationName(state, to) +
        '에게 ' + region.name + ' 할양' + (withTruce ? ' · 불가침 체결' : '');
      return { status: 'accepted', text };
    }
    const text = nationName(state, to) + '이(가) 영토 할양 제안을 거절했습니다';
    diploNote(state, text, 'warn', [from, to]);
    return { status: 'declined', text };
  },

  applyCede(state, from, to, regionId, withTruce) {
    const region = state.regions[regionId];
    if (!region || region.owner !== from) return null;
    region.owner = to;
    region.troops = 1;
    region.p = 0;
    if (state.capitals[from] === region.id) state.capitals[from] = -1;
    addRelation(state, from, to, 25);
    addReputation(state, from, 5);
    if (withTruce) {
      const prev = treatyOf(state, from, to);
      if (!prev) {
        Game.createTreaty(state, from, to, 'truce', DUR.truce);
      } else if (prev.type === 'truce') {
        prev.until = Math.max(prev.until, state.time + DUR.truce * 1000);
      }
    }
    const text = nationName(state, from) + ' → ' + nationName(state, to) + ' ' + region.name +
      ' 할양 · 관계 +25' + (withTruce ? ' · 불가침 ' + DUR.truce + '초' : '');
    diploNote(state, text, 'good', [from, to]);
    return region;
  },

  callToArms(state, from, to, target) {
    if (from === to || to < 0 || target < 0) return { status: 'none', reason: 'self' };
    if (!state.active[to] || Game.countOwned(state, to) === 0) return { status: 'none', reason: 'dead' };
    if (!state.active[target] || Game.countOwned(state, target) === 0) return { status: 'none', reason: 'target' };
    const tr = treatyOf(state, from, to);
    if (!tr || tr.type !== 'ally') return { status: 'none', reason: 'no_ally' };
    if (target === to || !atWar(state, from, target)) return { status: 'none', reason: 'not_enemy' };
    if (!atWar(state, to, target)) return { status: 'none', reason: 'ally_truce' };
    if (state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'call' && p.target === target)) {
      return { status: 'none', reason: 'dup' };
    }
    if (state.calls.some((c) => c.from === from && c.to === to && c.target === target && c.until > state.time)) {
      return { status: 'none', reason: 'dup' };
    }

    if (state.human[to]) {
      const p = Game.queueProposal(state, from, to, {
        kind: 'call', target, targetName: nationName(state, target), sec: DUR.call
      });
      return { status: 'queued', proposal: p, text: nationName(state, to) + '에 공동 참전을 요청했습니다' };
    }

    const worth = target === leaderOf(state) ||
      Game.borderThreat(state, to, target) > 0 ||
      Game.strength(state, target) > Game.strength(state, to) * 0.75;
    const accepted = relationOf(state, from, to) >= 30 && worth;
    if (!accepted) {
      const text = nationName(state, to) + '이(가) 공동 참전 요청을 거절했습니다';
      addRelation(state, from, to, -8);
      diploNote(state, text, 'warn', [from, to]);
      return { status: 'declined', text };
    }
    Game.addCall(state, from, to, target);
    addRelation(state, from, to, 10);
    diploNote(state, nationName(state, from) + ' ↔ ' + nationName(state, to) +
      ' 공동 참전 · 목표 ' + nationName(state, target), 'good', [from, to, target]);
    return {
      status: 'accepted',
      text: nationName(state, to) + '이(가) ' + nationName(state, target) + ' 에 대한 공동 참전을 수락했습니다'
    };
  },

  addCall(state, from, to, target) {
    const c = {
      id: state.nextCallId++,
      from, to, target,
      until: state.time + DUR.call * 1000,
      at: state.time
    };
    state.calls.push(c);
    return c;
  },

  resolveProposal(state, p, accept) {
    state.proposals = state.proposals.filter((x) => x.id !== p.id);
    if (!accept) {
      const penalty = { truce: 2, ally: 4, tribute: 3, cede: 1, call: 8 }[p.kind] || 2;
      addRelation(state, p.from, p.to, -penalty);
      const text = nationName(state, p.to) + '이(가) ' + nationName(state, p.from) + '의 제안을 거절했습니다';
      diploNote(state, text, 'warn', [p.from, p.to]);
      return { ok: true, accepted: false, text };
    }
    let text = '';
    let skipNote = false;
    if (p.kind === 'truce') {
      Game.createTreaty(state, p.from, p.to, 'truce', p.sec || DUR.truce);
      addRelation(state, p.from, p.to, 5);
      addReputation(state, p.from, 2);
      text = nationName(state, p.from) + ' ↔ ' + nationName(state, p.to) +
        ' 불가침 조약 체결 (' + (p.sec || DUR.truce) + '초)';
    } else if (p.kind === 'ally') {
      Game.createTreaty(state, p.from, p.to, 'ally', p.sec || DUR.ally);
      addRelation(state, p.from, p.to, 10);
      addReputation(state, p.from, 4);
      text = nationName(state, p.from) + ' ↔ ' + nationName(state, p.to) +
        ' 정식 동맹 체결 (' + (p.sec || DUR.ally) + '초)';
    } else if (p.kind === 'tribute') {
      const payer = p.payer != null ? p.payer : (p.direction === 'demand' ? p.to : p.from);
      const payee = p.payee != null ? p.payee : (p.direction === 'demand' ? p.from : p.to);
      Game.createTreaty(state, p.from, p.to, 'tribute', p.sec || DUR.tribute, {
        payer, payee, amount: clampNum(p.amount || 1, 1, 2)
      });
      addRelation(state, p.from, p.to, 3);
      if (p.direction === 'offer') addReputation(state, payer, 3); else addReputation(state, payer, -2);
      text = nationName(state, payer) + ' → ' + nationName(state, payee) + ' 조공 ' +
        clampNum(p.amount || 1, 1, 2) + '개씩 ' + (p.sec || DUR.tribute) + '초 조약 체결';
    } else if (p.kind === 'cede') {
      Game.applyCede(state, p.from, p.to, p.regionId, p.withTruce);
      text = nationName(state, p.from) + ' → ' + nationName(state, p.to) + ' ' +
        (p.regionName || '영토') + ' 할양' + (p.withTruce ? ' · 불가침 체결' : '');
      skipNote = true;
    } else if (p.kind === 'call') {
      Game.addCall(state, p.from, p.to, p.target);
      addRelation(state, p.from, p.to, 10);
      addReputation(state, p.from, 2);
      text = nationName(state, p.to) + '이(가) ' + nationName(state, p.from) +
        '의 공동 참전 요청을 수락 · 목표 ' + nationName(state, p.target);
    }
    if (text && !skipNote) diploNote(state, text, 'good', [p.from, p.to, p.target]);
    return { ok: true, accepted: true, text, kind: p.kind };
  },

  canAid(state, from) {
    return state.regions.some((r) => r.owner === from && r.troops >= 6);
  },

  sendAid(state, from, to) {
    if (from === to || to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { ok: false, reason: 'target' };
    }
    if (!state.human[from]) return { ok: false, reason: 'turn' };
    const need = 3;
    let best = null;
    for (const r of state.regions) {
      if (r.owner !== from || r.troops < 6) continue;
      if (!best || r.troops > best.troops) best = r;
    }
    if (!best) return { ok: false, reason: 'short' };
    best.troops -= need;

    let target = null;
    for (const q of state.regions) {
      if (q.owner !== to) continue;
      for (const nb of q.neighbors) {
        if (state.regions[nb].owner === from) { target = q; break; }
      }
      if (target) break;
    }
    if (!target) {
      for (const zz of state.regions) {
        if (zz.owner === to && (!target || zz.troops < target.troops)) target = zz;
      }
    }
    if (!target) return { ok: false, reason: 'target' };
    target.troops += need;

    const tr = treatyOf(state, from, to);
    if (tr && tr.type !== 'tribute') {
      tr.type = 'ally';
      tr.until = Math.max(tr.until, state.time + DUR.ally * 1000);
    } else if (!tr) {
      Game.createTreaty(state, from, to, 'ally', DUR.ally);
    }
    addRelation(state, from, to, 15);
    addReputation(state, from, 3);
    const after = treatyOf(state, from, to);
    const left = after ? Math.max(0, Math.round((after.until - state.time) / 1000)) : DUR.ally;
    const text = nationName(state, from) + ' → ' + nationName(state, to) + ' 병력 ' + need +
      ' 지원 (' + best.name + ') · 관계 +15';
    diploNote(state, text, 'good', [from, to]);
    return {
      ok: true,
      amount: need,
      source: 'territory',
      srcName: best.name,
      region: target.name,
      sec: left,
      text
    };
  },

  /* ---------------- AI 실시간 판단 ---------------- */

  frontlineScore(state, ai, r) {
    const leader = leaderOf(state);
    const callTargets = callTargetsFor(state, ai);
    const grudge = state.grudge[ai];
    let threat = 0, opportunity = 0, bonus = 0;
    for (const nb of r.neighbors) {
      const t = state.regions[nb];
      if (t.owner === ai) continue;
      if (t.owner >= 0 && treatyOf(state, ai, t.owner)) continue;
      threat += t.troops * (state.human[t.owner] ? 1.2 : 1);
      const diff = r.troops - t.troops;
      const need = t.owner === -1 ? 1 : 2;
      if (diff >= need) opportunity = Math.max(opportunity, diff + (t.owner === -1 ? 1.2 : 0));
      if (leader >= 0 && t.owner === leader) bonus += 1.6;
      if (callTargets.has(t.owner)) bonus += 3.5;
      if (t.owner === -1 && state.time < 30000) bonus += 1.0;
      if (t.troops <= 1 && t.owner >= 0) bonus += 0.8;
    }
    if (grudge) bonus += 1.2;
    return threat * 1.35 + opportunity + bonus;
  },

  /** 전선에 병력이 부족할 때 인접 아군 영토에서 행군시킨다 */
  aiDefend(state, ai) {
    const incoming = state.marches.filter((m) => m.owner !== ai && state.regions[m.to] && state.regions[m.to].owner === ai);
    if (!incoming.length) return 0;
    let acted = 0;
    for (const m of incoming) {
      if (acted >= 2) break;
      const target = state.regions[m.to];
      if (target.troops >= m.troops + 1) continue;
      let best = null;
      for (const nb of target.neighbors) {
        const r = state.regions[nb];
        if (r.owner !== ai || r.id === target.id || r.troops < 3) continue;
        if (!best || r.troops > best.troops) best = r;
      }
      if (!best) continue;
      const res = Game.dispatch(state, ai, best.id, target.id, 0.7);
      if (res.ok) acted++;
    }
    return acted;
  },

  /** 후방 병력을 전선으로 이동 (행군으로) */
  aiMarchShift(state, ai) {
    const own = state.regions.filter((r) => r.owner === ai);
    if (own.length < 2) return 0;
    const dist = {};
    const q = [];
    for (const r of own) {
      if (r.neighbors.some((nb) => state.regions[nb].owner !== ai)) {
        dist[r.id] = 0;
        q.push(r.id);
      }
    }
    if (!q.length) return 0;
    for (let h = 0; h < q.length; h++) {
      const v = state.regions[q[h]];
      for (const nb of v.neighbors) {
        const t = state.regions[nb];
        if (t.owner === ai && dist[t.id] == null) {
          dist[t.id] = dist[v.id] + 1;
          q.push(t.id);
        }
      }
    }
    const rear = own.filter((r) => dist[r.id] > 0 && r.troops >= 4).sort((a, b) => dist[b.id] - dist[a.id]);
    let moved = 0;
    for (const r of rear) {
      if (moved >= 4) break;
      let best = null, bestD = dist[r.id];
      for (const nb of r.neighbors) {
        const t = state.regions[nb];
        if (t.owner !== ai) continue;
        const d = dist[t.id];
        if (d == null || d >= bestD) continue;
        bestD = d;
        best = t;
      }
      if (!best) continue;
      if (Game.dispatch(state, ai, r.id, best.id, 1).ok) moved++;
    }
    return moved;
  },

  /** 가장 유리한 전선 한 곳에 인접 병력을 한꺼번에 모은다 (결정적 돌파용) */
  aiMassToFront(state, ai) {
    let best = null, bestScore = -1e9;
    for (const r of state.regions) {
      if (r.owner !== ai) continue;
      for (const nb of r.neighbors) {
        const t = state.regions[nb];
        if (t.owner === ai) continue;
        if (t.owner >= 0 && treatyOf(state, ai, t.owner)) continue;
        const score = r.troops - t.troops * 1.25 + (t.owner === -1 ? 2 : 0) +
          (state.capitals[t.owner] === t.id ? 0.5 : 0);
        if (score > bestScore) { bestScore = score; best = r; }
      }
    }
    if (!best) return 0;
    let moved = 0;
    for (const nb of best.neighbors) {
      const r = state.regions[nb];
      if (r.owner !== ai || r.id === best.id || r.troops < 3) continue;
      if (Game.dispatch(state, ai, r.id, best.id, 1).ok) moved++;
    }
    if (moved < 2) Game.aiMarchShift(state, ai);
    return moved;
  },

  aiPickAttack(state, ai) {
    let best = null, bestScore = -1e9;
    const grudge = state.grudge[ai];
    const leader = leaderOf(state);
    const callTargets = callTargetsFor(state, ai);
    for (const r of state.regions) {
      if (r.owner !== ai || r.troops < 2) continue;
      for (const nb of r.neighbors) {
        const t = state.regions[nb];
        if (t.owner === ai) continue;
        if (t.troops < 1) continue;
        if (t.owner >= 0 && treatyOf(state, ai, t.owner)) continue;
        const diff = r.troops - t.troops;
        const need = t.owner === -1 ? 1 : 2;
        if (diff < need) continue;
        // 출정은 병력 대부분(1개 남김)을 보낸다 → 이길 수 있을 때만 움직인다
        if (t.owner >= 0) {
          const capTarget = state.capitals[t.owner] === t.id;
          const needForce = t.troops * (capTarget ? SIM.capitalDefBonus : SIM.defBonus) + 1;
          if (r.troops - 1 < needForce) continue;
        }

        let score = diff * 1.15;
        if (t.owner === -1) score += state.time < 30000 ? 2.4 : 0.6;
        if (t.troops <= 1 && t.owner >= 0) score += 2.0;
        if (leader >= 0 && t.owner === leader) score += 1.6;
        if (callTargets.has(t.owner)) score += 5.0;
        if (grudge && grudge.at === t.owner) score += 2.2;
        if (state.human[t.owner]) score += 0.3;

        let danger = 0;
        for (const nn of r.neighbors) {
          if (nn === t.id) continue;
          const e = state.regions[nn];
          if (e.owner === ai) continue;
          if (e.owner >= 0 && treatyOf(state, ai, e.owner)) continue;
          if (e.troops > 2) danger += e.troops;
        }
        if (danger >= 4 && !(t.troops <= 1 && t.neighbors.length >= 4)) score -= 2.8;
        if (r.troops <= 2) score -= 1.5;
        if (t.owner === -1 && t.neighbors.length <= 2) score -= 0.4;
        score += rand() * 0.6;
        if (score > bestScore) { bestScore = score; best = { from: r, to: t, score }; }
      }
    }
    if (!best || bestScore <= 0.5) return null;
    return best;
  },

  nudgeAiCadence(state, slot) {
    const a = state.ai[slot] || (state.ai[slot] = { nextAt: 0, nextDiploAt: 0 });
    a.nextAt = state.time + SIM.aiMinMs + rand() * (SIM.aiMaxMs - SIM.aiMinMs);
  },

  aiThink(state, slot) {
    const out = { events: [] };
    if (!state.active[slot] || Game.countOwned(state, slot) === 0) return out;

    Game.aiDefend(state, slot);

    const mv = Game.aiPickAttack(state, slot);
    if (mv) {
      Game.dispatch(state, slot, mv.from.id, mv.to.id, 1);
    } else {
      Game.aiMassToFront(state, slot);
    }
    return out;
  },

  /* ---------------- AI 외교 ---------------- */
  aiDiplomacy(state, ai) {
    const out = [];
    const total = state.regions.length;
    const leader = leaderOf(state);
    const two = twoFrontCount(state, ai) >= 2;
    const share = (n) => Game.countOwned(state, n) / Math.max(1, total);

    function note(text, kind) {
      if (!text) return;
      out.push({ type: 'note', text, kind: kind || 'info' });
    }
    function queued(p, text) {
      if (!p) return;
      out.push({ type: 'proposal', proposal: p, text: text || '제안이 도착했습니다' });
    }

    if (leader >= 0 && leader !== ai && share(leader) > 0.35) {
      const partners = [];
      for (let i = 0; i < NATION_COUNT; i++) {
        if (i === ai || i === leader || !state.active[i]) continue;
        if (Game.countOwned(state, i) === 0) continue;
        partners.push(i);
      }
      partners.sort((a, b) => Game.strength(state, b) - Game.strength(state, a));
      let tried = 0;
      for (const p of partners) {
        if (tried >= 2) break;
        const tr = treatyOf(state, ai, p);
        if (!tr) {
          const r = Game.proposeTruce(state, ai, p);
          if (r.status === 'accepted') note(r.text, 'good');
          else if (r.status === 'queued') { queued(r.proposal, r.text); tried++; }
        } else if (tr.type === 'truce' && relationOf(state, ai, p) >= 20) {
          const r = Game.proposeAlliance(state, ai, p);
          if (r.status === 'accepted') note(r.text, 'good');
          else if (r.status === 'queued') { queued(r.proposal, r.text); tried++; }
        }
        tried++;
      }
    }

    if (two && rand() < 0.8) {
      const threats = [];
      for (let i = 0; i < NATION_COUNT; i++) {
        if (i === ai || !state.active[i]) continue;
        if (Game.countOwned(state, i) === 0) continue;
        if (treatyOf(state, ai, i)) continue;
        if (Game.borderThreat(state, ai, i) <= 0) continue;
        threats.push(i);
      }
      threats.sort((a, b) => Game.strength(state, a) - Game.strength(state, b));
      const target = threats[0];
      if (target != null) {
        const r = Game.proposeTruce(state, ai, target);
        if (r.status === 'accepted') note(r.text, 'good');
        else if (r.status === 'queued') queued(r.proposal, r.text);
        else if (r.status === 'declined' && rand() < 0.6) {
          const t2 = Game.proposeTribute(state, ai, target, 1, 'offer');
          if (t2.status === 'accepted') note(t2.text, 'tribute');
          else if (t2.status === 'queued') queued(t2.proposal, t2.text);
        }
      }
    }

    if (rand() < 0.32) {
      const victims = [];
      for (let i = 0; i < NATION_COUNT; i++) {
        if (i === ai || !state.active[i]) continue;
        if (Game.countOwned(state, i) === 0 || treatyOf(state, ai, i)) continue;
        if (relationOf(state, ai, i) < -35) continue;
        if (Game.borderThreat(state, ai, i) <= 0 && Game.borderThreat(state, i, ai) <= 0) continue;
        if (Game.strength(state, ai) < Game.strength(state, i) * 1.35) continue;
        victims.push(i);
      }
      victims.sort((a, b) => Game.countOwned(state, a) - Game.countOwned(state, b));
      const v = victims[0];
      if (v != null) {
        const r = Game.proposeTribute(state, ai, v, 1, 'demand');
        if (r.status === 'accepted') note(r.text, 'tribute');
        else if (r.status === 'queued') queued(r.proposal, r.text);
      }
    }

    if (rand() < 0.5) {
      const allies = [];
      for (let i = 0; i < NATION_COUNT; i++) {
        if (i === ai || !state.active[i]) continue;
        const tr = treatyOf(state, ai, i);
        if (!tr || tr.type !== 'ally') continue;
        if (relationOf(state, ai, i) < 35) continue;
        allies.push(i);
      }
      allies.sort((a, b) => relationOf(state, ai, b) - relationOf(state, ai, a));
      const ally = allies[0];
      if (ally != null) {
        const enemies = [];
        for (let i = 0; i < NATION_COUNT; i++) {
          if (i === ai || i === ally || !state.active[i]) continue;
          if (Game.countOwned(state, i) === 0) continue;
          if (!atWar(state, ai, i)) continue;
          enemies.push(i);
        }
        enemies.sort((a, b) => {
          const la = a === leader ? 1 : 0, lb = b === leader ? 1 : 0;
          if (la !== lb) return lb - la;
          return Game.strength(state, b) - Game.strength(state, a);
        });
        if (enemies.length) {
          const r = Game.callToArms(state, ai, ally, enemies[0]);
          if (r.status === 'accepted') note(r.text, 'good');
          else if (r.status === 'queued') queued(r.proposal, r.text);
        }
      }
    }

    if (rand() < 0.3) {
      const humans = [];
      for (let i = 0; i < NATION_COUNT; i++) {
        if (i === ai || !state.human[i] || !state.active[i]) continue;
        if (Game.countOwned(state, i) === 0) continue;
        humans.push(i);
      }
      humans.sort((a, b) => Game.strength(state, b) - Game.strength(state, a));
      const h = humans[0];
      if (h != null) {
        const tr = treatyOf(state, ai, h);
        if (!tr) {
          const r = Game.proposeTruce(state, ai, h);
          if (r.status === 'queued') queued(r.proposal, r.text);
        } else if (tr.type === 'truce' && relationOf(state, ai, h) >= 30 && rand() < 0.5) {
          const r = Game.proposeAlliance(state, ai, h);
          if (r.status === 'queued') queued(r.proposal, r.text);
          else if (r.status === 'accepted') note(r.text, 'good');
        }
      }
    }

    return out;
  }
};

/* =============================================================================
   실시간 시뮬레이션 스텝
   ============================================================================= */

const Sim = {
  step(state, dt) {
    const events = [];
    if (!state || state.over || dt <= 0) return { events, over: state ? state.over : null };
    state.time += dt;

    Game.tickProduction(state, dt);

    if (state.marches.length) {
      const due = [];
      const rest = [];
      for (const m of state.marches) {
        if (m.arriveAt <= state.time) due.push(m); else rest.push(m);
      }
      if (due.length) {
        state.marches = rest;
        due.sort((a, b) => a.arriveAt - b.arriveAt);
        for (const m of due) {
          const res = Game.resolveMarch(state, m);
          if (res && !res.silent) events.push(res);
          if (Game.checkOver(state)) break;
        }
      }
    }

    const dipEvents = Game.tickDiplomacy(state, dt);
    for (const e of dipEvents) if (!e.silent) events.push(e);

    if (!state.over) {
      for (let slot = 0; slot < NATION_COUNT; slot++) {
        if (!state.active[slot] || state.human[slot]) continue;
        if (Game.countOwned(state, slot) === 0) continue;
        const aiState = state.ai[slot] || (state.ai[slot] = { nextAt: 0, nextDiploAt: 0 });
        if (state.time >= aiState.nextAt) {
          Game.aiThink(state, slot);
          Game.nudgeAiCadence(state, slot);
        }
        if (state.over) break;
        if (state.time >= aiState.nextDiploAt) {
          aiState.nextDiploAt = state.time + SIM.aiDiploMinMs +
            rand() * (SIM.aiDiploMaxMs - SIM.aiDiploMinMs);
          const dip = Game.aiDiplomacy(state, slot);
          for (const item of dip) {
            if (!item) continue;
            if (item.type === 'note') {
              events.push({ kind: item.kind || 'info', text: item.text });
            } else if (item.type === 'proposal' && item.proposal) {
              events.push({
                kind: 'warn',
                text: nationName(state, slot) + ' 님이 ' + (item.text || '제안을 보냈습니다'),
                toSlot: item.proposal.to,
                silent: false
              });
            }
          }
          if (Game.checkOver(state)) break;
        }
      }
    }

    const over = Game.checkOver(state);
    return { events, over };
  }
};

function treatyLabel(tr) {
  if (!tr) return '조약';
  if (tr.type === 'ally') return '동맹';
  if (tr.type === 'tribute') return '조공 조약';
  return '불가침 조약';
}

/* =============================================================================
   3. 방 · 플레이어 · 실시간 진행
   ============================================================================= */

const rooms = new Map();
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';

function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  return 'W' + Date.now().toString(36).slice(-3).toUpperCase();
}

function makeToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  s = s.replace(/\s+/g, ' ').slice(0, 12);
  return s;
}

function newPlayer(slot, name, ws, isAI, controlSlot) {
  return {
    slot,
    controlSlot: controlSlot == null ? slot : controlSlot,
    name,
    token: makeToken(),
    ws: ws || null,
    connected: !!ws,
    isAI: !!isAI,
    abandoned: false,
    autoAI: false,
    lastDispatch: 0,
    disconnectedAt: null,
    dropTimer: null
  };
}

function createRoom(ws, name, aiFill, sim) {
  const code = makeRoomCode();
  const room = {
    code,
    hostSlot: 0,
    players: [newPlayer(0, name, ws, false, sim ? -1 : 0)],
    started: false,
    sim: !!sim,
    aiFill: aiFill !== false,
    speed: sim ? 2 : 1,
    game: null,
    lastStep: 0,
    lastBroadcast: 0,
    lastDiploSent: -1,
    lastLogSent: -1,
    lastAt: Date.now(),
    createdAt: Date.now(),
    finishedAt: null,
    logRev: 1,
    log: [],
    closed: false
  };
  rooms.set(code, room);
  bind(ws, room, room.players[0]);
  return { room, player: room.players[0] };
}

function joinRoom(ws, codeRaw, name) {
  const code = String(codeRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const room = rooms.get(code);
  if (!room) return { error: ['NO_ROOM', '그런 방이 없어요. 코드를 확인해 주세요.'] };
  if (room.sim) return { error: ['SIM_ROOM', 'AI 시뮬레이션 방에는 난입할 수 없어요.'] };
  if (room.started) return { error: ['ROOM_STARTED', '이미 시작된 방이에요.'] };
  if (room.players.filter((p) => !p.isAI).length >= MAX_PLAYERS) {
    return { error: ['ROOM_FULL', '방이 가득 찼어요 (4명).'] };
  }
  let slot = 0;
  const used = new Set(room.players.map((p) => p.slot));
  while (used.has(slot)) slot++;
  const player = newPlayer(slot, name, ws, false, slot);
  room.players.push(player);
  room.lastAt = Date.now();
  bind(ws, room, player);
  addLog(room, name + ' 님이 입장했습니다', 'info');
  return { room, player };
}

function findPlayer(room, slot) {
  return room.players.find((p) => p.slot === slot) || null;
}

function controlOf(room, player) {
  return player && player.controlSlot != null ? player.controlSlot : -1;
}

function bind(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    try { player.ws.close(4001, '다른 곳에서 접속'); } catch (e) { /* noop */ }
  }
  ws.room = room;
  ws.player = player;
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;
  if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
  if (room.game && !room.game.over) {
    const ctl = controlOf(room, player);
    if (ctl >= 0 && player.autoAI) {
      player.autoAI = false;
      room.game.human[ctl] = true;
      broadcastEvent(room, player.name + ' 님이 다시 조종합니다', 'good');
    }
  }
  room.lastAt = Date.now();
}

function addLog(room, text, kind) {
  room.log.push({ at: Date.now(), text, kind: kind || 'info' });
  if (room.log.length > 40) room.log.splice(0, room.log.length - 40);
  room.logRev++;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ }
}

function notify(ws, text, kind) {
  send(ws, { type: 'event', text: polishKo(text), kind: kind || 'info', at: Date.now() });
}

function playerName(room, slot) {
  if (slot < 0) return NEUTRAL_NAME;
  const p = findPlayer(room, slot);
  return p ? p.name : NATIONS[slot] ? NATIONS[slot].name : '?';
}

function nationLabel(room, slot) {
  if (slot < 0) return NEUTRAL_NAME;
  const st = room.game;
  if (st && st.names && st.names[slot]) return st.names[slot];
  return playerName(room, slot);
}

function playerView(room) {
  return room.players.map((p) => ({
    slot: p.slot,
    control: controlOf(room, p),
    name: p.name,
    connected: p.connected,
    isAI: p.isAI,
    autoAI: !!p.autoAI,
    host: p.slot === room.hostSlot
  }));
}

function treatyView(st) {
  return Object.keys(st.treaties).map((k) => {
    const t = st.treaties[k];
    return {
      a: t.a, b: t.b, type: t.type,
      left: Math.max(0, Math.round(t.until - st.time)),
      payer: t.payer == null ? null : t.payer,
      payee: t.payee == null ? null : t.payee,
      amount: t.amount == null ? null : t.amount
    };
  });
}

function proposalView(st) {
  return st.proposals.map((p) => ({
    id: p.id, from: p.from, to: p.to, kind: p.kind || 'truce', sec: p.sec,
    age: Math.max(0, Math.round(st.time - p.at)),
    amount: p.amount == null ? null : p.amount,
    direction: p.direction || null,
    regionId: p.regionId == null ? null : p.regionId,
    regionName: p.regionName || null,
    target: p.target == null ? null : p.target,
    targetName: p.targetName || null,
    withTruce: !!p.withTruce
  }));
}

function relationView(st) {
  return Object.keys(st.relations).map((k) => {
    const parts = k.split('-');
    return { a: Number(parts[0]), b: Number(parts[1]), value: st.relations[k] };
  });
}

function callView(st) {
  return (st.calls || []).map((c) => ({
    id: c.id, from: c.from, to: c.to, target: c.target,
    left: Math.max(0, Math.round(c.until - st.time))
  }));
}

function marchView(st) {
  return st.marches.map((m) => ({
    id: m.id, owner: m.owner, from: m.from, to: m.to, n: m.troops,
    left: Math.max(0, Math.round(m.arriveAt - st.time)), dur: m.dur
  }));
}

function leaderView(st) {
  const slot = leaderOf(st);
  if (slot < 0) return null;
  return { slot, share: Math.round((Game.countOwned(st, slot) / st.regions.length) * 100) };
}

function armyView(st) {
  const out = [];
  for (let i = 0; i < NATION_COUNT; i++) {
    out.push({
      slot: i,
      land: Game.countOwned(st, i),
      troops: Game.totalTroops(st, i),
      prod: Game.productionRateOf(st, i),
      rep: reputationOf(st, i)
    });
  }
  return out;
}

function fullState(room, slot) {
  const st = room.game;
  const delegate = slot >= 0 && !st.human[slot];
  return {
    type: 'state',
    code: room.code,
    host: room.hostSlot,
    started: true,
    sim: !!room.sim,
    aiFill: room.aiFill,
    speed: room.speed || 1,
    you: slot,
    delegate,
    time: Math.round(st.time),
    over: st.over,
    names: st.names,
    active: st.active,
    human: st.human,
    activeCount: st.activeCount,
    capitals: st.capitals,
    regions: st.regions.map((r) => ({
      id: r.id,
      name: r.name,
      poly: r.poly,
      cx: r.cx,
      cy: r.cy,
      r: r.r,
      neighbors: r.neighbors,
      owner: r.owner,
      troops: r.troops,
      p: Math.round(r.p * 100) / 100,
      cap: r.owner >= 0 && st.capitals[r.owner] === r.id
    })),
    marches: marchView(st),
    treaties: treatyView(st),
    proposals: proposalView(st),
    relations: relationView(st),
    reputation: st.reputation,
    calls: callView(st),
    diploLog: (st.diploLog || []).slice(-20),
    logRev: st.logRev || 0,
    army: armyView(st),
    leader: leaderView(st),
    players: playerView(room),
    stats: st.stats,
    log: room.log.slice(-24),
    roomLogRev: room.logRev,
    serverTime: Date.now()
  };
}

function tickState(room, slot) {
  const st = room.game;
  const out = {
    type: 'tick',
    you: slot,
    delegate: slot >= 0 && !st.human[slot],
    sim: !!room.sim,
    time: Math.round(st.time),
    over: st.over,
    speed: room.speed || 1,
    regions: st.regions.map((r) => [r.owner, r.troops]),
    marches: marchView(st),
    treaties: treatyView(st),
    proposals: proposalView(st),
    relations: relationView(st),
    reputation: st.reputation,
    calls: callView(st),
    army: armyView(st),
    leader: leaderView(st),
    players: playerView(room),
    stats: st.stats,
    logRev: st.logRev || 0,
    serverTime: Date.now()
  };
  if (room.lastDiploSent !== st.logRev) {
    room.lastDiploSent = st.logRev;
    out.diploLog = (st.diploLog || []).slice(-12);
  }
  if (room.lastLogSent !== room.logRev) {
    room.lastLogSent = room.logRev;
    out.log = room.log.slice(-20);
  }
  return out;
}

function broadcastState(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p.ws || p.isAI || !p.connected) continue;
    send(p.ws, fullState(room, controlOf(room, p)));
  }
}

function broadcastTick(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p.ws || p.isAI || !p.connected) continue;
    send(p.ws, tickState(room, controlOf(room, p)));
  }
}

function broadcastEvent(room, text, kind, extra) {
  const clean = polishKo(text);
  addLog(room, clean, kind);
  const payload = Object.assign({ type: 'event', text: clean, kind: kind || 'info', at: Date.now() }, extra || {});
  for (const p of room.players) {
    if (!p.ws || p.isAI || !p.connected) continue;
    send(p.ws, payload);
  }
}

function lobbyPayload(room, slot) {
  return {
    type: 'lobby',
    code: room.code,
    host: room.hostSlot,
    started: room.started,
    sim: !!room.sim,
    aiFill: room.aiFill,
    speed: room.speed || 1,
    you: slot,
    players: playerView(room)
  };
}

function broadcastLobby(room) {
  for (const p of room.players) {
    if (!p.ws || p.isAI || !p.connected) continue;
    send(p.ws, lobbyPayload(room, controlOf(room, p)));
  }
}

function resetGameMeta(room) {
  room.log = [];
  room.logRev++;
  room.lastDiploSent = -1;
  room.lastLogSent = -1;
  room.lastStep = Date.now();
  room.lastBroadcast = 0;
  room.finishedAt = null;
}

function startGame(room, bySlot) {
  if (room.started) return { error: ['ALREADY', '이미 시작했어요.'] };
  if (bySlot !== room.hostSlot) return { error: ['HOST_ONLY', '방장만 시작할 수 있어요.'] };
  const humans = room.players.filter((p) => !p.isAI).length;
  if (humans < 1) return { error: ['NO_PLAYER', '플레이어가 없어요.'] };
  if (humans === 1 && !room.aiFill) {
    return { error: ['NEED_OPPONENT', '혼자서는 AI 채우기를 켜거나 친구를 기다려 주세요.'] };
  }

  const hostPlayer = findPlayer(room, room.hostSlot);
  room.players = room.players.filter((p) => !p.isAI);
  room.players.sort((a, b) => a.slot - b.slot);
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].slot = i;
    room.players[i].controlSlot = i;
  }
  room.hostSlot = hostPlayer ? hostPlayer.slot : 0;

  room.game = Game.newGame({ humans, aiFill: room.aiFill });
  room.game.names = NATIONS.map((n) => n.name);
  for (const p of room.players) room.game.names[p.slot] = p.name;
  resetGameMeta(room);
  room.started = true;
  addLog(room, '실시간 전쟁 시작 · ' + humans + '명 참전' + (room.aiFill ? ' (빈 자리 AI)' : ''), 'good');
  broadcastLobby(room);
  broadcastState(room);
  for (const p of room.players) {
    if (p.ws && !p.isAI) send(p.ws, { type: 'started', sim: false });
  }
  return { ok: true };
}

/** AI 4개국 난전 — 관전으로 시작하고, 언제든 한 나라를 골라 난입할 수 있다 */
function startSim(room) {
  if (!room.players.length) return { error: ['NO_PLAYER', '플레이어가 없어요.'] };
  room.game = Game.newGame({ humans: 1, aiFill: true });
  room.game.human = [false, false, false, false];
  room.game.names = NATIONS.map((n) => n.name);
  room.game.ai = [
    { nextAt: 1200, nextDiploAt: 6000 },
    { nextAt: 1800, nextDiploAt: 8000 },
    { nextAt: 2400, nextDiploAt: 7000 },
    { nextAt: 3000, nextDiploAt: 9000 }
  ];
  for (const p of room.players) p.controlSlot = -1;
  resetGameMeta(room);
  room.sim = true;
  room.started = true;
  room.speed = room.speed || 2;
  addLog(room, 'AI 시뮬레이션 시작 · 4개국 난전 · 관전 중', 'good');
  broadcastState(room);
  for (const p of room.players) {
    if (p.ws && !p.isAI) send(p.ws, { type: 'started', sim: true });
  }
  return { ok: true };
}

/* ---------------- 전역 실시간 루프 ---------------- */

function stepRoom(room) {
  const st = room.game;
  if (!st || room.closed) return;
  const now = Date.now();
  if (!room.lastStep) { room.lastStep = now; return; }
  const real = clampNum(now - room.lastStep, 0, 700);
  room.lastStep = now;
  if (st.over) return;

  const anyHuman = room.players.some((p) => !p.isAI && p.connected && p.ws);
  if (!anyHuman) return; // 아무도 없으면 시뮬레이션을 멈춘다

  // 오래 끊긴 조종자는 AI 가 대신 조종
  for (const p of room.players) {
    if (p.isAI || p.connected || p.autoAI) continue;
    const ctl = controlOf(room, p);
    if (ctl < 0 || !st.human[ctl]) continue;
    if (!p.disconnectedAt || now - p.disconnectedAt < AUTO_AI_MS) continue;
    p.autoAI = true;
    st.human[ctl] = false;
    broadcastEvent(room, p.name + ' 님 접속 끊김 · AI가 대신 조종합니다', 'warn');
  }

  const dt = real * (room.speed || 1);
  const out = Sim.step(st, dt);
  for (const ev of out.events) {
    if (!ev || !ev.text) continue;
    if (ev.toSlot != null) {
      const tp = room.players.find((p) => controlOf(room, p) === ev.toSlot);
      if (tp && tp.ws) notify(tp.ws, ev.text, ev.kind || 'warn');
      addLog(room, ev.text, ev.kind || 'warn');
      continue;
    }
    broadcastEvent(room, ev.text, ev.kind || 'info', {
      battle: !!ev.battle,
      at: ev.at == null ? null : ev.at,
      attacker: ev.attacker == null ? null : ev.attacker,
      defender: ev.defender == null ? null : ev.defender
    });
  }

  if (now - room.lastBroadcast >= SIM.tickMs) {
    room.lastBroadcast = now;
    broadcastTick(room);
  }

  if (st.over) finishGame(room);
}

function finishGame(room) {
  const st = room.game;
  if (!st || !st.over) return;
  room.finishedAt = Date.now();
  broadcastState(room);
  const w = st.over.winner;
  const winText = w < 0
    ? '무승부 · 모두가 사라졌습니다'
    : st.over.type === 'nation'
      ? nationLabel(room, w) + '이(가) 대륙을 통일했습니다!'
      : nationLabel(room, w) + '이(가) 마지막까지 살아남았습니다!';
  broadcastEvent(room, '게임 종료 · ' + winText, 'good', { over: st.over });
}

function validName(ws, raw) {
  const name = sanitizeName(raw);
  if (!name || name.length < 1) {
    send(ws, { type: 'error', code: 'NAME', message: '이름을 입력해 주세요.' });
    return null;
  }
  return name;
}

function actionBlocked(room, player, ctl) {
  const st = room.game;
  if (!st) { notify(player.ws, '아직 게임이 시작되지 않았어요.', 'warn'); return true; }
  if (st.over) { notify(player.ws, '게임이 끝났어요.', 'warn'); return true; }
  if (ctl < 0) {
    notify(player.ws, '관전 중이에요 · 참전할 나라를 먼저 고르세요.', 'warn');
    return true;
  }
  if (!st.human[ctl]) {
    notify(player.ws, 'AI가 대신 조종 중이에요 · 조종을 가져오면 바로 싸울 수 있어요.', 'warn');
    return true;
  }
  return false;
}

function handleAction(room, player, action) {
  const st = room.game;
  const ctl = controlOf(room, player);
  if (actionBlocked(room, player, ctl)) return;
  if (!action || typeof action !== 'object') return;
  const kind = action.kind;
  const slot = ctl;

  if (kind === 'send' || kind === 'attack' || kind === 'transfer') {
    const from = Number(action.from), to = Number(action.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    const src = st.regions[from];
    if (!src || src.owner !== slot) { notify(player.ws, '내 영토에서만 출정할 수 있어요.', 'warn'); return; }
    const now = Date.now();
    if (now - (player.lastDispatch || 0) < SIM.dispatchCooldownMs) return;
    const res = Game.dispatch(st, slot, from, to, action.ratio);
    if (!res.ok) {
      if (res.reason === 'treaty') notify(player.ws, '조약 중이에요 · 먼저 파기하세요.', 'warn');
      else if (res.reason === 'far') notify(player.ws, '인접한 영토로만 보낼 수 있어요.', 'warn');
      else if (res.reason === 'weak') notify(player.ws, '병력 2 이상인 영토에서 출정할 수 있어요.', 'warn');
      else if (res.reason === 'busy') notify(player.ws, '행군이 너무 많아요 · 잠시 후 다시', 'warn');
      else notify(player.ws, '출정할 수 없어요.', 'warn');
      return;
    }
    player.lastDispatch = now;
    if (res.attack) notify(player.ws, '출정 ' + res.troops + ' → ' + res.toName, 'move');
    else notify(player.ws, '이동 ' + res.troops + ' → ' + res.toName, 'move');
    return;
  }

  if (kind === 'respond') {
    const id = Number(action.id);
    const p = st.proposals.find((x) => x.id === id);
    if (!p) { notify(player.ws, '이미 사라진 제안이에요.', 'warn'); return; }
    if (p.to !== slot) return;
    const r = Game.resolveProposal(st, p, !!action.accept);
    broadcastEvent(room, r.text, action.accept ? 'good' : 'warn');
    broadcastTick(room);
    return;
  }

  if (kind === 'propose') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const r = Game.proposeTruce(st, slot, to);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 불가침 조약을 제안했습니다', 'good');
      const target = findPlayer(room, to);
      if (target && target.ws) notify(target.ws, nationLabel(room, slot) + ' 님이 불가침 조약을 제안했습니다', 'warn');
      broadcastTick(room);
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text || '불가침 조약 체결', 'good');
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '상대가 제안을 거절했습니다', 'bad');
    } else if (r.reason === 'already') {
      notify(player.ws, '이미 조약이 있어요. 파기하거나 동맹으로 격상하세요.', 'warn');
    } else {
      notify(player.ws, '지금은 제안할 수 없어요.', 'warn');
    }
    return;
  }

  if (kind === 'alliance') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const r = Game.proposeAlliance(st, slot, to);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 동맹을 제안했습니다', 'good');
      const target = findPlayer(room, to);
      if (target && target.ws) notify(target.ws, nationLabel(room, slot) + ' 님이 동맹을 제안했습니다', 'warn');
      broadcastTick(room);
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '동맹 제안이 거절되었습니다', 'bad');
    } else if (r.reason === 'need_truce') {
      notify(player.ws, '먼저 불가침 조약을 맺어야 동맹으로 격상할 수 있어요.', 'warn');
    } else {
      notify(player.ws, '지금은 동맹을 제안할 수 없어요.', 'warn');
    }
    return;
  }

  if (kind === 'tribute') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const r = Game.proposeTribute(st, slot, to, action.amount, action.direction);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 조공 ' +
        (action.direction === 'offer' ? '제안' : '요구') + '을 보냈습니다', 'good');
      const target = findPlayer(room, to);
      if (target && target.ws) {
        notify(target.ws, nationLabel(room, slot) + ' 님이 조공 ' +
          (action.direction === 'offer' ? '제안' : '요구') + '을 보냈습니다', 'warn');
      }
      broadcastTick(room);
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '조공 제안이 거절되었습니다', 'bad');
    } else if (r.reason === 'already') {
      notify(player.ws, '이미 조약이 있어 조공 조약을 맺을 수 없어요.', 'warn');
    } else {
      notify(player.ws, '조공을 제안할 수 없어요.', 'warn');
    }
    return;
  }

  if (kind === 'cede') {
    const to = Number(action.to);
    const regionId = Number(action.regionId);
    if (!Number.isInteger(to) || !Number.isInteger(regionId)) return;
    const r = Game.proposeCede(st, slot, to, regionId, !!action.withTruce);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 ' + (st.regions[regionId] || {}).name +
        ' 할양을 제안했습니다', 'good');
      const target = findPlayer(room, to);
      if (target && target.ws) {
        notify(target.ws, nationLabel(room, slot) + ' 님이 ' + (st.regions[regionId] || {}).name +
          ' 할양을 제안했습니다', 'warn');
      }
      broadcastTick(room);
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '할양 제안이 거절되었습니다', 'bad');
    } else if (r.reason === 'region') {
      notify(player.ws, '내 영토만 할양할 수 있어요.', 'warn');
    } else {
      notify(player.ws, '지금은 할양을 제안할 수 없어요.', 'warn');
    }
    return;
  }

  if (kind === 'call') {
    const to = Number(action.to);
    const target = Number(action.target);
    if (!Number.isInteger(to) || !Number.isInteger(target)) return;
    const r = Game.callToArms(st, slot, to, target);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 공동 참전을 요청했습니다', 'good');
      const tp = findPlayer(room, to);
      if (tp && tp.ws) {
        notify(tp.ws, nationLabel(room, slot) + ' 님이 ' + nationLabel(room, target) +
          ' 에 대한 공동 참전을 요청했습니다', 'warn');
      }
      broadcastTick(room);
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '공동 참전 요청이 거절되었습니다', 'bad');
    } else if (r.reason === 'no_ally') {
      notify(player.ws, '정식 동맹에게만 공동 참전을 요청할 수 있어요.', 'warn');
    } else if (r.reason === 'not_enemy') {
      notify(player.ws, '지금 교전 중인 나라를 목표로 지정해 주세요.', 'warn');
    } else if (r.reason === 'ally_truce') {
      notify(player.ws, '동맹이 그 나라와 휴전 중이라 함께 공격할 수 없어요.', 'warn');
    } else if (r.reason === 'dup') {
      notify(player.ws, '이미 같은 요청이 진행 중이에요.', 'warn');
    } else {
      notify(player.ws, '지금은 요청할 수 없어요.', 'warn');
    }
    return;
  }

  if (kind === 'aid') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const a = Game.sendAid(st, slot, to);
    if (!a.ok) {
      notify(player.ws, '병력 6 이상인 내 영토가 있어야 지원할 수 있어요.', 'bad');
      return;
    }
    broadcastEvent(room, a.text, 'good');
    return;
  }

  if (kind === 'break') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const b = Game.breakPact(st, slot, to);
    if (!b) { notify(player.ws, '파기할 조약이 없어요.', 'warn'); return; }
    broadcastEvent(room, nationLabel(room, slot) + '이(가) ' + nationLabel(room, to) +
      '와(과)의 조약을 파기했습니다 · 신뢰도 -35', 'bad');
    return;
  }

  if (kind === 'speed') {
    setSpeed(room, player, action.value);
    return;
  }
}

function setSpeed(room, player, value) {
  if (player.slot !== room.hostSlot) return;
  const humans = room.players.filter((p) => !p.isAI).length;
  if (room.started && humans > 1) {
    notify(player.ws, '여러 명이 함께할 때는 로비에서만 속도를 바꿀 수 있어요.', 'warn');
    return;
  }
  const v = Number(value);
  if (SIM.speeds.indexOf(v) < 0) return;
  room.speed = v;
  if (room.started) {
    broadcastEvent(room, '게임 속도 ×' + v, 'info');
    broadcastState(room);
  } else {
    broadcastLobby(room);
  }
}

/** AI 시뮬레이션에서 나라를 골라 직접 조종 / AI 위임 토글 */
function handleControl(room, player, type, msg) {
  const st = room.game;
  if (!st) { notify(player.ws, '아직 게임이 시작되지 않았어요.', 'warn'); return; }
  if (st.over) { notify(player.ws, '게임이 끝났어요.', 'warn'); return; }

  if (type === 'takeover') {
    if (!room.sim) { notify(player.ws, 'AI 시뮬레이션에서만 나라를 골라 참전할 수 있어요.', 'warn'); return; }
    const slot = Number(msg.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= NATION_COUNT) return;
    if (!st.active[slot] || Game.countOwned(st, slot) === 0) {
      notify(player.ws, '그 나라는 지금 참전할 수 없어요 (멸망 또는 미참전).', 'warn');
      return;
    }
    const prev = controlOf(room, player);
    if (prev === slot && st.human[slot]) {
      notify(player.ws, '이미 그 나라를 조종하고 있어요.', 'info');
      return;
    }
    if (prev >= 0 && prev !== slot && st.human[prev]) {
      st.human[prev] = false;
      st.names[prev] = NATIONS[prev].name;
      st.ai[prev] = { nextAt: st.time + 600, nextDiploAt: st.time + 6000 };
      broadcastEvent(room, player.name + ' 님이 ' + NATIONS[prev].name + '을(를) AI에게 맡겼습니다', 'info');
    }
    player.controlSlot = slot;
    player.autoAI = false;
    player.lastDispatch = 0;
    st.human[slot] = true;
    st.names[slot] = player.name;
    addLog(room, player.name + ' 님이 ' + NATIONS[slot].name + '에 참전했습니다', 'good');
    broadcastEvent(room, '⚔️ ' + player.name + ' 님이 ' + NATIONS[slot].name + '에 참전했습니다!', 'good');
    broadcastState(room);
    return;
  }

  if (type === 'delegate') {
    const ctl = controlOf(room, player);
    if (ctl < 0) { notify(player.ws, '참전할 나라를 먼저 고르세요.', 'warn'); return; }
    const humans = room.players.filter((p) => !p.isAI).length;
    if (humans > 1) { notify(player.ws, '여러 명이 함께할 때는 위임을 쓸 수 없어요.', 'warn'); return; }
    const on = msg.value !== false;
    if (!on && st.human[ctl]) return;
    if (on && !st.human[ctl]) return;
    st.human[ctl] = !on;
    if (on) st.ai[ctl] = { nextAt: st.time + 500, nextDiploAt: st.time + 6000 };
    broadcastEvent(room,
      on
        ? '🤖 ' + player.name + ' 님이 AI에게 조종을 맡겼습니다 · 언제든 가져올 수 있어요'
        : '🎮 ' + player.name + ' 님이 직접 조종합니다',
      'info');
    broadcastState(room);
    return;
  }

  if (type === 'spectate') {
    if (!room.sim) return;
    const prev = controlOf(room, player);
    if (prev >= 0 && st.human[prev]) {
      st.human[prev] = false;
      st.names[prev] = NATIONS[prev].name;
      st.ai[prev] = { nextAt: st.time + 600, nextDiploAt: st.time + 6000 };
    }
    player.controlSlot = -1;
    addLog(room, player.name + ' 님이 관전으로 돌아갔습니다', 'info');
    broadcastEvent(room, player.name + ' 님이 관전합니다', 'info');
    broadcastState(room);
    return;
  }
}

function leaveRoom(ws, explicit) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) return;
  const wasHost = player.slot === room.hostSlot;

  if (!room.started) {
    room.players = room.players.filter((p) => p !== player);
    addLog(room, player.name + ' 님이 나갔습니다', 'info');
  } else {
    const ctl = controlOf(room, player);
    if (ctl >= 0 && room.game && room.game.human[ctl]) room.game.human[ctl] = false;
    player.isAI = true;
    player.connected = false;
    player.abandoned = true;
    player.ws = null;
    if (room.game) {
      if (ctl >= 0) {
        room.game.human[ctl] = false;
        room.game.ai[ctl] = { nextAt: room.game.time + 800, nextDiploAt: room.game.time + 5000 };
        room.game.names[ctl] = NATIONS[ctl].name;
      }
      addLog(room, player.name + ' 님이 나갔습니다 · AI가 이어받습니다', 'warn');
    }
  }

  if (room.players.length === 0) {
    room.players = [];
  } else {
    if (wasHost) {
      const next = room.players.find((p) => !p.isAI);
      if (next) room.hostSlot = next.slot;
    }
    if (room.started) broadcastState(room);
    else broadcastLobby(room);
  }

  if (ws.room === room) {
    ws.room = null;
    ws.player = null;
  }

  const anyHuman = room.players.some((p) => !p.isAI);
  if (!anyHuman) {
    room.closed = true;
    rooms.delete(room.code);
  }
}

function handleMessage(ws, msg) {
  ws.lastAt = Date.now();
  const type = msg && msg.type;

  if (type === 'create') {
    if (ws.room) return;
    const name = validName(ws, msg.name);
    if (!name) return;
    if (rooms.size >= MAX_ROOMS) {
      send(ws, { type: 'error', code: 'BUSY', message: '지금 접속자가 많아요. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    const sim = !!msg.sim;
    const { room, player } = createRoom(ws, name, sim ? true : !!msg.aiFill, sim);
    send(ws, {
      type: 'joined',
      code: room.code,
      token: player.token,
      slot: player.slot,
      name: player.name,
      sim
    });
    if (sim) {
      startSim(room);
    } else {
      broadcastLobby(room);
    }
    return;
  }

  if (type === 'join') {
    if (ws.room) return;
    const name = validName(ws, msg.name);
    if (!name) return;
    const out = joinRoom(ws, msg.code, name);
    if (out.error) {
      send(ws, { type: 'error', code: out.error[0], message: out.error[1] });
      return;
    }
    send(ws, {
      type: 'joined',
      code: out.room.code,
      token: out.player.token,
      slot: out.player.slot,
      name: out.player.name
    });
    broadcastLobby(out.room);
    return;
  }

  if (type === 'resume') {
    if (ws.room) return;
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const token = String(msg.token || '');
    const room = rooms.get(code);
    const player = room && room.players.find((p) => p.token === token && !p.abandoned);
    if (!room || !player) {
      send(ws, { type: 'resume_failed', message: '방을 찾을 수 없어요. 이미 끝났거나 닫힌 방이에요.' });
      return;
    }
    bind(ws, room, player);
    send(ws, {
      type: 'resumed',
      code: room.code,
      token: player.token,
      slot: player.slot,
      name: player.name,
      sim: !!room.sim
    });
    addLog(room, player.name + ' 님이 다시 접속했습니다', 'info');
    if (room.started) {
      broadcastState(room);
      broadcastEvent(room, player.name + ' 님이 다시 접속했습니다', 'info');
    } else {
      broadcastLobby(room);
    }
    return;
  }

  const room = ws.room;
  const player = ws.player;
  if (!room || !player) {
    send(ws, { type: 'error', code: 'NO_ROOM', message: '먼저 방을 만들거나 참가해 주세요.' });
    return;
  }
  room.lastAt = Date.now();

  if (type === 'aiFill') {
    if (player.slot !== room.hostSlot || room.started) return;
    room.aiFill = !!msg.value;
    broadcastLobby(room);
    return;
  }

  if (type === 'start') {
    const out = startGame(room, player.slot);
    if (out.error) send(ws, { type: 'error', code: out.error[0], message: out.error[1] });
    return;
  }

  if (type === 'sim') {
    if (player.slot !== room.hostSlot || room.started) return;
    startSim(room);
    return;
  }

  if (type === 'takeover' || type === 'delegate' || type === 'spectate') {
    if (!room.started) return;
    handleControl(room, player, type, msg);
    return;
  }

  if (type === 'action') {
    if (!room.started) {
      send(ws, { type: 'error', code: 'NOT_STARTED', message: '아직 시작하지 않았어요.' });
      return;
    }
    handleAction(room, player, msg.action);
    return;
  }

  if (type === 'speed') {
    setSpeed(room, player, msg.value);
    return;
  }

  if (type === 'rematch') {
    if (player.slot !== room.hostSlot) {
      notify(ws, '방장만 다시 시작할 수 있어요.', 'warn');
      return;
    }
    if (!room.game || !room.game.over) return;
    room.started = false;
    room.game = null;
    room.lastStep = 0;
    if (room.sim) {
      startSim(room);
      return;
    }
    room.players = room.players.filter((p) => !p.isAI);
    for (const p of room.players) { p.connected = !!p.ws; p.autoAI = false; p.controlSlot = p.slot; }
    room.hostSlot = room.players[0] ? room.players[0].slot : 0;
    addLog(room, '새 게임을 준비합니다', 'info');
    broadcastLobby(room);
    return;
  }

  if (type === 'leave') {
    leaveRoom(ws, true);
    send(ws, { type: 'left' });
    return;
  }

  if (type === 'ping') {
    send(ws, { type: 'pong', at: Date.now() });
  }
}

function handleDisconnect(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) return;
  if (player.ws && player.ws !== ws) return;
  player.connected = false;
  player.ws = null;
  player.disconnectedAt = Date.now();
  if (!room.started) {
    if (player.dropTimer) clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      player.dropTimer = null;
      if (player.connected || player.ws) return;
      if (room.started) return;
      room.players = room.players.filter((p) => p !== player);
      addLog(room, player.name + ' 님이 나갔습니다', 'info');
      if (room.hostSlot === player.slot) {
        const next = room.players.find((p) => !p.isAI);
        if (next) room.hostSlot = next.slot;
      }
      if (!room.players.length) {
        room.closed = true;
        rooms.delete(room.code);
        return;
      }
      broadcastLobby(room);
    }, 45000);
  } else {
    addLog(room, player.name + ' 님의 접속이 끊겼습니다', 'warn');
    broadcastEvent(room, player.name + ' 님 접속 끊김 · ' + Math.round(AUTO_AI_MS / 1000) +
      '초 뒤 AI가 대신 조종합니다', 'warn');
  }
}

/* =============================================================================
   4. WebSocket · HTTP 서버
   ============================================================================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    let live = 0;
    for (const room of rooms.values()) if (room.game && !room.game.over) live++;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, live, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const rel = pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('찾을 수 없는 페이지입니다.');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(data);
  });
}

function createServer() {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_MAX_PAYLOAD });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.lastAt = Date.now();
    ws.bucket = { count: 0, reset: Date.now() + 10000 };

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* noop */ });

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now > ws.bucket.reset) {
        ws.bucket = { count: 0, reset: now + 10000 };
      }
      ws.bucket.count++;
      if (ws.bucket.count > 80) {
        try { ws.close(4008, 'too many messages'); } catch (e) { /* noop */ }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (e) {
        send(ws, { type: 'error', code: 'BAD_JSON', message: '잘못된 메시지 형식이에요.' });
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || msg.type.length > 20) {
        send(ws, { type: 'error', code: 'BAD_MSG', message: '잘못된 메시지예요.' });
        return;
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        console.error('[message]', err);
        send(ws, { type: 'error', code: 'SERVER', message: '서버에서 문제가 생겼어요.' });
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });
  });

  // 실시간 시뮬레이션: 방 전체를 한 타이머로 돌린다
  const simulation = setInterval(() => {
    for (const room of Array.from(rooms.values())) {
      if (!room.game || room.closed) continue;
      try {
        stepRoom(room);
      } catch (err) {
        console.error('[sim]', err);
      }
    }
  }, SIM.stepMs);
  simulation.unref();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) { /* noop */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* noop */ }
    }
  }, 30000);
  heartbeat.unref();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyConnected = room.players.some((p) => p.connected && p.ws);
      const idle = now - room.lastAt;
      if (!anyConnected && idle > ROOM_IDLE_MS) {
        room.closed = true;
        rooms.delete(code);
        continue;
      }
      if (now - room.createdAt > ROOM_MAX_AGE_MS) {
        room.closed = true;
        rooms.delete(code);
      }
    }
  }, 60000);
  cleanup.unref();

  wss.on('close', () => {
    clearInterval(simulation);
    clearInterval(heartbeat);
    clearInterval(cleanup);
  });

  return { server, wss };
}

function start() {
  const { server } = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('영토 전쟁 ONLINE · 실시간 · http://localhost:' + PORT + '  (WebSocket /ws)');
  });
  const shutdown = () => {
    console.log('서버를 종료합니다…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  Game,
  Sim,
  NATIONS,
  SIM,
  DUR,
  TUNING: SIM,
  rooms,
  createServer,
  createRoom,
  joinRoom,
  startGame,
  startSim,
  setSpeed,
  handleControl,
  controlOf,
  handleMessage,
  handleAction,
  stepRoom,
  fullState,
  tickState,
  publicState: fullState,
  sanitizeName
};

if (require.main === module) start();

