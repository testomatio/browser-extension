#!/usr/bin/env node
// #177: the pictures inside a test's description, a comment or an attachment —
// extension/shared/img-hydrate.js. The panel's CSP carries no `https:` in `img-src` BY DESIGN, so an
// <img> the server sent cannot simply load: the bytes are fetched through the API and handed back as
// a `blob:` URL. What matters to a tester is the failure path — a broken image in a bug report is a
// bug report the next person cannot act on, so an image that will not load DEGRADES to a link they
// can click rather than to a blank box.
// Three rules are worth reading twice. A 200 IS NOT AN IMAGE: a signed-out fetch of an attachment
// gets the sign-in PAGE back, so the blob's own type is checked and `text/html` is a failure. An
// image pointing at a host the instance never named is a tracking beacon in authored markdown, so it
// is fetched with `instanceOnly` and shown as a link instead. And the whole walk must run on a
// DETACHED container, between sanitizeHtml() and the append.
// Run: node --test tests/img-hydrate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle } from './helpers/shared-harness.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

const BASE = 'https://a.io';
const RAILS = '/rails/active_storage/x.png';
const RAILS_URL = `${BASE}${RAILS}`;

// A response the way api.js's fetchAsset hands one back. `type` is the BLOB's, not the header's —
// that is the one looksLikeImage() reads.
const okBlob = (blob) => ({ ok: true, status: 200, blob: async () => blob });
const ok = (type = 'image/png') => okBlob({ type });
const status = (code) => ({ ok: false, status: code, blob: async () => ({ type: 'text/html' }) });

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// `groups` is module-level, so held() carries over unless every row loads its own copy.
function load({ icons = true, respond = () => ok(), revokeThrows = false } = {}) {
  const doc = makeDocument();
  const calls = { fetches: [], assetUrls: [], minted: [], revoked: [], icons: [] };
  const sandbox = {
    window: {},
    document: doc,
    // Absent in a bare vm context: the ledger this file keeps is only readable through a stub.
    URL: {
      createObjectURL: (blob) => {
        calls.minted.push(blob);
        return `blob:img/${calls.minted.length}`;
      },
      revokeObjectURL: (url) => {
        calls.revoked.push(url);
        if (revokeThrows) throw new Error('already revoked');
      },
    },
    // api/assets.js:15 and :35, cut to what this file leans on — including the default the real
    // fetchAsset applies when a caller hands it no options at all.
    TestomatAPI: {
      assetUrl: (raw) => {
        calls.assetUrls.push(raw);
        try { return new URL(String(raw), `${BASE}/`).toString(); } catch { return ''; }
      },
      fetchAsset: async (raw, opts) => {
        const { instanceOnly = true } = opts || {};
        calls.fetches.push({ url: raw, opts: opts === undefined ? null : { ...opts } });
        const url = new URL(String(raw), `${BASE}/`).toString();
        const ours = url === BASE || url.startsWith(`${BASE}/`);
        if (instanceOnly && !ours) throw new Error('Off-instance asset refused');
        return respond(url);
      },
    },
  };
  if (icons) {
    sandbox.Icons = {
      el: (name, size = 16) => {
        calls.icons.push({ name, size });
        const node = doc.createElement('svg');
        node.dataset.icon = name;
        return node;
      },
    };
  }
  loadInto(sandbox, ['shared/img-hydrate.js']);
  return { H: sandbox.window.ImgHydrate, doc, calls };
}

// A description as the panel has it after sanitizeHtml(): parsed, and not yet in the document.
function box(h, html) {
  const node = h.doc.createElement('div');
  node.innerHTML = html;
  return node;
}

// ---- what counts as a picture (read through load(), the only door onto it) ---------------------

