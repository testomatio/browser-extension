// Evidence relay (#123) — the ISOLATED-world half of the recorder's in-page
// instrumentation. MAIN world (evidence/page-hook.js) has the page's fetch,
// console and XHR but no chrome.* at all; this side has chrome.runtime but not
// the page's globals. They share exactly one thing — the DOM — so the hook posts
// through window.postMessage and this file forwards to the service worker.
//
// It is deliberately thin: no formatting, no filtering, no state. Anything that
// decides what an event MEANS lives in evidence/recorder.js.

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

  // Body capture is a privacy switch (#95) the hook cannot read for itself —
  // chrome.storage lives on this side. The hook parks any body read until this
  // answer lands, so an explicit OFF is never violated by a fast failure.
  //
  // ITS OWN key, never `settings` (#175): this file runs in the renderer process
  // of the site under test, and the `settings` record holds the API token — one
  // future mistake here would be token disclosure to that site. The panel mirrors
  // the boolean into this key (sidepanel/screens/evidence.js).
  function pushConfig() {
    chrome.storage.local.get('evidenceCaptureBodies')
      .then((s) => control({ captureBodies: s.evidenceCaptureBodies !== false }))
      .catch(() => control({ captureBodies: true })); // absent -> ON, same rule as the panel
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CHANNEL || d.control || !Array.isArray(d.events)) return;
    // The reply is the ONLY stop signal the hook gets: a recording that ended
    // while this document stayed open (or a worker that restarted without one)
    // answers `off`, and the hook goes quiet instead of posting into the void.
    chrome.runtime.sendMessage({ type: 'EVIDENCE_EVENTS', events: d.events })
      .then((r) => {
        if (r && r.off) control({ off: true });
        else if (d.events.some((ev) => ev && ev.t === 'ready')) pushConfig();
      })
      .catch(() => { /* worker asleep or extension reloaded — drop the batch */ });
  });

  // Stop/start arriving from the worker: Rec off mutes the hook, and a NEW
  // recording on this same never-navigated document un-mutes it (a re-inject
  // cannot — the hook's double-init guard swallows it).
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

  // The hook may have installed BEFORE us (two dynamic scripts have no
  // guaranteed order), in which case its `ready` is already gone — push the
  // config unprompted as well. A second config message is harmless.
  pushConfig();
})();
