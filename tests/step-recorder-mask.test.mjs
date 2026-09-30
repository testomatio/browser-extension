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

// ---- H: a field's text is its value, and no name, clause or packet fact reads it ----

const NEVER = { storage: { stepRecNeverValues: true } };

// The typed text reaches no part of any entry: not the sentence, the name, the clause or the packet.
function nowhere(h, typed) {
  const all = JSON.stringify(h.entries());
  assert.ok(!all.includes(typed), `"${typed}" leaked: ${all}`);
}

test('H1: a composer\'s text is its value alone, masked by the toggle or by the card rule', async () => {
  const on = load(NEVER);
  const mention = el('span', { contenteditable: 'false' }, '@John Smith'); // a chip inside the composer
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'call me back ', mention);
  on.doc.body.append(box);
  await on.act(box, 'blur');
  assert.deepEqual(texts(on), ['Type text into the Notes field']);
  assert.equal(on.entries()[0].ctx.element.text, '');
  nowhere(on, 'call me back');
  nowhere(on, 'John Smith');
  const off = load();
  const card = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, '4242 4242 4242 4242');
  off.doc.body.append(card);
  await off.act(card, 'blur');
  assert.deepEqual(texts(off), ['Type the card number into the Notes field']);
  nowhere(off, '4242');
});

test('H2: a textarea\'s own text is never a packet fact, masked or not', async () => {
  const masked = load();
  const key = el('textarea', { name: 'api_key', value: 'typed-now' }, 'sk-live-123');
  masked.doc.body.append(key);
  await masked.act(key, 'blur');
  assert.deepEqual(texts(masked), ['Type the value into the api_key field']);
  nowhere(masked, 'sk-live-123');
  nowhere(masked, 'typed-now');
  const plain = load();
  const note = el('textarea', { 'aria-label': 'Notes', value: 'call me back' }, 'prefilled draft');
  plain.doc.body.append(note);
  await plain.act(note, 'blur');
  const [entry] = plain.entries();
  assert.equal(entry.ctx.element.text, '');
  assert.deepEqual(entry.ctx.value, { text: 'call me back', masked: false });
  nowhere(plain, 'prefilled draft');
  const beside = load();
  const copy = el('button', null, 'Copy');
  beside.doc.body.append(el('div', null, el('textarea', { name: 'api_key' }, 'sk-live-456'), copy));
  await beside.act(copy, 'click');
  assert.deepEqual(texts(beside), ['Click the "Copy" button']);
  nowhere(beside, 'sk-live-456');
});

test('H3: a heading never reads a field, the one inside it or the one it is', async () => {
  const inside = load(NEVER);
  const title = el('span', { contenteditable: 'true', 'aria-label': 'Title' }, 'Secret plan');
  inside.doc.body.append(el('h2', null, text('Draft '), title));
  await inside.act(title, 'blur');
  assert.deepEqual(texts(inside), ['Type text into the Title field']);
  assert.equal(inside.entries()[0].ctx.near.heading, 'Draft');
  nowhere(inside, 'Secret plan');
  const itself = load(NEVER);
  const own = el('h2', { contenteditable: 'true', 'aria-label': 'Title' }, 'Secret plan');
  itself.doc.body.append(own);
  await itself.act(own, 'blur');
  assert.deepEqual(texts(itself), ['Type text into the Title field']);
  nowhere(itself, 'Secret plan');
  const after = load(NEVER);
  const share = el('button', null, 'Share');
  after.doc.body.append(el('div', null, el('h2', { contenteditable: 'true' }, 'Secret plan'), share));
  await after.act(share, 'click');
  assert.deepEqual(texts(after), ['Click the "Share" button']);
  nowhere(after, 'Secret plan');
});

