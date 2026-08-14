// Images in test CONTENT, shown despite a CSP that allows no remote <img>
// (#205). One copy of the fetch → blob → <img> swap for every surface that
// shows one: the test view's description, the editor's Preview, a reported
// step's screenshot and the result's attachment list.
//
// `img-src 'self' data: blob:` carries no `https:` BY DESIGN (#175/#179) and is
// deliberately NOT widened here. So the bytes are fetched instead — `connect-src`
// does allow https: — and the <img> is handed a `blob:` URL of its own, which is
// the extension's and which the CSP allows. shared/user-cell.js plays the same
// trick for an avatar; before this file, the description simply rendered BLANK
// while the web showed the image.
//
// What is NOT fetched: an image in authored markdown that points off the
// configured instance. That is a tracking beacon planted in a test — `img-src` was
// declared to stop it (the e2e suite pins the refusal) and constitution
// IV allows exactly one host — so it is refused before any request and shown as
// a link instead. Attachment thumbnails are the other case and are not
// restricted: their URL comes from an authenticated API payload, i.e. the
// product named it (a presigned bucket link is the normal shape).
//
// Two things the naive version gets wrong, both measured on prod (#205):
//   * the src is dropped BEFORE the node reaches the document. A description
//     image is often ROOT-RELATIVE (`/rails/active_storage/blobs/redirect/…`),
//     and left alone the document resolves that against `chrome-extension://`
//     and 404s it; a remote one just trips the CSP. Neither is ours to show.
//   * a 200 is not an image. The app-host attachment route answers a signed-out
//     fetch with the sign-in PAGE (302 → 200 text/html) — swapping that in would
//     be the blank box again, with a load that "worked".
// Where the URL points and whether the session token goes with it is
// TestomatAPI.fetchAsset's decision, not this file's.
//
// Object URLs are owned per GROUP — a caller names one ('test-description',
// 'editor-preview', 'summary-shots', 'result-attachments') and releases it when
// the container it painted goes away, so a long marking session doesn't leak one
// blob per screenshot it scrolled past.
//
// Zero-build classic script (MV3 CSP: no inline scripts), same plain-IIFE-global
// style as shared/html-sanitize.js; loaded after api.js and icons.js.

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

  // How many URLs a group is holding — the e2e reads it to prove a teardown
  // released them, and nothing in the panel needs it otherwise.
  const held = (group) => (groups.get(group) || []).length;

  // An image, and not merely something that came back 200 (see the header).
  // An empty type and `application/octet-stream` still pass: some artifact
  // hosts serve real images that way and the browser sniffs them fine.
  function looksLikeImage(type) {
    const t = String(type || '').toLowerCase().split(';')[0].trim();
    return !t || t === 'application/octet-stream' || t.startsWith('image/');
  }

  // Fetch `url` and point `img` at a blob of it. Answers true/false rather than
  // throwing: every caller's failure path is a different piece of UI (a link, a
  // name row), and none of them is an error the tester has to be told about.
  async function load(group, url, img, opts) {
    try {
      const res = await TestomatAPI.fetchAsset(url, opts);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!looksLikeImage(blob.type)) throw new Error(blob.type || 'not an image');
      const objectUrl = URL.createObjectURL(blob);
      track(group, objectUrl);
      img.src = objectUrl;
      img.dataset.loaded = 'true'; // what the e2e waits on (#202)
      return true;
    } catch {
      return false;
    }
  }

  // What a broken image leaves behind: the way OUT to it, never a silent blank.
  // Inside an existing link (`[![alt](img)](href)`) it is a plain span — the
  // anchor around it is already the way out, and an <a> inside an <a> is not
  // markup any browser keeps.
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

  // Every image in a rendered-markdown container, swapped for one the panel is
  // allowed to draw. Call it on the DETACHED container, between sanitizeHtml()
  // and the append: the raw src must never reach the document (see the header).
  //
  // `instanceOnly` is the whole reason this is not just "fetch what the markdown
  // says": a description is AUTHORED content, so an image in it that points
  // somewhere else is a tracking beacon by another name — the thing `img-src` was
  // declared to refuse (the e2e suite asserts it) and the thing constitution IV's
  // single egress forbids. It is never fetched; it becomes the link below, which
  // opens in an ordinary tab where the browser's own rules apply. Every image
  // the product itself embeds is an instance URL (measured, #205), so this costs
  // the real cases nothing.
  function hydrate(group, container) {
    if (!container) return;
    for (const img of [...container.querySelectorAll('img[src]')]) {
      const raw = img.getAttribute('src');
      if (/^(blob|data):/i.test(raw)) continue; // already ours to draw
      img.removeAttribute('src');
      // `![]()` names nothing, and resolving that lands on the instance ROOT —
      // a pointless request answered with a page. It is unloadable by definition.
      if (!raw.trim()) { img.replaceWith(fallback(img, '')); continue; }
      img.dataset.img = 'loading'; // a placeholder box, not a zero-height nothing
      const url = TestomatAPI.assetUrl(raw);
      load(group, url, img, { instanceOnly: true }).then((ok) => {
        if (ok) delete img.dataset.img;
        else img.replaceWith(fallback(img, url));
      });
    }
  }

  window.ImgHydrate = { hydrate, load, release, held };
})();
