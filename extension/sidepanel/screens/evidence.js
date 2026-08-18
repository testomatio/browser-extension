// Evidence panel UI: Record toggle, errors-only section, per-entry Attach and the
// auto-attach on FAIL. The background recorder is the source of truth.

/* global TestomatAPI, chrome, state, hasChrome, $, toast, resolveSiteTab, Tooltip,
   HoverCard, EmptyState, paintCounter, svgIcon, openAttachmentsDisclosure */

// The window is NOT mirrored here — evWindowSeconds() reads state.settings, which
// leads the recorder's copy. `expanded` must outlive the 2 s poll repaint (#150).
const evUi = {
  recording: false, tabId: null, tabTitle: '', tabUrl: '', sectionOpen: false, pollTimer: null,
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

// Readable .txt artifact (header + Console + Network sections) for auto-attach.
function evBuildTxt(runTitle, testTitle, entries, status) {
  const lines = [];
  lines.push(`Console & network log — ${runTitle || 'Run'} / ${testTitle || 'Test'}`);
  lines.push(`Recorded tab: ${status.tabTitle || '—'}`);
  if (status.tabUrl) lines.push(`URL: ${status.tabUrl}`);
  lines.push(`Window: last ${status.windowSec}s · ${entries.length} entries · ${new Date().toISOString()}`);
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
    lines.push(`[${evTime(e.ts)}] ${evNetStatus(e)} ${e.method} ${e.url}${rt}${err}`);
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
  const inRun = state.view === 'run' || state.view === 'test';
  // Visible where recording can START (run/test), and on EVERY view while a session
  // is active — the rec dot is a global indicator, stop is always one click away.
  btn.hidden = !inRun && !evUi.recording;
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
    open.textContent = 'Open in Attachments & log';
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

// Unparseable input — a `data:` URL, a relative string from the page hook —
// comes back as it came.
function evShortUrl(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    const here = evUi.tabUrl ? new URL(evUi.tabUrl).host : '';
    const path = `${u.pathname}${u.search}`;
    return evOneLine(u.host && u.host !== here ? `${u.host}${path}` : path || '/', 200);
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

// Lands on the rows themselves, expanded — not merely on the screen holding them.
function revealEvidenceSection() {
  if (state.view !== 'test') return;
  if (typeof openAttachmentsDisclosure === 'function') openAttachmentsDisclosure();
  if (!evUi.sectionOpen) toggleEvidenceHead();
  const sec = $('evidence-section');
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function onEvidenceToggle() {
  const btn = $('evidence-toggle');
  if (btn) btn.disabled = true;
  try {
    let tabId = null;
    if (!evUi.recording) {
      // Anything but `ok` is a page Chrome keeps extensions off — no grant to wait
      // for. `activate`: the recorder binds ONE tab, so the toast names the right one.
      const site = await resolveSiteTab({ verb: 'recorded', activate: true });
      if (site.state !== 'ok') { toast(site.error); return; }
      tabId = site.tab.id;
      await mirrorCaptureBodiesForRelay(); // before the hook can ask (#175)
    }
    const r = await evSend({ type: 'EVIDENCE_TOGGLE', tabId });
    if (!r || !r.ok) { toast(`Recorder: ${(r && r.error) || 'unavailable'}`); await refreshEvidenceStatus(); return; }
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

// Shown only while NOT recording — the live errors list takes its place once a
// recording starts.
function updatePrearmHint() {
  const el = $('prearm-hint');
  if (!el) return;
  const show = state.view === 'test' && !evUi.recording;
  el.hidden = !show;
  if (show) {
    el.textContent = `Recording is off — start it (Rec in the header) BEFORE reproducing: `
      + `it captures the last ${evWindowSeconds()}s.`;
  }
}

function updateEvidenceSection() {
  updatePrearmHint();
  const sec = $('evidence-section');
  if (!sec) return;
  const show = state.view === 'test' && evUi.recording;
  sec.hidden = !show;
  // The expanded-row keys retire with the list — a later recording must not
  // reopen rows the tester opened in a previous one (#150).
  if (!show) { evUi.expanded.clear(); return; }
  renderEvidenceList();
}

function toggleEvidenceHead() {
  evUi.sectionOpen = !evUi.sectionOpen;
  const head = $('evidence-head');
  const list = $('evidence-list');
  if (head) head.setAttribute('aria-expanded', evUi.sectionOpen ? 'true' : 'false');
  if (list) list.hidden = !evUi.sectionOpen;
  // The poll belongs to the RECORDING, not to this fold — the rows only have to
  // be painted from what it last brought back.
  if (evUi.sectionOpen) { renderEvidenceList(); pollEvidenceErrors(); }
}

// One 2 s poll for as long as the recording lasts, on EVERY view: a single
// EVIDENCE_LIST round trip feeds the chip count, the hover card and the fold.
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
  const r = await evSend({ type: 'EVIDENCE_LIST', errorsOnly: true });
  if (!r || !r.ok) return;
  if (r.status && !r.status.recording) { applyEvidenceStatus(r.status); return; } // recorder stopped underneath us
  evUi.errors = r.entries || [];
  paintEvidenceCount();
  renderEvidenceList();
  if (evUi.card) evUi.card.update(); // a card the pointer is resting in gains the new row
}

// Paints from `evUi.errors` (the poll's copy) — never fetches on its own.
function renderEvidenceList() {
  const ul = $('evidence-list');
  const count = $('evidence-count');
  if (!ul) return;
  if (!evUi.recording || state.view !== 'test') return;
  const entries = evUi.errors;
  if (count) count.textContent = String(entries.length);
  if (!evUi.sectionOpen) return; // folded away: nothing to paint until it opens
  ul.replaceChildren();
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
    toast(`Test marked failed — the console & network log couldn't attach (${e.message})`);
    return '';
  }
}

// ---- wiring --------------------------------------------------------------

// Since #123 a recording only ends without the tester when the recorded tab is gone.
function evStoppedMessage(reason) {
  if (reason === 'target_closed') return 'Recording stopped — the recorded tab was closed';
  return 'Recording stopped';
}

// Called by show() on every view change (guarded there).
function onViewShown(view) {
  renderEvidenceToggle();
  updateEvidenceSection();
  if (view === 'run' || view === 'test') refreshEvidenceStatus();
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
        toast(evStoppedMessage(msg.reason));
      }
    });
  }
  refreshEvidenceStatus();
}
