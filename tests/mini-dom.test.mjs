#!/usr/bin/env node
// The contract of tests/helpers/mini-dom.mjs, the hand-made page every screen fixture is built
// from: if it over-matches or reorders, the tests written on top of it pass for the wrong reason.
// Run: node --test tests/mini-dom.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, el, text, fire, NodeFilter } from './helpers/mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- building and moving nodes ----------

test('M1: el() makes an empty, parentless element', () => {
  const div = el('div');
  assert.equal(div.tagName, 'DIV');
  assert.equal(div.nodeType, 1);
  assert.deepEqual(div.childNodes, []);
  assert.equal(div.parentElement, null);
});

test('M2: className and classList stay in sync in both directions', () => {
  const li = el('li', { className: 'step-row' });
  assert.equal(li.className, 'step-row');
  assert.equal(li.classList.contains('step-row'), true);
  li.classList.add('open');
  assert.equal(li.className, 'step-row open');
  li.className = 'plain';
  assert.equal(li.classList.contains('open'), false);
  assert.equal(li.classList.contains('plain'), true);
});

test('M3: document.createElement and el() are one factory behind two doors', () => {
  const doc = makeDocument();
  const made = doc.createElement('ul');
  assert.equal(made.tagName, el('ul').tagName);
  assert.equal(Object.getPrototypeOf(made), Object.getPrototypeOf(el('ul')));
  assert.deepEqual(made.childNodes, []);
});

test('M4: createTextNode makes a text node', () => {
  const t = makeDocument().createTextNode('hi');
  assert.equal(t.nodeType, 3);
  assert.equal(t.nodeValue, 'hi');
  assert.equal(t.textContent, 'hi');
  assert.deepEqual(t.childNodes, []);
});

test('M5: append adopts nodes; children skips the text ones', () => {
  const p = el('p');
  const a = el('b');
  const b = text('tail');
  p.append(a, b);
  assert.deepEqual(p.childNodes, [a, b]);
  assert.equal(a.parentElement, p);
  assert.deepEqual(p.children, [a]);
});

test('M6: appending a string yields one text node, never markup', () => {
  const p = el('p');
  p.append('<b>hi</b>');
  assert.equal(p.childNodes.length, 1);
  assert.equal(p.childNodes[0].nodeType, 3);
  assert.equal(p.childNodes[0].nodeValue, '<b>hi</b>');
  assert.equal(p.textContent, '<b>hi</b>');
  assert.equal(p.querySelector('b'), null);
});

test('M7: prepend puts the node first', () => {
  const a = el('li');
  const c = el('li');
  const ul = el('ul', null, a);
  ul.prepend(c);
  assert.deepEqual(ul.childNodes, [c, a]);
  assert.equal(c.parentElement, ul);
});

test('M8: replaceChildren swaps the subtree and detaches the old children', () => {
  const old = el('span');
  const x = el('em');
  const p = el('p', null, old);
  p.replaceChildren(x);
  assert.deepEqual(p.childNodes, [x]);
  assert.equal(old.parentElement, null);
});

test('M9: replaceChildren() empties the node', () => {
  const old = el('span');
  const p = el('p', null, old, text('t'));
  p.replaceChildren();
  assert.deepEqual(p.childNodes, []);
  assert.equal(old.parentElement, null);
});

test('M10: replaceWith puts the new node at the old index', () => {
  const first = el('span');
  const br = el('br');
  const last = el('span');
  const li = el('li', null, first, br, last);
  const space = text(' ');
  br.replaceWith(space);
  assert.deepEqual(li.childNodes, [first, space, last]);
  assert.equal(br.parentElement, null);
  assert.equal(space.parentElement, li);
});

test('M11: remove() on a parentless node does not throw', () => {
  assert.doesNotThrow(() => el('div').remove());
});

test('M12: a fragment hands over its children and is not itself appended', () => {
  const doc = makeDocument();
  const frag = doc.createDocumentFragment();
  const a = el('li');
  const b = el('li');
  frag.append(a, b);
  const ul = el('ul');
  ul.append(frag);
  assert.deepEqual(ul.childNodes, [a, b]);
  assert.equal(a.parentElement, ul);
  assert.deepEqual(frag.childNodes, []);
});

