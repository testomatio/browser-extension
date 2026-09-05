#!/usr/bin/env node
// What re-opening the panel puts back on screen (#155): the boot read, the one-time move to
// per-host settings, the two dead secrets swept off the machine, and the exact ten fields the
// session carries. Run: node --test tests/storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStorage, plain, settle } from './helpers/core-harness.mjs';

const LEGACY = { baseUrl: 'https://a.io', apiToken: 't', projectId: 'p1' };

// Every write the module made, in order.
const sets = (h) => h.store.ops('set');
const removes = (h) => h.store.ops('remove').map((c) => c.arg);

// A live run view: what the panel looks like when the tester has a run open.
function live(h) {
  Object.assign(h.state, {
    settings: LEGACY,
    booting: false,
    view: 'run',
    activeTab: 'runs',
    tabViews: { runs: 'run', tests: 'tclist' },
    runId: 'r7',
    runTitle: 'Smoke',
    currentRecordId: 'rec9',
    stepTicks: { rec9: { 0: true, 2: true } },
    expandedGroups: ['g1', 'g2'],
    runsFilter: 'failed',
  });
  return h;
}

// ---- A: the boot read ------------------------------------------------------

test('#155-1: with no browser storage behind it the panel boots from nothing and asks for nothing',
  async () => {
    const off = loadStorage({ hasChrome: false });
    assert.deepEqual(plain(await off.fn.loadStored()), {});
    assert.deepEqual(off.store.calls, [], 'a panel with no chrome must not reach for storage');
    // The same harness with chrome present does read — the silence above is the panel's, not the fake's.
    const on = loadStorage({ seed: { settings: LEGACY } });
    assert.deepEqual(plain(await on.fn.loadStored()), { settings: LEGACY });
    assert.equal(on.store.ops('get').length, 1);
  });

test('#155-2: the boot read asks for the four saved slices and nothing else', async () => {
  const h = loadStorage();
  await h.fn.loadStored();
  assert.deepEqual(h.store.ops('get').map((c) => c.arg),
    [['settings', 'session', 'hostSettings', 'hostHistory']]);
});

// ---- B: the move to per-host settings --------------------------------------

test('#155-3: an install already on the per-host map is left exactly as it is', async () => {
  const h = loadStorage();
  const hostSettings = { 'a.io': LEGACY };
  await h.fn.migrateHostSettings({ hostSettings, hostHistory: ['a.io'] });
  assert.deepEqual(plain(h.state.hostSettings), hostSettings);
  assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
  assert.deepEqual(sets(h), [], 'nothing changed, so nothing is written back');
});

test('#155-4: an old single-instance install becomes that host\'s entry, saved once', async () => {
  const h = loadStorage();
  await h.fn.migrateHostSettings({ settings: LEGACY });
  assert.deepEqual(plain(h.state.hostSettings), { 'a.io': LEGACY });
  assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
  assert.equal(sets(h).length, 1, 'the migration is written once');
  assert.deepEqual(sets(h)[0].arg, { hostSettings: { 'a.io': LEGACY }, hostHistory: ['a.io'] });
});

test('#155-5: a saved instance whose address is not an address migrates to nothing', async () => {
  const h = loadStorage();
  await h.fn.migrateHostSettings({ settings: { baseUrl: 'garbage' } });
  assert.deepEqual(plain(h.state.hostSettings), {});
  assert.deepEqual(plain(h.state.hostHistory), []);
  assert.deepEqual(sets(h), [], 'a host that cannot be named is not a key to save under');
  // …while a real address in the same harness does migrate and does write.
  await h.fn.migrateHostSettings({ settings: LEGACY });
  assert.equal(sets(h).length, 1);
});

test('#155-6: a first-ever boot lands on an empty map and an empty history', async () => {
  const h = loadStorage();
  await h.fn.migrateHostSettings({});
  assert.deepEqual(plain(h.state.hostSettings), {});
  assert.deepEqual(plain(h.state.hostHistory), []);
  assert.deepEqual(sets(h), []);
});

