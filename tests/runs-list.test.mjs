#!/usr/bin/env node
// What extension/sidepanel/screens/runs-list.js is for the tester (#162): the Runs tab — every run in
// the project with its folders, the six status chips above it, and a Load more row that admits only
// part of the list was fetched and says how much. The same search box does two jobs: it narrows the
// loaded rows by title, and it takes a run URL or a bare id copied out of the web app or a CI log and
// opens that run.
// Three things here are easy to get quietly wrong. The chip counts rest on nested fetches that settle
// LATE, so a re-read holds the last settled numbers rather than flashing to zero. A pasted link is
// resolved against the configured host AND project — a foreign host is never opened. And the id probe
// is a debounced read with a token, an epoch and a re-check of the query, so an answer that arrives
// after the tester typed on is dropped instead of painted.
// Rows 1-65 are the ticket's; 66+ are code the ticket left unspoken for. A lettered suffix is the
// companion case that drives the same path the other way, so a row asserting "nothing happened"
// cannot pass against a stub that never worked.
// Rows 1-6 and 92 are gone to tests/runs-paging.test.mjs and rows 21-28, 72-73 and 84 to
// tests/runs-url.test.mjs (#195): the arithmetic and the parsers they drive are their own files now,
// and this one loads both for real, so the rows below still assert against real cursors and the real
// parser — including the line-versus-toast split of row 33.
// Run: node --test tests/runs-list.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';
import { loadInto } from './helpers/shared-harness.mjs';

// The real shared/roving.js, one per load(): its map of wired containers is a singleton, and the
// keyboard row below is worth nothing against a stub. Its own contract is tests/roving.test.mjs.
const roving = () => loadInto({ console }, [['shared/roving.js', 'Roving']]).value;

// A keypress from the row that has focus, which bubbles to the <ul> the helper is delegated on —
// the same trip a real one makes.
const key = (node, k) => fire(node, 'keydown', { key: k, bubbles: true });

const BASE = 'https://app.testomat.io';
const HOST = 'app.testomat.io';
const PROJECT = 'my-project';

// A promise this file resolves by hand: the probe and the strand rows are only about which answer
// lands second.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const run = (id, over = {}) => ({ id, type: 'run', title: `Run ${id}`, status: 'passed', ...over });
const group = (id, over = {}) => ({ id, type: 'rungroup', title: `Group ${id}`, ...over });
// api.js's own shape for a paged folder read: items plus the three cursor numbers.
const page = (items, over = {}) => ({ items, page: 1, total: items.length, totalPages: 1, ...over });

// A list the screen BUILT (every "Load more" spread happens inside the vm) carries that realm's
// Array prototype, which deepEqual refuses; read it back through this realm's own spread.
const idsOf = (list) => [...(list || [])].map((it) => it.id);

// The panel globals runs-list.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the screens beside this one land in parallel.
function load(opts = {}) {
  const o = {
    view: 'runs',
    listMode: 'dashboard',
    settings: { baseUrl: BASE, projectId: PROJECT },
    filter: 'all',
    search: '',
    dashItems: [],
    lastRuns: [],
    lastGroups: [],
    expandedGroups: [],
    childrenCache: {},
    subgroupsCache: {},
    descendantRuns: {},
    descendantsSettled: true,
    descendantsPartial: false,
    groupPaging: {},
    listPaging: {},
    v2RunsPaging: {},
    v2GroupsPaging: {},
    chipCounts: null,
    projects: [],
    epoch: 1,
    jwt: true,          // what TestomatAPI.jwtAvailable() answers
    gate: false,        // what readonlyGate() answers on the Runs screen
    without: [],        // ids to leave out of the page
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  const add = (key, tag, props) => {
    if (o.without.includes(props.id)) return;
    node[key] = el(tag, props);
    doc.body.append(node[key]);
  };
  // index.html's shape (:302-330), cut to the nodes this screen touches.
  add('list', 'ul', { id: 'runs-list' });
  add('status', 'div', { id: 'runs-status' });
  add('filter', 'div', { id: 'runs-filter' });
  add('search', 'input', { id: 'runs-search', value: o.search });
  add('searchClear', 'button', { id: 'runs-search-clear', hidden: true });
  add('newRun', 'a', { id: 'btn-new-run', hidden: true });

  const calls = {
    order: [],       // one ordered trace, for the rows that assert "before", not merely "both"
    shows: [],
    lines: [],       // { id, text, cls }
    toasts: [],      // { msg, opts } — `opts` undefined is the missing {error:true}, a row of its own
    tabCounts: [],
    counters: [],    // every value paintCounter painted, in chip order
    fits: 0,
    apiErrors: [],   // { kind, message, id }
    skeleton: [],    // ['show'|'hide', view]
    persists: 0,
    capabilities: 0, // applyCapabilities()
    blocks: 0,
    gates: 0,
    settingsForms: 0,
    projectRefreshes: 0,
    switches: [],    // switchProject(id)
    opened: [],      // openRunView(id, title)
    projectInfo: 0,
    projectUsers: 0,
    scrolls: [],     // whatever scrollIntoView was handed, per row
    icons: [],       // { name, size, cls } — svgIcon's ARITY is the contract, so cls stays a list
    empties: [],     // { tag, icon, title, text, live, compact, className }
    api: [],         // one ordered trace of every TestomatAPI call: [name, ...args]
    renders: 0,      // only counted once stubRenderList() is on
  };

  // mini-dom has no layout, and highlightGroup scrolls the row it flashed.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = (arg) => { calls.scrolls.push(plain(arg)); calls.order.push('scroll'); };
    return made;
  };
  for (const n of Object.values(node)) n.scrollIntoView = (arg) => { calls.scrolls.push(plain(arg)); };

  const state = {
    view: o.view,
    settings: o.settings,
    projectEpoch: o.epoch,
    projects: o.projects,
    runsFilter: o.filter,
    runsSearch: o.search,
    expandedGroups: o.expandedGroups,
    lastRuns: o.lastRuns,
    lastGroups: o.lastGroups,
    listMode: o.listMode,
    dashItems: o.dashItems,
    childrenCache: o.childrenCache,
    subgroupsCache: o.subgroupsCache,
    loadingGroup: {},
    descendantRuns: o.descendantRuns,
    descendantsSettled: o.descendantsSettled,
    descendantsPartial: o.descendantsPartial,
    descLoadToken: 0,
    descInFlight: 0,
    runsChipCounts: o.chipCounts,
    listPaging: o.listPaging,
    v2RunsPaging: o.v2RunsPaging,
    v2GroupsPaging: o.v2GroupsPaging,
    groupPaging: o.groupPaging,
    highlightedGroup: null,
  };

  // Reassignable after load(), so a test can answer the second read differently from the first, or
  // change the world from inside a call the screen is awaiting.
  const on = {
    dashboard: async () => ({ items: [], page: 1, total: 0, totalPages: 1 }),
    listRuns: async () => ({ data: [] }),
    listRunGroups: async () => ({ data: [] }),
    countRuns: async () => 0,
    nested: async () => [],
    subgroups: async () => page([]),
    children: async () => page([]),
    getRun: async () => ({ id: 'x', title: 'A run' }),
    getRunGroup: async () => ({ path: [] }),
    refreshProjects: async () => o.projects,
    switchProject: async () => {},
  };
  const trace = (name, fn) => async (...args) => {
    calls.api.push([name, ...(plain(args) ?? [])]);
    calls.order.push(name);
    return fn(...args);
  };

  // shared/empty-state.js's own shape, cut to what this screen reads back: the `.md-icon` inside the
  // mark (groupEmptyRow adds `spin` to it) and the actions, which carry real listeners.
  const buildEmpty = (spec = {}) => {
    calls.empties.push({
      tag: spec.tag, icon: spec.icon, title: spec.title, text: spec.text,
      live: !!spec.live, compact: !!spec.compact, className: spec.className || '',
    });
    const box = doc.createElement(spec.tag || 'div');
    box.className = `empty${spec.compact ? ' compact' : ''}${spec.className ? ` ${spec.className}` : ''}`;
    if (spec.live) box.setAttribute('role', 'status');
    if (spec.icon) {
      const mark = doc.createElement('span');
      mark.className = 'empty-mark';
      mark.append(el('span', { className: 'md-icon', dataset: { icon: spec.icon } }));
      box.append(mark);
    }
    const heading = doc.createElement('p');
    heading.className = 'empty-title';
    heading.textContent = spec.title || '';
    const body = doc.createElement('p');
    body.className = 'empty-text';
    for (const part of [].concat(spec.text ?? [])) {
      if (part == null || part === '') continue;
      body.append(typeof part === 'string' ? doc.createTextNode(part) : part);
    }
    const actions = doc.createElement('div');
    actions.className = 'empty-actions';
    for (const act of [].concat(spec.actions ?? []).filter(Boolean)) actions.append(act);
    box.append(heading, body, actions);
    return box;
  };

  const globals = {
    state,
    Roving: roving(),
    capabilities: { jwt: null, readonly: false },
    $: (id) => doc.getElementById(id),
    show: (view) => { calls.shows.push(view); calls.order.push(`show:${view}`); },
    // `opts` crosses the vm realm, so it is stored as plain JSON — and stays `undefined` when the
    // caller passed none, which is what the two "no {error:true}" rows read.
    toast: (msg, toastOpts) => { calls.toasts.push({ msg, opts: plain(toastOpts) }); calls.order.push('toast'); },
    setStatusLine: (id, text, cls = '') => {
      calls.lines.push({ id, text, cls });
      calls.order.push(`line:${id}`);
      const n = doc.getElementById(id);
      // The real one writes both, and loadDescendantRuns READS the class back to re-assert an error.
      if (n) { n.textContent = text; n.classList.toggle('error', cls === 'error'); }
    },
    setTabCount: (tab, n) => { calls.tabCounts.push([tab, n]); },
    paintCounter: (box, value) => { calls.counters.push(value); if (box) box.textContent = String(value); },
    fitFilterChips: () => { calls.fits += 1; },
    staleProject: (epoch) => epoch !== state.projectEpoch,
    persistSession: () => { calls.persists += 1; calls.order.push('persist'); },
    applyCapabilities: () => { calls.capabilities += 1; calls.order.push('capabilities'); },
    applyReadonlyBlock: () => { calls.blocks += 1; calls.order.push('block'); },
    readonlyGate: async () => { calls.gates += 1; calls.order.push('gate'); return o.gate; },
    isReadonlyError: (e) => e?.kind === 'readonly',
    handleApiError: (e, id) => {
      calls.apiErrors.push({ kind: e?.kind, message: e?.message ?? String(e), id });
      calls.order.push('apiError');
    },
    loadProjectInfo: () => { calls.projectInfo += 1; },
    loadProjectUsers: () => { calls.projectUsers += 1; },
    fillSettingsForm: () => { calls.settingsForms += 1; calls.order.push('settingsForm'); },
    refreshProjects: async () => { calls.projectRefreshes += 1; return on.refreshProjects(); },
    switchProject: async (id) => { calls.switches.push(id); calls.order.push('switch'); return on.switchProject(id); },
    Skeleton: {
      show: (view) => { calls.skeleton.push(['show', view]); return { view }; },
      hide: (handle) => { calls.skeleton.push(['hide', handle ? handle.view : handle]); },
    },
    // The real one writes data-tip on the node it is given (shared/tooltip.js:257); a counter alone
    // could not tell a tip that landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    EmptyState: {
      build: buildEmpty,
      into: (host, spec) => {
        if (!host) return null;
        const built = buildEmpty({ tag: host.tagName === 'UL' || host.tagName === 'OL' ? 'li' : 'div', ...spec });
        host.replaceChildren(built);
        return built;
      },
    },
    TestType: { mark: (kind) => (kind ? el('span', { className: `type-mark ${kind}`, dataset: { kind } }) : null) },

    // ---- core/status-icons.js's vocabulary, STUBBED. Loading the real module here would couple
    // the two test files: its own rows live in tests/status-icons.test.mjs.
    StatusIcons: {
      normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),
      statusIcon: (status) => el('span', {
        className: 'status-icon',
        dataset: { status: status === 'launching' ? 'running' : status || 'unknown' },
      }),
      // Icons.el does `svg.classList.add('md-icon', ...cls)` (shared/icons.js:209) and classList.add
      // THROWS on a token holding a space — so the arity is the contract, and this stub enforces it.
      svgIcon: (name, size = 16, ...cls) => {
        calls.icons.push({ name, size, cls: [...cls] });
        const icon = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        for (const c of cls) {
          if (/\s/.test(String(c))) throw new Error(`svgIcon: "${c}" is not one class token — classList.add throws on that`);
          icon.classList.add(c);
        }
        return icon;
      },
      treeIcon: (name, cls, emoji) => el('span', { className: `tree-icon ${cls}`, dataset: { icon: name, emoji: emoji || '' } }),
      runKind: (kind) => (['manual', 'automated', 'mixed'].includes(String(kind || '').toLowerCase())
        ? String(kind).toLowerCase()
        : null),
      CHEVRON: 'chevron_right',
      FOLDER: 'tree_folder',
    },
    // run-view.js's own, and still a late-bound global: runs-list.js loads BEFORE that screen.
    openRunView: async (id, title) => { calls.opened.push([id, title]); calls.order.push('openRun'); },

    TestomatAPI: {
      jwtAvailable: () => o.jwt,
      fetchDashboardPage: trace('fetchDashboardPage', (p) => on.dashboard(p)),
      listRuns: trace('listRuns', (p) => on.listRuns(p)),
      listRunGroups: trace('listRunGroups', (p) => on.listRunGroups(p)),
      countRuns: trace('countRuns', () => on.countRuns()),
      fetchGroupRunsNested: trace('fetchGroupRunsNested', (id) => on.nested(id)),
      fetchGroupSubgroups: trace('fetchGroupSubgroups', (id, p) => on.subgroups(id, p)),
      fetchGroupChildren: trace('fetchGroupChildren', (id, p, per) => on.children(id, p, per)),
      getRun: trace('getRun', (id) => on.getRun(id)),
      getRunGroup: trace('getRunGroup', (id) => on.getRunGroup(id)),
    },
  };

  const clock = fakeClock();
  // The screen's own `const` arrows are lexical, not sandbox properties: named here or unreachable.
  // Its three `let`s are not: the probe is read through runIdProbeFor(), the timers through the clock.
  const h = loadScreen('runs-list', {
    globals,
    document: doc,
    clock,
    // The REAL screens/runs-paging.js and screens/runs-url.js, in index.html's own order: every row
    // below is about what this screen DOES with a cursor or a pasted link, so a stub for either
    // would be the thing under assertion (#195).
    before: ['runs-paging', 'runs-url'],
    exported: `({ RUN_FILTERS, FILTER_KEYS, RUNS_FILTER_TINT, LOADING_ICON, filterLabel, matchesFilter,
      runsSearchActive, runsFilterActive, anyRunsConstraint, titleOf, searchNeedle, runMatchesSearch,
      groupTitleMatchesSearch, runPasses, groupSelfHit, runsEmptyMessage, childrenLoaded,
      groupContentsLoaded, isPasteInput, envTags, isExpanded, RunsPaging, RunsUrl,
      renderedGroupRow, runIdProbeFor, RUN_ID_PROBE_MS })`,
  });

  return {
    ...h,
    lex: h.screen,
    state,
    calls,
    on,
    node,
    doc,
    clock,
    // renderList is reached from a dozen places; a load-path row that leaves it real drags the whole
    // renderer (and every DOM stub behind it) into an assertion about a cursor.
    stubRenderList: () => { h.fn.renderList = () => { calls.renders += 1; calls.order.push('render'); }; return calls; },
    // What the tester can actually see in the list, top level only.
    rowIds: () => node.list.children.map((li) => li.dataset.runId ?? li.dataset.groupId ?? null),
    groupRowFor: (id) => node.list.querySelectorAll('li.group').find((li) => String(li.dataset.groupId) === String(id)),
    kidsOf: (li) => li.querySelector('.group-children'),
    // A run row wherever it sits — top level or inside a folder.
    rowFor: (id) => node.list.querySelector(`li[data-run-id="${id}"]`),
    // Every row's tabindex in document order — the shape the roving model is about.
    rowTabs: () => node.list.querySelectorAll('li[data-run-id], .group-head').map((r) => r.getAttribute('tabindex')),
    chip: (key) => node.filter.querySelector(`[data-filter="${key}"]`),
    chipCount: (key) => node.filter.querySelector(`[data-filter="${key}"] .counter`)?.textContent ?? null,
    // The tester's own act on the field: type (no inputType) or paste (one).
    type: (value) => { node.search.value = value; return fire(node.search, 'input'); },
    paste: (value) => { node.search.value = value; return fire(node.search, 'input', { inputType: 'insertFromPaste' }); },
    // The api trace, names only — the rows that assert "this leg was never called".
    apiNames: () => calls.api.map(([name]) => name),
    toastMsgs: () => calls.toasts.map((t) => t.msg),
    lastLine: (id) => [...calls.lines].reverse().find((l) => l.id === id) ?? null,
  };
}

