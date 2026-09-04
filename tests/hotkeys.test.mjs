#!/usr/bin/env node
// What extension/sidepanel/screens/hotkeys.js does for the tester (#158): inside an open test, Cmd or
// Ctrl with Enter, U or I marks it passed, failed or skipped through the SAME path the buttons use and
// deliberately without navigating anywhere; `N` jumps to the next still-untested visible row and the
// arrows move one row either way through the list as it is currently filtered — and none of them fires
// while the cursor is in a field or while a popup is hanging open, because an open menu leaves focus on
// its trigger button and the typing guard alone would let bare letters through underneath it.
// The same file runs capture → annotate → upload: the capture gives up after 30s rather than leaving
// the panel saying "Capturing tab…" for ever, and an upload refused because the run finished while the
// tester was drawing KEEPS the drawing in one slot under a Save button.
// Rows 1-40 are the ticket's; a lettered suffix is the companion case that drives the same path the
// other way, so a row asserting "nothing happened" cannot pass against a stub that never worked.
// Run: node --test tests/hotkeys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const NOW = 1_700_000_000_000;
const SHOT = 'data:image/jpeg;base64,SHOT';
const DRAWN = 'data:image/jpeg;base64,DRAWN';
const RUN_FINISHED = 'This run has finished — results are read-only';
const NO_ANSWER = 'the screenshot service did not answer — reload the extension on chrome://extensions and try again';

