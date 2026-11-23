// Status-write core shared by the test view, run-list rows and the offline queue's replay.

/* global TestomatAPI, OfflineQueue, CommentDrafts, state, recordFor, RunLock,
   collectEnvMeta, EvidenceUpload, syncBeginWrite, syncEndWrite */

const WriteCore = (() => {
  // Runs after the status write: a not-yet-graded row only gets its id in that response.
  async function writeEnvMeta(record, status, opts = {}) {
    if (!record?.id || status === 'pending') return; // an unset result ran nowhere
    // Lock check scoped to the open run: a queue replay into another, still-live run keeps its meta.
    const open = recordFor(record.id);
    if (open && typeof RunLock !== 'undefined' && RunLock.recordWriteLock(open)) return;
    if (TestomatAPI.jwtAvailable() === false) return;
    // A replay writes the environment snapshotted at enqueue, not the tab open now.
    const entries = opts.replay ? [...(opts.envMeta || [])] : await collectEnvMeta(state.settings);
    // The recorder's window is not parked with a queued entry, so a replay attaches no log.
    if (status === 'failed' && !opts.replay) {
      const url = await EvidenceUpload.log(record);
      if (url) entries.push(['Console & network log', url]);
    }
    if (!entries.length) return;
    try {
      await TestomatAPI.setTestrunMeta(record.id, entries);
    } catch { /* best effort — the status is already saved */ }
  }

  // Needs no JWT (v2 token path), so it works under a login-blocked session; the caller rolls back.
  async function writeStatus(record, status, comment, onOptimistic, opts = {}) {
    syncBeginWrite(); // pause livesync ticks; force an immediate refetch when this settles
    try {
      const message = comment;
      const prevStatus = record ? record.status : undefined; // what a Discard puts back
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
        // `noQueue` replays bypass the queue so a failed retry throws and stays queued.
        if (!opts.noQueue && record && record.id != null
            && typeof OfflineQueue !== 'undefined' && OfflineQueue.qualifies(e)) {
          // `reason` only picks the queued entry's wording; it does not change what queues.
          const reason = e.kind === 'auth' ? 'auth' : 'network';
          // Snapshot the environment now, so a replay hours later describes the test, not the drain.
          let envMeta = [];
          try { envMeta = await collectEnvMeta(state.settings); } catch { /* park it without */ }
          await OfflineQueue.enqueue({
            recordId: record.id, runId: state.runId, status, comment, queuedAt: Date.now(), reason, envMeta, prevStatus,
          });
          return { queued: true, reason };
        }
        throw e;
      }
      if (saved && record) Object.assign(record, saved, { test_id: record.test_id });
      // The comment reached the server, so its draft is spent; a queued entry holds its own copy.
      if (record && record.id != null) CommentDrafts.drop(record.id);
      // Drop anything queued for the row, or the next replay writes the older status back over it.
      if (!opts.noQueue && record && record.id != null && typeof OfflineQueue !== 'undefined') {
        // Replays remove their own entry by `queuedAt`; removing here would drop a newer mid-drain click.
        try { if (await OfflineQueue.remove(record.id)) OfflineQueue.refreshUI(); } catch { /* the status is saved */ }
      }
      await writeEnvMeta(record, status, opts);
      return saved;
    } finally {
      syncEndWrite();
    }
  }

  return { writeStatus, writeEnvMeta };
})();
