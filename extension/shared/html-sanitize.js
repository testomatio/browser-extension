// Shared HTML sanitizer (IIFE global `HtmlSanitize` + `sanitizeHtml`) — THE XSS boundary:
// TC markdown carries raw HTML, so a render is sanitized DETACHED before it hits the DOM.

const HtmlSanitize = (() => {
  // #175: <base> retargets every relative link, <meta http-equiv=refresh> navigates,
  // <link rel=preload> is an outbound fetch, <form> is a submit target.
  const DROP = 'script, style, iframe, object, embed, link, meta, base, form';
  // Every attribute a browser will resolve as a URL, not just href/src (#175).
  const URL_ATTRS = new Set(['href', 'src', 'formaction', 'action', 'xlink:href', 'data', 'poster']);
  // Never kept: a single-URL scheme check cannot validate a document body (`srcdoc`), a
  // list of POST targets (`ping`) or a candidate list (`srcset`). Markdown emits none.
  const DROP_ATTRS = new Set(['srcdoc', 'ping', 'srcset']);
  const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

  // Allow-list by scheme through the browser's own parser: a denylist loses to `data:`,
  // `vbscript:` and entity-encoded `javascript:`. Protocol-relative `//host/x` fails too.
  function urlAllowed(value) {
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
        if (URL_ATTRS.has(name) && !urlAllowed(attr.value)) el.removeAttribute(attr.name);
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
