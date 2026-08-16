// Evidence panel UI (M2 PR-1): the run-header Record toggle, the test-view
// "Evidence" errors-only section, per-entry Attach snippets, and the auto-attach
// on FAIL. All server-less except the .txt upload on failure. The recorder in
// the background SW is the source of truth; this reflects its EVIDENCE_* status.

/* global TestomatAPI, chrome, state, hasChrome, $, toast, resolveSiteTab, Tooltip,
   HoverCard, EmptyState, paintCounter, svgIcon, openAttachmentsDisclosure */

// Panel-local reflection of the recorder status + section/poll state. The window
// is NOT mirrored here — evWindowSeconds() reads it from state.settings, which is
// the value the tester just edited (the recorder's copy lags a settings save).
// `expanded` holds the keys of the rows the tester opened: the list is rebuilt
// from scratch every 2 s poll tick, so DOM-only expansion folded back on its own
// (#150) — the state has to outlive the repaint, like the paste flash does.
// `errors` is the ONE copy of the errors-only window every surface now paints
// from — the count on the chip, the chip's hover card and the test view's list —
// so a tick asks the recorder once and the three can never disagree.
const evUi = {
  recording: false, tabId: null, tabTitle: '', tabUrl: '', sectionOpen: false, pollTimer: null,
  expanded: new Set(), errors: [], card: null,
};

// How many errors the chip's hover card lists before it stops and says how many
// more there are. Six is what fits under the header without the card becoming
// the screen; the rest are one click away in the section that holds them all.
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
  const was = evUi.recording;
  evUi.recording = !!(status && status.recording);
  evUi.tabId = status && status.tabId != null ? status.tabId : null;
  evUi.tabTitle = (status && status.tabTitle) || '';
  // The recorded tab's URL is kept for ONE job: shortening the request rows on the
  // hover card to their path, and keeping the host on the ones that left this site.
  evUi.tabUrl = (status && status.tabUrl) || '';
  // A recording that ended takes its errors with it: the count on the chip is a
  // live figure, and a stopped recorder must not leave one standing.
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
  // The Record toggle shows where recording can START (run/test); it ALSO stays
  // visible on EVERY view while a session is active, so the pulsing rec dot is a
  // global indicator and stop is one click away from anywhere (Block 4).
  btn.hidden = !inRun && !evUi.recording;
  // The slot follows the toggle so an absent chip costs the tabs row no width (#127).
  const slot = $('rec-slot');
  if (slot) slot.hidden = btn.hidden;
  btn.classList.toggle('recording', evUi.recording);
  btn.setAttribute('aria-pressed', evUi.recording ? 'true' : 'false');
  paintEvidenceCount();
  // No tooltip on this chip, in either state — the hover card IS its label. The
  // two answer the same question and the card answers it better (what is being
  // recorded, what it caught, the way into it), so a `data-tip` here would only
  // open a black box over the card the pointer came for.
  bindEvidenceCard(btn);
  if (evUi.card) evUi.card.update();
}

// Errors caught in the recorder's window, on the chip itself. Hidden at zero,
// which is also how the chip says a recording is going WELL: a number appearing
// is the whole message, and it lands with the same fade every other count in the
// panel does (paintCounter, core/views.js).
//
// The figure counts the same rows the «Console & network log» section lists — the
// errors-only view of the trailing window — so it FALLS as old errors age out of
// it. That is the recorder's contract, not a bug in the count: what the chip
// offers is what a FAIL would attach right now.
function paintEvidenceCount() {
  const chip = $('evidence-errors');
  const btn = $('evidence-toggle');
  const n = evUi.recording ? evUi.errors.length : 0;
  if (chip) {
    chip.hidden = !n;
    if (n) paintCounter(chip, n);
    else chip.textContent = '';
  }
  // The chip has no tooltip any more (its label is the hover card, which a reader
  // cannot hover for), so the button's own NAME carries the whole state: what it
  // does when idle, and what it is recording — with the count in words, since the
  // chip beside the word is `aria-hidden`.
  if (!btn) return;
  if (!evUi.recording) {
    btn.setAttribute('aria-label', 'Rec — record the console & network log from the tab under test');
    return;
  }
  const errors = n ? `, ${n} error${n === 1 ? '' : 's'} caught` : '';
  btn.setAttribute('aria-label', `Rec — recording ${evUi.tabTitle || 'tab'}${errors}, click to stop`);
}

// ---- the chip's hover card (the errors, without leaving the view) ---------

// Attached once, to the button that outlives every repaint (it only ever MOVES,
// between the two header rows — see homeRecSlot in core/views.js). It is the
// chip's ONLY label, so it answers in both states: what a recording has caught,
// or — idle — what the button would do and why the order matters.
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

