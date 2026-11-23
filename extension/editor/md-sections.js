// Sections are spliced, never re-emitted from a parse, so the tester's text comes back byte for byte.

const MdSections = (() => {
  // `\r?$`: `.` does not match the `\r` a split on `\n` leaves, so CRLF bodies would lose their steps.
  const ITEM_RE = /^(\s*)(?:(\d+)([.)])|([-*+]))\s+(.*\S.*)\r?$/;
  const SUB_RE = /^\s{2,}[-*+]\s+(.*\S.*)\r?$/; // indented bullet = a sub-line of the item above
  const HEAD_RE = /^#{1,6}\s+\S/;
  const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Copied in shared/markdown.js: the panel never loads this file, and this one must not need showdown.
  const STEPS_HEADING = /step|крок/i;

  // Fenced text is prose: a `- flag` there is not a step, and a `# note` does not end the section.
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

  // Indent to this item's content column (`10.` needs a space more than `9.`) or the sub-list un-nests.
  const subPad = (indent, marker) => `${indent}${' '.repeat(marker.length + 1)}`;

  // `opts.ordered` only decides an empty section; an existing list keeps its own markers.
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

  /** The body's own name for a section matching `re`, trimmed the way `slice` looks for it, or null. */
  function findHeading(md, re) {
    const lines = String(md == null ? '' : md).split('\n');
    const fenced = fencedLines(lines);
    for (let i = 0; i < lines.length; i++) {
      if (fenced[i] || !HEAD_RE.test(lines[i])) continue;
      const text = lines[i].replace(/^#{1,6}\s+/, '').replace(/\s+$/, '');
      if (re.test(text)) return text;
    }
    return null;
  }

  /** `{ lines, hIdx, end, items, style }`; `hIdx === -1` means no such heading yet. */
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
    // No such heading: append; only here may the tail be trimmed, as it decides where the section joins.
    if (cut.hIdx === -1) {
      const block = [`### ${heading}`, '', ...render(list, cut.style)];
      // `cut.lines` is the body slice() normalised: a missing one joins onto '', not onto "null".
      return `${cut.lines.join('\n').replace(/\s+$/, '')}\n\n${block.join('\n')}`;
    }
    const lines = cut.lines.slice();
    const last = cut.items[cut.items.length - 1];
    if (last) {
      // `leadSubs` go to the last item already there: an expected result arrives after its step.
      const lead = leadSubs.map((s) => `${subPad(last.indent, last.marker)}- ${s}`);
      lines.splice(last.endLine + 1, 0, ...lead, ...render(list, cut.style));
      return lines.join('\n');
    }
    // No items: steps go under the tester's prose at the section end, before its trailing blanks.
    let at = cut.end;
    while (at > cut.hIdx + 1 && !lines[at - 1].trim()) at--;
    // With no step above, an expected result describes the step that follows.
    const head = leadSubs.length
      ? [{ ...list[0], subs: [...leadSubs, ...(list[0].subs || [])] }, ...list.slice(1)]
      : list;
    lines.splice(at, 0, '', ...render(head, cut.style));
    return lines.join('\n');
  }

  /** Polish rewrite: item N replaces item N in place; one edited by hand (not `written`) stays. */
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
        // Subs change only if the answer has some: silence must not drop an expected result we folded in.
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

  return { STEPS_HEADING, findHeading, slice, items: itemsOf, hasItems, insert, replaceItems };
})();
