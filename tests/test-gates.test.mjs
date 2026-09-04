#!/usr/bin/env node
// The "you cannot do that right now" gates (extension/sidepanel/screens/test-gates.js): what a
// finished run, a row with no result yet or a login-blocked session does to the verdict buttons, the
// comment, the step circles and the three attach controls — so these rows were the gate half of
// tests/test-view-write.test.mjs until the block became its own file; the status write, the step
// writes and the pager stayed there.
// Two things are easy to get quietly wrong. The PRECEDENCE is not one rule: here the lock is asked
// first, because "no saved result yet" would invite a click that can no longer create one, while
// screens/attachments.js asks the missing result first — one helper owns the sentences and neither
// caller's order. And a probing session answers 'unknown', which must never gate: a gate that reads
// it as a refusal locks the attach controls of every tester whose probe has not landed yet.
// Rows are the ticket's 96-103. The sections after them are driven by nothing before this file: the
// extraction published the full-page toggle and the attachments fold, and a mutation in either left
// the whole suite green.
// Run: node --test tests/test-gates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, makeDocument, el, plain } from './helpers/panel-harness.mjs';

const HOST = 'app.testomat.io';
const LOCK = 'Run is finished — results are read-only';

// The three attach gates, verbatim. The recorder's two use commas where the others use em dashes;
// that drift is the reason these are strings in the test and not a template.
const NO_RESULT = {
  shot: 'No saved result yet — screenshots attach to a test result',
  file: 'No saved result yet — files attach to a test result',
  rec: 'No saved result yet, a recording attaches to a test result',
};
const DEGRADED = {
  shot: `Attaching screenshots needs an active ${HOST} web login — sign in there, then Refresh`,
  file: `Attaching files needs an active ${HOST} web login — sign in there, then Refresh`,
  rec: `Attaching a recording needs an active ${HOST} web login, sign in there, then Refresh`,
};
// The fourth wording, which only screens/attachments.js says — bare where the three above finish the
// sentence. tests/attachments.test.mjs drives it through the two lock functions that read it.
const DELETE = {
  noResult: 'No saved result yet',
  degraded: `Deleting needs an active ${HOST} web login — sign in there, then Refresh`,
};

const rec = (id, over = {}) => ({ id, test_id: id * 100, test_title: `Test ${id}`, status: 'pending', ...over });

// index.html's shape (:576-744), cut to the nodes a gate touches. `true` = hidden in markup. There is
// no `test-status` here: this module never speaks on the write's line, it only disables and explains.
const NODES = [
  ['textarea', 'test-comment'],
  ['button', 'btn-passed'], ['button', 'btn-failed'], ['button', 'btn-skipped'],
  ['p', 'status-lock-reason', true],
  ['button', 'btn-screenshot-annotate'], ['p', 'screenshot-reason', true],
  ['button', 'btn-attach-file'], ['p', 'attach-file-reason', true],
  ['button', 'btn-screen-rec'], ['p', 'screen-rec-reason', true],
  ['ul', 'attachment-list', true], ['div', 'test-steps'],
  ['button', 'attachments-head'], ['div', 'attachments-body'],
];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// The panel globals test-gates.js reads. There is no OfflineQueue here, no WriteCore and no
// TestomatAPI beyond `jwtAvailable`: a gate asks the world what it is, it never writes to it.
function load(opts = {}) {
  const o = {
    recordId: 7,
    records: null,        // default: one untested record, id 7
    jwtAvailable: true,   // TestomatAPI.jwtAvailable(): true | false | 'unknown'
    hasChrome: true,
    lock: '',             // recordWriteLock()'s answer
    dropdown: true,       // a panel where TestMeta.initSubstatus already ran
    stepButtons: 0,       // `.step-state` circles inside #test-steps
    tiles: 0,             // `.file-tile-item` rows already in the attachment list
    settings: { baseUrl: `https://${HOST}`, projectId: 'proj' },
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    node[key(id)] = n;
    doc.body.append(n);
  }
  // The one control this module writes rather than reads: app.js mirrors the setting into it.
  node.fullpageTest = el('input', { id: 'fullpage-test', type: 'checkbox', checked: false });
  doc.body.append(node.fullpageTest);
  for (let i = 0; i < o.stepButtons; i += 1) {
    node.testSteps.append(el('button', { className: 'btn icon size-xs step-state' }));
  }
  for (let i = 0; i < o.tiles; i += 1) {
    node.attachmentList.append(el('li', { className: 'file-tile-item' }));
  }
  const store = fakeChrome({ local: { settings: o.settings } });

  const calls = { attachmentLists: 0 };

  const state = {
    currentRecordId: o.recordId,
    records: o.records || [rec(7)],
    settings: o.settings,
  };

  // The substatus control the gate reaches for by id — the Dropdown's public face, not its DOM.
  const control = { trigger: el('button', { id: 'substatus-select' }), disabled: false };

  const globals = {
    state,
    hasChrome: o.hasChrome,
    $: (id) => doc.getElementById(id),
    baseUrlHost: () => HOST,
    // core/state.js:79's own, stringified on both sides.
    recordFor: (id) => state.records.find((r) => String(r.id) === String(id)),
    // run-view.js:351 — one reason for every row here; the per-record scoping is that screen's.
    recordWriteLock: () => o.lock,
    normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),
    renderAttachmentList: () => { calls.attachmentLists += 1; },
    // The real one writes data-tip on the node it is given (shared/tooltip.js:257,267); a recorder
    // alone could not tell a tip that landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
      get: (n) => (n && n.dataset ? (n.dataset.tip || '') : ''),
    },
    Dropdown: { of: (id) => (id === 'substatus-select' && o.dropdown ? control : null) },
    TestomatAPI: { jwtAvailable: () => o.jwtAvailable },
  };

  const h = loadScreen('test-gates', { globals, document: doc, store, exported: 'TestGates' });

  return { ...h, mod: h.screen, state, calls, node, doc, store, control };
}

