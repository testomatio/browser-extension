// Runs-list screen: dashboard/v2 runs plus rungroup folders, status-filter chips,
// refresh, lazy nested loading, and run/group URL paste.

/* global TestomatAPI, Skeleton, Tooltip, EmptyState, TestType */

// ---------- runs list ----------

// Status filter chips (US3/FR-005): single-select, `launching` folds into
// Running. `all` is the default and shows everything. Passed/Failed lead the
// verdicts — they're the answers actually being checked for — so they sit
// right after All, ahead of the row's rarer, transient states; the row hides
// its RIGHTMOST chips first when it runs out of room (fitFilterChips,
// core/views.js), so this order is also what stays visible longest.
const RUN_FILTERS = [
  ['all', 'All'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['running', 'Running'],
  ['scheduled', 'Scheduled'],
  ['terminated', 'Terminated'],
];
const FILTER_KEYS = new Set(RUN_FILTERS.map(([k]) => k));
// The tint each filter's COUNT wears (shared/components.css: a `.counter`
// takes the same status words as a badge does). Only the two that ARE a
// verdict are coloured; a run that is still running, scheduled or terminated has
// no result yet, so its count stays the default neutral — as does All.
const RUNS_FILTER_TINT = { passed: 'passed', failed: 'failed' };
// The in-flight spinner on a "Load more" button (#110).
const LOADING_ICON = 'progress_activity';
const filterLabel = (key) => (RUN_FILTERS.find(([k]) => k === key) || [, key])[1];
const matchesFilter = (status) => state.runsFilter === 'all' || normStatus(status) === state.runsFilter;

// Runs-list live search (FR: title substring over runs + group titles), combined
// with the status chip. A run renders only when it passes BOTH constraints; a
// group renders when it self-matches both OR holds a passing descendant run. A
// group that self-matches the SEARCH title reveals all its (status-passing)
// contents — mirroring the run-view search, where a matching suite shows its rows.
const runsSearchActive = () => state.runsSearch.trim() !== '';
const runsFilterActive = () => state.runsFilter !== 'all';
const anyRunsConstraint = () => runsSearchActive() || runsFilterActive();
const titleOf = (item) => (item.clean_title || item.title || '').toLowerCase();
const runMatchesSearch = (run) => !runsSearchActive() || titleOf(run).includes(state.runsSearch.trim().toLowerCase());
const groupTitleMatchesSearch = (group) => !runsSearchActive() || titleOf(group).includes(state.runsSearch.trim().toLowerCase());
// A run passes both active constraints (status chip AND search).
const runPasses = (run) => matchesFilter(run.status) && runMatchesSearch(run);
// A group is a direct hit when every active constraint matches the group itself.
const groupSelfHit = (group) => matchesFilter(group.status) && groupTitleMatchesSearch(group);
const runsEmptyMessage = () =>
  (runsSearchActive() ? 'No runs match' : `No ${filterLabel(state.runsFilter).toLowerCase()} runs`);

// A v2 index response ({data, meta:{total,page,per_page}}) as the paging cursor
// the "Load more" control reads (#110). totalPages is derived — v2 reports a
// row total, not a page count.
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

// v2 runs+rungroups fetch (degraded fallback): parallel list + folders. Page 1
// of each; both cursors are kept so the shared "Load more" can advance whichever
// source still has a tail.
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

// Load the runs list into state (Phase 3): the web dashboard page 1 when a JWT
// session is available (single source, web order, branched scope), falling back
// to the v2 runs+rungroups fetch only when the session is unavailable (degraded,
// consistent with M1's contract). Clears the per-refresh child cache.
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
    loadDescendantRuns(); // best-effort; chips show "…" until it settles
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

// v2 mode folds two independently paged sources into one list, so the shared
// cursor is their sum: more rows exist while EITHER source has a next page.
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

// Dashboard mode: fetch ALL descendant runs (any depth) of every top-level
// rungroup in parallel via nested=true, so the filter-chip counters reflect
// every run right after load — before any group is expanded (owner bug fix).
// Best-effort: a failed leg caches [] silently (counts stay partial). A newer
// refresh (token) supersedes an in-flight batch; on settle chips + list rerender.
// Only groups without a cached descendant list are fetched, so a "Load more"
// page costs just its OWN groups' counts (#110). The token is owned by loadRuns
// (a refresh strands every batch); concurrent batches share `descInFlight` so
// the chips settle once, when the last one lands.
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
  let anyFailed = false; // a failed leg means the counts are a lower bound (Block 4)
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
    // The async settle must not clobber an error the user is reading (e.g. the
    // group-URL "not found" line) — re-assert it after the rebuild.
    const status = $('runs-status');
    const err = status.classList.contains('error') ? status.textContent : null;
    renderList();
    if (err) setStatusLine('runs-status', err, 'error');
  });
}

