// File viewer drawn OVER the page under test, injected on demand (NOT a declared
// content_script). background.js hands the file over in a storage.session key.

/* global chrome */
(() => {
  'use strict';

  const HOST_ID = '__testomat_file_overlay';
  const KEY = 'fileOverlay';
  // One overlay per document: a re-inject while it stands is a no-op (the storage listener
  // below swaps the file instead), while a host the page tore out is built again.
  if (window.__testomatFileOverlayInited && document.getElementById(HOST_ID)) return;
  if (!chrome?.storage?.session || !chrome.runtime?.getURL) return;
  window.__testomatFileOverlayInited = true;

  const CSS_TEXT = `
    :host { all: initial; }
    .backdrop {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55);
    }
    .frame {
      width: min(92vw, 1100px); height: min(88vh, 760px);
      overflow: hidden; border-radius: 10px;
      background: #1a1a1a; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
    /* Pinned to the viewport, not to the frame: the viewer's own bar already carries
       the "Open in a new tab" link exactly where a corner ✕ would sit. */
    .close {
      position: absolute; top: 16px; right: 16px;
      width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.35); background: rgba(0, 0, 0, 0.55);
      color: #fff; font: 600 15px/1 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .close:hover { background: rgba(255, 255, 255, 0.2); }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Max positive 32-bit z-index; fixed + full viewport, above all page content.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const frame = document.createElement('div');
  frame.className = 'frame';
  const iframe = document.createElement('iframe');
  // Delegated: a cross-origin frame gets neither autoplay nor fullscreen from the video controls.
  iframe.allow = 'autoplay; fullscreen';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  frame.append(iframe);
  backdrop.append(frame);
  shadow.append(style, backdrop, closeBtn);

  function showFile(file) {
    if (!file || !file.url) return false;
    const q = new URLSearchParams({ url: file.url, name: file.name || '', type: file.type || '' });
    iframe.src = `${chrome.runtime.getURL('viewer/viewer.html')}?${q}`;
    return true;
  }

  const root = document.documentElement;
  const prevOverflow = root.style.overflow;
  let torn = false;

  function teardown() {
    if (torn) return;
    torn = true;
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.removeListener(onChanged);
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('message', onMessage);
    root.style.overflow = prevOverflow;
    host.remove();
    window.__testomatFileOverlayInited = false;
  }

  // The panel clicked another file while this one is open: swap the src, never stack a second overlay.
  function onChanged(changes, area) {
    if (area !== 'session' || !changes[KEY]) return;
    showFile(changes[KEY].newValue);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    teardown();
  }

  // Esc pressed INSIDE the frame reaches us as a message — that document has its own keyboard.
  // Only our own iframe may ask: any script on the page can post here.
  function onMessage(e) {
    if (e.source === iframe.contentWindow && e.data && e.data.type === 'TESTOMAT_VIEWER_CLOSE') teardown();
  }

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) teardown(); });
  closeBtn.addEventListener('click', teardown);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('message', onMessage);
  if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onChanged);

  root.style.overflow = 'hidden';
  (document.body || root).append(host);
  chrome.storage.session.get(KEY)
    .then((v) => { if (!showFile(v && v[KEY])) teardown(); })
    .catch(teardown);
})();