test('M13: cloneNode(true) is a deep, independent copy', () => {
  const li = el('li', { className: 'step-row' }, el('ul', null, el('li', null, 'sub')));
  const copy = li.cloneNode(true);
  assert.equal(copy.parentElement, null);
  assert.equal(copy.textContent, 'sub');
  copy.querySelector('li').textContent = 'changed';
  assert.equal(li.textContent, 'sub');
  assert.equal(copy.textContent, 'changed');
});

test('M14: cloneNode(false) copies the node but not its children', () => {
  const li = el('li', { className: 'step-row' }, 'body');
  li.setAttribute('data-kind', 'step');
  const copy = li.cloneNode(false);
  assert.equal(copy.tagName, 'LI');
  assert.equal(copy.className, 'step-row');
  assert.equal(copy.getAttribute('data-kind'), 'step');
  assert.deepEqual(copy.childNodes, []);
});

test('M15: the `while (li.firstChild)` move loop terminates and keeps order', () => {
  const one = el('span');
  const two = text('two');
  const li = el('li', null, one, two);
  const box = el('div');
  while (li.firstChild) box.append(li.firstChild);
  assert.deepEqual(li.childNodes, []);
  assert.deepEqual(box.childNodes, [one, two]);
  assert.equal(li.firstChild, null);
});

// ---------- text ----------

test('M16: textContent concatenates the subtree in document order', () => {
  const li = el('li', null, 'a', el('span', null, 'b', el('i', null, 'c')), 'd');
  assert.equal(li.textContent, 'abcd');
});

test('M17: <li>one<br>two</li> reads "onetwo" — glued, no space inserted', () => {
  const li = el('li', null, 'one', el('br'), 'two');
  assert.equal(li.textContent, 'onetwo');
});

test('M18: writing textContent drops and detaches the children', () => {
  const kid = el('span', null, 'old');
  const li = el('li', null, kid);
  li.textContent = 'a';
  assert.equal(li.textContent, 'a');
  assert.equal(li.childNodes.length, 1);
  assert.equal(li.childNodes[0].nodeType, 3);
  assert.equal(kid.parentElement, null);
});

test('M19: writing an empty textContent leaves no children at all', () => {
  const li = el('li', null, 'old');
  li.textContent = '';
  assert.deepEqual(li.childNodes, []);
  assert.equal(li.textContent, '');
});

// ---------- selectors ----------

// <ul id="run-tests"><li class="test-row">a<ul><li class="sub">b</li></ul></li></ul>
function nested() {
  const inner = el('li', { className: 'sub' }, 'b');
  const sub = el('ul', null, inner);
  const outer = el('li', { className: 'test-row' }, text('a'), sub);
  const root = el('ul', { id: 'run-tests' }, outer);
  return { root, outer, sub, inner };
}

test('M20: querySelectorAll returns a plain array of descendants in document order', () => {
  const { root, outer, inner } = nested();
  const list = root.querySelectorAll('li');
  assert.equal(Array.isArray(list), true);
  assert.deepEqual(list, [outer, inner]);
  assert.equal(list.indexOf(inner), 1);
  assert.equal([...list].length, 2);
});

test('M21: a comma list takes every branch, in document order, without duplicates', () => {
  const ul = el('ul');
  const ol = el('ol');
  const root = el('div', null, ul, ol);
  assert.deepEqual(root.querySelectorAll('ul, ol'), [ul, ol]);
  assert.deepEqual(root.querySelectorAll('ul,ol'), [ul, ol]);
  assert.deepEqual(root.querySelectorAll('ul, ul'), [ul]);

  const heads = ['h1', 'h2', 'h3', 'h4'].map((t) => el(t));
  assert.deepEqual(el('div', null, ...heads).querySelectorAll('h1,h2,h3,h4'), heads);
});

test('M22: * matches every element descendant and no text node', () => {
  const { root, outer, sub, inner } = nested();
  assert.deepEqual(root.querySelectorAll('*'), [outer, sub, inner]);
});

