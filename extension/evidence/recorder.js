// Evidence recorder in the background worker (importScripts): the EVIDENCE_* protocol around
// the ring buffer of evidence/buffer.js. Two sources — page-hook.js and webRequest — separated
// by evWrOwns().

/* global chrome, SiteTab, EvBuffer */

const EVIDENCE_MIRROR_MS = 2000;     // throttled mirror to storage.session

// What the worker will keep out of one batch, whatever the page sends. page-hook.js applies the
// same two lengths, but it runs inside the page under test — the side that cannot be trusted.
const EV_BODY_CAP = 16 * 1024;       // parity with page-hook.js BODY_CAP
const EV_TEXT_CAP = 4000;            // parity with page-hook.js TEXT_CAP
// Half the ring buffer: a page flooding one batch cannot erase the reproduction already recorded.
const EV_BATCH_CAP = 500;

// Registered per origin while recording so a navigation is instrumented at document_start;
// the ids are fixed so a leftover registration is always found and replaced.
const EV_CS_HOOK = 'testomat-evidence-hook';
const EV_CS_RELAY = 'testomat-evidence-relay';
const EV_HOOK_FILE = 'evidence/page-hook.js';
const EV_RELAY_FILE = 'evidence/relay.js';

let evSession = null;                // { tabId, recordId, tabTitle, tabUrl, startedAt }
const evNetById = new Map();         // webRequest requestId -> network entry
let evWindowSec = 60;                // settings.evidenceWindowSec (clamped 10-600)
let evHookReady = false;             // the page hook owns this document's fetch/XHR
let evRestored = false;              // the storage.session mirror has been read back
let evMirrorTimer = null;

// The ring buffer itself, holding [{ ts, kind, ... }] newest last. It owns the map's leak guard
// and schedules the mirror, so every write to a row goes through it.
const evBuf = EvBuffer.makeBuffer({ netMap: evNetById, onChange: evScheduleMirror, windowSec: evWindowSec });

// Cached (refreshed on start and on any settings change) so per-event reads stay cheap.
// The body-capture flag is NOT cached here — the relay feeds it to the hook.
async function evLoadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    evWindowSec = settings && settings.evidenceWindowSec != null
      ? EvBuffer.clampWindow(settings.evidenceWindowSec) : 60;
  } catch { evWindowSec = 60; }
  evBuf.setWindowSec(evWindowSec);
}

// ---- page hook events ----------------------------------------------------

// Text rows the hook can send: a patched console call, a row the browser would have
// produced, and an uncaught exception / unhandled rejection (#163).
const EV_PAGE_KINDS = { console: 'console', log: 'log', exception: 'exception' };

// The relay forwards each batch with its sender tab, so a stale document from another
// tab can never write into this recording.
function evOnPageEvents(events, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!evSession || tabId == null || tabId !== evSession.tabId) return { off: true };
  if (sender.frameId) return { off: false }; // sub-frame: not ours to record (v1)
  const take = Math.min(events.length, EV_BATCH_CAP);
  for (let i = 0; i < take; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    if (ev.t === 'ready') { evHookReady = true; continue; }
    const ts = Number(ev.ts) || Date.now();
    if (ev.t === 'net') evBuf.pushPageNet(evCapBody(ev), ts);
    else if (EV_PAGE_KINDS[ev.t]) {
      evBuf.push({ ts, kind: EV_PAGE_KINDS[ev.t],
        level: ev.level === 'warning' ? 'warning' : 'error',
        text: String(ev.text || '').slice(0, EV_TEXT_CAP), url: ev.url || null,
        line: ev.line != null ? ev.line : null, col: ev.col != null ? ev.col : null });
    }
  }
  return { off: false };
}

// A copy, never the row itself: the caller still owns the message it was handed. `bodyTruncated`
// is raised as well, so a body WE cut still reads as a fragment in the log.
function evCapBody(ev) {
  if (!ev.bodySnippet) return ev;
  const body = String(ev.bodySnippet);
  if (body.length <= EV_BODY_CAP) return ev;
  return { ...ev, bodySnippet: body.slice(0, EV_BODY_CAP), bodyTruncated: true };
}

