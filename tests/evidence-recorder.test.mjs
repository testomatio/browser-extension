#!/usr/bin/env node
// What extension/evidence/recorder.js owes the tester: while they reproduce a bug the worker
// quietly keeps the last minute of the page's console errors and failed requests, so "attach the log"
// hands over that window — not the whole session, not a list full of duplicates, and not an empty file
// because Chrome put the worker to sleep halfway through.
// Two sources feed the same buffer. chrome.webRequest sees every request of the tab; a hook riding
// inside the page sees more (response bodies, console text) but only the top frame. evWrOwns() is the
// referee, evAdoptTwin() merges the pair when both reported the same request, and the storage.session
// mirror is what a recycled worker wakes up holding.
// The rows are the ticket's 58, numbered in their names; a row that pins a bug we are NOT fixing here
// gets a second `test.todo` naming the issue that will. Companion rows carry a letter suffix and drive
// the same path the other way, so a row asserting "nothing happened" cannot pass against a dead stub.
// Run: node --test tests/evidence-recorder.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// EV_SRC runs the whole file against a mutated copy, so a falsification run never has to edit the
// shipped module and risk leaving it edited.
const SRC = process.env.EV_SRC || join(repoRoot, 'extension/evidence/recorder.js');
// The REAL SiteTab, not a look-alike: row 38 asserts the restricted-page sentence word for word, and
// row 57 leans on originOf() dropping the port.
const SITE_TAB = join(repoRoot, 'extension/shared/site-tab.js');
const source = readFileSync(SRC, 'utf8');
const siteTabSource = readFileSync(SITE_TAB, 'utf8');

const NOW = 1_700_000_000_000;
const TAB = 5;
const SITE = 'https://shop.example.com';

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// One turn of the macrotask queue drains every microtask behind it; three is the cheap margin for
// evStart's own chain (settings -> tabs.get -> inject -> register -> mirror).
const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// Every ev* is a top-level `function`, so it lands on the sandbox anyway; the module state and the
// caps are lexical `const`/`let` and exist only in the script's completion value. `st` hands the rows
// live getters/setters over those bindings — the only way to seed a buffer or a session from outside.
const PICK = `
;({
  fns: { evClampWindow, evLoadSettings, evPush, evWindowEntries, evIsError, evOnPageEvents,
    evPushPageNet, evWrOwns, evWrStart, evWrDone, evWrError, evWrRedirect, evRegister, evUnregister,
    evStart, evStop, evStopIfRecording, evWipe, evStatus, evScheduleMirror, evMirror },
  caps: { HARD_CAP: EVIDENCE_HARD_CAP, MIRROR_MS: EVIDENCE_MIRROR_MS, NET_MAP_CAP: EVIDENCE_NET_MAP_CAP,
    MERGE_MS: EVIDENCE_MERGE_MS, REQUESTS: EVIDENCE_REQUESTS },
  ready: evReady,
  st: {
    get buffer() { return evBuffer; }, set buffer(v) { evBuffer = v; },
    get session() { return evSession; }, set session(v) { evSession = v; },
    get hookReady() { return evHookReady; }, set hookReady(v) { evHookReady = v; },
    get windowSec() { return evWindowSec; }, set windowSec(v) { evWindowSec = v; },
    get restored() { return evRestored; },
    net: evNetById,
  },
});`;

// chrome.storage.get, the two argument shapes this module uses.
function readKeys(store, keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
  const out = {};
  for (const k of keys) if (k in store) out[k] = store[k];
  return out;
}

function load(opts = {}) {
  const {
    now = NOW,
    settings,                    // undefined: the `settings` key is absent from storage.local
    mirror,                      // undefined: nothing was mirrored
    deferRestore = false,        // hold the mirror READ open until release() — rows 51/53
    noSession = false,           // chrome.storage.session missing entirely — row 47
    noWebRequest = false,        // a build without the permission
    webRequestThrows = false,    // addListener refuses — the try at the registration block
    sessionGetFails = false,
    localGetFails = false,
    noRegisterApi = false,
    noUnregisterApi = false,
  } = opts;

  const calls = [];
  const injects = [];            // every executeScript, with the state as it stood at that instant
  const sess = {};
  const loc = {};
  if (mirror !== undefined) sess.evidenceMirror = plain(mirror);
  if (settings !== undefined) loc.settings = plain(settings);

  let clock = now;
  let timerSeq = 0;
  const timers = new Map();
  let handles = null;            // late-bound: the stubs read state the script has not produced yet

  const log = (name, ...args) => { calls.push({ name, args }); };

  // The knobs a row turns after load(); the stubs read them live.
  const hooks = {
    getTab: (id) => ({ id, title: 'Cart', url: `${SITE}/cart` }),
    executeScript: () => [],
    sessionSet: null,            // a function here replaces the write: throw to make it reject
    registerContentScripts: () => {},
    tabsSendMessage: () => ({ ok: true }),
  };

  // ---- fake timers: evScheduleMirror leaves one live after almost every row ----------------
  const setTimeoutFake = (fn, ms = 0, ...args) => {
    const id = (timerSeq += 1);
    timers.set(id, { at: clock + Number(ms || 0), fn, args });
    return id;
  };
  const clearTimeoutFake = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const target = clock + Number(ms || 0);
    for (;;) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
      }
      if (!next) break;
      timers.delete(next[0]);
      clock = Math.max(clock, next[1].at);
      next[1].fn(...next[1].args);
    }
    clock = Math.max(clock, target);
    return clock;
  };

  // ---- chrome -----------------------------------------------------------------------------
  const bus = (throws = false) => {
    const fns = [];
    return {
      fns,
      addListener: (fn) => { if (throws) throw new Error('permission missing'); fns.push(fn); },
      removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    };
  };
  const emit = (b, ...args) => b.fns.map((fn) => fn(...args));

  let releaseRestore = () => {};
  const gate = deferRestore ? new Promise((r) => { releaseRestore = r; }) : null;

  const sessionArea = {
    get: async (keys) => {
      log('storage.session.get', keys);
      if (sessionGetFails) throw new Error('storage.session unavailable');
      // Chrome answers from the value the read was DISPATCHED against; a write racing it lands
      // after. Snapshotting here is what lets row 51 show the stale mirror winning.
      const snap = plain(readKeys(sess, keys));
      if (gate) await gate;
      return snap;
    },
    set: async (obj) => {
      log('storage.session.set', Object.keys(obj));
      if (hooks.sessionSet) return hooks.sessionSet(obj);
      Object.assign(sess, plain(obj)); // Chrome structured-clones; an alias would hide the copy
      return undefined;
    },
    remove: async (keys) => {
      log('storage.session.remove', keys);
      for (const k of Array.isArray(keys) ? keys : [keys]) delete sess[k];
    },
  };

  const localArea = {
    get: async (keys) => {
      log('storage.local.get', keys);
      if (localGetFails) throw new Error('storage.local unavailable');
      return plain(readKeys(loc, keys));
    },
    set: async (obj) => { log('storage.local.set', plain(obj)); Object.assign(loc, plain(obj)); },
  };

  const runtime = {
    onMessage: bus(),
    sendMessage: async (msg) => { log('runtime.sendMessage', plain(msg)); },
  };

  const snapshot = () => (handles ? {
    recording: !!handles.st.session,
    tabId: handles.st.session ? handles.st.session.tabId : null,
    entries: handles.st.buffer.length,
    hookReady: handles.st.hookReady,
  } : null);

  const scripting = {
    executeScript: async (arg) => {
      log('scripting.executeScript', plain(arg));
      injects.push({ ...plain(arg), state: snapshot() });
      return hooks.executeScript(arg);
    },
  };
  if (!noRegisterApi) {
    scripting.registerContentScripts = async (s) => {
      log('scripting.registerContentScripts', plain(s));
      return hooks.registerContentScripts(s);
    };
  }
  if (!noUnregisterApi) {
    scripting.unregisterContentScripts = async (f) => { log('scripting.unregisterContentScripts', plain(f)); };
  }

  const chromeStub = {
    runtime,
    storage: { local: localArea, onChanged: bus() },
    tabs: {
      onRemoved: bus(),
      onUpdated: bus(),
      get: async (id) => { log('tabs.get', id); return hooks.getTab(id); },
      sendMessage: async (tabId, msg) => {
        log('tabs.sendMessage', tabId, plain(msg));
        return hooks.tabsSendMessage(tabId, msg);
      },
    },
    scripting,
  };
  if (!noSession) chromeStub.storage.session = sessionArea;
  if (!noWebRequest) {
    chromeStub.webRequest = {
      onBeforeRequest: bus(webRequestThrows),
      onCompleted: bus(webRequestThrows),
      onErrorOccurred: bus(webRequestThrows),
      onBeforeRedirect: bus(webRequestThrows),
    };
  }

  // ---- the sandbox ------------------------------------------------------------------------
  class FakeDate extends Date { static now() { return clock; } }

  const sandbox = {
    chrome: chromeStub,
    console,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    Date: FakeDate,
    URL, // site-tab.js only; node:vm has none of its own
  };

  const context = createContext(sandbox);
  // Same context, before the recorder: site-tab.js's top-level `const SiteTab` lands in the global
  // lexical scope, which is exactly how the worker's bare `SiteTab` resolves after importScripts.
  runInContext(siteTabSource, context, { filename: SITE_TAB });
  const api = runInContext(`${source}\n${PICK}`, context, { filename: SRC });

  // One trip through the listener. `sync` is how many replies landed BEFORE it returned — rows 52/53
  // turn on the difference between an answer and a promise of one.
  const send = (msg, sender = {}) => {
    const replies = [];
    const rets = emit(runtime.onMessage, msg, sender, (r) => { replies.push(plain(r)); });
    return { ret: rets[0], sync: replies.length, replies };
  };

  handles = {
    st: api.st,
    fns: api.fns,
    caps: api.caps,
    ready: api.ready,
    chrome: chromeStub,
    hooks,
    injects,
    session: sess,

    buffer: () => plain(api.st.buffer),
    window: () => plain(api.fns.evWindowEntries()),
    status: () => plain(api.fns.evStatus()),
    pageEvents: (events, sender) => plain(api.fns.evOnPageEvents(events, sender)),
    named: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    names: () => calls.map((c) => c.name),
    clearCalls: () => { calls.length = 0; injects.length = 0; },

    setNow: (v) => { clock = v; return clock; },
    advance,
    pending: () => [...timers.values()].map((t) => t.at - clock),
    settle,
    release: () => { releaseRestore(); },

    emit: (path, ...args) => emit(path.split('.').reduce((o, k) => o[k], chromeStub), ...args),
    // Fire one chrome.webRequest event at whatever the module registered for it.
    wr: (event, d) => emit(chromeStub.webRequest[event], d),
    send,
    ask: async (msg, sender = {}) => { const s = send(msg, sender); await settle(); return s.replies[0]; },
  };
  return handles;
}

