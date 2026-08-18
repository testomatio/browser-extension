// Panel surface (IIFE global `ViewMode`) — Chrome's side panel vs our own popup window (#208).
// Loaded by BOTH the service worker (importScripts) and the panel document — no document/window refs.

const ViewMode = (() => {
  const KEY = 'viewMode';            // chrome.storage.local — the remembered choice
  const MODES = ['sidepanel', 'window'];
  const PANEL_PATH = 'sidepanel/index.html';
  // chrome.storage.session — window ids, which mean nothing after a restart.
  const NORMAL_KEY = 'viewNormalWindowId'; // the browser window the site under test is in
  const PANEL_KEY = 'viewPanelWindowId';   // …and our own popup, when there is one

  // Tall and narrow: the layout is the side panel's, and a wide window needs dragging into shape.
  const WINDOW_SIZE = { width: 460, height: 900 };

  // Anything else is the default — an absent key, or a value an older build left behind.
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

  // The window the SITE is in: the last NORMAL one focused, tracked by the worker and
  // verified before it is handed out — a closed window's id yields an empty tab query.
  async function normalWindowId() {
    const tracked = await idOf(NORMAL_KEY);
    if (tracked != null) {
      try {
        const win = await chrome.windows.get(tracked);
        if (win && win.type === 'normal') return win.id;
      } catch { /* it was closed — fall through */ }
    }
    // getAll carries no focus history, so: the focused normal window, else the newest.
    try {
      const wins = (await chrome.windows.getAll()).filter((w) => w && w.type === 'normal');
      const win = wins.find((w) => w.focused) || wins[wins.length - 1];
      return win && win.id != null ? win.id : null;
    } catch { return null; }
  }

  // A normal window never is. Without a recorded id, a popup in window mode is taken for
  // ours rather than mistaken for the site.
  async function isPanelWindow(win) {
    if (!win || win.type !== 'popup') return false;
    const id = await panelWindowId();
    if (id != null) return win.id === id;
    return (await mode()) === 'window';
  }

  // Weaker on purpose: this document is one of OURS, so a popup hosting it is the panel.
  // It also settles before either write above lands, while the window is still booting.
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
