// Webcam + MediaPipe hand landmark tracking.

const VISION_VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  /**
   * Perception only: this class reports what the camera sees — landmarks and
   * MediaPipe's raw handedness label. Deciding which hand plays which role is
   * gestures.js's job (see resolveSides).
   *
   * @param {HTMLVideoElement} video
   */
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.onFrame = () => {};
  }

  async init() {
    const { FilesetResolver, HandLandmarker } = await import(
      /* @vite-ignore */ `${CDN}/vision_bundle.mjs`
    );

    const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false
    });
    this.video.srcObject = stream;
    await this.video.play();
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.step();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    const stream = this.video.srcObject;
    if (stream) for (const t of stream.getTracks()) t.stop();
  }

  step() {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2) return;
    if (v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    const result = this.landmarker.detectForVideo(v, performance.now());
    const hands = [];

    // `handedness` is current, `handednesses` is the deprecated alias kept for
    // older builds. Verified against MediaPipe's own labelled test images
    // (left_hands.jpg / right_hands.jpg): the label is the ANATOMICALLY correct
    // hand for the frame as handed in, with no mirroring applied. Our display
    // mirror is CSS-only and does not reach the detector, so the label is
    // passed through untouched.
    const handedness = result.handedness || result.handednesses || [];

    for (let i = 0; i < result.landmarks.length; i++) {
      hands.push({
        label: handedness[i]?.[0]?.categoryName ?? null,
        score: handedness[i]?.[0]?.score ?? 0,
        landmarks: result.landmarks[i]
      });
    }

    this.onFrame(hands);
  }
}

// Landmark connectivity for the skeleton overlay.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

/** Draw a mirrored skeleton overlay onto a 2D canvas. */
export function drawHands(ctx, hands, colours) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  for (const hand of hands) {
    const colour = colours[hand.side] || '#fff';
    const pt = (i) => ({
      x: (1 - hand.landmarks[i].x) * width,
      y: hand.landmarks[i].y * height
    });

    ctx.lineWidth = Math.max(2, width / 320);
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.75;
    for (const [a, b] of HAND_CONNECTIONS) {
      const p = pt(a);
      const q = pt(b);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = colour;
    for (let i = 0; i < hand.landmarks.length; i++) {
      const p = pt(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.5, width / 220), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
