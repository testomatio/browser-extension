#!/usr/bin/env node
// The words of a step: what a click reads like, how the control gets its name, and the one clause
// the sentence carries about where it sits. Every row is one fixture and one action, read back as
// the sentence the tester will see in the test. Run: node --test tests/step-recorder-naming.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, el, text, HOST_ID } from './helpers/recorder-harness.mjs';

// Mount the fixture, act on the control, hand back the whole entry. `isConnected` and not
// `body.contains`: a control inside a component is already in the page, and moving it out is
// exactly the fixture the shadow-root rows are made of.
async function step(h, node, type = 'click', props = {}) {
  if (!node.isConnected) h.doc.body.append(node);
  await h.act(node, type, props);
  return h.entries()[0];
}

// The sentence alone, which is all most rows are about.
const say = async (h, node, type = 'click', props = {}) => (await step(h, node, type, props))?.text;

// A row that records nothing. An empty outbox proves nothing on its own, so the same page then
// records an ordinary click: the silence is the fixture's, not the harness's.
async function assertSilent(h, node, props = {}) {
  if (!h.doc.body.contains(node)) h.doc.body.append(node);
  await h.act(node, 'click', props);
  assert.deepEqual(h.entries(), [], 'expected this control to record nothing');
  const control = el('button', null, 'Pay now');
  h.doc.body.append(control);
  await h.act(control, 'click');
  assert.deepEqual(h.entries().map((e) => e.text), ['Click the "Pay now" button']);
}

// ---- A: what a click sentence reads like -----------------------------------

test('A1: a button is clicked by the name it shows', async () => {
  const h = load();
  const entry = await step(h, el('button', null, 'Pay now'));
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.action, 'click');
  assert.equal(entry.name, 'Pay now');
});

test('A2: a link is a link, not a button', async () => {
  const h = load();
  assert.equal(await say(h, el('a', { href: '/d' }, 'Docs')), 'Click the "Docs" link');
});

test('A3: a button with nothing to name it keeps the bare noun', async () => {
  const h = load();
  const entry = await step(h, el('button'));
  assert.equal(entry.text, 'Click the button');
  assert.equal(entry.name, null);
});

test('A4: a tab is opened, not clicked', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'tab', 'aria-label': 'Details' })),
    'Open the "Details" tab');
});

test('A5: a nameless tab is still opened', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'tab' })), 'Open the tab');
});

test('A6: a menu item is chosen in the menu', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'menuitem' }, 'Rename')),
    'Choose "Rename" in the menu');
});

test('A7: an option is selected, with no noun after it', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'option' }, 'Hand Tools')), 'Select "Hand Tools"');
});

test('A8: an ARIA checkbox is toggled', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'checkbox' }, 'Bulk')),
    'Toggle the "Bulk" checkbox');
});

test('A9: an ARIA switch is toggled and says switch', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'switch' }, 'Dark mode')),
    'Toggle the "Dark mode" switch');
});

test('A10: an ARIA radio is an option a tester chooses', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'radio' }, 'Card')), 'Choose the "Card" option');
});

// role=button has no phrase of its own: it falls to the default branch, which is the same words.
test('A11: role=button reads exactly like a real button', async () => {
  const h = load();
  assert.equal(await say(h, el('div', { role: 'button' }, 'Save')), 'Click the "Save" button');
});

test('A12: a <summary> is a button to the tester, never a link', async () => {
  const h = load();
  assert.equal(await say(h, el('summary', null, 'Details')), 'Click the "Details" button');
});

test('A13: a double click supersedes the exact single-click text it follows', async () => {
  const h = load();
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  h.fire(btn, 'click');
  h.fire(btn, 'click');
  h.fire(btn, 'dblclick');
  h.flush();
  await h.settle();
  const entries = h.entries();
  assert.equal(entries.length, 3);
  assert.equal(entries[2].text, 'Double-click the "Pay now" button');
  assert.equal(entries[2].replaces, 'Click the "Pay now" button');
  assert.equal(entries[2].replaces, entries[0].text);
});

