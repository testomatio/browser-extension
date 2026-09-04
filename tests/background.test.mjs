#!/usr/bin/env node
// extension/background.js: which line goes first when a click and the page it opened arrive out of
// order, which twins a double-click leaves behind, and when a line is too late to move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, mkSt, plain, settle, DEFAULT_TAB } from './helpers/worker-harness.mjs';
import { makeDocument, el } from './helpers/mini-dom.mjs';

const T0 = 1_700_000_000_000; // the harness clock at load(); every `at` below is written against it
const CLICK = 'Click the "Pay now" button';
const PAGE = 'The "Cart" page opens';
const FOREIGN = 'Cannot access a chrome-extension:// URL of different extension';

const step = (text, over = {}) => ({ kind: 'step', text, at: T0, ...over });
const expected = (text, over = {}) => ({ kind: 'expected', text, at: T0, ...over });
const texts = (st) => (st.entries || []).map((e) => e.text);
const kinds = (st) => (st.entries || []).map((e) => e.kind);
const sender = { tab: { id: 7 } };

// =========================== the append rule (srPush) ========================

test('W1: the first entry lands at index 0, stamped with the moment it arrived', () => {
  const h = load();
  const st = mkSt();
  h.setNow(T0 + 5000);
  const e = { kind: 'step', text: CLICK };
  assert.equal(h.api.srPush(st, e, 50), 0);
  assert.equal(e.at, T0 + 5000);
  assert.deepEqual(plain(st.entries), [{ kind: 'step', text: CLICK, at: T0 + 5000 }]);
});

test('W2: a paused recording pushes nothing and answers -1, either way it was paused', () => {
  for (const flag of ['paused', 'manualPause']) {
    const h = load();
    const st = mkSt({ [flag]: true });
    assert.equal(h.api.srPush(st, { kind: 'step', text: CLICK }, 50), -1);
    assert.deepEqual(st.entries, []);
  }
  const h = load(); // the control: the same push, on a recording that is running
  const st = mkSt();
  assert.equal(h.api.srPush(st, { kind: 'step', text: CLICK }, 50), 0);
  assert.deepEqual(texts(st), [CLICK]);
});

test('W3: at the cap the action is dropped and the recording pauses — it never truncates', () => {
  const h = load();
  const st = mkSt({ entries: [step('one'), step('two'), step('three')] });
  assert.equal(h.api.srPush(st, { kind: 'step', text: CLICK }, 3), -1);
  assert.deepEqual(texts(st), ['one', 'two', 'three']); // the three it already had, untouched
  assert.equal(st.paused, true);
});

test('W4: the entry that REACHES the cap is kept, and pauses on its way in', () => {
  const h = load();
  const st = mkSt({ entries: [step('one'), step('two')] });
  assert.equal(h.api.srPush(st, { kind: 'step', text: CLICK }, 3), 2);
  assert.deepEqual(texts(st), ['one', 'two', CLICK]);
  assert.equal(st.paused, true); // so the tester is offered "Continue" rather than losing the click
});

test('W5: the cap is 50 unless storage.session names a positive number', async () => {
  const h = load();
  assert.equal(await h.api.srCap(), 50);
  h.session.stepRecCap = 3;
  assert.equal(await h.api.srCap(), 3);
  for (const bad of ['abc', 0, -1]) {
    h.session.stepRecCap = bad;
    assert.equal(await h.api.srCap(), 50);
  }
});

// ===================== the 900 ms navigation lead (srPlace) ==================

// The recorder holds an action ~400ms to see what it caused, so the navigation that action
// triggered can reach the worker FIRST. A step landing right behind an auto nav line goes in front.
const navThenStep = (h, { gap = 200, prev = expected(PAGE), sent = 0, kind = 'step' } = {}) => {
  const st = mkSt({ sent, lastNavIdx: 0 });
  h.setNow(T0);
  h.api.srPush(st, prev, 50);
  h.setNow(T0 + gap);
  const idx = h.api.srPlace(st, h.api.srEntry(kind, CLICK, {}), 50);
  return { st, idx };
};

test('W6: a step landing 200 ms behind an auto navigation goes in front of it', () => {
  const h = load();
  const { st, idx } = navThenStep(h);
  assert.equal(idx, 0);
  assert.deepEqual(texts(st), [CLICK, PAGE]);
  assert.equal(st.lastNavIdx, 1); // the nav line kept its identity through the swap
});

test('W7: a step landing 1 500 ms behind it is a new action, and stays behind it', () => {
  const h = load();
  const { st, idx } = navThenStep(h, { gap: 1500 });
  assert.equal(idx, 1);
  assert.deepEqual(texts(st), [PAGE, CLICK]);
  assert.equal(st.lastNavIdx, 0);
});

test('W8: the tester\'s own sentence never moves, however fast the step follows it', () => {
  const h = load();
  const { st, idx } = navThenStep(h, { prev: expected('The receipt is shown', { manual: true }) });
  assert.equal(idx, 1);
  assert.deepEqual(texts(st), ['The receipt is shown', CLICK]);
});

test('W9: a line already handed to the editor is never unwritten', () => {
  const h = load();
  const { st, idx } = navThenStep(h, { sent: 1 });
  assert.equal(idx, 1);
  assert.deepEqual(texts(st), [PAGE, CLICK]);
});

test('W10: an expectation never overtakes anything; the same slot, a step, does', () => {
  const h = load();
  const { st, idx } = navThenStep(h, { kind: 'expected' });
  assert.equal(idx, 1);
  assert.deepEqual(kinds(st), ['expected', 'expected']);
  assert.deepEqual(texts(st), [PAGE, CLICK]);
  const control = navThenStep(load()); // the control: the same 200 ms, as a step
  assert.equal(control.idx, 0);
  assert.deepEqual(texts(control.st), [CLICK, PAGE]);
});

// ==================== the double-click twins (srPopTwins) ===================

test('W11: a double-click pops the two clicks that produced it, and no more', () => {
  const h = load();
  const st = mkSt({ entries: [step('Open https://shop.example.com'), step(CLICK), step(CLICK)] });
  h.api.srPopTwins(st, CLICK);
  assert.deepEqual(texts(st), ['Open https://shop.example.com']);
  const three = mkSt({ entries: [step(CLICK), step(CLICK), step(CLICK)] });
  h.api.srPopTwins(three, CLICK);
  assert.deepEqual(texts(three), [CLICK]); // two at most: the third click was its own action
});

