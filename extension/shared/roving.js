// Keyboard navigation for a list of rows (IIFE global `Roving`). One roving tab stop, not one per
// row: a run's test rows already carry three status buttons each, so a tab stop per row would turn a
// 200-test run into 800 of them. Tab enters the list once, the arrows walk it, Enter and Space open
// the focused row. Pure DOM in, DOM out — no panel state, so `node --test` covers it
// (tests/roving.test.mjs).
//
// The listeners live on the CONTAINER, never on the rows. Every list here is a stable <ul> whose
// children are replaced wholesale by replaceChildren(), so delegation is what makes a re-render
// free: nothing to re-attach, and no render path that can forget to.

const Roving = (() => {
  // container -> { selector, orientation }. A WeakMap so a container that goes away takes its
  // wiring with it, and so a second attach() can update the options without a second listener.
  const wired = new WeakMap();

  // Vertical for lists, horizontal for a tab bar. Home/End are the ends in both, and neither
  // wraps: the arrows stop at the last row, and the way back to the top is Home.
  const ARROWS = {
    vertical: { prev: 'ArrowUp', next: 'ArrowDown' },
    horizontal: { prev: 'ArrowLeft', next: 'ArrowRight' },
  };

  // A collapsed group's rows are still in the DOM — the runs list and the suite tree both put
  // `hidden` on the container that holds them — so the walk stops at the list itself.
  // A disabled item is out for the same reason: it cannot take focus, so the caret would stick.
  function reachable(container, node) {
    for (let n = node; n && n !== container; n = n.parentElement) if (n.hidden || n.disabled) return false;
    return true;
  }

  // Fresh on every keypress: a filter, a fold or a re-render may have changed the list since.
  const itemsOf = (container, selector) =>
    [...container.querySelectorAll(selector)].filter((n) => reachable(container, n));

  // The one act that moves the tab stop: exactly one item at 0, the rest at -1, focus on it.
  function select(container, selector, item) {
    for (const n of container.querySelectorAll(selector)) {
      n.setAttribute('tabindex', n === item ? '0' : '-1');
    }
    item.focus();
  }

  function onKeydown(container, ev) {
    const opts = wired.get(container);
    const item = ev.target;
    // Only a row itself answers these keys — a search field or a row's own button inside the
    // list keeps everything it is typed.
    if (!opts || !item || typeof item.matches !== 'function' || !item.matches(opts.selector)) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault(); // Space would scroll the panel under the row it just opened
      item.click();        // whatever the row's own click listener does, and only that
      return;
    }
    const arrows = ARROWS[opts.orientation] || ARROWS.vertical;
    const items = itemsOf(container, opts.selector);
    const at = items.indexOf(item);
    if (at < 0) return;
    let to = at;
    if (ev.key === arrows.next) to = Math.min(at + 1, items.length - 1);
    else if (ev.key === arrows.prev) to = Math.max(at - 1, 0);
    else if (ev.key === 'Home') to = 0;
    else if (ev.key === 'End') to = items.length - 1;
    else return;
    ev.preventDefault();
    select(container, opts.selector, items[to]);
  }

  // Every row is born a tab stop (see item()), so the first focus to land in a freshly rendered
  // list is what demotes the rest — which is how a re-render needs no call of its own.
  function onFocusin(container, ev) {
    const opts = wired.get(container);
    if (!opts || !ev.target || typeof ev.target.closest !== 'function') return;
    const item = ev.target.closest(opts.selector);
    if (!item || !container.contains(item)) return;
    for (const n of container.querySelectorAll(opts.selector)) {
      if (n !== item) n.setAttribute('tabindex', '-1');
    }
    item.setAttribute('tabindex', '0');
  }

  /**
   * Mark a row the arrows may land on. `role="button"` is what tells a reader the row is
   * actionable; the tab stop is handed to the first focus the list gets, not to a render.
   */
  function item(node) {
    if (!node) return node;
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    return node;
  }

  /**
   * Wire `container` for `selector`'s rows. Safe to call from a render — the listeners are added
   * once per container and later calls only refresh the options.
   */
  function attach(container, { selector, orientation = 'vertical' } = {}) {
    if (!container || !selector) return container;
    const first = !wired.has(container);
    wired.set(container, { selector, orientation });
    if (first) {
      container.addEventListener('keydown', (ev) => onKeydown(container, ev));
      container.addEventListener('focusin', (ev) => onFocusin(container, ev));
    }
    return container;
  }

  return { attach, item };
})();