// Idle: the sentence the tooltip used to carry, plus the one thing that sentence
// never had room for — the recorder keeps a TRAILING window, so arming it after
// the bug is arming it too late.
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

  // What is being recorded — the name the chip used to print beside itself, in
  // the one place that has room for a whole page title.
  const head = document.createElement('div');
  head.className = 'hovercard-head';
  const title = document.createElement('span');
  title.className = 'hovercard-title';
  title.textContent = evUi.tabTitle || 'Recording';
  head.append(title);

  // ONE short line of facts under it, and it leads with the news: how many, then
  // over what window. Not a sentence — a card this narrow turns "Recording ·
  // console & network errors of the last 60s" into two lines of preamble above
  // the errors themselves, and every word of it except the two numbers is
  // already known (the chip is pulsing, the section is named).
  const errors = evUi.errors;
  const n = errors.length;
  const meta = document.createElement('p');
  meta.className = 'hovercard-meta';
  meta.textContent = `${n ? `${n} error${n === 1 ? '' : 's'}` : 'No errors yet'} · last ${evWindowSeconds()}s`;
  box.append(head, meta);

  // Nothing caught is the whole message when there is nothing caught: the line
  // above already said it, so the card stops there rather than spending the
  // section's own bordered empty state on saying it a second time.
  if (!n) {
    box.append(evCardFoot());
    return box;
  }

  // NEWEST first, unlike the section's list: the card is a glance at what just
  // happened, and the errors that just happened are the reason the pointer
  // stopped on the chip. Six of them, then a line saying how many older ones the
  // section still holds — the card is a summary, and a card that grew with the
  // count would end up being the screen.
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

// The way into all of them, and — since the chip carries no tooltip any more —
// the line that says the chip is a toggle. The link is only on the test view:
// the list lives inside that screen's «Attachments & log», and a link that cannot
// land anywhere is worse than the sentence saying where to go.
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

// One error, as the card shows it: the section's own mark, the message, and the
// time in a column of its own. The section prints all three as one line —
// «500 GET /api/… · 14:22:06» — because its row is one line with an Attach button
// on the end; here the message gets two lines of its own and the clock stops
// being read as the tail of a URL.
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

// The message, stripped of the two things the CARD does not have room to repeat.
//
// A request loses its origin: `https://app.testomat.io/` is 24 characters of the
// tab named two lines above, and on a 300px card in mono it took the whole first
// line — so every row read "500 GET https://app.testomat.io/…" and the path, the
// half that says WHICH request failed, was the part that got cut. A request that
// left the recorded site keeps its host, because there the host IS the news.
//
// A console row loses the `console.` prefix: the mark beside it already splits
// error from warning, and the word cost the message a line. `uncaught` survives —
// no console call made that row (#163), and nothing else on the card says so.
function evCardRowText(e) {
  if (e.kind === 'network') return `${evNetStatus(e)} ${e.method} ${evShortUrl(e.url)}`;
  const kind = e.kind === 'exception' ? 'uncaught · ' : '';
  return `${kind}${evOneLine(e.text, 200)}`;
}

// Path (with its query) for a request to the recorded site, `host/path` for one
// that left it. Anything unparseable — a `data:` URL, a relative string from the
// page hook — is returned as it came.
function evShortUrl(raw) {
  const url = String(raw || '');
  try {
    const u = new URL(url);
    const here = evUi.tabUrl ? new URL(evUi.tabUrl).host : '';
    const path = `${u.pathname}${u.search}`;
    return evOneLine(u.host && u.host !== here ? `${u.host}${path}` : path || '/', 200);
  } catch { return evOneLine(url, 200); }
}

// How long ago, not when: inside a trailing window the age IS the fact ("this one
// is 3 s old, that one is about to age out"), and `17:22:07` in mono spent a third
// of the card's width on a figure whose first four characters never change. The
// exact clock stays one hover away, and the section prints it in full.
function evAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

// The card's way on: open «Attachments & log», open the log inside it, and put it
// on screen. Everything the card shows is a summary of this section — so the link
// lands on the rows themselves, expanded, rather than on the screen holding them.
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
      // ONE verdict for the tab under test (no hand-rolled url regex any more):
      // anything but `ok` is a page Chrome keeps extensions off, and the toast says
      // so — there is no grant left to wait for.
      // `activate`: the recorder binds to ONE tab, so a bound target that stood in
      // for a page we cannot touch is brought forward — the toast then names the tab
      // the tester is actually looking at.
      const site = await resolveSiteTab({ verb: 'recorded', activate: true });
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
  if (!show) { evUi.expanded.clear(); return; }
  renderEvidenceList();
}

function toggleEvidenceHead() {
  evUi.sectionOpen = !evUi.sectionOpen;
  const head = $('evidence-head');
  const list = $('evidence-list');
  if (head) head.setAttribute('aria-expanded', evUi.sectionOpen ? 'true' : 'false');
  if (list) list.hidden = !evUi.sectionOpen;
  // The poll is already running (it belongs to the RECORDING now, not to this
  // fold) — the rows only have to be painted from what it last brought back.
  if (evUi.sectionOpen) { renderEvidenceList(); pollEvidenceErrors(); }
}

// One poll, for as long as the recording lasts — on every view, not only on the
// test the list belongs to. It used to run while the «Console & network log» fold
// was open, because that fold was the only thing reading it; the chip's own count
// and its hover card are the other two now, and both are up wherever the tester
// is. Same 2 s tick, same single EVIDENCE_LIST round trip feeding all three.
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

// Paints the fold's rows from `evUi.errors` — the poll's copy, not a fetch of its
// own: three surfaces read the same window, and two of them are outside this view.
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
