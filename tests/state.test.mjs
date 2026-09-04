#!/usr/bin/env node
// The panel's memory (#154): what a project switch has to forget, whether this connection may
// write at all, and what a failed request looks like to the tester. Run: node --test tests/state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, plain, settle } from './helpers/core-harness.mjs';

const CONNECTED = { baseUrl: 'https://app.testomat.io', apiToken: 't', projectId: 'p1' };

// A panel with a project open — every read-only row needs isConfigured() to be true.
function connected(opts = {}) {
  const h = loadState(opts);
  h.state.settings = { ...CONNECTED };
  return h;
}

// A promise the test resolves by hand, for the "two callers, one request" rows.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---- A: who is who ---------------------------------------------------------

test('#154-1: a row is found whether its id arrived as a number or as text', () => {
  const h = loadState();
  h.state.records = [{ id: 7, test_title: 'Login' }];
  assert.equal(plain(h.recordFor('7')).test_title, 'Login');
  assert.equal(plain(h.recordFor(7)).test_title, 'Login');
  assert.equal(h.recordFor('8'), undefined);
});

test('#154-2: asking for no row at all finds a row whose id is literally the word "null"', () => {
  const h = loadState();
  // A sharp edge, pinned so that smoothing it later is a deliberate change.
  h.state.records = [{ id: 'null', test_title: 'Odd one' }];
  assert.equal(plain(h.recordFor(null)).test_title, 'Odd one');
});

test('#154-3: the instance is remembered by its host name', () => {
  assert.equal(loadState().hostOf('https://app.testomat.io/x'), 'app.testomat.io');
});

test('#154-4: something that is not an address names no host', () => {
  const h = loadState();
  assert.equal(h.hostOf('not a url'), null);
  assert.equal(h.hostOf(''), null);
  assert.equal(h.hostOf(undefined), null);
  assert.equal(h.hostOf('https://a.io'), 'a.io', 'a real one still names its host');
});

test('#154-5: a scheme with no host behind it names no host either', () => {
  assert.equal(loadState().hostOf('https://'), null);
});

test('#154-6: a token on its own is not a connection the tabs will open', () => {
  const h = loadState();
  h.state.settings = { apiToken: 't' };
  assert.equal(h.isConfigured(), false);
  h.state.settings = { ...CONNECTED };
  assert.equal(h.isConfigured(), true);
  h.state.settings = null;
  assert.equal(h.isConfigured(), false);
});

test('#154-7: rows that started loading for the project we have left are stale', () => {
  const h = loadState();
  h.state.projectEpoch = 4;
  assert.equal(h.staleProject(3), true);
  assert.equal(h.staleProject(4), false);
});

// ---- B: the project's own lists --------------------------------------------

const withReplies = async (groups) => {
  const h = loadState({ api: { getProjectInfo: async () => ({ data: { attributes: { 'run-replies': groups } } }) } });
  await h.fn.loadProjectInfo();
  return h;
};

test('#154-8: only real words are offered as reasons under a status', async () => {
  const h = await withReplies({ failed: ['Blocked', '', 42, ' '] });
  assert.deepEqual(plain(h.fn.runRepliesFor('failed')), ['Blocked']);
});

test('#154-9: a panel that never read the project offers no reasons', () => {
  assert.deepEqual(plain(loadState().fn.runRepliesFor('passed')), []);
});

test('#154-10: a project read that failed is tried again the next time it is needed', async () => {
  let attempt = 0;
  const h = loadState({
    api: {
      getProjectInfo: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('offline');
        return { data: { attributes: { 'run-replies': { failed: ['Blocked'] } } } };
      },
    },
  });
  assert.equal(await h.fn.loadProjectInfo(), null);
  assert.equal(h.peek().projectInfoPromise, null, 'the failed attempt is not kept as the answer');
  assert.ok(await h.fn.loadProjectInfo());
  assert.equal(h.api.count('getProjectInfo'), 2);
  // A third call reuses the good answer rather than asking again.
  await h.fn.loadProjectInfo();
  assert.equal(h.api.count('getProjectInfo'), 2);
});

// Anna signed up with capitals in her address — the map has to key on the lowercased one.
const MEMBERS = [
  { id: '42', name: 'Anna K', email: 'Anna@X.io', timezone: 'Europe/Kyiv' },
  { id: '43', name: 'Bob L', email: 'bob@x.io', timezone: 'UTC' },
];
const withMembers = async (users = MEMBERS, over = {}) => {
  const h = loadState({ api: { listProjectUsers: async () => users, ...over } });
  await h.fn.loadProjectUsers();
  return h;
};

