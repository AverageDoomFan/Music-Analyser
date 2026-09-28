// Renders test-bench tracks off the main thread and returns WAV bytes.
import { suiteTracks, } from "./suite.js";
import { toWav } from "./synth.js";

let tracks = null;
self.onmessage = (e) => {
  const { id, seconds } = e.data;
  try {
    tracks ??= new Map(suiteTracks(seconds).map((t) => [t.id, t]));
    const t = tracks.get(id);
    if (!t) throw new Error(`piste de test inconnue : ${id}`);
    const wav = toWav(t.render());
    self.postMessage({ id, wav }, [wav]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
self.postMessage({ ready: true });