// The noun a role is double-clicked by is not the verb it is clicked by: "tab" both times, but
// `Open the …` is what has to be popped.
test('A14: a double-clicked tab keeps the tab noun and replaces the Open sentence', async () => {
  const h = load();
  const entry = await step(h, el('div', { role: 'tab', 'aria-label': 'Details' }), 'dblclick');
  assert.equal(entry.text, 'Double-click the "Details" tab');
  assert.equal(entry.replaces, 'Open the "Details" tab');
});

test('A15: a double-clicked menu item reads as two words, not one', async () => {
  const h = load();
  const entry = await step(h, el('div', { role: 'menuitem' }, 'Rename'), 'dblclick');
  assert.equal(entry.text, 'Double-click the "Rename" menu item');
  assert.equal(entry.replaces, 'Choose "Rename" in the menu');
});

test('A16: clicking a text field is focus noise, not a step', async () => {
  const h = load();
  await assertSilent(h, el('input', { type: 'text' }));
});

test('A17: neither a <select> nor the option inside it records a click', async () => {
  const h = load();
  const opt = el('option', null, 'Large');
  const sel = el('select', null, opt);
  await assertSilent(h, sel);
  const h2 = load();
  h2.doc.body.append(el('select', null, opt.cloneNode(true)));
  await assertSilent(h2, h2.doc.body.querySelector('option'));
});

test('A18: a native checkbox records on change, so its click says nothing', async () => {
  const h = load();
  await assertSilent(h, el('input', { type: 'checkbox' }));
});

test('A19: a bare <div> with no clickable ancestor records nothing', async () => {
  const h = load();
  await assertSilent(h, el('div', null, 'Just some copy'));
});

test('A20: a click on the label inside a button is promoted to the button', async () => {
  const h = load();
  const span = el('span', null, 'Pay now');
  h.doc.body.append(el('button', null, span));
  assert.equal(await say(h, span), 'Click the "Pay now" button');
});

test('A21: a role wrapper around a real checkbox leaves the step to the change', async () => {
  const h = load();
  await assertSilent(h, el('div', { role: 'checkbox' }, el('input', { type: 'checkbox' })));
});

// The plain-<label> half of this is dead code: LABEL is not in CLICK_SEL, so `closest` never
// returns one and the LABEL guard is only ever reached through a role.
test('A22: a label wrapping a checkbox forwards its click and records nothing', async () => {
  const h = load();
  await assertSilent(h, el('label', { role: 'button' }, text('Bulk'), el('input', { type: 'checkbox' })));
  const h2 = load();
  await assertSilent(h2, el('label', null, text('Bulk'), el('input', { type: 'checkbox' })));
});

test('A23: once the worker says it stopped, the next click is not a step', async () => {
  const h = load({ reply: () => ({ recording: false }) });
  const btn = el('button', null, 'Pay now');
  h.doc.body.append(btn);
  await h.act(btn, 'click');
  assert.deepEqual(h.entries().map((e) => e.text), ['Click the "Pay now" button']);
  await h.act(btn, 'click');
  assert.equal(h.entries().length, 1);
});

test('A24: a click that composed out of the pill is the pill, not the page', async () => {
  const h = load();
  const btn = el('button', null, 'Stop');
  await assertSilent(h, btn, { composedPath: () => [btn, h.host()] });
});

test('A25: a target carrying the pill id is ignored whatever the path says', async () => {
  const h = load();
  // A button anywhere else in the page: only the id keeps it out of the recording.
  await assertSilent(h, el('button', { id: HOST_ID }, 'Impostor'));
});

// The class of ARIA widgets a SPA builds out of <div>s. Without them in CLICK_SEL a tester
// clicking a combobox or a tree item got a recording with a hole in it.
test('A26: a combobox, link, slider or treeitem role records a step', async () => {
  for (const role of ['combobox', 'link', 'slider', 'treeitem']) {
    const h = load();
    assert.ok(await say(h, el('div', { role }, 'Country')), `${role} recorded nothing`);
  }
});