// ---------- the chips, the counts and the empty messages (rows 13-18) ----------

test('13: the first paint of the chips while the nested counts are still coming rests at 0', () => {
  const h = load({ descendantsSettled: false, lastRuns: [run('a'), run('b', { status: 'failed' })] });
  h.fn.renderFilterChips();
  assert.deepEqual(h.calls.counters, [0, 0, 0, 0, 0, 0]);
  assert.equal(h.state.runsChipCounts, null); // nothing has settled, so nothing is remembered
  // The identical render with the counts settled paints the real numbers — the zeros are a policy,
  // not a chip that never gets a value.
  h.state.descendantsSettled = true;
  h.calls.counters.length = 0;
  h.fn.renderFilterChips();
  assert.deepEqual(h.calls.counters, ['2', '1', '1', '0', '0', '0']); // all, passed, failed, running, …
});

test('14: coming back to the Runs tab holds the last settled counts up instead of flashing to zero', () => {
  const h = load({ lastRuns: [run('a'), run('b', { status: 'failed' })] });
  h.fn.renderFilterChips();
  assert.equal(h.chipCount('all'), '2');
  // The re-read: the nested counts are in flight again and the loaded set is momentarily empty.
  h.state.descendantsSettled = false;
  h.state.lastRuns = [];
  h.fn.renderFilterChips();
  assert.equal(h.chipCount('all'), '2');
  assert.equal(h.chipCount('failed'), '1');
  // …and once it settles the held snapshot is replaced, so this is a hold and not a frozen chip.
  h.state.descendantsSettled = true;
  h.state.lastRuns = [run('c')];
  h.fn.renderFilterChips();
  assert.equal(h.chipCount('all'), '1');
  assert.equal(h.chipCount('failed'), '0');
});

test('15: only runs are counted, and a run that is still launching counts as running', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.statusCounts([
    { status: 'launching' }, { status: 'running' }, { status: 'passed' }, { status: null },
  ])), { all: 4, running: 2, passed: 1, failed: 0, scheduled: 0, terminated: 0 });
});

test('16: a chip key the panel does not own falls back to All, and re-pressing the live chip does nothing', () => {
  const h = load({ filter: 'failed' });
  h.stubRenderList();
  h.fn.setRunsFilter('bogus');
  assert.equal(h.state.runsFilter, 'all');
  assert.equal(h.calls.persists, 1);
  assert.equal(h.calls.renders, 1);
  // Pressing the chip that is already down is an early return: nothing persisted, nothing repainted.
  h.fn.setRunsFilter('all');
  assert.equal(h.calls.persists, 1);
  assert.equal(h.calls.renders, 1);
  // …and a real key still moves it, so the two counts above are a guard and not a dead function.
  h.fn.setRunsFilter('passed');
  assert.equal(h.state.runsFilter, 'passed');
  assert.equal(h.calls.persists, 2);
});

test('17: an empty list names the chip that emptied it, unless a search is what emptied it', () => {
  const h = load({ filter: 'terminated' });
  assert.equal(h.lex.runsEmptyMessage(), 'No terminated runs');
  h.state.runsSearch = 'nightly';
  assert.equal(h.lex.runsEmptyMessage(), 'No runs match');
  // Whitespace alone is not a search, so the chip's own message comes back.
  h.state.runsSearch = '   ';
  assert.equal(h.lex.runsEmptyMessage(), 'No terminated runs');
});

test('18: a filter key with no label of its own is printed as itself rather than as undefined', () => {
  const h = load();
  assert.equal(h.lex.filterLabel('unknownKey'), 'unknownKey');
  assert.equal(h.lex.filterLabel('terminated'), 'Terminated');
});

// ---------- what the search matches (rows 19-20) ----------

test('19: a run answers to its id as well as its title, case-folded — the id pasted from a CI log', () => {
  const h = load({ search: '9F8E' });
  h.state.runsSearch = '9F8E';
  assert.equal(h.lex.runMatchesSearch({ id: '9f8e7d6c', title: 'Nightly' }), true);
  assert.equal(h.lex.runMatchesSearch({ id: 'aaaaaaaa', title: 'Nightly' }), false);
  // clean_title wins over title, and an empty search matches everything.
  h.state.runsSearch = 'smoke';
  assert.equal(h.lex.runMatchesSearch({ id: 'x', clean_title: 'Smoke', title: 'Nightly' }), true);
  h.state.runsSearch = '';
  assert.equal(h.lex.runMatchesSearch({ id: 'x', title: 'Nightly' }), true);
});

test('20: a folder answers to its title only — an id belongs to a run, not to a folder', () => {
  const h = load();
  h.state.runsSearch = '9f8e';
  assert.equal(h.lex.groupTitleMatchesSearch({ id: '9f8e7d6c', title: 'Sprint 9' }), false);
  h.state.runsSearch = 'sprint';
  assert.equal(h.lex.groupTitleMatchesSearch({ id: '9f8e7d6c', title: 'Sprint 9' }), true);
});

// ---------- what the renderers decide (rows 44-50, 66-71) ----------

test('44: a run whose folder is not in the loaded list renders top-level instead of vanishing', () => {
  const h = load({ listMode: 'v2' });
  h.fn.renderRuns([run('r1', { rungroup_id: 'nested-somewhere' })], []);
  assert.deepEqual(h.rowIds(), ['r1']);
  // The same run WITH its folder loaded nests inside it, so the row above is a fallback and not
  // a renderer that ignores rungroup_id.
  h.fn.renderRuns([run('r1', { rungroup_id: 'g1' })], [group('g1')]);
  assert.deepEqual(h.rowIds(), ['g1']);
  assert.deepEqual(h.kidsOf(h.groupRowFor('g1')).children.map((li) => li.dataset.runId), ['r1']);
});

test('45: an archived folder is dropped from the list AND from the tester’s expanded folders', () => {
  const h = load({ listMode: 'v2', expandedGroups: ['g1', 'g2'] });
  h.fn.renderRuns([], [group('g1'), group('g2', { archived_at: '2026-01-01T00:00:00Z' })]);
  assert.deepEqual(h.rowIds(), ['g1']);
  assert.deepEqual([...h.state.expandedGroups], ['g1']);
  // A run that belonged to the archived folder does not vanish with it — it goes top-level.
  h.fn.renderRuns([run('r1', { rungroup_id: 'g2' })], [group('g1'), group('g2', { archived_at: 'x' })]);
  assert.deepEqual(h.rowIds(), ['g1', 'r1']);
});

test('46: a run held in three caches at once is counted once, and the folder’s own copy is the one kept', () => {
  const h = load({
    dashItems: [run('r1', { title: 'from the dashboard' })],
    descendantRuns: { g1: [{ id: 'r1', title: 'from the nested count', status: 'passed' }] },
    childrenCache: { g1: [{ id: 'r1', title: 'from the folder', status: 'passed' }] },
  });
  h.fn.renderDashboard();
  assert.equal(h.state.lastRuns.length, 1);
  assert.equal(h.state.lastRuns[0].title, 'from the folder');
  // Without the folder cache the descendant copy wins — so the line above is an ORDER, not a tie.
  h.state.childrenCache = {};
  h.fn.renderDashboard();
  assert.equal(h.state.lastRuns[0].title, 'from the nested count');
});