test('W12: a control that renamed itself between the clicks keeps both steps', () => {
  const h = load();
  const st = mkSt({ entries: [step('Click the "Pay now" button'), step('Click the "Paying…" button')] });
  h.api.srPopTwins(st, CLICK);
  assert.deepEqual(texts(st), ['Click the "Pay now" button', 'Click the "Paying…" button']);
  h.api.srPopTwins(st, 'Click the "Paying…" button'); // the control: the matching text does pop
  assert.deepEqual(texts(st), ['Click the "Pay now" button']);
});

test('W13: twins the editor already holds stay where they are', () => {
  const h = load();
  const st = mkSt({ entries: [step(CLICK), step(CLICK)], sent: 2 });
  h.api.srPopTwins(st, CLICK);
  assert.deepEqual(texts(st), [CLICK, CLICK]);
  st.sent = 1; // the control: one line still unsent, so one twin may go
  h.api.srPopTwins(st, CLICK);
  assert.deepEqual(texts(st), [CLICK]);
});

test('W14: popping past the last navigation forgets which line that was', () => {
  const h = load();
  const st = mkSt({ entries: [expected(PAGE), step(CLICK)], lastNavIdx: 1 });
  h.api.srPopTwins(st, CLICK);
  assert.deepEqual(texts(st), [PAGE]);
  assert.equal(st.lastNavIdx, -1); // nothing left to refine a title onto
});

// The frame contract, from the worker's side: tests/step-recorder-outbox.test.mjs H4/H5 pin that a
// double-click inside a frame EMITS `replaces` with the frame clause on it; this is the match.
test('W15: a double-click inside a frame pops its twins, frame clause and all', async () => {
  const inFrame = 'Click the "Pay" button in the "checkout.example.com" frame';
  const dbl = 'Double-click the "Pay" button in the "checkout.example.com" frame';
  const h = load({ session: { stepRec: mkSt({ entries: [step(inFrame), step(inFrame)] }) } });
  const r = await h.api.srAdd({ kind: 'step', text: dbl, replaces: inFrame }, sender);
  assert.equal(r.ok, true);
  assert.deepEqual(texts(h.st()), [dbl]);
});

// ================= the entry copy and its `replaces` firewall ===============

test('W16: `replaces` is a wire instruction and never enters the recording', () => {
  const h = load();
  const e = h.api.srEntry('step', 'x', {
    replaces: 'y', action: 'click', ctx: { frame: 'a' }, context: { row: '2', evil: 'z' },
  });
  assert.deepEqual(plain(e), { kind: 'step', text: 'x', action: 'click', context: { row: '2' }, ctx: { frame: 'a' } });
});

test('W17: `manual` marks an expectation the tester typed, and nothing else', () => {
  const h = load();
  assert.equal(h.api.srEntry('expected', 'x', { manual: true }).manual, true);
  assert.equal(h.api.srEntry('step', 'x', { manual: true }).manual, undefined);
});

// ====================== navigation dedup (srPushNav) ========================

test('W18: an identical auto navigation is the same line; a manual one is the tester\'s', () => {
  const h = load();
  assert.equal(h.api.srDupNavIdx(mkSt({ entries: [expected(PAGE)] }), PAGE), 0);
  assert.equal(h.api.srDupNavIdx(mkSt({ entries: [expected(PAGE, { manual: true })] }), PAGE), -1);
});

test('W19: one SPA navigation firing url and title collapses onto the first line', () => {
  const h = load();
  const st = mkSt({ entries: [expected(PAGE)] });
  assert.equal(h.api.srPushNav(st, PAGE, 50), 0);
  assert.deepEqual(texts(st), [PAGE]);
  assert.equal(h.api.srPushNav(st, 'The "Checkout" page opens', 50), 1); // the control: a real move
  assert.deepEqual(texts(st), [PAGE, 'The "Checkout" page opens']);
});

// ============================ title trimming ================================

test('W20: a title is one line of whitespace-collapsed text', () => {
  assert.equal(load().api.srTrimTitle('  Check   out  '), 'Check out');
});

test('W21: no title at all is the empty string, never "null"', () => {
  const { srTrimTitle } = load().api;
  assert.equal(srTrimTitle(''), '');
  assert.equal(srTrimTitle(null), '');
  assert.equal(srTrimTitle(undefined), '');
});

test('W22: a long title is cut at a word boundary, not mid-word', () => {
  const out = load().api.srTrimTitle(
    'Testomat.io — the manual test management tool for teams that ship weekly and often',
  );
  assert.equal(out, 'Testomat.io — the manual test management tool for teams that ship weekly and…');
  assert.equal(out.length, 77);
});

// Pinned as it stands: with no boundary in the first 80 the ellipsis is added to a full 80, so the
// output is 81 characters — one past SR_TITLE_MAX. Today's contract, and the reason it is here.
test('W23: a title with no boundary in it comes back one character over the maximum', () => {
  const out = load().api.srTrimTitle('x'.repeat(81));
  assert.equal(out, `${'x'.repeat(80)}…`);
  assert.equal(out.length, 81);
});

test('W24: a 79-character Ukrainian title is under the maximum and comes back whole', () => {
  const title = 'Замовлення №4711 — інтернет-магазин «Ромашка», доставка по всій Україні за добу';
  assert.equal(title.length, 79);
  assert.equal(load().api.srTrimTitle(title), title);
});

test('W25: the cut takes the last separator past the halfway mark and drops the punctuation on it', () => {
  const title = 'Dashboard | Acme — Admin · Reports, Metrics, Segments, Funnels, Cohorts, Retention';
  assert.equal(title.length, 82);
  assert.equal(
    load().api.srTrimTitle(title),
    'Dashboard | Acme — Admin · Reports, Metrics, Segments, Funnels, Cohorts…', // the comma is gone
  );
});

test('W26: a page with no title is named by its host', () => {
  assert.equal(load().api.srCleanTitle('', 'https://shop.example.com/cart'), 'shop.example.com');
});

// The ugly row, pinned as it is: with neither title nor parsable URL the sentence reads
// `The "the" page opens`. Written down so a change to it is a decision, not an accident.
test('W27: with nothing to go on the page is called by the URL, or literally "the"', () => {
  const { srCleanTitle } = load().api;
  assert.equal(srCleanTitle(null, 'not-a-url'), 'not-a-url');
  assert.equal(srCleanTitle('', ''), 'the');
});

// ==================== Chrome's placeholder title (srIsUrlTitle) =============

test('W28: host+path is Chrome\'s placeholder, not a title', () => {
  assert.equal(load().api.srIsUrlTitle('shop.example.com/cart', 'https://shop.example.com/cart'), true);
});

