#!/usr/bin/env node
// What extension/sidepanel/screens/livesync.js re-reads, keeps and refuses to overwrite (#159): a
// colleague's result reaches the open run within a poll, while the tester's own in-flight write and
// anything parked in the offline queue win over whatever the server says. The loop stops while the
// panel is hidden or the project is read-only, parks for good on an expired session, and slows to one
// tick a minute while the instance is rate-limiting us.
// Run: node --test tests/livesync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, settle } from './helpers/panel-harness.mjs';
import { loadState } from './helpers/core-harness.mjs';

// The REAL comparator out of core/state.js, not a hand-written copy: #258 was three copies of one
// sort rule, and a stub here would be a fourth free to drift. Its own rows live in state.test.mjs.
const { byRecordId } = loadState();

// screens/run-view.js's own two one-liners. Stubs that answered `record.status` verbatim would let
// the pending/untested rows pass without the module ever comparing a DISPLAY status.
const displayStatus = (record) => {
  const s = record?.status;
  return s && s !== 'pending' ? s : 'untested';
};
const statusLabel = (status) => (status === 'untested' ? 'pending' : status);

const err = (kind) => Object.assign(new Error(kind), { kind });
const clone = (rows) => rows.map((r) => ({ ...r }));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// A payload with a DIFFERENT id set: applying it replaces state.records and repaints the whole view,
// so "the poll was discarded" is visible as the records standing untouched.
const STRUCTURAL = [{ id: 2, status: 'failed' }];

const NOW = 1_700_000_000_000;

// The panel globals livesync.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the ones after this land in parallel.
function load(opts = {}) {
  const o = {
    view: 'run',
    runId: 'r1',
    currentRecordId: null,
    readonly: false,
    visibility: 'visible',
    records: [],          // the LOCAL records; copied, because syncApply mutates them in place
    remote: null,         // what listTestruns answers with; by default a fresh copy of `records`
    answer: null,         // …or a function, for a fetch the test holds open or makes reject
    rows: null,           // the <li>s on screen; by default one per local record
    statusClass: '',
    noStatusLine: false,
    queued: [],           // record ids OfflineQueue.has() says yes to
    withQueue: true,
    session: {},
    runInfoChanged: false,
    rateLimitedAt: null,  // a function, or null for an API that has no such method at all
    now: NOW,
    ...opts,
  };

  // index.html's shape, cut to the two nodes this screen touches: the run's status line and the row
  // list runRowEl() walks.
  const doc = makeDocument([]);
  const runStatus = el('div', { id: 'run-status', className: o.statusClass });
  const ids = o.rows || o.records.map((r) => String(r.id));
  const list = el('ul', { id: 'run-tests' }, ...ids.map((id) => el('li', {
    className: 'test-row', dataset: { recordId: String(id) },
  })));
  doc.body.append(list);
  if (!o.noStatusLine) doc.body.append(runStatus);

  const calls = {
    listTestruns: [],
    repaintRow: [],
    repaintRowSubstatus: [],
    refreshSuiteFraction: [],
    applyAssigneeGate: [],
    statusLines: [],
    toasts: [],
    refreshRunInfo: [],
    refreshRunFinished: [],
    paintRunProgress: 0,
    renderRunFilterChips: 0,
    renderRunView: 0,
    renderTestProgress: 0,
    renderRunInfo: 0,
    applyRunLock: 0,
    replays: 0,
  };

  const state = {
    view: o.view, runId: o.runId, currentRecordId: o.currentRecordId, records: clone(o.records),
  };
  const capabilities = { readonly: o.readonly };
  const queued = new Set(o.queued.map(String));
  const time = { now: o.now };

  const api = {
    listTestruns: (runId) => {
      calls.listTestruns.push(String(runId));
      return o.answer ? o.answer(String(runId)) : Promise.resolve(clone(o.remote || o.records));
    },
  };
  if (o.rateLimitedAt) api.rateLimitedAt = o.rateLimitedAt;

  const globals = {
    state,
    capabilities,
    displayStatus,
    statusLabel,
    TestomatAPI: api,
    $: (id) => doc.getElementById(id),
    setStatusLine: (id, text, cls) => { calls.statusLines.push({ id, text, cls }); },
    runRowEl: (id) => doc.querySelector(`#run-tests li.test-row[data-record-id="${id}"]`),
    repaintRow: (li, r) => { calls.repaintRow.push(String(r.id)); },
    repaintRowSubstatus: (li, r) => { calls.repaintRowSubstatus.push(String(r.id)); },
    refreshSuiteFraction: (li) => { calls.refreshSuiteFraction.push(li.dataset.recordId); },
    paintRunProgress: () => { calls.paintRunProgress += 1; },
    renderRunFilterChips: () => { calls.renderRunFilterChips += 1; },
    renderRunView: () => { calls.renderRunView += 1; },
    renderTestProgress: () => { calls.renderTestProgress += 1; },
    renderRunInfo: () => { calls.renderRunInfo += 1; },
    RunLock: { applyRunLock: () => { calls.applyRunLock += 1; } },
    // #153's gate moved to screens/test-meta.js; livesync only asks it to re-run after a
    // colleague's write, so the stub records the ask and tests/test-meta.test.mjs owns the rule.
    TestMeta: { applyAssigneeGate: (rec) => { calls.applyAssigneeGate.push(rec ? String(rec.id) : rec); } },
    recordFor: (id) => state.records.find((r) => String(r.id) === String(id)),
    byRecordId,
    toast: (msg) => { calls.toasts.push(msg); },
    refreshRunInfo: async (runId) => { calls.refreshRunInfo.push(String(runId)); return o.runInfoChanged; },
    refreshRunFinished: async (runId) => { calls.refreshRunFinished.push(String(runId)); },
  };
  // Left OUT rather than set to undefined when the panel has no queue: the module reaches it through
  // `typeof`, and only a genuinely absent binding reproduces that.
  if (o.withQueue) {
    globals.OfflineQueue = {
      has: (id) => queued.has(String(id)),
      replay: () => { calls.replays += 1; },
    };
  }
  if (o.noChrome) globals.chrome = undefined;

  const clock = fakeClock();
  const h = loadScreen('livesync', {
    globals, document: doc, clock, visibility: o.visibility, session: o.session, now: () => time.now,
  });

  return { ...h, state, capabilities, calls, list, runStatus, time, queued };
}

