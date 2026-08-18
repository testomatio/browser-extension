// Hover cards (IIFE global `HoverCard`) — the tooltip's richer sibling: a card the
// pointer can ENTER, so closing runs on a grace timer, never on `pointerleave`.

const HoverCard = (() => {
  // Not shadcn's 700/300: 700 reads as nothing happening in a panel. The close grace is
  // deliberately the longer — it is the gap the pointer crosses to reach the card.
  const OPEN_DELAY = 200;
  const CLOSE_DELAY = 240;
  const EDGE = 8;    // how close to the viewport's edge the box may land
  const OFFSET = 8;  // trigger → card

  let seq = 0;
  const registry = new Map(); // trigger element → controller
  let openOne = null;         // the one card that is up

  const clamp = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));

  function attach(trigger, options = {}) {
    if (!trigger) return null;
    const existing = registry.get(trigger);
    if (existing) return existing;

    const {
      render = () => null,
      side = 'bottom',
      className = '',
      openDelay = OPEN_DELAY,
      closeDelay = CLOSE_DELAY,
    } = options;

    const id = `hovercard-${++seq}`;
    let node = null;
    let openTimer = 0;
    let closeTimer = 0;
    let rafId = 0;
    let lastRect = '';
    let stashedTip = null;   // the trigger's `data-tip` while we hold the pointer
    let described = false;   // …and whether WE are the one holding aria-describedby
    let suppressed = false;  // clicked: no card until the pointer leaves the trigger
    let inside = false;      // the pointer is IN the card — see update()

    const build = () => {
      const box = document.createElement('div');
      box.className = `hovercard${className ? ` ${className}` : ''}`;
      box.id = id;
      box.hidden = true;
      // Entering cancels the close the exit scheduled, else the card shuts under the link.
      box.addEventListener('pointerenter', () => { inside = true; clearTimeout(closeTimer); closeTimer = 0; });
      // A card that opened UNDER a still pointer gets no `pointerenter`, so a press counts.
      box.addEventListener('pointerdown', () => { inside = true; });
      box.addEventListener('pointerleave', () => { inside = false; scheduleClose(); });
      return box;
    };

    // As the tooltip measures it: a transformed box (the Rec chip pulses) breathes about its centre.
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).transform === 'none') return r;
      const w = el.offsetWidth || r.width;
      const h = el.offsetHeight || r.height;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
    };

    // A flip to the opposite side, never a rotation. Measured after the content is in
    // the DOM — a card is a different height per open.
    const place = (r) => {
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const fits = {
        top: r.top - OFFSET - h >= EDGE,
        bottom: r.bottom + OFFSET + h <= vh - EDGE,
        left: r.left - OFFSET - w >= EDGE,
        right: r.right + OFFSET + w <= vw - EDGE,
      };
      const flip = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
      const chosen = fits[side] ? side : (fits[flip[side]] ? flip[side] : side);
      let x;
      let y;
      if (chosen === 'top' || chosen === 'bottom') {
        x = r.left + r.width / 2 - w / 2;
        y = chosen === 'top' ? r.top - OFFSET - h : r.bottom + OFFSET;
      } else {
        x = chosen === 'left' ? r.left - OFFSET - w : r.right + OFFSET;
        y = r.top + r.height / 2 - h / 2;
      }
      node.dataset.side = chosen;
      node.style.left = `${Math.round(clamp(x, EDGE, vw - EDGE - w))}px`;
      node.style.top = `${Math.round(clamp(y, EDGE, vh - EDGE - h))}px`;
      lastRect = `${r.left},${r.top},${r.width},${r.height}`;
    };

    // Follow the trigger while it is up, and drop the card once it is gone or hidden.
    const follow = () => {
      rafId = 0;
      if (!isOpen()) return;
      if (!trigger.isConnected || (trigger.offsetWidth === 0 && trigger.offsetHeight === 0)) { close(); return; }
      const r = boxOf(trigger);
      if (`${r.left},${r.top},${r.width},${r.height}` !== lastRect) place(r);
      schedule();
    };
    const schedule = () => { if (!rafId) rafId = requestAnimationFrame(follow); };

    const isOpen = () => !!node && !node.hidden;

    // Card and tip describe the same control, so the tip stands down while the card is up.
    const muteTip = () => {
      if (stashedTip !== null) return;
      stashedTip = trigger.dataset.tip || '';
      if (stashedTip) delete trigger.dataset.tip;
      if (typeof Tooltip !== 'undefined') Tooltip.hide();
    };
    const unmuteTip = () => {
      if (stashedTip) trigger.dataset.tip = stashedTip;
      stashedTip = null;
    };

    // false when `render()` has nothing to show — the caller decides stay-shut vs close.
    const paint = () => {
      const content = render();
      if (!content) return false;
      if (!node) node = build();
      node.replaceChildren(content);
      return true;
    };

    function open() {
      clearTimeout(openTimer); openTimer = 0;
      clearTimeout(closeTimer); closeTimer = 0;
      if (!paint()) { close(); return; }         // nothing to say — leave the tip to it
      if (openOne && openOne !== controller) openOne.close();
      // Inside a modal <dialog> the card must live IN it — the top layer paints over all else.
      const host = trigger.closest('dialog[open]') || document.body;
      if (node.parentNode !== host) host.append(node);
      muteTip();
      // Rendered, measured, placed — and only then opened, so the zoom starts right.
      node.hidden = false;
      node.dataset.open = 'false';
      place(boxOf(trigger));
      requestAnimationFrame(() => { if (isOpen()) node.dataset.open = 'true'; });
      if (!trigger.hasAttribute('aria-describedby')) {
        trigger.setAttribute('aria-describedby', id);
        described = true;
      }
      openOne = controller;
      schedule();
    }

    function close() {
      clearTimeout(openTimer); openTimer = 0;
      clearTimeout(closeTimer); closeTimer = 0;
      // A card closed from inside (Escape, a click) never gets `pointerleave`, and a
      // stale `inside` would freeze the NEXT card for good.
      inside = false;
      if (described) trigger.removeAttribute('aria-describedby');
      described = false;
      unmuteTip();
      if (node) {
        node.dataset.open = 'false';
        node.hidden = true;
        node.remove();
      }
      lastRect = '';
      if (openOne === controller) openOne = null;
    }

    const scheduleOpen = () => {
      if (suppressed || isOpen() || openTimer) return;
      openTimer = setTimeout(() => { openTimer = 0; if (trigger.isConnected) open(); }, openDelay);
    };
    const scheduleClose = () => {
      clearTimeout(openTimer); openTimer = 0;
      if (closeTimer) return;
      closeTimer = setTimeout(() => { closeTimer = 0; close(); }, closeDelay);
    };

    trigger.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return; // a touch has no hover to answer
      scheduleOpen();
    });
    trigger.addEventListener('pointerleave', () => { suppressed = false; scheduleClose(); });
    // A click is an ACTION on the trigger; the card stays away until the pointer leaves.
    trigger.addEventListener('pointerdown', () => { suppressed = true; close(); });
    // Keyboard: no "hovering slowly" to wait out, and only for focus that shows.
    trigger.addEventListener('focus', () => {
      let visible = true;
      try { visible = trigger.matches(':focus-visible'); } catch { /* older engine: show it */ }
      if (visible) open();
    });
    trigger.addEventListener('blur', () => {
      // Focus moving INTO the card keeps it up; anywhere else closes it.
      if (node && node.contains(document.activeElement)) return;
      close();
    });

    const controller = {
      /** Re-run `render()` in place, never a re-open. Skipped while the pointer is
       *  INSIDE: replacing children between mousedown and mouseup fires no `click`. */
      update() {
        if (!isOpen() || inside || (node && node.contains(document.activeElement))) return;
        if (!paint()) { close(); return; }
        place(boxOf(trigger)); // its height changed with its content
      },
      /** Open it now, delay skipped (a card the screen decided to show). */
      show() { open(); },
      close,
      isOpen,
      element() { return isOpen() ? node : null; },
      detach() { close(); registry.delete(trigger); },
    };
    registry.set(trigger, controller);
    return controller;
  }

  // Escape closes it but is NOT swallowed — the same key clears a search box and answers dialogs.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openOne) openOne.close(); }, true);
  window.addEventListener('blur', () => { if (openOne) openOne.close(); });
  document.addEventListener('visibilitychange', () => { if (openOne) openOne.close(); });

  return {
    attach,
    /** The controller for a trigger, from anywhere (the `Dropdown.of` convention). */
    of(trigger) { return registry.get(trigger) || null; },
    hide() { if (openOne) openOne.close(); },
  };
})();
