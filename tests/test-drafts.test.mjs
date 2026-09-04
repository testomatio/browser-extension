#!/usr/bin/env node
// extension/sidepanel/screens/test-drafts.js — what the tester was half-way through typing.
// Rows 1-17 of #164, moved here when the store left screens/test-view.js (#197). The comment box
// is READ only by a status write, so everything else that leaves the test — the pager, a hotkey,
// Back, a tab click, the panel closing — used to throw the typing away, and with it the evidence
// the Attach buttons paste into that same box. Four surfaces reach this store and only one of
// them is the test view, which is why it is its own file and its own suite.
//
// The whole stub list is below: chrome.storage.session, a {value:''} textarea, and three keys of
// `state`. No API, no OfflineQueue, no mini-DOM document beyond the one box — the point of the
// extraction is that this is all it ever needed.
// Run: node --test tests/test-drafts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeClock, plain, settle } from './helpers/panel-harness.mjs';

function load(opts = {}) {
  const o = {
    recordId: 7,
    records: null,     // default: the run still has result 7
    runId: 'r1',
    drafts: undefined, // seeds chrome.storage.session.commentDrafts
    hasChrome: true,
    sessionThrows: false,
    ...opts,
  };
  // The one element the store touches. A real textarea is more than these rows need, and a
  // document would let a row pass because some OTHER node happened to exist.
  const box = { value: '' };
  const state = {
    currentRecordId: o.recordId,
    runId: o.runId,
    records: o.records === null ? [{ id: 7 }] : o.records,
  };
  // panel-harness gives session a `get` only — no screen before this one wrote to it. The mirror
  // does, and these rows are asserted on what it actually wrote, so the two ops are recorded here.
  const store = fakeChrome({ session: o.drafts === undefined ? {} : { commentDrafts: o.drafts } });
  const sess = store.session;
  store.chrome.storage.session.set = async (arg) => {
    store.calls.push({ area: 'session', op: 'set', arg: plain(arg), raw: arg });
    Object.assign(sess, plain(arg)); // a JSON copy, the way real storage serialises
  };
  store.chrome.storage.session.remove = async (arg) => {
    store.calls.push({ area: 'session', op: 'remove', arg: plain(arg), raw: arg });
    for (const k of [].concat(arg)) delete sess[k];
  };
  if (o.sessionThrows) store.fails.sessionGet = new Error('session storage is gone');
  const clock = fakeClock();

  const h = loadScreen('test-drafts', {
    exported: 'CommentDrafts',
    store,
    clock,
    globals: { state, hasChrome: o.hasChrome, $: (id) => (id === 'test-comment' ? box : null) },
  });
  return {
    ...h,
    mod: h.screen,
    box,
    state,
    clock,
    drafts: () => store.session.commentDrafts,
    sets: () => store.ops('session', 'set').map((c) => c.arg.commentDrafts),
  };
}

test('1: a saved draft is one storage write and comes back tagged with its run', async () => {
  const h = load();
  await h.mod.save(7, 'repro steps', 42);
  assert.deepEqual(plain(await h.mod.load()), { 7: { text: 'repro steps', runId: '42' } });
  assert.equal(h.store.ops('session', 'set').length, 1);
  assert.deepEqual(h.sets(), [{ 7: { text: 'repro steps', runId: '42' } }]);
});

test('2: saving an empty box DELETES the row rather than storing an empty draft', async () => {
  const h = load({ drafts: { 7: { text: 'half a sentence', runId: 'r1' } } });
  await h.mod.save(7, '', 42);
  assert.deepEqual(plain(await h.mod.load()), {});
  assert.deepEqual(h.sets(), [{}]);
});

test('2b: …and anything else on the same row overwrites it', async () => {
  const h = load({ drafts: { 7: { text: 'half a sentence', runId: 'r1' } } });
  await h.mod.save(7, 'the rest of it', 42);
  assert.deepEqual(plain(await h.mod.load()), { 7: { text: 'the rest of it', runId: '42' } });
});

test('3: whitespace is kept VERBATIM — only the write trims', async () => {
  const h = load();
  await h.mod.save(7, '  ', 42);
  assert.deepEqual(plain(await h.mod.load()), { 7: { text: '  ', runId: '42' } });
});

test('4: no record id is a no-op, not a row under "null"', async () => {
  const h = load();
  await h.mod.save(null, 'x', 1);
  assert.deepEqual(h.store.calls, []);
  assert.deepEqual(plain(await h.mod.load()), {});
});

test('5: no run id stores an UNTAGGED draft — null, not the string "null"', async () => {
  const h = load();
  await h.mod.save(7, 'x', null);
  assert.deepEqual(plain(await h.mod.load()), { 7: { text: 'x', runId: null } });
});

test('6: a legacy bare-string row still restores — the shape that came before the run tag', async () => {
  const h = load({ drafts: { 7: 'bare string', 8: { text: 'tagged', runId: 'r1' } } });
  await h.mod.restore({ id: 7 });
  assert.equal(h.box.value, 'bare string');
  // …and the tagged shape beside it, so the two branches are told apart rather than one working.
  h.box.value = '';
  h.state.currentRecordId = 8;
  await h.mod.restore({ id: 8 });
  assert.equal(h.box.value, 'tagged');
});

test('6a: …and it answers NO run, so a prune of any run leaves it alone', async () => {
  const h = load({ records: [], drafts: { 7: 'bare string', 8: { text: 'tagged', runId: 'r1' } } });
  await h.mod.prune('r1');
  // 8 is this run's and its result is gone; 7 belongs to no run at all and is not this run's to judge.
  assert.deepEqual(plain(await h.mod.load()), { 7: 'bare string' });
});

