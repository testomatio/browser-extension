#!/usr/bin/env node
// What extension/sidepanel/screens/offline-queue.js parks, replays and drops (#160): a result marked
// while the connection is down waits on this machine, replays oldest click first when it returns, and
// is dropped with a sentence if its run has meanwhile finished, been archived or turned out automated.
// Run: node --test tests/offline-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, fire, settle } from './helpers/panel-harness.mjs';

// core/state.js's own one-liner. A stub that answered the whole URL would let the connection-stamp
// rows pass without the module ever comparing a host.
const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } };
const HERE = { baseUrl: 'https://a.io', projectId: 'p1' };
const ELSEWHERE = { baseUrl: 'https://b.io', projectId: 'p9' };

const err = (kind, message = kind) => Object.assign(new Error(message), { kind });
const OFFLINE_TIP = 'Saved offline — will sync when the connection returns';
const AUTH_TIP = 'Saved here — the token was rejected; authorize again in Settings to sync it';

// The panel globals offline-queue.js reads, all of them real enough to be driven. They live here and
// not in the harness: every screen has its own set, and the eight after this one land in parallel.
function load(opts = {}) {
  const o = {
    settings: { ...HERE },
    view: 'run',
    currentRecordId: null,
    jwt: true,
    readonly: false,
    hasChrome: true,
    rows: [],
    write: async () => {},
    getRun: async () => null,
    getRunInfo: async () => null,
    confirm: true,
    ...opts,
  };

  // index.html's shape, cut to what this screen touches: the banner, its Retry, the fold that opens
  // the queue (#108), the open-test badge and the run list refreshQueueUI walks.
  const doc = makeDocument([]);
  const bannerText = el('span', { className: 'pending-banner-text' });
  const retry = el('button', { id: 'pending-banner-retry' });
  const toggle = el('button', { id: 'pending-banner-toggle' });
  const queueList = el('ul', { id: 'pending-queue', hidden: true });
  const banner = el('div', { id: 'pending-banner', hidden: true }, bannerText, toggle, retry, queueList);
  const testQueued = el('span', { id: 'test-queued', hidden: true });
  // One line and no `.meta`, the shape rows took upstream — the row itself hosts the mark.
  const list = el('ul', { id: 'run-tests' }, ...o.rows.map((id) => el('li', {
    className: 'test-row', dataset: { recordId: String(id) },
  }, el('span', { className: 'title' }, `test ${id}`))));
  doc.body.append(banner, testQueued, list);

  const toasts = [];
  const writes = [];
  const repaints = [];
  const tips = [];
  const asks = [];
  const apiCalls = [];
  const calls = { $: 0 };
  const state = { settings: o.settings, view: o.view, currentRecordId: o.currentRecordId, runId: 'r1' };
  const capabilities = { jwt: o.jwt, readonly: o.readonly };
  const records = new Map(o.rows.map((id) => [String(id), { id, test_title: `test ${id}` }]));

  const globals = {
    state,
    capabilities,
    hasChrome: o.hasChrome,
    hostOf,
    isReadonlyError: (e) => !!e && e.kind === 'readonly',
    recordFor: (id) => records.get(String(id)) || null,
    runRowEl: (id) => doc.querySelector(`#run-tests li.test-row[data-record-id="${id}"]`),
    repaintRow: (li, r) => { repaints.push(String(r.id)); },
    toast: (msg, tOpts) => { toasts.push({ msg, ...(tOpts || {}) }); },
    // refreshQueueUI runs on every enqueue and every removal, so this one has to stay cheap.
    $: (id) => { calls.$ += 1; return doc.getElementById(id); },
    Tooltip: { set: (node, tip) => { tips.push({ node, tip }); } },
    // core/dialog.js's, stubbed: a Discard asks before it drops, and tests/dialog.test.mjs owns
    // the <dialog> itself.
    ConfirmDialog: { ask: async (message, label) => { asks.push({ message, label }); return o.confirm; } },
    // core/write-status.js's, stubbed: this suite is about what the drain hands it and what it
    // does with the answer. tests/write-status.test.mjs owns the request itself.
    WriteCore: {
      writeStatus: async (record, status, comment, onOptimistic, wOpts) => {
        writes.push({ id: String(record.id), status, comment, opts: { ...wOpts } });
        return o.write(record, status, comment, onOptimistic, wOpts);
      },
    },
    TestomatAPI: {
      getRun: async (id) => { apiCalls.push(['getRun', String(id)]); return o.getRun(String(id)); },
      getRunInfo: async (id) => { apiCalls.push(['getRunInfo', String(id)]); return o.getRunInfo(String(id)); },
    },
  };

  const h = loadScreen('offline-queue', {
    // index.html's own order: screens/run-lock.js stands ahead of this screen, and the drain asks
    // it whether a run is closed. The REAL one — a stub here would be a second copy of that set.
    before: ['run-lock'],
    exported: 'OfflineQueue',
    globals,
    document: doc,
    local: o.local,
    session: o.session,
    sessionOnChanged: o.sessionOnChanged,
    now: o.now,
  });

  return {
    ...h,
    Q: h.screen,
    banner, bannerText, retry, toggle, queueList, testQueued, list,
    toasts, writes, repaints, tips, asks, apiCalls, calls, state, capabilities,
    stored: () => h.store.data.offlineQueue,
    countOf: (name) => apiCalls.filter((c) => c[0] === name).length,
  };
}

// Every row that is not about the status itself queues a passing one.
const enqueue = (h, entry) => h.Q.enqueue({ status: 'passed', ...entry });

// ---------- queueability, the seam and the connection stamp (rows 1-13) ----------

test('1: a dropped connection and a rejected token both park the result', () => {
  const { Q } = load();
  assert.equal(Q.qualifies({ kind: 'network' }), true);
  assert.equal(Q.qualifies({ kind: 'auth' }), true);
});

test('2: a 404, a read-only project and no error at all keep their honest toast instead', () => {
  const { Q } = load();
  for (const e of [{ kind: 'notfound' }, { kind: 'readonly' }, undefined, null]) {
    assert.equal(Q.qualifies(e), false, `${JSON.stringify(e)} must not queue`);
  }
});

