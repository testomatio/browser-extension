// Names Chrome's debugger and capture refusals and the copy the tester reads instead of Chrome's.

const DbgErrors = (() => {
  // Chrome refuses the debugger while another extension has a frame in the tab, until the frame is gone.
  const DBG_FOREIGN_FRAME = 'Another extension has a frame on this page, so Chrome blocks the debugger this needs — turn that extension off for this page (or use a clean profile) and try again.';
  // captureVisibleTab needs activeTab (a toolbar click) or <all_urls>, so this asks for the click.
  const DBG_FOREIGN_FRAME_CLICK = 'Another extension has a frame on this page, so Chrome blocks the debugger a full screenshot needs — click the Testomat icon in the toolbar and try again, and the panel will shoot the visible page instead.';
  const dbgIsForeignFrame = (msg) => /chrome-extension:\/\/ URL of different extension/.test(String(msg || ''));
  // Chrome's wording names a tab id nobody can find, so ours names the remedy instead.
  const DBG_BUSY = 'Another tool is already debugging this tab — close DevTools on this page and try again.';
  // Matched without the id (and without "tab"/"target", which vary by how the attach was aimed).
  const dbgIsBusy = (msg) => /another debugger is already attached/i.test(String(msg || ''));
  // Chrome's wording for "captureVisibleTab needs activeTab or <all_urls>", the one a click fixes.
  const capNeedsGrant = (msg) => /all_urls|activeTab/.test(String(msg || ''));

  // `foreignFrame` unlocks the viewport rescue; `debuggerBusy` marks the refusal closing DevTools fixes.
  function dbgError(msg) {
    const foreign = dbgIsForeignFrame(msg);
    const busy = !foreign && dbgIsBusy(msg);
    let copy = String(msg);
    if (foreign) copy = DBG_FOREIGN_FRAME;
    else if (busy) copy = DBG_BUSY;
    const err = new Error(copy);
    if (foreign) err.foreignFrame = true;
    if (busy) err.debuggerBusy = true;
    return err;
  }

  return { dbgIsForeignFrame, dbgIsBusy, capNeedsGrant, dbgError,
    DBG_FOREIGN_FRAME, DBG_FOREIGN_FRAME_CLICK, DBG_BUSY };
})();
