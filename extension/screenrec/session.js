// Screen recording (#68) in the worker: the tab's picture goes to the offscreen document, the
// controls to the page, and the finished file to the panel, which owns every upload.
//
// Two capture routes, one recording. tabCapture is the good one, but Chrome hands its stream
// over only where the extension was INVOKED on the tab (activeTab; <all_urls> buys nothing).
// Where that grant is missing the recording falls back to CDP screencast over chrome.debugger,
// which needs no gesture at all, at the price of Chrome's "…is debugging" bar for its duration.

/* global resolveSiteTab, SiteTab */

const SREC_KEY = 'screenRec';           // live session; storage.session dies with the browser
const SREC_FILE_KEY = 'screenRecFile';  // a finished file waiting for a panel to attach it
const SREC_TARGET_KEY = 'screenRecTarget';
const SREC_DOC = 'offscreen/recorder.html';
const SREC_MENU_ID = 'testomat-screen-rec';
const SREC_COMMAND = 'toggle-screen-recording';
// Enforced in offscreen/recorder.js; kept here for what the bar and the panel say out loud.
const SREC_TIME_CAP_MS = 5 * 60 * 1000;

// The cast attach, mirrored in a module var so the frame pump filters without an await;
// re-seeded from storage on a worker restart (the debugger session survives one).
let castTab = null;
const srecCastOwns = (tabId) => castTab != null && tabId === castTab;

const srecGet = async () => (await chrome.storage.session.get(SREC_KEY))[SREC_KEY] || null;
const srecSet = (v) => chrome.storage.session.set({ [SREC_KEY]: v });
const srecClear = () => chrome.storage.session.remove(SREC_KEY);
const srecParked = async () => (await chrome.storage.session.get(SREC_FILE_KEY))[SREC_FILE_KEY] || null;

// Both hops are broadcasts: the offscreen document and the panel hold no port of their own.
const srecOff = (msg) => chrome.runtime.sendMessage({ type: 'SCREENREC_OFF', ...msg }).catch(() => null);
const srecTell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// ---- the offscreen document ------------------------------------------------

let srecCreating = null;
async function srecEnsureDoc() {
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (open && open.length) return;
  } catch { /* older Chrome: fall through to the create, which throws if one is already up */ }
  if (!srecCreating) {
    srecCreating = chrome.offscreen.createDocument({
      url: SREC_DOC,
      reasons: ['USER_MEDIA'],
      justification: 'Records the tab under test into a file the tester attaches to a result',
    }).catch(() => {});
  }
  await srecCreating;
  srecCreating = null;
}

// Never while a file is parked: the blob: URL dies with the document that made it.
async function srecCloseDoc() {
  if (await srecParked()) return;
  try { await chrome.offscreen.closeDocument(); } catch { /* none open */ }
}

// ---- the cast route (CDP screencast) ---------------------------------------

const CAST_PARAMS = { format: 'jpeg', quality: 60, maxWidth: 1920, maxHeight: 1920, everyNthFrame: 1 };

const castSend = (tabId, cmd, params = {}) => new Promise((resolve, reject) => {
  chrome.debugger.sendCommand({ tabId }, cmd, params, (res) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(res);
  });
});

const castAttach = (tabId) => new Promise((resolve, reject) => {
  chrome.debugger.attach({ tabId }, '1.3', () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  });
});

const castDetach = (tabId) => new Promise((resolve) => {
  chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
});

// Every frame goes to the offscreen canvas and is acked, or the screencast stalls.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.screencastFrame' || !srecCastOwns(source.tabId)) return;
  srecOff({ cmd: 'frame', data: params.data });
  chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.screencastFrameAck',
    { sessionId: params.sessionId }, () => void chrome.runtime.lastError);
});

// The infobar's own Cancel detaches, that is a Stop that keeps the file, never a loss.
chrome.debugger.onDetach.addListener(async (source) => {
  if (!srecCastOwns(source.tabId)) return;
  castTab = null;
  const st = await srecGet();
  if (!st || !st.recording || st.mode !== 'cast') return;
  const res = await srecOff({ cmd: 'stop', reason: 'user' });
  await srecFinish((res && res.file) || null, st, 'user');
});