const IMAGEY = [
  ['a plain png', { type: 'image/png' }],
  ['a type shouted in capitals', { type: 'IMAGE/PNG' }],
  ['a vector with a charset stuck on it', { type: 'image/svg+xml; charset=utf-8' }],
  ['a type with space around the parameters', { type: '  image/png ; x' }],
  ['a blob the host would not name at all', { type: '' }],
  ['a blob with no type property whatsoever', {}],
  ['the octet-stream an artifact host serves an image as', { type: 'application/octet-stream' }],
];
for (const [what, blob] of IMAGEY) {
  test(`1: ${what} is drawn as a picture`, async () => {
    const h = load({ respond: () => okBlob(blob) });
    const img = h.doc.createElement('img');
    assert.equal(await h.H.load('g', RAILS_URL, img, { instanceOnly: true }), true);
    assert.equal(img.getAttribute('src'), 'blob:img/1');
    assert.equal(h.H.held('g'), 1);
  });
}

test('4: the sign-in page a signed-out fetch gets back is not a picture, 200 or not', async () => {
  const h = load({ respond: () => ok('text/html') });
  const img = h.doc.createElement('img');
  assert.equal(await h.H.load('g', RAILS_URL, img, { instanceOnly: true }), false);
  assert.deepEqual(h.calls.minted, []);
  assert.equal(h.H.held('g'), 0);
  assert.equal(img.getAttribute('data-loaded'), null);
});

test('6: a refused or missing asset answers false and mints nothing — it never throws at the caller', async () => {
  const h = load({ respond: () => status(403) });
  const img = h.doc.createElement('img');
  assert.equal(await h.H.load('g', RAILS_URL, img, { instanceOnly: true }), false);
  assert.deepEqual(h.calls.minted, []);
  assert.equal(img.getAttribute('src'), null);
});

test('6b: an off-instance URL refused by the API answers false rather than rejecting', async () => {
  const h = load();
  const img = h.doc.createElement('img');
  assert.equal(await h.H.load('g', 'https://evil.example/px.png', img, { instanceOnly: true }), false);
  assert.deepEqual(h.calls.minted, []);
});

test('8: a picture that did load carries the blob and the flag the end-to-end run waits on', async () => {
  const h = load();
  const img = h.doc.createElement('img');
  assert.equal(await h.H.load('g', RAILS_URL, img, { instanceOnly: true }), true);
  assert.equal(img.getAttribute('src'), 'blob:img/1');
  assert.equal(img.dataset.loaded, 'true');
  assert.equal(h.H.held('g'), 1);
  assert.deepEqual(plain(h.calls.fetches), [{ url: RAILS_URL, opts: { instanceOnly: true } }]);
});

// ---- the ledger: every blob the panel minted, and letting go of it -----------------------------

test('9: closing a view hands back every blob it minted', async () => {
  const h = load();
  for (let i = 0; i < 3; i += 1) {
    await h.H.load('view', RAILS_URL, h.doc.createElement('img'), { instanceOnly: true });
  }
  assert.equal(h.H.held('view'), 3);
  h.H.release('view');
  assert.deepEqual(h.calls.revoked, ['blob:img/1', 'blob:img/2', 'blob:img/3']);
  assert.equal(h.H.held('view'), 0);
});

test('10: a blob the browser already let go of does not break the teardown behind it', async () => {
  const h = load({ revokeThrows: true });
  await h.H.load('view', RAILS_URL, h.doc.createElement('img'), { instanceOnly: true });
  await h.H.load('view', RAILS_URL, h.doc.createElement('img'), { instanceOnly: true });
  assert.doesNotThrow(() => h.H.release('view'));
  assert.equal(h.calls.revoked.length, 2); // the second one still got its turn
  assert.equal(h.H.held('view'), 0);
});

test('11: releasing a view that never drew a picture is a no-op', () => {
  const h = load();
  assert.equal(h.H.held('never-used'), 0);
  assert.doesNotThrow(() => h.H.release('never-used'));
  assert.deepEqual(h.calls.revoked, []);
  assert.equal(h.H.held('never-used'), 0);
});