test('#155-7: saved slices of the wrong shape are refused rather than adopted', async () => {
  const h = loadStorage();
  await h.fn.migrateHostSettings({ hostSettings: 'nope', hostHistory: 'nope' });
  assert.deepEqual(plain(h.state.hostSettings), {});
  assert.deepEqual(plain(h.state.hostHistory), []);
});

test('#155-8: an empty per-host map counts as already migrated, so the old settings stay behind',
  async () => {
    const h = loadStorage();
    await h.fn.migrateHostSettings({ hostSettings: {}, settings: LEGACY });
    assert.deepEqual(plain(h.state.hostSettings), {}, 'an empty object is truthy — no second migration');
    assert.deepEqual(plain(h.state.hostHistory), []);
    assert.deepEqual(sets(h), []);
  });

test('#155-9: outside a browser the migration still happens in memory, it is just not saved',
  async () => {
    const h = loadStorage({ hasChrome: false });
    await h.fn.migrateHostSettings({ settings: LEGACY });
    assert.deepEqual(plain(h.state.hostSettings), { 'a.io': LEGACY });
    assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
    assert.deepEqual(h.store.calls, [], 'no storage to write to');
  });

// ---- C: the two dead secrets -----------------------------------------------

test('#155-10: a storage that refuses to delete does not break the boot', async () => {
  const h = loadStorage();
  h.store.fails.remove = new Error('storage is busy');
  await h.fn.dropAiApiKey();
  await h.fn.dropOnboardingState();
  assert.equal(h.store.ops('remove').length, 2, 'both sweeps were attempted');
  // And with the failure lifted the same calls really do delete — the swallow is not a no-op.
  h.store.fails.remove = null;
  const live2 = loadStorage({ seed: { aiApiKey: 'sk-live', onboarding: { step: 2 } } });
  await live2.fn.dropAiApiKey();
  await live2.fn.dropOnboardingState();
  assert.deepEqual(Object.keys(live2.store.data), []);
});

test('#155-11: every boot deletes the retired AI key and the retired checklist, once each',
  async () => {
    const h = loadStorage({ seed: { aiApiKey: 'sk-live', onboarding: { step: 2 }, settings: LEGACY } });
    await h.fn.dropAiApiKey();
    await h.fn.dropOnboardingState();
    assert.deepEqual(removes(h), ['aiApiKey', 'onboarding']);
    assert.deepEqual(Object.keys(h.store.data), ['settings'], 'the tester\'s own settings survive');
    // Outside a browser neither sweep is even attempted.
    const off = loadStorage({ hasChrome: false });
    await off.fn.dropAiApiKey();
    await off.fn.dropOnboardingState();
    assert.deepEqual(off.store.calls, []);
  });

// ---- D: what the session write carries -------------------------------------

test('#155-12: nothing is saved while the panel is still starting up', async () => {
  const h = live(loadStorage());
  h.state.booting = true;
  h.fn.persistSession();
  await settle();
  assert.deepEqual(sets(h), [], 'a boot-time write can resurrect a session the reopen just cleared');
  // The same panel one line later, boot over, does write.
  h.state.booting = false;
  h.fn.persistSession();
  await settle();
  assert.equal(sets(h).length, 1);
});

test('#155-13: nothing is saved before there is a connection to save it against', async () => {
  const h = live(loadStorage());
  h.state.settings = null;
  h.fn.persistSession();
  await settle();
  assert.deepEqual(sets(h), []);
  h.state.settings = LEGACY;
  h.fn.persistSession();
  await settle();
  assert.equal(sets(h).length, 1);
});

test('#155-14: outside a browser there is nowhere to save the session', async () => {
  const off = live(loadStorage({ hasChrome: false }));
  off.fn.persistSession();
  await settle();
  assert.deepEqual(off.store.calls, []);
  const on = live(loadStorage());
  on.fn.persistSession();
  await settle();
  assert.equal(sets(on).length, 1);
});

