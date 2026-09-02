// A PERSON, printed — the monogram + name cell (`.user-cell` / `.avatar` in components.css).
// The CSP allows extension images only, so a remote avatar is fetched and swapped in as `blob:`.

/* global Tooltip, TestomatAPI */
/* exported UserCell */
(() => {
  'use strict';

  // A route hands back a name, an email or a record; null for anything naming nobody.
  function normalize(user) {
    if (!user) return null;
    if (typeof user === 'string') {
      const s = user.trim();
      if (!s) return null;
      return s.includes('@') ? { name: '', email: s } : { name: s, email: '' };
    }
    if (typeof user !== 'object') return null;
    const name = String(user.name || user.username || user.title || '').trim();
    const email = String(user.email || '').trim();
    if (!name && !email) return null;
    const avatar = String(user.avatar || user['avatar-url'] || user.avatarUrl || '').trim();
    return { name, email, avatar };
  }

  // The name, else the email's local part — the same fallback the assignee chip uses.
  function displayName(user) {
    const u = normalize(user);
    if (!u) return '';
    if (u.name) return u.name;
    const at = u.email.indexOf('@');
    return at > 0 ? u.email.slice(0, at) : u.email;
  }

  // Split on non-letters first, so "j.doe" is JD and not "J."; only punctuation → '?'.
  function initials(user) {
    const words = displayName(user)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2);
    return words[0][0] + words[1][0];
  }

  // Through the API, never a bare fetch: an avatar URL is server DATA, and fetchAsset is what
  // keeps a host named there from getting a request (and the session from following it out).
  const photos = new Map(); // url → Promise<objectURL|null>

  function photo(url) {
    if (!/^https:\/\//i.test(url)) return Promise.resolve(null); // http/data/junk: no
    if (typeof TestomatAPI === 'undefined') return Promise.resolve(null); // shared file, API optional
    if (!photos.has(url)) {
      photos.set(url, TestomatAPI.fetchAsset(url, { instanceOnly: true })
        .then((r) => (r.ok && /^image\//i.test(r.headers.get('content-type') || '') ? r.blob() : null))
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch(() => null));
    }
    return photos.get(url);
  }

  // null when the value names nobody — the caller drops its whole row on that.
  function cell(user) {
    const u = normalize(user);
    if (!u) return null;
    const el = document.createElement('span');
    el.className = 'user-cell';
    const av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true'); // the name beside it is the label
    av.textContent = initials(u);
    // Nothing re-reads the DOM: a repaint that threw this cell away leaves a detached node.
    if (u.avatar) {
      photo(u.avatar).then((src) => {
        if (!src) return;
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        av.replaceChildren(img);
        av.classList.add('has-photo');
      });
    }
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = displayName(u);
    el.append(av, name);
    // Both: a list out of room drops to the circles alone (`.user-cells.is-stacked`),
    // and then the tooltip is the only label.
    const tip = [displayName(u), u.email].filter(Boolean);
    if (tip.length && typeof Tooltip !== 'undefined') Tooltip.set(el, tip.join(' · '));
    return el;
  }

  window.UserCell = { normalize, displayName, initials, cell };
})();
