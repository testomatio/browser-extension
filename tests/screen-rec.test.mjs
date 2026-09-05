#!/usr/bin/env node
// What extension/sidepanel/screens/screen-rec.js does for the tester (#186): one button that records
// the tab, and the upload of the file the worker parks when it stops. Two promises are expensive to
// break here. The button must always say which of the three things it is about to do — stop a
// recording, go back to a take waiting for review, or retry an upload that failed — because a button
// that offers "Attach screen recording" over a parked take invites recording on top of the tester's
// only copy. And a take names the result it was recorded for: the panel may have moved to another
// test by the time the file arrives, and the take must wait for ITS test rather than land on the one
// that happens to be open. Both were real regressions (949e08d, c59c8cf) before they were rules.
// The worker's half of the same protocol is tests/screenrec-session.test.mjs; the fixtures below
// carry exactly the fields extension/screenrec/parked.js builds, so the two sides cannot drift.
// Rows 1-33 are the ticket's; a lettered suffix is the companion case that drives the same path the
// other way, so a row asserting "nothing happened" cannot pass against a stub that never worked.
// Run: node --test tests/screen-rec.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadScreen, fakeClock, makeDocument, el, fire, plain, settle, CORE_SRC,
} from './helpers/panel-harness.mjs';

// The worker's cap and its parked-take shape, copied from extension/screenrec/session.js and
// extension/screenrec/parked.js — the panel reads these fields and nothing else.
const CAP_MS = 5 * 60 * 1000;
const TAKE = (over = {}) => ({
  url: 'blob:chrome-extension://ext/take-1',
  size: 4096,
  ms: 65000,
  reason: 'user',
  name: 'screen-recording-2026-09-06-1042.webm',
  recordId: null,
  reviewed: true,
  ...over,
});
const IDLE = (file = null) => ({ recording: false, capMs: CAP_MS, file });
const LIVE = (over = {}) => ({
  recording: true, paused: false, ms: 65000, bytes: 900, tabId: 7, recordId: 'r-6', capMs: CAP_MS, ...over,
});

// Three results, kept apart on purpose: the one the panel has open, one loaded beside it, and an id
// no loaded record carries. Rows 18 and 22-28 are only worth anything while those three differ.
const OPEN = { id: 'r-6', test_title: 'Checkout works', test_id: 'T-6' };
const BESIDE = { id: 'r-5', test_title: 'Login works', test_id: 'T-5' };
const NAMELESS = { id: 'r-7', test_id: 'T-7' };
const STRANGER = 'r-9'; // recorded for a test this panel never loaded

const SHORTCUT = 'Alt+Shift+R';
const ELSEWHERE = 'This recording belongs to another test — open it to attach the file.';
const NO_TEST = 'Open a test result and the recording attaches to it.';
const ARCHIVED = 'Run is archived — results are read-only';

const camel = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// index.html:731 and :748, cut to the three nodes this screen touches.
function makePage(without) {
  const doc = makeDocument([]);
  const node = {};
  const mk = (tag, id, props = {}) => {
    const n = el(tag, { id, ...props });
    node[camel(id)] = n;
    return n;
  };
  const btn = mk('button', 'btn-screen-rec', { className: 'btn size-sm' });
  btn.append(el('span', { className: 'md-icon', dataset: { icon: 'videocam' } }),
    mk('span', 'screen-rec-label', { textContent: 'Attach screen recording' }));
  doc.body.append(btn, mk('p', 'screen-rec-reason', { className: 'hint inline-reason', hidden: true }));
  for (const id of without) {
    const n = doc.getElementById(id);
    if (n) n.remove();
  }
  return { doc, node };
}

