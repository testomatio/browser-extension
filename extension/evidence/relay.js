// ISOLATED half: the hook has the page's globals, this side chrome.runtime; they share only the DOM.

/* global chrome */
(() => {
  'use strict';

  if (window.__testomatEvRelay) return;
  window.__testomatEvRelay = true;
  if (!chrome?.runtime?.sendMessage) return;

  const CHANNEL = '__testomat_evidence__';
  // The channel name is public; this per-document token is what marks our hook's batches.
  const TOKEN = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  // The five kinds the hook emits; the log the tester attaches carries nothing else.
  const KINDS = new Set(['ready', 'console', 'exception', 'log', 'net']);

  const control = (payload) => {
    try { window.postMessage({ source: CHANNEL, control: true, tok: TOKEN, ...payload }, '*'); } catch { /* noop */ }
  };

  // Own key, never `settings`: this runs in the site's renderer, and `settings` holds the API token.
  function pushConfig() {
    // A missing `chrome.storage` must read as an unreadable setting, not leave the relay half-installed.
    try {
      chrome.storage.local.get('evidenceCaptureBodies')
        .then((s) => control({ captureBodies: s.evidenceCaptureBodies !== false }))
        .catch(() => control({ captureBodies: true })); // absent -> on, same rule as the panel
    } catch { control({ captureBodies: true }); }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CHANNEL || d.control || !Array.isArray(d.events)) return;
    // An untokened hello is the cue to hand a token over, but a hello is not evidence.
    if (d.tok !== TOKEN) {
      if (d.events.some((ev) => ev && ev.t === 'ready')) pushConfig();
      return;
    }
    const events = d.events.filter((ev) => ev && typeof ev === 'object' && KINDS.has(ev.t));
    // The reply is the hook's only stop signal: with no recording here the worker answers `off`.
    chrome.runtime.sendMessage({ type: 'EVIDENCE_EVENTS', events })
      .then((r) => {
        if (r && r.off) control({ off: true });
        else if (events.some((ev) => ev.t === 'ready')) pushConfig();
      })
      .catch(() => { /* worker asleep or extension reloaded — drop the batch */ });
  });

  // A new recording on this never-navigated document must un-mute the hook; a re-inject cannot.
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

  // The hook may have loaded first (dynamic scripts have no order); a second config is harmless.
  pushConfig();
})();