test('3: the queued reason normalises — auth stays auth, any other truthy value is network', async () => {
  const h = load();
  await enqueue(h, { recordId: 1, reason: 'auth' });
  await enqueue(h, { recordId: 2, reason: 'offline' });
  await enqueue(h, { recordId: 3, reason: '' });
  await enqueue(h, { recordId: 4 });
  await enqueue(h, { recordId: 5, reason: false });
  assert.equal(h.Q.reason(1), 'auth');
  assert.equal(h.Q.reason(2), 'network');
  assert.equal(h.Q.reason(3), null);
  assert.equal(h.Q.reason(4), null);
  assert.equal(h.Q.reason(5), null);
});

test('4: the forced-failure flag makes a real ApiError, so callers cannot tell it from the live one', async () => {
  const h = load({ session: { forceWriteFail: 'auth' } });
  await h.Q.init();
  const e = h.Q.forcedError();
  assert.ok(e instanceof h.ApiError);
  assert.ok(e instanceof Error);
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 403);
  assert.equal(e.message, 'forced offline (e2e)');

  const net = load({ session: { forceWriteFail: 'anything-else' } });
  await net.Q.init();
  assert.equal(net.Q.forcedError().kind, 'network');
  assert.equal(net.Q.forcedError().status, 0);
});

test('5: with no flag set the seam is inert', async () => {
  const h = load();
  await h.Q.init();
  assert.equal(h.Q.forcedError(), null);
  assert.equal(h.store.ops('session', 'get').length, 1); // it was read, and it answered nothing
});

test('6: a storage.session change keeps the flag live without a second storage read', async () => {
  const h = load();
  await h.Q.init();
  const reads = h.store.ops('session', 'get').length;

  h.store.fireSessionChange({ forceWriteFail: { newValue: 'network' } });
  assert.equal(h.Q.forcedError().kind, 'network');
  assert.equal(h.store.ops('session', 'get').length, reads);

  h.store.fireSessionChange({ forceWriteFail: { newValue: undefined } });
  assert.equal(h.Q.forcedError(), null);
  assert.equal(h.store.ops('session', 'get').length, reads);
});

test('7: an entry carries the connection it was written on', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io/projects/x', projectId: 'p1' }, now: 1700 });
  await h.Q.enqueue({ recordId: 5, runId: 'r1', status: 'failed', comment: 'flaky' });
  assert.deepEqual(h.stored(), {
    5: {
      recordId: 5, runId: 'r1', status: 'failed', comment: 'flaky',
      queuedAt: 1700, reason: null, envMeta: null, host: 'a.io', projectId: 'p1',
    },
  });
});

test('8: a second click on the same row replaces the first — one entry, the later status', async () => {
  const h = load();
  await enqueue(h, { recordId: 5, status: 'failed', queuedAt: 10 });
  await enqueue(h, { recordId: 5, status: 'passed', queuedAt: 20 });
  assert.equal(h.Q.count(), 1);
  assert.equal(h.stored()[5].status, 'passed');
  assert.equal(h.stored()[5].queuedAt, 20);
});

test('9: an enqueue with no stamp takes Date.now(); one that brings a stamp keeps it', async () => {
  const h = load({ now: 1_700_000_000_000 });
  await enqueue(h, { recordId: 5 });
  await enqueue(h, { recordId: 6, queuedAt: 42 });
  assert.equal(h.stored()[5].queuedAt, 1_700_000_000_000);
  assert.equal(h.stored()[6].queuedAt, 42);
});

test('10: a missing comment is stored as empty text, a real one verbatim', async () => {
  const h = load();
  await enqueue(h, { recordId: 5, comment: undefined });
  await enqueue(h, { recordId: 6, comment: 'saw a 500' });
  assert.equal(h.stored()[5].comment, '');
  assert.equal(h.stored()[6].comment, 'saw a 500');
});

test('11: an entry from an older build carries no stamp and still counts as this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({}), true);
  assert.equal(h.fn.queueEntryActive({ host: 'a.io', projectId: 'p1' }), true);
});

test('12: an entry written on another instance is not this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({ host: 'b.io', projectId: 'p1' }), false);
});

test('13: an entry written on another project is not this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({ host: 'a.io', projectId: 'p2' }), false);
});

// ---------- the store (rows 14-16) ----------

test('14: the count is the whole queue; the active count is the share this connection can sync', async () => {
  const h = load();
  await enqueue(h, { recordId: 1 });
  await enqueue(h, { recordId: 2 });
  h.state.settings = { ...ELSEWHERE };
  await enqueue(h, { recordId: 3 });
  h.state.settings = { ...HERE };
  assert.equal(h.Q.count(), 3);
  assert.equal(h.fn.queueCountActive(), 2);
});

test('15: removing an id that is not queued answers false and writes nothing', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  h.store.clear();

  assert.equal(await h.Q.remove('nope'), false);
  assert.equal(h.store.ops('local', 'set').length, 0);

  // The same call for an id that IS queued both answers true and persists — without this half the
  // assertion above would pass against a store that never writes at all.
  assert.equal(await h.Q.remove(5), true);
  assert.equal(h.store.ops('local', 'set').length, 1);
  assert.deepEqual(h.stored(), {});
});

test('16: a storage write that rejects is swallowed, and the in-memory queue still changed', async () => {
  const h = load();
  h.store.fails.set = new Error('QUOTA_BYTES exceeded');

  await enqueue(h, { recordId: 5, status: 'failed' }); // must not throw
  assert.equal(h.Q.has(5), true);
  assert.equal(h.stored(), undefined); // nothing reached storage

  h.store.fails.set = null;
  await enqueue(h, { recordId: 6, status: 'failed' });
  assert.deepEqual(Object.keys(h.stored()), ['5', '6']);
});

// ---------- the drain (rows 17-22) ----------

