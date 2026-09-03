#!/usr/bin/env node
// The frame contract of extension/content/step-recorder.js: every frame records a click and
// says which frame it was in, one frame draws the pill. Run: node --test tests/step-recorder.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repoRoot, 'extension/content/step-recorder.js'), 'utf8');

const HOST_ID = '__testomat_step_recorder';

// A node thin enough to stub and thick enough to click: it answers the naming walk (its text
// runs, its attributes, its missing ancestors) and swallows everything the pill builds on it.
function node(tag, text = '', attrs = {}) {
  const self = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: text,
    style: {},
    children: [],
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = v; },
    querySelector: () => null,
    querySelectorAll: () => [],
    // `closest(CLICK_SEL)` is what promotes a click target; no row, label or cell answers.
    closest: (sel) => (self.tagName === 'BUTTON' && sel.includes('button') ? self : null),
    append: (...n) => { self.children.push(...n); },
    replaceChildren: (...n) => { self.children = [...n]; },
    addEventListener: () => {},
    removeEventListener: () => {},
    remove: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    attachShadow: () => ({ append: () => {}, addEventListener: () => {} }),
  };
  // What the TreeWalker below hands back — the runs the element's name is built from.
  self.texts = text ? [{ nodeType: 3, nodeValue: text, parentElement: self }] : [];
  return self;
}

// One document, one frame position. Returns the handles the assertions need plus `fire`,
// which drives a real event through the capture listener the recorder itself registered.
function load({ top = true, hostname = 'example.com', title = 'Checkout' } = {}) {
  const sent = [];       // every chrome.runtime.sendMessage payload, in order
  const mounted = [];    // what reached document.body — the pill, or nothing
  const winEvents = [];  // the window listener types the script installed
  const timers = [];     // pending setTimeout callbacks: the packet's 400ms window
  const docListeners = new Map();
  let pollDelay = 0;

  const target = node('button', 'Pay now');

  const doc = {
    title,
    documentElement: {},
    body: { append: (...n) => { mounted.push(...n); } },
    activeElement: null,
    createElement: (t) => node(t),
    createTextNode: (t) => ({ nodeType: 3, nodeValue: t }),
    createTreeWalker: (root) => {
      const list = root.texts || [];
      let i = 0;
      return { nextNode: () => (i < list.length ? list[i] && list[i++] : null) };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };

  const win = {
    addEventListener: (type) => { winEvents.push(type); },
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  };
  win.top = top ? win : {}; // the one fact that tells a frame from the page

  const sandbox = {
    window: win,
    document: doc,
    location: { hostname, href: hostname ? `https://${hostname}/pay` : 'about:blank' },
    chrome: {
      runtime: {
        sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ count: sent.length }); },
        onMessage: { addListener: () => {}, removeListener: () => {} },
      },
      storage: {
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    },
    setInterval: (fn, ms) => { pollDelay = ms; return 1; },
    clearInterval: () => {},
    setTimeout: (fn) => timers.push(fn),
    NodeFilter: { SHOW_TEXT: 4 },
    CSS: { escape: (s) => s },
    MutationObserver: class { observe() {} disconnect() {} },
    performance: { now: () => 0 },
    URL,
  };

  runInNewContext(source, sandbox);

  return {
    target,
    pollDelay,
    mounted,
    winEvents,
    fire: (type) => {
      const ev = { type, target, composedPath: () => [target] };
      for (const fn of docListeners.get(type) || []) fn(ev);
    },
    // Close every open packet window, which is what hands the entries to sendMessage.
    flush: () => { for (const fn of timers.splice(0)) fn(); },
    entries: () => sent.filter((m) => m.type === 'STEPREC_ADD').map((m) => m.entry),
    titles: () => sent.filter((m) => m.type === 'STEPREC_TITLE').map((m) => m.title),
  };
}

const clickOnce = (opts) => {
  const r = load(opts);
  r.fire('click');
  r.flush();
  return r;
};

test('the top frame writes a plain sentence, draws the pill, polls twice a second', () => {
  const r = clickOnce({ top: true });
  const [entry] = r.entries();
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.ctx.frame, undefined);
  assert.equal(r.mounted.length, 1);
  assert.equal(r.mounted[0].id, HOST_ID);
  assert.equal(r.pollDelay, 500);
  assert.deepEqual(r.titles(), ['Checkout']);
  assert.ok(r.winEvents.includes('resize'));
});

test('the same click inside a frame says where it happened, and draws nothing', () => {
  const r = clickOnce({ top: false, hostname: 'checkout.example.com' });
  const [entry] = r.entries();
  assert.equal(entry.text, 'Click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(entry.ctx.frame, 'checkout.example.com');
  assert.equal(r.mounted.length, 0);
  assert.equal(r.pollDelay, 2000);
  assert.deepEqual(r.titles(), []); // a payment form's title is not where the tester navigated
  assert.ok(!r.winEvents.includes('resize'));
});

test('an about:blank frame has no host to name, so it names none', () => {
  const r = clickOnce({ top: false, hostname: '' });
  const [entry] = r.entries();
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.ctx.frame, undefined);
  assert.equal(r.mounted.length, 0);
  assert.equal(r.pollDelay, 2000);
});

// A real double-click fires click, click, dblclick; the worker pops the twins by matching
// `replaces` to their text, so the clause has to land on both or the twins stay behind.
test('a double click in a frame keeps `replaces` matched to the clicks it supersedes', () => {
  const r = load({ top: false, hostname: 'checkout.example.com' });
  r.fire('click');
  r.fire('click');
  r.fire('dblclick');
  r.flush();
  const entries = r.entries();
  assert.equal(entries.length, 3);
  const last = entries[2];
  assert.equal(last.text, 'Double-click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(last.replaces, 'Click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(last.replaces, entries[0].text);
});

test('the top frame double click carries the clause on neither string', () => {
  const r = load({ top: true });
  r.fire('click');
  r.fire('dblclick');
  r.flush();
  const entries = r.entries();
  const last = entries[1];
  assert.equal(last.text, 'Double-click the "Pay now" button');
  assert.equal(last.replaces, 'Click the "Pay now" button');
  assert.equal(last.replaces, entries[0].text);
});