// The common start: let the load-time evRestore() settle, then forget the calls it made.
async function ready(opts = {}) {
  const h = load(opts);
  await h.settle();
  h.clearCalls();
  return h;
}

// A recording of tab 5, already restored, with the buffer under the row's control.
async function recording(opts = {}) {
  const h = await ready(opts);
  h.st.session = { tabId: TAB, recordId: 'rec-1', tabTitle: 'Cart', tabUrl: `${SITE}/cart`, startedAt: NOW };
  return h;
}

const at = (secAgo) => NOW - secAgo * 1000;
const con = (over = {}) => ({ ts: at(1), kind: 'console', level: 'error', text: 'boom', ...over });
const net = (over = {}) => ({ ts: at(1), kind: 'network', method: 'GET', url: `${SITE}/api/x`, status: 200, ...over });
const wrq = (over = {}) => ({
  requestId: 'r1', tabId: TAB, frameId: 0, type: 'xmlhttprequest', method: 'GET', url: `${SITE}/api/x`, ...over,
});

// ============================ the window and the ring buffer ============================

test('1: a window setting that is not a number at all falls back to a minute', async () => {
  const { fns } = await ready();
  for (const v of [undefined, 'abc', NaN, Infinity, -Infinity]) assert.equal(fns.evClampWindow(v), 60);
});

test('2: a window below ten seconds or above ten minutes is clamped to the edge', async () => {
  const { fns } = await ready();
  for (const v of [0, 9, -5, true, []]) assert.equal(fns.evClampWindow(v), 10);
  for (const v of [601, 1e9]) assert.equal(fns.evClampWindow(v), 600);
  assert.equal(fns.evClampWindow(10), 10);
  assert.equal(fns.evClampWindow(600), 600);
});

test('3: a fractional or stringly window is rounded and coerced, not rejected', async () => {
  const { fns } = await ready();
  assert.equal(fns.evClampWindow(60.4), 60);
  assert.equal(fns.evClampWindow(60.5), 61);
  assert.equal(fns.evClampWindow('120'), 120);
  assert.equal(fns.evClampWindow([30]), 30);
});

test('4: null clamps to ten on its own, but the settings guard turns it into a minute', async () => {
  const h = await ready({ settings: { evidenceWindowSec: null } });
  assert.equal(h.fns.evClampWindow(null), 10);
  await h.fns.evLoadSettings();
  assert.equal(h.st.windowSec, 60);
});

test('4a: a window the tester chose is what the recorder keeps', async () => {
  const h = await ready({ settings: { evidenceWindowSec: 300 } });
  await h.fns.evLoadSettings();
  assert.equal(h.st.windowSec, 300);
  assert.deepEqual(h.named('storage.local.get'), [['settings']]);
});

test('4b: storage refusing to answer leaves the minute default rather than an unusable window', async () => {
  const h = await ready({ settings: { evidenceWindowSec: 300 }, localGetFails: true });
  h.st.windowSec = 999;
  await h.fns.evLoadSettings();
  assert.equal(h.st.windowSec, 60);
});

test('4c: the tester changing the window mid-recording is picked up from storage.onChanged', async () => {
  const h = await ready({ settings: { evidenceWindowSec: 45 } });
  h.st.windowSec = 60; // the load-time restore already read the tester's 45
  h.emit('storage.onChanged', { other: {} }, 'local');
  await h.settle();
  assert.equal(h.st.windowSec, 60, 'an unrelated local key must not re-read settings');
  h.emit('storage.onChanged', { settings: {} }, 'sync');
  await h.settle();
  assert.equal(h.st.windowSec, 60, 'another storage area is not ours');
  h.emit('storage.onChanged', { settings: {} }, 'local');
  await h.settle();
  assert.equal(h.st.windowSec, 45);
});

test('5: the buffer keeps two windows of history, not the one the panel shows', async () => {
  const h = await ready();
  h.st.windowSec = 60;
  h.st.buffer = [con({ ts: at(130), text: 'ancient' }), con({ ts: at(125), text: 'old' }),
    con({ ts: at(100), text: 'behind the window' })];
  h.fns.evPush(con({ ts: at(1), text: 'fresh' }));
  assert.deepEqual(h.buffer().map((e) => e.text), ['behind the window', 'fresh']);
  // The panel only ever sees one window — the extra minute is retroactive margin, not exposure.
  assert.deepEqual(h.window().map((e) => e.text), ['fresh']);
});

