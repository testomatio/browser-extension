#!/usr/bin/env node
// The pill the tester sees in the corner: what it says in its three states, the `+ Expected` input
// it opens, where a dragged pill lands and is remembered, and how the whole recorder starts, polls
// and takes itself down. Run: node --test tests/step-recorder-pill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { load, el, HOST_ID, RECORDER } from './helpers/recorder-harness.mjs';

const source = () => readFileSync(RECORDER, 'utf8');
const rec = (opts = {}) => load(opts);

// The worker's status reply (background.js srEcho) with whatever this row needs mirrored back.
const status = (over = {}) => ({ count: 0, paused: false, manualPause: false, recording: true, ...over });

const pillText = (h) => (h.box().querySelector('.txt') || {}).textContent;
const pillButtons = (h) => h.box().querySelectorAll('button').map((b) => b.textContent);
const buttonNamed = (h, label) => h.box().querySelectorAll('button').find((b) => b.textContent === label);
const css = (h) => h.host().style.cssText;
const types = (h) => h.sent().map((m) => m.type);
const CORNER = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';

// Open + Expected and hand back the input it put in the pill.
function openExpected(h) {
  h.fireOn(buttonNamed(h, 'Expected'), 'click');
  return h.box().children[1];
}

// One press-move-release: the press lands on the pill, the move and the release on the window.
function drag(h, from, to, id = 1) {
  h.fireOn(h.box(), 'pointerdown', { button: 0, pointerId: id, clientX: from[0], clientY: from[1] });
  h.fireWin('pointermove', { pointerId: id, clientX: to[0], clientY: to[1] });
  h.fireWin('pointerup', { pointerId: id });
}

// ---- K: pause / resume / stop / render -------------------------------------

test('K1: a fresh recording counts nothing yet', async () => {
  const h = rec();
  await h.settle();
  assert.equal(pillText(h), 'Recording · 0 steps');
});

test('K2: one step reads singular', async () => {
  const h = rec({ reply: () => status({ count: 1 }) });
  h.poll();
  await h.settle();
  assert.equal(pillText(h), 'Recording · 1 step');
});

test('K3: the tester\'s own pause names the count and offers Resume', async () => {
  const h = rec({ reply: () => status({ count: 3, manualPause: true }) });
  h.poll();
  await h.settle();
  assert.equal(pillText(h), 'Paused · 3 steps');
  assert.equal(h.box().classList.contains('paused'), true);
  assert.deepEqual(pillButtons(h), ['Resume', 'Stop']);
});

test('K4: the cap asks instead of counting, and offers Continue', async () => {
  const h = rec({ reply: () => status({ count: 3, paused: true }) });
  h.poll();
  await h.settle();
  assert.equal(pillText(h), 'Still recording?');
  assert.equal(h.box().classList.contains('paused'), true);
  assert.deepEqual(pillButtons(h), ['Continue', 'Stop']);
});

test('K5: recording draws + Expected with the panel\'s own add glyph, then Pause and Stop', async () => {
  const h = rec({ icons: true });
  await h.settle();
  assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']);
  assert.deepEqual(h.box().querySelectorAll('button').map((b) => b.className), ['exp', '', 'stop']);
  assert.equal(h.box().classList.contains('paused'), false);
  assert.deepEqual(h.iconCalls(), [{ name: 'add', size: 14 }]);
});

// A page stylesheet must not bleed into the pill; the reset is the one rule worth pinning.
test('K5b: the shadow stylesheet resets everything the page could inherit', async () => {
  const h = rec();
  await h.settle();
  assert.ok(h.shadow().querySelector('style').textContent.includes(':host { all: initial; }'));
});