// Render dispatcher: dashboard (interleaved, lazy children) vs v2 (folded list).
function renderList() {
  if (state.listMode === 'dashboard') renderDashboard();
  else renderRuns(state.lastRuns, state.lastGroups);
  // The tab's count chip is NOT set here: it states what the project holds, not
  // what this render drew, so it does not move with "Load more", a search
  // keystroke or a descendant settle. loadRunsCount() owns it — see there.
}

// The Runs tab's count chip (#127): how many runs the PROJECT holds, straight
// off the server's total — the same figure the web app's Runs heading carries,
// and the same kind of figure the Tests chip beside it carries (a whole suite
// tree, not a loaded page).
// It used to be a tally of the loaded rows instead, mirroring the All chip, and
// on any real project that reads as a wrong number rather than a scoped one: a
// project of 5456 runs said "Runs 30" — page one of the dashboard — while the
// web app said 5456 an inch away. The All chip still counts what is loaded,
// because that is what filtering it can actually reach; the tab says what the
// project has.
// The v2 total is what the old row-total objection asked for and the dashboard's
// could not give: dashboard rows are runs OR root folders, so a project of two
// empty folders read "Runs 2" over a list whose All said 0. `/runs` has no folder
// rows to miscount. It also needs no JWT, so both auth modes take this one path.
// Writes NOTHING into state — a count fetch must not leave a half-loaded list
// behind. Best effort: any failure leaves the chip absent, which is what "not
// known" looks like.
async function loadRunsCount(epoch) {
  try {
    const total = await TestomatAPI.countRuns();
    if (!staleProject(epoch)) setTabCount('runs', total);
  } catch { /* best effort — the chip stays absent */ }
}

// Reset the runs-list search to empty (in-memory only; not persisted, mirroring
// the run-view and TC-list searches) and reflect it onto the input + clear button.
function resetRunsSearch() {
  state.runsSearch = '';
  if ($('runs-search')) $('runs-search').value = '';
  if ($('runs-search-clear')) $('runs-search-clear').hidden = true;
}

// "New run" (#118): creating a run stays in the web app, so the header button
// is a plain new-tab link to <active host>/projects/<slug>/runs/new. Both halves
// come from the ACTIVE settings (per-host model / #103 switcher) and are re-read
// on every entry to the view, so a project switch repoints it. Nothing to link
// to without a resolved project — the link hides rather than 404s.
//
// #157: the route is /runs/new, not /runs/newrun. newrun is a dead web route —
// linked from nowhere in the app, it renders the run PLAYER inline under the
// runs list (two pages stacked, which is what the bug report showed) and its
// model hook POSTs a blank run on every visit. /runs/new is the app's own "New
// manual test run" target: an overlay over the list, cold-loadable, and it
// writes nothing until the user saves.
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
  show('runs');
  // The placeholder goes up BEFORE the read-only probe: that probe is a
  // round trip of its own, and it is the first thing standing between the tab
  // click and anything on screen.
  const sk = Skeleton.show('runs');
  // #155: settle the read-only probe BEFORE any list request — a locked project
  // must never flash a runs list it is about to replace with the blocking panel.
  if (await readonlyGate()) { Skeleton.hide(sk); applyReadonlyBlock(); return; }
  renderNewRunLink();           // href tracks the active host + project (#118)
  resetRunsSearch();
  renderFilterChips();          // chip row visible during the load
  setStatusLine('runs-status', 'Loading runs…');
  $('runs-list').replaceChildren();
  try {
    loadRunsCount(state.projectEpoch); // the tab chip, off its own total — never blocks the list
    await loadRuns();
    renderList();
    await ensureExpandedChildrenLoaded(); // hydrate groups restored expanded
  } catch (e) {
    handleApiError(e, 'runs-status');
  } finally {
    // Both ways out: the rows that replaced it, and the error line that says
    // there will be none.
    Skeleton.hide(sk);
  }
}

