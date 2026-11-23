// One roving tab stop per list: a stop per row would turn a 200-test run into 800 of them.

const Roving = (() => {
  // A WeakMap, so a container that goes away takes its wiring with it.
  const wired = new WeakMap();

  // Neither orientation wraps: the arrows stop at the last row, and the way back is Home.
  const ARROWS = {
    vertical: { prev: 'ArrowUp', next: 'ArrowDown' },
    horizontal: { prev: 'ArrowLeft', next: 'ArrowRight' },
  };

  // Collapsed rows stay in the DOM under a `hidden` container, and disabled items cannot take focus.
  function reachable(container, node) {
    for (let n = node; n && n !== container; n = n.parentElement) if (n.hidden || n.disabled) return false;
    return true;
  }

  // Fresh on every keypress: a filter, a fold or a re-render may have changed the list since.
  const itemsOf = (container, selector) =>
    [...container.querySelectorAll(selector)].filter((n) => reachable(container, n));

  function select(container, selector, item) {
    for (const n of container.querySelectorAll(selector)) {
      n.setAttribute('tabindex', n === item ? '0' : '-1');
    }
    item.focus();
  }

  function onKeydown(container, ev) {
    const opts = wired.get(container);
    const item = ev.target;
    // Only a row itself answers these keys; a search field or button inside keeps what is typed.
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

  // Rows are born tab stops, so the first focus in a fresh list demotes the rest: no re-render call.
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

  /** `role="button"` tells a reader the row is actionable; the first focus gets the tab stop. */
  function item(node) {
    if (!node) return node;
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    return node;
  }

  /** Safe to call from a render: listeners are added once, later calls only refresh the options. */
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
