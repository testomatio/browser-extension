// A PERSON, printed — the round monogram plus the name that every surface
// naming somebody uses (Run info's "Executed by" / "Created by" / "Assigned
// to"). The box, the circle and the truncation live in components.css
// (`.user-cell` / `.avatar`); this file is what turns whatever the API said
// about a person into it.
//
// The initials are the FLOOR, not the ceiling: the panel's CSP allows images
// from the extension only (`img-src 'self' data: blob:`), so a remote avatar
// URL in an <img> renders as a broken box — but a fetched image handed back as
// a `blob:` URL is the extension's own, and that the CSP allows. So a cell with
// a photo behind it draws the monogram first and swaps the picture in when it
// arrives; a cell without one, or whose fetch is refused (a host that sends no
// CORS header, a 404, an avatar behind a login), simply keeps the monogram.
// Nothing waits on the network to render, and nothing breaks when it fails.
//
// Zero-build classic script (MV3 CSP: no inline scripts) — exposes one global.

/* global Tooltip */
/* exported UserCell */
(() => {
  'use strict';

  // What the API can hand us for a person differs per route — a name, an email,
  // or a record with both — so one reader normalizes all of them to
  // `{name, email}` and answers null for anything that names nobody.
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
    // The picture is optional and read as loosely as the name: whichever key the
    // route spells it with, absent when nobody said.
    const avatar = String(user.avatar || user['avatar-url'] || user.avatarUrl || '').trim();
    return { name, email, avatar };
  }

  // What to CALL them: the name when there is one, else the email's local part
  // — the same degraded fallback the assignee chip uses, so one person is not
  // "T. Khomenko" on one line and "tetiana" on the next by accident.
  function displayName(user) {
    const u = normalize(user);
    if (!u) return '';
    if (u.name) return u.name;
    const at = u.email.indexOf('@');
    return at > 0 ? u.email.slice(0, at) : u.email;
  }

  // Up to two letters off the display name: first letters of the first two
  // words ("Tetiana Khomenko" → TK), or the first two characters of a single
  // word ("tetiana" → TE). Non-letters are dropped first so "j.doe" is JD and
  // not "J." — and a name that is only punctuation falls back to a person glyph
  // stand-in rather than an empty circle.
  function initials(user) {
    const words = displayName(user)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2);
    return words[0][0] + words[1][0];
  }

  // The PHOTO, as something the panel is allowed to show: the remote image
  // fetched once and kept as a `blob:` URL. One promise per URL — a run info
  // list, a checklist and a dropdown all naming the same tester share the one
  // request — and `null` for every way it can fail, which the caller reads as
  // "keep the monogram".
  // Cookies are deliberately NOT sent (`credentials: 'omit'`): this is a request
  // to whatever host the API named, up to and including a third-party avatar CDN,
  // and a panel that quietly forwarded the session to one would be a leak. An
  // avatar that needs the login is one the panel does without.
  const photos = new Map(); // url → Promise<objectURL|null>

  function photo(url) {
    if (!/^https:\/\//i.test(url)) return Promise.resolve(null); // http/data/junk: no
    if (!photos.has(url)) {
      photos.set(url, fetch(url, { credentials: 'omit', cache: 'force-cache' })
        .then((r) => (r.ok && /^image\//i.test(r.headers.get('content-type') || '') ? r.blob() : null))
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch(() => null));
    }
    return photos.get(url);
  }

  // The cell itself. `null` when the value names nobody — a caller drops its
  // whole row on that, exactly as an empty Run info field is skipped.
  // The full email rides on the tooltip when there is one: the panel truncates
  // long names, and "who exactly" has to stay reachable.
  function cell(user) {
    const u = normalize(user);
    if (!u) return null;
    const el = document.createElement('span');
    el.className = 'user-cell';
    const av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true'); // the name beside it is the label
    av.textContent = initials(u);
    // …and the picture over it once (if) it resolves. The cell is already in the
    // caller's hands by then — a repaint that threw this one away just leaves a
    // detached node to collect, which is why nothing here re-reads the DOM.
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
    // Who, then which address — BOTH, because the name beside the monogram is not
    // always there to read: a list that has run out of room drops to the circles
    // alone (`.user-cells.is-stacked`), and then the tooltip is the only label.
    const tip = [displayName(u), u.email].filter(Boolean);
    if (tip.length && typeof Tooltip !== 'undefined') Tooltip.set(el, tip.join(' · '));
    return el;
  }

  window.UserCell = { normalize, displayName, initials, cell };
})();
