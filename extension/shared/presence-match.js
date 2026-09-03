// The presence marker's match pattern (IIFE global `PresenceMatch`): which configured base URL earns
// a registered content script, and which earns none. Depends on URL and nothing else.

const PresenceMatch = (() => {
  const PRESENCE_STATIC_ORIGIN = 'https://app.testomat.io'; // static already — a second one marks twice

  function presenceMatch(baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin === PRESENCE_STATIC_ORIGIN) return null;
    return `${url.origin}/*`;
  }

  return { presenceMatch, PRESENCE_STATIC_ORIGIN };
})();