test('47: a folder stays in the list when the only match sits in a sub-folder two levels down', () => {
  const h = load({
    search: 'needle',
    subgroupsCache: { g1: [group('g2')], g2: [group('g3')] },
    childrenCache: { g3: [run('r9', { title: 'the needle' })] },
  });
  h.state.runsSearch = 'needle';
  assert.equal(h.fn.groupPasses(group('g1')), true);
  // A folder whose whole subtree misses is dropped, so the recursion is a search and not a yes-man.
  assert.equal(h.fn.groupPasses(group('other')), false);
});

test('48: with no chip and no search every folder passes at once, without walking a single cache', () => {
  const h = load({ subgroupsCache: { g1: [group('g2')] } });
  assert.equal(h.fn.groupPasses(group('g1')), true);
  assert.equal(h.fn.groupPasses(group('empty')), true);
  // Turn one constraint on and the same empty folder is dropped.
  h.state.runsFilter = 'failed';
  assert.equal(h.fn.groupPasses(group('empty')), false);
});

test('49: a folder found BY ITS NAME shows all its runs — but the status chip still applies to them', () => {
  const h = load({
    childrenCache: { g1: [run('r1', { title: 'Alpha', status: 'failed' }), run('r2', { title: 'Beta', status: 'passed' })] },
  });
  h.state.runsSearch = 'sprint';
  h.state.runsFilter = 'failed';
  const li = h.fn.dashGroupRow(group('g1', { title: 'Sprint 9', status: 'failed' }));
  assert.deepEqual(h.kidsOf(li).children.map((n) => n.dataset.runId), ['r1']);
  // Same folder, chip off: BOTH runs come back, neither of which matches "sprint" itself.
  h.state.runsFilter = 'all';
  const both = h.fn.dashGroupRow(group('g1', { title: 'Sprint 9' }));
  assert.deepEqual(h.kidsOf(both).children.map((n) => n.dataset.runId), ['r1', 'r2']);
});

test('50: a folder the tester just opened says "Loading runs…", not that it has none', () => {
  const h = load({ expandedGroups: ['g1'] });
  const li = h.fn.dashGroupRow(group('g1'));
  assert.equal(h.calls.empties.at(-1).text, 'Loading runs…');
  assert.equal(h.kidsOf(li).querySelector('.md-icon').classList.contains('spin'), true);
  // A folder that IS loaded and really is empty says so — and its glyph does not spin.
  h.state.subgroupsCache.g1 = [];
  h.state.childrenCache.g1 = [];
  const done = h.fn.dashGroupRow(group('g1'));
  assert.equal(h.calls.empties.at(-1).text, 'No runs loaded for this group.');
  assert.equal(h.kidsOf(done).querySelector('.md-icon').classList.contains('spin'), false);
});

test('66: the env pills split api.js’s one joined string, and a run with no env grows no pills', () => {
  const h = load();
  assert.deepEqual([...h.lex.envTags('chrome, firefox ,, safari')], ['chrome', 'firefox', 'safari']);
  assert.deepEqual([...h.lex.envTags('')], []);
  assert.deepEqual([...h.lex.envTags(null)], []);
  // Only a CHILD row wears them — a top-level run row draws none.
  const child = h.fn.runRow(run('r1', { env: 'chrome,firefox' }), { child: true });
  assert.deepEqual(child.querySelectorAll('.badge.env').map((n) => n.textContent), ['chrome', 'firefox']);
  assert.deepEqual(child.querySelectorAll('.badge.env').map((n) => n.dataset.tip), ['chrome', 'firefox']);
  assert.deepEqual(h.fn.runRow(run('r2', { env: 'chrome' })).querySelectorAll('.badge.env'), []);
});

test('67: a folder shows its run count only when the server sent one, and says "1 run" for one', () => {
  const h = load();
  assert.equal(h.fn.groupHead(group('g1', { runs_count: 1 })).querySelector('.row-count').textContent, '1 run');
  assert.equal(h.fn.groupHead(group('g1', { runs_count: 4 })).querySelector('.row-count').textContent, '4 runs');
  assert.equal(h.fn.groupHead(group('g1', { runs_count: 0 })).querySelector('.row-count').textContent, '0 runs');
  assert.equal(h.fn.groupHead(group('g1')).querySelector('.row-count'), null);
});

test('68: a chip carries its own count tint and presses the filter it is labelled with', () => {
  const h = load();
  h.stubRenderList();
  assert.equal(h.fn.buildFilterChip('passed', 'Passed').querySelector('.counter').className, 'counter passed');
  assert.equal(h.fn.buildFilterChip('failed', 'Failed').querySelector('.counter').className, 'counter failed');
  assert.equal(h.fn.buildFilterChip('running', 'Running').querySelector('.counter').className, 'counter');
  const chip = h.fn.buildFilterChip('scheduled', 'Scheduled');
  fire(chip, 'click');
  assert.equal(h.state.runsFilter, 'scheduled');
});

test('69: the chip row is updated in place, so pressing one never rebuilds the six buttons', () => {
  const h = load({ lastRuns: [run('a')] });
  h.fn.renderFilterChips();
  const first = h.chip('all');
  assert.equal(h.chip('all').getAttribute('aria-pressed'), 'true');
  assert.equal(h.chip('all').classList.contains('selected'), true);
  assert.equal(h.chip('passed').classList.contains('secondary'), true);
  h.state.runsFilter = 'passed';
  h.fn.renderFilterChips();
  assert.equal(h.chip('all'), first);                       // the same button object, moved not rebuilt
  assert.equal(h.chip('all').getAttribute('aria-pressed'), 'false');
  assert.equal(h.chip('passed').classList.contains('selected'), true);
  assert.equal(h.chip('passed').classList.contains('secondary'), false);
  assert.equal(h.node.filter.children.length, 6);
  assert.equal(h.calls.fits, 2);                            // the row is re-measured on every render
});

test('70: opening a folder remembers it and reads its contents; closing it forgets it and reads nothing', async () => {
  const h = load();
  h.stubRenderList();
  const li = el('li', { className: 'group' });
  h.fn.toggleGroup('g1', li);
  assert.deepEqual([...h.state.expandedGroups], ['g1']);   // mutated in place…
  assert.equal(h.calls.persists, 1);                       // …AND persisted
  assert.equal(li.classList.contains('expanded'), true);
  await settle();
  assert.deepEqual(h.apiNames(), ['fetchGroupSubgroups', 'fetchGroupChildren']);
  h.fn.toggleGroup('g1', li);
  assert.deepEqual([...h.state.expandedGroups], []);
  assert.equal(h.calls.persists, 2);
  assert.equal(li.classList.contains('expanded'), false);
  await settle();
  assert.equal(h.apiNames().length, 2);                    // closing reads nothing
});

test('71: a folder already read is not read again when the tester opens it a second time', async () => {
  const h = load({ subgroupsCache: { g1: [] }, childrenCache: { g1: [] } });
  h.stubRenderList();
  const li = el('li', { className: 'group' });
  h.fn.toggleGroup('g1', li);
  await settle();
  assert.deepEqual(h.apiNames(), []);
  // In the degraded v2 mode there is nothing to lazily read at all, so it is skipped there too.
  h.state.expandedGroups.length = 0;
  h.state.listMode = 'v2';
  h.state.subgroupsCache = {};
  h.state.childrenCache = {};
  h.fn.toggleGroup('g1', li);
  await settle();
  assert.deepEqual(h.apiNames(), []);
});

// ---------- the two jobs of the search field (rows 29-32, 74-77) ----------

test('29: paste and drop arrive carrying an inputType; a typed character does not', () => {
  const h = load();
  assert.equal(h.lex.isPasteInput({ inputType: 'insertFromPasteAsQuotation' }), true);
  assert.equal(h.lex.isPasteInput({ inputType: 'insertFromPaste' }), true);
  assert.equal(h.lex.isPasteInput({ inputType: 'insertFromDrop' }), true);
  assert.equal(h.lex.isPasteInput({ inputType: 'insertText' }), false);
  assert.equal(h.lex.isPasteInput({}), false);
  assert.equal(h.lex.isPasteInput(null), false);
});

test('30: a URL TYPED into the field is not a search and does not navigate — half of one is not a link', () => {
  const h = load({ search: 'nigh' });
  h.state.runsSearch = 'nigh';
  h.node.search.addEventListener('input', h.fn.onRunsSearch);
  h.stubRenderList();
  h.type(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`);
  assert.equal(h.state.runsSearch, '');        // the URL is never used as a title filter
  assert.equal(h.calls.renders, 1);            // the list did re-render — 'nigh' had matched rows
  assert.deepEqual(h.apiNames(), []);          // …and nothing was opened
  assert.equal(h.node.searchClear.hidden, false);
});

test('31: the same URL PASTED opens the run it names', async () => {
  const h = load();
  h.node.search.addEventListener('input', h.fn.onRunsSearch);
  h.stubRenderList();
  h.on.getRun = async () => ({ id: '9f8e7d6c', clean_title: 'Nightly' });
  h.paste(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`);
  await settle();
  assert.deepEqual(h.calls.api, [['getRun', '9f8e7d6c']]);
  assert.deepEqual(h.calls.opened, [['9f8e7d6c', 'Nightly']]);
  assert.equal(h.state.runsSearch, '');
});

