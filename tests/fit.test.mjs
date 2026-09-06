#!/usr/bin/env node
// extension/sidepanel/core/fit.js (#202, the fifth and last seam out of core/views.js): the two rows
// that measure themselves — the filter chips that hand their overflow to a "…" menu, and the create
// buttons that drop a word when the field beside them runs out of room.
// The module needs a document, Icons, Tooltip and a ResizeObserver, and nothing else: no state, no
// capabilities, no screen opener. That is the seam's value — the layout simulation, which is the one
// thing here a browser normally decides, can be driven at exact widths without a panel around it.
// tests/views.test.mjs keeps its own rows (V40-V51) over the same behaviour as the panel performs it,
// through the bare fitFilterChips/initActionLabelFit delegates every screen calls. The duplication is
// deliberate: those say the panel still behaves, these say what the two fitters actually are.
// TRAP: `ResizeObserver` is NOT a vm-realm global. Without the fake below both fitters would throw on
// their first line, and every row would be failing for the wrong reason — so F4 and F5 pin the
// observer being armed and its width guard, not merely that a fit ran.
// TRAP: mini-dom measures nothing. `clientWidth` is set by hand and `scrollWidth` is a getter that
// adds up whichever chips are still showing, which is exactly what the fit reads between its writes.
// Run: node --test tests/fit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el, fire } from './helpers/panel-harness.mjs';

function load() {
  const doc = makeDocument([]);
  const observers = []; // every ResizeObserver the two fitters arm: callback kept, fired on demand

  const h = loadScreen('fit', {
    dir: CORE_SRC,
    document: doc,
    globals: {
      // shared/icons.js:238 — the arity matters: `cls` reaches classList.add, which throws on a space.
      Icons: {
        el: (name, size = 16, ...cls) => {
          const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
          n.classList.add(...cls.filter(Boolean));
          return n;
        },
      },
      Tooltip: { set: (n, tip) => { if (n) n.dataset.tip = tip; } },
      // Never fires itself: the real callback re-enters the fitter, and the width guard is the only
      // thing that stops that — an eager fake would recurse instead of letting the guard be read.
      ResizeObserver: class {
        constructor(cb) { this.cb = cb; this.node = null; observers.push(this); }
        observe(n) { this.node = n; }
        disconnect() { this.node = null; }
      },
    },
    exported: '({ Fit, LABEL_FIT_MIN_FIELD })',
  });

  return { ...h, doc, observers, fit: h.screen.Fit, lex: h.screen };
}

// A row that measures the way a browser measures one: what it reports is the chips it is still
// SHOWING, plus the "…" trigger once that is up. screens/runs-list.js:457 is the chip's real shape.
const TRIGGER_W = 32;
function filterBar(h, widths, clientWidth) {
  const bar = el('div', { className: 'filter-bar' });
  const chips = widths.map((w, i) => {
    const chip = el('button', { className: 'btn secondary size-sm filter-chip', dataset: { filter: `f${i}` } });
    chip.append(el('span', { className: 'filter-label' }, `Filter ${i}`),
      el('span', { className: 'counter' }, String(i)));
    chip.w = w;
    return chip;
  });
  bar.append(...chips);
  h.doc.body.append(bar);
  bar.clientWidth = clientWidth;
  Object.defineProperty(bar, 'scrollWidth', {
    configurable: true,
    get: () => {
      const wrap = bar.querySelector('.filter-more');
      return chips.filter((c) => !c.hidden).reduce((n, c) => n + c.w, 0)
        + (wrap && !wrap.hidden ? TRIGGER_W : 0);
    },
  });
  return { bar, chips };
}

// ---------- the seam itself ----------

test('F1 (#202): the fitters load on a document, Icons, Tooltip and a ResizeObserver — nothing else', () => {
  const h = load();
  assert.deepEqual(Object.keys(h.fit).sort(),
    ['actionLabels', 'ensureFilterMore', 'filterChips', 'initActionLabels', 'renderFilterMore']);
  const { bar, chips } = filterBar(h, [50, 50], 300);
  h.fit.filterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false], 'and a fit runs with no panel around it');
});

// ---------- the filter row that sends its overflow to a menu ----------

test('F2 (#202): a row whose chips all fit keeps every one of them, and the "…" never appears', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50], 400);
  h.fit.filterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);
  const wrap = bar.querySelector('.filter-more');
  assert.equal(wrap.hidden, true, 'the trigger is in the row but takes up no space in it');
  assert.equal(wrap.querySelector('.filter-more-menu').childNodes.length, 0);
});

