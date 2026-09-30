// Places genre names from Spotify, MusicBrainz or Last.fm ("rawstyle", "indie pop", "roots reggae"…)
// into a readable hierarchy (Electronic › Hard dance › Rawstyle). Keyword rules,
// most specific first; unknown genres keep their own name at the top level.
// Only used for labels and suggestions: the user's labels always win.

import { t } from "../i18n/index.js";

const ELECTRO = t("Electronic");

const RULES = [
  // [pattern, family path] — order matters: the first match wins
  [/hardcore hip hop|horrorcore/, ["Rap & hip-hop"]],
  [/hardcore punk|post-hardcore|melodic hardcore|pop punk|punk|screamo/, ["Rock", "Punk"]],
  [/metalcore|deathcore|djent/, ["Metal", "Metalcore"]],
  [/indie pop|bedroom pop|dream pop|synthpop|synth-pop|electropop|k-pop|j-pop|art pop/, ["Pop"]],
  [/hardstyle|rawstyle|hardcore|gabber|frenchcore|uptempo|hard dance|jumpstyle|terror|speedcore|extratone|hard trance/, [ELECTRO, "Hard dance"]],
  [/drum and bass|drum'n'bass|dnb|jungle|liquid funk|neurofunk|jump up/, [ELECTRO, "Drum and bass"]],
  [/dubstep|riddim|brostep|bass music|future bass|trap edm|bassline|deathstep|tearout/, [ELECTRO, "Bass music"]],
  [/techno/, [ELECTRO, "Techno"]],
  [/trance|psytrance|goa/, [ELECTRO, "Trance"]],
  [/house|garage|disco house|jackin/, [ELECTRO, "House"]],
  [/ambient|drone|new age|downtempo|chillout|lo-fi|lofi|chillhop|chillwave/, ["Chill & ambient"]],
  [/trip hop|trip-hop/, [ELECTRO, "Trip hop"]],
  [/synthwave|retrowave|darksynth|outrun|vaporwave/, [ELECTRO, "Synthwave"]],
  [/edm|electro|electronic|dance|big room|eurodance|idm|breakbeat|breaks|glitch|nightcore|hyperpop/, [ELECTRO]],
  [/death metal|black metal|grindcore|doom|sludge|thrash|metal/, ["Metal"]],
  [/emo\b/, ["Rock", "Emo"]],
  [/indie rock|alternative rock|garage rock|shoegaze|post-rock|grunge|rock/, ["Rock"]],
  [/drill|trap|phonk|boom bap|rap|hip hop|hip-hop|grime/, ["Rap & hip-hop"]],
  [/reggaeton|dembow|latin|salsa|bachata|cumbia/, [t("Latin")]],
  [/reggae|dancehall|ska|dub|rocksteady/, ["Reggae"]],
  [/r&b|rnb|soul|funk|motown|neo soul/, ["Funk, soul & R&B"]],
  [/jazz|swing|bossa|bebop/, ["Jazz"]],
  [/classical|orchestra|baroque|opera|soundtrack|score|cinematic|epic|piano/, [t("Classical & soundtracks")]],
  [/folk|country|bluegrass|singer-songwriter|americana/, ["Folk & country"]],
  [/blues/, ["Blues"]],
  [/pop|indie/, ["Pop"]],
  [/chanson|variete|variété/, ["Chanson"]],
];

const cap = (s) => s.replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

/** Family path of a genre name, e.g. "rawstyle" → [ELECTRO, "Hard dance"]. */
export function familyOf(genre) {
  const g = String(genre).toLowerCase();
  for (const [re, path] of RULES) if (re.test(g)) return path;
  return null;
}

/** Full hierarchical label, e.g. "rawstyle" → "Electronic › Hard dance › Rawstyle". */
export function hierarchyOf(genre) {
  const fam = familyOf(genre);
  const leaf = cap(String(genre));
  if (!fam) return leaf;
  const same = fam.some((f) => f.toLowerCase() === String(genre).toLowerCase());
  return same ? fam.join(" › ") : [...fam, leaf].join(" › ");
}

/**
 * Main label for a list of genres (an artist's or a track's): the family with
 * the most votes, then its most specific (deepest, then longest) genre among the well-voted
 * ones. `weights` (0..1, same order) come from the source's vote counts;
 * without them every genre counts once.
 */
export function mainGenre(genres, weights = null) {
  const list = (genres ?? []).map((g, i) => ({ g, w: Number.isFinite(weights?.[i]) ? weights[i] : 1 })).filter((x) => x.g);
  if (!list.length) return null;
  const famOf = (g) => (familyOf(g) ?? [cap(g)]).join(" › ");
  const famCount = new Map();
  for (const { g, w } of list) famCount.set(famOf(g), (famCount.get(famOf(g)) ?? 0) + w);
  const topFam = [...famCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const inFam = list.filter((x) => famOf(x.g) === topFam);
  const maxW = Math.max(...inFam.map((x) => x.w));
  const depth = (g) => hierarchyOf(g).split(" › ").length;
  const best = inFam.filter((x) => x.w >= 0.5 * maxW).sort((a, b) => depth(b.g) - depth(a.g) || b.g.length - a.g.length)[0].g;
  return hierarchyOf(best);
}
