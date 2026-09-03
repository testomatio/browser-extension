// The shared load() for extension/background.js, the worker side of the recording — the way
// tests/helpers/recorder-harness.mjs is the page side.

// LOADING. The worker publishes nothing, so its functions come back as the script's completion
// value; `importScripts` is a no-op and the five siblings are put on the sandbox by hand.

// Each name is read as `typeof x === 'undefined' ? undefined : x`, so a mutated copy that deletes
// one still loads. createContext, not runInNewContext: an injected `func` needs a document after.

// TRAPS. Date.now is a value a test writes, and setTimeout is fake — an 8s capture floor would
// otherwise cost 8 real seconds.

// Every chrome event keeps an ARRAY of listeners, because the worker registers tabs.onRemoved
// twice; lastError is a getter cleared when a callback returns, or every later capture reads failed.

// storage.session round-trips through JSON on get AND set, as Chrome's clone does: sharing the
// object would hide what the read-modify-write is guarding.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
// BG_SRC drives the whole suite against a mutated copy, so a falsification run never has to edit
// the shipped file and risk leaving it edited.
export const WORKER = process.env.BG_SRC || join(repoRoot, 'extension/background.js');

const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// Values built inside the vm realm have that realm's prototypes: compare them as plain JSON.
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One turn of the macrotask queue drains every microtask behind it; three is the cheap margin for
// the worker's own chains (srSerial → srGet → srSet → the reply).
export const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// A plain `st` record, the shape chrome.storage.session holds under `stepRec`.
export const mkSt = (over = {}) => ({
  tabId: 7,
  recording: true,
  entries: [],
  sent: 0,
  lastNavIdx: -1,
  paused: false,
  manualPause: false,
  capBonus: 0,
  pendingOpen: null,
  lastUrl: 'https://shop.example.com/cart',
  blind: false,
  docIds: [],
  ...over,
});

// Everything the rows reach for. A `function` declaration lands on the sandbox anyway; a lexical
// `const` (srTrimTitle, srEcho, the constants…) exists only here.
const NAMES = [
  'srGet', 'srSet', 'srClear', 'srCap', 'srPush', 'srInject', 'srInjectSync', 'srCatchUpNav',
  'srTrimTitle', 'srCleanTitle', 'srDupNavIdx', 'srPushNav', 'srOpenUrl', 'srStart', 'srOwnerIds',
  'srOwnerOpen', 'srOrphaned', 'srFlushOpen', 'srAdd', 'srPlace', 'srEntry', 'srPopTwins', 'srEcho',
  'srStatus', 'srPause', 'srStopRequest', 'srFlush', 'srContinue', 'srFinalEnd', 'srPull', 'srStop',
  'srIsUrlTitle', 'srRefineNav', 'srTitle', 'srSerial',
  'dbgIsForeignFrame', 'capNeedsGrant', 'dbgError', 'dbgSendCmd', 'dbgAttach', 'dbgDetach',
  'captureVisible', 'captureVisibleNow', 'fullPageClip', 'trimToDocument', 'shootViaDebugger',
  'foreignFramesOut', 'foreignFramesBack', 'captureShot',
  'panelDocsChanged', 'panelOpenIn', 'panelPorts', 'panelDocPorts', 'sweepStagedShots',
  'viewerPageUrl', 'openFileOverlay', 'presenceMatch', 'syncPresenceScript', 'syncPanelBehavior',
  'openPanelWindow', 'openPreferredSurface', 'openSidePanelFor',
  'SR_NAV_LEAD_MS', 'SR_SETTLE_MS', 'SR_NAV_SETTLE_MS', 'SR_TITLE_MAX', 'SR_FLUSH_MS',
  'PANEL_DOC_GRACE_MS', 'CAPTURE_VISIBLE_TIMEOUT_MS', 'FULLPAGE_SLACK', 'FULLPAGE_TOLERANCE',
  'SHOTS_MAX_AGE_MS', 'DBG_FOREIGN_FRAME', 'DBG_FOREIGN_FRAME_CLICK', 'FOREIGN_PARK', 'PRESENCE_ID',
];
const PICK = `;({ ${NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} });`;

// chrome.storage.get, all four argument shapes.
function readKeys(store, keys) {
  if (keys == null) return { ...store };
  if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
  if (Array.isArray(keys)) {
    const out = {};
    for (const k of keys) if (k in store) out[k] = store[k];
    return out;
  }
  const out = {};
  for (const [k, d] of Object.entries(keys)) out[k] = k in store ? store[k] : d;
  return out;
}

export const DEFAULT_TAB = Object.freeze({
  id: 7, active: true, windowId: 1, url: 'https://shop.example.com/cart', title: 'Cart',
});