test('F3 (#202): however narrow the pane gets, the chip at index 0 is the one that never goes', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [200, 200], 100);
  h.fit.filterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, true],
    'a row with no chip left showing would tell the tester nothing about what it is filtered to');
  assert.equal(bar.querySelectorAll('.menu-option').length, 1);

  // Even one chip alone, far too wide for the row, stays: the loop is bounded at index 1.
  const only = filterBar(h, [500], 40);
  h.fit.filterChips(only.bar);
  assert.deepEqual(only.chips.map((c) => c.hidden), [false]);
  assert.equal(only.bar.querySelectorAll('.menu-option').length, 0);
});

test('F4 (#202): a row with no width yet is armed FIRST and measured never — the order is the fix', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50], 0);
  h.fit.filterChips(bar);
  assert.equal(h.observers.length, 1, 'armed BEFORE the early return, which is what a hidden row needs');
  assert.equal(h.observers[0].node, bar);
  assert.deepEqual(chips.map((c) => c.hidden), [undefined, undefined, undefined], 'and nothing was fitted');
  assert.equal(bar.querySelector('.filter-more'), null, 'not even the "…" was built');

  bar.clientWidth = 150; // the screen opens and the observer brings the row back
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);
  assert.equal(h.observers.length, 1, 'still the one observer — a second would re-fit forever');
});

test('F5 (#202): the observer re-fits for a width that really moved, and for no other', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50], 300);
  h.fit.filterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);

  // A mark the fit would wipe out: the row re-shows every chip before it measures anything.
  chips[1].hidden = true;
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, true, false],
    'the width the fit itself settled on comes back through the observer; re-fitting it is a loop');

  bar.clientWidth = 250; // the pane really moved — and WIDER, which a "grew" test alone would miss
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);

  chips[1].hidden = true;
  bar.clientWidth = 200; // …and narrower, which is the same question asked from the other side
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, false, false]);
  assert.equal(h.observers.length, 1);
});

// F5 asks the guard's question of a row where everything fitted. A row that HID something takes the
// other branch out of the fitter, and it has to remember its width too — otherwise the guard is
// always true and the row re-fits on every tick the observer fires, forever.
test('F5b (#202): a row that hid something remembers the width it hid at, same as one that did not', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [60, 60, 60, 60], 150);
  h.fit.filterChips(bar);
  assert.deepEqual(chips.map((c) => c.hidden), [false, true, true, true], 'three went into the "…"');

  // The same mark F5 uses: only a re-fit would wipe it, because the fit re-shows every chip first.
  chips[3].hidden = false;
  h.observers[0].cb();
  assert.deepEqual(chips.map((c) => c.hidden), [false, true, true, false],
    'the width it settled on came back through the observer, and the guard let nothing through');
});

test('F6 (#202): the "…" menu is built once per bar, so a re-fit cannot close it under the pointer', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fit.filterChips(bar);
  const first = h.fit.ensureFilterMore(bar);
  first.trigger.click();
  assert.equal(first.menu.hidden, false);

  bar.clientWidth = 140;
  h.fit.filterChips(bar); // the pane was nudged; the row re-fits under the open menu
  assert.equal(h.fit.ensureFilterMore(bar), first, 'the same menu, not a torn-down and rebuilt one');
  assert.equal(first.menu.hidden, false, 'and it is still open');
  assert.equal(bar.querySelectorAll('.filter-more').length, 1, 'one trigger in the row, not two');

  const other = filterBar(h, [50, 50, 50, 50], 150);
  h.fit.filterChips(other.bar);
  assert.notEqual(h.fit.ensureFilterMore(other.bar), first, 'built once per bar, not once per page');
});

test('F7 (#202): the "…" stands in for what it hides — including the filter that is chosen', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50, 50], 150);
  chips[3].classList.add('selected');
  h.fit.filterChips(bar);

  const { trigger, menu } = h.fit.ensureFilterMore(bar);
  const options = menu.querySelectorAll('.menu-option');
  assert.deepEqual(options.map((li) => li.getAttribute('aria-selected')), ['false', 'true']);
  assert.equal(trigger.classList.contains('selected'), true, 'or the row would look unfiltered');
  assert.equal(trigger.classList.contains('secondary'), false);

  chips[3].classList.remove('selected');
  h.fit.filterChips(bar);
  assert.equal(h.fit.ensureFilterMore(bar).trigger.classList.contains('selected'), false,
    'and it drops the mark again the moment the chosen chip is not one of the hidden ones');
  assert.equal(h.fit.ensureFilterMore(bar).trigger.classList.contains('secondary'), true);
});

test('F8 (#202): Escape closes the "…" and hands the caret back to the trigger', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fit.filterChips(bar);
  const { trigger, menu } = h.fit.ensureFilterMore(bar);

  trigger.click();
  assert.equal(menu.hidden, false);
  const ev = fire(menu, 'keydown', { key: 'Escape', bubbles: true });
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(h.doc.activeElement, trigger, 'Escape puts the caret back where the tester left it');
  assert.equal(ev.defaultPrevented, true, 'and the key does not also reach whatever is behind the menu');
  assert.equal((h.doc.listeners.get('keydown') || []).length, 0, 'the document-level closer went too');
});

