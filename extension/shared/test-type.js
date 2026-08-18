// Type of test — the square mark a test case wears in a list; glyphs in shared/icons.js
// (`type_*`), box and tint in components.css (`.type-mark`). Load AFTER icons.js.

/* global Icons, Tooltip */
/* exported TestType */
(() => {
  'use strict';

  // kind -> [glyph, tint class, the word the tooltip and the text form use]. The tint is
  // a GROUP the component styles ('alert', 'note'), not the kind's name repeated.
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

  // Only v2's `state` (manual | automated) and `automated` can be counted on; every flag
  // below them is sent when it applies and omitted when it does not.
  function of(rec) {
    if (!rec) return null;
    // Exceptions come FIRST: a detached test is still `automated`, and what a reader
    // needs to see on that row is that it lost its code.
    if (rec.defect || rec.has_defect) return 'defect';
    if (rec.detached) return 'detached';
    if (rec.out_of_sync || rec.outdated) return 'out-of-sync';
    const state = String(rec.state || rec.kind || '').toLowerCase();
    if (KINDS[state] && state !== 'note') return state;
    return rec.automated === true ? 'automated' : 'manual';
  }

  // `text: true` adds the label beside the glyph, for the places with room and no title
  // to lean on. Unknown kind → null, so a call site can hand this whatever it read.
  function mark(kind, { text = false } = {}) {
    const spec = KINDS[kind];
    if (!spec) return null;
    const [glyph, tint, word] = spec;
    const el = document.createElement('span');
    el.className = `type-mark ${tint}`;
    el.dataset.type = kind;
    // 12, not 16: these glyphs sit on their own 13.3333 frame (icons.js → BOXES), so
    // this IS the drawing's size — 12px of mark with 4px of air in the 20px square.
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

  // The mark for a RECORD, or null when it is not a kind we draw.
  const forRecord = (rec, opts) => mark(of(rec), opts);

  window.TestType = { KINDS, ORDER, of, mark, forRecord };
})();
