#!/usr/bin/env node
// The contract of extension/editor/params-grid.js (#192): the model any seed is squared off into,
// what plan() refuses to save, what commit() writes when a leg fails, and the draft/baseline guard.
// Cases numbered as in #192. Run: node --test tests/params-grid.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// PGRID_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.PGRID_SRC || join(repoRoot, 'extension/editor/params-grid.js');
const source = readFileSync(SRC, 'utf8');

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One sandbox per test: the control keeps module state (baseline, ready, available) and the grid
// hands out focus, so a shared document would let one case decide the next one's answer.
// `fails(name, args, nth)` returning a string is how a leg of commit() is made to reject.
function load({ fails = () => null } = {}) {
  const calls = [];
  const tips = [];
  const call = async (name, ...args) => {
    calls.push([name, ...args]);
    const msg = fails(name, args, calls.length);
    if (msg) throw new Error(msg);
  };
  const document = makeDocument();
  const ctx = createContext({
    document,
    Icons: { markup: (name, size) => `<i class="icon" data-name="${name}" data-size="${size}"></i>` },
    Tooltip: { set: (el, tip) => tips.push([el.id || el.className, tip]) },
    TestomatAPI: {
      setTestParams: (...a) => call('setTestParams', ...a),
      createExample: (...a) => call('createExample', ...a),
      updateExample: (...a) => call('updateExample', ...a),
      deleteExample: (...a) => call('deleteExample', ...a),
    },
  });
  const ParamsGrid = runInContext(`${source}\nParamsGrid;`, ctx);
  return { ParamsGrid, document, calls, tips };
}

// The control mounted into the document — focus() only records on an attached tree, and cases 41
// and 42 are about where the caret lands.
function mount({ seed = null, fails } = {}) {
  const env = load({ fails });
  const edits = [];
  const ctl = env.ParamsGrid.buildParamsControl({ seed, onEdited: () => edits.push(1) });
  env.document.body.append(ctl.section);
  const q = (sel) => ctl.section.querySelector(sel);
  return {
    ...env,
    ctl,
    edits,
    q,
    cell: (row, col) => q(`input[data-row="${row}"][data-col="${col}"]`),
    error: () => q('#tc-params-error'),
    open: () => q('#tc-params-head').getAttribute('aria-expanded') === 'true',
  };
}

// Typing into a cell, which is the only way the model ever changes.
const typeIn = (el, value) => { el.value = value; fire(el, 'input'); };

const { paramsModel, cloneParams, paramsHaveData } = load().ParamsGrid;

test('the module publishes exactly the surface editor.js and the tests reach for', () => {
  assert.deepEqual(Object.keys(load().ParamsGrid).sort(), [
    'buildParamsControl', 'cloneParams', 'paramText', 'paramsHaveData', 'paramsModel',
  ]);
  // cloneParams is a real copy: the rows are rebuilt, not shared with the model they came from.
  const m = paramsModel({ headers: ['a'], rows: [['1']] });
  const copy = cloneParams(m);
  copy.rows[0].cells[0] = 'changed';
  copy.headers[0] = 'b';
  assert.deepEqual(plain(m.rows[0].cells), ['1']);
  assert.deepEqual(plain(m.headers), ['a']);
  // paramsHaveData is what decides whether the fold opens by itself.
  assert.equal(paramsHaveData(paramsModel(null)), false);
  assert.equal(paramsHaveData(paramsModel({ headers: ['  '] })), false);
  assert.equal(paramsHaveData(paramsModel({ headers: ['a'] })), true);
  assert.equal(paramsHaveData(paramsModel({ rows: [['x']] })), true);
});

// ===================== paramsModel: any seed, squared off ===================

test('37: no seed at all is still one column, so there is something to name', () => {
  assert.deepEqual(plain(paramsModel(null)), { headers: [''], rows: [], removed: [] });
  assert.deepEqual(plain(paramsModel(undefined)), { headers: [''], rows: [], removed: [] });
});

test('38: the widest row decides the width, and every cell is a string', () => {
  const m = paramsModel({ headers: ['a'], rows: [[1, 2, 3]] });
  assert.deepEqual(plain(m), {
    headers: ['a', '', ''],
    rows: [{ id: null, cells: ['1', '2', '3'] }],
    removed: [],
  });
});

test('39: a server row keeps its id, stringified', () => {
  const m = paramsModel({ headers: ['a'], rows: [{ id: 7, cells: ['x'] }] });
  assert.deepEqual(plain(m.rows), [{ id: '7', cells: ['x'] }]);
  // `removed` is stringified the same way, so a delete list survives a draft round trip.
  assert.deepEqual(plain(paramsModel({ removed: [7, '8'] }).removed), ['7', '8']);
});

test('40: a bare array row has no id — it was never written to the server', () => {
  assert.deepEqual(plain(paramsModel({ rows: [['x']] }).rows), [{ id: null, cells: ['x'] }]);
  // A null cell is the empty string, not the word "null".
  assert.deepEqual(plain(paramsModel({ rows: [[null, undefined]] }).rows), [{ id: null, cells: ['', ''] }]);
});

