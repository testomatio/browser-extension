#!/usr/bin/env node
// What extension/sidepanel/screens/test-view.js SHOWS the tester (#164, half B): the steps they are
// about to run through, and everything the last automated run left behind — how long it took, the
// failure text, the environment meta, the reported step tree, the screenshots and the other files.
// Half A (the write path) is tests/test-view-write.test.mjs.
// Two things here are easy to get quietly wrong. A step's `pos` is the index among ALL <li> in the
// rendered description, nested bullets included, because that is what the web runner counts — and it
// is snapshotted BEFORE the Expected sub-bullets are folded away, so folding one must not renumber
// the steps after it. And the failure body has two readers: a reporter's assertion output, where the
// whitespace IS the information, and a human's Markdown, which goes through the sanitizer.
// Rows 18-56, 110-146 and 159 are the ticket's; a lettered suffix is the companion case that drives
// the same path the other way, so a row asserting "nothing happened" cannot pass against a stub that
// never worked.
// Run: node --test tests/test-view-read.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeWindow, makeDocument, el, plain, settle } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The real substitution module, not a look-alike: rows 121-124 are about the product's own non-"0"
// rule and the double quotes it wraps a value in. PARAMS_SRC mirrors params.test.mjs's own seam.
const PARAMS_SRC = process.env.PARAMS_SRC || join(repoRoot, 'extension/params.js');
const TestomatParams = runInNewContext(`${readFileSync(PARAMS_SRC, 'utf8')}\nTestomatParams;`, {});

// ---------- what Md.render really emits ----------
// Captured once from the real pipeline (vendor/showdown.min.js + shared/html-sanitize.js +
// shared/markdown.js over the mini-DOM) and frozen here: markdown.js needs a `showdown` global and a
// lexical `sanitizeHtml` from another file, so it is not reachable beside a screen. These strings are
// what the tester's description actually becomes.
const MD = {
  // '## Steps' + two bullets
  twoSteps: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site</li>\n<li>Click Login</li>\n</ul>',
  // …with a nested `- Expected: green banner` under the first
  nestedExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>Expected: green banner</li></ul></li>\n<li>Click Login</li>\n</ul>',
  // …where that sub-bullet was the list's only child
  onlyExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>Expected: green banner</li></ul></li>\n</ul>',
  // '- Do X. **Expected Result**: Y.' — the bolded label mid-<li>
  inlineExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n'
    + '<li>Do X. <strong>Expected Result</strong>: Y.</li>\n<li>Click Login</li>\n</ul>',
  bothSpellings: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>One<ul>\n<li>Expected: a</li></ul></li>\n'
    + '<li>Two<ul>\n<li>Expected Results: b</li></ul></li>\n</ul>',
  // a label-shaped bullet that is not the label
  notExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>One<ul>\n'
    + '<li>Expectations: a</li></ul></li>\n</ul>',
  softBreak: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>line one<br>line two</li>\n</ul>',
  // '- [ ] do it' — showdown's tasklists extension, disabled box and all
  taskItem: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li style="list-style-type: none;" '
    + 'class="task-list-item"><input type="checkbox" disabled="" style="margin: 0px 0.35em 0.25em -1.6em; '
    + 'vertical-align: middle;"> do it</li>\n</ul>',
  stepsThenNotes: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site</li>\n'
    + '<li>Click Login</li>\n</ul>\n<h2 id="notes">Notes</h2>\n<ul>\n<li>a note</li>\n</ul>',
  nestedPlain: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>not expected at all</li></ul></li>\n<li>Click Login</li>\n</ul>',
  // the same nesting, but under a heading that makes the outer bullet an item rather than a step
  nestedItem: '<h2 id="notes">Notes</h2>\n<ul>\n<li>a note<ul>\n<li>nested note</li></ul></li>\n'
    + '<li>another</li>\n</ul>',
  // the same two lists under a heading that is not "Steps"
  noStepsHeading: '<h2 id="notes">Notes</h2>\n<ul>\n<li>a note</li>\n<li>another</li>\n</ul>',
  headingBody: '<h1 id="heading">heading</h1>\n<p>body text</p>',
  // '![px](https://evil.test/px.png)' — a markdown image survives the sanitizer with its host intact
  remoteImage: '<p>it broke</p>\n<p><img src="https://evil.test/px.png" alt="px"></p>',
};

// shared/markdown.js:61-72, verbatim: which lists are the STEPS is the renderer's answer, and a body
// with no Steps-like heading has none — the contract row 119 turns on.
const STEPS_HEADING = /step|крок/i;
function stepLists(container) {
  const heading = container.querySelectorAll('h1,h2,h3,h4').find((h) => STEPS_HEADING.test(h.textContent));
  if (!heading) return [];
  const lists = [];
  let node = heading.nextElementSibling;
  while (node && !/^H[1-4]$/.test(node.tagName)) {
    if (node.tagName === 'UL' || node.tagName === 'OL') lists.push(node);
    node = node.nextElementSibling;
  }
  return lists;
}

// A promise this file resolves by hand: the reported-steps rows are about which answer lands second.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// index.html's shape (:570-572, :611, :639, :645, :749-794), cut to the nodes half B touches. The
// disclosure heads live INSIDE their wrap because summaryStepsTools() inserts itself after the head
// and then looks for itself under the wrap.
function makePage(without = []) {
  const doc = makeDocument([]);
  const node = {};
  const add = (tag, id, props = {}) => {
    if (without.includes(id)) return null;
    node[id] = el(tag, { id, ...props });
    return node[id];
  };
  const wrap = (tag, id, props, ...kids) => {
    const box = add(tag, id, props);
    if (box) box.append(...kids.filter(Boolean));
    return box;
  };
  const steps = add('div', 'test-steps');
  const badge = add('span', 'example-badge', { hidden: true });
  const tab = add('button', 'tab-test-summary');
  const row = wrap('div', 'test-result-row', { hidden: true },
    add('span', 'summary-status'), add('span', 'summary-duration'));
  const empty = add('div', 'test-summary-empty');
  const failure = wrap('div', 'summary-failure', { hidden: true },
    wrap('button', 'summary-failure-head', {}, add('span', 'summary-failure-title', { textContent: 'Failure' })),
    wrap('div', 'summary-failure-body', {}, add('div', 'summary-message', { className: 'summary-message' })));
  const artifacts = wrap('div', 'summary-artifacts', { hidden: true },
    wrap('button', 'summary-artifacts-head', {}, add('span', 'summary-artifacts-count')),
    add('ul', 'summary-artifacts-body'));
  const meta = wrap('div', 'summary-meta', { hidden: true },
    wrap('button', 'summary-meta-head', {}, add('span', 'summary-meta-count')),
    add('dl', 'summary-meta-body', { hidden: true }));
  const stepsFold = wrap('div', 'summary-steps', { hidden: true },
    wrap('button', 'summary-steps-head', {}, add('span', 'summary-steps-count')),
    add('div', 'summary-steps-body', { hidden: true }));
  const box = wrap('div', 'test-summary', { hidden: true }, failure, artifacts, meta, stepsFold);
  doc.body.append(...[steps, badge, tab, row, empty, box].filter(Boolean));
  // mini-dom has no after(); summaryStepsTools() parks its two buttons beside the head with it.
  for (const head of ['summary-steps-head', 'summary-failure-head']) {
    const h = node[head];
    if (h) h.after = (n) => h.parentElement.insertBefore(n, h.nextSibling);
  }
  return { doc, node };
}

