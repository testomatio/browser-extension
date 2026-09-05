#!/usr/bin/env node
// What extension/sidepanel/screens/tc-studio.js is for the tester (#163): the suite tree — the
// project's folders and files, read whole from the server and re-sorted here so the panel matches the
// web; the list of test cases inside the suite they opened, with its own search and its own counter;
// and the quick-add bar under it, which takes one title, or — with the Bulk switch — a whole pasted
// list at once. Clicking an existing test opens it read-only; New test opens the editor already bound
// to the suite that was chosen.
// Two things here are easy to get quietly wrong, so most of this file is about them. The bar's text
// follows the switch: the quick field is the FIRST line of the list, and the lines under it wait in
// memory for Bulk to come back. And a folder's counter shows its whole subtree while a file's shows
// only its own — zero included, because a badge left off the row reads as "not loaded".
// Rows 1-81 are the ticket's; a lettered suffix is the companion case that drives the same path the
// other way, so a row asserting "nothing happened" cannot pass against a stub that never worked.
// Rows 1-3 and 5-18 are no longer here: the four algorithms behind them left for
// extension/sidepanel/core/suite-tree.js (#196), and tests/suite-tree.test.mjs drives them with no
// stubs at all. This file loads the REAL module beside the screen, in index.html's own order, and
// keeps every row about what the RENDER does with the answers.
// Run: node --test tests/tc-studio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';
import { loadInto } from './helpers/shared-harness.mjs';

// The real shared/roving.js, one per load(): its map of wired containers is a singleton, and the
// keyboard rows below are worth nothing against a stub. Its own contract is tests/roving.test.mjs.
const roving = () => loadInto({ console }, [['shared/roving.js', 'Roving']]).value;

const BASE = 'https://app.testomat.io';

// A promise this file resolves by hand: the read guard is only about which answer lands second.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A keypress from the row that has focus, which bubbles to the <ul> the helper is delegated on —
// the same trip a real one makes.
const key = (node, k) => fire(node, 'keydown', { key: k, bubbles: true });

const folder = (id, title, children = [], extra = {}) =>
  ({ id, title, file_type: 'folder', children, ...extra });
const file = (id, title, extra = {}) => ({ id, title, file_type: 'file', ...extra });

