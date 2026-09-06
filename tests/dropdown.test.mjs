#!/usr/bin/env node
// The contract of extension/shared/dropdown.js (#298): which element a screen reader reads the
// highlight off, where the caret sits while the popup is open, and the keys the open control
// swallows. The four callers' suites cover their own wiring, not the widget's announcement.
// Run: node --test tests/dropdown.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto } from './helpers/shared-harness.mjs';
import { makeDocument, fire } from './helpers/mini-dom.mjs';

// One sandbox per test: the widget keeps a module-level registry keyed by trigger id, and every
// open control hangs two capture listeners on the document.
function load() {
  const document = makeDocument();
  // scrollIntoView is the one member mini-dom does not have that this module calls, and the
  // cursor rows go through it on every move.
  const create = document.createElement.bind(document);
  document.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = () => {};
    return made;
  };
  const Icons = {
    el: (name, size, cls) => {
      const i = document.createElement('i');
      i.className = cls || '';
      i.dataset.name = name;
      return i;
    },
  };
  const EmptyState = {
    build: ({ text = '', className = '' } = {}) => {
      const d = document.createElement('div');
      d.className = className;
      d.textContent = text;
      return d;
    },
  };
  const window = { Icons, EmptyState };
  const sandbox = { document, window, Icons, EmptyState };
  const { value: Dropdown } = loadInto(sandbox, [['shared/dropdown.js', 'window.Dropdown']]);
  return { document, Dropdown };
}

const OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
];

// The control mounted into the document — focus() only records on an attached tree, and half of
// these cases are about where the caret lands.
function mount(opts = {}) {
  const env = load();
  const changes = [];
  const dd = env.Dropdown.create({
    id: 'dd',
    label: 'Custom status',
    placeholder: '— none —',
    options: OPTIONS,
    onChange: (v) => changes.push(v),
    ...opts,
  });
  env.document.body.append(dd.el);
  const trigger = dd.el.querySelector('#dd');
  const list = dd.el.querySelector('#dd-list');
  return {
    ...env,
    dd,
    changes,
    trigger,
    list,
    menu: dd.menu,
    filterInput: dd.el.querySelector('#dd-filter'),
    open: () => dd.menu.hidden === false,
    // The row the cursor is on, as the CSS marks it — the announcement has to name the same one.
    active: () => { const li = list.querySelector('li.active'); return li && li.dataset.value; },
    named: (el) => el.getAttribute('aria-activedescendant'),
    // `tag#id`, not the node: a failing focus row has to read as one line, not as a tree dump.
    focused: () => { const a = env.document.activeElement; return a && `${a.tagName}#${a.id}`; },
    key: (k) => fire(env.document, 'keydown', { key: k }),
    docListeners: (type) => (env.document.listeners.get(type) || []).map((l) => l.capture),
  };
}

// ---- the announcement ------------------------------------------------------

test('#298: with no filter box the open LIST carries aria-activedescendant, never the trigger', () => {
  const m = mount();
  fire(m.trigger, 'click');
  assert.equal(m.open(), true);
  // The id has to name a row that is really inside the list this trigger controls.
  const named = m.named(m.list);
  assert.equal(named, 'dd-opt-0');
  assert.equal(m.list.querySelector(`#${named}`).dataset.value, 'low');
  // On a plain button the attribute is inert — a screen reader never reads it there.
  assert.equal(m.named(m.trigger), null);
  assert.equal(m.named(m.menu), null);
});

test('#298: the list the attribute lives on is the one the trigger already names', () => {
  const m = mount();
  assert.equal(m.trigger.getAttribute('aria-controls'), m.list.id);
  assert.equal(m.list.getAttribute('role'), 'listbox');
  assert.equal(m.list.getAttribute('aria-label'), 'Custom status');
  // Focusable, never in the tab order: it has to hold the caret without becoming a tab stop.
  assert.equal(m.list.getAttribute('tabindex'), '-1');
});

