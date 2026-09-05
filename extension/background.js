// Service worker: panel surface, screenshot capture, step recorder, screen recording.
// The evidence recorder holds NO chrome.debugger session; a debugger call here is a screenshot's,
// or the screen recording fallback's (screenrec/session.js), which holds one while it records.

/* global resolveSiteTab, ViewMode, SiteTab, evStopIfRecording, ShotStore, StepRecCore, DbgErrors,
   FullpageTrim, PresenceMatch */

importScripts('shared/view-mode.js', 'shared/site-tab.js', 'shared/shot-store.js',
  'shared/step-rec-core.js', 'shared/dbg-errors.js', 'shared/fullpage-trim.js',
  'shared/presence-match.js', 'evidence/buffer.js', 'evidence/recorder.js',
  'screenrec/parked.js', 'screenrec/claim.js', 'screenrec/session.js');

// ======================= Panel surface: side panel / window =================
// `sidePanel.open()` may only run before the first await (the gesture must still be on the stack), so
// the preference is mirrored onto `openPanelOnActionClick`; `windows.create` needs no gesture.

// Last storage read, so a WARM worker can branch before its first await. null = not read yet.
let viewModeCache = null;

// Chrome persists this flag per installation, so the mirror also overrides what an older build stored.
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

// Open only where there is NO panel yet: re-opening resets the panel document to default_path.
// The registry is read synchronously — the gesture is gone at the first await.
function openSidePanelFor(tab) {
  if (!tab || tab.windowId == null) return;
  if (panelOpenIn(tab.windowId)) return;
  try { chrome.sidePanel.open({ windowId: tab.windowId })?.catch(() => {}); } catch { /* older Chrome */ }
}

// ---- open panels, per window ----------------------------------------------
// A live port registry, not a stored flag: readable before the first await, and a port dies with its document.
const panelPorts = new Map(); // port -> windowId (null until PANEL_HELLO lands)

// ---- live panel DOCUMENTS, whatever surface hosts them ---------------------
// Deliberately NOT `panelPorts`, which counts the toolbar-icon surface alone: this registry takes
// every document hosting the panel — side panel, our own window, a tab — because that, and not the
// side panel, is what holds the testrun a recording belongs to (rec scoped to its testrun).
const panelDocPorts = new Set();
const PANEL_DOC_GRACE_MS = 2000;
let panelDocGraceTimer = null;

// Switching surfaces and reloading the panel both close one document BEFORE the next one opens, so
// an empty registry waits out a grace the replacement lands inside; only a real close runs it out.
function panelDocsChanged() {
  if (panelDocGraceTimer) { clearTimeout(panelDocGraceTimer); panelDocGraceTimer = null; }
  if (panelDocPorts.size) return;
  panelDocGraceTimer = setTimeout(() => {
    panelDocGraceTimer = null;
    if (!panelDocPorts.size) evStopIfRecording('panel-closed');
  }, PANEL_DOC_GRACE_MS);
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port) return;
  if (port.name === 'panel-doc') {
    panelDocPorts.add(port);
    panelDocsChanged();
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      panelDocPorts.delete(port);
      panelDocsChanged();
    });
    return;
  }
  if (port.name !== 'panel') return;
  // Panel-vs-tab is decided on the CONNECTING side (panel-link.js, chrome.tabs.getCurrent):
  // `sender.tab` for a side panel is unmeasured here, and a wrong guess would refuse every real panel.
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

// Forget the bound target only when its tab is gone; one that merely lost its grant is KEPT.
chrome.tabs.onRemoved.addListener((tabId) => {
  SiteTab.forgetTab(tabId).catch(() => { /* best effort — a stale binding self-heals */ });
});

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

// Also the e2e's entry point — a real toolbar click cannot be scripted.
async function openPreferredSurface(tab) {
  if ((await ViewMode.mode()) === 'window') return openPanelWindow();
  // The await above spends the gesture, so Chrome may refuse this — survivable here:
  // in side-panel mode `openPanelOnActionClick` already had Chrome open the panel itself.
  openSidePanelFor(tab);
  return null;
}

