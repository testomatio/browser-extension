// Step recorder, injected on demand via chrome.scripting.executeScript (NOT a declared
// content_script). background.js owns the state; this reflects it and tears itself down.

/* global chrome, RecMask, RecNaming, RecPacket, RecOutbox, RecPill */
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
  // Built in content/rec-packet.js. The frame is this file's fact, so it is handed over; the
  // window's length is the packet's, so it is read back.
  const { AFTER_MS } = RecPacket;
  const armPacket = (el, action, near, value) => RecPacket.armPacket(el, action, near, value, FRAME_HOST);

  // ---- send one recorded entry; reflect the returned count/paused ------------
  let recording = true;
  let paused = false;      // the step cap's pause (Continue clears it, +cap)
  let manualPause = false; // the tester's own Pause (Resume clears it, no +cap)
  let count = 0;

  // The queue itself is content/rec-outbox.js; the state a reply moves lives here, because
  // the pill and every event guard read it.
  const { queueEntry, flushOutbox, inflight } = RecOutbox.make({
    sendMessage: (msg) => chrome.runtime.sendMessage(msg),
    frameClause: FRAME_CLAUSE,
    afterMs: AFTER_MS,
    onReply: (r) => {
      // A worker that says the recording is over ends it here; nothing else in that reply counts.
      if (r.recording === false) { recording = false; render(); return; }
      if (typeof r.count === 'number') count = r.count;
      paused = !!r.paused;
      manualPause = !!r.manualPause;
      render();
    },
  });

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
    // A composer is a text field the tester types into; it just holds no `.value`.
    if (el.isContentEditable === true) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(button|submit|reset|image|checkbox|radio|file|range|color)$/i.test(el.type || 'text');
  };
  // What the tester entered: a contenteditable holds it as its own text, never in `.value`.
  const valueOf = (el) => (el.isContentEditable === true
    ? (el.innerText == null ? el.textContent : el.innerText) : el.value);

  // ---- sensitive values (#176) -----------------------------------------------
  // The rules themselves live in content/rec-mask.js; the field's label is read here because
  // reading it is the naming block's job just above.
  const maskedAs = (el, val) => RecMask.maskedAs(el, labelText, val);
  const maskedAllAs = (el) => RecMask.maskedAllAs(el, labelText);
  const looksLikeCard = RecMask.looksLikeCard;

  // ---- "Never record entered values" (#176) ----------------------------------
  // The pill says when the flag is on, so a landing or a flip redraws it — and only then, since
  // the pill is built further down and a redraw that changes nothing is one the tester paid for.
  let muted = false;
  let pillReady = false;
  const flag = RecMask.watchFlag(chrome.storage, (on) => {
    if (on === muted) return;
    muted = on;
    if (pillReady) render();
  });

  // The last value emitted per field, so blur+Enter don't double-record. A masked field
  // remembers a FINGERPRINT of it instead, so a second attempt at the same field records too.
  const lastTyped = new WeakMap();
  // FNV-1a, folded unsigned and printed base 36, `\0`-prefixed so it can never collide with a
  // real value: the secret is never stored, logged or sent — only this, beside `el.value` itself.
  const fingerprint = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return `\0m${(h >>> 0).toString(36)}`;
  };
  function flushType(el) {
    if (!isTextField(el)) return;
    // The toggle read lands milliseconds after injection; a step that beats it waits for
    // it rather than being recorded under a guessed default.
    if (flag.get() === null) { flag.read.then(() => flushType(el)); return; }
    const entered = valueOf(el);
    const val = entered == null ? '' : String(entered);
    if (!val.trim()) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const field = name ? `${name} field` : 'field';
    // Toggle ON: no value, and no heuristic decides anything — see maskedAllAs.
    const noun = flag.get() ? maskedAllAs(el) : maskedAs(el, val);
    if (noun) {
      const seen = fingerprint(val);
      if (lastTyped.get(el) === seen) return;
      lastTyped.set(el, seen);
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

  // A slider, a colour and a file picker are entered values nobody types: the control IS the
  // value. No heuristic reads them — a position is not a secret, a filename is not one either.
  const SET_SAY = {
    range: (n, v) => `Set the ${n}slider to "${v}"`,
    color: (n, v) => `Set the ${n}picker to "${v}"`,
    file: (n, v) => `Attach "${v}" to the ${n}field`,
  };
  const SET_MUTE = {
    range: (n) => `Set the ${n}slider`,
    color: (n) => `Set the ${n}picker`,
    file: (n) => `Attach a file to the ${n}field`,
  };
  // `files` is the honest name; a browser reports the value itself as `C:\fakepath\photo.png`.
  const fileName = (el) => {
    const f = el.files && el.files[0];
    return f && f.name ? String(f.name) : String(el.value == null ? '' : el.value).split(/[\\/]/).pop();
  };

  function flushValue(el, near, type) {
    // Same wait as flushType: a guessed toggle is a value recorded against the setting.
    if (flag.get() === null) { flag.read.then(() => flushValue(el, near, type)); return; }
    const val = trim40(type === 'file' ? fileName(el) : (el.value == null ? '' : el.value));
    // A file input the page CLEARS fires `change` with nothing chosen — no file, no step.
    if (!val.trim()) return;
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const quoted = name ? `"${name}" ` : '';
    const entry = { kind: 'step', action: 'type', name, context: ctx };
    if (flag.get()) {
      record(el, 'type', near, { ...entry, text: SET_MUTE[type](quoted) + clauseOf(ctx) },
        { text: type === 'file' ? 'a file' : 'a value', masked: true });
      return;
    }
    record(el, 'type', near, { ...entry, text: SET_SAY[type](quoted, val) + clauseOf(ctx) },
      { text: val, masked: false });
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
    if (el.tagName === 'INPUT' && /^(range|color|file)$/i.test(el.type || '')) {
      flushValue(el, near, String(el.type).toLowerCase());
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
    + ' [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"],'
    + ' [role="link"], [role="combobox"], [role="listbox"], [role="slider"],'
    + ' [role="spinbutton"], [role="treeitem"], [role="gridcell"]';

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

  // ---- the pill --------------------------------------------------------------
  // Drawn by content/rec-pill.js. It reads the state through `state()` and hands every click
  // back here, so the counter it shows and the pause it offers stay this file's to decide.
  const pill = RecPill.create({
    document,
    window,
    storage: chrome.storage,
    icons: window.Icons,
    top: TOP,
    hostId: HOST_ID,
    state: () => ({ recording, paused, manualPause, count, muted }),
    onStop: () => requestStop(),
    onPause: (on) => setManualPause(on),
    onContinue: () => {
      chrome.runtime.sendMessage({ type: 'STEPREC_CONTINUE' })
        .then(() => { paused = false; render(); }).catch(() => {});
    },
    onExpected: (text) => queueEntry({ kind: 'expected', text, manual: true }),
  });
  const host = pill.host;
  const render = () => pill.render();
  pillReady = true; // from here a flag landing or flipping has a pill to redraw


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
    pill.destroy();
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
