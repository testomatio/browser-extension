#!/usr/bin/env node
// The contract of extension/editor/priority-control.js (#192): what an unknown priority falls back
// to, which of the two ways in marks the editor dirty, and the document-level keys the open menu
// answers. Cases numbered as in #192. Run: node --test tests/priority-control.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, fire } from './helpers/mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// PRIO_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.PRIO_SRC || join(repoRoot, 'extension/editor/priority-control.js');
const source = readFileSync(SRC, 'utf8');
// The real glyph table, evaluated into the same context editor.html loads it into: ORDER is what
// cases 149 and 151 are about, and a stub of it would let the two drift without a test noticing.
const prioIconsSource = readFileSync(join(repoRoot, 'extension/shared/priority-icons.js'), 'utf8');

// One sandbox per test: the control keeps module state (the current priority, the open menu) and
// hangs two listeners on the document, so a shared document would let one case decide the next.
function load() {
  const tips = [];
  const document = makeDocument();
  const ctx = createContext({
    document,
    window: {},
    Icons: {
      markup: (name, size, o = {}) => `<i data-name="${name}" data-size="${size}" data-rotate="${o.rotate || 0}" class="${o.cls || ''}"></i>`,
    },
    Tooltip: { set: (el, tip) => tips.push([el.id || el.className, tip]) },
  });
  // priority-icons.js publishes on `window`; editor.html's other scripts read it as a bare global.
  runInContext(`${prioIconsSource}\nvar PriorityIcons = window.PriorityIcons;`, ctx);
  const PriorityControl = runInContext(`${source}\nPriorityControl;`, ctx);
  return { PriorityControl, PriorityIcons: ctx.PriorityIcons, document, tips };
}

// The control mounted into the document — focus() only records on an attached tree, and case 151
// is about where the caret lands after Escape.
function mount(initial = 'normal') {
  const env = load();
  const changes = [];
  const ctl = env.PriorityControl.buildPriorityControl(initial, () => changes.push(1));
  env.document.body.append(ctl.wrap);
  const btn = ctl.wrap.querySelector('#tc-priority');
  const menu = ctl.wrap.querySelector('#tc-priority-menu');
  return {
    ...env,
    ctl,
    changes,
    btn,
    menu,
    open: () => menu.hidden === false,
    active: () => { const li = menu.querySelector('li.active'); return li && li.dataset.priority; },
    // Every listener the module hung on the document, with the phase it asked for.
    docListeners: (type) => (env.document.listeners.get(type) || []).map((l) => l.capture),
  };
}

const ORDER = ['low', 'normal', 'high', 'important', 'critical'];

test('the module publishes exactly the surface editor.js destructures', () => {
  assert.deepEqual(Object.keys(load().PriorityControl).sort(), ['buildPriorityControl']);
  // The control's own surface: `wrap` is what the bar appends, the two others are the save path
  // and the e2e hook.
  const m = mount();
  assert.deepEqual(Object.keys(m.ctl).sort(), ['getPriority', 'setPriority', 'wrap']);
  assert.equal(m.ctl.wrap.className, 'tc-priority-wrap');
  // One option per priority, in the web's own order (#28: `high` before `important`).
  assert.deepEqual(m.menu.querySelectorAll('li').map((li) => li.dataset.priority), ORDER);
  assert.deepEqual(m.tips, [['tc-priority', 'Priority']]);
});

test('149: an unknown initial priority falls back to normal', () => {
  const m = mount('nonsense');
  assert.equal(m.ctl.getPriority(), 'normal');
  // The save path reads the button's dataset, so the fallback has to be there and not only inside.
  assert.equal(m.btn.dataset.priority, 'normal');
  assert.deepEqual(m.changes, []); // building the control is not an edit
});

test('149: a known initial priority is kept, glyph and label with it', () => {
  const m = mount('critical');
  assert.equal(m.ctl.getPriority(), 'critical');
  assert.equal(m.btn.querySelector('.tc-priority-label').textContent, 'critical');
  // 16, not the priority's own default size — the button's glyph is smaller than the list's.
  assert.equal(m.btn.querySelector('.tc-priority-ico i').getAttribute('data-size'), '16');
});

test('149: an absent priority is normal too — a new test has none', () => {
  assert.equal(mount(undefined).ctl.getPriority(), 'normal');
  assert.equal(mount(null).ctl.getPriority(), 'normal');
  assert.equal(mount('').ctl.getPriority(), 'normal');
});

test('150: setPriority ignores a value that is not a priority', () => {
  const m = mount('high');
  m.ctl.setPriority('nonsense');
  assert.equal(m.ctl.getPriority(), 'high');
  assert.deepEqual(m.changes, []);
});

// The two halves of case 150, asserted as they ship. They disagree on purpose-built dirt: the
// programmatic setter always marks, the picked option only marks on a real change.
test('150: setPriority marks the editor dirty even when the value did not change', () => {
  const m = mount('high');
  m.ctl.setPriority('high');
  assert.equal(m.ctl.getPriority(), 'high');
  assert.deepEqual(m.changes, [1]);
  m.ctl.setPriority('low');
  assert.equal(m.ctl.getPriority(), 'low');
  assert.deepEqual(m.changes, [1, 1]);
  assert.equal(m.open(), false); // a programmatic set never opens the menu
});

test('150: picking the option that is already current marks nothing', () => {
  const m = mount('high');
  fire(m.btn, 'click');
  fire(m.menu.querySelector('#tc-priority-opt-high'), 'click');
  assert.equal(m.ctl.getPriority(), 'high');
  assert.deepEqual(m.changes, []);
  assert.equal(m.open(), false); // picking still closes the menu
});

