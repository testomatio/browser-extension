// The panel's write gate: whether a result may be saved at all, why not, and the paint that says so.
// Its own file, not the run screen's — core/write-status.js and nine screens ask it, and app.js
// wires Finish run to it.

/* global state, $, TestomatAPI, ConfirmDialog, toast, progressToast, setStatusLine, handleApiError,
   isAuthError, sleep, stepWriteChain, byRecordId, Tooltip, TestGates, recordFor, ROW_BTN_LABEL,
   updateRunActions, applyRunInfo, renderRunView, awaitRunState */

// ---- write locks: archived (#186), finished (#152), automated (#154) ----
// One plumbing, three reasons: runWriteLock() for the whole run, recordWriteLock()
// for one row; applyRunLock() paints whatever they say onto the DOM.
//
// ---- finished run (#152)
// The server checks no run state on these writes (the CI reporter writes into
// finished runs by design), so the panel is the only place the gate can live.
const TERMINAL_RUN_STATUS = new Set(['passed', 'failed', 'terminated', 'finished']);

const RUN_LOCK_REASON = 'Run is finished — results are read-only';

// ---- archived run (#186)
// The server has no authorization check for archived runs (only list filtering) and
// `Run#calculate_counters` early-returns, so a write leaves counters permanently stale.
//
// ONE signal, session-only: `is-archived` on the JSON:API run detail. The v2 payload
// carries no archived flag at all, so BASIC MODE IS BLIND and deliberately stays so.
const ARCHIVED_LOCK_REASON = 'Run is archived — results are read-only';

// ---- automated result (#154)
// `Testrun#add_step!` returns early on an automated testrun while still answering
// 200, so step writes are swallowed. The RUN's `kind` bars every row, a row's flag one.
const AUTOMATED_LOCK_REASON = 'Automated result — read-only in the panel';

// Driven by the STATE, not by a detected transition: several paths learn that the
// run finished, and a flip-detector missed the paint. `force` is for a rebuilt DOM.
let lockPainted = null; // last signature painted into the DOM; null = never painted

const RunLock = {
  runStatusTerminal: (s) => TERMINAL_RUN_STATUS.has(String(s || '').toLowerCase()),

  runFinished() {
    if (RunLock.runStatusTerminal(state.runStatus)) return true;
    const info = state.runInfo || {};
    return RunLock.runStatusTerminal(info.status) || !!info.finishedAt;
  },

  runArchived: () => (state.runInfo || {}).isArchived === true,

  runAutomated: () => String(state.runKind || '').toLowerCase() === 'automated',

  // The JSON:API detail is consulted for the OPEN test, in case the list row is stale.
  recordAutomated(record) {
    if (!record) return false;
    if (record.automated === true) return true;
    return String(state.currentRecordId) === String(record.id)
      && state.testrunDetail?.data?.attributes?.automated === true;
  },

  // '' = writable, else the reason holding for EVERY row. Archived outranks finished
  // outranks automated: the tester must be told the ACTUAL reason.
  runWriteLock() {
    if (!state.runId) return '';
    if (RunLock.runArchived()) return ARCHIVED_LOCK_REASON;
    if (RunLock.runFinished()) return RUN_LOCK_REASON;
    if (RunLock.runAutomated()) return AUTOMATED_LOCK_REASON;
    return '';
  },

  // The run-level reason first (it is true of this row too), then the row's own flag.
  recordWriteLock(record) {
    return RunLock.runWriteLock() || (RunLock.recordAutomated(record) ? AUTOMATED_LOCK_REASON : '');
  },

  // The reason alone is not enough (#154): a reporter result landing in a mixed run
  // flips one row mid-poll while the run-level reason stays ''.
  lockSignature(reason) {
    const rows = (state.records || []).filter(RunLock.recordAutomated).map((r) => r.id).join(',');
    return `${reason} | ${rows}`;
  },

  applyRunLock({ force = false } = {}) {
    const reason = RunLock.runWriteLock();
    const signature = RunLock.lockSignature(reason);
    if (!force && signature === lockPainted) return;
    lockPainted = signature;
    // Per ROW, not per run: a mixed run locks only its automated rows.
    document.querySelectorAll('#run-tests li.test-row').forEach((li) => RunLock.applyRowLock(li));
    const note = $('run-lock-note');
    if (note) { note.textContent = reason; note.hidden = !reason; }
    updateRunActions();                                        // Finish run hides on the same signal
    if (typeof TestGates !== 'undefined') TestGates.update();
  },

  // The row itself stays clickable — only the write buttons go dead, with the reason
  // on their tooltip. The default reason is the row's own (a mixed run locks some).
  applyRowLock(li, reason = RunLock.recordWriteLock(recordFor(li.dataset.recordId))) {
    li.querySelectorAll('.row-actions .row-st').forEach((b) => {
      b.disabled = !!reason;
      Tooltip.set(b, reason || ROW_BTN_LABEL[b.dataset.status] || '');
    });
  },

  // Finish while writes are pending: step writes ride stepWriteChain, a save flips state.saving.
  async settlePendingWrites() {
    await Promise.resolve(stepWriteChain).catch(() => {});
    for (let i = 0; i < 200 && (state.saving || state.inlineWrites > 0); i++) await sleep(25);
    await Promise.resolve(stepWriteChain).catch(() => {});
    // Answering false is the point: a finished run takes no more writes, so closing over one loses it.
    return !state.saving && state.inlineWrites <= 0;
  },

  // Deliberately NOT runWriteLock(), which would also bar an automated run: the
  // button would be visible and then refuse itself (#154 gates results, not the run).
  finishBlockedReason() {
    if (RunLock.runArchived()) return ARCHIVED_LOCK_REASON;
    if (RunLock.runFinished()) return RUN_LOCK_REASON;
    return '';
  },

  async finishRun() {
    if (!state.runId) return;
    // #186: visibility is not a sufficient gate — the flag lands after updateRunActions().
    // Checked on BOTH sides of the dialog: the confirm can sit open indefinitely.
    await awaitRunState();
    let blocked = RunLock.finishBlockedReason();
    if (blocked) { RunLock.applyRunLock({ force: true }); toast(blocked); return; }
    const ok = await ConfirmDialog.ask('Finish run? Pending tests will be marked skipped.');
    if (!ok) return; // dismissed = no-op
    blocked = RunLock.finishBlockedReason();
    if (blocked) { RunLock.applyRunLock({ force: true }); toast(blocked); return; }
    const btn = $('btn-finish-run');
    if (btn) btn.disabled = true;
    progressToast('Finishing run…');
    try {
      if (!await RunLock.settlePendingWrites()) {
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
  },
};