// Refresh (US4/FR-006): re-fetch in place, keeping the active filter + expanded
// groups (both live in state). On failure the previous list stays; an error
// line + toast surface.
// This is the runs list's HALF of a refresh, not the control — the button lives
// in the project strip now and refreshAll() (core/views.js) owns its disabled +
// spinning state, so it stays in flight until the tab counts have landed too.
async function refreshRuns() {
  try {
    await loadRuns();
    renderList();
    await ensureExpandedChildrenLoaded();
  } catch (e) {
    // #155: access turning read-only under the tester is a lockout, not a failed
    // refresh — repaint into the blocking panel instead of toasting.
    if (isReadonlyError(e)) { applyCapabilities(); return; }
    setStatusLine('runs-status', `Refresh failed: ${e.message || e}`, 'error');
    toast(`Refresh failed: ${e.message || e}`);
  }
}

const childrenLoaded = (groupId) => Array.isArray(state.childrenCache[String(groupId)]);
// A group's contents (direct subgroups + direct runs) are both cached together.
const groupContentsLoaded = (groupId) =>
  childrenLoaded(groupId) && Array.isArray(state.subgroupsCache[String(groupId)]);

// Lazy group load (dashboard mode): on first expansion fetch a group's direct
// subgroups + direct runs in parallel, cache both per refresh, and re-render.
// Best-effort — a failed leg caches [] + toasts so the empty-state shows and the
// request isn't retried until the next refresh.
async function loadGroupContents(groupId) {
  const key = String(groupId);
  if (state.loadingGroup[key] || groupContentsLoaded(key)) return;
  state.loadingGroup[key] = true;
  renderList(); // reflect the loading state under the expanded folder
  const [subs, runs] = await Promise.all([
    TestomatAPI.fetchGroupSubgroups(groupId, 1).catch(() => null),
    TestomatAPI.fetchGroupChildren(groupId, 1).catch(() => null),
  ]);
  state.subgroupsCache[key] = subs?.items || [];
  state.childrenCache[key] = runs?.items || [];
  // Both cursors live in one record — the folder shows ONE "Load more" for its
  // whole contents, advancing whichever of the two still has a page (#110).
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
// Every list the panel paints is one server page deep. Rather than silently
// dropping the tail, an incomplete list ends in a button that fetches the next
// page and APPENDS it. Deliberately not infinite scroll: the panel's one shared
// scroll container (collapsed folders, paste-flash scrollIntoView) makes
// bottom-reach triggers race-prone, and under the client-side title search a
// button can say honestly how much of the list is even loaded.

// Rows still unfetched for a cursor, or null when the server gave no total.
function remainderOf(cursor, loadedCount) {
  if (!cursor || cursor.total == null) return null;
  return Math.max(0, cursor.total - loadedCount);
}
const hasNextPage = (cursor) => !!cursor && cursor.totalPages != null && (cursor.page || 1) < cursor.totalPages;

// The top-level list's cursor + how many rows are on screen-worth of loaded.
function listCursor() {
  return state.listMode === 'dashboard' ? state.listPaging : v2ListPaging(state.listPaging?.loading);
}
const listLoadedCount = () =>
  (state.listMode === 'dashboard'
    ? state.dashItems.length
    : (state.lastRuns || []).length + (state.lastGroups || []).length);

// Fetch the next page of the top-level list and append it. The rows land first
// (the user sees them immediately); the nested descendant counts for any group
// that arrived with this page settle right after, repainting the chips.
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

// Fetch the next page of ONE folder's contents (subgroups first, then runs — the
// render order) and append it inside that folder.
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

// A folder is incomplete while either of its two cursors has a next page.
function groupHasMore(groupId) {
  const p = state.groupPaging[String(groupId)];
  if (!p) return false;
  return hasNextPage({ page: p.subsPage, totalPages: p.subsTotalPages })
    || hasNextPage({ page: p.runsPage, totalPages: p.runsTotalPages });
}

// Rows a folder has not fetched yet (subgroups + runs), or null without totals.
function groupRemainder(groupId) {
  const key = String(groupId);
  const p = state.groupPaging[key];
  if (!p || (p.subsTotal == null && p.runsTotal == null)) return null;
  const subs = remainderOf({ total: p.subsTotal }, (state.subgroupsCache[key] || []).length);
  const runs = remainderOf({ total: p.runsTotal }, (state.childrenCache[key] || []).length);
  if (subs == null && runs == null) return null;
  return (subs || 0) + (runs || 0);
}

// The control itself: one <li> holding the button (+ a muted "M of T loaded"
// note whenever a search/status constraint is on, so the truncation stays
// honest about what the filter could even see). Spins while its page is in
// flight; the caller only renders it while a next page exists, so it simply
// disappears on the last one.
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

// Set of group ids reachable in the loaded tree: top-level dashboard rungroups
// plus every group that appears in some cached subgroup list (any depth).
function reachableGroupIds() {
  const ids = new Set(state.dashItems.filter((it) => it.type === 'rungroup').map((it) => String(it.id)));
  for (const subs of Object.values(state.subgroupsCache)) for (const sg of subs) ids.add(String(sg.id));
  return ids;
}

// After a dashboard (re)load, hydrate every expanded group whose row is reachable
// (top-level or inside a loaded ancestor), walking nested chains until no more
// progress; then prune expansion state for ids no longer anywhere in the tree.
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

// Expand each group id in order (root-first for a paste chain), loading its
// contents so the next level's subgroup row exists before we descend; the target
// (last) ends expanded with its own contents loaded.
async function expandGroupChain(ids) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!state.expandedGroups.some((x) => String(x) === String(id))) state.expandedGroups.push(id);
    persistSession();
    if (state.listMode === 'dashboard' && !groupContentsLoaded(id)) await loadGroupContents(id);
    else renderList();
    // The next link of the chain may sit on a LATER subgroup page (#110) — pull
    // pages until its row exists, else the paste target never renders.
    if (ids[i + 1] != null) await ensureSubgroupLoaded(id, ids[i + 1]);
  }
  renderList();
}