test('150: picking a different option marks once', () => {
  const m = mount('high');
  fire(m.btn, 'click');
  fire(m.menu.querySelector('#tc-priority-opt-low'), 'click');
  assert.equal(m.ctl.getPriority(), 'low');
  assert.deepEqual(m.changes, [1]);
});

test('151: the button opens and closes the menu, and the open menu takes the document keys', () => {
  const m = mount();
  assert.equal(m.open(), false);
  assert.deepEqual(m.docListeners('keydown'), []);
  fire(m.btn, 'click');
  assert.equal(m.open(), true);
  assert.equal(m.btn.getAttribute('aria-expanded'), 'true');
  // Both go on at CAPTURE: Esc and the arrows have to work whichever element holds focus.
  assert.deepEqual(m.docListeners('keydown'), [true]);
  assert.deepEqual(m.docListeners('click'), [true]);
  fire(m.btn, 'click');
  assert.equal(m.open(), false);
  assert.deepEqual(m.docListeners('keydown'), []);
  assert.deepEqual(m.docListeners('click'), []);
});

test('151: a closed control opens on the keys that open a listbox', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Spacebar']) {
    const m = mount();
    const ev = fire(m.btn, 'keydown', { key });
    assert.equal(m.open(), true, key);
    assert.equal(ev.defaultPrevented, true, key);
  }
  const m = mount();
  fire(m.btn, 'keydown', { key: 'a' });
  assert.equal(m.open(), false);
});

test('151: Escape closes the menu and puts the caret back on the button', () => {
  const m = mount();
  fire(m.btn, 'click');
  const ev = fire(m.document, 'keydown', { key: 'Escape' });
  assert.equal(m.open(), false);
  assert.equal(m.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(m.btn.getAttribute('aria-activedescendant'), null);
  assert.equal(m.document.activeElement, m.btn);
  // Stopped as well as prevented: Escape belongs to the menu, not to the editor behind it.
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(m.changes, []); // closing is not a pick
});

test('151: a click outside the control closes the menu, one inside does not', () => {
  const m = mount();
  fire(m.btn, 'click');
  fire(m.document, 'click', { target: m.menu.querySelector('#tc-priority-opt-low') });
  assert.equal(m.open(), true);
  fire(m.document, 'click', { target: m.document.body });
  assert.equal(m.open(), false);
});

test('151: ArrowUp clamps at the first option and ArrowDown at the last', () => {
  const m = mount();
  fire(m.btn, 'click');
  assert.equal(m.active(), 'normal'); // the menu opens on the current value
  const key = (k) => fire(m.document, 'keydown', { key: k });
  assert.equal(key('ArrowUp').defaultPrevented, true);
  assert.equal(m.active(), 'low');
  key('ArrowUp');
  assert.equal(m.active(), 'low'); // clamped, not wrapped round to critical
  for (let i = 0; i < 4; i += 1) key('ArrowDown');
  assert.equal(m.active(), 'critical');
  key('ArrowDown');
  assert.equal(m.active(), 'critical');
  // Moving the highlight is not picking: nothing is saved and nothing is dirty yet.
  assert.equal(m.ctl.getPriority(), 'normal');
  assert.deepEqual(m.changes, []);
});

test('151: the highlight is the aria state too, on exactly one option', () => {
  const m = mount();
  fire(m.btn, 'click');
  fire(m.document, 'keydown', { key: 'ArrowDown' });
  const on = m.menu.querySelectorAll('li').filter((li) => li.getAttribute('aria-selected') === 'true');
  assert.deepEqual(on.map((li) => li.dataset.priority), ['high']);
  assert.equal(m.btn.getAttribute('aria-activedescendant'), 'tc-priority-opt-high');
});

test('151: Enter and Space commit whatever the arrows highlighted', () => {
  for (const key of ['Enter', ' ', 'Spacebar']) {
    const m = mount();
    fire(m.btn, 'click');
    fire(m.document, 'keydown', { key: 'ArrowDown' });
    const ev = fire(m.document, 'keydown', { key });
    assert.equal(m.ctl.getPriority(), 'high', key);
    assert.equal(m.open(), false, key);
    assert.equal(ev.defaultPrevented, true, key);
    assert.deepEqual(m.changes, [1], key);
  }
});

// Case 148 — the widget's ARIA, D P2-14. `aria-activedescendant` sits on a
// <button aria-haspopup="listbox">, which does not support it, and nothing points the button at the
// list it owns, so a screen reader never hears which option is highlighted. Today's shape first:
test('148: the aria the control ships today, unsupported combination and all', () => {
  const m = mount();
  assert.equal(m.btn.tagName, 'BUTTON');
  assert.equal(m.btn.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(m.menu.getAttribute('role'), 'listbox');
  fire(m.btn, 'click');
  // Set on the button — where it has no meaning — rather than on a focused listbox.
  assert.equal(m.btn.getAttribute('aria-activedescendant'), 'tc-priority-opt-normal');
  assert.equal(m.btn.getAttribute('aria-controls'), null);
});

test.todo('148 (#109): the highlighted option is announced — the listbox is owned and focusable', () => {
  const m = mount();
  fire(m.btn, 'click');
  // aria-controls (or aria-owns) is what ties the button to #tc-priority-menu, and
  // aria-activedescendant belongs on whatever then holds focus — not on a plain button.
  assert.equal(m.btn.getAttribute('aria-controls'), 'tc-priority-menu');
  assert.equal(m.btn.getAttribute('aria-activedescendant'), null);
});
