// TC Studio screen: the suite tree, the per-suite TC list, and the hand-off to the test page.

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, PriorityIcons, TestType, Roving,
   StatusIcons, SuiteTree, TcQuickBar, TcSuiteCreate */

// The tree is read whole from GET /suites/tree, then re-sorted by `position`, the web's order.

const tcExpanded = (id) => !!state.tcExpanded[String(id)];

// Folders show the subtree total, files their own, 0 included: an omitted badge reads "not loaded".
function tcCounter(n) {
  if (!n || n.test_count == null) return null;
  const b = document.createElement('span');
  b.className = 'row-count';
  b.textContent = String(n.test_count);
  return b;
}

// It draws over the count at the row's trailing edge and hides it, so the two never compete.
function rowActions(...kids) {
  const cell = document.createElement('div');
  cell.className = 'row-actions on-hover';
  cell.append(...kids);
  return cell;
}

// `[data-id]` leaves out the inline create row, a `.tc-row` whose keyboard belongs to its field.
const TC_TREE_ROW_SELECTOR = '.tc-row[data-id]';

// The TC list's own rows; its two empty states are <li>s without one.
const TC_LIST_ROW_SELECTOR = 'li[data-id]';

// `ctx.pick` switches the file row: studio opens its TC list, pick mode calls ctx.onPick.
function tcNode(node, ctx) {
  const li = document.createElement('li');
  li.className = 'tc-item tree-node';
  const row = document.createElement('div');
  // `tree-row` puts the row's rule under its type glyph, not out at the chevron column.
  row.className = 'list-row tc-row list-head tree-row';
  row.dataset.id = node.id;
  // Both branches below end in a click listener, and Enter/Space run whichever it is.
  Roving.item(row);

  if (node.file_type === 'folder') {
    row.classList.add('tc-folder', 'has-chevron');
    row.append(StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron'));
    // `node.emoji` is the project's own folder mark; the folder glyph is the fallback.
    row.append(StatusIcons.treeIcon(StatusIcons.FOLDER, 'folder-icon', node.emoji));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = node.title || '(untitled)';
    row.append(title);
    const badge = tcCounter(node);
    if (badge) row.append(badge);
    li.append(row);

    // `ctx.expandAll` opens search hits without writing the expand set, so clearing restores folding.
    let open = ctx.expandAll || tcExpanded(node.id);
    const kids = document.createElement('ul');
    kids.className = 'tc-children tree-children';
    kids.hidden = !open;
    // Only a folder folds, so only a folder carries aria-expanded.
    row.setAttribute('aria-expanded', String(open));
    // The picker draws the project's own order — picking is reading the tree.
    const children = ctx.pick ? (node.children || []) : SuiteTree.hoist(node.children, TcSuiteCreate.justCreated);
    for (const c of children) kids.append(tcNode(c, ctx));
    li.append(kids);
    if (open) row.classList.add('expanded');
    row.addEventListener('click', () => {
      open = !open;
      state.tcExpanded[String(node.id)] = open;
      kids.hidden = !open;
      row.classList.toggle('expanded', open);
      row.setAttribute('aria-expanded', String(open));
    });
    if (!ctx.pick) {
      row.append(rowActions(TcSuiteCreate.addButtons((fileType) => {
        state.tcExpanded[String(node.id)] = true; // reveal the input inside kids
        kids.hidden = false;
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        TcSuiteCreate.open({
          parentId: node.id,
          fileType,
          // Scrolled to: a folder opening low in the panel can push its own first row off the bottom.
          mount: (r) => { kids.prepend(r); r.scrollIntoView({ block: 'nearest' }); },
        });
      })));
    }
  } else {
    row.classList.add('tc-file', 'has-chevron');
    row.append(StatusIcons.treeSlot(), StatusIcons.treeIcon(StatusIcons.FILE, 'file-icon', node.emoji));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = node.title || '(untitled)';
    row.append(title);
    const badge = tcCounter(node);
    if (badge) row.append(badge);

    if (ctx.pick) {
      row.classList.add('tc-pick');
      li.append(row);
      row.addEventListener('click', () => ctx.onPick(node));
    } else {
      const add = document.createElement('button');
      add.className = 'btn size-xs tc-new';
      add.append(StatusIcons.svgIcon('add', 16), document.createTextNode('New test'));
      Tooltip.set(add, 'New test in this suite');
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor({ suite: node.id, suiteId: node.id, suiteTitle: node.title });
      });
      row.append(rowActions(add));
      li.append(row);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tc-new')) return;
        openTcListView(node.id, node.title);
      });
    }
  }
  return li;
}

