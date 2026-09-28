import test from "node:test";
import assert from "node:assert/strict";
import { suggestGenres, genrePath, normalizeGenre } from "../src/scoring/genres.js";

test("genre labels are hierarchical", () => {
  assert.deepEqual(genrePath("Électro / Hardstyle > Rawstyle"), ["Électro", "Hardstyle", "Rawstyle"]);
  assert.equal(normalizeGenre(" Metal>Death metal "), "Metal › Death metal");
});

test("suggestion from the nearest labelled tracks, parent level when leaves disagree", () => {
  const L = [
    { label: "Électro › Techno", vec: [0, 0, 0] }, { label: "Électro › Techno", vec: [0.1, 0, 0] },
    { label: "Électro › House", vec: [0, 0.2, 0] }, { label: "Électro › House", vec: [0.1, 0.2, 0] },
    { label: "Metal › Death", vec: [5, 5, 5] }, { label: "Metal › Death", vec: [5.2, 5, 5] },
  ];
  const nearTechno = suggestGenres([0.02, 0, 0], L, 2);
  assert.equal(nearTechno[0].label, "Électro › Techno");
  const between = suggestGenres([0.05, 0.1, 0], L, 4);
  assert.equal(between[0].label, "Électro"); // techno vs house: agree on the parent
  const metal = suggestGenres([5.1, 5, 5], L, 3);
  assert.ok(metal[0].label.startsWith("Metal"));
  assert.ok(metal[0].confidence > 0.3);
});
