#!/usr/bin/env node
// The write gate of extension/sidepanel/screens/run-lock.js (rows 7-13, 49-50, 52, 66-71, 78-80a,
// 118 and 131, moved out of tests/run-view.test.mjs by #194): whether a result may be saved at all,
// which of the three reasons the tester is told, and Finish run — the one act that closes a run.
// Three things here are easy to get quietly wrong, so most of this file is about them. The reasons
// are RANKED — archived outranks finished outranks automated — and the tester must be told the
// ACTUAL one, not the first that happens to be true. finishBlockedReason() is deliberately not
// runWriteLock(): an automated run keeps a working Finish button while every row of it stays
// read-only. And the gate is asked TWICE, once before the confirm dialog and once after it resolves,
// because a colleague can archive the run while that dialog sits open under the tester's eye.
// Rows 132-135 are new: the falsification run behind the move found the 200 × 25 ms bound, the
// ledger of a confirmed finish, and two whole call sites — screens/screen-rec.js and app.js have no
// suite in this repo at all. The rows that paint over REAL checklist rows (72-76, 108a, 110, 111,
// 113) stay in tests/run-view.test.mjs, which builds those rows and now drives this module for real.
// Run: node --test tests/run-lock.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, SCREENS_SRC, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';
import { loadState } from './helpers/core-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The two switchable directories, so rows 135-136 read whatever SCREENS_SRC / CORE_SRC point at;
// index.html belongs to neither and is read where it ships, as tests/dialog.test.mjs:139 reads it.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

// The REAL comparator: #258 was one sort rule written out three times, and a stub here would be a
// fourth free to drift. finishRun re-sorts the checklist it re-reads with it (tests/state.test.mjs).
const { byRecordId } = loadState();

const ARCHIVED = 'Run is archived — results are read-only';
const FINISHED = 'Run is finished — results are read-only';
const AUTOMATED = 'Automated result — read-only in the panel';

// index.html:540-545 and :818-824, cut to the nodes this module touches: the note it paints, the
// button it disables while the PUT is out, the list it walks, and the dialog it asks.
const NODES = [
  ['button', 'btn-finish-run', true], ['p', 'run-lock-note', true], ['ul', 'run-tests', false],
  ['dialog', 'confirm-dialog', false], ['p', 'confirm-message', false],
  ['button', 'confirm-ok', false], ['button', 'confirm-cancel', false],
];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

const rec = (id, over = {}) => ({ id, test_id: id, test_title: `Test ${id}`, status: 'pending', ...over });