// Let a tick reach the fetch it is waiting on, without waiting for the tick itself.
const startTick = async (h) => { h.fn.syncTick(); await settle(); };

// ---------- the poll interval and the poll gate (rows 1-6) ----------

test('1: the poll interval comes from storage.session, and anything unusable falls back to 20s', async () => {
  const set = load({ session: { pollInterval: 500 } });
  assert.equal(await set.fn.readPollMs(), 500);
  assert.equal(set.store.ops('session', 'get').length, 1);

  for (const v of [0, -1, 'x', null, undefined]) {
    assert.equal(await load({ session: { pollInterval: v } }).fn.readPollMs(), 20000, `pollInterval=${v}`);
  }
  assert.equal(await load().fn.readPollMs(), 20000); // the key is not there at all

  const broken = load();
  broken.store.fails.sessionGet = new Error('storage unavailable');
  assert.equal(await broken.fn.readPollMs(), 20000);

  // A build with no `chrome` at all keeps the default without reaching for storage.
  const bare = load({ noChrome: true, session: { pollInterval: 500 } });
  assert.equal(await bare.fn.readPollMs(), 20000);
  assert.equal(bare.store.ops('session', 'get').length, 0);
});

test('2: an expired session parks the gate until the next start', async () => {
  const h = load({ records: [{ id: 1 }], answer: () => Promise.reject(err('auth')) });
  assert.equal(h.fn.syncShouldPoll(), true); // the same gate, before the 401
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.equal(h.fn.syncShouldPoll(), false);
});

test('3: a read-only project does not poll', () => {
  const h = load();
  assert.equal(h.fn.syncShouldPoll(), true);
  h.capabilities.readonly = true;
  assert.equal(h.fn.syncShouldPoll(), false);
});

test('4: a hidden panel does not poll', () => {
  const h = load();
  assert.equal(h.fn.syncShouldPoll(), true);
  h.doc.visibilityState = 'hidden';
  assert.equal(h.fn.syncShouldPoll(), false);
  h.doc.visibilityState = 'visible';
  assert.equal(h.fn.syncShouldPoll(), true);
  // A document that reports nothing is not a hidden one — the gate must not read it as one.
  h.doc.visibilityState = undefined;
  assert.equal(h.fn.syncShouldPoll(), true);
});

test('5: with no run open there is nothing to keep fresh', () => {
  const h = load();
  assert.equal(h.fn.syncShouldPoll(), true);
  h.state.runId = null;
  assert.equal(h.fn.syncShouldPoll(), false);
});

test('6: the loop runs on the run and on a test of it, never on the runs list', () => {
  const h = load();
  for (const [view, expected] of [['run', true], ['test', true], ['runs', false], ['tclist', false]]) {
    h.state.view = view;
    assert.equal(h.fn.syncShouldPoll(), expected, view);
  }
});

// ---------- the timer lifecycle and the own-write bracket (rows 7-11) ----------

