// Presence marker (#14): the web app reads this to tell whether the extension is installed.

/* global chrome */
(() => {
  'use strict';

  // A torn-down extension context makes getManifest() throw, and this page is not ours to break.
  try {
    document.documentElement.setAttribute('data-testomat-extension', chrome.runtime.getManifest().version);
    window.dispatchEvent(new Event('testomat-extension:ready'));
  } catch { /* no context, no marker */ }

  // "Run in Extension": a page cannot open the panel itself, so the click is relayed to the worker.
  window.addEventListener('testomat-extension:open-run', (event) => {
    let url = '';
    try { url = String(event?.detail?.url || ''); } catch { /* a hostile detail getter */ }
    try { chrome.runtime.sendMessage({ type: 'OPEN_RUN', url: url || location.href })?.catch(() => {}); }
    catch { /* no context, no relay */ }
  });
})();
