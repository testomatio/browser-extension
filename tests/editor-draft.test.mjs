#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// DRAFT_SRC points the file at a mutated copy, so a falsification run never edits the shipped module.
const SRC = process.env.DRAFT_SRC || join(repoRoot, 'extension/editor/draft.js');
const source = readFileSync(SRC, 'utf8');

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The 400ms throttle matters, so the sandbox has its own clock: run() fires what is armed.
function makeClock(log) {
  let seq = 0;
  const jobs = new Map();
  const delays = [];
  return {
    setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, fn); delays.push(ms); return id; },
    delays: () => [...delays],
    clearTimeout: (id) => { log.push('clearTimeout'); jobs.delete(id); },
    armed: () => jobs.size,
    run: () => { const all = [...jobs.values()]; jobs.clear(); for (const fn of all) fn(); },
  };
}

// One sandbox per test: the tracker keeps module state, and `log` is an ordered trace.
function load({ session = true, getFails = false, setThrows = false, removeThrows = false } = {}) {
  const log = [];
  const store = new Map();
  const clock = makeClock(log);
  const shots = { put: [], get: [], del: [] };
  const listeners = [];
  const chrome = { storage: {} };
  if (session) {
    chrome.storage.session = {
      get: async (key) => {
        log.push(`session.get:${key}`);
        if (getFails) throw new Error('storage is gone');
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      set: (obj) => {
        log.push('session.set');
        if (setThrows) throw new Error('quota');
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      remove: (key) => {
        log.push(`session.remove:${key}`);
        if (removeThrows) throw new Error('gone');
        store.delete(key);
      },
    };
  }
  const ctx = createContext({
    chrome,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // ShotStore is a real IndexedDB module in the page; here it only has to record the calls.
    ShotStore: {
      put: (key, list) => { log.push('ShotStore.put'); shots.put.push([key, list.slice()]); },
      get: async (key) => { log.push('ShotStore.get'); shots.get.push(key); return shots.answer || []; },
      del: (key) => { log.push('ShotStore.del'); shots.del.push(key); },
    },
    window: {
      addEventListener: (type, fn) => { log.push(`add:${type}`); listeners.push([type, fn]); },
      removeEventListener: (type, fn) => {
        log.push(`remove:${type}`);
        const i = listeners.findIndex(([t, f]) => t === type && f === fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  });
  const EditorDraft = runInContext(`${source}\nEditorDraft;`, ctx);
  return { EditorDraft, log, store, clock, shots, listeners };
}

// The getter bag renderEditor hands the tracker, with every value overridable per case.
function tracker(env, { ctx = 'panel', draftKey = 'editorDraft:test:t1', ...over } = {}) {
  const state = {
    title: 'Login works',
    markdown: '### Steps\n\n1. Open',
    priority: 'high',
    suite: null,
    test: 't1',
    params: null,
    recording: { entries: [], start: -1, count: 0, polished: false, rawItems: [], polishedItems: [] },
    shots: [],
    shotsRev: 0,
    savedId: null,
    ...over,
  };
  let strips = 0;
  const read = {};
  for (const k of ['title', 'markdown', 'priority', 'suite', 'test', 'params', 'recording', 'shots',
    'shotsRev', 'savedId']) {
    read[k] = () => state[k];
  }
  read.stripRefresh = () => { strips += 1; };
  return { t: env.EditorDraft.makeDirtyTracker({ ctx, draftKey, read }), state, strips: () => strips };
}

const written = (env, key = 'editorDraft:test:t1') => plain(env.store.get(key));

test('the module publishes exactly the surface editor.js and the tests reach for', () => {
  assert.deepEqual(Object.keys(load().EditorDraft).sort(), [
    'editorDraftKey', 'hasSession', 'makeDirtyTracker', 'readDraftShots', 'readEditorDraft',
    'removeEditorDraft',
  ]);
  // The tracker's own surface: `isDirty` is what the leave guard asks before it opens.
  const env = load();
  assert.deepEqual(Object.keys(tracker(env).t).sort(), [
    'clearDirty', 'isDirty', 'markDirty', 'onEdited', 'persistDraftNow', 'schedulePersist',
  ]);
});

test('58: a test key and a suite key can never collide', () => {
  const { editorDraftKey } = load().EditorDraft;
  assert.equal(editorDraftKey({ test: 't1' }), 'editorDraft:test:t1');
  assert.equal(editorDraftKey({ suite: 's1' }), 'editorDraft:suite:s1');
  // Editing, both are in scope — the test wins, so a suite's draft is never overwritten.
  assert.equal(editorDraftKey({ suite: 's1', test: 't1' }), 'editorDraft:test:t1');
});

test('58: hasSession answers for the storage the key lives in', () => {
  assert.equal(!!load().EditorDraft.hasSession(), true);
  assert.equal(!!load({ session: false }).EditorDraft.hasSession(), false);
});

test('59: no storage.session, or a read that rejects, is null and not a throw', async () => {
  const none = load({ session: false });
  assert.equal(await none.EditorDraft.readEditorDraft('editorDraft:test:t1'), null);
  assert.deepEqual(none.log, []); // nothing was even attempted

  const broken = load({ getFails: true });
  assert.equal(await broken.EditorDraft.readEditorDraft('editorDraft:test:t1'), null);
  assert.deepEqual(broken.log, ['session.get:editorDraft:test:t1']);

  const empty = load();
  assert.equal(await empty.EditorDraft.readEditorDraft('editorDraft:test:t1'), null);
  const held = load();
  held.store.set('editorDraft:test:t1', { title: 'x' });
  assert.deepEqual(plain(await held.EditorDraft.readEditorDraft('editorDraft:test:t1')), { title: 'x' });
});

test('60: removing a draft always drops its shots, storage.session or not', () => {
  const env = load();
  env.store.set('editorDraft:test:t1', { title: 'x' });
  env.EditorDraft.removeEditorDraft('editorDraft:test:t1');
  assert.deepEqual(env.shots.del, ['editorDraft:test:t1']);
  assert.equal(env.store.has('editorDraft:test:t1'), false);

  // No session storage at all: the pictures are in a database of their own and still go.
  const none = load({ session: false });
  none.EditorDraft.removeEditorDraft('editorDraft:test:t1');
  assert.deepEqual(none.shots.del, ['editorDraft:test:t1']);

  // A remove that throws is swallowed — the shots are already gone by then.
  const broken = load({ removeThrows: true });
  broken.EditorDraft.removeEditorDraft('editorDraft:test:t1');
  assert.deepEqual(broken.shots.del, ['editorDraft:test:t1']);
});

// The draft carries its own count, so shots the store lost are still known about.
async function restore(had, back) {
  const env = load();
  env.shots.answer = Array.from({ length: back }, (_, i) => `data:image/jpeg;base64,shot${i}`);
  const out = await env.EditorDraft.readDraftShots({ shots: had }, 'editorDraft:test:t1');
  return { env, out: plain(out) };
}

test('61: every staged shot comes back, and nothing is reported lost', async () => {
  const { out } = await restore(4, 4);
  assert.equal(out.shots.length, 4);
  assert.equal(out.lost, 0);
});

test('62: a store that lost three of four says so, and keeps the one it has', async () => {
  const { out } = await restore(4, 1);
  assert.deepEqual(out.shots, ['data:image/jpeg;base64,shot0']);
  assert.equal(out.lost, 3); // → the plural toast in editor.js
});

test('63: a draft that held one shot and got none back reports exactly one lost', async () => {
  const { out } = await restore(1, 0);
  assert.deepEqual(out.shots, []);
  assert.equal(out.lost, 1); // → the singular toast in editor.js
});

test('64: a draft with no shots never opens the store at all', async () => {
  const { env, out } = await restore(0, 3);
  assert.deepEqual(out, { shots: [], lost: 0 });
  assert.deepEqual(env.shots.get, []);
  const bare = load();
  assert.deepEqual(plain(await bare.EditorDraft.readDraftShots({}, 'k')), { shots: [], lost: 0 });
  assert.deepEqual(plain(await bare.EditorDraft.readDraftShots(null, 'k')), { shots: [], lost: 0 });
  assert.deepEqual(bare.shots.get, []);
});

// An update or reload tears a tab editor down, and its beforeunload dialog cannot survive that.
test('65 (#249): a tab-context editor persists its draft, so a reload does not eat it', () => {
  const env = load();
  const { t } = tracker(env, { ctx: 'tab' });
  t.persistDraftNow();
  assert.equal(env.store.size, 1);
  assert.equal(written(env).title, 'Login works');
});

test('65 (#249): a TAB takes the same 400ms throttle and the same shot write as the panel', () => {
  const env = load();
  const { t } = tracker(env, { ctx: 'tab', shots: ['a'], shotsRev: 1 });
  t.onEdited();
  assert.equal(env.clock.armed(), 1); // the throttled path is live in a tab too…
  assert.deepEqual(env.clock.delays(), [400]);
  env.clock.run();
  assert.equal(written(env).markdown, '### Steps\n\n1. Open');
  assert.deepEqual(env.shots.put, [['editorDraft:test:t1', ['a']]]); // …and the pictures with it
});

// A draft left behind would make the panel restore stale text over what the server holds.
test('65 (#249): a TAB that discards drops its draft and its shots, not just the panel', () => {
  const env = load();
  const { t } = tracker(env, { ctx: 'tab' });
  t.onEdited();
  env.clock.run();
  assert.equal(env.store.size, 1);
  t.clearDirty();
  assert.equal(env.store.size, 0);
  assert.deepEqual(env.shots.del, ['editorDraft:test:t1']);
});

test('65: no storage.session is the only early return left on the write', () => {
  const env = load({ session: false });
  const { t } = tracker(env);
  t.persistDraftNow();
  assert.deepEqual(env.shots.put, []); // not even the pictures — the whole write is off
});

// Without the id, a reload reopens a half-landed create and the retry makes a second test.
test('66b (#112): the draft carries the id of a test already created, and omits it when there is none', () => {
  const half = load();
  tracker(half, { savedId: 'T7' }).t.persistDraftNow();
  assert.equal(written(half).savedId, 'T7');
  const plainEnv = load();
  tracker(plainEnv).t.persistDraftNow();
  assert.equal('savedId' in written(plainEnv), false);
});

test('66: a grid that has not read the server yet leaves `params` off the draft', () => {
  const env = load();
  const { t } = tracker(env, { params: null });
  t.persistDraftNow();
  const draft = written(env);
  assert.equal('params' in draft, false); // absent, not null: the guard against restoring an empty grid
  assert.deepEqual(draft.title, 'Login works');
  assert.deepEqual(draft.priority, 'high');
  assert.equal(draft.test, 't1');
  assert.equal(draft.suite, null);
  assert.equal(draft.shots, 0);
  assert.equal(typeof draft.ts, 'number');

  const ready = load();
  const grid = tracker(ready, { params: { headers: ['email'], rows: [], removed: [] } });
  ready.log.length = 0;
  grid.t.persistDraftNow();
  assert.deepEqual(written(ready).params, { headers: ['email'], rows: [], removed: [] });
});

test('67: nothing recorded leaves `recording` off the draft', () => {
  const env = load();
  const { t } = tracker(env);
  t.persistDraftNow();
  assert.equal('recording' in written(env), false);

  const rec = load();
  const shape = {
    entries: [{ text: 'Click A' }], start: 0, count: 1,
    polished: true, rawItems: [{ text: 'raw', subs: [] }], polishedItems: [{ text: 'nice', subs: [] }],
  };
  tracker(rec, { recording: shape }).t.persistDraftNow();
  assert.deepEqual(written(rec).recording, shape);
});

test('68: the pictures are rewritten only when the strip actually moved', () => {
  const env = load();
  const { t, state } = tracker(env, { shots: ['a'], shotsRev: 1 });
  t.persistDraftNow();
  t.persistDraftNow();
  assert.equal(env.shots.put.length, 1); // twice through, one write
  assert.deepEqual(env.shots.put[0], ['editorDraft:test:t1', ['a']]);
  assert.equal(env.store.size, 1); // …while the draft itself is written every time
  state.shots = ['a', 'b'];
  state.shotsRev = 2;
  t.persistDraftNow();
  assert.equal(env.shots.put.length, 2);
  assert.deepEqual(env.shots.put[1], ['editorDraft:test:t1', ['a', 'b']]);
  assert.equal(written(env).shots, 2); // the count the draft carries for lost shots
});

test('71: a storage.session write that throws still lets the pictures through', () => {
  const env = load({ setThrows: true });
  const { t } = tracker(env, { shots: ['a'], shotsRev: 1 });
  t.persistDraftNow();
  assert.equal(env.store.size, 0); // the draft itself did not land
  assert.equal(env.shots.put.length, 1); // …and the shots write ran anyway
});

test('69: discarding kills the scheduled write BEFORE it removes the draft', () => {
  const env = load();
  const { t } = tracker(env);
  t.markDirty();
  t.schedulePersist();
  assert.equal(env.clock.armed(), 1);
  env.log.length = 0;
  t.clearDirty();
  // Order matters: a clearTimeout after the removal would let a scheduled write restore the draft.
  assert.deepEqual(env.log, ['clearTimeout', 'ShotStore.del', 'session.remove:editorDraft:test:t1']);
  assert.equal(env.clock.armed(), 0);
  env.clock.run();
  assert.equal(env.store.size, 0);
  assert.deepEqual(env.shots.put, []);
});

test('69: a draft already on disk is gone after a discard', () => {
  const env = load();
  const { t } = tracker(env);
  t.onEdited();
  env.clock.run();
  assert.equal(env.store.size, 1);
  t.clearDirty();
  assert.equal(env.store.size, 0);
  assert.deepEqual(env.shots.del, ['editorDraft:test:t1']);
});

test('70: the tab-ctx beforeunload guard is added and removed exactly once', () => {
  const env = load();
  const { t } = tracker(env, { ctx: 'tab' });
  assert.equal(t.isDirty(), false);
  t.markDirty();
  t.markDirty(); // a second keystroke must not stack a second listener
  assert.equal(t.isDirty(), true);
  assert.deepEqual(env.log, ['add:beforeunload']);
  assert.equal(env.listeners.length, 1);
  t.clearDirty();
  t.clearDirty();
  assert.equal(t.isDirty(), false);
  // clearDirty kills the persist timer first and removes the draft last, as case 69 requires.
  assert.deepEqual(env.log, ['add:beforeunload', 'clearTimeout', 'remove:beforeunload',
    'ShotStore.del', 'session.remove:editorDraft:test:t1']);
  assert.equal(env.listeners.length, 0);
  // The handler is the one the browser needs to show its own dialog.
  const ev = { prevented: false, returnValue: null, preventDefault() { this.prevented = true; } };
  t.markDirty();
  env.listeners[0][1](ev);
  assert.equal(ev.prevented, true);
  assert.equal(ev.returnValue, '');
});

test('70: the panel context registers no unload listener, and removes the draft instead', () => {
  const env = load();
  const { t } = tracker(env);
  t.markDirty();
  t.clearDirty();
  assert.deepEqual(env.listeners, []);
  assert.deepEqual(env.log.filter((l) => l.startsWith('add:') || l.startsWith('remove:')), []);
  assert.deepEqual(env.shots.del, ['editorDraft:test:t1']);
});

test('70: onEdited marks, throttles and refreshes the image strip, in that order', () => {
  const env = load();
  const { t, strips } = tracker(env);
  t.onEdited();
  t.onEdited();
  t.onEdited();
  assert.equal(t.isDirty(), true);
  assert.equal(strips(), 3); // the strip follows every keystroke…
  assert.equal(env.clock.armed(), 1); // …the draft write does not
  assert.equal(env.store.size, 0);
  // 400ms, pinned: shorter writes storage on every keystroke, longer is work the tester loses.
  assert.deepEqual(env.clock.delays(), [400, 400, 400]);
  env.clock.run();
  assert.equal(written(env).markdown, '### Steps\n\n1. Open');
});
