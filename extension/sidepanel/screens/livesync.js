// Live sync: polls the same v2 run-tests payload run-view loads (a token suffices,
// so basic mode works). Remote wins; the timer runs only while a run is open.

/* global TestomatAPI, state, capabilities, displayStatus, statusLabel, repaintRow,
   repaintRowSubstatus, runRowEl, paintRunProgress, renderRunFilterChips,
   refreshRunInfo, refreshRunFinished, renderRunInfo, refreshSuiteFraction, renderRunView,
   renderTestProgress, applyRunLock, applyAssigneeGate, recordFor, toast, OfflineQueue,
   $, setStatusLine */

let syncTimer = null;
let syncPollMs = 20000;      // default 20s; overridable via storage.session `pollInterval` (e2e hook)
let syncFetching = false;    // a poll fetch is in flight (no overlap)
let syncEpoch = 0;           // bumped on stop/restart — invalidates an in-flight fetch
let syncWriteDepth = 0;      // tester's own writes in flight (skip ticks while > 0)
let syncAuthStopped = false; // a poll 401/403 stopped the loop; resumes on Refresh (openRunView)
let syncArmedMs = 0;         // the interval the live timer is actually armed with

// #106: polling a rate-limited instance at the usual rate is what keeps it rate-limiting us. While
// the API's last answer was a 429, one tick a minute; a 2xx clears the stamp and the next re-arm
// returns to the ordinary interval — as does a stamp gone stale, if no answer ever arrives.
const SYNC_RATE_LIMIT_MS = 60000;
function syncTargetMs() {
  let at = 0;
  try { at = Number(TestomatAPI.rateLimitedAt?.()) || 0; } catch { at = 0; }
  return at && Date.now() - at < SYNC_RATE_LIMIT_MS ? SYNC_RATE_LIMIT_MS : syncPollMs;
}

// The ONE place the timer is armed, so the interval can never drift from syncTargetMs().
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

// A test view is always a test OF the open run (openTestView only opens rows of
// state.records), so no extra check is needed for it.
function syncShouldPoll() {
  if (syncAuthStopped) return false;
  // #155 — nothing open to keep fresh; core/state.js re-probes for the way back instead.
  if (capabilities.readonly) return false;
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return false;
  if (!state.runId) return false;
  return state.view === 'run' || state.view === 'test';
}

// Called by openRunView on every open / Refresh, so it also clears an auth-stop
// left by a prior session.
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

// Own-write bracket: a poll must not apply a stale snapshot over the fresh local
// value. Draining to zero forces an immediate refetch with the timer reset.
function syncBeginWrite() { syncWriteDepth += 1; }
function syncEndWrite() {
  if (syncWriteDepth > 0) syncWriteDepth -= 1;
  if (syncWriteDepth === 0) syncNow();
}

// Immediate refetch + timer reset — only meaningful while the loop is active.
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
    syncApply(records.slice().sort((a, b) => (a.id > b.id ? 1 : -1)));
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // a successful poll tick is a replay trigger
    // The run detail rides the same tick: custom-status counters (#109), Run info
    // (#112) and the finished state (#152) live there, not in the rows. Best-effort.
    if (await refreshRunInfo(runId)) {
      if (epoch !== syncEpoch || state.runId !== runId) return;
      paintRunProgress();
      if (state.view === 'run') renderRunInfo();
    }
    // Basic mode has no such read, so it re-reads the v2 run detail instead — the
    // one signal a token-only panel has that the run was finished elsewhere.
    await refreshRunFinished(runId);
    if (epoch !== syncEpoch || state.runId !== runId) return;
    // The lock engages (or lifts) within one poll interval of a remote finish
    // (#152), an automated flip (#154) or an archive (#186). Unconditional: free.
    applyRunLock();
  } catch (e) {
    // A token 401/403 on the poll path parks the loop (no toast spam); Refresh
    // resumes it via openRunView. Other errors are skipped — the next tick retries.
    if (e && e.kind === 'auth') { syncAuthStopped = true; syncStop(); }
  } finally {
    syncFetching = false;
    // The rate-limit stamp changed under this tick (set by a 429, cleared by a 2xx) — re-arm so the
    // NEXT tick lands at the interval that answer earned. Free while nothing is rate-limiting us.
    if (syncTimer && syncArmedMs !== syncTargetMs()) syncArm();
  }
}

function capStatus(status) {
  const s = statusLabel(status);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Remote-wins diff keyed by RECORD id — example rows share test_id. Never touches
// the comment draft or local step ticks: both live outside the record data.
function syncApply(remote) {
  const cur = new Map(state.records.map((r) => [String(r.id), r]));
  const incoming = new Map(remote.map((r) => [String(r.id), r]));
  const sameSet = cur.size === incoming.size && [...cur.keys()].every((k) => incoming.has(k));

  if (!sameSet) {
    // Structural change: replace + full re-render (drafts and step ticks live
    // in separate DOM/state, so they survive).
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
    // A locally queued status counts as an own write in flight — queue wins: keep
    // the local status/message, apply every other field, raise no remote change.
    const queued = typeof OfflineQueue !== 'undefined' && OfflineQueue.has(id);
    const statusChanged = !queued && displayStatus(rem) !== displayStatus(local);
    // A remote custom-status write (#109) changes no status, so it needs its own
    // diff. A remote ASSIGN needs none — no row names its assignee any more.
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
  // #153: a COLLEAGUE's status write closes the assignee gate on the open test too
  // — the select is otherwise repainted only on open.
  if (openToast && typeof applyAssigneeGate === 'function') applyAssigneeGate(recordFor(openId));
  if (openToast) toast(`"${openToast.title}" → ${capStatus(openToast.status)}`);
}

// The timer keeps firing while hidden but its ticks no-op, so becoming visible
// triggers an immediate catch-up. Wired from app.js init().
function initLiveSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTick();
  });
}