test('7: a second start leaves one timer alive and discards the fetch the first one had on the wire', async () => {
  const d = deferred();
  const h = load({ records: [{ id: 1, status: 'passed' }], answer: () => d.promise });
  await h.fn.startLiveSync();
  assert.equal(h.clock.count(), 1);
  await startTick(h);

  await h.fn.startLiveSync();
  assert.equal(h.clock.count(), 1); // the first timer was cleared, not left running beside the second
  d.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(h.state.records.map((r) => r.id), [1]);
  assert.equal(h.calls.renderRunView, 0);

  // The same drive without the restart applies the answer, so the two rows above are not asserting
  // a fetch that never resolves.
  const d2 = deferred();
  const alone = load({ records: [{ id: 1, status: 'passed' }], answer: () => d2.promise });
  await alone.fn.startLiveSync();
  await startTick(alone);
  d2.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(alone.state.records.map((r) => r.id), [2]);
  assert.equal(alone.calls.renderRunView, 1);
});

test('8: stopping clears the timer and discards the fetch already on the wire', async () => {
  const d = deferred();
  const h = load({ records: [{ id: 1, status: 'passed' }], answer: () => d.promise });
  await h.fn.startLiveSync();
  await startTick(h);

  h.fn.syncStop();
  assert.equal(h.clock.count(), 0);
  d.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(h.state.records.map((r) => r.id), [1]);
  assert.equal(h.calls.renderRunView, 0);
  assert.equal(h.calls.applyRunLock, 0);

  // The very same answer lands once the loop is running again, so the rows above are not about a
  // payload that could never be applied.
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.deepEqual(h.state.records.map((r) => r.id), [2]);
  assert.equal(h.calls.renderRunView, 1);
});

test('9: the last own write to drain forces an immediate refetch with the timer reset', async () => {
  const h = load({ records: [{ id: 1 }] });
  await h.fn.startLiveSync();
  const arms = h.clock.arms().length;
  const cleared = h.clock.cleared.length;

  h.fn.syncBeginWrite();
  h.fn.syncBeginWrite();
  h.fn.syncEndWrite(); // one write still open
  await settle();
  assert.deepEqual(h.calls.listTestruns, []);
  assert.equal(h.clock.arms().length, arms);

  h.fn.syncEndWrite(); // drained to zero
  await settle();
  assert.deepEqual(h.calls.listTestruns, ['r1']);
  assert.equal(h.clock.arms().length, arms + 1);
  assert.equal(h.clock.cleared.length, cleared + 1);
  assert.equal(h.clock.count(), 1);
});

test('10: an unmatched end never pushes the write depth below zero', async () => {
  const h = load({ records: [{ id: 1 }] });
  await h.fn.startLiveSync();
  for (let i = 0; i < 3; i += 1) { h.fn.syncEndWrite(); await settle(); }
  assert.equal(h.calls.listTestruns.length, 3); // each one is already a drain to zero

  // From a depth of -3 a single begin would not hold anything off; from 0 it holds off every tick.
  h.fn.syncBeginWrite();
  await h.clock.tick();
  await startTick(h);
  assert.equal(h.calls.listTestruns.length, 3);

  h.fn.syncEndWrite();
  await settle();
  assert.equal(h.calls.listTestruns.length, 4);
});

test('11: an immediate refetch is meaningless while the loop is stopped, and does nothing', async () => {
  const h = load({ records: [{ id: 1 }] });
  h.fn.syncNow();
  await settle();
  assert.deepEqual(h.calls.listTestruns, []);
  assert.deepEqual(h.clock.arms(), []);

  await h.fn.startLiveSync(); // the same call with the loop running does both halves
  h.fn.syncNow();
  await settle();
  assert.deepEqual(h.calls.listTestruns, ['r1']);
  assert.equal(h.clock.arms().length, 2);
  assert.equal(h.clock.count(), 1);
});

// ---------- the tick (rows 12-20) ----------

test('12: a tick landing while one is on the wire does not start a second fetch', async () => {
  const d = deferred();
  const h = load({ records: [{ id: 1 }], answer: () => d.promise });
  await h.fn.startLiveSync();
  await startTick(h);
  assert.equal(h.calls.listTestruns.length, 1);

  await h.clock.tick();  // the interval comes round again
  await startTick(h);    // and a catch-up fires too
  assert.equal(h.calls.listTestruns.length, 1);

  d.resolve([{ id: 1 }]);
  await settle();
  await h.clock.tick();  // with the wire clear the next tick does fetch
  assert.equal(h.calls.listTestruns.length, 2);
});

