// Step recorder, injected on demand via chrome.scripting.executeScript (NOT a declared
// content_script). background.js owns the state; this reflects it and tears itself down.

/* global chrome */
(() => {
  'use strict';

  const HOST_ID = '__testomat_step_recorder';
  // One recorder per document: a full-load re-inject runs in a fresh document (no flag),
  // while a spurious same-document re-inject is a no-op.
  if (window.__testomatStepRecInited) return;
  if (!chrome?.runtime?.sendMessage) return;
  window.__testomatStepRecInited = true;

  // ---- element naming: aria-label -> text -> label -> placeholder -> column header (#74)
  //      -> name/id -> null (bare tag); values trimmed to 40 chars. ---------------
  const trimTo = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const trim40 = (s) => trimTo(s, 40);

  // Decorative chrome (badge, counter, anything hidden from the a11y tree, a <script>
  // body): its text is never a name a tester reads — #86 `in the "3" row`, #75 a snippet.
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

  // `glued` = this run continues the previous with NO whitespace ("ABCDE" + "$20.33"),
  // the giveaway of a concatenation; `badge` = it came from decorative chrome.
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

  // A buttonish element is often a whole CARD whose textContent concatenates into an
  // unreadable name (#86: `Adjustable Wrench ABCDE$20.33`); block structure gives it away.
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
    // One run (or plain inline emphasis): the raw text is the name — dropped badge text
    // is the one reason to rebuild it from the runs.
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
  // control's own text (a <select>'s option labels) unless the controls are stripped.
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

  // "Names itself by its own text" — buttons, links and every ARIA custom control we
  // recognize; without the roles, name/id records `Open the "tab-details" tab`.
  const isButtonish = (el) => {
    const tag = el.tagName;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY'
      || role === 'button' || !!ROLE_PHRASE[role]
      || (tag === 'INPUT' && /^(button|submit|reset|image)$/i.test(el.type || ''));
  };

  // `fallback` (#74: the cell's column header) slots in AHEAD of name/id — those are
  // developer strings, a column header is what the tester actually reads. `near` (#23) is
  // the surroundings, read once per action.
  function elementName(el, fallback, near) {
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
    // #23: `near.label` IS the label branch above. What is new is the row/section — a
    // nameless control is named by the clause the sentence already carries ("Click the
    // button in the "Bolt Cutters" row"), which beats writing a dev string over it.
    if (near && near.label) return trim40(near.label);
    if (near && (near.row || near.section)) return null;
    if (el.getAttribute && el.getAttribute('name')) return trim40(el.getAttribute('name'));
    if (el.id) return trim40(el.id);
    return null;
  }

  // ---- element context (#74): the row/card, section and column an element sits in ----
  // Read AT EVENT TIME: the DOM has moved on by the time anyone reads the recording.
  const ROW_SEL = 'tr, li, [role=row], [role=listitem]';
  const ROW_TITLE_SEL = 'h1,h2,h3,h4,h5,h6,th,td,[role=rowheader],[role=cell],[role=gridcell],strong,b';

  // Nested controls stripped, so the cell that merely HOLDS a control never names the row.
  function cleanText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button, script, style, noscript, template').forEach((n) => n.remove());
    clone.querySelectorAll('[class], [aria-hidden]').forEach((n) => { if (badgeish(n)) n.remove(); }); // a counter is not text
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }

  // A bare counter ("3"), a price or a lone glyph is noise, not a row title (#86).
  const titleish = (t) => !!t && t.length >= 2 && /\p{L}/u.test(t);

  // The first title-ish heading/cell/bold run in document order (badges skipped), else the
  // item's whole text when it is short enough to BE a title — a sliced paragraph is noise.
  function rowTitle(row) {
    for (const n of row.querySelectorAll(ROW_TITLE_SEL)) {
      const t = cleanText(n);
      if (titleish(t) && !inBadge(n, row)) return trim40(t);
    }
    const own = cleanText(row);
    return titleish(own) && own.length <= 60 ? trim40(own) : null;
  }

  // A fieldset's legend, else the nearest heading BEFORE the element. The walk is bounded
  // (8 ancestors × 12 siblings): a full-DOM sweep on every click is not worth one clause.
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

  // `cellIndex` is the honest mapping to the header cell; only a real header row answers.
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

  // The nearest heading ABOVE the element: its own tag, then each ancestor's preceding
  // siblings. Same bounded walk as sectionTitle, minus the fieldset legend.
  function headingOf(el) {
    for (let node = el, up = 0; node && up < 8; node = node.parentElement, up++) {
      if (/^H[1-6]$/.test(node.tagName)) { const t = cleanText(node); if (t) return trim40(t); }
      let sib = node.previousElementSibling;
      for (let i = 0; sib && i < 12; i++, sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName)) { const t = cleanText(sib); if (t) return trim40(t); }
      }
    }
    return '';
  }

  // What sits either side of the control — the "- | 1" a lone + button is read by.
  function siblingsOf(el) {
    const one = (n) => (n ? trimTo(cleanText(n) || '', 24) : '');
    return [one(el.previousElementSibling), one(el.nextElementSibling)].filter(Boolean).join(' | ');
  }

  // The surroundings, read ONCE per action: the sentence's clause and the packet's `near`
  // (#23) are the same reads, and each of them walks the DOM.
  function nearFacts(el) {
    const out = { label: '', row: '', column: '', section: '', heading: '', siblings: '' };
    if (!el || !el.closest) return out;
    try {
      const lbl = labelText(el);
      out.label = lbl ? trim40(lbl) : '';
      const row = el.closest(ROW_SEL);
      out.row = row && row !== el ? (rowTitle(row) || '') : '';
      out.column = columnTitle(el) || '';
      out.section = sectionTitle(el) || '';
      out.heading = headingOf(el);
      out.siblings = siblingsOf(el);
    } catch { /* best effort: an empty field is fine, a lost step is not */ }
    return out;
  }

  // A control a tester cannot name from the control alone borrows its column header —
  // to them that IS its name ("the Bulk checkbox").
  const nameOf = (el, near) => elementName(el, near.column || null, near);

  // The three facts, minus any that only repeat the control's own name.
  function contextOf(el, name, near) {
    if (!el || !el.closest) return null;
    const n = near || nearFacts(el);
    const same = (t) => !!(t && name && t.toLowerCase() === String(name).toLowerCase());
    const ctx = {};
    if (n.row && !same(n.row)) ctx.row = n.row;
    if (n.section && !same(n.section)) ctx.section = n.section;
    if (n.column) ctx.column = n.column;
    return Object.keys(ctx).length ? ctx : null;
  }

  // ONE clause per step, never two: the row is the more specific fact, the section is the
  // fallback, and the column already spoke — as the control's name.
  const clauseOf = (ctx) => (!ctx ? ''
    : ctx.row ? ` in the "${ctx.row}" row`
      : ctx.section ? ` in the "${ctx.section}" section` : '');

  // ---- the action packet (#23) -----------------------------------------------
  // What a reader (a tester, or the AI polish in the editor) needs to recognize the action:
  // the control, its surroundings, the page, and what the page did next. Never a value the
  // masking above refused — `ctx.value` carries the masked noun, not the secret.
  const PACKET_MAX = 1500; // bytes of JSON per entry
  const AFTER_MS = 400;    // how long the page gets to react before the entry leaves

  // The control's own visible text, badges dropped — the runs its name is built from.
  const ownText = (el) => trim40(textRuns(el).filter((r) => !r.badge).map((r) => r.text).join(' '));

  // An icon-only control still says what it is: an <img alt>, an <svg><title>, or the
  // ligature text of a material icon.
  function iconOf(el) {
    const alt = firstAttr(el, 'img[alt]', 'alt');
    if (alt) return trimTo(alt, 24);
    const t = el.querySelector && el.querySelector('svg title');
    if (t && (t.textContent || '').trim()) return trimTo(t.textContent, 24);
    const lig = el.querySelector && el.querySelector('[class*="material-icons"], [class*="material-symbols"], [data-icon]');
    if (lig) return trimTo(lig.getAttribute('data-icon') || lig.textContent || '', 24);
    return '';
  }

  const at = (el, n) => (el.getAttribute && el.getAttribute(n)) || '';
  const classesOf = (el) => at(el, 'class').trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');

  const elementFacts = (el) => ({
    tag: String(el.tagName || '').toLowerCase(),
    role: at(el, 'role'),
    type: at(el, 'type'),
    text: ownText(el),
    ariaLabel: at(el, 'aria-label'),
    title: at(el, 'title'),
    placeholder: at(el, 'placeholder'),
    name: at(el, 'name'),
    id: el.id || '',
    class: classesOf(el),
    icon: iconOf(el),
  });

  // `origin + pathname`, the env-meta rule (sidepanel/core/env-info.js): it drops the query,
  // the fragment and any `user:pass@` the URL carries.
  function pageUrl() {
    try { const u = new URL(location.href); return `${u.origin}${u.pathname}`; }
    catch { return String(location.href).split(/[?#]/)[0]; }
  }
  const pageOf = () => ({ title: trimTo(document.title, 80), url: pageUrl() });

  // ---- what the page did next ------------------------------------------------
  const TOAST_SEL = '[role="status"], [aria-live], [class*="toast"], [class*="notification"], [class*="snackbar"]';
  const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], dialog, [class*="modal"]';
  // What the form says went wrong: the refusal a tester reads is as much "what happened next"
  // as a toast is, and it is the half a failed login has instead of one.
  const ERROR_SEL = '[class*="alert"], [class*="error"], [class*="invalid-feedback"],'
    + ' [class*="help-block"], [class*="validation"], [aria-invalid="true"]';
  const NOTE_SEL = `[role="alert"], ${TOAST_SEL}, ${DIALOG_SEL}, ${ERROR_SEL}`;
  const noteish = (n) => n.nodeType === 1 && (n.matches ? n.matches(NOTE_SEL) : false);
  const hits = (n, sel) => !!(n.matches && n.matches(sel));
  // A toast stays a toast even when it is styled as an alert; everything else that reports a
  // problem reads as the dialog half of the packet.
  const noteKind = (n) => (hits(n, TOAST_SEL) ? 'toast'
    : (n.tagName === 'DIALOG' || hits(n, DIALOG_SEL) || hits(n, ERROR_SEL)) ? 'dialog' : 'toast');

  // An `aria-invalid` control carries no message of its own — the line it points at, or the
  // one right after it, is the sentence the tester read.
  function noteText(n) {
    if (hits(n, '[aria-invalid="true"]') && !hits(n, '[class*="alert"], [class*="error"], [class*="invalid-feedback"], [class*="help-block"], [class*="validation"]')) {
      const ref = at(n, 'aria-describedby').split(/\s+/)[0];
      const by = ref && document.getElementById(ref);
      return trimTo((by && by.textContent) || (n.nextElementSibling && n.nextElementSibling.textContent) || '', 80);
    }
    return trimTo(n.textContent || '', 80);
  }

  // Nodes are KEPT, not read, until the window closes: a toast is routinely appended empty
  // and filled a tick later.
  function watchNotes() {
    const found = [];
    const take = (n) => {
      if (found.length >= 5 || !n || n.nodeType !== 1) return;
      if (noteish(n)) { found.push(n); return; }
      const inner = n.querySelector && n.querySelector(NOTE_SEL);
      if (inner) found.push(inner);
    };
    let obs = null;
    try {
      obs = new MutationObserver((recs) => { for (const r of recs) r.addedNodes.forEach(take); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* no observer — the packet says nothing rather than failing */ }
    return () => {
      if (obs) obs.disconnect();
      const out = { toast: '', dialog: '' };
      try {
        for (const n of found) { const k = noteKind(n); if (!out[k]) out[k] = noteText(n); }
      } catch { /* best effort: an empty field is fine, a lost step is not */ }
      return out;
    };
  }

  const STATE_ATTRS = ['aria-checked', 'aria-pressed', 'aria-expanded', 'aria-selected'];
  function stateOf(el) {
    const s = {};
    if (typeof el.checked === 'boolean') s.checked = String(el.checked);
    if (typeof el.open === 'boolean') s.open = String(el.open);
    for (const a of STATE_ATTRS) { const v = el.getAttribute && el.getAttribute(a); if (v != null) s[a] = v; }
    return s;
  }
  // Only what actually moved: `aria-checked: false → true`.
  const stateDiff = (before, after) => Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k}: ${before[k] == null ? '' : before[k]} → ${after[k]}`).join(', ');

  // The badge nearest the control — inside it, else inside one of its two nearest ancestors.
  const COUNTER_SEL = '[class*="badge"], [class*="count"], [class*="counter"]';
  function counterText(el) {
    for (let n = el, up = 0; n && up < 3; n = n.parentElement, up++) {
      const hit = n.querySelector && n.querySelector(COUNTER_SEL);
      if (hit) return trimTo(hit.textContent || '', 24);
    }
    return '';
  }

  // Over the cap the least load-bearing fields go first, then the long strings are cut.
  function fitPacket(ctx) {
    const size = () => JSON.stringify(ctx).length;
    if (size() <= PACKET_MAX) return ctx;
    ctx.near.siblings = '';
    if (size() <= PACKET_MAX) return ctx;
    ctx.element.class = '';
    for (const [o, k] of [[ctx.element, 'text'], [ctx.after, 'toast'], [ctx.after, 'dialog'],
      [ctx.element, 'ariaLabel'], [ctx.element, 'title'], [ctx.near, 'heading'],
      [ctx.near, 'section'], [ctx.near, 'row'], [ctx.page, 'title']]) {
      if (size() <= PACKET_MAX) break;
      if (o && o[k]) o[k] = trimTo(o[k], 24);
    }
    return ctx;
  }

  // Everything but `after` is read AT EVENT TIME; `after` is what the page made of it, read
  // once the window closes. Returns the closure that finishes the entry.
  function armPacket(el, action, near, value) {
    const ctx = { action, element: elementFacts(el), near, page: pageOf() };
    if (value) ctx.value = value;
    const before = { url: ctx.page.url, title: ctx.page.title, state: stateOf(el), counter: counterText(el) };
    const notes = watchNotes();
    return (entry) => {
      const now = { url: pageUrl(), title: trimTo(document.title, 80), counter: counterText(el) };
      const seen = notes();
      ctx.after = {
        url: now.url === before.url ? 'unchanged' : `${before.url} → ${now.url}`,
        title: now.title === before.title ? 'unchanged' : `${before.title} → ${now.title}`,
        toast: seen.toast,
        dialog: seen.dialog,
        state: stateDiff(before.state, stateOf(el)),
        counter: now.counter === before.counter ? '' : `${before.counter} → ${now.counter}`,
      };
      entry.ctx = fitPacket(ctx);
    };
  }

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
  // Everything typed is recorded verbatim and uploaded, and card, CVV, expiry, OTP and
  // tax-id fields are text/tel/numeric — never `type=password`.

  // Split a developer string (`cardNumber`, `card_number`, `CARD-NUMBER`) into words once,
  // then match whole words only, so `shipping` never reads as a `pin`.
  const words = (s) => String(s || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z\d]+/g, ' ')
    .trim().toLowerCase();

  // Best-effort (Luhn below is the backstop). Entries are written the way `words()` leaves
  // them: `cardnumber` has no seam to split on, so the space in `card ?num` is load-bearing.
  const CARD_NUMBER_WORDS = /\b(card ?num(ber)?|cc ?(num(ber)?|no))\b/;
  const SENSITIVE_WORDS = /\b(card ?num(ber)?|card|cc ?(num(ber)?|no)|cvv|cvc|csc|security code|ssn|social security|passport|otp|passcode|one[- ]?time|exp(iry|iration)?|secret|token|api[- ]?key|pin|iban|routing|account number|tax id)\b/;
  // A revealed password is a `type=text` field (every show/hide eye flips it). Whole words,
  // not a `pass` prefix: `passport` is a government id, masked as "the value" above.
  const PASSWORD_WORDS = /\b(password|passwd|pwd|passphrase)\b/;
  // `card` ALONE is not a card number: a Kanban "Card title" is masked by the list above,
  // and calling that "the card number" would be a confident lie.
  const isCardNumber = (w) => CARD_NUMBER_WORDS.test(w)
    || (/\bcard\b/.test(w) && /\b(number|num|no|pan)\b/.test(w));
  // `autocomplete` is the one signal a site states on purpose rather than by habit.
  const SENSITIVE_AC = /^(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name|one-time-code|new-password|current-password)$/;

  // Spec token order is `section-*`, billing/shipping, the field name, a trailing
  // `webauthn` — so every remaining token is tested, not just the last.
  const acTokens = (el) => ((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase().split(/\s+/)
    .filter((t) => t && t !== 'billing' && t !== 'shipping' && !t.startsWith('section-'));

  // Every string this field could be known by, as one normalized word bag.
  const fieldWords = (el) => words([el.getAttribute && el.getAttribute('name'), el.id,
    el.placeholder, el.getAttribute && el.getAttribute('aria-label'), labelText(el)]
    .filter(Boolean).join(' '));

  // 13-19 digits passing Luhn IS a payment card whatever the field is called. `\s` and not
  // ' ': an auto-formatting card input separates groups with a NBSP as often as a space.
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

  // null = the value is safe to record; otherwise the noun the step says INSTEAD of it.
  // Only two nouns are ever certain enough to name; everything else is "the value".
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

  // Under the toggle every field reads alike but a password, which keeps its noun: no
  // value is written either way, and `type=password` is a certainty, not a heuristic.
  const maskedAllAs = (el) => (isPassword(el, acTokens(el), fieldWords(el)) ? 'the password' : 'text');

  // ---- "Never record entered values" (#176) ----------------------------------
  // Read from its OWN top-level key, never off `settings` — that object carries the API
  // token, which has no business in a tab's isolated world (#175). Absent -> OFF.
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

  // The last value emitted per field, so blur+Enter don't double-record. A masked field
  // remembers a SENTINEL instead — the secret it just refused to send is not ours to hold.
  const lastTyped = new WeakMap();
  const MASKED = '\0masked';
  function flushType(el) {
    if (!isTextField(el)) return;
    // The toggle read lands milliseconds after injection; a step that beats it waits for
    // it rather than being recorded under a guessed default.
    if (neverValues === null) { flagRead.then(() => flushType(el)); return; }
    const val = el.value == null ? '' : String(el.value);
    if (!val.trim()) return;
    const near = nearFacts(el);
    const name = nameOf(el, near);
    const ctx = contextOf(el, name, near);
    const field = name ? `${name} field` : 'field';
    // Toggle ON: no value, and no heuristic decides anything — see maskedAllAs.
    const noun = neverValues ? maskedAllAs(el) : maskedAs(el);
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
      await flagRead; // flushType drops the step while the never-values toggle is unread
      const el = deepActive();
      if (el) flushType(el);
      flushOutbox();
      await Promise.allSettled([...inflight]);
    } catch { /* a stop is never held up by its flush */ }
  }

  // The indicator's own input is a text field inside the page (#78) — every one of these
  // must ignore it, or typing an expected result records itself as a step.
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
    const near = nearFacts(el);
    if (el.tagName === 'SELECT') {
      const name = nameOf(el, near);
      const ctx = contextOf(el, name, near);
      const opt = el.selectedOptions && el.selectedOptions[0];
      const val = opt ? (opt.textContent || opt.value || '').trim() : String(el.value || '');
      record(el, 'select', near, { kind: 'step', action: 'select', name, context: ctx,
        text: `Select "${trim40(val)}" in the ${name ? `${name} ` : ''}dropdown${clauseOf(ctx)}` },
      { text: trim40(val), masked: false });
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

  // Each role gets the verb a tester would write by hand; a nameless control keeps the
  // bare-noun form ("Click the button").
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

  // Shared with dblclick, which supersedes this exact text (context clause included).
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
  window.addEventListener('resize', onResize);

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
    chrome.runtime.onMessage.removeListener(onFlushMsg);
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.removeListener(onFlagChanged);
    dragTeardown();
    host.remove();
    window.__testomatStepRecInited = false;
  }

  // Self-removes once recording ends — editor Stop, indicator Stop and tab close all
  // flip recording=false.
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

  // The page's real title, for the worker's navigation entry — reliable after a
  // re-inject, unlike tab.title.
  const reportTitle = () => chrome.runtime.sendMessage({ type: 'STEPREC_TITLE', title: document.title }).catch(() => {});
  if (document.title) reportTitle();
  else window.addEventListener('DOMContentLoaded', reportTitle, { once: true });
})();
