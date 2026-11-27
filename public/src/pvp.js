/* =============================================================================
   pvp.js — 플레이어 PVP (실시간 1인칭 대전) 클라이언트
   -----------------------------------------------------------------------------
   · 홈의 「⚔️ 플레이어 PVP」 패널 → 방 만들기 / 방 코드 입장 → 대기실
   · 대기실: 팀(아군·적군·자동) · 병종 6종 · 방장이 승리 조건과 AI 병력 수 설정
   · 전투: 서버가 권위. 내 위치·시선·행동을 보내고, 서버가 실제 타격을 판정한다.
       - 상대는 선택한 병종의 풀 디테일 3D 모델 + 이름표 + 팀 색 + 체력바
       - 공격/막기/피격/사망 모션, 검기·피·불꽃·사운드는 배틀 아레나 그대로
   · 서버 이벤트(phit/pblock/pdeath …)를 배틀 아레나의 이펙트 이벤트로 옮겨 재생
   ============================================================================= */
import * as THREE from 'three';
import { CLASSES, SPELLS, SKILL, TEAM } from './config.js';
import { clamp, angLerp, angDiff } from './util.js';
import { clampOctagon } from './ground.js';

const $ = (s) => document.querySelector(s);
const PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const NAME_KEY = 'ba.pvp.name';
const MAX_PLATES = 28;

const clsIcon = (c) => (CLASSES[c] && CLASSES[c].icon) || '⚔️';
const clsName = (c) => (CLASSES[c] && CLASSES[c].name) || '병사';

