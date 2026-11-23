// Never prompts: `<all_urls>` is required, so the only "no" left is a restricted page.

/* global resolveSiteTab */

const SiteAccess = (() => {
  // `.error` is already the per-state copy to show.
  async function ensureSiteAccess() {
    const site = await resolveSiteTab();
    return site.state === 'ok'
      ? { ok: true, state: site.state, tab: site.tab, origin: site.origin }
      : { ok: false, state: site.state, tab: site.tab || null, error: site.error };
  }

  return { ensureSiteAccess };
})();

const ensureSiteAccess = SiteAccess.ensureSiteAccess;
