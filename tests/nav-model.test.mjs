#!/usr/bin/env node
// extension/sidepanel/core/nav-model.js (#202, the first seam out of core/views.js): which tab a
// screen belongs to, what the contextual row titles it, where its web link points, and which screen
// a tab click or a Back lands on.
// The whole value of the module is what it does NOT touch, so the sandbox below is literally `{}` —
// no document, no `$`, no `state`, no console, not even a stub of one. Loading it there proves
// nothing is read at load; CALLING every one of its functions there, which every row does, proves
// nothing is read at call time either. `state` and the record lookup arrive as arguments, and the
// two navigations hand back a DESCRIPTOR (`{show}` / `{open, args}`) rather than calling an opener,
// which is what lets a decision be asserted without a screen behind it.
// tests/views.test.mjs keeps its own 88 rows over the same decisions as core/views.js paints them:
// the duplication is deliberate — these say what the model decides, those say what the panel does.
// Run: node --test tests/nav-model.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_SRC, plain } from './helpers/panel-harness.mjs';

const file = join(CORE_SRC, 'nav-model.js');
// An EMPTY context object: whatever the module reached for would be a ReferenceError right here.
const load = () => runInNewContext(`${readFileSync(file, 'utf8')}\nNavModel;`, {});

const nav = load(); // stateless — one load serves every row

// The panel state each row needs, and nothing more: the model reads it, never writes it.
const st = (over = {}) => ({
  tabViews: {}, runId: null, currentRecordId: null, tcSuiteId: null,
  runTitle: '', testTitle: '', tcSuiteTitle: '', ...over,
});

// ---------- the seam itself ----------

test('N1 (#202): the model loads and answers with no document, no state and no globals at all', () => {
  const fresh = load(); // `{}` is the whole sandbox — see the header
  assert.equal(typeof fresh, 'object');
  assert.equal(fresh.tabOfView('run'), 'runs');
  assert.equal(fresh.contextTitleFor('promote', st()), 'Choose suite');
  assert.deepEqual(plain(fresh.webTarget('run', st({ runId: '9' }))), ['run', 'runs/9']);
  assert.equal(fresh.webHref('https://a.io', 'p1', 'runs/9'), 'https://a.io/projects/p1/runs/9');
  assert.deepEqual(plain(fresh.nextViewForTab('runs', st())), { open: 'runs' });
  assert.deepEqual(plain(fresh.backTargetFor('run', st())), { open: 'runs' });
});

// ---------- the tab a screen belongs to ----------

test('N2 (#202): every screen the panel can show belongs to exactly one of the three tabs', () => {
  assert.deepEqual(plain(nav.TAB_OF_VIEW), {
    tcstudio: 'tests', tclist: 'tests', promote: 'tests',
    runs: 'runs', run: 'runs', test: 'runs',
    settings: 'settings', pick: 'settings',
  });
  assert.deepEqual(plain(nav.TABS), ['tests', 'runs', 'settings']);
  assert.deepEqual(plain(nav.TAB_ROOT), { tests: 'tcstudio', runs: 'runs', settings: 'settings' });
  // The four landing screens: the Back arrow and the title row above it are hidden on these.
  const roots = ['settings', 'pick', 'runs', 'tcstudio', 'tclist', 'promote', 'run', 'test']
    .filter((v) => nav.ROOT_VIEWS.has(v));
  assert.deepEqual(roots, ['settings', 'pick', 'runs', 'tcstudio']);
});

test('N3 (#202): every one of the eight views names its tab, and one nobody knows lands in Runs', () => {
  assert.deepEqual(
    ['tcstudio', 'tclist', 'promote', 'runs', 'run', 'test', 'settings', 'pick'].map((v) => nav.tabOfView(v)),
    ['tests', 'tests', 'tests', 'runs', 'runs', 'runs', 'settings', 'settings'],
  );
  // A bar with no tab lit is a bar the tester cannot read, so the fallback is a real tab.
  assert.equal(nav.tabOfView('bogus'), 'runs');
  assert.equal(nav.tabOfView(undefined), 'runs');
  assert.equal(nav.tabOfView(''), 'runs');
});

