#!/usr/bin/env node
// extension/viewer/viewer.js: the page that opens when a tester clicks an attachment on a test — a
// screenshot, a screen recording, a log. One decision runs the whole file: WHAT KIND of file is
// this? The content type answers when the server sends one and the NAME answers when it does not —
// a bucket that serves a screencast as `application/octet-stream` is the whole reason the name has
// to be able to answer alone. Guess wrong and the tester gets a video player over a text file, or a
// download note over the screenshot they wanted to look at.
//
// The file is a BARE IIFE: it publishes nothing, exports nothing, has no completion value and
// declares no top-level function, so there is no `kindOf` to reach for. Every row builds a sandbox
// with one `?url=…&name=…&type=…`, runs the whole script, and reads the verdict off the stage —
// each kind paints exactly one element (pre / video / img / p), and that is kindOf()'s only
// observable from outside.
//
// Cases numbered as in issue 188. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';
import {
  loadInto, chromeFake, ExtURL, plain, settle,
} from './helpers/shared-harness.mjs';

// loadInto() resolves this through sharedPath(), so SHARED_MODULES=viewer.js=… runs the whole suite
// against a mutated copy without the shipped file ever being edited.
const VIEWER = 'viewer/viewer.js';

// Every id viewer.html carries. paintChrome() dereferences two of them at load, before any row can
// look, so a missing one throws and takes the whole script with it.
const IDS = ['div#viewer-stage', 'h1#viewer-name', 'a#viewer-open'];

const INSTANCE = 'https://app.testomat.io';
// The trailing slash is on purpose: boot() trims it, and every on-instance row depends on the trim.
const SETTINGS = Object.freeze({ baseUrl: `${INSTANCE}/`, apiKey: 'k-1' });

const NO_PREVIEW = 'No preview for this file type.';
const BROKEN = 'This file could not be loaded — the link may have expired.';

// No extension and no host of the instance's: with this url the NAME and the TYPE are the only
// things the verdict can be coming from.
const NEUTRAL = 'https://files.test/asset';

const BODY = 'a log line\nand another';

// ---- the pieces a vm realm has none of --------------------------------------

const okAsset = (body = BODY) => async () => ({
  ok: true,
  status: 200,
  blob: async () => ({ mark: 'blob', text: async () => body }),
});

const missingAsset = () => async () => ({
  ok: false,
  status: 404,
  blob: async () => { throw new Error('no body on a 404'); },
});

const deadAsset = () => async () => { throw new Error('the network went away'); };

// An undefined key is left OUT of the query, which is not the same as an empty one.
function search(parts) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(parts)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- the harness -------------------------------------------------------------

