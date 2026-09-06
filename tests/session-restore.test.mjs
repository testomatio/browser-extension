#!/usr/bin/env node
// extension/sidepanel/core/session-restore.js (#201): what a reopened panel is allowed to believe.
// Two different kinds of untrusted input meet here. The stored session is JSON an OLDER panel wrote
// — a key it never had, a key it spelled differently, a value the current build would never write —
// and every field of it lands straight on `state`, so a guard that gives way puts the panel into a
// shape no screen expects. The editor's `tcReturn` breadcrumb is worse than untrusted: it is a
// one-shot, and spending it twice means the tester who came back from the editor once is dragged
// back to that suite on every reload afterwards.
// Both halves are cheap to get wrong in a way nothing notices, because the wrong answer is a
// plausible screen. So each guard is driven from BOTH sides: the bad value that must be replaced,
// and the good value that must survive — a guard stuck shut looks exactly like a guard that works
// until you ask it to let something through.
// `fromStored` is pure and takes the filter keys as an argument, so it loads into a sandbox with
// NOTHING in it. `takeTcReturn` gets a sessionStorage fake and nothing else.
// Run: node --test tests/session-restore.test.mjs
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_SRC } from './helpers/panel-harness.mjs';
import { loadInto, plain } from './helpers/shared-harness.mjs';

const FILE = join(CORE_SRC, 'session-restore.js');

// The panel's own set, spelled out rather than loaded: screens/runs-list.js:18 builds it from
// RUN_FILTERS, and reaching that would mean booting a screen this module deliberately does not need.
const FILTER_KEYS = new Set(['all', 'passed', 'failed', 'running', 'scheduled', 'terminated']);

const DEFAULTS = {
  stepTicks: {}, expandedGroups: [], runsFilter: 'all', runInfoOpen: true, tabViews: {}, activeTab: null,
};

// The empty sandbox IS the assertion: `{}` is every global this module gets, so no stub of the
// panel's can hold a row up. What the vm realm brings — JSON, Array — is the language, not the panel.
const loadPure = () => loadInto({}, [[FILE, 'SessionRestore']]).value;

function fakeSessionStorage(seed = {}, fails = {}) {
  const data = { ...seed };
  const calls = [];
  return {
    data,
    calls,
    api: {
      getItem(k) {
        calls.push(['getItem', k]);
        if (fails.getItem) throw new Error('sessionStorage is unavailable');
        return k in data ? data[k] : null; // the browser answers a missing key with null, not undefined
      },
      removeItem(k) {
        calls.push(['removeItem', k]);
        if (fails.removeItem) throw new Error('sessionStorage is unavailable');
        delete data[k];
      },
    },
  };
}

function loadWithStorage(seed = {}, fails = {}) {
  const store = fakeSessionStorage(seed, fails);
  const SessionRestore = loadInto({ sessionStorage: store.api }, [[FILE, 'SessionRestore']]).value;
  return { SessionRestore, store };
}

const removals = (store) => store.calls.filter(([op]) => op === 'removeItem').map(([, k]) => k);

// ---------- fromStored(): the defaults ----------

test('SR12z (#201): nothing stored at all is the full set of defaults, so every row below is a change from a known floor', () => {
  const SessionRestore = loadPure();
  assert.deepEqual(plain(SessionRestore.fromStored(undefined, FILTER_KEYS)), DEFAULTS);
  assert.deepEqual(plain(SessionRestore.fromStored({}, FILTER_KEYS)), DEFAULTS);
});

// ---------- fromStored(): runsFilter ----------

test('SR12 (#201): a runsFilter the build no longer ships falls back to `all`, not to an empty chip row', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ runsFilter: 'bogus' }, FILTER_KEYS).runsFilter, 'all');
});

// The other side of the same guard: a guard that answered 'all' to everything would pass the row
// above and quietly forget the chip every tester who filters has set.
test('SR12b (#201): a filter the build does ship survives the guard untouched', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ runsFilter: 'failed' }, FILTER_KEYS).runsFilter, 'failed');
});