// The picker gets only the web-app link: nothing can be created from there.
function renderSuiteEmpty(ul, tail, canCreate) {
  const s = state.settings;
  const hasLink = !!(s?.baseUrl && s?.projectId);
  const webAppLink = () => {
    const a = document.createElement('a');
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'the web app';
    return a;
  };

  const text = [];
  const actions = [];
  if (canCreate) {
    text.push('Group your test cases into suites and folders — start with one here');
    if (hasLink) text.push(', or in ', webAppLink());
    text.push('.');
    actions.push(TcSuiteCreate.addButtons(TcSuiteCreate.openRoot, 'btn size-sm tc-add')); // a fragment of two
  } else {
    text.push('Create one in ', hasLink ? webAppLink() : 'the web app', tail);
  }

  ul.append(EmptyState.build({
    tag: 'li',
    icon: 'create_new_folder',
    title: 'No suites yet',
    text,
    actions,
  }));
}

// Tree search is local and over suite/folder titles only; tests have the TC list's own field.

// A query that matched nothing is not an empty project — the way out is the query.
function tcTreeEmptySearch() {
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn size-sm';
  clear.textContent = 'Clear search';
  clear.addEventListener('click', clearTcTreeSearch);
  return EmptyState.build({
    tag: 'li',
    live: true,
    icon: 'manage_search',
    title: 'No suites match',
    text: 'No suite or folder has that in its title.',
    actions: [clear],
  });
}

function onTcTreeSearch() {
  state.tcTreeSearch = $('tc-tree-search').value;
  syncTcTreeSearchInput();
  renderSuiteTree(state.tcSuites || []);
}

function clearTcTreeSearch() {
  state.tcTreeSearch = '';
  syncTcTreeSearchInput();
  renderSuiteTree(state.tcSuites || []);
  $('tc-tree-search').focus();
}

// Drops the query without redrawing, for callers about to redraw anyway.
function resetTcTreeSearch() {
  state.tcTreeSearch = '';
  syncTcTreeSearchInput();
}

// A project switch and a create both reset the query behind the input's back.
function syncTcTreeSearchInput() {
  const input = $('tc-tree-search');
  if (!input) return;
  if (input.value !== state.tcTreeSearch) input.value = state.tcTreeSearch;
  $('tc-tree-search-clear').hidden = state.tcTreeSearch.trim() === '';
}

// Wired here so the picker's tree gets the same keyboard as the Tests tab.
function renderSuiteTreeInto(ul, roots, ctx) {
  Roving.attach(ul, { selector: TC_TREE_ROW_SELECTOR });
  ul.replaceChildren();
  if (!roots.length) {
    if (ctx.searching) ul.append(tcTreeEmptySearch());
    else renderSuiteEmpty(ul, ctx.pick ? ' first.' : ' to start authoring.', !ctx.pick);
    return;
  }
  for (const n of roots) ul.append(tcNode(n, ctx));
}

function renderSuiteTree(roots) {
  const q = state.tcTreeSearch.trim();
  // The empty state brings its own create buttons; a query keeps the bar for its search field.
  const bar = $('tc-tree-bar');
  if (bar) bar.hidden = !roots.length && !q;
  // Hoist after the filter: it returns copies, so reordering has to come last.
  renderSuiteTreeInto($('tc-tree'), SuiteTree.hoist(SuiteTree.filter(roots, q), TcSuiteCreate.justCreated), {
    pick: false,
    expandAll: !!q,               // show the branch that leads to every match
    searching: !!q && !!roots.length, // "no match" only when there was something to match
  });
  // The tab chip counts the project, never the filter.
  setTabCount('tests', SuiteTree.testCount(roots));
}

// Leaves state.tcSuites untouched: a tree cached here would be drawn before its refetch.
async function loadTestsCount(epoch) {
  try {
    const roots = await TestomatAPI.getSuiteTree();
    if (staleProject(epoch)) return;
    setTabCount('tests', SuiteTree.testCount(roots));
    // The tree is dropped, but a run opened next wants its marks.
    rememberSuiteEmoji(roots);
  } catch { /* best effort — the chip stays absent */ }
}

