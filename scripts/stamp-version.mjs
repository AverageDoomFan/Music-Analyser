// Cache busting for static hosting (GitHub Pages caches files ~10 min).
// Appends ?v=<version> to every relative module URL in the built site, so a
// deploy never mixes a fresh page with stale cached modules (or vice versa).
//
// usage: node scripts/stamp-version.mjs <siteDir> <version>

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const [siteDir, version] = process.argv.slice(2);
if (!siteDir || !version) {
  console.error("usage: node scripts/stamp-version.mjs <siteDir> <version>");
  process.exit(1);
}
const v = encodeURIComponent(version);

// relative specifiers only: "./x.js", "../x.js"
const REL = String.raw`(\.{1,2}\/[^"'?#\s]+\.(?:js|mjs|css))`;
const rules = [
  new RegExp(String.raw`(\bfrom\s*["'])${REL}(["'])`, "g"),        // import … from "./x.js"
  new RegExp(String.raw`(\bimport\s*\(\s*["'])${REL}(["'])`, "g"), // import("./x.js")
  new RegExp(String.raw`(\bimport\s*["'])${REL}(["'])`, "g"),      // import "./x.js"
  new RegExp(String.raw`(new URL\(\s*["'])${REL}(["'])`, "g"),     // new URL("./worker.js", import.meta.url)
];

let files = 0, refs = 0;
function stamp(text) {
  for (const re of rules) text = text.replace(re, (_, a, url, b) => (refs++, `${a}${url}?v=${v}${b}`));
  return text;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if ([".js", ".mjs"].includes(extname(p))) {
      writeFileSync(p, stamp(readFileSync(p, "utf8")));
      files++;
    }
  }
}
walk(siteDir);

// index.html: <script src="src/main.js"> and <link href="styles.css">
const indexPath = join(siteDir, "index.html");
let html = readFileSync(indexPath, "utf8");
html = html.replace(/(<script[^>]+src=")([^"?:]+\.js)(")/g, (_, a, url, b) => (refs++, `${a}${url}?v=${v}${b}`));
html = html.replace(/(<link[^>]+href=")([^"?:]+\.css)(")/g, (_, a, url, b) => (refs++, `${a}${url}?v=${v}${b}`));
writeFileSync(indexPath, html);
console.log(`stamped ${refs} references in ${files + 1} files with v=${version}`);