test('6: an old entry hiding behind a fresh one is left in the buffer', async () => {
  const h = await ready();
  h.st.windowSec = 60;
  h.st.buffer = [con({ ts: at(1), text: 'fresh' }), con({ ts: at(2) }), con({ ts: at(3) }),
    con({ ts: at(4) }), con({ ts: at(5) }), con({ ts: at(300), text: 'ancient' })];
  h.fns.evPush(con({ ts: at(0), text: 'newest' }));
  assert.equal(h.buffer().length, 7);
  assert.ok(h.buffer().some((e) => e.text === 'ancient'), 'today: only evBuffer[0] triggers the rescan');
});

test.todo('6 (#313): an old entry hiding behind a fresh one is pruned like any other', async () => {
  const h = await ready();
  h.st.windowSec = 60;
  h.st.buffer = [con({ ts: at(1), text: 'fresh' }), con({ ts: at(300), text: 'ancient' })];
  h.fns.evPush(con({ ts: at(0), text: 'newest' }));
  assert.ok(!h.buffer().some((e) => e.text === 'ancient'));
});

test('7: a page that never stops logging keeps the newest thousand rows, not the first', async () => {
  const h = await ready();
  const { HARD_CAP } = h.caps;
  for (let i = 0; i < HARD_CAP + 1; i += 1) h.fns.evPush(con({ ts: at(1), text: `e${i}` }));
  const buf = h.buffer();
  assert.equal(buf.length, HARD_CAP);
  assert.equal(buf[0].text, 'e1');
  assert.equal(buf[HARD_CAP - 1].text, `e${HARD_CAP}`);
});

test('8: the requestId map is emptied wholesale once it passes its cap', async () => {
  const h = await ready();
  const { NET_MAP_CAP } = h.caps;
  for (let i = 0; i < NET_MAP_CAP; i += 1) h.st.net.set(`r${i}`, net());
  h.fns.evPush(con());
  assert.equal(h.st.net.size, NET_MAP_CAP, 'exactly at the cap nothing is dropped');
  h.st.net.set('one-too-many', net());
  h.fns.evPush(con());
  // In-flight requests lose their rows: a deliberate leak guard, not a merge.
  assert.equal(h.st.net.size, 0);
});

test('9: two sources arriving out of order come back oldest first', async () => {
  const h = await ready();
  h.st.buffer = [con({ ts: at(3), text: 'c' }), con({ ts: at(1), text: 'a' }), con({ ts: at(2), text: 'b' })];
  assert.deepEqual(h.window().map((e) => e.text), ['c', 'b', 'a']);
  assert.deepEqual(h.window().map((e) => e.ts), [at(3), at(2), at(1)]);
});

test('10: an entry sitting exactly on the cutoff is still in the window', async () => {
  const h = await ready();
  h.st.windowSec = 60;
  h.st.buffer = [con({ ts: at(60), text: 'on the line' }), con({ ts: at(60) + 1, text: 'inside' }),
    con({ ts: at(60) - 1, text: 'just out' })];
  assert.deepEqual(h.window().map((e) => e.text), ['on the line', 'inside']);
});

test('11: a network row counts as an error when it failed or came back non-2xx', async () => {
  const { fns } = await ready();
  assert.equal(fns.evIsError({ kind: 'network', status: 404 }), true);
  assert.equal(fns.evIsError({ kind: 'network', status: 200 }), false);
  assert.equal(fns.evIsError({ kind: 'network', status: null, errorText: 'net::ERR_FAILED' }), true);
  // Still in flight: no status, no error — it is not evidence of anything yet.
  assert.equal(fns.evIsError({ kind: 'network', status: null, errorText: null }), false);
});

test('12: a console row counts as an error at error and warning level only', async () => {
  const { fns } = await ready();
  assert.equal(fns.evIsError({ kind: 'console', level: 'warning' }), true);
  assert.equal(fns.evIsError({ kind: 'console', level: 'error' }), true);
  assert.equal(fns.evIsError({ kind: 'console', level: 'info' }), false);
});

test('13: the healthy band is 200 up to 299 — a 199 and a 300 are both evidence', async () => {
  const { fns } = await ready();
  assert.equal(fns.evIsError({ kind: 'network', status: 199 }), true);
  assert.equal(fns.evIsError({ kind: 'network', status: 300 }), true);
  assert.equal(fns.evIsError({ kind: 'network', status: 299 }), false);
});

// ============================ page events, and adopting the twin ============================

test('14: a batch from another tab is answered with the stop signal and buffers nothing', async () => {
  const h = await recording();
  assert.deepEqual(h.pageEvents([con()], { tab: { id: 9 }, frameId: 0 }), { off: true });
  assert.equal(h.st.buffer.length, 0);
});

test('15: a sub-frame stays out of the log but is not muted', async () => {
  const h = await recording();
  assert.deepEqual(
    h.pageEvents([{ t: 'console', text: 'from an iframe' }], { tab: { id: TAB }, frameId: 1 }),
    { off: false },
  );
  assert.equal(h.st.buffer.length, 0);
});

test('16: a hook still posting at a worker with no recording is told to stop', async () => {
  const h = await ready();
  assert.deepEqual(h.pageEvents([con()], { tab: { id: TAB }, frameId: 0 }), { off: true });
  assert.equal(h.st.buffer.length, 0);
  // No sender tab at all (a panel message) is the same answer.
  h.st.session = { tabId: TAB };
  assert.deepEqual(h.pageEvents([con()], { frameId: 0 }), { off: true });
});

test('17: the hook saying hello only flips the ownership flag', async () => {
  const h = await recording();
  assert.equal(h.st.hookReady, false);
  h.fns.evOnPageEvents([{ t: 'ready' }], { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.hookReady, true);
  assert.equal(h.st.buffer.length, 0);
});

test('18: a row of a kind this version does not know is dropped silently', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'websocket', text: 'x' }, null, 'nope', 42, { t: 'log', text: 'kept' }],
    { tab: { id: TAB }, frameId: 0 });
  assert.deepEqual(h.buffer().map((e) => e.kind), ['log']);
});

test('18a: the three text kinds the hook may send each keep their own name', async () => {
  const h = await recording();
  h.fns.evOnPageEvents(
    [{ t: 'console', text: 'a' }, { t: 'log', text: 'b' }, { t: 'exception', text: 'c' }],
    { tab: { id: TAB }, frameId: 0 },
  );
  assert.deepEqual(h.buffer().map((e) => e.kind), ['console', 'log', 'exception']);
});

test('18b: a kind borrowed from Object.prototype is taken at face value today', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'toString', text: 'x' }], { tab: { id: TAB }, frameId: 0 });
  // The lookup is a bare index into a plain object, so an inherited key is truthy and lands a row.
  assert.equal(h.st.buffer.length, 1);
  assert.equal(typeof h.st.buffer[0].kind, 'function');
});

test('19: only "warning" is a warning — every other console level is filed as an error', async () => {
  const h = await recording();
  h.fns.evOnPageEvents(
    [{ t: 'console', level: 'info', text: 'i' }, { t: 'console', level: 'warning', text: 'w' },
      { t: 'console', level: 'debug', text: 'd' }, { t: 'console', text: 'none' }],
    { tab: { id: TAB }, frameId: 0 },
  );
  assert.deepEqual(h.buffer().map((e) => e.level), ['error', 'warning', 'error', 'error']);
});

