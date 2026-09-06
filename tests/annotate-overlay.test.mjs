#!/usr/bin/env node
// #175: the on-page host of the annotator. extension/overlay/annotate-overlay.js is injected into
// the tab the tester was looking at, draws the annotator over everything, and is the only thing
// that tells the side panel what happened. Two contracts here have each already shipped a bug:
// EVERY exit must write the handoff key (the panel's watchdog has nothing else to listen to, so a
// silent return leaves it on "Annotating…" for good), and leaving the page must write "cancelled",
// never the un-redacted original. The engine it wraps is covered in tests/annotate-core.test.mjs.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/mini-dom.mjs';
import { chromeFake, loadInto, plain, settle } from './helpers/shared-harness.mjs';

const REL = 'overlay/annotate-overlay.js';
const HOST_ID = '__testomat_annotator_overlay';
const KEY = 'annotate-3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SHOT = 'data:image/jpeg;base64,ORIGINAL';
const DRAWN = 'data:image/jpeg;base64,REDACTED';
const LIB_CSS = ':root { --bg: #fff; }\n.btn { color: var(--bg); }';

// window is a plain object here, so the one listener the file registers is the only way in.
function makeWindow() {
  const on = [];
  const win = {
    addEventListener(type, fn) { on.push({ type, fn, live: true }); },
    removeEventListener(type, fn) {
      const hit = on.find((r) => r.live && r.type === type && r.fn === fn);
      if (hit) hit.live = false;
    },
  };
  win.on = on;
  win.live = (type) => on.filter((r) => r.live && r.type === type);
  return win;
}

const ABSENT = Symbol('absent');

function load(opts = {}) {
  const {
    key = KEY,
    scheme = ABSENT,
    css = LIB_CSS,
    payload = { dataUrl: SHOT },
    getFail = false,
    prefersDark = false,
    core = 'ok',            // 'ok' | 'throws' | 'missing'
    tooltip = true,
    overflow = 'scroll',
    stale = false,
    answer = true,
  } = opts;

  const doc = makeDocument();
  doc.documentElement.style.overflow = overflow;
  if (stale) {
    const old = doc.createElement('div');
    old.id = HOST_ID;
    doc.body.append(old);
  }

  const seed = payload === ABSENT ? {} : { [key]: payload };
  const ch = chromeFake({ session: seed, sessionFail: getFail ? { get: true } : {} });
  const sets = ch.session.sets;
  const flags = { throwSync: false, setFails: false };
  const realSet = ch.chrome.storage.session.set;
  ch.chrome.storage.session.set = async (patch) => {
    // The two ways a real MV3 store refuses: the context is gone (sync throw) and quota (reject).
    if (flags.throwSync) throw new Error('Extension context invalidated');
    await realSet(patch);
    if (flags.setFails) throw new Error('the session store is full');
  };

  const win = makeWindow();
  if (key !== ABSENT) win.__testomatAnnotateKey = key;
  if (scheme !== ABSENT) win.__testomatAnnotateScheme = scheme;
  win.__testomatAnnotateCss = css;
  const asked = [];
  const media = [];
  win.matchMedia = (q) => { media.push(q); return { matches: prefersDark }; };
  win.confirm = (msg) => { asked.push(msg); return answer; };

  const created = [];
  const destroyed = [];
  const hooks = { tag: 'the live annotator' };
  const Core = {
    create(o) {
      created.push({
        opts: o,
        // The panel's watchdog ends at {ready:true}; it has to be written BEFORE the slow half.
        setsAtCreate: sets.slice(),
        hostAtCreate: !!doc.getElementById(HOST_ID),
        overflowAtCreate: doc.documentElement.style.overflow,
      });
      if (core === 'throws') throw new Error('canvas is blocked on this page');
      return { hooks, destroy: () => { destroyed.push(true); } };
    },
  };

  const tips = [];
  const sandbox = { window: win, document: doc, chrome: ch.chrome, console };
  if (core !== 'missing') sandbox.AnnotateCore = Core;
  if (tooltip) sandbox.Tooltip = { mount: (r) => tips.push(['mount', r]), unmount: () => tips.push(['unmount']) };
  loadInto(sandbox, [REL]);

  const hosts = () => doc.querySelectorAll(`#${HOST_ID}`);
  const host = () => hosts()[0] || null;
  return {
    doc,
    win,
    sets,
    flags,
    asked,
    media,
    tips,
    created,
    destroyed,
    hooks,
    hosts,
    host,
    shadow: () => (host() ? host().shadowRoot : null),
    mount: () => (host() ? host().shadowRoot.querySelector('.annot-root') : null),
    opts: () => created[0].opts,
    overflow: () => doc.documentElement.style.overflow,
    pagehide: () => win.live('pagehide').forEach((l) => l.fn()),
    wrote: () => plain(sets),
  };
}

// ---- every exit writes the key ----------------------------------------------

test('1: the tester navigates away mid-blur and the panel is told “cancelled”, never the raw shot', async () => {
  const h = load();
  await settle();
  h.pagehide();
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { ready: true } }, { [KEY]: { cancelled: true } }]);
  const text = JSON.stringify(h.wrote());
  assert.equal(text.includes(SHOT), false, 'the un-blurred original must never leave this way');
  assert.equal(text.includes('resultDataUrl'), false);
});

