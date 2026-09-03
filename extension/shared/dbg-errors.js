// The chrome.debugger and capture refusals worth naming (IIFE global `DbgErrors`): which message is
// which failure, and the copy the tester reads instead of Chrome's. Depends on nothing.

const DbgErrors = (() => {
  // #101: Chrome refuses the debugger on an http(s) tab while another extension has a frame in it
  // (attaching by targetId too, and an open session starts failing) — and allows it once the frame is gone.
  const DBG_FOREIGN_FRAME = 'Another extension has a frame on this page, so Chrome blocks the debugger this needs — turn that extension off for this page (or use a clean profile) and try again.';
  // captureVisibleTab is allowed under `activeTab` (what a toolbar click leaves) or <all_urls>,
  // never under a per-origin grant — so this wording asks for the click that actually works.
  const DBG_FOREIGN_FRAME_CLICK = 'Another extension has a frame on this page, so Chrome blocks the debugger a full screenshot needs — click the Testomat icon in the toolbar and try again, and the panel will shoot the visible page instead.';
  const dbgIsForeignFrame = (msg) => /chrome-extension:\/\/ URL of different extension/.test(String(msg || ''));
  // Chrome's own wording for "captureVisibleTab needs activeTab or <all_urls>" — the one failure a click fixes.
  const capNeedsGrant = (msg) => /all_urls|activeTab/.test(String(msg || ''));

  // The one place a chrome.debugger refusal becomes an Error; `foreignFrame` unlocks the viewport rescue.
  function dbgError(msg) {
    const foreign = dbgIsForeignFrame(msg);
    const err = new Error(foreign ? DBG_FOREIGN_FRAME : String(msg));
    if (foreign) err.foreignFrame = true;
    return err;
  }

  return { dbgIsForeignFrame, capNeedsGrant, dbgError, DBG_FOREIGN_FRAME, DBG_FOREIGN_FRAME_CLICK };
})();
