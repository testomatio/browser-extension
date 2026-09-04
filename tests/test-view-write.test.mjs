#!/usr/bin/env node
// The WRITE half of extension/sidepanel/screens/test-view.js (#164): everything that turns "the
// tester marked this test" into a request. `writeStatus` is the panel's most-shared function — the
// run list's inline rows and the offline queue's replay both call it — so its enqueue, its draft
// drop and its stale-entry removal are pinned HERE rather than through the screens that borrow it.
// Four things are easy to get quietly wrong and most of this file is about them. A landed write has
// to spend the draft it came from AND drop the queue entry it supersedes, or the next replay writes
// an older status back over it. A queued write has two sentences, not one: a rejected token is not
// "offline", and telling the tester to wait for a connection that is already there costs them the
// session. Every gate here carries prose the tester reads, and the same sentence is worded four
// ways across this file — pinned exactly as it stands so a shared-helper refactor cannot drift it.
// And the module keeps mutable state (the draft cache, the step chain, the two write flags), so
// every test re-evaluates the source through its own load() rather than resetting anything by hand.
// Rows are the ticket's 1-17, 57-109 and 147-158. A lettered suffix is the companion case that
// drives the same path the other way, so a row asserting "nothing happened" cannot pass against a
// fixture where nothing could have happened anyway.
// Run: node --test tests/test-view-write.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeClock, makeDocument, el, plain, settle, rejection, ApiError } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');

const HOST = 'app.testomat.io';
const LOCK = 'Run is finished — results are read-only';

// The three attach gates, verbatim. The recorder's two use commas where the others use em dashes;
// that drift is the reason these are strings in the test and not a template.
const NO_RESULT = {
  shot: 'No saved result yet — screenshots attach to a test result',
  file: 'No saved result yet — files attach to a test result',
  rec: 'No saved result yet, a recording attaches to a test result',
};
const DEGRADED = {
  shot: `Attaching screenshots needs an active ${HOST} web login — sign in there, then Refresh`,
  file: `Attaching files needs an active ${HOST} web login — sign in there, then Refresh`,
  rec: `Attaching a recording needs an active ${HOST} web login, sign in there, then Refresh`,
};

// A promise this file resolves by hand: several rows are about what a SECOND call does while the
// first one's request is still on the wire.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const rec = (id, over = {}) => ({ id, test_id: id * 100, test_title: `Test ${id}`, status: 'pending', ...over });