test('20: a row the hook sent without a stamp is stamped on arrival', async () => {
  const h = await recording();
  h.setNow(NOW + 7000);
  h.fns.evOnPageEvents([{ t: 'console', text: 'a' }, { t: 'console', text: 'b', ts: at(4) }],
    { tab: { id: TAB }, frameId: 0 });
  assert.deepEqual(h.buffer().map((e) => e.ts), [NOW + 7000, at(4)]);
});

test('20a: a text row carries the url, line and column the tester needs to find it', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'exception', ts: at(2), text: 'TypeError: x', url: `${SITE}/app.js`, line: 12, col: 3 }],
    { tab: { id: TAB }, frameId: 0 });
  assert.deepEqual(h.buffer(), [{ ts: at(2), kind: 'exception', level: 'error', text: 'TypeError: x',
    url: `${SITE}/app.js`, line: 12, col: 3 }]);
  h.st.buffer = [];
  h.fns.evOnPageEvents([{ t: 'log' }], { tab: { id: TAB }, frameId: 0 });
  assert.deepEqual(h.buffer()[0], { ts: NOW, kind: 'log', level: 'error', text: '', url: null, line: null, col: null });
});

test('21: a response body arrives with no length cap on this side', async () => {
  const h = await recording();
  const body = 'x'.repeat(5_000_000);
  h.fns.evOnPageEvents([{ t: 'net', ts: at(1), url: `${SITE}/api/x`, bodySnippet: body, bodyTruncated: true }],
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer[0].bodySnippet.length, 5_000_000);
  assert.equal(h.st.buffer[0].bodyTruncated, true);
});

test.todo('21 (#314): a response body is capped before it reaches the buffer', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'net', ts: at(1), url: `${SITE}/api/x`, bodySnippet: 'x'.repeat(5_000_000) }],
    { tab: { id: TAB }, frameId: 0 });
  assert.ok(h.st.buffer[0].bodySnippet.length <= 16 * 1024);
});

test('22: console text arrives with no length cap either', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'console', ts: at(1), text: 'x'.repeat(10_000_000) }],
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer[0].text.length, 10_000_000);
});

test.todo('22 (#314): console text is capped before it reaches the buffer', async () => {
  const h = await recording();
  h.fns.evOnPageEvents([{ t: 'console', ts: at(1), text: 'x'.repeat(10_000_000) }],
    { tab: { id: TAB }, frameId: 0 });
  assert.ok(h.st.buffer[0].text.length <= 16 * 1024);
});

test('23: a single batch of a hundred thousand rows is processed to the last one', async () => {
  const h = await recording();
  const batch = [];
  for (let i = 0; i < 100_000; i += 1) batch.push({ t: 'console', ts: at(1), text: `e${i}` });
  h.fns.evOnPageEvents(batch, { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer.length, h.caps.HARD_CAP);
  assert.equal(h.st.buffer[h.st.buffer.length - 1].text, 'e99999');
});

test.todo('23 (#314): a single oversized batch is clamped instead of processed whole', async () => {
  const h = await recording();
  const batch = [];
  for (let i = 0; i < 100_000; i += 1) batch.push({ t: 'console', ts: at(1), text: `e${i}` });
  h.fns.evOnPageEvents(batch, { tab: { id: TAB }, frameId: 0 });
  assert.notEqual(h.st.buffer[h.st.buffer.length - 1].text, 'e99999');
});

test('24: a page row lands on the webRequest twin it beat, and once the hook owns the tab there is no twin left to land on', async () => {
  const h = await recording();
  // The hook is installed but its `ready` has not reached us yet, so webRequest opens the row.
  h.fns.evWrStart(wrq({ requestId: 'r1', url: `${SITE}/api/x` }));
  h.setNow(NOW + 200);
  h.fns.evOnPageEvents(
    [{ t: 'ready' }, { t: 'net', ts: NOW + 200, method: 'GET', url: `${SITE}/api/x`, status: 500,
      bodySnippet: '{"err":1}', mimeType: 'application/json', durationMs: 180 }],
    { tab: { id: TAB }, frameId: 0 },
  );
  assert.equal(h.st.buffer.length, 1, 'one request, one row');
  assert.deepEqual(h.buffer()[0], {
    ts: NOW, kind: 'network', requestId: 'r1', method: 'GET', url: `${SITE}/api/x`,
    resourceType: 'fetch', status: 500, errorText: null, fromPage: true, mimeType: 'application/json',
    durationMs: 180, bodySnippet: '{"err":1}', bodyTruncated: false,
  });
  // Now the hook owns the top frame's xhr: webRequest must not open a second row for the next one.
  h.fns.evWrStart(wrq({ requestId: 'r2', url: `${SITE}/api/y` }));
  assert.equal(h.st.buffer.length, 1);
  h.setNow(NOW + 400);
  h.fns.evOnPageEvents([{ t: 'net', ts: NOW + 400, method: 'GET', url: `${SITE}/api/y`, status: 200 }],
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer.length, 2);
  assert.equal(h.buffer()[1].requestId, undefined, 'the page row stands alone — nothing to merge with');
  assert.equal(h.buffer()[1].ts, NOW + 400);
});

test('25: a page row eleven seconds behind the webRequest row is a different request', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.setNow(NOW + 11_000);
  h.st.hookReady = true;
  h.fns.evOnPageEvents([{ t: 'net', ts: NOW + 11_000, method: 'GET', url: `${SITE}/api/x`, status: 500 }],
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer.length, 2);
  assert.deepEqual(h.buffer().map((e) => e.ts), [NOW, NOW + 11_000]);
});

test('25a: exactly on the merge window the twin is still adopted', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.setNow(NOW + h.caps.MERGE_MS);
  h.st.hookReady = true;
  h.fns.evOnPageEvents([{ t: 'net', ts: NOW + h.caps.MERGE_MS, method: 'GET', url: `${SITE}/api/x`, status: 500 }],
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(h.st.buffer.length, 1);
});

test('25b: the scan stops at the first row older than the merge window, even mid-buffer', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1', url: `${SITE}/api/x` }));
  // A hook batch replaying a row stamped a minute ago lands AFTER the fresh webRequest row, so
  // append order is not time order — and the backwards scan gives up on reaching it.
  h.fns.evPush(con({ ts: at(60), text: 'late and old' }));
  h.st.hookReady = true;
  h.fns.evPushPageNet({ method: 'GET', url: `${SITE}/api/x`, status: 500 }, NOW);
  assert.equal(h.st.buffer.length, 3, 'today the fresh twin one slot further back is never reached');
  assert.equal(h.buffer()[0].status, null);
  assert.equal(h.buffer()[2].fromPage, true);
});

test('26: a row the page already wrote is never adopted a second time', async () => {
  const h = await recording();
  h.st.buffer = [net({ ts: at(1), fromPage: true, status: 500, url: `${SITE}/api/x` })];
  h.fns.evPushPageNet({ method: 'GET', url: `${SITE}/api/x`, status: 503 }, at(0));
  assert.equal(h.st.buffer.length, 2);
  assert.deepEqual(h.buffer().map((e) => e.status), [500, 503]);
});

test('26a: a twin has to match on method as well as url', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1', method: 'GET' }));
  h.fns.evPushPageNet({ method: 'POST', url: `${SITE}/api/x`, status: 500 }, NOW + 100);
  assert.equal(h.st.buffer.length, 2);
});

test('26b: a page row nobody else saw carries the hook-only fields and its own defaults', async () => {
  const h = await recording();
  h.fns.evPushPageNet({ url: `${SITE}/api/z`, bodySkipped: true }, at(2));
  assert.deepEqual(h.buffer(), [{ ts: at(2), kind: 'network', fromPage: true, method: 'GET',
    url: `${SITE}/api/z`, resourceType: 'fetch', status: null, errorText: null, mimeType: null,
    durationMs: null, bodySkipped: true }]);
});

