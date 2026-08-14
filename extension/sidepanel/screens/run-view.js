// Run view: status-icon names and helpers, the run tests list with progress,
// status chips, search, suite sections, finish-run, and the run session probe.

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, TestType, PriorityIcons, UserCell */

// ---------- status icons (US2/FR-004) ----------
// The library's own marks now (◇ UI app library → Run status, node 2003-18939 —
// `status_*` in shared/icons.js), not Material stand-ins for them: a filled disc
// with a white tick for passed, the same disc with a minus for failed, the
// record-circle for everything nobody has decided yet, timer-off for a run that
// was stopped. `launching` renders as `running`, and running is
// not in this table at all — it is the LOADER, which is a drawn ring rather than
// a glyph (statusIcon below, `.spinner` in shared/components.css).
const STATUS_ICON = {
  passed: 'status_passed',
  failed: 'status_failed',
  skipped: 'status_record',
  terminated: 'status_terminated',
};
// Pending, scheduled, queued, unknown — one ring-with-a-dot for all of them.
const NEUTRAL_ICON = 'status_record';
// The two marks a tree row leads with, and they are the LIBRARY'S own now
// (`tree_*` in shared/icons.js) rather than Material's folder/description, which
// were only ever stand-ins: a two-tone folder for a grouping node, the suite
// page-with-a-tick for a node that holds test cases. What the API calls a `file`
// suite is what the product calls a SUITE — the constant keeps the API's word,
// the glyph speaks the product's.
const FOLDER_ICON = 'tree_folder'; // rungroups + TC-studio folders (grouping nodes)
const FILE_ICON = 'tree_suite';    // file/test-file suite nodes — and a run's suite sections
const CHEVRON_ICON = 'chevron_right'; // run/tree.hbs:25 (rotates 90° when expanded)
const ACCOUNT_ICON = 'person'; // assignee chip: person marker before the name

const normStatus = (s) => (s === 'launching' ? 'running' : s || 'unknown');

// Thin alias over Icons.el so the call sites below (and core/views.js, which is
// loaded first and reaches for this by name) read the same as they always did.
function svgIcon(name, size = 16, ...cls) {
  return Icons.el(name, size, ...cls);
}

// A tree row's own glyph (chevron, folder, file), in the shared 20px box every
// mark in this panel centres itself in (`.tree-icon`, shared/components.css —
// the same box `.type-mark`/`.prio` draw a 16px glyph in). Every collapsible
// row — TC Studio's folders, a rungroup, a run's suite section — builds its
// icons through this one function, so a chevron lines up on the same vertical
// whichever tree it opens. `cls` carries the glyph's OWN name (`chevron`,
// `folder-icon`, `file-icon`) for the screen's rotate/colour rules that still
// key off it.
//
// `emoji` is the override: a project can replace a suite's icon in Testomat with
// an emoji of its own, and where it did, the panel draws THAT in the same square
// — the tree here says what the web tree says. The glyph is the fallback, so a
// node without one is unchanged.
function treeIcon(name, cls, emoji) {
  const custom = Icons.emoji(emoji, `tree-icon ${cls}`);
  // `data-emoji` records WHICH mark this is, so a later repaint can tell an icon
  // that is already right from one that has to be replaced (paintSuiteEmoji).
  // It is the drawn text, not the raw value: a `:shortcode:` the panel cannot
  // resolve draws the glyph, and the glyph carries no mark at all.
  if (custom) { custom.dataset.emoji = custom.textContent; return custom; }
  const span = document.createElement('span');
  span.className = `tree-icon ${cls}`;
  span.append(svgIcon(name, 16));
  return span;
}

// What KIND of run this is — manual | automated | mixed, the three the product
// gives a run (badge.scss:87-104). Anything else — absent, unknown, or a
// RUNGROUP's own `kind` (multienv) — is not one of them and draws nothing: a
// rungroup is not a run.
//
// The three names are also three of the type-of-test kinds, which is the whole
// reason the mark works on both: `TestType.mark(runKind(k))` draws a run's kind
// in the same square the tests list draws a test's in (shared/test-type.js).
const RUN_KINDS = new Set(['manual', 'automated', 'mixed']);
function runKind(kind) {
  const k = String(kind || '').toLowerCase();
  return RUN_KINDS.has(k) ? k : null;
}

// The kind as a mark WITH its word — the library's own text form of the same
// component (`TestType.mark(k, { text: true })`, `.type-mark` + `.type-label`),
// for the one place that has room for it and a reason: the run header, where the
// chip sits beside the run's status chip and there is no title to lean on.
// (A row uses the icon-only square instead — see runs-list.js.)
//
// It was a text-only `.badge.kind` of its own until the library reached it, which
// left the panel spelling one thing two ways: a pill in the header, a mark on the
// rows below it, in two different corners at two different heights.
function kindBadge(kind) {
  const k = runKind(kind);
  if (!k || typeof TestType === 'undefined') return null;
  const el = TestType.mark(k, { text: true });
  // "manual run", not the bare kind: the header is describing THIS run, and the
  // word beside the glyph already says which sort it is.
  if (el) Tooltip.set(el, `${k} run`);
  return el;
}

// The run's mark, in the 20px box every mark in this panel stands in.
// `data-status` drives the colour (shared/components.css → RUN STATUS).
//
// RUNNING is the exception and it is not an icon: the library draws it as a
// two-colour ring with a turning quarter, which no single-path glyph can be —
// so it comes back as the `.spinner` element instead. Both forms measure the
// same 20px, so a row does not shift when the run finishes.
function statusIcon(status) {
  const s = normStatus(status);
  if (s === 'running') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.dataset.status = s;
    Tooltip.set(spinner, 'running');
    return spinner;
  }
  const icon = svgIcon(STATUS_ICON[s] || NEUTRAL_ICON, 16, 'status-icon');
  icon.dataset.status = s;
  return icon;
}

// ---------- run view ----------

async function openRunView(runId, title) {
  // #155: a read-only project is locked whole — including the run a restored
  // session or a pasted URL points at. Gated before any state is touched.
  if (await readonlyGate()) { show('run'); return; }
  // Suite expand/collapse prefs are remembered per run for the session: reset
  // only when a DIFFERENT run opens (reopening the same run keeps the layout).
  if (state.runId !== runId) state.expandedSuites = {};
  state.runId = runId;
  if (title) state.runTitle = title;
  state.runStatus = null;
  state.runKind = null;
  state.substatusCounts = {}; // filled by the JWT probe below (#109)
  state.runInfo = {};         // Run info fields (#112): v2 detail below, JWT extras on the probe
  state.currentRecordId = null;
  // Nav state resets on every run open (FR-001/002).
  state.runFilter = 'all';
  state.runSearch = '';
  if ($('run-search')) $('run-search').value = '';
  show('run');
  const sk = Skeleton.show('run'); // the checklist's shape while both legs below are in flight
  if (typeof Onboarding !== 'undefined') Onboarding.markRun(); // onboarding step 3: first run opened
  setStatusLine('run-status', 'Loading tests…');
  if ($('run-meta-note')) $('run-meta-note').hidden = true;
  $('run-tests').replaceChildren();
  $('run-progress').replaceChildren(); // clear progress only — the Finish button is a sibling
  // …and with it the two pills that state the PREVIOUS run's kind and status:
  // both are repainted from the fetch below, and neither may describe the old run
  // while the new one loads.
  if ($('run-kind')) $('run-kind').hidden = true;
  if ($('run-state')) $('run-state').hidden = true;
  try {
    // Fetch run meta and the test list INDEPENDENTLY (Block 4): a failed meta
    // fetch must not blank the (fetchable) checklist — render the list and degrade
    // the header to the cached/'Run' title with a muted note. Only the test-list
    // leg is essential; its failure surfaces through handleApiError as before.
    const [detailRes, recordsRes] = await Promise.allSettled([
      TestomatAPI.getRun(runId),
      TestomatAPI.listTestruns(runId),
    ]);
    if (state.runId !== runId) return;
    if (recordsRes.status === 'rejected') throw recordsRes.reason;
    const detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
    const metaFailed = !detail;
    if (metaFailed) {
      state.runTitle = state.runTitle || 'Run'; // keep the cached title, else 'Run'
      state.runStatus = null;
      state.runKind = null; // no meta read → no kind pill (the header just degrades)
      state.runInfo = {};   // …and no Run info section either
    } else {
      state.runTitle = detail.clean_title || detail.title || state.runTitle;
      state.runStatus = detail.status || null; // 'running' while unfinished; terminal after finish
      state.runKind = detail.kind || null;     // v2 run detail carries `kind` (#111)
      state.runInfo = runInfoFromDetail(detail); // Run info base fields (#112)
    }
    // The header row is painted by show() above, off the title the runs list
    // passed in (or none, on a pasted URL) — repaint it now that the detail has
    // settled the real one.
    refreshContextBar();
    // v2 returns newest-first; run order = creation order = id ASC.
    state.records = recordsRes.value.sort((a, b) => (a.id > b.id ? 1 : -1));
    renderRunView();
    if ($('run-meta-note')) $('run-meta-note').hidden = !metaFailed;
    updateRunActions();      // hidden until the session probe confirms JWT
    startLiveSync();         // (re)start polling for this run — also clears an auth-stop (resume-on-Refresh)
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // run-open is a replay trigger
    loadSuiteEmoji(runId);   // fire-and-forget: the sections' custom marks, if the project set any
    // Fire-and-forget for the UI, but KEPT: a row write started before it settles
    // waits for it, because the archived flag arrives on it (#186 — see runStateProbe).
    runStateProbe = probeRunSession(runId);
  } catch (e) {
    handleApiError(e, 'run-status');
  } finally {
    Skeleton.hide(sk);
  }
}