export class PvpClient {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.inLobby = false;
    this.inBattle = false;
    this.you = -1;
    this.code = '';
    this.name = '';
    this.token = null;
    this.lobby = null;
    this.roster = [];
    this.units = new Map();        // 서버 id(slot | 'b..') -> 로컬 battle unit
    this.plates = new Map();       // 서버 id -> DOM 이름표
    this.me = null;
    this.myTeam = 'ally';
    this.myCls = 'soldier';
    this.mode = 'kills';
    this.killTarget = 10;
    this.score = { ally: 0, enemy: 0 };
    this.left = 0;
    this.phase = 'lobby';
    this.skew = null;
    this.lastState = null;
    this.lastStateAt = 0;
    this.inputAt = 0;
    this.lastGuard = false;
    /* 🛡️ PVP 전용 검 막기 — 최대 유지 + 쿨타임 (서버 pstart 값으로 맞춘다) */
    this.guardHoldMax = 0.8;
    this.guardCdMax = 2.0;
    this.guardReflect = 1.0;
    this.guardActive = false;
    this.guardLeft = 0;
    this.guardCd = 0;
    this.guardSent = false;
    this.octagon = { apothem: 15 };
    this.stats = { hits: 0, blocks: 0, kills: 0, deaths: 0, reflected: 0 };
    this.blockLog = [];           // 🛡️ 최근 패링 기록 (테스트·디버그)
    this._staleWarned = false;
    this._nameTags = null;
    this._restoreName();
    this._bindUI();
  }

  /* ------------------------------------------------------------------ 공통 */
  _toast(msg) { if (this.app && this.app._toast) this.app._toast(msg); }

  _restoreName() {
    try {
      const n = localStorage.getItem(NAME_KEY);
      if (n) { const el = $('#pvpName'); if (el) el.value = n; }
    } catch (e) { /* 저장소 없음 */ }
  }

  _saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* noop */ }
  }

  _nick() {
    const el = $('#pvpName');
    let n = (el && el.value ? el.value : '').trim();
    if (!n) {
      n = '전사' + Math.floor(100 + Math.random() * 900);
      if (el) el.value = n;
    }
    n = n.replace(/\s+/g, ' ').slice(0, 10);
    this._saveName(n);
    return n;
  }

  _bindUI() {
    const mk = $('#pvpMake');
    if (mk) mk.addEventListener('click', () => this.create());
    const jn = $('#pvpJoin');
    if (jn) jn.addEventListener('click', () => this.join());
    const code = $('#pvpCode');
    if (code) {
      code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    }
    const nm = $('#pvpName');
    if (nm) nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.create(); });

    const lobby = $('#pvpLobby');
    if (lobby) {
      lobby.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.id === 'plLeave') return this.exitToHome();
        if (b.id === 'plStart') return this.startBattle();
        const team = b.dataset.team;
        if (team) return this.send({ type: 'pteam', team });
        const cls = b.dataset.cls;
        if (cls) return this.send({ type: 'pclass', cls });
        const mode = b.dataset.mode;
        if (mode) {
          if (mode === 'elim') return this.send({ type: 'pconf', mode: 'elim' });
          return this.send({ type: 'pconf', mode: 'kills', killTarget: mode === 'kills20' ? 20 : 10 });
        }
        const bots = b.dataset.bots;
        if (bots !== undefined) {
          const n = Number(bots) || 0;
          return this.send({ type: 'pconf', bots: { ally: n, enemy: n } });
        }
      });
    }

    const prAgain = $('#prAgain');
    if (prAgain) prAgain.addEventListener('click', () => this.rematch());
    const prHome = $('#prHome');
    if (prHome) prHome.addEventListener('click', () => this.exitToHome());
  }

  /* ------------------------------------------------------------------ 연결 */
  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(PROTO + '//' + location.host + '/ws'); } catch (e) { reject(e); return; }
      this.ws = ws;
      const fail = (e) => { if (this.ws === ws) this.ws = null; reject(e || new Error('연결 실패')); };
      const to = setTimeout(() => fail(new Error('서버 응답 없음')), 8000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(ws); });
      ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.onMessage(m);
      });
      ws.addEventListener('error', () => fail(new Error('연결 오류')));
      ws.addEventListener('close', () => {
        clearTimeout(to);
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.inBattle) {
          this.inBattle = false;
          this._toast('서버와 연결이 끊겼어요');
          if (this.app && this.app.toHome) this.app.toHome();
        } else if (this.inLobby) {
          this.inLobby = false;
          this.hideLobby();
          this._toast('서버와 연결이 끊겼어요');
        }
      });
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  async create() {
    const name = this._nick();
    try {
      await this.connect();
    } catch (e) { this._toast('서버에 연결할 수 없어요'); return; }
    this.name = name;
    this.send({ type: 'create', name, mode: 'pvp' });
  }

  async join() {
    const codeEl = $('#pvpCode');
    const code = (codeEl ? codeEl.value : '').trim().toUpperCase();
    if (code.length < 4) { this._toast('방 코드를 입력해 주세요'); if (codeEl) codeEl.focus(); return; }
    const name = this._nick();
    try {
      await this.connect();
    } catch (e) { this._toast('서버에 연결할 수 없어요'); return; }
    this.name = name;
    this.send({ type: 'join', name, code });
  }

  /* ------------------------------------------------------------------ 메시지 */
  onMessage(m) {
    switch (m.type) {
      case 'joined':
        this.you = m.slot;
        this.code = m.code;
        this.token = m.token;
        this.inLobby = true;
        this.showLobby();
        break;
      case 'plobby':
        this.lobby = m;
        this.you = m.you != null ? m.you : this.you;
        this.renderLobby(m);
        break;
      case 'pstart':
        this.beginBattle(m);
        break;
      case 'pstate':
        this.applyState(m);
        break;
      case 'phit':
        this.onHit(m);
        break;
      case 'pblock':
        this.onBlock(m);
        break;
      case 'pguardend':
        this.onGuardEnd(m);
        break;
      case 'pdeath':
        this.onDeath(m);
        break;
      case 'prespawn':
        this.onRespawn(m);
        break;
      case 'pswing':
        this.onSwing(m);
        break;
      case 'pspellfx':
        this.onSpellCast(m);
        break;
      case 'pfire':
        this.onRemoteFire(m);
        break;
      case 'pboom':
        this.onBoom(m);
        break;
      case 'pbolt':
        this.onBolt(m);
        break;
      case 'pice':
        this.onIce(m);
        break;
      case 'pskill':
        this.onPetal(m);
        break;
      case 'pover':
        this.onOver(m);
        break;
      case 'error':
        if (this.inLobby && !this.inBattle) this.renderLobbyError(m);
        this._toast(m.message || '요청을 처리하지 못했어요');
        break;
      case 'left':
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ 대기실 */
  showLobby() {
    const el = $('#pvpLobby');
    if (!el) return;
    el.classList.add('is-on');
    el.setAttribute('aria-hidden', 'false');
    this.app.paused = true;
  }

  hideLobby() {
    const el = $('#pvpLobby');
    if (!el) return;
    el.classList.remove('is-on');
    el.setAttribute('aria-hidden', 'true');
    if (this.app.state === 'home') this.app.paused = false;
  }

  renderLobbyError(m) {
    const n = $('#plNote');
    if (n) n.textContent = m.message || '다시 시도해 주세요';
  }

  renderLobby(l) {
    const codeEl = $('#plCode');
    if (codeEl) codeEl.textContent = '방 코드 ' + l.code;
    const host = l.host;
    const me = l.you;
    const list = (team) => l.players.filter((p) => p.team === team);
    const chip = (p) => (
      '<div class="pl-chip' + (p.slot === me ? ' me' : '') + (p.connected ? '' : ' off') + '">' +
        (p.slot === host ? '<span class="crown">👑</span>' : '') +
        '<span class="ci">' + clsIcon(p.cls) + '</span>' +
        '<span class="nm">' + escapeHtml(p.name) + (p.slot === me ? ' (나)' : '') + '</span>' +
        '<span class="dot' + (p.connected ? '' : ' off') + '"></span>' +
      '</div>'
    );
    const auto = l.players.filter((p) => p.team !== 'ally' && p.team !== 'enemy');
    const fill = (sel, arr, empty) => {
      const el = $(sel);
      if (!el) return;
      el.innerHTML = arr.length ? arr.map(chip).join('') : '<div class="pl-empty">' + empty + '</div>';
    };
    fill('#plAllyList', list('ally'), '아군 자리 비어 있음');
    fill('#plEnemyList', list('enemy'), '적군 자리 비어 있음');
    fill('#plAutoList', auto, '없음 (시작할 때 자동 배정)');
    const allyN = list('ally').length + (l.bots ? l.bots.ally : 0);
    const enemyN = list('enemy').length + (l.bots ? l.bots.enemy : 0);
    const an = $('#plAllyN'); if (an) an.textContent = allyN;
    const en = $('#plEnemyN'); if (en) en.textContent = enemyN;

    const mine = l.players.find((p) => p.slot === me);
    document.querySelectorAll('#plTeamBtns button').forEach((b) => {
      const t = b.dataset.team;
      const on = mine ? (t === 'auto' ? (!mine.team) : mine.team === t) : false;
      b.classList.toggle('is-on', !!on);
    });
    /* ⚔️ PVP 병종은 일반 병사 고정 — 다른 병종 버튼은 잠근다 */
    const fixed = l.fixedClass || 'soldier';
    document.querySelectorAll('#plClassBtns button').forEach((b) => {
      const locked = b.dataset.cls !== fixed;
      b.disabled = locked;
      b.classList.toggle('is-locked', locked);
      b.classList.toggle('is-on', !locked && (!mine || b.dataset.cls === mine.cls));
      b.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
    const clsNote = $('#plClassNote');
    if (clsNote) clsNote.textContent = '일반 병사 고정 (검 막기 대전)';
    document.querySelectorAll('#plModeBtns button').forEach((b) => {
      const m = b.dataset.mode;
      const on = m === 'elim' ? l.mode === 'elim' : (l.mode === 'kills' && l.killTarget === (m === 'kills20' ? 20 : 10));
      b.classList.toggle('is-on', !!on);
    });
    document.querySelectorAll('#plBotBtns button').forEach((b) => {
      const n = Number(b.dataset.bots) || 0;
      b.classList.toggle('is-on', !!l.bots && l.bots.ally === n && l.bots.enemy === n);
    });
    const conf = $('#plConf');
    if (conf) conf.classList.toggle('pl-conf-disabled', me !== host);
    const start = $('#plStart');
    if (start) {
      start.disabled = me !== host;
      start.textContent = me === host ? '⚔️ 대전 시작' : '방장이 시작하기를 기다리는 중…';
    }
    const note = $('#plNote');
    if (note) {
      note.textContent = me === host
        ? '일반 병사 고정 · 검 막기는 최대 0.8초, 풀면 2초 쿨타임 · 막아내면 상대에게 피해 100% 반사'
        : '방장이 시작하면 자동으로 옥타곤 링에 들어간다';
    }
    this.myTeam = mine && mine.team ? mine.team : 'ally';
    this.myCls = mine ? mine.cls : 'soldier';
  }

  startBattle() {
    if (!this.lobby || this.you !== this.lobby.host) return;
    this.send({ type: 'pstart' });
  }

  rematch() {
    if (!this.inBattle) return;
    this.send({ type: 'prematch' });
    const note = $('#prNote');
    if (note) note.textContent = '방장이 다시 시작하면 이어집니다';
  }

  exitToHome() {
    if (this.ws && this.ws.readyState === 1 && (this.inLobby || this.inBattle)) {
      this.send({ type: 'leave' });
    }
    this.resetGuard();
    this.inLobby = false;
    this.inBattle = false;
    this.hideLobby();
    this.clearUnits();
    this.hideResult();
    if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } this.ws = null; }
    const battleEl = $('#battle');
    if (battleEl) battleEl.classList.remove('is-pvp');
    this.app.toHome();
  }

  /* ------------------------------------------------------------------ 전장 시작 */
  clearUnits() {
    for (const [, u] of this.units) { u.removed = true; u.hideModel = true; }
    this.units.clear();
    for (const [, el] of this.plates) el.remove();
    this.plates.clear();
    this.me = null;
    this.roster = [];
  }

  beginBattle(msg) {
    this.inLobby = false;
    this.inBattle = true;
    this.hideLobby();
    this.hideResult();
    this.you = msg.you;
    this.myTeam = msg.team;
    this.myCls = msg.cls;
    this.mode = msg.mode;
    this.killTarget = msg.killTarget;
    this.score = { ally: 0, enemy: 0 };
    this.phase = 'battle';
    this.left = Math.round((msg.roundMs || 180000) / 1000);
    this.stats = { hits: 0, blocks: 0, kills: 0, deaths: 0 };
    this.skew = null;
    this.lastState = null;
    this._staleWarned = false;
    /* 서버가 정한 막기·링 규칙을 그대로 쓴다 */
    const gd = msg.guard || {};
    this.guardHoldMax = gd.hold ? gd.hold / 1000 : 0.8;
    this.guardCdMax = gd.cooldown ? gd.cooldown / 1000 : 2.0;
    this.guardReflect = gd.reflect === undefined ? 1 : gd.reflect;
    if (msg.arena && msg.arena.apothem) this.octagon = { apothem: msg.arena.apothem };
    this.guardActive = false;
    this.guardLeft = 0;
    this.guardCd = 0;
    this.guardSent = false;
    this.app.input.guard = false;
    this.clearUnits();
    this.roster = msg.roster || [];
    this.app.enterPvpBattle(msg);
  }

  /* 내가 만든/남의 유닛 등록 — 서버 id로 찾을 수 있게 */
  addUnit(r) {
    const b = this.app.battle;
    if (!b) return null;
    const u = b.newUnit(r.cls, r.team, 0, 0, false);
    u.net = true;
    u.netId = r.s;
    u.pname = r.name;
    u.forceDetail = !r.bot;
    u.bot = !!r.bot;
    u.team = r.team;
    u.hideModel = false;
    this.units.set(r.s, u);
    if (this.app.unitRenderer) this.app.unitRenderer.addUnit(u, r.cls);
    return u;
  }

  unitOf(id) {
    if (id === null || id === undefined) return null;
    if (id === this.you) return this.app.battle ? this.app.battle.player : null;
    return this.units.get(id) || null;
  }

  /* 이름표 DOM */
  buildPlates() {
    let host = $('#pvpNames');
    if (!host) return;
    if (this._nameTags !== host) {
      host.innerHTML = '';
      this._nameTags = host;
      this.plates.clear();
    }
    for (const r of this.roster) {
      if (r.s === this.you) continue;
      if (this.plates.has(r.s)) continue;
      if (this.plates.size >= MAX_PLATES) break;
      const el = document.createElement('div');
      el.className = 'pn-plate ' + (r.team === 'ally' ? 'ally' : 'enemy');
      el.innerHTML = '<span class="pn-name"><i>' + clsIcon(r.cls) + '</i>' + escapeHtml(r.name) + '</span>' +
        '<span class="pn-hp"><i></i></span>';
      host.appendChild(el);
      this.plates.set(r.s, el);
    }
  }

  /* ------------------------------------------------------------------ 상태 적용 */
  applyState(m) {
    if (!this.inBattle) return;
    const now = Date.now();
    this.lastState = m;
    this.lastStateAt = now;
    this._staleWarned = false;
    this.phase = m.phase;
    this.score = m.score || this.score;
    this.left = m.left;
    this.me = m.me;
    const skew = now - m.t;
    this.skew = this.skew === null ? skew : (skew < this.skew ? skew : this.skew + (skew - this.skew) * 0.06);
    if (m.me) this.applyMe(m.me);
    for (const e of m.ents || []) {
      if (e.s === this.you) continue;
      const u = this.units.get(e.s);
      if (!u) continue;
      this.applyRemote(u, e);
    }
    this.updateScore(false);
  }

  applyMe(e) {
    const b = this.app.battle;
    if (!b) return;
    const p = b.player;
    if (!p) return;
    p.maxHp = e.mx;
    if (!e.d) {
      if (p.dead) this.reviveMe(e);
      p.hp = e.hp;
      /* 서버와 크게 벌어졌을 때만 위치를 되돌린다 (부활·순간이동) */
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d > 2.6) {
        p.x = e.x; p.z = e.z;
        p.yaw = e.w;
        this.app.camYaw = p.yaw + Math.PI;
      }
      /* 서버 상태와 막기 상태기계를 맞춘다 (쿨타임은 서버가 더 길면 따른다) */
      if (!this.guardActive) p.guard = !!e.g;
      if (e.gc) this.guardCd = Math.max(this.guardCd, e.gc / 1000);
      if (this.guardActive && e.gl) this.guardLeft = Math.min(this.guardLeft, e.gl / 1000 + 0.05);
      p.freezeT = e.fz ? e.fz / 1000 : 0;
      if (p.freezeT > 0.02) { this.app.input.mx = 0; this.app.input.mz = 0; }
    } else if (!p.dead) {
      this.killMe(e);
    } else {
      p.deadT = Math.max(0, (this.serverNow() - e.dd) / 1000);
    }
  }

  serverNow() { return Date.now() - (this.skew || 0); }

  killMe(e) {
    const b = this.app.battle;
    const p = b.player;
    if (!p || p.dead) return;
    this.stats.deaths += 1;
    b.kill(p, null, 'blade');
    p.hideModel = false;
    this.app.attackHeld = false;
    this.app.input.attack = false;
    this.resetGuard();
    const veil = $('#deadVeil');
    if (veil) veil.classList.add('is-on');
  }

  reviveMe(e) {
    const b = this.app.battle;
    const p = b.player;
    p.dead = false; p.deadT = 0; p.corpseT = 0; p.removed = false;
    p.hp = e.hp; p.maxHp = e.mx;
    p.x = e.x; p.z = e.z; p.yaw = e.w;
    p.attackT = -1; p.cooldown = 0.35; p.staggerT = 0; p.freezeT = 0;
    p.dashT = -1; p.dashHit = null; p.guard = false;
    p.cd = { fire: 0, lightning: 0, ice: 0, petal: 0 };
    p.behead = false; p.deathKind = null;
    p.severed = { armL: 0, armR: 0, legL: 0, legR: 0, head: 0 };
    p.armsLost = 0; p.legsLost = 0; p.sevMask = 0;
    b.playerDeadT = 0;
    this.app.camYaw = p.yaw + Math.PI;
    if (!b.units.includes(p)) { b.units.push(p); b.byId.set(p.id, p); b.buildOrder(); }
    const veil = $('#deadVeil');
    if (veil) veil.classList.remove('is-on');
  }

  applyRemote(u, e) {
    const p = this.app.battle.player;
    if (e.s !== this.you) {
      u.tx = e.x; u.tz = e.z; u.tyaw = e.w;
      if (u.x === 0 && u.z === 0) { u.x = e.x; u.z = e.z; u.yaw = e.w; }
      u.hp = e.hp;
      u.maxHp = e.mx;
      u.team = e.tm;
      u.guard = !!e.g;
      u.freezeT = e.fz ? e.fz / 1000 : 0;
      if (u.cls !== e.c) {
        /* 병종은 대기실에서 정해지고 전투 중에는 바뀌지 않는다 */
      }
      const serverNow = this.serverNow();
      if (e.d) {
        if (!u.dead) {
          u.dead = true;
          u.deadT = 0;
          u.hp = 0;
          u.attackT = -1;
          u.dashT = -1;
        }
        u.deadT = Math.max(0, (serverNow - (e.dd || serverNow)) / 1000);
      } else {
        if (u.dead) { u.dead = false; u.deadT = 0; u.corpseT = 0; u.removed = false; u.hideModel = false; }
        u.hp = e.hp;
        u.dead = false;
        if (e.a) {
          const t = (serverNow - e.a) / 1000;
          const cyc = u.cycle || (CLASSES[u.cls] ? CLASSES[u.cls].cycle : 0.8);
          u.attackT = t >= 0 && t <= cyc * 1.06 ? t : -1;
        } else {
          u.attackT = -1;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ 이벤트 */
  onHit(m) {
    const b = this.app.battle;
    if (!b) return;
    const src = this.unitOf(m.by);
    const tgt = this.unitOf(m.to);
    if (!tgt) return;
    if (m.by === this.you) this.stats.hits += 1;
    if (m.lethal && m.by === this.you) this.stats.kills += 1;
    b.emit({
      type: 'hit', source: src || null, target: tgt, dmg: m.dmg, kind: m.kind || 'blade',
      part: 'body', lethal: !!m.lethal, hx: m.hx, hz: m.hz, hy: m.hy || 1.1, angle: m.angle || 0
    });
    /* ⚔️ 반사 피해 — 내가 공격했다가 막혀 되돌아온 타격 */
    if (m.kind === 'reflect') {
      this.reflectT = 0.5;
      this._toast('⚔️ 막혔다! 검에 튄 피해 ' + Math.round(m.dmg) + ' 가 나에게');
      this.app.fx && this.app.fx.addShake(0.30);
      this.app.fx && this.app.fx.flash(m.hx, (m.hy || 1.1), m.hz, 1.5, 0xffd9a0, 0.14);
    }
  }

  onBlock(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.to);
    if (!u) return;
    if (m.to === this.you) this.stats.blocks += 1;
    const reflect = m.reflect || 0;
    if (m.to === this.you) {
      this.stats.reflected += reflect;
      this.blockLog.push({ at: Date.now(), by: m.by, reflect, hp: Math.round(this.app.battle.player.hp) });
      if (this.blockLog.length > 6) this.blockLog.shift();
    }
    b.emit({ type: 'block', unit: u, source: this.unitOf(m.by), heavy: !!m.heavy, x: m.x, z: m.z, y: m.y || 1.2, dmg: 0, reflect });
    /* 🛡️ 패링 100% 반사 — 막은 사람 화면에 금빛 쾅 + 토스트
       (불티·섬광·충격파 자체는 main.js 의 block 이벤트 연출이 그린다 — 중복 재생 금지) */
    if (reflect > 0 && m.to === this.you) {
      this._toast('⚔️ 패링! ' + Math.round(reflect) + ' 피해를 그대로 돌려줬다');
    }
  }

  onDeath(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.to);
    if (!u) return;
    if (m.to === this.you) return;      // 내 사망은 pstate의 d 로 처리 (부활 시점 포함)
    if (!u.dead) {
      u.dead = true; u.hp = 0; u.deadT = 0; u.attackT = -1; u.dashT = -1; u.guard = false;
      b.emit({ type: 'death', unit: u, by: this.unitOf(m.by), kind: m.kind || 'blade', behead: false });
    }
  }

  onRespawn(m) {
    const b = this.app.battle;
    if (!b) return;
    if (m.to === this.you) {
      const me = { x: m.x, z: m.z, w: m.yaw, hp: m.hp, mx: m.mx, d: false };
      if (b.player.dead) this.reviveMe(me);
      b.player.x = m.x; b.player.z = m.z; b.player.hp = m.hp;
      b.player.yaw = m.yaw;
      this.app.camYaw = m.yaw + Math.PI;
      return;
    }
    const u = this.units.get(m.to);
    if (!u) return;
    u.dead = false; u.deadT = 0; u.corpseT = 0; u.removed = false; u.hideModel = false;
    u.hp = m.hp; u.maxHp = m.mx;
    u.x = m.x; u.z = m.z; u.tx = m.x; u.tz = m.z; u.yaw = m.yaw; u.tyaw = m.yaw;
    u.attackT = -1;
  }

  onSwing(m) {
    const u = this.unitOf(m.s);
    if (!u || u === this.app.battle.player) return;
    if (!u.dead) u.attackT = 0;
  }

  onSpellCast(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.by);
    if (!u) return;
    b.emit({ type: 'cast', unit: u, spell: m.spell });
  }

  onRemoteFire(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.by);
    if (!u) return;
    const dx = m.x - u.x, dz = m.z - u.z;
    const dist = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    u.yaw = yaw;
    b.spells.push({
      kind: 'fire', src: u, team: u.team, key: 'fire',
      x: u.x + Math.sin(yaw) * 1.0, z: u.z + Math.cos(yaw) * 1.0, y: 1.35,
      vx: Math.sin(yaw) * 24, vz: Math.cos(yaw) * 24,
      life: Math.max(0.12, dist / 24), maxLife: Math.max(0.12, dist / 24),
      tx: m.x, tz: m.z
    });
  }

  onBoom(m) {
    const b = this.app.battle;
    if (!b) return;
    const src = this.unitOf(m.by);
    b.emit({ type: 'explode', x: m.x, z: m.z, radius: m.radius || SPELLS.fire.radius, dmg: m.n || 0, src });
    this.app.fx && this.app.fx.addShake(0.2);
  }

  onBolt(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.by);
    const targets = (m.targets || []).map((id) => ({ o: this.unitOf(id), dmg: 0, lethal: false })).filter((t) => t.o);
    if (!u || !targets.length) return;
    b.emit({ type: 'lightning', unit: u, targets });
    if (this.app.sfx) this.app.sfx.spell('lightning', 0);
  }

  onIce(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.by);
    if (!u) return;
    u.yaw = m.yaw;
    const targets = (m.targets || []).map((id) => ({ o: this.unitOf(id), dmg: 0, lethal: false })).filter((t) => t.o);
    b.emit({ type: 'ice', unit: u, targets, radius: m.radius || SPELLS.ice.radius, halfAngle: m.halfAngle || SPELLS.ice.halfAngle });
  }

  onPetal(m) {
    const b = this.app.battle;
    if (!b) return;
    const u = this.unitOf(m.by);
    if (!u) return;
    b.emit({ type: 'petalDash', unit: u, x: m.x, z: m.z, yaw: m.yaw });
    if (u !== b.player && this.app.sfx) this.app.sfx.spell('ice', 0);
  }

  onOver(m) {
    this.phase = 'over';
    this.score = m.score || this.score;
    this.showResult(m);
  }

  /* ------------------------------------------------------------------ 결과 */
  showResult(m) {
    const el = $('#pvpResult');
    if (!el) return;
    const won = m.winner === this.myTeam;
    const draw = m.winner === 'draw';
    el.classList.toggle('lose', !won && !draw);
    const title = $('#prTitle');
    if (title) title.textContent = draw ? '무승부' : won ? '승리' : '패배';
    const em = $('#prEmblem');
    if (em) em.textContent = draw ? '🤝' : won ? '🏆' : '💀';
    const sub = $('#prSub');
    if (sub) {
      sub.textContent = m.reason === 'target'
        ? (won ? '목표 킬을 먼저 채웠다' : '상대가 목표 킬을 먼저 채웠다')
        : m.reason === 'wipe'
          ? (won ? '상대 팀을 전멸시켰다' : '아군이 전멸했다')
          : (draw ? '제한 시간 종료 — 동점' : '제한 시간 종료 — 킬 수 우세');
    }
    const a = $('#prAlly'); if (a) a.textContent = (m.score && m.score.ally) || 0;
    const b = $('#prEnemy'); if (b) b.textContent = (m.score && m.score.enemy) || 0;
    const k = $('#prKills'); if (k) k.textContent = this.me ? this.me.k : this.stats.kills;
    const d = $('#prDeaths'); if (d) d.textContent = this.me ? this.me.dt : this.stats.deaths;
    const c = $('#prCls'); if (c) c.textContent = clsIcon(this.myCls);
    const again = $('#prAgain');
    const isHost = this.lobby ? this.lobby.host === this.you : true;
    if (again) { again.disabled = !isHost; again.textContent = isHost ? '다시 하기' : '방장 대기'; }
    const note = $('#prNote');
    if (note) note.textContent = isHost ? '다시 하기를 누르면 같은 팀·병종으로 새 라운드' : '방장이 다시 시작할 수 있다';
    el.classList.add('is-on');
    this.app.paused = true;
    this.app.attackHeld = false;
    this.app.input.attack = false;
    this.resetGuard();
  }

  /* 막기 상태를 조용히 되돌린다 (사망·라운드 종료·퇴장) */
  resetGuard() {
    this.guardActive = false;
    this.guardLeft = 0;
    this.guardSent = false;
    this.guardCd = 0;
    this.app.input.guard = false;
    const b = this.app.battle;
    if (b && b.player) b.player.guard = false;
    const gb = document.getElementById('guardBtn');
    if (gb) gb.classList.remove('is-held');
  }

  hideResult() {
    const el = $('#pvpResult');
    if (el) el.classList.remove('is-on');
  }

  /* ------------------------------------------------------------------ 로컬 행동 */
  sendAttack(battlePlayer) {
    const p = battlePlayer || (this.app.battle && this.app.battle.player);
    if (!p || this.phase !== 'battle') return;
    this.send({ type: 'pattack', yaw: p.yaw });
  }

  castSpell(key) {
    const b = this.app.battle;
    const p = b && b.player;
    if (!p || p.dead) return;
    if (p.cls !== 'wizard') { this._toast('마법사 클래스에서만 사용할 수 있다'); return; }
    const sp = SPELLS[key];
    if (!sp) return;
    if ((p.cd[key] || 0) > 0.01) return;
    /* 조준: 카메라가 보는 방향에서 가장 가까운 적, 없으면 전방 */
    let aim = null, bestA = 0.32;
    for (const [, u] of this.units) {
      if (u.dead || u.team === p.team) continue;
      const dx = u.x - p.x, dz = u.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > sp.range) continue;
      const a = Math.abs(angDiff(Math.atan2(dx, dz), p.yaw));
      if (a < bestA) { bestA = a; aim = u; }
    }
    p.cd[key] = sp.cooldown;
    if (aim) p.yaw = Math.atan2(aim.x - p.x, aim.z - p.z);
    b.emit({ type: 'cast', unit: p, spell: key });
    if (this.app.vm) this.app.vm.triggerCast();
    if (this.app._beep) this.app._beep();
    if (key === 'fire') {
      const tx = aim ? aim.x : p.x + Math.sin(p.yaw) * 14;
      const tz = aim ? aim.z : p.z + Math.cos(p.yaw) * 14;
      const dx = tx - p.x, dz = tz - p.z;
      const dist = Math.min(sp.range, Math.hypot(dx, dz));
      const yaw = Math.atan2(dx, dz);
      p.yaw = yaw;
      b.spells.push({
        kind: 'fire', src: p, team: p.team, key: 'fire',
        x: p.x + Math.sin(yaw) * 1.0, z: p.z + Math.cos(yaw) * 1.0, y: 1.35,
        vx: Math.sin(yaw) * 24, vz: Math.cos(yaw) * 24,
        life: Math.max(0.12, dist / 24), maxLife: Math.max(0.12, dist / 24), tx, tz
      });
      this.send({ type: 'pspell', key, x: tx, z: tz });
    } else if (key === 'lightning') {
      this.send({ type: 'pspell', key, yaw: p.yaw });
    } else {
      this.send({ type: 'pspell', key, yaw: p.yaw });
    }
  }

  useSkill() {
    const b = this.app.battle;
    const p = b && b.player;
    if (!p || p.dead) return;
    if (p.cls !== 'blademaster') return;
    if (p.cd.petal > 0) { this._toast('매화 일섬 ' + p.cd.petal.toFixed(1) + '초'); return; }
    if (b.useSkill(p)) {
      if (this.app.sfx) this.app.sfx.spell('ice', 0);
      if (this.app.vm) this.app.vm.triggerCast();
      this._toast('🌸 매화 일섬!');
      this.send({ type: 'pskill', yaw: p.yaw });
    }
  }

  /* ------------------------------------------------------------------ 검 막기
     PVP 전용 — 한 번에 최대 guardHoldMax 초만 막을 수 있고, 풀거나 자동 종료되면
     guardCdMax 초 쿨타임이 돌아간다. 서버도 같은 규칙으로 거절한다. */
  pressGuard() {
    if (this.phase !== 'battle' || !this.inBattle) return false;
    const b = this.app.battle;
    const p = b && b.player;
    if (!p || p.dead) return false;
    if (this.guardActive) return true;
    if (this.guardCd > 0.02) { this.denyGuard(); return false; }
    this.guardActive = true;
    this.guardLeft = this.guardHoldMax;
    this.guardSent = true;
    this.app.input.guard = true;
    p.guard = true;
    this.send({ type: 'pguard', on: true });
    const gb = document.getElementById('guardBtn');
    if (gb) gb.classList.add('is-held');
    return true;
  }

  releaseGuard() {
    if (!this.guardActive) return;
    this.guardActive = false;
    this.guardLeft = 0;
    this.guardCd = this.guardCdMax;
    this.guardSent = false;
    this.app.input.guard = false;
    const b = this.app.battle;
    if (b && b.player) b.player.guard = false;
    if (this.inBattle) this.send({ type: 'pguard', on: false });
    const gb = document.getElementById('guardBtn');
    if (gb) gb.classList.remove('is-held');
  }

  /* 쿨타임 중 누름 — 버튼을 빨갛게 깜박이고 남은 시간을 알린다 */
  denyGuard() {
    const gb = document.getElementById('guardBtn');
    if (gb) {
      gb.classList.remove('is-deny');
      void gb.offsetWidth;
      gb.classList.add('is-deny');
      clearTimeout(this._denyT);
      this._denyT = setTimeout(() => gb.classList.remove('is-deny'), 420);
    }
    const left = Math.max(0.1, this.guardCd);
    this._toast('🛡️ 검 막기 쿨타임 ' + left.toFixed(1) + '초');
  }

  /* BA.pvp.guard(true/false) — 테스트·디버그용 */
  guard(on) {
    if (on) return this.pressGuard();
    this.releaseGuard();
    return true;
  }

  onGuardEnd(m) {
    /* 다른 사람의 막기 종료는 내 버튼에 영향을 주지 않는다 */
    if (m && m.to !== undefined && m.to !== this.you) return;
    this.guardActive = false;
    this.guardLeft = 0;
    this.guardSent = false;
    this.guardCd = Math.max(this.guardCd, m && m.cd ? m.cd / 1000 : this.guardCdMax);
    this.app.input.guard = false;
    const b = this.app.battle;
    if (b && b.player) b.player.guard = false;
    const gb = document.getElementById('guardBtn');
    if (gb) gb.classList.remove('is-held');
    if (m && m.held) this._toast('🛡️ 막기 풀림 — ' + this.guardCdMax.toFixed(1) + '초 뒤 다시 쓸 수 있다');
  }

  /* ------------------------------------------------------------------ 프레임 */
  tick(dt) {
    if (!this.inBattle) return;
    const app = this.app;
    const b = app.battle;
    if (!b) return;
    const p = b.player;
    const now = Date.now();

    /* 검 막기 타이머 — 최대 유지가 끝나면 자동으로 풀고 쿨타임 */
    if (this.guardActive) {
      this.guardLeft -= dt;
      if (this.guardLeft <= 0) this.releaseGuard();
    } else if (this.guardCd > 0) {
      this.guardCd = Math.max(0, this.guardCd - dt);
    }

    /* 입력 전송 (16Hz) */
    if (p && now - this.inputAt >= 62) {
      this.inputAt = now;
      this.send({ type: 'pinput', x: p.x, z: p.z, yaw: p.yaw, pitch: app.camPitch });
    }

    /* 원격 유닛 보간 */
    const k = Math.min(1, dt * 13);
    for (const [, u] of this.units) {
      if (u.dead) continue;
      if (u.tx !== undefined) {
        u.x += (u.tx - u.x) * k;
        u.z += (u.tz - u.z) * k;
        if (u.tyaw !== undefined) u.yaw = angLerp(u.yaw, u.tyaw, Math.min(1, dt * 16));
        if (Math.hypot(u.tx - u.x, u.tz - u.z) > 6) { u.x = u.tx; u.z = u.tz; }
      }
    }

    this.updatePlates();
    this.updateScore(false);
    if (this.app.octagon) this.app.octagon.update(dt, this.app.time || 0);

    /* 서버가 조용하면 알린다 */
    if (this.lastStateAt && now - this.lastStateAt > 3500 && !this._staleWarned) {
      this._staleWarned = true;
      this._toast('연결이 불안정해요 — 잠시 기다려 주세요');
    }
  }

  updateScore(force) {
    const bar = $('#pvpTop');
    if (!bar) return;
    const merged = this.lastState ? this.lastState.ents || [] : [];
    let ally = 0, enemy = 0;
    for (const e of merged) if (!e.d) { if (e.tm === 'ally') ally += 1; else enemy += 1; }
    const setTxt = (sel, v) => { const el = $(sel); if (el && el.textContent !== v) el.textContent = v; };
    setTxt('#ptAlly', '아군 ' + ally);
    setTxt('#ptEnemy', '적군 ' + enemy);
    setTxt('#ptScore', (this.score.ally || 0) + ' : ' + (this.score.enemy || 0));
    setTxt('#ptGoal', this.mode === 'elim' ? '전멸전' : '목표 ' + this.killTarget + '킬');
    const t = Math.max(0, this.left | 0);
    const mm = Math.floor(t / 60), ss = t % 60;
    const tel = $('#ptTime');
    if (tel) {
      const txt = mm + ':' + (ss < 10 ? '0' + ss : ss);
      if (tel.textContent !== txt) tel.textContent = txt;
      tel.classList.toggle('is-low', t <= 30);
    }
    /* 사망 화면의 부활 카운트다운 */
    if (this.me && this.me.d) {
      const rt = $('#respawnT');
      if (rt) rt.textContent = String(Math.max(0, Math.ceil(this.me.r || 0)));
    }
  }

  updatePlates() {
    const cam = this.app.cam;
    if (!cam) return;
    const b = this.app.battle;
    if (!b) return;
    const w = window.innerWidth, h = window.innerHeight;
    const v = _v;
    /* 이번 프레임 카메라 행렬로 투영한다 (render 전이라 matrixWorld 가 한 프레임 늦다) */
    cam.updateMatrixWorld();
    const camPos = cam.position;
    for (const [id, el] of this.plates) {
      const u = this.units.get(id);
      if (!u || u.dead || u.removed || u.hideModel) { el.classList.remove('is-on'); continue; }
      const dx = u.x - camPos.x, dz = u.z - camPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 46) { el.classList.remove('is-on'); continue; }
      v.set(u.x, 2.18 * (u.scale || 1), u.z).project(cam);
      if (v.z > 1 || v.z < -1) { el.classList.remove('is-on'); continue; }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -60 || sx > w + 60 || sy < -30 || sy > h + 40) { el.classList.remove('is-on'); continue; }
      const fade = clamp(1 - (dist - 30) / 16, 0.5, 1);
      el.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px) translate(-50%,-100%)';
      el.style.opacity = String(fade);
      el.classList.add('is-on');
      const hp = el.querySelector('.pn-hp i');
      if (hp) {
        const pct = clamp((u.hp / Math.max(1, u.maxHp)) * 100, 0, 100);
        hp.style.width = pct.toFixed(0) + '%';
      }
    }
  }

  /* ------------------------------------------------------------------ 테스트/디버그 */
  debugState() {
    const b = this.app.battle;
    const p = b && b.player;
    return {
      inBattle: this.inBattle,
      inLobby: this.inLobby,
      ws: this.ws ? this.ws.readyState : -1,
      last: this.lastStateAt ? Date.now() - this.lastStateAt : -1,
      code: this.code,
      you: this.you,
      myTeam: this.myTeam,
      myCls: this.myCls,
      phase: this.phase,
      score: { ...this.score },
      killTarget: this.killTarget,
      mode: this.mode,
      left: this.left,
      stats: { ...this.stats },
      blockLog: this.blockLog.slice(),
      plates: this.plates.size,
      platesOn: Array.from(this.plates.values()).filter((e) => e.classList.contains('is-on')).length,
      others: Array.from(this.units.entries()).map(([id, u]) => ({
        id, cls: u.cls, team: u.team, name: u.pname, x: +u.x.toFixed(2), z: +u.z.toFixed(2),
        hp: +u.hp.toFixed(0), maxHp: u.maxHp, dead: !!u.dead,
        drawn: u.dslot >= 0, attackT: +u.attackT.toFixed(2), guard: !!u.guard
      })),
      me: p ? {
        x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(2), hp: +p.hp.toFixed(0),
        maxHp: p.maxHp, dead: !!p.dead, guard: !!p.guard, cls: p.cls,
        respawn: this.me ? this.me.r : 0
      } : null,
      server: this.lastState ? { t: this.lastState.t, phase: this.lastState.phase, score: this.lastState.score } : null
    };
  }

  lookAt(id) {
    const b = this.app.battle;
    const p = b && b.player;
    const u = this.unitOf(id);
    if (!p || !u) return false;
    const yaw = Math.atan2(u.x - p.x, u.z - p.z);
    p.yaw = yaw;
    this.app.camYaw = yaw + Math.PI;
    this.app.camPitch = -0.02;
    return true;
  }

  swing() {
    const b = this.app.battle;
    if (!b || !b.player || b.player.dead) return false;
    return b.startAttack(b.player);
  }

}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const _v = new THREE.Vector3();
