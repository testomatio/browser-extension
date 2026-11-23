// Evidence panel UI; the background recorder is the source of truth.

/* global chrome, state, hasChrome, $, toast, resolveSiteTab, Tooltip,
   HoverCard, EmptyState, paintCounter, showTestSection, EvidenceFormat, StatusIcons */

// `recordId` is the testrun the session started in, so a panel reload still knows its owner.
const evUi = {
  recording: false, tabId: null, recordId: null, tabTitle: '', tabUrl: '', sectionOpen: false, pollTimer: null,
  expanded: new Set(), errors: [], card: null,
};

// Rows the hover card lists before "+N more" — six fit under the header.
const EV_CARD_ROWS = 6;

async function evSend(message) {
  if (!hasChrome || !chrome.runtime || !chrome.runtime.sendMessage) return { ok: false, error: 'no-extension' };
  try { return await chrome.runtime.sendMessage(message); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function applyEvidenceStatus(status) {
  const was = evUi.recording;
  evUi.recording = !!(status && status.recording);
  evUi.tabId = status && status.tabId != null ? status.tabId : null;
  evUi.recordId = status && status.recordId != null ? status.recordId : null;
  evUi.tabTitle = (status && status.tabTitle) || '';
  // Kept for one job: shortening request rows to their path (evShortUrl).
  evUi.tabUrl = (status && status.tabUrl) || '';
  // A stopped recorder must not leave a live error count standing on the chip.
  if (was && !evUi.recording) { evUi.errors = []; if (evUi.card) evUi.card.close(); }
  renderEvidenceToggle();
  updateEvidenceSection();
  syncEvidencePolling();
}

async function refreshEvidenceStatus() {
  const r = await evSend({ type: 'EVIDENCE_STATUS' });
  applyEvidenceStatus(r && r.ok ? r.status : { recording: false });
}

function renderEvidenceToggle() {
  const btn = $('evidence-toggle');
  if (!btn) return;
  // Test view only: leaving the testrun ends its session, so it never outlives the chip.
  btn.hidden = state.view !== 'test';
  // The slot follows the toggle so an absent chip costs the tabs row no width.
  const slot = $('rec-slot');
  if (slot) slot.hidden = btn.hidden;
  btn.classList.toggle('recording', evUi.recording);
  btn.setAttribute('aria-pressed', evUi.recording ? 'true' : 'false');
  paintEvidenceCount();
  // No tooltip: the hover card is this chip's label, and a `data-tip` would cover it.
  bindEvidenceCard(btn);
  if (evUi.card) evUi.card.update();
}

// Counts the trailing window, so it falls as errors age out: what a FAIL would attach now.
function paintEvidenceCount() {
  const chip = $('evidence-errors');
  const btn = $('evidence-toggle');
  const n = evUi.recording ? evUi.errors.length : 0;
  if (chip) {
    chip.hidden = !n;
    if (n) paintCounter(chip, n);
    else chip.textContent = '';
  }
  // A screen reader cannot hover the card and the chip is `aria-hidden`, so the name carries it all.
  if (!btn) return;
  if (!evUi.recording) {
    btn.setAttribute('aria-label', 'Rec — record the console & network log from the tab under test');
    return;
  }
  const errors = n ? `, ${n} error${n === 1 ? '' : 's'} caught` : '';
  btn.setAttribute('aria-label', `Rec — recording ${evUi.tabTitle || 'tab'}${errors}, click to stop`);
}

// Attached once: the button outlives every repaint, it only moves between the two header rows.
function bindEvidenceCard(btn) {
  if (evUi.card) return;
  evUi.card = HoverCard.attach(btn, {
    className: 'rec-card',
    side: 'bottom', // over the view, never over the tab bar it sits in
    render: evidenceCardContent,
  });
}

function evidenceCardContent() {
  return evUi.recording ? evRecordingCard() : evIdleCard();
}

// Says the recorder keeps a trailing window: arming it after the bug is too late.
function evIdleCard() {
  const box = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'hovercard-head';
  const title = document.createElement('span');
  title.className = 'hovercard-title';
  title.textContent = 'Console & network log';
  head.append(title);
  const meta = document.createElement('p');
  meta.className = 'hovercard-meta';
  meta.textContent = `Not recording · keeps the last ${evWindowSeconds()}s`;
  const hint = document.createElement('p');
  hint.className = 'hovercard-meta';
  hint.textContent = 'Click Rec to capture the console and the failed requests of '
    + 'the tab under test — before reproducing, not after.';
  box.append(head, meta, hint);
  return box;
}

function evRecordingCard() {
  const box = document.createDocumentFragment();

  const head = document.createElement('div');
  head.className = 'hovercard-head';
  const title = document.createElement('span');
  title.className = 'hovercard-title';
  title.textContent = evUi.tabTitle || 'Recording';
  head.append(title);

  const errors = evUi.errors;
  const n = errors.length;
  const meta = document.createElement('p');
  meta.className = 'hovercard-meta';
  meta.textContent = `${n ? `${n} error${n === 1 ? '' : 's'}` : 'No errors yet'} · last ${evWindowSeconds()}s`;
  box.append(head, meta);

  if (!n) {
    box.append(evCardFoot());
    return box;
  }

  // Newest first, unlike the section's list: the card is a glance at what just happened.
  const list = document.createElement('ul');
  list.className = 'hovercard-list';
  for (const e of errors.slice(-EV_CARD_ROWS).reverse()) list.append(evCardRow(e));
  box.append(list);
  const more = n - EV_CARD_ROWS;
  if (more > 0) {
    const rest = document.createElement('p');
    rest.className = 'hovercard-more';
    rest.textContent = `+${more} more`;
    box.append(rest);
  }
  box.append(evCardFoot());
  return box;
}

// The link exists only on the test view — that is the one screen holding the list.
function evCardFoot() {
  const foot = document.createElement('div');
  foot.className = 'hovercard-foot';
  if (state.view === 'test') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link-btn';
    open.textContent = 'Open the console & network log';
    open.addEventListener('click', () => { revealEvidenceSection(); if (evUi.card) evUi.card.close(); });
    const stop = document.createElement('span');
    stop.className = 'hovercard-meta rec-card-stop';
    stop.textContent = 'Click to stop';
    foot.append(open, stop);
  } else {
    const hint = document.createElement('span');
    hint.className = 'hovercard-meta';
    hint.textContent = 'Open a test to attach these — click Rec to stop.';
    foot.append(hint);
  }
  return foot;
}

function evCardRow(e) {
  const li = document.createElement('li');
  li.className = 'hovercard-row';
  const icon = document.createElement('span');
  icon.className = 'ev-icon';
  const mark = EvidenceFormat.icon(e);
  icon.dataset.kind = mark.kind;
  icon.append(StatusIcons.svgIcon(mark.name, 14));
  const txt = document.createElement('span');
  txt.className = 'hovercard-text';
  txt.textContent = evCardRowText(e);
  const at = document.createElement('span');
  at.className = 'hovercard-row-meta';
  at.textContent = evAge(e.ts);
  Tooltip.set(at, EvidenceFormat.time(e.ts));
  li.append(icon, txt, at);
  return li;
}

// A request keeps its host only off the recorded site; a console row keeps `uncaught` only.
function evCardRowText(e) {
  if (e.kind === 'network') return `${EvidenceFormat.netStatus(e)} ${e.method} ${evShortUrl(e.url)}`;
  const kind = e.kind === 'exception' ? 'uncaught · ' : '';
  return `${kind}${EvidenceFormat.oneLine(e.text, 200)}`;
}

// A host-less scheme (data:, blob:, file:) comes back as is: its "path" is the payload.
function evShortUrl(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    if (!u.host) return EvidenceFormat.oneLine(url, 200);
    const here = evUi.tabUrl ? new URL(evUi.tabUrl).host : '';
    const path = `${u.pathname}${u.search}`;
    return EvidenceFormat.oneLine(u.host !== here ? `${u.host}${path}` : path || '/', 200);
  } catch { return EvidenceFormat.oneLine(url, 200); }
}

