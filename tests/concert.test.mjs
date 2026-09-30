import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OnsetDetector, FlashLimiter, concertPalette, concertDrive, approach, visualParams, GAUGE_TOP,
  prepareShow, detectDrops, interpAt, windowIndex, beatsAt, beatClock, sampleShow, ShowDirector,
  synthSpectrum, synthWave, bandLevelAt, hueRotate, sectionHue, clockText,
} from "../src/ui/concert-logic.js";
const SCORE_MAX = GAUGE_TOP;
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

test("helpers: frame-rate independent approach", () => {
  let x = 0;
  for (let i = 0; i < 60; i++) x = approach(x, 100, 1 / 60, 3);
  let y = 0;
  for (let i = 0; i < 30; i++) y = approach(y, 100, 1 / 30, 3);
  assert.ok(Math.abs(x - y) < 0.5, `${x} ≈ ${y}`);
});

const SAME_IN_FRENCH = new Set(["Concert", "Drop"]);

test("concert strings are translated into French and merged into the dictionary", () => {
  for (const [en, fr] of Object.entries(FR_CONCERT)) {
    assert.equal(FR[en], fr, en);
    assert.ok(fr && (fr !== en || SAME_IN_FRENCH.has(en)), en);
  }
  assert.ok(FR["Concert mode"]);
});

// ------------------------------------------------------------------ show from a stored analysis

/**
 * A 90 s analysed record: calm intro, a build-up, a drop at 45 s into a
 * peak, a break. Windows every 3 s (centres), 128 BPM.
 */
function record({ bpm = 128, dropAt = 45, sections = true } = {}) {
  const times = [];
  for (let t = 3; t <= 87; t += 3) times.push(t);
  const intensity = times.map((t) => (t < 30 ? 20 : t < dropAt ? 20 + ((t - 30) / 15) * 20 : t < 75 ? 90 : 30));
  const n = times.length;
  const fill = (v) => times.map(() => v);
  const series = {
    bpm: fill(bpm), bpmConfidence: fill(0.8), onsetRate: intensity.map((v) => v / 10), loudnessRel: intensity.map((v) => (v - 90) / 6),
    bandSub: intensity.map((v) => 0.1 + v / 900), bandBass: fill(0.3), bandLowMid: fill(0.4), bandHighMid: fill(0.15), bandHigh: fill(0.02),
    fastPulseShare: fill(0), fastPulseRate: fill(0),
  };
  const subscores = Object.fromEntries(["energy", "tempo", "density", "brightness", "harshness", "pressure", "complexity", "noise"].map((k) => [k, intensity.map((v) => v * 0.9)]));
  return {
    id: "t1", name: "Song.wav", duration: 90, finalScore: 82,
    features: { bpm, bpmConfidence: 0.8, duration: 90, bandEnergy: { sub: 0.15, bass: 0.3, lowMid: 0.4, highMid: 0.13, high: 0.02 }, timeline: { windowSeconds: 6, hopSeconds: 3, times, series } },
    auto: {
      curves: { times, intensity, subscores },
      music: {
        tempo: { bpm },
        sections: sections ? [
          { start: 0, end: 30, label: "Intro" }, { start: 30, end: 44.2, label: "Build-up" },
          { start: 44.2, end: 75, label: "Peak" }, { start: 75, end: 90, label: "Break" },
        ] : null,
      },
    },
    _n: n,
  };
}

test("prepareShow: nothing without a curve; curves, bands and tempo from the record", () => {
  assert.equal(prepareShow(null), null);
  assert.equal(prepareShow({ auto: {} }), null);
  const s = prepareShow(record());
  assert.equal(s.duration, 90);
  assert.equal(s.times.length, s.intensity.length);
  assert.equal(s.bands.length, 5);
  for (const b of s.bands) for (const v of b) assert.ok(v >= 0 && v <= 1);
  assert.ok(Math.max(...s.bands[0]) === 1, "each band on its own scale");
  assert.ok(s.bpm.every((v) => v === 128));
  assert.deepEqual(s.sections.map((x) => x.label), ["Intro", "Build-up", "Peak", "Break"]);
  // an older record without a timeline series still gives a show (track-level values)
  const r = record();
  delete r.features.timeline;
  const old = prepareShow(r);
  assert.ok(old && old.bands.every((b) => b.length === old.times.length));
});

