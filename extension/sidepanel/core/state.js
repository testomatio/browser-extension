// Core state: the shared app-state object, the DOM/record helpers, the JWT
// capability gate (session probe, project info + members cache), handleApiError.

/* global TestomatAPI */

const $ = (id) => document.getElementById(id);
const views = ['settings', 'pick', 'runs', 'tcstudio', 'tclist', 'promote', 'run', 'test'];
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  settings: null,     // { baseUrl, apiToken, projectId } — the ACTIVE instance
  // Keyed by hostname: an instance switch restores that host's token/project.
  hostSettings: {},   // host -> its saved settings object
  hostHistory: [],    // hosts used before, most-recent-first
  projectEpoch: 0,    // bumped on every project switch; container loads capture it to drop late responses
  projects: [],       // {id (slug), title} from JWT /api/projects; in-memory only, never stored
  view: 'settings',
  activeTab: 'settings', // 'tests' | 'runs' | 'settings' — derived from the view
  tabViews: {},       // tab -> its last shown view (per-tab memory for tab clicks)
  booting: true,      // suppress session persistence until init's restore settles
  runId: null,
  runTitle: '',
  testTitle: '',      // the open test's name — the last crumb of the header path
  runStatus: null,    // v2 run status: 'running' until finished, then terminal
  runKind: null,      // v2 run kind: manual|automated|mixed — the header pill (#111)
  records: [],        // testrun records of the open run, in run order
  runExamples: {},    // #52: testrun id -> { values, params } of a parametrized row (JWT); {} in basic mode
  substatusCounts: {},// substatus -> count from the JSON:API run detail; {} in basic mode
  runInfo: {},        // open run's "Run info" fields: the v2 detail plus the JSON:API read
  currentRecordId: null, // testrun RECORD id of the open row, never test_id
  stepTicks: {},      // recordId -> { rowOrdinal: true } (v1 local ticks; degraded mode)
  runFilter: 'all',   // run-view status chip: all|passed|failed|skipped|untested (resets when another run opens)
  runSearch: '',      // run-view live search over test + suite titles (resets when another run opens)
  expandedSuites: {}, // suite key -> user toggle; absent = default (collapsed)
  testrunDetail: null,// last JSON:API testrun prefetch (JWT); carries server steps
  testDetailPending: false, // that prefetch is on the wire for the OPEN test
  currentSteps: [],   // parsed rows of the open test: { kind: step|item, li, pos, index, title, expected, state }
  saving: false,
  inlineWrites: 0,    // in-flight run-view inline status writes (finish-run waits on these)
  expandedGroups: [], // rungroup ids expanded inline in the runs list (persisted)
  runsFilter: 'all',  // active status filter chip for the runs list (persisted)
  runsSearch: '',     // runs-list live search over run + group titles (outlives the screen; a project switch clears it)
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
  runsChipCounts: null, // last SETTLED {counts, partial} the filter chips painted; kept up while a re-read runs
  // ---- list pagination (#110) — "Load more" instead of a silent page-1 cut ----
  listPaging: {},     // top-level cursor {page,total,totalPages,loading} from server meta
  v2RunsPaging: {},   // v2 mode only: the /runs cursor  {page,total,totalPages,perPage}
  v2GroupsPaging: {}, // v2 mode only: the /rungroups cursor, same shape
  groupPaging: {},    // dashboard: groupId -> its own two cursors (child runs + subgroups)
  highlightedGroup: null, // group-URL-paste flash target (in-memory; survives re-renders)
  // TC Studio: in-memory only — the tree is re-fetched on entry.
  tcSuites: [],       // suite tree roots (nested children) from getSuiteTree()
  tcExpanded: {},     // suite id -> true when a folder node is expanded (in-memory)
  tcSuiteId: null,    // the open file-suite in the TC list view
  tcSuiteTitle: '',   // its title (contextual row)
  tcSuiteEmoji: null, // …and the custom emoji it wears there, when the tree gave one
  tcTests: [],        // last-loaded TCs of the open suite
  tcSearch: '',       // TC-list live search over titles (resets on suite open)
  tcTreeSearch: '',   // Tests-screen live search over suite/folder titles (in-memory)
  // Suite title -> its custom emoji. null until a tree is read, then the WHOLE
  // answer — so every re-read REPLACES this map rather than merging into it.
  suiteEmoji: null,
};