test('F9 (#202): a click anywhere outside the "…" closes it, one inside leaves it standing', () => {
  const h = load();
  const { bar } = filterBar(h, [50, 50, 50, 50], 150);
  h.fit.filterChips(bar);
  const { trigger, menu } = h.fit.ensureFilterMore(bar);
  const elsewhere = el('button');
  h.doc.body.append(elsewhere);

  trigger.click();
  fire(menu, 'click', { bubbles: true });
  assert.equal(menu.hidden, false, 'a click on the menu itself is not a click away from it');

  fire(elsewhere, 'click', { bubbles: true });
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal((h.doc.listeners.get('click') || []).length, 0, 'and the closer did not outlive the menu');
});

test('F10 (#202): rendering the menu with nothing to hide takes the trigger and an open menu down', () => {
  const h = load();
  const { bar, chips } = filterBar(h, [50, 50, 50], 300);
  h.fit.renderFilterMore(bar, [chips[2]]);
  const { wrap, trigger, menu } = h.fit.ensureFilterMore(bar);
  assert.equal(wrap.hidden, false);
  assert.deepEqual(menu.querySelectorAll('.menu-option').map((li) => li.childNodes[0].textContent),
    ['Filter 2']);
  assert.deepEqual(menu.querySelectorAll('.menu-option').map((li) => li.childNodes[1].className),
    ['counter'], 'each option carries the chip’s own count, cloned');

  trigger.click();
  h.fit.renderFilterMore(bar, []);
  assert.equal(wrap.hidden, true);
  assert.equal(menu.hidden, true, 'a menu left open over a hidden trigger cannot be dismissed');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

// ---------- the create-button labels ----------

function labelBar(h, fieldWidth) {
  const bar = el('div', { className: 'toolbar' });
  const field = el('div', { className: 'field' });
  const btn = el('button', { className: 'btn primary fit-label', dataset: { label: 'New run' } });
  bar.append(field, btn);
  h.doc.body.append(bar);
  bar.clientWidth = 300;
  field.clientWidth = fieldWidth;
  return { bar, field, btn };
}

test('F11 (#202): 144px of field is the whole rule, and the short button keeps its whole name', () => {
  const h = load();
  const { bar, field, btn } = labelBar(h, 143);
  h.fit.actionLabels(bar);
  assert.equal(btn.classList.contains('is-short'), true);
  assert.equal(btn.getAttribute('aria-label'), 'New run', 'the reader still hears all of it');

  field.clientWidth = 144; // one pixel more, and the row goes back to both words
  h.fit.actionLabels(bar);
  assert.equal(btn.classList.contains('is-short'), false, 'or a pane dragged WIDER keeps the short label');
  assert.equal(btn.getAttribute('aria-label'), null, 'and the name is not announced twice over');
  assert.equal(h.lex.LABEL_FIT_MIN_FIELD, 144);
});

test('F12 (#202): a toolbar is armed once, and re-fits only when the pane really moved', () => {
  const h = load();
  const { bar, field, btn } = labelBar(h, 200);
  const second = el('button', { className: 'btn fit-label', dataset: { label: 'New test' } });
  bar.append(second);

  h.fit.initActionLabels();
  assert.equal(h.observers.length, 1, 'one observer for the bar, not one per button on it');
  assert.equal(btn.classList.contains('is-short'), false);

  field.clientWidth = 100;
  bar.clientWidth = 200;
  h.observers[0].cb();
  assert.deepEqual([btn, second].map((b) => b.classList.contains('is-short')), [true, true]);

  btn.classList.remove('is-short'); // a mark the next fit would put straight back
  h.observers[0].cb();
  assert.equal(btn.classList.contains('is-short'), false, 'the same width again re-measures nothing');

  bar.clientWidth = 160; // narrower, which the "changed at all" guard has to notice as well
  h.observers[0].cb();
  assert.equal(btn.classList.contains('is-short'), true);
  assert.equal(h.observers.length, 1);
});

test('F13 (#202): a toolbar with no field, and a call with no bar at all, are both no-ops', () => {
  const h = load();
  const bare = el('div', { className: 'toolbar' });
  bare.append(el('button', { className: 'btn fit-label', dataset: { label: 'New run' } }));
  h.doc.body.append(bare);
  bare.clientWidth = 50;

  h.fit.actionLabels(bare);
  assert.equal(bare.querySelector('.fit-label').classList.contains('is-short'), false,
    'there is nothing beside the button to measure, so nothing is decided');
  assert.equal(h.observers.length, 1, 'it is still armed, the way a row with no width is');

  h.fit.actionLabels(null);
  h.fit.filterChips(null);
  assert.equal(h.observers.length, 1, 'and neither fitter arms an observer on nothing');
});
