// Wiring: camera -> gestures -> chord -> synth -> UI.

import { HandTracker, drawHands } from './tracker.js';
import { readFrame } from './gestures.js';
import { Synth, PRESETS } from './synth.js';
import { Drums, LANES, PATTERNS, STEPS } from './drums.js';
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
  helpClose: el('help-close'),
  drums: el('drums'),
  drumsOpen: el('drums-open'),
  drumsClose: el('drums-close'),
  drumsPlay: el('drums-play'),
  bpm: el('bpm'),
  bpmValue: el('bpm-value'),
  drumPattern: el('drum-pattern'),
  drumLevel: el('drum-level'),
  drumLevelValue: el('drum-level-value'),
  stepsHead: el('steps-head'),
  lanes: el('lanes')
};

const synth = new Synth();
let drums = null;
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
  lastSignature = ''; // the chord may now be coming from the other hand
});

dom.helpOpen.addEventListener('click', () => dom.help.classList.add('is-open'));
dom.helpClose.addEventListener('click', () => dom.help.classList.remove('is-open'));
dom.help.addEventListener('click', (e) => {
  if (e.target === dom.help) dom.help.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  dom.help.classList.remove('is-open');
  dom.drums.classList.remove('is-open');
});

// ------------------------------------------------------------------- drums

const stepButtons = {}; // laneId -> HTMLButtonElement[]
let shownStep = -1;

function buildDrumUI() {
  for (const name of Object.keys(PATTERNS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    dom.drumPattern.appendChild(opt);
  }
  dom.drumPattern.value = 'four/floor';

  dom.stepsHead.appendChild(document.createElement('div'));
  for (let i = 0; i < STEPS; i++) {
    const tick = document.createElement('div');
    tick.className = 'tick' + (i % 4 === 0 ? ' is-beat' : '');
    tick.textContent = i % 4 === 0 ? String(i / 4 + 1) : '·';
    dom.stepsHead.appendChild(tick);
  }

  for (const lane of LANES) {
    const row = document.createElement('div');
    row.className = 'lane';

    const name = document.createElement('div');
    name.className = 'lane-name';

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.textContent = lane.label;
    mute.title = 'Mute / unmute';
    mute.addEventListener('click', () => {
      mute.classList.toggle('is-muted', drums.toggleMute(lane.id));
    });

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'load';
    load.textContent = '⇪';
    load.title = 'Load a sample for this lane';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'audio/*';
    load.appendChild(file);

    const shown = document.createElement('span');
    shown.className = 'sample';

    file.addEventListener('change', async () => {
      const picked = file.files?.[0];
      if (!picked) return;
      try {
        const loaded = await drums.loadSample(lane.id, picked);
        shown.textContent = loaded.name;
        shown.title = `${loaded.name} — click to revert to the built-in sound`;
      } catch (err) {
        shown.textContent = 'bad file';
        shown.title = String(err.message || err);
      }
      file.value = '';
    });

    shown.addEventListener('click', () => {
      drums.clearSample(lane.id);
      shown.textContent = '';
      shown.title = '';
    });

    name.append(mute, load, shown);
    row.appendChild(name);

    stepButtons[lane.id] = [];
    for (let i = 0; i < STEPS; i++) {
      const step = document.createElement('button');
      step.type = 'button';
      step.className = 'step';
      step.addEventListener('click', () => {
        step.classList.toggle('is-on', drums.toggleStep(lane.id, i));
      });
      stepButtons[lane.id].push(step);
      row.appendChild(step);
    }

    dom.lanes.appendChild(row);
  }
}

function renderPattern() {
  for (const lane of LANES) {
    stepButtons[lane.id].forEach((btn, i) => {
      btn.classList.toggle('is-on', drums.pattern[lane.id][i]);
    });
  }
}

function markStep(step, when) {
  // `when` is an audio-clock timestamp; delay the repaint so the highlight
  // lands with the sound rather than when the step was booked.
  const delay = Math.max(0, (when - synth.ctx.currentTime) * 1000);
  setTimeout(() => {
    if (shownStep >= 0) {
      dom.stepsHead.children[shownStep + 1]?.classList.remove('is-now');
      for (const lane of LANES) stepButtons[lane.id][shownStep].classList.remove('is-now');
    }
    shownStep = step;
    dom.stepsHead.children[step + 1]?.classList.add('is-now');
    for (const lane of LANES) stepButtons[lane.id][step].classList.add('is-now');
  }, delay);
}

function clearStepMarker() {
  if (shownStep < 0) return;
  dom.stepsHead.children[shownStep + 1]?.classList.remove('is-now');
  for (const lane of LANES) stepButtons[lane.id][shownStep]?.classList.remove('is-now');
  shownStep = -1;
}

dom.drumsOpen.addEventListener('click', () => dom.drums.classList.toggle('is-open'));
dom.drumsClose.addEventListener('click', () => dom.drums.classList.remove('is-open'));

dom.drumsPlay.addEventListener('click', async () => {
  await ensureAudio();
  if (drums.playing) {
    drums.stop();
    clearStepMarker();
  } else {
    drums.start();
  }
  dom.drumsPlay.textContent = drums.playing ? 'Stop' : 'Play';
  dom.drumsPlay.classList.toggle('is-playing', drums.playing);
});

dom.bpm.addEventListener('input', () => {
  dom.bpmValue.textContent = dom.bpm.value;
  if (drums) drums.setBpm(Number(dom.bpm.value));
});

dom.drumPattern.addEventListener('change', async () => {
  await ensureAudio();
  drums.setPattern(dom.drumPattern.value);
  renderPattern();
});

dom.drumLevel.addEventListener('input', () => {
  dom.drumLevelValue.textContent = `${dom.drumLevel.value}%`;
  if (drums) drums.setLevel(Number(dom.drumLevel.value) / 100);
});

buildDrumUI();

// ---------------------------------------------------------------- start-up

/** Audio can only start from a user gesture, so every entry point funnels here. */
async function ensureAudio() {
  await synth.start();
  if (!drums) {
    drums = new Drums(synth.ctx, synth.output);
    drums.onStep = markStep;
    drums.setBpm(Number(dom.bpm.value));
    drums.setLevel(Number(dom.drumLevel.value) / 100);
    drums.setPattern(dom.drumPattern.value);
    renderPattern();
  }
  return drums;
}

dom.start.addEventListener('click', async () => {
  dom.start.disabled = true;
  setStatus('starting audio…');
  try {
    await ensureAudio();
    synth.setPreset(state.preset);
    synth.setFilter(manualFilter);

    setStatus('loading hand model…');
    tracker = new HandTracker(dom.video);
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

  const frame = readFrame(hands, { swapHands: dom.swap.checked });
  drawHands(dom.canvas.getContext('2d'), frame.hands, HAND_COLOURS);

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

// Chords are held by gesture, so a hand leaving mid-chord would otherwise drone
// on after the tab loses focus. The beat is meant to keep running.
window.addEventListener('blur', () => synth.allOff());
