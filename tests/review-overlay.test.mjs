#!/usr/bin/env node
// #171: the recording review drawn OVER the page under test. extension/content/review-overlay.js
// frames screenrec/review.html so the tester can watch the take, trim it and attach it. Esc, the ✕
// and the dark backdrop all close it — with one exception that cost a shipped fix: while a trim is
// exporting, closing would throw minutes of the tester's work away, so it refuses. That refusal,
// and "only our own frame may ask us to close", are what the rows below hold down.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInContext } from 'node:vm';
import { makeDocument, event, fire } from './helpers/mini-dom.mjs';
import { chromeFake, loadInto, sharedPath, sourceOf } from './helpers/shared-harness.mjs';

const REL = 'content/review-overlay.js';
const HOST_ID = '__testomat_review_overlay';
const EXT = 'chrome-extension://abcdef';

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
  const { overflow = 'scroll', runtime = true } = opts;

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

  const ch = chromeFake();
  if (!runtime) delete ch.chrome.runtime;

  const win = makeWindow();
  // There is no setTimeout in a vm realm: the wait the overlay gives the frame is run by hand.
  const timers = [];
  const sandbox = {
    window: win,
    document: doc,
    chrome: ch.chrome,
    console,
    setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }),
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.live = false; },
  };
  const { context } = loadInto(sandbox, [REL]);

  const hosts = () => doc.querySelectorAll(`#${HOST_ID}`);
  const host = () => hosts()[0] || null;
  const part = (sel) => (host() ? host().shadowRoot.querySelector(sel) : null);
  const iframe = () => frames[frames.length - 1];
  const post = (source, data) => win.live('message')[0].fn({ source, data });
  return {
    doc,
    win,
    hosts,
    host,
    iframe,
    backdrop: () => part('.backdrop'),
    frame: () => part('.frame'),
    closeBtn: () => part('.close'),
    overflow: () => doc.documentElement.style.overflow,
    reinject: () => runInContext(sourceOf(sharedPath(REL)), context, { filename: sharedPath(REL) }),
    esc: () => { const ev = event(null, 'keydown', { key: 'Escape' }); win.live('keydown')[0].fn(ev); return ev; },
    post,
    // What review.js posts up while the export replays the take in real time.
    setBusy: (busy) => post(iframe().contentWindow, { type: 'TESTOMAT_REVIEW_BUSY', busy }),
    fromFrame: (data) => post(iframe().contentWindow, data),
    timers,
    stall: () => part('.stall'),
    stallLink: () => part('.stall a'),
    // The wait the overlay gives the frame runs out with the frame still silent.
    waitOut: () => { for (const t of timers) if (t.live) { t.live = false; t.fn(); } },
  };
}

// ---- the trim survives every reflex way out ---------------------------------

test('1: a reflex Escape during a trim export does not throw the tester’s take away', () => {
  const h = load();
  h.setBusy(true);
  assert.equal(h.hosts().length, 1, 'still up, so the export can keep replaying');
  h.esc();
  assert.equal(h.hosts().length, 1, 'Escape must not kill an export in flight');
  assert.equal(h.overflow(), 'hidden');
  assert.equal(h.win.live('message').length, 1, 'and the frame can still talk to us');
});

test('2: a reflex click on the backdrop during a trim export does not close it either', () => {
  const h = load();
  h.setBusy(true);
  fire(h.backdrop(), 'click', { target: h.backdrop() });
  assert.equal(h.hosts().length, 1);
});

test('2b: the ✕ during a trim export refuses too', () => {
  const h = load();
  h.setBusy(true);
  fire(h.closeBtn(), 'click');
  assert.equal(h.hosts().length, 1);
});

test('2c: the frame’s own close request during an export is refused as well', () => {
  const h = load();
  h.setBusy(true);
  h.fromFrame({ type: 'TESTOMAT_REVIEW_CLOSE' });
  assert.equal(h.hosts().length, 1, 'the export owns the window until it says otherwise');
});

