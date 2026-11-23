// Core storage: load persisted settings/session and persist the session slice.

async function loadStored() {
  if (!hasChrome) return {};
  return chrome.storage.local.get(['settings', 'session', 'hostSettings', 'hostHistory']);
}

// One-time migration: the single `settings` becomes the per-host map's entry for its host.
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

// The AI feature's stored API key is a live secret with no reader left, so every boot drops it.
async function dropAiApiKey() {
  if (!hasChrome) return;
  try { await chrome.storage.local.remove('aiApiKey'); } catch { /* best effort */ }
}

function persistSession() {
  if (!hasChrome) return;
  // Never during boot or unsettled: a transient first load's write can resurrect a phantom session.
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
      // The key stays `runInfoOpen`: a rename would silently lose every existing profile's choice.
      runInfoOpen: RunInfo.open, // the Run info disclosure, open unless the user shut it
    },
  });
}
