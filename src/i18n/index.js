// Interface language. The code is written in English; other languages are
// dictionaries keyed by the English text ({name} placeholders are kept).
// English is the default; the choice is remembered in this browser.

import FR from "./fr.js";

const KEY = "mea.lang";
const DICTS = { fr: FR };
export const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "fr", label: "Français" },
];

let lang = "en";
try {
  const saved = localStorage.getItem(KEY);
  if (saved && (saved === "en" || DICTS[saved])) lang = saved;
} catch { /* storage blocked: English */ }

export const getLang = () => lang;

/** Switches language; the page reloads so every view is rebuilt. */
export function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  location.reload();
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

/** Translates an English string, then fills {placeholders}. */
export function t(s, vars) {
  return fill(lang === "en" ? s : DICTS[lang]?.[s] ?? s, vars);
}

/** Singular / plural form ({n} is filled with the count). */
export function tn(n, one, many, vars) {
  const single = lang === "fr" ? Math.abs(n) < 2 : n === 1;
  return t(single ? one : many, { n, ...vars });
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const ATTRS = ["title", "placeholder", "aria-label", "alt"];

/**
 * Translates static markup once: elements marked data-i18n get their whole
 * inner HTML looked up (for text with inline tags), every other text node and
 * the usual attributes are looked up on their own.
 */
export function translateDom(root = document.body) {
  if (lang === "en") return;
  const dict = DICTS[lang];
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const hit = dict[norm(el.innerHTML)];
    if (hit) el.innerHTML = hit;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const key = norm(n.nodeValue);
    if (!key || n.parentElement?.closest("script,style,[data-i18n]")) continue;
    const hit = dict[key];
    if (hit) n.nodeValue = n.nodeValue.match(/^\s*/)[0] + hit + n.nodeValue.match(/\s*$/)[0];
  }
  for (const a of ATTRS) {
    for (const el of root.querySelectorAll(`[${a}]`)) {
      const hit = dict[norm(el.getAttribute(a))];
      if (hit) el.setAttribute(a, hit);
    }
  }
  document.documentElement.lang = lang;
}
