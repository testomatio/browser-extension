// The panel's icon vocabulary: the status glyph map, the tree marks a row wears, the running ring
// and the run-kind badge. Core, not a screen — core/views.js and six screens draw with it.

/* global Icons, Tooltip, TestType */

const SVG_NS = 'http://www.w3.org/2000/svg'; // icons.js keeps its own copy private
// manual | automated | mixed are the three the product gives a run; a RUNGROUP's
// own `kind` (multienv) is not one of them and draws nothing.
const RUN_KINDS = new Set(['manual', 'automated', 'mixed']);

const StatusIcons = {
  // `running` is deliberately absent: it is the LOADER, a drawn ring rather than a
  // glyph (statusIcon below). `launching` renders as `running`.
  STATUS: {
    passed: 'status_passed',
    failed: 'status_failed',
    // Its own crossed ring: the plain ring below belongs to a test nobody has run, so the two
    // are told apart by shape and not by colour alone.
    skipped: 'block',
    terminated: 'status_terminated',
  },
  // Pending, scheduled, queued, unknown — one ring-with-a-dot for all of them.
  NEUTRAL: 'status_record',
  // What the API calls a `file` suite is what the product calls a SUITE.
  FOLDER: 'tree_folder', // rungroups + TC-studio folders (grouping nodes)
  FILE: 'tree_suite',    // file/test-file suite nodes — and a run's suite sections
  CHEVRON: 'chevron_right', // rotates 90° when expanded
  ACCOUNT: 'person', // assignee chip: person marker before the name

  normStatus: (s) => (s === 'launching' ? 'running' : s || 'unknown'),

  // Thin alias over Icons.el — the one name every screen draws a glyph by.
  svgIcon(name, size = 16, ...cls) {
    return Icons.el(name, size, ...cls);
  },

  // `cls` carries the glyph's own name (`chevron`/`folder-icon`/`file-icon`) — the
  // screen's rotate/colour rules key off it. `emoji` is the project's override.
  treeIcon(name, cls, emoji) {
    const custom = Icons.emoji(emoji, `tree-icon ${cls}`);
    // `data-emoji` lets a repaint tell an already-right icon from one to replace.
    // It is the DRAWN text — an unresolved `:shortcode:` falls back and carries none.
    if (custom) { custom.dataset.emoji = custom.textContent; return custom; }
    const span = document.createElement('span');
    span.className = `tree-icon ${cls}`;
    span.append(StatusIcons.svgIcon(name, 16));
    return span;
  },

  // A row with nothing to unfold keeps the slot anyway: its glyph and title line up
  // with an unfoldable sibling's (TC studio, reported steps).
  treeSlot: () => Object.assign(document.createElement('span'), { className: 'tree-icon' }),

  runKind(kind) {
    const k = String(kind || '').toLowerCase();
    return RUN_KINDS.has(k) ? k : null;
  },

  // The mark WITH its word, for the run header; a list row uses the icon-only square.
  kindBadge(kind) {
    const k = StatusIcons.runKind(kind);
    if (!k || typeof TestType === 'undefined') return null;
    const el = TestType.mark(k, { text: true });
    if (el) Tooltip.set(el, `${k} run`);
    return el;
  },

  // The running mark is a two-colour ring, which no single-path icon can be: an SVG of two
  // circles — the track, and a quarter of it in the head colour — spun whole by CSS. Vector, so
  // the ring stays round and the quarter's ends stay sharp at 1x as at 2x; the gradient ring
  // this replaces drew hard colour stops that rotated as staircases. `pathLength` makes the
  // dash a percentage of the circumference, so the quarter reads "25 75" whatever the radius.
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
      // The quarter starts at 12 o'clock and runs clockwise, as the conic one did.
      if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('transform', 'rotate(-90 8 8)'); }
      svg.append(c);
    }
    return svg;
  },

  // `data-status` drives the colour. RUNNING comes back as the ring of its own (`spinnerEl`),
  // not an icon — both forms measure 20px, so a row does not shift when it finishes.
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
