#!/usr/bin/env node
// #170: the file viewer drawn OVER the page under test. extension/content/file-overlay.js is
// injected on demand, mounts one shadow host, and hands the page back untouched on the way out.
// Two questions decide whether a tester ever sees a mess: is there exactly ONE of me on this page
// (a re-inject must swap the file, not stack a second window), and may a script belonging to the
// page under test close me by shouting the right message (it may not).
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInContext } from 'node:vm';
import { makeDocument, event, fire } from './helpers/mini-dom.mjs';
import { chromeFake, loadInto, sharedPath, sourceOf, settle } from './helpers/shared-harness.mjs';

const REL = 'content/file-overlay.js';
const HOST_ID = '__testomat_file_overlay';
const KEY = 'fileOverlay';
const EXT = 'chrome-extension://abcdef';
const VIEWER = `${EXT}/viewer/viewer.html`;

const FILE = { url: 'https://x.test/take.webm', name: 'a b.webm', type: 'video/webm', at: 1 };
const OTHER = { url: 'https://x.test/two.png', name: 'two.png', type: 'image/png', at: 2 };

// URLSearchParams is NOT a per-realm built-in: a vm context has none, and without this the boot
// throws inside showFile() and every row passes for the wrong reason.
const REALM = { URLSearchParams, console };

// window is a plain object here, so the listeners the file registers are the only way in. A
// registration is kept after removal (`live: false`) so a row can still call a torn-down handler.
function makeWindow() {
  const on = [];
  const cap = (o) => o === true || !!(o && o.capture);
  const win = {
    addEventListener(type, fn, opts) { on.push({ type, fn, capture: cap(opts), live: true }); },
    removeEventListener(type, fn, opts) {
      const hit = on.find((r) => r.live && r.type === type && r.fn === fn && r.capture === cap(opts));
      if (hit) hit.live = false;
    },
  };
  win.on = on;
  win.live = (type) => on.filter((r) => r.live && r.type === type);
  return win;
}

function load(opts = {}) {
  const {
    session = { [KEY]: FILE },
    sessionFail = {},
    overflow = 'scroll',
    onChanged = true,
    storage = true,
  } = opts;

  const doc = makeDocument();
  doc.documentElement.style.overflow = overflow;
  const create = doc.createElement.bind(doc);
  const frames = [];
  doc.createElement = (tag) => {
    const node = create(tag);
    // Only a real <iframe> has a contentWindow, and that identity is the whole message guard.
    if (String(tag).toLowerCase() === 'iframe') {
      node.contentWindow = { frame: frames.length };
      frames.push(node);
    }
    return node;
  };

  const ch = chromeFake({ session, sessionFail });
  const changed = [];
  if (onChanged) {
    ch.chrome.storage.onChanged = {
      addListener: (fn) => { changed.push(fn); },
      removeListener: (fn) => { const i = changed.indexOf(fn); if (i >= 0) changed.splice(i, 1); },
    };
  }
  if (!storage) delete ch.chrome.storage.session;

  const win = makeWindow();
  const sandbox = { window: win, document: doc, chrome: ch.chrome, ...REALM };
  const { context } = loadInto(sandbox, [REL]);

  const hosts = () => doc.querySelectorAll(`#${HOST_ID}`);
  const host = () => hosts()[0] || null;
  const part = (sel) => (host() ? host().shadowRoot.querySelector(sel) : null);
  return {
    doc,
    win,
    ch,
    changed,
    context,
    hosts,
    host,
    frames,
    iframe: () => frames[frames.length - 1],
    backdrop: () => part('.backdrop'),
    frame: () => part('.frame'),
    closeBtn: () => part('.close'),
    overflow: () => doc.documentElement.style.overflow,
    // A second executeScript of the same file into the same page — what a re-inject really is.
    reinject: () => runInContext(sourceOf(sharedPath(REL)), context, { filename: sharedPath(REL) }),
    esc: () => { const ev = event(null, 'keydown', { key: 'Escape' }); win.live('keydown')[0].fn(ev); return ev; },
    post: (source, data) => win.live('message')[0].fn({ source, data }),
    swap: (changes, area) => changed[0](changes, area),
  };
}