test('12: closing one view leaves the pictures another view is still showing alone', async () => {
  const h = load();
  await h.H.load('a', RAILS_URL, h.doc.createElement('img'), { instanceOnly: true });
  await h.H.load('b', RAILS_URL, h.doc.createElement('img'), { instanceOnly: true });
  h.H.release('a');
  assert.equal(h.H.held('a'), 0);
  assert.equal(h.H.held('b'), 1);
  assert.deepEqual(h.calls.revoked, ['blob:img/1']);
});

// ---- the walk over a description ---------------------------------------------------------------

test('13: a description that never rendered is nothing to walk over', () => {
  const h = load();
  assert.doesNotThrow(() => h.H.hydrate('g', null));
  assert.doesNotThrow(() => h.H.hydrate('g', undefined));
  assert.deepEqual(h.calls.fetches, []);
});

test('14: a picture that is already ours to draw is left exactly as it is', async () => {
  const h = load();
  const node = box(h, '<img src="blob:already/1"><img src="data:image/png;base64,QQ==">');
  h.H.hydrate('g', node);
  await settle();
  assert.deepEqual(node.querySelectorAll('img').map((i) => i.getAttribute('src')),
    ['blob:already/1', 'data:image/png;base64,QQ==']);
  assert.deepEqual(h.calls.fetches, []);
  assert.deepEqual(h.calls.assetUrls, []);
});

test('15: an image tag naming nothing becomes a dead span, never a link back to the instance root', async () => {
  const h = load();
  const node = box(h, '<img src="   " alt="Chart">');
  h.H.hydrate('g', node);
  await settle();
  assert.deepEqual(h.calls.fetches, []);
  assert.deepEqual(h.calls.assetUrls, []); // nothing to resolve; resolving '' lands on the root
  const out = node.querySelector('.img-fallback');
  assert.equal(out.tagName, 'SPAN');
  assert.equal(out.getAttribute('href'), null);
  assert.equal(out.textContent, 'Chart');
  assert.equal(node.querySelector('img'), null);
});

test('16: a description image loses its raw src BEFORE anything else, and shows a placeholder while it loads', async () => {
  const gate = deferred();
  const h = load({ respond: () => gate.promise });
  const node = box(h, `<img src="${RAILS}" alt="Chart">`);
  h.H.hydrate('g', node);
  const img = node.querySelector('img');
  // Synchronously, before a single byte: no src to resolve against chrome-extension:// and trip the CSP.
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.dataset.img, 'loading');
  assert.deepEqual(h.calls.assetUrls, [RAILS]);
  assert.deepEqual(plain(h.calls.fetches), [{ url: RAILS_URL, opts: { instanceOnly: true } }]);
  gate.resolve(ok());
  await settle();
  assert.equal(img.dataset.img, undefined);
});

test('17: the picture arriving swaps in and clears the placeholder', async () => {
  const h = load();
  const node = box(h, `<img src="${RAILS}" alt="Chart">`);
  h.H.hydrate('g', node);
  await settle();
  const img = node.querySelector('img');
  assert.equal(img.getAttribute('src'), 'blob:img/1');
  assert.equal(img.dataset.img, undefined);
  assert.equal(img.dataset.loaded, 'true');
  assert.equal(node.querySelector('.img-fallback'), null);
  assert.equal(h.H.held('g'), 1);
});

