// Offline queue (M4 cycle 2): a status click that fails on a network error or a
// transient 401/403 «paused» token is applied locally and queued in
// chrome.storage.local (survives restart), shown as pending, and replayed when
// connectivity returns. Only test status writes ✓/✗/– (incl. the FAIL comment)
// are queued — the run hot path; assign/custom status/finish/steps/attachments
// fail honestly as before. Conflict policy is queue-wins (last-write-wins, same
// as the server). Drains from the PANEL only (background is untouched): a closed
// panel means the queue waits for the next open.

/* global TestomatAPI, state, capabilities, hasChrome, isReadonlyError, recordFor,
   runRowEl, repaintRow, toast, writeStatus, runStatusTerminal, $, Tooltip */

// The drain is the ONE write path that outlives the run view, so it re-checks the
// target run's write lock itself (#152 finished, #186 archived + automated) — see
// dropLockedRunEntries below.

// One entry PER record id (the only identity that separates two example rows of
// a parametrized test); a newer click replaces the older, so only the final
// status replays. In-memory cache is the source of truth for the synchronous
// marker/count reads; storage is written through on every mutation.
let queueCache = {};        // { [String(recordId)]: {recordId, runId, status, comment, queuedAt} }
let queueDraining = false;  // FIFO, one drain at a time — no retry storm
let queueRedrainRequested = false; // #192: a trigger that arrived mid-drain, honoured once after it
let queueLastPass = false;         // the running pass is the last one — no more can be promised
// e2e write-failure hook (storage.session `forceWriteFail`, mirroring the
// pollInterval/stepRecCap precedent): null | 'network' | 'auth'. Cached and kept
// live via storage.session.onChanged so writeStatus consults it with no per-call
// storage read.
let forceFail = null;

const QUEUE_KEY = 'offlineQueue';
const qKey = (recordId) => String(recordId);
const normalizeFlag = (v) => (!v ? null : v === 'auth' ? 'auth' : 'network');

// Only a network error or a 401/403 «paused» token qualifies for queueing; every
// other API error (4xx validation, etc.) keeps today's honest error toast.
function queueQualifies(e) { return !!e && (e.kind === 'network' || e.kind === 'auth'); }

// The synthetic write failure for the e2e hook — a real ApiError so `qualifies`
// and the caller treat it exactly like the live failure it stands in for.
function forcedError() {
  if (!forceFail) return null;
  const kind = forceFail === 'auth' ? 'auth' : 'network';
  return new TestomatAPI.ApiError(kind, kind === 'auth' ? 403 : 0, 'forced offline (e2e)');
}

function queueCount() { return Object.keys(queueCache).length; }
function queueHas(recordId) { return Object.prototype.hasOwnProperty.call(queueCache, qKey(recordId)); }

async function persistQueue() {
  if (!hasChrome) return;
  try { await chrome.storage.local.set({ [QUEUE_KEY]: queueCache }); } catch { /* best effort */ }
}

// Add or REPLACE the record's entry (newer click wins) and refresh the UI. The
// stored comment is the RAW tester text — replay re-derives the env-info/evidence
// suffix through writeStatus, so it reflects the state at replay time.
async function queueEnqueue({ recordId, runId, status, comment, queuedAt }) {
  queueCache[qKey(recordId)] = {
    recordId, runId, status, comment: comment || '', queuedAt: queuedAt || Date.now(),
  };
  await persistQueue();
  refreshQueueUI();
}

async function queueRemove(recordId) {
  const key = qKey(recordId);
  if (Object.prototype.hasOwnProperty.call(queueCache, key)) {
    delete queueCache[key];
    await persistQueue();
  }
}

// #152/#186: a run can change state while its results sit in the queue, and the
// queue is the one write path that outlives the view — replaying into a run the
// panel now refuses to write would smuggle past the very lock every live control
// respects (the server itself checks no run state). So the drain resolves each
// DISTINCT target run once and drops everything aimed at a locked one. Entries
// whose run cannot be read (offline — the common case here) are left alone: the
// replay below fails on its own terms and keeps them for the next trigger.
// Pre-#152 entries carry a runId too (offline-queue has stored one since day one),
// but an absent one simply replays as before.
//
// The three reasons mirror run-view's runWriteLock(), same precedence — but read
// from the API rather than from the open run, because the target run is usually
// NOT the one on screen:
//   * finished  — v2 run status, terminal (#152);
//   * automated — v2 run `kind`, which the queue ignored entirely until #186.
//     RUN level only: an entry for one automated row of a MIXED run still replays,
//     since the drop resolves runs and the v2 run detail carries no per-row flag;
//   * archived  — the JSON:API `is-archived` (#186). Session-only, exactly as in
//     run-view: a basic-mode panel cannot see it and replays as before.
const QUEUE_DROP_FINISHED = 'Run finished';
const QUEUE_DROP_AUTOMATED = 'Automated run';
const QUEUE_DROP_ARCHIVED = 'Run archived';

