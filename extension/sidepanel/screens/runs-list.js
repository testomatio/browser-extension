// Runs-list screen: dashboard/v2 runs plus rungroup folders, status-filter chips,
// refresh, lazy nested loading, and run/group URL paste.

/* global TestomatAPI, Skeleton, Tooltip, EmptyState, TestType */

// ---------- runs list ----------

// Single-select; `launching` folds into Running. Order matters: fitFilterChips
// (core/views.js) hides the RIGHTMOST chips first when the row runs out of room.
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
const matchesFilter = (status) => state.runsFilter === 'all' || normStatus(status) === state.runsFilter;

// Live title search over runs + group titles, ANDed with the status chip. A group
// matching the SEARCH reveals all its status-passing contents.
const runsSearchActive = () => state.runsSearch.trim() !== '';
const runsFilterActive = () => state.runsFilter !== 'all';
const anyRunsConstraint = () => runsSearchActive() || runsFilterActive();
const titleOf = (item) => (item.clean_title || item.title || '').toLowerCase();
const searchNeedle = () => state.runsSearch.trim().toLowerCase();
// #57: a run answers to its id as well as its title — pasted from a URL or a CI log.
// Folders keep matching by title only; an id belongs to a run.
const runMatchesSearch = (run) =>
  !runsSearchActive()
  || titleOf(run).includes(searchNeedle())
  || String(run.id || '').toLowerCase().includes(searchNeedle());
const groupTitleMatchesSearch = (group) => !runsSearchActive() || titleOf(group).includes(searchNeedle());
const runPasses = (run) => matchesFilter(run.status) && runMatchesSearch(run);
const groupSelfHit = (group) => matchesFilter(group.status) && groupTitleMatchesSearch(group);
const runsEmptyMessage = () =>
  (runsSearchActive() ? 'No runs match' : `No ${filterLabel(state.runsFilter).toLowerCase()} runs`);

// v2 index response → paging cursor: totalPages is derived, because v2 reports a
// row total and no page count.
function v2Cursor(res, page) {
  const meta = res?.meta || {};
  const perPage = Number(meta.per_page) || (res?.data || []).length || 1;
  const total = meta.total != null ? Number(meta.total) : null;
  return {
    page: Number(meta.page) || page,
    perPage,
    total,
    totalPages: total != null ? Math.max(1, Math.ceil(total / perPage)) : null,
  };
}

// Degraded fallback: page 1 of runs + rungroups. Both cursors are kept so the
// shared "Load more" can advance whichever source still has a tail.
async function fetchRunsData(page = 1) {
  const [runsRes, groupsRes] = await Promise.all([
    TestomatAPI.listRuns(page),
    TestomatAPI.listRunGroups(page),
  ]);
  return {
    runs: runsRes?.data || [],
    groups: groupsRes?.data || [],
    runsCursor: v2Cursor(runsRes, page),
    groupsCursor: v2Cursor(groupsRes, page),
  };
}

// Dashboard page 1 when a JWT session exists (single source, web order, branched
// scope); falls back to the degraded v2 fetch only when it does not.
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
    // The session is proven right here, and both caches memoize on success — so a run
    // opened a moment later paints the member names and the viewer's own timezone in
    // its FIRST frame, instead of the probe repainting both a round trip later.
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
      state.listPaging = v2ListPaging();
      state.descendantsSettled = true; // v2 flat list is already complete
    } else {
      throw e; // genuine error under a working session — surface it
    }
  }
}

// v2 folds two independently paged sources: more rows exist while EITHER has a
// next page.
function v2ListPaging(loading = false) {
  const r = state.v2RunsPaging || {};
  const g = state.v2GroupsPaging || {};
  const totals = [r.total, g.total];
  return {
    page: Math.max(r.page || 1, g.page || 1),
    total: totals.every((t) => t != null) ? totals.reduce((a, b) => a + b, 0) : null,
    totalPages: Math.max(r.totalPages || 1, g.totalPages || 1),
    loading,
  };
}