chrome.action.onClicked.addListener((tab) => {
  // Bind the clicked tab as the target, so a later detour onto a page we may not touch
  // (chrome://, a new tab) does not lose the site under test.
  if (tab) SiteTab.rememberTab(tab).catch(() => { /* a storage hiccup must not break the click */ });
  // A blinded step recording revives itself via tabs.onUpdated `complete` — no retry needed here.
  // A warm worker still holds the gesture; one woken BY this click takes the awaited path.
  if (viewModeCache === 'sidepanel') { openSidePanelFor(tab); return; }
  openPreferredSurface(tab);
});

// Track the last NORMAL window: a panel living in its own popup cannot work out where the
// site under test is. Popups are ignored on purpose — ours is one.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win && win.type === 'normal') await ViewMode.rememberNormalWindow(win.id);
  } catch { /* the window went away between the event and the read */ }
});

// A closed panel window must not be focused again on the next click.
chrome.windows.onRemoved.addListener((windowId) => { ViewMode.forgetPanelWindow(windowId); });

// "Open in window" from the panel document; the panel closes itself afterwards.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'VIEW_OPEN_WINDOW') return undefined;
  openPanelWindow()
    .then((id) => sendResponse({ ok: id != null, windowId: id }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// "Run in Extension" (#14): the surface opens FIRST and synchronously — the click's gesture dies at
// the first await. No rememberTab() either: the sender is the web app, never the site under test.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'OPEN_RUN') return undefined;
  if (viewModeCache === 'sidepanel') openSidePanelFor(sender?.tab);
  else openPreferredSurface(sender?.tab);
  chrome.storage.session.set({ openRunIntent: { url: String(msg.url || ''), at: Date.now() } })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// storage.session defaults to TRUSTED_CONTEXTS only; the annotator and file-overlay content
// scripts read their handoff keys there, so it must be opened to untrusted contexts.
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }); } catch { /* older Chrome */ }

// ==================== Staged screenshots: orphan sweep =====================
// An editor draft dies with the browser session; the shots it staged sit in IndexedDB, which doesn't.
const SHOTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function sweepStagedShots() {
  try {
    const all = await chrome.storage.session.get(null);
    await ShotStore.sweep(Object.keys(all).filter((k) => k.startsWith('editorDraft:')), SHOTS_MAX_AGE_MS);
  } catch { /* best effort — a sweep that missed runs again next startup */ }
}
chrome.runtime.onStartup.addListener(sweepStagedShots);
chrome.runtime.onInstalled.addListener(sweepStagedShots);

// ============================ File overlay (#21) ===========================
// The panel's tiles open a file OVER the page under test: a popup window cannot float above a
// fullscreen browser, and an extension frame keeps the session the file behind the login needs.

const FILE_OVERLAY_KEY = 'fileOverlay';

function viewerPageUrl(file) {
  const q = new URLSearchParams({ url: file.url, name: file.name, type: file.type });
  return chrome.runtime.getURL(`viewer/viewer.html?${q}`);
}

// `activate`: an overlay on a background tab is an overlay nobody sees. A page no extension may
// script (chrome://, the Web Store, the PDF viewer) throws at the inject and gets a tab instead.
async function openFileOverlay(msg) {
  const file = {
    url: String((msg && msg.url) || ''),
    name: String((msg && msg.name) || ''),
    type: String((msg && msg.mime) || ''),
    at: Date.now(),
  };
  if (!file.url) return { ok: false, error: 'no file' };
  await chrome.storage.session.set({ [FILE_OVERLAY_KEY]: file });
  const site = await resolveSiteTab({ verb: 'shown', activate: true });
  const tabId = site.tab && site.tab.id != null ? site.tab.id : null;
  if (tabId != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/file-overlay.js'] });
      return { ok: true, overlay: true, tabId };
    } catch { /* restricted page — fall through to a tab of its own */ }
  }
  const tab = await chrome.tabs.create({ url: viewerPageUrl(file) });
  return { ok: true, overlay: false, tabId: tab && tab.id != null ? tab.id : null };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'OPEN_FILE_OVERLAY') return undefined;
  openFileOverlay(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

// ============================ Screenshot capture ===========================
// A VIEWPORT shot is chrome.tabs.captureVisibleTab (no debugger banner); FULL PAGE needs the
// DevTools protocol on a temporary attach -> capture -> detach. `beyondViewport` picks.

// The refusals and their copy live in shared/dbg-errors.js; screenrec/session.js reads the bare
// `dbgIsForeignFrame` from here, at call time, exactly as it did before the move.
const { dbgIsForeignFrame, capNeedsGrant, dbgError,
  DBG_FOREIGN_FRAME, DBG_FOREIGN_FRAME_CLICK } = DbgErrors;

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

// captureVisibleTab shoots whatever tab is ACTIVE in the window (hence the guard) and refuses on
// an inactive tab or the per-second quota — reported as a value, never thrown, so callers can fall back.
// The timeout is not paranoia: on an occluded or minimised window Chrome can leave the callback
// UNCALLED, and without a floor under it the panel sits on "Capturing tab…" for good.
const CAPTURE_VISIBLE_TIMEOUT_MS = 8000;

function captureVisible(tab) {
  return Promise.race([
    captureVisibleNow(tab),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'the tab did not answer the capture' }), CAPTURE_VISIBLE_TIMEOUT_MS)),
  ]);
}

