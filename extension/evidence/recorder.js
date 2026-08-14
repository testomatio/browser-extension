// Evidence recorder — runs in the background service worker via importScripts.
// Owns the ring buffer of console/network entries and the EVIDENCE_* protocol
// the panel speaks; it does NOT own a chrome.debugger session any more (#123).
//
// TWO sources feed the buffer, with no overlap by construction:
//
//   evidence/page-hook.js (MAIN world, injected here) — fetch + XHR of the
//     recorded TOP frame, console.error/warn, uncaught errors, unhandled
//     rejections, CSP violations, failed resource loads. The only source that
//     can read a RESPONSE BODY: failures (>= 400 / network error) carry a
//     snippet capped at EVIDENCE_BODY_CAP (16 KB), and only while
//     settings.evidenceCaptureBodies is on (#95). Request bodies are never read.
//   chrome.webRequest (observational, no blocking) — everything else in that
//     tab: the document and subresource loads, sub-frame and worker traffic,
//     WebSocket handshakes, redirects, and anything at all before the hook
//     lands. Metadata only, never a body.
//
// The whole no-overlap rule is evWrOwns(): webRequest drops
// type 'xmlhttprequest' from frame 0 once the hook has reported ready.

/* global chrome, SiteTab */

const EVIDENCE_HARD_CAP = 1000;      // memory guard: absolute entry ceiling
const EVIDENCE_MIRROR_MS = 2000;     // throttled mirror to storage.session
const EVIDENCE_NET_MAP_CAP = 3000;   // requestId->entry map leak guard
const EVIDENCE_MERGE_MS = 10000;     // window for adopting a webRequest twin

// The dynamic content-script pair. Registered per origin while recording so a
// navigation is instrumented at document_start; ids are fixed so a leftover
// registration (worker killed mid-recording) is always found and replaced.
const EV_CS_HOOK = 'testomat-evidence-hook';
const EV_CS_RELAY = 'testomat-evidence-relay';
const EV_HOOK_FILE = 'evidence/page-hook.js';
const EV_RELAY_FILE = 'evidence/relay.js';

// Recording session (null when idle) and the ring buffer of entries.
let evSession = null;                // { tabId, tabTitle, tabUrl, startedAt }
let evBuffer = [];                   // [{ ts, kind, ... }] newest last
const evNetById = new Map();         // webRequest requestId -> network entry
let evWindowSec = 60;                // settings.evidenceWindowSec (clamped 10-600)
let evHookReady = false;             // the page hook owns this document's fetch/XHR
let evRestored = false;              // the storage.session mirror has been read back
let evMirrorTimer = null;

function evClampWindow(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(10, Math.round(n)));
}

// The window is read from the shared `settings` object; absent -> 60. Cached and
// refreshed on start + on any settings change so per-event reads stay cheap. The
// body-capture flag is NOT cached here any more — the page hook decides per
// response, and the relay feeds it the flag (evidence/relay.js).
async function evLoadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    evWindowSec = settings && settings.evidenceWindowSec != null
      ? evClampWindow(settings.evidenceWindowSec) : 60;
  } catch { evWindowSec = 60; }
}

// ---- ring buffer ---------------------------------------------------------

function evPush(entry) {
  evBuffer.push(entry);
  // Prune to 2x the window (retroactive margin) then hard-cap the length.
  const cutoff = Date.now() - 2 * evWindowSec * 1000;
  if (evBuffer[0] && evBuffer[0].ts < cutoff) evBuffer = evBuffer.filter((e) => e.ts >= cutoff);
  if (evBuffer.length > EVIDENCE_HARD_CAP) evBuffer = evBuffer.slice(evBuffer.length - EVIDENCE_HARD_CAP);
  if (evNetById.size > EVIDENCE_NET_MAP_CAP) evNetById.clear();
  evScheduleMirror();
  return entry;
}

// Entries within the actual (1x) window — the panel list + auto-attach source.
// Sorted by ts: the two sources arrive on different latencies (webRequest is
// immediate, the page hook batches ~200 ms), so append order is not time order.
function evWindowEntries() {
  const cutoff = Date.now() - evWindowSec * 1000;
  return evBuffer.filter((e) => e.ts >= cutoff).sort((a, b) => a.ts - b.ts);
}

