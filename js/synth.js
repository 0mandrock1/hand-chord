// Web Audio polyphonic synth with three presets and a shared filter/output stage.

import { midiToFreq } from './theory.js';

// Each oscillator is { type, gain, detune?, ratio? }. `detune` is cents around
// the note (for chorus-style thickening); `ratio` multiplies the frequency, so
// whole numbers stack harmonics like an organ and odd fractions ring like metal.
export const PRESETS = {
  warm: {
    label: 'Warm',
    oscillators: [
      { type: 'sawtooth', detune: -7, gain: 0.5 },
      { type: 'triangle', detune: +7, gain: 0.5 }
    ],
    attack: 0.06,
    decay: 0.25,
    sustain: 0.75,
    release: 0.45,
    cutoff: [220, 3200],
    resonance: 2
  },
  bright: {
    label: 'Bright',
    oscillators: [
      { type: 'sawtooth', detune: -4, gain: 0.45 },
      { type: 'sawtooth', detune: +9, gain: 0.35 },
      { type: 'square', detune: 0, gain: 0.2 }
    ],
    attack: 0.012,
    decay: 0.18,
    sustain: 0.8,
    release: 0.3,
    cutoff: [500, 9000],
    resonance: 4
  },
  retro: {
    label: 'Retro',
    oscillators: [
      { type: 'square', detune: 0, gain: 0.6 },
      { type: 'square', detune: -12, gain: 0.4 }
    ],
    attack: 0.005,
    decay: 0.35,
    sustain: 0.5,
    release: 0.18,
    cutoff: [300, 5200],
    resonance: 9
  },
  pluck: {
    label: 'Pluck',
    oscillators: [
      { type: 'triangle', detune: 0, gain: 0.55 },
      { type: 'sawtooth', detune: +6, gain: 0.3 }
    ],
    attack: 0.003,
    decay: 0.12,
    sustain: 0.06,
    release: 0.28,
    cutoff: [400, 7000],
    resonance: 3
  },
  bell: {
    // Inharmonic partials — the ratios are what make it read as struck metal
    // rather than as a chord of sines.
    label: 'Bell',
    oscillators: [
      { type: 'sine', ratio: 1, gain: 0.5 },
      { type: 'sine', ratio: 2.76, gain: 0.24 },
      { type: 'sine', ratio: 5.4, gain: 0.14 },
      { type: 'sine', ratio: 8.93, gain: 0.08 }
    ],
    attack: 0.002,
    decay: 0.55,
    sustain: 0.04,
    release: 1.1,
    cutoff: [700, 12000],
    resonance: 1
  },
  organ: {
    // Drawbar-ish stack: octave, octave+fifth, two octaves.
    label: 'Organ',
    oscillators: [
      { type: 'sine', ratio: 1, gain: 0.42 },
      { type: 'sine', ratio: 2, gain: 0.26 },
      { type: 'sine', ratio: 3, gain: 0.16 },
      { type: 'sine', ratio: 4, gain: 0.11 }
    ],
    attack: 0.02,
    decay: 0.05,
    sustain: 0.95,
    release: 0.12,
    cutoff: [500, 9000],
    resonance: 0.7
  },
  pad: {
    label: 'Pad',
    oscillators: [
      { type: 'sawtooth', detune: -11, gain: 0.3 },
      { type: 'sawtooth', detune: +11, gain: 0.3 },
      { type: 'triangle', ratio: 2, gain: 0.16 }
    ],
    attack: 0.7,
    decay: 0.9,
    sustain: 0.85,
    release: 1.6,
    cutoff: [180, 4200],
    resonance: 2.5
  },
  bass: {
    label: 'Bass',
    oscillators: [
      { type: 'square', ratio: 0.5, gain: 0.5 },
      { type: 'sawtooth', ratio: 0.5, detune: +5, gain: 0.3 },
      { type: 'sine', ratio: 1, gain: 0.2 }
    ],
    attack: 0.008,
    decay: 0.2,
    sustain: 0.7,
    release: 0.22,
    cutoff: [120, 2600],
    resonance: 6
  },
  glass: {
    label: 'Glass',
    oscillators: [
      { type: 'sine', ratio: 1, gain: 0.4 },
      { type: 'sine', ratio: 3.01, gain: 0.2 },
      { type: 'triangle', ratio: 4.98, gain: 0.14 }
    ],
    attack: 0.05,
    decay: 0.4,
    sustain: 0.35,
    release: 0.9,
    cutoff: [900, 14000],
    resonance: 1.5
  }
};