test('17: the drain replays oldest click first, whatever order the entries were made in', async () => {
  const h = load({ rows: ['a', 'b', 'c'] });
  await enqueue(h, { recordId: 'c', queuedAt: 3 });
  await enqueue(h, { recordId: 'a', queuedAt: 1 });
  await enqueue(h, { recordId: 'b', queuedAt: 2 });

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['a', 'b', 'c']);
  assert.deepEqual(h.repaints, ['a', 'b', 'c']); // each row loses its badge as its write lands
  assert.equal(h.Q.count(), 0);
  assert.equal(h.writes[0].opts.noQueue, true); // a replay that fails must not re-queue itself
  assert.equal(h.writes[0].opts.replay, true); // …and it writes no fresh environment either (#107)
});

test('18: a foreign entry is not thrown at this connection, and its run is not resolved here either', async () => {
  // The foreign run id would hit a DIFFERENT run of the same number in this project — one that is
  // finished, so an unfiltered drain would drop a result the other instance still owes.
  const h = load({ getRun: async (id) => (id === 'r-foreign' ? { status: 'finished' } : null) });
  await enqueue(h, { recordId: 'mine', runId: 'r-mine' });
  h.state.settings = { ...ELSEWHERE };
  await enqueue(h, { recordId: 'theirs', runId: 'r-foreign' });
  h.state.settings = { ...HERE };

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['mine']);
  assert.deepEqual(h.apiCalls, [['getRun', 'r-mine'], ['getRunInfo', 'r-mine']]);
  assert.equal(h.Q.has('theirs'), true);
  assert.equal(h.Q.count(), 1);
  assert.deepEqual(h.toasts, []);
});

test('19: a still-offline failure stops the pass and keeps every entry, with no toast', async () => {
  const h = load({ write: async () => { throw err('network', 'offline'); } });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i, queuedAt: i });

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']); // it broke, it did not carry on
  assert.equal(h.Q.count(), 3);
  assert.deepEqual(h.toasts, []);
});

test('20: a read-only account keeps the entry too — a role change can still land it', async () => {
  const h = load({ write: async () => { throw err('readonly', 'read-only'); } });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i, queuedAt: i });

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 3);
  assert.deepEqual(h.toasts, []);
});

test('21: a permanent failure drops that one entry, says so once, and the pass carries on', async () => {
  const h = load({
    write: async (rec) => { if (String(rec.id) === '1') throw err('notfound', 'Not found'); },
  });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i, queuedAt: i });

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1', '2', '3']);
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, [
    { msg: "A queued status couldn't be saved and was dropped: Not found", error: true },
  ]);
});

test('22: a newer click that lands mid-drain is kept, not removed by the older write', async () => {
  let h;
  let replaced = false;
  h = load({
    write: async (rec) => {
      if (String(rec.id) !== '5' || replaced) return;
      replaced = true;
      await enqueue(h, { recordId: 5, status: 'failed', queuedAt: 99 });
    },
  });
  await enqueue(h, { recordId: 5, status: 'passed', queuedAt: 10 });

  await h.Q.replay();
  assert.equal(h.Q.has(5), true);
  assert.equal(h.stored()[5].status, 'failed');
  assert.equal(h.stored()[5].queuedAt, 99);

  // Without the replacement the same drive removes the entry, so the row above is not asserting
  // that the drain simply never removes anything.
  const plainRun = load();
  await enqueue(plainRun, { recordId: 5, status: 'passed', queuedAt: 10 });
  await plainRun.Q.replay();
  assert.equal(plainRun.Q.has(5), false);
});

// ---------- the lock resolution (rows 23-30) ----------

test('23: entries for a finished run are dropped before any write, with one sentence saying so', async () => {
  const h = load({ getRun: async () => ({ status: 'finished' }) });
  await enqueue(h, { recordId: 1, runId: 'r7', queuedAt: 1 });
  await enqueue(h, { recordId: 2, runId: 'r7', queuedAt: 2 });

  await h.Q.replay();
  assert.deepEqual(h.writes, []); // row 28 is the same drive with the run unresolved, and it writes
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, [
    { msg: 'Run finished — 2 queued results were not written', error: true },
  ]);
});

test('24: one dropped result is one result, not one results', async () => {
  const h = load({ getRun: async () => ({ status: 'passed' }) });
  await enqueue(h, { recordId: 1, runId: 'r7' });

  await h.Q.replay();
  assert.deepEqual(h.toasts, [
    { msg: 'Run finished — 1 queued result was not written', error: true },
  ]);
});

test('25: two reasons at once are one toast — a second one would replace the first in the DOM', async () => {
  const h = load({ getRun: async (id) => (id === 'rf' ? { status: 'finished' } : { kind: 'automated' }) });
  await enqueue(h, { recordId: 1, runId: 'rf', queuedAt: 1 });
  await enqueue(h, { recordId: 2, runId: 'ra', queuedAt: 2 });

  await h.Q.replay();
  assert.deepEqual(h.toasts, [{
    msg: 'Run finished — 1 queued result was not written'
      + ' · Automated run — 1 queued result was not written',
    error: true,
  }]);
});

test('26: archived outranks the run status it arrives with', async () => {
  const running = load({
    getRun: async () => ({ status: 'running' }),
    getRunInfo: async () => ({ isArchived: true }),
  });
  await enqueue(running, { recordId: 1, runId: 'r7' });
  await running.Q.replay();
  assert.deepEqual(running.writes, []);
  assert.deepEqual(running.toasts, [
    { msg: 'Run archived — 1 queued result was not written', error: true },
  ]);

  // The outranking itself: a run that is BOTH finished and automated still reads as archived.
  const both = load({
    getRun: async () => ({ status: 'finished', kind: 'automated' }),
    getRunInfo: async () => ({ isArchived: true }),
  });
  await enqueue(both, { recordId: 1, runId: 'r7' });
  await both.Q.replay();
  assert.deepEqual(both.toasts, [
    { msg: 'Run archived — 1 queued result was not written', error: true },
  ]);
});

test('27: in basic mode archived runs are invisible — the second endpoint is never asked', async () => {
  const blind = load({
    jwt: false,
    getRun: async () => ({ status: 'running' }),
    getRunInfo: async () => ({ isArchived: true }),
  });
  await enqueue(blind, { recordId: 1, runId: 'r7' });
  await blind.Q.replay();
  assert.equal(blind.countOf('getRunInfo'), 0);
  assert.deepEqual(blind.writes.map((w) => w.id), ['1']); // unseen, so it replayed

  const seeing = load({
    jwt: true,
    getRun: async () => ({ status: 'running' }),
    getRunInfo: async () => ({ isArchived: true }),
  });
  await enqueue(seeing, { recordId: 1, runId: 'r7' });
  await seeing.Q.replay();
  assert.equal(seeing.countOf('getRunInfo'), 1);
  assert.deepEqual(seeing.writes, []);
});

