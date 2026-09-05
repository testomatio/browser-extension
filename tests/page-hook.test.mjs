#!/usr/bin/env node
// What extension/evidence/page-hook.js owes the tester (#172): while they reproduce a bug it rides
// inside the page under test and writes down what the page's own code does — every console error,
// every failed request, and, when the tester allowed it, the first 16 KB of the failing response.
// It is the half of the evidence log Chrome's own network events cannot see.
// Its FIRST duty is to be invisible. It replaces the page's console.error, fetch and XMLHttpRequest
// with wrappers, so a wrapper that throws, swallows a rejection or hands back a different response
// breaks the site the tester is testing — and they will blame the site, not us. Its second duty is
// not to say the same thing twice: a thrown error is usually both logged by the page and reported by
// the browser, and the tester should see one line, not two.
// The 16 KB body cap lives HERE, in the page — the worker stores whatever arrives with no cap of its
// own (tests/evidence-recorder.test.mjs rows 21-23), so these rows are the only thing holding it.
// The rows are the ticket's 62, numbered in their names. Companion rows carry a letter suffix and
// drive the same path the other way, so a row asserting "nothing happened" cannot pass against a
// dead stub.
// Run: node --test tests/page-hook.test.mjs
import { runInContext } from 'node:vm';
import { isNativeError } from 'node:util/types';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle, sharedPath, sourceOf } from './helpers/shared-harness.mjs';

const CHANNEL = '__testomat_evidence__';
const BODY_CAP = 16 * 1024;
const TEXT_CAP = 4000;
const NOW = 1_700_000_000_000;
const SITE = 'https://shop.example.com';
const PAGE = `${SITE}/cart`;
// SHARED_SRC / SHARED_MODULES=page-hook.js=<path> point sharedPath at a mutated copy, so a
// falsification run never has to edit the shipped file and risk leaving it edited.
const HOOK = 'evidence/page-hook.js';

// ---- the page's own XMLHttpRequest -----------------------------------------

// The prototype the hook patches. `responseText` throws for a non-text responseType exactly as a
// browser does, so a row can prove the hook never touched the page's own blob.
class FakeXHR {
  constructor() {
    this.status = 0;
    this.responseType = '';
    this.response = null;
    this.headers = { 'content-type': 'application/json' };
    this.headerThrows = false;
    this.opened = [];     // every original open(), in order
    this.sent = [];       // every original send(), in order
    this.__text = '';
    this.__ls = new Map();
  }

  get responseText() {
    if (this.responseType !== '' && this.responseType !== 'text') throw new Error('InvalidStateError');
    return this.__text;
  }

  set responseText(v) { this.__text = v; }

  addEventListener(type, fn) {
    if (!this.__ls.has(type)) this.__ls.set(type, []);
    this.__ls.get(type).push(fn);
  }

  getResponseHeader(name) {
    if (this.headerThrows) throw new Error('InvalidStateError');
    return this.headers[String(name).toLowerCase()] || null;
  }

  open(...args) { this.opened.push(args); return 'the page\'s own open'; }

  send(...args) { this.sent.push(args); return 'the page\'s own send'; }

  emit(type) { for (const fn of (this.__ls.get(type) || []).slice()) fn(); }
}

// ---- the page's own Response -----------------------------------------------

/** A believable `fetch` response plus the counters readCapped() is judged by. */
function response(opts = {}) {
  const {
    status = 200, type = 'basic', contentType = 'application/json',
    text = '', bytes = null, chunkSize = 8192,
    cloneThrows = false, typeThrows = false, noBody = false, textThrows = false,
  } = opts;
  const state = { clones: 0, cancelled: 0, chunks: 0 };
  const data = bytes || Buffer.from(text, 'utf8');
  const cloned = () => ({
    async text() { if (textThrows) throw new TypeError('already read'); return text; },
    body: noBody ? null : {
      getReader() {
        let at = 0;
        return {
          async read() {
            if (at >= data.length) return { done: true, value: undefined };
            const end = Math.min(at + chunkSize, data.length);
            const value = data.subarray(at, end);
            at = end;
            state.chunks += 1;
            return { done: false, value };
          },
          async cancel() { state.cancelled += 1; },
        };
      },
    },
  });
  const res = {
    status,
    get type() { if (typeThrows) throw new Error('poisoned'); return type; },
    headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? contentType : null) },
    clone() { state.clones += 1; if (cloneThrows) throw new TypeError('body already used'); return cloned(); },
  };
  return { res, state };
}

// ---- the load --------------------------------------------------------------

