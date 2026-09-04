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
import { loadScreen, fakeChrome, fakeClock, makeDocument, el, event, plain, settle, rejection, ApiError } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');

const HOST = 'app.testomat.io';
const LOCK = 'Run is finished — results are read-only';
const ASSIGN_GATE = "Can't re-assign already marked test";
const NONE = '— none —';

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
  ['div', 'test-substatus', true], ['span', 'test-substatus-mark', true],
  ['div', 'test-assignee', true], ['p', 'assignee-reason', true],
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
    users: [],            // usersList
    replies: {},          // runRepliesFor(status)
    dropdown: true,       // a panel where initSubstatusDropdown already ran
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
  // The assignee listbox is a real subtree: onAssigneeDocClick asks the wrapper whether the click
  // landed inside it, so a flat fixture would answer "outside" for every option.
  const dd = el('div', { id: 'assignee-dd' });
  const trigger = el('button', { id: 'assignee-trigger' });
  const value = el('span', { id: 'assignee-value' });
  const menu = el('div', { id: 'assignee-menu' });
  menu.hidden = true;
  const filter = el('input', { id: 'assignee-filter', value: '' });
  const list = el('ul', { id: 'assignee-list' });
  const empty = el('div', { id: 'assignee-empty' });
  empty.hidden = true;
  trigger.append(value);
  menu.append(filter, list, empty);
  dd.append(trigger, menu);
  node.testAssignee.append(dd, node.assigneeReason);
  Object.assign(node, { assigneeDd: dd, assigneeTrigger: trigger, assigneeValue: value,
    assigneeMenu: menu, assigneeFilter: filter, assigneeList: list, assigneeEmpty: empty });

  // scrollIntoView is the one member mini-dom does not have that this screen calls, and the cursor
  // rows go through it on every move.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = () => {};
    return made;
  };
  for (const n of Object.values(node)) n.scrollIntoView = () => {};

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
    markers: 0,
    refreshUIs: 0,
    setStatus: [],
    setStep: [],
    substatus: [],      // { op, id, value }
    assign: [],         // { id, value }
    meta: [],           // { id, entries }
    enqueued: [],
    removed: [],
    envMeta: [],        // every collectEnvMeta(settings)
    logUploads: [],
    ddOptions: [],      // { options, value }
    ddValues: [],
    probes: 0,          // awaitRunState()
  };

  // Reassignable after load(), so a row can answer the second call differently from the first or
  // change the world from inside a call the screen is awaiting.
  const on = {
    setStatus: async (payload) => ({ id: payload.testrunId, status: payload.status }),
    setStep: async () => ({}),
    setSubstatus: async () => ({}),
    clearSubstatus: async () => ({}),
    assignTestrun: async () => ({}),
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
  const control = {
    trigger: el('button', { id: 'substatus-select' }),
    disabled: false,
    value: '',
    options: [],
    setOptions: (next, sOpts = {}) => {
      control.options = plain(next);
      calls.ddOptions.push({ options: plain(next), value: sOpts.value });
      if ('value' in sOpts) control.value = sOpts.value;
    },
    setValue: (v) => { control.value = v; calls.ddValues.push(v); },
  };

  const rowVisible = (r) => !o.hidden.includes(String(r?.id));

  const globals = {
    state,
    capabilities: { jwt: o.jwt, readonly: false },
    hasChrome: o.hasChrome,
    usersList: o.users,
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
    runRepliesFor: (status) => o.replies[status] || [],
    collectEnvMeta: async (settings) => { calls.envMeta.push(plain(settings)); return on.collectEnvMeta(settings); },
    uploadEvidenceLog: async (record) => { calls.logUploads.push(record?.id ?? null); return on.uploadEvidenceLog(record); },
    // run-view.js's pair: the run's archived answer, which may still be in flight when a click lands.
    runStateProbe: o.probe,
    awaitRunState: async () => { calls.probes += 1; calls.order.push('probe'); return on.awaitRunState(); },
    Icons: {
      el: (name, size = 16, ...cls) => {
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        n.classList.add(...cls.filter(Boolean));
        return n;
      },
    },
    // The real one writes data-tip on the node it is given (shared/tooltip.js:257,267); a recorder
    // alone could not tell a tip that landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
      get: (n) => (n && n.dataset ? (n.dataset.tip || '') : ''),
    },
    UserCell: {
      cell: (user) => {
        const box = el('span', { className: 'user-cell', dataset: { email: user?.email || '' } });
        box.textContent = user?.name || user?.email || '';
        return box;
      },
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
      setSubstatus: async (id, v) => { calls.substatus.push({ op: 'set', id, value: v }); return on.setSubstatus(id, v); },
      clearSubstatus: async (id) => { calls.substatus.push({ op: 'clear', id, value: null }); return on.clearSubstatus(id); },
      assignTestrun: async (id, v) => { calls.assign.push({ id, value: v }); return on.assignTestrun(id, v); },
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
    exported: `({ ASSIGN_GATE_REASON,
      stepWriteChain: () => stepWriteChain,
      assigneeActiveId: () => assigneeActiveId })`,
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
    // What the tester sees under the cursor in the listbox.
    activeOption: () => node.assigneeList.querySelector('.active')?.id ?? null,
    optionIds: () => node.assigneeList.children.map((li) => li.dataset.userId),
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

// ---------- assignee and substatus writes (rows 63-75, 157-158) ----------

test('63: a custom status is written and shown before the server answers', async () => {
  const h = load({ records: [rec(7, { status: 'failed' })], replies: { failed: ['Needs investigation'] } });
  const done = h.fn.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Needs investigation'); // optimistic
  assert.equal(h.node.testSubstatusMark.textContent, 'Needs investigation');
  await done;
  assert.deepEqual(h.calls.substatus, [{ op: 'set', id: 7, value: 'Needs investigation' }]);
  assert.equal(h.calls.beginWrites, 1);
  assert.equal(h.calls.endWrites, 1);
});

test('64: the empty row is how a custom status comes back OFF', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Needs investigation' })] });
  await h.fn.onSubstatusChange('');
  assert.deepEqual(h.calls.substatus, [{ op: 'clear', id: 7, value: null }]);
  assert.equal(h.state.records[0].substatus, '');
});

test('65: a second change while the first is in flight is ignored, and the face re-synced', async () => {
  const h = load({ records: [rec(7, { status: 'failed' })] });
  const held = deferred();
  h.on.setSubstatus = async () => held.promise;
  const first = h.fn.onSubstatusChange('Needs investigation');
  await settle();
  const second = h.fn.onSubstatusChange('Blocked');
  await settle();
  assert.deepEqual(h.calls.substatus.map((c) => c.value), ['Needs investigation']);
  assert.deepEqual(h.calls.ddValues, ['Needs investigation']); // put back to what the record holds
  held.resolve({});
  await Promise.all([first, second]);
});

test('66: a locked result refuses the change and re-syncs the face', async () => {
  const h = load({ lock: LOCK, records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  await h.fn.onSubstatusChange('Needs investigation');
  assert.deepEqual(h.calls.substatus, []);
  assert.deepEqual(h.calls.ddValues, ['Blocked']);
  assert.equal(h.state.records[0].substatus, 'Blocked');
});

test('67: an expired token rolls the custom status back and speaks on the LINE, not a toast', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.on.setSubstatus = async () => { throw new h.ApiError('auth', 401, 'token rejected'); };
  await h.fn.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Blocked');
  assert.deepEqual(h.calls.ddValues, ['Blocked']);
  assert.deepEqual(h.calls.authLines, ['test-status']);
  assert.deepEqual(h.calls.toasts, []);
});

test('67b: …every other failure is a toast, and no auth line', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.on.setSubstatus = async () => { throw new h.ApiError('http', 500, 'server said no'); };
  await h.fn.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Blocked');
  assert.deepEqual(h.calls.authLines, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Custom status not saved: server said no', error: true }]);
});

test('68: assigning writes the member id and shows the member\'s EMAIL straight away', async () => {
  const h = load({ users: [{ id: '12', name: 'Ann', email: 'A@x.io' }] });
  const done = h.fn.onAssigneeChange('12');
  assert.equal(h.state.records[0].assigned_to, 'A@x.io'); // the shape the v2 read echoes back
  assert.equal(h.node.assigneeTrigger.disabled, true);
  await done;
  assert.deepEqual(h.calls.assign, [{ id: 7, value: '12' }]);
  assert.equal(h.node.assigneeTrigger.dataset.userId, '12');
  assert.equal(h.node.assigneeTrigger.disabled, false);
  assert.equal(h.node.assigneeTrigger.classList.contains('saved-flash'), true);
  await h.clock.tick();
  assert.equal(h.node.assigneeTrigger.classList.contains('saved-flash'), false);
});

test('68b: a rejected assign puts the previous member back and toasts', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }, { id: '9', name: 'Bo', email: 'b@x.io' }],
    records: [rec(7, { assigned_to: 'b@x.io' })],
  });
  h.on.assignTestrun = async () => { throw new h.ApiError('http', 500, 'nope'); };
  await h.fn.onAssigneeChange('12');
  assert.equal(h.state.records[0].assigned_to, 'b@x.io');
  assert.equal(h.node.assigneeTrigger.dataset.userId, '9');
  assert.deepEqual(h.calls.toasts, [{ msg: 'Assignee not saved: nope', error: true }]);
});