// index.html's shape (:576-744), cut to the nodes the write path touches. `true` = hidden in markup.
const NODES = [
  ['p', 'test-status'], ['textarea', 'test-comment'],
  ['button', 'btn-passed'], ['button', 'btn-failed'], ['button', 'btn-skipped'],
  ['p', 'status-lock-reason', true],
  ['button', 'btn-screenshot-annotate'], ['p', 'screenshot-reason', true],
  ['button', 'btn-attach-file'], ['p', 'attach-file-reason', true],
  ['button', 'btn-screen-rec'], ['p', 'screen-rec-reason', true],
  ['ul', 'attachment-list', true], ['div', 'test-steps'],
  ['button', 'attachments-head'], ['div', 'attachments-body'],
  ['span', 'test-position'], ['button', 'btn-prev-test'], ['button', 'btn-next-test'],
  ['button', 'tab-test-desc'], ['button', 'tab-test-status'], ['button', 'tab-test-summary'],
  ['div', 'pane-test-desc'], ['div', 'pane-test-status', true], ['div', 'pane-test-summary', true],
];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function load(opts = {}) {
  const o = {
    recordId: 7,
    records: null,        // default: one untested record, id 7
    runId: 'r1',
    runTitle: 'Checkout run',
    saving: false,
    jwt: true,            // capabilities.jwt
    jwtAvailable: true,   // TestomatAPI.jwtAvailable(): true | false | 'unknown'
    hasChrome: true,
    lock: '',             // recordWriteLock()'s answer
    hidden: [],           // ids rowVisible() answers false for
    dropdown: true,       // a panel where TestMeta.initSubstatus already ran
    stepButtons: 0,       // `.step-state` circles inside #test-steps
    probe: null,          // run-view's runStateProbe
    comment: '',
    settings: { baseUrl: `https://${HOST}`, projectId: 'proj' },
    now: 1700000000000,
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    node[key(id)] = n;
    doc.body.append(n);
  }
  node.testComment.value = o.comment;
  for (let i = 0; i < o.stepButtons; i += 1) {
    node.testSteps.append(el('button', { className: 'btn icon size-xs step-state' }));
  }
  // chrome.storage.session's writer half: the harness's fake reads only, and every draft row is
  // asserted on what the mirror actually wrote.
  const store = fakeChrome();

  const calls = {
    order: [],
    dropped: [],      // CommentDrafts.drop(recordId) — screens/test-drafts.js owns the rest
    toasts: [],
    lines: [],          // { id, text, tone }
    apiErrors: [],
    authLines: [],
    progressToasts: [],
    hideToasts: 0,
    beginWrites: 0,
    endWrites: 0,
    progress: 0,
    contextBars: 0,
    opened: [],         // openTestView(id) — the sandbox property, re-pointed below
    runViews: [],
    attachmentLists: 0,
    summary: [],        // TestSummary.render / .hide / .refresh
    metaPaints: [],     // TestMeta's four repaints, in order
    markers: 0,
    refreshUIs: 0,
    setStatus: [],
    setStep: [],
    meta: [],           // { id, entries }
    enqueued: [],
    removed: [],
    envMeta: [],        // every collectEnvMeta(settings)
    logUploads: [],
    probes: 0,          // awaitRunState()
  };

  // Reassignable after load(), so a row can answer the second call differently from the first or
  // change the world from inside a call the screen is awaiting.
  const on = {
    setStatus: async (payload) => ({ id: payload.testrunId, status: payload.status }),
    setStep: async () => ({}),
    setTestrunMeta: async () => ({}),
    forcedError: () => null,
    // offline-queue.js:30's own rule, verbatim: only a network error or a rejected token queues.
    qualifies: (e) => !!e && (e.kind === 'network' || e.kind === 'auth'),
    enqueue: async () => {},
    remove: async () => false,
    collectEnvMeta: async () => [],
    uploadEvidenceLog: async () => '',
    awaitRunState: async () => {},
  };

  const state = {
    currentRecordId: o.recordId,
    records: o.records || [rec(7)],
    runId: o.runId,
    runTitle: o.runTitle,
    testrunDetail: null,
    settings: o.settings,
    saving: o.saving,
    stepTicks: {},
    currentSteps: [],
  };

  // The substatus control the screen reaches for by id — the Dropdown's public face, not its DOM.
  // Only the lock still reaches it from here; the writes moved to tests/test-meta.test.mjs.
  const control = { trigger: el('button', { id: 'substatus-select' }), disabled: false };

  const rowVisible = (r) => !o.hidden.includes(String(r?.id));

  const globals = {
    state,
    capabilities: { jwt: o.jwt, readonly: false },
    hasChrome: o.hasChrome,
    $: (id) => doc.getElementById(id),
    show: (view) => { calls.order.push(`show:${view}`); },
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); calls.order.push('toast'); },
    progressToast: (msg) => { calls.progressToasts.push(msg); calls.order.push('progressToast'); },
    hideToast: () => { calls.hideToasts += 1; calls.order.push('hideToast'); },
    setStatusLine: (id, text, tone) => { calls.lines.push({ id, text, tone }); calls.order.push('line'); },
    handleApiError: (e, id, eOpts) => {
      calls.apiErrors.push({ message: e?.message ?? String(e), id, opts: plain(eOpts) });
      calls.order.push('apiError');
    },
    isAuthError: (e) => e?.kind === 'auth',
    setAuthExpiredLine: (id) => { calls.authLines.push(id); calls.order.push('authLine'); },
    baseUrlHost: () => HOST,
    // core/state.js:79's own, stringified on both sides.
    recordFor: (id) => state.records.find((r) => String(r.id) === String(id)),
    // run-view.js:351 — one reason for every row here; the rows that need the per-record scoping
    // drive it through whether the record is in the OPEN run at all.
    recordWriteLock: () => o.lock,
    displayStatus: (r) => (r?.status && r.status !== 'pending' ? r.status : 'untested'),
    normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),
    orderedRecords: () => state.records,
    rowVisible,
    visibleRecords: () => state.records.filter(rowVisible),
    openRunView: (id, title) => { calls.runViews.push([id, title]); calls.order.push('runView'); },
    renderTestProgress: () => { calls.progress += 1; calls.order.push('progress'); },
    refreshContextBar: () => { calls.contextBars += 1; },
    syncBeginWrite: () => { calls.beginWrites += 1; calls.order.push('beginWrite'); },
    syncEndWrite: () => { calls.endWrites += 1; calls.order.push('endWrite'); },
    svgIcon: (name, size) => el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } }),
    statusIcon: (s) => el('span', { className: 'md-icon', dataset: { icon: s } }),
    renderAttachmentList: () => { calls.attachmentLists += 1; },
    collectEnvMeta: async (settings) => { calls.envMeta.push(plain(settings)); return on.collectEnvMeta(settings); },
    uploadEvidenceLog: async (record) => { calls.logUploads.push(record?.id ?? null); return on.uploadEvidenceLog(record); },
    // run-view.js's pair: the run's archived answer, which may still be in flight when a click lands.
    runStateProbe: o.probe,
    awaitRunState: async () => { calls.probes += 1; calls.order.push('probe'); return on.awaitRunState(); },
    // The real one writes data-tip on the node it is given (shared/tooltip.js:257,267); a recorder
    // alone could not tell a tip that landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
      get: (n) => (n && n.dataset ? (n.dataset.tip || '') : ''),
    },
    Dropdown: {
      of: (id) => (id === 'substatus-select' && o.dropdown ? control : null),
      create: () => ({ el: el('div') }),
    },
    ImgHydrate: { release: () => {} },
    TestomatAPI: {
      jwtAvailable: () => o.jwtAvailable,
      setStatus: async (payload) => { calls.setStatus.push(plain(payload)); calls.order.push('setStatus'); return on.setStatus(payload); },
      setStep: async (id, body) => { calls.setStep.push({ id, body: plain(body) }); calls.order.push('setStep'); return on.setStep(id, body); },
      setTestrunMeta: async (id, entries) => { calls.meta.push({ id, entries: plain(entries) }); return on.setTestrunMeta(id, entries); },
    },
    // The draft store moved to screens/test-drafts.js, which has its own suite; here the write
    // only owes it a call, so the stub records that and nothing else.
    CommentDrafts: { drop: (id) => { calls.dropped.push(id); calls.order.push('dropDraft'); } },
    // Same for the result summary card (screens/test-summary.js, tests/test-summary.test.mjs): the
    // write path only asks it to repaint, so row 90c reads the ask back off this list.
    TestSummary: {
      render: () => { calls.summary.push('render'); },
      hide: () => { calls.summary.push('hide'); },
      refresh: () => { calls.summary.push('refresh'); calls.order.push('refreshSummary'); },
    },
    // And for the custom status and the assignee (screens/test-meta.js, tests/test-meta.test.mjs):
    // a landed verdict only asks them to repaint and to re-gate, so the stub records the ask.
    TestMeta: {
      renderSubstatus: () => { calls.metaPaints.push('substatus'); },
      renderSubstatusMark: () => { calls.metaPaints.push('mark'); },
      renderAssignee: () => { calls.metaPaints.push('assignee'); },
      applyAssigneeGate: (r) => { calls.metaPaints.push(`gate:${r?.status ?? ''}`); },
    },
    OfflineQueue: {
      forcedError: () => on.forcedError(),
      qualifies: (e) => on.qualifies(e),
      enqueue: async (entry) => { calls.enqueued.push(plain(entry)); calls.order.push('enqueue'); return on.enqueue(entry); },
      remove: async (id) => { calls.removed.push(id); calls.order.push('queueRemove'); return on.remove(id); },
      refreshUI: () => { calls.refreshUIs += 1; calls.order.push('refreshUI'); },
      updateTestMarker: () => { calls.markers += 1; },
    },
  };

  // The REAL core/write-status.js, evaluated over these same stub objects. clickStatus's rows are
  // about what the tester sees for a given SERVER answer, and a fake core between them would let a
  // queued row pass against something that never queued. tests/write-status.test.mjs owns the core.
  globals.WriteCore = runInContext(
    `${readFileSync(join(CORE_SRC, 'write-status.js'), 'utf8')}\nWriteCore;`,
    createContext({ ...globals, console, URL, Date, TestomatAPI: { ...globals.TestomatAPI, ApiError } }),
    { filename: join(CORE_SRC, 'write-status.js') },
  );

  const clock = fakeClock();
  const h = loadScreen('test-view', {
    globals,
    document: doc,
    store,
    clock,
    now: o.now,
    // Every name below is a lexical `const`/`let` — invisible as a sandbox property, reachable only
    // off the completion value. The mutable ones are getters or a test snapshots the load-time value.
    exported: '({ stepWriteChain: () => stepWriteChain })',
  });

  // nextTest calls openTestView, a declaration in this same file — so the seam is the sandbox
  // property the declaration created, not a global the harness could have passed in.
  h.fn.openTestView = (id) => { calls.opened.push(id); calls.order.push('openTest'); };

  return {
    ...h,
    lex: h.screen,
    state, calls, on, node, doc, clock, store, control,
    // A tri-state step as renderTriState builds it: the row, its control and the bookkeeping.
    step: (over = {}) => {
      const li = el('li');
      const ctrl = el('button', { className: 'btn icon size-xs step-state' });
      li.append(ctrl);
      node.testSteps.append(li);
      return { li, ctrl, title: 'Open the site', pos: 0, index: 0, kind: 'step', state: 'unset', ...over };
    },
    lastLine: () => calls.lines[calls.lines.length - 1] ?? null,
    writeState: () => node.testStatus.dataset.write,
  };
}

