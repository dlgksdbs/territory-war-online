/* =============================================================================
   sfx.js — 절차적 Web Audio 효과음 (외부 파일 없음)
   휘두르는 바람, 강철이 부딪히는 소리, 망치의 묵직한 울림, 마법 3종, 사망,
   성장 차임. 브라우저 자동재생 정책을 지키기 위해 첫 사용자 입력에서 resume.
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
      this.master.gain.value = 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 8;
      comp.attack.value = 0.003; comp.release.value = 0.16;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      // 노이즈 버퍼 1초
      const len = Math.floor(this.ctx.sampleRate * 1.0);
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
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.03, dur * 0.25));
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
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _atten(dist, maxDist) {
    if (dist === undefined) return 1;
    const m = maxDist || 40;
    return Math.max(0, Math.min(1, 1 - dist / m));
  }

  swing(cls) {
    if (!this.ready || !this.enabled) return;
    const now = performance.now();
    if (this.last.swing && now - this.last.swing < 70) return;
    this.last.swing = now;
    if (cls === 'knight') {
      this._noise(0.34, 'bandpass', 320, 900, 0.22, 0.9);
      this._tone('sine', 90, 46, 0.3, 0.1);
    } else if (cls === 'wizard') {
      this._noise(0.26, 'highpass', 900, 2400, 0.10, 1.2);
    } else {
      this._noise(0.22, 'bandpass', 700, 2600, 0.20, 1.1);
    }
  }

  hit(kind, dist, strong) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 26);
    if (att <= 0.02) return;
    const g = att * (strong ? 1.25 : 1);
    if (kind === 'hammer') {
      this._tone('sine', 118, 34, 0.42, 0.5 * g);
      this._noise(0.28, 'lowpass', 1400, 180, 0.32 * g, 0.7);
      this._tone('triangle', 320, 120, 0.3, 0.16 * g, 0.01);
      this._noise(0.12, 'highpass', 3000, 5200, 0.1 * g, 1.5);
    } else {
      this._noise(0.14, 'bandpass', 2200, 900, 0.26 * g, 1.6);
      this._tone('triangle', 420, 180, 0.12, 0.18 * g);
      this._tone('sine', 900, 520, 0.09, 0.07 * g, 0, 6);
    }
  }

  block(dist, strong) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 28);
    if (att <= 0.02) return;
    const g = att * (strong ? 1.2 : 1);
    // 철제 방패에 강철이 부딪히는 "쨍" — 높은 금속음 + 짧은 노이즈
    this._tone('triangle', 1180, 620, 0.16, 0.20 * g);
    this._tone('sine', 1760, 980, 0.12, 0.13 * g, 0.005);
    this._noise(0.10, 'highpass', 3200, 6200, 0.22 * g, 1.4);
    this._tone('sine', 240, 120, 0.10, 0.10 * g);
  }

  spell(key, dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 55);
    if (att <= 0.02) return;
    if (key === 'fire') {
      this._noise(0.5, 'bandpass', 380, 1500, 0.26 * att, 0.8);
      this._tone('sawtooth', 120, 70, 0.42, 0.14 * att);
      this._noise(0.32, 'lowpass', 1800, 220, 0.24 * att, 0.6, 0.16);
    } else if (key === 'lightning') {
      this._noise(0.34, 'highpass', 2600, 7000, 0.24 * att, 1.8);
      this._tone('square', 700, 180, 0.16, 0.08 * att);
      this._tone('sine', 2200, 380, 0.22, 0.05 * att, 0.02);
    } else {
      this._tone('sine', 1500, 640, 0.4, 0.10 * att);
      this._tone('sine', 2100, 900, 0.34, 0.06 * att, 0.03);
      this._noise(0.36, 'highpass', 2000, 5200, 0.12 * att, 1.4);
    }
  }

  explode(dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 70);
    if (att <= 0.02) return;
    this._tone('sine', 90, 28, 0.6, 0.45 * att);
    this._noise(0.5, 'lowpass', 2200, 140, 0.34 * att, 0.6);
  }

  death(dist) {
    if (!this.ready || !this.enabled) return;
    const att = this._atten(dist, 30);
    if (att <= 0.03) return;
    this._tone('sine', 160, 60, 0.24, 0.12 * att);
    this._noise(0.18, 'lowpass', 900, 220, 0.1 * att, 0.9);
  }

  levelUp() {
    if (!this.ready || !this.enabled) return;
    this._tone('sine', 880, 1320, 0.28, 0.12);
    this._tone('sine', 1320, 1760, 0.3, 0.08, 0.08);
  }

  ui() {
    if (!this.ready || !this.enabled) return;
    this._tone('sine', 660, 990, 0.06, 0.05);
  }
}