// ===================== plan(): what Save is allowed to write ================

test('41: a value under a nameless column stops the save and points at that column', () => {
  const g = mount({ seed: { headers: ['a', ''], rows: [['1', '2']] } });
  assert.equal(g.ctl.plan(), null);
  assert.equal(g.error().textContent, 'Every parameter needs a name');
  assert.equal(g.error().hidden, false);
  assert.equal(g.open(), true);
  assert.equal(g.document.activeElement, g.cell('head', 1));
});

test('42: rows with no header anywhere ask for the names first', () => {
  const g = mount({ seed: { headers: [''], rows: [['v']] } });
  assert.equal(g.ctl.plan(), null);
  assert.equal(g.error().textContent, 'Name the parameters first');
  assert.equal(g.open(), true);
  assert.equal(g.document.activeElement, g.cell('head', 0));
});

test('43: a trailing column nobody named or used never travels', () => {
  const g = mount({ seed: { headers: ['a', ''], rows: [['1', '']] } });
  const p = plain(g.ctl.plan());
  assert.deepEqual(p.headers, ['a']);
  assert.deepEqual(p.writes, [{ kind: 'create', id: null, cells: ['1'] }]);
});

test('44: a server row emptied to blanks is a delete, not a write', () => {
  const g = mount({ seed: { headers: ['a'], rows: [{ id: '5', cells: [''] }] } });
  const p = plain(g.ctl.plan());
  assert.deepEqual(p.deletes, ['5']);
  assert.deepEqual(p.writes, []);
});

test('45: a blank row that was never written just goes', () => {
  const g = mount({ seed: { headers: ['a'], rows: [[' ']] } });
  const p = plain(g.ctl.plan());
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.writes, []);
});

test('46: a server row nobody touched is filtered out of the writes', () => {
  const g = mount();
  g.ctl.load({ headers: ['a'], rows: [{ id: '1', cells: ['x'] }] });
  assert.deepEqual(plain(g.ctl.plan()), {
    headers: ['a'], headersChanged: false, writes: [], deletes: [],
  });
  // One keystroke in that row and it is a write again.
  typeIn(g.cell(0, 0), 'y');
  assert.deepEqual(plain(g.ctl.plan()).writes, [{ kind: 'update', id: '1', cells: ['y'] }]);
});

test('47: in basic mode plan() is an empty plan, never a refusal', () => {
  const g = mount({ seed: { headers: ['a'], rows: [['1']] } });
  g.ctl.disable();
  assert.equal(g.ctl.available(), false);
  assert.equal(g.ctl.section.hidden, true);
  assert.deepEqual(plain(g.ctl.plan()), {
    headers: [], headersChanged: false, writes: [], deletes: [],
  });
});

// 48 and 49 are the two names plan() does not check; the todos for them are at the end of the file.

test('48/49 (today): a duplicate name and a name outside [\\w-] are both saved as typed', () => {
  const dup = mount({ seed: { headers: ['email', 'email'], rows: [['a@x', 'b@x']] } });
  assert.deepEqual(plain(dup.ctl.plan()).headers, ['email', 'email']);
  assert.equal(dup.error().hidden, true);
  const odd = mount({ seed: { headers: ['price(usd)', 'a)'], rows: [['9', 'b']] } });
  assert.deepEqual(plain(odd.ctl.plan()).headers, ['price(usd)', 'a)']);
  assert.equal(odd.error().hidden, true);
});

test('50: Save writes the trimmed name, while the grid keeps what the tester typed', () => {
  const g = mount({ seed: { headers: [' email '], rows: [[' v ']] } });
  const p = plain(g.ctl.plan());
  assert.deepEqual(p.headers, ['email']);
  assert.deepEqual(p.writes, [{ kind: 'create', id: null, cells: ['v'] }]);
  assert.deepEqual(plain(g.ctl.get()).headers, [' email ']);
  assert.deepEqual(plain(g.ctl.get()).rows, [{ id: null, cells: [' v '] }]);
});

// ===================== commit(): best-effort, first message wins ============

const planOf = (over = {}) => ({
  headers: ['a'], headersChanged: false, writes: [], deletes: [], ...over,
});

test('51: the names leg failing does not hold back the rows behind it', async () => {
  const g = mount({ fails: (name) => (name === 'setTestParams' ? 'no params for you' : null) });
  const msg = await g.ctl.commit('uid1', planOf({
    headersChanged: true,
    writes: [{ kind: 'create', id: null, cells: ['1'] }, { kind: 'update', id: '9', cells: ['2'] }],
  }));
  assert.equal(msg, 'no params for you');
  assert.deepEqual(plain(g.calls), [
    ['setTestParams', 'uid1', ['a']],
    ['createExample', 'uid1', ['1']],
    ['updateExample', '9', ['2']],
  ]);
});