test('M23: :scope > matches direct children only', () => {
  const { root, outer } = nested();
  assert.deepEqual(root.querySelectorAll(':scope > li'), [outer]);
});

test('M24: :scope > ul > li, :scope > ol > li takes the sub-bullets of one item', () => {
  const fromUl = el('li', null, 'u');
  const fromOl = el('li', null, 'o');
  const deeper = el('li', null, 'deep');
  const li = el(
    'li',
    null,
    'Expected',
    el('ul', null, fromUl, el('li', null, el('ul', null, deeper))),
    el('ol', null, fromOl),
  );
  const subs = li.querySelectorAll(':scope > ul > li, :scope > ol > li');
  assert.equal(subs.includes(fromUl), true);
  assert.equal(subs.includes(fromOl), true);
  assert.equal(subs.includes(deeper), false);
  assert.equal(subs.length, 3); // the two bullets plus the one that carries the deeper list
});

test('M25: an attribute value parses the same quoted, single-quoted or bare', () => {
  const box = el('input', { type: 'checkbox' });
  const radio = el('input', { type: 'radio' });
  const li = el('li', null, box, radio);
  for (const sel of [':scope > input[type="checkbox"]', ":scope > input[type='checkbox']", ':scope > input[type=checkbox]']) {
    assert.deepEqual(li.querySelectorAll(sel), [box], sel);
  }
});

test('M26: a class matches anywhere under the document, not just under body', () => {
  const doc = makeDocument();
  const inBody = el('li', { className: 'tc-new-suite' });
  const outsideBody = el('div', { className: 'tc-new-suite' });
  doc.body.append(el('ul', null, inBody));
  doc.documentElement.append(outsideBody);
  assert.deepEqual(doc.querySelectorAll('.tc-new-suite'), [inBody, outsideBody]);
});

test('M27: a descendant combinator with a compound on the right', () => {
  const doc = makeDocument();
  const { root, outer } = nested();
  doc.body.append(root, el('li', { className: 'test-row' })); // the stray row is outside #run-tests
  assert.deepEqual(doc.querySelectorAll('#run-tests li.test-row'), [outer]);
});

test('M28: an attribute by value and an attribute by presence alone', () => {
  const doc = makeDocument();
  const label = el('label', { for: 'f' });
  const link = el('a', { href: '#x' });
  doc.body.append(label, link, el('label', { for: 'other' }), el('a'));
  assert.equal(doc.querySelector('label[for="f"]'), label);
  assert.equal(doc.querySelector('a[href]'), link);
});

test('M29: no match answers null and an empty array', () => {
  const { root } = nested();
  assert.equal(root.querySelector('.nope'), null);
  assert.deepEqual(root.querySelectorAll('.nope'), []);
});

test('M30: matches() answers off the same engine', () => {
  const li = el('li', { className: 'step-row' });
  assert.equal(li.matches('li.step-row'), true);
  assert.equal(li.matches('li.other'), false);
  assert.equal(li.matches('ul'), false);
});

test('M31: closest() answers the node itself, then the nearest ancestor, then null', () => {
  const btn = el('button', { className: 'tc-new' });
  const row = el('div', { className: 'tc-new' }, el('span', null, btn));
  assert.equal(btn.closest('.tc-new'), btn);
  assert.equal(btn.parentElement.closest('.tc-new'), row);
  assert.equal(row.closest('.missing'), null);
});

test('M32: contains() covers descendants and the node itself, not a detached node', () => {
  const { root, inner } = nested();
  assert.equal(root.contains(inner), true);
  assert.equal(root.contains(root), true);
  assert.equal(root.contains(el('li')), false);
});

// ---------- attributes, classes, data ----------

test('M33: an absent attribute answers null, never undefined or an empty string', () => {
  const row = el('div');
  row.setAttribute('aria-expanded', 'true');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(row.getAttribute('aria-label'), null);
});

test('M34: attributes is an ordered array the sanitizer walk can empty', () => {
  const a = el('a');
  a.setAttribute('href', '#x');
  a.setAttribute('target', '_blank');
  a.setAttribute('onclick', 'boom()');
  assert.deepEqual(a.attributes, [
    { name: 'href', value: '#x' },
    { name: 'target', value: '_blank' },
    { name: 'onclick', value: 'boom()' },
  ]);
  for (const attr of [...a.attributes]) a.removeAttribute(attr.name);
  assert.deepEqual(a.attributes, []);
});

