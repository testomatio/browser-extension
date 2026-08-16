// Service worker: panel behavior + tab screenshot capture (panel never in frame)
// + the evidence recorder (evidence/recorder.js — in-page instrumentation plus
// chrome.webRequest since #123; it holds NO debugger session, so every
// chrome.debugger call left in the extension is a screenshot's).

/* global resolveSiteTab, ViewMode, SiteTab */

importScripts('shared/view-mode.js', 'shared/site-tab.js', 'evidence/recorder.js');

// ======================= Panel surface: side panel / window =================
// #208: the toolbar click opens whichever surface the tester last chose, and the
// choice lives in chrome.storage.local (shared/view-mode.js).
//
// The awkward part is the user gesture. `sidePanel.open()` may only be called
// while the click is still on the stack, i.e. before the first await — and a
// worker woken BY that click cannot have read storage yet. So the preference is
// mirrored into the one place Chrome keeps for us across a worker sleeping:
// `openPanelOnActionClick`. In side-panel mode Chrome opens the panel itself and
// the handler below is never reached; in window mode the handler runs, and
// `windows.create` needs no gesture, so it may await the stored preference.

// What the last storage read said, so a WARM worker can still branch before its
// first await. `null` = not read yet, which only a worker woken by the click
// itself can be.
let viewModeCache = null;

// Mirror the preference onto Chrome's own behaviour flag. The value is persisted
// per installation, so this also overrides whatever an older build stored.
function syncPanelBehavior(mode) {
  viewModeCache = mode === 'window' ? 'window' : 'sidepanel';
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode !== 'window' })?.catch(() => {});
  } catch { /* older Chrome */ }
}
ViewMode.mode().then(syncPanelBehavior);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ViewMode.KEY]) syncPanelBehavior(changes[ViewMode.KEY].newValue);
});

// The panel, in the window the icon was clicked in. Synchronous on purpose.
// Only where there is NONE: this click is most often the fix the panel itself
// asked for, so the panel is already open and mid-flow — re-opening it risks
// re-navigating the document to the manifest's default_path, which would drop the
// page the tester is on (a half-written test in the editor being the one that
// hurts). The registry below is read synchronously on purpose: the gesture is gone
// at the first await.
function openSidePanelFor(tab) {
  if (!tab || tab.windowId == null) return;
  if (panelOpenIn(tab.windowId)) return;
  try { chrome.sidePanel.open({ windowId: tab.windowId })?.catch(() => {}); } catch { /* older Chrome */ }
}

// ---- open panels, per window ----------------------------------------------
// Which windows currently hold an open panel document. A LIVE port registry rather
// than a stored flag for two reasons: the click below has to read it before its
// first await (see there), and a port dies with the document it belongs to, so a
// closed panel needs no bookkeeping. Only real side panels connect — the editor in
// a tab does not (shared/panel-link.js).
const panelPorts = new Map(); // port -> windowId (null until PANEL_HELLO lands)

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'panel') return;
  // Panel-vs-tab is decided on the CONNECTING side (shared/site-tab.js's neighbour
  // panel-link.js, via chrome.tabs.getCurrent) rather than here off `sender.tab`:
  // that field's value for a side panel is not something this repo has measured, and
  // a guard built on a guess would silently refuse every real panel — leaving the
  // click re-opening the panel exactly as before, with nothing to show for it.
  panelPorts.set(port, null);
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PANEL_HELLO') panelPorts.set(port, msg.windowId != null ? msg.windowId : null);
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; panelPorts.delete(port); });
});

const panelOpenIn = (windowId) => {
  if (windowId == null) return false;
  for (const id of panelPorts.values()) if (id === windowId) return true;
  return false;
};

// The bound target only ever names a tab that exists: the one way it stops existing
// is this event. (A target that merely lost its grant is KEPT — one toolbar click on
// it and the panel picks up where it was.)
chrome.tabs.onRemoved.addListener((tabId) => {
  SiteTab.forgetTab(tabId).catch(() => { /* best effort — a stale binding self-heals */ });
});

// The panel's own window: ONE of it. A second click focuses the open one rather
// than stacking copies of the same document.
async function openPanelWindow() {
  const open = await ViewMode.panelWindowId();
  if (open != null) {
    try { await chrome.windows.update(open, { focused: true }); return open; } catch { /* it is gone */ }
  }
  const win = await chrome.windows.create({
    url: ViewMode.panelUrl(),
    type: 'popup',
    width: ViewMode.WINDOW_SIZE.width,
    height: ViewMode.WINDOW_SIZE.height,
  });
  const id = win && win.id != null ? win.id : null;
  await ViewMode.rememberPanelWindow(id);
  return id;
}

// The toolbar icon's whole job since #198: open the panel. Which SURFACE that is
// is the only thing #208 added. Also the e2e's entry point — a real toolbar click
// cannot be scripted (same precedent as the site-access scenarios).
async function openPreferredSurface(tab) {
  if ((await ViewMode.mode()) === 'window') return openPanelWindow();
  // The gesture is spent by the await above, so Chrome may refuse this — which is
  // survivable exactly here: side-panel mode means `openPanelOnActionClick` is on
  // and Chrome had already opened the panel itself.
  openSidePanelFor(tab);
  return null;
}

