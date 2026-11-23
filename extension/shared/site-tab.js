// Loaded by the worker and by panel/editor pages (no window/document); the editor has no ViewMode.

/* global ViewMode */

const SiteTab = (() => {
  // No "click the toolbar" hint: with `<all_urls>` held from install a click grants nothing.
  const restrictedCopy = (verb = 'used') => 'Chrome doesn’t allow extensions on this page '
    + `(chrome://…, the Web Store, another extension’s page), so it can’t be ${verb} — `
    + 'switch to the site under test.';

  // storage.session, not a variable: worker and panel are short-lived yet must name the same tab.
  const TARGET_KEY = 'siteTarget';   // content scripts can read it (§5.2): an origin + a tab id
  const hasSession = () => typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.session);

  async function readTarget() {
    if (!hasSession()) return null;
    try { return (await chrome.storage.session.get(TARGET_KEY))[TARGET_KEY] || null; }
    catch { return null; }
  }

  // Compared against storage, not a per-context cache, so two contexts cannot disagree.
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

  // With `tabId`, only that bound tab unbinds: a closed tab must not drop the tester's new target.
  async function forgetTab(tabId) {
    const cur = await readTarget();
    if (!cur) return false;
    if (tabId != null && cur.tabId !== tabId) return false;
    if (!hasSession()) return false;
    try { await chrome.storage.session.remove(TARGET_KEY); return true; } catch { return false; }
  }

  // null when the binding can't stand in: gone, unreadable, off http(s), or in another window.
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

  // Opt-in: only paths that need the page visible may move tabs; a background tab shoots nothing.
  async function focusTab(tab) {
    if (!tab || tab.id == null || tab.active) return tab;
    try { await chrome.tabs.update(tab.id, { active: true }); } catch { return tab; }
    try { return await chrome.tabs.get(tab.id); } catch { return tab; }
  }

  // Window mode: the panel's popup is skipped for the most recently focused normal window.
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

  // Origin without port (Chrome match patterns cannot carry one); null for non-http(s).
  function originOf(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.hostname}`;
    } catch { return null; }
  }

  // Without `tabs`, query hides `url` on pages Chrome keeps extensions off: hidden url = restricted.
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
    // On a detour to a page we can't work on, the bound target stands in so the flow keeps its page.
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

  // restrictedCopy is exported for the worker's inject: a tab that moved since must say the same.
  return { resolveSiteTab, originOf, restrictedCopy, rememberTab, forgetTab, readTarget };
})();

const resolveSiteTab = SiteTab.resolveSiteTab;
