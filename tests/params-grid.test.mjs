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
// The glyph names the grid draws through, evaluated into the same context editor.html loads them
// into — a stub here would let the two drift without a test noticing.
const iconsSource = readFileSync(join(repoRoot, 'extension/editor/editor-icons.js'), 'utf8');

// Values built inside the vm realm carry that realm's prototypes: compare them as plain JSON.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// One sandbox per test: the control keeps module state (baseline, ready, available) and the grid
// hands out focus, so a shared document would let one case decide the next one's answer.
// `fails(name, args, nth)` returning a string is how a leg of commit() is made to reject, and
// `reply(name, args, nth)` is what a leg that goes through answers with — `createExample`'s id.
function load({ fails = () => null, reply = () => undefined } = {}) {
  const calls = [];
  const tips = [];
  const call = async (name, ...args) => {
    calls.push([name, ...args]);
    const msg = fails(name, args, calls.length);
    if (msg) throw new Error(msg);
    return reply(name, args, calls.length);
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
  runInContext(iconsSource, ctx);
  const ParamsGrid = runInContext(`${source}\nParamsGrid;`, ctx);
  return { ParamsGrid, document, calls, tips };
}

// The control mounted into the document — focus() only records on an attached tree, and cases 41
// and 42 are about where the caret lands.
function mount({ seed = null, fails, reply } = {}) {
  const env = load({ fails, reply });
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

// 48, the duplicate name, is the check #112 adds below (58-60). 49, a name outside [\w-], stays
// allowed on purpose: #244 escaped the name in params.js, so `price(usd)` resolves and refusing it
// would take away a column testers can use today.
test('49 (today): a name outside [\\w-] is saved as typed, and #112 leaves it that way', () => {
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

// ===================== #112: two columns may not share a name ==============

test('58 (#112): two columns with the same name are refused, pointing at the second', () => {
  const g = mount({ seed: { headers: ['email', 'email'], rows: [['a@x', 'b@x']] } });
  assert.equal(g.ctl.plan(), null);
  assert.equal(g.error().textContent, 'Two parameters have the same name');
  assert.equal(g.error().hidden, false);
  assert.equal(g.open(), true);
  assert.equal(g.document.activeElement, g.cell('head', 1));
  // The second of the PAIR, not the last column: a, b, a points at index 2.
  const three = mount({ seed: { headers: ['a', 'b', 'a'], rows: [['1', '2', '3']] } });
  assert.equal(three.ctl.plan(), null);
  assert.equal(three.document.activeElement, three.cell('head', 2));
});

test('59 (#112): the names are compared trimmed, and case tells two of them apart', () => {
  // What Save would write is what is compared: ' email ' and 'email' are one name.
  const same = mount({ seed: { headers: [' email ', 'email'], rows: [['a', 'b']] } });
  assert.equal(same.ctl.plan(), null);
  assert.equal(same.error().textContent, 'Two parameters have the same name');
  // The server keeps the case and nothing downstream folds it, so these are two parameters.
  const cased = mount({ seed: { headers: ['email', 'Email'], rows: [['a', 'b']] } });
  assert.deepEqual(plain(cased.ctl.plan()).headers, ['email', 'Email']);
  assert.equal(cased.error().hidden, true);
});

test('60 (#112): a repeat cannot hide behind a column nobody filled in', () => {
  // A NAMED column travels even with nothing under it (43 drops only the unnamed ones), so the
  // second `a` is written to the test and has to be refused.
  const unused = mount({ seed: { headers: ['a', 'a'], rows: [['1', '']] } });
  assert.equal(unused.ctl.plan(), null);
  assert.equal(unused.error().textContent, 'Two parameters have the same name');
  // Blank names are never a duplicate pair: with nothing in them the grid is an empty plan…
  const spare = mount({ seed: { headers: ['', ''], rows: [] } });
  assert.deepEqual(plain(spare.ctl.plan()), {
    headers: [], headersChanged: false, writes: [], deletes: [],
  });
  // …and with a value under one, it is the nameless refusal that speaks first.
  const used = mount({ seed: { headers: ['', ''], rows: [['1', '']] } });
  assert.equal(used.ctl.plan(), null);
  assert.equal(used.error().textContent, 'Name the parameters first');
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

// ============ #112: a write that failed can be sent again, and only it ======

// The shape createExample answers with, keyed off the row's first cell so the id says which row
// the server made — `{id, data}`, as api.js builds it.
const madeExample = (name, args) => (name === 'createExample' ? { id: `ex-${args[1][0]}`, data: args[1] } : undefined);

test('61 (#112): after a partial write the second plan() carries only the row that failed', async () => {
  let flaky = true; // …until the retry, which is when the second row goes through
  const g = mount({
    seed: { headers: ['a'], rows: [['1'], ['2']] },
    fails: (name, args) => (flaky && args[1] && args[1][0] === '2' ? 'row two blew up' : null),
    reply: madeExample,
  });
  const first = g.ctl.plan();
  assert.deepEqual(plain(first.writes), [
    { kind: 'create', id: null, cells: ['1'] },
    { kind: 'create', id: null, cells: ['2'] },
  ]);
  assert.equal(await g.ctl.commit('uid1', first), 'row two blew up');
  // The row that landed took the server's id; the one that failed still has none.
  assert.deepEqual(plain(g.ctl.get()).rows, [
    { id: 'ex-1', cells: ['1'] },
    { id: null, cells: ['2'] },
  ]);
  const second = g.ctl.plan();
  assert.equal(second.headersChanged, false); // the names leg landed with the first row
  assert.deepEqual(plain(second.writes), [{ kind: 'create', id: null, cells: ['2'] }]);
  // The second Save sends exactly that one write — the names and the first row never go again.
  flaky = false;
  assert.equal(await g.ctl.commit('uid1', second), null);
  assert.deepEqual(plain(g.calls), [
    ['setTestParams', 'uid1', ['a']],
    ['createExample', 'uid1', ['1']],
    ['createExample', 'uid1', ['2']],
    ['createExample', 'uid1', ['2']],
  ]);
  // …and now the grid holds what the server holds: a third Save has nothing to send.
  assert.deepEqual(plain(g.ctl.get()).rows, [
    { id: 'ex-1', cells: ['1'] },
    { id: 'ex-2', cells: ['2'] },
  ]);
  const third = g.ctl.plan();
  assert.equal(third.headersChanged, false);
  assert.deepEqual(plain(third.writes), []);
});

test('62 (#112): when nothing lands, the second plan() carries every leg again', async () => {
  const g = mount({
    seed: { headers: ['a'], rows: [['1'], ['2']] },
    fails: () => 'the network went away',
    reply: madeExample,
  });
  assert.equal(await g.ctl.commit('uid1', g.ctl.plan()), 'the network went away');
  const second = g.ctl.plan();
  assert.equal(second.headersChanged, true);
  assert.deepEqual(plain(second.writes), [
    { kind: 'create', id: null, cells: ['1'] },
    { kind: 'create', id: null, cells: ['2'] },
  ]);
  assert.deepEqual(plain(g.ctl.get()).rows, [
    { id: null, cells: ['1'] }, { id: null, cells: ['2'] },
  ]);
});

test('63 (#112): a create that landed is updated by the retry, never created twice', async () => {
  const g = mount({ seed: { headers: ['a'], rows: [['1']] }, reply: madeExample });
  assert.equal(await g.ctl.commit('uid1', g.ctl.plan()), null);
  // Nothing has changed since, so a second Save has nothing at all to send.
  assert.deepEqual(plain(g.ctl.plan()).writes, []);
  // One keystroke in that row and it is an UPDATE of the example the create made.
  typeIn(g.cell(0, 0), '1b');
  const retry = g.ctl.plan();
  assert.deepEqual(plain(retry.writes), [{ kind: 'update', id: 'ex-1', cells: ['1b'] }]);
  assert.equal(await g.ctl.commit('uid1', retry), null);
  assert.deepEqual(plain(g.calls), [
    ['setTestParams', 'uid1', ['a']],
    ['createExample', 'uid1', ['1']],
    ['updateExample', 'ex-1', ['1b']],
  ]);
});

test('64 (#112): a create the server answered without an id is created again', async () => {
  // Nothing came back to update, so the honest retry is another create — and the row still has
  // no id. This is the one case where a second Save can leave two examples behind.
  const g = mount({ seed: { headers: ['a'], rows: [['1']] } });
  assert.equal(await g.ctl.commit('uid1', g.ctl.plan()), null);
  assert.deepEqual(plain(g.ctl.get()).rows, [{ id: null, cells: ['1'] }]);
  assert.deepEqual(plain(g.ctl.plan()).writes, [{ kind: 'create', id: null, cells: ['1'] }]);
});

test('65 (#112): an update that landed leaves the plan, one that failed stays in it', async () => {
  const g = mount({ fails: (name, args) => (args[1] && args[1][0] === 'y2' ? 'row two blew up' : null) });
  g.ctl.load({ headers: ['a'], rows: [{ id: '1', cells: ['x'] }, { id: '2', cells: ['y'] }] });
  typeIn(g.cell(0, 0), 'x2');
  typeIn(g.cell(1, 0), 'y2');
  const first = g.ctl.plan();
  assert.deepEqual(plain(first.writes), [
    { kind: 'update', id: '1', cells: ['x2'] },
    { kind: 'update', id: '2', cells: ['y2'] },
  ]);
  assert.equal(await g.ctl.commit('uid1', first), 'row two blew up');
  assert.deepEqual(plain(g.ctl.plan()).writes, [{ kind: 'update', id: '2', cells: ['y2'] }]);
});

test('66 (#112): the names leg is sent again only when it did not land', async () => {
  const g = mount({ seed: { headers: ['a'], rows: [] } });
  assert.equal(g.ctl.plan().headersChanged, true);
  assert.equal(await g.ctl.commit('uid1', g.ctl.plan()), null);
  assert.equal(g.ctl.plan().headersChanged, false);
  // Renaming the column after that is a change again.
  typeIn(g.cell('head', 0), 'b');
  assert.equal(g.ctl.plan().headersChanged, true);
  // The same write against a leg that refuses it stays on the plan.
  const bad = mount({ seed: { headers: ['a'], rows: [] }, fails: () => 'no params for you' });
  assert.equal(await bad.ctl.commit('uid1', bad.ctl.plan()), 'no params for you');
  assert.equal(bad.ctl.plan().headersChanged, true);
});

test('67 (#112): a delete that landed leaves the plan, and one that failed is sent again', async () => {
  // Both kinds of delete in one grid: row 1 is taken out with its ✕, row 2 is emptied in place.
  const setup = (bad) => {
    const g = mount({ fails: (name, args) => (name === 'deleteExample' && args[0] === bad ? 'delete blew up' : null) });
    g.ctl.load({ headers: ['a'], rows: [{ id: '1', cells: ['x'] }, { id: '2', cells: ['y'] }] });
    fire(g.q('.tc-params-remove[data-row="0"]'), 'click');
    typeIn(g.cell(0, 0), '');
    return g;
  };
  const a = setup('2');
  const firstA = a.ctl.plan();
  assert.deepEqual(plain(firstA.deletes), ['1', '2']);
  assert.equal(await a.ctl.commit('uid1', firstA), 'delete blew up');
  assert.deepEqual(plain(a.ctl.plan()).deletes, ['2']);
  // The other way round: the emptied row's delete lands and the spliced-out one's does not.
  const b = setup('1');
  assert.equal(await b.ctl.commit('uid1', b.ctl.plan()), 'delete blew up');
  assert.deepEqual(plain(b.ctl.plan()).deletes, ['1']);
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