// The in-flight probe for the OPEN run, or null before the first one (#186). The
// archived flag exists only on the JSON:API run detail this probe reads, so it
// lands one round-trip AFTER the run has rendered — a window in which the row
// buttons are live on a run that may turn out to be archived. Painting a lock
// while the answer is unknown was rejected: with a session in hand that is EVERY
// run open, so every tester would see "Run is archived — results are read-only"
// flash over a perfectly live run, which is precisely the dishonest reason this
// gate exists to prevent. So the paint stays truthful and the WRITE waits for the
// answer instead (writeRowStatus, clickStatus, finishRun). Overwritten on each
// open; never cleared, since awaiting a settled promise costs one microtask.
let runStateProbe = null;

// …but BOUNDED. Nothing in this extension sets a fetch timeout, so a probe that
// HANGS rather than fails — captive portal, black-holed TCP — would park the write
// forever: no spinner, no toast, and worst of all no error for the offline queue to
// catch, which is the one case the queue exists for. After the cap the write goes
// ahead on what it knows and fails honestly, exactly as it did before #186.
const PROBE_WAIT_MS = 2000;
const awaitRunState = () => (runStateProbe
  ? Promise.race([runStateProbe, sleep(PROBE_WAIT_MS)]).catch(() => {})
  : Promise.resolve());

// Best-effort session probe for the run view: loads project run-replies (US4),
// settles the finish-run button (US3), and paints the custom-status badges +
// per-run counters (#109). Degrades silently (an unavailable session leaves the
// email local-part fallback). Resolves as soon as the run detail has landed —
// assignee names are detached below, because a write must not wait on cosmetics.
async function probeRunSession(runId) {
  await loadProjectInfo();
  if (state.runId !== runId) return;
  capabilities.jwt = TestomatAPI.jwtAvailable() === true;
  applyCapabilities();
  updateRunActions();
  if (!capabilities.jwt) return;
  // Row badges are JWT-gated, so the first (pre-probe) paint carries none — repaint
  // the rows now that the session is known to be there (#109).
  if (state.records.some((r) => r.substatus) && state.view === 'run') renderRunSections();
  if (await refreshRunInfo(runId)) { paintRunProgress(); renderRunInfo(); applyRunLock(); }
  if (state.runId !== runId) return;
  probeRunAssignees(runId); // detached — see above
}

// Resolve the people this screen shows (FR-004) and re-render once they arrive.
// Split off the probe so the #186 write gate waits for the run detail only.
//
// The members map is fetched whenever the screen shows a PERSON at all: an
// assigned row, or a Run info person. It is what turns an address into a name —
// and the only read that carries the avatar, so a named person needs it too. One
// fetch, cached per project; both repaint off it.
//
// It is also read for the VIEWER's own row (#200): the profile timezone every Run
// info stamp renders in lives on the same member record, and a run with no person
// on it anywhere still shows stamps — so the read is unconditional now, and the
// person gate it used to carry would have left those runs on the machine's zone.
async function probeRunAssignees(runId) {
  await loadProjectUsers();
  if (state.runId === runId && state.view === 'run') { renderRunSections(); renderRunInfo(); }
}

// Re-read the JSON:API run detail: the custom-status counters (#109) and the four
// Run info fields v2 does not serialize (#112) — one request for both. JWT-only and
// best-effort: a failure leaves the last painted values rather than blanking them,
// and a stale response (run changed under us) is dropped. Returns true when state
// was updated and the caller should repaint.
async function refreshRunInfo(runId) {
  if (!capabilities.jwt) return false;
  try {
    const info = await TestomatAPI.getRunInfo(runId);
    if (state.runId !== runId) return false;
    applyRunInfo(info);
    return true;
  } catch {
    return false; // degrades silently — the header keeps whatever it had
  }
}

// Keep the finished signal fresh in BASIC mode (#152). Under a session the poll
// tick already re-reads the JSON:API run detail (refreshRunInfo), whose `status`
// and `finished-at` feed runFinished() — so this leg is for the token-only panel,
// which has no such read at all and would otherwise never learn that a colleague
// finished the run. The cheapest correct option is the very GET run open already
// makes: v2 `/runs/{id}`, once per poll interval, whose `status` IS terminal after
// a finish. Best-effort — a failure leaves the last known state rather than
// unlocking a run we simply couldn't re-read.
async function refreshRunFinished(runId) {
  if (capabilities.jwt) return;
  try {
    const detail = await TestomatAPI.getRun(runId);
    if (!detail || state.runId !== runId) return;
    state.runStatus = detail.status || null;
    applyRunInfo(runInfoFromDetail(detail)); // the v2 half of Run info rides along
  } catch { /* keep what we had */ }
}

// Fold a parsed JSON:API run payload into the open run's counters + info fields.
// Counters are only replaced when the payload actually carried them (see
// TestomatAPI.runInfoOf) — a write response that omits them must not blank them.
// `isArchived` follows the same rule for the same reason (#186): null means the
// payload didn't say, and an un-archive (false) must still land.
function applyRunInfo({ substatusCounts, isArchived, ...extras }) {
  if (substatusCounts) state.substatusCounts = substatusCounts;
  if (isArchived != null) state.runInfo.isArchived = isArchived;
  Object.assign(state.runInfo, extras); // merged over the v2 base fields
}

// ---- write locks: archived run (#186), finished run (#152), automated (#154) --
// One plumbing, three reasons. `runWriteLock()` answers "is the WHOLE run
// read-only, and why"; `recordWriteLock(record)` answers the same for one row,
// deferring to the run-level reason first. Every write path consults one of
// them, and `applyRunLock()` paints whatever they say onto the DOM.
//
// ---- finished run (#152)
// A finished run is FULLY read-only in the panel — owner decision, deliberately
// stricter than the web's own "Change result" affordance. The server checks no
// run state on any of these writes (the CI reporter writes into finished runs by
// design), so the panel is the only place the gate can live.
//
// Two independent signals, whichever is fresh:
//   * the v2 run status — 'running' while live, terminal after finish. The ONLY
//     signal basic mode has, refreshed by the livesync tick (refreshRunFinished);
//   * the JSON:API run detail's `status` / `finished-at`, which the JWT poll
//     already reads for the counters + Run info (#109/#112) and used to drop.
// `state.runStatus` is deliberately NOT overwritten from the JSON:API payload:
// the two vocabularies only have to agree about being terminal, not about the
// pre-finish value the Finish-run gate keys on.
const TERMINAL_RUN_STATUS = new Set(['passed', 'failed', 'terminated', 'finished']);
const runStatusTerminal = (s) => TERMINAL_RUN_STATUS.has(String(s || '').toLowerCase());

const RUN_LOCK_REASON = 'Run is finished — results are read-only';

function runFinished() {
  if (runStatusTerminal(state.runStatus)) return true;
  const info = state.runInfo || {};
  return runStatusTerminal(info.status) || !!info.finishedAt;
}

// ---- archived run (#186)
// The panel filters archived runs out of its lists, but an archived run is still
// reachable two ways — a pasted run URL (the archived filter sits on the INDEX,
// never on the show route, which answers 200) and a restored session, whose run
// may have been archived by anyone since the panel last closed. Every write then
// proceeds exactly as on a live run, and the server has no authorization check
// for archived runs at all (only list filtering), so the panel is the only place
// this can be stopped. The damage is silent rather than loud: `Run#calculate_counters`
// early-returns on an archived run, so a write leaves its counters permanently stale.
//
// Web parity: the run page drops the Finish / relaunch actions for an archived run
// (`extra-run-actions.hbs`) and shows an Archived badge — the panel's `finishRun`
// otherwise goes straight through, an action the web UI cannot even express.
//
// ONE signal, and it is session-only: `is-archived` on the JSON:API run detail
// (`RunSerializer`), refreshed on the same JWT poll read as #109/#112. The v2 run
// payload carries NO archived flag whatsoever, so BASIC MODE IS BLIND to this and
// deliberately stays that way — an inferred substitute (rungroup state, missing
// from the index) would be guesswork, and archiving a rungroup does not archive
// its runs anyway (`rungroup.rb` touches rungroups only).
const ARCHIVED_LOCK_REASON = 'Run is archived — results are read-only';

const runArchived = () => (state.runInfo || {}).isArchived === true;

