// Test-view hotkeys (web-runner parity) and the tab-screenshot capture helpers.

/* global TestomatAPI, CaptureAnnotate, resolveSiteTab, Tooltip */

// ---------- hotkeys (US5) ----------
// Web-runner parity (manual-run.hbs:223-232): Cmd/Ctrl+Enter -> passed,
// Cmd/Ctrl+U -> failed, Cmd/Ctrl+I -> skipped. Each calls the SAME clickStatus
// the big ✓/✗/− buttons call, so a shortcut and a click are one action (#77).
// NONE of them navigates: since #108 marking always stays on the test (the web's
// saveTestRun passes openNext=true for every status — this is our deliberate
// divergence, so the substatus/assignee/comment/attachment controls that appear
// on marking are actually reachable). Moving on is `N` -> nextTest(), the hotkey
// half of the persistent "Next test →" button; the fast flow is those two keys.
// Arrows step ±1 through the list without writing. Active only in the test view;
// both Cmd and Ctrl accepted on every platform (mirrors the web's dual bindings).

// Suppress shortcuts while the tester is typing so keystrokes stay natural (FR-010).
function typingInField(target) {
  const el = target || document.activeElement;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

// Move ±1 through the VISIBLE sequence (filter + search applied), clamped at the
// edges (no wrap-around). A row hidden by the filter is never navigated to.
function navigateTest(delta) {
  const order = visibleRecords();
  const from = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= order.length) return; // stop at the edges of the visible seq (no wrap)
  openTestView(order[to].id);
}

const HOTKEY_STATUS = { Enter: 'passed', KeyU: 'failed', KeyI: 'skipped' };

// ---- hotkey discoverability (tooltips + a "?" legend) --------------------
// The handler accepts both Cmd and Ctrl on every platform; the LABELS show the
// platform-appropriate modifier (mac ⌘ vs Ctrl+) so the hint reads naturally.
// (The task assumed platform detection already lived here — it didn't, so this
// mirrors env-info.js's UA-CH-first approach.)
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
const HK_MOD = IS_MAC ? '⌘' : 'Ctrl+';
const HK_STATUS_KEY = { passed: '⏎', failed: 'U', skipped: 'I' };
// "Next test" is a bare letter on purpose (#108): every modified chord that reads
// as "next" is taken by the browser (Cmd/Ctrl+N opens a window and cannot be
// preventDefault'ed), and the plain arrows already mean ±1 in the list.
const HK_NEXT_KEY = 'N';

function hotkeyStatusLabel(status) { return `${HK_MOD}${HK_STATUS_KEY[status]}`; }

// Set the status-button tooltips and build the legend rows once (labels are
// static per platform). Called from app init.
function initHotkeyHints() {
  Tooltip.set($('btn-passed'), `Passed (${hotkeyStatusLabel('passed')})`);
  Tooltip.set($('btn-failed'), `Failed (${hotkeyStatusLabel('failed')})`);
  Tooltip.set($('btn-skipped'), `Skipped (${hotkeyStatusLabel('skipped')})`);
  // The pager's two steps are the ARROWS' move (±1 through the visible list), so
  // that is what their tooltips name. The bare-letter N — jump to the next
  // UNTESTED row — has no button of its own any more; it lives in the legend
  // below, which is the only place it is written down.
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
  if (typingInField(e.target)) return;       // never steal keys from a field (FR-010)
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
// #187 made the flow re-ask the write lock immediately before the upload, which
// is right — but the refusal used to end at a status line, and the annotated
// image (minutes of drawing) died with it. The upload still must not land, so
// the image is KEPT in one slot instead and the tester can take it off the panel.
// One slot: a second refusal is a newer shot, and the older one had its chance.
let pendingAnnotation = null; // { dataUrl, name, recordId } — dropped once saved to disk

// Shown only on the record it was drawn for. openTestView() resets every other
// per-test control for the same reason ("never let the previous test's
// attachments linger"), and a Save button offered on test B would be lying about
// what it saves. The SLOT is not dropped on navigation, though — coming back
// finds the work still there, which is the whole point of keeping it.
// Deliberately NOT gated by recordWriteLock: this writes to the tester's own
// machine, never to the server, so a finished run has no say in it.
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

// Single screenshot flow: capture the active tab, hand off to the annotator, then
// upload whatever dataURL comes back. Apply uploads the merged JPEG (even with
// zero annotations); Keep original uploads the raw shot (owner-approved); Discard
// returns null → no upload, no state change.
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
    setStatusLine('test-status', 'Capturing tab…');
    const fullPage = fullPageCaptureEnabled();
    const resp = await chrome.runtime.sendMessage({ type: 'captureTab', fullPage }).catch((e) => ({ ok: false, error: String(e) }));
    if (!resp?.ok) {
      setStatusLine('test-status', '', '');
      // The worker's reason is already the honest one (site access was checked above).
      toast(`Capture failed: ${resp?.error || 'unknown'}`, { error: true });
      return;
    }
    // #101: the debugger was refused, so this is the viewport alone — never let a
    // "Full page" request hand back a cropped shot silently.
    if (fullPage && resp.viewportOnly) toast('Full page needs the debugger, which this page blocks — captured the viewport.', { ms: 8000 });
    setStatusLine('test-status', 'Annotating…');
    const annotated = await CaptureAnnotate.annotateImage(resp.dataUrl, resp.tabId, { toast });
    if (!annotated) { setStatusLine('test-status', '', ''); return; } // Discard — no upload, no state change
    // #187 — the gate above is minutes old by now: the annotator is interactive and the
    // run can finish under it, so the lock is re-asked immediately before the write.
    const lock = recordWriteLock(recordFor(record.id) || record); // by id: a structural sync apply replaces the row
    // #192: refuse the upload, keep the drawing — the Save button is the way out.
    if (lock) { keepRefusedAnnotation(annotated, record.id); setStatusLine('test-status', lock, 'error'); return; }
    const blob = await (await fetch(annotated)).blob();
    setStatusLine('test-status', 'Uploading screenshot…');
    await TestomatAPI.uploadAttachment(record.id, blob, `panel-annotated-${record.id}-${Date.now()}.jpg`);
    setStatusLine('test-status', 'Screenshot attached ✓', 'ok');
  } catch (e) {
    setStatusLine('test-status', '', '');
    toast(`Upload failed: ${e.message}`, { error: true });
  } finally {
    updateTestActionsState(); // restore the gate-driven disabled state
  }
}