test('28: a run whose state cannot be read is replayed as before, not dropped', async () => {
  const h = load({ getRun: async () => { throw err('network', 'offline'); } });
  await enqueue(h, { recordId: 1, runId: 'r7' });

  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, []);
});

test('29: the run kind is compared in lower case, and the sentence is «Automated run»', async () => {
  const h = load({ getRun: async () => ({ status: 'running', kind: 'AUTOMATED' }) });
  await enqueue(h, { recordId: 1, runId: 'r7' });

  await h.Q.replay();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.toasts, [
    { msg: 'Automated run — 1 queued result was not written', error: true },
  ]);
});

test('30: three entries for one run resolve that run once', async () => {
  const h = load({ getRun: async () => ({ status: 'running' }) });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i, runId: 'r7', queuedAt: i });

  await h.Q.replay();
  assert.equal(h.countOf('getRun'), 1);
  assert.equal(h.writes.length, 3);
});

// ---------- retry, coalescing and the banner (rows 31-42) ----------

test('31: a locked project takes no write and keeps its queue', async () => {
  const h = load({ readonly: true });
  await enqueue(h, { recordId: 1 });

  await h.Q.replay();
  assert.deepEqual(h.writes, []);
  assert.equal(h.Q.count(), 1);

  h.capabilities.readonly = false;
  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 0);
});

test('32: an empty queue returns before the lock is taken, so nothing repaints and nothing wedges', async () => {
  const h = load();
  const before = h.calls.$;
  await h.Q.replay();
  assert.equal(h.calls.$, before); // the finally never ran, so neither did refreshQueueUI

  await enqueue(h, { recordId: 1 });
  const mid = h.calls.$;
  await h.Q.replay();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']); // the early return left no lock behind
  assert.ok(h.calls.$ > mid);
});

test('33: a trigger arriving mid-drain is honoured by exactly one more pass', async () => {
  let h;
  h = load({ write: async () => { await h.Q.replay(); throw err('network', 'offline'); } });
  await enqueue(h, { recordId: 1 });

  await h.Q.replay();
  assert.equal(h.writes.length, 2); // the drain, plus the ONE coalesced re-run
  assert.equal(h.Q.count(), 1);
});

test('34: a third and a fourth trigger in the same drain still buy one extra pass, not a storm', async () => {
  let h;
  h = load({
    write: async () => {
      await h.Q.replay();
      await h.Q.replay();
      await h.Q.replay();
      throw err('network', 'offline');
    },
  });
  await enqueue(h, { recordId: 1 });

  await h.Q.replay();
  assert.equal(h.writes.length, 2);
});

test('35: Retry pressed during the first pass is promised the pass that follows', async () => {
  let h;
  let n = 0;
  h = load({
    write: async () => {
      n += 1;
      if (n === 1) fire(h.retry, 'click'); // through the listener queueInit registered itself
      throw err('network', 'offline');
    },
  });
  await h.Q.init();
  await enqueue(h, { recordId: 1 });

  await h.Q.replay();
  assert.deepEqual(h.toasts.map((t) => t.msg), ['Already syncing — your Retry runs right after']);
  assert.equal(h.writes.length, 2);
});

test('36: Retry pressed during the last pass is told to wait — there is no further pass to promise', async () => {
  let h;
  let n = 0;
  h = load({
    write: async () => {
      n += 1;
      if (n === 1) await h.Q.replay(); // a silent trigger buys the second pass
      if (n === 2) fire(h.retry, 'click');
      throw err('network', 'offline');
    },
  });
  await h.Q.init();
  await enqueue(h, { recordId: 1 });

  await h.Q.replay();
  assert.deepEqual(h.toasts.map((t) => t.msg), ['Still syncing — give it a moment and try again']);
  assert.equal(h.writes.length, 2);
});

test('37: a drain that throws still clears the lock and repaints', async () => {
  const h = load({ getRun: async () => ({ status: 'finished' }) });
  await enqueue(h, { recordId: 1, runId: 'r7' });
  const good = h.sandbox.toast;
  h.sandbox.toast = () => { throw new Error('toast blew up'); };
  h.banner.hidden = 'untouched';

  await assert.rejects(() => h.Q.replay(), /toast blew up/);
  assert.equal(h.banner.hidden, true); // refreshQueueUI ran in the finally

  // The lock is clear: the next trigger really drains rather than reporting a sync in flight.
  h.sandbox.toast = good;
  await enqueue(h, { recordId: 2, runId: null });
  await h.Q.replay({ user: true });
  assert.deepEqual(h.writes.map((w) => w.id), ['2']);
  assert.deepEqual(h.toasts, []);
});

test('38: one pending change on a run view', async () => {
  const h = load({ view: 'run' });
  await enqueue(h, { recordId: 1 });
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);
  assert.equal(h.bannerText.textContent, '1 change pending');
});

test('39: three pending changes', async () => {
  const h = load({ view: 'run' });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i });
  h.Q.refreshUI();
  assert.equal(h.bannerText.textContent, '3 changes pending');
});

test('40: a change for another connection gets its own clause, not an inflated count', async () => {
  const h = load({ view: 'runs' });
  h.state.settings = { ...ELSEWHERE };
  await enqueue(h, { recordId: 1 });
  h.state.settings = { ...HERE };
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);
  assert.equal(h.bannerText.textContent, '1 change waiting for another project or instance');
});

test('41: both clauses, joined', async () => {
  const h = load({ view: 'test' });
  for (const i of [1, 2]) await enqueue(h, { recordId: i });
  h.state.settings = { ...ELSEWHERE };
  for (const i of [3, 4, 5]) await enqueue(h, { recordId: i });
  h.state.settings = { ...HERE };
  h.Q.refreshUI();
  assert.equal(
    h.bannerText.textContent,
    '2 changes pending · 3 changes waiting for another project or instance',
  );
});