// ---- automated result (#154)
// Web parity: the Ember runner refuses to open an automated run at all
// (routes/launch.js afterModel → redirect), and the server's own
// `Testrun#add_step!` returns early on an automated testrun while the controller
// still answers 200 — so an API client's step writes are silently swallowed.
// A result the CI reported is therefore display-only here, and the panel says so
// instead of offering a click that goes nowhere.
//
// Two granularities, because that is how the data comes:
//   * the RUN's `kind` (v2 run detail, `state.runKind`) — an automated run bars
//     every row, the not-yet-reported ones included: they are the reporter's to
//     fill, exactly as the web's redirect treats them;
//   * the ROW's own `automated` flag (verified live on the v2 testrun record) —
//     in a mixed run only those rows lock, the manual ones keep writing.
const AUTOMATED_LOCK_REASON = 'Automated result — read-only in the panel';

const runAutomated = () => String(state.runKind || '').toLowerCase() === 'automated';

// Is THIS record an automated result? The v2 row carries the flag; for the OPEN
// test the JSON:API detail carries the same field (renderSummaryFailure already
// splits on it), which keeps the gate right even if the list record is stale.
function recordAutomated(record) {
  if (!record) return false;
  if (record.automated === true) return true;
  return String(state.currentRecordId) === String(record.id)
    && state.testrunDetail?.data?.attributes?.automated === true;
}

// The RUN-level lock: '' = writable, otherwise the reason that holds for EVERY
// row of the run. Archived outranks finished outranks automated — an archived run
// is usually finished too, and the tester must be told the ACTUAL reason the panel
// refuses (an honest reason is the whole point of the gate). One reason per control
// is all there is room for. Outside a run there is nothing to lock.
function runWriteLock() {
  if (!state.runId) return '';
  if (runArchived()) return ARCHIVED_LOCK_REASON;
  if (runFinished()) return RUN_LOCK_REASON;
  if (runAutomated()) return AUTOMATED_LOCK_REASON;
  return '';
}

// The lock for ONE record — what every per-record write path consults. The
// run-level reason comes first (it is true of this row too), then the row's own
// automated flag. Only the run-wide surfaces (the run-level note, the test-view
// gates' fallback) read runWriteLock() directly.
function recordWriteLock(record) {
  return runWriteLock() || (recordAutomated(record) ? AUTOMATED_LOCK_REASON : '');
}

// Repaint every write control that is currently in the DOM onto the lock state.
// READ paths are untouched — this only disables and explains, so a finished run
// still renders in full.
//
// Deliberately driven by the STATE, not by a detected transition: more than one
// path can learn that the run finished (the poll tick, the run-session probe's
// own run-detail read, our own finish), and a flip-detecting version silently
// missed the paint whenever a path other than the one holding the "before" value
// got there first — measured, not theorised. So callers just call it, and the
// memo below keeps that free: identical state => nothing to do. `force` is for
// a rebuilt DOM, where the memo would otherwise skip a genuinely needed paint.
let lockPainted = null; // last signature painted into the DOM; null = never painted

// Everything the paint depends on, as one string: the run-level reason PLUS the
// set of rows locked on their own account (#154). Since the lock went per-record
// the reason alone is not enough — a reporter result landing in a mixed run flips
// one row mid-poll while the run-level reason stays '', and the old memo would
// have swallowed exactly that repaint.
function lockSignature(reason) {
  const rows = (state.records || []).filter(recordAutomated).map((r) => r.id).join(',');
  return `${reason} | ${rows}`;
}

function applyRunLock({ force = false } = {}) {
  const reason = runWriteLock();
  const signature = lockSignature(reason);
  if (!force && signature === lockPainted) return;
  lockPainted = signature;
  // Per ROW, not per run: a mixed run locks only its automated rows.
  document.querySelectorAll('#run-tests li.test-row').forEach((li) => applyRowLock(li));
  const note = $('run-lock-note');
  if (note) { note.textContent = reason; note.hidden = !reason; }
  updateRunActions();                                        // Finish run hides on the same signal
  if (typeof updateTestActionsState === 'function') updateTestActionsState(); // the test view's own controls
}

