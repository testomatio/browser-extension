// The panel's navigation model: which tab a screen belongs to, what the contextual row titles it,
// where its web link points, and which screen a tab click or a Back lands on. Read by core/views.js.

// Everything here is a decision about names and ids — no DOM, no globals, no opener is called. That
// is what lets it be read on its own, and why the two navigations hand back a descriptor instead.
const NavModel = {
  // `promote` is the suite picker's historical view name (see tc-studio.js).
  TAB_OF_VIEW: {
    tcstudio: 'tests', tclist: 'tests', promote: 'tests',
    runs: 'runs', run: 'runs', test: 'runs',
    // `pick` is the choose-a-project screen: it stands BEFORE the tabs (nothing is scoped yet)
    // and hides them, but it is the Settings tab it belongs to — the one tab reachable unconfigured.
    settings: 'settings', pick: 'settings',
  },
  TABS: ['tests', 'runs', 'settings'],
  // A tab's landing view: the contextual row (Back + title) is hidden there.
  ROOT_VIEWS: new Set(['tcstudio', 'runs', 'settings', 'pick']),
  // Where a tab stands before it has stood anywhere — the section `aria-controls` names
  // until state.tabViews remembers one of its own (nextViewForTab lands on these same three).
  TAB_ROOT: { tests: 'tcstudio', runs: 'runs', settings: 'settings' },

  // A view name nobody knows still has to light a tab, or the bar tells the tester nothing.
  tabOfView: (view) => NavModel.TAB_OF_VIEW[view] || 'runs',

  // The LAST crumb of the path, printed as the screen's title, not as a link.
  // Empty on a tab root (the row is hidden there).
  contextTitleFor(view, state) {
    if (view === 'run') return state.runTitle || 'Run';
    if (view === 'test') return state.testTitle || 'Test';
    if (view === 'tclist') return state.tcSuiteTitle || 'Suite';
    if (view === 'promote') return 'Choose suite';
    return '';
  },

  // The way out to the web app for whatever the row names, as `[noun, path]` — null where there is
  // nothing to point at. The routes are the product's own (Ember), and every id here IS the public
  // uid v2 serializes. `recordFor` is passed in: it is a screen's lookup, and may be absent.
  webTarget(view, state, recordFor) {
    if (view === 'run') return state.runId ? ['run', `runs/${encodeURIComponent(state.runId)}`] : null;
    if (view === 'tclist') return state.tcSuiteId ? ['suite', `suite/${encodeURIComponent(state.tcSuiteId)}`] : null;
    if (view !== 'test') return null;
    // Links to the TESTRUN record, not the test case — a parametrized run has many
    // records sharing one test_id, which cannot name the row on screen.
    if (state.runId && state.currentRecordId) {
      return ['test', `runs/${encodeURIComponent(state.runId)}/test/${encodeURIComponent(state.currentRecordId)}`];
    }
    // No run around the record: the test CASE page (singular route).
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return rec && rec.test_id ? ['test', `test/${encodeURIComponent(rec.test_id)}`] : null;
  },

  // A saved base url is whatever was typed, so its trailing slashes go here rather than in storage;
  // the project id is a uid the user never sees and is encoded like every other id in the path.
  webHref(baseUrl, projectId, path) {
    return `${String(baseUrl).replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/${path}`;
  },

  // Where a tab click lands, as a DECISION rather than a call: `{ show }` re-shows a screen the tab
  // still holds in memory, `{ open, args }` names the opener core/views.js is to run.
  // Views holding in-memory state (an open run/test, a suite's TC list) are re-shown
  // without a reset; container views reload from storage/server.
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

  // Back navigates only INSIDE the active tab, one step up the trail the crumbs draw. Null on
  // tcstudio / runs / settings — they are tab roots, where the arrow is hidden.
  backTargetFor(view, state) {
    if (view === 'tclist') return { open: 'tcstudio' };
    if (view === 'promote') return { open: 'tcstudio' }; // cancel the + New test suite picker
    if (view === 'test') return { open: 'run', args: [state.runId, state.runTitle] };
    if (view === 'run') return { open: 'runs' };
    return null;
  },
};