test('13: a run opened while the poll was on the wire keeps the answer meant for the old one out', async () => {
  const d = deferred();
  const h = load({ records: [{ id: 1, status: 'passed' }], answer: () => d.promise });
  await h.fn.startLiveSync();
  await startTick(h);

  h.state.runId = 'r2';
  d.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(h.state.records.map((r) => r.id), [1]);
  assert.equal(h.calls.renderRunView, 0);
  assert.equal(h.calls.replays, 0);

  const d2 = deferred();
  const same = load({ records: [{ id: 1, status: 'passed' }], answer: () => d2.promise });
  await same.fn.startLiveSync();
  await startTick(same);
  d2.resolve(STRUCTURAL); // the same answer, on the run it was asked for
  await settle();
  assert.deepEqual(same.state.records.map((r) => r.id), [2]);
  assert.equal(same.calls.renderRunView, 1);
});

test('14: a write the tester starts mid-fetch wins — the snapshot behind it is not applied', async () => {
  const d = deferred();
  const h = load({ records: [{ id: 1, status: 'passed' }], answer: () => d.promise });
  await h.fn.startLiveSync();
  await startTick(h);

  h.fn.syncBeginWrite();
  d.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(h.state.records.map((r) => r.id), [1]);
  assert.equal(h.calls.renderRunView, 0);

  // The panel being hidden mid-fetch takes the same exit; visible throughout, it lands.
  const d2 = deferred();
  const hidden = load({ records: [{ id: 1, status: 'passed' }], answer: () => d2.promise });
  await hidden.fn.startLiveSync();
  await startTick(hidden);
  hidden.doc.visibilityState = 'hidden';
  d2.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(hidden.state.records.map((r) => r.id), [1]);

  const d3 = deferred();
  const open = load({ records: [{ id: 1, status: 'passed' }], answer: () => d3.promise });
  await open.fn.startLiveSync();
  await startTick(open);
  d3.resolve(STRUCTURAL);
  await settle();
  assert.deepEqual(open.state.records.map((r) => r.id), [2]);
});

test('15: a recovered connection clears the red line left standing under the run', async () => {
  const h = load({ records: [{ id: 1 }], statusClass: 'status-line error' });
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.deepEqual(h.calls.statusLines, [{ id: 'run-status', text: '', cls: undefined }]);
});

test('16: a line that is not red is left alone, and a run with no line at all does not throw', async () => {
  const ok = load({ records: [{ id: 1 }], statusClass: 'status-line ok' });
  await ok.fn.startLiveSync();
  await ok.clock.tick();
  assert.deepEqual(ok.calls.statusLines, []);
  assert.equal(ok.calls.applyRunLock, 1); // the tick did run, so the row above is not empty

  const none = load({ records: [{ id: 1 }], noStatusLine: true });
  await none.fn.startLiveSync();
  await none.clock.tick(); // must not throw
  assert.deepEqual(none.calls.statusLines, []);
  assert.equal(none.calls.applyRunLock, 1);
});

test('17: a good tick replays the queue, re-reads the run detail and settles the lock', async () => {
  const h = load({ records: [{ id: 1 }] });
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.equal(h.calls.replays, 1);
  assert.deepEqual(h.calls.refreshRunInfo, ['r1']);
  assert.deepEqual(h.calls.refreshRunFinished, ['r1']);
  assert.equal(h.calls.applyRunLock, 1);
  assert.equal(h.calls.paintRunProgress, 0); // the detail read said nothing changed
  assert.equal(h.calls.renderRunInfo, 0);

  // A detail that DID change repaints the header numbers on the same tick.
  const moved = load({ records: [{ id: 1 }], runInfoChanged: true });
  await moved.fn.startLiveSync();
  await moved.clock.tick();
  assert.equal(moved.calls.paintRunProgress, 1);
  assert.equal(moved.calls.renderRunInfo, 1);
});

test('18: a 401 on the poll path parks the loop without a word to the tester', async () => {
  const h = load({ records: [{ id: 1 }], answer: () => Promise.reject(err('auth')) });
  await h.fn.startLiveSync();
  assert.equal(h.clock.count(), 1);

  await h.clock.tick();
  assert.equal(h.clock.count(), 0);
  assert.equal(h.fn.syncShouldPoll(), false);
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.statusLines, []);
  assert.equal(h.calls.replays, 0);
});

test('19: a dropped connection is skipped — the loop keeps its timer and paints nothing', async () => {
  const h = load({ records: [{ id: 1 }], answer: () => Promise.reject(err('network')) });
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.equal(h.clock.count(), 1);
  assert.equal(h.fn.syncShouldPoll(), true);
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.statusLines, []);
  assert.equal(h.calls.replays, 0);
  assert.equal(h.calls.applyRunLock, 0);

  await h.clock.tick(); // and the failure left no in-flight flag standing
  assert.equal(h.calls.listTestruns.length, 2);
});

