#!/usr/bin/env node
// What the recorder writes when the tester ENTERS something: a typed value, an IME commit, a
// dropdown pick, a tick. This is the file that keeps a password, a card number or a security code
// out of a recorded test — every masked row here is a value that must never reach the editor.
//
// THE TRAP: flushType() and flushSelect() return early while the never-values flag is unread and
// re-enter through `flagRead.then(...)`, so a blur fired and flushed synchronously records NOTHING.
// Every typing and select row therefore goes through `await h.act(...)` and asserts the entry it
// expects, never an empty outbox on its own. Run: node --test tests/step-recorder-mask.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, el, text } from './helpers/recorder-harness.mjs';

// The control almost every row types into: one input in the body, named by whatever it carries.
function field(h, props, value) {
  const node = el('input', { ...props, value });
  h.doc.body.append(node);
  return node;
}

const texts = (h) => h.entries().map((e) => e.text);

// A dropdown with one option already picked, which is what a change event reports.
function dropdown(h, props, ...optionTexts) {
  const options = optionTexts.map((t, i) => el('option', { selected: i === 0 }, t));
  const node = el('select', props, ...options);
  h.doc.body.append(node);
  return node;
}

function ticked(h, type, props, checked) {
  const node = el('input', { ...props, type, checked });
  h.doc.body.append(node);
  return node;
}

// ---- D: typing, and the masking that decides whether the value is written at all ----

test('D1: an ordinary value is written into the step verbatim', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type "shoes" into the Search field');
  assert.deepEqual(entry.ctx.value, { text: 'shoes', masked: false });
});

test('D2: a password field is recorded as a noun, never as the password', async () => {
  const h = load();
  const input = field(h, { type: 'password', 'aria-label': 'Password' }, 'hunter2');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type the password into the Password field');
  assert.deepEqual(entry.ctx.value, { text: 'the password', masked: true });
});

// Nothing in this field's name says "card": 16 digits that pass Luhn are the whole signal.
test('D3: a Luhn-valid 16-digit run is masked even in a plainly named field', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Number' }, '4242 4242 4242 4242');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type the card number into the Number field');
  assert.deepEqual(entry.ctx.value, { text: 'the card number', masked: true });
});

test('D4: a security code is masked as "the value" — the noun is never a guess', async () => {
  const h = load();
  const input = field(h, { name: 'cvv' }, '123');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type the value into the cvv field');
  assert.deepEqual(entry.ctx.value, { text: 'the value', masked: true });
});

// The spec puts the field name after `section-*` and billing/shipping, so every token is tested.
test('D5: an autocomplete token behind section- and billing is still read', async () => {
  const h = load();
  const input = field(h, { autocomplete: 'section-blue billing cc-exp' }, '07/29');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type the value into the field');
  assert.deepEqual(entry.ctx.value, { text: 'the value', masked: true });
});

test('D6: with the never-values toggle on, an ordinary value is written as "text"', async () => {
  const h = load({ storage: { stepRecNeverValues: true } });
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type text into the Search field');
  assert.deepEqual(entry.ctx.value, { text: 'text', masked: true });
});

test('D7: under the toggle a password keeps its own noun', async () => {
  const h = load({ storage: { stepRecNeverValues: true } });
  const input = field(h, { type: 'password', 'aria-label': 'Password' }, 'hunter2');
  await h.act(input, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type the password into the Password field');
  assert.deepEqual(entry.ctx.value, { text: 'the password', masked: true });
});

test('D8: a field holding only whitespace is not a typed step', async () => {
  const h = load();
  const blank = field(h, { 'aria-label': 'Search' }, '   ');
  await h.act(blank, 'blur');
  assert.deepEqual(h.entries(), []);
  // The same recorder, still live: the next real value proves the silence above was the rule.
  const real = field(h, { 'aria-label': 'Email' }, 'john');
  await h.act(real, 'blur');
  assert.deepEqual(texts(h), ['Type "john" into the Email field']);
});

test('D9: Enter records the field the tester never left', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'keydown', { key: 'Enter' });
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('D10: blur then Enter on an unchanged value is one step, not two', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'blur');
  await h.act(input, 'keydown', { key: 'Enter' });
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('D11: a value that grew between two blurs is two steps', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'a');
  await h.act(input, 'blur');
  input.value = 'ab';
  await h.act(input, 'blur');
  assert.deepEqual(texts(h), [
    'Type "a" into the Search field',
    'Type "ab" into the Search field',
  ]);
});