// The other shape Chrome shows while a page loads: the host with no path behind it.
test('W28b: the host on its own is Chrome\'s placeholder too', () => {
  const { srIsUrlTitle } = load().api;
  assert.equal(srIsUrlTitle('shop.example.com', 'https://shop.example.com/cart'), true);
  assert.equal(srIsUrlTitle('shop.example.com', 'https://shop.example.com/'), true);
});

test('W29: a real title is kept', () => {
  assert.equal(load().api.srIsUrlTitle('Cart', 'https://shop.example.com/cart'), false);
});

// A placeholder IS the address; a one-word section name the address happens to contain, and a
// title that carries the domain inside it, are the page's own words and are kept.
test('W30b: a real title that the URL merely contains is still a title', () => {
  const { srIsUrlTitle } = load().api;
  assert.equal(srIsUrlTitle('cart', 'https://shop.example.com/cart'), false);
  assert.equal(srIsUrlTitle('example.com — Home', 'https://shop.example.com/cart'), false);
});

test('W31: an empty or blank title is a placeholder', () => {
  const { srIsUrlTitle } = load().api;
  assert.equal(srIsUrlTitle('', 'https://shop.example.com/cart'), true);
  assert.equal(srIsUrlTitle('   ', 'https://shop.example.com/cart'), true);
});

test('W32: with an unparsable URL there is nothing to compare, so the title stands', () => {
  assert.equal(load().api.srIsUrlTitle('Checkout', 'not-a-url'), false);
});

// ======================= the title refine (srRefineNav) =====================

const navSt = (over = {}) => mkSt({
  entries: [expected('The "shop.example.com/cart" page opens')], lastNavIdx: 0, ...over,
});

test('W33: a placeholder title leaves the line alone', () => {
  const h = load();
  const st = navSt();
  assert.equal(h.api.srRefineNav(st, 'shop.example.com/cart', 'https://shop.example.com/cart'), false);
  assert.deepEqual(texts(st), ['The "shop.example.com/cart" page opens']);
  assert.equal(st.lastNavIdx, 0); // still waiting for a real one
});

test('W34: the first real title rewrites the line once, and then never again', () => {
  const h = load();
  const st = navSt();
  assert.equal(h.api.srRefineNav(st, 'Your cart', 'https://shop.example.com/cart'), true);
  assert.deepEqual(texts(st), ['The "Your cart" page opens']);
  assert.equal(st.lastNavIdx, -1);
  assert.equal(h.api.srRefineNav(st, 'Your cart — 3 items', 'https://shop.example.com/cart'), false);
  assert.deepEqual(texts(st), ['The "Your cart" page opens']);
});

test('W35: a line the editor already holds is never rewritten in our copy alone', () => {
  const h = load();
  const st = navSt({ sent: 1 });
  assert.equal(h.api.srRefineNav(st, 'Your cart', 'https://shop.example.com/cart'), false);
  assert.deepEqual(texts(st), ['The "shop.example.com/cart" page opens']);
  assert.equal(st.lastNavIdx, -1); // and the firewall closes for good
});

test('W36: when the rewrite creates a twin of the line above it, the twin goes', () => {
  const h = load();
  const st = mkSt({
    entries: [expected('The "Your cart" page opens'), expected('The "shop.example.com/cart" page opens')],
    lastNavIdx: 1,
  });
  assert.equal(h.api.srRefineNav(st, 'Your cart', 'https://shop.example.com/cart'), true);
  assert.deepEqual(texts(st), ['The "Your cart" page opens']);
});

// ========================= the recorded URL (srOpenUrl) =====================

test('W37: the query string is cut — a reset token is not part of the step', () => {
  assert.equal(load().api.srOpenUrl('https://a.com/p?token=x#frag', false), 'https://a.com/p');
});

test('W38: "Include the query string" is honoured, and hands back the address bar', () => {
  assert.equal(load().api.srOpenUrl('https://a.com/p?token=x#frag', true), 'https://a.com/p?token=x#frag');
});

test('W39: a #/ route is the page, and its own query is still cut', () => {
  assert.equal(load().api.srOpenUrl('https://a.com/#/board/1?q=2', false), 'https://a.com/#/board/1');
});

test('W40: credentials in the URL are dropped', () => {
  assert.equal(load().api.srOpenUrl('https://u:p@a.com/p', false), 'https://a.com/p');
});

test('W41: a non-default port is part of the address and is kept', () => {
  assert.equal(load().api.srOpenUrl('https://a.com:8443/p?q=1', false), 'https://a.com:8443/p');
});

test('W42: something that is not a URL is written down as it is', () => {
  assert.equal(load().api.srOpenUrl('not a url', false), 'not a url');
});

// ==================== the hand-over window (srFinalEnd) =====================

test('W43: the hand-over stops at the first line still young enough to change', () => {
  const h = load();
  const st = mkSt({ entries: [step('a', { at: 0 }), step('b', { at: 0 }), step('c', { at: 900 })] });
  assert.equal(h.api.srFinalEnd(st, 1000), 2);
});

test('W44: a navigation line gets three seconds to grow its real title', () => {
  const h = load();
  const st = mkSt({ entries: [expected(PAGE, { at: 0 })], lastNavIdx: 0 });
  assert.equal(h.api.srFinalEnd(st, 1500), 0);
  assert.equal(h.api.srFinalEnd(st, 3500), 1); // the control: past the nav window it is final
});

// ========================= the live pull and Stop ===========================

test('W45: a second poll with nothing new hands over nothing and writes nothing', async () => {
  const h = load({ session: { stepRec: mkSt({ entries: [step('a', { at: T0 - 1000 })] }) } });
  const first = await h.api.srPull();
  assert.deepEqual(plain(first.entries).map((e) => e.text), ['a']);
  assert.equal(h.st().sent, 1);
  assert.equal(h.named('storage.session.set').length, 1); // the control: the first pull did write
  h.clearCalls();
  const second = await h.api.srPull();
  assert.deepEqual(plain(second.entries), []);
  assert.deepEqual(h.named('storage.session.set'), []);
});

test('W46: Stop drains only the tail the poll had not taken, and is idempotent', async () => {
  const h = load({
    session: { stepRec: mkSt({ entries: [step('a', { at: T0 - 1000 }), step('b', { at: T0 })] }) },
  });
  await h.api.srPull(); // 'a' is final, 'b' is 200ms young
  assert.equal(h.st().sent, 1);
  const stop = await h.api.srStop();
  assert.deepEqual(plain(stop.entries).map((e) => e.text), ['b']);
  assert.equal(h.session.stepRec, undefined);
  assert.deepEqual(plain((await h.api.srStop()).entries), []);
});

