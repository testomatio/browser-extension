#!/usr/bin/env node
// extension/screenrec/session.js: the worker's own state machine for a screen recording — the
// parked-take guard on start, the CDP cast ladder and the one teardown that takes Chrome's
// "…is debugging" bar down, and the single-panel claim on the finished file.
// Cases numbered as in issue 166. Run: node --test tests/screenrec-session.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// SREC_SRC runs the whole file against another copy — a mutation, or an older revision for the
// historical check — so a falsification run never has to edit the shipped module.
const SRC = process.env.SREC_SRC || join(repoRoot, 'extension/screenrec/session.js');
const source = readFileSync(SRC, 'utf8');
// The worker's own sibling, evaluated in the SAME realm below rather than stubbed: a stub would keep
// every parked row green while testing nothing. SREC_PARKED_SRC points it at a mutated copy.
const PARKED_SRC = process.env.SREC_PARKED_SRC || join(repoRoot, 'extension/screenrec/parked.js');
const parkedSource = readFileSync(PARKED_SRC, 'utf8');
const BG_SOURCE = readFileSync(join(repoRoot, 'extension/background.js'), 'utf8');

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One turn of the macrotask queue drains every microtask behind it; three is the cheap margin for
// this file's own chains (srecStop → teardown → the OFF hop → srecFinish → the review inject).
const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// The whole surface the rows reach for. Every top-level `function` lands on the sandbox anyway; the
// arrows (srecGet, srecCastOwnsReady, the constants…) are lexical and come back as the completion
// value. Read through `typeof`, so a mutated copy that deletes a name still loads.
const NAMES = [
  'srecCastOwns', 'srecCastOwnsReady', 'srecGet', 'srecSet', 'srecClear', 'srecParked',
  'srecOff', 'srecTell', 'srecEnsureDoc', 'srecCloseDoc', 'castSend', 'castAttach', 'castDetach',
  'srecStartCast', 'srecTeardownCast', 'srecName', 'srecStart', 'srecStop', 'srecFinish',
  'srecOpenReview', 'srecPause', 'srecStatus', 'srecInjectBar', 'srecMenu', 'srecTarget',
  'srecToggle', 'CAST_PARAMS', 'SREC_CLAIM_MS', 'SREC_TIME_CAP_MS', 'SREC_KEY', 'SREC_FILE_KEY',
  'SREC_TARGET_KEY', 'SREC_DOC', 'SREC_MENU_ID', 'SREC_COMMAND',
];
const PICK = `;({ ${NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} });`;

// The instant every row is frozen at, so a parked record's `name` is the same string everywhere.
// Built from local fields, never a UTC epoch: srecName reads getHours(), not getUTCHours().
const NOW = new Date(2026, 8, 3, 12, 56, 0).getTime();
const NAME_AT_NOW = 'screen-recording-2026-09-03-1256.webm';
const PARKED_REFUSAL = 'A recording is waiting to be reviewed or attached — finish it first';
// Chrome's own wording for the refusal shared/dbg-errors.js matches on.
const FOREIGN_FRAME_MSG = 'Cannot access a chrome-extension:// URL of different extension';

const SITE_TAB = Object.freeze({ id: 7, url: 'https://shop.example.com/cart', active: true });

// chrome.storage.get, the argument shapes this file uses (a bare key string).
function readKeys(store, keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
  const out = {};
  for (const k of keys) if (k in store) out[k] = store[k];
  return out;
}