// A wrong password then the right one used to record once, so a negative-path login read as if
// the first attempt had worked: every flush matched the one sentinel a masked field remembered.
test('D12: a masked field records both attempts, not just the first', async () => {
  const h = load();
  const input = field(h, { type: 'password', 'aria-label': 'Password' }, 'wrong');
  await h.act(input, 'blur');
  input.value = 'right';
  await h.act(input, 'blur');
  assert.deepEqual(texts(h), [
    'Type the password into the Password field',
    'Type the password into the Password field',
  ]);
});

// The other half of the same rule, and what the sentinel was there for: one attempt is one step
// however many events end it — the field is left untouched between the blur and the Enter.
test('D12b: blur then Enter on an unchanged masked value is one step, not two', async () => {
  const h = load();
  const input = field(h, { type: 'password', 'aria-label': 'Password' }, 'hunter2');
  await h.act(input, 'blur');
  await h.act(input, 'keydown', { key: 'Enter' });
  assert.deepEqual(texts(h), ['Type the password into the Password field']);
});

test('D13: a field with nothing to name it is still "the field"', async () => {
  const h = load();
  const input = field(h, {}, 'x');
  await h.act(input, 'blur');
  assert.deepEqual(texts(h), ['Type "x" into the field']);
});

// A step that beats the storage read waits for it rather than being recorded under a guess.
test('D14: a blur before the flag is read is deferred, not dropped', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  h.fire(input, 'blur');
  h.flush();
  await h.settle();
  assert.deepEqual(h.entries(), []); // the deferred call has run; its 400ms window is still open
  h.flush();
  await h.settle();
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('D15: with no readable storage the flag is off and the heuristics still run', async () => {
  for (const opts of [{ noStorage: true }, { storageFails: true }]) {
    const h = load(opts);
    const plain = field(h, { 'aria-label': 'Search' }, 'shoes');
    await h.act(plain, 'blur');
    const secret = field(h, { type: 'password', 'aria-label': 'Password' }, 'hunter2');
    await h.act(secret, 'blur');
    assert.deepEqual(texts(h), [
      'Type "shoes" into the Search field',       // the flag defaulted to off
      'Type the password into the Password field', // and masking is not the flag's job
    ], JSON.stringify(opts));
  }
});

test('D16: the toggle saved mid-recording takes effect on the next step', async () => {
  const h = load();
  const before = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(before, 'blur');
  h.changeFlag({ stepRecNeverValues: { newValue: true } });
  const after = field(h, { 'aria-label': 'Email' }, 'john');
  await h.act(after, 'blur');
  assert.deepEqual(texts(h), [
    'Type "shoes" into the Search field',
    'Type text into the Email field',
  ]);
});

test('D17: the same change in the sync area is not this flag', async () => {
  const h = load();
  const before = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(before, 'blur');
  h.changeFlag({ stepRecNeverValues: { newValue: true } }, 'sync');
  const after = field(h, { 'aria-label': 'Email' }, 'john');
  await h.act(after, 'blur');
  assert.deepEqual(texts(h), [
    'Type "shoes" into the Search field',
    'Type "john" into the Email field',
  ]);
});

// A slider, a colour and a file picker are entered values a tester would expect back.
test('D18: range, color and file inputs record a step', async () => {
  const h = load();
  for (const type of ['range', 'color', 'file']) {
    const input = field(h, { type, 'aria-label': 'Volume' }, '7');
    await h.act(input, 'change');
  }
  assert.equal(h.entries().length, 3);
});

// The filename comes from `files` when the page has one; a browser reports the value itself
// as `C:\fakepath\photo.png`, and only the last segment is a name a tester reads.
test('D18b: each of the three says what it was set to, and a nameless one keeps the noun', async () => {
  const h = load();
  await h.act(field(h, { type: 'range', 'aria-label': 'Volume' }, '7'), 'change');
  await h.act(field(h, { type: 'color', 'aria-label': 'Colour' }, '#ff0000'), 'change');
  const picked = field(h, { type: 'file', 'aria-label': 'Avatar' }, 'C:\\fakepath\\ignored.png');
  picked.files = [{ name: 'photo.png' }];
  await h.act(picked, 'change');
  await h.act(field(h, { type: 'file' }, 'C:\\fakepath\\scan.pdf'), 'change');
  await h.act(field(h, { type: 'range' }, '3'), 'change');
  assert.deepEqual(texts(h), [
    'Set the "Volume" slider to "7"',
    'Set the "Colour" picker to "#ff0000"',
    'Attach "photo.png" to the "Avatar" field',
    'Attach "scan.pdf" to the field',
    'Set the slider to "3"',
  ]);
  assert.deepEqual(h.entries()[0].ctx.value, { text: '7', masked: false });
});

// The toggle is the only rule these three answer to: a slider position is not a secret.
test('D18c: under the never-values toggle the three record no value at all', async () => {
  const h = load({ storage: { stepRecNeverValues: true } });
  await h.act(field(h, { type: 'range', 'aria-label': 'Volume' }, '7'), 'change');
  await h.act(field(h, { type: 'color', 'aria-label': 'Colour' }, '#ff0000'), 'change');
  await h.act(field(h, { type: 'file', 'aria-label': 'Avatar' }, 'C:\\fakepath\\photo.png'), 'change');
  assert.deepEqual(texts(h), [
    'Set the "Volume" slider',
    'Set the "Colour" picker',
    'Attach a file to the "Avatar" field',
  ]);
  assert.deepEqual(h.entries().map((e) => e.ctx.value.masked), [true, true, true]);
  // The withheld value still says one existed: the editor prints this line under the step.
  assert.deepEqual(h.entries().map((e) => e.ctx.value.text), ['a value', 'a value', 'a file']);
});

// Clearing a file input is a `change` like any other, and a page does it on its own Remove
// button — an empty one has no filename to attach and no step to write.
test('D18d: a file input with nothing chosen records nothing', async () => {
  const h = load();
  const cleared = el('input', { type: 'file', 'aria-label': 'Avatar' });
  h.doc.body.append(cleared);
  await h.act(cleared, 'change');
  assert.deepEqual(h.entries(), []);
  const picked = field(h, { type: 'file', 'aria-label': 'Avatar' }, 'C:\\fakepath\\photo.png');
  await h.act(picked, 'change'); // the control: the same page records a real pick
  assert.deepEqual(texts(h), ['Attach "photo.png" to the "Avatar" field']);
});

test('D19: typing into a contenteditable records a step', async () => {
  const h = load();
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'hello');
  h.doc.body.append(box);
  await h.act(box, 'blur');
  assert.equal(h.entries().length, 1);
});

