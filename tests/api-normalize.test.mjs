#!/usr/bin/env node
// extension/api.js: the pure normalisers between a server payload and what the panel draws — who a
// person is, what a page of a list means, which suite comes first. Rows 60-81 and 84-87 of #145,
// with no fetch anywhere in the file. Run: node --test tests/api-normalize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, plain } from './helpers/api-harness.mjs';

// One sandbox for the whole file: none of these functions reads a byte of module state.
const { inner, mod } = load();
const { personOf, peopleByKey, runAssigneesOf, normEnv, pageResult, DASH_KEYS } = inner;
const { normSuiteNode, orderSuiteTree, testrunExampleOf } = inner;

const doc = (attributes, over = {}) => ({ data: { attributes }, ...over });
const ASSIGN = /assign/i;

// ---- personOf: a person out of whatever the payload calls one ----

test('60: blank, absent and numeric values are nobody', () => {
  assert.equal(personOf('  '), null);
  assert.equal(personOf(null), null);
  assert.equal(personOf(42), null);
});

test('61: a bare address is an address, with no name', () => {
  assert.deepEqual(plain(personOf('a@b.io')), { name: '', email: 'a@b.io' });
});

test('62: a bare name is a name, with no address', () => {
  assert.deepEqual(plain(personOf('Ann Lee')), { name: 'Ann Lee', email: '' });
});

test('63: a JSON:API resource is read through its attributes', () => {
  assert.deepEqual(plain(personOf({ attributes: { name: 'Ann', email: 'a@b' } })), { name: 'Ann', email: 'a@b' });
});

test('64: a flat record falls back to the username', () => {
  assert.deepEqual(plain(personOf({ username: 'ann' })), { name: 'ann', email: '' });
});

// ---- peopleByKey: a name-shaped key holding something that is not a person ----

test('65: a SETTING whose key merely matches draws nobody', () => {
  assert.deepEqual(plain(peopleByKey(doc({ 'assign-mode': 'none' }), ASSIGN)), []);
});

test('66: the payload word for nobody is nobody', () => {
  assert.deepEqual(plain(peopleByKey(doc({ 'assigned-to': 'none' }), ASSIGN)), []);
});

test('67: a bare id has no letter and no address, so it is not a person', () => {
  assert.deepEqual(plain(peopleByKey(doc({ 'assigned-to': '12345' }), ASSIGN)), []);
});

test('68: the id and count companions of an assignee list are skipped', () => {
  const d = doc({ 'assignee-ids': [1, 2], 'assignee-count': 2 });
  assert.deepEqual(plain(peopleByKey(d, ASSIGN)), []);
});

test('69: the same person twice, by address or by name, lands once', () => {
  const d = doc({ 'assigned-to': ['a@b', 'a@b', 'Ann'] });
  assert.deepEqual(plain(peopleByKey(d, ASSIGN)), [{ name: '', email: 'a@b' }, { name: 'Ann', email: '' }]);
});

test('70: a relationship is resolved out of included', () => {
  const d = {
    data: { attributes: {}, relationships: { assignees: { data: [{ type: 'user', id: '1' }] } } },
    included: [{ type: 'user', id: '1', attributes: { name: 'Ann', email: 'a@b' } }],
  };
  assert.deepEqual(plain(peopleByKey(d, ASSIGN)), [{ name: 'Ann', email: 'a@b' }]);
});

test('71: a payload naming nobody says nothing — undefined, never an empty list', () => {
  assert.equal(runAssigneesOf(doc({ title: 'Nightly' })), undefined);
  assert.deepEqual(plain(runAssigneesOf(doc({ 'assigned-to': 'Ann' }))), [{ name: 'Ann', email: '' }]);
});

// ---- runInfoOf: the fields v2 does not serialize ----

test('72: zero, non-numeric and empty-key substatus counters are dropped', () => {
  const info = mod.runInfoOf(doc({ 'substatuses-counts': { a: 2, b: 0, c: 'x', '': 5 } }));
  assert.deepEqual(plain(info.substatusCounts), { a: 2 });
});

test('73: no counters at all is null, not an empty map', () => {
  assert.equal(mod.runInfoOf(doc({ status: 'passed' })).substatusCounts, null);
});

