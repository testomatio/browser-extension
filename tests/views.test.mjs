#!/usr/bin/env node
// The navigation shell — extension/sidepanel/core/views.js — and the first suite it has ever had:
// every other harness in this directory stubs show(), so the one function the whole panel calls on
// every screen change shipped unprobed (#109, and the shell half of epic #141).
// Two things here are easy to get quietly wrong. show() toggles `hidden` on eight sections, which
// drops the caret on the floor — a reader is left narrating the screen the tester just left — so it
// puts the caret on the section it opened; but ONLY where the switch is what took it, or it fights
// the two screens that focus a field of their own (applyConnectMode's token box, run from inside
// show(), and project-pick's filter, run right after it returns). And #tabbar is three tabs over
// EIGHT panels: aria-controls cannot be static markup, because which panel a tab names moves with
// the section that tab is standing on, and a tab that cannot be opened must name none.
// Run: node --test tests/views.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el, fire } from './helpers/panel-harness.mjs';
import { loadInto } from './helpers/shared-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// core/state.js:7, verbatim — the order show() walks when it hides the other seven.
const VIEWS = ['settings', 'pick', 'runs', 'tcstudio', 'tclist', 'promote', 'run', 'test'];
const BAR = ['tests', 'runs', 'settings'];

// index.html's shell (:79-96, :117-131, :147-575), cut to the nodes the switcher touches. The eight
// sections carry the shipped `tabindex="-1"`, which is what makes them able to hold the caret.
function makePage() {
  const doc = makeDocument([]);
  const node = {};
  const mk = (tag, id, props = {}) => { node[id] = el(tag, { id, ...props }); return node[id]; };

  const tabbar = mk('nav', 'tabbar', { role: 'tablist' });
  for (const t of BAR) tabbar.append(mk('button', `tab-${t}`, { className: 'tab', role: 'tab' }));
  const headerTop = mk('div', 'header-top');
  headerTop.append(tabbar, mk('div', 'rec-slot'));

  const projectBar = mk('div', 'project-bar');
  projectBar.append(mk('button', 'btn-refresh'), mk('a', 'project-open'));

  const contextBar = mk('div', 'context-bar');
  contextBar.append(mk('button', 'btn-back'), mk('h1', 'context-title'),
    mk('nav', 'context-crumbs'), mk('a', 'context-open'));

  const main = el('main');
  main.append(mk('section', 'readonly-block', { hidden: true }));
  for (const v of VIEWS) {
    const section = mk('section', `view-${v}`, { hidden: true });
    section.setAttribute('tabindex', '-1');
    main.append(section);
  }
  doc.body.append(headerTop, projectBar, contextBar, mk('div', 'degraded-banner', { hidden: true }), main);
  return { doc, node };
}

// The real Roving, not a stub: the arrows across the bar and the tab stop they leave behind are half
// of what this file is about, and a stub would be answering for both of them.
const roving = () => loadInto({ console }, [['shared/roving.js', 'Roving']]).value;

const SETTINGS = { baseUrl: 'https://app.testomat.io', projectId: 'p1' };

function load(opts = {}) {
  const o = { settings: SETTINGS, readonly: false, jwt: true, ...opts };
  const { doc, node } = makePage();
  const calls = { persists: 0, clicks: [] };

  const state = {
    view: null,
    activeTab: null,
    tabViews: {},
    settings: o.settings,
    runId: null,
    currentRecordId: null,
    tcSuiteId: null,
    runTitle: '',
    testTitle: '',
    testDetailPending: false,
    projectEpoch: 0,
  };

  const globals = {
    state,
    capabilities: { readonly: o.readonly, jwt: o.jwt },
    views: VIEWS,
    Roving: roving(),
    $: (id) => doc.getElementById(id),
    Skeleton: { bootDone: () => {}, hide: () => {} },
    Tooltip: { set: (n, tip) => { if (n) n.dataset.tip = tip; } },
    TestomatAPI: { jwtAvailable: () => o.jwt },
    // core/state.js:101, verbatim.
    isConfigured: () => !!(state.settings && state.settings.projectId),
    persistSession: () => { calls.persists += 1; },
    // The crumb factories name these at BUILD time, not on click — an absent one throws.
    openRunsView: () => {},
    openRunView: () => {},
    openTcStudioView: () => {},
    // core/status-icons.js — the suite mark a tclist title carries.
    StatusIcons: {
      FILE: 'tree_suite',
      treeIcon: (name, cls) => el('span', { className: cls, dataset: { icon: name } }),
    },
  };

  const h = loadScreen('views', {
    dir: CORE_SRC,
    document: doc,
    globals,
    exported: '({ TAB_OF_VIEW, TABS, TAB_ROOT })',
  });

  // Each tab's own click listener, the way app.js wires it: what Enter and Space are allowed to do,
  // and the only place a screen load could come from.
  for (const t of BAR) node[`tab-${t}`].addEventListener('click', () => calls.clicks.push(t));

  return {
    ...h,
    state,
    doc,
    node,
    calls,
    lex: h.screen,
    tab: (t) => node[`tab-${t}`],
    // Every tab's tabindex in bar order — the one shape the roving model is about.
    tabs: () => BAR.map((t) => node[`tab-${t}`].getAttribute('tabindex')),
    controls: () => BAR.map((t) => node[`tab-${t}`].getAttribute('aria-controls')),
    at: () => (doc.activeElement ? doc.activeElement.id || '(no id)' : null),
    // What the tester's finger does: a keydown on the tab that has focus, which bubbles to the bar.
    key: (n, k) => fire(n, 'keydown', { key: k, bubbles: true }),
  };
}