function captureVisibleNow(tab) {
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
      // Some builds throw the permission refusal instead of reporting it.
      const msg = String((e && e.message) || e);
      resolve({ error: msg, needsGrant: capNeedsGrant(msg) });
    }
  });
}

// #158: `Page.getLayoutMetrics`'s cssContentSize as an explicit clip (origin 0,0 is document-relative)
// fences the shot to ONE page; the clip `scale` MULTIPLIES the device scale factor, so 1 is no resize.
// Chromium's maximum texture dimension: past it the compose cannot succeed, so a taller page is
// cut here and the clip says it was cut — the alternative is a capture that fails with no reason.
const FULLPAGE_MAX_HEIGHT = 16384;

async function fullPageClip(tabId) {
  try {
    const m = await dbgSendCmd(tabId, 'Page.getLayoutMetrics');
    const cs = m && (m.cssContentSize || m.contentSize);
    const width = Math.floor(cs?.width || 0);
    const full = Math.floor(cs?.height || 0);
    if (!(width > 0 && full > 0)) return null;
    const height = Math.min(full, FULLPAGE_MAX_HEIGHT);
    const clip = { x: 0, y: 0, width, height, scale: 1 };
    if (height < full) clip.heightClipped = true;
    return clip;
  } catch { return null; }
}

// The double-compose guard lives in shared/fullpage-trim.js.
const { trimToDocument, overshoot, FULLPAGE_SLACK, FULLPAGE_TOLERANCE } = FullpageTrim;

// One attach → shoot → detach (the foreign-frame path below runs it twice).
// `captureBeyondViewport` is kept for older Chrome builds; it is a no-op next to an explicit clip.
async function shootViaDebugger(tabId, beyondViewport) {
  let clip = null;
  let res;
  // A cast recording already holds the attach on this tab: share it, and leave it standing.
  // Awaited: right after a worker restart the mirror is still null and says there is no recording.
  const shared = typeof srecCastOwnsReady === 'function' && await srecCastOwnsReady(tabId);
  if (!shared) await dbgAttach(tabId);
  try {
    if (beyondViewport) clip = await fullPageClip(tabId);
    const shotParams = { format: 'jpeg', quality: 80, captureBeyondViewport: !!beyondViewport };
    // By field: `heightClipped` is ours to carry, not a Page.Viewport the protocol asked for.
    if (clip) shotParams.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale };
    res = await dbgSendCmd(tabId, 'Page.captureScreenshot', shotParams);
  } finally { if (!shared) await dbgDetach(tabId); }
  return { res, clip };
}

// ---- #101, cleared on the fly ---------------------------------------------
// Foreign frames are DETACHED, not hidden: `display:none` leaves the document committed and Chrome
// keeps refusing. Re-inserting an iframe reloads it — the price of a shot that would not exist.
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
        // Position, not just the node: an iframe put back at the end of <body> is not where it was.
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