async function load(opts = {}) {
  const {
    url, name, type,          // the ?query — omit a key to leave it out of the URL entirely
    query,                    // …or state the query string verbatim, including ''
    framed = false,
    settings = SETTINGS,      // what chrome.storage.local answers for 'settings'
    credentialed = true,
    hasChrome = true,
    hasStorage = true,
    hasTabs = true,
    storageFail = false,
    readyRejects = false,
    currentTab = { id: 7, url: `${INSTANCE}/` },
    getCurrentRejects = false,
    removeRejects = false,
    asset = okAsset(),
  } = opts;

  const doc = makeDocument(IDS);

  const fetches = [];     // every TestomatAPI.fetchAsset(url, opts), in order
  const TestomatAPI = {
    async fetchAsset(u, o) { fetches.push({ url: u, opts: plain(o) }); return asset(u, o); },
  };

  const handoff = { credentialed: [], ready: 0, configured: [] };
  const Handoff = {
    credentialed(s) { handoff.credentialed.push(plain(s)); return credentialed && !!s; },
    async ready() {
      handoff.ready += 1;
      if (readyRejects) throw new Error('the handed-off config never landed');
    },
    configure(s) { handoff.configured.push(plain(s)); },
  };

  // A vm realm has no URL at all, and createObjectURL is the whole difference between "shown from
  // our own bytes" and "fetched off a host the extension never configured".
  const objectUrls = [];  // every blob handed to createObjectURL
  const revoked = [];     // every url handed back to revokeObjectURL — row 21 watches this stay empty
  class VMURL extends ExtURL {}
  VMURL.createObjectURL = (blob) => {
    objectUrls.push(plain(blob) || { mark: 'blob' });
    return `blob:viewer-${objectUrls.length}`;
  };
  VMURL.revokeObjectURL = (u) => { revoked.push(u); };

  const posts = [];      // what reached window.parent
  const selfPosts = [];  // what the page shouted at itself — never expected
  const closes = [];
  const win = {
    close: () => { closes.push(true); },
    postMessage: (d, o) => { selfPosts.push({ data: plain(d), origin: o }); },
  };
  // The branch is `window.parent !== window`, so the framed page needs a genuinely other object.
  win.parent = framed ? { postMessage: (d, o) => posts.push({ data: plain(d), origin: o }) } : win;

  const fake = chromeFake({
    local: settings ? { settings: plain(settings) } : {},
    localFail: storageFail ? { get: true } : {},
  });
  const removed = [];
  fake.chrome.tabs.getCurrent = async () => {
    if (getCurrentRejects) throw new Error('this page is not in a tab');
    return currentTab;
  };
  fake.chrome.tabs.remove = async (id) => {
    removed.push(id);
    if (removeRejects) throw new Error('that tab is already gone');
  };
  if (!hasTabs) delete fake.chrome.tabs;
  if (!hasStorage) delete fake.chrome.storage;

  const sandbox = {
    document: doc,
    window: win,
    location: { search: query !== undefined ? query : search({ url, name, type }) },
    URL: VMURL,
    // URLSearchParams is NOT a per-realm built-in: without it line 9 throws and every row here
    // would pass on an empty page.
    URLSearchParams,
    TestomatAPI,
    Handoff,
    console,
  };
  if (hasChrome) sandbox.chrome = fake.chrome;

  loadInto(sandbox, [VIEWER]);
  // paintChrome() is synchronous, but boot() and show() are a chain of promises: drive it the way a
  // browser would before any row looks at the stage.
  await settle(3);

  const $ = (id) => doc.getElementById(id);
  const child = () => $('viewer-stage').children[0] || null;
  const KINDS = { PRE: 'text', VIDEO: 'video', IMG: 'image' };

  return {
    doc,
    win,
    $,
    fetches,
    objectUrls,
    revoked,
    posts,
    selfPosts,
    closes,
    removed,
    handoff,
    child,
    stage: () => $('viewer-stage'),
    text: () => $('viewer-stage').textContent,
    src: () => (child() ? child().src : null),
    // The verdict, read off what got painted. A <p> is either the download note or the failure one.
    kind: () => {
      const el = child();
      if (!el) return null;
      if (el.tagName === 'P') return el.textContent === NO_PREVIEW ? 'file' : 'failed';
      return KINDS[el.tagName] || `?${el.tagName}`;
    },
    key: (k) => fire(doc, 'keydown', { key: k }),
    esc: () => fire(doc, 'keydown', { key: 'Escape' }),
  };
}

// The verdict for one ?query, over a url that answers for nothing.
const kindOf = async (parts) => (await load({ url: NEUTRAL, ...parts })).kind();

// ---- the verdict: the type, or the name ---------------------------------------

test('1: a screen recording a bucket calls application/octet-stream is still a video', async () => {
  assert.equal(await kindOf({ type: 'application/octet-stream', name: 'take.webm' }), 'video');
});

test('1b: the same either-tell answers for a log served as bytes', async () => {
  assert.equal(await kindOf({ type: 'application/octet-stream', name: 'console.log' }), 'text');
});

test('1c: a name that tells nothing and a type that tells nothing is offered as a download', async () => {
  assert.equal(await kindOf({ type: 'application/octet-stream', name: 'evidence' }), 'file');
});

test('2: a video content type answers on its own, with no name to help it', async () => {
  assert.equal(await kindOf({ type: 'video/webm', name: '' }), 'video');
});

