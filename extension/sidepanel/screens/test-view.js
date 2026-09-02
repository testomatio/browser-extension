// Test view: render steps (tri-state or local checkboxes), example substitution,
// status writes, the priority icon, and the substatus dropdown.

/* global TestomatAPI, TestomatParams, Md, PriorityIcons,
   renderPendingAnnotation, Skeleton, Sk, Tooltip, EmptyState, UserCell, Icons,
   ImgHydrate, progressToast, hideToast */

// Object-URL groups (shared/img-hydrate.js) — four, because each is repainted
// and released on its own occasion.
const IMG_GROUP_DESC = 'test-description';
const IMG_GROUP_SHOTS = 'summary-shots';
const IMG_GROUP_ATTS = 'result-attachments';
const IMG_GROUP_ARTIFACTS = 'summary-artifacts';

// ---------- test view ----------

async function openTestView(recordId) {
  if (capabilities.readonly) { show('test'); return; } // #155 — locked project
  const record = recordFor(recordId);
  if (!record) return;
  state.currentRecordId = record.id; // canonical id, even if called with a string
  state.testrunDetail = null;
  // Header holds the priority slot open until that read lands (views.js).
  state.testDetailPending = true;
  state.currentSteps = [];
  // v2 pre-substitutes the title server-side (verified live); only description/
  // steps arrive raw. Set BEFORE show() or the header paints the previous test.
  state.testTitle = record.test_title || `Test ${record.test_id}`;
  show('test');
  showTestSection('desc'); // every open starts on "what to do", never on the last test's section
  renderTestProgress();
  paintTestNav();
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
  $('test-title').textContent = state.testTitle;
  $('test-comment').value = record.message || '';
  $('test-steps').replaceChildren();
  ImgHydrate.release(IMG_GROUP_DESC); // #205 — the images that body was holding go with it
  // This line belongs to the WRITE (Saving…/queued/error); only a failed read speaks here.
  setStatusLine('test-status', '');
  setWriteState('');
  if ($('example-badge')) $('example-badge').hidden = true;
  if ($('test-substatus')) $('test-substatus').hidden = true;
  renderSubstatusMark(null); // never let the previous test's custom status linger
  if ($('test-assignee')) $('test-assignee').hidden = true;
  hideResultSummary(); // #117: never let the previous test's result flash here
  updateTestActionsState();
  renderAttachmentList(); // #107: never let the previous test's attachments linger
  renderPendingAnnotation(); // #192: a kept annotation is offered on its own record only
  srecOnTestOpen(); // #68: bind a page-started recording to this result, and take a parked file
  applyAttachmentsDisclosure();
  syncFullPageToggles();
  const sk = Skeleton.show('test');
  try {
    // Versioned steps from the testrun, and the session probe alongside it: two
    // independent reads, so the open costs one round trip rather than two. The gate has
    // to be settled BEFORE RENDERING — so steps render once in the right mode — which
    // this still is; the probe never throws, so it cannot fail the batch either.
    const [fetched] = await Promise.all([
      record.id ? TestomatAPI.getTestrun(record.id) : null,
      probeSession(record.id),
    ]);
    // Fall back to the current TC text. Serial, and rare: only a testrun that carried none.
    let source = fetched;
    if (!source?.description && record.test_id) source = await TestomatAPI.getTest(record.test_id);
    if (String(state.currentRecordId) !== String(record.id)) return; // moved on
    // Both JWT-only (cached); parallel to avoid a serial stall on two best-effort reads.
    if (capabilities.jwt) await Promise.all([loadProjectInfo(), loadProjectUsers()]);
    if (String(state.currentRecordId) !== String(record.id)) return;
    renderSteps(applyExample(source?.description || ''), record);
    renderResultSummary();
    renderPriority();
    renderSubstatus(record);
    renderSubstatusMark(record);
    renderAssignee(record);
    // #107: both need the settled session — prefetched attachments + the degraded gate.
    renderAttachmentList();
    updateTestActionsState();
  } catch (e) {
    if (String(state.currentRecordId) === String(record.id)) handleApiError(e, 'test-status');
  } finally {
    // A failed read must not leave the header pulsing at a slot that never fills —
    // and only for the test still open (a tester who paged on awaits their own read).
    if (String(state.currentRecordId) === String(record.id) && state.testDetailPending) {
      state.testDetailPending = false;
      refreshContextBar();
    }
    Skeleton.hide(sk);
  }
}

// ---- the three sections of the screen (Description / Status / Summary) ----
// Which one is open belongs to the VIEW, not the test: remembering it per test
// would open a fresh test on a section describing another one.
const TEST_SECTIONS = {
  desc: { tab: 'tab-test-desc', pane: 'pane-test-desc' },
  status: { tab: 'tab-test-status', pane: 'pane-test-status' },
  summary: { tab: 'tab-test-summary', pane: 'pane-test-summary' },
};

function showTestSection(name) {
  const chosen = TEST_SECTIONS[name] ? name : 'desc';
  for (const [key, ids] of Object.entries(TEST_SECTIONS)) {
    const on = key === chosen;
    const tab = $(ids.tab);
    const pane = $(ids.pane);
    if (tab) tab.setAttribute('aria-selected', on ? 'true' : 'false');
    if (pane) pane.hidden = !on;
  }
}

// WHICH lists are step lists is the renderer's answer (shared/markdown.js
// `stepLists`): the stylesheet numbers those same lists off the class it stamps.
function stepListItems(container) {
  return Md.stepLists(container)
    .flatMap((list) => [...list.querySelectorAll(':scope > li')]); // top-level only
}

// Both spellings occur: fixtures write "Expected:", humans "Expected Result:".
const EXPECTED_LABEL = /^\s*expected(\s+results?)?\s*:/i;