test('20: Refresh resumes a loop an expired session parked', async () => {
  let fail = true;
  const h = load({
    records: [{ id: 1 }],
    answer: () => (fail ? Promise.reject(err('auth')) : Promise.resolve([{ id: 1 }])),
  });
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.equal(h.fn.syncShouldPoll(), false);

  fail = false;
  await h.fn.startLiveSync();
  assert.equal(h.fn.syncShouldPoll(), true);
  assert.equal(h.clock.count(), 1);
  await h.clock.tick();
  assert.equal(h.calls.listTestruns.length, 2);
  assert.equal(h.calls.replays, 1);
});

// ---------- the remote-wins diff (rows 21-33) ----------

test('21: the poll re-sorts by record id, and a newest-first payload comes out in run order', async () => {
  const numbers = load({ records: [], answer: () => Promise.resolve([{ id: 10 }, { id: 9 }]) });
  await numbers.fn.startLiveSync();
  await numbers.clock.tick();
  assert.deepEqual(numbers.state.records.map((r) => r.id), [9, 10]);

  // The poll re-sorts the payload rather than the LIST, so the server's array is left alone.
  const payload = [{ id: 10 }, { id: 9 }];
  const untouched = load({ records: [], answer: () => Promise.resolve(payload) });
  await untouched.fn.startLiveSync();
  await untouched.clock.tick();
  assert.deepEqual(payload.map((r) => r.id), [10, 9]);
});

test("21 (#258): record ids sort numerically whatever their type — '9' before '10'", async () => {
  const h = load({ records: [], answer: () => Promise.resolve([{ id: '9' }, { id: '10' }]) });
  await h.fn.startLiveSync();
  await h.clock.tick();
  assert.deepEqual(h.state.records.map((r) => r.id), ['9', '10']);

  // Every 20 s tick re-sorts, so a wrong order here is the one a refresh never settles.
  const hundred = load({ records: [], answer: () => Promise.resolve([{ id: '100' }, { id: '99' }]) });
  await hundred.fn.startLiveSync();
  await hundred.clock.tick();
  assert.deepEqual(hundred.state.records.map((r) => r.id), ['99', '100']);
  await hundred.clock.tick();
  assert.deepEqual(hundred.state.records.map((r) => r.id), ['99', '100'], 'and it stays settled');
});

test('22: a record added remotely replaces the list and repaints the run view', () => {
  const h = load({ records: [{ id: 1, status: 'passed' }] });
  h.fn.syncApply([{ id: 1, status: 'passed' }, { id: 2, status: 'failed' }]);
  assert.deepEqual(h.state.records.map((r) => String(r.id)), ['1', '2']);
  assert.equal(h.calls.renderRunView, 1);
  assert.equal(h.calls.renderTestProgress, 0);
  assert.deepEqual(h.calls.repaintRow, []); // structural: no per-row diff runs at all
  assert.equal(h.calls.paintRunProgress, 0);
});

test('23: a record removed remotely takes the same structural path', () => {
  const h = load({ records: [{ id: 1, status: 'passed' }, { id: 2, status: 'failed' }] });
  h.fn.syncApply([{ id: 1, status: 'passed' }]);
  assert.deepEqual(h.state.records.map((r) => String(r.id)), ['1']);
  assert.equal(h.calls.renderRunView, 1);
  assert.deepEqual(h.calls.repaintRow, []);
});

test('24: a structural change while a test is open repaints the test, not the run list', () => {
  const h = load({ view: 'test', currentRecordId: 1, records: [{ id: 1, status: 'passed' }] });
  h.fn.syncApply([{ id: 1, status: 'passed' }, { id: 2, status: 'failed' }]);
  assert.equal(h.calls.renderTestProgress, 1);
  assert.equal(h.calls.renderRunView, 0);
});

test('25: a status a colleague changed repaints that row, the progress, the chips and its fraction', () => {
  const h = load({ records: [{ id: 1, status: 'passed' }, { id: 2, status: 'passed' }] });
  h.fn.syncApply([{ id: 1, status: 'failed' }, { id: 2, status: 'passed' }]);
  assert.deepEqual(h.calls.repaintRow, ['1']);
  assert.deepEqual(h.calls.repaintRowSubstatus, []);
  assert.equal(h.calls.paintRunProgress, 1);
  assert.equal(h.calls.renderRunFilterChips, 1);
  assert.deepEqual(h.calls.refreshSuiteFraction, ['1']);
  assert.equal(h.calls.renderRunView, 0); // the id set is the same, so nothing is re-rendered whole
  assert.equal(h.state.records[0].status, 'failed');
  assert.equal(h.state.records[1].status, 'passed');
});

