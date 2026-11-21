'use strict';

/* =============================================================================
   영토 전쟁 ONLINE · 웹소켓 멀티플레이 서버
   - 의존성: ws (WebSocket) 만 사용
   - 같은 포트에서 public/index.html (HTTP) 과 /ws (WebSocket) 를 함께 서비스
   - 게임 상태·주사위·외교·AI 턴은 모두 서버가 권위를 가진다 (클라이언트는 표시만)
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
const TURN_GRACE_MS = 75 * 1000;          // 접속이 끊긴 플레이어의 턴을 자동 종료하는 시간
const MAX_ROOMS = 800;
const MAX_PLAYERS = NATION_COUNT;
const WS_MAX_PAYLOAD = 16 * 1024;

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
   2. 게임 규칙 (DOM 과 무관 · 서버 권위)
   ============================================================================= */

const TUNING = {
  aiAttacksBase: 4,
  aiAttacksPerOwned: 0.55,
  aiAttacksMax: 11,
  playerBias: 0,
  neutralBonus: 1.7,
  reinforceDiv: 2,
  minReinforce: 3,
  treatyTurns: 4,      // 불가침 조약 지속 턴
  allyTurns: 5,        // 동맹 지속 턴
  callTurns: 2,        // 공동 참전 요청 지속 턴
  tributeTurns: 4,     // 조공 조약 지속 턴
  aidAmount: 3,        // 병력 지원량
  aidThreshold: 5,     // 지원을 뽑아낼 영토의 최소 병력
  grudgeTurns: 6,      // 조약 파기 후 원한 지속 턴
  aidRelation: 15,     // 병력 지원 시 관계 상승
  aidReputation: 3,
  betrayReputation: 35,
  betrayRelation: 55,
  combatRelation: 4,
  allianceRelation: 10,
  cedeRelation: 25,
  repStart: 60
};

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
  return typeof v === 'number' ? v : TUNING.repStart;
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
    if (c.to === ai && c.turns > 0) set.add(c.target);
  }
  if (state.grudge && state.grudge[ai]) set.add(state.grudge[ai].at);
  return set;
}

