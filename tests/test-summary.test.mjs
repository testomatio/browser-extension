#!/usr/bin/env node
// What extension/sidepanel/screens/test-summary.js SHOWS the tester: everything the last automated
// run left behind the verdict — how long it took, the failure text, the environment meta, the
// reported step tree, the screenshots and the other files. These rows were half B of
// tests/test-view-read.test.mjs until the card became its own file; the steps a tester is about to
// run through stayed there, and the write path is tests/test-view-write.test.mjs.
// Two things here are easy to get quietly wrong. The failure body has two readers: a reporter's
// assertion output, where the whitespace IS the information, and a human's Markdown, which goes
// through the sanitizer and must be hydrated before it reaches the document. And a file's address
// has two forms — `display_url` is the inline one an IMAGE has, and anything else would get a
// file-type icon from it, so only `url` ever opens the file itself.
// Rows 30-56, 126-146 and 159 are the ticket's; a lettered suffix is the companion case that drives
// the same path the other way, so a row asserting "nothing happened" cannot pass against a stub that
// never worked.
// Run: node --test tests/test-summary.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeWindow, makeDocument, el, plain, settle } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The REAL one, not a stub: the rows below assert the duration a tester reads, and a fake would
// let them pass against a wording the panel never prints. tests/format.test.mjs owns its cases.
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const Fmt = runInNewContext(`${readFileSync(join(CORE_SRC, 'format.js'), 'utf8')}\nFmt;`, {});

// ---------- what Md.render really emits ----------
// Captured once from the real pipeline (vendor/showdown.min.js + shared/html-sanitize.js +
// shared/markdown.js over the mini-DOM) and frozen here: markdown.js needs a `showdown` global and a
// lexical `sanitizeHtml` from another file, so it is not reachable beside a screen. These strings are
// what the tester's failure message actually becomes.
const MD = {
  headingBody: '<h1 id="heading">heading</h1>\n<p>body text</p>',
  // '![px](https://evil.test/px.png)' — a markdown image survives the sanitizer with its host intact
  remoteImage: '<p>it broke</p>\n<p><img src="https://evil.test/px.png" alt="px"></p>',
};

// A promise this file resolves by hand: the reported-steps rows are about which answer lands second.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// index.html's shape (:611, :639, :645, :749-794), cut to the nodes this card touches. The
// disclosure heads live INSIDE their wrap because summaryStepsTools() inserts itself after the head
// and then looks for itself under the wrap.
function makePage() {
  const doc = makeDocument([]);
  const node = {};
  const add = (tag, id, props = {}) => {
    node[id] = el(tag, { id, ...props });
    return node[id];
  };
  const wrap = (tag, id, props, ...kids) => {
    const box = add(tag, id, props);
    box.append(...kids);
    return box;
  };
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
  doc.body.append(tab, row, empty, box);
  // mini-dom has no after(); summaryStepsTools() parks its two buttons beside the head with it.
  for (const head of ['summary-steps-head', 'summary-failure-head']) {
    const h = node[head];
    h.after = (n) => h.parentElement.insertBefore(n, h.nextSibling);
  }
  return { doc, node };
}