test('18: a picture that will not load becomes a link the tester can open, with the caption as its words', async () => {
  const h = load({ respond: () => status(404) });
  const node = box(h, `<img src="${RAILS}" alt="Chart">`);
  h.H.hydrate('g', node);
  await settle();
  const out = node.querySelector('.img-fallback');
  assert.equal(out.tagName, 'A');
  assert.equal(out.getAttribute('href'), RAILS_URL);
  assert.equal(out.getAttribute('target'), '_blank');
  assert.equal(out.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(out.getAttribute('title'), RAILS_URL);
  assert.equal(out.textContent, 'Chart');
  assert.deepEqual(plain(h.calls.icons), [{ name: 'open_in_new', size: 12 }]);
  assert.equal(node.querySelector('img'), null);
  assert.equal(h.H.held('g'), 0);
});

test('19: an image on somebody else’s server gets no request at all — the tester sees the link instead', async () => {
  const h = load();
  const node = box(h, '<img src="https://evil.example/px.png" alt="pixel">');
  h.H.hydrate('g', node);
  await settle();
  // The refusal is fetchAsset's to make; what this file owes is asking for it, every time.
  assert.deepEqual(plain(h.calls.fetches),
    [{ url: 'https://evil.example/px.png', opts: { instanceOnly: true } }]);
  assert.deepEqual(h.calls.minted, []);
  const out = node.querySelector('.img-fallback');
  assert.equal(out.tagName, 'A');
  assert.equal(out.getAttribute('href'), 'https://evil.example/px.png');
  assert.equal(out.getAttribute('rel'), 'noopener noreferrer');
});

test('20: a picture that was already inside a link degrades to plain words — no link inside a link', async () => {
  const h = load({ respond: () => status(404) });
  const node = box(h, `<a href="https://a.io/page"><img src="${RAILS}" alt="Chart"></a>`);
  h.H.hydrate('g', node);
  await settle();
  const out = node.querySelector('.img-fallback');
  assert.equal(out.tagName, 'SPAN');
  assert.equal(out.getAttribute('href'), null);
  assert.equal(out.parentElement.tagName, 'A'); // it stayed inside the tester's own link
  assert.equal(out.getAttribute('title'), RAILS_URL); // the address is still readable on hover
});

test('21: a picture with no caption still says what the link is for', async () => {
  const h = load({ respond: () => status(404) });
  const node = box(h, `<img src="${RAILS}">`);
  h.H.hydrate('g', node);
  await settle();
  assert.equal(node.querySelector('.img-fallback').textContent, 'Open image');
});

test('22: on a page with no icon set the link loses its arrow and nothing else', async () => {
  const h = load({ icons: false, respond: () => status(404) });
  const node = box(h, `<img src="${RAILS}" alt="Chart">`);
  h.H.hydrate('g', node);
  await settle();
  const out = node.querySelector('.img-fallback');
  assert.equal(out.textContent, 'Chart');
  assert.equal(out.querySelector('svg'), null);
  assert.equal(out.getAttribute('href'), RAILS_URL);
});

test('23: in a description where half the pictures are gone, the half that loaded still draw', async () => {
  const dead = new Set([`${BASE}/b.png`, `${BASE}/d.png`]);
  const h = load({ respond: (url) => (dead.has(url) ? status(404) : ok()) });
  const node = box(h, ['a', 'b', 'c', 'd']
    .map((n) => `<img src="/${n}.png" alt="${n}">`).join(''));
  h.H.hydrate('g', node);
  await settle();
  assert.deepEqual(node.querySelectorAll('.img-fallback').map((n) => n.textContent), ['b', 'd']);
  assert.deepEqual(node.querySelectorAll('img').map((n) => n.getAttribute('src')),
    ['blob:img/1', 'blob:img/2']);
  assert.equal(h.H.held('g'), 2);
});

test('24: it runs on a container ALREADY in the document too — the detached rule is the caller’s to keep', async () => {
  const h = load();
  const node = box(h, `<img src="${RAILS}" alt="Chart">`);
  h.doc.body.append(node); // what the file's own comment says must not happen: nothing here stops it
  h.H.hydrate('g', node);
  await settle();
  assert.equal(node.querySelector('img').getAttribute('src'), 'blob:img/1');
});

test('24b: the module publishes the four functions its two hosts call, and no more', () => {
  const h = load();
  assert.deepEqual(Object.keys(h.H).sort(), ['held', 'hydrate', 'load', 'release']);
});