// The panel globals tc-studio.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the screens beside this one land in parallel.
function load(opts = {}) {
  const o = {
    readonly: false,                 // capabilities.readonly — the #155 lockout
    gate: false,                     // what readonlyGate() answers on the Tests screen
    settings: { baseUrl: BASE, projectId: 'my project' },
    suites: [],                      // state.tcSuites
    expanded: {},                    // state.tcExpanded
    treeQuery: '',                   // state.tcTreeSearch
    search: '',                      // state.tcSearch
    suiteId: null,
    suiteTitle: '',
    tests: [],                       // state.tcTests
    epoch: 1,
    jwt: true,                       // what TestomatAPI.jwtAvailable() answers
    quickBar: true,                  // the four quick-bar fields present in the DOM
    sessionThrows: false,            // a private window, where sessionStorage.setItem throws
    ...opts,
  };

  // index.html's shape (:451-508), cut to the nodes this screen touches.
  const doc = makeDocument([]);
  const node = {
    tree: el('ul', { id: 'tc-tree' }),
    treeBar: el('div', { id: 'tc-tree-bar', hidden: false }),
    treeSearch: el('input', { id: 'tc-tree-search', value: o.treeQuery }),
    treeClear: el('button', { id: 'tc-tree-search-clear', hidden: true }),
    list: el('ul', { id: 'tc-list' }),
    listCount: el('span', { id: 'tc-list-count', hidden: true }),
    listNew: el('button', { id: 'tc-list-new' }),
    search: el('input', { id: 'tc-search', value: o.search }),
    searchClear: el('button', { id: 'tc-search-clear', hidden: true }),
    promote: el('ul', { id: 'promote-tree' }),
  };
  doc.body.append(...Object.values(node));
  if (o.quickBar) {
    Object.assign(node, {
      title: el('input', { id: 'tc-quick-title', value: '', hidden: false, readOnly: false, disabled: false }),
      titles: el('textarea', { id: 'tc-quick-titles', value: '', hidden: true, readOnly: false, disabled: false }),
      create: el('button', { id: 'tc-quick-create', disabled: true, textContent: 'Create' }),
      bulk: el('input', { id: 'tc-quick-bulk', type: 'checkbox', checked: false, disabled: false }),
    });
    // index.html's shape: the tip lives on the LABEL, because a disabled input answers no pointer.
    node.bulkLabel = el('label', { className: 'choice tc-quick-bulk', dataset: { tip: 'Add more' } }, node.bulk);
    doc.body.append(node.title, node.titles, node.create, node.bulkLabel);
  }

  const calls = {
    order: [],          // one ordered trace, for the rows that assert "before", not merely "both"
    shows: [],
    lines: [],          // { id, text }
    toasts: [],
    tabCounts: [],      // [tab, n]
    counters: [],       // every number paintCounter painted
    apiErrors: [],      // { message, id }
    skeleton: [],       // ['show'|'hide', view]
    emojiIndex: [],     // the roots handed to rememberSuiteEmoji
    empties: [],        // { title, live, tag } of every EmptyState built
    tips: [],
    scrolls: [],        // window.scrollTo arguments
    scrolledInto: 0,    // scrollIntoView on a freshly built row
    gates: 0,
    blocks: 0,
    jwtAsked: 0,
    listNew: 0,
    treeReads: 0,       // getSuiteTreeOrdered
    countReads: 0,      // getSuiteTree — the chip's own read, without the tree
    listReads: [],      // getTestsBySuite(suiteId)
    createSuites: [],
    createTests: [],
    bulks: [],
  };

  // mini-dom has neither, and both are real acts here: the inline create row scrolls itself in, and
  // the empty list's New test button clicks the toolbar's.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = () => { calls.scrolledInto += 1; };
    return made;
  };
  node.listNew.click = () => { calls.listNew += 1; };
  doc.documentElement.scrollHeight = 4321;

  // Reassignable after load(), so a test can answer the second read differently from the first, or
  // change the world from inside a call the screen is awaiting.
  const on = {
    orderedTree: async () => o.serverTree ?? [],
    tree: async () => o.serverTree ?? [],
    tests: async () => o.serverTests ?? [],
    createSuite: async () => ({ id: 'new-1' }),
    createTest: async () => ({ id: 'made-1' }),
    bulk: async () => ({}),
  };

  const state = {
    settings: o.settings,
    projectEpoch: o.epoch,
    view: 'tcstudio',
    tcSuites: o.suites,
    tcExpanded: o.expanded,
    tcSuiteId: o.suiteId,
    tcSuiteTitle: o.suiteTitle,
    tcSuiteEmoji: null,
    tcTests: o.tests,
    tcSearch: o.search,
    tcTreeSearch: o.treeQuery,
    suiteEmoji: null,
  };

  // shared/icons.js's own rule: an empty value or an unresolved `:shortcode:` draws nothing, so the
  // caller falls back to the glyph — treeIcon below is core/status-icons.js's, which this screen borrows.
  const emojiSpan = (value, cls = '') => {
    const s = String(value || '').trim();
    if (!s || /^:[a-z0-9_+-]+:$/i.test(s)) return null;
    const span = doc.createElement('span');
    span.className = `${cls} emoji`.trim();
    span.textContent = s;
    return span;
  };
  const treeIcon = (name, cls, emoji) => {
    const custom = emojiSpan(emoji, `tree-icon ${cls}`);
    if (custom) { custom.dataset.emoji = custom.textContent; return custom; }
    const span = doc.createElement('span');
    span.className = `tree-icon ${cls}`;
    span.dataset.icon = name;
    return span;
  };

  // EmptyState.build's own `fill`: a string, a node or a list of either, appended in order — which
  // is what makes the web-app link inside the sentence findable.
  const buildEmpty = (spec = {}) => {
    calls.empties.push({ tag: spec.tag, icon: spec.icon, title: spec.title, live: !!spec.live });
    const box = doc.createElement(spec.tag || 'div');
    box.className = 'empty';
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
    capabilities: { readonly: o.readonly },
    // Node installs it on the main context only, exactly as the harness documents for `URL`. Without
    // it openEditor throws instead of building its query, and every hand-off row fails for that.
    URLSearchParams,
    sessionStorage: {
      setItem: (k, v) => {
        if (o.sessionThrows) throw new Error('sessionStorage is not available');
        session.writes.push([k, v]);
      },
    },
    $: (id) => doc.getElementById(id),
    show: (view) => { calls.shows.push(view); calls.order.push(`show:${view}`); },
    toast: (msg) => { calls.toasts.push(msg); calls.order.push('toast'); },
    baseUrlHost: () => 'app.testomat.io', // core/views.js's own — the lock names where to sign in
    setStatusLine: (id, text) => { calls.lines.push({ id, text }); },
    setTabCount: (tab, n) => { calls.tabCounts.push([tab, n]); },
    paintCounter: (box, value) => { calls.counters.push(value); box.textContent = String(value); },
    staleProject: (epoch) => epoch !== state.projectEpoch,
    handleApiError: (e, id) => {
      calls.apiErrors.push({ message: e?.message ?? String(e), id });
      calls.order.push('apiError');
    },
    rememberSuiteEmoji: (roots) => { calls.emojiIndex.push(plain(roots)); calls.order.push('emoji'); },
    readonlyGate: async () => { calls.gates += 1; calls.order.push('gate'); return o.gate; },
    applyReadonlyBlock: () => { calls.blocks += 1; calls.order.push('block'); },
    Skeleton: {
      show: (view) => { calls.skeleton.push(['show', view]); return { view }; },
      hide: (handle) => { calls.skeleton.push(['hide', handle ? handle.view : handle]); },
    },
    // The real one writes data-tip on the node it is given; a recorder alone could not tell a tip
    // that landed on the right element from one that went nowhere. (shared/tooltip.js:257)
    Tooltip: {
      set: (n, tip) => {
        calls.tips.push(tip);
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    Icons: { emoji: emojiSpan },
    StatusIcons: {
      svgIcon: (name) => el('span', { className: 'md-icon', dataset: { icon: name } }),
      treeIcon,
      treeSlot: () => el('span', { className: 'tree-icon' }),
      CHEVRON: 'chevron_right',
      FOLDER: 'tree_folder',
      FILE: 'tree_suite',
    },
    EmptyState: { build: buildEmpty },
    // PriorityIcons and TestType are deliberately absent: renderTcList reaches for both behind a
    // `typeof` guard, so leaving them out is a valid panel and exercises the fallback row.
    TestomatAPI: {
      jwtAvailable: () => { calls.jwtAsked += 1; return o.jwt; },
      getSuiteTree: async () => { calls.countReads += 1; return on.tree(); },
      getSuiteTreeOrdered: async () => { calls.treeReads += 1; calls.order.push('tree'); return on.orderedTree(); },
      getTestsBySuite: async (id) => { calls.listReads.push(id); calls.order.push('read'); return on.tests(id); },
      createSuite: async (payload) => {
        calls.createSuites.push(plain(payload));
        calls.order.push('createSuite');
        return on.createSuite(payload);
      },
      createTest: async (attrs) => {
        calls.createTests.push(plain(attrs));
        calls.order.push('createTest');
        return on.createTest(attrs);
      },
      bulkCreateTests: async (id, titles) => {
        calls.bulks.push({ suiteId: id, titles: [...titles] });
        calls.order.push('bulk');
        return on.bulk(id, titles);
      },
    },
  };

  const session = { writes: [] };
  const win = {
    location: { href: '' },
    scrollTo: (arg) => { calls.scrolls.push(plain(arg)); calls.order.push('scroll'); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // The screen's own `const` arrows are lexical, not sandbox properties: named here or unreachable.
  // The `let`s are deliberately NOT named — the fields and the button are all the tester can see.
  const h = loadScreen('tc-studio', {
    globals,
    document: doc,
    window: win,
    // index.html's own order: core/suite-tree.js stands ahead of this screen, whose every paint
    // asks it what a query keeps, what the chip counts and which rows ride at the top. The REAL
    // one — a stub would leave the rows below asserting the stub's order, not the panel's (#196).
    before: [['suite-tree', CORE_SRC]],
    exported: `({ tcExpanded, tcJustCreated, tcRowMatches,
      tcQuickBulkOn, tcQuickTitle, tcQuickLines, tcQuickTitles, onTcQuickInput })`,
  });

  // app.js:61-71 wires the two search fields and the quick bar; the screen registers nothing at load,
  // so the fixture stands in for index.html's own wiring and every row below drives real listeners.
  node.search.addEventListener('input', h.fn.onTcSearch);
  node.searchClear.addEventListener('click', h.fn.clearTcSearch);
  node.treeSearch.addEventListener('input', h.fn.onTcTreeSearch);
  node.treeClear.addEventListener('click', h.fn.clearTcTreeSearch);
  if (o.quickBar) {
    node.title.addEventListener('input', h.screen.onTcQuickInput);
    node.title.addEventListener('keydown', h.fn.onTcQuickKeydown);
    node.titles.addEventListener('input', h.screen.onTcQuickInput);
    node.titles.addEventListener('keydown', h.fn.onTcQuickKeydown);
    node.create.addEventListener('click', h.fn.submitTcQuick);
    node.bulk.addEventListener('change', h.fn.onTcQuickBulkToggle);
  }

  return {
    ...h,
    lex: h.screen,
    state,
    calls,
    on,
    node,
    doc,
    win,
    session,
    // The top-level rows; then every row in the tree — a folded folder still BUILDS its children,
    // so `shownIds` is the one that answers what the tester can actually see.
    rootIds: () => node.tree.children.map((li) => li.querySelector('.tc-row')?.dataset.id),
    rowIds: () => node.tree.querySelectorAll('.tc-row').map((r) => r.dataset.id),
    shownIds: () => node.tree.querySelectorAll('.tc-row')
      .filter((r) => {
        for (let n = r; n && n !== node.tree; n = n.parentElement) if (n.hidden) return false;
        return true;
      })
      .map((r) => r.dataset.id),
    rowFor: (id) => node.tree.querySelector(`[data-id="${id}"]`),
    // Every tree row's tabindex in document order — the shape the roving model is about.
    treeTabs: () => node.tree.querySelectorAll('.tc-row[data-id]').map((r) => r.getAttribute('tabindex')),
    // What the TC list shows, empty state excluded.
    listRows: () => node.list.children.filter((li) => li.dataset.id != null),
    listTitles: () => node.list.children.filter((li) => li.dataset.id != null).map((li) => li.textContent),
    emptyTitle: (ul) => ul.querySelector('.empty-title')?.textContent ?? null,
    // The tester's own two acts on the bar.
    type: (fieldNode, value) => { fieldNode.value = value; fire(fieldNode, 'input'); },
    switchBulk: (on2) => { node.bulk.checked = on2; fire(node.bulk, 'change'); },
    // The web session answering differently later — it can lapse while the bar is open.
    setJwt: (v) => { o.jwt = v; },
    // The open inline create row, and the field inside it.
    newRow: () => node.tree.querySelector('.tc-new-suite'),
    newInput: () => node.tree.querySelector('.tc-new-suite .tree-input'),
  };
}

// ---------- what the screen makes of the filter (row 4) ----------
// Rows 1-3, 5-18 are the algorithms themselves and now live in tests/suite-tree.test.mjs, which
// drives extension/sidepanel/core/suite-tree.js with no stubs at all.

const CHECKOUT = [folder('f1', 'Checkout', [file('s1', 'Guest'), file('s2', 'Card')])];

test('4: a query nothing answers makes the screen say "No suites match" over an empty tree', () => {
  const h = load({ suites: CHECKOUT });
  h.state.tcTreeSearch = 'zzz';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.equal(h.emptyTitle(h.node.tree), 'No suites match');
  assert.deepEqual(h.rowIds(), []);
  // The identical render with a query that DOES match draws the rows instead of the plaque.
  h.state.tcTreeSearch = 'guest';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.equal(h.emptyTitle(h.node.tree), null);
  assert.deepEqual(h.rowIds(), ['f1', 's1']);
});

// ---------- what the tree render decides (rows 19-24, 74-75) ----------

test('19: a live query filters the tree and the suites made this visit still ride at the top of it', () => {
  const h = load({ suites: [folder('a', 'Alpha'), folder('b', 'Beta'), folder('c', 'Gamma')] });
  h.lex.tcJustCreated.unshift('c');
  h.state.tcTreeSearch = 'a'; // Alpha, Beta and Gamma all carry an "a"
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rootIds(), ['c', 'a', 'b']);

  // Narrow the query and the filter really is running: Beta goes, and the hoisted row stays first.
  h.state.tcTreeSearch = 'ga';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rootIds(), ['c']);
  h.state.tcTreeSearch = 'a';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rootIds(), ['c', 'a', 'b']);
  // Neither the filter nor the hoist wrote to state — the server's order is still there underneath.
  assert.deepEqual(h.state.tcSuites.map((n) => n.id), ['a', 'b', 'c']);
});

test('19b: with nothing created this visit the drawn order is the servers own', () => {
  const h = load({ suites: [folder('a', 'Alpha'), folder('b', 'Beta'), folder('c', 'Gamma')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rootIds(), ['a', 'b', 'c']);
});

test('19c: a folder draws its own children hoisted too, and its subtree comes with it', () => {
  const h = load({
    suites: [folder('f1', 'Checkout', [file('s1', 'Guest'), file('s2', 'Card')])],
    expanded: { f1: true },
  });
  h.lex.tcJustCreated.unshift('s2');
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rowIds(), ['f1', 's2', 's1']);
  assert.deepEqual(h.state.tcSuites[0].children.map((n) => n.id), ['s1', 's2']);
});

test('20: the tab chip counts the project, never what the query left standing', () => {
  const h = load({
    suites: [folder('a', 'Alpha', [], { test_count: 4 }), folder('b', 'Beta', [], { test_count: 6 })],
  });
  h.state.tcTreeSearch = 'alpha';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.rootIds(), ['a']);
  assert.deepEqual(h.calls.tabCounts, [['tests', 10]]);
});

test('21: the toolbar hides over an empty project, and stays up while a query is being typed', () => {
  const h = load();
  h.fn.renderSuiteTree([]);
  assert.equal(h.node.treeBar.hidden, true);
  h.state.tcTreeSearch = 'zzz';
  h.fn.renderSuiteTree([]);
  assert.equal(h.node.treeBar.hidden, false); // the search field lives in that same row
  h.state.tcTreeSearch = '';
  h.fn.renderSuiteTree([folder('a', 'Alpha')]);
  assert.equal(h.node.treeBar.hidden, false);
});

