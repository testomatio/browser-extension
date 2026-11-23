// Pins `color-scheme` on <html> for tokens.css's `light-dark()`; must load from <head> (paint flash).

const Theme = (() => {
  'use strict';

  const MODES = ['system', 'light', 'dark'];
  const KEY = 'theme';
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

  // `system` is the absence of the pin: `:root`'s own `color-scheme: light dark` follows the OS live.
  const clean = (m) => (MODES.includes(m) ? m : 'system');

  let mode = 'system';
  const listeners = new Set();

  function paint() {
    document.documentElement.style.colorScheme = mode === 'system' ? '' : mode;
  }

  // With localStorage blocked, chrome.storage brings the theme a tick later, at the cost of a flash.
  function mirror() {
    try { window.localStorage.setItem(KEY, mode); } catch { /* nothing to do */ }
  }

  function announce() {
    for (const fn of listeners) {
      try { fn(mode); } catch { /* one bad listener is not the others' problem */ }
    }
  }

  // Never writes back; the early return stops our own set()'s onChanged echo bouncing between pages.
  function adopt(next) {
    next = clean(next);
    if (next === mode) return;
    mode = next;
    paint();
    mirror();
    announce();
  }

  // Paints first and persists after, so a failed storage write still shows the choice this session.
  async function set(next) {
    next = clean(next);
    if (next !== mode) { mode = next; paint(); mirror(); announce(); }
    if (hasChrome) {
      try { await chrome.storage.local.set({ [KEY]: mode }); } catch { /* this session keeps it */ }
    }
  }

  // The localStorage mirror, synchronously, before the page has drawn.
  let seed = null;
  try { seed = window.localStorage.getItem(KEY); } catch { /* fall through to system */ }
  mode = clean(seed);
  paint();

  // Then the authority, and the subscription that keeps an open editor tab in step with the panel.
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

    // A concrete scheme for the on-page overlay, which can read neither store above.
    resolved: () => (mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode),

    // Fires for every change, including one made on the other page.
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
