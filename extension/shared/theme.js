// Colour scheme for every page this extension owns — pinned as `color-scheme` on <html>,
// which tokens.css resolves `light-dark()` against. MUST load from <head> (paint flash).

const Theme = (() => {
  'use strict';

  const MODES = ['system', 'light', 'dark'];
  const KEY = 'theme';
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

  // Anything that is not one of the three is `system`, and `system` is the ABSENCE of the
  // pin: `:root`'s own `color-scheme: light dark` takes over and follows the OS live.
  const clean = (m) => (MODES.includes(m) ? m : 'system');

  let mode = 'system';
  const listeners = new Set();

  function paint() {
    document.documentElement.style.colorScheme = mode === 'system' ? '' : mode;
  }

  // Best effort: a browser with localStorage blocked still gets the theme from
  // chrome.storage a tick later — it just pays the flash.
  function mirror() {
    try { window.localStorage.setItem(KEY, mode); } catch { /* nothing to do */ }
  }

  function announce() {
    for (const fn of listeners) {
      try { fn(mode); } catch { /* one bad listener is not the others' problem */ }
    }
  }

  // Takes a mode that came FROM storage: never writes back, and the early return is what
  // stops the onChanged echo of our own set() bouncing between the panel and the tab.
  function adopt(next) {
    next = clean(next);
    if (next === mode) return;
    mode = next;
    paint();
    mirror();
    announce();
  }

  // Paints first and persists after, so a storage write that fails still leaves the page
  // showing the choice for this session.
  async function set(next) {
    next = clean(next);
    if (next !== mode) { mode = next; paint(); mirror(); announce(); }
    if (hasChrome) {
      try { await chrome.storage.local.set({ [KEY]: mode }); } catch { /* this session keeps it */ }
    }
  }

  // ---------- boot: both steps run at load, before the page has drawn ----------

  // 1. The mirror, synchronously.
  let seed = null;
  try { seed = window.localStorage.getItem(KEY); } catch { /* fall through to system */ }
  mode = clean(seed);
  paint();

  // 2. The authority, as soon as it answers — and the cross-page subscription that keeps
  //    an open editor tab in step with the panel.
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

    // For the one caller that must hand a CONCRETE scheme to something that cannot
    // resolve one: the on-page overlay, which can read neither store above.
    resolved: () => (mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode),

    // Fires for every change, including one made on the other page.
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
