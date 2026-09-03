#!/usr/bin/env node
// extension/content/rec-mask.js on its own: the rules that decide whether a typed value reaches
// the test, read as a table rather than through a field and a blur. The whole module loads with
// no stubs at all — that is the reason this file exists beside the end-to-end rows in
// tests/step-recorder-mask.test.mjs, which stay the authority on the sentences.
// Run: node --test tests/*.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repoRoot, 'extension/content/rec-mask.js'), 'utf8');
// A top-level const is lexical, so the script's completion value is how it gets out.
const RecMask = runInNewContext(`${source}\nRecMask;`, {});

// Enough of a field for the rules: they read the attributes, the value and the type, nothing else.
const field = ({ type = 'text', value = '', name = '', id = '', placeholder = '', ...attrs } = {}) => ({
  type,
  value,
  id,
  placeholder,
  getAttribute: (n) => (n === 'name' ? name : (n in attrs ? attrs[n] : null)),
});

test('words: a developer string becomes whole words, whatever it was written in', () => {
  assert.equal(RecMask.words('cardNumber'), 'card number');
  assert.equal(RecMask.words('card_number'), 'card number');
  assert.equal(RecMask.words('CARD-NUMBER'), 'card number');
  assert.equal(RecMask.words('cardnumber'), 'cardnumber'); // no seam to split on
  assert.equal(RecMask.words(null), '');
});

test('looksLikeCard: thirteen to nineteen digits that pass Luhn, however they are spaced', () => {
  assert.equal(RecMask.looksLikeCard('4111111111111111'), true);
  assert.equal(RecMask.looksLikeCard('4111 1111 1111 1111'), true);
  assert.equal(RecMask.looksLikeCard('4111-1111-1111-1111'), true);
  assert.equal(RecMask.looksLikeCard('4111 1111 1111 1111'), true); // a formatter's NBSP
  assert.equal(RecMask.looksLikeCard('4111111111111112'), false); // one digit off
  assert.equal(RecMask.looksLikeCard('12345678'), false); // too short to be a card at all
  assert.equal(RecMask.looksLikeCard('41111111111111111111'), false); // twenty digits
  assert.equal(RecMask.looksLikeCard('4111 1111 1111 111a'), false);
});

test('isCardNumber: "card" alone is a Kanban card, not a payment card', () => {
  assert.equal(RecMask.isCardNumber('card number'), true);
  assert.equal(RecMask.isCardNumber('cc no'), true);
  assert.equal(RecMask.isCardNumber('card pan'), true);
  assert.equal(RecMask.isCardNumber('card'), false);
  assert.equal(RecMask.isCardNumber('card title'), false);
});

// The spread is not decoration: the array is built inside the sandbox, so a strict deepEqual
// against one built here fails on the prototype alone.
test('acTokens: the spec prefixes are dropped so the field name is what is left', () => {
  assert.deepEqual([...RecMask.acTokens(field({ autocomplete: 'section-blue billing cc-number' }))], ['cc-number']);
  assert.deepEqual([...RecMask.acTokens(field({ autocomplete: 'shipping postal-code' }))], ['postal-code']);
  assert.deepEqual([...RecMask.acTokens(field())], []);
});

test('fieldWords: every string the field could be known by, the label included', () => {
  const el = field({ name: 'ccNum', id: 'pay1', placeholder: 'Number', 'aria-label': 'Card' });
  assert.equal(RecMask.fieldWords(el, () => 'Payment card'), 'cc num pay1 number card payment card');
  assert.equal(RecMask.fieldWords(el), 'cc num pay1 number card'); // no label reader, no label
});

test('a password is a password by its type, whatever the field is called', () => {
  assert.equal(RecMask.maskedAs(field({ type: 'password', value: 'hunter2' })), 'the password');
  assert.equal(RecMask.maskedAs(field({ type: 'PASSWORD', value: 'hunter2' })), 'the password');
  // A revealed password is type=text; the name is what is left to go on.
  assert.equal(RecMask.maskedAs(field({ name: 'passphrase', value: 'x' })), 'the password');
  assert.equal(RecMask.maskedAs(field({ autocomplete: 'current-password', value: 'x' })), 'the password');
});

test('a card number is named only when it is certain, and guessed at from the value', () => {
  assert.equal(RecMask.maskedAs(field({ name: 'cardNumber', value: '' })), 'the card number');
  assert.equal(RecMask.maskedAs(field({ autocomplete: 'cc-number', value: '' })), 'the card number');
  // The field says nothing, the value says everything.
  assert.equal(RecMask.maskedAs(field({ name: 'reference', value: '4111 1111 1111 1111' })), 'the card number');
});

test('everything else sensitive is "the value" — the noun is never a guess', () => {
  for (const name of ['cvv', 'csc', 'securityCode', 'ssn', 'passport', 'otp', 'apiKey', 'iban', 'pin']) {
    assert.equal(RecMask.maskedAs(field({ name, value: 'x' })), 'the value', name);
  }
  assert.equal(RecMask.maskedAs(field({ name: 'cardTitle', value: 'Fix login' })), 'the value');
});

test('an ordinary field is not masked at all', () => {
  for (const name of ['email', 'firstName', 'shippingCity', 'search', 'quantity']) {
    assert.equal(RecMask.maskedAs(field({ name, value: 'x' })), null, name);
  }
});

test('a whole word, never a prefix: passport is a document, shipping is not a pin', () => {
  assert.equal(RecMask.maskedAs(field({ name: 'passport', value: 'x' })), 'the value');
  assert.equal(RecMask.maskedAs(field({ name: 'shipping', value: 'x' })), null);
  assert.equal(RecMask.maskedAs(field({ name: 'passwordHint', value: 'x' })), 'the password');
});

test('under the toggle every field reads alike, except a password', () => {
  assert.equal(RecMask.maskedAllAs(field({ name: 'email', value: 'a@b.c' })), 'text');
  assert.equal(RecMask.maskedAllAs(field({ name: 'cardNumber', value: '4111' })), 'text');
  assert.equal(RecMask.maskedAllAs(field({ type: 'password', value: 'x' })), 'the password');
});

test('the flag answers null until it is read, and never guesses', async () => {
  const listeners = [];
  const storage = {
    local: { get: () => Promise.resolve({ stepRecNeverValues: true }) },
    onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => listeners.pop() },
  };
  const flag = RecMask.watchFlag(storage);
  assert.equal(flag.get(), null); // a step arriving now waits rather than being recorded
  await flag.read;
  assert.equal(flag.get(), true);

  listeners[0]({ stepRecNeverValues: { newValue: false } }, 'local');
  assert.equal(flag.get(), false); // a Save mid-recording lands on the next step
  listeners[0]({ stepRecNeverValues: { newValue: true } }, 'sync');
  assert.equal(flag.get(), false); // another area is not this setting

  flag.stop();
  assert.equal(listeners.length, 0);
});

test('unreadable storage means off, not stuck, and no listener is left behind', async () => {
  const flag = RecMask.watchFlag({ local: { get: () => Promise.reject(new Error('gone')) } });
  await flag.read;
  assert.equal(flag.get(), false);
  flag.stop(); // nothing to remove, and it must not throw
  const none = RecMask.watchFlag(undefined);
  await none.read;
  assert.equal(none.get(), false);
});