chrome.action.onClicked.addListener((tab) => {
  // The click IS the tester pointing at the page they are testing, so bind it as
  // the target: from here a detour onto a page we may not touch — a chrome:// page,
  // a new tab — no longer loses the site under test (shared/site-tab.js).
  if (tab) SiteTab.rememberTab(tab).catch(() => { /* a storage hiccup must not break the click */ });
  // A step recording blinded by a cross-origin navigation revives on its own via
  // tabs.onUpdated's `complete` once the tab is reachable again — no retry needed here.
  // A warm worker knows the answer already and keeps the gesture; a worker woken
  // BY this click does not, and takes the awaited path — where side-panel mode is
  // Chrome's own business anyway (see the note above).
  if (viewModeCache === 'sidepanel') { openSidePanelFor(tab); return; }
  openPreferredSurface(tab);
});

// Which NORMAL window the site under test is in — the one thing a panel living in
// its own popup cannot work out for itself (shared/site-tab.js resolves against
// it). Popups are ignored on purpose: ours is one, and so is anything else the
// tester opened as one.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win && win.type === 'normal') await ViewMode.rememberNormalWindow(win.id);
  } catch { /* the window went away between the event and the read */ }
});

// A closed panel window must not be focused again on the next click.
chrome.windows.onRemoved.addListener((windowId) => { ViewMode.forgetPanelWindow(windowId); });

// The panel document asks for its own window when the tester presses "Open in
// window": the surface is created here, and the panel closes itself after.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'VIEW_OPEN_WINDOW') return undefined;
  openPanelWindow()
    .then((id) => sendResponse({ ok: id != null, windowId: id }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// The annotator overlay is a content script (isolated world) that reads/writes
// the SAME chrome.storage.session handoff key as the editor-tab fallback. Session
// storage defaults to TRUSTED_CONTEXTS only, so open it to content scripts.
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }); } catch { /* older Chrome */ }

// ============================ Screenshot capture ===========================
// Two paths since #198. A VIEWPORT shot is chrome.tabs.captureVisibleTab —
// `<all_urls>` is held from install, which is exactly what that API requires, so
// the common capture raises no debugger banner at all. A FULL PAGE shot still
// needs the DevTools protocol (`Page.captureScreenshot` + captureBeyondViewport),
// on a TEMPORARY attach -> capture -> detach; since #123 the evidence recorder
// holds no session of its own, so this is the only chrome.debugger user left.
// `beyondViewport` selects between the two.

// #101: Chrome refuses the debugger on a NORMAL http(s) tab as soon as another
// extension has a frame in it — measured: attaching by targetId is refused the
// same way, an already-open session starts failing the moment such a frame
// appears, and it works again once the frame is gone. Its raw message names a
// chrome-extension:// url the tester never opened, so the capture blamed site
// access instead. Since #123 this hits the screenshot ALONE — the recorder no
// longer attaches, which is the whole point of that issue.
const DBG_FOREIGN_FRAME = 'Another extension has a frame on this page, so Chrome blocks the debugger this needs — turn that extension off for this page (or use a clean profile) and try again.';
// …and the SAME refusal when the rescue below is one permission away from working.
// captureVisibleTab is allowed under `activeTab` (what a toolbar click leaves) or
// <all_urls>, never under a per-origin grant — so a tester who allowed this site
// permanently and has not clicked the icon on this tab is told the thing that
// actually works, instead of being sent off to disable someone else's extension.
const DBG_FOREIGN_FRAME_CLICK = 'Another extension has a frame on this page, so Chrome blocks the debugger a full screenshot needs — click the Testomat icon in the toolbar and try again, and the panel will shoot the visible page instead.';
const dbgIsForeignFrame = (msg) => /chrome-extension:\/\/ URL of different extension/.test(String(msg || ''));
// Chrome's own wording for "captureVisibleTab needs activeTab or <all_urls>" —
// the ONE rescue failure a toolbar click fixes, told apart from a real one.
const capNeedsGrant = (msg) => /all_urls|activeTab/.test(String(msg || ''));

// The one place a chrome.debugger failure becomes an Error: the raw refusal is
// rewritten, and `foreignFrame` lets the capture path try its viewport rescue.
function dbgError(msg) {
  const foreign = dbgIsForeignFrame(msg);
  const err = new Error(foreign ? DBG_FOREIGN_FRAME : String(msg));
  if (foreign) err.foreignFrame = true;
  return err;
}