// Every top-level group's descendant runs (any depth, nested=true), fetched up
// front so the chip counts are complete before any folder is expanded.
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
  // The tab count chip is NOT set here — loadRunsCount() owns it, so it never
  // moves with "Load more", a search keystroke or a descendant settle.
}

// Runs tab chip (#127): the PROJECT's run total off /runs — no folder rows to
// miscount and no JWT needed. Writes NOTHING into state; failure leaves it absent.
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

// A project switch clears the query in state (resetProjectScopedState) behind the
// input's back, so the field is read FROM state rather than trusted to hold it.
function syncRunsSearchInput() {
  const input = $('runs-search');
  if (!input) return;
  if (input.value !== state.runsSearch) input.value = state.runsSearch;
  if ($('runs-search-clear')) $('runs-search-clear').hidden = state.runsSearch.trim() === '';
}

// #157: the route is /runs/new — /runs/newrun is a dead web route that stacks the
// run player under the list and POSTs a blank run on every visit.
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
  // The rows this project already read are painted AT ONCE and re-read behind them.
  // Coming back from a run they never left memory, and clearing the list to fetch the
  // same ones again is what put an empty screen in front of the tester for 150ms.
  const inMemory = state.listMode === 'dashboard' ? state.dashItems?.length : state.lastRuns?.length;
  if (inMemory) {
    show('runs');
    renderNewRunLink();         // href tracks the active host + project (#118)
    syncRunsSearchInput();      // the query outlives leaving the screen, a project switch clears it
    renderFilterChips();
    renderList();
    loadRunsCount(state.projectEpoch); // tab chip only — never blocks the list
    // #155: still gated, but the lockout REPLACES what is up — nothing is blanked for it.
    if (await readonlyGate()) { applyReadonlyBlock(); return; }
    await refreshRuns();        // the re-read, behind the rows already on screen
    return;
  }
  show('runs');
  // Nothing to show from memory (first open, or a project switch emptied it), so the
  // placeholder is drawn — BEFORE the read-only probe, which is its own round trip.
  const sk = Skeleton.show('runs');
  // #155: settle the read-only probe BEFORE any list request — a locked project
  // must not flash a runs list it is about to replace with the blocking panel.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  renderNewRunLink();           // href tracks the active host + project (#118)
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

// The runs list's HALF of a refresh — refreshAll() (core/views.js) owns the
// button's disabled/spinning state. On failure the previous list stays.
async function refreshRuns() {
  try {
    await loadRuns();
    renderList();
    await ensureExpandedChildrenLoaded();
  } catch (e) {
    // #155: access turning read-only mid-session is a lockout, not a failed
    // refresh — repaint into the blocking panel instead of toasting.
    if (isReadonlyError(e)) { applyCapabilities(); return; }
    setStatusLine('runs-status', `Refresh failed: ${e.message || e}`, 'error');
    toast(`Refresh failed: ${e.message || e}`);
  }
}

const childrenLoaded = (groupId) => Array.isArray(state.childrenCache[String(groupId)]);
const groupContentsLoaded = (groupId) =>
  childrenLoaded(groupId) && Array.isArray(state.subgroupsCache[String(groupId)]);

// Lazy first-expansion load, cached per refresh. A failed leg caches [] + toasts,
// so the empty state shows and it is not retried until the next refresh.
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
  // Both cursors in one record — the folder shows ONE "Load more" for all its
  // contents, advancing whichever of the two still has a page (#110).
  state.groupPaging[key] = {
    subsPage: subs?.page || 1, subsTotal: subs?.total ?? null, subsTotalPages: subs?.totalPages ?? null,
    runsPage: runs?.page || 1, runsTotal: runs?.total ?? null, runsTotalPages: runs?.totalPages ?? null,
    runsPerPage: runs?.perPage ?? null,
    loading: false,
  };
  if (subs === null || runs === null) toast('Could not load some group contents');
  delete state.loadingGroup[key];
  renderList();
}

