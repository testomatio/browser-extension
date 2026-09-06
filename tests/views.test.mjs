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
import {
  loadScreen, CORE_SRC, makeDocument, el, fire, plain, fakeClock, rejection,
} from './helpers/panel-harness.mjs';
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
  for (const t of BAR) {
    // index.html:90 — the count chip lives INSIDE its tab and ships hidden, because unknown is not 0.
    const btn = mk('button', `tab-${t}`, { className: 'tab', role: 'tab' });
    btn.append(mk('span', `tab-${t}-count`, { className: 'counter size-sm', hidden: true }));
    tabbar.append(btn);
  }
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
  const degraded = mk('div', 'degraded-banner', { hidden: true });
  degraded.append(el('span', { className: 'banner-text degraded-banner-text' })); // index.html:135

  doc.body.append(headerTop, projectBar, contextBar, degraded, main,
    mk('p', 'run-status', { className: 'status-line' }),   // index.html:569
    mk('p', 'test-status', { className: 'status-line' }),  // index.html:638
    mk('div', 'toast', { className: 'toast', hidden: true })); // index.html:816
  return { doc, node };
}

// The real Roving, not a stub: the arrows across the bar and the tab stop they leave behind are half
// of what this file is about, and a stub would be answering for both of them.
const roving = () => loadInto({ console }, [['shared/roving.js', 'Roving']]).value;

const SETTINGS = { baseUrl: 'https://app.testomat.io', projectId: 'p1' };

