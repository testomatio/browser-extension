// Worker half of the evidence recorder: page-hook.js and webRequest rows, split by evWrOwns().

/* global chrome, SiteTab, EvBuffer */

const EVIDENCE_MIRROR_MS = 2000;     // throttled mirror to storage.session

// page-hook.js applies the same caps, but it runs in the untrusted page, so the worker repeats them.
const EV_BODY_CAP = 16 * 1024;       // parity with page-hook.js BODY_CAP
const EV_TEXT_CAP = 4000;            // parity with page-hook.js TEXT_CAP
// Half the ring buffer: a page flooding one batch cannot erase the reproduction already recorded.
const EV_BATCH_CAP = 500;

// Fixed ids, so a leftover document_start registration is always found and replaced.
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

// It owns the map's leak guard and schedules the mirror, so every row write goes through it.
const evBuf = EvBuffer.makeBuffer({ netMap: evNetById, onChange: evScheduleMirror, windowSec: evWindowSec });

// Cached so per-event reads stay cheap; the body-capture flag is not, the relay feeds it to the hook.
async function evLoadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    evWindowSec = settings && settings.evidenceWindowSec != null
      ? EvBuffer.clampWindow(settings.evidenceWindowSec) : 60;
  } catch { evWindowSec = 60; }
  evBuf.setWindowSec(evWindowSec);
}

// Text rows the hook sends: a console call, a browser-made row and an uncaught exception.
const EV_PAGE_KINDS = { console: 'console', log: 'log', exception: 'exception' };

// The relay forwards the sender tab, so a stale document in another tab cannot write here.
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

// A copy, as the caller owns the message; `bodyTruncated` makes a body we cut read as a fragment.
function evCapBody(ev) {
  if (!ev.bodySnippet) return ev;
  const body = String(ev.bodySnippet);
  if (body.length <= EV_BODY_CAP) return ev;
  return { ...ev, bodySnippet: body.slice(0, EV_BODY_CAP), bodyTruncated: true };
}

// The hook patches only the top frame's fetch + XHR; once it says hello those rows are its own.
function evWrOwns(d) {
  if (!evSession || d.tabId !== evSession.tabId) return false;
  if (evHookReady && d.frameId === 0 && d.type === 'xmlhttprequest') return false;
  return true;
}

function evWrStart(d) {
  if (!evWrOwns(d)) return;
  // A main-frame request means this document's hook is leaving; the next one says hello again.
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

// A redirect keeps one requestId for the chain, so each hop closes and the target starts a row.
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

// Registered at load, not on start: a recycled MV3 worker re-attaches only top-level listeners.
if (chrome.webRequest) {
  const filter = { urls: ['<all_urls>'] };
  try {
    chrome.webRequest.onBeforeRequest.addListener(evWrStart, filter);
    chrome.webRequest.onCompleted.addListener(evWrDone, filter);
    chrome.webRequest.onErrorOccurred.addListener(evWrError, filter);
    chrome.webRequest.onBeforeRedirect.addListener(evWrRedirect, filter);
  } catch { /* permission missing (unpacked copy without it) — the hook still records */ }
}

// Relay first to hear the hook's hello; cross-world order is no contract, so the hook re-announces.
async function evInject(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_RELAY_FILE], world: 'ISOLATED', injectImmediately: true,
  });
  await chrome.scripting.executeScript({
    target: { tabId }, files: [EV_HOOK_FILE], world: 'MAIN', injectImmediately: true,
  });
}

// document_start is the only way to see a page's first requests; it names an origin, not a tab.
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
  } catch { return false; } // an origin the registration API refuses (never http(s))
}

async function evUnregister() {
  if (!chrome.scripting.unregisterContentScripts) return;
  try { await chrome.scripting.unregisterContentScripts({ ids: [EV_CS_RELAY, EV_CS_HOOK] }); }
  catch { /* nothing registered */ }
}

