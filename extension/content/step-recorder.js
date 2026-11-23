/* global chrome, RecMask, RecNaming, RecPacket, RecOutbox, RecPill */
(() => {
  'use strict';

  const HOST_ID = '__testomat_step_recorder';
  // A full-load re-inject runs in a fresh document (no flag); a same-document re-inject is a no-op.
  if (window.__testomatStepRecInited) return;
  if (!chrome?.runtime?.sendMessage) return;
  window.__testomatStepRecInited = true;
  // Every frame records; one of them draws, or the tester gets a pill per frame.
  const TOP = window.top === window;

  const { trimTo, trim40, trimMark, textRuns, firstAttr, labelText, nearFacts, nameOf, contextOf,
    clauseOf, roleOf, clickPhrase, ROLE_PHRASE, ROLE_NOUN } = RecNaming;

  // Where the step happened: its own hostname is all a cross-origin frame knows of itself.
  const FRAME_HOST = TOP ? '' : trim40(location.hostname || '');
  // An `about:blank` frame has nothing to name, so it says nothing rather than `in the "" frame`.
  const FRAME_CLAUSE = FRAME_HOST ? ` in the "${FRAME_HOST}" frame` : '';

  const { AFTER_MS } = RecPacket;
  const armPacket = (el, action, near, value) => RecPacket.armPacket(el, action, near, value, FRAME_HOST);

  let recording = true;
  let paused = false;      // the step cap's pause (Continue clears it, +cap)
  let manualPause = false; // the tester's own Pause (Resume clears it, no +cap)
  let count = 0;

  // The state a reply moves lives here: the pill and every event guard read it.
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

  function record(el, action, near, entry, value) {
    let close = null;
    try { close = armPacket(el, action, near, value); } catch { /* no packet, still a step */ }
    queueEntry(entry, close);
  }

  const path0 = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  // The indicator is a shadow host inside the page, so its clicks compose out to `document`.
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

  const maskedAs = (el, val) => RecMask.maskedAs(el, labelText, val);
  const maskedAllAs = (el) => RecMask.maskedAllAs(el, labelText);
  const looksLikeCard = RecMask.looksLikeCard;

  // The pill shows the flag, so only a landing or a flip redraws it: a no-op redraw costs the tester.
  let muted = false;
  let pillReady = false;
  const flag = RecMask.watchFlag(chrome.storage, (on) => {
    if (on === muted) return;
    muted = on;
    if (pillReady) render();
  });

  // Last value per field, so blur+Enter don't double-record; a masked field keeps a fingerprint instead.
  const lastTyped = new WeakMap();
  // FNV-1a, `\0`-prefixed so it never collides with a real value: the secret itself is never stored.
  const fingerprint = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return `\0m${(h >>> 0).toString(36)}`;
  };
  function flushType(el) {
    if (!isTextField(el)) return;
    // The toggle read lands just after injection; a step that beats it waits rather than guess a default.
    if (flag.get() === null) { flag.read.then(() => flushType(el)); return; }
    const entered = valueOf(el);
    const val = entered == null ? '' : String(entered);
    if (!val.trim()) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const field = name ? `${name} field` : 'field';
    // Toggle on: no value, and no heuristic decides anything (see maskedAllAs).
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
    // Marked, not merely cut: a value that reads as complete is one a tester compares and fails.
    const shown = trimMark(val, 40);
    record(el, 'type', near, { kind: 'step', action: 'type', name, context: ctx,
      text: `Type "${shown}" into the ${field}${clauseOf(ctx)}` }, { text: shown, masked: false });
  }

  // `activeElement` stops at a shadow host, so the caret inside a web component is found by descending.
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

  // Stop is the one moment a never-blurred field must become a step; same path, so masking applies.
  async function flushPending() {
    try {
      await flag.read; // flushType drops the step while the never-values toggle is unread
      const el = deepActive();
      if (el) flushType(el);
      flushOutbox();
      await Promise.allSettled([...inflight]);
    } catch { /* a stop is never held up by its flush */ }
  }

  // Mid-composition `.value` is the IME's unfinished reading; only compositionend has the meant text.
  let composingEl = null; // one caret per document, and every frame runs its own copy

  function onCompositionStart(e) {
    if (!recording || fromIndicator(e)) return;
    composingEl = path0(e);
  }

  // Blink commits the text into `.value` before this fires; the Enter that follows dedupes against it.
  function onCompositionEnd(e) {
    if (!recording || fromIndicator(e)) return;
    const el = path0(e);
    composingEl = null;
    flushType(el);
  }

  // The indicator's own input is a page text field: every handler here must ignore it.
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
    // On: "text" reads wrong for a list. Off: maskedAs sees el.value, a card may be option text.
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

  // Slider, colour and file picker values are not secrets, so no heuristic reads them.
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
    // A file input the page clears fires `change` with nothing chosen: no file, no step.
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
      // Nameless and contextless stays silent: "Choose the option" alone says nothing.
      if (name) record(el, 'check', near, { ...entry, text: `Choose the "${name}" option${clause}` });
      else if (clause) record(el, 'check', near, { ...entry, text: `Choose the option${clause}` });
    }
  }

  // Plus the ARIA controls SPAs build from <div>s: without them a tab strip or menu records nothing.
  const CLICK_SEL = 'a, button, [role="button"], summary,'
    + ' input[type="button"], input[type="submit"], input[type="reset"], input[type="image"],'
    + ' [role="checkbox"], [role="radio"], [role="switch"], [role="tab"],'
    + ' [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"],'
    + ' [role="link"], [role="combobox"], [role="listbox"], [role="slider"],'
    + ' [role="spinbutton"], [role="treeitem"], [role="gridcell"]';

  function clickTarget(e) {
    if (!recording || fromIndicator(e)) return null;
    const raw = path0(e);
    if (!raw || !raw.closest) return null;
    if (isTextField(raw)) return null;
    if (raw.tagName === 'SELECT' || raw.closest('select')) return null;
    if (raw.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(raw.type || '')) return null;
    const el = raw.closest(CLICK_SEL);
    if (!el) return null;
    // A label forwards its click to the checkbox/radio, which the `change` step already covers.
    if (el.tagName === 'LABEL') return null;
    // Same for a role wrapper around a real control: `change`/type records it, one action, one step.
    if (ROLE_PHRASE[roleOf(el)] && el.querySelector('input, select, textarea')) return null;
    return el;
  }

  // Clicks on text inputs and selects are focus noise; checkboxes and radios record via `change`.
  function onClick(e) {
    const el = clickTarget(e);
    if (!el) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    record(el, 'click', near, { kind: 'step', action: 'click', name, context: ctx, text: clickPhrase(el, name, ctx) });
  }

  // A real double-click fires click, click, dblclick: `replaces` pops the two clicks in the worker.
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
    flushOutbox(); // before the stop message: the worker still takes entries
    render();      // the pill answers the click now, not when the flush lands
    await flushed; // the editor's follow-up stop clears the state — lose that race and the step is gone
    chrome.runtime.sendMessage({ type: 'STEPREC_STOP_REQUEST' }).catch(() => {});
  }

  const opts = { capture: true };
  document.addEventListener('click', onClick, opts);
  document.addEventListener('dblclick', onDblClick, opts);
  document.addEventListener('change', onChange, opts);
  document.addEventListener('blur', onBlur, opts);
  document.addEventListener('keydown', onKeydown, opts);
  document.addEventListener('compositionstart', onCompositionStart, opts);
  document.addEventListener('compositionend', onCompositionEnd, opts);
  // The navigating click would be lost in a packet window; both events fire while the document lives.
  window.addEventListener('pagehide', flushOutbox);
  window.addEventListener('beforeunload', flushOutbox);
  // Answer at once even when torn down, or the editor's Stop waits out its timeout.
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

  // A frame has no counter to feed, so it polls four times less often.
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

  // The page's real title for the navigation entry: reliable after a re-inject, unlike tab.title.
  const reportTitle = () => chrome.runtime.sendMessage({ type: 'STEPREC_TITLE', title: document.title }).catch(() => {});
  // Top frame only: a payment form's <title> is not where the tester navigated.
  if (TOP) {
    if (document.title) reportTitle();
    else window.addEventListener('DOMContentLoaded', reportTitle, { once: true });
  }
})();
