// `img-src` carries no `https:` by design, so image bytes are fetched and shown via a `blob:` URL.

/* global TestomatAPI, Icons */
/* exported ImgHydrate */
(() => {
  'use strict';

  const groups = new Map(); // group name → object URLs it minted

  function track(group, url) {
    const list = groups.get(group) || [];
    list.push(url);
    groups.set(group, list);
  }

  function release(group) {
    for (const u of groups.get(group) || []) {
      try { URL.revokeObjectURL(u); } catch { /* already revoked */ }
    }
    groups.set(group, []);
  }

  // The e2e reads it to prove a teardown released them; the panel never needs it.
  const held = (group) => (groups.get(group) || []).length;

  // Signed out, the attachment route answers 200 with the sign-in page; octet-stream still passes.
  function looksLikeImage(type) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    return !t || t === 'application/octet-stream' || t.startsWith('image/');
  }

  // Answers true/false rather than throwing — each caller's failure path is different UI.
  async function load(group, url, img, opts) {
    try {
      const res = await TestomatAPI.fetchAsset(url, opts);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!looksLikeImage(blob.type)) throw new Error(blob.type || 'not an image');
      const objectUrl = URL.createObjectURL(blob);
      track(group, objectUrl);
      img.src = objectUrl;
      img.dataset.loaded = 'true'; // what the e2e waits on
      return true;
    } catch {
      return false;
    }
  }

  // Inside an existing link the fallback is a span: browsers drop an <a> nested in an <a>.
  function fallback(img, url) {
    const inLink = !!img.closest('a');
    const el = document.createElement(inLink || !url ? 'span' : 'a');
    el.className = 'img-fallback';
    if (el.tagName === 'A') {
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    el.append(img.getAttribute('alt') || 'Open image');
    if (typeof Icons !== 'undefined') el.append(Icons.el('open_in_new', 12));
    el.title = url || '';
    return el;
  }

  // Run it detached, after sanitizeHtml(): a raw src in the document misresolves or trips the CSP.
  function hydrate(group, container) {
    if (!container) return;
    for (const img of [...container.querySelectorAll('img[src]')]) {
      const raw = img.getAttribute('src');
      if (/^(blob|data):/i.test(raw)) continue; // already ours to draw
      img.removeAttribute('src');
      // `![]()` names nothing, and resolving it lands on the instance root.
      if (!raw.trim()) { img.replaceWith(fallback(img, '')); continue; }
      img.dataset.img = 'loading'; // a placeholder box, not a zero-height nothing
      const url = TestomatAPI.assetUrl(raw);
      // Off-instance images in authored markdown are tracking beacons: never fetched, shown as a link.
      load(group, url, img, { instanceOnly: true }).then((ok) => {
        if (ok) delete img.dataset.img;
        else img.replaceWith(fallback(img, url));
      });
    }
  }

  window.ImgHydrate = { hydrate, load, release, held };
})();