// ---------- where the caret goes ----------

test('V1: a switch that took the caret away hands it to the section it opened', () => {
  const h = load();
  h.fn.show('runs');
  // Where PR-1's roving tab stop leaves it: on a row of the list inside the open section.
  const row = el('li');
  h.node['view-runs'].append(row);
  row.focus();
  assert.equal(h.doc.activeElement, row);

  h.fn.show('run');
  assert.equal(h.at(), 'view-run', 'the caret came along instead of falling to the body');
});

test('V1b: focus on the body, or nowhere at all, is focus the switch has to place', () => {
  const h = load();
  h.doc.body.focus();
  h.fn.show('runs');
  assert.equal(h.at(), 'view-runs');

  const fresh = load();
  assert.equal(fresh.doc.activeElement, null, 'a panel that has only just booted');
  fresh.fn.show('tcstudio');
  assert.equal(fresh.at(), 'view-tcstudio');
});

test('V2: a caret already inside the section being shown is left exactly where it is', () => {
  const h = load();
  h.fn.show('settings');
  const field = el('input', { id: 'set-token' });
  h.node['view-settings'].append(field);
  field.focus();

  h.fn.show('settings'); // a repaint of the screen that is already open
  assert.equal(h.at(), 'set-token', 'not dragged back up to the section');
});

test('V2b: the token field applyConnectMode focuses INSIDE show() keeps the caret', () => {
  const h = load();
  const field = el('input', { id: 'set-token' });
  h.node['view-settings'].append(field);
  // screens/settings.js:224-241's shape: it runs from inside show(), after the sections switched.
  h.fn.applyConnectMode = () => { field.focus(); };

  h.fn.show('settings');
  assert.equal(h.at(), 'set-token', 'show() must not fight the screen it has just opened');
});

test('V2c: project-pick focuses its filter after show() returns, and that is where the tester types', () => {
  const h = load();
  const filter = el('input', { id: 'pick-filter' });
  h.node['view-pick'].append(filter);

  h.fn.show('pick');                       // screens/project-pick.js:100
  assert.equal(h.at(), 'view-pick', 'the section holds it until the screen says otherwise');
  filter.focus();                          // screens/project-pick.js:102
  assert.equal(h.at(), 'pick-filter');
});

test('V2d: a caret on the tab bar stays on the bar — arrowing across it is not being lost', () => {
  const h = load();
  h.fn.show('runs');
  h.tab('tests').focus();
  h.fn.show('tcstudio');
  assert.equal(h.at(), 'tab-tests');
});

// ---------- what a tab says it controls ----------

test('V3: the panel a tab names is the section that tab is standing on right now', () => {
  const h = load();
  h.fn.show('runs');
  assert.deepEqual(h.controls(), ['view-tcstudio', 'view-runs', 'view-settings'],
    'a tab nobody has opened names its landing view');

  h.state.runId = '7';
  h.fn.show('run');
  assert.deepEqual(h.controls(), ['view-tcstudio', 'view-run', 'view-settings']);

  h.state.tcSuiteId = 's1';
  h.fn.show('tclist');
  assert.deepEqual(h.controls(), ['view-tclist', 'view-run', 'view-settings'],
    'and the Runs tab still names the run it is holding');
});

test('V4: a disabled tab names no panel at all — it cannot open one', () => {
  const h = load({ settings: null });
  h.fn.show('settings');
  assert.equal(h.tab('tests').disabled, true);
  assert.deepEqual(h.controls(), [null, null, 'view-settings']);

  // Configured, the two come back naming the section each would show.
  h.state.settings = SETTINGS;
  h.fn.updateTabBar();
  assert.deepEqual(h.controls(), ['view-tcstudio', 'view-runs', 'view-settings']);
});

// ---------- one tab stop for the whole bar ----------