test('K6: Pause flips the pill before it tells the worker', async () => {
  const seen = [];
  let peek = () => null;
  const h = rec({
    reply: (m) => { seen.push({ type: m.type, txt: peek() }); return status({ manualPause: m.type === 'STEPREC_PAUSE' && m.on }); },
  });
  peek = () => pillText(h);
  await h.settle();
  h.fireOn(buttonNamed(h, 'Pause'), 'click');
  // Synchronously, before a single microtask has run: the pill has already answered the click.
  assert.equal(pillText(h), 'Paused · 0 steps');
  assert.deepEqual(pillButtons(h), ['Resume', 'Stop']);
  const pause = h.sent().find((m) => m.type === 'STEPREC_PAUSE');
  assert.equal(pause.on, true);
  assert.deepEqual(seen.find((s) => s.type === 'STEPREC_PAUSE'), { type: 'STEPREC_PAUSE', txt: 'Paused · 0 steps' });
  await h.settle();
  assert.equal(pillText(h), 'Paused · 0 steps');
});

test('K7: a worker that disagrees flips the pill back', async () => {
  const h = rec({ reply: () => status({ manualPause: false }) });
  await h.settle();
  h.fireOn(buttonNamed(h, 'Pause'), 'click');
  assert.equal(pillText(h), 'Paused · 0 steps');
  await h.settle();
  assert.equal(pillText(h), 'Recording · 0 steps');
  assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']);
});

test('K8: a sleeping worker leaves the optimistic pause standing', async () => {
  const h = rec({
    reply: (m) => { if (m.type === 'STEPREC_PAUSE') throw new Error('worker asleep'); return status(); },
  });
  await h.settle();
  h.fireOn(buttonNamed(h, 'Pause'), 'click');
  await h.settle();
  assert.equal(pillText(h), 'Paused · 0 steps');
  assert.deepEqual(pillButtons(h), ['Resume', 'Stop']);
});

test('K9: Continue asks the worker first, then clears the cap', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ paused: true }) : status()) });
  h.poll();
  await h.settle();
  h.fireOn(buttonNamed(h, 'Continue'), 'click');
  assert.ok(types(h).includes('STEPREC_CONTINUE'));
  assert.equal(pillText(h), 'Still recording?'); // not optimistic: the cap is the worker's to lift
  await h.settle();
  assert.equal(pillText(h), 'Recording · 0 steps');
  assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']);
});

// The order is the whole row: the entry has to REACH the worker before the stop message, because
// the editor's follow-up stop clears the state the moment it lands.
test('K10: Stop sends the last typed field and only then asks to stop', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const h = rec({ reply: (m) => (m.type === 'STEPREC_ADD' ? held.then(() => status({ count: 1 })) : status()) });
  const input = el('input', { 'aria-label': 'Search', value: 'shoes' });
  h.doc.body.append(input);
  input.focus();
  await h.settle();

  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  // The worker has not answered the entry yet, so the stop request is still held back.
  assert.deepEqual(types(h), ['STEPREC_TITLE', 'STEPREC_ADD']);
  assert.equal(h.entries()[0].text, 'Type "shoes" into the Search field');

  release();
  await h.settle(4);
  assert.deepEqual(types(h), ['STEPREC_TITLE', 'STEPREC_ADD', 'STEPREC_STOP_REQUEST']);
  assert.ok(types(h).indexOf('STEPREC_ADD') < types(h).indexOf('STEPREC_STOP_REQUEST'));
});

test('K10b: Stop takes the click at once — the pill never waits for the flush', async () => {
  const held = new Promise(() => {}); // an entry the worker never answers
  const h = rec({ reply: (m) => (m.type === 'STEPREC_ADD' ? held : status()) });
  const input = el('input', { 'aria-label': 'Search', value: 'shoes' });
  h.doc.body.append(input);
  input.focus();
  await h.settle();
  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  assert.equal(pillText(h), 'Recording · 0 steps'); // re-rendered, not frozen mid-click
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  await h.act(btn, 'click');
  assert.deepEqual(h.entries().map((e) => e.action), ['type']); // recording is off
});

test.todo('K11: a stopped recorder still shows a live toolbar (#223)', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_ADD' ? status() : status()) });
  await h.settle();
  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  assert.deepEqual(pillButtons(h), ['Stop']);
});

