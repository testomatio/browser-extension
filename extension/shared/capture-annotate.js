// Shared capture + annotate helpers (IIFE global `CaptureAnnotate`). Relocated
// from the removed quick-capture screen so BOTH the side panel (test-view attach,
// hotkeys.js) and the editor page (in-editor Attach screenshot) can reuse one
// copy. Same module style as TestomatParams — plain <script>
// include, no bundler.
//
// The annotate handoff rides ONLY in chrome.storage.session under a random key
// (never local/sync); the annotator overwrites that key with the result. Session
// storage is opened to content scripts by the service worker (setAccessLevel
// TRUSTED_AND_UNTRUSTED_CONTEXTS) so the injected overlay can read it.

/* global resolveSiteTab, Theme */

const CaptureAnnotate = (() => {
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime;
  const noop = () => {};

  // Neither capture path reaches a page Chrome keeps extensions off, so the
  // resolver's verdict is the preflight: `ok` or the honest reason for this page.
  async function ensureCapturePermission() {
    if (!hasChrome || typeof resolveSiteTab !== 'function') return { ok: true };
    const site = await resolveSiteTab({ verb: 'captured' });
    return site.state === 'ok' ? { ok: true } : { ok: false, state: site.state, error: site.error };
  }

  // Screenshot the active tab via the background worker (local API, no network).
  // Returns { ok, dataUrl, tabId, error? }. Format is fixed at JPEG q80 in the
  // worker (background.js captureShot) — `fullPage` is the only knob.
  async function captureTab({ fullPage = false } = {}) {
    if (!hasChrome || !chrome.runtime?.sendMessage) return { ok: false, error: 'no extension context' };
    const resp = await chrome.runtime
      .sendMessage({ type: 'captureTab', fullPage })
      .catch((e) => ({ ok: false, error: String(e) }));
    return resp || { ok: false, error: 'no response' };
  }

  // Inject the on-page annotator overlay into `targetTabId`. Returns true on
  // success. A restricted page (or missing scripting API) throws → caller falls
  // back to the editor tab. The key is stashed on the page's window first (a tiny
  // bootstrap func in the SAME isolated world) so the injected overlay picks it up
  // — and the colour scheme rides along with it, RESOLVED to light or dark here:
  // the overlay runs in the site's document, where the Appearance setting cannot
  // be read, so a page that resolved it itself would ignore a pinned theme.
  // The overlay's toolbar is drawn with the LIBRARY's own stylesheet — the same
  // shared/tokens.css + shared/components.css the panel and the editor page load
  // — handed over as TEXT, because a shadow root in somebody else's document
  // cannot <link> an extension file, and making those files web-accessible would
  // let every page the overlay ever touches fingerprint this extension by
  // fetching them. Read here, in the extension's own context, where they are
  // just local resources (no network, Constitution IV).
  //
  // Two edits on the way in, both forced by the move:
  //   :root → :host   the token block has to land on the shadow HOST; `:root` in
  //                   there is the SITE's <html> and matches nothing.
  //   @font-face out  its `url()`s are relative, so inside the site's document
  //                   they would be fetched FROM THE SITE — a request to a
  //                   stranger's server for a font we ship. The stacks fall back
  //                   to the system faces, which is what the overlay always did.
  let libCss = null;
  async function libraryCss() {
    if (libCss != null) return libCss;
    const files = ['shared/tokens.css', 'shared/components.css'];
    const parts = await Promise.all(files.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())));
    libCss = parts.join('\n')
      .replace(/@font-face\s*\{[^}]*\}/g, '')
      .replace(/:root\b/g, ':host');
    return libCss;
  }

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
        // icons.js first — annotate-core.js draws its toolbar from that set — and
        // tooltip.js with them, so the toolbar's labels are the product's own
        // tooltip rather than the browser's `title` (it is mounted INTO the
        // shadow root by the overlay).
        files: ['shared/icons.js', 'shared/tooltip.js', 'shared/annotate-core.js', 'overlay/annotate-overlay.js'],
      });
      return true;
    } catch { /* restricted page → fallback */ return false; }
  }

  // Annotate an image dataURL and resolve with a dataURL on Apply/Keep original,
  // or null on Discard. PRIMARY path: inject the on-page overlay into the captured
  // tab (no new browser tab). FALLBACK: if injection throws (chrome://, Web Store,
  // PDF, file://), open the editor-tab annotator (editor.html?annotate=) and toast
  // that the page can't host it. `tabId` names the tab to inject into.
  //
  // `opts.forceTab` skips the overlay and opens the editor tab directly, WITHOUT
  // the fallback toast — a neutral surface for re-annotating a saved image.
  // `opts.toast` is the caller's toast fn (panel `toast` / editor `showToast`).
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
      // A raw close of the editor tab (no button clicked → no storage write) maps
      // to Keep original: hand back the raw shot, not a discard.
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