// Age, not clock time: in a trailing window, the age says how close a row is to ageing out.
function evAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

// The fold lives in the Status tab: switch first, or the unfold happens behind a hidden pane.
function revealEvidenceSection() {
  if (state.view !== 'test') return;
  showTestSection('status');
  if (!evUi.sectionOpen) toggleEvidenceHead();
  else renderEvidenceList(); // already open: repaint, the pane may have been hidden since
  const sec = $('evidence-section');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Shared with the auto-start, so it only reports: each caller narrates the outcome its own way.
async function evStartRecording(stillWanted = null) {
  // `activate`: the recorder binds one tab, so the toast names the right one.
  const site = await resolveSiteTab({ verb: 'recorded', activate: true });
  if (site.state !== 'ok') return { ok: false, unrecordable: site.error };
  if (stillWanted && !stillWanted()) return { ok: false };
  await mirrorCaptureBodiesForRelay(); // before the hook can ask
  if (stillWanted && !stillWanted()) return { ok: false };
  return await evSend({ type: 'EVIDENCE_TOGGLE', tabId: site.tab.id, recordId: state.currentRecordId });
}

async function onEvidenceToggle() {
  const btn = $('evidence-toggle');
  if (btn) btn.disabled = true;
  try {
    let r;
    if (evUi.recording) {
      r = await evSend({ type: 'EVIDENCE_TOGGLE', tabId: null, recordId: state.currentRecordId });
    } else {
      // Defensive: a session needs a testrun to belong to.
      if (state.view !== 'test' || state.currentRecordId == null) { toast('Open a test to record its console & network log'); return; }
      r = await evStartRecording();
      // `r` is undefined when the worker answered nothing; the `!r` guard below handles that.
      if (r && r.unrecordable) { toast(r.unrecordable, { error: true }); return; }
    }
    // Refusals get the error flag, or they read as "done" where `Recording stopped` appears.
    if (!r || !r.ok) { toast(`Recorder: ${(r && r.error) || 'unavailable'}`, { error: true }); await refreshEvidenceStatus(); return; }
    applyEvidenceStatus(r.status);
    // In-page instrumentation: no "…is debugging this browser" bar, and DevTools may stay open.
    toast(r.status.recording ? `Recording ${r.status.tabTitle || 'tab'}` : 'Recording stopped');
  } catch (e) {
    // A throw is a refusal too — same slot as `Recording stopped`, so it needs the same flag.
    toast(`Recorder error: ${e.message}`, { error: true });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Mirrors buffer.js EvBuffer.clampWindow: settings not loaded yet is 60, not 0.
function evWindowSeconds() {
  const raw = state.settings && state.settings.evidenceWindowSec;
  if (raw == null) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(10, Math.round(n)));
}

function updateEvidenceSection() {
  const sec = $('evidence-section');
  if (!sec) return;
  // Shown on the test view even when idle: it answers "where do the logs come from?"
  const onTest = state.view === 'test';
  sec.hidden = !onTest;
  // Expanded keys retire with the list, so a later recording does not reopen old rows.
  if (!onTest || !evUi.recording) evUi.expanded.clear();
  if (!onTest) return;
  renderEvidenceList();
}

function toggleEvidenceHead() {
  evUi.sectionOpen = !evUi.sectionOpen;
  const head = $('evidence-head');
  const body = $('evidence-body');
  if (head) head.setAttribute('aria-expanded', evUi.sectionOpen ? 'true' : 'false');
  if (body) body.hidden = !evUi.sectionOpen;
  // The poll belongs to the recording, not this fold; the rows paint from its last result.
  if (evUi.sectionOpen) { renderEvidenceList(); pollEvidenceErrors(); }
}

// One EVIDENCE_LIST round trip feeds the chip count, the hover card and the fold.
function syncEvidencePolling() {
  if (evUi.recording && !evUi.pollTimer) {
    evUi.pollTimer = setInterval(pollEvidenceErrors, 2000);
    pollEvidenceErrors(); // the count must not wait 2 s for its first figure
  } else if (!evUi.recording) {
    stopEvidencePolling();
  }
}

function stopEvidencePolling() {
  if (evUi.pollTimer) { clearInterval(evUi.pollTimer); evUi.pollTimer = null; }
}

async function pollEvidenceErrors() {
  if (!evUi.recording) { stopEvidencePolling(); return; }
  // A boot that landed away from the bound testrun: the view change already came and went.
  if (evLeftBoundTestrun()) { await evStopLeftTestrun(); return; }
  const r = await evSend({ type: 'EVIDENCE_LIST', errorsOnly: true });
  if (!r || !r.ok) return;
  if (r.status && !r.status.recording) { applyEvidenceStatus(r.status); return; } // recorder stopped underneath us
  evUi.errors = r.entries || [];
  paintEvidenceCount();
  renderEvidenceList();
  if (evUi.card) evUi.card.update(); // a card the pointer is resting in gains the new row
}

function evIdleHint() {
  const rec = document.createElement('strong');
  rec.textContent = 'Rec';
  return EmptyState.build({
    tag: 'li',
    compact: true,
    className: 'evidence-empty',
    icon: 'fiber_manual_record',
    text: ['Not recording. Click ', rec, ' at the top of the panel to capture this tab\u2019s console '
      + `and failed requests \u2014 the last ${evWindowSeconds()}s are kept, and marking the test Failed attaches them.`],
  });
}

// Paints from `evUi.errors` (the poll's copy) — never fetches on its own.
function renderEvidenceList() {
  const ul = $('evidence-list');
  const count = $('evidence-count');
  if (!ul || state.view !== 'test') return;
  const entries = evUi.recording ? evUi.errors : [];
  // Idle shows no figure: a "0" would read as "recorded, and the page was clean".
  if (count) {
    count.hidden = !evUi.recording;
    if (evUi.recording) paintCounter(count, entries.length);
    else count.textContent = '';
  }
  if (!evUi.sectionOpen) return; // folded away: nothing to paint until it opens
  ul.replaceChildren();
  if (!evUi.recording) { ul.append(evIdleHint()); return; }
  if (!entries.length) {
    // A tick, not a shrug: an empty errors-only log means the page behaved.
    ul.append(EmptyState.build({
      tag: 'li',
      compact: true,
      className: 'evidence-empty',
      icon: 'check_circle',
      text: 'No console or network errors captured yet.',
    }));
    return;
  }
  for (const e of entries.slice(-100)) ul.append(evRow(e));
}

function evRow(e) {
  const li = document.createElement('li');
  li.className = `evidence-row ${e.kind === 'network' ? 'ev-net' : 'ev-con'}`;

  const head = document.createElement('div');
  head.className = 'ev-row-head';
  const icon = document.createElement('span');
  icon.className = 'ev-icon';
  const mark = EvidenceFormat.icon(e);
  icon.dataset.kind = mark.kind;
  icon.append(StatusIcons.svgIcon(mark.name, 14));
  const txt = document.createElement('span');
  txt.className = 'ev-text';
  txt.textContent = EvidenceFormat.rowText(e);
  Tooltip.set(txt, EvidenceFormat.rowText(e));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn size-xs ev-attach';
  btn.textContent = 'Attach';
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); attachEvidenceEntry(e); });
  head.append(icon, txt, btn);

  // Open state lives in evUi.expanded, not the DOM, so a poll repaint keeps what the tester left.
  const key = EvidenceFormat.key(e);
  const details = evDetails(e);
  const paint = (open) => { details.hidden = !open; li.classList.toggle('expanded', open); };
  paint(evUi.expanded.has(key));
  head.addEventListener('click', (ev) => {
    if (ev.target.closest('.ev-attach')) return;
    const open = !evUi.expanded.has(key);
    if (open) evUi.expanded.add(key); else evUi.expanded.delete(key);
    paint(open);
  });

  li.append(head, details);
  return li;
}

