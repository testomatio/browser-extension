// Screen recording (#68), panel side: the button, what it says while a recording runs, and the
// upload of the file the worker parks when it stops. The worker owns the capture, this owns the JWT.

/* global TestomatAPI, state, recordFor, recordWriteLock, $, toast, setStatusLine,
   TestGates, attRemember, renderAttachmentList, progressToast, hideToast */

const SREC_COMMAND = 'toggle-screen-recording';
// One token per panel document: the worker's claim keeps two open panels off the same upload.
const SREC_ME = Math.random().toString(36).slice(2);

let srecTimer = null;
let srecBusy = false;

const srecSend = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

const srecClock = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function srecReason(text) {
  const el = $('screen-rec-reason');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function srecPaint(st) {
  const btn = $('btn-screen-rec');
  if (!btn) return;
  const on = !!(st && st.recording);
  // ANY parked take: the button finishes that one — its review, or the attach that failed —
  // never a new recording over it.
  const waiting = !on && !!(st && st.file);
  const label = $('screen-rec-label');
  if (label) {
    label.textContent = on ? `Stop recording ${srecClock(st.ms)}`
      : waiting ? (st.file.reviewed ? 'Retry attach…' : 'Review recording…') : 'Attach screen recording';
  }
  btn.classList.toggle('recording', on);
  if (on || waiting) btn.disabled = false; // stopping/reviewing is never gated: the file is the tester's
  if (on && !srecTimer) srecTimer = setInterval(srecRefresh, 1000);
  if (!on && srecTimer) { clearInterval(srecTimer); srecTimer = null; }
}

async function srecRefresh() {
  srecPaint(await srecSend({ type: 'SCREENREC_STATUS' }));
}

// Chrome names the shortcut, and it is empty when the tester has cleared it.
async function srecShortcut() {
  try {
    const all = await chrome.commands.getAll();
    const cmd = all.find((c) => c.name === SREC_COMMAND);
    return (cmd && cmd.shortcut) || '';
  } catch { return ''; }
}

async function srecStartHint(res) {
  if (res && res.reason === 'cast-attach-frame') {
    // The frames-out rescue ran and Chrome still refused — reloading the page is what clears it.
    const key = await srecShortcut();
    return 'Another extension left a frame on this page and Chrome blocks the recording — '
      + `reload the page${key ? `, or press ${key} on the tab` : ''}.`
      + (res.error ? ` Chrome says: ${res.error}` : '');
  }
  if (!res || res.reason !== 'cast-attach') return (res && res.reason) || 'Chrome refused the capture';
  // Both routes are taken: the debugger fallback is held by DevTools (or another debugger),
  // and only a real gesture on the tab unlocks the tabCapture route.
  const key = await srecShortcut();
  return 'Another debugger holds that tab (DevTools open?). Close it, '
    + (key ? `or press ${key} on the tab, ` : '')
    + 'or right-click the page and choose "Record this tab for Testomat.io".'
    // The raw refusal names the holder when Chrome knows it — worth more than our guess.
    + (res.error ? ` Chrome says: ${res.error}` : '');
}

async function onScreenRecClick() {
  const btn = $('btn-screen-rec');
  if (!btn || btn.disabled) return;
  const st = await srecSend({ type: 'SCREENREC_STATUS' });
  if (st && st.recording) {
    await srecSend({ type: 'SCREENREC_STOP' });
    await srecRefresh();
    return;
  }
  // A reviewed take is parked because its upload failed — the click retries THAT, not a new take.
  if (st && st.file && st.file.reviewed) {
    await srecAttach(st.file);
    return;
  }
  if (st && st.file && !st.file.reviewed) {
    await srecSend({ type: 'SCREENREC_OPEN_REVIEW' });
    return;
  }
  const record = recordFor(state.currentRecordId);
  if (!record || !record.id) return; // the gate should have caught this; never record blind
  srecReason('');
  const res = await srecSend({ type: 'SCREENREC_START', recordId: record.id });
  if (!res || !res.ok) { srecReason(await srecStartHint(res)); return; }
  progressToast('Recording this tab…');
  srecRefresh();
}

// The blob: URL — the original's or the trimmed swap's — belongs to the offscreen document,
// and this panel shares its origin, so the bytes come back with a plain fetch. A failed
// upload KEEPS the file parked for the next try.
async function srecAttach(file) {
  if (srecBusy || !file || !file.url || !file.reviewed) return;
  // The take names the result it was started for; the panel may have moved on since it stopped.
  const bound = file.recordId != null;
  const record = recordFor(bound ? file.recordId : state.currentRecordId);
  // Its test is not even loaded here — parked is better than landing on a stranger.
  if (bound && !record) {
    srecReason('This recording belongs to another test — open it to attach the file.');
    await srecRefresh(); // still parked and reviewed — the label says so instead of going stale
    return;
  }
  if (!record || !record.id) { srecReason('Open a test result and the recording attaches to it.'); return; }
  const lock = recordWriteLock(record);
  if (lock) { srecReason(lock); return; }
  // Refused: another panel document is already uploading this take — not this tester's problem.
  const claim = await srecSend({ type: 'SCREENREC_CLAIM', by: SREC_ME });
  if (!claim || !claim.ok) return;
  srecBusy = true;
  const btn = $('btn-screen-rec');
  if (btn) btn.disabled = true;
  try {
    progressToast(`Uploading ${file.name}…`);
    const blob = await fetch(file.url).then((r) => r.blob());
    const res = await TestomatAPI.uploadAttachment(record.id, blob, file.name);
    attRemember(record.id, { name: file.name, url: (res && res.url) || '' });
    await srecSend({ type: 'SCREENREC_DONE', attached: true });
    srecReason('');
    if (String(record.id) === String(state.currentRecordId)) {
      renderAttachmentList();
      setStatusLine('test-status', 'Recording attached ✓', 'ok');
    } else {
      // That list and that status line belong to the OPEN test — a landing elsewhere names itself.
      toast(`Recording attached to "${record.test_title || `Test ${record.test_id}`}"`);
    }
  } catch (e) {
    // The file stays parked, so it must not stay claimed either: «Retry attach…» claims it again.
    await srecSend({ type: 'SCREENREC_UNCLAIM', by: SREC_ME });
    toast(`${file.name}: upload failed, ${e.message}`, { error: true }); // …which also takes the progress plaque down
  } finally {
    srecBusy = false;
    TestGates.update();
    srecRefresh();
  }
}

// A recording started from the page binds to whatever result is open here, so the worker is
// told which one that is; a file parked for THIS result lands on arrival.
async function srecOnTestOpen() {
  const record = recordFor(state.currentRecordId);
  await srecSend({ type: 'SCREENREC_TARGET', recordId: (record && record.id) || null });
  await srecRefresh();
  const parked = await srecSend({ type: 'SCREENREC_TAKE' });
  // Unreviewed stays parked — the button reads «Review recording…» and leads back to it.
  if (!parked || !parked.reviewed) return;
  // A bound take waits for ITS test to be opened, not for the next one to come along.
  if (parked.recordId != null && String(parked.recordId) !== String(state.currentRecordId)) return;
  srecAttach(parked);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'SCREENREC_EVENT') return undefined;
  if (msg.event === 'file' && msg.file) srecAttach(msg.file);
  else {
    // Nothing left to attach — nothing was recorded, or the take is gone — so the plaque goes too.
    if (msg.event === 'ended' && (msg.empty || msg.reason === 'discarded')) hideToast();
    srecRefresh();
  }
  return undefined;
});

function initScreenRec() {
  const btn = $('btn-screen-rec');
  if (btn) btn.addEventListener('click', onScreenRecClick);
  srecRefresh();
}