test('M35: removeAttribute takes it out of attributes and getAttribute', () => {
  const a = el('a');
  a.setAttribute('href', '#x');
  a.removeAttribute('href');
  assert.deepEqual(a.attributes, []);
  assert.equal(a.getAttribute('href'), null);
  assert.equal(a.matches('a[href]'), false);
});

test('M36: classList add/remove/toggle/contains, with className reflecting them', () => {
  const row = el('div');
  row.classList.add('a', 'b');
  assert.equal(row.className, 'a b');
  row.classList.remove('a');
  assert.equal(row.className, 'b');
  assert.equal(row.classList.toggle('c'), true);
  assert.equal(row.className, 'b c');
  assert.equal(row.classList.toggle('c', false), false);
  assert.equal(row.className, 'b');
  assert.equal(row.classList.contains('b'), true);
  assert.equal(row.classList.contains('c'), false);
});

test('M37: a dataset assignment stringifies', () => {
  const row = el('div');
  row.dataset.id = 7;
  assert.equal(row.dataset.id, '7');
  assert.equal(row.dataset.id === 7, false);
});

test('M38: deleting a dataset key really removes it', () => {
  const row = el('div');
  row.dataset.write = 'on';
  delete row.dataset.write;
  assert.equal('write' in row.dataset, false);
  assert.equal(row.dataset.write, undefined);
});

test('M39: any other property assignment sticks and reads back unchanged', () => {
  const a = el('a');
  a.hidden = true;
  a.href = 'https://example.com';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Open';
  assert.equal(a.hidden, true); // true, not the string 'true' — the screens compare it strictly
  assert.equal(a.href, 'https://example.com');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
  assert.equal(a.title, 'Open');

  const input = el('input');
  input.type = 'checkbox';
  input.value = '';
  input.src = 'x.png';
  assert.equal(input.type, 'checkbox');
  assert.equal(input.value, '');
  assert.equal(input.src, 'x.png');
});

// ---------- events ----------

test('M40: a listener runs once with the event and its target', () => {
  const node = el('button');
  const seen = [];
  node.addEventListener('click', (e) => seen.push(e));
  fire(node, 'click');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'click');
  assert.equal(seen[0].target, node);
});

test('M41: two listeners for one type both run, in registration order', () => {
  const node = el('button');
  const order = [];
  node.addEventListener('click', () => order.push('first'));
  node.addEventListener('click', () => order.push('second'));
  fire(node, 'click');
  assert.deepEqual(order, ['first', 'second']);
});

test('M42: a removed listener does not run', () => {
  const node = el('button');
  let calls = 0;
  const fn = () => { calls += 1; };
  node.addEventListener('click', fn);
  node.removeEventListener('click', fn);
  fire(node, 'click');
  assert.equal(calls, 0);
});

test('M43: fire() carries extra fields, and preventDefault/stopPropagation record themselves', () => {
  const input = el('input');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
  });
  const enter = fire(input, 'keydown', { key: 'Enter' });
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(enter.propagationStopped, true);

  const esc = fire(input, 'keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, false);
  assert.equal(esc.propagationStopped, false);
});

test('M44: a document listener runs and its capture flag is recorded', () => {
  const doc = makeDocument();
  let calls = 0;
  doc.addEventListener('click', () => { calls += 1; }, true);
  fire(doc, 'click');
  assert.equal(calls, 1);
  assert.equal(doc.listeners.get('click')[0].capture, true);

  doc.addEventListener('keydown', () => {});
  assert.equal(doc.listeners.get('keydown')[0].capture, false);
});

// ---------- the document ----------

test('M45: makeDocument pre-creates the ids, and answers with the same node every time', () => {
  const doc = makeDocument(['test-status', 'test-comment', 'ul#tc-tree']);
  const status = doc.getElementById('test-status');
  assert.equal(status.id, 'test-status');
  assert.equal(doc.getElementById('test-status'), status);
  assert.equal(doc.getElementById('test-comment').id, 'test-comment');
  assert.equal(doc.getElementById('tc-tree').tagName, 'UL');
  assert.equal(doc.body.contains(status), true);
});

