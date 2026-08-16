// Annotator overlay (on-page) — the primary annotate surface. Injected on demand
// via chrome.scripting.executeScript (NOT a declared content_script), alongside
// shared/annotate-core.js, into the tab where the screenshot was taken. It builds
// a full-viewport fixed host with a Shadow DOM (styles are the inline CSS string
// below — page CSS cannot leak in, our CSS cannot leak out), blocks page scroll
// while open, and reuses the shared core verbatim. Esc = Cancel. On pagehide
// (navigation/close) it best-effort writes Cancel so the panel never hangs.
//
// Handoff: identical chrome.storage.session key contract as the editor-tab
// fallback — Apply/Keep-original overwrite the key with {resultDataUrl} (Apply's
// is the flattened export, Keep-original's is the raw shot), Discard with
// {cancelled:true}; the panel reacts via onChanged. The panel stashes the key on
// window.__testomatAnnotateKey (a prior executeScript func) before this runs.
// Session storage is opened to content scripts by the service worker
// (setAccessLevel TRUSTED_AND_UNTRUSTED_CONTEXTS).

/* global chrome, AnnotateCore, Tooltip */
(() => {
  'use strict';

  const HOST_ID = '__testomat_annotator_overlay';
  const key = window.__testomatAnnotateKey;
  window.__testomatAnnotateKey = null; // consume the one-shot handoff key
  // The panel's Appearance setting, ALREADY RESOLVED to light or dark — this
  // overlay lives in the site's document, where neither of the two stores
  // shared/theme.js keeps is readable, so the panel hands it a concrete scheme
  // in the same bootstrap func that hands over the key. Anything else (an older
  // panel, a direct injection) is the OS preference, exactly as before.
  const scheme = window.__testomatAnnotateScheme === 'dark' || window.__testomatAnnotateScheme === 'light'
    ? window.__testomatAnnotateScheme
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  window.__testomatAnnotateScheme = null;
  // The library's own stylesheet, read in the extension's context and handed
  // over with the key (shared/capture-annotate.js). Without it this toolbar
  // would be unstyled markup, so the injector treats a failure to read it as a
  // failed injection and opens the editor-tab annotator instead.
  const libCss = window.__testomatAnnotateCss || '';
  window.__testomatAnnotateCss = null;

  if (!key || !libCss || !chrome?.storage?.session || typeof AnnotateCore === 'undefined') return;

  // The overlay's LOOK is the library's, not a copy of it: shared/tokens.css and
  // shared/components.css arrive as text on `window.__testomatAnnotateCss` (the
  // injector reads them — see the note in shared/capture-annotate.js) and are the
  // first stylesheet in this shadow root. Every control the toolbar builds
  // already carries the library's own class — `.btn`, `.btn.icon`, `.swatch`,
  // `.segmented`/`.segment`, `.menu`, `.tooltip` — so what used to be ~120 lines
  // of hand-copied button skin down here is now just the library, and a change to
  // a button in the panel is the same change in this toolbar.
  //
  // What is left below is what the LIBRARY does not know about: the overlay's own
  // layout (a bar over a stage), the canvas, the crop cursors, the shortcut card,
  // the ink popover's position and the label typed onto the picture.
  //
  // The scheme is written on `.annot-root` as a concrete `color-scheme`, not left
  // to a `prefers-color-scheme` media query: a media query cannot see the panel's
  // Appearance setting, so an overlay under one would come up dark while the
  // panel that opened it was pinned to Light. Every token in tokens.css is a
  // `light-dark()` pair resolved against exactly that.
  const OVERLAY_CSS = `
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .annot-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      color-scheme: light;
      background: var(--bg); color: var(--fg);
      font-family: var(--font-sans); font-size: var(--fs-base);
    }
    .annot-root[data-scheme="dark"] { color-scheme: dark; }
    .annot { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .annot-bar {
      flex: none;
      /* Over the stage: the stage is positioned (the shortcut card is pinned to
         it), so without a layer of its own the bar's ink popover would open
         BEHIND the picture. */
      position: relative; z-index: 1;
      /* Eleven tools, the ink, three weights and the four actions do not fit
         every window, so this row wraps; the row gap keeps the second line on
         the 4px grid. */
      display: flex; flex-wrap: wrap; align-items: center;
      gap: var(--space-2); row-gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      /* No rule under it — the shared BAR carries none (components.css). */
      background: var(--bg);
    }
    .annot-spacer { flex: 1 1 auto; }
    /* Controls that answer one question stand together at the tighter gap; the
       rule between two groups is the shared border. */
    .annot-group { display: inline-flex; align-items: center; gap: var(--space-1); }
    .annot-sep { flex: none; width: 1px; height: var(--space-5); background: var(--border); }
    /* What Copy and Download report back — text at full strength that simply is
       not there when there is nothing to say. */
    .annot-flash { font-size: var(--fs-sm); color: var(--muted); }
    /* The ink: one swatch that opens the eight over it. The popover IS the
       library's `.menu` (position, depth, padding and shadow come from there);
       what is said here is only where it hangs and that a row of swatches needs
       no minimum width. */
    .annot-ink { position: relative; display: inline-flex; }
    .annot-ink-menu { left: 0; min-width: 0; }
    .annot-ink-menu[hidden] { display: none; }
    .annot-stage {
      position: relative;   /* the shortcut card is pinned to the stage */
      flex: 1 1 auto; min-height: 0;
      display: flex; align-items: center; justify-content: center;
      padding: var(--space-2); overflow: auto;
      background: var(--surface-2);
    }
    /* The keyboard map (?): a card over the stage, not a dialog — it is read
       WHILE drawing, and the canvas keeps the keyboard under it. */
    .annot-help {
      position: absolute; z-index: 10; top: var(--space-4); right: var(--space-4);
      width: 280px; max-height: calc(100% - var(--space-8));
      padding: var(--space-4); overflow: auto;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: var(--shadow-bar);
    }
    .annot-help[hidden] { display: none; }
    .annot-help h2 {
      margin: 0 0 var(--space-3); font-size: var(--fs-sm); font-weight: var(--weight-semibold);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .annot-help dl {
      display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-3);
      margin: 0; font-size: var(--fs-sm);
    }
    .annot-help dt { font-family: var(--font-mono); font-size: var(--fs-2xs); white-space: nowrap; }
    .annot-help dd { margin: 0; color: var(--muted); }
    .annot-canvas {
      display: block; max-width: 100%;
      box-shadow: var(--shadow-bar);
      cursor: crosshair; touch-action: none;
    }
    /* Select tool (#68): pointing, not drawing — 'move' while over a hit op. A
       grip and the freehand tools set their own cursor inline (annotate-core). */
    .annot-canvas.pick { cursor: default; }
    .annot-canvas.pick.over { cursor: move; }
    /* Crop: choosing a region of the picture, not laying ink on it. */
    .annot-canvas.crop { cursor: cell; }
    .annot-msg { padding: var(--space-4); font-size: var(--fs-base); }
    .annot-text-input {
      position: fixed; z-index: 20;
      width: auto; height: auto; min-width: 40px;
      padding: 1px var(--space-1); margin: 0;
      background: var(--annot-label-bg);
      border: 1px dashed var(--annot-tool); border-radius: var(--radius-xs);
      outline: none;
    }
  `;

  (async () => {
    let payload = null;
    try { payload = (await chrome.storage.session.get(key))[key]; } catch { /* no access */ }
    const dataUrl = payload && payload.dataUrl;
    if (!dataUrl) return;

    // A stale overlay (re-annotate on the same tab) is torn down first.
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    // Max positive 32-bit z-index; fixed + full viewport, above all page content.
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    // The library first, this file's layout second — so an overlay rule that has
    // to win (the canvas cursors, the label typed onto the picture) wins by
    // order rather than by a specificity race with the design system.
    const lib = document.createElement('style');
    lib.textContent = libCss;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const mount = document.createElement('div');
    mount.className = 'annot-root';
    mount.dataset.scheme = scheme; // the panel's Appearance setting, resolved
    shadow.append(lib, style, mount);
    (document.body || document.documentElement).append(host);
    // …and the product's own tooltip, drawn INSIDE this root: from the document
    // the hit test only ever finds the shadow host, which is why this toolbar
    // used to fall back to the browser's `title`.
    if (typeof Tooltip !== 'undefined') Tooltip.mount(shadow);

    // Block page scroll behind the modal; restore exactly on teardown.
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    let handle = null;
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      try { handle && handle.destroy(); } catch { /* noop */ }
      try { if (typeof Tooltip !== 'undefined') Tooltip.unmount(); } catch { /* noop */ }
      root.style.overflow = prevOverflow;
      window.removeEventListener('pagehide', onPageHide);
      host.remove();
    };

    const onApply = async (resultDataUrl) => {
      try { await chrome.storage.session.set({ [key]: { resultDataUrl } }); } catch { /* best effort */ }
      teardown();
    };
    const onCancel = async () => {
      try { await chrome.storage.session.set({ [key]: { cancelled: true } }); } catch { /* best effort */ }
      teardown();
    };
    // Navigation/close while open maps to Keep original (Block 5): best-effort
    // write the raw shot back so the panel keeps it, and the promise settles.
    const onPageHide = () => { try { chrome.storage.session.set({ [key]: { resultDataUrl: dataUrl } }); } catch { /* noop */ } };
    window.addEventListener('pagehide', onPageHide);

    handle = AnnotateCore.create({
      mount,
      doc: document,
      dataUrl,
      onApply,
      onCancel,
      confirmDiscard: () => window.confirm('Discard the screenshot and its annotations?'),
      onReady: (hooks) => { window.__annot = hooks; },
    });
    window.__annot = handle.hooks; // exposed in the isolated world for e2e
  })();
})();