test('69: the empty value UNASSIGNS — a null id and a null email', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }],
    records: [rec(7, { assigned_to: 'A@x.io' })],
  });
  await h.fn.onAssigneeChange('');
  assert.deepEqual(h.calls.assign, [{ id: 7, value: null }]);
  assert.equal(h.state.records[0].assigned_to, null);
});

test('70: picking the member who already holds it writes nothing', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }],
    records: [rec(7, { assigned_to: 'a@X.io' })], // the same address, cased the other way
  });
  await h.fn.onAssigneeChange('12');
  assert.deepEqual(h.calls.assign, []);
});

test('71: a row that already has a verdict is no longer re-assignable', async () => {
  const h = load({ users: [{ id: '12', name: 'Ann', email: 'A@x.io' }], records: [rec(7, { status: 'failed' })] });
  await h.fn.onAssigneeChange('12');
  assert.deepEqual(h.calls.assign, []);
  assert.equal(h.node.assigneeTrigger.disabled, true);
  assert.equal(h.node.assigneeReason.textContent, ASSIGN_GATE);
  assert.equal(h.node.assigneeReason.hidden, false);
  assert.equal(h.node.assigneeTrigger.dataset.tip, ASSIGN_GATE);
});

test('72: the echoed email maps back to a member id, case-insensitively', () => {
  const h = load({ users: [{ id: '9', name: 'Ann', email: 'A@x.io' }] });
  assert.equal(h.fn.assignedUserId({ assigned_to: 'a@X.io' }), '9');
});

