// Headless checks for the pure logic (no DOM, no audio, no camera).
// Run: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChord, midiToName, midiToFreq } from '../js/theory.js';
import {
  readFingers, readDegree, readQuality, readTilt, isInward, resolveSides, readFrame
} from '../js/gestures.js';
import { PRESETS } from '../js/synth.js';
import { secondsPerStep, emptyPattern, patternFrom, PATTERNS, LANES, STEPS } from '../js/drums.js';

// ------------------------------------------------------------------ theory

test('C major I is a C major triad', () => {
  const c = buildChord({ tonic: 0, mode: 'major', degree: 0, quality: 0, octave: 4 });
  assert.deepEqual(c.midi, [60, 64, 67]);
  assert.equal(c.name, 'C');
  assert.equal(c.degreeLabel, 'I');
});

test('C major V is a G major triad', () => {
  const c = buildChord({ tonic: 0, mode: 'major', degree: 4, quality: 0, octave: 4 });
  assert.deepEqual(c.midi.map((m) => m % 12).sort((a, b) => a - b), [2, 7, 11]);
  assert.equal(c.name, 'G');
});

test('C major vii is diminished', () => {
  const c = buildChord({ tonic: 0, mode: 'major', degree: 6, quality: 0, octave: 4 });
  const [r, t, f] = c.midi;
  assert.equal(t - r, 3);
  assert.equal(f - r, 6);
  assert.equal(c.name, 'Bdim');
});

test('A minor i is an A minor triad', () => {
  const c = buildChord({ tonic: 9, mode: 'minor', degree: 0, quality: 0, octave: 4 });
  assert.deepEqual(c.midi.map((m) => m % 12).sort((a, b) => a - b), [0, 4, 9]);
  assert.equal(c.name, 'Am');
});

test('first inversion lifts the root an octave', () => {
  const root = buildChord({ tonic: 0, mode: 'major', degree: 0, quality: 0, octave: 4 });
  const inv = buildChord({ tonic: 0, mode: 'major', degree: 0, quality: 1, octave: 4 });
  assert.deepEqual(inv.midi, [64, 67, 72]);
  assert.equal(inv.midi.length, root.midi.length);
});

test('diatonic 7th on I is a maj7, on V a dominant-flavoured min7 shape', () => {
  const one = buildChord({ tonic: 0, mode: 'major', degree: 0, quality: 2, octave: 4 });
  assert.deepEqual(one.midi, [60, 64, 67, 71]);
  assert.equal(one.name, 'Cmaj7');

  const two = buildChord({ tonic: 0, mode: 'major', degree: 1, quality: 2, octave: 4 });
  assert.equal(two.name, 'Dm7');
});

test('quality 3 gives a dominant 7th, or dim7 on a diminished degree', () => {
  const v = buildChord({ tonic: 0, mode: 'major', degree: 4, quality: 3, octave: 4 });
  const r = v.midi[0];
  assert.deepEqual(v.midi.map((m) => m - r), [0, 4, 7, 10]);
  assert.equal(v.name, 'G7');

  const vii = buildChord({ tonic: 0, mode: 'major', degree: 6, quality: 3, octave: 4 });
  const r2 = vii.midi[0];
  assert.deepEqual(vii.midi.map((m) => m - r2), [0, 3, 6, 9]);
  assert.equal(vii.name, 'Bdim7');
});

test('octave shifts by exactly 12 semitones', () => {
  const a = buildChord({ tonic: 0, mode: 'major', degree: 2, quality: 0, octave: 3 });
  const b = buildChord({ tonic: 0, mode: 'major', degree: 2, quality: 0, octave: 4 });
  assert.deepEqual(b.midi.map((m) => m - 12), a.midi);
});

test('every key and degree produces sorted, in-range notes', () => {
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      for (let degree = 0; degree < 7; degree++) {
        for (let quality = 0; quality < 4; quality++) {
          const c = buildChord({ tonic, mode, degree, quality, octave: 4 });
          assert.ok(c.midi.length >= 3 && c.midi.length <= 4);
          assert.deepEqual(c.midi, [...c.midi].sort((a, b) => a - b));
          for (const m of c.midi) assert.ok(m > 40 && m < 100, `midi ${m} out of range`);
          assert.ok(c.name.length > 0);
        }
      }
    }
  }
});

test('midi helpers agree with concert pitch', () => {
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(69), 'A4');
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
});

// ---------------------------------------------------------------- gestures

/**
 * Synthetic right-way-up hand. `up` fingers are extended, the rest are curled.
 * Coordinates are normalized image space (y grows downward).
 */
