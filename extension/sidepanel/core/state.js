// Core state: the shared app-state object, the DOM helper and recordFor lookup,
// the JWT capability gate (session probe, project info and members cache), and
// the cross-screen handleApiError helper.

/* global TestomatAPI */

const $ = (id) => document.getElementById(id);
const views = ['settings', 'runs', 'tcstudio', 'tclist', 'promote', 'run', 'test'];
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  settings: null,     // { baseUrl, apiToken, projectId } — the ACTIVE instance
  // Configurable instance (permission rework): per-host saved settings + the
  // ordered host history for the Instance dropdown. Keyed by hostname so switching
  // the instance restores that host's token/project/prefs with no re-entry.
  hostSettings: {},   // host -> its saved settings object
  hostHistory: [],    // hosts used before, most-recent-first
  projectEpoch: 0,    // bumped on every project switch. Loads that identify their
                      // rows some other way (a run id, a suite id) already bail on
                      // their own; the container loads have no such handle, so they
                      // capture this and drop a response that arrived too late.
  projects: [],       // {id (slug), title} the token can reach on the ACTIVE host
                      // (JWT /api/projects) — the header switcher's options (#103).
                      // In-memory only: re-fetched on every panel open, never stored.
  view: 'settings',
  activeTab: 'settings', // 'tests' | 'runs' | 'settings' — derived from the view
  tabViews: {},       // tab -> its last shown view (per-tab memory for tab clicks)
  booting: true,      // suppress session persistence until init's restore settles
                      // (a transient boot must not leak a phantom session)
  runId: null,
  runTitle: '',
  testTitle: '',      // the open test's name — the last crumb of the header path
                      // (core/views.js), written when the test view opens
  runStatus: null,    // v2 run status: 'running' until finished, then terminal
  runKind: null,      // v2 run kind: manual|automated|mixed — the header pill (#111)
  records: [],        // testrun records of the open run, in run order
  substatusCounts: {},// open run's custom-status counters (#109): substatus -> count,
                      // from the JSON:API run detail (JWT). {} in basic mode / on a
                      // run with none; refreshed on the same poll cycle as the rows
  runInfo: {},        // open run's "Run info" fields (#112): status/testsCount/createdAt/
                      // description/envs/plans from the v2 detail (basic mode has
                      // these), plus ciBuildUrl/duration/launchedAt/finishedAt merged in
                      // from the same JSON:API read the counters ride (JWT-only, no extra fetch)
  currentRecordId: null, // testrun RECORD id of the open row (not test_id): a
                         // parametrized TC has one record per example row, all
                         // sharing test_id, so the row identity is the record id
  stepTicks: {},      // recordId -> { stepIndex: true } (v1 local ticks; degraded mode)
  runFilter: 'all',   // run-view status chip: all|passed|failed|skipped|untested (resets on run open)
  runSearch: '',      // run-view live search over test + suite titles (resets on run open)
  expandedSuites: {}, // run-view suite key -> user toggle: true expanded / false collapsed;
                      // absent = default (collapsed; single-suite runs render expanded)
  testrunDetail: null,// last JSON:API testrun prefetch (JWT); carries server steps
  testDetailPending: false, // that prefetch is on the wire for the OPEN test — the
                      // header keeps the priority slot reserved (a skeleton disc)
                      // instead of guessing, so the title cannot shift when it lands
  currentSteps: [],   // parsed steps of the open test: { li, pos, index, title, expected, state }
  saving: false,
  inlineWrites: 0,    // in-flight run-view inline status writes (finish-run waits on these)
  expandedGroups: [], // rungroup ids expanded inline in the runs list (persisted)
  runsFilter: 'all',  // active status filter chip for the runs list (persisted)
  runsSearch: '',     // runs-list live search over run + group titles (resets on open)
  lastRuns: [],       // countable runs feeding client-side filter/counts (both modes)
  lastGroups: [],     // last-loaded rungroups (folder rows)
  listMode: 'v2',     // 'dashboard' (JWT, web parity) | 'v2' (degraded fallback)
  dashItems: [],      // dashboard mode: interleaved runs+rungroups in web order
  childrenCache: {},  // dashboard mode: groupId -> lazily-loaded direct child runs (per refresh)
  subgroupsCache: {}, // dashboard mode: groupId -> lazily-loaded direct subgroups (per refresh)
  loadingGroup: {},   // dashboard mode: groupId -> true while its subgroups+runs fetch
  descendantRuns: {}, // dashboard mode: top-level groupId -> ALL descendant runs (nested; per refresh)
  descendantsSettled: false, // dashboard mode: all nested count fetches have resolved
  descendantsPartial: false, // dashboard mode: some nested count legs failed (counts are a lower bound)
  descLoadToken: 0,   // guards a superseding refresh against a stale nested batch
  descInFlight: 0,    // nested-count batches still running (a "Load more" page adds one)
  // ---- list pagination (#110) — "Load more" instead of a silent page-1 cut ----
  listPaging: {},     // the TOP-LEVEL list cursor: {page,total,totalPages,loading}.
                      // Filled from the server meta of the last page fetched, in
                      // BOTH modes (dashboard: one source; v2: runs+groups folded,
                      // so `total` is the two totals summed).
  v2RunsPaging: {},   // v2 mode only: the /runs cursor  {page,total,totalPages,perPage}
  v2GroupsPaging: {}, // v2 mode only: the /rungroups cursor, same shape
  groupPaging: {},    // dashboard: groupId -> {runsPage,runsTotal,runsTotalPages,runsPerPage,
                      //   subsPage,subsTotal,subsTotalPages,loading} — a group's own
                      //   two cursors (direct child runs + direct subgroups)
  highlightedGroup: null, // group-URL-paste flash target (in-memory; survives re-renders)
  // TC Studio (M3): suite tree + per-suite TC list. In-memory only — the tree is
  // re-fetched on entry; expand state is a per-session set of suite ids.
  tcSuites: [],       // suite tree roots (nested children) from getSuiteTree()
  tcExpanded: {},     // suite id -> true when a folder node is expanded (in-memory)
  tcSuiteId: null,    // the open file-suite in the TC list view
  tcSuiteTitle: '',   // its title (contextual row)
  tcSuiteEmoji: null, // …and the custom emoji it wears there, when the tree gave one
  tcTests: [],        // last-loaded TCs of the open suite
  tcSearch: '',       // TC-list live search over titles (resets on suite open)
  tcTreeSearch: '',   // Tests-screen live search over suite/folder titles (in-memory)
  // Suite title -> the custom emoji the project gave that suite, indexed off the
  // same tree (rememberSuiteEmoji, screens/run-view.js). Project-scoped and
  // lazy: null until something has read a tree, then the WHOLE answer — a suite
  // missing from it has no mark, which is why every re-read replaces this map
  // rather than merging into it.
  suiteEmoji: null,
};