// The panel globals hotkeys.js reads, all of them real enough to be driven. They live here and not in
// the harness: every screen has its own set, and the screens beside this one land in parallel.
function load(opts = {}) {
  const o = {
    mac: false,
    view: 'test',
    currentRecordId: '55',
    records: [{ id: '55' }],
    visible: null,        // what visibleRecords() answers; by default the records themselves
    popup: null,          // null | 'true' | 'false' | 'bare' — the substatus trigger on the page
    disabled: false,      // the screenshot button's gate
    hasChrome: true,
    runtime: true,        // false — a chrome with no runtime.sendMessage at all
    site: { state: 'ok', tab: { id: 7 }, origin: 'https://x.io', error: null },
    perm: { ok: true },
    fullPage: false,
    capture: { ok: true, dataUrl: SHOT, tabId: 7 },
    send: null,           // a chrome.runtime.sendMessage of the test's own
    annotated: DRAWN,     // a value, or a function called at annotation time
    lock: '',             // a string, or (callIndex, record) => string — the lock is asked TWICE
    upload: { url: 'https://cdn.example/x.jpg' },
    fetchImpl: null,
    now: NOW,
    ...opts,
  };

  // index.html's shape, cut to the nodes this screen touches: the three status buttons and the two
  // step buttons the tooltips land on, the "?" legend, the Save slot and the screenshot button.
  const doc = makeDocument([]);
  const btn = {
    passed: el('button', { id: 'btn-passed' }),
    failed: el('button', { id: 'btn-failed' }),
    skipped: el('button', { id: 'btn-skipped' }),
    prev: el('button', { id: 'btn-prev-test' }),
    next: el('button', { id: 'btn-next-test' }),
    help: el('button', { id: 'hotkey-help' }),
    save: el('button', { id: 'btn-save-annotation', hidden: true }),
    shot: el('button', { id: 'btn-screenshot-annotate', disabled: o.disabled }),
  };
  const legend = el('div', { id: 'hotkey-legend', hidden: true });
  doc.body.append(...Object.values(btn), legend);
  if (o.popup) {
    // The substatus listbox's trigger, marked the way every popup control here marks its own.
    const trigger = el('button', { className: 'substatus-trigger' });
    if (o.popup !== 'bare') trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', o.popup === 'false' ? 'false' : 'true');
    doc.body.append(trigger);
  }

  // mini-dom elements carry no click(), and the anchor IS the download: without one the save path
  // would take its catch branch and row 30 would pass for the wrong reason.
  const anchors = [];
  const created = [];
  const makeEl = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = makeEl(tag);
    created.push(String(tag).toLowerCase());
    if (String(tag).toLowerCase() === 'a') {
      node.click = () => { anchors.push({ href: node.href, download: node.download }); };
    }
    return node;
  };

  const calls = {
    order: [],          // one ordered trace: "attRemember, THEN the repaint, THEN the line" is a row
    clickStatus: [],
    openTestView: [],
    nextTest: 0,
    tips: [],
    statusLines: [],
    toasts: [],
    progress: [],
    hideToast: 0,
    updateTestActionsState: 0,
    attRemember: [],
    renderAttachmentList: 0,
    resolveSiteTab: [],
    perms: 0,
    annotate: [],
    locks: [],
    uploads: [],
    fetches: [],
    sends: [],
  };

  const state = { view: o.view, currentRecordId: o.currentRecordId };
  const urls = { created: [], revoked: [], next: 1 };
  const URLg = {
    createObjectURL: (blob) => {
      urls.created.push(blob);
      const u = `blob:panel/${urls.next}`;
      urls.next += 1;
      return u;
    },
    revokeObjectURL: (u) => { urls.revoked.push(u); calls.order.push('revoke'); },
  };

  const fetchG = async (url) => {
    calls.fetches.push(String(url));
    calls.order.push('fetch');
    if (o.fetchImpl) return o.fetchImpl(url);
    return { blob: async () => ({ kind: 'blob', from: String(url) }) };
  };

  const chromeStub = { runtime: {} };
  if (o.runtime) {
    chromeStub.runtime.sendMessage = (msg) => {
      calls.sends.push(plain(msg));
      calls.order.push('sendMessage');
      return o.send ? o.send(msg) : Promise.resolve(o.capture);
    };
  }

  const globals = {
    state,
    // The three rows IS_MAC reads, in order; each settable on its own, which is what row 25 is about.
    navigator: {
      userAgentData: 'uaData' in opts ? o.uaData : { platform: o.mac ? 'macOS' : 'Windows' },
      platform: 'platform' in opts ? o.platform : (o.mac ? 'MacIntel' : 'Win32'),
      userAgent: 'userAgent' in opts ? o.userAgent : (o.mac ? MAC_UA : WIN_UA),
    },
    fetch: fetchG,
    URL: URLg,
    hasChrome: o.hasChrome,
    chrome: chromeStub,
    $: (id) => doc.getElementById(id),
    Tooltip: { set: (node, tip) => { calls.tips.push([node ? node.id : node, tip]); } },
    visibleRecords: () => (o.visible || o.records),
    openTestView: (id) => { calls.openTestView.push(String(id)); calls.order.push('openTestView'); },
    clickStatus: (s) => { calls.clickStatus.push(s); calls.order.push('clickStatus'); },
    nextTest: () => { calls.nextTest += 1; calls.order.push('nextTest'); },
    recordFor: (id) => o.records.find((r) => String(r.id) === String(id)) || null,
    recordWriteLock: (record) => {
      calls.locks.push(record ? String(record.id) : record);
      return typeof o.lock === 'function' ? o.lock(calls.locks.length, record) : o.lock;
    },
    setStatusLine: (id, txt, cls) => { calls.statusLines.push({ id, text: txt, cls }); calls.order.push('status'); },
    toast: (msg, tOpts) => { calls.toasts.push({ msg, ...(tOpts || {}) }); calls.order.push('toast'); },
    progressToast: (msg) => { calls.progress.push(msg); calls.order.push('progress'); },
    hideToast: () => { calls.hideToast += 1; calls.order.push('hideToast'); },
    updateTestActionsState: () => { calls.updateTestActionsState += 1; calls.order.push('updateTestActionsState'); },
    fullPageCaptureEnabled: () => o.fullPage,
    resolveSiteTab: async (args) => { calls.resolveSiteTab.push(plain(args)); calls.order.push('resolveSiteTab'); return o.site; },
    CaptureAnnotate: {
      ensureCapturePermission: async () => { calls.perms += 1; calls.order.push('perm'); return o.perm; },
      annotateImage: async (dataUrl, tabId, aOpts) => {
        calls.annotate.push({ dataUrl, tabId, hasToast: typeof (aOpts && aOpts.toast) === 'function' });
        calls.order.push('annotate');
        return typeof o.annotated === 'function' ? o.annotated() : o.annotated;
      },
    },
    TestomatAPI: {
      uploadAttachment: async (id, blob, name) => {
        calls.uploads.push({ id: String(id), blob, name });
        calls.order.push('upload');
        return typeof o.upload === 'function' ? o.upload() : o.upload;
      },
    },
    attRemember: (id, entry) => { calls.attRemember.push({ id: String(id), ...entry }); calls.order.push('attRemember'); },
    renderAttachmentList: () => { calls.renderAttachmentList += 1; calls.order.push('renderAttachmentList'); },
  };

  const clock = fakeClock();
  const h = loadScreen('hotkeys', { globals, document: doc, clock, now: o.now });

  return {
    ...h, state, calls, btn, legend, anchors, created, urls,
    // What the tester's fingers actually do; app.js hands onHotkey a plain event with a preventDefault.
    key: (props) => {
      const ev = { preventDefault: () => { ev.defaultPrevented = true; }, defaultPrevented: false, ...props };
      ev.preventDefault = () => { ev.defaultPrevented = true; };
      h.fn.onHotkey(ev);
      return ev;
    },
    saveShown: () => btn.save.hidden === false,
  };
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

// ---------- the two guards: a caret in a field, a popup under the hand (rows 1-7) ----------

test('1: a caret in any kind of field swallows the shortcut', () => {
  const h = load();
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(h.fn.typingInField({ tagName }), true, tagName);
  }
});

test('2: a button is not a field — which is exactly what let a bare letter fire under an open listbox', () => {
  const h = load();
  for (const tagName of ['BUTTON', 'DIV', 'LI', 'BODY', 'A']) {
    assert.equal(h.fn.typingInField({ tagName }), false, tagName);
  }
});

test('3: a contenteditable counts only when the property really is the boolean true', () => {
  const h = load();
  assert.equal(h.fn.typingInField({ tagName: 'DIV', isContentEditable: true }), true);
  // The string 'true' is what a naive attribute read hands back; the compare is === true on purpose.
  assert.equal(h.fn.typingInField({ tagName: 'DIV', isContentEditable: 'true' }), false);
  assert.equal(h.fn.typingInField({ tagName: 'DIV', isContentEditable: false }), false);
});

