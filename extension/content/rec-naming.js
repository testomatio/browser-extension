// How a step names the thing the tester acted on: aria-label, the id it points at, the control's
// own text, its label, its placeholder, its column header, name/id — then the row or section clause.

/* global CSS */

/* global window */
(() => {
  'use strict';
  // Injected on demand, and a same-document re-inject runs the file again: without this the
  // second run throws before the recorder's own latch is ever reached.
  if (window.RecNaming) return;
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

  window.RecNaming = {
    trimTo, trim40, badgeish, inBadge, textRuns, firstAttr, labelText, elementName,
    cleanText, rowTitle, sectionTitle, columnTitle, headingOf, siblingsOf,
    nearFacts, nameOf, contextOf, clauseOf, roleOf, clickPhrase, ROLE_PHRASE, ROLE_NOUN,
  };
})();