// The panel globals test-view.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the ones beside this land in parallel.
function load(opts = {}) {
  const o = {
    jwt: true,
    hasChrome: true,
    runtime: true,        // false — a chrome that cannot send a message
    currentRecordId: '55',
    testrunDetail: null,
    session: {},          // chrome.storage.session's seed — `stepShotHook` lives here
    sessionThrows: false,
    without: [],          // page ids to leave out
    md: {},               // markdown source -> the html Md.render answers with
    presign: async () => 'https://signed.test/a',
    stepsDoc: { steps: [] }, // what GET /testruns/{id}/steps answers, or a function
    imgLoad: async () => true,
    ...opts,
  };

  const { doc, node } = makePage(o.without);
  const calls = {
    order: [],
    renders: [],     // every string handed to Md.render
    hydrates: [],    // ImgHydrate.hydrate(group, container)
    releases: [],    // ImgHydrate.release(group)
    loads: [],       // { group, src, opts } — row 159 is about the missing opts
    empties: [],     // { host, title, icon, compact }
    presigns: [],
    requests: [],    // TestomatAPI.jwtRequest paths
    opened: [],      // window.open(url, target, features)
    sends: [],       // chrome.runtime.sendMessage payloads
  };

  const state = {
    currentRecordId: o.currentRecordId,
    testrunDetail: o.testrunDetail,
    currentSteps: [],
    stepTicks: {},
  };

  const store = fakeChrome({ session: o.session });
  if (o.sessionThrows) store.fails.sessionGet = new Error('session storage is gone');
  const chromeStub = { storage: store.chrome.storage, runtime: {} };
  if (o.runtime) {
    chromeStub.runtime.sendMessage = async (msg) => {
      calls.sends.push(plain(msg));
      calls.order.push('sendMessage');
      if (o.sendFails) throw new Error('no receiving end');
      return { ok: true };
    };
  }

  const win = fakeWindow();
  win.open = (...args) => { calls.opened.push(args); calls.order.push('window.open'); };

  const html = (tag, className) => {
    const made = doc.createElement(tag);
    if (className) made.className = className;
    return made;
  };

  const globals = {
    state,
    capabilities: { jwt: o.jwt, readonly: false },
    hasChrome: o.hasChrome,
    chrome: chromeStub,
    $: (id) => doc.getElementById(id),
    TestomatParams,
    // shared/markdown.js's two answers: `render` off the frozen snapshots above, `stepLists` the
    // real algorithm — a stub that always found the lists would make row 119 pass for free.
    Md: {
      render: (md) => {
        calls.renders.push(md);
        calls.order.push('Md.render');
        const boxEl = doc.createElement('div');
        boxEl.innerHTML = o.md[md] !== undefined ? o.md[md] : `<p>${String(md)}</p>`;
        return boxEl;
      },
      stepLists,
    },
    ImgHydrate: {
      release: (group) => { calls.releases.push(group); calls.order.push(`release:${group}`); },
      hydrate: (group, container) => { calls.hydrates.push(group); calls.order.push('hydrate'); return container; },
      load: async (group, src, img, loadOpts) => {
        calls.loads.push({ group, src, opts: loadOpts === undefined ? null : plain(loadOpts) });
        calls.order.push('ImgHydrate.load');
        return typeof o.imgLoad === 'function' ? o.imgLoad(src) : o.imgLoad;
      },
    },
    // shared/empty-state.js's shape, cut to what these paths ask of it.
    EmptyState: {
      build: (opt = {}) => {
        calls.empties.push({ title: opt.title || '', icon: opt.icon || '', compact: !!opt.compact });
        const boxEl = html(opt.tag || 'div', `empty${opt.compact ? ' compact' : ''}`);
        boxEl.dataset.icon = opt.icon || '';
        boxEl.textContent = opt.title || opt.text || '';
        return boxEl;
      },
      into: (host, opt) => {
        if (!host) return null;
        const made = globals.EmptyState.build({ tag: host.tagName === 'UL' ? 'li' : 'div', ...opt });
        calls.empties[calls.empties.length - 1].host = host.id;
        host.replaceChildren(made);
        return made;
      },
    },
    Tooltip: { set: (n, tipText) => { n.dataset.tip = tipText; } },
    Sk: { lines: () => html('div', 'sk-lines') },
    svgIcon: (name, size, ...cls) => el('span', { className: ['icon', ...cls].join(' '), dataset: { icon: name } }),
    statusIcon: (status) => el('span', { className: 'status-icon', dataset: { status } }),
    // run-view.js:25, verbatim.
    normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),
    treeSlot: () => html('span', 'tree-icon'),
    CHEVRON_ICON: 'chevron_right',
    persistSession: () => {},
    toast: () => {},
    TestomatAPI: {
      // The real one resolves a root-relative asset path against the instance (api/assets.js:15).
      assetUrl: (raw) => { try { return new URL(String(raw), 'https://app.testomat.io/').toString(); } catch { return ''; } },
      presignArtifact: async (url) => {
        calls.presigns.push(url);
        return typeof o.presign === 'function' ? o.presign(url) : o.presign;
      },
      jwtRequest: async (path) => {
        calls.requests.push(path);
        return typeof o.stepsDoc === 'function' ? o.stepsDoc(path) : o.stepsDoc;
      },
    },
  };

  const h = loadScreen('test-view', {
    // `attachmentHref` is a const arrow, so it never lands on the sandbox; `summarySteps` is a
    // mutable `let`, so a getter — a plain read would hand every test the load-time null.
    exported: `({ summaryOpen, artifactPresigned, attachmentHref,
      IMG_GROUP_SHOTS, IMG_GROUP_ARTIFACTS, IMG_GROUP_DESC,
      get summarySteps() { return summarySteps; } })`,
    document: doc, window: win, store, globals,
  });

  return {
    ...h,
    state, calls, node, store, doc,
    // A rendered description, exactly as Md.render would hand it over.
    fixture: (markup) => { const c = doc.createElement('div'); c.innerHTML = markup; return c; },
  };
}

// A step row without its DOM node: the li holds a parent pointer, so plain() cannot see the row
// whole — and the list itself was built inside the vm, so it needs plain() to compare at all.
const rowsOf = (steps) => plain([...steps].map((s) => ({
  kind: s.kind, pos: s.pos, index: s.index, title: s.title, expected: s.expected, state: s.state,
})));

// ===================== duration (rows 18-25) =====================