async function srecStartCast(target, recordId) {
  // The debugger cannot touch chrome://, the Web Store or another extension's pages, and a tab
  // whose url the worker cannot even read is one of those — say what every capture path says
  // instead of aiming the attach at it and relaying Chrome's cryptic refusal.
  if (!SiteTab.originOf(target.url)) {
    return { ok: false, reason: SiteTab.restrictedCopy('recorded') };
  }
  try {
    await castAttach(target.id);
  } catch (e) {
    // Usually DevTools (or another extension's debugger) holding the tab.
    return { ok: false, reason: 'cast-attach', error: String((e && e.message) || e) };
  }
  await srecEnsureDoc();
  const started = await srecOff({ cmd: 'cast-start' });
  if (!started || !started.ok) {
    await castDetach(target.id);
    await srecCloseDoc();
    return { ok: false, reason: 'Chrome refused the capture' };
  }
  castTab = target.id;
  await srecSet({ recording: true, paused: false, tabId: target.id, recordId, mode: 'cast', startedAt: Date.now() });
  await castSend(target.id, 'Page.startScreencast', CAST_PARAMS).catch(() => {});
  await srecInjectBar(target.id);
  srecTell({ type: 'SCREENREC_EVENT', event: 'started', tabId: target.id });
  return { ok: true, tabId: target.id };
}

// ---- start / stop ----------------------------------------------------------

function srecName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `screen-recording-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}.webm`;
}

async function srecStart({ recordId = null, tab = null } = {}) {
  const live = await srecGet();
  if (live && live.recording) return { ok: false, reason: 'A screen recording is already running' };
  // A hotkey or the menu hands the tab it fired on, which can be a page no extension may
  // touch (chrome://, another extension's page) — those fall through to the resolver, which
  // knows how to stand the bound site tab in instead.
  let target = tab && tab.id != null && SiteTab.originOf(tab.url) ? tab : null;
  if (!target) {
    const site = await resolveSiteTab({ verb: 'recorded', activate: true });
    if (site.state !== 'ok') return { ok: false, reason: site.error };
    target = site.tab;
  }
  let streamId = '';
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
  } catch {
    // No activeTab grant on that tab, record it over the debugger instead.
    return srecStartCast(target, recordId);
  }
  await srecEnsureDoc();
  const started = await srecOff({ cmd: 'start', streamId });
  if (!started || !started.ok) {
    await srecCloseDoc();
    return { ok: false, reason: (started && started.error) || 'Chrome refused the capture' };
  }
  await srecSet({ recording: true, paused: false, tabId: target.id, recordId, mode: 'tab', startedAt: Date.now() });
  await srecInjectBar(target.id);
  srecTell({ type: 'SCREENREC_EVENT', event: 'started', tabId: target.id });
  return { ok: true, tabId: target.id };
}

async function srecStop(reason) {
  const st = await srecGet();
  if (!st || !st.recording) return { ok: false, reason: 'Nothing is recording' };
  if (st.mode === 'cast' && castTab != null) {
    const tabId = castTab;
    castTab = null; // silence onDetach, this stop already owns the finish
    await castSend(tabId, 'Page.stopScreencast').catch(() => {});
    await castDetach(tabId);
  }
  const res = await srecOff({ cmd: 'stop', reason });
  await srecFinish((res && res.file) || null, st, reason);
  return { ok: true };
}

// Everything that ends a recording funnels through here: state cleared, file parked, panel told.
async function srecFinish(file, st, reason) {
  await srecClear();
  if (!file || !file.size) {
    await srecCloseDoc();
    srecTell({ type: 'SCREENREC_EVENT', event: 'ended', reason: reason || 'user', empty: true });
    return;
  }
  const parked = {
    url: file.url,
    size: file.size,
    ms: file.ms || 0,
    reason: file.reason || reason || 'user',
    name: srecName(),
    recordId: (st && st.recordId) || null,
  };
  await chrome.storage.session.set({ [SREC_FILE_KEY]: parked });
  srecTell({ type: 'SCREENREC_EVENT', event: 'file', file: parked });
}

async function srecPause(on) {
  const st = await srecGet();
  if (!st || !st.recording) return { ok: false };
  await srecOff({ cmd: 'pause', on });
  // Cast: no frames while paused, the pump idles rather than drawing into a paused recorder.
  if (st.mode === 'cast' && castTab != null) {
    if (on) await castSend(castTab, 'Page.stopScreencast').catch(() => {});
    else await castSend(castTab, 'Page.startScreencast', CAST_PARAMS).catch(() => {});
  }
  st.paused = !!on;
  await srecSet(st);
  return { ok: true, paused: st.paused };
}

