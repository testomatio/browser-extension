// The shared load() for extension/shared/*.js — the way tests/helpers/api-harness.mjs is api.js's.

// LOADING. Every file here is one IIFE assigned to a top-level `const`, so the module object is the
// script's completion value: `${source}\nHandoff;`. A `const` is lexical, never a sandbox property,
// which is also why a file can be evaluated only ONCE per context (html-sanitize.js and markdown.js
// both declare one at top level) — load() builds a fresh context every call.

// THE FALSIFICATION SEAM. SHARED_SRC names a directory of replacement copies of
// extension/shared/*.js: any basename present there wins over the shipped file, so a mutation run
// never has to edit the repo and risk leaving it edited. SHARED_MODULES=name.js=/abs/path swaps one
// file without a directory. Both mirror API_SRC / API_MODULES in api-harness.mjs.

// STUBS. chromeFake() is a promise-based (MV3) chrome.storage over a plain object plus tabs/windows
// — the same fake serves site-tab.js and handoff.js. It records every set/remove so a row can assert
// that NOTHING was written, next to a row where something was.

// TRAPS. Values built inside the vm realm carry that realm's prototypes: compare them with plain().
// A module's own state (handoff's `offered`, storage contents) is a singleton per load — one load
// per test.
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const OVERRIDES = new Map(
  (process.env.SHARED_MODULES || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return [basename(pair.slice(0, at)), pair.slice(at + 1)];
    }),
);

/** The path a shared file is read from: an override, then SHARED_SRC's copy, then the repo's. */
export function sharedPath(rel) {
  const name = basename(rel);
  if (OVERRIDES.has(name)) return OVERRIDES.get(name);
  if (process.env.SHARED_SRC) {
    const candidate = join(process.env.SHARED_SRC, name);
    try { readFileSync(candidate); return candidate; } catch { /* not mutated — ship it */ }
  }
  return join(repoRoot, 'extension', rel);
}

const sources = new Map();
export const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One turn of the macrotask queue drains every microtask behind it.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * Evaluate files into ONE context, in order, and hand back each one's completion value.
 * `files` are `['shared/html-sanitize.js', ...]` (repo-relative) or `[path, expression]` pairs.
 */
export function loadInto(sandbox, specs) {
  const context = createContext(sandbox);
  const out = [];
  for (const spec of specs) {
    const [rel, expr] = Array.isArray(spec) ? spec : [spec, null];
    const path = rel.startsWith('/') ? rel : sharedPath(rel);
    const src = expr ? `${sourceOf(path)}\n${expr};` : sourceOf(path);
    out.push(runInContext(src, context, { filename: path }));
  }
  return { context, sandbox, values: out, value: out[out.length - 1] };
}

// ---- the chrome fake -------------------------------------------------------

// A promise-based storage area over a plain object; `fail` makes one method reject, which is how a
// row asks "does a broken store swallow the offer?".
function storageArea(seed = {}, fail = {}) {
  const data = { ...seed };
  const sets = [];   // every object handed to set(), in order
  const removes = []; // every key handed to remove()
  return {
    data,
    sets,
    removes,
    api: {
      async get(key) {
        if (fail.get) throw new Error('storage.get failed');
        if (key == null) return { ...data };
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      },
      async set(patch) {
        sets.push(JSON.parse(JSON.stringify(patch)));
        if (fail.set) throw new Error('storage.set failed');
        Object.assign(data, JSON.parse(JSON.stringify(patch)));
      },
      async remove(key) {
        removes.push(key);
        if (fail.remove) throw new Error('storage.remove failed');
        for (const k of (Array.isArray(key) ? key : [key])) delete data[k];
      },
    },
  };
}

/**
 * chrome.storage.local/session over plain objects, plus tabs and windows.
 * `tabs` is an array of tab records; `queryFail` makes the windowId query throw so a row can watch
 * the lastFocusedWindow fallback answer instead.
 */
export function chromeFake(opts = {}) {
  const {
    local = {}, session = {}, localFail = {}, sessionFail = {},
    tabs = [], windows = [], currentWindowId = 1,
    getFail = new Set(), queryFail = () => false, updateFail = false,
    getURL = (p) => `chrome-extension://abcdef/${p}`,
  } = opts;

  const localArea = storageArea(local, localFail);
  const sessionArea = storageArea(session, sessionFail);
  const byId = new Map(tabs.map((t) => [t.id, { ...t }]));
  const queries = [];  // every chrome.tabs.query argument, in order
  const updates = [];  // every chrome.tabs.update(id, props)

  const chrome = {
    runtime: { getURL },
    storage: { local: localArea.api, session: sessionArea.api },
    tabs: {
      async get(id) {
        if (getFail.has(id) || !byId.has(id)) throw new Error(`no tab ${id}`);
        return { ...byId.get(id) };
      },
      async query(q) {
        queries.push({ ...q });
        if (queryFail(q)) throw new Error('tabs.query failed');
        return [...byId.values()].filter((t) => {
          if (q.active && !t.active) return false;
          if (q.windowId != null && t.windowId !== q.windowId) return false;
          if (q.lastFocusedWindow && t.windowId !== currentWindowId) return false;
          return true;
        }).map((t) => ({ ...t }));
      },
      async update(id, props) {
        updates.push({ id, props });
        if (updateFail) throw new Error('tabs.update failed');
        const t = byId.get(id);
        if (t) Object.assign(t, props);
        return t ? { ...t } : undefined;
      },
    },
    windows: {
      async getCurrent() {
        const win = windows.find((w) => w.id === currentWindowId);
        if (!win) throw new Error('no current window');
        return { ...win };
      },
    },
  };

  return { chrome, local: localArea, session: sessionArea, tabs: byId, queries, updates };
}

// ---- the page a sanitiser sees ---------------------------------------------

/** `document.baseURI` + the matching `location.origin` — what resAllowed() reads at call time. */
export const EXT_BASE = 'chrome-extension://abcdef/sidepanel/index.html';
export const EXT_ORIGIN = 'chrome-extension://abcdef';

// Chrome gives a chrome-extension:// URL a real origin; Node reports "null" for every scheme it
// does not treat as special, which would make `/rails/x.png` and `javascript:x` look alike to
// resAllowed(). This is the browser's answer, not a loosening: a different extension id still
// compares unequal, and `javascript:` / `data:` stay origin-less.
export class ExtURL extends URL {
  get origin() {
    const own = super.origin;
    return own === 'null' && this.protocol === 'chrome-extension:'
      ? `${this.protocol}//${this.host}`
      : own;
  }
}

/** The two globals html-sanitize.js reads at call time, plus the URL it judges schemes with. */
export const pageGlobals = (over = {}) => ({
  document: { baseURI: EXT_BASE },
  location: { origin: EXT_ORIGIN },
  URL: ExtURL,
  ...over,
});
