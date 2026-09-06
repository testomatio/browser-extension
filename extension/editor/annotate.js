// Screenshot annotator, editor-page fallback for where the overlay cannot be injected. Its
// handoff always OVERWRITES the storage.session key, so no un-blurred original survives.

/* global chrome, AnnotateCore */
window.Annotate = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // The URL names the key this page reads AND overwrites on exit, so only the shape
  // shared/capture-annotate.js ever parks a handoff under is accepted.
  const HANDOFF_KEY = /^annotate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let key = null;
  let done = false;         // guards double storage-write

  function fail(text) {
    const host = $('root');
    host.replaceChildren();
    const box = document.createElement('div');
    box.className = 'annot-msg';
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
    host.append(box);
  }

  function closeSelf() {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id != null) chrome.tabs.remove(tab.id);
        else { try { window.close(); } catch { /* noop */ } }
      });
    } catch { try { window.close(); } catch { /* noop */ } }
  }

  async function writeAndClose(value) {
    if (done) return;
    done = true;
    try { await chrome.storage.session.set({ [key]: value }); } catch { /* best effort */ }
    closeSelf();
  }

  // ---- boot ---------------------------------------------------------------
  async function init(k) {
    document.title = 'Annotate screenshot';
    if (!HANDOFF_KEY.test(String(k ?? '')) || !chrome?.storage?.session) { fail('Nothing to annotate.'); return; }
    key = k;
    let payload = null;
    try { payload = (await chrome.storage.session.get(key))[key]; } catch { /* unavailable */ }
    const dataUrl = payload && payload.dataUrl;
    if (!dataUrl) { fail('Nothing to annotate (the image handoff expired).'); return; }

    const handle = AnnotateCore.create({
      mount: $('root'),
      doc: document,
      dataUrl,
      onApply: (resultDataUrl) => writeAndClose({ resultDataUrl }),
      onCancel: () => writeAndClose({ cancelled: true }),
      confirmDiscard: () => window.confirm('Discard the screenshot and its annotations?'),
      confirmKeep: (hasBlur) => window.confirm(hasBlur
        ? 'Attach the original screenshot, with the areas you blurred visible again?'
        : 'Attach the original screenshot and drop the annotations?'),
      onReady: (hooks) => { window.__annot = hooks; },
    });
    // Expose immediately too, so `ready` can be polled from its false state.
    window.__annot = handle.hooks;
  }

  return { init };
})();
