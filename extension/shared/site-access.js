// Runtime site access (IIFE global `SiteAccess` + the bare `ensureSiteAccess`). Never
// prompts: `<all_urls>` is required, so the only "no" left is a restricted page (#198).

/* global resolveSiteTab */

const SiteAccess = (() => {
  // `.ok` plus `.tab`/`.origin`, or `.error` — already the per-state copy to show.
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
