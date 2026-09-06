#!/usr/bin/env node
// What extension/evidence/relay.js owes the tester (#173): it is the translator between the hook
// riding inside the page under test (which sees the page but has no chrome.*) and the worker (which
// is the other way round). Two of the things it carries decide whether a recording behaves at all.
// It is the ONLY way a page hook is ever told to STOP — when the tester ends a recording, this is
// what makes the page go quiet — and it is what tells the hook whether the tester allowed response
// bodies to be captured. Get that default backwards and the extension either records bodies nobody
// asked for or loses the one body the tester needed.
// The rows are the ticket's 22, numbered in their names; a row that pins behaviour we are NOT
// changing here gets a second `test.todo` naming the audit finding that will. Companion rows carry a
// letter suffix and drive the same path the other way, so a row asserting "nothing happened" cannot
// pass against a dead stub.
// Run: node --test tests/evidence-relay.test.mjs
import { runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, chromeFake, plain, settle, sharedPath, sourceOf } from './helpers/shared-harness.mjs';

const CHANNEL = '__testomat_evidence__';
const KEY = 'evidenceCaptureBodies';
// SHARED_SRC / SHARED_MODULES=relay.js=<path> point sharedPath at a mutated copy, so a
// falsification run never has to edit the shipped file and risk leaving it edited.
const RELAY = 'evidence/relay.js';

// The relay is a bare IIFE: it publishes nothing and declares no top-level function, so there is no
// export to grab. Every row drives it through the four callbacks it registered and the one post it
// makes at load.
function load(opts = {}) {
  const {
    local = {},                 // storage.local seed
    localFail = {},             // { get: true } makes the config read reject
    noSendMessage = false,      // the guard at :10 — an ISOLATED world without the API
    chromeMode = 'full',        // 'full' | 'undefined' (the binding exists, the value does not)
    noOnMessage = false,        // chrome.runtime.onMessage absent — addListener throws
    onMessageThrows = false,    // the API is there and refuses
    noOnChanged = false,        // chrome.storage.onChanged absent — an older Chrome
    noStorage = false,          // chrome.storage absent entirely — the permission was not granted
    reply = () => ({}),         // what the worker answers a forwarded batch
    replyRejects = false,       // the worker is asleep
    postThrows = false,         // the page tore the frame down under us
  } = opts;

  const fake = chromeFake({ local, localFail });
  const chrome = fake.chrome;
  // Not the permission being denied at a call — the namespace simply is not there, so every
  // reach through `chrome.storage.` is a TypeError rather than a rejected promise.
  if (noStorage) delete chrome.storage;

  const sent = [];              // every chrome.runtime.sendMessage payload, in order
  if (!noSendMessage) {
    chrome.runtime.sendMessage = (msg) => {
      sent.push(plain(msg));
      if (replyRejects) return Promise.reject(new Error('Extension context invalidated'));
      // A reply that throws has to reach the relay as a rejection — the shape a sleeping worker makes.
      try { return Promise.resolve(reply(msg, sent.length)); } catch (e) { return Promise.reject(e); }
    };
  }

  let runtimeListener = null;
  if (!noOnMessage) {
    chrome.runtime.onMessage = {
      addListener: (fn) => {
        if (onMessageThrows) throw new Error('onMessage refused');
        runtimeListener = fn;
      },
    };
  }

  let changedListener = null;
  if (!noOnChanged && !noStorage) {
    chrome.storage.onChanged = { addListener: (fn) => { changedListener = fn; } };
  }

  const posts = [];             // every window.postMessage, in order
  const listeners = [];         // {type, fn} — the relay's only DOM registration
  const sandbox = {
    chrome: chromeMode === 'undefined' ? undefined : chrome,
    console: { warn() {}, error() {} },
  };
  sandbox.window = sandbox;     // `e.source !== window` at :27 depends on this identity
  sandbox.postMessage = (msg, target) => {
    if (postThrows) throw new Error('frame detached');
    posts.push({ msg: plain(msg), target });
  };
  sandbox.addEventListener = (type, fn) => { listeners.push({ type, fn }); };

  const { context } = loadInto(sandbox, [RELAY]);
  // node hands the vm its own global proxy for `window`, not the raw sandbox object, and
  // `e.source !== window` at :27 compares against exactly that.
  const win = runInContext('globalThis', context);

  const msgListener = () => (listeners.find((l) => l.type === 'message') || {}).fn;
  // The token the relay handed the hook, off the first control message that carried one.
  const handed = () => { const p = posts.find((x) => x.msg.tok); return p ? p.msg.tok : undefined; };

  return {
    sandbox,
    context,
    win,
    posts: () => posts.slice(),
    // Every control message carries the per-document token (rows 22a-22c); the rows about WHAT
    // the relay says read past it, and `batch` puts it back on the way in.
    controls: () => posts.map((p) => { const { tok, ...rest } = p.msg; return rest; }),
    tok: handed,
    sent: () => sent.slice(),
    listeners: () => listeners.map((l) => l.type),
    storage: fake.local,
    settle,
    // A batch from the hook WE injected: stamped with the token the relay handed out.
    batch: (events) => ({ source: CHANNEL, tok: handed(), events }),
    // A batch the page hook posted onto the shared DOM channel.
    page: (data, source = win) => {
      const fn = msgListener();
      return fn ? fn({ source, data }) : undefined;
    },
    // A message the worker sent down chrome.runtime.
    worker: (msg) => (runtimeListener ? runtimeListener(msg, {}, () => {}) : undefined),
    hasRuntimeListener: () => runtimeListener != null,
    hasChangedListener: () => changedListener != null,
    change: (changes, area = 'local') => (changedListener ? changedListener(changes, area) : undefined),
  };
}