test('42: settings is not a view the banner belongs on, whatever is waiting', async () => {
  const h = load({ view: 'run' });
  for (const i of [1, 2]) await enqueue(h, { recordId: i });
  h.state.settings = { ...ELSEWHERE };
  for (const i of [3, 4, 5]) await enqueue(h, { recordId: i });
  h.state.settings = { ...HERE };

  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);

  h.state.view = 'settings';
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, true);
});

// ---------- the row markers (rows 43-50) ----------

const row = (...kids) => el('li', { className: 'test-row', dataset: { recordId: '5' } }, ...kids);

test('43: a one-line row with no .meta hosts the mark itself, and only the queued row wears one', async () => {
  // Driven by the refresh the enqueue itself runs, over the real #run-tests list.
  const h = load({ rows: [5, 6] });
  await enqueue(h, { recordId: 5 });

  const [five, six] = h.list.children;
  const mark = five.querySelector('.queued-mark');
  assert.ok(mark);
  assert.equal(mark.tagName, 'SPAN');
  assert.equal(mark.className, 'badge outline queued-mark');
  assert.equal(mark.textContent, 'queued');
  assert.equal(mark.parentElement, five);
  assert.equal(five.childNodes.at(-1), mark); // appended, because there is no actions cell
  assert.equal(six.querySelector('.queued-mark'), null);
});

test('44: a row that still has its .meta puts the mark inside it', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const meta = el('span', { className: 'meta' });
  const li = row(el('span', { className: 'title' }), meta);

  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelector('.queued-mark').parentElement, meta);
});

test('45: decorating twice leaves one mark', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const li = row();

  h.Q.decorateRow(li, 5);
  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelectorAll('.queued-mark').length, 1);
});

test('46: once the entry is gone the mark goes with it', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const li = row();
  h.Q.decorateRow(li, 5);
  assert.ok(li.querySelector('.queued-mark'));

  await h.Q.remove(5);
  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelector('.queued-mark'), null);
});

test('47: the mark goes in front of the row actions, never after them', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const actions = el('span', { className: 'row-actions' });
  const li = row(el('span', { className: 'title' }), actions);

  h.Q.decorateRow(li, 5);
  const mark = li.querySelector('.queued-mark');
  assert.equal(mark.nextElementSibling, actions);
  assert.equal(mark.previousElementSibling.className, 'title');
});

test('48: a row that is not on screen is not an error', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  assert.doesNotThrow(() => h.Q.decorateRow(null, 5));
});

test('49: the open test shows its queued badge, with the wording its reason earned', async () => {
  const h = load({ view: 'test', currentRecordId: 5 });
  await enqueue(h, { recordId: 5, reason: 'network' });
  h.Q.updateTestMarker();
  assert.equal(h.testQueued.hidden, false);
  assert.equal(h.tips.at(-1).tip, OFFLINE_TIP);

  await enqueue(h, { recordId: 5, reason: 'auth' });
  h.Q.updateTestMarker();
  assert.equal(h.tips.at(-1).tip, AUTH_TIP);
});

test('50: a badge queued for another record leaves the open one alone', async () => {
  const h = load({ view: 'test', currentRecordId: 5 });
  await enqueue(h, { recordId: 6 });
  h.Q.updateTestMarker();
  assert.equal(h.testQueued.hidden, true);
});

// ---------- boot, and the whole cycle (rows 51-54) ----------

test('51a: a corrupt string in storage boots an empty queue', async () => {
  const h = load({ local: { offlineQueue: 'garbage' } });
  await h.Q.init();
  assert.equal(h.Q.count(), 0);

  const good = load({ local: { offlineQueue: { 5: { recordId: 5, status: 'passed', queuedAt: 1 } } } });
  await good.Q.init();
  assert.equal(good.Q.count(), 1);
  assert.equal(good.Q.has(5), true);
});

test('51b: an ARRAY passes the object gate, and its indexes become the record keys', async () => {
  const h = load({
    local: { offlineQueue: [{ recordId: 'a', status: 'passed', queuedAt: 1 }, { recordId: 'b', status: 'passed', queuedAt: 2 }] },
    view: 'run',
  });
  await h.Q.init();
  assert.equal(h.Q.count(), 2);
  assert.equal(h.Q.has(0), true);  // the array index, not the recordId
  assert.equal(h.Q.has('a'), false);
  assert.equal(h.bannerText.textContent, '2 changes pending');
});

test('52: storage that will not answer boots an empty queue rather than throwing', async () => {
  const h = load({ local: { offlineQueue: { 5: { recordId: 5, status: 'passed', queuedAt: 1 } } } });
  h.store.fails.get = new Error('storage unavailable');
  await h.Q.init(); // must not throw
  assert.equal(h.Q.count(), 0);

  // The same seed without the failure does load, so the row above is not asserting a store that
  // never answers anything.
  h.store.fails.get = null;
  await h.Q.init();
  assert.equal(h.Q.count(), 1);
});

test('53: an older Chrome with no session onChanged still finishes init and still wires online', async () => {
  const h = load({ sessionOnChanged: false });
  await h.Q.init(); // must not throw
  assert.deepEqual(h.window.typesOf(), ['online']);
  assert.equal(h.store.sessionListeners.length, 0);

  await enqueue(h, { recordId: 1 });
  h.window.fire('online');
  await settle();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 0);
});

