import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { makeDocument, el, text, fire, event, NodeFilter } from './mini-dom.mjs';

export { el, text };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
// REC_SRC points the suite at a mutated copy, so a mutation run never edits the shipped file.
export const RECORDER = process.env.REC_SRC || join(repoRoot, 'extension/content/step-recorder.js');

export const HOST_ID = '__testomat_step_recorder';

// The same list background.js injects, minus shared/icons.js, which the `icons` option stubs.
const MODULE_FILES = ['content/rec-naming.js', 'content/rec-mask.js', 'content/rec-packet.js',
  'content/rec-outbox.js', 'content/rec-pill.js'];
// REC_MODULES swaps one or all of them for mutated copies, as REC_SRC does for the recorder.
export const MODULES = process.env.REC_MODULES
  ? process.env.REC_MODULES.split(',').map((f) => f.trim()).filter(Boolean)
  : MODULE_FILES.map((f) => join(repoRoot, 'extension', f));

// One read per file, however many sandboxes are built out of it.
const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// One macrotask turn drains the deferred `flagRead.then(() => flushType(el))`; two is margin.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// The worker's own reply shape (srEcho); any other stub reply is a message the extension never sends.
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
      // `.finally` runs on the returned promise, and a throwing reply must arrive as a rejection.
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

  // In a page `window` is the global, so an injected `window.RecMask = …` becomes bare `RecMask`.
  const context = createContext(sandbox);
  Object.assign(sandbox, win);
  sandbox.window = sandbox;
  sandbox.top = top ? sandbox : {};
  for (const m of modules) runInContext(sourceOf(m), context);
  runInContext(sourceOf(sourcePath), context);

  const host = () => doc.getElementById(HOST_ID);
  const shadow = () => host()?.shadowRoot || null;
  const box = () => shadow()?.querySelector('.box') || null;
  const flush = () => { for (const t of timers.splice(0)) t.fn(); };

  return {
    doc,
    win: sandbox, // the page's window IS its global, and the recorder writes its latch there
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
    // Typing re-enters through the flag read, so a blur flushed synchronously records nothing at all.
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

    // JSON copies: a vm-realm entry fails deepEqual against a plain object on the prototype alone.
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
