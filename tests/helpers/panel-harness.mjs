// A screen's published const is lexical, so the caller names it and gets the completion value.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { makeDocument, el, text, fire, event } from './mini-dom.mjs';

export { makeDocument, el, text, fire, event };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// SCREENS_SRC/CORE_SRC point at mutated copies, so a mutation run never edits the shipped files.
export const SCREENS_SRC = process.env.SCREENS_SRC || join(repoRoot, 'extension/sidepanel/screens');
export const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');

const sources = new Map();
const sourceOf = (path) => {
  if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'));
  return sources.get(path);
};

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
export const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One macrotask turn drains every microtask behind it, as a dropped async drain promise needs.
export const settle = async (turns = 2) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

// A rejection as a value — `instanceof` does not cross the vm realm.
export const rejection = async (p) => {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, got a resolution');
};

// The real class: only a Node-realm class keeps `instanceof` working across the vm boundary.
export class ApiError extends Error {
  constructor(kind, status, detail) {
    super(detail || kind);
    this.kind = kind; // unconfigured | network | auth | readonly | notfound | http
    this.status = status;
  }
}

// `fails` makes one op reject, the only way to reach the swallowed-rejection branches.
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
  // `raw` too: an undefined value vanishes from JSON, and some rows assert the exact key set.
  const record = (area, op, arg) => { calls.push({ area, op, arg: plain(arg), raw: arg }); };

  const localOp = (op) => async (arg) => {
    record('local', op, arg);
    if (fails[op]) throw fails[op];
    if (op === 'get') return pick(data, arg);
    // A JSON copy, as real storage serialises: a live reference would let later mutations rewrite it.
    if (op === 'set') Object.assign(data, plain(arg));
    if (op === 'remove') for (const k of [].concat(arg)) delete data[k];
    return undefined;
  };
  const sessionGet = async (arg) => {
    record('session', 'get', arg);
    if (fails.sessionGet) throw fails.sessionGet;
    return pick(sess, arg);
  };

  // The open-run intent is burnt before it is acted on, so rows watch the key actually leave `sess`.
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

// Handlers are asserted by running them, so the fake keeps registrations rather than counting.
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

// A real interval keeps the node process alive; these fire only when a test calls tick().
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

// `before` scripts share the context: a published const is a global lexical, never a property.
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

  // Without it a poll gate takes its "no such property" branch and passes for the wrong reason.
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
    // [name, otherDir] loads a script from another folder, so CORE_SRC stays switchable.
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

// APP_SRC points at a mutated copy of app.js, the file-shaped twin of CORE_SRC.
export const APP_SRC = process.env.APP_SRC || join(repoRoot, 'extension/sidepanel/app.js');

// SessionRestore.fromStored() for an empty panel, so `restored` names only the field a row is about.
const RESTORE_DEFAULTS = {
  stepTicks: {}, expandedGroups: [], runsFilter: 'all', runInfoOpen: true, tabViews: {}, activeTab: null,
};

// Globals app.js only wires during boot: stubbed so boot reaches its decisions, still recorded.
const BOOT_NOOPS = [
  'initActionLabelFit', 'initCounterFade', 'switchTab', 'openTestSuitePicker', 'openEditor', 'goBack',
  'saveSettings', 'initSettingsSections', 'toggleSettingsAdvanced', 'initThemeSwitch',
  'disconnectInstance', 'forgetInstance', 'signOut', 'renderDiagnostics', 'copyDiagnostics',
  'updateTokenHelpLink', 'syncTokenField', 'initHostHistoryDropdown', 'initProjectDropdown',
  'initProjectPick', 'refreshAll', 'initViewSwitch', 'dismissDegradedBanner',
  'refreshFromDegradedBanner', 'onRunsSearch', 'onRunsSearchKeydown', 'clearRunsSearch', 'onRunSearch',
  'clearRunSearch', 'onTcSearch', 'clearTcSearch', 'onTcTreeSearch', 'clearTcTreeSearch', 'clickStatus',
  'navigateTest', 'showTestSection', 'attachScreenshotAnnotated', 'savePendingAnnotation',
  'initEvidence', 'initAttachments', 'initScreenRec', 'initLiveSync', 'onHotkey', 'initHotkeyHints',
  'applyCapabilities', 'fillSettingsForm', 'show', 'askForProject', 'setStatusLine', 'openRunFromUrl',
  'migrateHostSettings', 'dropAiApiKey',
];

// The six screen openers: which one boot picked, with what, IS the assertion in every landing row.
const BOOT_OPENERS = [
  'openRunView', 'openTestView', 'openTcListView', 'openSettingsView', 'openTcStudioView', 'openRunsView',
];

