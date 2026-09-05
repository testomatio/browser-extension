#!/usr/bin/env node
// extension/shared/view-mode.js (#182): which surface the panel is on, and which browser window a
// screenshot or a screen recording is aimed at. Getting the second one wrong is silent — the tester
// presses Capture and photographs the wrong screen, or stops a recording that was never theirs.
// This file is loaded TWICE per browser: once as a panel script and once into the service worker
// (background.js:8 importScripts), so every sandbox here is worker-shaped — no `document`, no
// `window`, nothing but `chrome`. A reference to either would throw in the worker and take the
// panel surface down with it.
// Run: node --test tests/view-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, chromeFake, plain } from './helpers/shared-harness.mjs';

const NORMAL_KEY = 'viewNormalWindowId';
const PANEL_KEY = 'viewPanelWindowId';

// One load per case: `ViewMode` is an IIFE and its `chrome` is captured by the context, not passed.
// The sandbox holds `chrome` ALONE — that absence is the worker contract, asserted by every row.
function loadViewMode(opts = {}) {
  const {
    local = {}, session = {}, localFail = {}, sessionFail = {},
    all = [],            // what windows.getAll() answers
    win = null,          // (id) => a window record, or undefined to make windows.get reject
    getAllFail = false,
    current = null,      // windows.getCurrent()'s answer; an Error value rejects
    noChrome = false,
  } = opts;

  const h = chromeFake({ local, session, localFail, sessionFail });
  const calls = { get: [], getAll: 0, getCurrent: 0 };
  h.chrome.windows = {
    async get(id) {
      calls.get.push(id);
      const found = win ? win(id) : undefined;
      if (!found) throw new Error(`no window ${id}`);
      return { ...found };
    },
    async getAll() {
      calls.getAll += 1;
      if (getAllFail) throw new Error('windows.getAll failed');
      return all.map((w) => ({ ...w }));
    },
    async getCurrent() {
      calls.getCurrent += 1;
      if (current instanceof Error) throw current;
      return current;
    },
  };

  const sandbox = noChrome ? {} : { chrome: h.chrome };
  const { value } = loadInto(sandbox, [['shared/view-mode.js', 'ViewMode']]);
  return { vm: value, h, calls, sandbox };
}

// ---------- the remembered choice ----------

test('the tester who chose the free-floating window is still in it next time', async () => {
  const { vm } = loadViewMode({ local: { viewMode: 'window' } });
  assert.equal(await vm.mode(), 'window');
});

test('a first run, and a mode an older build left behind, both mean the side panel', async () => {
  assert.equal(await loadViewMode().vm.mode(), 'sidepanel');
  assert.equal(await loadViewMode({ local: { viewMode: 'tab' } }).vm.mode(), 'sidepanel');
  assert.equal(await loadViewMode({ local: { viewMode: '' } }).vm.mode(), 'sidepanel');
  assert.equal(await loadViewMode({ local: { viewMode: null } }).vm.mode(), 'sidepanel');
});

test('storage that will not answer leaves the tester in the side panel rather than nowhere', async () => {
  const { vm } = loadViewMode({ local: { viewMode: 'window' }, localFail: { get: true } });
  assert.equal(await vm.mode(), 'sidepanel');
});

test('a page with no chrome API at all still reads a mode instead of throwing', async () => {
  const { vm } = loadViewMode({ noChrome: true });
  assert.equal(await vm.mode(), 'sidepanel');
  await vm.setMode('window'); // and the write path is just as quiet
});

test('a junk mode is clamped on the way IN, so nothing unreadable is ever stored', async () => {
  const { vm, h } = loadViewMode();
  await vm.setMode('junk');
  assert.deepEqual(plain(h.local.sets), [{ viewMode: 'sidepanel' }]);
  assert.equal(h.local.data.viewMode, 'sidepanel');
});

test('the chosen surface is written through unchanged', async () => {
  const { vm, h } = loadViewMode();
  await vm.setMode('window');
  assert.deepEqual(plain(h.local.sets), [{ viewMode: 'window' }]);
});

test('a write that fails is swallowed — the switch already happened on screen', async () => {
  const { vm, h } = loadViewMode({ localFail: { set: true } });
  await vm.setMode('window'); // must resolve, not reject
  assert.deepEqual(plain(h.local.sets), [{ viewMode: 'window' }]);
});

