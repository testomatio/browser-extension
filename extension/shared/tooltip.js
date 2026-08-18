// Tooltips (IIFE global `Tooltip`): markup carries `data-tip`, this file draws the box.
// `window.Tooltip`, not a top-level `const` — a re-injection of a const-declaring file throws.

window.Tooltip = window.Tooltip || (() => {
  // 300, not shadcn's 700: in a panel that is a row of icon buttons, 700 reads as broken.
  const OPEN_DELAY = 300;
  const GRACE = 300;      // …and inside this, the next one opens at once
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

  // The fallback order flips to the OPPOSITE side first, never a rotation. The side is
  // read off the nearest ANCESTOR naming one, so a header can say it once for its row.
  const sideOwner = (el) => el.closest('[data-tip-side]');
  const sidesFor = (owner) => {
    const want = (owner ? owner.dataset.tipSide : 'top').toLowerCase();
    const order = { top: ['top', 'bottom', 'right', 'left'], bottom: ['bottom', 'top', 'right', 'left'],
      left: ['left', 'right', 'top', 'bottom'], right: ['right', 'left', 'top', 'bottom'] };
    return order[want] || order.top;
  };

  // What the box must CLEAR: a tip whose side a BLOCK chose is measured off that block,
  // so "below the header" is not 8px under a button that still sits inside it.
  const blockFor = (el, r) => {
    const owner = sideOwner(el);
    return owner && owner !== el ? boxOf(owner) : r;
  };

  const clamp = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));

  // A rotating element's client rect breathes (a spinner made the label bounce), so the centre
  // comes off the painted box and the size off offsetWidth/Height. Only its OWN transform is undone.
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).transform === 'none') return r;
    const w = el.offsetWidth || r.width;   // undefined on an <svg> — the rect stands
    const h = el.offsetHeight || r.height;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
  };

  // First side it fits on. The caller un-hides the box FIRST: a tip that wraps to two
  // lines is a different height, and guessing it lands the label half off-screen.
  const place = (r) => {
    const w = layer.offsetWidth;
    const h = layer.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
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

    // The arrow keeps pointing at the CONTROL's middle after the edge clamp shifts the box.
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
    // Inside an open modal <dialog> the tip must live IN the dialog: the top layer paints
    // over everything else, z-index included. Under a shadow root, that root is home.
    const host = el.closest('dialog[open]') || scope || document.body;
    if (layer.parentNode !== host) host.append(layer);
    // Rendered but transparent: measured and placed before it opens, so the zoom starts right.
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

  // At once inside the grace window, so a row of icon buttons reads by sweeping across it.
  const openLater = (el) => {
    clearTimeout(openTimer);
    const instant = Date.now() - closedAt < GRACE;
    if (instant) { show(el); return; }
    pendingEl = el;
    openTimer = setTimeout(() => {
      openTimer = 0;
      pendingEl = null; // spent whether or not it opened
      if (el.isConnected) show(el);
    }, OPEN_DELAY);
  };

  // `elementFromPoint`, not the event target: a disabled control dispatches no pointer
  // events at all, and a gate's reason is precisely a tip on a disabled control.
  const hitTest = () => {
    // A shadow root hit-tests THROUGH itself; the document would answer with
    // the shadow host and never see the button the pointer is actually on.
    const under = (scope || document).elementFromPoint(px, py);
    const found = under && under.closest ? under.closest('[data-tip]') : null;
    const el = found && tipOf(found) ? found : null;
    if (suppressed && el !== suppressed) suppressed = null;
    if (el && el === suppressed) return;
    if (el === trigger) return;                 // already showing this one
    // The delay means "the pointer stopped HERE", so a drift across a button must not
    // restart the clock on every frame.
    if (el && el === pendingEl) return;
    if (!el) { clearTimeout(openTimer); openTimer = 0; hide(); return; }
    hide();
    openLater(el);
  };

  // Drop it the moment the trigger leaves the DOM, stops being shown, or loses its tip —
  // all three happen constantly, the panel re-renders rows under the pointer.
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
  // The pointer is sampled, not acted on: one hit-test per frame at most.
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return; // a touch has no hover to answer
    px = e.clientX; py = e.clientY; moved = true;
    schedule();
  }, { passive: true, capture: true });

  // On <html> and NOT captured on the document: `pointerleave` is dispatched per element
  // left, so a capture listener up here would close the tip on every move between rows.
  document.documentElement.addEventListener('pointerleave', hide);

  // A click answers the question, so the label stays away until the pointer leaves.
  document.addEventListener('pointerdown', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    suppressed = el;
    hide();
  }, true);

  // Focus opens it at once, but only :focus-visible — a click must not leave its own
  // label hanging over the row.
  document.addEventListener('focusin', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el || !tipOf(el)) return;
    let visible = true;
    try { visible = el.matches(':focus-visible'); } catch { /* older engine: show it */ }
    if (visible) show(el);
  }, true);
  document.addEventListener('focusout', (e) => { if (trigger && e.target === trigger) hide(); }, true);

  // Escape closes the label but is deliberately NOT swallowed — the same key clears the
  // search box and answers dialogs.
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
      // Let the follow loop settle the open one rather than flickering it closed.
      if (trigger === el) schedule();
      return el;
    },
    get(el) { return tipOf(el); },

    /** Draw tips inside a ShadowRoot: from the document neither the hit test nor
     *  `aria-describedby` reaches into one. `unmount()` hands it back. */
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

    /** Take over `title`s in vendored markup (the markdown toolbar). MOVING the
     *  attribute is the point — leaving it opens the OS tooltip beside ours. */
    adopt(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('[title]').forEach((el) => {
        const text = el.getAttribute('title');
        el.removeAttribute('title');
        if (text) el.dataset.tip = text;
      });
    },
    hide,
  };
})();