function load(opts = {}) {
  const { now = NOW, session = {} } = opts;

  const calls = [];               // every stubbed call, in order: {name, args}
  const sess = plain(session);    // storage.session, a plain object
  let clock = now;
  let lastError;                  // read through a getter, cleared the moment a callback returns
  let attachSeq = 0;

  const log = (name, ...args) => { calls.push({ name, args: args.map(plain) }); };

  // The knobs a row turns. A test overrides one AFTER load(); the stubs read them live.
  const hooks = {
    // The offscreen document's replies, keyed by SCREENREC_OFF cmd. Resolving is the default on
    // purpose: a rejecting sendMessage makes srecOff answer null, which every caller here reads as
    // "the document refused" — the easy way to pass a row for the wrong reason.
    off: {},
    offDefault: { ok: true },
    sendMessage: null,            // set to take the whole broadcast channel over
    getContexts: () => [{ documentId: 'doc-1' }],
    createDocument: async () => {},
    closeDocument: async () => {},
    originOf: (url) => (/^https?:\/\//.test(String(url || '')) ? String(url).split('/').slice(0, 3).join('/') : null),
    resolveSiteTab: () => ({ state: 'ok', tab: { ...SITE_TAB } }),
    foreignFrame: (msg) => /chrome-extension:\/\/ URL of different extension/.test(String(msg || '')),
    dbgAttach: () => null,        // a string here becomes chrome.runtime.lastError
    dbgDetach: () => null,
    dbgSend: () => ({}),          // {error} or {res}
    getMediaStreamId: async () => 'stream-1',
    executeScript: async () => [],
    updateTab: async (id, props) => ({ id, ...props }),
    createTab: async (props) => ({ id: 99, ...props }),
  };

  const bus = () => {
    const fns = [];
    return { fns, addListener: (fn) => { fns.push(fn); }, removeListener: () => {}, hasListener: (fn) => fns.includes(fn) };
  };
  // Never a broadcast: in the worker these channels carry background.js's and the recorders'
  // listeners too, so a row calls the listener THIS file registered and nothing else.
  const only = (b) => {
    assert.equal(b.fns.length, 1, 'session.js should register exactly one listener here');
    return b.fns[0];
  };

  // A callback-style API reports its failure through lastError and clears it on the way out.
  const withLastError = (msg, fn) => {
    lastError = msg ? { message: msg } : undefined;
    try { return fn(); } finally { lastError = undefined; }
  };

  const runtime = {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    get lastError() { return lastError; },
    getURL: (path) => `chrome-extension://${runtime.id}/${String(path)}`,
    getContexts: async (filter) => { log('runtime.getContexts', filter); return hooks.getContexts(filter); },
    sendMessage: async (msg) => {
      log('runtime.sendMessage', msg);
      if (hooks.sendMessage) return hooks.sendMessage(plain(msg));
      if (msg && msg.type === 'SCREENREC_OFF') {
        if (msg.cmd in hooks.off) {
          const r = hooks.off[msg.cmd];
          return typeof r === 'function' ? r(plain(msg)) : r;
        }
        return hooks.offDefault;
      }
      return undefined;
    },
    onMessage: bus(),
    onConnect: bus(),
    onInstalled: bus(),
    onStartup: bus(),
  };

  const storageArea = (store, area) => ({
    get: async (keys) => { log(`storage.${area}.get`, keys); return plain(readKeys(store, keys)); },
    // Chrome structured-clones on the way in; an alias would hide what a read-modify-write guards.
    set: async (obj) => { log(`storage.${area}.set`, obj); Object.assign(store, plain(obj)); },
    remove: async (key) => {
      log(`storage.${area}.remove`, key);
      for (const k of Array.isArray(key) ? key : [key]) delete store[k];
    },
  });

  const chromeStub = {
    runtime,
    storage: { session: storageArea(sess, 'session') },
    offscreen: {
      createDocument: (o) => { log('offscreen.createDocument', o); return hooks.createDocument(plain(o)); },
      closeDocument: () => { log('offscreen.closeDocument'); return hooks.closeDocument(); },
    },
    tabCapture: {
      getMediaStreamId: (o) => { log('tabCapture.getMediaStreamId', o); return hooks.getMediaStreamId(plain(o)); },
    },
    tabs: {
      onUpdated: bus(),
      onRemoved: bus(),
      update: (id, props) => { log('tabs.update', id, props); return hooks.updateTab(id, plain(props)); },
      create: (props) => { log('tabs.create', props); return hooks.createTab(plain(props)); },
    },
    scripting: {
      executeScript: (arg) => { log('scripting.executeScript', arg); return hooks.executeScript(plain(arg)); },
    },
    debugger: {
      onEvent: bus(),
      onDetach: bus(),
      attach: (target, version, cb) => {
        log('debugger.attach', target, version);
        attachSeq += 1;
        withLastError(hooks.dbgAttach(plain(target), attachSeq), cb);
      },
      detach: (target, cb) => { log('debugger.detach', target); withLastError(hooks.dbgDetach(plain(target)), cb); },
      sendCommand: (target, cmd, params, cb) => {
        log('debugger.sendCommand', target, cmd, params);
        const out = hooks.dbgSend(cmd, plain(params), plain(target)) || {};
        withLastError(out.error, () => cb(out.error ? undefined : out.res));
      },
    },
    contextMenus: {
      onClicked: bus(),
      create: (props, cb) => { log('contextMenus.create', props); withLastError(null, () => cb && cb()); },
    },
    commands: { onCommand: bus() },
  };

  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }

    static now() { return clock; }
  }

  const sandbox = {
    chrome: chromeStub,
    console,
    Date: FakeDate,
    URL,
    // The five worker globals session.js declares at the top and its siblings own.
    SiteTab: {
      originOf: (url) => { log('SiteTab.originOf', url); return hooks.originOf(url); },
      restrictedCopy: (verb) => { log('SiteTab.restrictedCopy', verb); return `restricted:${verb}`; },
    },
    resolveSiteTab: async (o) => { log('resolveSiteTab', o); return hooks.resolveSiteTab(plain(o)); },
    dbgIsForeignFrame: (msg) => { log('dbgIsForeignFrame', msg); return hooks.foreignFrame(msg); },
    foreignFramesOut: async (tabId) => { log('foreignFramesOut', tabId); },
    foreignFramesBack: async (tabId) => { log('foreignFramesBack', tabId); },
  };

  const context = createContext(sandbox);
  // Same realm, before session.js: importScripts is what makes a sibling's top-level `const` — and
  // the bare names this file destructures off it — resolve here.
  runInContext(parkedSource, context, { filename: PARKED_SRC });
  const api = runInContext(`${source}\n${PICK}`, context, { filename: SRC });

  const makePort = (name, o = {}) => {
    const posted = [];
    const p = {
      name,
      posted,
      onMessage: bus(),
      onDisconnect: bus(),
      postMessage: (m) => { posted.push(plain(m)); if (o.dead) throw new Error('Attempting to use a disconnected port'); },
      disconnect: () => p.onDisconnect.fns.forEach((fn) => fn()),
    };
    return p;
  };

  return {
    api,
    hooks,
    calls,
    session: sess,
    settle,
    context,
    // Sibling scripts share the worker's global lexical scope; importScripts is what makes a
    // top-level `const` here reachable from background.js.
    evalHere: (code) => runInContext(code, context, { filename: 'probe' }),

    named: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    order: () => calls.map((c) => c.name),
    clearCalls: () => { calls.length = 0; },
    // Everything srecTell/srecOff put on the broadcast channel, as plain objects.
    sent: () => calls.filter((c) => c.name === 'runtime.sendMessage').map((c) => c.args[0]),
    events: () => calls.filter((c) => c.name === 'runtime.sendMessage')
      .map((c) => c.args[0]).filter((m) => m && m.type === 'SCREENREC_EVENT'),

    now: () => clock,
    advance: (ms) => { clock += ms; return clock; },
    parked: () => plain(sess.screenRecFile),
    live: () => plain(sess.screenRec),

    // One trip through THIS file's onMessage listener. SCREENREC_FILE answers `false` — a harness
    // that only ever waited for sendResponse would hang on it.
    message: (msg, sender = {}) => new Promise((resolve) => {
      let answered = false;
      const ret = only(runtime.onMessage)(msg, sender, (r) => {
        if (!answered) { answered = true; resolve(plain(r)); }
      });
      if (ret !== true) resolve(undefined);
    }),
    emit: (path, ...args) => path.split('.').reduce((o, k) => o[k], chromeStub).fns.map((fn) => fn(...args)),
    connect: (name, o) => { const p = makePort(name, o); only(runtime.onConnect)(p); return p; },
    makePort,
  };
}