test('2: Save writes the picture the tester drew on and takes the overlay off the page', async () => {
  const h = load();
  await settle();
  await h.opts().onApply(DRAWN);
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { ready: true } }, { [KEY]: { resultDataUrl: DRAWN } }]);
  assert.equal(h.hosts().length, 0, 'the page is handed back');
  assert.equal(h.overflow(), 'scroll');
  assert.deepEqual(h.destroyed, [true], 'and the engine is destroyed with it');
  assert.deepEqual(h.win.live('pagehide'), [], 'no pagehide listener left to write a late cancel');
});

test('3: Discard writes “cancelled” and takes the overlay off the page', async () => {
  const h = load();
  await settle();
  await h.opts().onCancel();
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { ready: true } }, { [KEY]: { cancelled: true } }]);
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll');
});

test('3b: a store that refuses the exit write still hands the page back', async () => {
  const h = load();
  await settle();
  h.flags.setFails = true;
  await h.opts().onApply(DRAWN);
  await settle();
  assert.equal(h.hosts().length, 0, 'a failed write must not strand the overlay on the page');
  assert.equal(h.overflow(), 'scroll');
});

// ---- the bail-outs, which the panel hears as an error rather than silence ----

test('4: no handoff key means no channel, so nothing is written and nothing is drawn', async () => {
  const h = load({ key: ABSENT });
  await settle();
  assert.deepEqual(h.wrote(), [], 'the panel’s watchdog covers this one');
  assert.equal(h.hosts().length, 0);
});

test('5: the design system’s stylesheet never arrived, so the tester is told, not left waiting', async () => {
  const h = load({ css: '' });
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { error: 'The annotator could not load on this page' } }]);
  assert.equal(h.hosts().length, 0);
});

test('6: the engine half of the injection failed, and the same message goes back', async () => {
  const h = load({ core: 'missing' });
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { error: 'The annotator could not load on this page' } }]);
  assert.equal(h.hosts().length, 0);
});

test('6b: a bail-out whose write throws outright is swallowed, not left as a page error', async () => {
  const h = load({ css: '' });
  h.flags.throwSync = true;
  await settle();
  assert.equal(h.hosts().length, 0);
});

test('7: the session store cannot be read and the reason reaches the panel', async () => {
  const h = load({ getFail: true });
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { error: 'The annotator could not read the shot: storage.get failed' } }]);
  assert.equal(h.hosts().length, 0);
});

test('8: the shot never made it into the key and the panel is told so', async () => {
  const h = load({ payload: ABSENT });
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { error: 'The shot did not reach the annotator' } }]);
  assert.equal(h.hosts().length, 0);
});

test('8b: a payload that arrived without a dataUrl reads the same way', async () => {
  const h = load({ payload: { at: 1 } });
  await settle();
  assert.deepEqual(h.wrote(), [{ [KEY]: { error: 'The shot did not reach the annotator' } }]);
});

// ---- the happy path ---------------------------------------------------------

test('9: the frame is up and the panel hears “ready” before the picture is decoded', async () => {
  const h = load();
  await settle();
  assert.equal(h.hosts().length, 1);
  assert.deepEqual(h.wrote(), [{ [KEY]: { ready: true } }]);
  const at = h.created[0];
  assert.equal(at.hostAtCreate, true, 'the host is on the page before the slow half starts');
  assert.deepEqual(plain(at.setsAtCreate), [{ [KEY]: { ready: true } }], 'ready is said first');
  assert.equal(at.overflowAtCreate, 'hidden', 'and the page behind is already locked');
});

test('9b: the overlay is built to sit over everything, styled library-first', async () => {
  const h = load();
  await settle();
  assert.equal(h.host().style.cssText, 'position:fixed;inset:0;z-index:2147483647;');
  const kids = h.shadow().childNodes;
  assert.equal(kids[0].textContent, LIB_CSS, 'the design system first…');
  assert.equal(kids[1].textContent.includes('.annot-root'), true, '…this file’s layout second, so it wins by order');
  assert.equal(kids[2], h.mount());
  assert.deepEqual(h.tips, [['mount', h.shadow()]], 'the tooltip is drawn inside our root, not the page');
});

test('9c: the engine is handed the mount, the page’s document and the shot', async () => {
  const h = load();
  await settle();
  const o = h.opts();
  assert.equal(o.mount, h.mount());
  assert.equal(o.doc, h.doc);
  assert.equal(o.dataUrl, SHOT);
  assert.equal(h.win.__annot, h.hooks, 'exposed in the isolated world for e2e');
  o.onReady({ tag: 'from onReady' });
  assert.deepEqual(plain(h.win.__annot), { tag: 'from onReady' });
});