test('H4: an editable cell or list item never names its row', async () => {
  const cellRow = load(NEVER);
  const cell = el('td', { contenteditable: 'true', 'aria-label': 'cvv' }, '987');
  cellRow.doc.body.append(el('table', null, el('tr', null, cell)));
  await cellRow.act(cell, 'blur');
  assert.deepEqual(texts(cellRow), ['Type text into the cvv field']);
  nowhere(cellRow, '987');
  const listRow = load(NEVER);
  const item = el('span', { contenteditable: 'true', 'aria-label': 'cvv' }, '987');
  listRow.doc.body.append(el('ul', null, el('li', null, item)));
  await listRow.act(item, 'blur');
  assert.deepEqual(texts(listRow), ['Type text into the cvv field']);
  nowhere(listRow, '987');
  // A grid keeps its key column read-only: those words are the page's, and still name the row.
  const keyed = load(NEVER);
  const qty = el('span', { contenteditable: 'true', 'aria-label': 'Qty' }, '987');
  keyed.doc.body.append(el('ul', null, el('li', null, el('span', { contenteditable: 'false' }, 'Bolt Cutters'), text(' '), qty)));
  await keyed.act(qty, 'blur');
  assert.deepEqual(texts(keyed), ['Type text into the Qty field in the "Bolt Cutters" row']);
  nowhere(keyed, '987');
});

test('H5: a label never reads a field, the composer it holds or the one it sits in', async () => {
  const holds = load(NEVER);
  const box = el('div', { contenteditable: 'true' }, 'Secret plan');
  holds.doc.body.append(el('label', null, text('Notes '), box));
  await holds.act(box, 'blur');
  assert.deepEqual(texts(holds), ['Type text into the Notes field']);
  nowhere(holds, 'Secret plan');
  // A form builder: the question the tester typed labels the preview field under it.
  const builder = load(NEVER);
  const answer = el('input', { id: 'q1', value: 'yes' });
  builder.doc.body.append(el('div', { contenteditable: 'true' }, el('label', { for: 'q1' }, 'Your salary?')), answer);
  await builder.act(answer, 'blur');
  assert.deepEqual(texts(builder), ['Type text into the q1 field']);
  nowhere(builder, 'salary');
});

test('H6: a composer is never named by its own text', async () => {
  const combo = load(NEVER);
  const to = el('div', { contenteditable: 'true', role: 'combobox' }, 'john@acme.com');
  combo.doc.body.append(to);
  await combo.act(to, 'blur');
  assert.deepEqual(texts(combo), ['Type text into the field']);
  nowhere(combo, 'john@acme.com');
  // The WAI combobox pattern: aria-labelledby lists the field itself after its label.
  const listed = load(NEVER);
  listed.doc.body.append(el('span', { id: 'lbl' }, 'To'));
  const self = el('div', { contenteditable: 'true', id: 'to', 'aria-labelledby': 'lbl to' }, 'john@acme.com');
  listed.doc.body.append(self);
  await listed.act(self, 'blur');
  assert.deepEqual(texts(listed), ['Type text into the To field']);
  nowhere(listed, 'john@acme.com');
  const grid = load(NEVER);
  const cell = el('div', { role: 'gridcell' }, text('Qty '), el('span', { contenteditable: 'true' }, '57'));
  grid.doc.body.append(cell);
  await grid.act(cell, 'click');
  assert.deepEqual(texts(grid), ['Click the "Qty" cell']);
  nowhere(grid, '57');
});

test('H7: the counter beside a composer never reads the composer', async () => {
  // `[class*="count"]` also matches `account-…`, and a chat composer is emptied on Enter.
  const own = load(NEVER);
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes', className: 'account-notes' }, 'call me back');
  own.doc.body.append(el('div', null, el('div', null, box)));
  own.fire(box, 'keydown', { key: 'Enter' });
  await own.settle();
  box.textContent = '';
  own.flush();
  await own.settle();
  assert.deepEqual(texts(own), ['Type text into the Notes field']);
  nowhere(own, 'call me back');
  const row = load(NEVER);
  const inner = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'call me back');
  row.doc.body.append(el('div', null, el('div', { className: 'account-row' }, text('Notes '), inner)));
  row.fire(inner, 'keydown', { key: 'Enter' });
  await row.settle();
  inner.textContent = '';
  row.flush();
  await row.settle();
  assert.deepEqual(texts(row), ['Type text into the Notes field']);
  nowhere(row, 'call me back');
});