export function load(opts = {}) {
  const {
    now = 1_700_000_000_000,
    session = {},
    local = {},
    sourcePath = WORKER,
  } = opts;

  const calls = [];                 // every stubbed call, in order: {name, args}
  const sess = plain(session);      // storage.session, a plain object
  const loc = plain(local);         // storage.local
  const canvases = [];              // every OffscreenCanvas the trim built
  let clock = now;
  let timerSeq = 0;
  const timers = new Map();         // id -> {at, fn, args}
  let lastError;                    // read through a getter, cleared the moment a callback returns

  const log = (name, ...args) => { calls.push({ name, args }); };

  // The knobs a row turns. A test overrides one of these AFTER load(); the stubs read them live.
  const hooks = {
    viewMode: () => 'sidepanel',
    resolveSiteTab: () => ({ state: 'ok', tab: { ...DEFAULT_TAB } }),
    castOwns: () => false,
    getContexts: () => [{ documentId: 'doc-1' }],
    sessionGet: null,               // set to a function to make storage.session.get reject
    getTab: (id) => ({ ...DEFAULT_TAB, id }),
    sendMessage: () => Promise.resolve({ ok: true }),
    createTab: (props) => ({ id: 99, ...props }),
    captureVisibleTab: (windowId, o, cb) => cb('data:image/jpeg;base64,visible'),
    executeScript: () => [],
    getRegisteredContentScripts: () => [],
    dbgAttach: () => null,          // a string here becomes chrome.runtime.lastError
    dbgDetach: () => null,
    dbgSend: () => ({ res: { data: 'shot' } }),
    fetchImage: () => ({ blob: async () => ({ kind: 'blob' }) }),
    bitmap: () => ({ width: 1280, height: 4000, close() {} }),
    convertToBlob: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  };

  // ---- fake timers --------------------------------------------------------
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

  // ---- chrome ------------------------------------------------------------
  const bus = () => {
    const fns = [];
    return {
      fns,
      addListener: (fn) => { fns.push(fn); },
      removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
      hasListener: (fn) => fns.includes(fn),
    };
  };
  const emit = (b, ...args) => b.fns.map((fn) => fn(...args));

  // A callback-style API reports its failure through lastError and clears it on the way out.
  const withLastError = (msg, fn) => {
    lastError = msg ? { message: msg } : undefined;
    try { return fn(); } finally { lastError = undefined; }
  };

  const storageArea = (store, area) => ({
    get: async (keys) => {
      log(`storage.${area}.get`, keys);
      if (area === 'session' && hooks.sessionGet) return hooks.sessionGet(keys);
      return plain(readKeys(store, keys));
    },
    set: async (obj) => {
      log(`storage.${area}.set`, plain(obj));
      Object.assign(store, plain(obj)); // Chrome structured-clones; an alias would hide srSerial's job
    },
    remove: async (key) => {
      log(`storage.${area}.remove`, key);
      for (const k of Array.isArray(key) ? key : [key]) delete store[k];
    },
  });

  const runtime = {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    get lastError() { return lastError; },
    getURL: (path) => `chrome-extension://${runtime.id}/${String(path)}`,
    getContexts: async (filter) => { log('runtime.getContexts', filter); return hooks.getContexts(filter); },
    onMessage: bus(),
    onConnect: bus(),
    onStartup: bus(),
    onInstalled: bus(),
  };

  const sessionArea = storageArea(sess, 'session');
  sessionArea.setAccessLevel = (o) => { log('storage.session.setAccessLevel', o); return Promise.resolve(); };

  const chromeStub = {
    runtime,
    storage: { session: sessionArea, local: storageArea(loc, 'local'), onChanged: bus() },
    sidePanel: {
      setPanelBehavior: (o) => { log('sidePanel.setPanelBehavior', o); return Promise.resolve(); },
      open: (o) => { log('sidePanel.open', o); return Promise.resolve(); },
    },
    action: { onClicked: bus() },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: bus(),
      onRemoved: bus(),
      get: async (id) => { log('windows.get', id); return { id, type: 'normal' }; },
      create: async (o) => { log('windows.create', o); return { id: 42 }; },
      update: async (id, o) => { log('windows.update', id, o); return { id }; },
    },
    tabs: {
      onUpdated: bus(),
      onRemoved: bus(),
      get: async (id) => { log('tabs.get', id); return hooks.getTab(id); },
      create: async (o) => { log('tabs.create', o); return hooks.createTab(o); },
      sendMessage: (tabId, msg) => { log('tabs.sendMessage', tabId, msg); return hooks.sendMessage(tabId, msg); },
      captureVisibleTab: (windowId, o, cb) => {
        log('tabs.captureVisibleTab', windowId, o);
        return hooks.captureVisibleTab(windowId, o, (dataUrl, err) => withLastError(err, () => cb(dataUrl)));
      },
    },
    scripting: {
      executeScript: async (arg) => { log('scripting.executeScript', arg); return hooks.executeScript(arg); },
      getRegisteredContentScripts: async (f) => {
        log('scripting.getRegisteredContentScripts', f);
        return hooks.getRegisteredContentScripts(f);
      },
      registerContentScripts: async (s) => { log('scripting.registerContentScripts', s); },
      updateContentScripts: async (s) => { log('scripting.updateContentScripts', s); },
      unregisterContentScripts: async (s) => { log('scripting.unregisterContentScripts', s); },
    },
    debugger: {
      attach: (target, version, cb) => {
        log('debugger.attach', target, version);
        withLastError(hooks.dbgAttach(target), cb);
      },
      detach: (target, cb) => { log('debugger.detach', target); withLastError(hooks.dbgDetach(target), cb); },
      sendCommand: (target, cmd, params, cb) => {
        log('debugger.sendCommand', target, cmd, params);
        const out = hooks.dbgSend(cmd, params, target) || {};
        withLastError(out.error, () => cb(out.error ? undefined : out.res));
      },
    },
  };

  // ---- the sandbox -------------------------------------------------------
  class FakeDate extends Date { static now() { return clock; } }
  class FakeCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      canvases.push(this);
    }

    getContext() { return { drawImage: (...a) => log('canvas.drawImage', ...a) }; }

    async convertToBlob(o) { log('canvas.convertToBlob', o); return hooks.convertToBlob(o); }
  }

  const sandbox = {
    importScripts: (...files) => { log('importScripts', ...files); }, // the siblings are stubbed below
    ViewMode: {
      KEY: 'viewMode',
      WINDOW_SIZE: { width: 420, height: 720 },
      mode: async () => hooks.viewMode(),
      panelUrl: () => 'panel.html',
      panelWindowId: async () => null,
      rememberPanelWindow: async (id) => { log('ViewMode.rememberPanelWindow', id); },
      rememberNormalWindow: async (id) => { log('ViewMode.rememberNormalWindow', id); },
      forgetPanelWindow: (id) => { log('ViewMode.forgetPanelWindow', id); },
    },
    SiteTab: {
      restrictedCopy: () => 'This page cannot be captured',
      rememberTab: async (tab) => { log('SiteTab.rememberTab', tab && tab.id); },
      forgetTab: async (id) => { log('SiteTab.forgetTab', id); },
    },
    resolveSiteTab: async (o) => { log('resolveSiteTab', o); return hooks.resolveSiteTab(o); },
    ShotStore: { sweep: async (keys, maxAge) => { log('ShotStore.sweep', keys, maxAge); } },
    evStopIfRecording: (reason) => { log('evStopIfRecording', reason); },
    srecCastOwns: (tabId) => hooks.castOwns(tabId),

    chrome: chromeStub,
    console,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    setInterval: () => 0,
    clearInterval: () => {},
    Date: FakeDate,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch: async (url) => { log('fetch', url); return hooks.fetchImage(url); },
    createImageBitmap: async (blob) => { log('createImageBitmap'); return hooks.bitmap(blob); },
    OffscreenCanvas: FakeCanvas,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  };

  const context = createContext(sandbox);
  const api = runInContext(`${sourceOf(sourcePath)}\n${PICK}`, context, { filename: sourcePath });

  const port = (name) => {
    const p = {
      name,
      onMessage: bus(),
      onDisconnect: bus(),
      postMessage: (msg) => log('port.postMessage', name, msg),
      disconnect: () => emit(p.onDisconnect),
      hello: (windowId) => emit(p.onMessage, windowId === undefined
        ? { type: 'PANEL_HELLO' } : { type: 'PANEL_HELLO', windowId }),
    };
    return p;
  };

  return {
    api,
    sandbox,
    hooks,
    chrome: chromeStub,
    session: sess,
    local: loc,
    calls,
    canvases,

    // The stepRec record as a JSON copy — safe to deepEqual against a plain object.
    st: () => plain(sess.stepRec),
    setSt: (v) => { sess.stepRec = plain(v); },

    callsOf: (name) => calls.filter((c) => c.name === name),
    named: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    clearCalls: () => { calls.length = 0; },

    now: () => clock,
    setNow: (v) => { clock = v; return clock; },
    advance,
    pending: () => [...timers.values()].map((t) => t.at - clock),
    settle,

    // Fire an event at EVERY listener registered for it, the way Chrome does.
    emit: (path, ...args) => {
      const b = path.split('.').reduce((o, k) => o[k], chromeStub);
      return emit(b, ...args);
    },
    // One trip through the onMessage routers; resolves with whatever sendResponse was handed.
    message: (msg, sender = {}) => new Promise((resolve) => {
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
      const rets = emit(runtime.onMessage, msg, sender, respond);
      if (!rets.some((r) => r === true)) resolve(undefined);
    }),
    connect: (name) => {
      const p = port(name);
      emit(runtime.onConnect, p);
      return p;
    },
    port,
  };
}