// Keep loading a folder's next page until `childId` shows up among its
// subgroups (or the folder is exhausted). Bounded; only the URL-paste path pays.
async function ensureSubgroupLoaded(parentId, childId) {
  const key = String(parentId);
  const has = () => (state.subgroupsCache[key] || []).some((sg) => String(sg.id) === String(childId));
  for (let guard = 0; guard < 50 && !has() && groupHasMore(key); guard++) {
    await loadMoreGroup(key);
  }
}

// Same for a ROOT group pasted by URL: it may live past page 1 of the list, so
// pull pages until its row is loaded or the list ends (bounded at 20 pages).
async function ensureTopLevelGroupLoaded(groupId) {
  for (let guard = 0; guard < 20; guard++) {
    if (findGroupById(groupId)) return true;
    if (!hasNextPage(listCursor())) return false;
    await loadMoreRuns();
  }
  return false;
}

// Per-status run counts over the loaded list (groups themselves are never
// counted — only runs; `launching` folds into running). `all` = total runs.
function statusCounts(runs) {
  const counts = { all: runs.length, running: 0, passed: 0, failed: 0, scheduled: 0, terminated: 0 };
  for (const r of runs) {
    const s = normStatus(r.status);
    if (s !== 'all' && counts[s] !== undefined) counts[s] += 1;
  }
  return counts;
}