// ---------- step writes: the ring control (rows 57-62) ----------

test('57: the first click on an unset step writes passed at its web position', async () => {
  const h = load();
  const s = h.step({ pos: 3, title: 'Click Login' });
  h.fn.cycleStep(s, h.state.records[0]);
  await h.lex.stepWriteChain();
  assert.deepEqual(h.calls.setStep, [{ id: 7, body: { title: 'Click Login', status: 'passed', pos: 3 } }]);
  assert.equal(s.state, 'passed');
  assert.equal(s.ctrl.dataset.state, 'passed');
  assert.equal(s.saving, false);
});

test('58: the cycle wraps — skipped goes back to passed', async () => {
  const h = load();
  const s = h.step({ state: 'skipped' });
  h.fn.cycleStep(s, h.state.records[0]);
  await h.lex.stepWriteChain();
  assert.equal(h.calls.setStep[0].body.status, 'passed');
  // …and the two steps in between, so "wraps" is not just "always passed".
  const mid = load();
  const a = mid.step({ state: 'passed' });
  mid.fn.cycleStep(a, mid.state.records[0]);
  await mid.lex.stepWriteChain();
  assert.equal(mid.calls.setStep[0].body.status, 'failed');
});

test('59: a step whose own write is still in flight refuses a second click', async () => {
  const h = load();
  const s = h.step({ saving: true });
  h.fn.cycleStep(s, h.state.records[0]);
  await h.lex.stepWriteChain();
  assert.deepEqual(h.calls.setStep, []);
  assert.equal(s.state, 'unset');
});

