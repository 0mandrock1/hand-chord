// Web Audio polyphonic synth with three presets and a shared filter/output stage.

import { midiToFreq } from './theory.js';

export const PRESETS = {
  warm: {
    label: 'Warm Synth',
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
    label: 'Bright Synth',
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
    label: 'Retro Synth',
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
      osc.frequency.setValueAtTime(freq, now);
      osc.detune.setValueAtTime(spec.detune, now);

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