// Finish run is JWT-gated (FR-012) and only makes sense on an unfinished run:
// v2 run status is 'running' until finish, terminal (passed/failed) after —
// so a finished/reopened run never shows the button. Since #152 the fresh
// finished signal counts too, so a run a COLLEAGUE finished mid-session hides
// the button on the next poll tick instead of offering it forever.
// `jwtAvailable` is 'unknown' until a probe runs, so it also stays hidden in
// degraded mode and until the probe resolves.
// #186: an ARCHIVED run hides it too — a rerun-ed archived run is 'running' again,
// so the finished check alone would still offer a Finish the web UI removes.
function updateRunActions() {
  const btn = $('btn-finish-run');
  if (!btn) return;
  const jwt = TestomatAPI.jwtAvailable(); // 'unknown' | true | false
  const running = state.runStatus === 'running' && !runFinished() && !runArchived();
  // Hidden on a finished/non-running run, and until the probe settles ('unknown',
  // to avoid a flash). Under a degraded session it stays VISIBLE but disabled-
  // with-reason (Block 4) so the lost capability is legible instead of vanishing.
  btn.hidden = !running || jwt === 'unknown';
  const degraded = running && jwt === false;
  btn.disabled = degraded;
  Tooltip.set(btn, degraded
    ? `Finish run needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
    : '');
}

// In-panel confirm dialog (US3). Resolves true on confirm, false on cancel /
// Esc / backdrop dismiss. Listeners are added per call and torn down on close.
function confirmDialog(message, confirmLabel = 'Finish run') {
  const dlg = $('confirm-dialog');
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = confirmLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (val) => {
      $('confirm-ok').removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    $('confirm-ok').addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel); // Esc / backdrop
  });
}

// Let queued step writes and any in-flight status save settle before finalizing
// the run (spec edge case: finish while writes are pending). Step writes are
// serialized on stepWriteChain; a status save flips state.saving.
async function settlePendingWrites() {
  await Promise.resolve(stepWriteChain).catch(() => {});
  for (let i = 0; i < 200 && (state.saving || state.inlineWrites > 0); i++) await sleep(25);
  await Promise.resolve(stepWriteChain).catch(() => {});
}

// Is finishing barred right now, and why? Mirrors what updateRunActions() hides the
// button on — deliberately NOT runWriteLock(), which would also bar an automated run:
// updateRunActions() has never consulted runAutomated(), so that would render a
// visible Finish button that then refuses itself (#154 gates results, not the run).
// Pinned by 46-archived-readonly's automated-run case, since nothing else does.
function finishBlockedReason() {
  if (runArchived()) return ARCHIVED_LOCK_REASON;
  if (runFinished()) return RUN_LOCK_REASON;
  return '';
}

async function finishRun() {
  if (!state.runId) return;
  // #186: the button's visibility is NOT a sufficient gate. updateRunActions() runs
  // inside the session probe BEFORE the archived flag lands, so Finish is live on an
  // archived+running run for that sub-window — and finishing a run is the one action
  // the web UI removes outright for an archived run. Checked on BOTH sides of the
  // dialog, because the confirm can sit open for as long as the tester likes.
  await awaitRunState();
  let blocked = finishBlockedReason();
  if (blocked) { applyRunLock({ force: true }); toast(blocked); return; }
  const ok = await confirmDialog('Finish run? Pending tests will be marked skipped.');
  if (!ok) return; // dismissed = no-op (US3 AC-3)
  blocked = finishBlockedReason();
  if (blocked) { applyRunLock({ force: true }); toast(blocked); return; }
  const btn = $('btn-finish-run');
  if (btn) btn.disabled = true;
  setStatusLine('run-status', 'Finishing run…');
  try {
    await settlePendingWrites();
    // The finish PUT answers with the updated run — its terminal status, duration
    // and finished-at feed Run info (#112) straight from the write, no re-read.
    applyRunInfo(TestomatAPI.runInfoOf(await TestomatAPI.finishRun(state.runId)));
    // v2 run counts lag (async) — re-read testruns as the authoritative source.
    const records = await TestomatAPI.listTestruns(state.runId);
    state.records = records.sort((a, b) => (a.id > b.id ? 1 : -1));
    state.runStatus = 'finished';  // any non-'running' value hides the button
    renderRunView();               // pending rows now render as skipped
    setStatusLine('run-status', 'Run finished ✓', 'ok');
  } catch (e) {
    handleApiError(e, 'run-status', { inlineAuth: true }); // stay in the run on an expired session
    if (!isAuthError(e)) toast(`Finish failed: ${e.message}`, { error: true });
  } finally {
    if (btn) btn.disabled = false;
    updateRunActions();
  }
}

function displayStatus(record) {
  const s = record?.status;
  return s && s !== 'pending' ? s : 'untested';
}

// User-facing badge/label for an internal status key (class name keeps the key).
const statusLabel = (status) => (status === 'untested' ? 'pending' : status);

function progressNodes() {
  const total = state.records.length;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const r of state.records) {
    const s = displayStatus(r);
    if (counts[s] !== undefined) counts[s] += 1;
  }
  const done = counts.passed + counts.failed + counts.skipped;

  // `4/6` first, then only the tallies that HAPPENED, each tinted like the
  // segment of the bar it explains: the line is read at a glance next to the bar,
  // and "0 skipped" in a run with no skips is a word the eye has to reject before
  // it gets to the two that matter. The done/total figure always stands, zero
  // included — that one IS the progress.
  const line = document.createElement('div');
  line.className = 'hint counts';
  const fraction = document.createElement('span');
  fraction.className = 'counts-done';
  fraction.textContent = `${done}/${total}`;
  line.append(fraction);
  for (const key of ['passed', 'failed', 'skipped']) {
    if (!counts[key]) continue;
    const part = document.createElement('span');
    part.className = `counts-part ${key}`;
    part.textContent = `${counts[key]} ${key}`;
    line.append(document.createTextNode(' · '), part);
  }
  const bar = document.createElement('div');
  bar.className = 'progress';
  for (const [key, cls] of [['passed', 'p'], ['failed', 'f'], ['skipped', 's']]) {
    const seg = document.createElement('div');
    seg.className = cls;
    seg.style.width = total ? `${(counts[key] / total) * 100}%` : '0';
    bar.append(seg);
  }
  return [line, bar];
}

// Per-run custom-status counters (#109), appended to the run header's counts line
// as `· Product Bug: 3 · Test Issue: 1`. Run header ONLY — the test view reuses
// progressNodes() and stays a plain status line. JWT-gated exactly like the badges
// and the in-test select; nothing is appended in basic mode or when the run has no
// substatus. Ordered by count DESC then name ASC (the server's grouping order is
// not guaranteed, and a jumping header reads as flicker).
function appendSubstatusCounts(line) {
  if (!capabilities.jwt) return;
  const entries = Object.entries(state.substatusCounts || {})
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  if (!entries.length) return;
  const group = document.createElement('span');
  group.className = 'substatus-counts';
  Tooltip.set(group, 'Custom statuses set in this run');
  for (const [name, count] of entries) {
    const item = document.createElement('span');
    item.className = 'substatus-count';
    item.dataset.substatus = name;
    item.textContent = `${name}: ${count}`;
    // NBSP after the separator: when the band wraps, the `·` travels down with its
    // counter instead of dangling at the end of the status-counts line.
    group.append(document.createTextNode(' · '), item);
  }
  line.append(group);
}

// Progress lives in #run-progress (the left of the slim header band); the Finish
// run button is a sibling in the same band, so a progress repaint never wipes it.
function paintRunProgress() {
  const nodes = progressNodes();
  appendSubstatusCounts(nodes[0]); // the .counts line — counters extend it inline
  $('run-progress').replaceChildren(...nodes);
}

// The run's kind in the slim header band (#111), in the mark's LABEL form —
// the square WITH its word, which is what a surface takes when it has the room
// and no title beside it to lean on. (A list row takes the square alone; see
// runs-list.js.) Hidden when the run-meta read failed or the kind is unknown,
// so the band keeps its layout either way.
function paintRunKind() {
  const el = $('run-kind');
  if (!el) return;
  const badge = kindBadge(state.runKind); // the mark's label form (glyph + word)
  el.replaceChildren(...(badge ? [badge] : []));
  el.hidden = !badge;
}

// The run's own status, as the LABEL form of the status mark (`.status-label`:
// glyph + word, the library's `label=on` variant) in the summary card's state
// row. It used to live only in the folded field table, where "how did this run
// end" — the first question the header is asked — was one click away.
// Two sources, the fresher first: the JSON:API detail's `status` (what Run info
// reads) then the v2 run status basic mode has.
// Hidden when neither answered, so the row keeps its shape.
//
// The mark, not a `.badge`: this chip stands beside the kind chip, and the two
// are marks of one family — same 20px box, same corner — rather than a mark and
// a pill. A running run brings the loader in place of the glyph, which is the
// same swap every other status surface in the panel makes (statusIcon above).
const RUN_STATE_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };
function paintRunState() {
  const el = $('run-state');
  if (!el) return;
  const status = state.runInfo?.status || state.runStatus || '';
  el.replaceChildren();
  el.hidden = !status;
  if (!status) return;
  el.className = `status-label ${RUN_STATE_TINT[normStatus(status)] || 'neutral'}`;
  Tooltip.set(el, `Run status: ${status}`);
  const label = document.createElement('span');
  label.textContent = status;
  el.append(statusIcon(status), label);
}

function renderRunHeader() {
  paintRunKind();
  paintRunState();
  paintRunProgress();
  // Refresh the contextual row's title — NOT `show('run')`, which is a view
  // SWITCH: this runs whenever the run re-renders, including from a poll tick
  // and from a run-open whose fetch lands after the tester already opened a row,
  // and it threw them back out of the test they were reading (#215).
  refreshContextBar();
}

// ---- Run info (#112) ------------------------------------------------------
// The web run page's details sidebar (front run-summary.hbs), folded into one
// disclosure under the slim header: same fields, same order, empty ones skipped.
// Two sources, no extra fetch: Status / Tests / Created / Description ride the v2
// run detail run-view already reads (so they survive basic mode), and Duration /
// Executed / Started / Build URL ride the JSON:API read the substatus counters
// already make (JWT-only — those four rows are simply absent in basic mode).

// Open by default: the fields are what a reader opens a run for, so the first
// look shows them rather than a word to click. From there the choice is the
// USER'S — the toggle writes it to the persisted session (core/storage.js), and
// app.js restores it at boot, so a panel reopened tomorrow looks like the one
// they left. Only an explicit close reads as closed (`!== false`), so a profile
// that predates the key opens.
let runInfoOpen = true;

// The v2 half of the fields. Kept verbatim; formatting/skipping happens at render.
function runInfoFromDetail(detail) {
  const info = {
    status: detail.status || null,
    // v2 show merges response_test_counts — `total_tests` is the authoritative
    // count there (`tests_count` is the pre-merge value on the same payload).
    testsCount: Number(detail.total_tests ?? detail.tests_count),
    createdAt: detail.created_at || null,
    description: typeof detail.description === 'string' ? detail.description.trim() : '',
  };
  // Whoever the flat v2 payload names, in its own snake_case spelling — so the
  // people rows survive basic mode when v2 carries them. Read exactly as
  // defensively as the JSON:API half (api.js runPeopleOf): the spellings we have
  // seen first, then any key that MEANS the same thing, and a key that says
  // nothing is left off — never written as null over what a read already found.
  const executedBy = UserCell.normalize(detail.executed_by ?? detail.launched_by ?? detail.user)
    || flatPeople(detail, /^(executed|launched|started|ran)(_by)?$/)[0];
  const createdBy = UserCell.normalize(detail.created_by ?? detail.author ?? detail.owner)
    || flatPeople(detail, /^(created_by|creator|author|owner)$/)[0];
  const assignees = flatPeople(detail, /assign/);
  if (executedBy) info.executedBy = executedBy;
  if (createdBy) info.createdBy = createdBy;
  if (assignees.length) info.assignees = assignees;
  // WHERE it ran and WHAT it covers. Both are v2's own fields (`to_response_hash`
  // serves env + plans — verified live), so both survive basic
  // mode like status/tests/created/description — no second read pays for them.
  // Written only when the payload said something, the same bargain the people
  // above take: an omitting read must not blank what an earlier one found.
  const envs = envList(detail.env);
  const plans = planList(detail.plans ?? detail.plan ?? detail.test_plans ?? detail.test_plan);
  if (envs.length) info.envs = envs;
  if (plans.length) info.plans = plans;
  return info;
}

// A run's environments as the LIST they are: v2 sends them as an array on some
// routes and as one comma-joined string on others (api.js `normEnv` joins the
// array for the runs list), and both name the same handful of answers. Same
// split the runs list does under a run's title (runs-list.js `envTags`).
function envList(env) {
  const raw = Array.isArray(env) ? env : String(env ?? '').split(',');
  return raw.map((one) => String(one ?? '').trim()).filter(Boolean);
}

// The test plans a run covers. Nothing pins their shape on the flat payload — a
// title, a record, or a bare id — so this reads as defensively as flatPeople
// above and on the same bargain: an entry that does not NAME a plan contributes
// nothing, rather than a field reading "4831".
function planList(plans) {
  const out = [];
  for (const one of Array.isArray(plans) ? plans : (plans == null ? [] : [plans])) {
    const title = typeof one === 'string' ? one.trim()
      : String(one?.title || one?.clean_title || one?.name || '').trim();
    if (title) out.push(title);
  }
  return out;
}

// Everyone a FLAT payload names under a key that means what we are asking for —
// the v2 twin of api.js `peopleByKey`, and the same bargain: a key whose name
// matches counts only if what it holds is person-shaped, so `assignee_ids: [3,7]`
// contributes nobody rather than two people called 3 and 7.
//
// …including the two person-shaped things that are NOT people, which the JSON:API
// half refuses by the same pair of tests (api.js SETTING_KEY / NOBODY): a SETTING
// about assigning ("assign_mode": "none" is a strategy, and this drew it as a
// tester called none, monogram NO — the run info screenshot on #112), and the word
// a payload uses for nobody. Neither can drop a real person: somebody actually
// assigned arrives with an address, under a key that names people rather than a
// switch.
const FLAT_SETTING_KEY = /(strategy|mode|policy|method|kind|type|option|enabled|state|status|auto|allow)/i;
const FLAT_NOBODY = /^(none|nobody|no[-_\s]?one|unassigned|not[-_\s]?assigned|n\/?a|null|nil|false|true|any|all|auto|everyone|manual)$/i;
function flatPeople(obj, pattern) {
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    if (!pattern.test(key) || /(^|_)ids?$|count/i.test(key)) continue;
    if (FLAT_SETTING_KEY.test(key)) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      const u = UserCell.normalize(one);
      if (!u) continue;
      if (!u.email && !/\p{L}/u.test(u.name)) continue;
      if (!u.email && FLAT_NOBODY.test(u.name.trim())) continue;
      out.push(u);
    }
  }
  return out;
}

// Web parity (#200): a stamp renders in the ACCOUNT PROFILE timezone, exactly like
// the web's <DateTime> (`dayjs(t).tz(user.timezone || dayjs.tz.guess()).format('lll')`,
// date-time.js) — NOT in the machine's zone, which had the panel and the web reading
// the same run hours apart in two windows side by side. `lll` is en `MMM D, YYYY h:mm A`
// ("Feb 12, 2026 10:06 PM"); en-US puts a comma before the hour too, so the string is
// assembled from the parts. `timeZone` null/unknown (or a zone Intl rejects) falls back
// to the browser's — the web's own guess. null on an unparseable value.
function formatTimeIn(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', timeZone ? { ...opts, timeZone } : opts).formatToParts(d);
  } catch { parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d); }
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

// A timestamp cell: the web's `lll` in the viewer's profile zone, with the exact
// stamp on the tooltip (the web's <DateTime> does the same). null on an absent or
// unparseable value, which drops the whole row.
function runInfoTime(iso) {
  if (!iso) return null;
  const text = formatTimeIn(iso, viewerTimezone());
  if (!text) return null;
  const span = document.createElement('span');
  span.className = 'run-info-time';
  span.dataset.time = iso; // the raw stamp, zone- and locale-free
  Tooltip.set(span, iso);
  span.textContent = text;
  return span;
}

// The CI build link. Only http(s) is rendered — the value is server data, and a
// `javascript:` URL behind a click is exactly the hole an href must not open.
function ciBuildLink(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(raw)) return null;
  const a = document.createElement('a');
  a.className = 'run-info-link';
  a.href = raw;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  Tooltip.set(a, raw);       // the raw URL is a tooltip, never the label (#112)
  a.append('Open CI build ', svgIcon('open_in_new', 14, 'link-out-icon'));
  return a;
}

// A LIST of words as one value — where the run ran, which plans it covers. The
// pill is the library's (`.badge.env`, shared/components.css → ENV): the very
// one the runs list draws under a run's title, so "MacOS, beta, Chrome" is three
// answers on both screens instead of one long string here and three pills there.
// The whole string rides the tooltip, because a pill too long for the panel is
// cut rather than widening the field. Nothing to show → null → the row is skipped.
function runInfoTags(list) {
  if (!list.length) return null;
  const box = document.createElement('span');
  box.className = 'env-tags';
  for (const name of list) {
    const pill = document.createElement('span');
    pill.className = 'badge env';
    pill.textContent = name;
    Tooltip.set(pill, name);
    box.append(pill);
  }
  return box;
}

// Status value: the library's TEXT form of a run status (shared/components.css
// → RUN STATUS) — the run's own glyph with the word beside it, printed in the
// status' own colour. The chip form belongs to the header above; down here the
// status is one value among facts, and the colour is what carries it.
function runInfoStatus(status) {
  const span = document.createElement('span');
  span.className = 'status-text';
  span.dataset.status = normStatus(status);
  span.append(statusIcon(status));
  const label = document.createElement('span');
  label.textContent = status;
  span.append(label);
  return span;
}

// A person value: the shared monogram + name (shared/user-cell.js). Whoever the
// run payload named is resolved through the project's members first — the same
// map the assignee rows read, so one tester is spelled one way everywhere, and
// so the field gets the PICTURE, which only the members read carries (the run
// payload names people, it does not describe them). What the payload said wins
// where it said anything; the member row fills the rest, and an address nobody
// in the project answers to falls back to its local part.
function runInfoUser(person) {
  const u = UserCell.normalize(person);
  if (!u) return null;
  const member = u.email ? assigneeUser(u.email) : null;
  return UserCell.cell({
    name: u.name || member?.name || assigneeName(u.email),
    email: u.email || member?.email || '',
    avatar: u.avatar || member?.avatar || '',
  });
}

// "Assigned to": everyone this run is on, from BOTH places the answer lives —
// the run's own assignees (api.js runAssigneesOf, JWT) and whoever its rows are
// assigned to. Neither alone is the web's list: a run can be handed to a tester
// who holds no row yet, and a row can be handed to somebody the run itself never
// named. The union is what the web prints, and it costs no request — the run
// half rides the detail read, the rows half is the checklist already in state,
// so a re-assignment shows on the next paint.
// Each person appears once, keyed by address (the only identity both halves
// share), run-level names first; a run nobody has taken has no row at all.
function runInfoAssignees() {
  const people = [...(state.runInfo?.assignees || []), ...state.records.map((r) => r.assigned_to)];
  const seen = new Set();
  const cells = [];
  for (const person of people) {
    const u = UserCell.normalize(person);
    if (!u) continue;
    const key = (u.email || u.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = runInfoUser(u);
    if (cell) cells.push(cell);
  }
  if (cells.length === 0) return null;
  const box = document.createElement('span');
  box.className = 'user-cells';
  box.append(...cells);
  return box;
}

// A people list that has run out of room drops to the coin stack — the
// monograms alone, overlapped (`.user-cells.is-stacked`). It is a MEASUREMENT,
// not a head count: two long names wrap in a 400px panel where four short ones
// would not, and the panel is resizable, so the answer is whatever the layout
// just did. The test is "did it take a second line" — the list wraps rather than
// overflowing, so a box taller than one of its cells is a box that did not fit.
// Needs a visible body, like the description measure below; a stacked list is
// left alone (each render builds unstacked cells, so the next paint re-decides).
function measureRunInfoPeople() {
  const body = $('run-info-body');
  if (!body || body.hidden) return;
  for (const box of body.querySelectorAll('.user-cells:not(.is-stacked)')) {
    const first = box.firstElementChild;
    if (!first) continue;
    if (box.getBoundingClientRect().height > first.getBoundingClientRect().height + 1) {
      box.classList.add('is-stacked');
    }
  }
}

// Description (#159): a reporter can write a whole session report here, and the
// unclamped text buried every other field. The value renders clamped to its first
// lines with an inline expander; collapsed on every paint, nothing remembers it.
function runInfoDescription(text) {
  const el = document.createElement('div');
  el.className = 'run-info-desc-text is-clamped';
  el.textContent = text;
  return el;
}

// The expander itself, bound to the clamp it uncovers.
function runInfoDescExpander(text) {
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'link-btn run-info-desc-more';
  more.textContent = 'Show more';
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    const clamped = text.classList.toggle('is-clamped');
    more.textContent = clamped ? 'Show more' : 'Show less';
    more.setAttribute('aria-expanded', clamped ? 'false' : 'true');
  });
  return more;
}

// The expander is added only once a measurement proves the clamp hides something,
// which needs the section open — a hidden body has no layout to measure. Once the
// tester has expanded the text the button stays; the next render rebuilds both.
function measureRunInfoDesc() {
  const body = $('run-info-body');
  if (!body || body.hidden) return;
  const text = body.querySelector('.run-info-desc-text');
  if (!text || !text.classList.contains('is-clamped')) return;
  if (text.scrollHeight <= text.clientHeight + 1) return; // sub-pixel line heights
  if (!text.parentElement.querySelector('.run-info-desc-more')) {
    text.after(runInfoDescExpander(text));
  }
}

// Ordered [label, value] pairs; a null/empty value drops its row entirely.
function runInfoRows() {
  const info = state.runInfo || {};
  const started = runInfoTime(info.launchedAt);
  const finished = runInfoTime(info.finishedAt);
  const rows = [];
  if (info.status) rows.push(['Status', runInfoStatus(info.status)]);
  // Duration is seconds here (RunSerializer), ms in humanDuration — and 0 on an
  // unfinished run, which formats to '' and skips the row, like the web.
  if (info.duration > 0) rows.push(['Duration', humanDuration(info.duration * 1000)]);
  // The run's own count, but never below the checklist the band is counting: the
  // server's count trails the rows for a beat after a run is created, and "Tests 2"
  // under a "0/3" progress line reads as a bug.
  const tests = Math.max(Number(info.testsCount) || 0, state.records.length);
  if (tests > 0) rows.push(['Tests', String(tests)]);
  // What qualifies that count — where the run ran and which plan it covers, in
  // the web's own order (Environment then Test plan, under Tests). Environment
  // is a LIST (a run can carry several) and is drawn as one, pills; the plan is
  // a single name and reads as plain text, the way the web sidebar prints it —
  // a value, not a tag.
  const envs = runInfoTags(info.envs || []);
  if (envs) rows.push(['Environment', envs]);
  if (info.plans && info.plans.length) rows.push(['Test plan', info.plans.join(', ')]);
  // Web parity: a finished run shows the executed span, a live one just its start.
  if (started && finished) {
    const span = document.createDocumentFragment();
    // Bare glyph: the row is a flex line now (`.kv.rows`), so the space either
    // side of the arrow is the cell's own gap rather than two typed spaces.
    span.append(started, '→', finished);
    rows.push(['Executed', span]);
  } else if (started) {
    rows.push(['Started', started]);
  }
  // Who ran it and who made it — the two people the web prints beside those
  // dates, each row skipped when the payload named nobody (api.js runPeopleOf).
  const executedBy = runInfoUser(info.executedBy);
  if (executedBy) rows.push(['Executed by', executedBy]);
  // …and who is holding the tests, from the checklist itself.
  const assignees = runInfoAssignees();
  if (assignees) rows.push(['Assigned to', assignees]);
  const link = ciBuildLink(info.ciBuildUrl);
  if (link) rows.push(['Build URL', link]);
  // Who made it and when, as ONE row — the web's own "Created by <person>,
  // <date>". They were two rows saying half a sentence each, and the person half
  // vanished on any payload that did not name a creator, leaving a lone date
  // under a label that no longer explained it. Nobody named → the date alone,
  // under the label it had.
  const created = runInfoTime(info.createdAt);
  const createdBy = runInfoUser(info.createdBy);
  if (createdBy) {
    const made = document.createDocumentFragment();
    made.append(createdBy);
    if (created) made.append(created);
    rows.push(['Created by', made]);
  } else if (created) {
    rows.push(['Created', created]);
  }
  if (info.description) rows.push(['Description', runInfoDescription(info.description)]);
  return rows;
}

function renderRunInfo() {
  const box = $('run-info');
  const body = $('run-info-body');
  if (!box || !body) return;
  paintRunState(); // the same fields feed the card's status pill — repaint together
  const rows = runInfoRows();
  box.hidden = rows.length === 0; // nothing read (meta failed) → no empty section
  body.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.append(value);
    if (label === 'Description') dd.classList.add('run-info-desc');
    body.append(dt, dd);
  }
  paintRunInfo();
}

// Apply the remembered open/closed state to the head + body.
function paintRunInfo() {
  const head = $('run-info-head');
  const body = $('run-info-body');
  if (head) head.setAttribute('aria-expanded', runInfoOpen ? 'true' : 'false');
  if (body) body.hidden = !runInfoOpen;
  // Both measures need a VISIBLE body — a hidden one has no layout to read.
  measureRunInfoPeople(); // names, or the coin stack when they do not fit
  measureRunInfoDesc();   // …and whether the description is hiding anything
}

function toggleRunInfo() {
  runInfoOpen = !runInfoOpen;
  paintRunInfo();
  persistSession(); // the user's choice outlives this panel (#112)
}

function renderTestProgress() {
  $('test-progress').replaceChildren(...progressNodes());
}

// ---- run-view navigation (004): status chips + search + suite sections ----

// Status filter chips (US1/FR-001): single-select; `pending` presents as
// Pending (via displayStatus). Counts are over the WHOLE run, never narrowed by
// the search. Reset to All on every run open.
const RUN_STATUS_FILTERS = [
  ['all', 'All'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped'],
  ['untested', 'Pending'],
];
const RUN_FILTER_KEYS = new Set(RUN_STATUS_FILTERS.map(([k]) => k));
// The tint each filter's COUNT wears (shared/components.css: a `.counter`
// takes the same status words as a badge does). Only the three that ARE a
// result are coloured — All is every row and Pending is the absence of one, so
// both stay the default neutral.
const RUN_FILTER_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

function runStatusCounts() {
  const counts = { all: state.records.length, passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const r of state.records) {
    const s = displayStatus(r);
    if (counts[s] !== undefined) counts[s] += 1;
  }
  return counts;
}

const matchesRunFilter = (r) => state.runFilter === 'all' || displayStatus(r) === state.runFilter;

// Case-insensitive substring over test + suite titles (FR-002).
function matchesRunSearch(r) {
  const q = state.runSearch.trim().toLowerCase();
  if (!q) return true;
  return (r.test_title || '').toLowerCase().includes(q) || (r.suite_title || '').toLowerCase().includes(q);
}

const rowVisible = (r) => matchesRunFilter(r) && matchesRunSearch(r);

// Suite key for grouping: the title, or the "No suite" sentinel for bare rows.
const NO_SUITE = '__none__';
const suiteKeyOf = (r) => (r.suite_title ? r.suite_title : NO_SUITE);

// Sections by suite_title in first-appearance order, run order (id ASC) within.
// Structure is built from ALL records; callers filter rows per section.
function suiteSections() {
  const order = [];
  const map = new Map();
  for (const r of state.records) {
    const k = suiteKeyOf(r);
    if (!map.has(k)) { map.set(k, { key: k, title: r.suite_title || null, rows: [] }); order.push(k); }
    map.get(k).rows.push(r);
  }
  return order.map((k) => map.get(k));
}

// ---- custom suite emoji, for the sections above ----
// A run's rows name their suite by TITLE and nothing else: `/testruns` carries
// `suite_title`, no suite id and no emoji (verified live). So the
// custom mark has to come off the SUITE TREE, the one place the panel can read
// it — indexed title → emoji, re-read whenever a run opens or the Tests screen
// reloads the tree. A duplicate title anywhere in the tree
// keeps the first node's emoji: two suites of the same name are already one
// section in this view, so the map cannot be more precise than the grouping is.
//
// The map has a NULL prototype: its keys are suite titles a project chose, and
// on a plain object a suite honestly called "constructor" or "toString" would
// answer the lookup below with something off Object.prototype — a function
// printed where an emoji belongs.
function indexSuiteEmoji(nodes, into) {
  for (const n of nodes || []) {
    if (n.title && n.emoji && !(n.title in into)) into[n.title] = n.emoji;
    indexSuiteEmoji(n.children, into);
  }
  return into;
}

const suiteEmojiOf = (title) => (title && state.suiteEmoji ? state.suiteEmoji[title] || null : null);

// Index a tree into that map. Anyone who fetches the suite tree calls this — the
// run view below, and the Tests screen every time it reloads its own tree
// (screens/tc-studio.js) — so the two screens cannot end up naming one suite two
// different ways. Wholesale replacement, not a merge: a mark the project TOOK
// AWAY has to disappear here too, and a merge would keep it forever.
function rememberSuiteEmoji(roots) {
  state.suiteEmoji = indexSuiteEmoji(roots, Object.create(null));
}

// Fire-and-forget: paint whatever is already known, then re-read the tree and
// paint again if it says something else. Stale-while-revalidate, because the
// mark is the project's to change: a suite that gets an icon (or loses one)
// while the panel is open would otherwise keep the mark it wore when this
// session started, until the tester happened to switch projects.
//
// In place, not a re-render — the mark lands while a tester is already reading
// the checklist, and a full repaint there would throw away whatever row they
// were part-way through. Silent on failure: the tree is the JWT leg, and a run
// is perfectly readable with the default glyphs.
async function loadSuiteEmoji(runId) {
  // The Tests tab may already be holding the very same tree — draw from it at
  // once rather than making the sections wait a round trip for a mark the panel
  // has in memory.
  if (!state.suiteEmoji && state.tcSuites?.length) rememberSuiteEmoji(state.tcSuites);
  if (state.suiteEmoji) paintSuiteEmoji();
  let roots;
  try { roots = await TestomatAPI.getSuiteTree(); } catch { return; }
  if (state.runId !== runId) return; // a different run (or none) is on screen now
  rememberSuiteEmoji(roots);
  paintSuiteEmoji();
}

// Bring every section's mark up to what the index now says. `dataset.suite` is
// the section's key, which IS the suite title (or the "No suite" sentinel, which
// no tree node can match).
//
// Both directions: a suite that gained an emoji takes it, and one whose emoji
// was removed goes back to the suite glyph. The icon that would be drawn now is
// built and compared with the one standing there — same mark, no replacement, so
// a repaint that changes nothing does not touch the DOM.
function paintSuiteEmoji() {
  for (const sec of document.querySelectorAll('#run-tests .suite-section')) {
    const slot = sec.querySelector('.suite-head .file-icon');
    if (!slot) continue;
    const next = treeIcon(FILE_ICON, 'file-icon', suiteEmojiOf(sec.dataset.suite));
    if ((slot.dataset.emoji || '') !== (next.dataset.emoji || '')) slot.replaceWith(next);
  }
}

// Render-order sequence of ALL records (sections in first-appearance order, run
// order within) — the traversal anchor; collapse is ignored (presentation only).
function orderedRecords() {
  const seq = [];
  for (const sec of suiteSections()) seq.push(...sec.rows);
  return seq;
}

// The visible sequence: render order with the filter + search applied (FR-005).
const visibleRecords = () => orderedRecords().filter(rowVisible);

// Updated, not rebuilt — the runs list's row works the same way and for the same
// reason (see renderFilterChips in screens/runs-list.js). It matters more here,
// if anything: these counts move every time a test is marked and on every
// livesync poll, so this row re-renders while the tester is looking straight at
// it. Only the figures change, and they fade rather than snap (paintCounter).
function renderRunFilterChips() {
  const bar = $('run-filter');
  if (!bar) return;
  const counts = runStatusCounts();
  for (const [key, label] of RUN_STATUS_FILTERS) {
    let chip = bar.querySelector(`[data-filter="${key}"]`);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      // The same plain library button the runs list wears, from the same
      // component (shared/components.css → FILTERS) — no chip modifier of its
      // own. Whatever doesn't fit the row leaves it entirely for the `⋯` menu
      // (fitFilterChips, core/views.js).
      chip.className = 'btn secondary size-sm filter-chip';
      chip.dataset.filter = key;
      const text = document.createElement('span');
      text.className = 'filter-label';
      text.textContent = label;
      const count = document.createElement('span');
      count.className = `counter${RUN_FILTER_TINT[key] ? ` ${RUN_FILTER_TINT[key]}` : ''}`;
      chip.append(text, count);
      chip.addEventListener('click', () => setRunFilter(key));
      bar.append(chip);
    }
    const on = state.runFilter === key;
    chip.classList.toggle('selected', on);
    chip.classList.toggle('secondary', !on);
    chip.setAttribute('aria-pressed', String(on));
    paintCounter(chip.querySelector('.counter'), counts[key] ?? 0);
  }
  fitFilterChips(bar);
}

// Single-select the chip and re-render the sections (in-memory; not persisted).
function setRunFilter(key) {
  if (!RUN_FILTER_KEYS.has(key)) key = 'all';
  if (state.runFilter === key) return;
  state.runFilter = key;
  renderRunFilterChips();
  renderRunSections();
}

// Reflect the search state onto the input + clear button (called on full render;
// the input itself drives state via its own listener, so it is left untouched
// during typing). openRunView is the only place that resets the value.
function syncRunSearch() {
  const input = $('run-search');
  const clear = $('run-search-clear');
  if (input && input.value !== state.runSearch) input.value = state.runSearch;
  if (clear) clear.hidden = state.runSearch === '';
}

function onRunSearch() {
  state.runSearch = $('run-search').value;
  $('run-search-clear').hidden = state.runSearch.trim() === '';
  renderRunSections();
}

function clearRunSearch() {
  $('run-search').value = '';
  state.runSearch = '';
  $('run-search-clear').hidden = true;
  renderRunSections();
  $('run-search').focus();
}

// (The custom-status pill (#109) and the assignee chip used to be built here,
// for the row's second line. The row is one line now — status, priority, type,
// title — and neither is on it: the custom status hangs off the status mark it
// refines (statusTip), and the assignee is left to the OPEN test, where its
// select lives and where it is written. The custom status has a pill of its own
// there too.)

// Inline status buttons (checklist mode): always-visible compact ✓/✗/– after the
// badge, drawn as icons — an SVG centers geometrically in the circle where the
// old text glyphs drifted off-center with font metrics (owner-reported).
const ROW_STATUS_BTNS = [
  ['passed', 'check', 'Mark passed'],
  ['failed', 'close', 'Mark failed'],
  ['skipped', 'remove', 'Mark skipped'],
];
const ROW_BTN_LABEL = Object.fromEntries(ROW_STATUS_BTNS.map(([status, , label]) => [status, label]));

// The always-visible inline status buttons for a run-view row. Each writes its
// own record — parametrized example rows are separate records, so they get their
// own buttons for free. Clicks never open the test (stopPropagation); the button
// matching the row's current status is highlighted.
function rowStatusButtons(r, li) {
  const group = document.createElement('span');
  group.className = 'row-actions';
  // #152/#154: a finished run — or an automated result — renders read-only.
  const lock = recordWriteLock(r);
  for (const [status, icon, label] of ROW_STATUS_BTNS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn icon size-xs row-st';
    btn.dataset.status = status;
    btn.append(svgIcon(icon, 14));
    btn.disabled = !!lock;
    Tooltip.set(btn, lock || label);
    btn.setAttribute('aria-label', label);
    if (r.status === status) btn.classList.add('active');
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); writeRowStatus(r, status, li); });
    group.append(btn);
  }
  return group;
}

// Paint the lock onto one row's ✓/✗/– buttons (#152, per-record since #154). The
// row itself stays clickable — opening the test to READ it is exactly what a
// finished or automated result is for; only the write buttons go dead, with the
// reason on their tooltip (the run view's own inline note carries it in text when
// it holds for the WHOLE run; rows have no room for three copies).
// The default reason is the row's own — a mixed run locks only some of its rows.
function applyRowLock(li, reason = recordWriteLock(recordFor(li.dataset.recordId))) {
  li.querySelectorAll('.row-actions .row-st').forEach((b) => {
    b.disabled = !!reason;
    Tooltip.set(b, reason || ROW_BTN_LABEL[b.dataset.status] || '');
  });
}

// What a checklist row is called, with the fallbacks a record without a title
// needs.
const rowTitle = (r) => r.test_title || (r.test_id ? `Test ${r.test_id}` : 'Untitled test');

// What the STATUS MARK says in words: the status the colour stands for, and the
// custom status refining it (#109) after it. The row itself carries no tooltip —
// a label over the whole line covered the rows under it to repeat a title that
// is already printed there — so what a mark cannot spell out is hung on the mark
// itself, the way the type square and the priority arrow already do.
function statusTip(r) {
  const sub = typeof r?.substatus === 'string' ? r.substatus.trim() : '';
  return [
    statusLabel(displayStatus(r)),
    capabilities.jwt && sub ? sub : '',
  ].filter(Boolean).join(' · ');
}

// The checklist row, in ONE line: how it went, how much it matters, what it is,
// what it is called — the order the tests list already reads in, and the order
// the library's own row does (◇ Tests → tests-item). It used to be a title with
// a wrapping line of pills under it, which cost every row a second line to say
// in words what four marks say in 60 pixels.
//
// The type mark is the row's own `automated` flag — the same flag #154 locks
// the write buttons on, so the square is the row saying WHY its ✓/✗/– are dead
// before a tester presses one. The priority mark is drawn on EVERY row, the way
// the tests list draws it: a record the v2 run payload sends no priority for
// still RUNS at `normal` (that is what the editor's picker opens on), so the
// ring is the answer, not a guess. Drawing it only for the rows that carried one
// left the column half-filled and every other title starting a box further left.
function testRow(r) {
  const li = document.createElement('li');
  li.className = 'test-row';
  li.dataset.recordId = r.id;
  li.append(statusMark(r));
  const prio = typeof PriorityIcons !== 'undefined' ? PriorityIcons.mark(r.priority) : null;
  if (prio) li.append(prio);
  const type = typeof TestType !== 'undefined' ? TestType.forRecord(r) : null;
  if (type) li.append(type);
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = rowTitle(r);
  li.append(title);
  // Fixed right cell (flex:none): the always-visible ✓/✗/– checklist buttons,
  // a constant column regardless of how long the title is.
  li.append(rowStatusButtons(r, li));
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker on (re)render
  li.addEventListener('click', () => openTestView(r.id)); // per-row identity
  return li;
}

// The row's own copy of the status mark. `.row-status` is what a repaint finds
// it by — the element itself is swapped rather than recoloured, because a run
// that starts or finishes swaps the FORM of the mark (a glyph for a loader).
function statusMark(r) {
  // The LABEL, not the internal key: `untested` is what a record with no result
  // is called in this file and `pending` is what it is called everywhere a
  // person can see it — including `data-status`, which is what the colour rule
  // and the e2e both read the row's state from.
  const mark = statusIcon(statusLabel(displayStatus(r)));
  mark.classList.add('row-status');
  Tooltip.set(mark, statusTip(r)); // the word behind the colour (+ the custom status)
  return mark;
}

// Repaint a row's mark + active button in place after an inline write. The mark
// is REPLACED, not recoloured: a row that starts running trades its glyph for
// the loader and back again, and the two are different elements.
function repaintRow(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) mark.replaceWith(statusMark(r));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => b.classList.toggle('active', r.status === b.dataset.status));
  applyRowLock(li); // #152: a repaint (own write or livesync) re-asserts the lock
  repaintRowSubstatus(li, r);
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker follows the queue
}

// Reconcile a row's custom status in place (#109). It rides the status mark's
// tooltip — the mark is what it refines — so reconciling it is rewriting that
// label, on whichever mark the row is wearing right now.
function repaintRowSubstatus(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) Tooltip.set(mark, statusTip(r));
}

// The run-view row <li> for a record id (may be absent — rows live only once the
// run view has rendered; still present, just hidden, while a test is open).
function runRowEl(recordId) {
  return document.querySelector(`#run-tests li.test-row[data-record-id="${String(recordId)}"]`);
}

// Disable/enable one row's status buttons while its own write is in flight
// (other rows stay active — no global lock). The lock outranks the busy flag:
// releasing a write must never re-enable a locked row (#152/#154).
function setRowButtonsBusy(li, busy) {
  const lock = recordWriteLock(recordFor(li.dataset.recordId));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => { b.disabled = busy || !!lock; });
}

