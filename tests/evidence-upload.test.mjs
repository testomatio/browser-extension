#!/usr/bin/env node
// extension/sidepanel/screens/evidence-upload.js (#157 rows 55-59, moved out of tests/evidence.test.mjs
// by #193): the one thing the evidence panel sends out by itself. Marking a test Failed takes the
// recorder's window — the last minute of the tested tab's console errors and failed requests — and
// hangs it on the result as a readable .txt, whose URL becomes the `Console & network log` meta key.
// It runs AFTER the status write has landed, and that is what every row here is really about: the
// verdict is already saved, so nothing this can fail at may be turned into a lost click. Every way
// out is an empty string, which writes no meta key, and the one sentence it prints says the log did
// not attach — flagged an error, because a tester who reads it as a confirmation stops looking.
// Run: node --test tests/evidence-upload.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, plain, SCREENS_SRC, CORE_SRC } from './helpers/panel-harness.mjs';

// The REAL trim from core/env-info.js, not a look-alike: EvidenceFormat is loaded beside the module
// the way index.html loads it, and the .txt below is asserted whole — a stub would let an address
// through that PRIVACY.md says never leaves. CORE_SRC points the suite at a mutated COPY of core/.
const envTrimUrl = runInNewContext(`${readFileSync(join(CORE_SRC, 'env-info.js'), 'utf8')}\nenvTrimUrl;`, { URL });

// The auto-attach gate and the kept window stay in screens/evidence.js and are reached from here as
// late-bound globals. The real ones, read out of the screen the same way evidence-format.test.mjs
// reads them, so no row can pass against a gate the panel would never open; SCREENS_SRC is honoured.
const screenSrc = readFileSync(join(SCREENS_SRC, 'evidence.js'), 'utf8');
const fromScreen = (state) => runInNewContext(
  `${screenSrc}\n({ evidenceAutoAttachEnabled, evWindowSeconds });`, { state },
);

// The .txt stamps its rows with getHours/getMinutes/getSeconds — LOCAL time. Pinned here so the
// ticket's own UTC stamps are the ones asserted.
process.env.TZ = 'UTC';

const NOW = Date.UTC(2026, 8, 3, 14, 6, 9); // what the panel's clock reads, and names the upload
const TS = Date.UTC(2026, 8, 3, 14, 5, 9);  // one minute earlier: every fixture entry's stamp
const SITE = 'https://shop.example.com';
const UPLOADED = 'https://cdn.example/evidence.txt';

// new Date() stamps the .txt header and Date.now() names the file. The one-argument form stays real,
// because that is the entry timestamp each row of the .txt is stamped from.
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

// The module's own globals, all of them real except the messaging: `evSend` is where the worker's
// answers come from, and those answers are the input to almost every row below. The panel's page is
// cut to the one node this reads — the test title it borrows when the record carries none.
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
    // index.html's own order: the escaping layer is evaluated into this context first, so the .txt
    // every row reads is the one the tester's team would open.
    before: ['evidence-format'],
    exported: '({ EvidenceUpload, EvidenceFormat })',
    document: doc, globals,
  });

  return {
    ...h,
    state, calls,
    // Both are lexical consts: invisible as sandbox properties, reachable only off the completion
    // value, the same seam tests/md-sections.test.mjs uses.
    up: h.screen.EvidenceUpload,
    format: h.screen.EvidenceFormat,
    types: () => calls.sends.map((m) => m.type),
  };
}

// ---------- the upload on a failed test (rows 55-59) ----------

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

  // The same record with the gate open goes all the way to the upload.
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

  // A snapshot the worker could not build stops one step later, before any blob is made.
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
  // With neither, the artifact still names itself rather than printing an empty half.
  const bare = load({ reply: recorded, without: ['test-title'] });
  await bare.up.log({ id: '900' });
  assert.ok(bare.calls.uploads[0].blob.text.startsWith('Console & network log — Run A / Test\n'));
});

// 57c: `snap.status || {}` and `snap.entries || []` are both load-bearing, and nothing pinned
// either — dropping the `|| {}` stayed green through the whole suite, and so did dropping the `|| []`.
// buildTxt reads status.tabTitle and filters entries before the try block, so an ok snapshot missing
// one of them would throw straight out of the meta write whose status had already saved.
test('57c: a snapshot with no status and no entries still uploads, rather than throwing at the meta write', async () => {
  const bare = (m) => (m.type === 'EVIDENCE_SNAPSHOT'
    ? { ok: true }                              // ok, and neither `status` nor `entries`
    : { ok: true, status: { recording: true } });
  const h = load({ reply: bare });
  const url = await h.up.log({ id: '900', test_title: 'Test B' });
  assert.equal(url, UPLOADED);
  // Every field falls back the way buildTxt falls back everywhere else: the em dash for a tab it was
  // never told about, the panel's own kept window, and `(none)` under a section with nothing in it.
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
  // The status write landed and the evidence did not — the sentence saying so used to look
  // exactly like the sentences that mean everything went fine.
  assert.deepEqual(h.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (413 too large)", error: true },
  ]);
  // Those sentences are still unflagged: the upload that landed says nothing at all…
  const ok = load({ reply: recorded });
  await ok.up.log({ id: '900' });
  assert.deepEqual(ok.calls.toasts, []);
  // …and the panel's own Attach still prints an unflagged confirmation — that half of the contrast
  // stays with the screen, in rows 53-54 of tests/evidence.test.mjs, now that the two live apart.
});

// #107: the offline queue replays a parked FAIL through writeStatus -> writeEnvMeta -> here. This
// window cannot be parked with the entry — up to 1000 entries carrying a 16KB body each, against
// storage.local's 10MB — so the two rows below are why the replay path skips this function outright.
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