// ============================ srAdd, the gate ===============================

test('W47: a stale frame from another tab writes nothing', async () => {
  const h = load({ session: { stepRec: mkSt({ entries: [step('a')] }) } });
  const r = await h.api.srAdd({ kind: 'step', text: CLICK }, { tab: { id: 99 } });
  assert.deepEqual(plain(r), { ok: false, wrongTab: true, count: 1 });
  assert.deepEqual(texts(h.st()), ['a']);
  const ok = await h.api.srAdd({ kind: 'step', text: CLICK }, sender); // the control: the right tab
  assert.equal(ok.ok, true);
  assert.deepEqual(texts(h.st()), ['a', CLICK]);
});

test('W48: an entry with no text is refused, and the pill is told the count it already had', async () => {
  const h = load({ session: { stepRec: mkSt({ entries: [step('a')] }) } });
  const r = await h.api.srAdd({ kind: 'step', text: '   ' }, sender);
  assert.deepEqual(plain(r), { ok: false, count: 1, paused: false, manualPause: false, recording: true });
  assert.deepEqual(texts(h.st()), ['a']);
});

test('W49: an action refused because of the pause leaves the deferred Open standing', async () => {
  const h = load({
    session: { stepRec: mkSt({ paused: true, pendingOpen: 'https://shop.example.com/cart' }) },
  });
  const r = await h.api.srAdd({ kind: 'step', text: CLICK }, sender);
  assert.equal(r.ok, false);
  assert.equal(h.st().pendingOpen, 'https://shop.example.com/cart'); // still owed to the recording
  assert.deepEqual(texts(h.st()), []);
});

test('W50: the first real action brings the deferred Open in with it', async () => {
  const h = load({ session: { stepRec: mkSt({ pendingOpen: 'https://shop.example.com/cart' }) } });
  const r = await h.api.srAdd({ kind: 'step', text: CLICK }, sender);
  assert.equal(r.ok, true);
  assert.deepEqual(texts(h.st()), ['Open https://shop.example.com/cart', CLICK]);
  assert.equal(h.st().pendingOpen, null);
});

test('W51: start then stop records nothing, and the Open it deferred is a trimmed URL', async () => {
  const h = load({ local: { settings: { envFullUrl: false } } });
  h.hooks.resolveSiteTab = () => ({
    state: 'ok',
    tab: { ...DEFAULT_TAB, url: 'https://shop.example.com/cart?token=abc#frag' },
  });
  assert.deepEqual(plain(await h.api.srStart({ documentId: 'doc-1' })), { ok: true, tabId: 7 });
  await settle();
  assert.equal(h.st().pendingOpen, 'https://shop.example.com/cart');
  assert.deepEqual(plain((await h.api.srStop()).entries), []);
});

// ===================== after a blind stretch (srCatchUpNav) =================

test('W52: coming back from a blind stretch records the page open NOW, not the hops', async () => {
  const h = load();
  const st = mkSt({ blind: true, lastUrl: 'https://shop.example.com/cart' });
  h.hooks.getTab = () => ({ id: 7, url: 'https://shop.example.com/thanks', title: 'Thank you' });
  assert.equal(await h.api.srCatchUpNav(st), true);
  assert.deepEqual(texts(st), ['The "Thank you" page opens']);
  assert.equal(st.lastUrl, 'https://shop.example.com/thanks');
});

test('W53: manually paused, the catch-up follows the tab and records nothing', async () => {
  const h = load();
  const st = mkSt({ blind: true, manualPause: true, lastUrl: 'https://shop.example.com/cart' });
  h.hooks.getTab = () => ({ id: 7, url: 'https://shop.example.com/thanks', title: 'Thank you' });
  assert.equal(await h.api.srCatchUpNav(st), true);
  assert.deepEqual(texts(st), []);
  assert.equal(st.lastUrl, 'https://shop.example.com/thanks');
  st.manualPause = false; // the control: the same hop, unpaused, is written down
  st.lastUrl = 'https://shop.example.com/cart';
  await h.api.srCatchUpNav(st);
  assert.deepEqual(texts(st), ['The "Thank you" page opens']);
});

// ==================== who owns the recording (srOrphaned) ===================

test('W54: with no owner to check, a live recording is never ended on a guess', async () => {
  const h = load();
  h.hooks.getContexts = () => [];
  assert.equal(await h.api.srOwnerOpen(mkSt({ docIds: [] })), true);
  assert.equal(await h.api.srOwnerOpen(mkSt({ docIds: ['doc-1'] })), false); // the control
});

test('W55: a registry that will not answer is not evidence the editor is gone', async () => {
  const h = load();
  h.hooks.getContexts = () => { throw new Error('registry mid-write'); };
  assert.equal(await h.api.srOwnerOpen(mkSt({ docIds: ['doc-1'] })), true);
});

test('W56: an editor that is gone ends the recording and keeps every entry', async () => {
  const h = load({ session: { stepRec: mkSt({ docIds: ['doc-1'], entries: [step('a'), step('b')] }) } });
  h.hooks.getContexts = () => [];
  assert.equal(await h.api.srOrphaned(), true);
  assert.equal(h.st().recording, false);
  assert.deepEqual(texts(h.st()), ['a', 'b']);
});

// ===================== one chain for the appends (srSerial) =================

test('W57: three actions fired in the same tick all land, in the order they were fired', async () => {
  const h = load({ session: { stepRec: mkSt() } });
  const { srSerial, srAdd } = h.api;
  srSerial(() => srAdd({ kind: 'step', text: 'one' }, sender));
  srSerial(() => srAdd({ kind: 'step', text: 'two' }, sender));
  await srSerial(() => srAdd({ kind: 'step', text: 'three' }, sender));
  assert.deepEqual(texts(h.st()), ['one', 'two', 'three']);
});

test('W58: one queued step failing does not take the chain down with it', async () => {
  const h = load({ session: { stepRec: mkSt() } });
  const { srSerial, srAdd } = h.api;
  await srSerial(() => Promise.reject(new Error('a handler blew up'))).catch(() => {});
  await srSerial(() => srAdd({ kind: 'step', text: CLICK }, sender));
  assert.deepEqual(texts(h.st()), [CLICK]);
});

// ======================== Stop's flush of the caret ========================

test('W59: a tab that never answers the flush stops the recording anyway, after 700 ms', async () => {
  const h = load({ session: { stepRec: mkSt() } });
  h.hooks.sendMessage = () => new Promise(() => {}); // the asleep tab: no answer, ever
  const p = h.api.srFlush();
  await settle();
  assert.deepEqual(h.pending(), [700]);
  h.advance(700);
  assert.deepEqual(plain(await p), { ok: true });
});

