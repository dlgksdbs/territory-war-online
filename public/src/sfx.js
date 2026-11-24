/* =============================================================================
   sfx.js — 절차적 Web Audio 효과음 (외부 파일 없음)
   -----------------------------------------------------------------------------
   모든 소리는 "층(layer)"으로 만든다:
     · 밴드패스/하이패스 노이즈 스윕  — 바람·칼날·파편
     · 금속 공명(비화성 배음)         — 칼날이 부딪히는 팅/쨍
     · 저음 펀치(사인 드롭)           — 묵직한 타격의 몸통
     · 엔벨로프 레이어(어택/감쇠)     — 촥! 하고 베이고 여운이 남는 느낌
   브라우저 자동재생 정책을 지키기 위해 첫 사용자 입력에서 resume.
   ============================================================================= */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ready = false;
    this.enabled = true;
    this.last = {};
    this.noiseBuf = null;
    this.rngSeed = 1;
  }

  init() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 9;
      comp.attack.value = 0.002; comp.release.value = 0.14;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      // 노이즈 버퍼 2초 (스윕·파편·바람)
      const len = Math.floor(this.ctx.sampleRate * 2.0);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.ready = true;
      return true;
    } catch (e) { return false; }
  }

  resume() {
    if (!this.init()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /* 밴드패스/로우/하이패스 노이즈 스윕 — 바람, 칼날, 파편 */
  _noise(dur, filterType, f0, f1, gain, q, delay) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    flt.Q.value = q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  _tone(type, f0, f1, dur, gain, delay, detune) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (detune) o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /* 금속 공명 — 비화성 배음(종/판) 여러 개를 아주 짧게 겹친다.
     강철이 부딪힐 때의 "팅!" 하는 그 소리. decay 가 작을수록 쨍하고 짧다. */
  _metal(base, gain, delay, decay, spread) {
    const ratios = [1, 2.76, 5.4, 8.93, 13.3];
    const d = decay === undefined ? 0.16 : decay;
    const sp = spread === undefined ? 1 : spread;
    for (let i = 0; i < ratios.length; i++) {
      const g = gain * (i === 0 ? 1 : 0.55 / (1 + i * 0.55));
      this._tone('sine', base * ratios[i] * sp, base * ratios[i] * sp * 0.985, d * (1 - i * 0.13), g, (delay || 0) + i * 0.002);
    }
  }

  _atten(dist, maxDist) {
    if (dist === undefined) return 1;
    const m = maxDist || 40;
    return Math.max(0, Math.min(1, 1 - dist / m));
  }

  /* 칼을 휘두르는 바람 — 칼끝이 공기를 가르는 스윕 */
  swing(cls) {
    if (!this.ready || !this.enabled) return;
    const now = performance.now();
    if (this.last.swing && now - this.last.swing < 70) return;
    this.last.swing = now;
    if (cls === 'knight') {
      // 묵직한 망치 — 낮게 깔리는 바람 + 몸통에 남는 저음
      this._noise(0.40, 'bandpass', 260, 720, 0.24, 0.75);
      this._noise(0.22, 'lowpass', 900, 180, 0.14, 0.6, 0.05);
      this._tone('sine', 78, 42, 0.30, 0.10, 0.02);
    } else if (cls === 'wizard') {
      this._noise(0.30, 'highpass', 1100, 3000, 0.09, 1.1);
      this._tone('sine', 1650, 2400, 0.18, 0.035, 0.02);
    } else if (cls === 'blademaster') {
      // 매화 검객 — 얇고 빠른 칼날: 짧고 날카롭게
      this._noise(0.16, 'bandpass', 1500, 3800, 0.20, 1.7);
      this._noise(0.22, 'bandpass', 900, 2200, 0.12, 2.4, 0.03);
      this._metal(2100, 0.020, 0.05, 0.10, 1.1);
    } else {
      // 일반 병사 — "촥" 하는 균형 잡힌 스윕 + 칼끝의 금속 뉘앙스
      this._noise(0.20, 'bandpass', 700, 2700, 0.22, 1.15);
      this._noise(0.26, 'highpass', 2400, 5200, 0.055, 0.9, 0.04);
      this._metal(1500, 0.014, 0.08, 0.10, 1.05);
      this._tone('sine', 220, 120, 0.10, 0.03, 0.01);
    }
  }

  /* 타격 — 베는 소리(촥) / 망치(묵직) */
  hit(kind, dist, strong) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 26);
    if (att <= 0.02) return;
    const g = att * (strong ? 1.3 : 1);
    if (kind === 'hammer') {
      // 망치: 깊은 저음 폭발 + 파편 + 금속 파열
      this._tone('sine', 105, 26, 0.46, 0.52 * g);
      this._noise(0.34, 'lowpass', 1500, 120, 0.34 * g, 0.65);
      this._noise(0.12, 'highpass', 2800, 6200, 0.12 * g, 1.4, 0.005);
      this._metal(320, 0.14 * g, 0.01, 0.28, 1.0);
      this._tone('triangle', 300, 90, 0.22, 0.10 * g, 0.02);
    } else if (kind === 'petal') {
      // 매화 일섬 — 날카로운 참격 + 꽃잎이 흩어지는 잔향
      this._noise(0.16, 'bandpass', 1800, 5200, 0.26 * g, 1.9);
      this._metal(2450, 0.10 * g, 0, 0.18, 1.02);
      this._noise(0.40, 'highpass', 3200, 7000, 0.06 * g, 0.8, 0.03);
      this._tone('sine', 190, 70, 0.14, 0.10 * g);
    } else {
      // 검: 저음 펀치 + 썰리는 노이즈 + 금속 팅 (레이어 3겹)
      this._tone('sine', 150, 48, 0.16, 0.30 * g);
      this._noise(0.13, 'bandpass', 2600, 780, 0.26 * g, 1.5);
      this._noise(0.20, 'highpass', 3400, 6800, 0.06 * g, 0.9, 0.01);
      this._metal(1750, 0.075 * g, 0.004, 0.13, 1.0);
      this._tone('triangle', 520, 200, 0.10, 0.10 * g, 0.004);
    }
  }

  /* 막기 — 강철이 강철을 튕겨내는 "팅!" */
  block(dist, strong) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 28);
    if (att <= 0.02) return;
    const g = att * (strong ? 1.35 : 1);
    this._metal(1850, 0.20 * g, 0, strong ? 0.34 : 0.22, 1.0);
    this._noise(0.06, 'highpass', 4200, 7600, 0.20 * g, 1.3);
    this._noise(0.16, 'bandpass', 1600, 3200, 0.10 * g, 2.2, 0.006);
    this._tone('sine', 260, 120, 0.10, 0.10 * g);
    if (strong) this._tone('sine', 130, 60, 0.26, 0.16 * g, 0.01);
  }

  /* 마법 */
  spell(key, dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 55);
    if (att <= 0.02) return;
    if (key === 'fire') {
      // 시전: 화염이 뭉치는 소리 → 낮게 타오르는 잔향
      this._noise(0.34, 'bandpass', 320, 1400, 0.22 * att, 0.8);
      this._noise(0.46, 'lowpass', 1600, 200, 0.20 * att, 0.6, 0.10);
      this._tone('sawtooth', 120, 68, 0.42, 0.12 * att);
      this._tone('sine', 60, 44, 0.5, 0.08 * att, 0.05);
    } else if (key === 'lightning') {
      // 번개: 지직거리는 크랙 + 고음 방전
      this._noise(0.10, 'highpass', 3200, 9000, 0.26 * att, 1.6);
      this._noise(0.22, 'bandpass', 1800, 6000, 0.16 * att, 2.6, 0.03);
      this._noise(0.14, 'highpass', 5000, 2600, 0.12 * att, 1.2, 0.07);
      this._tone('square', 700, 160, 0.14, 0.07 * att);
      this._tone('sine', 2400, 420, 0.2, 0.05 * att, 0.02);
    } else {
      // 빙결: 맑은 유리 공명이 올라가며 얼어붙는 소리
      this._tone('sine', 1200, 2400, 0.38, 0.09 * att);
      this._tone('sine', 1800, 3000, 0.34, 0.055 * att, 0.03);
      this._tone('sine', 2400, 3600, 0.3, 0.035 * att, 0.06);
      this._noise(0.40, 'highpass', 2400, 6800, 0.10 * att, 1.5);
    }
  }

  explode(dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 70);
    if (att <= 0.02) return;
    this._tone('sine', 92, 24, 0.62, 0.48 * att);
    this._noise(0.52, 'lowpass', 2400, 120, 0.34 * att, 0.55);
    this._noise(0.20, 'highpass', 3000, 6500, 0.10 * att, 1.2, 0.01);
  }

  death(dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 30);
    if (att <= 0.03) return;
    // 쓰러지는 몸: 낮은 퍽 + 갑옷/천이 흙에 닿는 잡음
    this._tone('sine', 150, 48, 0.26, 0.13 * att);
    this._noise(0.22, 'lowpass', 1100, 200, 0.11 * att, 0.9);
    this._noise(0.30, 'bandpass', 700, 1600, 0.05 * att, 1.1, 0.06);
  }

  levelUp() {
    if (!this.ready || !this.enabled) return;
    this._tone('sine', 880, 1320, 0.26, 0.11);
    this._tone('sine', 1320, 1760, 0.30, 0.075, 0.07);
    this._tone('sine', 1760, 2340, 0.36, 0.05, 0.14);
    this._metal(1400, 0.03, 0.05, 0.5, 1.0);
  }

  ui() {
    if (!this.ready || !this.enabled) return;
    this._noise(0.03, 'highpass', 3000, 6000, 0.06, 1.2);
    this._tone('sine', 720, 980, 0.06, 0.045);
  }
}