// Muted, never un-patched (others may wrap fetch after us), so a new recording must wake it up.
function evTellHook(tabId, on) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
  try { chrome.tabs.sendMessage(tabId, { type: on ? 'EVIDENCE_HOOK_ON' : 'EVIDENCE_HOOK_OFF' }).catch(() => {}); }
  catch { /* noop */ }
}

// Chrome titles a page with no <title> by its address, query and all: the name is never that.
function evTabName(tab, tabId) {
  try {
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.origin}${u.pathname}`;
  } catch { /* no url, or none Chrome let us see */ }
  return `Tab ${tabId}`;
}

// The page's own title; '' when it has none or will not say.
async function evPageTitle(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title });
    return String((res && res.result) || '').trim();
  } catch { return ''; }
}

async function evStart(tabId, recordId) {
  await evLoadSettings();
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* title may be hidden */ }
  // Armed before the inject: a batch reaching a session-less worker would mute the new hook.
  evBuf.clear();
  evNetById.clear();
  evHookReady = false;
  evSession = {
    tabId, startedAt: Date.now(),
    // The testrun that owns this recording — it rides the mirror, so a restart still knows it.
    recordId: recordId != null ? recordId : null,
    tabTitle: evTabName(tab, tabId),
    tabUrl: (tab && tab.url) || '',
  };
  try {
    await evInject(tabId);
  } catch {
    // resolveSiteTab said `ok` moments ago, so a refused inject means the tab went restricted.
    evSession = null;
    evMirror();
    throw new Error(SiteTab.restrictedCopy('recorded'));
  }
  evTellHook(tabId, true); // a hook left muted by a previous recording
  await evRegister(SiteTab.originOf(evSession.tabUrl));
  const title = await evPageTitle(tabId);
  if (title && evSession && evSession.tabId === tabId) evSession.tabTitle = title;
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

// The one path for a stop nobody clicked: evStop plus a broadcast naming the reason.
async function evStopIfRecording(reason) {
  if (!evSession) return false;
  await evStop(true);
  chrome.runtime.sendMessage({ type: 'EVIDENCE_STOPPED', reason }).catch(() => {});
  return true;
}

// The buffer lives here, not in storage, so clearing storage.session alone refills it ~2 s later.
async function evWipe() {
  await evReady; // a restore still in flight would re-adopt the buffer we drop
  // A mirror already scheduled fires after the panel's clear(), so cancel it first.
  if (evMirrorTimer) { clearTimeout(evMirrorTimer); evMirrorTimer = null; }
  // evStop writes the key back empty, so the removal must come after it.
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

function evScheduleMirror() {
  if (evMirrorTimer) return;
  evMirrorTimer = setTimeout(() => { evMirrorTimer = null; evMirror(); }, EVIDENCE_MIRROR_MS);
}

// Returns the write so a caller can order after it; other callers fire and forget.
function evMirror() {
  try {
    return chrome.storage.session
      .set({ evidenceMirror: { session: evSession, buffer: evBuf.entries(), windowSec: evWindowSec } })
      .catch(() => {});
  } catch { return Promise.resolve(); } // storage.session unavailable — best effort
}

// The page hook keeps running and wakes us with its next batch; only a vanished tab drops the session.
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

// A closed recorded tab ends the recording (the hook died with it).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (evSession && evSession.tabId === tabId) evStopIfRecording('target_closed');
});

// Unconditional: the document_start registration covers only the start origin.
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
  // Answered synchronously once restored; one answered before the mirror read would mute a live hook.
  if (msg.type === 'EVIDENCE_EVENTS') {
    const events = Array.isArray(msg.events) ? msg.events : [];
    if (evRestored) { sendResponse(evOnPageEvents(events, sender)); return undefined; }
    evReady.then(() => sendResponse(evOnPageEvents(events, sender)));
    return true;
  }
  (async () => {
    try {
      // The mirror read decides whether anything records; a request beating it would answer wrong.
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

// A page hook may still post after a worker restart, before this restore settles.
const evReady = evRestore();
