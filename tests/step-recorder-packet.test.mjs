#!/usr/bin/env node
// The action packet: what a reader — a tester, or the AI polish in the editor — is given besides
// the sentence. The control's own facts and its surroundings are read at event time; `after` is
// what the page made of the action, read 400ms later. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, el, text } from './helpers/recorder-harness.mjs';

// Every packet case is one click on one control, so the fixture is always the same two lines.
async function clickOn(h, node, before) {
  h.doc.body.append(node);
  if (before) before();
  h.fire(node, 'click');
  await h.settle();
  return node;
}

// Fire, let the page do whatever the case says it does, then close the 400ms window.
async function closeWindow(h, during) {
  if (during) await during();
  h.flush();
  await h.settle();
}

const ctxOf = (h, i = 0) => h.entries()[i].ctx;

test('I1: the packet a plain button produces, field for field', async () => {
  const h = load();
  const btn = el('button', { id: 'payBtn', title: 't', name: 'n' }, 'Pay now');
  await clickOn(h, btn);
  // The page gets exactly 400ms to react, and the entry waits that long before it leaves.
  assert.deepEqual(h.pending(), [400]);
  assert.deepEqual(h.entries(), []);
  await closeWindow(h);

  assert.deepEqual(ctxOf(h), {
    action: 'click',
    element: {
      tag: 'button', role: '', type: '', text: 'Pay now', ariaLabel: '', title: 't',
      placeholder: '', name: 'n', id: 'payBtn', class: '', icon: '',
    },
    near: { label: '', row: '', column: '', section: '', heading: '', siblings: '' },
    page: { title: 'Checkout', url: 'https://example.com/pay' },
    after: { url: 'unchanged', title: 'unchanged', toast: '', dialog: '', state: '', counter: '' },
  });
});

test('I2: the page URL drops the query, the fragment and any user:pass@ it carries', async () => {
  const h = load({ href: 'https://u:p@example.com/pay?t=1#x' });
  await clickOn(h, el('button', null, 'Pay now'));
  await closeWindow(h);
  assert.equal(ctxOf(h).page.url, 'https://example.com/pay');
});

// A hash-routed app moves the tester to a new screen and the packet says nothing happened.
test.todo('I3: a hash-only route change is lost — after.url stays "unchanged" (#220)', async () => {
  const h = load({ href: 'https://example.com/app#/cart' });
  await clickOn(h, el('button', null, 'Next'));
  await closeWindow(h, () => { h.location.href = 'https://example.com/app#/checkout'; });
  assert.equal(ctxOf(h).after.url, 'https://example.com/app#/cart → https://example.com/app#/checkout');
});

test('I4: a real navigation inside the window is reported as one arrow', async () => {
  const h = load({ href: 'https://example.com/pay' });
  await clickOn(h, el('button', null, 'Pay now'));
  await closeWindow(h, () => { h.location.href = 'https://example.com/thanks'; });
  assert.equal(ctxOf(h).after.url, 'https://example.com/pay → https://example.com/thanks');
});

test('I5: a title change inside the window is reported the same way', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Pay now'));
  await closeWindow(h, () => { h.doc.title = 'Thanks'; });
  assert.equal(ctxOf(h).after.title, 'Checkout → Thanks');
});

test('I6: a toast appended empty and filled a tick later is read filled, not empty', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Pay now'));
  const toast = el('div', { role: 'status' });
  await closeWindow(h, async () => {
    h.doc.body.append(toast);
    h.mutate(toast);            // the node is kept, not read
    toast.textContent = 'Saved'; // filled after the observer saw it
  });
  assert.equal(ctxOf(h).after.toast, 'Saved');
});

test('I7: a modal appended inside the window carries its text as the dialog half', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Delete'));
  const modal = el('div', { className: 'modal-body' }, 'Are you sure?');
  await closeWindow(h, () => { h.doc.body.append(modal); h.mutate(modal); });
  const ctx = ctxOf(h);
  assert.equal(ctx.after.dialog, 'Are you sure?');
  assert.equal(ctx.after.toast, '');
});

test('I8: an aria-invalid field reports the message it points at, not its own text', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Sign in'));
  const err = el('span', { id: 'err' }, 'Wrong password');
  const field = el('input', { 'aria-invalid': 'true' });
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', 'err');
  await closeWindow(h, () => { h.doc.body.append(field, err); h.mutate(field); });
  assert.equal(ctxOf(h).after.dialog, 'Wrong password');
});

test('I9: with nothing to point at, the line right after the field is the message', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Sign in'));
  const field = el('input');
  field.setAttribute('aria-invalid', 'true');
  const next = el('span', null, 'Enter your password');
  await closeWindow(h, () => { h.doc.body.append(el('div', null, field, next)); h.mutate(field); });
  assert.equal(ctxOf(h).after.dialog, 'Enter your password');
});