// ---------- window ids, which mean nothing after a restart ----------

test('only a real integer window id is remembered — 3.5, "3" and null are dropped', async () => {
  const { vm, h } = loadViewMode();
  await vm.rememberNormalWindow(3.5);
  await vm.rememberNormalWindow('3');
  await vm.rememberNormalWindow(null);
  await vm.rememberNormalWindow(undefined);
  await vm.rememberPanelWindow(2.5);
  assert.deepEqual(plain(h.session.sets), []);
});

test('an integer id is written under the key the worker and the panel both read', async () => {
  const { vm, h } = loadViewMode();
  await vm.rememberNormalWindow(3);
  await vm.rememberPanelWindow(8);
  assert.deepEqual(plain(h.session.sets), [{ [NORMAL_KEY]: 3 }, { [PANEL_KEY]: 8 }]);
});

test('an id that came back from storage as a string is no id at all', async () => {
  const { vm } = loadViewMode({ session: { [PANEL_KEY]: '7' } });
  assert.equal(await vm.panelWindowId(), null);
});

test('a session store that throws yields no id rather than a broken one', async () => {
  const { vm } = loadViewMode({ session: { [PANEL_KEY]: 7 }, sessionFail: { get: true } });
  assert.equal(await vm.panelWindowId(), null);
});

test('the panel window Chrome just closed is the one that gets forgotten', async () => {
  const { vm, h } = loadViewMode({ session: { [PANEL_KEY]: 9 } });
  await vm.forgetPanelWindow(9);
  assert.deepEqual(plain(h.session.removes), [PANEL_KEY]);
  assert.equal(PANEL_KEY in h.session.data, false);
});

test('a stale close notice must not drop the panel window that is still open', async () => {
  const { vm, h } = loadViewMode({ session: { [PANEL_KEY]: 4 } });
  await vm.forgetPanelWindow(9);
  assert.deepEqual(plain(h.session.removes), []);
  assert.equal(h.session.data[PANEL_KEY], 4);
});

test('a remove that throws is swallowed — the fallbacks still answer', async () => {
  const { vm } = loadViewMode({ session: { [PANEL_KEY]: 9 }, sessionFail: { remove: true } });
  await vm.forgetPanelWindow(9);
});

// ---------- which window the SITE is in ----------

test('the tracked window is handed straight back, and no window list is walked', async () => {
  const { vm, calls } = loadViewMode({
    session: { [NORMAL_KEY]: 5 },
    win: () => ({ id: 5, type: 'normal' }),
  });
  assert.equal(await vm.normalWindowId(), 5);
  assert.deepEqual(calls.get, [5]);
  assert.equal(calls.getAll, 0);
});

test('a tracked window the tester has since closed falls through to the live list', async () => {
  const { vm, calls } = loadViewMode({
    session: { [NORMAL_KEY]: 5 },
    win: () => undefined, // windows.get rejects, the way a closed id does
    all: [{ id: 2, type: 'normal' }],
  });
  assert.equal(await vm.normalWindowId(), 2);
  assert.equal(calls.getAll, 1);
});

test('a tracked id that turns out to be a popup is OUR panel, never the site', async () => {
  const { vm, calls } = loadViewMode({
    session: { [NORMAL_KEY]: 5 },
    win: () => ({ id: 5, type: 'popup' }),
    all: [{ id: 2, type: 'normal' }],
  });
  assert.equal(await vm.normalWindowId(), 2);
  assert.equal(calls.getAll, 1);
});

test('with nothing tracked, the focused NORMAL window wins over a focused popup', async () => {
  const { vm } = loadViewMode({
    all: [
      { id: 1, type: 'normal' },
      { id: 2, type: 'popup', focused: true },
      { id: 3, type: 'normal', focused: true },
    ],
  });
  assert.equal(await vm.normalWindowId(), 3);
});

test('with nothing focused, the newest normal window is the tester’s best guess', async () => {
  const { vm } = loadViewMode({
    all: [{ id: 1, type: 'normal' }, { id: 2, type: 'popup' }, { id: 3, type: 'normal' }],
  });
  assert.equal(await vm.normalWindowId(), 3);
});

