#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';
import {
  loadInto, chromeFake, ExtURL, plain, settle,
} from './helpers/shared-harness.mjs';

// loadInto() resolves this through sharedPath(), so SHARED_MODULES can swap in a mutated copy.
const VIEWER = 'viewer/viewer.js';

// paintChrome() dereferences two of these at load, so a missing id throws and kills the whole script.
const IDS = ['div#viewer-stage', 'h1#viewer-name', 'a#viewer-open'];

const INSTANCE = 'https://app.testomat.io';
// The trailing slash is on purpose: boot() trims it, and every on-instance row depends on the trim.
const SETTINGS = Object.freeze({ baseUrl: `${INSTANCE}/`, apiKey: 'k-1' });

const NO_PREVIEW = 'No preview for this file type.';
const BROKEN = 'This file could not be loaded — the link may have expired.';
const REFUSED = 'This link did not come from the panel, so it was not opened.';

// No extension and no instance host: with this url only the name and the type can decide.
const NEUTRAL = 'https://files.test/asset';

const BODY = 'a log line\nand another';

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

// An undefined key is left out of the query, which is not the same as an empty one.
function search(parts) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(parts)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function load(opts = {}) {
  const {
    url, name, type,          // the ?query — omit a key to leave it out of the URL entirely
    query,                    // …or state the query string verbatim, including ''
    framed = false,
    settings = SETTINGS,      // what chrome.storage.local answers for 'settings'
    // What the worker parked in storage.session; omitted parks the row's own url, `null` parks nothing.
    parked,
    credentialed = true,
    hasChrome = true,
    hasStorage = true,
    hasLocal = true,
    hasTabs = true,
    storageFail = false,
    sessionFail = false,
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

  // A vm realm has no URL; createObjectURL separates our own bytes from a fetch off an unknown host.
  const objectUrls = [];  // every blob handed to createObjectURL
  const revoked = [];     // every url handed back to revokeObjectURL; the leak row watches it stay empty
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

  // background.js parks it before the viewer opens, and no web page can write storage.session.
  const park = parked === undefined ? url : parked;
  const record = park == null ? null
    : (typeof park === 'object' ? park : { url: String(park), name: '', type: '', at: 1 });
  const fake = chromeFake({
    local: settings ? { settings: plain(settings) } : {},
    localFail: storageFail ? { get: true } : {},
    session: record == null ? {} : { fileOverlay: plain(record) },
    sessionFail: sessionFail ? { get: true } : {},
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
  if (!hasLocal) delete fake.chrome.storage.local;

  const sandbox = {
    document: doc,
    window: win,
    location: { search: query !== undefined ? query : search({ url, name, type }) },
    URL: VMURL,
    // URLSearchParams is not a per-realm built-in: without it every row would pass on an empty page.
    URLSearchParams,
    TestomatAPI,
    Handoff,
    console,
  };
  if (hasChrome) sandbox.chrome = fake.chrome;

  loadInto(sandbox, [VIEWER]);
  // boot() and show() are a chain of promises: settle them as a browser would before reading the stage.
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
    // A <p> is the download note, the refusal one or the failure one.
    kind: () => {
      const el = child();
      if (!el) return null;
      if (el.tagName === 'P') {
        if (el.textContent === NO_PREVIEW) return 'file';
        return el.textContent === REFUSED ? 'refused' : 'failed';
      }
      return KINDS[el.tagName] || `?${el.tagName}`;
    },
    key: (k) => fire(doc, 'keydown', { key: k }),
    esc: () => fire(doc, 'keydown', { key: 'Escape' }),
  };
}

const kindOf = async (parts) => (await load({ url: NEUTRAL, ...parts })).kind();

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

// Nothing else notices if the controls, the autoplay or the error handler quietly go away.
test('12b: a recording opens as a player the tester can actually drive', async () => {
  const h = await load({ url: NEUTRAL, name: 'take.webm' });
  assert.equal(h.kind(), 'video');
  const el = h.child();
  assert.equal(el.controls, true, 'without controls there is no way to scrub to the bug');
  assert.equal(el.autoplay, true);
  assert.equal(el.playsInline, true);
});

test('12c: a recording that will not play says so where the player was, the way a broken image does', async () => {
  const h = await load({ url: NEUTRAL, name: 'take.webm' });
  fire(h.child(), 'error');
  assert.equal(h.text(), BROKEN);
  assert.equal(h.child().tagName, 'P');
});

// An attachment must not put markup into a page that holds the extension origin.
test('12d: a log is shown as the text it is, not parsed as markup', async () => {
  const body = '<b>total</b> 3 failures <script>x</script>';
  const h = await load({ url: NEUTRAL, name: 'console.log', asset: okAsset(body) });
  assert.equal(h.kind(), 'text');
  const el = h.child();
  assert.equal(el.childNodes.length, 1, 'one text node, not a parsed tree');
  assert.equal(el.textContent, body);
});

test('12e: a picture carries the file name as its alt text, and the note keeps its styling', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png' });
  assert.equal(h.child().alt, 'shot.png');
  fire(h.child(), 'error');
  assert.equal(h.child().className, 'viewer-note');
});

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

test('16c: a page with no settings store skips the session and shows the file anyway', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', hasLocal: false });
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

// A javascript: url in the way-out link is one click from running in the extension's own origin.
test('17 (#105): a javascript: url is refused instead of landing in the way-out link', async () => {
  const h = await load({ url: 'javascript:alert(1)', name: 'evidence' });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('17b (#105): a url that is not https is refused rather than offered as the way out', async () => {
  const h = await load({ url: 'javascript:alert(1)', name: 'evidence' });
  assert.equal(h.$('viewer-open').href, '');
  assert.equal(h.$('viewer-open').hidden, true);
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

// Any page can open viewer.html with a ?url= of its own, so the parked url is the whole allowlist.

test('22 (#105): a url nobody parked is refused — nothing is fetched and no link is painted', async () => {
  const h = await load({ url: `${INSTANCE}/api/v1/runs/1/secrets`, name: 'run.log', parked: null });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, [], 'the token would have ridden along on that GET');
  assert.equal(h.$('viewer-open').href, '');
  assert.equal(h.$('viewer-open').hidden, true);
});

test('22b (#105): the same refusal for a host of the page\'s own choosing', async () => {
  const h = await load({ url: 'https://evil.test/collect.webm', name: 'take.webm', parked: null });
  assert.equal(h.kind(), 'refused');
  // An off-instance recording streams from its own url, so a painted <video src> is the request.
  assert.equal(h.child().tagName, 'P');
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.objectUrls, []);
  assert.equal(h.$('viewer-open').href, '');
});

test('22c (#105): a parked file vouches for itself only, never for a different url', async () => {
  const h = await load({
    url: `${INSTANCE}/api/v1/runs/1`, name: 'run.log', parked: `${INSTANCE}/artifacts/run.log`,
  });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22d (#105): the match is exact — the parked url with a query bolted on is not it', async () => {
  const parked = `${INSTANCE}/artifacts/shot.png`;
  const h = await load({ url: `${parked}?x=1`, name: 'shot.png', parked });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

// A shorter path on the same instance passes a prefix test, and the token would go out on it.
test('22m (#105): a url the parked one only starts with is refused, not treated as a match', async () => {
  const h = await load({ url: `${INSTANCE}/`, name: 'shot.png', parked: `${INSTANCE}/artifacts/shot.png` });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22e (#105): http is refused outright, even when it is the url that was parked', async () => {
  const h = await load({ url: 'http://files.test/run.log', name: 'run.log' });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22f (#105): a parked record with no url in it vouches for nothing', async () => {
  const h = await load({ url: NEUTRAL, name: 'run.log', parked: {} });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22g (#105): no session store to check against is a refusal, not a guess', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', hasStorage: false });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22h (#105): the session store throws and the file is refused, not shown', async () => {
  const h = await load({ url: `${INSTANCE}/run.log`, name: 'run.log', sessionFail: true });
  assert.equal(h.kind(), 'refused');
  assert.deepEqual(h.fetches, []);
});

test('22i (#105): a kind with no preview is refused too — the note says which is which', async () => {
  const h = await load({ url: 'https://evil.test/x.zip', name: 'bundle.zip', parked: null });
  assert.equal(h.kind(), 'refused');
  assert.notEqual(h.text(), NO_PREVIEW);
});

test('22j (#105): the file the panel really parked opens exactly as it did before', async () => {
  const url = `${INSTANCE}/artifacts/run.log`;
  const h = await load({ url, name: 'run.log' });
  assert.equal(h.text(), BODY);
  assert.deepEqual(h.fetches, [{ url, opts: { instanceOnly: false } }]);
  assert.equal(h.$('viewer-open').href, url);
  assert.equal(h.$('viewer-open').hidden, false);
});

test('22k (#105): the swap to a second file is accepted — the parked record moved with it', async () => {
  const b = 'https://files.test/run/take.webm';
  const h = await load({ url: b, name: 'take.webm', parked: b });
  assert.equal(h.kind(), 'video');
  assert.equal(h.src(), b);
});

test('22l (#105): no url at all reaches nothing, so it keeps its own expired note', async () => {
  const h = await load({ name: 'shot.png', type: 'image/png', parked: `${INSTANCE}/other.png` });
  assert.equal(h.text(), BROKEN);
  assert.deepEqual(h.fetches, []);
});

test('21: the blob url the page made is never handed back — today one file leaks one url', async () => {
  const h = await load({ url: NEUTRAL, name: 'shot.png' });
  assert.equal(h.objectUrls.length, 1);
  assert.deepEqual(h.revoked, []);
});
