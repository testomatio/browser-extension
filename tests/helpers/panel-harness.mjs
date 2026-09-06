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
// run never has to edit the shipped files and risk leaving them edited. CORE_SRC is the same knob
// for extension/sidepanel/core, spelled the way tests/helpers/core-harness.mjs already spells it.
export const SCREENS_SRC = process.env.SCREENS_SRC || join(repoRoot, 'extension/sidepanel/screens');
export const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');

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

  // The panel's one WRITE to session storage is a removal, and it is ordered: the open-run intent is
  // burnt before it is acted on, so a row has to watch the key actually leave `sess`, not just count.
  const sessionRemove = async (arg) => {
    record('session', 'remove', arg);
    for (const k of [].concat(arg)) delete sess[k];
    return undefined;
  };

  const sessionArea = { get: sessionGet, remove: sessionRemove };
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

// ---------- the clock ----------

// A REAL interval keeps the node test process alive for its whole period; these fire only when a
// test calls tick(). Same shape core-harness.mjs proves: callbacks held, clear() really unregisters.
export function fakeClock() {
  let nextId = 1;
  const live = new Map();  // id -> { fn, ms, repeat }
  const armed = [];        // every arming in order: { id, ms, repeat }
  const cleared = [];      // every id handed to clearInterval / clearTimeout, whether armed or not

  const arm = (fn, ms, repeat) => {
    const id = nextId;
    nextId += 1;
    const t = { id, fn, ms: Number(ms) || 0, repeat };
    live.set(id, t);
    armed.push({ id: t.id, ms: t.ms, repeat });
    return id;
  };
  const disarm = (id) => { cleared.push(id); live.delete(id); };

  return {
    live,
    armed,
    cleared,
    // Spliced into the sandbox by loadScreen — the four names a screen reaches for.
    timers: {
      setInterval: (fn, ms) => arm(fn, ms, true),
      clearInterval: disarm,
      setTimeout: (fn, ms) => arm(fn, ms, false),
      clearTimeout: disarm,
    },
    // How many timers are armed right now: a screen that re-arms without clearing shows up as 2.
    count: () => live.size,
    // The period the live timer carries — the rate-limit rows need the number, not "a timer exists".
    ms: () => (live.size ? [...live.values()][0].ms : null),
    // Every period ever armed, so a re-arm is visible even when it lands on the same number.
    arms: () => armed.map((a) => a.ms),
    // Fire each live timer once, oldest first; a one-shot unregisters the way a real one does.
    tick: async () => {
      for (const t of [...live.values()]) {
        if (!t.repeat) live.delete(t.id);
        await t.fn();
      }
    },
  };
}

// ---------- the loader ----------

// `exported` names the screen's published `const` — the trailing completion expression. `globals` is
// the screen's own panel globals, which this file deliberately knows nothing about. `dir` is the
// directory to read from: core/views.js is a plain script of the same shape, one folder over.
// `before` names the sibling scripts index.html loads AHEAD of this one, evaluated into the same
// context: a published `const` is a global lexical, shared between the scripts and never a property.
export function loadScreen(name, opts = {}) {
  const {
    dir = SCREENS_SRC,
    before = [],
    exported = null,
    globals = {},
    ids = [],
    now,
    clock = null,          // a fakeClock() whose timers replace the realm's
    visibility = 'visible', // mini-dom has no visibilityState; the poll gate reads one
    store = fakeChrome(opts),
    document: doc = makeDocument(ids),
    window: win = fakeWindow(),
  } = opts;

  // Without it a poll gate silently takes its "no such property" branch and passes for the
  // wrong reason — the same trap this file already documents for `URL`.
  if (doc.visibilityState === undefined) doc.visibilityState = visibility;

  const sandbox = {
    console, URL, document: doc, window: win, chrome: store.chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ...(clock ? clock.timers : {}),
    ...globals,
    // Whatever else a test puts on TestomatAPI, ApiError stays the real constructor.
    TestomatAPI: { ...(globals.TestomatAPI || {}), ApiError },
  };
  // A clock the caller can hold still, with the realm's own Date otherwise untouched.
  if (now !== undefined) {
    const at = typeof now === 'function' ? now : () => now;
    sandbox.Date = new Proxy(Date, { get: (t, k) => (k === 'now' ? at : Reflect.get(t, k)) });
  }

  const file = join(dir, `${name}.js`);
  const source = sourceOf(file);
  const context = createContext(sandbox);
  for (const dep of before) {
    // A name in `dir`, or [name, otherDir] for a script index.html loads from another folder —
    // core/status-icons.js stands ahead of every screen, and CORE_SRC has to stay switchable.
    const [depName, depDir = dir] = [].concat(dep);
    const path = join(depDir, `${depName}.js`);
    runInContext(sourceOf(path), context, { filename: path });
  }
  const screen = runInContext(exported ? `${source}\n${exported};` : source, context, { filename: file });

  return {
    screen, fn: sandbox, sandbox, doc, window: win, store, ApiError, plain, settle, rejection, clock,
    // Changing the value and firing the event are the one act a browser performs.
    visibility: (value) => { doc.visibilityState = value; doc.dispatchEvent(event(doc, 'visibilitychange')); },
  };
}
