// Headless checks for the pure logic (no DOM, no audio, no camera).
// Run: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChord, midiToName, midiToFreq } from '../js/theory.js';
import { readFingers, readDegree, readQuality, readTilt, isInward } from '../js/gestures.js';

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
