// Shared HTML sanitizer (IIFE global `HtmlSanitize` + `sanitizeHtml`). THE XSS
// boundary of this extension: every `showdown` render is injected with
// innerHTML, so it passes through here before it reaches a live document — the
// panel's step renderer (sidepanel/screens/test-view.js) and the editor's
// markdown preview (editor/editor.js), both of which now render through
// shared/markdown.js, whose `render()` is the one caller of this file.
// Test-case content is authored in Testomat and can carry raw HTML.
//
// It mutates `container` in place, after the untrusted HTML is parsed into a
// DETACHED <div> and before that div's children are moved into the document:
//   1. drop script/style/iframe/object/embed/link/meta/base/form nodes outright;
//   2. strip every on* handler attribute, the multi-URL attributes outright, and
//      every URL attribute whose scheme is not http/https/mailto (or relative);
//   3. force links to target=_blank rel=noopener.
// Anything not listed stays — the goal is safe rendering of TC markdown, not a
// whitelist. Both call sites had a verbatim copy of this until cycle D; keep it
// in one place so a fix cannot land on only one of them.
//
// Zero-build classic script (MV3 CSP: no inline scripts), same plain-IIFE-global
// style as shared/site-tab.js; loaded via <script> before its callers.

const HtmlSanitize = (() => {
  // #175: <base> retargets every relative link in the document, <meta
  // http-equiv=refresh> navigates it, <link rel=preload/stylesheet> is an
  // outbound fetch and <form> gives page-authored markup a submit target.
  const DROP = 'script, style, iframe, object, embed, link, meta, base, form';
  // Every attribute a browser will resolve as a URL, not just href/src (#175).
  const URL_ATTRS = new Set(['href', 'src', 'formaction', 'action', 'xlink:href', 'data', 'poster']);
  // Never kept, because a single-URL scheme check cannot honestly validate them:
  // `srcdoc` is a whole document body, `ping` a space-separated list of POST
  // targets, `srcset` a comma-separated candidate list. Markdown emits none.
  const DROP_ATTRS = new Set(['srcdoc', 'ping', 'srcset']);
  const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

  // Allow-list by scheme, resolved by the browser's own URL parser against the
  // REAL base — a denylist loses to `data:`, `vbscript:` and to entity/control-
  // character `javascript:` forms the parser still resolves. A relative value
  // lands on our own origin and passes; a protocol-relative `//host/x` does not,
  // which is the point.
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