// ============================ the source split and the webRequest backbone ============================

test('27: once the hook says hello a top-frame xhr is the hook\'s, not webRequest\'s', async () => {
  const h = await recording();
  h.st.hookReady = true;
  assert.equal(h.fns.evWrOwns(wrq({ frameId: 0, type: 'xmlhttprequest' })), false);
  h.st.hookReady = false;
  assert.equal(h.fns.evWrOwns(wrq({ frameId: 0, type: 'xmlhttprequest' })), true);
});

test('28: the hook only patches the top frame, so a sub-frame xhr stays webRequest\'s', async () => {
  const h = await recording();
  h.st.hookReady = true;
  assert.equal(h.fns.evWrOwns(wrq({ frameId: 1, type: 'xmlhttprequest' })), true);
});

test('29: the resource types webRequest actually reports for the rest of the page stay ours', async () => {
  const h = await recording();
  h.st.hookReady = true;
  // Chrome reports fetch() AS xmlhttprequest; a literal 'fetch' is not a type the browser sends.
  for (const type of ['fetch', 'main_frame', 'sub_frame', 'script', 'image', 'stylesheet', 'websocket']) {
    assert.equal(h.fns.evWrOwns(wrq({ frameId: 0, type })), true, type);
  }
});

test('30: a request from a tab nobody is recording is nobody\'s', async () => {
  const h = await ready();
  assert.equal(h.fns.evWrOwns(wrq()), false);
  h.st.session = { tabId: TAB };
  assert.equal(h.fns.evWrOwns(wrq({ tabId: 9 })), false);
  assert.equal(h.fns.evWrOwns(wrq({ tabId: -1 })), false, 'a request with no tab at all');
  assert.equal(h.fns.evWrOwns(wrq({ tabId: TAB })), true);
});

test('31: a fresh top-frame navigation retires the old document\'s hook', async () => {
  const h = await recording();
  h.st.hookReady = true;
  h.fns.evWrStart(wrq({ requestId: 'n1', type: 'main_frame', frameId: 0, url: `${SITE}/next` }));
  assert.equal(h.st.hookReady, false);
});

test('31a: a sub-frame navigating does not retire the top frame\'s hook', async () => {
  const h = await recording();
  h.st.hookReady = true;
  h.fns.evWrStart(wrq({ requestId: 'n1', type: 'main_frame', frameId: 1, url: `${SITE}/frame` }));
  assert.equal(h.st.hookReady, true);
});

test('31b: a request webRequest opened is on the buffer and findable by its id', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1', type: 'script', url: `${SITE}/app.js` }));
  assert.deepEqual(h.buffer(), [{ ts: NOW, kind: 'network', requestId: 'r1', method: 'GET',
    url: `${SITE}/app.js`, resourceType: 'script', status: null, errorText: null }]);
  assert.equal(h.st.net.get('r1'), h.st.buffer[0], 'the map holds the row itself, not a copy');
});

test('31c: a request from a tab nobody is recording never reaches the buffer', async () => {
  const h = await ready();
  h.fns.evWrStart(wrq());
  assert.equal(h.st.buffer.length, 0);
  assert.equal(h.st.net.size, 0);
});

test('32: a completion for a request nobody opened a row for does nothing', async () => {
  const h = await recording();
  h.fns.evWrDone({ requestId: 'ghost', statusCode: 200 });
  assert.equal(h.st.buffer.length, 0);
  h.fns.evWrError({ requestId: 'ghost', error: 'net::ERR_FAILED' });
  assert.equal(h.st.buffer.length, 0);
});

test('33: a finished request gets its status and how long it took, and leaves the map', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.setNow(NOW + 340);
  h.fns.evWrDone({ requestId: 'r1', statusCode: 404, fromCache: false });
  assert.deepEqual(h.buffer()[0], { ts: NOW, kind: 'network', requestId: 'r1', method: 'GET',
    url: `${SITE}/api/x`, resourceType: 'xmlhttprequest', status: 404, errorText: null, durationMs: 340 });
  assert.equal('fromCache' in h.st.buffer[0], false, 'a live request is not annotated as cached');
  assert.equal(h.st.net.size, 0);
});

test('33a: a request Chrome answered from cache says so', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.fns.evWrDone({ requestId: 'r1', statusCode: 200, fromCache: true });
  assert.equal(h.buffer()[0].fromCache, true);
});

test('34: a request that never got a status is filed as a zero with the browser\'s reason', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.setNow(NOW + 90);
  h.fns.evWrError({ requestId: 'r1', error: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(h.buffer()[0].status, 0);
  assert.equal(h.buffer()[0].errorText, 'net::ERR_NAME_NOT_RESOLVED');
  assert.equal(h.buffer()[0].durationMs, 90);
  assert.equal(h.st.net.size, 0);
});

test('34a: an error with no reason still reads as failed, and a status already known is kept', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1' }));
  h.st.net.get('r1').status = 206;
  h.fns.evWrError({ requestId: 'r1' });
  assert.equal(h.buffer()[0].errorText, 'failed');
  assert.equal(h.buffer()[0].status, 206);
});

test('35: a redirect closes the hop that finished and opens a row for where it went', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1', type: 'main_frame', method: 'GET', url: `${SITE}/old` }));
  h.setNow(NOW + 120);
  h.fns.evWrRedirect({ requestId: 'r1', tabId: TAB, frameId: 0, type: 'main_frame',
    statusCode: 301, redirectURL: `${SITE}/new` });
  assert.deepEqual(h.buffer(), [
    { ts: NOW, kind: 'network', requestId: 'r1', method: 'GET', url: `${SITE}/old`,
      resourceType: 'main_frame', status: 301, errorText: null, durationMs: 120, redirectedTo: `${SITE}/new` },
    { ts: NOW + 120, kind: 'network', requestId: 'r1', method: 'GET', url: `${SITE}/new`,
      resourceType: 'main_frame', status: null, errorText: null, redirectedFrom: `${SITE}/old` },
  ]);
  // The id now points at the new hop, so its completion lands there.
  h.fns.evWrDone({ requestId: 'r1', statusCode: 200 });
  assert.deepEqual(h.buffer().map((e) => e.status), [301, 200]);
});

test('36: a redirect the hook has taken over closes the old hop and opens nothing', async () => {
  const h = await recording();
  h.fns.evWrStart(wrq({ requestId: 'r1', url: `${SITE}/api/x` }));
  h.st.hookReady = true; // the hook said hello mid-chain
  h.setNow(NOW + 50);
  h.fns.evWrRedirect(wrq({ requestId: 'r1', statusCode: 302, redirectURL: `${SITE}/api/moved` }));
  assert.equal(h.st.buffer.length, 1);
  assert.equal(h.buffer()[0].status, 302);
  assert.equal(h.buffer()[0].redirectedTo, `${SITE}/api/moved`);
  assert.equal(h.st.net.size, 0, 'the id is dropped so a later completion cannot resurrect it');
});

test('36a: a redirect for an id with no row still opens the target\'s row', async () => {
  const h = await recording();
  h.fns.evWrRedirect(wrq({ requestId: 'r9', type: 'sub_frame', statusCode: 307, redirectURL: `${SITE}/b` }));
  assert.deepEqual(h.buffer(), [{ ts: NOW, kind: 'network', requestId: 'r9', method: 'GET',
    url: `${SITE}/b`, resourceType: 'sub_frame', status: null, errorText: null, redirectedFrom: null }]);
});