function dbgSendCmd(tabId, cmd, cmdParams = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, cmd, cmdParams, (res) => {
      if (chrome.runtime.lastError) reject(dbgError(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(dbgError(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function dbgDetach(tabId) {
  return new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
}

// The viewport shot, and the #101 rescue for the one capture the debugger cannot
// do (a tab carrying another extension's frame). captureVisibleTab shoots whatever
// tab is ACTIVE in the window — hence the guard — and returns null (not an error)
// whenever Chrome refuses it, so the caller can fall back or rethrow. Refusals are
// rare but real: an inactive tab, and the per-second capture quota.
function captureVisible(tab) {
  return new Promise((resolve) => {
    if (!chrome.tabs.captureVisibleTab) { resolve({ error: 'captureVisibleTab unavailable' }); return; }
    if (!tab || !tab.active || tab.windowId == null) { resolve({ error: 'the tab is not the visible one' }); return; }
    try {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }, (dataUrl) => {
        const msg = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (dataUrl) { resolve({ dataUrl }); return; }
        resolve({ error: msg || 'no image', needsGrant: capNeedsGrant(msg) });
      });
    } catch (e) {
      // Some builds throw the permission refusal instead of reporting it — same
      // verdict either way.
      const msg = String((e && e.message) || e);
      resolve({ error: msg, needsGrant: capNeedsGrant(msg) });
    }
  });
}

// #158: the full-page shot is BOUNDED by the document Chrome measured for us,
// never by whatever the renderer ends up composing. `Page.getLayoutMetrics`
// gives `cssContentSize` = the scrollable document in CSS px; passing it back as
// an explicit `clip` (origin 0,0 — document-relative, so a scrolled page still
// starts at the top) means the surface can hold exactly ONE page and no reflow
// mid-capture can append a second copy underneath. `scale: 1` is deliberate: the
// clip scale MULTIPLIES the device scale factor, so 1 reproduces the pre-#158
// output byte for byte on a well-behaved Chrome (1265x1811 at dpr 1,
// 2530x3620 at dpr 2) — this is a fence, not a resize.
//
// `captureBeyondViewport` stays alongside it. Modern Chrome captures the whole
// clip without it, but it is the documented flag for the older builds a tester
// may still be on, and it is a no-op next to an explicit clip.
//
// Returns null when the metrics are unavailable (an older/odd build, a target
// that refuses the command) — the caller then shoots exactly as before.
async function fullPageClip(tabId) {
  try {
    const m = await dbgSendCmd(tabId, 'Page.getLayoutMetrics');
    const cs = m && (m.cssContentSize || m.contentSize);
    const width = Math.floor(cs?.width || 0);
    const height = Math.floor(cs?.height || 0);
    if (!(width > 0 && height > 0)) return null;
    return { x: 0, y: 0, width, height, scale: 1 };
  } catch { return null; }
}

// The belt to the clip's braces (#158). The owner's report — the page rendered
// TWICE, stacked, both copies complete — is a taller-than-the-document image, so
// that is what we test for and that is what we cut: decode the shot, derive the
// device scale from its OWN width against the measured document width, and drop
// everything past the document's own height. On a healthy capture the numbers
// match and the original dataUrl is returned untouched (no re-encode, no quality
// loss); only a misbehaving one pays for the redraw, and it pays with the single
// clean page the annotator has to receive.
//
// The scale comes from the WIDTH ratio rather than a devicePixelRatio read, so a
// zoomed page (whose shot is smaller than its CSS box) is absorbed instead of
// being mistaken for a duplicate. And the trigger is proportional, not a hair's
// breadth: the bug is a shot ~2x the document, while a few per cent of
// disagreement is scrollbar/rounding noise that must never cost real content off
// the bottom.
const FULLPAGE_SLACK = 4;     // px of rounding we forgive outright
const FULLPAGE_TOLERANCE = 1.1; // ...and the share of the document beyond it
async function trimToDocument(dataUrl, clip) {
  if (!clip || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { dataUrl, trimmed: false };
  }
  let bmp = null;
  try {
    bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = bmp.width / clip.width;
    const expected = Math.round(clip.height * scale);
    const limit = Math.max(expected + FULLPAGE_SLACK, Math.round(expected * FULLPAGE_TOLERANCE));
    if (!(scale > 0) || !(expected > 0) || bmp.height <= limit) return { dataUrl, trimmed: false };
    const canvas = new OffscreenCanvas(bmp.width, expected);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Chunked: fromCharCode.apply blows the argument limit on a megabyte of JPEG.
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, trimmed: true };
  } catch {
    return { dataUrl, trimmed: false }; // never lose the shot over the guard
  } finally {
    try { bmp?.close(); } catch { /* best effort */ }
  }
}

// One attach → shoot → detach. Extracted because the foreign-frame path below runs
// it TWICE: once as it stands, and once with the offending frames out of the page.
async function shootViaDebugger(tabId, beyondViewport) {
  let clip = null;
  let res;
  await dbgAttach(tabId);
  try {
    if (beyondViewport) clip = await fullPageClip(tabId);
    const shotParams = { format: 'jpeg', quality: 80, captureBeyondViewport: !!beyondViewport };
    if (clip) shotParams.clip = clip;
    res = await dbgSendCmd(tabId, 'Page.captureScreenshot', shotParams);
  } finally { await dbgDetach(tabId); }
  return { res, clip };
}

// ---- #101, cleared on the fly ---------------------------------------------
// Chrome refuses the debugger over a COMMITTED chrome-extension:// document in the
// tab — and #101 measured the other half of that sentence too: "it works again once
// the frame is gone". We hold host access to this page (resolveSiteTab said `ok`),
// which is the whole opportunity: the foreign <iframe>s can be taken out of the DOM
// for the length of one shot and put back exactly where they were, so the tester is
// asked for nothing at all.
//
// DETACHED, not hidden: `display:none` leaves the document committed and Chrome
// keeps refusing. The cost is honest and bounded — re-inserting an iframe reloads
// it, so the other extension's panel comes back fresh. That happens only on a page
// that would otherwise have produced no screenshot whatsoever.
//
// The nodes are parked on the isolated world's `window`, per frame, so the restore
// runs in the same world that removed them. `allFrames` reaches every same-origin
// frame we can script; one we cannot reach keeps its frame and the capture falls
// through to the paths below, exactly as before.
const FOREIGN_PARK = '__testomatFramesOut';

async function foreignFramesOut(tabId) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [chrome.runtime.getURL(''), FOREIGN_PARK],
      func: (mine, park) => {
        const foreign = [...document.querySelectorAll('iframe')]
          .filter((f) => {
            const src = f.src || '';
            return src.startsWith('chrome-extension://') && !src.startsWith(mine);
          });
        // Position, not just the node: an iframe put back at the end of <body> is
        // not where its owner left it.
        window[park] = foreign.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
        for (const f of foreign) f.remove();
        return foreign.length;
      },
    });
    return (out || []).reduce((n, r) => n + (r && r.result ? r.result : 0), 0);
  } catch { return 0; }
}

