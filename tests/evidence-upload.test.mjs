#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, plain, SCREENS_SRC, CORE_SRC } from './helpers/panel-harness.mjs';

// The real trim: a stub could let through an address that PRIVACY.md says never leaves.
const envTrimUrl = runInNewContext(`${readFileSync(join(CORE_SRC, 'env-info.js'), 'utf8')}\nenvTrimUrl;`, { URL });

// The real auto-attach gate and kept window from evidence.js, so no row passes on a gate never opened.
const screenSrc = readFileSync(join(SCREENS_SRC, 'evidence.js'), 'utf8');
const fromScreen = (state) => runInNewContext(
  `${screenSrc}\n({ evidenceAutoAttachEnabled, evWindowSeconds });`, { state },
);

// The .txt stamps rows in local time, so TZ is pinned to keep the UTC fixture stamps asserted.
process.env.TZ = 'UTC';

const NOW = Date.UTC(2026, 8, 3, 14, 6, 9); // what the panel's clock reads, and names the upload
const TS = Date.UTC(2026, 8, 3, 14, 5, 9);  // one minute earlier: every fixture entry's stamp
const SITE = 'https://shop.example.com';
const UPLOADED = 'https://cdn.example/evidence.txt';

// new Date() stamps the header and Date.now() names the file; the one-argument form stays real.
class PinnedDate extends Date {
  constructor(...args) { if (!args.length) super(NOW); else super(...args); }
  static now() { return NOW; }
}

// The host object the sandbox has no realm copy of — the blob is asserted by its text.
class FakeBlob {
  constructor(parts, opts) { this.text = parts.join(''); this.type = opts && opts.type; }
}

const con = (over = {}) => ({ kind: 'console', level: 'error', text: 'boom', ts: TS, ...over });
const net = (over = {}) => ({ kind: 'network', status: 500, method: 'GET', url: `${SITE}/api/y`, ts: TS, ...over });

// All globals real except evSend: the worker's answers are the input to almost every row.
function load(opts = {}) {
  const o = {
    settings: {},          // state.settings — `{}` is "configured, nothing customised"
    runTitle: 'Run A',
    testTitle: '',         // what #test-title carries
    without: [],           // ids to leave out of the page
    reply: null,           // (msg) => the worker's answer; by default a stopped recorder
    upload: { url: UPLOADED },
    ...opts,
  };

  const doc = makeDocument([]);
  if (!o.without.includes('test-title')) {
    const title = el('h2', { id: 'test-title' });
    title.textContent = o.testTitle;
    doc.body.append(title);
  }

  const calls = { sends: [], toasts: [], uploads: [] };
  const state = { runTitle: o.runTitle, settings: o.settings };
  const screen = fromScreen(state);

  const globals = {
    state,
    Date: PinnedDate,
    Blob: FakeBlob,
    envTrimUrl,
    evidenceAutoAttachEnabled: screen.evidenceAutoAttachEnabled,
    evWindowSeconds: screen.evWindowSeconds,
    evSend: async (msg) => {
      calls.sends.push(plain(msg));
      return o.reply ? o.reply(msg) : { ok: true, status: { recording: false } };
    },
    $: (id) => doc.getElementById(id),
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); },
    TestomatAPI: {
      uploadAttachment: async (id, blob, name) => {
        calls.uploads.push({ id: String(id), blob, name });
        return typeof o.upload === 'function' ? o.upload() : o.upload;
      },
    },
  };

  const h = loadScreen('evidence-upload', {
    // index.html's order: the escaping layer is evaluated first, so the .txt is the one a team would open.
    before: ['evidence-format'],
    exported: '({ EvidenceUpload, EvidenceFormat })',
    document: doc, globals,
  });

  return {
    ...h,
    state, calls,
    // Both are lexical consts, reachable only off the completion value, not off the sandbox.
    up: h.screen.EvidenceUpload,
    format: h.screen.EvidenceFormat,
    types: () => calls.sends.map((m) => m.type),
  };
}