function load(opts = {}) {
  const o = {
    records: [],           // state.records — what recordFor can find
    currentRecordId: null, // the open result
    runId: null,           // with a runId, the archived flag below turns into a write lock
    archived: false,
    shortcut: SHORTCUT,    // chrome.commands.getAll's answer for SREC_COMMAND
    commands: null,        // () => the full command list, or a throw
    reject: [],            // message types chrome.runtime.sendMessage rejects on
    upload: null,          // (recordId, blob, name) => result, or a throw
    fetchThrows: null,
    blob: { size: 4096, type: 'video/webm' },
    without: [],           // ids to leave out of the page
    ...opts,
  };

  const { doc, node } = makePage(o.without);
  const order = [];   // every observable act, in the order it happened — rows 22, 24 and 25 are order
  const sends = [];
  const calls = {
    toasts: [], progress: [], status: [], remembered: [], uploads: [], fetches: [],
    hides: 0, renders: 0, gates: 0, clicks: [],
  };

  // The worker's answers, mutable: a stop or an attach changes what the next status says.
  const worker = {
    SCREENREC_STATUS: IDLE(),
    SCREENREC_TAKE: null,
    SCREENREC_START: { ok: true },
    SCREENREC_STOP: { ok: true },
    SCREENREC_CLAIM: { ok: true },
    SCREENREC_DONE: { ok: true },
    SCREENREC_UNCLAIM: { ok: true },
    SCREENREC_TARGET: { ok: true },
    SCREENREC_OPEN_REVIEW: { ok: true },
  };
  const rejects = new Set(o.reject);

  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => { listeners.push(fn); } },
      sendMessage: (msg) => {
        order.push(`send:${msg.type}`);
        sends.push(plain(msg));
        if (rejects.has(msg.type)) return Promise.reject(new Error('Receiving end does not exist'));
        const a = worker[msg.type];
        return Promise.resolve(typeof a === 'function' ? a(msg) : a);
      },
    },
    commands: {
      getAll: async () => {
        order.push('commands.getAll');
        if (o.commands) return o.commands();
        return [{ name: 'other-thing', shortcut: 'Alt+9' },
          { name: 'toggle-screen-recording', shortcut: o.shortcut }];
      },
    },
  };
  const listeners = [];

  const globals = {
    chrome: chromeStub,
    fetch: async (url) => {
      order.push('fetch');
      calls.fetches.push(url);
      if (o.fetchThrows) throw o.fetchThrows;
      return { blob: async () => o.blob };
    },
    TestGates: { update: () => { order.push('TestGates.update'); calls.gates += 1; } },
    toast: (msg, opts2 = {}) => { order.push('toast'); calls.toasts.push({ msg, ...opts2 }); },
    progressToast: (msg) => { order.push('progressToast'); calls.progress.push(msg); },
    hideToast: () => { order.push('hideToast'); calls.hides += 1; },
    setStatusLine: (id, msg, cls = '') => {
      order.push(`status:${id}`);
      calls.status.push({ id, msg, cls });
    },
    attRemember: (recordId, entry) => {
      order.push('attRemember');
      calls.remembered.push({ recordId, entry: plain(entry) });
    },
    renderAttachmentList: () => { order.push('renderAttachmentList'); calls.renders += 1; },
    TestomatAPI: {
      uploadAttachment: async (recordId, blob, name) => {
        order.push('upload');
        calls.uploads.push({ recordId, name, blob });
        if (o.upload) return o.upload(recordId, blob, name);
        return { url: 'https://app.testomat.io/attachments/take-1.webm' };
      },
    },
  };

  const clock = fakeClock();
  const h = loadScreen('screen-rec', {
    // The REAL state bag, recordFor and RunLock, loaded the way index.html loads them: `recordFor`
    // compares ids as text and `recordWriteLock` is three rules deep, and a look-alike for either
    // would let rows 18-20 and 26-28 pass against a comparison this panel does not make.
    before: [['state', CORE_SRC], 'run-lock'],
    exported: '({ srecClock, SREC_COMMAND, SREC_ME, state, recordFor, RunLock })',
    document: doc, clock, globals,
  });

  const { state } = h.screen;
  state.records = o.records;
  state.currentRecordId = o.currentRecordId;
  state.runId = o.runId;
  if (o.archived) state.runInfo = { isArchived: true };

  return {
    ...h,
    doc, node, state, order, sends, calls, clock, worker, listeners,
    fn: h.fn,
    types: () => sends.map((s) => s.type),
    sent: (type) => sends.filter((s) => s.type === type),
    label: () => (node.screenRecLabel ? node.screenRecLabel.textContent : null),
    reason: () => node.screenRecReason.textContent,
    reasonHidden: () => node.screenRecReason.hidden,
    isRecording: () => node.btnScreenRec.classList.contains('recording'),
    // One trip through the chrome.runtime.onMessage listener registered at load.
    message: (msg) => listeners[0](msg, { id: 'ext' }, () => {}),
    clear: () => { order.length = 0; sends.length = 0; return h; },
  };
}

// ============================================================================
// The clock (row 1)
// ============================================================================

test('1: the button counts the recording in minutes and seconds', () => {
  const { srecClock } = load().screen;
  assert.equal(srecClock(65000), '1:05');
  assert.equal(srecClock(599999), '9:59');
  assert.equal(srecClock(60000), '1:00');
  assert.equal(srecClock(5999), '0:05');
});

test('1a: nothing recorded yet reads 0:00 rather than a blank or a NaN', () => {
  const { srecClock } = load().screen;
  assert.equal(srecClock(0), '0:00');
  assert.equal(srecClock(undefined), '0:00');
  assert.equal(srecClock(null), '0:00');
});

test('1b: past ten minutes the clock keeps counting instead of wrapping', () => {
  const { srecClock } = load().screen;
  assert.equal(srecClock(600000), '10:00');
  assert.equal(srecClock(3661000), '61:01');
  assert.equal(srecClock(CAP_MS), '5:00');
});

// ============================================================================
// The three states the button can be in (rows 2-6)
// ============================================================================

test('2: while a recording runs the button says Stop recording with the minutes on it', () => {
  const h = load();
  h.fn.srecPaint(LIVE({ ms: 65000 }));
  assert.equal(h.label(), 'Stop recording 1:05');
  assert.equal(h.isRecording(), true);
  assert.equal(h.node.btnScreenRec.disabled, false);
  assert.equal(h.clock.count(), 1);
  assert.deepEqual(h.clock.arms(), [1000]);
});

