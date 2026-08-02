// Turn raw MediaPipe hand landmarks into musical control values.
//
// Landmark indices (MediaPipe Hands, 21 points):
//   0 wrist | 1-4 thumb | 5-8 index | 9-12 middle | 13-16 ring | 17-20 pinky

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;

const FINGERS = [
  { name: 'index', tip: 8, pip: 6 },
  { name: 'middle', tip: 12, pip: 10 },
  { name: 'ring', tip: 16, pip: 14 },
  { name: 'pinky', tip: 20, pip: 18 }
];

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Which fingers are extended.
 * Rotation-invariant: a fingertip further from the wrist than its own PIP joint
 * means the finger is straight, whichever way the hand is turned.
 * The thumb is measured sideways instead (distance to the index knuckle).
 */
export function readFingers(lm) {
  const wrist = lm[WRIST];
  const span = dist(wrist, lm[MIDDLE_MCP]) || 1e-6;

  const state = {};
  for (const f of FINGERS) {
    state[f.name] = dist(lm[f.tip], wrist) > dist(lm[f.pip], wrist) * 1.12;
  }
  state.thumb = dist(lm[THUMB_TIP], lm[INDEX_MCP]) / span > 0.72;
  return state;
}

/**
 * Hand tilt in mirrored screen space, degrees.
 * 0 = fingers point straight up, positive = leaning toward screen-right.
 */
export function readTilt(lm) {
  const dx = -(lm[MIDDLE_MCP].x - lm[WRIST].x); // mirrored view
  const dy = lm[MIDDLE_MCP].y - lm[WRIST].y;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * How far the hand leans toward the body centre, degrees.
 * In a mirrored (selfie) view the left hand sits on screen-left, so leaning
 * right is "inward"; for the right hand it is the opposite.
 */
export function inwardness(lm, side) {
  const tilt = readTilt(lm);
  return side === 'left' ? tilt : -tilt;
}

/** Wrist height, 0 at the bottom of the frame, 1 at the top. */
export function readHeight(lm) {
  return clamp(1 - lm[WRIST].y, 0, 1);
}

const TILT_DEADZONE = 8; // degrees; below this the hand counts as upright

export function isInward(lm, side) {
  return inwardness(lm, side) > TILT_DEADZONE;
}

/**
 * Left hand -> scale degree, 0-6.
 *   1 finger  -> I      2 -> II     3 -> III    4 -> IV    5 -> V
 *   index + pinky          -> VI
 *   index + pinky + thumb  -> VII
 * Returns null when the shape matches nothing (e.g. a closed fist).
 */
export function readDegree(fingers) {
  const { thumb, index, middle, ring, pinky } = fingers;
  const splayed = index && pinky && !middle && !ring;

  if (splayed) return thumb ? 6 : 5;

  const count =
    (thumb ? 1 : 0) + (index ? 1 : 0) + (middle ? 1 : 0) +
    (ring ? 1 : 0) + (pinky ? 1 : 0);

  if (count >= 1 && count <= 5) return count - 1;
  return null;
}

/**
 * Right hand -> chord quality, 0-3. Thumb is reserved for the octave switch,
 * so only the four long fingers are counted.
 */
export function readQuality(fingers) {
  const count =
    (fingers.index ? 1 : 0) + (fingers.middle ? 1 : 0) +
    (fingers.ring ? 1 : 0) + (fingers.pinky ? 1 : 0);
  return count === 0 ? 0 : count - 1;
}

function normaliseLabel(label) {
  if (typeof label !== 'string') return null;
  const l = label.toLowerCase();
  return l === 'left' || l === 'right' ? l : null;
}

/** Horizontal position of the wrist in mirrored screen space, 0 = screen-left. */
function mirroredX(hand) {
  return 1 - hand.landmarks[WRIST].x;
}

/**
 * Decide which detected hand plays the left part and which plays the right.
 *
 * MediaPipe's label is trusted when it distinguishes the two hands, because it
 * survives hands crossing over each other. Its characteristic failure is giving
 * BOTH hands the same label — one hand then goes silent, since two hands cannot
 * both be the left one. In that case fall back to screen position: the display
 * is mirrored, so the player's left hand sits on the left of the screen.
 *
 * @param {Array<{landmarks:Array, label:?string}>} hands
 * @param {{swapHands?: boolean}} [opts]
 * @returns {Array<{landmarks:Array, label:?string, side:'left'|'right'}>}
 */
export function resolveSides(hands, { swapHands = false } = {}) {
  const out = hands.map((h) => ({ ...h, side: normaliseLabel(h.label) }));

  if (out.length === 2) {
    if (!out[0].side || !out[1].side || out[0].side === out[1].side) {
      const [l, r] = mirroredX(out[0]) <= mirroredX(out[1])
        ? [out[0], out[1]]
        : [out[1], out[0]];
      l.side = 'left';
      r.side = 'right';
    }
  } else {
    // A single unlabelled hand has nothing to compare against; assume the left
    // part, which is the one that actually makes sound.
    for (const h of out) h.side = h.side || 'left';
  }

  if (swapHands) {
    for (const h of out) h.side = h.side === 'left' ? 'right' : 'left';
  }
  return out;
}

/**
 * Read both hands into one control frame.
 * @param {Array<{landmarks:Array, label:?string}>} hands
 * @param {{swapHands?: boolean}} [opts]
 */
export function readFrame(hands, opts = {}) {
  const resolved = resolveSides(hands, opts);

  const out = {
    hands: resolved, // side-tagged, for the overlay
    left: null,
    right: null,
    degree: null,
    mode: 'major',
    quality: 0,
    octaveShift: 0,
    filter: null,
    volume: null
  };

  for (const hand of resolved) {
    const fingers = readFingers(hand.landmarks);
    const info = {
      fingers,
      tilt: readTilt(hand.landmarks),
      inward: isInward(hand.landmarks, hand.side),
      lean: inwardness(hand.landmarks, hand.side),
      height: readHeight(hand.landmarks)
    };

    if (hand.side === 'left') {
      out.left = info;
      out.degree = readDegree(fingers);
      out.mode = info.inward ? 'major' : 'minor';
    } else {
      out.right = info;
      out.quality = readQuality(fingers);
      // fingers.thumb is true when the thumb is held AWAY from the palm, and a
      // thumb held out means the lower octave.
      out.octaveShift = fingers.thumb ? -1 : 0;
      out.filter = clamp((info.lean + 45) / 90, 0, 1);
      out.volume = clamp((info.height - 0.15) / 0.6, 0, 1);
    }
  }

  return out;
}