// Rows are keyed by testrun record id — the only identity that distinguishes two
// example rows of the same parametrized test (they share test_id). ids may be
// number or string across the v2/session boundary, so compare stringified.
const recordFor = (recordId) => state.records.find((r) => String(r.id) === String(recordId));

// Hostname of an instance base URL — the per-host settings map key. null when the
// URL is empty/invalid.
const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } };

// Usable config = an instance + token AND a resolved project: every scoped route
// carries the slug. Since #103 the slug is never typed — Save resolves it from the
// token's project list — so this is what gates the Tests/Runs tabs.
const isConfigured = () => !!(state.settings && state.settings.projectId);

// True when a load that started at `epoch` belongs to a project we have since
// left — its rows must be dropped, not rendered into the new project (#103).
const staleProject = (epoch) => epoch !== state.projectEpoch;

// ---------- capability gate (US6) ----------
// One flag deciding server-sync vs v1 fallback, derived from the JWT session
// state. Read DIRECTLY as `capabilities.jwt` — there is no subscription: three
// probes write it (probeSession here, probeRunSession in run-view, loadRuns in
// runs-list) and each calls applyCapabilities() to repaint. `false` => degrade
// to v1 with a muted hint (FR-012). It gates tri-state steps, priority,
// substatus, assignee, finish-run, the dashboard runs list, project members,
// the project picker and every upload.
//
// `capabilities.readonly` (#155) is the second, harder gate: read-only access to
// the project (reader role, company-readonly, or an archived project). v2 answers
// 403 to every request there, GET included, so there is nothing the panel can
// honestly offer — it locks the whole project out (views.js applyReadonlyBlock)
// rather than degrading. Derived from the API client by applyCapabilities(), same
// as `jwt`; read DIRECTLY, no subscription.

const capabilities = { jwt: false, readonly: false };

// Project info (JSON:API /projects/{slug}) carries `run-replies` — the substatus
// options grouped by status (US4). Fetched once per panel session and cached;
// on failure the in-flight promise is cleared so a recovered session retries.
let projectInfo = null;
let projectInfoPromise = null;