test('W60: a blind tab is not asked to flush at all', async () => {
  const h = load({ session: { stepRec: mkSt({ blind: true }) } });
  assert.deepEqual(plain(await h.api.srFlush()), { ok: true });
  assert.deepEqual(h.named('tabs.sendMessage'), []);
  assert.deepEqual(h.pending(), []);
  h.setSt(mkSt({ blind: false })); // the control: a tab that can see is asked
  await h.api.srFlush();
  assert.deepEqual(plain(h.named('tabs.sendMessage')), [[7, { type: 'STEPREC_FLUSH_NOW' }]]);
});

// ====================== Continue is not Resume =============================

test('W61: Continue grants another cap and clears the cap pause only', async () => {
  const h = load({ session: { stepRec: mkSt({ paused: true, manualPause: true }) } });
  assert.deepEqual(plain(await h.api.srContinue()), { ok: true });
  assert.equal(h.st().capBonus, 50);
  assert.equal(h.st().paused, false);
  assert.equal(h.st().manualPause, true);
});

test('W62: Pause survives Continue — Resume is the tester\'s own button', async () => {
  const h = load({ session: { stepRec: mkSt() } });
  await h.api.srPause(true);
  assert.equal(h.st().manualPause, true);
  await h.api.srContinue();
  assert.equal(h.st().manualPause, true);
  await h.api.srPause(false); // the control: Resume is what clears it
  assert.equal(h.st().manualPause, false);
});

// ==================== the debugger's refusals, classified ==================

test('W63: Chrome\'s foreign-frame wording is recognised', () => {
  assert.equal(load().api.dbgIsForeignFrame(FOREIGN), true);
});

test('W64: the foreign-frame refusal becomes our own copy, and unlocks the viewport rescue', () => {
  const h = load();
  const err = h.api.dbgError(FOREIGN);
  assert.equal(err.message, h.api.DBG_FOREIGN_FRAME);
  assert.equal(err.foreignFrame, true);
});

// Chrome's own wording names a tab id nobody can find; ours names the thing to close.
test('W65: "another debugger is attached" is explained in our words', () => {
  const err = load().api.dbgError('Another debugger is already attached to the tab with id: 5');
  assert.match(err.message, /DevTools|another tool|close/i);
  assert.equal(err.debuggerBusy, true);
});

test('W66: the refusal a toolbar click fixes is told apart from the ones it does not', () => {
  const { capNeedsGrant } = load().api;
  assert.equal(capNeedsGrant("Cannot access contents; requires 'activeTab' permission"), true);
  assert.equal(capNeedsGrant('The <all_urls> permission is missing'), true);
  assert.equal(capNeedsGrant(null), false);
});

// ======================= the viewport capture ==============================

test('W67: a background tab is reported, never thrown', async () => {
  const out = await load().api.captureVisibleNow({ active: false, windowId: 1 });
  assert.deepEqual(plain(out), { error: 'the tab is not the visible one' });
});

test('W68: a Chrome with no captureVisibleTab says so', async () => {
  const h = load();
  delete h.chrome.tabs.captureVisibleTab;
  assert.deepEqual(plain(await h.api.captureVisibleNow({ ...DEFAULT_TAB })), { error: 'captureVisibleTab unavailable' });
});

test('W69: an occluded window that never answers hits the eight-second floor', async () => {
  const h = load();
  h.hooks.captureVisibleTab = () => {}; // Chrome leaves the callback uncalled
  const p = h.api.captureVisible({ ...DEFAULT_TAB });
  await settle();
  assert.deepEqual(h.pending(), [8000]);
  h.advance(8000);
  assert.deepEqual(plain(await p), { error: 'the tab did not answer the capture' });
});

test('W70: a refusal a click would fix comes back flagged for the retry', async () => {
  const h = load();
  h.hooks.captureVisibleTab = (w, o, cb) => cb(undefined, "requires 'activeTab' permission");
  assert.deepEqual(plain(await h.api.captureVisibleNow({ ...DEFAULT_TAB })), {
    error: "requires 'activeTab' permission", needsGrant: true,
  });
});

test('W71: a build that throws the refusal instead of reporting it lands in the same shape', async () => {
  const h = load();
  h.hooks.captureVisibleTab = () => { throw new Error("Cannot access contents; requires 'activeTab' permission"); };
  assert.deepEqual(plain(await h.api.captureVisibleNow({ ...DEFAULT_TAB })), {
    error: "Cannot access contents; requires 'activeTab' permission", needsGrant: true,
  });
});

// ========================= the full-page clip ==============================

test('W72: the clip is the document, floored, at scale 1', async () => {
  const h = load();
  h.hooks.dbgSend = () => ({ res: { cssContentSize: { width: 1280.7, height: 4000.2 } } });
  assert.deepEqual(plain(await h.api.fullPageClip(7)), { x: 0, y: 0, width: 1280, height: 4000, scale: 1 });
});

test('W73: metrics with no size in them are no clip at all', async () => {
  const h = load();
  h.hooks.dbgSend = () => ({ res: {} });
  assert.equal(await h.api.fullPageClip(7), null);
  h.hooks.dbgSend = () => ({ res: { cssContentSize: { width: 0, height: 4000 } } });
  assert.equal(await h.api.fullPageClip(7), null);
  h.hooks.dbgSend = () => ({ res: { contentSize: { width: 800, height: 600 } } }); // the control
  assert.deepEqual(plain(await h.api.fullPageClip(7)), { x: 0, y: 0, width: 800, height: 600, scale: 1 });
});

test('W74: a refused metrics call is no clip, and no throw', async () => {
  const h = load();
  h.hooks.dbgSend = () => ({ error: 'Detached while handling command' });
  assert.equal(await h.api.fullPageClip(7), null);
});

// #112: past Chromium's 16384px texture ceiling the compose cannot succeed, so an unbounded clip
// asks for a shot that comes back as a generic failure. Cut it, and say the shot was cut.
test('W74b: a page taller than a screenshot can be is cut at the ceiling, and the clip says so', async () => {
  const h = load();
  h.hooks.dbgSend = () => ({ res: { cssContentSize: { width: 1280, height: 40000 } } });
  assert.deepEqual(plain(await h.api.fullPageClip(7)), {
    x: 0, y: 0, width: 1280, height: 16384, scale: 1, heightClipped: true,
  });
});

