// The read-only lockout and the basic-mode strip; core/views.js keeps the bare names.

/* global $, TestomatAPI, capabilities, hostOf, setImmersive, state, updateContextBar, views */

// setImmersive and updateContextBar load after this file, but are only reached at paint time.

// Dismissal is in-memory only: it lasts the panel session and resets on reload.
let degradedBannerDismissed = false;

const Gates = {
  // v2 refuses every request on a read-only project, GET included, so there is nothing to show.
  applyReadonlyBlock() {
    const blocked = !!capabilities.readonly && state.view !== 'settings';
    document.body.dataset.readonly = capabilities.readonly ? 'true' : 'false';
    const block = $('readonly-block');
    if (block) block.hidden = !blocked;
    for (const v of views) $(`view-${v}`).hidden = blocked || v !== state.view;
    if (!blocked) { updateContextBar(state.view); return; }
    // Nothing is open behind the block, so Back and the title would both be lying.
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
    // The strip says "sign in over there": with no instance saved there is no there.
    const named = !!(state.settings && hostOf(state.settings.baseUrl));
    // Under the read-only lockout there is no basic mode to explain.
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