// A promise this file resolves by hand: rows 131 park inside the 200 × 25 ms wait and let it out.
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// The panel globals run-lock.js reads. Four of them — updateRunActions, applyRunInfo, renderRunView
// and awaitRunState — belong to screens/run-view.js and stay there, so they are recorders here: what
// this module owes them is THAT it calls them, and tests/run-view.test.mjs owns what they then do.
function load(opts = {}) {
  const o = {
    runId: 'r1',
    runStatus: null,
    runKind: null,
    runInfo: {},
    records: [],
    currentRecordId: null,
    testrunDetail: null,
    saving: false,
    without: [],          // ids to leave out of the page
    noTestActions: false, // a panel where screens/test-gates.js was never loaded
    holdSleep: false,     // sleep() parks instead of resolving — row 131 needs the wait held open
    chainRejects: false,  // the step-write chain answers with a rejection, which must be swallowed
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    if (o.without.includes(id)) continue;
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    node[key(id)] = n;
    doc.body.append(n);
  }
  const calls = {
    order: [],        // one ordered trace, for the rows that assert "before", not merely "both"
    toasts: [],
    progressToasts: [],
    lines: [],        // { id, text, tone }
    apiErrors: [],    // { message, id, opts }
    sleeps: [],       // { ms, resolve } in order — settlePendingWrites' give-up is counted here
    testActions: 0,
    runActions: 0,
    infos: [],        // every payload handed to run-view's applyRunInfo
    renders: 0,
    probes: 0,
    chainReads: 0,    // how often stepWriteChain was awaited — once on each side of the wait
    reads: { testruns: [], finish: [] },
  };

  // <dialog>'s own three members; mini-dom has no dialog element, and ConfirmDialog.ask drives all
  // of them — showModal to open it, `open` to decide whether close() is still needed.
  if (node.confirmDialog) {
    node.confirmDialog.open = false;
    node.confirmDialog.showModal = () => { node.confirmDialog.open = true; calls.order.push('showModal'); };
    node.confirmDialog.close = () => { node.confirmDialog.open = false; calls.order.push('closeModal'); };
  }

  // Held promises, so row 131 can decide when the wait is allowed to end.
  const held = [];
  const sleep = (ms) => {
    if (!o.holdSleep) { calls.sleeps.push({ ms }); return Promise.resolve(); }
    const d = deferred();
    calls.sleeps.push({ ms, resolve: d.resolve });
    held.push(d);
    return d.promise;
  };

  // Reassignable after load(), so a row can answer the second read differently from the first.
  const on = {
    finishRun: async () => ({ id: o.runId, status: 'finished' }),
    listTestruns: async () => o.serverRecords ?? [],
    runInfoOf: (payload) => ({ status: payload?.status ?? null }),
  };

  const state = {
    runId: o.runId,
    runStatus: o.runStatus,
    runKind: o.runKind,
    runInfo: o.runInfo,
    records: o.records,
    currentRecordId: o.currentRecordId,
    testrunDetail: o.testrunDetail,
    saving: o.saving,
    inlineWrites: 0,
  };

  const globals = {
    state,
    sleep,
    // A thenable, not a promise: `await Promise.resolve(stepWriteChain)` calls .then, so asking it
    // on BOTH sides of the wait is visible rather than merely believed (row 132).
    stepWriteChain: {
      then: (res, rej) => { calls.chainReads += 1; return o.chainRejects ? rej(new Error('chain')) : res(); },
    },
    byRecordId,
    $: (id) => doc.getElementById(id),
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); calls.order.push('toast'); },
    progressToast: (msg) => { calls.progressToasts.push(msg); calls.order.push('progressToast'); },
    setStatusLine: (id, text, tone) => { calls.lines.push({ id, text, tone }); },
    handleApiError: (e, id, eOpts) => {
      calls.apiErrors.push({ message: e?.message ?? String(e), id, opts: plain(eOpts) });
      calls.order.push('apiError');
    },
    isAuthError: (e) => e?.kind === 'auth',
    // core/state.js:79's own, stringified on both sides; applyRowLock's default reason goes through it.
    recordFor: (recordId) => state.records.find((r) => String(r.id) === String(recordId)),
    // screens/run-view.js's own map, verbatim: the label applyRowLock puts back when the lock lifts.
    ROW_BTN_LABEL: { passed: 'Mark passed', failed: 'Mark failed', skipped: 'Mark skipped' },
    // The real one writes data-tip on the node it is given; a recorder alone could not tell a tip
    // that landed on the right element from one that went nowhere. (shared/tooltip.js:257)
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    TestGates: o.noTestActions ? undefined : { update: () => { calls.testActions += 1; } },
    // screens/run-view.js's four, recorded: they stayed with the screen this module came out of.
    updateRunActions: () => { calls.runActions += 1; calls.order.push('updateRunActions'); },
    applyRunInfo: (info) => { calls.infos.push(info); Object.assign(state.runInfo, info); },
    renderRunView: () => { calls.renders += 1; calls.order.push('render'); },
    awaitRunState: async () => { calls.probes += 1; calls.order.push('awaitRunState'); },
    TestomatAPI: {
      jwtAvailable: () => true,
      finishRun: async (id) => { calls.reads.finish.push(id); calls.order.push('finishPut'); return on.finishRun(id); },
      listTestruns: async (id) => { calls.reads.testruns.push(id); calls.order.push('listTestruns'); return on.listTestruns(id); },
      runInfoOf: (payload) => on.runInfoOf(payload),
    },
  };

  const h = loadScreen('run-lock', {
    globals,
    document: doc,
    // index.html's own order: core/dialog.js stands ahead of every screen, and finishRun asks its
    // confirm through it. The REAL one — a stub would make the two gate rows test the stub (#194).
    before: [['dialog', CORE_SRC]],
    // RunLock is a lexical const: invisible as a sandbox property, reachable only off the completion
    // value, the same seam tests/md-sections.test.mjs uses.
    exported: 'RunLock',
  });

  return {
    ...h,
    lock: h.screen,
    state, calls, on, node, doc,
    // The held sleeps, so a row can let the wait end on purpose.
    releaseSleeps: () => { for (const d of held.splice(0)) d.resolve(); },
  };
}

