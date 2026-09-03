#!/usr/bin/env node
// extension/content/step-recorder.js, the outbox and the frames: which frame a step says it
// happened in, what leaves the queue and when, and the one frame that draws the pill.
// Run: node --test tests/step-recorder-outbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { load, el, HOST_ID, MODULES } from './helpers/recorder-harness.mjs';

// The page every row below clicks: one button, in the body, named by its own text.
function payNow(h) {
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  return btn;
}

const clickOnce = async (opts) => {
  const h = load(opts);
  await h.act(payNow(h), 'click');
  return h;
};

test('H1: the top frame writes a plain sentence, draws the pill, polls twice a second', async () => {
  const h = await clickOnce({ top: true });
  const [entry] = h.entries();
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.ctx.frame, undefined);
  assert.equal(h.host().id, HOST_ID);
  assert.equal(h.doc.body.contains(h.host()), true);
  assert.equal(h.pollDelay, 500);
  assert.deepEqual(h.titles(), ['Checkout']);
  assert.ok(h.winEvents().includes('resize'));
});

test('H2: the same click inside a frame says where it happened, and draws nothing', async () => {
  const h = await clickOnce({ top: false, hostname: 'checkout.example.com' });
  const [entry] = h.entries();
  assert.equal(entry.text, 'Click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(entry.ctx.frame, 'checkout.example.com');
  assert.equal(h.host(), null);
  assert.equal(h.pollDelay, 2000);
  assert.deepEqual(h.titles(), []); // a payment form's title is not where the tester navigated
  assert.ok(!h.winEvents().includes('resize'));
});

test('H3: an about:blank frame has no host to name, so it names none', async () => {
  const h = await clickOnce({ top: false, hostname: '' });
  const [entry] = h.entries();
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.ctx.frame, undefined);
  assert.equal(h.host(), null);
  assert.equal(h.pollDelay, 2000);
});

// A real double-click fires click, click, dblclick; the worker pops the twins by matching
// `replaces` to their text, so the clause has to land on both or the twins stay behind.
test('H4: a double click in a frame keeps `replaces` matched to the clicks it supersedes', async () => {
  const h = load({ top: false, hostname: 'checkout.example.com' });
  const btn = payNow(h);
  h.fire(btn, 'click');
  h.fire(btn, 'click');
  h.fire(btn, 'dblclick');
  h.flush();
  await h.settle();
  const entries = h.entries();
  assert.equal(entries.length, 3);
  const last = entries[2];
  assert.equal(last.text, 'Double-click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(last.replaces, 'Click the "Pay now" button in the "checkout.example.com" frame');
  assert.equal(last.replaces, entries[0].text);
});

test('H5: the top frame double click carries the clause on neither string', async () => {
  const h = load({ top: true });
  const btn = payNow(h);
  h.fire(btn, 'click');
  h.fire(btn, 'dblclick');
  h.flush();
  await h.settle();
  const entries = h.entries();
  const last = entries[1];
  assert.equal(last.text, 'Double-click the "Pay now" button');
  assert.equal(last.replaces, 'Click the "Pay now" button');
  assert.equal(last.replaces, entries[0].text);
});

// The pill lives in the top frame only, so a manual expectation can never originate inside a
// frame today. The rule it would meet if it could is that send() appends the clause to ANY
// entry text, the expected included — the seam that moves the pill must not change that.
test('H6: a frame has no pill, so no manual expectation can start there', async () => {
  const h = load({ top: false, hostname: 'checkout.example.com' });
  assert.equal(h.host(), null);
  assert.equal(h.shadow(), null);
  await h.act(payNow(h), 'click');
  assert.equal(h.entries().length, 1);
  assert.ok(h.entries()[0].text.endsWith(' in the "checkout.example.com" frame'));
});

test('H7: a frame with no title never waits for the page to finish loading', async () => {
  const top = load({ top: true, title: '' });
  const frame = load({ top: false, hostname: 'checkout.example.com', title: '' });
  assert.ok(top.winEvents().includes('DOMContentLoaded'));
  assert.ok(!frame.winEvents().includes('DOMContentLoaded'));
});

test('J1: nothing leaves while the packet window is still open', async () => {
  const h = load();
  h.fire(payNow(h), 'click');
  await h.settle();
  assert.deepEqual(h.entries(), []);
  assert.deepEqual(h.pending(), [400]);
});

test('J2: when the window closes, exactly one step leaves, packet and all', async () => {
  const h = load();
  await h.act(payNow(h), 'click');
  const entries = h.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Click the "Pay now" button');
  assert.equal(entries[0].ctx.action, 'click');
});

// The queue is one line, in arrival order: an expectation typed while the click's window is
// still open must not overtake the step it belongs to.
test('J3: an expectation typed mid-window is held until the step ahead of it leaves', async () => {
  const h = load();
  h.fire(payNow(h), 'click');
  await h.settle();

  const expectedBtn = [...h.box().children].find((n) => n.textContent === 'Expected');
  h.fireOn(expectedBtn, 'click');
  const input = h.box().querySelector('.exp-input');
  input.value = 'The receipt is shown';
  h.fireOn(h.shadow(), 'keydown', { key: 'Enter', target: input });
  await h.settle();

  assert.deepEqual(h.entries(), []); // still nothing: the click is ahead and not ready

  h.flush();
  await h.settle();
  const entries = h.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, 'Click the "Pay now" button');
  assert.equal(entries[1].text, 'The receipt is shown');
  assert.equal(entries[1].kind, 'expected');
});