test('7: a result that already carries a message keeps it — the draft does not overwrite', async () => {
  const h = load({ drafts: { 7: { text: 'unsent', runId: 'r1' } } });
  h.box.value = 'already sent';
  await h.mod.restore({ id: 7, message: 'already sent' });
  assert.equal(h.box.value, 'already sent');
  assert.deepEqual(h.store.calls, []); // it never even reads storage
});

test('7b: …the same result with no message of its own gets the draft back', async () => {
  const h = load({ drafts: { 7: { text: 'unsent', runId: 'r1' } } });
  await h.mod.restore({ id: 7 });
  assert.equal(h.box.value, 'unsent');
});

test('8: an absent draft answers null, never "" — it must not blank the box', async () => {
  const h = load({ drafts: { 9: { text: 'another test', runId: 'r1' } } });
  h.box.value = 'typed just now';
  await h.mod.restore({ id: 7 });
  assert.equal(h.box.value, 'typed just now');
});

test('9: paging away mid-read leaves the next test\'s box alone', async () => {
  const h = load({ drafts: { 7: { text: 'unsent', runId: 'r1' } } });
  const done = h.mod.restore({ id: 7 });
  h.state.currentRecordId = 8; // the tester moved on while storage answered
  await done;
  assert.equal(h.box.value, '');
});

test('10: the prune drops only THIS run\'s rows whose result is gone', async () => {
  const h = load({
    records: [{ id: 8 }],
    drafts: { 7: { text: 'a', runId: '42' }, 8: { text: 'b', runId: '99' }, 9: 'legacy' },
  });
  await h.mod.prune(42);
  // 8 belongs to another run, 9 is untagged and belongs to no run at all.
  assert.deepEqual(plain(await h.mod.load()), { 8: { text: 'b', runId: '99' }, 9: 'legacy' });
  assert.deepEqual(h.sets(), [{ 8: { text: 'b', runId: '99' }, 9: 'legacy' }]);
});

test('11: a prune with nothing stale writes nothing at all', async () => {
  const h = load({ records: [{ id: 7 }], drafts: { 7: { text: 'a', runId: '42' } } });
  await h.mod.prune(42);
  assert.deepEqual(h.store.ops('session', 'set'), []);
  // …and an empty store short-circuits before the run id is even considered.
  const empty = load({ drafts: {} });
  await empty.mod.prune(42);
  assert.deepEqual(empty.store.ops('session', 'set'), []);
});

test('12: storage that throws leaves an empty cache — a draft never fails an open', async () => {
  const h = load({ drafts: { 7: { text: 'a', runId: 'r1' } } });
  h.store.fails.sessionGet = new Error('session storage is gone');
  assert.deepEqual(plain(await h.mod.load()), {});
  // …and the open goes on: a restore over that cache is silent, not a rejection.
  await h.mod.restore({ id: 7 });
  assert.equal(h.box.value, '');
});

test('13: no chrome at all answers {} and persists nothing', async () => {
  const h = load({ hasChrome: false, drafts: { 7: { text: 'a', runId: 'r1' } } });
  assert.deepEqual(plain(await h.mod.load()), {});
  await h.mod.save(7, 'x', 1);
  assert.deepEqual(h.store.calls, []);
});

test('14: the map is seeded once — a reopened panel must not write over the drafts already there', async () => {
  const h = load({ drafts: { 7: { text: 'a', runId: 'r1' } } });
  const [a, b] = await Promise.all([h.mod.load(), h.mod.load()]);
  assert.equal(h.store.ops('session', 'get').length, 1); // one read for two concurrent callers
  assert.equal(a, b);
  assert.equal(await h.mod.load(), a);       // …and none at all once it has settled
  assert.equal(h.store.ops('session', 'get').length, 1);
  assert.deepEqual(plain(a), { 7: { text: 'a', runId: 'r1' } });
});

test('15: a burst of typing is ONE write, and only after the debounce', async () => {
  const h = load();
  h.box.value = 'rep';
  h.mod.onInput();
  h.box.value = 'repro steps';
  h.mod.onInput();
  assert.deepEqual(h.store.ops('session', 'set'), []);
  assert.equal(h.clock.count(), 1); // the first arming was cleared, not left behind
  assert.deepEqual(h.clock.arms(), [400, 400]);
  await h.clock.tick();
  await settle();
  assert.deepEqual(h.sets(), [{ 7: { text: 'repro steps', runId: 'r1' } }]);
});

test('16: a keystroke in the NEXT test commits the previous test\'s pending draft', async () => {
  const h = load();
  h.box.value = 'for seven';
  h.mod.onInput();
  h.state.currentRecordId = 8;
  h.box.value = 'for eight';
  h.mod.onInput();
  await settle();
  // Committed, not cancelled: record 7's text is already in storage before any timer ran.
  assert.deepEqual(h.sets(), [{ 7: { text: 'for seven', runId: 'r1' } }]);
  await h.clock.tick();
  await settle();
  assert.deepEqual(plain(await h.mod.load()), {
    7: { text: 'for seven', runId: 'r1' }, 8: { text: 'for eight', runId: 'r1' },
  });
});

test('17: dropping every draft settles the read already on the wire first', async () => {
  const h = load({ drafts: { 7: { text: 'a', runId: 'r1' }, 8: 'legacy' } });
  h.mod.load();               // in flight, deliberately not awaited
  await h.mod.dropAll();
  assert.deepEqual(plain(await h.mod.load()), {});
  assert.deepEqual(h.store.ops('session', 'remove').map((c) => c.arg), ['commentDrafts']);
});
