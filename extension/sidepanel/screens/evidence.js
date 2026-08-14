// Evidence panel UI (M2 PR-1): the run-header Record toggle, the test-view
// "Evidence" errors-only section, per-entry Attach snippets, and the auto-attach
// on FAIL. All server-less except the .txt upload on failure. The recorder in
// the background SW is the source of truth; this reflects its EVIDENCE_* status.

/* global TestomatAPI, chrome, state, hasChrome, $, toast, resolveSiteTab, Tooltip, EmptyState */

// Panel-local reflection of the recorder status + section/poll state. The window
// is NOT mirrored here — evWindowSeconds() reads it from state.settings, which is
// the value the tester just edited (the recorder's copy lags a settings save).
// `expanded` holds the keys of the rows the tester opened: the list is rebuilt
// from scratch every 2 s poll tick, so DOM-only expansion folded back on its own
// (#150) — the state has to outlive the repaint, like the paste flash does.
const evUi = { recording: false, tabId: null, tabTitle: '', sectionOpen: false, pollTimer: null, expanded: new Set() };

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

function evTruncate(s, n) { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function evNetStatus(e) { return e.errorText ? (e.status || 'ERR') : (e.status != null ? e.status : '—'); }

// The label of a text row: a patched console call, a row the browser produced
// (`log`), or an uncaught exception / unhandled rejection (`uncaught`, #163) —
// which no console call ever made, so it must not read as one.
function evLabel(e) {
  if (e.kind === 'exception') return `uncaught.${e.level}`;
  return e.kind === 'log' ? `log.${e.level}` : `console.${e.level}`;
}

// source:line:col — the col only an uncaught row carries.
function evLoc(e) {
  if (!e.url) return '';
  return `${e.url}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ''}` : ''}`;
}

// Stands in for the snippet of a failed request the recorder deliberately did not
// read (#95 toggle OFF, entry.bodySkipped) — in the details pane and the .txt log.
const EV_BODY_DISABLED = '(body capture disabled)';

// Wrap a body snippet in a fenced code block, choosing a fence longer than any
// backtick run inside it so the body can never break out of the fence.
function evFence(body) {
  const runs = String(body).match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1));
  return `${fence}\n${body}\n${fence}`;
}

// Same rule for the one-line row (#175): the message, the url and the errorText
// are written by the PAGE, so a backtick in them would close the inline span and
// hand the rest of the row to the comment's markdown renderer as live markup. A
// newline would end the blockquote line just as effectively, hence the collapse.
function evInlineCode(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const runs = s.match(/`+/g) || [];
  const ticks = '`'.repeat(runs.reduce((m, r) => Math.max(m, r.length), 0) + 1);
  const pad = /^`|`$/.test(s) ? ' ' : ''; // CommonMark strips one space from each end
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

// Inline markdown snippet appended to the comment on Attach (design §2). For a
// failed network entry with a captured body (M2 PR-3), the snippet also carries
// the body as a fenced code block.
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

// One-line row text for the errors-only list.
function evRowText(e) {
  const t = evTime(e.ts);
  if (e.kind === 'network') return `${evNetStatus(e)} ${e.method} ${evOneLine(e.url, 120)} · ${t}`;
  return `${evLabel(e)} · ${evOneLine(e.text, 120)} · ${t}`;
}

// Stable identity of an entry across re-renders (#150). `ts` is stamped once at
// capture and never rewritten (an adopted page/webRequest twin keeps the ts of
// the row it merges into), so it anchors the key; the requestId separates two
// hops of one redirect chain, and the page hook's own rows — which carry no
// requestId — fall back to method+url.
function evKey(e) {
  if (e.kind === 'network') return `network:${e.ts}:${e.requestId || `${e.method} ${e.url}`}`;
  return `${e.kind}:${e.ts}:${e.text || ''}`;
}

// Row marker, from the panel's one icon set: a failed request is blocked, a live
// one is the globe, and console entries split warning vs error. Returns the icon
// AND the severity that colours it — the emoji carried its own colour, an icon
// does not, and the two must never disagree.
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
    // M2 PR-3: the captured response body of a failed request, indented under it.
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
  evUi.recording = !!(status && status.recording);
  evUi.tabId = status && status.tabId != null ? status.tabId : null;
  evUi.tabTitle = (status && status.tabTitle) || '';
  renderEvidenceToggle();
  updateEvidenceSection();
}

