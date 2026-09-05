#!/usr/bin/env node
// #179: the small coloured square every test wears in a list — extension/shared/test-type.js. A
// tester reads that square before they read the title: it is how they tell a manual case from an
// automated one, and how a defect, a detached test or one that has drifted out of sync announces
// itself on a row that otherwise looks fine.
// Two things here are easy to get quietly wrong. The PRECEDENCE: the server sends the flags that
// apply and omits the ones that do not, so `of()` is a ladder — the exceptions are read BEFORE
// `state`, because a detached test is still `automated` and what the reader needs is the loss of its
// code. And the ASYMMETRY in mark(): `Tooltip` is guarded, `Icons` is not.
// Run: node --test tests/test-type.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain } from './helpers/shared-harness.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

// One IIFE publishing on `window`; it keeps no state between calls, so a fresh load is only needed
// by the rows that want one of the two globals ABSENT.
function load({ icons = true, tooltip = true } = {}) {
  const doc = makeDocument();
  const calls = { icons: [], tips: [] };
  const sandbox = { window: {}, document: doc };
  if (icons) {
    // shared/icons.js's own arity — (name, size, ...cls) — so a row can assert the size asked for.
    sandbox.Icons = {
      el: (name, size = 16, ...cls) => {
        calls.icons.push({ name, size, cls: [...cls] });
        const node = doc.createElement('span');
        node.className = 'md-icon';
        node.dataset.icon = name;
        return node;
      },
    };
  }
  if (tooltip) {
    // The real one writes the tip onto the node it is handed (shared/tooltip.js), so a recorder
    // alone could not tell a tip that landed on the mark from one that went nowhere.
    sandbox.Tooltip = {
      set: (node, tip) => {
        calls.tips.push({ node, tip });
        if (node && node.dataset) node.dataset.tip = String(tip);
      },
    };
  }
  loadInto(sandbox, ['shared/test-type.js']);
  return { T: sandbox.window.TestType, doc, calls };
}

const { T } = load();
const kids = (el) => el.childNodes.map((n) => (n.nodeType === 1 ? n.tagName : n.nodeValue));

// ---- the ladder: which square, out of whatever the server sent -------------------------------

test('1: nobody at all — a null or missing record wears no square rather than a wrong one', () => {
  assert.equal(T.of(null), null);
  assert.equal(T.of(undefined), null);
});

test('2: a record with none of the fields set reads as a manual test', () => {
  assert.equal(T.of({}), 'manual');
});

test('3: the automated flag is what makes a test read as automated', () => {
  assert.equal(T.of({ automated: true }), 'automated');
});

test('4: a truthy-but-not-true automated flag is NOT automated — the check is strict', () => {
  assert.equal(T.of({ automated: 'yes' }), 'manual');
  assert.equal(T.of({ automated: 1 }), 'manual');
});

test('5: a detached test says it lost its code, not that it is automated', () => {
  assert.equal(T.of({ state: 'automated', detached: true }), 'detached');
});

test('6: a defect outranks every other exception on the same row', () => {
  assert.equal(T.of({ defect: true, detached: true, out_of_sync: true }), 'defect');
});

test('7: the older has_defect spelling is read as a defect too', () => {
  assert.equal(T.of({ has_defect: true }), 'defect');
});

test('8: the older outdated spelling is read as out of sync', () => {
  assert.equal(T.of({ outdated: true }), 'out-of-sync');
  assert.equal(T.of({ out_of_sync: true }), 'out-of-sync');
});

test('9: a state shouted in capitals is still the same state', () => {
  assert.equal(T.of({ state: 'MANUAL' }), 'manual');
  assert.equal(T.of({ state: 'Automated' }), 'automated');
});

test('10: with no state at all the kind field is what the square is read from', () => {
  assert.equal(T.of({ kind: 'mixed' }), 'mixed');
});

test('11: a note arriving as a state is deliberately NOT drawn as a note — it falls back to manual', () => {
  assert.equal(T.of({ state: 'note' }), 'manual');
  assert.equal(T.of({ kind: 'note' }), 'manual');
  // …and the same word arriving through automated: still not a note.
  assert.equal(T.of({ state: 'note', automated: true }), 'automated');
});

test('12: a test shared in from another project keeps that state', () => {
  assert.equal(T.of({ state: 'shared-from' }), 'shared-from');
  assert.equal(T.of({ state: 'shared-to' }), 'shared-to');
});

test('13: a state the panel has never heard of falls through to the automated flag', () => {
  assert.equal(T.of({ state: 'wat', automated: true }), 'automated');
  assert.equal(T.of({ state: 'wat' }), 'manual');
});