test('M46: an unknown id answers null', () => {
  assert.equal(makeDocument(['test-status']).getElementById('nope'), null);
});

test('M47: body and documentElement are real nodes, and queries run under documentElement', () => {
  const doc = makeDocument();
  assert.equal(doc.documentElement.tagName, 'HTML');
  assert.equal(doc.body.tagName, 'BODY');
  assert.equal(doc.documentElement.contains(doc.body), true);
  const li = el('li', { className: 'test-row' });
  doc.body.append(el('ul', null, li));
  assert.equal(doc.querySelector('.test-row'), li);
  assert.deepEqual(doc.querySelectorAll('li'), [li]);
});

// ---------- one real screen, loaded through the helper ----------

test('a real screen: tc-studio draws a folder row through mini-dom, and the row folds', () => {
  const source = readFileSync(join(repoRoot, 'extension/sidepanel/screens/tc-studio.js'), 'utf8');
  const doc = makeDocument(['ul#tc-tree']);
  const sandbox = {
    document: doc,
    state: { tcExpanded: {}, tcTreeSearch: '', settings: {} },
    $: (id) => doc.getElementById(id),
    setTabCount: () => {},
    EmptyState: { build: () => el('li', { className: 'empty-state' }) },
    Tooltip: { set: () => {} },
    svgIcon: (name) => el('span', { className: `icon icon-${name}` }),
    treeIcon: (name, cls) => el('span', { className: `tree-icon ${cls}` }),
    treeSlot: () => el('span', { className: 'tree-icon' }),
    CHEVRON_ICON: 'chevron_right',
    FOLDER_ICON: 'tree_folder',
    FILE_ICON: 'tree_suite',
  };
  const { renderSuiteTreeInto } = runInNewContext(`${source}\n({ renderSuiteTreeInto })`, sandbox);

  const ul = doc.getElementById('tc-tree');
  renderSuiteTreeInto(
    ul,
    [{
      id: 1,
      title: 'Checkout',
      file_type: 'folder',
      test_count: 3,
      children: [{ id: 2, title: 'Guest', file_type: 'file' }],
    }],
    { pick: false, expandAll: false, searching: false },
  );

  const roots = ul.querySelectorAll(':scope > li'); // the child suite is a row, not a root
  assert.equal(roots.length, 1);
  const li = roots[0];
  assert.equal(li, ul.children[0]);
  assert.equal(li.tagName, 'LI');
  assert.equal(li.classList.contains('tc-item'), true);

  const row = li.firstChild;
  assert.equal(row.tagName, 'DIV');
  assert.equal(row.classList.contains('list-row'), true);
  assert.equal(row.classList.contains('tc-row'), true);
  assert.equal(row.dataset.id, '1');
  assert.equal(row.querySelector('.title').textContent, 'Checkout');
  assert.equal(row.querySelector('.row-count').textContent, '3');

  const kids = li.querySelector(':scope > ul.tc-children');
  assert.equal(kids.hidden, true);
  assert.equal(kids.querySelector('.title').textContent, 'Guest');

  fire(row, 'click');
  assert.equal(kids.hidden, false);
  assert.equal(row.classList.contains('expanded'), true);
});

// Added in review of the ticket: `attributes` and `getAttribute` have to describe the same node.
// A fixture built as el('a', { href }) is the natural way to write one, and the sanitizer only
// ever sees a node through `attributes` — the two views disagreeing is how a fake lies quietly.
test('M48: a property set through el() is visible to an attributes walk', () => {
  const a = el('a', { href: 'javascript:alert(1)', title: 'Open' });
  assert.deepEqual(a.attributes, [
    { name: 'href', value: 'javascript:alert(1)' },
    { name: 'title', value: 'Open' },
  ]);
  for (const attr of [...a.attributes]) a.removeAttribute(attr.name);
  assert.deepEqual(a.attributes, []);
  assert.equal(a.getAttribute('href'), null);
  assert.equal(a.matches('a[href]'), false);
});