function load(opts = {}) {
  const o = { settings: SETTINGS, readonly: false, jwt: true, ...opts };
  const { doc, node } = makePage();
  // `order` is every collaborator this file calls, in the order it called them: half of what the
  // switch and the tab model promise is a sequence, not a set.
  const calls = {
    persists: 0, clicks: [], order: [], opens: [], counts: [], configures: [], projects: 0,
  };
  const observers = []; // every ResizeObserver the two fitters arm, callback kept, never fired for them

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
    tcSuiteTitle: '',
    tcSuiteEmoji: '',
    testrunDetail: null,
    testDetailPending: false,
    projectEpoch: 0,
  };

  const globals = {
    state,
    capabilities: { readonly: o.readonly, jwt: o.jwt },
    views: VIEWS,
    Roving: roving(),
    $: (id) => doc.getElementById(id),
    Skeleton: {
      bootDone: () => { calls.order.push('bootDone'); },
      hide: () => { calls.order.push('hide'); },
    },
    Tooltip: { set: (n, tip) => { if (n) n.dataset.tip = tip; } },
    TestomatAPI: { jwtAvailable: () => o.jwt },
    // core/state.js:101, verbatim.
    isConfigured: () => !!(state.settings && state.settings.projectId),
    persistSession: () => { calls.persists += 1; calls.order.push('persist'); },
    // The crumb factories name these at BUILD time, not on click — an absent one throws.
    openRunsView: () => { calls.opens.push(['runs']); calls.order.push('openRunsView'); },
    openRunView: (id, title) => { calls.opens.push(['run', id, title]); calls.order.push('openRunView'); },
    openTcStudioView: () => { calls.opens.push(['tcstudio']); calls.order.push('openTcStudioView'); },
    openTestView: (id) => { calls.opens.push(['test', id]); },
    openTestSuitePicker: () => { calls.opens.push(['promote']); },
    refreshTcList: () => { calls.opens.push(['refreshTcList']); },
    refreshRuns: () => { calls.opens.push(['refreshRuns']); return o.refreshRuns ? o.refreshRuns() : undefined; },
    refreshProjects: () => { calls.projects += 1; return o.projects || Promise.resolve(); },
    fillSettingsForm: () => { calls.order.push('fillSettingsForm'); },
    loadRunsCount: (epoch) => { calls.counts.push(['runs', epoch]); return Promise.resolve(); },
    loadTestsCount: (epoch) => { calls.counts.push(['tests', epoch]); return Promise.resolve(); },
    Handoff: { configure: (s) => { calls.configures.push(s); calls.order.push('Handoff.configure'); } },
    // shared/icons.js:238 — the arity matters: `cls` reaches classList.add, which throws on a space.
    Icons: {
      el: (name, size = 16, ...cls) => {
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        n.classList.add(...cls.filter(Boolean));
        return n;
      },
    },
    Sk: { bar: (kind) => el('span', { className: 'sk-bar', dataset: { kind } }) },
    // Records the callback and never fires it: the real one re-enters fitFilterChips, and only the
    // width guard stops that — an eager fake would recurse instead of testing the guard.
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; this.node = null; observers.push(this); }
      observe(n) { this.node = n; }
      disconnect() { this.node = null; }
    },
    recordFor: (id) => (o.records || {})[id] || null,
    TestType: { forRecord: (rec) => (rec.automated ? el('span', { className: 'type-mark' }, 'A') : null) },
    // core/status-icons.js — the suite mark a tclist title carries.
    StatusIcons: {
      FILE: 'tree_suite',
      treeIcon: (name, cls) => el('span', { className: cls, dataset: { icon: name } }),
    },
  };
  // shared/priority-icons.js loads before core, but the file guards on `typeof` — so a row can take
  // it away and watch the title carry no marks rather than throw.
  if (o.priorityIcons !== false) {
    globals.PriorityIcons = { mark: (p) => el('span', { className: 'prio', dataset: { prio: String(p || '') } }, String(p || '')) };
  }

  const clock = fakeClock(); // a real 3.5s toast timer would hold the whole test run open

  const h = loadScreen('views', {
    dir: CORE_SRC,
    document: doc,
    globals,
    clock,
    // core/nav-model.js is the tab model and the two navigation decisions, loaded ahead of views the
    // way index.html loads it. It is where the four maps and the web-link rule now live, so the
    // names below are re-bound to the shape they had while this was one file: every row keeps
    // asking the shipped decision the same question, and CONTEXT_WEB_TARGET's per-view closures are
    // rebuilt over webTarget(view, state, recordFor) — the arguments the model takes instead.
    before: ['nav-model'],
    exported: `({
      TAB_OF_VIEW: NavModel.TAB_OF_VIEW, TABS: NavModel.TABS, TAB_ROOT: NavModel.TAB_ROOT,
      ROOT_VIEWS: NavModel.ROOT_VIEWS, CONTEXT_TRAILS,
      CONTEXT_WEB_TARGET: Object.fromEntries(['run', 'test', 'tclist']
        .map((v) => [v, () => NavModel.webTarget(v, state, recordFor)])),
      tabCountKnown, LABEL_FIT_MIN_FIELD, ALERT_ICON, PROGRESS_ICON, progressToast })`,
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
    observers,
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

// The map this row reads is the shipped one (core/nav-model.js), so the markup and TAB_OF_VIEW
// cannot drift apart.
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

// ---------- the tab a screen belongs to ----------

test('V12: every screen the panel can show belongs to exactly one of the three tabs', () => {
  const h = load();
  assert.deepEqual(plain(h.lex.TAB_OF_VIEW), {
    tcstudio: 'tests', tclist: 'tests', promote: 'tests',
    runs: 'runs', run: 'runs', test: 'runs',
    settings: 'settings', pick: 'settings',
  });
  assert.deepEqual(plain(h.lex.TABS), BAR);
  // The four landing screens: the Back arrow and the title row above it are hidden on these.
  assert.deepEqual(VIEWS.filter((v) => h.lex.ROOT_VIEWS.has(v)), ['settings', 'pick', 'runs', 'tcstudio']);
});

test('V13: a view name nobody knows lands the tester in Runs rather than in no tab at all', () => {
  const h = load();
  h.fn.show('bogus'); // no throw: there is no #view-bogus to hide, show or focus
  assert.equal(h.state.activeTab, 'runs', 'a bar with no tab lit is a bar the tester cannot read');
  assert.equal(h.state.view, 'bogus');
  assert.equal(h.doc.body.dataset.view, 'bogus');
  assert.deepEqual(VIEWS.filter((v) => !h.node[`view-${v}`].hidden), []);
});

test('V14: the switch does its steps in the order the screens after it depend on', () => {
  const h = load();
  h.state.runId = '7';
  h.state.runTitle = 'Nightly';
  const at = {};
  // screens/settings.js:224 focuses its token field from in here, so the sections must have switched.
  h.fn.applyConnectMode = () => {
    h.calls.order.push('applyConnectMode');
    at.sectionUp = h.node['view-run'].hidden;
    at.view = h.state.view;
  };
  h.fn.updatePendingBanner = () => { h.calls.order.push('updatePendingBanner'); };
  h.fn.onViewShown = (v) => {
    h.calls.order.push(`onViewShown:${v}`);
    at.title = h.node['context-title'].textContent;
    at.selected = h.tab('runs').getAttribute('aria-selected');
  };

  h.fn.show('run');
  assert.deepEqual(h.calls.order, ['bootDone', 'hide', 'applyConnectMode',
    'updatePendingBanner', 'onViewShown:run', 'persist']);
  assert.equal(at.sectionUp, false, 'the section was already up when the screen reached for its field');
  assert.equal(at.view, 'run');
  assert.equal(at.title, 'Nightly', 'and the header row was painted before the screen loaded');
  assert.equal(at.selected, 'true');
});

test('V15: the three scripts that load after core are optional — the switch runs without any of them', () => {
  const h = load();
  assert.equal(h.fn.applyConnectMode, undefined);
  assert.equal(h.fn.updatePendingBanner, undefined);
  assert.equal(h.fn.onViewShown, undefined);
  h.fn.show('settings'); // no throw
  assert.equal(h.node['view-settings'].hidden, false);
  assert.equal(h.calls.persists, 1, 'and the session was still written');
});

// ---------- the title above the Back arrow ----------

test('V16: the title names the screen from the first frame, before its data has landed', () => {
  const h = load();
  assert.equal(h.fn.contextTitleFor('run'), 'Run');
  assert.equal(h.fn.contextTitleFor('test'), 'Test');
  assert.equal(h.fn.contextTitleFor('tclist'), 'Suite');
  assert.equal(h.fn.contextTitleFor('promote'), 'Choose suite');
  assert.equal(h.fn.contextTitleFor('runs'), '', 'a tab root has no title — the row is hidden there');

  h.state.runTitle = 'Nightly';
  h.state.testTitle = 'Login works';
  h.state.tcSuiteTitle = 'Checkout';
  assert.deepEqual(['run', 'test', 'tclist'].map((v) => h.fn.contextTitleFor(v)),
    ['Nightly', 'Login works', 'Checkout']);
});

test('V17: a priority still being read holds its slot, so the title cannot jump under the reader', () => {
  const h = load();
  h.state.testDetailPending = true;
  const [prio, type] = h.fn.contextTitleMarks('test');
  assert.equal(prio.className, 'prio');
  assert.equal(prio.childNodes.length, 1, 'a skeleton bar stands in the slot the real mark will take');
  assert.equal(prio.firstChild.className, 'sk-bar');
  assert.equal(type, null);

  h.state.testDetailPending = false;
  h.state.testrunDetail = { data: { attributes: { test: { priority: 'high' } } } };
  assert.equal(h.fn.contextTitleMarks('test')[0].dataset.prio, 'high', 'the same slot, now filled');
});

test('V18: with the priority vocabulary missing the title simply carries no marks', () => {
  const h = load({ priorityIcons: false });
  assert.deepEqual(plain(h.fn.contextTitleMarks('test')), [null, null]);
  h.state.testTitle = 'Login works';
  h.fn.updateContextBar('test');
  assert.equal(h.node['context-title'].textContent, 'Login works', 'and prints no holes where they were');
});

// ---------- the trail ----------

test('V19: the trail above a test names the run it came out of, and that crumb is the way back', () => {
  const h = load();
  h.state.runId = '7';
  h.state.runTitle = 'Nightly';
  h.fn.renderContextCrumbs('test');

  const nav = h.node['context-crumbs'];
  assert.equal(nav.hidden, false);
  assert.deepEqual(nav.childNodes.map((n) => n.className), ['crumb', 'crumb-sep', 'crumb']);
  const [root, run] = nav.querySelectorAll('.crumb');
  assert.deepEqual([root.textContent, run.textContent], ['Runs', 'Nightly']);
  // The root crumb keeps its width; the ones after it give width up, so what they lose comes back.
  assert.equal(root.dataset.tip, undefined);
  assert.equal(root.getAttribute('aria-label'), null);
  assert.equal(run.dataset.tip, 'Nightly');
  assert.equal(run.getAttribute('aria-label'), 'Nightly');

  run.click();
  assert.deepEqual(plain(h.calls.opens), [['run', '7', 'Nightly']]);
});

test('V20: a tab root has no trail — the nav goes away rather than standing there empty', () => {
  const h = load();
  h.state.runId = '7';
  h.fn.renderContextCrumbs('test');
  assert.equal(h.node['context-crumbs'].childNodes.length, 3);

  h.fn.renderContextCrumbs('runs');
  assert.equal(h.node['context-crumbs'].hidden, true);
  assert.equal(h.node['context-crumbs'].childNodes.length, 0);
  h.fn.renderContextCrumbs(null); // what updateContextBar passes on a root view
  assert.equal(h.node['context-crumbs'].hidden, true);
});

// ---------- the way out to the web app ----------

test('V21: the web link points at the RECORD the tester is reading, not the test case behind it', () => {
  const h = load({ records: { 55: { test_id: 't7' } } });
  const target = h.lex.CONTEXT_WEB_TARGET;
  h.state.runId = '9';
  h.state.currentRecordId = '55';
  assert.deepEqual(plain(target.test()), ['test', 'runs/9/test/55'],
    'a parametrized run has many records on one test_id — only the record names the row on screen');

  h.state.runId = null; // a test opened with no run around it: the case page is the honest target
  assert.deepEqual(plain(target.test()), ['test', 'test/t7']);
  h.state.currentRecordId = null;
  assert.equal(target.test(), null, 'and with neither there is nothing to point at');

  h.state.runId = '9';
  assert.deepEqual(plain(target.run()), ['run', 'runs/9']);
  h.state.tcSuiteId = 's 1';
  assert.deepEqual(plain(target.tclist()), ['suite', 'suite/s%201']);
});

test('V22: the link is built off the SAVED base url, trailing slashes gone and every id encoded', () => {
  const h = load({ settings: { baseUrl: 'https://a.io///', projectId: 'p 1' } });
  h.state.runId = '9';
  h.fn.renderContextOpenLink('run');
  const a = h.node['context-open'];
  assert.equal(a.hidden, false);
  assert.equal(a.href, 'https://a.io/projects/p%201/runs/9');
  assert.equal(a.getAttribute('aria-label'), 'Open this run in Testomat');
  assert.equal(a.dataset.tip, 'Open this run in Testomat');
});

test('V23: with nothing to open the link hides instead of pointing the tester at a 404', () => {
  const h = load();
  h.state.runId = '9';
  h.fn.renderContextOpenLink('run');
  assert.equal(h.node['context-open'].hidden, false);

  h.state.runId = null; // the id has not been read back yet
  h.fn.renderContextOpenLink('run');
  assert.equal(h.node['context-open'].hidden, true);
  assert.equal(h.node['context-open'].getAttribute('href'), null, 'and the stale href went with it');

  h.state.runId = '9';
  h.fn.renderContextOpenLink('promote'); // the suite picker is a step, not a page on the web
  assert.equal(h.node['context-open'].hidden, true);
});

test('V24: a locked project is not offered a way out to the web app either', () => {
  const h = load({ readonly: true });
  h.state.runId = '9';
  h.fn.renderContextOpenLink('run');
  assert.equal(h.node['context-open'].hidden, true);
});

test('V25: an http base url a handoff supplied is emitted exactly as it stands', () => {
  // saveSettings is https-only, Handoff.connect is not — so this is reachable, and pinned as it is.
  const h = load({ settings: { baseUrl: 'http://a.io', projectId: 'p1' } });
  h.state.runId = '9';
  h.fn.renderContextOpenLink('run');
  assert.equal(h.node['context-open'].href, 'http://a.io/projects/p1/runs/9');
});

// ---------- the header row on a drill-down ----------

test('V26: on a drill-down the Rec chip and the one Refresh ride into the only row left', () => {
  const h = load();
  h.state.runId = '7';
  h.fn.updateContextBar('runs'); // a tab root: the row folds away and the two go home
  assert.equal(h.node['context-bar'].hidden, true);
  assert.equal(h.node['btn-back'].hidden, true);
  assert.equal(h.doc.body.dataset.immersive, 'false');
  assert.equal(h.node['rec-slot'].parentElement.id, 'header-top');
  assert.equal(h.node['btn-refresh'].parentElement.id, 'project-bar');

  h.fn.updateContextBar('run');
  assert.equal(h.node['context-bar'].hidden, false);
  assert.equal(h.node['btn-back'].hidden, false);
  assert.equal(h.doc.body.dataset.immersive, 'true');
  assert.equal(h.node['rec-slot'].parentElement.id, 'context-bar', 'or Rec would be unreachable');
  const bar = h.node['context-bar'];
  assert.equal(bar.childNodes.indexOf(h.node['btn-refresh']) + 1,
    bar.childNodes.indexOf(h.node['context-open']), 'and Refresh keeps its seat left of the open-link');

  h.fn.updateContextBar('runs'); // …and back home again, in one piece
  assert.equal(h.node['rec-slot'].parentElement.id, 'header-top');
  assert.equal(h.node['btn-refresh'].nextElementSibling.id, 'project-open');
});

test('V27: a title too long for its row is offered whole as a tooltip — the NAME, not the whole row', () => {
  const h = load();
  h.state.testTitle = 'Checkout with an expired card';
  h.state.testrunDetail = { data: { attributes: { test: { priority: 'high' } } } };
  const title = h.node['context-title'];
  title.scrollHeight = 40; // the box a browser would have measured after the row went up
  title.clientHeight = 20;

  h.fn.updateContextBar('test');
  assert.equal(title.textContent, 'highCheckout with an expired card', 'the mark is drawn in the row');
  assert.equal(title.dataset.tip, 'Checkout with an expired card',
    'the reader can already see the mark; repeating it in the tip would be noise');

  title.scrollHeight = 20; // it fits now
  h.fn.updateContextBar('test');
  assert.equal(title.dataset.tip, '');
});

// ---------- the tab bar ----------

test('V28: unconfigured, the two tabs that need a project are taken away and say why', () => {
  const h = load({ settings: null });
  h.fn.updateTabBar();
  for (const t of ['tests', 'runs']) {
    assert.equal(h.tab(t).disabled, true, t);
    assert.equal(h.tab(t).getAttribute('aria-disabled'), 'true', t);
    assert.equal(h.tab(t).dataset.tip, 'Configure settings first', t);
  }
  assert.equal(h.tab('settings').disabled, false, 'Settings is the one tab reachable unconfigured');
  assert.equal(h.tab('settings').getAttribute('aria-disabled'), 'false');
  assert.equal(h.tab('settings').dataset.tip, '');
});

test('V29: a tab the markup has not built is walked past, not thrown over', () => {
  const h = load();
  h.node['tab-tests'].remove();
  h.fn.updateTabBar(); // no throw
  assert.equal(h.tab('runs').getAttribute('aria-disabled'), 'false');
});

// ---------- the counters ----------

test('V30: zero is a number the tester can see — only an UNKNOWN count hides the chip', () => {
  const h = load();
  const chip = h.node['tab-runs-count'];
  h.fn.setTabCount('runs', 0);
  assert.equal(chip.hidden, false, 'a project with no runs says so');
  assert.equal(chip.textContent, '0');

  for (const unknown of [null, undefined, NaN, -1, '12', Infinity]) {
    h.fn.setTabCount('runs', unknown);
    assert.equal(chip.hidden, true, `${String(unknown)} is not a count the bar may print`);
    assert.equal(chip.textContent, '');
  }

  h.fn.setTabCount('runs', 12);
  assert.equal(chip.textContent, '12');
  h.fn.resetTabCounts();
  assert.deepEqual(BAR.map((t) => h.node[`tab-${t}-count`].hidden), [true, true, true]);
});

test('V31: a count that did not move does not blink — the flash replays only for a new number', () => {
  const h = load();
  const chip = h.node['tab-runs-count'];
  const churn = [];
  let name = 'counter settled';
  Object.defineProperty(chip, 'className', {
    configurable: true, get: () => name, set: (v) => { name = v; churn.push(v); },
  });
  // The read that forces the layout the class toggle just changed — without it the keyframe never
  // restarts, and a settled count would sit there with no flash at all.
  Object.defineProperty(chip, 'offsetWidth', {
    configurable: true, get: () => { churn.push('reflow'); return 0; },
  });

  h.fn.paintCounter(chip, 12);
  assert.deepEqual(churn, ['counter', 'reflow', 'counter settled']);
  assert.equal(chip.textContent, '12');

  churn.length = 0;
  h.fn.paintCounter(chip, 12); // the same number arriving again
  assert.deepEqual(churn, [], 'nothing was touched, so nothing re-fades under the tester');

  h.fn.paintCounter(chip, 13);
  assert.deepEqual(churn, ['counter', 'reflow', 'counter settled']);
  assert.equal(chip.textContent, '13');
});

test('V32: the flash is dropped once it has played, so a screen coming back does not re-fade its counts', () => {
  const h = load();
  const chip = h.node['tab-runs-count'];
  h.fn.initCounterFade();

  chip.className = 'counter settled';
  fire(h.doc, 'animationend', { animationName: 'counter-in', target: chip });
  assert.equal(chip.className, 'counter');

  chip.className = 'counter settled';
  fire(h.doc, 'animationend', { animationName: 'spin', target: chip });
  assert.equal(chip.className, 'counter settled', 'another animation on the same node is not this one');
});

test('V33: a tab that already knows its number is not counted a second time', () => {
  const h = load();
  h.state.projectEpoch = 4;
  h.node['tab-tests-count'].hidden = false; // the suite tree derived it on the way in
  h.fn.prefetchTabCounts();
  assert.deepEqual(plain(h.calls.counts), [['runs', 4]], 'a second, differently derived count must not win');
  assert.equal(h.lex.tabCountKnown('tests'), true);

  h.calls.counts.length = 0;
  h.node['tab-tests-count'].hidden = true;
  h.fn.prefetchTabCounts();
  assert.deepEqual(plain(h.calls.counts), [['tests', 4], ['runs', 4]]);
});

test('V34: a locked project counts nothing — every request it could make is refused anyway', async () => {
  const h = load({ readonly: true });
  await h.fn.prefetchTabCounts();
  await h.fn.refreshTabCounts();
  assert.deepEqual(h.calls.counts, []);
});

test('V35: the suite tree owns the tests number, so a refresh on that screen does not re-derive it', () => {
  const h = load();
  h.state.projectEpoch = 2;
  h.state.view = 'tcstudio';
  h.fn.refreshTabCounts();
  assert.deepEqual(plain(h.calls.counts), [['runs', 2]]);

  h.calls.counts.length = 0;
  h.state.view = 'runs';
  h.fn.refreshTabCounts();
  assert.deepEqual(plain(h.calls.counts), [['runs', 2], ['tests', 2]]);
});

// ---------- the panel-wide Refresh ----------

test('V36: a second Refresh while the first is still in flight is dropped, not queued', async () => {
  let release;
  const h = load({ projects: new Promise((r) => { release = r; }) });
  const btn = h.node['btn-refresh'];

  const first = h.fn.refreshAll();
  assert.equal(btn.disabled, true, 'disabled before the first request goes out, not after it lands');
  assert.equal(btn.classList.contains('spinning'), true);

  const second = h.fn.refreshAll();
  release();
  await Promise.all([first, second]);
  assert.equal(h.calls.projects, 1, 'or every request in flight would be sent a second time');
  assert.equal(btn.disabled, false);
  assert.equal(btn.classList.contains('spinning'), false);
});

test('V37: a refresh that fails still gives the button back — the panel is not left spinning', async () => {
  let fail = true;
  const h = load({ refreshRuns: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()) });
  h.state.view = 'runs';

  const err = await rejection(h.fn.refreshAll());
  assert.equal(err.message, 'offline');
  const btn = h.node['btn-refresh'];
  assert.equal(btn.disabled, false);
  assert.equal(btn.classList.contains('spinning'), false);

  fail = false;
  h.calls.projects = 0;
  await h.fn.refreshAll();
  assert.equal(h.calls.projects, 1, 'and the next press really runs — the door was unlocked too');
});

test('V38: Refresh re-pulls the screen that is open without navigating away from it', async () => {
  const h = load();
  h.state.runId = '7';
  h.state.runTitle = 'Nightly';
  h.state.currentRecordId = '55';
  const ran = async (view) => {
    h.calls.opens.length = 0;
    h.state.view = view;
    await h.fn.refreshCurrentView();
    return plain(h.calls.opens);
  };
  assert.deepEqual(await ran('runs'), [['refreshRuns']]);
  assert.deepEqual(await ran('run'), [['run', '7', 'Nightly']]);
  assert.deepEqual(await ran('test'), [['test', '55']]);
  assert.deepEqual(await ran('tcstudio'), [['tcstudio']]);
  assert.deepEqual(await ran('tclist'), [['refreshTcList']], 're-read in place, or the open list is lost');
  assert.deepEqual(await ran('promote'), [['promote']]);
  assert.deepEqual(await ran('settings'), [], 'Settings holds no server data of its own');
});

test('V39: a run or test whose id is not known yet is left alone rather than re-opened as nothing', async () => {
  const h = load();
  h.state.view = 'run';
  h.state.runId = null;
  await h.fn.refreshCurrentView();
  h.state.view = 'test';
  h.state.currentRecordId = null;
  await h.fn.refreshCurrentView();
  assert.deepEqual(h.calls.opens, []);
});

// ---------- the filter row that sends its overflow to a menu ----------

// A row that measures the way a browser measures one: what it reports is the chips it is still
// SHOWING, plus the "…" trigger once that is up. screens/runs-list.js:457 is the chip's real shape.
const TRIGGER_W = 32;
function filterBar(h, widths, clientWidth) {
  const bar = el('div', { className: 'filter-bar' });
  const chips = widths.map((w, i) => {
    const chip = el('button', { className: 'btn secondary size-sm filter-chip', dataset: { filter: `f${i}` } });
    chip.append(el('span', { className: 'filter-label' }, `Filter ${i}`),
      el('span', { className: 'counter' }, String(i)));
    chip.w = w;
    return chip;
  });
  bar.append(...chips);
  h.doc.body.append(bar);
  bar.clientWidth = clientWidth;
  Object.defineProperty(bar, 'scrollWidth', {
    configurable: true,
    get: () => {
      const wrap = bar.querySelector('.filter-more');
      return chips.filter((c) => !c.hidden).reduce((n, c) => n + c.w, 0)
        + (wrap && !wrap.hidden ? TRIGGER_W : 0);
    },
  });
  return { bar, chips };
}

test('V40: a row whose chips all fit keeps every one of them, and the "…" never appears', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50], 300);
  h.fn.fitFilterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false]);
  const wrap = bar.querySelector('.filter-more');
  assert.equal(wrap.hidden, true);
  assert.equal(wrap.querySelector('.filter-more-menu').childNodes.length, 0);
});