async function foreignFramesBack(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [FOREIGN_PARK],
      func: (park) => {
        for (const { el, parent, next } of window[park] || []) {
          try { if (parent && parent.isConnected) parent.insertBefore(el, next); } catch { /* the page moved on */ }
        }
        window[park] = null;
      },
    });
  } catch { /* the page navigated or closed — nothing left to put back */ }
}

// The shot itself. Two paths since #198: a VIEWPORT capture is
// chrome.tabs.captureVisibleTab (no debugger, no banner), and only "Full page"
// attaches the debugger. `activate` first — when the answer is the BOUND target
// rather than the tab in front of the tester, a shot of a background tab is a
// shot of a page nobody is rendering, and the viewport rescue needs it active.
async function captureShot({ beyondViewport = false } = {}) {
  // The resolver still gates: a restricted page can be captured by neither path.
  const site = await resolveSiteTab({ verb: 'captured', activate: true });
  if (site.state !== 'ok') throw new Error(site.error);
  const tabId = site.tab.id;
  // A refusal here (an inactive tab, the capture quota) falls through to the
  // debugger rather than losing the shot.
  if (!beyondViewport) {
    const cap = await captureVisible(site.tab);
    if (cap.dataUrl) return { dataUrl: cap.dataUrl, tabId };
  }
  let shot = null;
  let framesMoved = 0;
  try {
    shot = await shootViaDebugger(tabId, beyondViewport);
  } catch (e) {
    // Only the foreign-frame refusal downgrades: it can never succeed as it stands,
    // while any other debugger failure still rejects rather than silently losing
    // full page.
    if (!e || !e.foreignFrame) throw e;
    framesMoved = await foreignFramesOut(tabId);
    if (framesMoved > 0) {
      try { shot = await shootViaDebugger(tabId, beyondViewport); }
      catch { shot = null; /* re-added by its owner, or something else refuses */ }
      finally { await foreignFramesBack(tabId); }
    }
    if (!shot) {
      // Everything below is the pre-existing ladder, now the LAST resort rather
      // than the first answer: the viewport rescue, then the sentence for it.
      const cap = await captureVisible(site.tab);
      if (!cap.dataUrl) throw e;
      return { dataUrl: cap.dataUrl, tabId, viewportOnly: true };
    }
  }
  const out = await trimToDocument(`data:image/jpeg;base64,${shot.res.data}`, shot.clip);
  return { dataUrl: out.dataUrl, tabId, trimmed: out.trimmed, framesMoved };
}

// ============================ Step recorder ================================
// Records the tester's actions on the page under test as human-readable Markdown
// steps (NOT Playwright code). The content script (content/step-recorder.js) sees
// the DOM and ships each step here; THIS worker owns the canonical recording state
// in chrome.storage.session under `stepRec` — it survives an SW restart, but a
// browser restart intentionally drops it (session, not local). No chrome.debugger
// is involved (the single per-tab session stays with the evidence recorder), so
// the two recorders run in parallel.
//
// stepRec = { tabId, recording, paused, manualPause, capBonus, lastUrl, startedAt,
//             blind, entries:[{kind:'step'|'expected', text, at, action?, name?,
//             context?:{row,section,column}, manual?}],
//             needsReinject, lastNavIdx, sent }
//
// `text` is the rendered line every consumer reads; the structured fields ride
// along additively (#74 action/name/context for later consumers, #78 `manual` =
// the tester typed this expected on the indicator, not an auto nav one, #160 `at`
// = when it was pushed, which decides when it may be handed over).
//
// `sent` counts the entries already handed to the editor (#160): the recording is
// inserted LIVE, so the editor pulls finalized entries as they happen and Stop only
// flushes the tail the last pull had not reached.
//
// TWO pauses, deliberately separate: `paused` is the step cap's (cleared by
// Continue, which also grants +cap) and `manualPause` is the tester's Pause on the
// indicator (cleared by Resume alone — a detour must never buy 50 more steps).