// `activate` first: a background tab is a page nobody is rendering, and the viewport
// rescue only works on the active tab.
async function captureShot({ beyondViewport = false } = {}) {
  // The resolver still gates: a restricted page can be captured by neither path.
  const site = await resolveSiteTab({ verb: 'captured', activate: true });
  if (site.state !== 'ok') throw new Error(site.error);
  const tabId = site.tab.id;
  // A refusal here (inactive tab, capture quota) falls through to the debugger rather than losing the shot.
  if (!beyondViewport) {
    const cap = await captureVisible(site.tab);
    if (cap.dataUrl) return { dataUrl: cap.dataUrl, tabId };
  }
  let shot = null;
  let framesMoved = 0;
  try {
    shot = await shootViaDebugger(tabId, beyondViewport);
  } catch (e) {
    // Only the foreign-frame refusal downgrades; any other debugger failure still rejects.
    if (!e || !e.foreignFrame) throw e;
    framesMoved = await foreignFramesOut(tabId);
    if (framesMoved > 0) {
      try { shot = await shootViaDebugger(tabId, beyondViewport); }
      catch { shot = null; /* re-added by its owner, or something else refuses */ }
      finally { await foreignFramesBack(tabId); }
    }
    if (!shot) {
      const cap = await captureVisible(site.tab);
      if (!cap.dataUrl) throw e;
      return { dataUrl: cap.dataUrl, tabId, viewportOnly: true };
    }
  }
  const out = await trimToDocument(`data:image/jpeg;base64,${shot.res.data}`, shot.clip);
  return { dataUrl: out.dataUrl, tabId, trimmed: out.trimmed, framesMoved, heightClipped: !!shot.clip?.heightClipped };
}

// ============================ Step recorder ================================
// State lives in chrome.storage.session `stepRec`: survives an SW restart, dropped on browser restart.

// The ordering rules live in shared/step-rec-core.js; the bare names keep this file's call sites.
const { srPush, srPlace, srEntry, srPopTwins, srPushNav, srDupNavIdx, srFlushOpen, srFinalEnd,
  srRefineNav, srIsUrlTitle, srTrimTitle, srCleanTitle, srOpenUrl,
  SR_TITLE_MAX, SR_NAV_LEAD_MS, SR_SETTLE_MS, SR_NAV_SETTLE_MS } = StepRecCore;

const SR_KEY = 'stepRec';
async function srGet() { return (await chrome.storage.session.get(SR_KEY))[SR_KEY] || null; }
async function srSet(v) { await chrome.storage.session.set({ [SR_KEY]: v }); }
async function srClear() { await chrome.storage.session.remove(SR_KEY); }

// 50-step soft cap; `stepRecCap` in storage.session overrides it (e2e seam). Continue grants one more cap.
async function srCap() {
  const n = Number((await chrome.storage.session.get('stepRecCap')).stepRecCap);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// icons.js FIRST: the pill's "+ Expected" glyph comes from that set (same order as capture-annotate.js).
// `allFrames`: an embedded form is where the steps go missing; one frame refusing injection is not a blind tab.
async function srInject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['shared/icons.js', 'content/rec-naming.js', 'content/rec-mask.js', 'content/rec-packet.js', 'content/rec-outbox.js', 'content/rec-pill.js', 'content/step-recorder.js'],
    });
    return true;
  } catch { return false; }
}

// BLIND: on a page Chrome keeps extensions off, executeScript throws AND tabs.onUpdated stops carrying
// `changeInfo.url`. The slow inject stays OFF the append chain; only the state write joins it.
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

// After a blind stretch, emit only the page open NOW — intermediate hops stay unrecorded
// rather than invented. Mutates `st` (caller persists).
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

async function srStart(sender) {
  // `activate`: a recording follows ONE tab, so bring that tab in front of the tester.
  const site = await resolveSiteTab({ verb: 'recorded', activate: true });
  if (site.state !== 'ok') return { ok: false, reason: site.error };
  const tab = site.tab;
  const { settings } = await chrome.storage.local.get('settings');
  // The `Open <url>` step is DEFERRED to the first real action, so start-then-stop records nothing.
  await srSet({
    tabId: tab.id, recording: true, paused: false, manualPause: false, capBonus: 0, blind: false,
    docIds: await srOwnerIds(sender), // the editor document that owns this recording
    lastUrl: tab.url, startedAt: Date.now(),
    pendingOpen: srOpenUrl(tab.url, !!(settings && settings.envFullUrl === true)),
    entries: [], lastNavIdx: -1, sent: 0,
  });
  await srInjectSync(tab.id);
  return { ok: true, tabId: tab.id };
}

