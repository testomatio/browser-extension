// Polls the v2 run-tests payload (a token suffices, so basic mode works); remote wins.

/* global TestomatAPI, state, capabilities, displayStatus, statusLabel, repaintRow,
   repaintRowSubstatus, runRowEl, paintRunProgress, renderRunFilterChips,
   refreshRunInfo, refreshRunFinished, RunInfo, refreshSuiteFraction, renderRunView,
   renderTestProgress, RunLock, TestMeta, recordFor, byRecordId, toast, OfflineQueue,
   $, setStatusLine */

let syncTimer = null;
let syncPollMs = 20000;      // default 20s; overridable via storage.session `pollInterval` (e2e hook)
let syncFetching = false;    // a poll fetch is in flight (no overlap)
let syncEpoch = 0;           // bumped on stop/restart — invalidates an in-flight fetch
let syncWriteDepth = 0;      // tester's own writes in flight (skip ticks while > 0)
let syncAuthStopped = false; // a poll 401/403 stopped the loop; resumes on Refresh (openRunView)
let syncArmedMs = 0;         // the interval the live timer is actually armed with

// After a 429, one tick a minute: polling at the usual rate keeps the instance rate-limiting us.
const SYNC_RATE_LIMIT_MS = 60000;
function syncTargetMs() {
  let at = 0;
  try { at = Number(TestomatAPI.rateLimitedAt?.()) || 0; } catch { at = 0; }
  return at && Date.now() - at < SYNC_RATE_LIMIT_MS ? SYNC_RATE_LIMIT_MS : syncPollMs;
}

// The only place the timer is armed, so the interval cannot drift from syncTargetMs().
function syncArm() {
  if (syncTimer) clearInterval(syncTimer);
  syncArmedMs = syncTargetMs();
  syncTimer = setInterval(syncTick, syncArmedMs);
}

async function readPollMs() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      const v = Number((await chrome.storage.session.get('pollInterval')).pollInterval);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch { /* ignore — use the default */ }
  return 20000;
}

// A test view always belongs to the open run (openTestView opens rows of state.records only).
function syncShouldPoll() {
  if (syncAuthStopped) return false;
  // A read-only project has nothing to keep fresh; core/state.js re-probes for the way back.
  if (capabilities.readonly) return false;
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return false;
  if (!state.runId) return false;
  return state.view === 'run' || state.view === 'test';
}

// Runs on every open and Refresh, so it also clears an auth-stop left by a prior session.
async function startLiveSync() {
  syncAuthStopped = false;
  syncStop();                       // clear a prior timer + bump the epoch
  syncPollMs = await readPollMs();
  syncArm();
}

function syncStop() {
  syncEpoch += 1;                   // invalidate any in-flight fetch
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  syncArmedMs = 0;
}

// Own-write bracket: a poll must not apply a stale snapshot over the fresh local value.
function syncBeginWrite() { syncWriteDepth += 1; }
function syncEndWrite() {
  if (syncWriteDepth > 0) syncWriteDepth -= 1;
  if (syncWriteDepth === 0) syncNow();
}

function syncNow() {
  if (!syncTimer) return;
  syncArm();
  syncTick();
}

async function syncTick() {
  if (!syncShouldPoll() || syncWriteDepth > 0 || syncFetching) return;
  const runId = state.runId;
  const epoch = syncEpoch;
  syncFetching = true;
  try {
    const records = await TestomatAPI.listTestruns(runId);
    if (epoch !== syncEpoch || state.runId !== runId) return; // superseded (stop / run change)
    if (syncWriteDepth > 0 || !syncShouldPoll()) return;      // own write started / navigated away
    // A recovered connection must not leave a red line standing — only a red one goes.
    const line = $('run-status');
    if (line && line.classList.contains('error')) setStatusLine('run-status', '');
    syncApply(records.slice().sort(byRecordId));
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // a successful poll tick is a replay trigger
    // Custom-status counters, Run info and the finished state live in the run detail, not the rows.
    if (await refreshRunInfo(runId)) {
      if (epoch !== syncEpoch || state.runId !== runId) return;
      paintRunProgress();
      if (state.view === 'run') RunInfo.render();
    }
    // The one signal a token-only panel has that the run was finished elsewhere.
    await refreshRunFinished(runId);
    if (epoch !== syncEpoch || state.runId !== runId) return;
    // The lock follows a remote finish, automated flip or archive within one poll interval.
    RunLock.applyRunLock();
  } catch (e) {
    // A 401/403 parks the loop without toast spam; Refresh resumes it, other errors just retry.
    if (e && e.kind === 'auth') { syncAuthStopped = true; syncStop(); }
  } finally {
    syncFetching = false;
    // Re-arm when this tick's answer moved the rate-limit stamp, so the next tick uses its interval.
    if (syncTimer && syncArmedMs !== syncTargetMs()) syncArm();
  }
}

function capStatus(status) {
  const s = statusLabel(status);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Keyed by record id, not test_id: example rows share a test_id.
function syncApply(remote) {
  const cur = new Map(state.records.map((r) => [String(r.id), r]));
  const incoming = new Map(remote.map((r) => [String(r.id), r]));
  const sameSet = cur.size === incoming.size && [...cur.keys()].every((k) => incoming.has(k));

  if (!sameSet) {
    // Drafts and step ticks live outside the records, so a full re-render keeps them.
    state.records = remote;
    if (state.view === 'run') renderRunView();
    else if (state.view === 'test') renderTestProgress();
    return;
  }

  const openId = state.view === 'test' ? String(state.currentRecordId) : null;
  const changed = [];
  let openToast = null;
  for (const [id, rem] of incoming) {
    const local = cur.get(id);
    if (!local) continue;
    // A queued status counts as an own write in flight: the local status and message win.
    const queued = typeof OfflineQueue !== 'undefined' && OfflineQueue.has(id);
    const statusChanged = !queued && displayStatus(rem) !== displayStatus(local);
    // A remote custom-status write changes no status, so it needs its own diff.
    const substatusChanged = (rem.substatus || null) !== (local.substatus || null);
    const keepLocal = queued ? { status: local.status, message: local.message } : null;
    Object.assign(local, rem, { test_id: rem.test_id != null ? rem.test_id : local.test_id }, keepLocal || {});
    if (statusChanged || substatusChanged) {
      changed.push({ id, local, statusChanged, substatusChanged });
      if (openId && id === openId && statusChanged) {
        openToast = { title: local.test_title || `Test ${local.test_id}`, status: local.status };
      }
    }
  }
  if (!changed.length) return;

  for (const c of changed) {
    const li = runRowEl(c.id);
    if (!li) continue;
    if (c.statusChanged) repaintRow(li, c.local);          // also relabels the status mark
    else if (c.substatusChanged) repaintRowSubstatus(li, c.local);
  }
  paintRunProgress();
  renderRunFilterChips();
  for (const c of changed) { const li = runRowEl(c.id); if (li) refreshSuiteFraction(li); }
  if (state.view === 'test') renderTestProgress();
  // A colleague's status write closes the assignee gate; the select otherwise repaints only on open.
  if (openToast && typeof TestMeta !== 'undefined') TestMeta.applyAssigneeGate(recordFor(openId));
  if (openToast) toast(`"${openToast.title}" → ${capStatus(openToast.status)}`);
}

// Ticks no-op while hidden, so becoming visible triggers an immediate catch-up.
function initLiveSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTick();
  });
}