test('#154-11: a member is recognised however the email was capitalised', async () => {
  const h = await withMembers();
  assert.equal(h.fn.assigneeName('ANNA@x.io'), 'Anna K');
  assert.equal(plain(h.fn.assigneeUser('Anna@X.io')).timezone, 'Europe/Kyiv');
});

test('#154-12: an assignee the panel never loaded shows as the name in front of the @', () => {
  const h = loadState();
  assert.equal(h.fn.assigneeName('bob@x.io'), 'bob');
  assert.equal(h.fn.assigneeUser('bob@x.io'), null);
});

test('#154-13: an address that starts with @ is shown whole rather than emptied', () => {
  assert.equal(loadState().fn.assigneeName('@x.io'), '@x.io');
});

test('#154-14: a name written in another alphabet is cut at the @ like any other', () => {
  assert.equal(loadState().fn.assigneeName('日本@例.jp'), '日本');
});

test('#154-15: the viewer\'s own time zone is found even though the id arrives as a number',
  async () => {
    const h = await withMembers(MEMBERS, { jwtUserId: () => 42 });
    assert.equal(h.fn.viewerTimezone(), 'Europe/Kyiv');
  });

test('#154-16: with no members loaded there is no viewer time zone to use', () => {
  const h = loadState({ api: { jwtUserId: () => 42 } });
  assert.equal(h.fn.viewerTimezone(), null);
});

test('#154-B1: a members read that failed is tried again, and clears what it had', async () => {
  let attempt = 0;
  const h = loadState({
    api: { listProjectUsers: async () => { attempt += 1; if (attempt === 1) throw new Error('offline'); return MEMBERS; } },
  });
  assert.equal(await h.fn.loadProjectUsers(), null);
  assert.equal(h.peek().usersMap, null);
  assert.ok(await h.fn.loadProjectUsers());
  assert.equal(h.fn.assigneeName('anna@x.io'), 'Anna K');
  assert.equal(h.api.count('listProjectUsers'), 2);
});

// ---- C: switching project must leave nothing behind -------------------------

// What every field is worth once the switch is done. Named one by one on purpose: the bug this
// guards against is exactly "one field was forgotten".
const AFTER_RESET = {
  runId: null, runTitle: '', testTitle: '', runStatus: null, records: [], runExamples: {},
  substatusCounts: {}, runInfo: {}, currentRecordId: null, stepTicks: {}, runFilter: 'all',
  runSearch: '', expandedSuites: {}, testrunDetail: null, currentSteps: [], expandedGroups: [],
  runsFilter: 'all', runsSearch: '', lastRuns: [], lastGroups: [], dashItems: [],
  childrenCache: {}, subgroupsCache: {}, loadingGroup: {}, descendantRuns: {},
  descendantsSettled: false, descendantsPartial: false, descInFlight: 0, runsChipCounts: null,
  listPaging: {}, v2RunsPaging: {}, v2GroupsPaging: {}, groupPaging: {}, highlightedGroup: null,
  tcSuites: [], tcExpanded: {}, tcSuiteId: null, tcSuiteTitle: '', tcSuiteEmoji: null,
  tcTests: [], tcSearch: '', tcTreeSearch: '', suiteEmoji: null, tabViews: {},
};
// Counters, not values: they go UP so anything still in flight can tell it was left behind.
const BUMPED = ['projectEpoch', 'descLoadToken'];
// Deliberately survives a project switch — the connection itself, the screen furniture, and the
// two in-flight write counters a switch has no business zeroing.
const KEPT = ['settings', 'hostSettings', 'hostHistory', 'projects', 'view', 'activeTab', 'booting',
  'runKind', 'testDetailPending', 'saving', 'inlineWrites', 'listMode'];

