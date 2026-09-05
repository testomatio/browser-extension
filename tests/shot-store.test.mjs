#!/usr/bin/env node
// The pictures a tester pastes into a draft they have not saved yet: what extension/shared/shot-store.js
// keeps, what it refuses to keep, what it hands back when the browser refuses IndexedDB, and the two
// rules it throws pictures away by. The database underneath is tests/helpers/fake-idb.mjs, written
// from the IndexedDB contract and not from a browser run. Run: node --test tests/shot-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain } from './helpers/shared-harness.mjs';
import { makeIdb } from './helpers/fake-idb.mjs';

// The answer is handed over on COMMIT, so a fake that forgot to commit would hang, not fail: a
// timeout on every row turns that silence into a red test.
const T = { timeout: 5000 };

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const SHOT = 'data:image/jpeg;base64,AAA';

// `Date.now()` is read on write and on sweep; a real clock would make the age rows flaky at midnight.
function load({ now = NOW, ...idb } = {}) {
  const fake = makeIdb(idb);
  const { value } = loadInto(
    { indexedDB: fake.indexedDB, Date: { now: () => now } },
    [['shared/shot-store.js', 'ShotStore']],
  );
  return { shots: value, ...fake };
}

const ops = (calls) => calls.map((c) => c.op);
const argsFor = (calls, op) => calls.filter((c) => c.op === op).map((c) => c.args);
const keys = (records) => records.map((r) => r.key);
const staged = (key, at = NOW) => ({ key, shots: [SHOT], at });

// ---- A: what a draft stages, and what it refuses to stage -------------------

test('1: the picture a tester pasted comes back out of the database exactly as it went in', T,
  async () => {
    const s = load();
    assert.equal(await s.shots.put('editorDraft:7', [SHOT]), true);
    assert.deepEqual(plain(await s.shots.get('editorDraft:7')), [SHOT]);
    assert.deepEqual(s.records, [{ key: 'editorDraft:7', shots: [SHOT], at: NOW }]);
    // Asserted on the call log too: openDb never rejects, so a broken fake would read as an empty list.
    assert.deepEqual(ops(s.calls), ['open', 'createObjectStore', 'transaction', 'put', 'close',
      'open', 'transaction', 'get', 'close']);
    assert.deepEqual(argsFor(s.calls, 'transaction'), [['shots', 'readwrite'], ['shots', 'readonly']]);
  });

test('2: staging an empty list deletes the row rather than storing a draft with no pictures', T,
  async () => {
    const s = load({ records: [staged('k')] });
    assert.equal(await s.shots.put('k', []), true);
    assert.deepEqual(s.records, []);
    assert.deepEqual(argsFor(s.calls, 'delete'), [['k']]);
    assert.deepEqual(argsFor(s.calls, 'put'), [], 'an empty row must never be written');
  });

test('3: the blanks and the non-strings in a shot list are dropped, the pictures are kept', T,
  async () => {
    const s = load();
    assert.equal(await s.shots.put('k', ['a', '', null, 42, 'b']), true);
    assert.deepEqual(s.records, [{ key: 'k', shots: ['a', 'b'], at: NOW }]);
    assert.deepEqual(argsFor(s.calls, 'put'), [[{ key: 'k', shots: ['a', 'b'], at: NOW }]]);
  });

test('4: a shot list that is not a list at all deletes the row instead of storing it', T,
  async () => {
    const s = load({ records: [staged('k')] });
    assert.equal(await s.shots.put('k', 'not an array'), true);
    assert.deepEqual(s.records, []);
    assert.deepEqual(argsFor(s.calls, 'delete'), [['k']]);
    assert.deepEqual(argsFor(s.calls, 'put'), []);
  });

test('5: a draft with no key never reaches the database at all', T, async () => {
  const s = load();
  assert.equal(await s.shots.put('', [SHOT]), false);
  assert.equal(await s.shots.put(null, [SHOT]), false);
  assert.deepEqual(s.calls, [], 'a keyless draft must not even open the database');
});

// ---- B: reading them back ---------------------------------------------------

test('6: a draft nobody staged pictures for comes back with an empty list', T, async () => {
  const s = load({ records: [staged('other')] });
  assert.deepEqual(plain(await s.shots.get('missing')), []);
  assert.deepEqual(argsFor(s.calls, 'get'), [['missing']]);
  assert.deepEqual(keys(s.records), ['other'], 'a read must not disturb the store');
});

