// Hover cards (IIFE global `HoverCard`) — the tooltip's richer sibling, on every
// surface that loads shared/components.css.
//
// A `.tooltip` is one string. The moment the thing the pointer asks about is a
// LIST — "which errors has the recorder caught?" — the label stops being a
// label: it wants rows with their own marks, a count, and a way INTO the section
// that holds the full set. A tooltip can carry none of those, and by design it
// never will: it is `pointer-events: none` precisely so it can never sit between
// the pointer and the control it describes.
//
// So this is shadcn/ui's `hover-card` in this system's tokens (see the HOVERCARD
// section of shared/components.css for the box; everything here is behaviour),
// and the three things that make it a different component rather than a bigger
// tooltip:
//
//   ENTERABLE     the card is a hit target. The pointer may travel from the
//                 trigger INTO it and click what is inside, which is why closing
//                 is on a grace timer rather than on `pointerleave`: the 8px gap
//                 between trigger and card is not "the pointer left".
//   RENDERED      content comes from a `render()` callback per open — a node or a
//                 fragment — and `update()` re-runs it in place: the recorder's
//                 card is polled while it is up, so a new error appears in a card
//                 the pointer is resting in. `render()` returning null is the
//                 answer "nothing to show": the card stays shut and the trigger's
//                 own tooltip is left alone.
//   ONE AT A TIME opening one closes any other, and only ever ONE per trigger:
//                 the card belongs to a control, unlike the tooltip's single
//                 roaming node, because its content outlives a repaint of the
//                 row underneath it.
//
// While a card is open the trigger's `data-tip` is taken away and given back on
// close — the two describe the same control and would otherwise open on top of
// each other, and the card is the one that was asked for.
//
// Not for anything a keyboard cannot reach another way: the card opens on focus
// and describes its trigger while it is up (`aria-describedby`), but everything
// in it is a SUMMARY of something already on the screen — a hover card is never
// the only home of a control or a fact.

const HoverCard = (() => {
  // shadcn's `HoverCard` defaults are 700ms in / 300ms out. 700 is a web page's
  // pace; in a side panel where the trigger is a 24px chip in the header it
  // reads as nothing happening. 200 is past a pointer that is on its way
  // somewhere else, and the close grace is deliberately the longer of the two —
  // it is the gap the pointer crosses to reach the card.
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
      // Entering the card cancels the close the pointer's own exit scheduled —
      // otherwise the card closes under the link it was opened to reach.
      box.addEventListener('pointerenter', () => { inside = true; clearTimeout(closeTimer); closeTimer = 0; });
      // A press counts as being inside even when no `pointerenter` ever fired —
      // a card that opened UNDER a pointer that then never moved gets none.
      box.addEventListener('pointerdown', () => { inside = true; });
      box.addEventListener('pointerleave', () => { inside = false; scheduleClose(); });
      return box;
    };

    // Where the trigger IS. The same reason the tooltip measures it this way: the
    // Rec chip's dot pulses, and a transformed box breathes around its own centre.
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).transform === 'none') return r;
      const w = el.offsetWidth || r.width;
      const h = el.offsetHeight || r.height;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
    };

    // Place the card beside the trigger, on the asked-for side if it fits and on
    // its opposite if it does not — a flip, not a rotation. Measured after the
    // content is in the DOM: a card is a different height per open.
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

    // While it is up: follow the trigger (the chip moves between header rows when
    // the panel goes immersive, and the header itself scrolls), and drop the card
    // the moment the trigger stops existing or stops being shown.
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

    // The card and the tip describe the same control: while the card is up the
    // tip stands down, and gets its text back untouched on close.
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

    // Content in, box measured. Returns false for `render()` saying "nothing to
    // show" — the caller decides whether that means "stay shut" or "close now".
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
      // A card opened from inside a modal <dialog> has to live in the dialog: the
      // top layer paints over everything the rest of the document can reach.
      const host = trigger.closest('dialog[open]') || document.body;
      if (node.parentNode !== host) host.append(node);
      muteTip();
      // Rendered, measured, placed — and only then opened, so the zoom runs from
      // where the box actually is.
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
      // Escape and the link's own click both close a card the pointer is INSIDE,
      // and the card leaves without a `pointerleave` — a flag left standing here
      // would freeze the NEXT card for good.
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
    // A click is an ACTION on the trigger (the Rec chip stops recording), and its
    // card must not hang over the answer. Away until the pointer has left.
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
      /** Re-run `render()` in place — for a card whose content is polled. NOT a
       *  re-open: the fade and the zoom belong to the card ARRIVING, and a poll
       *  that replayed them would make the card flicker every couple of seconds
       *  under the pointer that is reading it. Only the content and the box move;
       *  a render that now has nothing to show closes the card instead.
       *
       *  A card the pointer has ENTERED does not update at all, and that is
       *  load-bearing rather than polite: `paint()` replaces the card's children,
       *  so a tick landing between a mouse-down and the mouse-up destroys the very
       *  node being pressed and the browser dispatches no `click` — the link in the
       *  foot simply did nothing, about as often as the poll's period. (The reading
       *  argument holds too: rows must not shuffle under a pointer that is aiming
       *  at one.) The pointer is on its way out of the card anyway — leaving it
       *  closes the card — so nothing goes stale that survives. */
      update() {
        if (!isOpen() || inside || (node && node.contains(document.activeElement))) return;
        if (!paint()) { close(); return; }
        place(boxOf(trigger)); // its height changed with its content
      },
      /** Open it now, delay skipped (a card the screen decided to show). */
      show() { open(); },
      close,
      isOpen,
      /** The card's element while it is up, for a test or a caller that measures. */
      element() { return isOpen() ? node : null; },
      detach() { close(); registry.delete(trigger); },
    };
    registry.set(trigger, controller);
    return controller;
  }

  // Escape dismisses whatever is up — NOT swallowed, exactly as the tooltip's is
  // not: the same key clears a search box and answers a dialog, and a card that
  // happened to be open must not eat the keystroke meant for the screen.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openOne) openOne.close(); }, true);
  window.addEventListener('blur', () => { if (openOne) openOne.close(); });
  document.addEventListener('visibilitychange', () => { if (openOne) openOne.close(); });

  return {
    attach,
    /** The controller for a trigger, from anywhere (the `Dropdown.of` convention). */
    of(trigger) { return registry.get(trigger) || null; },
    /** Close whatever is up — a screen swap, a modal opening. */
    hide() { if (openOne) openOne.close(); },
  };
})();