test('M49: id and class reflect between property and attribute in both directions', () => {
  const row = el('div', { id: 'tc-tree', className: 'list-row tc-row' });
  assert.equal(row.getAttribute('id'), 'tc-tree');
  assert.equal(row.getAttribute('class'), 'list-row tc-row');
  const other = el('div');
  other.setAttribute('id', 'run-tests');
  other.setAttribute('class', 'test-row');
  assert.equal(other.id, 'run-tests');
  assert.equal(other.className, 'test-row');
  assert.equal(other.classList.contains('test-row'), true);
  const doc = makeDocument();
  doc.body.append(other);
  assert.equal(doc.getElementById('run-tests'), other);
  other.removeAttribute('class');
  assert.equal(other.className, '');
  assert.equal(other.matches('.test-row'), false);
});

// ---------- what the step recorder reads (tests/helpers/recorder-harness.mjs) ----------

test('M50: [attr*=value] matches a substring, [attr=value] still demands the whole string', () => {
  const toast = el('div', { className: 'app-toast is-open' });
  const modal = el('div', { className: 'modal' });
  const root = el('div', null, toast, modal);
  assert.deepEqual(root.querySelectorAll('[class*="toast"]'), [toast]);
  assert.deepEqual(root.querySelectorAll('[class="modal"]'), [modal]);
  assert.deepEqual(root.querySelectorAll('[class="toast"]'), []);
  assert.equal(toast.matches('[class*="snackbar"], [class*="app-toast"]'), true);
});

test('M51: previous/nextElementSibling skip the text between them and stop at the ends', () => {
  const first = el('td', null, 'Bolt Cutters');
  const last = el('td', null, el('button', null, 'Delete'));
  el('tr', null, first, text(' '), last);
  assert.equal(first.nextElementSibling, last);
  assert.equal(last.previousElementSibling, first);
  assert.equal(first.previousElementSibling, null);
  assert.equal(last.nextElementSibling, null);
  assert.equal(el('div').nextElementSibling, null);
});

test('M52: labels answers the wrapping <label> and the one pointing at the id, in document order', () => {
  const doc = makeDocument();
  const input = el('input', { id: 'e' });
  const wrap = el('label', null, 'Email ', input);
  const pointing = el('label', { for: 'e' }, 'Also email');
  doc.body.append(wrap, pointing, el('label', { for: 'other' }, 'Other'));
  assert.deepEqual(input.labels, [wrap, pointing]);
  assert.deepEqual(el('input').labels, []);
  assert.equal(el('div').labels, undefined); // a browser gives a <div> no such property at all
});

test('M53: the table shape: a header row, its cells, and a body cell that knows its index', () => {
  const head = el('tr', null, el('th', null, 'Item'), el('th', null, 'Bulk'));
  const cell = el('td', null, el('input', { type: 'checkbox' }));
  const body = el('tr', null, el('td', null, 'Bolt Cutters'), cell);
  const table = el('table', null, el('tbody', null, body), el('thead', null, head));
  assert.equal(table.tHead.tagName, 'THEAD');
  assert.equal(table.rows[0], head); // the head's row first, however the fixture ordered the sections
  assert.equal(table.tHead.rows[0], head);
  assert.equal(cell.cellIndex, 1);
  assert.equal(head.cells[cell.cellIndex].textContent, 'Bulk');
  assert.equal(el('td').cellIndex, -1);
});

test('M54: selectedOptions is the selection, and a fixture can take it away', () => {
  const large = el('option', { selected: true }, 'Large');
  const select = el('select', null, el('option', null, 'Small'), large);
  assert.deepEqual(select.selectedOptions, [large]);
  select.selectedOptions = undefined; // the browser that answers nothing at all
  assert.equal(select.selectedOptions, undefined);
  assert.equal(el('div').selectedOptions, undefined);
});