// Brief green-ring confirmation on the badge once an inline write lands. The
// class is toggled off first so a rapid re-write restarts the flash.
function flashRowSaved(li) {
  const badge = li.querySelector('.badge');
  if (!badge) return;
  badge.classList.remove('saved-flash');
  void badge.offsetWidth; // reflow → restart the animation
  badge.classList.add('saved-flash');
  setTimeout(() => badge.classList.remove('saved-flash'), 1000);
}

// Recompute the containing suite section's done/total after an inline write.
function refreshSuiteFraction(li) {
  const sec = li.closest('.suite-section');
  const frac = sec && sec.querySelector('.suite-frac');
  if (!sec || !frac) return;
  const key = sec.dataset.suite;
  const rows = state.records.filter((r) => suiteKeyOf(r) === key);
  const done = rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${rows.length}`;
}

// Inline status write from a run-view row button (checklist mode). Same-status
// click is a no-op (no duplicate record write); a different status overwrites.
// The row's buttons are disabled while its write is in flight; on success the
// badge, run progress, chip counts and suite fraction update in place (no full
// reload); on failure the record is restored and the row is left unchanged.
async function writeRowStatus(record, status, li) {
  if (!record || record.status === status) return; // same status → no-op
  const btn = li.querySelector(`.row-actions .row-st[data-status="${status}"]`);
  // Claim the row BEFORE any await: the same-status guard above already ran, so
  // two fast clicks inside the probe window would otherwise both get through and
  // issue two writes. A disabled button fires no click.
  setRowButtonsBusy(li, true);
  // #194: paint in the click's own turn — behind the probe await it lagged up to 2s.
  if (btn) btn.classList.add('busy');
  // #186: the archived answer rides the session probe and may still be in flight
  // this soon after the run opened. Wait for it — a click is rare enough to pay a
  // round trip, and the alternative is writing into a run we were about to lock.
  if (runStateProbe) await awaitRunState();
  // #152/#154: the buttons are already disabled on a locked row — this catches
  // the race where the run finished (or a reporter result flipped the row to
  // automated) between the render and the click, and repaints.
  const lock = recordWriteLock(record);
  if (lock) {
    if (btn) btn.classList.remove('busy'); // applyRunLock repaints in place, so the spinner would strand
    applyRunLock({ force: true }); toast(lock); return;
  }
  const prev = { ...record };
  state.inlineWrites += 1;
  try {
    const res = await writeStatus(record, status, ''); // no comment / no view-specific bits at run level
    if (btn) btn.classList.remove('busy');
    repaintRow(li, record);          // repaint reflects the queued marker too (decorateRow)
    if (!(res && res.queued)) flashRowSaved(li); // green flash only when the write actually landed
    paintRunProgress();        // run progress in place
    renderRunFilterChips();    // whole-run chip counts
    refreshSuiteFraction(li);
  } catch (e) {
    if (btn) btn.classList.remove('busy');
    Object.assign(record, prev); // row unchanged on failure
    handleApiError(e, 'run-status', { inlineAuth: true }); // stay in the run on an expired session
    if (!isAuthError(e)) toast(`Status not saved: ${e.message}`, { error: true });
  } finally {
    state.inlineWrites -= 1;
    setRowButtonsBusy(li, false);
  }
}

// A suite section: header (chevron + folder + name + per-suite done/total over ALL its
// rows) over its visible rows. Collapse toggles a class (in-memory only).
// Default is COLLAPSED (huge checklist runs must not open as a wall of rows);
// a single-suite run renders expanded, an active filter/search auto-expands the
// sections it matched, and an explicit user toggle (per run, session) wins.
function suiteSection(sec, rows, single) {
  const li = document.createElement('li');
  li.className = 'suite-section tree-node';
  li.dataset.suite = sec.key;
  const pref = state.expandedSuites[sec.key];
  const filterActive = state.runFilter !== 'all' || state.runSearch.trim() !== '';
  const expanded = filterActive ? true : (pref !== undefined ? pref : single);
  if (!expanded) li.classList.add('collapsed');
  const head = document.createElement('div');
  // Padding, vertical and horizontal, is the library row's own, so the chevron
  // stays on the column the open guide comes down.
  head.className = 'list-row list-head suite-head tree-row has-chevron';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = sec.title || 'No suite';
  const frac = document.createElement('span');
  // The shared trailing figure — `.row-count` (ROW TAIL, shared/components.css).
  // This row is where the panel's rows got the shape, and it now takes it from
  // the library rather than spelling out a hint of its own; `.suite-frac` stays
  // as the hook that finds it.
  frac.className = 'row-count suite-frac';
  const done = sec.rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${sec.rows.length}`;
  // Chevron, then the SUITE glyph — a run's section is a suite, not a folder,
  // and drew the folder mark only because that was the mark the panel had. It
  // now leads with the same one TC Studio gives a suite, in the same column, so
  // one thing has one mark wherever it is looked at. A suite the project gave a
  // custom emoji draws that instead (suiteEmojiOf — absent until the tree lands).
  head.append(treeIcon(CHEVRON_ICON, 'chevron'),
    treeIcon(FILE_ICON, 'file-icon', suiteEmojiOf(sec.title)), title, frac);
  head.addEventListener('click', () => toggleSuite(sec.key, li));
  li.append(head);
  const rowsUl = document.createElement('ul');
  rowsUl.className = 'suite-rows tree-children';
  for (const r of rows) rowsUl.append(testRow(r));
  li.append(rowsUl);
  return li;
}

