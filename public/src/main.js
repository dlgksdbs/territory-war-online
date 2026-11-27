/* =============================================================================
   main.js — BATTLE ARENA 3D
   -----------------------------------------------------------------------------
   홈(병력 편성) → 3D 전장(1인칭 참전 / 관전) → 결과 · 다시 싸우기
   ============================================================================= */
import * as THREE from 'three';
import { CLASSES, SPELLS, SPELL_ORDER, SKILL, MAX_SOLDIERS, MAX_ELITES, MAX_SPECIALS, TEAM, GROWTH_PER_KILL, impactAt, GUARD_CHANCE, REGEN_FRAC, LIFESTEAL } from './config.js';
import { buildWorld } from './world.js';
import { UnitRenderer } from './rig.js';
import { Battle } from './battle.js';
import { computePose, attackDuration, stepWalk } from './pose.js';
import { FX } from './fx.js';
import { ViewModel } from './viewmodel.js';
import { Sfx } from './sfx.js';
import { createFullscreenToggle, isFullscreen, fullscreenSupported } from './fullscreen.js';
import { initHudLayout } from './hud-custom.js';
import { loadProgress, saveProgress, rosterOf, rosterTotal, growthMult, growthLabel, playerSpec, powerIndex } from './config.js';
import { PvpClient } from './pvp.js';
import { buildOctagon } from './octagon.js';
import { groundY, clampOctagon, resolveObstacles, blockedAt, OCTAGON } from './ground.js';
import { clamp, lerp, damp, angLerp, angDiff, TAU, mulberry32, smoothstep, joyToWorld } from './util.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* 시점 감도 — 예전보다 조금 더 민첩하게 (1.4배) */
/* 시점 감도 — 2026-11-26: 전체화면에서 "감도도 조금 빠르게" 요청으로 기본 10% 올리고,
   전체화면일 때 한 번 더 27% 보정한다 (손놀림은 그대로인데 화면이 커져 답답한 느낌을 없엔다). */
const LOOK_SENS = 0.0069;        // 화면 드래그 1px 당 좌우 회전(rad)
const LOOK_PITCH_SENS = 0.0054;  // 화면 드래그 1px 당 상하 회전(rad)
const SPEC_SENS = 0.0079;        // 관전 카메라 좌우
const SPEC_PITCH_SENS = 0.0062;  // 관전 카메라 상하
const FS_SENS_BOOST = 1.27;      // 전체화면 보정 배율
const lookSens = (base) => base * (isFullscreen() ? FS_SENS_BOOST : 1);
/* 🎬 관전 자유 비행 범위 — 땅 아래만 막고 하늘(120m)·성채 뒷편까지 어디든 */
const SPECTATE_MIN_Y = 1.2;
const SPECTATE_MAX_Y = 120;
const _aimDir = new THREE.Vector3();
const UNIT_KR = { soldier: '병사', elite: '고급 병사', knight: '기사', wizard: '마법사', blademaster: '검객', berserker: '광전사' };
const BUCKET_KEYS = ['soldier', 'elite', 'knight', 'wizard', 'blademaster', 'berserker'];

class App {
  constructor() {
    this.progress = loadProgress();
    this.cfg = {
      playerClass: 'soldier',
      /* 기본 편성 — 2026-11-26 부터 전 병종 0명 (첫 화면에서 직접 편성하게 비워 둔다) */
      allySoldiers: 0, allyElites: 0, allyKnights: 0, allyWizards: 0, allyBlademasters: 0, allyBerserkers: 0,
      enemySoldiers: 0, enemyElites: 0, enemyKnights: 0, enemyWizards: 0, enemyBlademasters: 0, enemyBerserkers: 0
    };
    this.state = 'home';
    this.paused = false;
    this.frames = 0;
    this.time = 0;
    this.camYaw = Math.PI;
    this.camPitch = -0.04;
    this.camMode = 'fp';
    this.cam = null;
    this.battle = null;
    this.renderer = null;
    this.fx = null;
    this.vm = null;
    this.world = null;
    this.shakeTrauma = 0;
    this.hitStopT = 0;
    this.playerKillSaveT = 0;
    this.spellAimHelper = new THREE.Vector3();
    this.input = { mx: 0, mz: 0, yaw: 0, pitch: 0, attack: false, attackHeld: false, guard: false };
    this.debugLock = null;
    this.sfx = new Sfx();
    this.last = 0;
    this.autoSpectate = false;
    this.spectate = null;
    this._spectateIdle = 0;
    this._aimOn = false;
    this._aimKey = '';
    this.qualityStep = 2;      // 2 = 최고, 1 = 중간(그림자 끔), 0 = 절약(해상도 낮춤)
    this._ftSamples = [];
    this._raf = null;
    this._hudCache = {};
    this._bindUI();
    /* 🎮 전투 HUD 버튼 크기·위치 커스텀 — 저장된 배치를 지금 바로 적용한다 */
    this.hudLayout = initHudLayout(this);
    /* ⚔️ 플레이어 PVP — 홈 패널·대기실·전장 동기화 */
    this.pvp = new PvpClient(this);
    this._readUrl();
    this._showHome();
  }

