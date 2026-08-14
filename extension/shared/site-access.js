// Runtime site access (IIFE global `SiteAccess` + the bare `ensureSiteAccess`).
//
// Since #198 there is exactly ONE question left — "may we touch the tab the tester
// is looking at?" — and it is answered without ever prompting: `<all_urls>` is a
// required host permission, so every http(s) tab is already ours and the only
// negative verdict is a page Chrome keeps extensions off. The per-origin request
// machinery this file used to carry (ensureOriginAccess, the one-time
// permanent-grant toast, the `alwaysAllowOffered` list) died with that model —
// narrowing access is Chrome's own Site access UI now, not ours to ask for.

/* global resolveSiteTab */

const SiteAccess = (() => {
  // Verdict for the active site tab, in the shape the call sites expect: `.ok`
  // plus `.tab`/`.origin`, or `.error` (already the honest per-state copy).
  async function ensureSiteAccess() {
    const site = await resolveSiteTab();
    return site.state === 'ok'
      ? { ok: true, state: site.state, tab: site.tab, origin: site.origin }
      : { ok: false, state: site.state, tab: site.tab || null, error: site.error };
  }

  return { ensureSiteAccess };
})();

// Bare global for call sites (mirrors ensureCapturePermission usage).
const ensureSiteAccess = SiteAccess.ensureSiteAccess;