function makeHand({ fingers = [], thumbOut = false, tilt = 0, wristY = 0.8 } = {}) {
  const lm = new Array(21).fill(null).map(() => ({ x: 0.5, y: wristY, z: 0 }));
  const rad = (tilt * Math.PI) / 180;

  // place a point at `len` from the wrist, rotated by `tilt`, in mirrored space
  const at = (len, lateral = 0) => ({
    x: 0.5 - (Math.sin(rad) * len + Math.cos(rad) * lateral),
    y: wristY - (Math.cos(rad) * len - Math.sin(rad) * lateral),
    z: 0
  });

  lm[0] = at(0);
  lm[9] = at(0.20);          // middle MCP defines the palm span
  lm[5] = at(0.19, -0.05);   // index MCP

  const cols = { index: -0.05, middle: -0.01, ring: 0.03, pinky: 0.07 };
  const joints = { index: [8, 6], middle: [12, 10], ring: [16, 14], pinky: [20, 18] };

  for (const [name, [tip, pip]] of Object.entries(joints)) {
    const on = fingers.includes(name);
    lm[pip] = at(0.26, cols[name]);
    lm[tip] = at(on ? 0.42 : 0.22, cols[name]);
  }

  lm[3] = at(0.14, thumbOut ? -0.13 : -0.06);
  lm[4] = at(0.13, thumbOut ? -0.22 : -0.07);
  return lm;
}

test('extended fingers are detected', () => {
  const f = readFingers(makeHand({ fingers: ['index', 'pinky'] }));
  assert.equal(f.index, true);
  assert.equal(f.pinky, true);
  assert.equal(f.middle, false);
  assert.equal(f.ring, false);
});

test('thumb out vs tucked in', () => {
  assert.equal(readFingers(makeHand({ thumbOut: true })).thumb, true);
  assert.equal(readFingers(makeHand({ thumbOut: false })).thumb, false);
});

test('finger count maps to scale degrees I..V', () => {
  const sets = [
    ['index'],
    ['index', 'middle'],
    ['index', 'middle', 'ring'],
    ['index', 'middle', 'ring', 'pinky']
  ];
  sets.forEach((fingers, i) => {
    assert.equal(readDegree(readFingers(makeHand({ fingers }))), i);
  });
  // all five, thumb included -> V
  const five = readFingers(makeHand({
    fingers: ['index', 'middle', 'ring', 'pinky'], thumbOut: true
  }));
  assert.equal(readDegree(five), 4);
});

test('splayed shapes map to VI and VII', () => {
  const vi = readFingers(makeHand({ fingers: ['index', 'pinky'], thumbOut: false }));
  assert.equal(readDegree(vi), 5);
  const vii = readFingers(makeHand({ fingers: ['index', 'pinky'], thumbOut: true }));
  assert.equal(readDegree(vii), 6);
});

test('a fist means silence', () => {
  assert.equal(readDegree(readFingers(makeHand({}))), null);
});

test('right hand quality counts only the long fingers', () => {
  const one = readFingers(makeHand({ fingers: ['index'], thumbOut: true }));
  assert.equal(readQuality(one), 0);
  const four = readFingers(makeHand({ fingers: ['index', 'middle', 'ring', 'pinky'] }));
  assert.equal(readQuality(four), 3);
});

// ------------------------------------------------------------------- drums

test('a step is a sixteenth note at the given tempo', () => {
  assert.equal(secondsPerStep(120), 0.125);      // 120 BPM -> 0.5s beat -> 0.125s step
  assert.equal(secondsPerStep(60), 0.25);
  assert.ok(Math.abs(secondsPerStep(140) - 60 / 140 / 4) < 1e-12);
  // one full pass of the grid is exactly one bar of 4/4
  assert.ok(Math.abs(secondsPerStep(120) * STEPS - 2) < 1e-12);
});

test('an empty pattern has every lane, all steps off', () => {
  const p = emptyPattern();
  assert.deepEqual(Object.keys(p).sort(), LANES.map((l) => l.id).sort());
  for (const lane of LANES) {
    assert.equal(p[lane.id].length, STEPS);
    assert.ok(p[lane.id].every((s) => s === false));
  }
});

test('patternFrom turns step indices into flags', () => {
  const p = patternFrom({ kick: [0, 4, 8, 12] });
  assert.deepEqual(
    p.kick.map((on, i) => (on ? i : null)).filter((i) => i !== null),
    [0, 4, 8, 12]
  );
  assert.ok(p.snare.every((s) => s === false));
});

test('patternFrom ignores out-of-range steps and unknown lanes', () => {
  const p = patternFrom({ kick: [-1, 0, STEPS, 99], nosuchlane: [0] });
  assert.equal(p.kick.filter(Boolean).length, 1);
  assert.equal(p.kick[0], true);
  assert.ok(!('nosuchlane' in p));
});

test('every built-in pattern is playable', () => {
  for (const [name, spec] of Object.entries(PATTERNS)) {
    const p = patternFrom(spec);
    for (const lane of LANES) {
      assert.equal(p[lane.id].length, STEPS, `${name}/${lane.id} wrong length`);
    }
  }
  // and they are not all silent
  assert.ok(patternFrom(PATTERNS['four/floor']).kick.filter(Boolean).length > 0);
  assert.equal(patternFrom(PATTERNS.empty).kick.filter(Boolean).length, 0);
});

// ---------------------------------------------------------------- presets

