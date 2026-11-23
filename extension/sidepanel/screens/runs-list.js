// Runs-list screen: runs and rungroup folders, filter chips, refresh, lazy nesting, URL paste.

/* global TestomatAPI, Skeleton, Tooltip, EmptyState, TestType, Roving, StatusIcons, RunsPaging, RunsUrl */

// Order matters: fitFilterChips hides the rightmost chips first when the row runs out of room.
const RUN_FILTERS = [
  ['all', 'All'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['running', 'Running'],
  ['scheduled', 'Scheduled'],
  ['terminated', 'Terminated'],
];
const FILTER_KEYS = new Set(RUN_FILTERS.map(([k]) => k));
// Count tint: a `.counter` takes the same status words as a badge (shared/components.css).
const RUNS_FILTER_TINT = { passed: 'passed', failed: 'failed' };
const LOADING_ICON = 'progress_activity';
const filterLabel = (key) => (RUN_FILTERS.find(([k]) => k === key) || [, key])[1];
const matchesFilter = (status) => state.runsFilter === 'all' || StatusIcons.normStatus(status) === state.runsFilter;

// A group matching the search reveals all its status-passing contents.
const runsSearchActive = () => state.runsSearch.trim() !== '';
const runsFilterActive = () => state.runsFilter !== 'all';
const anyRunsConstraint = () => runsSearchActive() || runsFilterActive();
const titleOf = (item) => (item.clean_title || item.title || '').toLowerCase();
const searchNeedle = () => state.runsSearch.trim().toLowerCase();
// A run also answers to its id, pasted from a URL or a CI log; folders match by title only.
const runMatchesSearch = (run) =>
  !runsSearchActive()
  || titleOf(run).includes(searchNeedle())
  || String(run.id || '').toLowerCase().includes(searchNeedle());
const groupTitleMatchesSearch = (group) => !runsSearchActive() || titleOf(group).includes(searchNeedle());
const runPasses = (run) => matchesFilter(run.status) && runMatchesSearch(run);
const groupSelfHit = (group) => matchesFilter(group.status) && groupTitleMatchesSearch(group);
const runsEmptyMessage = () =>
  (runsSearchActive() ? 'No runs match' : `No ${filterLabel(state.runsFilter).toLowerCase()} runs`);

// Degraded fallback: both cursors are kept so "Load more" can advance whichever source has a tail.
async function fetchRunsData(page = 1) {
  const [runsRes, groupsRes] = await Promise.all([
    TestomatAPI.listRuns(page),
    TestomatAPI.listRunGroups(page),
  ]);
  return {
    runs: runsRes?.data || [],
    groups: groupsRes?.data || [],
    runsCursor: RunsPaging.v2Cursor(runsRes, page),
    groupsCursor: RunsPaging.v2Cursor(groupsRes, page),
  };
}

// Dashboard page 1 under a JWT session (one source, web order); the v2 fetch only without one.
async function loadRuns() {
  state.childrenCache = {};
  state.subgroupsCache = {};
  state.loadingGroup = {};
  state.descendantRuns = {};
  state.descendantsSettled = false;
  state.descendantsPartial = false;
  state.descInFlight = 0;
  state.descLoadToken += 1; // strands any nested-count batch of the previous load
  state.groupPaging = {};
  state.listPaging = {};
  state.v2RunsPaging = {};
  state.v2GroupsPaging = {};
  const epoch = state.projectEpoch; // a project switch mid-fetch discards this list
  try {
    const res = await TestomatAPI.fetchDashboardPage(1);
    if (staleProject(epoch)) return;
    state.listMode = 'dashboard';
    state.dashItems = res.items;
    state.listPaging = { page: res.page, total: res.total, totalPages: res.totalPages, loading: false };
    capabilities.jwt = true;
    applyCapabilities();
    // Session proven: prefetch so a run opened next paints names and timezone in its first frame.
    loadProjectInfo();  // fire-and-forget; each swallows its own failure
    loadProjectUsers();
    loadDescendantRuns(); // best-effort
  } catch (e) {
    if (TestomatAPI.jwtAvailable() === false) {
      capabilities.jwt = false;
      applyCapabilities();
      const { runs, groups, runsCursor, groupsCursor } = await fetchRunsData(1);
      if (staleProject(epoch)) return;
      state.listMode = 'v2';
      state.lastRuns = runs;
      state.lastGroups = groups;
      state.v2RunsPaging = runsCursor;
      state.v2GroupsPaging = groupsCursor;
      state.listPaging = RunsPaging.v2ListPaging();
      state.descendantsSettled = true; // v2 flat list is already complete
    } else {
      throw e; // genuine error under a working session — surface it
    }
  }
}

// Fetched up front so the chip counts are complete before any folder is expanded.
function loadDescendantRuns() {
  const groups = state.dashItems
    .filter((it) => it.type === 'rungroup' && !state.descendantRuns[String(it.id)]);
  const token = state.descLoadToken;
  if (!groups.length) {
    if (!state.descInFlight) state.descendantsSettled = true;
    return Promise.resolve();
  }
  state.descendantsSettled = false;
  state.descInFlight += 1;
  let anyFailed = false; // a failed leg means the counts are a lower bound
  return Promise.all(groups.map((g) =>
    TestomatAPI.fetchGroupRunsNested(g.id)
      .then((runs) => { if (token === state.descLoadToken) state.descendantRuns[String(g.id)] = runs; })
      .catch(() => { if (token === state.descLoadToken) { state.descendantRuns[String(g.id)] = []; anyFailed = true; } }),
  )).then(() => {
    if (token !== state.descLoadToken) return; // a newer load owns the cache now
    state.descInFlight = Math.max(0, state.descInFlight - 1);
    if (anyFailed) state.descendantsPartial = true;
    if (state.descInFlight) return; // another page's counts are still in flight
    state.descendantsSettled = true;
    // The async settle must not clobber an error the user is reading — re-assert it.
    const status = $('runs-status');
    const err = status.classList.contains('error') ? status.textContent : null;
    renderList();
    if (err) setStatusLine('runs-status', err, 'error');
  });
}

function renderList() {
  if (state.listMode === 'dashboard') renderDashboard();
  else renderRuns(state.lastRuns, state.lastGroups);
  // The tab count chip is not set here: loadRunsCount() owns it, so "Load more" never moves it.
}

// The project's run total off /runs: no folder rows to miscount, no JWT needed, nothing in state.
async function loadRunsCount(epoch) {
  try {
    const total = await TestomatAPI.countRuns();
    if (!staleProject(epoch)) setTabCount('runs', total);
  } catch { /* best effort — the chip stays absent */ }
}

// In-memory only — the runs search is never persisted.
function resetRunsSearch() {
  state.runsSearch = '';
  syncRunsSearchInput();
}

// A project switch clears the query in state behind the input's back, so the field reads from state.
function syncRunsSearchInput() {
  const input = $('runs-search');
  if (!input) return;
  if (input.value !== state.runsSearch) input.value = state.runsSearch;
  if ($('runs-search-clear')) $('runs-search-clear').hidden = state.runsSearch.trim() === '';
}

// Not /runs/newrun: that dead web route stacks the player under the list and POSTs a blank run.
function renderNewRunLink() {
  const a = $('btn-new-run');
  if (!a) return;
  const s = state.settings || {};
  if (s.baseUrl && s.projectId) {
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/new`;
    a.hidden = false;
  } else {
    a.removeAttribute('href');
    a.hidden = true;
  }
}

async function openRunsView() {
  // Rows already read paint at once and are re-read behind, so the tester never faces an empty screen.
  const inMemory = state.listMode === 'dashboard' ? state.dashItems?.length : state.lastRuns?.length;
  if (inMemory) {
    show('runs');
    renderNewRunLink();         // href tracks the active host + project
    syncRunsSearchInput();      // the query outlives leaving the screen, a project switch clears it
    renderFilterChips();
    renderList();
    loadRunsCount(state.projectEpoch); // tab chip only — never blocks the list
    // Still gated, but the lockout replaces what is up; nothing is blanked for it.
    if (await readonlyGate()) { applyReadonlyBlock(); return; }
    await refreshRuns();        // the re-read, behind the rows already on screen
    return;
  }
  show('runs');
  // Nothing in memory, so the placeholder is drawn before the read-only probe, its own round trip.
  const sk = Skeleton.show('runs');
  // Probe read-only before any list request: a locked project must not flash a list first.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  renderNewRunLink();           // href tracks the active host + project
  syncRunsSearchInput();
  renderFilterChips();
  setStatusLine('runs-status', 'Loading runs…');
  $('runs-list').replaceChildren();
  try {
    loadRunsCount(state.projectEpoch); // tab chip only — never blocks the list
    await loadRuns();
    renderList();
    await ensureExpandedChildrenLoaded(); // hydrate groups restored expanded
  } catch (e) {
    handleApiError(e, 'runs-status');
  } finally {
    Skeleton.hide(sk);
  }
}

// refreshAll() owns the button's spinning state; on failure the previous list stays.
async function refreshRuns() {
  try {
    await loadRuns();
    renderList();
    await ensureExpandedChildrenLoaded();
  } catch (e) {
    // Read-only mid-session is a lockout, not a failed refresh: repaint into the blocking panel.
    if (isReadonlyError(e)) { applyCapabilities(); return; }
    setStatusLine('runs-status', `Refresh failed: ${e.message || e}`, 'error');
    toast(`Refresh failed: ${e.message || e}`, { error: true });
  }
}

const childrenLoaded = (groupId) => Array.isArray(state.childrenCache[String(groupId)]);
const groupContentsLoaded = (groupId) =>
  childrenLoaded(groupId) && Array.isArray(state.subgroupsCache[String(groupId)]);

// Lazy, cached per refresh; a failed leg caches [] and toasts, so it is not retried until then.
async function loadGroupContents(groupId) {
  const key = String(groupId);
  if (state.loadingGroup[key] || groupContentsLoaded(key)) return;
  state.loadingGroup[key] = true;
  renderList();
  const [subs, runs] = await Promise.all([
    TestomatAPI.fetchGroupSubgroups(groupId, 1).catch(() => null),
    TestomatAPI.fetchGroupChildren(groupId, 1).catch(() => null),
  ]);
  state.subgroupsCache[key] = subs?.items || [];
  state.childrenCache[key] = runs?.items || [];
  // Both cursors in one record: the folder shows one "Load more" for all its contents.
  state.groupPaging[key] = {
    subsPage: subs?.page || 1, subsTotal: subs?.total ?? null, subsTotalPages: subs?.totalPages ?? null,
    runsPage: runs?.page || 1, runsTotal: runs?.total ?? null, runsTotalPages: runs?.totalPages ?? null,
    runsPerPage: runs?.perPage ?? null,
    loading: false,
  };
  if (subs === null || runs === null) toast('Could not load some group contents', { error: true });
  delete state.loadingGroup[key];
  renderList();
}

// Deliberately not infinite scroll: the one shared scroll container makes bottom-reach races.

// Rows land first; the descendant counts for the page's new groups settle after, repainting chips.
async function loadMoreRuns() {
  const cursor = RunsPaging.listCursor();
  if (!cursor || cursor.loading || !RunsPaging.hasNextPage(cursor)) return;
  const next = (cursor.page || 1) + 1;
  const epoch = state.projectEpoch;
  state.listPaging = { ...cursor, loading: true };
  renderList();
  try {
    if (state.listMode === 'dashboard') {
      const res = await TestomatAPI.fetchDashboardPage(next);
      if (staleProject(epoch) || state.listMode !== 'dashboard') return;
      state.dashItems = [...state.dashItems, ...res.items];
      state.listPaging = { page: res.page, total: res.total, totalPages: res.totalPages, loading: false };
      renderList();
      await loadDescendantRuns();          // counts for the groups this page brought in
      await ensureExpandedChildrenLoaded(); // …and contents for any that restored expanded
    } else {
      const runsNext = RunsPaging.hasNextPage(state.v2RunsPaging) ? next : null;
      const groupsNext = RunsPaging.hasNextPage(state.v2GroupsPaging) ? next : null;
      const [runsRes, groupsRes] = await Promise.all([
        runsNext ? TestomatAPI.listRuns(runsNext) : null,
        groupsNext ? TestomatAPI.listRunGroups(groupsNext) : null,
      ]);
      if (staleProject(epoch) || state.listMode !== 'v2') return;
      if (runsRes) {
        state.lastRuns = [...(state.lastRuns || []), ...(runsRes.data || [])];
        state.v2RunsPaging = RunsPaging.v2Cursor(runsRes, runsNext);
      }
      if (groupsRes) {
        state.lastGroups = [...(state.lastGroups || []), ...(groupsRes.data || [])];
        state.v2GroupsPaging = RunsPaging.v2Cursor(groupsRes, groupsNext);
      }
      state.listPaging = RunsPaging.v2ListPaging();
      renderList();
    }
  } catch (e) {
    state.listPaging = { ...cursor, loading: false };
    renderList();
    toast(`Could not load more runs: ${e.message || e}`, { error: true });
  }
}

// Next page of one folder's contents: subgroups first, then runs (render order).
async function loadMoreGroup(groupId) {
  const key = String(groupId);
  const p = state.groupPaging[key];
  if (!p || p.loading || !RunsPaging.groupHasMore(key)) return;
  const epoch = state.projectEpoch;
  state.groupPaging[key] = { ...p, loading: true };
  renderList();
  const subsNext = RunsPaging.hasNextPage({ page: p.subsPage, totalPages: p.subsTotalPages }) ? p.subsPage + 1 : null;
  const runsNext = RunsPaging.hasNextPage({ page: p.runsPage, totalPages: p.runsTotalPages }) ? p.runsPage + 1 : null;
  try {
    const [subs, runs] = await Promise.all([
      subsNext ? TestomatAPI.fetchGroupSubgroups(groupId, subsNext) : null,
      runsNext ? TestomatAPI.fetchGroupChildren(groupId, runsNext, p.runsPerPage) : null,
    ]);
    if (staleProject(epoch)) return;
    const merged = { ...state.groupPaging[key], loading: false };
    if (subs) {
      state.subgroupsCache[key] = [...(state.subgroupsCache[key] || []), ...subs.items];
      Object.assign(merged, { subsPage: subs.page, subsTotal: subs.total, subsTotalPages: subs.totalPages });
    }
    if (runs) {
      state.childrenCache[key] = [...(state.childrenCache[key] || []), ...runs.items];
      Object.assign(merged, {
        runsPage: runs.page, runsTotal: runs.total, runsTotalPages: runs.totalPages,
        runsPerPage: runs.perPage ?? merged.runsPerPage,
      });
    }
    state.groupPaging[key] = merged;
    renderList();
  } catch (e) {
    state.groupPaging[key] = { ...state.groupPaging[key], loading: false };
    renderList();
    toast(`Could not load more runs: ${e.message || e}`, { error: true });
  }
}

// "M of T loaded" shows only under an active constraint: the filter searched just the loaded rows.
function loadMoreRow({ remaining, loading, loaded, total, onClick, label = 'Load more' }) {
  const li = document.createElement('li');
  li.className = 'load-more';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn pill size-sm load-more-btn';
  btn.disabled = !!loading;
  btn.dataset.loading = loading ? 'true' : 'false';
  const text = document.createElement('span');
  text.className = 'load-more-text';
  text.textContent = loading
    ? 'Loading…'
    : (remaining ? `${label} (${remaining} more)` : label);
  // One class per argument: classList.add throws on a token holding a space.
  if (loading) btn.append(StatusIcons.svgIcon(LOADING_ICON, 14, 'spin', 'load-more-spinner'));
  btn.append(text);
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
  li.append(btn);
  if (anyRunsConstraint() && total != null) {
    const note = document.createElement('span');
    note.className = 'hint load-more-note';
    note.textContent = `${loaded} of ${total} loaded`;
    li.append(note);
  }
  return li;
}

function reachableGroupIds() {
  const ids = new Set(state.dashItems.filter((it) => it.type === 'rungroup').map((it) => String(it.id)));
  for (const subs of Object.values(state.subgroupsCache)) for (const sg of subs) ids.add(String(sg.id));
  return ids;
}

// Walks nested chains until no progress, then prunes expansion state for ids gone from the tree.
async function ensureExpandedChildrenLoaded() {
  if (state.listMode !== 'dashboard') return;
  for (let guard = 0; guard < 20; guard++) {
    const reachable = reachableGroupIds();
    const toLoad = state.expandedGroups.filter((id) => reachable.has(String(id)) && !groupContentsLoaded(id));
    if (!toLoad.length) break;
    await Promise.all(toLoad.map((id) => loadGroupContents(id)));
  }
  const reachable = reachableGroupIds();
  const kept = state.expandedGroups.filter((id) => reachable.has(String(id)));
  if (kept.length !== state.expandedGroups.length) { state.expandedGroups = kept; persistSession(); }
  renderList();
}

// Root-first: each level's contents must load before the next level's row exists.
async function expandGroupChain(ids) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!state.expandedGroups.some((x) => String(x) === String(id))) state.expandedGroups.push(id);
    persistSession();
    if (state.listMode === 'dashboard' && !groupContentsLoaded(id)) await loadGroupContents(id);
    else renderList();
    // The next link may sit on a later subgroup page: pull pages until its row exists.
    if (ids[i + 1] != null) await ensureSubgroupLoaded(id, ids[i + 1]);
  }
  renderList();
}

// Bounded page-pulling until `childId`'s row exists; only the URL-paste path pays.
async function ensureSubgroupLoaded(parentId, childId) {
  const key = String(parentId);
  const has = () => (state.subgroupsCache[key] || []).some((sg) => String(sg.id) === String(childId));
  for (let guard = 0; guard < 50 && !has() && RunsPaging.groupHasMore(key); guard++) {
    await loadMoreGroup(key);
  }
}

// A root group pasted by URL may live past page 1 of the list.
async function ensureTopLevelGroupLoaded(groupId) {
  for (let guard = 0; guard < 20; guard++) {
    if (findGroupById(groupId)) return true;
    if (!RunsPaging.hasNextPage(RunsPaging.listCursor())) return false;
    await loadMoreRuns();
  }
  return false;
}

// Runs only — folders are never counted; `launching` folds into running.
function statusCounts(runs) {
  const counts = { all: runs.length, running: 0, passed: 0, failed: 0, scheduled: 0, terminated: 0 };
  for (const r of runs) {
    const s = StatusIcons.normStatus(r.status);
    if (s !== 'all' && counts[s] !== undefined) counts[s] += 1;
  }
  return counts;
}

// Built once: only the pressed state and the number move (renderFilterChips).
function buildFilterChip(key, label) {
  const chip = document.createElement('button');
  chip.type = 'button';
  // Plain library button (shared/components.css → FILTERS), no chip modifier.
  chip.className = 'btn secondary size-sm filter-chip';
  chip.dataset.filter = key;
  const text = document.createElement('span');
  text.className = 'filter-label';
  text.textContent = label;
  const count = document.createElement('span');
  count.className = `counter${RUNS_FILTER_TINT[key] ? ` ${RUNS_FILTER_TINT[key]}` : ''}`;
  chip.append(text, count);
  chip.addEventListener('click', () => setRunsFilter(key));
  return chip;
}

// Updated, not rebuilt: rebuilding the six buttons per render re-measures the row, and chips jump.
function renderFilterChips() {
  const bar = $('runs-filter');
  if (!bar) return;
  // Until nested fetches settle, a re-read keeps the last settled numbers rather than count up from 0.
  const pending = state.listMode === 'dashboard' && !state.descendantsSettled;
  // Failed legs: the loaded set is a lower bound, so counts get a trailing "+".
  const settledPartial = state.listMode === 'dashboard' && state.descendantsSettled && state.descendantsPartial;
  const fresh = statusCounts(state.lastRuns || []);
  const held = pending ? state.runsChipCounts : null; // null on a first read — nothing settled yet
  if (!pending) state.runsChipCounts = { counts: fresh, partial: settledPartial };
  const counts = held ? held.counts : fresh;
  // The tooltip follows what the chips show: the snapshot's flag while the snapshot is on screen.
  const partial = held ? held.partial : settledPartial;
  Tooltip.set(bar, partial ? 'Some run counts couldn’t load — Refresh to complete them' : '');
  for (const [key, label] of RUN_FILTERS) {
    let chip = bar.querySelector(`[data-filter="${key}"]`);
    if (!chip) bar.append(chip = buildFilterChip(key, label));
    const on = state.runsFilter === key;
    chip.classList.toggle('selected', on);
    chip.classList.toggle('secondary', !on);
    chip.setAttribute('aria-pressed', String(on));
    paintCounter(chip.querySelector('.counter'),
      pending && !held ? 0 : `${counts[key] ?? 0}${partial ? '+' : ''}`);
  }
  fitFilterChips(bar);
}

// Client-side only (no re-fetch); persisted so the filter survives a reopen.
function setRunsFilter(key) {
  if (!FILTER_KEYS.has(key)) key = 'all';
  if (state.runsFilter === key) return;
  state.runsFilter = key;
  persistSession();
  renderList();
}

// Title search unless URL-shaped: a pasted url opens at once, a typed one waits for Enter.
function onRunsSearch(e) {
  const raw = $('runs-search').value;
  const urlish = RunsUrl.looksLikeRunUrl(raw);
  const next = urlish ? '' : raw;
  const changed = state.runsSearch !== next;
  state.runsSearch = next;
  $('runs-search-clear').hidden = raw.trim() === '';
  if (changed) renderList();
  if (urlish && isPasteInput(e)) openRunsSearchUrl();
}

// Paste and drop carry an inputType; typed characters and synthetic Events carry none.
const isPasteInput = (e) =>
  e?.inputType === 'insertFromDrop' || String(e?.inputType || '').startsWith('insertFromPaste');

function onRunsSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  const raw = $('runs-search').value;
  if (RunsUrl.looksLikeRunUrl(raw)) { e.preventDefault(); openRunsSearchUrl(); return; }
  // A bare id opens its run on Enter, exactly as a pasted link does.
  if (!RunsUrl.looksLikeRunId(raw)) return;
  e.preventDefault();
  openRunsSearchId(raw.trim());
}

function clearRunsSearch() {
  state.runsSearch = '';
  $('runs-search').value = '';
  $('runs-search-clear').hidden = true;
  renderList();
  $('runs-search').focus();
}

// api.js joins v2's env array into one string; split here so `env` stays one comparable string.
const envTags = (env) => String(env || '').split(',').map((s) => s.trim()).filter(Boolean);

// Every run row and folder head; Load more and the empty states stay ordinary tab stops.
const RUNS_ROW_SELECTOR = 'li[data-run-id], .group-head';

function runRow(run, { child = false, showId = false } = {}) {
  const li = document.createElement('li');
  li.className = child ? 'group-child' : 'run';
  li.dataset.runId = run.id;
  li.dataset.status = StatusIcons.normStatus(run.status);
  const head = document.createElement('div');
  head.className = 'list-head';
  head.append(StatusIcons.statusIcon(run.status));
  // status icon → type → title is the web list's own order; an unknown kind renders nothing.
  const kind = typeof TestType !== 'undefined' ? TestType.mark(StatusIcons.runKind(run.kind)) : null;
  if (kind) head.append(kind);
  // `.list-lines`: the text block a head lays out beside its marks (shared/components.css).
  const lines = document.createElement('div');
  lines.className = 'list-lines';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = run.clean_title || run.title || `Run ${run.id}`;
  lines.append(title);
  const envs = child ? envTags(run.env) : [];
  if (envs.length) {
    const meta = document.createElement('div');
    meta.className = 'meta env-tags';
    for (const name of envs) {
      const pill = document.createElement('span');
      pill.className = 'badge env';
      pill.textContent = name;
      // A pill cut off by the row width still has to be readable somewhere.
      Tooltip.set(pill, name);
      meta.append(pill);
    }
    lines.append(meta);
  }
  // Nothing else on the row names the id the by-id lookup was asked for.
  if (showId) {
    const idLine = document.createElement('div');
    idLine.className = 'meta';
    idLine.textContent = run.id;
    lines.append(idLine);
  }
  head.append(lines);
  li.append(head);
  // No status or kind on the second line: the glyph and the type mark say both.
  li.addEventListener('click', () => openRunView(run.id, run.clean_title || run.title));
  return Roving.item(li);
}

const isExpanded = (groupId) => state.expandedGroups.some((id) => String(id) === String(groupId));

// The trailing run count is drawn only when reliable — subgroup rows carry none.
function groupHead(group) {
  const head = document.createElement('div');
  // A real `.list-row`: its own rule, inset to the glyph column, with the library's padding.
  head.className = 'list-row list-head group-head tree-row has-chevron';
  // A head that folds a folder has to say whether it is open: the chevron is a picture.
  head.setAttribute('aria-expanded', String(isExpanded(group.id)));
  const chevron = StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron');
  // A v2 rungroup row may carry a project `emoji` that stands in for the folder mark.
  const folder = StatusIcons.treeIcon(StatusIcons.FOLDER, 'folder-icon', group.emoji);
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = group.clean_title || group.title || `Group ${group.id}`;
  head.append(chevron, folder, title);
  if (group.runs_count != null) {
    const count = document.createElement('span');
    // Shared trailing figure (`.row-count`, ROW TAIL in shared/components.css).
    count.className = 'row-count';
    const n = group.runs_count;
    count.textContent = `${n} ${n === 1 ? 'run' : 'runs'}`;
    head.append(count);
  }
  // No status icon: a rungroup is not a run (owner call).
  return Roving.item(head);
}

// No depth param: a subgroup nests in its parent's children, so the indent compounds on its own.
function groupShell(group) {
  const li = document.createElement('li');
  li.className = 'group tree-node';
  li.dataset.groupId = group.id;
  li.dataset.status = StatusIcons.normStatus(group.status);
  if (isExpanded(group.id)) li.classList.add('expanded');
  // Paste flash re-applied from state so it survives any re-render.
  if (String(state.highlightedGroup) === String(group.id)) li.classList.add('group-highlight');
  const head = groupHead(group);
  li.append(head);
  const kids = document.createElement('div');
  kids.className = 'group-children tree-children';
  // The class hides the rows; `hidden` also takes them out of the arrow walk and a reader's way.
  kids.hidden = !isExpanded(group.id);
  li.append(kids);
  head.addEventListener('click', () => toggleGroup(group.id, li));
  return { li, kids };
}

// Compact: a block empty state under one folder would read as the whole list collapsing.
function groupEmptyRow(loading) {
  const row = EmptyState.build({
    compact: true,
    className: 'group-empty',
    icon: loading ? LOADING_ICON : 'folder_off',
    text: loading ? 'Loading runs…' : 'No runs loaded for this group.',
  });
  if (loading) row.querySelector('.md-icon')?.classList.add('spin');
  return row;
}

// v2 has no nested subgroups, so a flat folder; `loading` keeps signature parity with the dashboard.
function groupRow(group, children, { loading = false } = {}) {
  const { li, kids } = groupShell(group);
  if (children.length) {
    for (const c of children) kids.append(runRow(c, { child: true }));
  } else {
    kids.append(groupEmptyRow(loading));
  }
  return li;
}

// Top-level groups carry the full descendant list, so a collapsed group still matches a deep run.
function groupPasses(group) {
  if (!anyRunsConstraint()) return true;
  if (groupSelfHit(group)) return true;
  const key = String(group.id);
  if ((state.descendantRuns[key] || []).some(runPasses)) return true;
  if ((state.childrenCache[key] || []).some(runPasses)) return true;
  return (state.subgroupsCache[key] || []).some((sg) => groupPasses(sg));
}

// `forceShowKids` (an ancestor's title matched) exempts contents from the search, not the chip.
function dashGroupRow(group, forceShowKids = false) {
  const constrained = anyRunsConstraint();
  if (constrained && !forceShowKids && !groupPasses(group)) return null;
  const key = String(group.id);
  const showKids = forceShowKids || (runsSearchActive() && groupTitleMatchesSearch(group));
  const childRunOk = (r) => matchesFilter(r.status) && (showKids || runMatchesSearch(r));
  const { li, kids } = groupShell(group);
  let rendered = 0;
  for (const sg of (state.subgroupsCache[key] || [])) {
    const row = dashGroupRow(sg, showKids);
    if (row) { kids.append(row); rendered += 1; }
  }
  for (const r of (state.childrenCache[key] || [])) {
    if (constrained && !childRunOk(r)) continue;
    kids.append(runRow(r, { child: true }));
    rendered += 1;
  }
  if (!rendered) {
    kids.append(groupEmptyRow(state.loadingGroup[key]
      || (isExpanded(group.id) && !groupContentsLoaded(key))));
  }
  // Also under a constraint: a filter narrowing the loaded rows must not hide that more exist.
  if (RunsPaging.groupHasMore(key)) {
    const p = state.groupPaging[key];
    const loadedHere = (state.subgroupsCache[key] || []).length + (state.childrenCache[key] || []).length;
    const totalHere = p.subsTotal == null && p.runsTotal == null ? null : (p.subsTotal || 0) + (p.runsTotal || 0);
    kids.append(loadMoreRow({
      remaining: RunsPaging.groupRemainder(key),
      loading: !!p.loading,
      loaded: loadedHere,
      total: totalHere,
      onClick: () => loadMoreGroup(key),
    }));
  }
  return li;
}

function toggleGroup(groupId, li) {
  const i = state.expandedGroups.findIndex((id) => String(id) === String(groupId));
  const expanding = i === -1;
  if (expanding) { state.expandedGroups.push(groupId); li.classList.add('expanded'); }
  else { state.expandedGroups.splice(i, 1); li.classList.remove('expanded'); }
  const kids = li.querySelector(':scope > .group-children');
  if (kids) kids.hidden = !expanding;
  const head = li.querySelector(':scope > .group-head');
  if (head) head.setAttribute('aria-expanded', String(expanding));
  persistSession();
  if (expanding && state.listMode === 'dashboard' && !groupContentsLoaded(groupId)) {
    loadGroupContents(groupId);
  }
}

function renderRuns(runs, groups = []) {
  state.lastRuns = runs;
  state.lastGroups = groups;
  const ul = $('runs-list');
  ul.replaceChildren();

  // Folder rows come from /rungroups (which is roots-only in v2), minus archived.
  const groupMap = new Map();
  for (const g of groups) if (!g.archived_at) groupMap.set(String(g.id), g);

  // A run whose rungroup_id names no known group renders top-level instead of vanishing.
  const childrenByGroup = new Map();
  const topLevel = [];
  for (const run of runs) {
    const gid = run.rungroup_id != null ? String(run.rungroup_id) : null;
    if (gid && groupMap.has(gid)) {
      if (!childrenByGroup.has(gid)) childrenByGroup.set(gid, []);
      childrenByGroup.get(gid).push(run);
    } else {
      topLevel.push(run);
    }
  }

  // Pruned BEFORE render, so restored/URL-driven expansions of live groups survive.
  const present = new Set(groupMap.keys());
  state.expandedGroups = state.expandedGroups.filter((id) => present.has(String(id)));

  const constrained = anyRunsConstraint();
  let shown = 0;
  for (const g of groupMap.values()) {
    const allKids = childrenByGroup.get(String(g.id)) || [];
    const titleHit = runsSearchActive() && groupTitleMatchesSearch(g);
    const kids = constrained
      ? allKids.filter((c) => matchesFilter(c.status) && (titleHit || runMatchesSearch(c)))
      : allKids;
    if (constrained && !(groupSelfHit(g) || kids.length)) continue;
    ul.append(groupRow(g, kids));
    shown += 1;
  }
  for (const run of topLevel) {
    if (constrained && !runPasses(run)) continue;
    ul.append(runRow(run));
    shown += 1;
  }

  finishRunsRender(ul, { loaded: groupMap.size + topLevel.length, shown, constrained });
}

// No-match goes before the load-more row, its footnote ("only page 1 was searched").
function finishRunsRender(ul, { loaded, shown, constrained }) {
  // The <ul> outlives both renderers' replaceChildren(), so the keyboard is wired once.
  Roving.attach(ul, { selector: RUNS_ROW_SELECTOR });
  if (!loaded) { renderRunsEmptyCta(ul); renderFilterChips(); return; }
  // Nothing loaded answered an id-shaped query: look the run up directly.
  const probeId = constrained && !shown ? RunsUrl.searchRunId() : null;
  syncRunIdProbe(probeId);
  if (constrained && !shown) {
    const probe = probeId ? runIdProbeFor(probeId) : null;
    if (probe?.run) ul.append(...foundByIdRows(probe.run));
    else ul.append(runsNoMatchEmpty(!!probe && !probe.pending));
  }
  renderTopLoadMore(ul);
  renderFilterChips();
  setStatusLine('runs-status', '');
}

// Stays put under an active constraint, so a filtered-empty list still admits it searched page 1.
function renderTopLoadMore(ul) {
  const cursor = RunsPaging.listCursor();
  if (!RunsPaging.hasNextPage(cursor) && !cursor?.loading) return;
  const loaded = RunsPaging.listLoadedCount();
  ul.append(loadMoreRow({
    remaining: RunsPaging.remainderOf(cursor, loaded),
    loading: !!cursor.loading,
    loaded,
    total: cursor.total,
    onClick: loadMoreRuns,
  }));
}

// Counts and filters stay client-side; a not-yet-expanded group falls back to its own status.
function renderDashboard() {
  const ul = $('runs-list');
  ul.replaceChildren();

  // Countable set deduped by id: the same run appears in several caches.
  const byId = new Map();
  for (const it of state.dashItems) if (it.type === 'run') byId.set(String(it.id), it);
  for (const runs of Object.values(state.descendantRuns)) for (const r of runs) byId.set(String(r.id), r);
  for (const runs of Object.values(state.childrenCache)) for (const r of runs) byId.set(String(r.id), r);
  state.lastRuns = [...byId.values()];
  state.lastGroups = state.dashItems.filter((it) => it.type === 'rungroup');

  const constrained = anyRunsConstraint();
  let shown = 0;
  for (const it of state.dashItems) {
    if (it.type === 'rungroup') {
      const row = dashGroupRow(it);
      if (row) { ul.append(row); shown += 1; }
    } else {
      if (constrained && !runPasses(it)) continue;
      ul.append(runRow(it));
      shown += 1;
    }
  }

  finishRunsRender(ul, { loaded: state.dashItems.length, shown, constrained });
}

// A truly empty project only; a filter-emptied list gets runsNoMatchEmpty.
function renderRunsEmptyCta(ul) {
  const s = state.settings || {};
  const actions = [];
  if (s.baseUrl && s.projectId) {
    const a = document.createElement('a');
    a.className = 'btn primary size-sm';
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/new`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(StatusIcons.svgIcon('add', 16), document.createTextNode('New run'));
    actions.push(a);
  }
  const paste = document.createElement('button');
  paste.type = 'button';
  paste.className = 'btn size-sm';
  paste.textContent = 'Paste a run URL';
  paste.addEventListener('click', () => $('runs-search')?.focus());
  actions.push(paste);

  EmptyState.into(ul, {
    icon: 'play_arrow',
    title: 'No runs yet',
    text: 'Start a manual run in Testomat and it appears here. Already have a link to one? Paste it in the search above.',
    actions,
  });
  setStatusLine('runs-status', '');
}

// `live`: it takes over the status line's aria-live job; `idMiss`: the by-id lookup missed too.
function runsNoMatchEmpty(idMiss = false) {
  const actions = [];
  if (runsSearchActive()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Clear search';
    b.addEventListener('click', clearRunsSearch);
    actions.push(b);
  }
  if (runsFilterActive()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Show all runs';
    b.addEventListener('click', () => setRunsFilter('all'));
    actions.push(b);
  }
  return EmptyState.build({
    tag: 'li',
    live: true,
    icon: runsSearchActive() ? 'search_off' : 'filter_alt_off',
    title: runsEmptyMessage(),
    text: runsSearchActive()
      ? (idMiss
        ? 'Nothing loaded matches what you typed, and no run in the project has this id.'
        : 'Nothing in the loaded runs matches what you typed.')
      : 'Nothing loaded so far carries this status.',
    actions,
  });
}

// Probed first, so a bad id or a no-access run leaves the user on the list, not a half-drawn run.
async function openParsedRunTarget(target) {
  // The group path shows the runs list before anything can fail, so it always lands.
  if (target.kind === 'group') { await openGroupFromUrl(target.id); return true; }
  let detail;
  try { detail = await TestomatAPI.getRun(target.id); }
  catch (e) {
    if (e?.kind === 'notfound') { RunsUrl.reportNotFound(); return false; }
    handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
    return false;
  }
  resetRunsSearch();
  openRunView(target.id, detail?.clean_title || detail?.title);
  return true;
}

async function openRunsSearchUrl() {
  const target = RunsUrl.parse($('runs-search').value);
  if (!target) { RunsUrl.reportNotFound(); return; }
  await openParsedRunTarget(target);
}

// "Run in Extension" from the web app; true when it landed the panel on a view, else boot restores.
async function openRunFromUrl(url) {
  const parts = RunsUrl.parseParts(url);
  if (!parts) { RunsUrl.reportNotFound(); return false; }
  let cfgHost = null;
  try { cfgHost = new URL(state.settings.baseUrl).hostname; } catch { /* not connected yet */ }
  if (!cfgHost || parts.host !== cfgHost) {
    fillSettingsForm();
    show('settings');
    setStatusLine('settings-status', cfgHost
      ? `This panel is connected to ${cfgHost}, and that run lives on ${parts.host} — connect to it to open the run here`
      : `Connect this panel to ${parts.host} to open that run here`, 'error');
    return true;
  }
  if (parts.projectId !== state.settings.projectId) {
    // The boot refresh runs in the background, so an empty list is "not loaded yet", not "no projects".
    const known = state.projects.length ? state.projects : await refreshProjects();
    if (!known.some((p) => p.id === parts.projectId)) {
      toast(`No access to project ${parts.projectId}`, { error: true });
      return false;
    }
    await switchProject(parts.projectId);
  }
  return openParsedRunTarget(parts);
}

// URL intent wins over any active filter or search: both reset before the group is shown.
async function openGroupFromUrl(groupId) {
  state.runsFilter = 'all';
  resetRunsSearch();
  persistSession();
  show('runs');
  renderFilterChips();
  setStatusLine('runs-status', 'Loading runs…');
  $('runs-list').replaceChildren();
  try { await loadRuns(); }
  catch (e) { handleApiError(e, 'runs-status'); return; }
  renderList();
  await ensureExpandedChildrenLoaded(); // hydrate any restored expansions first

  // A root group past page 1 is pulled in first rather than reported missing.
  await ensureTopLevelGroupLoaded(groupId);
  const top = findGroupById(groupId);
  if (top) {
    await expandGroupChain([top.id]);
    highlightGroup(top.id);
    return;
  }
  // Nested: the show payload's `path` is root-first and excludes self, so levels expand first.
  if (state.listMode === 'dashboard') {
    let detail;
    try { detail = await TestomatAPI.getRunGroup(groupId); }
    catch (e) {
      renderList();
      if (e?.kind === 'notfound') RunsUrl.reportNotFound();
      else handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
      return;
    }
    const chain = (detail.path || []).filter((id) => String(id) !== String(groupId));
    chain.push(groupId);
    await expandGroupChain(chain);
    if (renderedGroupRow(groupId)) highlightGroup(groupId);
    else RunsUrl.reportNotFound();
    return;
  }
  RunsUrl.reportNotFound();
}

function findGroupById(groupId) {
  if (state.listMode === 'dashboard') {
    return state.dashItems.find((it) => it.type === 'rungroup' && String(it.id) === String(groupId));
  }
  return (state.lastGroups || []).find((g) => String(g.id) === String(groupId) && !g.archived_at);
}

const renderedGroupRow = (groupId) =>
  [...$('runs-list').querySelectorAll('li.group')].find((li) => String(li.dataset.groupId) === String(groupId));

let highlightTimer = null;
function highlightGroup(groupId) {
  const row = renderedGroupRow(groupId);
  if (!row) { state.highlightedGroup = null; return; }
  state.highlightedGroup = String(groupId); // state-driven so re-renders keep it
  row.classList.add('group-highlight');
  row.scrollIntoView({ block: 'center' });
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    state.highlightedGroup = null;
    renderedGroupRow(groupId)?.classList.remove('group-highlight');
  }, 2500);
}