test('14: an empty state with automated off is a manual test', () => {
  assert.equal(T.of({ state: '', automated: false }), 'manual');
});

// ---- the square itself -----------------------------------------------------------------------

test('15: a defect draws the alert-tinted square with its own glyph at 12px, and says which kind it is', () => {
  const h = load();
  const m = h.T.mark('defect');
  assert.equal(m.tagName, 'SPAN');
  assert.equal(m.className, 'type-mark alert'); // the tint is the GROUP, not the kind repeated
  assert.equal(m.getAttribute('data-type'), 'defect');
  // 12, not 16: the glyph sits on its own 13.3333 frame, so this IS the drawing's size.
  assert.deepEqual(plain(h.calls.icons), [{ name: 'type_defect', size: 12, cls: [] }]);
  assert.deepEqual(kids(m), ['SPAN']);
});

test('16: asked for text, the square carries the word beside the glyph and no tooltip at all', () => {
  const h = load();
  const m = h.T.mark('defect', { text: true });
  const label = m.querySelector('.type-label');
  assert.equal(label.textContent, 'defect');
  assert.deepEqual(kids(m), ['SPAN', 'SPAN']); // glyph first, then the word
  assert.deepEqual(h.calls.tips, []);
});

test('17: out of sync reads as three words in the tooltip and as three words in the label', () => {
  const h = load();
  const m = h.T.mark('out-of-sync');
  assert.equal(m.className, 'type-mark alert');
  assert.deepEqual(plain(h.calls.tips.map((c) => c.tip)), ['out of sync']);
  assert.equal(h.calls.tips[0].node, m); // the tip landed on the mark, not somewhere near it
  const withText = load();
  assert.equal(withText.T.mark('out-of-sync', { text: true }).querySelector('.type-label').textContent,
    'out of sync');
});

test('18: a kind the panel does not draw gets no square rather than an empty box', () => {
  const h = load();
  assert.equal(h.T.mark('nope'), null);
  assert.equal(h.T.mark(''), null);
  assert.equal(h.T.mark(undefined), null);
  assert.deepEqual(h.calls.icons, []);
});

test('19: a record naming nobody draws nothing, and a record naming a defect draws the defect', () => {
  const h = load();
  assert.equal(h.T.forRecord(null), null);
  const m = h.T.forRecord({ defect: true, automated: true });
  assert.equal(m.getAttribute('data-type'), 'defect');
  // …and the options ride through to mark() rather than being dropped on the way.
  assert.equal(h.T.forRecord({}, { text: true }).querySelector('.type-label').textContent, 'manual');
});

test('20: on a page with no tooltip machinery the square still draws — the tip is simply skipped', () => {
  const h = load({ tooltip: false });
  const m = h.T.mark('note');
  assert.equal(m.className, 'type-mark note');
  assert.equal(m.getAttribute('data-tip'), null);
});

test('21: on a page with no icon set the square THROWS — Icons is unguarded where Tooltip is not', () => {
  const h = load({ icons: false });
  assert.throws(() => h.T.mark('note'), /Icons is not defined/);
});

test('22: the filter row draws the kinds in the table’s own order', () => {
  assert.deepEqual(plain(T.ORDER), Object.keys(plain(T.KINDS)));
  assert.deepEqual(plain(T.ORDER), ['manual', 'automated', 'mixed', 'out-of-sync', 'detached',
    'defect', 'note', 'shared-from', 'shared-to']);
});

test('22b: the whole table — glyph, tint and the word a tester reads — as it stands', () => {
  assert.deepEqual(plain(T.KINDS), {
    manual: ['type_manual', 'manual', 'manual'],
    automated: ['type_automated', 'automated', 'automated'],
    mixed: ['type_mixed', 'mixed', 'mixed'],
    'out-of-sync': ['type_out_of_sync', 'alert', 'out of sync'],
    detached: ['type_detached', 'alert', 'detached'],
    defect: ['type_defect', 'alert', 'defect'],
    note: ['type_note', 'note', 'note'],
    'shared-from': ['type_shared_from', 'note', 'shared'],
    'shared-to': ['type_shared_to', 'note', 'shared'],
  });
  // Every kind in the table draws, and each one names itself on the node the panel styles.
  for (const kind of plain(T.ORDER)) {
    const h = load();
    const m = h.T.mark(kind);
    assert.equal(m.getAttribute('data-type'), kind);
    assert.equal(m.className, `type-mark ${plain(T.KINDS)[kind][1]}`);
    assert.equal(h.calls.icons[0].name, plain(T.KINDS)[kind][0]);
  }
});