test('V41: a row dragged narrow gives up chips from the right, and the menu lists them in row order', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50, 50], 150);
  h.fn.fitFilterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, true, true]);

  const options = bar.querySelectorAll('.menu-option');
  assert.deepEqual(options.map((li) => li.childNodes[0].textContent), ['Filter 2', 'Filter 3']);
  assert.deepEqual(options.map((li) => li.childNodes[1].className), ['counter', 'counter'],
    'each option carries the chip’s own count, cloned');

  // Dragged wide again the row re-fits from the WIDE state, never from where the last fit left it.
  bar.clientWidth = 400;
  h.fn.fitFilterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false, false]);
});

test('V42: however narrow the pane gets, "All" is the one chip that never goes', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [200, 200], 100);
  h.fn.fitFilterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, true],
    'a row with no chip left showing would tell the tester nothing about what it is filtered to');
  assert.equal(bar.querySelectorAll('.menu-option').length, 1);
});

test('V43: a filter row built on a hidden screen is armed to fit itself the moment the screen opens', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50], 0);
  h.fn.fitFilterChips(bar);
  assert.equal(h.observers.length, 1, 'armed BEFORE the measuring, which is what a hidden row needs');
  assert.equal(h.observers[0].node, bar);
  assert.deepEqual(chips.map((c) => c.hidden), [undefined, undefined, undefined], 'and nothing was fitted');
  assert.equal(bar.querySelector('.filter-more'), null);

  bar.clientWidth = 150; // the screen opens and the observer brings the row back
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);
  assert.equal(h.observers.length, 1, 'still the one observer — a second would re-fit forever');
});