test('7: a row whose shots are not a list reads as no pictures, not as a broken editor', T,
  async () => {
    const s = load({ records: [{ key: 'k', shots: 'nope', at: NOW }] });
    assert.deepEqual(plain(await s.shots.get('k')), []);
    assert.deepEqual(argsFor(s.calls, 'get'), [['k']], 'the row really was read');
  });

test('8: asking for the pictures of an empty key opens no database', T, async () => {
  const s = load({ records: [staged('k')] });
  assert.deepEqual(plain(await s.shots.get('')), []);
  assert.deepEqual(s.calls, []);
});

// ---- C: the three ways a browser refuses the database ------------------------

test('9: a browser with IndexedDB switched off loses the pictures, never the editor', T, async () => {
  const s = load({ failOpen: true });
  assert.deepEqual(plain(await s.shots.get('k')), []);
  assert.equal(await s.shots.put('k', [SHOT]), false);
  assert.equal(await s.shots.sweep(['k'], WEEK), 0);
  assert.deepEqual(ops(s.calls), ['open', 'open', 'open'], 'each call tried, and each gave up');
});

test('10: a database that refuses to open reports no pictures and no write', T, async () => {
  const s = load({ openError: true });
  assert.deepEqual(plain(await s.shots.get('k')), []);
  assert.equal(await s.shots.put('k', [SHOT]), false);
  assert.equal(await s.shots.sweep(['k'], WEEK), 0);
  assert.deepEqual(ops(s.calls), ['open', 'open', 'open']);
});

test('11: a database another document holds open reports no pictures and no write', T, async () => {
  const s = load({ openBlocked: true });
  assert.deepEqual(plain(await s.shots.get('k')), []);
  assert.equal(await s.shots.put('k', [SHOT]), false);
  assert.equal(await s.shots.sweep(['k'], WEEK), 0);
  assert.deepEqual(ops(s.calls), ['open', 'open', 'open']);
});

test('12: a write the browser aborts on quota reports false, not the success it never had', T,
  async () => {
    const s = load({ txAborts: true });
    assert.equal(await s.shots.put('k', [SHOT]), false);
    assert.deepEqual(argsFor(s.calls, 'put'), [[{ key: 'k', shots: [SHOT], at: NOW }]],
      'the write was issued — the false is the commit that never came, not a call that never went');
    assert.ok(ops(s.calls).includes('close'));
  });

test('13: a transaction that cannot start still answers, and still lets go of the database', T,
  async () => {
    const s = load({ records: [staged('k')], txThrows: true });
    assert.deepEqual(plain(await s.shots.get('k')), []);
    assert.equal(await s.shots.put('k', [SHOT]), false);
    assert.equal(await s.shots.sweep([], WEEK), 0);
    assert.deepEqual(ops(s.calls), ['open', 'transaction', 'close', 'open', 'transaction', 'close',
      'open', 'transaction', 'close']);
    assert.deepEqual(s.records, [{ key: 'k', shots: [SHOT], at: NOW }], 'nothing was touched');
  });

test('14: the connection is handed back after every call, the ones that blew up included', T,
  async () => {
    const read = load({ records: [staged('k')] });
    await read.shots.get('k');
    const write = load();
    await write.shots.put('k', [SHOT]);
    const swept = load({ records: [staged('k')] });
    await swept.shots.sweep(['k'], WEEK);
    const aborted = load({ txAborts: true });
    await aborted.shots.put('k', [SHOT]);
    const broken = load({ records: [staged('k')], txThrows: true });
    await broken.shots.get('k');
    for (const s of [read, write, swept, aborted, broken]) {
      assert.equal(ops(s.calls).at(-1), 'close', `close is in a finally: ${ops(s.calls).join(',')}`);
    }
    // The counterpoint: no database was ever handed over, so there is nothing to hand back.
    const none = load({ failOpen: true });
    await none.shots.get('k');
    assert.equal(ops(none.calls).includes('close'), false);
  });

test('15: the very first open creates the shots store; the next open leaves it standing', T,
  async () => {
    const s = load();
    await s.shots.get('a');
    await s.shots.get('b');
    assert.deepEqual(argsFor(s.calls, 'createObjectStore'), [['shots', { keyPath: 'key' }]]);
    assert.deepEqual(ops(s.calls), ['open', 'createObjectStore', 'transaction', 'get', 'close',
      'open', 'transaction', 'get', 'close']);
  });

// ---- D: the sweep, and its two rules ----------------------------------------

test('16: a draft that is gone takes its pictures with it, the live ones stay', T, async () => {
  const s = load({ records: [staged('A'), staged('B'), staged('C')] });
  assert.equal(await s.shots.sweep(['A', 'C'], WEEK), 1);
  assert.deepEqual(keys(s.records), ['A', 'C']);
  assert.deepEqual(argsFor(s.calls, 'delete'), [['B']]);
});

