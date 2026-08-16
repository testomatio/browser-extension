// The panel's live wire to the service worker (IIFE global `PanelLink`). One long-
// lived port per OPEN side-panel document, and its whole job is to answer a question
// the worker has to answer WITHOUT awaiting anything: "does this window already have
// a panel?".
//
// Why it cannot be a storage read: chrome.action.onClicked may only call
// sidePanel.open() before its first await (the user gesture is on the stack until
// then), so the answer has to be in the worker's memory already. A port gives that
// for free and is self-cleaning — the browser drops it when the document is
// destroyed, which is why nothing here has to notice the panel closing.
//
// Why the worker cares: with a panel already open, opening it AGAIN can only take it
// away from the page the tester is on (the editor, mid-edit, is the one that hurts);
// the click's remaining job there is the activeTab grant it carries.
//
// PANEL DOCUMENTS ONLY. The editor is also served in a normal TAB (`?ctx=tab`), and
// a tab is not a panel: chrome.tabs.getCurrent() answers that — a tab object in a
// tab, undefined in a side panel — so a tab never registers. The window id rides
// along in the first message because a side panel's `sender` carries no tab, and so
// no window, for the worker to read it off.
//
// Loaded by sidepanel/index.html and editor/editor.html. Best-effort throughout: a
// failure here costs the open-guard (the click falls back to opening the panel — the
// behaviour before this file existed), never a feature.

const PanelLink = (() => {
  const NAME = 'panel';
  const RETRY_MS = 1000;
  let port = null;
  let retryTimer = null;

  // A reloaded or updated extension leaves this page holding a dead `chrome` —
  // `runtime.id` is the standard tell, and it is what stops the retry below from
  // looping forever against an API that will never answer again.
  const alive = () => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // The worker is torn down when it goes idle, taking the port with it — so a
  // disconnect is routine, not a failure, and the panel just dials again.
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
    chrome.windows.getCurrent()
      .then((win) => (win && win.id != null ? win.id : null))
      .catch(() => null)
      .then((windowId) => { try { live.postMessage({ type: 'PANEL_HELLO', windowId }); } catch { /* raced a disconnect */ } });
  }

  // Connect only from a real side panel. getCurrent() is async, so a toolbar click
  // in the first milliseconds of a panel's life still takes the open() path — the
  // pre-existing behaviour, and harmless.
  function init() {
    if (!alive() || !chrome.runtime.connect) return;
    const inTab = chrome.tabs && chrome.tabs.getCurrent
      ? chrome.tabs.getCurrent().then((t) => !!t).catch(() => false)
      : Promise.resolve(false);
    inTab.then((tab) => { if (!tab) open(); });
  }

  return { init, connected: () => !!port };
})();