test('54: the forced-failure cycle — queue while it fails, and a later success clears its own entry', async () => {
  const server = {};
  let h;
  // core/write-status.js's writeStatus, cut to the three lines this cycle turns on.
  const mark = async (recordId, status) => {
    try {
      const forced = h.Q.forcedError();
      if (forced) throw forced;
      server[recordId] = status;
    } catch (e) {
      if (!h.Q.qualifies(e)) throw e;
      await h.Q.enqueue({
        recordId, runId: 'r1', status, queuedAt: Date.now(), reason: e.kind === 'auth' ? 'auth' : 'network',
      });
      return;
    }
    await h.Q.remove(recordId); // this status supersedes anything queued for the row
  };

  h = load({
    session: { forceWriteFail: 'auth' },
    write: async (rec, status) => { server[rec.id] = status; },
  });
  await h.Q.init();

  await mark(5, 'failed');
  assert.equal(h.Q.has(5), true);
  assert.equal(h.Q.reason(5), 'auth');
  assert.equal(server[5], undefined);

  h.store.fireSessionChange({ forceWriteFail: { newValue: undefined } });
  await mark(5, 'passed');
  assert.equal(server[5], 'passed');
  assert.equal(h.Q.count(), 0);

  await h.Q.replay();
  assert.deepEqual(h.writes, []); // nothing left, so the old «failed» cannot land on top
  assert.equal(server[5], 'passed');
  assert.equal(h.Q.count(), 0);
});

// ---------- the environment snapshot and the log it cannot park (rows 55-58) ----------

// #107: what the entry carries is what the replay writes. Collecting the environment at drain time
// described the tab the tester happened to be on hours later, and the log attached beside it was
// the recorder's window on some other page — a developer triaging the result went to the wrong page.

test('55 (#107): an entry keeps the environment it was marked in, and the drain hands it back', async () => {
  const h = load();
  const env = [['URL', 'https://shop.example/cart'], ['Viewport', '1280×720']];
  await h.Q.enqueue({ recordId: 5, runId: 'r1', status: 'failed', comment: 'card declined', envMeta: env });
  assert.deepEqual(h.stored()[5].envMeta, env); // parked, so a panel reload still has it

  await h.Q.replay();
  assert.deepEqual(h.writes[0].opts.envMeta, env);
  assert.equal(h.writes[0].opts.replay, true); // core/write-status.js writes THAT instead of collecting
});

test('56 (#107): an entry from an older build carries no snapshot, and the drain invents none', async () => {
  const h = load();
  // Straight into storage the way an older build left it — no envMeta key at all.
  const h2 = load({ local: { offlineQueue: { 5: { recordId: 5, runId: 'r1', status: 'failed', comment: '', queuedAt: 1 } } } });
  await h2.Q.init();
  await h2.Q.replay();
  assert.deepEqual([...h2.writes[0].opts.envMeta], []); // empty, so write-status writes no meta at all
  assert.equal(h2.writes[0].opts.replay, true);

  // A non-array from anywhere else is stored as «none» rather than passed on as it is.
  await h.Q.enqueue({ recordId: 6, status: 'failed', envMeta: 'not a list' });
  assert.equal(h.stored()[6].envMeta, null);
});

test('57 (#107): a synced FAIL says once that it carries no log; a synced PASS says nothing', async () => {
  const one = load();
  await enqueue(one, { recordId: 1, status: 'failed', queuedAt: 1 });
  await one.Q.replay();
  assert.deepEqual(one.toasts, [
    { msg: '1 synced result has no console & network log — it is not kept offline', error: false },
  ]);

  const many = load();
  for (const i of [1, 2]) await enqueue(many, { recordId: i, status: 'failed', queuedAt: i });
  await enqueue(many, { recordId: 3, status: 'passed', queuedAt: 3 });
  await many.Q.replay();
  assert.deepEqual(many.toasts, [
    { msg: '2 synced results have no console & network log — it is not kept offline', error: false },
  ]);

  // Nothing failed, so there is no missing attachment to explain.
  const passing = load();
  await enqueue(passing, { recordId: 1, status: 'passed' });
  await passing.Q.replay();
  assert.deepEqual(passing.toasts, []);
});

test('58 (#107): the log clause joins the drop clauses in ONE toast, and only lands writes count', async () => {
  const h = load({
    getRun: async (id) => (id === 'rf' ? { status: 'finished' } : null),
    write: async (rec) => { if (String(rec.id) === '2') throw err('notfound', 'Not found'); },
  });
  await enqueue(h, { recordId: 1, runId: 'rf', status: 'failed', queuedAt: 1 }); // dropped, never written
  await enqueue(h, { recordId: 2, runId: 'r1', status: 'failed', queuedAt: 2 }); // permanent failure
  await enqueue(h, { recordId: 3, runId: 'r1', status: 'failed', queuedAt: 3 }); // the only one that lands

  await h.Q.replay();
  assert.deepEqual(h.toasts, [{
    msg: 'Run finished — 1 queued result was not written'
      + " · A queued status couldn't be saved and was dropped: Not found"
      + ' · 1 synced result has no console & network log — it is not kept offline',
    error: true,
  }]);

  // A pass that never got to write says nothing at all — the entries are all still queued.
  const offline = load({ write: async () => { throw err('network', 'offline'); } });
  await enqueue(offline, { recordId: 1, status: 'failed' });
  await offline.Q.replay();
  assert.deepEqual(offline.toasts, []);
  assert.equal(offline.Q.count(), 1);
});

// ---------- the queued list, retried and discarded one row at a time (rows 59-76) ----------

// #108: the banner said «3 changes pending» and nothing more — not which three, not whose run, not how
// long they had waited. Worse, its one Retry walks a FIFO that STOPS on the first still-offline entry,
// so the results behind the block could never be tried at all. The fold below is that list, and each
// row goes through the same single-entry write the pass uses, on its own.

const NOW = 1_700_000_000_000;
const AGO = (ms) => NOW - ms;

// enqueue() stamps queuedAt, host and project itself, and these rows are ABOUT those three — so the
// queue is seeded the way a previous panel session left it in storage instead.
const seed = (...entries) => ({
  offlineQueue: Object.fromEntries(entries.map((e) => [String(e.recordId), {
    runId: 'r1', status: 'passed', comment: '', queuedAt: AGO(60_000), reason: null, envMeta: null,
    host: 'a.io', projectId: 'p1', ...e,
  }])),
});

// The fold is wired by queueInit, the way the panel wires it.
async function booted(opts = {}) {
  const h = load({ now: NOW, ...opts });
  await h.Q.init();
  return h;
}

const rowsOf = (h) => h.queueList.children;
const idsOf = (h) => rowsOf(h).map((li) => li.dataset.recordId);
const openFold = (h) => fire(h.toggle, 'click');
const cellText = (li, cls) => li.querySelector(`.${cls}`)?.textContent ?? null;
const rowBtn = (h, i, what) => rowsOf(h)[i].querySelector(`.pending-row-${what}`);