test('17: being a live draft does not save pictures older than the limit', T, async () => {
  const s = load({ records: [staged('A', NOW - 8 * DAY), staged('B')] });
  assert.equal(await s.shots.sweep(['A', 'B'], WEEK), 1);
  assert.deepEqual(keys(s.records), ['B']);
  assert.deepEqual(argsFor(s.calls, 'delete'), [['A']]);
});

test('18: pictures no build of ours stamped with a time go with the stale ones', T, async () => {
  const s = load({ records: [{ key: 'A', shots: [SHOT] }, staged('B')] });
  assert.equal(await s.shots.sweep(['A', 'B'], WEEK), 1);
  assert.deepEqual(keys(s.records), ['B']);
});

test('19: a timestamp of null, or the word yesterday, counts as no timestamp at all', T, async () => {
  const s = load({
    records: [{ key: 'A', shots: [SHOT], at: null }, { key: 'B', shots: [SHOT], at: 'yesterday' },
      staged('C')],
  });
  assert.equal(await s.shots.sweep(['A', 'B', 'C'], WEEK), 2);
  assert.deepEqual(keys(s.records), ['C']);
});

test('20: with no drafts left alive the startup sweep clears the whole database', T, async () => {
  const s = load({ records: [staged('A'), staged('B'), staged('C')] });
  assert.equal(await s.shots.sweep([], WEEK), 3);
  assert.deepEqual(s.records, []);
  assert.deepEqual(argsFor(s.calls, 'delete'), [['A'], ['B'], ['C']]);
});

test('21: a sweep handed nothing instead of a list of drafts clears the database too', T, async () => {
  const s = load({ records: [staged('A'), staged('B'), staged('C')] });
  assert.equal(await s.shots.sweep(null, WEEK), 3);
  assert.deepEqual(s.records, []);
});

test('22: an age limit of zero or less wipes everything, even what was written this instant', T,
  async () => {
    const zero = load({ records: [staged('A')] });
    assert.equal(await zero.shots.sweep(['A'], 0), 1);
    assert.deepEqual(zero.records, []);
    const negative = load({ records: [staged('A')] });
    assert.equal(await negative.shots.sweep(['A'], -1), 1);
    assert.deepEqual(negative.records, []);
  });

test('23: a sweep over an empty database reports nothing swept and does not fail', T, async () => {
  const s = load();
  assert.equal(await s.shots.sweep(['A'], WEEK), 0);
  assert.deepEqual(ops(s.calls), ['open', 'createObjectStore', 'transaction', 'openCursor', 'close'],
    'the count is delivered on the cursor that came back empty');
});

test('24: a sweep whose transaction never commits reports nothing swept, not the count it reached', T,
  async () => {
    const s = load({ records: [staged('A'), staged('B'), staged('C')], txAborts: true });
    assert.equal(await s.shots.sweep([], WEEK), 0);
    assert.deepEqual(argsFor(s.calls, 'delete'), [['A'], ['B'], ['C']],
      'the walk really did reach three — the zero is the commit that never came');
  });

test('25: five hundred rows are walked to the end and the 250 stale ones dropped on the way', T,
  async () => {
    const records = Array.from({ length: 500 },
      (_, i) => staged(`k${i}`, i % 2 ? NOW - 8 * DAY : NOW));
    const s = load({ records });
    assert.equal(await s.shots.sweep(records.map((r) => r.key), WEEK), 250);
    assert.equal(s.records.length, 250);
    assert.equal(argsFor(s.calls, 'delete').length, 250);
    // One cursor for the lot: the walk carried on after each delete instead of stopping there.
    assert.deepEqual(argsFor(s.calls, 'openCursor'), [[]]);
    assert.deepEqual(keys(s.records).slice(0, 3), ['k0', 'k2', 'k4']);
  });

test('26: the worker sweeps with exactly the editorDraft keys the session still holds', T, async () => {
  const session = { 'editorDraft:7': { title: 'Login' }, siteTarget: { tabId: 3 } };
  const live = Object.keys(session).filter((k) => k.startsWith('editorDraft:'));
  assert.deepEqual(live, ['editorDraft:7'], 'only draft keys are live, whatever else the session holds');
  const s = load({ records: [staged('editorDraft:7'), staged('editorDraft:9'), staged('siteTarget')] });
  assert.equal(await s.shots.sweep(live, WEEK), 2);
  assert.deepEqual(keys(s.records), ['editorDraft:7']);
});