test('18: a duration that is zero, negative or not a number at all prints nothing', () => {
  const h = load();
  for (const v of [0, -5, NaN, null, '', undefined, 'later']) assert.equal(h.fn.humanDuration(v), '');
});

test('18a: …and every duration above zero does print, down to a single millisecond', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(1), '1ms');
  assert.equal(h.fn.humanDuration(0.4), '0ms'); // rounded, but still a figure: it ran
});

test('19: under a second is milliseconds', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(999), '999ms');
  assert.equal(h.fn.humanDuration(1000), '1s'); // the boundary belongs to seconds
});

test('20: the reported-steps route hands a STRING by design, and it formats the same', () => {
  const h = load();
  assert.equal(h.fn.humanDuration('1500'), '1.5s');
  assert.equal(h.fn.humanDuration(1500), '1.5s');
});

test('21: a whole number of seconds loses its .0', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(2000), '2s');
  assert.equal(h.fn.humanDuration(2100), '2.1s'); // …and a tenth that is there stays
});

test('22: a whole minute is a minute, with no seconds hung off it', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(60000), '1m');
});

test('23: minutes and seconds', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(90000), '1m 30s');
});

test('24: one millisecond under the hour reads "59m 60s" — the rounding artifact, pinned', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(3599999), '59m 60s');
  // The neighbouring second, where the same arithmetic is unremarkable.
  assert.equal(h.fn.humanDuration(3599000), '59m 59s');
});

test('25: hours, with the minutes dropped when there are none', () => {
  const h = load();
  assert.equal(h.fn.humanDuration(3600000), '1h');
  assert.equal(h.fn.humanDuration(3660000), '1h 1m');
  assert.equal(h.fn.humanDuration(7260000), '2h 1m');
});

// ===================== the server step overlay (rows 26-29) =====================

const detail = (attributes) => ({ data: { attributes } });

// A Map built inside the vm is not this realm's Map, and its entries carry that realm's prototypes.
const entriesOf = (map) => plain([...map.entries()]);

test('26: the overlay is keyed by pos, and the unsorted list the route promises is sorted first', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: 2, status: 'failed' }, { pos: 0, status: 'passed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[0, 'passed'], [2, 'failed']]);
});

test('27: a pos that arrived as a string is not a position, and the entry is dropped', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: '1', status: 'failed' }, { pos: 1, status: 'passed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[1, 'passed']]);
});

test('28: two entries on the same pos — the later one in sorted order wins', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: 1, status: 'passed' }, { pos: 1, status: 'failed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[1, 'failed']]);
});

test('29: no testrun detail, or steps that are not a list, is an empty overlay and no throw', () => {
  assert.equal(load().fn.serverStepStates().size, 0);
  assert.equal(load({ testrunDetail: detail({}) }).fn.serverStepStates().size, 0);
  assert.equal(load({ testrunDetail: detail({ steps: 'none' }) }).fn.serverStepStates().size, 0);
});

// ===================== the reported-step tree (rows 30-34) =====================

test('30: a sub-step becomes a child node', () => {
  const h = load();
  const tree = h.fn.summaryStepTree([{ title: 'a', steps: [{ title: 'b' }] }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'a');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].name, 'b');
  assert.equal(tree[0].children[0].children, null);
});

test('31: files move into a child "Attachments" group, off the step itself', () => {
  const h = load();
  const atts = [{ name: 'x.png' }];
  const [nodeOut] = h.fn.summaryStepTree([{ title: 'a', attachments: atts }]);
  assert.equal(nodeOut.attachments, null);
  assert.equal(nodeOut.isImage, true);
  assert.deepEqual(plain(nodeOut.children), [{ name: 'Attachments', attachments: [{ name: 'x.png' }], children: null }]);
});

test('32: an empty attachments array grows no group and leaves the step a leaf', () => {
  const h = load();
  const [nodeOut] = h.fn.summaryStepTree([{ title: 'a', attachments: [] }]);
  assert.equal(nodeOut.children, null);
  assert.equal(nodeOut.isImage, false);
  assert.deepEqual(plain(nodeOut.attachments), []); // still the step's own empty list, not nulled
});

test('33: anything that is not a list of steps is no steps at all', () => {
  const h = load();
  for (const v of [null, undefined, 'x', 42, { steps: [] }]) assert.deepEqual(plain(h.fn.summaryStepTree(v)), []);
});

test('34: sub-steps come first and the Attachments group last', () => {
  const h = load();
  const [nodeOut] = h.fn.summaryStepTree([{ title: 'a', steps: [{ title: 'b' }], attachments: [{ name: 'x.png' }] }]);
  assert.deepEqual(nodeOut.children.map((c) => c.name), ['b', 'Attachments']);
});

test('34a: the fields the web transform carries ride along untouched', () => {
  const h = load();
  const [nodeOut] = h.fn.summaryStepTree([{ title: 'a', category: 'hook', duration: '12', log: 'L', error: 'E', status: 'failed' }]);
  assert.deepEqual(plain(nodeOut), {
    name: 'a', category: 'hook', duration: '12', log: 'L', error: 'E', status: 'failed',
    children: null, isImage: false,
  });
});

// ===================== linkifying a reporter's log (rows 35-41) =====================

const linked = (h, source) => {
  const host = h.doc.createElement('div');
  h.fn.linkifyInto(host, source);
  return host;
};
const anchors = (host) => host.querySelectorAll('a').map((a) => ({ href: a.href, text: a.textContent }));

test('35: a URL in the middle of a line becomes an anchor, and the prose around it survives', () => {
  const h = load();
  const host = linked(h, 'see https://a.test/x for more');
  assert.deepEqual(anchors(host), [{ href: 'https://a.test/x', text: 'https://a.test/x' }]);
  assert.equal(host.textContent, 'see https://a.test/x for more');
  const [a] = host.querySelectorAll('a');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
});

test('36: a full stop after a URL is prose, and stays out of the href', () => {
  const h = load();
  const host = linked(h, 'go to https://a.test/x.');
  assert.deepEqual(anchors(host), [{ href: 'https://a.test/x', text: 'https://a.test/x' }]);
  assert.equal(host.textContent, 'go to https://a.test/x.'); // the stop is still read, as text
});

test('37: so is a closing bracket', () => {
  const h = load();
  const host = linked(h, '(https://a.test/x)');
  assert.deepEqual(anchors(host), [{ href: 'https://a.test/x', text: 'https://a.test/x' }]);
  assert.equal(host.textContent, '(https://a.test/x)');
});

test('38: only http and https are linked — a javascript: URL stays words', () => {
  const h = load();
  const host = linked(h, 'javascript:alert(1)');
  assert.deepEqual(anchors(host), []);
  assert.equal(host.textContent, 'javascript:alert(1)');
  // …and the neighbouring scheme that IS linked, so the row cannot pass on a dead regex.
  assert.equal(linked(h, 'http://a.test/x').querySelectorAll('a').length, 1);
});