function evDetails(e) {
  const box = document.createElement('div');
  box.className = 'ev-details';
  box.hidden = true;
  const dl = document.createElement('dl');
  dl.className = 'ev-fields';
  const field = (k, v) => {
    if (v == null || v === '') return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  };
  if (e.kind === 'network') {
    field('Method', e.method);
    field('URL', e.url);
    field('Status', EvidenceFormat.netStatus(e));
    field('MIME', e.mimeType);
    field('Type', e.resourceType);
    if (e.errorText) field('Error', e.errorText);
    field('Timing', e.durationMs != null ? `${e.durationMs} ms` : null);
    field('At', EvidenceFormat.time(e.ts));
    box.append(dl);
    if (e.bodySnippet || e.bodySkipped) {
      const pre = document.createElement('pre');
      pre.className = e.bodySnippet ? 'code ev-body' : 'code ev-body ev-body-note';
      pre.textContent = e.bodySnippet ? e.bodySnippet + (e.bodyTruncated ? '\n… (truncated)' : '') : EvidenceFormat.BODY_DISABLED;
      box.append(pre);
    }
  } else {
    field('Level', EvidenceFormat.label(e));
    field('At', EvidenceFormat.time(e.ts));
    // Untrimmed, unlike the .txt and the comment: nothing here leaves the browser.
    field('Location', EvidenceFormat.loc(e));
    box.append(dl);
    const pre = document.createElement('pre');
    pre.className = 'code ev-body';
    pre.textContent = e.text || '';
    box.append(pre);
  }
  return box;
}

