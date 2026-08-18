// Active-site tab resolver (IIFE global `SiteTab` + `resolveSiteTab`). Loaded by BOTH the
// service worker (importScripts) and panel/editor documents — no document/window references.

// ViewMode is guarded at every use — the editor page loads this file without it.
/* global ViewMode */

const SiteTab = (() => {
  // One copy for a page no extension may touch. No "click the toolbar" hint: with
  // `<all_urls>` held from install there is nothing a click could grant (#198).
  const restrictedCopy = (verb = 'used') => 'Chrome doesn’t allow extensions on this page '
    + `(chrome://…, the Web Store, another extension’s page), so it can’t be ${verb} — `
    + 'switch to the site under test.';

  // ---- the bound target ----------------------------------------------------
  // storage.session, not a variable: the worker is torn down between clicks and the panel
  // is a new document after every navigation, yet both must name the SAME tab.
  const TARGET_KEY = 'siteTarget';   // content scripts can read it (§5.2): an origin + a tab id
  const hasSession = () => typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.session);

  async function readTarget() {
    if (!hasSession()) return null;
    try { return (await chrome.storage.session.get(TARGET_KEY))[TARGET_KEY] || null; }
    catch { return null; }
  }

  // Only an http(s) tab whose url we can read qualifies — the origin IS the access check.
  // Compared against STORAGE, not a per-context cache, so two contexts cannot disagree.
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

  // With `tabId` given it only fires when that tab IS the bound one — the tab-closed
  // listener must never unbind a target the tester has moved on to.
  async function forgetTab(tabId) {
    const cur = await readTarget();
    if (!cur) return false;
    if (tabId != null && cur.tabId !== tabId) return false;
    if (!hasSession()) return false;
    try { await chrome.storage.session.remove(TARGET_KEY); return true; } catch { return false; }
  }

  // The binding resolved against the LIVE tab; null when it cannot stand in — gone, no
  // longer readable, off http(s), or in another window (the side panel is per-window).
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

  // Opt-in (`activate: true`): only the paths that need the page VISIBLE may move the
  // tester's tabs — a screenshot of a background tab is a screenshot of nothing.
  async function focusTab(tab) {
    if (!tab || tab.id == null || tab.active) return tab;
    try { await chrome.tabs.update(tab.id, { active: true }); } catch { return tab; }
    try { return await chrome.tabs.get(tab.id); } catch { return tab; }
  }

  // ---- the caller's window and its active tab ------------------------------
  // WINDOW MODE (#208): the panel then lives in a popup whose active tab is THIS document,
  // so that window is skipped for the most recently focused NORMAL one. null = unknown.
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

  // lastFocusedWindow is the fallback for an API hiccup, or a context with no window.
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

  // Origin WITHOUT port (Chrome match patterns cannot carry one); null for non-http(s).
  function originOf(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.hostname}`;
    } catch { return null; }
  }

  // #198: with no `tabs` permission chrome.tabs.query HIDES `url` on the pages Chrome keeps
  // extensions off, so a hidden url is a restricted page — 'system-page', as non-http(s) is.
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
    // The tester detoured to a page we cannot work on; the site they are TESTING is still
    // open, so the bound target stands in instead of the panel losing the page mid-flow.
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

  // restrictedCopy is exported because the recorder's inject runs in the worker AFTER the
  // panel resolved the tab: a tab that moved since must say the same thing, not throw.
  return { resolveSiteTab, originOf, restrictedCopy, rememberTab, forgetTab, readTarget };
})();

// Bare globals for call sites (mirrors ensureSiteAccess / ensureCapturePermission).
const resolveSiteTab = SiteTab.resolveSiteTab;
