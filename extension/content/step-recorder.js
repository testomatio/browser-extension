// Step recorder (on-page content script). Injected on demand via
// chrome.scripting.executeScript (NOT a declared content_script), same mechanism
// as the annotator overlay — isolated world, capture-phase listeners, a Shadow
// DOM indicator. It turns the tester's actions into human-readable Markdown steps
// (never Playwright code) and ships each one to the service worker, which owns the
// canonical recording state in chrome.storage.session. Nothing leaves the
// extension (Single Egress holds).
//
// Protocol (chrome.runtime messages to background.js):
//   STEPREC_ADD {entry:{kind,text,action,name,context,manual}}
//                                   -> {ok,count,paused,manualPause,recording}
//   STEPREC_STATUS                  -> {recording,count,paused,manualPause,tabId}
//   STEPREC_STOP_REQUEST            -> recording=false (indicator Stop)
//   STEPREC_CONTINUE                -> clears the CAP pause, grants +cap
//   STEPREC_PAUSE {on}              -> the tester's own Pause/Resume (no +cap)
// The service worker mutates state; this script only reflects it (poll STATUS) and
// tears itself down when recording ends. v1: top frame only, no iframes/contenteditable.

/* global chrome */
(() => {
  'use strict';

  const HOST_ID = '__testomat_step_recorder';
  // One recorder per document. A full-load re-inject runs in a fresh document (no
  // flag); a spurious same-document re-inject is a no-op.
  if (window.__testomatStepRecInited) return;
  if (!chrome?.runtime?.sendMessage) return;
  window.__testomatStepRecInited = true;

  // ---- element naming: aria-label -> visible text -> label -> placeholder ->
  //      table column header (#74) -> name/id -> null (bare tag).
  //      Values trimmed to 40 chars. --------------------------------------------
  const trim40 = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 40);

  // Decorative chrome: a badge / pill / counter bubble, anything hidden from the
  // a11y tree, or a <script>/<style> body. Its text is never a name a tester reads
  // (#86: `in the "3" row`; #75: an analytics snippet inside a card naming the
  // button after its source, `Click the "window.__x=1;" button`).
  const BADGE_RE = /(^|[\s_-])(badge|pill|count|counter)([\s_-]|$)/i;
  const NOT_READ = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const badgeish = (el) => !!el && el.nodeType === 1
    && (NOT_READ.test(el.tagName) || el.getAttribute('aria-hidden') === 'true'
      || BADGE_RE.test(el.getAttribute('class') || ''));
  // …the node itself or any ancestor below `stop`.
  function inBadge(node, stop) {
    for (let n = node; n && n !== stop; n = n.parentElement) if (badgeish(n)) return true;
    return false;
  }

  // The element's visible text runs in document order. `glued` = this run continues
  // the previous one with NO whitespace ("ABCDE" + "$20.33") — the giveaway of a
  // concatenation; `badge` = it came from decorative chrome. One run means the text
  // IS the label; several mean it is parts of one stitched together.
  function textRuns(el, limit = 24) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let gap = true; let prev = '';
    for (let n = w.nextNode(); n && out.length < limit; n = w.nextNode()) {
      const v = n.nodeValue || '';
      const t = v.replace(/\s+/g, ' ').trim();
      if (!t) { if (/\s/.test(v)) gap = true; continue; }
      if (/^\s/.test(v)) gap = true;
      out.push({ text: t, badge: inBadge(n.parentElement, el),
        glued: !!out.length && !gap && /[\p{L}\d]$/u.test(prev) && /[\p{L}\d$€£¥₴]/u.test(t) });
      gap = /\s$/.test(v);
      prev = t;
    }
    return out;
  }

  // A buttonish element is often a whole CARD, and its textContent concatenates the
  // parts into an unreadable name (#86: `Adjustable Wrench ABCDE$20.33`). Block-level
  // structure or glued runs give that away; then name it by what a tester actually
  // reads — heading, aria-label, image alt, longest run — never the concatenation.
  const STRUCT_SEL = 'img, picture, h1, h2, h3, h4, h5, h6, p, div, section, article,'
    + ' figure, header, footer, ul, ol, li, table';
  const firstAttr = (el, sel, at) => {
    for (const n of el.querySelectorAll(sel)) { const v = (n.getAttribute(at) || '').trim(); if (v) return v; }
    return null;
  };
  function buttonishText(el) {
    const runs = textRuns(el);
    if (!runs.length) return null;
    const kept = runs.filter((r) => !r.badge);
    if (!kept.length) return null; // nothing but chrome (an icon-font glyph) — let a label/id name it
    const raw = (el.textContent || '').trim();
    // One run (or plain inline emphasis) — the raw text is the name, as before;
    // dropped badge text is the one reason to rebuild it from the runs.
    if (!(runs.length > 1 && (runs.some((r) => r.glued) || el.querySelector(STRUCT_SEL)))) {
      return kept.length < runs.length ? kept.map((r) => r.text).join(' ') : raw;
    }
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    const ht = h && cleanText(h);
    if (ht) return ht;
    return firstAttr(el, '[aria-label]', 'aria-label') || firstAttr(el, 'img[alt]', 'alt')
      || kept.reduce((a, r) => (r.text.length > a.length ? r.text : a), '') || raw;
  }

  // A wrapping <label> holds the control it labels, so its textContent bleeds the
  // control's own text (e.g. a <select>'s option labels). Strip nested controls
  // before reading, so `<label>Role <select>…</select></label>` yields "Role".
  function cleanLabelText(labelEl) {
    if (!labelEl) return null;
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    const t = clone.textContent;
    return t && t.trim() ? t : null;
  }
  function labelText(el) {
    try {
      if (el.labels && el.labels.length) { const t = cleanLabelText(el.labels[0]); if (t) return t; }
    } catch { /* labels unsupported */ }
    const wrap = el.closest && el.closest('label');
    if (wrap) { const t = cleanLabelText(wrap); if (t) return t; }
    if (el.id) { const t = cleanLabelText(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)); if (t) return t; }
    return null;
  }

  // "Names itself by its own text" — buttons, links, and every ARIA custom control
  // we recognize (a [role=tab] is labelled by its text exactly like a button; the
  // name/id fallback below would otherwise record `Open the "tab-details" tab`).
  const isButtonish = (el) => {
    const tag = el.tagName;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY'
      || role === 'button' || !!ROLE_PHRASE[role]
      || (tag === 'INPUT' && /^(button|submit|reset|image)$/i.test(el.type || ''));
  };

  // `fallback` (#74: the cell's column header) slots in AHEAD of name/id — those
  // are developer strings, a column header is what the tester actually reads.
  function elementName(el, fallback) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return trim40(aria);
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const l = document.getElementById(labelledby);
      if (l && l.textContent.trim()) return trim40(l.textContent);
    }
    if (isButtonish(el)) {
      const t = buttonishText(el);
      if (t) return trim40(t);
      if (el.value && String(el.value).trim()) return trim40(el.value);
    }
    const lbl = labelText(el);
    if (lbl) return trim40(lbl);
    if (el.placeholder && el.placeholder.trim()) return trim40(el.placeholder);
    if (fallback) return fallback;
    if (el.getAttribute && el.getAttribute('name')) return trim40(el.getAttribute('name'));
    if (el.id) return trim40(el.id);
    return null;
  }

  // ---- element context (#74): the row/card, the section and the table column an
  //      element sits in. Read AT EVENT TIME — the DOM has moved on by the time
  //      anyone reads the recording, so a name resolved later is a guess. --------
  const ROW_SEL = 'tr, li, [role=row], [role=listitem]';
  const ROW_TITLE_SEL = 'h1,h2,h3,h4,h5,h6,th,td,[role=rowheader],[role=cell],[role=gridcell],strong,b';

  // Text of a title candidate with nested controls stripped, so the cell that
  // merely HOLDS the control never ends up naming the row after it.
  function cleanText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button, script, style, noscript, template').forEach((n) => n.remove());
    clone.querySelectorAll('[class], [aria-hidden]').forEach((n) => { if (badgeish(n)) n.remove(); }); // a counter is not text
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }

  // What a tester would actually call a row: at least two characters and at least
  // one letter. A bare counter ("3"), a price or a lone glyph is noise (#86).
  const titleish = (t) => !!t && t.length >= 2 && /\p{L}/u.test(t);

  // The row/card's own label: the first heading / header cell / cell / bold run in
  // document order that is a title AT ALL (a badge is skipped, not emitted), else the
  // item's whole text when it is short enough to BE a title (a card's paragraph body
  // is not one, and a sliced paragraph reads as noise).
  function rowTitle(row) {
    for (const n of row.querySelectorAll(ROW_TITLE_SEL)) {
      const t = cleanText(n);
      if (titleish(t) && !inBadge(n, row)) return trim40(t);
    }
    const own = cleanText(row);
    return titleish(own) && own.length <= 60 ? trim40(own) : null;
  }

  // The enclosing section: a fieldset's legend, else the nearest heading BEFORE the
  // element in document order. Bounded walk (8 ancestors × 12 siblings) — a full-DOM
  // sweep on every click is not worth one context clause.
  function sectionTitle(el) {
    for (let node = el, up = 0; node && up < 8; node = node.parentElement, up++) {
      if (node.tagName === 'FIELDSET') {
        const lg = node.querySelector(':scope > legend');
        const t = lg && cleanText(lg);
        if (t) return trim40(t);
      }
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 12; i++, sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName)) { const t = cleanText(sib); if (t) return trim40(t); }
      }
    }
    return null;
  }

  // A cell's column = the header cell above it (`cellIndex` is the honest mapping);
  // only a table with a real header row answers.
  function columnTitle(el) {
    const cell = el.closest && el.closest('td, th');
    if (!cell || cell.tagName === 'TH') return null;
    const table = cell.closest('table');
    const head = table && (table.tHead ? table.tHead.rows[0] : table.rows[0]);
    if (!head || head === cell.parentElement) return null;
    const th = head.cells[cell.cellIndex];
    if (!th || th.tagName !== 'TH') return null;
    const t = cleanText(th);
    return t ? trim40(t) : null;
  }

  // A control a tester cannot name from the control alone borrows its column
  // header — to them that IS its name ("the Bulk checkbox").
  const nameOf = (el) => elementName(el, columnTitle(el));

  // The three facts, minus any that only repeat the control's own name.
  function contextOf(el, name) {
    if (!el || !el.closest) return null;
    const same = (t) => !!(t && name && t.toLowerCase() === String(name).toLowerCase());
    const ctx = {};
    const row = el.closest(ROW_SEL);
    const rt = row && row !== el ? rowTitle(row) : null;
    if (rt && !same(rt)) ctx.row = rt;
    const st = sectionTitle(el);
    if (st && !same(st)) ctx.section = st;
    const col = columnTitle(el);
    if (col) ctx.column = col;
    return Object.keys(ctx).length ? ctx : null;
  }

  // ONE clause in the step text, never two: the row is the more specific fact, the
  // section is the fallback. The column already spoke — as the control's name.
  const clauseOf = (ctx) => (!ctx ? ''
    : ctx.row ? ` in the "${ctx.row}" row`
      : ctx.section ? ` in the "${ctx.section}" section` : '');

  // ---- send one recorded entry; reflect the returned count/paused ------------
  let recording = true;
  let paused = false;      // the step cap's pause (Continue clears it, +cap)
  let manualPause = false; // the tester's own Pause (Resume clears it, no +cap)
  let count = 0;

  // The entry carries the rendered `text` every consumer reads PLUS the structured
  // {action, name, context} behind it (#74). `replaces` (dblclick only) is a wire
  // instruction: the exact single-click text this action supersedes — the worker
  // pops those trailing twins before appending.
  function send(entry) {
    if (!entry || !entry.text) return;
    chrome.runtime.sendMessage({ type: 'STEPREC_ADD', entry })
      .then((r) => {
        if (!r) return;
        if (r.recording === false) { recording = false; render(); return; }
        if (typeof r.count === 'number') count = r.count;
        paused = !!r.paused;
        manualPause = !!r.manualPause;
        render();
      })
      .catch(() => { /* worker asleep / gone — the poll recovers */ });
  }

  // ---- action recognizers ----------------------------------------------------
  const path0 = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  // The indicator is a shadow host INSIDE the page, so its own clicks compose out
  // into `document` and would record as steps — Pause/Resume/Stop are ours, not
  // the tester's scenario.
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
  // Everything typed is recorded verbatim into the test case and uploaded, and
  // `type=password` used to be the only thing masked — while card, CVV, expiry,
  // OTP and tax-id fields are text/tel/numeric, never password. So a checkout
  // rehearsed on staging with a real card published that card.

  // A developer string says the same word three ways — `cardNumber`, `card_number`,
  // `CARD-NUMBER`. Split it into words once, then match whole words only, so
  // `shipping` never reads as a `pin` and `Card number` matches `card`.
  const words = (s) => String(s || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z\d]+/g, ' ')
    .trim().toLowerCase();

  // BEST-EFFORT, deliberately: a field is only as findable as the site chose to
  // name it, so this list will miss things and is meant to be extended. The Luhn
  // check below is the backstop for the one case with real consequences, and the
  // Settings toggle is the way out for anyone who cannot rely on a heuristic.
  // Every entry is written the way `words()` leaves it, which is BOTH spellings:
  // it splits `cardNumber`/`card-number` into `card number`, but a run-together
  // lowercase `cardnumber` has no seam to split on and arrives whole — so the
  // optional space in `card ?num(ber)?` is load-bearing, not cosmetic.
  const CARD_NUMBER_WORDS = /\b(card ?num(ber)?|cc ?(num(ber)?|no))\b/;
  const SENSITIVE_WORDS = /\b(card ?num(ber)?|card|cc ?(num(ber)?|no)|cvv|cvc|csc|security code|ssn|social security|passport|otp|passcode|one[- ]?time|exp(iry|iration)?|secret|token|api[- ]?key|pin|iban|routing|account number|tax id)\b/;
  // A revealed password is a `type=text` field (every show/hide eye button flips
  // it), and a signup or admin form routinely ships no `autocomplete` at all.
  // `passphrase` earns its place (SSH keys, wallets, PGP). `passport` must not
  // land HERE — it is a government id, masked as "the value" by the list above,
  // not a password — which is why these are whole words and not a `pass` prefix.
  const PASSWORD_WORDS = /\b(password|passwd|pwd|passphrase)\b/;
  // `card` ALONE is not a card number — a Kanban "Card title" is masked by the list
  // above, and calling that "the card number" would be a confident lie.
  const isCardNumber = (w) => CARD_NUMBER_WORDS.test(w)
    || (/\bcard\b/.test(w) && /\b(number|num|no|pan)\b/.test(w));
  // `autocomplete` is the one signal a site states on purpose rather than by habit.
  const SENSITIVE_AC = /^(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name|one-time-code|new-password|current-password)$/;

  // Spec tokens: `section-*`, then billing/shipping, then the field name (and a
  // trailing `webauthn`) — so test every token that is left, not just the last.
  const acTokens = (el) => ((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase().split(/\s+/)
    .filter((t) => t && t !== 'billing' && t !== 'shipping' && !t.startsWith('section-'));

  // Every string this field could be known by, as one normalized word bag.
  const fieldWords = (el) => words([el.getAttribute && el.getAttribute('name'), el.id,
    el.placeholder, el.getAttribute && el.getAttribute('aria-label'), labelText(el)]
    .filter(Boolean).join(' '));

  // The backstop: 13-19 digits passing Luhn IS a payment card whatever the field is
  // called, so a card typed into `input3` is still masked. `\s` and not ' ' — an
  // auto-formatting card input separates its groups with a NBSP as often as a space.
  function looksLikeCard(val) {
    const d = String(val).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  // null = the value is safe to record; otherwise the noun the step says INSTEAD of
  // it. Only two nouns are ever certain enough to name — everything else is "the
  // value", which tells a reader what happened without narrowing what it was.
  const isPassword = (el, ac, w) => (el.type || '').toLowerCase() === 'password'
    || PASSWORD_WORDS.test(w) || ac.includes('new-password') || ac.includes('current-password');

  function maskedAs(el) {
    const ac = acTokens(el);
    const val = el.value == null ? '' : String(el.value);
    const w = fieldWords(el); // one DOM walk (labelText), read three times below
    if (isPassword(el, ac, w)) return 'the password';
    if (ac.includes('cc-number') || looksLikeCard(val) || isCardNumber(w)) return 'the card number';
    if (ac.some((t) => SENSITIVE_AC.test(t)) || SENSITIVE_WORDS.test(w)) return 'the value';
    return null;
  }

  // Under the toggle every field reads alike, with exactly ONE exception: a
  // password keeps its noun. No value is written either way, so this costs nothing
  // in privacy, and `type=password` / PASSWORD_WORDS is a certainty rather than a
  // heuristic — naming it makes the step readable without revealing anything. No
  // other noun survives: a card, a CVV, an OTP and a passport all read like an
  // ordinary field, which is the point of turning this on.
  const maskedAllAs = (el) => (isPassword(el, acTokens(el), fieldWords(el)) ? 'the password' : 'text');

  // ---- "Never record entered values" (#176) ----------------------------------
  // Read from its OWN top-level key, never off `settings` — that object carries the
  // API token, which has no business in a tab's isolated world (#175). Absent -> OFF:
  // values keep being recorded, with the masking above applied.
  const NEVER_KEY = 'stepRecNeverValues';
  let neverValues = null; // null = not read yet; a value is never emitted on a guess
  const flagRead = (chrome.storage && chrome.storage.local
    ? chrome.storage.local.get(NEVER_KEY) : Promise.reject())
    .then((r) => { neverValues = r[NEVER_KEY] === true; })
    .catch(() => { neverValues = false; });
  // A Save mid-recording takes effect on the next step, not the next injection.
  const onFlagChanged = (changes, area) => {
    if (area === 'local' && changes[NEVER_KEY]) neverValues = changes[NEVER_KEY].newValue === true;
  };
  if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onFlagChanged);

  // Type consolidation: remember the last value emitted per field so blur+Enter
  // don't double-record, and empty fields never record. A masked field remembers a
  // SENTINEL instead — the secret it just refused to send is not ours to hold.
  const lastTyped = new WeakMap();
  const MASKED = '\0masked';
  function flushType(el) {
    if (!isTextField(el)) return;
    // The toggle read lands milliseconds after injection; a step that beats it waits
    // for it rather than being recorded under a guessed default.
    if (neverValues === null) { flagRead.then(() => flushType(el)); return; }
    const val = el.value == null ? '' : String(el.value);
    if (!val.trim()) return;
    const name = nameOf(el);
    const ctx = contextOf(el, name);
    const field = name ? `${name} field` : 'field';
    // Toggle ON: no value, and no heuristic decides anything — see maskedAllAs.
    const noun = neverValues ? maskedAllAs(el) : maskedAs(el);
    if (noun) {
      if (lastTyped.get(el) === MASKED) return;
      lastTyped.set(el, MASKED);
      send({ kind: 'step', action: 'type', name, context: ctx,
        text: `Type ${noun} into the ${field}${clauseOf(ctx)}` });
      return;
    }
    if (lastTyped.get(el) === val) return;
    lastTyped.set(el, val);
    send({ kind: 'step', action: 'type', name, context: ctx,
      text: `Type "${trim40(val)}" into the ${field}${clauseOf(ctx)}` });
  }

  // The indicator's own input is a text field inside the page (#78) — every one of
  // these must ignore it, or typing an expected result records itself as a step.
  function onBlur(e) {
    if (!recording || fromIndicator(e)) return;
    flushType(path0(e));
  }

  function onKeydown(e) {
    if (!recording || e.key !== 'Enter' || fromIndicator(e)) return;
    const el = path0(e);
    if (isTextField(el)) flushType(el);
  }

  function onChange(e) {
    if (!recording || fromIndicator(e)) return;
    const el = path0(e);
    if (!el || !el.tagName) return;
    if (el.tagName === 'SELECT') {
      const name = nameOf(el);
      const ctx = contextOf(el, name);
      const opt = el.selectedOptions && el.selectedOptions[0];
      const val = opt ? (opt.textContent || opt.value || '').trim() : String(el.value || '');
      send({ kind: 'step', action: 'select', name, context: ctx,
        text: `Select "${trim40(val)}" in the ${name ? `${name} ` : ''}dropdown${clauseOf(ctx)}` });
      return;
    }
    if (el.tagName === 'INPUT' && /^checkbox$/i.test(el.type || '')) {
      const name = nameOf(el);
      const ctx = contextOf(el, name);
      send({ kind: 'step', action: el.checked ? 'check' : 'uncheck', name, context: ctx,
        text: `${el.checked ? 'Check' : 'Uncheck'} the ${name ? `${name} ` : ''}checkbox${clauseOf(ctx)}` });
      return;
    }
    if (el.tagName === 'INPUT' && /^radio$/i.test(el.type || '')) {
      const name = nameOf(el);
      const ctx = contextOf(el, name);
      const clause = clauseOf(ctx);
      // Nameless AND contextless stays silent, as before — "Choose the option" on
      // its own tells a reader nothing. A context clause rescues it.
      if (name) send({ kind: 'step', action: 'choose', name, context: ctx, text: `Choose the "${name}" option${clause}` });
      else if (clause) send({ kind: 'step', action: 'choose', name, context: ctx, text: `Choose the option${clause}` });
    }
  }

  // Clickable targets: the native ones plus the ARIA custom controls React/SPA UIs
  // build out of <div>s — without these a whole tab strip or menu records nothing.
  const CLICK_SEL = 'a, button, [role="button"], summary,'
    + ' input[type="button"], input[type="submit"], input[type="reset"], input[type="image"],'
    + ' [role="checkbox"], [role="radio"], [role="switch"], [role="tab"],'
    + ' [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';

  // Each role gets the verb a tester would write by hand; a nameless control keeps
  // the bare-noun form the button recognizer already uses ("Click the button").
  const menuPhrase = (n) => (n ? `Choose "${n}" in the menu` : 'Choose the menu item');
  const ROLE_PHRASE = {
    tab: (n) => (n ? `Open the "${n}" tab` : 'Open the tab'),
    menuitem: menuPhrase,
    menuitemcheckbox: menuPhrase,
    menuitemradio: menuPhrase,
    option: (n) => (n ? `Select "${n}"` : 'Select the option'),
    checkbox: (n) => (n ? `Toggle the "${n}" checkbox` : 'Toggle the checkbox'),
    switch: (n) => (n ? `Toggle the "${n}" switch` : 'Toggle the switch'),
    radio: (n) => (n ? `Choose the "${n}" option` : 'Choose the option'),
  };
  const ROLE_NOUN = {
    tab: 'tab', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item',
    option: 'option', checkbox: 'checkbox', switch: 'switch', radio: 'option', button: 'button',
  };
  const roleOf = (el) => (el.getAttribute && el.getAttribute('role')) || '';

  // The step a click on `el` produces — shared with dblclick, which supersedes it
  // by exactly this text (context clause included).
  function clickPhrase(el, name, ctx) {
    const phrase = ROLE_PHRASE[roleOf(el)];
    const clause = clauseOf(ctx);
    if (phrase) return phrase(name) + clause;
    const word = el.tagName === 'A' ? 'link' : 'button';
    return (name ? `Click the "${name}" ${word}` : `Click the ${word}`) + clause;
  }

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
    // A label wrapping a checkbox/radio forwards its click to the control — the
    // `change` step already covers it; don't also emit a Click.
    if (el.tagName === 'LABEL') return null;
    // Same rule for a role wrapper around a REAL control (a styled native
    // checkbox): the `change`/type path records it, so one action stays one step.
    if (ROLE_PHRASE[roleOf(el)] && el.querySelector('input, select, textarea')) return null;
    return el;
  }

  // Clicks on text inputs / selects are focus noise (the following Type/Select
  // absorbs them). Native checkboxes/radios record via `change`. Buttons, links
  // and the ARIA custom controls here.
  function onClick(e) {
    const el = clickTarget(e);
    if (!el) return;
    const name = nameOf(el);
    const ctx = contextOf(el, name);
    send({ kind: 'step', action: 'click', name, context: ctx, text: clickPhrase(el, name, ctx) });
  }

  // A real double-click fires click, click, dblclick — so the two clicks are
  // already recorded when this lands; `replaces` pops them in the worker.
  function onDblClick(e) {
    const el = clickTarget(e);
    if (!el) return;
    const noun = ROLE_NOUN[roleOf(el)] || (el.tagName === 'A' ? 'link' : 'button');
    const name = nameOf(el);
    const ctx = contextOf(el, name);
    send({ kind: 'step', action: 'dblclick', name, context: ctx,
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

  // `icon` is a Material Symbols name from shared/icons.js, injected right
  // before this file (background.js srInject). Absent set → the label alone,
  // which is what every pill but the create one wants anyway.
  function pillButton(label, cls, onClick, icon) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    const svg = icon && window.Icons ? window.Icons.elIn(document, icon, 14) : null;
    if (svg) b.append(svg);
    b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  // Rebuilt on every 500ms poll, so the dot and the label are re-APPENDED nodes,
  // never fresh ones — the open + Expected input relies on surviving a render.
  const dot = document.createElement('span');
  dot.className = 'dot';
  const txt = document.createElement('span');
  txt.className = 'txt';

  // ---- moving the pill -------------------------------------------------------
  // The bottom-right corner is where a page puts its own cookie banner, chat
  // bubble and toast stack — exactly the controls a tester has to reach WHILE
  // recording. So the pill is draggable: grab it anywhere but a button or the
  // input and drop it wherever it is out of the way.
  //
  // Dropped position lives in storage.local (its own top-level key, never
  // `settings` — same rule as NEVER_KEY above), so it survives the re-injection
  // every navigation performs and the pill does not jump back to the corner
  // mid-recording. It holds nothing but two numbers.
  const POS_KEY = 'stepRecIndicatorPos';
  const EDGE = 8;          // never flush against the viewport edge
  const DRAG_SLOP = 4;     // below this a press is a press, not a drag
  let pos = null;          // {left, top} viewport px; null = the default corner

  // A viewport is not the one the position was saved from — a narrower window, a
  // second monitor, or just a pill that grew (the + Expected input is 220px wider
  // than the label it replaces). Clamping on every apply is what keeps a dropped
  // pill on screen instead of half past its edge.
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
    // Left button / touch / pen only, and never a press that is aimed at a
    // control: Stop must stay one click, not a click that might have moved.
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

  // The move/up pair listens on the WINDOW, in the capture phase: pointer capture
  // is best-effort (a synthetic pointer has none to take), and a hand that outruns
  // the pill must not strand a half-finished drag. Capture, because the pill stops
  // these events from bubbling out of itself — see below.
  const winOpts = { capture: true };
  box.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, winOpts);
  window.addEventListener('pointerup', endDrag, winOpts);
  window.addEventListener('pointercancel', endDrag, winOpts);
  // The click a drop produces (grabbed the pill, released over Stop) must not press
  // the button under it — caught on the way DOWN, before the button's own handler.
  // A browser fires that click in the same breath as the pointerup, so the window
  // is short on purpose: a drag that never produced one must not leave something
  // behind that eats the tester's next real click on Pause.
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
  window.addEventListener('resize', onResize);

  function dragTeardown() {
    window.removeEventListener('pointermove', onPointerMove, winOpts);
    window.removeEventListener('pointerup', endDrag, winOpts);
    window.removeEventListener('pointercancel', endDrag, winOpts);
    window.removeEventListener('resize', onResize);
  }

  // ---- + Expected (#78) ------------------------------------------------------
  // The one thing a recorder cannot observe: an expectation is what the tester
  // LOOKED at, not a DOM event. So it is typed — inside the shadow root, where no
  // page CSS reaches it and (with the stopPropagation below) no page key handler
  // sees it either.
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

  // Enter commits (an empty input just collapses — never an empty expected), Esc
  // collapses. A committed entry counts toward the cap exactly like a step.
  function commitExpected() {
    const text = expInput ? String(expInput.value || '').replace(/\s+/g, ' ').trim() : '';
    closeExpected();
    if (text) send({ kind: 'expected', text, manual: true });
    render();
  }

  // Our keystrokes are ours: stopped on the way OUT of the shadow root, so the
  // page's own handlers (a "/" search hotkey, an Esc-closes-modal) never see the
  // tester typing. A page listener in the CAPTURE phase still runs first — no DOM
  // can prevent that — and our own capture listeners bail out via fromIndicator().
  shadow.addEventListener('keydown', (e) => {
    if (expOpen && e.target === expInput) {
      if (e.key === 'Enter') { e.preventDefault(); commitExpected(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeExpected(); render(); }
    }
    e.stopPropagation();
  });
  ['keyup', 'keypress', 'input', 'change'].forEach((t) => shadow.addEventListener(t, (e) => e.stopPropagation()));

  // Three states, one pill: recording (+ Expected + Pause + Stop), the tester's own
  // pause (Resume + Stop) and the cap's "Still recording?" (Continue + Stop). Both
  // pauses share the amber styling; only the copy and the buttons differ, so
  // Continue's +cap grant is never the way out of a manual pause.
  function render() {
    txt.textContent = manualPause ? `Paused · ${steps(count)}`
      : paused ? 'Still recording?' : `Recording · ${steps(count)}`;
    // An open input OWNS the pill: a poll re-render would take the caret and the
    // half-typed text with it. A pause or a stop takes the pill back.
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
      // + Expected only while actually recording — a paused pill has no step to
      // attach the expectation to, and the worker would drop it anyway.
      box.append(pillButton('Expected', 'exp', openExpected, 'add'),
        pillButton('Pause', '', () => setManualPause(true)), stop);
    }
    // The pill just changed width (Pause drops two buttons, + Expected adds a
    // 220px input). Anchored by its left edge, that is what can push it off
    // screen — so re-clamp where it stands.
    if (pos) applyPos();
  }

  function setManualPause(on) {
    manualPause = on; // optimistic: the pill must not lag the click it just took
    render();
    chrome.runtime.sendMessage({ type: 'STEPREC_PAUSE', on })
      .then((r) => { if (r) { manualPause = !!r.manualPause; render(); } })
      .catch(() => { /* worker asleep — the poll re-syncs */ });
  }

  function requestStop() {
    recording = false;
    render();
    chrome.runtime.sendMessage({ type: 'STEPREC_STOP_REQUEST' }).catch(() => {});
  }

  // ---- lifecycle -------------------------------------------------------------
  const opts = { capture: true };
  document.addEventListener('click', onClick, opts);
  document.addEventListener('dblclick', onDblClick, opts);
  document.addEventListener('change', onChange, opts);
  document.addEventListener('blur', onBlur, opts);
  document.addEventListener('keydown', onKeydown, opts);

  let torn = false;
  let pollTimer = null;
  function teardown() {
    if (torn) return;
    torn = true;
    clearInterval(pollTimer);
    document.removeEventListener('click', onClick, opts);
    document.removeEventListener('dblclick', onDblClick, opts);
    document.removeEventListener('change', onChange, opts);
    document.removeEventListener('blur', onBlur, opts);
    document.removeEventListener('keydown', onKeydown, opts);
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.removeListener(onFlagChanged);
    dragTeardown();
    host.remove();
    window.__testomatStepRecInited = false;
  }

  // Reflect the canonical state (count/paused) and self-remove once recording
  // ends (editor Stop, indicator Stop, tab close — all flip recording=false).
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
  }, 500);

  (document.body || document.documentElement).append(host);
  render();

  // Report this page's real title so the worker can refine the navigation entry
  // (`The "<title>" page opens`) — reliable after a re-inject, unlike tab.title.
  const reportTitle = () => chrome.runtime.sendMessage({ type: 'STEPREC_TITLE', title: document.title }).catch(() => {});
  if (document.title) reportTitle();
  else window.addEventListener('DOMContentLoaded', reportTitle, { once: true });
})();
