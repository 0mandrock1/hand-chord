// Wiring: camera -> gestures -> chord -> synth -> UI.

import { HandTracker, drawHands } from './tracker.js';
import { readFrame } from './gestures.js';
import { Synth, PRESETS } from './synth.js';
import { buildChord, midiToName, NOTE_LABELS, QUALITY_LABELS } from './theory.js';

const BASE_OCTAVE = 4;
const HAND_COLOURS = { left: '#7cf5c8', right: '#ff9df0' };

const el = (id) => document.getElementById(id);

const dom = {
  video: el('cam'),
  canvas: el('overlay'),
  start: el('start'),
  startScreen: el('start-screen'),
  status: el('status'),
  key: el('key'),
  preset: el('preset'),
  filter: el('filter'),
  filterValue: el('filter-value'),
  swap: el('swap-hands'),
  chord: el('chord'),
  chordNotes: el('chord-notes'),
  degree: el('degree'),
  mode: el('mode'),
  quality: el('quality'),
  octave: el('octave'),
  leftDot: el('left-dot'),
  rightDot: el('right-dot'),
  help: el('help'),
  helpOpen: el('help-open'),
  helpClose: el('help-close')
};

const synth = new Synth();
let tracker = null;
let manualFilter = 0.5;
let lastSignature = '';

const state = {
  tonic: 0,
  preset: 'warm'
};

// ---------------------------------------------------------------- controls

for (let i = 0; i < NOTE_LABELS.length; i++) {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = NOTE_LABELS[i];
  dom.key.appendChild(opt);
}
dom.key.value = '0';
dom.key.addEventListener('change', () => {
  state.tonic = Number(dom.key.value);
});

for (const [name, preset] of Object.entries(PRESETS)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.dataset.preset = name;
  btn.textContent = preset.label;
  btn.addEventListener('click', () => selectPreset(name));
  dom.preset.appendChild(btn);
}

function selectPreset(name) {
  state.preset = name;
  synth.setPreset(name);
  for (const btn of dom.preset.children) {
    btn.classList.toggle('is-active', btn.dataset.preset === name);
  }
}
selectPreset('warm');

dom.filter.addEventListener('input', () => {
  manualFilter = Number(dom.filter.value) / 100;
  dom.filterValue.textContent = `${dom.filter.value}%`;
  synth.setFilter(manualFilter);
});

dom.swap.addEventListener('change', () => {
  if (tracker) tracker.swapHands = dom.swap.checked;
});

dom.helpOpen.addEventListener('click', () => dom.help.classList.add('is-open'));
dom.helpClose.addEventListener('click', () => dom.help.classList.remove('is-open'));
dom.help.addEventListener('click', (e) => {
  if (e.target === dom.help) dom.help.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') dom.help.classList.remove('is-open');
});

// ---------------------------------------------------------------- start-up

dom.start.addEventListener('click', async () => {
  dom.start.disabled = true;
  setStatus('starting audio…');
  try {
    await synth.start();
    synth.setPreset(state.preset);
    synth.setFilter(manualFilter);

    setStatus('loading hand model…');
    tracker = new HandTracker(dom.video, { swapHands: dom.swap.checked });
    tracker.onFrame = handleFrame;
    await tracker.init();
    tracker.start();

    dom.startScreen.classList.add('is-hidden');
    setStatus('tracking — raise both hands');
  } catch (err) {
    console.error(err);
    dom.start.disabled = false;
    setStatus(`could not start: ${err.message}`, true);
  }
});

function setStatus(text, isError = false) {
  dom.status.textContent = text;
  dom.status.classList.toggle('is-error', isError);
}

// ---------------------------------------------------------------- per frame

function handleFrame(hands) {
  fitCanvas();
  drawHands(dom.canvas.getContext('2d'), hands, HAND_COLOURS);

  const frame = readFrame(hands);
  dom.leftDot.classList.toggle('is-on', !!frame.left);
  dom.rightDot.classList.toggle('is-on', !!frame.right);

  // Right hand drives filter and volume; falls back to the slider when absent.
  synth.setFilter(frame.filter === null ? manualFilter : frame.filter);
  if (frame.filter !== null) {
    const pct = Math.round(frame.filter * 100);
    dom.filter.value = String(pct);
    dom.filterValue.textContent = `${pct}%`;
  }
  synth.setLevel(frame.volume === null ? 0.7 : 0.15 + frame.volume * 0.85);

  if (frame.degree === null) {
    synth.allOff();
    lastSignature = '';
    renderChord(null, frame);
    return;
  }

  const octave = BASE_OCTAVE + frame.octaveShift;
  const signature = [frame.degree, frame.mode, frame.quality, octave, state.tonic].join('|');
  const chord = buildChord({
    tonic: state.tonic,
    mode: frame.mode,
    degree: frame.degree,
    quality: frame.quality,
    octave
  });

  if (signature !== lastSignature) {
    lastSignature = signature;
    synth.setChord(chord.midi);
  }
  renderChord(chord, frame);
}

function renderChord(chord, frame) {
  dom.chord.textContent = chord ? chord.name : '—';
  dom.chordNotes.textContent = chord ? chord.midi.map(midiToName).join('  ') : '';
  dom.degree.textContent = chord ? chord.degreeLabel : '—';
  dom.mode.textContent = frame.left ? frame.mode : '—';
  dom.quality.textContent = frame.right ? QUALITY_LABELS[frame.quality] : '—';
  dom.octave.textContent = frame.right
    ? String(BASE_OCTAVE + frame.octaveShift)
    : String(BASE_OCTAVE);
}

function fitCanvas() {
  const rect = dom.video.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (dom.canvas.width !== w || dom.canvas.height !== h) {
    dom.canvas.width = w;
    dom.canvas.height = h;
  }
}

window.addEventListener('blur', () => synth.allOff());