// One chip, built once. Everything here is fixed for the life of the row — the
// word, the tint, the click — so it is set up front and never touched again;
// only the two things that MOVE (the pressed state and the number) are
// re-applied per render, in renderFilterChips below.
function buildFilterChip(key, label) {
  const chip = document.createElement('button');
  chip.type = 'button';
  // Plain library button (shared/components.css → FILTERS) — no chip modifier
  // of its own. The word leads, the count trails, same order a badge count
  // reads on a row.
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

// The row is UPDATED, not rebuilt. It used to be replaceChildren + six fresh
// buttons on every render — and this function runs on every list render, which
// includes the moment the nested run counts settle: six controls were destroyed
// and recreated under the pointer, the row re-measured itself from scratch, and
// the words the tight row had given up came back for a frame before it decided
// to give them up again. All of that was visible as a jump. Keeping the chips
// alive leaves nothing moving but the figures themselves.
function renderFilterChips() {
  const bar = $('runs-filter');
  if (!bar) return;
  // Dashboard counts are only complete once the nested descendant fetches
  // settle. Until then every chip rests at 0 rather than at a partial number:
  // the partial one would count UP as the folders land, and a figure that walks
  // is a figure the tester tries to read. 0 is the one value that cannot be
  // mistaken for an answer, and the fade in paintCounter (core/views.js) is what
  // says the real one has arrived. (It is not the tab chips' rule — those stay
  // ABSENT until known, because a tab bar states what the project HAS and there
  // is no row under it explaining that a load is in progress.)
  const pending = state.listMode === 'dashboard' && !state.descendantsSettled;
  // Some nested-count legs failed: the loaded set is a lower bound, so mark every
  // count approximate with a trailing "+" and explain it on the chip row (Block 4).
  const partial = state.listMode === 'dashboard' && state.descendantsSettled && state.descendantsPartial;
  const counts = statusCounts(state.lastRuns || []);
  Tooltip.set(bar, partial ? 'Some run counts couldn’t load — Refresh to complete them' : '');
  for (const [key, label] of RUN_FILTERS) {
    let chip = bar.querySelector(`[data-filter="${key}"]`);
    if (!chip) bar.append(chip = buildFilterChip(key, label));
    const on = state.runsFilter === key;
    chip.classList.toggle('selected', on);
    chip.classList.toggle('secondary', !on);
    chip.setAttribute('aria-pressed', String(on));
    paintCounter(chip.querySelector('.counter'), pending ? 0 : `${counts[key] ?? 0}${partial ? '+' : ''}`);
  }
  fitFilterChips(bar);
}

// Switch the active chip and re-render client-side (no re-fetch); persisted so
// the filter survives a panel reopen.
function setRunsFilter(key) {
  if (!FILTER_KEYS.has(key)) key = 'all';
  if (state.runsFilter === key) return;
  state.runsFilter = key;
  persistSession();
  renderList();
}

// One input, two jobs (#106). Live title search over runs + group contents
// (mirrors onRunSearch) — except when the value is URL-shaped, which is never a
// title filter: it is a run/rungroup link waiting to be opened. The chip counts
// stay over the whole loaded set — search only narrows the visible list.
// Pasting (or dropping) a URL opens its target straight away; a typed one waits
// for Enter, so a half-typed id can't open the wrong run.
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

// Pasted/dropped text arrives as one input event carrying its inputType; typed
// characters do not (and a synthetic Event has none).
const isPasteInput = (e) =>
  e?.inputType === 'insertFromDrop' || String(e?.inputType || '').startsWith('insertFromPaste');

function onRunsSearchKeydown(e) {
  if (e.key !== 'Enter' || !looksLikeRunUrl($('runs-search').value)) return;
  e.preventDefault();
  openRunsSearchUrl();
}

function clearRunsSearch() {
  state.runsSearch = '';
  $('runs-search').value = '';
  $('runs-search-clear').hidden = true;
  renderList();
  $('runs-search').focus();
}

// A run's environments arrive as ONE string — api.js joins the array v2 sends
// ("MacOS, beta, Chrome") — but they are a LIST, and a list is drawn as a list:
// one pill per environment, so three environments read as three answers instead
// of one long one. The split happens HERE, in the row that draws them, rather
// than in the API: `env` is one comparable string everywhere else it is stored,
// logged or asserted on, and a shape only the row needs belongs to the row.
const envTags = (env) => String(env || '').split(',').map((s) => s.trim()).filter(Boolean);

// An ungrouped run row (top-level), or a child row inside an expanded group.
function runRow(run, { child = false } = {}) {
  const li = document.createElement('li');
  li.className = child ? 'group-child' : 'run';
  li.dataset.runId = run.id;
  li.dataset.status = normStatus(run.status);
  const head = document.createElement('div');
  head.className = 'list-head';
  head.append(statusIcon(run.status));
  // What the run IS, between how it went and what it is called — the web list's
  // own order (status icon → type → title; list-runs.hbs:198-206). It is the
  // MARK now, not the word: `manual` spelled out in a pill took a fifth of a
  // 380px row to say what the tests list says in a 20px square, and the two
  // lists were naming the same thing in two different alphabets. The square is
  // the shared `.type-mark` (◇ UI app library → Type of test), and it carries
  // the word on its tooltip. Absent or unknown kind renders nothing.
  const kind = typeof TestType !== 'undefined' ? TestType.mark(runKind(run.kind)) : null;
  if (kind) head.append(kind);
  // The title, and under it what qualifies the title: `.list-lines` is the block
  // of text a head lays out beside its marks (shared/components.css). The
  // environments used to ride BEFORE the title on the same line, where they took
  // a third of a 380px row to say "MacOS, beta, Chrome" and pushed the run's own
  // name into a second line that started nowhere in particular. Under the title,
  // on the title's own left edge, they read as what they are — a qualifier of
  // the name above them — and the name gets the whole row to wrap in.
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
      // A pill that had to be cut to fit still has to be readable somewhere.
      Tooltip.set(pill, name);
      meta.append(pill);
    }
    lines.append(meta);
  }
  head.append(lines);
  li.append(head);
  // The second line says ONLY what the row cannot say anywhere else. The status
  // left it (the glyph that opens the same row already says it, in colour, in
  // the column every other list in the panel reads statuses from) and the kind
  // left it for the head's own mark in #111; the environments are what is left,
  // and they have no other column to stand in. So a run row is one line, and a
  // run row in an environment is two — never two to say a thing twice.
  li.addEventListener('click', () => openRunView(run.id, run.clean_title || run.title));
  return li;
}

const isExpanded = (groupId) => state.expandedGroups.some((id) => String(id) === String(groupId));