// The `srecGet()` at the foot of the file re-seeds the castTab mirror; without this the whole cast
// section would assert against a mirror that is still null and pass vacuously.
const open = async (opts) => { const h = load(opts); await h.settle(); return h; };

// A worker that restarted onto a cast already in flight — the state rows 14-22 need.
const CASTING = (over = {}) => ({
  screenRec: { recording: true, paused: false, tabId: 7, recordId: 'r-1', mode: 'cast', framesOut: false, startedAt: NOW - 5000, ...over },
});
const TAKE = (over = {}) => ({ url: 'blob:parked', size: 4096, ms: 8000, reason: 'user', name: NAME_AT_NOW, recordId: 'r-1', reviewed: false, ...over });

// ---- start, and the parked guard -------------------------------------------

test('1: a tester who presses record twice is told the first recording is still running', async () => {
  const h = await open({ session: { screenRec: { recording: true, tabId: 7, mode: 'tab' } } });
  assert.deepEqual(plain(await h.api.srecStart({ recordId: 'r-2' })), {
    ok: false, reason: 'A screen recording is already running',
  });
  assert.equal(h.named('resolveSiteTab').length, 0);
});

test('2: a take waiting to be reviewed refuses the next record before any tab is touched', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(plain(await h.api.srecStart({ recordId: 'r-2' })), {
    ok: false, reason: PARKED_REFUSAL, parked: true,
  });
  assert.deepEqual(h.named('resolveSiteTab'), []);
  assert.deepEqual(h.named('tabCapture.getMediaStreamId'), []);
  assert.deepEqual(h.named('debugger.attach'), []);
  assert.deepEqual(h.named('scripting.executeScript'), []);
  assert.equal(h.parked().url, 'blob:parked'); // the tester's take is still there
});

test('3: the hotkey refused by a parked take answers with the review instead of silence', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  await h.api.srecToggle({ ...SITE_TAB });
  await h.settle();
  assert.deepEqual(h.named('resolveSiteTab'), [[{ verb: 'reviewed', activate: true }]]);
});

test('4: a hotkey fired on chrome://extensions records the bound site tab instead', async () => {
  const h = await open();
  const res = plain(await h.api.srecStart({ recordId: 'r-1', tab: { id: 3, url: 'chrome://extensions' } }));
  assert.deepEqual(res, { ok: true, tabId: 7 });
  assert.deepEqual(h.named('resolveSiteTab'), [[{ verb: 'recorded', activate: true }]]);
  assert.deepEqual(h.named('tabCapture.getMediaStreamId'), [[{ targetTabId: 7 }]]);
});