// Read RENDERED text through here, never `textContent`: a soft line break is a
// <br> with no text, so textContent glues "the page"+"and wait" into one word.
function textIn(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// Pull nested `Expected:` sub-bullets out of a step <li>; they are removed from
// the DOM, so `pos` is snapshotted before removal (the web still counts them).
function extractExpected(li) {
  const expected = [];
  li.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach((sub) => {
    if (EXPECTED_LABEL.test(sub.textContent)) {
      expected.push(textIn(sub));
      const list = sub.parentElement;
      sub.remove();
      if (list && !list.querySelector(':scope > li')) list.remove();
    }
  });
  return expected.join('\n');
}

// The same label bolded mid-sentence instead of its own <li>: "Do X. **Expected Result**: Y."
const INLINE_EXPECTED_LABEL = /^expected(\s+results?)?$/i;

function extractInlineExpected(li) {
  const nodes = [...li.childNodes];
  const idx = nodes.findIndex((n) => (
    n.nodeType === 1 && /^(strong|b)$/i.test(n.tagName) && INLINE_EXPECTED_LABEL.test(n.textContent.trim())
  ));
  if (idx < 0) return '';
  // Detached holder: lifts the tail out of the <li> and gives textIn() one node.
  const holder = document.createElement('div');
  holder.append(...nodes.slice(idx));
  return textIn(holder);
}

// Own inline text, nested lists excluded — used verbatim as the server step `title`.
function stepTitle(li) {
  const clone = li.cloneNode(true);
  clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
  return textIn(clone);
}

// The body div owns `min-width: 0` so a long title wraps; showdown's disabled
// `- [ ]` box is removed — the control is the mark.
function wrapRow(li, expected) {
  li.querySelectorAll(':scope > input[type="checkbox"]').forEach((n) => n.remove());
  const body = document.createElement('div');
  body.className = 'step-main';
  const text = document.createElement('div');
  text.className = 'step-title';
  while (li.firstChild) text.append(li.firstChild);
  body.append(text);
  if (expected) {
    const ex = document.createElement('div');
    ex.className = 'step-expected';
    ex.textContent = expected;
    body.append(ex);
  }
  li.append(body);
  li.classList.add('step-row');
}

// Web-runner `pos` = index among ALL <li>: nested ones count in it but get no control.
function parseSteps(container) {
  const allItems = [...container.querySelectorAll('li')];
  const steps = stepListItems(container).map((li, idx) => {
    const pos = allItems.indexOf(li);
    const expected = extractExpected(li) || extractInlineExpected(li);
    const title = stepTitle(li);
    wrapRow(li, expected);
    return { kind: 'step', li, pos: pos < 0 ? idx : pos, index: idx, title, expected, state: 'unset', saving: false };
  });
  const taken = new Set(steps.map((s) => s.li));
  // `container.contains` (the div is detached) drops the Expected sub-bullets folded above.
  const nested = (li) => li.parentElement?.parentElement?.tagName === 'LI';
  const items = allItems
    .filter((li) => !taken.has(li) && container.contains(li) && !nested(li))
    .map((li, idx) => {
      const title = stepTitle(li);
      wrapRow(li, '');
      li.classList.add('step-item');
      return { kind: 'item', li, pos: allItems.indexOf(li), index: idx, title, expected: '', state: 'unset', saving: false };
    });
  return [...steps, ...items];
}

// The v2 description arrives UNsubstituted (params + example ride the JSON:API
// detail); the title needs none — v2 substitutes it server-side.
function applyExample(description) {
  const attrs = state.testrunDetail?.data?.attributes;
  const params = attrs?.test?.params;
  const example = attrs?.example;
  let out = description;
  if (TestomatParams.isParametrized(params) && Array.isArray(example) && example.length) {
    out = TestomatParams.substitute(description, params, example);
  }
  updateExampleBadge(out, params);
  return out;
}

// A leftover ${..}/{{..}} means substitution could not run. Under JWT params are
// known, so gate on parametrized; degraded, the placeholder is the only signal.
function updateExampleBadge(description, params) {
  const el = $('example-badge');
  if (!el) return;
  const raw = TestomatParams.hasPlaceholder(description);
  const show = raw && (capabilities.jwt ? TestomatParams.isParametrized(params) : true);
  el.hidden = !show;
}

function renderSteps(markdownText, record) {
  const box = $('test-steps');
  box.replaceChildren();
  ImgHydrate.release(IMG_GROUP_DESC); // the <img>s about to be dropped own these
  if (!markdownText || !markdownText.trim()) {
    EmptyState.into(box, {
      icon: 'description',
      title: 'No description',
      text: 'This test has no steps to run through — the status buttons above still work.',
    });
    return;
  }
  const tmp = Md.render(markdownText); // parse + sanitize (shared/markdown.js)
  // Hydrate BEFORE the body reaches the document: CSP allows no remote <img> and
  // a root-relative one would resolve against the extension (#205).
  ImgHydrate.hydrate(IMG_GROUP_DESC, tmp);

  state.currentSteps = parseSteps(tmp);
  box.append(...tmp.childNodes);
  applyStepMode(record);
}

function applyStepMode(record) {
  if (capabilities.jwt && record?.id) renderTriState(record);
  else renderLocalCheckboxes(record);
}

// ---- v1 local checkboxes (degraded mode) ----
// Keyed by record id + row ordinal — local only, never the server `pos`.
function renderLocalCheckboxes(record) {
  const key = record.id;
  const ticks = state.stepTicks[key] || {};
  state.currentSteps.forEach((s, ord) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'checkbox';
    cb.checked = !!ticks[ord];
    if (cb.checked) s.li.classList.add('done');
    cb.addEventListener('change', () => {
      const t = state.stepTicks[key] || (state.stepTicks[key] = {});
      if (cb.checked) t[ord] = true; else delete t[ord];
      s.li.classList.toggle('done', cb.checked);
      persistSession();
    });
    s.li.prepend(cb);
  });
}

// ---- tri-state server-synced steps ----
// Web-runner cycle: first click => passed, then passed -> failed -> skipped; no unset write.
const STEP_OPTIONS = ['passed', 'failed', 'skipped'];
// `unset` is the caller's choice: the ring control draws nothing, the summary dot a ring.
const STEP_ICON = { passed: 'check', failed: 'close', skipped: 'remove' };

function paintStepMark(el, status, size, unset = '') {
  const name = STEP_ICON[status] || unset;
  el.replaceChildren(...(name ? [svgIcon(name, size)] : []));
}

// Matched by `pos`; GET .../steps is unsorted (contract), stale entries ignored.
function serverStepStates() {
  const raw = state.testrunDetail?.data?.attributes?.steps;
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const s of [...raw].sort((a, b) => a.pos - b.pos)) {
      if (typeof s?.pos === 'number') map.set(s.pos, s.status);
    }
  }
  return map;
}

function paintStep(s) {
  s.ctrl.dataset.state = s.state;
  paintStepMark(s.ctrl, s.state, 12);
  s.ctrl.setAttribute('aria-label', `${s.kind} ${s.index + 1}: ${s.state}`); // ordinal within its kind, not the web `pos`
  for (const c of ['passed', 'failed', 'skipped']) s.li.classList.toggle(c, s.state === c);
}

function renderTriState(record) {
  const overlay = serverStepStates();
  for (const s of state.currentSteps) {
    s.state = overlay.get(s.pos) || 'unset';
    s.ctrl = document.createElement('button');
    s.ctrl.type = 'button';
    s.ctrl.className = 'btn icon size-xs step-state';
    paintStep(s);
    s.ctrl.addEventListener('click', () => cycleStep(s, record));
    s.li.classList.add('tri');
    s.li.prepend(s.ctrl);
  }
}

// Serialized: concurrent clicks would race the server's read-modify-write of the steps JSON column.
let stepWriteChain = Promise.resolve();

function cycleStep(s, record) {
  if (s.saving) return;
  // #152/#154 — catches the race past the disabled circles. On an automated testrun
  // `Testrun#add_step!` returns early while still answering 200.
  if (recordWriteLock(record)) return;
  const prev = s.state;
  const next = STEP_OPTIONS[(STEP_OPTIONS.indexOf(prev) + 1) % STEP_OPTIONS.length];
  s.state = next;          // optimistic
  paintStep(s);
  s.saving = true;
  const run = async () => {
    try {
      await TestomatAPI.setStep(record.id, { title: s.title, status: next, pos: s.pos });
    } catch (e) {
      s.state = prev;
      paintStep(s);
      toast(`Step not saved: ${e.message}`, { error: true });
    } finally {
      s.saving = false;
    }
  };
  stepWriteChain = stepWriteChain.then(run, run);
}

// Priority rides the JSON:API testrun detail (v2 omits it), so it is JWT-only and
// lands after the header row was painted — this only says the read is in.
function renderPriority() {
  state.testDetailPending = false;
  refreshContextBar();
}

// Read-only mark of the custom status (#109) — tinted by the row's STATUS, not
// the value, and JWT-gated like the select that writes it.
function renderSubstatusMark(record) {
  const el = $('test-substatus-mark');
  if (!el) return;
  const sub = typeof record?.substatus === 'string' ? record.substatus.trim() : '';
  const show = capabilities.jwt && !!sub;
  el.hidden = !show;
  el.className = `badge custom-status ${show ? displayStatus(record) : ''}`.trim();
  el.textContent = show ? sub : '';
  if (show) Tooltip.set(el, `Custom status: ${sub}`);
}

// ---- result summary (#117) ----
// JWT-only; JSON:API attribute keys are DASHERIZED (`run-time`). `steps` is
// serialized only for a manual testrun — an automated one uses the lazy GET.

// Remembered for the panel session (module-level), like the Attachments one.
const summaryOpen = { failure: true, artifacts: true, meta: false, steps: false };

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };
// Mirrors the run header's RUN_STATE_TINT; anything else is neutral.
const TEST_STATE_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

// Per-open state, cleared by hideResultSummary.
let summarySteps = null;
let summaryStepsFetch = null;

// pretty-ms parity with the web (helpers/duration-to-human).
function humanDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  const secs = n / 1000;
  if (secs < 60) return `${String(secs.toFixed(1)).replace(/\.0$/, '')}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rest = Math.round(secs - mins * 60);
    return rest ? `${mins}m ${rest}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  return restMin ? `${hours}h ${restMin}m` : `${hours}h`;
}

