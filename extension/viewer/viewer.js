// File viewer (#21): the ONE artifact or attachment the panel handed over, framed over the page
// by content/file-overlay.js (or alone in a tab) — a ~400px side panel is no size for a screencast.

/* global TestomatAPI, Handoff */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const fileUrl = q.get('url') || '';
  const fileName = q.get('name') || '';
  const fileType = q.get('type') || '';

  // This page is web-accessible under a pinned id, so any site can open it with a ?url= of its
  // own. The worker parks the ONE file it is about to show here first; no page can write there.
  const PARKED_KEY = 'fileOverlay';

  const VIDEO_EXT = /\.(webm|mp4|mov|m4v|ogv)(?:$|[?#])/i;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)(?:$|[?#])/i;
  const TEXT_EXT = /\.(md|log|txt|json|csv|xml|ya?ml)(?:$|[?#])/i;

  // EITHER tell, like the panel's tiles: a bucket serves a screencast as
  // `application/octet-stream` often enough that the name has to be able to answer alone.
  function kindOf() {
    const t = String(fileType);
    const n = fileName || fileUrl;
    if (t.startsWith('video/') || VIDEO_EXT.test(n)) return 'video';
    if ((t.startsWith('image/') && !/svg/i.test(t)) || IMAGE_EXT.test(n)) return 'image';
    if (t.startsWith('text/') || TEXT_EXT.test(n)) return 'text';
    return 'file';
  }

  // ---- the session the panel already has -----------------------------------
  // Only the configured instance needs one; a presigned bucket link carries its own signature.
  let base = '';

  async function boot() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    let settings = null;
    try { ({ settings } = await chrome.storage.local.get('settings')); } catch { return; }
    if (!Handoff.credentialed(settings)) return;
    await Handoff.ready(); // a handed-off config keeps its session token in the host's file
    Handoff.configure(settings);
    base = String(settings.baseUrl).replace(/\/+$/, '');
  }

  const onInstance = () => !!base && (fileUrl === base || fileUrl.startsWith(`${base}/`));

  // ---- the allowlist of exactly one ----------------------------------------

  async function parkedUrl() {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return '';
    try {
      const got = await chrome.storage.session.get(PARKED_KEY);
      const rec = got && got[PARKED_KEY];
      return rec && typeof rec.url === 'string' ? rec.url : '';
    } catch { return ''; }
  }

  // No url reaches nothing, so it keeps its own note below. Anything else has to be https AND the
  // very url the worker parked — a query the page made up matches neither.
  const allowed = async () => !fileUrl
    || (/^https:\/\//i.test(fileUrl) && fileUrl === await parkedUrl());

  // fetchAsset carries the session ONLY for the configured instance; a presigned or public
  // link goes out bare. Both come back as bytes, which is what the CSP leaves room for.
  async function fileBlob() {
    // Permissive on purpose: this document presigned nothing, so its signed set can vouch for nothing.
    const res = await TestomatAPI.fetchAsset(fileUrl, { instanceOnly: false });
    if (!res.ok) throw new Error(String(res.status));
    return res.blob();
  }

  const blobSrc = async () => URL.createObjectURL(await fileBlob());

  // `img-src` carries no `https:` by design (#175), so EVERY image is fetched and shown from a
  // blob — an instance-hosted one also because an <img> sends no Authorization header.
  const imageSrc = blobSrc;

  // `media-src` does allow https:, so an off-instance video streams from its own URL rather
  // than being buffered into memory whole; the instance's own still needs the authorized fetch.
  async function videoSrc() {
    return onInstance() ? blobSrc() : fileUrl;
  }

  const fileText = async () => (await fileBlob()).text();

  // ---- render --------------------------------------------------------------

  const stage = () => $('viewer-stage');

  function note(text) {
    const p = document.createElement('p');
    p.className = 'viewer-note';
    p.textContent = text;
    stage().replaceChildren(p);
  }

  // The title bar's link stays up through every failure — it is the way out to a real tab.
  const fail = () => note('This file could not be loaded — the link may have expired.');

  const refuse = () => note('This link did not come from the panel, so it was not opened.');

  function renderVideo(src) {
    const el = document.createElement('video');
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
    el.addEventListener('error', fail);
    el.src = src;
    stage().replaceChildren(el);
  }

  function renderImage(src) {
    const el = document.createElement('img');
    el.alt = fileName || 'file';
    el.addEventListener('error', fail);
    el.src = src;
    stage().replaceChildren(el);
  }

  function renderText(text) {
    const el = document.createElement('pre');
    el.textContent = text;
    stage().replaceChildren(el);
  }

  async function show() {
    const kind = kindOf();
    if (kind === 'file') { note('No preview for this file type.'); return; }
    if (!fileUrl) { fail(); return; }
    try {
      if (kind === 'text') renderText(await fileText());
      else if (kind === 'video') renderVideo(await videoSrc());
      else renderImage(await imageSrc());
    } catch { fail(); }
  }

  // ---- chrome --------------------------------------------------------------

  function paintChrome() {
    const name = fileName || 'File';
    document.title = name;
    $('viewer-name').textContent = name;
    $('viewer-name').title = name;
  }

  // The way out waits for the verdict: a url this page refuses must not become a link either.
  function paintOut(ok) {
    const out = $('viewer-open');
    out.href = ok ? fileUrl : '';
    out.hidden = !ok || !fileUrl;
  }

  // Framed by the on-page overlay, or standing alone in a tab of its own (the overlay's
  // fallback). Framed, Esc is the overlay's to act on — the site's origin is unknown, hence '*'.
  const framed = window.parent !== window;

  function closeSelf() {
    if (framed) { window.parent.postMessage({ type: 'TESTOMAT_VIEWER_CLOSE' }, '*'); return; }
    if (typeof chrome === 'undefined' || !chrome.tabs) { window.close(); return; }
    chrome.tabs.getCurrent()
      .then((tab) => (tab && tab.id != null ? chrome.tabs.remove(tab.id) : window.close()))
      .catch(() => window.close());
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSelf(); });

  paintChrome();
  allowed().then((ok) => {
    paintOut(ok);
    if (!ok) { refuse(); return undefined; }
    return boot().catch(() => { /* no session — a signed or public link still loads */ }).then(show);
  });
})();
