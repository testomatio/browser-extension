// TC Studio screen: the suite tree, the per-suite TC list, and the test-page
// hand-off (read-only view for an existing test, editor for a new one).

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, PriorityIcons, TestType */

// ---------- TC Studio: suite tree + TC list ----------
// The tree is built SERVER-side and read whole from GET /suites/tree (#114) — here
// and in the "New test" picker, so both show the same nodes in abs_position order.

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

  // Both hold the field's focus on mousedown: the row cancels on focusout, so a
  // control that dismissed the row before its own click landed would never fire.
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
      state.tcSuites = await TestomatAPI.getSuiteTree(); // server tree, incl. the new node
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
    b.append(svgIcon('add', 16), document.createTextNode(label));
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

  if (node.file_type === 'folder') {
    row.classList.add('tc-folder', 'has-chevron');
    row.append(treeIcon(CHEVRON_ICON, 'chevron'));
    // `node.emoji` (api.js normSuiteNode) is the project's own mark for the
    // folder; the folder glyph is the fallback for a node without one.
    row.append(treeIcon(FOLDER_ICON, 'folder-icon', node.emoji));
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
          // First child of its folder, scrolled to — a folder opening low in the
          // panel can push its own first row off the bottom.
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
  show('tcstudio');
  const sk = Skeleton.show('tcstudio'); // before the read-only probe — it is a round trip too
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
    const suites = await TestomatAPI.getSuiteTree();
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
    ul.append(li);
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
  // Read off the tree already in memory — the callers have an id and a title,
  // never the node. null (no tree, e.g. a restored session) draws the glyph.
  state.tcSuiteEmoji = suiteNodeEmoji(state.tcSuites, suiteId);
  // Search resets on every suite open (in-memory only).
  state.tcSearch = '';
  if ($('tc-search')) $('tc-search').value = '';
  if ($('tc-search-clear')) $('tc-search-clear').hidden = true;
  show('tclist');
  const sk = Skeleton.show('tclist');
  setStatusLine('tclist-status', 'Loading tests…');
  $('tc-list').replaceChildren();
  // The previous suite's number is not this one's — the chip goes for the fetch.
  if ($('tc-list-count')) $('tc-list-count').hidden = true;
  try {
    // v2 answers newest-first; the web orders a suite's tests by `position` ascending (#4).
    const tests = await TestomatAPI.getTestsBySuite(suiteId);
    if (state.tcSuiteId !== suiteId) return;
    state.tcTests = tests.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    renderTcList();
  } catch (e) {
    handleApiError(e, 'tclist-status');
  } finally {
    Skeleton.hide(sk);
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