// The owner's document id: a tab-hosted page's sender carries it, a side panel's sender has only its
// URL — so that document is looked up by URL (exact match, query included). [] when it cannot be told.
async function srOwnerIds(sender) {
  if (sender && sender.documentId) return [sender.documentId];
  if (!sender || !sender.url) return [];
  try { return (await chrome.runtime.getContexts({ documentUrls: [sender.url] })).map((c) => c.documentId).filter(Boolean); }
  catch { return []; }
}

// A recording belongs to the editor page that started it. Closing the panel (or the editor's own tab
// or window) tears that page down with no unload, so the worker asks Chrome whether it is still there.
async function srOwnerOpen(st) {
  if (!st.docIds || !st.docIds.length) return true; // nothing to check — never end a live recording on a guess
  try { return (await chrome.runtime.getContexts({ documentIds: st.docIds })).length > 0; }
  catch { return true; }
}

// Ends a recording whose editor is gone (entries kept, as on tab close). True when it did.
async function srOrphaned() {
  const st = await srGet();
  if (!st || !st.recording || await srOwnerOpen(st)) return false;
  await srSerial(async () => {
    const cur = await srGet();
    if (cur && cur.recording) { cur.recording = false; await srSet(cur); }
  });
  return true;
}

async function srAdd(entry, sender) {
  const st = await srGet();
  if (!st || !st.recording) return { ok: false, recording: false };
  const senderTab = sender && sender.tab && sender.tab.id;
  if (senderTab != null && st.tabId !== senderTab) return { ok: false, wrongTab: true, count: st.entries.length };
  const kind = entry && entry.kind === 'expected' ? 'expected' : 'step';
  const text = String((entry && entry.text) || '').trim();
  if (!text) return { ok: false, ...srEcho(st) };
  // Pause is checked BEFORE any mutation: a deferred `Open` flushed here would be dropped and lost.
  if (st.paused || st.manualPause) return { ok: false, ...srEcho(st) };
  const cap = (await srCap()) + (st.capBonus || 0);
  // A dblclick supersedes the click(s) that produced it — those trailing twins are dropped first.
  if (entry && typeof entry.replaces === 'string') srPopTwins(st, entry.replaces);
  srFlushOpen(st, cap);
  const idx = srPlace(st, srEntry(kind, text, entry), cap);
  await srSet(st);
  return { ok: idx !== -1, ...srEcho(st) };
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

// Manual Pause/Resume, distinct from the cap pause on purpose: Resume only clears the flag,
// it never grants the +cap that Continue does.
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

// A `type` is written only when the field blurs, so the field the caret sits in is still unrecorded
// when Stop arrives (#62) — the tab is asked for it first. A closed, asleep or un-injected tab never
// answers, and Stop must proceed exactly as it does today, hence the timeout around the ask.
const SR_FLUSH_MS = 700;
async function srFlush() {
  const st = await srGet();
  if (!st || !st.recording || st.blind) return { ok: true };
  try {
    await Promise.race([
      chrome.tabs.sendMessage(st.tabId, { type: 'STEPREC_FLUSH_NOW' }),
      new Promise((resolve) => setTimeout(resolve, SR_FLUSH_MS)),
    ]);
  } catch { /* no recorder listening there — the recording is whatever the worker already holds */ }
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
// The editor's poll: unseen finalized entries + the status, in one message per tick.
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

// Drain the tail the live pull had not handed over, and clear. Idempotent (empty on re-drain).
async function srStop() {
  const st = await srGet();
  await srClear();
  return { ok: true, entries: (st && st.entries ? st.entries.slice(st.sent || 0) : []) };
}

// The re-injected content script's own document.title — independent of tab.title timing.
async function srTitle(title) {
  await srSerial(async () => {
    const st = await srGet();
    if (st && st.recording && srRefineNav(st, title, st.lastUrl)) await srSet(st);
  });
  return { ok: true };
}

// tabs.onUpdated carries full loads AND SPA pushState. A full load kills the content script, so it is
// re-injected on every `complete` (the double-init guard makes a same-document re-inject a no-op).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // ON THE APPEND CHAIN: one SPA navigation delivers url and title microseconds apart, and this is a
  // read-modify-write. The re-inject stays inside this recording/tab check, or every load flashes an indicator.
  let reinject = false;
  await srSerial(async () => {
    const st = await srGet();
    if (!st || !st.recording || st.tabId !== tabId) return;
    reinject = changeInfo.status === 'complete';
    let changed = false;
    if (changeInfo.url && changeInfo.url !== st.lastUrl) {
      if (st.manualPause) {
        // A manual pause covers the detour's navigations: follow the tab, record nothing.
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
  if (reinject && !(await srOrphaned())) await srInjectSync(tabId); // an orphan gets no new pill
});

// Closing the recorded tab auto-stops but PRESERVES the entries — the editor's poll drains them.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await srGet();
  if (st && st.tabId === tabId && st.recording) { st.recording = false; await srSet(st); }
});

// ONE chain for appends: `stepRec` is a read-modify-write and a double-click fires three messages
// within milliseconds, so concurrent handlers would drop entries. Reads (STATUS/PEEK) need no slot.
let srChain = Promise.resolve();
function srSerial(fn) {
  const next = srChain.then(fn, fn);
  srChain = next.catch(() => { /* keep the chain alive */ });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'STEPREC_START': srStart(sender).then(sendResponse); return true;
    case 'STEPREC_ADD': srSerial(() => srAdd(msg.entry, sender)).then(sendResponse); return true;
    // The pill's poll doubles as the orphan check: an editor that is gone ends the recording here.
    case 'STEPREC_STATUS': srOrphaned().then(srStatus).then(sendResponse); return true;
    // The editor's live poll (#160) — a read-modify-write, so it takes a chain slot.
    case 'STEPREC_PULL': srSerial(srPull).then(sendResponse); return true;
    case 'STEPREC_TITLE': srTitle(msg.title).then(sendResponse); return true;
    // Test seam (no production sender): e2e reads the raw entries mid-recording.
    case 'STEPREC_PEEK': srGet().then((st) => sendResponse({ entries: (st && st.entries) || [] })); return true;
    // NOT on the chain: the ADD this flush waits for needs that slot, so serializing here would
    // deadlock the pair until the timeout fires.
    case 'STEPREC_FLUSH': srFlush().then(sendResponse); return true;
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
    // A debugger failure rejects and never downgrades — except the #101 refusal, which comes back
    // as `viewportOnly`. `trimmed` (#158) and `framesMoved` (#101) are diagnostics; the image is correct.
    captureShot({ beyondViewport: !!msg.fullPage })
      .then((r) => sendResponse({
        ok: true, dataUrl: r.dataUrl, tabId: r.tabId, viewportOnly: !!r.viewportOnly, trimmed: !!r.trimmed,
        heightClipped: !!r.heightClipped, framesMoved: r.framesMoved || 0,
      }))
      // `needsGrant`: the failure a toolbar click fixes — the panel pends the retry on it.
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), needsGrant: !!e?.needsGrant }));
    return true; // async response
  }
});

// =========================== Presence marker (#14) ==========================
// The manifest declares app.testomat.io; a self-hosted instance is known only once Settings saves it.

const PRESENCE_ID = 'presence-configured';
const PRESENCE_FILE = 'content/presence.js';
// The match pattern lives in shared/presence-match.js.
const { presenceMatch, PRESENCE_STATIC_ORIGIN } = PresenceMatch;

// The registration outlives the worker, so it can still name a host the user has replaced since.
async function syncPresenceScript() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const match = presenceMatch(settings && settings.baseUrl);
    const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [PRESENCE_ID] });
    if (!match) {
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [PRESENCE_ID] });
      return;
    }
    // persistAcrossSessions: a new session loads its first page before anything wakes this worker.
    const script = { id: PRESENCE_ID, js: [PRESENCE_FILE], matches: [match],
      runAt: 'document_start', persistAcrossSessions: true };
    if (registered) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch { /* a refused origin or a registry mid-write is never worth taking the worker down */ }
}
syncPresenceScript();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncPresenceScript();
});