test('22: "no match" is only said when there WAS something to match', () => {
  const h = load();
  h.fn.renderSuiteTreeInto(h.node.tree, [], { searching: true });
  assert.equal(h.emptyTitle(h.node.tree), 'No suites match');
  h.fn.renderSuiteTreeInto(h.node.tree, [], { searching: false });
  assert.equal(h.emptyTitle(h.node.tree), 'No suites yet');
  // And an empty project the tester is searching in still reads as empty, not as a failed search.
  h.state.tcTreeSearch = 'zzz';
  h.fn.renderSuiteTree([]);
  assert.equal(h.emptyTitle(h.node.tree), 'No suites yet');
});

test('22b: the "no match" plaque is announced, and its Clear button really gives the tree back', () => {
  const h = load({ suites: CHECKOUT });
  h.state.tcTreeSearch = 'zzz';
  h.node.treeSearch.value = 'zzz';
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.calls.empties.at(-1), { tag: 'li', icon: 'manage_search', title: 'No suites match', live: true });
  fire(h.node.tree.querySelector('.empty-actions button'), 'click');
  assert.equal(h.state.tcTreeSearch, '');
  assert.equal(h.node.treeSearch.value, '');
  assert.deepEqual(h.rootIds(), ['f1']);
  assert.equal(h.doc.activeElement, h.node.treeSearch);
});

test('23: a suite holding no tests wears a "0", because a row with no badge reads as "not loaded"', () => {
  const h = load();
  const badge = h.fn.tcCounter({ test_count: 0 });
  assert.equal(badge.textContent, '0');
  assert.equal(badge.className, 'row-count');
  assert.equal(h.fn.tcCounter({ test_count: 12 }).textContent, '12');
});

test('24: a row the server sent no count for wears no badge at all', () => {
  const h = load();
  assert.equal(h.fn.tcCounter({}), null);
  assert.equal(h.fn.tcCounter({ test_count: null }), null);
  assert.equal(h.fn.tcCounter(null), null);
});

test('24b: the badge reaches the drawn row — a folders subtree total beside a files own', () => {
  const h = load({
    suites: [folder('f1', 'Checkout', [file('s1', 'Guest', { test_count: 0 })], { test_count: 9 })],
    expanded: { f1: true },
  });
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.equal(h.rowFor('f1').querySelector('.row-count').textContent, '9');
  assert.equal(h.rowFor('s1').querySelector('.row-count').textContent, '0');
});

test('74: an empty project the tester cannot create in points at the web app by name and by link', () => {
  const h = load();
  const ul = el('ul');
  h.fn.renderSuiteEmpty(ul, ' first.', false);
  const link = ul.querySelector('a');
  assert.equal(link.href, `${BASE}/projects/my%20project`);
  assert.equal(link.textContent, 'the web app');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(ul.querySelector('.empty-text').textContent, 'Create one in the web app first.');
  assert.deepEqual(ul.querySelectorAll('.empty-actions button'), []);
});

test('75: with no instance saved yet the same sentence names the web app without linking to it', () => {
  for (const settings of [null, { baseUrl: BASE }, { projectId: 'p' }]) {
    const h = load({ settings });
    const ul = el('ul');
    h.fn.renderSuiteEmpty(ul, ' to start authoring.', false);
    assert.equal(ul.querySelector('a'), null, JSON.stringify(settings));
    assert.equal(ul.querySelector('.empty-text').textContent, 'Create one in the web app to start authoring.');
  }
});

test('75b: on the Tests screen the same empty state offers Suite and Folder instead of the link', () => {
  const h = load();
  const ul = el('ul');
  h.fn.renderSuiteEmpty(ul, ' to start authoring.', true);
  assert.deepEqual(ul.querySelectorAll('.empty-actions button').map((b) => b.textContent), ['Suite', 'Folder']);
  assert.equal(ul.querySelector('.empty-text').textContent,
    'Group your test cases into suites and folders — start with one here, or in the web app.');
  // The pair really opens the inline row, at the top of the tree.
  fire(ul.querySelectorAll('.empty-actions button')[1], 'click');
  assert.equal(h.newInput().placeholder, 'Enter folder name');
});

// ---------- inline suite and folder create (rows 68-73) ----------

test('68: a blank name is not a suite — the row waits instead of sending it', async () => {
  const h = load();
  h.fn.openRootSuiteInput('file');
  h.newInput().value = '   ';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.createSuites, []);
  assert.ok(h.newRow(), 'the row stays open for a real name');
  // The same row, a real name, and it goes.
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.createSuites, [{ title: 'Checkout', parentId: null, fileType: 'file' }]);
});

test('69: a folders own New suite sends the folder as the parent, keeps it open, and re-reads the tree', async () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  h.on.orderedTree = async () => [folder('f1', 'Checkout', [file('new-1', 'Guest checkout')])];
  h.fn.renderSuiteTree(h.state.tcSuites);
  h.state.tcTreeSearch = 'checkout';          // a live filter would hide a node whose name misses it
  h.node.treeSearch.value = 'checkout';

  fire(h.rowFor('f1').querySelectorAll('.tc-new')[0], 'click'); // the "Suite" pill
  h.newInput().value = '  Guest checkout  ';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  assert.deepEqual(h.calls.createSuites, [{ title: 'Guest checkout', parentId: 'f1', fileType: 'file' }]);
  assert.deepEqual([...h.lex.tcJustCreated], ['new-1']);
  assert.equal(h.state.tcExpanded.f1, true);
  assert.equal(h.state.tcTreeSearch, '');
  assert.equal(h.node.treeSearch.value, '');
  assert.equal(h.calls.treeReads, 1);
  assert.deepEqual(h.calls.emojiIndex.length, 1);
  assert.deepEqual(h.rowIds(), ['f1', 'new-1']); // the re-render replaced the input row with the node
  assert.equal(h.newRow(), null);
});

test('69c: a folder the tester collapsed while naming is opened again, so the new suite is not hidden', async () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  h.on.orderedTree = async () => [folder('f1', 'Checkout', [file('new-1', 'Guest checkout')])];
  h.fn.renderSuiteTree(h.state.tcSuites);

  fire(h.rowFor('f1').querySelectorAll('.tc-new')[0], 'click'); // opens the folder to show the input
  // Two clicks to fold: the pill opened the folder without telling the row handler, so its first
  // click only re-opens what is already open.
  fire(h.rowFor('f1'), 'click');
  fire(h.rowFor('f1'), 'click');
  assert.equal(h.state.tcExpanded.f1, false);

  h.newInput().value = 'Guest checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  // Without this the suite lands inside a shut folder and reads as "nothing happened".
  assert.equal(h.state.tcExpanded.f1, true);
  assert.deepEqual(h.rowIds(), ['f1', 'new-1']);
});

test('69b: the tick creates the same suite the Enter key does, and a folder row asks for a folder', async () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  fire(h.rowFor('f1').querySelectorAll('.tc-new')[1], 'click'); // the "Folder" pill
  assert.equal(h.newInput().placeholder, 'Enter folder name');
  h.newInput().value = 'Payments';
  fire(h.newRow().querySelector('.tc-new-suite-ok'), 'click');
  await settle();
  assert.deepEqual(h.calls.createSuites, [{ title: 'Payments', parentId: 'f1', fileType: 'folder' }]);
});

