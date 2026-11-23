// Long-lived ports, so the worker knows without awaiting: sidePanel.open() dies past its gesture.

const PanelLink = (() => {
  const NAME = 'panel';
  const NAME_DOC = 'panel-doc';
  const RETRY_MS = 1000;

  // A reloaded extension leaves a dead `chrome`; `runtime.id` is the tell that stops the retries.
  const alive = () => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // The idle worker takes the port down with it; a disconnect is routine, so just dial again.
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

  // The window id is sent: a side panel's `sender` carries no tab, so no window for the worker.
  function hello(live) {
    chrome.windows.getCurrent()
      .then((win) => (win && win.id != null ? win.id : null))
      .catch(() => null)
      .then((windowId) => { try { live.postMessage({ type: 'PANEL_HELLO', windowId }); } catch { /* raced a disconnect */ } });
  }

  const surface = dialer(NAME, hello);
  const doc = dialer(NAME_DOC);

  // The editor holds 'panel' so a click can't replace a half-written test, but is no panel surface.
  const inEditor = () => /\/editor\/editor\.html$/.test(location.pathname);

  function init() {
    if (!alive() || !chrome.runtime.connect) return;
    // Every surface hosting the panel registers, so the worker can tell when the last one is gone.
    if (!inEditor()) doc.open();
    // 'panel' is the toolbar-icon surface alone: tabs.getCurrent() is undefined only in a panel.
    const inTab = chrome.tabs && chrome.tabs.getCurrent
      ? chrome.tabs.getCurrent().then((t) => !!t).catch(() => false)
      : Promise.resolve(false);
    inTab.then((tab) => { if (!tab) surface.open(); });
  }

  return { init, connected: () => surface.connected() };
})();