test('4: with no target on the event the focused element is asked instead', () => {
  const h = load();
  h.doc.activeElement = { tagName: 'INPUT' };
  assert.equal(h.fn.typingInField(null), true);
  assert.equal(h.fn.typingInField(undefined), true);
  // …and the target still wins when there is one: the fallback is a fallback, not an override.
  assert.equal(h.fn.typingInField({ tagName: 'BUTTON' }), false);
});

test('5: nothing focused at all is not a field', () => {
  const h = load();
  assert.equal(h.fn.typingInField(null), false);
  h.doc.activeElement = {}; // a node without a tagName is not one either
  assert.equal(h.fn.typingInField(null), false);
  // The same document DOES answer true once the caret lands, so the two rows above are not asserting
  // a read that never happens.
  h.doc.activeElement = { tagName: 'TEXTAREA' };
  assert.equal(h.fn.typingInField(null), true);
});

test('6: an expanded popup trigger anywhere on the page owns the keyboard', () => {
  assert.equal(load({ popup: 'true' }).fn.popupOpen(), true);
});

test('7: a closed trigger, and an expanded one that is not a popup trigger, leave the keyboard alone', () => {
  assert.equal(load({ popup: 'false' }).fn.popupOpen(), false);
  // aria-expanded='true' with no aria-haspopup: a disclosure, not a popup — both halves must match.
  assert.equal(load({ popup: 'bare' }).fn.popupOpen(), false);
  assert.equal(load().fn.popupOpen(), false); // nothing on the page at all
});

// ---------- ±1 through the list as it is filtered (rows 20-23) ----------

test('20: the last visible row is the end of the road — no wrap onto the first', () => {
  const h = load({ records: rows(3), currentRecordId: '3' });
  h.fn.navigateTest(1);
  assert.deepEqual(h.calls.openTestView, []);
  // The same call one row up moves, so the row above is not asserting a stub that never opens a test.
  h.state.currentRecordId = '2';
  h.fn.navigateTest(1);
  assert.deepEqual(h.calls.openTestView, ['3']);
});

test('21: the first visible row is the other end — no wrap onto the last', () => {
  const h = load({ records: rows(3), currentRecordId: '1' });
  h.fn.navigateTest(-1);
  assert.deepEqual(h.calls.openTestView, []);
  h.state.currentRecordId = '2';
  h.fn.navigateTest(-1);
  assert.deepEqual(h.calls.openTestView, ['1']);
});

test('22: a row the filter has hidden is not a place to step from', () => {
  // The open test is real but filtered out of the visible sequence: stepping has no anchor.
  const h = load({ records: rows(3), visible: [{ id: '1' }, { id: '3' }], currentRecordId: '2' });
  h.fn.navigateTest(1);
  h.fn.navigateTest(-1);
  assert.deepEqual(h.calls.openTestView, []);
  // Widening the filter back over that row restores the step — same drive, one thing changed.
  const wide = load({ records: rows(3), currentRecordId: '2' });
  wide.fn.navigateTest(1);
  assert.deepEqual(wide.calls.openTestView, ['3']);
});

test('23: numeric record ids and a string currentRecordId are the same row', () => {
  const h = load({ records: [{ id: 1 }, { id: 2 }, { id: 3 }], currentRecordId: '2' });
  h.fn.navigateTest(1);
  h.fn.navigateTest(-1);
  assert.deepEqual(h.calls.openTestView, ['3', '1']);
});

// ---------- the dispatch matrix (rows 8-19) ----------

test('8: a bare N under an open substatus listbox marks nothing', () => {
  const h = load({ popup: 'true' });
  const ev = h.key({ key: 'n' });
  assert.equal(h.calls.nextTest, 0);
  assert.equal(ev.defaultPrevented, false); // the popup gets the key, untouched
  // The identical keypress with the listbox closed jumps — the guard is what stopped it, not the stub.
  const open = load({ popup: 'false' });
  open.key({ key: 'n' });
  assert.equal(open.calls.nextTest, 1);
});

test('8b: an open popup owns the modifiers too, not only the bare letters', () => {
  const h = load({ popup: 'true' });
  h.key({ metaKey: true, code: 'Enter' });
  h.key({ key: 'ArrowDown' });
  assert.deepEqual(h.calls.clickStatus, []);
  assert.deepEqual(h.calls.openTestView, []);
});

test('9: a bare N jumps to the next untested row once, and the key does not reach the page', () => {
  const h = load();
  const ev = h.key({ key: 'n' });
  assert.equal(h.calls.nextTest, 1);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.calls.openTestView, []); // N is not a step through the list
});

test('10: a non-Latin layout still jumps — the physical key is read first', () => {
  const h = load();
  h.key({ code: 'KeyN', key: 'т' });
  assert.equal(h.calls.nextTest, 1);
});

test('11: Shift+N is not the jump', () => {
  // The ticket's own input for this row was { key: 'N', shiftKey: true }, which the `key === 'n'`
  // compare rejects on its own — `code` is what makes the shift guard the reason nothing fires.
  const h = load();
  const ev = h.key({ code: 'KeyN', key: 'N', shiftKey: true });
  assert.equal(h.calls.nextTest, 0);
  assert.equal(ev.defaultPrevented, false);
  // The same physical key without the shift jumps.
  const plainN = load();
  plainN.key({ code: 'KeyN', key: 'N' });
  assert.equal(plainN.calls.nextTest, 1);
});