test('70: a create the server refused keeps the row, the typed name and both buttons', async () => {
  const h = load();
  h.on.createSuite = async () => { throw new Error('403 not allowed'); };
  h.fn.openRootSuiteInput('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  assert.deepEqual(h.calls.toasts, ['403 not allowed']);
  assert.ok(h.newRow());
  assert.equal(h.newInput().value, 'Checkout');
  assert.equal(h.newRow().querySelector('.tc-new-suite-ok').disabled, false);
  assert.equal(h.newRow().querySelector('.tc-new-suite-cancel').disabled, false);
  assert.equal(h.calls.treeReads, 0);
  // The buttons really are live again: the retry goes out on the same row.
  h.on.createSuite = async () => ({ id: 'new-1' });
  fire(h.newRow().querySelector('.tc-new-suite-ok'), 'click');
  await settle();
  assert.equal(h.calls.createSuites.length, 2);
});

test('71: focus leaving the row while a create is in flight does not take the row away', async () => {
  const h = load();
  const answer = deferred();
  h.on.createSuite = () => answer.promise;
  h.fn.openRootSuiteInput('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  const row = h.newRow().querySelector('.tree-input-row');
  fire(row, 'focusout', { relatedTarget: null });
  assert.ok(h.newRow(), 'a create owns its row until it answers');
  answer.resolve({ id: 'new-1' });
  await settle();

  // With nothing in flight the very same event dismisses the row.
  const idle = load();
  idle.fn.openRootSuiteInput('file');
  fire(idle.newRow().querySelector('.tree-input-row'), 'focusout', { relatedTarget: null });
  assert.equal(idle.newRow(), null);
});

test('71b: tabbing onto the tick is still inside the row, so the row stays', () => {
  const h = load();
  h.fn.openRootSuiteInput('file');
  const row = h.newRow().querySelector('.tree-input-row');
  fire(row, 'focusout', { relatedTarget: row.querySelector('.tc-new-suite-ok') });
  assert.ok(h.newRow());
  fire(row, 'focusout', { relatedTarget: h.node.treeSearch });
  assert.equal(h.newRow(), null);
});

test('72: Escape puts the row away, and so does the cross', () => {
  const h = load();
  h.fn.openRootSuiteInput('file');
  const ev = fire(h.newInput(), 'keydown', { key: 'Escape' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(h.newRow(), null);

  h.fn.openRootSuiteInput('file');
  fire(h.newRow().querySelector('.tc-new-suite-cancel'), 'click');
  assert.equal(h.newRow(), null);
});

test('73: only one inline row at a time — opening a second takes the first away', () => {
  const h = load();
  h.fn.openRootSuiteInput('file');
  const first = h.newRow();
  first.querySelector('.tree-input').value = 'half typed';
  h.fn.openRootSuiteInput('folder');
  assert.deepEqual(h.node.tree.querySelectorAll('.tc-new-suite').length, 1);
  assert.notEqual(h.newRow(), first);
  assert.equal(h.newInput().value ?? '', '');
  assert.equal(h.newInput().placeholder, 'Enter folder name');
});

test('73b: the row mounts at the top of the tree and scrolls itself into view', () => {
  const h = load({ suites: [folder('a', 'Alpha')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  const before = h.calls.scrolledInto;
  h.fn.openRootSuiteInput('file');
  assert.equal(h.node.tree.children[0].className.includes('tc-new-suite'), true);
  assert.equal(h.calls.scrolledInto, before + 1);
  assert.equal(h.doc.activeElement, h.newInput());
});

// ---------- opening the Tests screen, and the chip's own read (rows 76-80) ----------

test('76: a tree already in memory is on screen before the re-read leaves, in the projects own order', async () => {
  const h = load({ suites: [folder('a', 'Alpha'), folder('b', 'Beta')] });
  h.lex.tcJustCreated.unshift('b'); // last visit's creation must not reshuffle this paint
  let onScreenAtRead = null;
  h.on.orderedTree = async () => {
    onScreenAtRead = h.rootIds();
    return [folder('a', 'Alpha'), folder('b', 'Beta'), folder('c', 'Gamma')];
  };
  await h.fn.openTcStudioView();

  assert.deepEqual(onScreenAtRead, ['a', 'b'], 'the cached rows were up before the fetch went out');
  assert.deepEqual([...h.lex.tcJustCreated], []);
  assert.deepEqual(h.rootIds(), ['a', 'b', 'c']);
  assert.deepEqual(h.calls.skeleton, [], 'no placeholder over rows that never left the screen');
  assert.deepEqual(h.calls.lines.at(-1), { id: 'tcstudio-status', text: '' });
});

test('76b: with nothing in memory the screen shows its placeholder and reads the tree once', async () => {
  const h = load();
  h.on.orderedTree = async () => [folder('a', 'Alpha')];
  await h.fn.openTcStudioView();
  assert.deepEqual(h.calls.skeleton, [['show', 'tcstudio'], ['hide', 'tcstudio']]);
  assert.deepEqual(h.calls.lines.map((l) => l.text), ['Loading suites…', '']);
  assert.deepEqual(h.rootIds(), ['a']);
  assert.equal(h.calls.treeReads, 1);
});

test('76c: a read that fails is reported and leaves the screen as it was', async () => {
  const h = load({ suites: [folder('a', 'Alpha')] });
  h.on.orderedTree = async () => { throw new Error('502 upstream'); };
  await h.fn.openTcStudioView();
  assert.deepEqual(h.calls.apiErrors, [{ message: '502 upstream', id: 'tcstudio-status' }]);
  assert.deepEqual(h.rootIds(), ['a'], 'the cached rows are still the best thing on screen');
});

test('77: a locked project gets the blocking panel and no tree fetch at all', async () => {
  const h = load({ gate: true });
  await h.fn.openTcStudioView();
  assert.equal(h.calls.treeReads, 0);
  assert.equal(h.calls.blocks, 1);
  assert.deepEqual(h.calls.shows, ['tcstudio']);
  assert.deepEqual(h.calls.skeleton, [['show', 'tcstudio'], ['hide', 'tcstudio']]);
  // The identical open on an unlocked project reads the tree.
  const open = load();
  await open.fn.openTcStudioView();
  assert.equal(open.calls.treeReads, 1);
  assert.equal(open.calls.blocks, 0);
});

test('77b: a project locked while its tree is cached is still blocked, after one last paint', async () => {
  const h = load({ suites: [folder('a', 'Alpha')], gate: true });
  await h.fn.openTcStudioView();
  assert.equal(h.calls.blocks, 1);
  assert.equal(h.calls.treeReads, 0);
  assert.deepEqual(h.calls.order, ['show:tcstudio', 'gate', 'block']);
});

test('78: a project switched while the tree was on the wire drops that tree on the floor', async () => {
  const h = load();
  h.on.orderedTree = async () => { h.state.projectEpoch += 1; return [folder('a', 'Alpha')]; };
  await h.fn.openTcStudioView();
  assert.deepEqual(plain(h.state.tcSuites), []);
  assert.deepEqual(h.calls.emojiIndex, []);
  assert.deepEqual(h.rootIds(), []);
  // Without the switch the very same answer lands.
  const stayed = load();
  stayed.on.orderedTree = async () => [folder('a', 'Alpha')];
  await stayed.fn.openTcStudioView();
  assert.deepEqual(stayed.rootIds(), ['a']);
  assert.equal(stayed.calls.emojiIndex.length, 1);
});

test('78b: the cached path drops a late tree too', async () => {
  const h = load({ suites: [folder('a', 'Alpha')] });
  h.on.orderedTree = async () => { h.state.projectEpoch += 1; return [folder('z', 'Zeta')]; };
  await h.fn.openTcStudioView();
  assert.deepEqual(h.state.tcSuites.map((n) => n.id), ['a']);
  assert.deepEqual(h.rootIds(), ['a']);
});

test('79: the chip is best effort — a read that fails leaves it absent instead of throwing', async () => {
  const h = load();
  h.on.tree = async () => { throw new Error('offline'); };
  await h.fn.loadTestsCount(h.state.projectEpoch);
  assert.deepEqual(h.calls.tabCounts, []);
  assert.deepEqual(h.calls.emojiIndex, []);
  assert.deepEqual(h.calls.apiErrors, []); // best effort means silent, not reported
  // The same call over a read that lands does fill the chip, so the silence above is the catch.
  h.on.tree = async () => [folder('x', 'X', [], { test_count: 4 })];
  await h.fn.loadTestsCount(h.state.projectEpoch);
  assert.deepEqual(h.calls.tabCounts, [['tests', 4]]);
});

test('80: the chip can be filled without the tree, and it leaves state.tcSuites alone', async () => {
  const cached = [folder('a', 'Alpha', [], { test_count: 1 })];
  const h = load({ suites: cached });
  h.on.tree = async () => [folder('x', 'X', [], { test_count: 4 }), folder('y', 'Y', [], { test_count: 3 })];
  await h.fn.loadTestsCount(h.state.projectEpoch);
  assert.deepEqual(h.calls.tabCounts, [['tests', 7]]);
  assert.deepEqual(h.calls.emojiIndex.map((r) => r.map((n) => n.id)), [['x', 'y']]);
  assert.equal(h.state.tcSuites, cached, 'a tree cached here would be drawn before its refetch');
});

test('80b: a project switched mid-read paints neither the chip nor the marks', async () => {
  const h = load();
  let switching = true;
  h.on.tree = async () => {
    if (switching) h.state.projectEpoch += 1;
    return [folder('x', 'X', [], { test_count: 4 })];
  };
  await h.fn.loadTestsCount(h.state.projectEpoch);
  assert.deepEqual(h.calls.tabCounts, []);
  assert.deepEqual(h.calls.emojiIndex, []);
  // The same answer with the project still open lands, so the two above are the epoch check.
  switching = false;
  await h.fn.loadTestsCount(h.state.projectEpoch);
  assert.deepEqual(h.calls.tabCounts, [['tests', 4]]);
  assert.equal(h.calls.emojiIndex.length, 1);
});

// ---------- the TC list, and the guard against two reads answering out of order (rows 25-39) ----------

test('25: with no query every row in the suite is a match', () => {
  const h = load();
  assert.equal(h.lex.tcRowMatches({ title: 'Login' }), true);
  assert.equal(h.lex.tcRowMatches({}), true);
});

test('26: a row that only carries a clean_title is searched by that', () => {
  const h = load({ search: 'log' });
  assert.equal(h.lex.tcRowMatches({ clean_title: 'Login' }), true);
  assert.equal(h.lex.tcRowMatches({ title: 'Login' }), true);
  // …and the title wins when a row has both, which is why an unmatching title is not saved by it.
  assert.equal(h.lex.tcRowMatches({ title: 'Checkout', clean_title: 'Login' }), false);
});

test('27: a nameless row matches no query', () => {
  const h = load({ search: 'log' });
  assert.equal(h.lex.tcRowMatches({}), false);
  assert.equal(h.lex.tcRowMatches({ title: 'Checkout' }), false);
});

test('28: the caption counts what is on screen, not what the suite holds', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: i < 2 ? `Login ${i}` : `Other ${i}` }));
  const h = load({ tests: rows, search: 'login' });
  h.fn.renderTcList();
  assert.deepEqual(h.listTitles(), ['Login 0', 'Login 1']);
  assert.deepEqual(h.calls.counters, [2]);
  assert.equal(h.node.listCount.hidden, false);
  // Clear the query and the same list says ten, so the 2 above is the filter and not the fixture.
  h.state.tcSearch = '';
  h.fn.renderTcList();
  assert.deepEqual(h.calls.counters, [2, 10]);
});

test('29: an empty suite is a place to write the first case, and a real 0 beside it', () => {
  const h = load();
  h.fn.renderTcList();
  assert.equal(h.emptyTitle(h.node.list), 'No test cases yet');
  assert.deepEqual(h.calls.counters, [0]);
  assert.equal(h.node.listCount.hidden, false);
  assert.equal(h.node.listCount.textContent, '0');
  // Its New test button is the toolbar's, so an empty suite has one way in, not two.
  fire(h.node.list.querySelector('.empty-actions button'), 'click');
  assert.equal(h.calls.listNew, 1);
});

test('30: a suite with rows and a query that matches none of them just needs clearing', () => {
  const h = load({ tests: [{ id: 't1', title: 'Login' }], search: 'zzz' });
  h.fn.renderTcList();
  assert.equal(h.emptyTitle(h.node.list), 'No tests match');
  assert.deepEqual(h.calls.empties.at(-1), { tag: 'li', icon: 'manage_search', title: 'No tests match', live: true });
  assert.deepEqual(h.calls.counters, [0]);
  // Its Clear button gives the row back.
  h.node.search.value = 'zzz';
  fire(h.node.list.querySelector('.empty-actions button'), 'click');
  assert.deepEqual(h.listTitles(), ['Login']);
  assert.equal(h.node.search.value, '');
  assert.equal(h.doc.activeElement, h.node.search);
});

test('31: clicking a row opens that test, with the suite it was opened from as the way back', () => {
  const h = load({ tests: [{ id: '5', title: 'Login' }], suiteId: 's1', suiteTitle: 'Checkout' });
  h.fn.renderTcList();
  fire(h.listRows()[0], 'click');
  assert.deepEqual(h.session.writes, [['tcReturn', '{"suiteId":"s1","suiteTitle":"Checkout"}']]);
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&test=5');
});

test('31b: a row wears the title the server gave it, whichever field carried it', () => {
  const h = load({ tests: [{ id: '1', clean_title: 'Login' }, { id: '2' }, { id: '3', title: 'Card', emoji: '🔥' }] });
  h.fn.renderTcList();
  assert.deepEqual(h.listTitles(), ['Login', '(untitled)', '🔥Card']);
});

test('32: two reads of the same suite, and only the newer one is allowed to paint', async () => {
  const h = load({ suiteId: 's1' });
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  h.on.tests = () => queue.shift();

  const older = h.fn.loadTcList('s1', { quiet: true });
  const newer = h.fn.loadTcList('s1', { quiet: true });
  second.resolve([{ id: 't2', title: 'the newer answer' }]);
  await newer;
  first.resolve([{ id: 't1', title: 'the older answer' }]);
  await older;

  assert.deepEqual(h.listTitles(), ['the newer answer']);
  assert.deepEqual(plain(h.state.tcTests).map((t) => t.id), ['t2']);
});

test('32b: one read on its own does paint — the guard is a race, not a mute', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => [{ id: 't1', title: 'Login' }];
  await h.fn.loadTcList('s1', { quiet: true });
  assert.deepEqual(h.listTitles(), ['Login']);
});

test('33: rows for a suite the tester has already left are dropped, not painted over the new one', async () => {
  const h = load({ suiteId: 's1' });
  const answer = deferred();
  h.on.tests = () => answer.promise;
  const inFlight = h.fn.loadTcList('s1');
  h.state.tcSuiteId = 's2'; // the tester opened another suite while this was on the wire
  answer.resolve([{ id: 't1', title: 'last suites row' }]);
  await inFlight;

  assert.deepEqual(h.listTitles(), []);
  assert.deepEqual(plain(h.state.tcTests), []);
  assert.deepEqual(h.calls.skeleton, [['show', 'tclist'], ['hide', 'tclist']]); // it still tidies up
  // The identical read for the suite that IS open paints, so the silence above is the guard.
  h.on.tests = async () => [{ id: 't2', title: 'this suites row' }];
  await h.fn.loadTcList('s2');
  assert.deepEqual(h.listTitles(), ['this suites row']);
});

test('33b: the panel-wide refresh is a re-read in place of the suite still open', async () => {
  const h = load({ suiteId: 's1', tests: [{ id: 't1', title: 'Login' }] });
  h.on.tests = async () => [{ id: 't1', title: 'Login' }, { id: 't2', title: 'Logout' }];
  await h.fn.refreshTcList();
  assert.deepEqual(h.calls.listReads, ['s1']);
  assert.deepEqual(h.calls.skeleton, [], 'the rows stay up until it lands');
  assert.deepEqual(h.listTitles(), ['Login', 'Logout']);
  // With no suite open there is nothing to refresh.
  const none = load();
  await none.fn.refreshTcList();
  assert.deepEqual(none.calls.listReads, []);
});

test('33c: a suite id of another type than the one in state never paints — no caller mixes them today', async () => {
  const h = load({ suiteId: '7' });
  h.on.tests = async () => [{ id: 't1', title: 'Login' }];
  await h.fn.loadTcList(7); // a number against the string state holds
  assert.deepEqual(h.listTitles(), []);
  // The same read with the id state actually holds paints, so the silence above is the compare.
  await h.fn.loadTcList('7');
  assert.deepEqual(h.listTitles(), ['Login']);
});

test('34: the suites own order is position ascending, and a row without one goes first', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => [
    { id: 'c', title: 'C', position: 3 },
    { id: 'b', title: 'B', position: 1 },
    { id: 'a', title: 'A' },
  ];
  await h.fn.loadTcList('s1');
  assert.deepEqual(h.listTitles(), ['A', 'B', 'C']);
  assert.deepEqual(plain(h.state.tcTests).map((t) => t.id), ['a', 'b', 'c']);
});

test('34b: a negative position is still ahead of the row that has none', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', position: -1 }];
  await h.fn.loadTcList('s1');
  assert.deepEqual(h.listTitles(), ['B', 'A']);
});