test('36b: the four webRequest events are wired up at load, not at start', async () => {
  const h = await ready();
  const wr = h.chrome.webRequest;
  assert.deepEqual(
    [wr.onBeforeRequest, wr.onCompleted, wr.onErrorOccurred, wr.onBeforeRedirect].map((b) => b.fns.length),
    [1, 1, 1, 1],
  );
  h.st.session = { tabId: TAB };
  h.wr('onBeforeRequest', wrq({ requestId: 'r1', type: 'script' }));
  h.wr('onCompleted', { requestId: 'r1', statusCode: 500 });
  assert.deepEqual(h.buffer().map((e) => e.status), [500]);
});

test('36c: a build with no webRequest permission still loads and still answers the panel', async () => {
  for (const opts of [{ noWebRequest: true }, { webRequestThrows: true }]) {
    const h = await ready(opts);
    assert.equal(typeof h.fns.evStatus, 'function');
    const res = await h.ask({ type: 'EVIDENCE_STATUS' });
    assert.equal(res.ok, true);
    assert.equal(res.status.recording, false);
  }
});

// ============================ start, stop, wipe ============================

test('37: the session is armed before the hook is injected, over a cleared buffer', async () => {
  const h = await recording();
  h.st.buffer = [con()];
  h.st.hookReady = true;
  h.st.net.set('stale', net());
  h.st.session = null;
  await h.fns.evStart(TAB, 'rec-1');
  assert.deepEqual(h.injects.map((i) => [i.files[0], i.world, i.target.tabId]), [
    ['evidence/relay.js', 'ISOLATED', TAB],
    ['evidence/page-hook.js', 'MAIN', TAB],
  ]);
  // The relay is listening before the hook lands, and both find a session already armed.
  assert.deepEqual(h.injects[0].state, { recording: true, tabId: TAB, entries: 0, hookReady: false });
  assert.equal(h.st.net.size, 0);
  assert.deepEqual(plain(h.st.session), { tabId: TAB, startedAt: NOW, recordId: 'rec-1',
    tabTitle: 'Cart', tabUrl: `${SITE}/cart` });
});

test('37a: starting wakes a hook a previous recording left muted, and registers the origin', async () => {
  const h = await ready();
  await h.fns.evStart(TAB, 'rec-1');
  assert.deepEqual(h.named('tabs.sendMessage'), [[TAB, { type: 'EVIDENCE_HOOK_ON' }]]);
  assert.equal(h.named('scripting.registerContentScripts').length, 1);
  assert.equal(h.named('storage.session.set').length, 1);
});

test('37b: a start with no recordId still records — the panel just cannot claim it', async () => {
  const h = await ready();
  await h.fns.evStart(TAB);
  assert.equal(h.st.session.recordId, null);
});

test('38: a tab that slipped onto a restricted page names that, not the raw API error', async () => {
  const h = await ready();
  h.hooks.executeScript = () => { throw new Error('Cannot access contents of the page'); };
  await assert.rejects(h.fns.evStart(TAB, 'rec-1'), {
    message: 'Chrome doesn’t allow extensions on this page (chrome://…, the Web Store, another '
      + 'extension’s page), so it can’t be recorded — switch to the site under test.',
  });
  assert.equal(h.st.session, null);
  assert.equal(h.named('storage.session.set').length, 1, 'the mirror records that nothing is recording');
  assert.equal(h.named('tabs.sendMessage').length, 0, 'no hook to wake');
  assert.equal(h.named('scripting.registerContentScripts').length, 0);
});

test('39: a tab whose title Chrome hides is still recordable under a placeholder name', async () => {
  const h = await ready();
  h.hooks.getTab = () => { throw new Error('No tab with id 5'); };
  await h.fns.evStart(TAB, 'rec-1');
  assert.equal(h.st.session.tabTitle, `Tab ${TAB}`);
  assert.equal(h.st.session.tabUrl, '');
  assert.equal(h.fns.evStatus().recording, true);
  // No url means no origin, so the document_start registration is skipped, not attempted.
  assert.equal(h.named('scripting.registerContentScripts').length, 0);
});

test('39a: a tab with a url but no title falls back to the url before the placeholder', async () => {
  const h = await ready();
  h.hooks.getTab = (id) => ({ id, url: `${SITE}/cart` });
  await h.fns.evStart(TAB, 'rec-1');
  assert.equal(h.st.session.tabTitle, `${SITE}/cart`);
});

test('40: stopping keeps the evidence, drops everything else, and waits for the mirror', async () => {
  const h = await recording();
  h.st.buffer = [con(), net()];
  h.st.hookReady = true;
  h.st.net.set('r1', net());
  await h.fns.evStop(true);
  assert.equal(h.st.session, null);
  assert.equal(h.st.hookReady, false);
  assert.equal(h.st.net.size, 0);
  assert.equal(h.st.buffer.length, 2, 'the tester can still attach what was recorded');
  assert.deepEqual(h.named('tabs.sendMessage'), [[TAB, { type: 'EVIDENCE_HOOK_OFF' }]]);
  assert.deepEqual(h.names(),
    ['tabs.sendMessage', 'scripting.unregisterContentScripts', 'storage.session.set']);
  assert.deepEqual(plain(h.session.evidenceMirror.session), null);
});

test('40a: stopping when nothing is recording sends the hook nothing', async () => {
  const h = await ready();
  await h.fns.evStop(true);
  assert.equal(h.named('tabs.sendMessage').length, 0);
  assert.deepEqual(h.named('scripting.unregisterContentScripts'), [[{ ids: ['testomat-evidence-relay',
    'testomat-evidence-hook'] }]]);
});

test('41: stopping without keeping the buffer leaves nothing to attach', async () => {
  const h = await recording();
  h.st.buffer = [con(), net()];
  await h.fns.evStop(false);
  assert.equal(h.st.buffer.length, 0);
  assert.deepEqual(plain(h.session.evidenceMirror.buffer), []);
});

test('42: a stop nobody clicked when nothing is recording tells nobody', async () => {
  const h = await ready();
  assert.equal(await h.fns.evStopIfRecording('panel-closed'), false);
  assert.equal(h.named('runtime.sendMessage').length, 0);
  assert.equal(h.named('storage.session.set').length, 0, 'nothing happened, nothing is mirrored');
});

test('43: a stop nobody clicked broadcasts the reason exactly once', async () => {
  const h = await recording();
  assert.equal(await h.fns.evStopIfRecording('target_closed'), true);
  assert.deepEqual(h.named('runtime.sendMessage'), [[{ type: 'EVIDENCE_STOPPED', reason: 'target_closed' }]]);
  assert.equal(h.st.session, null);
  assert.equal(await h.fns.evStopIfRecording('target_closed'), false);
  assert.equal(h.named('runtime.sendMessage').length, 1);
});

test('43a: closing the recorded tab ends the recording; closing another tab does not', async () => {
  const h = await recording();
  h.emit('tabs.onRemoved', 99);
  await h.settle();
  assert.equal(h.fns.evStatus().recording, true);
  h.emit('tabs.onRemoved', TAB);
  await h.settle();
  assert.equal(h.fns.evStatus().recording, false);
  assert.deepEqual(h.named('runtime.sendMessage'), [[{ type: 'EVIDENCE_STOPPED', reason: 'target_closed' }]]);
});

test('43b: the recorded tab navigating re-injects the hook; another tab is ignored', async () => {
  const h = await recording();
  h.emit('tabs.onUpdated', 99, { status: 'loading' });
  h.emit('tabs.onUpdated', TAB, { title: 'Cart (1)' });
  await h.settle();
  assert.equal(h.injects.length, 0);
  h.emit('tabs.onUpdated', TAB, { status: 'loading' });
  await h.settle();
  assert.deepEqual(h.injects.map((i) => i.files[0]), ['evidence/relay.js', 'evidence/page-hook.js']);
  // A tab that navigated somewhere we cannot reach must not take the worker down with it.
  h.hooks.executeScript = () => { throw new Error('Cannot access contents of the page'); };
  h.emit('tabs.onUpdated', TAB, { status: 'complete' });
  await h.settle();
  assert.equal(h.fns.evStatus().recording, true);
});

