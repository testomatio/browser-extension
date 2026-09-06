#!/usr/bin/env node
// extension/sidepanel/core/view-switch.js (#184): the one header button that moves the panel between
// Chrome's side panel and a free-floating window, and back.
// Two promises hold it up, and both break silently. The preference is written ONLY once the other
// surface has really opened — write it early and a tester whose window Chrome refused is left with
// a toolbar icon pointing at a surface that never appears. And `sidePanel.open()` must run while the
// click is still on the stack: put one await in front of it and Chrome rejects the gesture, so the
// dock button simply stops working with no error anyone sees.
// Run: node --test tests/view-switch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, fakeWindow, fire, plain, settle } from './helpers/panel-harness.mjs';

const NORMAL_KEY = 'viewNormalWindowId';

// `inPanelWindow` and `hostWindowId` are module `let`s no caller can reach, so every row about them
// is asserted through what the button then DOES. One load per case: the two are never reset.
function loadViewSwitch(opts = {}) {
  const {
    withButton = true,
    hasChrome = true,
    withWindows = true,
    inPanelWindow = false,
    normalWindowId = 7,
    open = 'ok',             // 'ok' | 'throw' (synchronously) | 'reject'
    closeThrows = false,
  } = opts;
  // Read through `in`, not a default: `undefined` IS one of the worker's answers, and a default
  // parameter would quietly turn that row into the happy path.
  const answer = 'answer' in opts ? opts.answer : { ok: true };

  // Every side effect in the order it happened: half of what this file promises is a sequence.
  const order = [];
  const toasts = [];
  const tips = [];
  const sent = [];
  const opens = [];
  const icons = [];
  const listeners = [];

  const doc = makeDocument(withButton ? ['button#view-switch'] : []);
  const btn = doc.getElementById('view-switch');
  if (btn) {
    // index.html:53 ships the side-panel state statically; this file repaints it once it knows.
    btn.setAttribute('aria-label', 'Open in window');
    btn.append(doc.createElement('span'));
  }

  const win = fakeWindow();
  win.close = () => {
    order.push('close');
    if (closeThrows) throw new Error('Scripts may not close windows that were not opened by script');
  };

  const chrome = {
    runtime: {
      async sendMessage(msg) {
        sent.push(msg);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    sidePanel: {
      open(arg) {
        order.push('sidePanel.open');
        opens.push(arg);
        if (open === 'throw') throw new Error('user gesture required');
        if (open === 'reject') return Promise.reject(new Error('no such window'));
        return Promise.resolve();
      },
    },
    storage: { onChanged: { addListener: (fn) => listeners.push(fn) } },
  };
  if (withWindows) chrome.windows = {};

  const asked = { inPanelWindow: 0, normalWindowId: 0 };
  const modes = [];
  const globals = {
    $: (id) => doc.getElementById(id),
    hasChrome,
    toast: (msg, o) => { order.push('toast'); toasts.push({ msg, error: !!(o && o.error) }); },
    Icons: { el: (name, size) => { icons.push([name, size]); return doc.createElement('span'); } },
    Tooltip: { set: (node, label) => tips.push(label) },
    ViewMode: {
      NORMAL_KEY,
      async inPanelWindow() { asked.inPanelWindow += 1; return inPanelWindow; },
      async normalWindowId() { asked.normalWindowId += 1; return normalWindowId; },
      async setMode(m) { order.push(`setMode:${m}`); modes.push(m); },
    },
  };

  const h = loadScreen('view-switch', {
    dir: CORE_SRC, store: { chrome }, globals, document: doc, window: win,
  });
  return {
    fn: h.fn, doc, btn, order, toasts, tips, sent, opens, icons, listeners, modes, asked,
    // What Chrome delivers when the worker records a focus change into a normal window.
    fire: (changes, area = 'session') => listeners.forEach((cb) => cb(changes, area)),
  };
}

// ---------- boot ----------

test('a browser without the windows API hides the switch rather than offering a dead one', async () => {
  const h = loadViewSwitch({ withWindows: false });
  await h.fn.initViewSwitch();
  assert.equal(h.btn.hidden, true);
  assert.equal(h.asked.inPanelWindow, 0);
  assert.equal(h.listeners.length, 0);
  assert.equal(h.btn.dataset.viewTarget, undefined); // never repainted
});

test('a page with no chrome at all hides it the same way', async () => {
  const h = loadViewSwitch({ hasChrome: false });
  await h.fn.initViewSwitch();
  assert.equal(h.btn.hidden, true);
});

test('a document with no such button returns instead of throwing on boot', async () => {
  const h = loadViewSwitch({ withButton: false });
  await h.fn.initViewSwitch();
  h.fn.renderViewSwitch(); // and the repaint is just as quiet
  assert.equal(h.listeners.length, 0);
});

test('the side panel needs no host window id, so it never looks one up', async () => {
  const h = loadViewSwitch({ inPanelWindow: false });
  await h.fn.initViewSwitch();
  assert.equal(h.asked.inPanelWindow, 1);
  assert.equal(h.asked.normalWindowId, 0);
  // …and the id it never read is the one a dock would need.
  h.fn.dockToSidePanel();
  assert.deepEqual(plain(h.toasts), [
    { msg: 'Open a browser window first — the side panel lives in one', error: true },
  ]);
  assert.deepEqual(h.opens, []);
});

test('the floating window learns which browser window a dock would land in', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  await h.fn.initViewSwitch();
  assert.equal(h.asked.normalWindowId, 1);
  h.fn.dockToSidePanel();
  assert.deepEqual(plain(h.opens), [{ windowId: 7 }]);
});

test('the tester focusing another browser window moves where a dock would land', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  await h.fn.initViewSwitch();
  h.fire({ [NORMAL_KEY]: { newValue: 12 } }, 'session');
  h.fn.dockToSidePanel();
  assert.deepEqual(plain(h.opens), [{ windowId: 12 }]);
});

