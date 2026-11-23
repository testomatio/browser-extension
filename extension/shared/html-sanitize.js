// The XSS boundary: test markdown carries raw HTML, so a render is sanitized detached from the DOM.

const HtmlSanitize = (() => {
  // <base> retargets links, meta refresh navigates, link preload fetches, <form> is a submit target.
  const DROP = 'script, style, iframe, object, embed, link, meta, base, form';
  // Two URL classes, because a nav target moves the user while a load only pulls bytes in.
  const NAV_ATTRS = new Set(['href', 'action', 'formaction', 'xlink:href']);
  const RES_ATTRS = new Set(['src', 'poster', 'data']);
  // A single-URL scheme check cannot validate `srcdoc`, `ping` or `srcset`; markdown emits none.
  const DROP_ATTRS = new Set(['srcdoc', 'ping', 'srcset']);
  const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

  // Scheme allow-list via the URL parser: a denylist loses to data:, vbscript: and encoded javascript:.

  // Absolute only: a relative target lands on our own pages; a bare #anchor reaches no document.
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

const sanitizeHtml = HtmlSanitize.sanitize;