test('32: Enter on a bare id opens that run and stops the field from doing anything else', async () => {
  const h = load();
  h.node.search.addEventListener('keydown', h.fn.onRunsSearchKeydown);
  h.on.getRun = async () => ({ id: '9f8e7d', title: 'By id' });
  h.node.search.value = '  9f8e7d  ';
  const ev = fire(h.node.search, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  await settle();
  assert.deepEqual(h.calls.api, [['getRun', '9f8e7d']]);  // trimmed
  assert.deepEqual(h.calls.opened, [['9f8e7d', 'By id']]);
});

test('74: Enter on a plain title, and any other key, leave the field alone', async () => {
  const h = load();
  h.node.search.addEventListener('keydown', h.fn.onRunsSearchKeydown);
  h.node.search.value = 'nightly regression';
  assert.equal(fire(h.node.search, 'keydown', { key: 'Enter' }).defaultPrevented, false);
  h.node.search.value = '9f8e7d';
  assert.equal(fire(h.node.search, 'keydown', { key: 'a' }).defaultPrevented, false);
  await settle();
  assert.deepEqual(h.apiNames(), []);
});

test('75: Enter on a pasted URL opens it too, without waiting for a second paste event', async () => {
  const h = load();
  h.node.search.addEventListener('keydown', h.fn.onRunsSearchKeydown);
  h.stubRenderList();
  h.node.search.value = `${BASE}/projects/${PROJECT}/runs/groups/12`;
  const ev = fire(h.node.search, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  await settle();
  assert.deepEqual(h.calls.shows, ['runs']);  // the folder path shows the list before anything fails
});

test('76: clearing the field empties the search, hides the clear button and puts the caret back', () => {
  const h = load({ search: 'nightly' });
  h.state.runsSearch = 'nightly';
  h.node.searchClear.hidden = false;
  h.stubRenderList();
  h.fn.clearRunsSearch();
  assert.equal(h.state.runsSearch, '');
  assert.equal(h.node.search.value, '');
  assert.equal(h.node.searchClear.hidden, true);
  assert.equal(h.calls.renders, 1);
  assert.equal(h.doc.activeElement, h.node.search);
});

test('77: the field is re-read FROM state, because a project switch clears the query behind its back', () => {
  const h = load({ search: 'nightly' });
  h.node.search.value = 'nightly';
  h.node.searchClear.hidden = false;
  h.state.runsSearch = '';          // what resetProjectScopedState does
  h.fn.syncRunsSearchInput();
  assert.equal(h.node.search.value, '');
  assert.equal(h.node.searchClear.hidden, true);
  // Coming back to the screen with a live query puts it back in the field and shows the clear.
  h.state.runsSearch = 'smoke';
  h.fn.syncRunsSearchInput();
  assert.equal(h.node.search.value, 'smoke');
  assert.equal(h.node.searchClear.hidden, false);
});

// ---------- opening what was pasted (rows 33-37, 78-82) ----------

const notFound = (h) => new h.ApiError('notfound', 404, 'Not Found');
const offline = (h) => new h.ApiError('network', 0, 'Failed to fetch');

test('33: an id that names no run leaves the tester on the list, told so on the list’s own line', async () => {
  const h = load();
  h.on.getRun = async () => { throw notFound(h); };
  assert.equal(await h.fn.openParsedRunTarget({ kind: 'run', id: 'deadbeef' }), false);
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: 'Run not found', cls: 'error' });
  assert.deepEqual(h.calls.toasts, []);   // a toast is wiped by the next one; the line is not
  assert.deepEqual(h.calls.opened, []);
  // The same miss while the tester is NOT on the runs list can only be a toast — a line on a
  // hidden view would be invisible.
  h.state.view = 'test';
  h.calls.lines.length = 0;
  assert.equal(await h.fn.openParsedRunTarget({ kind: 'run', id: 'deadbeef' }), false);
  assert.deepEqual(h.calls.lines, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Run not found', opts: { error: true } }]);
});

test('34: a run that could not be READ says why — a dropped connection is not "Run not found"', async () => {
  const h = load();
  h.on.getRun = async () => { throw offline(h); };
  assert.equal(await h.fn.openParsedRunTarget({ kind: 'run', id: '9f8e7d6c' }), false);
  assert.deepEqual(h.calls.apiErrors, [{ kind: 'network', message: 'Failed to fetch', id: 'runs-status' }]);
  assert.deepEqual(h.toastMsgs(), []);
  assert.deepEqual(h.calls.opened, []);
});

test('35: a run that lives on another host sends the tester to Settings, and says which two hosts', async () => {
  const h = load();
  assert.equal(await h.fn.openRunFromUrl('https://other.testomat.io/projects/abc/runs/9f8e7d6c'), true);
  assert.equal(h.calls.settingsForms, 1);
  assert.deepEqual(h.calls.shows, ['settings']);
  assert.deepEqual(h.lastLine('settings-status'), {
    id: 'settings-status',
    text: `This panel is connected to ${HOST}, and that run lives on other.testomat.io — connect to it to open the run here`,
    cls: 'error',
  });
  assert.deepEqual(h.apiNames(), []);   // nothing is read from a host we are not connected to
});

test('36: a run in a project the tester has no access to is refused, and no project is switched', async () => {
  const h = load({ projects: [{ id: PROJECT }] });
  assert.equal(await h.fn.openRunFromUrl(`${BASE}/projects/stranger/runs/9f8e7d6c`), false);
  assert.deepEqual(h.calls.toasts, [{ msg: 'No access to project stranger', opts: { error: true } }]);
  assert.deepEqual(h.calls.switches, []);
  assert.deepEqual(h.apiNames(), []);
});

test('37: a run in another project the tester DOES have switches project first, then opens the run', async () => {
  const h = load({ projects: [{ id: PROJECT }, { id: 'other-project' }] });
  h.on.getRun = async () => ({ id: '9f8e7d6c', clean_title: 'Nightly' });
  assert.equal(await h.fn.openRunFromUrl(`${BASE}/projects/other-project/runs/9f8e7d6c`), true);
  assert.deepEqual(h.calls.switches, ['other-project']);
  assert.deepEqual(h.calls.opened, [['9f8e7d6c', 'Nightly']]);
  assert.deepEqual(h.calls.order.filter((s) => ['switch', 'getRun', 'openRun'].includes(s)),
    ['switch', 'getRun', 'openRun']);
});

test('78: a pasted FOLDER link lands on the runs list before anything can fail, and reports landing', async () => {
  const h = load({ dashItems: [group('12')] });
  h.on.dashboard = async () => ({ items: [group('12')], page: 1, total: 1, totalPages: 1 });
  assert.equal(await h.fn.openParsedRunTarget({ kind: 'group', id: '12' }), true);
  assert.deepEqual(h.calls.shows, ['runs']);
  assert.deepEqual(h.calls.opened, []);   // a folder is not a run view
});

test('79: a pasted value the panel cannot resolve is reported without a single request going out', async () => {
  const h = load();
  h.node.search.value = 'https://evil.example/projects/abc/runs/9f8e7d6c';
  await h.fn.openRunsSearchUrl();
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: 'Run not found', cls: 'error' });
  assert.deepEqual(h.apiNames(), []);
  // The same field holding a link this panel DOES own reads the run, so the silence above is a guard.
  h.node.search.value = `${BASE}/projects/${PROJECT}/runs/9f8e7d6c`;
  await h.fn.openRunsSearchUrl();
  assert.deepEqual(h.apiNames(), ['getRun']);
});

test('80: "Run in Extension" carrying something that is not a link lands the panel nowhere', async () => {
  const h = load();
  assert.equal(await h.fn.openRunFromUrl('not a url'), false);
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: 'Run not found', cls: 'error' });
  assert.deepEqual(h.calls.shows, []);
});

test('81: a panel not connected anywhere yet is asked to connect to the host the link names', async () => {
  const h = load({ settings: { baseUrl: '', projectId: '' } });
  assert.equal(await h.fn.openRunFromUrl(`${BASE}/projects/abc/runs/9f8e7d6c`), true);
  assert.deepEqual(h.lastLine('settings-status'), {
    id: 'settings-status',
    text: `Connect this panel to ${HOST} to open that run here`,
    cls: 'error',
  });
});

test('82: an empty project list on boot means "not read yet", so the projects are re-read before refusing', async () => {
  const h = load({ projects: [] });
  h.on.refreshProjects = async () => [{ id: 'other-project' }];
  h.on.getRun = async () => ({ id: '9f8e7d6c', title: 'Nightly' });
  assert.equal(await h.fn.openRunFromUrl(`${BASE}/projects/other-project/runs/9f8e7d6c`), true);
  assert.equal(h.calls.projectRefreshes, 1);
  assert.deepEqual(h.calls.switches, ['other-project']);
  // With the list already in memory the re-read is skipped.
  const h2 = load({ projects: [{ id: 'other-project' }] });
  h2.on.getRun = async () => ({ id: '9f8e7d6c', title: 'Nightly' });
  await h2.fn.openRunFromUrl(`${BASE}/projects/other-project/runs/9f8e7d6c`);
  assert.equal(h2.calls.projectRefreshes, 0);
});

// ---------- finding a run by its id (rows 38-43, 83, 85) ----------
// fakeClock.tick() AWAITS each callback, so a probe whose read is deliberately left hanging is
// ticked WITHOUT awaiting and joined once the answer has landed.

test('38: typing on restarts the wait, and once the read is out a repeat of the same id is a no-op', async () => {
  const h = load();
  h.stubRenderList();
  h.fn.syncRunIdProbe('9f8e7d');
  assert.deepEqual(h.clock.arms(), [500]);
  const first = h.clock.armed[0].id;
  h.fn.syncRunIdProbe('9f8e7d');
  assert.deepEqual(h.clock.arms(), [500, 500]);  // debounced: re-armed, not doubled
  assert.equal(h.clock.count(), 1);
  assert.ok(h.clock.cleared.includes(first));
  // The wait elapses and the read goes out; now the same query really is a no-op.
  const gate = deferred();
  h.on.getRun = () => gate.promise;
  const fired = h.clock.tick();
  assert.deepEqual(h.apiNames(), ['getRun']);
  h.fn.syncRunIdProbe('9f8e7d');
  assert.equal(h.clock.count(), 0);
  assert.deepEqual(h.clock.arms(), [500, 500]);  // no third arming
  gate.resolve({ id: '9f8e7d' });
  await fired;
  assert.deepEqual(h.apiNames(), ['getRun']);
});

test('39: deleting the id back out of the field drops the wait, and the read already out is stranded', async () => {
  const h = load();
  h.stubRenderList();
  h.fn.syncRunIdProbe('9f8e7d');
  h.fn.syncRunIdProbe(null);
  assert.equal(h.clock.count(), 0);
  await h.clock.tick();
  assert.deepEqual(h.apiNames(), []);          // the armed read never went out
  // And the same with the read already on the wire: the answer that lands afterwards is dropped.
  const gate = deferred();
  h.on.getRun = () => gate.promise;
  h.fn.syncRunIdProbe('9f8e7d');
  const fired = h.clock.tick();
  h.state.runsSearch = '9f8e7d';
  assert.ok(h.lex.runIdProbeFor('9f8e7d'));    // it IS on the wire
  h.fn.syncRunIdProbe(null);
  assert.equal(h.lex.runIdProbeFor('9f8e7d'), null);
  gate.resolve({ id: '9f8e7d', title: 'Nightly' });
  await fired;
  assert.equal(h.lex.runIdProbeFor('9f8e7d'), null);
  assert.equal(h.calls.renders, 0);
});

test('40: an answer that lands after the tester moved on is discarded — query, project and token all', async () => {
  // (a) the query moved on: the run is never written into the probe, so no row can be painted from it
  const a = load();
  a.stubRenderList();
  a.state.runsSearch = '9f8e7d';
  const gateA = deferred();
  a.on.getRun = () => gateA.promise;
  a.fn.syncRunIdProbe('9f8e7d');
  const firedA = a.clock.tick();
  a.state.runsSearch = 'nightly';
  gateA.resolve({ id: '9f8e7d', title: 'Nightly' });
  await firedA;
  assert.deepEqual(plain(a.lex.runIdProbeFor('9f8e7d')), { query: '9f8e7d', epoch: 1, pending: true, run: null });
  assert.equal(a.calls.renders, 0);

  // (b) the project switched under it — the epoch voids the record whatever it holds
  const b = load();
  b.stubRenderList();
  b.state.runsSearch = '9f8e7d';
  const gateB = deferred();
  b.on.getRun = () => gateB.promise;
  b.fn.syncRunIdProbe('9f8e7d');
  const firedB = b.clock.tick();
  b.state.projectEpoch = 2;
  gateB.resolve({ id: '9f8e7d' });
  await firedB;
  assert.equal(b.lex.runIdProbeFor('9f8e7d'), null);
  assert.equal(b.calls.renders, 0);

  // (c) a newer read for a different id took the token: the first answer is dropped whole
  const d = load();
  d.stubRenderList();
  d.state.runsSearch = 'aaaaaa';
  const gateD = deferred();
  d.on.getRun = () => gateD.promise;
  d.fn.syncRunIdProbe('aaaaaa');
  const firedD = d.clock.tick();
  d.state.runsSearch = 'bbbbbb';
  d.fn.syncRunIdProbe('bbbbbb');
  gateD.resolve({ id: 'aaaaaa', title: 'First' });
  await firedD;
  assert.equal(d.lex.runIdProbeFor('aaaaaa'), null);
  assert.equal(d.calls.renders, 0);

  // (d) nothing moved: the same drive DOES remember and repaint, so the three drops above are re-checks.
  const c = load();
  c.stubRenderList();
  c.state.runsSearch = '9f8e7d';
  c.on.getRun = async () => ({ id: '9f8e7d', title: 'Nightly' });
  c.fn.syncRunIdProbe('9f8e7d');
  await c.clock.tick();
  assert.equal(plain(c.lex.runIdProbeFor('9f8e7d')).run.title, 'Nightly');
  assert.equal(c.calls.renders, 1);
});

test('41: a dropped connection is not an answer — the id stays retryable and nothing is painted', async () => {
  const h = load();
  h.stubRenderList();
  h.state.runsSearch = '9f8e7d';
  h.on.getRun = async () => { throw offline(h); };
  h.fn.syncRunIdProbe('9f8e7d');
  await h.clock.tick();
  assert.equal(h.lex.runIdProbeFor('9f8e7d'), null);
  assert.equal(h.calls.renders, 0);
  assert.deepEqual(h.toastMsgs(), []);           // quiet: it fires on a keystroke pause
  // …and asking again really does read again, which is what "retryable" means.
  h.fn.syncRunIdProbe('9f8e7d');
  assert.equal(h.clock.count(), 1);
  await h.clock.tick();
  assert.deepEqual(h.apiNames(), ['getRun', 'getRun']);
});