// The hook is a bare IIFE: it publishes nothing but a double-init flag and declares no top-level
// function, so there is no export to grab. Every row drives it through the globals it patched and
// the listeners it registered.
function load(opts = {}) {
  const {
    now = NOW,
    baseURI = PAGE,
    noBaseURI = false,          // a document with no usable base — abs() falls back to String(u)
    href = PAGE,
    stack = '',                 // what `new Error().stack` reads inside callSite()
    postThrows = false,
    noFetch = false,            // a world without window.fetch
    noXHR = false,              // a world without XMLHttpRequest
    consoleError,               // pass a non-function to refuse the patch
    reenter = 0,                // the page's own console.error calls back into ours
  } = opts;

  let clock = now;
  let stackText = stack;
  const posts = [];             // every window.postMessage, in order
  const winListeners = [];      // {type, fn, capture}
  const docListeners = [];
  const consoleCalls = [];      // every call that reached the page's OWN console
  const origFetchCalls = [];    // every call that reached the page's OWN fetch
  let reentered = 0;
  let fetchAnswer = () => Promise.resolve(response({ status: 200 }).res);

  // `new Error()` with no arguments is only ever callSite() asking where it is; a synthetic stack is
  // the only stable one, since Node's frames read nothing like Chrome's.
  class PageError extends Error {
    constructor(...args) {
      super(...args);
      if (!args.length) this.stack = stackText;
    }

    // The page has one realm; a test's Error and a vm Error must both answer `instanceof Error`.
    static [Symbol.hasInstance](v) { return isNativeError(v); }
  }

  let seq = 0;
  const timers = new Map();

  const con = {
    error: (...args) => {
      consoleCalls.push({ name: 'error', args });
      if (reentered < reenter) { reentered += 1; sandbox.console.error('the logger logging'); }
      return 'the page\'s own console.error';
    },
    warn: (...args) => { consoleCalls.push({ name: 'warn', args }); return 'the page\'s own console.warn'; },
  };
  if ('consoleError' in opts) con.error = consoleError;

  const sandbox = {
    console: con,
    document: {
      baseURI: noBaseURI ? undefined : baseURI,
      addEventListener: (type, fn, capture) => docListeners.push({ type, fn, capture }),
    },
    location: { href },
    Date: { now: () => clock },
    Error: PageError,
    URL,
    TextDecoder,
    Request: class Request {
      constructor(input, init = {}) {
        this.url = new URL(String(input), noBaseURI ? undefined : baseURI).href;
        this.method = init.method || 'GET';
      }
    },
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  sandbox.window = sandbox;
  sandbox.postMessage = (msg, target) => {
    if (postThrows) throw new Error('the page killed the frame');
    posts.push({ msg: plain(msg), target });
  };
  sandbox.addEventListener = (type, fn, capture) => { winListeners.push({ type, fn, capture }); };
  if (!noFetch) {
    sandbox.fetch = function fetch(...args) {
      origFetchCalls.push({ self: this, args });
      return fetchAnswer.apply(this, args);
    };
  }
  if (!noXHR) sandbox.XMLHttpRequest = FakeXHR;

  const { context } = loadInto(sandbox, [HOOK]);
  // node hands the vm its own global proxy for `window`, not the raw sandbox object, and both
  // `e.source !== window` (:52) and `el !== window` (:205) compare against exactly that.
  const win = runInContext('globalThis', context);

  const fireMs = (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); }
  };
  const events = () => posts.flatMap((p) => p.msg.events || []);
  const call = (list, type, ev) => {
    for (const l of list.slice()) if (l.type === type) l.fn(ev);
  };

  return {
    sandbox,
    context,
    win,
    posts: () => posts.slice(),
    events,
    kinds: () => events().map((e) => e.t),
    nets: () => events().filter((e) => e.t === 'net'),
    consoleCalls: () => consoleCalls.slice(),
    origFetchCalls: () => origFetchCalls.slice(),
    winListeners: () => winListeners.map((l) => ({ type: l.type, capture: l.capture })),
    docListeners: () => docListeners.map((l) => ({ type: l.type, capture: l.capture })),

    setNow: (t) => { clock = t; },
    advance: (ms) => { clock += ms; },
    setStack: (s) => { stackText = s; },
    answerWith: (fn) => { fetchAnswer = fn; },
    pending: () => [...timers.values()].map((t) => t.ms),
    fireMs,

    // The batch window is 200 ms; three turns covers a row whose flush produces another row.
    drain: async () => {
      for (let i = 0; i < 3; i += 1) { await settle(); fireMs(200); }
      await settle();
      return events();
    },

    fetch: (...args) => sandbox.fetch(...args),
    xhr: () => new FakeXHR(),
    reload: () => runInContext(sourceOf(sharedPath(HOOK)), context),

    message: (data, source = win) => call(winListeners, 'message', { source, data }),
    control: (payload, source = win) => call(winListeners, 'message',
      { source, data: { source: CHANNEL, control: true, ...payload } }),
    errorEvent: (ev = {}) => call(winListeners, 'error', { target: win, ...ev }),
    rejection: (ev = {}) => call(winListeners, 'unhandledrejection', ev),
    csp: (ev = {}) => call(docListeners, 'securitypolicyviolation', ev),
    pagehide: () => call(winListeners, 'pagehide', {}),
  };
}

/** An element the way the capture-phase `error` listener sees one. */
const element = (tagName, props = {}) => ({ nodeType: 1, tagName, ...props });
/** An Error with the stack a row wants; `instanceof Error` still answers true inside the vm. */
const erroring = (message, stack) => Object.assign(new Error(message), stack === undefined ? {} : { stack });

// ============================================================================
// Batching and the control channel
// ============================================================================

test('1: a page logging all afternoon does not post a message per line — 39 rows wait for the window', async () => {
  const h = load();
  for (let i = 0; i < 39; i += 1) h.sandbox.console.error(`row ${i}`);
  assert.equal(h.posts().length, 1, 'only the handshake went out');
  assert.deepEqual(h.pending(), [200], 'one batch window pending');
});

test('2: the fortieth row does not wait — a busy page flushes on the spot', async () => {
  const h = load();
  for (let i = 0; i < 40; i += 1) h.sandbox.console.error(`row ${i}`);
  assert.equal(h.posts().length, 2);
  assert.equal(h.posts()[1].msg.events.length, 40, 'the whole batch, once');
  assert.deepEqual(h.pending(), [], 'and the timer was cleared, not left to fire on an empty queue');
  h.fireMs(200);
  assert.equal(h.posts().length, 2);
});

test('3: once the recording is over the page keeps working and nothing more is recorded', async () => {
  const h = load();
  h.control({ off: true });
  h.sandbox.console.error('after the stop');
  assert.deepEqual(await h.drain(), [{ t: 'ready', ts: NOW, url: PAGE }]);
  assert.equal(h.consoleCalls().length, 1, 'and the page still got its own log');
});

test('4: the stop throws away what was queued — a finished recording gains nothing after the fact', async () => {
  const h = load();
  h.sandbox.console.error('one');
  h.sandbox.console.error('two');
  h.control({ off: true });
  assert.deepEqual(await h.drain(), [{ t: 'ready', ts: NOW, url: PAGE }]);
});

test('5: a new recording on a page that never navigated un-mutes the hook and says hello again', async () => {
  const h = load();
  h.control({ off: true });
  h.setNow(NOW + 5000);
  h.control({ off: false });
  h.sandbox.console.error('recording again');
  const evs = await h.drain();
  assert.deepEqual(evs[1], { t: 'ready', ts: NOW + 5000, url: PAGE });
  assert.equal(evs[2].text, 'recording again');
});