// ---------- the gates and their copy (rows 96-103) ----------

test('96: a lock disables every verdict control and says the reason once, above them', () => {
  const h = load({ lock: LOCK, stepButtons: 2 });
  h.mod.update();
  for (const id of ['btnPassed', 'btnFailed', 'btnSkipped']) {
    assert.equal(h.node[id].disabled, true, id);
    assert.equal(h.node[id].dataset.tip, LOCK, id);
  }
  assert.equal(h.node.statusLockReason.textContent, LOCK);
  assert.equal(h.node.statusLockReason.hidden, false);
  assert.equal(h.node.testComment.disabled, true);
  assert.equal(h.node.testComment.dataset.tip, LOCK);
  assert.deepEqual(h.doc.querySelectorAll('#test-steps .step-state').map((b) => b.disabled), [true, true]);
  assert.equal(h.control.disabled, true);
});

test('96b: …and with no lock every one of them is live again', () => {
  const h = load({ stepButtons: 2 });
  h.mod.update();
  for (const id of ['btnPassed', 'btnFailed', 'btnSkipped']) assert.equal(h.node[id].disabled, false, id);
  assert.equal(h.node.statusLockReason.hidden, true);
  assert.equal(h.node.statusLockReason.textContent, '');
  assert.equal(h.node.testComment.disabled, false);
  assert.deepEqual(h.doc.querySelectorAll('#test-steps .step-state').map((b) => b.disabled), [false, false]);
  assert.equal(h.control.disabled, false);
});

test('97: the lock reaches the attach buttons on the TOOLTIP only — one copy, not four', () => {
  const h = load({ lock: LOCK });
  h.mod.update();
  for (const [btn, reason] of [['btnScreenshotAnnotate', 'screenshotReason'],
    ['btnAttachFile', 'attachFileReason'], ['btnScreenRec', 'screenRecReason']]) {
    assert.equal(h.node[btn].disabled, true, btn);
    assert.equal(h.node[btn].dataset.tip, LOCK, btn);
    assert.equal(h.node[reason].hidden, true, reason);
    assert.equal(h.node[reason].textContent, '', reason);
  }
});

test('98: no saved result yet — the three sentences, verbatim, inline and on the tooltip', () => {
  const h = load({ records: [rec(7, { id: null })] });
  h.mod.update();
  assert.equal(h.node.screenshotReason.textContent, NO_RESULT.shot);
  assert.equal(h.node.attachFileReason.textContent, NO_RESULT.file);
  assert.equal(h.node.screenRecReason.textContent, NO_RESULT.rec);
  assert.equal(h.node.btnScreenshotAnnotate.dataset.tip, NO_RESULT.shot);
  assert.equal(h.node.screenRecReason.hidden, false);
  // The verdict buttons are NOT gated by a missing id — a pending row is marked into existence.
  assert.equal(h.node.btnPassed.disabled, false);
});