test('59 (#108): the fold starts shut and opens one row per queued entry, oldest click first', async () => {
  const h = await booted({
    local: seed({ recordId: 2, queuedAt: AGO(30 * 60_000) }, { recordId: 1, queuedAt: AGO(90 * 60_000) }),
  });
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.queueList.hidden, true);
  assert.equal(rowsOf(h).length, 0);

  openFold(h);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.queueList.hidden, false);
  assert.deepEqual(idsOf(h), ['1', '2']);
});

test('60 (#108): a row names the test it belongs to, and a result from another run by its id', async () => {
  const h = await booted({ rows: [5], local: seed({ recordId: 5, queuedAt: AGO(120_000) }, { recordId: 9 }) });
  openFold(h);
  assert.deepEqual(rowsOf(h).map((li) => cellText(li, 'pending-row-title')), ['test 5', 'Result 9']);
});

test('61 (#108): a row carries the status that is waiting and the age its queuedAt earned', async () => {
  const h = await booted({
    local: seed(
      { recordId: 1, status: 'failed', queuedAt: AGO(20_000) },
      { recordId: 2, status: 'passed', queuedAt: AGO(5 * 60_000) },
      { recordId: 3, status: 'skipped', queuedAt: AGO(3 * 3_600_000) },
      { recordId: 4, status: 'passed', queuedAt: AGO(50 * 3_600_000) },
    ),
  });
  openFold(h);
  assert.deepEqual(
    rowsOf(h).map((li) => [cellText(li, 'pending-row-status'), cellText(li, 'pending-row-age')]),
    [['passed', '2d ago'], ['skipped', '3h ago'], ['passed', '5m ago'], ['failed', 'just now']],
  );
  // The status wears the panel's own mark, so the list reads like every other row in it.
  assert.equal(rowsOf(h)[3].querySelector('.pending-row-status').className, 'badge failed pending-row-status');
});

test('62 (#108): an entry for another project or instance says which, and its Retry is not offered', async () => {
  const h = await booted({
    local: seed(
      { recordId: 1, queuedAt: AGO(3 * 60_000) },
      { recordId: 2, projectId: 'p9', queuedAt: AGO(2 * 60_000) },
      { recordId: 3, host: 'b.io', queuedAt: AGO(60_000) },
    ),
  });
  openFold(h);
  assert.deepEqual(
    rowsOf(h).map((li) => cellText(li, 'pending-row-where')),
    [null, 'other project', 'other instance'],
  );
  assert.deepEqual(rowsOf(h).map((li) => li.querySelector('.pending-row-retry').disabled), [false, true, true]);
  // …and the way out stays open: a foreign entry is exactly the one a tester wants to drop.
  assert.deepEqual(rowsOf(h).map((li) => li.querySelector('.pending-row-discard').disabled), [false, false, false]);
});

test('63 (#108): shutting the fold empties it, so no stale row waits behind a closed list', async () => {
  const h = await booted({ local: seed({ recordId: 1 }) });
  openFold(h);
  assert.equal(rowsOf(h).length, 1);

  openFold(h);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.queueList.hidden, true);
  assert.equal(rowsOf(h).length, 0);
});

test('64 (#108): the queue emptying shuts the fold instead of leaving an empty list open', async () => {
  const h = await booted({ local: seed({ recordId: 1 }) });
  openFold(h);

  await h.Q.replay();
  assert.equal(h.Q.count(), 0);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.toggle.hidden, true); // nothing to unfold, so nothing invites the click
  assert.equal(h.queueList.hidden, true);
  assert.equal(rowsOf(h).length, 0);
});

test('65 (#108): a row Retry writes THAT entry, with a still-offline one ahead of it in the queue', async () => {
  const h = await booted({
    local: seed({ recordId: 1, queuedAt: AGO(9 * 60_000) }, { recordId: 2, queuedAt: AGO(60_000) }),
    write: async (rec) => { if (String(rec.id) === '1') throw err('network', 'offline'); },
  });
  // The complaint itself: the whole-queue Retry stops on 1, and 2 never gets a turn.
  await h.Q.replay({ user: true });
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 2);

  openFold(h);
  fire(rowBtn(h, 1, 'retry'), 'click');
  await settle();
  assert.deepEqual(h.writes.map((w) => w.id), ['1', '2']);
  assert.equal(h.Q.has(2), false);
  assert.equal(h.Q.has(1), true); // the entry that blocks the pass is untouched, not dropped with it
  assert.deepEqual(idsOf(h), ['1']);
});

test('66 (#108): a row Retry that is still offline keeps the result and says so', async () => {
  const h = await booted({ local: seed({ recordId: 1 }), write: async () => { throw err('network', 'offline'); } });
  openFold(h);
  fire(rowBtn(h, 0, 'retry'), 'click');
  await settle();
  assert.equal(h.Q.has(1), true);
  assert.deepEqual(h.toasts, [{ msg: 'Still offline — the result stays queued', error: true }]);

  // A rejected token is not a dropped connection, and the row says the other sentence (#106).
  const auth = await booted({ local: seed({ recordId: 1 }), write: async () => { throw err('auth', '403'); } });
  openFold(auth);
  fire(rowBtn(auth, 0, 'retry'), 'click');
  await settle();
  assert.equal(auth.Q.has(1), true);
  assert.deepEqual(auth.toasts, [{
    msg: 'The token was rejected — authorize again in Settings; the result stays queued', error: true,
  }]);
});

test('67 (#108): a row Retry that fails permanently drops that entry with the drain’s own sentence', async () => {
  const h = await booted({ local: seed({ recordId: 1 }), write: async () => { throw err('notfound', 'Not found'); } });
  openFold(h);
  fire(rowBtn(h, 0, 'retry'), 'click');
  await settle();
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, [
    { msg: "A queued status couldn't be saved and was dropped: Not found", error: true },
  ]);
});