test('5: no activeTab grant on the tab sends the recording down the debugger route', async () => {
  const h = await open();
  h.hooks.getMediaStreamId = async () => { throw new Error('Extension has not been invoked'); };
  const res = plain(await h.api.srecStart({ recordId: 'r-1' }));
  assert.deepEqual(res, { ok: true, tabId: 7 });
  assert.deepEqual(h.named('debugger.attach'), [[{ tabId: 7 }, '1.3']]);
  assert.equal(h.live().mode, 'cast');
});

// ---- the cast ladder and its teardown --------------------------------------

test('6: a page Chrome keeps extensions off is refused in our words, with no attach attempted', async () => {
  const h = await open();
  assert.deepEqual(plain(await h.api.srecStartCast({ id: 3, url: 'chrome://extensions' }, 'r-1')), {
    ok: false, reason: 'restricted:recorded',
  });
  assert.deepEqual(h.named('debugger.attach'), []);
});

test('7: a dead extension frame blocks the attach, so the frames go out and the retry records', async () => {
  const h = await open();
  h.hooks.dbgAttach = (_t, nth) => (nth === 1 ? FOREIGN_FRAME_MSG : null);
  const res = plain(await h.api.srecStartCast({ ...SITE_TAB }, 'r-1'));
  assert.deepEqual(res, { ok: true, tabId: 7 });
  assert.deepEqual(h.named('foreignFramesOut'), [[7]]);
  assert.equal(h.named('debugger.attach').length, 2);
  assert.equal(h.live().framesOut, true);
  assert.deepEqual(h.named('foreignFramesBack'), []); // they go back when the recording ends
});

test('8: when the retry fails too the frames are put back and the refusal names the frame', async () => {
  const h = await open();
  h.hooks.dbgAttach = () => FOREIGN_FRAME_MSG;
  assert.deepEqual(plain(await h.api.srecStartCast({ ...SITE_TAB }, 'r-1')), {
    ok: false, reason: 'cast-attach-frame', error: FOREIGN_FRAME_MSG,
  });
  assert.deepEqual(h.named('foreignFramesBack'), [[7]]);
  assert.equal(h.live(), undefined);
});

test('9: DevTools already on the tab is refused without moving anyone’s frames', async () => {
  const h = await open();
  h.hooks.dbgAttach = () => 'Another debugger is already attached to the tab with id: 7';
  assert.deepEqual(plain(await h.api.srecStartCast({ ...SITE_TAB }, 'r-1')), {
    ok: false, reason: 'cast-attach', error: 'Another debugger is already attached to the tab with id: 7',
  });
  assert.deepEqual(h.named('foreignFramesOut'), []);
  assert.deepEqual(h.named('foreignFramesBack'), []);
});

test('10: a recorder page that will not open leaves the tab as it was found, debugger off', async () => {
  const h = await open();
  h.hooks.dbgAttach = (_t, nth) => (nth === 1 ? FOREIGN_FRAME_MSG : null);
  h.hooks.getContexts = () => [];
  h.hooks.createDocument = async () => { throw new Error('Only a single offscreen document may be created'); };
  assert.deepEqual(plain(await h.api.srecStartCast({ ...SITE_TAB }, 'r-1')), {
    ok: false,
    reason: 'Could not open the recorder page: Only a single offscreen document may be created',
  });
  assert.deepEqual(h.named('debugger.detach'), [[{ tabId: 7 }]]);
  assert.deepEqual(h.named('foreignFramesBack'), [[7]]);
  assert.equal(h.live(), undefined);
});

test('11: an offscreen document already up is reused rather than created again', async () => {
  const h = await open();
  h.hooks.getContexts = () => [{ documentId: 'doc-1' }];
  await h.api.srecEnsureDoc();
  assert.deepEqual(h.named('runtime.getContexts'), [[{ contextTypes: ['OFFSCREEN_DOCUMENT'] }]]);
  assert.deepEqual(h.named('offscreen.createDocument'), []);
});

test('12: two openings racing in one tick create one document, and a refusal frees the next try', async () => {
  const h = await open();
  h.hooks.getContexts = () => [];
  let release;
  h.hooks.createDocument = () => new Promise((_r, reject) => { release = reject; });
  const a = h.api.srecEnsureDoc();
  const b = h.api.srecEnsureDoc();
  await h.settle();
  assert.equal(h.named('offscreen.createDocument').length, 1);
  release(new Error('no slot'));
  await assert.rejects(a);
  await assert.rejects(b);
  // Cleared in the finally either way, so the tester's next press is not stuck on the dead promise.
  h.hooks.createDocument = async () => {};
  await h.api.srecEnsureDoc();
  assert.equal(h.named('offscreen.createDocument').length, 2);
});

test('13: the recorder page is kept open while a take is parked — its blob would die with it', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  await h.api.srecCloseDoc();
  assert.deepEqual(h.named('offscreen.closeDocument'), []);
});