const SNAP = {
  ok: true,
  entries: [con(), net({ url: 'https://x/y', bodySnippet: '{"a":1}' })],
  status: { tabTitle: 'Shop', tabUrl: `${SITE}/cart`, windowSec: 60 },
};
const recorded = (m) => {
  if (m.type === 'EVIDENCE_STATUS') return { ok: true, status: { recording: true } };
  if (m.type === 'EVIDENCE_SNAPSHOT') return SNAP;
  return { ok: true, status: { recording: false } };
};

test('55: with no result to hang it on, or auto-attach off, the FAIL attaches nothing', async () => {
  const none = load({ reply: recorded });
  assert.equal(await none.up.log(null), '');
  assert.equal(await none.up.log({}), '');
  assert.equal(await none.up.log({ id: '' }), '');
  assert.deepEqual(none.types(), []);

  const off = load({ settings: { evidenceAutoAttach: false }, reply: recorded });
  assert.equal(await off.up.log({ id: '900' }), '');
  assert.deepEqual(off.types(), []);
  assert.deepEqual(off.calls.uploads, []);

  const on = load({ reply: recorded });
  assert.equal(await on.up.log({ id: '900' }), UPLOADED);
});

test('56: a recorder that is not recording is asked for no snapshot at all', async () => {
  const idle = load({ reply: (m) => (m.type === 'EVIDENCE_STATUS'
    ? { ok: true, status: { recording: false } } : recorded(m)) });
  assert.equal(await idle.up.log({ id: '900' }), '');
  assert.deepEqual(idle.types(), ['EVIDENCE_STATUS']);

  const gone = load({ reply: (m) => (m.type === 'EVIDENCE_STATUS' ? { ok: false, error: 'no-extension' } : recorded(m)) });
  assert.equal(await gone.up.log({ id: '900' }), '');
  assert.deepEqual(gone.types(), ['EVIDENCE_STATUS']);

  const empty = load({ reply: (m) => (m.type === 'EVIDENCE_SNAPSHOT' ? { ok: false } : recorded(m)) });
  assert.equal(await empty.up.log({ id: '900' }), '');
  assert.deepEqual(empty.types(), ['EVIDENCE_STATUS', 'EVIDENCE_SNAPSHOT']);
  assert.deepEqual(empty.calls.uploads, []);
});

test('57: the FAIL uploads the window as a named .txt, and hands back the URL the META key needs', async () => {
  const h = load({ reply: recorded });
  const url = await h.up.log({ id: '900', test_title: 'Test B' });
  assert.equal(url, UPLOADED);
  assert.deepEqual(h.types(), ['EVIDENCE_STATUS', 'EVIDENCE_SNAPSHOT']);
  assert.equal(h.calls.uploads.length, 1);
  const sent = h.calls.uploads[0];
  assert.equal(sent.id, '900');
  assert.equal(sent.name, `evidence-900-${NOW}.txt`);
  assert.equal(sent.blob.type, 'text/plain');
  // The run title comes from `state`, the test title from the record, the rows from the snapshot.
  assert.ok(sent.blob.text.startsWith('Console & network log — Run A / Test B\nRecorded tab: Shop\n'), sent.blob.text);
  assert.ok(sent.blob.text.includes('== Console (1) ==\n[14:05:09] console.error: boom'), sent.blob.text);
  assert.ok(sent.blob.text.includes('== Network (1) ==\n[14:05:09] 500 GET https://x/y\n    {"a":1}'), sent.blob.text);
  assert.equal(sent.blob.text, h.format.buildTxt('Run A', 'Test B', SNAP.entries, SNAP.status));
});

