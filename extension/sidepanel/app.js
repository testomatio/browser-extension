// Panel bootstrap: wire controls, restore settings/session, pick the initial view.
// MUST load LAST — every core/ and screens/ script defines the globals this init uses.

/* global Handoff, Icons, Skeleton, askForProject, CommentDrafts, TestSummary, TestMeta, TestGates,
   RunLock, RunInfo, TcQuickBar, TcSuiteCreate, OpenRunIntent, SessionRestore */

// ---------- init ----------

async function init() {
  // The boot placeholder goes up before any wiring; show() takes it down on the first real view.
  Skeleton.paintBoot();
  // Static chrome asks for its icons by name (data-icon).
  Icons.hydrate(document);
  // After the icons are in: create buttons keep their full label while the pane can spare the width,
  // and the observers armed here re-answer that as it is dragged (core/views.js).
  initActionLabelFit();
  initCounterFade(); // a counter's flash is one-shot — it must not replay on every re-show
  $('tab-tests').addEventListener('click', () => switchTab('tests'));
  $('tab-runs').addEventListener('click', () => switchTab('runs'));
  $('tab-settings').addEventListener('click', () => switchTab('settings'));
  $('tc-add-test-root').addEventListener('click', openTestSuitePicker); // + New test → suite picker → editor
  $('tc-add-suite-root').addEventListener('click', () => TcSuiteCreate.openRoot('file'));
  $('tc-add-folder-root').addEventListener('click', () => TcSuiteCreate.openRoot('folder'));
  $('tc-list-new').addEventListener('click', () => {
    if (state.tcSuiteId) {
      openEditor({ suite: state.tcSuiteId, suiteId: state.tcSuiteId, suiteTitle: state.tcSuiteTitle });
    }
  });
  $('btn-back').addEventListener('click', goBack);
  $('btn-save-settings').addEventListener('click', () => saveSettings());
  // On the first-run connect screen the form IS this one field, so Enter commits.
  $('set-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
  initSettingsSections(); // the settings accordion — one delegated click for every fold
  $('settings-advanced-head').addEventListener('click', toggleSettingsAdvanced); // Advanced collapse (#146)
  // The head script already pinned the theme before the first paint; this only wires the switch.
  initThemeSwitch();
  // #177: Disconnect erases the ACTIVE instance's token, Forget the one the form is showing.
  // Both are wrapped — forgetInstance takes options, and a click event is not one.
  $('btn-disconnect').addEventListener('click', () => disconnectInstance());
  $('btn-forget-instance').addEventListener('click', () => forgetInstance());
  $('btn-sign-out').addEventListener('click', signOut);
  // Diagnostics: the fold is the delegate's, this only re-reads the numbers on the way open.
  $('settings-diagnostics-head').addEventListener('click', () => renderDiagnostics());
  $('btn-copy-diagnostics').addEventListener('click', () => copyDiagnostics());
  // Both track the Instance field: the token box itself comes back for an instance we hold no token for.
  $('set-baseurl').addEventListener('input', () => { updateTokenHelpLink(); syncTokenField(); });
  // Instance history: picking a host restores its saved settings into the form.
  initHostHistoryDropdown();
  // Header project switcher (#103/#126): picking a row repoints the panel and resets the tabs.
  initProjectDropdown();
  // …and its whole-screen twin, the pick a connection lands on when it resolved no project.
  initProjectPick();
  // Panel-wide Refresh (#127): re-pulls the projects, the open view and both tab counts.
  $('btn-refresh').addEventListener('click', refreshAll);
  // #208 surface switch. Not awaited — it only needs to know its surface before the first click.
  initViewSwitch();
  $('degraded-banner-dismiss').addEventListener('click', dismissDegradedBanner);
  $('degraded-banner-refresh').addEventListener('click', refreshFromDegradedBanner);
  // One runs input (#106): typing filters, a pasted run/group URL opens it (Enter re-tries it).
  $('runs-search').addEventListener('input', onRunsSearch);
  $('runs-search').addEventListener('keydown', onRunsSearchKeydown);
  $('runs-search-clear').addEventListener('click', clearRunsSearch);
  $('run-search').addEventListener('input', onRunSearch);
  $('run-search-clear').addEventListener('click', clearRunSearch);
  $('tc-search').addEventListener('input', onTcSearch);
  $('tc-search-clear').addEventListener('click', clearTcSearch);
  // Add new test (#3): the bar at the panel's bottom — one title, or a list of them under Bulk.
  $('tc-quick-title').addEventListener('input', TcQuickBar.onInput);
  $('tc-quick-title').addEventListener('keydown', TcQuickBar.onKeydown);
  $('tc-quick-titles').addEventListener('input', TcQuickBar.onInput);
  $('tc-quick-titles').addEventListener('keydown', TcQuickBar.onKeydown);
  $('tc-quick-create').addEventListener('click', TcQuickBar.submit);
  $('tc-quick-bulk').addEventListener('change', TcQuickBar.onBulkToggle);
  $('tc-tree-search').addEventListener('input', onTcTreeSearch);
  $('tc-tree-search-clear').addEventListener('click', clearTcTreeSearch);
  $('btn-passed').addEventListener('click', () => clickStatus('passed'));
  $('btn-failed').addEventListener('click', () => clickStatus('failed'));
  $('btn-skipped').addEventListener('click', () => clickStatus('skipped'));
  // ← / → move ±1 through the visible list; #108's jump to the next UNTESTED row is the N key.
  $('btn-prev-test').addEventListener('click', () => navigateTest(-1));
  $('btn-next-test').addEventListener('click', () => navigateTest(1));
  // The comment is read only by a status write, so what is typed is kept as a draft
  // until one lands — otherwise leaving the test drops it.
  $('test-comment').addEventListener('input', CommentDrafts.onInput);
  $('tab-test-desc').addEventListener('click', () => showTestSection('desc'));
  $('tab-test-status').addEventListener('click', () => showTestSection('status'));
  $('tab-test-summary').addEventListener('click', () => showTestSection('summary'));
  $('btn-screenshot-annotate').addEventListener('click', attachScreenshotAnnotated);
  // #192: the escape hatch for an annotation the upload re-check refused.
  $('btn-save-annotation').addEventListener('click', savePendingAnnotation);
  // Full-page capture checkbox: persisted, and mirrored wherever else it shows.
  $('fullpage-test').addEventListener('change', (e) => TestGates.setFullPageCapture(e.target.checked));
  $('btn-finish-run').addEventListener('click', RunLock.finishRun);
  $('run-info-head').addEventListener('click', RunInfo.toggle); // Run info disclosure (#112)
  TestMeta.initSubstatus();
  TestMeta.initAssignee();
  $('attachments-head').addEventListener('click', TestGates.toggleAttachmentsDisclosure);
  for (const key of ['failure', 'artifacts', 'meta', 'steps']) {
    $(`summary-${key}-head`).addEventListener('click', () => TestSummary.toggleDisclosure(key));
  }
  initEvidence();
  initAttachments(); // #107: the Attach file button + its hidden native picker
  initScreenRec(); // #68: the screen recording button and the upload of what it produced
  // While this panel is open the worker must not re-open it on a toolbar click, or the tester
  // loses the page they are on (shared/panel-link.js).
  PanelLink.init();
  initLiveSync(); // M4 poll: visibilitychange catch-up (the timer starts on run open)
  document.addEventListener('keydown', onHotkey); // web-runner hotkeys; inert outside the test view
  initHotkeyHints();
  applyCapabilities(); // seed data-jwt="unknown" before any probe

  const stored = await loadStored();
  state.settings = stored.settings || null;
  await migrateHostSettings(stored); // per-host map + history (seeds from `settings`)
  await dropAiApiKey(); // #105: the removed AI polish must leave no key behind
  await dropOnboardingState(); // …and the removed welcome checklist no progress slice
  // Before any run renders, so restored rows show their «queued» markers immediately.
  if (typeof OfflineQueue !== 'undefined') await OfflineQueue.init();
  // A host app's offer outranks whatever is stored: it is this session's own connection, and it
  // is what a tester who opened the panel FROM that app is expecting to see.
  if (await Handoff.ready()) await Handoff.connect();
  if (!state.settings) {
    OpenRunIntent.drop(); // landing on Settings anyway; a stale intent must not fire on a later connect
    fillSettingsForm();
    show('settings');
    state.booting = false; // a later Save may now persist its session
    return;
  }
  Handoff.configure(state.settings);
  // Paints the saved project at once, refreshes the list in the background, and resolves one for a
  // config that has none — or leaves that pick to the tester (#11). Failing all, there is nothing to
  // run against — land on Settings.
  const project = await initProjectSwitcher();
  if (project !== 'ready') {
    if (project === 'choose') askForProject();
    else {
      fillSettingsForm();
      show('settings');
      // The token is saved, so the form has no box to re-paste it into: retry, or reconnect.
      setStatusLine('settings-status',
        "Couldn't load your projects — press Save & validate to retry, or Disconnect to use another token", 'error');
    }
    state.booting = false;
    return;
  }
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // panel open is a replay trigger

  const session = stored.session;
  // Sessions are keyed by record id; a session that predates that degrades to the run list
  // (nothing resolves) rather than restoring a stale test.
  const restored = SessionRestore.fromStored(session, FILTER_KEYS);
  state.stepTicks = restored.stepTicks;
  state.expandedGroups = restored.expandedGroups;
  state.runsFilter = restored.runsFilter;
  RunInfo.open = restored.runInfoOpen;
  state.tabViews = restored.tabViews;

  // The host's run, then a "Run in Extension" click — both outrank the editor breadcrumb and the
  // restored session below, and both need the project switcher settled above.
  const openedIntent = (await Handoff.openRun()) || (await OpenRunIntent.consume(openRunFromUrl));
  OpenRunIntent.init(openRunFromUrl); // …and a panel left open answers the next click without a reload
  if (openedIntent) { state.booting = false; return; }

  // Returning from the editor: openEditor()'s breadcrumb restores that suite's TC list.
  const tcReturn = SessionRestore.takeTcReturn();
  if (tcReturn) {
    openTcListView(tcReturn.suiteId, tcReturn.suiteTitle);
    state.booting = false;
    return;
  }

  const activeTab = restored.activeTab;
  if (activeTab === 'runs' && session?.runId && (session.view === 'run' || session.view === 'test')) {
    state.runTitle = session.runTitle || '';
    await openRunView(session.runId, session.runTitle);
    if (session.view === 'test' && session.currentRecordId && recordFor(session.currentRecordId)) {
      openTestView(session.currentRecordId);
    }
  } else if (activeTab === 'settings') {
    openSettingsView();
  } else if (activeTab === 'tests') {
    // The Tests tab restores its root; ephemeral sub-views fall back to the tree.
    openTcStudioView();
  } else {
    openRunsView();
  }
  // Boot restore is done — later view changes may persist the session again.
  state.booting = false;
}

// The floor under show(): a boot that throws before reaching a view must not leave the placeholder up.
init().finally(() => Skeleton.bootDone());