test('a change that is not an id, or not the session area, leaves the target alone', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  await h.fn.initViewSwitch();
  h.fire({ [NORMAL_KEY]: { newValue: '12' } }, 'session');
  h.fire({ [NORMAL_KEY]: { newValue: 3.5 } }, 'session');
  h.fire({ [NORMAL_KEY]: { newValue: undefined } }, 'session');
  h.fire({ [NORMAL_KEY]: { newValue: 12 } }, 'local');
  h.fire({ viewMode: { newValue: 12 } }, 'session');
  h.fn.dockToSidePanel();
  assert.deepEqual(plain(h.opens), [{ windowId: 7 }]);
});

// ---------- the label ----------

test('in the side panel the button says what pressing it does: open in window', async () => {
  const h = loadViewSwitch({ inPanelWindow: false });
  await h.fn.initViewSwitch();
  assert.equal(h.btn.dataset.viewTarget, 'window');
  assert.equal(h.btn.getAttribute('aria-label'), 'Open in window');
  assert.deepEqual(h.tips, ['Open in window']);
  assert.deepEqual(plain(h.icons), [['web_asset', 20]]);
});

test('in the floating window it says the opposite: dock to side panel', async () => {
  const h = loadViewSwitch({ inPanelWindow: true });
  await h.fn.initViewSwitch();
  assert.equal(h.btn.dataset.viewTarget, 'sidepanel');
  assert.equal(h.btn.getAttribute('aria-label'), 'Dock to side panel');
  assert.deepEqual(h.tips, ['Dock to side panel']);
  assert.deepEqual(plain(h.icons), [['dock_to_right', 20]]);
});

// ---------- side panel → window ----------

test('the window really opening is what earns the preference, and then this surface closes', async () => {
  const h = loadViewSwitch({ inPanelWindow: false, answer: { ok: true } });
  await h.fn.initViewSwitch();
  await h.fn.openInWindow();
  assert.deepEqual(plain(h.sent), [{ type: 'VIEW_OPEN_WINDOW' }]);
  assert.deepEqual(h.order, ['setMode:window', 'close']);
  assert.deepEqual(h.toasts, []);
});

test('a window Chrome refused is explained, and nothing is remembered', async () => {
  const h = loadViewSwitch({ answer: { ok: false, error: 'blocked' } });
  await h.fn.initViewSwitch();
  await h.fn.openInWindow();
  assert.deepEqual(plain(h.toasts), [
    { msg: "Couldn't open the panel in a window — blocked", error: true },
  ]);
  assert.deepEqual(h.modes, []);
  assert.deepEqual(h.order, ['toast'], 'no setMode, and this surface stays open');
});

test('a worker that never answers gets the same refusal without a made-up reason', async () => {
  for (const answer of [new Error('receiving end does not exist'), null, undefined, { ok: false }, {}]) {
    const h = loadViewSwitch({ answer });
    await h.fn.initViewSwitch();
    await h.fn.openInWindow();
    assert.deepEqual(plain(h.toasts), [
      { msg: "Couldn't open the panel in a window", error: true },
    ]);
    assert.deepEqual(h.modes, []);
  }
});

// ---------- window → side panel ----------