// ---------- "Load more" (#110) ----------
// Deliberately not infinite scroll: the panel's one shared scroll container
// (collapsed folders, paste-flash scrollIntoView) makes bottom-reach races.

function remainderOf(cursor, loadedCount) {
  if (!cursor || cursor.total == null) return null;
  return Math.max(0, cursor.total - loadedCount);
}
const hasNextPage = (cursor) => !!cursor && cursor.totalPages != null && (cursor.page || 1) < cursor.totalPages;

function listCursor() {
  return state.listMode === 'dashboard' ? state.listPaging : v2ListPaging(state.listPaging?.loading);
}
const listLoadedCount = () =>
  (state.listMode === 'dashboard'
    ? state.dashItems.length
    : (state.lastRuns || []).length + (state.lastGroups || []).length);

// Rows land first; the nested descendant counts for groups this page brought in
// settle right after, repainting the chips.
async function loadMoreRuns() {
  const cursor = listCursor();
  if (!cursor || cursor.loading || !hasNextPage(cursor)) return;
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
      const runsNext = hasNextPage(state.v2RunsPaging) ? next : null;
      const groupsNext = hasNextPage(state.v2GroupsPaging) ? next : null;
      const [runsRes, groupsRes] = await Promise.all([
        runsNext ? TestomatAPI.listRuns(runsNext) : null,
        groupsNext ? TestomatAPI.listRunGroups(groupsNext) : null,
      ]);
      if (staleProject(epoch) || state.listMode !== 'v2') return;
      if (runsRes) {
        state.lastRuns = [...(state.lastRuns || []), ...(runsRes.data || [])];
        state.v2RunsPaging = v2Cursor(runsRes, runsNext);
      }
      if (groupsRes) {
        state.lastGroups = [...(state.lastGroups || []), ...(groupsRes.data || [])];
        state.v2GroupsPaging = v2Cursor(groupsRes, groupsNext);
      }
      state.listPaging = v2ListPaging();
      renderList();
    }
  } catch (e) {
    state.listPaging = { ...cursor, loading: false };
    renderList();
    toast(`Could not load more runs: ${e.message || e}`, { error: true });
  }
}

// Next page of ONE folder's contents — subgroups first, then runs (render order).
async function loadMoreGroup(groupId) {
  const key = String(groupId);
  const p = state.groupPaging[key];
  if (!p || p.loading || !groupHasMore(key)) return;
  const epoch = state.projectEpoch;
  state.groupPaging[key] = { ...p, loading: true };
  renderList();
  const subsNext = hasNextPage({ page: p.subsPage, totalPages: p.subsTotalPages }) ? p.subsPage + 1 : null;
  const runsNext = hasNextPage({ page: p.runsPage, totalPages: p.runsTotalPages }) ? p.runsPage + 1 : null;
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

function groupHasMore(groupId) {
  const p = state.groupPaging[String(groupId)];
  if (!p) return false;
  return hasNextPage({ page: p.subsPage, totalPages: p.subsTotalPages })
    || hasNextPage({ page: p.runsPage, totalPages: p.runsTotalPages });
}

function groupRemainder(groupId) {
  const key = String(groupId);
  const p = state.groupPaging[key];
  if (!p || (p.subsTotal == null && p.runsTotal == null)) return null;
  const subs = remainderOf({ total: p.subsTotal }, (state.subgroupsCache[key] || []).length);
  const runs = remainderOf({ total: p.runsTotal }, (state.childrenCache[key] || []).length);
  if (subs == null && runs == null) return null;
  return (subs || 0) + (runs || 0);
}

// The "M of T loaded" note shows only under an active constraint — the filter
// searched just the loaded rows, and must say so.
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
  // One class PER ARGUMENT: Icons.el feeds them to classList.add, which throws on a token holding a space (#215).
  if (loading) btn.append(svgIcon(LOADING_ICON, 14, 'spin', 'load-more-spinner'));
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

// Walks nested chains until no further progress, then prunes expansion state for
// ids no longer anywhere in the tree.
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
    // The next link may sit on a LATER subgroup page (#110) — pull pages until
    // its row exists, else the paste target never renders.
    if (ids[i + 1] != null) await ensureSubgroupLoaded(id, ids[i + 1]);
  }
  renderList();
}

