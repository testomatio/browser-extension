// Type of test — the square mark a test case wears in a list, and the reading
// of a record that decides WHICH square. The glyphs live in shared/icons.js
// (the `type_*` block); the box, the tint and the corner live in
// components.css (`.type-mark`). This file is the vocabulary between them.
//
// Nine kinds, straight off the design library (◇ UI app library → Type of test,
// node 1730-20999) and grouped by what they mean rather than by hue:
//
//   how it runs      manual · automated · mixed
//   something is off out-of-sync · detached · defect
//   where it came    note · shared-from · shared-to
//
// Loaded AFTER icons.js in the side panel. Zero-build classic script (MV3 CSP:
// no inline scripts) — exposes one global.

/* global Icons, Tooltip */
/* exported TestType */
(() => {
  'use strict';

  // kind -> [glyph, tint class, the word the tooltip and the text form use].
  // The tint class is the component's own modifier, not a colour: `alert` and
  // `note` are the two GROUPS above, and three kinds share each of them, which
  // is the whole reason the modifier is not just the kind's name repeated.
  const KINDS = {
    manual: ['type_manual', 'manual', 'manual'],
    automated: ['type_automated', 'automated', 'automated'],
    mixed: ['type_mixed', 'mixed', 'mixed'],
    'out-of-sync': ['type_out_of_sync', 'alert', 'out of sync'],
    detached: ['type_detached', 'alert', 'detached'],
    defect: ['type_defect', 'alert', 'defect'],
    note: ['type_note', 'note', 'note'],
    'shared-from': ['type_shared_from', 'note', 'shared'],
    'shared-to': ['type_shared_to', 'note', 'shared'],
  };

  const ORDER = Object.keys(KINDS);

  // What kind IS this record? The two fields we can count on are the v2 test
  // record's `state` (manual | automated — a test imported from code leaves the
  // manual state, which is the one difference this mark exists to show) and the
  // v2 testrun record's own `automated` boolean. Everything below them is a
  // flag the API sends when it applies and omits when it does not, so each is
  // read defensively: an absent flag is simply not that kind, never a crash.
  //
  // Order is the library's own, exceptions first: a detached test is still
  // `automated`, and what a reader needs to see on that row is that it lost its
  // code, not how it runs.
  function of(rec) {
    if (!rec) return null;
    if (rec.defect || rec.has_defect) return 'defect';
    if (rec.detached) return 'detached';
    if (rec.out_of_sync || rec.outdated) return 'out-of-sync';
    const state = String(rec.state || rec.kind || '').toLowerCase();
    if (KINDS[state] && state !== 'note') return state;
    return rec.automated === true ? 'automated' : 'manual';
  }

  // The mark itself: the 20px square, icon only — the form a LIST wears, where
  // the row's own title is already carrying the words. `text: true` adds the
  // library's label beside the glyph, for the one-off places (a header, a
  // detail line) that have the room and no title to lean on.
  // Unknown kind → null, so a call site can hand this whatever it read.
  function mark(kind, { text = false } = {}) {
    const spec = KINDS[kind];
    if (!spec) return null;
    const [glyph, tint, word] = spec;
    const el = document.createElement('span');
    el.className = `type-mark ${tint}`;
    el.dataset.type = kind;
    // 12, not 16: the glyphs are on their own 13.3333 frame (icons.js → BOXES),
    // so this IS the drawing's size — 12px of mark with 4px of air a side in the
    // 20px square, one step down from the 13.3333 the library's own symbol draws
    // and the same size the status chip cuts its mark to.
    el.append(Icons.el(glyph, 12));
    if (text) {
      const label = document.createElement('span');
      label.className = 'type-label';
      label.textContent = word;
      el.append(label);
    } else if (typeof Tooltip !== 'undefined') {
      // Icon-only: the word the square stands for has to be reachable somehow.
      Tooltip.set(el, word);
    }
    return el;
  }

  // The mark for a RECORD, or null when it is not a kind we draw. One call for
  // the lists, so a row never spells out the read-then-draw pair itself.
  const forRecord = (rec, opts) => mark(of(rec), opts);

  window.TestType = { KINDS, ORDER, of, mark, forRecord };
})();