test('#298: opening with no filter box puts the caret on the list', () => {
  const m = mount({ value: 'normal' });
  m.trigger.focus();
  fire(m.trigger, 'keydown', { key: 'ArrowDown' });
  assert.equal(m.open(), true);
  assert.equal(m.focused(), 'UL#dd-list');
  // Named its active option BEFORE taking the caret, so the move announces the highlight with it.
  assert.equal(m.named(m.list), 'dd-opt-1');
  assert.equal(m.active(), 'normal');
});

test('#298: the announcement follows the highlight as the arrows move it', () => {
  const m = mount();
  fire(m.trigger, 'click');
  m.key('ArrowDown');
  assert.equal(m.active(), 'normal');
  assert.equal(m.named(m.list), 'dd-opt-1');
  m.key('ArrowDown');
  assert.equal(m.active(), 'high');
  assert.equal(m.named(m.list), 'dd-opt-2');
  m.key('ArrowDown'); // clamped at the last row, and the announcement stays with it
  assert.equal(m.named(m.list), 'dd-opt-2');
  m.key('ArrowUp');
  assert.equal(m.named(m.list), 'dd-opt-1');
  assert.equal(m.named(m.trigger), null); // still nothing on the button
});

test('#298: a list emptied under an open control names nothing', () => {
  const m = mount();
  fire(m.trigger, 'click');
  assert.equal(m.named(m.list), 'dd-opt-0');
  m.dd.setOptions([]);
  assert.equal(m.named(m.list), null);
  m.dd.setOptions(OPTIONS, { value: 'high' });
  assert.equal(m.named(m.list), 'dd-opt-0'); // the cursor falls back to the first visible row
});

// ---- the open/close focus round trip ---------------------------------------

