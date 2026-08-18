// Shared capture + annotate helpers (IIFE global `CaptureAnnotate`). The handoff rides in
// chrome.storage.session (access level TRUSTED_AND_UNTRUSTED_CONTEXTS, so the overlay reads it).

/* global resolveSiteTab, Theme */

const CaptureAnnotate = (() => {
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime;
  const noop = () => {};

  // The resolver's verdict IS the preflight — no capture path may reach a restricted page.
  async function ensureCapturePermission() {
    if (!hasChrome || typeof resolveSiteTab !== 'function') return { ok: true };
    const site = await resolveSiteTab({ verb: 'captured' });
    return site.state === 'ok' ? { ok: true } : { ok: false, state: site.state, error: site.error };
  }

  // Format is fixed at JPEG q80 in the worker (background.js captureShot); `fullPage` is the
  // only knob. Local API, no network.
  async function captureTab({ fullPage = false } = {}) {
    if (!hasChrome || !chrome.runtime?.sendMessage) return { ok: false, error: 'no extension context' };
    const resp = await chrome.runtime
      .sendMessage({ type: 'captureTab', fullPage })
      .catch((e) => ({ ok: false, error: String(e) }));
    return resp || { ok: false, error: 'no response' };
  }

  // The library stylesheet is handed over as TEXT: a shadow root in another document cannot
  // <link> an extension file, and web-accessible files would let any page fingerprint us.
  let libCss = null;
  async function libraryCss() {
    if (libCss != null) return libCss;
    const files = ['shared/tokens.css', 'shared/components.css'];
    const parts = await Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())));
    libCss = parts.join('\n')
      .replace(/@font-face\s*\{[^}]*\}/g, '')   // relative url()s would be fetched FROM THE SITE
      .replace(/:root\b/g, ':host');            // `:root` in a shadow root is the SITE's <html>
    return libCss;
  }

  // The key and the RESOLVED colour scheme are stashed on the page's window first, in the
  // SAME isolated world: the overlay runs in the site's document and cannot read Appearance.
  async function tryInjectOverlay(targetTabId, key) {
    if (targetTabId == null || !chrome.scripting?.executeScript) return false;
    const scheme = typeof Theme !== 'undefined' ? Theme.resolved() : null;
    try {
      const css = await libraryCss();
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (k, s, c) => {
          window.__testomatAnnotateKey = k;
          window.__testomatAnnotateScheme = s;
          window.__testomatAnnotateCss = c;
        },
        args: [key, scheme, css],
      });
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        // icons.js first — annotate-core.js draws its toolbar from that set.
        files: ['shared/icons.js', 'shared/tooltip.js', 'shared/annotate-core.js', 'overlay/annotate-overlay.js'],
      });
      return true;
    } catch { /* restricted page → fallback */ return false; }
  }

  // Resolves with a dataURL on Apply/Keep original, null on Discard. The on-page overlay is
  // the primary path; a page that cannot host it falls back to the editor tab.
  function annotateImage(dataUrl, tabId, opts = {}) {
    const toast = typeof opts.toast === 'function' ? opts.toast : noop;
    if (!hasChrome || !chrome.storage?.session) {
      toast('Annotator needs the extension context');
      return Promise.resolve(null);
    }
    const forceTab = !!opts.forceTab;
    const key = `annotate-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      let settled = false;
      let fallbackTabId = null; // set only when we open the editor tab
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { chrome.storage.session.onChanged.removeListener(onChanged); } catch { /* noop */ }
        try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch { /* noop */ }
        chrome.storage.session.remove(key).catch(() => {});
        resolve(result);
      };
      const onChanged = (changes) => {
        const c = changes && changes[key];
        if (!c) return;
        const v = c.newValue;
        if (!v) return;
        if (v.resultDataUrl) finish(v.resultDataUrl);
        else if (v.cancelled) finish(null);
      };
      // A raw close of the editor tab (no storage write) maps to Keep original, not Discard.
      const onRemoved = (id) => { if (fallbackTabId != null && id === fallbackTabId) finish(dataUrl); };
      chrome.storage.session.onChanged.addListener(onChanged);
      chrome.tabs.onRemoved.addListener(onRemoved);
      (async () => {
        try {
          await chrome.storage.session.set({ [key]: { dataUrl } });
          if (!forceTab) {
            let targetTabId = tabId;
            if (targetTabId == null && typeof resolveSiteTab === 'function') {
              const site = await resolveSiteTab();
              targetTabId = site.tab && site.tab.id; // inject still decides reachability
            }
            if (await tryInjectOverlay(targetTabId, key)) return; // overlay drives the handoff
            toast("This page can't host the annotator — opened it in a tab.");
          }
          // Editor-tab annotator: the forced neutral surface, or the injection fallback.
          if (!chrome.tabs?.create) { finish(null); return; }
          const url = `${chrome.runtime.getURL('editor/editor.html')}?annotate=${encodeURIComponent(key)}`;
          const tab = await chrome.tabs.create({ url });
          fallbackTabId = tab && tab.id;
        } catch (e) {
          toast(`Could not open the annotator: ${(e && e.message) || e}`);
          finish(null);
        }
      })();
    });
  }

  return { ensureCapturePermission, captureTab, tryInjectOverlay, annotateImage };
})();
