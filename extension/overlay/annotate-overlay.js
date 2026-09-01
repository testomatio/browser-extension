// Annotator overlay injected on demand into the captured tab (NOT a declared content_script).
// It answers on a storage.session key the worker opened to content scripts (setAccessLevel).

/* global chrome, AnnotateCore, Tooltip */
(() => {
  'use strict';

  const HOST_ID = '__testomat_annotator_overlay';
  const key = window.__testomatAnnotateKey;
  window.__testomatAnnotateKey = null; // consume the one-shot handoff key
  // The panel's Appearance setting, ALREADY RESOLVED: this overlay lives in the site's
  // document, where neither store shared/theme.js keeps is readable.
  const scheme = window.__testomatAnnotateScheme === 'dark' || window.__testomatAnnotateScheme === 'light'
    ? window.__testomatAnnotateScheme
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  window.__testomatAnnotateScheme = null;
  // The library's stylesheet, read in the extension's context and handed over with the key;
  // the injector treats a failure to read it as a failed injection (unstyled markup).
  const libCss = window.__testomatAnnotateCss || '';
  window.__testomatAnnotateCss = null;

  // Every exit writes to the handoff key. A silent `return` here used to leave the panel on
  // "Annotating…" for good: it awaits this key and there is nothing else to tell it the
  // overlay never came up.
  const signal = (v) => { try { chrome.storage.session.set({ [key]: v }); } catch { /* noop */ } };

  if (!key || !chrome?.storage?.session) return; // no key, no channel — the panel's watchdog covers it
  if (!libCss || typeof AnnotateCore === 'undefined') {
    signal({ error: 'The annotator could not load on this page' });
    return;
  }

  // `.annot-root` carries a concrete `color-scheme`: a media query cannot see the panel's
  // Appearance setting, and every token in tokens.css is a `light-dark()` pair on it.
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
       library's .menu (position, depth, padding and shadow come from there);
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
    let readErr = '';
    try { payload = (await chrome.storage.session.get(key))[key]; }
    catch (e) { readErr = (e && e.message) || String(e); }
    const dataUrl = payload && payload.dataUrl;
    if (!dataUrl) {
      signal({ error: readErr ? `The annotator could not read the shot: ${readErr}` : 'The shot did not reach the annotator' });
      return;
    }

    // A stale overlay (re-annotate on the same tab) is torn down first.
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    // Max positive 32-bit z-index; fixed + full viewport, above all page content.
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    // The library first, this file's layout second, so an overlay rule that has to win
    // wins by ORDER rather than by a specificity race with the design system.
    const lib = document.createElement('style');
    lib.textContent = libCss;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const mount = document.createElement('div');
    mount.className = 'annot-root';
    mount.dataset.scheme = scheme; // the panel's Appearance setting, resolved
    shadow.append(lib, style, mount);
    (document.body || document.documentElement).append(host);
    // The frame IS up — said before the picture is decoded, which is the slow half. It is what
    // ends the panel's watchdog, so nothing after this point can be mistaken for a dead overlay.
    signal({ ready: true });
    // The tooltip is drawn INSIDE this root: from the document, a hit test only ever
    // finds the shadow host.
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
    // Navigation/close while open maps to Keep original: the raw shot goes back so the
    // panel keeps it and its promise settles.
    const onPageHide = () => { try { chrome.storage.session.set({ [key]: { resultDataUrl: dataUrl } }); } catch { /* noop */ } };
    window.addEventListener('pagehide', onPageHide);

    // A throw in here would otherwise be an unhandled rejection in the page's world — invisible
    // from the panel, which would sit on a mounted-but-empty overlay.
    try {
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
    } catch (e) {
      teardown();
      signal({ error: `The annotator failed on this page: ${(e && e.message) || e}` });
    }
  })();
})();