// A panel in the middle of real work: a run open, a test open, ticks, filters, caches, paging, tree.
const DIRT = {
  runId: 'r7', runTitle: 'Nightly smoke', testTitle: 'Login works', runStatus: 'running',
  records: [{ id: 1 }, { id: 2 }, { id: 3 }], runExamples: { 1: { values: ['a'] } },
  substatusCounts: { failed: 2 }, runInfo: { build: '42' }, currentRecordId: 'rec9',
  stepTicks: { rec9: { 0: true } }, runFilter: 'failed', runSearch: 'login',
  expandedSuites: { s1: true }, testrunDetail: { data: { id: 'x' } },
  currentSteps: [{ kind: 'step', title: 'Open' }], expandedGroups: ['g1'], runsFilter: 'passed',
  runsSearch: 'nightly', lastRuns: [{ id: 'r1' }], lastGroups: [{ id: 'g1' }],
  dashItems: [{ id: 'd1' }], childrenCache: { g1: [] }, subgroupsCache: { g1: [] },
  loadingGroup: { g1: true }, descendantRuns: { g1: [] }, descendantsSettled: true,
  descendantsPartial: true, descInFlight: 3, runsChipCounts: { counts: { failed: 2 }, partial: true },
  listPaging: { page: 2 }, v2RunsPaging: { page: 2 }, v2GroupsPaging: { page: 2 },
  groupPaging: { g1: {} }, highlightedGroup: 'g1', tcSuites: [{ id: 's1' }], tcExpanded: { s1: true },
  tcSuiteId: 's1', tcSuiteTitle: 'Checkout', tcSuiteEmoji: '\u{1F6D2}', tcTests: [{ id: 't1' }],
  tcSearch: 'pay', tcTreeSearch: 'check', suiteEmoji: { Checkout: '\u{1F6D2}' },
  tabViews: { runs: 'run', tests: 'tclist' },
};

function dirty(h) {
  Object.assign(h.state, DIRT, { settings: { ...CONNECTED }, projectEpoch: 5, descLoadToken: 9 });
  return h;
}

test('#154-17: switching project leaves not one field of the old one on screen', () => {
  const h = dirty(connected());
  h.fn.resetProjectScopedState();
  for (const [key, value] of Object.entries(AFTER_RESET)) {
    assert.deepEqual(plain(h.state[key]), value, `${key} still carries the old project`);
  }
  // …and the fixture really was dirty: the same keys differ before the switch.
  const before = dirty(connected());
  for (const key of Object.keys(AFTER_RESET)) {
    assert.notDeepEqual(plain(before.state[key]), AFTER_RESET[key], `${key} was never dirtied`);
  }
});

test('#154-17b: every field of the panel\'s memory is either cleared or knowingly kept', () => {
  // A field added to `state` and forgotten in the reset lands in neither list and fails here.
  assert.deepEqual(
    Object.keys(loadState().state).sort(),
    [...Object.keys(AFTER_RESET), ...BUMPED, ...KEPT].sort(),
  );
});

test('#154-18: the two counters go up, so anything still loading knows it was left behind', () => {
  const h = dirty(connected());
  h.fn.resetProjectScopedState();
  assert.equal(h.state.projectEpoch, 6);
  assert.equal(h.state.descLoadToken, 10);
});

test('#154-19: the project\'s cached answers and its permissions are dropped too', async () => {
  const h = connected({
    api: {
      getProjectInfo: async () => ({ data: { attributes: {} } }),
      listProjectUsers: async () => MEMBERS,
      readonlyAccess: () => true,
      jwtAvailable: () => true,
    },
  });
  await h.fn.loadProjectInfo();
  await h.fn.loadProjectUsers();
  h.fn.applyCapabilities();
  h.capabilities.jwt = true;
  assert.ok(h.peek().projectInfo && h.peek().usersMap, 'the fixture really cached something');
  assert.equal(h.capabilities.readonly, true);

  h.fn.resetProjectScopedState();
  const kept = h.peek();
  assert.equal(kept.projectInfo, null);
  assert.equal(kept.projectInfoPromise, null);
  assert.equal(kept.usersMap, null);
  assert.equal(kept.usersList, null);
  assert.equal(kept.usersPromise, null);
  assert.equal(kept.readonlyProbe, null);
  assert.equal(h.capabilities.jwt, false);
  assert.equal(h.capabilities.readonly, false);
  assert.equal(h.intervals(), 0, 'the read-only re-check belonged to the project we left');
});

test('#154-20: a switch during boot, before the rest of the panel exists, does not crash', () => {
  const h = dirty(connected({ omit: ['resetTabCounts', 'CommentDrafts', 'syncStop'] }));
  assert.doesNotThrow(() => h.fn.resetProjectScopedState());
  assert.equal(h.state.runId, null, 'and it still did the clearing');
});