test('35: a quiet re-read puts no placeholder and no line over rows that are still there', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => [{ id: 't1', title: 'Login' }];
  await h.fn.loadTcList('s1', { quiet: true });
  assert.deepEqual(h.calls.skeleton, []);
  assert.deepEqual(h.calls.lines.map((l) => l.text), ['']); // only renderTcList's own clear
  // The loud read, driven identically, does both.
  const loud = load({ suiteId: 's1' });
  loud.on.tests = async () => [{ id: 't1', title: 'Login' }];
  await loud.fn.loadTcList('s1');
  assert.deepEqual(loud.calls.skeleton, [['show', 'tclist'], ['hide', 'tclist']]);
  assert.deepEqual(loud.calls.lines.map((l) => l.text), ['Loading tests…', '']);
});

test('36: a read that fails is reported on the lists own line, and takes its placeholder down', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => { throw new Error('502 upstream'); };
  await h.fn.loadTcList('s1');
  assert.deepEqual(h.calls.apiErrors, [{ message: '502 upstream', id: 'tclist-status' }]);
  assert.deepEqual(h.calls.skeleton, [['show', 'tclist'], ['hide', 'tclist']]);
  assert.deepEqual(h.listTitles(), []);
  // A quiet read that fails reports the same way, with no placeholder to take down.
  const quiet = load({ suiteId: 's1' });
  quiet.on.tests = async () => { throw new Error('502 upstream'); };
  await quiet.fn.loadTcList('s1', { quiet: true });
  assert.deepEqual(quiet.calls.apiErrors, [{ message: '502 upstream', id: 'tclist-status' }]);
  assert.deepEqual(quiet.calls.skeleton, []);
});

test('37: a locked project shows the list screen and reads nothing into it', async () => {
  const h = load({ readonly: true });
  await h.fn.openTcListView('s1', 'Checkout');
  assert.deepEqual(h.calls.shows, ['tclist']);
  assert.deepEqual(h.calls.listReads, []);
  assert.equal(h.state.tcSuiteId, null); // it did not even record which suite was asked for
  // The identical open on an unlocked project reads the suite.
  const open = load();
  await open.fn.openTcListView('s1', 'Checkout');
  assert.deepEqual(open.calls.listReads, ['s1']);
  assert.equal(open.state.tcSuiteTitle, 'Checkout');
});

test('38: coming back to the suite already open keeps its rows up and its half-typed title', async () => {
  const h = load({ suiteId: 's1', suiteTitle: 'Checkout', tests: [{ id: 't1', title: 'Login' }] });
  h.node.title.value = 'half typed';
  let onScreenAtRead = null;
  h.on.tests = async () => {
    onScreenAtRead = h.listTitles();
    return [{ id: 't1', title: 'Login' }, { id: 't2', title: 'Logout' }];
  };
  await h.fn.openTcListView('s1', 'Checkout');

  assert.deepEqual(onScreenAtRead, ['Login'], 'the rows were up before the re-read went out');
  assert.deepEqual(h.calls.skeleton, [], 'a quiet re-read under rows that never left');
  assert.equal(h.node.title.value, 'half typed', 'a return is not a suite change');
  assert.deepEqual(h.listTitles(), ['Login', 'Logout']);
});