test('42: an id no run in the project answers is remembered, and the empty state says exactly that', async () => {
  const h = load({ search: '9f8e7d6c', dashItems: [run('r1', { title: 'Alpha' })] });
  h.state.runsSearch = '9f8e7d6c';
  h.on.getRun = async () => { throw notFound(h); };
  h.fn.renderDashboard();
  assert.equal(h.calls.empties.at(-1).text, 'Nothing in the loaded runs matches what you typed.');
  await h.clock.tick();
  assert.deepEqual(plain(h.lex.runIdProbeFor('9f8e7d6c')), { query: '9f8e7d6c', epoch: 1, pending: false, run: null });
  assert.equal(h.calls.empties.at(-1).text,
    'Nothing loaded matches what you typed, and no run in the project has this id.');
  assert.equal(h.calls.empties.at(-1).title, 'No runs match');
  assert.equal(h.calls.empties.at(-1).live, true);
});

test('43: a run found by its id is shown under a "Found by id" label even when the chip would hide it', async () => {
  const h = load({ filter: 'failed', search: '9f8e7d6c', dashItems: [run('r1', { title: 'Alpha', status: 'passed' })] });
  h.state.runsSearch = '9f8e7d6c';
  h.on.getRun = async () => ({ id: '9f8e7d6c', title: 'Nightly', status: 'passed' });
  h.fn.renderDashboard();
  assert.deepEqual(h.rowIds(), [null]);          // only the no-match plaque so far
  await h.clock.tick();
  const rows = h.node.list.children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].className, 'found-by-id');
  assert.equal(rows[0].textContent, 'Found by id');
  assert.equal(rows[1].dataset.runId, '9f8e7d6c');
  // The id line is the only thing on the row naming what was asked for.
  assert.ok(rows[1].querySelectorAll('.meta').some((n) => n.textContent === '9f8e7d6c'));
  // A row NOT found by id carries no such line, so the assertion above is about `showId`.
  assert.deepEqual(h.fn.runRow(run('r1')).querySelectorAll('.meta'), []);
});

test('83: a probe answered before the project switched is never reused for the project after it', async () => {
  const h = load();
  h.stubRenderList();
  h.state.runsSearch = '9f8e7d';
  h.on.getRun = async () => ({ id: '9f8e7d', title: 'Nightly' });
  h.fn.syncRunIdProbe('9f8e7d');
  await h.clock.tick();
  assert.ok(h.lex.runIdProbeFor('9f8e7d'));
  h.state.projectEpoch = 2;
  assert.equal(h.lex.runIdProbeFor('9f8e7d'), null);
  // …so the next render arms a fresh read rather than repainting the other project's answer.
  h.fn.syncRunIdProbe('9f8e7d');
  assert.equal(h.clock.count(), 1);
});

test('85: the no-match plaque offers exactly the constraints that are on, and its buttons undo them', () => {
  const h = load({ search: 'zzz', filter: 'failed' });
  h.state.runsSearch = 'zzz';
  h.stubRenderList();
  const both = h.fn.runsNoMatchEmpty();
  assert.deepEqual(both.querySelectorAll('.empty-actions button').map((b) => b.textContent),
    ['Clear search', 'Show all runs']);
  fire(both.querySelectorAll('.empty-actions button')[1], 'click');
  assert.equal(h.state.runsFilter, 'all');
  fire(both.querySelectorAll('.empty-actions button')[0], 'click');
  assert.equal(h.state.runsSearch, '');
  // With only the chip on there is nothing to clear, and the sentence changes with it.
  h.state.runsFilter = 'failed';
  const chipOnly = h.fn.runsNoMatchEmpty();
  assert.deepEqual(chipOnly.querySelectorAll('.empty-actions button').map((b) => b.textContent), ['Show all runs']);
  assert.equal(h.calls.empties.at(-1).text, 'Nothing loaded so far carries this status.');
  assert.equal(h.calls.empties.at(-1).icon, 'filter_alt_off');
});

// ---------- loading the list and the descendant counts (rows 7-12, 94-96) ----------

test('7: no web session behind the panel degrades to the two v2 reads, and says the counts are complete', async () => {
  const h = load({ jwt: false, listMode: 'v2' });
  h.stubRenderList();
  h.on.dashboard = async () => { throw offline(h); };
  h.on.listRuns = async () => ({ data: [run('r1')], meta: { page: 1, per_page: 10, total: 20 } });
  h.on.listRunGroups = async () => ({ data: [group('g1')], meta: { page: 1, per_page: 10, total: 5 } });
  await h.fn.loadRuns();
  assert.equal(h.state.listMode, 'v2');
  assert.deepEqual(plain(h.state.v2RunsPaging), { page: 1, perPage: 10, total: 20, totalPages: 2 });
  assert.deepEqual(plain(h.state.v2GroupsPaging), { page: 1, perPage: 10, total: 5, totalPages: 1 });
  assert.deepEqual(plain(h.state.listPaging), { page: 1, total: 25, totalPages: 2, loading: false });
  assert.equal(h.state.descendantsSettled, true);   // the flat list is already whole
  assert.equal(h.sandbox.capabilities.jwt, false);
  assert.equal(h.calls.capabilities, 1);
  assert.deepEqual(h.apiNames(), ['fetchDashboardPage', 'listRuns', 'listRunGroups']);
});

test('8: a genuine failure under a working session is surfaced, not quietly degraded', async () => {
  const h = load({ jwt: true, listMode: 'dashboard' });
  h.stubRenderList();
  h.on.dashboard = async () => { throw offline(h); };
  const e = await h.rejection(h.fn.loadRuns());
  assert.equal(e.kind, 'network');
  assert.deepEqual(h.apiNames(), ['fetchDashboardPage']);   // no degraded read behind the tester's back
  assert.equal(h.sandbox.capabilities.jwt, null);
});

test('9: a project switched mid-read throws the answer away — the other project’s rows never land', async () => {
  const h = load({ listMode: 'v2', dashItems: [run('old')] });
  h.stubRenderList();
  h.on.dashboard = async () => { h.state.projectEpoch = 2; return { items: [run('r1')], page: 1, total: 1, totalPages: 1 }; };
  await h.fn.loadRuns();
  assert.equal(h.state.listMode, 'v2');
  assert.deepEqual(h.state.dashItems.map((it) => it.id), ['old']);
  assert.equal(h.calls.capabilities, 0);
  // The v2 leg guards the same way…
  const v = load({ jwt: false, listMode: 'dashboard', lastRuns: [run('old')] });
  v.stubRenderList();
  v.on.dashboard = async () => { throw offline(v); };
  v.on.listRuns = async () => { v.state.projectEpoch = 2; return { data: [run('r1')] }; };
  await v.fn.loadRuns();
  assert.equal(v.state.listMode, 'dashboard');
  assert.deepEqual(v.state.lastRuns.map((r) => r.id), ['old']);
  // …and with the project standing still the identical drive DOES write, so both are real guards.
  const ok = load({ listMode: 'v2' });
  ok.stubRenderList();
  ok.on.dashboard = async () => ({ items: [run('r1')], page: 1, total: 1, totalPages: 1 });
  await ok.fn.loadRuns();
  assert.equal(ok.state.listMode, 'dashboard');
  assert.deepEqual(ok.state.dashItems.map((it) => it.id), ['r1']);
  assert.equal(ok.calls.capabilities, 1);
  // The proven session also warms the two caches a run view would otherwise repaint a round trip in.
  assert.equal(ok.calls.projectInfo, 1);
  assert.equal(ok.calls.projectUsers, 1);
});

test('10: a nested-count batch a fresh load supersedes leaves no in-flight counter behind', async () => {
  const h = load({ dashItems: [group('g1')] });
  h.stubRenderList();
  const gate = deferred();
  h.on.nested = () => gate.promise;
  const stranded = h.fn.loadDescendantRuns();
  assert.equal(h.state.descInFlight, 1);
  assert.equal(h.state.descendantsSettled, false);
  // A fresh load supersedes it: the token bump and the counter reset are the same statement pair,
  // so the strand's skipped decrement cannot take the NEW load's count down with it.
  h.on.dashboard = async () => ({ items: [group('g1')], page: 1, total: 1, totalPages: 1 });
  h.on.nested = async () => [run('r1')];
  await h.fn.loadRuns();
  await settle();
  assert.equal(h.state.descInFlight, 0);
  assert.equal(h.state.descendantsSettled, true);
  gate.resolve([run('stale')]);
  await stranded;
  await settle();
  assert.equal(h.state.descInFlight, 0);
  assert.deepEqual(h.state.descendantRuns.g1.map((r) => r.id), ['r1']);  // the strand wrote nothing
});

test('11: one folder whose count could not be read makes every chip a lower bound, and says so on hover', async () => {
  const h = load({ dashItems: [group('g1'), group('g2')] });
  h.stubRenderList();
  h.on.nested = async (id) => { if (id === 'g2') throw offline(h); return [run('r1')]; };
  await h.fn.loadDescendantRuns();
  assert.deepEqual(plain(h.state.descendantRuns.g2), []);
  assert.equal(h.state.descendantsPartial, true);
  assert.equal(h.state.descendantsSettled, true);
  h.state.lastRuns = [run('r1')];
  h.fn.renderFilterChips();
  assert.equal(h.chipCount('all'), '1+');
  assert.equal(h.node.filter.dataset.tip, 'Some run counts couldn’t load — Refresh to complete them');
  // With both legs answering there is no "+" and no tip, so the two above are the failure's mark.
  const ok = load({ dashItems: [group('g1')], lastRuns: [run('r1')] });
  ok.stubRenderList();
  ok.on.nested = async () => [run('r1')];
  await ok.fn.loadDescendantRuns();
  ok.fn.renderFilterChips();
  assert.equal(ok.chipCount('all'), '1');
  assert.equal(ok.node.filter.dataset.tip, undefined);
});

test('12: with no folder left to count the counts are settled at once — unless a batch is still out', async () => {
  const h = load({ dashItems: [run('r1')] });
  h.stubRenderList();
  h.state.descendantsSettled = false;
  await h.fn.loadDescendantRuns();
  assert.equal(h.state.descendantsSettled, true);
  assert.deepEqual(h.apiNames(), []);

  // …and with one batch still on the wire it waits for it rather than declaring the counts whole.
  const w = load({ dashItems: [group('g1'), group('g2')] });
  w.stubRenderList();
  const gate = deferred();
  w.on.nested = async (id) => (id === 'g2' ? gate.promise : [run('r1')]);
  const batch = w.fn.loadDescendantRuns();
  await settle();
  w.state.dashItems = [group('g1')];   // the re-read came back without g2
  await w.fn.loadDescendantRuns();
  assert.equal(w.state.descendantsSettled, false);
  assert.equal(w.state.descInFlight, 1);
  gate.resolve([]);
  await batch;
  assert.equal(w.state.descendantsSettled, true);
});

test('94: a v2 server that answers with no data envelope at all yields empty lists, not a throw', async () => {
  const h = load();
  h.on.listRuns = async () => null;
  h.on.listRunGroups = async () => ({});
  const out = await h.fn.fetchRunsData(1);
  assert.deepEqual(plain(out.runs), []);
  assert.deepEqual(plain(out.groups), []);
  assert.deepEqual(plain(out.runsCursor), { page: 1, perPage: 1, total: null, totalPages: null });
  assert.deepEqual(h.calls.api, [['listRuns', 1], ['listRunGroups', 1]]);
});

test('95: the Runs tab chip counts the PROJECT’s runs, and simply stays absent when that read fails', async () => {
  const h = load();
  h.on.countRuns = async () => 80;
  await h.fn.loadRunsCount(1);
  assert.deepEqual(h.calls.tabCounts, [['runs', 80]]);
  // A project switched under the read paints nothing…
  h.on.countRuns = async () => { h.state.projectEpoch = 2; return 5; };
  await h.fn.loadRunsCount(1);
  assert.deepEqual(h.calls.tabCounts, [['runs', 80]]);
  // …and neither does a failure, which is swallowed rather than toasted.
  h.state.projectEpoch = 1;
  h.on.countRuns = async () => { throw offline(h); };
  await h.fn.loadRunsCount(1);
  assert.deepEqual(h.calls.tabCounts, [['runs', 80]]);
  assert.deepEqual(h.toastMsgs(), []);
});