// The two reads go out TOGETHER, and so does every run: the archived flag lives on
// a different endpoint from status/kind, and resolving them in series WIDENED the
// drain's dead time — measured at ~1.35x, 158ms median to 117ms — which was enough
// for a Retry click to arrive while `queueDraining` was still set (measured, not
// theorised: it cost 36-finished-lock's queue case a toast it had always received).
// Since #192 such a click is coalesced rather than dropped, but a narrow dead time
// is still the cheaper half of the fix.
async function runDropReason(runId) {
  const [detail, info] = await Promise.all([
    TestomatAPI.getRun(runId).catch(() => null),
    capabilities.jwt ? TestomatAPI.getRunInfo(runId).catch(() => null) : null, // basic mode is blind (#186)
  ]);
  if (info && info.isArchived === true) return QUEUE_DROP_ARCHIVED; // outranks the other two
  if (!detail) return ''; // unknown state → replay as before
  if (runStatusTerminal(detail.status)) return QUEUE_DROP_FINISHED;
  if (String(detail.kind || '').toLowerCase() === 'automated') return QUEUE_DROP_AUTOMATED;
  return '';
}

// Drop every entry whose run is locked; answers {reason: count} so the caller can
// raise one honest toast per reason (never a silent discard — these are results
// the tester believes are saved).
async function dropLockedRunEntries(list) {
  const runIds = [...new Set(list.map((e) => e.runId).filter((id) => id != null).map(String))];
  if (!runIds.length) return {};
  const resolved = await Promise.all(runIds.map((id) => runDropReason(id)));
  const reasons = new Map();
  runIds.forEach((id, i) => { if (resolved[i]) reasons.set(id, resolved[i]); });
  const dropped = {};
  for (const e of list) {
    const reason = e.runId != null ? reasons.get(String(e.runId)) : null;
    if (!reason) continue;
    await queueRemove(e.recordId);
    dropped[reason] = (dropped[reason] || 0) + 1;
  }
  return dropped;
}

// ONE pass over the queue, FIFO, off a snapshot taken here — an entry queued
// after it waits for the next pass. A qualifying (still-offline) failure stops
// the pass and keeps every entry for the next trigger; a non-qualifying failure
// (e.g. the record was deleted) drops that one entry so it can't wedge the banner
// forever. Records not currently loaded replay against a bare {id} pseudo-record
// (replay needs only the API, not the run being open).
async function drainPass() {
  const list = Object.values(queueCache).sort((a, b) => a.queuedAt - b.queuedAt);
  if (!list.length) return;
  // ONE toast, not one per reason: a second toast() replaces the first in the
  // DOM, and a drop nobody was told about is exactly what this path exists to
  // prevent. A single-reason drain reads the same as it always did.
  const dropped = Object.entries(await dropLockedRunEntries(list))
    .map(([reason, n]) => `${reason} — ${n} queued ${n === 1 ? 'result was' : 'results were'} not written`);
  if (dropped.length) toast(dropped.join(' · '), { error: true });
  for (const entry of list) {
    const snap = queueCache[qKey(entry.recordId)];
    if (!snap) continue; // removed/replaced/dropped since the snapshot list was taken
    const record = (typeof recordFor === 'function' && recordFor(snap.recordId)) || { id: snap.recordId };
    try {
      await writeStatus(record, snap.status, snap.comment, null, { noQueue: true });
    } catch (e) {
      // #155: read-only access is not a permanent failure of THIS entry — a
      // role change can still land it — so it keeps the queue like an offline
      // failure does, instead of dropping results with a toast.
      if (queueQualifies(e) || isReadonlyError(e)) break; // keep all, retry on the next trigger
      await queueRemove(snap.recordId); // permanent failure — drop so the banner can clear
      toast(`A queued status couldn't be saved and was dropped: ${e.message}`, { error: true });
      continue;
    }
    // Success — remove only if a newer click hasn't replaced it mid-drain.
    const cur = queueCache[qKey(snap.recordId)];
    if (cur && cur.queuedAt === snap.queuedAt) await queueRemove(snap.recordId);
    const li = typeof runRowEl === 'function' ? runRowEl(snap.recordId) : null;
    const r = typeof recordFor === 'function' ? recordFor(snap.recordId) : null;
    if (li && r && typeof repaintRow === 'function') repaintRow(li, r);
  }
}

