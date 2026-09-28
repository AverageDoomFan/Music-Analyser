import test from "node:test";
import assert from "node:assert/strict";
import { hierarchyOf, mainGenre, familyOf } from "../src/scoring/genre-map.js";

test("Spotify micro-genres land in the right family", () => {
  assert.equal(hierarchyOf("rawstyle"), "Electronic › Hard dance › Rawstyle");
  assert.equal(hierarchyOf("indie pop"), "Pop › Indie Pop");
  assert.equal(hierarchyOf("roots reggae"), "Reggae › Roots Reggae");
  assert.equal(hierarchyOf("hardcore punk"), "Rock › Punk › Hardcore Punk");
  assert.equal(hierarchyOf("electropop"), "Pop › Electropop");
  assert.equal(hierarchyOf("dubstep"), "Electronic › Bass music › Dubstep");
  assert.equal(hierarchyOf("techno"), "Electronic › Techno");
  assert.deepEqual(familyOf("french hip hop"), ["Rap & hip-hop"]);
  assert.equal(hierarchyOf("vaporwave"), "Electronic › Synthwave › Vaporwave");
  assert.equal(hierarchyOf("zeuhl"), "Zeuhl");
});

test("main genre of an artist: most common family, most specific genre", () => {
  assert.equal(mainGenre(["hardstyle", "rawstyle", "euphoric hardstyle", "edm"]), "Electronic › Hard dance › Euphoric Hardstyle");
  assert.equal(mainGenre(["reggae", "roots reggae", "pop"]), "Reggae › Roots Reggae");
  assert.equal(mainGenre([]), null);
});