function toggleSuite(key, li) {
  const collapsed = li.classList.toggle('collapsed');
  state.expandedSuites[key] = !collapsed; // explicit pref overrides the default
}

// Build the suite sections (filter + search applied). A section with zero visible
// rows is not rendered; zero visible rows overall → "No tests match".
// The run came back with no records at all — not a filter, an actually empty
// run. Worth saying WHY, because it is nearly always the same cause: a run
// created outside the web UI (a CI reporter that has yet to report, an API
// POST) carries no checklist for a tester to work through.
function runNoTestsEmpty() {
  const s = state.settings || {};
  const actions = [];
  if (s.baseUrl && s.projectId && state.runId) {
    // The same `<host>/projects/<slug>/runs/<id>` shape the runs search parses
    // a pasted link out of (looksLikeRunUrl, screens/runs-list.js).
    const a = document.createElement('a');
    a.className = 'btn size-sm';
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/${encodeURIComponent(state.runId)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // The label is a <span>, not a bare text node: the button's leading-icon
    // padding rule asks whether the ICON is the first child, and a text node is
    // not a child a selector can see — so an unwrapped label would leave the ↗
    // first and pull the LEFT edge in on a button whose icon trails. Wrapping it
    // is the same shape "Next test ↗" already uses in index.html.
    const label = document.createElement('span');
    label.textContent = 'Open in Testomat';
    a.append(label, svgIcon('north_east', 16));
    actions.push(a);
  }
  return EmptyState.build({
    tag: 'li',
    icon: 'checklist',
    title: 'No tests in this run',
    text: 'Runs created outside the web UI can start out with an empty checklist.',
    actions,
  });
}

// The filter and the search emptied it. Same two escapes the runs list offers,
// against this screen's own state.
function runNoMatchEmpty() {
  const actions = [];
  if (state.runSearch.trim()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Clear search';
    b.addEventListener('click', clearRunSearch);
    actions.push(b);
  }
  if (state.runFilter !== 'all') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Show all tests';
    b.addEventListener('click', () => setRunFilter('all'));
    actions.push(b);
  }
  return EmptyState.build({
    tag: 'li',
    live: true, // it took over the status line's announcement
    // Its own pair of marks, not the runs list's: a search here looks INSIDE
    // one run's checklist (find_in_page), and the chip narrowing it is a list
    // filter, not the runs list's status funnel.
    icon: state.runSearch.trim() ? 'find_in_page' : 'filter_list_off',
    title: 'No tests match',
    text: state.runSearch.trim()
      ? 'No test or suite title in this run matches what you typed.'
      : 'No test in this run carries that status.',
    actions,
  });
}

function renderRunSections() {
  const ul = $('run-tests');
  ul.replaceChildren();
  setStatusLine('run-status', '');
  if (!state.records.length) { ul.append(runNoTestsEmpty()); return; }
  let shown = 0;
  const secs = suiteSections();
  const single = secs.length === 1; // a lone suite renders expanded by default
  for (const sec of secs) {
    const rows = sec.rows.filter(rowVisible);
    if (!rows.length) continue;
    ul.append(suiteSection(sec, rows, single));
    shown += rows.length;
  }
  if (!shown) ul.append(runNoMatchEmpty());
}

function renderRunView() {
  renderRunHeader();
  renderRunInfo();
  renderRunFilterChips();
  syncRunSearch();
  renderRunSections();
  applyRunLock({ force: true }); // #152 — the run-level note + the Finish/test-view gates
}