// `kind` is 'unreported' | 'bare' (falsy clears): "mark it and this fills in" vs
// "it IS marked and the run carried nothing behind the verdict".
function paintSummaryEmpty(kind) {
  const host = $('test-summary-empty');
  if (!host) return;
  if (!kind) { host.replaceChildren(); return; }
  EmptyState.into(host, kind === 'bare' ? {
    icon: 'checklist',
    title: 'Nothing behind this result',
    text: 'No failure message, environment meta or reported steps came with it.',
  } : {
    icon: 'checklist',
    title: 'Nothing reported yet',
    text: 'Mark a result above to see its failure, environment meta and step outcomes here.',
  });
}

// Driven by what the tab actually HOLDS, not by the existence of a verdict: a
// marked test with an empty summary must not wear a dot.
function paintSectionMark(status) {
  const tab = $('tab-test-summary');
  if (!tab) return;
  const existing = tab.querySelector('.status-dot');
  if (!status) { if (existing) existing.remove(); return; }
  const dot = existing || document.createElement('span');
  dot.className = 'status-dot';
  dot.dataset.status = status;
  if (!existing) tab.append(dot);
}

function hideResultSummary() {
  const box = $('test-summary');
  if (box) box.hidden = true;
  if ($('test-result-row')) $('test-result-row').hidden = true;
  paintSummaryEmpty('unreported');
  paintSectionMark('');
  if ($('summary-message')) $('summary-message').replaceChildren();
  if ($('summary-artifacts-body')) $('summary-artifacts-body').replaceChildren();
  if ($('summary-meta-body')) $('summary-meta-body').replaceChildren();
  if ($('summary-steps-body')) $('summary-steps-body').replaceChildren();
  summarySteps = null;
  summaryStepsFetch = null;
  ImgHydrate.release(IMG_GROUP_SHOTS);
  ImgHydrate.release(IMG_GROUP_ARTIFACTS);
  syncSummaryStepsTools();
}

function paintSummaryDisclosure(key) {
  const head = $(`summary-${key}-head`);
  const body = $(`summary-${key}-body`);
  const open = !!summaryOpen[key];
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
  if (key === 'steps') syncSummaryStepsTools();
}

function toggleSummaryDisclosure(key) {
  summaryOpen[key] = !summaryOpen[key];
  paintSummaryDisclosure(key);
  if (key === 'steps' && summaryOpen.steps) loadSummarySteps(); // lazy for automated
}

function renderResultSummary() {
  const box = $('test-summary');
  if (!box) return;
  const attrs = state.testrunDetail?.data?.attributes;
  const status = attrs?.status;
  // "Reported" = the web's `hasStatus`: a real, non-pending status.
  if (!attrs || !status || status === 'pending') { hideResultSummary(); return; }
  if ($('test-result-row')) $('test-result-row').hidden = false;
  const label = STATUS_LABEL[status] || status;
  // `data-status` stays: the machine-readable value a script reads off the element.
  const el = $('summary-status');
  el.className = `status-label ${TEST_STATE_TINT[normStatus(status)] || 'neutral'}`;
  el.dataset.status = status;
  const word = document.createElement('span');
  word.textContent = label;
  el.replaceChildren(statusIcon(status), word);
  const dur = humanDuration(attrs['run-time']);
  $('summary-duration').textContent = dur ? `· ${dur}` : '';
  renderSummaryFailure(attrs);
  renderSummaryArtifacts(attrs);
  renderSummaryMeta(attrs);
  renderSummaryStepsSection(attrs);
  // All four hidden = an empty accordion, which a bare manual pass reaches often.
  const filled = ['summary-failure', 'summary-artifacts', 'summary-meta', 'summary-steps']
    .some((id) => $(id) && !$(id).hidden);
  box.hidden = !filled;
  paintSummaryEmpty(filled ? '' : 'bare');
  paintSectionMark(filled ? normStatus(status) : '');
}

// `status` and `message` are the ONLY fields the panel can change, so they are
// patched into the prefetched detail instead of costing a re-read.
function refreshResultSummary(record) {
  const attrs = state.testrunDetail?.data?.attributes;
  if (!attrs || !record) return;
  attrs.status = record.status;
  attrs.message = record.message || '';
  renderResultSummary();
}

// The split matters: a reporter message is assertion output whose whitespace IS
// the information (verbatim text); a manual one is Markdown through the sanitizer.
function renderSummaryFailure(attrs) {
  const wrap = $('summary-failure');
  const out = $('summary-message');
  if (!wrap || !out) return;
  const message = typeof attrs.message === 'string' ? attrs.message.trim() : '';
  wrap.hidden = !message;
  out.replaceChildren();
  if (!message) return;
  const failed = attrs.status === 'failed';
  $('summary-failure-title').textContent = failed ? 'Failure' : 'Log';
  out.className = `summary-message ${failed ? 'is-failed' : 'is-ok'}`;
  if (attrs.automated) {
    out.classList.add('code', 'is-raw');
    out.textContent = message; // pre-wrap; reporter output is not markdown
  } else {
    const tmp = Md.render(message); // shared/markdown.js — parse + sanitize
    // `.sections`: headings inside the panel's chrome render as muted labels.
    out.classList.add('markdown', 'sections');
    out.append(...tmp.childNodes);
  }
  paintSummaryDisclosure('failure');
}

// #21: on a private bucket the server presigns only the first artifacts of a result
// and flags the tail — signed once per URL here ('' remembers a refusal).
const artifactPresigned = new Map();

async function artifactSigned(a) {
  if (!a?.needs_presign || !a.url) return a;
  if (!artifactPresigned.has(a.url)) {
    let signed = '';
    try { signed = await TestomatAPI.presignArtifact(a.url); } catch { /* stays raw */ }
    artifactPresigned.set(a.url, signed);
  }
  const url = artifactPresigned.get(a.url);
  // A refusal keeps the raw URL: the link still opens, and a thumbnail that fails on
  // it drops back to that same link rather than a broken box.
  return url ? { ...a, url, display_url: url } : a;
}

// Web parity: the web's Summary lists EVERY file on the result — runner artifacts and manual
// uploads alike (one `attachments` array, told apart by the `artifact` flag) — so this fold
// does too. attachments.js still keeps its own fold to the manual ones.
function renderSummaryArtifacts(attrs) {
  const wrap = $('summary-artifacts');
  const body = $('summary-artifacts-body');
  if (!wrap || !body) return;
  const rows = (Array.isArray(attrs.attachments) ? attrs.attachments : [])
    .filter((a) => a && (a.url || a.name));
  wrap.hidden = rows.length === 0;
  if (!rows.length) {
    ImgHydrate.release(IMG_GROUP_ARTIFACTS); // the thumbnails about to be dropped own these
    body.replaceChildren();
    return;
  }
  $('summary-artifacts-count').textContent = String(rows.length);
  paintSummaryDisclosure('artifacts');
  paintSummaryArtifacts(rows);
}

// Async because of the presign: a tile is built only once its URL is final, so the
// preview, the viewer and the way out never start on one that is about to change.
async function paintSummaryArtifacts(rows) {
  const recordId = state.currentRecordId;
  const resolved = await Promise.all(rows.map((a) => artifactSigned(a)));
  const body = $('summary-artifacts-body');
  if (!body || String(state.currentRecordId) !== String(recordId)) return; // moved on
  ImgHydrate.release(IMG_GROUP_ARTIFACTS);
  body.replaceChildren(...resolved.map((a) => fileTileItem(a, IMG_GROUP_ARTIFACTS, attachmentHref(a))));
}

// Meta = the testrun's non-system `extras` (web `metafields`); the system entries
// (change/duration/substatus/testlink) are bookkeeping, never shown.
function renderSummaryMeta(attrs) {
  const wrap = $('summary-meta');
  const body = $('summary-meta-body');
  if (!wrap || !body) return;
  const rows = (Array.isArray(attrs.extras) ? attrs.extras : [])
    .filter((e) => e && e.source !== 'system' && e.key);
  wrap.hidden = rows.length === 0;
  body.replaceChildren();
  if (!rows.length) return;
  $('summary-meta-count').textContent = String(rows.length);
  for (const e of rows) {
    const dt = document.createElement('dt');
    dt.textContent = e.key;
    const dd = document.createElement('dd');
    dd.textContent = e.value == null ? '' : String(e.value);
    body.append(dt, dd);
  }
  paintSummaryDisclosure('meta');
}

