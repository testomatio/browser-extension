#!/usr/bin/env node
// What extension/sidepanel/screens/test-view.js SHOWS the tester (#164, half B): the steps they are
// about to run through, and the example row substituted into them. The result summary card that used
// to sit beside them is its own file now, with its own suite (tests/test-summary.test.mjs); half A
// (the write path) is tests/test-view-write.test.mjs.
// One thing here is easy to get quietly wrong. A step's `pos` is the index among ALL <li> in the
// rendered description, nested bullets included, because that is what the web runner counts — and it
// is snapshotted BEFORE the Expected sub-bullets are folded away, so folding one must not renumber
// the steps after it.
// Rows 26-29 and 110-125 are the ticket's; a lettered suffix is the companion case that drives
// the same path the other way, so a row asserting "nothing happened" cannot pass against a stub that
// never worked.
// Run: node --test tests/test-view-read.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The real substitution module, not a look-alike: rows 121-124 are about the product's own non-"0"
// rule and the double quotes it wraps a value in. PARAMS_SRC mirrors params.test.mjs's own seam.
const PARAMS_SRC = process.env.PARAMS_SRC || join(repoRoot, 'extension/params.js');
const TestomatParams = runInNewContext(`${readFileSync(PARAMS_SRC, 'utf8')}\nTestomatParams;`, {});

// ---------- what Md.render really emits ----------
// Captured once from the real pipeline (vendor/showdown.min.js + shared/html-sanitize.js +
// shared/markdown.js over the mini-DOM) and frozen here: markdown.js needs a `showdown` global and a
// lexical `sanitizeHtml` from another file, so it is not reachable beside a screen. These strings are
// what the tester's description actually becomes.
const MD = {
  // '## Steps' + two bullets
  twoSteps: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site</li>\n<li>Click Login</li>\n</ul>',
  // …with a nested `- Expected: green banner` under the first
  nestedExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>Expected: green banner</li></ul></li>\n<li>Click Login</li>\n</ul>',
  // …where that sub-bullet was the list's only child
  onlyExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>Expected: green banner</li></ul></li>\n</ul>',
  // '- Do X. **Expected Result**: Y.' — the bolded label mid-<li>
  inlineExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n'
    + '<li>Do X. <strong>Expected Result</strong>: Y.</li>\n<li>Click Login</li>\n</ul>',
  bothSpellings: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>One<ul>\n<li>Expected: a</li></ul></li>\n'
    + '<li>Two<ul>\n<li>Expected Results: b</li></ul></li>\n</ul>',
  // a label-shaped bullet that is not the label
  notExpected: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>One<ul>\n'
    + '<li>Expectations: a</li></ul></li>\n</ul>',
  softBreak: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>line one<br>line two</li>\n</ul>',
  // '- [ ] do it' — showdown's tasklists extension, disabled box and all
  taskItem: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li style="list-style-type: none;" '
    + 'class="task-list-item"><input type="checkbox" disabled="" style="margin: 0px 0.35em 0.25em -1.6em; '
    + 'vertical-align: middle;"> do it</li>\n</ul>',
  stepsThenNotes: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site</li>\n'
    + '<li>Click Login</li>\n</ul>\n<h2 id="notes">Notes</h2>\n<ul>\n<li>a note</li>\n</ul>',
  nestedPlain: '<h2 id="steps">Steps</h2>\n<ul class="md-steps">\n<li>Open the site<ul>\n'
    + '<li>not expected at all</li></ul></li>\n<li>Click Login</li>\n</ul>',
  // the same nesting, but under a heading that makes the outer bullet an item rather than a step
  nestedItem: '<h2 id="notes">Notes</h2>\n<ul>\n<li>a note<ul>\n<li>nested note</li></ul></li>\n'
    + '<li>another</li>\n</ul>',
  // the same two lists under a heading that is not "Steps"
  noStepsHeading: '<h2 id="notes">Notes</h2>\n<ul>\n<li>a note</li>\n<li>another</li>\n</ul>',
};

// shared/markdown.js:61-72, verbatim: which lists are the STEPS is the renderer's answer, and a body
// with no Steps-like heading has none — the contract row 119 turns on.
const STEPS_HEADING = /step|крок/i;
function stepLists(container) {
  const heading = container.querySelectorAll('h1,h2,h3,h4').find((h) => STEPS_HEADING.test(h.textContent));
  if (!heading) return [];
  const lists = [];
  let node = heading.nextElementSibling;
  while (node && !/^H[1-4]$/.test(node.tagName)) {
    if (node.tagName === 'UL' || node.tagName === 'OL') lists.push(node);
    node = node.nextElementSibling;
  }
  return lists;
}

