// Evidence panel UI: Record toggle, errors-only section, per-entry Attach, the
// auto-attach on FAIL and the auto-start on entering a testrun. The background
// recorder is the source of truth.

/* global TestomatAPI, chrome, state, hasChrome, $, toast, resolveSiteTab, Tooltip,
   HoverCard, EmptyState, paintCounter, svgIcon, showTestSection, envTrimUrl */

// The window is NOT mirrored here — evWindowSeconds() reads state.settings, which
// leads the recorder's copy. `expanded` must outlive the 2 s poll repaint (#150).
// `recordId` is the recorder's copy, not state.currentRecordId: the testrun the session was
// STARTED in, so a panel reload still knows which screen owns it (rec scoped to its testrun).
const evUi = {
  recording: false, tabId: null, recordId: null, tabTitle: '', tabUrl: '', sectionOpen: false, pollTimer: null,
  expanded: new Set(), errors: [], card: null,
};

// Rows the hover card lists before "+N more" — six fit under the header.
const EV_CARD_ROWS = 6;

// ---- messaging -----------------------------------------------------------

async function evSend(message) {
  if (!hasChrome || !chrome.runtime || !chrome.runtime.sendMessage) return { ok: false, error: 'no-extension' };
  try { return await chrome.runtime.sendMessage(message); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---- formatting ----------------------------------------------------------

function evTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function evOneLine(s, max = 200) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function evNetStatus(e) { return e.errorText ? (e.status || 'ERR') : (e.status != null ? e.status : '—'); }

// `uncaught` (#163) is an exception or unhandled rejection — no console call made
// that row, so it must not read as one.
function evLabel(e) {
  if (e.kind === 'exception') return `uncaught.${e.level}`;
  return e.kind === 'log' ? `log.${e.level}` : `console.${e.level}`;
}

// source:line:col — the col only an uncaught row carries.
function evLoc(e) {
  if (!e.url) return '';
  return `${e.url}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : ''}`;
}

// Stands in for a body the recorder deliberately did not read (#95 toggle OFF).
const EV_BODY_DISABLED = '(body capture disabled)';

// The fence is longer than any backtick run inside, so the body cannot break out.
function evFence(body) {
  const runs = String(body).match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1));
  return `${fence}\n${body}\n${fence}`;
}