test('a browser showing only our own popups has no site window to aim at', async () => {
  assert.equal(await loadViewMode({ all: [] }).vm.normalWindowId(), null);
  assert.equal(
    await loadViewMode({ all: [{ id: 2, type: 'popup' }, { id: 4, type: 'popup' }] }).vm.normalWindowId(),
    null,
  );
});

test('a normal window with no id is no answer either', async () => {
  const { vm } = loadViewMode({ all: [{ type: 'normal' }] });
  assert.equal(await vm.normalWindowId(), null);
});

test('a window list that throws answers null instead of aiming at nothing', async () => {
  const { vm } = loadViewMode({ getAllFail: true });
  assert.equal(await vm.normalWindowId(), null);
});

// ---------- telling our own panel window apart from the tester's ----------

test('a normal window is never mistaken for the panel', async () => {
  const { vm } = loadViewMode({ session: { [PANEL_KEY]: 8 } });
  assert.equal(await vm.isPanelWindow({ type: 'normal', id: 8 }), false);
});

test('the popup whose id we recorded is the panel; another popup is not', async () => {
  const yes = loadViewMode({ session: { [PANEL_KEY]: 8 } });
  assert.equal(await yes.vm.isPanelWindow({ type: 'popup', id: 8 }), true);
  const no = loadViewMode({ session: { [PANEL_KEY]: 9 } });
  assert.equal(await no.vm.isPanelWindow({ type: 'popup', id: 8 }), false);
});

test('before the id write lands, a popup counts as ours only in window mode', async () => {
  const win = loadViewMode({ local: { viewMode: 'window' } });
  assert.equal(await win.vm.isPanelWindow({ type: 'popup', id: 8 }), true);
  const side = loadViewMode({ local: { viewMode: 'sidepanel' } });
  assert.equal(await side.vm.isPanelWindow({ type: 'popup', id: 8 }), false);
});

test('no window at all is not the panel', async () => {
  const { vm } = loadViewMode();
  assert.equal(await vm.isPanelWindow(null), false);
  assert.equal(await vm.isPanelWindow(undefined), false);
});

test('this document knows it is in the panel window by its own popup frame', async () => {
  assert.equal(await loadViewMode({ current: { id: 8, type: 'popup' } }).vm.inPanelWindow(), true);
  assert.equal(await loadViewMode({ current: { id: 1, type: 'normal' } }).vm.inPanelWindow(), false);
  assert.equal(await loadViewMode({ current: null }).vm.inPanelWindow(), false);
  assert.equal(
    await loadViewMode({ current: new Error('no current window') }).vm.inPanelWindow(),
    false,
  );
});

// ---------- the contract the rest of the extension leans on ----------

test('the panel window opens tall and narrow, because the layout is the side panel’s', () => {
  const { vm } = loadViewMode();
  assert.deepEqual(plain(vm.WINDOW_SIZE), { width: 460, height: 900 });
});

test('the keys and the panel URL are the ones the worker writes and reads', () => {
  const { vm } = loadViewMode();
  assert.equal(vm.KEY, 'viewMode');
  assert.equal(vm.NORMAL_KEY, NORMAL_KEY);
  assert.equal(vm.PANEL_KEY, PANEL_KEY);
  assert.equal(vm.PANEL_PATH, 'sidepanel/index.html');
  assert.deepEqual(plain(vm.MODES), ['sidepanel', 'window']);
  assert.equal(vm.panelUrl(), 'chrome-extension://abcdef/sidepanel/index.html');
});

test('every entry point survives a service worker: no document, no window, only chrome', async () => {
  const { vm, sandbox } = loadViewMode({
    local: { viewMode: 'window' },
    session: { [NORMAL_KEY]: 5, [PANEL_KEY]: 8 },
    win: () => ({ id: 5, type: 'normal' }),
    current: { id: 8, type: 'popup' },
  });
  assert.deepEqual(Object.keys(sandbox), ['chrome']); // the whole global the worker offers
  await Promise.all([
    vm.mode(), vm.setMode('window'), vm.rememberNormalWindow(5), vm.rememberPanelWindow(8),
    vm.panelWindowId(), vm.forgetPanelWindow(8), vm.normalWindowId(),
    vm.isPanelWindow({ type: 'popup', id: 8 }), vm.inPanelWindow(),
  ]);
});