// Folder-row head: chevron + folder icon + title + the run count at the trailing
// edge (only when a reliable count exists — subgroup rows have none, so it is
// left off rather than showing a misleading number) + status icon.
function groupHead(group) {
  const head = document.createElement('div');
  // A real `.list-row`: the folder head is a row like any other, so it draws its
  // own rule (inset to its glyph column by `tree-row has-chevron`) instead of
  // borrowing a border-top from the children container underneath it. The row's
  // own padding is the library's — the head used to spell out a padding of its
  // own, which put it 4px off the tree's column.
  head.className = 'list-row list-head group-head tree-row has-chevron';
  const chevron = treeIcon(CHEVRON_ICON, 'chevron');
  // A rungroup IS a folder of runs, so it keeps the folder mark — unless the
  // project replaced that icon with an emoji of its own, which the v2 rungroup
  // row carries (`emoji`, research R1) and which then stands in for it.
  const folder = treeIcon(FOLDER_ICON, 'folder-icon', group.emoji);
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = group.clean_title || group.title || `Group ${group.id}`;
  head.append(chevron, folder, title);
  if (group.runs_count != null) {
    const count = document.createElement('span');
    // The shared trailing figure (`.row-count`, ROW TAIL in
    // shared/components.css) — the same plain count a suite row and a run's
    // suite header end on, not a chip of its own.
    count.className = 'row-count';
    const n = group.runs_count;
    count.textContent = `${n} ${n === 1 ? 'run' : 'runs'}`;
    head.append(count);
  }
  // No status icon: a rungroup is not a run (owner call, 2026-07-22).
  return head;
}

// Shared folder shell: a group <li> with its clickable head + an (empty) children
// container. Nesting needs no depth: a subgroup's <li> is appended into its
// parent's children container, so the shared `.tree-children` indent compounds
// on its own (style.css).
function groupShell(group) {
  const li = document.createElement('li');
  li.className = 'group tree-node';
  li.dataset.groupId = group.id;
  li.dataset.status = normStatus(group.status);
  if (isExpanded(group.id)) li.classList.add('expanded');
  // Re-apply the paste flash from state so it survives any re-render (e.g. the
  // async nested-count settle rebuild), not just the render that added it.
  if (String(state.highlightedGroup) === String(group.id)) li.classList.add('group-highlight');
  const head = groupHead(group);
  li.append(head);
  const kids = document.createElement('div');
  kids.className = 'group-children tree-children';
  li.append(kids);
  head.addEventListener('click', () => toggleGroup(group.id, li));
  return { li, kids };
}

// What an OPEN folder shows when it holds nothing to draw — the same line in
// both list modes, and the same line whether the children are still on the wire
// or genuinely absent. Compact, because this is a nothing INSIDE a screen that
// is otherwise full of rows: a block empty state indented under one folder of
// twenty would read as the whole list having collapsed. `.group-empty` stays on
// it — that class is what carries the child rows' indentation.
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

// v2 (degraded) folder row: a flat folder over its direct child runs — v2 has no
// nested subgroups, so no recursion. `loading` is unused here (v2 has no lazy
// load) but kept for signature parity with the dashboard renderer's needs.
function groupRow(group, children, { loading = false } = {}) {
  const { li, kids } = groupShell(group);
  if (children.length) {
    for (const c of children) kids.append(runRow(c, { child: true }));
  } else {
    kids.append(groupEmptyRow(loading));
  }
  return li;
}

// Recursive visibility test (dashboard) under the combined status+search
// constraints: a group is visible when it self-matches (status chip AND search
// title), any of its runs passes, or a direct subgroup is itself visible. Top-
// level groups carry a complete nested descendant list (any depth), so a
// collapsed group stays visible when a deep run matches — no expansion needed.
// Subgroups (no nested cache) fall back to their lazily-loaded direct caches.
function groupPasses(group) {
  if (!anyRunsConstraint()) return true;
  if (groupSelfHit(group)) return true;
  const key = String(group.id);
  if ((state.descendantRuns[key] || []).some(runPasses)) return true;
  if ((state.childrenCache[key] || []).some(runPasses)) return true;
  return (state.subgroupsCache[key] || []).some((sg) => groupPasses(sg));
}