test('#154-21: the tab counts, the unsent comments and the run poll are each stopped once', () => {
  const h = dirty(connected());
  h.fn.resetProjectScopedState();
  assert.equal(h.spies.resetTabCounts.count(), 1);
  assert.equal(h.spies.CommentDrafts.count(), 1);
  assert.equal(h.spies.syncStop.count(), 1);
});

test('#154-22: results waiting to be sent are NOT thrown away by a project switch', () => {
  const queued = [{ id: 'q1', host: 'app.testomat.io', projectId: 'p1' },
    { id: 'q2', host: 'app.testomat.io', projectId: 'p2' }];
  const touched = [];
  const OfflineQueue = {
    entries: queued,
    count: () => { touched.push('count'); return queued.length; },
    clear: () => { touched.push('clear'); queued.length = 0; },
    replay: () => { touched.push('replay'); },
  };
  const h = dirty(connected({ globals: { OfflineQueue } }));
  h.fn.resetProjectScopedState();
  assert.equal(queued.length, 2, 'each queued result carries its own host and project stamp');
  assert.deepEqual(touched, [], 'the switch does not reach for the queue at all');
  // The rest of the switch did happen — the untouched queue is not an untouched harness.
  assert.equal(h.state.runId, null);
  assert.equal(h.spies.syncStop.count(), 1);
});

// ---- D: may this connection write? -----------------------------------------

test('#154-23: a panel that has not proven anything yet shows no warning', () => {
  const h = connected({ api: { jwtAvailable: () => 'unknown' } });
  h.fn.applyCapabilities();
  assert.equal(h.doc.body.dataset.jwt, 'unknown');
  assert.equal(h.doc.getElementById('jwt-hint').hidden, true);
});

test('#154-24: once the session is proven gone, the degraded hint appears', () => {
  const h = connected({ api: { jwtAvailable: () => false } });
  h.fn.applyCapabilities();
  assert.equal(h.doc.body.dataset.jwt, 'degraded');
  assert.equal(h.doc.getElementById('jwt-hint').hidden, false);
  // …and a working session marks the panel available again.
  const good = connected({ api: { jwtAvailable: () => true } });
  good.fn.applyCapabilities();
  assert.equal(good.doc.body.dataset.jwt, 'available');
  assert.equal(good.doc.getElementById('jwt-hint').hidden, true);
});

test('#154-25: a read-only account locks the panel, repaints it, and starts watching', () => {
  const h = connected({ api: { readonlyAccess: () => true } });
  h.fn.applyCapabilities();
  assert.equal(h.capabilities.readonly, true);
  assert.equal(h.intervals(), 1);
  assert.deepEqual(h.timers.armed, [h.READONLY_RECHECK_MS]);
  assert.equal(h.spies.applyReadonlyBlock.count(), 1);
  assert.equal(h.spies.updateDegradedBanner.count(), 1);
});

test('#154-26: repainting the panel does not stack up a second re-check', () => {
  const h = connected({ api: { readonlyAccess: () => true } });
  h.fn.applyCapabilities();
  h.fn.applyCapabilities();
  h.fn.applyCapabilities();
  assert.equal(h.intervals(), 1);
  assert.equal(h.timers.armed.length, 1);
});

test('#154-27: a panel with nothing connected has nothing to re-check', () => {
  const h = loadState();
  h.capabilities.readonly = true;
  h.state.settings = null;
  h.fn.startReadonlyWatch();
  assert.equal(h.intervals(), 0);
  h.state.settings = { ...CONNECTED };
  h.fn.startReadonlyWatch();
  assert.equal(h.intervals(), 1, 'with a project open it does arm');
});

test('#154-28: a permission the panel already knows is not asked about again', async () => {
  const h = connected({ api: { readonlyAccess: () => false, jwtAvailable: () => true } });
  await h.fn.probeReadonly();
  assert.equal(h.api.count('validate'), 0);
  assert.equal(h.doc.body.dataset.jwt, 'available', 'the panel was still repainted');
  // The same probe on an unknown permission does ask.
  const unknown = connected();
  await unknown.fn.probeReadonly();
  assert.equal(unknown.api.count('validate'), 1);
});

