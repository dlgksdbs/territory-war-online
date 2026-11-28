'use strict';

/* =============================================================================
   솔로 전장 밸런스 테스트 (브라우저 없이 Node 에서 도는 순수 시뮬레이션)
   -----------------------------------------------------------------------------
   2026-11-28 사용자 지시로 바뀐 것들을 실제 코드로 확인한다:
   1) ⚔️ 근접 사거리 소폭 상향 — 근접 5병종 공통 +0.40m, 빨간 조준점(aimTarget)과
      실제 타격 판정(resolveMelee)이 정확히 같은 거리에서 맞는다
   2) 🔮 대마법사는 제외 — 지팡이 근접 판정·마법 범위 모두 예전 값 그대로
   3) 🌸 매화 일섬 — 돌진 거리 +44%, 돌진 중 무적, 돌진 직후 0.2초 무적, 베면 즉시 해제
   실행: node test/balance.js   (npm test 에 포함)
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
  const { Battle } = await mod('battle.js');
  const dt = 1 / 60;

  console.log('⚔️ 근접 사거리 소폭 상향 (근접 5병종 공통)');
  ok('플레이어 근접 사거리 보정은 0.85 (예전 0.45 + 0.40)',
    cfg.PLAYER_REACH_BONUS === 0.85 && Math.abs(cfg.PLAYER_REACH_BONUS - 0.45 - 0.4) < 1e-9,
    { bonus: cfg.PLAYER_REACH_BONUS });
  ok('플레이어 부채꼴 여유는 그대로 0.3', cfg.PLAYER_ARC_BONUS === 0.3, cfg.PLAYER_ARC_BONUS);
  ok('대마법사 보정은 예전 값 0.45 그대로', cfg.PLAYER_REACH_BONUS_WIZARD === 0.45,
    cfg.PLAYER_REACH_BONUS_WIZARD);

  /* 근접 5병종 — 같은 거리(예전엔 닿지 않던 3.24m)에서 실제로 벤다 */
  const MELEE = ['soldier', 'elite', 'knight', 'blademaster', 'berserker'];
  for (const cls of MELEE) {
    const b = new Battle({ config: {} });
    const p = b.newUnit(cls, 'ally', 0, 0, true);
    p.yaw = 0; p.cooldown = 0; p.attackT = -1;
    const spec = cfg.CLASSES[cls];
    /* 예전 사거리(spec.reach + 0.45 + 상대 반지름)로는 못 닿고, 새 사거리로는 닿는 지점 */
    const oldMax = spec.reach + 0.45 + cfg.CLASSES.soldier.radius;
    const d = oldMax + 0.12;
    const foe = b.newUnit('soldier', 'enemy', 0, d, false);
    /* 한 방에 죽지 않게 체력만 크게 (반지름·방어력은 그대로) */
    foe.hp = 99999; foe.maxHp = 99999;
    b.player = p; b.noGrowth = true;
    b.grid.build(b.units);
    b.resolveMelee(p);
    ok(cls + ' — 넓어진 사거리(' + d.toFixed(2) + 'm)에서 베기가 들어간다',
      foe.hp < foe.maxHp, { d: +d.toFixed(2), hp: +foe.hp.toFixed(1), oldMax: +oldMax.toFixed(2) });
  }

  /* 빨간 조준점(aimTarget) = 실제 타격 판정 — 같은 거리에서 켜지고, 넘으면 꺼진다 */
  {
    const b = new Battle({ config: {} });
    const p = b.newUnit('soldier', 'ally', 0, 0, true);
    p.yaw = 0; p.cooldown = 0; p.attackT = -1;
    b.player = p;
    const edge = cfg.CLASSES.soldier.reach + cfg.PLAYER_REACH_BONUS + cfg.CLASSES.soldier.radius; // 3.28
    const foe = b.newUnit('soldier', 'enemy', 0, edge - 0.04, false);
    b.grid.build(b.units);
    const onEdge = b.aimTarget();
    foe.z = edge + 0.20;
    b.grid.build(b.units);
    const outEdge = b.aimTarget();
    ok('빨간 조준점은 실제 사거리와 정확히 같은 거리에서 켜진다',
      onEdge === foe && outEdge === null, { edge: +edge.toFixed(2), on: !!onEdge, off: !!outEdge });
  }

  console.log('🔮 대마법사는 사거리가 넓어지지 않는다');
  {
    const b = new Battle({ config: {} });
    const p = b.newUnit('wizard', 'ally', 0, 0, true);
    p.yaw = 0; p.cooldown = 0; p.attackT = -1;
    b.player = p;
    const spec = cfg.CLASSES.wizard;
    /* 새 보정(0.85)이면 닿고, 예전 보정(0.45)이면 닿지 않는 지점 */
    const d = spec.reach + 0.45 + cfg.CLASSES.soldier.radius + 0.12;
    const foe = b.newUnit('soldier', 'enemy', 0, d, false);
    foe.hp = 99999; foe.maxHp = 99999;
    b.noGrowth = true;
    b.grid.build(b.units);
    b.resolveMelee(p);
    ok('대마법사 지팡이 근접은 예전 사거리 그대로 (넓어진 만큼은 안 닿는다)',
      foe.hp === foe.maxHp, { d: +d.toFixed(2), hp: foe.hp });
    ok('대마법사는 빨간 조준점 판정이 없다 (마법 버튼으로만)', b.aimTarget() === null);
  }
  ok('대마법사 마법 범위는 그대로 (화염 3.5 · 번개 17 · 빙결 7.4)',
    cfg.SPELLS.fire.radius === 3.5 && cfg.SPELLS.lightning.range === 17 && cfg.SPELLS.ice.radius === 7.4,
    { fire: cfg.SPELLS.fire.radius, lightning: cfg.SPELLS.lightning.range, ice: cfg.SPELLS.ice.radius });

  console.log('🌸 매화 일섬 — 돌진 거리 증가 · 돌진 중 무적');
  ok('돌진 거리 10.4m (7.2 → +44%)', cfg.SKILL.dash === 10.4 && cfg.SKILL.dash >= 7.2 * 1.35,
    { dash: cfg.SKILL.dash, ratio: +(cfg.SKILL.dash / 7.2).toFixed(2) });
  ok('돌진 시간도 함께 늘렸다 (0.34 → 0.40초)', cfg.SKILL.dashTime === 0.40, cfg.SKILL.dashTime);
  ok('돌진 후 잔여 무적은 0.2초', cfg.SKILL_IFRAME === 0.2, cfg.SKILL_IFRAME);

  {
    const b = new Battle({ config: {} });
    const bm = b.newUnit('blademaster', 'ally', 0, 0, true);
    bm.yaw = 0;
    const victim = b.newUnit('soldier', 'enemy', 0, 5, false);
    victim.hp = 99999; victim.maxHp = 99999;   // 돌진 참격에 죽지 않는 허수아비
    b.player = bm; b.noGrowth = true;
    b.grid.build(b.units);

    ok('매화 검객이 매화 일섬을 쓴다', b.useSkill(bm) === true && bm.dashT === 0);
    b.updateDash(bm, dt);
    const midDash = b.damage(bm, 500, victim, 'blade', 'body');
    ok('돌진하는 동안은 무적 (맞아도 피해 0)',
      midDash === 0 && bm.hp === bm.maxHp, { dmg: midDash, hp: bm.hp });

    const x0 = bm.x, z0 = bm.z;
    let guard = 0;
    while (bm.dashT >= 0 && guard++ < 600) b.updateDash(bm, dt);
    const dist = Math.hypot(bm.x - x0, bm.z - z0) + Math.hypot(x0, z0);
    ok('실제로 돌진한 거리가 예전(7.2m)보다 확실히 길다 (약 10.4m)',
      dist > 7.2 * 1.35 && Math.abs(dist - cfg.SKILL.dash) < 0.8, { dist: +dist.toFixed(2) });
    ok('돌진이 끝나면 0.2초 잔여 무적이 붙는다', bm.invulnT > 0.15 && bm.invulnT <= 0.2,
      { invulnT: +bm.invulnT.toFixed(3) });
    const afterDash = b.damage(bm, 500, victim, 'blade', 'body');
    ok('돌진 직후(0.2초 안)에도 무적', afterDash === 0 && bm.hp === bm.maxHp, { dmg: afterDash, hp: bm.hp });

    /* 공격하면 잔여 무적이 즉시 풀린다 */
    bm.attackT = -1; bm.cooldown = 0;
    const started = b.startAttack(bm);
    ok('잔여 무적 중에 베면 즉시 무적이 풀린다', started === true && bm.invulnT === 0, { invulnT: bm.invulnT });
    const afterAttack = b.damage(bm, 500, victim, 'blade', 'body');
    ok('그 뒤에는 다시 맞는다', afterAttack > 0 && bm.hp < bm.maxHp,
      { dmg: +afterAttack.toFixed(1), hp: +bm.hp.toFixed(1) });
  }

  /* 0.2초가 지나면 저절로 풀린다 (프레임 갱신 경로로 확인) */
  {
    const b = new Battle({ config: {} });
    const bm = b.newUnit('blademaster', 'ally', 0, 0, true);
    b.player = bm;
    bm.yaw = 0;
    const victim = b.newUnit('soldier', 'enemy', 0, 40, false);
    victim.hp = 99999; victim.maxHp = 99999;
    b.noGrowth = true;
    b.grid.build(b.units);
    bm.invulnT = 0.2;
    let t = 0;
    while (bm.invulnT > 0 && t < 1) { b.update(dt, {}); t += dt; }
    ok('0.2초가 지나면 잔여 무적이 저절로 풀린다', bm.invulnT === 0 && t >= 0.18 && t <= 0.30,
      { elapsed: +t.toFixed(3) });
  }

  console.log('\n솔로 밸런스 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