const SR_KEY = 'stepRec';
async function srGet() { return (await chrome.storage.session.get(SR_KEY))[SR_KEY] || null; }
async function srSet(v) { await chrome.storage.session.set({ [SR_KEY]: v }); }
async function srClear() { await chrome.storage.session.remove(SR_KEY); }

// 50-step soft cap, overridable via `stepRecCap` in chrome.storage.session so e2e
// can pause the recorder cheaply. Continue grants one more cap's worth.
async function srCap() {
  const n = Number((await chrome.storage.session.get('stepRecCap')).stepRecCap);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// Append an entry honoring the cap: at the cap the recording PAUSES and drops the
// action (a forgotten recorder must not write garbage). Returns the new index, or
// -1 when dropped. Mutates `st` (caller persists).
function srPush(st, entry, cap) {
  if (st.paused || st.manualPause) return -1;
  if (st.entries.length >= cap) { st.paused = true; return -1; }
  entry.at = Date.now(); // #160: the live pull hands an entry over once it settles
  st.entries.push(entry);
  if (st.entries.length >= cap) st.paused = true;
  return st.entries.length - 1;
}

// icons.js first — the recorder's pill draws its "+ Expected" mark from the one
// set, the same order shared/capture-annotate.js injects the annotator in. The
// pill degrades to a typed "+" if the set is somehow absent, so a failure here
// costs a glyph, never the recording.
async function srInject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/icons.js', 'content/step-recorder.js'],
    });
    return true;
  } catch { return false; }
}

// BLIND = the inject failed while recording, so nothing can reach us any more.
// Since #198 that means one thing: the tab moved to a page Chrome keeps extensions
// off (chrome://, the Web Store, another extension). executeScript throws AND
// tabs.onUpdated stops carrying `changeInfo.url` there — the recorder goes deaf and
// can't even see the page change, while the editor still shows a live recording.
// Flag it (STEPREC_STATUS carries it to the editor, which names the fix) instead of
// swallowing the failure; the recording is left running because the very next
// inject that lands — the tester navigating back — revives it.
// The blind tab is always `st.tabId` — the recorder is bound to one tab.
// The inject itself stays OFF the append chain (executeScript is slow and the
// injected script's own messages take chain slots); only the state write joins it.
async function srInjectSync(tabId) {
  const ok = await srInject(tabId);
  await srSerial(async () => {
    const st = await srGet();
    if (!st || !st.recording || st.tabId !== tabId) return;
    const wasBlind = !!st.blind;
    let changed = wasBlind !== !ok;
    if (ok && wasBlind && await srCatchUpNav(st)) changed = true;
    st.blind = !ok;
    if (changed) await srSet(st);
  });
  return ok;
}

// Coming back from a blind stretch the tab may sit on a page we never saw open.
// The url is readable again, so tabs.get reveals it: emit the ONE navigation
// entry that is true — the page open RIGHT NOW. Any intermediate hop stays
// unrecorded rather than invented. Mutates `st` (caller persists).
async function srCatchUpNav(st) {
  let tab = null;
  try { tab = await chrome.tabs.get(st.tabId); } catch { return false; }
  if (!tab || !tab.url || tab.url === st.lastUrl) return false;
  // Manually paused: follow the tab, record nothing (same rule as tabs.onUpdated).
  if (st.manualPause) { st.lastUrl = tab.url; return true; }
  const cap = (await srCap()) + (st.capBonus || 0);
  srFlushOpen(st, cap);
  st.lastUrl = tab.url;
  st.lastNavIdx = srPushNav(st, `The "${srCleanTitle(tab.title, tab.url)}" page opens`, cap);
  return true;
}

// A page title is a sentence, not an element name: the element trim sliced it
// mid-word ('… – v'), so navigation titles get their own, longer cap that cuts at
// the last word/dash boundary and says so with an ellipsis (#86).
const SR_TITLE_MAX = 80;
const srTrimTitle = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= SR_TITLE_MAX) return t;
  const cut = t.slice(0, SR_TITLE_MAX);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('-'), cut.lastIndexOf('–'),
    cut.lastIndexOf('—'), cut.lastIndexOf('|'), cut.lastIndexOf('·'));
  return `${cut.slice(0, at > SR_TITLE_MAX / 2 ? at : SR_TITLE_MAX).replace(/[\s\-–—|·:;,]+$/, '')}…`;
};