test('K12: a poll re-render moves the dot and the label, it never rebuilds them', async () => {
  const h = rec({ reply: () => status({ count: 2 }) });
  await h.settle();
  const dot = h.box().querySelector('.dot');
  const txt = h.box().querySelector('.txt');
  const stop = buttonNamed(h, 'Stop');
  h.poll();
  await h.settle();
  assert.equal(h.box().querySelector('.dot'), dot);
  assert.equal(h.box().querySelector('.txt'), txt);
  assert.equal(pillText(h), 'Recording · 2 steps');
  assert.notEqual(buttonNamed(h, 'Stop'), stop); // the buttons, by contrast, are new every render
});

test.todo('K13: the pill announces nothing to a screen reader (#224)', async () => {
  const h = rec();
  await h.settle();
  assert.equal(h.box().getAttribute('aria-live'), 'polite');
});

// ---- L: + Expected ---------------------------------------------------------

test('L1: + Expected replaces the toolbar with a focused input', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  assert.deepEqual(h.box().children.map((c) => `${c.tagName}.${c.className}`), ['SPAN.dot', 'INPUT.exp-input', 'BUTTON.stop']);
  assert.equal(input.type, 'text');
  assert.equal(input.className, 'exp-input');
  assert.equal(input.maxLength, 200);
  assert.equal(input.placeholder, 'Expected result — Enter to add, Esc to cancel');
  assert.equal(input.getAttribute('aria-label'), 'Expected result');
  assert.equal(h.shadow().activeElement, input);
  assert.equal(h.box().querySelector('.txt'), null);
});

test('L2: Enter commits the typed expectation with its whitespace collapsed', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  input.value = '  the   cart  opens ';
  const ev = h.fireOn(h.shadow(), 'keydown', { target: input, key: 'Enter' });
  assert.deepEqual(h.entries(), [{ kind: 'expected', text: 'the cart opens', manual: true }]);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']); // the pill comes back
  assert.equal(pillText(h), 'Recording · 0 steps');
});

test('L3: Enter on nothing typed adds nothing and restores the pill', async () => {
  const h = rec();
  await h.settle();
  for (const value of ['', '   ']) {
    const input = openExpected(h);
    input.value = value;
    h.fireOn(h.shadow(), 'keydown', { target: input, key: 'Enter' });
    assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']);
    assert.equal(pillText(h), 'Recording · 0 steps');
  }
  assert.deepEqual(h.entries(), []);
});

test('L4: Escape throws the typed text away and restores the pill', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  input.value = 'the cart opens';
  const ev = h.fireOn(h.shadow(), 'keydown', { target: input, key: 'Escape' });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.entries(), []);
  assert.deepEqual(pillButtons(h), ['Expected', 'Pause', 'Stop']);
  assert.equal(pillText(h), 'Recording · 0 steps');
});

test('L5: a poll while the input is open leaves the caret and the half-typed text alone', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  input.value = 'half typed';
  h.poll();
  await h.settle();
  assert.equal(h.box().children.includes(input), true);
  assert.equal(input.value, 'half typed');
  assert.equal(h.shadow().activeElement, input);
  assert.equal(h.box().querySelector('.txt'), null); // the pill was never rebuilt under it
});

test('L6: a pause takes the pill back and the typed text with it', async () => {
  for (const [flag, label, buttons] of [
    ['paused', 'Still recording?', ['Continue', 'Stop']],
    ['manualPause', 'Paused · 0 steps', ['Resume', 'Stop']],
  ]) {
    const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ [flag]: true }) : status()) });
    await h.settle();
    const input = openExpected(h);
    input.value = 'half typed';
    h.poll();
    await h.settle();
    assert.equal(h.box().children.includes(input), false);
    assert.equal(pillText(h), label);
    assert.deepEqual(pillButtons(h), buttons);
  }
});

