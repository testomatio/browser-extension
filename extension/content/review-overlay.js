// Recording review drawn OVER the page (#68 preview+trim), injected on demand by the worker
// when a recording stops. Frames screenrec/review.html; the page reads the parked file itself.
// Closing WITHOUT attaching keeps the file parked — the panel's button offers the review again.

/* global chrome */
(() => {
  'use strict';

  const HOST_ID = '__testomat_review_overlay';
  // An extension page paints in milliseconds; past this it is not slow, it is refused.
  const FRAME_WAIT_MS = 3000;
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
    iframe[hidden] { display: none; }
    .stall {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; height: 100%; padding: 28px; text-align: center; color: #d7dbe0;
      font: 13px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .stall b { font-size: 15px; }
    .stall p { margin: 0; color: #8b93a1; }
    .stall a { color: #6ea3ff; }
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
  let loaded = false;
  let stalled = false;
  let waitId = null;
  let keyed = false; // the frame is pointed at the review only once the worker hands the key over

  // review.html is web-accessible to every page, so it acts framed only for whoever carries the key
  // the worker minted with this take. The hash keeps it out of the request and out of a referrer.
  function armFrame(key) {
    if (torn) return;
    keyed = true;
    iframe.src = chrome.runtime.getURL('screenrec/review.html')
      + (key ? `#k=${encodeURIComponent(key)}` : '');
  }

  // A page whose CSP refuses our frame leaves a dark rectangle and no word of explanation, so a
  // tester cannot tell a refused review from a ruined take. Say it, and hand over the standalone tab.
  function showStall() {
    if (stalled || loaded || torn) return;
    stalled = true;
    iframe.hidden = true;
    const box = document.createElement('div');
    box.className = 'stall';
    const head = document.createElement('b');
    head.textContent = 'This page won’t let the review open inside it.';
    const note = document.createElement('p');
    note.textContent = 'Your recording is safe — it is still parked, waiting for you to attach or discard it.';
    const out = document.createElement('a');
    out.href = chrome.runtime.getURL('screenrec/review.html');
    out.target = '_blank';
    out.rel = 'noopener noreferrer';
    out.textContent = 'Open the review in a new tab';
    box.append(head, note, out);
    frame.append(box);
  }

  function teardown() {
    if (torn || busy) return;
    torn = true;
    if (waitId !== null) clearTimeout(waitId);
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
  // Chrome fires `load` for a frame its CSP refused, leaving it on the initial about:blank — which
  // is same-origin and so still readable. A review that really opened is an extension page, another
  // origin, and reading into it is refused. That is the only honest tell the two apart.
  const frameOpened = () => {
    try { return !iframe.contentDocument; } catch { return true; }
  };
  iframe.addEventListener('load', () => {
    if (!keyed) return; // the about:blank every empty frame loads on insertion is not our review
    if (!frameOpened()) { showStall(); return; }
    loaded = true;
    if (waitId !== null) clearTimeout(waitId);
  });
  iframe.addEventListener('error', showStall);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('message', onMessage);

  root.style.overflow = 'hidden';
  (document.body || root).append(host);
  waitId = setTimeout(showStall, FRAME_WAIT_MS);
  // A content script cannot read chrome.storage.session, and raising its access level would hand
  // the parked take to every content script on every page. The worker answers instead.
  chrome.runtime.sendMessage({ type: 'SCREENREC_REVIEW_KEY' })
    .then((r) => armFrame(r && r.key), () => armFrame(''));
})();