// index.html's shape (:570-572, :611), cut to the two nodes half B touches.
function makePage(without = []) {
  const doc = makeDocument([]);
  const node = {};
  const add = (tag, id, props = {}) => {
    if (without.includes(id)) return null;
    node[id] = el(tag, { id, ...props });
    return node[id];
  };
  const steps = add('div', 'test-steps');
  const badge = add('span', 'example-badge', { hidden: true });
  doc.body.append(...[steps, badge].filter(Boolean));
  return { doc, node };
}

// The panel globals test-view.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the ones beside this land in parallel.
function load(opts = {}) {
  const o = {
    jwt: true,
    testrunDetail: null,
    without: [],          // page ids to leave out
    md: {},               // markdown source -> the html Md.render answers with
    ...opts,
  };

  const { doc, node } = makePage(o.without);
  const calls = {
    order: [],
    renders: [],     // every string handed to Md.render
    hydrates: [],    // ImgHydrate.hydrate(group, container)
    releases: [],    // ImgHydrate.release(group)
    empties: [],     // { host, title, icon, compact }
  };

  const state = {
    currentRecordId: '55',
    testrunDetail: o.testrunDetail,
    currentSteps: [],
    stepTicks: {},
  };

  const globals = {
    state,
    capabilities: { jwt: o.jwt, readonly: false },
    $: (id) => doc.getElementById(id),
    TestomatParams,
    // shared/markdown.js's two answers: `render` off the frozen snapshots above, `stepLists` the
    // real algorithm — a stub that always found the lists would make row 119 pass for free.
    Md: {
      render: (md) => {
        calls.renders.push(md);
        calls.order.push('Md.render');
        const boxEl = doc.createElement('div');
        boxEl.innerHTML = o.md[md] !== undefined ? o.md[md] : `<p>${String(md)}</p>`;
        return boxEl;
      },
      stepLists,
    },
    ImgHydrate: {
      release: (group) => { calls.releases.push(group); calls.order.push(`release:${group}`); },
      hydrate: (group, container) => { calls.hydrates.push(group); calls.order.push('hydrate'); return container; },
    },
    // shared/empty-state.js's shape, cut to what these paths ask of it.
    EmptyState: {
      build: (opt = {}) => {
        calls.empties.push({ title: opt.title || '', icon: opt.icon || '', compact: !!opt.compact });
        const boxEl = doc.createElement(opt.tag || 'div');
        boxEl.className = `empty${opt.compact ? ' compact' : ''}`;
        boxEl.dataset.icon = opt.icon || '';
        boxEl.textContent = opt.title || opt.text || '';
        return boxEl;
      },
      into: (host, opt) => {
        if (!host) return null;
        const made = globals.EmptyState.build({ tag: host.tagName === 'UL' ? 'li' : 'div', ...opt });
        calls.empties[calls.empties.length - 1].host = host.id;
        host.replaceChildren(made);
        return made;
      },
    },
    svgIcon: (name, size, ...cls) => el('span', { className: ['icon', ...cls].join(' '), dataset: { icon: name } }),
    persistSession: () => {},
    toast: () => {},
  };

  const h = loadScreen('test-view', { document: doc, globals });

  return {
    ...h,
    state, calls, node, doc,
    // A rendered description, exactly as Md.render would hand it over.
    fixture: (markup) => { const c = doc.createElement('div'); c.innerHTML = markup; return c; },
  };
}

// A step row without its DOM node: the li holds a parent pointer, so plain() cannot see the row
// whole — and the list itself was built inside the vm, so it needs plain() to compare at all.
const rowsOf = (steps) => plain([...steps].map((s) => ({
  kind: s.kind, pos: s.pos, index: s.index, title: s.title, expected: s.expected, state: s.state,
})));

// ===================== the server step overlay (rows 26-29) =====================

const detail = (attributes) => ({ data: { attributes } });

// A Map built inside the vm is not this realm's Map, and its entries carry that realm's prototypes.
const entriesOf = (map) => plain([...map.entries()]);

test('26: the overlay is keyed by pos, and the unsorted list the route promises is sorted first', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: 2, status: 'failed' }, { pos: 0, status: 'passed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[0, 'passed'], [2, 'failed']]);
});

test('27: a pos that arrived as a string is not a position, and the entry is dropped', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: '1', status: 'failed' }, { pos: 1, status: 'passed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[1, 'passed']]);
});

test('28: two entries on the same pos — the later one in sorted order wins', () => {
  const h = load({ testrunDetail: detail({ steps: [{ pos: 1, status: 'passed' }, { pos: 1, status: 'failed' }] }) });
  assert.deepEqual(entriesOf(h.fn.serverStepStates()), [[1, 'failed']]);
});

