// The shared load() for the sidepanel's screen scripts — extension/sidepanel/screens/*.js — the way
// tests/helpers/core-harness.mjs is the core's and tests/helpers/api-harness.mjs is api.js's.

// LOADING. Every screen is a plain script: no IIFE, no exports. Its FUNCTION declarations land on the
// sandbox object, so `h.fn.drainPass` works. Its top-level `const`/`let` do NOT — those go to the
// context's global LEXICAL scope, invisible as a property — and the object a screen publishes
// (`OfflineQueue`, and one per screen after it) is exactly one of those. So the caller NAMES it and
// gets it back as the script's completion value, the same seam tests/md-sections.test.mjs:16 uses.

// THE BOUNDARY. This file carries only what every screen needs identically: a document, a window, a
// chrome fake, a real ApiError and `URL`. A screen's OWN panel globals — `state`, `capabilities`,
// `toast`, `$`, `writeStatus`, … — are passed in by the test as a plain `globals` object. The eight
// screens after offline-queue land in parallel, and a harness that owned their stubs would be a
// merge conflict in every one of those PRs.

// URL is NOT a vm-realm global: Node installs it on the main context only. Seven of the thirteen
// screens build one, and without it they silently take their catch branch — a URL row would then
// pass for the wrong reason.

// TRAPS. A screen's `online` handler is registered on `window`, so a sandbox without one skips that
// step in silence. `storage.session.onChanged` keeps its callback here, because firing it by hand is
// the only way to reach the live-flag branch; `sessionOnChanged: false` reproduces an older Chrome
// that has no such event at all.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { makeDocument, el, text, fire, event } from './mini-dom.mjs';

export { makeDocument, el, text, fire, event };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// SCREENS_SRC points the whole suite at a mutated COPY of the screens directory, so a falsification
// run never has to edit the shipped files and risk leaving them edited.
export const SCREENS_SRC = process.env.SCREENS_SRC || join(repoRoot, 'extension/sidepanel/screens');

const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One turn of the macrotask queue drains every microtask behind it; a listener that starts an async
// drain and drops the promise needs exactly this.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// A rejection as a value — `instanceof` does not cross the vm realm.
export const rejection = async (p) => {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, got a resolution');
};

// ---------- TestomatAPI.ApiError ----------

// The real class from extension/api/errors.js, not a look-alike shape: a screen that CONSTRUCTS one
// is asserted on `instanceof`, and only a Node-realm class keeps that working across the vm boundary.
export class ApiError extends Error {
  constructor(kind, status, detail) {
    super(detail || kind);
    this.kind = kind; // unconfigured | network | auth | readonly | notfound | http
    this.status = status;
  }
}

// ---------- chrome.storage ----------

// In memory, and every call recorded in order. `fails` makes one op reject, which is the only way to
// reach the swallowed-rejection branches: a persist that never lands, a boot off corrupt storage.
export function fakeChrome(opts = {}) {
  const { local = {}, session = {}, sessionOnChanged = true } = opts;
  const data = { ...local };
  const sess = { ...session };
  const calls = [];
  const fails = { get: null, set: null, remove: null, sessionGet: null };
  const sessionListeners = [];

  const pick = (bag, arg) => {
    const keys = Array.isArray(arg) ? arg : [arg];
    return Object.fromEntries(keys.filter((k) => k in bag).map((k) => [k, bag[k]]));
  };
  // `raw` as well as the JSON copy: a key whose value is `undefined` vanishes from JSON, and some
  // rows are asserted by their exact key set.
  const record = (area, op, arg) => { calls.push({ area, op, arg: plain(arg), raw: arg }); };

  const localOp = (op) => async (arg) => {
    record('local', op, arg);
    if (fails[op]) throw fails[op];
    if (op === 'get') return pick(data, arg);
    // A JSON copy, the way real storage serialises: a live reference would let a later in-memory
    // mutation rewrite what a test believes was already written.
    if (op === 'set') Object.assign(data, plain(arg));
    if (op === 'remove') for (const k of [].concat(arg)) delete data[k];
    return undefined;
  };
  const sessionGet = async (arg) => {
    record('session', 'get', arg);
    if (fails.sessionGet) throw fails.sessionGet;
    return pick(sess, arg);
  };

  const sessionArea = { get: sessionGet };
  if (sessionOnChanged) {
    sessionArea.onChanged = { addListener: (fn) => { sessionListeners.push(fn); } };
  }

  const store = {
    data,
    session: sess,
    calls,
    fails,
    sessionListeners,
    chrome: {
      storage: {
        local: { get: localOp('get'), set: localOp('set'), remove: localOp('remove') },
        session: sessionArea,
      },
    },
    ops: (area, op) => calls.filter((c) => c.area === area && c.op === op),
    // The value has already changed by the time a real onChanged fires, so mirror it here too.
    fireSessionChange: (changes) => {
      for (const [key, c] of Object.entries(changes)) {
        if (c && 'newValue' in c && c.newValue !== undefined) sess[key] = c.newValue;
        else delete sess[key];
      }
      for (const fn of [...sessionListeners]) fn(changes);
    },
    clear: () => { calls.length = 0; return store; },
  };
  return store;
}

// ---------- window ----------

// A screen's `online` / `offline` / `beforeunload` handler is asserted by RUNNING it, so the fake
// keeps the registration rather than merely counting it.
export function fakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener: (type, fn, options) => { listeners.push({ type, fn, options }); },
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    typesOf: () => listeners.map((l) => l.type),
    fire: (type, ev = { type }) => listeners.filter((l) => l.type === type).map((l) => l.fn(ev)),
  };
}

// ---------- the loader ----------

// `exported` names the screen's published `const` — the trailing completion expression. `globals` is
// the screen's own panel globals, which this file deliberately knows nothing about.
export function loadScreen(name, opts = {}) {
  const {
    exported = null,
    globals = {},
    ids = [],
    now,
    store = fakeChrome(opts),
    document: doc = makeDocument(ids),
    window: win = fakeWindow(),
  } = opts;

  const sandbox = {
    console, URL, document: doc, window: win, chrome: store.chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ...globals,
    // Whatever else a test puts on TestomatAPI, ApiError stays the real constructor.
    TestomatAPI: { ApiError, ...(globals.TestomatAPI || {}) },
  };
  // A clock the caller can hold still, with the realm's own Date otherwise untouched.
  if (now !== undefined) {
    const at = typeof now === 'function' ? now : () => now;
    sandbox.Date = new Proxy(Date, { get: (t, k) => (k === 'now' ? at : Reflect.get(t, k)) });
  }

  const file = join(SCREENS_SRC, `${name}.js`);
  const source = sourceOf(file);
  const context = createContext(sandbox);
  const screen = runInContext(exported ? `${source}\n${exported};` : source, context, { filename: file });

  return { screen, fn: sandbox, sandbox, doc, window: win, store, ApiError, plain, settle, rejection };
}