export class Synth {
  constructor() {
    this.ctx = null;
    this.preset = PRESETS.warm;
    this.voices = new Map(); // midi -> voice
    this.filterAmount = 0.5;
    this.level = 0.7;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  async start() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();

      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';

      this.master = this.ctx.createGain();
      this.master.gain.value = 0;

      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.2;

      this.filter.connect(this.master);
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      this.applyFilter();
      this.applyLevel();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Bus to plug other sources into. Drums land here so they share the limiter
   * but skip the chord filter — hand tilt should not muffle the beat.
   */
  get output() {
    return this.limiter || null;
  }

  setPreset(name) {
    if (!PRESETS[name]) return;
    this.preset = PRESETS[name];
    this.applyFilter();
  }

  /** @param {number} amount 0..1 — 0 is dark and closed, 1 is fully open. */
  setFilter(amount) {
    this.filterAmount = Math.min(1, Math.max(0, amount));
    this.applyFilter();
  }

  /** @param {number} level 0..1 */
  setLevel(level) {
    this.level = Math.min(1, Math.max(0, level));
    this.applyLevel();
  }

  applyFilter() {
    if (!this.ctx) return;
    const [lo, hi] = this.preset.cutoff;
    const hz = lo * Math.pow(hi / lo, this.filterAmount);
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(hz, t, 0.04);
    this.filter.Q.setTargetAtTime(this.preset.resonance, t, 0.05);
  }

  applyLevel() {
    if (!this.ctx) return;
    // A few voices at once, so keep headroom.
    this.master.gain.setTargetAtTime(this.level * 0.28, this.ctx.currentTime, 0.05);
  }

  /** Play exactly this set of notes: adds what is new, releases what is gone. */
  setChord(midiNotes) {
    if (!this.running) return;
    const wanted = new Set(midiNotes);

    for (const midi of this.voices.keys()) {
      if (!wanted.has(midi)) this.noteOff(midi);
    }
    for (const midi of wanted) {
      if (!this.voices.has(midi)) this.noteOn(midi);
    }
  }

  allOff() {
    for (const midi of Array.from(this.voices.keys())) this.noteOff(midi);
  }

  noteOn(midi) {
    const { ctx, preset } = this;
    const now = ctx.currentTime;
    const freq = midiToFreq(midi);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + preset.attack);
    env.gain.setTargetAtTime(preset.sustain, now + preset.attack, preset.decay);
    env.connect(this.filter);

    const oscs = preset.oscillators.map((spec) => {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(freq * (spec.ratio ?? 1), now);
      osc.detune.setValueAtTime(spec.detune ?? 0, now);

      const g = ctx.createGain();
      g.gain.value = spec.gain;
      osc.connect(g);
      g.connect(env);
      osc.start(now);
      return osc;
    });

    this.voices.set(midi, { env, oscs });
  }

  noteOff(midi) {
    const voice = this.voices.get(midi);
    if (!voice) return;
    this.voices.delete(midi);

    const now = this.ctx.currentTime;
    const rel = this.preset.release;
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setValueAtTime(voice.env.gain.value, now);
    voice.env.gain.linearRampToValueAtTime(0.0001, now + rel);

    for (const osc of voice.oscs) osc.stop(now + rel + 0.05);
    setTimeout(() => voice.env.disconnect(), (rel + 0.2) * 1000);
  }
}
