// Test-view hotkeys (web-runner parity) and the tab-screenshot capture helpers.

/* global TestomatAPI, CaptureAnnotate, resolveSiteTab, Tooltip, TestGates, attRemember,
   renderAttachmentList, progressToast, hideToast, RunLock */

function typingInField(target) {
  const el = target || document.activeElement;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// An open listbox or menu keeps focus on its trigger button, so the typing guard alone misses it.
function popupOpen() {
  return !!document.querySelector('[aria-haspopup][aria-expanded="true"]');
}

// Steps through the visible sequence (filter and search applied), clamped, no wrap.
function navigateTest(delta) {
  const order = pagerRecords(); // the open test keeps its place after a status takes it out of the filter
  const from = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= order.length) return;
  openTestView(order[to].id);
}

const HOTKEY_STATUS = { Enter: 'passed', KeyU: 'failed', KeyI: 'skipped' };

// The handler accepts Cmd and Ctrl everywhere; only the labels are platform-specific.
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
const HK_MOD = IS_MAC ? '⌘' : 'Ctrl+';
const HK_STATUS_KEY = { passed: '⏎', failed: 'U', skipped: 'I' };
// A bare letter: Cmd/Ctrl+N opens a browser window and cannot be preventDefault'ed.
const HK_NEXT_KEY = 'N';

function hotkeyStatusLabel(status) { return `${HK_MOD}${HK_STATUS_KEY[status]}`; }

// Built once: the labels are static per platform.
function initHotkeyHints() {
  Tooltip.set($('btn-passed'), `Passed (${hotkeyStatusLabel('passed')})`);
  Tooltip.set($('btn-failed'), `Failed (${hotkeyStatusLabel('failed')})`);
  Tooltip.set($('btn-skipped'), `Skipped (${hotkeyStatusLabel('skipped')})`);
  // N has no button of its own, so the legend below is the only place it is written down.
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
    clickStatus(status, { key: true });      // the buttons' path; never navigates, never unsets
    return;
  }
  if (e.altKey || e.shiftKey) return;
  // N jumps to the next still-untested visible row, as the "Next test →" button does.
  if (e.code === 'KeyN' || e.key === 'n') { e.preventDefault(); nextTest(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); navigateTest(1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); navigateTest(-1); }
}

// A refused upload keeps the annotated image in one slot so the tester can save it; newer wins.
let pendingAnnotation = null; // { dataUrl, name, recordId } — dropped once saved to disk

// Not gated by RunLock: this writes to the tester's disk, not the server.
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

// No `downloads` permission needed; the revoke waits, since revoking mid-start kills the download.
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

// An MV3 worker can die mid-job; well past a full-page shot, so only a dead worker hits it.
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

// Apply uploads even with zero annotations, Keep original the raw shot, Discard nothing.
async function attachScreenshotAnnotated() {
  const btn = $('btn-screenshot-annotate');
  if (btn?.disabled) return; // gated (no result / basic mode / finished or automated run) or a capture in flight
  const record = recordFor(state.currentRecordId);
  if (RunLock.recordWriteLock(record)) return; // re-asked at the upload
  if (!record?.id) return;
  if (!hasChrome || !chrome.runtime?.sendMessage) {
    toast('Screenshots need the extension context');
    return;
  }
  if (btn) btn.disabled = true; // double-click guard for the whole capture→upload flow
  // Declared out here so the catch can still see it: a failed upload must not cost the drawing too.
  let annotated = null;
  try {
    // Capture and annotator inject both need a page Chrome lets us touch; host access is from install.
    const site = await resolveSiteTab({ verb: 'captured' });
    if (site.state !== 'ok') { toast(site.error); return; }
    const perm = await CaptureAnnotate.ensureCapturePermission();
    if (!perm.ok) {
      toast(perm.error);
      return;
    }
    progressToast('Capturing tab…');
    const fullPage = TestGates.fullPageCaptureEnabled();
    const resp = await captureTab(fullPage);
    if (!resp?.ok) {
      // A grant is missing when another extension blocks the debugger; the worker's text names the fix.
      toast(resp?.needsGrant ? resp.error : `Capture failed: ${resp?.error || 'unknown'}`, { error: true });
      return;
    }
    // Never let a "Full page" request hand back a cropped shot silently.
    if (fullPage && resp.viewportOnly) toast('Full page needs the debugger, which this page blocks — captured the viewport.', { ms: 8000 });
    else if (fullPage && resp.heightClipped) toast('This page is taller than a screenshot can be — the shot stops at the full-page limit.', { ms: 8000 });
    else progressToast('Annotating…');
    annotated = await CaptureAnnotate.annotateImage(resp.dataUrl, resp.tabId, { toast });
    if (!annotated) { hideToast(); return; } // Discard — no upload, no state change
    // The run can finish while the annotator is open, so the lock is re-asked right before the write.
    const lock = RunLock.recordWriteLock(recordFor(record.id) || record); // by id: a structural sync apply replaces the row
    // Refuse the upload but keep the drawing; the Save button is the way out.
    if (lock) { keepRefusedAnnotation(annotated, record.id); setStatusLine('test-status', lock, 'error'); return; }
    const blob = await (await fetch(annotated)).blob();
    progressToast('Uploading screenshot…');
    const name = `panel-annotated-${record.id}-${Date.now()}.jpg`;
    const res = await TestomatAPI.uploadAttachment(record.id, blob, name);
    // The server list is re-read only on reopen, so remember the shot locally, keyed by record id.
    attRemember(record.id, { name, url: (res && res.url) || '' });
    renderAttachmentList();
    setStatusLine('test-status', 'Screenshot attached ✓', 'ok');
  } catch (e) {
    // A connection that drops mid-upload is the same loss as a refusal — keep it, offer Save.
    if (annotated) keepRefusedAnnotation(annotated, record.id);
    toast(`Upload failed: ${e.message}`, { error: true }); // …which also takes the progress plaque down
  } finally {
    TestGates.update(); // restore the gate-driven disabled state
  }
}