test('60: a locked result writes no step and does not move the ring', async () => {
  const h = load({ lock: LOCK });
  const s = h.step();
  h.fn.cycleStep(s, h.state.records[0]);
  await h.lex.stepWriteChain();
  assert.deepEqual(h.calls.setStep, []);
  assert.equal(s.state, 'unset');
  assert.equal(s.ctrl.dataset.state, undefined); // never repainted either
});

test('61: a rejected step write rolls the ring back and says so', async () => {
  const h = load();
  h.on.setStep = async () => { throw new Error('boom'); };
  const s = h.step({ state: 'passed' });
  h.fn.cycleStep(s, h.state.records[0]);
  assert.equal(s.state, 'failed'); // optimistic, before the chain settles
  await h.lex.stepWriteChain();
  assert.equal(s.state, 'passed');
  assert.equal(s.ctrl.dataset.state, 'passed');
  assert.deepEqual(h.calls.toasts, [{ msg: 'Step not saved: boom', error: true }]);
  assert.equal(s.saving, false); // …and the row is clickable again
});

test('62: two steps write in sequence — the server\'s read-modify-write is never raced', async () => {
  const h = load();
  const first = deferred();
  h.on.setStep = async () => first.promise;
  const a = h.step({ pos: 0, title: 'one' });
  const b = h.step({ pos: 1, title: 'two', index: 1 });
  h.fn.cycleStep(a, h.state.records[0]);
  h.fn.cycleStep(b, h.state.records[0]);
  await settle();
  assert.deepEqual(h.calls.setStep.map((c) => c.body.title), ['one']);
  h.on.setStep = async () => ({});
  first.resolve({});
  await h.lex.stepWriteChain();
  assert.deepEqual(h.calls.setStep.map((c) => c.body.title), ['one', 'two']);
});

