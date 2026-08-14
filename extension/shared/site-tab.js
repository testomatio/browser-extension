// Active-site tab resolver (IIFE global `SiteTab` + `resolveSiteTab`). ONE copy of
// the "which tab is the site under test, and may we touch it?" question that the
// capture, annotate, evidence, step-recorder and env-info paths all ask.
//
// KEY INVARIANT (#198): `<all_urls>` is held from install, so every http(s) tab is
// ours and there is no runtime grant to wait for. There is still no `tabs`
// permission, so chrome.tabs.query hides `url` for the pages Chrome keeps every
// extension off — chrome://, the Web Store, another extension's page. A hidden url
// is therefore a RESTRICTED page, exactly like a readable non-http(s) one, and both
// carry the same verdict.
//
// Loadable from BOTH the service worker (importScripts) and the panel/editor
// documents (<script src>) — no document/window references. Same plain-IIFE-global
// style as shared/site-access.js.
//
// `ViewMode` (shared/view-mode.js) is read where it is loaded — the worker and the
// panel — and guarded, because the editor page loads this file without it.

/* global ViewMode */

const SiteTab = (() => {
  // The one copy for a page no extension may touch. `verb` keeps each call site's
  // wording ("captured" / "recorded" / …); no toolbar-icon hint — there is nothing
  // a click could grant here (#198).
  const restrictedCopy = (verb = 'used') => 'Chrome doesn’t allow extensions on this page '
    + `(chrome://…, the Web Store, another extension’s page), so it can’t be ${verb} — `
    + 'switch to the site under test.';

  // The tab the CALLER is looking at. The side panel is per-window, so resolve the
  // window hosting this context (windows.getCurrent) instead of trusting the last
  // focused one; in the worker getCurrent() yields the last focused window, which
  // is the window whose panel/tab triggered us. lastFocusedWindow is the fallback
  // for any API hiccup (or a context with no window of its own).
  //
  // WINDOW MODE (#208) is the exception, and the reason this is three steps: the
  // panel then lives in a popup window of its own, whose active tab is this very
  // document — resolving against it would point every capture and every recorder
  // at the panel instead of the site. So the panel's window is skipped and the
  // question goes to the most recently focused NORMAL window (ViewMode tracks it
  // from the worker; getAll is its fallback). In side-panel mode nothing here
  // changes: a normal window is never the panel's.
  async function activeTab() {
    try {
      const win = await chrome.windows.getCurrent();
      const ours = typeof ViewMode !== 'undefined' ? await ViewMode.isPanelWindow(win) : false;
      if (win && win.id != null && !ours) {
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (tab) return tab;
      }
    } catch { /* fall through */ }
    try {
      const windowId = typeof ViewMode !== 'undefined' ? await ViewMode.normalWindowId() : null;
      if (windowId != null) {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab) return tab;
      }
    } catch { /* fall through to lastFocusedWindow */ }
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab || null;
    } catch { return null; }
  }

  // Site origin WITHOUT port (Chrome match patterns can't carry one), or null for
  // anything that isn't an http(s) page.
  function originOf(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.hostname}`;
    } catch { return null; }
  }

  // Resolve the active site tab. `verb` only tunes the restricted-page wording
  // ("recorded" / "captured" / …) so each call site keeps its existing copy.
  //   state 'ok'          — http(s) tab whose url we can read → the site under test
  //         'system-page' — a page extensions are kept off: url hidden (chrome://,
  //                         the Web Store, another extension) or a readable
  //                         non-http(s) one (devtools://, file://, …)
  //         'none'        — no active tab at all (or no extension context)
  async function resolveSiteTab({ verb = 'used' } = {}) {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return { state: 'none', tab: null, origin: null, error: 'This feature needs the extension context' };
    }
    const tab = await activeTab();
    if (!tab || tab.id == null) {
      return { state: 'none', tab: null, origin: null, error: 'No active tab — focus the site under test' };
    }
    const origin = tab.url ? originOf(tab.url) : null;
    if (!origin) return { state: 'system-page', tab, origin: null, error: restrictedCopy(verb) };
    return { state: 'ok', tab, origin, error: null };
  }

  // restrictedCopy is exported too: the evidence recorder's inject runs in the
  // worker AFTER the panel resolved the tab, and a tab that moved to a restricted
  // page in between must say the same thing rather than surface a scripting error.
  return { resolveSiteTab, originOf, restrictedCopy };
})();

// Bare globals for call sites (mirrors ensureSiteAccess / ensureCapturePermission).
const resolveSiteTab = SiteTab.resolveSiteTab;
