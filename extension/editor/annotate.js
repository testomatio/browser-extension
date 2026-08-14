// Screenshot annotator — editor-page mode (`editor.html?annotate=<key>`), the
// automatic FALLBACK for pages where the on-page overlay cannot be injected
// (chrome://, Web Store, PDF viewer, file:// without access). editor.js hands the
// page over to Annotate.init(key) before any editor rendering.
//
// This is now a thin shell around the shared engine (shared/annotate-core.js):
// it owns only the chrome.storage.session handoff and closing its own tab; all
// tool/canvas logic lives in the core, which the on-page overlay reuses verbatim.
//
// Handoff (chrome.storage.session, never local/sync): the caller stores
// {dataUrl} at key `annotate-<rand>` and opens this tab. Apply and
// Keep original both write {resultDataUrl} back to the SAME key (the flattened
// export vs the raw shot); Discard writes {cancelled:true}. Either way the
// original dataUrl is overwritten — after Apply nothing retains the un-blurred
// original (privacy, spec §1). The caller reacts via
// chrome.storage.session.onChanged and closes on its side; we also close here.

/* global chrome, AnnotateCore */
window.Annotate = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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
    key = k;
    if (!key || !chrome?.storage?.session) { fail('Nothing to annotate.'); return; }
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
      onReady: (hooks) => { window.__annot = hooks; },
    });
    // Expose immediately too, so `ready` can be polled from its false state.
    window.__annot = handle.hooks;
  }

  return { init };
})();