// Each of the seven has the verb a tester would write by hand, and the bare-noun form when
// there is nothing to name it by.
test('A27: every custom-control role reads as the widget it is, named or not', async () => {
  const rows = [
    ['link', 'Click the "Country" link', 'Click the link'],
    ['combobox', 'Open the "Country" dropdown', 'Open the dropdown'],
    ['listbox', 'Open the "Country" list', 'Open the list'],
    ['slider', 'Click the "Country" slider', 'Click the slider'],
    ['spinbutton', 'Click the "Country" spinner', 'Click the spinner'],
    ['treeitem', 'Select "Country" in the tree', 'Select the tree item'],
    ['gridcell', 'Click the "Country" cell', 'Click the cell'],
  ];
  for (const [role, named, bare] of rows) {
    assert.equal(await say(load(), el('div', { role }, 'Country')), named, role);
    assert.equal(await say(load(), el('div', { role })), bare, `${role}, nameless`);
  }
});

// ---- B: the naming ladder --------------------------------------------------

test('B1: an aria-label beats the text the control shows', async () => {
  const h = load();
  assert.equal(await say(h, el('button', { 'aria-label': 'Close' }, '×')),
    'Click the "Close" button');
});

test('B2: aria-labelledby names the field from the element it points at', async () => {
  const h = load();
  h.doc.body.append(el('h1', { id: 'h1' }, 'Billing'));
  const entry = await step(h, el('input', { 'aria-labelledby': 'h1', value: 'Acme Ltd' }), 'blur');
  assert.equal(entry.text, 'Type "Acme Ltd" into the Billing field');
  assert.equal(entry.name, 'Billing');
});

// The spec-legal multi-id form is looked up as ONE id, finds nothing, and the ladder walks past it.
test('B3: aria-labelledby with two ids names nothing', async () => {
  const h = load();
  h.doc.body.append(el('span', { id: 'a' }, 'Billing'), el('span', { id: 'b' }, 'address'));
  const entry = await step(h, el('input', { 'aria-labelledby': 'a b', value: 'Acme Ltd' }), 'blur');
  assert.equal(entry.text, 'Type "Acme Ltd" into the Billing address field');
});

// getElementById only ever searches the light DOM, so an id reused inside a component is answered
// by whatever unrelated node happens to hold it in the page.
test('B4: a labelled control in a shadow root borrows a light-DOM id', async () => {
  const h = load();
  h.doc.body.append(el('h1', { id: 'lbl' }, 'Recent orders'));
  const comp = el('div');
  h.doc.body.append(comp);
  const root = comp.attachShadow({ mode: 'open' });
  const field = el('input', { 'aria-labelledby': 'lbl', value: 'Leave at door' });
  root.append(el('span', { id: 'lbl' }, 'Delivery notes'), field);
  assert.equal(await say(h, field, 'blur'), 'Type "Leave at door" into the Delivery notes field');
});

test('B5: a product card is named by its heading, not by its whole text', async () => {
  const h = load();
  const card = el('button', null,
    el('h3', null, 'Adjustable Wrench'),
    el('span', { className: 'badge' }, 'ABCDE'),
    el('span', null, '$20.33'));
  assert.equal(await say(h, card), 'Click the "Adjustable Wrench" button');
});

test('B6: with no heading the card borrows the alt text of its image', async () => {
  const h = load();
  const card = el('button', null,
    el('img', { alt: 'Wrench' }),
    el('span', { className: 'badge' }, 'ABCDE'),
    el('span', null, '$20.33'));
  assert.equal(await say(h, card), 'Click the "Wrench" button');
});

test('B7: a control whose only text is chrome falls through to the ladder', async () => {
  const h = load();
  const btn = el('button', { id: 'save' }, el('i', { className: 'icon-badge' }, 'shopping_cart'));
  assert.equal(await say(h, btn), 'Click the "save" button');
});

test('B8: a submit input is named by its value', async () => {
  const h = load();
  assert.equal(await say(h, el('input', { type: 'submit', value: 'Send' })),
    'Click the "Send" button');
});

test('B9: a <label for> names the field it points at', async () => {
  const h = load();
  h.doc.body.append(el('label', { htmlFor: 'e' }, 'Email'));
  h.doc.body.querySelector('label').setAttribute('for', 'e');
  assert.equal(await say(h, el('input', { id: 'e', value: 'john' }), 'blur'),
    'Type "john" into the Email field');
});