function loadProjectInfo() {
  if (projectInfoPromise) return projectInfoPromise;
  projectInfoPromise = TestomatAPI.getProjectInfo()
    .then((doc) => { projectInfo = doc; return doc; })
    .catch(() => { projectInfoPromise = null; projectInfo = null; return null; });
  return projectInfoPromise;
}

// Substatus options for a status, from the project's run-replies group.
function runRepliesFor(status) {
  const groups = projectInfo?.data?.attributes?.['run-replies'];
  const g = groups && groups[status];
  return Array.isArray(g) ? g.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
}

// Project members (JWT). `usersMap` = email(lowercased)->name for the assignee
// chip; `usersList` = the full {id,name,email,avatar,timezone} rows for the assignee
// dropdown (M4). Fetched once and cached (per project, single-project panel);
// best-effort — a failure clears the in-flight promise so a recovered session can
// retry.
let usersMap = null;
let usersList = null;
let usersPromise = null;

function loadProjectUsers() {
  if (usersPromise) return usersPromise;
  usersPromise = TestomatAPI.listProjectUsers()
    .then((users) => {
      usersList = users;
      usersMap = new Map();
      // The whole member row, not just the name: an address on a run info field
      // or a checklist row resolves to a name AND to the picture beside it, and
      // both come from this one read.
      for (const u of users) if (u.email) usersMap.set(u.email.toLowerCase(), u);
      return usersMap;
    })
    .catch(() => { usersPromise = null; usersMap = null; usersList = null; return null; });
  return usersPromise;
}

// The VIEWER's own profile timezone (#200), IANA, off the same members read —
// the web formats every stamp in it, never in the machine's zone. The viewer is
// the JWT's `user_id` claim; ids are strings here, the claim numeric. null
// whenever the profile zone cannot be known — no session (BASIC MODE IS BLIND to
// the profile: a v2 token carries no identity and /users is JSON:API-only, the
// same deliberate blindness as the archived flag in run-view), the members read
// has not landed yet, or the viewer is not on the list — and the caller then
// falls back to the browser zone, the web's own `dayjs.tz.guess()` fallback.
function viewerTimezone() {
  const id = TestomatAPI.jwtUserId();
  if (id == null || !usersList) return null;
  return usersList.find((u) => u.id === String(id))?.timezone || null;
}

// The member behind an address, or null while the map is unread (basic mode, a
// failed/unmade /users call) or the address belongs to nobody in the project.
function assigneeUser(email) {
  return usersMap?.get(String(email).toLowerCase()) || null;
}

// Display name for an assignee email: the resolved member name, else the email's
// local part (degraded/unknown fallback, FR-004).
function assigneeName(email) {
  const resolved = assigneeUser(email)?.name;
  if (resolved) return resolved;
  const at = String(email).indexOf('@');
  return at > 0 ? String(email).slice(0, at) : String(email);
}

// Drop EVERYTHING that belongs to the project we are leaving (#103 switcher, and
// any future re-point of the panel): the open run/test, both lists and their
// caches, the TC tree, the per-tab memory, and the two per-project JWT caches
// above. Deliberately total — a row, a suite id or a members map surviving into
// another project is a silent wrong-project write. The caller repaints after.
function resetProjectScopedState() {
  state.runId = null;
  state.runTitle = '';
  state.testTitle = '';
  state.runStatus = null;
  state.records = [];
  state.substatusCounts = {};
  state.runInfo = {};
  state.currentRecordId = null;
  state.stepTicks = {};
  state.runFilter = 'all';
  state.runSearch = '';
  state.expandedSuites = {};
  state.testrunDetail = null;
  state.currentSteps = [];
  state.expandedGroups = [];
  state.runsFilter = 'all';
  state.runsSearch = '';
  state.lastRuns = [];
  state.lastGroups = [];
  state.dashItems = [];
  state.childrenCache = {};
  state.subgroupsCache = {};
  state.loadingGroup = {};
  state.descendantRuns = {};
  state.descendantsSettled = false;
  state.descendantsPartial = false;
  state.descLoadToken += 1; // strands any in-flight nested-count batch
  state.descInFlight = 0;
  state.listPaging = {};
  state.v2RunsPaging = {};
  state.v2GroupsPaging = {};
  state.groupPaging = {};
  state.highlightedGroup = null;
  state.tcSuites = [];
  state.tcExpanded = {};
  state.tcSuiteId = null;
  state.tcSuiteTitle = '';
  state.tcSuiteEmoji = null;
  state.tcTests = [];
  state.tcSearch = '';
  state.tcTreeSearch = '';
  state.suiteEmoji = null;  // the marks belong to the project that set them
  state.tabViews = {};      // every tab lands on its root, not a stale sub-view
  state.projectEpoch += 1;  // strands any container load already in flight
  projectInfo = null;
  projectInfoPromise = null;
  usersMap = null;
  usersList = null;
  usersPromise = null;
  capabilities.jwt = false; // re-probed against the new project
  capabilities.readonly = false; // …and so is the read-only lockout (#155)
  readonlyProbe = null;
  // The tab counts are project-scoped like everything above — the outgoing
  // project's totals must not sit in the bar over the incoming one's views until
  // those views happen to load. Guarded: core/views.js loads after this module.
  if (typeof resetTabCounts === 'function') resetTabCounts();
  if (typeof syncStop === 'function') syncStop(); // no poll for the closed run
}

