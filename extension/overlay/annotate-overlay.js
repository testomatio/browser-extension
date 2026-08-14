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

/* global chrome, AnnotateCore */
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

  if (!key || !chrome?.storage?.session || typeof AnnotateCore === 'undefined') return;

  // Self-contained shadow styles. One design language (Block 6): panel token
  // VALUES are copied inline here (no imports, no fetched fonts — Single Egress;
  // page CSS can't leak into the shadow root, ours can't leak out). Light
  // defaults + a dark override mirror sidepanel/style.css; the annotator keeps
  // its fixed #dc2626 tool colour and #6366f1-family accent.
  //
  // The dark block is keyed on `[data-scheme="dark"]` rather than on a
  // `prefers-color-scheme` media query: a media query cannot see the panel's
  // Appearance setting, so an overlay under one would come up dark while the
  // panel that opened it was pinned to Light. The scheme is resolved once, above,
  // and written onto the root — which also means `color-scheme` here is a
  // concrete value, so the native widgets inside match too.
  const OVERLAY_CSS = `
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .annot-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      color-scheme: light;
      --bg: #ffffff; --fg: #262626;
      --border: #e5e5e5; --border-control: #d4d4d4;
      --card: #fafafa; --surface-2: #f5f5f5;
      --hover-overlay: rgba(0, 0, 0, 0.045);
      --accent: #6366f1; --accent-border: #4f46e5; --accent-hover: #4f46e5; --on-accent: #ffffff;
      --radius: 8px;
      background: var(--bg); color: var(--fg);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      font-size: 14px;
    }
    .annot-root[data-scheme="dark"] {
      color-scheme: dark;
      /* Tailwind "neutral", same ramp as the panel: page on the 850 half-step,
         card raised by a 5% white overlay (#2a2a2a), well recessed to 900. */
      --bg: #1f1f1f; --fg: #e5e5e5;
      --border: #404040; --border-control: #525252;
      --card: #2a2a2a; --surface-2: #171717;
      --hover-overlay: rgba(255, 255, 255, 0.06);
      /* indigoDark 600 → 700 on hover → 800 as the edge: up the ramp, the
         direction dark runs (tokens.css, the brand block). */
      --accent: #7781e2; --accent-border: #9aa2f9; --accent-hover: #818cf8;
    }
    .annot { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .annot-bar {
      flex: none;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      /* No rule under it — the shared BAR carries none (components.css), and this
         is that same row rewritten for the overlay's own stylesheet. */
      background: var(--bg);
    }
    .annot-spacer { flex: 1 1 auto; }
    .annot-btn {
      flex: none;
      /* Icon + word — the tool buttons lead with a Material Symbols mark (#180).
         8px between the two, the shared --control-gap-md: the library holds that
         gap at every control height, so a 32px button here matches a 32px button
         in the panel. */
      display: inline-flex; align-items: center; gap: 8px;
      /* Height outright + side padding on the grid, like the shared .btn: 32 is
         the system's ceiling, and vertical padding would only fight it. */
      height: 32px; padding: 0 12px;
      font: inherit; font-weight: 500; color: var(--fg);
      border: 1px solid var(--border-control);
      border-radius: var(--radius);
      background: var(--card);
      cursor: pointer;
    }
    .annot-btn:hover:not(:disabled) { box-shadow: inset 0 0 0 999px var(--hover-overlay); }
    .annot-btn.active { background: #dc2626; border-color: #b91c1c; color: #fff; }
    .annot-btn.primary { background: var(--accent); border-color: var(--accent-border); color: var(--on-accent); }
    .annot-btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
    .annot-btn.danger { color: #dc2626; border-color: rgba(220, 38, 38, 0.5); }
    .annot-btn.danger:hover:not(:disabled) { background: rgba(220, 38, 38, 0.12); }
    .annot-stage {
      flex: 1 1 auto; min-height: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 8px; overflow: auto;
      background: var(--surface-2);
    }
    .annot-canvas {
      display: block; max-width: 100%;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      cursor: crosshair; touch-action: none;
    }
    /* Select tool (#68): pointing, not drawing — 'move' while over a hit op. */
    .annot-canvas.pick { cursor: default; }
    .annot-canvas.pick.over { cursor: move; }
    .annot-msg { padding: 16px; font-size: 13px; }
    .annot-text-input {
      position: fixed; z-index: 20;
      min-width: 40px; padding: 1px 4px; margin: 0;
      background: rgba(255, 255, 255, 0.92);
      border: 1px dashed #dc2626; border-radius: 3px;
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
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const mount = document.createElement('div');
    mount.className = 'annot-root';
    mount.dataset.scheme = scheme; // the panel's Appearance setting, resolved
    shadow.append(style, mount);
    (document.body || document.documentElement).append(host);

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