// The single source of truth for the bar and the panel alike. A session whose offscreen
// document is gone (browser restart, a crash) is stale and reported as idle.
async function srecStatus() {
  const st = await srecGet();
  const parked = await srecParked();
  if (!st || !st.recording) return { recording: false, capMs: SREC_TIME_CAP_MS, file: parked || null };
  const live = await srecOff({ cmd: 'state' });
  if (!live || !live.recording) {
    await srecClear();
    return { recording: false, capMs: SREC_TIME_CAP_MS, file: parked || null };
  }
  return {
    recording: true,
    paused: !!live.paused,
    ms: live.ms || 0,
    bytes: live.bytes || 0,
    tabId: st.tabId,
    recordId: st.recordId || null,
    capMs: SREC_TIME_CAP_MS,
  };
}

// ---- the bar on the page ---------------------------------------------------

async function srecInjectBar(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/rec-bar.js'] });
    return true;
  } catch { return false; } // a page Chrome keeps extensions off records without its controls
}

// A full load kills the bar; the script re-runs and replaces its own host, so this is idempotent.
// A cross-process navigation can also silence the screencast, re-asking is a no-op otherwise.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const st = await srecGet();
  if (!st || !st.recording || st.tabId !== tabId) return;
  await srecInjectBar(tabId);
  if (st.mode === 'cast' && !st.paused && srecCastOwns(tabId)) {
    await castSend(tabId, 'Page.startScreencast', CAST_PARAMS).catch(() => {});
  }
});

// A worker restart drops the module mirror; the debugger session it filters for survives one.
srecGet().then((st) => { if (st && st.recording && st.mode === 'cast') castTab = st.tabId; }).catch(() => {});

// The track ends with the tab and the offscreen document pushes the file; this only tidies state.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await srecGet();
  if (st && st.recording && st.tabId === tabId) await srecStop('tab-gone');
});

// ---- the two entries that also grant the capture ---------------------------

function srecMenu() {
  try {
    chrome.contextMenus.create({
      id: SREC_MENU_ID,
      title: 'Record this tab for Testomat.io',
      contexts: ['page', 'selection', 'image', 'link'],
    }, () => void chrome.runtime.lastError);
  } catch { /* older Chrome */ }
}
chrome.runtime.onInstalled.addListener(srecMenu);
chrome.runtime.onStartup.addListener(srecMenu);

async function srecTarget() {
  const id = (await chrome.storage.session.get(SREC_TARGET_KEY))[SREC_TARGET_KEY];
  return id != null ? id : null;
}

// Started from the page, the recording binds to whatever result the panel has open.
async function srecToggle(tab) {
  const st = await srecGet();
  if (st && st.recording) { await srecStop('user'); return; }
  await srecStart({ recordId: await srecTarget(), tab });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info && info.menuItemId === SREC_MENU_ID) srecToggle(tab);
});
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === SREC_COMMAND) srecToggle(tab);
});

// ---- protocol --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg && msg.type) {
    case 'SCREENREC_START': srecStart({ recordId: msg.recordId != null ? msg.recordId : null }).then(sendResponse); return true;
    case 'SCREENREC_STOP': srecStop('user').then(sendResponse); return true;
    case 'SCREENREC_PAUSE': srecPause(!!msg.on).then(sendResponse); return true;
    case 'SCREENREC_STATUS': srecStatus().then(sendResponse); return true;
    case 'SCREENREC_TAKE': srecParked().then((f) => sendResponse(f || null)); return true;
    case 'SCREENREC_DONE':
      chrome.storage.session.remove(SREC_FILE_KEY).then(srecCloseDoc).then(() => sendResponse({ ok: true }));
      return true;
    case 'SCREENREC_TARGET':
      chrome.storage.session.set({ [SREC_TARGET_KEY]: msg.recordId != null ? msg.recordId : null })
        .then(() => sendResponse({ ok: true }));
      return true;
    // Pushed by the offscreen document when a cap or a closed tab ended the recording.
    case 'SCREENREC_FILE':
      srecGet().then((st) => srecFinish(msg.file, st, msg.file && msg.file.reason));
      return false;
    default: return undefined;
  }
});