test('96: the New run link follows the connected host and project, and hides when there is neither', () => {
  const h = load({ settings: { baseUrl: BASE, projectId: 'my project' } });
  h.fn.renderNewRunLink();
  assert.equal(h.node.newRun.href, `${BASE}/projects/my%20project/runs/new`);
  assert.equal(h.node.newRun.hidden, false);
  h.state.settings = { baseUrl: BASE, projectId: '' };
  h.fn.renderNewRunLink();
  assert.equal(h.node.newRun.getAttribute('href'), null);
  assert.equal(h.node.newRun.hidden, true);
});

// ---------- Load more, folder contents and Refresh (rows 51-57, 86-91, 93) ----------

test('51: under a search the Load more row admits how much of the list was actually searched', () => {
  const h = load({ search: 'nightly' });
  h.state.runsSearch = 'nightly';
  const li = h.fn.loadMoreRow({ remaining: 5, total: 80, loaded: 30, onClick: () => {} });
  assert.equal(li.querySelector('.load-more-text').textContent, 'Load more (5 more)');
  assert.equal(li.querySelector('.load-more-note').textContent, '30 of 80 loaded');
  // The status chip alone is a constraint too, and the label can be overridden per folder.
  h.state.runsSearch = '';
  h.state.runsFilter = 'failed';
  const chipOnly = h.fn.loadMoreRow({ remaining: 0, total: 80, loaded: 30, label: 'More runs', onClick: () => {} });
  assert.equal(chipOnly.querySelector('.load-more-text').textContent, 'More runs');
  assert.equal(chipOnly.querySelector('.load-more-note').textContent, '30 of 80 loaded');
});

test('52: with nothing filtered there is nothing to admit — and an unknown total states no fraction', () => {
  const h = load();
  const plainRow = h.fn.loadMoreRow({ remaining: 5, total: 80, loaded: 30, onClick: () => {} });
  assert.equal(plainRow.querySelector('.load-more-note'), null);
  assert.equal(plainRow.querySelector('.load-more-text').textContent, 'Load more (5 more)');
  // A constraint IS on but the server never said how many there are.
  h.state.runsFilter = 'failed';
  assert.equal(h.fn.loadMoreRow({ remaining: 5, total: null, loaded: 30, onClick: () => {} })
    .querySelector('.load-more-note'), null);
});

test('86: a Load more press that is still running says so, and its spinner classes stay separate tokens', () => {
  const h = load();
  let clicked = 0;
  const li = h.fn.loadMoreRow({ remaining: 0, loading: true, loaded: 30, total: 80, onClick: () => { clicked += 1; } });
  const btn = li.querySelector('button');
  assert.equal(li.querySelector('.load-more-text').textContent, 'Loading…');
  assert.equal(btn.disabled, true);
  assert.equal(btn.dataset.loading, 'true');
  // Icons.el feeds these to classList.add one by one; a joined 'spin load-more-spinner' would throw.
  assert.deepEqual(h.calls.icons.at(-1), { name: 'progress_activity', size: 14, cls: ['spin', 'load-more-spinner'] });
  // An idle row draws no spinner at all, and its button really calls back — without opening the row.
  const idle = h.fn.loadMoreRow({ remaining: 3, loaded: 30, total: 80, onClick: () => { clicked += 1; } });
  assert.equal(idle.querySelector('button').disabled, false);
  assert.equal(idle.querySelector('.md-icon'), null);
  const ev = fire(idle.querySelector('button'), 'click');
  assert.equal(clicked, 1);
  assert.equal(ev.propagationStopped, true);
});

test('53: when only the runs have another page the folders endpoint is left alone entirely', async () => {
  const h = load({
    listMode: 'v2',
    lastRuns: [run('r1')],
    lastGroups: [group('g1')],
    v2RunsPaging: { page: 1, perPage: 1, total: 3, totalPages: 3 },
    v2GroupsPaging: { page: 1, perPage: 1, total: 1, totalPages: 1 },
  });
  h.stubRenderList();
  h.on.listRuns = async () => ({ data: [run('r2')], meta: { page: 2, per_page: 1, total: 3 } });
  await h.fn.loadMoreRuns();
  assert.deepEqual(h.apiNames(), ['listRuns']);
  assert.deepEqual(plain(h.state.v2GroupsPaging), { page: 1, perPage: 1, total: 1, totalPages: 1 });
  assert.deepEqual(idsOf(h.state.lastRuns), ['r1', 'r2']);
  assert.deepEqual(plain(h.state.v2RunsPaging), { page: 2, perPage: 1, total: 3, totalPages: 3 });
  // With BOTH sources holding a tail both are read, so the single name above is a decision.
  h.state.v2GroupsPaging = { page: 1, perPage: 1, total: 4, totalPages: 4 };
  h.on.listRunGroups = async () => ({ data: [group('g2')], meta: { page: 2, per_page: 1, total: 4 } });
  await h.fn.loadMoreRuns();
  assert.deepEqual(h.apiNames(), ['listRuns', 'listRuns', 'listRunGroups']);
  assert.deepEqual(idsOf(h.state.lastGroups), ['g1', 'g2']);
});

test('54: a Load more that fails puts the button back and says why, marked as an error', async () => {
  const h = load({ dashItems: [run('r1')], listPaging: { page: 1, total: 80, totalPages: 3, loading: false } });
  h.stubRenderList();
  h.on.dashboard = async () => { throw offline(h); };
  await h.fn.loadMoreRuns();
  assert.equal(h.state.listPaging.loading, false);
  assert.deepEqual(plain(h.state.listPaging), { page: 1, total: 80, totalPages: 3, loading: false });
  assert.deepEqual(h.calls.toasts, [{ msg: 'Could not load more runs: Failed to fetch', opts: { error: true } }]);
  assert.deepEqual(h.state.dashItems.map((it) => it.id), ['r1']);   // nothing half-appended
  assert.equal(h.calls.renders, 2);                                  // spinner up, then spinner down
});

test('87: a Load more page in dashboard mode appends its rows and then counts the folders it brought', async () => {
  const h = load({ dashItems: [run('r1')], listPaging: { page: 1, total: 3, totalPages: 2, loading: false } });
  h.stubRenderList();
  h.on.dashboard = async () => ({ items: [run('r2'), group('g1')], page: 2, total: 3, totalPages: 2 });
  h.on.nested = async () => [run('r3')];
  await h.fn.loadMoreRuns();
  assert.deepEqual(idsOf(h.state.dashItems), ['r1', 'r2', 'g1']);
  assert.deepEqual(plain(h.state.listPaging), { page: 2, total: 3, totalPages: 2, loading: false });
  assert.deepEqual(h.apiNames(), ['fetchDashboardPage', 'fetchGroupRunsNested']);
  assert.deepEqual(h.state.descendantRuns.g1.map((r) => r.id), ['r3']);
});

test('88: a second press while a page is on the wire, or one with no page left, does nothing at all', async () => {
  const h = load({ dashItems: [run('r1')], listPaging: { page: 1, total: 80, totalPages: 3, loading: true } });
  h.stubRenderList();
  await h.fn.loadMoreRuns();
  assert.deepEqual(h.apiNames(), []);
  h.state.listPaging = { page: 3, total: 80, totalPages: 3, loading: false };
  await h.fn.loadMoreRuns();
  assert.deepEqual(h.apiNames(), []);
  // …and with a page left and nothing in flight the same call DOES read.
  h.state.listPaging = { page: 1, total: 80, totalPages: 3, loading: false };
  await h.fn.loadMoreRuns();
  assert.deepEqual(h.apiNames(), ['fetchDashboardPage']);
});

test('55: a folder whose contents could not be read caches empty and complains exactly once', async () => {
  const h = load();
  h.stubRenderList();
  h.on.subgroups = async () => { throw offline(h); };
  h.on.children = async () => { throw offline(h); };
  await h.fn.loadGroupContents('g1');
  assert.deepEqual(plain(h.state.subgroupsCache.g1), []);
  assert.deepEqual(plain(h.state.childrenCache.g1), []);
  assert.equal('g1' in h.state.loadingGroup, false);
  // ONE toast for two failed legs, marked as the failure it is (#272).
  assert.deepEqual(h.calls.toasts, [{ msg: 'Could not load some group contents', opts: { error: true } }]);
  assert.deepEqual(plain(h.state.groupPaging.g1), {
    subsPage: 1, subsTotal: null, subsTotalPages: null,
    runsPage: 1, runsTotal: null, runsTotalPages: null, runsPerPage: null, loading: false,
  });
  // One leg answering still caches the other as empty and still toasts once…
  const one = load();
  one.stubRenderList();
  one.on.subgroups = async () => page([group('g2')]);
  one.on.children = async () => { throw offline(one); };
  await one.fn.loadGroupContents('g1');
  assert.deepEqual(one.state.subgroupsCache.g1.map((g) => g.id), ['g2']);
  assert.deepEqual(plain(one.state.childrenCache.g1), []);
  assert.equal(one.toastMsgs().length, 1);
  // …and with both answering there is no toast, so the complaint is a real signal.
  const ok = load();
  ok.stubRenderList();
  await ok.fn.loadGroupContents('g1');
  assert.deepEqual(ok.toastMsgs(), []);
});


test('56: access turning read-only mid-session repaints the lockout instead of reporting a failed refresh', async () => {
  const h = load({ dashItems: [run('r1')] });
  h.stubRenderList();
  h.on.dashboard = async () => { throw new h.ApiError('readonly', 403, 'Read only'); };
  await h.fn.refreshRuns();
  assert.equal(h.calls.capabilities, 1);
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.lines, []);
  assert.deepEqual(h.state.dashItems.map((it) => it.id), ['r1']);   // the previous list stays
});

test('57: any other failed refresh leaves the previous list up and says so on the line and in a toast', async () => {
  const h = load({ dashItems: [run('r1')] });
  h.stubRenderList();
  h.on.dashboard = async () => { throw offline(h); };
  await h.fn.refreshRuns();
  assert.equal(h.calls.capabilities, 0);
  assert.deepEqual(h.lastLine('runs-status'),
    { id: 'runs-status', text: 'Refresh failed: Failed to fetch', cls: 'error' });
  // The line and the plaque beside it now agree that this is a failure (#272).
  assert.deepEqual(h.calls.toasts, [{ msg: 'Refresh failed: Failed to fetch', opts: { error: true } }]);
  assert.deepEqual(h.state.dashItems.map((it) => it.id), ['r1']);
  // A refresh that succeeds says nothing at all, so the two above are the failure's own marks.
  const ok = load({ dashItems: [run('r1')] });
  ok.stubRenderList();
  ok.on.dashboard = async () => ({ items: [run('r2')], page: 1, total: 1, totalPages: 1 });
  await ok.fn.refreshRuns();
  assert.deepEqual(ok.calls.toasts, []);
  assert.deepEqual(ok.state.dashItems.map((it) => it.id), ['r2']);
});


test('89: opening a folder reads both its halves once, marks it loading meanwhile, and keeps both cursors', async () => {
  const h = load();
  h.stubRenderList();
  h.on.subgroups = async () => page([group('g2')]);
  h.on.children = async () => ({ items: [run('r1')], page: 1, total: 4, totalPages: 2, perPage: 2 });
  const opening = h.fn.loadGroupContents('g1');
  assert.equal(h.state.loadingGroup.g1, true);
  await opening;
  assert.equal('g1' in h.state.loadingGroup, false);
  assert.deepEqual(h.state.subgroupsCache.g1.map((g) => g.id), ['g2']);
  assert.deepEqual(h.state.childrenCache.g1.map((r) => r.id), ['r1']);
  assert.deepEqual(plain(h.state.groupPaging.g1), {
    subsPage: 1, subsTotal: 1, subsTotalPages: 1,
    runsPage: 1, runsTotal: 4, runsTotalPages: 2, runsPerPage: 2, loading: false,
  });
  await h.fn.loadGroupContents('g1');
  assert.deepEqual(h.apiNames(), ['fetchGroupSubgroups', 'fetchGroupChildren']);  // not read twice
});