test('J4: a page going away flushes the queue, and flushing twice sends nothing twice', async () => {
  const h = load();
  h.fire(payNow(h), 'click');
  await h.settle();
  h.fireWin('pagehide');
  await h.settle();
  assert.equal(h.entries().length, 1);
  h.fireWin('beforeunload');
  h.flush(); // the 400ms timer still fires afterwards; close() is idempotent
  await h.settle();
  assert.equal(h.entries().length, 1);
});

// Two guards stand between an empty expectation and the test: commitExpected refuses to queue
// one, and send() refuses to send one. Only the first is reachable — every recorded action
// writes a sentence, even for a control with no name — so the second is belt to this braces.
test('J6: an expectation typed as whitespace is never queued', async () => {
  const h = load();
  h.fire(payNow(h), 'click');
  await h.settle();
  const expectedBtn = [...h.box().children].find((n) => n.textContent === 'Expected');
  h.fireOn(expectedBtn, 'click');
  const input = h.box().querySelector('.exp-input');
  input.value = '   '; // whitespace only: commitExpected trims it to nothing
  h.fireOn(h.shadow(), 'keydown', { key: 'Enter', target: input });
  h.flush();
  await h.settle();
  assert.deepEqual(h.entries().map((e) => e.text), ['Click the "Pay now" button']);
});

test('J7: a sleeping worker loses no step and throws nothing at the page', async () => {
  const h = load({ reply: () => { throw new Error('worker asleep'); } });
  await h.act(payNow(h), 'click');
  assert.equal(h.entries().length, 1); // it was sent; only the reply failed
  assert.equal(h.box().querySelector('.txt').textContent, 'Recording · 0 steps');
});

// The worker answering "that recording is over" is how a stop from the panel reaches a page
// that never heard about it. Everything else in that reply is deliberately ignored.
test('J8: a reply saying the recording is over stops the recorder and ignores the rest of it', async () => {
  const h = load({ reply: () => ({ recording: false, count: 99, paused: true }) });
  const btn = payNow(h);
  await h.act(btn, 'click');
  assert.equal(h.entries().length, 1);
  assert.equal(h.box().querySelector('.txt').textContent, 'Recording · 0 steps'); // count not adopted

  await h.act(btn, 'click'); // nothing is watched any more
  assert.equal(h.entries().length, 1);
});

test('J9: the reply carries the count and the cap pause, and the pill says so', async () => {
  const h = load({ reply: () => ({ count: 7, paused: true, manualPause: false, recording: true }) });
  await h.act(payNow(h), 'click');
  assert.equal(h.box().querySelector('.txt').textContent, 'Still recording?');
  assert.ok([...h.box().children].some((n) => n.textContent === 'Continue'));
});

test('J10: an empty reply changes nothing', async () => {
  const h = load({ reply: () => undefined });
  await h.act(payNow(h), 'click');
  assert.equal(h.box().querySelector('.txt').textContent, 'Recording · 0 steps');
  assert.ok([...h.box().children].some((n) => n.textContent === 'Pause'));
});

// Injected files are evaluated again on a same-document re-inject, and the recorder's own latch
// runs last — so a module that throws on its second run takes the whole injection with it.
test('J11: injecting the modules a second time into the same page is a no-op', async () => {
  const h = load();
  await h.act(payNow(h), 'click');
  const before = h.entries().length;

  for (const m of MODULES) runInContext(readFileSync(m, 'utf8'), h.sandbox);

  await h.act(payNow(h), 'click');
  assert.equal(h.entries().length, before + 1); // still one recorder, still recording
  assert.equal(h.sandbox.RecMask.maskedAs({ type: 'password', value: 'x' }), 'the password');
});
