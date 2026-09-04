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
