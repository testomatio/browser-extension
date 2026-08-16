// Tooltips (IIFE global `Tooltip`) — the extension's own replacement for the
// browser's `title` attribute, on every surface that loads shared/components.css.
//
// A native tooltip was the one piece of this product's UI the design system
// could not reach: it opens after about a second and cannot be hurried, it is
// painted in the OS's font and the OS's colours (a white box on a dark panel),
// it will not wrap a sentence to a readable width, it never appears for a
// keyboard user, and on a `<button disabled>` it is the ONLY thing left saying
// why the button is off. Half the gates in this panel are exactly that button.
//
// So the markup carries `data-tip` instead of `title`, and this file draws it:
// the shadcn/ui tooltip, in this system's tokens (see the TOOLTIP section of
// shared/components.css for the box; everything here is behaviour).
//
//   ONE node        a single `.tooltip` in the document, moved and rewritten
//                   per trigger. A panel repaints its rows constantly, so a
//                   tooltip that lived inside its trigger would be rebuilt out
//                   from under the pointer several times a second.
//   HIT-TESTED      the pointer is followed with `elementFromPoint` rather than
//                   with `pointerover` on the trigger, because a DISABLED
//                   control dispatches no pointer events at all — and a gate's
//                   reason ("Finished run", "Configure settings first") is
//                   precisely a tip on a disabled control. Hit-testing sees it;
//                   listening never would.
//   FOLLOWED        while one is open a rAF loop re-reads the trigger's box, so
//                   the label rides a scrolling list and a repaint instead of
//                   floating where the row used to be — and it closes itself the
//                   moment the trigger leaves the DOM or gives up its text.
//   DESCRIBES       `aria-describedby` while it is open (and only if the trigger
//                   has none of its own): a tip is the accessible DESCRIPTION,
//                   never the accessible NAME. Anything whose name was its
//                   `title` carries an `aria-label` now instead — a tip that is
//                   also the name is a control that goes silent on touch.
//
//   SCOPED          `mount(root)` moves the whole thing INTO a shadow root: the
//                   annotator overlay draws its toolbar in one, inside somebody
//                   else's document, and there `document.elementFromPoint`
//                   answers with the shadow HOST — every tip in that toolbar was
//                   invisible to the hit test, which is why it used to fall back
//                   to the browser's `title`. A shadow root hit-tests through
//                   itself, and the layer has to live in the same tree as the
//                   trigger anyway or `aria-describedby` cannot reach it.
//
// `window.Tooltip`, not a top-level `const`: the overlay is injected into a page
// that may already have annotated once, and a second injection of a file that
// declares a global `const` throws before it runs.