test('12: the hotkeys live in the open test only, never on the run list', () => {
  for (const view of ['run', 'runs', 'tclist', 'settings']) {
    const h = load({ view });
    h.key({ key: 'n' });
    h.key({ metaKey: true, code: 'Enter' });
    h.key({ key: 'ArrowDown' });
    assert.equal(h.calls.nextTest, 0, view);
    assert.deepEqual(h.calls.clickStatus, [], view);
    assert.deepEqual(h.calls.openTestView, [], view);
  }
  const open = load({ view: 'test', records: rows(2), currentRecordId: '1' });
  open.key({ key: 'n' });
  open.key({ metaKey: true, code: 'Enter' });
  open.key({ key: 'ArrowDown' });
  assert.equal(open.calls.nextTest, 1);
  assert.deepEqual(open.calls.clickStatus, ['passed']);
  assert.deepEqual(open.calls.openTestView, ['2']);
});

test('13: a comment being typed keeps its letters', () => {
  const h = load();
  const ev = h.key({ key: 'n', target: { tagName: 'TEXTAREA' } });
  assert.equal(h.calls.nextTest, 0);
  assert.equal(ev.defaultPrevented, false);
  // The same key from a button — where the focus sits after a click — does fire.
  const fromButton = load();
  fromButton.key({ key: 'n', target: { tagName: 'BUTTON' } });
  assert.equal(fromButton.calls.nextTest, 1);
});

test('14: Cmd+Enter marks it passed through the buttons own path, and stays put', () => {
  const h = load();
  const ev = h.key({ metaKey: true, code: 'Enter' });
  assert.deepEqual(h.calls.clickStatus, ['passed']);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.calls.openTestView, []); // the deliberate divergence from the web runner
  assert.equal(h.calls.nextTest, 0);
});

test('15: Ctrl+Enter is the same key, numpad Enter included', () => {
  const ctrl = load();
  ctrl.key({ ctrlKey: true, key: 'Enter', code: 'NumpadEnter' });
  assert.deepEqual(ctrl.calls.clickStatus, ['passed']);
  // …and the mac build takes Ctrl too: the handler accepts both everywhere, only the LABEL differs.
  const onMac = load({ mac: true });
  onMac.key({ ctrlKey: true, code: 'Enter' });
  assert.deepEqual(onMac.calls.clickStatus, ['passed']);
});

test('16: U is failed and I is skipped, under either modifier', () => {
  const meta = load();
  meta.key({ metaKey: true, code: 'KeyU' });
  meta.key({ metaKey: true, code: 'KeyI' });
  assert.deepEqual(meta.calls.clickStatus, ['failed', 'skipped']);

  const ctrl = load();
  ctrl.key({ ctrlKey: true, code: 'KeyU' });
  ctrl.key({ ctrlKey: true, code: 'KeyI' });
  assert.deepEqual(ctrl.calls.clickStatus, ['failed', 'skipped']);
});

test('17: Cmd+Z is not ours — undo still reaches the browser', () => {
  const h = load();
  const undo = h.key({ metaKey: true, code: 'KeyZ' });
  assert.deepEqual(h.calls.clickStatus, []);
  assert.equal(undo.defaultPrevented, false); // the whole point: the page keeps its own shortcut
  // A key that IS ours, driven the same way, does get taken.
  const ours = h.key({ metaKey: true, code: 'KeyU' });
  assert.equal(ours.defaultPrevented, true);
  assert.deepEqual(h.calls.clickStatus, ['failed']);
});

test('18: the arrows walk the list, down and right forward, up and left back', () => {
  const h = load({ records: rows(3), currentRecordId: '2' });
  for (const key of ['ArrowDown', 'ArrowRight']) {
    const ev = h.key({ key });
    assert.equal(ev.defaultPrevented, true, key);
  }
  for (const key of ['ArrowUp', 'ArrowLeft']) h.key({ key });
  assert.deepEqual(h.calls.openTestView, ['3', '3', '1', '1']);
  assert.deepEqual(h.calls.clickStatus, []);
});

test('19: Alt or Shift with an arrow is somebody elses shortcut', () => {
  for (const mod of ['altKey', 'shiftKey']) {
    const h = load({ records: rows(3), currentRecordId: '2' });
    const ev = h.key({ key: 'ArrowDown', [mod]: true });
    assert.deepEqual(h.calls.openTestView, [], mod);
    assert.equal(ev.defaultPrevented, false, mod);
  }
  const bare = load({ records: rows(3), currentRecordId: '2' });
  bare.key({ key: 'ArrowDown' });
  assert.deepEqual(bare.calls.openTestView, ['3']);
});

// ---------- the labels and the "?" legend (rows 24-28) ----------

test('24: the label is the platforms own — the screen is loaded once per platform to see it', () => {
  const mac = load({ mac: true });
  assert.equal(mac.fn.hotkeyStatusLabel('passed'), '⌘⏎');
  assert.equal(mac.fn.hotkeyStatusLabel('failed'), '⌘U');
  assert.equal(mac.fn.hotkeyStatusLabel('skipped'), '⌘I');

  const win = load({ mac: false });
  assert.equal(win.fn.hotkeyStatusLabel('passed'), 'Ctrl+⏎');
  assert.equal(win.fn.hotkeyStatusLabel('failed'), 'Ctrl+U');
  assert.equal(win.fn.hotkeyStatusLabel('skipped'), 'Ctrl+I');
});

