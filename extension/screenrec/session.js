// Screen recording (#68) in the worker: the tab's picture goes to the offscreen document, the
// controls to the page, and the finished file to the panel, which owns every upload.
//
// Two capture routes, one recording. tabCapture is the good one, but Chrome hands its stream
// over only where the extension was INVOKED on the tab (activeTab; <all_urls> buys nothing).
// Where that grant is missing the recording falls back to CDP screencast over chrome.debugger,
// which needs no gesture at all, at the price of Chrome's "…is debugging" bar for its duration.

/* global resolveSiteTab, SiteTab, dbgIsForeignFrame, foreignFramesOut, foreignFramesBack,
   SrecParked, SrecClaim */

// The parked take's record and its transitions live in screenrec/parked.js; the bare names keep this
// file's call sites and its worker surface — srecName has no caller here, but stays reachable.
const { srecName, buildParked, applyReviewed, applyTrimmed } = SrecParked;
// Who owns the upload lives in screenrec/claim.js, along with the queue its writes take turns in;
// SREC_CLAIM_MS has no caller here either, but stays reachable the same way.
const { SREC_CLAIM_MS, claimOk, applyClaim, dropClaim, serialize } = SrecClaim;

const SREC_KEY = 'screenRec';           // live session; storage.session dies with the browser
const SREC_FILE_KEY = 'screenRecFile';  // a finished file waiting for a panel to attach it
// What a FRAMED screenrec/review.html has to show to act: any page can frame that page, and only
// our own overlay is ever handed this. Its own key — the parked record is broadcast, this is not.
const SREC_RKEY_KEY = 'screenRecReviewKey';
const SREC_TARGET_KEY = 'screenRecTarget';
const SREC_DOC = 'offscreen/recorder.html';
const SREC_MENU_ID = 'testomat-screen-rec';
const SREC_COMMAND = 'toggle-screen-recording';
// Enforced in offscreen/recorder.js; kept here for what the bar and the panel say out loud.
const SREC_TIME_CAP_MS = 5 * 60 * 1000;

// The cast attach, mirrored in a module var so the frame pump filters without an await;
// re-seeded from storage on a worker restart (the debugger session survives one).
let castTab = null;
let castSeeded = Promise.resolve(); // the re-seed below, so a caller can wait for the mirror
const srecCastOwns = (tabId) => castTab != null && tabId === castTab;
// The answer worth acting on: a caller that CAN await gets the truth, not a mirror mid-re-seed.
const srecCastOwnsReady = async (tabId) => { await castSeeded; return srecCastOwns(tabId); };

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
    });
  }
  // The refusal is the caller's to report; cleared either way, so a later attempt can try again.
  try { await srecCreating; } finally { srecCreating = null; }
}

// Never while a file is parked: the blob: URL — the original's or the trimmed swap's — dies
// with the document that made it.
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

// The offscreen document's own pipe for frames: a broadcast would copy every JPEG, several a
// second, into every extension page. Opened on cast-start, dropped when the recording ends.
let castPort = null;
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'screenrec-frames') return;
  castPort = port;
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (castPort === port) castPort = null; });
});

// Every frame goes to the offscreen canvas and is acked, or the screencast stalls.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.screencastFrame' || !srecCastOwns(source.tabId)) return;
  // The broadcast still carries the bootstrap frame — one can arrive before the port is up.
  if (!castPort) srecOff({ cmd: 'frame', data: params.data });
  else {
    try { castPort.postMessage({ cmd: 'frame', data: params.data }); }
    catch { castPort = null; srecOff({ cmd: 'frame', data: params.data }); }
  }
  chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.screencastFrameAck',
    { sessionId: params.sessionId }, () => void chrome.runtime.lastError);
});