window.Tooltip = window.Tooltip || (() => {
  // shadcn's own `TooltipProvider` defaults: `delayDuration` 700ms before the
  // first one opens, `skipDelayDuration` 300ms in which the NEXT one opens at
  // once. 700 is a web page's pace; in a side panel where a whole row of icon
  // buttons is tips and nothing else, it reads as the tooltip being broken.
  // 300 is where the pointer has clearly stopped rather than passed through.
  const OPEN_DELAY = 300;
  const GRACE = 300;      // …and inside this, moving on to the next one is free
  const EDGE = 8;         // how close to the viewport's edge the box may land
  const OFFSET = 8;       // trigger → box: the arrow (~6 across the diagonal) + air
  const ARROW = 8;        // .tooltip-arrow is a square of --space-2
  const ARROW_INSET = 8;  // …and stays this far from the box's own corners

  let scope = null;       // a ShadowRoot the tips live in, when the UI does
  let layer = null;       // the one node, built on first use
  let arrow = null;
  let trigger = null;     // what is described right now
  let described = false;  // …and whether WE are the one holding its aria-describedby
  let openTimer = 0;
  let pendingEl = null;   // waiting out the delay — NOT re-armed by a wobble on it
  let closedAt = 0;       // for the grace window
  let suppressed = null;  // clicked: no tip until the pointer leaves it
  let rafId = 0;
  let moved = false;
  let px = 0;
  let py = 0;
  let shownText = '';
  let lastRect = '';

  const build = () => {
    layer = document.createElement('div');
    layer.className = 'tooltip';
    layer.id = 'app-tooltip';
    layer.setAttribute('role', 'tooltip');
    layer.hidden = true;
    arrow = document.createElement('span');
    arrow.className = 'tooltip-arrow';
    (scope || document.body).append(layer);
    return layer;
  };

  const tipOf = (el) => (el && el.dataset ? (el.dataset.tip || '') : '');

  // The side the trigger ASKS for (`data-tip-side`), then the rest — its
  // opposite first, because a flip is what a tip that does not fit needs, not a
  // rotation. Top by default, the same as shadcn's.
  //
  // Read off the nearest ANCESTOR that names a side, so a row can say it once
  // for everything it holds: a header bar wants every one of its tips below it
  // (over the view, not over Back and the trail), and the fit test alone will
  // not say so — a header that sits a little down the page leaves just enough
  // room above for a two-line label to "fit" straight over the row itself.
  const sideOwner = (el) => el.closest('[data-tip-side]');
  const sidesFor = (owner) => {
    const want = (owner ? owner.dataset.tipSide : 'top').toLowerCase();
    const order = { top: ['top', 'bottom', 'right', 'left'], bottom: ['bottom', 'top', 'right', 'left'],
      left: ['left', 'right', 'top', 'bottom'], right: ['right', 'left', 'top', 'bottom'] };
    return order[want] || order.top;
  };

  // …and what the box has to CLEAR on that side. An ancestor that names a side
  // names it for a reason — "every tip in this header opens below it" — and the
  // trigger's own box is not what "below it" means: a header row is two lines
  // tall around a 32px Back button pinned to its top, so 8px under the BUTTON is
  // still inside the header. The label came out over the trail it was opened
  // from, wearing the row's own fill as its background.
  // So a tip whose side was chosen for it by a block is measured off that block,
  // and the block is left whole. Along the other axis it stays centred on the
  // control (the arrow with it), which is what still ties the label to the thing
  // it describes across the gap.
  // (`r` is the trigger's own box, already measured by the caller — a control
  // that names its own side is its own block and needs no second read.)
  const blockFor = (el, r) => {
    const owner = sideOwner(el);
    return owner && owner !== el ? boxOf(owner) : r;
  };

  const clamp = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));

  // Where a trigger IS, which is not always where it is PAINTED. A `.spinner`
  // turns, and the bounding box of a rotating square breathes between its own
  // 20px and the 28px of its diagonal — four pixels of it above the mark's real
  // top, sixty times a second. The follow loop below read that faithfully, so
  // the label over a RUNNING run bounced up and down for as long as it was open.
  // (A chevron rotated open is the same error standing still: 4px off, once.)
  //
  // A transform turns an element about its own centre, and the centre is the one
  // thing that survives it — the painted box breathes symmetrically around it.
  // So take the CENTRE from the painted box and the SIZE from the layout
  // (`offsetWidth/Height`, which no transform touches) and the box stops moving.
  // Only the element's OWN transform is undone: a scaled ANCESTOR really does
  // paint it smaller, and there the painted box is the truth.
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).transform === 'none') return r;
    const w = el.offsetWidth || r.width;   // undefined on an <svg> — the rect stands
    const h = el.offsetHeight || r.height;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
  };

  // Place the box beside `r` (the trigger's viewport box), on the first side it
  // fits on. The box is already rendered and measured when this runs, which is
  // why the caller un-hides it first: a tooltip that wraps to two lines is a
  // different height, and guessing it is how a label lands half off-screen.
  const place = (r) => {
    const w = layer.offsetWidth;
    const h = layer.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // `b` is the box to clear — the trigger's own, unless a block above it named
    // the side (see blockFor). The fit test asks about THAT box: room "below"
    // starts under the header, not under the button.
    const b = blockFor(trigger, r);
    const fits = {
      top: b.top - OFFSET - h >= EDGE,
      bottom: b.bottom + OFFSET + h <= vh - EDGE,
      left: b.left - OFFSET - w >= EDGE,
      right: b.right + OFFSET + w <= vw - EDGE,
    };
    const order = sidesFor(sideOwner(trigger));
    const side = order.find((s) => fits[s]) || order[0];

    let x;
    let y;
    if (side === 'top' || side === 'bottom') {
      x = r.left + r.width / 2 - w / 2;
      y = side === 'top' ? b.top - OFFSET - h : b.bottom + OFFSET;
    } else {
      x = side === 'left' ? b.left - OFFSET - w : b.right + OFFSET;
      y = r.top + r.height / 2 - h / 2;
    }
    x = clamp(x, EDGE, vw - EDGE - w);
    y = clamp(y, EDGE, vh - EDGE - h);

    layer.dataset.side = side;
    layer.style.left = `${Math.round(x)}px`;
    layer.style.top = `${Math.round(y)}px`;

    // The arrow keeps pointing at the middle of the CONTROL even after the box
    // was pushed off-centre by the viewport's edge — which, in a 380px panel,
    // is most of the time.
    if (side === 'top' || side === 'bottom') {
      const ax = clamp(r.left + r.width / 2 - x - ARROW / 2, ARROW_INSET, w - ARROW - ARROW_INSET);
      arrow.style.left = `${Math.round(ax)}px`;
      arrow.style.top = '';
    } else {
      const ay = clamp(r.top + r.height / 2 - y - ARROW / 2, ARROW_INSET, h - ARROW - ARROW_INSET);
      arrow.style.top = `${Math.round(ay)}px`;
      arrow.style.left = '';
    }
    lastRect = `${r.left},${r.top},${r.width},${r.height}`;
  };

  const hide = () => {
    clearTimeout(openTimer);
    openTimer = 0;
    pendingEl = null;
    if (!trigger) return;
    if (described) trigger.removeAttribute('aria-describedby');
    described = false;
    trigger = null;
    shownText = '';
    lastRect = '';
    if (layer) {
      layer.dataset.open = 'false';
      layer.hidden = true;
    }
    closedAt = Date.now();
  };

  const show = (el) => {
    const text = tipOf(el);
    if (!text) return;
    if (!layer) build();
    hide();
    trigger = el;
    shownText = text;
    layer.replaceChildren(document.createTextNode(text), arrow);
    // A tip on a control inside an open modal <dialog> has to be in the dialog:
    // the top layer paints over everything the rest of the document can reach,
    // z-index included. Scoped to a shadow root, the root is home — outside it
    // neither this stylesheet nor `aria-describedby` reaches the label.
    const host = el.closest('dialog[open]') || scope || document.body;
    if (layer.parentNode !== host) host.append(layer);
    // Rendered but still transparent — measured, placed, and only then opened,
    // so the zoom runs from where the box actually is.
    layer.hidden = false;
    layer.dataset.open = 'false';
    place(boxOf(el));
    requestAnimationFrame(() => { if (trigger === el) layer.dataset.open = 'true'; });
    // The DESCRIPTION, never the name — and never over one the trigger already has.
    if (!el.hasAttribute('aria-describedby')) {
      el.setAttribute('aria-describedby', 'app-tooltip');
      described = true;
    }
    schedule();
  };

  // Open after the delay — or at once, inside the grace window that follows a
  // tooltip closing, which is what makes a row of icon buttons readable by
  // sweeping across it instead of by stopping on each.
  const openLater = (el) => {
    clearTimeout(openTimer);
    const instant = Date.now() - closedAt < GRACE;
    if (instant) { show(el); return; }
    pendingEl = el;
    openTimer = setTimeout(() => {
      openTimer = 0;
      pendingEl = null; // spent, whether or not it opened — a tip set a moment
      if (el.isConnected) show(el); // later must still be able to arrive
    }, OPEN_DELAY);
  };

  // What is under the pointer right now. `elementFromPoint` rather than the
  // event's own target: a disabled control is invisible to event dispatch but
  // not to hit-testing, and its tip is the one that matters most.
  const hitTest = () => {
    // A shadow root hit-tests THROUGH itself; the document would answer with
    // the shadow host and never see the button the pointer is actually on.
    const under = (scope || document).elementFromPoint(px, py);
    const found = under && under.closest ? under.closest('[data-tip]') : null;
    const el = found && tipOf(found) ? found : null;
    if (suppressed && el !== suppressed) suppressed = null;
    if (el && el === suppressed) return;
    if (el === trigger) return;                 // already showing this one
    // …and still WAITING on this one: the delay is "the pointer stopped here",
    // not "the pointer stopped moving", so a slow drift across a button must
    // not restart the clock on every frame.
    if (el && el === pendingEl) return;
    if (!el) { clearTimeout(openTimer); openTimer = 0; hide(); return; }
    hide();
    openLater(el);
  };

  // While one is open: follow its trigger, and drop it the moment the thing it
  // describes stops existing, stops being shown, or stops having a tip. All
  // three happen constantly here — the panel re-renders rows under the pointer.
  const follow = () => {
    if (!trigger) return;
    if (!trigger.isConnected || (trigger.offsetWidth === 0 && trigger.offsetHeight === 0)) { hide(); return; }
    const text = tipOf(trigger);
    if (!text) { hide(); return; }
    const r = boxOf(trigger);
    if (text !== shownText) {
      shownText = text;
      layer.replaceChildren(document.createTextNode(text), arrow);
      place(r);
      return;
    }
    if (`${r.left},${r.top},${r.width},${r.height}` !== lastRect) place(r);
  };

  const tick = () => {
    rafId = 0;
    if (moved) { moved = false; hitTest(); }
    if (trigger) { follow(); schedule(); }
  };
  function schedule() { if (!rafId) rafId = requestAnimationFrame(tick); }

  // ---- wiring ---------------------------------------------------------
  // Pointer position is sampled, not acted on: one hit-test per frame at most,
  // however many moves the browser delivers.
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return; // a touch has no hover to answer
    px = e.clientX; py = e.clientY; moved = true;
    schedule();
  }, { passive: true, capture: true });

  // The pointer left the window entirely — no move event will ever say so. On
  // <html> and NOT on the document: `pointerleave` is dispatched separately to
  // every element being left, so a capture listener up here would fire on every
  // move between two rows and close the tooltip the instant it opened.
  document.documentElement.addEventListener('pointerleave', hide);

  // A click IS the answer to "what does this do", so the label gets out of the
  // way, and stays away until the pointer has been somewhere else.
  document.addEventListener('pointerdown', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    suppressed = el;
    hide();
  }, true);

  // Keyboard: focus shows it at once (there is no "hovering slowly" to wait
  // for), and only for focus that is actually visible — clicking a button must
  // not leave its own label hanging over the row.
  document.addEventListener('focusin', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el || !tipOf(el)) return;
    let visible = true;
    try { visible = el.matches(':focus-visible'); } catch { /* older engine: show it */ }
    if (visible) show(el);
  }, true);
  document.addEventListener('focusout', (e) => { if (trigger && e.target === trigger) hide(); }, true);

  // Escape dismisses the label. It is deliberately NOT swallowed here: the same
  // key clears the search box, closes the project menu and answers a dialog, and
  // a tooltip that happened to be open must not eat the keystroke that was meant
  // for the screen. Closing both at once is the lesser surprise.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);

  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', hide);

  return {
    /** Give an element its tip (or take it away with '' / null). */
    set(el, text, side) {
      if (!el || !el.dataset) return el;
      const value = text == null ? '' : String(text);
      if (value) el.dataset.tip = value;
      else delete el.dataset.tip;
      if (side) el.dataset.tipSide = side;
      // The open one belongs to this element: let the follow loop settle it
      // (it rewrites on a change, closes on an empty) rather than flickering.
      if (trigger === el) schedule();
      return el;
    },
    /** What this element would show. */
    get(el) { return tipOf(el); },

    /** Draw tips inside `root` (a ShadowRoot) instead of in the document: the
     *  annotator overlay's toolbar lives in one, and from the document neither
     *  the hit test nor `aria-describedby` can reach into it. `unmount()` hands
     *  the whole thing back — the injected world outlives the overlay, and a
     *  hit test into a detached root on every pointer move is pure waste. */
    mount(root) {
      if (!root || typeof root.elementFromPoint !== 'function') return;
      hide();
      scope = root;
      if (layer) { layer.remove(); layer = null; arrow = null; }   // rebuilt in the new tree
    },
    unmount() {
      if (!scope) return;
      hide();
      if (layer) { layer.remove(); layer = null; arrow = null; }
      scope = null;
    },

    /** Take over the `title`s inside a subtree that this repo does not write —
     *  the vendored markdown toolbar is the only one. Moving the attribute is
     *  the whole job: leaving it in place would open the OS tooltip beside
     *  ours, and the buttons already carry their own `aria-label`. */
    adopt(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('[title]').forEach((el) => {
        const text = el.getAttribute('title');
        el.removeAttribute('title');
        if (text) el.dataset.tip = text;
      });
    },
    /** Close whatever is open — a screen swap, a modal opening. */
    hide,
  };
})();