// ---- chrome.webRequest (the backbone) ------------------------------------

// The hook patches fetch + XHR of the TOP frame only, so once it has said hello those
// rows are its business; everything else is exactly what it cannot see.
function evWrOwns(d) {
  if (!evSession || d.tabId !== evSession.tabId) return false;
  if (evHookReady && d.frameId === 0 && d.type === 'xmlhttprequest') return false;
  return true;
}

function evWrStart(d) {
  if (!evWrOwns(d)) return;
  // A fresh main-frame request means the current document (and its hook) is on its way
  // out; the newly injected hook says hello again.
  if (d.type === 'main_frame' && d.frameId === 0) evHookReady = false;
  const entry = evBuf.push({
    ts: Date.now(), kind: 'network', requestId: d.requestId,
    method: d.method || 'GET', url: d.url || '',
    resourceType: d.type || null, status: null, errorText: null,
  });
  evNetById.set(d.requestId, entry);
}

function evWrDone(d) {
  const e = evNetById.get(d.requestId);
  evNetById.delete(d.requestId);
  if (!e) return;
  e.status = d.statusCode != null ? d.statusCode : e.status;
  e.durationMs = Date.now() - e.ts;
  if (d.fromCache) e.fromCache = true;
  evScheduleMirror();
}

function evWrError(d) {
  const e = evNetById.get(d.requestId);
  evNetById.delete(d.requestId);
  if (!e) return;
  e.errorText = d.error || 'failed';
  if (e.status == null) e.status = 0;
  e.durationMs = Date.now() - e.ts;
  evScheduleMirror();
}

// A redirect keeps ONE requestId across the whole chain, so the hop that just finished
// is closed off and the target starts its own row.
function evWrRedirect(d) {
  const e = evNetById.get(d.requestId);
  if (e) {
    e.status = d.statusCode != null ? d.statusCode : e.status;
    e.durationMs = Date.now() - e.ts;
    e.redirectedTo = d.redirectURL || null;
  }
  if (!evWrOwns(d)) { evNetById.delete(d.requestId); return; }
  const next = evBuf.push({
    ts: Date.now(), kind: 'network', requestId: d.requestId,
    method: (e && e.method) || d.method || 'GET', url: d.redirectURL || '',
    resourceType: d.type || null, status: null, errorText: null, redirectedFrom: (e && e.url) || null,
  });
  evNetById.set(d.requestId, next);
}

// Registered at load, NOT on start: an MV3 worker only re-attaches listeners declared at
// the top level, and a recording must survive it being recycled.
if (chrome.webRequest) {
  const filter = { urls: ['<all_urls>'] };
  try {
    chrome.webRequest.onBeforeRequest.addListener(evWrStart, filter);
    chrome.webRequest.onCompleted.addListener(evWrDone, filter);
    chrome.webRequest.onErrorOccurred.addListener(evWrError, filter);
    chrome.webRequest.onBeforeRedirect.addListener(evWrRedirect, filter);
  } catch { /* permission missing (unpacked copy without it) — the hook still records */ }
}

// ---- inject / start / stop -----------------------------------------------

// The relay goes first so it is listening when the hook says hello — executeScript order
// across worlds is not a contract, so the hook re-announces as well.
async function evInject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_RELAY_FILE], world: 'ISOLATED', injectImmediately: true,
  });
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_HOOK_FILE], world: 'MAIN', injectImmediately: true,
  });
}

// document_start is the only way to see a page's very first requests. A registration
// names an ORIGIN, not a tab (#198); the tabs.onUpdated re-inject covers the rest.
async function evRegister(origin) {
  await evUnregister();
  if (!origin || !chrome.scripting.registerContentScripts) return false;
  try {
    await chrome.scripting.registerContentScripts([
      { id: EV_CS_RELAY, js: [EV_RELAY_FILE], matches: [`${origin}/*`], runAt: 'document_start',
        world: 'ISOLATED', allFrames: false, persistAcrossSessions: false },
      { id: EV_CS_HOOK, js: [EV_HOOK_FILE], matches: [`${origin}/*`], runAt: 'document_start',
        world: 'MAIN', allFrames: false, persistAcrossSessions: false },
    ]);
    return true;
  } catch { return false; } // an origin the registration API refuses (never http(s) now)
}

