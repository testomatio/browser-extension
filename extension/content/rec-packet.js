// What a step carries besides its sentence: the control's facts, its surroundings, the page, and
// what the page made of the action. All but `after`, which is read once the window closes.

/* global RecNaming */

/* global window */
(() => {
  'use strict';
  // Injected on demand, and a same-document re-inject runs the file again: without this the
  // second run throws before the recorder's own latch is ever reached.
  if (window.RecPacket) return;
  const { trimTo, trim40, textRuns, firstAttr } = RecNaming;

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

  // Where the tester STANDS, for the before/after comparison only: a hash-routed app moves
  // screens in the fragment, so it is kept — unless it reads as credentials (`=` or `&`).
  const routeHash = (h) => (h.length > 1 && !/[=&]/.test(h) ? h : '');
  function routeUrl() {
    const base = pageUrl();
    try { return base + routeHash(new URL(location.href).hash || ''); }
    catch { return base; }
  }

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
  // Only what actually moved, on BOTH sides: `aria-checked: false → true`. A key the control
  // gained or lost prints the same arrow with that side blank — the old value carries its space.
  const was = (v) => (v == null ? '' : ` ${v}`);
  const stateDiff = (before, after) => Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k}:${was(before[k])} → ${after[k] == null ? '' : after[k]}`).join(', ');

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
  function armPacket(el, action, near, value, frameHost) {
    const ctx = { action, element: elementFacts(el), near, page: pageOf() };
    if (frameHost) ctx.frame = frameHost; // the reader has to know it was not the page itself
    if (value) ctx.value = value;
    const before = { url: routeUrl(), title: ctx.page.title, state: stateOf(el), counter: counterText(el) };
    const notes = watchNotes();
    return (entry) => {
      const now = { url: routeUrl(), title: trimTo(document.title, 80), counter: counterText(el) };
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

  window.RecPacket = { AFTER_MS, armPacket, pageUrl, routeUrl, elementFacts, stateOf, stateDiff, counterText, fitPacket };
})();
