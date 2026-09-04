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
// Run: node --test tests/runs-list.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

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

    // ---- run-view.js's globals, STUBBED. Loading run-view into this context would couple the two
    // test files: a mutation there would redden rows here that have nothing to do with it.
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
    openRunView: async (id, title) => { calls.opened.push([id, title]); calls.order.push('openRun'); },
    CHEVRON_ICON: 'chevron_right',
    FOLDER_ICON: 'tree_folder',

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
    exported: `({ RUN_FILTERS, FILTER_KEYS, RUNS_FILTER_TINT, LOADING_ICON, filterLabel, matchesFilter,
      runsSearchActive, runsFilterActive, anyRunsConstraint, titleOf, searchNeedle, runMatchesSearch,
      groupTitleMatchesSearch, runPasses, groupSelfHit, runsEmptyMessage, childrenLoaded,
      groupContentsLoaded, hasNextPage, listLoadedCount, isPasteInput, envTags, isExpanded,
      renderedGroupRow, looksLikeRunId, runsSearchRunId, runIdProbeFor, RUN_NOT_FOUND, RUN_ID_PROBE_MS })`,
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

// ---------- the paging arithmetic (rows 1-6) ----------

test('1: the server states the page size and the row total, and the page count is derived from them', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.v2Cursor({ meta: { page: 2, per_page: 50, total: 180 } }, 2)),
    { page: 2, perPage: 50, total: 180, totalPages: 4 });
});

test('2: a server that sends no meta at all never offers Load more — the page size is what arrived', () => {
  const h = load();
  const cursor = h.fn.v2Cursor({ data: Array.from({ length: 30 }, (_, i) => run(`r${i}`)) }, 1);
  assert.deepEqual(plain(cursor), { page: 1, perPage: 30, total: null, totalPages: null });
  assert.equal(h.lex.hasNextPage(cursor), false);
  // The same shape WITH a meta does offer it, so the false above is a decision and not a stub.
  assert.equal(h.lex.hasNextPage(h.fn.v2Cursor({ meta: { page: 1, per_page: 30, total: 90 }, data: [] }, 1)), true);
});

test('3: an empty page still divides — perPage falls to 1 rather than to zero', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.v2Cursor({ data: [] }, 3)), { page: 3, perPage: 1, total: null, totalPages: null });
  // With a total present the |1 is what keeps the ceil finite instead of Infinity.
  assert.equal(h.fn.v2Cursor({ meta: { total: 7 }, data: [] }, 1).totalPages, 7);
});

test('4: "there is more" needs a page COUNT — an unknown one is not a promise of another page', () => {
  const h = load();
  assert.equal(h.lex.hasNextPage({ page: 1, totalPages: null }), false);
  assert.equal(h.lex.hasNextPage({ page: 1, totalPages: 2 }), true);
  assert.equal(h.lex.hasNextPage(null), false);
  // The last page is not a next page either.
  assert.equal(h.lex.hasNextPage({ page: 2, totalPages: 2 }), false);
});

test('5: the remainder never goes negative, and an unknown total has no remainder to state', () => {
  const h = load();
  assert.equal(h.fn.remainderOf({ total: 180 }, 200), 0);
  assert.equal(h.fn.remainderOf({ total: null }, 5), null);
  assert.equal(h.fn.remainderOf(null, 5), null);
  assert.equal(h.fn.remainderOf({ total: 180 }, 30), 150);
});

test('6: the two v2 sources fold into one cursor, and the total is null unless BOTH report one', () => {
  const h = load({
    v2RunsPaging: { page: 1, total: 10, totalPages: 4 },
    v2GroupsPaging: { page: 2, total: null, totalPages: 1 },
  });
  assert.deepEqual(plain(h.fn.v2ListPaging()), { page: 2, total: null, totalPages: 4, loading: false });
  // Both reporting: the totals ADD, which is the branch the null above is chosen over.
  h.state.v2GroupsPaging = { page: 2, total: 3, totalPages: 1 };
  assert.deepEqual(plain(h.fn.v2ListPaging(true)), { page: 2, total: 13, totalPages: 4, loading: true });
});

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

// ---------- the URL and id parsers — the security seam (rows 21-28, 72-73) ----------

test('21: a value with a space in it is never treated as a link — it is what the tester typed', () => {
  const h = load();
  assert.equal(h.fn.looksLikeRunUrl('a b/projects/x/runs/1'), false);
  assert.equal(h.fn.looksLikeRunUrl('/projects/x/runs/1'), true);
  assert.equal(h.fn.looksLikeRunUrl('https://x'), true);
  assert.equal(h.fn.looksLikeRunUrl(''), false);
  assert.equal(h.fn.looksLikeRunUrl('Nightly regression'), false);
});