async function openTcStudioView() {
  // A tree already read for the project paints at once and is re-read behind it.
  if (state.tcSuites?.length) {
    show('tcstudio');
    syncTcTreeSearchInput(); // read from state, as on the fresh path below
    // Before the paint: the re-read returns the project's order, and a late hoist drop would reshuffle.
    TcSuiteCreate.justCreated.length = 0;
    renderSuiteTree(state.tcSuites);
    // A locked project replaces the tree with the blocking panel.
    if (await readonlyGate()) { applyReadonlyBlock(); return; }
    const epoch = state.projectEpoch; // a project switch mid-fetch discards this tree
    try {
      const suites = await TestomatAPI.getSuiteTreeOrdered();
      if (staleProject(epoch)) return;
      state.tcSuites = suites;
      rememberSuiteEmoji(state.tcSuites);
      renderSuiteTree(state.tcSuites);
      setStatusLine('tcstudio-status', ''); // a read that landed clears the last one's error
    } catch (e) {
      handleApiError(e, 'tcstudio-status');
    }
    return;
  }
  show('tcstudio');
  const sk = Skeleton.show('tcstudio'); // drawn at once, and before the read-only probe — a round trip too
  // Read-only probe before the fetch, so a locked project shows the blocking panel and nothing else.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  setStatusLine('tcstudio-status', 'Loading suites…');
  // The query outlives leaving the screen but not a project switch, so it is read from state.
  syncTcTreeSearchInput();
  // A fresh open is the project's own order again.
  TcSuiteCreate.justCreated.length = 0;
  $('tc-tree').replaceChildren();
  const epoch = state.projectEpoch; // a project switch mid-fetch discards this tree
  try {
    const suites = await TestomatAPI.getSuiteTreeOrdered();
    if (staleProject(epoch)) return;
    state.tcSuites = suites;
    // One index: a run's suite sections wear these marks without a fetch of their own.
    rememberSuiteEmoji(state.tcSuites);
    renderSuiteTree(state.tcSuites);
    setStatusLine('tcstudio-status', '');
  } catch (e) {
    handleApiError(e, 'tcstudio-status');
  } finally {
    Skeleton.hide(sk);
  }
}

function tcRowMatches(t) {
  const q = state.tcSearch.trim().toLowerCase();
  if (!q) return true;
  return (t.title || t.clean_title || '').toLowerCase().includes(q);
}

// Two nothings: an empty suite is a place to write one, a search that matched nothing needs clearing.
function tcListEmpty(searching) {
  if (searching) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn size-sm';
    clear.textContent = 'Clear search';
    clear.addEventListener('click', clearTcSearch);
    return EmptyState.build({
      tag: 'li',
      live: true,
      icon: 'manage_search',
      title: 'No tests match',
      text: 'No test in this suite has that in its title.',
      actions: [clear],
    });
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn primary size-sm';
  add.append(StatusIcons.svgIcon('add', 16), document.createTextNode('New test'));
  add.addEventListener('click', () => $('tc-list-new')?.click());
  return EmptyState.build({
    tag: 'li',
    icon: 'note_add',
    title: 'No test cases yet',
    text: 'This suite is empty. Write the first case for it here.',
    actions: [add],
  });
}

function renderTcList() {
  const ul = $('tc-list');
  Roving.attach(ul, { selector: TC_LIST_ROW_SELECTOR });
  ul.replaceChildren();
  const all = state.tcTests || [];
  const rows = all.filter(tcRowMatches);
  for (const t of rows) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    const head = document.createElement('div');
    head.className = 'list-head';
    // priority → type → title, the web's own row order; an absent priority draws the `normal` ring.
    const prio = typeof PriorityIcons !== 'undefined' ? PriorityIcons.mark(t.priority) : null;
    // A custom Testomat emoji stands in the type mark's own square.
    const type = Icons.emoji(t.emoji, 'type-mark')
      || (typeof TestType !== 'undefined' ? TestType.forRecord(t) : null);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title || t.clean_title || '(untitled)';
    head.append(...[prio, type, title].filter(Boolean));
    li.append(head);
    li.addEventListener('click', () =>
      openEditor({ test: t.id, suiteId: state.tcSuiteId, suiteTitle: state.tcSuiteTitle }));
    ul.append(Roving.item(li));
  }
  if (!rows.length) ul.append(tcListEmpty(all.length > 0));
  // The caption counts what is on screen, not what the suite holds; an empty suite is a real 0.
  const count = $('tc-list-count');
  if (count) { paintCounter(count, rows.length); count.hidden = false; }
  setStatusLine('tclist-status', '');
}