test('2b: an image and a text content type answer on their own too', async () => {
  assert.equal(await kindOf({ type: 'image/png', name: '' }), 'image');
  assert.equal(await kindOf({ type: 'text/plain', name: '' }), 'text');
});

test('3: an svg is not drawn — it is offered as a download instead', async () => {
  assert.equal(await kindOf({ type: 'image/svg+xml', name: '' }), 'file');
});

test('3b: a file merely NAMED .svg is refused the same way', async () => {
  assert.equal(await kindOf({ type: '', name: 'diagram.svg' }), 'file');
});

test('3c: the svg refusal reads the type only, so an svg named .png is still drawn', async () => {
  assert.equal(await kindOf({ type: 'image/svg+xml', name: 'diagram.png' }), 'image');
});

test('4: a presigned screenshot keeps its extension behind the signature and the anchor', async () => {
  assert.equal(await kindOf({ type: '', name: 'shot.PNG?sig=abc#x' }), 'image');
});

test('4b: an upper-case extension is the same extension, for a video and for a log too', async () => {
  assert.equal(await kindOf({ type: '', name: 'take.WEBM#t=3' }), 'video');
  assert.equal(await kindOf({ type: '', name: 'RUN.LOG?x=1' }), 'text');
});

test('4c: a longer word that merely starts with an extension is not that extension', async () => {
  assert.equal(await kindOf({ type: '', name: 'take.webmx' }), 'file');
  assert.equal(await kindOf({ type: '', name: 'shot.pngx' }), 'file');
});

test('5: a markdown report is shown as text', async () => {
  assert.equal(await kindOf({ type: '', name: 'report.md' }), 'text');
});

test('5b: a name with two dots is read from the END — the last extension is the file', async () => {
  assert.equal(await kindOf({ type: '', name: 'screenshot.png.txt' }), 'text');
  assert.equal(await kindOf({ type: '', name: 'notes.txt.png' }), 'image');
});

test('6: with no type and no name the url stands in for the name', async () => {
  assert.equal(await kindOf({ url: 'https://files.test/run/a.log', type: '', name: '' }), 'text');
});

test('6b: a name that is there REPLACES the url, it does not join it', async () => {
  const kind = await kindOf({ url: 'https://files.test/clip.webm', type: '', name: 'notes.txt' });
  assert.equal(kind, 'text');
});

test('7: a file named in Ukrainian is judged by its extension like any other', async () => {
  assert.equal(await kindOf({ type: '', name: 'архів.json' }), 'text');
});

// ---- what the verdict costs ---------------------------------------------------

test('8: a file with no preview says so, and nothing is fetched for it', async () => {
  const h = await load({ url: NEUTRAL, type: 'application/zip', name: 'bundle.zip' });
  assert.equal(h.text(), NO_PREVIEW);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.objectUrls, []);
});

test('9: a link that arrived without its url tells the tester it may have expired', async () => {
  const h = await load({ name: 'shot.png', type: 'image/png' });
  assert.equal(h.text(), BROKEN);
  assert.deepEqual(h.fetches, []);
  // Nothing to open, so the way out is hidden rather than pointing at nowhere.
  assert.equal(h.$('viewer-open').hidden, true);
  assert.equal(h.$('viewer-open').href, '');
});

test('9b: an empty query gets the no-preview note, because the kind is decided first', async () => {
  const h = await load({ query: '' });
  assert.equal(h.text(), NO_PREVIEW);
  assert.equal(h.$('viewer-name').textContent, 'File');
  assert.equal(h.doc.title, 'File');
});

test('10: an expired link 404s and the way out to a real tab still stands', async () => {
  const url = `${INSTANCE}/files/run.log`;
  const h = await load({ url, name: 'run.log', asset: missingAsset() });
  assert.equal(h.text(), BROKEN);
  assert.equal(h.$('viewer-open').href, url);
  assert.equal(h.$('viewer-open').hidden, false);
});