test('39: a different suite starts clean — the bar, the rows and the chip all go first', async () => {
  const h = load({ suiteId: 's1', suiteTitle: 'Checkout', tests: [{ id: 't1', title: 'Login' }] });
  h.fn.renderTcList();
  h.node.title.value = 'half typed';
  assert.equal(h.node.listCount.hidden, false);

  const seen = {};
  h.on.tests = async () => {
    seen.rows = h.listTitles();
    seen.chipHidden = h.node.listCount.hidden;
    return [{ id: 't9', title: 'Guest checkout' }];
  };
  await h.fn.openTcListView('s2', 'Payments');

  assert.equal(h.node.title.value, '', 'a different suite resets the quick bar');
  assert.deepEqual(seen.rows, [], 'the previous suites rows went before the read');
  assert.equal(seen.chipHidden, true, 'the previous suites number is not this ones');
  assert.deepEqual(h.calls.skeleton, [['show', 'tclist'], ['hide', 'tclist']]);
  assert.deepEqual(h.listTitles(), ['Guest checkout']);
  assert.equal(h.state.tcSuiteTitle, 'Payments');
});

test('39b: a suite opened with no title of its own is still named on the way back', async () => {
  const h = load();
  await h.fn.openTcListView('s2', '');
  assert.equal(h.state.tcSuiteTitle, 'Suite');
});

test('39c: opening a suite wears the mark the tree gave it, and drops it when the tree has none', async () => {
  const h = load({ suites: [file('s1', 'Checkout', { emoji: '🔥' })] });
  await h.fn.openTcListView('s1', 'Checkout');
  assert.equal(h.state.tcSuiteEmoji, '🔥');
  await h.fn.openTcListView('s2', 'Payments');
  assert.equal(h.state.tcSuiteEmoji, null);
});

// One roving tab stop per list, not one per row: Tab enters the tree once, the arrows walk it, and
// Enter opens the row under them. The helper's own contract is tests/roving.test.mjs.
test('81 (#109): a suite row and a test row are reachable from the keyboard', () => {
  const h = load({
    suites: [folder('f1', 'Checkout', [file('s1', 'Guest')]), file('s2', 'Payments')],
    tests: [{ id: 't1', title: 'Login' }],
  });
  h.fn.renderSuiteTree(h.state.tcSuites);
  h.fn.renderTcList();

  const treeRow = h.rowFor('f1');
  assert.equal(treeRow.getAttribute('role'), 'button', 'a reader is told the row is actionable');
  assert.equal(treeRow.getAttribute('tabindex'), '0');

  // Down moves to the next row and takes the tab stop with it — the folded 'Guest' is stepped over.
  assert.equal(key(treeRow, 'ArrowDown').defaultPrevented, true);
  assert.equal(h.doc.activeElement, h.rowFor('s2'));
  assert.deepEqual(h.treeTabs(), ['-1', '-1', '0'], 'exactly one row is a tab stop');

  // Enter on the folder does what clicking it does: it opens.
  assert.equal(key(treeRow, 'Enter').defaultPrevented, true);
  assert.equal(treeRow.className.includes('expanded'), true);
  assert.deepEqual(h.shownIds(), ['f1', 's1', 's2']);

  // The TC list is a list of its own, with its own single tab stop.
  const listRow = h.listRows()[0];
  assert.equal(listRow.getAttribute('role'), 'button');
  assert.equal(listRow.getAttribute('tabindex'), '0');
  assert.equal(key(listRow, ' ').defaultPrevented, true, 'Space opens, and does not scroll');
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&test=t1');

  // …and Enter on a file row opens its list, exactly as the click listener would.
  key(h.rowFor('s2'), 'Enter');
  assert.deepEqual(h.calls.shows, ['tclist']);
});

test('81b (#109): the suite PICKER is the same tree, so it gets the same keyboard', () => {
  const h = load();
  const picked = [];
  h.fn.renderSuiteTreeInto(h.node.promote, [file('s1', 'Checkout'), file('s2', 'Payments')], {
    pick: true,
    onPick: (n) => picked.push(n.id),
  });
  const rows = h.node.promote.querySelectorAll('.tc-row');
  assert.deepEqual(rows.map((r) => r.getAttribute('role')), ['button', 'button']);

  key(rows[0], 'ArrowDown');
  assert.equal(h.doc.activeElement, rows[1]);
  key(rows[1], 'Enter');
  assert.deepEqual(picked, ['s2']);
});

test('81c (#109): the inline create field keeps every key typed into it, tree or no tree', () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  h.fn.openRootSuiteInput('file');
  const input = h.newInput();

  // Space and the arrows are text and caret movement here — not "open the row under me".
  assert.equal(fire(input, 'keydown', { key: ' ', bubbles: true }).defaultPrevented, false);
  assert.equal(fire(input, 'keydown', { key: 'ArrowDown', bubbles: true }).defaultPrevented, false);
  assert.equal(h.calls.shows.length, 0);
  // The create row is a `.tc-row` too, but it is not a stop the arrows may land on.
  assert.equal(h.newRow().querySelector('.tc-row').getAttribute('role'), null);
  key(h.rowFor('f1'), 'ArrowUp');
  assert.equal(h.doc.activeElement, h.rowFor('f1'));
});

