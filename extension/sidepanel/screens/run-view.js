// Run view: status-icon names and helpers, the run tests list with progress,
// status chips, search, suite sections, finish-run, and the run session probe.

/* global TestomatAPI, Icons, Skeleton, Tooltip, EmptyState, TestType, PriorityIcons, UserCell,
   progressToast, Fmt, CommentDrafts, WriteCore, byRecordId */

// ---------- status icons ----------
// `running` is deliberately absent: it is the LOADER, a drawn ring rather than a
// glyph (statusIcon below). `launching` renders as `running`.
const STATUS_ICON = {
  passed: 'status_passed',
  failed: 'status_failed',
  // Its own crossed ring: the plain ring below belongs to a test nobody has run, so the two
  // are told apart by shape and not by colour alone.
  skipped: 'block',
  terminated: 'status_terminated',
};
// Pending, scheduled, queued, unknown — one ring-with-a-dot for all of them.
const NEUTRAL_ICON = 'status_record';
// What the API calls a `file` suite is what the product calls a SUITE.
const FOLDER_ICON = 'tree_folder'; // rungroups + TC-studio folders (grouping nodes)
const FILE_ICON = 'tree_suite';    // file/test-file suite nodes — and a run's suite sections
const CHEVRON_ICON = 'chevron_right'; // rotates 90° when expanded
const ACCOUNT_ICON = 'person'; // assignee chip: person marker before the name
const SVG_NS = 'http://www.w3.org/2000/svg'; // icons.js keeps its own copy private

const normStatus = (s) => (s === 'launching' ? 'running' : s || 'unknown');

// Thin alias over Icons.el — core/views.js is loaded first and reaches for it by name.
function svgIcon(name, size = 16, ...cls) {
  return Icons.el(name, size, ...cls);
}

// `cls` carries the glyph's own name (`chevron`/`folder-icon`/`file-icon`) — the
// screen's rotate/colour rules key off it. `emoji` is the project's override.
function treeIcon(name, cls, emoji) {
  const custom = Icons.emoji(emoji, `tree-icon ${cls}`);
  // `data-emoji` lets a repaint tell an already-right icon from one to replace.
  // It is the DRAWN text — an unresolved `:shortcode:` falls back and carries none.
  if (custom) { custom.dataset.emoji = custom.textContent; return custom; }
  const span = document.createElement('span');
  span.className = `tree-icon ${cls}`;
  span.append(svgIcon(name, 16));
  return span;
}

// A row with nothing to unfold keeps the slot anyway: its glyph and title line up
// with an unfoldable sibling's (TC studio, reported steps).
const treeSlot = () => Object.assign(document.createElement('span'), { className: 'tree-icon' });

// manual | automated | mixed are the three the product gives a run; a RUNGROUP's
// own `kind` (multienv) is not one of them and draws nothing.
const RUN_KINDS = new Set(['manual', 'automated', 'mixed']);
function runKind(kind) {
  const k = String(kind || '').toLowerCase();
  return RUN_KINDS.has(k) ? k : null;
}

// The mark WITH its word, for the run header; a list row uses the icon-only square.
function kindBadge(kind) {
  const k = runKind(kind);
  if (!k || typeof TestType === 'undefined') return null;
  const el = TestType.mark(k, { text: true });
  if (el) Tooltip.set(el, `${k} run`);
  return el;
}

// The running mark is a two-colour ring, which no single-path icon can be: an SVG of two
// circles — the track, and a quarter of it in the head colour — spun whole by CSS. Vector, so
// the ring stays round and the quarter's ends stay sharp at 1x as at 2x; the gradient ring
// this replaces drew hard colour stops that rotated as staircases. `pathLength` makes the
// dash a percentage of the circumference, so the quarter reads "25 75" whatever the radius.
function spinnerEl() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'spinner');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dash] of [['spinner-track', null], ['spinner-head', '25 75']]) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '5.68');
    c.setAttribute('pathLength', '100');
    // The quarter starts at 12 o'clock and runs clockwise, as the conic one did.
    if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('transform', 'rotate(-90 8 8)'); }
    svg.append(c);
  }
  return svg;
}

