// The skeleton VOCABULARY (IIFE global `Sk`): the two or three primitives every
// loading placeholder in this extension is built out of.
//
// It is deliberately small, and deliberately not a screen. The shapes live in
// shared/components.css (the SKELETON section) — `.skeleton.line`, `.circle`,
// `.chip`, `.control` — and this file is only the assembly: make one, give it
// the width the thing it stands in for runs to.
//
// The split it exists for: WHICH placeholder a screen puts up is that screen's
// business (sidepanel/core/skeleton.js holds one plan per panel view, the
// editor draws its own read-only page), but the bars themselves are the same
// bars everywhere, and two documents now draw them — the panel and
// editor.html, which have no script in common. Same reason shared/empty-state.js
// sits beside this one: the twin state, the same two callers.
//
// Zero-build classic script (MV3 CSP), safe to load anywhere: it only builds
// nodes, touches no ids and starts no timers.

/* exported Sk */

const Sk = (() => {
  'use strict';

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  // One grey bar. `w` is what it stands in for — how long that title or chip
  // runs is content, so it is set here and not in the stylesheet.
  const bar = (cls, w) => {
    const b = el('span', `skeleton ${cls}`);
    if (w) b.style.width = w;
    return b;
  };

  // A paragraph of rendered prose (a test's steps, in the panel's test view and
  // on the editor's read-only page). The last line is short, which is what a
  // paragraph looks like from across the room — a block of equal lines reads as
  // a table.
  const PROSE_W = ['96%', '88%', '92%', '64%'];
  function lines(widths = PROSE_W) {
    const box = el('div', 'sk-lines');
    for (const w of widths) box.append(bar('line', w));
    return box;
  }

  return { el, bar, lines };
})();