test('I10: a node that is both a toast and an alert stays a toast', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Save'));
  const both = el('div', { className: 'toast alert-danger' }, 'Could not save');
  await closeWindow(h, () => { h.doc.body.append(both); h.mutate(both); });
  const ctx = ctxOf(h);
  assert.equal(ctx.after.toast, 'Could not save');
  assert.equal(ctx.after.dialog, '');
});

test('I11: at most five notes are kept, and the first of each kind wins', async () => {
  const h = load();
  await clickOn(h, el('button', null, 'Save'));
  const notes = [
    el('div', { role: 'status' }, 'first toast'),
    el('div', { role: 'status' }, 'second toast'),
    el('div', { className: 'modal' }, 'first modal'),
    el('div', { className: 'modal' }, 'second modal'),
    el('div', { role: 'status' }, 'third toast'),
    el('div', { className: 'modal' }, 'sixth note'),
    el('div', { role: 'status' }, 'seventh note'),
  ];
  await closeWindow(h, () => { for (const n of notes) { h.doc.body.append(n); h.mutate(n); } });
  const ctx = ctxOf(h);
  assert.equal(ctx.after.toast, 'first toast');
  assert.equal(ctx.after.dialog, 'first modal');
});

test('I12: with no MutationObserver the packet says nothing and the step still records', async () => {
  const h = load({ noObserver: true });
  await clickOn(h, el('button', null, 'Save'));
  const toast = el('div', { role: 'status' }, 'Saved');
  await closeWindow(h, () => { h.doc.body.append(toast); });
  const entry = h.entries()[0];
  assert.equal(entry.text, 'Click the "Save" button');
  assert.equal(entry.ctx.after.toast, '');
  assert.equal(entry.ctx.after.dialog, '');
});

test('I13: a state attribute that moved is reported as an arrow', async () => {
  const h = load();
  const box = el('div', { role: 'checkbox' }, 'Bulk');
  box.setAttribute('aria-checked', 'false');
  await clickOn(h, box);
  await closeWindow(h, () => { box.setAttribute('aria-checked', 'true'); });
  assert.equal(ctxOf(h).after.state, 'aria-checked: false → true');
});

// A control that loses `aria-expanded` or `disabled` reports nothing: the diff walks the keys
// of the "after" state only, so a key that disappeared is never compared.
test.todo('I14: a state key that disappears is not reported (#221)', async () => {
  const h = load();
  const box = el('div', { role: 'checkbox' }, 'Bulk');
  box.setAttribute('aria-expanded', 'true');
  await clickOn(h, box);
  await closeWindow(h, () => { box.removeAttribute('aria-expanded'); });
  assert.equal(ctxOf(h).after.state, 'aria-expanded: true → ');
});

// A key the control gains reads with two spaces where the old value would have been.
test.todo('I15: a state key that appears prints a double space (#222)', async () => {
  const h = load();
  const box = el('div', { role: 'checkbox' }, 'Bulk');
  await clickOn(h, box);
  await closeWindow(h, () => { box.setAttribute('aria-expanded', 'true'); });
  assert.equal(ctxOf(h).after.state, 'aria-expanded: → true');
});

test('I16: a badge near the control that changed is reported as an arrow', async () => {
  const h = load();
  const badge = el('span', { className: 'badge' }, '2');
  const btn = el('button', null, text('Cart'), badge);
  await clickOn(h, btn);
  await closeWindow(h, () => { badge.textContent = '3'; });
  const ctx = ctxOf(h);
  assert.equal(ctx.after.counter, '2 → 3');
  assert.equal(ctx.element.text, 'Cart'); // the badge is chrome, never part of the name
});

test('I17: over the cap, fields go in the documented order and never out of it', async () => {
  // The order fitPacket promises: siblings and class are dropped outright, then the long
  // strings are trimmed to 24, left to right.
  const TRIMS = [
    ['element', 'text'], ['after', 'toast'], ['after', 'dialog'], ['element', 'ariaLabel'],
    ['element', 'title'], ['near', 'heading'], ['near', 'section'], ['near', 'row'], ['page', 'title'],
  ];
  // 900 lands the packet at 1496 bytes — inside the cap, and well over half of it, so a cap
  // quietly halved would show here. Past that the overflow grows and fitPacket reaches deeper.
  for (const width of [0, 900, 1600, 3000, 6000]) {
    const h = load();
    const btn = el('button', {
      className: 'btn btn-primary btn-lg extra',
      title: 'T'.repeat(100),
    }, 'Pay now the long way round for a while');
    btn.setAttribute('aria-label', 'A'.repeat(width));
    const row = el('li', null, el('span', null, 'Bolt Cutters'), btn, el('span', null, 'in stock'));
    h.doc.body.append(el('ul', null, row));
    h.fire(btn, 'click');
    await h.settle();
    await closeWindow(h);
    const ctx = ctxOf(h);

    if (width <= 900) { // inside the cap: nothing is touched at all
      assert.ok(JSON.stringify(ctx).length <= 1500, `over the cap at width ${width}`);
      assert.equal(ctx.near.siblings, 'Bolt Cutters | in stock');
      assert.equal(ctx.element.class, 'btn btn-primary btn-lg');
      assert.equal(ctx.element.title.length, 100);
      continue;
    }
    // Both outright drops happen before any trim, every time.
    assert.equal(ctx.near.siblings, '', `siblings survived at width ${width}`);
    assert.equal(ctx.element.class, '', `class survived at width ${width}`);
    // And the trims form a PREFIX of the list: field n trimmed means every earlier one is too.
    const trimmed = TRIMS.map(([g, k]) => {
      const v = ctx[g][k];
      return typeof v === 'string' && v.length > 0 && v.length <= 24;
    });
    const firstUntouched = trimmed.indexOf(false);
    if (firstUntouched >= 0) {
      const after = trimmed.slice(firstUntouched).filter(Boolean);
      // A later field trimmed while an earlier one is whole means the order was not honoured.
      const untouchedIsEmpty = TRIMS.slice(firstUntouched).some(([g, k]) => !ctx[g][k]);
      assert.ok(after.length === 0 || untouchedIsEmpty, `out of order at width ${width}`);
    }
    if (width === 4000) assert.equal(ctx.element.ariaLabel.length, 24);
  }
});

