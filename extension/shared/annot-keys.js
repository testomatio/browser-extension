// The annotator's keyboard map (IIFE global `AnnotKeys`): what a key pressed over
// shared/annotate-core.js means, and nothing else. Nothing here touches a canvas, a document,
// `chrome.*` or the event itself — an event and the editor's state go in, a decision comes out.
// That is the point of the split: the Esc ladder standing between a tester and an un-redacted
// upload is checkable without building a toolbar first.
//
// IT DECIDES, IT DOES NOT ACT. `keyAction` answers `null` when the key is not bound, otherwise
// `{ action, arg, preventDefault, stopPropagation }`; the caller runs those two on the event and
// switches on `action`. Both flags are carried explicitly because they are NOT the same set: every
// bound key prevents the default, but only the three Esc rungs that CONSUME the key stop it
// propagating — the Esc that falls through to Discard lets the host page see it, and that
// asymmetry is behaviour, not an oversight. `action: null` with `preventDefault: true` is a real
// answer: the key is claimed, there is nothing to do with it.
//
// THE Esc LADDER IS LOAD-BEARING — ink menu, then help card, then selection, then exit. Esc is the
// reflex key and the exit it reaches is a discard that asks first, so a rung out of order means an
// Esc meant to close a menu throws away a screenshot instead.
//
// THE ENV BAG. The state lives in the caller's editor, so `keyAction` is handed all of it:
//   inkOpen  — the colour menu is open, and swallows the first Esc;
//   helpOpen — the keyboard card is showing, and swallows the second;
//   selected — the selected op's INDEX, or null. Index 0 is a real selection, hence `!= null`;
//   textOpen — a label input owns the keyboard, so every bare-key binding stands down;
//   weight   — the stroke weight in force: the rung `[` and `]` step away from;
//   palette, tools, weights — the caller's three ladders, read for their length and for `.hex`,
//              `.key`, `.id` and `.w`. Handed in rather than owned here: they also carry the
//              toolbar's labels, icons and tips, which are none of this file's business.
// A caller that forgets the bag gets a TypeError, not a quietly dead shortcut.

const AnnotKeys = (() => {
  'use strict';

  const decide = (action, arg, stop) => ({ action, arg, preventDefault: true, stopPropagation: !!stop });

  // The rung `[` / `]` lands on, clamped so neither end of the ladder has anything beyond it; a
  // weight that is not on the ladder counts as the middle rung.
  function stepWeight(weights, weight, dir) {
    const i = weights.findIndex((s) => s.w === weight);
    return weights[Math.max(0, Math.min(weights.length - 1, (i < 0 ? 1 : i) + dir))];
  }

  function keyAction(e, { inkOpen, helpOpen, selected, textOpen, weight, palette, tools, weights }) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (inkOpen) return decide('closeInk', true, true);
      if (helpOpen) return decide('help', false, true);
      if (selected != null) return decide('deselect', undefined, true);
      // The reflex key must never attach an un-redacted shot, so it discards (asking first).
      return decide('discard');
    }
    if (mod && (e.key === 'Enter' || e.key === 'NumpadEnter')) return decide('apply');
    if (mod && (e.key === 'z' || e.key === 'Z')) return decide(e.shiftKey ? 'redo' : 'undo');
    if (mod && (e.key === 'y' || e.key === 'Y')) return decide('redo');
    if (mod || e.altKey) return null;   // every binding below is a bare key
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null && !textOpen) return decide('delete');
    if (textOpen) return null;
    if (e.key === '?') return decide('help');
    if (e.key === '[' || e.key === ']') {
      const next = stepWeight(weights, weight, e.key === '[' ? -1 : 1);
      // Claimed either way: a ladder with no rung to move to still eats the keystroke.
      return next ? decide('weight', next.w) : decide(null);
    }
    const digit = Number(e.key);
    if (digit >= 1 && digit <= palette.length) return decide('color', palette[digit - 1].hex);
    const spec = tools.find((t) => t.key === e.key.toLowerCase());
    return spec ? decide('tool', spec.id) : null;
  }

  return { keyAction, stepWeight };
})();
