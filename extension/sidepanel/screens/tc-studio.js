// TC Studio screen: the suite tree, the per-suite TC list, and the test-page
// hand-off (read-only view for an existing test, editor for a new one).

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, PriorityIcons, TestType, Roving,
   StatusIcons */

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

// ---------- inline suite/folder creation (cycle 011) ----------

// Suites created in THIS visit, newest first: the API appends a new suite to the
// END of its parent's children, so server order would move it off-screen.
const tcJustCreated = [];

// Non-mutating — state.tcSuites keeps the server's order; only the drawing moves.
function hoistJustCreated(list) {
  const nodes = list || [];
  if (!tcJustCreated.length || !nodes.length) return nodes;
  const rank = (n) => tcJustCreated.indexOf(String(n.id));
  const fresh = nodes.filter((n) => rank(n) >= 0).sort((a, b) => rank(a) - rank(b));
  return fresh.length ? [...fresh, ...nodes.filter((n) => rank(n) < 0)] : nodes;
}

// Remove any open inline create row — only one may be active at a time.
function closeSuiteInput() {
  for (const el of document.querySelectorAll('.tc-new-suite')) el.remove();
}

// `mount(li)` places the row at the TOP of its list, one row under the button that
// opened it. Enter or the tick create; Esc, the cross or losing focus dismiss.
function openSuiteInput({ parentId, fileType, mount }) {
  closeSuiteInput();
  const folder = fileType === 'folder';
  const li = document.createElement('li');
  li.className = 'tc-item tree-node tc-new-suite';
  const row = document.createElement('div');
  row.className = 'list-row tc-row list-head tree-row tree-input-row';
  row.classList.add('has-chevron');
  row.append(folder ? StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron') : StatusIcons.treeSlot());
  const mark = folder ? StatusIcons.FOLDER : StatusIcons.FILE;
  row.append(StatusIcons.treeIcon(mark, folder ? 'folder-icon' : 'file-icon'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-input';
  input.autocomplete = 'off';
  input.placeholder = folder ? 'Enter folder name' : 'Enter suite name';
  input.setAttribute('aria-label', folder ? 'New folder name' : 'New suite name');

  // Both hold the field's focus on mousedown: the row cancels on focusout, so a
  // control that dismissed the row before its own click landed would never fire.
  const iconBtn = (icon, cls, tip) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn size-xs ${cls}`;
    b.append(StatusIcons.svgIcon(icon, 16));
    b.setAttribute('aria-label', tip);
    Tooltip.set(b, tip);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    return b;
  };
  const ok = iconBtn('check', 'tc-new-suite-ok', folder ? 'Create folder' : 'Create suite');
  const cancel = iconBtn('close', 'tc-new-suite-cancel', 'Cancel');
  row.append(input, ok, cancel);
  li.append(row);
  mount(li);
  input.focus();

  let busy = false;
  const submit = async () => {
    const title = input.value.trim();
    if (!title || busy) return;
    busy = true;
    ok.disabled = true; cancel.disabled = true;
    try {
      const made = await TestomatAPI.createSuite({ title, parentId, fileType });
      if (made?.id) tcJustCreated.unshift(String(made.id)); // keeps it in the row it was named in
      if (parentId) state.tcExpanded[String(parentId)] = true; // keep parent open
      resetTcTreeSearch(); // a live filter would hide a node whose title misses it
      state.tcSuites = await TestomatAPI.getSuiteTreeOrdered(); // the ordered tree, incl. the new node
      rememberSuiteEmoji(state.tcSuites); // the run view's suite marks read the same tree
      renderSuiteTree(state.tcSuites); // re-render replaces the input row
    } catch (e) {
      busy = false;
      ok.disabled = false; cancel.disabled = false;
      toast(e.message || String(e)); // keep the row + typed title
    }
  };
  ok.addEventListener('click', submit);
  cancel.addEventListener('click', closeSuiteInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSuiteInput(); }
  });
  // Focus leaving the ROW cancels — Tab onto the tick or the cross is still
  // inside it, and a create in flight owns the row until it answers.
  row.addEventListener('focusout', (e) => {
    if (busy || (e.relatedTarget && row.contains(e.relatedTarget))) return;
    closeSuiteInput();
  });
}

// Two skins: `.tc-new` is the pill revealed on hovering a tree row (style.css),
// while the empty state passes the always-visible shared button class.
function suiteAddButtons(openFor, cls = 'btn size-xs tc-new') {
  const frag = document.createDocumentFragment();
  const mk = (label, fileType, tip) => {
    const b = document.createElement('button');
    b.className = cls;
    b.append(StatusIcons.svgIcon('add', 16), document.createTextNode(label));
    Tooltip.set(b, tip);
    b.addEventListener('click', (e) => { e.stopPropagation(); openFor(fileType); });
    return b;
  };
  frag.append(mk('Suite', 'file', 'New test suite here'), mk('Folder', 'folder', 'New folder here'));
  return frag;
}

// Mounts at the tree top and scrolls itself in, for a tree already scrolled down.
function openRootSuiteInput(fileType) {
  openSuiteInput({
    parentId: null,
    fileType,
    mount: (row) => { $('tc-tree').prepend(row); row.scrollIntoView({ block: 'nearest' }); },
  });
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
    const children = ctx.pick ? (node.children || []) : hoistJustCreated(node.children);
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
      row.append(rowActions(suiteAddButtons((fileType) => {
        state.tcExpanded[String(node.id)] = true; // reveal the input inside kids
        kids.hidden = false;
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        openSuiteInput({
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
    actions.push(suiteAddButtons(openRootSuiteInput, 'btn size-sm tc-add')); // a fragment of two
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

// A matching folder keeps its WHOLE subtree; one kept only for a descendant shows
// just the branch leading there. Returns copies — a cleared query restores tcSuites.
function filterSuiteTree(roots, query) {
  const q = query.trim().toLowerCase();
  if (!q) return roots;
  const keep = (n) => {
    const self = (n.title || '').toLowerCase().includes(q);
    const kids = (n.children || []).map(keep).filter(Boolean);
    if (!self && !kids.length) return null;
    return { ...n, children: self ? (n.children || []) : kids };
  };
  return (roots || []).map(keep).filter(Boolean);
}

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
  renderSuiteTreeInto($('tc-tree'), hoistJustCreated(filterSuiteTree(roots, q)), {
    pick: false,
    expandAll: !!q,               // show the branch that leads to every match
    searching: !!q && !!roots.length, // "no match" only when there WAS something to match
  });
  // The tab chip counts the PROJECT, never the filter.
  setTabCount('tests', treeTestCount(roots));
}

// Every test case in the project (#127). Summed over the ROOTS only — a folder's
// `test_count` is already its subtree total, so descending would double-count.
const treeTestCount = (roots) =>
  (roots || []).reduce((n, s) => n + (Number(s.test_count) || 0), 0);

// The Tests count WITHOUT the tree (prefetchTabCounts, core/views.js). Leaves
// state.tcSuites untouched — a tree cached here would be drawn before its refetch.
async function loadTestsCount(epoch) {
  try {
    const roots = await TestomatAPI.getSuiteTree();
    if (staleProject(epoch)) return;
    setTabCount('tests', treeTestCount(roots));
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
    tcJustCreated.length = 0;
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
  tcJustCreated.length = 0;
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

// null when the tree is empty or the node is absent — both mean "draw the glyph".
function suiteNodeEmoji(nodes, id) {
  for (const n of nodes || []) {
    if (String(n.id) === String(id)) return n.emoji || null;
    const found = suiteNodeEmoji(n.children, id);
    if (found) return found;
  }
  return null;
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
  if (!sameSuite) resetTcQuickBar();
  state.tcSuiteId = suiteId;
  state.tcSuiteTitle = title || 'Suite';
  // Read off the tree already in memory — the callers have an id and a title,
  // never the node. null (no tree, e.g. a restored session) draws the glyph.
  state.tcSuiteEmoji = suiteNodeEmoji(state.tcSuites, suiteId);
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

// ---------- Add new test: the quick/bulk bar (#3) ----------
// Quick mode creates ONE test from a title, bulk mode a whole list in a single request.
// Both append at the end of the suite, which is where the re-read finds them.

// Lines parked while quick mode shows only the first of them — Bulk gets them back.
let tcQuickParked = [];
let tcQuickBusy = false;

const tcQuickBulkOn = () => !!$('tc-quick-bulk')?.checked;

// One space between words and none at the ends, the way the web trims a title.
const tcQuickTitle = () => String($('tc-quick-title').value).replace(/\s+/g, ' ').trim();

// Order kept and duplicates left alone: the tester typed the list they meant.
const tcQuickLines = () =>
  String($('tc-quick-titles').value).split('\n').map((s) => s.trim()).filter(Boolean);

// What the button would send, in either mode.
const tcQuickTitles = () => (tcQuickBulkOn() ? tcQuickLines() : [tcQuickTitle()].filter(Boolean));

// '' = the whole list can go out, else why not. Bulk rides the WEB session (jwtRequest) while a
// single title does not, so a token-only panel must not be offered a switch its request would refuse.
function tcBulkLock() {
  // 'unknown' is still probing and must never gate — only an explicit refusal does.
  return TestomatAPI.jwtAvailable() === false
    ? `Bulk needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
    : '';
}

// Nothing to send, or a send already out — either way there is nothing to press.
function syncTcQuickCreate() {
  const btn = $('tc-quick-create');
  if (btn) btn.disabled = tcQuickBusy || !tcQuickTitles().length;
}

// The fields stay READ-ONLY rather than disabled: a title in flight is still the tester's to read.
function setTcQuickBusy(busy) {
  tcQuickBusy = busy;
  $('tc-quick-title').readOnly = busy;
  $('tc-quick-titles').readOnly = busy;
  const lock = tcBulkLock();
  $('tc-quick-bulk').disabled = busy || !!lock;
  // The tip sits on the LABEL: a disabled input answers no pointer, so its own tip would never show.
  Tooltip.set($('tc-quick-bulk').parentElement, lock || 'Add more');
  $('tc-quick-create').textContent = busy ? 'Creating…' : 'Create';
  syncTcQuickCreate();
}

// Every suite open starts the bar clean — quick mode, both fields empty, nothing parked.
function resetTcQuickBar() {
  const input = $('tc-quick-title');
  const area = $('tc-quick-titles');
  if (!input || !area) return;
  tcQuickParked = [];
  input.value = '';
  area.value = '';
  $('tc-quick-bulk').checked = false;
  input.hidden = false;
  area.hidden = true;
  setTcQuickBusy(false);
}

// The text follows the switch, as it does in the web widget: the quick field is the FIRST line
// of the list, and the lines under it wait in memory for Bulk to come back.
function onTcQuickBulkToggle() {
  const input = $('tc-quick-title');
  const area = $('tc-quick-titles');
  const bulk = tcQuickBulkOn();
  if (bulk) {
    area.value = [input.value.trim(), ...tcQuickParked].filter(Boolean).join('\n');
    tcQuickParked = [];
    input.value = '';
  } else {
    const lines = tcQuickLines();
    input.value = lines[0] || '';
    tcQuickParked = lines.slice(1);
    area.value = '';
  }
  input.hidden = bulk;
  area.hidden = !bulk;
  (bulk ? area : input).focus();
  syncTcQuickCreate();
}

const onTcQuickInput = () => syncTcQuickCreate();

// Quick: Enter creates, and a modifier held with it does nothing (web parity). Bulk: Enter is a
// newline, Cmd/Ctrl+Enter the create. Panel hotkeys never see either — hotkeys.js skips fields.
function onTcQuickKeydown(e) {
  if (e.key !== 'Enter') return;
  if (tcQuickBulkOn()) {
    if (!e.metaKey && !e.ctrlKey) return;
  } else if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
    return;
  }
  e.preventDefault();
  submitTcQuick();
}

async function submitTcQuick() {
  const titles = tcQuickTitles();
  if (tcQuickBusy || !titles.length || !state.tcSuiteId) return;
  const bulk = tcQuickBulkOn();
  // The web session can lapse between opening the suite and pressing Create.
  const lock = bulk ? tcBulkLock() : '';
  if (lock) { toast(lock); return; }
  const suiteId = state.tcSuiteId;
  const field = bulk ? $('tc-quick-titles') : $('tc-quick-title');
  setTcQuickBusy(true);
  try {
    if (bulk) await TestomatAPI.bulkCreateTests(suiteId, titles);
    else await TestomatAPI.createTest({ title: titles[0], suite_id: suiteId });
    field.value = '';
    if (bulk) tcQuickParked = [];
    resetTcSearch(); // a live filter would hide the very row just made
    await loadTcList(suiteId, { quiet: true });
    // The new tests are appended, so the end of the list is where they landed. The page's own
    // bottom, not the last row: scrolled all the way, the pinned bar sits under the list, over nothing.
    if (state.tcSuiteId === suiteId) window.scrollTo({ top: document.documentElement.scrollHeight });
  } catch (e) {
    toast(e.message || String(e)); // the typed titles stay in the field
  } finally {
    setTcQuickBusy(false);
    if (state.tcSuiteId === suiteId) field.focus();
  }
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