// Drains, one at a time. Triggers: `online`, a successful poll tick, the banner
// Retry, panel/run open. `user` marks the Retry — the one trigger with a human
// behind it, and the only one allowed to raise a toast (a poll tick landing
// mid-drain must stay quiet).
async function queueReplay({ user = false } = {}) {
  // #192 (was a documented wart in #186): a trigger arriving mid-drain used to be
  // swallowed here and raise nothing — the tester's click did nothing at all, and
  // entries queued after the running drain took its snapshot waited for a trigger
  // that might never come. It is COALESCED instead: remembered, and honoured by
  // ONE more pass after the current drain. One, not a loop — that is what keeps
  // the original "no retry storm" promise.
  if (queueDraining) {
    queueRedrainRequested = true;
    // Two wordings, because only one of them can be kept: inside the LAST pass
    // there is no further pass to promise, and a click answered with a promise
    // nothing will honour is a nicer-sounding version of the bug being fixed.
    // Either way the click is answered — it is never silently ignored.
    if (user) {
      toast(queueLastPass
        ? 'Still syncing — give it a moment and try again'
        : 'Already syncing — your Retry runs right after');
    }
    return;
  }
  if (!hasChrome) return;
  if (capabilities.readonly) return; // #155 — a locked project takes no write; keep the queue
  if (!queueCount()) return;
  queueDraining = true;
  try {
    const PASSES = 2; // the drain + the ONE coalesced re-run
    for (let pass = 0; pass < PASSES; pass++) {
      queueRedrainRequested = false;
      queueLastPass = pass === PASSES - 1;
      await drainPass();
      if (!queueRedrainRequested || !queueCount()) break; // nothing asked for, or nothing left
    }
  } finally {
    queueDraining = false;
    queueRedrainRequested = false;
    queueLastPass = false;
    refreshQueueUI();
  }
}

// ---------- UI: pending banner + «queued» markers ----------

// Slim banner «N changes pending · Retry» (degraded-banner style). Shown on the
// runs/run/test views whenever the queue is non-empty — entries for runs other
// than the open one still count.
function updatePendingBanner() {
  const banner = $('pending-banner');
  if (!banner) return;
  const n = queueCount();
  const onView = state.view === 'runs' || state.view === 'run' || state.view === 'test';
  const showit = n > 0 && onView;
  banner.hidden = !showit;
  if (!showit) return;
  const txt = banner.querySelector('.pending-banner-text');
  if (txt) txt.textContent = `${n} ${n === 1 ? 'change' : 'changes'} pending`;
}

// The small «queued» marker on a run-view row (add/remove to match the record's
// queue state). Called from repaintRow + testRow so every render path reflects
// the queue.
// The run-view row lost its `.meta` line when the rows went to ONE line (the
// marks moved in front of the title), and this used to bail when it found none —
// so an offline write silently stopped marking its row (#215). The row ITSELF is
// the host now, and the marker lands before the ✓/✗/– cell so that cell still
// closes the row; a `.meta` line, where one exists, is still preferred.
function applyQueuedMarker(li, recordId) {
  if (!li) return;
  const host = li.querySelector('.meta') || li;
  const queued = queueHas(recordId);
  let mark = host.querySelector('.queued-mark');
  if (queued && !mark) {
    mark = document.createElement('span');
    mark.className = 'badge outline queued-mark';
    mark.textContent = 'queued';
    Tooltip.set(mark, 'Saved offline — will sync when the connection returns');
    // insertBefore(node, null) appends — the `.meta` host has no actions cell.
    host.insertBefore(mark, host.querySelector(':scope > .row-actions'));
  } else if (!queued && mark) {
    mark.remove();
  }
}

// The test-view «queued» marker for the open record.
function updateTestQueuedMarker() {
  const el = $('test-queued');
  if (!el) return;
  el.hidden = !(state.view === 'test' && state.currentRecordId != null && queueHas(state.currentRecordId));
}

function refreshQueueUI() {
  updatePendingBanner();
  document.querySelectorAll('#run-tests li.test-row').forEach((li) => applyQueuedMarker(li, li.dataset.recordId));
  updateTestQueuedMarker();
}

// ---------- init ----------

async function loadForceFlag() {
  try {
    if (chrome?.storage?.session) {
      forceFail = normalizeFlag((await chrome.storage.session.get('forceWriteFail')).forceWriteFail);
    }
  } catch { /* ignore — no hook */ }
}

async function queueInit() {
  if (!hasChrome) return;
  try {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    const q = stored && stored[QUEUE_KEY];
    queueCache = q && typeof q === 'object' ? q : {};
  } catch { queueCache = {}; }
  await loadForceFlag();
  try {
    chrome.storage.session.onChanged.addListener((c) => {
      if (c.forceWriteFail) forceFail = normalizeFlag(c.forceWriteFail.newValue);
    });
  } catch { /* older Chrome — no session onChanged */ }
  if (typeof window !== 'undefined') window.addEventListener('online', () => queueReplay());
  const retry = $('pending-banner-retry');
  if (retry) retry.addEventListener('click', () => queueReplay({ user: true }));
  refreshQueueUI();
}

const OfflineQueue = {
  init: queueInit,
  has: queueHas,
  count: queueCount,
  qualifies: queueQualifies,
  enqueue: queueEnqueue,
  replay: queueReplay,
  forcedError,
  decorateRow: applyQueuedMarker,
  updateTestMarker: updateTestQueuedMarker,
  refreshUI: refreshQueueUI,
};