test('26: a custom status moving on its own repaints the substatus, not the row', () => {
  const h = load({ records: [{ id: 1, status: 'passed', substatus: null }] });
  h.fn.syncApply([{ id: 1, status: 'passed', substatus: 'blocked' }]);
  assert.deepEqual(h.calls.repaintRowSubstatus, ['1']);
  assert.deepEqual(h.calls.repaintRow, []);
  assert.equal(h.state.records[0].substatus, 'blocked');
  assert.equal(h.calls.paintRunProgress, 1);
});

test('27: a remote row with no test_id does not erase the one the panel already knows', () => {
  const h = load({ records: [{ id: 1, status: 'passed', test_id: 't7' }] });
  h.fn.syncApply([{ id: 1, status: 'failed', test_id: null }]);
  assert.equal(h.state.records[0].test_id, 't7');
  assert.equal(h.state.records[0].status, 'failed'); // everything else still lands

  const named = load({ records: [{ id: 1, status: 'passed', test_id: 't7' }] });
  named.fn.syncApply([{ id: 1, status: 'failed', test_id: 't9' }]);
  assert.equal(named.state.records[0].test_id, 't9');
});

test('28: a result queued offline wins over the server — its status and message stay, the rest lands', () => {
  const h = load({
    view: 'test',
    currentRecordId: 1,
    queued: [1],
    records: [{ id: 1, status: 'failed', message: 'saw a 500', test_title: 'Login works', duration: 1 }],
  });
  h.fn.syncApply([{ id: 1, status: 'passed', message: 'from the server', test_title: 'Login works', duration: 42 }]);
  assert.equal(h.state.records[0].status, 'failed');
  assert.equal(h.state.records[0].message, 'saw a 500');
  assert.equal(h.state.records[0].duration, 42); // every other field is the server's
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.repaintRow, []);
  assert.equal(h.calls.paintRunProgress, 0);

  // The same payload on a row that is NOT queued takes the remote status and says so.
  const free = load({
    view: 'test',
    currentRecordId: 1,
    records: [{ id: 1, status: 'failed', message: 'saw a 500', test_title: 'Login works' }],
  });
  free.fn.syncApply([{ id: 1, status: 'passed', message: 'from the server', test_title: 'Login works' }]);
  assert.equal(free.state.records[0].status, 'passed');
  assert.equal(free.state.records[0].message, 'from the server');
  assert.deepEqual(free.calls.repaintRow, ['1']);
  assert.deepEqual(free.calls.toasts, ['"Login works" → Passed']);
});

test('29: the queue guards status and message only — a remote substatus still counts as a change', () => {
  const h = load({ queued: [1], records: [{ id: 1, status: 'failed', message: 'm', substatus: null }] });
  h.fn.syncApply([{ id: 1, status: 'passed', message: 'server', substatus: 'blocked' }]);
  assert.deepEqual(h.calls.repaintRowSubstatus, ['1']);
  assert.deepEqual(h.calls.repaintRow, []);
  assert.equal(h.state.records[0].status, 'failed'); // still the tester's own
  assert.equal(h.state.records[0].message, 'm');
  assert.equal(h.state.records[0].substatus, 'blocked');
  assert.equal(h.calls.paintRunProgress, 1);
});

test('30: a colleague marking the open test toasts it once and re-runs the assignee gate', () => {
  const h = load({
    view: 'test',
    currentRecordId: 2,
    records: [
      { id: 1, status: 'passed', test_title: 'Other' },
      { id: 2, status: 'failed', test_title: 'Login works' },
    ],
  });
  h.fn.syncApply([
    { id: 1, status: 'passed', test_title: 'Other' },
    { id: 2, status: 'passed', test_title: 'Login works' },
  ]);
  assert.deepEqual(h.calls.toasts, ['"Login works" → Passed']);
  assert.deepEqual(h.calls.applyAssigneeGate, ['2']);
  assert.deepEqual(h.calls.repaintRow, ['2']);
  assert.equal(h.calls.renderTestProgress, 1);

  // A record with no title falls back to naming its test.
  const bare = load({ view: 'test', currentRecordId: 2, records: [{ id: 2, status: 'failed', test_id: 't9' }] });
  bare.fn.syncApply([{ id: 2, status: 'passed', test_id: 't9' }]);
  assert.deepEqual(bare.calls.toasts, ['"Test t9" → Passed']);
});

