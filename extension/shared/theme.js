// Colour scheme — the one appearance preference, shared by every page this
// extension owns (the side panel and the editor tab).
//
// Three answers, exactly one of them true: `system` (the default), `light`,
// `dark`. Applying one is a single line — pin `color-scheme` on <html>, which is
// what every token in shared/tokens.css already resolves its `light-dark()` pair
// against. Nothing else in the whole stylesheet has to know a preference exists,
// and it is the same one-line implementation the styleguide's toggle uses.
//
// `system` is the ABSENCE of that pin, not a third value: the property is
// removed, `:root`'s own `color-scheme: light dark` takes back over, and the
// page follows the OS live — with no matchMedia listener to keep in step.
//
// Stored twice, on purpose:
//
//   chrome.storage.local   the AUTHORITY. It is also what keeps an open editor
//                          tab in step with the panel (storage.onChanged), so
//                          switching the theme in Settings repaints both.
//   localStorage           a synchronous MIRROR, and the only reason this file
//                          is a <head> script. chrome.storage answers a tick
//                          later than the first paint, so without the mirror
//                          every open of a pinned panel flashes the OS scheme
//                          for a frame before correcting itself.
//
// Not part of `settings`: that object is per-instance (core/storage.js keeps a
// map of it per host) and is committed by Save & validate. A colour scheme
// belongs to this browser, not to the Testomat you happen to be connected to,
// and it commits on the click — you pick a theme by looking at it.

const Theme = (() => {
  'use strict';

  const MODES = ['system', 'light', 'dark'];
  const KEY = 'theme';
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

  // Anything that is not one of the three is `system` — an absent key on a
  // fresh profile, a value left by an older build, a corrupted mirror.
  const clean = (m) => (MODES.includes(m) ? m : 'system');

  let mode = 'system';
  const listeners = new Set();

  function paint() {
    document.documentElement.style.colorScheme = mode === 'system' ? '' : mode;
  }

  // Best effort by design: a browser with localStorage blocked still gets the
  // theme from chrome.storage a tick later — it just pays the flash.
  function mirror() {
    try { window.localStorage.setItem(KEY, mode); } catch { /* nothing to do */ }
  }

  function announce() {
    for (const fn of listeners) {
      try { fn(mode); } catch { /* one bad listener is not the others' problem */ }
    }
  }

  // Take a mode that came FROM storage. Never writes back, and returns early
  // when nothing changed — which is what stops the onChanged echo of our own
  // set() from bouncing between the panel and the editor tab.
  function adopt(next) {
    next = clean(next);
    if (next === mode) return;
    mode = next;
    paint();
    mirror();
    announce();
  }

  // The user picked one. Paints first and persists after: the click has to land
  // on screen at once, and a storage write that fails leaves the page showing
  // the choice for this session rather than refusing it.
  async function set(next) {
    next = clean(next);
    if (next !== mode) { mode = next; paint(); mirror(); announce(); }
    if (hasChrome) {
      try { await chrome.storage.local.set({ [KEY]: mode }); } catch { /* this session keeps it */ }
    }
  }

  // ---------- boot ----------
  // Both steps run at load, from <head>, before the page has drawn anything.

  // 1. The mirror, synchronously.
  let seed = null;
  try { seed = window.localStorage.getItem(KEY); } catch { /* fall through to system */ }
  mode = clean(seed);
  paint();

  // 2. The authority, as soon as it answers — and the cross-page subscription.
  //    An absent key resolves to `system`, which is also how a sign-out that
  //    wiped storage lands back on the default.
  if (hasChrome) {
    chrome.storage.local.get(KEY)
      .then((got) => adopt(got && got[KEY]))
      .catch(() => { /* keep the mirror's answer */ });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) adopt(changes[KEY].newValue);
    });
  }

  return {
    MODES,
    KEY,
    set,
    get: () => mode,

    // What the page is actually painted in right now — `system` answered by the
    // OS. For the one place that has to hand a concrete scheme to something
    // that cannot resolve one itself: the on-page annotator overlay, which lives
    // in the site's document and can read neither of the two stores above.
    resolved: () => (mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode),

    // Repaint whatever shows the current mode (the Settings switch). Fires for
    // every change, including one made on the other page.
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
