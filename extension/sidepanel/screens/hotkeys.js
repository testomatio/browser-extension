// Test-view hotkeys (web-runner parity) and the tab-screenshot capture helpers.

/* global TestomatAPI, CaptureAnnotate, resolveSiteTab, Tooltip, attRemember,
   renderAttachmentList, progressToast, hideToast */

// ---------- hotkeys (US5) ----------
// Cmd/Ctrl+Enter/U/I mark passed/failed/skipped through the SAME clickStatus the
// buttons call. Deliberate divergence from the web: none of them navigates (#108).

// Suppress shortcuts while the tester is typing.
function typingInField(target) {
  const el = target || document.activeElement;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// …and while a popup is up: an open listbox/menu leaves focus on its `<button>`
// trigger, so the typing guard alone lets bare letters through underneath it.
// Every popup control marks its trigger the same way, so new ones come covered.
function popupOpen() {
  return !!document.querySelector('[aria-haspopup][aria-expanded="true"]');
}

// ±1 through the VISIBLE sequence (filter + search applied), clamped, no wrap.
function navigateTest(delta) {
  const order = visibleRecords();
  const from = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= order.length) return;
  openTestView(order[to].id);
}

const HOTKEY_STATUS = { Enter: 'passed', KeyU: 'failed', KeyI: 'skipped' };

// ---- hotkey discoverability (tooltips + a "?" legend) --------------------
// The handler accepts both Cmd and Ctrl everywhere; only the LABELS are platform-
// specific (mac ⌘ vs Ctrl+).
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
const HK_MOD = IS_MAC ? '⌘' : 'Ctrl+';
const HK_STATUS_KEY = { passed: '⏎', failed: 'U', skipped: 'I' };
// A bare letter on purpose (#108): Cmd/Ctrl+N opens a browser window and cannot be
// preventDefault'ed, and the plain arrows already mean ±1 in the list.
const HK_NEXT_KEY = 'N';

function hotkeyStatusLabel(status) { return `${HK_MOD}${HK_STATUS_KEY[status]}`; }

// Built once — the labels are static per platform. Called from app init.
function initHotkeyHints() {
  Tooltip.set($('btn-passed'), `Passed (${hotkeyStatusLabel('passed')})`);
  Tooltip.set($('btn-failed'), `Failed (${hotkeyStatusLabel('failed')})`);
  Tooltip.set($('btn-skipped'), `Skipped (${hotkeyStatusLabel('skipped')})`);
  // N (jump to the next UNTESTED row) has no button of its own — the legend below
  // is the only place it is written down.
  Tooltip.set($('btn-prev-test'), 'Previous test (↑ / ←)');
  Tooltip.set($('btn-next-test'), 'Next test (↓ / →)');

  const legend = $('hotkey-legend');
  if (legend) {
    const rows = [
      ['Passed', hotkeyStatusLabel('passed')],
      ['Failed', hotkeyStatusLabel('failed')],
      ['Skipped', hotkeyStatusLabel('skipped')],
      ['Next untested test', HK_NEXT_KEY],
      ['Previous test', '↑ / ←'],
      ['Next test in list', '↓ / →'],
    ];
    legend.replaceChildren();
    for (const [name, keys] of rows) {
      const row = document.createElement('div');
      row.className = 'hk-row';
      const n = document.createElement('span'); n.className = 'hk-name'; n.textContent = name;
      const k = document.createElement('kbd'); k.className = 'kbd hk-keys'; k.textContent = keys;
      row.append(n, k);
      legend.append(row);
    }
  }

  const help = $('hotkey-help');
  if (help) help.addEventListener('click', toggleHotkeyLegend);
}

function toggleHotkeyLegend() {
  const legend = $('hotkey-legend');
  const help = $('hotkey-help');
  if (!legend) return;
  const opening = legend.hidden;
  legend.hidden = !opening;
  if (help) help.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

function onHotkey(e) {
  if (state.view !== 'test') return;         // hotkeys live only in the test view
  if (typingInField(e.target)) return;       // never steal keys from a field
  if (popupOpen()) return;                   // an open popup owns the keyboard, modifiers included
  if (e.metaKey || e.ctrlKey) {              // Cmd (mac) / Ctrl (win/linux); accept both
    const code = e.code === 'Enter' || e.key === 'Enter' ? 'Enter' : e.code;
    const status = HOTKEY_STATUS[code];
    if (!status) return;
    e.preventDefault();                      // beat browser defaults (view-source/italic/underline)
    clickStatus(status);                     // the buttons' own path: saves and stays put (#77/#108)
    return;
  }
  if (e.altKey || e.shiftKey) return;
  // N — the "Next test →" button's hotkey (#108): next still-untested visible row.
  if (e.code === 'KeyN' || e.key === 'n') { e.preventDefault(); nextTest(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); navigateTest(1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); navigateTest(-1); }
}

// ---- the annotation an upload refusal must not throw away (#192) ----------
// The refusal still blocks the upload, but the annotated image is KEPT in one slot
// so the tester can take it off the panel. One slot — a newer shot wins.
let pendingAnnotation = null; // { dataUrl, name, recordId } — dropped once saved to disk

// Shown only on the record it was drawn for; the SLOT itself survives navigation.
// NOT gated by recordWriteLock — this writes to the tester's disk, not the server.
function renderPendingAnnotation() {
  const btn = $('btn-save-annotation');
  if (!btn) return;
  btn.hidden = !(pendingAnnotation
    && String(pendingAnnotation.recordId) === String(state.currentRecordId));
}

function keepRefusedAnnotation(dataUrl, recordId) {
  pendingAnnotation = { dataUrl, name: `panel-annotated-${recordId}-${Date.now()}.jpg`, recordId };
  renderPendingAnnotation();
}

// An anchor + object URL: the panel holds no `downloads` permission and needs
// none. The revoke is deferred — revoking while the download is starting kills it.
async function savePendingAnnotation() {
  if (!pendingAnnotation) return;
  const { dataUrl, name } = pendingAnnotation;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    pendingAnnotation = null; // it is on disk now — the work is no longer at risk
    renderPendingAnnotation();
    setStatusLine('test-status', `Annotated screenshot saved as ${name} ✓`, 'ok');
  } catch (e) {
    // The slot is kept on purpose: a failed save must not be a second loss.
    setStatusLine('test-status', `Couldn't save the annotated screenshot: ${e.message}`, 'error');
  }
}