test('31: only the test actually on screen is toasted — not another row, and not the run list', () => {
  const h = load({
    view: 'test',
    currentRecordId: 2,
    records: [
      { id: 1, status: 'passed', test_title: 'Other' },
      { id: 2, status: 'failed', test_title: 'Login works' },
    ],
  });
  h.fn.syncApply([
    { id: 1, status: 'failed', test_title: 'Other' },
    { id: 2, status: 'failed', test_title: 'Login works' },
  ]);
  assert.deepEqual(h.calls.repaintRow, ['1']);
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.applyAssigneeGate, []);

  // Back on the run list, the row the tester last had open changes: the id still matches, the view
  // does not, and a toast about a test that is not on screen would be wrong.
  const listed = load({
    view: 'run',
    currentRecordId: 2,
    records: [{ id: 2, status: 'failed', test_title: 'Login works' }],
  });
  listed.fn.syncApply([{ id: 2, status: 'passed', test_title: 'Login works' }]);
  assert.deepEqual(listed.calls.repaintRow, ['2']); // it did repaint, so the two rows above are not empty
  assert.deepEqual(listed.calls.toasts, []);
  assert.deepEqual(listed.calls.applyAssigneeGate, []);
});

test('32: a poll that brings nothing new paints nothing at all', () => {
  const h = load({ records: [{ id: 1, status: 'passed' }, { id: 2, status: 'pending' }] });
  // `pending` and `untested` are the same DISPLAY status, so neither row moved.
  h.fn.syncApply([{ id: 1, status: 'passed' }, { id: 2, status: 'untested' }]);
  assert.equal(h.calls.paintRunProgress, 0);
  assert.equal(h.calls.renderRunFilterChips, 0);
  assert.deepEqual(h.calls.repaintRow, []);
  assert.deepEqual(h.calls.refreshSuiteFraction, []);

  // One real change through the same call does paint, so the four rows above are not empty.
  h.fn.syncApply([{ id: 1, status: 'passed' }, { id: 2, status: 'skipped' }]);
  assert.equal(h.calls.paintRunProgress, 1);
  assert.equal(h.calls.renderRunFilterChips, 1);
  assert.deepEqual(h.calls.repaintRow, ['2']);
});

test('33: a changed row with no <li> on screen is skipped instead of throwing', () => {
  const h = load({ records: [{ id: 1, status: 'passed' }, { id: 2, status: 'passed' }], rows: ['2'] });
  h.fn.syncApply([{ id: 1, status: 'failed' }, { id: 2, status: 'failed' }]);
  assert.deepEqual(h.calls.repaintRow, ['2']);
  assert.deepEqual(h.calls.refreshSuiteFraction, ['2']);
  assert.equal(h.calls.paintRunProgress, 1); // the rest of the paint still runs
  assert.equal(h.state.records[0].status, 'failed'); // and the invisible record still took the change
});

// ---------- the label and the catch-up (rows 34-36) ----------

test('34: the toast label is capitalised, and a falsy status passes straight through', () => {
  const h = load();
  assert.equal(h.fn.capStatus('passed'), 'Passed');
  assert.equal(h.fn.capStatus('untested'), 'Pending'); // the label, not the internal key
  assert.equal(h.fn.capStatus(''), '');
  assert.equal(h.fn.capStatus(undefined), undefined);
  assert.equal(h.fn.capStatus(null), null);
});

test('35: a panel becoming visible again catches up at once', async () => {
  const h = load({ records: [{ id: 1 }], visibility: 'hidden' });
  h.fn.initLiveSync();
  assert.equal(h.doc.listeners.get('visibilitychange').length, 1);

  h.visibility('visible');
  await settle();
  assert.deepEqual(h.calls.listTestruns, ['r1']);
  assert.equal(h.calls.replays, 1);
});

test('36: a panel being hidden is not a reason to fetch', async () => {
  const h = load({ records: [{ id: 1 }] });
  h.fn.initLiveSync();
  h.visibility('hidden');
  await settle();
  assert.deepEqual(h.calls.listTestruns, []);

  // The listener's own check is not the gate's, and only this value tells them apart: a document
  // reporting NO visibility is one syncShouldPoll() would poll, and the catch-up still must not run.
  h.visibility(undefined);
  await settle();
  assert.equal(h.fn.syncShouldPoll(), true);
  assert.deepEqual(h.calls.listTestruns, []);

  // The same listener, the value it does answer to: without this the rows above would pass on a
  // handler that was never registered.
  h.visibility('visible');
  await settle();
  assert.deepEqual(h.calls.listTestruns, ['r1']);
});

// ---------- the rate-limit back-off (rows 37-43; newer than #159, no rows of its own there) ----------

test('37: while the instance is still refusing us the target is one tick a minute', async () => {
  let stamp = 0;
  const h = load({ records: [{ id: 1 }], session: { pollInterval: 500 }, rateLimitedAt: () => stamp });
  await h.fn.startLiveSync();
  assert.equal(h.fn.syncTargetMs(), 500); // the ordinary interval is the configured one
  assert.equal(h.clock.ms(), 500);

  stamp = NOW - 10_000;
  assert.equal(h.fn.syncTargetMs(), 60000);

  const limited = load({ records: [{ id: 1 }], rateLimitedAt: () => NOW - 10_000 });
  await limited.fn.startLiveSync();
  assert.equal(limited.clock.ms(), 60000); // a start under a 429 arms the back-off straight away
});

