#!/usr/bin/env node
// The little editor-tab screen that hosts the annotator when the page under test could not host
// it: read the capture out of the `?annotate=<key>` handoff, run the engine on it, write the
// answer back under the SAME key and close the tab. Its one hard contract is that it writes once —
// a second write is what would put an un-blurred original back over an applied result.
// Run: node --test tests/editor-annotate.test.mjs

// `key` and `done` are module state, so this file loads a fresh sandbox per row.
// AnnotateCore is stubbed: nothing here draws, and `handle.hooks` only has to be recognisable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { makeDocument } from './helpers/mini-dom.mjs';
import { sharedPath, sourceOf, settle } from './helpers/shared-harness.mjs';

// The only shape anything really produces: capture-annotate.js writes `annotate-<randomUUID()>`.
const KEY = 'annotate-0f2b1c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const SHOT = 'data:image/png;base64,SHOT';

function load(over = {}) {
  const cfg = {
    store: {},
    getFails: false,
    setFails: false,
    noSession: false,
    noTabs: false,
    currentTab: { id: 7 },
    confirmAnswer: true,
    ...over,
  };
  const doc = makeDocument(['div#root']);
  const calls = { gets: [], sets: [], removed: [], closed: 0, confirms: [], created: [], annotAtCreate: 'unset' };
  const hooks = { ready: false, tag: 'the core hooks' };

  const win = {
    confirm: (text) => { calls.confirms.push(text); return cfg.confirmAnswer; },
    close: () => { calls.closed += 1; },
  };
  const session = {
    async get(k) {
      calls.gets.push(k);
      if (cfg.getFails) throw new Error('the session store is gone');
      return k in cfg.store ? { [k]: cfg.store[k] } : {};
    },
    async set(patch) {
      calls.sets.push(JSON.parse(JSON.stringify(patch)));
      if (cfg.setFails) throw new Error('quota');
    },
  };
  const sandbox = {
    window: win,
    document: doc,
    chrome: {
      storage: cfg.noSession ? {} : { session },
      tabs: cfg.noTabs ? undefined : {
        getCurrent: (cb) => cb(cfg.currentTab),
        remove: (id) => { calls.removed.push(id); },
      },
    },
    AnnotateCore: {
      create: (opts) => {
        calls.created.push(opts);
        calls.annotAtCreate = win.__annot;   // line 63 runs only after create() returns
        return { hooks };
      },
    },
    console,
  };
  const context = createContext(sandbox);
  const path = sharedPath('editor/annotate.js');
  runInContext(sourceOf(path), context, { filename: path });

  return {
    Annotate: win.Annotate,
    win,
    doc,
    hooks,
    calls,
    cfg,
    root: () => doc.getElementById('root'),
    opts: () => calls.created[0],
  };
}

const boot = async (over, key = KEY) => {
  const h = load(over);
  await h.Annotate.init(key);
  return h;
};

// Hand the answer back through the callback the core was given, and let the write settle.
async function handBack(h, how, value) {
  if (how === 'apply') h.opts().onApply(value); else h.opts().onCancel();
  await settle();
}

// ---- the four ways the boot gives up ----------------------------------------

test('AN1: opening the annotator tab with no handoff key at all says there is nothing to annotate', async () => {
  for (const key of ['', null]) {
    const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } }, key);
    assert.equal(h.root().textContent, 'Nothing to annotate.');
    assert.deepEqual(h.calls.created, [], 'the engine is never started');
    assert.deepEqual(h.calls.gets, [], 'and nothing is read');
    assert.deepEqual(h.calls.sets, [], 'and nothing is written');
  }
});

test('AN2: a browser with no session store to read the capture from says the same thing', async () => {
  const h = await boot({ noSession: true });
  assert.equal(h.root().textContent, 'Nothing to annotate.');
  assert.deepEqual(h.calls.created, []);
  assert.deepEqual(h.calls.sets, []);
});

test('AN3: a handoff that expired before the tab opened says so, rather than throwing', async () => {
  const h = await boot({ getFails: true });
  assert.equal(h.root().textContent, 'Nothing to annotate (the image handoff expired).');
  assert.deepEqual(h.calls.gets, [KEY], 'it did try to read');
  assert.deepEqual(h.calls.created, []);
  assert.deepEqual(h.calls.sets, []);
});

test('AN4: a handoff record that is there but carries no picture reads as expired too', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: undefined } } });
  assert.equal(h.root().textContent, 'Nothing to annotate (the image handoff expired).');
  assert.deepEqual(h.calls.created, []);
});

// ---- the happy path and the hand-back ---------------------------------------

