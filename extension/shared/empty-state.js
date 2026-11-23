// Load after shared/icons.js, which draws the mark; the shape lives in shared/components.css.

/* exported EmptyState */
(() => {
  'use strict';

  // The box changes size between the two states, so the glyph in it has to as well.
  const ICON_BLOCK = 24;
  const ICON_COMPACT = 16;

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  // A string, a node, or a list of either: a few states carry a link in the sentence.
  function fill(node, content) {
    const parts = Array.isArray(content) ? content : [content];
    for (const part of parts) {
      if (part == null || part === '') continue;
      node.append(typeof part === 'string' ? document.createTextNode(part) : part);
    }
    return node;
  }

  // `live` is what stops a filtered list going empty from being silent to a reader.
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

    // Drawn even for a text-only state: it keeps the sentence in a column beside the mark.
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

  function into(host, opts) {
    if (!host) return null;
    const node = build({ tag: host.tagName === 'UL' || host.tagName === 'OL' ? 'li' : 'div', ...opts });
    host.replaceChildren(node);
    return node;
  }

  window.EmptyState = { build, into };
})();