test('#155-15: the saved session carries exactly ten fields, and this is the list', async () => {
  const h = live(loadStorage());
  h.fn.persistSession();
  await settle();
  assert.equal(sets(h).length, 1);
  const written = sets(h)[0].raw;
  assert.deepEqual(Object.keys(written), ['session']);
  assert.deepEqual(Object.keys(written.session).sort(), [
    'activeTab', 'currentRecordId', 'expandedGroups', 'runId', 'runInfoOpen', 'runTitle',
    'runsFilter', 'stepTicks', 'tabViews', 'view',
  ], 'an unsent comment draft is deliberately NOT one of them');
  assert.deepEqual(sets(h)[0].arg.session, {
    view: 'run',
    activeTab: 'runs',
    tabViews: { runs: 'run', tests: 'tclist' },
    runId: 'r7',
    runTitle: 'Smoke',
    currentRecordId: 'rec9',
    stepTicks: { rec9: { 0: true, 2: true } },
    expandedGroups: ['g1', 'g2'],
    runsFilter: 'failed',
    runInfoOpen: true,
  });
});

test('#155-16: closing the Run info panel is remembered as closed', async () => {
  const h = live(loadStorage());
  h.setRunInfoOpen(false);
  h.fn.persistSession();
  await settle();
  assert.equal(sets(h)[0].arg.session.runInfoOpen, false);
});

test('#155-17: without screens/run-info.js in the page the save throws instead of saving', () => {
  const h = live(loadStorage({ withRunInfo: false }));
  assert.throws(() => h.fn.persistSession(), (e) => e.name === 'ReferenceError');
  // The same call with the module present goes through — the throw is the missing global, not the fixture.
  const ok = live(loadStorage());
  assert.doesNotThrow(() => ok.fn.persistSession());
});

test('#194-17a: the saved key is spelled `runInfoOpen`, off the module\'s own accessor', async () => {
  const h = live(loadStorage());
  // Not the harness's copy of the default: the module is the shipped one, opened by nobody yet.
  assert.equal(h.RunInfo.open, true);
  h.RunInfo.open = false;
  h.fn.persistSession();
  await settle();
  const session = sets(h)[0].arg.session;
  assert.ok('runInfoOpen' in session, 'a renamed key loses every existing profile\'s choice');
  assert.equal(session.runInfoOpen, false);
  assert.equal('open' in session, false, 'the module\'s name for it is not the storage key');
});

// The five guards app.js:147-152 reads the saved session back through, copied here because loading
// app.js would boot the whole panel. FILTER_KEYS is screens/runs-list.js:18.
const FILTER_KEYS = new Set(['all', 'passed', 'failed', 'running', 'scheduled', 'terminated']);
const restore = (session) => ({
  stepTicks: session?.stepTicks || {},
  expandedGroups: Array.isArray(session?.expandedGroups) ? session.expandedGroups : [],
  runsFilter: FILTER_KEYS.has(session?.runsFilter) ? session.runsFilter : 'all',
  runInfoOpen: session?.runInfoOpen !== false,
  tabViews: (session && session.tabViews && typeof session.tabViews === 'object') ? session.tabViews : {},
});

test('#155-18: what the panel saves is what the next boot puts back on screen', async () => {
  const h = live(loadStorage());
  h.setRunInfoOpen(false);
  h.fn.persistSession();
  await settle();
  assert.deepEqual(restore(sets(h)[0].arg.session), {
    stepTicks: { rec9: { 0: true, 2: true } },
    expandedGroups: ['g1', 'g2'],
    runsFilter: 'failed',
    runInfoOpen: false,
    tabViews: { runs: 'run', tests: 'tclist' },
  });
  // A boot with nothing saved lands on the defaults, so the round trip above is not the guards' doing.
  assert.deepEqual(restore(undefined),
    { stepTicks: {}, expandedGroups: [], runsFilter: 'all', runInfoOpen: true, tabViews: {} });
});