test('39: markup in the log arrives as text — the pieces are appended, never parsed', () => {
  const h = load();
  const host = linked(h, '<b>hi</b> https://a.test');
  assert.equal(host.childNodes[0].nodeType, 3);
  assert.equal(host.querySelectorAll('b').length, 0);
  assert.equal(host.innerHTML, '&lt;b&gt;hi&lt;/b&gt; <a href="https://a.test" target="_blank" '
    + 'rel="noopener noreferrer">https://a.test</a>');
});

test('40: two URLs on one line are two anchors, with the words between them kept', () => {
  const h = load();
  const host = linked(h, 'a https://x.test b https://y.test c');
  assert.deepEqual(anchors(host).map((a) => a.href), ['https://x.test', 'https://y.test']);
  assert.equal(host.textContent, 'a https://x.test b https://y.test c');
});

test('41: a bare "https://" matches nothing and is left as the text it is', () => {
  const h = load();
  const host = linked(h, 'https://');
  // The regex needs at least one character after the slashes, so there is no match to strip.
  assert.deepEqual(anchors(host), []);
  assert.equal(host.textContent, 'https://');
});

test('41a: "https://." IS matched, and the stripped stop leaves a degenerate anchor — current behaviour', () => {
  const h = load();
  const host = linked(h, 'https://.');
  // The dot satisfies the character class, then the trailing-punctuation strip takes it back off.
  assert.deepEqual(anchors(host), [{ href: 'https://', text: 'https://' }]);
  assert.equal(host.textContent, 'https://.');
});

// ===================== what kind of file is this (rows 42-53) =====================

test('42: a server-declared image is an image', () => {
  const h = load();
  assert.equal(h.fn.isImageAttachment({ type: 'image/png' }), true);
  assert.equal(h.fn.isImageAttachment({ type: 'text/plain' }), false);
});

test('43: SVG is excluded, however it is spelled', () => {
  const h = load();
  assert.equal(h.fn.isImageAttachment({ type: 'image/svg+xml' }), false);
  assert.equal(h.fn.isImageAttachment({ type: 'image/SVG+XML' }), false);
});

test('44: a declared MIME type wins over the name, even when the name says .png', () => {
  const h = load();
  assert.equal(h.fn.isImageAttachment({ type: 'application/octet-stream', name: 'a.png' }), false);
  // …and with the type gone the same row is an image, so the name fallback is really reachable.
  assert.equal(h.fn.isImageAttachment({ name: 'a.png' }), true);
});

test('45: with no type at all the name decides, case and all', () => {
  const h = load();
  assert.equal(h.fn.isImageAttachment({ name: 'a.JPEG' }), true);
  assert.equal(h.fn.isImageAttachment({ name: 'a.avif' }), true);
  assert.equal(h.fn.isImageAttachment({ name: 'a.png.txt' }), false); // anchored at the end
});

test('46: a video needs EITHER tell — a bucket that serves a screencast as bytes is still a video', () => {
  const h = load();
  assert.equal(h.fn.isVideoAttachment({ type: 'application/octet-stream', name: 'take.webm' }), true);
  assert.equal(h.fn.isVideoAttachment({ type: 'video/webm' }), true);
  assert.equal(h.fn.isVideoAttachment({ type: 'application/octet-stream', name: 'take.txt' }), false);
});

test('47: a query string after the extension does not hide it', () => {
  const h = load();
  assert.equal(h.fn.isVideoAttachment({ url: 'https://h/f.mp4?sig=1' }), true);
  assert.equal(h.fn.isVideoAttachment({ url: 'https://h/f.mp4#t=2' }), true);
  assert.equal(h.fn.isVideoAttachment({ url: 'https://h/f.mp4x' }), false);
});

test('48: the badge is the LAST extension, not the first', () => {
  const h = load();
  assert.equal(h.fn.fileExt({ name: 'archive.tar.gz' }), 'GZ');
});

test('49: it comes off a URL too, upper-cased, with the query left behind', () => {
  const h = load();
  assert.equal(h.fn.fileExt({ url: 'https://h/a/file.PNG?x=1' }), 'PNG');
  assert.equal(h.fn.fileExt({ name: 'shot.png', url: 'https://h/other.gif' }), 'PNG'); // the name is asked first
});

test('50: an extension is at most five characters — six is not one, and the tile says FILE instead', () => {
  const h = load();
  assert.equal(h.fn.fileExt({ name: 'archive.tarball' }), '');
  assert.equal(h.fn.fileExt({ name: 'a.plist' }), 'PLIST'); // five: the boundary itself
  assert.equal(h.fn.fileExt({ name: 'a.sqlite' }), '');     // six: one over
  assert.equal(h.fn.fileExt({}), '');
});

test('50a: …and the tile badge falls back to FILE when there is no usable extension', () => {
  const h = load();
  const badge = (att) => h.fn.fileTile(att, 'g', '').querySelector('.file-tile-badge').textContent;
  assert.equal(badge({ name: 'archive.tarball' }), 'FILE');
  assert.equal(badge({ name: 'notes.txt' }), 'TXT');
});

test('51: an image opens at its inline address', () => {
  const h = load();
  assert.equal(h.screen.attachmentHref({ type: 'image/png', display_url: 'D', url: 'U' }), 'D');
  assert.equal(h.screen.attachmentHref({ type: 'image/png', url: 'U' }), 'U'); // …and falls back to its own
});

test('52: anything else never uses display_url — the server answers a type icon there', () => {
  const h = load();
  assert.equal(h.screen.attachmentHref({ type: 'text/plain', display_url: 'D', url: 'U' }), 'U');
});

test('53: a row with no address at all answers the empty string, never undefined', () => {
  const h = load();
  assert.equal(h.screen.attachmentHref({}), '');
  assert.equal(h.screen.attachmentHref(null), '');
});

// ===================== where a thumbnail's bytes come from (rows 54-56) =====================

test('54: with no hook set the instance\'s own URL is asked first', async () => {
  const h = load();
  assert.equal(await h.fn.attachmentSrc({ url: 'U', display_url: 'D' }), 'U');
  assert.equal(await h.fn.attachmentSrc({ display_url: 'D' }), 'D'); // …and display_url when there is none
  assert.equal(await h.fn.attachmentSrc({}), '');
});

// 55: the e2e hook outranks the row's own url, by name, against the hook as the base. It names an
// off-instance host, but nothing is fetched from one: api/assets.js:35 refuses that by default.
test('55: the e2e hook wins over the row\'s own url and rebuilds it from the name', async () => {
  const h = load({ session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.fn.attachmentSrc({ name: 'a.png', url: 'https://app.testomat.io/a.png' }),
    'http://127.0.0.1:8080/a.png');
});

test('55a: …and a nameless row still resolves against it rather than falling back', async () => {
  const h = load({ session: { stepShotHook: 'http://127.0.0.1:8080/x/' } });
  assert.equal(await h.fn.attachmentSrc({ url: 'https://app.testomat.io/a.png' }),
    'http://127.0.0.1:8080/x/');
});

test('56: a session store that throws answers no hook, and the thumbnail still resolves', async () => {
  const h = load({ sessionThrows: true, session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.fn.shotHookBase(), '');
  assert.equal(await h.fn.attachmentSrc({ url: 'U' }), 'U');
});

test('56a: …and so does a panel with no chrome at all', async () => {
  const h = load({ hasChrome: false, session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.fn.shotHookBase(), '');
  assert.equal(await h.fn.attachmentSrc({ url: 'U' }), 'U');
});

// ===================== parsing the steps out of a description (rows 110-120) =====================

test('110: a Steps heading and two bullets are two step rows, numbered from zero', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.twoSteps));
  assert.deepEqual(rowsOf(rows), [
    { kind: 'step', pos: 0, index: 0, title: 'Open the site', expected: '', state: 'unset' },
    { kind: 'step', pos: 1, index: 1, title: 'Click Login', expected: '', state: 'unset' },
  ]);
});