// The panel globals test-summary.js reads, all of them real enough to be driven. They live here and
// not in the harness: every screen has its own set. There is no `capabilities` in this list, and no
// `Dropdown` and no `OfflineQueue` — the card asks the session nothing and writes nothing.
function load(opts = {}) {
  const o = {
    hasChrome: true,
    runtime: true,        // false — a chrome that cannot send a message
    currentRecordId: '55',
    testrunDetail: null,
    session: {},          // chrome.storage.session's seed — `stepShotHook` lives here
    sessionThrows: false,
    md: {},               // markdown source -> the html Md.render answers with
    presign: async () => 'https://signed.test/a',
    stepsDoc: { steps: [] }, // what GET /testruns/{id}/steps answers, or a function
    imgLoad: async () => true,
    ...opts,
  };

  const { doc, node } = makePage();
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
    hasChrome: o.hasChrome,
    chrome: chromeStub,
    $: (id) => doc.getElementById(id),
    Fmt,
    // shared/markdown.js's `render`, off the frozen snapshots above.
    Md: {
      render: (md) => {
        calls.renders.push(md);
        calls.order.push('Md.render');
        const boxEl = doc.createElement('div');
        boxEl.innerHTML = o.md[md] !== undefined ? o.md[md] : `<p>${String(md)}</p>`;
        return boxEl;
      },
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
    // test-view.js:289-296, verbatim: the step dot and the tri-state control wear the same mark, and
    // a stub that always drew one would let the reported tree's `unset` ring pass for free.
    paintStepMark: (target, status, size, unset = '') => {
      const name = { passed: 'check', failed: 'close', skipped: 'remove' }[status] || unset;
      target.replaceChildren(...(name ? [globals.svgIcon(name, size)] : []));
    },
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

  const h = loadScreen('test-summary', {
    exported: 'TestSummary',
    document: doc, window: win, store, globals,
  });

  return { ...h, mod: h.screen, state, calls, node, store, doc };
}

const detail = (attributes) => ({ data: { attributes } });

// ===================== the reported-step tree (rows 30-34) =====================

test('30: a sub-step becomes a child node', () => {
  const h = load();
  const tree = h.mod.stepTree([{ title: 'a', steps: [{ title: 'b' }] }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'a');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].name, 'b');
  assert.equal(tree[0].children[0].children, null);
});

test('31: files move into a child "Attachments" group, off the step itself', () => {
  const h = load();
  const atts = [{ name: 'x.png' }];
  const [nodeOut] = h.mod.stepTree([{ title: 'a', attachments: atts }]);
  assert.equal(nodeOut.attachments, null);
  assert.equal(nodeOut.isImage, true);
  assert.deepEqual(plain(nodeOut.children), [{ name: 'Attachments', attachments: [{ name: 'x.png' }], children: null }]);
});

test('32: an empty attachments array grows no group and leaves the step a leaf', () => {
  const h = load();
  const [nodeOut] = h.mod.stepTree([{ title: 'a', attachments: [] }]);
  assert.equal(nodeOut.children, null);
  assert.equal(nodeOut.isImage, false);
  assert.deepEqual(plain(nodeOut.attachments), []); // still the step's own empty list, not nulled
});

test('33: anything that is not a list of steps is no steps at all', () => {
  const h = load();
  for (const v of [null, undefined, 'x', 42, { steps: [] }]) assert.deepEqual(plain(h.mod.stepTree(v)), []);
});

test('34: sub-steps come first and the Attachments group last', () => {
  const h = load();
  const [nodeOut] = h.mod.stepTree([{ title: 'a', steps: [{ title: 'b' }], attachments: [{ name: 'x.png' }] }]);
  assert.deepEqual(nodeOut.children.map((c) => c.name), ['b', 'Attachments']);
});

test('34a: the fields the web transform carries ride along untouched', () => {
  const h = load();
  const [nodeOut] = h.mod.stepTree([{ title: 'a', category: 'hook', duration: '12', log: 'L', error: 'E', status: 'failed' }]);
  assert.deepEqual(plain(nodeOut), {
    name: 'a', category: 'hook', duration: '12', log: 'L', error: 'E', status: 'failed',
    children: null, isImage: false,
  });
});

// ===================== linkifying a reporter's log (rows 35-41) =====================

const linked = (h, source) => {
  const host = h.doc.createElement('div');
  h.mod.linkifyInto(host, source);
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
  assert.equal(h.mod.isImage({ type: 'image/png' }), true);
  assert.equal(h.mod.isImage({ type: 'text/plain' }), false);
});

test('43: SVG is excluded, however it is spelled', () => {
  const h = load();
  assert.equal(h.mod.isImage({ type: 'image/svg+xml' }), false);
  assert.equal(h.mod.isImage({ type: 'image/SVG+XML' }), false);
});