const srCleanTitle = (title, url) => {
  const t = srTrimTitle(title);
  if (t) return t;
  try { return new URL(url).hostname; } catch { return url || 'the'; }
};

// One SPA navigation fires the URL/title events twice, so the same page pushed the
// same expected line twice in a row. Collapse consecutive identical AUTO
// entries onto the first one (its index, so a later title refine still lands) — a
// manual expected is the tester's own sentence and is never deduped, even verbatim.
const srDupNavIdx = (st, text) => {
  const i = st.entries.length - 1;
  const e = st.entries[i];
  return e && e.kind === 'expected' && !e.manual && e.text === text ? i : -1;
};
function srPushNav(st, text, cap) {
  const dup = srDupNavIdx(st, text);
  return dup !== -1 ? dup : srPush(st, { kind: 'expected', text }, cap);
}

async function srStart() {
  // `activate`: a recording follows ONE tab, so if the answer is the bound target
  // rather than the tab in front of the tester, put that tab in front of them —
  // recording a page they cannot see is worse than not recording at all.
  const site = await resolveSiteTab({ verb: 'recorded', activate: true });
  if (site.state !== 'ok') return { ok: false, reason: site.error };
  const tab = site.tab;
  // The `Open <url>` step is DEFERRED until the first real action/navigation, so a
  // start-then-immediately-stop records 0 entries (nothing is inserted) — the Open
  // is prepended right before the first recorded step keeps it first.
  await srSet({
    tabId: tab.id, recording: true, paused: false, manualPause: false, capBonus: 0, blind: false,
    lastUrl: tab.url, startedAt: Date.now(), pendingOpen: tab.url,
    entries: [], lastNavIdx: -1, sent: 0,
  });
  await srInjectSync(tab.id);
  return { ok: true, tabId: tab.id };
}

// Prepend the deferred `Open <url>` step before the first recorded entry.
function srFlushOpen(st, cap) {
  if (!st.pendingOpen) return;
  srPush(st, { kind: 'step', text: `Open ${st.pendingOpen}` }, cap);
  st.pendingOpen = null;
}

async function srAdd(entry, sender) {
  const st = await srGet();
  if (!st || !st.recording) return { ok: false, recording: false };
  const senderTab = sender && sender.tab && sender.tab.id;
  if (senderTab != null && st.tabId !== senderTab) return { ok: false, wrongTab: true, count: st.entries.length };
  const kind = entry && entry.kind === 'expected' ? 'expected' : 'step';
  const text = String((entry && entry.text) || '').trim();
  if (!text) return { ok: false, ...srEcho(st) };
  // Paused (either kind) drops the action BEFORE anything mutates — a deferred
  // `Open` flushed here would be dropped by the same pause and lost for good.
  if (st.paused || st.manualPause) return { ok: false, ...srEcho(st) };
  const cap = (await srCap()) + (st.capBonus || 0);
  // A dblclick supersedes the click(s) that produced it: the recorder sends the
  // exact single-click text it emitted, and those trailing twins are dropped first.
  if (entry && typeof entry.replaces === 'string') srPopTwins(st, entry.replaces);
  srFlushOpen(st, cap);
  const idx = srPush(st, srEntry(kind, text, entry), cap);
  await srSet(st);
  return { ok: idx !== -1, ...srEcho(st) };
}

// The stored entry. Field by field on purpose: `text` is the contract, the rest is
// additive data (#74/#78), and `replaces` is a wire instruction that must never
// become part of the recording.
function srEntry(kind, text, entry) {
  const e = { kind, text };
  if (entry.action) e.action = String(entry.action);
  if (entry.name) e.name = String(entry.name);
  if (entry.context && typeof entry.context === 'object') {
    const c = {};
    for (const k of ['row', 'section', 'column']) if (entry.context[k]) c[k] = String(entry.context[k]);
    if (Object.keys(c).length) e.context = c;
  }
  if (kind === 'expected' && entry.manual) e.manual = true; // typed by the tester, not a navigation
  return e;
}

// A real double-click fires click, click, dblclick — so up to TWO identical
// entries precede it. Matching on the text keeps this honest: a control that
// renamed itself between the clicks keeps both steps rather than losing one.
function srPopTwins(st, text) {
  for (let i = 0; i < 2; i++) {
    const last = st.entries[st.entries.length - 1];
    if (!last || last.text !== text) break;
    if (st.entries.length <= (st.sent || 0)) break; // already in the editor — never unwrite it (#160)
    st.entries.pop();
    if (st.lastNavIdx >= st.entries.length) st.lastNavIdx = -1;
  }
}

// The state every ADD/STATUS reply echoes back to the content script.
const srEcho = (st) => ({
  count: st.entries.length, paused: !!st.paused, manualPause: !!st.manualPause, recording: true,
});

async function srStatus() {
  const st = await srGet();
  if (!st) return { recording: false, count: 0, paused: false, manualPause: false };
  // `blind` rides along so the editor's existing poll can warn without a new message.
  return { recording: !!st.recording, count: st.entries.length, paused: !!st.paused,
    manualPause: !!st.manualPause, blind: !!st.blind, tabId: st.tabId };
}