test('2a: the armed second re-asks the worker, so the minutes on the button move', async () => {
  const h = load();
  h.fn.srecPaint(LIVE({ ms: 65000 }));
  h.worker.SCREENREC_STATUS = LIVE({ ms: 66000 });
  h.clear();
  await h.clock.tick();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
  assert.equal(h.label(), 'Stop recording 1:06');
});

test('2b: a repaint while still recording does not stack a second timer', () => {
  const h = load();
  h.fn.srecPaint(LIVE());
  h.fn.srecPaint(LIVE({ ms: 70000 }));
  assert.equal(h.clock.count(), 1);
  assert.deepEqual(h.clock.arms(), [1000]);
  assert.equal(h.label(), 'Stop recording 1:10');
});

test('3: a take waiting to be looked at turns the button into Review recording…', () => {
  const h = load();
  h.fn.srecPaint(IDLE(TAKE({ reviewed: false })));
  assert.equal(h.label(), 'Review recording…');
  assert.equal(h.node.btnScreenRec.disabled, false);
  assert.equal(h.isRecording(), false);
});

test('4: a take whose upload failed turns the button into Retry attach…', () => {
  const h = load();
  h.fn.srecPaint(IDLE(TAKE({ reviewed: true })));
  assert.equal(h.label(), 'Retry attach…');
  assert.equal(h.node.btnScreenRec.disabled, false);
});

test('5: with nothing recording and nothing parked the button offers a new recording', () => {
  const h = load();
  h.fn.srecPaint(LIVE());
  h.fn.srecPaint(IDLE());
  assert.equal(h.label(), 'Attach screen recording');
  assert.equal(h.isRecording(), false);
});

test('5a: no answer at all from the worker reads exactly like nothing parked', () => {
  const h = load();
  h.fn.srecPaint(null);
  assert.equal(h.label(), 'Attach screen recording');
  h.fn.srecPaint(undefined);
  assert.equal(h.label(), 'Attach screen recording');
  h.fn.srecPaint({});
  assert.equal(h.label(), 'Attach screen recording');
});

test('6: stopping clears the second exactly once, however often the button repaints', () => {
  const h = load();
  h.fn.srecPaint(LIVE());
  const [id] = h.clock.armed.map((a) => a.id);
  h.fn.srecPaint(IDLE());
  h.fn.srecPaint(IDLE());
  h.fn.srecPaint(null);
  assert.deepEqual(h.clock.cleared, [id]);
  assert.equal(h.clock.count(), 0);
});

test('6a: a take parked by the stop stops the clock too', () => {
  const h = load();
  h.fn.srecPaint(LIVE());
  h.fn.srecPaint(IDLE(TAKE({ reviewed: false })));
  assert.equal(h.clock.count(), 0);
  assert.equal(h.label(), 'Review recording…');
});

test('6b: recording again after a stop arms a fresh second', () => {
  const h = load();
  h.fn.srecPaint(LIVE());
  h.fn.srecPaint(IDLE());
  h.fn.srecPaint(LIVE());
  assert.equal(h.clock.count(), 1);
  assert.deepEqual(h.clock.arms(), [1000, 1000]);
});

test('7: a page without the button paints nothing and arms nothing', () => {
  const h = load({ without: ['btn-screen-rec'] });
  h.fn.srecPaint(LIVE());
  assert.equal(h.clock.count(), 0);
  assert.equal(h.node.screenRecLabel.textContent, 'Attach screen recording');
});

test('7a: a button without its label still wears the recording class and arms the second', () => {
  const h = load({ without: ['screen-rec-label'] });
  h.fn.srecPaint(LIVE());
  assert.equal(h.isRecording(), true);
  assert.equal(h.clock.count(), 1);
});

test('8: stopping and reviewing are never gated, but an idle button keeps the gate answer', () => {
  const h = load();
  h.node.btnScreenRec.disabled = true; // TestGates' doing: no test open
  h.fn.srecPaint(IDLE());
  assert.equal(h.node.btnScreenRec.disabled, true);
  h.fn.srecPaint(IDLE(TAKE({ reviewed: false })));
  assert.equal(h.node.btnScreenRec.disabled, false);
  h.node.btnScreenRec.disabled = true;
  h.fn.srecPaint(LIVE());
  assert.equal(h.node.btnScreenRec.disabled, false);
});

test('8a: a repaint refreshes from the worker, and no answer leaves the button idle', async () => {
  const h = load({ reject: ['SCREENREC_STATUS'] });
  h.fn.srecPaint(LIVE());
  await h.fn.srecRefresh();
  assert.equal(h.label(), 'Attach screen recording');
  assert.equal(h.clock.count(), 0);
});

// ============================================================================
// The reason line under the button
// ============================================================================

