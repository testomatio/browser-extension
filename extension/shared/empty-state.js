// Empty states (IIFE global `EmptyState`): the one builder for every place in
// this extension that has nothing to show.
//
// It is the twin of core/skeleton.js. That one draws content that has not
// ARRIVED; this one draws content that is not THERE — and until now the panel
// answered the second with the tools it had for neither: a muted 12px line
// ("No runs in this project yet.", "No reported steps", "No runs loaded for
// this group.") left alone in a container the size of the whole screen. Nine
// screens had written that line nine different ways, three of them with a
// hand-rolled title/hint/actions stack of their own.
//
// So the SHAPE lives in shared/components.css (the EMPTY section) and the
// assembly lives here, and a screen only supplies the four things that are
// actually its own:
//
//   icon    which Material Symbol says what is missing
//   title   what is not here
//   text    why, and what to do about it — a string, or nodes when the sentence
//           carries a link
//   actions the way out: buttons/links the screen builds itself, because only
//           the screen knows what its way out is
//
// Everything else is a decision the component has already made. A caller picks
// `compact` when the nothing is small (a line inside a full screen) rather than
// a whole view; that choice is argued for in the stylesheet, not here. The mark
// itself is never a choice — it is muted in every state.
//
// Zero-build classic script (MV3 CSP), loaded by BOTH the panel and the editor,
// after shared/icons.js — it draws its mark from it.

/* exported EmptyState */
(() => {
  'use strict';

  // The mark's icon is drawn at 24 in the block state and at the panel's own
  // control-icon size in the compact one — the box is what changes, so the
  // glyph inside it has to change with it or a 16px icon rattles around in a
  // 48px square.
  const ICON_BLOCK = 24;
  const ICON_COMPACT = 16;

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  // A string, a node, or a list of either — the sentence is prose in most
  // states and prose-with-a-link in a few ("Start one in the web app"), and a
  // caller should not have to know which shape this wants.
  function fill(node, content) {
    const parts = Array.isArray(content) ? content : [content];
    for (const part of parts) {
      if (part == null || part === '') continue;
      node.append(typeof part === 'string' ? document.createTextNode(part) : part);
    }
    return node;
  }

  // Build one. `tag` is 'div' by default and 'li' when the state is the only
  // child of a list — see the note in the stylesheet about a <div> inside a
  // <ul>. `live` marks it as the screen's own announcement, for the states that
  // took over a message a status line used to carry: without it a filtered list
  // going empty is silent to a screen reader.
  function build({
    icon,
    title,
    text,
    actions,
    compact = false,
    tag = 'div',
    className = '',
    id = '',
    live = false,
  } = {}) {
    const box = el(tag, `empty${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`);
    if (id) box.id = id;
    if (live) box.setAttribute('role', 'status');

    if (icon && window.Icons) {
      const mark = el('span', 'empty-mark');
      const svg = window.Icons.el(icon, compact ? ICON_COMPACT : ICON_BLOCK);
      if (svg) { mark.append(svg); box.append(mark); }
    }

    // The body is drawn even for a text-only state (the compact ones usually
    // are): it is what keeps the sentence in a column beside the mark instead
    // of on the same baseline as it.
    if (title || text) {
      const body = el('div', 'empty-body');
      if (title) body.append(fill(el('p', 'empty-title'), title));
      if (text) body.append(fill(el('p', 'empty-text'), text));
      box.append(body);
    }

    const list = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
    if (list.length) box.append(fill(el('div', 'empty-actions'), list));
    return box;
  }

  // Replace a container's contents with one. The common call — a render that
  // found no rows clears the list and puts this in its place — and it picks the
  // tag for the caller, since the container is right there to be asked.
  function into(host, opts) {
    if (!host) return null;
    const node = build({ tag: host.tagName === 'UL' || host.tagName === 'OL' ? 'li' : 'div', ...opts });
    host.replaceChildren(node);
    return node;
  }

  window.EmptyState = { build, into };
})();