// errorsOnly: console error/warn (incl. log + uncaught rows) + non-2xx/failed net.
function evIsError(e) {
  if (e.kind === 'network') return e.errorText != null || (e.status != null && (e.status < 200 || e.status >= 300));
  return e.level === 'error' || e.level === 'warning';
}

// ---- page hook events ----------------------------------------------------

// Text rows the hook can send: a patched console call, a row the browser would
// have produced, and an uncaught exception / unhandled rejection (#163).
const EV_PAGE_KINDS = { console: 'console', log: 'log', exception: 'exception' };

// The hook batches its events; the relay forwards them with the sender tab, so
// a stale document from another tab can never write into this recording.
function evOnPageEvents(events, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!evSession || tabId == null || tabId !== evSession.tabId) return { off: true };
  if (sender.frameId) return { off: false }; // sub-frame: not ours to record (v1)
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.t === 'ready') { evHookReady = true; continue; }
    const ts = Number(ev.ts) || Date.now();
    if (ev.t === 'net') evPushPageNet(ev, ts);
    else if (EV_PAGE_KINDS[ev.t]) {
      evPush({ ts, kind: EV_PAGE_KINDS[ev.t],
        level: ev.level === 'warning' ? 'warning' : 'error',
        text: String(ev.text || ''), url: ev.url || null,
        line: ev.line != null ? ev.line : null, col: ev.col != null ? ev.col : null });
    }
  }
  return { off: false };
}

// The one place the two sources can collide: the hook is installed but its
// `ready` had not reached us when webRequest saw the same xhr. Adopt that row
// instead of pushing a second one — the page entry is strictly richer (body,
// MIME, real timing), so it overwrites in place and keeps its position.
function evAdoptTwin(ev, ts) {
  for (let i = evBuffer.length - 1; i >= 0; i--) {
    const e = evBuffer[i];
    if (e.ts < ts - EVIDENCE_MERGE_MS) break;
    if (e.kind === 'network' && e.fromPage !== true && e.method === ev.method && e.url === ev.url) return e;
  }
  return null;
}

function evPushPageNet(ev, ts) {
  const fields = {
    ts, kind: 'network', fromPage: true, method: ev.method || 'GET', url: ev.url || '',
    resourceType: ev.resourceType || 'fetch',
    status: ev.status != null ? ev.status : null, errorText: ev.errorText || null,
    mimeType: ev.mimeType || null, durationMs: ev.durationMs != null ? ev.durationMs : null,
  };
  if (ev.bodySnippet) { fields.bodySnippet = String(ev.bodySnippet); fields.bodyTruncated = !!ev.bodyTruncated; }
  if (ev.bodySkipped) fields.bodySkipped = true;
  const twin = evAdoptTwin(ev, ts);
  if (twin) { Object.assign(twin, fields, { ts: twin.ts }); evScheduleMirror(); return; }
  evPush(fields);
}

// ---- chrome.webRequest (the backbone) ------------------------------------

// Does webRequest own this request, or does the page hook? The hook patches
// fetch + XHR of the TOP frame only, so once it has said hello those rows are
// its business and webRequest stays out. Everything else — the document itself,
// scripts, images, fonts, media, beacons, websockets, sub-frames, workers — is
// exactly what the hook cannot see, and is why this backbone exists.
function evWrOwns(d) {
  if (!evSession || d.tabId !== evSession.tabId) return false;
  if (evHookReady && d.frameId === 0 && d.type === 'xmlhttprequest') return false;
  return true;
}