test('57b: a record with no title of its own borrows the one on screen', async () => {
  const h = load({ testTitle: 'Checkout — guest', reply: recorded });
  await h.up.log({ id: '900' });
  assert.ok(h.calls.uploads[0].blob.text.startsWith('Console & network log — Run A / Checkout — guest\n'));
  const bare = load({ reply: recorded, without: ['test-title'] });
  await bare.up.log({ id: '900' });
  assert.ok(bare.calls.uploads[0].blob.text.startsWith('Console & network log — Run A / Test\n'));
});

// buildTxt reads status and entries outside the try, so a missing one would throw from the meta write.
test('57c: a snapshot with no status and no entries still uploads, rather than throwing at the meta write', async () => {
  const bare = (m) => (m.type === 'EVIDENCE_SNAPSHOT'
    ? { ok: true }                              // ok, and neither `status` nor `entries`
    : { ok: true, status: { recording: true } });
  const h = load({ reply: bare });
  const url = await h.up.log({ id: '900', test_title: 'Test B' });
  assert.equal(url, UPLOADED);
  // Each field falls back as buildTxt does elsewhere: em dash, the panel's kept window, and (none).
  const text = h.calls.uploads[0].blob.text;
  assert.ok(text.includes('\nRecorded tab: —\n'), text);
  assert.ok(text.includes('Window: last 60s · 0 entries'), text);
  assert.ok(text.includes('== Console (0) ==\n(none)'), text);
  assert.ok(text.includes('== Network (0) ==\n(none)'), text);
});

test('58: an upload that fails is non-fatal — the status write already landed', async () => {
  const broke = load({ reply: recorded, upload: () => { throw new Error('413 too large'); } });
  assert.equal(await broke.up.log({ id: '900' }), '');
  assert.deepEqual(broke.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (413 too large)", error: true },
  ]);

  const silent = load({ reply: recorded, upload: () => ({}) });
  assert.equal(await silent.up.log({ id: '900' }), '');
  assert.deepEqual(silent.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (upload returned no url)", error: true },
  ]);
  // A landing upload says nothing at all: the sentence is the failure's, not the flow's.
  const ok = load({ reply: recorded });
  assert.equal(await ok.up.log({ id: '900' }), UPLOADED);
  assert.deepEqual(ok.calls.toasts, []);
});

test('58 (#267): a log that could not attach is toasted as an error, not as a confirmation', async () => {
  const h = load({ reply: recorded, upload: () => { throw new Error('413 too large'); } });
  await h.up.log({ id: '900' });
  assert.deepEqual(h.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (413 too large)", error: true },
  ]);
  const ok = load({ reply: recorded });
  await ok.up.log({ id: '900' });
  assert.deepEqual(ok.calls.toasts, []);
});

// The window is too big to park with a queued fail (1000 x 16KB vs 10MB), so a replay skips this.
test('59 (#107): the log is the recorder\'s window NOW, whatever the record it is handed carries', async () => {
  const atFailTime = [con({ text: 'the error the tester saw' })];
  const rightNow = [con({ text: 'an unrelated page open at replay time' })];
  const h = load({ reply: (m) => {
    if (m.type === 'EVIDENCE_STATUS') return { ok: true, status: { recording: true } };
    if (m.type === 'EVIDENCE_SNAPSHOT') return { ok: true, entries: rightNow, status: { windowSec: 60 } };
    return { ok: true, status: { recording: false } };
  } });
  await h.up.log({ id: '900', test_title: 'T', queuedAt: NOW - 3_600_000, entries: atFailTime });
  const txt = h.calls.uploads[0].blob.text;
  assert.ok(txt.includes('an unrelated page open at replay time'), txt);
  assert.ok(!txt.includes('the error the tester saw'), txt);
});

test('59b (#107): and hours later the recorder is usually stopped, so a replay would attach nothing', async () => {
  const idle = load({ reply: () => ({ ok: true, status: { recording: false } }) });
  assert.equal(await idle.up.log({ id: '900', test_title: 'T' }), '');
  assert.deepEqual(idle.calls.uploads, []);
  assert.deepEqual(idle.calls.toasts, []); // silent: the missing key is not a failure to report here
});
