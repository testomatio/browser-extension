// Both surfaces are the same document, so switching is: open the other, close this one.

/* global $, toast, Icons, Tooltip, ViewMode, hasChrome */

// Asked once at init: a document never moves between surfaces, it is reopened.
let inPanelWindow = false;
// The window a dock would open the side panel in. Read synchronously by the click.
let hostWindowId = null;

async function initViewSwitch() {
  const btn = $('view-switch');
  if (!btn) return;
  if (!hasChrome || !chrome.windows) { btn.hidden = true; return; }
  inPanelWindow = await ViewMode.inPanelWindow();
  // Only the window surface can dock, and only the dock needs this id.
  if (inPanelWindow) hostWindowId = await ViewMode.normalWindowId();
  // The worker records every normal-window focus; this keeps the id in step for the dock click.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[ViewMode.NORMAL_KEY]) {
      const next = changes[ViewMode.NORMAL_KEY].newValue;
      if (Number.isInteger(next)) hostWindowId = next;
    }
  });
  renderViewSwitch();
  // Wired last: a press landing before the label settles could open a window from inside one.
  btn.addEventListener('click', onViewSwitch);
}

// The button says what pressing it does, in both places it can be pressed.
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

// The preference is written only once the window is there: a failed create must not strand it.
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

// `sidePanel.open()` must run before any await, and needs a normal window: a popup can't host one.
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

// There is no sidePanel.close(), and both surfaces are our document: closing it closes the surface.
function closeSurface() {
  try { window.close(); } catch { /* nothing else to try */ }
}