// The composer's text is its value, and it reaches the masking rules like any other.
test('D19b: a contenteditable records its text, and a card number in one is still masked', async () => {
  const h = load();
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'call me back');
  h.doc.body.append(box);
  await h.act(box, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type "call me back" into the Notes field');
  assert.deepEqual(entry.ctx.value, { text: 'call me back', masked: false });
  const secret = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, '4242 4242 4242 4242');
  h.doc.body.append(secret);
  await h.act(secret, 'blur');
  assert.equal(h.entries()[1].text, 'Type the card number into the Notes field');
});

test('D20: a textarea is recorded exactly like an input', async () => {
  const h = load();
  const area = el('textarea', { 'aria-label': 'Notes', value: 'call me back' });
  h.doc.body.append(area);
  await h.act(area, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type "call me back" into the Notes field');
  assert.deepEqual(entry.ctx.value, { text: 'call me back', masked: false });
});

// ---- E: IME composition — the field holds the reading until the commit lands ----

test('E1: a composed word records once, as the committed text', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'けんさく'); // the unfinished reading
  await h.act(input, 'compositionstart');
  await h.act(input, 'blur');   // swallowed: recording it would write the reading
  input.value = '検索';          // Blink commits into .value before compositionend
  await h.act(input, 'compositionend');
  await h.act(input, 'keydown', { key: 'Enter' }); // the IME's commit key, dedupes
  assert.deepEqual(texts(h), ['Type "検索" into the Search field']);
});

