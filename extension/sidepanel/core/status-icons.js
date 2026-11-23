// Core, not a screen: core/views.js and six screens draw with this icon vocabulary.

/* global Icons, Tooltip, TestType */

const SVG_NS = 'http://www.w3.org/2000/svg'; // icons.js keeps its own copy private
// A rungroup's own `kind` (multienv) is not one of the three run kinds and draws nothing.
const RUN_KINDS = new Set(['manual', 'automated', 'mixed']);

const StatusIcons = {
  // `running` is absent: it is the loader, a drawn ring, not a glyph; `launching` renders as it.
  STATUS: {
    passed: 'status_passed',
    failed: 'status_failed',
    // A crossed ring: the plain one is an unrun test, so shape tells them apart, not colour alone.
    skipped: 'block',
    terminated: 'status_terminated',
  },
  // Pending, scheduled, queued, unknown — one ring-with-a-dot for all of them.
  NEUTRAL: 'status_record',
  // What the API calls a `file` suite is what the product calls a suite.
  FOLDER: 'tree_folder', // rungroups + TC-studio folders (grouping nodes)
  FILE: 'tree_suite',    // file/test-file suite nodes — and a run's suite sections
  CHEVRON: 'chevron_right', // rotates 90° when expanded
  ACCOUNT: 'person', // assignee chip: person marker before the name

  normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),

  // Thin alias over Icons.el — the one name every screen draws a glyph by.
  svgIcon(name, size = 16, ...cls) {
    return Icons.el(name, size, ...cls);
  },

  // `cls` carries the glyph's name, which the screen's rotate/colour rules key off.
  treeIcon(name, cls, emoji) {
    const custom = Icons.emoji(emoji, `tree-icon ${cls}`);
    // `data-emoji` is the drawn text, so a repaint can tell an already-right icon from one to replace.
    if (custom) { custom.dataset.emoji = custom.textContent; return custom; }
    const span = document.createElement('span');
    span.className = `tree-icon ${cls}`;
    span.append(StatusIcons.svgIcon(name, 16));
    return span;
  },

  // A row with nothing to unfold keeps the slot, so it lines up with an unfoldable sibling.
  treeSlot: () => Object.assign(document.createElement('span'), { className: 'tree-icon' }),

  runKind(kind) {
    const k = String(kind || '').toLowerCase();
    return RUN_KINDS.has(k) ? k : null;
  },

  // The mark with its word, for the run header; a list row uses the icon-only square.
  kindBadge(kind) {
    const k = StatusIcons.runKind(kind);
    if (!k || typeof TestType === 'undefined') return null;
    const el = TestType.mark(k, { text: true });
    if (el) Tooltip.set(el, `${k} run`);
    return el;
  },

  // A two-colour ring no single-path icon can be; `pathLength` makes the dash a percentage.
  spinnerEl() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'spinner');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const [cls, dash] of [['spinner-track', null], ['spinner-head', '25 75']]) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', '8');
      c.setAttribute('cy', '8');
      c.setAttribute('r', '5.68');
      c.setAttribute('pathLength', '100');
      // The quarter starts at 12 o'clock and runs clockwise.
      if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('transform', 'rotate(-90 8 8)'); }
      svg.append(c);
    }
    return svg;
  },

  // Running is the spinner, not an icon; both measure 20px, so a row does not shift when it ends.
  statusIcon(status) {
    const s = StatusIcons.normStatus(status);
    if (s === 'running') {
      const spinner = StatusIcons.spinnerEl();
      spinner.dataset.status = s;
      Tooltip.set(spinner, 'running');
      return spinner;
    }
    const icon = StatusIcons.svgIcon(StatusIcons.STATUS[s] || StatusIcons.NEUTRAL, 16, 'status-icon');
    icon.dataset.status = s;
    return icon;
  },
};
