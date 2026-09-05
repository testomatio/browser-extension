#!/usr/bin/env node
// extension/sidepanel/core/suite-tree.js — the four decisions the Tests tab's suite tree is made
// of, as the tester meets them: what a search leaves standing, what the number on a folder means,
// which mark a node wears, and which suites ride at the top of the list. Rows 1-18 of #163, moved
// here unchanged when they left screens/tc-studio.js (#196).
// They were always pure, and this file is the proof: the module is evaluated in a BARE `{}`
// sandbox — no document, no chrome, no state, no API, not one stub. A row that needed one would
// mean the algorithm had reached back into the screen.
// The one call that changed shape is `hoist`: it read the screen's own `tcJustCreated` array, and
// now takes it as an argument. Same array, same order, same answer — the rows below hand it in.
// Run: node --test tests/suite-tree.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// CORE_SRC points the suite at a mutated COPY of core/, so a falsification run never edits the
// shipped file. `SuiteTree` is a top-level const: lexical, so only the completion value reaches us.
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const T = runInNewContext(`${readFileSync(join(CORE_SRC, 'suite-tree.js'), 'utf8')}\nSuiteTree;`, {});

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const folder = (id, title, children = [], extra = {}) =>
  ({ id, title, file_type: 'folder', children, ...extra });
const file = (id, title, extra = {}) => ({ id, title, file_type: 'file', ...extra });

// ---------- what a query keeps (rows 1-8) ----------

const CHECKOUT = [folder('f1', 'Checkout', [file('s1', 'Guest'), file('s2', 'Card')])];

test('1: a cleared query is not a filter — the tester gets their own tree object back, untouched', () => {
  const roots = CHECKOUT;
  assert.equal(T.filter(roots, ''), roots);
  assert.equal(T.filter(roots, '   '), roots);
  // A query that IS one hands back something else, so the identity above is a decision, not a stub.
  assert.notEqual(T.filter(roots, 'guest'), roots);
});

test('2: a folder whose own name matches keeps its whole subtree, not just the matching rows', () => {
  const out = plain(T.filter(CHECKOUT, 'check'));
  assert.deepEqual(out.map((n) => n.title), ['Checkout']);
  assert.deepEqual(out[0].children.map((n) => n.title), ['Guest', 'Card']);
});

test('3: a folder kept only for a child shows just the branch that leads there', () => {
  const out = plain(T.filter(CHECKOUT, 'guest'));
  assert.deepEqual(out.map((n) => n.title), ['Checkout']);
  assert.deepEqual(out[0].children.map((n) => n.title), ['Guest']);
});

// The plaque the screen raises over that emptiness is tests/tc-studio.test.mjs's own row 4.
test('4: a query nothing answers is an empty tree', () => {
  assert.deepEqual(plain(T.filter(CHECKOUT, 'zzz')), []);
  // The same tree under a query that DOES answer is not empty, so the row is about the query.
  assert.deepEqual(plain(T.filter(CHECKOUT, 'guest')).map((n) => n.id), ['f1']);
});

test('5: the search is case-blind on both sides', () => {
  const hit = (q, title) => plain(T.filter([{ title }], q)).length === 1;
  assert.equal(hit('CHECK', 'checkout'), true);
  assert.equal(hit('check', 'CHECKOUT'), true);
  assert.equal(hit('xyz', 'CHECKOUT'), false);
});

test('6: a node the server sent with no title at all is filtered, not thrown over', () => {
  const roots = [{ id: 'a' }, { id: 'b', title: 'Checkout' }];
  assert.deepEqual(plain(T.filter(roots, 'check')).map((n) => n.id), ['b']);
  // …and a childless node with no title survives an empty query the same way.
  assert.equal(T.filter(roots, ''), roots);
});

test('7: no tree at all filters to nothing rather than throwing', () => {
  assert.deepEqual(plain(T.filter(null, 'x')), []);
  assert.deepEqual(plain(T.filter(undefined, 'x')), []);
});

test('8: the filter hands back copies, so state.tcSuites keeps the order and shape the server sent', () => {
  const roots = [folder('f1', 'Checkout', [file('s1', 'Guest')])];
  const out = T.filter(roots, 'guest');
  assert.notEqual(out[0], roots[0]);
  out[0].title = 'rewritten';
  out[0].children.length = 0;
  assert.equal(roots[0].title, 'Checkout');
  assert.deepEqual(roots[0].children.map((n) => n.id), ['s1']);
});

