// Panel surface (IIFE global `ViewMode`) — WHICH of the two surfaces this panel
// is showing in, and which one the toolbar icon opens next time (#208).
//
// One document, two surfaces: `sidepanel/index.html` is served either by Chrome's
// side panel or by a `windows.create({ type: 'popup' })` window of our own. The
// choice is REMEMBERED in chrome.storage.local, exactly like the colour scheme
// (shared/theme.js) — it is a fact about this browser, not about the Testomat
// instance — and the worker's action.onClicked honours it.
//
// The other half of this file is the window-mode TAB problem. In a popup window
// `chrome.windows.getCurrent()` answers with the panel's own window, whose only
// tab is this very document, so every "which tab is the site under test"
// question (shared/site-tab.js) would resolve to the panel itself and screenshot,
// full page, Rec, the step recorder and env-info would all target nothing. So the
// worker tracks the most recently focused NORMAL browser window, and this file is
// where that id is written and read: chrome.storage.session, so an SW restart
// does not forget it and a browser restart deliberately does.
//
// Loadable from BOTH the service worker (importScripts) and the panel document
// (<script src>) — no document/window references, same deal as shared/site-tab.js.

const ViewMode = (() => {
  const KEY = 'viewMode';            // chrome.storage.local — the remembered choice
  const MODES = ['sidepanel', 'window'];
  const PANEL_PATH = 'sidepanel/index.html';
  // chrome.storage.session — window ids, which mean nothing after a restart.
  const NORMAL_KEY = 'viewNormalWindowId'; // the browser window the site under test is in
  const PANEL_KEY = 'viewPanelWindowId';   // …and our own popup, when there is one

  // Tall and narrow: the panel's layout is the side panel's, and a window that
  // opens as a wide rectangle would need dragging back into shape before it is
  // usable next to a site.
  const WINDOW_SIZE = { width: 460, height: 900 };

  // Anything that is not one of the two is the default — an absent key on a fresh
  // profile, a value an older build left behind.
  const clean = (m) => (MODES.includes(m) ? m : 'sidepanel');
  const hasStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

  async function mode() {
    if (!hasStorage()) return 'sidepanel';
    try { return clean((await chrome.storage.local.get(KEY))[KEY]); } catch { return 'sidepanel'; }
  }

  async function setMode(next) {
    if (!hasStorage()) return;
    try { await chrome.storage.local.set({ [KEY]: clean(next) }); } catch { /* this session keeps it */ }
  }

  const panelUrl = () => chrome.runtime.getURL(PANEL_PATH);

  // ---------- window ids (session) ----------

  async function idOf(key) {
    try {
      const v = (await chrome.storage.session.get(key))[key];
      return Number.isInteger(v) ? v : null;
    } catch { return null; }
  }

  async function remember(key, id) {
    if (!Number.isInteger(id)) return;
    try { await chrome.storage.session.set({ [key]: id }); } catch { /* the fallbacks still answer */ }
  }

  const rememberNormalWindow = (id) => remember(NORMAL_KEY, id);
  const rememberPanelWindow = (id) => remember(PANEL_KEY, id);
  const panelWindowId = () => idOf(PANEL_KEY);

  // A window we recorded and Chrome then closed must not be pointed at again.
  async function forgetPanelWindow(id) {
    if ((await panelWindowId()) !== id) return;
    try { await chrome.storage.session.remove(PANEL_KEY); } catch { /* best effort */ }
  }

  // The window the SITE UNDER TEST is in: the last NORMAL one the tester focused,
  // tracked by the worker. Verified before it is handed out — a closed window's
  // id resolves to nothing but a confusing empty tab query.
  async function normalWindowId() {
    const tracked = await idOf(NORMAL_KEY);
    if (tracked != null) {
      try {
        const win = await chrome.windows.get(tracked);
        if (win && win.type === 'normal') return win.id;
      } catch { /* it was closed — fall through */ }
    }
    // Fallback: getAll carries no focus history, so the focused normal window
    // first and the newest one after it is the best answer available.
    try {
      const wins = (await chrome.windows.getAll()).filter((w) => w && w.type === 'normal');
      const win = wins.find((w) => w.focused) || wins[wins.length - 1];
      return win && win.id != null ? win.id : null;
    } catch { return null; }
  }

  // Is this window OUR panel popup? A normal window never is — which is what
  // keeps side-panel mode (and every existing scenario) on exactly the old path.
  // The recorded id is the answer when we have it; a popup we did not record
  // while the panel is in window mode (Chrome restarted the worker's session
  // store, say) is taken for ours rather than mistaken for the site.
  async function isPanelWindow(win) {
    if (!win || win.type !== 'popup') return false;
    const id = await panelWindowId();
    if (id != null) return win.id === id;
    return (await mode()) === 'window';
  }

  // …and the same question about the context asking it: am I the popup surface?
  // A weaker test on purpose, and it may be: this document is one of OURS, so a
  // popup hosting it is the panel window and nothing else. It also settles before
  // either write above lands — the window opens, its panel boots, and the id and
  // the preference are still in flight.
  async function inPanelWindow() {
    try {
      const win = await chrome.windows.getCurrent();
      return !!win && win.type === 'popup';
    } catch { return false; }
  }

  return {
    KEY,
    MODES,
    PANEL_PATH,
    NORMAL_KEY,
    PANEL_KEY,
    WINDOW_SIZE,
    mode,
    setMode,
    panelUrl,
    rememberNormalWindow,
    rememberPanelWindow,
    forgetPanelWindow,
    panelWindowId,
    normalWindowId,
    isPanelWindow,
    inPanelWindow,
  };
})();