test('68 (#108): a row Retry asks the run lock first — a finished run drops the entry, unwritten', async () => {
  const h = await booted({ local: seed({ recordId: 1, runId: 'r7' }), getRun: async () => ({ status: 'finished' }) });
  openFold(h);
  fire(rowBtn(h, 0, 'retry'), 'click');
  await settle();
  assert.deepEqual(h.writes, []);
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, [{ msg: 'Run finished — 1 queued result was not written', error: true }]);
});

test('69 (#108): a FAIL synced from its own row still says once that it carries no log', async () => {
  const h = await booted({ local: seed({ recordId: 1, status: 'failed' }) });
  openFold(h);
  fire(rowBtn(h, 0, 'retry'), 'click');
  await settle();
  assert.deepEqual(h.toasts, [{
    msg: '1 synced result has no console & network log — it is not kept offline', error: false,
  }]);

  // A PASS has nothing to say about a log it never wanted.
  const pass = await booted({ local: seed({ recordId: 1 }) });
  openFold(pass);
  fire(rowBtn(pass, 0, 'retry'), 'click');
  await settle();
  assert.deepEqual(pass.toasts, []);
});

test('70 (#108): Discard asks first — these are results the tester believes are saved', async () => {
  const h = await booted({ local: seed({ recordId: 1, status: 'failed' }), confirm: false });
  openFold(h);
  fire(rowBtn(h, 0, 'discard'), 'click');
  await settle();
  assert.equal(h.asks.length, 1);
  assert.match(h.asks[0].message, /^Discard Result 1\?/);
  assert.equal(h.asks[0].label, 'Discard');
  assert.equal(h.Q.has(1), true); // a cancel changes nothing
  assert.deepEqual(idsOf(h), ['1']);
});

test('71 (#108): a confirmed Discard drops that one entry and leaves the rest of the queue alone', async () => {
  const h = await booted({ local: seed({ recordId: 1, queuedAt: AGO(120_000) }, { recordId: 2 }) });
  openFold(h);
  fire(rowBtn(h, 0, 'discard'), 'click');
  await settle();
  assert.equal(h.Q.has(1), false);
  assert.equal(h.Q.has(2), true);
  assert.deepEqual(h.writes, []); // discarded, not sent
  assert.deepEqual(Object.keys(h.stored()), ['2']); // and gone from storage, not just from the list
  assert.deepEqual(idsOf(h), ['2']);
});

test('72 (#108): a row whose entry went away under the click neither writes nor throws', async () => {
  const h = await booted({ local: seed({ recordId: 1 }, { recordId: 2, queuedAt: AGO(30_000) }) });
  openFold(h);
  // The buttons the tester is looking at, held from BEFORE the entry behind them went away — a
  // fresher click, a livesync apply, a drain that got there first.
  const [stale] = rowsOf(h);
  await h.Q.remove(1);

  fire(stale.querySelector('.pending-row-retry'), 'click');
  fire(stale.querySelector('.pending-row-discard'), 'click');
  await settle();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.asks, []); // nothing to confirm about an entry that is already gone
  assert.equal(h.Q.count(), 1);
  assert.deepEqual(idsOf(h), ['2']); // both clicks repainted the list they found stale
});

test('73 (#108): a row Retry pressed mid-drain is coalesced like the banner’s, not run beside it', async () => {
  let h;
  h = load({
    now: NOW,
    local: seed({ recordId: 1 }),
    write: async () => {
      if (h.writes.length === 1) fire(rowBtn(h, 0, 'retry'), 'click');
      throw err('network', 'offline');
    },
  });
  await h.Q.init();
  openFold(h);

  await h.Q.replay();
  assert.equal(h.writes.length, 2); // the drain plus the ONE coalesced re-run, never a third
  assert.deepEqual(h.toasts, [{ msg: 'Already syncing — your Retry runs right after' }]);
});

test('74 (#108): a trigger landing during a row Retry still buys the whole-queue pass it was promised', async () => {
  let h;
  h = load({
    now: NOW,
    local: seed({ recordId: 1, queuedAt: AGO(120_000) }, { recordId: 2 }),
    write: async (rec) => { if (String(rec.id) === '2') await h.Q.replay({ user: true }); },
  });
  await h.Q.init();
  openFold(h);

  fire(rowBtn(h, 1, 'retry'), 'click');
  await settle();
  // The row first, on its own; the pass it promised then takes what is left.
  assert.deepEqual(h.writes.map((w) => w.id), ['2', '1']);
  assert.equal(h.Q.count(), 0);
  assert.deepEqual(h.toasts, [{ msg: 'Already syncing — your Retry runs right after' }]);
});

test('75 (#108): a locked project takes no row Retry either, and keeps the entry (#155)', async () => {
  const h = await booted({ local: seed({ recordId: 1 }), readonly: true });
  openFold(h);
  fire(rowBtn(h, 0, 'retry'), 'click');
  await settle();
  assert.deepEqual(h.writes, []);
  assert.equal(h.Q.has(1), true);

  // A 403 that arrives from the SERVER mid-write is the same idea, said out loud.
  const server = await booted({ local: seed({ recordId: 1 }), write: async () => { throw err('readonly', 'ro'); } });
  openFold(server);
  fire(rowBtn(server, 0, 'retry'), 'click');
  await settle();
  assert.equal(server.Q.has(1), true);
  assert.deepEqual(server.toasts, [{
    msg: 'Your access here is read-only — the result stays queued', error: true,
  }]);
});

test('76 (#108): an open fold repaints through refreshQueueUI, so a newer click shows at once', async () => {
  const h = await booted({ local: seed({ recordId: 1, queuedAt: AGO(2 * 3_600_000) }) });
  openFold(h);
  assert.deepEqual([cellText(rowsOf(h)[0], 'pending-row-status'), cellText(rowsOf(h)[0], 'pending-row-age')],
    ['passed', '2h ago']);

  await enqueue(h, { recordId: 1, status: 'failed', queuedAt: AGO(10_000) });
  assert.equal(rowsOf(h).length, 1); // replaced, not appended — one entry per record id
  assert.deepEqual([cellText(rowsOf(h)[0], 'pending-row-status'), cellText(rowsOf(h)[0], 'pending-row-age')],
    ['failed', 'just now']);
});
