// TC Studio screen: the suite tree, the per-suite TC list, and the test-page
// hand-off (read-only view for an existing test, editor for a new one).

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, PriorityIcons, TestType, Roving,
   StatusIcons, SuiteTree, TcQuickBar, TcSuiteCreate */

// ---------- TC Studio: suite tree + TC list ----------
// The tree is built SERVER-side and read whole from GET /suites/tree (#114), then
// re-sorted by `position` — the web's order — here and in the "New test" picker (#26).

const tcExpanded = (id) => !!state.tcExpanded[String(id)];

// The shared `.row-count` (ROW TAIL, shared/components.css). Folders show the
// subtree total, files their own — 0 included: an omitted badge reads "not loaded".
function tcCounter(n) {
  if (!n || n.test_count == null) return null;
  const b = document.createElement('span');
  b.className = 'row-count';
  b.textContent = String(n.test_count);
  return b;
}

// Shared `.row-actions.on-hover` — it draws over the count at the row's trailing
// edge and hides it while up, so the two never compete for the slot.
function rowActions(...kids) {
  const cell = document.createElement('div');
  cell.className = 'row-actions on-hover';
  cell.append(...kids);
  return cell;
}

// What the arrows walk in either tree. `[data-id]` is what leaves out the inline create row,
// which is a `.tc-row` too but belongs to the field inside it, not to the keyboard.
const TC_TREE_ROW_SELECTOR = '.tc-row[data-id]';

// The TC list's own rows; its two empty states are <li>s without one.
const TC_LIST_ROW_SELECTOR = 'li[data-id]';

