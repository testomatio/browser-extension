// The shared load() for the step-recorder test files. extension/content/step-recorder.js publishes
// NOTHING by name — it is one IIFE whose whole surface is the listeners it registers — so a test
// drives it exactly as a page does: build a node, fire an event at the document, read what reached
// chrome.runtime.sendMessage. The page under it is tests/helpers/mini-dom.mjs, the same fake every
// other test file is built on: one DOM, one event shape, one set of rules.
//
// THE TRAP THIS FILE EXISTS TO CLOSE: flushType() and flushSelect() return early while the
// never-values flag is unread and re-enter through `flagRead.then(...)`. A blur fired and flushed
// synchronously therefore records NOTHING, and a test that asserts an empty outbox there is green
// and hollow. Use `await h.act(node, 'blur')` — it fires, turns the microtask queue, closes the
// 400ms packet window and turns it again — or the primitives in that order by hand.
//
//   const h = load({ top: false, hostname: 'checkout.example.com' });
//   const btn = el('button', null, 'Pay now');
//   h.doc.body.append(btn);
//   await h.act(btn, 'click');
//   h.entries()[0].text; // 'Click the "Pay now" button in the "checkout.example.com" frame'
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { makeDocument, el, text, fire, event, NodeFilter } from './mini-dom.mjs';

export { el, text };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
// REC_SRC drives the whole suite against a mutated copy, so a falsification run never has to
// edit the shipped file and risk leaving it edited.
export const RECORDER = process.env.REC_SRC || join(repoRoot, 'extension/content/step-recorder.js');

export const HOST_ID = '__testomat_step_recorder';

// The same list background.js injects, minus shared/icons.js, which the `icons` option stubs.
// An older checkout of the recorder carries these blocks inline and simply ignores the globals.
const MODULE_FILES = ['content/rec-naming.js', 'content/rec-mask.js', 'content/rec-packet.js',
  'content/rec-outbox.js', 'content/rec-pill.js'];
// REC_MODULES swaps one or all of them for mutated copies, the same seam REC_SRC gives the
// recorder: a falsification run never edits a shipped file.
export const MODULES = process.env.REC_MODULES
  ? process.env.REC_MODULES.split(',').map((f) => f.trim()).filter(Boolean)
  : MODULE_FILES.map((f) => join(repoRoot, 'extension', f));

// One read per file, however many sandboxes are built out of it.
const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// One turn of the macrotask queue drains every microtask waiting behind it, which is what the
// deferred `flagRead.then(() => flushType(el))` needs; two turns is the cheap margin.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// The worker's own reply shape (background.js srEcho) — a stub that answers anything else teaches
// the recorder to handle a message the extension never sends.
const echo = (msg, n) => ({ count: n, paused: false, manualPause: false, recording: true });