// Manual Pause/Resume from the on-page indicator. Distinct from the cap pause on
// purpose: Resume just clears the flag, it never grants the +cap that Continue does.
async function srPause(on) {
  const st = await srGet();
  if (!st) return { ok: false };
  st.manualPause = !!on;
  await srSet(st);
  return { ok: true, manualPause: st.manualPause, count: st.entries.length, paused: !!st.paused };
}

async function srStopRequest() {
  const st = await srGet();
  if (st && st.recording) { st.recording = false; await srSet(st); }
  return { ok: true };
}

async function srContinue() {
  const st = await srGet();
  if (!st) return { ok: false };
  st.capBonus = (st.capBonus || 0) + (await srCap());
  st.paused = false;
  await srSet(st);
  return { ok: true };
}

// ---- live hand-over (#160) -------------------------------------------------
// Each action reaches the open editor as it happens, so an entry may only be
// handed over once it can no longer change here. Exactly two things still rewrite
// the tail: a dblclick pops its own click twins (milliseconds later), and a
// navigation entry is rewritten when the page's real title lands (up to a load
// away — hence the longer window, after which the URL-derived title stands).
const SR_SETTLE_MS = 700;
const SR_NAV_SETTLE_MS = 3000;

// The first index that is NOT final yet; everything before it may be handed over.
function srFinalEnd(st, now) {
  const es = st.entries || [];
  for (let i = 0; i < es.length; i++) {
    const age = now - (es[i].at || 0);
    if (age < SR_SETTLE_MS) return i;
    if (i === st.lastNavIdx && age < SR_NAV_SETTLE_MS) return i;
  }
  return es.length;
}

// The editor's poll: the finalized entries it has not seen + the status it used to
// read through STEPREC_STATUS (one message per tick, not two).
async function srPull() {
  const st = await srGet();
  if (!st) return { entries: [], recording: false, count: 0, paused: false, manualPause: false };
  const sent = st.sent || 0;
  const end = srFinalEnd(st, Date.now());
  const entries = end > sent ? st.entries.slice(sent, end) : [];
  if (entries.length) { st.sent = end; await srSet(st); }
  return { entries, recording: !!st.recording, count: st.entries.length, paused: !!st.paused,
    manualPause: !!st.manualPause, blind: !!st.blind, tabId: st.tabId };
}

// Drain: return what the live pull had not handed over yet and clear the state.
// The editor is the sole consumer — it appends the tail to the open test.
// Idempotent (empty on re-drain).
async function srStop() {
  const st = await srGet();
  await srClear();
  return { ok: true, entries: (st && st.entries ? st.entries.slice(st.sent || 0) : []) };
}

// Chrome fills tab.title with a URL-derived placeholder (host+path) until the real
// <title> parses. Detect that so we keep waiting for the real title instead of
// locking in the placeholder.
function srIsUrlTitle(title, url) {
  const t = (title || '').trim();
  if (!t) return true;
  try {
    const u = new URL(url);
    const bare = (u.host + u.pathname + u.search).replace(/\/+$/, '');
    return t.replace(/\/+$/, '') === bare || u.href.includes(t) || t.includes(u.host);
  } catch { return false; }
}

// Refine the last navigation entry once a REAL page title arrives (the title lands
// after the URL change — via a later onUpdated, or the re-injected content script
// reporting document.title). A URL-derived placeholder is ignored; the first real
// title wins and then stops rewriting.
function srRefineNav(st, title, url) {
  if (st.lastNavIdx == null || st.lastNavIdx < 0) return false;
  const e = st.entries[st.lastNavIdx];
  if (!e) return false;
  // Handed over already (the title outran its settle window): the line is the
  // editor's now, so leave it standing rather than rewriting only our copy (#160).
  if (st.lastNavIdx < (st.sent || 0)) { st.lastNavIdx = -1; return false; }
  const t = (title || '').replace(/\s+/g, ' ').trim();
  if (!t || srIsUrlTitle(t, url || st.lastUrl)) return false;
  e.text = `The "${srTrimTitle(t)}" page opens`;
  // The refine itself can produce the twin (the first of the two events carried the
  // stale title): the entry it just rewrote is the last one, so drop it.
  const prev = st.entries[st.entries.length - 2];
  if (st.lastNavIdx === st.entries.length - 1 && prev && prev.kind === 'expected'
    && !prev.manual && prev.text === e.text) st.entries.pop();
  st.lastNavIdx = -1;
  return true;
}

// The re-injected content script reports its page's document.title — the most
// reliable source after a navigation (independent of tab.title timing).
async function srTitle(title) {
  await srSerial(async () => {
    const st = await srGet();
    if (st && st.recording && srRefineNav(st, title, st.lastUrl)) await srSet(st);
  });
  return { ok: true };
}