const control = (payload) => ({ source: CHANNEL, control: true, ...payload });
// Everything a page can build unaided: the channel name is compiled into both halves, so it is
// published, and knowing it is the whole of what a forger has.
const forged = (events) => ({ source: CHANNEL, events });

// ---- the body-capture default (rows 1-4) -----------------------------------

test('1: the tester who never touched the body switch gets bodies — an absent setting means ON', async () => {
  const h = load();
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: true })]);
  assert.deepEqual(h.posts()[0].target, '*');
});

test('2: the tester who turned body capture off has it stay off', async () => {
  const h = load({ local: { [KEY]: false } });
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: false })]);
});

test('3: only a literal false turns bodies off — 0, an empty string and null do not', async () => {
  for (const stored of [0, '', null]) {
    const h = load({ local: { [KEY]: stored } });
    await h.settle();
    assert.deepEqual(h.controls(), [control({ captureBodies: true })], `stored ${JSON.stringify(stored)}`);
  }
});

test('4: a storage read that fails still answers the hook, and answers ON', async () => {
  const h = load({ localFail: { get: true } });
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: true })]);
});

test('4a: the hook is never left waiting — the config post happens at load, before anyone asks', async () => {
  const h = load();
  assert.deepEqual(h.controls(), [], 'the storage read is async, so nothing is posted synchronously');
  await h.settle();
  assert.equal(h.controls().length, 1);
});

// ---- forwarding a batch (rows 5-8) -----------------------------------------

test('5: a batch the page hook posted reaches the worker as EVIDENCE_EVENTS', async () => {
  const h = load();
  await h.settle();
  const events = [{ t: 'console', text: 'Boom' }, { t: 'net', status: 500 }];
  h.page(h.batch(events));
  assert.deepEqual(h.sent(), [{ type: 'EVIDENCE_EVENTS', events }]);
});

test('6: a batch from an iframe or an opener is not this page, and is ignored', async () => {
  const h = load();
  await h.settle();
  h.page(h.batch([{ t: 'console' }]), { other: 'window' });
  assert.deepEqual(h.sent(), []);
});

test('7: the relay does not eat its own output — a control message is never forwarded', async () => {
  const h = load();
  h.page({ source: CHANNEL, control: true, events: [{ t: 'console' }] });
  assert.deepEqual(h.sent(), []);
});

test('8: anything on the channel that is not a batch of events is ignored', async () => {
  const h = load();
  for (const data of [null, undefined, 'ready', 42, { source: 'other', events: [] },
    { source: CHANNEL }, { source: CHANNEL, events: 'ready' }, { source: CHANNEL, events: { 0: 'a' } }]) {
    h.page(data);
  }
  assert.deepEqual(h.sent(), []);
});

