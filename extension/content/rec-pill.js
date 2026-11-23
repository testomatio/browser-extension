/* global window */
(() => {
  'use strict';
  // A same-document re-inject runs the file again; without this the second run throws.
  if (window.RecPill) return;
  // The page objects arrive as arguments so the pill can be built without one.
  function create({ document, window, storage, icons, top = true, hostId,
    state, onStop, onPause, onContinue, onExpected }) {
    const HOST_ID = hostId;

    let host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    const HOST_BASE = 'position:fixed;z-index:2147483647;';
    host.style.cssText = `${HOST_BASE}right:16px;bottom:16px;`;
    const shadow = host.attachShadow({ mode: 'open' });
    const CSS_TEXT = `
      :host { all: initial; }
      .box {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-radius: 9999px;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px; color: #fff; background: #0a0a0a;
        box-shadow: 0 6px 20px rgba(0,0,0,0.4); user-select: none;
        /* The pill is a drag handle, and a touch drags it instead of scrolling the page. */
        cursor: grab; touch-action: none;
      }
      .box.dragging { cursor: grabbing; }
      .box.paused { background: #7c2d12; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; flex: none; animation: pulse 1.2s infinite; }
      .box.paused .dot { animation: none; background: #f59e0b; }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .txt { flex: none; white-space: nowrap; }
      /* Says a setting is on, not an error, so it is dimmer and smaller than the counter. */
      .chip {
        flex: none; white-space: nowrap; font-size: 11px; padding: 2px 8px;
        border-radius: 9999px; color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.12);
      }
      button {
        flex: none; font: inherit; font-weight: 600; cursor: pointer;
        padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(255,255,255,0.35);
        background: transparent; color: #fff;
      }
      button:hover { background: rgba(255,255,255,0.15); }
      button.stop { color: #fca5a5; border-color: rgba(252,165,165,0.5); }
      button.exp { color: #bbf7d0; border-color: rgba(187,247,208,0.5); }
      /* A create button carries the panel's add glyph from the icon set, not a typed plus. */
      button:has(svg) { display: inline-flex; align-items: center; gap: 6px; }
      button svg { display: block; flex: none; width: 14px; height: 14px; }
      .exp-input {
        flex: none; width: 220px; max-width: 60vw; font: inherit; color: #fff; cursor: text;
        padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(187,247,208,0.6);
        background: rgba(255,255,255,0.12); outline: none;
      }
      .exp-input::placeholder { color: rgba(255,255,255,0.6); }
    `;
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    const box = document.createElement('div');
    box.className = 'box';
    // The only place the counter and pause are said, so a reader who cannot see the pill hears it change.
    box.setAttribute('aria-live', 'polite');
    shadow.append(style, box);

    const steps = (n) => `${n} step${n === 1 ? '' : 's'}`;

    // `icon` comes from shared/icons.js, injected just before this file; with none the label stands alone.
    function pillButton(label, cls, onClick, icon) {
      const b = document.createElement('button');
      if (cls) b.className = cls;
      const svg = icon && icons ? icons.elIn(document, icon, 14) : null;
      if (svg) b.append(svg);
      b.append(document.createTextNode(label));
      b.addEventListener('click', onClick);
      return b;
    }

    // Rebuilt every 500ms poll, so the dot and label are re-appended, never fresh: the input relies on it.
    const dot = document.createElement('span');
    dot.className = 'dot';
    const txt = document.createElement('span');
    txt.className = 'txt';
    // "Never record entered values" is on: the tester reads it here rather than in the saved steps.
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'Values off';

    // Its own storage.local key (never `settings`), so it survives the re-injection every navigation does.
    const POS_KEY = 'stepRecIndicatorPos';
    const EDGE = 8;          // never flush against the viewport edge
    const DRAG_SLOP = 4;     // below this a press is a press, not a drag
    let pos = null;          // {left, top} viewport px; null = the default corner

    // Every apply re-clamps: the viewport differs from the saved one and + Expected widens the pill 220px.
    function clamp(p) {
      const w = box.offsetWidth || 0;
      const h = box.offsetHeight || 0;
      const maxL = Math.max(EDGE, window.innerWidth - w - EDGE);
      const maxT = Math.max(EDGE, window.innerHeight - h - EDGE);
      return { left: Math.min(Math.max(EDGE, p.left), maxL), top: Math.min(Math.max(EDGE, p.top), maxT) };
    }

    function applyPos() {
      if (!pos) { host.style.cssText = `${HOST_BASE}right:16px;bottom:16px;`; return; }
      pos = clamp(pos);
      host.style.cssText = `${HOST_BASE}left:${pos.left}px;top:${pos.top}px;`;
    }

    let drag = null;  // {dx, dy, id, moved}
    let dropAt = 0;   // when the last drag ended — see the click listener below

    (storage && storage.local ? storage.local.get(POS_KEY) : Promise.reject())
      .then((r) => {
        const p = r[POS_KEY];
        if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') return;
        if (drag || pos) return; // the tester got there first — their hand outranks the read
        pos = p;
        applyPos();
      })
      .catch(() => { /* no stored position — the default corner stands */ });

    function onPointerDown(e) {
      // Never a press aimed at a control: Stop must stay one click, not a click that might have moved.
      if (e.button !== 0 || drag) return;
      dropAt = 0; // a new press: whatever the last drop left is spent
      if (e.target.closest && e.target.closest('button, input')) return;
      const r = box.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId, moved: false };
      try { box.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      e.preventDefault(); // no text selection, no page drag-and-drop
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const next = { left: e.clientX - drag.dx, top: e.clientY - drag.dy };
      if (!drag.moved) {
        const r = box.getBoundingClientRect();
        if (Math.abs(next.left - r.left) + Math.abs(next.top - r.top) < DRAG_SLOP) return;
        drag.moved = true;
        box.classList.add('dragging');
      }
      pos = next;
      applyPos();
    }

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const { moved } = drag;
      drag = null;
      dropAt = moved ? performance.now() : 0;
      box.classList.remove('dragging');
      try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved && pos && storage && storage.local) {
        storage.local.set({ [POS_KEY]: pos }).catch(() => {});
      }
    }

    // On the window, capture phase: pointer capture is best-effort and the pill stops these from bubbling.
    const winOpts = { capture: true };
    box.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, winOpts);
    window.addEventListener('pointerup', endDrag, winOpts);
    window.addEventListener('pointercancel', endDrag, winOpts);
    // The click a drop produces must not press the button under it; short, so it never eats a real click.
    const DROP_CLICK_MS = 100;
    box.addEventListener('click', (e) => {
      if (!dropAt || performance.now() - dropAt > DROP_CLICK_MS) return;
      dropAt = 0;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    // A page listener has no business seeing any of this, same rule as the keystrokes.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));

    const onResize = () => { if (pos) applyPos(); };
    if (top) window.addEventListener('resize', onResize); // a frame's pill is never on screen to re-clamp

    function dragTeardown() {
      window.removeEventListener('pointermove', onPointerMove, winOpts);
      window.removeEventListener('pointerup', endDrag, winOpts);
      window.removeEventListener('pointercancel', endDrag, winOpts);
      window.removeEventListener('resize', onResize);
    }

    // Typed in the shadow root, which no page CSS and (with stopPropagation) no page key reaches.
    let expOpen = false;
    let expInput = null;

    function openExpected() {
      expOpen = true;
      expInput = document.createElement('input');
      expInput.type = 'text';
      expInput.className = 'exp-input';
      expInput.maxLength = 200;
      expInput.placeholder = 'Expected result — Enter to add, Esc to cancel';
      expInput.setAttribute('aria-label', 'Expected result');
      box.replaceChildren(dot, expInput, pillButton('Stop', 'stop', onStop));
      if (pos) applyPos(); // the input widens the pill — keep it inside the viewport
      expInput.focus();
    }

    function closeExpected() { expOpen = false; expInput = null; }

    // A committed entry counts toward the cap exactly like a step.
    function commitExpected() {
      const text = expInput ? String(expInput.value || '').replace(/\s+/g, ' ').trim() : '';
      closeExpected();
      if (text) onExpected(text);
      render();
    }

    // Stopped leaving the shadow root, so a page's "/" hotkey never sees the expectation being typed.
    shadow.addEventListener('keydown', (e) => {
      const open = expOpen; // Enter and Escape close the input; the key that closed it is still ours
      if (open && e.target === expInput) {
        if (e.key === 'Enter') { e.preventDefault(); commitExpected(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeExpected(); render(); }
      }
      if (open) e.stopPropagation();
    });
    ['keyup', 'keypress', 'input', 'change'].forEach((t) => shadow.addEventListener(t, (e) => { if (expOpen) e.stopPropagation(); }));

    // A manual pause (Resume) and the cap's "Still recording?" (Continue) differ: +cap never ends a pause.
    function render() {
      const { recording, paused, manualPause, count, muted } = state();
      txt.textContent = manualPause ? `Paused · ${steps(count)}`
        : paused ? 'Still recording?' : `Recording · ${steps(count)}`;
      // An open input owns the pill: a poll re-render would take the caret and the half-typed text.
      if (expOpen) {
        if (recording && !paused && !manualPause) return;
        closeExpected();
      }
      box.classList.toggle('paused', paused || manualPause);
      box.replaceChildren(dot, txt);
      if (muted) box.append(chip);
      const stop = pillButton('Stop', 'stop', onStop);
      // A finished recording has nothing to pause, continue or expect: Stop is its only button.
      if (!recording) {
        box.append(stop);
      } else if (manualPause) {
        box.append(pillButton('Resume', '', () => onPause(false)), stop);
      } else if (paused) {
        const cont = pillButton('Continue', '', onContinue);
        box.append(cont, stop);
      } else {
        // + Expected only while recording: a paused pill has no step to attach it to, the worker drops it.
        box.append(pillButton('Expected', 'exp', openExpected, 'add'),
          pillButton('Pause', '', () => onPause(true)), stop);
      }
      // Anchored by its left edge, so re-clamp after the width change or it grows off screen.
      if (pos) applyPos();
    }
    return {
      host,
      shadow,
      box,
      render,
      isExpectedOpen: () => expOpen,
      destroy: () => { dragTeardown(); host.remove(); },
    };
  }

  window.RecPill = { create };
})();