// An id no loaded row answers is read straight off /runs/{id}: it may sit deep in a folder.

// Long enough that the read waits for the typing to stop.
const RUN_ID_PROBE_MS = 500;

// One probe kept; a settled `run: null` means no such run, and `epoch` voids it on a project switch.
let runIdProbe = null;
let runIdProbeTimer = null;
let runIdProbeToken = 0; // strands a read whose query is no longer the one on screen

const runIdProbeFor = (query) =>
  (runIdProbe && runIdProbe.query === query && runIdProbe.epoch === state.projectEpoch
    ? runIdProbe
    : null);

// Arms the read for a fresh id-shaped miss and strands the pending one once the query changes.
function syncRunIdProbe(query) {
  if (query && runIdProbeFor(query)) return; // settled, or already on the wire
  clearTimeout(runIdProbeTimer);
  runIdProbeTimer = null;
  runIdProbeToken += 1;
  if (runIdProbe?.pending) runIdProbe = null;
  if (!query) return;
  const token = runIdProbeToken;
  runIdProbeTimer = setTimeout(() => probeRunById(query, token), RUN_ID_PROBE_MS);
}

async function probeRunById(query, token) {
  runIdProbeTimer = null;
  if (token !== runIdProbeToken) return;
  const epoch = state.projectEpoch;
  runIdProbe = { query, epoch, pending: true, run: null };
  let run = null;
  try {
    run = await TestomatAPI.getRun(query);
  } catch (e) {
    // Quiet, as it fires on a typing pause: only a definite miss is remembered; blips stay retryable.
    if (e?.kind !== 'notfound') { if (token === runIdProbeToken) runIdProbe = null; return; }
  }
  if (token !== runIdProbeToken || staleProject(epoch) || state.runsSearch.trim() !== query) return;
  runIdProbe = { query, epoch, pending: false, run };
  if (state.view === 'runs') renderList();
}

// An explicit id ask outranks the status chip, so the row shows even when the filter would hide it.
function foundByIdRows(run) {
  const label = document.createElement('li');
  label.className = 'found-by-id';
  label.textContent = 'Found by id';
  return [label, runRow(run, { showId: true })];
}

// Probed first, like the URL path — a bad id leaves the user on the list with a toast.
async function openRunsSearchId(id) {
  let detail;
  try { detail = await TestomatAPI.getRun(id); }
  catch (e) {
    if (e?.kind === 'notfound') { RunsUrl.reportNotFound(); return; }
    handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
    return;
  }
  resetRunsSearch();
  openRunView(id, detail?.clean_title || detail?.title);
}