function activeCallFor(state, ai) {
  if (!state.calls) return null;
  return state.calls.find((c) => c.to === ai && c.turns > 0) || null;
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
      troops: 1
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
  TUNING,

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
      turn: 1,
      cur: 0,
      phase: 'player',
      reinforcements: 0,
      over: null,
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
      stats: { battles: 0, captures: 0 }
    };
    for (let i = 0; i < NATION_COUNT; i++) {
      if (!active[i]) continue;
      state.reputation[i] = TUNING.repStart;
      for (let j = i + 1; j < NATION_COUNT; j++) {
        if (!active[j]) continue;
        state.relations[tkey(i, j)] = 0;
      }
    }
    Game.startTurn(state, 0);
    Game.checkOver(state);
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

  reinforceCount(state, owner) {
    return Math.max(TUNING.minReinforce, Math.floor(Game.countOwned(state, owner) / TUNING.reinforceDiv));
  },

  startTurn(state, who) {
    state.cur = who;
    if (state.human[who]) {
      state.phase = 'player';
      state.reinforcements = Game.reinforceCount(state, who);
    } else {
      state.phase = 'ai';
      state.reinforcements = 0;
    }
  },

  deploy(state, idx, amount) {
    const r = state.regions[idx];
    if (!r) return 0;
    if (r.owner !== state.cur) return 0;
    if (state.phase !== 'player' || state.reinforcements <= 0) return 0;
    const n = Math.min(amount, state.reinforcements);
    if (n <= 0) return 0;
    r.troops += n;
    state.reinforcements -= n;
    return n;
  },

  transfer(state, fromIdx, toIdx) {
    const from = state.regions[fromIdx], to = state.regions[toIdx];
    if (!from || !to) return 0;
    if (from.owner !== to.owner) return 0;
    if (!from.neighbors.includes(toIdx)) return 0;
    if (from.troops < 2) return 0;
    const n = from.troops - 1;
    from.troops = 1;
    to.troops += n;
    return n;
  },

  attack(state, fromIdx, toIdx) {
    const from = state.regions[fromIdx], to = state.regions[toIdx];
    if (!from || !to) return { ok: false, reason: 'missing' };
    if (!from.neighbors.includes(toIdx)) return { ok: false, reason: 'far' };
    if (from.owner === to.owner) return { ok: false, reason: 'friend' };
    if (to.owner >= 0) {
      const pact = treatyOf(state, from.owner, to.owner);
      if (pact) return { ok: false, reason: 'treaty', treaty: pact };
    }
    if (from.troops < 2 || to.troops < 1) return { ok: false, reason: 'weak' };

    const targetOwner = to.owner;
    const targetName = to.name;
    const aDice = Math.min(3, from.troops - 1);
    const dDice = Math.min(2, to.troops);
    const ar = [], dr = [];
    for (let i = 0; i < aDice; i++) ar.push(1 + Math.floor(rand() * 6));
    for (let i = 0; i < dDice; i++) dr.push(1 + Math.floor(rand() * 6));
    ar.sort((a, b) => b - a);
    dr.sort((a, b) => b - a);

    // 동맹 보너스: 공동의 적과 싸울 때 가장 높은 공격 주사위 +1
    const allyBonus = hasAllyAgainst(state, from.owner, targetOwner);
    if (allyBonus) ar[0] = Math.min(6, ar[0] + 1);

    let aLoss = 0, dLoss = 0;
    const pairs = Math.min(aDice, dDice);
    for (let i = 0; i < pairs; i++) {
      if (ar[i] > dr[i]) dLoss++; else aLoss++;
    }
    aLoss = Math.min(aLoss, from.troops - 1);
    dLoss = Math.min(dLoss, to.troops);

    from.troops -= aLoss;
    to.troops -= dLoss;

    let captured = false, moved = 0;
    if (to.troops <= 0) {
      if (from.troops >= 2) {
        moved = Math.max(1, Math.min(from.troops - 1, aDice));
        from.troops -= moved;
        to.troops = moved;
        to.owner = from.owner;
        captured = true;
      } else {
        to.troops = 1;
      }
    }

    state.stats.battles++;
    if (captured) state.stats.captures++;

    if (targetOwner >= 0) {
      addRelation(state, from.owner, targetOwner, captured ? -12 : -6);
      if (allyBonus) {
        for (let al = 0; al < NATION_COUNT; al++) {
          if (al === from.owner || !state.active[al]) continue;
          const at = treatyOf(state, from.owner, al);
          if (at && at.type === 'ally' && relationOf(state, from.owner, al) >= 25 && atWar(state, al, targetOwner)) {
            addRelation(state, from.owner, al, TUNING.combatRelation);
          }
        }
      }
    }

    return {
      ok: true,
      aLoss,
      dLoss,
      captured,
      moved,
      allyBonus,
      fromOwner: from.owner,
      targetOwner,
      fromName: from.name,
      toName: targetName,
      ar,
      dr
    };
  },

  /* ---------------- AI: 전선 배치 · 후방 이동 · 공격 판단 ---------------- */

  aiReinforce(state, ai) {
    const own = state.regions.filter((r) => r.owner === ai);
    if (!own.length) return 0;
    const borders = own.filter((r) => r.neighbors.some((nb) => state.regions[nb].owner !== ai));
    const pool = borders.length ? borders : own;
    const scored = pool
      .map((r) => ({ r, score: Game.frontlineScore(state, ai, r) }))
      .sort((a, b) => b.score - a.score);
    let n = Math.max(TUNING.minReinforce, Math.floor(own.length / TUNING.reinforceDiv));
    const total = n;
    const top = scored[0];
    if (!top) return 0;
    // 70% 는 가장 급한 전선, 나머지는 두 번째 전선 (안전한 내부 영토에는 절대 넣지 않는다)
    const first = scored[1] && n >= 3 ? Math.ceil(n * 0.7) : n;
    top.r.troops += first;
    n -= first;
    if (n > 0 && scored[1]) scored[1].r.troops += n;
    return total;
  },

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
      if (t.owner === -1 && state.turn <= 8) bonus += 1.0;
      if (t.troops <= 1 && t.owner >= 0) bonus += 0.8;
    }
    if (grudge) bonus += 1.2;
    return threat * 1.35 + opportunity + bonus;
  },

  aiShiftTroops(state, ai) {
    const own = state.regions.filter((r) => r.owner === ai);
    if (own.length < 2) return 0;
    // 전선(적과 맞닿은 영토)에서의 거리
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
    let moved = 0;
    for (let pass = 0; pass < 3; pass++) {
      // 내부의 남는 병력을 전선 쪽으로
      const rear = own
        .filter((r) => dist[r.id] > 0 && r.troops >= 3)
        .sort((a, b) => dist[b.id] - dist[a.id]);
      for (const r of rear) {
        if (r.troops < 3) continue;
        let best = null, bestScore = -1e9;
        for (const nb of r.neighbors) {
          const t = state.regions[nb];
          if (t.owner !== ai) continue;
          if (dist[t.id] == null || dist[t.id] >= dist[r.id]) continue;
          const sc = -dist[t.id] * 2 + Game.frontlineScore(state, ai, t) * 0.25 + rand();
          if (sc > bestScore) { bestScore = sc; best = t; }
        }
        if (!best) continue;
        const n = r.troops - 1;
        r.troops = 1;
        best.troops += n;
        moved += n;
      }
      // 안전한 전선에 쌓인 병력을 위협 전선으로
      for (const r of own) {
        if (dist[r.id] !== 0 || r.troops < 4) continue;
        let threat = 0;
        for (const nb of r.neighbors) {
          const t = state.regions[nb];
          if (t.owner !== ai && !(t.owner >= 0 && treatyOf(state, ai, t.owner))) threat += t.troops;
        }
        if (threat > 1) continue;
        let best = null, bestT = 0;
        for (const nb of r.neighbors) {
          const t = state.regions[nb];
          if (t.owner !== ai) continue;
          let th = 0;
          for (const nn of t.neighbors) {
            const e = state.regions[nn];
            if (e.owner !== ai && !(e.owner >= 0 && treatyOf(state, ai, e.owner))) th += e.troops;
          }
          if (th > bestT) { bestT = th; best = t; }
        }
        if (!best || bestT <= threat) continue;
        const n = Math.min(3, r.troops - 1);
        r.troops -= n;
        best.troops += n;
        moved += n;
      }
    }
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
        const need = t.owner === -1 ? 1 : 2; // 적국은 +2, 약한 중립은 +1 우위일 때만
        if (diff < need) continue;
        if (t.owner >= 0 && t.troops >= 4 && diff < 3) continue;

        let score = diff * 1.15;
        if (t.owner === -1) score += state.turn <= 8 ? 2.4 : 0.6;
        if (t.troops <= 1 && t.owner >= 0) score += 2.0;
        if (leader >= 0 && t.owner === leader) score += 1.6;
        if (callTargets.has(t.owner)) score += 5.0;
        if (grudge && grudge.at === t.owner) score += 2.2;
        if (state.human[t.owner]) score += 0.3;

        // 과확장 방지: 점령 직후 1개만 남는데 큰 적 부대에 둘러싸이면 감점
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

  aiAttackBudget(state, ai) {
    const n = Game.countOwned(state, ai);
    let b = Math.round(TUNING.aiAttacksBase + n * TUNING.aiAttacksPerOwned);
    if (activeCallFor(state, ai)) b += 2;
    const leader = leaderOf(state);
    if (leader >= 0 && leader !== ai) b += 1;
    return Math.round(clampNum(b, TUNING.aiAttacksBase, 13));
  },

  checkOver(state) {
    if (state.over) return state.over;
    const total = state.regions.length;
    for (let i = 0; i < NATION_COUNT; i++) {
      if (state.active[i] && Game.countOwned(state, i) === total) {
        state.over = { type: 'nation', winner: i };
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
    // 참전국이 하나만 남았고, 실제로 누군가 탈락한 뒤라면 마지막 생존국 승리
    if (alive === 1 && state.everEliminated) {
      state.over = { type: 'lastStanding', winner: last };
    }
    return state.over;
  },

  /* ---------------- 외교: 조약 · 제안 · 평판 ---------------- */

  createTreaty(state, a, b, type, turns, extra) {
    const k = tkey(a, b);
    const prev = state.treaties[k];
    const tr = {
      a: Math.min(a, b),
      b: Math.max(a, b),
      type: type || 'truce',
      turns: Math.max(1, turns || TUNING.treatyTurns),
      since: prev ? prev.since : state.turn
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
    if (to >= 0) state.grudge[to] = { at: from, turns: TUNING.grudgeTurns };
    addRelation(state, from, to, -TUNING.betrayRelation);
    addReputation(state, from, -TUNING.betrayReputation);
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
      '와(과)의 ' + treatyLabel(tr) + '을(를) 파기했습니다 · 신뢰도 -' + TUNING.betrayReputation,
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
    // 받는 쪽: 지불국과 맞닿은 영토 우선, 없으면 가장 약한 영토
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

  tickTreaties(state) {
    const expired = [];
    const tributes = [];
    const broke = [];
    for (const k of Object.keys(state.treaties)) {
      const tr = state.treaties[k];
      if (!tr) continue;
      if (tr.type === 'tribute') {
        const paid = Game.payTribute(state, tr);
        if (paid.ok) {
          tributes.push(paid);
          diploNote(state, nationName(state, tr.payer) + ' → ' + nationName(state, tr.payee) +
            ' 조공 ' + paid.amount + ' (' + paid.region + ')', 'tribute', [tr.payer, tr.payee]);
        } else {
          broke.push({ a: tr.a, b: tr.b, type: 'tribute' });
          delete state.treaties[k];
          addReputation(state, tr.payer, -10);
          addRelation(state, tr.payer, tr.payee, -15);
          diploNote(state, nationName(state, tr.payer) + '이(가) 조공을 이행하지 못해 조약이 깨졌습니다',
            'bad', [tr.payer, tr.payee]);
          continue;
        }
      }
      tr.turns--;
      if (tr.turns <= 0) {
        expired.push({ a: tr.a, b: tr.b, type: tr.type });
        delete state.treaties[k];
      }
    }

    for (const c of state.calls.slice()) {
      c.turns--;
      if (c.turns <= 0) {
        state.calls = state.calls.filter((x) => x !== c);
      }
    }

    for (const k of Object.keys(state.grudge)) {
      const gr = state.grudge[k];
      if (!gr) continue;
      gr.turns--;
      if (gr.turns <= 0) delete state.grudge[k];
    }

    // 평판은 매 라운드 조금씩 회복 (배신의 대가는 오래 남는다)
    for (let i = 0; i < NATION_COUNT; i++) {
      if (state.active[i] && Game.countOwned(state, i) > 0) addReputation(state, i, 1);
    }

    return { expired, tributes, broke };
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
    const p = Object.assign({ id: state.nextProposalId++, from, to, at: Date.now() }, fields);
    p.kind = kind;
    state.proposals.push(p);
    return p;
  },

  proposeTruce(state, from, to, turns) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    if (treatyOf(state, from, to)) return { status: 'none', reason: 'already' };
    const t = turns || TUNING.treatyTurns;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'truce');
      const p = Game.queueProposal(state, from, to, { kind: 'truce', turns: t });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '불가침 조약을 제안했습니다' };
    }
    if (Game.evaluateTruce(state, to, from)) {
      Game.createTreaty(state, from, to, 'truce', t);
      addRelation(state, from, to, 5);
      addReputation(state, from, 2);
      const text = nationName(state, from) + ' ↔ ' + nationName(state, to) +
        ' 불가침 조약 체결 (' + t + '턴)';
      diploNote(state, text, 'good', [from, to]);
      return { status: 'accepted', turns: t, text };
    }
    const text = nationName(state, to) + '이(가) 불가침 제안을 거절했습니다';
    diploNote(state, text, 'warn', [from, to]);
    return { status: 'declined', text };
  },

  proposeAlliance(state, from, to, turns) {
    if (from === to) return { status: 'none', reason: 'self' };
    if (to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { status: 'none', reason: 'dead' };
    }
    const tr = treatyOf(state, from, to);
    if (!tr || tr.type === 'ally') return { status: 'none', reason: 'need_truce' };
    if (tr.type === 'tribute') return { status: 'none', reason: 'need_truce' };
    const t = turns || TUNING.allyTurns;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'ally');
      const p = Game.queueProposal(state, from, to, { kind: 'ally', turns: t });
      return { status: 'queued', dup: had, proposal: p, text: had ? null : '동맹을 제안했습니다' };
    }
    if (Game.evaluateAlliance(state, to, from)) {
      Game.createTreaty(state, from, to, 'ally', t);
      addRelation(state, from, to, TUNING.allianceRelation);
      addReputation(state, from, 4);
      const text = nationName(state, from) + ' ↔ ' + nationName(state, to) +
        ' 정식 동맹 체결 (' + t + '턴 · 공동 참전 가능)';
      diploNote(state, text, 'good', [from, to]);
      return { status: 'accepted', turns: t, text };
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
    const t = TUNING.tributeTurns;
    const payer = dir === 'demand' ? to : from;
    const payee = dir === 'demand' ? from : to;

    if (state.human[to]) {
      const had = state.proposals.some((p) => p.from === from && p.to === to && p.kind === 'tribute');
      const p = Game.queueProposal(state, from, to, {
        kind: 'tribute', turns: t, amount: amt, direction: dir,
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
      amt + '개씩 ' + t + '턴 조약 체결';
    diploNote(state, text, 'tribute', [from, to]);
    return { status: 'accepted', turns: t, text };
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
        withTruce: !!withTruce, turns: withTruce ? TUNING.treatyTurns : 0
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
    addRelation(state, from, to, TUNING.cedeRelation);
    addReputation(state, from, 5);
    if (withTruce) {
      const prev = treatyOf(state, from, to);
      if (!prev) {
        Game.createTreaty(state, from, to, 'truce', TUNING.treatyTurns);
      } else if (prev.type === 'truce') {
        prev.turns = Math.max(prev.turns, TUNING.treatyTurns);
      }
    }
    const text = nationName(state, from) + ' → ' + nationName(state, to) + ' ' + region.name +
      ' 할양 · 관계 +' + TUNING.cedeRelation + (withTruce ? ' · 불가침 ' + TUNING.treatyTurns + '턴' : '');
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
    if (state.calls.some((c) => c.from === from && c.to === to && c.target === target && c.turns > 0)) {
      return { status: 'none', reason: 'dup' };
    }

    if (state.human[to]) {
      const p = Game.queueProposal(state, from, to, {
        kind: 'call', target, targetName: nationName(state, target), turns: TUNING.callTurns
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
      turns: TUNING.callTurns,
      at: Date.now()
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
      Game.createTreaty(state, p.from, p.to, 'truce', p.turns || TUNING.treatyTurns);
      addRelation(state, p.from, p.to, 5);
      addReputation(state, p.from, 2);
      text = nationName(state, p.from) + ' ↔ ' + nationName(state, p.to) +
        ' 불가침 조약 체결 (' + (p.turns || TUNING.treatyTurns) + '턴)';
    } else if (p.kind === 'ally') {
      Game.createTreaty(state, p.from, p.to, 'ally', p.turns || TUNING.allyTurns);
      addRelation(state, p.from, p.to, TUNING.allianceRelation);
      addReputation(state, p.from, 4);
      text = nationName(state, p.from) + ' ↔ ' + nationName(state, p.to) +
        ' 정식 동맹 체결 (' + (p.turns || TUNING.allyTurns) + '턴)';
    } else if (p.kind === 'tribute') {
      const payer = p.payer != null ? p.payer : (p.direction === 'demand' ? p.to : p.from);
      const payee = p.payee != null ? p.payee : (p.direction === 'demand' ? p.from : p.to);
      Game.createTreaty(state, p.from, p.to, 'tribute', p.turns || TUNING.tributeTurns, {
        payer, payee, amount: clampNum(p.amount || 1, 1, 2)
      });
      addRelation(state, p.from, p.to, 3);
      if (p.direction === 'offer') addReputation(state, payer, 3); else addReputation(state, payer, -2);
      text = nationName(state, payer) + ' → ' + nationName(state, payee) + ' 조공 ' +
        clampNum(p.amount || 1, 1, 2) + '개씩 ' + (p.turns || TUNING.tributeTurns) + '턴 조약 체결';
    } else if (p.kind === 'cede') {
      Game.applyCede(state, p.from, p.to, p.regionId, p.withTruce);
      text = nationName(state, p.from) + ' → ' + nationName(state, p.to) + ' ' +
        (p.regionName || '영토') + ' 할양' + (p.withTruce ? ' · 불가침 체결' : '');
      skipNote = true; // applyCede 가 상세한 소식을 이미 남긴다
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
    if (state.reinforcements >= TUNING.aidAmount) return true;
    return state.regions.some((r) => r.owner === from && r.troops >= TUNING.aidThreshold);
  },

  sendAid(state, from, to) {
    if (from === to || to < 0 || !state.active[to] || Game.countOwned(state, to) === 0) {
      return { ok: false, reason: 'target' };
    }
    if (!state.human[from]) return { ok: false, reason: 'turn' };
    const need = TUNING.aidAmount;
    let source = null, srcName = '';

    if (state.reinforcements >= need) {
      state.reinforcements -= need;
      source = 'reserve';
      srcName = '남은 배치';
    } else {
      let best = null;
      for (const r of state.regions) {
        if (r.owner !== from || r.troops < TUNING.aidThreshold) continue;
        if (!best || r.troops > best.troops) best = r;
      }
      if (best) {
        best.troops -= need;
        source = 'territory';
        srcName = best.name;
      }
    }
    if (!source) return { ok: false, reason: 'short' };

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
      tr.turns = Math.max(tr.turns, TUNING.allyTurns);
    } else if (!tr) {
      Game.createTreaty(state, from, to, 'ally', TUNING.allyTurns);
    }
    addRelation(state, from, to, TUNING.aidRelation);
    addReputation(state, from, TUNING.aidReputation);
    const after = treatyOf(state, from, to);
    const text = nationName(state, from) + ' → ' + nationName(state, to) + ' 병력 ' + need +
      ' 지원 (' + srcName + ') · 관계 +' + TUNING.aidRelation;
    diploNote(state, text, 'good', [from, to]);
    return {
      ok: true,
      amount: need,
      source,
      srcName,
      region: target.name,
      turns: after ? after.turns : TUNING.allyTurns,
      text
    };
  },

  /* ---------------- AI 외교: 리더 견제 · 두 전선 · 조공 · 공동 참전 ---------------- */
  aiDiplomacy(state, ai) {
    const out = [];
    const total = state.regions.length;
    const leader = leaderOf(state);
    const myCount = Game.countOwned(state, ai);
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

    // 1) 35% 이상을 먹은 1위 국가 견제: 다른 강국과 손잡는다
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

    // 2) 두 전선: 약한 쪽과 먼저 휴전, 필요하면 조공 1개를 바친다
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

    // 3) 약한 이웃에게 조공 요구
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

    // 4) 동맹에게 공동 참전 요청
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

    // 5) 사람 플레이어와의 관계 관리
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

function treatyLabel(tr) {
  if (!tr) return '조약';
  if (tr.type === 'ally') return '동맹';
  if (tr.type === 'tribute') return '조공 조약';
  return '불가침 조약';
}

/* =============================================================================
   3. 방 · 플레이어 · 진행
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

function createRoom(ws, name, aiFill) {
  const code = makeRoomCode();
  const room = {
    code,
    hostSlot: 0,
    players: [],
    started: false,
    aiFill: aiFill !== false,
    game: null,
    flow: 0,
    log: [],
    createdAt: Date.now(),
    lastAt: Date.now(),
    autoEndTimer: null,
    finishedAt: null,
    closed: false
  };
  const player = {
    slot: 0,
    name,
    token: makeToken(),
    ws,
    connected: true,
    isAI: false,
    abandoned: false
  };
  room.players.push(player);
  rooms.set(code, room);
  bind(ws, room, player);
  return { room, player };
}

function joinRoom(ws, codeRaw, name) {
  const code = String(codeRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const room = rooms.get(code);
  if (!room) return { error: ['NO_ROOM', '그런 방이 없어요. 코드를 확인해 주세요.'] };
  if (room.started) return { error: ['ROOM_STARTED', '이미 시작된 방이에요.'] };
  if (room.players.length >= MAX_PLAYERS) return { error: ['ROOM_FULL', '방이 가득 찼어요 (4명).'] };
  let slot = 0;
  const used = new Set(room.players.map((p) => p.slot));
  while (used.has(slot)) slot++;
  const player = {
    slot,
    name,
    token: makeToken(),
    ws,
    connected: true,
    isAI: false,
    abandoned: false
  };
  room.players.push(player);
  room.lastAt = Date.now();
  bind(ws, room, player);
  addLog(room, name + ' 님이 입장했습니다', 'info');
  return { room, player };
}

function findPlayer(room, slot) {
  return room.players.find((p) => p.slot === slot) || null;
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
  if (room.autoEndTimer) { clearTimeout(room.autoEndTimer); room.autoEndTimer = null; }
  room.lastAt = Date.now();
}

function addLog(room, text, kind) {
  room.log.push({ at: Date.now(), text, kind: kind || 'info' });
  if (room.log.length > 40) room.log.splice(0, room.log.length - 40);
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
  const p = findPlayer(room, slot);
  if (p && p.isAI) return p.name;
  return playerName(room, slot);
}

function publicState(room, slot) {
  const st = room.game;
  const base = {
    type: 'state',
    code: room.code,
    host: room.hostSlot,
    started: room.started,
    aiFill: room.aiFill,
    you: slot,
    turn: st.turn,
    cur: st.cur,
    phase: st.phase,
    reinforcements: st.reinforcements,
    over: st.over,
    regions: st.regions.map((r) => ({
      id: r.id,
      name: r.name,
      poly: r.poly,
      cx: r.cx,
      cy: r.cy,
      r: r.r,
      neighbors: r.neighbors,
      owner: r.owner,
      troops: r.troops
    })),
    treaties: Object.keys(st.treaties).map((k) => {
      const t = st.treaties[k];
      return {
        a: t.a, b: t.b, type: t.type, turns: t.turns,
        payer: t.payer == null ? null : t.payer,
        payee: t.payee == null ? null : t.payee,
        amount: t.amount == null ? null : t.amount
      };
    }),
    proposals: st.proposals.map((p) => ({
      id: p.id, from: p.from, to: p.to, kind: p.kind || 'truce', turns: p.turns,
      amount: p.amount == null ? null : p.amount,
      direction: p.direction || null,
      regionId: p.regionId == null ? null : p.regionId,
      regionName: p.regionName || null,
      target: p.target == null ? null : p.target,
      targetName: p.targetName || null,
      withTruce: !!p.withTruce
    })),
    relations: Object.keys(st.relations).map((k) => {
      const parts = k.split('-');
      return { a: Number(parts[0]), b: Number(parts[1]), value: st.relations[k] };
    }),
    reputation: st.reputation,
    calls: (st.calls || []).map((c) => ({
      id: c.id, from: c.from, to: c.to, target: c.target, turns: c.turns
    })),
    diploLog: (st.diploLog || []).slice(-20),
    names: st.names,
    players: room.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      connected: p.connected,
      isAI: p.isAI,
      host: p.slot === room.hostSlot
    })),
    active: st.active,
    human: st.human,
    activeCount: st.activeCount,
    stats: st.stats,
    log: room.log.slice(-24),
    serverTime: Date.now()
  };
  return base;
}

function broadcastState(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (!p.ws || p.isAI) continue;
    send(p.ws, publicState(room, p.slot));
  }
}

function broadcastEvent(room, text, kind, extra) {
  const clean = polishKo(text);
  addLog(room, clean, kind);
  const payload = Object.assign({ type: 'event', text: clean, kind: kind || 'info', at: Date.now() }, extra || {});
  for (const p of room.players) {
    if (!p.ws || p.isAI) continue;
    send(p.ws, payload);
  }
}

function lobbyPayload(room, slot) {
  return {
    type: 'lobby',
    code: room.code,
    host: room.hostSlot,
    started: room.started,
    aiFill: room.aiFill,
    you: slot,
    players: room.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      connected: p.connected,
      isAI: p.isAI,
      host: p.slot === room.hostSlot
    })),
    youToken: null
  };
}

function broadcastLobby(room) {
  for (const p of room.players) {
    if (!p.ws || p.isAI) continue;
    send(p.ws, lobbyPayload(room, p.slot));
  }
}

function startGame(room, bySlot) {
  if (room.started) return { error: ['ALREADY', '이미 시작했어요.'] };
  if (bySlot !== room.hostSlot) return { error: ['HOST_ONLY', '방장만 시작할 수 있어요.'] };
  const humans = room.players.length;
  if (humans < 1) return { error: ['NO_PLAYER', '플레이어가 없어요.'] };
  if (humans === 1 && !room.aiFill) {
    return { error: ['NEED_OPPONENT', '혼자서는 AI 채우기를 켜거나 친구를 기다려 주세요.'] };
  }

  // 나라 번호(0~3)는 로비 자리 순서와 같아야 하므로 빈 자리를 메운다
  const hostPlayer = findPlayer(room, room.hostSlot);
  room.players.sort((a, b) => a.slot - b.slot);
  for (let i = 0; i < room.players.length; i++) room.players[i].slot = i;
  room.hostSlot = hostPlayer ? hostPlayer.slot : 0;

  room.game = Game.newGame({ humans, aiFill: room.aiFill });
  // 외교 로그에 사람 이름이 바로 보이도록 이름표를 넘긴다
  room.game.names = NATIONS.map((n) => n.name);
  for (const p of room.players) room.game.names[p.slot] = p.name;
  room.log = [];
  room.started = true;
  room.finishedAt = null;
  room.flow++;
  addLog(room, '게임 시작 · ' + humans + '명 참전' + (room.aiFill ? ' (빈 자리 AI)' : ''), 'good');
  broadcastLobby(room);
  broadcastState(room);
  for (const p of room.players) {
    if (p.ws && !p.isAI) send(p.ws, { type: 'started' });
  }
  const st = room.game;
  if (!st.human[st.cur]) {
    // 방장이 없거나(있을 수 없지만) AI 차례라면 진행
    const token = ++room.flow;
    advanceTurn(room, token).catch(() => {});
  } else {
    scheduleAutoEnd(room);
    // 시작 시 대기 중인 제안이 있으면 표시되도록 상태를 한 번 더 보낸다
    setTimeout(() => broadcastState(room), 300);
  }
  return { ok: true };
}

function clearAutoEnd(room) {
  if (room.autoEndTimer) {
    clearTimeout(room.autoEndTimer);
    room.autoEndTimer = null;
  }
}

function scheduleAutoEnd(room, graceMs) {
  clearAutoEnd(room);
  const st = room.game;
  if (!st || st.over || room.started === false) return;
  const p = findPlayer(room, st.cur);
  if (!p || p.isAI || p.connected) return;
  const slot = st.cur;
  const delay = graceMs || TURN_GRACE_MS;
  room.autoEndTimer = setTimeout(() => {
    room.autoEndTimer = null;
    const g = room.game;
    if (!g || g.over || g.cur !== slot || g.phase !== 'player') return;
    broadcastEvent(room, playerName(room, slot) + ' 님 접속 끊김 · 턴을 자동 종료합니다', 'warn');
    endHumanTurn(room, slot, true);
  }, delay);
}

function endHumanTurn(room, slot, forced) {
  const st = room.game;
  if (!st || st.over) return false;
  if (!st.human[st.cur] || st.cur !== slot) return false;
  if (!forced) clearAutoEnd(room);
  st.phase = 'ai';
  broadcastState(room);
  const token = ++room.flow;
  advanceTurn(room, token).catch((err) => {
    console.error('[advance]', err);
  });
  return true;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function battleText(room, res, attackerSlot) {
  const attacker = nationLabel(room, attackerSlot);
  const victim = res.targetOwner >= 0 ? nationLabel(room, res.targetOwner) : NEUTRAL_NAME;
  const bonus = res.allyBonus ? ' [동맹 +1]' : '';
  if (res.captured) {
    return attacker + ' ✦ ' + res.toName + ' 점령 (주사위 ' + res.ar.join('·') + ' vs ' +
      res.dr.join('·') + ')' + bonus + ' · ' + victim;
  }
  if (res.dLoss > 0 && res.aLoss > 0) {
    return attacker + ' ↔ ' + victim + ' 접전 · 아군 -' + res.aLoss + ' / 적 -' + res.dLoss +
      ' (' + res.ar.join('·') + ' vs ' + res.dr.join('·') + ')' + bonus;
  }
  if (res.dLoss > 0) {
    return attacker + ' 공격 성공 · 적 -' + res.dLoss + ' (' + res.ar.join('·') + ' vs ' +
      res.dr.join('·') + ')' + bonus;
  }
  return attacker + ' 공격 실패 · 아군 -' + res.aLoss + ' (' + res.ar.join('·') + ' vs ' +
    res.dr.join('·') + ')' + bonus;
}

async function advanceTurn(room, token) {
  const st = room.game;
  if (!st) return;
  let n = st.cur;
  let guard = 0;

  while (guard++ < 16) {
    if (room.closed || room.flow !== token) return;
    n = (n + 1) % NATION_COUNT;
    if (n === 0) {
      st.turn++;
      const tick = Game.tickTreaties(st);
      for (const e of tick.expired) {
        if (!st.active[e.a] && !st.active[e.b]) continue;
        broadcastEvent(
          room,
          '조약 만료 · ' + nationLabel(room, e.a) + ' ↔ ' + nationLabel(room, e.b),
          'warn'
        );
      }
      for (const tr of tick.tributes) {
        broadcastEvent(room, '조공 · ' + nationLabel(room, tr.from) + ' → ' +
          nationLabel(room, tr.to) + ' ' + tr.amount + '개 (' + tr.region + ')', 'info');
      }
      for (const b of tick.broke) {
        broadcastEvent(room, '조약 파기 · ' + nationLabel(room, b.a) + ' ↔ ' +
          nationLabel(room, b.b) + ' (조공 미이행)', 'bad');
      }
      broadcastState(room);
    }

    if (!st.active[n] || Game.countOwned(st, n) === 0) continue;

    if (st.human[n]) {
      Game.startTurn(st, n);
      st.phase = 'player';
      st.cur = n;
      broadcastState(room);
      broadcastEvent(room, nationLabel(room, n) + ' 님의 차례입니다', 'good');
      const p = findPlayer(room, n);
      scheduleAutoEnd(room, p && !p.connected ? 20000 : TURN_GRACE_MS);
      return;
    }

    st.cur = n;
    st.phase = 'ai';
    st.reinforcements = 0;
    broadcastState(room);
    await sleep(700);
    if (room.closed || room.flow !== token) return;

    await runAiTurn(room, n, token);
    if (room.closed || room.flow !== token) return;
    if (st.over) return;
  }
}

async function runAiTurn(room, slot, token) {
  const st = room.game;
  if (!st || st.over) return;

  Game.aiReinforce(st, slot);
  Game.aiShiftTroops(st, slot);
  broadcastState(room);
  await sleep(420);
  if (room.closed || room.flow !== token) return;

  const dip = Game.aiDiplomacy(st, slot);
  for (const item of dip) {
    if (!item) continue;
    if (item.type === 'note') {
      broadcastEvent(room, item.text, item.kind || 'info');
    } else if (item.type === 'proposal' && item.proposal) {
      broadcastState(room);
      const target = findPlayer(room, item.proposal.to);
      if (target && target.ws) {
        const label = nationLabel(room, slot);
        const what = item.text || '제안이 도착했습니다';
        notify(target.ws, label + ' 님이 ' + what, 'warn');
      }
    }
  }
  if (dip.length) {
    await sleep(360);
    if (room.closed || room.flow !== token) return;
  }

  const budget = Game.aiAttackBudget(st, slot);
  for (let k = 0; k < budget && !st.over; k++) {
    const mv = Game.aiPickAttack(st, slot);
    if (!mv) break;
    const res = Game.attack(st, mv.from.id, mv.to.id);
    if (!res.ok) break;
    const victimSlot = res.targetOwner;
    broadcastState(room);
    broadcastEvent(room, battleText(room, res, slot), res.captured ? 'good' : 'warn');
    if (res.captured && victimSlot >= 0 && st.human[victimSlot] &&
        Game.countOwned(st, victimSlot) === 0) {
      broadcastEvent(room, nationLabel(room, victimSlot) + ' 님이 탈락했습니다', 'bad');
    }
    Game.checkOver(st);
    if (st.over) { finishGame(room); return; }
    await sleep(res.captured ? 620 : 360);
    if (room.closed || room.flow !== token) return;
  }
  broadcastState(room);
}

function finishGame(room) {
  const st = room.game;
  if (!st || !st.over) return;
  clearAutoEnd(room);
  room.finishedAt = Date.now();
  st.phase = 'over';
  broadcastState(room);
  const w = st.over.winner;
  const winText = st.over.type === 'nation'
    ? nationLabel(room, w) + '이(가) 대륙을 통일했습니다!'
    : nationLabel(room, w) + '이(가) 마지막까지 살아남았습니다!';
  broadcastEvent(room, '게임 종료 · ' + winText, 'good');
}

function validName(ws, raw) {
  const name = sanitizeName(raw);
  if (!name || name.length < 1) {
    send(ws, { type: 'error', code: 'NAME', message: '이름을 입력해 주세요.' });
    return null;
  }
  return name;
}

function validateAction(room, slot, action) {
  const st = room.game;
  if (!st) return 'not_started';
  if (st.over) return 'over';
  if (!action || typeof action !== 'object') return 'bad';
  const isTurn = st.phase === 'player' && st.cur === slot && st.human[slot];
  const kind = action.kind;

  if (kind === 'respond') {
    const p = st.proposals.find((x) => x.id === Number(action.id));
    if (!p || p.to !== slot) return 'no_proposal';
    return null;
  }
  if (!isTurn) return 'not_your_turn';
  if (kind === 'deploy' || kind === 'attack' || kind === 'transfer' || kind === 'end' ||
      kind === 'propose' || kind === 'aid' || kind === 'break' || kind === 'alliance' ||
      kind === 'tribute' || kind === 'cede' || kind === 'call') {
    return null;
  }
  return 'bad';
}

function handleAction(room, player, action) {
  const st = room.game;
  const slot = player.slot;
  const err = validateAction(room, slot, action);
  if (err) {
    const msg = {
      not_started: '아직 게임이 시작되지 않았어요.',
      over: '게임이 끝났어요.',
      not_your_turn: '지금은 내 차례가 아니에요.',
      no_proposal: '이미 사라진 제안이에요.',
      bad: '잘못된 요청이에요.'
    }[err] || '할 수 없는 동작이에요.';
    notify(player.ws, msg, 'warn');
    return;
  }

  const kind = action.kind;

  if (kind === 'deploy') {
    const idx = Number(action.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= st.total) return;
    const r = st.regions[idx];
    if (!r || r.owner !== slot) { notify(player.ws, '내 영토에만 배치할 수 있어요.', 'warn'); return; }
    let amount = action.amount === 'all' ? st.reinforcements : Number(action.amount);
    if (!Number.isFinite(amount) || amount < 1) amount = 1;
    const placed = Game.deploy(st, idx, Math.floor(amount));
    if (placed > 0) {
      notify(player.ws, '+' + placed + ' 병력 → ' + r.name + ' (' + r.troops + ')', 'good');
      broadcastState(room);
    }
    return;
  }

  if (kind === 'attack') {
    const from = Number(action.from), to = Number(action.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    const src = st.regions[from];
    if (!src || src.owner !== slot) { notify(player.ws, '내 영토에서만 공격할 수 있어요.', 'warn'); return; }
    const victimSlot = st.regions[to] ? st.regions[to].owner : -2;
    const res = Game.attack(st, from, to);
    if (!res.ok) {
      if (res.reason === 'treaty') notify(player.ws, '불가침 조약 중이에요 · 먼저 파기하세요.', 'warn');
      else if (res.reason === 'far') notify(player.ws, '인접한 영토만 공격할 수 있어요.', 'warn');
      else if (res.reason === 'weak') notify(player.ws, '공격에는 병력 2 이상이 필요해요.', 'warn');
      else notify(player.ws, '공격할 수 없어요.', 'warn');
      return;
    }
    broadcastState(room);
    broadcastEvent(room, battleText(room, res, slot), res.captured ? 'good' : 'warn');
    if (res.captured && victimSlot >= 0 && st.human[victimSlot] && Game.countOwned(st, victimSlot) === 0) {
      broadcastEvent(room, nationLabel(room, victimSlot) + ' 님이 탈락했습니다', 'bad');
    }
    if (Game.checkOver(st)) {
      finishGame(room);
    } else if (Game.countOwned(st, slot) > 0) {
      // 턴은 유지 (여러 번 공격 가능)
    }
    return;
  }

  if (kind === 'transfer') {
    const from = Number(action.from), to = Number(action.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    const src = st.regions[from];
    if (!src || src.owner !== slot) return;
    const n = Game.transfer(st, from, to);
    if (n > 0) {
      notify(player.ws, '병력 ' + n + ' 이동 → ' + st.regions[to].name, 'good');
      broadcastState(room);
    }
    return;
  }

  if (kind === 'end') {
    endHumanTurn(room, slot, false);
    return;
  }

  if (kind === 'propose') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const r = Game.proposeTruce(st, slot, to);
    if (r.status === 'queued') {
      notify(player.ws, nationLabel(room, to) + ' 님에게 불가침 조약을 제안했습니다', 'good');
      broadcastState(room);
      const target = findPlayer(room, to);
      if (target && target.ws) {
        notify(target.ws, nationLabel(room, slot) + ' 님이 불가침 조약을 제안했습니다', 'warn');
      }
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text || ('불가침 조약 체결'), 'good');
      broadcastState(room);
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '상대가 제안을 거절했습니다', 'bad');
      broadcastState(room);
    } else if (r.reason === 'already') {
      notify(player.ws, '이미 조약이 있어요. 동맹으로 격상할 수 있어요.', 'warn');
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
      broadcastState(room);
      const target = findPlayer(room, to);
      if (target && target.ws) notify(target.ws, nationLabel(room, slot) + ' 님이 동맹을 제안했습니다', 'warn');
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
      broadcastState(room);
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '동맹 제안이 거절되었습니다', 'bad');
      broadcastState(room);
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
      broadcastState(room);
      const target = findPlayer(room, to);
      if (target && target.ws) {
        notify(target.ws, nationLabel(room, slot) + ' 님이 조공 ' +
          (action.direction === 'offer' ? '제안' : '요구') + '을 보냈습니다', 'warn');
      }
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
      broadcastState(room);
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '조공 제안이 거절되었습니다', 'bad');
      broadcastState(room);
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
      broadcastState(room);
      const target = findPlayer(room, to);
      if (target && target.ws) {
        notify(target.ws, nationLabel(room, slot) + ' 님이 ' + (st.regions[regionId] || {}).name +
          ' 할양을 제안했습니다', 'warn');
      }
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
      broadcastState(room);
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '할양 제안이 거절되었습니다', 'bad');
      broadcastState(room);
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
      broadcastState(room);
      const tp = findPlayer(room, to);
      if (tp && tp.ws) {
        notify(tp.ws, nationLabel(room, slot) + ' 님이 ' + nationLabel(room, target) +
          ' 에 대한 공동 참전을 요청했습니다', 'warn');
      }
    } else if (r.status === 'accepted') {
      broadcastEvent(room, r.text, 'good');
      broadcastState(room);
    } else if (r.status === 'declined') {
      notify(player.ws, r.text || '공동 참전 요청이 거절되었습니다', 'bad');
      broadcastState(room);
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

  if (kind === 'respond') {
    const id = Number(action.id);
    const p = st.proposals.find((x) => x.id === id);
    if (!p) { notify(player.ws, '이미 사라진 제안이에요.', 'warn'); return; }
    const r = Game.resolveProposal(st, p, !!action.accept);
    broadcastEvent(room, r.text, action.accept ? 'good' : 'warn');
    broadcastState(room);
    return;
  }

  if (kind === 'aid') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const a = Game.sendAid(st, slot, to);
    if (!a.ok) {
      notify(player.ws, '병력이 부족해요 · 배치 ' + TUNING.aidAmount + '개 또는 병력 ' +
        TUNING.aidThreshold + '+ 영토가 필요해요.', 'bad');
      return;
    }
    broadcastEvent(room, a.text || (nationLabel(room, slot) + ' → ' + nationLabel(room, to) +
      ' 병력 ' + a.amount + ' 지원 · 동맹 ' + a.turns + '턴'), 'good');
    broadcastState(room);
    return;
  }

  if (kind === 'break') {
    const to = Number(action.to);
    if (!Number.isInteger(to)) return;
    const b = Game.breakPact(st, slot, to);
    if (!b) { notify(player.ws, '파기할 조약이 없어요.', 'warn'); return; }
    broadcastEvent(room, nationLabel(room, slot) + '이(가) ' + nationLabel(room, to) +
      '와(과)의 조약을 파기했습니다 · 신뢰도 -' + TUNING.betrayReputation, 'bad');
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
    // 진행 중 나가면 그 나라는 AI 가 이어받는다 (탈주 처리)
    player.isAI = true;
    player.connected = false;
    player.abandoned = true;
    player.ws = null;
    if (room.game) {
      room.game.human[player.slot] = false;
      addLog(room, player.name + ' 님이 나갔습니다 · AI 가 이어받습니다', 'warn');
    }
  }

  // 남은 플레이어에게 알린다
  if (room.players.length === 0) {
    room.players = [];
  } else {
    if (wasHost) {
      const next = room.players.find((p) => !p.isAI);
      if (next) room.hostSlot = next.slot;
    }
    if (room.started) {
      broadcastState(room);
      if (room.game && !room.game.over && room.game.cur === player.slot) {
        // 나간 사람 차례였다면 바로 다음으로
        const st = room.game;
        if (st.human[st.cur] === false) {
          st.phase = 'ai';
          const token = ++room.flow;
          advanceTurn(room, token).catch(() => {});
        }
      }
    } else {
      broadcastLobby(room);
    }
  }

  if (ws.room === room) {
    ws.room = null;
    ws.player = null;
  }

  const anyHuman = room.players.some((p) => !p.isAI);
  if (!anyHuman) {
    room.closed = true;
    clearAutoEnd(room);
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
    const { room, player } = createRoom(ws, name, !!msg.aiFill);
    send(ws, {
      type: 'joined',
      code: room.code,
      token: player.token,
      slot: player.slot,
      name: player.name
    });
    broadcastLobby(room);
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
    player.connected = true;
    send(ws, {
      type: 'resumed',
      code: room.code,
      token: player.token,
      slot: player.slot,
      name: player.name
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
    if (player.slot !== room.hostSlot) return;
    if (room.started) return;
    room.aiFill = !!msg.value;
    broadcastLobby(room);
    return;
  }

  if (type === 'start') {
    const out = startGame(room, player.slot);
    if (out.error) send(ws, { type: 'error', code: out.error[0], message: out.error[1] });
    return;
  }

  if (type === 'action') {
    if (!room.started) { send(ws, { type: 'error', code: 'NOT_STARTED', message: '아직 시작하지 않았어요.' }); return; }
    handleAction(room, player, msg.action);
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
    room.finishedAt = null;
    room.flow++;
    room.players = room.players.filter((p) => !p.isAI);
    for (const p of room.players) p.connected = !!p.ws;
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
  if (player.ws && player.ws !== ws) return; // 이미 새 연결로 교체됨
  player.connected = false;
  player.ws = null;
  player.disconnectedAt = Date.now();
  if (!room.started) {
    // 로비에서는 잠시 자리를 남겨 두고, 새로고침/재접속을 기다린다
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
    broadcastState(room);
    const st = room.game;
    if (st && !st.over && st.cur === player.slot && st.phase === 'player') {
      broadcastEvent(room, player.name + ' 님 접속 끊김 · ' + Math.round(TURN_GRACE_MS / 1000) +
        '초 뒤 턴이 자동 종료됩니다', 'warn');
      scheduleAutoEnd(room);
    }
  }
}

/* =============================================================================
   4. WebSocket 서버
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
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
    const noCache = ext === '.html';
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
      if (ws.bucket.count > 60) {
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
        clearAutoEnd(room);
        rooms.delete(code);
        continue;
      }
      if (now - room.createdAt > ROOM_MAX_AGE_MS) {
        room.closed = true;
        clearAutoEnd(room);
        rooms.delete(code);
      }
    }
  }, 60000);
  cleanup.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(cleanup);
  });

  return { server, wss };
}

function start() {
  const { server } = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('영토 전쟁 ONLINE · http://localhost:' + PORT + '  (WebSocket /ws)');
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
  NATIONS,
  TUNING,
  rooms,
  createServer,
  createRoom,
  joinRoom,
  startGame,
  handleMessage,
  publicState,
  sanitizeName
};

if (require.main === module) start();