test('9: the reason line shows what it is given and hides when there is nothing to say', () => {
  const h = load();
  h.fn.srecReason('Chrome refused the capture');
  assert.equal(h.reason(), 'Chrome refused the capture');
  assert.equal(h.reasonHidden(), false);
  h.fn.srecReason('');
  assert.equal(h.reason(), '');
  assert.equal(h.reasonHidden(), true);
  h.fn.srecReason(undefined);
  assert.equal(h.reason(), '');
  assert.equal(h.reasonHidden(), true);
});

test('9a: a page without the reason line swallows the sentence instead of throwing', () => {
  const h = load({ without: ['screen-rec-reason'] });
  h.fn.srecReason('anything at all');
  assert.equal(h.node.screenRecReason.textContent, ''); // detached: nothing was written to it
});

// ============================================================================
// What the tester is told when Chrome refuses (rows 11-14)
// ============================================================================

test('10: the shortcut on the line is the one bound to this command, not another', async () => {
  const h = load();
  assert.equal(await h.fn.srecShortcut(), SHORTCUT);
  assert.equal(h.screen.SREC_COMMAND, 'toggle-screen-recording');
});

test('10a: a command list without this command yields no shortcut', async () => {
  const h = load({ commands: () => [{ name: 'other-thing', shortcut: 'Alt+9' }] });
  assert.equal(await h.fn.srecShortcut(), '');
});

test('10b: a shortcut the tester has cleared reads as none', async () => {
  const h = load({ shortcut: '' });
  assert.equal(await h.fn.srecShortcut(), '');
});

test('13: a refusal Chrome gave no reason for just says it refused', async () => {
  const h = load();
  assert.equal(await h.fn.srecStartHint(null), 'Chrome refused the capture');
  assert.equal(await h.fn.srecStartHint(undefined), 'Chrome refused the capture');
  assert.equal(await h.fn.srecStartHint({ ok: false }), 'Chrome refused the capture');
});

test('13a: a refusal that names its own reason is passed on in those words', async () => {
  const h = load();
  const parked = 'A recording is waiting to be reviewed or attached — finish it first';
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: parked }), parked);
  assert.equal(h.order.length, 0); // no shortcut lookup on a reason that speaks for itself
});

test('11: DevTools holding the tab is named, with the shortcut and the right-click route', async () => {
  const h = load();
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach' }),
    'Another debugger holds that tab (DevTools open?). Close it, '
    + `or press ${SHORTCUT} on the tab, `
    + 'or right-click the page and choose "Record this tab for Testomat.io".');
});

test('11a: with no shortcut bound the DevTools sentence drops the press-this clause', async () => {
  const h = load({ shortcut: '' });
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach' }),
    'Another debugger holds that tab (DevTools open?). Close it, '
    + 'or right-click the page and choose "Record this tab for Testomat.io".');
});

test("11b: Chrome's own words are appended to the DevTools sentence when it gave any", async () => {
  const h = load();
  const line = await h.fn.srecStartHint({ ok: false, reason: 'cast-attach', error: 'Another debugger is attached' });
  assert.ok(line.endsWith(' Chrome says: Another debugger is attached'), line);
});

test('12: a frame another extension left behind asks for a reload, shortcut as the other way', async () => {
  const h = load();
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach-frame' }),
    'Another extension left a frame on this page and Chrome blocks the recording — '
    + `reload the page, or press ${SHORTCUT} on the tab.`);
});

test('12a: the reload sentence without a shortcut, and with what Chrome said', async () => {
  const h = load({ shortcut: '' });
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach-frame', error: 'Cannot access' }),
    'Another extension left a frame on this page and Chrome blocks the recording — '
    + 'reload the page. Chrome says: Cannot access');
});

test('14: chrome.commands failing builds both sentences without the shortcut clause', async () => {
  const h = load({ commands: () => { throw new Error('commands unavailable'); } });
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach' }),
    'Another debugger holds that tab (DevTools open?). Close it, '
    + 'or right-click the page and choose "Record this tab for Testomat.io".');
  assert.equal(await h.fn.srecStartHint({ ok: false, reason: 'cast-attach-frame' }),
    'Another extension left a frame on this page and Chrome blocks the recording — reload the page.');
  assert.equal(await h.fn.srecShortcut(), '');
});

// ============================================================================
// Where the click goes (rows 7-10, 15)
// ============================================================================

test('7 (click): a click while recording stops it and repaints, and starts no second take', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_STATUS = LIVE();
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS', 'SCREENREC_STOP', 'SCREENREC_STATUS']);
  assert.equal(h.sent('SCREENREC_START').length, 0);
});

test('9 (click): a click on a take waiting for review goes back to it, never over it', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_STATUS = IDLE(TAKE({ reviewed: false, recordId: OPEN.id }));
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS', 'SCREENREC_OPEN_REVIEW']);
  assert.equal(h.sent('SCREENREC_START').length, 0);
  assert.equal(h.sent('SCREENREC_CLAIM').length, 0);
});

test('8 (click): a click on a take whose upload failed retries that upload, not a new take', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_STATUS = IDLE(TAKE({ reviewed: true, recordId: OPEN.id }));
  await h.fn.onScreenRecClick();
  await settle(3);
  assert.equal(h.sent('SCREENREC_START').length, 0);
  assert.equal(h.sent('SCREENREC_CLAIM').length, 1);
  assert.equal(h.calls.uploads.length, 1);
});