test('H8: a note from inside a field is not what the page said', async () => {
  const spell = load(NEVER);
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'call me ');
  spell.doc.body.append(box);
  spell.fire(box, 'blur');
  await spell.settle();
  const mark = el('span', { className: 'spelling-error' }, 'bakc'); // an editor's own spell-check mark
  box.append(mark);
  spell.mutate(mark);
  spell.flush();
  await spell.settle();
  assert.equal(spell.entries()[0].ctx.after.dialog, '');
  nowhere(spell, 'bakc');
  // An invalid control with no message of its own is read by what it points at, or what follows it.
  const invalid = load();
  const save = el('button', null, 'Save');
  invalid.doc.body.append(save);
  invalid.fire(save, 'click');
  await invalid.settle();
  const pointed = el('input', { 'aria-invalid': 'true', 'aria-describedby': 'hint' });
  const followed = el('input', { 'aria-invalid': 'true' });
  invalid.doc.body.append(el('div', null, pointed, el('textarea', { id: 'hint' }, 'sk-live-123')),
    el('div', null, followed, el('textarea', null, 'sk-live-456')));
  invalid.mutate(pointed, followed);
  invalid.flush();
  await invalid.settle();
  assert.deepEqual(texts(invalid), ['Click the "Save" button']);
  assert.equal(invalid.entries()[0].ctx.after.dialog, '');
  nowhere(invalid, 'sk-live');
});

test('H9: an image typed into a composer is not its icon', async () => {
  const h = load(NEVER);
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Notes' }, 'hi ', el('img', { alt: 'party-parrot' }));
  h.doc.body.append(box);
  await h.act(box, 'blur');
  assert.equal(h.entries()[0].ctx.element.icon, '');
  nowhere(h, 'party-parrot');
});

// The control, green before the fix and after it: the page's own words still name and place a composer.
test('H10: a heading, a row and a label around a composer still say where it is', async () => {
  const h = load(NEVER);
  const box = el('div', { contenteditable: 'true', 'aria-label': 'Qty' }, 'call me back');
  h.doc.body.append(el('h2', null, 'Billing'),
    el('table', null, el('tr', null, el('td', null, 'Bolt Cutters'), el('td', null, box))));
  await h.act(box, 'blur');
  const [entry] = h.entries();
  assert.equal(entry.text, 'Type text into the Qty field in the "Bolt Cutters" row');
  assert.deepEqual(entry.context, { row: 'Bolt Cutters', section: 'Billing' });
  assert.equal(entry.ctx.near.heading, 'Billing');
});

// ---- I: a field is named by its label, never by what it holds, whatever role the page gives it ----

// The field inside its own <label>, which is how most forms name one.
function labelled(h, label, field) {
  h.doc.body.append(el('label', null, text(`${label} `), field));
  return field;
}

test('I1: an address autocomplete is named by its label, toggle on or off, and nameless without one', async () => {
  const on = load(NEVER);
  await on.act(labelled(on, 'Address', el('input', { role: 'combobox', value: 'Kyiv, Khreshchatyk 22' })), 'blur');
  assert.deepEqual(texts(on), ['Type text into the Address field']);
  nowhere(on, 'Khreshchatyk');
  const off = load();
  await off.act(labelled(off, 'Address', el('input', { role: 'combobox', value: 'Kyiv, Khreshchatyk 22' })), 'blur');
  assert.deepEqual(texts(off), ['Type "Kyiv, Khreshchatyk 22" into the Address field']);
  const bare = load(NEVER);
  const input = el('input', { role: 'combobox', value: 'Kyiv' });
  bare.doc.body.append(input);
  await bare.act(input, 'blur');
  assert.deepEqual(texts(bare), ['Type text into the field']);
  nowhere(bare, 'Kyiv');
});

