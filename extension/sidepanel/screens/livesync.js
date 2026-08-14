// Live sync (M4 cycle 1): keep the open run fresh without Refresh by polling the
// same v2 run-tests payload run-view already loads (token suffices → works in
// basic mode). Remote wins: diff by testrun record id, repaint changed rows in
// place (#40/#49 infra). No runs-list polling; ActionCable push is #55 (blocked).
// One extra leg rides the same tick under a session: the run's custom-status
// counters (#109), which live on the JSON:API run detail rather than in the rows.
//
// Timer runs only while a run is open; each tick self-gates on view + visibility.
// Own writes (status/substatus/assign) pause ticks and force an immediate refetch.

/* global TestomatAPI, state, capabilities, displayStatus, statusLabel, repaintRow,
   repaintRowSubstatus, runRowEl, paintRunProgress, renderRunFilterChips,
   refreshRunInfo, refreshRunFinished, renderRunInfo, refreshSuiteFraction, renderRunView,
   renderTestProgress, applyRunLock, applyAssigneeGate, recordFor, toast, OfflineQueue */

let syncTimer = null;
let syncPollMs = 20000;      // default 20s; overridable via storage.session `pollInterval` (e2e hook)
let syncFetching = false;    // a poll fetch is in flight (no overlap)
let syncEpoch = 0;           // bumped on stop/restart — invalidates an in-flight fetch
let syncWriteDepth = 0;      // tester's own writes in flight (skip ticks while > 0)
let syncAuthStopped = false; // a poll 401/403 stopped the loop; resumes on Refresh (openRunView)

// Test hook precedent = background.js srCap(): read an override from
// chrome.storage.session, fall back to the default.
async function readPollMs() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      const v = Number((await chrome.storage.session.get('pollInterval')).pollInterval);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch { /* ignore — use the default */ }
  return 20000;
}

// Poll only when a run (or a test OF that run) is open, the panel is visible, and
// no poll auth-failure has parked the loop. A test view is always a test of the
// open run (openTestView only opens rows of state.records), so no extra check.
function syncShouldPoll() {
  if (syncAuthStopped) return false;
  if (capabilities.readonly) return false; // #155 — nothing open to keep fresh
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return false;
  if (!state.runId) return false;
  return state.view === 'run' || state.view === 'test';
}

// (Re)start the loop for the current run. Called by openRunView on every open /
// Refresh, so it also clears any auth-stop from a prior session (resume-on-Refresh).
async function startLiveSync() {
  syncAuthStopped = false;
  syncStop();                       // clear a prior timer + bump the epoch
  syncPollMs = await readPollMs();
  syncTimer = setInterval(syncTick, syncPollMs);
}

function syncStop() {
  syncEpoch += 1;                   // invalidate any in-flight fetch
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// Own-write bracket: the caller wraps its optimistic-mutation + API round trip so
// a poll can't apply a stale snapshot over the fresh local value. Draining to zero
// forces an immediate refetch with the timer reset (spec: own write → refetch now).
function syncBeginWrite() { syncWriteDepth += 1; }
function syncEndWrite() {
  if (syncWriteDepth > 0) syncWriteDepth -= 1;
  if (syncWriteDepth === 0) syncNow();
}

// Immediate refetch + timer reset — only meaningful while the loop is active.
function syncNow() {
  if (!syncTimer) return;
  clearInterval(syncTimer);
  syncTimer = setInterval(syncTick, syncPollMs);
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
    syncApply(records.slice().sort((a, b) => (a.id > b.id ? 1 : -1)));
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // a successful poll tick is a replay trigger
    // The run detail rides the same tick: custom-status counters (#109), the Run
    // info fields (#112) and — since #152 — the run's own finished state all live
    // there rather than in the rows. A separate read: a colleague's substatus
    // write changes no row status, and a run that finishes elsewhere leaves the
    // rows it already graded alone, so none of it would otherwise catch up.
    // Best-effort inside (JWT-gated, swallows its own failures) — it can neither
    // park the loop nor blank the numbers.
    if (await refreshRunInfo(runId)) {
      if (epoch !== syncEpoch || state.runId !== runId) return;
      paintRunProgress();
      if (state.view === 'run') renderRunInfo();
    }
    // Basic mode has no such read, so it re-reads the v2 run detail instead — the
    // one signal a token-only panel has that the run was finished elsewhere.
    await refreshRunFinished(runId);
    if (epoch !== syncEpoch || state.runId !== runId) return;
    // The lock engages (or lifts) within one poll interval of a remote finish —
    // since #154, of a reporter result flipping a row to automated (the rows the
    // tick just merged are part of the memo signature) — and since #186 of the
    // run being archived (or restored) elsewhere, which rides the same
    // refreshRunInfo read above and changes no status at all. Called
    // unconditionally: an unchanged tick costs nothing, and no path can leave
    // the controls behind.
    applyRunLock();
  } catch (e) {
    // A token 401/403 on the poll path parks the loop (no toast spam); Refresh
    // resumes it via openRunView. Other errors are skipped — the next tick retries.
    if (e && e.kind === 'auth') { syncAuthStopped = true; syncStop(); }
  } finally {
    syncFetching = false;
  }
}

// Capitalize a status label for the open-test toast ("failed" → "Failed").
function capStatus(status) {
  const s = statusLabel(status);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Remote-wins diff (keyed by record id — example rows share test_id, known rake).
// Repaints changed rows in place; recomputes progress/chip counts/suite fractions;
// toasts only for a remote status change of the OPEN test (no actor name — polling
// carries none). Never touches the comment draft (textarea) or local step ticks
// (state.stepTicks) — both live outside the record data this apply mutates.
function syncApply(remote) {
  const cur = new Map(state.records.map((r) => [String(r.id), r]));
  const incoming = new Map(remote.map((r) => [String(r.id), r]));
  const sameSet = cur.size === incoming.size && [...cur.keys()].every((k) => incoming.has(k));

  if (!sameSet) {
    // Structural change (rare for a pre-created checklist). Replace + full re-render,
    // preserving expansion prefs; drafts/step-ticks are separate DOM/state.
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
    // A locally queued status counts as an own-write in flight: the remote snapshot
    // must never overwrite it (queue wins). Keep the local status/message; apply
    // every other field, and never treat it as a remote status change (no repaint,
    // no toast) — extends the #56 own-write bracket to a queued entry.
    const queued = typeof OfflineQueue !== 'undefined' && OfflineQueue.has(id);
    const statusChanged = !queued && displayStatus(rem) !== displayStatus(local);
    // A remote custom-status write (#109) changes no status, so it needs its own
    // diff to reach the label on the row's status mark. A remote ASSIGN needs
    // none: the record is refreshed either way (below), and the run row stopped
    // naming its assignee — the open test's select is where that is read.
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
  // #153: a COLLEAGUE's status write closes the assignee gate on the open test
  // too — the select is otherwise repainted only on open, and would sit enabled
  // over a row the panel now refuses to re-assign.
  if (openToast && typeof applyAssigneeGate === 'function') applyAssigneeGate(recordFor(openId));
  if (openToast) toast(`"${openToast.title}" → ${capStatus(openToast.status)}`);
}

// Immediate catch-up when the panel becomes visible again (the timer keeps firing
// underneath but ticks no-op while hidden). Wired from app.js init().
function initLiveSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncTick();
  });
}