test('10 (click): with nothing parked and no test open the click asks the worker for nothing', async () => {
  const h = load();
  h.fn.srecReason('an older refusal');
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
  assert.equal(h.reason(), 'an older refusal'); // untouched: the gate should have caught this click
});

test('10a: an open id no loaded record answers to is the same as no test open', async () => {
  const h = load({ records: [BESIDE], currentRecordId: STRANGER });
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});

test('10b: a record row with no id of its own never starts a recording', async () => {
  const h = load({ records: [{ id: '', test_title: 'half a row' }], currentRecordId: '' });
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});

test('15: a start Chrome accepts shows the plaque, clears the last refusal and repaints', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.fn.srecReason('an older refusal');
  await h.fn.onScreenRecClick();
  await settle();
  assert.deepEqual(plain(h.sent('SCREENREC_START')), [{ type: 'SCREENREC_START', recordId: OPEN.id }]);
  assert.deepEqual(h.calls.progress, ['Recording this tab…']);
  assert.equal(h.reason(), '');
  assert.equal(h.reasonHidden(), true);
  assert.deepEqual(h.types(), ['SCREENREC_STATUS', 'SCREENREC_START', 'SCREENREC_STATUS']);
});

test('15a: a start Chrome refuses leaves the reason on the line and no plaque', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_START = { ok: false, reason: 'cast-attach' };
  await h.fn.onScreenRecClick();
  await settle();
  assert.ok(h.reason().startsWith('Another debugger holds that tab'), h.reason());
  assert.equal(h.reasonHidden(), false);
  assert.deepEqual(h.calls.progress, []);
});

test('15b: the worker not answering the start at all is a refusal too', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, reject: ['SCREENREC_START'] });
  await h.fn.onScreenRecClick();
  await settle();
  assert.equal(h.reason(), 'Chrome refused the capture');
  assert.deepEqual(h.calls.progress, []);
});

test('15c: the worker not answering the status is read as idle, so the click can still start', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, reject: ['SCREENREC_STATUS'] });
  await h.fn.onScreenRecClick();
  await settle();
  assert.equal(h.sent('SCREENREC_START').length, 1);
});

test('15d: a disabled button ignores the click entirely', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.node.btnScreenRec.disabled = true;
  await h.fn.onScreenRecClick();
  assert.deepEqual(h.types(), []);
});

test('15e: a page without the button ignores the click entirely', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, without: ['btn-screen-rec'] });
  await h.fn.onScreenRecClick();
  assert.deepEqual(h.types(), []);
});

// ============================================================================
// The upload, and the test a take is bound to (rows 16-25)
// ============================================================================

test('16: a take the tester has not reviewed yet is never uploaded', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  await h.fn.srecAttach(TAKE({ reviewed: false, recordId: OPEN.id }));
  assert.deepEqual(h.types(), []);
  assert.equal(h.calls.uploads.length, 0);
});

test('16a: no take, and a take with no bytes behind it, are both nothing to upload', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  await h.fn.srecAttach(undefined);
  await h.fn.srecAttach(null);
  await h.fn.srecAttach(TAKE({ url: '' }));
  assert.deepEqual(h.types(), []);
});

test('17: one upload at a time — a second click while one runs does nothing', async () => {
  let release;
  const h = load({
    records: [OPEN],
    currentRecordId: OPEN.id,
    upload: () => new Promise((r) => { release = r; }),
  });
  const first = h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(h.calls.uploads.length, 1);
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id })); // the tester clicks Retry again
  assert.equal(h.calls.uploads.length, 1);
  assert.equal(h.sent('SCREENREC_CLAIM').length, 1);
  release({ url: 'https://app.testomat.io/attachments/take-1.webm' });
  await first;
  await settle();
});

test('18: a take recorded for a test that is not loaded here stays parked and says so', async () => {
  const h = load({ records: [OPEN, BESIDE], currentRecordId: OPEN.id });
  h.worker.SCREENREC_STATUS = IDLE(TAKE({ reviewed: true, recordId: STRANGER }));
  await h.fn.srecAttach(TAKE({ reviewed: true, recordId: STRANGER }));
  assert.equal(h.reason(), ELSEWHERE);
  assert.equal(h.reasonHidden(), false);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.sent('SCREENREC_CLAIM').length, 0);
  assert.equal(h.sent('SCREENREC_DONE').length, 0);
  // …and the repaint says the take is still there, reviewed, waiting for its own test.
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
  assert.equal(h.label(), 'Retry attach…');
});

test('18a: a take bound to the id 0 is a bound take, not an unbound one', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  await h.fn.srecAttach(TAKE({ recordId: 0 }));
  assert.equal(h.reason(), ELSEWHERE); // no record 0 is loaded — parked, not landed on OPEN
  assert.equal(h.calls.uploads.length, 0);
});