test('B10: a wrapping label drops the control it wraps before naming it', async () => {
  const h = load();
  const opt = el('option', { selected: true }, 'US');
  const sel = el('select', null, opt);
  h.doc.body.append(el('label', null, text('Country '), sel));
  assert.equal(await say(h, sel, 'change'), 'Select "US" in the Country dropdown');
});

// The label[for] lookup runs against `document`, so a component's field is named by a page-level
// label that was never meant for it.
test('B11: label[for] crosses out of a shadow root', async () => {
  const h = load();
  const stray = el('label', null, 'Recent orders');
  stray.setAttribute('for', 'note');
  h.doc.body.append(stray);
  const comp = el('div');
  h.doc.body.append(comp);
  const root = comp.attachShadow({ mode: 'open' });
  const field = el('input', { id: 'note', placeholder: 'Delivery notes', value: 'Leave at door' });
  root.append(field);
  assert.equal(await say(h, field, 'blur'), 'Type "Leave at door" into the Delivery notes field');
});

test('B12: a placeholder names a field that has nothing else', async () => {
  const h = load();
  assert.equal(await say(h, el('input', { placeholder: 'Search products', value: 'shoes' }), 'blur'),
    'Type "shoes" into the Search products field');
});

// An icon-only button a human reads by its tooltip records as nameless: `title` rides along in the
// packet and is never consulted by the ladder.
test('B13: a title attribute never names the control', async () => {
  const h = load();
  assert.equal(await say(h, el('button', { title: 'Delete row' })), 'Click the "Delete row" button');
});

test('B14: a nameless cell control is named by its column header, over its own dev strings', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true, name: 'bulk_42', id: 'row-42-bulk' });
  h.doc.body.append(el('table', null,
    el('thead', null, el('tr', null, el('th', null, 'Bulk'))),
    el('tbody', null, el('tr', null, el('td', null, box)))));
  const entry = await step(h, box, 'change');
  assert.equal(entry.text, 'Check the Bulk checkbox');
  assert.equal(entry.name, 'Bulk');
});

