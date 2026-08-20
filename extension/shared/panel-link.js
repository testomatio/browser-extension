// Two long-lived ports per OPEN panel document (IIFE global `PanelLink`), because the worker must
// know both without awaiting (sidePanel.open() dies past its gesture): 'panel' says a WINDOW holds
// the toolbar-icon surface, 'panel-doc' says a panel document is alive on ANY surface.

const PanelLink = (() => {
  const NAME = 'panel';
  const NAME_DOC = 'panel-doc';
  const RETRY_MS = 1000;

  // A reloaded or updated extension leaves this page holding a dead `chrome`; `runtime.id`
  // is the tell, and it stops the retry below looping against an API that is gone.
  const alive = () => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // One named port, redialled for as long as this document lives. The worker is torn down when it
  // goes idle, taking the port with it — a disconnect is routine, not a failure, so the panel just
  // dials again. `onOpen` runs on each fresh connection.
  function dialer(name, onOpen) {
    let port = null;
    let retryTimer = null;

    function schedule() {
      if (retryTimer || !alive()) return;
      retryTimer = setTimeout(() => { retryTimer = null; open(); }, RETRY_MS);
    }

    function open() {
      if (port || !alive()) return;
      try { port = chrome.runtime.connect({ name }); }
      catch { port = null; schedule(); return; }
      const live = port;
      live.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (port === live) port = null; schedule(); });
      if (onOpen) onOpen(live);
    }

    return { open, connected: () => !!port };
  }

  // The window id is sent explicitly: a side panel's `sender` carries no tab, and so
  // no window for the worker to read it off.
  function hello(live) {
    chrome.windows.getCurrent()
      .then((win) => (win && win.id != null ? win.id : null))
      .catch(() => null)
      .then((windowId) => { try { live.postMessage({ type: 'PANEL_HELLO', windowId }); } catch { /* raced a disconnect */ } });
  }

  const surface = dialer(NAME, hello);
  const doc = dialer(NAME_DOC);

  // The editor loads this file too — it keeps a 'panel' port so a toolbar click cannot replace a
  // half-written test — but it is no panel surface, so it is the one document that skips 'panel-doc'.
  const inEditor = () => /\/editor\/editor\.html$/.test(location.pathname);

  function init() {
    if (!alive() || !chrome.runtime.connect) return;
    // Every surface hosting the panel registers here — side panel, our popup window, a tab — so the
    // worker can tell when the LAST one is gone (rec scoped to its testrun).
    if (!inEditor()) doc.open();
    // 'panel' stays the toolbar-icon surface alone: chrome.tabs.getCurrent() answers a tab object
    // in a tab and undefined in a panel, so neither the editor's `?ctx=tab` nor a panel window registers.
    const inTab = chrome.tabs && chrome.tabs.getCurrent
      ? chrome.tabs.getCurrent().then((t) => !!t).catch(() => false)
      : Promise.resolve(false);
    inTab.then((tab) => { if (!tab) surface.open(); });
  }

  return { init, connected: () => surface.connected() };
})();