test('V44: the "…" menu is built once, so a re-fit cannot close it under the tester’s pointer', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fn.fitFilterChips(bar);
  const first = h.fn.ensureFilterMore(bar);
  first.trigger.click();
  assert.equal(first.menu.hidden, false);
  assert.equal(first.trigger.getAttribute('aria-expanded'), 'true');

  h.fn.fitFilterChips(bar); // the pane was nudged; the row re-fits under the open menu
  assert.equal(h.fn.ensureFilterMore(bar), first, 'the same menu, not a torn-down and rebuilt one');
  assert.equal(first.menu.hidden, false, 'and it is still open');
});

test('V45: the "…" stands in for what it hides — including the filter that is currently chosen', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50, 50], 150);
  chips[3].classList.add('selected');
  h.fn.fitFilterChips(bar);

  const { trigger, menu } = h.fn.ensureFilterMore(bar);
  const options = menu.querySelectorAll('.menu-option');
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((li) => li.getAttribute('role')), ['menuitem', 'menuitem']);
  assert.deepEqual(options.map((li) => li.tabIndex), [0, 0]);
  assert.deepEqual(options.map((li) => li.getAttribute('aria-selected')), ['false', 'true']);
  assert.equal(trigger.classList.contains('selected'), true, 'or the row would look unfiltered');
  assert.equal(trigger.classList.contains('secondary'), false);
  assert.equal(trigger.getAttribute('aria-label'), 'More filters', 'a glyph-only button needs a name');

  chips[3].classList.remove('selected');
  h.fn.fitFilterChips(bar);
  assert.equal(h.fn.ensureFilterMore(bar).trigger.classList.contains('selected'), false);
  assert.equal(h.fn.ensureFilterMore(bar).trigger.classList.contains('secondary'), true);
});