async function evUnregister() {
  if (!chrome.scripting.unregisterContentScripts) return;
  try { await chrome.scripting.unregisterContentScripts({ ids: [EV_CS_RELAY, EV_CS_HOOK] }); }
  catch { /* nothing registered */ }
}

// The hook is muted, never un-patched (others may have wrapped fetch after us). The mute
// SURVIVES a document that never navigated, so a new recording has to wake it back up.
function evTellHook(tabId, on) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
  try { chrome.tabs.sendMessage(tabId, { type: on ? 'EVIDENCE_HOOK_ON' : 'EVIDENCE_HOOK_OFF' }).catch(() => {}); }
  catch { /* noop */ }
}

async function evStart(tabId, recordId) {
  await evLoadSettings();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* title may be hidden */ }
  // Armed BEFORE the inject: the hook says hello the instant it lands, and a batch
  // arriving at a session-less worker is answered by muting the hook we just installed.
  evBuf.clear();
  evNetById.clear();
  evHookReady = false;
  evSession = {
    tabId, startedAt: Date.now(),
    // The testrun that owns this recording — it rides the mirror, so a restart still knows it.
    recordId: recordId != null ? recordId : null,
    tabTitle: (tab && (tab.title || tab.url)) || `Tab ${tabId}`,
    tabUrl: (tab && tab.url) || '',
  };
  try {
    await evInject(tabId);
  } catch {
    // resolveSiteTab said `ok` moments ago, so a refused inject means the tab left for a
    // restricted page in between — name that, not the API error.
    evSession = null;
    evMirror();
    throw new Error(SiteTab.restrictedCopy('recorded'));
  }
  evTellHook(tabId, true); // a hook left muted by a previous recording
  await evRegister(SiteTab.originOf(evSession.tabUrl));
  evMirror();
}

async function evStop(keepBuffer = true) {
  const tabId = evSession && evSession.tabId;
  evSession = null;
  evNetById.clear();
  evHookReady = false;
  if (!keepBuffer) evBuf.clear();
  evTellHook(tabId, false);
  await evUnregister();
  await evMirror(); // awaited so EVIDENCE_WIPE can order its remove() after this write
}

// The one path for a stop nobody clicked (tab gone, testrun left, panel closed): the same
// evStop, plus the broadcast that names the reason. A no-op when nothing is recording.
async function evStopIfRecording(reason) {
  if (!evSession) return false;
  await evStop(true);
  chrome.runtime.sendMessage({ type: 'EVIDENCE_STOPPED', reason }).catch(() => {});
  return true;
}

// Sign out's erase (#183). The buffer lives HERE, not in storage — `evidenceMirror` is
// only a copy — so the panel clearing storage.session gets it back ~2 s later.
async function evWipe() {
  await evReady; // a restore still in flight would re-adopt the buffer we drop
  // A mirror ALREADY scheduled fires after the panel's clear() — cancel it first.
  if (evMirrorTimer) { clearTimeout(evMirrorTimer); evMirrorTimer = null; }
  // evStop ends in evMirror(), writing the key back empty — so the removal below must
  // come after it.
  await evStop(false);
  if (chrome.storage.session) await chrome.storage.session.remove('evidenceMirror');
}

function evStatus() {
  return {
    recording: !!evSession,
    tabId: evSession ? evSession.tabId : null,
    // The panel reconciles against this: a recording it does not own any more is stopped.
    recordId: evSession ? evSession.recordId : null,
    tabTitle: evSession ? evSession.tabTitle : '',
    tabUrl: evSession ? evSession.tabUrl : '',
    windowSec: evWindowSec,
    entryCount: evBuf.entries().length,
  };
}