test('3: the export finishes, and now Escape closes the review as it always did', () => {
  const h = load();
  h.setBusy(true);
  h.esc();
  assert.equal(h.hosts().length, 1, 'still refusing while busy');
  h.setBusy(false);
  assert.equal(h.hosts().length, 1, 'the end of the export does not itself close anything');
  h.esc();
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll');
});

test('3b: a busy message with a missing flag is read as “not busy”', () => {
  const h = load();
  h.fromFrame({ type: 'TESTOMAT_REVIEW_BUSY' });
  h.esc();
  assert.equal(h.hosts().length, 0);
});

// ---- who may close it -------------------------------------------------------

test('4: the review page says it is done and the overlay goes away', () => {
  const h = load();
  h.fromFrame({ type: 'TESTOMAT_REVIEW_CLOSE' });
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll');
});

test('5: a script on the page under test cannot close the review by shouting the right message', () => {
  const h = load();
  h.post({ hostile: true }, { type: 'TESTOMAT_REVIEW_CLOSE' });
  assert.equal(h.hosts().length, 1, 'only our own iframe may ask');
});

test('5b: nor can it pin the review open by faking a busy export', () => {
  const h = load();
  h.post({ hostile: true }, { type: 'TESTOMAT_REVIEW_BUSY', busy: true });
  h.esc();
  assert.equal(h.hosts().length, 0, 'a page script must not be able to jam the ✕');
});

test('6: a message carrying no data is ignored rather than thrown on', () => {
  const h = load();
  h.fromFrame(null);
  h.fromFrame(undefined);
  h.fromFrame({ type: 'SOMETHING_ELSE' });
  assert.equal(h.hosts().length, 1);
  h.esc();
  assert.equal(h.hosts().length, 0);
});

// ---- one overlay per page ---------------------------------------------------

test('7: a second recording review on the same page reuses the window already up', () => {
  const h = load();
  const first = h.host();
  h.reinject();
  assert.equal(h.hosts().length, 1, 'one review window, not two stacked');
  assert.equal(h.host(), first);
  assert.equal(h.win.live('keydown').length, 1, 'and no second set of listeners');
  assert.equal(h.win.live('message').length, 1);
});

test('7b: the page tore our host out, so the next review builds a fresh one', () => {
  const h = load();
  const first = h.host();
  first.remove();
  h.reinject();
  assert.equal(h.hosts().length, 1);
  assert.notEqual(h.host(), first, 'the flag alone must not block the rebuild');
});

test('7c: a context with no chrome.runtime puts nothing on the page', () => {
  const h = load({ runtime: false });
  assert.equal(h.hosts().length, 0);
  assert.equal(h.win.__testomatReviewOverlayInited, undefined);
});

// ---- handing the page back --------------------------------------------------

test('8: closing hands the page back exactly as it was found', () => {
  const h = load({ overflow: 'scroll' });
  assert.equal(h.overflow(), 'hidden', 'the page behind is locked while the review stands');
  assert.equal(h.iframe().src, `${EXT}/screenrec/review.html`);
  h.esc();
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll', 'the page’s own overflow, not an empty string');
  assert.equal(h.win.live('keydown').length, 0, 'the capture keydown listener is gone');
  assert.equal(h.win.live('message').length, 0);
  assert.equal(h.win.__testomatReviewOverlayInited, false, 'so the next review builds again');
});

test('8b: a second Escape after it is already closed changes nothing', () => {
  const h = load();
  h.esc();
  h.doc.documentElement.style.overflow = 'auto'; // the page moved on after the review left
  const again = event(null, 'keydown', { key: 'Escape' });
  h.win.on.find((r) => r.type === 'keydown').fn(again);
  assert.equal(h.overflow(), 'auto', 'a torn-down overlay must not restore overflow a second time');
});