test('E2: Enter that only commits a composition is not a step', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'keydown', { key: 'Enter', isComposing: true });
  assert.deepEqual(h.entries(), []);
  await h.act(input, 'keydown', { key: 'Enter' }); // the real Enter after it still records
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('E3: keyCode 229 is that same commit from an IME that leaves isComposing unset', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'keydown', { key: 'Enter', keyCode: 229 });
  assert.deepEqual(h.entries(), []);
  await h.act(input, 'keydown', { key: 'Enter' });
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('E4: a composition started inside the pill never becomes the page\'s', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  // The pill's own Expected input composes too; it must not arm the page's composing state.
  h.fire(input, 'compositionstart', { composedPath: () => [input, h.host()] });
  await h.act(input, 'blur'); // so this blur is an ordinary one, and records
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

test('E5: a compositionend with no start behind it records the field as usual', async () => {
  const h = load();
  const input = field(h, { 'aria-label': 'Search' }, 'shoes');
  await h.act(input, 'compositionend');
  assert.deepEqual(texts(h), ['Type "shoes" into the Search field']);
});

// ---- F: <select> — a picked option is an entered value, and masks like one ----

test('F1: a picked option is written into the step', async () => {
  const h = load();
  const sel = dropdown(h, { 'aria-label': 'Size' }, 'Large');
  await h.act(sel, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Select "Large" in the Size dropdown');
  assert.deepEqual(entry.ctx.value, { text: 'Large', masked: false });
});

test('F2: under the never-values toggle a dropdown says "an option", not "text"', async () => {
  const h = load({ storage: { stepRecNeverValues: true } });
  const sel = dropdown(h, { 'aria-label': 'Size' }, 'Large');
  await h.act(sel, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Select an option in the Size dropdown');
  assert.deepEqual(entry.ctx.value, { text: 'an option', masked: true });
});

// An expiry month is sensitive, but it is not a card number: the noun stays "the value".
test('F3: a cc-exp-month dropdown masks as "the value"', async () => {
  const h = load();
  const sel = dropdown(h, { 'aria-label': 'Expiry month', autocomplete: 'cc-exp-month' }, '07');
  await h.act(sel, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Select the value in the Expiry month dropdown');
  assert.deepEqual(entry.ctx.value, { text: 'the value', masked: true });
});

// The Luhn backstop reads the OPTION text: a card number a page offers in a list is still one.
test('F4: a Luhn-valid option text is masked as the card number', async () => {
  const h = load();
  h.doc.body.append(el('span', { id: 'cardLbl' }, 'Card'));
  const sel = dropdown(h, { 'aria-labelledby': 'cardLbl' }, '4242 4242 4242 4242');
  await h.act(sel, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Select the card number in the Card dropdown');
  assert.deepEqual(entry.ctx.value, { text: 'the card number', masked: true });
});

test('F5: a nameless dropdown is "the dropdown", with one space and no empty quotes', async () => {
  const h = load();
  const sel = dropdown(h, {}, 'Large');
  await h.act(sel, 'change');
  assert.deepEqual(texts(h), ['Select "Large" in the dropdown']);
});

test('F6: a change before the flag is read is deferred, not dropped', async () => {
  const h = load();
  const sel = dropdown(h, { 'aria-label': 'Size' }, 'Large');
  h.fire(sel, 'change');
  h.flush();
  await h.settle();
  assert.deepEqual(h.entries(), []); // the deferred call has run; its 400ms window is still open
  h.flush();
  await h.settle();
  assert.deepEqual(texts(h), ['Select "Large" in the Size dropdown']);
});

test('F7: with no selectedOptions the element value names the pick', async () => {
  const h = load();
  const sel = dropdown(h, { 'aria-label': 'Size' }, 'Large');
  sel.selectedOptions = undefined; // a custom element, or a select the page emptied
  sel.value = 'Large';
  await h.act(sel, 'change');
  assert.deepEqual(texts(h), ['Select "Large" in the Size dropdown']);
});

// ---- G: checkbox and radio — the change event, not the click, is the step ----

test('G1: a checkbox that went on is a Check step', async () => {
  const h = load();
  const box = ticked(h, 'checkbox', { 'aria-label': 'Bulk' }, true);
  await h.act(box, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Check the Bulk checkbox');
  assert.equal(entry.action, 'check');
});

test('G2: the same checkbox going off is an Uncheck step', async () => {
  const h = load();
  const box = ticked(h, 'checkbox', { 'aria-label': 'Bulk' }, false);
  await h.act(box, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Uncheck the Bulk checkbox');
  assert.equal(entry.action, 'uncheck');
});

test('G3: a nameless checkbox is named by the row it sits in', async () => {
  const h = load();
  const box = el('input', { type: 'checkbox', checked: true });
  h.doc.body.append(el('ul', null, el('li', null, el('span', null, 'Bolt Cutters'), box)));
  await h.act(box, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Check the checkbox in the "Bolt Cutters" row');
  assert.deepEqual(entry.context, { row: 'Bolt Cutters' });
});

test('G4: a radio is a Choose step, and its name is quoted', async () => {
  const h = load();
  const radio = ticked(h, 'radio', { 'aria-label': 'Card' }, true);
  await h.act(radio, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Choose the "Card" option');
  assert.equal(entry.action, 'choose');
});

test('G5: a radio with neither a name nor a clause says nothing at all', async () => {
  const h = load();
  const mute = ticked(h, 'radio', {}, true);
  await h.act(mute, 'change');
  assert.deepEqual(h.entries(), []); // "Choose the option" alone is not a step anyone can read
  const named = ticked(h, 'radio', { 'aria-label': 'Card' }, true);
  await h.act(named, 'change');
  assert.deepEqual(texts(h), ['Choose the "Card" option']);
});

test('G6: a nameless radio inside a fieldset is named by its legend', async () => {
  const h = load();
  const radio = el('input', { type: 'radio', checked: true });
  h.doc.body.append(el('fieldset', null, el('legend', null, 'Payment'), radio));
  await h.act(radio, 'change');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Choose the option in the "Payment" section');
  assert.deepEqual(entry.context, { section: 'Payment' });
});

test('G7: a change on anything that is not a field is not a step', async () => {
  const h = load();
  const div = el('div', null, 'not a control');
  h.doc.body.append(div);
  await h.act(div, 'change');
  await h.act(text('a bare text node'), 'change'); // no tagName at all
  assert.deepEqual(h.entries(), []);
  const box = ticked(h, 'checkbox', { 'aria-label': 'Bulk' }, true);
  await h.act(box, 'change');
  assert.deepEqual(texts(h), ['Check the Bulk checkbox']);
});

test('G8: the pill\'s own Expected input never records itself as a step', async () => {
  const h = load();
  h.fireOn(h.box().querySelector('button.exp'), 'click');
  const expInput = h.box().querySelector('.exp-input');
  expInput.value = 'the cart opens';
  await h.act(expInput, 'change');
  assert.deepEqual(h.entries(), []);
  const box = ticked(h, 'checkbox', { 'aria-label': 'Bulk' }, true);
  await h.act(box, 'change');
  assert.deepEqual(texts(h), ['Check the Bulk checkbox']);
});

// Added in review: every other password row names the field "password" too, so the field TYPE
// on its own was never pinned — the branch could be deleted and the suite would not notice.
// A bank's "memorable answer" is a real field of type password with no telling name.
test('D21: a password field masks on its type alone, whatever it is called', async () => {
  const h = load();
  const field = el('input', { type: 'password', value: 'Springfield' });
  field.setAttribute('aria-label', 'Memorable answer');
  h.doc.body.append(field);
  await h.act(field, 'blur');
  assert.deepEqual(h.entries().map((e) => e.text), ['Type the password into the Memorable answer field']);
});
