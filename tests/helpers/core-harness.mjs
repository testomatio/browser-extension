// The shared load() for the sidepanel's three core scripts — state.js, storage.js, env-info.js —
// the way tests/helpers/api-harness.mjs is api.js's.

// LOADING. All three are plain scripts: no IIFE, no exports. Their FUNCTION declarations land on
// the sandbox object, so `sandbox.persistSession` works. Their top-level `const`/`let` do NOT —
// those go to the context's global LEXICAL scope, invisible as a property. `state`, `hasChrome`,
// `hostOf`, `capabilities` are all of that kind, so state.js is read through a completion value.

// THE LEXICAL SEAM IS ALSO THE LOAD ORDER. index.html runs state.js before storage.js, and a
// second script in the SAME vm context really does see the first one's `const state` — verified,
// not assumed. So loadStorage() evaluates state.js first and storage.js gets the real `state`,
// the real `hasChrome` and the real `hostOf`, not copies of them.

// THE PRIVATE-STATE SEAM. `projectInfo`, `usersMap`, `readonlyProbe`, `readonlyWatch` … are module
// `let`s no caller can see. One `peek()` closure is appended to the evaluated STRING (never to the
// shipped file) so a row can name them the way the ticket does.

// STUBS. `URL` is NOT a vm-realm global — Node adds it to the main context only, and without it
// `envTrimUrl` and `hostOf` silently take their catch branch and every URL row passes for the wrong
// reason. It is supplied here. state.js also reaches for `document` (through `$`), `TestomatAPI`,
// `setInterval`/`clearInterval`, and six cross-file globals behind `typeof` guards.

// TRAPS. `startReadonlyWatch` arms a 60 s interval, so the timers here are fakes and h.tick() is
// what advances them; a real one keeps the node test process alive. `persistSession` is
// fire-and-forget, so await settle() before reading the recorded write. `runInfoOpen` belongs to
// screens/run-view.js and must be a sandbox property — a sandbox without it throws by design.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { makeDocument } from './mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// CORE_SRC points the whole suite at a mutated COPY of the core directory, so a falsification run
// never has to edit the shipped files and risk leaving them edited.
export const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');

const DEFAULT_MODULES = {
  state: join(CORE_SRC, 'state.js'),
  storage: join(CORE_SRC, 'storage.js'),
  'env-info': join(CORE_SRC, 'env-info.js'),
};

// CORE_MODULES swaps ONE module for a mutated copy: `CORE_MODULES=state=/tmp/bad-state.js`.
// Bare paths are keyed by their basename, so `CORE_MODULES=/tmp/storage.js` works too.
const overrides = (process.env.CORE_MODULES || '')
  .split(',').map((p) => p.trim()).filter(Boolean)
  .map((p) => {
    const at = p.indexOf('=');
    return at < 0 ? [basename(p, '.js'), p] : [p.slice(0, at), p.slice(at + 1)];
  });
export const CORE_MODULES = { ...DEFAULT_MODULES, ...Object.fromEntries(overrides) };

const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One turn of the macrotask queue drains every microtask behind it.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// A rejection as a value — `instanceof` does not cross the vm realm.
export const rejection = async (p) => {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, got a resolution');
};

// ---------- chrome.storage.local ----------

// In memory, and every call recorded in order. `fails` makes one op reject, which is the only way
// to reach the swallowed-rejection branches.
export function fakeStorage(seed = {}) {
  const data = { ...seed };
  const calls = [];
  const fails = { get: null, set: null, remove: null };
  // `raw` as well as the JSON copy: a key whose value is `undefined` vanishes from JSON, and the
  // session write is asserted by its exact KEY SET.
  const run = (op) => async (arg) => {
    calls.push({ op, arg: plain(arg), raw: arg });
    if (fails[op]) throw fails[op];
    if (op === 'get') {
      const keys = Array.isArray(arg) ? arg : [arg];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    }
    if (op === 'set') Object.assign(data, plain(arg));
    if (op === 'remove') for (const k of [].concat(arg)) delete data[k];
    return undefined;
  };
  const store = {
    data,
    calls,
    fails,
    chrome: { storage: { local: { get: run('get'), set: run('set'), remove: run('remove') } } },
    ops: (op) => calls.filter((c) => c.op === op),
    clear: () => { calls.length = 0; return store; },
  };
  return store;
}

// ---------- env-info.js ----------

// Only the keys actually passed are put on the sandbox: rows 29 and 35 are about a global that is
// genuinely MISSING, which `undefined` would not reproduce.
export function loadEnvInfo(over = {}) {
  const sandbox = { URL, console };
  for (const key of ['navigator', 'chrome', 'resolveSiteTab']) {
    if (key in over) sandbox[key] = over[key];
  }
  const file = CORE_MODULES['env-info'];
  runInNewContext(sourceOf(file), sandbox, { filename: file });
  return sandbox;
}

export const nav = (userAgent, userAgentData) => ({ userAgent, userAgentData });

// `answer` is the executeScript result, or a function of the options it was called with; an Error
// value makes the call reject.
export function scripting(answer) {
  const calls = [];
  const executeScript = async (opts) => {
    calls.push(plain({ target: opts.target }));
    const out = typeof answer === 'function' ? answer(opts) : answer;
    if (out instanceof Error) throw out;
    return out;
  };
  return { calls, chrome: { scripting: { executeScript } } };
}

// ---------- TestomatAPI ----------

