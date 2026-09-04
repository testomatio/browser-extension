#!/usr/bin/env node
// extension/sidepanel/core/write-status.js — the one place "the tester marked this test" becomes a
// request. Rows 76-87 of #164, moved here when the core left screens/test-view.js (#197).
//
// Three surfaces call it and each would otherwise be asserting the same thing through its own
// screen: the test view's verdict buttons, the run list's inline rows and the offline queue's
// replay. Four things are easy to get quietly wrong and this file is about them. A landed write
// has to spend the draft it came from AND drop the queue entry it supersedes, or the next replay
// writes an older status back over it. A queueable failure keeps the optimistic status and says
// nothing — a rollback or a toast there would tell the tester their click was lost when it was
// not. A replay must rethrow instead of re-queueing, or its entry is written twice. And livesync
// is paused exactly once and released exactly once, throw or no throw.
//
// The stub list is the whole point of the extraction: TestomatAPI, OfflineQueue, `state.runId`,
// four cross-file functions and a CommentDrafts that only records. No document, no mini-DOM, no
// capabilities, no Dropdown — the screen needed all of those and this does not.
// Run: node --test tests/write-status.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, plain, settle, rejection } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// CORE_SRC points the suite at a mutated COPY of core/, so a falsification run never edits the
// shipped file. `WriteCore` is a top-level const: lexical, so only the completion value reaches us.
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const source = readFileSync(join(CORE_SRC, 'write-status.js'), 'utf8');

const LOCK = 'Run is finished — results are read-only';
const rec = (id, over = {}) => ({ id, test_id: id * 100, status: 'pending', ...over });

function load(opts = {}) {
  const o = {
    records: null,        // default: one pending record, id 7
    runId: 'r1',
    lock: '',             // recordWriteLock()'s answer for a record in the OPEN run
    jwtAvailable: true,   // true | false | 'unknown'
    now: 1700000000000,
    ...opts,
  };
  const state = {
    runId: o.runId,
    settings: { baseUrl: 'https://app.testomat.io' },
    records: o.records === null ? [rec(7)] : o.records,
  };
  const calls = {
    order: [], setStatus: [], enqueued: [], removed: [], refreshUIs: 0, forced: 0,
    dropped: [], meta: [], envMeta: [], logUploads: [], toasts: [],
    beginWrites: 0, endWrites: 0,
  };
  // Every one of these is replaceable per row: several rows are about what the core does with an
  // answer it cannot control, so the answer is the input.
  const on = {
    setStatus: async () => ({ id: 7, status: 'passed' }),
    qualifies: (e) => e?.kind === 'network' || e?.kind === 'auth',
    remove: async () => false,
    forcedError: () => null,
    collectEnvMeta: async () => [],
    uploadEvidenceLog: async () => '',
    setTestrunMeta: async () => undefined,
  };

  const sandbox = {
    console,
    URL,
    Date: new Proxy(Date, { get: (t, k) => (k === 'now' ? () => o.now : Reflect.get(t, k)) }),
    state,
    // Scoped to the OPEN run: a record the open run does not carry is a replay into another one.
    recordFor: (id) => state.records.find((r) => String(r.id) === String(id)) || null,
    recordWriteLock: () => o.lock,
    syncBeginWrite: () => { calls.beginWrites += 1; calls.order.push('beginWrite'); },
    syncEndWrite: () => { calls.endWrites += 1; calls.order.push('endWrite'); },
    CommentDrafts: { drop: (id) => { calls.dropped.push(id); calls.order.push('dropDraft'); } },
    collectEnvMeta: async (settings) => { calls.envMeta.push(plain(settings)); return on.collectEnvMeta(); },
    uploadEvidenceLog: async (record) => { calls.logUploads.push(record?.id); return on.uploadEvidenceLog(record); },
    TestomatAPI: {
      ApiError,
      jwtAvailable: () => o.jwtAvailable,
      setStatus: async (payload) => {
        calls.setStatus.push(plain(payload));
        calls.order.push('setStatus');
        return on.setStatus(payload);
      },
      setTestrunMeta: async (id, entries) => {
        calls.meta.push({ id, entries: plain(entries) });
        calls.order.push('meta');
        return on.setTestrunMeta(id, entries);
      },
    },
    OfflineQueue: {
      forcedError: () => { calls.forced += 1; return on.forcedError(); },
      qualifies: (e) => on.qualifies(e),
      enqueue: async (entry) => { calls.enqueued.push(plain(entry)); calls.order.push('enqueue'); },
      remove: async (id) => { calls.removed.push(id); return on.remove(id); },
      refreshUI: () => { calls.refreshUIs += 1; },
    },
    toast: (text, opt) => { calls.toasts.push({ text, error: !!opt?.error }); },
  };

  const screen = runInContext(`${source}\nWriteCore;`, createContext(sandbox),
    { filename: join(CORE_SRC, 'write-status.js') });
  return { fn: screen, state, calls, on, ApiError, plain, settle, rejection };
}