// ---- storage.session mirror (survives SW restart mid-session) ------------

function evScheduleMirror() {
  if (evMirrorTimer) return;
  evMirrorTimer = setTimeout(() => { evMirrorTimer = null; evMirror(); }, EVIDENCE_MIRROR_MS);
}

// Returns the write so a caller that must ORDER something after it can await; every other
// call site is fire-and-forget (the promise carries its own catch).
function evMirror() {
  try {
    return chrome.storage.session
      .set({ evidenceMirror: { session: evSession, buffer: evBuf.entries(), windowSec: evWindowSec } })
      .catch(() => {});
  } catch { return Promise.resolve(); } // storage.session unavailable — best effort
}

// SW start: restore the mirror, then resync. Nothing to re-attach — the page hook keeps
// running and its next batch wakes us; only a vanished tab drops the session.
async function evRestore() {
  await evLoadSettings();
  try {
    const { evidenceMirror } = await chrome.storage.session.get('evidenceMirror');
    if (evidenceMirror) {
      evBuf.load(Array.isArray(evidenceMirror.buffer) ? evidenceMirror.buffer : []);
      evSession = evidenceMirror.session || null;
    }
  } catch { /* nothing mirrored */ }
  if (evSession) {
    try { await chrome.tabs.get(evSession.tabId); }
    catch { evSession = null; await evUnregister(); evMirror(); }
  } else {
    await evUnregister();
  }
  evRestored = true;
}

// ---- listeners -----------------------------------------------------------

// A closed recorded tab ends the recording (the hook died with it).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (evSession && evSession.tabId === tabId) evStopIfRecording('target_closed');
});

// Unconditional on purpose: the document_start registration covers the START origin only,
// so a recording that follows the tester cross-origin has nothing else.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!evSession || evSession.tabId !== tabId) return;
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  evInject(tabId).catch(() => { /* access gone — webRequest still covers what it can */ });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) evLoadSettings();
});

const EVIDENCE_REQUESTS = new Set(['EVIDENCE_TOGGLE', 'EVIDENCE_STOP', 'EVIDENCE_STATUS', 'EVIDENCE_LIST', 'EVIDENCE_SNAPSHOT', 'EVIDENCE_EVENTS', 'EVIDENCE_WIPE']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !EVIDENCE_REQUESTS.has(msg.type)) return undefined; // not ours (incl. the EVIDENCE_STOPPED broadcast)
  // The hook's batches are answered synchronously so a busy page never queues microtasks
  // behind a storage read; one that beats the mirror read would mute a live hook.
  if (msg.type === 'EVIDENCE_EVENTS') {
    const events = Array.isArray(msg.events) ? msg.events : [];
    if (evRestored) { sendResponse(evOnPageEvents(events, sender)); return undefined; }
    evReady.then(() => sendResponse(evOnPageEvents(events, sender)));
    return true;
  }
  (async () => {
    try {
      // The mirror read decides whether anything is recording, so a request that beats it would
      // both answer wrong and have its own work overwritten when the read lands.
      await evReady;
      if (msg.type === 'EVIDENCE_TOGGLE') {
        if (evSession) { await evStop(true); }
        else if (msg.tabId != null) { await evStart(msg.tabId, msg.recordId); }
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_STOP') {
        // Idempotent by design: the panel fires it on leaving a testrun, whatever it believes.
        await evStopIfRecording(msg.reason || 'stopped');
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_WIPE') {
        await evWipe();
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_STATUS') {
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_LIST') {
        const all = evBuf.windowEntries();
        const entries = msg.errorsOnly ? all.filter(evBuf.isError) : all;
        sendResponse({ ok: true, status: evStatus(), entries });
      } else { // EVIDENCE_SNAPSHOT
        sendResponse({ ok: true, status: evStatus(), entries: evBuf.windowEntries() });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), status: evStatus() });
    }
  })();
  return true; // async response
});

// Awaited only by the one handler that can arrive before it settles: a page hook still
// posting after a worker restart.
const evReady = evRestore();
