// Step recorder, injected on demand via chrome.scripting.executeScript (NOT a declared
// content_script). background.js owns the state; this reflects it and tears itself down.

/* global chrome, RecMask, RecNaming, RecPacket */
(() => {
  'use strict';

  const HOST_ID = '__testomat_step_recorder';
  // One recorder per document: a full-load re-inject runs in a fresh document (no flag),
  // while a spurious same-document re-inject is a no-op.
  if (window.__testomatStepRecInited) return;
  if (!chrome?.runtime?.sendMessage) return;
  window.__testomatStepRecInited = true;
  // Every frame records; ONE of them draws — otherwise the tester gets a pill per frame.
  const TOP = window.top === window;

  // ---- element naming and context (#74, #23) ---------------------------------
  // Both walks live in content/rec-naming.js; these are the names the rest of the file reads.
  const { trimTo, trim40, textRuns, firstAttr, labelText, nearFacts, nameOf, contextOf,
    clauseOf, roleOf, clickPhrase, ROLE_PHRASE, ROLE_NOUN } = RecNaming;

  // Where the step happened: its own hostname is all a cross-origin frame knows of itself.
  const FRAME_HOST = TOP ? '' : trim40(location.hostname || '');
  // An `about:blank` frame has nothing to name, so it says nothing rather than `in the "" frame`.
  const FRAME_CLAUSE = FRAME_HOST ? ` in the "${FRAME_HOST}" frame` : '';

  // ---- the action packet (#23) -----------------------------------------------
  // Built in content/rec-packet.js; the frame it happened in is this file's fact, so it is
  // handed over rather than reached for.
  // AFTER_MS is the window's length: the packet owns it, the queue below waits it out.
  const { AFTER_MS } = RecPacket;
  const armPacket = (el, action, near, value) => RecPacket.armPacket(el, action, near, value, FRAME_HOST);

  // ---- send one recorded entry; reflect the returned count/paused ------------
  let recording = true;
  let paused = false;      // the step cap's pause (Continue clears it, +cap)
  let manualPause = false; // the tester's own Pause (Resume clears it, no +cap)
  let count = 0;

  // A Stop flush has to know its entry REACHED the worker, not merely that it was handed to
  // sendMessage — the editor reads and clears the state the moment the flush resolves (#62).
  const inflight = new Set();

  // `replaces` (dblclick only) is a wire instruction: the exact single-click text this
  // action supersedes — the worker pops those trailing twins before appending.
  function send(entry) {
    if (!entry || !entry.text) return;
    // Onto BOTH strings: a `replaces` the worker can no longer match leaves the twins behind.
    if (FRAME_CLAUSE) {
      entry.text += FRAME_CLAUSE;
      if (entry.replaces) entry.replaces += FRAME_CLAUSE;
    }
    const p = chrome.runtime.sendMessage({ type: 'STEPREC_ADD', entry })
      .then((r) => {
        if (!r) return;
        if (r.recording === false) { recording = false; render(); return; }
        if (typeof r.count === 'number') count = r.count;
        paused = !!r.paused;
        manualPause = !!r.manualPause;
        render();
      })
      .catch(() => { /* worker asleep / gone — the poll recovers */ });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }

  // ONE queue, in arrival order: an action's packet needs ~400ms of the page's time before
  // it can say what changed, and a manual expected must never overtake the step it follows.
  const outbox = [];
  const drain = () => { while (outbox.length && outbox[0].ready) send(outbox.shift().entry); };
  function queueEntry(entry, close) {
    const item = { entry, ready: !close };
    outbox.push(item);
    if (!close) { drain(); return; }
    item.close = () => {
      if (item.ready) return;
      item.ready = true;
      try { close(entry); } catch { /* a packet is never worth a lost step */ }
      drain();
    };
    setTimeout(item.close, AFTER_MS);
  }
  // The window is about to die (a navigation, a Stop): what is queued leaves with the
  // packet it has rather than with the page.
  const flushOutbox = () => { for (const it of outbox.slice()) if (it.close) it.close(); };

  // One recorded action: the sentence is already written, the packet is built around it.
  function record(el, action, near, entry, value) {
    let close = null;
    try { close = armPacket(el, action, near, value); } catch { /* no packet, still a step */ }
    queueEntry(entry, close);
  }

  // ---- action recognizers ----------------------------------------------------
  const path0 = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  // The indicator is a shadow host INSIDE the page, so its own clicks compose out into
  // `document` and would record as steps.
  const fromIndicator = (e) => {
    const p = (e.composedPath && e.composedPath()) || [];
    return p.includes(host) || (e.target && e.target.id === HOST_ID);
  };
  const isTextField = (el) => {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(button|submit|reset|image|checkbox|radio|file|range|color)$/i.test(el.type || 'text');
  };

  // ---- sensitive values (#176) -----------------------------------------------
  // The rules themselves live in content/rec-mask.js; the field's label is read here because
  // reading it is the naming block's job just above.
  const maskedAs = (el) => RecMask.maskedAs(el, labelText);
  const maskedAllAs = (el) => RecMask.maskedAllAs(el, labelText);
  const looksLikeCard = RecMask.looksLikeCard;

  // ---- "Never record entered values" (#176) ----------------------------------
  const flag = RecMask.watchFlag(chrome.storage);

  // The last value emitted per field, so blur+Enter don't double-record. A masked field
  // remembers a SENTINEL instead — the secret it just refused to send is not ours to hold.
  const lastTyped = new WeakMap();
  const MASKED = '\0masked';
  function flushType(el) {
    if (!isTextField(el)) return;
    // The toggle read lands milliseconds after injection; a step that beats it waits for
    // it rather than being recorded under a guessed default.
    if (flag.get() === null) { flag.read.then(() => flushType(el)); return; }
    const val = el.value == null ? '' : String(el.value);
    if (!val.trim()) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const field = name ? `${name} field` : 'field';
    // Toggle ON: no value, and no heuristic decides anything — see maskedAllAs.
    const noun = flag.get() ? maskedAllAs(el) : maskedAs(el);
    if (noun) {
      if (lastTyped.get(el) === MASKED) return;
      lastTyped.set(el, MASKED);
      record(el, 'type', near, { kind: 'step', action: 'type', name, context: ctx,
        text: `Type ${noun} into the ${field}${clauseOf(ctx)}` }, { text: noun, masked: true });
      return;
    }
    if (lastTyped.get(el) === val) return;
    lastTyped.set(el, val);
    record(el, 'type', near, { kind: 'step', action: 'type', name, context: ctx,
      text: `Type "${trim40(val)}" into the ${field}${clauseOf(ctx)}` }, { text: trim40(val), masked: false });
  }

  // `document.activeElement` stops at a shadow host, so the caret inside a web component is
  // found by descending. The indicator IS such a host (#78) — its Expected input is not a step.
  function deepActive() {
    let el = document.activeElement;
    while (el) {
      if (el === host) return null;
      const inner = el.shadowRoot && el.shadowRoot.activeElement;
      if (!inner) return el;
      el = inner;
    }
    return null;
  }

  // Stop is the one moment a field that never blurred still has to become a step (#62). Reuses
  // the ordinary path, so masking, the dedupe and the cap apply exactly as on a blur.
  async function flushPending() {
    try {
      await flag.read; // flushType drops the step while the never-values toggle is unread
      const el = deepActive();
      if (el) flushType(el);
      flushOutbox();
      await Promise.allSettled([...inflight]);
    } catch { /* a stop is never held up by its flush */ }
  }

  // An IME composes in the field itself, so mid-composition `.value` is the unfinished
  // reading ("けんさく") and only compositionend has the text the tester meant ("検索").
  let composingEl = null; // one caret per document, and every frame runs its own copy

  function onCompositionStart(e) {
    if (!recording || fromIndicator(e)) return;
    composingEl = path0(e);
  }

  // Blink commits the text into `.value` and dispatches this after, so the step reads the
  // finished string; the Enter that follows dedupes against it.
  function onCompositionEnd(e) {
    if (!recording || fromIndicator(e)) return;
    const el = path0(e);
    composingEl = null;
    flushType(el);
  }

  // The indicator's own input is a text field inside the page (#78) — every one of these
  // must ignore it, or typing an expected result records itself as a step.
  function onBlur(e) {
    if (!recording || fromIndicator(e)) return;
    const el = path0(e);
    // A blur mid-composition would record the reading; compositionend does it instead.
    if (el === composingEl) { composingEl = null; return; }
    flushType(el);
  }

  function onKeydown(e) {
    if (!recording || e.key !== 'Enter' || fromIndicator(e)) return;
    // Enter is also the IME's commit key; 229 is what IMEs report that leave isComposing unset.
    if (e.isComposing || e.keyCode === 229) return;
    const el = path0(e);
    if (isTextField(el)) flushType(el);
  }

  // An expiry or date-of-birth dropdown is an entered value too, so it masks like a typed one.
  function flushSelect(el, near) {
    // Same wait as flushType: a guessed toggle is a value recorded against the setting.
    if (flag.get() === null) { flag.read.then(() => flushSelect(el, near)); return; }
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const opt = el.selectedOptions && el.selectedOptions[0];
    const val = opt ? (opt.textContent || opt.value || '').trim() : String(el.value || '');
    // ON: "text" reads wrong for a list. Off: maskedAs sees el.value, a card may be option text.
    const noun = flag.get() ? 'an option' : (maskedAs(el) || (looksLikeCard(val) ? 'the card number' : null));
    if (noun) {
      record(el, 'select', near, { kind: 'step', action: 'select', name, context: ctx,
        text: `Select ${noun} in the ${name ? `${name} ` : ''}dropdown${clauseOf(ctx)}` },
      { text: noun, masked: true });
      return;
    }
    record(el, 'select', near, { kind: 'step', action: 'select', name, context: ctx,
      text: `Select "${trim40(val)}" in the ${name ? `${name} ` : ''}dropdown${clauseOf(ctx)}` },
    { text: trim40(val), masked: false });
  }

  function onChange(e) {
    if (!recording || fromIndicator(e)) return;
    const el = path0(e);
    if (!el || !el.tagName) return;
    const near = nearFacts(el);
    if (el.tagName === 'SELECT') {
      flushSelect(el, near);
      return;
    }
    if (el.tagName === 'INPUT' && /^checkbox$/i.test(el.type || '')) {
      const name = nameOf(el, near);
      const ctx = contextOf(el, name, near);
      record(el, 'check', near, { kind: 'step', action: el.checked ? 'check' : 'uncheck', name, context: ctx,
        text: `${el.checked ? 'Check' : 'Uncheck'} the ${name ? `${name} ` : ''}checkbox${clauseOf(ctx)}` });
      return;
    }
    if (el.tagName === 'INPUT' && /^radio$/i.test(el.type || '')) {
      const name = nameOf(el, near);
      const ctx = contextOf(el, name, near);
      const clause = clauseOf(ctx);
      const entry = { kind: 'step', action: 'choose', name, context: ctx };
      // Nameless AND contextless stays silent: "Choose the option" alone says nothing.
      if (name) record(el, 'check', near, { ...entry, text: `Choose the "${name}" option${clause}` });
      else if (clause) record(el, 'check', near, { ...entry, text: `Choose the option${clause}` });
    }
  }

  // The native targets plus the ARIA custom controls SPA UIs build out of <div>s —
  // without these a whole tab strip or menu records nothing.
  const CLICK_SEL = 'a, button, [role="button"], summary,'
    + ' input[type="button"], input[type="submit"], input[type="reset"], input[type="image"],'
    + ' [role="checkbox"], [role="radio"], [role="switch"], [role="tab"],'
    + ' [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';

  // Shared gate for click + dblclick: the recognized target, or null.
  function clickTarget(e) {
    if (!recording || fromIndicator(e)) return null;
    const raw = path0(e);
    if (!raw || !raw.closest) return null;
    if (isTextField(raw)) return null;
    if (raw.tagName === 'SELECT' || raw.closest('select')) return null;
    if (raw.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(raw.type || '')) return null;
    const el = raw.closest(CLICK_SEL);
    if (!el) return null;
    // A label wrapping a checkbox/radio forwards its click to the control, which the
    // `change` step already covers.
    if (el.tagName === 'LABEL') return null;
    // Same for a role wrapper around a REAL control (a styled native checkbox): the
    // `change`/type path records it, so one action stays one step.
    if (ROLE_PHRASE[roleOf(el)] && el.querySelector('input, select, textarea')) return null;
    return el;
  }

  // Clicks on text inputs / selects are focus noise (the following Type/Select absorbs
  // them); native checkboxes and radios record via `change`.
  function onClick(e) {
    const el = clickTarget(e);
    if (!el) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    record(el, 'click', near, { kind: 'step', action: 'click', name, context: ctx, text: clickPhrase(el, name, ctx) });
  }

  // A real double-click fires click, click, dblclick — the two clicks are already
  // recorded when this lands, and `replaces` pops them in the worker.
  function onDblClick(e) {
    const el = clickTarget(e);
    if (!el) return;
    const noun = ROLE_NOUN[roleOf(el)] || (el.tagName === 'A' ? 'link' : 'button');
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    record(el, 'dblclick', near, { kind: 'step', action: 'dblclick', name, context: ctx,
      text: (name ? `Double-click the "${name}" ${noun}` : `Double-click the ${noun}`) + clauseOf(ctx),
      replaces: clickPhrase(el, name, ctx) });
  }

  // ---- Shadow-DOM indicator --------------------------------------------------
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
      /* The pill is a handle: grab it anywhere that is not a control, and let a
         touch drag it rather than scrolling the page under it. */
      cursor: grab; touch-action: none;
    }
    .box.dragging { cursor: grabbing; }
    .box.paused { background: #7c2d12; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; flex: none; animation: pulse 1.2s infinite; }
    .box.paused .dot { animation: none; background: #f59e0b; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    .txt { flex: none; white-space: nowrap; }
    button {
      flex: none; font: inherit; font-weight: 600; cursor: pointer;
      padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(255,255,255,0.35);
      background: transparent; color: #fff;
    }
    button:hover { background: rgba(255,255,255,0.15); }
    button.stop { color: #fca5a5; border-color: rgba(252,165,165,0.5); }
    button.exp { color: #bbf7d0; border-color: rgba(187,247,208,0.5); }
    /* A pill that MAKES something carries the leading add glyph, the mark the
       panel gives every create control — so the pill's plus is the same plus,
       drawn from the set rather than typed in the label's font. */
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
  shadow.append(style, box);

  const steps = (n) => `${n} step${n === 1 ? '' : 's'}`;

  // `icon` is a Material Symbols name from shared/icons.js, injected right before this
  // file (background.js srInject); with no set present the label stands alone.
  function pillButton(label, cls, onClick, icon) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    const svg = icon && window.Icons ? window.Icons.elIn(document, icon, 14) : null;
    if (svg) b.append(svg);
    b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  // The pill is rebuilt on every 500ms poll, so the dot and the label are re-APPENDED
  // nodes, never fresh ones — the open + Expected input relies on surviving a render.
  const dot = document.createElement('span');
  dot.className = 'dot';
  const txt = document.createElement('span');
  txt.className = 'txt';

  // ---- moving the pill -------------------------------------------------------
  // The dropped position lives in storage.local under its own top-level key (never
  // `settings`), so it survives the re-injection every navigation performs.
  const POS_KEY = 'stepRecIndicatorPos';
  const EDGE = 8;          // never flush against the viewport edge
  const DRAG_SLOP = 4;     // below this a press is a press, not a drag
  let pos = null;          // {left, top} viewport px; null = the default corner

  // The viewport is rarely the one the position was saved from, and the pill itself grows
  // (+ Expected adds 220px), so every apply re-clamps rather than trusting the stored pair.
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

  (chrome.storage && chrome.storage.local ? chrome.storage.local.get(POS_KEY) : Promise.reject())
    .then((r) => {
      const p = r[POS_KEY];
      if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') return;
      if (drag || pos) return; // the tester got there first — their hand outranks the read
      pos = p;
      applyPos();
    })
    .catch(() => { /* no stored position — the default corner stands */ });

  function onPointerDown(e) {
    // Never a press aimed at a control: Stop must stay one click, not a click that
    // might have moved.
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
    if (moved && pos && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {});
    }
  }

  // On the WINDOW and in the CAPTURE phase: pointer capture is best-effort (a synthetic
  // pointer has none), and the pill stops these events from bubbling out of itself.
  const winOpts = { capture: true };
  box.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, winOpts);
  window.addEventListener('pointerup', endDrag, winOpts);
  window.addEventListener('pointercancel', endDrag, winOpts);
  // The click a drop produces must not press the button under it — caught on the way DOWN.
  // The window is short: a drag that produced no click must not eat the next real one.
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
  if (TOP) window.addEventListener('resize', onResize); // a frame's pill is never on screen to re-clamp

  function dragTeardown() {
    window.removeEventListener('pointermove', onPointerMove, winOpts);
    window.removeEventListener('pointerup', endDrag, winOpts);
    window.removeEventListener('pointercancel', endDrag, winOpts);
    window.removeEventListener('resize', onResize);
  }

  // ---- + Expected (#78) ------------------------------------------------------
  // An expectation is what the tester LOOKED at, not a DOM event, so it is typed — in the
  // shadow root, which no page CSS and (with the stopPropagation below) no page key reaches.
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
    box.replaceChildren(dot, expInput, pillButton('Stop', 'stop', requestStop));
    if (pos) applyPos(); // the input widens the pill — keep it inside the viewport
    expInput.focus();
  }

  function closeExpected() { expOpen = false; expInput = null; }

  // A committed entry counts toward the cap exactly like a step.
  function commitExpected() {
    const text = expInput ? String(expInput.value || '').replace(/\s+/g, ' ').trim() : '';
    closeExpected();
    if (text) queueEntry({ kind: 'expected', text, manual: true });
    render();
  }

  // Stopped on the way OUT of the shadow root, so a page's "/" hotkey never sees the tester
  // typing. A page CAPTURE listener still runs first, hence fromIndicator() in ours.
  shadow.addEventListener('keydown', (e) => {
    if (expOpen && e.target === expInput) {
      if (e.key === 'Enter') { e.preventDefault(); commitExpected(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeExpected(); render(); }
    }
    e.stopPropagation();
  });
  ['keyup', 'keypress', 'input', 'change'].forEach((t) => shadow.addEventListener(t, (e) => e.stopPropagation()));

  // Three states, one pill: recording, the tester's own pause (Resume) and the cap's
  // "Still recording?" (Continue) — so Continue's +cap never ends a manual pause.
  function render() {
    txt.textContent = manualPause ? `Paused · ${steps(count)}`
      : paused ? 'Still recording?' : `Recording · ${steps(count)}`;
    // An open input OWNS the pill: a poll re-render would take the caret and the
    // half-typed text with it. A pause or a stop takes it back.
    if (expOpen) {
      if (recording && !paused && !manualPause) return;
      closeExpected();
    }
    box.classList.toggle('paused', paused || manualPause);
    box.replaceChildren(dot, txt);
    const stop = pillButton('Stop', 'stop', requestStop);
    if (manualPause) {
      box.append(pillButton('Resume', '', () => setManualPause(false)), stop);
    } else if (paused) {
      const cont = pillButton('Continue', '', () => {
        chrome.runtime.sendMessage({ type: 'STEPREC_CONTINUE' }).then(() => { paused = false; render(); }).catch(() => {});
      });
      box.append(cont, stop);
    } else {
      // + Expected only while actually recording: a paused pill has no step to attach
      // the expectation to, and the worker would drop it anyway.
      box.append(pillButton('Expected', 'exp', openExpected, 'add'),
        pillButton('Pause', '', () => setManualPause(true)), stop);
    }
    // The pill just changed width, and it is anchored by its LEFT edge — so re-clamp
    // where it stands or the growth pushes it off screen.
    if (pos) applyPos();
  }

  function setManualPause(on) {
    manualPause = on; // optimistic: the pill must not lag the click it just took
    render();
    chrome.runtime.sendMessage({ type: 'STEPREC_PAUSE', on })
      .then((r) => { if (r) { manualPause = !!r.manualPause; render(); } })
      .catch(() => { /* worker asleep — the poll re-syncs */ });
  }

  async function requestStop() {
    const flushed = flushPending(); // clicking the pill never blurs the field the caret is in
    recording = false;
    flushOutbox(); // BEFORE the stop message: the worker still takes entries
    render();      // the pill answers the click now, not when the flush lands
    await flushed; // the editor's follow-up stop clears the state — lose that race and the step is gone
    chrome.runtime.sendMessage({ type: 'STEPREC_STOP_REQUEST' }).catch(() => {});
  }

  // ---- lifecycle -------------------------------------------------------------
  const opts = { capture: true };
  document.addEventListener('click', onClick, opts);
  document.addEventListener('dblclick', onDblClick, opts);
  document.addEventListener('change', onChange, opts);
  document.addEventListener('blur', onBlur, opts);
  document.addEventListener('keydown', onKeydown, opts);
  document.addEventListener('compositionstart', onCompositionStart, opts);
  document.addEventListener('compositionend', onCompositionEnd, opts);
  // The click that navigates is the one a packet window would swallow: both events fire
  // while the document is still alive, and sendMessage from either still reaches the worker.
  window.addEventListener('pagehide', flushOutbox);
  window.addEventListener('beforeunload', flushOutbox);
  // The editor's Stop asks here before it reads the entries; a torn-down recorder has nothing
  // left to write, and answering at once is what keeps that Stop from waiting out its timeout.
  function onFlushMsg(msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'STEPREC_FLUSH_NOW') return undefined;
    if (torn) { sendResponse({ ok: true }); return undefined; }
    flushPending().then(() => sendResponse({ ok: true }));
    return true;
  }
  chrome.runtime.onMessage.addListener(onFlushMsg);

  let torn = false;
  let pollTimer = null;
  function teardown() {
    if (torn) return;
    torn = true;
    flushOutbox();
    clearInterval(pollTimer);
    window.removeEventListener('pagehide', flushOutbox);
    window.removeEventListener('beforeunload', flushOutbox);
    document.removeEventListener('click', onClick, opts);
    document.removeEventListener('dblclick', onDblClick, opts);
    document.removeEventListener('change', onChange, opts);
    document.removeEventListener('blur', onBlur, opts);
    document.removeEventListener('keydown', onKeydown, opts);
    document.removeEventListener('compositionstart', onCompositionStart, opts);
    document.removeEventListener('compositionend', onCompositionEnd, opts);
    chrome.runtime.onMessage.removeListener(onFlushMsg);
    flag.stop();
    dragTeardown();
    host.remove();
    window.__testomatStepRecInited = false;
  }

  // Self-removes once recording ends — editor Stop, indicator Stop and tab close all
  // flip recording=false. A frame has no counter to feed, so it asks four times less often.
  const POLL_MS = TOP ? 500 : 2000;
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'STEPREC_STATUS' })
      .then((s) => {
        if (!s || s.recording === false) { teardown(); return; }
        if (typeof s.count === 'number') count = s.count;
        paused = !!s.paused;
        manualPause = !!s.manualPause;
        render();
      })
      .catch(() => { /* worker asleep — keep the indicator, retry next tick */ });
  }, POLL_MS);

  // The pill is the top frame's: everything above it is detached nodes a frame never reaches.
  if (TOP) (document.body || document.documentElement).append(host);
  render();

  // The page's real title, for the worker's navigation entry — reliable after a
  // re-inject, unlike tab.title.
  const reportTitle = () => chrome.runtime.sendMessage({ type: 'STEPREC_TITLE', title: document.title }).catch(() => {});
  // Top frame only: a payment form's <title> is not where the tester navigated.
  if (TOP) {
    if (document.title) reportTitle();
    else window.addEventListener('DOMContentLoaded', reportTitle, { once: true });
  }
})();
