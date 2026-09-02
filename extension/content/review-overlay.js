// Recording review drawn OVER the page (#68 preview+trim), injected on demand by the worker
// when a recording stops. Frames screenrec/review.html; the page reads the parked file itself.
// Closing WITHOUT attaching keeps the file parked — the panel's button offers the review again.

/* global chrome */
(() => {
  'use strict';

  const HOST_ID = '__testomat_review_overlay';
  if (window.__testomatReviewOverlayInited && document.getElementById(HOST_ID)) return;
  if (!chrome?.runtime?.getURL) return;
  window.__testomatReviewOverlayInited = true;

  const CSS_TEXT = `
    :host { all: initial; }
    .backdrop {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55);
    }
    .frame {
      width: min(94vw, 1000px); height: min(90vh, 720px);
      overflow: hidden; border-radius: 10px;
      background: #16191f; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
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
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const frame = document.createElement('div');
  frame.className = 'frame';
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay';
  iframe.src = chrome.runtime.getURL('screenrec/review.html');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  frame.append(iframe);
  backdrop.append(frame);
  shadow.append(style, backdrop, closeBtn);

  const root = document.documentElement;
  const prevOverflow = root.style.overflow;
  let torn = false;
  let busy = false; // a trim export is running in the frame — tearing it down now throws the take away

  function teardown() {
    if (torn || busy) return;
    torn = true;
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('message', onMessage);
    root.style.overflow = prevOverflow;
    host.remove();
    window.__testomatReviewOverlayInited = false;
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    teardown();
  }

  // Esc or a finished review inside the frame reaches us as a message — that document has its
  // own keyboard. Only our own iframe may ask: any script on the page can post here.
  function onMessage(e) {
    if (e.source !== iframe.contentWindow || !e.data) return;
    if (e.data.type === 'TESTOMAT_REVIEW_BUSY') busy = !!e.data.busy;
    else if (e.data.type === 'TESTOMAT_REVIEW_CLOSE') teardown();
  }

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) teardown(); });
  closeBtn.addEventListener('click', teardown);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('message', onMessage);

  root.style.overflow = 'hidden';
  (document.body || root).append(host);
})();