  /* ------------------------------------------------------------------ 초기화 */
  initGL() {
    if (this.renderer) return;
    const q = new URLSearchParams(location.search);
    this.quality = q.get('q') || 'high';
    const low = this.quality === 'low';
    const canvas = $('#gl');
    canvas.addEventListener('webglcontextlost', (e) => { console.warn('WEBGL_CONTEXT_LOST', e.statusMessage || ''); }, false);
    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false
    });
    r.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.94;
    r.shadowMap.enabled = !low;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.autoClear = false;
    r.info.autoReset = false;
    this.renderer = r;

    const scene = new THREE.Scene();
    this.scene = scene;
    const cam = new THREE.PerspectiveCamera(62, 1, 0.08, 620);
    cam.position.set(0, 1.62, -20);
    this.cam = cam;
    this.world = buildWorld(scene, r);
    this.fx = new FX(scene, cam);
    /* 지면 높이 — 이펙트(피·불티)도 언덕을 따라간다 */
    this.fx.ground = (x, z) => groundY(x, z, !!(this.battle && this.battle.pvp));
    this.vm = new ViewModel(r, scene, cam);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 220));
  }

  resize() {
    if (!this.renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    /* 화면이 커지거나 돌아가면 커스텀 버튼 배치도 새 화면 안으로 다시 맞춘다 */
    if (this.hudLayout) this.hudLayout.apply();
  }

  /* ------------------------------------------------------------------ 화면 */
  _showHome() {
    this.state = 'home';
    $('#loading').classList.add('is-done');
    $('#home').classList.add('is-active');
    $('#battle').classList.remove('is-active');
    $('#result').classList.remove('is-on');
    $('#menuSheet').classList.remove('is-on');
    this._syncHome();
  }

  _syncHome() {
    $('#growthKills').textContent = this.progress.kills.toLocaleString();
    $('#growthPct').textContent = growthLabel(this.progress.kills);
    $$('.class-card').forEach((c) => c.classList.toggle('is-on', c.dataset.cls === this.cfg.playerClass));
    const note = {
      soldier: '검과 방패, 민첩한 연속 베기. 적을 벨 때마다 <b>+0.001%</b>씩 영구히 강해진다.',
      elite: '금장 판금의 정예 검병. 병사보다 <b>체력·이속·공속 +10%</b>, 방패 없이 <b>장검</b>으로 정면을 막아낸다.',
      knight: '큰 망치를 든 중갑 장군. 내려치기 한 번에 <b>최대 100명</b>을 으스러뜨린다. 망치를 두 손으로 쥐므로 <b>막기 불가</b>.',
      wizard: '몸은 약하지만 <b>화염·번개·빙결</b> 세 마법으로 전장을 지운다. 버튼으로 직접 시전.',
      blademaster: '가장 빠른 연속 베기와 기동력. <b>🌸 매화 일섬</b>으로 전방을 돌진하며 쓸어버린다.',
      berserker: '쌍단검을 쥔 <b>초고체력·초고속 연타</b> 탱커. 한 방은 약하지만 공격 버튼을 <b>꾹 누르면 자동 연타</b>가 나간다. 쌍단검이라 <b>막기는 불가</b>.'
    };
    $('#classNote').innerHTML = note[this.cfg.playerClass] || '';
    $$('.row').forEach((row) => {
      const team = row.dataset.team, unit = row.dataset.unit;
      const key = team + unit[0].toUpperCase() + unit.slice(1) + 's';
      const input = row.querySelector('input[type=range]');
      const num = row.querySelector('input.num');
      const out = row.querySelector('output');
      const v = this.cfg[key] || 0;
      input.value = v;
      if (num) num.value = v;
      if (out) out.textContent = v;
      const max = Number(input.max) || MAX_SOLDIERS;
      const pct = (v / max) * 100;
      input.style.setProperty('--p', Math.max(2, pct) + '%');
    });
    const r = rosterOf(this.cfg);
    $('#rosterTotal').textContent = `총 ${rosterTotal(r).toLocaleString()}명 출전`;
    $$('.class-card').forEach((card) => {
      const cls = card.dataset.cls;
      const s = CLASSES[cls];
      if (!s) return;
      const hp = card.querySelector('[data-stat=hp]');
      const dmg = card.querySelector('[data-stat=dmg]');
      const pw = card.querySelector('[data-stat=power]');
      if (hp) hp.textContent = Math.round(s.hp);
      if (dmg) dmg.textContent = cls === 'wizard' ? SPELLS.fire.damage : s.damage;
      if (pw && !card.dataset.power) {
        const m = powerIndex(cls);
        pw.textContent = m.toFixed(m < 1.2 ? 2 : 1) + '×';
        card.dataset.power = '1';
      }
    });
  }

  _bindUI() {
    $$('.class-card').forEach((card) => {
      card.addEventListener('click', () => {
        this.sfx.resume(); this.sfx.ui();
        this.cfg.playerClass = card.dataset.cls;
        this._syncHome();
        this._beep();
      });
    });
    const applyRowValue = (row, raw) => {
      const unit = row.dataset.unit, team = row.dataset.team;
      const key = team + unit[0].toUpperCase() + unit.slice(1) + 's';
      const range = row.querySelector('input[type=range]');
      const num = row.querySelector('input.num');
      const max = Number(range.max) || MAX_SOLDIERS;
      const v = Math.max(0, Math.min(max, Math.round(Number(raw) || 0)));
      this.cfg[key] = v;
      if (range.value !== String(v)) range.value = v;
      if (num && num.value !== String(v)) num.value = v;
      const pct = (v / max) * 100;
      range.style.setProperty('--p', Math.max(2, pct) + '%');
      $('#rosterTotal').textContent = `총 ${rosterTotal(rosterOf(this.cfg)).toLocaleString()}명 출전`;
    };
    $$('.row input[type=range]').forEach((input) => {
      input.addEventListener('input', () => {
        applyRowValue(input.closest('.row'), input.value);
      });
    });
    // 숫자 직접 입력칸 — 슬라이더와 양방향 연동
    $$('.row input.num').forEach((input) => {
      const commit = () => applyRowValue(input.closest('.row'), input.value);
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      input.addEventListener('focus', () => input.select());
    });
    $('#presets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const p = b.dataset.preset;
      const set = (a, k, w, es, ek, ew, ab, eb, el, eel) => {
        this.cfg.allySoldiers = a; this.cfg.allyKnights = k; this.cfg.allyWizards = w;
        this.cfg.enemySoldiers = es; this.cfg.enemyKnights = ek; this.cfg.enemyWizards = ew;
        this.cfg.allyBlademasters = ab || 0; this.cfg.enemyBlademasters = eb || 0;
        this.cfg.allyElites = el || 0; this.cfg.enemyElites = eel || 0;
        // 프리셋을 고르면 다른 병종은 초기화한다 (이전 선택이 남아 섞이지 않게)
        this.cfg.allyBerserkers = 0; this.cfg.enemyBerserkers = 0;
      };
      /* 프리셋도 한 진영 30~150명 수준으로 가볍게 — 2026-11-26 기본 인원 축소에 맞춤 */
      if (p === 'duel') { set(0, 1, 0, 0, 1, 0); }
      else if (p === 'clash') { set(24, 1, 1, 24, 1, 1, 1, 1, 4, 4); }
      else if (p === 'epic') { set(120, 6, 3, 120, 6, 3, 6, 6, 20, 20); }
      else if (p === 'horde') { set(600, 0, 0, 600, 0, 0, 0, 0, 0, 0); this.cfg.playerClass = 'blademaster'; }
      else if (p === 'insane') { set(2000, 0, 0, 2000, 0, 0, 0, 0, 0, 0); this.cfg.playerClass = 'blademaster'; }
      else if (p === 'elite') { set(0, 0, 0, 0, 0, 0, 0, 0, 60, 60); this.cfg.playerClass = 'elite'; }
      else if (p === 'veteran') { set(0, 4, 2, 0, 4, 2, 4, 4, 120, 120); this.cfg.playerClass = 'elite'; }
      else if (p === 'magic') { set(0, 0, 12, 0, 0, 12); this.cfg.playerClass = 'wizard'; }
      else if (p === 'blade') { set(0, 0, 0, 0, 0, 0, 12, 12); this.cfg.playerClass = 'blademaster'; }
      else if (p === 'rage') {
        set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        this.cfg.allyBerserkers = 12; this.cfg.enemyBerserkers = 12;
        this.cfg.playerClass = 'berserker';
      }
      else if (p === 'underdog') { this.cfg.playerClass = 'blademaster'; set(0, 0, 0, 1000, 0, 0); }
      this._syncHome();
    });
    $('#countQuick').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = Number(b.dataset.count);
      this.cfg.allySoldiers = v; this.cfg.enemySoldiers = v;
      this.sfx.ui();
      this._syncHome();
    });
    $('#startBtn').addEventListener('click', () => this.startBattle());
    $('#camBtn').addEventListener('click', () => this.cycleCamera());
    $('#menuBtn').addEventListener('click', () => { $('#menuSheet').classList.add('is-on'); this.paused = true; });
    this._bindFullscreen();
    $('#menuSheet').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('#menuSheet').classList.remove('is-on');
      if (b.dataset.act === 'resume') this.paused = false;
      else if (b.dataset.act === 'restart') { this.paused = false; this.startBattle(); }
      else { this.toHome(); }
    });
    $('#againBtn').addEventListener('click', () => this.startBattle());
    $('#toHomeBtn').addEventListener('click', () => this.toHome());
    // 결과 미니 카드 닫기 — 결과창 없이 전장을 자유롭게 구경한다
    const resClose = $('#resClose');
    if (resClose) {
      resClose.addEventListener('click', () => {
        $('#result').classList.remove('is-on');
        this.paused = false;
        this.attackHeld = false; this.input.attack = false; this.input.guard = false;
        this.camMode = 'spectate';
        this.spectate = null;
        this._enterSpectate();
        const cb = $('#camBtn');
        if (cb) { cb.textContent = '🎬'; cb.title = '관전'; }
        this._toast('🎬 전장 구경 — 🎬 버튼으로 참전');
      });
    }
    const atkBtn = $('#attackBtn');
    let atkPid = null;
    const pressAtk = (e) => {
      if (e.cancelable) e.preventDefault();
      atkPid = e.pointerId === undefined ? null : e.pointerId;
      /* ⚔️ PVP — 막기 유지 중에 베기 버튼을 누르면 막기가 즉시 풀리고 공격이 나간다 */
      if (this.battle && this.battle.pvp && this.pvp) this.pvp.cancelGuardForAttack();
      this.attackHeld = true;
      this.input.attack = true;
      this._aimAssist();
      atkBtn.classList.add('is-held');
      try { atkBtn.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    };
    /* 손을 떼면 연타도 멈춘다 — 다른 손가락(조이스틱·막기)의 up 으로는 끊기지 않게
       내 포인터 id 만 놓는다. 캡처가 풀리거나(lostpointercapture) 화면이 가려져
       이벤트가 유실되면 연타가 굳지 않도록 같이 놓아준다. */
    const releaseAtk = (e) => {
      if (e && e.pointerId !== undefined && atkPid !== null && e.pointerId !== atkPid) return;
      atkPid = null;
      this.attackHeld = false;
      atkBtn.classList.remove('is-held');
    };
    atkBtn.addEventListener('pointerdown', pressAtk);
    atkBtn.addEventListener('pointerup', releaseAtk);
    atkBtn.addEventListener('pointercancel', releaseAtk);
    atkBtn.addEventListener('lostpointercapture', releaseAtk);
    atkBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    window.addEventListener('pointerup', releaseAtk, true);
    window.addEventListener('pointercancel', releaseAtk, true);
    window.addEventListener('blur', () => releaseAtk());
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAtk(); });
    $$('.spell-btn').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.castSpell(b.dataset.spell);
      });
    });
    const skillBtn = $('#skillBtn');
    skillBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.useSkill(); });
    // 🛡️ 검·방패 막기 — 누르고 있는 동안(홀드) + 짧게 톡 눌러도 잠깐 막는다
    const guardBtn = $('#guardBtn');
    if (guardBtn) {
      let pid = null;
      const press = (e) => {
        if (e.cancelable) e.preventDefault();
        pid = e.pointerId;
        /* ⚔️ PVP — 최대 유지·쿨타임이 있는 검 막기 */
        if (this.battle && this.battle.pvp && this.pvp) { this.pvp.pressGuard(); return; }
        this.input.guard = true;
        this.guardMinT = Math.max(this.guardMinT || 0, 0.40);   // 탭 한 번만 해도 0.4초는 막힌다
        guardBtn.classList.add('is-held');
        try { guardBtn.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      };
      const release = (e) => {
        if (pid !== null && e && e.pointerId !== undefined && e.pointerId !== pid) return;
        pid = null;
        /* 🛡️ PVP — 손을 떼도 1초(guardHoldMax) 동안 막기가 유지된다 (공격·시간 종료가 끝낸다) */
        if (this.battle && this.battle.pvp && this.pvp) { this.pvp.tapRelease(); return; }
        this.input.guard = false;
        guardBtn.classList.remove('is-held');
      };
      guardBtn.addEventListener('pointerdown', press);
      guardBtn.addEventListener('pointerup', release);
      guardBtn.addEventListener('pointercancel', release);
      guardBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
    }
    this._bindJoystick();
    this._bindLook();
    this._bindKeys();
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (this.state !== 'battle') return;
      this.keys = this.keys || {};
      this.keys[e.code] = true;
      if (e.code === 'Space') { e.preventDefault(); this.attackHeld = true; this.input.attack = true; if (this.battle && this.battle.pvp && this.pvp) this.pvp.cancelGuardForAttack(); this._aimAssist(); }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyE') {
        if (this.battle && this.battle.pvp && this.pvp) { this.pvp.pressGuard(); return; }
        this.input.guard = true; this.guardMinT = Math.max(this.guardMinT || 0, 0.40);
        const gb = $('#guardBtn'); if (gb) gb.classList.add('is-held');
      }
      if (e.code === 'Digit1') this.castSpell('fire');
      if (e.code === 'Digit2') this.castSpell('lightning');
      if (e.code === 'Digit3') this.castSpell('ice');
      if (e.code === 'KeyP') this.cycleCamera();
    });
    window.addEventListener('keyup', (e) => {
      if (this.keys) this.keys[e.code] = false;
      if (e.code === 'Space') this.attackHeld = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyE') {
        if (this.battle && this.battle.pvp && this.pvp) { this.pvp.tapRelease(); return; }
        this.input.guard = false;
        const gb = $('#guardBtn'); if (gb) gb.classList.remove('is-held');
      }
    });
  }

  /* 🖥️ 전체화면 — 홈 상단과 전장 HUD 의 ⛶ 버튼이 같은 상태를 공유한다 */
  _bindFullscreen() {
    this.fs = createFullscreenToggle({
      buttons: [$('#fsBtn'), $('#fsHomeBtn')],
      onChange: () => this._onFullscreenChange(),
      onError: (kind) => {
        if (this._fsNoticeT && performance.now() - this._fsNoticeT < 1200) return;
        this._fsNoticeT = performance.now();
        this._toast(kind === 'unsupported' ? '이 브라우저에서는 전체화면을 쓸 수 없어요' : '전체화면 전환을 브라우저가 막았어요');
      }
    });
    for (const b of [$('#fsBtn'), $('#fsHomeBtn')]) {
      if (!b) continue;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.sfx) { try { this.sfx.resume(); this.sfx.ui(); } catch (err) { /* 소리 없는 환경 */ } }
        this.fs.toggle();
      });
    }
  }

  /* 전체화면 진입/해제 — 브라우저 창 크기가 바뀌는 중이라 여러 번 맞춰 준다 */
  _onFullscreenChange() {
    /* HUD 배치·버튼 크기·시점 감도가 상태를 한 번에 알아보도록 #app 에도 표시한다 */
    const el = document.getElementById('app');
    if (el) el.classList.toggle('is-fullscreen', isFullscreen());
    this.resize();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.resize());
    clearTimeout(this._fsResizeT);
    this._fsResizeT = setTimeout(() => this.resize(), 320);
    if (this.state === 'battle' && this.cam) this.cam.updateProjectionMatrix();
  }

  _bindJoystick() {
    const joy = $('#joy'), knob = $('#joyKnob');
    let id = null, cx = 0, cy = 0;
    /* 손잡이가 움직이는 반경 — 조이스틱이 커스텀 배율로 커지면 같이 넓어진다 */
    let R = 42;
    const move = (e) => {
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      const k = Math.min(1, len / R);
      const nx = len > 0.001 ? (dx / len) * k : 0;
      const ny = len > 0.001 ? (dy / len) * k : 0;
      knob.style.transform = `translate(${nx * R}px, ${ny * R}px)`;
      this.input.mx = nx;
      this.input.mz = -ny;
    };
    joy.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault();
      id = e.pointerId;
      const rect = joy.getBoundingClientRect();
      cx = rect.left + rect.width / 2; cy = rect.top + rect.height / 2;
      R = Math.max(20, rect.width * 0.375);
      try { joy.setPointerCapture(id); } catch (err) { /* 합성 이벤트 */ }
      move(e);
    });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      knob.style.transform = 'translate(0,0)';
      this.input.mx = 0; this.input.mz = 0;
    };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    joy.addEventListener('lostpointercapture', end);
    /* 🖐️ 이벤트를 놓쳐도(다른 손가락이 먼저 올라감·화면 밖) 이동이 멈춘 채 굳지 않게 */
    window.addEventListener('pointerup', (e) => { if (id !== null && e.pointerId === id) end(e); }, true);
    window.addEventListener('pointercancel', (e) => { if (id !== null && e.pointerId === id) end(e); }, true);
  }

  _bindLook() {
    const canvas = $('#gl');
    let id = null, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      id = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { canvas.setPointerCapture(id); } catch (err) { /* noop */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (this.camMode === 'spectate') {
        if (!this.spectate) this._enterSpectate();
        const s = this.spectate;
        s.yaw -= dx * lookSens(SPEC_SENS);        // 1인칭과 같은 방향 (예전엔 부호가 반대라 화면이 거꾸로 돌았다)
        s.pitch = clamp(s.pitch - dy * lookSens(SPEC_PITCH_SENS), -1.50, 0.92);
        this._spectateIdle = 0;
        this.autoSpectate = false;      // 손으로 돌리면 자동 회전은 멈춘다
      } else {
        // 1인칭 — 화면을 민 방향으로 고개가 돈다
        this.camYaw -= dx * lookSens(LOOK_SENS);
        this.camPitch = clamp(this.camPitch - dy * lookSens(LOOK_PITCH_SENS), -1.15, 0.9);
      }
    });
    const end = (e) => { if (e.pointerId === id) id = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  _beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audio = this.audio || new AC();
      const o = this.audio.createOscillator(), g = this.audio.createGain();
      o.frequency.value = 620; g.gain.value = 0.03;
      o.connect(g); g.connect(this.audio.destination);
      o.start(); o.stop(this.audio.currentTime + 0.05);
    } catch (e) { /* 무음 환경 */ }
  }

  _readUrl() {
    const p = new URLSearchParams(location.search);
    if (p.get('cls')) this.cfg.playerClass = p.get('cls');
    if (p.get('ally')) this.cfg.allySoldiers = Number(p.get('ally'));
    if (p.get('enemy')) this.cfg.enemySoldiers = Number(p.get('enemy'));
    if (p.get('ak')) this.cfg.allyKnights = Number(p.get('ak'));
    if (p.get('ek')) this.cfg.enemyKnights = Number(p.get('ek'));
    if (p.get('aw')) this.cfg.allyWizards = Number(p.get('aw'));
    if (p.get('ew')) this.cfg.enemyWizards = Number(p.get('ew'));
    if (p.get('ae')) this.cfg.allyElites = Number(p.get('ae'));
    if (p.get('ee')) this.cfg.enemyElites = Number(p.get('ee'));
    if (p.get('abz')) this.cfg.allyBerserkers = Number(p.get('abz'));
    if (p.get('ebz')) this.cfg.enemyBerserkers = Number(p.get('ebz'));
  }

  /* ------------------------------------------------------------------ 전투 */
  startBattle() {
    /* ⚔️ 아군·적군이 모두 0명이면 빈 전장에 플레이어만 서게 된다 — 승패도 없고 볼 것도 없다.
       첫 화면 기본 편성이 0명이라 아무것도 고르지 않고 누를 수 있으므로, 편성부터 안내하고
       전장에 들어가지 않는다 (아군 0 + 적군 N = 1 vs N, 적군 0 = 연습 모드는 그대로 허용). */
    if (rosterTotal(rosterOf(this.cfg)) === 0) {
      this._toast('병력을 1명 이상 편성해 줘 · 프리셋을 눌러도 된다');
      this._nudgeArmy();
      this.sfx.ui();
      return;
    }
    this.sfx.resume();
    this.initGL();
    $('#home').classList.remove('is-active');
    $('#battle').classList.add('is-active');
    /* 커스텀 버튼 배치 — 전장이 보이는 지금 실제 크기로 한 번 더 맞춘다 */
    if (this.hudLayout) this.hudLayout.apply();
    $('#result').classList.remove('is-on');
    $('#menuSheet').classList.remove('is-on');
    this.state = 'battle';
    this.paused = false;
    this.debugLock = null;
    this.debugCam = false;
    this._pendingResult = null;
    this._pendingT = 0;
    this._resultShown = false;
    this.input.aimId = 0;
    this.input.aimPart = 'body';

    // 기존 유닛 렌더러 정리
    if (this.unitRenderer) { this.unitRenderer.dispose(); this.unitRenderer = null; }
    this.fx.clear();

    const cfg = Object.assign({}, this.cfg, { playerClass: this.cfg.playerClass, seed: (Date.now() % 100000) });
    this.battle = new Battle({
      config: cfg,
      playerKills: this.progress.kills
    }).start();
    /* 🪨 지형물 충돌 — 바위·기둥·횃불을 뚫고 지나가지 못한다 */
    this.battle.colliders = this.world.colliders || [];
    this.battle.groundFn = (x, z) => groundY(x, z, false);

    // 클래스별 버킷
    const buckets = {};
    for (const k of BUCKET_KEYS) buckets[k] = [];
    for (const u of this.battle.units) {
      if (!buckets[u.cls]) buckets[u.cls] = [];
      buckets[u.cls].push(u);
    }
    this.unitRenderer = new UnitRenderer(this.scene, {
      shadowUnits: this.quality !== 'low' && this.battle.units.length <= 420,
      // 전장이 클수록 상세 모델 예산을 줄여 프레임을 지킨다 (실루엣이 나머지를 채운다)
      detailCap: this.battle.units.length > 1600 ? 70 : this.battle.units.length > 800 ? 100 : 140
    });
    // 예비 병력이 나중에 들어와도 그릴 자리가 있도록 클래스별 수용량을 미리 잡아둔다
    const caps = {};
    for (const cls of BUCKET_KEYS) {
      caps[cls] = (this.battle.roster.ally[cls] || 0) + (this.battle.roster.enemy[cls] || 0) + (cls === this.cfg.playerClass ? 1 : 0);
    }
    this.unitRenderer.build(buckets, caps);
    this.fx.buildShadows(this.battle.units.length <= 900 ? this.battle.units : null);
    this._initialAlly = this.battle.initialTotalAlly || this.battle.countAlive('ally');
    this._initialEnemy = this.battle.initialTotalEnemy || this.battle.countAlive('enemy');
    // 적 0명 편성 = 연습 모드 (승리로 끝나지 않음을 화면에 알린다)
    const practice = !!this.battle.practice;
    const tag = $('#practiceTag');
    if (tag) tag.classList.toggle('is-on', practice);
    if (practice) this._toast('연습 모드 · 적군 0명');
    this.vm.setClass(this.cfg.playerClass);
    if (this.cfg.playerClass === 'berserker') this._toast('🩸 공격 버튼을 꾹 누르면 자동 연타');
    this.camMode = 'fp';
    this.spectate = null;
    this.input.guard = false;
    this.attackHeld = false;
    const gb0 = $('#guardBtn'); if (gb0) gb0.classList.remove('is-held');
    $('#battle').classList.remove('is-spectate');
    // 시작 첫 프레임부터 자기 몸이 1인칭 시야를 가리지 않도록
    if (this.battle.player) this.battle.player.hideModel = true;
    this.camYaw = Math.PI;
    this.camPitch = -0.05;
    this.cam.fov = 62;
    this.cam.updateProjectionMatrix();
    this.frameStats = { drawCalls: 0, triangles: 0 };
    this._hudCache = {};
    $('#deadVeil').classList.remove('is-on');
    $('#hitVignette').style.opacity = 0;
    $('#hitVignette').classList.remove('is-strong');
    const ai = document.getElementById('aimInfo'); if (ai) ai.classList.remove('is-on');
    const hm = document.getElementById('hitMark'); if (hm) hm.classList.remove('is-on', 'is-kill');
    this._aimOn = false; this._aimKey = '';
    const sh = document.getElementById('specHint'); if (sh) sh.classList.remove('is-on');
    this._syncHUD(true);
    if (this.audio) { try { this.audio.resume(); } catch (e) { /* noop */ } }
    if (!this._raf) this.loop();
  }

  /* ------------------------------------------------------------------ ⚔️ PVP */
  /* 서버가 시작을 알리면(pstart) 호출된다 — 배틀 아레나와 같은 1인칭 무대에
     다른 플레이어들을 네트워크 유닛으로 세운다. 전투 판정은 서버가 한다. */
  enterPvpBattle(init) {
    this.sfx.resume();
    this.initGL();
    $('#home').classList.remove('is-active');
    $('#pvpLobby').classList.remove('is-on');
    $('#battle').classList.add('is-active');
    $('#battle').classList.add('is-pvp');
    $('#battle').classList.remove('is-spectate');
    if (this.hudLayout) this.hudLayout.apply();
    $('#result').classList.remove('is-on');
    $('#menuSheet').classList.remove('is-on');
    $('#pvpResult').classList.remove('is-on');
    this.state = 'battle';
    this.paused = false;
    this.debugLock = null;
    this.debugCam = false;
    this._pendingResult = null;
    this._pendingT = 0;
    this._resultShown = true;         // 로컬 승패 배너는 쓰지 않는다 (서버가 결과를 보낸다)
    this._aimOn = false; this._aimKey = '';
    this.input.aimId = 0; this.input.aimPart = 'body';
    this.input.guard = false; this.input.attack = false; this.input.mx = 0; this.input.mz = 0;
    this.attackHeld = false;

    if (this.unitRenderer) { this.unitRenderer.dispose(); this.unitRenderer = null; }
    this.fx.clear();

    const zero = {
      playerClass: init.cls,
      allySoldiers: 0, allyElites: 0, allyKnights: 0, allyWizards: 0, allyBlademasters: 0, allyBerserkers: 0,
      enemySoldiers: 0, enemyElites: 0, enemyKnights: 0, enemyWizards: 0, enemyBlademasters: 0, enemyBerserkers: 0,
      seed: (Date.now() % 100000)
    };
    /* ⚔️ PVP 는 영구 성장 제외 — 솔로에서 쌓은 배율도 쓰지 않는다 */
    this.battle = new Battle({ config: zero, playerKills: 0, noGrowth: true }).start();
    this.battle.pvp = true;
    this.battle.practice = false;
    this.battle.arenaR = OCTAGON.fence;
    this.battle.groundFn = (x, z) => groundY(x, z, true);
    /* 🥊 PVP 는 UFC 옥타곤 링 위에서만 — 바깥 지형물 충돌은 쓰지 않고 링 경계로 막는다 */
    this.battle.colliders = [];
    this.battle.onPvpImpact = (u) => { if (this.pvp) this.pvp.sendAttack(u); };

    /* 🥊 옥타곤 무대 — PVP 에서만 만들고, 나갈 때 걷어낸다 */
    if (this.octagon) { try { this.octagon.dispose(); } catch (e) { /* noop */ } }
    this.octagon = buildOctagon(this.scene);
    /* 매트 위에 마법진(룬)이 비쳐 보이지 않게 PVP 에서는 숨긴다 */
    if (this.world && this.world.rune) this.world.rune.visible = false;
    if (this.pvp) this.pvp.octagon = { apothem: OCTAGON.apothem };

    /* 유닛 렌더러 — 병종별로 상세 슬롯을 넉넉히 잡아 PVP 인원 전원을 풀 디테일로 그린다 */
    const empty = {};
    const caps = {};
    for (const k of BUCKET_KEYS) { empty[k] = []; caps[k] = 18; }
    this.unitRenderer = new UnitRenderer(this.scene, { shadowUnits: true, detailCap: 18 });
    this.unitRenderer.build(empty, caps);
    this.fx.buildShadows(null);

    const p = this.battle.player;
    p.x = init.spawn ? init.spawn.x : 0;
    p.z = init.spawn ? init.spawn.z : -9;
    p.yaw = init.spawn ? init.spawn.yaw : 0;
    p.hideModel = true;
    /* 🥊 링 안으로 */
    const spw = clampOctagon(p.x, p.z);
    p.x = spw.x; p.z = spw.z;
    p.y = groundY(p.x, p.z, true);
    this.camYaw = p.yaw + Math.PI;
    this.camPitch = -0.04;
    this.cam.fov = 62;
    this.cam.updateProjectionMatrix();

    /* 다른 플레이어·AI 병력 */
    for (const r of init.roster || []) {
      if (r.s === init.you) continue;
      this.pvp.addUnit(r);
    }
    this.pvp.buildPlates();

    this.vm.setClass(init.cls);
    this.camMode = 'fp';
    $('#deadVeil').classList.remove('is-on');
    $('#hitVignette').style.opacity = 0;
    $('#hitVignette').classList.remove('is-strong');
    const ai = document.getElementById('aimInfo'); if (ai) ai.classList.remove('is-on');
    const hm = document.getElementById('hitMark'); if (hm) hm.classList.remove('is-on', 'is-kill');
    this._hudCache = {};
    this._syncHUD(true);
    this.pvp.updateScore(true);
    if (!this._raf) this.loop();
  }

  toHome() {
    /* PVP 전투 중이면 방에서 나간 뒤 홈으로 (exitToHome 이 다시 toHome 을 부른다) */
    if (this.pvp && this.pvp.inBattle) { this.pvp.exitToHome(); return; }
    if (this.octagon) { try { this.octagon.dispose(); } catch (e) { /* noop */ } this.octagon = null; }
    if (this.world && this.world.rune) this.world.rune.visible = true;
    this.state = 'home';
    this.paused = true;
    this.camMode = 'fp';
    this.spectate = null;
    $('#battle').classList.remove('is-spectate');
    if (this.unitRenderer) { this.unitRenderer.dispose(); this.unitRenderer = null; }
    if (this.fx) this.fx.clear();
    $('#battle').classList.remove('is-active');
    $('#battle').classList.remove('is-pvp');
    $('#result').classList.remove('is-on');
    $('#menuSheet').classList.remove('is-on');
    $('#home').classList.add('is-active');
    const tag = $('#practiceTag');
    if (tag) tag.classList.remove('is-on');
    const ai = document.getElementById('aimInfo'); if (ai) ai.classList.remove('is-on');
    const hm = document.getElementById('hitMark'); if (hm) hm.classList.remove('is-on', 'is-kill');
    this._aimOn = false;
    this._syncHome();
  }

  cycleCamera() {
    if (!this.battle) return;
    /* ⚔️ PVP 는 1인칭 대전 — 관전(무적) 시점으로 바꾸면 상대에게 일방적으로 유리해진다 */
    if (this.battle.pvp) { this._toast('PVP는 1인칭으로만 싸운다'); return; }
    // 👁️ 1인칭 ↔ 🎬 관전 — 두 가지 시점만 쓴다 (3인칭은 없다)
    this.camMode = this.camMode === 'spectate' ? 'fp' : 'spectate';
    if (this.camMode === 'spectate') this._enterSpectate(); else this._exitSpectate();
    const b = $('#camBtn');
    b.textContent = this.camMode === 'fp' ? '👁️' : '🎬';
    b.title = this.camMode === 'fp' ? '1인칭' : '관전';
    this._toast(this.camMode === 'fp' ? '👁️ 1인칭 참전' : '🎬 관전 — 조이스틱 이동 · 드래그 시점');
  }

  /* 🎬 관전 — 공중에서 자유롭게 돌아다니며 전장을 본다 */
  _enterSpectate() {
    const p = this.battle && this.battle.player;
    const span = this.battle ? Math.sqrt(this.battle.units.length || 1) : 1;
    this.spectate = {
      x: p ? p.x : 0,
      z: p ? p.z : 0,
      y: clamp(9 + span * 3.4, 12, 34),
      yaw: this.camYaw + Math.PI,     // 지금 보던 방향 그대로
      pitch: -0.55
    };
    this._spectateIdle = 0;
    // 관전으로 넘어갈 때 눌려 있던 이동·공격 입력을 모두 놓는다 (몸은 그 자리에 세워 둔다)
    this.input.mx = 0; this.input.mz = 0;
    this.input.attack = false; this.attackHeld = false; this.input.guard = false;
    this.autoSpectate = true;          // 입력이 없을 때만 천천히 전장을 훑는다
    if (this.battle) {
      this.battle.playerSafe = true;
      this.battle.playerInvuln = 0;
      // 🎬 유령 — 나를 쫓던 적은 즉시 다른 아군을 찾는다
      this.battle.releaseFromPlayer();
    }
    const el = $('#battle');
    if (el) el.classList.add('is-spectate');
  }

  _exitSpectate() {
    const b = this.battle;
    const s = this.spectate;
    const el = $('#battle');
    if (el) el.classList.remove('is-spectate');
    if (!b) return;
    const p = b.player;
    if (p && s) {
      // 관전하던 그 자리(지면)로 내려와 바로 싸운다 — 예전 플레이어 자리로 순간이동하지 않는다.
      // 전장 반경 안으로만 들어오게 하고, 보던 방향 그대로 서서 내려온다.
      const lim = Math.max(4, (b.arenaR || 60) * 0.94);
      p.x = clamp(s.x, -lim, lim);
      p.z = clamp(s.z, -lim, lim);
      p.yaw = s.yaw;
      p.moveAmt = 0;
      p.pitch = clamp(s.pitch + (s.pitch < 0 ? 0.28 : 0), -1.15, 0.9);
      this.camYaw = p.yaw + Math.PI;
      this.camPitch = p.pitch;
      this._prevYaw = this.camYaw;
      // 내려온 자리 주변의 적과 붙어 있어도 바로 죽지 않게 짧은 무적
      b.playerInvuln = Math.max(b.playerInvuln || 0, 0.9);
    }
    this.autoSpectate = false;
    b.playerSafe = false;
  }

  /* 병력 편성이 비어 있을 때 편성판을 한 번 깜빡인다 */
  _nudgeArmy() {
    const panel = document.querySelector('.army-panel');
    if (!panel) return;
    panel.classList.remove('is-nudge');
    void panel.offsetWidth;          // 애니메이션 재시작
    panel.classList.add('is-nudge');
    clearTimeout(this._nudgeT);
    this._nudgeT = setTimeout(() => panel.classList.remove('is-nudge'), 950);
  }

  /* 지면 높이 (이펙트 y 보정) */
  _gy(x, z) {
    if (x === undefined || z === undefined) return 0;
    return groundY(x, z, !!(this.battle && this.battle.pvp));
  }

  _toast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);padding:8px 14px;border-radius:10px;background:rgba(8,10,14,.78);border:1px solid rgba(232,194,122,.3);color:#ffe6b4;font-size:11px;letter-spacing:.08em;opacity:0;transition:opacity .2s;pointer-events:none;z-index:30';
      // 홈에서도 보이도록 — 전장 밖이면 화면 전체(#app) 위에 띄운다
      const host = (this.state === 'battle' && $('#battle')) ? $('#battle') : ($('#app') || $('#battle'));
      host.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.style.opacity = '0'; }, 900);
  }

  /* 🎯 조준점 아래 적 체력 — 크로스헤어가 적 위에 오면 즉시 표시
     + 조준 높이로 🩸 부위(머리·팔·다리)를 판정해 전투에 넘긴다 */
  _updateAimInfo() {
    const b = this.battle;
    const el = document.getElementById('aimInfo');
    if (!b || !el) return;
    const p = b.player;
    const show = this.state === 'battle' && p && !p.dead && this.camMode !== 'spectate' && !this.debugCam;
    let best = null, bestT = 26;   // 26m 안쪽 적만 표시
    let hitY = 0, hitX = 0, hitZ = 0;
    if (show) {
      this.cam.getWorldDirection(_aimDir);
      const cx = this.cam.position.x, cy = this.cam.position.y, cz = this.cam.position.z;
      const units = b.units;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.dead || u === p) continue;
        const dx = u.x - cx, dz = u.z - cz;
        if (dx * dx + dz * dz > 26 * 26) continue;
        const uy = 1.05 * (u.cls === 'knight' ? 1.12 : 1) + (u.y || 0);
        const vy = uy - cy;
        const t = dx * _aimDir.x + vy * _aimDir.y + dz * _aimDir.z;
        if (t <= 0.5) continue;
        const px = dx - _aimDir.x * t, py = vy - _aimDir.y * t, pz = dz - _aimDir.z * t;
        const perp2 = px * px + py * py + pz * pz;
        const lim = 0.38 + t * 0.042 + (u.radius || 0.4);
        if (perp2 > lim * lim) continue;
        if (t < bestT) {
          bestT = t; best = u;
          hitY = cy + _aimDir.y * t; hitX = cx + _aimDir.x * t; hitZ = cz + _aimDir.z * t;
        }
      }
      // 가장 가까운 것이 아군이면 적은 가려져 있다 → 체력을 띄우지 않는다
      if (best && best.team === p.team) { best = null; }
    }
    if (!best) {
      if (this._aimOn) { el.classList.remove('is-on'); this._aimOn = false; this._aimKey = ''; }
      this.input.aimId = 0; this.input.aimPart = 'body';
      return;
    }
    // 부위 절단이 없다 — 에임은 항상 몸통
    this.input.aimId = best.id;
    this.input.aimPart = 'body';
    this._aimUnit = best;
    if (!this._aimOn) { el.classList.add('is-on'); this._aimOn = true; }
    const hp = Math.max(0, Math.ceil(best.hp));
    const mx = Math.max(1, Math.ceil(best.maxHp));
    const key = best.id + ':' + hp;
    if (key !== this._aimKey) {
      this._aimKey = key;
      const nEl = document.getElementById('aiName');
      const hEl = document.getElementById('aiHp');
      const bar = document.getElementById('aiBar');
      if (nEl) {
        if (best.pname) nEl.textContent = (best.team === p.team ? '아군 ' : '적 ') + best.pname;
        else nEl.textContent = '적 ' + (UNIT_KR[best.cls] || '병사');
      }
      if (hEl) hEl.textContent = hp + ' / ' + mx;
      if (bar) {
        bar.style.width = clamp((hp / mx) * 100, 0, 100) + '%';
        bar.classList.toggle('is-low', hp / mx < 0.3);
      }
    }
  }

  /* 크로스헤어 히트 마커 — 맞았을 때만 뜨다 */
  _hitMark(dmg, kill) {
    const el = document.getElementById('hitMark');
    if (!el) return;
    el.classList.remove('is-on', 'is-kill');
    void el.offsetWidth;                 // 애니메이션 재시작
    el.classList.add('is-on');
    if (kill) el.classList.add('is-kill');
    const d = document.getElementById('hitDmg');
    if (d) d.textContent = dmg ? String(Math.round(dmg)) : '';
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => el.classList.remove('is-on', 'is-kill'), kill ? 280 : 150);
  }

  /* 프레임 시간으로 품질을 자동 조절한다 (폰에서 먼저 부드러움을 지킨다) */
  _perfTick(dtMs) {
    if (this.quality === 'low') return;
    const s = this._ftSamples;
    s.push(dtMs);
    if (s.length < 90) return;
    s.sort((a, b) => a - b);
    const med = s[s.length >> 1];
    s.length = 0;
    this._slowTicks = 0;
    if (med > 26 && this.qualityStep > 0) this._setQuality(this.qualityStep - 1, med);
    else if (med < 11 && this.qualityStep < 2 && (this._fastTicks = (this._fastTicks || 0) + 1) >= 3) {
      this._fastTicks = 0; this._setQuality(this.qualityStep + 1, med);
    }
  }

  _setQuality(step, medMs) {
    this.qualityStep = step;
    const r = this.renderer;
    if (!r) return;
    const dpr = window.devicePixelRatio || 1;
    /* 해상도만 부드럽게 낮춘다 — 그림자 토글은 셰이더를 전부 재컴파일해서 순간 멈춤을 만든다.
       그림자는 시작할 때 한 번만 결정하고(품질 옵션), 여기서는 건드리지 않는다. */
    if (step >= 2) r.setPixelRatio(Math.min(dpr, 1.5));
    else if (step === 1) r.setPixelRatio(Math.min(dpr, 1.15));
    else r.setPixelRatio(1);
    /* 해상도와 함께 상세 모델 반경도 조절한다 (셰이더 재컴파일 없이 인스턴스만 줄어든다) */
    const ur = this.unitRenderer;
    if (ur) {
      if (step >= 2) { ur.lodNear = 15; ur.lodFar = 36; }
      else if (step === 1) { ur.lodNear = 13; ur.lodFar = 32; }
      else { ur.lodNear = 11; ur.lodFar = 27; }
    }
    if (medMs) console.log('PERF quality=' + step + ' median=' + medMs.toFixed(1) + 'ms dpr=' + r.getPixelRatio().toFixed(2));
  }

  _aimAssist() {
    const p = this.battle && this.battle.player;
    if (!p || p.dead) return;
    let best = null, bestA = 0.55;
    for (const u of this.battle.units) {
      if (u.team === p.team || u.dead) continue;
      const dx = u.x - p.x, dz = u.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 4.2) continue;
      const a = Math.abs(angDiff(Math.atan2(dx, dz), p.yaw));
      if (a < bestA) { bestA = a; best = u; }
    }
    if (best) p.yaw = Math.atan2(best.x - p.x, best.z - p.z);
  }

  castSpell(key) {
    const b = this.battle;
    if (!b || !b.player || b.player.dead) return;
    if (b.pvp && this.pvp) { this.pvp.castSpell(key); return; }
    const p = b.player;
    if (p.cls !== 'wizard') { this._toast('마법사 클래스에서만 사용할 수 있다'); return; }
    if (p.cd[key] > 0) return;
    // 조준점: 카메라 전방에서 가장 가까운 적, 없으면 전방 14m
    const dir = this.spellAimHelper.set(0, 0, -1).applyQuaternion(this.cam.quaternion);
    let aimEnemy = null, bestA = 0.30;
    for (const u of b.units) {
      if (u.team === p.team || u.dead) continue;
      const dx = u.x - p.x, dz = u.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > SPELLS[key].range) continue;
      const a = Math.abs(angDiff(Math.atan2(dx, dz), p.yaw));
      if (a < bestA) { bestA = a; aimEnemy = u; }
    }
    const yaw = Math.atan2(dir.x, dir.z);
    p.yaw = aimEnemy ? Math.atan2(aimEnemy.x - p.x, aimEnemy.z - p.z) : this.camYaw + Math.PI;
    if (key === 'fire') {
      const tx = aimEnemy ? aimEnemy.x : p.x + Math.sin(p.yaw) * 14;
      const tz = aimEnemy ? aimEnemy.z : p.z + Math.cos(p.yaw) * 14;
      b.castSpell(p, key, { x: tx, z: tz });
    } else if (key === 'lightning') {
      if (aimEnemy) p.target = aimEnemy;
      if (!aimEnemy) {
        // 정면 부채꼴에서 가장 가까운 적
        let best = null, bd = 1e9;
        for (const u of b.units) {
          if (u.team === p.team || u.dead) continue;
          const dx = u.x - p.x, dz = u.z - p.z;
          const d = Math.hypot(dx, dz);
          if (d > SPELLS.lightning.range) continue;
          if (Math.abs(angDiff(Math.atan2(dx, dz), p.yaw)) > 0.9) continue;
          if (d < bd) { bd = d; best = u; }
        }
        if (best) p.target = best;
      }
      if (!aimEnemy && !p.target) { this._toast('사거리 안에 적이 없다'); return; }
      b.castSpell(p, key, { yaw: p.yaw });
    } else if (key === 'ice') {
      b.castSpell(p, key, { yaw: p.yaw });
    }
    this.vm.triggerCast();
    this._beep();
  }

  useSkill() {
    const b = this.battle;
    if (!b || !b.player || b.player.dead) return;
    if (b.pvp && this.pvp) { this.pvp.useSkill(); return; }
    const p = b.player;
    if (p.cls !== 'blademaster') return;
    if (b.useSkill(p)) {
      this.sfx.spell('ice', 0);
      this.vm.triggerCast();
      this._toast('🌸 매화 일섬!');
    } else if (p.cd.petal > 0) {
      this._toast(`매화 일섬 ${p.cd.petal.toFixed(1)}초`);
    }
  }

  /* ------------------------------------------------------------------ 카메라 */
  updateCamera(dt) {
    const b = this.battle;
    if (!b) return;
    const p = b.player;
    if (this.debugCam) { this.vm.enabled = false; p.hideModel = true; return; }

    if (this.camMode === 'fp') {
      const spec = CLASSES[p.cls];
      const eye = spec.viewEye;
      // 화면 흔들림 없음 — 걸음 헤드밥·호흡·공격/피격 반동·시선 롤을 모두 제거했다.
      // 카메라는 눈높이에 정확히 고정되고, 시점만 드래그한 그대로 유지된다.
      this.cam.position.set(p.x, (p.y || 0) + (p.dead ? 0.92 : eye), p.z);
      this.camYaw = p.yaw + Math.PI;
      this.cam.rotation.set(this.camPitch, this.camYaw, 0, 'YXZ');
      this.cam.fov = 62;
      this.cam.updateProjectionMatrix();
      this.vm.enabled = !p.dead;
    } else {
      // 🎬 관전 — 보는 방향 그대로 3D 자유 비행
      // 왼쪽 조이스틱 = 시선 방향 전후좌우 + 위아래 고도, 오른쪽 드래그 = 시선 회전
      if (!this.spectate) this._enterSpectate();
      const s = this.spectate;
      const mx = this.input.mx || 0, mz = this.input.mz || 0;
      const mag = Math.min(1, Math.hypot(mx, mz));
      if (mag > 0.06) {
        this._spectateIdle = 0;
        this.autoSpectate = false;
        const spd = 20 * mag;
        // 수평 — 카메라가 보는 정면(s.yaw) 그대로 조이스틱 방향으로 난다
        const d = joyToWorld(s.yaw, mx, mz);
        s.x += d.x * spd * dt;
        s.z += d.z * spd * dt;
        // 수직 — 아래를 보며 앞으로 가면 땅으로 내려가고, 위를 보며 가면 하늘로 올라간다.
        //        뒤로 당기면 반대. 병사가 다니는 높이(1.2m)부터 성채 위 하늘(120m)까지 자유롭게.
        s.y = clamp(s.y + Math.sin(s.pitch) * mz * spd * dt, SPECTATE_MIN_Y, SPECTATE_MAX_Y);
      } else {
        this._spectateIdle += dt;
        if (this.autoSpectate && this._spectateIdle > 2.2) s.yaw += dt * 0.055;
      }
      // 🎬 관전은 맵 안이면 어디든 — 땅 아래와 전장 바깥 허공만 막는다 (AI 병사가 못 가는 곳도 구경 가능)
      const bound = Math.max((b.arenaR || 60) + 35, 95);
      s.x = clamp(s.x, -bound, bound);
      s.z = clamp(s.z, -bound, bound);
      s.y = clamp(s.y, SPECTATE_MIN_Y, SPECTATE_MAX_Y);
      /* ⛰️ 관전 카메라도 지면 아래로 파고들지 못한다 */
      s.y = Math.max(s.y, groundY(s.x, s.z, !!b.pvp) + 0.7);
      const cp = Math.cos(s.pitch), sp2 = Math.sin(s.pitch);
      this.cam.position.set(s.x, s.y, s.z);
      this.cam.lookAt(s.x + Math.sin(s.yaw) * cp * 60, s.y + sp2 * 60, s.z + Math.cos(s.yaw) * cp * 60);
      this.cam.fov = 66;
      this.cam.updateProjectionMatrix();
      this.vm.enabled = false;
    }

    // 플레이어 자신의 몸은 1인칭에서 숨긴다
    if (b.player) b.player.hideModel = this.camMode === 'fp';
  }

  /* ------------------------------------------------------------------ 루프 */
  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    let dt = this.last ? (now - this.last) / 1000 : 0.016;
    this.last = now;
    dt = Math.min(0.05, Math.max(0.0005, dt));
    if (this.state !== 'battle' || !this.battle) return;
    this.time += dt;

    // 히트스톱 — 내가 때린 순간만 짧게 무게를 준다. (AI 타격까지 겹치면 전장이 영원히 느려지던 문제)
    let scale = 1;
    if (this.battle.hitStop > 0) {
      this.battle.hitStop = Math.min(0.10, Math.max(0, this.battle.hitStop - dt));
      scale = 0.35;
    }

    // 탭 막기 최소 유지 시간
    if (this.guardMinT > 0) this.guardMinT = Math.max(0, this.guardMinT - dt);

    const p = this.battle.player;
    const spectating = this.camMode === 'spectate';
    // 입력 → 전투 (프레임이 길어지면 잘게 나눠 시뮬레이션한다 — 접촉 프레임을 놓치지 않게)
    if (!this.paused && !this.debugLock) {
      this.input.mx = this.input.mx || 0;
      if (this.attackHeld && p.cooldown <= 0 && p.attackT < 0) {
        if (!spectating) this._aimAssist();
      }
      const cmd = {
        mx: spectating ? 0 : this.input.mx,
        mz: spectating ? 0 : this.input.mz,
        yaw: p.yaw,
        guard: spectating ? false : (!!this.input.guard || (this.guardMinT || 0) > 0),
        attack: spectating ? false : !!this.input.attack,
        hold: spectating ? false : !!this.attackHeld,
        aimPart: this.input.aimPart || 'body',
        aimId: this.input.aimId || 0
      };
      const total = dt * scale;
      const sub = Math.min(3, Math.max(1, Math.ceil(total / (1 / 60))));
      const sdt = total / sub;
      for (let s = 0; s < sub; s++) this.battle.update(sdt, cmd);
      this.input.attack = false;
      // 키보드 이동
      if (!spectating && this.keys && (this.keys.KeyW || this.keys.KeyA || this.keys.KeyS || this.keys.KeyD)) {
        const kx = (this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0);
        const kz = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);
        const d = joyToWorld(p.yaw, kx, kz);
        const sp = CLASSES[p.cls].speed;
        p.x += d.x * sp * dt; p.z += d.z * sp * dt;
        p.moveAmt = Math.min(1, Math.hypot(kx, kz));
        p.walkPhase += dt * 6.4;
      }
      // 카메라 시점 → 플레이어 방향 (1인칭)
      if (!spectating) {
        p.yaw = this.camYaw + Math.PI;
        p.pitch = this.camPitch;
      }
    }

    // 디버그 포즈 잠금
    if (this.debugLock) {
      const { unit, kind, t } = this.debugLock;
      if (unit) {
        if (kind === 'death') {
          unit.dead = true; unit.deadT = t; unit.hp = 0;
        } else if (kind === 'attack') {
          unit.attackT = t; unit.hitDone = true;
        }
      }
    }

    // 플레이어 공격 시작 → 휘두르는 소리
    if (p && p.attackT >= 0 && this._lastAtkT === -1) {
      this.sfx.swing(p.cls);
      if (this.vm) this.vm.impulse(0.0);
    }
    this._lastAtkT = p ? p.attackT : -1;

    // 포즈 계산 — 상세 모델로 그려지는 유닛만 (실루엣은 yaw 만으로 그린다 → 대규모에서 큰 절약)
    const units = this.battle.units;
    /* ⛰️ 모든 유닛이 지면 높이를 따라간다 (언덕·경사·옥타곤 매트) */
    const gf = this.battle.groundFn;
    if (gf) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        u.y = gf(u.x, u.z);
      }
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.isPlayer && u.dslot < 0) continue;
      if (u.dead && u.deadT > 4.2) continue;
      computePose(u, this.time, dt);
    }

    this.updateCamera(dt);
    if (this.battle.pvp && this.pvp) this.pvp.tick(dt);
    const camPos = this.cam.position;

    /* 1인칭 — 코앞에 붙은 아군도 숨기지 않는다. 아군이 시야를 가리는 것은 그대로 둔다 */

    // 렌더러
    if (this.unitRenderer) this.unitRenderer.update(units, camPos, this.time, dt);

    // 이펙트
    const events = this.battle.drain();
    this.fx.handle(events, this.battle);
    for (const e of events) this._onEvent(e);

    this.fx.update(dt, this.battle, this.cam);
    this.world.update(dt, this.time, camPos);

    // 뷰모델
    if (this.vm) {
      this.vm.update(dt, p, this.input, this.time, this.camYaw + Math.PI, this.camPitch);
      if (this.camMode === 'fp' && this.vm.enabled && !this.debugCam) {
        if (p.attackT >= 0) {
          const base = _v1, tip = _v2;
          if (this.vm.bladePoints(base, tip)) {
            this.fx.playerBlade(base, tip, 1.55);
            this.fx.spawnBladeSparks(base, tip, p.cls);
          }
        }
        // 타격 순간 전방에 선명한 초승달 검기를 그린다
        const atkNow = p.attackT;
        if (atkNow < 0 || atkNow < (this._prevAtk || 0)) this._arcSpawned = false;
        if (atkNow >= 0 && !this._arcSpawned && atkNow >= impactAt(p.cls) - 0.03) {
          this._arcSpawned = true;
          const petal = p.cls === 'blademaster';
          const d = p.cls === 'knight' ? 3.6 : p.cls === 'berserker' ? 1.9 : 3.2;
          const ax = p.x + Math.sin(p.yaw) * d;
          const az = p.z + Math.cos(p.yaw) * d;
          this.fx.spawnArc(ax, 1.12, az, p.yaw, p.cls === 'knight' ? 0.86 : p.cls === 'berserker' ? 0.40 : petal ? 0.62 : 0.56,
            'blade', 0.17, petal ? 0xffd0e6 : 0xeaf9ff, 0.06);
          if (petal) {
            for (let i = 0; i < 12; i++) {
              const a = this.fx.rng() * TAU;
              this.fx.petals.spawn({
                x: ax + Math.cos(a) * 0.6, y: 1.0 + (this.fx.rng() - 0.5) * 1.2, z: az + Math.sin(a) * 0.6,
                vx: Math.cos(a) * (0.8 + this.fx.rng() * 2.2), vy: 0.5 + this.fx.rng() * 2.0, vz: Math.sin(a) * (0.8 + this.fx.rng() * 2.2),
                life: 0.7 + this.fx.rng() * 0.8, size: 0.06 + this.fx.rng() * 0.07,
                r: 1, g: 0.82, b: 0.93, alpha: 0.95, gravity: -3.0, drag: 1.3, grow: 0.04, fade: 1.1
              });
            }
          }
        }
        this._prevAtk = atkNow;
      }
    }

    // 승패 배너는 마지막 사망 모션이 끝난 뒤에 — 판정되자마자 화면을 덮지 않는다
    if (this._pendingResult) {
      this._pendingT = (this._pendingT || 0) + dt;
      if (this._pendingT >= (this._pendingDelay || 1.4)) {
        const w = this._pendingResult;
        this._pendingResult = null;
        this._finish(w);
      }
    }

    // HUD
    this._syncHUD(false);
    this._syncInputUI();
    this._updateAimInfo();

    // 자동 품질 조절 (폰 발열·끊김 완화)
    this._perfTick(dt * 1000);

    // 렌더
    /* 🧪 테스트 전용 — 뒤 탭의 GPU 부담을 끊는다 (시뮬레이션·네트워크는 그대로 돈다) */
    if (this.noRender) { this.frames++; return; }
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.cam);
    if (this.camMode === 'fp' && !p.dead && this.vm.enabled && !this.debugCam) {
      this.vm.render(r, window.innerWidth, window.innerHeight);
    }
    this.frames++;
  }

  _onEvent(e) {
    const cam = this.cam ? this.cam.position : null;
    const dOf = (x, z) => (cam ? Math.hypot(cam.x - x, cam.z - z) : 0);
    if (e.type === 'spawn' && e.unit && this.unitRenderer) {
      this.unitRenderer.addUnit(e.unit, e.unit.cls);   // 증원병도 화면에 그린다
      return;
    }
    if (e.type === 'hit') {
      this.sfx.hit(e.kind, dOf(e.hx, e.hz), !!(e.source && e.source.isPlayer));
      // 내가 친 타격만 화면에 표시한다 (안 맞았을 땐 아무것도 안 뜬다)
      if (e.source && e.source.isPlayer) {
        this._hitMark(e.dmg, e.lethal);
        this.fx.addShake(0.05);
      }
    } else if (e.type === 'slam') {
      this.sfx.hit('hammer', dOf(e.x, e.z), true);
    } else if (e.type === 'block') {
      // 🛡️ 방패 막힘 — 스파크·둥근 충격파 + 철제 "쨍" + 내가 막았을 때 토스트
      const gy = this._gy(e.x, e.z);
      const by = (e.y || 1.1) + gy;
      this.sfx.block(dOf(e.x, e.z), e.heavy);
      this.fx.spawnShieldSparks(e.x, by, e.z, e.heavy);
      /* ⚔️ 패링 100% 반사 — 금빛 폭발 + 화면 흔들림 (양쪽 화면 모두) */
      if (e.reflect > 0) {
        this.fx.flash(e.x, by, e.z, 1.9, 0xffe6a8, 0.15);
        this.fx.ring(e.x, by, e.z, 1.6, 0xffcf7a, 0.40);
        this.fx.addShake(0.26);
      }
      /* 🛡️ 막아낸 쪽은 팔·상체가 뒤로 튀는 반동을 포즈로 보여준다 */
      if (e.unit) e.unit.guardFlash = Math.max(e.unit.guardFlash || 0, 0.26);
      if (e.unit && e.unit.isPlayer && this.vm) this.vm.impulse(-0.05);
      if (e.unit && e.unit.isPlayer) {
        if (!this._blockToastAt || performance.now() - this._blockToastAt > 700) {
          this._blockToastAt = performance.now();
          this._toast(e.reflect > 0
            ? '⚔️ 패링! ' + Math.round(e.reflect) + ' 피해를 그대로 돌려줬다'
            : (e.heavy ? '🛡️ 강타를 막아냈다!' : '🛡️ 막았다!'));
        }
      }
    } else if (e.type === 'explode') {
      this.sfx.explode(dOf(e.x, e.z));
    } else if (e.type === 'lightning') {
      const t0 = e.targets && e.targets[0] ? e.targets[0].o : null;
      this.sfx.spell('lightning', t0 ? dOf(t0.x, t0.z) : 0);
    } else if (e.type === 'ice') {
      this.sfx.spell('ice', e.unit ? dOf(e.unit.x, e.unit.z) : 0);
    } else if (e.type === 'cast') {
      if (e.spell !== 'lightning' && e.spell !== 'ice') this.sfx.spell(e.spell, e.unit ? dOf(e.unit.x, e.unit.z) : 0);
    } else if (e.type === 'death') {
      const u = e.unit;
      this.sfx.death(u ? dOf(u.x, u.z) : 0);
    } else if (e.type === 'guardEmpty') {
      if (e.unit && e.unit.isPlayer) this._toast('🛡️ 방패 충전을 다 썼다 — 19초 재충전');
    } else if (e.type === 'guardReady') {
      if (e.unit && e.unit.isPlayer) this._toast('🛡️ 방패 5회 회복');
    } else if (e.type === 'levelUp') {
      this.sfx.levelUp();
    }
    if (e.type === 'end') {
      // 🏆 마지막 적의 사망 모션이 끝날 때까지 배너를 미룬다 (사망 모션을 끊지 않는다)
      this._pendingResult = e.winner;
      this._pendingDelay = e.delay || 1.4;
      this._pendingT = 0;
    } else if (e.type === 'playerDown') {
      this._toast('쓰러졌다 — 잠시 후 부활');
    } else if (e.type === 'levelUp') {
      if (!(this.battle && this.battle.pvp)) { this.progress.kills = e.kills; this._scheduleSave(); }
    } else if (e.type === 'death' && e.by && e.by.isPlayer) {
      if (!(this.battle && this.battle.pvp)) { this.progress.kills = this.battle.playerKills; this._scheduleSave(); }
    }
  }

  _scheduleSave() {
    if (!this.progress) return;
    saveProgress(this.progress);
    this.progressSavedAt = performance.now();
  }

  _finish(winner) {
    const b = this.battle;
    if (!b) return;
    if (this._resultShown) return;
    this._resultShown = true;
    if (this._aimOn) { const el = document.getElementById('aimInfo'); if (el) el.classList.remove('is-on'); this._aimOn = false; }
    const won = winner === 'ally';
    $('#resEmblem').textContent = won ? '🏆' : '💀';
    $('#resTitle').textContent = won ? '승리' : '패배';
    $('#resSub').textContent = won ? '적군을 전멸시켰다' : '아군이 전멸했다';
    $('#resKills').textContent = b.playerKills.toLocaleString();
    // 🤝 아군 생존 수도 플레이어 본인을 빼고 센다
    $('#resAlive').textContent = Math.max(0, b.countAlive('ally') - 1).toLocaleString();
    $('#resGrow').textContent = growthLabel(this.progress.kills);
    $('#result').classList.add('is-on');
    this.progress.kills = b.playerKills;
    saveProgress(this.progress);
    this.paused = true;
    this._syncHome();
  }

  /* ------------------------------------------------------------------ HUD */
  _syncHUD(force) {
    const b = this.battle;
    if (!b) return;
    const p = b.player;
    const tal = b.tally;
    let allyRaw = 0, enemy = 0;
    for (const c of BUCKET_KEYS) { allyRaw += tal.ally[c] || 0; enemy += tal.enemy[c] || 0; }
    // ⚔️ 상단 전장/예비/총 아군 수에는 '플레이어 본인'을 세지 않는다
    const ally = Math.max(0, allyRaw - (p && !p.dead && !p.removed ? 1 : 0));
    const aRes = b.reserveTotal ? b.reserveTotal('ally') : 0;
    const eRes = b.reserveTotal ? b.reserveTotal('enemy') : 0;
    const totalA = Math.max(1, (this._initialAlly || 1) - 1);
    const totalE = Math.max(1, this._initialEnemy || 1);
    const cache = this._hudCache;
    if (force || cache.ally !== ally) { $('#allyCount').textContent = ally.toLocaleString(); cache.ally = ally; }
    if (force || cache.enemy !== enemy) { $('#enemyCount').textContent = enemy.toLocaleString(); cache.enemy = enemy; }
    if (force || cache.aRes !== aRes) {
      const el = $('#allyReserve'); if (el) el.textContent = '+' + aRes.toLocaleString();
      const row = $('#allyCount').parentElement; if (row) row.title = '전장 ' + ally + '명(플레이어 제외) · 예비 ' + aRes + '명 (합계 ' + (ally + aRes) + '명)';
      cache.aRes = aRes;
    }
    if (force || cache.eRes !== eRes) {
      const el = $('#enemyReserve'); if (el) el.textContent = '+' + eRes.toLocaleString();
      const row = $('#enemyCount').parentElement; if (row) row.title = '전장 ' + enemy + '명 · 예비 ' + eRes + '명 (합계 ' + (enemy + eRes) + '명)';
      cache.eRes = eRes;
    }
    $('#allyBar').style.width = clamp(((ally + aRes) / totalA) * 100, 0, 100) + '%';
    $('#enemyBar').style.width = clamp(((enemy + eRes) / totalE) * 100, 0, 100) + '%';
    const hpPct = clamp((p.hp / Math.max(1, p.maxHp)) * 100, 0, 100);
    $('#hpBar').style.width = hpPct + '%';
    const hpTxt = `${Math.max(0, Math.ceil(p.hp))} / ${Math.ceil(p.maxHp)}`;
    if (force || cache.hp !== hpTxt) { $('#hpText').textContent = hpTxt; cache.hp = hpTxt; }
    if (force || cache.cls !== p.cls) {
      $('#psClass').textContent = CLASSES[p.cls].icon;
      cache.cls = p.cls;
    }
    if (force || cache.grow !== this.progress.kills) {
      $('#psGrow').textContent = growthLabel(this.progress.kills);
      cache.grow = this.progress.kills;
    }
    /* PVP 는 영구 성장(처치 누적)을 건드리지 않는다 — 배틀 아레나 기록을 그대로 둔다 */
    if (!b.pvp && this._savedKills !== b.playerKills) {
      this._savedKills = b.playerKills;
      this.progress.kills = b.playerKills;
      saveProgress(this.progress);
      this._syncHome();
    }
    if (force || cache.kills !== b.playerKills) {
      $('#killCount').textContent = b.playerKills.toLocaleString();
      $('#killPct').textContent = growthLabel(b.playerKills);
      cache.kills = b.playerKills;
    }
    // 에임 아래 공속 게이지 (팔을 잃으면 느려진 주기를 그대로 반영)
    const gauge = $('#aimGauge');
    if (gauge) {
      const cyc = p.cycle || CLASSES[p.cls].cycle;
      const imp = impactAt(p.cls);
      let k;
      if (p.attackT >= 0 && !p.dead) {
        k = clamp((p.attackT - imp) / Math.max(0.001, cyc - imp), 0, 1);
      } else {
        k = 1 - clamp(p.cooldown / Math.max(0.001, cyc), 0, 1);
      }
      const w = (k * 100).toFixed(1) + '%';
      if (force || cache.gauge !== w) { gauge.querySelector('i').style.width = w; cache.gauge = w; }
      gauge.classList.toggle('is-ready', p.cooldown <= 0.02 && !p.dead);
      gauge.classList.toggle('is-knight', p.cls === 'knight');
      gauge.classList.toggle('is-wizard', p.cls === 'wizard');
      gauge.style.display = p.dead ? 'none' : '';
    }
    // 🎯 조준점 — 지금 공격하면 맞는 적이 있으면 색이 바뀐다 (판정은 실제 베기와 동일)
    const ret = document.getElementById('reticle');
    if (ret) {
      const hit = !p.dead && this.camMode !== 'spectate' && !this.paused && !!b.aimTarget();
      if (this._retHit !== hit) { this._retHit = hit; ret.classList.toggle('is-hit', hit); }
    }
    // 쿨타임 — 편집기 미리보기의 마법 버튼은 제외하고 실제 전장 HUD 만
    $$('#battle .spell-btn').forEach((btn) => {
      const key = btn.dataset.spell;
      const cd = p.cd[key] || 0;
      const max = SPELLS[key].cooldown;
      const on = p.cls === 'wizard';
      btn.style.display = on ? '' : 'none';
      const mask = btn.querySelector('.cd-mask');
      const num = btn.querySelector('.cd-num');
      if (cd > 0.05) {
        btn.classList.add('is-cd');
        mask.style.transform = `scaleY(${clamp(cd / max, 0, 1)})`;
        num.textContent = cd < 1 ? cd.toFixed(1) : Math.ceil(cd);
      } else {
        btn.classList.remove('is-cd');
        mask.style.transform = 'scaleY(0)';
      }
    });
    const skBtn = $('#skillBtn');
    if (skBtn) {
      const on = p.cls === 'blademaster';
      skBtn.classList.toggle('is-on', on);
      const cd = p.cd.petal || 0;
      const mask = skBtn.querySelector('.cd-mask');
      const num = skBtn.querySelector('.cd-num');
      skBtn.classList.toggle('is-cd', cd > 0.05);
      mask.style.transform = `scaleY(${clamp(cd / SKILL.cooldown, 0, 1)})`;
      num.textContent = cd > 0 ? Math.ceil(cd) : '';
      skBtn.querySelector('.sk-label').textContent = cd > 0 ? '충전' : '매화 일섬';
    }
    // 🛡️ 막기 버튼 — 일반 병사·고급 병사·매화 검객만 (기사·마법사·단검 광전사는 막기 불가)
    const gdBtn = $('#guardBtn');
    if (gdBtn) {
      const canGuard = (CLASSES[p.cls] || CLASSES.soldier).guard !== false;
      gdBtn.classList.toggle('is-on', canGuard);
      const chEl = document.getElementById('guardCharges');
      if (chEl) chEl.style.display = 'none';
      gdBtn.classList.remove('is-empty');
      const lbl = gdBtn.querySelector('.sk-label');
      const ic = gdBtn.querySelector('.sk-icon');
      /* ⚔️ PVP — 막기 유지 시간과 쿨타임을 버튼에 그대로 보여준다 */
      if (b.pvp && this.pvp) {
        const pv = this.pvp;
        const cd = Math.max(0, pv.guardCd || 0);
        const isCd = cd > 0.05;
        const held = !!pv.guardActive;
        gdBtn.classList.toggle('is-cd', isCd);
        gdBtn.classList.toggle('is-guardcd', isCd);
        gdBtn.classList.toggle('is-guarding', held);
        const mask = gdBtn.querySelector('.cd-mask');
        if (mask) mask.style.transform = 'scaleY(' + clamp(cd / Math.max(0.1, pv.guardCdMax), 0, 1).toFixed(3) + ')';
        const num = gdBtn.querySelector('.cd-num');
        if (num) num.textContent = isCd ? (cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd))) : '';
        const want = held ? '막는 중' : isCd ? '재장전' : '검 막기';
        if (lbl && lbl.textContent !== want) lbl.textContent = want;
        if (ic) ic.textContent = isCd && !held ? '⏳' : '🗡️';
        const ring = gdBtn.querySelector('.gd-ring');
        if (ring) ring.style.transform = 'scaleX(' + (held ? clamp((pv.guardLeft || 0) / Math.max(0.1, pv.guardHoldMax), 0, 1).toFixed(3) : 0) + ')';
      } else {
        gdBtn.classList.remove('is-cd', 'is-guardcd', 'is-guarding');
        const mask = gdBtn.querySelector('.cd-mask');
        if (mask) mask.style.transform = 'scaleY(0)';
        const num = gdBtn.querySelector('.cd-num');
        if (num) num.textContent = '';
        const want = '검 막기';
        if (lbl && lbl.textContent !== want) lbl.textContent = want;
        if (ic) ic.textContent = '🗡️';
      }
    }
    const atkBtn = $('#attackBtn');
    atkBtn.style.display = p.cls === 'wizard' ? 'none' : '';
    if (p.cls !== 'wizard') {
      const cd = Math.max(0, p.cooldown);
      atkBtn.classList.toggle('is-cd', cd > 0.05);
      atkBtn.querySelector('.ab-label').textContent = p.cls === 'knight' ? '내려치기' : p.cls === 'berserker' ? '연타' : '베기';
      atkBtn.querySelector('.ab-icon').textContent = p.cls === 'knight' ? '🔨' : p.cls === 'berserker' ? '🩸' : '⚔️';
      atkBtn.title = p.cls === 'berserker' ? '꾹 누르고 있으면 자동 연타' : '공격';
    }
    // 사망
    const veil = $('#deadVeil');
    if (p.dead) {
      veil.classList.add('is-on');
      if (!b.pvp) $('#respawnT').textContent = Math.max(0, Math.ceil(3.6 - b.playerDeadT));
      else if (this.pvp && this.pvp.me) $('#respawnT').textContent = Math.max(0, Math.ceil(this.pvp.me.r || 0));
    } else veil.classList.remove('is-on');
    // 피격 비네트 — 맞으면 가장자리가 확 붉게 번지고 빠르게 깜빡인다
    const hv = $('#hitVignette');
    const hf = this.fx ? this.fx.hitFlash : 0;
    hv.style.opacity = String(clamp(hf * 1.15, 0, 0.92));
    hv.classList.toggle('is-strong', hf > 0.72);
  }

  _syncInputUI() {
    const p = this.battle && this.battle.player;
    if (!p) return;
  }
}

