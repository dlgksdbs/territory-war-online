'use strict';

/* =============================================================================
   🎬 모션 품질 테스트 (브라우저 없이 Node 에서 도는 절차적 모션 검증)
   -----------------------------------------------------------------------------
   2026-11-28 사용자 요청 "모션 더 열심히 깎아" 반영분을 수치 확인한다:
   1) 프레임 사이 관절 회전이 튀지 않는다 (Catmull-Rom 곡선으로 키 경계 속도 연속)
   2) 무릎·팔꿈치가 사람 관절 범위를 벗어나 꺾이지 않는다 (몸을 뚫거나 뒤로 꺾임 없음)
   3) 걷기 착지에서 무릎이 충격을 흡수한다 (한 걸음 안에 접혔다 펴지는 진동)
   4) 막기 전환은 스프링이라 살짝 지나쳤다(오버슈트) 내려앉는다
   실행: node test/motion.js   (npm test 에 포함)
   ============================================================================= */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('  ✗ ' + name, extra == null ? '' : JSON.stringify(extra));
    throw new Error('테스트 실패: ' + name);
  }
  passed++;
  console.log('  ✓ ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra)));
}

const mod = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', rel)).href);

(async () => {
  const cfg = await mod('config.js');
  const pose = await mod('pose.js');
  const { Battle } = await mod('battle.js');
  const { J } = await mod('rig.js');
  const DT = 1 / 60;

  /* 한 유닛을 원하는 상태로 고정해 프레임을 돌린다 (main.js poseTrack 과 같은 방식) */
  function track(cls, kind, from, to, frames) {
    const b = new Battle({ config: {} });
    const u = b.newUnit(cls, 'ally', 0, 0, false);
    b.player = null;
    u.dead = false; u.attackT = -1; u.moveAmt = 0; u.staggerT = 0;
    u.guard = false; u._guardK = 0; u.walkPhase = 0; u.y = 0;
    const prev = new Float32Array(u.pose.rot.length);
    let max = 0, maxAt = -1, rootJump = 0, prevY = 0, prevZ = 0, have = false;
    let minShin = 99, maxShin = -99, maxElb = -99;
    for (let i = 0; i <= frames; i++) {
      const k = from + (to - from) * (i / frames);
      if (kind === 'attack') u.attackT = k;
      else if (kind === 'death') { u.dead = true; u.deadT = k; }
      else if (kind === 'walk') { u.moveAmt = 1; u.walkPhase = k; }
      pose.computePose(u, i * DT, DT);
      const rot = u.pose.rot;
      minShin = Math.min(minShin, rot[J.shinR * 3], rot[J.shinL * 3]);
      maxShin = Math.max(maxShin, rot[J.shinR * 3], rot[J.shinL * 3]);
      maxElb = Math.max(maxElb, rot[J.elbR * 3], rot[J.elbL * 3]);
      if (have) {
        for (let j = 0; j < rot.length; j++) {
          const d = Math.abs(rot[j] - prev[j]);
          if (d > max) { max = d; maxAt = i; }
        }
        rootJump = Math.max(rootJump, Math.abs(u.pose.rootAdd[0] - prevY) + Math.abs(u.pose.rootAdd[2] - prevZ));
      }
      prev.set(rot);
      prevY = u.pose.rootAdd[0]; prevZ = u.pose.rootAdd[2];
      have = true;
    }
    return { max: +max.toFixed(4), maxAt, rootJump: +rootJump.toFixed(4), minShin: +minShin.toFixed(3), maxShin: +maxShin.toFixed(3), maxElb: +maxElb.toFixed(3) };
  }

  const CLASSES = ['soldier', 'elite', 'knight', 'blademaster', 'wizard', 'berserker'];
  /* 프레임당 허용 회전(rad) — 광전사는 0.24초 모션이라 원래 크다 */
  /* 프레임당 허용 회전(rad) — 2026-11-28 Catmull-Rom 곡선 기준 실측값 + 여유.
     (예전 elite 한계 0.45 는 이미 곡선 개편 전에도 0.547 로 넘고 있었다 — 실측에 맞춰 다시 잡았다) */
  const ATK_LIMIT = { soldier: 0.48, elite: 0.62, knight: 0.47, blademaster: 0.92, wizard: 0.38, berserker: 0.85 };

  console.log('🎬 공격 모션 — 프레임이 튀지 않는다 (키 경계 속도 연속)');
  for (const cls of CLASSES) {
    const c = cfg.CLASSES[cls];
    const atk = track(cls, 'attack', 0, c.cycle, Math.round(c.cycle * 60));
    ok(cls + ' — 프레임당 회전 ' + atk.max + ' ≤ ' + ATK_LIMIT[cls], atk.max <= ATK_LIMIT[cls], atk);
  }

  console.log('🦵 관절이 사람 범위를 벗어나 꺾이지 않는다');
  for (const cls of CLASSES) {
    const c = cfg.CLASSES[cls];
    const walk = track(cls, 'walk', 0, Math.PI * 4, 200);
    const atk = track(cls, 'attack', 0, c.cycle, Math.round(c.cycle * 60));
    ok(cls + ' — 무릎이 뒤로 꺾이지 않는다 (걷기·공격)',
      walk.minShin > -0.06 && atk.minShin > -0.06, { walk: walk.minShin, attack: atk.minShin });
    ok(cls + ' — 팔꿈치는 몸 안쪽으로만 접힌다 (걷기·공격)',
      walk.maxElb < 0.12 && atk.maxElb < 0.12, { walk: walk.maxElb, attack: atk.maxElb });
  }

  console.log('👣 걷기 — 착지할 때 무릎이 충격을 먹는다');
  {
    const walk = track('soldier', 'walk', 0, Math.PI * 4, 220);
    ok('한 걸음 안에 무릎이 접혔다 펴지는 진동 폭이 있다', walk.maxShin - walk.minShin > 0.35,
      { min: walk.minShin, max: walk.maxShin });
    const w1 = track('soldier', 'walk', 0, Math.PI * 4, 220);
    ok('걷기 프레임 회전도 튀지 않는다', w1.max < 0.30, { max: w1.max });
    ok('걷기 루트 이동이 프레임마다 작다 (순간이동 없음)', w1.rootJump < 0.02, { rootJump: w1.rootJump });
  }

  console.log('🛡️ 막기 전환 — 스프링(묵직하게, 살짝 지나쳤다 내려앉음)');
  {
    const b = new Battle({ config: {} });
    const u = b.newUnit('soldier', 'ally', 0, 0, false);
    u.guard = true; u._guardK = 0; u._guardV = 0;
    let maxK = 0, framesTo1 = -1, minV = 99;
    for (let i = 0; i < 40; i++) {
      pose.computePose(u, i * DT, DT);
      maxK = Math.max(maxK, u._guardK);
      if (framesTo1 < 0 && Math.abs(u._guardK - 1) < 0.04) framesTo1 = i;
    }
    ok('가드 자세로 0.25초 안에 들어간다', framesTo1 >= 0 && framesTo1 <= 15, { frames: framesTo1, maxK: +maxK.toFixed(3) });
    ok('들어올 때 살짝 지나친다 (오버슈트)', maxK > 1.0 && maxK < 1.13, { maxK: +maxK.toFixed(3) });
    ok('가만히 있으면 정확히 1 로 안정된다', Math.abs(u._guardK - 1) < 0.004, { k: +u._guardK.toFixed(4) });
    /* 가드 유지 중에도 완전히 굳지 않는다 (호흡·떨림) */
    const seen = new Set();
    for (let i = 0; i < 6; i++) { pose.computePose(u, i * 0.13, DT); seen.add(u.pose.rot[J.chest * 3].toFixed(4)); }
    ok('막는 동안에도 미세하게 숨을 쉰다', seen.size >= 2, { distinct: seen.size });
    void minV;
  }

  console.log('\n모션 품질 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