// The keys are an ARGUMENT — that is the whole reason this file loads with no stubs. A module that
// carried its own copy of the list would pass both rows above and this one is what notices.
test('SR12c (#201): the vocabulary is the caller\'s — a key only the passed-in set knows still gets through', () => {
  const SessionRestore = loadPure();
  const keys = new Set(['flaky']);
  assert.equal(SessionRestore.fromStored({ runsFilter: 'flaky' }, keys).runsFilter, 'flaky');
  assert.equal(SessionRestore.fromStored({ runsFilter: 'all' }, keys).runsFilter, 'all',
    'and a key the panel ships but this set does not is refused like any other');
});

// ---------- fromStored(): expandedGroups ----------

test('SR13 (#201): expandedGroups that is not an array becomes one — the run list iterates it', () => {
  const SessionRestore = loadPure();
  assert.deepEqual(plain(SessionRestore.fromStored({ expandedGroups: 'x' }, FILTER_KEYS).expandedGroups), []);
});

test('SR13b (#201): a real array of group ids is handed straight back, folds and all', () => {
  const SessionRestore = loadPure();
  const groups = ['g1', 'g2'];
  const out = SessionRestore.fromStored({ expandedGroups: groups }, FILTER_KEYS);
  assert.equal(out.expandedGroups, groups, 'the very array, not a copy — state takes ownership of it');
});

// ---------- fromStored(): runInfoOpen ----------

test('SR14 (#201): a session with no runInfoOpen key opens the Run info card — the default is open', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({}, FILTER_KEYS).runInfoOpen, true);
});

test('SR14b (#201): a tester who closed the card keeps it closed across the reload', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ runInfoOpen: false }, FILTER_KEYS).runInfoOpen, false);
});

// `!== false`, not truthiness: the closed state is one exact value, so every other falsy thing an
// older panel might have written is "no answer given" and lands on the default.
test('SR14c (#201): only an exact `false` closes it — 0 and the string "false" are not that answer', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ runInfoOpen: 0 }, FILTER_KEYS).runInfoOpen, true);
  assert.equal(SessionRestore.fromStored({ runInfoOpen: 'false' }, FILTER_KEYS).runInfoOpen, true);
  assert.equal(SessionRestore.fromStored({ runInfoOpen: null }, FILTER_KEYS).runInfoOpen, true);
});

// ---------- fromStored(): tabViews ----------

test('SR15 (#201): a null tabViews becomes an empty map, so the first tab switch has something to write into', () => {
  const SessionRestore = loadPure();
  assert.deepEqual(plain(SessionRestore.fromStored({ tabViews: null }, FILTER_KEYS).tabViews), {});
});

// `null` is caught by the truthiness check alone; a non-empty STRING is what the `typeof` half is
// for, and without this row that half could go without anything noticing.
test('SR15b (#201): a truthy tabViews that is not an object is still an empty map', () => {
  const SessionRestore = loadPure();
  assert.deepEqual(plain(SessionRestore.fromStored({ tabViews: 'runs' }, FILTER_KEYS).tabViews), {});
});

test('SR15c (#201): a real per-tab map comes back, so each tab reopens on the view it was left on', () => {
  const SessionRestore = loadPure();
  const tabViews = { runs: 'run', tests: 'tclist' };
  assert.equal(SessionRestore.fromStored({ tabViews }, FILTER_KEYS).tabViews, tabViews);
});

// ---------- fromStored(): the activeTab inference ----------

test('SR16 (#201): an old session with no activeTab but a run on screen infers the runs tab', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ view: 'run' }, FILTER_KEYS).activeTab, 'runs');
});

// A test view lives under the runs tab too — inferring only from 'run' would drop a tester out of
// the test they were mid-way through and back onto the list.
test('SR16b (#201): a persisted test view infers the runs tab as well, not just a run view', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ view: 'test' }, FILTER_KEYS).activeTab, 'runs');
});

test('SR16c (#201): a view that belongs to no tab infers nothing — boot falls through to the runs list', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ view: 'tclist' }, FILTER_KEYS).activeTab, null);
  assert.equal(SessionRestore.fromStored({ view: 'settings' }, FILTER_KEYS).activeTab, null);
});

test('SR16d (#201): a session that recorded its tab is believed over anything inferred from the view', () => {
  const SessionRestore = loadPure();
  assert.equal(SessionRestore.fromStored({ activeTab: 'tests', view: 'run' }, FILTER_KEYS).activeTab, 'tests');
  assert.equal(SessionRestore.fromStored({ activeTab: 'settings' }, FILTER_KEYS).activeTab, 'settings');
});