test.todo('L7: the pill swallows every key the page might want (#225)', async () => {
  const h = rec();
  await h.settle();
  // No input open, so neither key means anything to the pill — a page "/" hotkey should still fire.
  assert.equal(h.fireOn(h.shadow(), 'keydown', { target: h.box(), key: '/' }).propagationStopped, false);
  assert.equal(h.fireOn(h.shadow(), 'keydown', { target: h.box(), key: 'Escape' }).propagationStopped, false);
});

test('L8: nothing typed in the pill leaks out to the page', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  for (const type of ['input', 'change', 'keyup', 'keypress']) {
    assert.equal(h.fireOn(h.shadow(), type, { target: input }).propagationStopped, true, type);
  }
});

test('L9: the pill\'s own input is never a step, the page\'s field beside it still is', async () => {
  const h = rec();
  const field = el('input', { 'aria-label': 'Search', value: 'shoes' });
  h.doc.body.append(field);
  await h.settle();
  const input = openExpected(h);
  input.value = 'the cart opens';
  await h.act(input, 'blur');
  assert.deepEqual(h.entries(), []);
  await h.act(field, 'blur');
  assert.deepEqual(h.entries().map((e) => e.text), ['Type "shoes" into the Search field']);
});

// ---- M: position and drag --------------------------------------------------

test('M1: with nothing stored the pill sits in the bottom-right corner', async () => {
  const h = rec();
  await h.settle();
  assert.equal(css(h), CORNER);
});

test('M2: a stored position is applied as left/top', async () => {
  const h = rec({ storage: { stepRecIndicatorPos: { left: 100, top: 200 } } });
  await h.settle();
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:100px;top:200px;');
});

test('M3: a stored position that is not a pair of numbers is ignored', async () => {
  for (const stepRecIndicatorPos of [{ left: 'a', top: 10 }, null]) {
    const h = rec({ storage: { stepRecIndicatorPos } });
    await h.settle();
    assert.equal(css(h), CORNER);
  }
});