test('AN5: the capture reaches the engine, and the e2e handle is published before it is ready', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });

  assert.equal(h.doc.title, 'Annotate screenshot');
  assert.equal(h.calls.created.length, 1);
  const opts = h.opts();
  assert.deepEqual(Object.keys(opts).sort(),
    ['confirmDiscard', 'confirmKeep', 'dataUrl', 'doc', 'mount', 'onApply', 'onCancel', 'onReady'].sort());
  assert.equal(opts.dataUrl, SHOT);
  assert.equal(opts.mount, h.root());
  assert.equal(opts.doc, h.doc);

  assert.equal(h.calls.annotAtCreate, undefined, 'nothing was published while create() was running');
  assert.equal(h.win.__annot, h.hooks, 'the handle is up straight away, so `ready` can be polled');

  const later = { ready: true };
  opts.onReady(later);
  assert.equal(h.win.__annot, later, 'and onReady replaces it with the same object once it is ready');
});

test('AN6: Save writes the annotated image back under the key it came from, then closes the tab', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });
  await handBack(h, 'apply', 'data:image/jpeg;base64,OUT');

  assert.deepEqual(h.calls.sets, [{ [KEY]: { resultDataUrl: 'data:image/jpeg;base64,OUT' } }]);
  assert.deepEqual(h.calls.removed, [7], 'the tab closes itself');
});

test('AN7: Discard writes a cancellation under the same key, then closes the tab', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });
  await handBack(h, 'cancel');

  assert.deepEqual(h.calls.sets, [{ [KEY]: { cancelled: true } }]);
  assert.deepEqual(h.calls.removed, [7]);
});

test('AN8: a second answer after the first is ignored — nothing can overwrite the applied result', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });
  h.opts().onApply('data:image/jpeg;base64,OUT');
  h.opts().onCancel();
  await settle();

  assert.deepEqual(h.calls.sets, [{ [KEY]: { resultDataUrl: 'data:image/jpeg;base64,OUT' } }]);
  assert.deepEqual(h.calls.removed, [7], 'and the tab is closed once');
});

test('AN9: a store that refuses the write still closes the tab instead of hanging on it', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } }, setFails: true });
  await handBack(h, 'apply', 'data:image/jpeg;base64,OUT');

  assert.equal(h.calls.sets.length, 1);
  assert.deepEqual(h.calls.removed, [7]);
});

// ---- closing the tab it lives in --------------------------------------------

test('AN10: the annotator tab closes itself by its own tab id', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } }, currentTab: { id: 7 } });
  await handBack(h, 'apply', 'x');

  assert.deepEqual(h.calls.removed, [7]);
  assert.equal(h.calls.closed, 0, 'no need for the window fallback');
});

test('AN11: with no tab id to close, it falls back to closing the window', async () => {
  for (const tab of [null, { id: null }]) {
    const h = await boot({ store: { [KEY]: { dataUrl: SHOT } }, currentTab: tab });
    await handBack(h, 'apply', 'x');

    assert.deepEqual(h.calls.removed, []);
    assert.equal(h.calls.closed, 1);
  }
});

test('AN12: with no tabs API at all it still gets out of the way', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } }, noTabs: true });
  await handBack(h, 'apply', 'x');

  assert.equal(h.calls.closed, 1);
  assert.equal(h.calls.sets.length, 1, 'the answer was still written');
});

// ---- the key it trusts, and the wording it owns ------------------------------

test.todo('AN13 (#318): the annotator reads and overwrites whatever storage key its URL names', async () => {
  for (const bad of ['settings', 'stepRec', '../x']) {
    const h = await boot({ store: { [bad]: { dataUrl: SHOT } } }, bad);
    assert.deepEqual(h.calls.gets, [], `?annotate=${bad} is not a handoff key and must not be read`);
    assert.deepEqual(h.calls.created, [], 'nor handed to the engine');
    assert.ok(h.root().querySelector('.annot-msg'), 'the tester is told instead');
  }
});

test('AN14: Keep original names the blur it is about to un-hide, and says something else without one', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });

  assert.equal(h.opts().confirmKeep(true), true);
  assert.equal(h.opts().confirmKeep(false), true);
  const [withBlur, without] = h.calls.confirms;
  assert.match(withBlur, /blurred/, 'the tester is told the redaction is coming back');
  assert.notEqual(withBlur, without, 'a shot with no blur gets its own, milder sentence');
  assert.match(without, /drop the annotations/);
});

test('AN15: Discard asks its own question, and the engine is handed a real function to ask with', async () => {
  const h = await boot({ store: { [KEY]: { dataUrl: SHOT } } });

  assert.equal(typeof h.opts().confirmDiscard, 'function');
  assert.equal(h.opts().confirmDiscard(), true);
  assert.deepEqual(h.calls.confirms, ['Discard the screenshot and its annotations?']);

  const said = await boot({ store: { [KEY]: { dataUrl: SHOT } }, confirmAnswer: false });
  assert.equal(said.opts().confirmDiscard(), false, 'and saying no comes back as no');
});