test('W74c: a page that ends exactly at the ceiling is taken whole, and says nothing', async () => {
  const h = load();
  h.hooks.dbgSend = () => ({ res: { cssContentSize: { width: 1280, height: 16384 } } });
  assert.deepEqual(plain(await h.api.fullPageClip(7)), { x: 0, y: 0, width: 1280, height: 16384, scale: 1 });
});

test('W74d: the cut reaches the panel the way the viewport downgrade does, and Chrome is asked only for what it can give', async () => {
  const tall = (h, height) => {
    h.hooks.dbgSend = (cmd) => (cmd === 'Page.getLayoutMetrics'
      ? { res: { cssContentSize: { width: 1280, height } } }
      : { res: { data: 'full' } });
  };
  const h = load();
  tall(h, 40000);
  assert.equal((await h.api.captureShot({ beyondViewport: true })).heightClipped, true);
  const shot = h.named('debugger.sendCommand').find((a) => a[1] === 'Page.captureScreenshot');
  // The whole point: the clip Chrome is handed stops at the ceiling, and carries nothing else.
  assert.deepEqual(plain(shot[2].clip), { x: 0, y: 0, width: 1280, height: 16384, scale: 1 });
  const control = load(); // the same shot of a page inside the ceiling is not reported as cut
  tall(control, 4000);
  assert.equal((await control.api.captureShot({ beyondViewport: true })).heightClipped, false);
});

// ================== the double-compose trim (trimToDocument) ================

const trim = async (h, bmp, clip) => {
  h.hooks.bitmap = () => ({ width: bmp[0], height: bmp[1], close() {} });
  return plain(await h.api.trimToDocument('data:image/jpeg;base64,orig', clip));
};

test('W75: a healthy shot is handed back untouched, never re-encoded', async () => {
  const h = load();
  assert.deepEqual(await trim(h, [1280, 4000], { width: 1280, height: 4000 }), {
    dataUrl: 'data:image/jpeg;base64,orig', trimmed: false,
  });
  assert.deepEqual(h.canvases, []);
});

test('W76: a page composed twice is cut back to one document', async () => {
  const h = load();
  const out = await trim(h, [1280, 8000], { width: 1280, height: 4000 });
  assert.equal(out.trimmed, true);
  assert.notEqual(out.dataUrl, 'data:image/jpeg;base64,orig');
  assert.deepEqual(h.canvases.map((c) => [c.width, c.height]), [[1280, 4000]]);
});

test('W77: two pixels of rounding are forgiven', async () => {
  const h = load();
  assert.equal((await trim(h, [1280, 4002], { width: 1280, height: 4000 })).trimmed, false);
  assert.deepEqual(h.canvases, []);
});

test('W78: on a 2x display the scale comes from the width, so nothing is cut', async () => {
  const h = load();
  assert.equal((await trim(h, [2560, 8000], { width: 1280, height: 4000 })).trimmed, false);
  assert.deepEqual(h.canvases, []);
});

test('W79: a tiny page gets the same rule, not a fixed slack', async () => {
  const h = load();
  assert.equal((await trim(h, [1280, 100], { width: 1280, height: 40 })).trimmed, true);
  assert.deepEqual(h.canvases.map((c) => [c.width, c.height]), [[1280, 40]]);
});

test('W80: the original shot is never lost to the guard that was meant to protect it', async () => {
  const orig = 'data:image/jpeg;base64,orig';
  const clip = { width: 1280, height: 4000 };
  const bmp = [1280, 8000];

  const noBitmap = load();
  delete noBitmap.sandbox.createImageBitmap;
  assert.deepEqual(plain(await noBitmap.api.trimToDocument(orig, clip)), { dataUrl: orig, trimmed: false });

  const noFetch = load();
  noFetch.hooks.fetchImage = () => Promise.reject(new Error('blob: gone'));
  assert.deepEqual(await trim(noFetch, bmp, clip), { dataUrl: orig, trimmed: false });

  const noEncode = load();
  noEncode.hooks.convertToBlob = () => { throw new Error('encoder busy'); };
  assert.deepEqual(await trim(noEncode, bmp, clip), { dataUrl: orig, trimmed: false });

  const control = load(); // the control: with all three working, the trim does happen
  assert.equal((await trim(control, bmp, clip)).trimmed, true);
});

// ========================== the capture ladder =============================

const shotOf = async (setup, opts = {}) => {
  const h = load();
  setup(h);
  h.clearCalls();
  try { return { h, out: plain(await h.api.captureShot(opts)) }; }
  catch (e) { return { h, err: e }; }
};

test('W81: a viewport shot that succeeds never touches the debugger', async () => {
  const { h, out } = await shotOf(() => {});
  assert.deepEqual(out, { dataUrl: 'data:image/jpeg;base64,visible', tabId: 7 });
  assert.deepEqual(h.named('debugger.attach'), []);
  assert.equal(h.named('tabs.captureVisibleTab').length, 1);
});

test('W82: a refused viewport shot falls through to the debugger rather than losing the shot', async () => {
  const { h, out } = await shotOf((hh) => {
    hh.hooks.captureVisibleTab = (w, o, cb) => cb(undefined, 'exceeded the quota');
  });
  assert.equal(out.dataUrl, 'data:image/jpeg;base64,shot');
  assert.equal(h.named('debugger.attach').length, 1);
});

test('W83: a restricted page is refused before either route runs', async () => {
  const { h, err } = await shotOf((hh) => {
    hh.hooks.resolveSiteTab = () => ({ state: 'system-page', error: 'A Chrome page cannot be captured' });
  });
  assert.equal(err.message, 'A Chrome page cannot be captured');
  assert.deepEqual(h.named('tabs.captureVisibleTab'), []);
  assert.deepEqual(h.named('debugger.attach'), []);
});

// A refusal with no copy of its own — it reaches the panel exactly as Chrome wrote it.
test('W84: any debugger failure that is not the foreign frame still rejects', async () => {
  const { h, err } = await shotOf(
    (hh) => { hh.hooks.dbgAttach = () => 'Cannot attach to this target.'; },
    { beyondViewport: true },
  );
  assert.equal(err.message, 'Cannot attach to this target.');
  assert.deepEqual(h.named('scripting.executeScript'), []); // no frame surgery for a stranger
});

test('W85: with no foreign frame to move and no viewport rescue, the original refusal is what is thrown', async () => {
  const { h, err } = await shotOf((hh) => {
    hh.hooks.dbgAttach = () => FOREIGN;
    hh.hooks.executeScript = () => [{ result: 0 }];
    hh.hooks.captureVisibleTab = (w, o, cb) => cb(undefined, 'exceeded the quota');
  }, { beyondViewport: true });
  assert.equal(err.message, h.api.DBG_FOREIGN_FRAME);
  assert.equal(err.foreignFrame, true);
});

