// The header's surface switch (#208): "Open in window" in the side panel, "Dock
// to side panel" in the window. ONE control with two states, in the project strip
// beside Refresh and the way out to the web app — the strip is the panel's own
// chrome, and which surface the panel is in is exactly that.
//
// Both surfaces are the SAME document, so switching is: open the other one, then
// close this one. Nothing has to be carried across — the session restore that
// already survives a panel close (core/storage.js) is what puts the tester back
// on the run they were executing.
//
// The two directions are not symmetric, and the asymmetry is the user gesture:
//
//   → window        the worker owns `windows.create` (background.js), so this is
//                   a message, and an await before closing costs nothing.
//   → side panel    `chrome.sidePanel.open()` may only be called while the click
//                   is still on the stack, and it needs the id of a NORMAL window
//                   (a popup cannot host a side panel). So the id is kept fresh
//                   here — seeded on load, then updated live from the worker's
//                   focus tracking — and the call is the FIRST statement of the
//                   handler, before anything that awaits.

/* global $, toast, Icons, Tooltip, ViewMode, hasChrome */

// Which surface this document is: asked once at init, because a document never
// moves between surfaces — it is reopened in the other one.
let inPanelWindow = false;
// The window a dock would open the side panel in. Read synchronously by the click.
let hostWindowId = null;

async function initViewSwitch() {
  const btn = $('view-switch');
  if (!btn) return;
  btn.addEventListener('click', onViewSwitch);
  if (!hasChrome || !chrome.windows) { btn.hidden = true; return; }
  inPanelWindow = await ViewMode.inPanelWindow();
  // Only the window surface can dock, and only the dock needs this id — in the
  // side panel the two window lookups it costs would buy nothing.
  if (inPanelWindow) hostWindowId = await ViewMode.normalWindowId();
  // The worker records every focus change into a normal window; this keeps the id
  // above in step with it, so the dock click never has to look one up.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[ViewMode.NORMAL_KEY]) {
      const next = changes[ViewMode.NORMAL_KEY].newValue;
      if (Number.isInteger(next)) hostWindowId = next;
    }
  });
  renderViewSwitch();
}

// The button says what pressing it DOES, in both places it can be pressed.
function renderViewSwitch() {
  const btn = $('view-switch');
  if (!btn) return;
  const label = inPanelWindow ? 'Dock to side panel' : 'Open in window';
  // The machine-readable half: which surface this press would land on.
  btn.dataset.viewTarget = inPanelWindow ? 'sidepanel' : 'window';
  btn.setAttribute('aria-label', label);
  Tooltip.set(btn, label);
  btn.replaceChildren(Icons.el(inPanelWindow ? 'dock_to_right' : 'web_asset', 20));
}

function onViewSwitch() {
  if (inPanelWindow) dockToSidePanel();
  else openInWindow();
}

// Side panel → window. The preference is written only once the window is really
// there: a failed create must not leave the toolbar icon pointing at a surface
// that could not be opened.
async function openInWindow() {
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: 'VIEW_OPEN_WINDOW' }); } catch { res = null; }
  if (!res || !res.ok) {
    toast(`Couldn't open the panel in a window${res && res.error ? ` — ${res.error}` : ''}`, { error: true });
    return;
  }
  await ViewMode.setMode('window');
  closeSurface();
}

// Window → side panel. `sidePanel.open()` FIRST — everything else here can wait,
// and the gesture cannot.
function dockToSidePanel() {
  if (hostWindowId == null) {
    toast('Open a browser window first — the side panel lives in one', { error: true });
    return;
  }
  let opening = null;
  try { opening = chrome.sidePanel.open({ windowId: hostWindowId }); } catch (e) { opening = Promise.reject(e); }
  Promise.resolve(opening)
    .then(async () => { await ViewMode.setMode('sidepanel'); closeSurface(); })
    .catch((e) => toast(`Couldn't dock to the side panel — ${String(e?.message || e)}`, { error: true }));
}

// Both surfaces close the same way: there is no sidePanel.close() API, and the
// window is our own document's — so closing the document IS closing the surface.
function closeSurface() {
  try { window.close(); } catch { /* nothing else to try */ }
}