// ---------- the title above the Back arrow ----------

test('N4 (#202): the title names the screen from the first frame, before its data has landed', () => {
  const empty = st();
  assert.equal(nav.contextTitleFor('run', empty), 'Run');
  assert.equal(nav.contextTitleFor('test', empty), 'Test');
  assert.equal(nav.contextTitleFor('tclist', empty), 'Suite');
  assert.equal(nav.contextTitleFor('promote', empty), 'Choose suite');
});

test('N5 (#202): once the data lands the title is the thing’s own name; a tab root has none', () => {
  const s = st({ runTitle: 'Nightly', testTitle: 'Login works', tcSuiteTitle: 'Checkout' });
  assert.deepEqual(['run', 'test', 'tclist'].map((v) => nav.contextTitleFor(v, s)),
    ['Nightly', 'Login works', 'Checkout']);
  // The contextual row is hidden on a root, so a title there would never be read anyway.
  for (const root of ['runs', 'tcstudio', 'settings', 'pick', 'bogus']) {
    assert.equal(nav.contextTitleFor(root, s), '', root);
  }
});

// ---------- the way out to the web app ----------

test('N6 (#202): the web link points at the RECORD the tester is reading, not the test case behind it', () => {
  const recordFor = (id) => ({ 55: { test_id: 't7' } })[id] || null;
  const s = st({ runId: '9', currentRecordId: '55' });
  assert.deepEqual(plain(nav.webTarget('test', s, recordFor)), ['test', 'runs/9/test/55'],
    'a parametrized run has many records on one test_id — only the record names the row on screen');

  s.runId = null; // a test opened with no run around it: the case page is the honest target
  assert.deepEqual(plain(nav.webTarget('test', s, recordFor)), ['test', 'test/t7']);
  s.currentRecordId = null;
  assert.equal(nav.webTarget('test', s, recordFor), null, 'and with neither there is nothing to point at');
});

test('N7 (#202): a record lookup the screen has not loaded leaves the test with no target, not a throw', () => {
  const s = st({ currentRecordId: '55' });
  // The lookup belongs to the test screen; core/views.js passes null when that script is absent.
  assert.equal(nav.webTarget('test', s, null), null);
  assert.equal(nav.webTarget('test', s, undefined), null);
  // A record that carries no test_id is the same nothing — an id-less link would be a 404.
  assert.equal(nav.webTarget('test', s, () => ({})), null);
});

test('N8 (#202): a run and a suite each point at their own route, and an id not read back yet at none', () => {
  assert.deepEqual(plain(nav.webTarget('run', st({ runId: '9' }))), ['run', 'runs/9']);
  assert.equal(nav.webTarget('run', st()), null);
  assert.deepEqual(plain(nav.webTarget('tclist', st({ tcSuiteId: 's 1' }))), ['suite', 'suite/s%201'],
    'every id in the path is the public uid, and it is encoded');
  assert.equal(nav.webTarget('tclist', st()), null);
});

test('N9 (#202): a screen the web app has no page for is offered no link — the picker, the roots', () => {
  const s = st({ runId: '9', tcSuiteId: 's1', currentRecordId: '55' });
  for (const view of ['promote', 'runs', 'tcstudio', 'settings', 'pick', 'bogus', undefined]) {
    assert.equal(nav.webTarget(view, s, () => ({ test_id: 't7' })), null, String(view));
  }
});

test('N10 (#202): the link is built off the SAVED base url, trailing slashes gone and the id encoded', () => {
  assert.equal(nav.webHref('https://a.io///', 'p 1', 'runs/9'), 'https://a.io/projects/p%201/runs/9');
  // saveSettings is https-only, Handoff.connect is not — so http is reachable, and emitted as it stands.
  assert.equal(nav.webHref('http://a.io', 'p1', 'runs/9'), 'http://a.io/projects/p1/runs/9');
  assert.equal(nav.webHref('https://a.io/', 'p1', 'suite/s%201'), 'https://a.io/projects/p1/suite/s%201',
    'the path arrives already encoded by webTarget and is not encoded a second time');
});

