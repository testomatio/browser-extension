// Markdown section arithmetic (IIFE global `MdSections`). The recorder writes into a body a
// tester already wrote, so a section is SPLICED, never re-emitted from a parse: prose, images,
// code fences, `1)` numbering and second-level bullets are what the tester put there and come
// back out byte for byte. Pure data in, markdown out — no DOM, no editor state, so `node --test`
// covers it (tests/md-sections.test.mjs).
//
// An item is `{text, subs}` plus the positions a splice needs; `subs` are the indented
// `- Expected: …` lines under it (#78). Ordered items are `N.` or `N)`, bullets `-`, `*`, `+`.

const MdSections = (() => {
  // `\r?$`: a body saved with CRLF keeps its steps — `.` does not match the `\r` a split on `\n`
  // leaves behind, while HEAD_RE's `\s*$` swallows it, so the heading was found and its items lost.
  const ITEM_RE = /^(\s*)(?:(\d+)([.)])|([-*+]))\s+(.*\S.*)\r?$/;
  const SUB_RE = /^\s{2,}[-*+]\s+(.*\S.*)\r?$/; // indented bullet = a sub-line of the item above
  const HEAD_RE = /^#{1,6}\s+\S/;
  const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Whatever sits inside ``` or ~~~ is prose: a `- flag` line there is not a step to be
  // numbered, and a `# note` is not the heading that ends the section.
  function fencedLines(lines) {
    const out = new Array(lines.length).fill(false);
    let open = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FENCE_RE);
      if (open) {
        out[i] = true;
        if (m && m[1][0] === open.char && m[1].length >= open.len && !m[2].trim()) open = null;
        continue;
      }
      // A backtick fence's info string cannot itself hold a backtick — that is an inline span.
      if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue;
      open = { char: m[1][0], len: m[1].length };
      out[i] = true;
    }
    return out;
  }

  // Indent to THIS item's content column or the sub-list starts a new top-level list instead
  // of nesting (`10.` needs one space more than `9.`).
  const subPad = (indent, marker) => `${indent}${' '.repeat(marker.length + 1)}`;

  // `opts.ordered` decides an EMPTY section only; a section that already has a list keeps its
  // own shape, so bullets stay bullets and `1)` continues as `2)`.
  function styleOf(items, opts) {
    const last = items[items.length - 1];
    if (!last) return { ordered: !!(opts && opts.ordered), bullet: '-', delim: '.', indent: '', start: 1 };
    const ordered = last.number !== null;
    return {
      ordered,
      bullet: ordered ? '-' : last.marker,
      delim: ordered ? last.marker.slice(-1) : '.',
      indent: last.indent,
      start: ordered ? last.number + 1 : 1,
    };
  }

  function render(items, style) {
    const out = [];
    (items || []).forEach((it, i) => {
      const marker = style.ordered ? `${style.start + i}${style.delim}` : style.bullet;
      out.push(`${style.indent}${marker} ${it.text}`);
      (it.subs || []).forEach((s) => out.push(`${subPad(style.indent, marker)}- ${s}`));
    });
    return out;
  }

  /**
   * The section as data: `{ lines, hIdx, end, items, style }`. `hIdx === -1` = no such heading
   * yet; `end` is the line the section stops at (the next heading, or past the last line). Each
   * item carries `line`/`endLine`/`subLines` — the positions a splice writes between.
   */
  function slice(md, heading, opts) {
    const lines = String(md == null ? '' : md).split('\n');
    const fenced = fencedLines(lines);
    const hRe = new RegExp(`^#{1,6}\\s+${escapeRe(heading)}\\s*$`, 'i');
    const hIdx = lines.findIndex((l, i) => !fenced[i] && hRe.test(l));
    if (hIdx === -1) return { lines, hIdx, end: -1, items: [], style: styleOf([], opts) };
    let end = lines.length;
    for (let i = hIdx + 1; i < lines.length; i++) { if (!fenced[i] && HEAD_RE.test(lines[i])) { end = i; break; } }
    const items = [];
    for (let i = hIdx + 1; i < end; i++) {
      if (fenced[i]) continue;
      const last = items[items.length - 1];
      const sub = lines[i].match(SUB_RE);
      if (sub && last) { last.subs.push(sub[1]); last.subLines.push(i); last.endLine = i; continue; }
      const m = lines[i].match(ITEM_RE);
      if (!m) continue;
      items.push({
        text: m[5],
        subs: [],
        line: i,
        endLine: i,
        subLines: [],
        marker: m[2] ? `${m[2]}${m[3]}` : m[4],
        indent: m[1],
        number: m[2] ? parseInt(m[2], 10) : null,
      });
    }
    return { lines, hIdx, end, items, style: styleOf(items, opts) };
  }

  const itemsOf = (md, heading, opts) => slice(md, heading, opts).items;
  const hasItems = (md, heading, opts) => slice(md, heading, opts).items.length > 0;

  /** The body with `items` spliced into the section; `opts` is `{ordered, leadSubs}`. */
  function insert(md, heading, items, opts) {
    const list = items || [];
    const leadSubs = (opts && opts.leadSubs) || [];
    const cut = slice(md, heading, opts);
    if (!list.length && !(leadSubs.length && cut.items.length)) return md;
    // No such heading: the block is appended, and only here does a tail trim survive — it
    // decides where the new section joins the document.
    if (cut.hIdx === -1) {
      const block = [`### ${heading}`, '', ...render(list, cut.style)];
      return `${String(md).replace(/\s+$/, '')}\n\n${block.join('\n')}`;
    }
    const lines = cut.lines.slice();
    const last = cut.items[cut.items.length - 1];
    if (last) {
      // `leadSubs` (#160) belong to the LAST item already in the section: live insertion
      // delivers an expected result after the step it followed is already in the body.
      const lead = leadSubs.map((s) => `${subPad(last.indent, last.marker)}- ${s}`);
      lines.splice(last.endLine + 1, 0, ...lead, ...render(list, cut.style));
      return lines.join('\n');
    }
    // No items: the steps go at the END of the section, under whatever prose, image or fence
    // the tester wrote there, and the section's own trailing blanks stay where they are.
    let at = cut.end;
    while (at > cut.hIdx + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, '', ...render(list, cut.style));
    return lines.join('\n');
  }

  /**
   * The polish rewrite (#23), in place: 1:1 by index over the `count` items starting at `start`
   * — polished item N replaces recorded item N, keeping that item's own marker and indent. An
   * item whose text is no longer what we last wrote there (`written`) was edited by hand and is
   * left exactly as it is; so is one the answer has nothing for.
   */
  function replaceItems(md, heading, opts, spec) {
    const { start, count, next, written } = spec || {};
    const cut = slice(md, heading, opts);
    const items = [];
    if (cut.hIdx === -1 || !(start >= 0)) return { md, items, touched: 0 };
    const put = new Map();
    const drop = new Set();
    let touched = 0;
    for (let i = 0; i < count; i++) {
      const it = cut.items[start + i];
      if (!it) { items.push(null); continue; } // the tester deleted it — hold the numbering
      const want = next && next[i];
      const ours = (written && written[i] && written[i].text) || null;
      let text = it.text;
      let subs = (it.subs || []).slice();
      if (want && it.text === ours) {
        text = want.text;
        // Rewritten only when the answer HAS subs: an expected result the recorder folded in
        // is not something a silent answer may drop.
        const fresh = want.subs && want.subs.length ? want.subs.slice() : null;
        if (fresh) subs = fresh.slice();
        const own = `${it.indent}${it.marker} ${text}`;
        const pad = subPad(it.indent, it.marker);
        put.set(it.line, fresh ? [own, ...fresh.map((s) => `${pad}- ${s}`)] : [own]);
        if (fresh) it.subLines.forEach((n) => drop.add(n));
        touched++;
      }
      items.push({ text, subs: subs.slice() });
    }
    if (!touched) return { md, items, touched };
    const out = [];
    cut.lines.forEach((l, i) => {
      if (drop.has(i)) return;
      const rep = put.get(i);
      if (rep) out.push(...rep);
      else out.push(l);
    });
    return { md: out.join('\n'), items, touched };
  }

  return { slice, items: itemsOf, hasItems, insert, replaceItems };
})();