async function refreshEvidenceStatus() {
  const r = await evSend({ type: 'EVIDENCE_STATUS' });
  applyEvidenceStatus(r && r.ok ? r.status : { recording: false });
}

// ---- run-header toggle ---------------------------------------------------

function renderEvidenceToggle() {
  const btn = $('evidence-toggle');
  const label = $('evidence-tab');
  if (!btn || !label) return;
  const inRun = state.view === 'run' || state.view === 'test';
  // The Record toggle shows where recording can START (run/test); it ALSO stays
  // visible on EVERY view while a session is active, so the pulsing rec dot is a
  // global indicator and stop is one click away from anywhere (Block 4).
  btn.hidden = !inRun && !evUi.recording;
  label.hidden = !evUi.recording;
  // The slot follows the toggle so an absent chip costs the tabs row no width (#127).
  const slot = $('rec-slot');
  if (slot) slot.hidden = btn.hidden;
  btn.classList.toggle('recording', evUi.recording);
  btn.setAttribute('aria-pressed', evUi.recording ? 'true' : 'false');
  Tooltip.set(btn, evUi.recording
    ? `Recording ${evUi.tabTitle || 'tab'} — click to stop`
    : 'Record the console & network log from the active tab');
  if (evUi.recording && evUi.tabTitle) { label.textContent = evTruncate(evUi.tabTitle, 22); Tooltip.set(label, evUi.tabTitle); }
  else label.textContent = '';
}