function onTcSearch() {
  state.tcSearch = $('tc-search').value;
  $('tc-search-clear').hidden = state.tcSearch.trim() === '';
  renderTcList();
}

function clearTcSearch() {
  resetTcSearch();
  renderTcList();
  $('tc-search').focus();
}

// Drops the query without redrawing or taking focus: the quick bar's field keeps the caret.
function resetTcSearch() {
  state.tcSearch = '';
  if ($('tc-search')) $('tc-search').value = '';
  if ($('tc-search-clear')) $('tc-search-clear').hidden = true;
}

// Two reads of one suite can be in flight (refresh, a create's re-read) and answer out of order.
let tcListReadSeq = 0;

// `quiet` re-reads behind the rows already up: no skeleton over a list that is still there.
async function loadTcList(suiteId, { quiet = false } = {}) {
  const seq = ++tcListReadSeq;
  const sk = quiet ? null : Skeleton.show('tclist');
  if (!quiet) setStatusLine('tclist-status', 'Loading tests…');
  try {
    // v2 answers newest-first; the web orders a suite's tests by `position` ascending.
    const tests = await TestomatAPI.getTestsBySuite(suiteId);
    // A suite opened meanwhile, or a newer read of the same suite, owns the list now.
    if (state.tcSuiteId !== suiteId || seq !== tcListReadSeq) return;
    state.tcTests = tests.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    renderTcList();
  } catch (e) {
    handleApiError(e, 'tclist-status');
  } finally {
    if (sk) Skeleton.hide(sk);
  }
}

async function openTcListView(suiteId, title) {
  if (capabilities.readonly) { show('tclist'); return; } // locked project
  const sameSuite = String(state.tcSuiteId) === String(suiteId);
  // A different suite starts the bar clean; a refresh or a return keeps what is half-typed.
  if (!sameSuite) TcQuickBar.reset();
  state.tcSuiteId = suiteId;
  state.tcSuiteTitle = title || 'Suite';
  // Read off the tree in memory: callers have an id, never the node. null draws the glyph.
  state.tcSuiteEmoji = SuiteTree.emojiOf(state.tcSuites, suiteId);
  resetTcSearch();
  // Back to the open suite: its rows stay up and the re-read lands under them.
  if (sameSuite && state.tcTests?.length) {
    show('tclist');
    renderTcList();
    await loadTcList(suiteId, { quiet: true });
    return;
  }
  show('tclist');
  $('tc-list').replaceChildren();
  // The previous suite's number is not this one's — the chip goes for the fetch.
  if ($('tc-list-count')) $('tc-list-count').hidden = true;
  await loadTcList(suiteId);
}

// A re-read in place, not a re-open: the rows, the query and half-typed titles all survive a refresh.
async function refreshTcList() {
  if (!state.tcSuiteId) return;
  await loadTcList(state.tcSuiteId, { quiet: true });
}

// Reuses the TC tree in pick mode; Cancel is the Back arrow (goBack → tcstudio).
async function openTestSuitePicker() {
  show('promote');
  const sk = Skeleton.show('promote');
  $('promote-hint').textContent = 'Choose a suite for the new test:';
  setStatusLine('promote-status', 'Loading suites…');
  $('promote-tree').replaceChildren();
  try {
    const roots = await TestomatAPI.getSuiteTreeOrdered(); // same ordered tree as the Tests tab
    if (state.view !== 'promote') return;
    renderSuiteTreeInto($('promote-tree'), roots, {
      pick: true,
      onPick: (node) => openEditor({ suite: node.id, suiteId: node.id, suiteTitle: node.title }),
    });
    setStatusLine('promote-status', '');
  } catch (e) {
    handleApiError(e, 'promote-status');
  } finally {
    Skeleton.hide(sk);
  }
}

// Hand-off by id only, never serialized content; the sessionStorage breadcrumb is read once in init.
function openEditor({ test, suite, suiteId, suiteTitle }) {
  try {
    sessionStorage.setItem('tcReturn', JSON.stringify({ suiteId, suiteTitle }));
  } catch { /* sessionStorage unavailable — Back falls through to runs */ }
  const params = new URLSearchParams({ ctx: 'panel' });
  if (test) params.set('test', test);
  if (suite) params.set('suite', suite);
  window.location.href = `../editor/editor.html?${params.toString()}`;
}
