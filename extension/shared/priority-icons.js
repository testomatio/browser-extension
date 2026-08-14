// Shared priority icons — the five priority glyphs, drawn from the panel's one
// icon set (shared/icons.js: Material Symbols Rounded, wght 400, fill 0). Loaded
// AFTER icons.js in both hosts (sidepanel/index.html, editor/editor.html).
// Zero-build classic script (MV3 CSP: no inline scripts) — exposes one global.

/* global Icons, Tooltip */
/* exported PriorityIcons */
(() => {
  'use strict';

  // Material Symbols names; colour always via CSS currentColor (no inline fills).
  // The set mirrors the design library's ladder (◇ UI app library → Priority,
  // node 3633-13383): a chevron down for low, a plain ring for normal, a caret
  // up for high, doubled for important, and a label pointing up for critical.
  // `high` is the CONTROL KEY caret, not the arrow one step below it — the two
  // are the same gesture at different weights, and the library draws the wide,
  // shallow one so `high` and `important` read as one arrow and two rather than
  // as two different marks.
  const NAMES = {
    low: 'keyboard_arrow_down',
    normal: 'radio_button_unchecked',
    high: 'keyboard_control_key',
    important: 'keyboard_double_arrow_up',
    critical: 'label_important',
  };

  // Canon sizes (priority/icons.hbs): normal is intentionally smaller.
  const DEFAULT_SIZE = { low: 19, normal: 12, important: 19, high: 19, critical: 19 };

  const ORDER = ['low', 'normal', 'important', 'high', 'critical'];

  // Returns an SVG string for a priority (fill=currentColor), or '' if unknown.
  function svg(priority, size) {
    const name = NAMES[priority];
    if (!name) return '';
    const s = size || DEFAULT_SIZE[priority] || 19;
    // critical = the label turned to point upwards (mirrors ember-mdi @rotate).
    return Icons.markup(name, s, { rotate: priority === 'critical' ? 270 : 0 });
  }

  // The `.prio` component itself (components.css), ready to drop into a row: the
  // glyph in the box that gives every priority the same width, whichever of the
  // five it is, so a list of them lines up on one vertical.
  // An absent or unknown priority IS `normal` — that is what the editor's picker
  // opens on for a test that has never been given one (editor.js), so it is the
  // priority the test actually runs at. Drawing nothing instead left a list where
  // only some rows carried a mark and the rest started a box further left: it
  // read as data half-loaded rather than as tests that differ.
  // `size` is the glyph, not the box; the box is the component's own.
  function mark(priority, size) {
    const p = ORDER.includes(priority) ? priority : 'normal';
    const html = svg(p, size);
    if (!html) return null;
    const el = document.createElement('span');
    el.className = 'prio';
    el.dataset.priority = p;
    el.innerHTML = html; // our own markup, from the vendored path table
    if (typeof Tooltip !== 'undefined') Tooltip.set(el, `Priority: ${p}`);
    return el;
  }

  window.PriorityIcons = { ORDER, svg, mark };
})();