// Automated: only `sections.steps.count` is advertised, the list is fetched on first expand.
function renderSummaryStepsSection(attrs) {
  const wrap = $('summary-steps');
  if (!wrap) return;
  const inline = Array.isArray(attrs.steps) ? attrs.steps : null;
  const advertised = Number(attrs.sections?.steps?.count) || 0;
  summarySteps = inline && inline.length ? inline : null;
  const count = summarySteps ? summarySteps.length : advertised;
  wrap.hidden = count === 0;
  if (!count) return;
  $('summary-steps-count').textContent = String(count);
  paintSummaryDisclosure('steps');
  if (summarySteps) paintSummarySteps();
  else if (summaryOpen.steps) loadSummarySteps();
}

// Same route the web uses: GET /testruns/{id}/steps -> { steps: [...] }. Best-effort.
async function loadSummarySteps() {
  const body = $('summary-steps-body');
  if (!body || summarySteps || summaryStepsFetch) return;
  const recordId = state.currentRecordId;
  if (!recordId) return;
  // Drawn at once rather than armed: nothing behind it for a placeholder to flash over.
  body.replaceChildren(Sk.lines(['76%', '58%', '68%']));
  summaryStepsFetch = TestomatAPI.jwtRequest(`/testruns/${encodeURIComponent(recordId)}/steps`);
  try {
    const doc = await summaryStepsFetch;
    if (String(state.currentRecordId) !== String(recordId)) return; // moved on
    summarySteps = Array.isArray(doc?.steps) ? doc.steps : [];
    paintSummarySteps();
  } catch {
    if (String(state.currentRecordId) === String(recordId)) body.textContent = "Couldn't load the reported steps";
  } finally {
    summaryStepsFetch = null;
  }
}

// ---- reported steps: web-report parity (#202) ----
// Live contract: `attachments` exist ONLY on GET /testruns/{id}/steps (the manual
// route permits [status,title,message,pos]); `duration` comes back a STRING there.

// Web parity (front nested-steps.js): attachments move into a child "Attachments"
// group so they render in one place. Length check, or an empty array grows a group.
function summaryStepTree(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => {
    const node = {
      name: step?.title,
      category: step?.category, // carried like the web's transform; not rendered
      duration: step?.duration,
      attachments: step?.attachments,
      log: step?.log,
      error: step?.error,
      status: step?.status,
      children: null,
      isImage: false,
    };
    if (Array.isArray(step?.steps) && step.steps.length) node.children = summaryStepTree(step.steps);
    if (Array.isArray(step?.attachments) && step.attachments.length) {
      if (!node.children) node.children = [];
      node.children.push({ name: 'Attachments', attachments: step.attachments, children: null });
      node.attachments = null;
      node.isImage = true;
    }
    return node;
  });
}

// Web default: collapsed until the tester asks. Sticky per panel session.
let summaryStepsExpanded = false;

// http(s) URLs inside a step log become real links — built as anchor NODES around
// text nodes, never through innerHTML: the log is reporter output, i.e. untrusted.
const LOG_URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkifyInto(el, text) {
  const s = String(text);
  let last = 0;
  for (const m of s.matchAll(LOG_URL_RE)) {
    let href = m[0];
    const trail = href.match(/[.,;:!?)\]}'"]+$/); // trailing punctuation is prose, not URL
    if (trail) href = href.slice(0, -trail[0].length);
    if (!href) continue;
    if (m.index > last) el.append(s.slice(last, m.index));
    const a = document.createElement('a');
    a.href = href;
    a.textContent = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el.append(a);
    last = m.index + href.length;
  }
  if (last < s.length) el.append(s.slice(last));
}

// Web `isImage`: trust the server MIME type, the name only as fallback; SVG excluded.
function isImageAttachment(a) {
  const type = String(a?.type || '');
  if (type) return type.startsWith('image/') && !/svg/i.test(type);
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(String(a?.name || a?.url || ''));
}