test('44: a declared MIME type wins over the name, even when the name says .png', () => {
  const h = load();
  assert.equal(h.mod.isImage({ type: 'application/octet-stream', name: 'a.png' }), false);
  // …and with the type gone the same row is an image, so the name fallback is really reachable.
  assert.equal(h.mod.isImage({ name: 'a.png' }), true);
});

test('45: with no type at all the name decides, case and all', () => {
  const h = load();
  assert.equal(h.mod.isImage({ name: 'a.JPEG' }), true);
  assert.equal(h.mod.isImage({ name: 'a.avif' }), true);
  assert.equal(h.mod.isImage({ name: 'a.png.txt' }), false); // anchored at the end
});

test('46: a video needs EITHER tell — a bucket that serves a screencast as bytes is still a video', () => {
  const h = load();
  assert.equal(h.mod.isVideo({ type: 'application/octet-stream', name: 'take.webm' }), true);
  assert.equal(h.mod.isVideo({ type: 'video/webm' }), true);
  assert.equal(h.mod.isVideo({ type: 'application/octet-stream', name: 'take.txt' }), false);
});

test('47: a query string after the extension does not hide it', () => {
  const h = load();
  assert.equal(h.mod.isVideo({ url: 'https://h/f.mp4?sig=1' }), true);
  assert.equal(h.mod.isVideo({ url: 'https://h/f.mp4#t=2' }), true);
  assert.equal(h.mod.isVideo({ url: 'https://h/f.mp4x' }), false);
});

test('48: the badge is the LAST extension, not the first', () => {
  const h = load();
  assert.equal(h.mod.fileExt({ name: 'archive.tar.gz' }), 'GZ');
});

test('49: it comes off a URL too, upper-cased, with the query left behind', () => {
  const h = load();
  assert.equal(h.mod.fileExt({ url: 'https://h/a/file.PNG?x=1' }), 'PNG');
  assert.equal(h.mod.fileExt({ name: 'shot.png', url: 'https://h/other.gif' }), 'PNG'); // the name is asked first
});

test('50: an extension is at most five characters — six is not one, and the tile says FILE instead', () => {
  const h = load();
  assert.equal(h.mod.fileExt({ name: 'archive.tarball' }), '');
  assert.equal(h.mod.fileExt({ name: 'a.plist' }), 'PLIST'); // five: the boundary itself
  assert.equal(h.mod.fileExt({ name: 'a.sqlite' }), '');     // six: one over
  assert.equal(h.mod.fileExt({}), '');
});

test('50a: …and the tile badge falls back to FILE when there is no usable extension', () => {
  const h = load();
  const badge = (att) => h.mod.fileTile(att, 'g', '').querySelector('.file-tile-badge').textContent;
  assert.equal(badge({ name: 'archive.tarball' }), 'FILE');
  assert.equal(badge({ name: 'notes.txt' }), 'TXT');
});

test('51: an image opens at its inline address', () => {
  const h = load();
  assert.equal(h.mod.href({ type: 'image/png', display_url: 'D', url: 'U' }), 'D');
  assert.equal(h.mod.href({ type: 'image/png', url: 'U' }), 'U'); // …and falls back to its own
});

test('52: anything else never uses display_url — the server answers a type icon there', () => {
  const h = load();
  assert.equal(h.mod.href({ type: 'text/plain', display_url: 'D', url: 'U' }), 'U');
});

test('53: a row with no address at all answers the empty string, never undefined', () => {
  const h = load();
  assert.equal(h.mod.href({}), '');
  assert.equal(h.mod.href(null), '');
});

// ===================== where a thumbnail's bytes come from (rows 54-56) =====================

test('54: with no hook set the instance\'s own URL is asked first', async () => {
  const h = load();
  assert.equal(await h.mod.src({ url: 'U', display_url: 'D' }), 'U');
  assert.equal(await h.mod.src({ display_url: 'D' }), 'D'); // …and display_url when there is none
  assert.equal(await h.mod.src({}), '');
});

