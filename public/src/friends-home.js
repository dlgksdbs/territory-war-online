/* =============================================================================
   홈 화면 아래쪽 「🤝 친구와 플레이 (2~5인 국가전쟁)」 패널
   -----------------------------------------------------------------------------
   방 만들기 / 방 코드 입장 / 2~5인 대기실까지 홈에서 처리하고,
   게임이 시작되면 /friends/ 전장으로 넘어간다 (토큰은 sessionStorage 로 이어진다).
   ============================================================================= */

import { connectFriends, PRESETS, NATION_COLORS } from './friends-shared.js';

const KEY = 'friends:room';

export function initFriendsHome() {
  const root = document.getElementById('friendsPanel');
  if (!root) return;

  const $ = (id) => document.getElementById(id);
  let ws = null;
  let code = '';
  let token = '';
  let name = '';
  let capacity = 5;
  let host = -1;
  let slot = -1;
  let starting = false;

  try {
    const saved = localStorage.getItem('friends:name');
    if (saved) $('fpName').value = saved;
    const sess = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (sess && sess.code && sess.token) {
      code = sess.code;
      token = sess.token;
      showResume(true);
    }
  } catch (e) { /* noop */ }

  function showResume(on) {
    const b = $('fpResume');
    if (!b) return;
    b.classList.toggle('hidden', !on);
    if (on) b.textContent = '🔄 진행 중인 방 ' + code + ' 으로 돌아가기';
  }

  function saveSession() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ code, token, name }));
      localStorage.setItem('friends:name', name);
    } catch (e) { /* noop */ }
  }

  function connect() {
    if (ws) return;
    ws = connectFriends({
      onOpen: () => { $('fpStatus').textContent = ''; },
      onClose: () => {
        ws = null;
        $('fpStatus').textContent = '연결이 끊겼어요. 다시 시도해 주세요.';
      },
      onMessage: handle
    });
  }

  function send(obj) {
    connect();
    if (ws) ws.send(obj);
  }

  function handle(m) {
    if (!m || !m.type) return;
    if (m.type === 'joined') {
      code = m.code; token = m.token; slot = m.slot; name = m.name; host = 0;
      saveSession();
      showResume(false);
      showWait(true);
      $('fpStatus').textContent = '';
      return;
    }
    if (m.type === 'flobby') {
      host = m.host;
      capacity = m.capacity || capacity;
      renderPlayers(m.players || []);
      showWait(true);
      return;
    }
    if (m.type === 'fstate') {
      if (m.phase && m.phase !== 'lobby') {
        starting = true;
        goGame();
      }
      return;
    }
    if (m.type === 'error') {
      $('fpStatus').textContent = m.message || '요청을 처리하지 못했어요.';
      return;
    }
    if (m.type === 'left') {
      code = ''; token = '';
      try { sessionStorage.removeItem(KEY); } catch (e) { /* noop */ }
      showWait(false);
      showResume(false);
    }
  }

  function goGame() {
    const url = '/friends/?code=' + encodeURIComponent(code || '');
    location.href = url;
  }

  function showWait(on) {
    $('fpSetup').classList.toggle('hidden', on);
    $('fpWait').classList.toggle('hidden', !on);
    $('fpWaitCode').textContent = code || '----';
  }

  function renderPlayers(list) {
    const box = $('fpPlayers');
    box.innerHTML = '';
    for (let i = 0; i < capacity; i++) {
      const p = list[i];
      const d = document.createElement('div');
      d.className = 'fp-player' + (p ? '' : ' empty');
      if (p) {
        d.innerHTML = '<i style="background:' + NATION_COLORS[i % NATION_COLORS.length] + '"></i>' +
          '<b>' + escapeHtml(p.name) + '</b>' + (p.host ? '<span>👑</span>' : '');
      } else {
        d.innerHTML = '<i style="background:#33465e"></i><b>빈 자리 (AI)</b>';
      }
      box.appendChild(d);
    }
    $('fpStart').disabled = slot !== host;
    $('fpStart').textContent = slot === host ? '게임 시작' : '방장이 시작하길 기다리는 중';
    $('fpHint').textContent = list.length < 2
      ? '친구를 기다리는 중 · AI로 채우면 혼자서도 시작할 수 있어요'
      : list.length + '명 입장 · 시작하면 성과 성벽이 세워집니다';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* 인원 선택 */
  root.querySelectorAll('#fpCap button').forEach((b) => {
    b.addEventListener('click', () => {
      capacity = Number(b.dataset.cap) || 5;
      root.querySelectorAll('#fpCap button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });

  $('fpCreate').addEventListener('click', () => {
    name = ($('fpName').value || '').trim().slice(0, 12) || '지휘관';
    $('fpStatus').textContent = '방을 만드는 중…';
    send({ type: 'create', mode: 'castle', name, capacity, aiFill: $('fpAi').checked });
  });

  $('fpJoin').addEventListener('click', () => {
    name = ($('fpName').value || '').trim().slice(0, 12) || '지휘관';
    const c = ($('fpCode').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) { $('fpStatus').textContent = '방 코드를 확인해 주세요.'; return; }
    send({ type: 'join', code: c, name });
  });

  $('fpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fpJoin').click(); });

  $('fpStart').addEventListener('click', () => {
    $('fpStatus').textContent = '전장을 준비하는 중…';
    send({ type: 'start' });
  });

  $('fpLeave').addEventListener('click', () => {
    send({ type: 'leave' });
    code = ''; token = '';
    try { sessionStorage.removeItem(KEY); } catch (e) { /* noop */ }
    showWait(false);
    showResume(false);
  });

  const resumeBtn = $('fpResume');
  if (resumeBtn) resumeBtn.addEventListener('click', goGame);

  $('fpCopy').addEventListener('click', () => {
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).catch(() => { /* noop */ });
    }
    $('fpStatus').textContent = '방 코드 ' + code + ' 복사됨';
  });

  /* 전장이 이미 시작된 방이면 자동으로 들어가지 않고 알려 준다 */
  window.addEventListener('pagehide', () => { if (ws) ws.close(); });
  window.__fpInit = true;
}