test('29: no testrun detail, or steps that are not a list, is an empty overlay and no throw', () => {
  assert.equal(load().fn.serverStepStates().size, 0);
  assert.equal(load({ testrunDetail: detail({}) }).fn.serverStepStates().size, 0);
  assert.equal(load({ testrunDetail: detail({ steps: 'none' }) }).fn.serverStepStates().size, 0);
});

// ===================== parsing the steps out of a description (rows 110-120) =====================

test('110: a Steps heading and two bullets are two step rows, numbered from zero', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.twoSteps));
  assert.deepEqual(rowsOf(rows), [
    { kind: 'step', pos: 0, index: 0, title: 'Open the site', expected: '', state: 'unset' },
    { kind: 'step', pos: 1, index: 1, title: 'Click Login', expected: '', state: 'unset' },
  ]);
});

test('111: a nested Expected bullet is lifted out, removed, and does not renumber the step after it', () => {
  const h = load();
  const container = h.fixture(MD.nestedExpected);
  const rows = h.fn.parseSteps(container);
  assert.deepEqual(rowsOf(rows).map((r) => [r.pos, r.expected]), [[0, 'Expected: green banner'], [2, '']]);
  // pos 2, not 1: the index was snapshotted over the <li>s the web counts, before the fold.
  assert.equal(container.querySelectorAll('li').length, 2);
});

test('112: the list that held nothing but the Expected bullet goes with it', () => {
  const h = load();
  const container = h.fixture(MD.onlyExpected);
  h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('ul').length, 1); // the steps list, and no empty leftover
});

test('112a: a list that still has a bullet in it stays', () => {
  const h = load();
  const container = h.fixture(MD.bothSpellings.replace('<li>Expected: a</li>', '<li>Expected: a</li><li>keep me</li>'));
  h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('ul').length, 2); // the steps list plus the surviving sub-list
});

test('113: a bolded "Expected Result" mid-sentence lifts the whole tail out of the step title', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.inlineExpected));
  assert.deepEqual(rowsOf(rows).map((r) => [r.title, r.expected]), [
    ['Do X.', 'Expected Result: Y.'],
    ['Click Login', ''],
  ]);
});

test('114: both spellings of the label match', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.bothSpellings));
  assert.deepEqual(plain([...rows].map((r) => r.expected)), ['Expected: a', 'Expected Results: b']);
});

test('114a: a bullet that merely starts with the same letters is not the label', () => {
  const h = load();
  const container = h.fixture(MD.notExpected);
  const rows = h.fn.parseSteps(container);
  assert.equal(rows[0].expected, '');
  assert.equal(container.querySelectorAll('li').length, 2); // and it is left in the document
});

test('115: a soft line break is read as a space, never glued into one word', () => {
  const h = load();
  const container = h.fixture(MD.softBreak);
  const raw = container.querySelector('li').textContent;
  const rows = h.fn.parseSteps(container);
  assert.equal(rows[0].title, 'line one line two');
  assert.equal(raw, 'line oneline two'); // what textContent alone would have said: one word out of two
});

test('116: showdown\'s disabled task checkbox is removed — the control is the mark', () => {
  const h = load();
  const container = h.fixture(MD.taskItem);
  assert.equal(container.querySelectorAll('input').length, 1); // it really was there
  const rows = h.fn.parseSteps(container);
  assert.equal(container.querySelectorAll('input').length, 0);
  assert.equal(rows[0].title, 'do it');
});

test('117: a bullet list under another heading is an item row, listed after every step', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.stepsThenNotes));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.index, r.title]), [
    ['step', 0, 0, 'Open the site'],
    ['step', 1, 1, 'Click Login'],
    ['item', 2, 0, 'a note'],
  ]);
  assert.equal(rows[2].li.classList.contains('step-item'), true);
  assert.equal(rows[0].li.classList.contains('step-item'), false);
});

test('118: a bullet nested under a step counts in pos — and today it is listed as an item too', () => {
  const h = load();
  const container = h.fixture(MD.nestedPlain);
  const rows = h.fn.parseSteps(container);
  // The nested guard reads the grandparent, and wrapRow has already moved the step's sub-list under
  // a <div> by the time it runs, so the bullet no longer looks nested to it.
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.title]), [
    ['step', 0, 'Open the site'],
    ['step', 2, 'Click Login'],
    ['item', 1, 'not expected at all'],
  ]);
  assert.equal(container.querySelectorAll('li').length, 3); // still in the document, still counted
});