// The record id is the only identity separating two example rows of a parametrized
// test. ids may be number or string across the v2/session boundary — compare stringified.
const recordFor = (recordId) => state.records.find((r) => String(r.id) === String(recordId));

// Hostname of an instance base URL — the per-host settings key; null when invalid.
const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } };

// Usable config = instance + token AND a resolved project (every scoped route
// carries the slug; Save resolves it, #103). Gates the Tests/Runs tabs.
const isConfigured = () => !!(state.settings && state.settings.projectId);

// A load started at `epoch` belongs to a project we have left — drop its rows (#103).
const staleProject = (epoch) => epoch !== state.projectEpoch;

// ---------- capability gate (US6) ----------
// Read DIRECTLY, no subscription: the probes write these and call applyCapabilities().
// `jwt: false` degrades to v1; `readonly` (#155) means v2 answers 403 to everything, GET included.

const capabilities = { jwt: false, readonly: false };

// /projects/{slug} carries `run-replies` — the substatus options grouped by status.
// Cached per panel session; on failure the promise is cleared so a retry can happen.
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

// Project members (JWT): `usersMap` keys the {id,name,email,avatar,timezone} rows by
// lowercased email, `usersList` keeps them in order. A failure clears the promise.
let usersMap = null;
let usersList = null;
let usersPromise = null;

function loadProjectUsers() {
  if (usersPromise) return usersPromise;
  usersPromise = TestomatAPI.listProjectUsers()
    .then((users) => {
      usersList = users;
      usersMap = new Map();
      // The whole member row, not just the name — the avatar rides along.
      for (const u of users) if (u.email) usersMap.set(u.email.toLowerCase(), u);
      return usersMap;
    })
    .catch(() => { usersPromise = null; usersMap = null; usersList = null; return null; });
  return usersPromise;
}

// The viewer's IANA profile timezone (#200) — the web formats every stamp in it, not
// the machine's zone. Viewer = the JWT `user_id` claim (numeric; ids here are strings).
function viewerTimezone() {
  const id = TestomatAPI.jwtUserId();
  if (id == null || !usersList) return null;
  return usersList.find((u) => u.id === String(id))?.timezone || null;
}

// null while the map is unread (basic mode, a failed /users call) or nobody matches.
function assigneeUser(email) {
  return usersMap?.get(String(email).toLowerCase()) || null;
}

// The resolved member name, else the email's local part.
function assigneeName(email) {
  const resolved = assigneeUser(email)?.name;
  if (resolved) return resolved;
  const at = String(email).indexOf('@');
  return at > 0 ? String(email).slice(0, at) : String(email);
}

// Drop EVERYTHING scoped to the project being left: a row, a suite id or a members
// map that survives into the next one is a silent wrong-project write.
function resetProjectScopedState() {
  state.runId = null;
  state.runTitle = '';
  state.testTitle = '';
  state.runStatus = null;
  state.records = [];
  state.runExamples = {};
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
  state.runsChipCounts = null; // another project's numbers are not a lower bound for this one
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
  stopReadonlyWatch(); // the lockout it watched belonged to the project being left
  // Guarded: core/views.js loads after this module.
  if (typeof resetTabCounts === 'function') resetTabCounts();
  // An unsent comment is keyed by a testrun id, which means nothing in the next project.
  if (typeof dropAllCommentDrafts === 'function') dropAllCommentDrafts();
  if (typeof syncStop === 'function') syncStop(); // no poll for the closed run
}