// Loading app.js is the boot: its last `init().finally(...)` is the completion value awaited here.
export async function bootPanel(opts = {}) {
  const {
    stored = {},          // what loadStored() answers: { settings, session, … }
    restored = {},        // over RESTORE_DEFAULTS — SessionRestore.fromStored()'s answer
    handoffReady = false, // a host app is offering a connection
    handoffRun = false,   // …and it carries a run to open
    intent = false,       // a pending "Run in Extension" click, as OpenRunIntent.consume() answers it
    tcReturn = null,      // the editor's breadcrumb, as SessionRestore.takeTcReturn() answers it
    project = 'ready',    // initProjectSwitcher(): ready | choose | none
    records = [],         // the loaded run's rows, which is what recordFor() searches
    state: seed = {},
    answers = {},
    globals = {},
    file = APP_SRC,
    document: doc = makeDocument(),
    window: win = fakeWindow(),
    store = fakeChrome(opts),
  } = opts;

  const calls = [];
  const stub = (name, fallback) => {
    const impl = Object.prototype.hasOwnProperty.call(answers, name) ? answers[name] : fallback;
    return (...args) => {
      calls.push({ name, args });
      return typeof impl === 'function' ? impl(...args) : impl;
    };
  };

  // $() mints what it is asked for: one of app.js's ~60 lookups answering null would throw mid-boot.
  const lookups = [];
  const $ = (id) => {
    lookups.push(id);
    let node = doc.getElementById(id);
    if (!node) { node = el('div', { id }); doc.body.append(node); }
    return node;
  };

  const state = {
    booting: true, settings: null, view: null, records, runTitle: '',
    tcSuiteId: null, tcSuiteTitle: '', ...seed,
  };

  const sandbox = {
    console, URL, document: doc, window: win, chrome: store.chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    $,
    state,
    FILTER_KEYS: new Set(['all', 'passed', 'failed', 'running', 'scheduled', 'terminated']),
    Skeleton: { paintBoot: stub('Skeleton.paintBoot'), bootDone: stub('Skeleton.bootDone') },
    Icons: { hydrate: stub('Icons.hydrate') },
    PanelLink: { init: stub('PanelLink.init') },
    CommentDrafts: { onInput: stub('CommentDrafts.onInput') },
    RunLock: { finishRun: stub('RunLock.finishRun') },
    RunInfo: { open: true, toggle: stub('RunInfo.toggle') },
    TestSummary: { toggleDisclosure: stub('TestSummary.toggleDisclosure') },
    TestMeta: { initSubstatus: stub('TestMeta.initSubstatus'), initAssignee: stub('TestMeta.initAssignee') },
    TestGates: {
      setFullPageCapture: stub('TestGates.setFullPageCapture'),
      toggleAttachmentsDisclosure: stub('TestGates.toggleAttachmentsDisclosure'),
    },
    TcSuiteCreate: { openRoot: stub('TcSuiteCreate.openRoot') },
    TcQuickBar: {
      onInput: stub('TcQuickBar.onInput'), onKeydown: stub('TcQuickBar.onKeydown'),
      submit: stub('TcQuickBar.submit'), onBulkToggle: stub('TcQuickBar.onBulkToggle'),
    },
    OfflineQueue: { init: stub('OfflineQueue.init'), replay: stub('OfflineQueue.replay') },
    Handoff: {
      ready: stub('Handoff.ready', async () => handoffReady),
      connect: stub('Handoff.connect', async () => {}),
      configure: stub('Handoff.configure'),
      openRun: stub('Handoff.openRun', async () => handoffRun),
    },
    OpenRunIntent: {
      drop: stub('OpenRunIntent.drop'),
      consume: stub('OpenRunIntent.consume', async () => intent),
      init: stub('OpenRunIntent.init'),
    },
    SessionRestore: {
      fromStored: stub('SessionRestore.fromStored', () => ({ ...RESTORE_DEFAULTS, ...restored })),
      takeTcReturn: stub('SessionRestore.takeTcReturn', () => tcReturn),
    },
    loadStored: stub('loadStored', async () => stored),
    initProjectSwitcher: stub('initProjectSwitcher', async () => project),
    // core/state.js's own lookup, over whatever run the row says is loaded.
    recordFor: stub('recordFor', (id) => state.records.find((r) => String(r.id) === String(id))),
    ...Object.fromEntries([...BOOT_NOOPS, ...BOOT_OPENERS].map((n) => [n, stub(n)])),
    ...globals,
  };

  const boot = runInContext(sourceOf(file), createContext(sandbox), { filename: file });
  // No handle means app.js's last statement stopped being the boot: fail rather than pass hollow.
  if (!boot || typeof boot.then !== 'function') {
    throw new Error(`${file} did not end in the boot promise — its last statement is this harness's only handle`);
  }
  let bootError = null;
  try { await boot; } catch (e) { bootError = e; }
  await settle();

  const names = () => calls.map((c) => c.name);
  return {
    calls, lookups, state, sandbox, doc, window: win, store, bootError, plain, settle,
    names,
    count: (name) => calls.filter((c) => c.name === name).length,
    argsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    // The calls a row names, in boot order, without the fifty listener wirings in between.
    order: (...of) => names().filter((n) => of.includes(n)),
  };
}