test('the dock opens the side panel BEFORE anything is awaited, or Chrome drops the gesture', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  await h.fn.initViewSwitch();
  h.fn.dockToSidePanel();               // deliberately not awaited: this is the click's own turn
  assert.deepEqual(h.order, ['sidePanel.open']);
  await settle();
  assert.deepEqual(h.order, ['sidePanel.open', 'setMode:sidepanel', 'close']);
  assert.deepEqual(plain(h.opens), [{ windowId: 7 }]);
});

test('with no browser window to dock into, the tester is told to open one first', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: null });
  await h.fn.initViewSwitch();
  h.fn.dockToSidePanel();
  await settle();
  assert.deepEqual(plain(h.toasts), [
    { msg: 'Open a browser window first — the side panel lives in one', error: true },
  ]);
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.modes, []);
});

test('a sidePanel.open that throws on the spot lands on the same refusal as one that rejects', async () => {
  for (const open of ['throw', 'reject']) {
    const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7, open });
    await h.fn.initViewSwitch();
    h.fn.dockToSidePanel();
    await settle();
    assert.equal(h.toasts.length, 1, open);
    assert.match(h.toasts[0].msg, /^Couldn't dock to the side panel — /, open);
    assert.equal(h.toasts[0].error, true);
    assert.deepEqual(h.modes, [], open);
    assert.deepEqual(h.order.filter((o) => o === 'close'), [], open);
  }
});

test('the refusal carries Chrome’s own reason, so the tester knows what happened', async () => {
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7, open: 'reject' });
  await h.fn.initViewSwitch();
  h.fn.dockToSidePanel();
  await settle();
  assert.deepEqual(plain(h.toasts), [
    { msg: "Couldn't dock to the side panel — no such window", error: true },
  ]);
});

// ---------- the click, and the teardown ----------

test('pressing the button routes to the surface this document is NOT on', async () => {
  const side = loadViewSwitch({ inPanelWindow: false });
  await side.fn.initViewSwitch();
  fire(side.btn, 'click');
  await settle();
  assert.deepEqual(plain(side.sent), [{ type: 'VIEW_OPEN_WINDOW' }]);
  assert.deepEqual(side.opens, []);

  const window = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  await window.fn.initViewSwitch();
  fire(window.btn, 'click');
  await settle();
  assert.deepEqual(plain(window.opens), [{ windowId: 7 }]);
  assert.deepEqual(window.sent, []);
});

test('17b (#350): a click landing before boot has finished opens no second window', async () => {
  // app.js:53 calls initViewSwitch() without awaiting it, so the press can land a whole await before
  // the surface is known — and a surface nobody has answered for must take no branch at all.
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: 7 });
  const booting = h.fn.initViewSwitch();  // started, not awaited
  fire(h.btn, 'click');                   // the tester is fast, or the storage read is slow
  await settle();
  assert.deepEqual(h.sent, [], 'a dock must never open a window');
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.modes, []);
  // …and the press that comes a heartbeat later still docks: the button is asleep, not dead.
  await booting;
  fire(h.btn, 'click');
  await settle();
  assert.deepEqual(plain(h.opens), [{ windowId: 7 }]);
  assert.deepEqual(h.sent, []);
});

// The narrower half of the same race: the surface IS known by now, but the window to dock into is
// not. Wiring the press anywhere before the last await trades the second window for a dock that
// answers "Open a browser window first" — still wrong, and still only under a fast finger.
test('17c (#350): the press stays asleep until the window to dock into is known too', async () => {
  let letItFinish;
  const pending = new Promise((resolve) => { letItFinish = () => resolve(7); });
  const h = loadViewSwitch({ inPanelWindow: true, normalWindowId: pending });
  const booting = h.fn.initViewSwitch();
  await settle(); // the surface has been answered for; the window id has not
  assert.equal(h.asked.normalWindowId, 1, 'boot is parked on the second question, not the first');
  fire(h.btn, 'click');
  await settle();
  assert.deepEqual(h.opens, [], 'no dock');
  assert.deepEqual(h.toasts, [], 'and no "Open a browser window first" aimed at a tester already in one');
  assert.deepEqual(h.sent, []);

  letItFinish();
  await booting;
  fire(h.btn, 'click');
  await settle();
  assert.deepEqual(plain(h.opens), [{ windowId: 7 }]);
});

test('a window that refuses to close does not take the switch down with it', async () => {
  const h = loadViewSwitch({ closeThrows: true, answer: { ok: true } });
  await h.fn.initViewSwitch();
  await h.fn.openInWindow();
  assert.deepEqual(h.order, ['setMode:window', 'close']);
  assert.deepEqual(h.toasts, []);
});

test('closing the surface is closing the document — there is no sidePanel.close', async () => {
  const h = loadViewSwitch();
  h.fn.closeSurface();
  assert.deepEqual(h.order, ['close']);
});
