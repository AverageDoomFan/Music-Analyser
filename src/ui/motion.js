// Motion layer, purely presentational: sliding tab indicator, view-transition
// tab switches, staggered entrance of a panel's blocks, count-up of big
// numbers. Everything is generic (any [role="tab"] / [role="tabpanel"]) and
// turns itself off under prefers-reduced-motion.

const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };
let lastEnter = 0;

export function initMotion() {
  lastEnter = performance.now(); // the first render counts as an entrance
  const nav = document.querySelector('[role="tablist"]');
  if (nav) {
    initIndicator(nav);
    initTabTransitions(nav);
  }
  initPanelEntrance();
  initCountUp();
}

/** A pill that slides under the selected tab and follows its size. */
function initIndicator(nav) {
  const ind = document.createElement("span");
  ind.className = "tab-indicator";
  ind.setAttribute("aria-hidden", "true");
  nav.prepend(ind);
  let settled = false;
  let raf = 0;
  const place = () => {
    raf = 0;
    const sel = nav.querySelector('[role="tab"][aria-selected="true"]');
    if (!sel || !sel.offsetWidth) return;
    ind.style.width = `${sel.offsetWidth}px`;
    ind.style.transform = `translateX(${sel.offsetLeft}px)`;
    ind.style.opacity = "1";
    // keep the selected tab in view when the bar scrolls (phones)
    const l = sel.offsetLeft;
    const r = l + sel.offsetWidth;
    if (l < nav.scrollLeft + 16 || r > nav.scrollLeft + nav.clientWidth - 16) {
      nav.scrollTo({ left: l - (nav.clientWidth - sel.offsetWidth) / 2, behavior: settled && !reduce.matches ? "smooth" : "auto" });
    }
    if (!settled) requestAnimationFrame(() => { settled = true; ind.classList.add("ready"); });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
  new MutationObserver(schedule).observe(nav, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "hidden"] });
  if ("ResizeObserver" in window) new ResizeObserver(schedule).observe(nav);
  window.addEventListener("resize", schedule);
  document.fonts?.ready.then(schedule);
  schedule();
}

/**
 * A tab clicked by the user switches inside document.startViewTransition, so
 * the old panel cross-fades into the new one. Only trusted clicks are wrapped:
 * programmatic tab.click() calls stay synchronous, as the rest of the app
 * expects. Without the API (or with reduced motion) nothing changes.
 */
function initTabTransitions(nav) {
  if (!document.startViewTransition) return;
  let running = false;
  nav.addEventListener("click", (e) => {
    const tab = e.target.closest?.('[role="tab"]');
    if (!tab || !e.isTrusted || running || reduce.matches) return;
    if (tab.getAttribute("aria-selected") === "true") return;
    const tabs = [...nav.querySelectorAll('[role="tab"]')];
    const from = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    e.stopPropagation(); // the tab's own handler runs inside the transition
    const root = document.documentElement;
    root.dataset.navDir = tabs.indexOf(tab) < from ? "back" : "fwd";
    running = true;
    let vt;
    try {
      vt = document.startViewTransition(() => tab.click());
    } catch {
      running = false;
      tab.click();
      return;
    }
    vt.finished.finally(() => { running = false; delete root.dataset.navDir; });
  }, true);
}

/** When a panel is shown, its top-level blocks fade up one after another. */
function initPanelEntrance() {
  const main = document.querySelector("main") ?? document.body;
  new MutationObserver((recs) => {
    for (const r of recs) {
      const p = r.target;
      if (p.getAttribute?.("role") === "tabpanel" && !p.hidden && r.oldValue !== null) enter(p);
    }
  }).observe(main, { subtree: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
}

function enter(panel) {
  lastEnter = performance.now();
  if (reduce.matches) return;
  [...panel.children].filter((el) => !el.hidden).forEach((el, i) => el.style.setProperty("--stagger", Math.min(i, 8)));
  panel.classList.remove("is-entering");
  void panel.offsetWidth; // restart the animation
  panel.classList.add("is-entering");
  clearTimeout(panel._enterTimer);
  panel._enterTimer = setTimeout(() => panel.classList.remove("is-entering"), 1000);
}

// Big numbers roll from their previous value (0 the first time) to the new one.
const COUNT_SEL = ".home-stat b, .big-score, .lv-session-stats b, .agg-stats b, .gm-chip b";
const lastValue = new Map();

function initCountUp() {
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(COUNT_SEL)) countUp(n);
        for (const el of n.querySelectorAll(COUNT_SEL)) countUp(el);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function keyOf(el) {
  const host = el.parentElement?.closest("[id]");
  if (!host) return null;
  return `${host.id}:${[...host.querySelectorAll(COUNT_SEL)].indexOf(el)}`;
}

function countUp(el) {
  const m = el.textContent.match(/^(\s*)(-?\d+)(?![.,\d])(.*)$/s);
  if (!m) return;
  const to = Number(m[2]);
  const key = keyOf(el);
  if (!key) return;
  const from = lastValue.has(key) ? lastValue.get(key) : 0;
  lastValue.set(key, to);
  if (reduce.matches || from === to) return;
  // first appearance only animates right after a panel or dialog opens
  if (!lastValue.has(`${key}#seen`) && performance.now() - lastEnter > 2500 && !el.closest("dialog")) {
    lastValue.set(`${key}#seen`, 1);
    return;
  }
  lastValue.set(`${key}#seen`, 1);
  const [, lead, , tail] = m;
  const dur = Math.min(900, 380 + Math.abs(to - from) * 6);
  const t0 = performance.now();
  el.classList.add("counting");
  const step = (now) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = `${lead}${Math.round(from + (to - from) * e)}${tail}`;
    if (k < 1) requestAnimationFrame(step);
    else el.classList.remove("counting");
  };
  el.textContent = `${lead}${from}${tail}`;
  requestAnimationFrame(step);
}