test('V46: when the row grows wide enough for every chip, an open menu closes with it', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fn.fitFilterChips(bar);
  const { wrap, trigger, menu } = h.fn.ensureFilterMore(bar);
  trigger.click();
  assert.equal(menu.hidden, false);

  bar.clientWidth = 400; // the tester drags the pane wide
  h.fn.fitFilterChips(bar);
  assert.equal(wrap.hidden, true);
  assert.equal(menu.hidden, true, 'a menu left open over a hidden trigger cannot be dismissed');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal((h.doc.listeners.get('click') || []).length, 0, 'and its document-level closer went too');
});

test('V47: picking a filter out of the "…" runs the real chip, and the menu closes behind it', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50, 50], 150);
  const picked = [];
  for (const c of chips) c.addEventListener('click', () => picked.push(c.dataset.filter));
  h.fn.fitFilterChips(bar);
  const { trigger, menu } = h.fn.ensureFilterMore(bar);

  trigger.click();
  fire(menu.querySelectorAll('.menu-option')[0], 'keydown', { key: 'Enter' });
  assert.deepEqual(picked, ['f2'], 'the hidden chip itself was clicked, so its own listener ran');
  assert.equal(menu.hidden, true);

  trigger.click();
  fire(menu.querySelectorAll('.menu-option')[1], 'keydown', { key: ' ' });
  assert.deepEqual(picked, ['f2', 'f3']);
  assert.equal(menu.hidden, true);
});

