// The shared load() for extension/api.js, the one file in the product that talks to the network —
// the way tests/helpers/worker-harness.mjs is the worker's.

// LOADING. api.js is one IIFE assigned to a top-level `const`, so the module object is the script's
// completion value: `${source}\nTestomatAPI;`.

// api.js's OWN modules (extension/api/*.js) are evaluated in the same sandbox, before it, so the rows
// exercise the moved code itself and not a stale copy left behind.

// THE INTERNALS SEAM. Half the file never reaches that object — `request`, `toError`, `personOf`,
// `pageResult`… are closure-private. One assignment is spliced in just above the export literal so
// a row can name them the way the ticket does; the module's own returned object is untouched, and
// each name is read as `typeof x === 'undefined' ? undefined : x` so an older copy still loads. A
// name that has moved out of the closure is picked off its module global instead; the closure's own
// still wins, so a half-done extract shows up as a leftover rather than hiding behind the module.

// STUBS. api.js reaches for exactly seven globals: fetch, URL, AbortSignal (.timeout/.any), atob,
// FormData, setTimeout — and Blob through the caller's payload. Node supplies all but `fetch`, which
// is the scripted recorder below. No chrome, no document, no storage, no top-level side effects.
// `setTimeout` is the rate-limit back-off's only wait: the stub records the ms and fires at once, so
// a row reads the wait it ASKED for (h.waits()) instead of sitting through it.

// TRAPS. Module state is a singleton per load (cfg, jwt, v2Keys, readonly, readonlyCheck,
// signedAssets, handedJwt) — call load() per test. `readonlyCheck` is a shared in-flight promise: a
// row that leaves it pending poisons the next one, so always await the rejection.

// Every scripted answer resolves a macrotask later, so a Promise.all fan-out really does overlap and
// maxInFlight() can measure it; `delay` makes one answer land out of order on purpose.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
// API_SRC drives the whole suite against a mutated copy, so a falsification run never has to edit
// the shipped file and risk leaving it edited.
export const API = process.env.API_SRC || join(repoRoot, 'extension/api.js');

// The files api.js loads before itself in all three HTML documents, in that order.
const MODULE_FILES = ['api/errors.js', 'api/transport.js', 'api/paging.js', 'api/people.js',
  'api/normalize.js', 'api/assets.js'];
// API_MODULES swaps one or all of them for mutated copies, the same seam API_SRC gives api.js.
export const MODULES = process.env.API_MODULES
  ? process.env.API_MODULES.split(',').map((f) => f.trim()).filter(Boolean)
  : MODULE_FILES.map((f) => join(repoRoot, 'extension', f));

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

// NEVER a real credential: the repository is public. 'TOKEN' is a General token by shape (no `eyJ`),
// and jwtWith() mints a session token with a header that is real base64 and a signature that is not.
export const TOKEN = 'TOKEN';
export const BASE = 'https://app.testomat.io';
export const PROJECT = 'p1';
export const jwtWith = (payload) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
export const JWT = jwtWith({ user_id: 7 });

// Scripted answers. `json` absent = a body res.json() cannot parse; `fail` = fetch itself rejects.
export const ok = (json, over = {}) => ({ status: 200, json, ...over });
export const page = (rows, meta) => ok(meta === undefined ? { data: rows } : { data: rows, meta });
export const fail = (status, over = {}) => ({ status, ...over }); // no `json` key: unparseable body
export const netFail = () => ({ fail: true });

// A rejection as a value — every error row reads `.kind`/`.status`/`.message` off it, never
// `instanceof`, which does not cross the vm realm.
export const rejection = async (p) => {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, got a resolution');
};

// The closure-private names a row names directly. Everything else goes through the module object.
const INNER = [
  'request', 'pagedData', 'rawFetch', 'toError', 'login', 'jwtSend', 'uploadTo', 'v2Token',
  'v2TokenInHand', 'isSessionToken', 'hasCredential', 'guardConfigured', 'guardSession',
  'decodeJwtUserId', 'getSuitePositions', 'normSuiteNode', 'orderSuiteTree', 'normEnv',
  'normDashRun', 'normDashGroup', 'pageResult', 'DASH_KEYS', 'GROUP_KEYS', 'personOf', 'peopleOf',
  'peopleByKey', 'runAssigneesOf', 'runPeopleOf', 'includedRef', 'includedPerson',
  'testrunExampleOf', 'instanceHost', 'PAGE_GUARD',
];
// The one global each api/ module publishes, in load order.
const MODULE_GLOBALS = ['ApiErrors', 'ApiTransport', 'ApiPaging', 'ApiPeople', 'ApiNormalize', 'ApiAssets'];
// The export literal at the bottom of the IIFE, the only `return {` at that indent.
const ANCHOR = '\n  return {\n';
function instrument(src) {
  const at = src.lastIndexOf(ANCHOR);
  if (at < 0) throw new Error('api-harness: the export literal moved — the internals seam needs a new anchor');
  const pick = INNER.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ');
  const mods = MODULE_GLOBALS.map((g) => `(typeof ${g} === 'undefined' ? {} : ${g})`).join(', ');
  const splice = `\n  __inner = (() => {\n`
    + `    const own = { ${pick} };\n`
    + `    for (const k of Object.keys(own)) if (own[k] === undefined) delete own[k];\n`
    + `    return Object.assign({}, ${mods}, own);\n`
    + `  })();\n`;
  return `${src.slice(0, at)}${splice}${src.slice(at)}`;
}

