// The two walls that take the panel away from the tester: the lockout a read-only project raises in
// front of every screen, and the basic-mode strip. Read by core/views.js, which keeps the bare names.

/* global $, TestomatAPI, capabilities, hostOf, setImmersive, state, updateContextBar, views */

// setImmersive and updateContextBar belong to core/views.js, which loads AFTER this file. Both are
// reached at paint time only, so the reference resolves the way the load order does.

// Degraded-mode strip on the runs + run views. Dismissal is in-memory only: it
// lasts the panel session and resets on reload.
let degradedBannerDismissed = false;

const Gates = {
  // ---------- read-only lockout (#155) ----------
  // v2 refuses every request on a read-only project, GET included, so there is nothing
  // to show: one blocking panel, with Settings and the project switcher the way out.
  applyReadonlyBlock() {
    const blocked = !!capabilities.readonly && state.view !== 'settings';
    document.body.dataset.readonly = capabilities.readonly ? 'true' : 'false';
    const block = $('readonly-block');
    if (block) block.hidden = !blocked;
    for (const v of views) $(`view-${v}`).hidden = blocked || v !== state.view;
    if (!blocked) { updateContextBar(state.view); return; }
    // Nothing is open behind the block, so Back and the title would both be lying —
    // and with the row gone the panel is not immersed in anything either.
    $('context-bar').hidden = true;
    $('btn-back').hidden = true;
    setImmersive(false);
  },

  baseUrlHost() {
    try { return new URL(state.settings.baseUrl).hostname; } catch { return 'the web app'; }
  },

  updateDegradedBanner() {
    const banner = $('degraded-banner');
    if (!banner) return;
    const degraded = TestomatAPI.jwtAvailable() === false; // only once degradation is proven
    const onRunViews = state.view === 'runs' || state.view === 'run';
    // The strip's whole advice is "sign in over there": with no instance saved there is no there,
    // and the sentence would name the fallback instead of a host. It stays down until one is saved.
    const named = !!(state.settings && hostOf(state.settings.baseUrl));
    // #155: under the read-only lockout there is no basic mode to explain.
    const showit = degraded && onRunViews && named && !degradedBannerDismissed && !capabilities.readonly;
    banner.hidden = !showit;
    if (!showit) return;
    const txt = banner.querySelector('.degraded-banner-text');
    if (txt) {
      txt.textContent = 'Basic mode — steps are local-only; finish run, priority and custom statuses '
        + `need an active ${Gates.baseUrlHost()} web login. Sign in there, then Refresh.`;
    }
  },

  dismissDegradedBanner() { degradedBannerDismissed = true; Gates.updateDegradedBanner(); },
};