test('6: a control message from an iframe or an opener is not ours, and is ignored', async () => {
  const h = load();
  h.control({ off: true }, { some: 'other window' });
  h.sandbox.console.error('still recording');
  assert.equal((await h.drain()).length, 2, 'the hook never went quiet');
});

test('7: a message on some other channel, or with no control flag, is not ours', async () => {
  const h = load();
  for (const data of [null, undefined, 'off', { source: 'other', control: true, off: true },
    { source: CHANNEL, off: true }]) {
    h.message(data);
  }
  h.sandbox.console.error('still recording');
  assert.equal((await h.drain()).length, 2);
});

test('8: a relay that loaded after us gets one hello, however many times it repeats the config', async () => {
  const h = load();
  h.control({ captureBodies: true });
  h.control({ captureBodies: false });
  h.control({ captureBodies: true });
  const readies = (await h.drain()).filter((e) => e.t === 'ready');
  assert.equal(readies.length, 2, 'the one at load and one re-announcement, not one per message');
});

test('8b: a fresh un-mute is a fresh recording, and earns a hello of its own', async () => {
  const h = load();
  h.control({ captureBodies: true });   // the re-announce for this recording is spent
  h.control({ off: false });
  assert.equal((await h.drain()).filter((e) => e.t === 'ready').length, 3,
    'the worker has to learn this frame is hooked before it will keep the rows');
});

test('8a: the stop is not a hello — a mute never re-announces the hook to the worker', async () => {
  const h = load();
  h.control({ off: true });
  assert.equal((await h.drain()).filter((e) => e.t === 'ready').length, 1,
    'off returns before the re-announce, so a stopped recording is not restarted by its own stop');
});

test('9: a body read that arrives before the privacy answer waits for it instead of guessing', async () => {
  const h = load();
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'the failure' }).res));
  h.fetch('/api/save');
  assert.deepEqual((await h.drain()).filter((e) => e.t === 'net'), [], 'nothing posted while it waits');
  h.control({ captureBodies: true });
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, 'the failure');
});

test('10: a privacy switch never guesses — an answer that never comes means NO after three seconds', async () => {
  const h = load();
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'the failure' }).res));
  h.fetch('/api/save');
  await settle();
  assert.ok(h.pending().includes(3000), 'the give-up timer is armed');
  h.fireMs(3000);
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySkipped, true);
  assert.equal(net.bodySnippet, null);
});

test('11: once the answer has landed the next read does not wait again', async () => {
  const h = load();
  h.control({ captureBodies: false });
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'x' }).res));
  h.fetch('/api/save');
  await settle();
  assert.equal(h.pending().includes(3000), false, 'no second give-up timer');
  assert.equal((await h.drain()).find((e) => e.t === 'net').bodySkipped, true);
});

// ============================================================================
// The text the tester reads
// ============================================================================

test('12: a whole stack dump on one console line is cut to 4000 characters with an ellipsis', async () => {
  const h = load();
  h.sandbox.console.error('x'.repeat(5000));
  const row = (await h.drain())[1];
  assert.equal(row.text.length, TEXT_CAP);
  assert.equal(row.text.slice(-1), '…', 'the ellipsis replaces the last kept character');
  assert.equal(row.text.slice(0, TEXT_CAP - 1), 'x'.repeat(TEXT_CAP - 1));
});

test('13: a line that already fits is passed through untouched, ellipsis and all', async () => {
  const h = load();
  h.sandbox.console.error('x'.repeat(TEXT_CAP));
  assert.equal((await h.drain())[1].text, 'x'.repeat(TEXT_CAP));
});

test('14: an Error logged by the page arrives as its stack, and as its name and message without one', async () => {
  const h = load();
  h.sandbox.console.error(erroring('boom', 'Error: boom\n    at pay (https://shop.example.com/app.js:9:1)'));
  h.sandbox.console.error(erroring('boom', ''));
  const evs = await h.drain();
  assert.equal(evs[1].text, 'Error: boom\n    at pay (https://shop.example.com/app.js:9:1)');
  assert.equal(evs[2].text, 'Error: boom');
});

test('15: a logged null or undefined says so — it does not vanish into an empty line', async () => {
  const h = load();
  h.sandbox.console.error(null, undefined);
  assert.equal((await h.drain())[1].text, 'null undefined');
});

test('16: an object is logged as its JSON, and a DOM node as the thing a tester recognises', async () => {
  const h = load();
  h.sandbox.console.error({ a: 1 });
  h.sandbox.console.error({ toString: () => '[object HTMLDivElement]' }); // JSON is '{}'
  const evs = await h.drain();
  assert.equal(evs[1].text, '{"a":1}');
  assert.equal(evs[2].text, '[object HTMLDivElement]');
});

test('17: an object that refers to itself is logged, not thrown at the page', async () => {
  const h = load();
  const loop = { name: 'cart' };
  loop.self = loop;
  h.sandbox.console.error(loop);
  assert.equal((await h.drain())[1].text, '[object Object]');
  assert.equal(h.consoleCalls().length, 1, 'and the page still got its log');
});

test('18: a multi-argument log reads as one line, the way the page meant it', async () => {
  const h = load();
  h.sandbox.console.error('a', 1, { b: 2 });
  assert.equal((await h.drain())[1].text, 'a 1 {"b":2}');
});

test('18a: the joined line is trimmed, so a leading empty argument does not indent the row', async () => {
  const h = load();
  h.sandbox.console.error('', 'checkout failed', '');
  assert.equal((await h.drain())[1].text, 'checkout failed');
});

test('19: a console row carries the page file and line the tester has to open, not ours', async () => {
  const h = load({
    stack: ['Error',
      '    at pushConsole (chrome-extension://abcdef/evidence/page-hook.js:157:5)',
      '    at console.error (chrome-extension://abcdef/evidence/page-hook.js:189:16)',
      '    at pay (https://shop.example.com/app.js:12:3)',
      '    at onclick (https://shop.example.com/app.js:40:1)'].join('\n'),
  });
  h.sandbox.console.error('checkout failed');
  const row = (await h.drain())[1];
  assert.equal(row.url, 'https://shop.example.com/app.js');
  assert.equal(row.line, 12);
  assert.equal(row.col, null, 'callSite reads no column');
});