function toResponse(spec) {
  const status = spec.status ?? 200;
  const headers = new Map(
    Object.entries(spec.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
    // No `json` key at all is a body the parser chokes on — a 500 HTML page, an empty 200.
    json: async () => {
      if (!('json' in spec)) throw new SyntaxError('Unexpected end of JSON input');
      return plain(spec.json) ?? spec.json;
    },
    text: async () => spec.text ?? '',
  };
}

export function load(opts = {}) {
  const { sourcePath = API, modules = MODULES } = opts;

  const calls = [];   // every fetch, in order: {url, method, headers, body, timeout, signal}
  const routes = [];  // {match, spec} consulted before the queue
  const queue = [];   // scripted answers, in order
  let inFlight = 0;
  let maxInFlight = 0;
  let lastTimeout = null; // the budget rawFetch asked for, read back off the AbortSignal stub
  const waits = [];       // every ms the code asked to sleep for, in order

  const hooks = {
    // Overridden by the two timeout rows: a signal already aborted, without waiting 30 real seconds.
    timeoutSignal: null,
  };

  const specFor = (rec, n) => {
    for (const r of routes) {
      const hit = typeof r.match === 'function' ? r.match(rec) : rec.url.includes(r.match);
      if (hit) return typeof r.spec === 'function' ? r.spec(rec, n) : r.spec;
    }
    return queue.length ? queue.shift() : undefined;
  };

  const fetchStub = async (input, init = {}) => {
    const rec = {
      url: String(input),
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
      credentials: init.credentials,
      signal: init.signal,
      timeout: lastTimeout,
    };
    calls.push(rec);
    const spec = specFor(rec, calls.length);
    if (spec === undefined) {
      throw new Error(`api-harness: no scripted answer for ${rec.method} ${rec.url}`);
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await settle(spec.delay ?? 1);
      if (spec.fail) throw new Error('fetch failed');
      return toResponse(spec);
    } finally { inFlight -= 1; }
  };

  // A live object, not the real constructor: row 23 deletes `.any` off it.
  const AbortStub = {
    timeout: (ms) => {
      lastTimeout = ms;
      return hooks.timeoutSignal ? hooks.timeoutSignal(ms) : AbortSignal.timeout(ms);
    },
    any: (list) => AbortSignal.any(list),
  };

  const sandbox = {
    __inner: null,
    fetch: fetchStub,
    URL,
    URLSearchParams,
    AbortSignal: AbortStub,
    FormData,
    Blob,
    atob,
    console,
    // The back-off's wait, recorded and skipped: a row asserts the ms, never waits them.
    setTimeout: (fn, ms) => { waits.push(ms); return setTimeout(fn, 0); },
  };

  const context = createContext(sandbox);
  // Same context, before api.js: a module's top-level `const` is what api.js destructures.
  for (const m of modules) runInContext(sourceOf(m), context, { filename: m });
  const src = instrument(sourceOf(sourcePath));
  const mod = runInContext(`${src}\nTestomatAPI;`, context, { filename: sourcePath });

  const h = {
    mod,
    inner: sandbox.__inner,
    sandbox,
    hooks,
    calls,

    // Scripted answers, in order — what a row that does not care about routing uses.
    reply: (...specs) => { queue.push(...specs); return h; },
    // …and by URL, for the fan-outs and for the login that rides along with them.
    route: (match, spec) => { routes.push({ match, spec }); return h; },

    configure: (over = {}) => {
      mod.configure({ baseUrl: BASE, apiToken: TOKEN, projectId: PROJECT, ...over });
      return h;
    },

    urls: () => calls.map((c) => c.url),
    methods: () => calls.map((c) => c.method),
    // Every request whose URL carries `part`.
    matching: (part) => calls.filter((c) => c.url.includes(part)),
    body: (i) => (typeof calls[i]?.body === 'string' ? JSON.parse(calls[i].body) : calls[i]?.body),
    clear: () => { calls.length = 0; maxInFlight = 0; waits.length = 0; return h; },
    maxInFlight: () => maxInFlight,
    // Every back-off the code asked for, in ms and in order.
    waits: () => waits.slice(),
    settle,
  };
  return h;
}
