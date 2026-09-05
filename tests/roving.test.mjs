#!/usr/bin/env node
// #109: without extension/shared/roving.js the panel's lists are mouse-only — Tab walks past every
// run, suite and test onto the status line, and no key opens one. This is the shared answer the four
// screens hang off: ONE tab stop per list, the arrows between rows, Home/End at the ends, Enter and
// Space to open. Two properties carry the whole design and are asserted hardest here: the listeners
// live on the CONTAINER, so a list whose children are swapped by replaceChildren() needs nothing
// re-attached; and a row a fold has hidden — or a tab the first-launch gate has disabled — is not
// somewhere the arrows may land, because the caret would arrive at what cannot hold it and stick.
// Run: node --test tests/roving.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto } from './helpers/shared-harness.mjs';
import { makeDocument, el, fire } from './helpers/mini-dom.mjs';

// A fresh module per case — the WeakMap of wired containers is a singleton per load.
const load = () => loadInto({ console }, [['shared/roving.js', 'Roving']]).value;

// A list of `n` rows in a real document, wired the way a screen wires it. `clicks` records which
// row's own click listener ran, which is the only thing Enter and Space are allowed to do.
function list({ rows = 3, orientation = 'vertical', tag = 'li' } = {}) {
  const Roving = load();
  const doc = makeDocument([]);
  const ul = el('ul', { id: 'rows' });
  doc.body.append(ul);
  const clicks = [];
  const add = (name, into = ul) => {
    const row = el(tag, { dataset: { name } });
    row.addEventListener('click', () => clicks.push(name));
    into.append(Roving.item(row));
    return row;
  };
  for (let i = 0; i < rows; i += 1) add(`r${i}`);
  Roving.attach(ul, { selector: `${tag}[data-name]`, orientation });
  return {
    Roving,
    doc,
    ul,
    clicks,
    add,
    at: (i) => ul.querySelectorAll(`${tag}[data-name]`)[i],
    // Every row's tabindex in document order — the one shape the whole model is about.
    tabs: () => ul.querySelectorAll(`${tag}[data-name]`).map((r) => r.getAttribute('tabindex')),
    focused: () => (doc.activeElement ? doc.activeElement.dataset.name : null),
    // What the tester's finger does: a keydown on the row that has focus, which bubbles to the <ul>.
    key: (row, k) => fire(row, 'keydown', { key: k, bubbles: true }),
  };
}

// ---------- what a row is ----------

test('R1: a marked row says it is a button and starts out reachable by Tab', () => {
  const h = list({ rows: 2 });
  assert.equal(h.at(0).getAttribute('role'), 'button');
  assert.deepEqual(h.tabs(), ['0', '0']);
});

test('R1b: item() hands back the row it was given, so a factory can return it inline', () => {
  const Roving = load();
  const row = el('li');
  assert.equal(Roving.item(row), row);
  assert.equal(Roving.item(null), null);
});

// ---------- moving ----------

test('R2: the arrows walk the list and leave exactly one tab stop behind them', () => {
  const h = list({ rows: 3 });
  h.key(h.at(0), 'ArrowDown');
  assert.equal(h.focused(), 'r1');
  assert.deepEqual(h.tabs(), ['-1', '0', '-1']);

  h.key(h.at(1), 'ArrowDown');
  assert.equal(h.focused(), 'r2');
  h.key(h.at(2), 'ArrowUp');
  assert.equal(h.focused(), 'r1');
  assert.deepEqual(h.tabs(), ['-1', '0', '-1']);
});

test('R3: the arrows STOP at the ends — no wrapping in either direction', () => {
  const h = list({ rows: 3 });
  h.key(h.at(0), 'ArrowUp');
  assert.equal(h.focused(), 'r0', 'up from the first row stays on it');
  h.key(h.at(0), 'End');
  h.key(h.at(2), 'ArrowDown');
  assert.equal(h.focused(), 'r2', 'down from the last row stays on it');
});

test('R4: Home and End are the way to the ends', () => {
  const h = list({ rows: 4 });
  h.key(h.at(0), 'End');
  assert.equal(h.focused(), 'r3');
  assert.deepEqual(h.tabs(), ['-1', '-1', '-1', '0']);
  h.key(h.at(3), 'Home');
  assert.equal(h.focused(), 'r0');
  assert.deepEqual(h.tabs(), ['0', '-1', '-1', '-1']);
});