test('62b: …and a REJECTED first write still lets the second one through', async () => {
  const h = load();
  const first = deferred();
  h.on.setStep = async () => first.promise;
  const a = h.step({ pos: 0, title: 'one' });
  const b = h.step({ pos: 1, title: 'two', index: 1 });
  h.fn.cycleStep(a, h.state.records[0]);
  h.fn.cycleStep(b, h.state.records[0]);
  await settle();
  h.on.setStep = async () => ({});
  first.reject(new Error('offline'));
  await h.lex.stepWriteChain();
  assert.deepEqual(h.calls.setStep.map((c) => c.body.title), ['one', 'two']);
});

// ---------- status click and write state (rows 88-95) ----------

test('88: a click while a write is already running returns before anything is painted', async () => {
  const h = load({ saving: true });
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.calls.progressToasts, []);
  assert.deepEqual(h.calls.setStatus, []);
  assert.equal(h.writeState(), undefined);
});

test('88b: a click landing while the archived answer is in flight waits, and blocks a second one', async () => {
  const h = load({ probe: {} });
  const held = deferred();
  h.on.awaitRunState = async () => held.promise;
  const first = h.fn.clickStatus('passed');
  await settle();
  const second = h.fn.clickStatus('failed'); // state.saving is claimed by the probe — refused
  await settle();
  assert.equal(h.calls.probes, 1); // the second click never even reached the probe
  assert.deepEqual(h.calls.progressToasts, []);
  held.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.setStatus.map((c) => c.status), ['passed']);
});

test('88c: with no probe in flight the click never waits on the run state', async () => {
  const h = load({ probe: null });
  await h.fn.clickStatus('passed');
  assert.equal(h.calls.probes, 0);
  assert.deepEqual(h.calls.setStatus.map((c) => c.status), ['passed']);
});

test('89: a locked result says the reason on the line and writes nothing — the hotkey path too', async () => {
  const h = load({ lock: LOCK });
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: LOCK, tone: 'error' }]);
  assert.deepEqual(h.calls.setStatus, []);
  assert.deepEqual(h.calls.progressToasts, []);
  assert.equal(h.node.statusLockReason.textContent, LOCK); // updateTestActionsState ran with it
});

test('90: a click queued while offline says so, and the line is an OK one', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('network', 0, 'offline'); };
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.lastLine(),
    { id: 'test-status', text: 'passed — queued offline, will sync when back online', tone: 'ok' });
  assert.equal(h.writeState(), 'queued');
});

test('90b: a click queued on a REJECTED TOKEN sends the tester to Settings, not to wait', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('auth', 403, 'token rejected'); };
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.lastLine(), {
    id: 'test-status',
    text: 'passed — saved here, but the token was rejected; authorize again in Settings',
    tone: 'ok',
  });
  assert.equal(h.writeState(), 'queued');
});

test('90c: a queued click does not touch the result summary card', async () => {
  const h = load();
  h.state.testrunDetail = { data: { attributes: { status: 'pending', message: '' } } };
  h.on.setStatus = async () => { throw new h.ApiError('network', 0, 'offline'); };
  await h.fn.clickStatus('passed');
  // The card patches the prefetched detail itself, so "not touched" is the ask never being made.
  assert.deepEqual(h.calls.summary, []);
  assert.equal(h.state.testrunDetail.data.attributes.status, 'pending');
});