test('76: the write carries the four ids the server needs, and the merge keeps test_id', async () => {
  const h = load();
  const record = h.state.records[0];
  h.on.setStatus = async () => ({ id: 7, test_id: 999, status: 'passed', 'finished-at': 'T' });
  const saved = await h.fn.writeStatus(record, 'passed', 'note', null);
  assert.deepEqual(h.calls.setStatus, [{
    testrunId: 7, runId: 'r1', testId: 700, status: 'passed', message: 'note',
  }]);
  assert.equal(record.test_id, 700); // the row was opened BY id and keeps the test it belongs to
  assert.equal(record.status, 'passed');
  assert.equal(record.message, 'note');
  assert.equal(record['finished-at'], 'T');
  assert.equal(plain(saved).id, 7);
});

test('76b: the optimistic callback runs before the request, not after it', async () => {
  const h = load();
  await h.fn.writeStatus(h.state.records[0], 'passed', 'note', () => h.calls.order.push('optimistic'));
  assert.deepEqual(h.calls.order.filter((s) => s === 'optimistic' || s === 'setStatus'),
    ['optimistic', 'setStatus']);
});

test('77: a landed write spends its draft AND drops the queue entry it supersedes', async () => {
  const h = load();
  h.on.remove = async () => true;
  await h.fn.writeStatus(h.state.records[0], 'passed', 'note', null);
  await settle();
  assert.deepEqual(h.calls.removed, [7]);
  assert.equal(h.calls.refreshUIs, 1);
  // The store is screens/test-drafts.js's; what this write owes it is the call.
  assert.deepEqual(h.calls.dropped, [7]);
});

test('77b: nothing queued for the row leaves the pending badge alone', async () => {
  const h = load();
  h.on.remove = async () => false;
  await h.fn.writeStatus(h.state.records[0], 'passed', '', null);
  assert.deepEqual(h.calls.removed, [7]);
  assert.equal(h.calls.refreshUIs, 0);
});

test('77c: a replay does NOT drop the row\'s entry — the drain removes its own by queuedAt', async () => {
  const h = load();
  await h.fn.writeStatus(h.state.records[0], 'passed', 'note', null, { noQueue: true });
  await settle();
  assert.deepEqual(h.calls.removed, []);
  assert.deepEqual(h.calls.dropped, [7]); // the draft still goes
});

test('78: a queue removal that throws does not fail a status that is already saved', async () => {
  const h = load();
  h.on.remove = async () => { throw new Error('queue storage is gone'); };
  const saved = await h.fn.writeStatus(h.state.records[0], 'passed', '', null);
  assert.equal(plain(saved).status, 'passed');
  assert.equal(h.calls.endWrites, 1);
});

test('79: a network failure queues the click, keeps the optimistic status and says nothing', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('network', 0, 'offline'); };
  const res = await h.fn.writeStatus(h.state.records[0], 'passed', 'note', null);
  assert.deepEqual(plain(res), { queued: true, reason: 'network' });
  assert.deepEqual(h.calls.enqueued, [{
    recordId: 7, runId: 'r1', status: 'passed', comment: 'note', queuedAt: 1700000000000, reason: 'network',
  }]);
  assert.equal(h.state.records[0].status, 'passed'); // no rollback
  assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.removed, []); // and nothing is dropped from the queue
});

test('79b: a REJECTED TOKEN queues under its own reason — it is not "offline"', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('auth', 403, 'token rejected'); };
  const res = await h.fn.writeStatus(h.state.records[0], 'passed', 'note', null);
  assert.deepEqual(plain(res), { queued: true, reason: 'auth' });
  assert.equal(h.calls.enqueued[0].reason, 'auth');
});

test('79c: a failure the queue does not take is rethrown, not swallowed', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('http', 500, 'server said no'); };
  const e = await rejection(h.fn.writeStatus(h.state.records[0], 'passed', 'note', null));
  assert.equal(e.message, 'server said no');
  assert.deepEqual(h.calls.enqueued, []);
});

test('79d: a row with no id yet cannot be queued — there would be nothing to replay onto', async () => {
  const h = load({ records: [rec(7, { id: null })] });
  h.on.setStatus = async () => { throw new h.ApiError('network', 0, 'offline'); };
  const e = await rejection(h.fn.writeStatus(h.state.records[0], 'passed', '', null));
  assert.equal(e.kind, 'network');
  assert.deepEqual(h.calls.enqueued, []);
});

test('80: a replay rethrows so its entry stays queued for the next drain', async () => {
  const h = load();
  h.on.setStatus = async () => { throw new h.ApiError('network', 0, 'offline'); };
  const e = await rejection(h.fn.writeStatus(h.state.records[0], 'passed', 'note', null, { noQueue: true }));
  assert.equal(e.kind, 'network');
  assert.deepEqual(h.calls.enqueued, []);
});

test('81: the e2e force flag fires INSTEAD of the request, not after it', async () => {
  const h = load();
  h.on.forcedError = () => new h.ApiError('network', 0, 'forced offline (e2e)');
  const res = await h.fn.writeStatus(h.state.records[0], 'passed', '', null);
  assert.deepEqual(h.calls.setStatus, []);
  assert.equal(plain(res).queued, true);
  assert.equal(h.calls.enqueued[0].reason, 'network');
});

