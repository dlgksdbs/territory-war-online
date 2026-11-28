'use strict';

/* =============================================================================
   🔑 솔로 전장 리딤코드 테스트 (2026-11-28 사용자 요청)
   -----------------------------------------------------------------------------
   · 코드 2012 만 통과, 잘못된 코드는 잠금 유지
   · 한 번 해금하면 localStorage 에 남아 새로고침·재접속 후에도 열려 있다
   · 해금 상태를 지우면 다시 잠긴다
   실행: node test/redeem.js   (npm test 에 포함)
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

/* localStorage 대역 */
function fakeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => Object.fromEntries(m)
  };
}

(async () => {
  const R = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'src', 'redeem.js')).href);
  console.log('🔑 리딤코드 — 솔로 전장 잠금');

  ok('리딤코드는 2012', R.SOLO_CODE === '2012', R.SOLO_CODE);
  ok('저장 키는 ba.soloUnlocked.v1', R.SOLO_UNLOCK_KEY === 'ba.soloUnlocked.v1', R.SOLO_UNLOCK_KEY);
  ok('2012 는 통과 (앞뒤 공백 무시)', R.isValidSoloCode('2012') && R.isValidSoloCode(' 2012 '));
  ok('다른 코드는 거절', ['201', '2013', '20120', 'code', '', null, undefined].every((v) => !R.isValidSoloCode(v)),
    ['201', '2013', '20120', 'code', '']);

  const st = fakeStorage();
  ok('처음에는 잠겨 있다', R.loadSoloUnlocked(st) === false);
  ok('해금 저장 → 새로고침 후에도 열려 있다', R.saveSoloUnlocked(st, true) === true &&
    st.getItem('ba.soloUnlocked.v1') === '1' && R.loadSoloUnlocked(st) === true, st._dump());
  ok('저장된 값이 1 이 아니면 잠금', R.loadSoloUnlocked(fakeStorage({ 'ba.soloUnlocked.v1': '0' })) === false);
  ok('해금을 지우면 다시 잠긴다', R.saveSoloUnlocked(st, false) === true && R.loadSoloUnlocked(st) === false);
  ok('저장소가 없어도 죽지 않는다', R.loadSoloUnlocked(null) === false || true);
  ok('저장소가 망가져도 잠금으로 안전하게', R.loadSoloUnlocked({ getItem() { throw new Error('quota'); } }) === false);

  console.log('\n리딤코드 테스트 통과 · ' + passed + '개');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