test('#154-29: two screens opening at once ask about the permission once between them', async () => {
  const gate = deferred();
  const h = connected({ api: { validate: () => gate.promise } });
  const both = Promise.all([h.fn.probeReadonly(), h.fn.probeReadonly()]);
  await settle();
  assert.equal(h.api.count('validate'), 1);
  gate.resolve(true);
  await both;
  assert.equal(h.peek().readonlyProbe, null, 'and the memo is released once it settles');
});

test('#154-D1: the gate answers whether this project is locked, once the probe has settled',
  async () => {
    const locked = connected({ api: { readonlyAccess: () => true } });
    assert.equal(await locked.fn.readonlyGate(), true);
    const open = connected({ api: { readonlyAccess: () => false } });
    assert.equal(await open.fn.readonlyGate(), false);
  });

test('#154-30: while the panel is not in front of the tester nothing is re-checked', async () => {
  const h = connected({ api: { readonlyAccess: () => true } });
  h.fn.applyCapabilities();
  h.doc.visibilityState = 'hidden';
  await h.tick();
  assert.equal(h.api.count('recheckAccess'), 0);
  h.doc.visibilityState = 'visible';
  await h.tick();
  assert.equal(h.api.count('recheckAccess'), 1, 'and the beat resumes when it comes back');
});

test('#154-31: a re-check that finds the lockout already lifted shuts itself down', async () => {
  const h = connected({ api: { readonlyAccess: () => true } });
  h.fn.applyCapabilities();
  assert.equal(h.intervals(), 1);
  h.capabilities.readonly = false; // cleared by some path that never passed applyCapabilities
  await h.fn.recheckReadonly();
  assert.equal(h.intervals(), 0);
  assert.equal(h.api.count('recheckAccess'), 0, 'no point asking about a lockout that is gone');
});

test('#154-32: the moment the account can write again, the panel unlocks and reloads the screen',
  async () => {
    const h = connected({ api: { readonlyAccess: () => true } });
    h.fn.applyCapabilities();
    h.api.impl.recheckAccess = async () => { h.api.impl.readonlyAccess = () => false; };
    await h.tick();
    assert.equal(h.capabilities.readonly, false);
    assert.equal(h.intervals(), 0, 'the watch stops itself');
    assert.equal(h.spies.refreshCurrentView.count(), 1);
    assert.equal(h.spies.applyReadonlyBlock.count(), 2, 'the lockout panel is repainted');
  });

test('#154-D2: a re-check that still finds the account read-only changes nothing', async () => {
  const h = connected({ api: { readonlyAccess: () => true } });
  h.fn.applyCapabilities();
  await h.tick();
  assert.equal(h.api.count('recheckAccess'), 1);
  assert.equal(h.capabilities.readonly, true);
  assert.equal(h.intervals(), 1, 'still watching');
  assert.equal(h.spies.refreshCurrentView.count(), 0);
});

// ---- E: the session probe --------------------------------------------------

test('#154-40: with no test to prefetch the panel just repaints itself', async () => {
  const h = connected({ api: { jwtAvailable: () => true } });
  await h.fn.probeSession(null);
  assert.equal(h.api.count('jwtRequest'), 0);
  assert.equal(h.doc.body.dataset.jwt, 'available');
});

test('#154-41: a prefetch that fails leaves the last answer alone and degrades quietly', async () => {
  const h = connected({
    api: { jwtRequest: async () => { throw new Error('401'); }, jwtAvailable: () => false },
  });
  h.state.testrunDetail = { data: { id: 'previous' } };
  await assert.doesNotReject(h.fn.probeSession('12'));
  assert.equal(plain(h.state.testrunDetail).data.id, 'previous');
  assert.equal(h.capabilities.jwt, false);
  assert.equal(h.doc.body.dataset.jwt, 'degraded');
});

test('#154-E1: a prefetch that works stores the detail and marks the session available', async () => {
  const h = connected({
    api: { jwtRequest: async () => ({ data: { id: '12' } }), jwtAvailable: () => true },
  });
  await h.fn.probeSession('12 b');
  assert.deepEqual(plain(h.api.argsOf('jwtRequest')), [['/testruns/12%20b']]);
  assert.equal(plain(h.state.testrunDetail).data.id, '12');
  assert.equal(h.capabilities.jwt, true);
});

// ---- F: what a failed request looks like to the tester ---------------------