// Dashboard folder row (recursive, any depth). Subgroups render first (each a
// folder with identical lazy expansion), then direct runs — server order within
// each. Under the combined constraints only passing descendants render; returns
// null when the group itself is filtered out. `forceShowKids` (an ancestor whose
// title matched the search) exempts this group's contents from the SEARCH filter
// — the status chip still narrows them.
function dashGroupRow(group, forceShowKids = false) {
  const constrained = anyRunsConstraint();
  if (constrained && !forceShowKids && !groupPasses(group)) return null;
  const key = String(group.id);
  // A group whose own title matches the search reveals its contents; nested
  // groups inherit the exemption.
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
  // The folder's own tail (#110). Rendered under an active constraint too — a
  // filter narrowing the LOADED rows must not hide the fact that more exist.
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
  // Dashboard mode loads subgroups+runs lazily on first expansion; cached after.
  if (expanding && state.listMode === 'dashboard' && !groupContentsLoaded(groupId)) {
    loadGroupContents(groupId);
  }
}

function renderRuns(runs, groups = []) {
  state.lastRuns = runs;
  state.lastGroups = groups;
  const ul = $('runs-list');
  ul.replaceChildren();

  // Folder rows come from the /rungroups payload (so a group with all children
  // archived-filtered still renders), minus archived groups (out of scope). v2
  // rungroups is roots-only.
  const groupMap = new Map();
  for (const g of groups) if (!g.archived_at) groupMap.set(String(g.id), g);

  // Fold a run under its group only when that group is KNOWN. A run whose
  // rungroup_id matches no known group (e.g. it lives in a nested subgroup,
  // absent from v2 roots-only rungroups) renders as an ordinary top-level row
  // instead of vanishing (Phase 4, owner-approved degraded behaviour).
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

  // Drop expansion state for groups that are no longer present (before render,
  // so restored/URL-driven expansions of live groups are honoured).
  const present = new Set(groupMap.keys());
  state.expandedGroups = state.expandedGroups.filter((id) => present.has(String(id)));

  // Client-side status+search filter (FR-005). A group shows iff it self-matches
  // both constraints or any child passes; only passing children render. A group
  // whose title matches the search reveals all its status-passing children.
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

// The tail every render of the list ends with, in both modes: the "Load more"
// control, the chip counts, and whichever kind of nothing this render produced.
// Order matters — the no-match state goes in BEFORE the load-more row, because
// the row is a footnote to it ("only page 1 was searched"), not a sibling of it.
function finishRunsRender(ul, { loaded, shown, constrained }) {
  if (!loaded) { renderRunsEmptyCta(ul); renderFilterChips(); return; }
  if (constrained && !shown) ul.append(runsNoMatchEmpty());
  renderTopLoadMore(ul);
  renderFilterChips();
  setStatusLine('runs-status', '');
}

// The top-level list's tail control, appended after every row in BOTH modes.
// Stays put under an active search/status chip (the note then reads "M of T
// loaded") so a filtered-empty list still admits it only searched page 1.
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

// Dashboard mode (Phase 3): render the interleaved runs+rungroups list in web
// order. Children come from the lazy cache — a not-yet-expanded group falls back
// to its own status for filtering, and only loaded children can be counted or
// matched. counts/filters stay client-side over the loaded set (state.lastRuns).
function renderDashboard() {
  const ul = $('runs-list');
  ul.replaceChildren();

  // Countable set (client-side filter/counts) = top-level runs + ALL nested
  // descendant runs of every top-level group (any depth, fetched up front),
  // plus any lazily-loaded direct children — DEDUPED by run id so a run that
  // appears in several caches never counts twice.
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

// Empty runs list (first-launch dead end, Block 6): the shared empty state with
// the two ways OUT of it — start a run where runs are started, or open one you
// already have a link to. Only for a truly empty project; a list that a filter
// emptied is a different sentence (runsNoMatchEmpty below).
//
// The primary action is the header's own "New run" target, /runs/new, not the
// runs index: a tester looking at an empty project does not want to be shown
// the empty list again in a second tab. It wears the header button's exact face
// too — a leading `add`, the one mark this panel gives every control that makes
// something which did not exist.
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
    // A run is something you START, and the panel already says "started" with a
    // play triangle on the Runs tab and on every running row — so the mark over
    // an empty runs list is that same triangle, not a rocket borrowed from a
    // launch metaphor this product never uses anywhere else.
    icon: 'play_arrow',
    title: 'No runs yet',
    text: 'Start a manual run in Testomat and it appears here. Already have a link to one? Paste it in the search above.',
    actions,
  });
  setStatusLine('runs-status', '');
}