// ---------- takeTcReturn() ----------

test('SR18 (#201): the editor breadcrumb is handed over once and burnt — a later plain reload gets nothing', () => {
  const { SessionRestore, store } = loadWithStorage({
    tcReturn: JSON.stringify({ suiteId: 's-42', suiteTitle: 'Checkout' }),
  });
  assert.deepEqual(plain(SessionRestore.takeTcReturn()), { suiteId: 's-42', suiteTitle: 'Checkout' });
  assert.deepEqual(removals(store), ['tcReturn']);
  assert.equal('tcReturn' in store.data, false, 'gone from the store, not merely asked for');
  assert.equal(SessionRestore.takeTcReturn(), null, 'the second boot is a plain one');
});

test('SR18b (#201): a breadcrumb with no title still returns — the suite id is what opens the list', () => {
  const { SessionRestore, store } = loadWithStorage({ tcReturn: JSON.stringify({ suiteId: 's-42' }) });
  assert.deepEqual(plain(SessionRestore.takeTcReturn()), { suiteId: 's-42' });
  assert.deepEqual(removals(store), ['tcReturn']);
});

test('SR19 (#201): malformed JSON is a null, swallowed — boot carries on to the restored session', () => {
  const { SessionRestore, store } = loadWithStorage({ tcReturn: '{"suiteId":' });
  assert.equal(SessionRestore.takeTcReturn(), null);
  assert.deepEqual(removals(store), [], 'nothing to burn: the crumb was never understood');
});

test('SR19b (#201): no breadcrumb at all is a null, and the store is left alone', () => {
  const { SessionRestore, store } = loadWithStorage();
  assert.equal(SessionRestore.takeTcReturn(), null);
  assert.deepEqual(removals(store), []);
});

// Today's behaviour, pinned rather than praised: the removal is inside the `suiteId` check, so a
// crumb without one is neither used nor cleared. It is inert — openTcListView is never reached.
test('SR19c (#201): a breadcrumb with no suiteId opens nothing, and is left where it lies', () => {
  const { SessionRestore, store } = loadWithStorage({ tcReturn: JSON.stringify({ suiteTitle: 'Checkout' }) });
  assert.equal(SessionRestore.takeTcReturn(), null);
  assert.deepEqual(removals(store), []);
  assert.equal('tcReturn' in store.data, true);
});

test('SR19d (#201): a sessionStorage that refuses to be read is a null, not a boot that dies on it', () => {
  const { SessionRestore } = loadWithStorage({ tcReturn: JSON.stringify({ suiteId: 's-42' }) }, { getItem: true });
  assert.equal(SessionRestore.takeTcReturn(), null);
});

test('SR19e (#201): a removal that throws still hands the suite over — the tester lands where they left', () => {
  const { SessionRestore } = loadWithStorage(
    { tcReturn: JSON.stringify({ suiteId: 's-42', suiteTitle: 'Checkout' }) }, { removeItem: true },
  );
  assert.deepEqual(plain(SessionRestore.takeTcReturn()), { suiteId: 's-42', suiteTitle: 'Checkout' });
});

// ---------- the four rules that stayed in app.js ----------

// All four live between `init()`'s awaits, and app.js's last line is `init().finally(...)`: loading
// the file to reach them runs the whole boot. They are recorded in #352, not solved here.

test.todo('SR17 (#201): a handoff run outranks an open-run intent, which outranks the editor breadcrumb, which outranks the restored session — the order is four early returns inside init(), unreachable without booting the panel (#352)');

test.todo('SR20 (#201): a restored test view whose currentRecordId no longer resolves opens the run and stops — the guard is recordFor() against a loaded run, which needs the whole boot to exist (#352)');

test.todo('SR21 (#201): a boot with no saved settings drops the pending open-run intent before landing on Settings — the branch is inside init(), above every seam this file can load (#352)');

test.todo('SR22 (#201): an init() that throws anywhere still runs Skeleton.bootDone(), so the boot placeholder never sticks — asserting it means loading app.js, which is exactly what runs init() (#352)');