function applyCapabilities() {
  const s = TestomatAPI.jwtAvailable(); // 'unknown' | true | false
  document.body.dataset.jwt = s === true ? 'available' : s === false ? 'degraded' : 'unknown';
  const hint = $('jwt-hint');
  if (hint) hint.hidden = s !== false; // shown only once degradation is proven
  capabilities.readonly = TestomatAPI.readonlyAccess() === true; // #155
  // The one place the flag is (re)computed, so the watch below simply follows it.
  if (capabilities.readonly) startReadonlyWatch(); else stopReadonlyWatch();
  if (typeof applyReadonlyBlock === 'function') applyReadonlyBlock(); // the lockout panel
  if (typeof updateDegradedBanner === 'function') updateDegradedBanner(); // runs/run strip
}

// ---------- read-only access probe (#155) ----------
// JSON:API keeps GETs open for a reader and only v2 answers 403, so one cheap v2 GET is
// the whole detection. The memo is the CLIENT's tri-state, reset on every configure().
let readonlyProbe = null;

function probeReadonly() {
  if (TestomatAPI.readonlyAccess() !== 'unknown') { applyCapabilities(); return Promise.resolve(); }
  if (readonlyProbe) return readonlyProbe;
  readonlyProbe = TestomatAPI.validate()
    .catch(() => null) // a readonly 403 is recorded inside the client; nothing to report
    .then(() => { readonlyProbe = null; applyCapabilities(); });
  return readonlyProbe;
}

// Settle the probe and answer "is this project locked?" — every screen entry gates on it.
async function readonlyGate() {
  await probeReadonly();
  return capabilities.readonly === true;
}

// ---------- read-only re-probe (#155) ----------
// The lockout hides every list, so live sync stays off (livesync.js) and this is all that runs:
// ONE cheap read on a slow beat, whose only job is to notice that the role changed back.
const READONLY_RECHECK_MS = 60000;
let readonlyWatch = null;

// Armed only by applyCapabilities, and never for a panel with no connection to read.
function startReadonlyWatch() {
  if (readonlyWatch || !capabilities.readonly || !isConfigured()) return;
  readonlyWatch = setInterval(recheckReadonly, READONLY_RECHECK_MS);
}

function stopReadonlyWatch() {
  if (readonlyWatch) { clearInterval(readonlyWatch); readonlyWatch = null; }
}

async function recheckReadonly() {
  // Self-teardown, for any path that clears the flag without passing applyCapabilities.
  if (!capabilities.readonly || !isConfigured()) { stopReadonlyWatch(); return; }
  // A hidden panel is nobody watching — the same guard syncShouldPoll keeps.
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  await TestomatAPI.recheckAccess(); // coalesced with a corroboration already on the wire
  if (TestomatAPI.readonlyAccess() !== false) return; // still refused, or never answered at all
  applyCapabilities(); // stops this watch and lifts the block…
  if (typeof refreshCurrentView === 'function') refreshCurrentView(); // …onto a screen with data on it
}

// Best-effort session upgrade + JSON:API testrun prefetch; a failure degrades silently.
async function probeSession(testrunId) {
  if (!testrunId) { applyCapabilities(); return; }
  try {
    state.testrunDetail = await TestomatAPI.jwtRequest(`/testruns/${encodeURIComponent(testrunId)}`);
  } catch { /* degraded — the probe is best effort */ }
  capabilities.jwt = TestomatAPI.jwtAvailable() === true;
  applyCapabilities();
}

// ---------- shared ----------

const isAuthError = (e) => e?.kind === 'auth' || e?.kind === 'unconfigured';
const isReadonlyError = (e) => e?.kind === 'readonly';

// `opts.inlineAuth` (in-run writes): show an inline "Session expired" line on
// `statusId` instead of redirecting; initial-load failures omit it and redirect.
function handleApiError(e, statusId, opts = {}) {
  // #155: read-only is not an error to report — the blocking panel is the surface.
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
