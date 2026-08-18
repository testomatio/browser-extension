// The five priority glyphs, drawn from shared/icons.js (Material Symbols Rounded).
// Load AFTER icons.js in both hosts (sidepanel/index.html, editor/editor.html).

/* global Icons, Tooltip */
/* exported PriorityIcons */
(() => {
  'use strict';

  // Material Symbols names; colour always via CSS currentColor (no inline fills). `high`
  // is the CONTROL KEY caret, so `high` and `important` read as one arrow and two.
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

  // An absent or unknown priority IS `normal` — the priority the test actually runs at.
  // `size` is the glyph, not the box; the box is the `.prio` component's own.
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
