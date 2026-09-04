#!/usr/bin/env node
// extension/params.js (#147): the file that turns `Open ${email}` into `Open "admin@example.com"`
// for the example row the panel is showing, and decides whether the "example" badge still fires.
// Run: node --test tests/params.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// PARAMS_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.PARAMS_SRC || join(repoRoot, 'extension/params.js');
const source = readFileSync(SRC, 'utf8');

// params.js touches no global at all, so the sandbox is bare; its top-level `const` is lexical,
// not a global property — the script's completion value is it.
const Params = runInNewContext(`${source}\nTestomatParams;`, {});
const sub = (text, params, example) => Params.substitute(text, params, example);

// ===================== substitution, the happy contract =====================

test('P1: the value the tester put in the row reaches the step in double quotes', () => {
  assert.equal(sub('Hi ${a}', ['a'], ['X']), 'Hi "X"');
});

test('P2: a step written with the {{a}} spelling is substituted just the same', () => {
  assert.equal(sub('Hi {{a}}', ['a'], ['X']), 'Hi "X"');
});

// Product parity with descriptionWithExample.js: a column named "0" is not a column.
test('P3: a column named 0 is skipped and its placeholder stays on the screen', () => {
  assert.equal(sub('${0}=${x}', ['0', 'x'], ['A', 'B']), '${0}="B"');
});

test('P4: with no example row to read, the step is handed back exactly as written', () => {
  assert.equal(sub('x', ['a'], 'notarray'), 'x');
  // The row above cannot see the guard go (there is no placeholder in `x` to substitute);
  // this one can — without it a string example is indexed into and `${a}` becomes "n".
  assert.equal(sub('Hi ${a}', ['a'], 'notarray'), 'Hi ${a}');
  assert.equal(sub('Hi ${a}', 'a', ['X']), 'Hi ${a}');
});

test('P5: an empty or missing description comes back as an empty string, never as null', () => {
  assert.equal(sub(null, ['a'], ['X']), '');
  assert.equal(sub(undefined, ['a'], ['X']), '');
  assert.equal(sub('', ['a'], ['X']), '');
});

// #147 predicted '' here; only a FALSY non-string takes the `|| ''` branch of line 7.
test('P6: a description that is not text at all is handed straight back', () => {
  assert.equal(sub(123, ['a'], ['X']), 123);
  assert.equal(sub(0, ['a'], ['X']), ''); // the falsy half, which is where '' comes from
});

test('P17: a column name with spaces round it is matched with the spaces kept', () => {
  assert.equal(sub('${ x }', [' x '], ['A']), '"A"');
  // The name is trim()-TESTED but used UNTRIMMED, so the tidy-looking placeholder is the one
  // that misses. Today's answer, not an endorsement: trimming belongs with the product's mirror.
  assert.equal(sub('${x}', [' x '], ['A']), '${x}');
});

test('P18: a column named in Ukrainian substitutes like any other', () => {
  assert.equal(sub('${кроки}', ['кроки'], ['так']), '"так"');
});

// #147 asked for the opposite here: a value carrying a placeholder should survive the later
// passes. It does not — substitution is one pass per column and pass two re-reads pass one's
// output. Pinned as today's answer only; the single-pass rewrite belongs with the product's
// own descriptionWithExample.js, which this file mirrors line for line.
test('P23: an example value that looks like a placeholder is substituted a second time, so the column order decides the answer', () => {
  assert.equal(sub('${a} ${b}', ['a', 'b'], ['${b}', 'V']), '""V"" "V"');
  assert.equal(sub('${a} ${b}', ['b', 'a'], ['V', '${b}']), '"${b}" "V"');
});

// ================= a column name is data, not a pattern (#112) ==============

test('P7: a column named price(usd) substitutes instead of leaving ${price(usd)} on the screen', () => {
  assert.equal(sub('X ${price(usd)} Y', ['price(usd)'], ['V']), 'X "V" Y');
});

test('P8: a column with one unclosed bracket substitutes instead of breaking the whole test view', () => {
  assert.equal(sub('X ${price(usd} Y', ['price(usd'], ['V']), 'X "V" Y');
});

test('P9: a column ending in a stray closing bracket substitutes instead of breaking the test view', () => {
  assert.equal(sub('X ${a)} Y', ['a)'], ['V']), 'X "V" Y');
});

test('P10: a column named a.b no longer fills in an unrelated ${axb}', () => {
  assert.equal(sub('Set ${axb}', ['a.b'], ['X']), 'Set ${axb}');
  assert.equal(sub('Set ${a.b}', ['a.b'], ['X']), 'Set "X"'); // the control: its own placeholder still fills in
});

test('P11: a column named a|b fills its placeholder once, not both halves of it', () => {
  assert.equal(sub('X ${a|b} Y', ['a|b'], ['V']), 'X "V" Y');
});

test('P12: every punctuation mark the parameters grid lets a tester type substitutes', () => {
  for (const name of ['a[0]', 'a*', 'a+', 'a?', 'a{2}', 'a$', 'a\\']) {
    assert.equal(sub(`X \${${name}} Y`, [name], ['V']), 'X "V" Y', name);
    assert.equal(sub(`X {{${name}}} Y`, [name], ['V']), 'X "V" Y', name);
  }
});

// Today's answer, not a correct one: the first pass has already taken every occurrence, so the
// second column can never be seen. Refusing two columns of one name is the editor's plan(), #112.
test('P13: with two columns of the same name the FIRST one wins', () => {
  assert.equal(sub('${email}', ['email', 'email'], ['a@x', 'b@y']), '"a@x"');
});

// ============ a row shorter than the columns writes no "undefined" ==========

test('P14: a row that stops short leaves the rest of the placeholders raw, never the word undefined', () => {
  assert.equal(sub('${a} ${b}', ['a', 'b'], ['A']), '"A" ${b}');
});

test('P15: an empty cell in the row leaves its placeholder raw, never the word null', () => {
  assert.equal(sub('${a}', ['a'], [null]), '${a}');
});

test('P16: a row with nothing in it leaves the step exactly as the tester wrote it', () => {
  assert.equal(sub('${a}', ['a'], []), '${a}');
  // The control: a cell the tester deliberately left blank is a value, and still substitutes.
  assert.equal(sub('${a}', ['a'], ['']), '""');
});

// ============================= the two predicates ===========================

test('P19: a step still holding a placeholder is reported as one, in either spelling', () => {
  assert.equal(Params.hasPlaceholder('${a}'), true);
  assert.equal(Params.hasPlaceholder('{{a}}'), true);
});

test('P20: empty braces are not a placeholder, so they raise no example badge', () => {
  assert.equal(Params.hasPlaceholder('${}'), false);
  assert.equal(Params.hasPlaceholder('{{}}'), false);
});

test('P21: anything that is not text holds no placeholder', () => {
  assert.equal(Params.hasPlaceholder(null), false);
  assert.equal(Params.hasPlaceholder(42), false);
});

// The badge and the substitution loop must not drift: this is line 11's test, spelled again.
test('P22: a test counts as parametrized only when a column has a usable name', () => {
  assert.equal(Params.isParametrized(['a']), true);
  assert.equal(Params.isParametrized(['0']), false);
  assert.equal(Params.isParametrized([' ']), false);
  assert.equal(Params.isParametrized([]), false);
  assert.equal(Params.isParametrized('a'), false);
  assert.equal(Params.isParametrized(null), false);
});