// The dialog is answered from outside, the way a tester answers it: start the call, let it reach
// showModal, then click. `settle()` is the turn in between — never await the finishRun promise here,
// which cannot resolve until the click that has not happened yet.
async function openConfirm(h) {
  await settle();
  assert.equal(h.node.confirmDialog.open, true, 'the dialog should be open by now');
}

// ---------- the write gate: three reasons, ranked (rows 7-13, 66-71) ----------

test('7: an archived run that also finished and is automated says ARCHIVED — the actual reason', () => {
  const h = load({ runInfo: { isArchived: true }, runStatus: 'finished', runKind: 'automated' });
  assert.equal(h.lock.runWriteLock(), ARCHIVED);
});

test('8: take the archive away and the same run says FINISHED', () => {
  const h = load({ runInfo: {}, runStatus: 'finished', runKind: 'automated' });
  assert.equal(h.lock.runWriteLock(), FINISHED);
});

test('9: an automated run bars every row but leaves Finish run alive', () => {
  const h = load({ runStatus: 'running', runKind: 'automated' });
  assert.equal(h.lock.runWriteLock(), AUTOMATED);
  assert.equal(h.lock.finishBlockedReason(), '');
  // …and the two reasons Finish DOES answer to, driven the same way.
  h.state.runInfo = { isArchived: true };
  assert.equal(h.lock.finishBlockedReason(), ARCHIVED);
  h.state.runInfo = {};
  h.state.runStatus = 'passed';
  assert.equal(h.lock.finishBlockedReason(), FINISHED);
});

test('10: no run open at all is not a lock — the screen is simply empty', () => {
  const h = load({ runId: null, runInfo: { isArchived: true }, runStatus: 'finished' });
  assert.equal(h.lock.runWriteLock(), '');
  // The identical state WITH a run id locks, so the guard is what answered and not the flags.
  h.state.runId = 'r1';
  assert.equal(h.lock.runWriteLock(), ARCHIVED);
});

test('11: a run still reported running is finished once it carries a finishedAt', () => {
  const h = load({ runStatus: 'running', runInfo: { finishedAt: '2026-01-01T00:00:00Z' } });
  assert.equal(h.lock.runFinished(), true);
  assert.equal(h.lock.runWriteLock(), FINISHED);
  h.state.runInfo = { finishedAt: null };
  assert.equal(h.lock.runFinished(), false);
});

test('12: the open row consults the JSON:API detail, and the id is compared as text', () => {
  const h = load({ currentRecordId: 7, testrunDetail: { data: { attributes: { automated: true } } } });
  assert.equal(h.lock.recordAutomated({ id: '7' }), true);
  // A different row on the same screen is not the one the detail describes.
  assert.equal(h.lock.recordAutomated({ id: '8' }), false);
  assert.equal(h.lock.recordAutomated(null), false);
});

test('13: the lock signature carries the automated rows, so a mid-poll flip repaints', () => {
  const h = load({ records: [{ id: 1, automated: true }, { id: 2 }] });
  assert.equal(h.lock.lockSignature(''), ' | 1');
  // The second row flipping is a DIFFERENT signature — which is the whole point of listing them.
  h.state.records[1].automated = true;
  assert.equal(h.lock.lockSignature(''), ' | 1,2');
  assert.equal(h.lock.lockSignature(FINISHED), `${FINISHED} | 1,2`);
});

test('66: a run-level reason is the row\'s reason too, and outranks its own flag', () => {
  const h = load({ runStatus: 'finished' });
  assert.equal(h.lock.recordWriteLock({ id: 1, automated: true }), FINISHED);
  h.state.runStatus = 'running';
  assert.equal(h.lock.recordWriteLock({ id: 1, automated: true }), AUTOMATED);
  assert.equal(h.lock.recordWriteLock({ id: 2 }), '');
});

