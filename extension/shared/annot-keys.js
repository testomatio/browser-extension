// The Esc order (ink menu, help, selection, discard) matters: out of order, Esc throws a shot away.

const AnnotKeys = (() => {
  'use strict';

  const decide = (action, arg, stop) => ({ action, arg, preventDefault: true, stopPropagation: !!stop });

  // Clamped at both ends; a weight that is not on the ladder counts as the middle rung.
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