test('19: an unbound take with no test open asks the tester to open one', async () => {
  const h = load();
  await h.fn.srecAttach(TAKE({ recordId: null }));
  assert.equal(h.reason(), NO_TEST);
  assert.equal(h.reasonHidden(), false);
  assert.deepEqual(h.types(), []); // not even a repaint: nothing about the take changed
  assert.equal(h.calls.uploads.length, 0);
});

test('19a: an unbound take lands on whatever test is open', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  await h.fn.srecAttach(TAKE({ recordId: null }));
  await settle();
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [OPEN.id]);
});

test("20: a locked result refuses the attach in the lock's own words, and claims nothing", async () => {
  const h = load({
    records: [OPEN], currentRecordId: OPEN.id, runId: 'run-1', archived: true,
  });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  assert.equal(h.reason(), ARCHIVED);
  assert.deepEqual(h.types(), []);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.calls.gates, 0);
});

test('21: another panel document holding the claim makes this one give up in silence', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_CLAIM = { ok: false };
  h.node.btnScreenRec.disabled = false;
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_CLAIM']);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.reason(), '');
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.node.btnScreenRec.disabled, false); // never taken over, so never taken dead
});

test('21a: the worker not answering the claim is the same as a refusal', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, reject: ['SCREENREC_CLAIM'] });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(h.calls.uploads.length, 0);
});

test('22: the take of the open test is remembered, finished with the worker, and shown', async () => {
  const h = load({ records: [OPEN, BESIDE], currentRecordId: OPEN.id });
  const file = TAKE({ recordId: OPEN.id });
  await h.fn.srecAttach(file);
  await settle();
  assert.deepEqual(h.calls.remembered, [{
    recordId: OPEN.id,
    entry: { name: file.name, url: 'https://app.testomat.io/attachments/take-1.webm' },
  }]);
  assert.deepEqual(plain(h.sent('SCREENREC_DONE')), [{ type: 'SCREENREC_DONE', attached: true }]);
  assert.equal(h.calls.renders, 1);
  assert.deepEqual(h.calls.status, [{ id: 'test-status', msg: 'Recording attached ✓', cls: 'ok' }]);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.reason(), '');
  // The order is the promise: remembered, then released by the worker, then shown to the tester.
  const at = (s) => h.order.indexOf(s);
  assert.ok(at('attRemember') < at('send:SCREENREC_DONE'), h.order.join(' '));
  assert.ok(at('send:SCREENREC_DONE') < at('renderAttachmentList'), h.order.join(' '));
  assert.ok(at('renderAttachmentList') < at('status:test-status'), h.order.join(' '));
});

test("22a: the plaque names the file, and the bytes come from the take's own blob URL", async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  const file = TAKE({ recordId: OPEN.id });
  await h.fn.srecAttach(file);
  await settle();
  assert.deepEqual(h.calls.progress, [`Uploading ${file.name}…`]);
  assert.deepEqual(h.calls.fetches, [file.url]);
  assert.equal(h.calls.uploads[0].name, file.name);
  assert.equal(h.calls.uploads[0].blob.size, 4096);
});

test('22b: an upload answer with no url still remembers the attachment by name', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, upload: () => null });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.deepEqual(h.calls.remembered[0].entry, { name: TAKE().name, url: '' });
});

test('22c: an open id that arrives as text is still the open test', async () => {
  const h = load({ records: [{ ...OPEN, id: 6 }], currentRecordId: '6' });
  await h.fn.srecAttach(TAKE({ recordId: 6 }));
  await settle();
  assert.equal(h.calls.renders, 1);
  assert.deepEqual(h.calls.toasts, []);
});

test('23: a take of a loaded but not-open test lands there and names that test in a toast', async () => {
  const h = load({ records: [OPEN, BESIDE], currentRecordId: OPEN.id });
  await h.fn.srecAttach(TAKE({ recordId: BESIDE.id }));
  await settle();
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [BESIDE.id]);
  assert.deepEqual(h.calls.remembered.map((r) => r.recordId), [BESIDE.id]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording attached to "Login works"' }]);
  assert.equal(h.calls.renders, 0);      // that list belongs to the OPEN test
  assert.deepEqual(h.calls.status, []);  // and so does that status line
});

test('23a: a result with no title is named by its test id instead', async () => {
  const h = load({ records: [OPEN, NAMELESS], currentRecordId: OPEN.id });
  await h.fn.srecAttach(TAKE({ recordId: NAMELESS.id }));
  await settle();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording attached to "Test T-7"' }]);
});

test('24: a failed upload releases the claim BEFORE it says so, so Retry can claim again', async () => {
  const h = load({
    records: [OPEN], currentRecordId: OPEN.id, upload: () => { throw new Error('502 Bad Gateway'); },
  });
  const file = TAKE({ recordId: OPEN.id });
  await h.fn.srecAttach(file);
  await settle();
  assert.deepEqual(plain(h.sent('SCREENREC_UNCLAIM')),
    [{ type: 'SCREENREC_UNCLAIM', by: h.screen.SREC_ME }]);
  assert.deepEqual(h.calls.toasts,
    [{ msg: `${file.name}: upload failed, 502 Bad Gateway`, error: true }]);
  assert.ok(h.order.indexOf('send:SCREENREC_UNCLAIM') < h.order.indexOf('toast'), h.order.join(' '));
  assert.equal(h.sent('SCREENREC_DONE').length, 0); // the take stays parked
  assert.equal(h.calls.renders, 0);
});

