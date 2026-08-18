// Offline queue: ONLY test status writes are queued (on network / transient
// 401-403), and only the PANEL drains — a closed panel means the queue waits.

/* global TestomatAPI, state, capabilities, hasChrome, isReadonlyError, recordFor,
   runRowEl, repaintRow, toast, writeStatus, runStatusTerminal, $, Tooltip */

// One entry PER record id — the only identity separating two example rows of a
// parametrized test; a newer click replaces the older, so only the final replays.
let queueCache = {};        // { [String(recordId)]: {recordId, runId, status, comment, queuedAt} }
let queueDraining = false;  // FIFO, one drain at a time — no retry storm
let queueRedrainRequested = false; // #192: a trigger that arrived mid-drain, honoured once after it
let queueLastPass = false;         // the running pass is the last one — no more can be promised
// e2e hook (storage.session `forceWriteFail`): null | 'network' | 'auth', kept
// live via onChanged so writeStatus needs no per-call storage read.
let forceFail = null;

const QUEUE_KEY = 'offlineQueue';
const qKey = (recordId) => String(recordId);
const normalizeFlag = (v) => (!v ? null : v === 'auth' ? 'auth' : 'network');

// Only a network error or a 401/403 «paused» token queues; every other API error
// keeps its honest error toast.
function queueQualifies(e) { return !!e && (e.kind === 'network' || e.kind === 'auth'); }

// A real ApiError, so callers treat it exactly like the live failure it stands in for.
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

// Add or REPLACE (newer click wins). The stored comment is the RAW tester text —
// replay re-derives the env-info/evidence suffix at replay time.
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

// #152/#186: the SERVER checks no run state, and the queue is the one write path
// that outlives the view — so the drain resolves each target run and drops locked ones.
const QUEUE_DROP_FINISHED = 'Run finished';
const QUEUE_DROP_AUTOMATED = 'Automated run';
const QUEUE_DROP_ARCHIVED = 'Run archived';

// Both reads go out TOGETHER (archived lives on another endpoint): in series they
// widened the drain's dead time ~1.35x — wide enough to swallow a Retry click.
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

// Answers {reason: count} — never a silent discard, these are results the tester
// believes are saved.
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

// ONE FIFO pass off a snapshot. A still-offline failure stops the pass and keeps
// every entry; any other failure drops that one, so it cannot wedge the banner.
async function drainPass() {
  const list = Object.values(queueCache).sort((a, b) => a.queuedAt - b.queuedAt);
  if (!list.length) return;
  // ONE toast, not one per reason — a second toast() replaces the first in the DOM.
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
      // #155: read-only is not a permanent failure of THIS entry — a role change
      // can still land it, so it keeps the queue like an offline failure does.
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

// Triggers: `online`, a successful poll tick, the banner Retry, panel/run open.
// `user` marks the Retry — the only trigger allowed to raise a toast.
async function queueReplay({ user = false } = {}) {
  // #192: a trigger arriving mid-drain is COALESCED — honoured by ONE more pass
  // after the current drain. One, not a loop, so there is still no retry storm.
  if (queueDraining) {
    queueRedrainRequested = true;
    // Two wordings: inside the LAST pass there is no further pass to promise.
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

// Entries for runs other than the open one still count towards the banner.
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

// #215: rows went to ONE line and lost their `.meta`, and bailing on a missing
// `.meta` stopped marking offline writes — the row ITSELF is the host now.
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