test('90: a folder’s Load more advances both halves and hands the server back the page size it stated', async () => {
  const h = load({
    subgroupsCache: { g1: [group('a')] },
    childrenCache: { g1: [run('r1')] },
    groupPaging: {
      g1: {
        subsPage: 1, subsTotal: 2, subsTotalPages: 2,
        runsPage: 1, runsTotal: 4, runsTotalPages: 2, runsPerPage: 2, loading: false,
      },
    },
  });
  h.stubRenderList();
  h.on.subgroups = async () => ({ items: [group('b')], page: 2, total: 2, totalPages: 2 });
  h.on.children = async () => ({ items: [run('r2')], page: 2, total: 4, totalPages: 2, perPage: 2 });
  await h.fn.loadMoreGroup('g1');
  assert.deepEqual(h.calls.api, [['fetchGroupSubgroups', 'g1', 2], ['fetchGroupChildren', 'g1', 2, 2]]);
  assert.deepEqual(idsOf(h.state.subgroupsCache.g1), ['a', 'b']);
  assert.deepEqual(idsOf(h.state.childrenCache.g1), ['r1', 'r2']);
  assert.equal(h.state.groupPaging.g1.loading, false);
  // Both halves are now on their last page, so pressing again does nothing.
  await h.fn.loadMoreGroup('g1');
  assert.equal(h.calls.api.length, 2);
});

test('91: a folder’s Load more that fails puts its button back and marks the toast as an error', async () => {
  const h = load({
    childrenCache: { g1: [run('r1')] },
    groupPaging: {
      g1: { subsPage: 1, subsTotalPages: 1, runsPage: 1, runsTotal: 4, runsTotalPages: 2, runsPerPage: 2, loading: false },
    },
  });
  h.stubRenderList();
  h.on.children = async () => { throw offline(h); };
  await h.fn.loadMoreGroup('g1');
  assert.equal(h.state.groupPaging.g1.loading, false);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Could not load more runs: Failed to fetch', opts: { error: true } }]);
  assert.deepEqual(h.state.childrenCache.g1.map((r) => r.id), ['r1']);
});

test('93: the Load more row stays up while its own press is running, even on the last page', () => {
  const h = load({ dashItems: [run('r1')], listPaging: { page: 2, total: 2, totalPages: 2, loading: true } });
  h.fn.renderTopLoadMore(h.node.list);
  assert.equal(h.node.list.querySelectorAll('.load-more').length, 1);
  assert.equal(h.node.list.querySelector('.load-more-text').textContent, 'Loading…');
  // Idle and out of pages, it is not drawn at all.
  h.state.listPaging = { page: 2, total: 2, totalPages: 2, loading: false };
  h.node.list.replaceChildren();
  h.fn.renderTopLoadMore(h.node.list);
  assert.deepEqual(h.node.list.querySelectorAll('.load-more'), []);
});

// ---------- the expansion walk and the pasted folder link (rows 58-64, 101-108) ----------

test('58: pulling pages to find a sub-folder gives up after 50 rather than pulling for ever', async () => {
  const paged = (over = {}) => ({
    subsPage: 1, subsTotal: 999, subsTotalPages: 999,
    runsPage: 1, runsTotal: null, runsTotalPages: null, runsPerPage: null, loading: false, ...over,
  });
  const h = load({ subgroupsCache: { g1: [group('a')] }, groupPaging: { g1: paged() } });
  h.stubRenderList();
  let reads = 0;
  h.on.subgroups = async (id, p) => { reads += 1; return { items: [group(`x${p}`)], page: p, total: 999, totalPages: 999 }; };
  await h.fn.ensureSubgroupLoaded('g1', 'never-there');
  assert.equal(reads, 50);
  // The same server WITH the child on page 3 stops the moment its row exists.
  const found = load({ subgroupsCache: { g1: [group('a')] }, groupPaging: { g1: paged() } });
  found.stubRenderList();
  let hits = 0;
  found.on.subgroups = async (id, p) => {
    hits += 1;
    return { items: [group(p === 3 ? 'target' : `x${p}`)], page: p, total: 999, totalPages: 999 };
  };
  await found.fn.ensureSubgroupLoaded('g1', 'target');
  assert.equal(hits, 2);
  // …and a child already in the cache costs no read at all.
  const there = load({ subgroupsCache: { g1: [group('target')] }, groupPaging: { g1: paged() } });
  there.stubRenderList();
  await there.fn.ensureSubgroupLoaded('g1', 'target');
  assert.deepEqual(there.apiNames(), []);
});

test('59: a folder the tester had open that is no longer anywhere in the tree is forgotten and saved', async () => {
  const h = load({
    dashItems: [group('g1')],
    expandedGroups: ['g1', 'gone'],
    subgroupsCache: { g1: [] },
    childrenCache: { g1: [] },
  });
  h.stubRenderList();
  await h.fn.ensureExpandedChildrenLoaded();
  assert.deepEqual([...h.state.expandedGroups], ['g1']);
  assert.equal(h.calls.persists, 1);
  // With nothing to prune it is not persisted again — a save on every render would be a write storm.
  await h.fn.ensureExpandedChildrenLoaded();
  assert.equal(h.calls.persists, 1);
  // A NESTED folder is reachable through its parent's cache, so it survives the same walk.
  h.state.subgroupsCache = { g1: [group('sub')], sub: [] };
  h.state.childrenCache = { g1: [], sub: [] };
  h.state.expandedGroups = ['g1', 'sub'];
  await h.fn.ensureExpandedChildrenLoaded();
  assert.deepEqual([...h.state.expandedGroups], ['g1', 'sub']);
  assert.equal(h.calls.persists, 1);
});

test('60: a folder link for a folder that is not in the list stops looking once the list is exhausted', async () => {
  const h = load({ dashItems: [group('other')], listPaging: { page: 1, total: 1, totalPages: 1, loading: false } });
  h.stubRenderList();
  assert.equal(await h.fn.ensureTopLevelGroupLoaded('g1'), false);
  assert.deepEqual(h.apiNames(), []);
  // A folder already on screen costs nothing either.
  assert.equal(await h.fn.ensureTopLevelGroupLoaded('other'), true);
  assert.deepEqual(h.apiNames(), []);
  // …and with a page still to come it DOES pull, which is what makes the false above a decision.
  h.state.listPaging = { page: 1, total: 2, totalPages: 2, loading: false };
  h.on.dashboard = async () => ({ items: [group('g1')], page: 2, total: 2, totalPages: 2 });
  assert.equal(await h.fn.ensureTopLevelGroupLoaded('g1'), true);
  // One page pulled, then it stops — the nested counts behind it are that page's own business.
  assert.deepEqual(h.apiNames().filter((n) => n === 'fetchDashboardPage'), ['fetchDashboardPage']);
});

test('61: a pasted folder link beats the live filter and search, opens the chain root-first and flashes the row', async () => {
  const h = load({ filter: 'failed', search: 'nightly' });
  h.state.runsSearch = 'nightly';
  h.node.search.value = 'nightly';
  h.on.dashboard = async () => ({ items: [group('g1')], page: 1, total: 1, totalPages: 1 });
  h.on.getRunGroup = async () => ({ path: ['g1'] });
  h.on.subgroups = async (id) => (id === 'g1' ? page([group('g2')]) : page([]));
  await h.fn.openGroupFromUrl('g2');
  assert.equal(h.state.runsFilter, 'all');
  assert.equal(h.state.runsSearch, '');
  assert.equal(h.node.search.value, '');
  assert.deepEqual([...h.state.expandedGroups], ['g1', 'g2']);   // the root before the leaf
  assert.equal(h.state.highlightedGroup, 'g2');
  assert.equal(h.groupRowFor('g2').classList.contains('group-highlight'), true);
  assert.deepEqual(h.calls.scrolls.at(-1), { block: 'center' });
});

test('62: a folder link for a row that did not render leaves no flash pointing at nothing', () => {
  const h = load({ dashItems: [group('g1')] });
  h.fn.renderDashboard();
  h.fn.highlightGroup('not-rendered');
  assert.equal(h.state.highlightedGroup, null);
  assert.equal(h.clock.count(), 0);
  // A row that IS on screen is flashed, so the null above is a miss and not a dead function.
  h.fn.highlightGroup('g1');
  assert.equal(h.state.highlightedGroup, 'g1');
  assert.equal(h.clock.count(), 1);
});

test('63: the flash is state-driven, so it survives a re-render — and it lets go after 2500 ms', async () => {
  const h = load({ dashItems: [group('g1')] });
  h.fn.renderDashboard();
  h.fn.highlightGroup('g1');
  const first = h.groupRowFor('g1');
  assert.equal(first.classList.contains('group-highlight'), true);
  assert.deepEqual(h.clock.arms(), [2500]);
  h.fn.renderDashboard();
  assert.notEqual(h.groupRowFor('g1'), first);                       // a brand-new row object…
  assert.equal(h.groupRowFor('g1').classList.contains('group-highlight'), true);  // …still flashing
  await h.clock.tick();
  assert.equal(h.state.highlightedGroup, null);
  assert.equal(h.groupRowFor('g1').classList.contains('group-highlight'), false);
  // A second paste re-arms rather than stacking a second timer on the same row.
  h.fn.highlightGroup('g1');
  h.fn.highlightGroup('g1');
  assert.equal(h.clock.count(), 1);
  assert.deepEqual(h.clock.arms(), [2500, 2500, 2500]);
});

// One roving tab stop for the whole list, not one per row: a run row already grows three status
// buttons in the run view, so a stop per row would be hundreds of them. Tab enters the list once,
// the arrows walk it, Enter opens. The helper's own contract is tests/roving.test.mjs.
test('64 (#109): a run row and a folder head can be reached and opened from the keyboard', () => {
  const h = load({
    dashItems: [group('g1'), run('r2')],
    subgroupsCache: { g1: [] },
    childrenCache: { g1: [run('r1')] },
  });
  h.fn.renderDashboard();

  const head = h.groupRowFor('g1').querySelector('.group-head');
  assert.equal(head.getAttribute('role'), 'button', 'a reader is told the folder head is actionable');
  assert.equal(head.getAttribute('tabindex'), '0');

  // Down steps STRAIGHT over the folded folder's run — it is not on screen.
  assert.equal(key(head, 'ArrowDown').defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.rowFor('r2'));
  assert.deepEqual(h.rowTabs(), ['-1', '-1', '0'], 'exactly one row is a tab stop');

  // Enter on the head opens the folder — the same act as clicking it, and NOT a left/right key.
  assert.equal(key(head, 'Enter').defaultPrevented, true);
  assert.deepEqual([...h.state.expandedGroups], ['g1']);
  assert.equal(h.kidsOf(h.groupRowFor('g1')).hidden, false);

  // …and now its run is somewhere the arrows can land, with nothing re-attached.
  key(head, 'ArrowDown');
  assert.equal(h.doc.activeElement, h.rowFor('r1'));
  assert.equal(key(h.rowFor('r1'), 'Enter').defaultPrevented, true);
  assert.deepEqual(h.calls.opened, [['r1', 'Run r1']]);

  // Space opens too, and is swallowed so the list does not scroll out from under the row.
  assert.equal(key(h.rowFor('r2'), ' ').defaultPrevented, true);
  assert.deepEqual(h.calls.opened, [['r1', 'Run r1'], ['r2', 'Run r2']]);
});

test('64b: a re-render leaves the list keyboard-ready again, and Load more stays an ordinary button', () => {
  const h = load({
    dashItems: [run('r1'), run('r2')],
    listPaging: { page: 1, totalPages: 2, total: 40, perPage: 20 },
  });
  h.fn.renderDashboard();
  key(h.rowFor('r1'), 'End');
  assert.equal(h.doc.activeElement, h.rowFor('r2'));

  // What every render does: brand-new rows into the same <ul>. Nothing is wired a second time.
  h.fn.renderDashboard();
  assert.equal(h.node.list.listeners.get('keydown').length, 1);
  key(h.rowFor('r1'), 'ArrowDown');
  assert.equal(h.doc.activeElement, h.rowFor('r2'));
  assert.deepEqual(h.rowTabs(), ['-1', '0']);

  // The Load more row is a button of its own — it keeps its own tab stop and its own Enter.
  const more = h.node.list.querySelector('.load-more');
  assert.equal(more.getAttribute('role'), null);
  key(h.rowFor('r2'), 'ArrowDown');
  assert.equal(h.doc.activeElement, h.rowFor('r2'), 'the arrows stop at the last ROW');
});