test('20: a stack with nothing but our own frames names no file at all', async () => {
  const h = load({
    stack: 'Error\n    at x (chrome-extension://abcdef/evidence/page-hook.js:157:5)',
  });
  h.sandbox.console.error('checkout failed');
  const row = (await h.drain())[1];
  assert.deepEqual([row.url, row.line, row.col], [null, null, null]);
});

test('20a: a stack the engine refused to build leaves the row without a location, not without a row', async () => {
  const h = load({ stack: undefined });
  h.sandbox.console.error('checkout failed');
  const row = (await h.drain())[1];
  assert.equal(row.text, 'checkout failed');
  assert.equal(row.url, null);
});

// ============================================================================
// One failure, one line: the dedup
// ============================================================================

test('21: the three ways a browser announces the same throw all collapse to the same first line', async () => {
  for (const stack of ['Uncaught TypeError: x', 'Uncaught (in promise) TypeError: x']) {
    const h = load();
    h.sandbox.console.error('TypeError: x');
    h.errorEvent({ error: erroring('x', stack) });
    assert.equal((await h.drain()).filter((e) => e.t === 'exception').length, 0, stack);
  }
  const h = load();
  h.sandbox.console.error('TypeError: x');
  h.rejection({ reason: erroring('x', 'TypeError: x') });
  assert.equal((await h.drain()).filter((e) => e.t === 'exception').length, 0,
    'Unhandled promise rejection: TypeError: x');
});

test('22: the framework that logs an error and rethrows it gives the tester one line, not two', async () => {
  const h = load();
  h.sandbox.console.error('TypeError: cart is undefined');
  h.advance(100);
  h.errorEvent({ error: erroring('cart is undefined', 'TypeError: cart is undefined\n    at pay (x)') });
  const evs = await h.drain();
  assert.deepEqual(evs.map((e) => e.t), ['ready', 'console'], 'the uncaught twin was dropped');
});

test('23: the same failure a second later is a second failure, and is kept', async () => {
  const h = load();
  h.sandbox.console.error('TypeError: cart is undefined');
  h.advance(1100);
  h.errorEvent({ error: erroring('cart is undefined', 'TypeError: cart is undefined\n    at pay (x)') });
  const evs = await h.drain();
  assert.deepEqual(evs.map((e) => e.t), ['ready', 'console', 'exception']);
});

test('24: a page that logs all day remembers only the last fifty lines for the dedup', async () => {
  const h = load();
  for (let i = 0; i < 60; i += 1) h.sandbox.console.error(`TypeError: e${i}`);
  h.errorEvent({ error: erroring('e0', 'TypeError: e0') });
  h.errorEvent({ error: erroring('e59', 'TypeError: e59') });
  const kept = (await h.drain()).filter((e) => e.t === 'exception').map((e) => e.text);
  assert.deepEqual(kept, ['Uncaught TypeError: e0'], 'the oldest heads fell out; the newest still dedups');
});

test('25: an empty console line is not a failure worth remembering, so it evicts nothing', async () => {
  const h = load();
  for (let i = 0; i < 50; i += 1) h.sandbox.console.error(`TypeError: e${i}`);
  for (let i = 0; i < 5; i += 1) h.sandbox.console.error('');
  h.errorEvent({ error: erroring('e0', 'TypeError: e0') });
  assert.equal((await h.drain()).filter((e) => e.t === 'exception').length, 0,
    'the five empties did not push the oldest head out of the window');
});

// ============================================================================
// Never break the page's console
// ============================================================================

test('26: an argument that logs while we are reading it does not send the console into a spin', async () => {
  const h = load();
  const chatty = { toString() { h.sandbox.console.error('from inside toString'); return 'chatty'; } };
  h.sandbox.console.error(chatty);
  const evs = await h.drain();
  assert.deepEqual(evs.filter((e) => e.t === 'console').map((e) => e.text), ['chatty'],
    'the re-entrant call was not recorded a second time');
  assert.deepEqual(h.consoleCalls().map((c) => c.args[0]), ['from inside toString', chatty],
    'and both still reached the page\'s own console, inner one first');
});

test('26a: a logger the page wired to log again is two real page logs, and both are kept', async () => {
  const h = load({ reenter: 1 });
  h.sandbox.console.error('the page said this');
  assert.deepEqual((await h.drain()).filter((e) => e.t === 'console').map((e) => e.text),
    ['the page said this', 'the logger logging'],
    'the guard covers the recording half only — it is released before the page\'s own console runs');
});

test('27: an argument that cannot be turned into text still reaches the page\'s console', async () => {
  const hostile = { toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } };
  const h = load();
  h.sandbox.console.error(hostile);
  assert.deepEqual(h.consoleCalls(), [{ name: 'error', args: [hostile] }],
    'the page never notices we were there');
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('27a: and the guard is released, so the very next line is recorded normally', async () => {
  const hostile = { toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } };
  const h = load();
  h.sandbox.console.error(hostile);
  h.sandbox.console.error('the next one');
  assert.equal((await h.drain())[1].text, 'the next one');
});

test('27b: the page gets its own console.error return value back, unchanged', async () => {
  const h = load();
  assert.equal(h.sandbox.console.error('x'), 'the page\'s own console.error');
  assert.equal(h.sandbox.console.warn('x'), 'the page\'s own console.warn');
});