test('11: the fetch throws and the tester gets the note, not an unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(String(e));
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = await load({ url: `${INSTANCE}/files/run.log`, name: 'run.log', asset: deadAsset() });
    await settle(2);
    assert.equal(h.text(), BROKEN);
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('12: an image that arrives but will not decode says so where the image was', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png' });
  assert.equal(h.kind(), 'image');
  fire(h.child(), 'error');
  assert.equal(h.text(), BROKEN);
  assert.equal(h.child().tagName, 'P');
});

// ---- where the bytes come from ------------------------------------------------

test('13: the fetch is told not to refuse an off-instance host — this page presigned nothing', async () => {
  const url = 'https://files.test/run/console.log';
  const h = await load({ url, name: 'console.log' });
  assert.deepEqual(h.fetches, [{ url, opts: { instanceOnly: false } }]);
  assert.equal(h.text(), BODY);
});

test.todo('13b (#105): an off-instance recording is streamed straight off its own host — today <video src> is the raw remote url, so opening an attachment reaches out to a host the extension was never configured for', async () => {
  const url = 'https://files.test/run/take.webm';
  const h = await load({ url, name: 'take.webm' });
  assert.notEqual(h.src(), url);
});

test('13c: today that off-instance recording plays from the remote url, with no fetch at all', async () => {
  const url = 'https://files.test/run/take.webm';
  const h = await load({ url, name: 'take.webm' });
  assert.equal(h.kind(), 'video');
  assert.equal(h.src(), url);
  assert.deepEqual(h.fetches, []);
});

test('14: the instance\'s own recording is fetched with the session and played from a blob', async () => {
  const url = `${INSTANCE}/artifacts/take.webm`;
  const h = await load({ url, name: 'take.webm' });
  assert.equal(h.kind(), 'video');
  assert.equal(h.src(), 'blob:viewer-1');
  assert.deepEqual(h.fetches, [{ url, opts: { instanceOnly: false } }]);
});

test('14b: a host that merely BEGINS with the instance is not the instance', async () => {
  const url = 'https://app.testomat.io.evil.test/take.webm';
  const h = await load({ url, name: 'take.webm' });
  assert.equal(h.src(), url);
  assert.deepEqual(h.fetches, []);
});

test('14c: the instance url itself, with the stored trailing slash trimmed off, is on-instance', async () => {
  const h = await load({ url: INSTANCE, type: 'video/webm', name: '' });
  assert.equal(h.src(), 'blob:viewer-1');
  assert.deepEqual(h.fetches, [{ url: INSTANCE, opts: { instanceOnly: false } }]);
});

test('15: every image is shown from our own bytes, on-instance or not — the CSP allows nothing else', async () => {
  const off = await load({ url: 'https://files.test/shot.png', name: 'shot.png' });
  assert.equal(off.src(), 'blob:viewer-1');
  assert.equal(off.fetches.length, 1);

  const on = await load({ url: `${INSTANCE}/shot.png`, name: 'shot.png' });
  assert.equal(on.src(), 'blob:viewer-1');
  assert.equal(on.fetches.length, 1);
});

// ---- the session the page may or may not have ---------------------------------

test('16: nothing is configured yet and a presigned link still opens', async () => {
  const url = `${INSTANCE}/artifacts/take.webm`;
  const h = await load({ url, name: 'take.webm', settings: null });
  // base stayed '', so even the instance's own url is treated as somewhere else.
  assert.equal(h.kind(), 'video');
  assert.equal(h.src(), url);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.handoff.configured, []);
});

test('16b: settings without a session are not configured over, and the file still shows', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', credentialed: false });
  assert.equal(h.text(), BODY);
  assert.equal(h.handoff.ready, 0);
  assert.deepEqual(h.handoff.configured, []);
});

test('16c: a page with no storage at all skips the session and shows the file anyway', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', hasStorage: false });
  assert.equal(h.text(), BODY);
  assert.deepEqual(h.handoff.credentialed, []);
});

test('16d: the store throws on the way past and the file still shows', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', storageFail: true });
  assert.equal(h.text(), BODY);
  assert.deepEqual(h.handoff.credentialed, []);
});