function attachEvidenceEntry(e) {
  const ta = $('test-comment');
  if (!ta) return;
  const snippet = EvidenceFormat.entrySnippet(e);
  ta.value = ta.value ? `${ta.value}\n${snippet}` : snippet;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  toast('Log snippet added to the comment');
}

// Off only skips the FAIL upload; recording and the manual Attach are unaffected.
function evidenceAutoAttachEnabled(settings) {
  return !(settings && settings.evidenceAutoAttach === false);
}

// Decided in the page: page-hook.js is the only side that can read a body (fed by relay.js).
function evidenceCaptureBodiesEnabled(settings) {
  return !(settings && settings.evidenceCaptureBodies === false);
}

// A top-level key, never `settings`: that holds the token, which must not reach the tested page.
async function mirrorCaptureBodiesForRelay() {
  if (!hasChrome || !chrome.storage) return;
  const value = evidenceCaptureBodiesEnabled(state.settings);
  try { await chrome.storage.local.set({ evidenceCaptureBodies: value }); } catch { /* absent -> ON, same rule */ }
}

// Default off, unlike the other evidence toggles: a recorder nobody switched on is a surprise.
function evidenceAutoStartEnabled(settings) {
  return !!(settings && settings.evidenceAutoStart === true);
}

// Entries can overlap; only the newest may start, or a second toggle would stop the first session.
let evAutoStartSeq = 0;

