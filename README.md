# Hand Chord

Play chords with your hands. A webcam tracks both hands in the browser, and the
gestures drive a Web Audio synthesizer — no plugins, no server, no build step.

Left hand chooses **which** chord. Right hand shapes **how** it sounds.

> Independent reimplementation of a gesture-synth idea, written from scratch and
> published with the original author's blessing. No code or assets were copied.

## Try it

```bash
git clone https://github.com/0mandrock1/hand-chord.git
cd hand-chord
python3 -m http.server 8080
```

Open <http://localhost:8080>. A camera needs a secure context, so `localhost` or
HTTPS only — plain `file://` will not work.

Deploying is a matter of serving the folder: GitHub Pages, Vercel, Netlify or any
static host will do.

## Gestures

### Left hand — which chord

| Gesture | Result |
| --- | --- |
| lean inward | major scale |
| lean outward | minor scale |
| 1 finger | degree I |
| 2 fingers | degree II |
| 3 fingers | degree III |
| 4 fingers | degree IV |
| 5 fingers | degree V |
| index + pinky | degree VI |
| index + pinky + thumb | degree VII |
| closed fist | silence |

### Right hand — how it sounds

| Gesture | Result |
| --- | --- |
| 1 finger | root position |
| 2 fingers | 1st inversion |
| 3 fingers | major / minor 7th |
| 4 fingers | dominant / diminished 7th |
| thumb tucked in | higher octave |
| thumb stuck out | lower octave |
| lean inward | filter opens (brighter) |
| lean outward | filter closes (darker) |
| hand raised | louder |
| hand lowered | softer |

With no right hand in frame the filter follows the on-screen slider and the level
sits at a fixed default, so you can play one-handed.

If the hands are detected the wrong way round — camera drivers disagree about
mirroring — tick **Swap hands**.

## How it works

```
webcam ──► MediaPipe HandLandmarker ──► gesture features ──► chord ──► Web Audio
           (21 landmarks per hand)      degree/mode/quality   voices    synth
```

| File | Responsibility |
| --- | --- |
| `js/tracker.js` | camera stream, MediaPipe landmarks and raw handedness, skeleton overlay |
| `js/gestures.js` | which hand is which, then landmarks → fingers, tilt, height → control frame |
| `js/theory.js` | scales, diatonic chords, inversions, sevenths, chord names |
| `js/synth.js` | polyphonic Web Audio voices, three presets, filter, limiter |
| `js/main.js` | wiring and UI state |

Finger extension is measured rotation-invariantly: a fingertip further from the
wrist than its own middle joint counts as extended, so the reading survives a
rotated or tilted hand. The thumb is judged sideways instead, by its distance to
the index knuckle relative to the palm span.

Telling the hands apart is where this kind of app usually breaks. MediaPipe's
handedness label is the anatomically correct hand for the frame as handed in —
verified against its own `left_hands.jpg` / `right_hands.jpg` test images, not
assumed — and the display mirror is CSS-only, so the label is used as-is. Its
one real failure mode is labelling both hands the same, which would silence one
of them; when that happens the app falls back to screen position, since a
mirrored view puts your left hand on the left. Labels take priority so that
crossing your hands still works.

Chords are rebuilt only when the gesture signature actually changes, so held
notes ring instead of retriggering every frame.

## Privacy

Video is processed entirely in the browser. Nothing is uploaded, recorded or sent
anywhere. The only network requests are for the MediaPipe runtime and model on
first load.

## Requirements

A browser with WebGL, WebAssembly and Web Audio — current Chrome, Edge, Firefox
or Safari. Works on mobile, though hand tracking is noticeably happier with a
decent camera and good light.

## Licence

MIT — see [LICENSE](LICENSE).