export function load(opts = {}) {
  const {
    top = true,
    hostname = 'example.com',
    href = hostname ? `https://${hostname}/pay` : 'about:blank',
    title = 'Checkout',
    ids = [],
    storage = {},
    noStorage = false,
    storageFails = false,
    noSendMessage = false,
    noObserver = false,
    icons = false,
    innerWidth = 1280,
    innerHeight = 800,
    now = 1000,
    reply = echo,
    sourcePath = RECORDER,
    modules = MODULES,
  } = opts;

  const doc = makeDocument(ids);
  doc.title = title;

  const sent = [];         // every chrome.runtime.sendMessage payload, in order
  const timers = [];       // pending setTimeout callbacks: the 400ms packet windows
  const winListeners = []; // {type, fn, options}, minus whatever teardown removed
  const observers = new Set();
  const writes = [];       // every chrome.storage.local.set payload
  const iconCalls = [];
  const seed = { ...storage };
  let clock = now;
  let pollFn = null;
  let pollDelay = 0;
  let pollCleared = false;
  let flagListener = null;
  let msgListener = null;

  const win = {
    innerWidth,
    innerHeight,
    addEventListener: (type, fn, options) => { winListeners.push({ type, fn, options }); },
    removeEventListener: (type, fn) => {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
  };
  win.top = top ? win : {}; // the one fact that tells a frame from the page
  if (icons) {
    win.Icons = { elIn: (d, name, size) => { iconCalls.push({ name, size }); return d.createElement('svg'); } };
  }

  const runtime = {
    onMessage: {
      addListener: (fn) => { msgListener = fn; },
      removeListener: (fn) => { if (msgListener === fn) msgListener = null; },
    },
  };
  // Absent on purpose for the guard at the top of the file: no sendMessage, no recorder at all.
  if (!noSendMessage) {
    runtime.sendMessage = (msg) => {
      sent.push(msg);
      // A `.finally` runs on the returned promise, so a thenable is not enough — and a reply that
      // throws has to reach the recorder as a rejection, the shape a sleeping worker produces.
      try { return Promise.resolve(reply(msg, sent.length)); } catch (e) { return Promise.reject(e); }
    };
  }

  const chromeStub = { runtime };
  if (!noStorage) {
    chromeStub.storage = {
      local: {
        get: (key) => (storageFails ? Promise.reject(new Error('storage unavailable'))
          : Promise.resolve(key in seed ? { [key]: seed[key] } : {})),
        set: (obj) => { writes.push(obj); Object.assign(seed, obj); return Promise.resolve(); },
      },
      onChanged: {
        addListener: (fn) => { flagListener = fn; },
        removeListener: (fn) => { if (flagListener === fn) flagListener = null; },
      },
    };
  }

  // Records are delivered by hand through h.mutate(): nothing in mini-dom observes itself.
  class Observer {
    constructor(cb) { this.cb = cb; observers.add(this); }

    observe() {}

    disconnect() { observers.delete(this); }
  }

  const sandbox = {
    window: win,
    document: doc,
    location: { hostname, href },
    chrome: chromeStub,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    setInterval: (fn, ms) => { pollFn = fn; pollDelay = ms; return 1; },
    clearInterval: () => { pollCleared = true; },
    NodeFilter,
    CSS: { escape: (s) => String(s) }, // identity: no id a fixture writes needs escaping
    performance: { now: () => clock },
    URL,
  };
  if (!noObserver) sandbox.MutationObserver = Observer;

  // A fresh sandbox per load: `window.__testomatStepRecInited` survives a reused one, and the
  // second evaluation would be a silent no-op that looks exactly like a passing test.
  for (const m of modules) runInNewContext(sourceOf(m), sandbox);
  runInNewContext(sourceOf(sourcePath), sandbox);

  const host = () => doc.getElementById(HOST_ID);
  const shadow = () => host()?.shadowRoot || null;
  const box = () => shadow()?.querySelector('.box') || null;
  const flush = () => { for (const t of timers.splice(0)) t.fn(); };

  return {
    doc,
    win,
    sandbox,
    location: sandbox.location,
    pollDelay,

    // The 7 capture listeners the recorder registered on `document`, with `node` as the target.
    fire: (node, type, props = {}) => fire(doc, type, { target: node, ...props }),
    // A listener registered on the node itself: the pill's box, its buttons, the shadow root.
    fireOn: (node, type, props = {}) => fire(node, type, props),
    fireWin: (type, props = {}) => {
      const ev = event(win, type, props);
      for (const l of [...winListeners]) if (l.type === type) l.fn(ev);
      return ev;
    },
    // Fire, let the deferred flag read land, close the packet window, let the send land.
    act: async (node, type, props = {}) => {
      fire(doc, type, { target: node, ...props });
      await settle();
      flush();
      await settle();
    },

    flush,
    settle,
    pending: () => timers.map((t) => t.ms),
    advance: (ms) => { clock += ms; return clock; },
    now: () => clock,
    mutate: (...nodes) => { for (const o of [...observers]) o.cb([{ addedNodes: nodes }]); },
    poll: () => { if (pollFn) pollFn(); },
    pollCleared: () => pollCleared,

    // JSON copies: an entry is built inside the vm realm, so a deepEqual against a plain object
    // written here fails on the prototype alone.
    entries: () => sent.filter((m) => m.type === 'STEPREC_ADD').map((m) => JSON.parse(JSON.stringify(m.entry))),
    titles: () => sent.filter((m) => m.type === 'STEPREC_TITLE').map((m) => m.title),
    sent: () => sent.slice(),

    host,
    shadow,
    box,
    iconCalls: () => iconCalls.slice(),

    winEvents: () => winListeners.map((l) => l.type),
    writes: () => writes.slice(),
    flagListener: () => flagListener,
    msgListener: () => msgListener,
    changeFlag: (changes, area = 'local') => { if (flagListener) flagListener(changes, area); },
    runtimeMessage: (msg, sendResponse = () => {}) => (msgListener ? msgListener(msg, {}, sendResponse) : undefined),
  };
}