test('25: the platform is read at load, from userAgentData first and the userAgent last', () => {
  const isMac = (h) => h.fn.hotkeyStatusLabel('passed').startsWith('⌘');
  // The hinted platform wins over both older rows, in either direction.
  assert.equal(isMac(load({ uaData: { platform: 'macOS' }, platform: 'Win32', userAgent: WIN_UA })), true);
  assert.equal(isMac(load({ uaData: { platform: 'Windows' }, platform: 'MacIntel', userAgent: MAC_UA })), false);
  // No hint: navigator.platform decides.
  assert.equal(isMac(load({ uaData: undefined, platform: 'MacIntel', userAgent: WIN_UA })), true);
  assert.equal(isMac(load({ uaData: undefined, platform: 'Win32', userAgent: MAC_UA })), false);
  // Neither: the user agent string is the last word, and a browser that reports nothing is not a Mac.
  assert.equal(isMac(load({ uaData: undefined, platform: '', userAgent: MAC_UA })), true);
  assert.equal(isMac(load({ uaData: undefined, platform: '', userAgent: WIN_UA })), false);
  assert.equal(isMac(load({ uaData: undefined, platform: '', userAgent: '' })), false);
});

test('26: the legend writes down all six, in order, and N is written down nowhere else', () => {
  const h = load({ mac: true });
  h.fn.initHotkeyHints();
  const printed = h.legend.querySelectorAll('.hk-row').map((r) => [
    r.querySelector('.hk-name').textContent,
    r.querySelector('kbd.hk-keys').textContent,
  ]);
  assert.deepEqual(printed, [
    ['Passed', '⌘⏎'],
    ['Failed', '⌘U'],
    ['Skipped', '⌘I'],
    ['Next untested test', 'N'],
    ['Previous test', '↑ / ←'],
    ['Next test in list', '↓ / →'],
  ]);
  // The buttons carry their own label; N has no button, which is why the legend above is its only home.
  assert.deepEqual(h.calls.tips, [
    ['btn-passed', 'Passed (⌘⏎)'],
    ['btn-failed', 'Failed (⌘U)'],
    ['btn-skipped', 'Skipped (⌘I)'],
    ['btn-prev-test', 'Previous test (↑ / ←)'],
    ['btn-next-test', 'Next test (↓ / →)'],
  ]);
});

test('27: building the hints twice leaves six rows, not twelve', () => {
  const h = load();
  h.fn.initHotkeyHints();
  h.fn.initHotkeyHints();
  assert.equal(h.legend.querySelectorAll('.hk-row').length, 6);
  assert.equal(h.legend.querySelectorAll('kbd.hk-keys').length, 6);
});

test('28: the "?" opens the legend and says so to a screen reader, and closes it again', () => {
  const h = load();
  h.fn.toggleHotkeyLegend();
  assert.equal(h.legend.hidden, false);
  assert.equal(h.btn.help.getAttribute('aria-expanded'), 'true');
  h.fn.toggleHotkeyLegend();
  assert.equal(h.legend.hidden, true);
  assert.equal(h.btn.help.getAttribute('aria-expanded'), 'false');
});

test('28b: the "?" button is wired to that toggle, and a page without a legend does not throw', () => {
  const h = load();
  h.fn.initHotkeyHints();
  fire(h.btn.help, 'click');
  assert.equal(h.legend.hidden, false);
  assert.equal(h.btn.help.getAttribute('aria-expanded'), 'true');

  const bare = load();
  bare.legend.remove();
  bare.fn.initHotkeyHints();       // no legend to fill
  bare.fn.toggleHotkeyLegend();    // and nothing to toggle
  assert.equal(bare.btn.help.getAttribute('aria-expanded'), null);
});

// ---------- the slot a refused upload must not empty (rows 29-32) ----------

test('29: the Save button belongs to the record the drawing was made on, and waits there', () => {
  const h = load({ currentRecordId: '55' });
  assert.equal(h.saveShown(), false); // nothing drawn yet
  h.fn.keepRefusedAnnotation(DRAWN, 55);
  assert.equal(h.saveShown(), true);
  // The tester walks off to the next test: the button goes, the drawing does not.
  h.state.currentRecordId = '56';
  h.fn.renderPendingAnnotation();
  assert.equal(h.saveShown(), false);
  h.state.currentRecordId = '55';
  h.fn.renderPendingAnnotation();
  assert.equal(h.saveShown(), true);
});

test('29b: one slot only — a newer shot takes it and the older one is gone', async () => {
  const h = load({ currentRecordId: '55' });
  h.fn.keepRefusedAnnotation('data:image/jpeg;base64,OLD', 55);
  h.fn.keepRefusedAnnotation('data:image/jpeg;base64,NEW', 56);
  h.fn.renderPendingAnnotation();
  assert.equal(h.saveShown(), false); // record 55's drawing no longer exists
  h.state.currentRecordId = '56';
  h.fn.renderPendingAnnotation();
  assert.equal(h.saveShown(), true);
  await h.fn.savePendingAnnotation();
  assert.deepEqual(h.calls.fetches, ['data:image/jpeg;base64,NEW']);
});

test('29c: a panel with no Save button in it is not a crash', () => {
  const h = load();
  h.btn.save.remove();
  h.fn.keepRefusedAnnotation(DRAWN, 55); // renders through the missing button
  h.fn.renderPendingAnnotation();
});