test('I2: a card number in an autocomplete stays masked, the name included', async () => {
  const h = load();
  await h.act(labelled(h, 'Number', el('input', { role: 'combobox', value: '4242 4242 4242 4242' })), 'blur');
  assert.deepEqual(texts(h), ['Type the card number into the Number field']);
  nowhere(h, '4242');
});

test('I3: a spinner, a button-role input and a textarea with a role are named by their labels', async () => {
  const spin = load(NEVER);
  await spin.act(labelled(spin, 'Quantity', el('input', { type: 'number', role: 'spinbutton', value: '314' })), 'blur');
  assert.deepEqual(texts(spin), ['Type text into the Quantity field']);
  nowhere(spin, '314');
  const code = load(NEVER);
  await code.act(labelled(code, 'Code', el('input', { role: 'button', value: 'SECRET42' })), 'blur');
  assert.deepEqual(texts(code), ['Type text into the Code field']);
  nowhere(code, 'SECRET42');
  const to = load(NEVER);
  await to.act(labelled(to, 'To', el('textarea', { role: 'combobox', value: 'john@acme.com' })), 'blur');
  assert.deepEqual(texts(to), ['Type text into the To field']);
  nowhere(to, 'john@acme.com');
});

test('I4: a slider is named by its label, when it is set and when it is clicked', async () => {
  const set = load(NEVER);
  await set.act(labelled(set, 'Volume', el('input', { type: 'range', role: 'slider', value: '73' })), 'change');
  assert.deepEqual(texts(set), ['Set the "Volume" slider']);
  nowhere(set, '73');
  const click = load(NEVER);
  await click.act(labelled(click, 'Volume', el('input', { type: 'range', role: 'slider', value: '73' })), 'click');
  assert.deepEqual(texts(click), ['Click the "Volume" slider']);
  nowhere(click, '73');
});

test('I5: a dropdown with a combobox role is named by its label, not by one of its options', async () => {
  const h = load(NEVER);
  const sel = el('select', { role: 'combobox' }, el('option', { selected: true }, 'Large'), el('option', null, 'Extra small'));
  await h.act(labelled(h, 'Size', sel), 'change');
  assert.deepEqual(texts(h), ['Select an option in the Size dropdown']);
});

test('I6: a file picker styled as a button is named by its label, not by the file', async () => {
  const h = load(NEVER);
  const picker = el('input', { type: 'file', role: 'button', value: 'C:\\fakepath\\passport.pdf' });
  await h.act(labelled(h, 'Upload ID', picker), 'change');
  assert.deepEqual(texts(h), ['Attach a file to the "Upload ID" field']);
  nowhere(h, 'passport');
});

// Chrome gives a checkbox the value "on" unless the page sets one.
test('I7: a switch is named by its label, not by its value', async () => {
  const h = load();
  await h.act(labelled(h, 'Dark mode', el('input', { type: 'checkbox', role: 'switch', value: 'on', checked: true })), 'change');
  assert.deepEqual(texts(h), ['Check the Dark mode checkbox']);
});

// The control, green before the fix and after it: a button input's value IS its label.
test('I8: a submit and a button input are still named by their value', async () => {
  const h = load();
  const pay = el('input', { type: 'submit', value: 'Pay now' });
  const apply = el('input', { type: 'button', role: 'button', value: 'Apply' });
  h.doc.body.append(pay, apply);
  await h.act(pay, 'click');
  await h.act(apply, 'click');
  assert.deepEqual(texts(h), ['Click the "Pay now" button', 'Click the "Apply" button']);
});