test('73: an unassigned row, an unknown address and no member list all answer ""', () => {
  const h = load({ users: [{ id: '9', email: 'A@x.io' }] });
  assert.equal(h.fn.assignedUserId({}), '');
  assert.equal(h.fn.assignedUserId({ assigned_to: 'stranger@x.io' }), '');
  h.fn.usersList = null;
  assert.equal(h.fn.assignedUserId({ assigned_to: 'A@x.io' }), '');
});

test('74: a marked row states the reason it cannot be re-assigned', () => {
  const h = load();
  assert.equal(h.lex.ASSIGN_GATE_REASON, ASSIGN_GATE);
  assert.equal(h.fn.assigneeGateReason({ status: 'failed' }), ASSIGN_GATE);
  assert.equal(h.fn.assigneeGateReason({ status: 'passed' }), ASSIGN_GATE);
});

test('75: pending folds to untested, and no record at all is not a gate', () => {
  const h = load();
  assert.equal(h.fn.assigneeGateReason({ status: 'pending' }), '');
  assert.equal(h.fn.assigneeGateReason({}), '');
  assert.equal(h.fn.assigneeGateReason(null), '');
});

test('157: the reply group is offered with the empty row first, and the record\'s own value picked', () => {
  const h = load({
    records: [rec(7, { status: 'failed', substatus: 'Blocked' })],
    replies: { failed: ['Blocked', 'Needs investigation'] },
  });
  h.fn.renderSubstatus(h.state.records[0]);
  assert.equal(h.node.testSubstatus.hidden, false);
  assert.deepEqual(h.calls.ddOptions, [{
    options: [{ value: '', label: NONE }, { value: 'Blocked', label: 'Blocked' },
      { value: 'Needs investigation', label: 'Needs investigation' }],
    value: 'Blocked',
  }]);
});

test('157b: a value the project no longer replies with falls back to the empty row', () => {
  const h = load({
    records: [rec(7, { status: 'failed', substatus: 'Retired' })],
    replies: { failed: ['Blocked'] },
  });
  h.fn.renderSubstatus(h.state.records[0]);
  assert.equal(h.calls.ddOptions[0].value, '');
});

test('158: no reply group, no JWT and a pending row each hide the control and clear it', () => {
  for (const [why, opts] of [
    ['no reply group', { records: [rec(7, { status: 'failed' })], replies: {} }],
    ['no jwt', { jwt: false, records: [rec(7, { status: 'failed' })], replies: { failed: ['Blocked'] } }],
    ['pending', { records: [rec(7)], replies: { pending: ['Blocked'] } }],
    ['no result id', { records: [rec(7, { status: 'failed' })], replies: { failed: ['Blocked'] } }],
  ]) {
    const h = load(opts);
    const record = why === 'no result id' ? { ...h.state.records[0], id: null } : h.state.records[0];
    h.fn.renderSubstatus(record);
    assert.equal(h.node.testSubstatus.hidden, true, why);
    assert.deepEqual(h.calls.ddOptions, [{ options: [], value: undefined }], why);
  }
});

// ---------- the assignee listbox keyboard (rows 147-156) ----------

