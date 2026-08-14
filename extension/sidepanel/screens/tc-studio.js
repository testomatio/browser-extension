// TC Studio screen: the suite tree, the per-suite TC list, and the test-page
// hand-off (read-only view for an existing test, editor for a new one).

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, PriorityIcons, TestType */

// ---------- TC Studio (M3): suite tree + TC list ----------
// The tree itself is built SERVER-side and read whole from JSON:API
// GET /suites/tree (#114) — both here and in the "New test" suite picker, so the
// two always show the same nodes in the same (abs_position) order.
// The test page is a separate vanilla extension page reached by navigating the
// panel document to editor/editor.html?ctx=panel (research R3, amendment A1).

const tcExpanded = (id) => !!state.tcExpanded[String(id)];

// The row's test_count, as the shared `.row-count` — the plain trailing figure
// every list in the panel ends a row with (ROW TAIL, shared/components.css),
// the same one a run's suite header shows its done/total in. It was a boxed
// `.counter` here, which put a column of chips down the right edge of the tree
// and made a number that only qualifies its title read as a control.
// Folders show the subtree total, files their own count, including 0 for an
// empty one — an omitted badge read as "not loaded yet", not "empty".
function tcCounter(n) {
  if (!n || n.test_count == null) return null;
  const b = document.createElement('span');
  b.className = 'row-count';
  b.textContent = String(n.test_count);
  return b;
}

// The row's hover cell: the shared `.row-actions.on-hover`, which draws over
// the trailing edge the count is standing on and hides it while it is up — one
// slot at the end of a row, never a number and a button competing for it.
function rowActions(...kids) {
  const cell = document.createElement('div');
  cell.className = 'row-actions on-hover';
  cell.append(...kids);
  return cell;
}

// ---------- inline suite/folder creation (cycle 011) ----------

// Suites created in THIS visit to the screen, newest first. The API appends a
// new suite to the end of its parent's children, so drawn in the server's order
// a node would leave the row it was named in and reappear at the bottom of the
// list — in a big project, off-screen. Instead it is hoisted back to the top of
// its own siblings, the row the input row stood in, and stays there while the
// tester is looking at the tree.
//
// Reset on every fresh open of the Tests screen (openTcStudioView), so the next
// look at the project is the project's own order — by then the node is one of
// the others, not the one just made. IDs only, so a re-fetched tree still hits.
const tcJustCreated = [];

// Non-mutating: state.tcSuites is the server's tree and stays in its order —
// only the drawing is reordered, and only at the level the node belongs to.
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