async function onEvidenceToggle() {
  const btn = $('evidence-toggle');
  if (btn) btn.disabled = true;
  try {
    let tabId = null;
    if (!evUi.recording) {
      // ONE verdict for the tab under test (no hand-rolled url regex any more):
      // anything but `ok` is a page Chrome keeps extensions off, and the toast says
      // so — there is no grant left to wait for.
      const site = await resolveSiteTab({ verb: 'recorded' });
      if (site.state !== 'ok') { toast(site.error); return; }
      tabId = site.tab.id;
      await mirrorCaptureBodiesForRelay(); // before the hook can ask (#175)
    }
    const r = await evSend({ type: 'EVIDENCE_TOGGLE', tabId });
    if (!r || !r.ok) { toast(`Recorder: ${(r && r.error) || 'unavailable'}`); await refreshEvidenceStatus(); return; }
    applyEvidenceStatus(r.status);
    // #123: no infobar note any more — recording is in-page instrumentation, so
    // Chrome shows no "…is debugging this browser" bar and DevTools may stay open.
    toast(r.status.recording ? `Recording ${r.status.tabTitle || 'tab'}` : 'Recording stopped');
  } catch (e) {
    toast(`Recorder error: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- test-view "Evidence" section ----------------------------------------

// Configured recorder window in seconds (settings.evidenceWindowSec; absent ->
// 60, clamp 10-600 — mirrors recorder.js evClampWindow).
function evWindowSeconds() {
  const raw = state.settings && state.settings.evidenceWindowSec;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(10, Math.round(n)));
}

// Pre-arm cue (Block 5): while NOT recording, nudge the tester to arm the
// recorder BEFORE reproducing (it only keeps the trailing window). Lives at the
// top of the Attachments & log disclosure; the live errors list takes its place
// once recording starts.
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
  // Leaving the test view or the recording ending retires the whole list, so the
  // expanded-row keys retire with it — a later recording never reopens rows the
  // tester opened in a previous one (#150).
  if (!show) { evUi.expanded.clear(); stopEvidencePolling(); return; }
  if (evUi.sectionOpen) startEvidencePolling(); else { stopEvidencePolling(); renderEvidenceList(); }
}

function toggleEvidenceHead() {
  evUi.sectionOpen = !evUi.sectionOpen;
  const head = $('evidence-head');
  const list = $('evidence-list');
  if (head) head.setAttribute('aria-expanded', evUi.sectionOpen ? 'true' : 'false');
  if (list) list.hidden = !evUi.sectionOpen;
  if (evUi.sectionOpen) startEvidencePolling(); else stopEvidencePolling();
}

function startEvidencePolling() {
  renderEvidenceList();
  if (evUi.pollTimer) return;
  evUi.pollTimer = setInterval(renderEvidenceList, 2000); // design: poll while open + recording
}

function stopEvidencePolling() {
  if (evUi.pollTimer) { clearInterval(evUi.pollTimer); evUi.pollTimer = null; }
}

async function renderEvidenceList() {
  if (!evUi.recording || state.view !== 'test') { stopEvidencePolling(); return; }
  const r = await evSend({ type: 'EVIDENCE_LIST', errorsOnly: true });
  const ul = $('evidence-list');
  const count = $('evidence-count');
  if (!ul) return;
  if (!r || !r.ok) { ul.replaceChildren(); return; }
  if (r.status && !r.status.recording) { applyEvidenceStatus(r.status); return; } // recorder stopped underneath us
  const entries = r.entries || [];
  if (count) count.textContent = String(entries.length);
  ul.replaceChildren();
  if (!entries.length) {
    // Compact, and a TICK rather than a shrug: an errors-only log with nothing
    // in it is the recorder working and the page behaving, not a screen that
    // failed to load.
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

  // Clicking the row (but not Attach) toggles the expandable details (M2 PR-3).
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

// Expandable details (M2 PR-3): network fields + body snippet for a request, or
// the full message + location for a console/log entry. Built once, hidden until
// the row is clicked; the body renders in a scrollable <pre>.
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

// Append the entry's markdown snippet to the comment (the tester can edit it).
function attachEvidenceEntry(e) {
  const ta = $('test-comment');
  if (!ta) return;
  const snippet = evEntrySnippet(e);
  ta.value = ta.value ? `${ta.value}\n${snippet}` : snippet;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  toast('Log snippet added to the comment');
}

// ---- auto-attach on FAIL -------------------------------------------------

// Auto-attach toggle: absent/undefined -> ON (mirrors envInfoOnFail's A2 rule);
// explicit `false` -> OFF. OFF only skips the FAIL upload/link — recording and
// the manual per-entry Attach are unaffected.
function evidenceAutoAttachEnabled(settings) {
  return !(settings && settings.evidenceAutoAttach === false);
}

// Response-body capture toggle (#95): same absent -> ON rule. Read by the Settings
// form; since #123 the decision happens IN the page (evidence/page-hook.js is the
// only side that can read a body), fed the same flag by evidence/relay.js.
function evidenceCaptureBodiesEnabled(settings) {
  return !(settings && settings.evidenceCaptureBodies === false);
}

// The relay reads a top-level `evidenceCaptureBodies` key rather than `settings`,
// which holds the token it must not pull into the tested page (#175). Written from
// the ACTIVE instance's settings right before a recording starts — the one moment
// the value matters — so it also migrates a config saved before the key existed.
async function mirrorCaptureBodiesForRelay() {
  if (!hasChrome || !chrome.storage) return;
  const value = evidenceCaptureBodiesEnabled(state.settings);
  try { await chrome.storage.local.set({ evidenceCaptureBodies: value }); } catch { /* absent -> ON, same rule */ }
}

// Uploads the recorded window as a .txt attachment and hands the URL back for the
// `Console & network log` META key (#116 — it used to be appended to the comment
// instead). Toggle off / recording off / not-a-real-record / upload failure /
// degraded mode → '' , i.e. no key is written and nothing else about the status
// write changes.
//
// Since #116 this runs AFTER the status is saved rather than while the message is
// being built. That is what makes the `!record.id` guard survivable: a row that
// had no result yet only earns its testrun id in the status response, so the
// caller now passes a record that HAS one — the old ordering had to skip those
// tests entirely.
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

// Map a recorder stop reason to a human phrase (Block 4). Since #123 there is
// only one way a recording ends without the tester: the recorded tab is gone.
// (DevTools taking the tab used to be the other one — it cannot happen now.)
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