test('111: a nested Expected bullet is lifted out, removed, and does not renumber the step after it', () => {
  const h = load();
  const container = h.fixture(MD.nestedExpected);
  const rows = h.fn.parseSteps(container);
  assert.deepEqual(rowsOf(rows).map((r) => [r.pos, r.expected]), [[0, 'Expected: green banner'], [2, '']]);
  // pos 2, not 1: the index was snapshotted over the <li>s the web counts, before the fold.
  assert.equal(container.querySelectorAll('li').length, 2);
});

test('112: the list that held nothing but the Expected bullet goes with it', () => {
  const h = load();
  const container = h.fixture(MD.onlyExpected);
  h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('ul').length, 1); // the steps list, and no empty leftover
});

test('112a: a list that still has a bullet in it stays', () => {
  const h = load();
  const container = h.fixture(MD.bothSpellings.replace('<li>Expected: a</li>', '<li>Expected: a</li><li>keep me</li>'));
  h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('ul').length, 2); // the steps list plus the surviving sub-list
});

test('113: a bolded "Expected Result" mid-sentence lifts the whole tail out of the step title', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.inlineExpected));
  assert.deepEqual(rowsOf(rows).map((r) => [r.title, r.expected]), [
    ['Do X.', 'Expected Result: Y.'],
    ['Click Login', ''],
  ]);
});

test('114: both spellings of the label match', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.bothSpellings));
  assert.deepEqual(plain([...rows].map((r) => r.expected)), ['Expected: a', 'Expected Results: b']);
});

test('114a: a bullet that merely starts with the same letters is not the label', () => {
  const h = load();
  const container = h.fixture(MD.notExpected);
  const rows = h.fn.parseSteps(container);
  assert.equal(rows[0].expected, '');
  assert.equal(container.querySelectorAll('li').length, 2); // and it is left in the document
});

test('115: a soft line break is read as a space, never glued into one word', () => {
  const h = load();
  const container = h.fixture(MD.softBreak);
  const raw = container.querySelector('li').textContent;
  const rows = h.fn.parseSteps(container);
  assert.equal(rows[0].title, 'line one line two');
  assert.equal(raw, 'line oneline two'); // what textContent alone would have said: one word out of two
});

test('116: showdown\'s disabled task checkbox is removed — the control is the mark', () => {
  const h = load();
  const container = h.fixture(MD.taskItem);
  assert.equal(container.querySelectorAll('input').length, 1); // it really was there
  const rows = h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('input').length, 0);
  assert.equal(rows[0].title, 'do it');
});

test('117: a bullet list under another heading is an item row, listed after every step', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.stepsThenNotes));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.index, r.title]), [
    ['step', 0, 0, 'Open the site'],
    ['step', 1, 1, 'Click Login'],
    ['item', 2, 0, 'a note'],
  ]);
  assert.equal(rows[2].li.classList.contains('step-item'), true);
  assert.equal(rows[0].li.classList.contains('step-item'), false);
});

test('118: a bullet nested under a step counts in pos — and today it is listed as an item too', () => {
  const h = load();
  const container = h.fixture(MD.nestedPlain);
  const rows = h.fn.parseSteps(container);
  // The nested guard reads the grandparent, and wrapRow has already moved the step's sub-list under
  // a <div> by the time it runs, so the bullet no longer looks nested to it.
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.title]), [
    ['step', 0, 'Open the site'],
    ['step', 2, 'Click Login'],
    ['item', 1, 'not expected at all'],
  ]);
  assert.equal(container.querySelectorAll('li').length, 3); // still in the document, still counted
});

test('118a: the same bullet nested under an ITEM is dropped — that row is not wrapped yet', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.nestedItem));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.title]), [
    ['item', 0, 'a note'], ['item', 2, 'another'],
  ]);
});

test('119: a description with no Steps-like heading has no steps — everything is an item', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.noStepsHeading));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.index]), [['item', 0, 0], ['item', 1, 1]]);
  assert.equal([...rows].every((r) => r.li.classList.contains('step-item')), true);
});

test('119a: the same two lists under a Steps heading ARE steps', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.noStepsHeading.replace('Notes</h2>', 'Steps</h2>')));
  assert.deepEqual(plain([...rows].map((r) => r.kind)), ['step', 'step']);
});

test('120: a description that is blank or only spaces draws the No description state', () => {
  const h = load({ jwt: false });
  h.state.currentSteps = ['untouched'];
  for (const md of ['', '   ', null]) {
    h.fn.renderSteps(md, { id: 7 });
    assert.deepEqual(plain(h.state.currentSteps), ['untouched']);
    assert.equal(h.node['test-steps'].textContent, 'No description');
  }
  assert.deepEqual(h.calls.empties.map((e) => e.title), ['No description', 'No description', 'No description']);
});

test('120a: a description with something in it replaces the steps and draws no empty state', () => {
  const h = load({ jwt: false, md: { '## Steps\n- a': MD.twoSteps } });
  h.fn.renderSteps('## Steps\n- a', { id: 7 });
  assert.equal(h.state.currentSteps.length, 2);
  assert.deepEqual(h.calls.empties, []);
  assert.equal(h.node['test-steps'].querySelectorAll('li').length, 2);
  // The body is hydrated BEFORE it reaches the document, and the group released first.
  assert.deepEqual(h.calls.order.filter((c) => c !== 'Md.render'), ['release:test-description', 'hydrate']);
});

// ===================== the example row and its badge (rows 121-125) =====================

const withExample = (params, example) => detail({ test: { params }, example });

test('121: a parameter is replaced by the row\'s value, in the double quotes the product uses', () => {
  const h = load({ testrunDetail: withExample(['user'], ['ann']) });
  assert.equal(h.fn.applyExample('Login as ${user}'), 'Login as "ann"');
});

test('122: a column named "0" or blank is not a parameter, and its own placeholder is left alone', () => {
  // The placeholder names that very column, so only the non-"0"/non-blank rule can leave it standing.
  for (const [params, text] of [[['0'], 'Login as ${0}'], [['  '], 'Login as {{  }}']]) {
    const h = load({ testrunDetail: withExample(params, ['ann']) });
    assert.equal(h.fn.applyExample(text), text);
  }
});