test('30: saving writes the file, empties the slot and holds the object URL back for a minute', async () => {
  const h = load({ currentRecordId: '55' });
  const name = `panel-annotated-55-${NOW}.jpg`;
  h.fn.keepRefusedAnnotation(DRAWN, 55);
  await h.fn.savePendingAnnotation();

  assert.deepEqual(h.calls.fetches, [DRAWN]);
  assert.equal(h.urls.created.length, 1);
  assert.deepEqual(h.anchors, [{ href: 'blob:panel/1', download: name }]);
  assert.deepEqual(h.calls.statusLines, [{ id: 'test-status', text: `Annotated screenshot saved as ${name} ✓`, cls: 'ok' }]);
  assert.equal(h.saveShown(), false); // it is on disk now — the work is no longer at risk

  // Revoking while the download is starting kills it, so the release is deferred, not skipped.
  assert.deepEqual(h.urls.revoked, []);
  assert.deepEqual(h.clock.arms(), [60000]);
  await h.clock.tick();
  assert.deepEqual(h.urls.revoked, ['blob:panel/1']);

  await h.fn.savePendingAnnotation(); // the slot really is empty: no second download
  assert.equal(h.anchors.length, 1);
});

test('31: a save that fails keeps the drawing — a failed save must not be a second loss', async () => {
  let broken = true;
  const h = load({
    currentRecordId: '55',
    fetchImpl: async (url) => {
      if (broken) throw new Error('network down');
      return { blob: async () => ({ kind: 'blob', from: String(url) }) };
    },
  });
  h.fn.keepRefusedAnnotation(DRAWN, 55);
  await h.fn.savePendingAnnotation();
  assert.deepEqual(h.calls.statusLines, [{ id: 'test-status', text: "Couldn't save the annotated screenshot: network down", cls: 'error' }]);
  assert.deepEqual(h.anchors, []);
  assert.equal(h.saveShown(), true);

  // …and what was kept is a live shot, not an empty slot: the retry saves it.
  broken = false;
  await h.fn.savePendingAnnotation();
  assert.equal(h.anchors.length, 1);
  assert.equal(h.anchors[0].download, `panel-annotated-55-${NOW}.jpg`);
  assert.equal(h.saveShown(), false);
});

test('32: pressing Save with nothing drawn does nothing at all', async () => {
  const h = load();
  await h.fn.savePendingAnnotation();
  assert.deepEqual(h.calls.fetches, []);
  assert.deepEqual(h.calls.statusLines, []);
  assert.deepEqual(h.anchors, []);
  assert.deepEqual(h.clock.arms(), []);
  // The same press once something is in the slot does all four.
  h.fn.keepRefusedAnnotation(DRAWN, 55);
  await h.fn.savePendingAnnotation();
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.statusLines.length, 1);
  assert.equal(h.anchors.length, 1);
  assert.deepEqual(h.clock.arms(), [60000]);
});

// ---------- the capture, and the worker that may not be there (rows 33-34) ----------

test('33: a worker torn down mid-job is given thirty seconds, not for ever', async () => {
  const h = load({ send: () => new Promise(() => {}) }); // the worker never answers
  const asked = h.fn.captureTab(false);
  assert.deepEqual(h.calls.sends, [{ type: 'captureTab', fullPage: false }]);
  assert.deepEqual(h.clock.arms(), [30000]);
  await h.clock.tick();
  assert.deepEqual(plain(await asked), { ok: false, error: NO_ANSWER });
});

test('34: a worker that rejects hands its own sentence back rather than throwing', async () => {
  const gone = load({ send: () => Promise.reject(new Error('Receiving end does not exist')) });
  assert.deepEqual(plain(await gone.fn.captureTab(true)), { ok: false, error: 'Receiving end does not exist' });
  assert.deepEqual(gone.calls.sends, [{ type: 'captureTab', fullPage: true }]);
  // A rejection that is not an Error at all still reads as a sentence.
  const odd = load({ send: () => Promise.reject('boom') });
  assert.deepEqual(plain(await odd.fn.captureTab(false)), { ok: false, error: 'boom' });
});

test('34b: a worker that answers wins the race, deadline or no deadline', async () => {
  const h = load({ capture: { ok: true, dataUrl: SHOT, tabId: 7 } });
  assert.deepEqual(plain(await h.fn.captureTab(true)), { ok: true, dataUrl: SHOT, tabId: 7 });
});

// ---------- capture, annotate, upload: the gates in order (rows 35-40) ----------

test('35: a disabled screenshot button is the end of it — nothing runs, not even the finally', async () => {
  const off = load({ disabled: true });
  await off.fn.attachScreenshotAnnotated();
  assert.deepEqual(off.calls.order, []);
  assert.deepEqual(off.calls.locks, []);
  // The same press with the button live runs the whole flow.
  const on = load();
  await on.fn.attachScreenshotAnnotated();
  assert.deepEqual(on.calls.uploads.map((u) => u.id), ['55']);
});