function evWrStart(d) {
  if (!evWrOwns(d)) return;
  // A fresh main-frame request means the current document (and its hook) is on
  // its way out; the newly injected hook says hello again.
  if (d.type === 'main_frame' && d.frameId === 0) evHookReady = false;
  const entry = evPush({
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

// A redirect keeps ONE requestId across the whole chain, so the hop that just
// finished is closed off and the target starts its own row — what the CDP
// recorder never showed and DevTools always does.
function evWrRedirect(d) {
  const e = evNetById.get(d.requestId);
  if (e) {
    e.status = d.statusCode != null ? d.statusCode : e.status;
    e.durationMs = Date.now() - e.ts;
    e.redirectedTo = d.redirectURL || null;
  }
  if (!evWrOwns(d)) { evNetById.delete(d.requestId); return; }
  const next = evPush({
    ts: Date.now(), kind: 'network', requestId: d.requestId,
    method: (e && e.method) || d.method || 'GET', url: d.redirectURL || '',
    resourceType: d.type || null, status: null, errorText: null, redirectedFrom: (e && e.url) || null,
  });
  evNetById.set(d.requestId, next);
}

// Registered at load, NOT on start: an MV3 worker only re-attaches listeners it
// declares at the top level, and a recording must survive it being recycled.
// Every handler is a no-op unless a recording owns that exact tab.
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

// Inject into the CURRENT document. The relay goes first so it is listening
// when the hook says hello (the hook re-announces if it wasn't — belt and
// braces, since executeScript order across worlds is not a contract).
async function evInject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_RELAY_FILE], world: 'ISOLATED', injectImmediately: true,
  });
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_HOOK_FILE], world: 'MAIN', injectImmediately: true,
  });
}

// Every LATER navigation of that origin gets the hook at document_start — the
// only way to see a page's very first requests. A registration names an origin,
// not a tab, and `<all_urls>` covers every http(s) one (#198); the re-inject on
// tabs.onUpdated stays as the fallback for whatever it cannot cover.
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

// The hook cannot be un-patched safely (other code may have wrapped fetch after
// us), so it is muted and un-muted instead. Muting matters twice: it stops a
// finished recording from posting into the void, and — because the mute SURVIVES
// in a document that never navigated — a new recording on the same tab has to
// wake it back up, or the re-inject would be a silent no-op (the hook's
// double-init guard). Best effort: the tab may be gone.
function evTellHook(tabId, on) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
  try { chrome.tabs.sendMessage(tabId, { type: on ? 'EVIDENCE_HOOK_ON' : 'EVIDENCE_HOOK_OFF' }).catch(() => {}); }
  catch { /* noop */ }
}

async function evStart(tabId) {
  await evLoadSettings();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* title may be hidden */ }
  // The session is armed BEFORE the inject: the hook says hello the instant it
  // lands, and a batch arriving at a session-less worker is answered "you are
  // not being recorded" — which would mute the hook we just installed.
  evBuffer = [];
  evNetById.clear();
  evHookReady = false;
  evSession = {
    tabId, startedAt: Date.now(),
    tabTitle: (tab && (tab.title || tab.url)) || `Tab ${tabId}`,
    tabUrl: (tab && tab.url) || '',
  };
  try {
    await evInject(tabId);
  } catch {
    // resolveSiteTab said `ok` moments ago, so a refused inject means the tab left
    // for a restricted page in between — name that, not the API error.
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
  if (!keepBuffer) evBuffer = [];
  evTellHook(tabId, false);
  await evUnregister();
  await evMirror(); // awaited so EVIDENCE_WIPE can order its remove() after this write
}

// Sign out's erase (#183). The buffer lives HERE, not in storage —
// `evidenceMirror` is only a copy — so the panel clearing storage.session gets
// it back ~2 s later unless the recording is stopped first. Two writes can
// resurrect it and both are closed below; every step is awaited so the panel
// learns about a failure instead of being told "erased" over a buffer we kept.
async function evWipe() {
  await evReady; // a restore still in flight would re-adopt the buffer we drop
  // A mirror ALREADY scheduled fires after the panel's clear() — cancel it first.
  if (evMirrorTimer) { clearTimeout(evMirrorTimer); evMirrorTimer = null; }
  // keepBuffer=false: drop it. Ends in evMirror(), so the key is written back
  // (empty) — which is why the removal below comes after and wins by construction.
  await evStop(false);
  if (chrome.storage.session) await chrome.storage.session.remove('evidenceMirror');
}