test('38: a stamp nobody refreshed goes stale on its own and the ordinary interval returns', () => {
  const h = load({ rateLimitedAt: () => NOW });
  assert.equal(h.fn.syncTargetMs(), 60000);
  h.time.now = NOW + 59_999;
  assert.equal(h.fn.syncTargetMs(), 60000);
  h.time.now = NOW + 60_000;
  assert.equal(h.fn.syncTargetMs(), 20000);
});

test('39: a stamp that is absent, throws or is not a number is not a rate limit', () => {
  assert.equal(load().fn.syncTargetMs(), 20000); // the API has no such method at all
  assert.equal(load({ rateLimitedAt: () => { throw new Error('boom'); } }).fn.syncTargetMs(), 20000);
  assert.equal(load({ rateLimitedAt: () => 'nope' }).fn.syncTargetMs(), 20000);
  assert.equal(load({ rateLimitedAt: () => 0 }).fn.syncTargetMs(), 20000);
  // The same seam WITH a live stamp does answer the back-off, so the four rows above are not
  // asserting a stub that can never say yes.
  assert.equal(load({ rateLimitedAt: () => NOW - 1 }).fn.syncTargetMs(), 60000);
});

test('40: a 429 under the tick re-arms the loop, so the NEXT tick lands a minute out', async () => {
  let stamp = 0;
  const h = load({
    records: [{ id: 1 }],
    rateLimitedAt: () => stamp,
    answer: () => { stamp = NOW; return Promise.resolve([{ id: 1 }]); },
  });
  await h.fn.startLiveSync();
  assert.equal(h.clock.ms(), 20000);
  const arms = h.clock.arms().length;

  await h.clock.tick();
  assert.equal(h.clock.ms(), 60000);
  assert.equal(h.clock.arms().length, arms + 1);
  assert.equal(h.clock.count(), 1); // re-armed, not armed a second time beside the first
});

test('41: the 2xx that clears the stamp brings the loop back to the ordinary interval', async () => {
  let stamp = NOW;
  const h = load({
    records: [{ id: 1 }],
    rateLimitedAt: () => stamp,
    answer: () => { stamp = 0; return Promise.resolve([{ id: 1 }]); },
  });
  await h.fn.startLiveSync();
  assert.equal(h.clock.ms(), 60000);

  await h.clock.tick();
  assert.equal(h.clock.ms(), 20000);
  assert.equal(h.clock.count(), 1);
});

test('42: a tick that leaves the stamp alone leaves the timer exactly as it was', async () => {
  const h = load({ records: [{ id: 1 }], rateLimitedAt: () => 0 });
  await h.fn.startLiveSync();
  const armed = [...h.clock.live.keys()];
  const arms = h.clock.arms().length;
  const cleared = h.clock.cleared.length;

  await h.clock.tick();
  assert.deepEqual([...h.clock.live.keys()], armed); // the same timer, never re-armed
  assert.equal(h.clock.arms().length, arms);
  assert.equal(h.clock.cleared.length, cleared);
  assert.equal(h.clock.ms(), 20000);
});

test('43: a panel with no offline queue polls and diffs anyway — both typeof guards hold', async () => {
  const h = load({
    withQueue: false,
    records: [{ id: 1, status: 'passed' }],
    answer: () => Promise.resolve([{ id: 1, status: 'failed' }]),
  });
  await h.fn.startLiveSync();
  await h.clock.tick(); // must not throw on the replay or on the queue-wins check
  assert.deepEqual(h.calls.repaintRow, ['1']);
  assert.equal(h.state.records[0].status, 'failed');
  assert.equal(h.calls.replays, 0);
  // A ReferenceError here would be swallowed by the tick's own catch, so the proof the guard held
  // is that the tick RAN ON past the replay line.
  assert.deepEqual(h.calls.refreshRunFinished, ['r1']);
  assert.equal(h.calls.applyRunLock, 1);

  // With the queue present the same drive replays, and a queued row keeps the tester's own status.
  const q = load({
    queued: [1],
    records: [{ id: 1, status: 'passed' }],
    answer: () => Promise.resolve([{ id: 1, status: 'failed' }]),
  });
  await q.fn.startLiveSync();
  await q.clock.tick();
  assert.equal(q.calls.replays, 1);
  assert.deepEqual(q.calls.repaintRow, []);
  assert.equal(q.state.records[0].status, 'passed');
});