test('52: write 2 of 3 failing still lets writes 1 and 3 out, and reports once', async () => {
  const g = mount({ fails: (name, args) => (args[1] && args[1][0] === '2' ? 'row two blew up' : null) });
  const msg = await g.ctl.commit('uid1', planOf({
    writes: [1, 2, 3].map((n) => ({ kind: 'create', id: null, cells: [String(n)] })),
    deletes: ['77'],
  }));
  assert.equal(msg, 'row two blew up');
  assert.deepEqual(plain(g.calls), [
    ['createExample', 'uid1', ['1']],
    ['createExample', 'uid1', ['2']],
    ['createExample', 'uid1', ['3']],
    ['deleteExample', '77'],
  ]);
});

test('53: everything through is a null, which is what Save reads as success', async () => {
  const g = mount();
  const msg = await g.ctl.commit('uid1', planOf({
    headersChanged: true,
    writes: [{ kind: 'create', id: null, cells: ['1'] }],
    deletes: ['5'],
  }));
  assert.equal(msg, null);
  assert.equal(g.calls.length, 3);
  // A thrown non-Error still reads as a sentence rather than as `undefined`.
  const bad = mount({ fails: () => 'plain string' });
  assert.equal(await bad.ctl.commit('uid1', planOf({ headersChanged: true })), 'plain string');
});

// ===================== the grid the tester actually touches =================

test('54: typing nothing into the blank row does not make it a row', () => {
  const g = mount({ seed: { headers: ['a'], rows: [] } });
  typeIn(g.cell('new', 0), '');
  assert.deepEqual(plain(g.ctl.get()).rows, []);
  assert.equal(g.edits.length, 0);
  // One character does make it one, and the grid grows another blank row under it.
  typeIn(g.cell('new', 0), 'x');
  assert.deepEqual(plain(g.ctl.get()).rows, [{ id: null, cells: ['x'] }]);
  assert.equal(g.edits.length, 1);
  assert.equal(g.document.activeElement, g.cell(0, 0));
  assert.ok(g.cell('new', 0));
});

test('55: the last column cannot be dropped — one always stays', () => {
  const g = mount();
  const drop = g.q('#tc-params-drop-col');
  assert.equal(drop.disabled, true);
  fire(drop, 'click');
  assert.deepEqual(plain(g.ctl.get()).headers, ['']);
  assert.equal(g.edits.length, 0);
  fire(g.q('#tc-params-add-col'), 'click');
  assert.equal(g.q('#tc-params-drop-col').disabled, false);
  fire(g.q('#tc-params-drop-col'), 'click');
  assert.deepEqual(plain(g.ctl.get()).headers, ['']);
});

// ===================== draft() and load(): whose copy wins =================

test('56: an unread grid hands out no draft, so it cannot overwrite real parameters', () => {
  const g = mount();
  assert.equal(g.ctl.draft(), null);
  g.ctl.ready();
  assert.deepEqual(plain(g.ctl.draft()), { headers: [''], rows: [], removed: [] });
  // Basic mode takes the draft away again: there is nothing to write it back with.
  g.ctl.disable();
  assert.equal(g.ctl.draft(), null);
});

test('57: a draft outranks the server read — only the baseline is taken from it', () => {
  const g = mount({ seed: { headers: ['draft'], rows: [['d']] } });
  g.ctl.load({ headers: ['srv'], rows: [{ id: '9', cells: ['s'] }] });
  assert.deepEqual(plain(g.ctl.get()), {
    headers: ['draft'], rows: [{ id: null, cells: ['d'] }], removed: [],
  });
  // The baseline landed all the same: the draft's header now reads as a change.
  const p = plain(g.ctl.plan());
  assert.equal(p.headersChanged, true);
  assert.deepEqual(p.headers, ['draft']);
  // …and the same load on a grid with no draft behind it replaces the model.
  const fresh = mount();
  fresh.ctl.load({ headers: ['srv'], rows: [{ id: '9', cells: ['s'] }] });
  assert.deepEqual(plain(fresh.ctl.get()).headers, ['srv']);
  assert.equal(fresh.open(), true);
});

// ===================== what #112 will add, carried over unfixed =============

// 48: `params.js` resolves both `${email}` occurrences to the FIRST column (tests/params.test.mjs
// P13), so the second column's values are unreachable and the tester is never told.
test.todo('48 (#112): two columns with the same name are refused before Save', () => {
  const g = mount({ seed: { headers: ['email', 'email'], rows: [['a@x', 'b@x']] } });
  assert.equal(g.ctl.plan(), null);
  assert.equal(g.error().textContent, 'Two parameters have the same name');
  assert.equal(g.document.activeElement, g.cell('head', 1));
});

// 49: #192 said such a name breaks substitution downstream. It no longer does — #244 escapes the
// name in params.js and `${price(usd)}` resolves (P7). What is left is only the missing check.
test.todo('49 (#112): a column name outside [\\w-] is refused before Save', () => {
  const g = mount({ seed: { headers: ['price(usd)'], rows: [['9']] } });
  assert.equal(g.ctl.plan(), null);
  assert.equal(g.document.activeElement, g.cell('head', 0));
});