// Every route the tester can land on, as one readable object.
const routed = (h) => ({
  inline: plain(h.spies.setAuthExpiredLine.calls),
  settingsForm: h.spies.fillSettingsForm.count(),
  shown: plain(h.spies.show.calls),
  lines: plain(h.spies.setStatusLine.calls),
  toasts: plain(h.spies.toast.calls),
});
const NOTHING = { inline: [], settingsForm: 0, shown: [], lines: [], toasts: [] };

test('#154-33: a read-only refusal is not reported as an error — the lockout panel says it',
  () => {
    const h = connected({ api: { readonlyAccess: () => true } });
    h.fn.handleApiError({ kind: 'readonly' }, 'run-status');
    assert.deepEqual(routed(h), NOTHING);
    assert.equal(h.spies.applyReadonlyBlock.count(), 1, 'the lockout panel was repainted instead');
    // An ordinary failure through the same panel does reach the tester.
    h.fn.handleApiError({ kind: 'network', message: 'Failed to fetch' }, 'run-status');
    assert.deepEqual(plain(h.spies.setStatusLine.calls),
      [['run-status', 'Failed to fetch', 'error']]);
  });

test('#154-34: a session that expired mid-run says so in the run, without throwing them out', () => {
  const h = connected();
  h.fn.handleApiError({ kind: 'auth', message: 'Session expired' }, 'test-status', { inlineAuth: true });
  assert.deepEqual(routed(h), { ...NOTHING, inline: [['test-status']] });
});

test('#154-35: a session that expired on the way in lands on Settings, in the server\'s words',
  () => {
    const h = connected();
    h.fn.handleApiError({ kind: 'auth', message: 'Token rejected' }, 'run-status');
    assert.deepEqual(routed(h), {
      inline: [], settingsForm: 1, shown: [['settings']],
      lines: [['settings-status', 'Token rejected', 'error']], toasts: [],
    });
  });

test('#154-36: an inline message with nowhere to put it becomes the Settings bounce instead', () => {
  const h = connected();
  h.fn.handleApiError({ kind: 'auth', message: 'Session expired' }, null, { inlineAuth: true });
  assert.deepEqual(routed(h), {
    inline: [], settingsForm: 1, shown: [['settings']],
    lines: [['settings-status', 'Session expired', 'error']], toasts: [],
  });
});

test('#154-37: a request that never reached the server writes a red line under the list', () => {
  const h = connected();
  h.fn.handleApiError({ kind: 'network', message: 'Failed to fetch' }, 'runs-status');
  assert.deepEqual(routed(h), { ...NOTHING, lines: [['runs-status', 'Failed to fetch', 'error']] });
});

test('#154-38: a failure with no field to sit under is toasted instead', () => {
  const h = connected();
  h.fn.handleApiError(new Error('boom'), null);
  assert.deepEqual(routed(h), { ...NOTHING, toasts: [['boom', { error: true }]] });
  h.fn.handleApiError({ toString: () => 'odd' }, null);
  assert.deepEqual(plain(h.spies.toast.calls),
    [['boom', { error: true }], ['odd', { error: true }]], 'even a bare value is toasted');
});

test('#154-38b: a genuine failure toasts in the error style, not as ordinary news', () => {
  const h = connected();
  h.fn.handleApiError(new Error('boom'), null);
  // The red variant: the alert icon and role="alert", the same as every sibling branch asks for.
  assert.deepEqual(plain(h.spies.toast.calls[0][1]), { error: true });
  // Not glued onto everything that comes through: a read-only refusal is still no error at all.
  h.fn.handleApiError({ kind: 'readonly' }, null);
  assert.equal(h.spies.toast.count(), 1);
});

test('#154-39: a panel that lost its settings is treated exactly like an expired session', () => {
  const h = connected();
  h.fn.handleApiError({ kind: 'unconfigured', message: 'Not configured' }, 'x');
  assert.deepEqual(routed(h), {
    inline: [], settingsForm: 1, shown: [['settings']],
    lines: [['settings-status', 'Not configured', 'error']], toasts: [],
  });
  assert.equal(loadState().isAuthError({ kind: 'unconfigured' }), true);
  assert.equal(loadState().isAuthError({ kind: 'network' }), false);
  assert.equal(loadState().isReadonlyError({ kind: 'readonly' }), true);
  assert.equal(loadState().isAuthError(undefined), false);
});
