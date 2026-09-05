#!/usr/bin/env node
// extension/shared/panel-link.js (#178): the line an open panel keeps to the service worker, so the
// worker knows a panel is on screen and which browser window holds it — that is how a screen
// recording is stopped when the tester closes the last panel. Chrome tears the worker down whenever
// it likes, so the line drops constantly and this file redials.
// Both ways of getting the redial wrong are silent. A loop with no brake burns the tester's CPU
// against an API that is gone; a redial that never fires leaves a panel that looks fine and has
// quietly stopped talking, so the recording never stops. And the two ports are not
// interchangeable — 'panel' is the toolbar-icon surface alone, 'panel-doc' is any live panel
// document — so a document that opens the wrong one makes two surfaces claim to be the same one.
// Run: node --test tests/panel-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle } from './helpers/shared-harness.mjs';

const PANEL = '/sidepanel/index.html';
const EDITOR = '/editor/editor.html';

// A hand-rolled timer queue, never the realm's: the redial is 1000 ms away and every row about it is
// an assertion on WHAT IS IN THE QUEUE, which a real wait could only turn into a slow, flaky guess.
function loadPanelLink(opts = {}) {
  const {
    pathname = PANEL,
    noConnect = false,
    connectThrows = false,
    postThrows = false,
    tabs = 'panel',      // 'panel' | 'tab' | 'reject' | 'absent' | 'no-getcurrent'
    current = { id: 12 },// windows.getCurrent(); an Error value rejects
    noChrome = false,
  } = opts;

  // `id` is read through `in`, not a default: `{ id: undefined }` IS the case, and a default
  // parameter would silently hand the dead-context row a live runtime id.
  const s = { id: 'id' in opts ? opts.id : 'abcdefghij', connectThrows, postThrows };
  const ports = [];
  const timers = [];
  let lastErrorReads = 0;

  const makePort = (name) => {
    const listeners = [];
    const port = {
      name,
      posts: [],
      onDisconnect: { addListener: (fn) => listeners.push(fn) },
      postMessage(msg) {
        port.posts.push(msg);
        if (s.postThrows) throw new Error('Attempting to use a disconnected port object');
      },
      // What Chrome does when the worker goes idle.
      drop: () => listeners.forEach((fn) => fn()),
    };
    ports.push(port);
    return port;
  };

  const runtime = {
    get id() { return s.id; },
    get lastError() { lastErrorReads += 1; return undefined; },
  };
  if (!noConnect) {
    runtime.connect = ({ name }) => {
      if (s.connectThrows) throw new Error('Could not establish connection');
      return makePort(name);
    };
  }

  const chrome = {
    runtime,
    windows: {
      async getCurrent() {
        if (current instanceof Error) throw current;
        return current;
      },
    },
  };
  if (tabs === 'panel') chrome.tabs = { getCurrent: async () => undefined };
  if (tabs === 'tab') chrome.tabs = { getCurrent: async () => ({ id: 1 }) };
  if (tabs === 'reject') chrome.tabs = { getCurrent: async () => { throw new Error('no tab'); } };
  if (tabs === 'no-getcurrent') chrome.tabs = {};

  const sandbox = {
    location: { pathname },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  if (!noChrome) sandbox.chrome = chrome;

  const { value } = loadInto(sandbox, [['shared/panel-link.js', 'PanelLink']]);
  return {
    link: value,
    ports,
    timers,
    state: s,
    names: () => ports.map((p) => p.name),
    countOf: (name) => ports.filter((p) => p.name === name).length,
    portsOf: (name) => ports.filter((p) => p.name === name),
    reads: () => lastErrorReads,
    // Fire every queued redial once, the way 1000 ms of real waiting would.
    run: () => { const due = timers.splice(0); due.forEach((t) => t.fn()); },
  };
}

// ---------- a context that is gone, or an API that never was ----------

test('an extension reloaded under an open panel does not dial a runtime that is gone', async () => {
  const h = loadPanelLink({ id: undefined });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), []);
  assert.equal(h.link.connected(), false);
});

test('a page without chrome.runtime.connect returns from init instead of throwing', async () => {
  const h = loadPanelLink({ noConnect: true });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), []);
});

test('a page with no chrome object at all loads and inits quietly', async () => {
  const h = loadPanelLink({ noChrome: true });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), []);
  assert.equal(h.link.connected(), false);
});

// ---------- which surface opens which port ----------

test('the side panel registers as both a live panel document and the toolbar surface', async () => {
  const h = loadPanelLink({ tabs: 'panel' });
  h.link.init();
  assert.deepEqual(h.names(), ['panel-doc']); // the doc port needs no promise, so it is first
  await settle();
  assert.deepEqual(h.names(), ['panel-doc', 'panel']);
  assert.equal(h.link.connected(), true);
});

test('the editor keeps the toolbar port but is no panel surface, so it skips panel-doc', async () => {
  const h = loadPanelLink({ pathname: EDITOR, tabs: 'panel' });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), ['panel']);
  assert.equal(h.link.connected(), true);
});

test('the panel opened in a tab is a live panel document, but not the toolbar surface', async () => {
  const h = loadPanelLink({ tabs: 'tab' });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), ['panel-doc']);
  assert.equal(h.link.connected(), false);
});

