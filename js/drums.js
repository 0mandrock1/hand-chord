// A 16-step drum machine. Each lane has a built-in synthesized sound and an
// optional user sample that replaces it.
//
// Timing note: setInterval alone is far too jittery to sequence audio. The
// interval is only a *pump* — it looks ahead a fraction of a second and books
// every step falling inside that window at an exact AudioContext timestamp, so
// the actual playback times come from the audio clock, not the JS clock.

export const STEPS = 16;

export const LANES = [
  { id: 'kick', label: 'Kick' },
  { id: 'snare', label: 'Snare' },
  { id: 'hat', label: 'Hat' },
  { id: 'perc', label: 'Perc' }
];

const SCHEDULE_AHEAD = 0.12; // seconds of audio booked in advance
const PUMP_INTERVAL = 25; // ms between look-ahead sweeps

/** Sixteenth notes, so one bar of 4/4 is exactly STEPS steps. */
export function secondsPerStep(bpm) {
  return 60 / bpm / 4;
}

export function emptyPattern() {
  const p = {};
  for (const lane of LANES) p[lane.id] = new Array(STEPS).fill(false);
  return p;
}

/** Build a pattern from step indices, e.g. { kick: [0, 4, 8, 12] }. */
export function patternFrom(spec) {
  const p = emptyPattern();
  for (const [lane, steps] of Object.entries(spec)) {
    if (!p[lane]) continue;
    for (const s of steps) {
      if (s >= 0 && s < STEPS) p[lane][s] = true;
    }
  }
  return p;
}

export const PATTERNS = {
  'four/floor': { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], perc: [] },
  breakbeat: { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], perc: [7, 15] },
  house: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], perc: [3, 11] },
  halftime: { kick: [0, 6], snare: [8], hat: [0, 4, 8, 12], perc: [14] },
  sparse: { kick: [0, 8], snare: [], hat: [4, 12], perc: [] },
  empty: {}
};

export class Drums {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.bpm = 120;
    this.playing = false;
    this.step = 0;
    this.nextStepTime = 0;
    this.timer = null;
    this.pattern = patternFrom(PATTERNS['four/floor']);
    this.samples = {}; // laneId -> { buffer, name }
    this.muted = {};
    this.onStep = () => {};

    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(destination);

    this.gains = {};
    for (const lane of LANES) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(this.out);
      this.gains[lane.id] = g;
      this.muted[lane.id] = false;
    }

    this.noise = makeNoiseBuffer(ctx);
  }

  setBpm(bpm) {
    this.bpm = Math.min(200, Math.max(40, bpm));
  }

  setLevel(v) {
    this.out.gain.setTargetAtTime(
      Math.min(1, Math.max(0, v)), this.ctx.currentTime, 0.03
    );
  }

  setPattern(name) {
    this.pattern = patternFrom(PATTERNS[name] || {});
  }

  toggleStep(laneId, step) {
    const lane = this.pattern[laneId];
    if (!lane || step < 0 || step >= STEPS) return false;
    lane[step] = !lane[step];
    return lane[step];
  }

  toggleMute(laneId) {
    this.muted[laneId] = !this.muted[laneId];
    return this.muted[laneId];
  }

  /** Decode an uploaded file and use it in place of the built-in sound. */
  async loadSample(laneId, file) {
    const bytes = await file.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(bytes);
    this.samples[laneId] = { buffer, name: file.name };
    return this.samples[laneId];
  }

  clearSample(laneId) {
    delete this.samples[laneId];
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextStepTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL);
    this.pump();
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  pump() {
    if (!this.playing) return;
    const spacing = secondsPerStep(this.bpm);

    while (this.nextStepTime < this.ctx.currentTime + SCHEDULE_AHEAD) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.onStep(this.step, this.nextStepTime);
      this.nextStepTime += spacing;
      this.step = (this.step + 1) % STEPS;
    }
  }

  scheduleStep(step, when) {
    for (const lane of LANES) {
      if (this.muted[lane.id]) continue;
      if (!this.pattern[lane.id][step]) continue;

      const sample = this.samples[lane.id];
      if (sample) this.playSample(sample.buffer, this.gains[lane.id], when);
      else VOICES[lane.id](this.ctx, this.gains[lane.id], when, this.noise);
    }
  }

  playSample(buffer, destination, when) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(destination);
    src.start(when);
  }
}

function makeNoiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function noiseBurst(ctx, out, when, noise, { type, freq, q, decay, gain }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, when);
  env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

  src.connect(filter);
  filter.connect(env);
  env.connect(out);
  src.start(when);
  src.stop(when + decay + 0.02);
}

// Built-in voices. Deliberately synthesized rather than shipped as audio files:
// the whole app stays a handful of text files, works offline after first load,
// and any lane can still be replaced by a real sample.
const VOICES = {
  kick(ctx, out, when) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.11);

    const env = ctx.createGain();
    env.gain.setValueAtTime(1, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.36);

    osc.connect(env);
    env.connect(out);
    osc.start(when);
    osc.stop(when + 0.4);
  },

  snare(ctx, out, when, noise) {
    noiseBurst(ctx, out, when, noise, {
      type: 'bandpass', freq: 1800, q: 0.8, decay: 0.18, gain: 0.7
    });
    // a little tuned body under the noise, or it reads as a hiss
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, when);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.45, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    osc.connect(env);
    env.connect(out);
    osc.start(when);
    osc.stop(when + 0.14);
  },

  hat(ctx, out, when, noise) {
    noiseBurst(ctx, out, when, noise, {
      type: 'highpass', freq: 7000, q: 1, decay: 0.045, gain: 0.35
    });
  },

  perc(ctx, out, when, noise) {
    // three quick bursts read as a clap; one burst just reads as a click
    for (const offset of [0, 0.011, 0.023]) {
      noiseBurst(ctx, out, when + offset, noise, {
        type: 'bandpass', freq: 1200, q: 1.4, decay: 0.09, gain: 0.4
      });
    }
  }
};