test('M4: a read that lands mid-drag never overrules the hand that is dragging', async () => {
  const h = rec({ storage: { stepRecIndicatorPos: { left: 100, top: 200 } } });
  // No await yet: the storage promise is queued but the tester gets there first.
  h.fireOn(h.box(), 'pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 300 });
  h.fireWin('pointermove', { pointerId: 1, clientX: 340, clientY: 320 });
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:40px;top:20px;');
  await h.settle();
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:40px;top:20px;');
});

test('M5: a position off the top-left is pulled back to the edge margin', async () => {
  const h = rec({ storage: { stepRecIndicatorPos: { left: -50, top: -50 } } });
  await h.settle();
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:8px;top:8px;');
});

test('M6: a position off a smaller viewport is clamped to the pill\'s own size', async () => {
  const h = rec({ storage: { stepRecIndicatorPos: { left: 5000, top: 5000 } }, innerWidth: 1280, innerHeight: 800 });
  h.box().offsetWidth = 300;
  h.box().offsetHeight = 40;
  await h.settle();
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:972px;top:752px;');
});

test('M7: a pill wider than the viewport still starts at the margin, never off-screen left', async () => {
  const h = rec({ storage: { stepRecIndicatorPos: { left: 500, top: 500 } }, innerWidth: 1280, innerHeight: 800 });
  h.box().offsetWidth = 1400;
  h.box().offsetHeight = 40;
  await h.settle();
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:8px;top:500px;');
});

test('M8: a press aimed at Stop is a press, never the start of a drag', async () => {
  const h = rec();
  await h.settle();
  const stop = buttonNamed(h, 'Stop');
  h.fireOn(h.box(), 'pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, target: stop });
  h.fireWin('pointermove', { pointerId: 1, clientX: 200, clientY: 200 });
  h.fireWin('pointerup', { pointerId: 1 });
  assert.equal(css(h), CORNER);
  assert.equal(h.box().className, 'box');
  assert.deepEqual(h.writes(), []);
});

test('M9: a right-click press starts no drag', async () => {
  const h = rec();
  await h.settle();
  h.fireOn(h.box(), 'pointerdown', { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
  h.fireWin('pointermove', { pointerId: 1, clientX: 200, clientY: 200 });
  assert.equal(css(h), CORNER);
  assert.equal(h.box().className, 'box');
});

test('M10: three pixels is a press, not a drag', async () => {
  const h = rec();
  await h.settle();
  drag(h, [100, 100], [102, 101]);
  assert.equal(css(h), CORNER);
  assert.equal(h.box().className, 'box');
  assert.deepEqual(h.writes(), []);
});

test('M11: twenty pixels moves the pill and the drop is remembered', async () => {
  const h = rec();
  await h.settle();
  h.fireOn(h.box(), 'pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  h.fireWin('pointermove', { pointerId: 1, clientX: 120, clientY: 100 });
  assert.equal(h.box().classList.contains('dragging'), true);
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:20px;top:8px;');
  h.fireWin('pointerup', { pointerId: 1 });
  assert.equal(h.box().classList.contains('dragging'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes())), [{ stepRecIndicatorPos: { left: 20, top: 8 } }]);
});

test('M12: the click a drop produces never reaches the button under the pill', async () => {
  const h = rec();
  await h.settle();
  drag(h, [100, 100], [140, 100]);
  h.advance(50);
  const ev = h.fireOn(h.box(), 'click', {});
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
});

test('M13: a click long after the drop is the tester\'s, and goes through', async () => {
  const h = rec();
  await h.settle();
  drag(h, [100, 100], [140, 100]);
  h.advance(150);
  const ev = h.fireOn(h.box(), 'click', {});
  assert.equal(ev.defaultPrevented, false);
  assert.equal(ev.propagationStopped, false);
});

test('M14: a drop that produced no click does not eat the next real one', async () => {
  const h = rec();
  await h.settle();
  drag(h, [100, 100], [140, 100]);
  h.advance(10);
  // The next press spends whatever the drop left, well inside the 100ms window.
  h.fireOn(h.box(), 'pointerdown', { button: 0, pointerId: 2, clientX: 140, clientY: 100 });
  h.advance(10);
  assert.equal(h.fireOn(h.box(), 'click', {}).defaultPrevented, false);
});

test('M15: no press or release on the pill ever bubbles into the page', async () => {
  const h = rec();
  await h.settle();
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    assert.equal(h.fireOn(h.box(), type, { button: 1, pointerId: 7 }).propagationStopped, true, type);
  }
});

test('M16: a frame draws no pill, so it listens for no resize', async () => {
  const child = rec({ top: false });
  await child.settle();
  assert.equal(child.host(), null);
  assert.equal(child.winEvents().includes('resize'), false);
  const top = rec({ top: true });
  await top.settle();
  assert.equal(top.winEvents().includes('resize'), true);
});

test('M17: a synthetic pointer that cannot be captured still drags the pill', async () => {
  const h = rec();
  await h.settle();
  h.box().setPointerCapture = () => { throw new Error('synthetic pointer'); };
  h.box().releasePointerCapture = () => { throw new Error('synthetic pointer'); };
  drag(h, [100, 100], [130, 100]);
  assert.equal(css(h), 'position:fixed;z-index:2147483647;left:30px;top:8px;');
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes())), [{ stepRecIndicatorPos: { left: 30, top: 8 } }]);
});

// ---- N: lifecycle and teardown ---------------------------------------------

test('N1: a second injection into the same document changes nothing', async () => {
  const h = rec();
  await h.settle();
  const host = h.host();
  const before = { win: h.winEvents().length, sent: h.sent().length, msg: h.msgListener() };
  runInContext(source(), h.sandbox);
  await h.settle();
  assert.equal(h.host(), host); // not removed and rebuilt: the same pill the tester was looking at
  assert.equal(h.doc.querySelectorAll(`#${HOST_ID}`).length, 1);
  assert.equal(h.winEvents().length, before.win);
  assert.equal(h.sent().length, before.sent);
  assert.equal(h.msgListener(), before.msg);
  for (const type of ['click', 'dblclick', 'change', 'blur', 'keydown', 'compositionstart', 'compositionend']) {
    assert.equal(h.doc.listeners.get(type).length, 1, type);
  }
});