test('122b: a usable column beside an unusable one is substituted, and only it', () => {
  const h = load({ testrunDetail: withExample(['user', '0'], ['ann', 'zero']) });
  assert.equal(h.fn.applyExample('Login as ${user} at ${0}'), 'Login as "ann" at ${0}');
});

test('122a: …and an example row that is missing or empty stops substitution too', () => {
  assert.equal(load({ testrunDetail: withExample(['user'], []) }).fn.applyExample('Hi ${user}'), 'Hi ${user}');
  assert.equal(load({ testrunDetail: withExample(['user'], null) }).fn.applyExample('Hi ${user}'), 'Hi ${user}');
});

test('123: under JWT a leftover placeholder on an unparametrized test hides the badge', () => {
  const h = load({ jwt: true, testrunDetail: withExample(['0'], ['ann']) });
  h.fn.applyExample('Hi {{x}}');
  assert.equal(h.node['example-badge'].hidden, true);
});

test('123a: …and shows it once the test IS parametrized and a placeholder survived', () => {
  const h = load({ jwt: true, testrunDetail: withExample(['user'], []) });
  h.fn.applyExample('Hi ${user}');
  assert.equal(h.node['example-badge'].hidden, false);
});

test('124: degraded, the leftover placeholder is the only signal there is, so it alone shows the badge', () => {
  const h = load({ jwt: false, testrunDetail: withExample(['0'], ['ann']) });
  h.fn.applyExample('Hi ${x}');
  assert.equal(h.node['example-badge'].hidden, false);
  // …and a description with nothing left over still hides it.
  h.fn.applyExample('Hi there');
  assert.equal(h.node['example-badge'].hidden, true);
});

test('125: a page with no badge element does not throw', () => {
  const h = load({ without: ['example-badge'] });
  assert.equal(h.fn.applyExample('Hi ${x}'), 'Hi ${x}');
});

// ===================== what the summary card decides to show (rows 126-128) =====================

test('126: a pending result, or none at all, hides the whole card and takes the tab dot off', () => {
  for (const attrs of [{ status: 'pending' }, {}, null]) {
    const h = load({ testrunDetail: attrs === null ? null : detail(attrs) });
    h.node['test-summary'].hidden = false;
    h.node['tab-test-summary'].append(el('span', { className: 'status-dot' }));
    h.fn.renderResultSummary();
    assert.equal(h.node['test-summary'].hidden, true);
    assert.equal(h.node['test-result-row'].hidden, true);
    assert.equal(h.node['tab-test-summary'].querySelectorAll('.status-dot').length, 0);
    assert.equal(h.calls.empties.at(-1).title, 'Nothing reported yet');
    // Every group the card was holding goes with it — a failure body's images included.
    for (const g of ['summary-shots', 'summary-artifacts', 'summary-failure']) {
      assert.ok(h.calls.releases.includes(g), g);
    }
  }
});

test('127: a marked test the run left nothing behind on keeps the card shut and says so', () => {
  const h = load({ testrunDetail: detail({ status: 'passed' }) });
  h.fn.renderResultSummary();
  assert.equal(h.node['test-summary'].hidden, true);
  assert.equal(h.node['test-result-row'].hidden, false); // the verdict line itself still shows
  assert.equal(h.calls.empties.at(-1).title, 'Nothing behind this result');
  assert.equal(h.node['tab-test-summary'].querySelectorAll('.status-dot').length, 0);
  assert.equal(h.node['summary-status'].textContent, 'Passed');
});

test('128: a failure with a message opens the card, dots the tab and prints the run time', () => {
  const h = load({ testrunDetail: detail({ status: 'failed', message: 'boom', 'run-time': 1200 }) });
  h.fn.renderResultSummary();
  assert.equal(h.node['test-result-row'].hidden, false);
  assert.equal(h.node['summary-duration'].textContent, '· 1.2s');
  assert.equal(h.node['test-summary'].hidden, false);
  assert.equal(h.node['tab-test-summary'].querySelector('.status-dot').dataset.status, 'failed');
  assert.equal(h.node['summary-status'].dataset.status, 'failed');
});

test('128a: with no run-time the duration line is empty, not a stray dot', () => {
  const h = load({ testrunDetail: detail({ status: 'failed', message: 'boom' }) });
  h.fn.renderResultSummary();
  assert.equal(h.node['summary-duration'].textContent, '');
});

// ===================== the failure body (rows 129-132) =====================

test('129: a reporter message is text, and its whitespace is the information', () => {
  const h = load();
  h.fn.renderSummaryFailure({ status: 'failed', automated: true, message: '\n  line one\n    indented\n\n' });
  // Trimmed on the way in — verbatim INSIDE the trim, so the indentation of line two survives.
  assert.equal(h.node['summary-message'].textContent, 'line one\n    indented');
  assert.equal(h.node['summary-message'].className, 'summary-message is-failed code is-raw');
  assert.deepEqual(h.calls.renders, []); // never through the markdown renderer
});

test('129a: a passing automated result is a Log, not a Failure, and it is not tinted red', () => {
  const h = load();
  h.fn.renderSummaryFailure({ status: 'passed', automated: true, message: 'all good' });
  assert.equal(h.node['summary-failure-title'].textContent, 'Log');
  assert.equal(h.node['summary-message'].className, 'summary-message is-ok code is-raw');
});

test('130: a human\'s message is Markdown, appended as nodes under the sections classes', () => {
  const h = load({ md: { '# heading\n\nbody text': MD.headingBody } });
  h.fn.renderSummaryFailure({ status: 'failed', message: '# heading\n\nbody text' });
  assert.deepEqual(h.calls.renders, ['# heading\n\nbody text']);
  assert.equal(h.node['summary-message'].className, 'summary-message is-failed markdown sections');
  assert.equal(h.node['summary-message'].querySelector('h1').textContent, 'heading');
  assert.equal(h.node['summary-failure-title'].textContent, 'Failure');
  assert.equal(h.node['summary-failure'].hidden, false);
});

// 131: a manual body goes through the same hydrate every other Md.render site uses (renderSteps
// :365-368, editor.js:140,805) — the CSP allows no remote <img>, so an unhydrated one is a broken box.
const FAIL_MSG = 'it broke\n\n![px](https://evil.test/px.png)';

test('131: a remote image in a manual failure message is hydrated like every other body', () => {
  const h = load({ md: { [FAIL_MSG]: MD.remoteImage } });
  h.fn.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  // Its own group: summary-shots is released when the step tree repaints, which would revoke
  // these while the failure body is still on screen.
  assert.deepEqual(h.calls.hydrates, ['summary-failure']);
  // Freed before the new body is built, so the previous message's object URLs never outlive it.
  assert.deepEqual(h.calls.order.filter((o) => o === 'hydrate' || o === 'release:summary-failure'),
    ['release:summary-failure', 'hydrate']);
});