// The OTHER nothing: rows exist, none of them survived the status chip and the
// search. It keeps the exact wording the status line used to carry — the chip's
// own word, so "No running runs" still names the filter that is hiding
// everything — and adds the thing a status line could not: the way back. Marked
// `live`, because it took over an aria-live region's job.
function runsNoMatchEmpty() {
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
    // Two constraints can empty this list and they are not the same problem, so
    // the mark says WHICH: a struck-through magnifier for a search that found
    // nothing, a struck-through funnel for a status chip that let nothing past.
    icon: runsSearchActive() ? 'search_off' : 'filter_alt_off',
    title: runsEmptyMessage(),
    text: runsSearchActive()
      ? 'Nothing in the loaded runs matches what you typed.'
      : 'Nothing loaded so far carries this status.',
    actions,
  });
}

// The one message every unresolvable link gets (#106): wrong host, wrong
// project, a non-run path, an unknown id, or no access. Deliberately blunt — the
// panel never offers to switch project on a pasted link.
const RUN_NOT_FOUND = 'Run not found';

// URL-shaped? Anything with a scheme, plus the bare `host/projects/…/runs/…`
// shape people copy out of the address bar. Whitespace means prose — a title
// search, never a link. A URL-shaped value is never used as a title filter, so
// this must stay narrow enough that ordinary run titles don't trip it.
function looksLikeRunUrl(raw) {
  const v = String(raw || '').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\//i.test(v) || /\/projects\/[^/]+\/runs\//.test(v);
}

// Resolve a pasted link against the configured instance + project. Returns
// `{ kind: 'run' | 'group', id }`, or null for anything this panel cannot open
// (other host, other project, not a run/group path, unparseable).
function parseRunsUrl(raw) {
  const v = String(raw || '').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
  let cfgHost;
  try { cfgHost = new URL(state.settings.baseUrl).hostname; } catch { return null; }
  if (u.hostname !== cfgHost) return null;
  // The group URL is the more specific shape — matched before the run pattern,
  // which would otherwise capture the literal "groups" as a run id.
  const gm = u.pathname.match(/\/projects\/([^/]+)\/runs\/groups\/([^/]+)/);
  if (gm) return gm[1] === state.settings.projectId ? { kind: 'group', id: gm[2] } : null;
  // The web's "Copy url" slugs the run segment (`<uid>-<kebab-title>/`) and its
  // route reads back only `params.id.split('-')[0]` — mirror that split or every
  // copied link 404s. Public uids carry no dash, so nothing real is ever cut.
  const rm = u.pathname.match(/\/projects\/([^/]+)\/runs\/([^/]+)/);
  if (rm) return rm[1] === state.settings.projectId ? { kind: 'run', id: rm[2].split('-')[0] } : null;
  return null;
}

// Open whatever the runs input currently holds as a link. A run is probed first
// so a bad id or a run we have no access to leaves the user on the list with a
// toast instead of a half-rendered run view; a group hands over to the existing
// paste chain (root-first expand + flash highlight).
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

// Group URL paste (FR-003): open the runs view focused on one rungroup — filter
// reset to All (URL intent wins over any active filter), the group expanded,
// highlighted, and scrolled into view. An unresolvable id gets the same blunt
// "Run not found" toast every other dead link gets (#106).
async function openGroupFromUrl(groupId) {
  state.runsFilter = 'all';
  resetRunsSearch(); // URL intent wins over a stale search, like the filter reset
  persistSession();
  show('runs');
  renderFilterChips();
  setStatusLine('runs-status', 'Loading runs…');
  $('runs-list').replaceChildren();
  try { await loadRuns(); }
  catch (e) { handleApiError(e, 'runs-status'); return; }
  renderList();
  await ensureExpandedChildrenLoaded(); // hydrate any restored expansions first

  // Top-level hit: expand + highlight directly (resolve by stringified id). A
  // root group past page 1 is pulled in first rather than reported missing.
  await ensureTopLevelGroupLoaded(groupId);
  const top = findGroupById(groupId);
  if (top) {
    await expandGroupChain([top.id]);
    highlightGroup(top.id);
    return;
  }
  // Nested group (dashboard only): resolve the ancestor chain from the show
  // payload's `path` (root-first, excludes self), expand each level so the next
  // level's row exists, then the target; highlight it once rendered.
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
  // v2 mode, unknown group id -> the same not-found toast.
  toast(RUN_NOT_FOUND, { error: true });
}

// The target rungroup in the active list source (dashboard items or v2 folders).
function findGroupById(groupId) {
  if (state.listMode === 'dashboard') {
    return state.dashItems.find((it) => it.type === 'rungroup' && String(it.id) === String(groupId));
  }
  return (state.lastGroups || []).find((g) => String(g.id) === String(groupId) && !g.archived_at);
}

// The rendered folder <li> for a group id (top-level OR nested subgroup row).
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