test('#298: Escape clears the attribute off the list and hands the caret back to the trigger', () => {
  const m = mount();
  fire(m.trigger, 'click');
  assert.equal(m.focused(), 'UL#dd-list');
  const ev = m.key('Escape');
  assert.equal(m.open(), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  // Cleared off the LIST — the element it was put on, not the one it used to be put on.
  assert.equal(m.named(m.list), null);
  assert.equal(m.named(m.trigger), null);
  assert.equal(m.focused(), 'BUTTON#dd');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(m.changes, []); // closing is not a pick
});

test('#298: picking a row closes and returns the caret to the trigger', () => {
  const m = mount();
  fire(m.trigger, 'click');
  m.key('ArrowDown');
  const ev = m.key('Enter');
  assert.equal(m.open(), false);
  assert.equal(m.dd.value, 'normal');
  assert.deepEqual(m.changes, ['normal']);
  assert.equal(m.named(m.list), null);
  assert.equal(m.focused(), 'BUTTON#dd');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
});

test('#298: the trigger toggles the control shut and takes the caret back with it', () => {
  const m = mount();
  fire(m.trigger, 'click');
  assert.equal(m.focused(), 'UL#dd-list');
  fire(m.trigger, 'click');
  assert.equal(m.open(), false);
  assert.equal(m.named(m.list), null);
  assert.equal(m.focused(), 'BUTTON#dd');
});

test('#298: reopening announces again from the current value', () => {
  const m = mount();
  fire(m.trigger, 'click');
  m.key('ArrowDown');
  m.key('Enter');
  fire(m.trigger, 'click');
  assert.equal(m.focused(), 'UL#dd-list');
  assert.equal(m.named(m.list), 'dd-opt-1');
  assert.equal(m.active(), 'normal');
});

// ---- the keyboard ----------------------------------------------------------

test('#298: Home jumps to the first option and End to the last', () => {
  const m = mount({ value: 'normal' });
  fire(m.trigger, 'click');
  const end = m.key('End');
  assert.equal(m.active(), 'high');
  assert.equal(m.named(m.list), 'dd-opt-2');
  const home = m.key('Home');
  assert.equal(m.active(), 'low');
  assert.equal(m.named(m.list), 'dd-opt-0');
  // Swallowed like the arrows: the screen behind must not scroll to its own top instead.
  for (const ev of [end, home]) {
    assert.equal(ev.defaultPrevented, true);
    assert.equal(ev.propagationStopped, true);
  }
});

test('#298: Home and End on a closed control are left alone', () => {
  const m = mount();
  const ev = fire(m.trigger, 'keydown', { key: 'End' });
  assert.equal(m.open(), false);
  assert.equal(ev.defaultPrevented, false);
});

test('#298: Tab hands the caret back to the trigger before closing, so the tab order does not move', () => {
  const m = mount();
  m.trigger.focus();
  fire(m.trigger, 'click');
  assert.equal(m.focused(), 'UL#dd-list');
  const ev = m.key('Tab');
  assert.equal(m.open(), false);
  assert.equal(m.focused(), 'BUTTON#dd');
  // NOT prevented: the browser still has to perform the move, from the trigger onwards.
  assert.equal(ev.defaultPrevented, false);
  assert.equal(ev.propagationStopped, false);
});

test('#298: moving the caret changes nothing about which keys the open control swallows', () => {
  const m = mount();
  fire(m.trigger, 'click');
  // Both listeners at CAPTURE, on the document: the keys work wherever focus sits, and the
  // screen's own arrow handlers never see them.
  assert.deepEqual(m.docListeners('keydown'), [true]);
  assert.deepEqual(m.docListeners('click'), [true]);
  for (const key of ['ArrowDown', 'ArrowUp', ' ', 'Spacebar']) {
    const m2 = mount();
    fire(m2.trigger, 'click');
    const ev = m2.key(key);
    assert.equal(ev.defaultPrevented, true, key);
    assert.equal(ev.propagationStopped, true, key);
  }
  // A key the popup has no use for passes straight through to the screen.
  const other = m.key('a');
  assert.equal(other.defaultPrevented, false);
  assert.equal(other.propagationStopped, false);
  m.key('Escape');
  assert.deepEqual(m.docListeners('keydown'), []);
  assert.deepEqual(m.docListeners('click'), []);
});

test('#298: the caret sitting in the menu does not make the outside-click close fire', () => {
  const m = mount();
  fire(m.trigger, 'click');
  fire(m.document, 'click', { target: m.list });
  assert.equal(m.open(), true);
  fire(m.document, 'click', { target: m.list.querySelector('#dd-opt-1') });
  assert.equal(m.open(), true);
  fire(m.document, 'click', { target: m.document.body });
  assert.equal(m.open(), false);
  assert.equal(m.named(m.list), null);
});

// ---- the filter-box path, which must not move ------------------------------

test('#298: with a filter box the attribute stays on the input, and the list stays out of the way', () => {
  const m = mount({ filter: true });
  fire(m.trigger, 'click');
  assert.equal(m.focused(), 'INPUT#dd-filter');
  assert.equal(m.named(m.filterInput), 'dd-opt-0');
  assert.equal(m.named(m.list), null);
  assert.equal(m.named(m.trigger), null);
  // The input holds the caret, so the list must not become focusable behind it.
  assert.equal(m.list.getAttribute('tabindex'), null);
  assert.equal(m.filterInput.getAttribute('aria-controls'), m.list.id);
});

test('#298: a filtered control announces the first match, and closing clears the input', () => {
  const m = mount({ filter: true });
  fire(m.trigger, 'click');
  m.filterInput.value = 'hi';
  fire(m.filterInput, 'input');
  assert.equal(m.active(), 'high');
  assert.equal(m.named(m.filterInput), 'dd-opt-0'); // the only visible row is now index 0
  m.key('Escape');
  assert.equal(m.named(m.filterInput), null);
  assert.equal(m.named(m.list), null);
  assert.equal(m.focused(), 'BUTTON#dd');
});

test('#298: a filter box keeps Home, End and Space for its own text caret', () => {
  const m = mount({ filter: true, value: 'normal' });
  fire(m.trigger, 'click');
  for (const key of ['Home', 'End', ' ']) {
    const ev = m.key(key);
    assert.equal(ev.defaultPrevented, false, key);
    assert.equal(m.open(), true, key);
    assert.equal(m.active(), 'normal', key); // the cursor did not move with the text caret
  }
});
