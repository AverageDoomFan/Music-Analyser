// Optional lyrics lookup on LRCLIB (lrclib.net, open lyrics database, no key).
// Only artist / title / album / duration are sent. The lyrics text is never
// stored: we keep whether lyrics exist, the "instrumental" flag, and a mood
// suggestion from a small word list, that the user confirms or changes.

const API = "https://lrclib.net/api/search";

const LEXICON = {
  joyeux: ["happy", "joy", "smile", "sun", "sunshine", "dance", "party", "celebrate", "fun", "laugh", "heureux", "joie", "sourire", "soleil", "danse", "fête", "rire", "bonheur"],
  doux: ["love", "baby", "kiss", "heart", "tender", "gentle", "hold me", "forever", "amour", "coeur", "cœur", "doux", "tendre", "câlin", "embrasse", "toujours"],
  triste: ["cry", "tears", "alone", "lonely", "goodbye", "miss you", "lost", "broken", "sorry", "pleure", "larmes", "seul", "adieu", "manque", "perdu", "triste", "brisé"],
  sombre: ["dark", "death", "die", "dead", "grave", "night", "shadow", "void", "hell", "sombre", "mort", "mourir", "nuit", "ombre", "vide", "enfer", "noir"],
  violent: ["kill", "blood", "fight", "hate", "rage", "war", "gun", "fuck", "destroy", "scream", "tue", "sang", "combat", "haine", "rage", "guerre", "flingue", "détruire", "crie", "nique"],
};

/** Mood suggestion from lyrics text: { mood, strength, scores } or null. */
export function suggestMood(text) {
  if (!text) return null;
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\s']/gu, " ").replace(/\s+/g, " ")} `;
  const words = t.trim().split(" ").length || 1;
  const scores = {};
  for (const [mood, list] of Object.entries(LEXICON)) {
    let n = 0;
    for (const w of list) {
      let i = t.indexOf(` ${w} `);
      while (i >= 0) { n++; i = t.indexOf(` ${w} `, i + 1); }
    }
    scores[mood] = n / words;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 0.004) return { mood: "neutre", strength: 1, scores };
  const strength = best[1] > 0.03 ? 3 : best[1] > 0.012 ? 2 : 1;
  return { mood: best[0], strength, scores };
}

/**
 * @returns {Promise<{found:boolean, instrumental:boolean, suggestion:object|null}>}
 */
export async function lookupLyrics({ artist, title, durationSec }) {
  if (!artist || !title) return { found: false, instrumental: false, suggestion: null };
  const url = new URL(API);
  url.search = new URLSearchParams({ artist_name: artist, track_name: title }).toString();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { found: false, instrumental: false, suggestion: null };
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  const list = await res.json();
  // closest duration (same recording), within 10 s when the duration is known
  const cands = (Array.isArray(list) ? list : []).filter((c) => !durationSec || !c.duration || Math.abs(c.duration - durationSec) <= 10);
  cands.sort((a, b) => Math.abs((a.duration ?? 0) - (durationSec ?? 0)) - Math.abs((b.duration ?? 0) - (durationSec ?? 0)));
  const j = cands[0];
  if (!j) return { found: false, instrumental: false, suggestion: null };
  const text = j.plainLyrics || (j.syncedLyrics ?? "").replace(/\[[^\]]*\]/g, " ");
  return { found: true, instrumental: !!j.instrumental, suggestion: j.instrumental ? null : suggestMood(text) };
}