test('91: a landed click says NOTHING on the line and moves the screen to Status', async () => {
  const h = load({ comment: '  note  ' });
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.lastLine(), { id: 'test-status', text: '', tone: '' });
  assert.equal(h.writeState(), 'saved');
  assert.equal(h.node.paneTestStatus.hidden, false);
  assert.equal(h.node.paneTestDesc.hidden, true);
  assert.equal(h.node.tabTestStatus.getAttribute('aria-selected'), 'true');
  assert.equal(h.calls.setStatus[0].message, 'note'); // the box is trimmed on the way out
  assert.equal(h.calls.hideToasts, 0);
  assert.equal(h.calls.markers, 1);
  // The card belongs to screens/test-summary.js now, so the landed verdict owes it a repaint —
  // without this row, 90c's "queued does NOT refresh" would pass against a screen refreshing never.
  assert.deepEqual(h.calls.summary, ['refresh']);
  // Same for the metadata pair (screens/test-meta.js): the status just changed, so the reply group
  // is re-offered and the #153 assignee gate re-applied — across a file boundary now.
  assert.deepEqual(h.calls.metaPaints, ['substatus', 'mark', 'gate:passed']);
});

test('92: FAILED reopens the attachments fold and still does not navigate', async () => {
  const h = load();
  h.fn.toggleAttachmentsDisclosure(); // the tester had folded it away
  assert.equal(h.node.attachmentsBody.hidden, true);
  await h.fn.clickStatus('failed');
  assert.equal(h.node.attachmentsBody.hidden, false);
  assert.equal(h.node.attachmentsHead.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.runViews, []);
});

test('92b: …every other verdict leaves the fold exactly as the tester left it', async () => {
  const h = load();
  h.fn.toggleAttachmentsDisclosure();
  await h.fn.clickStatus('passed');
  assert.equal(h.node.attachmentsBody.hidden, true);
});

test('93: a tester who paged away mid-write gets no line on the test they are now reading', async () => {
  const h = load();
  h.on.setStatus = async () => { h.state.currentRecordId = 8; return { id: 7, status: 'passed' }; };
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.calls.lines, []);
  assert.equal(h.writeState(), 'saving'); // left where the write put it — this line is not theirs
  assert.equal(h.calls.hideToasts, 1);
});

test('93b: …and a FAILURE after paging away is a toast only, never an inline line', async () => {
  const h = load();
  h.on.setStatus = async () => { h.state.currentRecordId = 8; throw new h.ApiError('http', 500, 'nope'); };
  await h.fn.clickStatus('passed');
  assert.deepEqual(h.calls.lines, []);
  assert.deepEqual(h.calls.apiErrors, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Status not saved: nope', error: true }]);
});

test('94: a failed click restores the row from the pre-write clone', async () => {
  const h = load({ records: [rec(7, { status: 'failed', message: 'the old note' })], comment: 'a new note' });
  h.on.setStatus = async () => { throw new h.ApiError('http', 500, 'nope'); };
  await h.fn.clickStatus('passed');
  assert.equal(h.state.records[0].status, 'failed');
  assert.equal(h.state.records[0].message, 'the old note');
  assert.equal(h.writeState(), 'error');
  assert.deepEqual(h.lastLine(), { id: 'test-status', text: '', tone: '' });
  assert.deepEqual(h.calls.apiErrors, [{ message: 'nope', id: 'test-status', opts: { inlineAuth: true } }]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Status not saved: nope', error: true }]);
  assert.equal(h.state.saving, false);
});

test('94b: an expired session stays put on the line and adds no toast on top of it', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('auth', 401, 'session expired'); };
  h.on.qualifies = () => false; // an auth error the queue refused, so it reaches the error branch
  await h.fn.clickStatus('passed');
  assert.equal(h.writeState(), 'error');
  assert.deepEqual(h.calls.apiErrors.map((a) => a.id), ['test-status']);
  assert.deepEqual(h.calls.toasts, []);
});

test('95: clearing the write state DELETES the attribute rather than emptying it', () => {
  const h = load();
  h.fn.setWriteState('saving');
  assert.equal(h.node.testStatus.dataset.write, 'saving');
  h.fn.setWriteState('');
  assert.equal('write' in h.node.testStatus.dataset, false);
  assert.equal(h.node.testStatus.getAttribute('data-write'), null);
});

// ---------- gates and copy (rows 96-103) ----------

