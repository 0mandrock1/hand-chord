// Music theory: scales, diatonic chords, inversions, sevenths.

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
];

export const NOTE_LABELS = [
  'C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'
];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10] // natural minor
};

export const DEGREE_LABELS = {
  major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
  minor: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']
};

export const QUALITY_LABELS = ['root', '1st inv', '7th', 'dom/dim 7th'];

/**
 * Scale step -> semitone offset, wrapping octaves.
 * step may exceed the scale length (e.g. 8 = third above the octave).
 */
function step(scale, index) {
  const len = scale.length;
  const octave = Math.floor(index / len);
  return scale[((index % len) + len) % len] + 12 * octave;
}

/** Triad quality from its own interval structure. */
function triadQuality(intervals) {
  const [, third, fifth] = intervals;
  if (third === 4 && fifth === 7) return 'maj';
  if (third === 3 && fifth === 7) return 'min';
  if (third === 3 && fifth === 6) return 'dim';
  if (third === 4 && fifth === 8) return 'aug';
  return 'other';
}

/**
 * Build a chord.
 * @param {object} o
 * @param {number} o.tonic      0-11, key root pitch class
 * @param {'major'|'minor'} o.mode
 * @param {number} o.degree     0-6 (I..VII)
 * @param {number} o.quality    0=root, 1=1st inversion, 2=diatonic 7th, 3=dominant/diminished 7th
 * @param {number} o.octave     MIDI octave of the chord root (4 = middle)
 * @returns {{midi:number[], name:string, degreeLabel:string}}
 */
export function buildChord({ tonic, mode, degree, quality, octave }) {
  const scale = SCALES[mode];
  const rootOffset = step(scale, degree);
  const intervals = [
    0,
    step(scale, degree + 2) - rootOffset,
    step(scale, degree + 4) - rootOffset
  ];

  const kind = triadQuality(intervals);
  let tones = intervals.slice();

  if (quality === 2) {
    // diatonic seventh (maj7 / min7 / m7b5)
    tones.push(step(scale, degree + 6) - rootOffset);
  } else if (quality === 3) {
    // dominant 7th, or fully diminished 7th when the triad is diminished
    tones = kind === 'dim' ? [0, 3, 6, 9] : [0, 4, 7, 10];
  }

  let midi = tones.map(
    (t) => 12 * (octave + 1) + tonic + rootOffset + t
  );

  if (quality === 1) {
    // 1st inversion: root up an octave
    midi = midi.slice(1).concat(midi[0] + 12);
  }

  midi.sort((a, b) => a - b);

  return {
    midi,
    name: chordName({ tonic, rootOffset, kind, tones, quality }),
    degreeLabel: DEGREE_LABELS[mode][degree]
  };
}

function chordName({ tonic, rootOffset, kind, tones, quality }) {
  const root = NOTE_NAMES[(tonic + rootOffset + 120) % 12];
  const seventh = tones[3];
  let suffix = { maj: '', min: 'm', dim: 'dim', aug: 'aug', other: '' }[kind];

  if (seventh !== undefined) {
    if (quality === 3) {
      suffix = kind === 'dim' ? 'dim7' : '7';
    } else if (kind === 'maj') {
      suffix = 'maj7';
    } else if (kind === 'min') {
      suffix = 'm7';
    } else if (kind === 'dim') {
      suffix = 'm7♭5';
    }
  }

  return root + suffix + (quality === 1 ? '/1st' : '');
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
