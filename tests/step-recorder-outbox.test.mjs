#!/usr/bin/env node
// extension/content/step-recorder.js, the outbox and the frames: which frame a step says it
// happened in, what leaves the queue and when, and the one frame that draws the pill.
// Run: node --test tests/step-recorder-outbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, el, HOST_ID } from './helpers/recorder-harness.mjs';

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