// 81d: the row is a role="button" that folds a branch, and the chevron pointing one way or the
// other is a picture. Three places write this fold, and a reader believes whichever wrote last.
test('81d (#109): a folder row says whether it is open — and a file row claims no fold at all', () => {
  const h = load({ suites: [folder('f1', 'Checkout', [file('s1', 'Guest')]), file('s2', 'Payments')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  const folderRow = h.rowFor('f1');
  assert.equal(folderRow.getAttribute('aria-expanded'), 'false');
  assert.equal(h.rowFor('s2').getAttribute('aria-expanded'), null, 'a leaf folds nothing');
  assert.equal(h.rowFor('s1').getAttribute('aria-expanded'), null);

  fire(folderRow, 'click');
  assert.equal(folderRow.getAttribute('aria-expanded'), 'true');
  fire(folderRow, 'click');
  assert.equal(folderRow.getAttribute('aria-expanded'), 'false');

  // The New-suite button opens the folder to show the field it mounts inside — a fold write too.
  fire(folderRow.querySelector('.tc-new'), 'click', { bubbles: true });
  assert.equal(folderRow.getAttribute('aria-expanded'), 'true');
  assert.equal(h.rowFor('s1').closest('.tc-children').hidden, false, 'and the fold it claims is the real one');

  // …and a row rebuilt from the expand set is born saying it, not left to a toggle to correct.
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.equal(h.rowFor('f1').getAttribute('aria-expanded'), 'true');
});

// ---------- the two search fields, and what a reset is allowed to touch (rows 4d-30c) ----------

test('4b: typing in the tree search narrows the tree and reveals the branch under every match', () => {
  const h = load({ suites: [folder('f1', 'Checkout', [file('s1', 'Guest')]), folder('f2', 'Payments')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  assert.deepEqual(h.shownIds(), ['f1', 'f2'], 'the folders start folded');

  h.type(h.node.treeSearch, 'guest');
  assert.equal(h.state.tcTreeSearch, 'guest');
  assert.deepEqual(h.shownIds(), ['f1', 's1'], 'a match deep inside a folded folder is opened to');
  assert.equal(h.node.treeClear.hidden, false);
  assert.deepEqual(h.state.tcExpanded, {}, 'and the testers own folding was not written over');

  // Clearing gives the folding back exactly as it was, which is what the untouched set above is for.
  fire(h.node.treeClear, 'click');
  assert.deepEqual(h.shownIds(), ['f1', 'f2']);
});

test('4b2: clicking a folder opens it and writes that down; the search never does', () => {
  const h = load({ suites: [folder('f1', 'Checkout', [file('s1', 'Guest')])] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  fire(h.rowFor('f1'), 'click');
  assert.deepEqual(h.shownIds(), ['f1', 's1']);
  assert.equal(h.state.tcExpanded.f1, true);
  assert.equal(h.rowFor('f1').className.includes('expanded'), true);
  fire(h.rowFor('f1'), 'click');
  assert.deepEqual(h.shownIds(), ['f1']);
  assert.equal(h.state.tcExpanded.f1, false);
});

test('4c: the clear button drops the query, redraws and puts the caret back in the field', () => {
  const h = load({ suites: [folder('f1', 'Checkout'), folder('f2', 'Payments')] });
  h.type(h.node.treeSearch, 'checkout');
  assert.deepEqual(h.rowIds(), ['f1']);
  fire(h.node.treeClear, 'click');
  assert.equal(h.state.tcTreeSearch, '');
  assert.equal(h.node.treeSearch.value, '');
  assert.equal(h.node.treeClear.hidden, true);
  assert.deepEqual(h.rowIds(), ['f1', 'f2']);
  assert.equal(h.doc.activeElement, h.node.treeSearch);
});

test('4d: a reset drops the query behind the fields back, without redrawing anything', () => {
  const h = load({ suites: [folder('f1', 'Checkout'), folder('f2', 'Payments')] });
  h.type(h.node.treeSearch, 'checkout');
  assert.deepEqual(h.rowIds(), ['f1']);
  h.fn.resetTcTreeSearch();
  assert.equal(h.state.tcTreeSearch, '');
  assert.equal(h.node.treeSearch.value, '');
  assert.equal(h.node.treeClear.hidden, true);
  assert.deepEqual(h.rowIds(), ['f1'], 'the caller is about to redraw anyway');
  assert.notEqual(h.doc.activeElement, h.node.treeSearch, 'and it does not steal the caret');
});

test('4e: a query held in state paints itself into the field on the way in, whitespace and all', () => {
  const h = load({ treeQuery: 'checkout' });
  h.node.treeSearch.value = 'stale';
  h.fn.syncTcTreeSearchInput();
  assert.equal(h.node.treeSearch.value, 'checkout');
  assert.equal(h.node.treeClear.hidden, false);
  // A query of nothing but spaces is not a query: the clear button goes.
  h.state.tcTreeSearch = '   ';
  h.fn.syncTcTreeSearchInput();
  assert.equal(h.node.treeSearch.value, '   ');
  assert.equal(h.node.treeClear.hidden, true);
});

test('30b: the list search narrows the rows and lights its own clear button', () => {
  const h = load({ tests: [{ id: 't1', title: 'Login' }, { id: 't2', title: 'Checkout' }] });
  h.fn.renderTcList();
  h.type(h.node.search, 'log');
  assert.equal(h.state.tcSearch, 'log');
  assert.deepEqual(h.listTitles(), ['Login']);
  assert.equal(h.node.searchClear.hidden, false);
  fire(h.node.searchClear, 'click');
  assert.deepEqual(h.listTitles(), ['Login', 'Checkout']);
  assert.equal(h.node.searchClear.hidden, true);
  assert.equal(h.doc.activeElement, h.node.search);
});

test('30c: the list reset drops the query without redrawing and without taking the caret', () => {
  const h = load({ tests: [{ id: 't1', title: 'Login' }, { id: 't2', title: 'Checkout' }] });
  h.type(h.node.search, 'log');
  assert.deepEqual(h.listTitles(), ['Login']);
  h.fn.resetTcSearch();
  assert.equal(h.state.tcSearch, '');
  assert.equal(h.node.search.value, '');
  assert.equal(h.node.searchClear.hidden, true);
  assert.deepEqual(h.listTitles(), ['Login'], 'the quick bars create redraws right after it');
  assert.notEqual(h.doc.activeElement, h.node.search);
  // A panel without the field is not a crash — the reset is called from a suite open too.
  h.node.search.remove();
  h.node.searchClear.remove();
  h.fn.resetTcSearch();
});

// ---------- the quick / bulk create bar (rows 40-63) ----------

test('40: a title is trimmed at the ends and collapsed in the middle, the way the web trims one', () => {
  const h = load();
  h.node.title.value = '  Log   in  ';
  assert.equal(h.lex.tcQuickTitle(), 'Log in');
  h.node.title.value = '\tLog\nin\t';
  assert.equal(h.lex.tcQuickTitle(), 'Log in');
  h.node.title.value = '   ';
  assert.equal(h.lex.tcQuickTitle(), '');
});

test('41: a pasted list keeps its order and its duplicates, and drops only the blank lines', () => {
  const h = load();
  h.node.titles.value = 'a\n\n b \nb';
  assert.deepEqual([...h.lex.tcQuickLines()], ['a', 'b', 'b']);
});

test('42: a list pasted from a Windows editor loses its carriage returns to the same trim', () => {
  const h = load();
  h.node.titles.value = 'a\r\nb';
  assert.deepEqual([...h.lex.tcQuickLines()], ['a', 'b']);
});

test('43: an empty quick field has nothing to send, so Create is dead', () => {
  const h = load();
  h.type(h.node.title, '   ');
  assert.deepEqual([...h.lex.tcQuickTitles()], []);
  assert.equal(h.node.create.disabled, true);
  // One real word and the very same button is live.
  h.type(h.node.title, 'Login');
  assert.deepEqual([...h.lex.tcQuickTitles()], ['Login']);
  assert.equal(h.node.create.disabled, false);
});

test('44: a send already on the wire leaves Create dead however much is typed under it', () => {
  const h = load();
  h.type(h.node.title, 'Login');
  assert.equal(h.node.create.disabled, false);
  h.fn.setTcQuickBusy(true);
  assert.equal(h.node.create.disabled, true);
  h.type(h.node.title, 'Login again');
  assert.equal(h.node.create.disabled, true);
  h.fn.setTcQuickBusy(false);
  assert.equal(h.node.create.disabled, false);
});

test('45: Bulk takes the typed title with it as the first line, and hands the caret to the list', () => {
  const h = load();
  h.type(h.node.title, 'first');
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first');
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.title.hidden, true);
  assert.equal(h.node.titles.hidden, false);
  assert.equal(h.doc.activeElement, h.node.titles);
  // Nothing was parked on the way in: the round trip brings back that one line and no more.
  h.switchBulk(false);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first');
});

test('46: the lines the quick field could not show waited in memory for Bulk to come back', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);              // b and c park; the field shows a
  h.type(h.node.title, 'first');    // the tester renames the one line they can see
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first\nb\nc');
});

test('47: leaving Bulk keeps the first line in the field and parks the rest', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);
  assert.equal(h.node.title.value, 'a');
  assert.equal(h.node.titles.value, '');
  assert.equal(h.node.title.hidden, false);
  assert.equal(h.node.titles.hidden, true);
  assert.equal(h.doc.activeElement, h.node.title);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'a\nb\nc', 'b and c really were parked');
});

test('48: leaving an empty Bulk list parks nothing and leaves an empty field', () => {
  const h = load();
  h.switchBulk(true);
  h.switchBulk(false);
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.create.disabled, true);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, '', 'nothing was parked to come back');
});