test('8a: an empty batch is still a batch — it reaches the worker and can be answered', async () => {
  const h = load();
  await h.settle();
  h.page(h.batch([]));
  assert.deepEqual(h.sent(), [{ type: 'EVIDENCE_EVENTS', events: [] }]);
});

// ---- the reply path (rows 9-12) --------------------------------------------

test('9: the worker with no recording for this page tells the hook to stop, and the hook is told', async () => {
  const h = load({ reply: () => ({ off: true }) });
  await h.settle();
  h.page(h.batch([{ t: 'console' }]));
  await h.settle();
  assert.deepEqual(h.controls().slice(1), [control({ off: true })]);
});

test('9a: the stop lands a microtask later, not while the page is still posting', async () => {
  const h = load({ reply: () => ({ off: true }) });
  await h.settle();
  h.page(h.batch([{ t: 'console' }]));
  assert.deepEqual(h.controls().slice(1), [], 'nothing yet — the worker has not answered');
  await h.settle();
  assert.equal(h.controls().length, 2);
});

test('10: a hook saying hello to a recording that IS running gets the body-capture answer', async () => {
  const h = load({ local: { [KEY]: false }, reply: () => ({ off: false }) });
  await h.settle();
  h.page(h.batch([{ t: 'ready' }, { t: 'console' }]));
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: false }), control({ captureBodies: false })]);
});

test('10a: a worker that answers nothing at all still gets the ready re-answered', async () => {
  const h = load({ reply: () => undefined });
  await h.settle();
  h.page(h.batch([{ t: 'ready' }]));
  await h.settle();
  assert.equal(h.controls().length, 2, 'no reply is not the same as `off`');
});

test('11: an ordinary batch with no hello does not re-post the config', async () => {
  const h = load({ reply: () => ({ off: false }) });
  await h.settle();
  h.page(h.batch([{ t: 'console' }, { t: 'net' }]));
  await h.settle();
  assert.equal(h.controls().length, 1, 'only the config from load');
});

test('11a: a null row inside the batch does not crash the hello scan', async () => {
  const h = load({ reply: () => ({ off: false }) });
  await h.settle();
  h.page(h.batch([null, undefined, { t: 'ready' }]));
  await h.settle();
  assert.equal(h.controls().length, 2);
});

test('12: a batch the sleeping worker never took is dropped, not retried and not buffered', async () => {
  const h = load({ replyRejects: true });
  await h.settle();
  h.page(h.batch([{ t: 'console', text: 'the one the tester needed' }]));
  await h.settle();
  assert.equal(h.sent().length, 1, 'sent once');
  assert.equal(h.controls().length, 1, 'no control message came of it');
  h.page(h.batch([{ t: 'console' }]));
  await h.settle();
  assert.equal(h.sent().length, 2, 'and the next batch is still attempted');
});

// ---- the worker's own channel (rows 13-15) ---------------------------------

test('13: ending a recording mutes the hook of a page that never navigated', async () => {
  const h = load();
  await h.settle();
  h.worker({ type: 'EVIDENCE_HOOK_OFF' });
  assert.deepEqual(h.controls().slice(1), [control({ off: true })]);
});

test('14: starting a new recording un-mutes that same page and re-sends the body switch', async () => {
  const h = load({ local: { [KEY]: false } });
  await h.settle();
  h.worker({ type: 'EVIDENCE_HOOK_ON' });
  await h.settle();
  assert.deepEqual(h.controls().slice(1),
    [control({ off: false }), control({ captureBodies: false })]);
});

test('15: any other worker message is left alone — the relay never claims the reply channel', async () => {
  const h = load();
  await h.settle();
  for (const msg of [null, undefined, {}, { type: 'STEPREC_ADD' }, { type: 'EVIDENCE_WIPE' }]) {
    assert.equal(h.worker(msg), undefined, JSON.stringify(msg));
  }
  assert.equal(h.controls().length, 1, 'and nothing was posted to the page');
});

// ---- the config change (rows 16-17) ----------------------------------------