test('67: only the four terminal words are terminal, whatever their case', () => {
  const h = load();
  for (const s of ['passed', 'FAILED', 'Terminated', 'finished']) {
    assert.equal(h.lock.runStatusTerminal(s), true, s);
  }
  for (const s of ['running', 'launching', 'scheduled', '', null, undefined]) {
    assert.equal(h.lock.runStatusTerminal(s), false, String(s));
  }
});

test('68: the run detail is a second source of "finished" — the status the card shows counts', () => {
  const h = load({ runStatus: 'running', runInfo: { status: 'passed' } });
  assert.equal(h.lock.runFinished(), true);
  assert.equal(h.lock.runWriteLock(), FINISHED);
});

test('69: archived is one signal only — a run info that never said so is not archived', () => {
  const h = load({ runInfo: {} });
  assert.equal(h.lock.runArchived(), false);
  h.state.runInfo = { isArchived: false };
  assert.equal(h.lock.runArchived(), false);
  h.state.runInfo = { isArchived: 'true' }; // a string is not the flag: basic mode stays blind
  assert.equal(h.lock.runArchived(), false);
  h.state.runInfo = { isArchived: true };
  assert.equal(h.lock.runArchived(), true);
});

test('70: only the word `automated` locks the run — a rungroup kind draws nothing here', () => {
  const h = load({ runKind: 'AUTOMATED' });
  assert.equal(h.lock.runAutomated(), true);
  for (const k of ['manual', 'mixed', 'multienv', null]) {
    h.state.runKind = k;
    assert.equal(h.lock.runAutomated(), false, String(k));
  }
});

test('71: a row flagged automated by the server locks without the run being automated at all', () => {
  const h = load({ runStatus: 'running', runKind: 'mixed' });
  assert.equal(h.lock.runWriteLock(), '');
  assert.equal(h.lock.recordAutomated({ id: 9, automated: true }), true);
  assert.equal(h.lock.recordWriteLock({ id: 9, automated: true }), AUTOMATED);
});

// ---------- finishing a run: the two gates (rows 49-50, 78-80a) ----------

test('49: the archive landing while the confirm sits open is caught by the second gate', async () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  const done = h.lock.finishRun();
  await openConfirm(h);
  h.state.runInfo = { isArchived: true }; // a colleague archives it while the tester reads
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.reads.finish, [], 'no PUT');
  assert.deepEqual(h.calls.toasts, [{ msg: ARCHIVED }]);
  assert.equal(h.node.runLockNote.textContent, ARCHIVED, 'and the lock is force-painted');
  assert.equal(h.state.runStatus, 'running');
});

test('50: dismissing the dialog is a no-op — no PUT, no state change', async () => {
  const h = load({ runStatus: 'running' });
  const done = h.lock.finishRun();
  await openConfirm(h);
  fire(h.node.confirmCancel, 'click');
  await done;
  assert.deepEqual(h.calls.reads.finish, []);
  assert.equal(h.state.runStatus, 'running');
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.progressToasts, []);
  assert.equal(h.node.confirmDialog.open, false);
});

test('78: the FIRST gate bites before the dialog is ever shown', async () => {
  const h = load({ runStatus: 'finished' });
  await h.lock.finishRun();
  assert.equal(h.node.confirmDialog.open, false);
  assert.ok(!h.calls.order.includes('showModal'));
  assert.deepEqual(h.calls.toasts, [{ msg: FINISHED }]);
  assert.deepEqual(h.calls.reads.finish, []);
  assert.equal(h.node.runLockNote.textContent, FINISHED);
});

test('79: with no run open Finish does nothing at all — not even the state probe', async () => {
  const h = load({ runId: null, runStatus: 'running' });
  await h.lock.finishRun();
  assert.deepEqual(h.calls.order, []);
  // The same call WITH a run id gets as far as the dialog, so the guard is what stopped it.
  const open = load({ runStatus: 'running' });
  const done = open.lock.finishRun();
  await settle();
  assert.equal(open.node.confirmDialog.open, true);
  fire(open.node.confirmCancel, 'click');
  await done;
});