test('B15: a nameless control in a named row is named by the row, not by a dev string', async () => {
  const h = load();
  const btn = el('button', { name: 'del', id: 'row-42-del' });
  h.doc.body.append(el('ul', null, el('li', null, el('span', null, 'Bolt Cutters'), btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the button in the "Bolt Cutters" row');
  assert.equal(entry.name, null);
});

test('B16: with nothing else at all, the name attribute is the last readable thing', async () => {
  const h = load();
  assert.equal(await say(h, el('button', { name: 'q' })), 'Click the "q" button');
});

test('B17: and after that, the id', async () => {
  const h = load();
  assert.equal(await say(h, el('button', { id: 'tab-details' })), 'Click the "tab-details" button');
});

test('B18: nothing at all leaves the bare noun', async () => {
  const h = load();
  assert.equal(await say(h, el('button')), 'Click the button');
});

// The cut used to keep the space it landed on and add nothing, so a truncated value read as a
// complete one and a tester comparing it to the field saw a mismatch they could not explain.
test('B19: a truncated value says it was cut', async () => {
  const h = load();
  const long = 'The quick brown fox jumps over the lazy dog';
  const entry = await step(h, el('input', { 'aria-label': 'Note', value: long }), 'blur');
  assert.equal(entry.text, 'Type "The quick brown fox jumps over the lazy…" into the Note field');
});

test('B20: a name broken over lines is collapsed to one', async () => {
  const h = load();
  assert.equal(await say(h, el('button', { 'aria-label': 'Pay\n  now' })),
    'Click the "Pay now" button');
});

// trim40 slices UTF-16 code units, so a 40-boundary that lands inside a surrogate pair ships half
// a character into the step text.
test('B21: a name cut at an astral emoji ships half a character', async () => {
  const h = load();
  const stem = 'Send the receipt to the billing contact'; // 39 units: the emoji straddles the cut
  const entry = await step(h, el('button', { 'aria-label': `${stem}\u{1F600}` }));
  assert.equal(entry.name, `${stem}\u{1F600}`);
});

test('B22: a script body and an aria-hidden glyph are not part of the name', async () => {
  const h = load();
  const btn = el('button', null,
    el('script', null, 'alert(1)'),
    el('span', { 'aria-hidden': 'true' }, '×'),
    text('Pay now'));
  assert.equal(await say(h, btn), 'Click the "Pay now" button');
});

test('B23: "countdown" is a word, not a badge class', async () => {
  const h = load();
  const kept = el('button', null, el('span', { className: 'countdown' }, '3'), text(' days left'));
  assert.equal(await say(h, kept), 'Click the "3 days left" button');
  const h2 = load();
  const dropped = el('button', null, el('span', { className: 'count' }, '3'), text(' days left'));
  assert.equal(await say(h2, dropped), 'Click the "days left" button');
});

// ---- C: the clause the sentence carries ------------------------------------

test('C1: a control in a table row says which row', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('table', null, el('tr', null,
    el('td', null, 'Bolt Cutters'), el('td', null, btn))));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "Bolt Cutters" row');
  assert.deepEqual(entry.context, { row: 'Bolt Cutters' });
});

test('C2: a list item is a row too', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('ul', null, el('li', null, el('strong', null, 'Products'), btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "Products" row');
  assert.deepEqual(entry.context, { row: 'Products' });
});

test('C3: a row that only repeats the control name is dropped', async () => {
  const h = load();
  const btn = el('button', null, 'products');
  h.doc.body.append(el('ul', null, el('li', null, el('strong', null, 'Products'), btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "products" button');
  assert.equal(entry.context, null);
  assert.equal(entry.ctx.near.row, 'Products'); // read, then dropped — not a walk that found nothing
});

test('C4: with both a row and a section, the packet keeps both and the sentence takes the row', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('fieldset', null,
    el('legend', null, 'Payment'),
    el('ul', null, el('li', null, el('strong', null, 'Bolt Cutters'), btn))));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "Bolt Cutters" row');
  assert.deepEqual(entry.context, { row: 'Bolt Cutters', section: 'Payment' });
});

test('C5: with no row, the section speaks', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('fieldset', null, el('legend', null, 'Payment'), btn));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "Payment" section');
  assert.deepEqual(entry.context, { section: 'Payment' });
});

// The section walk takes the nearest heading BEFORE the element, wherever it belongs: in a flat
// grid that is the previous card's heading, and the step claims a section it is not in.
test('C6: a flat card grid borrows the previous card heading', async () => {
  const h = load();
  const btn = el('button', null, 'Subscribe to updates');
  h.doc.body.append(el('div', { className: 'grid' },
    el('h2', null, 'Recent orders'),
    el('div', { className: 'card' }, el('span', null, 'Order 1042')),
    el('div', { className: 'promo' }, btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Subscribe to updates" button');
  assert.equal(entry.context, null);
});

// Five order rows keyed only by their number produce five identical steps, and nothing in the
// recording says which row was clicked.
test('C7: a row keyed by a number alone names nothing', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('table', null, el('tr', null,
    el('td', null, '1042'), el('td', null, btn))));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "1042" row');
  assert.deepEqual(entry.context, { row: '1042' });
});

// An unclassed counter rides into the row name, so the step goes stale the moment the count moves.
test('C8: an unclassed counter is kept in the row title', async () => {
  const h = load();
  const btn = el('button', null, 'Open');
  h.doc.body.append(el('ul', null, el('li', null, text('Products '), el('span', null, '(12)'), btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Open" button in the "Products" row');
  assert.deepEqual(entry.context, { row: 'Products' });
});

// cellIndex is the cell's index in its own row, so one colspan in the header shifts every mapping
// after it — and the wrong header then NAMES the control.
test('C9: a colspan header names the control after the wrong column', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true });
  const head = el('tr', null, el('th', { colspan: '2' }, 'Item'), el('th', null, 'Bulk'), el('th', null, 'Notes'));
  h.doc.body.append(el('table', null,
    el('thead', null, head),
    el('tbody', null, el('tr', null,
      el('td', null, 'Wrench'), el('td', null, '$20.33'), el('td', null, box), el('td', null, '-')))));
  const entry = await step(h, box, 'change');
  assert.equal(entry.text, 'Check the Bulk checkbox in the "Wrench" row');
  assert.equal(entry.name, 'Bulk');
});

test('C10: a header cell in the clicked row is not that row own column header', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true });
  h.doc.body.append(el('table', null, el('tr', null,
    el('th', null, 'Bulk'), el('td', null, box))));
  const entry = await step(h, box, 'change');
  assert.equal(entry.text, 'Check the checkbox in the "Bulk" row');
  assert.deepEqual(entry.context, { row: 'Bulk' });
});