test('V48: any other key on a menu option does nothing and leaves the menu standing', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50, 50], 150);
  const picked = [];
  for (const c of chips) c.addEventListener('click', () => picked.push(c.dataset.filter));
  h.fn.fitFilterChips(bar);
  const { trigger, menu } = h.fn.ensureFilterMore(bar);

  trigger.click();
  const ev = fire(menu.querySelectorAll('.menu-option')[0], 'keydown', { key: 'a' });
  assert.deepEqual(picked, []);
  assert.equal(menu.hidden, false);
  assert.equal(ev.defaultPrevented, false);
});

test('V49 (#335): Escape hands the caret back to the "…"; picking an option does not, and that is a gap', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fn.fitFilterChips(bar);
  const { trigger, menu } = h.fn.ensureFilterMore(bar);

  trigger.click();
  fire(menu, 'keydown', { key: 'Escape', bubbles: true });
  assert.equal(menu.hidden, true);
  assert.equal(h.doc.activeElement, trigger, 'Escape puts the caret back where the tester left it');

  // Picking asks for the same thing — but the chip's own click reaches the document-level closer
  // FIRST, so the menu is already shut when the focus request runs, and it returns having moved
  // nothing. Today's behaviour, pinned: the caret is left on a row the next render throws away.
  h.doc.body.focus();
  trigger.click();
  const option = menu.querySelectorAll('.menu-option')[0];
  option.focus();
  fire(option, 'keydown', { key: 'Enter' });
  assert.equal(menu.hidden, true);
  assert.equal(h.doc.activeElement, option);
});

// ---------- the create-button labels ----------

function labelBar(h, fieldWidth) {
  const bar = el('div', { className: 'toolbar' });
  const field = el('div', { className: 'field' });
  const btn = el('button', { className: 'btn primary fit-label', dataset: { label: 'New run' } });
  bar.append(field, btn);
  h.doc.body.append(bar);
  bar.clientWidth = 300;
  field.clientWidth = fieldWidth;
  return { bar, field, btn };
}

test('V50: when the search box gets too narrow the button drops a word but keeps its whole name', () => {
  const h = load();
  const { bar, field, btn } = labelBar(h, 143);
  h.fn.fitActionLabels(bar);
  assert.equal(btn.classList.contains('is-short'), true);
  assert.equal(btn.getAttribute('aria-label'), 'New run', 'the reader still hears all of it');

  field.clientWidth = 144; // one pixel more is the whole rule
  h.fn.fitActionLabels(bar);
  assert.equal(btn.classList.contains('is-short'), false);
  assert.equal(btn.getAttribute('aria-label'), null, 'and the name is not announced twice over');
  assert.equal(h.lex.LABEL_FIT_MIN_FIELD, 144);
});

test('V51: every toolbar is armed once at boot, and re-fits itself when the pane really moves', () => {
  const h = load();
  const { bar, field, btn } = labelBar(h, 200);
  const second = el('button', { className: 'btn fit-label', dataset: { label: 'New test' } });
  bar.append(second);

  h.fn.initActionLabelFit();
  assert.equal(h.observers.length, 1, 'one observer for the bar, not one per button on it');
  assert.equal(btn.classList.contains('is-short'), false);

  field.clientWidth = 100;
  bar.clientWidth = 200;
  h.observers[0].cb();
  assert.deepEqual([btn, second].map((b) => b.classList.contains('is-short')), [true, true]);

  h.observers[0].cb(); // the same width again: the guard is what stops the row re-fitting forever
  assert.equal(h.observers.length, 1);
});

// ---------- the read-only lockout ----------

test('V52: the read-only lockout takes the run screen away before the tester can press anything on it', () => {
  const h = load({ readonly: true });
  h.state.runId = '7';
  h.fn.show('run');

  assert.equal(h.node['readonly-block'].hidden, false);
  assert.deepEqual(VIEWS.filter((v) => !h.node[`view-${v}`].hidden), [],
    'v2 refuses every request on a locked project, GET included — there is nothing behind the block');
  assert.equal(h.node['context-bar'].hidden, true);
  assert.equal(h.node['btn-back'].hidden, true, 'Back would be lying: nothing is open behind it');
  assert.equal(h.doc.body.dataset.immersive, 'false', 'and the panel is not immersed in anything');
  assert.equal(h.doc.body.dataset.readonly, 'true');
});

test('V53: Settings is the way out of the lockout, so that one screen is never blocked', () => {
  const h = load({ readonly: true });
  h.fn.show('settings');
  assert.equal(h.node['readonly-block'].hidden, true);
  assert.equal(h.node['view-settings'].hidden, false, 'or the tester could not switch project or sign out');
  assert.equal(h.doc.body.dataset.readonly, 'true', 'the panel still knows the project is locked');
});

test('V54: unlocking a project gives the open screen and its header row straight back', () => {
  const h = load({ readonly: true });
  h.state.runId = '7';
  h.state.runTitle = 'Nightly';
  h.fn.show('run');
  assert.equal(h.node['view-run'].hidden, true);

  h.fn.capabilities.readonly = false;
  h.node['context-title'].replaceChildren(); // whatever the block left standing there
  h.fn.applyReadonlyBlock();
  assert.equal(h.node['readonly-block'].hidden, true);
  assert.deepEqual(VIEWS.filter((v) => !h.node[`view-${v}`].hidden), ['run']);
  assert.equal(h.node['context-title'].textContent, 'Nightly', 'the header row was repainted with it');
  assert.equal(h.doc.body.dataset.readonly, 'false');
});

// ---------- the basic-mode strip ----------

test('V55: the basic-mode strip appears only once the missing web login is PROVEN, never on a maybe', () => {
  const unknown = load({ jwt: 'unknown' });
  unknown.fn.show('runs');
  assert.equal(unknown.node['degraded-banner'].hidden, true);

  const proven = load({ jwt: false });
  proven.fn.show('runs');
  assert.equal(proven.node['degraded-banner'].hidden, false);
});