test('131a: the body it holds is released before the next one replaces it', () => {
  const h = load({ md: { [FAIL_MSG]: MD.remoteImage } });
  h.fn.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  h.calls.releases.length = 0;
  h.fn.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  assert.ok(h.calls.releases.includes('summary-failure'));
});

test('131b: an AUTOMATED body is not markdown, so it is neither rendered nor hydrated', () => {
  const h = load();
  h.fn.renderSummaryFailure({ status: 'failed', automated: true, message: '  expected 1\n  got 2  ' });
  assert.deepEqual(h.calls.hydrates, []);
  assert.equal(h.node['summary-message'].textContent, 'expected 1\n  got 2'); // trimmed, not reflowed
});

test('132: a message of nothing but spaces hides the section and paints no title', () => {
  const h = load();
  h.node['summary-failure'].hidden = false;
  h.fn.renderSummaryFailure({ status: 'failed', message: '   ' });
  assert.equal(h.node['summary-failure'].hidden, true);
  assert.equal(h.node['summary-message'].childNodes.length, 0);
  assert.equal(h.node['summary-failure-title'].textContent, 'Failure'); // the markup's own default, untouched
  assert.equal(h.node['summary-message'].className, 'summary-message'); // …and no is-failed / is-ok
});

test('132a: a message with anything in it shows the section', () => {
  const h = load();
  h.fn.renderSummaryFailure({ status: 'failed', automated: true, message: ' x ' });
  assert.equal(h.node['summary-failure'].hidden, false);
  assert.equal(h.node['summary-message'].textContent, 'x');
});

// ===================== environment meta (rows 133-134) =====================

test('133: the run\'s own bookkeeping entries never reach the tester', () => {
  const h = load();
  h.fn.renderSummaryMeta({ extras: [{ source: 'system', key: 'duration' }, { key: 'Browser', value: 'Chrome' }] });
  const body = h.node['summary-meta-body'];
  assert.deepEqual(body.children.map((n) => [n.tagName, n.textContent]), [['DT', 'Browser'], ['DD', 'Chrome']]);
  assert.equal(h.node['summary-meta-count'].textContent, '1');
  assert.equal(h.node['summary-meta'].hidden, false);
});

test('133a: an entry with no key is dropped too, and an empty section is hidden', () => {
  const h = load();
  h.fn.renderSummaryMeta({ extras: [{ value: 'orphan' }, null] });
  assert.equal(h.node['summary-meta'].hidden, true);
  assert.equal(h.node['summary-meta-body'].children.length, 0);
});

test('134: a value that is missing prints nothing, not the word null', () => {
  const h = load();
  h.fn.renderSummaryMeta({ extras: [{ key: 'A', value: null }, { key: 'B', value: 0 }, { key: 'C', value: false }] });
  const dds = h.node['summary-meta-body'].children.filter((n) => n.tagName === 'DD');
  assert.deepEqual(dds.map((n) => n.textContent), ['', '0', 'false']);
});

// ===================== the artifacts fold (row 135) =====================

test('135: a row with neither an address nor a name is not a file, and an empty fold is released', () => {
  const h = load();
  h.node['summary-artifacts-body'].append(el('li', {}, 'stale'));
  h.fn.renderSummaryArtifacts({ attachments: [{}, { size: 12 }, null] });
  assert.equal(h.node['summary-artifacts'].hidden, true);
  assert.equal(h.node['summary-artifacts-body'].children.length, 0);
  assert.deepEqual(h.calls.releases, ['summary-artifacts']);
});

test('135a: a row with only a name survives and the fold opens', async () => {
  const h = load();
  h.fn.renderSummaryArtifacts({ attachments: [{ name: 'report' }] });
  await settle();
  assert.equal(h.node['summary-artifacts'].hidden, false);
  assert.equal(h.node['summary-artifacts-count'].textContent, '1');
  assert.equal(h.node['summary-artifacts-body'].querySelector('.file-tile').dataset.kind, 'file');
});

// ===================== the reported steps section (rows 136-138) =====================

test('136: an automated result advertises a count and the list waits for the tester to ask', async () => {
  const h = load({ testrunDetail: detail({ steps: [], sections: { steps: { count: 3 } } }) });
  h.fn.renderSummaryStepsSection({ steps: [], sections: { steps: { count: 3 } } });
  assert.equal(h.screen.summarySteps, null);
  assert.equal(h.node['summary-steps'].hidden, false);
  assert.equal(h.node['summary-steps-count'].textContent, '3');
  assert.deepEqual(h.calls.requests, []); // shut: nothing fetched yet
  h.fn.toggleSummaryDisclosure('steps');
  await settle();
  assert.deepEqual(h.calls.requests, ['/testruns/55/steps']);
});

test('136a: a manual result carries its steps inline and never asks the server', async () => {
  const h = load();
  h.fn.renderSummaryStepsSection({ steps: [{ title: 'a', status: 'passed' }] });
  await settle();
  assert.equal(h.screen.summarySteps.length, 1);
  assert.equal(h.node['summary-steps-count'].textContent, '1');
  assert.deepEqual(h.calls.requests, []);
});

test('136b: no inline steps and nothing advertised hides the section', () => {
  const h = load();
  h.fn.renderSummaryStepsSection({});
  assert.equal(h.node['summary-steps'].hidden, true);
});

test('137: a read that lands after the tester paged on paints nothing', async () => {
  const gate = deferred();
  const h = load({ stepsDoc: () => gate.promise });
  const body = h.node['summary-steps-body'];
  h.fn.loadSummarySteps();
  await settle();
  assert.equal(body.querySelectorAll('.sk-lines').length, 1); // the placeholder it drew
  h.state.currentRecordId = '56';
  gate.resolve({ steps: [{ title: 'a' }] });
  await settle();
  assert.equal(h.screen.summarySteps, null);
  assert.equal(body.querySelectorAll('.sk-lines').length, 1); // still only the placeholder
});

test('137a: …and the same read for the test still open does paint', async () => {
  const h = load({ stepsDoc: { steps: [{ title: 'a', status: 'passed' }] } });
  h.fn.loadSummarySteps();
  await settle();
  assert.equal(h.screen.summarySteps.length, 1);
  assert.equal(h.node['summary-steps-body'].querySelector('.summary-step-title').textContent, 'a');
});

test('138: a read that failed says so in the body', async () => {
  const h = load({ stepsDoc: () => { throw new Error('502'); } });
  h.fn.loadSummarySteps();
  await settle();
  assert.equal(h.node['summary-steps-body'].textContent, "Couldn't load the reported steps");
});

test('138a: a failure for a test the tester already left is not written over the new one', async () => {
  const gate = deferred();
  const h = load({ stepsDoc: () => gate.promise });
  h.fn.loadSummarySteps();
  await settle();
  h.state.currentRecordId = '56';
  gate.reject(new Error('502'));
  await settle();
  assert.equal(h.node['summary-steps-body'].querySelectorAll('.sk-lines').length, 1);
});

// ===================== presigning an artifact (rows 139-140) =====================