test('28: a stopped recording leaves the console a plain pass-through', async () => {
  const h = load();
  h.control({ off: true });
  h.sandbox.console.error('after the stop');
  assert.deepEqual(h.consoleCalls(), [{ name: 'error', args: ['after the stop'] }]);
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('29: a page that replaced console.error with something else is left alone', async () => {
  const h = load({ consoleError: 'not a function' });
  assert.equal(h.sandbox.console.error, 'not a function', 'untouched');
  h.sandbox.console.warn('a warning');
  assert.equal((await h.drain())[1].level, 'warning', 'and warn was still patched');
});

test('29a: console.warn is filed as a warning and console.error as an error', async () => {
  const h = load();
  h.sandbox.console.warn('slow');
  h.sandbox.console.error('broken');
  assert.deepEqual((await h.drain()).slice(1).map((e) => [e.t, e.level]),
    [['console', 'warning'], ['console', 'error']]);
});

// ============================================================================
// What the browser reports and the page swallows
// ============================================================================

test('30: an image the page could not load is one log row, not an exception', async () => {
  const h = load();
  h.errorEvent({ target: element('IMG', { src: `${SITE}/broken.png` }) });
  const evs = await h.drain();
  assert.deepEqual(evs.slice(1), [{ t: 'log', ts: NOW, level: 'error',
    text: `Failed to load resource: ${SITE}/broken.png`, url: `${SITE}/broken.png` }]);
});

test('30a: a relative src is made absolute against the page, so the tester can click it', async () => {
  const h = load();
  h.errorEvent({ target: element('SCRIPT', { src: '../js/app.js' }) });
  assert.equal((await h.drain())[1].url, `${SITE}/js/app.js`);
});

test('31: an element with no src reports the page URL, because an empty href resolves to it', async () => {
  const h = load();
  h.errorEvent({ target: element('IMG') });
  const row = (await h.drain())[1];
  assert.equal(row.text, `Failed to load resource: ${PAGE}`,
    'the tag-name fallback at :207 needs abs() to fail, which an empty src on a real page never does');
  assert.equal(row.url, PAGE);
});

test('31a: the tag name is only reached when the document has no usable base URL at all', async () => {
  const h = load({ noBaseURI: true });
  h.errorEvent({ target: element('IMG') });
  const row = (await h.drain())[1];
  assert.equal(row.text, 'Failed to load resource: img');
  assert.equal(row.url, null);
});

test('32: a thirty-frame stack is cut to the message plus the five frames that place the throw', async () => {
  const h = load();
  const frames = Array.from({ length: 30 }, (_, i) => `    at f${i} (${SITE}/app.js:${i}:1)`);
  h.errorEvent({ error: erroring('boom', `TypeError: boom\n${frames.join('\n')}`) });
  const row = (await h.drain())[1];
  assert.equal(row.text.split('\n').length, 6);
  assert.equal(row.text.split('\n')[0], 'Uncaught TypeError: boom');
  assert.equal(row.text.split('\n')[5], `    at f4 (${SITE}/app.js:4:1)`, 'the frames keep their indent');
});

test('32a: a stack longer than the text cap is cut there too', async () => {
  const h = load();
  h.errorEvent({ error: erroring('boom', `TypeError: ${'x'.repeat(9000)}`) });
  assert.equal((await h.drain())[1].text.length, TEXT_CAP);
});

test('33: an error the engine gave us no object for still reads the way DevTools writes it', async () => {
  const h = load();
  h.errorEvent({ message: 'Script error.', filename: `${SITE}/app.js`, lineno: 4, colno: 9 });
  assert.deepEqual((await h.drain())[1], { t: 'exception', ts: NOW, level: 'error',
    text: 'Uncaught Script error.', url: `${SITE}/app.js`, line: 4, col: 9 });
});

test('33a: Chrome already writes "Uncaught", so the row never says it twice', async () => {
  const h = load();
  h.errorEvent({ message: 'Uncaught TypeError: x' });
  assert.equal((await h.drain())[1].text, 'Uncaught TypeError: x');
});

test('33b: an error event with nothing in it at all is still a row the tester can see', async () => {
  const h = load();
  h.errorEvent({});
  assert.equal((await h.drain())[1].text, 'Uncaught error');
});

test('34: a promise rejected with a plain object is reported as that object, not as "[object Object]"', async () => {
  const h = load();
  h.rejection({ reason: { code: 7 } });
  assert.equal((await h.drain())[1].text, 'Unhandled promise rejection: {"code":7}');
});

test('35: a rejection whose reason hides no file leaves the location empty rather than inventing one', async () => {
  const h = load();
  h.rejection({ reason: 'just a string' });
  assert.deepEqual((await h.drain())[1], { t: 'exception', ts: NOW, level: 'error',
    text: 'Unhandled promise rejection: just a string', url: null, line: null, col: null });
});

test('35a: a rejection carrying an Error is placed by that Error\'s own stack', async () => {
  const h = load();
  h.rejection({ reason: erroring('boom', `TypeError: boom\n    at pay (${SITE}/app.js:12:3)`) });
  const row = (await h.drain())[1];
  assert.deepEqual([row.url, row.line, row.col], [`${SITE}/app.js`, 12, 3]);
});

test('36: a script the page\'s own policy refused is a row the tester would otherwise never see', async () => {
  const h = load();
  h.csp({ blockedURI: 'https://cdn.example.com/a.js', violatedDirective: 'script-src', sourceFile: PAGE });
  assert.deepEqual((await h.drain())[1], { t: 'log', ts: NOW, level: 'error',
    text: 'CSP refused https://cdn.example.com/a.js — violated script-src', url: PAGE });
});

test('36a: an inline block refused by the policy is named as inline, and falls back to the directive it has', async () => {
  const h = load();
  h.csp({ blockedURI: '', effectiveDirective: 'style-src-elem', documentURI: PAGE });
  assert.equal((await h.drain())[1].text, 'CSP refused (inline) — violated style-src-elem');
});

test('36b: a violation with no directive at all still names the policy', async () => {
  const h = load();
  h.csp({});
  assert.equal((await h.drain())[1].text, 'CSP refused (inline) — violated policy');
});

test('37: a stopped recording silences the browser\'s own reports too', async () => {
  const h = load();
  h.control({ off: true });
  h.errorEvent({ target: element('IMG', { src: `${SITE}/broken.png` }) });
  h.errorEvent({ message: 'boom' });
  h.rejection({ reason: 'boom' });
  h.csp({ blockedURI: 'x' });
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('37a: the element listener is capture-phase, or a failed image would never reach it', () => {
  const h = load();
  assert.deepEqual(h.winListeners(), [
    { type: 'message', capture: undefined },
    { type: 'error', capture: true },
    { type: 'unhandledrejection', capture: undefined },
    { type: 'pagehide', capture: true },
  ]);
  assert.deepEqual(h.docListeners(), [{ type: 'securitypolicyviolation', capture: undefined }]);
});

// ============================================================================
// The capped body read
// ============================================================================

test('38: a hundred-kilobyte failure gives up sixteen kilobytes and lets the rest go', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const big = response({ status: 500, text: 'x'.repeat(100 * 1024) });
  h.answerWith(() => Promise.resolve(big.res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet.length, BODY_CAP);
  assert.equal(net.bodyTruncated, true);
  assert.equal(big.state.cancelled, 1, 'the rest of the download was cancelled, not read into memory');
  assert.ok(big.state.chunks <= 4, 'and it stopped reading almost at once');
});

test('39: a small failure body arrives whole and is not marked truncated', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const small = response({ status: 500, text: '{"error":"card declined"}' });
  h.answerWith(() => Promise.resolve(small.res));
  h.fetch('/api/pay');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, '{"error":"card declined"}');
  assert.equal(net.bodyTruncated, false);
  assert.equal(small.state.cancelled, 0);
});

test('40: a response the page already consumed costs the row its body, never the page its response', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const used = response({ status: 500, text: 'gone', cloneThrows: true });
  h.answerWith(() => Promise.resolve(used.res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, null);
  assert.equal(net.bodySkipped, false, 'the tester did allow bodies — this one just could not be read');
  assert.equal(net.status, 500);
});

test('41: a response with no readable stream falls back to reading it as text', async () => {
  const h = load();
  h.control({ captureBodies: true });
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'no stream here', noBody: true }).res));
  const net = (h.fetch('/api/save'), (await h.drain()).find((e) => e.t === 'net'));
  assert.equal(net.bodySnippet, 'no stream here');
  assert.equal(net.bodyTruncated, false);
});

