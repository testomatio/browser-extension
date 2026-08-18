// Evidence relay (#123) — the ISOLATED-world half: page-hook.js has the page's globals but
// no chrome.*, this side has chrome.runtime, and the DOM is all the two share.

/* global chrome */
(() => {
  'use strict';

  if (window.__testomatEvRelay) return;
  window.__testomatEvRelay = true;
  if (!chrome?.runtime?.sendMessage) return;

  const CHANNEL = '__testomat_evidence__';

  const control = (payload) => {
    try { window.postMessage({ source: CHANNEL, control: true, ...payload }, '*'); } catch { /* noop */ }
  };

  // ITS OWN key, never `settings` (#175): this runs in the renderer process of the site
  // under test, and the `settings` record holds the API token. The panel mirrors it here.
  function pushConfig() {
    chrome.storage.local.get('evidenceCaptureBodies')
      .then((s) => control({ captureBodies: s.evidenceCaptureBodies !== false }))
      .catch(() => control({ captureBodies: true })); // absent -> ON, same rule as the panel
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CHANNEL || d.control || !Array.isArray(d.events)) return;
    // The reply is the ONLY stop signal the hook gets: a worker with no recording for
    // this document answers `off`, and the hook goes quiet instead of posting into the void.
    chrome.runtime.sendMessage({ type: 'EVIDENCE_EVENTS', events: d.events })
      .then((r) => {
        if (r && r.off) control({ off: true });
        else if (d.events.some((ev) => ev && ev.t === 'ready')) pushConfig();
      })
      .catch(() => { /* worker asleep or extension reloaded — drop the batch */ });
  });

  // A NEW recording on this same never-navigated document has to un-mute the hook: a
  // re-inject cannot, since its double-init guard swallows it.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return undefined;
      if (msg.type === 'EVIDENCE_HOOK_OFF') control({ off: true });
      else if (msg.type === 'EVIDENCE_HOOK_ON') { control({ off: false }); pushConfig(); }
      return undefined;
    });
  } catch { /* noop */ }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.evidenceCaptureBodies) pushConfig();
    });
  } catch { /* older Chrome */ }

  // The hook may have installed BEFORE us (two dynamic scripts have no guaranteed order),
  // in which case its `ready` is already gone; a second config message is harmless.
  pushConfig();
})();