// `data-status` drives the colour. RUNNING comes back as the ring of its own (`spinnerEl`),
// not an icon — both forms measure 20px, so a row does not shift when it finishes.
function statusIcon(status) {
  const s = normStatus(status);
  if (s === 'running') {
    const spinner = spinnerEl();
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
  // #155: a read-only project is locked whole — gated before any state is touched.
  if (await readonlyGate()) { show('run'); return; }
  const runChanged = state.runId !== runId;
  // Back from a test, or the panel-wide Refresh with this run open: it is already
  // painted and its records are in memory, so nothing here is torn down — the screen
  // stays as the tester left it and the re-read below lands in place.
  const quiet = !runChanged && state.records.length > 0;
  // Suite prefs are per run for the session — reset only when a DIFFERENT run opens.
  if (runChanged) state.expandedSuites = {};
  state.runId = runId;
  if (title) state.runTitle = title;
  state.currentRecordId = null; // no row is open on this screen, by either path
  if (!quiet) {
    state.runStatus = null;
    state.runKind = null;
    state.substatusCounts = {}; // filled by the JSON:API read below (#109)
    state.runInfo = {};         // #112: v2 detail below, JSON:API extras over it
    state.runFilter = 'all';
    state.runSearch = '';
    if ($('run-search')) $('run-search').value = '';
  }
  show('run');
  let sk = null;
  if (!quiet) {
    sk = Skeleton.show('run');
    setStatusLine('run-status', 'Loading tests…');
    if ($('run-meta-note')) $('run-meta-note').hidden = true;
    $('run-tests').replaceChildren();
    $('run-progress').replaceChildren(); // clear progress only — the Finish button is a sibling
    // Neither pill may describe the PREVIOUS run while the new one loads.
    if ($('run-kind')) $('run-kind').hidden = true;
    if ($('run-state')) $('run-state').hidden = true;
    // Nor may Run info or the status chips: under the new title they read as this
    // run's own numbers. Only for another run — reloading THIS one keeps them up.
    if (runChanged) {
      if ($('run-info')) $('run-info').hidden = true;
      if ($('run-info-body')) $('run-info-body').replaceChildren();
      if ($('run-filter')) $('run-filter').replaceChildren();
    }
  }
  try {
    // Independent legs: a failed meta fetch must not blank a fetchable checklist.
    // Only the test-list leg is essential. The JSON:API read rides along whenever the
    // session is already proven, so the run paints ONCE with everything it will show
    // — Started, Duration and Executed by used to insert themselves a paint later.
    const readInfo = capabilities.jwt === true;
    const [detailRes, recordsRes, infoRes, examplesRes] = await Promise.allSettled([
      TestomatAPI.getRun(runId),
      TestomatAPI.listTestruns(runId),
      readInfo ? TestomatAPI.getRunInfo(runId) : null,
      readInfo ? TestomatAPI.listTestrunExamples(runId) : null,
    ]);
    if (state.runId !== runId) return;
    if (recordsRes.status === 'rejected') throw recordsRes.reason;
    const detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
    const metaFailed = !detail;
    if (metaFailed) {
      state.runTitle = state.runTitle || 'Run';
      state.runStatus = null;
      state.runKind = null;
      state.runInfo = {};
    } else {
      state.runTitle = detail.clean_title || detail.title || state.runTitle;
      state.runStatus = detail.status || null; // 'running' while unfinished; terminal after finish
      state.runKind = detail.kind || null;     // v2 run detail carries `kind`
      state.runInfo = runInfoFromDetail(detail);
    }
    // Merged OVER the v2 base, the order the probe applied these in when it was the
    // one reading them (#112). null whenever the read was not part of the batch.
    const info = infoRes.status === 'fulfilled' ? infoRes.value : null;
    if (info) applyRunInfo(info);
    // show() painted the header off the passed-in title — repaint with the real one.
    refreshContextBar();
    // v2 returns newest-first; run order = creation order = id ASC.
    state.records = recordsRes.value.sort(byRecordId);
    // #52: best-effort like the info leg — a failed read leaves the parametrized rows bare.
    state.runExamples = (examplesRes.status === 'fulfilled' && examplesRes.value) || {};
    renderRunView();
    if ($('run-meta-note')) $('run-meta-note').hidden = !metaFailed;
    updateRunActions();      // hidden until the session probe confirms JWT
    startLiveSync();         // (re)start polling; also clears an auth-stop
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // run-open is a replay trigger
    loadSuiteEmoji(runId);   // fire-and-forget
    CommentDrafts.prune(runId); // …and so is dropping the drafts of results THIS run no longer has
    // Kept though fire-and-forget: a row write waits on it for the archived flag (#186).
    runStateProbe = probeRunSession(runId, { infoRead: !!info });
  } catch (e) {
    handleApiError(e, 'run-status');
  } finally {
    if (sk) {
      Skeleton.hide(sk);
      // The card painted while the placeholder held it hidden, and both Run info measures
      // need layout to read — so they are taken again now that it is back on screen.
      paintRunInfo();
    }
  }
}

// #186: without a proven session the archived flag lands one round-trip AFTER the
// run renders — openRunView's batch carries it whenever there IS one, but the first
// run of a panel session still has none. The paint stays truthful either way and the
// WRITE waits for the answer instead.
let runStateProbe = null;

// Bounded: nothing here sets a fetch timeout, so a probe that HANGS rather than
// fails would park the write forever, with no error for the offline queue to catch.
const PROBE_WAIT_MS = 2000;
const awaitRunState = () => (runStateProbe
  ? Promise.race([runStateProbe, sleep(PROBE_WAIT_MS)]).catch(() => {})
  : Promise.resolve());

// Best-effort; degrades silently. Resolves as soon as the run detail has landed —
// assignee names are detached below, because a write must not wait on cosmetics.
// `infoRead`: the open batch already carried the JSON:API read (a session was known
// to work), so the run is painted whole and there is nothing here to re-read.
async function probeRunSession(runId, { infoRead = false } = {}) {
  await loadProjectInfo();
  if (state.runId !== runId) return;
  capabilities.jwt = TestomatAPI.jwtAvailable() === true;
  applyCapabilities();
  updateRunActions();
  if (!capabilities.jwt) return;
  // #52: the example values are a JWT read too, so a late-proven session still has to make it —
  // awaited before the paint below, which is the ONE repaint both it and the substatuses get.
  const gotExamples = infoRead ? false : await refreshRunExamples(runId);
  if (state.runId !== runId) return;
  // Row marks are JWT-gated, so the first (pre-probe) paint carried none (#109/#52).
  if ((gotExamples || state.records.some((r) => r.substatus)) && state.view === 'run') renderRunSections();
  if (!infoRead && await refreshRunInfo(runId)) { paintRunProgress(); renderRunInfo(); applyRunLock(); }
  if (state.runId !== runId) return;
  probeRunAssignees(runId); // detached — see above
}

// Split off the probe so the #186 write gate waits for the run detail only. The
// read is unconditional (#200): the viewer's profile timezone rides the same record.
async function probeRunAssignees(runId) {
  await loadProjectUsers();
  if (state.runId === runId && state.view === 'run') { renderRunSections(); renderRunInfo(); }
}

// One JSON:API read for both the counters (#109) and the four Run info fields v2
// does not serialize (#112). Best-effort: a failure leaves the last painted values.
async function refreshRunInfo(runId) {
  if (!capabilities.jwt) return false;
  try {
    const info = await TestomatAPI.getRunInfo(runId);
    if (state.runId !== runId) return false;
    applyRunInfo(info);
    return true;
  } catch {
    return false;
  }
}

// #52: the example values behind the row chips. Best-effort like the read above; true only when
// the map came back with something in it — i.e. there is a chip for the caller to paint.
async function refreshRunExamples(runId) {
  if (!capabilities.jwt) return false;
  try {
    const map = await TestomatAPI.listTestrunExamples(runId);
    if (state.runId !== runId) return false;
    state.runExamples = map || {};
    return Object.keys(state.runExamples).length > 0;
  } catch {
    return false;
  }
}

// BASIC mode only (#152): the token-only panel makes no JSON:API read, so it would
// never learn a colleague finished the run. v2 `/runs/{id}` status IS terminal after.
async function refreshRunFinished(runId) {
  if (capabilities.jwt) return;
  try {
    const detail = await TestomatAPI.getRun(runId);
    if (!detail || state.runId !== runId) return;
    state.runStatus = detail.status || null;
    applyRunInfo(runInfoFromDetail(detail)); // the v2 half of Run info rides along
  } catch { /* keep what we had */ }
}

// Replaced only when the payload actually carried them — a write response that
// omits them must not blank them. null = didn't say; an un-archive (false) lands.
function applyRunInfo({ substatusCounts, isArchived, ...extras }) {
  if (substatusCounts) state.substatusCounts = substatusCounts;
  if (isArchived != null) state.runInfo.isArchived = isArchived;
  Object.assign(state.runInfo, extras); // merged over the v2 base fields
}

// ---- write locks: archived (#186), finished (#152), automated (#154) ----
// One plumbing, three reasons: runWriteLock() for the whole run, recordWriteLock()
// for one row; applyRunLock() paints whatever they say onto the DOM.
//
// ---- finished run (#152)
// The server checks no run state on these writes (the CI reporter writes into
// finished runs by design), so the panel is the only place the gate can live.
const TERMINAL_RUN_STATUS = new Set(['passed', 'failed', 'terminated', 'finished']);
const runStatusTerminal = (s) => TERMINAL_RUN_STATUS.has(String(s || '').toLowerCase());

const RUN_LOCK_REASON = 'Run is finished — results are read-only';
const RUN_LIVE_STATUSES = new Set(['running', 'launching']);

function runFinished() {
  if (runStatusTerminal(state.runStatus)) return true;
  const info = state.runInfo || {};
  return runStatusTerminal(info.status) || !!info.finishedAt;
}

// ---- archived run (#186)
// The server has no authorization check for archived runs (only list filtering) and
// `Run#calculate_counters` early-returns, so a write leaves counters permanently stale.
//
// ONE signal, session-only: `is-archived` on the JSON:API run detail. The v2 payload
// carries no archived flag at all, so BASIC MODE IS BLIND and deliberately stays so.
const ARCHIVED_LOCK_REASON = 'Run is archived — results are read-only';

const runArchived = () => (state.runInfo || {}).isArchived === true;

// ---- automated result (#154)
// `Testrun#add_step!` returns early on an automated testrun while still answering
// 200, so step writes are swallowed. The RUN's `kind` bars every row, a row's flag one.
const AUTOMATED_LOCK_REASON = 'Automated result — read-only in the panel';

const runAutomated = () => String(state.runKind || '').toLowerCase() === 'automated';

// The JSON:API detail is consulted for the OPEN test, in case the list row is stale.
function recordAutomated(record) {
  if (!record) return false;
  if (record.automated === true) return true;
  return String(state.currentRecordId) === String(record.id)
    && state.testrunDetail?.data?.attributes?.automated === true;
}

// '' = writable, else the reason holding for EVERY row. Archived outranks finished
// outranks automated: the tester must be told the ACTUAL reason.
function runWriteLock() {
  if (!state.runId) return '';
  if (runArchived()) return ARCHIVED_LOCK_REASON;
  if (runFinished()) return RUN_LOCK_REASON;
  if (runAutomated()) return AUTOMATED_LOCK_REASON;
  return '';
}

// The run-level reason first (it is true of this row too), then the row's own flag.
function recordWriteLock(record) {
  return runWriteLock() || (recordAutomated(record) ? AUTOMATED_LOCK_REASON : '');
}

// Driven by the STATE, not by a detected transition: several paths learn that the
// run finished, and a flip-detector missed the paint. `force` is for a rebuilt DOM.
let lockPainted = null; // last signature painted into the DOM; null = never painted

// The reason alone is not enough (#154): a reporter result landing in a mixed run
// flips one row mid-poll while the run-level reason stays ''.
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
  if (typeof TestGates !== 'undefined') TestGates.update();
}