test('118a: the same bullet nested under an ITEM is dropped — that row is not wrapped yet', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.nestedItem));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.title]), [
    ['item', 0, 'a note'], ['item', 2, 'another'],
  ]);
});

test('119: a description with no Steps-like heading has no steps — everything is an item', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.noStepsHeading));
  assert.deepEqual(rowsOf(rows).map((r) => [r.kind, r.pos, r.index]), [['item', 0, 0], ['item', 1, 1]]);
  assert.equal([...rows].every((r) => r.li.classList.contains('step-item')), true);
});

test('119a: the same two lists under a Steps heading ARE steps', () => {
  const h = load();
  const rows = h.fn.parseSteps(h.fixture(MD.noStepsHeading.replace('Notes</h2>', 'Steps</h2>')));
  assert.deepEqual(plain([...rows].map((r) => r.kind)), ['step', 'step']);
});

test('120: a description that is blank or only spaces draws the No description state', () => {
  const h = load({ jwt: false });
  h.state.currentSteps = ['untouched'];
  for (const md of ['', '   ', null]) {
    h.fn.renderSteps(md, { id: 7 });
    assert.deepEqual(plain(h.state.currentSteps), ['untouched']);
    assert.equal(h.node['test-steps'].textContent, 'No description');
  }
  assert.deepEqual(h.calls.empties.map((e) => e.title), ['No description', 'No description', 'No description']);
});

test('120a: a description with something in it replaces the steps and draws no empty state', () => {
  const h = load({ jwt: false, md: { '## Steps\n- a': MD.twoSteps } });
  h.fn.renderSteps('## Steps\n- a', { id: 7 });
  assert.equal(h.state.currentSteps.length, 2);
  assert.deepEqual(h.calls.empties, []);
  assert.equal(h.node['test-steps'].querySelectorAll('li').length, 2);
  // The body is hydrated BEFORE it reaches the document, and the group released first.
  assert.deepEqual(h.calls.order.filter((c) => c !== 'Md.render'), ['release:test-description', 'hydrate']);
});

// ===================== the example row and its badge (rows 121-125) =====================

const withExample = (params, example) => detail({ test: { params }, example });

test('121: a parameter is replaced by the row\'s value, in the double quotes the product uses', () => {
  const h = load({ testrunDetail: withExample(['user'], ['ann']) });
  assert.equal(h.fn.applyExample('Login as ${user}'), 'Login as "ann"');
});

test('122: a column named "0" or blank is not a parameter, and its own placeholder is left alone', () => {
  // The placeholder names that very column, so only the non-"0"/non-blank rule can leave it standing.
  for (const [params, text] of [[['0'], 'Login as ${0}'], [['  '], 'Login as {{  }}']]) {
    const h = load({ testrunDetail: withExample(params, ['ann']) });
    assert.equal(h.fn.applyExample(text), text);
  }
});

test('122b: a usable column beside an unusable one is substituted, and only it', () => {
  const h = load({ testrunDetail: withExample(['user', '0'], ['ann', 'zero']) });
  assert.equal(h.fn.applyExample('Login as ${user} at ${0}'), 'Login as "ann" at ${0}');
});

test('122a: …and an example row that is missing or empty stops substitution too', () => {
  assert.equal(load({ testrunDetail: withExample(['user'], []) }).fn.applyExample('Hi ${user}'), 'Hi ${user}');
  assert.equal(load({ testrunDetail: withExample(['user'], null) }).fn.applyExample('Hi ${user}'), 'Hi ${user}');
});

test('123: under JWT a leftover placeholder on an unparametrized test hides the badge', () => {
  const h = load({ jwt: true, testrunDetail: withExample(['0'], ['ann']) });
  h.fn.applyExample('Hi {{x}}');
  assert.equal(h.node['example-badge'].hidden, true);
});

test('123a: …and shows it once the test IS parametrized and a placeholder survived', () => {
  const h = load({ jwt: true, testrunDetail: withExample(['user'], []) });
  h.fn.applyExample('Hi ${user}');
  assert.equal(h.node['example-badge'].hidden, false);
});

test('124: degraded, the leftover placeholder is the only signal there is, so it alone shows the badge', () => {
  const h = load({ jwt: false, testrunDetail: withExample(['0'], ['ann']) });
  h.fn.applyExample('Hi ${x}');
  assert.equal(h.node['example-badge'].hidden, false);
  // …and a description with nothing left over still hides it.
  h.fn.applyExample('Hi there');
  assert.equal(h.node['example-badge'].hidden, true);
});

test('125: a page with no badge element does not throw', () => {
  const h = load({ without: ['example-badge'] });
  assert.equal(h.fn.applyExample('Hi ${x}'), 'Hi ${x}');
});