test('41a: and that fallback is capped at sixteen kilobytes too', async () => {
  const h = load();
  h.control({ captureBodies: true });
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'y'.repeat(40 * 1024), noBody: true }).res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet.length, BODY_CAP);
  assert.equal(net.bodyTruncated, true);
});

test('41b: a text read that throws costs the row its body and nothing else', async () => {
  const h = load();
  h.control({ captureBodies: true });
  h.answerWith(() => Promise.resolve(response({ status: 500, noBody: true, textThrows: true }).res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, null);
  assert.equal(net.status, 500);
});

test('42: a body that is not valid UTF-8 is decoded as best it can be, not thrown at the page', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]);
  h.answerWith(() => Promise.resolve(response({ status: 500, bytes }).res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, 'hi��!');
  assert.equal(net.bodyTruncated, false);
});

// ============================================================================
// The fetch wrapper
// ============================================================================

test('43: a no-cors response the page cannot read is not recorded as a failure it never saw', async () => {
  const h = load();
  for (const type of ['opaque', 'opaqueredirect']) {
    const g = load();
    g.control({ captureBodies: true });
    g.answerWith(() => Promise.resolve(response({ status: 0, type }).res));
    g.fetch('https://cdn.example.com/pixel.gif');
    const net = (await g.drain()).find((e) => e.t === 'net');
    assert.equal(net.status, null, type);
    assert.equal(net.errorText, null, type);
    assert.equal(net.bodySkipped, false, type);
  }
  assert.ok(h);
});

test('44: the tester who allowed bodies gets the failing response, and its content type', async () => {
  const h = load();
  h.control({ captureBodies: true });
  h.answerWith(() => Promise.resolve(response({ status: 500, text: 'boom', contentType: 'text/plain' }).res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, 'boom');
  assert.equal(net.bodyTruncated, false);
  assert.equal(net.mimeType, 'text/plain');
});

test('45: the tester who said no gets the row and a note saying why the body is missing', async () => {
  const h = load();
  h.control({ captureBodies: false });
  const r = response({ status: 500, text: 'private' });
  h.answerWith(() => Promise.resolve(r.res));
  h.fetch('/api/save');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySkipped, true);
  assert.equal(net.bodySnippet, null);
  assert.equal(r.state.clones, 0, 'and the response was never even cloned');
});

test('46: a request that worked carries no body and no excuse for one', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const r = response({ status: 200, text: 'fine' });
  h.answerWith(() => Promise.resolve(r.res));
  h.fetch('/api/cart');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.deepEqual([net.bodySnippet, net.bodyTruncated, net.bodySkipped], [null, false, false]);
  assert.equal(r.state.clones, 0);
});

test('46a: a 404 is a failure and a 399 is not', async () => {
  for (const [status, expected] of [[399, false], [400, true], [404, true]]) {
    const h = load();
    h.control({ captureBodies: false });
    h.answerWith(() => Promise.resolve(response({ status }).res));
    h.fetch('/api/x');
    const net = (await h.drain()).find((e) => e.t === 'net');
    assert.equal(net.bodySkipped, expected, `status ${status}`);
  }
});

test('47: a Request object is recorded by its own method and its own resolved url', async () => {
  const h = load();
  const req = new h.sandbox.Request('https://api.example.com', { method: 'POST' });
  h.fetch(req);
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.method, 'POST');
  assert.equal(net.url, 'https://api.example.com/');
});

test('48: a relative url and a lowercase method are recorded the way the panel sorts them', async () => {
  const h = load();
  h.fetch('/api/save', { method: 'post' });
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.method, 'POST');
  assert.equal(net.url, `${SITE}/api/save`);
  assert.equal(net.resourceType, 'fetch');
});

test('48a: an init method beats the Request it was given alongside, the way fetch itself works', async () => {
  const h = load();
  h.fetch(new h.sandbox.Request('https://api.example.com', { method: 'POST' }), { method: 'put' });
  assert.equal((await h.drain()).find((e) => e.t === 'net').method, 'PUT');
});

