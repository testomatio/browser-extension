// The skeleton VOCABULARY (IIFE global `Sk`) — the primitives every loading placeholder is
// built from; the shapes themselves live in shared/components.css (the SKELETON section).

/* exported Sk */

const Sk = (() => {
  'use strict';

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  // `w` is content — how long the title or chip it stands in for runs — so it is set
  // here and not in the stylesheet.
  const bar = (cls, w) => {
    const b = el('span', `skeleton ${cls}`);
    if (w) b.style.width = w;
    return b;
  };

  // A paragraph of rendered prose. The last line is short on purpose: a block of equal
  // lines reads as a table.
  const PROSE_W = ['96%', '88%', '92%', '64%'];
  function lines(widths = PROSE_W) {
    const box = el('div', 'sk-lines');
    for (const w of widths) box.append(bar('line', w));
    return box;
  }

  return { el, bar, lines };
})();