test('14: with the frame port up every frame goes down it, never to every extension page', async () => {
  const h = await open({ session: CASTING() });
  const port = h.connect('screenrec-frames');
  h.clearCalls();
  h.emit('debugger.onEvent', { tabId: 7 }, 'Page.screencastFrame', { data: 'JPEG', sessionId: 's1' });
  await h.settle();
  assert.deepEqual(port.posted, [{ cmd: 'frame', data: 'JPEG' }]);
  assert.deepEqual(h.named('runtime.sendMessage'), []);
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.screencastFrameAck', { sessionId: 's1' }]]);
});

test('15: the bootstrap frame that lands before the port still reaches the recorder', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  h.emit('debugger.onEvent', { tabId: 7 }, 'Page.screencastFrame', { data: 'JPEG', sessionId: 's1' });
  await h.settle();
  assert.deepEqual(h.sent(), [{ type: 'SCREENREC_OFF', cmd: 'frame', data: 'JPEG' }]);
  assert.equal(h.named('debugger.sendCommand').length, 1);
});

test('16: a port that died under us is dropped and that frame goes out as a broadcast', async () => {
  const h = await open({ session: CASTING() });
  const port = h.connect('screenrec-frames', { dead: true });
  h.clearCalls();
  h.emit('debugger.onEvent', { tabId: 7 }, 'Page.screencastFrame', { data: 'A', sessionId: 's1' });
  h.emit('debugger.onEvent', { tabId: 7 }, 'Page.screencastFrame', { data: 'B', sessionId: 's2' });
  await h.settle();
  assert.deepEqual(port.posted, [{ cmd: 'frame', data: 'A' }]); // nulled, so B never tries it
  assert.deepEqual(h.sent(), [
    { type: 'SCREENREC_OFF', cmd: 'frame', data: 'A' },
    { type: 'SCREENREC_OFF', cmd: 'frame', data: 'B' },
  ]);
});

test('17: a frame from a tab we are not recording is dropped without an ack', async () => {
  const h = await open({ session: CASTING() });
  const port = h.connect('screenrec-frames');
  h.clearCalls();
  h.emit('debugger.onEvent', { tabId: 8 }, 'Page.screencastFrame', { data: 'JPEG', sessionId: 's1' });
  await h.settle();
  assert.deepEqual(port.posted, []);
  assert.deepEqual(h.named('runtime.sendMessage'), []);
  assert.deepEqual(h.named('debugger.sendCommand'), []);
});

test('18: Cancel on Chrome’s debugging bar is a Stop that keeps the file', async () => {
  const h = await open({ session: CASTING({ framesOut: true }) });
  h.hooks.off.stop = { file: { url: 'blob:take', size: 2048, ms: 9000 } };
  h.clearCalls();
  h.emit('debugger.onDetach', { tabId: 7 }, 'canceled_by_user');
  await h.settle(6);
  assert.equal(h.api.srecCastOwns(7), false);
  assert.deepEqual(h.named('foreignFramesBack'), [[7]]);
  assert.ok(h.sent().some((m) => m.type === 'SCREENREC_OFF' && m.cmd === 'stop' && m.reason === 'user'));
  assert.equal(h.parked().url, 'blob:take');
  assert.equal(h.live(), undefined);
  // The mirror was nulled first, so the finish's own teardown found nothing left to detach.
  assert.deepEqual(h.named('debugger.detach'), []);
});

test('19: a detach on somebody else’s tab leaves our recording alone', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  h.emit('debugger.onDetach', { tabId: 8 }, 'target_closed');
  await h.settle(6);
  assert.deepEqual(h.named('runtime.sendMessage'), []);
  assert.equal(h.live().recording, true);
});

test('20: the teardown is a no-op off the cast route and after the mirror is gone', async () => {
  const tab = await open({ session: CASTING() });
  await tab.api.srecTeardownCast({ recording: true, mode: 'tab', tabId: 7 });
  assert.deepEqual(tab.named('debugger.detach'), []);
  assert.deepEqual(tab.named('debugger.sendCommand'), []);

  const cold = await open(); // nothing in storage, so the mirror never seeded
  await cold.api.srecTeardownCast({ recording: true, mode: 'cast', tabId: 7, framesOut: true });
  assert.deepEqual(cold.named('debugger.detach'), []);
  assert.deepEqual(cold.named('foreignFramesBack'), []);
});

test('21: ending a cast stops the screencast, detaches, and only then puts frames back', async () => {
  const h = await open({ session: CASTING({ framesOut: true }) });
  const owned = [];
  h.hooks.dbgSend = (cmd) => { owned.push([cmd, h.api.srecCastOwns(7)]); return {}; };
  h.clearCalls();
  await h.api.srecTeardownCast({ recording: true, mode: 'cast', tabId: 7, framesOut: true });
  assert.deepEqual(h.order(), ['debugger.sendCommand', 'debugger.detach', 'foreignFramesBack']);
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.stopScreencast', {}]]);
  assert.deepEqual(owned, [['Page.stopScreencast', false]]); // nulled before the awaits

  const kept = await open({ session: CASTING({ framesOut: false }) });
  await kept.api.srecTeardownCast({ recording: true, mode: 'cast', tabId: 7, framesOut: false });
  assert.deepEqual(kept.named('debugger.detach'), [[{ tabId: 7 }]]);
  assert.deepEqual(kept.named('foreignFramesBack'), []);
});