test('49: a first argument we cannot read does not fail the page\'s request', async () => {
  const h = load();
  const init = { get method() { throw new Error('poisoned init'); } };
  h.fetch('/api/save', init);
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.method, 'GET', 'the default survived');
  assert.equal(net.url, `${SITE}/api/save`);
  assert.equal(h.origFetchCalls().length, 1, 'and the page\'s own fetch still ran');
  assert.deepEqual(h.origFetchCalls()[0].args, ['/api/save', init], 'with the arguments untouched');
});

test('50: a request that never reached the network is recorded, and the page still sees the rejection', async () => {
  const h = load();
  const boom = erroring('Failed to fetch');
  h.answerWith(() => Promise.reject(boom));
  await assert.rejects(() => h.fetch('/api/save'), (e) => e === boom);
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.errorText, 'Failed to fetch');
  assert.equal(net.status, 0);
});

test('50a: a rejection with nothing to say is still given words', async () => {
  const h = load();
  h.answerWith(() => Promise.reject(''));
  await assert.rejects(() => h.fetch('/api/save'), (e) => e === '');
  assert.equal((await h.drain()).find((e) => e.t === 'net').errorText, 'network error');
});

test('51: a fetch that throws before it starts is recorded, and the throw reaches the page unchanged', async () => {
  const h = load();
  const boom = erroring('Invalid URL');
  h.answerWith(() => { throw boom; });
  assert.throws(() => h.fetch('::::'), (e) => e === boom);
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.errorText, 'Invalid URL');
  assert.equal(net.status, 0);
});

test('52: our own bookkeeping failing must not become the unhandled rejection we would then record', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const poisoned = response({ status: 500, typeThrows: true }).res;
  h.answerWith(() => Promise.resolve(poisoned));
  assert.equal(await h.fetch('/api/save'), poisoned, 'the page got its response');
  assert.deepEqual((await h.drain()).filter((e) => e.t !== 'ready'), [],
    'no row, and no rejection escaping into the page');
});

test('53: a stopped recording leaves fetch a plain pass-through', async () => {
  const h = load();
  h.control({ off: true });
  const r = response({ status: 500, text: 'x' }).res;
  h.answerWith(() => Promise.resolve(r));
  assert.equal(await h.fetch('/api/save'), r);
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('53a: the wrapper hands back the very response the page\'s own fetch resolved', async () => {
  const h = load();
  const r = response({ status: 200 }).res;
  h.answerWith(() => Promise.resolve(r));
  assert.equal(await h.fetch('/api/cart'), r);
});

test('53b: the wrapper passes `this` and every argument through to the page\'s own fetch', async () => {
  const h = load();
  const owner = { name: 'the page' };
  const init = { method: 'POST', body: 'a=1' };
  await h.sandbox.fetch.call(owner, '/api/save', init);
  assert.equal(h.origFetchCalls()[0].self, owner);
  assert.deepEqual(h.origFetchCalls()[0].args, ['/api/save', init]);
});

test('53d: a request still in flight when the recording stops does not land in it afterwards', async () => {
  const h = load();
  h.control({ captureBodies: true });
  let settleIt;
  h.answerWith(() => new Promise((r) => { settleIt = r; }));
  const inFlight = h.fetch('/api/save');
  h.control({ off: true });               // the tester clicked stop while it was out
  settleIt(response({ status: 500, text: 'too late' }).res);
  await inFlight;
  assert.deepEqual((await h.drain()).filter((e) => e.t === 'net'), [],
    'post() is the last gate — the fetch wrapper had already decided to record this one');
});

test('53c: a page with no fetch at all still gets a hook, and still records its console', async () => {
  const h = load({ noFetch: true });
  assert.equal(h.sandbox.fetch, undefined);
  h.sandbox.console.error('still here');
  assert.equal((await h.drain())[1].text, 'still here');
});

// ============================================================================
// The XMLHttpRequest wrapper
// ============================================================================

test('54: a failed XHR gives up its response text, capped at sixteen kilobytes', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const x = h.xhr();
  x.open('POST', '/api/save');
  x.status = 500;
  x.responseText = 'z'.repeat(40 * 1024);
  x.send('{}');
  x.emit('loadend');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet.length, BODY_CAP);
  assert.equal(net.bodyTruncated, true);
  assert.equal(net.method, 'POST');
  assert.equal(net.url, `${SITE}/api/save`);
  assert.equal(net.resourceType, 'xhr');
});

test('54a: a short one arrives whole', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const x = h.xhr();
  x.open('get', '/api/cart');
  x.status = 503;
  x.responseText = 'upstream is down';
  x.send();
  x.emit('loadend');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, 'upstream is down');
  assert.equal(net.bodyTruncated, false);
  assert.equal(net.method, 'GET');
});

test('55: a binary download is left alone — reading it back would touch the page\'s own copy', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const x = h.xhr();
  x.open('GET', '/api/report.pdf');
  x.status = 500;
  x.responseType = 'blob';
  x.response = { theBlob: true };
  x.send();
  x.emit('loadend');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, null, 'reading responseText here throws in a real browser');
  assert.deepEqual(x.response, { theBlob: true });
});

test('56: a JSON response is recorded as its JSON, and an uncopyable one costs only the body', async () => {
  const h = load();
  h.control({ captureBodies: true });
  const x = h.xhr();
  x.open('GET', '/api/cart');
  x.status = 500;
  x.responseType = 'json';
  x.response = { error: 'card declined' };
  x.send();
  x.emit('loadend');
  assert.equal((await h.drain()).find((e) => e.t === 'net').bodySnippet, '{"error":"card declined"}');

  const g = load();
  g.control({ captureBodies: true });
  const y = g.xhr();
  y.open('GET', '/api/cart');
  y.status = 500;
  y.responseType = 'json';
  const loop = { a: 1 };
  loop.self = loop;
  y.response = loop;
  y.send();
  y.emit('loadend');
  const net = (await g.drain()).find((e) => e.t === 'net');
  assert.equal(net.bodySnippet, null);
  assert.equal(net.status, 500);
});

