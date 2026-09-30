import { test } from "node:test";
import assert from "node:assert/strict";
import { OnsetDetector, FlashLimiter, concertPalette, concertDrive, approach, levelIntensity } from "../src/ui/concert-logic.js";
import { SCORE_MAX } from "../src/config.js";
import FR from "../src/i18n/fr.js";
import FR_CONCERT from "../src/i18n/fr-concert.js";

const SR = 44100, FFT = 2048, BINS = FFT / 2;
const hz = SR / FFT;

/** A dB spectrum: quiet floor, optional kick (low band) and broadband hit. */
function frame({ kick = 0, hit = 0, floor = -80, seed = 0 }) {
  const db = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const f = i * hz;
    let v = floor + 3 * Math.sin(i * 1.7 + seed); // a little texture
    if (kick && f > 40 && f < 160) v = Math.max(v, -80 + 60 * kick);
    if (hit) v = Math.max(v, -80 + 45 * hit);
    db[i] = v;
  }
  return db;
}

test("onset detector: kicks on a steady beat, nothing in a steady pad", () => {
  const d = new OnsetDetector({ sampleRate: SR, fftSize: FFT });
  let kicks = 0, onsets = 0;
  // 4 s at 60 fps; kick every 0.5 s (120 BPM) lasting 3 frames with decay
  for (let n = 0; n < 240; n++) {
    const tt = n / 60;
    const ph = n % 30;
    const k = ph < 3 ? 1 - ph * 0.3 : 0;
    const o = d.push(frame({ kick: k, seed: n }), tt);
    if (tt > 0.5) { if (o.kick) kicks++; if (o.onset) onsets++; }
  }
  assert.ok(kicks >= 6 && kicks <= 8, `about one kick per beat (${kicks})`);
  assert.ok(onsets >= kicks - 1, `kicks are onsets too (${onsets})`);

  const pad = new OnsetDetector({ sampleRate: SR, fftSize: FFT });
  let false_ = 0;
  for (let n = 0; n < 240; n++) {
    const o = pad.push(frame({ floor: -40, seed: 0 }), n / 60);
    if (o.kick || o.onset) false_++;
  }
  assert.ok(false_ <= 1, `a steady sound gives no onsets (${false_})`);
});

test("onset detector: a broadband hit is an onset, not a kick; refractory time holds", () => {
  const d = new OnsetDetector({ sampleRate: SR, fftSize: FFT });
  for (let n = 0; n < 60; n++) d.push(frame({ seed: n }), n / 60);
  const o = d.push(frame({ hit: 1, seed: 60 }), 1);
  assert.equal(o.onset, true);
  assert.ok(o.strength > 0 && o.strength <= 1);
  // the same hit again 1 frame later is refused (refractory)
  d.push(frame({ seed: 61 }), 1 + 1 / 60);
  const again = d.push(frame({ hit: 1, seed: 62 }), 1 + 2 / 60);
  assert.equal(again.onset, false);
  // band levels stay within 0..1
  for (const k of ["bass", "mid", "high", "loud"]) assert.ok(o[k] >= 0 && o[k] <= 1, k);
});

test("flash limiter: never more than 3 flashes per second, fewer and softer with reduced motion", () => {
  const l = new FlashLimiter();
  let n = 0;
  for (let i = 0; i < 600; i++) if (l.request(i / 60, 1) > 0) n++; // asked every frame for 10 s
  assert.ok(n <= 30, `≤ 3/s (${n})`);
  const r = new FlashLimiter({ reduced: true });
  let m = 0, max = 0;
  for (let i = 0; i < 600; i++) { const a = r.request(i / 60, 1); if (a > 0) { m++; max = Math.max(max, a); } }
  assert.ok(m <= 10, `≤ 1/s with reduced motion (${m})`);
  assert.ok(max <= 0.25);
  assert.equal(new FlashLimiter({ maxPerSecond: 20 }).gap >= 1 / 3, true, "3/s is a hard cap");
  assert.equal(l.request(100, 0), 0, "no flash for nothing");
});

test("palette follows the heat ramp and turns white hot past 100", () => {
  const calm = concertPalette(5), mid = concertPalette(60), top = concertPalette(100), otc = concertPalette(SCORE_MAX);
  for (const p of [calm, mid, top, otc]) for (const c of [p.base, p.accent, p.shadow]) for (const x of c) assert.ok(x >= 0 && x <= 1);
  assert.ok(calm.base[2] > calm.base[0], "calm is blue");
  assert.equal(top.hot, 0);
  assert.equal(otc.hot, 1);
  assert.ok(concertPalette(112).hot > 0 && concertPalette(112).hot < 1);
  assert.ok(Math.min(...otc.accent) > 0.95, "off the charts: white-hot accents");
  assert.ok(Math.min(...otc.base) < 0.8, "the body colour stays saturated");
  assert.deepEqual(concertPalette(-10), concertPalette(0));
  assert.deepEqual(concertPalette(null), concertPalette(0));
});

test("drive: speed and shake grow with the intensity, no shake when calm", () => {
  const a = concertDrive(20), b = concertDrive(90), c = concertDrive(120);
  assert.ok(a.speed < b.speed && b.speed <= c.speed);
  assert.equal(a.shake, 0);
  assert.ok(b.shake > 0);
  assert.ok(c.hot > 0 && b.hot === 0);
  assert.ok(concertDrive(60, { tempo: 100 }).speed > concertDrive(60, { tempo: 0 }).speed, "tempo speeds the tunnel up");
});

test("helpers: frame-rate independent approach, level guess stays below the top stages", () => {
  let x = 0;
  for (let i = 0; i < 60; i++) x = approach(x, 100, 1 / 60, 3);
  let y = 0;
  for (let i = 0; i < 30; i++) y = approach(y, 100, 1 / 30, 3);
  assert.ok(Math.abs(x - y) < 0.5, `${x} ≈ ${y}`);
  assert.ok(levelIntensity(1) <= 72 && levelIntensity(0) === 0);
});

test("concert strings are translated into French and merged into the dictionary", () => {
  for (const [en, fr] of Object.entries(FR_CONCERT)) {
    assert.equal(FR[en], fr, en);
    assert.ok(fr && fr !== en, en);
  }
  assert.ok(FR["Concert mode"]);
});