test('every synth preset is complete and sanely ordered', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.ok(p.label, `${name} needs a label`);
    assert.ok(p.oscillators.length > 0, `${name} needs oscillators`);
    for (const o of p.oscillators) {
      assert.ok(['sine', 'square', 'sawtooth', 'triangle'].includes(o.type),
        `${name}: bad oscillator type ${o.type}`);
      assert.ok(o.gain > 0 && o.gain <= 1, `${name}: gain out of range`);
      if (o.ratio !== undefined) assert.ok(o.ratio > 0, `${name}: ratio must be positive`);
    }
    // summed oscillator gain drives one envelope; over 1 and the voice clips
    const sum = p.oscillators.reduce((a, o) => a + o.gain, 0);
    assert.ok(sum <= 1.001, `${name}: oscillator gains sum to ${sum}`);

    for (const k of ['attack', 'decay', 'release']) {
      assert.ok(p[k] > 0, `${name}: ${k} must be positive`);
    }
    assert.ok(p.sustain >= 0 && p.sustain <= 1, `${name}: sustain out of range`);
    const [lo, hi] = p.cutoff;
    assert.ok(lo > 0 && hi > lo, `${name}: cutoff range must ascend`);
    assert.ok(hi <= 20000, `${name}: cutoff above hearing`);
  }
});

test('there are several synths to choose from', () => {
  assert.ok(Object.keys(PRESETS).length >= 8);
});

// ------------------------------------------------------------ side assignment

/** A hand positioned at a given mirrored-x, with a given MediaPipe label. */
function placed(mirroredX, label, opts = {}) {
  const lm = makeHand(opts);
  const shift = (1 - mirroredX) - lm[0].x;
  return { label, landmarks: lm.map((p) => ({ ...p, x: p.x + shift })) };
}

test('MediaPipe labels are passed through, never inverted', () => {
  // Regression: the first version flipped every label on the theory that
  // MediaPipe assumes a mirrored frame. It does not — checked against its own
  // left_hands.jpg / right_hands.jpg — and flipping silenced one whole hand.
  const [a, b] = resolveSides([
    placed(0.2, 'Left'),
    placed(0.8, 'Right')
  ]);
  assert.equal(a.side, 'left');
  assert.equal(b.side, 'right');
});

test('labels win over position, so crossed hands still work', () => {
  // player crosses over: the left hand is now on the right of the screen
  const [a, b] = resolveSides([
    placed(0.8, 'Left'),
    placed(0.2, 'Right')
  ]);
  assert.equal(a.side, 'left');
  assert.equal(b.side, 'right');
});

test('two hands labelled the same fall back to screen position', () => {
  const [a, b] = resolveSides([
    placed(0.75, 'Left'),
    placed(0.25, 'Left')
  ]);
  assert.equal(a.side, 'right'); // further right on screen
  assert.equal(b.side, 'left');
});

test('missing labels fall back to screen position', () => {
  const [a, b] = resolveSides([placed(0.9, null), placed(0.1, null)]);
  assert.equal(a.side, 'right');
  assert.equal(b.side, 'left');
});

test('a lone unlabelled hand takes the left part, which is the one that sounds', () => {
  const [only] = resolveSides([placed(0.5, null)]);
  assert.equal(only.side, 'left');
});

test('swapHands inverts the final assignment', () => {
  const [a, b] = resolveSides(
    [placed(0.2, 'Left'), placed(0.8, 'Right')],
    { swapHands: true }
  );
  assert.equal(a.side, 'right');
  assert.equal(b.side, 'left');
});

test('both hands reach their own controls in one frame', () => {
  const frame = readFrame([
    placed(0.2, 'Left', { fingers: ['index', 'middle'], tilt: 20 }),
    placed(0.8, 'Right', { fingers: ['index'], tilt: -20 })
  ]);
  assert.ok(frame.left, 'left hand must be read');
  assert.ok(frame.right, 'right hand must be read');
  assert.equal(frame.degree, 1);       // two fingers -> II
  assert.equal(frame.mode, 'major');   // leaning inward
  assert.equal(frame.quality, 0);      // one finger -> root position
  assert.ok(frame.filter > 0.5);       // right hand leaning inward -> brighter
  assert.equal(frame.hands.length, 2);
});

test('thumb tucked in is the higher octave, thumb out the lower', () => {
  const tucked = readFrame([placed(0.8, 'Right', { thumbOut: false })]);
  const out = readFrame([placed(0.8, 'Right', { thumbOut: true })]);
  assert.equal(tucked.octaveShift, 0);
  assert.equal(out.octaveShift, -1);
  assert.ok(tucked.octaveShift > out.octaveShift, 'tucked thumb must sound higher');
});

test('tilt is signed and inwardness is hand-relative', () => {
  const upright = makeHand({ tilt: 0 });
  assert.ok(Math.abs(readTilt(upright)) < 1);

  const leaningRight = makeHand({ tilt: 30 });
  assert.ok(readTilt(leaningRight) > 20);

  // screen-right lean is inward for the left hand, outward for the right
  assert.equal(isInward(leaningRight, 'left'), true);
  assert.equal(isInward(leaningRight, 'right'), false);

  const leaningLeft = makeHand({ tilt: -30 });
  assert.equal(isInward(leaningLeft, 'right'), true);
  assert.equal(isInward(leaningLeft, 'left'), false);
});