test('M55: attachShadow keeps the children it is given, out of the document\'s reach', () => {
  const doc = makeDocument();
  const host = el('div', { id: 'pill' });
  doc.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const box = el('div', { className: 'box' }, 'Recording');
  shadow.append(box);
  assert.equal(host.shadowRoot, shadow);
  assert.equal(shadow.host, host);
  assert.equal(shadow.querySelector('.box'), box);
  assert.equal(doc.querySelector('.box'), null); // the page's selectors never cross the boundary
  assert.equal(el('div').attachShadow({ mode: 'closed' }).host.shadowRoot, undefined);
});

test('M56: focus() lands on the nearest root, and the document records the host', () => {
  const doc = makeDocument();
  const host = el('div');
  const button = el('button');
  doc.body.append(host, button);
  const shadow = host.attachShadow({ mode: 'open' });
  const input = el('input');
  shadow.append(input);
  input.focus();
  assert.equal(shadow.activeElement, input);
  assert.equal(doc.activeElement, host);
  button.focus();
  assert.equal(doc.activeElement, button);
  assert.doesNotThrow(() => el('input').focus()); // detached: nowhere to record it
});

test('M57: layout is told, not computed, and never reads as an attribute', () => {
  const box = el('div');
  assert.deepEqual(box.getBoundingClientRect(),
    { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 });
  Object.assign(box, { offsetLeft: 100, offsetTop: 200, offsetWidth: 300, offsetHeight: 40 });
  const rect = box.getBoundingClientRect();
  assert.equal(rect.left, 100);
  assert.equal(rect.top, 200);
  assert.equal(rect.right, 400);
  assert.equal(rect.bottom, 240);
  assert.deepEqual(box.attributes, []);
  assert.equal(box.getAttribute('offsetWidth'), null);
});

test('M58: createTreeWalker(SHOW_TEXT) hands back the text runs in document order', () => {
  const doc = makeDocument();
  const card = el('button', null,
    el('h3', null, 'Adjustable Wrench'), el('span', { className: 'badge' }, 'ABCDE'), '$20.33');
  const walker = doc.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const runs = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) runs.push([n.nodeValue, n.parentElement.tagName]);
  assert.deepEqual(runs, [['Adjustable Wrench', 'H3'], ['ABCDE', 'SPAN'], ['$20.33', 'BUTTON']]);
  assert.equal(doc.createTreeWalker(card, NodeFilter.SHOW_ELEMENT).nextNode().tagName, 'H3');
});

test('M59: fire() gives the event a composedPath that crosses the shadow boundary', () => {
  const doc = makeDocument();
  const host = el('div', { id: 'pill' });
  doc.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const stop = el('button', null, 'Stop');
  shadow.append(stop);
  const seen = [];
  shadow.addEventListener('click', (e) => seen.push(e.composedPath()));
  fire(shadow, 'click', { target: stop });
  assert.deepEqual(seen[0], [stop, shadow, host, doc.body, doc.documentElement]);
  const given = fire(el('div'), 'click', { composedPath: () => ['mine'] });
  assert.deepEqual(given.composedPath(), ['mine']); // a caller's own path wins
});

test('M60: setPointerCapture records the pointer, releasing it clears it', () => {
  const box = el('div');
  box.setPointerCapture(7);
  assert.equal(box.pointerCapture, 7);
  box.releasePointerCapture(7);
  assert.equal(box.pointerCapture, null);
  assert.deepEqual(box.attributes, []);
});

test('M61: a fresh document has an empty title and no active element, and both are writable', () => {
  const doc = makeDocument();
  assert.equal(doc.title, '');
  assert.equal(doc.activeElement, null);
  doc.title = 'Checkout';
  doc.activeElement = doc.body;
  assert.equal(doc.title, 'Checkout');
  assert.equal(doc.activeElement, doc.body);
});

test('M62: a computed member can be overwritten, and the override is neither attribute nor clone', () => {
  const area = el('textarea', { rows: 3 }); // a getter-only property would throw on this line
  assert.equal(area.rows, 3);
  assert.equal(area.matches('textarea[rows]'), false);
  const table = el('table', null, el('tr'));
  table.rows = [];
  const copy = table.cloneNode(true);
  assert.deepEqual(table.rows, []);
  assert.equal(copy.rows.length, 1); // the copy computes its own, it does not inherit the override
});