// An inline title-input row for a new suite (`file`) or folder (`folder`).
// `parentId` nests it (null = root); `mount(li)` places the <li> at the TOP of
// its list (the tree itself, or a folder's children) — one row under the button
// that opened it, never off the bottom of a project with a hundred suites. The
// node then STAYS in that row once it exists (see tcJustCreated): the server
// appends it, but a thing you just made jumping to the end of a long list is
// how you lose it.
//
// The row is the shared name-the-node row (`.tree-input-row`,
// shared/components.css): the node is drawn where it will land, wearing the
// glyphs it will wear — chevron + folder for a folder, the file glyph for a
// suite — with the field standing in for the title it does not have yet. Enter
// or the tick create, Esc / the cross / losing focus dismiss — a row being typed
// is not a mode to escape from, so looking away is an answer.
// Success: re-fetch the tree, keep the parent expanded, new node visible.
// Failure: toast, keep the row with the typed title (FR-008 spirit).
function openSuiteInput({ parentId, fileType, mount }) {
  closeSuiteInput();
  const folder = fileType === 'folder';
  const li = document.createElement('li');
  li.className = 'tc-item tree-node tc-new-suite';
  const row = document.createElement('div');
  row.className = 'list-row tc-row list-head tree-row tree-input-row';
  if (folder) {
    row.classList.add('has-chevron');
    row.append(treeIcon(CHEVRON_ICON, 'chevron'));
  }
  row.append(treeIcon(folder ? FOLDER_ICON : FILE_ICON, folder ? 'folder-icon' : 'file-icon'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-input';
  input.autocomplete = 'off';
  input.placeholder = folder ? 'Enter folder name' : 'Enter suite name';
  input.setAttribute('aria-label', folder ? 'New folder name' : 'New suite name');

  // Tick and cross, in the slot a tree row keeps its actions in. Both hold the
  // field's focus on mousedown: the row cancels on focusout, and a control that
  // dismissed the row before its own click landed would never fire.
  const iconBtn = (icon, cls, tip) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn size-xs ${cls}`;
    b.append(svgIcon(icon, 16));
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
      state.tcSuites = await TestomatAPI.getSuiteTree(); // server-built tree, incl. the new node
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

// The "Suite" / "Folder" button pair (house style). `openFor(fileType)`
// opens the inline input in the caller's chosen location. Two skins, because the
// pair lives in two places: `.tc-new` is the pill revealed on hovering a tree row
// (see style.css), while the empty state shows the shared button, always visible.
//
// Both wear the leading `add` glyph rather than a typed "+ ": the plus is an
// ICON in this panel, so it lines up with the tree's own chevron and folder
// marks and takes the button's icon size instead of the label's font.
function suiteAddButtons(openFor, cls = 'btn size-xs tc-new') {
  const frag = document.createDocumentFragment();
  const mk = (label, fileType, tip) => {
    const b = document.createElement('button');
    b.className = cls;
    b.append(svgIcon('add', 16), document.createTextNode(label));
    Tooltip.set(b, tip);
    b.addEventListener('click', (e) => { e.stopPropagation(); openFor(fileType); });
    return b;
  };
  frag.append(mk('Suite', 'file', 'New test suite here'), mk('Folder', 'folder', 'New folder here'));
  return frag;
}

// Root-level create (toolbar + empty-state): the input mounts at the tree top,
// right under the toolbar the button lives in, and scrolls itself into view for
// a tree the tester had already scrolled down.
function openRootSuiteInput(fileType) {
  openSuiteInput({
    parentId: null,
    fileType,
    mount: (row) => { $('tc-tree').prepend(row); row.scrollIntoView({ block: 'nearest' }); },
  });
}

// One tree node. A `folder` is a collapsible grouping; a `file` is a TC
// container (research R5). `ctx.pick` switches the file behaviour: in studio mode
// a file opens its TC list and offers "New test"; in pick mode (promote suite
// picker) a file row is selectable and calls `ctx.onPick(node)`. Children are
// built once and shown/hidden by the expand set; ctx flows down unchanged.
function tcNode(node, ctx) {
  const li = document.createElement('li');
  li.className = 'tc-item tree-node';
  const row = document.createElement('div');
  // `tree-row` is what puts the row's rule under its TYPE glyph rather than out
  // at the chevron column the open guide comes down (shared/components.css).
  row.className = 'list-row tc-row list-head tree-row';
  row.dataset.id = node.id;

  if (node.file_type === 'folder') {
    row.classList.add('tc-folder', 'has-chevron');
    row.append(treeIcon(CHEVRON_ICON, 'chevron'));
    // `node.emoji` is the icon the project chose for this folder in Testomat
    // (api.js normSuiteNode reads it off the tree) — where there is one, it is
    // the mark, and the folder glyph is what a node without one falls back to.
    row.append(treeIcon(FOLDER_ICON, 'folder-icon', node.emoji));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = node.title || '(untitled)';
    row.append(title);
    const badge = tcCounter(node);
    if (badge) row.append(badge);
    li.append(row);

    // A search opens every folder it left standing (`ctx.expandAll`) — a match
    // three levels down is not an answer if the branch to it is shut. It does
    // NOT write to the expand set: clearing the query has to give the tester
    // back the tree they had folded themselves, so `open` is local from here on
    // and only a real click on the row records a preference.
    let open = ctx.expandAll || tcExpanded(node.id);
    const kids = document.createElement('ul');
    kids.className = 'tc-children tree-children';
    kids.hidden = !open;
    // Studio only: the picker draws the project's own order, because picking a
    // suite is reading the tree, not making one. (`hoistJustCreated` is a no-op
    // until something is created, so an untouched tree is the server's either way.)
    const children = ctx.pick ? (node.children || []) : hoistJustCreated(node.children);
    for (const c of children) kids.append(tcNode(c, ctx));
    li.append(kids);
    if (open) row.classList.add('expanded');
    row.addEventListener('click', () => {
      open = !open;
      state.tcExpanded[String(node.id)] = open;
      kids.hidden = !open;
      row.classList.toggle('expanded', open);
    });
    // Studio mode: folders can spawn child suites/folders (not in the pick tree).
    if (!ctx.pick) {
      row.append(rowActions(suiteAddButtons((fileType) => {
        state.tcExpanded[String(node.id)] = true; // reveal the input inside kids
        kids.hidden = false;
        row.classList.add('expanded');
        openSuiteInput({
          parentId: node.id,
          fileType,
          // First child of the folder it belongs to — directly under the row
          // whose button opened it — and scrolled to, since a folder opening
          // low in the panel can push its own first row off the bottom.
          mount: (r) => { kids.prepend(r); r.scrollIntoView({ block: 'nearest' }); },
        });
      })));
    }
  } else {
    row.classList.add('tc-file');
    row.append(treeIcon(FILE_ICON, 'file-icon', node.emoji));
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
      add.append(svgIcon('add', 16), document.createTextNode('New test'));
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

// Empty-tree edge (spec): the project has no suites. The shared empty state,
// with the "Suite"/"Folder" pair as its ACTIONS in studio mode (`canCreate`)
// so an empty project is not a dead end (cycle 011), and the web-app link in the
// sentence for the picker, which cannot create anything from here.
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
//
// The tree is already in memory (state.tcSuites), so the filter is local: no
// round trip, no endpoint, nothing to keep in step with the server. It matches
// TITLES of suites and folders — the only thing this screen draws; the tests
// themselves are searched one level in, by the TC list's own field.

// A node survives when its own title matches, or when anything under it does —
// a folder is the PATH to what was found, so it stays even when its own name
// says nothing about the query. A matching folder keeps its whole subtree (the
// tester asked for that folder, and its contents are the answer); a folder kept
// only for what is under it shows just the branches that lead there.
//
// Returns a fresh tree of copies: state.tcSuites is what a cleared query
// restores, so the filter must never write into it.
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

// The tree's counterpart of tcListEmpty(searching): a query that matched nothing
// is not an empty project, and the way out of it is the query, not a create.
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

// Reflect the field onto state + its clear button, then redraw from the tree
// already in memory.
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

// Drop the query WITHOUT redrawing — for the callers that are about to redraw
// anyway (a create, whose new node a live filter could otherwise hide).
function resetTcTreeSearch() {
  state.tcTreeSearch = '';
  syncTcTreeSearchInput();
}

// Put the field and its clear button back in step with the state: a project
// switch and a create both reset the query behind the input's back.
function syncTcTreeSearchInput() {
  const input = $('tc-tree-search');
  if (!input) return;
  if (input.value !== state.tcTreeSearch) input.value = state.tcTreeSearch;
  $('tc-tree-search-clear').hidden = state.tcTreeSearch.trim() === '';
}

function renderSuiteTreeInto(ul, roots, ctx) {
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
  // The empty state carries its own create buttons, so hide the redundant root
  // toolbar there; otherwise the toolbar is the primary root-create affordance.
  // A query keeps it up whatever it matched — the field IS in that row, and a
  // toolbar that vanishes under the search that emptied the tree takes the way
  // back with it.
  const bar = $('tc-tree-bar');
  if (bar) bar.hidden = !roots.length && !q;
  // Hoist AFTER the filter: the filter returns copies, and a node kept by the
  // query is the same node — reordering last keeps the two rules independent.
  renderSuiteTreeInto($('tc-tree'), hoistJustCreated(filterSuiteTree(roots, q)), {
    pick: false,
    expandAll: !!q,               // show the branch that leads to every match
    searching: !!q && !!roots.length, // "no match" only when there WAS something to match
  });
  // The tab chip counts the PROJECT, never the filter: it is a statement about
  // what the project holds, and it is read from a tab the search is not on.
  setTabCount('tests', treeTestCount(roots));
}

// The Tests tab's count chip (#127): every test case in the project. Summed over
// the ROOTS only, never the whole tree — a folder's `test_count` is already its
// subtree total (see tcCountBadge above), so descending would count a test once
// per ancestor it hangs under. Roots do not overlap, so their totals add.
// Only renderSuiteTree feeds it, not renderSuiteTreeInto: the picker draws the
// same tree into a different list, and that is a step of "New test", not a statement
// about the project. An empty tree is a real 0 and says so.
const treeTestCount = (roots) =>
  (roots || []).reduce((n, s) => n + (Number(s.test_count) || 0), 0);

// The Tests count WITHOUT the tree: the counterpart of loadRunsCount(), for the
// tab a project switch did NOT land on (prefetchTabCounts in core/views.js is
// the only caller). Same source as renderSuiteTree — the roots' own totals — so
// opening the tab does not change the number. Leaves state.tcSuites untouched:
// the tree belongs to the view that draws it, and a stale one cached here would
// be shown before the real fetch replaced it.
async function loadTestsCount(epoch) {
  try {
    const roots = await TestomatAPI.getSuiteTree();
    if (staleProject(epoch)) return;
    setTabCount('tests', treeTestCount(roots));
    // The tree itself is dropped (see above), but the marks it carries are not:
    // they are the project's, not this screen's, and a run opened next will
    // want them (rememberSuiteEmoji, screens/run-view.js).
    rememberSuiteEmoji(roots);
  } catch { /* best effort — the chip stays absent */ }
}

async function openTcStudioView() {
  show('tcstudio');
  const sk = Skeleton.show('tcstudio'); // before the read-only probe — it is a round trip too
  // #155: the lockout covers the Tests tab too — settle the probe before the
  // tree fetch, so a locked project shows the blocking panel and nothing else.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  setStatusLine('tcstudio-status', 'Loading suites…');
  // The query outlives leaving the screen (it is where the tester left the tree)
  // but not a project switch, which clears it in state — so the field is read
  // FROM the state on every open, not the other way round.
  syncTcTreeSearchInput();
  // A fresh look at the tree is the project's own order again: what was made
  // last visit has had its moment at the top and is now one of the suites.
  tcJustCreated.length = 0;
  $('tc-tree').replaceChildren();
  const epoch = state.projectEpoch; // a project switch mid-fetch discards this tree
  try {
    const suites = await TestomatAPI.getSuiteTree();
    if (staleProject(epoch)) return;
    state.tcSuites = suites;
    // Same tree, one index: a run's suite sections wear the marks this screen
    // just read, without a fetch of their own (screens/run-view.js).
    rememberSuiteEmoji(state.tcSuites);
    renderSuiteTree(state.tcSuites);
    setStatusLine('tcstudio-status', '');
  } catch (e) {
    handleApiError(e, 'tcstudio-status');
  } finally {
    Skeleton.hide(sk);
  }
}

// One node's emoji, found by id anywhere in the tree (depth-first). null when
// the tree is empty or the node is not in it — both mean "draw the glyph".
function suiteNodeEmoji(nodes, id) {
  for (const n of nodes || []) {
    if (String(n.id) === String(id)) return n.emoji || null;
    const found = suiteNodeEmoji(n.children, id);
    if (found) return found;
  }
  return null;
}

// Case-insensitive title substring match against the live search query.
function tcRowMatches(t) {
  const q = state.tcSearch.trim().toLowerCase();
  if (!q) return true;
  return (t.title || t.clean_title || '').toLowerCase().includes(q);
}

// The two nothings a suite can show, and they are genuinely different answers:
// a suite with no tests is a place to write one (the screen's own "New test"
// is right above, so the empty state points AT it rather than repeating it),
// while a search that matched none of them just needs clearing.
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
  add.append(svgIcon('add', 16), document.createTextNode('New test'));
  add.addEventListener('click', () => $('tc-list-new')?.click());
  return EmptyState.build({
    tag: 'li',
    icon: 'note_add',
    title: 'No test cases yet',
    text: 'This suite is empty. Write the first case for it here.',
    actions: [add],
  });
}

// Render the already-fetched TCs with the live-search filter applied.
function renderTcList() {
  const ul = $('tc-list');
  ul.replaceChildren();
  const all = state.tcTests || [];
  const rows = all.filter(tcRowMatches);
  for (const t of rows) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    const head = document.createElement('div');
    head.className = 'list-head';
    // The two marks the web app opens a test row with (◇ UI app library): how
    // much it matters, then what it is, then its name. Both come off the v2
    // record this list is already holding — `priority` and `state` — so neither
    // costs a round trip, and both are absent-safe: a test the API returns no
    // priority for gets the `normal` ring it in fact runs at, so every row in the
    // column carries a mark and every title starts on the same vertical.
    const prio = typeof PriorityIcons !== 'undefined' ? PriorityIcons.mark(t.priority) : null;
    // …unless the test was given a custom EMOJI in Testomat, which stands in the
    // type mark's own square — the icon a project chose for a test is what that
    // test is called by, and the panel says the same thing the web list does.
    // The kind is still on the test's own page, which is where a row that shows
    // an emoji sends you.
    const type = Icons.emoji(t.emoji, 'type-mark')
      || (typeof TestType !== 'undefined' ? TestType.forRecord(t) : null);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title || t.clean_title || '(untitled)';
    head.append(...[prio, type, title].filter(Boolean));
    li.append(head);
    li.addEventListener('click', () =>
      openEditor({ test: t.id, suiteId: state.tcSuiteId, suiteTitle: state.tcSuiteTitle }));
    ul.append(li);
  }
  if (!rows.length) ul.append(tcListEmpty(all.length > 0));
  // The caption's count is what is ON SCREEN, not what the suite holds: with a
  // search running, the number the eye can check against the rows is the only one
  // that is not a contradiction. An empty suite is a real 0 and says so.
  const count = $('tc-list-count');
  if (count) { paintCounter(count, rows.length); count.hidden = false; }
  setStatusLine('tclist-status', '');
}

// Reflect the search input onto state + clear button, then re-render the list.
function onTcSearch() {
  state.tcSearch = $('tc-search').value;
  $('tc-search-clear').hidden = state.tcSearch.trim() === '';
  renderTcList();
}

function clearTcSearch() {
  $('tc-search').value = '';
  state.tcSearch = '';
  $('tc-search-clear').hidden = true;
  renderTcList();
  $('tc-search').focus();
}

async function openTcListView(suiteId, title) {
  if (capabilities.readonly) { show('tclist'); return; } // #155 — locked project
  state.tcSuiteId = suiteId;
  state.tcSuiteTitle = title || 'Suite';
  // …and the mark it wears in the header of the screen it opens (core/views.js).
  // Read off the tree the panel is already holding — the three callers of this
  // function have an id and a title between them, never the node — and null when
  // there is no tree to read (a session restored straight into this view), which
  // is the suite glyph, not a wrong emoji.
  state.tcSuiteEmoji = suiteNodeEmoji(state.tcSuites, suiteId);
  // Search resets on every suite open (in-memory only).
  state.tcSearch = '';
  if ($('tc-search')) $('tc-search').value = '';
  if ($('tc-search-clear')) $('tc-search-clear').hidden = true;
  show('tclist');
  const sk = Skeleton.show('tclist');
  setStatusLine('tclist-status', 'Loading tests…');
  $('tc-list').replaceChildren();
  // The previous suite's number is not this one's: the chip goes away for the
  // fetch and comes back with an answer, the way a tab's count does.
  if ($('tc-list-count')) $('tc-list-count').hidden = true;
  try {
    // Newest-first as the API returns (created_at DESC — research R5).
    const tests = await TestomatAPI.getTestsBySuite(suiteId);
    if (state.tcSuiteId !== suiteId) return;
    state.tcTests = tests;
    renderTcList();
  } catch (e) {
    handleApiError(e, 'tclist-status');
  } finally {
    Skeleton.hide(sk);
  }
}

// "New test" (root toolbar): pick a file suite, then open the editor in create mode
// bound to it. Reuses the TC-tree in pick mode (the former promote picker — kept
// exactly for this). Cancel is the Back arrow (goBack → tcstudio).
async function openTestSuitePicker() {
  show('promote');
  const sk = Skeleton.show('promote');
  $('promote-hint').textContent = 'Choose a suite for the new test:';
  setStatusLine('promote-status', 'Loading suites…');
  $('promote-tree').replaceChildren();
  try {
    const roots = await TestomatAPI.getSuiteTree(); // same server tree as the Tests tab
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

// Navigate the panel document to the test page (research R3). State handoff is
// by id only (never serialized content); a sessionStorage breadcrumb lets the
// page's Back button restore the exact suite/list it came from (consumed once in
// init). `test` => the read-only view (#115); `suite` => the create editor.
function openEditor({ test, suite, suiteId, suiteTitle }) {
  try {
    sessionStorage.setItem('tcReturn', JSON.stringify({ suiteId, suiteTitle }));
  } catch { /* sessionStorage unavailable — Back falls through to runs */ }
  const params = new URLSearchParams({ ctx: 'panel' });
  if (test) params.set('test', test);
  if (suite) params.set('suite', suite);
  window.location.href = `../editor/editor.html?${params.toString()}`;
}
