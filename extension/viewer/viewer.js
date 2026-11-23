// Shows one panel file over the page or in a tab: a ~400px side panel is too small for a video.

/* global TestomatAPI, Handoff */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const fileUrl = q.get('url') || '';
  const fileName = q.get('name') || '';
  const fileType = q.get('type') || '';

  // Any site can open this page with its own ?url=, so only the url the worker parked here is shown.
  const PARKED_KEY = 'fileOverlay';

  const VIDEO_EXT = /\.(webm|mp4|mov|m4v|ogv)(?:$|[?#])/i;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)(?:$|[?#])/i;
  const TEXT_EXT = /\.(md|log|txt|json|csv|xml|ya?ml)(?:$|[?#])/i;

  // Type or name, either decides: buckets often serve a screencast as application/octet-stream.
  function kindOf() {
    const t = String(fileType);
    const n = fileName || fileUrl;
    if (t.startsWith('video/') || VIDEO_EXT.test(n)) return 'video';
    if ((t.startsWith('image/') && !/svg/i.test(t)) || IMAGE_EXT.test(n)) return 'image';
    if (t.startsWith('text/') || TEXT_EXT.test(n)) return 'text';
    return 'file';
  }

  // Only the configured instance needs a session; a presigned bucket link carries its own signature.
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

  async function parkedUrl() {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return '';
    try {
      const got = await chrome.storage.session.get(PARKED_KEY);
      const rec = got && got[PARKED_KEY];
      return rec && typeof rec.url === 'string' ? rec.url : '';
    } catch { return ''; }
  }

  // An empty url keeps its own note; anything else must be https and the exact url the worker parked.
  const allowed = async () => !fileUrl
    || (/^https:\/\//i.test(fileUrl) && fileUrl === await parkedUrl());

  // The session goes only to the configured instance; a blob is what the CSP leaves room for.
  async function fileBlob() {
    // Permissive on purpose: this document presigned nothing, so its signed set can vouch for nothing.
    const res = await TestomatAPI.fetchAsset(fileUrl, { instanceOnly: false });
    if (!res.ok) throw new Error(String(res.status));
    return res.blob();
  }

  const blobSrc = async () => URL.createObjectURL(await fileBlob());

  // img-src has no https: on purpose, so every image is shown from a blob; an <img> sends no auth.
  const imageSrc = blobSrc;

  // media-src allows https:, so an off-instance video streams; the instance's own needs the auth fetch.
  async function videoSrc() {
    return onInstance() ? blobSrc() : fileUrl;
  }

  const fileText = async () => (await fileBlob()).text();

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

  // Framed, Esc belongs to the overlay; the site's origin is unknown, hence '*'.
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