test('N2: no sendMessage means no recorder — and no latch to block the real injection', async () => {
  const h = rec({ noSendMessage: true });
  await h.settle();
  assert.equal(h.win.__testomatStepRecInited, undefined);
  assert.equal(h.host(), null);
  assert.deepEqual(h.winEvents(), []);
  assert.equal(h.msgListener(), null);

  const seen = [];
  h.sandbox.chrome.runtime.sendMessage = (m) => { seen.push(m.type); return Promise.resolve(status()); };
  runInContext(source(), h.sandbox);
  await h.settle();
  assert.equal(h.win.__testomatStepRecInited, true);
  assert.equal(h.host().id, HOST_ID);
  assert.deepEqual(seen, ['STEPREC_TITLE']);
});

test('N3: the poll learns recording is over and takes the recorder down', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ recording: false }) : status()) });
  await h.settle();
  h.poll();
  await h.settle();
  assert.equal(h.host(), null);
  assert.equal(h.pollCleared(), true);
  assert.equal(h.win.__testomatStepRecInited, false);
});

test('N4: a sleeping worker leaves the pill alone until the next tick answers', async () => {
  let asleep = true;
  const h = rec({
    reply: (m) => {
      if (m.type === 'STEPREC_STATUS' && asleep) throw new Error('worker asleep');
      return status({ count: 4 });
    },
  });
  await h.settle();
  h.poll();
  await h.settle();
  assert.equal(h.host().id, HOST_ID);
  assert.equal(h.pollCleared(), false);
  assert.equal(pillText(h), 'Recording · 0 steps');
  asleep = false;
  h.poll();
  await h.settle();
  assert.equal(pillText(h), 'Recording · 4 steps');
});

test('N5: the poll mirrors the worker\'s count and both pauses', async () => {
  const h = rec({ reply: () => status({ count: 9, paused: false, manualPause: true }) });
  h.poll();
  await h.settle();
  assert.equal(pillText(h), 'Paused · 9 steps');
  assert.equal(h.box().classList.contains('paused'), true);
  assert.deepEqual(pillButtons(h), ['Resume', 'Stop']);
});

const DOC_EVENTS = ['click', 'dblclick', 'change', 'blur', 'keydown', 'compositionstart', 'compositionend'];

test('N6: teardown flushes what is queued and unhooks every listener it made', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ recording: false }) : status()) });
  await h.settle();
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  h.fire(btn, 'click');
  await h.settle();
  assert.deepEqual(h.entries(), []); // still inside its 400ms packet window
  assert.deepEqual(h.winEvents(), ['pointermove', 'pointerup', 'pointercancel', 'resize', 'pagehide', 'beforeunload']);

  h.poll();
  await h.settle();
  assert.deepEqual(h.entries().map((e) => e.text), ['Click the "Pay now" button']);
  assert.equal(h.pollCleared(), true);
  assert.deepEqual(h.winEvents(), []);
  for (const type of DOC_EVENTS) assert.equal(h.doc.listeners.get(type).length, 0, type);
  assert.equal(h.msgListener(), null);
  assert.equal(h.flagListener(), null);
  assert.equal(h.host(), null);
  assert.equal(h.win.__testomatStepRecInited, false);
});

test('N7: a second teardown does nothing at all', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ recording: false }) : status()) });
  await h.settle();
  const host = h.host();
  h.poll();
  await h.settle();
  // Two things only a second teardown would touch.
  h.win.__testomatStepRecInited = 'untouched';
  h.doc.body.append(host);
  h.poll();
  await h.settle();
  assert.equal(h.win.__testomatStepRecInited, 'untouched');
  assert.equal(h.host(), host);
});