// ---- one overlay per page ---------------------------------------------------

test('1: the panel opens the same file twice and the tester still sees one window, not two', async () => {
  const h = load();
  await settle();
  assert.equal(h.hosts().length, 1);
  const first = h.host();

  h.reinject();
  await settle();
  assert.equal(h.hosts().length, 1, 'a re-inject over a standing overlay must be a no-op');
  assert.equal(h.host(), first, 'the very same host, not a rebuilt one');
  assert.equal(h.win.live('keydown').length, 1, 'and no second set of listeners');
  assert.equal(h.win.live('message').length, 1);
  assert.equal(h.changed.length, 1);
});

test('2: the page tore our host out, so the next open builds a fresh overlay', async () => {
  const h = load();
  await settle();
  const first = h.host();
  first.remove(); // a hostile page (or a framework re-render) wiped the node
  assert.equal(h.doc.getElementById(HOST_ID), null);

  h.reinject();
  await settle();
  assert.equal(h.hosts().length, 1);
  assert.notEqual(h.host(), first, 'the flag alone must not block the rebuild');
});

test('2b: a page with no storage.session gets no overlay at all', async () => {
  const h = load({ storage: false });
  await settle();
  assert.equal(h.hosts().length, 0);
  assert.equal(h.win.__testomatFileOverlayInited, undefined, 'the flag is not claimed on a bail-out');
});

// ---- the viewer URL ---------------------------------------------------------

test('3: a take with a space in its name reaches the viewer with the name intact', async () => {
  const h = load();
  await settle();
  assert.equal(
    h.iframe().src,
    `${VIEWER}?url=https%3A%2F%2Fx.test%2Ftake.webm&name=a+b.webm&type=video%2Fwebm`,
  );
});

test('3b: a file with no name or type still opens, on the url alone', async () => {
  const h = load({ session: { [KEY]: { url: 'https://x.test/f' } } });
  await settle();
  assert.equal(h.iframe().src, `${VIEWER}?url=https%3A%2F%2Fx.test%2Ff&name=&type=`);
});

test('4: the key is empty, so nothing is left on screen for the tester to close', async () => {
  const h = load({ session: {} });
  await settle();
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll', 'and the page scrolls again');
  assert.equal(h.win.__testomatFileOverlayInited, false);
});

test('4b: a record with no url is treated as no file at all', async () => {
  const h = load({ session: { [KEY]: { name: 'x.png' } } });
  await settle();
  assert.equal(h.hosts().length, 0);
});

test('5: the session store is unreachable and the overlay clears itself away', async () => {
  const h = load({ sessionFail: { get: true } });
  await settle();
  assert.equal(h.hosts().length, 0, 'no orphaned host');
  assert.equal(h.overflow(), 'scroll');
  assert.equal(h.win.live('keydown').length, 0);
  assert.equal(h.win.live('message').length, 0);
  assert.equal(h.changed.length, 0);
});

// ---- clicking another file in the panel --------------------------------------

test('6: clicking another file in the panel swaps this window instead of stacking a second', async () => {
  const h = load();
  await settle();
  const before = h.iframe();
  h.swap({ [KEY]: { newValue: OTHER } }, 'session');
  assert.equal(h.hosts().length, 1, 'still one overlay');
  assert.equal(h.iframe(), before, 'the same iframe, re-pointed');
  assert.equal(before.src, `${VIEWER}?url=https%3A%2F%2Fx.test%2Ftwo.png&name=two.png&type=image%2Fpng`);
});

test('7: the same key changing in local storage is none of this overlay’s business', async () => {
  const h = load();
  await settle();
  const src = h.iframe().src;
  h.swap({ [KEY]: { newValue: OTHER } }, 'local');
  assert.equal(h.iframe().src, src, 'a local write must not repoint the viewer');
  assert.equal(h.hosts().length, 1);
});

test('7b: some other session key changing leaves the shown file alone', async () => {
  const h = load();
  await settle();
  const src = h.iframe().src;
  h.swap({ screenRecFile: { newValue: OTHER } }, 'session');
  assert.equal(h.iframe().src, src);
});

// ---- who may close it -------------------------------------------------------