// The prefix check above proves nothing was trimmed out of turn; these two prove the turns
// themselves, by sizing the overflow so that exactly one more field has to give way. The two
// name lengths were measured against the real source — a fixture change moves them.
test('I17b: the trims happen left to right — text, then aria-label, then title', async () => {
  const build = (nameLen) => {
    const h = load();
    const btn = el('button', {
      className: 'btn btn-primary btn-lg',
      title: 'T'.repeat(100),
      name: 'N'.repeat(nameLen), // never trimmed itself, so it is the dial that sets the overflow
    }, 'Pay now the long way round for a while');
    btn.setAttribute('aria-label', 'A'.repeat(200));
    h.doc.body.append(el('ul', null, el('li', null, el('span', null, 'Bolt Cutters'), btn, el('span', null, 'in stock'))));
    return { h, btn };
  };

  // Barely over: dropping the siblings alone is enough, so the classes are still there.
  const tiny = build(715);
  tiny.h.fire(tiny.btn, 'click');
  await tiny.h.settle();
  tiny.h.flush();
  await tiny.h.settle();
  const z = ctxOf(tiny.h);
  assert.equal(z.near.siblings, '');
  assert.equal(z.element.class, 'btn btn-primary btn-lg');
  assert.equal(z.element.text.length, 38);

  // Just over: the two drops plus the text trim are enough, so both long attributes survive.
  const small = build(760);
  small.h.fire(small.btn, 'click');
  await small.h.settle();
  small.h.flush();
  await small.h.settle();
  const a = ctxOf(small.h);
  assert.equal(a.element.text.length, 24);
  assert.equal(a.element.ariaLabel.length, 200);
  assert.equal(a.element.title.length, 100);

  // Further over: the aria-label goes next and the title is still not reached.
  const big = build(800);
  big.h.fire(big.btn, 'click');
  await big.h.settle();
  big.h.flush();
  await big.h.settle();
  const b = ctxOf(big.h);
  assert.equal(b.element.text.length, 24);
  assert.equal(b.element.ariaLabel.length, 24);
  assert.equal(b.element.title.length, 100);
});

test('I18: a page that throws while the packet is built still gets its step', async () => {
  const h = load();
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  // A hostile page: reading the title is what armPacket does first, and it throws.
  Object.defineProperty(h.doc, 'title', { get() { throw new Error('hostile'); }, configurable: true });
  h.fire(btn, 'click');
  await h.settle();
  const entry = h.entries()[0];
  assert.equal(entry.text, 'Click the "Pay now" button'); // shipped, and shipped at once
  assert.equal(entry.ctx, undefined);
  assert.deepEqual(h.pending(), []); // no window was ever armed
});

test('I19: an icon-only control borrows the alt text of its image', async () => {
  const h = load();
  const btn = el('button', null, el('img', { alt: 'Trash' }));
  await clickOn(h, btn);
  await closeWindow(h);
  assert.equal(ctxOf(h).element.icon, 'Trash');
});

test('I20: an svg title is an icon name too', async () => {
  const h = load();
  const btn = el('button', null, el('svg', null, el('title', null, 'Trash')));
  await clickOn(h, btn);
  await closeWindow(h);
  assert.equal(ctxOf(h).element.icon, 'Trash');
});

test('I21: a material icon ligature is read as the icon name', async () => {
  const h = load();
  const btn = el('button', null, el('i', { className: 'material-icons' }, 'delete'));
  await clickOn(h, btn);
  await closeWindow(h);
  assert.equal(ctxOf(h).element.icon, 'delete');
});

test('I22: only the first three classes are carried', async () => {
  const h = load();
  const btn = el('button', { className: 'btn btn-primary btn-lg extra' }, 'Pay now');
  await clickOn(h, btn);
  await closeWindow(h);
  assert.equal(ctxOf(h).element.class, 'btn btn-primary btn-lg');
});
