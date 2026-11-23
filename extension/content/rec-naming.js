/* global CSS */

/* global window */
(() => {
  'use strict';
  // A same-document re-inject runs the file again; without this the second run throws.
  if (window.RecNaming) return;
  // Counted in code points: a cut between an emoji's halves ships half a character into the step.
  const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const trimTo = (s, n) => {
    const cp = [...oneLine(s)];
    return cp.length <= n ? cp.join('') : cp.slice(0, n).join('');
  };
  const trim40 = (s) => trimMark(s, 40);
  // A visible cut: the ellipsis takes the place of what was dropped, inside the same n.
  const trimMark = (s, n) => {
    const cp = [...oneLine(s)];
    return cp.length <= n ? cp.join('') : `${cp.slice(0, n - 1).join('').replace(/\s+$/, '')}…`;
  };

  // Decorative chrome (badge, counter, a11y-hidden, <script>): its text is never a name a tester reads.
  const BADGE_RE = /(^|[\s_-])(badge|pill|count|counter)([\s_-]|$)/i;
  const NOT_READ = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const badgeish = (el) => !!el && el.nodeType === 1
    && (NOT_READ.test(el.tagName) || el.getAttribute('aria-hidden') === 'true'
      || BADGE_RE.test(el.getAttribute('class') || ''));
  function inBadge(node, stop) {
    for (let n = node; n && n !== stop; n = n.parentElement) if (badgeish(n)) return true;
    return false;
  }

  // A field's text (a composer's, a textarea's) is what was typed: its value, never a name or a fact.
  const inField = (n) => !!n && n.nodeType === 1
    && (n.tagName === 'TEXTAREA' || n.isContentEditable === true);
  // The same fields in a detached clone, where `isContentEditable` is always false.
  const FIELD_SEL = 'textarea, [contenteditable]';
  const dropFields = (clone) => clone.querySelectorAll(FIELD_SEL).forEach((n) => {
    if (n.tagName === 'TEXTAREA' || String(n.getAttribute('contenteditable')).toLowerCase() !== 'false') n.remove();
  });
  function plainText(node) {
    if (!node || inField(node)) return '';
    if (!node.querySelector || !node.querySelector(FIELD_SEL)) return node.textContent || '';
    const clone = node.cloneNode(true);
    dropFields(clone);
    return clone.textContent || '';
  }

  // `glued` = continues the previous run with no whitespace, the sign of a concatenation.
  function textRuns(el, limit = 24) {
    const out = [];
    if (inField(el)) return out;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let gap = true; let prev = '';
    for (let n = w.nextNode(); n && out.length < limit; n = w.nextNode()) {
      if (inField(n.parentElement)) continue; // a composer inside the control
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

  // A buttonish element is often a whole card whose text concatenates into an unreadable name.
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
    const raw = plainText(el).trim();
    // One run or inline emphasis: the raw text is the name; only dropped badge text forces a rebuild.
    if (!(runs.length > 1 && (runs.some((r) => r.glued) || el.querySelector(STRUCT_SEL)))) {
      return kept.length < runs.length ? kept.map((r) => r.text).join(' ') : raw;
    }
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    const ht = h && cleanText(h);
    if (ht) return ht;
    return firstAttr(el, '[aria-label]', 'aria-label') || firstAttr(el, 'img[alt]', 'alt')
      || kept.reduce((a, r) => (r.text.length > a.length ? r.text : a), '') || raw;
  }

  // A wrapping <label> holds its control, so its text bleeds the control's own (a <select>'s options).
  function cleanLabelText(labelEl) {
    if (!labelEl || inField(labelEl)) return null;
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    dropFields(clone);
    const t = clone.textContent;
    return t && t.trim() ? t : null;
  }
  // An id belongs to one tree: inside a web component that is its shadow root, not the page.
  const rootOf = (el) => (el.getRootNode && el.getRootNode()) || document;
  const byId = (el, id) => { const r = rootOf(el); return r.getElementById ? r.getElementById(id) : null; };

  function labelText(el) {
    try {
      if (el.labels && el.labels.length) { const t = cleanLabelText(el.labels[0]); if (t) return t; }
    } catch { /* labels unsupported */ }
    const wrap = el.closest && el.closest('label');
    if (wrap) { const t = cleanLabelText(wrap); if (t) return t; }
    if (el.id) { const t = cleanLabelText(rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`)); if (t) return t; }
    return null;
  }

  // The <input> types whose value is their caption.
  const BUTTON_INPUT = /^(button|submit|reset|image)$/i;
  // Without the ARIA roles, name/id would record `Open the "tab-details" tab`.
  const isButtonish = (el) => {
    const tag = el.tagName;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY'
      || role === 'button' || !!ROLE_PHRASE[role]
      || (tag === 'INPUT' && BUTTON_INPUT.test(el.type || ''));
  };
  // Every other form field holds what the tester entered, whatever role the page gives it.
  const holdsValue = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && !BUTTON_INPUT.test(el.type || ''));

  // `fallback` (the column header) beats name/id: those are dev strings, the header is what testers see.
  function elementName(el, fallback, near) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return trim40(aria);
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      // The attribute holds a list of ids, and the name is everything they say, in that order.
      const named = labelledby.trim().split(/\s+/)
        .map((id) => { const l = byId(el, id); return l ? plainText(l).trim() : ''; })
        .filter(Boolean);
      if (named.length) return trim40(named.join(' '));
    }
    if (isButtonish(el) && !holdsValue(el)) { // a combobox input is named by its label, not its value
      const t = buttonishText(el);
      if (t) return trim40(t);
      if (el.value && String(el.value).trim()) return trim40(el.value);
    }
    const lbl = labelText(el);
    if (lbl) return trim40(lbl);
    if (el.placeholder && el.placeholder.trim()) return trim40(el.placeholder);
    if (fallback) return fallback;
    // An icon button's tooltip is the author's name for it: below visible text, above dev strings.
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return trim40(title);
    // A nameless control is named by its row/section clause, which beats writing a dev string over it.
    if (near && near.label) return trim40(near.label);
    if (near && (near.row || near.section)) return null;
    if (el.getAttribute && el.getAttribute('name')) return trim40(el.getAttribute('name'));
    if (el.id) return trim40(el.id);
    return null;
  }

  // Read at event time: the DOM has moved on by the time anyone reads the recording.
  const ROW_SEL = 'tr, li, [role=row], [role=listitem]';
  const ROW_TITLE_SEL = 'h1,h2,h3,h4,h5,h6,th,td,[role=rowheader],[role=cell],[role=gridcell],strong,b';

  // Nested controls stripped, so a cell that merely holds a control never names the row.
  function cleanText(node) {
    if (inField(node)) return null;
    const clone = node.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button, script, style, noscript, template').forEach((n) => n.remove());
    dropFields(clone);
    clone.querySelectorAll('[class], [aria-hidden]').forEach((n) => { if (badgeish(n)) n.remove(); }); // a counter is not text
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }

  // Prices, dates and glyphs are noise; bare digits count, or ten rows' Delete buttons read alike.
  const worded = (t) => !!t && t.length >= 2 && /\p{L}/u.test(t);
  const numeric = (t) => !!t && /^\d{2,}$/.test(t);
  const titleish = (t) => worded(t) || numeric(t);

  // A counter the page wrote no class on ("Products (12)") goes stale the moment the count moves.
  const dropCount = (t) => (t ? t.replace(/\s*\(\s*\d[\d.,]*\s*\)$/, '').trim() : t);

  // A number-only cell is a title of last resort: any worded cell in the row reads better.
  function rowTitle(row) {
    let keyed = null;
    for (const n of row.querySelectorAll(ROW_TITLE_SEL)) {
      const t = dropCount(cleanText(n));
      if (!titleish(t) || inBadge(n, row)) continue;
      if (worded(t)) return trim40(t);
      keyed = keyed || trim40(t);
    }
    if (keyed) return keyed;
    const own = dropCount(cleanText(row));
    return titleish(own) && own.length <= 60 ? trim40(own) : null;
  }

  // The walk is bounded (8 ancestors × 12 siblings): a full-DOM sweep per click is not worth a clause.
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
        // A block between us and the heading is a peer card, and a heading past it heads that card too.
        if (sib.children && sib.children.length) break;
      }
    }
    return null;
  }

  // A colspan makes a cell's index and its column differ, so both rows are counted in spans.
  const spanOf = (c) => Math.max(1, parseInt(c.getAttribute('colspan'), 10) || 1);
  function columnAt(row, cell) {
    let col = 0;
    for (const c of row.cells) { if (c === cell) return col; col += spanOf(c); }
    return -1;
  }
  function coveringCell(row, col) {
    let at = 0;
    for (const c of row.cells) { at += spanOf(c); if (col >= 0 && col < at) return c; }
    return null;
  }

  function columnTitle(el) {
    const cell = el.closest && el.closest('td, th');
    if (!cell || cell.tagName === 'TH') return null;
    const table = cell.closest('table');
    const head = table && (table.tHead ? table.tHead.rows[0] : table.rows[0]);
    if (!head || head === cell.parentElement) return null;
    const th = coveringCell(head, columnAt(cell.parentElement, cell));
    if (!th || th.tagName !== 'TH') return null;
    const t = cleanText(th);
    return t ? trim40(t) : null;
  }

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

  // Read once per action: the sentence's clause and the packet's `near` share these DOM walks.
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

  // A control unnamed by itself borrows its column header: to the tester that is its name.
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

  // One clause per step: row first, section as fallback; the column already named the control.
  const clauseOf = (ctx) => (!ctx ? ''
    : ctx.row ? ` in the "${ctx.row}" row`
      : ctx.section ? ` in the "${ctx.section}" section` : '');


  // Each role gets the verb a tester would write by hand; a nameless control keeps the bare-noun form.
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
    link: (n) => (n ? `Click the "${n}" link` : 'Click the link'),
    combobox: (n) => (n ? `Open the "${n}" dropdown` : 'Open the dropdown'),
    listbox: (n) => (n ? `Open the "${n}" list` : 'Open the list'),
    slider: (n) => (n ? `Click the "${n}" slider` : 'Click the slider'),
    spinbutton: (n) => (n ? `Click the "${n}" spinner` : 'Click the spinner'),
    treeitem: (n) => (n ? `Select "${n}" in the tree` : 'Select the tree item'),
    gridcell: (n) => (n ? `Click the "${n}" cell` : 'Click the cell'),
  };
  const ROLE_NOUN = {
    tab: 'tab', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item',
    option: 'option', checkbox: 'checkbox', switch: 'switch', radio: 'option', button: 'button',
    link: 'link', combobox: 'dropdown', listbox: 'list', slider: 'slider',
    spinbutton: 'spinner', treeitem: 'tree item', gridcell: 'cell',
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
    trimTo, trim40, trimMark, badgeish, inBadge, inField, plainText, textRuns, firstAttr, labelText,
    elementName, cleanText, rowTitle, sectionTitle, columnTitle, headingOf, siblingsOf,
    nearFacts, nameOf, contextOf, clauseOf, roleOf, clickPhrase, ROLE_PHRASE, ROLE_NOUN,
  };
})();