// 64c: the head is a role="button" that folds a folder, and the chevron that says which way it is
// pointing is a picture. Written where the fold is written — the render, and the toggle.
test('64c (#109): a folder head says whether it is open, and keeps saying it as the fold moves', () => {
  const h = load({ dashItems: [group('g1'), run('r2')], subgroupsCache: { g1: [] }, childrenCache: { g1: [run('r1')] } });
  h.fn.renderDashboard();
  const head = () => h.groupRowFor('g1').querySelector('.group-head');
  assert.equal(head().getAttribute('aria-expanded'), 'false');

  fire(head(), 'click');
  assert.equal(head().getAttribute('aria-expanded'), 'true');
  fire(head(), 'click');
  assert.equal(head().getAttribute('aria-expanded'), 'false');

  // …and a row rebuilt from state is born saying it, not left to the toggle that is not coming.
  h.state.expandedGroups.push('g1');
  h.fn.renderDashboard();
  assert.equal(head().getAttribute('aria-expanded'), 'true');
  // A run row folds nothing, so it claims no fold.
  assert.equal(h.rowFor('r2').getAttribute('aria-expanded'), null);
});

test('101: in the degraded v2 mode there is nothing nested to hydrate, so the walk returns at once', async () => {
  const h = load({ listMode: 'v2', expandedGroups: ['gone'], dashItems: [] });
  h.stubRenderList();
  await h.fn.ensureExpandedChildrenLoaded();
  assert.deepEqual([...h.state.expandedGroups], ['gone']);   // not pruned
  assert.equal(h.calls.persists, 0);
  assert.equal(h.calls.renders, 0);                          // not even a render
  // In dashboard mode the same call prunes and repaints.
  h.state.listMode = 'dashboard';
  await h.fn.ensureExpandedChildrenLoaded();
  assert.deepEqual([...h.state.expandedGroups], []);
  assert.equal(h.calls.persists, 1);
  assert.equal(h.calls.renders, 1);
});

test('102: expanding a chain never lists a folder twice, and in v2 mode it repaints instead of reading', async () => {
  const h = load({ expandedGroups: ['g1'], subgroupsCache: { g1: [] }, childrenCache: { g1: [] } });
  h.stubRenderList();
  await h.fn.expandGroupChain(['g1']);
  assert.deepEqual([...h.state.expandedGroups], ['g1']);
  assert.deepEqual(h.apiNames(), []);
  const v = load({ listMode: 'v2' });
  v.stubRenderList();
  await v.fn.expandGroupChain(['g1']);
  assert.deepEqual([...v.state.expandedGroups], ['g1']);
  assert.deepEqual(v.apiNames(), []);      // v2 folders are flat: nothing to read
  assert.equal(v.calls.renders, 2);        // the level's render, then the chain's own
});

test('103: a folder link that cannot even load the list reports the read’s own reason', async () => {
  const h = load();
  h.stubRenderList();
  h.on.dashboard = async () => { throw offline(h); };
  await h.fn.openGroupFromUrl('g1');
  assert.deepEqual(h.calls.shows, ['runs']);
  assert.deepEqual(h.calls.apiErrors, [{ kind: 'network', message: 'Failed to fetch', id: 'runs-status' }]);
  assert.deepEqual(h.toastMsgs(), []);
});

test('104: a folder link naming a folder the project does not have says so; a broken read says why', async () => {
  const h = load();
  h.on.dashboard = async () => ({ items: [group('other')], page: 1, total: 1, totalPages: 1 });
  h.on.getRunGroup = async () => { throw notFound(h); };
  await h.fn.openGroupFromUrl('g1');
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: 'Run not found', cls: 'error' });
  assert.deepEqual(h.calls.apiErrors, []);
  const e = load();
  e.on.dashboard = async () => ({ items: [group('other')], page: 1, total: 1, totalPages: 1 });
  e.on.getRunGroup = async () => { throw offline(e); };
  await e.fn.openGroupFromUrl('g1');
  assert.deepEqual(e.calls.apiErrors, [{ kind: 'network', message: 'Failed to fetch', id: 'runs-status' }]);
});

test('105: in the degraded v2 mode there is no nested lookup — an unknown folder is simply not found', async () => {
  const h = load({ jwt: false, listMode: 'v2' });
  h.on.dashboard = async () => { throw offline(h); };
  h.on.listRunGroups = async () => ({ data: [group('other')] });
  await h.fn.openGroupFromUrl('nope');
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: 'Run not found', cls: 'error' });
  assert.equal(h.apiNames().includes('getRunGroup'), false);
});

test('106: a folder link for a ROOT folder opens it without asking the server where it sits', async () => {
  const h = load();
  h.on.dashboard = async () => ({ items: [group('g1')], page: 1, total: 1, totalPages: 1 });
  await h.fn.openGroupFromUrl('g1');
  assert.deepEqual([...h.state.expandedGroups], ['g1']);
  assert.equal(h.state.highlightedGroup, 'g1');
  assert.equal(h.apiNames().includes('getRunGroup'), false);
});

test('107: an archived folder is not found by id either, so a link to one is never opened', () => {
  const h = load({ listMode: 'v2', lastGroups: [group('g1', { archived_at: 'x' }), group('g2')] });
  assert.equal(h.fn.findGroupById('g1'), undefined);
  assert.equal(h.fn.findGroupById('g2').id, 'g2');
  // In dashboard mode the lookup reads dashItems, and a RUN with that id is not a folder.
  const d = load({ dashItems: [run('g2'), group('g3')] });
  assert.equal(d.fn.findGroupById('g2'), undefined);
  assert.equal(d.fn.findGroupById('g3').id, 'g3');
});

test('108: the reachable folders are the list’s own plus every sub-folder any open folder brought in', () => {
  const h = load({ dashItems: [group('g1'), run('r1')], subgroupsCache: { g1: [group('g2')] } });
  assert.deepEqual([...h.fn.reachableGroupIds()].sort(), ['g1', 'g2']);
  h.state.subgroupsCache = {};
  assert.deepEqual([...h.fn.reachableGroupIds()].sort(), ['g1']);
});

// ---------- opening the screen, and the empty project (rows 97-100, 109-110) ----------

test('97: coming back to the Runs tab paints the rows already in memory and re-reads behind them', async () => {
  const h = load({ dashItems: [run('r1')] });
  h.stubRenderList();
  h.on.dashboard = async () => ({ items: [run('r1')], page: 1, total: 1, totalPages: 1 });
  await h.fn.openRunsView();
  await settle();
  assert.deepEqual(h.calls.skeleton, []);                    // nothing is blanked for a re-read
  assert.deepEqual(h.calls.shows, ['runs']);
  const at = (s) => h.calls.order.indexOf(s);
  assert.ok(at('show:runs') < at('gate'));                   // the rows go up BEFORE the lock probe
  assert.ok(at('gate') < at('fetchDashboardPage'));
  assert.equal(h.calls.gates, 1);
  assert.deepEqual(h.calls.tabCounts, [['runs', 0]]);
});

test('98: a first open draws the placeholder and settles the read-only probe before asking for any run', async () => {
  const h = load({ dashItems: [] });
  h.stubRenderList();
  h.on.dashboard = async () => ({ items: [run('r1')], page: 1, total: 1, totalPages: 1 });
  await h.fn.openRunsView();
  assert.deepEqual(h.calls.skeleton, [['show', 'runs'], ['hide', 'runs']]);
  const at = (s) => h.calls.order.indexOf(s);
  assert.ok(at('gate') < at('fetchDashboardPage'));
  assert.ok(h.calls.lines.some((l) => l.id === 'runs-status' && l.text === 'Loading runs…'));
  assert.deepEqual(idsOf(h.state.dashItems), ['r1']);
});

test('99: a locked project replaces what is up and never asks for the list at all', async () => {
  const back = load({ dashItems: [run('r1')], gate: true });
  back.stubRenderList();
  await back.fn.openRunsView();
  assert.equal(back.calls.blocks, 1);
  assert.deepEqual(back.calls.skeleton, []);
  assert.equal(back.apiNames().includes('fetchDashboardPage'), false);
  assert.deepEqual(idsOf(back.state.dashItems), ['r1']);     // nothing blanked for the lockout
  // On a FIRST open the placeholder comes down before the blocking panel goes up.
  const first = load({ gate: true });
  first.stubRenderList();
  await first.fn.openRunsView();
  assert.equal(first.calls.blocks, 1);
  assert.deepEqual(first.calls.skeleton, [['show', 'runs'], ['hide', 'runs']]);
  assert.deepEqual(first.apiNames(), []);
  const at = (s) => first.calls.order.indexOf(s);
  assert.ok(at('gate') < at('block'));
});

test('100: a project with no runs at all offers the two ways in — start one, or paste a link to one', () => {
  const h = load();
  h.fn.renderRunsEmptyCta(h.node.list);
  assert.equal(h.calls.empties.at(-1).title, 'No runs yet');
  const link = h.node.list.querySelector('a.btn.primary');
  assert.equal(link.href, `${BASE}/projects/my-project/runs/new`);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  const paste = h.node.list.querySelectorAll('button').find((b) => b.textContent === 'Paste a run URL');
  fire(paste, 'click');
  assert.equal(h.doc.activeElement, h.node.search);
  assert.deepEqual(h.lastLine('runs-status'), { id: 'runs-status', text: '', cls: '' });
  // Not connected anywhere yet: there is nowhere to send them, so only the paste button is offered.
  h.state.settings = {};
  h.fn.renderRunsEmptyCta(h.node.list);
  assert.equal(h.node.list.querySelector('a.btn.primary'), null);
  assert.equal(h.node.list.querySelectorAll('button').length, 1);
});

test('109: the chip narrows a folder’s own runs, and a folder left with none of them drops out', () => {
  const h = load({ listMode: 'v2', filter: 'failed' });
  h.fn.renderRuns(
    [run('r1', { rungroup_id: 'g1', status: 'failed' }), run('r2', { rungroup_id: 'g1', status: 'passed' })],
    [group('g1'), group('g2')],
  );
  assert.deepEqual(h.rowIds(), ['g1']);
  assert.deepEqual(h.kidsOf(h.groupRowFor('g1')).children.map((li) => li.dataset.runId), ['r1']);
  // With the chip off both folders and both runs come back.
  h.state.runsFilter = 'all';
  h.fn.renderRuns(
    [run('r1', { rungroup_id: 'g1', status: 'failed' }), run('r2', { rungroup_id: 'g1', status: 'passed' })],
    [group('g1'), group('g2')],
  );
  assert.deepEqual(h.rowIds(), ['g1', 'g2']);
  assert.deepEqual(h.kidsOf(h.groupRowFor('g1')).children.map((li) => li.dataset.runId), ['r1', 'r2']);
});

test('110: a page whose runs toolbar is not in the DOM yet is left alone rather than thrown over', () => {
  const bare = load({ without: ['runs-filter', 'runs-search', 'btn-new-run'], search: 'nightly' });
  bare.state.runsSearch = 'nightly';
  bare.fn.renderFilterChips();
  bare.fn.syncRunsSearchInput();
  bare.fn.renderNewRunLink();
  assert.equal(bare.calls.fits, 0);
  assert.deepEqual(bare.calls.counters, []);
  // The field without its clear button is a separate guard: the value still lands.
  const noClear = load({ without: ['runs-search-clear'], search: '' });
  noClear.state.runsSearch = 'nightly';
  noClear.fn.syncRunsSearchInput();
  assert.equal(noClear.node.search.value, 'nightly');
  // With the whole toolbar present the same three calls all do their work.
  const full = load({ search: '' });
  full.state.runsSearch = 'nightly';
  full.fn.renderFilterChips();
  full.fn.syncRunsSearchInput();
  full.fn.renderNewRunLink();
  assert.equal(full.calls.fits, 1);
  assert.equal(full.calls.counters.length, 6);
  assert.equal(full.node.search.value, 'nightly');
  assert.equal(full.node.searchClear.hidden, false);
  assert.equal(full.node.newRun.hidden, false);
});
