// The square test-type mark; glyphs in shared/icons.js, box in components.css. Load after icons.js.

/* global Icons, Tooltip */
/* exported TestType */
(() => {
  'use strict';

  // The tint is a group the component styles ('alert', 'note'), not the kind's name repeated.
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

  // Only v2's `state` and `automated` are always sent; the other flags only when they apply.
  function of(rec) {
    if (!rec) return null;
    // Exceptions first: a detached test is still `automated`, but the reader must see it lost its code.
    if (rec.defect || rec.has_defect) return 'defect';
    if (rec.detached) return 'detached';
    if (rec.out_of_sync || rec.outdated) return 'out-of-sync';
    const state = String(rec.state || rec.kind || '').toLowerCase();
    if (KINDS[state] && state !== 'note') return state;
    return rec.automated === true ? 'automated' : 'manual';
  }

  // Unknown kind → null, so a call site can hand this whatever it read.
  function mark(kind, { text = false } = {}) {
    const spec = KINDS[kind];
    if (!spec) return null;
    const [glyph, tint, word] = spec;
    const el = document.createElement('span');
    el.className = `type-mark ${tint}`;
    el.dataset.type = kind;
    // 12, not 16: these glyphs sit on their own 13.3333 frame, so this is the drawing's size.
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

  const forRecord = (rec, opts) => mark(of(rec), opts);

  window.TestType = { KINDS, ORDER, of, mark, forRecord };
})();