/* ---------------------------------------------------------------------------
   부트
   --------------------------------------------------------------------------- */
const app = new App();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* 테스트/디버그 API */
window.__THREE = THREE;
window.BA = {
  app,
  get battle() { return app.battle; },
  /* 🥊 PVP 옥타곤 링 정보 (테스트·디버그) */
  oct: () => (app.octagon ? app.octagon.info() : null),
  ground: (x, z) => groundY(x, z, !!(app.battle && app.battle.pvp)),
  /* 🥊 옥타곤 경계 계산 (테스트용) */
  ring: (x, z) => clampOctagon(x, z),
  state() {
    const b = app.battle;
    if (!b) return { state: app.state, frames: app.frames };
    const p = b.player;
    return {
      state: app.state,
      frames: app.frames,
      time: app.time,
      units: b.units.length,
      ally: b.countAlive('ally'),
      enemy: b.countAlive('enemy'),
      alive: b.units.filter((u) => !u.dead && !u.removed).length,
      corpses: b.units.filter((u) => u.dead && !u.removed).length,
      removed: b.units.filter((u) => u.removed).length,
      playerKills: b.playerKills,
      growth: growthLabel(b.playerKills),
      localStorageKills: loadProgress().kills,
      player: p ? {
        cls: p.cls, x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, maxHp: p.maxHp,
        dead: p.dead, attackT: p.attackT, guard: !!p.guard, cd: { ...p.cd }, kills: b.playerKills,
        severed: { ...p.severed },
        speed: p.speed, cycle: p.cycle, behead: !!p.behead, deathKind: p.deathKind || null
      } : null,
      spells: b.spells.length,
      drawCalls: app.renderer ? app.renderer.info.render.calls : 0,
      triangles: app.renderer ? app.renderer.info.render.triangles : 0,
      camMode: app.camMode,
      cam: app.cam ? {
        x: app.cam.position.x, y: app.cam.position.y, z: app.cam.position.z,
        pitch: app.cam.rotation.x, yaw: app.cam.rotation.y, roll: app.cam.rotation.z,
        fov: app.cam.fov
      } : null,
      camPitch: app.camPitch,
      camYaw: app.camYaw,
      spectate: app.spectate ? {
        x: app.spectate.x, y: app.spectate.y, z: app.spectate.z,
        yaw: app.spectate.yaw, pitch: app.spectate.pitch
      } : null,
      playerSafe: !!b.playerSafe,
      playerInvuln: b.playerInvuln || 0,
      arenaR: b.arenaR || 0,
      ctxLost: app.renderer ? app.renderer.getContext().isContextLost() : null,
      glError: app.renderer ? app.renderer.getContext().getError() : null,
      hitStop: b.hitStop,
      practice: !!b.practice,
      field: { ally: b.countAlive('ally'), enemy: b.countAlive('enemy') },
      allyNoPlayer: Math.max(0, b.countAlive('ally') - (p && !p.dead ? 1 : 0)),
      reserve: { ally: b.reserveTotal('ally'), enemy: b.reserveTotal('enemy') },
      totals: { ally: b.initialTotalAlly, enemy: b.initialTotalEnemy },
      resultDelay: b.resultDelay, overAt: b.endAt,
      over: b.over
    };
  },
  config: () => ({ ...app.cfg }),
  /* 밸런스 스펙 (테스트·디버그) */
  specs: () => ({ classes: CLASSES, skill: SKILL, spells: SPELLS, guardChance: GUARD_CHANCE, regen: REGEN_FRAC, lifesteal: LIFESTEAL }),
  /* 시점 감도 (테스트·디버그) — 지금 화면 기준 실제 적용값 */
  look: () => ({
    sens: LOOK_SENS, pitch: LOOK_PITCH_SENS, spec: SPEC_SENS, specPitch: SPEC_PITCH_SENS,
    fsBoost: FS_SENS_BOOST, fullscreen: isFullscreen(),
    now: { sens: lookSens(LOOK_SENS), spec: lookSens(SPEC_SENS) }
  }),
  setConfig(cfg) {
    Object.assign(app.cfg, cfg || {});
    app._syncHome();
  },
  start(cfg) {
    if (cfg) {
      if (cfg.cls) app.cfg.playerClass = cfg.cls;
      if (cfg.ally !== undefined) app.cfg.allySoldiers = Number(cfg.ally);
      if (cfg.enemy !== undefined) app.cfg.enemySoldiers = Number(cfg.enemy);
      if (cfg.ak !== undefined) app.cfg.allyKnights = Number(cfg.ak);
      if (cfg.ek !== undefined) app.cfg.enemyKnights = Number(cfg.ek);
      if (cfg.aw !== undefined) app.cfg.allyWizards = Number(cfg.aw);
      if (cfg.ew !== undefined) app.cfg.enemyWizards = Number(cfg.ew);
      if (cfg.ab !== undefined) app.cfg.allyBlademasters = Number(cfg.ab);
      if (cfg.eb !== undefined) app.cfg.enemyBlademasters = Number(cfg.eb);
      if (cfg.ae !== undefined) app.cfg.allyElites = Number(cfg.ae);
      if (cfg.ee !== undefined) app.cfg.enemyElites = Number(cfg.ee);
      if (cfg.abz !== undefined) app.cfg.allyBerserkers = Number(cfg.abz);
      if (cfg.ebz !== undefined) app.cfg.enemyBerserkers = Number(cfg.ebz);
    }
    app.startBattle();
  },
  home() { app.toHome(); },
  setCameraMode(m) {
    app.camMode = m;
    if (m === 'spectate') { app.spectate = null; app._enterSpectate(); }
  },
  cast(key) { app.castSpell(key); },
  skill() { app.useSkill(); },
  attack() { app.input.attack = true; },
  setPlayerClass(cls) { app.cfg.playerClass = cls; app.vm.setClass(cls); app._syncHome(); },
  get hudLayout() { return app.hudLayout; },
  /* ⚔️ 플레이어 PVP (테스트·디버그) */
  pvp: {
    get client() { return app.pvp; },
    state: () => (app.pvp ? app.pvp.debugState() : null),
    lobby: () => (app.pvp ? app.pvp.lobby : null),
    create: (name) => { if (name) { const el = document.getElementById('pvpName'); if (el) el.value = name; } return app.pvp.create(); },
    join: (code, name) => {
      if (name) { const el = document.getElementById('pvpName'); if (el) el.value = name; }
      const c = document.getElementById('pvpCode'); if (c) c.value = String(code || '').toUpperCase();
      return app.pvp.join();
    },
    leave: () => app.pvp.exitToHome(),
    lookAt: (id) => app.pvp.lookAt(id),
    swing: () => app.pvp.swing(),
    guard: (on) => app.pvp.guard(on),
    cast: (k) => app.pvp.castSpell(k),
    skill: () => app.pvp.useSkill(),
    send: (o) => app.pvp.send(o),
    team: (t) => app.pvp.send({ type: 'pteam', team: t }),
    cls: (c) => app.pvp.send({ type: 'pclass', cls: c }),
    start: () => app.pvp.send({ type: 'pstart' }),
    conf: (o) => app.pvp.send(Object.assign({ type: 'pconf' }, o || {})),
    rematch: () => app.pvp.rematch()
  },
  fullscreen: {
    toggle: () => (app.fs ? app.fs.toggle() : Promise.resolve(false)),
    sync: () => (app.fs ? app.fs.sync() : false),
    isOn: () => isFullscreen(),
    supported: () => fullscreenSupported()
  },
  debug: {
    pause(v) { app.paused = v === undefined ? true : !!v; },
    pose({ cls, kind, t, side }) {
      const b = app.battle;
      if (!b) return false;
      app.paused = true;
      const u = b.units.find((x) => x.cls === cls && !x.isPlayer && x.team === 'ally') ||
                b.units.find((x) => x.cls === cls && !x.isPlayer);
      if (!u) return false;
      // 시야 확보를 위해 근처로 이동
      u.x = 0; u.z = 0; u.yaw = Math.PI; u.dead = false; u.deadT = 0; u.removed = false;
      if (kind === 'death') { u.dead = true; u.hp = 0; u.deadT = t || 0.3; } else { u.dead = false; u.attackT = t || 0.3; u.hitDone = true; }
      app.debugLock = { unit: u, kind: kind || 'attack', t: t || 0.3 };
      // 카메라
      app.camMode = 'fp';
      app.vm.enabled = false;
      const ang = side === 'left' ? -0.8 : side === 'right' ? 0.8 : 0.35;
      app.cam.position.set(u.x + Math.sin(ang) * 3.1, 1.55, u.z - 3.1);
      app.cam.rotation.set(-0.06, Math.PI * 0 + ang, 0, 'YXZ');
      app.cam.lookAt(u.x, 1.0, u.z);
      return true;
    },
    playerPose(t) {
      const b = app.battle;
      if (!b) return;
      app.paused = true;
      b.player.attackT = t;
      b.player.hitDone = true;
      app.camMode = 'fp';
      app.camYaw = b.player.yaw + Math.PI;
      app.debugLock = null;
    },
    spawn(cls, team, x, z) {
      const b = app.battle;
      if (!b) return null;
      const u = b.newUnit(cls, team || 'enemy', x || 0, z || 0, false);
      if (app.unitRenderer) app.unitRenderer.addUnit(u, cls);
      return u;
    },
    corpses() { return app.battle ? app.battle.units.filter((u) => u.dead && !u.removed).map((u) => ({ cls: u.cls, t: u.deadT })) : []; },
    lineup(opts) {
      const b = app.battle;
      if (!b) return false;
      app.paused = true;
      app.debugLock = null;
      app.camMode = 'fp';
      app.debugCam = true;
      app.vm.enabled = false;
      b.player.hideModel = true;
      const o = opts || {};
      const cls = ['soldier', 'knight', 'wizard'];
      const picks = {};
      for (const u of b.units) { if (!picks[u.cls] && !u.isPlayer) picks[u.cls] = u; }
      const xs = o.xs || [-1.45, 0, 1.45];
      let i = 0;
      for (const c of cls) {
        const u = picks[c];
        if (!u) continue;
        u.x = xs[i]; u.z = 0; u.y = 0; u.yaw = Math.PI;
        u.dead = false; u.removed = false; u.attackT = -1; u.moveAmt = 0; u.staggerT = 0; u.freezeT = 0;
        u.hideModel = false;
        i++;
      }
      for (const u of b.units) {
        if (!Object.values(picks).includes(u) && !u.isPlayer) u.hideModel = true;
      }
      const cx = o.cx === undefined ? 0 : o.cx;
      const cy = o.cy === undefined ? 1.15 : o.cy;
      const cz = o.cz === undefined ? -3.6 : o.cz;
      const tx = o.tx === undefined ? 0 : o.tx;
      const ty = o.ty === undefined ? 1.0 : o.ty;
      const tz = o.tz === undefined ? 0 : o.tz;
      app.cam.position.set(cx, cy, cz);
      app.cam.lookAt(tx, ty, tz);
      return true;
    },
    solo(cls, kind, t) {
      const b = app.battle;
      if (!b) return false;
      app.paused = true;
      app.camMode = 'fp';
      app.debugCam = true;
      app.vm.enabled = false;
      b.player.hideModel = true;
      let u = null;
      for (const x of b.units) { if (x.cls === cls && !x.isPlayer) { u = x; break; } }
      if (!u) return false;
      for (const x of b.units) if (x !== u && !x.isPlayer) x.hideModel = true;
      u.hideModel = false;
      u.x = 0; u.z = 0; u.yaw = Math.PI;
      u.dead = kind === 'death';
      u.deadT = kind === 'death' ? (t || 0) : 0;
      u.attackT = kind === 'attack' ? (t || 0) : -1;
      u.hitDone = true;
      u.moveAmt = 0; u.staggerT = 0; u.freezeT = 0;
      app.debugLock = { unit: u, kind: kind === 'death' ? 'death' : 'attack', t: t || 0 };
      app.cam.position.set(1.6, 1.35, -3.0);
      app.cam.lookAt(0, 1.0, 0);
      return true;
    },
    lockFree() { app.debugLock = null; app.paused = false; app.debugCam = false; },
    setTimeScale(v) { app.timeScale = v; },
    colorize(cls) {
      const r = app.unitRenderer;
      const c = r && r.classes[cls];
      if (!c) return null;
      const list = [];
      c.parts.forEach((p, i) => {
        const col = new THREE.Color().setHSL((i * 0.137) % 1, 0.95, 0.55);
        p.material = new THREE.MeshBasicMaterial({ color: col, wireframe: false });
        list.push({ i, mat: p.userData.matKey, joint: p.userData.joint, col: '#' + col.getHexString() });
      });
      c.silhouette.visible = false;
      return list;
    },
    advance(sec) {
      const b = app.battle;
      if (!b) return 0;
      const n = Math.max(1, Math.round(sec * 60));
      for (let i = 0; i < n; i++) {
        b.update(1 / 60, {
          mx: app.input.mx || 0, mz: app.input.mz || 0,
          yaw: b.player ? b.player.yaw : 0,
          guard: !!app.input.guard,
          attack: !!app.input.attack,
          hold: !!app.attackHeld
        });
        for (let k = 0; k < b.units.length; k++) computePose(b.units[k], app.time + i / 60, 1 / 60);
        // 실제 루프와 같은 순서로 이벤트·카메라를 처리한다 (증원·히트마커·관전도 검증 가능)
        const evs = b.drain();
        if (app.fx) { app.fx.handle(evs, b); app.fx.update(1 / 60, b, app.cam); }
        for (const e of evs) app._onEvent(e);
        if (app.cam) app.updateCamera(1 / 60);
        if (b.over) break;
      }
      app.time += n / 60;
      if (app._syncHUD) app._syncHUD(true);
      return n;
    },
    perf() { return { calls: app.renderer.info.render.calls, tris: app.renderer.info.render.triangles, mem: app.renderer.info.memory }; },
    /* 모션 연속성 측정 — 프레임 사이 관절 위치가 얼마나 튀는지(m) 재서 '뚝 끊김'을 잡는다 */
    poseTrack(opts) {
      const b = app.battle;
      if (!b) return null;
      const o = opts || {};
      const cls = o.cls || 'soldier';
      const kind = o.kind || 'attack';
      const frames = o.frames || 60;
      const from = o.from === undefined ? 0 : o.from;
      const to = o.to === undefined ? 3 : o.to;
      const u = b.units.find((x) => x.cls === cls && !x.isPlayer && !x.removed) || b.units.find((x) => !x.isPlayer);
      if (!u) return null;
      u.hideModel = false; u.dead = false; u.attackT = -1; u.moveAmt = 0; u.staggerT = 0;
      u.guard = false; u._guardK = 0; u.severed = { armL: 0, armR: 0, legL: 0, legR: 0, head: 0 };
      u.y = 0;
      const dt = 1 / 60;
      const prev = new Float32Array(u.pose.rot.length);
      let max = 0, maxAt = -1, maxJoint = -1, rootJump = 0;
      let prevY = 0, prevZ = 0;
      let have = false;
      for (let i = 0; i <= frames; i++) {
        const k = from + (to - from) * (i / frames);
        if (kind === 'attack') u.attackT = k;
        else if (kind === 'death') { u.dead = true; u.deadT = k; }
        else if (kind === 'guard') u.guard = k > (from + to) / 2;
        else if (kind === 'walk') { u.moveAmt = 1; u.walkPhase = k; }
        computePose(u, i * dt, dt);
        if (have) {
          /* 프레임 사이 관절 회전(rad) 변화 — 큰 값이면 모션이 '뚝' 끊긴 것 */
          for (let j = 0; j < u.pose.rot.length; j++) {
            const d = Math.abs(u.pose.rot[j] - prev[j]);
            if (d > max) { max = d; maxAt = i; maxJoint = (j / 3) | 0; }
          }
          rootJump = Math.max(rootJump, Math.abs(u.pose.rootAdd[0] - prevY) + Math.abs(u.pose.rootAdd[2] - prevZ));
        }
        prev.set(u.pose.rot);
        prevY = u.pose.rootAdd[0]; prevZ = u.pose.rootAdd[2];
        have = true;
      }
      u.dead = false; u.deadT = 0; u.attackT = -1; u.guard = false; u._guardK = 2;
      return { max: +max.toFixed(4), maxAt, maxJoint, rootJump: +rootJump.toFixed(4), frames };
    }
  }
};

window.addEventListener('error', (e) => {
  console.error('PAGE_ERROR', e.message, e.filename, e.lineno);
});

export { app };
