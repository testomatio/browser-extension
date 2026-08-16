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
// THE TARGET TAB is REMEMBERED, not re-guessed on every call. Every resolve that
// lands on a real http(s) tab binds it (storage.session `siteTarget`), and so does
// the toolbar click — the one gesture where the tester literally points at the page
// they are testing (background.js action.onClicked). When the tab they are looking
// at is one we cannot work on — a page we hold no grant for, a chrome:// page, a
// fresh tab — the bound target stands in rather than the panel losing the page
// mid-flow, and `activate: true` brings it back to the front for the paths that need
// it VISIBLE. The tester's own tab still wins whenever it is a readable http(s) one:
// this keeps a target, it does not pin one.
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

  // ---- the bound target ----------------------------------------------------
  // In storage.session rather than a variable, because the two contexts that ask
  // are both short-lived: the worker is torn down between clicks and the panel is
  // a different document after every navigation (index.html → editor.html). Both
  // have to name the SAME tab. Shape: { tabId, origin, at }. Session-scoped, so a
  // browser restart starts with no target, exactly like `stepRec`.
  // Content scripts can read it (§5.2 access level) — it holds an origin and a tab
  // id, both of which the page under test already knows about itself.
  const TARGET_KEY = 'siteTarget';
  const hasSession = () => typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.session);

  async function readTarget() {
    if (!hasSession()) return null;
    try { return (await chrome.storage.session.get(TARGET_KEY))[TARGET_KEY] || null; }
    catch { return null; }
  }

  // Bind `tab` as the target. Only an http(s) tab whose url we can read qualifies —
  // the origin IS the access check. Compared against what is stored (not against a
  // per-context cache) so two contexts binding in turn cannot disagree; identical
  // re-binds write nothing, and this runs on every successful resolve.
  async function rememberTab(tab) {
    if (!tab || tab.id == null) return false;
    const origin = originOf(tab.url);
    if (!origin) return false;
    const cur = await readTarget();
    if (cur && cur.tabId === tab.id && cur.origin === origin) return true;
    if (!hasSession()) return false;
    try {
      await chrome.storage.session.set({ [TARGET_KEY]: { tabId: tab.id, origin, at: Date.now() } });
      return true;
    } catch { return false; }
  }

  // Drop the binding. With `tabId` given it only fires when that tab IS the bound
  // one — the tab-closed listener must never unbind a target the tester has since
  // moved on to.
  async function forgetTab(tabId) {
    const cur = await readTarget();
    if (!cur) return false;
    if (tabId != null && cur.tabId !== tabId) return false;
    if (!hasSession()) return false;
    try { await chrome.storage.session.remove(TARGET_KEY); return true; } catch { return false; }
  }

  // The bound target resolved against the LIVE tab, or null when it cannot stand
  // in: gone (dropped here), url no longer readable (access lapsed — kept, since a
  // toolbar click on it brings it straight back), navigated off http(s), or sitting
  // in another window than the caller's (the side panel is per-window).
  async function targetTab(winId) {
    const cur = await readTarget();
    if (!cur || cur.tabId == null) return null;
    let tab = null;
    try { tab = await chrome.tabs.get(cur.tabId); }
    catch { await forgetTab(cur.tabId); return null; }
    if (!tab || !tab.url) return null;
    const origin = originOf(tab.url);
    if (!origin) return null;
    if (winId != null && tab.windowId != null && tab.windowId !== winId) return null;
    return { tab, origin };
  }

  // Bring the target back to the front. Opt-in (`activate: true`), because only the
  // paths that need the page VISIBLE may move the tester's tabs: a screenshot of a
  // background tab is a screenshot of nothing, and a step recording of a page the
  // tester cannot see is worse than none. Passive readers — env-info on every status
  // write — must never do it.
  async function focusTab(tab) {
    if (!tab || tab.id == null || tab.active) return tab;
    try { await chrome.tabs.update(tab.id, { active: true }); } catch { return tab; }
    try { return await chrome.tabs.get(tab.id); } catch { return tab; }
  }

  // ---- the caller's window and its active tab ------------------------------
  // The window the SITE lives in. The side panel is per-window, so resolve the
  // window hosting THIS context (windows.getCurrent) instead of trusting the last
  // focused one; in the worker getCurrent() yields the last focused window, which
  // is the window whose panel/tab triggered us.
  //
  // WINDOW MODE (#208) is the exception, and the reason this is two steps: the
  // panel then lives in a popup window of its own, whose active tab is this very
  // document — resolving against it would point every capture and every recorder
  // at the panel instead of the site. So the panel's window is skipped and the
  // question goes to the most recently focused NORMAL window (ViewMode tracks it
  // from the worker; getAll is its fallback). In side-panel mode nothing changes:
  // a normal window is never the panel's. null = we could not tell, and every
  // window is fair game.
  async function siteWindowId() {
    try {
      const win = await chrome.windows.getCurrent();
      const ours = typeof ViewMode !== 'undefined' ? await ViewMode.isPanelWindow(win) : false;
      if (win && win.id != null && !ours) return win.id;
    } catch { /* fall through to the normal window */ }
    try {
      return typeof ViewMode !== 'undefined' ? await ViewMode.normalWindowId() : null;
    } catch { return null; }
  }

  // The tab the CALLER is looking at, inside that window. lastFocusedWindow is the
  // fallback for any API hiccup (or a context with no window of its own).
  async function activeTab(winId) {
    if (winId != null) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
        if (tab) return tab;
      } catch { /* fall through to lastFocusedWindow */ }
    }
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

  // Resolve the site tab. `verb` only tunes the restricted-page wording
  // ("recorded" / "captured" / …) so each call site keeps its existing copy;
  // `activate` brings a stood-in target back to the front (see focusTab).
  //   state 'ok'          — http(s) tab whose url we can read → the site under
  //                         test. `viaTarget` marks the ones that came from the
  //                         BINDING rather than from the tab the tester is on.
  //         'system-page' — a page extensions are kept off: url hidden (chrome://,
  //                         the Web Store, another extension) or a readable
  //                         non-http(s) one (devtools://, file://, …)
  //         'none'        — no active tab at all (or no extension context)
  async function resolveSiteTab({ verb = 'used', activate = false } = {}) {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return { state: 'none', tab: null, origin: null, error: 'This feature needs the extension context' };
    }
    const winId = await siteWindowId();
    const tab = await activeTab(winId);
    const origin = tab && tab.id != null ? originOf(tab.url) : null;
    if (origin) {
      await rememberTab(tab);
      return { state: 'ok', tab, origin, error: null };
    }
    // The tester is looking at something we cannot work on. The page they are
    // TESTING is still open, so carry on against it instead of dropping the thread —
    // this is what keeps a mid-edit test, a live recording and a capture pointed at
    // the same site across a detour into chrome://, a new tab or an ungranted page.
    const kept = await targetTab(winId);
    if (kept) {
      const live = activate ? await focusTab(kept.tab) : kept.tab;
      return { state: 'ok', tab: live, origin: kept.origin, error: null, viaTarget: true };
    }
    if (!tab || tab.id == null) {
      return { state: 'none', tab: null, origin: null, error: 'No active tab — focus the site under test' };
    }
    return { state: 'system-page', tab, origin: null, error: restrictedCopy(verb) };
  }

  // restrictedCopy is exported too: the evidence recorder's inject runs in the
  // worker AFTER the panel resolved the tab, and a tab that moved to a restricted
  // page in between must say the same thing rather than surface a scripting error.
  // The target binding rides with it: remembering the tab under test is what keeps
  // a capture, a recording and a mid-edit test pointed at the same site.
  return { resolveSiteTab, originOf, restrictedCopy, rememberTab, forgetTab, readTarget };
})();

// Bare globals for call sites (mirrors ensureSiteAccess / ensureCapturePermission).
const resolveSiteTab = SiteTab.resolveSiteTab;