// Every method recorded; `impl` stays writable so a row can change an answer mid-flight, which is
// what the read-only re-probe is about.
export function apiStub(over = {}) {
  const calls = [];
  const impl = {
    getProjectInfo: async () => null,
    listProjectUsers: async () => [],
    jwtUserId: () => null,
    jwtAvailable: () => 'unknown',
    readonlyAccess: () => 'unknown',
    validate: async () => true,
    recheckAccess: async () => undefined,
    jwtRequest: async () => ({}),
    ...over,
  };
  const api = {};
  for (const name of Object.keys(impl)) {
    api[name] = (...args) => { calls.push({ name, args }); return impl[name](...args); };
  }
  return {
    api,
    impl,
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    names: () => calls.map((c) => c.name),
    argsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    clear: () => { calls.length = 0; },
  };
}

// A recorded no-op: the sandbox globals state.js calls without a `typeof` guard.
export function spy(impl = () => undefined) {
  const calls = [];
  const fn = (...args) => { calls.push(plain(args)); return impl(...args); };
  fn.calls = calls;
  fn.count = () => calls.length;
  return fn;
}

// The five handleApiError reaches for bare — a sandbox missing any of them throws instead of routing.
const ROUTER_GLOBALS = ['setAuthExpiredLine', 'fillSettingsForm', 'show', 'setStatusLine', 'toast'];
// …and the ones behind `typeof` guards, which rows about a missing global leave out on purpose.
const GUARDED_GLOBALS = ['resetTabCounts', 'syncStop', 'applyReadonlyBlock',
  'updateDegradedBanner', 'refreshCurrentView'];
// Guarded globals that are an OBJECT rather than a bare function: `name: method`. The spy is still
// `spies[name]`, so `omit` and the count read the same as for the others.
const GUARDED_OBJECTS = { CommentDrafts: 'dropAll' };

// ---------- state.js ----------

// `opts.omit` drops named globals from the sandbox; `opts.api` overrides TestomatAPI answers.
export function loadState(opts = {}) {
  const { omit = [], api: apiOver = {}, ids = ['jwt-hint'], hasChrome = true } = opts;
  const store = opts.store || fakeStorage(opts.seed);
  const api = apiStub(apiOver);
  const doc = makeDocument(ids);
  doc.visibilityState = 'visible'; // mini-dom has no such field; state.js reads it as a plain one

  // Fake interval: 60 s of real waiting would outlive the test run and keep node alive.
  const timers = { next: 1, live: new Map(), armed: [], cleared: [] };
  const sandbox = {
    console, URL, TestomatAPI: api.api, document: doc,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = timers.next; timers.next += 1;
      timers.live.set(id, fn); timers.armed.push(ms);
      return id;
    },
    clearInterval: (id) => { timers.cleared.push(id); timers.live.delete(id); },
  };
  if (hasChrome) sandbox.chrome = store.chrome;
  const spies = {};
  for (const name of [...ROUTER_GLOBALS, ...GUARDED_GLOBALS]) {
    if (omit.includes(name)) continue;
    spies[name] = spy(opts.impl?.[name]);
    sandbox[name] = spies[name];
  }
  for (const [name, method] of Object.entries(GUARDED_OBJECTS)) {
    if (omit.includes(name)) continue;
    spies[name] = spy(opts.impl?.[name]);
    sandbox[name] = { [method]: spies[name] };
  }
  Object.assign(sandbox, opts.globals || {}); // anything else the panel's other files publish

  const file = CORE_MODULES.state;
  // The `const`s are lexical, so the script's completion value is how they cross back; `peek` is
  // appended to the STRING only — the shipped file keeps its module state private.
  const exported = runInContext(
    `${sourceOf(file)}\n({ state, capabilities, recordFor, byRecordId, hostOf, isConfigured, staleProject,`
    + ` isAuthError, isReadonlyError, $, views, hasChrome, sleep, READONLY_RECHECK_MS,`
    + ` peek: () => ({ projectInfo, projectInfoPromise, usersMap, usersList, usersPromise,`
    + ` readonlyProbe, readonlyWatch }) })`,
    createContext(sandbox),
    { filename: file },
  );

  return {
    ...exported,
    fn: sandbox,          // the function declarations: resetProjectScopedState, applyCapabilities, …
    sandbox, doc, api, store, spies, timers,
    // Fire every armed interval once, the way the 60 s beat would.
    tick: async () => { for (const fn of [...timers.live.values()]) await fn(); },
    intervals: () => timers.live.size,
    settle,
  };
}

// ---------- storage.js ----------

// state.js first, storage.js second — index.html's order, and the only way storage.js sees the real
// `state`/`hasChrome`/`hostOf` instead of hand-written copies of them.
export function loadStorage(opts = {}) {
  const { hasChrome = true, runInfoOpen = true, withRunInfoOpen = true } = opts;
  const store = opts.store || fakeStorage(opts.seed);
  const api = apiStub(opts.api || {});
  const sandbox = { console, URL, TestomatAPI: api.api, document: makeDocument([]) };
  if (hasChrome) sandbox.chrome = store.chrome;
  // Row 17 wants a sandbox that GENUINELY lacks it, not one where it is undefined.
  if (withRunInfoOpen) sandbox.runInfoOpen = runInfoOpen;

  const context = createContext(sandbox);
  const stateFile = CORE_MODULES.state;
  const shared = runInContext(`${sourceOf(stateFile)}\n({ state, hasChrome, hostOf })`, context,
    { filename: stateFile });
  const storageFile = CORE_MODULES.storage;
  runInContext(sourceOf(storageFile), context, { filename: storageFile });

  return {
    ...shared,
    fn: sandbox,          // loadStored, migrateHostSettings, dropAiApiKey, dropOnboardingState, persistSession
    sandbox, store, api,
    // The script reads `runInfoOpen` as a free variable, so the sandbox property is what it sees.
    setRunInfoOpen: (v) => { sandbox.runInfoOpen = v; },
    settle,
  };
}
