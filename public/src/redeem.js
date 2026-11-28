/* =============================================================================
   redeem.js — 🔑 솔로 전장 리딤코드 (순수 모듈 · DOM 없이도 돌아간다 · npm test 대상)
   -----------------------------------------------------------------------------
   2026-11-28 사용자 요청:
     "솔로전장은 리딤코드 만들어서 그거 사용한 사람만 쓸 수 있게. 코드는 2012"
   · 코드가 맞으면 해금하고 localStorage 에 남긴다 → 새로고침·재접속·재배포 후에도 유지
   · PVP 는 이 잠금과 무관하다 (누구나 바로 이용)
   ============================================================================= */

export const SOLO_CODE = '2012';
export const SOLO_UNLOCK_KEY = 'ba.soloUnlocked.v1';

/* 🔑 화면에는 어떤 안내문도 쓰지 않는다 (코드 노출 금지) — 아래 문자열은 내부용 기본값뿐이다. */
export const SOLO_LOCK_NOTE = '';
export const SOLO_OPEN_NOTE = '';
export const SOLO_BAD_NOTE = '';

/* 입력 코드가 맞는지 — 앞뒤 공백은 무시한다 */
export function isValidSoloCode(raw) {
  return String(raw == null ? '' : raw).trim() === SOLO_CODE;
}

/* 저장된 해금 상태 읽기 (저장소가 없거나 막혀 있으면 잠금) */
export function loadSoloUnlocked(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    return !!s && s.getItem(SOLO_UNLOCK_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/* 해금 상태 저장 — 실패해도 이번 세션은 열린 채로 쓸 수 있게 조용히 넘어간다 */
export function saveSoloUnlocked(storage, on) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s) return false;
    if (on) s.setItem(SOLO_UNLOCK_KEY, '1');
    else s.removeItem(SOLO_UNLOCK_KEY);
    return true;
  } catch (e) {
    return false;
  }
}
