// Injected on demand into the captured tab, not a declared content_script.

/* global chrome, AnnotateCore, Tooltip */
(() => {
  'use strict';

  const HOST_ID = '__testomat_annotator_overlay';
  const key = window.__testomatAnnotateKey;
  window.__testomatAnnotateKey = null; // consume the one-shot handoff key
  // The panel's Appearance, already resolved: the site's document cannot read shared/theme.js stores.
  const scheme = window.__testomatAnnotateScheme === 'dark' || window.__testomatAnnotateScheme === 'light'
    ? window.__testomatAnnotateScheme
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  window.__testomatAnnotateScheme = null;
  // Handed over with the key; the injector treats a failed read as a failed injection.
  const libCss = window.__testomatAnnotateCss || '';
  window.__testomatAnnotateCss = null;

  // Every exit must write this key (the panel awaits it); refusals stay off the page's console.
  const signal = (v) => { try { chrome.storage.session.set({ [key]: v })?.catch(() => {}); } catch { /* noop */ } };

  if (!key || !chrome?.storage?.session) return; // no key, no channel — the panel's watchdog covers it
  if (!libCss || typeof AnnotateCore === 'undefined') {
    signal({ error: 'The annotator could not load on this page' });
    return;
  }

  // `.annot-root` sets a concrete `color-scheme`: a media query cannot see the panel's Appearance.
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
      /* Own layer: the stage is positioned, so the ink popover would otherwise open behind it. */
      position: relative; z-index: 1;
      /* The tools do not fit every window, so the row wraps; row-gap keeps line two on the grid. */
      display: flex; flex-wrap: wrap; align-items: center;
      gap: var(--space-2); row-gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      background: var(--bg);
    }
    .annot-spacer { flex: 1 1 auto; }
    .annot-group { display: inline-flex; align-items: center; gap: var(--space-1); }
    .annot-sep { flex: none; width: 1px; height: var(--space-5); background: var(--border); }
    .annot-flash { font-size: var(--fs-sm); color: var(--muted); }
    /* The popover is the library's .menu; only where it hangs and its zero min-width live here. */
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
    /* A card, not a dialog: it is read while drawing, and the canvas keeps the keyboard. */
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
    /* Grips and freehand tools set their own cursor inline (annotate-core). */
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
    // Library first, layout second: an overlay rule wins by order, not by a specificity race.
    const lib = document.createElement('style');
    lib.textContent = libCss;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const mount = document.createElement('div');
    mount.className = 'annot-root';
    mount.dataset.scheme = scheme; // the panel's Appearance setting, resolved
    shadow.append(lib, style, mount);
    (document.body || document.documentElement).append(host);
    // Said before the slow picture decode: this ends the panel's watchdog.
    signal({ ready: true });
    // Tooltip drawn inside this root: from the document, a hit test only finds the shadow host.
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
    // Navigating away is not a deliberate exit: attach nothing rather than the un-blurred raw shot.
    const onPageHide = () => { try { chrome.storage.session.set({ [key]: { cancelled: true } })?.catch(() => {}); } catch { /* noop */ } };
    window.addEventListener('pagehide', onPageHide);

    // A page-world rejection is invisible to the panel, which would sit on an empty overlay.
    try {
      handle = AnnotateCore.create({
        mount,
        doc: document,
        dataUrl,
        onApply,
        onCancel,
        confirmDiscard: () => window.confirm('Discard the screenshot and its annotations?'),
        confirmKeep: (hasBlur) => window.confirm(hasBlur
          ? 'Attach the original screenshot, with the areas you blurred visible again?'
          : 'Attach the original screenshot and drop the annotations?'),
        onReady: (hooks) => { window.__annot = hooks; },
      });
      window.__annot = handle.hooks; // exposed in the isolated world for e2e
    } catch (e) {
      teardown();
      signal({ error: `The annotator failed on this page: ${(e && e.message) || e}` });
    }
  })();
})();