test('W86: two frames moved out, the shot taken, and the frames put back', async () => {
  let attempt = 0;
  const { h, out } = await shotOf((hh) => {
    hh.hooks.dbgAttach = () => { attempt += 1; return attempt === 1 ? FOREIGN : null; };
    hh.hooks.executeScript = () => [{ result: 2 }];
    hh.hooks.dbgSend = (cmd) => (cmd === 'Page.getLayoutMetrics'
      ? { res: { cssContentSize: { width: 1280, height: 4000 } } }
      : { res: { data: 'full' } });
  }, { beyondViewport: true });
  assert.equal(out.framesMoved, 2);
  assert.equal(out.dataUrl, 'data:image/jpeg;base64,full');
  assert.equal(h.named('scripting.executeScript').length, 2); // out, and back again
  const order = h.calls.map((c) => c.name);
  assert.ok(order.lastIndexOf('scripting.executeScript') > order.indexOf('debugger.detach'));
});

test('W87: when the second shot fails too the frames still go back, and the viewport rescues it', async () => {
  const { h, out } = await shotOf((hh) => {
    hh.hooks.dbgAttach = () => FOREIGN;
    hh.hooks.executeScript = () => [{ result: 2 }];
  }, { beyondViewport: true });
  assert.deepEqual(out, { dataUrl: 'data:image/jpeg;base64,visible', tabId: 7, viewportOnly: true });
  assert.equal(h.named('scripting.executeScript').length, 2);
});

test('W88: a cast recording already holds the attach, so the shot shares it and leaves it standing', async () => {
  const { h, out } = await shotOf((hh) => { hh.hooks.castOwns = () => true; }, { beyondViewport: true });
  assert.equal(out.dataUrl, 'data:image/jpeg;base64,shot');
  assert.deepEqual(h.named('debugger.attach'), []);
  assert.deepEqual(h.named('debugger.detach'), []);
  assert.equal(h.named('debugger.sendCommand').length, 2); // the control: it did shoot
});

// After a worker restart the mirror is null until the cast's tab is re-seeded from session
// storage; the shot waits for that answer rather than attaching on top of the cast's own session.
test('W89: a shot right after a worker restart still shares the cast\'s attach', async () => {
  const h = load({ session: { screenRec: { recording: true, mode: 'cast', tabId: 7, paused: false } } });
  h.hooks.castOwns = () => false; // the mirror: the re-seed has not landed yet
  h.hooks.dbgAttach = () => 'Another debugger is already attached to the tab with id: 7';
  const { res } = await h.api.shootViaDebugger(7, true);
  assert.deepEqual(h.named('debugger.attach'), []);
  assert.deepEqual(h.named('debugger.detach'), []); // the cast's session is left standing
  assert.equal(res.data, 'shot'); // the control: it shared the attach and did shoot
});

// The control on W89: with no cast in session storage there is nothing to share, so the shot
// opens its own attach and closes it again.
test('W89b: with no recording to share, the shot attaches and detaches as it always did', async () => {
  const h = load();
  h.hooks.castOwns = () => false;
  const { res } = await h.api.shootViaDebugger(7, true);
  assert.deepEqual(plain(h.named('debugger.attach')), [[{ tabId: 7 }, '1.3']]);
  assert.deepEqual(plain(h.named('debugger.detach')), [[{ tabId: 7 }]]);
  assert.equal(res.data, 'shot');
});

// ================= the injected frame surgery, run on a page ===============

const framePage = (h) => {
  const doc = makeDocument();
  const win = {};
  h.sandbox.document = doc;
  h.sandbox.window = win;
  const mine = el('iframe');
  mine.src = `chrome-extension://${h.chrome.runtime.id}/panel.html`;
  const foreign = el('iframe');
  foreign.src = 'chrome-extension://otherextensionidhere/frame.html';
  const web = el('iframe');
  web.src = 'https://ads.example.com/f.html';
  doc.body.append(mine, foreign, web);
  return { doc, win, foreign };
};

test('W86a: only another extension\'s frame is taken out of the page', async () => {
  const h = load();
  h.hooks.executeScript = () => [{ result: 1 }];
  await h.api.foreignFramesOut(7);
  const [[arg]] = h.named('scripting.executeScript');
  const { doc, win } = framePage(h);
  assert.equal(arg.func(...arg.args), 1);
  assert.deepEqual(doc.body.children.map((c) => c.src), [
    `chrome-extension://${h.chrome.runtime.id}/panel.html`,
    'https://ads.example.com/f.html',
  ]);
  assert.equal(win.__testomatFramesOut.length, 1);
});

test('W86b: putting them back restores the position, not just the node', async () => {
  const h = load();
  h.hooks.executeScript = () => [{ result: 1 }];
  await h.api.foreignFramesOut(7);
  await h.api.foreignFramesBack(7);
  const [[out], [back]] = h.named('scripting.executeScript');
  const { doc, win } = framePage(h);
  out.func(...out.args);
  back.func(...back.args);
  assert.deepEqual(doc.body.children.map((c) => c.src), [
    `chrome-extension://${h.chrome.runtime.id}/panel.html`,
    'chrome-extension://otherextensionidhere/frame.html', // back in the middle, where it stood
    'https://ads.example.com/f.html',
  ]);
  assert.equal(win.__testomatFramesOut, null);
});

// ==================== the panel-document registry ==========================

test('W90: the last panel document closing ends an evidence recording, once', () => {
  const h = load();
  const port = h.connect('panel-doc');
  assert.deepEqual(h.pending(), []);
  port.disconnect();
  assert.deepEqual(h.pending(), [2000]);
  h.advance(2000);
  assert.deepEqual(h.named('evStopIfRecording'), [['panel-closed']]);
});

test('W91: a surface switch replaces the document inside the grace, and nothing is stopped', () => {
  const h = load();
  h.connect('panel-doc').disconnect();
  h.advance(1500);
  h.connect('panel-doc'); // the replacement lands
  assert.deepEqual(h.pending(), []); // the grace is CANCELLED here, not merely outvoted when it fires
  h.advance(5000);
  assert.deepEqual(h.named('evStopIfRecording'), []);
  const reclosed = load(); // a close, a reopen and a second close each get the full grace
  reclosed.connect('panel-doc').disconnect();
  reclosed.advance(1500);
  const back = reclosed.connect('panel-doc');
  back.disconnect();
  reclosed.advance(1999);
  assert.deepEqual(reclosed.named('evStopIfRecording'), []);
  reclosed.advance(1);
  assert.deepEqual(reclosed.named('evStopIfRecording'), [['panel-closed']]);
  const control = load(); // the control: with no replacement, the same close does stop it
  control.connect('panel-doc').disconnect();
  control.advance(2000);
  assert.deepEqual(control.named('evStopIfRecording'), [['panel-closed']]);
});

