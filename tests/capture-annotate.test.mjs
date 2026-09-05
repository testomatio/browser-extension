#!/usr/bin/env node
// #168: the annotator handoff. Between "the tester pressed the screenshot button" and "the annotator
// is in front of them" sits extension/shared/capture-annotate.js: it asks the worker for the picture,
// tries to open the annotator right on the page under test, and opens an editor tab instead when that
// page will not host it. Three separate "the panel sits on Annotating… forever" bugs were fixed in
// here, so nearly every row below is really the same question — does the promise still come back?
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle } from './helpers/shared-harness.mjs';

const EXT = 'chrome-extension://abcdef';
const OVERLAY_HOST_ID = '__testomat_annotator_overlay';
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const KEY = `annotate-${UUID}`;
const TAB_URL = `${EXT}/editor/editor.html?annotate=${KEY}`;
const SHOT = 'data:image/jpeg;base64,ORIGINAL';
const DRAWN = 'data:image/jpeg;base64,REDACTED';

// Two stylesheets with the exact two shapes the inliner rewrites, and nothing else.
const TOKENS = ':root { --bg: #fff; }\n@font-face { font-family: Ink; src: url(ink.woff2); }';
const COMPONENTS = '.btn { color: var(--bg); }\n:root[data-theme="dark"] { --bg: #000; }';

// The liveness probe is the only executeScript that carries exactly the host id.
const isProbe = (c) => Array.isArray(c.args) && c.args.length === 1 && c.args[0] === OVERLAY_HOST_ID;

// annotateImage never rejects, so a bare await proves nothing — watch the value instead.
function track(p) {
  const seen = { settled: false, value: undefined, error: undefined };
  p.then((v) => { seen.settled = true; seen.value = v; }, (e) => { seen.settled = true; seen.error = e; });
  return seen;
}

/**
 * One sandbox, one load, one set of recorders. `libCss` is module-level memo state, so every
 * case needs its own load or the second one sees no fetch at all.
 */