// JWT-gated; `jwtAvailable` is 'unknown' until a probe runs, so it stays hidden then.
// #186: a rerun-ed archived run is 'running' again, so the finished check alone fails.
function updateRunActions() {
  const btn = $('btn-finish-run');
  if (!btn) return;
  const jwt = TestomatAPI.jwtAvailable(); // 'unknown' | true | false
  // `launching` is a running run here as it is everywhere else in this file — a run that is still
  // starting is exactly the one a tester wants to be able to stop.
  const running = RUN_LIVE_STATUSES.has(state.runStatus) && !runFinished() && !runArchived();
  // Degraded stays VISIBLE but disabled-with-reason, so the lost capability is legible.
  btn.hidden = !running || jwt === 'unknown';
  const degraded = running && jwt === false;
  btn.disabled = degraded;
  Tooltip.set(btn, degraded
    ? `Finish run needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
    : '');
}

// Resolves true on confirm, false on cancel/Esc/backdrop; listeners torn down on close.
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

// Finish while writes are pending: step writes ride stepWriteChain, a save flips state.saving.
async function settlePendingWrites() {
  await Promise.resolve(stepWriteChain).catch(() => {});
  for (let i = 0; i < 200 && (state.saving || state.inlineWrites > 0); i++) await sleep(25);
  await Promise.resolve(stepWriteChain).catch(() => {});
  // Answering false is the point: a finished run takes no more writes, so closing over one loses it.
  return !state.saving && state.inlineWrites <= 0;
}

// Deliberately NOT runWriteLock(), which would also bar an automated run: the
// button would be visible and then refuse itself (#154 gates results, not the run).
function finishBlockedReason() {
  if (runArchived()) return ARCHIVED_LOCK_REASON;
  if (runFinished()) return RUN_LOCK_REASON;
  return '';
}

async function finishRun() {
  if (!state.runId) return;
  // #186: visibility is not a sufficient gate — the flag lands after updateRunActions().
  // Checked on BOTH sides of the dialog: the confirm can sit open indefinitely.
  await awaitRunState();
  let blocked = finishBlockedReason();
  if (blocked) { applyRunLock({ force: true }); toast(blocked); return; }
  const ok = await confirmDialog('Finish run? Pending tests will be marked skipped.');
  if (!ok) return; // dismissed = no-op
  blocked = finishBlockedReason();
  if (blocked) { applyRunLock({ force: true }); toast(blocked); return; }
  const btn = $('btn-finish-run');
  if (btn) btn.disabled = true;
  progressToast('Finishing run…');
  try {
    if (!await settlePendingWrites()) {
      toast('A result is still saving — try Finish run again in a moment', { error: true });
      return;
    }
    // The finish PUT answers with the updated run, so Run info needs no re-read.
    applyRunInfo(TestomatAPI.runInfoOf(await TestomatAPI.finishRun(state.runId)));
    // v2 run counts lag (async) — re-read testruns as the authoritative source.
    const records = await TestomatAPI.listTestruns(state.runId);
    state.records = records.sort(byRecordId);
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

  // Only the tallies that HAPPENED; the done/total figure always stands, zero included.
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

// Run header ONLY — the test view reuses progressNodes(). Sorted count DESC then
// name ASC: the server's grouping order is not guaranteed and a jump reads as flicker.
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
    // NBSP after the separator, so a wrap takes the `·` down with its counter.
    group.append(document.createTextNode(' · '), item);
  }
  line.append(group);
}

// The Finish run button is a sibling in the band, so a progress repaint never wipes it.
function paintRunProgress() {
  const nodes = progressNodes();
  appendSubstatusCounts(nodes[0]); // the .counts line — counters extend it inline
  $('run-progress').replaceChildren(...nodes);
}

function paintRunKind() {
  const el = $('run-kind');
  if (!el) return;
  const badge = kindBadge(state.runKind);
  el.replaceChildren(...(badge ? [badge] : []));
  el.hidden = !badge;
}

// Two sources, the fresher first: the JSON:API detail's `status`, then the v2 run
// status basic mode has. Hidden when neither answered, so the row keeps its shape.
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
  // NOT `show('run')`, which is a view SWITCH: a poll tick or a late fetch would
  // throw the tester out of the test they were reading (#215).
  refreshContextBar();
}

// ---- Run info (#112) ----
// Two sources, no extra fetch: Status/Tests/Created/Description ride the v2 detail
// (so they survive basic mode); Duration/Executed/Started/Build URL are JWT-only.

// Open by default; the toggle persists the choice (core/storage.js, restored at
// boot). Only an explicit close reads as closed, so a profile predating the key opens.
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
  // The spellings seen first, then any key that MEANS the same thing; a key that
  // says nothing is left off — never written as null over what a read already found.
  const executedBy = UserCell.normalize(detail.executed_by ?? detail.launched_by ?? detail.user)
    || flatPeople(detail, /^(executed|launched|started|ran)(_by)?$/)[0];
  const createdBy = UserCell.normalize(detail.created_by ?? detail.author ?? detail.owner)
    || flatPeople(detail, /^(created_by|creator|author|owner)$/)[0];
  const assignees = flatPeople(detail, /assign/);
  if (executedBy) info.executedBy = executedBy;
  if (createdBy) info.createdBy = createdBy;
  if (assignees.length) info.assignees = assignees;
  // Both are v2's own fields (`to_response_hash` serves env + plans, verified live),
  // so they survive basic mode. Written only when the payload said something.
  const envs = envList(detail.env);
  const plans = planList(detail.plans ?? detail.plan ?? detail.test_plans ?? detail.test_plan);
  if (envs.length) info.envs = envs;
  if (plans.length) info.plans = plans;
  return info;
}

// v2 sends env as an array on some routes and as one comma-joined string on others.
function envList(env) {
  const raw = Array.isArray(env) ? env : String(env ?? '').split(',');
  return raw.map((one) => String(one ?? '').trim()).filter(Boolean);
}

// Nothing pins the plan shape on the flat payload — a title, a record, or a bare
// id — so an entry that does not NAME a plan contributes nothing, not "4831".
function planList(plans) {
  const out = [];
  for (const one of Array.isArray(plans) ? plans : (plans == null ? [] : [plans])) {
    const title = typeof one === 'string' ? one.trim()
      : String(one?.title || one?.clean_title || one?.name || '').trim();
    if (title) out.push(title);
  }
  return out;
}

// A matching key counts only if what it holds is person-shaped: `assignee_ids: [3,7]`
// contributes nobody, and "assign_mode": "none" is a setting, not a tester called none.
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

// Web parity (#200): the ACCOUNT PROFILE timezone, not the machine's. `lll` is
// `MMM D, YYYY h:mm A` — en-US adds a comma before the hour, so parts are assembled.
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

// null on an absent or unparseable value, which drops the whole row.
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

// Only http(s): the value is server data, and `javascript:` is the hole an href must not open.
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

// The whole string rides the tooltip: a pill too long for the panel is cut, not widened.
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

// Resolved through the project's members: only that read carries the AVATAR (the
// run payload names people, it does not describe them). What the payload said wins.
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

// The union of both places the answer lives: a run can be handed to a tester who
// holds no row, and a row to somebody the run itself never named. Keyed by address.
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

// A MEASUREMENT, not a head count (the panel is resizable): the list wraps, so a
// box taller than one of its cells is one that did not fit. Needs a VISIBLE body.
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

// #159: a reporter can write a whole session report here, so the value renders clamped.
function runInfoDescription(text) {
  const el = document.createElement('div');
  el.className = 'run-info-desc-text is-clamped';
  el.textContent = text;
  return el;
}

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

// Needs the section open — a hidden body has no layout to measure.
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
  // Duration is SECONDS here (RunSerializer), ms in Fmt.humanDuration; 0 while unfinished.
  if (info.duration > 0) rows.push(['Duration', Fmt.humanDuration(info.duration * 1000)]);
  // Never below the checklist: the server's count trails the rows after a run is created.
  const tests = Math.max(Number(info.testsCount) || 0, state.records.length);
  if (tests > 0) rows.push(['Tests', String(tests)]);
  // The web's own order: Environment then Test plan, under Tests.
  const envs = runInfoTags(info.envs || []);
  if (envs) rows.push(['Environment', envs]);
  if (info.plans && info.plans.length) rows.push(['Test plan', info.plans.join(', ')]);
  // Web parity: a finished run shows the executed span, a live one just its start.
  if (started && finished) {
    const span = document.createDocumentFragment();
    // Bare glyph: the row is a flex line (`.kv.rows`), so the gap is the cell's own.
    span.append(started, '→', finished);
    rows.push(['Executed', span]);
  } else if (started) {
    rows.push(['Started', started]);
  }
  const executedBy = runInfoUser(info.executedBy);
  if (executedBy) rows.push(['Executed by', executedBy]);
  const assignees = runInfoAssignees();
  if (assignees) rows.push(['Assigned to', assignees]);
  const link = ciBuildLink(info.ciBuildUrl);
  if (link) rows.push(['Build URL', link]);
  // One row — the web's "Created by <person>, <date>"; nobody named → the date alone.
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

function paintRunInfo() {
  const head = $('run-info-head');
  const body = $('run-info-body');
  if (head) head.setAttribute('aria-expanded', runInfoOpen ? 'true' : 'false');
  if (body) body.hidden = !runInfoOpen;
  // Both measures need a VISIBLE body — a hidden one has no layout to read.
  measureRunInfoPeople();
  measureRunInfoDesc();
}

function toggleRunInfo() {
  runInfoOpen = !runInfoOpen;
  paintRunInfo();
  persistSession(); // the user's choice outlives this panel (#112)
}

function renderTestProgress() {
  $('test-progress').replaceChildren(...progressNodes());
}

// ---- run-view navigation: status chips + search + suite sections ----

// Single-select; the counts are over the WHOLE run, never narrowed by the search.
const RUN_STATUS_FILTERS = [
  ['all', 'All'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped'],
  ['untested', 'Pending'],
];
const RUN_FILTER_KEYS = new Set(RUN_STATUS_FILTERS.map(([k]) => k));
// Only the three that ARE a result are coloured; All and Pending stay neutral.
const RUN_FILTER_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

// A row the runner is still executing answers `running`, which has no chip: counted nowhere, it made
// the chips add up to less than All and left the row reachable only from All.
const chipStatusOf = (r) => {
  const s = displayStatus(r);
  return RUN_FILTER_KEYS.has(s) ? s : 'untested';
};

function runStatusCounts() {
  const counts = { all: state.records.length, passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const r of state.records) counts[chipStatusOf(r)] += 1;
  return counts;
}

const matchesRunFilter = (r) => state.runFilter === 'all' || chipStatusOf(r) === state.runFilter;

// #52: the row's `{ values, params }`, keyed by RECORD id — a v2 record's numeric id indexes the
// JSON:API map's string keys unchanged. null for a plain test, and for every row in basic mode.
const exampleOf = (r) => state.runExamples[r.id] || null;

// Case-insensitive substring over test + suite titles — and a parametrized row's example values,
// which are the only thing separating N rows sharing one title (#52).
function matchesRunSearch(r) {
  const q = state.runSearch.trim().toLowerCase();
  if (!q) return true;
  if ((r.test_title || '').toLowerCase().includes(q)) return true;
  if ((r.suite_title || '').toLowerCase().includes(q)) return true;
  return (exampleOf(r)?.values || []).some((v) => v.toLowerCase().includes(q));
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
// `/testruns` carries `suite_title` only — no suite id, no emoji (verified live) —
// so the mark comes off the SUITE TREE, indexed title → emoji; duplicates: first wins.
//
// NULL prototype: a suite called "constructor" would otherwise answer the lookup
// below with something off Object.prototype.
function indexSuiteEmoji(nodes, into) {
  for (const n of nodes || []) {
    if (n.title && n.emoji && !(n.title in into)) into[n.title] = n.emoji;
    indexSuiteEmoji(n.children, into);
  }
  return into;
}

const suiteEmojiOf = (title) => (title && state.suiteEmoji ? state.suiteEmoji[title] || null : null);

// Wholesale replacement, not a merge: a mark the project TOOK AWAY must disappear.
function rememberSuiteEmoji(roots) {
  state.suiteEmoji = indexSuiteEmoji(roots, Object.create(null));
}

// Stale-while-revalidate: the mark is the project's to change mid-session. Painted
// in place — a full repaint would throw away the row a tester is part-way through.
async function loadSuiteEmoji(runId) {
  // The Tests tab may already hold the same tree — draw from it rather than wait.
  if (!state.suiteEmoji && state.tcSuites?.length) rememberSuiteEmoji(state.tcSuites);
  if (state.suiteEmoji) paintSuiteEmoji();
  let roots;
  try { roots = await TestomatAPI.getSuiteTree(); } catch { return; }
  if (state.runId !== runId) return; // a different run (or none) is on screen now
  rememberSuiteEmoji(roots);
  paintSuiteEmoji();
}

// `dataset.suite` IS the suite title. The icon that would be drawn now is compared
// with the one standing there, so a repaint that changes nothing leaves the DOM alone.
function paintSuiteEmoji() {
  for (const sec of document.querySelectorAll('#run-tests .suite-section')) {
    const slot = sec.querySelector('.suite-head .file-icon');
    if (!slot) continue;
    const next = treeIcon(FILE_ICON, 'file-icon', suiteEmojiOf(sec.dataset.suite));
    if ((slot.dataset.emoji || '') !== (next.dataset.emoji || '')) slot.replaceWith(next);
  }
}

// The traversal anchor; collapse is ignored (presentation only).
function orderedRecords() {
  const seq = [];
  for (const sec of suiteSections()) seq.push(...sec.rows);
  return seq;
}

// The visible sequence: render order with the filter + search applied.
const visibleRecords = () => orderedRecords().filter(rowVisible);

// Updated, not rebuilt: the counts move on every mark and poll tick, under the eye.
function renderRunFilterChips() {
  const bar = $('run-filter');
  if (!bar) return;
  const counts = runStatusCounts();
  for (const [key, label] of RUN_STATUS_FILTERS) {
    let chip = bar.querySelector(`[data-filter="${key}"]`);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      // Whatever doesn't fit the row leaves it for the `⋯` menu (fitFilterChips).
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

// The input drives state via its own listener, so typing must leave it untouched.
function syncRunSearch() {
  const input = $('run-search');
  const clear = $('run-search-clear');
  if (input && input.value !== state.runSearch) input.value = state.runSearch;
  if (clear) clear.hidden = state.runSearch === '';
}

// The list is rebuilt whole, so a run of a few hundred tests cannot afford one rebuild per keystroke.
// The clear button stays immediate — that part is cheap and the field must not feel unresponsive.
const RUN_SEARCH_MS = 250;
let runSearchTimer = null;

function onRunSearch() {
  state.runSearch = $('run-search').value;
  $('run-search-clear').hidden = state.runSearch.trim() === '';
  clearTimeout(runSearchTimer);
  runSearchTimer = setTimeout(renderRunSections, RUN_SEARCH_MS);
}

function clearRunSearch() {
  $('run-search').value = '';
  state.runSearch = '';
  $('run-search-clear').hidden = true;
  clearTimeout(runSearchTimer); // one deliberate act, not typing — and no stale redraw behind it
  renderRunSections();
  $('run-search').focus();
}

// Drawn as icons: an SVG centres geometrically where a text glyph drifts on font metrics.
const ROW_STATUS_BTNS = [
  ['passed', 'check', 'Mark passed'],
  ['failed', 'close', 'Mark failed'],
  ['skipped', 'remove', 'Mark skipped'],
];
const ROW_BTN_LABEL = Object.fromEntries(ROW_STATUS_BTNS.map(([status, , label]) => [status, label]));

// Each writes its own record — parametrized example rows are separate records.
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

// The row itself stays clickable — only the write buttons go dead, with the reason
// on their tooltip. The default reason is the row's own (a mixed run locks some).
function applyRowLock(li, reason = recordWriteLock(recordFor(li.dataset.recordId))) {
  li.querySelectorAll('.row-actions .row-st').forEach((b) => {
    b.disabled = !!reason;
    Tooltip.set(b, reason || ROW_BTN_LABEL[b.dataset.status] || '');
  });
}

const rowTitle = (r) => r.test_title || (r.test_id ? `Test ${r.test_id}` : 'Untitled test');

// The row itself carries no tooltip — what a mark cannot spell out hangs on the mark.
function statusTip(r) {
  const sub = typeof r?.substatus === 'string' ? r.substatus.trim() : '';
  return [
    statusLabel(displayStatus(r)),
    capabilities.jwt && sub ? sub : '',
  ].filter(Boolean).join(' · ');
}

// The type mark is the row's own `automated` flag — the same one #154 locks on.
// Priority is drawn on EVERY row: no priority still RUNS at `normal`, not unknown.
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
  const example = exampleChip(r);
  if (example) li.append(example);
  // Fixed right cell (flex:none) — a constant column however long the title is.
  li.append(rowStatusButtons(r, li));
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker on (re)render
  li.addEventListener('click', () => openTestView(r.id));
  return li;
}

// The values one example row was run with (#52); the names ride the tooltip, positional to them.
// Not the status mark: flashRowSaved flashes THAT on every write, and this is not a result.
function exampleChip(r) {
  const example = exampleOf(r);
  if (!example?.values?.length) return null;
  const { values, params } = example;
  const span = document.createElement('span');
  span.className = 'example';
  span.textContent = values.join(', ');
  const aligned = Array.isArray(params) && params.length === values.length;
  Tooltip.set(span, aligned ? values.map((v, i) => `${params[i]}: ${v}`).join(' · ') : span.textContent);
  return span;
}

// Swapped, not recoloured: starting/finishing swaps the FORM (a glyph for a loader).
function statusMark(r) {
  // The LABEL, not the internal key: `untested` is this file's word, `pending` is
  // what a person sees — including `data-status`, which the CSS and the e2e read.
  const mark = statusIcon(statusLabel(displayStatus(r)));
  mark.classList.add('row-status');
  Tooltip.set(mark, statusTip(r)); // the word behind the colour (+ the custom status)
  return mark;
}

function repaintRow(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) mark.replaceWith(statusMark(r));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => b.classList.toggle('active', r.status === b.dataset.status));
  applyRowLock(li); // #152: a repaint (own write or livesync) re-asserts the lock
  repaintRowSubstatus(li, r);
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker follows the queue
}

// The custom status rides the status mark's tooltip, so reconciling it rewrites that.
function repaintRowSubstatus(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) Tooltip.set(mark, statusTip(r));
}

// May be absent — rows live only once the run view has rendered.
function runRowEl(recordId) {
  return document.querySelector(`#run-tests li.test-row[data-record-id="${String(recordId)}"]`);
}

// The lock outranks the busy flag: releasing a write must never re-enable a locked row.
function setRowButtonsBusy(li, busy) {
  const lock = recordWriteLock(recordFor(li.dataset.recordId));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => { b.disabled = busy || !!lock; });
}

