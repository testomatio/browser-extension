// Panel bootstrap: wire up controls, restore settings/session, and pick the
// initial view. Loaded last, after every core/ and screens/ script has defined
// the globals this init uses.

/* global TestomatAPI, Icons, Skeleton */

// ---------- init ----------

async function init() {
  // The boot placeholder, before anything else: every line below this one is
  // wiring, and every line after the first `await` is a network round trip the
  // tester would otherwise spend looking at a white panel. It comes down
  // in show(), on the first view there is something real to paint.
  Skeleton.paintBoot();
  // Static chrome asks for its icons by name (data-icon); the one icon set fills
  // them in. Everything below can already be looking at the header.
  Icons.hydrate(document);
  // Every toolbar's create button now that its icon is in: they say the whole
  // errand ("New run", "New test") while the search beside them can spare the
  // width, and the observers armed here keep answering that as the pane is
  // dragged (core/views.js).
  initActionLabelFit();
  $('tab-tests').addEventListener('click', () => switchTab('tests'));
  $('tab-runs').addEventListener('click', () => switchTab('runs'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));
  $('tc-add-test-root').addEventListener('click', openTestSuitePicker); // + New test → suite picker → editor
  $('tc-add-suite-root').addEventListener('click', () => openRootSuiteInput('file'));
  $('tc-add-folder-root').addEventListener('click', () => openRootSuiteInput('folder'));
  $('tc-list-new').addEventListener('click', () => {
    if (state.tcSuiteId) {
      openEditor({ suite: state.tcSuiteId, suiteId: state.tcSuiteId, suiteTitle: state.tcSuiteTitle });
    }
  });
  $('btn-back').addEventListener('click', goBack);
  $('btn-save-settings').addEventListener('click', () => saveSettings());
  // Enter commits from the token field: on the first-run connect screen the form
  // is that one field, and pressing Enter in it is what everyone does.
  $('set-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
  $('settings-advanced-head').addEventListener('click', toggleSettingsAdvanced); // Advanced collapse (#146)
  // Appearance: System / Light / Dark. The theme itself was already pinned by
  // the head script before this panel drew a pixel — this only wires the switch
  // that changes it.
  initThemeSwitch();
  // #177: the only way to take a saved token off this machine short of uninstalling.
  // Disconnect is the same erase aimed at the ACTIVE instance; Forget (in
  // Advanced) aims at whichever one the form is showing. Both are wrapped —
  // forgetInstance takes options, and a click event is not one.
  $('btn-disconnect').addEventListener('click', () => disconnectInstance());
  $('btn-forget-instance').addEventListener('click', () => forgetInstance());
  $('btn-sign-out').addEventListener('click', signOut);
  // Token-help link tracks the Instance field as the user types — and so does the
  // token field itself, which comes back for an instance we hold no token for.
  $('set-baseurl').addEventListener('input', () => { updateTokenHelpLink(); syncTokenField(); });
  // Instance history: picking a host restores its saved settings into the form.
  $('set-host-history').addEventListener('change', onInstanceHostPicked);
  // Header project switcher (#103/#126): the custom dropdown — picking a row
  // repoints the panel and resets the tabs.
  initProjectDropdown();
  // Panel-wide Refresh (#127): the strip's own control — re-pulls the projects,
  // the open view and both tab counts, from whichever tab it is pressed on.
  $('btn-refresh').addEventListener('click', refreshAll);
  // …and the strip's last control (#208): side panel ↔ its own window. Not
  // awaited — it only has to know which surface it is in before the first click.
  initViewSwitch();
  $('degraded-banner-dismiss').addEventListener('click', dismissDegradedBanner);
  $('degraded-banner-refresh').addEventListener('click', refreshFromDegradedBanner);
  // One runs input (#106): typing filters, a pasted run/group URL opens it
  // (Enter re-tries the URL already in the box).
  $('runs-search').addEventListener('input', onRunsSearch);
  $('runs-search').addEventListener('keydown', onRunsSearchKeydown);
  $('runs-search-clear').addEventListener('click', clearRunsSearch);
  $('run-search').addEventListener('input', onRunSearch);
  $('run-search-clear').addEventListener('click', clearRunSearch);
  $('tc-search').addEventListener('input', onTcSearch);
  $('tc-search-clear').addEventListener('click', clearTcSearch);
  // Tests screen: the same deal one level up — typing filters the suite tree.
  $('tc-tree-search').addEventListener('input', onTcTreeSearch);
  $('tc-tree-search-clear').addEventListener('click', clearTcTreeSearch);
  $('btn-passed').addEventListener('click', () => clickStatus('passed'));
  $('btn-failed').addEventListener('click', () => clickStatus('failed'));
  $('btn-skipped').addEventListener('click', () => clickStatus('skipped'));
  // The pager's two steps — the ← / → keys' own move, ±1 through the visible
  // list. (#108's status-aware jump to the next UNTESTED row is the N key.)
  $('btn-prev-test').addEventListener('click', () => navigateTest(-1));
  $('btn-next-test').addEventListener('click', () => navigateTest(1));
  // Test view sections: Description (the steps) / Status (the result + its controls).
  $('tab-test-desc').addEventListener('click', () => showTestSection('desc'));
  $('tab-test-status').addEventListener('click', () => showTestSection('status'));
  $('tab-test-summary').addEventListener('click', () => showTestSection('summary'));
  $('btn-screenshot-annotate').addEventListener('click', attachScreenshotAnnotated);
  // #192: the escape hatch for an annotation the upload re-check refused.
  $('btn-save-annotation').addEventListener('click', savePendingAnnotation);
  // Full-page capture checkbox (M2 PR-3): persist + mirror; test-view only now.
  $('fullpage-test').addEventListener('change', (e) => setFullPageCapture(e.target.checked));
  $('btn-finish-run').addEventListener('click', finishRun);
  $('run-info-head').addEventListener('click', toggleRunInfo); // Run info disclosure (#112)
  $('substatus-select').addEventListener('change', onSubstatusChange);
  // Assignee (M4 → custom listbox): the search filter + open/close/keyboard
  // wiring, same deal as initProjectDropdown() above.
  initAssigneeDropdown();
  $('attachments-head').addEventListener('click', toggleAttachmentsDisclosure); // control-tower diet
  // Result summary disclosures (#117): Failure / Meta / Steps.
  for (const key of ['failure', 'meta', 'steps']) {
    $(`summary-${key}-head`).addEventListener('click', () => toggleSummaryDisclosure(key));
  }
  $('onboarding-dismiss').addEventListener('click', () => Onboarding.dismiss()); // welcome checklist ×
  initEvidence(); // evidence recorder toggle + section wiring (M2 PR-1)
  initAttachments(); // #107: the Attach file button + its hidden native picker
  initLiveSync(); // M4 poll: visibilitychange catch-up (the timer starts on run open)
  document.addEventListener('keydown', onHotkey); // web-runner hotkeys (US5); inert outside the test view
  initHotkeyHints(); // status-button shortcut tooltips + the "?" legend
  applyCapabilities(); // seed data-jwt="unknown" before any probe

  const stored = await loadStored();
  state.settings = stored.settings || null;
  await migrateHostSettings(stored); // per-host map + history (seeds from `settings`)
  await dropAiApiKey(); // #105: the removed AI polish must leave no key behind
  Onboarding.init(stored); // welcome checklist: seed from storage / existing config + session (before any render or run restore)
  // Load the offline queue before any run renders so restored rows show their
  // «queued» markers immediately (survives panel restart).
  if (typeof OfflineQueue !== 'undefined') await OfflineQueue.init();
  if (!state.settings) {
    fillSettingsForm();
    show('settings');
    state.booting = false; // a later Save may now persist its session
    return;
  }
  TestomatAPI.configure(state.settings);
  // Header project switcher (#103): paints the saved project at once and refreshes
  // the list in the background. A config with no project (pre-#103 leftovers) gets
  // one resolved here; when even that fails there is nothing to run against, so we
  // land on Settings rather than a wall of unconfigured errors.
  if (!(await initProjectSwitcher())) {
    fillSettingsForm();
    show('settings');
    // The token is saved, so the form has no box to re-paste it into (#connection
    // -card): the two ways forward are a retry and a fresh connection.
    setStatusLine('settings-status',
      "Couldn't load your projects — press Save & validate to retry, or Disconnect to use another token", 'error');
    state.booting = false;
    return;
  }
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // panel open is a replay trigger

  // Returning from the editor page (panel ctx): the one-shot breadcrumb set by
  // openEditor() restores the exact suite's TC list. Consumed once so a later
  // plain reload doesn't hijack the runs view.
  let tcReturn = null;
  try { tcReturn = JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { /* ignore */ }
  if (tcReturn && tcReturn.suiteId) {
    try { sessionStorage.removeItem('tcReturn'); } catch { /* ignore */ }
    openTcListView(tcReturn.suiteId, tcReturn.suiteTitle);
    state.booting = false;
    return;
  }

  const session = stored.session;
  // Sessions are keyed by record id. A pre-refactor session stored the old
  // test_id-keyed `currentTestId`/`stepTicks`; those keys simply won't resolve
  // (recordFor returns undefined → falls through to the run view; stale ticks
  // never match a record id), so old sessions degrade to the run list without
  // error rather than restoring a stale test — an acceptable one-time reset for
  // an internal, ephemeral session shape.
  state.stepTicks = session?.stepTicks || {};
  state.expandedGroups = Array.isArray(session?.expandedGroups) ? session.expandedGroups : [];
  state.runsFilter = FILTER_KEYS.has(session?.runsFilter) ? session.runsFilter : 'all';
  // Run info disclosure (#112): open unless this user closed it — an old session
  // (no key) and a fresh profile both land on the default, which is open.
  runInfoOpen = session?.runInfoOpen !== false;
  state.tabViews = (session && session.tabViews && typeof session.tabViews === 'object') ? session.tabViews : {};

  // Restore the last active tab. Old sessions (no activeTab) infer 'runs' from a
  // persisted run/test view so an in-flight run still restores.
  const activeTab = session?.activeTab
    || ((session?.view === 'run' || session?.view === 'test') ? 'runs' : null);
  if (activeTab === 'runs' && session?.runId && (session.view === 'run' || session.view === 'test')) {
    state.runTitle = session.runTitle || '';
    await openRunView(session.runId, session.runTitle);
    if (session.view === 'test' && session.currentRecordId && recordFor(session.currentRecordId)) {
      openTestView(session.currentRecordId);
    }
  } else if (activeTab === 'settings') {
    openSettingsView();
  } else if (activeTab === 'tests') {
    // The Tests tab restores its root; ephemeral sub-views (tclist/suite picker)
    // fall back to the tree.
    openTcStudioView();
  } else {
    openRunsView();
  }
  // Boot restore is done — later view changes may persist the session again.
  state.booting = false;
}

// A boot that throws before it reaches a view would leave the placeholder up for
// good, and a panel frozen mid-load reads far worse than the empty one the
// failure actually left behind. show() is what normally retires it; this is the
// floor under that, and on the happy path it finds nothing left to do.
init().finally(() => Skeleton.bootDone());