test("timeline interpolation: through the knots, smooth, never beyond its neighbours", () => {
  const times = [3, 6, 9, 12, 15];
  const v = [10, 10, 50, 50, 20];
  assert.equal(windowIndex(times, 0), 0);
  assert.equal(windowIndex(times, 7), 1);
  assert.equal(windowIndex(times, 99), 4);
  assert.equal(interpAt(v, times, 6), 10);
  assert.equal(interpAt(v, times, 9), 50);
  assert.equal(interpAt(v, times, 0), 10, "before the first window: its value");
  assert.equal(interpAt(v, times, 40), 20, "after the last: its value");
  let prev = -1;
  for (let t = 6; t <= 9; t += 0.25) {
    const x = interpAt(v, times, t);
    assert.ok(x >= 10 && x <= 50, `no overshoot at ${t}: ${x}`);
    assert.ok(x >= prev, "rises monotonically between two rising knots");
    prev = x;
  }
  // continuous: no jump across a knot
  assert.ok(Math.abs(interpAt(v, times, 8.999) - interpAt(v, times, 9.001)) < 0.1);
});

test("drops: a big rise is a drop, snapped to the section start; a gentle build is not", () => {
  const r = record();
  const s = prepareShow(r);
  assert.equal(s.drops.length, 1);
  assert.equal(s.drops[0].time, 44.2, "snapped to the peak section");
  assert.ok(s.drops[0].to >= 85 && s.drops[0].from <= 45);
  // without sections: between the windows around 45 s
  const d = detectDrops(r.auto.curves.times, r.auto.curves.intensity, []);
  assert.equal(d.length, 1);
  assert.ok(d[0].time > 40 && d[0].time < 48, `${d[0].time}`);
  // a slow ramp never drops; nor does a rise into something calm
  const times = Array.from({ length: 30 }, (_, i) => 3 + i * 3);
  assert.equal(detectDrops(times, times.map((t) => t), []).length, 0);
  assert.equal(detectDrops(times, times.map((t) => (t > 40 ? 35 : 5)), []).length, 0);
  // two jumps close together count once (the bigger)
  const two = detectDrops(times, times.map((t) => (t < 30 ? 10 : t < 36 ? 50 : 95)), []);
  assert.equal(two.length, 1);
});

test("beat clock: beats follow the tempo, the bar grid lands on the drop", () => {
  const s = prepareShow(record());
  assert.ok(Math.abs(beatsAt(s, 60) - beatsAt(s, 30) - 64) < 1e-6, "128 BPM: 64 beats in 30 s");
  assert.equal(beatsAt(s, 0), 0);
  const c = beatClock(s, 44.2);
  assert.ok(Math.abs(c.beats - Math.round(c.beats)) < 1e-6, "on a beat");
  assert.equal(c.inBar, 0, "on a downbeat");
  const later = beatClock(s, 44.2 + 60 / 128 * 2.5);
  assert.equal(later.inBar, 2);
  assert.ok(Math.abs(later.phase - 0.5) < 1e-6);
  // a tempo change: beats keep counting without a jump
  const r = record();
  r.features.timeline.series.bpm = r.features.timeline.series.bpm.map((v, i) => (i < 15 ? 100 : 150));
  const s2 = prepareShow(r);
  let prev = beatsAt(s2, 0);
  for (let t = 0.1; t < 90; t += 0.1) {
    const b = beatsAt(s2, t);
    assert.ok(b > prev && b - prev < 0.1 * 150 / 60 + 1e-6, `monotonic at ${t}`);
    prev = b;
  }
});

test("sampleShow: the drop is a cliff, tension builds before it, next section known", () => {
  const s = prepareShow(record());
  const out = {};
  sampleShow(s, 20, out);
  assert.ok(Math.abs(out.intensity - 20) < 1);
  assert.equal(out.section.label, "Intro");
  assert.equal(out.nextSection.label, "Build-up");
  assert.ok(Math.abs(out.nextSectionIn - 10) < 1e-6);
  assert.equal(out.tension, 0, "no tension long before the drop");
  const before = sampleShow(s, 43.5, {}).intensity;
  const after = sampleShow(s, 44.6, {}).intensity;
  assert.ok(after - before > 30, `jump at the drop (${before} → ${after})`);
  const t1 = sampleShow(s, 36, {}).tension, t2 = sampleShow(s, 43, {}).tension;
  assert.ok(t1 > 0 && t2 > t1 && t2 <= 1, `tension grows (${t1} → ${t2})`);
  assert.ok(sampleShow(s, 43, {}).nextDropIn > 0);
  assert.equal(sampleShow(s, 50, {}).tension, 0, "released after it");
  assert.ok(sampleShow(s, 50, {}).sinceDrop > 5);
  for (const v of Object.values(out.subs)) assert.ok(Number.isFinite(v));
  assert.ok(out.progress > 0.2 && out.progress < 0.25);
});