// Member ids are STRINGS everywhere below because the read builds them that way (api.js:481) and
// the cursor compares them with `===` — a number would never match the row it is sitting on.
test('147: the list always opens with Unassigned above the members', () => {
  const h = load({ users: [{ id: '1', name: 'Ann' }] });
  assert.deepEqual(plain(h.fn.assigneeRows()), [
    { id: '', name: 'Unassigned', email: '' }, { id: '1', name: 'Ann' },
  ]);
});

test('148: the filter matches a name or an address, and Unassigned is filterable too', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'brian@x.io' }] });
  h.fn.openAssigneeMenu();
  h.node.assigneeFilter.value = 'AN';
  h.fn.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['1', '2']); // Ann by name, Brian by address
  h.node.assigneeFilter.value = 'una';
  h.fn.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['']);
});

test('149: a filter that matches nobody empties the list and shows the empty state', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.fn.openAssigneeMenu();
  assert.equal(h.node.assigneeEmpty.hidden, true);
  h.node.assigneeFilter.value = 'zz';
  h.fn.onAssigneeFilterInput();
  assert.deepEqual(plain(h.fn.assigneeRows()), []);
  assert.deepEqual(h.optionIds(), []);
  assert.equal(h.node.assigneeEmpty.hidden, false);
});

test('150: the cursor clamps at the last row instead of wrapping', () => {
  const h = load({
    users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'b@x.io' }],
    records: [rec(7, { assigned_to: 'b@x.io' })],
  });
  h.fn.openAssigneeMenu();
  assert.equal(h.activeOption(), 'assignee-opt-2');
  h.fn.moveAssigneeActive(1);
  assert.equal(h.activeOption(), 'assignee-opt-2');
  assert.equal(h.node.assigneeFilter.getAttribute('aria-activedescendant'), 'assignee-opt-2');
  // …and one step the other way does move, so the clamp is a clamp and not a dead control.
  h.fn.moveAssigneeActive(-1);
  assert.equal(h.activeOption(), 'assignee-opt-1');
});

test('151: with no cursor yet, either direction lands on the first row', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  assert.equal(h.lex.assigneeActiveId(), null);
  h.fn.moveAssigneeActive(-1);
  assert.equal(h.lex.assigneeActiveId(), '');
});

test('152: Escape closes the menu and hands focus back to the trigger', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.fn.openAssigneeMenu();
  const ev = event(h.doc, 'keydown', { key: 'Escape' });
  h.fn.onAssigneeMenuKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(h.doc.activeElement, h.node.assigneeTrigger);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  // …and the document-level listeners the open registered are gone with it.
  assert.equal(h.doc.listeners.get('keydown').length, 0);
  assert.equal(h.doc.listeners.get('click').length, 0);
});

test('153: Tab closes the menu but is NOT swallowed — focus is leaving on purpose', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.fn.openAssigneeMenu();
  const ev = event(h.doc, 'keydown', { key: 'Tab' });
  h.fn.onAssigneeMenuKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(ev.propagationStopped, false);
});

test('154: Enter on the cursor row assigns that member', async () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'b@x.io' }] });
  h.fn.openAssigneeMenu();
  h.fn.moveAssigneeActive(1); // off Unassigned, onto Ann
  const ev = event(h.doc, 'keydown', { key: 'Enter' });
  h.fn.onAssigneeMenuKey(ev);
  await settle();
  assert.deepEqual(h.calls.assign, [{ id: 7, value: '1' }]);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(ev.defaultPrevented, true);
});

test('155: Space opens the closed trigger and keeps the page from scrolling', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  const ev = event(h.node.assigneeTrigger, 'keydown', { key: ' ' });
  h.fn.onAssigneeTriggerKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, false);
  assert.equal(ev.defaultPrevented, true);
  // …a key with no meaning here leaves both alone.
  const h2 = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  const other = event(h2.node.assigneeTrigger, 'keydown', { key: 'x' });
  h2.fn.onAssigneeTriggerKey(other);
  assert.equal(h2.node.assigneeMenu.hidden, true);
  assert.equal(other.defaultPrevented, false);
});

test('156: typing in the filter moves the cursor to the first match', () => {
  const h = load({
    users: [{ id: '1', name: 'Zoe', email: 'zoe@x.io' }, { id: '2', name: 'Zack', email: 'zack@x.io' }],
    records: [rec(7, { assigned_to: 'zack@x.io' })],
  });
  h.fn.openAssigneeMenu();
  assert.equal(h.activeOption(), 'assignee-opt-2'); // the member the row already holds
  h.node.assigneeFilter.value = 'z'; // both still match, so only the reset can move the cursor
  h.fn.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['1', '2']);
  assert.equal(h.activeOption(), 'assignee-opt-1');
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