// 55: the e2e hook outranks the row's own url, by name, against the hook as the base. It names an
// off-instance host, but nothing is fetched from one: api/assets.js:35 refuses that by default.
test('55: the e2e hook wins over the row\'s own url and rebuilds it from the name', async () => {
  const h = load({ session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.mod.src({ name: 'a.png', url: 'https://app.testomat.io/a.png' }),
    'http://127.0.0.1:8080/a.png');
});

test('55a: …and a nameless row still resolves against it rather than falling back', async () => {
  const h = load({ session: { stepShotHook: 'http://127.0.0.1:8080/x/' } });
  assert.equal(await h.mod.src({ url: 'https://app.testomat.io/a.png' }),
    'http://127.0.0.1:8080/x/');
});

test('56: a session store that throws answers no hook, and the thumbnail still resolves', async () => {
  const h = load({ sessionThrows: true, session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.mod.shotHookBase(), '');
  assert.equal(await h.mod.src({ url: 'U' }), 'U');
});

test('56a: …and so does a panel with no chrome at all', async () => {
  const h = load({ hasChrome: false, session: { stepShotHook: 'http://127.0.0.1:8080/' } });
  assert.equal(await h.mod.shotHookBase(), '');
  assert.equal(await h.mod.src({ url: 'U' }), 'U');
});

// ===================== what the summary card decides to show (rows 126-128) =====================

test('126: a pending result, or none at all, hides the whole card and takes the tab dot off', () => {
  for (const attrs of [{ status: 'pending' }, {}, null]) {
    const h = load({ testrunDetail: attrs === null ? null : detail(attrs) });
    h.node['test-summary'].hidden = false;
    h.node['tab-test-summary'].append(el('span', { className: 'status-dot' }));
    h.mod.render();
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
  h.mod.render();
  assert.equal(h.node['test-summary'].hidden, true);
  assert.equal(h.node['test-result-row'].hidden, false); // the verdict line itself still shows
  assert.equal(h.calls.empties.at(-1).title, 'Nothing behind this result');
  assert.equal(h.node['tab-test-summary'].querySelectorAll('.status-dot').length, 0);
  assert.equal(h.node['summary-status'].textContent, 'Passed');
});

test('128: a failure with a message opens the card, dots the tab and prints the run time', () => {
  const h = load({ testrunDetail: detail({ status: 'failed', message: 'boom', 'run-time': 1200 }) });
  h.mod.render();
  assert.equal(h.node['test-result-row'].hidden, false);
  assert.equal(h.node['summary-duration'].textContent, '· 1.2s');
  assert.equal(h.node['test-summary'].hidden, false);
  assert.equal(h.node['tab-test-summary'].querySelector('.status-dot').dataset.status, 'failed');
  assert.equal(h.node['summary-status'].dataset.status, 'failed');
});

test('128a: with no run-time the duration line is empty, not a stray dot', () => {
  const h = load({ testrunDetail: detail({ status: 'failed', message: 'boom' }) });
  h.mod.render();
  assert.equal(h.node['summary-duration'].textContent, '');
});

// ===================== the failure body (rows 129-132) =====================

test('129: a reporter message is text, and its whitespace is the information', () => {
  const h = load();
  h.mod.renderSummaryFailure({ status: 'failed', automated: true, message: '\n  line one\n    indented\n\n' });
  // Trimmed on the way in — verbatim INSIDE the trim, so the indentation of line two survives.
  assert.equal(h.node['summary-message'].textContent, 'line one\n    indented');
  assert.equal(h.node['summary-message'].className, 'summary-message is-failed code is-raw');
  assert.deepEqual(h.calls.renders, []); // never through the markdown renderer
});

test('129a: a passing automated result is a Log, not a Failure, and it is not tinted red', () => {
  const h = load();
  h.mod.renderSummaryFailure({ status: 'passed', automated: true, message: 'all good' });
  assert.equal(h.node['summary-failure-title'].textContent, 'Log');
  assert.equal(h.node['summary-message'].className, 'summary-message is-ok code is-raw');
});

test('130: a human\'s message is Markdown, appended as nodes under the sections classes', () => {
  const h = load({ md: { '# heading\n\nbody text': MD.headingBody } });
  h.mod.renderSummaryFailure({ status: 'failed', message: '# heading\n\nbody text' });
  assert.deepEqual(h.calls.renders, ['# heading\n\nbody text']);
  assert.equal(h.node['summary-message'].className, 'summary-message is-failed markdown sections');
  assert.equal(h.node['summary-message'].querySelector('h1').textContent, 'heading');
  assert.equal(h.node['summary-failure-title'].textContent, 'Failure');
  assert.equal(h.node['summary-failure'].hidden, false);
});

// 131: a manual body goes through the same hydrate every other Md.render site uses (test-view.js's
// renderSteps, editor.js:140,805) — the CSP allows no remote <img>, so an unhydrated one is a broken box.
const FAIL_MSG = 'it broke\n\n![px](https://evil.test/px.png)';

test('131: a remote image in a manual failure message is hydrated like every other body', () => {
  const h = load({ md: { [FAIL_MSG]: MD.remoteImage } });
  h.mod.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  // Its own group: summary-shots is released when the step tree repaints, which would revoke
  // these while the failure body is still on screen.
  assert.deepEqual(h.calls.hydrates, ['summary-failure']);
  // Freed before the new body is built, so the previous message's object URLs never outlive it.
  assert.deepEqual(h.calls.order.filter((o) => o === 'hydrate' || o === 'release:summary-failure'),
    ['release:summary-failure', 'hydrate']);
});

test('131a: the body it holds is released before the next one replaces it', () => {
  const h = load({ md: { [FAIL_MSG]: MD.remoteImage } });
  h.mod.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  h.calls.releases.length = 0;
  h.mod.renderSummaryFailure({ status: 'failed', message: FAIL_MSG });
  assert.ok(h.calls.releases.includes('summary-failure'));
});

test('131b: an AUTOMATED body is not markdown, so it is neither rendered nor hydrated', () => {
  const h = load();
  h.mod.renderSummaryFailure({ status: 'failed', automated: true, message: '  expected 1\n  got 2  ' });
  assert.deepEqual(h.calls.hydrates, []);
  assert.equal(h.node['summary-message'].textContent, 'expected 1\n  got 2'); // trimmed, not reflowed
});

test('132: a message of nothing but spaces hides the section and paints no title', () => {
  const h = load();
  h.node['summary-failure'].hidden = false;
  h.mod.renderSummaryFailure({ status: 'failed', message: '   ' });
  assert.equal(h.node['summary-failure'].hidden, true);
  assert.equal(h.node['summary-message'].childNodes.length, 0);
  assert.equal(h.node['summary-failure-title'].textContent, 'Failure'); // the markup's own default, untouched
  assert.equal(h.node['summary-message'].className, 'summary-message'); // …and no is-failed / is-ok
});

test('132a: a message with anything in it shows the section', () => {
  const h = load();
  h.mod.renderSummaryFailure({ status: 'failed', automated: true, message: ' x ' });
  assert.equal(h.node['summary-failure'].hidden, false);
  assert.equal(h.node['summary-message'].textContent, 'x');
});

// ===================== environment meta (rows 133-134) =====================

test('133: the run\'s own bookkeeping entries never reach the tester', () => {
  const h = load();
  h.mod.renderSummaryMeta({ extras: [{ source: 'system', key: 'duration' }, { key: 'Browser', value: 'Chrome' }] });
  const body = h.node['summary-meta-body'];
  assert.deepEqual(body.children.map((n) => [n.tagName, n.textContent]), [['DT', 'Browser'], ['DD', 'Chrome']]);
  assert.equal(h.node['summary-meta-count'].textContent, '1');
  assert.equal(h.node['summary-meta'].hidden, false);
});

test('133a: an entry with no key is dropped too, and an empty section is hidden', () => {
  const h = load();
  h.mod.renderSummaryMeta({ extras: [{ value: 'orphan' }, null] });
  assert.equal(h.node['summary-meta'].hidden, true);
  assert.equal(h.node['summary-meta-body'].children.length, 0);
});

test('134: a value that is missing prints nothing, not the word null', () => {
  const h = load();
  h.mod.renderSummaryMeta({ extras: [{ key: 'A', value: null }, { key: 'B', value: 0 }, { key: 'C', value: false }] });
  const dds = h.node['summary-meta-body'].children.filter((n) => n.tagName === 'DD');
  assert.deepEqual(dds.map((n) => n.textContent), ['', '0', 'false']);
});

// ===================== the artifacts fold (row 135) =====================

test('135: a row with neither an address nor a name is not a file, and an empty fold is released', () => {
  const h = load();
  h.node['summary-artifacts-body'].append(el('li', {}, 'stale'));
  h.mod.renderSummaryArtifacts({ attachments: [{}, { size: 12 }, null] });
  assert.equal(h.node['summary-artifacts'].hidden, true);
  assert.equal(h.node['summary-artifacts-body'].children.length, 0);
  assert.deepEqual(h.calls.releases, ['summary-artifacts']);
});

test('135a: a row with only a name survives and the fold opens', async () => {
  const h = load();
  h.mod.renderSummaryArtifacts({ attachments: [{ name: 'report' }] });
  await settle();
  assert.equal(h.node['summary-artifacts'].hidden, false);
  assert.equal(h.node['summary-artifacts-count'].textContent, '1');
  assert.equal(h.node['summary-artifacts-body'].querySelector('.file-tile').dataset.kind, 'file');
});

// ===================== the reported steps section (rows 136-138) =====================

// `summarySteps` is the module's own `let`, private to the IIFE — so what it holds is read back
// the way the tester sees it, off the body the card paints.
test('136: an automated result advertises a count and the list waits for the tester to ask', async () => {
  const h = load({ testrunDetail: detail({ steps: [], sections: { steps: { count: 3 } } }) });
  h.mod.renderSummaryStepsSection({ steps: [], sections: { steps: { count: 3 } } });
  assert.equal(h.node['summary-steps-body'].children.length, 0); // nothing adopted, so nothing painted
  assert.equal(h.node['summary-steps'].hidden, false);
  assert.equal(h.node['summary-steps-count'].textContent, '3');
  assert.deepEqual(h.calls.requests, []); // shut: nothing fetched yet
  h.mod.toggleDisclosure('steps');
  await settle();
  assert.deepEqual(h.calls.requests, ['/testruns/55/steps']);
});

test('136a: a manual result carries its steps inline and never asks the server', async () => {
  const h = load();
  h.mod.renderSummaryStepsSection({ steps: [{ title: 'a', status: 'passed' }] });
  await settle();
  assert.equal(h.node['summary-steps-body'].querySelectorAll('.summary-step-title').length, 1);
  assert.equal(h.node['summary-steps-count'].textContent, '1');
  assert.deepEqual(h.calls.requests, []);
});

test('136b: no inline steps and nothing advertised hides the section', () => {
  const h = load();
  h.mod.renderSummaryStepsSection({});
  assert.equal(h.node['summary-steps'].hidden, true);
});

test('137: a read that lands after the tester paged on paints nothing', async () => {
  const gate = deferred();
  const h = load({ stepsDoc: () => gate.promise });
  const body = h.node['summary-steps-body'];
  h.mod.loadSummarySteps();
  await settle();
  assert.equal(body.querySelectorAll('.sk-lines').length, 1); // the placeholder it drew
  h.state.currentRecordId = '56';
  gate.resolve({ steps: [{ title: 'a' }] });
  await settle();
  assert.equal(body.querySelectorAll('.sk-lines').length, 1); // still only the placeholder
  assert.equal(body.querySelectorAll('.summary-step-title').length, 0); // …and nothing was adopted
});

test('137a: …and the same read for the test still open does paint', async () => {
  const h = load({ stepsDoc: { steps: [{ title: 'a', status: 'passed' }] } });
  h.mod.loadSummarySteps();
  await settle();
  assert.equal(h.node['summary-steps-body'].querySelector('.summary-step-title').textContent, 'a');
});

test('138: a read that failed says so in the body', async () => {
  const h = load({ stepsDoc: () => { throw new Error('502'); } });
  h.mod.loadSummarySteps();
  await settle();
  assert.equal(h.node['summary-steps-body'].textContent, "Couldn't load the reported steps");
});

test('138a: a failure for a test the tester already left is not written over the new one', async () => {
  const gate = deferred();
  const h = load({ stepsDoc: () => gate.promise });
  h.mod.loadSummarySteps();
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
  const first = await h.mod.artifactSigned(row);
  const second = await h.mod.artifactSigned(row);
  assert.deepEqual(h.calls.presigns, ['U']);
  assert.equal(first.url, 'https://signed.test/a');
  assert.equal(first.display_url, 'https://signed.test/a');
  assert.equal(second.url, 'https://signed.test/a');
});

test('139a: a row that is not flagged is handed straight back, unsigned', async () => {
  const h = load();
  const row = { url: 'U' };
  assert.equal(await h.mod.artifactSigned(row), row);
  assert.deepEqual(h.calls.presigns, []);
});

test('140: a refusal is remembered as a refusal, and the raw row keeps the link openable', async () => {
  const h = load({ presign: async () => { throw new Error('403'); } });
  const row = { needs_presign: true, url: 'U' };
  const out = await h.mod.artifactSigned(row);
  assert.equal(out, row); // the same object: url 'U', still openable
  // The memo is private to the IIFE, so the remembered '' shows itself the only way it can: the
  // second call answers the raw row again without asking.
  assert.equal(await h.mod.artifactSigned(row), row);
  assert.deepEqual(h.calls.presigns, ['U']); // asked once, never again
});

// ===================== links, the viewer and the tiles (rows 141-146, 159) =====================

// 141: the url is server data, so it is resolved and then checked — the same rule ciBuildLink
// (run-view.js:679-682) applies to the same kind of value on the same kind of element.
test('141: an attachment url that is not http(s) never becomes an href', () => {
  const h = load();
  const link = h.mod.attachmentLink({ name: 'a', url: 'javascript:alert(1)' });
  assert.equal(link.tagName, 'SPAN');
  assert.equal(link.getAttribute('href'), null);
  assert.equal(link.textContent, 'a'); // refused, but the name is still shown
});

test('141a: an ordinary address is still an anchor that opens safely', () => {
  const h = load();
  const link = h.mod.attachmentLink({ name: 'a', url: 'https://app.testomat.io/f.png' });
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'https://app.testomat.io/f.png');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('141b: a ROOT-RELATIVE address resolves against the instance instead of the extension', () => {
  const h = load();
  const link = h.mod.attachmentLink({ name: 'a', url: '/rails/active_storage/x.png' });
  // Unresolved it would have pointed at chrome-extension://<id>/rails/… — a dead link.
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'https://app.testomat.io/rails/active_storage/x.png');
});

test('142: a row with no address is a span, so there is nothing to click', () => {
  const h = load();
  const span = h.mod.attachmentLink({ name: 'a' });
  assert.equal(span.tagName, 'SPAN');
  assert.equal(span.getAttribute('href'), null);
  assert.equal(span.className, 'summary-step-att-link');
  assert.equal(span.textContent, 'a');
  assert.equal(h.mod.attachmentLink({}).textContent, 'attachment');
});

test('142a: …and one with an address is an anchor that leaves the panel safely', () => {
  const h = load();
  const a = h.mod.attachmentLink({ name: 'a', url: 'https://h/a.txt' });
  assert.equal(a.tagName, 'A');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
});

test('143: the viewer message names the file type under `mime` — `type` is the worker\'s own route', async () => {
  const h = load();
  h.mod.openFileViewer({ name: 'x', type: 'image/png' }, 'U');
  await settle();
  assert.deepEqual(h.calls.sends, [{ type: 'OPEN_FILE_OVERLAY', url: 'U', name: 'x', mime: 'image/png' }]);
  assert.deepEqual(h.calls.opened, []);
});

test('143a: with no resolved url it falls back to the attachment\'s own address', async () => {
  const h = load();
  h.mod.openFileViewer({ type: 'image/png', display_url: 'D', url: 'U' });
  await settle();
  assert.equal(h.calls.sends[0].url, 'D');
});

test('144: a worker that never answers hands the file to a new tab instead', async () => {
  const h = load({ sendFails: true });
  h.mod.openFileViewer({ name: 'x' }, 'U');
  await settle();
  assert.deepEqual(h.calls.opened, [['U', '_blank', 'noopener']]);
});

test('144a: …and so does a panel with no runtime to send through', () => {
  const h = load({ runtime: false });
  h.mod.openFileViewer({ name: 'x' }, 'U');
  assert.deepEqual(h.calls.opened, [['U', '_blank', 'noopener']]);
  assert.deepEqual(h.calls.sends, []);
});

test('145: an attachment with no address at all opens nothing', async () => {
  const h = load();
  h.mod.openFileViewer({});
  await settle();
  assert.deepEqual(h.calls.sends, []);
  assert.deepEqual(h.calls.opened, []);
});

test('146: an image tile whose bytes never arrive becomes a file card, badge and all', async () => {
  const h = load({ imgLoad: async () => false });
  const btn = h.mod.fileTile({ type: 'image/png', name: 'shot.png', url: 'U' }, 'g', '');
  assert.equal(btn.dataset.kind, 'image');
  await settle();
  assert.equal(btn.dataset.kind, 'file');
  assert.equal(btn.querySelector('.file-tile-badge').textContent, 'PNG');
  assert.equal(btn.querySelectorAll('img').length, 0);
});

test('146a: one whose bytes do arrive stays an image', async () => {
  const h = load({ imgLoad: async () => true });
  const btn = h.mod.fileTile({ type: 'image/png', name: 'shot.png', url: 'U' }, 'g', '');
  await settle();
  assert.equal(btn.dataset.kind, 'image');
  assert.equal(btn.querySelectorAll('img').length, 1);
  assert.equal(btn.querySelectorAll('.file-tile-badge').length, 0);
});

test('146b: a video and a plain file are cards from the start and are never fetched', async () => {
  const h = load();
  assert.equal(h.mod.fileTile({ name: 'take.webm' }, 'g', '').dataset.kind, 'video');
  assert.equal(h.mod.fileTile({ name: 'notes.txt' }, 'g', '').dataset.kind, 'file');
  await settle();
  assert.deepEqual(h.calls.loads, []);
});

// 159: both call sites hand ImgHydrate.load no options, and that is the SAFE shape — fetchAsset's
// `instanceOnly` defaults to true (api/assets.js:35), so an off-instance host is refused for them.
test('159: a thumbnail and a tile pass no fetch options, which is instance-only by default', async () => {
  const h = load();
  h.mod.attachmentThumb('g', { name: 'a.png', url: 'https://evil.test/a.png' }, () => {});
  h.mod.fileTile({ type: 'image/png', name: 'b.png', url: 'https://evil.test/b.png' }, 'g', '');
  await settle();
  assert.deepEqual(h.calls.loads, [
    { group: 'g', src: 'https://evil.test/a.png', opts: null },
    { group: 'g', src: 'https://evil.test/b.png', opts: null },
  ]);
  // An opt-out would have to be written here to exist: tests/api-errors-auth.test.mjs owns the refusal.
  assert.deepEqual(h.calls.loads.filter((l) => l.opts && l.opts.instanceOnly === false), []);
});