function evStatus() {
  return {
    recording: !!evSession,
    tabId: evSession ? evSession.tabId : null,
    tabTitle: evSession ? evSession.tabTitle : '',
    tabUrl: evSession ? evSession.tabUrl : '',
    windowSec: evWindowSec,
    entryCount: evBuffer.length,
  };
}

// ---- storage.session mirror (survives SW restart mid-session) ------------

function evScheduleMirror() {
  if (evMirrorTimer) return;
  evMirrorTimer = setTimeout(() => { evMirrorTimer = null; evMirror(); }, EVIDENCE_MIRROR_MS);
}

// Returns the write so a caller that must ORDER something after it can await;
// every other call site stays fire-and-forget (the promise carries its own catch).
function evMirror() {
  try {
    return chrome.storage.session
      .set({ evidenceMirror: { session: evSession, buffer: evBuffer, windowSec: evWindowSec } })
      .catch(() => {});
  } catch { return Promise.resolve(); } // storage.session unavailable — best effort
}

// SW start: restore the mirror, then resync. Nothing to re-attach any more —
// the page hook keeps running on its own and its next batch wakes us; only a
// vanished tab drops the session (buffer kept for a final read).
async function evRestore() {
  await evLoadSettings();
  try {
    const { evidenceMirror } = await chrome.storage.session.get('evidenceMirror');
    if (evidenceMirror) {
      evBuffer = Array.isArray(evidenceMirror.buffer) ? evidenceMirror.buffer : [];
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
  if (evSession && evSession.tabId === tabId) {
    evStop(true);
    chrome.runtime.sendMessage({ type: 'EVIDENCE_STOPPED', reason: 'target_closed' }).catch(() => {});
  }
});

// Re-inject on every navigation of the recorded tab. Unconditional on purpose:
// the document_start registration covers the START origin only, so a recording
// that follows the tester cross-origin has nothing else. Where the registered
// script DID land this is a no-op (the hook's double-init guard).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!evSession || evSession.tabId !== tabId) return;
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  evInject(tabId).catch(() => { /* access gone — webRequest still covers what it can */ });
});

// Keep the cached window fresh when the tester saves settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) evLoadSettings();
});

const EVIDENCE_REQUESTS = new Set(['EVIDENCE_TOGGLE', 'EVIDENCE_STATUS', 'EVIDENCE_LIST', 'EVIDENCE_SNAPSHOT', 'EVIDENCE_EVENTS', 'EVIDENCE_WIPE']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !EVIDENCE_REQUESTS.has(msg.type)) return undefined; // not ours (incl. the EVIDENCE_STOPPED broadcast)
  // The page hook's batches are hot-path and synchronous — answer without a
  // promise so a busy page never queues microtasks behind a storage read. The
  // ONE exception is a batch that beats the mirror read after a worker restart:
  // answering it from a still-empty session would mute a live recording's hook.
  if (msg.type === 'EVIDENCE_EVENTS') {
    const events = Array.isArray(msg.events) ? msg.events : [];
    if (evRestored) { sendResponse(evOnPageEvents(events, sender)); return undefined; }
    evReady.then(() => sendResponse(evOnPageEvents(events, sender)));
    return true;
  }
  (async () => {
    try {
      if (msg.type === 'EVIDENCE_TOGGLE') {
        if (evSession) { await evStop(true); }
        else if (msg.tabId != null) { await evStart(msg.tabId); }
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_WIPE') {
        await evWipe();
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_STATUS') {
        sendResponse({ ok: true, status: evStatus() });
      } else if (msg.type === 'EVIDENCE_LIST') {
        const all = evWindowEntries();
        const entries = msg.errorsOnly ? all.filter(evIsError) : all;
        sendResponse({ ok: true, status: evStatus(), entries });
      } else { // EVIDENCE_SNAPSHOT
        sendResponse({ ok: true, status: evStatus(), entries: evWindowEntries() });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), status: evStatus() });
    }
  })();
  return true; // async response
});

// Kicked off at load; `evReady` is only awaited by the one handler that can
// arrive before it settles (a page hook still posting after a worker restart).
const evReady = evRestore();