test('N8: STEPREC_FLUSH_NOW keeps the channel open and answers once the flush lands', async () => {
  const h = rec();
  const input = el('input', { 'aria-label': 'Search', value: 'shoes' });
  h.doc.body.append(input);
  input.focus();
  await h.settle();
  const got = [];
  assert.equal(h.runtimeMessage({ type: 'STEPREC_FLUSH_NOW' }, (r) => got.push(r)), true);
  assert.equal(got.length, 0); // the answer is owed, not given
  await h.settle(4);
  assert.equal(got.length, 1);
  assert.equal(got[0].ok, true);
  assert.deepEqual(h.entries().map((e) => e.text), ['Type "shoes" into the Search field']);
});

test('N9: the same message after teardown is answered at once, not left to time out', async () => {
  const h = rec({ reply: (m) => (m.type === 'STEPREC_STATUS' ? status({ recording: false }) : status()) });
  await h.settle();
  const onFlushMsg = h.msgListener(); // teardown unhooks it; a message already in flight still lands
  h.poll();
  await h.settle();
  const got = [];
  assert.equal(onFlushMsg({ type: 'STEPREC_FLUSH_NOW' }, {}, (r) => got.push(r)), undefined);
  assert.equal(got.length, 1);
  assert.equal(got[0].ok, true);
});

test('N10: any other message is left to whoever it was for', async () => {
  const h = rec();
  await h.settle();
  const got = [];
  assert.equal(h.runtimeMessage({ type: 'SOMETHING_ELSE' }, (r) => got.push(r)), undefined);
  assert.equal(h.runtimeMessage(null, (r) => got.push(r)), undefined);
  assert.deepEqual(got, []);
});

test('N11: a page about to go flushes what the last click queued', async () => {
  for (const type of ['pagehide', 'beforeunload']) {
    const h = rec();
    const btn = el('button', null, 'Pay now');
    h.doc.body.append(btn);
    h.fire(btn, 'click');
    await h.settle();
    assert.deepEqual(h.entries(), [], type); // the packet window has not closed
    h.fireWin(type);
    await h.settle();
    assert.deepEqual(h.entries().map((e) => e.text), ['Click the "Pay now" button'], type);
  }
});

test('N12: Stop records the field the caret never left', async () => {
  const h = rec();
  const input = el('input', { 'aria-label': 'Search', value: 'shoes' });
  h.doc.body.append(input);
  input.focus();
  await h.settle();
  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  assert.deepEqual(h.entries().map((e) => e.text), ['Type "shoes" into the Search field']);
  assert.ok(types(h).includes('STEPREC_STOP_REQUEST'));
});

test('N13: a caret inside the pill is not a field to flush', async () => {
  const h = rec();
  await h.settle();
  const input = openExpected(h);
  input.value = 'the cart opens';
  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  assert.deepEqual(h.entries(), []);
  assert.ok(types(h).includes('STEPREC_STOP_REQUEST')); // the stop still ran to the end
});

test('N14: a caret inside a web component is found by descending into it', async () => {
  const h = rec();
  const widget = h.doc.createElement('my-widget');
  h.doc.body.append(widget);
  const inner = el('input', { 'aria-label': 'Search', value: 'shoes' });
  widget.attachShadow({ mode: 'open' }).append(inner);
  inner.focus();
  assert.equal(h.doc.activeElement, widget); // the document only ever sees the host
  await h.settle();
  h.fireOn(buttonNamed(h, 'Stop'), 'click');
  await h.settle(4);
  assert.deepEqual(h.entries().map((e) => e.text), ['Type "shoes" into the Search field']);
});

test('N15: a document with no title yet reports it once the parse is done', async () => {
  const h = rec({ title: '' });
  await h.settle();
  assert.deepEqual(h.titles(), []);
  assert.equal(h.winEvents().includes('DOMContentLoaded'), true);
  h.doc.title = 'Checkout';
  h.fireWin('DOMContentLoaded');
  await h.settle();
  assert.deepEqual(h.titles(), ['Checkout']);
});