test('V56: the strip names the site to sign in to, taken from the settings that were saved', () => {
  const h = load({ jwt: false, settings: { baseUrl: 'https://a.io', projectId: 'p1' } });
  h.fn.show('runs');
  assert.equal(h.node['degraded-banner'].querySelector('.degraded-banner-text').textContent,
    'Basic mode — steps are local-only; finish run, priority and custom statuses '
    + 'need an active a.io web login. Sign in there, then Refresh.');
  assert.equal(h.fn.baseUrlHost(), 'a.io');
});

test('V57: the strip belongs to the two run screens — nowhere else carries it', () => {
  const h = load({ jwt: false });
  for (const v of ['runs', 'run']) {
    h.fn.show(v);
    assert.equal(h.node['degraded-banner'].hidden, false, v);
  }
  for (const v of ['settings', 'tcstudio', 'test', 'tclist']) {
    h.fn.show(v);
    assert.equal(h.node['degraded-banner'].hidden, true, v);
  }
});

test('V58: dismissing the strip keeps it down for the rest of the panel session', () => {
  const h = load({ jwt: false });
  h.fn.show('runs');
  assert.equal(h.node['degraded-banner'].hidden, false);

  h.fn.dismissDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, true);
  h.fn.show('run');
  h.fn.show('runs');
  assert.equal(h.node['degraded-banner'].hidden, true, 'it does not come back on the next screen');
});

test('V59: under the lockout there is no basic mode to explain, so the strip stays down', () => {
  const h = load({ jwt: false, readonly: true });
  h.fn.show('runs');
  assert.equal(h.node['degraded-banner'].hidden, true);
});

test('V60 (#336): with nothing saved the strip reads "the web app web login", and that is a gap', () => {
  const h = load({ jwt: false, settings: null });
  assert.equal(h.fn.baseUrlHost(), 'the web app');
  h.state.view = 'runs';
  h.fn.updateDegradedBanner();
  assert.match(h.node['degraded-banner'].querySelector('.degraded-banner-text').textContent,
    /an active the web app web login/);
});

// ---------- tabs, and the way back ----------

test('V61: until the panel is configured a tab click goes nowhere at all', () => {
  const h = load({ settings: null });
  h.fn.show('settings');
  h.calls.opens.length = 0;
  h.fn.switchTab('runs');
  h.fn.switchTab('tests');
  assert.deepEqual(h.calls.opens, []);
  assert.equal(h.state.activeTab, 'settings');
});

test('V62: leaving Settings reconfigures the API from what was SAVED, before the next screen opens', () => {
  const h = load();
  h.fn.show('settings');
  h.calls.order.length = 0;
  h.fn.switchTab('runs');
  assert.deepEqual(h.calls.order, ['Handoff.configure', 'openRunsView'],
    'a screen loading first would run on the unsaved edits still sitting in the form');
  assert.deepEqual(plain(h.calls.configures), [SETTINGS]);
});

test('V63: clicking the tab you are already on keeps the screen you are on', () => {
  const h = load();
  h.state.runId = '7';
  h.fn.show('run'); // deep inside the Runs tab
  h.calls.opens.length = 0;
  h.fn.switchTab('runs');
  assert.deepEqual(h.calls.opens, [], 'the open run is not thrown away for the list');
  assert.equal(h.state.view, 'run');
});

test('V64: coming back to a tab lands on the screen it was left on, without reloading it', () => {
  const h = load();
  h.state.tabViews.tests = 'tclist';
  h.state.tcSuiteId = 's1';
  h.fn.openTabView('tests');
  assert.equal(h.state.view, 'tclist');
  assert.deepEqual(h.calls.opens, [], 're-shown, not re-read: the list it holds survives');

  h.state.tabViews.runs = 'test';
  h.state.runId = '7';
  h.fn.openTabView('runs');
  assert.equal(h.state.view, 'test');
  assert.deepEqual(h.calls.opens, []);
});

test('V65: a remembered screen whose id has gone lands the tester on the tab’s own root instead', () => {
  const h = load();
  h.state.tabViews.tests = 'tclist';
  h.state.tcSuiteId = null; // the suite is not known any more
  h.fn.openTabView('tests');
  assert.deepEqual(plain(h.calls.opens), [['tcstudio']]);

  h.calls.opens.length = 0;
  h.state.tabViews.runs = 'run';
  h.state.runId = null;
  h.fn.openTabView('runs');
  assert.deepEqual(plain(h.calls.opens), [['runs']]);
});

test('V66: the suite picker is a step of + New test, never a screen to come back to', () => {
  const h = load();
  h.state.tabViews.tests = 'promote';
  h.state.tcSuiteId = 's1';
  h.fn.openTabView('tests');
  assert.deepEqual(plain(h.calls.opens), [['tcstudio']]);
});

test('V67: opening Settings refills the form from what was saved, dropping the stale edits in the DOM', () => {
  const h = load();
  h.calls.order.length = 0;
  h.fn.openTabView('settings');
  assert.deepEqual(h.calls.order.slice(0, 2), ['fillSettingsForm', 'bootDone']);
  assert.equal(h.state.view, 'settings');
});

test('V68: Back walks one step up the same trail the crumbs draw', () => {
  const h = load();
  h.state.runId = '7';
  h.state.runTitle = 'Nightly';
  const back = (view) => {
    h.calls.opens.length = 0;
    h.state.view = view;
    h.fn.goBack();
    return plain(h.calls.opens);
  };
  assert.deepEqual(back('tclist'), [['tcstudio']]);
  assert.deepEqual(back('promote'), [['tcstudio']], 'cancelling the picker is going back to the tree');
  assert.deepEqual(back('test'), [['run', '7', 'Nightly']]);
  assert.deepEqual(back('run'), [['runs']]);
  for (const root of ['runs', 'settings', 'tcstudio']) {
    assert.deepEqual(back(root), [], `${root} is a tab root — the arrow is hidden there`);
  }
});

// ---------- the toast at the bottom ----------

test('V69: a long message stays up longer, and no message holds the panel forever', () => {
  const h = load();
  assert.equal(h.fn.toastDuration('short'), 3500);
  assert.equal(h.fn.toastDuration('x'.repeat(40)), 3500);
  assert.equal(h.fn.toastDuration('x'.repeat(41)), 3550);
  assert.equal(h.fn.toastDuration('x'.repeat(200)), 8000);
});

