// Which tab a screen belongs to, its title, its web link, and where a tab click or Back lands.

// No DOM, no globals, no opener called: the two navigations hand back a descriptor instead.
const NavModel = {
  // `promote` is the suite picker's view name (see tc-studio.js).
  TAB_OF_VIEW: {
    tcstudio: 'tests', tclist: 'tests', promote: 'tests',
    runs: 'runs', run: 'runs', test: 'runs',
    // `pick` hides the tabs, but belongs to Settings: the one tab reachable unconfigured.
    settings: 'settings', pick: 'settings',
  },
  TABS: ['tests', 'runs', 'settings'],
  // A tab's landing view: the contextual row (Back + title) is hidden there.
  ROOT_VIEWS: new Set(['tcstudio', 'runs', 'settings', 'pick']),
  // Where a tab stands before it has stood anywhere: the section `aria-controls` names.
  TAB_ROOT: { tests: 'tcstudio', runs: 'runs', settings: 'settings' },

  // A view name nobody knows still has to light a tab, or the bar tells the tester nothing.
  tabOfView: (view) => NavModel.TAB_OF_VIEW[view] || 'runs',

  // The last crumb of the path, printed as the title; empty on a tab root (the row is hidden).
  contextTitleFor(view, state) {
    if (view === 'run') return state.runTitle || 'Run';
    if (view === 'test') return state.testTitle || 'Test';
    if (view === 'tclist') return state.tcSuiteTitle || 'Suite';
    if (view === 'promote') return 'Choose suite';
    return '';
  },

  // Routes are the product's own (Ember), and every id here is the public uid v2 serializes.
  webTarget(view, state, recordFor) {
    if (view === 'run') return state.runId ? ['run', `runs/${encodeURIComponent(state.runId)}`] : null;
    if (view === 'tclist') return state.tcSuiteId ? ['suite', `suite/${encodeURIComponent(state.tcSuiteId)}`] : null;
    if (view !== 'test') return null;
    // The testrun record, not the test case: a parametrized run has many records per test_id.
    if (state.runId && state.currentRecordId) {
      return ['test', `runs/${encodeURIComponent(state.runId)}/test/${encodeURIComponent(state.currentRecordId)}`];
    }
    // No run around the record: the test case page (singular route).
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return rec && rec.test_id ? ['test', `test/${encodeURIComponent(rec.test_id)}`] : null;
  },

  // A saved base url is whatever was typed, so its trailing slashes are stripped here, not in storage.
  webHref(baseUrl, projectId, path) {
    return `${String(baseUrl).replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/${path}`;
  },

  // A decision, not a call: `{ show }` re-shows a held screen, `{ open, args }` names an opener.
  nextViewForTab(tab, state) {
    if (tab === 'settings') return { open: 'settings' };
    const remembered = state.tabViews[tab];
    if (tab === 'tests') {
      // The picker is a transient step of + New test — re-entry lands on the tree.
      return remembered === 'tclist' && state.tcSuiteId ? { show: 'tclist' } : { open: 'tcstudio' };
    }
    return (remembered === 'run' || remembered === 'test') && state.runId
      ? { show: remembered }
      : { open: 'runs' };
  },

  // Back navigates only inside the active tab, one step up the trail the crumbs draw.
  backTargetFor(view, state) {
    if (view === 'tclist') return { open: 'tcstudio' };
    if (view === 'promote') return { open: 'tcstudio' }; // cancel the + New test suite picker
    if (view === 'test') return { open: 'run', args: [state.runId, state.runTitle] };
    if (view === 'run') return { open: 'runs' };
    return null;
  },
};