test('24a: the bytes failing to come back fails the same way, claim released and all', async () => {
  const h = load({
    records: [OPEN], currentRecordId: OPEN.id, fetchThrows: new Error('blob is gone'),
  });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(h.sent('SCREENREC_UNCLAIM').length, 1);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.calls.toasts[0].error, true);
});

test('24b: the claim and the release carry the same panel token', async () => {
  const h = load({
    records: [OPEN], currentRecordId: OPEN.id, upload: () => { throw new Error('nope'); },
  });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  const claim = h.sent('SCREENREC_CLAIM')[0];
  const unclaim = h.sent('SCREENREC_UNCLAIM')[0];
  assert.equal(typeof claim.by, 'string');
  assert.ok(claim.by.length > 0);
  assert.equal(claim.by, unclaim.by);
  assert.equal(claim.by, h.screen.SREC_ME);
});

test('24c: a failed upload leaves the take attachable, and the next try goes through', async () => {
  let fail = true;
  const h = load({
    records: [OPEN],
    currentRecordId: OPEN.id,
    upload: () => {
      if (fail) { fail = false; throw new Error('502 Bad Gateway'); }
      return { url: 'https://app.testomat.io/attachments/take-1.webm' };
    },
  });
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  await h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(h.calls.uploads.length, 2);
  assert.equal(h.sent('SCREENREC_DONE').length, 1);
});

test('25: past the claim the gates are re-asked and the button repainted, either way', async () => {
  const ok = load({ records: [OPEN], currentRecordId: OPEN.id });
  await ok.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(ok.calls.gates, 1);
  assert.equal(ok.sent('SCREENREC_STATUS').length, 1);

  const bad = load({
    records: [OPEN], currentRecordId: OPEN.id, upload: () => { throw new Error('502'); },
  });
  await bad.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(bad.calls.gates, 1);
  assert.equal(bad.sent('SCREENREC_STATUS').length, 1);
});

test('25a: nothing short of the claim re-asks the gates', async () => {
  const cases = [
    load({ records: [OPEN], currentRecordId: OPEN.id }),                       // not reviewed
    load({ records: [OPEN], currentRecordId: OPEN.id }),                       // bound elsewhere
    load(),                                                                     // no test open
    load({ records: [OPEN], currentRecordId: OPEN.id, runId: 'run-1', archived: true }),
  ];
  await cases[0].fn.srecAttach(TAKE({ reviewed: false }));
  await cases[1].fn.srecAttach(TAKE({ recordId: STRANGER }));
  await cases[2].fn.srecAttach(TAKE({ recordId: null }));
  await cases[3].fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  for (const h of cases) assert.equal(h.calls.gates, 0);
});

test('25b: the button goes dead for the length of the upload', async () => {
  let release;
  const h = load({
    records: [OPEN], currentRecordId: OPEN.id, upload: () => new Promise((r) => { release = r; }),
  });
  const run = h.fn.srecAttach(TAKE({ recordId: OPEN.id }));
  await settle();
  assert.equal(h.node.btnScreenRec.disabled, true);
  release({ url: 'u' });
  await run;
  await settle();
  // Nothing parked any more, so the repaint leaves the gate holding it — TestGates.update decides.
  assert.equal(h.node.btnScreenRec.disabled, true);
  assert.equal(h.label(), 'Attach screen recording');
});

// ============================================================================
// Opening a test (rows 26-28)
// ============================================================================

test('26: opening a test tells the worker which result a page-started recording belongs to', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_TAKE = TAKE({ reviewed: false, recordId: null });
  await h.fn.srecOnTestOpen();
  await settle();
  assert.deepEqual(plain(h.sent('SCREENREC_TARGET')),
    [{ type: 'SCREENREC_TARGET', recordId: OPEN.id }]);
  assert.deepEqual(h.types(), ['SCREENREC_TARGET', 'SCREENREC_STATUS', 'SCREENREC_TAKE']);
  assert.equal(h.calls.uploads.length, 0); // unreviewed stays parked
});

test('26a: with no test open the worker is told there is no target', async () => {
  const h = load();
  await h.fn.srecOnTestOpen();
  await settle();
  assert.deepEqual(plain(h.sent('SCREENREC_TARGET')),
    [{ type: 'SCREENREC_TARGET', recordId: null }]);
});

test('26b: nothing parked at all is nothing to attach', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  await h.fn.srecOnTestOpen();
  await settle();
  assert.equal(h.sent('SCREENREC_CLAIM').length, 0);
  assert.equal(h.calls.uploads.length, 0);
});