test("director: beats, one drop, section changes; a seek fires nothing", () => {
  const s = prepareShow(record());
  const d = new ShowDirector(s);
  const seen = { beat: 0, down: 0, drop: 0, section: [] };
  for (let t = 0; t <= 90; t += 1 / 60) {
    for (const e of d.advance(t)) {
      if (e.type === "beat") { seen.beat++; if (e.downbeat) seen.down++; }
      if (e.type === "drop") seen.drop++;
      if (e.type === "section") seen.section.push(e.section.label);
    }
  }
  assert.ok(Math.abs(seen.beat - 192) <= 1, `128 BPM for 90 s (${seen.beat})`);
  assert.ok(Math.abs(seen.down - 48) <= 1);
  assert.equal(seen.drop, 1);
  assert.deepEqual(seen.section, ["Build-up", "Peak", "Break"]);
  // jumping over the drop (a seek) does not fire it; going back neither
  const j = new ShowDirector(s);
  j.advance(40);
  assert.equal(j.advance(50).length, 0);
  assert.equal(j.advance(10).length, 0);
});

test("synthesized spectrum and waveform: bounded, follow the bands and the beat", () => {
  const N = 512;
  const spec = new Float32Array(N), wave = new Float32Array(N);
  const base = { bands: [1, 1, 0.6, 0.4, 0.3], level: 0.9, beatAmt: 0.9, fastRate: 0, onsetRate: 6, intensity: 90 };
  const onBeat = { phase: 0, inBar: 0 }, offBeat = { phase: 0.6, inBar: 0 };
  synthSpectrum(spec, base, onBeat, 1.2);
  for (const v of spec) assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
  const low = (a) => a.slice(10, 60).reduce((x, y) => x + y, 0);
  const lowOn = low(spec);
  synthSpectrum(spec, base, offBeat, 1.2);
  assert.ok(lowOn > low(spec) * 1.2, "the kick lifts the lows on the beat");
  // no highs in the analysis: quiet top bins
  synthSpectrum(spec, { ...base, bands: [1, 1, 0.5, 0, 0], onsetRate: 0 }, offBeat, 1.2);
  const top = spec.slice(N - 60).reduce((x, y) => x + y, 0) / 60;
  assert.ok(top < 0.05, `highs follow the bands (${top})`);
  // silence: next to nothing
  synthSpectrum(spec, { ...base, bands: [0, 0, 0, 0, 0], beatAmt: 0, onsetRate: 0, level: 0 }, offBeat, 3);
  assert.ok(Math.max(...spec) < 0.01);
  synthWave(wave, base, onBeat, 2);
  for (const v of wave) assert.ok(Math.abs(v) <= 1.5 && Number.isFinite(v));
  assert.ok(Math.max(...wave.map(Math.abs)) > 0.1, "it moves");
  assert.equal(bandLevelAt([0.1, 0.2, 0.3, 0.4, 0.5], 10), 0.1);
  assert.equal(bandLevelAt([0.1, 0.2, 0.3, 0.4, 0.5], 20000), 0.5);
});

test("colour and camera helpers", () => {
  const red = [1, 0, 0];
  assert.deepEqual(hueRotate(red, 0).map((x) => +x.toFixed(6)), [1, 0, 0]);
  const g = hueRotate(red, 120);
  assert.ok(g[1] > g[0] && g[1] > g[2], "120°: red turns green");
  for (const x of hueRotate([0.4, 0.7, 0.2], 77)) assert.ok(x >= 0 && x <= 1);
  assert.ok(sectionHue("Break") !== sectionHue("Peak"));
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(75.9), "1:15");
  assert.equal(clockText(NaN), "0:00");
  const f = visualParams({}, {
    time: 10, dt: 1 / 60, travel: 0, kick: 0, bass: 0, loud: 0.5, idle: 0, flash: 0, drive: concertDrive(80), palette: concertPalette(80),
    tension: 1, bigAt: 9, bigStrength: 1, cam: { x: 0.01, y: 0, zoom: 1.1, roll: 0.02 },
  });
  assert.ok(f.zoom > 1, "tension: the feedback turns inwards");
  assert.equal(f.tension, 1);
  assert.deepEqual(f.cam, [0.01, 0, 1.1, 0.02]);
  assert.ok(f.shock2[0] === 1 && f.shock2[1] > 0);
  const calm = visualParams({}, { time: 10, dt: 1 / 60, travel: 0, kick: 0, bass: 0, loud: 0.5, idle: 0, flash: 0, drive: concertDrive(80), palette: concertPalette(80) });
  assert.ok(calm.zoom < 1 && calm.tension === 0);
});

test("scores above the top of the scale keep the visuals at the top", () => {
  assert.deepEqual(concertPalette(GAUGE_TOP + 40), concertPalette(GAUGE_TOP));
  const r = record();
  r.auto.curves.intensity = r.auto.curves.intensity.map((v) => v * 2);
  const s = prepareShow(r);
  assert.ok(s.peak > GAUGE_TOP, "the real value is kept");
  assert.ok(sampleShow(s, 60, {}).intensity > GAUGE_TOP);
});