test('V70: a plain toast is announced politely, carries nothing but its words, and takes itself down', async () => {
  const h = load();
  h.fn.toast('Saved');
  const t = h.node.toast;
  assert.equal(t.hidden, false);
  assert.equal(t.getAttribute('role'), 'status', 'status waits its turn; alert would cut the reader off');
  assert.equal(t.querySelectorAll('.toast-text').length, 1);
  assert.equal(t.textContent, 'Saved');
  assert.equal(t.querySelector('.toast-icon'), null);
  assert.equal(t.querySelector('.toast-dismiss'), null);
  assert.equal(h.clock.count(), 1);
  assert.equal(h.clock.ms(), 3500);

  await h.clock.tick();
  assert.equal(t.hidden, true);
});

test('V71: an error interrupts the reader, offers a way out — and still goes away on its own', async () => {
  const h = load();
  h.fn.toast('Upload failed', { error: true });
  const t = h.node.toast;
  assert.equal(t.getAttribute('role'), 'alert');
  assert.equal(t.classList.contains('error'), true);
  assert.equal(t.childNodes[0].className, 'toast-icon', 'the mark comes before the words, not after');
  assert.equal(t.querySelector('.toast-icon .md-icon').dataset.icon, 'error');
  const x = t.querySelector('.toast-dismiss');
  assert.equal(x.getAttribute('aria-label'), 'Dismiss');
  assert.equal(t.childNodes[t.childNodes.length - 1], x, 'and the way out comes last');
  assert.equal(h.clock.count(), 1, 'an error the tester ignores must not sit there for the session');

  await h.clock.tick();
  assert.equal(t.hidden, true);
  assert.equal(t.getAttribute('role'), 'status',
    'the live region is handed back, or the next quiet message would interrupt');
});

test('V72: the dismiss button takes the error down at once and disarms its timer', () => {
  const h = load();
  h.fn.toast('Upload failed', { error: true });
  h.node.toast.querySelector('.toast-dismiss').click();
  assert.equal(h.node.toast.hidden, true);
  assert.equal(h.clock.count(), 0, 'a timer left running would hide a toast that replaced this one');
});

test('V73: the running-job plaque holds until the job answers — a timer would take it down mid-work', () => {
  const h = load();
  h.lex.progressToast('Uploading…');
  const t = h.node.toast;
  assert.equal(t.classList.contains('progress'), true);
  assert.equal(t.getAttribute('role'), 'status', 'a step of a job is not an interruption');
  const mark = t.querySelector('.toast-icon .md-icon');
  assert.equal(mark.dataset.icon, 'progress_activity');
  assert.equal(mark.classList.contains('spin'), true);
  assert.equal(h.clock.count(), 0);
});

test('V74: the legacy number form still means "hold it this long"', () => {
  const h = load();
  h.fn.toast('x', 5000);
  assert.deepEqual(h.clock.arms(), [5000]);
});

test('V75: a new toast replaces the last one whole — no leftover icon, no leftover timer', () => {
  const h = load();
  h.fn.toast('Upload failed', { error: true });
  const firstTimer = h.clock.armed[0].id;

  h.fn.toast('Saved');
  const t = h.node.toast;
  assert.equal(t.querySelectorAll('.toast-text').length, 1);
  assert.equal(t.querySelector('.toast-icon'), null, 'the error mark went with the error');
  assert.equal(t.querySelector('.toast-dismiss'), null);
  assert.equal(t.classList.contains('error'), false);
  assert.equal(t.getAttribute('role'), 'status');
  assert.ok(h.clock.cleared.includes(firstTimer), 'the first timer would have hidden this message early');
  assert.equal(h.clock.count(), 1);
});

test('V76: an inline action fires once and takes the toast with it', () => {
  const h = load();
  let ran = 0;
  h.fn.toast('Deleted', { action: { label: 'Undo', onClick: () => { ran += 1; } } });
  const act = h.node.toast.querySelector('.toast-action');
  assert.equal(act.textContent, 'Undo');

  act.click();
  assert.equal(ran, 1);
  assert.equal(h.node.toast.hidden, true);
  assert.equal(h.clock.count(), 0);
});

test('V77: an action with nothing to do is not drawn as a button the tester can press', () => {
  const h = load();
  h.fn.toast('Deleted', { action: { label: 'Undo' } });
  assert.equal(h.node.toast.querySelector('.toast-action'), null);
});

test('V78: hideToast takes the plaque down and hands the live region back', () => {
  const h = load();
  h.lex.progressToast('Uploading…');
  h.fn.hideToast();
  const t = h.node.toast;
  assert.equal(t.hidden, true);
  assert.equal(t.classList.contains('progress'), false);
  assert.equal(t.getAttribute('role'), 'status');
  assert.equal(h.clock.count(), 0);
});

test('V79: hiding a toast on a page that has none is not an error the tester has to see', () => {
  const h = load();
  h.node.toast.remove();
  h.fn.hideToast(); // no throw
});

// ---------- the line under a field ----------

test('V80: a screen printing its own status line takes the running-job plaque down with it', () => {
  const h = load();
  h.lex.progressToast('Saving…');
  assert.equal(h.node.toast.hidden, false);

  h.fn.setStatusLine('run-status', 'Saved', 'ok');
  assert.equal(h.node['run-status'].textContent, 'Saved');
  assert.equal(h.node['run-status'].className, 'status-line ok');
  assert.equal(h.node.toast.hidden, true,
    'this is the one rule that keeps a plaque from standing over a job that already answered');
});

test('V81: a status line with no tone carries no trailing space in its class', () => {
  const h = load();
  h.fn.setStatusLine('run-status', '');
  assert.equal(h.node['run-status'].className, 'status-line');
  assert.equal(h.node['run-status'].textContent, '');
});

test('V82: an expired session offers Settings inline instead of teleporting the tester out of the run', () => {
  const h = load();
  h.fn.show('runs');
  h.fn.setAuthExpiredLine('test-status');
  const line = h.node['test-status'];
  assert.equal(line.className, 'status-line error');
  assert.equal(line.textContent, 'Session expired — open Settings to re-authenticate');
  const btn = line.querySelector('.link-btn.inline-auth-link');
  assert.equal(btn.tagName, 'BUTTON');

  btn.click();
  assert.equal(h.state.activeTab, 'settings');
  assert.equal(h.state.view, 'settings');
  assert.deepEqual(h.calls.order.filter((s) => s === 'fillSettingsForm'), ['fillSettingsForm']);
});

test('V83: a status line the screen does not have is not an error either', () => {
  const h = load();
  h.fn.setAuthExpiredLine('nope'); // no throw
});