test('22: a recording the size cap ended still lets go of the tab, bar and all', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  const answer = await h.message({ type: 'SCREENREC_FILE', file: { url: 'blob:cap', size: 999, ms: 300000, reason: 'cap' } });
  assert.equal(answer, undefined); // fire-and-forget: the listener answers false
  await h.settle(6);
  assert.deepEqual(h.named('debugger.detach'), [[{ tabId: 7 }]]);
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.stopScreencast', {}]]);
  assert.equal(h.parked().url, 'blob:cap');
  assert.equal(h.live(), undefined);
});

// ---- finish: park, refuse, revoke, review ----------------------------------

test('23: a recording that captured nothing closes the recorder page and says so', async () => {
  const h = await open();
  await h.api.srecFinish(null, { recording: true, mode: 'tab', tabId: 7 }, 'user');
  assert.deepEqual(h.named('offscreen.closeDocument'), [[]]);
  assert.deepEqual(h.events(), [{ type: 'SCREENREC_EVENT', event: 'ended', reason: 'user', empty: true }]);
  assert.equal(h.parked(), undefined);
});

test('24: a second take never records over the one still waiting — the newcomer is revoked', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  h.clearCalls();
  await h.api.srecFinish({ url: 'blob:newer', size: 700, ms: 3000 }, { recording: true, mode: 'tab', tabId: 7, recordId: 'r-2' }, 'user');
  assert.ok(h.sent().some((m) => m.type === 'SCREENREC_OFF' && m.cmd === 'revoke' && m.url === 'blob:newer'));
  assert.deepEqual(h.parked(), TAKE());
  assert.deepEqual(h.events(), [{ type: 'SCREENREC_EVENT', event: 'ended', reason: 'user' }]);
  assert.deepEqual(h.named('scripting.executeScript'), []);
});

test('25: a finished take is parked whole and the review opens over the tab it was shot on', async () => {
  const h = await open();
  await h.api.srecFinish({ url: 'blob:take', size: 4096, ms: 8000, reason: 'user' },
    { recording: true, mode: 'tab', tabId: 7, recordId: 'r-1' }, 'user');
  assert.deepEqual(h.parked(), {
    url: 'blob:take', size: 4096, ms: 8000, reason: 'user', name: NAME_AT_NOW, recordId: 'r-1', reviewed: false,
  });
  assert.deepEqual(h.events(), [{ type: 'SCREENREC_EVENT', event: 'review', file: h.parked() }]);
  assert.deepEqual(h.named('tabs.update'), [[7, { active: true }]]);
  assert.deepEqual(h.named('scripting.executeScript'), [[{ target: { tabId: 7 }, files: ['content/review-overlay.js'] }]]);
});

test('26: a take pushed after the worker restarted is parked with no test bound to it', async () => {
  const h = await open();
  await h.api.srecFinish({ url: 'blob:orphan', size: 512, ms: 2000 }, null, 'cap');
  assert.deepEqual(h.parked(), {
    url: 'blob:orphan', size: 512, ms: 2000, reason: 'cap', name: NAME_AT_NOW, recordId: null, reviewed: false,
  });
  assert.deepEqual(h.named('resolveSiteTab'), [[{ verb: 'reviewed', activate: true }]]);
});

// The two pushes are not serialized: the second read can see the first's parked record and revoke
// the URL that is now the parked one, so the review loads a dead blob. The guard belongs in
// extension/offscreen/recorder.js — the worker has none to assert on yet.
test.todo('27 (#206): the same take pushed twice revokes the URL that is now parked');

test('53: the parked take is named for the local minute it finished in', async () => {
  const h = await open();
  assert.equal(h.api.srecName(), NAME_AT_NOW);
});

// ---- status, pause, the bar, the review window -----------------------------

test('28: with nothing recording the status is idle and carries whatever take is waiting', async () => {
  const idle = await open();
  assert.deepEqual(plain(await idle.api.srecStatus()), { recording: false, capMs: 300000, file: null });

  const waiting = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(plain(await waiting.api.srecStatus()), { recording: false, capMs: 300000, file: TAKE() });
});

test('29: a recorder page that crashed is reported idle, and its debugging bar comes down', async () => {
  const h = await open({ session: CASTING() });
  h.hooks.off.state = null;
  h.clearCalls();
  assert.deepEqual(plain(await h.api.srecStatus()), { recording: false, capMs: 300000, file: null });
  assert.deepEqual(h.named('debugger.detach'), [[{ tabId: 7 }]]);
  assert.equal(h.live(), undefined);
});