// #175: message/url/errorText are written by the PAGE — a backtick would close the
// inline span and hand the rest to the markdown renderer; a newline ends the quote.
function evInlineCode(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const runs = s.match(/`+/g) || [];
  const ticks = '`'.repeat(runs.reduce((m, r) => Math.max(m, r.length), 0) + 1);
  const pad = /^`|`$/.test(s) ? ' ' : ''; // CommonMark strips one space from each end
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

function evEntrySnippet(e) {
  const t = evTime(e.ts);
  if (e.kind === 'network') {
    const inner = e.errorText
      ? `${evNetStatus(e)} ${e.method} ${e.url} ${e.errorText} ${t}`
      : `${evNetStatus(e)} ${e.method} ${e.url} ${t}`;
    let out = `> ${evInlineCode(`[${inner}]`)}`;
    if (e.bodySnippet) out += `\n\n${evFence(e.bodySnippet + (e.bodyTruncated ? '\n… (truncated)' : ''))}`;
    return out;
  }
  return `> ${evInlineCode(`[${evLabel(e)} ${t}] ${evOneLine(e.text)}`)}`;
}

function evRowText(e) {
  const t = evTime(e.ts);
  if (e.kind === 'network') return `${evNetStatus(e)} ${e.method} ${evOneLine(e.url, 120)} · ${t}`;
  return `${evLabel(e)} · ${evOneLine(e.text, 120)} · ${t}`;
}

// Stable across re-renders (#150): `ts` is stamped once and never rewritten, the
// requestId separates redirect hops, and page-hook rows carry no requestId.
function evKey(e) {
  if (e.kind === 'network') return `network:${e.ts}:${e.requestId || `${e.method} ${e.url}`}`;
  return `${e.kind}:${e.ts}:${e.text || ''}`;
}

// Returns the icon AND the severity that colours it — an icon carries no colour
// of its own, and the two must never disagree.
function evIcon(e) {
  if (e.kind === 'network') {
    return e.errorText ? { name: 'block', kind: 'error' } : { name: 'language', kind: 'net' };
  }
  return e.level === 'warning' ? { name: 'warning', kind: 'warning' } : { name: 'error', kind: 'error' };
}

// Readable .txt artifact (header + Console + Network sections) for auto-attach. UPLOADED onto the
// result, so every address in it goes through envTrimUrl — a query string carries tokens (PRIVACY.md).
// Unconditional, unlike the env meta's one line: this file is every request of a whole minute, and
// it stays on the result for the team to read, so the full-URL setting deliberately does not reach it.
function evBuildTxt(runTitle, testTitle, entries, status) {
  const lines = [];
  lines.push(`Console & network log — ${runTitle || 'Run'} / ${testTitle || 'Test'}`);
  lines.push(`Recorded tab: ${status.tabTitle || '—'}`);
  if (status.tabUrl) lines.push(`URL: ${envTrimUrl(status.tabUrl)}`);
  // A status with no window would write "last undefineds" into a file that is uploaded onto
  // the result: the panel's own kept window stands in, the way every other field here falls back.
  const win = Number.isFinite(status.windowSec) ? status.windowSec : evWindowSeconds();
  lines.push(`Window: last ${win}s · ${entries.length} entries · ${new Date().toISOString()}`);
  lines.push('');
  const cons = entries.filter((e) => e.kind !== 'network');
  const nets = entries.filter((e) => e.kind === 'network');
  lines.push(`== Console (${cons.length}) ==`);
  if (!cons.length) lines.push('(none)');
  for (const e of cons) {
    const loc = evLoc(e) ? ` (${evLoc(e)})` : '';
    lines.push(`[${evTime(e.ts)}] ${evLabel(e)}: ${evOneLine(e.text, 500)}${loc}`);
  }
  lines.push('');
  lines.push(`== Network (${nets.length}) ==`);
  if (!nets.length) lines.push('(none)');
  for (const e of nets) {
    const rt = e.resourceType ? ` [${e.resourceType}]` : '';
    const err = e.errorText ? ` — ${e.errorText}` : '';
    lines.push(`[${evTime(e.ts)}] ${evNetStatus(e)} ${e.method} ${envTrimUrl(e.url)}${rt}${err}`);
    // The captured response body, indented under its request.
    if (e.bodySnippet) {
      for (const bl of e.bodySnippet.split('\n')) lines.push(`    ${bl}`);
      if (e.bodyTruncated) lines.push('    … (truncated)');
    } else if (e.bodySkipped) lines.push(`    ${EV_BODY_DISABLED}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---- status reflection ---------------------------------------------------

function applyEvidenceStatus(status) {
  const was = evUi.recording;
  evUi.recording = !!(status && status.recording);
  evUi.tabId = status && status.tabId != null ? status.tabId : null;
  evUi.recordId = status && status.recordId != null ? status.recordId : null;
  evUi.tabTitle = (status && status.tabTitle) || '';
  // Kept for ONE job: shortening request rows to their path (evShortUrl).
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

// ---- run-header toggle ---------------------------------------------------

function renderEvidenceToggle() {
  const btn = $('evidence-toggle');
  if (!btn) return;
  // The test view alone, recording or not: a session belongs to the testrun it started in,
  // and leaving that screen ends it (onViewShown), so it never outlives the chip.
  btn.hidden = state.view !== 'test';
  // The slot follows the toggle so an absent chip costs the tabs row no width (#127).
  const slot = $('rec-slot');
  if (slot) slot.hidden = btn.hidden;
  btn.classList.toggle('recording', evUi.recording);
  btn.setAttribute('aria-pressed', evUi.recording ? 'true' : 'false');
  paintEvidenceCount();
  // No tooltip in either state — the hover card IS this chip's label, and a
  // `data-tip` would open a black box over the card the pointer came for.
  bindEvidenceCard(btn);
  if (evUi.card) evUi.card.update();
}

// Hidden at zero. The figure counts the trailing window, so it FALLS as errors age
// out — the recorder's contract: it is what a FAIL would attach right now.
function paintEvidenceCount() {
  const chip = $('evidence-errors');
  const btn = $('evidence-toggle');
  const n = evUi.recording ? evUi.errors.length : 0;
  if (chip) {
    chip.hidden = !n;
    if (n) paintCounter(chip, n);
    else chip.textContent = '';
  }
  // A reader cannot hover the card and the count chip is `aria-hidden`, so the
  // button's own NAME has to carry the whole state, count included.
  if (!btn) return;
  if (!evUi.recording) {
    btn.setAttribute('aria-label', 'Rec — record the console & network log from the tab under test');
    return;
  }
  const errors = n ? `, ${n} error${n === 1 ? '' : 's'} caught` : '';
  btn.setAttribute('aria-label', `Rec — recording ${evUi.tabTitle || 'tab'}${errors}, click to stop`);
}

// ---- the chip's hover card (the errors, without leaving the view) ---------

// Attached once — the button outlives every repaint, it only MOVES between the
// two header rows (homeRecSlot, core/views.js).
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

// Idle: says the recorder keeps a TRAILING window — arming it after the bug is
// arming it too late.
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

  // NEWEST first, unlike the section's list — the card is a glance at what just happened.
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
  const mark = evIcon(e);
  icon.dataset.kind = mark.kind;
  icon.append(svgIcon(mark.name, 14));
  const txt = document.createElement('span');
  txt.className = 'hovercard-text';
  txt.textContent = evCardRowText(e);
  const at = document.createElement('span');
  at.className = 'hovercard-row-meta';
  at.textContent = evAge(e.ts);
  Tooltip.set(at, evTime(e.ts));
  li.append(icon, txt, at);
  return li;
}

// A request drops its origin unless it LEFT the recorded site (there the host IS
// the news); a console row drops the `console.` prefix, but `uncaught` (#163) stays.
function evCardRowText(e) {
  if (e.kind === 'network') return `${evNetStatus(e)} ${e.method} ${evShortUrl(e.url)}`;
  const kind = e.kind === 'exception' ? 'uncaught · ' : '';
  return `${kind}${evOneLine(e.text, 200)}`;
}

// A relative string from the page hook comes back as it came — and so does a host-less scheme
// (data:, blob:, file:): what `new URL` calls the path there is the payload, not an address.
function evShortUrl(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    if (!u.host) return evOneLine(url, 200);
    const here = evUi.tabUrl ? new URL(evUi.tabUrl).host : '';
    const path = `${u.pathname}${u.search}`;
    return evOneLine(u.host !== here ? `${u.host}${path}` : path || '/', 200);
  } catch { return evOneLine(url, 200); }
}

// Age, not clock time — inside a trailing window the age IS the fact (how close a
// row is to ageing out). The exact clock stays one hover away.
function evAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

// Lands on the rows themselves, expanded — not merely on the screen holding them. The fold
// lives in the Status tab, which a test does NOT open on, so the tab is switched FIRST: the
// unfold alone would have happened behind a hidden pane, and the click would read as dead.
// An empty log opens all the same — "nothing captured yet" is the answer the tester came for.
function revealEvidenceSection() {
  if (state.view !== 'test') return;
  showTestSection('status');
  if (!evUi.sectionOpen) toggleEvidenceHead();
  else renderEvidenceList(); // already open: repaint, the pane may have been hidden since
  const sec = $('evidence-section');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// The whole start half of a Rec click, shared with the auto-start: the tab the session binds
// to, the body-capture flag the in-page hook reads (#175), then the toggle itself. It only
// REPORTS — a manual start and an automatic one narrate the same outcomes differently.
// `unrecordable` carries the copy for a page Chrome keeps extensions off; `stillWanted` is
// re-asked after every await, for the caller whose test may be gone by then.
async function evStartRecording(stillWanted = null) {
  // Anything but `ok` is a page Chrome keeps extensions off — no grant to wait
  // for. `activate`: the recorder binds ONE tab, so the toast names the right one.
  const site = await resolveSiteTab({ verb: 'recorded', activate: true });
  if (site.state !== 'ok') return { ok: false, unrecordable: site.error };
  if (stillWanted && !stillWanted()) return { ok: false };
  await mirrorCaptureBodiesForRelay(); // before the hook can ask (#175)
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
      // Defensive: the chip does not exist off the test view, and a session with no testrun
      // to belong to would be the very thing this scoping removes.
      if (state.view !== 'test' || state.currentRecordId == null) { toast('Open a test to record its console & network log'); return; }
      r = await evStartRecording();
      // `r` is undefined when the worker answered nothing at all — that case belongs to the
      // `!r` guard below, which has the sentence for it; reading a field here threw instead.
      if (r && r.unrecordable) { toast(r.unrecordable, { error: true }); return; }
    }
    // Both are refusals: in the confirmation style they read as "done" in the very place
    // `Recording stopped` appears, and a reader's screen reader would wait instead of interrupt.
    if (!r || !r.ok) { toast(`Recorder: ${(r && r.error) || 'unavailable'}`, { error: true }); await refreshEvidenceStatus(); return; }
    applyEvidenceStatus(r.status);
    // #123: in-page instrumentation, so Chrome shows no "…is debugging this
    // browser" bar and DevTools may stay open.
    toast(r.status.recording ? `Recording ${r.status.tabTitle || 'tab'}` : 'Recording stopped');
  } catch (e) {
    toast(`Recorder error: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- test-view "Evidence" section ----------------------------------------

// Absent -> 60, clamp 10-600 — mirrors recorder.js evClampWindow.
function evWindowSeconds() {
  const raw = state.settings && state.settings.evidenceWindowSec;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(10, Math.round(n)));
}

function updateEvidenceSection() {
  const sec = $('evidence-section');
  if (!sec) return;
  // The fold belongs to the TEST view, not to the recording: idle it is the one place that
  // answers "where do the logs come from?" — a section that only exists once you already
  // found Rec teaches nobody. Only leaving the test takes it away.
  const onTest = state.view === 'test';
  sec.hidden = !onTest;
  // The expanded-row keys retire with the list — a later recording must not
  // reopen rows the tester opened in a previous one (#150).
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
  // The poll belongs to the RECORDING, not to this fold — the rows only have to
  // be painted from what it last brought back.
  if (evUi.sectionOpen) { renderEvidenceList(); pollEvidenceErrors(); }
}

// One 2 s poll for as long as the recording lasts: a single EVIDENCE_LIST round
// trip feeds the chip count, the hover card and the fold.
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

// The idle body: how to GET a log, in one line. It names Rec because the chip is right
// there in the header on this view (renderEvidenceToggle) — and says what the recorder
// keeps, since arming it after the bug is arming it too late.
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
  // Idle carries NO figure: a "0" beside the name would read as "recorded, and the page
  // was clean", which is the opposite of "nothing has been recorded".
  if (count) {
    count.hidden = !evUi.recording;
    if (evUi.recording) paintCounter(count, entries.length);
    else count.textContent = '';
  }
  if (!evUi.sectionOpen) return; // folded away: nothing to paint until it opens
  ul.replaceChildren();
  if (!evUi.recording) { ul.append(evIdleHint()); return; }
  if (!entries.length) {
    // A TICK, not a shrug — an empty errors-only log means the page behaved.
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
  const mark = evIcon(e);
  icon.dataset.kind = mark.kind;
  icon.append(svgIcon(mark.name, 14));
  const txt = document.createElement('span');
  txt.className = 'ev-text';
  txt.textContent = evRowText(e);
  Tooltip.set(txt, evRowText(e));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn size-xs ev-attach';
  btn.textContent = 'Attach';
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); attachEvidenceEntry(e); });
  head.append(icon, txt, btn);

  // The open/closed verdict comes from evUi.expanded, not from the DOM, so the
  // next poll tick rebuilds the row in the state the tester left it in (#150).
  const key = evKey(e);
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
    field('Status', evNetStatus(e));
    field('MIME', e.mimeType);
    field('Type', e.resourceType);
    if (e.errorText) field('Error', e.errorText);
    field('Timing', e.durationMs != null ? `${e.durationMs} ms` : null);
    field('At', evTime(e.ts));
    box.append(dl);
    if (e.bodySnippet || e.bodySkipped) {
      const pre = document.createElement('pre');
      pre.className = e.bodySnippet ? 'code ev-body' : 'code ev-body ev-body-note';
      pre.textContent = e.bodySnippet ? e.bodySnippet + (e.bodyTruncated ? '\n… (truncated)' : '') : EV_BODY_DISABLED;
      box.append(pre);
    }
  } else {
    field('Level', evLabel(e));
    field('At', evTime(e.ts));
    field('Location', evLoc(e));
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
  const snippet = evEntrySnippet(e);
  ta.value = ta.value ? `${ta.value}\n${snippet}` : snippet;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  toast('Log snippet added to the comment');
}

// ---- auto-attach on FAIL -------------------------------------------------

// Absent -> ON, explicit `false` -> OFF. OFF only skips the FAIL upload —
// recording and the manual per-entry Attach are unaffected.
function evidenceAutoAttachEnabled(settings) {
  return !(settings && settings.evidenceAutoAttach === false);
}

// #95, same absent -> ON rule. Since #123 the decision happens IN the page —
// page-hook.js is the only side that can read a body (fed by relay.js).
function evidenceCaptureBodiesEnabled(settings) {
  return !(settings && settings.evidenceCaptureBodies === false);
}

// The relay reads a top-level `evidenceCaptureBodies` key, never `settings` —
// that holds the token, which must not reach the tested page (#175).
async function mirrorCaptureBodiesForRelay() {
  if (!hasChrome || !chrome.storage) return;
  const value = evidenceCaptureBodiesEnabled(state.settings);
  try { await chrome.storage.local.set({ evidenceCaptureBodies: value }); } catch { /* absent -> ON, same rule */ }
}

// Uploads the window as .txt and returns its URL for the `Console & network log`
// META key (#116); '' writes no key. Runs AFTER the status save, so record.id exists.
async function uploadEvidenceLog(record) {
  if (!record || !record.id) return '';
  if (!evidenceAutoAttachEnabled(state.settings)) return '';
  const st = await evSend({ type: 'EVIDENCE_STATUS' });
  if (!st || !st.ok || !st.status.recording) return '';
  const snap = await evSend({ type: 'EVIDENCE_SNAPSHOT' });
  if (!snap || !snap.ok) return '';
  const entries = snap.entries || [];
  const testTitle = record.test_title || ($('test-title') && $('test-title').textContent) || '';
  const txt = evBuildTxt(state.runTitle, testTitle, entries, snap.status || {});
  try {
    const blob = new Blob([txt], { type: 'text/plain' });
    const res = await TestomatAPI.uploadAttachment(record.id, blob, `evidence-${record.id}-${Date.now()}.txt`);
    const url = res && res.url;
    if (!url) throw new Error('upload returned no url');
    return url;
  } catch (e) {
    // Non-fatal: the status write already succeeded — only the log couldn't attach.
    toast(`Test marked failed — the console & network log couldn't attach (${e.message})`, { error: true });
    return '';
  }
}

// ---- auto-start on entering a testrun ------------------------------------

// Absent -> OFF, explicit `true` -> ON — deliberately the inverse of the other evidence
// toggles' default: a recorder nobody switched on is the surprising direction.
function evidenceAutoStartEnabled(settings) {
  return !!(settings && settings.evidenceAutoStart === true);
}

// Two test-view entries can overlap (Back and straight forward again inside one round trip);
// only the newest may still start, or the second toggle would STOP the first one's session.
let evAutoStartSeq = 0;

// The setting's whole job: entering a testrun arms the recorder exactly as a Rec click would,
// so "Next test →" chains — the old test's session ends on the way out, the new test's begins.
// ONE attempt per entry, whatever it ends in: a manual stop on the test now open has to stand,
// because starting is tied to ENTERING the testrun and not to the stopped state.
async function evAutoStartOnTestView() {
  if (!evidenceAutoStartEnabled(state.settings)) return;
  // Never over a live session, whatever it is bound to, and never without a testrun to bind to.
  if (evUi.recording || state.view !== 'test' || state.currentRecordId == null) return;
  const recordId = state.currentRecordId;
  const seq = ++evAutoStartSeq;
  const stillWanted = () => seq === evAutoStartSeq && state.view === 'test'
    && String(state.currentRecordId) === String(recordId);
  const r = await evStartRecording(stillWanted);
  // SILENT in both outcomes: no toast on a start the pulsing chip and the tab title already
  // announce (one on every test opened would be noise), and none on a page Chrome keeps
  // extensions off — the test view's own "Recording is off — start it…" hint says it there.
  // Applied even if the tester left between the send and this answer: the session exists now,
  // and it is evLeftBoundTestrun (next poll tick) that ends it.
  if (r && r.ok) applyEvidenceStatus(r.status);
}

// ---- wiring --------------------------------------------------------------

// A recording ends without the tester's click when what it belongs to goes away: the
// recorded tab, the testrun it started in, or the panel holding that screen. Leaving the
// testrun falls through to the bare message — naming that cause would mean the test title.
function evStoppedMessage(reason) {
  if (reason === 'target_closed') return 'Recording stopped — the recorded tab was closed';
  if (reason === 'panel-closed') return 'Recording stopped — the panel was closed';
  return 'Recording stopped';
}

// The whole rule of the scoping: a live session whose testrun is not the screen on show.
// Never mid-boot — that restore passes through the run view on its way back to the test,
// and a recording the worker kept across a panel reload must survive the trip.
function evLeftBoundTestrun() {
  if (!evUi.recording || state.booting) return false;
  return state.view !== 'test' || String(state.currentRecordId) !== String(evUi.recordId);
}

// Quiet, no dialog: applied here so the screen being left cannot hold a live chip for a
// round trip, and the toast comes from the worker's one EVIDENCE_STOPPED broadcast.
async function evStopLeftTestrun() {
  applyEvidenceStatus({ recording: false });
  await evSend({ type: 'EVIDENCE_STOP', reason: 'left-testrun' });
}

// Called by show() on every view change (guarded there) — the one place a recording is
// checked against the screen it belongs to. The caller does not await it.
async function onViewShown(view) {
  if (evLeftBoundTestrun()) await evStopLeftTestrun();
  renderEvidenceToggle();
  updateEvidenceSection();
  if (view !== 'test') return;
  // AWAITED, unlike before: the auto-start has to know what the worker is doing first — after
  // a panel reload it may already be recording this very testrun, and then there is nothing
  // to start.
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
        // In the chain the dot keeps pulsing (the next test's session starts at once), so a
        // "stopped" toast would contradict the screen; it also stays quiet if that start then
        // fails — the test view's own hint says recording is off.
        const chained = msg.reason === 'left-testrun' && evidenceAutoStartEnabled(state.settings)
          && state.view === 'test' && state.currentRecordId != null;
        if (!chained) toast(evStoppedMessage(msg.reason));
      }
    });
  }
  refreshEvidenceStatus();
}