// The class is toggled off first so a rapid re-write restarts the flash.
function flashRowSaved(li) {
  const badge = li.querySelector('.row-status');
  if (!badge) return;
  badge.classList.remove('saved-flash');
  void badge.offsetWidth; // reflow → restart the animation
  badge.classList.add('saved-flash');
  setTimeout(() => badge.classList.remove('saved-flash'), 1000);
}

function refreshSuiteFraction(li) {
  const sec = li.closest('.suite-section');
  const frac = sec && sec.querySelector('.suite-frac');
  if (!sec || !frac) return;
  const key = sec.dataset.suite;
  const rows = state.records.filter((r) => suiteKeyOf(r) === key);
  const done = rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${rows.length}`;
}

// Same-status click is a no-op; success updates in place, failure restores the record.
async function writeRowStatus(record, status, li) {
  if (!record || record.status === status) return; // same status → no-op
  const btn = li.querySelector(`.row-actions .row-st[data-status="${status}"]`);
  // Claim the row BEFORE any await: two fast clicks inside the probe window would
  // otherwise both get through. A disabled button fires no click.
  setRowButtonsBusy(li, true);
  // #194: paint in the click's own turn — behind the probe await it lagged up to 2s.
  if (btn) btn.classList.add('busy');
  // #186: wait for the archived answer rather than write into a run we were about to lock.
  if (runStateProbe) await awaitRunState();
  // #152/#154: catches the race where the lock landed between the render and the click.
  const lock = recordWriteLock(record);
  if (lock) {
    if (btn) btn.classList.remove('busy'); // applyRunLock repaints in place, so the spinner would strand
    applyRunLock({ force: true }); toast(lock); return;
  }
  const prev = { ...record };
  state.inlineWrites += 1;
  try {
    const res = await WriteCore.writeStatus(record, status, ''); // no comment / no view-specific bits at run level
    if (btn) btn.classList.remove('busy');
    repaintRow(li, record);          // repaint reflects the queued marker too (decorateRow)
    if (!(res && res.queued)) flashRowSaved(li); // green flash only when the write actually landed
    paintRunProgress();
    renderRunFilterChips();
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

// Default COLLAPSED (a huge run must not open as a wall of rows); a single-suite
// run expands, a filter/search auto-expands its matches, an explicit toggle wins.
function suiteSection(sec, rows, single) {
  const li = document.createElement('li');
  li.className = 'suite-section tree-node';
  li.dataset.suite = sec.key;
  const pref = state.expandedSuites[sec.key];
  const filterActive = state.runFilter !== 'all' || state.runSearch.trim() !== '';
  const expanded = filterActive ? true : (pref !== undefined ? pref : single);
  if (!expanded) li.classList.add('collapsed');
  const head = document.createElement('div');
  head.className = 'list-row list-head suite-head tree-row has-chevron';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = sec.title || 'No suite';
  const frac = document.createElement('span');
  // `.row-count` is the shared trailing figure; `.suite-frac` stays as the hook.
  frac.className = 'row-count suite-frac';
  const done = sec.rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${sec.rows.length}`;
  // A project's custom emoji draws instead (suiteEmojiOf — absent until the tree lands).
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

// An actually empty run — nearly always one created outside the web UI.
function runNoTestsEmpty() {
  const s = state.settings || {};
  const actions = [];
  if (s.baseUrl && s.projectId && state.runId) {
    // The same `<host>/projects/<slug>/runs/<id>` shape looksLikeRunUrl parses.
    const a = document.createElement('a');
    a.className = 'btn size-sm';
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/${encodeURIComponent(state.runId)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // The label is a <span>, not a bare text node: the leading-icon padding rule
    // asks whether the ICON is the first child, and a selector cannot see a text node.
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