test('30: while recording the clock and the byte count come from the recorder page', async () => {
  const h = await open({ session: CASTING() });
  h.hooks.off.state = { recording: true, paused: true, ms: 4200, bytes: 90000 };
  assert.deepEqual(plain(await h.api.srecStatus()), {
    recording: true, paused: true, ms: 4200, bytes: 90000, tabId: 7, recordId: 'r-1', capMs: 300000,
  });
});

test('31: pausing a cast idles the screencast too, and resuming asks for the frames again', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  assert.deepEqual(plain(await h.api.srecPause(true)), { ok: true, paused: true });
  assert.ok(h.sent().some((m) => m.type === 'SCREENREC_OFF' && m.cmd === 'pause' && m.on === true));
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.stopScreencast', {}]]);
  assert.equal(h.live().paused, true);

  h.clearCalls();
  assert.deepEqual(plain(await h.api.srecPause(false)), { ok: true, paused: false });
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.startScreencast', plain(h.api.CAST_PARAMS)]]);
  assert.equal(h.live().paused, false);
});

test('32: pausing a tabCapture recording touches no debugger at all', async () => {
  const h = await open({ session: { screenRec: { recording: true, paused: false, tabId: 7, recordId: 'r-1', mode: 'tab' } } });
  h.clearCalls();
  assert.deepEqual(plain(await h.api.srecPause(true)), { ok: true, paused: true });
  assert.deepEqual(h.named('debugger.sendCommand'), []);
});

test('33: a navigation on the recorded tab gets the bar back and the screencast restarted', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  await Promise.all(h.emit('tabs.onUpdated', 7, { status: 'complete' }, { ...SITE_TAB }));
  assert.deepEqual(h.named('scripting.executeScript'), [[{ target: { tabId: 7 }, files: ['content/rec-bar.js'] }]]);
  assert.deepEqual(h.named('debugger.sendCommand'), [[{ tabId: 7 }, 'Page.startScreencast', plain(h.api.CAST_PARAMS)]]);
});

test('34: a navigation on any other tab draws no bar there', async () => {
  const h = await open({ session: CASTING() });
  h.clearCalls();
  await Promise.all(h.emit('tabs.onUpdated', 8, { status: 'complete' }, { id: 8, url: 'https://news.example.com/' }));
  assert.deepEqual(h.named('scripting.executeScript'), []);
  assert.deepEqual(h.named('debugger.sendCommand'), []);
});

test('35: closing the recorded tab stops the recording and says why', async () => {
  const h = await open({ session: CASTING() });
  h.hooks.off.stop = { file: { url: 'blob:gone', size: 100, ms: 1000 } };
  h.clearCalls();
  await Promise.all(h.emit('tabs.onRemoved', 7, { isWindowClosing: false }));
  await h.settle(6);
  assert.ok(h.sent().some((m) => m.type === 'SCREENREC_OFF' && m.cmd === 'stop' && m.reason === 'tab-gone'));
  assert.equal(h.live(), undefined);
});

test('36: a page that will not take the bar records on without its controls', async () => {
  const h = await open();
  h.hooks.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  assert.equal(await h.api.srecInjectBar(7), false);
});

test('37: the review is brought to the front of the recorded tab before it is injected', async () => {
  const h = await open();
  h.clearCalls(); // the mirror re-seed's own storage read is not part of this order
  assert.deepEqual(plain(await h.api.srecOpenReview(7)), { ok: true });
  assert.deepEqual(h.order(), ['tabs.update', 'scripting.executeScript']);
  assert.deepEqual(h.named('tabs.update'), [[7, { active: true }]]);
});

// srecOpenReview activates the recorded tab, and the fallback's resolveSiteTab({activate:true})
// activates the site tab as well — two tabs come to the front for one review.
test.todo('38 (#316): a review that falls back to the site tab brings two tabs forward');

test('39: with both tabs refusing the review, it opens in a tab of its own', async () => {
  const h = await open();
  h.hooks.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  h.hooks.resolveSiteTab = () => ({ state: 'ok', tab: { id: 9, url: 'https://shop.example.com/' } });
  assert.deepEqual(plain(await h.api.srecOpenReview(7)), { ok: true });
  assert.deepEqual(h.named('tabs.create'), [[{
    url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/screenrec/review.html',
  }]]);
});

test('54: right after a worker restart the awaited owner check waits for the mirror to re-seed', async () => {
  const h = load({ session: CASTING() });
  assert.equal(h.api.srecCastOwns(7), false);  // the mirror is still null this very tick
  assert.equal(await h.api.srecCastOwnsReady(7), true);
  assert.equal(await h.api.srecCastOwnsReady(8), false);
  assert.equal(h.api.srecCastOwns(7), true);   // and the cheap mirror is honest from here on
});