test('99: a proven degraded session names the host to sign in to', () => {
  const h = load({ jwtAvailable: false });
  h.mod.update();
  assert.equal(h.node.screenshotReason.textContent, DEGRADED.shot);
  assert.equal(h.node.attachFileReason.textContent, DEGRADED.file);
  assert.equal(h.node.screenRecReason.textContent, DEGRADED.rec);
  assert.equal(h.node.btnAttachFile.disabled, true);
});

test('99b: the lock OUTRANKS a missing result and a degraded session both', () => {
  const h = load({ lock: LOCK, jwtAvailable: false, records: [rec(7, { id: null })] });
  h.mod.update();
  assert.equal(h.node.btnScreenshotAnnotate.dataset.tip, LOCK);
  assert.equal(h.node.screenshotReason.textContent, '');
});

test('100: a session still probing must never gate — "unknown" is not a refusal', () => {
  const h = load({ jwtAvailable: 'unknown' });
  h.mod.update();
  for (const id of ['btnScreenshotAnnotate', 'btnAttachFile', 'btnScreenRec']) {
    assert.equal(h.node[id].disabled, false, id);
  }
  assert.equal(h.node.screenshotReason.hidden, true);
});

test('101: lifting a gate restores the button\'s own tooltip, not an empty one', () => {
  const h = load({ jwtAvailable: false });
  h.node.btnAttachFile.dataset.tip = 'Attach a file to this result';
  h.mod.update();
  assert.equal(h.node.btnAttachFile.dataset.tip, DEGRADED.file);
  h.sandbox.TestomatAPI.jwtAvailable = () => true; // the tester signed in and hit Refresh
  h.mod.update();
  assert.equal(h.node.btnAttachFile.dataset.tip, 'Attach a file to this result');
  assert.equal(h.node.btnAttachFile.disabled, false);
});

test('102: an unmarked row fills none of the three verdict buttons', () => {
  const h = load();
  h.mod.paintStatusButtons('pending');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].className),
    ['outline', 'outline', 'outline']);
  // …and a real verdict fills exactly its own.
  h.mod.paintStatusButtons('failed');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].className),
    ['outline', 'solid', 'outline']);
});

test('103: a status the panel does not know fills nothing either', () => {
  const h = load();
  h.mod.paintStatusButtons('quarantined');
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].classList.contains('solid')),
    [false, false, false]);
  h.mod.paintStatusButtons(null);
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].classList.contains('solid')),
    [false, false, false]);
});

// The buttons double as the result display, and the gate repaint is the only thing that fills them
// after a verdict lands. Dropping that one call from update() showed on no row before this one.
test('103b: a repaint through the gate fills the button the row actually holds', () => {
  const h = load({ records: [rec(7, { status: 'failed' })] });
  h.mod.update();
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => h.node[id].classList.contains('solid')),
    [false, true, false]);
  // …and a row with no verdict yet fills none of them.
  const fresh = load();
  fresh.mod.update();
  assert.deepEqual(['btnPassed', 'btnFailed', 'btnSkipped'].map((id) => fresh.node[id].classList.contains('solid')),
    [false, false, false]);
});

// ---------- the copy, now that one function owns it (#197) ----------
// Four wordings for one refusal, in two files, until this module took them over. They are asserted
// as literals rather than built from a template: a helper that composed them would drift them.

// `plain` on every answer: the object is built in the vm realm, so its prototype is not this one's.
test('the four gate sentences come back byte for byte, the host filled in', () => {
  const h = load();
  assert.deepEqual(plain(h.mod.gateReason({ need: 'screenshot' })), { noResult: NO_RESULT.shot, degraded: DEGRADED.shot });
  assert.deepEqual(plain(h.mod.gateReason({ need: 'file' })), { noResult: NO_RESULT.file, degraded: DEGRADED.file });
  assert.deepEqual(plain(h.mod.gateReason({ need: 'recording' })), { noResult: NO_RESULT.rec, degraded: DEGRADED.rec });
  assert.deepEqual(plain(h.mod.gateReason({ need: 'delete' })), DELETE);
});

test('a need nobody wrote copy for answers with no sentence rather than a broken one', () => {
  const h = load();
  assert.deepEqual(plain(h.mod.gateReason({ need: 'video' })), { noResult: '', degraded: '' });
  assert.deepEqual(plain(h.mod.gateReason({})), { noResult: '', degraded: '' });
  assert.deepEqual(plain(h.mod.gateReason()), { noResult: '', degraded: '' });
});

test('the sentence names whatever host the panel is pointed at', () => {
  const h = load();
  h.sandbox.baseUrlHost = () => 'staging.testomat.io';
  assert.equal(h.mod.gateReason({ need: 'file' }).degraded,
    'Attaching files needs an active staging.testomat.io web login — sign in there, then Refresh');
});

