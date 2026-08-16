// Core storage: load persisted settings/session and persist the session slice.

// ---------- storage ----------

async function loadStored() {
  if (!hasChrome) return {};
  return chrome.storage.local.get(['settings', 'session', 'hostSettings', 'hostHistory']);
}

// One-time migration (permission rework): the pre-rework single `settings` object
// becomes the per-host map's entry for its own host, so a later instance switch
// restores it with no re-entry. No-op once `hostSettings` exists (idempotent), and
// on a fresh install it just seeds empty maps. Populates state.hostSettings/History.
async function migrateHostSettings(stored) {
  let hostSettings = stored.hostSettings && typeof stored.hostSettings === 'object' ? stored.hostSettings : null;
  let hostHistory = Array.isArray(stored.hostHistory) ? stored.hostHistory : null;
  if (!hostSettings && stored.settings) {
    const host = hostOf(stored.settings.baseUrl);
    if (host) {
      hostSettings = { [host]: stored.settings };
      hostHistory = [host];
      if (hasChrome) await chrome.storage.local.set({ hostSettings, hostHistory });
    }
  }
  state.hostSettings = hostSettings || {};
  state.hostHistory = hostHistory || [];
}

// One-time cleanup (#105): the AI step polish is gone, so the Anthropic key it
// stored must not be left lying in chrome.storage.local — it is a live secret with
// nothing left to read it. Removed at every boot, which is also the migration for
// an install that had one. No-op on a profile that never had a key.
async function dropAiApiKey() {
  if (!hasChrome) return;
  try { await chrome.storage.local.remove('aiApiKey'); } catch { /* best effort */ }
}

// Same deal for the welcome checklist: the card is gone, so its progress slice is
// a key nobody reads. Dropped at every boot — no-op once, then forever after.
async function dropOnboardingState() {
  if (!hasChrome) return;
  try { await chrome.storage.local.remove('onboarding'); } catch { /* best effort */ }
}

function persistSession() {
  if (!hasChrome) return;
  // Never persist during boot or before settings exist: a fire-and-forget write
  // from a transient first load could otherwise race a reopen's storage reset and
  // resurrect a phantom session (wrong tab on the next load).
  if (state.booting || !state.settings) return;
  chrome.storage.local.set({
    session: {
      view: state.view,
      activeTab: state.activeTab,
      tabViews: state.tabViews,
      runId: state.runId,
      runTitle: state.runTitle,
      currentRecordId: state.currentRecordId,
      stepTicks: state.stepTicks,
      expandedGroups: state.expandedGroups,
      runsFilter: state.runsFilter,
      runInfoOpen, // the Run info disclosure (#112), open unless the user shut it
    },
  });
}