// ---------- where a tab click lands ----------

test('N11 (#202): coming back to a tab lands on the screen it was left on, as a re-show not a reload', () => {
  assert.deepEqual(plain(nav.nextViewForTab('tests', st({ tabViews: { tests: 'tclist' }, tcSuiteId: 's1' }))),
    { show: 'tclist' }, 're-shown, not re-read: the list it holds survives');
  for (const remembered of ['run', 'test']) {
    assert.deepEqual(plain(nav.nextViewForTab('runs', st({ tabViews: { runs: remembered }, runId: '7' }))),
      { show: remembered }, remembered);
  }
});

test('N12 (#202): a remembered screen whose id has gone lands the tester on the tab’s own root instead', () => {
  assert.deepEqual(plain(nav.nextViewForTab('tests', st({ tabViews: { tests: 'tclist' } }))),
    { open: 'tcstudio' }, 'the suite is not known any more');
  assert.deepEqual(plain(nav.nextViewForTab('runs', st({ tabViews: { runs: 'run' } }))), { open: 'runs' });
  assert.deepEqual(plain(nav.nextViewForTab('runs', st({ tabViews: { runs: 'test' } }))), { open: 'runs' });
});

test('N13 (#202): a tab that has stood nowhere yet opens its root, and Settings always refills its form', () => {
  assert.deepEqual(plain(nav.nextViewForTab('tests', st())), { open: 'tcstudio' });
  assert.deepEqual(plain(nav.nextViewForTab('runs', st())), { open: 'runs' });
  // Settings is opened, never re-shown: opening is what discards the stale edits in the DOM.
  assert.deepEqual(plain(nav.nextViewForTab('settings', st({ tabViews: { settings: 'settings' } }))),
    { open: 'settings' });
});

test('N14 (#202): the suite picker is a step of + New test, never a screen to come back to', () => {
  assert.deepEqual(plain(nav.nextViewForTab('tests', st({ tabViews: { tests: 'promote' }, tcSuiteId: 's1' }))),
    { open: 'tcstudio' });
  // …and neither is the picker's own tab-root screen, or the project-pick that stands before the tabs.
  assert.deepEqual(plain(nav.nextViewForTab('runs', st({ tabViews: { runs: 'runs' }, runId: '7' }))),
    { open: 'runs' });
});

// ---------- the way back ----------

test('N15 (#202): Back walks one step up the same trail the crumbs draw', () => {
  const s = st({ runId: '7', runTitle: 'Nightly' });
  assert.deepEqual(plain(nav.backTargetFor('tclist', s)), { open: 'tcstudio' });
  assert.deepEqual(plain(nav.backTargetFor('promote', s)), { open: 'tcstudio' },
    'cancelling the picker is going back to the tree');
  assert.deepEqual(plain(nav.backTargetFor('test', s)), { open: 'run', args: ['7', 'Nightly'] },
    'the run is re-opened BY id and title, so the row above says the run’s name at once');
  assert.deepEqual(plain(nav.backTargetFor('run', s)), { open: 'runs' });
});

test('N16 (#202): a tab root has nowhere above it, so Back is handed no target at all', () => {
  const s = st({ runId: '7' });
  for (const root of ['runs', 'settings', 'tcstudio', 'pick', 'bogus', undefined]) {
    assert.equal(nav.backTargetFor(root, s), null, `${String(root)} is a tab root — the arrow is hidden there`);
  }
});

test('N17 (#202): Back out of a test whose run id has gone still names the run leg, ids and all', () => {
  // Not the model's call to make: core/views.js hands whatever it holds to openRunView, exactly as
  // the inline branch did — a target invented here would be a different screen, silently.
  assert.deepEqual(plain(nav.backTargetFor('test', st())), { open: 'run', args: [null, ''] });
});