// The worker does the shooting, and an MV3 worker can be torn down mid-job — a promise that
// never settles would leave the panel saying "Capturing tab…" for good. Well past a full-page
// shot, so a slow page still lands; only a dead worker hits it.
const CAPTURE_TIMEOUT_MS = 30000;

function captureTab(fullPage) {
  const asked = chrome.runtime.sendMessage({ type: 'captureTab', fullPage })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  const gaveUp = new Promise((resolve) => setTimeout(() => resolve({
    ok: false,
    error: 'the screenshot service did not answer — reload the extension on chrome://extensions and try again',
  }), CAPTURE_TIMEOUT_MS));
  return Promise.race([asked, gaveUp]);
}

// Capture → annotate → upload. Apply uploads the merged JPEG even with zero
// annotations, Keep original the raw shot, Discard returns null (no upload).
async function attachScreenshotAnnotated() {
  const btn = $('btn-screenshot-annotate');
  if (btn?.disabled) return; // gated (no result / basic mode / finished or automated run) or a capture in flight
  const record = recordFor(state.currentRecordId);
  if (recordWriteLock(record)) return; // #152/#154 — re-asked at the upload (#187)
  if (!record?.id) return;
  if (!hasChrome || !chrome.runtime?.sendMessage) {
    toast('Screenshots need the extension context');
    return;
  }
  if (btn) btn.disabled = true; // double-click guard for the whole capture→upload flow
  try {
    // The tab under test: the capture AND the annotator-overlay inject both need a
    // page Chrome lets us touch. Never a prompt — host access is held from install.
    const site = await resolveSiteTab({ verb: 'captured' });
    if (site.state !== 'ok') { toast(site.error); return; }
    const perm = await CaptureAnnotate.ensureCapturePermission();
    if (!perm.ok) {
      toast(perm.error);
      return;
    }
    progressToast('Capturing tab…');
    const fullPage = fullPageCaptureEnabled();
    const resp = await captureTab(fullPage);
    if (!resp?.ok) {
      // #101: another extension's frame blocked the debugger and the viewport
      // rescue is short of `activeTab` — the worker's sentence names the fix.
      toast(resp?.needsGrant ? resp.error : `Capture failed: ${resp?.error || 'unknown'}`, { error: true });
      return;
    }
    // #101: the debugger was refused, so this is the viewport alone — never let a
    // "Full page" request hand back a cropped shot silently.
    // One plaque at a time: the warning IS the message here, so it stands in place of the
    // "Annotating…" step — the annotator itself is on the page, where the panel says nothing.
    if (fullPage && resp.viewportOnly) toast('Full page needs the debugger, which this page blocks — captured the viewport.', { ms: 8000 });
    else progressToast('Annotating…');
    const annotated = await CaptureAnnotate.annotateImage(resp.dataUrl, resp.tabId, { toast });
    if (!annotated) { hideToast(); return; } // Discard — no upload, no state change
    // #187: the annotator is interactive and the run can finish under it, so the
    // lock is re-asked immediately before the write.
    const lock = recordWriteLock(recordFor(record.id) || record); // by id: a structural sync apply replaces the row
    // #192: refuse the upload, keep the drawing — the Save button is the way out.
    if (lock) { keepRefusedAnnotation(annotated, record.id); setStatusLine('test-status', lock, 'error'); return; }
    const blob = await (await fetch(annotated)).blob();
    progressToast('Uploading screenshot…');
    const name = `panel-annotated-${record.id}-${Date.now()}.jpg`;
    const res = await TestomatAPI.uploadAttachment(record.id, blob, name);
    // The server list is re-read only on reopen, so the shot would sit invisible on a
    // screen the tester is already looking at — the same remember+repaint the file
    // picker does (attachments.js), keyed by record id so a navigation away is safe.
    attRemember(record.id, { name, url: (res && res.url) || '' });
    renderAttachmentList();
    setStatusLine('test-status', 'Screenshot attached ✓', 'ok');
  } catch (e) {
    toast(`Upload failed: ${e.message}`, { error: true }); // …which also takes the progress plaque down
  } finally {
    updateTestActionsState(); // restore the gate-driven disabled state
  }
}