// The grace is a setTimeout in a worker Chrome may recycle at any moment, and chrome.alarms is not
// in the manifest — so a panel closed just before a recycle never stops the evidence recording.
test('W92: a worker recycled inside the grace wakes up holding nothing, and never stops it', () => {
  const dying = load();
  dying.connect('panel-doc').disconnect();
  assert.deepEqual(dying.pending(), [2000]); // the timer that is about to be thrown away
  const revived = load(); // the same worker, restarted: a fresh realm with a fresh timer table
  assert.deepEqual(revived.pending(), []);
  revived.advance(60_000);
  assert.deepEqual(revived.named('evStopIfRecording'), []);
});

test('W93: a panel is open in a window when a port says that window is its own', () => {
  const h = load();
  h.connect('panel'); // one that never said hello
  h.connect('panel').hello(3);
  assert.equal(h.api.panelOpenIn(3), true);
  assert.equal(h.api.panelOpenIn(4), false);
  assert.equal(h.api.panelOpenIn(null), false);
});

test('W94: a hello with no window id maps to null, the value the registry compares against', () => {
  const h = load();
  h.connect('panel').hello(undefined);
  const values = [...h.api.panelPorts.values()];
  assert.equal(values.length, 1);
  assert.ok(Object.is(values[0], null)); // null, never undefined
});

// ===================== the staged-shot sweep ===============================

test('W95: only an editor draft counts as a live owner of a staged shot', async () => {
  const h = load({ session: { 'editorDraft:7': { id: 7 }, siteTarget: 3, stepRec: mkSt() } });
  await h.api.sweepStagedShots();
  assert.deepEqual(plain(h.named('ShotStore.sweep')), [[['editorDraft:7'], 604800000]]);
});

test('W96: a sweep that cannot read the session is dropped, not thrown', async () => {
  const h = load();
  h.hooks.sessionGet = () => Promise.reject(new Error('storage unavailable'));
  await h.api.sweepStagedShots(); // resolves: a missed sweep runs again next startup
  assert.deepEqual(h.named('ShotStore.sweep'), []);
});

// ======================= the presence marker ===============================

test('W97: a self-hosted instance is marked on its own origin', () => {
  assert.equal(load().api.presenceMatch('https://self.example.com/'), 'https://self.example.com/*');
});

test('W98: the origin the manifest already declares is never registered twice', () => {
  assert.equal(load().api.presenceMatch('https://app.testomat.io'), null);
});

test('W99: anything that is not an http(s) origin is not marked at all', () => {
  const { presenceMatch } = load().api;
  for (const bad of ['ftp://x/', 'not a url', '', undefined]) assert.equal(presenceMatch(bad), null);
  assert.equal(presenceMatch('https://self.example.com'), 'https://self.example.com/*'); // the control
});

test('W100: plain http is accepted, deliberately — an instance on the intranet is still an instance', () => {
  assert.equal(load().api.presenceMatch('http://self.example.com/'), 'http://self.example.com/*');
});

test('W101: an instance that is no longer self-hosted has its registration taken away', async () => {
  const h = load({ local: { settings: { baseUrl: 'https://app.testomat.io' } } });
  h.hooks.getRegisteredContentScripts = () => [{ id: 'presence-configured' }];
  await settle();
  h.clearCalls();
  await h.api.syncPresenceScript();
  assert.deepEqual(plain(h.named('scripting.unregisterContentScripts')), [[{ ids: ['presence-configured'] }]]);
  assert.deepEqual(h.named('scripting.registerContentScripts'), []);
});

test('W102: a host that changed is updated in place; a first one is registered', async () => {
  const h = load({ local: { settings: { baseUrl: 'https://self.example.com' } } });
  h.hooks.getRegisteredContentScripts = () => [{ id: 'presence-configured' }];
  await settle();
  h.clearCalls();
  await h.api.syncPresenceScript();
  assert.deepEqual(plain(h.named('scripting.updateContentScripts')), [[[{
    id: 'presence-configured',
    js: ['content/presence.js'],
    matches: ['https://self.example.com/*'],
    runAt: 'document_start',
    persistAcrossSessions: true,
  }]]]);
  assert.deepEqual(h.named('scripting.registerContentScripts'), []);

  const first = load({ local: { settings: { baseUrl: 'https://self.example.com' } } });
  await settle();
  assert.equal(first.named('scripting.registerContentScripts').length, 1); // the control
  assert.deepEqual(first.named('scripting.updateContentScripts'), []);
});

// ========================== the file overlay ===============================

test('W103: the viewer URL carries the file through URLSearchParams, encoded', () => {
  const h = load();
  const url = h.api.viewerPageUrl({ url: 'https://x/a b?c=1', name: 'a&b.png', type: 'image/png' });
  assert.equal(url, `chrome-extension://${h.chrome.runtime.id}/viewer/viewer.html`
    + '?url=https%3A%2F%2Fx%2Fa+b%3Fc%3D1&name=a%26b.png&type=image%2Fpng');
  assert.deepEqual([...new URL(url).searchParams.getAll('name')], ['a&b.png']);
});

test('W104: a message with no file is refused before any tab is touched', async () => {
  const h = load();
  await settle();
  h.clearCalls();
  assert.deepEqual(plain(await h.api.openFileOverlay({})), { ok: false, error: 'no file' });
  assert.deepEqual(h.named('storage.session.set'), []);
  assert.deepEqual(h.named('resolveSiteTab'), []);
});

test('W105: a page no extension may script gets the viewer in a tab of its own', async () => {
  const h = load();
  h.hooks.executeScript = () => { throw new Error('Cannot access a chrome:// URL'); };
  const out = plain(await h.api.openFileOverlay({ url: 'https://x/a.png', name: 'a.png', mime: 'image/png' }));
  assert.deepEqual(out, { ok: true, overlay: false, tabId: 99 });
  const [[created]] = h.named('tabs.create');
  assert.equal(created.url, h.api.viewerPageUrl({ url: 'https://x/a.png', name: 'a.png', type: 'image/png' }));
  const control = load(); // the control: a page that can be scripted keeps the overlay
  assert.deepEqual(
    plain(await control.api.openFileOverlay({ url: 'https://x/a.png', name: 'a.png', mime: 'image/png' })),
    { ok: true, overlay: true, tabId: 7 },
  );
});
