// Presence marker (#14): the web app reads this to tell whether the extension is installed.

/* global chrome */
(() => {
  'use strict';

  // A torn-down extension context makes getManifest() throw, and this page is not ours to break.
  try {
    document.documentElement.setAttribute('data-testomat-extension', chrome.runtime.getManifest().version);
    window.dispatchEvent(new Event('testomat-extension:ready'));
  } catch { /* no context, no marker */ }
})();