test('27: a reviewed take bound to another test is not attached to the one just opened', async () => {
  const h = load({ records: [OPEN, BESIDE], currentRecordId: OPEN.id });
  h.worker.SCREENREC_TAKE = TAKE({ reviewed: true, recordId: BESIDE.id });
  await h.fn.srecOnTestOpen();
  await settle(3);
  assert.equal(h.sent('SCREENREC_CLAIM').length, 0);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.reason(), ''); // it is waiting for its own test, not a problem to report here
});

test('28: a reviewed take bound to the test just opened attaches on arrival', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_TAKE = TAKE({ reviewed: true, recordId: OPEN.id });
  await h.fn.srecOnTestOpen();
  await settle(4);
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [OPEN.id]);
  assert.deepEqual(h.calls.status, [{ id: 'test-status', msg: 'Recording attached ✓', cls: 'ok' }]);
});

test('28a: an unbound reviewed take attaches to whatever test was just opened', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_TAKE = TAKE({ reviewed: true, recordId: null });
  await h.fn.srecOnTestOpen();
  await settle(4);
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [OPEN.id]);
});

test('28b: the binding is compared as text, so 6 and "6" are the same test', async () => {
  const h = load({ records: [{ ...OPEN, id: 6 }], currentRecordId: 6 });
  h.worker.SCREENREC_TAKE = TAKE({ reviewed: true, recordId: '6' });
  await h.fn.srecOnTestOpen();
  await settle(4);
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [6]);
});

test('28c: the worker not answering the take is nothing to attach', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id, reject: ['SCREENREC_TAKE'] });
  await h.fn.srecOnTestOpen();
  await settle(3);
  assert.equal(h.calls.uploads.length, 0);
});

// ============================================================================
// What the worker announces (rows 29-33)
// ============================================================================

test('29: the worker announcing a reviewed file starts its upload', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.message({ type: 'SCREENREC_EVENT', event: 'file', file: TAKE({ recordId: OPEN.id }) });
  await settle(4);
  assert.deepEqual(h.calls.uploads.map((u) => u.recordId), [OPEN.id]);
  assert.equal(h.calls.hides, 0);
});

test('29a: a file event carrying no file is only a repaint', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.message({ type: 'SCREENREC_EVENT', event: 'file' });
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
  assert.equal(h.calls.hides, 0);
});

test('30: a recording that ended with nothing in it takes the plaque down', async () => {
  const h = load();
  h.message({ type: 'SCREENREC_EVENT', event: 'ended', empty: true, reason: 'user' });
  await settle();
  assert.equal(h.calls.hides, 1);
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});

test('31: a take the tester discarded in the review takes the plaque down too', async () => {
  const h = load();
  h.message({ type: 'SCREENREC_EVENT', event: 'ended', reason: 'discarded' });
  await settle();
  assert.equal(h.calls.hides, 1);
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});

test('32: an ordinary end leaves the plaque standing and only repaints', async () => {
  const h = load();
  h.worker.SCREENREC_STATUS = IDLE(TAKE({ reviewed: false }));
  h.message({ type: 'SCREENREC_EVENT', event: 'ended', reason: 'user' });
  await settle();
  assert.equal(h.calls.hides, 0);
  assert.equal(h.label(), 'Review recording…');
});

test('32a: a start announcement is a repaint, not a plaque to take down', async () => {
  const h = load();
  h.message({ type: 'SCREENREC_EVENT', event: 'started', tabId: 7 });
  await settle();
  assert.equal(h.calls.hides, 0);
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});

test("33: any other message is not this listener's business", async () => {
  const h = load();
  for (const msg of [null, undefined, {}, { type: 'SCREENREC_FILE' }, { type: 'EVIDENCE_WIPE' }]) {
    assert.equal(h.message(msg), undefined);
  }
  await settle();
  assert.deepEqual(h.types(), []);
  assert.equal(h.calls.hides, 0);
});

test('33a: the listener answers nothing, so it never holds the message channel open', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  assert.equal(h.message({ type: 'SCREENREC_EVENT', event: 'ended' }), undefined);
  assert.equal(h.message({ type: 'SCREENREC_EVENT', event: 'file', file: TAKE() }), undefined);
  await settle(4);
});

// ============================================================================
// Wiring the button up
// ============================================================================

test('34: init wires the click and asks the worker where things stand', async () => {
  const h = load({ records: [OPEN], currentRecordId: OPEN.id });
  h.worker.SCREENREC_STATUS = IDLE(TAKE({ reviewed: false }));
  h.fn.initScreenRec();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
  assert.equal(h.label(), 'Review recording…');

  h.clear();
  fire(h.node.btnScreenRec, 'click');
  await settle(3);
  assert.deepEqual(h.types(), ['SCREENREC_STATUS', 'SCREENREC_OPEN_REVIEW']);
});

test('34a: init on a page without the button still asks the worker where things stand', async () => {
  const h = load({ without: ['btn-screen-rec'] });
  h.fn.initScreenRec();
  await settle();
  assert.deepEqual(h.types(), ['SCREENREC_STATUS']);
});