test('R5: a horizontal list answers Left/Right and ignores Up/Down; a vertical one the other way', () => {
  const bar = list({ rows: 3, orientation: 'horizontal' });
  bar.key(bar.at(0), 'ArrowRight');
  assert.equal(bar.focused(), 'r1');
  bar.key(bar.at(1), 'ArrowLeft');
  assert.equal(bar.focused(), 'r0');
  assert.equal(bar.key(bar.at(0), 'ArrowDown').defaultPrevented, false, 'not this bar’s key');
  assert.equal(bar.focused(), 'r0');
  // Home/End belong to both orientations.
  bar.key(bar.at(0), 'End');
  assert.equal(bar.focused(), 'r2');

  const rows = list({ rows: 3 });
  assert.equal(rows.key(rows.at(0), 'ArrowRight').defaultPrevented, false);
  assert.equal(rows.focused(), null, 'nothing was focused, so nothing moved');
});

test('R6: a key the helper does not own is left alone for the page', () => {
  const h = list({ rows: 2 });
  const ev = h.key(h.at(0), 'a');
  assert.equal(ev.defaultPrevented, false);
  assert.equal(h.focused(), null);
});

// ---------- opening ----------

test('R7: Enter opens the focused row by running its own click listener', () => {
  const h = list({ rows: 2 });
  const ev = h.key(h.at(1), 'Enter');
  assert.deepEqual(h.clicks, ['r1']);
  assert.equal(ev.defaultPrevented, true);
});

test('R8: Space opens it too, and is swallowed so the panel does not scroll out from under it', () => {
  const h = list({ rows: 2 });
  const ev = h.key(h.at(0), ' ');
  assert.deepEqual(h.clicks, ['r0']);
  assert.equal(ev.defaultPrevented, true, 'an unhandled Space scrolls the page');
});

// ---------- what the helper must not touch ----------

test('R9: a field inside the list keeps every key typed into it', () => {
  const h = list({ rows: 2 });
  const input = el('input', { value: '' });
  const holder = el('li');
  holder.append(input);
  h.ul.append(holder);
  const typed = fire(input, 'keydown', { key: ' ', bubbles: true });
  assert.equal(typed.defaultPrevented, false, 'a space in a search box is a space');
  assert.deepEqual(h.clicks, []);
  assert.equal(fire(input, 'keydown', { key: 'ArrowDown', bubbles: true }).defaultPrevented, false);
  assert.equal(h.focused(), null);
});

test('R10: a button inside a row answers Enter itself — the row is not opened behind it', () => {
  const h = list({ rows: 2 });
  const btn = el('button');
  h.at(0).append(btn);
  assert.equal(fire(btn, 'keydown', { key: 'Enter', bubbles: true }).defaultPrevented, false);
  assert.deepEqual(h.clicks, []);
});

// ---------- folds ----------

test('R11: a row a fold has hidden is not somewhere the arrows may land', () => {
  const h = list({ rows: 0 });
  const first = h.add('r0');
  const group = el('li', { hidden: true });
  h.ul.append(group);
  h.add('folded', group);          // inside the collapsed container
  const last = h.add('r1');

  h.key(first, 'ArrowDown');
  assert.equal(h.focused(), 'r1', 'the folded row was stepped over');
  h.key(last, 'End');
  assert.equal(h.focused(), 'r1', 'and it is not the end of the list either');

  // Opened, it joins the walk without anything being re-attached.
  group.hidden = false;
  h.key(first, 'ArrowDown');
  assert.equal(h.focused(), 'folded');
});

// ---------- the property the whole design rests on ----------