test('22: the folder shape is read first, so /runs/groups/12 is a folder and not a run called "groups"', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.parseRunUrlParts(`${HOST}/projects/abc/runs/groups/12`)),
    { host: HOST, projectId: 'abc', kind: 'group', id: '12' });
  // Without the groups segment the SAME path is a run, so the order above is a decision.
  assert.deepEqual(plain(h.fn.parseRunUrlParts(`${HOST}/projects/abc/runs/12`)),
    { host: HOST, projectId: 'abc', kind: 'run', id: '12' });
});

test('23: the web app’s "Copy url" slugs the run segment, and the panel cuts it back to the id', () => {
  const h = load();
  assert.equal(h.fn.parseRunUrlParts('https://h/projects/abc/runs/9f8e7d6c-my-title').id, '9f8e7d6c');
  assert.equal(h.fn.parseRunUrlParts('https://h/projects/abc/runs/9f8e7d6c').id, '9f8e7d6c');
});

test('24: something that is not a URL, and a project link with no run in it, resolve to nothing', () => {
  const h = load();
  assert.equal(h.fn.parseRunUrlParts('not a url'), null);
  assert.equal(h.fn.parseRunUrlParts('https://h/projects/abc'), null);
  assert.equal(h.fn.parseRunUrlParts(''), null);
  assert.equal(h.fn.parseRunUrlParts(null), null);
});

test('25: a run link on a FOREIGN host is never resolved against the project this panel is connected to', () => {
  const h = load();
  assert.equal(h.fn.parseRunsUrl(`https://evil.example/projects/${PROJECT}/runs/9f8e7d6c`), null);
  // The identical path on the CONFIGURED host does resolve, so the null above is the host check.
  assert.deepEqual(plain(h.fn.parseRunsUrl(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`)),
    { kind: 'run', id: '9f8e7d6c' });
});

test('26: the right host with the wrong project is not this panel’s run either', () => {
  const h = load();
  assert.equal(h.fn.parseRunsUrl(`${BASE}/projects/someone-else/runs/9f8e7d6c`), null);
  assert.deepEqual(plain(h.fn.parseRunsUrl(`${BASE}/projects/${PROJECT}/runs/groups/12`)),
    { kind: 'group', id: '12' });
});

test('27: a panel whose own base URL will not parse resolves nothing — never a bare-host match', () => {
  const h = load({ settings: { baseUrl: 'not a url', projectId: PROJECT } });
  assert.equal(h.fn.parseRunsUrl(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`), null);
  // The same link with the base URL repaired resolves, so the branch above was really reached.
  h.state.settings = { baseUrl: BASE, projectId: PROJECT };
  assert.deepEqual(plain(h.fn.parseRunsUrl(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`)),
    { kind: 'run', id: '9f8e7d6c' });
});

test('28: a bare run id is 6 to 12 hex characters, case-blind — anything else is a title search', () => {
  const h = load();
  assert.equal(h.lex.looksLikeRunId('9F8E7D6C'), true);
  assert.equal(h.lex.looksLikeRunId('abcde'), false);          // five is too short
  assert.equal(h.lex.looksLikeRunId('zzzzzz'), false);         // six, but not hex
  assert.equal(h.lex.looksLikeRunId('1234567890123'), false);  // thirteen is too long
  assert.equal(h.lex.looksLikeRunId('  9f8e7d  '), true);      // a trimmed paste still reads
});

test('72: a bare id can never look like a link, so the two jobs of the one field cannot collide', () => {
  const h = load();
  for (const id of ['9f8e7d', '9F8E7D6C', 'abcdef012345']) {
    assert.equal(h.lex.looksLikeRunId(id), true);
    assert.equal(h.fn.looksLikeRunUrl(id), false);
  }
  // And a link is never mistaken for an id.
  assert.equal(h.lex.looksLikeRunId(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`), false);
});

test('73: a link copied from deep inside a run still opens the run, and the id survives the query', () => {
  const h = load();
  assert.equal(h.fn.parseRunUrlParts(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c/tests/42`).id, '9f8e7d6c');
  assert.equal(h.fn.parseRunUrlParts(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c?tab=all#top`).id, '9f8e7d6c');
  assert.equal(h.fn.parseRunUrlParts(`${BASE}/projects/${PROJECT}/runs/groups/12/whatever`).kind, 'group');
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

// ---------- finding a run by its id (rows 38-43, 83-85) ----------
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

test('84: only an id-shaped query is probed, and it is probed trimmed', () => {
  const h = load();
  h.state.runsSearch = '  9f8e7d  ';
  assert.equal(h.lex.runsSearchRunId(), '9f8e7d');
  h.state.runsSearch = 'nightly';
  assert.equal(h.lex.runsSearchRunId(), null);
  h.state.runsSearch = '';
  assert.equal(h.lex.runsSearchRunId(), null);
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