test('139: a flagged URL is signed once and remembered', async () => {
  const h = load();
  const row = { needs_presign: true, url: 'U', name: 'a.png' };
  const first = await h.fn.artifactSigned(row);
  const second = await h.fn.artifactSigned(row);
  assert.deepEqual(h.calls.presigns, ['U']);
  assert.equal(first.url, 'https://signed.test/a');
  assert.equal(first.display_url, 'https://signed.test/a');
  assert.equal(second.url, 'https://signed.test/a');
});

test('139a: a row that is not flagged is handed straight back, unsigned', async () => {
  const h = load();
  const row = { url: 'U' };
  assert.equal(await h.fn.artifactSigned(row), row);
  assert.deepEqual(h.calls.presigns, []);
});

test('140: a refusal is remembered as a refusal, and the raw row keeps the link openable', async () => {
  const h = load({ presign: async () => { throw new Error('403'); } });
  const row = { needs_presign: true, url: 'U' };
  const out = await h.fn.artifactSigned(row);
  assert.equal(out, row); // the same object: url 'U', still openable
  assert.equal(h.screen.artifactPresigned.get('U'), '');
  await h.fn.artifactSigned(row);
  assert.deepEqual(h.calls.presigns, ['U']); // asked once, never again
});

// ===================== links, the viewer and the tiles (rows 141-146, 159) =====================

// 141: the url is server data, so it is resolved and then checked — the same rule ciBuildLink
// (run-view.js:679-682) applies to the same kind of value on the same kind of element.
test('141: an attachment url that is not http(s) never becomes an href', () => {
  const h = load();
  const link = h.fn.attachmentLink({ name: 'a', url: 'javascript:alert(1)' });
  assert.equal(link.tagName, 'SPAN');
  assert.equal(link.getAttribute('href'), null);
  assert.equal(link.textContent, 'a'); // refused, but the name is still shown
});

test('141a: an ordinary address is still an anchor that opens safely', () => {
  const h = load();
  const link = h.fn.attachmentLink({ name: 'a', url: 'https://app.testomat.io/f.png' });
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'https://app.testomat.io/f.png');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('141b: a ROOT-RELATIVE address resolves against the instance instead of the extension', () => {
  const h = load();
  const link = h.fn.attachmentLink({ name: 'a', url: '/rails/active_storage/x.png' });
  // Unresolved it would have pointed at chrome-extension://<id>/rails/… — a dead link.
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'https://app.testomat.io/rails/active_storage/x.png');
});

test('142: a row with no address is a span, so there is nothing to click', () => {
  const h = load();
  const span = h.fn.attachmentLink({ name: 'a' });
  assert.equal(span.tagName, 'SPAN');
  assert.equal(span.getAttribute('href'), null);
  assert.equal(span.className, 'summary-step-att-link');
  assert.equal(span.textContent, 'a');
  assert.equal(h.fn.attachmentLink({}).textContent, 'attachment');
});

test('142a: …and one with an address is an anchor that leaves the panel safely', () => {
  const h = load();
  const a = h.fn.attachmentLink({ name: 'a', url: 'https://h/a.txt' });
  assert.equal(a.tagName, 'A');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
});

test('143: the viewer message names the file type under `mime` — `type` is the worker\'s own route', async () => {
  const h = load();
  h.fn.openFileViewer({ name: 'x', type: 'image/png' }, 'U');
  await settle();
  assert.deepEqual(h.calls.sends, [{ type: 'OPEN_FILE_OVERLAY', url: 'U', name: 'x', mime: 'image/png' }]);
  assert.deepEqual(h.calls.opened, []);
});

test('143a: with no resolved url it falls back to the attachment\'s own address', async () => {
  const h = load();
  h.fn.openFileViewer({ type: 'image/png', display_url: 'D', url: 'U' });
  await settle();
  assert.equal(h.calls.sends[0].url, 'D');
});

test('144: a worker that never answers hands the file to a new tab instead', async () => {
  const h = load({ sendFails: true });
  h.fn.openFileViewer({ name: 'x' }, 'U');
  await settle();
  assert.deepEqual(h.calls.opened, [['U', '_blank', 'noopener']]);
});

test('144a: …and so does a panel with no runtime to send through', () => {
  const h = load({ runtime: false });
  h.fn.openFileViewer({ name: 'x' }, 'U');
  assert.deepEqual(h.calls.opened, [['U', '_blank', 'noopener']]);
  assert.deepEqual(h.calls.sends, []);
});

test('145: an attachment with no address at all opens nothing', async () => {
  const h = load();
  h.fn.openFileViewer({});
  await settle();
  assert.deepEqual(h.calls.sends, []);
  assert.deepEqual(h.calls.opened, []);
});

test('146: an image tile whose bytes never arrive becomes a file card, badge and all', async () => {
  const h = load({ imgLoad: async () => false });
  const btn = h.fn.fileTile({ type: 'image/png', name: 'shot.png', url: 'U' }, 'g', '');
  assert.equal(btn.dataset.kind, 'image');
  await settle();
  assert.equal(btn.dataset.kind, 'file');
  assert.equal(btn.querySelector('.file-tile-badge').textContent, 'PNG');
  assert.equal(btn.querySelectorAll('img').length, 0);
});

test('146a: one whose bytes do arrive stays an image', async () => {
  const h = load({ imgLoad: async () => true });
  const btn = h.fn.fileTile({ type: 'image/png', name: 'shot.png', url: 'U' }, 'g', '');
  await settle();
  assert.equal(btn.dataset.kind, 'image');
  assert.equal(btn.querySelectorAll('img').length, 1);
  assert.equal(btn.querySelectorAll('.file-tile-badge').length, 0);
});

test('146b: a video and a plain file are cards from the start and are never fetched', async () => {
  const h = load();
  assert.equal(h.fn.fileTile({ name: 'take.webm' }, 'g', '').dataset.kind, 'video');
  assert.equal(h.fn.fileTile({ name: 'notes.txt' }, 'g', '').dataset.kind, 'file');
  await settle();
  assert.deepEqual(h.calls.loads, []);
});

// 159: both call sites hand ImgHydrate.load no options, and that is the SAFE shape — fetchAsset's
// `instanceOnly` defaults to true (api/assets.js:35), so an off-instance host is refused for them.
test('159: a thumbnail and a tile pass no fetch options, which is instance-only by default', async () => {
  const h = load();
  h.fn.attachmentThumb('g', { name: 'a.png', url: 'https://evil.test/a.png' }, () => {});
  h.fn.fileTile({ type: 'image/png', name: 'b.png', url: 'https://evil.test/b.png' }, 'g', '');
  await settle();
  assert.deepEqual(h.calls.loads, [
    { group: 'g', src: 'https://evil.test/a.png', opts: null },
    { group: 'g', src: 'https://evil.test/b.png', opts: null },
  ]);
  // An opt-out would have to be written here to exist: tests/api-errors-auth.test.mjs owns the refusal.
  assert.deepEqual(h.calls.loads.filter((l) => l.opts && l.opts.instanceOnly === false), []);
});