test('V5: the bar is ONE tab stop — the selected tab, and the other two out of Tab’s way', () => {
  const h = load();
  h.fn.show('runs');
  assert.deepEqual(h.tabs(), ['-1', '0', '-1']);

  h.fn.show('settings');
  assert.deepEqual(h.tabs(), ['-1', '-1', '0']);
});

test('V5b: a tab is still a tab — the tab stop is written onto it, not Roving.item’s role="button"', () => {
  const h = load();
  h.fn.show('runs');
  assert.deepEqual(BAR.map((t) => h.tab(t).getAttribute('role')), ['tab', 'tab', 'tab']);
});

test('V6: the arrows walk the bar and select NOTHING — three screen loads is not a way across it', () => {
  const h = load();
  h.fn.show('runs');
  h.key(h.tab('runs'), 'ArrowRight');
  assert.equal(h.at(), 'tab-settings');
  assert.deepEqual(h.calls.clicks, [], 'the caret moved; nothing was activated');
  assert.equal(h.state.activeTab, 'runs');
  assert.equal(h.tab('settings').getAttribute('aria-selected'), 'false');
  assert.deepEqual(h.tabs(), ['-1', '-1', '0'], 'and the tab stop came with the caret');

  h.key(h.tab('settings'), 'ArrowLeft');
  assert.equal(h.at(), 'tab-runs');
});

test('V7: Enter activates a tab ONCE — the keydown is swallowed, so the button cannot click a second time', () => {
  const h = load();
  h.fn.show('runs');
  const ev = h.key(h.tab('settings'), 'Enter');
  assert.deepEqual(h.calls.clicks, ['settings']);
  assert.equal(ev.defaultPrevented, true, 'an unswallowed Enter is a second click, from the button itself');

  const space = h.key(h.tab('tests'), ' ');
  assert.deepEqual(h.calls.clicks, ['settings', 'tests']);
  assert.equal(space.defaultPrevented, true);
});

test('V8: unconfigured, the arrows never put the caret on a disabled tab — it could not hold it', () => {
  const h = load({ settings: null });
  h.fn.show('settings');
  assert.deepEqual(h.tabs(), ['-1', '-1', '0']);
  h.key(h.tab('settings'), 'ArrowLeft');
  assert.equal(h.at(), 'tab-settings', 'Runs is disabled, so there is nothing to the left');
  h.key(h.tab('settings'), 'Home');
  assert.equal(h.at(), 'tab-settings', 'and it is the near end of the bar as well');
  assert.deepEqual(h.calls.clicks, []);

  // Configured, the same two keys walk — so the rows above are about `disabled`, not about the ends.
  const ok = load();
  ok.fn.show('settings');
  ok.key(ok.tab('settings'), 'ArrowLeft');
  assert.equal(ok.at(), 'tab-runs');
  ok.key(ok.tab('runs'), 'Home');
  assert.equal(ok.at(), 'tab-tests');
});

// ---------- the wiring itself ----------

test('V9: the bar is wired once, however many screens the tester walks through', () => {
  const h = load();
  for (const v of ['runs', 'run', 'test', 'runs', 'settings']) h.fn.show(v);
  assert.equal(h.node.tabbar.listeners.get('keydown').length, 1);
  assert.equal(h.node.tabbar.listeners.get('focusin').length, 1);
  h.key(h.tab('tests'), 'Enter');
  assert.deepEqual(h.calls.clicks, ['tests'], 'and one Enter is one screen load');
});

test('V10: everything the switch already did it still does', () => {
  const h = load();
  h.state.runId = '7';
  h.fn.show('run');
  assert.equal(h.state.view, 'run');
  assert.equal(h.state.activeTab, 'runs');
  assert.equal(h.doc.body.dataset.view, 'run');
  assert.equal(h.node['view-run'].hidden, false);
  assert.equal(h.node['view-runs'].hidden, true);
  assert.equal(h.tab('runs').getAttribute('aria-selected'), 'true');
  assert.equal(h.calls.persists, 1);
});

// ---------- the static half ----------

// The map this row reads is views.js's own, so the markup and TAB_OF_VIEW cannot drift apart.
const { TAB_OF_VIEW } = load().lex;

test('V11: every one of the eight sections is its tab’s panel, and can hold the caret show() gives it', () => {
  const html = readFileSync(join(repoRoot, 'extension/sidepanel/index.html'), 'utf8');
  for (const v of VIEWS) {
    const open = new RegExp(`<section id="view-${v}"([^>]*)>`).exec(html);
    assert.ok(open, `view-${v} is in the markup`);
    assert.match(open[1], /\btabindex="-1"/, `view-${v} can take focus`);
    assert.match(open[1], /\brole="tabpanel"/, `view-${v} is a panel`);
    assert.match(open[1], new RegExp(`\\baria-labelledby="tab-${TAB_OF_VIEW[v]}"`), `view-${v} names its tab`);
  }
});