test('57: an XHR that failed, timed out or was aborted says which, in one row on loadend', async () => {
  for (const [event, errorText] of [['error', 'net::ERR_FAILED'], ['timeout', 'timeout'], ['abort', 'aborted']]) {
    const h = load();
    h.control({ captureBodies: true });
    const x = h.xhr();
    x.open('GET', '/api/cart');
    x.send();
    x.emit(event);
    assert.deepEqual((await h.drain()).filter((e) => e.t === 'net'), [], `${event}: nothing yet`);
    x.emit('loadend');
    const nets = (await h.drain()).filter((e) => e.t === 'net');
    assert.equal(nets.length, 1, event);
    assert.equal(nets[0].errorText, errorText);
    assert.equal(nets[0].status, 0);
  }
});

test('58: an XHR that worked never asks whether bodies may be captured', async () => {
  const h = load();
  const x = h.xhr();
  x.open('GET', '/api/cart');
  x.status = 200;
  x.responseText = 'a page of json';
  x.send();
  x.emit('loadend');
  assert.equal(h.pending().includes(3000), false, 'the privacy question was never asked');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.deepEqual([net.bodySnippet, net.bodySkipped], [null, false]);
  assert.equal(net.mimeType, 'application/json');
});

test('58a: a header read that throws costs the row its mime type and nothing else', async () => {
  const h = load();
  const x = h.xhr();
  x.open('GET', '/api/cart');
  x.status = 200;
  x.headerThrows = true;
  x.send();
  x.emit('loadend');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.mimeType, null);
  assert.equal(net.status, 200);
});

test('58b: the wrapper hands the page\'s own open and send their arguments, and their return value', async () => {
  const h = load();
  const x = h.xhr();
  assert.equal(x.open('POST', '/api/save', true, 'user', 'pass'), 'the page\'s own open');
  assert.equal(x.send('a=1'), 'the page\'s own send');
  assert.deepEqual(x.opened, [['POST', '/api/save', true, 'user', 'pass']]);
  assert.deepEqual(x.sent, [['a=1']]);
});

test('58c: an XHR the page sent without opening it first is still the page\'s to send', async () => {
  const h = load();
  const x = h.xhr();
  assert.equal(x.send('a=1'), 'the page\'s own send');
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('58d: an XHR still in flight when the recording stops is not recorded when it lands', async () => {
  const h = load();
  const x = h.xhr();
  x.open('GET', '/api/cart');
  x.status = 200;
  x.send();
  h.control({ off: true });
  x.emit('loadend');
  assert.deepEqual((await h.drain()).map((e) => e.t), ['ready']);
});

test('58e: a page with no XMLHttpRequest at all still gets a hook', async () => {
  const h = load({ noXHR: true });
  h.sandbox.console.error('still here');
  assert.equal((await h.drain())[1].text, 'still here');
});

test('58f: a request the tester watched is timed, from the send to the last byte', async () => {
  const h = load();
  const x = h.xhr();
  x.open('GET', '/api/cart');
  x.status = 200;
  x.send();
  h.advance(180);
  x.emit('loadend');
  const net = (await h.drain()).find((e) => e.t === 'net');
  assert.equal(net.durationMs, 180);
  assert.equal(net.ts, NOW, 'stamped when the page sent it, not when it came back');
});

// ============================================================================
// Load-time behaviour
// ============================================================================

test('59: a frame torn down under us swallows the post instead of throwing into the page', async () => {
  const h = load({ postThrows: true });
  assert.deepEqual(h.posts(), [], 'the handshake was lost, and the load survived it');
  h.sandbox.console.error('and the page keeps working');
  assert.deepEqual(h.consoleCalls(), [{ name: 'error', args: ['and the page keeps working'] }]);
});

test('60: the failed request right before a navigation is the one the tester wants, and it is flushed', async () => {
  const h = load();
  h.sandbox.console.error('the last thing that happened');
  assert.equal(h.posts().length, 1, 'still batched');
  h.pagehide();
  assert.equal(h.posts().length, 2);
  assert.equal(h.events()[1].text, 'the last thing that happened');
  assert.deepEqual(h.pending(), [], 'and the pending window was cleared');
});

test('61: the worker re-injecting the hook into the same page does not wrap fetch twice', async () => {
  const h = load();
  const wrapped = h.sandbox.fetch;
  const listeners = h.winListeners().length;
  h.reload();
  assert.equal(h.sandbox.fetch, wrapped, 'a nested wrapper would record every request twice');
  assert.equal(h.winListeners().length, listeners);
  assert.equal(h.posts().length, 1, 'and it did not say hello a second time');
});

test('62: everything the hook posts goes to the page\'s own world too, by design', async () => {
  const h = load();
  h.sandbox.console.error('a line the page can read back');
  await h.drain();
  assert.ok(h.posts().length >= 2);
  for (const p of h.posts()) {
    assert.equal(p.target, '*', 'a page that wants its own evidence log can listen for it');
    assert.equal(p.msg.source, CHANNEL);
  }
});

test('62a: the handshake goes out at load, before the page has done anything', () => {
  const h = load();
  assert.deepEqual(h.posts(), [{ msg: { source: CHANNEL, events: [{ t: 'ready', ts: NOW, url: PAGE }] }, target: '*' }]);
});

test('62b: the hook claims the document so a second injection can tell it is already there', () => {
  const h = load();
  assert.equal(h.sandbox.__testomatEvHooked, true);
});

test('63: the four kinds this hook emits are the four the worker knows how to file', async () => {
  const h = load();
  h.sandbox.console.error('c');
  h.errorEvent({ message: 'boom' });
  h.csp({ blockedURI: 'x' });
  h.control({ captureBodies: false });
  h.answerWith(() => Promise.resolve(response({ status: 500 }).res));
  h.fetch('/api/save');
  const kinds = [...new Set((await h.drain()).map((e) => e.t))].sort();
  assert.deepEqual(kinds, ['console', 'exception', 'log', 'net', 'ready'],
    'recorder.js files console/log/exception by name and net separately — anything else is dropped there');
});