test('74: an absent is-archived is null, so a write response cannot unlock a run', () => {
  assert.equal(mod.runInfoOf(doc({ status: 'passed' })).isArchived, null);
  assert.equal(mod.runInfoOf(doc({ 'is-archived': true })).isArchived, true);
});

test('75: an unreadable duration is zero seconds', () => {
  assert.equal(mod.runInfoOf(doc({ duration: 'x' })).duration, 0);
});

// The run card reads these by name, so a field quietly dropped from the shape shows as a blank
// card rather than a failure. The whole mapping is pinned, not only the three tricky ones.
test('75b: every field the run card reads is mapped from its own attribute', () => {
  const info = mod.runInfoOf(doc({
    status: 'failed',
    'is-archived': false,
    'ci-build-url': 'https://ci.example.com/42',
    duration: '90',
    'launched-at': '2026-09-01T10:00:00Z',
    'finished-at': '2026-09-01T10:01:30Z',
  }));
  assert.equal(info.status, 'failed');
  assert.equal(info.isArchived, false);
  assert.equal(info.ciBuildUrl, 'https://ci.example.com/42');
  assert.equal(info.duration, 90);
  assert.equal(info.launchedAt, '2026-09-01T10:00:00Z');
  assert.equal(info.finishedAt, '2026-09-01T10:01:30Z');
  // Absent is null, never an empty string: the card hides the row instead of drawing a blank one.
  const bare = mod.runInfoOf(doc({}));
  assert.deepEqual([bare.status, bare.ciBuildUrl, bare.launchedAt, bare.finishedAt], [null, null, null, null]);
});

// ---- the dashboard shapes ----

test('76: an env list is joined, and anything else is an empty string', () => {
  assert.equal(normEnv(['Chrome', 'Linux']), 'Chrome, Linux');
  assert.equal(normEnv(null), '');
  assert.equal(normEnv([null, 'a']), 'a');
});

test('77: the camelCase dashboard meta is read into the one page shape', () => {
  const meta = { page: '2', perPage: 30, totalCount: 90, totalPages: 3 };
  assert.deepEqual(plain(pageResult([], 3, meta, DASH_KEYS)),
    { items: [], page: 2, perPage: 30, total: 90, totalPages: 3 });
});

test('78: no meta leaves the asked-for page and three nulls', () => {
  assert.deepEqual(plain(pageResult([], 3, undefined, DASH_KEYS)),
    { items: [], page: 3, perPage: null, total: null, totalPages: null });
});

test('79: a meta page of 0 falls back to the page we asked for', () => {
  assert.equal(pageResult([], 3, { page: 0 }, DASH_KEYS).page, 3);
});

// ---- the suite tree ----

test('80: a tree node is normalised whole, children included', () => {
  const node = normSuiteNode({ id: 1, fileType: 'folder', testCount: null, children: [{ id: 2 }] });
  assert.deepEqual(plain(node), {
    id: 1,
    title: '',
    file_type: 'folder',
    test_count: 0,
    emoji: null,
    children: [{ id: 2, title: '', file_type: 'file', test_count: 0, emoji: null, children: [] }],
  });
});

test('81: position orders the level, an unknown id sorts as 0, and ties keep server order', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const positions = new Map([['a', 3], ['b', 1], ['d', 1]]);
  assert.deepEqual(plain(orderSuiteTree(nodes, positions)).map((n) => n.id), ['c', 'b', 'd', 'a']);
});

// ---- parametrized run rows ----

test('84: an example array keeps its cells, positional to the test params', () => {
  const out = testrunExampleOf({ example: ['a', '', 'b'], test: { params: ['x', 'y', 'z'] } });
  assert.deepEqual(plain(out), { values: ['a', '', 'b'], params: ['x', 'y', 'z'] });
});

test('85: an all-empty example is not a parametrized row at all', () => {
  assert.equal(testrunExampleOf({ example: ['', '', ''] }), null);
});

test('86: the object form names its own params, and drops the empty cells', () => {
  const out = testrunExampleOf({ example: { city: 'Kyiv', zip: '' } });
  assert.deepEqual(plain(out), { values: ['Kyiv'], params: ['city'] });
});

test('87: numbers and booleans are values; without test params there are no names', () => {
  assert.deepEqual(plain(testrunExampleOf({ example: [1, true] })), { values: ['1', 'true'], params: null });
});