test('36: a locked record is not captured — the run is over before the shutter opens', async () => {
  const locked = load({ lock: RUN_FINISHED });
  await locked.fn.attachScreenshotAnnotated();
  assert.deepEqual(locked.calls.locks, ['55']);
  assert.deepEqual(locked.calls.sends, []);
  assert.deepEqual(locked.calls.resolveSiteTab, []);
  assert.equal(locked.calls.updateTestActionsState, 0); // it returned ahead of the try
  assert.equal(locked.btn.shot.disabled, false);
  // The identical press on an open record captures and uploads.
  const open = load();
  await open.fn.attachScreenshotAnnotated();
  assert.deepEqual(open.calls.sends, [{ type: 'captureTab', fullPage: false }]);
  assert.equal(open.calls.uploads.length, 1);
});

test('36b: with no record open there is nothing to attach to', async () => {
  const h = load({ records: [], currentRecordId: '55' });
  await h.fn.attachScreenshotAnnotated();
  assert.deepEqual(h.calls.locks, [null]);
  assert.deepEqual(h.calls.sends, []);
  assert.equal(h.calls.updateTestActionsState, 0);
});

test('36c: outside the extension context the panel says so instead of shooting', async () => {
  for (const opts of [{ hasChrome: false }, { runtime: false }]) {
    const h = load(opts);
    await h.fn.attachScreenshotAnnotated();
    assert.deepEqual(h.calls.toasts, [{ msg: 'Screenshots need the extension context' }], JSON.stringify(opts));
    assert.deepEqual(h.calls.sends, [], JSON.stringify(opts));
    assert.equal(h.calls.updateTestActionsState, 0, JSON.stringify(opts));
  }
});

test('36d: a page Chrome keeps us off, and a refused permission, both stop before the shutter', async () => {
  const detour = load({ site: { state: 'system-page', tab: null, origin: null, error: 'That page cannot be captured' } });
  await detour.fn.attachScreenshotAnnotated();
  assert.deepEqual(detour.calls.toasts, [{ msg: 'That page cannot be captured' }]);
  assert.equal(detour.calls.perms, 0);
  assert.deepEqual(detour.calls.sends, []);
  assert.equal(detour.calls.updateTestActionsState, 1); // inside the try now: the finally runs

  const refused = load({ perm: { ok: false, error: 'Allow the site in Settings first' } });
  await refused.fn.attachScreenshotAnnotated();
  assert.deepEqual(refused.calls.toasts, [{ msg: 'Allow the site in Settings first' }]);
  assert.deepEqual(refused.calls.sends, []);
  assert.deepEqual(refused.calls.resolveSiteTab, [{ verb: 'captured' }]);
  assert.equal(refused.calls.updateTestActionsState, 1);
});

test('36e: a capture that fails is named, and a worker asking for a grant keeps its own wording', async () => {
  const failed = load({ capture: { ok: false, error: 'the tab went away' } });
  await failed.fn.attachScreenshotAnnotated();
  assert.deepEqual(failed.calls.toasts, [{ msg: 'Capture failed: the tab went away', error: true }]);
  assert.deepEqual(failed.calls.annotate, []);

  const silent = load({ capture: { ok: false } });
  await silent.fn.attachScreenshotAnnotated();
  assert.deepEqual(silent.calls.toasts, [{ msg: 'Capture failed: unknown', error: true }]);

  const grant = load({ capture: { ok: false, needsGrant: true, error: 'Click the extension icon on this page to allow one capture.' } });
  await grant.fn.attachScreenshotAnnotated();
  assert.deepEqual(grant.calls.toasts, [{ msg: 'Click the extension icon on this page to allow one capture.', error: true }]);
});

test('33b: a dead worker under the whole flow lands as a named failure, not a stuck plaque', async () => {
  const h = load({ send: () => new Promise(() => {}) });
  const flow = h.fn.attachScreenshotAnnotated();
  await settle();
  assert.deepEqual(h.calls.progress, ['Capturing tab…']);
  assert.deepEqual(h.clock.arms(), [30000]);
  await h.clock.tick();
  await flow;
  assert.deepEqual(h.calls.toasts, [{ msg: `Capture failed: ${NO_ANSWER}`, error: true }]);
  assert.deepEqual(h.calls.annotate, []);
  assert.equal(h.calls.updateTestActionsState, 1);
});

test('37: Discard throws the shot away and changes nothing behind it', async () => {
  const discarded = load({ annotated: null });
  await discarded.fn.attachScreenshotAnnotated();
  assert.equal(discarded.calls.hideToast, 1);
  assert.deepEqual(discarded.calls.uploads, []);
  assert.deepEqual(discarded.calls.attRemember, []);
  assert.deepEqual(discarded.calls.statusLines, []);
  assert.equal(discarded.calls.renderAttachmentList, 0);
  assert.equal(discarded.saveShown(), false); // discarded means discarded — nothing kept either
  assert.equal(discarded.calls.updateTestActionsState, 1);
  // Apply, driven identically, uploads.
  const applied = load();
  await applied.fn.attachScreenshotAnnotated();
  assert.equal(applied.calls.hideToast, 0);
  assert.equal(applied.calls.uploads.length, 1);
});