test('16: the tester flipping the body switch mid-recording reaches the page at once', async () => {
  const h = load();
  await h.settle();
  h.storage.data[KEY] = false;
  h.change({ [KEY]: { newValue: false } }, 'local');
  await h.settle();
  assert.deepEqual(h.controls().slice(1), [control({ captureBodies: false })]);
});

test('17: a change to some other key, or in some other area, is not the body switch', async () => {
  const h = load();
  await h.settle();
  h.change({ [KEY]: { newValue: false } }, 'session');
  h.change({ settings: { newValue: {} } }, 'local');
  await h.settle();
  assert.equal(h.controls().length, 1);
});

// ---- loading in a world that cannot help (rows 18-21) ----------------------

test('18: an isolated world with no runtime API registers nothing and posts nothing', async () => {
  const h = load({ noSendMessage: true });
  await h.settle();
  assert.deepEqual(h.listeners(), [], 'no message listener');
  assert.equal(h.hasRuntimeListener(), false);
  assert.equal(h.hasChangedListener(), false);
  assert.deepEqual(h.controls(), [], 'and the hook was never told anything');
});

test('18a: a `chrome` that exists but is undefined is survivable, and the relay stands down', async () => {
  const h = load({ chromeMode: 'undefined' });
  await h.settle();
  assert.deepEqual(h.listeners(), []);
  assert.deepEqual(h.controls(), []);
});

test('18b: standing down still claims the document, so a later healthy injection is swallowed too', async () => {
  const h = load({ noSendMessage: true });
  assert.equal(h.sandbox.__testomatEvRelay, true);
});

test('19: injecting the relay twice into one document does not double every batch', async () => {
  const h = load();
  await h.settle();
  const before = h.listeners().length;
  runInContext(sourceOf(sharedPath(RELAY)), h.context); // the worker retries a missing registration
  await h.settle();
  assert.equal(h.listeners().length, before, 'the second load returned at the guard');
  assert.equal(h.controls().length, 1, 'and did not re-announce the config');
});

test('20: a runtime channel that refuses the listener still leaves the page forwarding', async () => {
  const h = load({ onMessageThrows: true });
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: true })], 'the config still went out');
  h.page(h.batch([{ t: 'console' }]));
  assert.equal(h.sent().length, 1, 'and the page channel still forwards');
});

test('20a: an older Chrome with no onMessage at all is the same story', async () => {
  const h = load({ noOnMessage: true });
  await h.settle();
  assert.equal(h.controls().length, 1);
  h.page(h.batch([{ t: 'console' }]));
  assert.equal(h.sent().length, 1);
});

test('21: an older Chrome with no storage.onChanged loads anyway', async () => {
  const h = load({ noOnChanged: true });
  await h.settle();
  assert.deepEqual(h.controls(), [control({ captureBodies: true })]);
  h.page(h.batch([{ t: 'console' }]));
  assert.equal(h.sent().length, 1);
});

test('21a: a page that tore the frame down under us swallows the post instead of throwing', async () => {
  const h = load({ postThrows: true });
  await h.settle();
  assert.deepEqual(h.controls(), [], 'nothing recorded, and the load did not throw');
  h.worker({ type: 'EVIDENCE_HOOK_OFF' });
  assert.deepEqual(h.controls(), []);
});

// A build without the `storage` permission is the one world where the relay can end up neither
// installed nor stood down: the config read is the last thing the file does and the only thing in
// it that reaches `chrome.storage` unguarded. The three rows below are the three ways that shows.

test('21b (#343): a world with no chrome.storage installs the relay whole, not halfway', async () => {
  const h = load({ noStorage: true });
  await h.settle();
  assert.deepEqual(h.listeners(), ['message'], 'the page channel is live');
  assert.equal(h.hasRuntimeListener(), true, 'and so is the worker channel');
  assert.deepEqual(h.controls(), [control({ captureBodies: true })],
    'and the hook was answered: a setting that cannot be read is ON, exactly as in row 4');
});

test('21c (#343): with no storage, starting a recording still un-mutes the page instead of throwing', async () => {
  const h = load({ noStorage: true });
  await h.settle();
  h.worker({ type: 'EVIDENCE_HOOK_ON' });
  await h.settle();
  assert.deepEqual(h.controls().slice(1),
    [control({ off: false }), control({ captureBodies: true })]);
});