// #21: EITHER tell, not MIME-first like the image test — a bucket serves a screencast as
// `application/octet-stream` often enough that the extension has to be able to answer alone.
function isVideoAttachment(a) {
  if (String(a?.type || '').startsWith('video/')) return true;
  return /\.(webm|mp4|mov|m4v|ogv)(?:$|[?#])/i.test(String(a?.name || a?.url || ''));
}

// The tile badge: what the file IS, in the few letters an 88px card fits.
function fileExt(a) {
  const m = String(a?.name || a?.url || '').match(/\.([a-z0-9]{1,5})(?:$|[?#])/i);
  return m ? m[1].toUpperCase() : '';
}

// e2e-only hook: real artifact URLs are presigned bucket links the harness cannot
// mint, so `stepShotHook` swaps only the HOST and the whole fetch path still runs.
async function shotHookBase() {
  if (!hasChrome || !chrome.storage?.session) return '';
  try { return (await chrome.storage.session.get('stepShotHook')).stepShotHook || ''; } catch { return ''; }
}

// `display_url` is the presigned inline form (no session); `url` is the app-host
// route behind the login, which fetchAsset carries the JWT to.
// The instance's own URL first: `display_url` is already a storage link the server put in
// the data, and the bytes are the same file — its own address redirects there authorized.
async function attachmentSrc(att) {
  const base = await shotHookBase();
  if (base) return new URL(att?.name || '', base).toString();
  return att?.url || att?.display_url || '';
}

// `display_url` is the inline form of an IMAGE; for any other type the server answers a
// file-type icon there, so the file itself only ever comes from `url`.
const attachmentHref = (att) => (isImageAttachment(att) ? att?.display_url || att?.url : att?.url) || '';

function attachmentLink(att) {
  const el = document.createElement(att?.url ? 'a' : 'span');
  el.className = 'summary-step-att-link';
  if (att?.url) { el.href = att.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
  el.textContent = att?.name || 'attachment';
  el.title = el.textContent;
  return el;
}

// Bytes go through shared/img-hydrate.js because CSP img-src carries no `https:`
// by design (#175). `onFail` gives the caller's own row shape — never a broken box.
function attachmentThumb(group, att, onFail) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'attachment-thumb';
  btn.title = `${att?.name || 'screenshot'} — click to enlarge`;
  const img = document.createElement('img');
  img.alt = att?.name || 'screenshot';
  btn.append(img);
  btn.addEventListener('click', () => openFileViewer(att));
  attachmentSrc(att)
    .then((src) => ImgHydrate.load(group, src, img))
    .then((ok) => { if (!ok) onFail(btn); })
    .catch(() => onFail(btn));
  return btn;
}

// A step's video keeps the tree's one-line density (no tile), but its click opens the
// same viewer the tiles use instead of handing the tester a new tab.
function attachmentPlay(att) {
  const url = attachmentHref(att);
  if (!url) return attachmentLink(att);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'summary-step-att-link is-play';
  btn.title = att?.name || 'attachment';
  btn.append(svgIcon('play_arrow', 12), document.createTextNode(att?.name || 'attachment'));
  btn.addEventListener('click', () => openFileViewer(att, url));
  return btn;
}

function summaryAttachment(att) {
  if (isImageAttachment(att)) {
    return attachmentThumb(IMG_GROUP_SHOTS, att, (el) => el.replaceWith(attachmentLink(att)));
  }
  return isVideoAttachment(att) ? attachmentPlay(att) : attachmentLink(att);
}

// ---- file tiles (#21) ----
// One shape everywhere the panel LISTS files: an image shows itself, a video and any other
// file show a card. Which one a tile is lives in `data-kind`, and the click reads it back —
// an image whose bytes never arrive becomes a 'file' card and opens in a tab like one.

function paintTilePreview(host, kind, att) {
  host.replaceChildren();
  if (kind === 'image') {
    const img = document.createElement('img');
    img.alt = att?.name || 'screenshot';
    host.append(img);
    return;
  }
  const badge = document.createElement('span');
  badge.className = 'file-tile-badge';
  badge.textContent = fileExt(att) || 'FILE';
  host.append(svgIcon(kind === 'video' ? 'play_arrow' : 'description', 24), badge);
}

function fileTile(att, group, resolvedUrl) {
  const url = resolvedUrl || attachmentHref(att);
  const name = att?.name || 'attachment';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'file-tile';
  btn.dataset.kind = isImageAttachment(att) ? 'image' : (isVideoAttachment(att) ? 'video' : 'file');
  Tooltip.set(btn, name);
  const preview = document.createElement('span');
  preview.className = 'file-tile-preview';
  paintTilePreview(preview, btn.dataset.kind, att);
  const label = document.createElement('span');
  label.className = 'file-tile-name';
  label.textContent = name;
  btn.append(preview, label);
  if (btn.dataset.kind === 'image') {
    const fail = () => { btn.dataset.kind = 'file'; paintTilePreview(preview, 'file', att); };
    attachmentSrc(att)
      .then((src) => ImgHydrate.load(group, src, preview.querySelector('img')))
      .then((ok) => { if (!ok) fail(); })
      .catch(fail);
  }
  btn.addEventListener('click', () => openFileViewer(att, url));
  return btn;
}

// Both file grids are <ul>s, so the tile travels inside an <li>.
function fileTileItem(att, group, resolvedUrl) {
  const li = document.createElement('li');
  li.append(fileTile(att, group, resolvedUrl));
  return li;
}

// The web's `file-image-outline` marker, in the panel's own icon set.
function imageMarker() {
  return svgIcon('photo_camera', 13, 'summary-step-marker');
}

// A step block is a TREE NODE, drawn with the library's own tree parts: a chevron
// slot, then a glyph slot, then the title — the shape the runs list and TC studio
// already wear, so the three lists rule at the same columns.
// An Attachments group node renders NO step row — the web skips it the same way
// (`{{#unless node.model.attachments}}`) and shows only the files.
function summaryStepNode(node) {
  const group = document.createElement('div');
  group.className = 'summary-step-group tree-node';
  // The row rule hangs off `.summary-step-self`, so a step's own log stays ABOVE
  // the line that closes it and its children start below.
  const self = document.createElement('div');
  self.className = 'summary-step-self';
  group.append(self);
  if (node?.attachments) {
    // The files hang off the block the way a log does, so the rule that closes the
    // block still starts at the same column as every other row's.
    const atts = document.createElement('div');
    atts.className = 'summary-step-atts';
    for (const att of node.attachments) atts.append(summaryAttachment(att));
    self.append(atts);
    return group;
  }
  const row = document.createElement('div');
  row.className = 'summary-step tree-row has-chevron';
  const kids = node?.children?.length ? document.createElement('div') : null;
  if (kids) {
    // A bare chevron in the tree's 20px slot — still a real button, so it keeps its
    // place in the tab order. CSS rotates it 90° on aria-expanded.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-icon chevron summary-step-toggle';
    toggle.append(svgIcon(CHEVRON_ICON, 16));
    const paint = (open) => {
      kids.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      Tooltip.set(toggle, open ? 'Collapse' : 'Expand');
    };
    paint(summaryStepsExpanded);
    toggle.addEventListener('click', () => paint(kids.hidden));
    row.append(toggle);
  } else {
    row.append(treeSlot()); // a leaf still pays for the chevron column, or the marks below it stagger
  }
  const dot = document.createElement('span');
  dot.className = 'tree-icon summary-step-dot';
  dot.dataset.status = node?.status || '';
  paintStepMark(dot, node?.status, 16, 'radio_button_unchecked');
  const title = document.createElement('span');
  title.className = 'summary-step-title';
  title.textContent = node?.name || '(untitled step)';
  row.append(dot, title);
  if (node?.isImage) title.append('\u00a0', imageMarker()); // NBSP: the mark rides the last word instead of wrapping alone
  if (node?.status) {
    const word = document.createElement('span');
    word.className = 'summary-step-status';
    word.dataset.status = node.status;
    word.textContent = node.status;
    row.append(word);
  }
  const dur = humanDuration(node?.duration);
  if (dur) {
    const d = document.createElement('span');
    d.className = 'summary-step-duration';
    d.textContent = dur;
    row.append(d);
  }
  self.append(row);
  if (node?.error) {
    const err = document.createElement('div');
    err.className = 'summary-step-error';
    err.textContent = String(node.error);
    self.append(err);
  }
  // The log hangs off the step, not its children — readable while sub-steps are collapsed.
  if (node?.log) {
    const log = document.createElement('div');
    log.className = `summary-step-log${node.error ? ' is-failed' : ''}`;
    linkifyInto(log, String(node.log).trim());
    self.append(log);
  }
  if (kids) {
    // A `.tree-children` and nothing more: the open subtree is the library's own
    // container, so it drops the same guide a folder does in the runs list and
    // takes the same 28px step in — and folding it away takes the line with it.
    kids.className = 'summary-step-kids tree-children';
    kids.hidden = !summaryStepsExpanded;
    for (const child of node.children) kids.append(summaryStepNode(child));
    group.append(kids);
  }
  return group;
}

// Created lazily beside the disclosure head, so app.js needs no extra wiring.
function summaryStepsTools() {
  const wrap = $('summary-steps');
  const head = $('summary-steps-head');
  if (!wrap || !head) return null;
  let tools = wrap.querySelector('.summary-steps-tools');
  if (tools) return tools;
  tools = document.createElement('div');
  tools.className = 'summary-steps-tools';
  const mk = (id, icon, label, expanded) => {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'btn icon size-xs';
    b.append(svgIcon(icon, 16));
    b.setAttribute('aria-label', label);
    Tooltip.set(b, label);
    b.addEventListener('click', () => {
      summaryStepsExpanded = expanded;
      paintSummarySteps();
    });
    return b;
  };
  tools.append(mk('summary-steps-expand', 'keyboard_arrow_down', 'Expand all', true),
    mk('summary-steps-collapse', 'keyboard_arrow_up', 'Collapse all', false));
  head.after(tools);
  return tools;
}

function syncSummaryStepsTools() {
  const tools = summaryStepsTools();
  if (tools) tools.hidden = !summaryOpen.steps || !(summarySteps && summarySteps.length);
}

function paintSummarySteps() {
  const body = $('summary-steps-body');
  if (!body) return;
  ImgHydrate.release(IMG_GROUP_SHOTS); // the <img>s about to be dropped own these
  body.replaceChildren();
  if (!summarySteps || !summarySteps.length) {
    // Compact: a centred block would push the rest of the test view off screen.
    body.append(EmptyState.build({
      compact: true,
      icon: 'format_list_numbered',
      text: 'No reported steps',
    }));
    syncSummaryStepsTools();
    return;
  }
  for (const node of summaryStepTree(summarySteps)) body.append(summaryStepNode(node));
  syncSummaryStepsTools();
}

// ---- file viewer (#21) ----
// Out of the panel entirely (at ~400px a video is a postage stamp), but not into a window of
// its own either: on macOS a popup cannot float over a fullscreen browser. The worker draws
// the viewer INTO the page under test instead (background.js openFileOverlay).

function openFileViewer(att, resolvedUrl) {
  const url = resolvedUrl || attachmentHref(att);
  if (!url) return;
  if (!hasChrome || !chrome.runtime?.sendMessage) { window.open(url, '_blank', 'noopener'); return; }
  chrome.runtime
    // `mime`, not `type`: the message's own `type` is what the worker routes on.
    .sendMessage({ type: 'OPEN_FILE_OVERLAY', url, name: att?.name || '', mime: att?.type || '' })
    .catch(() => { window.open(url, '_blank', 'noopener'); });
}

// JWT-only, and only once the row has a real status AND the project defines
// replies for it. The empty row is how a custom status comes back off.
const SUBSTATUS_NONE = '— none —';

// Wired once from app init — the mount is static markup, the control is not.
function initSubstatusDropdown() {
  const mount = $('substatus-mount');
  if (!mount || Dropdown.of('substatus-select')) return;
  mount.append(Dropdown.create({
    id: 'substatus-select',
    className: 'substatus-dd',
    labelledBy: 'substatus-label',
    label: 'Custom status',
    placeholder: SUBSTATUS_NONE,
    onChange: onSubstatusChange,
  }).el);
}

function renderSubstatus(record) {
  const wrap = $('test-substatus');
  const dd = Dropdown.of('substatus-select');
  if (!wrap || !dd) return;
  const status = record?.status;
  const group = runRepliesFor(status);
  const show = capabilities.jwt && !!record?.id && !!status && status !== 'pending' && group.length > 0;
  wrap.hidden = !show;
  if (!show) { dd.setOptions([]); return; }
  dd.setOptions(
    [{ value: '', label: SUBSTATUS_NONE }, ...group.map((r) => ({ value: r, label: r }))],
    { value: group.includes(record.substatus) ? record.substatus : '' });
}

// JWT-only, custom listbox (an OS menu draws no monogram or filter box). The v2
// read folds the assignee to ONE email, so single-select — more would be unpicked.
let assigneeFilter = '';
let assigneeActiveId = null;

function assigneeRows() {
  const rows = [{ id: '', name: 'Unassigned', email: '' }, ...(usersList || [])];
  const q = assigneeFilter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((u) => `${u.name || ''} ${u.email || ''}`.toLowerCase().includes(q));
}

function renderAssignee(record) {
  const wrap = $('test-assignee');
  const trigger = $('assignee-trigger');
  if (!wrap || !trigger) return;
  const show = capabilities.jwt && !!record?.id;
  wrap.hidden = !show;
  if (!show) { closeAssigneeMenu(); applyAssigneeGate(null); return; }
  paintAssigneeTrigger(record);
  if ($('assignee-menu') && !$('assignee-menu').hidden) renderAssigneeOptions();
  applyAssigneeGate(record); // #153 — a marked row is no longer re-assignable
}

function paintAssigneeTrigger(record) {
  const trigger = $('assignee-trigger');
  const valueSlot = $('assignee-value');
  if (!trigger || !valueSlot) return;
  const id = assignedUserId(record);
  trigger.dataset.userId = id;
  const user = id ? (usersList || []).find((u) => String(u.id) === id) : null;
  valueSlot.replaceChildren(user ? UserCell.cell(user) : unassignedCell());
}

// Same `.user-cell` shape as a real person, so it sits in the same column.
function unassignedCell() {
  const cell = document.createElement('span');
  cell.className = 'user-cell';
  const mark = document.createElement('span');
  mark.className = 'avatar';
  mark.setAttribute('aria-hidden', 'true');
  mark.append(Icons.el('person', 12));
  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = 'Unassigned';
  cell.append(mark, name);
  return cell;
}

// ---- the popup (search + rows) --------------------------------------------

function renderAssigneeOptions() {
  const list = $('assignee-list');
  if (!list) return;
  const record = recordFor(state.currentRecordId);
  const current = assignedUserId(record);
  const rows = assigneeRows();
  if (!rows.some((u) => u.id === assigneeActiveId)) assigneeActiveId = rows.length ? rows[0].id : null;
  list.replaceChildren(...rows.map((u) => {
    const li = document.createElement('li');
    li.id = `assignee-opt-${u.id || 'none'}`;
    li.className = 'menu-option assignee-option';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', u.id === current ? 'true' : 'false');
    li.dataset.userId = u.id;
    li.classList.toggle('active', u.id === assigneeActiveId);
    li.append(u.id === '' ? unassignedCell() : UserCell.cell(u));
    li.append(Icons.el('check', 14, 'assignee-option-check'));
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the filter
    li.addEventListener('click', () => pickAssignee(u.id));
    return li;
  }));
  const empty = $('assignee-empty');
  if (empty) empty.hidden = rows.length > 0;
  syncAssigneeActiveOption();
}

function syncAssigneeActiveOption() {
  const input = $('assignee-filter');
  if (!input) return;
  const li = assigneeActiveId != null ? $(`assignee-opt-${assigneeActiveId || 'none'}`) : null;
  if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  else input.removeAttribute('aria-activedescendant');
}

function openAssigneeMenu() {
  const menu = $('assignee-menu');
  const trigger = $('assignee-trigger');
  if (!menu || !trigger || trigger.disabled || !menu.hidden) return;
  assigneeFilter = '';
  assigneeActiveId = assignedUserId(recordFor(state.currentRecordId));
  const input = $('assignee-filter');
  if (input) input.value = '';
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  renderAssigneeOptions();
  if (input) input.focus(); // typing filters straight away
  document.addEventListener('click', onAssigneeDocClick, true);
  document.addEventListener('keydown', onAssigneeMenuKey, true);
}

function closeAssigneeMenu({ focus = false } = {}) {
  const menu = $('assignee-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const trigger = $('assignee-trigger');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }
  document.removeEventListener('click', onAssigneeDocClick, true);
  document.removeEventListener('keydown', onAssigneeMenuKey, true);
}

function onAssigneeDocClick(e) {
  const dd = $('assignee-dd');
  if (dd && !dd.contains(e.target)) closeAssigneeMenu();
}

// Document-level capture, so the keys work wherever focus sits.
function onAssigneeMenuKey(e) {
  const menu = $('assignee-menu');
  if (!menu || menu.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAssigneeMenu({ focus: true }); return; }
  if (e.key === 'Tab') { closeAssigneeMenu(); return; } // focus is leaving — let it
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveAssigneeActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (assigneeActiveId != null) pickAssignee(assigneeActiveId);
  }
}

function moveAssigneeActive(delta) {
  const rows = assigneeRows();
  if (!rows.length) return;
  const from = rows.findIndex((u) => u.id === assigneeActiveId);
  const to = from === -1 ? 0 : Math.min(Math.max(from + delta, 0), rows.length - 1);
  assigneeActiveId = rows[to].id;
  const list = $('assignee-list');
  if (list) for (const li of list.children) li.classList.toggle('active', li.dataset.userId === assigneeActiveId);
  syncAssigneeActiveOption();
}

function onAssigneeFilterInput() {
  const input = $('assignee-filter');
  assigneeFilter = input ? input.value : '';
  assigneeActiveId = null; // the first match becomes the cursor
  renderAssigneeOptions();
}

function onAssigneeTriggerClick(e) {
  e.stopPropagation(); // the doc-level close listener would swallow the toggle
  if ($('assignee-menu').hidden) openAssigneeMenu(); else closeAssigneeMenu({ focus: true });
}

function onAssigneeTriggerKey(e) {
  if (!$('assignee-menu').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openAssigneeMenu();
  }
}

function pickAssignee(value) {
  closeAssigneeMenu({ focus: true });
  onAssigneeChange(value);
}

// Wired once from app init — the markup is static.
function initAssigneeDropdown() {
  $('assignee-trigger').addEventListener('click', onAssigneeTriggerClick);
  $('assignee-trigger').addEventListener('keydown', onAssigneeTriggerKey);
  $('assignee-filter').addEventListener('input', onAssigneeFilterInput);
}

// ---- assignee gate (#153) ----
// Web parity (`AssignTo @disabled={{...hasStatus}}`). The server accepts the write
// regardless — no check on its side — so the panel IS the gate.
const ASSIGN_GATE_REASON = "Can't re-assign already marked test";

function assigneeGateReason(record) {
  if (!record) return '';
  return displayStatus(record) === 'untested' ? '' : ASSIGN_GATE_REASON;
}

// A hover-only tooltip is invisible on touch, so the reason is shown inline too.
function applyAssigneeGate(record) {
  const trigger = $('assignee-trigger');
  if (!trigger) return '';
  const reason = assigneeGateReason(record);
  trigger.disabled = !!reason;
  if (reason) closeAssigneeMenu();
  Tooltip.set(trigger, reason);
  const note = $('assignee-reason');
  if (note) { note.textContent = reason; note.hidden = !reason; }
  return reason;
}

// v2 echoes the assignee as an EMAIL — map it back to the member id.
function assignedUserId(record) {
  const email = record?.assigned_to;
  if (!email) return '';
  const u = (usersList || []).find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase());
  return u ? String(u.id) : '';
}

function flashAssignee() {
  const trigger = $('assignee-trigger');
  if (!trigger) return;
  trigger.classList.remove('saved-flash');
  void trigger.offsetWidth; // reflow → restart the animation
  trigger.classList.add('saved-flash');
  setTimeout(() => trigger.classList.remove('saved-flash'), 1000);
}

// Optimistic, serialized like substatus. The optimistic value is the member's
// EMAIL — the shape the v2 read echoes — so the immediate refetch finds no diff.
let assignWriting = false;
async function onAssigneeChange(value) {
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return;
  if (assignWriting) { paintAssigneeTrigger(record); return; } // ignore + re-sync
  // #153: the trigger is already disabled — this only catches the status-landed race.
  if (assigneeGateReason(record)) { paintAssigneeTrigger(record); applyAssigneeGate(record); return; }
  const prevId = assignedUserId(record);
  if (value === prevId) return;
  const user = value ? (usersList || []).find((u) => String(u.id) === value) : null;
  const prevEmail = record.assigned_to || null;
  assignWriting = true;
  $('assignee-trigger').disabled = true;
  syncBeginWrite();
  record.assigned_to = user ? user.email : null; // optimistic (v2 read = email)
  paintAssigneeTrigger(record);
  try {
    await TestomatAPI.assignTestrun(record.id, value || null);
    flashAssignee();
  } catch (e) {
    record.assigned_to = prevEmail;
    paintAssigneeTrigger(record);
    if (isAuthError(e)) setAuthExpiredLine('test-status');
    else toast(`Assignee not saved: ${e.message}`, { error: true });
  } finally {
    assignWriting = false;
    // Not a bare `disabled = false`: a status may have landed and the #153 gate must hold.
    applyAssigneeGate(record);
    syncEndWrite();
  }
}

// Optimistic + serialized. The Dropdown has ALREADY moved its closed face to the
// new value, so every path that refuses the change must put the face back.
let substatusWriting = false;
async function onSubstatusChange(value) {
  const dd = Dropdown.of('substatus-select');
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return;
  const resync = () => dd.setValue(record.substatus || '');
  if (substatusWriting) { resync(); return; }                    // ignore + re-sync
  if (recordWriteLock(record)) { resync(); return; }             // #152/#154 — locked, re-sync
  const prev = record.substatus || '';
  substatusWriting = true;
  syncBeginWrite();
  record.substatus = value; // optimistic
  renderSubstatusMark(record);
  try {
    if (value) await TestomatAPI.setSubstatus(record.id, value);
    else await TestomatAPI.clearSubstatus(record.id);
  } catch (e) {
    record.substatus = prev;
    dd.setValue(prev);
    renderSubstatusMark(record);
    if (isAuthError(e)) setAuthExpiredLine('test-status');
    else toast(`Custom status not saved: ${e.message}`, { error: true });
  } finally {
    substatusWriting = false;
    syncEndWrite();
  }
}

// ---- full-page capture toggle ----
// Persisted in settings (default false); every capture path reads fullPageCaptureEnabled().
function fullPageCaptureEnabled() { return !!(state.settings && state.settings.fullPageCapture); }

function syncFullPageToggles() {
  const el = $('fullpage-test');
  if (el) el.checked = fullPageCaptureEnabled();
}

async function setFullPageCapture(on) {
  if (!state.settings) return;
  state.settings.fullPageCapture = !!on;
  syncFullPageToggles();
  if (hasChrome && chrome.storage?.local) {
    try { await chrome.storage.local.set({ settings: state.settings }); } catch { /* best effort */ }
  }
}

// A hover-only tooltip is invisible on touch, so the reason shows inline too. The
// button's own tooltip is remembered once and restored when the gate lifts.
function applyActionGate(btnId, reasonId, msg, { inline = true } = {}) {
  const btn = $(btnId);
  if (!btn) return;
  if (btn.dataset.baseTip === undefined) btn.dataset.baseTip = Tooltip.get(btn);
  btn.disabled = !!msg;
  Tooltip.set(btn, msg || btn.dataset.baseTip);
  const reason = $(reasonId);
  const show = !!msg && inline;
  if (reason) { reason.textContent = show ? msg : ''; reason.hidden = !show; }
}

// The buttons double as the result display: the matching one takes the `.solid` fill.
function paintStatusButtons(status) {
  const s = status && status !== 'pending' ? normStatus(status) : '';
  for (const st of ['passed', 'failed', 'skipped']) {
    const btn = $(`btn-${st}`);
    if (!btn) continue;
    btn.classList.toggle('solid', st === s);
    btn.classList.toggle('outline', st !== s);
  }
}

function updateTestActionsState() {
  const record = recordFor(state.currentRecordId);
  // #152/#154: the lock outranks every other gate here — "no saved result yet"
  // would invite a click that can no longer create one. Per RECORD since #154.
  const lock = typeof recordWriteLock === 'function' ? recordWriteLock(record) : '';
  // The three buttons share ONE reason paragraph, so they are gated together.
  for (const id of ['btn-passed', 'btn-failed', 'btn-skipped']) applyActionGate(id, null, lock);
  const lockNote = $('status-lock-reason');
  if (lockNote) { lockNote.textContent = lock; lockNote.hidden = !lock; }
  paintStatusButtons(record?.status);
  // The comment rides the status write, so a lock makes it read-only too.
  const comment = $('test-comment');
  if (comment) { comment.disabled = !!lock; Tooltip.set(comment, lock); }
  // Tri-state step circles write straight to the server (add_step) — same lock.
  // The v1 local checkboxes (basic mode) are local-only ticks and stay live.
  document.querySelectorAll('#test-steps .step-state').forEach((b) => {
    b.disabled = !!lock;
    Tooltip.set(b, lock);
  });
  // Substatus stays visible and simply refuses to change; assignee is deliberately
  // NOT gated here — it is workflow metadata, tracked separately (#153).
  const substatus = Dropdown.of('substatus-select');
  if (substatus) { substatus.disabled = !!lock; Tooltip.set(substatus.trigger, lock); }
  // Attach gates on a missing result id, NOT the status — a pending row can have one.
  const noResult = !record?.id;
  // #107: uploads are JWT-only, so a PROVEN degraded session disables them —
  // 'unknown' is still probing and must never gate.
  const degraded = TestomatAPI.jwtAvailable() === false;
  // The lock still DISABLES both buttons, but its reason is not repeated inline: the
  // group note above already says it once, and two more copies read as a stutter.
  // `inline: false` keeps the reason on the tooltip only.
  applyActionGate('btn-screenshot-annotate', 'screenshot-reason',
    lock ? lock
      : noResult ? 'No saved result yet — screenshots attach to a test result'
        : degraded ? `Attaching screenshots needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
          : '', { inline: !lock });
  applyActionGate('btn-attach-file', 'attach-file-reason',
    lock ? lock
      : noResult ? 'No saved result yet — files attach to a test result'
        : degraded ? `Attaching files needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
          : '', { inline: !lock });
  applyActionGate('btn-screen-rec', 'screen-rec-reason',
    lock ? lock
      : noResult ? 'No saved result yet, a recording attaches to a test result'
        : degraded ? `Attaching a recording needs an active ${baseUrlHost()} web login, sign in there, then Refresh`
          : '', { inline: !lock });
  // The empty-list dropzone repeats this gate in its own copy, so it repaints when the gate
  // moves. ONLY while it IS the dropzone: rebuilding real rows would drop their thumbnails.
  const attList = $('attachment-list');
  if (typeof renderAttachmentList === 'function' && attList && !attList.querySelector('.file-tile-item')) {
    renderAttachmentList();
  }
}

// ---- Attachments disclosure ----
// Open by default: the files on a result are what the tester came for, and a collapsed
// section reads as "nothing attached". Closing it is remembered for the panel session.
let attachmentsOpen = true;

function applyAttachmentsDisclosure() {
  const head = $('attachments-head');
  const body = $('attachments-body');
  if (head) head.setAttribute('aria-expanded', attachmentsOpen ? 'true' : 'false');
  if (body) body.hidden = !attachmentsOpen;
}

function toggleAttachmentsDisclosure() {
  attachmentsOpen = !attachmentsOpen;
  applyAttachmentsDisclosure();
}

// Through the same toggle a click uses, so aria-expanded and the memory stay coherent.
function openAttachmentsDisclosure() {
  if (!attachmentsOpen) toggleAttachmentsDisclosure();
}

// FAILED keeps the tester on the test to attach evidence, so open the section.
function expandAttachmentsForFailure() {
  openAttachmentsDisclosure();
}

// Runs AFTER the status write (#116): the meta keys hang off an id a not-yet-graded
// row only gets in that response, and nothing here may endanger a saved status.
async function writeEnvMeta(record, status) {
  if (!record?.id) return;
  // #152/#154: a locked result skips both. Scoped to the OPEN run (recordFor) — an
  // offline-queue replay into another, still-live run must keep writing its meta.
  const open = recordFor(record.id);
  if (open && typeof recordWriteLock === 'function' && recordWriteLock(open)) return;
  if (TestomatAPI.jwtAvailable() === false) return;
  const entries = await collectEnvMeta(state.settings);
  // The two toggles are independent: env-info OFF still lets the log key through.
  if (status === 'failed') {
    const url = await uploadEvidenceLog(record);
    if (url) entries.push(['Console & network log', url]);
  }
  if (!entries.length) return;
  try {
    await TestomatAPI.setTestrunMeta(record.id, entries);
  } catch { /* best effort — the status is already saved */ }
}

// Shared status-write core (test view + run-view rows). Needs no JWT — the v2
// token path — so it keeps working under login-blocked. Caller rolls back.
async function writeStatus(record, status, comment, onOptimistic, opts = {}) {
  syncBeginWrite(); // pause livesync ticks; force an immediate refetch when this settles
  try {
    const message = comment;
    if (record) Object.assign(record, { status, message });
    if (onOptimistic) onOptimistic();
    let saved;
    try {
      // e2e hook fires before the real request so the enqueue path runs deterministically.
      const forced = typeof OfflineQueue !== 'undefined' ? OfflineQueue.forcedError() : null;
      if (forced) throw forced;
      saved = await TestomatAPI.setStatus({
        testrunId: record?.id,
        runId: state.runId,
        testId: record?.test_id,
        status,
        message,
      });
    } catch (e) {
      // A queueable failure keeps the optimistic status and queues it — no rollback,
      // no toast. `noQueue` replays bypass this so a retry throws and stays queued.
      if (!opts.noQueue && record && record.id != null
          && typeof OfflineQueue !== 'undefined' && OfflineQueue.qualifies(e)) {
        await OfflineQueue.enqueue({ recordId: record.id, runId: state.runId, status, comment, queuedAt: Date.now() });
        return { queued: true };
      }
      throw e;
    }
    // The row always exists (opened by record id) and keeps its test_id.
    if (saved && record) Object.assign(record, saved, { test_id: record.test_id });
    // This status supersedes anything queued for the row, or the next replay writes
    // the older one back over it. Before writeEnvMeta and caught: never fatal.
    if (!opts.noQueue && record && record.id != null && typeof OfflineQueue !== 'undefined') {
      // The replay path removes its own entry comparing `queuedAt` — a second removal
      // here would drop a newer click that landed mid-drain.
      try { if (await OfflineQueue.remove(record.id)) OfflineQueue.refreshUI(); } catch { /* the status is saved */ }
    }
    await writeEnvMeta(record, status); // #116 — after the id exists, never fatal
    return saved;
  } finally {
    syncEndWrite();
  }
}

// The write's state as DATA on the line — `data-write` is what the panel and the
// e2e harness read back, instead of keying on the prose.
function setWriteState(kind) {
  const el = $('test-status');
  if (!el) return;
  if (kind) el.dataset.write = kind;
  else delete el.dataset.write;
}

async function clickStatus(status) {
  if (state.saving) return;
  const record = recordFor(state.currentRecordId);
  // #186: these controls are painted synchronously, so a click can land while the
  // run's archived answer is in flight. `state.saving` is claimed first — it is the guard.
  if (typeof awaitRunState === 'function' && typeof runStateProbe !== 'undefined' && runStateProbe) {
    state.saving = true;
    await awaitRunState();
    state.saving = false;
  }
  // #152/#154: covers the hotkeys too, which have no disabled state — a hotkey on
  // a locked result must no-op VISIBLY. Keyed on the RECORD (a mixed run).
  const lock = typeof recordWriteLock === 'function' ? recordWriteLock(record) : '';
  if (lock) {
    setStatusLine('test-status', lock, 'error');
    updateTestActionsState();
    return;
  }
  const prev = record ? { ...record } : null;
  const typed = $('test-comment').value.trim();
  // Leaving mid-write is possible, so every view-specific paint below is gated on
  // still being on THIS record. The write, mutation and rollback are NOT gated.
  const stillHere = () => String(state.currentRecordId) === String(record?.id);

  state.saving = true; // guard re-entrancy across the async env-info read below
  progressToast(`Saving ${status}…`);
  setWriteState('saving');
  try {
    const res = await writeStatus(record, status, typed, renderTestProgress);
    const queued = !!(res && res.queued);
    delete state.stepTicks[record?.id]; // leaving the test resets ticks
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
    if (!stillHere()) { hideToast(); return; } // tester already moved on — nothing left to paint here
    // Landed: the line says NOTHING (the verdict is already on three surfaces).
    setStatusLine('test-status', queued ? `${status} — queued offline, will sync when back online` : '', queued ? 'ok' : '');
    setWriteState(queued ? 'queued' : 'saved');
    // The controls below only apply once a row HAS a status, so the screen follows it.
    showTestSection('status');
    updateTestActionsState();
    renderSubstatus(record); // status changed -> offer that status's reply group
    renderSubstatusMark(record);
    applyAssigneeGate(record); // #153: status changed -> the row is no longer re-assignable
    if (!queued) refreshResultSummary(record); // #117: keep the summary card in step
    // #108: NO status navigates away — moving on is an explicit act ("Next test →"
    // or its hotkey). FAILED still surfaces the evidence controls it needs.
    if (status === 'failed') expandAttachmentsForFailure();
  } catch (e) {
    if (record && prev) Object.assign(record, prev);
    renderTestProgress();
    if (stillHere()) {
      setStatusLine('test-status', '', '');
      setWriteState('error'); // the words come from handleApiError below
      handleApiError(e, 'test-status', { inlineAuth: true }); // stay put on an expired session
      if (!isAuthError(e)) toast(`Status not saved: ${e.message}`, { error: true });
    } else {
      // Moved on: the inline line belongs to another test, so the toast is all that is left.
      toast(`Status not saved: ${e.message}`, { error: true });
    }
  } finally {
    state.saving = false;
  }
}

// The pager walks the VISIBLE sequence ±1, no wrap. Disabled and not hidden: an
// edge that removed a button would shift the two beside it.
function paintTestNav() {
  const pos = $('test-position');
  const prev = $('btn-prev-test');
  const next = $('btn-next-test');
  const order = visibleRecords();
  const at = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  // -1 = the open test is not in the visible set (a filter no longer matches it).
  if (pos) pos.textContent = at === -1 ? '' : `${at + 1} of ${order.length}`;
  if (prev) prev.disabled = at <= 0;
  if (next) next.disabled = at === -1 || at >= order.length - 1;
}

// Lands on the next still-untested VISIBLE row, never re-opening the current test:
// nothing untested left → back to the run view; only THIS one left → say so, stay.
function nextTest() {
  const order = orderedRecords();
  const from = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  for (let step = 1; step < order.length; step++) {
    const candidate = order[(from + step) % order.length];
    if (rowVisible(candidate) && displayStatus(candidate) === 'untested') {
      openTestView(candidate.id);
      return;
    }
  }
  const current = recordFor(state.currentRecordId);
  if (current && displayStatus(current) === 'untested') {
    toast('This is the last untested test');
    return;
  }
  toast('Run complete');
  openRunView(state.runId, state.runTitle);
}