test('a browser with no tabs API is treated as not-a-tab rather than left unregistered', async () => {
  for (const tabs of ['absent', 'no-getcurrent']) {
    const h = loadPanelLink({ tabs });
    h.link.init();
    await settle();
    assert.deepEqual(h.names(), ['panel-doc', 'panel'], tabs);
  }
});

test('a tab lookup that rejects is treated the same way — the surface still registers', async () => {
  const h = loadPanelLink({ tabs: 'reject' });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), ['panel-doc', 'panel']);
});

test('a document that boots twice keeps one port per name, not two', async () => {
  const h = loadPanelLink();
  h.link.init();
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), ['panel-doc', 'panel']);
});

// ---------- the hello that tells the worker which window this is ----------

test('a fresh toolbar port announces the window it sits in, because a panel sender has none', async () => {
  const h = loadPanelLink({ current: { id: 12 } });
  h.link.init();
  await settle();
  assert.deepEqual(plain(h.portsOf('panel')[0].posts), [{ type: 'PANEL_HELLO', windowId: 12 }]);
  assert.deepEqual(plain(h.portsOf('panel-doc')[0].posts), []); // only the surface port says hello
});

test('a window lookup that fails still says hello, with no window id', async () => {
  for (const current of [new Error('no current window'), null, {}]) {
    const h = loadPanelLink({ current });
    h.link.init();
    await settle();
    assert.deepEqual(plain(h.portsOf('panel')[0].posts), [{ type: 'PANEL_HELLO', windowId: null }]);
  }
});

test('a hello that races the disconnect it was answering leaves no unhandled rejection', async () => {
  const caught = [];
  const onRejection = (e) => caught.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const h = loadPanelLink({ postThrows: true });
    h.link.init();
    await settle(4);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(caught.map(String), []);
});

test('every redial says hello again — a warm worker still learns the window', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  h.portsOf('panel')[0].drop();
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 2);
  assert.deepEqual(plain(h.portsOf('panel')[1].posts), [{ type: 'PANEL_HELLO', windowId: 12 }]);
});

// ---------- the redial ----------

test('a connect that throws leaves no port and books a retry a second out', async () => {
  const h = loadPanelLink({ connectThrows: true });
  h.link.init();
  await settle();
  assert.deepEqual(h.names(), []);
  assert.equal(h.link.connected(), false);
  assert.deepEqual(h.timers.map((t) => t.ms), [1000, 1000]); // one per port, both still trying
  h.state.connectThrows = false;
  h.run();
  await settle();
  assert.deepEqual(h.names(), ['panel-doc', 'panel']);
  assert.equal(h.link.connected(), true);
});

test('the worker going idle drops the port, silences the error and books one retry', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  const before = h.reads();
  h.portsOf('panel')[0].drop();
  assert.equal(h.link.connected(), false);
  assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  assert.ok(h.reads() > before, 'chrome.runtime.lastError must be read, or Chrome logs it');
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 2);
  assert.equal(h.link.connected(), true);
});

test('two drops inside one retry window arm one timer, not two', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  const port = h.portsOf('panel')[0];
  port.drop();
  port.drop();
  assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 2); // one redial, not one per drop
});

test('a dead port’s late goodbye must not tear down the live one that replaced it', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  const stale = h.portsOf('panel')[0];
  stale.drop();
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 2);

  stale.drop(); // Chrome delivering the old port's disconnect after the new one is up
  assert.equal(h.link.connected(), true, 'the live port stays');
  assert.deepEqual(h.timers.map((t) => t.ms), [1000], 'a retry is still booked');
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 2, 'and it finds a port already open, so it does nothing');
});

test('a disconnect after the extension was reloaded stops the loop dead', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  h.state.id = undefined; // the tell that this page's `chrome` is a corpse
  h.portsOf('panel')[0].drop();
  assert.deepEqual(h.timers, [], 'an empty queue is the only proof the loop stopped');
  assert.equal(h.link.connected(), false);
});

test('a redial that fires after the reload does not reconnect either', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  h.portsOf('panel')[0].drop();
  assert.equal(h.timers.length, 1);
  h.state.id = undefined;
  h.run();
  await settle();
  assert.equal(h.countOf('panel'), 1);
  assert.deepEqual(h.timers, []);
});

test('the panel-doc port redials on its own, so a closed panel is still noticed', async () => {
  const h = loadPanelLink();
  h.link.init();
  await settle();
  h.portsOf('panel-doc')[0].drop();
  assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  h.run();
  await settle();
  assert.equal(h.countOf('panel-doc'), 2);
  assert.equal(h.countOf('panel'), 1); // the other dialer was not disturbed
});

// ---------- what a caller can ask ----------

test('the panel reports no line to the worker until init has actually dialled one', async () => {
  const h = loadPanelLink();
  assert.equal(h.link.connected(), false);
  h.link.init();
  assert.equal(h.link.connected(), false, 'the tab check has not settled yet');
  await settle();
  assert.equal(h.link.connected(), true);
});

test('the module publishes only init and connected — nothing else is anyone’s business', () => {
  const h = loadPanelLink();
  assert.deepEqual(Object.keys(h.link).sort(), ['connected', 'init']);
});
