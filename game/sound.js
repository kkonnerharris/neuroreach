// Procedural sound design (Web Audio, no audio files). The viewer drives the servo hum from the
// arm's real speed; discrete effects fire on simulator events (grab, release, lamp, ring, ship).
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem("nr-muted") === "1"; } catch {}
    this.ringTimer = null;
  }
  // browsers only allow audio after a user gesture
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = (this.ctx = new AC());
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.55;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    this.master.connect(comp).connect(c.destination);
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // servo: two detuned saws through a lowpass, gain follows arm speed
    this.servoGain = c.createGain(); this.servoGain.gain.value = 0;
    this.servoFilter = c.createBiquadFilter(); this.servoFilter.type = "lowpass"; this.servoFilter.Q.value = 4;
    this.servoOsc = [c.createOscillator(), c.createOscillator()];
    this.servoOsc.forEach((o, i) => { o.type = "sawtooth"; o.frequency.value = 110 + i * 3.5; o.connect(this.servoFilter); o.start(); });
    this.servoFilter.connect(this.servoGain).connect(this.master);
    // faint room tone so silence feels like a space, not a dead tab
    const room = c.createBufferSource(); room.buffer = buf; room.loop = true;
    const rf = c.createBiquadFilter(); rf.type = "lowpass"; rf.frequency.value = 260;
    const rg = c.createGain(); rg.gain.value = 0.018;
    room.connect(rf).connect(rg).connect(this.master); room.start();
  }
  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem("nr-muted", m ? "1" : "0"); } catch {}
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }
  servo(speed) { // speed in m/s of the tool
    if (!this.ctx) return;
    const t = this.ctx.currentTime, s = Math.min(1, speed / 0.6);
    this.servoGain.gain.setTargetAtTime(s * 0.07, t, 0.06);
    this.servoOsc.forEach((o, i) => o.frequency.setTargetAtTime(95 + s * 260 + i * 3.5, t, 0.08));
    this.servoFilter.frequency.setTargetAtTime(350 + s * 2200, t, 0.08);
  }
  _noise(dur, { type = "bandpass", f0 = 1000, f1 = f0, q = 1, gain = 0.3, delay = 0 } = {}) {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master); src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  _tone(freq, dur, { type = "sine", gain = 0.2, delay = 0, slide = 0 } = {}) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  play(name) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case "grab": // suction cup seals: short hiss + soft thunk
        this._noise(0.18, { f0: 3000, f1: 600, q: 0.8, gain: 0.12 });
        this._tone(140, 0.12, { gain: 0.18, slide: 0.6 });
        break;
      case "release": // vacuum vents
        this._noise(0.35, { f0: 900, f1: 4000, q: 0.6, gain: 0.1 });
        break;
      case "thud": // object lands
        this._tone(85, 0.18, { gain: 0.3, slide: 0.7 });
        this._noise(0.12, { type: "lowpass", f0: 700, f1: 200, gain: 0.18 });
        break;
      case "click": // lamp switch
        this._noise(0.03, { f0: 4500, q: 3, gain: 0.25 });
        this._tone(2200, 0.03, { gain: 0.06, delay: 0.04 });
        break;
      case "tape": // packing tape pulled across the box
        this._noise(0.55, { f0: 1800, f1: 5200, q: 1.5, gain: 0.12 });
        this._noise(0.3, { type: "lowpass", f0: 400, f1: 120, gain: 0.12, delay: 0.75 });
        break;
      case "scan": // headset starts recording
        this._tone(880, 0.09, { gain: 0.05 }); this._tone(1320, 0.12, { gain: 0.04, delay: 0.09 });
        break;
      case "ok":
        this._tone(659, 0.18, { gain: 0.12 }); this._tone(988, 0.32, { gain: 0.1, delay: 0.12 });
        break;
      case "fail":
        this._tone(330, 0.16, { gain: 0.1, type: "triangle" }); this._tone(262, 0.28, { gain: 0.1, type: "triangle", delay: 0.14 });
        break;
      case "level":
        [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.35, { gain: 0.08, delay: i * 0.11 }));
        break;
    }
  }
  ring(on) { // a phone ringing on the table: two-tone trill, 1.2 s on / 1.8 s off
    if (on === !!this.ringTimer) return;
    if (!on) { clearInterval(this.ringTimer); this.ringTimer = null; return; }
    const burst = () => {
      if (!this.ctx || this.muted) return;
      for (let k = 0; k < 12; k++) this._tone(k % 2 ? 1046 : 1318, 0.09, { gain: 0.035, type: "square", delay: k * 0.1 });
    };
    burst();
    this.ringTimer = setInterval(burst, 3000);
  }
}