test('16e: the handed-off session never lands and the file still shows', async () => {
  const url = `${INSTANCE}/artifacts/take.webm`;
  const h = await load({ url, name: 'take.webm', readyRejects: true });
  assert.equal(h.kind(), 'video');
  // configure() never ran, so base is still '' and the instance's own take goes out unauthorized.
  assert.equal(h.src(), url);
  assert.deepEqual(h.handoff.configured, []);
});

test('16f: a configured session is handed to Handoff before anything is fetched', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log' });
  assert.equal(h.handoff.ready, 1);
  assert.deepEqual(h.handoff.configured, [plain(SETTINGS)]);
  assert.equal(h.text(), BODY);
});

// ---- the title bar ------------------------------------------------------------

test('17: the url arrives as a javascript: scheme and lands in the way-out link as it is', async () => {
  const h = await load({ url: 'javascript:alert(1)', name: 'evidence' });
  assert.equal(h.$('viewer-open').href, 'javascript:alert(1)');
  assert.equal(h.$('viewer-open').hidden, false);
  // Nothing is fetched or drawn for it — the link is the whole exposure.
  assert.equal(h.text(), NO_PREVIEW);
});

test.todo('17b (#105): a url that is not http(s) is refused rather than offered as the way out — viewer.html is reachable from any page that knows the extension id', async () => {
  const h = await load({ url: 'javascript:alert(1)', name: 'evidence' });
  assert.equal(h.$('viewer-open').href, '');
});

test('18: a name written to look like markup is shown as the text it is, never parsed', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const h = await load({ url: NEUTRAL, name });
  const el = h.$('viewer-name');
  assert.equal(el.textContent, name);
  assert.deepEqual(el.children, []);
  assert.equal(el.title, name);
  assert.equal(h.doc.title, name);
});

test('18b: a file with a name puts it in the tab title and points the way out at the url', async () => {
  const h = await load({ url: NEUTRAL, name: 'run.log' });
  assert.equal(h.doc.title, 'run.log');
  assert.equal(h.$('viewer-name').textContent, 'run.log');
  assert.equal(h.$('viewer-open').href, NEUTRAL);
  assert.equal(h.$('viewer-open').hidden, false);
});

// ---- Escape, on two different pages -------------------------------------------

test('19: framed over the site, Escape asks the overlay to close and does nothing else', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', framed: true });
  h.esc();
  assert.deepEqual(h.posts, [{ data: { type: 'TESTOMAT_VIEWER_CLOSE' }, origin: '*' }]);
  assert.deepEqual(h.selfPosts, []);
  assert.deepEqual(h.closes, []);
  assert.deepEqual(h.removed, []);
});

test('19b: any other key is left alone', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', framed: true });
  h.key('Esc');
  h.key('Enter');
  h.key('e');
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.closes, []);
});

test('20: standing alone in a tab, Escape closes that tab', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png' });
  h.esc();
  await settle(2);
  assert.deepEqual(h.removed, [7]);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.closes, []);
});

test('20b: the tab cannot be identified, so the window closes itself', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', getCurrentRejects: true });
  h.esc();
  await settle(2);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.closes, [true]);
});

test('20c: a current tab with no id gets the same fallback', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', currentTab: { url: 'x' } });
  h.esc();
  await settle(2);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.closes, [true]);
});

test('20d: the tab refuses to be removed and the window closes itself', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', removeRejects: true });
  h.esc();
  await settle(2);
  assert.deepEqual(h.removed, [7]);
  assert.deepEqual(h.closes, [true]);
});

test('20e: no tabs api to ask, so the window closes itself right away', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png', hasTabs: false });
  h.esc();
  assert.deepEqual(h.closes, [true]);
});

// ---- what today leaks ----------------------------------------------------------

test('21: the blob url the page made is never handed back — today one file leaks one url', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png' });
  assert.equal(h.objectUrls.length, 1);
  assert.deepEqual(h.revoked, []);
});