function load(opts = {}) {
  const {
    chromeMissing = false, noStorageSession = false, noScripting = false,
    noTabsCreate = false, noSendMessage = false,
    sendMessage = async () => ({ ok: true, dataUrl: SHOT, tabId: 7 }),
    setThrowsOn = 0, setError = 'QUOTA_BYTES quota exceeded',
    css = { 'shared/tokens.css': TOKENS, 'shared/components.css': COMPONENTS },
    fetchThrows = false, injectThrows = false,
    overlayUp = false, probeGate = false,
    tab = { id: 42 },
    site, theme, uuid = UUID,
  } = opts;

  const key = `annotate-${uuid}`;
  const rec = {
    sets: [], removes: [], scripts: [], fetches: [], toasts: [],
    created: [], messages: [], siteCalls: [], timers: [],
  };
  const state = { overlayUp, injectThrows, fetchThrows };
  const hooks = { create: null };
  const changed = [];
  const removed = [];
  let releaseProbe = null;
  let setCalls = 0;

  const emit = (value, k = key) => { for (const fn of [...changed]) fn({ [k]: { newValue: value } }); };

  const session = {
    async set(patch) {
      setCalls += 1;
      const copy = JSON.parse(JSON.stringify(patch));
      rec.sets.push(copy);
      if (setCalls === setThrowsOn) throw new Error(setError);
      // Chrome delivers onChanged for the extension's own writes too.
      for (const [k, v] of Object.entries(copy)) emit(v, k);
    },
    async remove(k) { rec.removes.push(k); },
    onChanged: {
      addListener: (fn) => changed.push(fn),
      removeListener: (fn) => { const i = changed.indexOf(fn); if (i >= 0) changed.splice(i, 1); },
    },
  };

  const tabs = {
    onRemoved: {
      addListener: (fn) => removed.push(fn),
      removeListener: (fn) => { const i = removed.indexOf(fn); if (i >= 0) removed.splice(i, 1); },
    },
  };
  if (!noTabsCreate) {
    tabs.create = async (o) => {
      rec.created.push(JSON.parse(JSON.stringify(o)));
      if (hooks.create) await hooks.create(o);
      return tab;
    };
  }

  const scripting = {
    async executeScript(arg) {
      const call = {
        target: { ...arg.target },
        files: arg.files ? [...arg.files] : undefined,
        func: arg.func,
        args: arg.args ? [...arg.args] : undefined,
      };
      rec.scripts.push(call);
      if (isProbe(call)) {
        if (probeGate) await new Promise((r) => { releaseProbe = r; });
        return [{ result: state.overlayUp }];
      }
      if (state.injectThrows) throw new Error('Cannot access contents of the page');
      return [{ result: undefined }];
    },
  };

  const fetchStub = async (url) => {
    rec.fetches.push(String(url));
    if (state.fetchThrows) throw new Error('net::ERR_FILE_NOT_FOUND');
    const rel = String(url).replace(`${EXT}/`, '');
    return { text: async () => css[rel] };
  };

  const sandbox = {
    console,
    crypto: { randomUUID: () => uuid },
    fetch: fetchStub,
    // READY_MS is a hard-coded 3000 with no seam: hold the callback, never a real timer.
    setTimeout: (fn, ms) => { rec.timers.push({ fn, ms }); return rec.timers.length; },
  };
  if (!chromeMissing) {
    const api = { runtime: { getURL: (p) => `${EXT}/${p}` }, tabs };
    if (!noSendMessage) {
      api.runtime.sendMessage = (m) => { rec.messages.push(JSON.parse(JSON.stringify(m))); return sendMessage(m); };
    }
    if (!noStorageSession) api.storage = { session };
    if (!noScripting) api.scripting = scripting;
    sandbox.chrome = api;
  }
  if (site !== undefined) {
    sandbox.resolveSiteTab = async (o) => {
      rec.siteCalls.push(o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
      return site;
    };
  }
  if (theme !== undefined) sandbox.Theme = { resolved: () => theme };

  const { value: api } = loadInto(sandbox, [['shared/capture-annotate.js', 'CaptureAnnotate']]);
  const toast = (m) => rec.toasts.push(m);

  return {
    api, rec, state, hooks, emit, toast, key,
    start: (tabId = 7, extra = {}) => track(api.annotateImage(SHOT, tabId, { toast, ...extra })),
    fireTimers: () => { for (const t of rec.timers.splice(0)) t.fn(); },
    releaseProbe: () => { const r = releaseProbe; releaseProbe = null; r(); },
    closeTab: (id) => { for (const fn of [...removed]) fn(id, { isWindowClosing: false }); },
    probes: () => rec.scripts.filter(isProbe).length,
    listeners: () => changed.length + removed.length,
  };
}

// ---- the on-page overlay answers -------------------------------------------

test('R1: the overlay comes up and the tester applies — the panel gets the drawing, no tab is opened, and the handoff is cleared away', async () => {
  const h = load();
  const run = h.start();
  await settle();
  assert.equal(h.rec.scripts.length, 2); // stashed, then injected

  h.emit({ ready: true });
  await settle();
  h.emit({ resultDataUrl: DRAWN });
  await settle();

  assert.equal(run.settled, true);
  assert.equal(run.value, DRAWN);
  assert.deepEqual(h.rec.created, []);
  assert.deepEqual(h.rec.removes, [KEY]);
  assert.equal(h.listeners(), 0); // nothing left listening on the next capture
});

test('R2: the tester discards in the overlay — the panel is handed nothing and uploads nothing', async () => {
  const h = load();
  const run = h.start();
  await settle();

  h.emit({ ready: true });
  await settle();
  h.emit({ cancelled: true });
  await settle();

  assert.equal(run.settled, true);
  assert.equal(run.value, null);
  assert.deepEqual(h.rec.created, []);
  assert.equal(h.listeners(), 0);
});

test('R3: the overlay is slow but its host IS on the page — the watchdog leaves it alone rather than opening a second annotator', async () => {
  const h = load({ overlayUp: true });
  const run = h.start();
  await settle();
  assert.deepEqual(h.rec.timers.map((t) => t.ms), [3000]);

  h.fireTimers();
  await settle();

  assert.deepEqual(h.rec.created, []);
  assert.deepEqual(h.rec.toasts, []);
  assert.equal(h.rec.sets.length, 1);
  assert.equal(run.settled, false); // still the tester's annotator, still in front of them
});

test('R4: the overlay never reports and nothing is on the page — the shot is re-parked under the key and the editor tab takes over', async () => {
  const h = load({ overlayUp: false });
  const run = h.start();
  await settle();
  h.fireTimers();
  await settle();

  assert.equal(h.probes(), 1);
  assert.deepEqual(h.rec.sets, [{ [KEY]: { dataUrl: SHOT } }, { [KEY]: { dataUrl: SHOT } }]);
  assert.deepEqual(h.rec.created, [{ url: TAB_URL }]);
  assert.deepEqual(h.rec.toasts, ["The annotator didn't come up on that page — opened it in a tab."]);
  assert.equal(run.settled, false); // the tab now owns the answer
});

test('R5: a page Chrome will not let the overlay into goes straight to the tab, with no three-second wait first', async () => {
  const h = load({ injectThrows: true });
  const run = h.start();
  await settle();

  assert.deepEqual(h.rec.toasts, ["This page can't host the annotator — opened it in a tab."]);
  assert.deepEqual(h.rec.created, [{ url: TAB_URL }]);
  assert.deepEqual(h.rec.timers, []); // nothing to wait for — the injection already failed
  assert.equal(h.rec.sets.length, 1);
  assert.equal(run.settled, false);
});

test('R6: the overlay reports its own failure — that sentence is the toast, and the tab takes over without a second opinion', async () => {
  const h = load({ overlayUp: true });
  const run = h.start();
  await settle();

  h.emit({ error: 'The annotator could not read the page stylesheet' });
  await settle();

  assert.deepEqual(h.rec.toasts, ['The annotator could not read the page stylesheet']);
  assert.equal(h.probes(), 0); // an explicit failure is not re-asked; only a timeout is
  assert.deepEqual(h.rec.created, [{ url: TAB_URL }]);
  assert.equal(h.rec.sets.length, 2);
  assert.equal(run.settled, false);
});

test.todo('R7: the tester closes the fallback tab without applying and the panel uploads the un-redacted original (#205)');

test('R8: some other tab closing while the annotator tab is open is none of the handoff\'s business', async () => {
  const h = load({ overlayUp: false });
  const run = h.start();
  await settle();
  h.fireTimers();
  await settle();
  assert.deepEqual(h.rec.created, [{ url: TAB_URL }]);

  h.closeTab(99);
  await settle();

  assert.equal(run.settled, false);
  assert.deepEqual(h.rec.removes, []);
});

// The worker clamps a full-page shot to FULLPAGE_MAX_HEIGHT and the panel says so, which keeps
// this rare — the degrade is pinned all the same.
test('R9: the session store refuses the handoff — the tester gets one sentence and the capture is thrown away, not uploaded', async () => {
  const h = load({ setThrowsOn: 1 });
  const run = h.start();
  await settle();

  assert.deepEqual(h.rec.toasts, ['Could not open the annotator: QUOTA_BYTES quota exceeded']);
  assert.equal(run.settled, true);
  assert.equal(run.value, null);
  assert.deepEqual(h.rec.created, []);
  assert.deepEqual(h.rec.scripts, []);
  assert.deepEqual(h.rec.removes, [KEY]);
  assert.equal(h.listeners(), 0);
});

// ---- the editor tab --------------------------------------------------------

test('R10: asked for the tab outright, the page under test is never touched at all', async () => {
  const h = load({ site: { state: 'ok', tab: { id: 77 } } });
  const run = h.start(7, { forceTab: true });
  await settle();

  assert.deepEqual(h.rec.scripts, []);
  assert.deepEqual(h.rec.siteCalls, []);
  assert.deepEqual(h.rec.timers, []);
  assert.deepEqual(h.rec.toasts, []);
  assert.deepEqual(h.rec.sets, [{ [KEY]: { dataUrl: SHOT } }]);
  assert.deepEqual(h.rec.created, [{ url: TAB_URL }]);
  assert.equal(run.settled, false);
});

test('R11: the caller names no tab, so the site resolver names one and the overlay lands there', async () => {
  const h = load({ site: { state: 'ok', tab: { id: 77 } } });
  h.start(null);
  await settle();

  assert.deepEqual(h.rec.siteCalls, [undefined]); // asked plainly — the verb belongs to the preflight
  assert.deepEqual(h.rec.scripts.map((c) => c.target.tabId), [77, 77]);
});

test('R12: with no way to open a tab the panel is told "nothing" rather than left on Annotating…', async () => {
  const h = load({ noTabsCreate: true });
  const run = h.start(7, { forceTab: true });
  await settle();

  assert.equal(run.settled, true);
  assert.equal(run.value, null);
  assert.deepEqual(h.rec.removes, [KEY]);
  assert.equal(h.listeners(), 0);
});

test('R13: with the extension context gone the answer comes back before anything is armed', async () => {
  const h = load({ noStorageSession: true });
  const run = h.start();

  assert.deepEqual(h.rec.toasts, ['Annotator needs the extension context']);
  assert.equal(h.listeners(), 0); // no listener to leak, no key to clean up
  assert.deepEqual(h.rec.sets, []);

  await settle();
  assert.equal(run.settled, true);
  assert.equal(run.value, null);
});

test('R14: two answers race — the drawing the tester applied wins, and the handoff is torn down exactly once', async () => {
  // The overlay applies while the watchdog is still asking the page whether anything is there.
  const slow = load({ overlayUp: false, probeGate: true });
  const first = slow.start();
  await settle();
  slow.fireTimers();
  await settle();
  assert.equal(slow.probes(), 1);

  slow.emit({ resultDataUrl: DRAWN });
  await settle();
  slow.releaseProbe();
  await settle();

  assert.equal(first.value, DRAWN);
  assert.deepEqual(slow.rec.created, []); // no second annotator behind the tester's back
  assert.equal(slow.rec.sets.length, 1);
  assert.deepEqual(slow.rec.removes, [KEY]);
  assert.deepEqual(slow.rec.toasts, []);

  // And again, with the drawing landing in the very turn the fallback tab fails to open.
  const clash = load({ overlayUp: false });
  clash.hooks.create = async () => {
    clash.emit({ resultDataUrl: DRAWN });
    throw new Error('tabs.create failed');
  };
  const second = clash.start();
  await settle();
  clash.fireTimers();
  await settle();

  assert.equal(second.value, DRAWN);
  assert.deepEqual(clash.rec.removes, [KEY]); // finish ran once, not once per answer
});

// ---- injection ------------------------------------------------------------

test('R15: the stylesheet handed to the overlay carries no webfont and no :root, and is read from disk only once', async () => {
  const h = load();
  assert.equal(await h.api.tryInjectOverlay(7, KEY), true);

  const css = h.rec.scripts[0].args[2];
  assert.equal(css.includes('@font-face'), false);
  assert.equal(css.includes('ink.woff2'), false); // a relative url() would be fetched FROM the site
  assert.equal(css.includes(':root'), false);
  assert.equal(css.includes(':host { --bg: #fff; }'), true);
  assert.equal(css.includes(':host[data-theme="dark"] { --bg: #000; }'), true);
  assert.deepEqual(h.rec.fetches, [`${EXT}/shared/tokens.css`, `${EXT}/shared/components.css`]);

  assert.equal(await h.api.tryInjectOverlay(7, KEY), true);
  assert.equal(h.rec.fetches.length, 2); // memoised — the second injection re-reads nothing
  assert.equal(h.rec.scripts[2].args[2], css);
});

test('R16: an unreadable stylesheet is a "no" from the injector, not a page half-dressed in an annotator', async () => {
  const direct = load({ fetchThrows: true });
  assert.equal(await direct.api.tryInjectOverlay(7, KEY), false);
  assert.deepEqual(direct.rec.scripts, []); // the page is never touched

  const whole = load({ fetchThrows: true });
  const run = whole.start();
  await settle();
  assert.deepEqual(whole.rec.toasts, ["This page can't host the annotator — opened it in a tab."]);
  assert.deepEqual(whole.rec.created, [{ url: TAB_URL }]);
  assert.equal(run.settled, false);
});

test('R17: the key, the scheme and the stylesheet are stashed first, then the four files run in the order the toolbar needs', async () => {
  const h = load({ theme: 'dark' });
  assert.equal(await h.api.tryInjectOverlay(7, KEY), true);
  assert.equal(h.rec.scripts.length, 2);

  const [stash, run] = h.rec.scripts;
  assert.deepEqual(stash.target, { tabId: 7 });
  assert.equal(typeof stash.func, 'function');
  assert.equal(stash.files, undefined);
  assert.deepEqual(stash.args.slice(0, 2), [KEY, 'dark']);

  assert.deepEqual(run.target, { tabId: 7 });
  assert.equal(run.func, undefined);
  assert.deepEqual(run.files, [
    'shared/icons.js', 'shared/tooltip.js', 'shared/annotate-core.js', 'overlay/annotate-overlay.js',
  ]);

  // Outside the panel there is no Appearance setting to resolve, and the overlay is told so.
  const bare = load();
  assert.equal(await bare.api.tryInjectOverlay(7, KEY), true);
  assert.equal(bare.rec.scripts[0].args[1], null);
});

// ---- preflight and the worker round-trip -----------------------------------

test('R18: on a page Chrome bars extensions from, the preflight refuses and hands back the sentence to show', async () => {
  const restricted = load({ site: { state: 'restricted', error: 'Chrome doesn’t allow extensions on this page' } });
  assert.deepEqual(plain(await restricted.api.ensureCapturePermission()), {
    ok: false, state: 'restricted', error: 'Chrome doesn’t allow extensions on this page',
  });
  assert.deepEqual(restricted.rec.siteCalls, [{ verb: 'captured' }]);
  assert.deepEqual(restricted.rec.messages, []); // no capture is even asked for

  // The editor loads this file without the resolver; there the preflight has nothing to refuse on.
  const noResolver = load();
  assert.deepEqual(plain(await noResolver.api.ensureCapturePermission()), { ok: true });
});

test('R19: the worker never answering is an error the panel can print, never an unhandled rejection', async () => {
  const h = load({ sendMessage: async () => { throw new Error('Receiving end does not exist'); } });
  assert.deepEqual(plain(await h.api.captureTab({ fullPage: true })), {
    ok: false, error: 'Error: Receiving end does not exist',
  });
  assert.deepEqual(h.rec.messages, [{ type: 'captureTab', fullPage: true }]);
});

test('R20: a worker that answers with nothing at all still gives the panel a reason to show', async () => {
  const h = load({ sendMessage: async () => undefined });
  assert.deepEqual(plain(await h.api.captureTab()), { ok: false, error: 'no response' });
  assert.deepEqual(h.rec.messages, [{ type: 'captureTab', fullPage: false }]);

  const noRuntime = load({ noSendMessage: true });
  assert.deepEqual(plain(await noRuntime.api.captureTab()), { ok: false, error: 'no extension context' });
});

test('R21: every handoff is parked under annotate-<uuid>, and the editor tab is sent that exact key (#318)', async () => {
  const h = load({ overlayUp: false });
  h.start();
  await settle();
  h.fireTimers();
  await settle();

  const [written] = Object.keys(h.rec.sets[0]);
  assert.match(written, /^annotate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(h.rec.sets[1]), [written]);
  assert.deepEqual(h.rec.created, [{ url: `${EXT}/editor/editor.html?annotate=${written}` }]);
  assert.equal(h.rec.scripts[0].args[0], written);
});