test('81b: …and with the flag down the real request goes out', async () => {
  const h = load();
  await h.fn.writeStatus(h.state.records[0], 'passed', '', null);
  assert.equal(h.calls.setStatus.length, 1);
});

test('82: livesync is paused and released exactly once on every path', async () => {
  const ok = load();
  await ok.fn.writeStatus(ok.state.records[0], 'passed', '', null);
  assert.deepEqual([ok.calls.beginWrites, ok.calls.endWrites], [1, 1]);

  const thrown = load();
  thrown.on.setStatus = async () => { throw new thrown.ApiError('http', 500, 'nope'); };
  await rejection(thrown.fn.writeStatus(thrown.state.records[0], 'passed', '', null));
  assert.deepEqual([thrown.calls.beginWrites, thrown.calls.endWrites], [1, 1]);

  const queued = load();
  queued.on.setStatus = async () => { throw new queued.ApiError('network', 0, 'offline'); };
  await queued.fn.writeStatus(queued.state.records[0], 'passed', '', null);
  assert.deepEqual([queued.calls.beginWrites, queued.calls.endWrites], [1, 1]);
});

test('83: a failed result carries the environment AND the log, in that order', async () => {
  const h = load();
  h.on.collectEnvMeta = async () => [['URL', 'https://shop.test/cart']];
  h.on.uploadEvidenceLog = async () => 'https://files.test/log.txt';
  await h.fn.writeEnvMeta(h.state.records[0], 'failed');
  assert.deepEqual(h.calls.meta, [{
    id: 7,
    entries: [['URL', 'https://shop.test/cart'], ['Console & network log', 'https://files.test/log.txt']],
  }]);
});

test('83b: a passed result never uploads a log', async () => {
  const h = load();
  h.on.collectEnvMeta = async () => [['URL', 'https://shop.test/cart']];
  h.on.uploadEvidenceLog = async () => 'https://files.test/log.txt';
  await h.fn.writeEnvMeta(h.state.records[0], 'passed');
  assert.deepEqual(h.calls.logUploads, []);
  assert.deepEqual(h.calls.meta, [{ id: 7, entries: [['URL', 'https://shop.test/cart']] }]);
});

test('84: a proven degraded session writes no meta and does not even collect it', async () => {
  const h = load({ jwtAvailable: false });
  h.on.collectEnvMeta = async () => [['URL', 'u']];
  await h.fn.writeEnvMeta(h.state.records[0], 'passed');
  assert.deepEqual(h.calls.envMeta, []);
  assert.deepEqual(h.calls.meta, []);
});

test('84b: a session still PROBING is not a gate', async () => {
  const h = load({ jwtAvailable: 'unknown' });
  h.on.collectEnvMeta = async () => [['URL', 'u']];
  await h.fn.writeEnvMeta(h.state.records[0], 'passed');
  assert.deepEqual(h.calls.meta, [{ id: 7, entries: [['URL', 'u']] }]);
});

test('85: a locked result in the OPEN run writes no meta', async () => {
  const h = load({ lock: LOCK });
  h.on.collectEnvMeta = async () => [['URL', 'u']];
  await h.fn.writeEnvMeta(h.state.records[0], 'passed');
  assert.deepEqual(h.calls.meta, []);
});

test('85b: …but a replay into another, still-live run keeps writing its meta', async () => {
  const h = load({ lock: LOCK, records: [] }); // the record belongs to a run that is not open here
  h.on.collectEnvMeta = async () => [['URL', 'u']];
  await h.fn.writeEnvMeta({ id: 42 }, 'passed');
  assert.deepEqual(h.calls.meta, [{ id: 42, entries: [['URL', 'u']] }]);
});

test('85c: a row with no result id yet writes nothing — the meta keys hang off that id', async () => {
  const h = load();
  h.on.collectEnvMeta = async () => [['URL', 'u']];
  await h.fn.writeEnvMeta({ id: null }, 'passed');
  await h.fn.writeEnvMeta(null, 'passed');
  assert.deepEqual(h.calls.envMeta, []);
  assert.deepEqual(h.calls.meta, []);
});

test('86: nothing to say is no request — both toggles off is the common case', async () => {
  const h = load();
  h.on.collectEnvMeta = async () => [];
  await h.fn.writeEnvMeta(h.state.records[0], 'passed');
  assert.deepEqual(h.calls.meta, []);
});

test('86b: …and the log alone is still worth a request when env-info is off', async () => {
  const h = load();
  h.on.collectEnvMeta = async () => [];
  h.on.uploadEvidenceLog = async () => 'https://files.test/log.txt';
  await h.fn.writeEnvMeta(h.state.records[0], 'failed');
  assert.deepEqual(h.calls.meta, [{ id: 7, entries: [['Console & network log', 'https://files.test/log.txt']] }]);
});

// #107: an offline replay is written from whatever tab is open NOW, so the environment and the
// console log attached to it are not the ones the tester recorded the result in.
test.todo('87: a replayed failure should not attach the CURRENT tab\'s environment (#107)');