test('44: wiping cancels the pending mirror so its write cannot outlive the removal', async () => {
  const h = await recording();
  h.st.buffer = [con()];
  h.fns.evScheduleMirror();
  assert.equal(h.pending().length, 1);
  await h.fns.evWipe();
  assert.deepEqual(h.pending(), [], 'a mirror firing after the remove would restore the key');
  const order = h.names().filter((n) => n.startsWith('storage.session'));
  assert.deepEqual(order, ['storage.session.set', 'storage.session.remove']);
  assert.equal('evidenceMirror' in h.session, false);
  assert.equal(h.st.buffer.length, 0);
  assert.equal(h.st.session, null);
});

test('44a: a wipe waits for a restore still in flight before it drops anything', async () => {
  const h = load({ deferRestore: true, mirror: { session: { tabId: TAB }, buffer: [con()] } });
  const done = h.fns.evWipe();
  await h.settle();
  assert.equal(h.named('storage.session.remove').length, 0, 'nothing removed while the read is open');
  h.release();
  await done;
  assert.equal('evidenceMirror' in h.session, false);
  assert.equal(h.st.buffer.length, 0);
});

test('44b: a wipe on a build with no storage.session still stops and clears', async () => {
  const h = await ready({ noSession: true });
  h.st.session = { tabId: TAB };
  h.st.buffer = [con()];
  await h.fns.evWipe();
  assert.equal(h.st.session, null);
  assert.equal(h.st.buffer.length, 0);
});

test('44c: status is what the panel reconciles against, before and during a recording', async () => {
  const h = await ready({ settings: { evidenceWindowSec: 120 } });
  await h.fns.evLoadSettings();
  assert.deepEqual(h.status(),
    { recording: false, tabId: null, recordId: null, tabTitle: '', tabUrl: '', windowSec: 120, entryCount: 0 });
  await h.fns.evStart(TAB, 'rec-1');
  h.fns.evPush(con());
  assert.deepEqual(h.status(),
    { recording: true, tabId: TAB, recordId: 'rec-1', tabTitle: 'Cart', tabUrl: `${SITE}/cart`,
      windowSec: 120, entryCount: 1 });
});

// ============================ the mirror and the restore ============================

test('45: a burst of activity costs one mirror write, not fifty', async () => {
  const h = await recording();
  for (let i = 0; i < 50; i += 1) h.fns.evScheduleMirror();
  assert.equal(h.pending().length, 1);
  h.advance(h.caps.MIRROR_MS - 1);
  assert.equal(h.named('storage.session.set').length, 0);
  h.advance(1);
  assert.equal(h.named('storage.session.set').length, 1);
  // The timer is free again, so the next burst is mirrored too.
  h.fns.evScheduleMirror();
  h.advance(h.caps.MIRROR_MS);
  assert.equal(h.named('storage.session.set').length, 2);
});

test('46: a mirror write the quota refused is swallowed and the tester is never told', async () => {
  const h = await recording();
  h.hooks.sessionSet = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await assert.doesNotReject(h.fns.evMirror());
  h.fns.evPush(con());
  h.advance(h.caps.MIRROR_MS);
  await h.settle();
  assert.equal(h.fns.evStatus().recording, true, 'recording carries on believing it is crash-safe');
});

test('47: a build with no storage.session mirrors nothing and throws nothing', async () => {
  const h = await ready({ noSession: true });
  const p = h.fns.evMirror();
  assert.ok(p instanceof Promise || typeof p.then === 'function');
  await assert.doesNotReject(p);
  h.fns.evPush(con());
  h.advance(h.caps.MIRROR_MS);
  await h.settle();
});

test('48: a worker waking up to a recording whose tab is gone drops the session and says so', async () => {
  const h = load({ mirror: { session: { tabId: TAB, recordId: 'rec-1' }, buffer: [con()], windowSec: 60 } });
  h.hooks.getTab = () => { throw new Error('No tab with id 5'); };
  await h.ready;
  assert.equal(h.st.session, null);
  assert.equal(h.st.buffer.length, 1, 'the evidence outlives the tab that produced it');
  assert.equal(h.named('scripting.unregisterContentScripts').length, 1);
  assert.deepEqual(plain(h.session.evidenceMirror.session), null);
  assert.equal(h.st.restored, true);
});

test('48a: a worker waking up to a live recording keeps it and re-attaches nothing', async () => {
  const h = load({ mirror: { session: { tabId: TAB, recordId: 'rec-1' }, buffer: [con(), net()] } });
  await h.ready;
  assert.equal(h.st.session.recordId, 'rec-1');
  assert.equal(h.st.buffer.length, 2);
  assert.equal(h.named('scripting.unregisterContentScripts').length, 0, 'the registration is still ours');
  assert.equal(h.named('storage.session.set').length, 0);
});

test('49: a cold start with nothing mirrored still sweeps a leftover registration', async () => {
  const h = load();
  await h.ready;
  assert.equal(h.st.session, null);
  assert.deepEqual(h.named('scripting.unregisterContentScripts'), [[{ ids: ['testomat-evidence-relay',
    'testomat-evidence-hook'] }]]);
  assert.equal(h.st.restored, true);
});

test('49a: a mirror read that throws leaves a clean worker rather than a half-restored one', async () => {
  const h = load({ sessionGetFails: true });
  await h.ready;
  assert.equal(h.st.session, null);
  assert.deepEqual(h.buffer(), []);
  assert.equal(h.st.restored, true);
});

test('50: a mirror whose buffer is not a list restores as an empty one', async () => {
  const h = load({ mirror: { session: null, buffer: 'not-a-list' } });
  await h.ready;
  assert.deepEqual(h.buffer(), []);
});

test('51: a toggle answered before the restore lands is overwritten by the stale mirror', async () => {
  const h = load({ deferRestore: true, mirror: { session: { tabId: 77, recordId: 'stale' }, buffer: [] } });
  const res = await h.ask({ type: 'EVIDENCE_TOGGLE', tabId: TAB, recordId: 'rec-1' });
  assert.equal(res.status.tabId, TAB, 'the fresh recording answered the panel');
  h.release();
  await h.ready;
  // Today the handler does not await evReady, so the restore lands second and wins.
  assert.equal(h.st.session.recordId, 'stale');
  assert.equal(h.fns.evStatus().tabId, 77);
});

test.todo('51 (#315): a toggle answered before the restore lands keeps the recording it started', async () => {
  const h = load({ deferRestore: true, mirror: { session: { tabId: 77, recordId: 'stale' }, buffer: [] } });
  await h.ask({ type: 'EVIDENCE_TOGGLE', tabId: TAB, recordId: 'rec-1' });
  h.release();
  await h.ready;
  assert.equal(h.st.session.recordId, 'rec-1');
});

// ============================ the protocol and the registrations ============================