// One attempt per entry, so a manual stop on the open test stands.
async function evAutoStartOnTestView() {
  if (!evidenceAutoStartEnabled(state.settings)) return;
  // Never over a live session, whatever it is bound to, and never without a testrun to bind to.
  if (evUi.recording || state.view !== 'test' || state.currentRecordId == null) return;
  const recordId = state.currentRecordId;
  const seq = ++evAutoStartSeq;
  const stillWanted = () => seq === evAutoStartSeq && state.view === 'test'
    && String(state.currentRecordId) === String(recordId);
  const r = await evStartRecording(stillWanted);
  // Silent: the pulsing chip announces a start, and the test view's hint covers a refused page.
  if (r && r.ok) applyEvidenceStatus(r.status);
}

// Leaving the testrun gets the bare message: naming that cause would mean the test title.
function evStoppedMessage(reason) {
  if (reason === 'target_closed') return 'Recording stopped — the recorded tab was closed';
  if (reason === 'panel-closed') return 'Recording stopped — the panel was closed';
  return 'Recording stopped';
}

// Never mid-boot: the restore passes through the run view, and the recording must survive it.
function evLeftBoundTestrun() {
  if (!evUi.recording || state.booting) return false;
  return state.view !== 'test' || String(state.currentRecordId) !== String(evUi.recordId);
}

// Applied here so the screen being left holds no live chip; the worker's broadcast brings the toast.
async function evStopLeftTestrun() {
  applyEvidenceStatus({ recording: false });
  await evSend({ type: 'EVIDENCE_STOP', reason: 'left-testrun' });
}

// The one place a recording is checked against its screen; show() does not await it.
async function onViewShown(view) {
  if (evLeftBoundTestrun()) await evStopLeftTestrun();
  renderEvidenceToggle();
  updateEvidenceSection();
  if (view !== 'test') return;
  // Awaited: after a panel reload the worker may already be recording this testrun.
  await refreshEvidenceStatus();
  await evAutoStartOnTestView();
}

function initEvidence() {
  const toggle = $('evidence-toggle');
  const head = $('evidence-head');
  if (toggle) toggle.addEventListener('click', onEvidenceToggle);
  if (head) head.addEventListener('click', toggleEvidenceHead);
  if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'EVIDENCE_STOPPED') {
        applyEvidenceStatus({ recording: false });
        // Chained: the next session starts at once, so a "stopped" toast would contradict the screen.
        const chained = msg.reason === 'left-testrun' && evidenceAutoStartEnabled(state.settings)
          && state.view === 'test' && state.currentRecordId != null;
        if (!chained) toast(evStoppedMessage(msg.reason));
      }
    });
  }
  refreshEvidenceStatus();
}
