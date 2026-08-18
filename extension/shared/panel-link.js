// One long-lived port per OPEN side-panel document (IIFE global `PanelLink`): the worker
// must know a window has a panel without awaiting (sidePanel.open() dies past its gesture).

const PanelLink = (() => {
  const NAME = 'panel';
  const RETRY_MS = 1000;
  let port = null;
  let retryTimer = null;

  // A reloaded or updated extension leaves this page holding a dead `chrome`; `runtime.id`
  // is the tell, and it stops the retry below looping against an API that is gone.
  const alive = () => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // The worker is torn down when it goes idle, taking the port with it — a disconnect is
  // routine, not a failure, so the panel just dials again.
  function schedule() {
    if (retryTimer || !alive()) return;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, RETRY_MS);
  }

  function open() {
    if (port || !alive()) return;
    try { port = chrome.runtime.connect({ name: NAME }); }
    catch { port = null; schedule(); return; }
    const live = port;
    live.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (port === live) port = null; schedule(); });
    // The window id is sent explicitly: a side panel's `sender` carries no tab, and so
    // no window for the worker to read it off.
    chrome.windows.getCurrent()
      .then((win) => (win && win.id != null ? win.id : null))
      .catch(() => null)
      .then((windowId) => { try { live.postMessage({ type: 'PANEL_HELLO', windowId }); } catch { /* raced a disconnect */ } });
  }

  // Connect only from a real side panel — chrome.tabs.getCurrent() answers a tab object
  // in a tab and undefined in a panel, so the editor's `?ctx=tab` never registers.
  function init() {
    if (!alive() || !chrome.runtime.connect) return;
    const inTab = chrome.tabs && chrome.tabs.getCurrent
      ? chrome.tabs.getCurrent().then((t) => !!t).catch(() => false)
      : Promise.resolve(false);
    inTab.then((tab) => { if (!tab) open(); });
  }

  return { init, connected: () => !!port };
})();
