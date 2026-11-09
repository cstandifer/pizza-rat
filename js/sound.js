// =========================================================================
// 🔊 SOUND — everything is synthesized with the Web Audio API (no files).
// Swap any of these for real recordings later if you want.
// =========================================================================

export class Sound {
  constructor() {
    this.ctx = null;
  }

  // Must be called from a click (browsers block audio until the user interacts)
  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    // A compressor keeps the train from clipping when everything gets loud
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);

    this.white = this._noiseBuffer('white', 2);
    this.brown = this._noiseBuffer('brown', 4);

    // The only background sound is the real station recording (assets/sounds/nyc-subway-loop.mp3).
    // (The old synthesized room tone, crowd murmur and street sounds (siren, car horn) are off.)
    this._scrapeSetup();
    this._trainSetup(); // (silent unless the recording fails to load)
    this._loadSamples();
  }

  // -----------------------------------------------------------------------
  // 🎧 RECORDED SOUNDS (in assets/sounds). If a file fails to load, the
  // synthesized version is used instead.
  // -----------------------------------------------------------------------
  async _loadSamples() {
    const load = async (url) => {
      const res = await fetch(url);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    try {
      this.passBuf = await load('assets/sounds/subway-passing.mp3');
    } catch (err) {
      console.warn('Could not load express recording, using synthesized train:', err);
    }
    try {
      this.loopBuf = await load('assets/sounds/nyc-subway-loop.mp3');
      this._startStationLoop();
    } catch (err) {
      console.warn('Could not load station loop:', err);
    }
  }

  // The real station recording, looping forever. Trains in it come and go,
  // and the station watches loopTime() to send a train past at the same moment.
  static LOOP_START = 17.5; // the first 17s are loud and wouldn't loop cleanly into the quiet ending

  _startStationLoop() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.loopBuf;
    src.loop = true;
    src.loopStart = Sound.LOOP_START;
    src.loopEnd = this.loopBuf.duration;
    const g = this.ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(this.master);
    src.start(0, Sound.LOOP_START);
    this.loopStartedAt = this.ctx.currentTime;
  }

  get hasStationLoop() {
    return this.loopStartedAt !== undefined;
  }

  /** Where we are in the recording, in seconds (stays within the looped section). */
  loopTime() {
    if (!this.hasStationLoop) return null;
    const len = this.loopBuf.duration - Sound.LOOP_START;
    return Sound.LOOP_START + ((this.ctx.currentTime - this.loopStartedAt) % len);
  }

  get hasPassRecording() {
    return !!this.passBuf;
  }

  /** Express train roaring through. The recording is loudest from about 4s to 15.5s. */
  playPass(volume = 1) {
    if (!this.passBuf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = this.passBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
    return true;
  }

  _noiseBuffer(type, seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
    return buf;
  }

  _loop(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  // Subway station room tone: low rumble, fluorescent hum, distant trains
  _ambience() {
    const ctx = this.ctx;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 1;
    this.ambBus.connect(this.master);

    const rumble = this._loop(this.brown);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    rumble.connect(lp).connect(g).connect(this.ambBus);

    // Slow swell, like a train passing somewhere far away
    const far = this._loop(this.brown);
    const flp = ctx.createBiquadFilter();
    flp.type = 'lowpass';
    flp.frequency.value = 90;
    const fg = ctx.createGain();
    fg.gain.value = 0.0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.35;
    lfo.connect(lfoGain).connect(fg.gain);
    lfo.start();
    far.connect(flp).connect(fg).connect(this.ambBus);

    // Fluorescent light hum
    [60, 120, 180].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = [0.012, 0.008, 0.003][i];
      o.connect(og).connect(this.ambBus);
      o.start();
    });
  }

  // The pizza scraping on concrete while he drags it
  _scrapeSetup() {
    const ctx = this.ctx;
    const src = this._loop(this.white);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    src.connect(bp).connect(this.scrapeGain).connect(this.master);
  }

  setScrape(level) {
    if (!this.ctx) return;
    this.scrapeGain.gain.setTargetAtTime(level * 0.05, this.ctx.currentTime, 0.08);
  }

  _burst({ when = 0, dur = 0.02, freq = 2000, type = 'highpass', gain = 0.5, q = 0.7 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  _tone({ when = 0, dur = 0.08, from = 440, to = 440, gain = 0.1, type = 'sine' }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Phone camera shutter: two mechanical clicks
  shutter() {
    if (!this.ctx) return;
    this._burst({ when: 0, dur: 0.025, freq: 1500, gain: 0.9 });
    this._tone({ when: 0, dur: 0.04, from: 220, to: 120, gain: 0.25, type: 'triangle' });
    this._burst({ when: 0.075, dur: 0.035, freq: 900, gain: 0.7 });
    this._tone({ when: 0.075, dur: 0.05, from: 180, to: 90, gain: 0.2, type: 'triangle' });
  }

  // Startled rat squeak
  squeak() {
    if (!this.ctx) return;
    this._tone({ when: 0.05, dur: 0.09, from: 3800, to: 5400, gain: 0.08 });
    this._tone({ when: 0.16, dur: 0.07, from: 5200, to: 4100, gain: 0.06 });
    this._tone({ when: 0.25, dur: 0.12, from: 4300, to: 6000, gain: 0.07 });
  }

  // Tiny claws scrabbling on concrete
  scurry(duration = 0.6) {
    if (!this.ctx) return;
    for (let t = 0; t < duration; t += 0.028 + Math.random() * 0.02) {
      this._burst({ when: t, dur: 0.012, freq: 3500 + Math.random() * 2500, gain: 0.12 + Math.random() * 0.12 });
    }
  }

  // Curious sniffs when he peeks out
  sniff() {
    if (!this.ctx) return;
    [0, 0.12, 0.22].forEach((w) =>
      this._burst({ when: w, dur: 0.06, freq: 1400, type: 'bandpass', gain: 0.18, q: 1.2 })
    );
  }

  // -----------------------------------------------------------------------
  // 🚇 SUBWAY TRAIN — continuous layers the station turns up and down
  // -----------------------------------------------------------------------
  _trainSetup() {
    const ctx = this.ctx;
    const layer = (src, filterType, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      return { f, g };
    };
    this.tRumble = layer(this._loop(this.brown), 'lowpass', 150);          // deep rumble
    this.tRoar = layer(this._loop(this.white), 'bandpass', 700, 0.5);      // wheels on rails
    this.tScreech = layer(this._loop(this.white), 'bandpass', 3400, 14);   // brakes

    const sq = ctx.createOscillator();                                     // brake squeal tone
    sq.frequency.value = 3100;
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vibG = ctx.createGain();
    vibG.gain.value = 60;
    vib.connect(vibG).connect(sq.frequency);
    this.tSqueal = ctx.createGain();
    this.tSqueal.gain.value = 0;
    sq.connect(this.tSqueal).connect(this.master);
    sq.start();
    vib.start();

    this.tMotor = ctx.createOscillator();                                  // electric motor whine
    this.tMotor.type = 'sawtooth';
    this.tMotor.frequency.value = 200;
    const mf = ctx.createBiquadFilter();
    mf.type = 'lowpass';
    mf.frequency.value = 1400;
    this.tMotorG = ctx.createGain();
    this.tMotorG.gain.value = 0;
    this.tMotor.connect(mf).connect(this.tMotorG).connect(this.master);
    this.tMotor.start();
  }

  /** prox: 0 (far) .. 1 (right here); speed in m/s */
  setTrain({ prox = 0, speed = 0, braking = false, accel = false }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.12;
    const sp = Math.min(speed / 16, 1.2);
    this.tRumble.g.gain.setTargetAtTime(prox * (0.12 + 0.55 * sp), t, k);
    this.tRumble.f.frequency.setTargetAtTime(110 + speed * 22, t, k);
    this.tRoar.g.gain.setTargetAtTime(prox * prox * 0.14 * sp, t, k);
    const squeal = braking && speed < 9 ? prox * (1.1 - speed / 9) : 0;
    this.tScreech.g.gain.setTargetAtTime(squeal * 0.1, t, 0.08);
    this.tSqueal.gain.setTargetAtTime(squeal * 0.022, t, 0.08);
    this.tMotorG.gain.setTargetAtTime(prox * (accel || braking ? 0.028 : 0.01) * (speed > 0.3 ? 1 : 0), t, k);
    this.tMotor.frequency.setTargetAtTime(120 + speed * 48, t, k);
  }

  /** Wheels thumping over a rail joint (two trucks, so two thumps) */
  clack(prox, speed) {
    if (!this.ctx || prox < 0.02) return;
    const gap = Math.min(0.25, 2.2 / Math.max(speed, 1));
    [0, gap].forEach((w) => {
      this._burst({ when: w, dur: 0.07, freq: 420, type: 'lowpass', gain: prox * 0.55 });
      this._tone({ when: w, dur: 0.06, from: 95, to: 60, gain: prox * 0.18, type: 'triangle' });
    });
  }

  /** The two-note door chime ("bing-bong") */
  chime() {
    if (!this.ctx) return;
    [[0, 830], [0.42, 622]].forEach(([w, f]) => {
      this._tone({ when: w, dur: 1.1, from: f, to: f, gain: 0.11 });
      this._tone({ when: w, dur: 0.6, from: f * 2.76, to: f * 2.76, gain: 0.025 });
    });
  }

  /** Conductor announcement, using the browser's built-in voice */
  announce(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 0.85;
      u.volume = 0.8;
      window.speechSynthesis.speak(u);
    } catch (e) { /* no voice available */ }
  }

  // -----------------------------------------------------------------------
  // 🗽 NYC STREET LIFE drifting down the stairwell
  // -----------------------------------------------------------------------
  _streetSetup() {
    const ctx = this.ctx;
    // Everything from "upstairs" goes through a muffled, echoey bus so it sounds far away
    this.street = ctx.createGain();
    this.street.gain.value = 1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    this.street.connect(lp);
    lp.connect(this.master);
    lp.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(this.master);

    // Crowd murmur on the platform
    const crowd = this._loop(this.brown);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    cg.gain.value = 0.05;
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 0.3;
    const wg = ctx.createGain();
    wg.gain.value = 0.02;
    wobble.connect(wg).connect(cg.gain);
    wobble.start();
    crowd.connect(bp).connect(cg).connect(this.master);

    const next = () => {
      const r = Math.random();
      if (r < 0.4) this.siren();
      else if (r < 0.8) this.honk();
      else if (!this.hasStationLoop) this.distantTrain(); // the recording has its own trains
      setTimeout(next, 8000 + Math.random() * 14000);
    };
    setTimeout(next, 5000);
  }

  siren() {
    const ctx = this.ctx, t = ctx.currentTime, dur = 6;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const lfo = ctx.createOscillator();
    lfo.frequency.value = Math.random() < 0.5 ? 0.3 : 3.2; // wail or yelp
    const lg = ctx.createGain();
    lg.gain.value = 320;
    o.frequency.value = 980;
    lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.street);
    o.start(t); lfo.start(t);
    o.stop(t + dur); lfo.stop(t + dur);
  }

  honk() {
    const ctx = this.ctx;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const t = ctx.currentTime + k * 0.32 + Math.random() * 0.05;
      const len = 0.18 + Math.random() * 0.25;
      [392, 494].forEach((f) => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f + Math.random() * 20;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.025, t + 0.02);
        g.gain.setValueAtTime(0.025, t + len);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
        o.connect(g).connect(this.street);
        o.start(t);
        o.stop(t + len + 0.1);
      });
    }
  }

  // A train on another line, rumbling through the walls
  distantTrain() {
    const ctx = this.ctx, t = ctx.currentTime, dur = 7;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }
}
