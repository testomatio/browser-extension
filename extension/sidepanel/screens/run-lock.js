// The panel's write gate: whether a result may be saved at all, why not, and the paint that says so.

/* global state, $, TestomatAPI, ConfirmDialog, toast, progressToast, setStatusLine, handleApiError,
   isAuthError, sleep, stepWriteChain, byRecordId, Tooltip, TestGates, recordFor, ROW_BTN_LABEL,
   RESET_TIP, updateRunActions, applyRunInfo, renderRunView, awaitRunState */

// The server never checks run state on writes (CI writes to finished runs), so the gate lives here.
const TERMINAL_RUN_STATUS = new Set(['passed', 'failed', 'terminated', 'finished']);

const RUN_LOCK_REASON = 'Run is finished — results are read-only';

// Archived runs accept writes but never recount; only the JSON:API detail flags them (v2 is blind).
const ARCHIVED_LOCK_REASON = 'Run is archived — results are read-only';

// The server answers 200 to step writes on an automated testrun but drops them.
const AUTOMATED_LOCK_REASON = 'Automated result — read-only in the panel';

// Painted from state, not on a transition: several paths learn the run finished. force = rebuilt DOM.
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

  // The JSON:API detail is consulted for the open test, in case the list row is stale.
  recordAutomated(record) {
    if (!record) return false;
    if (record.automated === true) return true;
    return String(state.currentRecordId) === String(record.id)
      && state.testrunDetail?.data?.attributes?.automated === true;
  },

  // '' = writable. Archived outranks finished outranks automated, so the tester sees the real reason.
  runWriteLock() {
    if (!state.runId) return '';
    if (RunLock.runArchived()) return ARCHIVED_LOCK_REASON;
    if (RunLock.runFinished()) return RUN_LOCK_REASON;
    if (RunLock.runAutomated()) return AUTOMATED_LOCK_REASON;
    return '';
  },

  recordWriteLock(record) {
    return RunLock.runWriteLock() || (RunLock.recordAutomated(record) ? AUTOMATED_LOCK_REASON : '');
  },

  // A reporter result can flip one row mid-poll while the run-level reason stays ''.
  lockSignature(reason) {
    const rows = (state.records || []).filter(RunLock.recordAutomated).map((r) => r.id).join(',');
    return `${reason} | ${rows}`;
  },

  applyRunLock({ force = false } = {}) {
    const reason = RunLock.runWriteLock();
    const signature = RunLock.lockSignature(reason);
    if (!force && signature === lockPainted) return;
    lockPainted = signature;
    // Per row, not per run: a mixed run locks only its automated rows.
    document.querySelectorAll('#run-tests li.test-row').forEach((li) => RunLock.applyRowLock(li));
    const note = $('run-lock-note');
    if (note) { note.textContent = reason; note.hidden = !reason; }
    updateRunActions();                                        // Finish run hides on the same signal
    if (typeof TestGates !== 'undefined') TestGates.update();
  },

  // The row stays clickable; only the write buttons go dead, with the reason on their tooltip.
  applyRowLock(li, reason = RunLock.recordWriteLock(recordFor(li.dataset.recordId))) {
    li.querySelectorAll('.row-actions .row-st').forEach((b) => {
      b.disabled = !!reason;
      const idle = b.classList.contains('active') ? RESET_TIP : ROW_BTN_LABEL[b.dataset.status];
      Tooltip.set(b, reason || idle || '');
    });
  },

  async settlePendingWrites() {
    await Promise.resolve(stepWriteChain).catch(() => {});
    for (let i = 0; i < 200 && (state.saving || state.inlineWrites > 0); i++) await sleep(25);
    await Promise.resolve(stepWriteChain).catch(() => {});
    // Answering false is the point: a finished run takes no more writes, so closing over one loses it.
    return !state.saving && state.inlineWrites <= 0;
  },

  // Not runWriteLock(): automated gates results, not the run, and the button would refuse itself.
  finishBlockedReason() {
    if (RunLock.runArchived()) return ARCHIVED_LOCK_REASON;
    if (RunLock.runFinished()) return RUN_LOCK_REASON;
    return '';
  },

  async finishRun() {
    if (!state.runId) return;
    // Checked on both sides of the dialog: the archived flag lands late and the confirm can sit open.
    await awaitRunState();
    let blocked = RunLock.finishBlockedReason();
    if (blocked) { RunLock.applyRunLock({ force: true }); toast(blocked); return; }
    const ok = await ConfirmDialog.ask('Finish run? Pending tests will be marked skipped.');
    if (!ok) return;
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