test('96: a lock disables every verdict control and says the reason once, above them', () => {
  const h = load({ lock: LOCK, stepButtons: 2 });
  h.fn.updateTestActionsState();
  for (const id of ['btnPassed', 'btnFailed', 'btnSkipped']) {
    assert.equal(h.node[id].disabled, true, id);
    assert.equal(h.node[id].dataset.tip, LOCK, id);
  }
  assert.equal(h.node.statusLockReason.textContent, LOCK);
  assert.equal(h.node.statusLockReason.hidden, false);
  assert.equal(h.node.testComment.disabled, true);
  assert.equal(h.node.testComment.dataset.tip, LOCK);
  assert.deepEqual(h.doc.querySelectorAll('#test-steps .step-state').map((b) => b.disabled), [true, true]);
  assert.equal(h.control.disabled, true);
});

test('96b: …and with no lock every one of them is live again', () => {
  const h = load({ stepButtons: 2 });
  h.fn.updateTestActionsState();
  for (const id of ['btnPassed', 'btnFailed', 'btnSkipped']) assert.equal(h.node[id].disabled, false, id);
  assert.equal(h.node.statusLockReason.hidden, true);
  assert.equal(h.node.statusLockReason.textContent, '');
  assert.equal(h.node.testComment.disabled, false);
  assert.deepEqual(h.doc.querySelectorAll('#test-steps .step-state').map((b) => b.disabled), [false, false]);
  assert.equal(h.control.disabled, false);
});

test('97: the lock reaches the attach buttons on the TOOLTIP only — one copy, not four', () => {
  const h = load({ lock: LOCK });
  h.fn.updateTestActionsState();
  for (const [btn, reason] of [['btnScreenshotAnnotate', 'screenshotReason'],
    ['btnAttachFile', 'attachFileReason'], ['btnScreenRec', 'screenRecReason']]) {
    assert.equal(h.node[btn].disabled, true, btn);
    assert.equal(h.node[btn].dataset.tip, LOCK, btn);
    assert.equal(h.node[reason].hidden, true, reason);
    assert.equal(h.node[reason].textContent, '', reason);
  }
});

test('98: no saved result yet — the three sentences, verbatim, inline and on the tooltip', () => {
  const h = load({ records: [rec(7, { id: null })] });
  h.fn.updateTestActionsState();
  assert.equal(h.node.screenshotReason.textContent, NO_RESULT.shot);
  assert.equal(h.node.attachFileReason.textContent, NO_RESULT.file);
  assert.equal(h.node.screenRecReason.textContent, NO_RESULT.rec);
  assert.equal(h.node.btnScreenshotAnnotate.dataset.tip, NO_RESULT.shot);
  assert.equal(h.node.screenRecReason.hidden, false);
  // The verdict buttons are NOT gated by a missing id — a pending row is marked into existence.
  assert.equal(h.node.btnPassed.disabled, false);
});

test('99: a proven degraded session names the host to sign in to', () => {
  const h = load({ jwtAvailable: false });
  h.fn.updateTestActionsState();
  assert.equal(h.node.screenshotReason.textContent, DEGRADED.shot);
  assert.equal(h.node.attachFileReason.textContent, DEGRADED.file);
  assert.equal(h.node.screenRecReason.textContent, DEGRADED.rec);
  assert.equal(h.node.btnAttachFile.disabled, true);
});

test('99b: the lock OUTRANKS a missing result and a degraded session both', () => {
  const h = load({ lock: LOCK, jwtAvailable: false, records: [rec(7, { id: null })] });
  h.fn.updateTestActionsState();
  assert.equal(h.node.btnScreenshotAnnotate.dataset.tip, LOCK);
  assert.equal(h.node.screenshotReason.textContent, '');
});

test('100: a session still probing must never gate — "unknown" is not a refusal', () => {
  const h = load({ jwtAvailable: 'unknown' });
  h.fn.updateTestActionsState();
  for (const id of ['btnScreenshotAnnotate', 'btnAttachFile', 'btnScreenRec']) {
    assert.equal(h.node[id].disabled, false, id);
  }
  assert.equal(h.node.screenshotReason.hidden, true);
});