test('38: the run finishing while the tester draws refuses the upload and keeps the drawing', async () => {
  // The lock is asked twice: clear when the flow starts, engaged by the time the drawing comes back.
  const h = load({ lock: (n) => (n === 1 ? '' : RUN_FINISHED) });
  await h.fn.attachScreenshotAnnotated();
  assert.deepEqual(h.calls.locks, ['55', '55']);
  assert.deepEqual(h.calls.uploads, []);
  assert.deepEqual(h.calls.fetches, []); // it never even read the image back
  assert.deepEqual(h.calls.attRemember, []);
  assert.deepEqual(h.calls.statusLines, [{ id: 'test-status', text: RUN_FINISHED, cls: 'error' }]);
  assert.equal(h.saveShown(), true);

  // What it kept is the ANNOTATED image, and the Save button really takes it off the panel.
  await h.fn.savePendingAnnotation();
  assert.deepEqual(h.calls.fetches, [DRAWN]);
  assert.deepEqual(h.anchors, [{ href: 'blob:panel/1', download: `panel-annotated-55-${NOW}.jpg` }]);
  assert.equal(h.saveShown(), false);
});

test('39: a full-page request the page refused says so instead of the "Annotating…" plaque', async () => {
  const cropped = load({ fullPage: true, capture: { ok: true, dataUrl: SHOT, tabId: 7, viewportOnly: true } });
  await cropped.fn.attachScreenshotAnnotated();
  assert.deepEqual(cropped.calls.toasts, [{ msg: 'Full page needs the debugger, which this page blocks — captured the viewport.', ms: 8000 }]);
  assert.deepEqual(cropped.calls.progress, ['Capturing tab…', 'Uploading screenshot…']); // one plaque at a time
  assert.equal(cropped.calls.uploads.length, 1); // the warning is a warning, not a refusal

  const clipped = load({ fullPage: true, capture: { ok: true, dataUrl: SHOT, tabId: 7, heightClipped: true } });
  await clipped.fn.attachScreenshotAnnotated();
  assert.deepEqual(clipped.calls.toasts, [{ msg: 'This page is taller than a screenshot can be — the shot stops at the full-page limit.', ms: 8000 }]);
  assert.ok(!clipped.calls.progress.includes('Annotating…'));

  // A full page that came back whole says "Annotating…" and nothing else.
  const whole = load({ fullPage: true });
  await whole.fn.attachScreenshotAnnotated();
  assert.deepEqual(whole.calls.toasts, []);
  assert.deepEqual(whole.calls.progress, ['Capturing tab…', 'Annotating…', 'Uploading screenshot…']);

  // …and a viewport shot nobody asked to be full-page is not a disappointment worth a toast.
  const asked = load({ fullPage: false, capture: { ok: true, dataUrl: SHOT, tabId: 7, viewportOnly: true } });
  await asked.fn.attachScreenshotAnnotated();
  assert.deepEqual(asked.calls.toasts, []);
  assert.deepEqual(asked.calls.progress, ['Capturing tab…', 'Annotating…', 'Uploading screenshot…']);
});

test('40: a shot that lands is remembered, repainted and confirmed, in that order', async () => {
  const h = load();
  await h.fn.attachScreenshotAnnotated();
  const name = `panel-annotated-55-${NOW}.jpg`;

  assert.deepEqual(h.calls.annotate, [{ dataUrl: SHOT, tabId: 7, hasToast: true }]);
  assert.deepEqual(h.calls.fetches, [DRAWN]); // the merged drawing is what is uploaded, not the raw shot
  assert.deepEqual(h.calls.uploads, [{ id: '55', blob: { kind: 'blob', from: DRAWN }, name }]);
  assert.deepEqual(h.calls.attRemember, [{ id: '55', name, url: 'https://cdn.example/x.jpg' }]);
  assert.equal(h.calls.renderAttachmentList, 1);
  assert.deepEqual(h.calls.statusLines, [{ id: 'test-status', text: 'Screenshot attached ✓', cls: 'ok' }]);
  // The whole gate order, once: the server list is only re-read on reopen, so the remember has to
  // come before the repaint or the tester looks at a screen the shot is missing from.
  assert.deepEqual(h.calls.order, [
    'resolveSiteTab', 'perm', 'progress', 'sendMessage', 'progress', 'annotate',
    'fetch', 'progress', 'upload', 'attRemember', 'renderAttachmentList', 'status',
    'updateTestActionsState',
  ]);
});

test('40b: an upload the server refuses is named, and the gate state is restored either way', async () => {
  const h = load({ upload: () => { throw new Error('413 too large'); } });
  await h.fn.attachScreenshotAnnotated();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Upload failed: 413 too large', error: true }]);
  assert.deepEqual(h.calls.attRemember, []);
  assert.equal(h.calls.renderAttachmentList, 0);
  assert.equal(h.calls.updateTestActionsState, 1); // the finally runs whatever happened above it
  // A response with no url at all is still remembered, under an empty one.
  const bare = load({ upload: null });
  await bare.fn.attachScreenshotAnnotated();
  assert.deepEqual(bare.calls.attRemember, [{ id: '55', name: `panel-annotated-55-${NOW}.jpg`, url: '' }]);
});

test('40c: the button is held down for the whole capture-to-upload flow, not just the click', async () => {
  let duringAnnotation = null;
  const h = load({ annotated: () => { duringAnnotation = h.btn.shot.disabled; return DRAWN; } });
  assert.equal(h.btn.shot.disabled, false);
  await h.fn.attachScreenshotAnnotated();
  assert.equal(duringAnnotation, true); // a second click cannot start a second capture
  assert.equal(h.btn.shot.disabled, true); // and it is updateTestActionsState that lets it go
  assert.equal(h.calls.updateTestActionsState, 1);
});