test('21d (#343): with no storage, a hook that missed the config is still handed its token', async () => {
  const h = load({ noStorage: true });
  await h.settle();
  h.page(forged([{ t: 'ready' }]));   // the hello of a hook that installed before us
  await h.settle();
  assert.equal(h.controls().length, 2, 'the hello was answered');
  assert.equal(h.posts()[1].msg.tok, h.tok(), 'so the hook can stamp what it posts next');
  h.page(h.batch([{ t: 'console', text: 'Boom' }]));
  assert.deepEqual(h.sent(), [{ type: 'EVIDENCE_EVENTS', events: [{ t: 'console', text: 'Boom' }] }],
    'and what it posts next is believed — a mute hook records nothing at all');
});

// ---- whose batch it is (row 22) --------------------------------------------

// The evidence log is what the tester attaches to a ticket as proof. A row in it that the page
// wrote, not the hook, is a lie the tester will never spot — so the relay believes the token it
// handed its own hook and nothing else.
const EVIDENCE = [{ t: 'net', status: 500, url: 'https://bank.example.com/statement' }];

test('22: a batch the page forged is refused — only the hook we injected is believed', async () => {
  const h = load();
  await h.settle();
  h.page(forged(EVIDENCE));
  assert.deepEqual(h.sent(), [], 'the channel name is in both halves, so knowing it proves nothing');
});

test('22a: the very same events from our hook go through — the token is the whole difference', async () => {
  const h = load();
  await h.settle();
  h.page(h.batch(EVIDENCE));
  assert.deepEqual(h.sent(), [{ type: 'EVIDENCE_EVENTS', events: EVIDENCE }]);
});

// The comparison is `!==` against a string, and it has to stay that way: a single-element array
// stringifies to the element, so anything looser lets a lookalike through. No worse than knowing
// the token outright — but the strictness is the fix, and a fix nothing asks about drifts.
test('22e: a token-shaped lookalike is not the token — the comparison is strict, not coerced', async () => {
  const h = load();
  await h.settle();
  for (const tok of [[h.tok()], { toString: () => h.tok() }, `${h.tok()} `, null, undefined, 0]) {
    h.page({ source: CHANNEL, tok, events: EVIDENCE });
  }
  assert.deepEqual(h.sent(), [], 'only the string the relay minted is the string the relay minted');
});

test('22b: a row of a kind this hook never emits is dropped before the worker files it', async () => {
  const h = load();
  await h.settle();
  h.page(h.batch([{ t: 'console', text: 'real' }, { t: 'wire', text: 'not ours' }, 'nope', null]));
  assert.deepEqual(h.sent(), [{ type: 'EVIDENCE_EVENTS', events: [{ t: 'console', text: 'real' }] }]);
});

test('22c: the token is minted per document, not compiled in — two relays never share one', async () => {
  const a = load();
  const b = load();
  await a.settle();
  await b.settle();
  assert.equal(typeof a.tok(), 'string');
  assert.ok(a.tok().length >= 8, `too short to be worth minting: ${a.tok()}`);
  assert.notEqual(a.tok(), b.tok());
});

test('22d: a hook that missed the config is handed a token, not believed on its word', async () => {
  const h = load();
  await h.settle();
  h.page(forged([{ t: 'ready' }]));   // the hook's first hello, sent before it heard from us
  await h.settle();
  assert.deepEqual(h.sent(), [], 'a hello is a cue, not evidence');
  assert.equal(h.controls().length, 2, 'and the config went out again so the hook learns the token');
  assert.equal(h.posts()[1].msg.tok, h.tok(), 'the same token, not a fresh one');
});

// ---- the shape of every control message ------------------------------------

test('23: every message the relay puts on the page channel is marked as its own control', async () => {
  const h = load({ reply: () => ({ off: true }) });
  await h.settle();
  h.page(h.batch([{ t: 'console' }]));
  await h.settle();
  h.worker({ type: 'EVIDENCE_HOOK_ON' });
  await h.settle();
  assert.ok(h.posts().length >= 4);
  for (const { msg, target } of h.posts()) {
    assert.equal(msg.source, CHANNEL);
    assert.equal(msg.control, true, 'or the relay would forward its own output back to the worker');
    assert.equal(target, '*');
  }
});