// The infobar's own Cancel detaches, that is a Stop that keeps the file, never a loss.
chrome.debugger.onDetach.addListener(async (source) => {
  if (!srecCastOwns(source.tabId)) return;
  castTab = null;
  const st = await srecGet();
  if (!st || !st.recording || st.mode !== 'cast') return;
  if (st.framesOut) await foreignFramesBack(source.tabId);
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
  // #101's disease strikes here too: a chrome-extension:// frame in the page — typically a DEAD
  // one left by a disabled or updated extension — makes Chrome refuse the attach. Same cure as
  // the full-page shot: frames out, one more try, and back where they were when the recording ends.
  let framesOut = false;
  try {
    await castAttach(target.id);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Without a foreign frame in play this is usually DevTools (or another debugger) holding the tab.
    if (!dbgIsForeignFrame(msg)) return { ok: false, reason: 'cast-attach', error: msg };
    await foreignFramesOut(target.id);
    framesOut = true;
    try {
      await castAttach(target.id);
    } catch (e2) {
      await foreignFramesBack(target.id);
      return { ok: false, reason: 'cast-attach-frame', error: String((e2 && e2.message) || e2) };
    }
  }
  // The attach already stands: leave the tab as it was found before reporting the refusal.
  try {
    await srecEnsureDoc();
  } catch (e) {
    await castDetach(target.id);
    if (framesOut) await foreignFramesBack(target.id);
    return { ok: false, reason: 'Could not open the recorder page: ' + String((e && e.message) || e) };
  }
  const started = await srecOff({ cmd: 'cast-start' });
  if (!started || !started.ok) {
    await castDetach(target.id);
    if (framesOut) await foreignFramesBack(target.id);
    await srecCloseDoc();
    return { ok: false, reason: 'Chrome refused the capture' };
  }
  castTab = target.id;
  await srecSet({ recording: true, paused: false, tabId: target.id, recordId, mode: 'cast', framesOut, startedAt: Date.now() });
  await castSend(target.id, 'Page.startScreencast', CAST_PARAMS).catch(() => {});
  await srecInjectBar(target.id);
  srecTell({ type: 'SCREENREC_EVENT', event: 'started', tabId: target.id });
  return { ok: true, tabId: target.id };
}

// The one way out of a cast: Chrome's "…is debugging" bar goes with the debugger session, and
// every end of a recording passes here — twice on the stop path, where the second call is a no-op.
async function srecTeardownCast(st) {
  if (!st || st.mode !== 'cast' || castTab == null) return;
  const tabId = castTab;
  castTab = null; // first, so onDetach stays quiet: whoever ends the recording owns the finish
  await castSend(tabId, 'Page.stopScreencast').catch(() => {});
  await castDetach(tabId);
  // A closed tab throws inside the restore's own try — calling is safe either way.
  if (st.framesOut) await foreignFramesBack(tabId);
}

// ---- start / stop ----------------------------------------------------------

async function srecStart({ recordId = null, tab = null } = {}) {
  const live = await srecGet();
  if (live && live.recording) return { ok: false, reason: 'A screen recording is already running' };
  // Refused before any tab is resolved or attached: a parked take is a recording the tester has
  // not finished with, and starting over would drop it on the floor.
  if (await srecParked()) {
    return {
      ok: false,
      reason: 'A recording is waiting to be reviewed or attached — finish it first',
      parked: true,
    };
  }
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
  try {
    await srecEnsureDoc();
  } catch (e) {
    return { ok: false, reason: 'Could not open the recorder page: ' + String((e && e.message) || e) };
  }
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
  await srecTeardownCast(st);
  const res = await srecOff({ cmd: 'stop', reason });
  await srecFinish((res && res.file) || null, st, reason);
  return { ok: true };
}

// Everything that ends a recording funnels through here: state cleared, file parked — and the
// REVIEW opened over the page (#68 preview+trim). Nothing is attached until the tester says so
// there; the panel only hears 'file' once the review answers.
async function srecFinish(file, st, reason) {
  // A cap ends the recording inside the offscreen document, with no stop to detach the cast.
  await srecTeardownCast(st);
  await srecClear();
  if (!file || !file.size) {
    await srecCloseDoc();
    srecTell({ type: 'SCREENREC_EVENT', event: 'ended', reason: reason || 'user', empty: true });
    return;
  }
  // A parked take is the tester's: the newcomer's bytes go instead, and its document stays open.
  const held = await srecParked();
  if (held && held.url) {
    // …but the take already parked is no newcomer. A tab closing while the worker asks to stop
    // hands the SAME file through both doors, and revoking it would kill the review's own blob.
    if (held.url === file.url) return;
    await srecOff({ cmd: 'revoke', url: file.url });
    srecTell({ type: 'SCREENREC_EVENT', event: 'ended', reason: reason || 'user' });
    return;
  }
  const parked = buildParked(file, st, reason);
  // A key of its own per parked take, so a page that learned the last one has learned nothing.
  await chrome.storage.session.set({ [SREC_FILE_KEY]: parked, [SREC_RKEY_KEY]: crypto.randomUUID() });
  srecTell({ type: 'SCREENREC_EVENT', event: 'review', file: parked });
  await srecOpenReview((st && st.tabId) != null ? st.tabId : null);
}

// The review overlay, over the recorded tab when it still lives, over the site tab otherwise,
// in a tab of its own when Chrome keeps extensions off both.
async function srecOpenReview(tabId) {
  // The overlay goes in FIRST, and the tab comes forward only once it is in: fronting a tab for an
  // inject that then fails moves the tester to a page with no review on it, and the next one again.
  const inject = async (id) => {
    if (id == null) return false;
    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/review-overlay.js'] });
    } catch { return false; }
    // The review is in — this placement stands whether or not Chrome lets us raise the tab.
    try { await chrome.tabs.update(id, { active: true }); } catch { /* left where it is */ }
    return true;
  };
  if (await inject(tabId)) return { ok: true };
  const site = await resolveSiteTab({ verb: 'reviewed' });
  if (site.state === 'ok' && await inject(site.tab.id)) return { ok: true };
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('screenrec/review.html') });
    return { ok: true };
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
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
    // The document died with our debugger session still on the tab: its bar would outlive the take.
    await srecTeardownCast(st);
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
// Held in `castSeeded`, and never rejecting, so a shot landing mid-seed waits for an answer.
castSeeded = srecGet()
  .then((st) => { if (st && st.recording && st.mode === 'cast') castTab = st.tabId; })
  .catch(() => {});

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
  const res = await srecStart({ recordId: await srecTarget(), tab });
  // From the page there is nowhere to report a refusal — a parked take answers with its review.
  if (res && res.parked) await srecOpenReview(null);
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
      chrome.storage.session.remove([SREC_FILE_KEY, SREC_RKEY_KEY]).then(srecCloseDoc).then(() => {
        // Only a discard leaves the plaque with nothing to sit for; an attach speaks for itself.
        if (!msg.attached) srecTell({ type: 'SCREENREC_EVENT', event: 'ended', reason: 'discarded' });
        sendResponse({ ok: true });
      });
      return true;
    // The 'file' event is a broadcast: every open panel document would upload the same take.
    case 'SCREENREC_CLAIM':
      serialize(async () => {
        const parked = await srecParked();
        if (!parked) return sendResponse({ ok: false });
        // One instant for both the verdict and the stamp, so the TTL runs from the claim it granted.
        const now = Date.now();
        if (!claimOk(parked, msg.by, now)) return sendResponse({ ok: false });
        await chrome.storage.session.set({ [SREC_FILE_KEY]: applyClaim(parked, msg.by, now) });
        return sendResponse({ ok: true });
      });
      return true;
    // Sent when an upload fails, so the next «Retry attach…» — here or in another panel — can claim it.
    case 'SCREENREC_UNCLAIM':
      serialize(async () => {
        const rest = dropClaim(await srecParked(), msg.by);
        if (rest) await chrome.storage.session.set({ [SREC_FILE_KEY]: rest });
        return sendResponse({ ok: true });
      });
      return true;
    // The review approved the file AS RECORDED — only now may the panel attach it.
    case 'SCREENREC_REVIEWED':
      srecParked().then(async (parked) => {
        if (!parked) return sendResponse({ ok: false });
        const reviewed = applyReviewed(parked);
        await chrome.storage.session.set({ [SREC_FILE_KEY]: reviewed });
        srecTell({ type: 'SCREENREC_EVENT', event: 'file', file: reviewed });
        return sendResponse({ ok: true });
      });
      return true;
    // The review cut it: the offscreen page has already swapped the trimmed bytes in and
    // revoked the original's URL — only the cut version exists from here on.
    case 'SCREENREC_TRIMMED':
      srecParked().then(async (parked) => {
        if (!parked || !msg.url) return sendResponse({ ok: false });
        const trimmed = applyTrimmed(parked, msg);
        await chrome.storage.session.set({ [SREC_FILE_KEY]: trimmed });
        srecTell({ type: 'SCREENREC_EVENT', event: 'file', file: trimmed });
        return sendResponse({ ok: true });
      });
      return true;
    // Only the worker may read storage.session; content/review-overlay.js needs this to prove to
    // the review page that the extension framed it and the page under test did not.
    case 'SCREENREC_REVIEW_KEY':
      chrome.storage.session.get(SREC_RKEY_KEY)
        .then((r) => sendResponse({ key: r[SREC_RKEY_KEY] || '' }));
      return true;
    // The panel's button while an unreviewed file waits: back to the review, never a new take.
    case 'SCREENREC_OPEN_REVIEW':
      srecOpenReview(null).then(sendResponse);
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