test('C11: a control sitting in a <th> takes no column', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true });
  h.doc.body.append(el('table', null,
    el('thead', null, el('tr', null, el('th', null, 'Select'), el('th', null, 'Item'))),
    el('tbody', null, el('tr', null, el('th', null, box), el('td', null, 'Wrench')))));
  const entry = await step(h, box, 'change');
  assert.equal(entry.text, 'Check the checkbox in the "Wrench" row');
  assert.deepEqual(entry.context, { row: 'Wrench' });
});

test('C12: a page whose closest() throws loses the surroundings, never the step', async () => {
  const h = load();
  const btn = el('button', null, 'Pay now');
  const real = btn.closest.bind(btn);
  // A hostile page: only the selectors the click gate needs are answered, the rest throw.
  btn.closest = (sel) => {
    if (sel.includes('button')) return real(sel);
    if (sel === 'select') return null;
    throw new Error('hostile');
  };
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Pay now" button');
  assert.equal(entry.context, null);
  assert.deepEqual(entry.ctx.near,
    { label: '', row: '', column: '', section: '', heading: '', siblings: '' });
});

test('C13: a column is kept in the packet and stays out of the sentence', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true });
  h.doc.body.append(el('table', null,
    el('thead', null, el('tr', null, el('th', null, 'Bulk'))),
    el('tbody', null, el('tr', null, el('td', null, box)))));
  const entry = await step(h, box, 'change');
  assert.deepEqual(entry.context, { column: 'Bulk' });
  assert.equal(entry.text, 'Check the Bulk checkbox');
});

test('C14: the cell that merely holds the control never names the row', async () => {
  const h = load();
  const btn = el('button', null, 'Delete');
  h.doc.body.append(el('table', null, el('tr', null,
    el('td', null, btn), el('td', null, 'Wrench'))));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Delete" button in the "Wrench" row');
  assert.deepEqual(entry.context, { row: 'Wrench' });
});

test('C15: a row of running text is a title only while it is short enough to be one', async () => {
  const h = load();
  const btn = el('button', null, 'Open');
  const long = 'A tidy boxed wrench and spanner set for the home workshop, barely used';
  h.doc.body.append(el('ul', null, el('li', null, el('span', null, long), btn)));
  const entry = await step(h, btn);
  assert.equal(entry.text, 'Click the "Open" button');
  assert.equal(entry.context, null);

  const h2 = load();
  const btn2 = el('button', null, 'Open');
  h2.doc.body.append(el('ul', null, el('li', null, el('span', null, 'Wrench and spanner set'), btn2)));
  const entry2 = await step(h2, btn2);
  assert.equal(entry2.text, 'Click the "Open" button in the "Wrench and spanner set" row');
  assert.deepEqual(entry2.context, { row: 'Wrench and spanner set' });
});

// Added in review: raising the 40-character cut broke no test, so the cut itself was never
// pinned. A step is a sentence a person reads, and a control whose label is a paragraph would
// otherwise carry the paragraph into the test. The ellipsis is part of the forty.
test('B24: a long name is cut to forty characters, and says so', async () => {
  const h = load();
  const btn = el('button', null, 'Confirm and place the order for all seventeen items');
  h.doc.body.append(btn);
  await h.act(btn, 'click');
  const text = h.entries()[0].text;
  assert.equal(text, 'Click the "Confirm and place the order for all sev…" button');
  assert.equal(text.replace(/^Click the "|" button$/g, '').length, 40);
});