test('52: a hook batch arriving after the restore is answered on the spot', async () => {
  const h = await recording();
  const s = h.send({ type: 'EVIDENCE_EVENTS', events: [{ t: 'console', ts: at(1), text: 'boom' }] },
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(s.sync, 1, 'a busy page must not queue microtasks behind a storage read');
  assert.equal(s.ret, undefined, 'the channel is not held open');
  assert.deepEqual(s.replies, [{ off: false }]);
  assert.equal(h.st.buffer.length, 1);
});

test('52a: a batch that is not a list is answered, not thrown at', async () => {
  const h = await recording();
  const s = h.send({ type: 'EVIDENCE_EVENTS' }, { tab: { id: TAB }, frameId: 0 });
  assert.deepEqual(s.replies, [{ off: false }]);
  assert.equal(h.st.buffer.length, 0);
});

test('53: a hook batch that beats the restore is held open and answered after it', async () => {
  const h = load({ deferRestore: true, mirror: { session: { tabId: TAB }, buffer: [] } });
  const s = h.send({ type: 'EVIDENCE_EVENTS', events: [{ t: 'console', ts: at(1), text: 'boom' }] },
    { tab: { id: TAB }, frameId: 0 });
  assert.equal(s.ret, true, 'the channel is held open');
  assert.equal(s.sync, 0);
  await h.settle();
  assert.equal(s.sync, 0, 'still nothing: the mirror read has not resolved');
  h.release();
  await h.ready;
  await h.settle();
  // The restored session owns tab 5, so the batch is kept rather than muted.
  assert.deepEqual(s.replies, [{ off: false }]);
  assert.equal(h.st.buffer.length, 1);
});

test('54: asking for errors only leaves the healthy rows out and keeps the order', async () => {
  const h = await recording();
  h.st.buffer = [net({ ts: at(2), status: 500, url: `${SITE}/api/b` }), con({ ts: at(4), level: 'info', text: 'i' }),
    con({ ts: at(6), level: 'error', text: 'boom' }), net({ ts: at(8), status: 200, url: `${SITE}/api/a` })];
  const all = await h.ask({ type: 'EVIDENCE_LIST' });
  assert.deepEqual(all.entries.map((e) => e.ts), [at(8), at(6), at(4), at(2)]);
  const errs = await h.ask({ type: 'EVIDENCE_LIST', errorsOnly: true });
  assert.deepEqual(errs.entries.map((e) => e.ts), [at(6), at(2)]);
  assert.equal(errs.status.entryCount, 4, 'the status still counts the whole buffer');
  const snap = await h.ask({ type: 'EVIDENCE_SNAPSHOT' });
  assert.deepEqual(snap.entries.map((e) => e.ts), [at(8), at(6), at(4), at(2)]);
});

test('55: a message that is not the recorder\'s leaves the channel to whoever owns it', async () => {
  const h = await recording();
  for (const msg of [null, undefined, {}, { type: 'EVIDENCE_STOPPED', reason: 'x' },
    { type: 'STEPREC_ADD' }, { type: 'EVIDENCE' }]) {
    const s = h.send(msg);
    assert.equal(s.ret, undefined, JSON.stringify(msg));
    assert.equal(s.sync, 0);
  }
  await h.settle();
  assert.deepEqual(h.names(), []);
});

test('55a: every request the panel and the hook send is claimed', async () => {
  const h = await recording();
  assert.deepEqual([...h.caps.REQUESTS], ['EVIDENCE_TOGGLE', 'EVIDENCE_STOP', 'EVIDENCE_STATUS',
    'EVIDENCE_LIST', 'EVIDENCE_SNAPSHOT', 'EVIDENCE_EVENTS', 'EVIDENCE_WIPE']);
});

test('56: a start that fails answers with the reason AND the status, not a dead channel', async () => {
  const h = await ready();
  h.hooks.executeScript = () => { throw new Error('Cannot access contents of the page'); };
  const res = await h.ask({ type: 'EVIDENCE_TOGGLE', tabId: TAB, recordId: 'rec-1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Chrome doesn’t allow extensions on this page/);
  assert.equal(res.status.recording, false, 'the panel can repaint from a failed reply');
});

test('56a: the toggle starts, then stops, and the stop is idempotent', async () => {
  const h = await ready();
  const on = await h.ask({ type: 'EVIDENCE_TOGGLE', tabId: TAB, recordId: 'rec-1' });
  assert.deepEqual([on.ok, on.status.recording, on.status.tabId], [true, true, TAB]);
  const off = await h.ask({ type: 'EVIDENCE_TOGGLE', tabId: TAB });
  assert.deepEqual([off.ok, off.status.recording], [true, false]);
  h.clearCalls();
  const again = await h.ask({ type: 'EVIDENCE_STOP', reason: 'left the run' });
  assert.equal(again.ok, true);
  assert.equal(h.named('runtime.sendMessage').length, 0, 'nothing was recording, nobody is told');
});

test('56b: a toggle with no tab to record is answered without starting anything', async () => {
  const h = await ready();
  const res = await h.ask({ type: 'EVIDENCE_TOGGLE' });
  assert.deepEqual([res.ok, res.status.recording], [true, false]);
  assert.equal(h.injects.length, 0);
});

test('56c: the stop message names its reason in the broadcast, defaulting to "stopped"', async () => {
  const h = await recording();
  await h.ask({ type: 'EVIDENCE_STOP' });
  assert.deepEqual(h.named('runtime.sendMessage'), [[{ type: 'EVIDENCE_STOPPED', reason: 'stopped' }]]);
});

test('56d: the wipe message clears the evidence and reports an empty status', async () => {
  const h = await recording();
  h.st.buffer = [con(), net()];
  const res = await h.ask({ type: 'EVIDENCE_WIPE' });
  assert.deepEqual([res.ok, res.status.recording, res.status.entryCount], [true, false, 0]);
  assert.equal('evidenceMirror' in h.session, false);
});

test('57: a localhost origin is registered without its port, so every port matches', async () => {
  const h = await ready();
  assert.equal(await h.fns.evRegister('http://localhost'), true);
  assert.deepEqual(h.named('scripting.registerContentScripts'), [[[
    { id: 'testomat-evidence-relay', js: ['evidence/relay.js'], matches: ['http://localhost/*'],
      runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: false },
    { id: 'testomat-evidence-hook', js: ['evidence/page-hook.js'], matches: ['http://localhost/*'],
      runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false },
  ]]]);
});

test('57a: a tester recording localhost:3000 gets the whole of localhost instrumented', async () => {
  const h = await ready();
  h.hooks.getTab = (id) => ({ id, title: 'Dev', url: 'http://localhost:3000/checkout' });
  await h.fns.evStart(TAB, 'rec-1');
  assert.deepEqual(h.named('scripting.registerContentScripts')[0][0].map((s) => s.matches),
    [['http://localhost/*'], ['http://localhost/*']]);
});

test('57b: a registration the API refuses is reported, not thrown', async () => {
  const h = await ready();
  h.hooks.registerContentScripts = () => { throw new Error('Invalid match pattern'); };
  assert.equal(await h.fns.evRegister('https://shop.example.com'), false);
  const bare = await ready({ noRegisterApi: true });
  assert.equal(await bare.fns.evRegister('https://shop.example.com'), false);
  assert.equal(bare.named('scripting.unregisterContentScripts').length, 1, 'the sweep runs regardless');
});

test('58: registering nothing still sweeps whatever the last recording left behind', async () => {
  const h = await ready();
  assert.equal(await h.fns.evRegister(null), false);
  assert.deepEqual(h.named('scripting.unregisterContentScripts'), [[{ ids: ['testomat-evidence-relay',
    'testomat-evidence-hook'] }]]);
  assert.equal(h.named('scripting.registerContentScripts').length, 0);
});

test('58a: an unregister the API cannot do is not an error the recording dies on', async () => {
  const h = await ready({ noUnregisterApi: true });
  await assert.doesNotReject(h.fns.evUnregister());
  await h.fns.evStart(TAB, 'rec-1');
  assert.equal(h.fns.evStatus().recording, true);
});