// `ctx.pick` switches the file row: studio opens its TC list, pick mode selects it
// and calls ctx.onPick. Children are built once, shown/hidden by the expand set.
function tcNode(node, ctx) {
  const li = document.createElement('li');
  li.className = 'tc-item tree-node';
  const row = document.createElement('div');
  // `tree-row` puts the row's rule under its TYPE glyph, not out at the chevron
  // column the open guide comes down (shared/components.css).
  row.className = 'list-row tc-row list-head tree-row';
  row.dataset.id = node.id;
  // Both branches below end in a click listener, and Enter/Space run whichever it is.
  Roving.item(row);

  if (node.file_type === 'folder') {
    row.classList.add('tc-folder', 'has-chevron');
    row.append(StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron'));
    // `node.emoji` (api.js normSuiteNode) is the project's own mark for the
    // folder; the folder glyph is the fallback for a node without one.
    row.append(StatusIcons.treeIcon(StatusIcons.FOLDER, 'folder-icon', node.emoji));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = node.title || '(untitled)';
    row.append(title);
    const badge = tcCounter(node);
    if (badge) row.append(badge);
    li.append(row);

    // `ctx.expandAll` opens every folder a search left standing, WITHOUT writing
    // to the expand set — clearing the query must give back the tester's folding.
    let open = ctx.expandAll || tcExpanded(node.id);
    const kids = document.createElement('ul');
    kids.className = 'tc-children tree-children';
    kids.hidden = !open;
    // Only a FOLDER folds, so only a folder says so; on a file row the attribute would claim a
    // fold that is not there.
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
    // Studio mode: folders can spawn child suites/folders (not in the pick tree).
    if (!ctx.pick) {
      row.append(rowActions(TcSuiteCreate.addButtons((fileType) => {
        state.tcExpanded[String(node.id)] = true; // reveal the input inside kids
        kids.hidden = false;
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        TcSuiteCreate.open({
          parentId: node.id,
          fileType,
          // First child of its folder, scrolled to — a folder opening low in the
          // panel can push its own first row off the bottom.
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

// In studio mode (`canCreate`) the Suite/Folder pair are its actions; the picker
// gets only the web-app link — nothing can be created from there.
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

// ---------- tree search (Tests screen) ----------
// Local (the tree is already in state.tcSuites) and over suite/folder TITLES only
// — the tests themselves are searched by the TC list's own field.

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

// Drops the query WITHOUT redrawing — for callers about to redraw anyway.
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

// The picker's #promote-tree is built by the same tcNode, so it is wired here too — one call
// covers both trees rather than the Tests tab getting a keyboard the picker does not have.
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
  // The empty state carries its own create buttons, so the root toolbar hides
  // there — but a query keeps it up: the search field lives in that same row.
  const bar = $('tc-tree-bar');
  if (bar) bar.hidden = !roots.length && !q;
  // Hoist AFTER the filter — it returns copies, so reordering has to come last.
  renderSuiteTreeInto($('tc-tree'), SuiteTree.hoist(SuiteTree.filter(roots, q), TcSuiteCreate.justCreated), {
    pick: false,
    expandAll: !!q,               // show the branch that leads to every match
    searching: !!q && !!roots.length, // "no match" only when there WAS something to match
  });
  // The tab chip counts the PROJECT, never the filter.
  setTabCount('tests', SuiteTree.testCount(roots));
}

// The Tests count WITHOUT the tree (prefetchTabCounts, core/views.js). Leaves
// state.tcSuites untouched — a tree cached here would be drawn before its refetch.
async function loadTestsCount(epoch) {
  try {
    const roots = await TestomatAPI.getSuiteTree();
    if (staleProject(epoch)) return;
    setTabCount('tests', SuiteTree.testCount(roots));
    // The tree is dropped, but its marks are the project's — a run opened next
    // wants them (rememberSuiteEmoji, screens/run-view.js).
    rememberSuiteEmoji(roots);
  } catch { /* best effort — the chip stays absent */ }
}

async function openTcStudioView() {
  // A tree already read for this project is painted AT ONCE and re-read behind it:
  // the nodes never left memory, and clearing them to fetch the same ones back is
  // what made a return to the Tests tab blank the screen first (the piecemeal paint).
  if (state.tcSuites?.length) {
    show('tcstudio');
    syncTcTreeSearchInput(); // read FROM state, as on the fresh path below
    // Before the paint, not after: the re-read below returns the project's own order,
    // and a hoist dropped afterwards would reshuffle the tree under the tester.
    TcSuiteCreate.justCreated.length = 0;
    renderSuiteTree(state.tcSuites);
    // #155: still gated — a locked project replaces the tree with the blocking panel.
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
  // #155: settle the read-only probe before the tree fetch, so a locked project
  // shows the blocking panel and nothing else.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  setStatusLine('tcstudio-status', 'Loading suites…');
  // The query outlives leaving the screen but not a project switch (which clears
  // it in state), so the field is read FROM state on every open.
  syncTcTreeSearchInput();
  // A fresh open is the project's own order again.
  TcSuiteCreate.justCreated.length = 0;
  $('tc-tree').replaceChildren();
  const epoch = state.projectEpoch; // a project switch mid-fetch discards this tree
  try {
    const suites = await TestomatAPI.getSuiteTreeOrdered();
    if (staleProject(epoch)) return;
    state.tcSuites = suites;
    // One index: a run's suite sections wear these marks without a fetch of
    // their own (screens/run-view.js).
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

// Two different nothings: an empty suite is a place to write one, a search that
// matched nothing just needs clearing.
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
    // priority → type → title, the web app's own row order. Both marks come off
    // the v2 record already held; an absent priority draws the `normal` ring.
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
  // The caption counts what is ON SCREEN, not what the suite holds — a search
  // narrows it, and an empty suite is a real 0.
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

// Drops the query WITHOUT redrawing and WITHOUT taking focus — for callers about to redraw
// anyway, and whose own field holds the caret (the quick bar's create).
function resetTcSearch() {
  state.tcSearch = '';
  if ($('tc-search')) $('tc-search').value = '';
  if ($('tc-search-clear')) $('tc-search-clear').hidden = true;
}

// Two reads of the SAME suite can be in flight — a refresh clicked while the quick bar's
// create is re-reading, or the other way round — and they may answer out of order (#27).
let tcListReadSeq = 0;

// The suite's rows, read and drawn. Shared by the suite open and by every create in the
// quick bar, so a new test is read back exactly the way the list was first filled.
// `quiet` re-reads behind the rows already up — no skeleton over a list that is still there.
async function loadTcList(suiteId, { quiet = false } = {}) {
  const seq = ++tcListReadSeq;
  const sk = quiet ? null : Skeleton.show('tclist');
  if (!quiet) setStatusLine('tclist-status', 'Loading tests…');
  try {
    // v2 answers newest-first; the web orders a suite's tests by `position` ascending (#4).
    const tests = await TestomatAPI.getTestsBySuite(suiteId);
    // A suite opened while this was on the wire owns the list now — these rows are the last one's.
    // Same for a later read of THIS suite: only the newest one may paint.
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
  if (capabilities.readonly) { show('tclist'); return; } // #155 — locked project
  const sameSuite = String(state.tcSuiteId) === String(suiteId);
  // A DIFFERENT suite starts the bar clean; a refresh or a return to this one keeps what is half-typed.
  if (!sameSuite) TcQuickBar.reset();
  state.tcSuiteId = suiteId;
  state.tcSuiteTitle = title || 'Suite';
  // Read off the tree already in memory — the callers have an id and a title,
  // never the node. null (no tree, e.g. a restored session) draws the glyph.
  state.tcSuiteEmoji = SuiteTree.emojiOf(state.tcSuites, suiteId);
  // Search resets on every suite open (in-memory only).
  resetTcSearch();
  // Coming back to the suite already open — its rows are in memory, so they stay up
  // and the re-read lands under them, the way a create in the quick bar re-reads.
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

// The panel-wide refresh's leg for the suite list (#27) — a re-read in place, not a re-open:
// the rows stay up until it lands, and the search query and whatever is half-typed in the
// Add-new-test bar are kept, because a refresh is not a suite change. Errors go to
// `tclist-status` the way every other read of this list reports them (loadTcList).
async function refreshTcList() {
  if (!state.tcSuiteId) return;
  await loadTcList(state.tcSuiteId, { quiet: true });
}

// Reuses the TC tree in pick mode, then opens the editor in create mode bound to
// the chosen suite. Cancel is the Back arrow (goBack → tcstudio).
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

// Navigates the panel document to the test page. Hand-off is by id only, never
// serialized content; the sessionStorage breadcrumb is consumed once in init.
function openEditor({ test, suite, suiteId, suiteTitle }) {
  try {
    sessionStorage.setItem('tcReturn', JSON.stringify({ suiteId, suiteTitle }));
  } catch { /* sessionStorage unavailable — Back falls through to runs */ }
  const params = new URLSearchParams({ ctx: 'panel' });
  if (test) params.set('test', test);
  if (suite) params.set('suite', suite);
  window.location.href = `../editor/editor.html?${params.toString()}`;
}