test('9: a click on the video itself does not close the review, only the backdrop does', () => {
  const inside = load();
  fire(inside.backdrop(), 'click', { target: inside.frame() });
  assert.equal(inside.hosts().length, 1);

  const outside = load();
  fire(outside.backdrop(), 'click', { target: outside.backdrop() });
  assert.equal(outside.hosts().length, 0);
});

test('9b: the ✕ closes it', () => {
  const h = load();
  fire(h.closeBtn(), 'click');
  assert.equal(h.hosts().length, 0);
});

test('10: Escape closes the review and the page under test never sees the key', () => {
  const h = load();
  const ev = h.esc();
  assert.equal(ev.propagationStopped, true, 'the page must not also act on this Escape');
  assert.equal(h.hosts().length, 0);
});

test('10b: any other key is left for the page under test', () => {
  const h = load();
  const ev = event(null, 'keydown', { key: 'k' });
  h.win.live('keydown')[0].fn(ev);
  assert.equal(ev.propagationStopped, false);
  assert.equal(h.hosts().length, 1);
});

// ---- a frame the page under test refuses to load ----------------------------
// The page's CSP can refuse an extension frame. The overlay gives it a short wait; a frame that
// never says it loaded is a dark rectangle, so the words and the way out take its place.

test('11 (#332): a review whose frame never loads tells the tester why, and offers a tab', () => {
  const h = load();
  assert.equal(h.stall(), null, 'nothing is said while the frame still has its wait');
  h.waitOut();
  const said = h.stall();
  assert.ok(said, 'a frame that never loaded must not be left as a dark rectangle');
  assert.match(said.textContent, /\S/, 'in words, not an empty box');
  assert.equal(h.iframe().hidden, true, 'and the dark rectangle itself is gone');
  const out = h.stallLink();
  assert.ok(out, 'the tab the worker already opens as its third placement is offered here too');
  assert.equal(out.href, `${EXT}/screenrec/review.html`);
  assert.equal(out.target, '_blank');
  assert.equal(h.hosts().length, 1, 'the take is not lost — the review is still standing');
});

test('11b (#332): the frame loads in time and the tester is told nothing', () => {
  const h = load();
  // A review page that really opened is another origin: reading into it is refused, not merely empty.
  Object.defineProperty(h.iframe(), 'contentDocument', {
    configurable: true, get() { throw new Error('cross-origin'); },
  });
  fire(h.iframe(), 'load');
  h.waitOut();
  assert.equal(h.stall(), null, 'a review that works must not be talked over');
  assert.equal(h.iframe().hidden, undefined, 'nor its frame hidden');
});

// The case the ticket is actually about. A page's CSP does not make the frame fail — Chrome reports
// `load` and leaves it on the initial about:blank, which is same-origin and therefore still readable.
// Trusting that `load` is what left the tester with a dark rectangle in the first place.
test('11e (#332): a `load` on a frame that never left about:blank is a refusal, not a review', () => {
  const h = load();
  h.iframe().contentDocument = { title: '' }; // still ours to read: the navigation was blocked
  fire(h.iframe(), 'load');
  assert.ok(h.stall(), 'the refusal is said at once, without waiting the frame out');
  assert.equal(h.iframe().hidden, true);
  assert.ok(h.stallLink());
});

test('11c (#332): a frame that errors out says so without waiting the whole wait', () => {
  const h = load();
  fire(h.iframe(), 'error');
  assert.ok(h.stall(), 'the refusal is already known — no reason to keep the tester waiting');
  assert.ok(h.stallLink());
});

test('11d (#332): closing before the wait is out leaves the late wait nothing to say', () => {
  const h = load();
  const box = h.frame();
  h.esc();
  assert.equal(h.timers.filter((t) => t.live).length, 0, 'the wait is called off with the review');
  h.waitOut();
  assert.equal(h.hosts().length, 0, 'a late wait must not put the review back on the page');
  assert.equal(box.querySelector('.stall'), null, 'nor paint a refusal into a review already gone');
});