// ---------- what a count means (rows 9-11) ----------

test('9: a count is a number however the server spelled it, and a row without one counts nothing', () => {
  assert.equal(T.testCount([{ test_count: 3 }, { test_count: '4' }, {}]), 7);
  assert.equal(T.testCount([{ test_count: 'many' }]), 0);
});

test('10: a folder already carries its subtree total, so the children are not summed on top of it', () => {
  const roots = [folder('f1', 'Checkout', [file('s1', 'Guest', { test_count: 4 })], { test_count: 6 })];
  assert.equal(T.testCount(roots), 6);
  // Two roots ARE added together — the sum is over the roots, not over nothing.
  assert.equal(T.testCount([...roots, file('s9', 'Other', { test_count: 2 })]), 8);
});

test('11: no tree is a count of zero', () => {
  assert.equal(T.testCount(null), 0);
  assert.equal(T.testCount([]), 0);
});

// ---------- which mark a node wears (rows 12-15) ----------

test('12: a suite mark is found however deep the node sits', () => {
  const tree = [folder('f1', 'Checkout', [folder('f2', 'Guest', [file('s3', 'Card', { emoji: '🔥' })])])];
  assert.equal(T.emojiOf(tree, 's3'), '🔥');
});

test('13: a node that exists without a mark answers null — "draw the glyph", not "keep looking"', () => {
  const tree = [folder('f1', 'Checkout', [file('s1', 'Guest')])];
  assert.equal(T.emojiOf(tree, 's1'), null);
  // The same tree with a mark on that node answers it, so the null above is the node's own answer.
  assert.equal(T.emojiOf([folder('f1', 'C', [file('s1', 'Guest', { emoji: '🧪' })])], 's1'), '🧪');
});

// 13a is new (#196). Row 13's node sits one level down, and the recursion swallows the difference:
// the parent frame sees a falsy `found` and falls through to its own `return null`. So dropping the
// `|| null` — handing the screen `undefined` where it pins a null — went red NOWHERE.
test('13a: …and at the very top of the tree too, where no parent frame can answer for it', () => {
  assert.equal(T.emojiOf([file('s1', 'Guest')], 's1'), null);
  assert.equal(T.emojiOf([file('s1', 'Guest', { emoji: '' })], 's1'), null);
  // The same root node with a mark answers it, so the null above is that node's own answer.
  assert.equal(T.emojiOf([file('s1', 'Guest', { emoji: '🔥' })], 's1'), '🔥');
});

test('14: an empty tree and an id that is not in it are the same null', () => {
  assert.equal(T.emojiOf([], 's1'), null);
  assert.equal(T.emojiOf(null, 's1'), null);
  assert.equal(T.emojiOf([file('s1', 'Guest', { emoji: '🔥' })], 's2'), null);
});

test('15: a numeric id and the string the tree holds are the same suite', () => {
  assert.equal(T.emojiOf([file('7', 'Guest', { emoji: '🔥' })], 7), '🔥');
  assert.equal(T.emojiOf([file(7, 'Guest', { emoji: '🔥' })], '7'), '🔥');
});

// ---------- which suites ride at the top (rows 16-18) ----------

test('16: suites made in this visit ride at the top, newest first, the rest in the servers order', () => {
  const created = ['c', 'b']; // the order openSuiteInput's unshift leaves them in: newest first
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(plain(T.hoist(list, created)).map((n) => n.id), ['c', 'b', 'a']);
});

test('17: nothing created this visit leaves the list exactly as it came, same array and all', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.equal(T.hoist(list, []), list);
  // A creation that is not in THIS list is not a reorder either.
  assert.equal(T.hoist(list, ['zz']), list);
  // …and one that is changes the order, so the identity above is a decision.
  assert.deepEqual(plain(T.hoist(list, ['b', 'zz'])).map((n) => n.id), ['b', 'a']);
});

test('18: an empty list of children is nothing to hoist', () => {
  assert.deepEqual(plain(T.hoist([], ['b'])), []);
  assert.deepEqual(plain(T.hoist(null, ['b'])), []);
});