// background.js guards the call with `typeof <name> === 'function'`, so a rename here would not
// break the build — it would silently turn the shared attach off and leave the suite green.
test('54b: the owner check background.js guards on is still a reachable global of this module', async () => {
  const h = await open({ session: CASTING() });
  const guarded = [...BG_SOURCE.matchAll(/typeof\s+(srec\w+)\s*===\s*'function'/g)].map((m) => m[1]);
  assert.ok(guarded.includes('srecCastOwnsReady'), 'background.js should still guard srecCastOwnsReady');
  for (const name of guarded) {
    assert.equal(h.evalHere(`typeof ${name}`), 'function', `${name} is no longer reachable from a sibling script`);
  }
  assert.equal(await h.evalHere('srecCastOwnsReady(7)'), true);
});

test('55: clearing the bound test writes null, and the next read gives null back', async () => {
  const h = await open({ session: { screenRecTarget: 'r-1' } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_TARGET', recordId: null }), { ok: true });
  assert.deepEqual(h.named('storage.session.set').at(-1), [{ screenRecTarget: null }]);
  assert.equal(await h.api.srecTarget(), null);
});

// ---- the claim, and the parked record's transitions ------------------------

test('40: the first panel to ask owns the upload of the parked take', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: true });
  assert.deepEqual(h.parked().claim, { by: 'A', at: NOW });
});

test('41: the second panel open on the same take is refused, so it is uploaded once', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: true });
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'B' }), { ok: false });
  assert.deepEqual(h.parked().claim, { by: 'A', at: NOW });
});

test('42: a panel closed mid-upload cannot strand the take — the claim expires after two minutes', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: true });
  h.advance(2 * 60 * 1000 + 1);
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'B' }), { ok: true });
  assert.deepEqual(h.parked().claim, { by: 'B', at: NOW + 2 * 60 * 1000 + 1 });
});

test('43: the panel that already holds the take may take it again', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: true });
  h.advance(1000);
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: true });
  assert.deepEqual(h.parked().claim, { by: 'A', at: NOW + 1000 });
});

test('44: two panels asking in the same tick still leave exactly one owner', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  const both = await Promise.all([
    h.message({ type: 'SCREENREC_CLAIM', by: 'A' }),
    h.message({ type: 'SCREENREC_CLAIM', by: 'B' }),
  ]);
  assert.equal(both.filter((r) => r.ok).length, 1);
  assert.equal(h.parked().claim.by, 'A');
});

test('45: with no take parked there is nothing to claim', async () => {
  const h = await open();
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'A' }), { ok: false });
  assert.equal(h.parked(), undefined);
});

test('46: a failed upload gives the take back, claim and all, for any panel to retry', async () => {
  const h = await open({ session: { screenRecFile: TAKE({ claim: { by: 'A', at: NOW } }) } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_UNCLAIM', by: 'A' }), { ok: true });
  assert.equal('claim' in h.parked(), false); // deleted, not nulled: a null would read as held
  assert.deepEqual(await h.message({ type: 'SCREENREC_CLAIM', by: 'B' }), { ok: true });
});

test('47: a panel cannot release a take another one is holding', async () => {
  const h = await open({ session: { screenRecFile: TAKE({ claim: { by: 'A', at: NOW } }) } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_UNCLAIM', by: 'B' }), { ok: true });
  assert.deepEqual(h.parked().claim, { by: 'A', at: NOW });
});

test('48: approving the take as recorded is what finally offers it to the panel', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_REVIEWED' }), { ok: true });
  assert.deepEqual(h.parked(), TAKE({ reviewed: true }));
  assert.deepEqual(h.events(), [{ type: 'SCREENREC_EVENT', event: 'file', file: TAKE({ reviewed: true }) }]);
});

test('49: a trimmed take keeps its name and test, and carries no stale claim', async () => {
  const h = await open({ session: { screenRecFile: TAKE({ claim: { by: 'A', at: NOW } }) } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_TRIMMED', url: 'blob:cut', size: 900, ms: 3200 }), { ok: true });
  assert.deepEqual(h.parked(), {
    url: 'blob:cut', size: 900, ms: 3200, reason: 'user', name: NAME_AT_NOW, recordId: 'r-1', reviewed: true,
  });
});

test('50: a trim that arrives without its new blob changes nothing', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_TRIMMED', size: 900, ms: 3200 }), { ok: false });
  assert.deepEqual(h.parked(), TAKE());
  assert.deepEqual(h.events(), []);
});

test('51: discarding the take clears the panel’s "Recording this tab…" plaque too', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_DONE', attached: false }), { ok: true });
  assert.equal(h.parked(), undefined);
  assert.deepEqual(h.named('offscreen.closeDocument'), [[]]);
  assert.deepEqual(h.events(), [{ type: 'SCREENREC_EVENT', event: 'ended', reason: 'discarded' }]);
});

test('52: attaching the take speaks for itself, so nothing is broadcast', async () => {
  const h = await open({ session: { screenRecFile: TAKE() } });
  assert.deepEqual(await h.message({ type: 'SCREENREC_DONE', attached: true }), { ok: true });
  assert.equal(h.parked(), undefined);
  assert.deepEqual(h.named('offscreen.closeDocument'), [[]]);
  assert.deepEqual(h.events(), []);
});