test('80: a failed PUT is reported inline, the button comes back, and the run is untouched', async () => {
  const h = load({ runStatus: 'running' });
  h.on.finishRun = async () => { throw Object.assign(new Error('boom'), { kind: 'http' }); };
  const done = h.lock.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.apiErrors, [{ message: 'boom', id: 'run-status', opts: { inlineAuth: true } }]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Finish failed: boom', error: true }]);
  assert.equal(h.state.runStatus, 'running');
  assert.equal(h.node.btnFinishRun.disabled, false, 'released in the finally');
});

test('80a: an expired session is handled inline WITHOUT a second toast on top of it', async () => {
  const h = load({ runStatus: 'running' });
  h.on.finishRun = async () => { throw Object.assign(new Error('nope'), { kind: 'auth' }); };
  const done = h.lock.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.equal(h.calls.apiErrors.length, 1);
  assert.deepEqual(h.calls.toasts, []);
});

// ---------- waiting for the writes already in flight (rows 52, 118, 131) ----------

// 52 (#276): the wait still gives up after 200 × 25 ms, but it now SAYS so — a finished run takes no
// more writes, so closing the run over a save still in flight lost the result the tester had marked.
test('52 (#276): a save still in flight stops the finish instead of being closed over', async () => {
  const stuck = load({ saving: true });
  assert.equal(await stuck.lock.settlePendingWrites(), false,
    `gave up after ${stuck.calls.sleeps.length} × 25 ms and said so`);

  // Nothing pending: it answers true, so the false above is a report and not a constant.
  const clear = load();
  assert.equal(await clear.lock.settlePendingWrites(), true);
  assert.equal(clear.calls.sleeps.length, 0);
});

test('118: with nothing pending, Finish waits for nobody', async () => {
  const h = load({ saving: false });
  await h.lock.settlePendingWrites();
  assert.deepEqual(h.calls.sleeps, []);
});

test('131: Finish waits while an inline write is still in flight, and goes on the moment it lands', async () => {
  const h = load({ holdSleep: true });
  h.state.inlineWrites = 1;
  const settling = h.lock.settlePendingWrites();
  await settle();
  assert.deepEqual(h.calls.sleeps.map((s) => s.ms), [25], 'it is waiting, not returning');
  h.state.inlineWrites = 0;
  h.releaseSleeps();
  await settling;
  assert.equal(h.calls.sleeps.length, 1, 'and it stops the moment the write lands');
});

// ---------- what nothing else pinned (rows 132-135) ----------

// 132: row 52 PRINTS the count it gave up after and asserts only the answer, so cutting the bound to
// three waits left every row above green. Pinned, not fixed — the give-up is #161's own issue.
test('132: the wait is 200 × 25 ms, with the step chain asked on both sides and its rejection swallowed', async () => {
  const h = load({ saving: true, chainRejects: true });
  assert.equal(await h.lock.settlePendingWrites(), false, 'a rejected chain is not an exception');
  assert.equal(h.calls.sleeps.length, 200, 'the bound');
  assert.deepEqual([...new Set(h.calls.sleeps.map((s) => s.ms))], [25], 'and the period');
  assert.equal(h.calls.chainReads, 2, 'asked before the wait and again after it');
});

// 133: the ledger, not merely the outcome — dropping the progress toast and the updateRunActions in
// the finally both left every row above green, and each is something the tester sees.
test('133: a confirmed finish says so, then settles, writes, re-reads, repaints and re-gates the button', async () => {
  const h = load({ runStatus: 'running', records: [rec(1)] });
  h.on.listTestruns = async () => [rec(2), rec(1)];
  const done = h.lock.finishRun();
  await openConfirm(h);
  fire(h.node.confirmOk, 'click');
  await done;
  assert.deepEqual(h.calls.order, ['awaitRunState', 'showModal', 'closeModal', 'progressToast',
    'finishPut', 'listTestruns', 'render', 'updateRunActions']);
  assert.deepEqual(h.calls.progressToasts, ['Finishing run…']);
  assert.deepEqual(h.state.records.map((r) => r.id), [1, 2], 're-read AND re-sorted by id');
  assert.deepEqual(h.calls.lines, [{ id: 'run-status', text: 'Run finished ✓', tone: 'ok' }]);
  assert.equal(h.node.btnFinishRun.disabled, false, 'released in the finally');
});