test('R12: the tab stop survives a replaceChildren() re-render with nothing re-attached', () => {
  const h = list({ rows: 3 });
  h.key(h.at(0), 'End');
  assert.deepEqual(h.tabs(), ['-1', '-1', '0']);

  // What every render in the panel does: brand-new rows into the SAME <ul>.
  h.ul.replaceChildren();
  const fresh = ['n0', 'n1'].map((n) => h.add(n));
  assert.deepEqual(h.tabs(), ['0', '0'], 'a fresh row is born reachable');

  // Tab lands on the first of them, and that one focus is what demotes the rest.
  fire(fresh[0], 'focusin', { bubbles: true });
  assert.deepEqual(h.tabs(), ['0', '-1']);

  // And the arrows work on the new rows without a second attach().
  h.key(fresh[0], 'ArrowDown');
  assert.equal(h.focused(), 'n1');
  h.key(fresh[1], 'Enter');
  assert.deepEqual(h.clicks, ['n1']);
});

test('R13: focus arriving on a row, or on something inside one, makes that row the tab stop', () => {
  const h = list({ rows: 3 });
  const mark = el('span');
  h.at(2).append(mark);
  fire(mark, 'focusin', { bubbles: true });
  assert.deepEqual(h.tabs(), ['-1', '-1', '0'], 'the row that owns the focus, not the span');

  // Focus landing outside any row leaves the list as it was.
  const outside = el('li');
  h.ul.append(outside);
  fire(outside, 'focusin', { bubbles: true });
  assert.deepEqual(h.tabs(), ['-1', '-1', '0']);
});

test('R14: attach() is safe to call from a render — the listeners are wired exactly once', () => {
  const h = list({ rows: 2 });
  for (let i = 0; i < 5; i += 1) h.Roving.attach(h.ul, { selector: 'li[data-name]' });
  assert.equal(h.ul.listeners.get('keydown').length, 1);
  assert.equal(h.ul.listeners.get('focusin').length, 1);
  h.key(h.at(0), 'Enter');
  assert.deepEqual(h.clicks, ['r0'], 'and the row opens once, not five times');
});

// ---------- the edges a list really has ----------

test('R15: an empty list, and a container nothing was attached to, both stay quiet', () => {
  const h = list({ rows: 0 });
  assert.deepEqual(h.tabs(), []);
  assert.doesNotThrow(() => fire(h.ul, 'keydown', { key: 'ArrowDown', bubbles: true }));
  assert.doesNotThrow(() => fire(h.ul, 'focusin', { bubbles: true }));

  const loose = el('ul', null, el('li', { dataset: { name: 'x' } }));
  assert.equal(h.Roving.attach(loose, {}), loose, 'no selector, no wiring');
  assert.equal(loose.listeners.get('keydown'), undefined);
  assert.equal(h.Roving.attach(null, { selector: 'li' }), null);
});

test('R16: a row that a fold hid while it had focus does not move the tab stop anywhere', () => {
  const h = list({ rows: 0 });
  const group = el('li');
  h.ul.append(group);
  const inside = h.add('folded', group);
  h.add('r1');
  group.hidden = true;
  assert.equal(h.key(inside, 'ArrowDown').defaultPrevented, false, 'it is not in the walk at all');
  assert.equal(h.focused(), null);
});

// ---------- and the other thing that cannot hold the caret (#109 PR-3) ----------

test('R17: a disabled item is stepped over — the caret would arrive there and stick', () => {
  const bar = list({ rows: 3, orientation: 'horizontal', tag: 'button' });
  bar.at(1).disabled = true;
  bar.key(bar.at(0), 'ArrowRight');
  assert.equal(bar.focused(), 'r2', 'over the disabled one, not onto it');
  bar.key(bar.at(2), 'ArrowLeft');
  assert.equal(bar.focused(), 'r0');
  assert.deepEqual(bar.tabs(), ['0', '-1', '-1']);

  // Enabled again it joins the walk with nothing re-attached — the same property a fold has.
  bar.at(1).disabled = false;
  bar.key(bar.at(0), 'ArrowRight');
  assert.equal(bar.focused(), 'r1');
});

test('R18: Home and End are the ends that can HOLD the caret, not the ends of the markup', () => {
  const bar = list({ rows: 4, orientation: 'horizontal', tag: 'button' });
  bar.at(0).disabled = true;
  bar.at(3).disabled = true;
  bar.key(bar.at(1), 'End');
  assert.equal(bar.focused(), 'r2');
  assert.deepEqual(bar.tabs(), ['-1', '-1', '0', '-1']);
  bar.key(bar.at(2), 'Home');
  assert.equal(bar.focused(), 'r1');
});
