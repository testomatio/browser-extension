// The status-write core (IIFE global `WriteCore`). One place turns "the tester marked this test"
// into a request, and three surfaces reach it: the test view's verdict buttons, the run list's
// inline rows (screens/run-view.js) and the offline queue's replay (screens/offline-queue.js).
// It lived in the test view, so a change to how the queue replays meant editing that screen.
//
// It needs no JWT — the v2 token path — so it keeps working under a login-blocked session. The
// CALLER rolls back: this returns what the server said, or `{queued, reason}` when the failure
// was one the queue takes, and throws anything else.
//
// `uploadEvidenceLog` lives in screens/evidence.js, so this core does reach into a screen. That
// edge is smaller than the one it replaces and is left alone deliberately.

/* global TestomatAPI, OfflineQueue, CommentDrafts, state, recordFor, recordWriteLock,
   collectEnvMeta, uploadEvidenceLog, syncBeginWrite, syncEndWrite */

const WriteCore = (() => {
  // Runs AFTER the status write (#116): the meta keys hang off an id a not-yet-graded
  // row only gets in that response, and nothing here may endanger a saved status.
  async function writeEnvMeta(record, status, opts = {}) {
    if (!record?.id) return;
    // #152/#154: a locked result skips both. Scoped to the OPEN run (recordFor) — an
    // offline-queue replay into another, still-live run must keep writing its meta.
    const open = recordFor(record.id);
    if (open && typeof recordWriteLock === 'function' && recordWriteLock(open)) return;
    if (TestomatAPI.jwtAvailable() === false) return;
    // A replay writes the environment SNAPSHOTTED at enqueue: collecting now describes the tab open
    // now. An entry from an older build carries none, and says nothing rather than something wrong.
    const entries = opts.replay ? [...(opts.envMeta || [])] : await collectEnvMeta(state.settings);
    // The two toggles are independent: env-info OFF still lets the log key through. The recorder's
    // window is not parked with the entry, so a replay attaches no log.
    if (status === 'failed' && !opts.replay) {
      const url = await uploadEvidenceLog(record);
      if (url) entries.push(['Console & network log', url]);
    }
    if (!entries.length) return;
    try {
      await TestomatAPI.setTestrunMeta(record.id, entries);
    } catch { /* best effort — the status is already saved */ }
  }

  // Shared status-write core (test view + run-view rows). Needs no JWT — the v2
  // token path — so it keeps working under login-blocked. Caller rolls back.
  async function writeStatus(record, status, comment, onOptimistic, opts = {}) {
    syncBeginWrite(); // pause livesync ticks; force an immediate refetch when this settles
    try {
      const message = comment;
      if (record) Object.assign(record, { status, message });
      if (onOptimistic) onOptimistic();
      let saved;
      try {
        // e2e hook fires before the real request so the enqueue path runs deterministically.
        const forced = typeof OfflineQueue !== 'undefined' ? OfflineQueue.forcedError() : null;
        if (forced) throw forced;
        saved = await TestomatAPI.setStatus({
          testrunId: record?.id,
          runId: state.runId,
          testId: record?.test_id,
          status,
          message,
        });
      } catch (e) {
        // A queueable failure keeps the optimistic status and queues it — no rollback,
        // no toast. `noQueue` replays bypass this so a retry throws and stays queued.
        if (!opts.noQueue && record && record.id != null
            && typeof OfflineQueue !== 'undefined' && OfflineQueue.qualifies(e)) {
          // `reason` is the queued entry's WORDING, nothing else: what queues is unchanged (#106).
          const reason = e.kind === 'auth' ? 'auth' : 'network';
          // The environment as it is NOW, so a replay hours from here describes the test and not
          // the drain. Local (tab + navigator) and caught: nothing may cost the tester the result.
          let envMeta = [];
          try { envMeta = await collectEnvMeta(state.settings); } catch { /* park it without */ }
          await OfflineQueue.enqueue({
            recordId: record.id, runId: state.runId, status, comment, queuedAt: Date.now(), reason, envMeta,
          });
          return { queued: true, reason };
        }
        throw e;
      }
      // The row always exists (opened by record id) and keeps its test_id.
      if (saved && record) Object.assign(record, saved, { test_id: record.test_id });
      // The comment reached the server, so the draft it came from is spent — a queued
      // write does NOT pass here, and its text is held by the queue entry instead.
      if (record && record.id != null) CommentDrafts.drop(record.id);
      // This status supersedes anything queued for the row, or the next replay writes
      // the older one back over it. Before writeEnvMeta and caught: never fatal.
      if (!opts.noQueue && record && record.id != null && typeof OfflineQueue !== 'undefined') {
        // The replay path removes its own entry comparing `queuedAt` — a second removal
        // here would drop a newer click that landed mid-drain.
        try { if (await OfflineQueue.remove(record.id)) OfflineQueue.refreshUI(); } catch { /* the status is saved */ }
      }
      await writeEnvMeta(record, status, opts); // #116 — after the id exists, never fatal
      return saved;
    } finally {
      syncEndWrite();
    }
  }

  return { writeStatus, writeEnvMeta };
})();