// Bounded page-pulling until `childId`'s row exists; only the URL-paste path pays.
async function ensureSubgroupLoaded(parentId, childId) {
  const key = String(parentId);
  const has = () => (state.subgroupsCache[key] || []).some((sg) => String(sg.id) === String(childId));
  for (let guard = 0; guard < 50 && !has() && groupHasMore(key); guard++) {
    await loadMoreGroup(key);
  }
}

// A ROOT group pasted by URL may live past page 1 of the list.
async function ensureTopLevelGroupLoaded(groupId) {
  for (let guard = 0; guard < 20; guard++) {
    if (findGroupById(groupId)) return true;
    if (!hasNextPage(listCursor())) return false;
    await loadMoreRuns();
  }
  return false;
}

// Runs only — folders are never counted; `launching` folds into running.
function statusCounts(runs) {
  const counts = { all: runs.length, running: 0, passed: 0, failed: 0, scheduled: 0, terminated: 0 };
  for (const r of runs) {
    const s = normStatus(r.status);
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

// The row is UPDATED, not rebuilt: rebuilding the six buttons per render (this
// runs on every list render) re-measures the row and the chips visibly jump.
function renderFilterChips() {
  const bar = $('runs-filter');
  if (!bar) return;
  // Until the nested fetches settle the loaded set is a lower bound that would count
  // UP as folders land. A FIRST read has nothing better and rests at 0 (tab chips
  // instead stay absent); a RE-read keeps the last settled numbers up — dropping them
  // to zero and climbing back is the flicker every Back would otherwise show.
  const pending = state.listMode === 'dashboard' && !state.descendantsSettled;
  // Failed legs: the loaded set is a lower bound, so counts get a trailing "+".
  const settledPartial = state.listMode === 'dashboard' && state.descendantsSettled && state.descendantsPartial;
  const fresh = statusCounts(state.lastRuns || []);
  const held = pending ? state.runsChipCounts : null; // null on a first read — nothing settled yet
  if (!pending) state.runsChipCounts = { counts: fresh, partial: settledPartial };
  const counts = held ? held.counts : fresh;
  // The tooltip follows whatever the chips SHOW, so it is the snapshot's flag while
  // the snapshot is the thing on screen.
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

// One input, two jobs (#106): title search, unless the value is URL-shaped. A
// PASTED url opens at once; a typed one waits for Enter (half-typed ids).
function onRunsSearch(e) {
  const raw = $('runs-search').value;
  const urlish = looksLikeRunUrl(raw);
  const next = urlish ? '' : raw;
  const changed = state.runsSearch !== next;
  state.runsSearch = next;
  $('runs-search-clear').hidden = raw.trim() === '';
  if (changed) renderList();
  if (urlish && isPasteInput(e)) openRunsSearchUrl();
}

// Paste/drop arrive as one input event carrying inputType; typed characters and
// synthetic Events carry none.
const isPasteInput = (e) =>
  e?.inputType === 'insertFromDrop' || String(e?.inputType || '').startsWith('insertFromPaste');

function onRunsSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  const raw = $('runs-search').value;
  if (looksLikeRunUrl(raw)) { e.preventDefault(); openRunsSearchUrl(); return; }
  // #57: a bare id opens its run on Enter, exactly as a pasted link does.
  if (!looksLikeRunId(raw)) return;
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

// api.js joins v2's env array into ONE string; the split lives here, in the row
// that draws the pills, so `env` stays one comparable string everywhere else.
const envTags = (env) => String(env || '').split(',').map((s) => s.trim()).filter(Boolean);

function runRow(run, { child = false, showId = false } = {}) {
  const li = document.createElement('li');
  li.className = child ? 'group-child' : 'run';
  li.dataset.runId = run.id;
  li.dataset.status = normStatus(run.status);
  const head = document.createElement('div');
  head.className = 'list-head';
  head.append(statusIcon(run.status));
  // status icon → type → title is the web list's own order (list-runs.hbs). The
  // shared `.type-mark` carries the word on its tooltip; unknown kind renders nothing.
  const kind = typeof TestType !== 'undefined' ? TestType.mark(runKind(run.kind)) : null;
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
  // #57: nothing else on the row names the id the by-id lookup was asked for.
  if (showId) {
    const idLine = document.createElement('div');
    idLine.className = 'meta';
    idLine.textContent = run.id;
    lines.append(idLine);
  }
  head.append(lines);
  li.append(head);
  // No status or kind on the second line — the glyph and the type mark say both (#111).
  li.addEventListener('click', () => openRunView(run.id, run.clean_title || run.title));
  return li;
}

const isExpanded = (groupId) => state.expandedGroups.some((id) => String(id) === String(groupId));

// The trailing run count is drawn only when reliable — subgroup rows carry none.
function groupHead(group) {
  const head = document.createElement('div');
  // A real `.list-row` — its own rule, inset to the glyph column by
  // `tree-row has-chevron`, and the library's padding rather than its own.
  head.className = 'list-row list-head group-head tree-row has-chevron';
  const chevron = treeIcon(CHEVRON_ICON, 'chevron');
  // A v2 rungroup row may carry a project `emoji` that stands in for the folder mark.
  const folder = treeIcon(FOLDER_ICON, 'folder-icon', group.emoji);
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
  return head;
}

// Nesting needs no depth param — a subgroup <li> goes into its parent's children
// container, so the `.tree-children` indent compounds on its own (style.css).
function groupShell(group) {
  const li = document.createElement('li');
  li.className = 'group tree-node';
  li.dataset.groupId = group.id;
  li.dataset.status = normStatus(group.status);
  if (isExpanded(group.id)) li.classList.add('expanded');
  // Paste flash re-applied from state so it survives any re-render.
  if (String(state.highlightedGroup) === String(group.id)) li.classList.add('group-highlight');
  const head = groupHead(group);
  li.append(head);
  const kids = document.createElement('div');
  kids.className = 'group-children tree-children';
  li.append(kids);
  head.addEventListener('click', () => toggleGroup(group.id, li));
  return { li, kids };
}

// Compact: a block empty state indented under one folder would read as the whole
// list collapsing. `.group-empty` is what carries the child-row indentation.
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

// v2 (degraded): a flat folder, v2 has no nested subgroups. `loading` is unused
// here — kept for signature parity with the dashboard renderer.
function groupRow(group, children, { loading = false } = {}) {
  const { li, kids } = groupShell(group);
  if (children.length) {
    for (const c of children) kids.append(runRow(c, { child: true }));
  } else {
    kids.append(groupEmptyRow(loading));
  }
  return li;
}

// Top-level groups carry the full nested descendant list, so a COLLAPSED group
// still matches a deep run; subgroups only have their lazily-loaded caches.
function groupPasses(group) {
  if (!anyRunsConstraint()) return true;
  if (groupSelfHit(group)) return true;
  const key = String(group.id);
  if ((state.descendantRuns[key] || []).some(runPasses)) return true;
  if ((state.childrenCache[key] || []).some(runPasses)) return true;
  return (state.subgroupsCache[key] || []).some((sg) => groupPasses(sg));
}

// Recursive, any depth; subgroups before runs. `forceShowKids` (an ancestor's
// title matched the search) exempts contents from SEARCH, not from the chip.
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
  // Rendered under an active constraint too — a filter narrowing the LOADED rows
  // must not hide the fact that more exist (#110).
  if (groupHasMore(key)) {
    const p = state.groupPaging[key];
    const loadedHere = (state.subgroupsCache[key] || []).length + (state.childrenCache[key] || []).length;
    const totalHere = p.subsTotal == null && p.runsTotal == null ? null : (p.subsTotal || 0) + (p.runsTotal || 0);
    kids.append(loadMoreRow({
      remaining: groupRemainder(key),
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

  // A run whose rungroup_id names no KNOWN group (nested subgroup, absent from
  // v2's roots-only list) renders top-level instead of vanishing.
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

// Order matters — the no-match state goes in BEFORE the load-more row, which is
// a footnote to it ("only page 1 was searched"), not a sibling.
function finishRunsRender(ul, { loaded, shown, constrained }) {
  if (!loaded) { renderRunsEmptyCta(ul); renderFilterChips(); return; }
  // #57: nothing loaded answered an id-shaped query — look the run up directly.
  const probeId = constrained && !shown ? runsSearchRunId() : null;
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

// Stays put under an active search/status chip, so a filtered-empty list still
// admits it only searched page 1.
function renderTopLoadMore(ul) {
  const cursor = listCursor();
  if (!hasNextPage(cursor) && !cursor?.loading) return;
  const loaded = listLoadedCount();
  ul.append(loadMoreRow({
    remaining: remainderOf(cursor, loaded),
    loading: !!cursor.loading,
    loaded,
    total: cursor.total,
    onClick: loadMoreRuns,
  }));
}

// Interleaved runs+rungroups in web order. Counts/filters stay client-side over
// the loaded set; a not-yet-expanded group falls back to its own status.
function renderDashboard() {
  const ul = $('runs-list');
  ul.replaceChildren();

  // Countable set: top-level runs + nested descendants + lazily-loaded children,
  // DEDUPED by id — the same run appears in several caches.
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

// A truly empty project only — a filter-emptied list is runsNoMatchEmpty below.
// The primary action targets /runs/new, not the runs index.
function renderRunsEmptyCta(ul) {
  const s = state.settings || {};
  const actions = [];
  if (s.baseUrl && s.projectId) {
    const a = document.createElement('a');
    a.className = 'btn primary size-sm';
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/new`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(svgIcon('add', 16), document.createTextNode('New run'));
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

// Rows exist, none survived the chip + search. Marked `live` — it took over the
// status line's aria-live job. `idMiss`: the by-id lookup came back empty too (#57).
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

// One message for every unresolvable link (#106) — wrong host, wrong project,
// unknown id, no access. Deliberately blunt: no offer to switch project.
const RUN_NOT_FOUND = 'Run not found';

// A scheme, or the bare `host/projects/…/runs/…` shape copied from the address
// bar. Must stay narrow — a URL-shaped value is never used as a title filter.
function looksLikeRunUrl(raw) {
  const v = String(raw || '').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\//i.test(v) || /\/projects\/[^/]+\/runs\//.test(v);
}

// Resolved against the configured host + project; null for anything else.
function parseRunsUrl(raw) {
  const v = String(raw || '').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
  let cfgHost;
  try { cfgHost = new URL(state.settings.baseUrl).hostname; } catch { return null; }
  if (u.hostname !== cfgHost) return null;
  // Group shape first — the run pattern would capture the literal "groups" as an id.
  const gm = u.pathname.match(/\/projects\/([^/]+)\/runs\/groups\/([^/]+)/);
  if (gm) return gm[1] === state.settings.projectId ? { kind: 'group', id: gm[2] } : null;
  // The web's "Copy url" slugs the run segment (`<uid>-<kebab-title>`) and its
  // route reads back only `id.split('-')[0]` — mirror it or every copied link 404s.
  const rm = u.pathname.match(/\/projects\/([^/]+)\/runs\/([^/]+)/);
  if (rm) return rm[1] === state.settings.projectId ? { kind: 'run', id: rm[2].split('-')[0] } : null;
  return null;
}

// The run is probed first, so a bad id or a no-access run leaves the user on the
// list with a toast instead of in a half-rendered run view.
async function openRunsSearchUrl() {
  const target = parseRunsUrl($('runs-search').value);
  if (!target) { toast(RUN_NOT_FOUND, { error: true }); return; }
  if (target.kind === 'group') { openGroupFromUrl(target.id); return; }
  let detail;
  try { detail = await TestomatAPI.getRun(target.id); }
  catch (e) {
    if (e?.kind === 'notfound') { toast(RUN_NOT_FOUND, { error: true }); return; }
    handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
    return;
  }
  resetRunsSearch();
  openRunView(target.id, detail?.clean_title || detail?.title);
}

// URL intent wins over any active filter/search: both reset, then the group is
// expanded, highlighted and scrolled into view.
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
  // Nested (dashboard only): the show payload's `path` is root-first and
  // excludes self, so each level is expanded before the target.
  if (state.listMode === 'dashboard') {
    let detail;
    try { detail = await TestomatAPI.getRunGroup(groupId); }
    catch (e) {
      renderList();
      if (e?.kind === 'notfound') toast(RUN_NOT_FOUND, { error: true });
      else handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
      return;
    }
    const chain = (detail.path || []).filter((id) => String(id) !== String(groupId));
    chain.push(groupId);
    await expandGroupChain(chain);
    if (renderedGroupRow(groupId)) highlightGroup(groupId);
    else toast(RUN_NOT_FOUND, { error: true });
    return;
  }
  toast(RUN_NOT_FOUND, { error: true });
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

// ---------- find a run by id (#57) ----------
// The search reaches only the loaded rows, so an id that none of them answers is read
// straight off /runs/{id} — the run may sit deep in a folder or far down the list.

// Real ids are 8 hex chars; 6–12 tolerates a trimmed or over-copied paste. A bare id
// can never be URL-shaped, so the two search intents cannot collide.
const looksLikeRunId = (raw) => /^[0-9a-f]{6,12}$/i.test(String(raw || '').trim());
const runsSearchRunId = () => (looksLikeRunId(state.runsSearch) ? state.runsSearch.trim() : null);

// Long enough that the read waits for the typing to stop.
const RUN_ID_PROBE_MS = 500;

// The one probe kept: { query, epoch, pending, run }; a settled `run: null` = no such run.
// Re-renders repaint it; only a NEW query reads again, and `epoch` voids it on a project switch.
let runIdProbe = null;
let runIdProbeTimer = null;
let runIdProbeToken = 0; // strands a read whose query is no longer the one on screen

const runIdProbeFor = (query) =>
  (runIdProbe && runIdProbe.query === query && runIdProbe.epoch === state.projectEpoch
    ? runIdProbe
    : null);

// Every render passes through here: it arms the read for a fresh id-shaped miss, and
// strands the pending one the moment the query stops being one.
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
    // Quiet on purpose (fires on a keystroke pause): only a definite miss is remembered,
    // a network or auth blip stays retryable.
    if (e?.kind !== 'notfound') { if (token === runIdProbeToken) runIdProbe = null; return; }
  }
  if (token !== runIdProbeToken || staleProject(epoch) || state.runsSearch.trim() !== query) return;
  runIdProbe = { query, epoch, pending: false, run };
  if (state.view === 'runs') renderList();
}

// Stands in for the empty state: an explicit id ask outranks the status chip, so the
// row appears even when the filter would have hidden it.
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
    if (e?.kind === 'notfound') { toast(RUN_NOT_FOUND, { error: true }); return; }
    handleApiError(e, 'runs-status'); // network/auth/http — the real reason wins
    return;
  }
  resetRunsSearch();
  openRunView(id, detail?.clean_title || detail?.title);
}