test('49: Enter in the quick field creates, and the key never reaches the panel', async () => {
  const h = load({ suiteId: 's1' });
  h.type(h.node.title, 'Login');
  const ev = fire(h.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

test('50: a modifier held with Enter in the quick field is somebody elses shortcut', async () => {
  for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    const h = load({ suiteId: 's1' });
    h.type(h.node.title, 'Login');
    const ev = fire(h.node.title, 'keydown', { key: 'Enter', [mod]: true });
    await settle();
    assert.deepEqual(h.calls.createTests, [], mod);
    assert.equal(ev.defaultPrevented, false, mod);
  }
  // The same key with no modifier on it does create.
  const bare = load({ suiteId: 's1' });
  bare.type(bare.node.title, 'Login');
  fire(bare.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(bare.calls.createTests.length, 1);
});

test('51: in Bulk a bare Enter is a newline, not a send', async () => {
  const h = load({ suiteId: 's1' });
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb');
  const ev = fire(h.node.titles, 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.bulks, []);
  assert.equal(ev.defaultPrevented, false);
  // The same key with Cmd held, in the same box, does send it.
  fire(h.node.titles, 'keydown', { key: 'Enter', metaKey: true });
  await settle();
  assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b'] }]);
});

test('52: in Bulk it is Cmd or Ctrl with Enter that sends the list', async () => {
  for (const mod of ['metaKey', 'ctrlKey']) {
    const h = load({ suiteId: 's1' });
    h.switchBulk(true);
    h.type(h.node.titles, 'a\nb');
    const ev = fire(h.node.titles, 'keydown', { key: 'Enter', [mod]: true });
    await settle();
    assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b'] }], mod);
    assert.equal(ev.defaultPrevented, true, mod);
  }
});

test('53: every other key is just typing', async () => {
  const h = load({ suiteId: 's1' });
  h.type(h.node.title, 'Login');
  for (const key of ['a', 'Escape', 'Tab', 'ArrowDown']) {
    const ev = fire(h.node.title, 'keydown', { key });
    assert.equal(ev.defaultPrevented, false, key);
  }
  await settle();
  assert.deepEqual(h.calls.createTests, []);
  // Enter into the very same field does create, so the four above are the key check.
  fire(h.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(h.calls.createTests.length, 1);
});

test('54: one title creates one test in the open suite, then the bar clears and the list re-reads', async () => {
  const h = load({ suiteId: 's1' });
  h.on.tests = async () => [{ id: 'made-1', title: 'Login' }];
  h.type(h.node.title, '  Log   in  ');
  fire(h.node.create, 'click');
  await settle();

  assert.deepEqual(h.calls.createTests, [{ title: 'Log in', suite_id: 's1' }]);
  assert.deepEqual(h.calls.bulks, []);
  assert.equal(h.node.title.value, '');
  assert.deepEqual(h.calls.listReads, ['s1']);
  assert.deepEqual(h.calls.skeleton, [], 'the re-read is quiet — the rows are still up');
  assert.deepEqual(h.calls.scrolls, [{ top: 4321 }]);
  assert.equal(h.doc.activeElement, h.node.title, 'the caret goes back for the next title');
  assert.equal(h.node.create.textContent, 'Create');
});

test('55: a whole pasted list is one request, not one per line', async () => {
  const h = load({ suiteId: 's1' });
  h.switchBulk(true);
  h.type(h.node.titles, 'a\n\nb\nc');
  fire(h.node.create, 'click');
  await settle();

  assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b', 'c'] }]);
  assert.deepEqual(h.calls.createTests, []);
  assert.equal(h.node.titles.value, '');
  assert.deepEqual(h.calls.listReads, ['s1']);
  // And what it cleared is really gone: coming back out of Bulk finds nothing parked.
  h.switchBulk(false);
  assert.equal(h.node.title.value, '');
});

test('56: with no suite open there is nothing to create in', async () => {
  const h = load({ suiteId: null });
  h.type(h.node.title, 'Login');
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.createTests, []);
  assert.deepEqual(h.calls.listReads, []);
  // The identical press once a suite is open does create.
  h.state.tcSuiteId = 's1';
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

test('57: a second press while the first create is on the wire sends nothing', async () => {
  const h = load({ suiteId: 's1' });
  const answer = deferred();
  h.on.createTest = () => answer.promise;
  h.type(h.node.title, 'Login');
  const first = h.fn.submitTcQuick();
  await settle();
  assert.equal(h.node.create.disabled, true);
  await h.fn.submitTcQuick();
  assert.equal(h.calls.createTests.length, 1);
  answer.resolve({ id: 'made-1' });
  await first;
  // Once it lands the button is live again, and the next press really does go out.
  h.type(h.node.title, 'Logout');
  await h.fn.submitTcQuick();
  assert.equal(h.calls.createTests.length, 2);
});

test('58: a create the server refused keeps the typed titles, lets the button go and gives the caret back', async () => {
  const h = load({ suiteId: 's1' });
  h.on.createTest = async () => { throw new Error('422 title taken'); };
  h.type(h.node.title, 'Login');
  await h.fn.submitTcQuick();

  assert.deepEqual(h.calls.toasts, ['422 title taken']);
  assert.equal(h.node.title.value, 'Login');
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.create.disabled, false);
  assert.equal(h.node.create.textContent, 'Create');
  assert.equal(h.doc.activeElement, h.node.title);
  assert.deepEqual(h.calls.listReads, [], 'nothing was made, so there is nothing to read back');
});

test('58b: a refused bulk keeps the whole pasted list in the box', async () => {
  const h = load({ suiteId: 's1' });
  h.on.bulk = async () => { throw new Error('Bulk needs a web session'); };
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.toasts, ['Bulk needs a web session']);
  assert.equal(h.node.titles.value, 'a\nb\nc');
  assert.equal(h.doc.activeElement, h.node.titles);
});

test('59: a live search would hide the very row just made, so it is dropped before the re-read', async () => {
  const h = load({ suiteId: 's1', tests: [{ id: 't0', title: 'Checkout' }] });
  h.type(h.node.search, 'checkout');
  assert.deepEqual(h.listTitles(), ['Checkout']);

  let queryAtRead = null;
  h.on.tests = async () => {
    queryAtRead = h.state.tcSearch;
    return [{ id: 't0', title: 'Checkout' }, { id: 'made-1', title: 'Login' }];
  };
  h.type(h.node.title, 'Login');
  await h.fn.submitTcQuick();

  assert.equal(queryAtRead, '', 'the query was dropped BEFORE the rows came back');
  assert.equal(h.node.search.value, '');
  assert.equal(h.node.searchClear.hidden, true);
  assert.deepEqual(h.listTitles(), ['Checkout', 'Login']);
  // With the query still up that same row would have been drawn away — which is what this is for.
  h.type(h.node.search, 'checkout');
  assert.deepEqual(h.listTitles(), ['Checkout']);
});

test('60: a suite opened while the create was in flight is not scrolled and does not lose its caret', async () => {
  const h = load({ suiteId: 's1' });
  h.on.createTest = async () => { h.state.tcSuiteId = 's2'; return { id: 'made-1' }; };
  h.type(h.node.title, 'Login');
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.scrolls, []);
  assert.equal(h.doc.activeElement, null);
  assert.deepEqual(h.listTitles(), [], 'and the new suites list was not painted with the old ones row');
  // The same create with the tester still on that suite scrolls to the end and takes the caret back.
  const stayed = load({ suiteId: 's1' });
  stayed.type(stayed.node.title, 'Login');
  await stayed.fn.submitTcQuick();
  assert.deepEqual(stayed.calls.scrolls, [{ top: 4321 }]);
  assert.equal(stayed.doc.activeElement, stayed.node.title);
});

test('61: a title in flight is still the testers to read — the fields go read-only, not disabled', () => {
  const h = load();
  h.fn.setTcQuickBusy(true);
  assert.equal(h.node.title.readOnly, true);
  assert.equal(h.node.titles.readOnly, true);
  assert.equal(h.node.title.disabled, false);
  assert.equal(h.node.titles.disabled, false);
  assert.equal(h.node.bulk.disabled, true);
  assert.equal(h.node.create.textContent, 'Creating…');
  h.fn.setTcQuickBusy(false);
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.titles.readOnly, false);
  assert.equal(h.node.bulk.disabled, false);
  assert.equal(h.node.create.textContent, 'Create');
});

test('62: every suite open starts the bar clean — quick mode, both fields empty, nothing parked', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);            // b and c are parked
  h.type(h.node.title, 'a');
  h.fn.setTcQuickBusy(true);

  h.fn.resetTcQuickBar();
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.titles.value, '');
  assert.equal(h.node.bulk.checked, false);
  assert.equal(h.node.title.hidden, false);
  assert.equal(h.node.titles.hidden, true);
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.create.textContent, 'Create');
  assert.equal(h.node.create.disabled, true);
  // The parked lines are gone too: Bulk comes back to an empty box.
  h.switchBulk(true);
  assert.equal(h.node.titles.value, '');
});

test('63: a panel drawn without the bar is not a crash', () => {
  load({ quickBar: false }).fn.resetTcQuickBar();
  // Half a bar is not one either — the reset wants both fields before it touches anything.
  const half = load();
  half.type(half.node.title, 'Login');
  half.node.titles.remove();
  half.fn.resetTcQuickBar();
  assert.equal(half.node.title.value, 'Login');
  // And with the whole bar in the page it really does clear it, so the two above are not stubs.
  const full = load();
  full.type(full.node.title, 'Login');
  full.fn.resetTcQuickBar();
  assert.equal(full.node.title.value, '');
});

// ---------- the switch nobody gates (#263) ----------

test('63b: Bulk is not offered on a token-only connection, and the session is re-asked at submit (#263)', async () => {
  // bulkCreateTests goes through jwtRequest and needs an active web session; createTest does not.
  const none = load({ suiteId: 's1', jwt: false });
  none.fn.resetTcQuickBar();
  assert.equal(none.node.bulk.disabled, true);
  assert.match(none.node.bulkLabel.dataset.tip, /web login/);

  // The same bar WITH a session offers it, and keeps its ordinary tip — so the row above is not
  // asserting a switch that is disabled whatever happens.
  const h = load({ suiteId: 's1', jwt: true });
  h.fn.resetTcQuickBar();
  assert.equal(h.node.bulk.disabled, false);
  assert.equal(h.node.bulkLabel.dataset.tip, 'Add more');

  // Still probing is not a refusal: an 'unknown' answer must never take the switch away.
  const probing = load({ suiteId: 's1', jwt: 'unknown' });
  probing.fn.resetTcQuickBar();
  assert.equal(probing.node.bulk.disabled, false);

  // And the session can lapse after the bar was drawn: the submit asks again and sends nothing.
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb');
  h.setJwt(false);
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.bulks, []);
  assert.match(h.calls.toasts.at(-1), /web login/);

  // The single-title path never needed the web session and still does not.
  h.switchBulk(false);
  h.type(h.node.title, 'Login');
  await h.fn.submitTcQuick();
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

// ---------- the hand-off to the test page (rows 64-67) ----------

test('64: opening an existing test leaves the suite behind as a breadcrumb and navigates by id', () => {
  const h = load();
  h.fn.openEditor({ test: '5', suiteId: 's1', suiteTitle: 'Checkout' });
  assert.deepEqual(h.session.writes, [['tcReturn', '{"suiteId":"s1","suiteTitle":"Checkout"}']]);
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&test=5');
});

test('65: a new test opens the same page in create mode, bound to the suite that was chosen', () => {
  const h = load();
  h.fn.openEditor({ suite: 's1', suiteId: 's1', suiteTitle: 'Checkout' });
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&suite=s1');
  assert.deepEqual(h.session.writes, [['tcReturn', '{"suiteId":"s1","suiteTitle":"Checkout"}']]);
});

test('66: a window that refuses session storage still opens the test — Back just falls through to runs', () => {
  const h = load({ sessionThrows: true });
  h.fn.openEditor({ test: '5', suiteId: 's1', suiteTitle: 'Checkout' });
  assert.deepEqual(h.session.writes, []);
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&test=5');
  // The identical call in a window that allows it does leave the breadcrumb.
  const ok = load();
  ok.fn.openEditor({ test: '5', suiteId: 's1', suiteTitle: 'Checkout' });
  assert.equal(ok.session.writes.length, 1);
});

test('67: an id with a space or an ampersand in it survives the address bar', () => {
  const h = load();
  h.fn.openEditor({ test: 'a b&c' });
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&test=a+b%26c');
  assert.deepEqual(h.session.writes, [['tcReturn', '{}']]);
});

test('67b: with neither a test nor a suite the page opens on the panel context alone', () => {
  const h = load();
  h.fn.openEditor({ suiteId: 's1', suiteTitle: 'Checkout' });
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel');
});

test('67c: New test on a tree row opens the editor bound to that suite, and does not open its list too', () => {
  const h = load({ suites: [file('s1', 'Checkout')] });
  h.fn.renderSuiteTree(h.state.tcSuites);
  const row = h.rowFor('s1');
  const pill = row.querySelector('.tc-new');

  fire(pill, 'click');
  assert.equal(h.win.location.href, '../editor/editor.html?ctx=panel&suite=s1');
  assert.deepEqual(h.session.writes, [['tcReturn', '{"suiteId":"s1","suiteTitle":"Checkout"}']]);

  // The row hears that same click; it is the pill under the pointer that stops it opening the list.
  fire(row, 'click', { target: pill });
  assert.deepEqual(h.calls.shows, []);
  // A click anywhere else on the row does open it.
  fire(row, 'click', { target: row.querySelector('.title') });
  assert.deepEqual(h.calls.shows, ['tclist']);
  assert.equal(h.state.tcSuiteId, 's1');
  assert.equal(h.state.tcSuiteTitle, 'Checkout');
});
