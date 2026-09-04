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
// screens/run-view.js's own set — the drain asks it whether a run is closed.
const TERMINAL = new Set(['passed', 'failed', 'terminated', 'finished']);

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
    ...opts,
  };

  // index.html's shape, cut to what this screen touches: the banner, its Retry, the open-test badge
  // and the run list refreshQueueUI walks.
  const doc = makeDocument([]);
  const bannerText = el('span', { className: 'pending-banner-text' });
  const banner = el('div', { id: 'pending-banner', hidden: true }, bannerText);
  const retry = el('button', { id: 'pending-banner-retry' });
  const testQueued = el('span', { id: 'test-queued', hidden: true });
  // One line and no `.meta`, the shape rows took upstream — the row itself hosts the mark.
  const list = el('ul', { id: 'run-tests' }, ...o.rows.map((id) => el('li', {
    className: 'test-row', dataset: { recordId: String(id) },
  }, el('span', { className: 'title' }, `test ${id}`))));
  doc.body.append(banner, retry, testQueued, list);

  const toasts = [];
  const writes = [];
  const repaints = [];
  const tips = [];
  const apiCalls = [];
  const calls = { $: 0 };
  const state = { settings: o.settings, view: o.view, currentRecordId: o.currentRecordId, runId: 'r1' };
  const capabilities = { jwt: o.jwt, readonly: o.readonly };
  const records = new Map(o.rows.map((id) => [String(id), { id }]));

  const globals = {
    state,
    capabilities,
    hasChrome: o.hasChrome,
    hostOf,
    isReadonlyError: (e) => !!e && e.kind === 'readonly',
    runStatusTerminal: (s) => TERMINAL.has(String(s || '').toLowerCase()),
    recordFor: (id) => records.get(String(id)) || null,
    runRowEl: (id) => doc.querySelector(`#run-tests li.test-row[data-record-id="${id}"]`),
    repaintRow: (li, r) => { repaints.push(String(r.id)); },
    toast: (msg, tOpts) => { toasts.push({ msg, ...(tOpts || {}) }); },
    // refreshQueueUI runs on every enqueue and every removal, so this one has to stay cheap.
    $: (id) => { calls.$ += 1; return doc.getElementById(id); },
    Tooltip: { set: (node, tip) => { tips.push({ node, tip }); } },
    writeStatus: async (record, status, comment, onOptimistic, wOpts) => {
      writes.push({ id: String(record.id), status, comment, opts: { ...wOpts } });
      return o.write(record, status, comment, onOptimistic, wOpts);
    },
    TestomatAPI: {
      getRun: async (id) => { apiCalls.push(['getRun', String(id)]); return o.getRun(String(id)); },
      getRunInfo: async (id) => { apiCalls.push(['getRunInfo', String(id)]); return o.getRunInfo(String(id)); },
    },
  };

  const h = loadScreen('offline-queue', {
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
    banner, bannerText, retry, testQueued, list,
    toasts, writes, repaints, tips, apiCalls, calls, state, capabilities,
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
      queuedAt: 1700, reason: null, host: 'a.io', projectId: 'p1',
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
  // screens/test-view.js's writeStatus, cut to the three lines this cycle turns on.
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