test('101: lifting a gate restores the button\'s own tooltip, not an empty one', () => {
  const h = load({ jwtAvailable: false });
  h.node.btnAttachFile.dataset.tip = 'Attach a file to this result';
  h.fn.updateTestActionsState();
  assert.equal(h.node.btnAttachFile.dataset.tip, DEGRADED.file);
  h.sandbox.TestomatAPI.jwtAvailable = () => true; // the tester signed in and hit Refresh
  h.fn.updateTestActionsState();
  assert.equal(h.node.btnAttachFile.dataset.tip, 'Attach a file to this result');
  assert.equal(h.node.btnAttachFile.disabled, false);
});

test('102: an unmarked row fills none of the three verdict buttons', () => {
  const h = load();
  h.fn.paintStatusButtons('pending');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].className),
    ['outline', 'outline', 'outline']);
  // …and a real verdict fills exactly its own.
  h.fn.paintStatusButtons('failed');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].className),
    ['outline', 'solid', 'outline']);
});

test('103: a status the panel does not know fills nothing either', () => {
  const h = load();
  h.fn.paintStatusButtons('quarantined');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].classList.contains('solid')),
    [false, false, false]);
  h.fn.paintStatusButtons(null);
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].classList.contains('solid')),
    [false, false, false]);
});

// ---------- the pager (rows 104-109) ----------

test('104: the position counts within the VISIBLE set, with both arrows live in the middle', () => {
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const h = load({ recordId: 3, records: ids.map((id) => rec(id)) });
  h.fn.paintTestNav();
  assert.equal(h.node.testPosition.textContent, '3 of 7');
  assert.equal(h.node.btnPrevTest.disabled, false);
  assert.equal(h.node.btnNextTest.disabled, false);
});

test('104b: the two edges disable one arrow each', () => {
  const ids = [1, 2, 3];
  const first = load({ recordId: 1, records: ids.map((id) => rec(id)) });
  first.fn.paintTestNav();
  assert.equal(first.node.testPosition.textContent, '1 of 3');
  assert.deepEqual([first.node.btnPrevTest.disabled, first.node.btnNextTest.disabled], [true, false]);

  const last = load({ recordId: 3, records: ids.map((id) => rec(id)) });
  last.fn.paintTestNav();
  assert.deepEqual([last.node.btnPrevTest.disabled, last.node.btnNextTest.disabled], [false, true]);
});

test('105: a filter that no longer matches the open test empties the position and both arrows', () => {
  const h = load({ recordId: 3, records: [1, 2, 3].map((id) => rec(id)), hidden: ['3'] });
  h.fn.paintTestNav();
  assert.equal(h.node.testPosition.textContent, '');
  assert.deepEqual([h.node.btnPrevTest.disabled, h.node.btnNextTest.disabled], [true, true]);
});

test('106: Next test walks past the end and back to the first untested row', () => {
  const h = load({
    recordId: 3,
    records: [rec(1), rec(2, { status: 'passed' }), rec(3, { status: 'passed' })],
  });
  h.fn.nextTest();
  assert.deepEqual(h.calls.opened, [1]);
  assert.deepEqual(h.calls.toasts, []);
});

test('106b: …and forwards without wrapping when there is a later one', () => {
  const h = load({
    recordId: 1,
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'passed' }), rec(3)],
  });
  h.fn.nextTest();
  assert.deepEqual(h.calls.opened, [3]);
});

test('107: the last untested test says so and stays where it is', () => {
  const h = load({ recordId: 1, records: [rec(1), rec(2, { status: 'passed' })] });
  h.fn.nextTest();
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'This is the last untested test' }]);
  assert.deepEqual(h.calls.runViews, []);
});

test('108: nothing left untested goes back to the run', () => {
  const h = load({
    recordId: 1,
    records: [rec(1, { status: 'passed' }), rec(2, { status: 'failed' })],
  });
  h.fn.nextTest();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Run complete' }]);
  assert.deepEqual(h.calls.runViews, [['r1', 'Checkout run']]);
});

test('109: an untested row the filter hides is not a candidate', () => {
  const h = load({
    recordId: 1,
    records: [rec(1, { status: 'passed' }), rec(2)],
    hidden: ['2'],
  });
  h.fn.nextTest();
  assert.deepEqual(h.calls.opened, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Run complete' }]);
  // …and the same row, visible, is opened.
  const shown = load({ recordId: 1, records: [rec(1, { status: 'passed' }), rec(2)] });
  shown.fn.nextTest();
  assert.deepEqual(shown.calls.opened, [2]);
});