// The ids and the load order are late-bound: a renamed note or a script tag moved below its callers
// throws only under a tester's finger, and the fixture above would go on passing.
test('134: the page carries the note this module paints, and loads it before every screen that asks', () => {
  const html = raw(repoRoot, 'extension/sidepanel/index.html');
  for (const id of ['run-lock-note', 'btn-finish-run', 'run-tests']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('screens/run-lock.js') > 0, 'the module is loaded at all');
  // core/dialog.js is its one load-order dependency; every other name it reads is late-bound.
  assert.ok(at('core/dialog.js') < at('screens/run-lock.js'), 'after the dialog it asks');
  for (const s of ['screens/run-view.js', 'screens/test-meta.js', 'screens/test-gates.js',
    'screens/test-view.js', 'screens/livesync.js', 'screens/offline-queue.js',
    'screens/attachments.js', 'screens/screen-rec.js', 'screens/hotkeys.js', 'app.js']) {
    assert.ok(at('screens/run-lock.js') < at(s), `screens/run-lock.js stands before ${s}`);
  }
  // core/write-status.js is the one caller it does NOT stand before — a core file reaching forward
  // into a screen, exactly as it did when these names lived in run-view.js. Late-bound, unchanged.
  assert.ok(at('core/write-status.js') < at('screens/run-lock.js'));
});

// 135: screens/screen-rec.js and extension/sidepanel/app.js have NO suite in this repo, so the gate
// on attaching a recording and the wiring of the Finish run button are reachable by no row above.
// Read as text, they are: a bare old name in either would sail through the whole test run.
test('135: every call site asks RunLock by name, the two unsuited files included', () => {
  const callers = {
    [join(SCREENS_SRC, 'run-view.js')]: 9,
    [join(SCREENS_SRC, 'test-view.js')]: 2,
    [join(SCREENS_SRC, 'test-meta.js')]: 1,
    [join(SCREENS_SRC, 'test-gates.js')]: 1,
    [join(SCREENS_SRC, 'attachments.js')]: 3,
    [join(SCREENS_SRC, 'screen-rec.js')]: 1,
    [join(SCREENS_SRC, 'hotkeys.js')]: 2,
    [join(SCREENS_SRC, 'livesync.js')]: 1,
    [join(SCREENS_SRC, 'offline-queue.js')]: 1,
    [join(CORE_SRC, 'write-status.js')]: 1,
    [join(repoRoot, 'extension/sidepanel/app.js')]: 1, // neither directory — read where it ships
  };
  // Every name the module took, as a CALL: a bare one here throws only under a tester's finger.
  const OLD = /(^|[^.\w])(recordWriteLock|runWriteLock|runStatusTerminal|applyRunLock|applyRowLock|lockSignature|recordAutomated|finishBlockedReason|settlePendingWrites|runFinished|runArchived|runAutomated)\s*\(/;
  for (const [file, n] of Object.entries(callers)) {
    const src = readFileSync(file, 'utf8');
    const code = src.replace(/\/\/.*$/gm, ''); // one file names the module in a trailing comment too
    assert.equal(code.match(/\bRunLock\.\w+/g).length, n, `${file} names RunLock ${n} time(s)`);
    // The file's own `/* global … */` block, not merely the name somewhere in the file.
    assert.ok(/\/\* global ([\s\S]*?)\*\//.exec(src)[1].includes('RunLock'), `${file} declares the global`);
    assert.doesNotMatch(code, OLD, `${file} calls no bare old name`);
  }
  // app.js hands the button the method itself, unbound — which is only safe because nothing in the
  // module says `this`. One `this.` in there and every Finish run would throw under the listener.
  assert.match(readFileSync(join(repoRoot, 'extension/sidepanel/app.js'), 'utf8'),
    /addEventListener\('click', RunLock\.finishRun\)/);
  assert.doesNotMatch(readFileSync(join(SCREENS_SRC, 'run-lock.js'), 'utf8').replace(/\/\/.*$/gm, ''), /\bthis\b/);
});
