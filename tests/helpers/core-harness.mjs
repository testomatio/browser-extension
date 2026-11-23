// persistSession is fire-and-forget: await settle() before reading the recorded write.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { makeDocument } from './mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// CORE_SRC/SCREENS_SRC point at mutated copies, so a mutation run never edits the shipped files.
export const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
export const SCREENS_SRC = process.env.SCREENS_SRC || join(repoRoot, 'extension/sidepanel/screens');

const DEFAULT_MODULES = {
  state: join(CORE_SRC, 'state.js'),
  storage: join(CORE_SRC, 'storage.js'),
  'env-info': join(CORE_SRC, 'env-info.js'),
};

// CORE_MODULES swaps one module for a mutated copy: `state=/tmp/bad-state.js` or a bare path.
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

// `fails` makes one op reject, the only way to reach the swallowed-rejection branches.
export function fakeStorage(seed = {}) {
  const data = { ...seed };
  const calls = [];
  const fails = { get: null, set: null, remove: null };
  // `raw` too: an undefined value vanishes from JSON, and the session write is asserted by key set.
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

// Only passed keys go on the sandbox: a missing global is not the same as one set to undefined.
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

// `answer` is the executeScript result or a function of its options; an Error value rejects.
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

// `impl` stays writable so a row can change an answer mid-flight, as the read-only re-probe needs.
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
// Globals behind `typeof` guards, which rows about a missing global leave out on purpose.
const GUARDED_GLOBALS = ['resetTabCounts', 'syncStop', 'applyReadonlyBlock',
  'updateDegradedBanner', 'refreshCurrentView'];
// Guarded globals that are an object, as `name: method`; the spy is still `spies[name]`.
const GUARDED_OBJECTS = { CommentDrafts: 'dropAll' };

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
  // `peek` is appended to the evaluated string only; the shipped file keeps its module state private.
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

// state.js first, as index.html orders it, so storage.js sees the real state/hasChrome/hostOf.
export function loadStorage(opts = {}) {
  const { hasChrome = true, runInfoOpen = true, withRunInfo = true } = opts;
  const store = opts.store || fakeStorage(opts.seed);
  const api = apiStub(opts.api || {});
  const sandbox = { console, URL, TestomatAPI: api.api, document: makeDocument([]) };
  if (hasChrome) sandbox.chrome = store.chrome;

  const context = createContext(sandbox);
  const stateFile = CORE_MODULES.state;
  const shared = runInContext(`${sourceOf(stateFile)}\n({ state, hasChrome, hostOf })`, context,
    { filename: stateFile });
  // The real run-info.js; one row needs a context that truly lacks it, not one where it is undefined.
  let RunInfo = null;
  if (withRunInfo) {
    const infoFile = join(SCREENS_SRC, 'run-info.js');
    RunInfo = runInContext(`${sourceOf(infoFile)}\nRunInfo;`, context, { filename: infoFile });
    RunInfo.open = runInfoOpen;
  }
  const storageFile = CORE_MODULES.storage;
  runInContext(sourceOf(storageFile), context, { filename: storageFile });

  return {
    ...shared,
    fn: sandbox,          // loadStored, migrateHostSettings, dropAiApiKey, persistSession
    sandbox, store, api, RunInfo,
    // `RunInfo` is a lexical const of this context, read by storage.js as a free variable.
    setRunInfoOpen: (v) => { RunInfo.open = v; },
    settle,
  };
}
