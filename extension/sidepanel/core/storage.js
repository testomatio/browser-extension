// Core storage: load persisted settings/session and persist the session slice.

async function loadStored() {
  if (!hasChrome) return {};
  return chrome.storage.local.get(['settings', 'session', 'hostSettings', 'hostHistory']);
}

// One-time migration: the pre-rework single `settings` becomes the per-host map's
// entry for its own host. No-op once `hostSettings` exists; seeds empty maps otherwise.
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

// #105: the AI feature is gone, so its stored API key must not be left lying in
// chrome.storage.local — a live secret with nothing left to read it. Every boot.
async function dropAiApiKey() {
  if (!hasChrome) return;
  try { await chrome.storage.local.remove('aiApiKey'); } catch { /* best effort */ }
}

// Same deal for the welcome checklist: a key nobody reads. Dropped at every boot.
async function dropOnboardingState() {
  if (!hasChrome) return;
  try { await chrome.storage.local.remove('onboarding'); } catch { /* best effort */ }
}

function persistSession() {
  if (!hasChrome) return;
  // Never during boot or before settings exist: a fire-and-forget write from a transient
  // first load can race a reopen's storage reset and resurrect a phantom session.
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
      // The KEY stays `runInfoOpen`: a rename would silently lose every existing profile's choice.
      runInfoOpen: RunInfo.open, // the Run info disclosure (#112), open unless the user shut it
    },
  });
}