test('10: the engine throws on this page and the overlay leaves rather than standing empty', async () => {
  const h = load({ core: 'throws' });
  await settle();
  assert.equal(h.hosts().length, 0, 'never a mounted-but-empty overlay');
  assert.equal(h.overflow(), 'scroll', 'and the page scrolls again');
  assert.deepEqual(h.wrote(), [
    { [KEY]: { ready: true } },
    { [KEY]: { error: 'The annotator failed on this page: canvas is blocked on this page' } },
  ]);
  assert.deepEqual(h.tips.map((r) => r[0]), ['mount', 'unmount'], 'the tooltip goes with it');
});

// signal() is fire-and-forget on purpose, so a store that REJECTS (quota, a context torn down
// mid-write) has no owner: the rejection surfaces in the console of the site being tested.
test('10b (#333): a store that refuses the exit signal leaves no error in the page under test', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(String(e));
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = load({ core: 'throws' });
    h.flags.setFails = true; // armed before the async half writes anything
    await settle(4);
    assert.equal(h.hosts().length, 0, 'the overlay still leaves');
    assert.deepEqual(seen, [], 'nothing of ours may reach the tested page’s console');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('11: annotating the same tab twice leaves one overlay behind, not two', async () => {
  const h = load({ stale: true });
  await settle();
  assert.equal(h.hosts().length, 1, 'the stale host is taken out before the new one goes in');
  assert.equal(h.mount() !== null, true, 'and the survivor is the live one');
});

// ---- the handoff, the scheme and the scroll lock -----------------------------

test('12: the panel’s Appearance setting decides the annotator’s scheme', async () => {
  const dark = load({ scheme: 'dark' });
  await settle();
  assert.equal(dark.mount().dataset.scheme, 'dark');
  assert.deepEqual(dark.media, [], 'a resolved setting never asks the site’s media query');

  const light = load({ scheme: 'light', prefersDark: true });
  await settle();
  assert.equal(light.mount().dataset.scheme, 'light');
});

test('12b: no setting handed over falls back to what the tester’s OS asks for', async () => {
  const h = load({ prefersDark: true });
  await settle();
  assert.equal(h.mount().dataset.scheme, 'dark');
  assert.deepEqual(h.media, ['(prefers-color-scheme: dark)']);

  const day = load({ prefersDark: false });
  await settle();
  assert.equal(day.mount().dataset.scheme, 'light');
});

test('12c: a garbage setting falls back the same way rather than reaching the markup', async () => {
  const h = load({ scheme: 'sepia', prefersDark: true });
  await settle();
  assert.equal(h.mount().dataset.scheme, 'dark');
});

test('13: the handoff is one-shot, so a second injection cannot reuse the key', async () => {
  const h = load({ scheme: 'dark' });
  await settle();
  assert.equal(h.win.__testomatAnnotateKey, null);
  assert.equal(h.win.__testomatAnnotateScheme, null);
  assert.equal(h.win.__testomatAnnotateCss, null);
});

test('13b: even a bail-out consumes the handoff', async () => {
  const h = load({ css: '' });
  await settle();
  assert.equal(h.win.__testomatAnnotateKey, null);
  assert.equal(h.win.__testomatAnnotateScheme, null);
  assert.equal(h.win.__testomatAnnotateCss, null);
});

test('14: a second exit after the overlay is already gone does not touch the page again', async () => {
  const h = load();
  await settle();
  await h.opts().onApply(DRAWN);
  h.doc.documentElement.style.overflow = 'auto'; // the page moved on after the annotator left
  await h.opts().onCancel();
  await settle();
  assert.equal(h.overflow(), 'auto', 'overflow must not be restored a second time');
  assert.deepEqual(h.destroyed, [true], 'and the engine is destroyed once');
});

test('15: keeping the original after blurring something says out loud what that means', async () => {
  const h = load();
  await settle();
  h.opts().confirmKeep(true);
  assert.equal(h.asked[0], 'Attach the original screenshot, with the areas you blurred visible again?');
  h.opts().confirmKeep(false);
  assert.equal(h.asked[1], 'Attach the original screenshot and drop the annotations?');
  h.opts().confirmDiscard();
  assert.equal(h.asked[2], 'Discard the screenshot and its annotations?');
  const no = load({ answer: false });
  await settle();
  assert.equal(no.opts().confirmKeep(true), false, 'a tester who says no is heard');
});

test('15b: a page the tooltip never reached still opens and still closes', async () => {
  const h = load({ tooltip: false });
  await settle();
  assert.equal(h.hosts().length, 1);
  await h.opts().onCancel();
  assert.equal(h.hosts().length, 0);
  assert.equal(h.overflow(), 'scroll');
});

test('16: a page that scrolled before is scrolling again afterwards, at its own setting', async () => {
  const h = load({ overflow: 'scroll' });
  await settle();
  assert.equal(h.overflow(), 'hidden');
  await h.opts().onCancel();
  assert.equal(h.overflow(), 'scroll', 'the page’s exact value, not an empty string');
});

test('16b: a page that set no overflow of its own gets an empty one back, not “hidden”', async () => {
  const h = load({ overflow: '' });
  await settle();
  assert.equal(h.overflow(), 'hidden');
  await h.opts().onCancel();
  assert.equal(h.overflow(), '');
});