// URL changes on the recorded tab (full loads AND SPA pushState) surface via
// tabs.onUpdated: the transition emits an `expected` entry ("The <title> page
// opens"), which the drain hangs under the step that caused it (#91). A full load
// kills the content script, so it is re-injected on every
// `complete` (the double-init guard makes a same-document re-inject a no-op); the
// fresh script reports its real document.title (STEPREC_TITLE) to refine the
// entry — decoupled from this event's timing, since tab.title lags the load.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // ON THE APPEND CHAIN: one SPA navigation delivers its url and title events
  // microseconds apart, and this is a read-modify-write on storage.session — run
  // unserialized (as it was), the title handler reads the pre-push snapshot and
  // the refine is lost, leaving the stale title standing next to the real one.
  // The re-inject must live INSIDE this same recording/tab check — otherwise every
  // tab's every page load injects the indicator, which then tears itself down a
  // poll later (no `stepRec` to reflect): a flash on every navigation, recorder or not.
  let reinject = false;
  await srSerial(async () => {
    const st = await srGet();
    if (!st || !st.recording || st.tabId !== tabId) return;
    reinject = changeInfo.status === 'complete';
    let changed = false;
    if (changeInfo.url && changeInfo.url !== st.lastUrl) {
      if (st.manualPause) {
        // A manual pause covers the detour's navigations too: follow where the tab
        // went, record nothing, and keep the deferred Open for the resume.
        st.lastUrl = changeInfo.url;
        changed = true;
      } else {
        const cap = (await srCap()) + (st.capBonus || 0);
        srFlushOpen(st, cap); // the page being left is the first page → emit its Open
        st.lastUrl = changeInfo.url;
        st.lastNavIdx = srPushNav(st, `The "${srCleanTitle(tab && tab.title, changeInfo.url)}" page opens`, cap);
        changed = true;
      }
    }
    if (changeInfo.title && srRefineNav(st, changeInfo.title, st.lastUrl)) changed = true;
    if (changed) await srSet(st);
  });
  if (reinject) await srInjectSync(tabId);
});

// Closing the recorded tab auto-stops (recording=false); the editor's poll drains
// the entries and inserts them. Entries are preserved for that drain.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await srGet();
  if (st && st.tabId === tabId && st.recording) { st.recording = false; await srSet(st); }
});

// Appends run through ONE chain: `stepRec` is a read-modify-write on
// storage.session, and a double-click fires three messages within milliseconds —
// concurrent handlers would drop entries (same reason the panel serializes step
// writes). Reads (STATUS/PEEK) need no slot.
let srChain = Promise.resolve();
function srSerial(fn) {
  const next = srChain.then(fn, fn);
  srChain = next.catch(() => { /* keep the chain alive */ });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'STEPREC_START': srStart().then(sendResponse); return true;
    case 'STEPREC_ADD': srSerial(() => srAdd(msg.entry, sender)).then(sendResponse); return true;
    case 'STEPREC_STATUS': srStatus().then(sendResponse); return true;
    // The editor's live poll (#160) — a read-modify-write, so it takes a chain slot.
    case 'STEPREC_PULL': srSerial(srPull).then(sendResponse); return true;
    case 'STEPREC_TITLE': srTitle(msg.title).then(sendResponse); return true;
    // Test seam (no production sender): the e2e step-recorder scenario reads the
    // raw entries mid-recording, which STEPREC_STATUS does not expose.
    case 'STEPREC_PEEK': srGet().then((st) => sendResponse({ entries: (st && st.entries) || [] })); return true;
    // On the chain too: it reads `sent` a pull may be writing in the same tick.
    case 'STEPREC_STOP': srSerial(srStop).then(sendResponse); return true;
    case 'STEPREC_STOP_REQUEST': srStopRequest().then(sendResponse); return true;
    case 'STEPREC_CONTINUE': srContinue().then(sendResponse); return true;
    case 'STEPREC_PAUSE': srPause(msg.on).then(sendResponse); return true;
    default: return undefined;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'captureTab') {
    // `fullPage` picks the debugger path (captureBeyondViewport, clipped to the
    // measured document since #158); without it the shot is captureVisibleTab
    // (#198). The JPEG dataUrl + captured tab id ride back so the annotator overlay
    // injects into it. A debugger failure rejects and never downgrades — except the
    // one refusal that can never be retried (#101), which comes back as
    // `viewportOnly`. `trimmed` reports the #158 guard having cut a doubled shot
    // back to one page (diagnostics — the image is already correct).
    captureShot({ beyondViewport: !!msg.fullPage })
      // `framesMoved` = how many foreign frames had to be lifted out of the page to
      // get this shot (#101). Diagnostics: the image is a normal full-quality one.
      .then((r) => sendResponse({
        ok: true, dataUrl: r.dataUrl, tabId: r.tabId, viewportOnly: !!r.viewportOnly, trimmed: !!r.trimmed,
        framesMoved: r.framesMoved || 0,
      }))
      // `needsGrant`: the failure a toolbar click fixes (#101 rescue, above) — the
      // panel pends the retry on it instead of leaving the tester at a dead end.
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), needsGrant: !!e?.needsGrant }));
    return true; // async response
  }
});