test('8: a script on the page under test cannot close the overlay by shouting the right message', async () => {
  const h = load();
  await settle();
  h.post({ hostile: true }, { type: 'TESTOMAT_VIEWER_CLOSE' });
  assert.equal(h.hosts().length, 1, 'only our own iframe may ask');
  assert.equal(h.overflow(), 'hidden');
});

test('8b: a message with no data at all is ignored rather than thrown on', async () => {
  const h = load();
  await settle();
  h.post(h.iframe().contentWindow, null);
  h.post(h.iframe().contentWindow, { type: 'SOMETHING_ELSE' });
  assert.equal(h.hosts().length, 1);
});

test('9: Escape pressed inside the viewer closes the overlay', async () => {
  const h = load();
  await settle();
  h.post(h.iframe().contentWindow, { type: 'TESTOMAT_VIEWER_CLOSE' });
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll');
});

test('10: Escape closes the overlay and the page under test never sees the key', async () => {
  const h = load();
  await settle();
  const ev = h.esc();
  assert.equal(ev.propagationStopped, true, 'the page must not also act on this Escape');
  assert.equal(h.hosts().length, 0);
});

test('10b: any other key is left for the page under test', async () => {
  const h = load();
  await settle();
  const ev = event(null, 'keydown', { key: 'k' });
  h.win.live('keydown')[0].fn(ev);
  assert.equal(ev.propagationStopped, false);
  assert.equal(h.hosts().length, 1);
});

test('11: a click on the dark backdrop closes it, a click on the file itself does not', async () => {
  const inside = load();
  await settle();
  fire(inside.backdrop(), 'click', { target: inside.frame() });
  assert.equal(inside.hosts().length, 1, 'clicking the file must not throw the viewer away');

  const outside = load();
  await settle();
  fire(outside.backdrop(), 'click', { target: outside.backdrop() });
  assert.equal(outside.hosts().length, 0);
});

test('11b: the ✕ closes it', async () => {
  const h = load();
  await settle();
  fire(h.closeBtn(), 'click');
  assert.equal(h.hosts().length, 0);
});

// ---- handing the page back --------------------------------------------------

test('12: closing hands the page back exactly as it was found', async () => {
  const h = load({ overflow: 'scroll' });
  await settle();
  assert.equal(h.overflow(), 'hidden', 'the page behind is locked while the viewer stands');
  h.esc();
  assert.equal(h.overflow(), 'scroll', 'the page’s own overflow, not an empty string');
  assert.equal(h.hosts().length, 0);
  assert.equal(h.win.live('keydown').length, 0, 'the capture keydown listener is gone');
  assert.equal(h.win.live('message').length, 0);
  assert.equal(h.changed.length, 0, 'and the storage listener with it');
  assert.equal(h.win.__testomatFileOverlayInited, false, 'so the next open builds again');
});

test('12b: a page that set no overflow of its own gets an empty one back, not “hidden”', async () => {
  const h = load({ overflow: '' });
  await settle();
  h.esc();
  assert.equal(h.overflow(), '');
});

test('13: a second Escape after it is already closed changes nothing', async () => {
  const h = load();
  await settle();
  h.esc();
  h.doc.documentElement.style.overflow = 'auto'; // the page moved on after the overlay left
  const again = event(null, 'keydown', { key: 'Escape' });
  h.win.on.find((r) => r.type === 'keydown').fn(again);
  assert.equal(h.overflow(), 'auto', 'a torn-down overlay must not restore overflow a second time');
  assert.equal(again.propagationStopped, true);
});

test('14: a browser with no storage.onChanged still opens and still closes', async () => {
  const h = load({ onChanged: false });
  await settle();
  assert.equal(h.hosts().length, 1);
  assert.equal(h.iframe().src.startsWith(`${VIEWER}?url=`), true);
  h.esc();
  assert.equal(h.hosts().length, 0, 'teardown must survive the missing listener too');
  assert.equal(h.overflow(), 'scroll');
});

// viewer/viewer.html is web_accessible to <all_urls> under a pinned "key" (manifest.json:38-43, 53)
// and with no use_dynamic_url, so any site can frame it and read whatever url it is handed.
test.todo('15 (#105): a page under test cannot frame viewer.html on its own');