// ---------- the dropzone that repeats the gate ----------
// An empty list draws the same reason in its own copy (screens/attachments.js), so it has to be
// rebuilt when the gate moves — and left alone when it holds real tiles, whose thumbnails would go.

test('an empty attachment list is repainted with the gate; one holding files is not', () => {
  const h = load();
  h.mod.update();
  assert.equal(h.calls.attachmentLists, 1);
  const full = load({ tiles: 1 });
  full.mod.update();
  assert.equal(full.calls.attachmentLists, 0);
});

// ---------- the full-page capture toggle ----------
// Published by the extraction and driven by nothing until now: hotkeys.js reads it before every
// capture and app.js writes it from the checkbox, so both directions are asserted here.

test('the checkbox mirrors the stored setting, in both positions', () => {
  const off = load();
  off.mod.syncFullPageToggles();
  assert.equal(off.mod.fullPageCaptureEnabled(), false);
  assert.equal(off.node.fullpageTest.checked, false);

  const on = load({ settings: { baseUrl: `https://${HOST}`, fullPageCapture: true } });
  on.mod.syncFullPageToggles();
  assert.equal(on.mod.fullPageCaptureEnabled(), true);
  assert.equal(on.node.fullpageTest.checked, true);
});

test('setting it persists the whole settings object and mirrors it straight away', async () => {
  const h = load();
  await h.mod.setFullPageCapture(true);
  assert.equal(h.state.settings.fullPageCapture, true);
  assert.equal(h.node.fullpageTest.checked, true);
  assert.deepEqual(h.store.ops('local', 'set').map((c) => c.arg.settings.fullPageCapture), [true]);
  // …and off again, so "persists" is not just "writes true".
  await h.mod.setFullPageCapture(false);
  assert.equal(h.state.settings.fullPageCapture, false);
  assert.equal(h.node.fullpageTest.checked, false);
});

test('no settings loaded yet writes nothing at all', async () => {
  const h = load({ settings: null });
  await h.mod.setFullPageCapture(true);
  assert.deepEqual(h.store.ops('local', 'set'), []);
  assert.equal(h.node.fullpageTest.checked, false);
});

test('a storage that refuses still leaves the toggle where the tester put it', async () => {
  const h = load();
  h.store.fails.set = new Error('quota');
  await h.mod.setFullPageCapture(true); // best effort: the rejection must not reach the caller
  assert.equal(h.mod.fullPageCaptureEnabled(), true);
  assert.equal(h.node.fullpageTest.checked, true);
  // …and a panel with no chrome at all never reaches storage.
  const bare = load({ hasChrome: false });
  await bare.mod.setFullPageCapture(true);
  assert.deepEqual(bare.store.ops('local', 'set'), []);
  assert.equal(bare.node.fullpageTest.checked, true);
});

// ---------- the attachments fold ----------
// Open by default and remembered for the panel session; clickStatus reopens it on FAILED
// (tests/test-view-write.test.mjs:92), which is the one caller that must never CLOSE it.

test('the fold starts open, and a toggle closes it on the head as well as the body', () => {
  const h = load();
  h.mod.applyAttachmentsDisclosure();
  assert.equal(h.node.attachmentsBody.hidden, false);
  assert.equal(h.node.attachmentsHead.getAttribute('aria-expanded'), 'true');
  h.mod.toggleAttachmentsDisclosure();
  assert.equal(h.node.attachmentsBody.hidden, true);
  assert.equal(h.node.attachmentsHead.getAttribute('aria-expanded'), 'false');
  h.mod.toggleAttachmentsDisclosure();
  assert.equal(h.node.attachmentsBody.hidden, false);
});

test('opening an already-open fold leaves it open — it is not a second toggle', () => {
  const h = load();
  h.mod.applyAttachmentsDisclosure(); // the paint every test open does
  h.mod.openAttachmentsDisclosure();
  assert.equal(h.node.attachmentsBody.hidden, false);
  h.mod.expandForFailure();
  assert.equal(h.node.attachmentsBody.hidden, false);
  // …and from closed, either name really does open it.
  h.mod.toggleAttachmentsDisclosure();
  assert.equal(h.node.attachmentsBody.hidden, true);
  h.mod.expandForFailure();
  assert.equal(h.node.attachmentsBody.hidden, false);
  assert.equal(h.node.attachmentsHead.getAttribute('aria-expanded'), 'true');
});