function applyCapabilities() {
  const s = TestomatAPI.jwtAvailable(); // 'unknown' | true | false
  document.body.dataset.jwt = s === true ? 'available' : s === false ? 'degraded' : 'unknown';
  const hint = $('jwt-hint');
  if (hint) hint.hidden = s !== false; // shown only once degradation is proven
  capabilities.readonly = TestomatAPI.readonlyAccess() === true; // #155
  if (typeof applyReadonlyBlock === 'function') applyReadonlyBlock(); // the lockout panel
  if (typeof updateDegradedBanner === 'function') updateDegradedBanner(); // runs/run strip
}

// ---------- read-only access probe (#155) ----------
// Nothing on the working screens would otherwise learn about read-only access:
// the runs list, the suite tree and every session-only read ride the JSON:API
// (JWT) channel, which keeps GETs open for a reader. Only v2 answers 403, so one
// cheap v2 GET — the same `/runs?per_page=1` Settings validates with — is the
// whole detection. Fired from the tab roots BEFORE they load anything, so a
// locked project never flashes content it is about to replace. Silent by design:
// the failure IS the answer, and the blocking panel is the only surface.
//
// The memo is the CLIENT's own tri-state, not a flag here: it resets to
// 'unknown' on every configure() — instance, token or project — so the probe
// re-runs exactly when the answer could have changed and never otherwise. The
// promise below only collapses concurrent entries into one request.
let readonlyProbe = null;

function probeReadonly() {
  if (TestomatAPI.readonlyAccess() !== 'unknown') { applyCapabilities(); return Promise.resolve(); }
  if (readonlyProbe) return readonlyProbe;
  readonlyProbe = TestomatAPI.validate()
    .catch(() => null) // a readonly 403 is recorded inside the client; nothing to report
    .then(() => { readonlyProbe = null; applyCapabilities(); });
  return readonlyProbe;
}

// Settle the probe and answer "is this project locked?" — what every screen
// entry point gates its load on.
async function readonlyGate() {
  await probeReadonly();
  return capabilities.readonly === true;
}

// Best-effort session upgrade + prefetch of the JSON:API testrun detail that
// US2 will consume. A failed upgrade degrades silently — no error or toast.
async function probeSession(testrunId) {
  if (!testrunId) { applyCapabilities(); return; }
  try {
    state.testrunDetail = await TestomatAPI.jwtRequest(`/testruns/${encodeURIComponent(testrunId)}`);
  } catch { /* degraded — probe is best-effort (FR-012) */ }
  capabilities.jwt = TestomatAPI.jwtAvailable() === true;
  applyCapabilities();
}

// ---------- shared ----------

const isAuthError = (e) => e?.kind === 'auth' || e?.kind === 'unconfigured';
const isReadonlyError = (e) => e?.kind === 'readonly';

// `opts.inlineAuth` (in-run writes): an expired/again-unconfigured session shows
// an inline "Session expired" line + Settings link on `statusId`, instead of
// redirecting to Settings — the tester keeps their place in the run (Block 4).
// Initial-load auth failures omit the flag and keep the redirect behavior.
function handleApiError(e, statusId, opts = {}) {
  // #155: read-only access is not an error to report — whichever call ran into
  // it, the panel repaints into its blocking state and says the one honest thing
  // there. No status line, no toast, no trip to Settings.
  if (isReadonlyError(e)) { applyCapabilities(); return; }
  if (isAuthError(e)) {
    if (opts.inlineAuth && statusId) { setAuthExpiredLine(statusId); return; }
    fillSettingsForm();
    show('settings');
    setStatusLine('settings-status', e.message, 'error');
  } else if (statusId) {
    setStatusLine(statusId, e.message || String(e), 'error');
  } else {
    toast(e.message || String(e));
  }
}
