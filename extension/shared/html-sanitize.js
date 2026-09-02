// Shared HTML sanitizer (IIFE global `HtmlSanitize` + `sanitizeHtml`) — THE XSS boundary:
// TC markdown carries raw HTML, so a render is sanitized DETACHED before it hits the DOM.

const HtmlSanitize = (() => {
  // #175: <base> retargets every relative link, <meta http-equiv=refresh> navigates,
  // <link rel=preload> is an outbound fetch, <form> is a submit target.
  const DROP = 'script, style, iframe, object, embed, link, meta, base, form';
  // Two URL classes, because a nav target MOVES the user while a load only pulls bytes in.
  const NAV_ATTRS = new Set(['href', 'action', 'formaction', 'xlink:href']);
  const RES_ATTRS = new Set(['src', 'poster', 'data']);
  // Never kept: a single-URL scheme check cannot validate a document body (`srcdoc`), a
  // list of POST targets (`ping`) or a candidate list (`srcset`). Markdown emits none.
  const DROP_ATTRS = new Set(['srcdoc', 'ping', 'srcset']);
  const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

  // Allow-list by scheme through the browser's own parser: a denylist loses to `data:`,
  // `vbscript:` and entity-encoded `javascript:`. Protocol-relative `//host/x` fails too.

  // Absolute only, no base: a relative target lands on our own pages — `/handoff.json` is one.
  // A bare `#anchor` is the exception: it reaches no document, and long descriptions link to their
  // own headings with it.
  function navAllowed(value) {
    if (/^#[^#]*$/.test(String(value))) return true;
    try { return SAFE_SCHEMES.has(new URL(value).protocol); } catch { return false; }
  }

  // Same-origin stays: instance images arrive root-relative for img-hydrate.js to re-base.
  function resAllowed(value) {
    try {
      const u = new URL(value, document.baseURI);
      return SAFE_SCHEMES.has(u.protocol) || u.origin === location.origin;
    } catch { return false; }
  }

  function sanitize(container) {
    container.querySelectorAll(DROP).forEach((n) => n.remove());
    for (const el of container.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (/^on/i.test(name) || DROP_ATTRS.has(name)) el.removeAttribute(attr.name);
        if (NAV_ATTRS.has(name) && !navAllowed(attr.value)) el.removeAttribute(attr.name);
        if (RES_ATTRS.has(name) && !resAllowed(attr.value)) el.removeAttribute(attr.name);
      }
    }
    container.querySelectorAll('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  return { sanitize };
})();

// Bare global for call sites (mirrors resolveSiteTab in shared/site-tab.js).
const sanitizeHtml = HtmlSanitize.sanitize;
