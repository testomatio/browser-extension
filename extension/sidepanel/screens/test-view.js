// Test view: render steps (tri-state or local checkboxes), example substitution,
// status writes, the priority icon, and the substatus dropdown.

/* global TestomatAPI, TestomatParams, marked, PriorityIcons, sanitizeHtml,
   renderPendingAnnotation, Skeleton, Sk, Tooltip, EmptyState, UserCell, Icons,
   ImgHydrate */

// Object-URL groups (shared/img-hydrate.js): the description's own images, the
// reported steps' screenshots, and the result's attached ones. Three, because
// each is repainted — and so has to be released — on its own occasion.
const IMG_GROUP_DESC = 'test-description';
const IMG_GROUP_SHOTS = 'summary-shots';
const IMG_GROUP_ATTS = 'result-attachments';

// ---------- test view ----------

async function openTestView(recordId) {
  if (capabilities.readonly) { show('test'); return; } // #155 — locked project
  const record = recordFor(recordId);
  if (!record) return;
  state.currentRecordId = record.id; // canonical id, even if called with a string
  state.testrunDetail = null;
  // …and the header holds the priority slot open until that read lands, instead
  // of drawing a mark it would have to change a round trip later (views.js).
  state.testDetailPending = true;
  state.currentSteps = [];
  // v2 pre-substitutes the title server-side for parametrized rows (verified
  // live: test_title = "Parametrized greeting Alice"); use it verbatim. Only the
  // description/steps arrive raw and need client substitution below (US2).
  // Written into state BEFORE the view is shown: the header row names the open
  // test now (Runs / <run> / <test>), and show() paints that row — a title set
  // after it would put the PREVIOUS test's name in the header for a frame.
  state.testTitle = record.test_title || `Test ${record.test_id}`;
  show('test');
  showTestSection('desc'); // every open starts on "what to do", never on the last test's section
  renderTestProgress();
  paintTestNav();          // the foot band's two moves, for THIS position in the list
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker(); // reflect a queued write on open
  $('test-title').textContent = state.testTitle;
  $('test-comment').value = record.message || '';
  $('test-steps').replaceChildren();
  ImgHydrate.release(IMG_GROUP_DESC); // #205 — the images that body was holding go with it
  // The line under the status buttons belongs to the WRITE — Saving… / queued
  // offline / the error — so opening a test clears the last one and says NOTHING
  // while the steps come in: the skeleton is already the whole screen saying it
  // is loading, and a second "Loading steps…" under it was that said twice. Only
  // a read that FAILS gets to speak here (handleApiError, below).
  setStatusLine('test-status', '');
  setWriteState('');
  if ($('example-badge')) $('example-badge').hidden = true; // reset per open
  if ($('test-substatus')) $('test-substatus').hidden = true;
  renderSubstatusMark(null); // never let the previous test's custom status linger
  if ($('test-assignee')) $('test-assignee').hidden = true;
  hideResultSummary(); // #117: never let the previous test's result flash here
  updateTestActionsState();
  renderAttachmentList(); // #107: never let the previous test's attachments linger
  renderPendingAnnotation(); // #192: a kept annotation is offered on its own record only
  applyAttachmentsDisclosure(); // re-apply the session-remembered disclosure state
  syncFullPageToggles();
  // The steps are the screen and they arrive last — the versioned text, then the
  // session probe, then the two JWT reads behind it.
  const sk = Skeleton.show('test');
  try {
    // Versioned steps from the testrun; fall back to the current TC text.
    let source = record.id ? await TestomatAPI.getTestrun(record.id) : null;
    if (!source?.description && record.test_id) source = await TestomatAPI.getTest(record.test_id);
    if (String(state.currentRecordId) !== String(record.id)) return; // moved on
    // Settle the session gate (and prefetch server step states) BEFORE rendering
    // so steps render once in the right mode — tri-state (JWT) vs v1 checkboxes.
    await probeSession(record.id);
    if (String(state.currentRecordId) !== String(record.id)) return;
    // run-replies power the substatus dropdown, project members the assignee
    // dropdown; both are JWT-only (cached). Fetched in parallel to avoid a serial
    // stall on the two best-effort JSON:API reads.
    if (capabilities.jwt) await Promise.all([loadProjectInfo(), loadProjectUsers()]);
    if (String(state.currentRecordId) !== String(record.id)) return;
    renderSteps(applyExample(source?.description || ''), record);
    renderResultSummary();  // #117: the already-reported result, above the controls
    renderPriority();       // JWT-only priority icon (FR-014)
    renderSubstatus(record);// substatus dropdown for the current status (US4)
    renderSubstatusMark(record); // …and its mark in the header card
    renderAssignee(record); // JWT-only assignee dropdown (M4)
    // #107: both need the settled session — the list reads the prefetched detail's
    // `attachments`, and the upload gate only knows it is degraded after the probe.
    renderAttachmentList();
    updateTestActionsState();
  } catch (e) {
    if (String(state.currentRecordId) === String(record.id)) handleApiError(e, 'test-status');
  } finally {
    // A read that FAILED must not leave the header pulsing at a slot that will
    // never be filled — and only for the test still open: a tester who has
    // already paged on is waiting on their own read, not this one.
    if (String(state.currentRecordId) === String(record.id) && state.testDetailPending) {
      state.testDetailPending = false;
      refreshContextBar();
    }
    Skeleton.hide(sk);
  }
}

// ---- the three sections of the screen (Description / Status / Summary) ----
// Which one is open belongs to the VIEW, not to the test: every open starts on
// Description (what to do), and a landed status write moves the tester on to
// Status — the comment / assignee / custom status / attachment controls that
// only make sense once there IS a result. Summary is the report ITSELF (the
// already-reported failure, environment meta, per-step outcome): facts to
// check, not a workflow step, so marking a result does not jump there.
// Remembering it per test would open a fresh test on a section describing
// another one.
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

// Top-level list items under a "Steps"-like heading are the steps; nested
// sub-bullets are NOT steps (their `Expected:` text folds into the parent —
// see parseSteps). Everything else stays plain markdown.
function stepListItems(container) {
  const headings = [...container.querySelectorAll('h1,h2,h3,h4')];
  const stepsHeading = headings.find((h) => /step|крок/i.test(h.textContent));
  if (!stepsHeading) return [];
  const items = [];
  let node = stepsHeading.nextElementSibling;
  while (node && !/^H[1-4]$/.test(node.tagName)) {
    if (node.tagName === 'UL' || node.tagName === 'OL') {
      items.push(...node.querySelectorAll(':scope > li')); // top-level only
    }
    node = node.nextElementSibling;
  }
  return items;
}

// `Expected:` is how the fixture writes it, `Expected Result:` is how a human
// does — and the second spelling used to miss the test below, leaving the
// sub-bullet in the row as a second flex item beside the step's own text (that
// is the two-column squeeze the steps list showed). Both, singular or plural.
const EXPECTED_LABEL = /^\s*expected(\s+results?)?\s*:/i;

// Pull nested `Expected:` sub-bullets out of a step <li> and return their text
// (FR-003). The sub-bullets are removed from the DOM so they never render as
// steps; a muted, non-interactive block replaces them. `pos` is snapshotted
// before removal (parseSteps) — the web still counts them.
function extractExpected(li) {
  const expected = [];
  li.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach((sub) => {
    if (EXPECTED_LABEL.test(sub.textContent)) {
      expected.push(sub.textContent.trim());
      const list = sub.parentElement;
      sub.remove();
      if (list && !list.querySelector(':scope > li')) list.remove();
    }
  });
  return expected.join('\n');
}

// The same fact, authored inline instead of as a sub-bullet: "Do X. **Expected
// Result**: Y." — the label bolded mid-sentence rather than its own <li>
// (extractExpected's shape). Split the label and everything after it off into
// its own block so it reads as a second line, not a run-on of the step text.
const INLINE_EXPECTED_LABEL = /^expected(\s+results?)?$/i;

function extractInlineExpected(li) {
  const nodes = [...li.childNodes];
  const idx = nodes.findIndex((n) => (
    n.nodeType === 1 && /^(strong|b)$/i.test(n.tagName) && INLINE_EXPECTED_LABEL.test(n.textContent.trim())
  ));
  if (idx < 0) return '';
  const tail = nodes.slice(idx);
  const text = tail.map((n) => n.textContent).join('').trim();
  tail.forEach((n) => n.remove());
  return text;
}

// A step's title = its own inline text, excluding any nested lists (which hold
// expected results / sub-notes). Used verbatim as the server step `title`.
function stepTitle(li) {
  const clone = li.cloneNode(true);
  clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
  return clone.textContent.trim();
}

// Parse the rendered markdown into the step model (T012). `pos` MUST match the
// web runner's step index: classical.js `stepEls` enumerates EVERY <li> of the
// rendered description (nested Expected bullets and non-step lists included),
// so pos = index among all <li>, snapshotted before extractExpected drops any.
// `index` stays the step ordinal (display only). The Expected sub-bullet folds
// into `expected`.
function parseSteps(container) {
  const allItems = [...container.querySelectorAll('li')];
  return stepListItems(container).map((li, idx) => {
    const pos = allItems.indexOf(li);
    const expected = extractExpected(li) || extractInlineExpected(li);
    const title = stepTitle(li);
    // A step row is CONTROL + BODY, and the body is a column: the step's own text,
    // then the expected result under it. The text has to be wrapped for that —
    // loose text in a flex row is an anonymous item, and an anonymous item is the
    // one thing a `min-width: 0` cannot be given, so the title and the expected
    // block used to divide the row between them and wrap at four words each.
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
    return { li, pos: pos < 0 ? idx : pos, index: idx, title, expected, state: 'unset', saving: false };
  });
}

// US2: substitute ${param}/{{param}} in the raw step markdown from the run's
// example row. Params + example values ride on the JSON:API testrun detail that
// probeSession prefetched (state.testrunDetail); v1's v2 description is
// unsubstituted, so substitution happens here. Title needs none — v2 already
// substitutes it server-side (FR-006). Returns the (possibly substituted) text
// and refreshes the "no example data" badge.
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

// Badge heuristic (FR-007): show "no example data" when the rendered description
// still carries a raw ${..}/{{..}} placeholder — i.e. substitution could not run.
//  - JWT on: params are known, so restrict the badge to a genuinely parametrized
//    test whose example row is absent (never flags a literal ${VAR} in a plain,
//    non-parametrized description).
//  - JWT off (degraded): params are unknown (JSON:API is down), so a raw
//    placeholder in the text is the only signal we have — treat it as an
//    unresolved parametrized test and show the badge.
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
  // A test with no description text at all: the Description tab said nothing
  // rather than showing a blank pane under a live "Loading…" that never lands.
  if (!markdownText || !markdownText.trim()) {
    EmptyState.into(box, {
      icon: 'description',
      title: 'No description',
      text: 'This test has no steps to run through — the status buttons above still work.',
    });
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = marked.parse(markdownText, { async: false });
  sanitizeHtml(tmp); // shared/html-sanitize.js — the XSS boundary, one copy
  // …then the images, BEFORE the body reaches the document: the CSP allows no
  // remote <img> and a root-relative one would resolve against the extension
  // (#205). Detached, so nothing is ever requested with the raw src.
  ImgHydrate.hydrate(IMG_GROUP_DESC, tmp);

  state.currentSteps = parseSteps(tmp);
  box.append(...tmp.childNodes);
  applyStepMode(record); // tri-state (JWT) vs v1 local checkboxes (degraded)
}

// JWT available => server-synced tri-state; otherwise the v1 local checkboxes.
function applyStepMode(record) {
  if (capabilities.jwt && record?.id) renderTriState(record);
  else renderLocalCheckboxes(record);
}

// ---- v1 local checkboxes (degraded mode, unchanged behavior) ----
// Ticks are keyed by testrun record id so two example rows of one parametrized
// test keep independent local state, and by step ordinal (never the server
// `pos`) — these ticks are local-only and survive across sessions.
function renderLocalCheckboxes(record) {
  const key = record.id;
  const ticks = state.stepTicks[key] || {};
  for (const s of state.currentSteps) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'checkbox';
    cb.checked = !!ticks[s.index];
    if (cb.checked) s.li.classList.add('done');
    cb.addEventListener('change', () => {
      const t = state.stepTicks[key] || (state.stepTicks[key] = {});
      if (cb.checked) t[s.index] = true; else delete t[s.index];
      s.li.classList.toggle('done', cb.checked);
      persistSession();
    });
    s.li.prepend(cb);
  }
}

// ---- tri-state server-synced steps (T013/T014) ----
// Cycle mirrors the web runner (manual-run.js `setStepStatus`, ~1153-1180):
// options are [passed, failed, skipped] and next = options[(idx+1) % 3] with
// idx=-1 for an unset step. The web performs NO unset write for steps, so a
// step cannot be clicked back to unset — first click => passed, then a pure
// 3-cycle passed -> failed -> skipped -> passed.
const STEP_OPTIONS = ['passed', 'failed', 'skipped'];
// Step marks, from the panel's one icon set. `unset` is the caller's choice: the
// tri-state control is already a hollow ring, so it draws nothing inside it (an ○
// there only doubled the circle), while the summary dot draws the ring itself.
const STEP_ICON = { passed: 'check', failed: 'close', skipped: 'remove' };

// Paint one step mark into `el` (a ring button, or the summary dot).
function paintStepMark(el, status, size, unset = '') {
  const name = STEP_ICON[status] || unset;
  el.replaceChildren(...(name ? [svgIcon(name, size)] : []));
}

// Overlay server step states onto the parsed steps, matched by `pos`
// (contract: GET .../steps is unsorted; unmatched/stale-pos entries ignored).
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
  s.ctrl.setAttribute('aria-label', `step ${s.index + 1}: ${s.state}`); // ordinal, not the web `pos`
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

// Writes are serialized like the web runner (setStepStatus `enqueue: true`) so
// concurrent clicks on different steps don't race the server's read-modify-write
// of the steps JSON column.
let stepWriteChain = Promise.resolve();

function cycleStep(s, record) {
  if (s.saving) return;
  // #152/#154 — the circles are disabled, this catches the race. An automated
  // testrun is the sharper case: `Testrun#add_step!` returns early there while
  // still answering 200, so an ungated click would paint a state the server
  // never stored.
  if (recordWriteLock(record)) return;
  const prev = s.state;
  const next = STEP_OPTIONS[(STEP_OPTIONS.indexOf(prev) + 1) % STEP_OPTIONS.length];
  s.state = next;          // optimistic (FR-004)
  paintStep(s);
  s.saving = true;
  const run = async () => {
    try {
      // Client enforces the enum; `next` is always one of STEP_OPTIONS.
      await TestomatAPI.setStep(record.id, { title: s.title, status: next, pos: s.pos });
    } catch (e) {
      s.state = prev;      // rollback + toast (FR-004)
      paintStep(s);
      toast(`Step not saved: ${e.message}`, { error: true });
    } finally {
      s.saving = false;
    }
  };
  stepWriteChain = stepWriteChain.then(run, run);
}

// Priority icon (FR-014). Unified on the shared MDI set (PriorityIcons) so the
// run row reads the same as the editor: low = down, normal = circle, high = up,
// important = double-up, critical = flag. Priority is JWT-only — it rides on the
// JSON:API testrun detail (test.priority); the v2 list record omits it, so
// degraded mode shows no icon.
// Priority is drawn in the HEADER row now, at the head of the test's name and to
// the left of its type mark — the two marks a list row already opens with, in
// the order it opens with them (contextTitleMarks, core/views.js). It rides the
// JSON:API detail, which lands after that row was first painted, so all this
// screen owes it is: say the read is in, and repaint the row.
function renderPriority() {
  state.testDetailPending = false;
  refreshContextBar();
}

// The custom status (#109) as a MARK in the same row — read-only, the way the
// run rows wear it: it is written by the select in the Test result tab, and this
// is what says the write landed. Tinted by the row's own status, not by the
// value (the pill's rule), and JWT-gated exactly like the select that fills it,
// so basic mode shows nothing rather than a chip that can never change.
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

// ---- result summary (#117) ----------------------------------------------
// What the run ALREADY reported for this test, mirroring the web Summary panel
// (front app/components/report/test-results-display.hbs): a status + duration
// line, then Failure / Meta / Steps disclosures. The web's Stacktrace section is
// deliberately NOT rendered here (owner-approved scope) even when the detail says
// one exists — the panel is a marking tool, not a log reader.
//
// Everything rides on the JSON:API testrun detail probeSession already prefetched
// (state.testrunDetail), so this is JWT-only: in basic mode there is no detail and
// the whole block stays hidden, exactly like the priority icon. Attribute keys are
// DASHERIZED there (`run-time`), and two fields need care (verified live on prod,
// TestrunSerializer):
//   * `steps` is serialized ONLY for a manual testrun; an automated one carries
//     `sections.steps.count` instead and its steps come from the lazy
//     GET /testruns/{id}/steps (the same route the web fetches on expand),
//   * Meta is `extras` minus the system-source entries — the web's `metafields`.
//     The `meta` attribute is a project-template STRING, not the entry list.
//
// Rendered once per open from the prefetch; a status the tester then writes is
// folded in locally by refreshResultSummary() rather than costing a re-read.

// Which disclosures are open, remembered for the panel session like the
// Attachments one. Failure starts open (it is the reason to look), the rest shut.
const summaryOpen = { failure: true, meta: false, steps: false };

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };
// Which tint the verdict chip takes — the run header's own map (RUN_STATE_TINT),
// spelled here for the test's three statuses; anything else is neutral.
const TEST_STATE_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

// The reported steps of the open testrun and the in-flight lazy fetch — both
// per-open state, cleared by hideResultSummary.
let summarySteps = null;
let summaryStepsFetch = null;

// pretty-ms parity for the durations the web prints (helpers/duration-to-human):
// sub-second in ms, then one decimal second (18400 -> "18.4s"), then m/h pairs.
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

// The Summary tab with nothing to show: an EmptyState in place of the accordion
// rather than a tab that opens on a blank pane. Two ways to get here, and they
// are not the same fact — one is "mark it and this fills in", the other is "it
// IS marked, and the run simply carried nothing behind the verdict" (a manual
// pass with no comment is the ordinary case). `kind` is 'unreported' | 'bare',
// or a falsy value to clear.
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

// The dot on the Summary segment says "there is something under this one",
// tinted by the reported status. Driven by what the tab actually HOLDS, not by
// the mere existence of a verdict: a marked test whose summary is empty would
// otherwise wear a dot promising a pane that opens on nothing.
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
  if ($('summary-meta-body')) $('summary-meta-body').replaceChildren();
  if ($('summary-steps-body')) $('summary-steps-body').replaceChildren();
  summarySteps = null;
  summaryStepsFetch = null;
  // #202: the step thumbnails go with the steps — close the lightbox before the
  // blob URLs it may be showing are revoked.
  closeShotModal();
  ImgHydrate.release(IMG_GROUP_SHOTS);
  syncSummaryStepsTools();
}

// Apply the remembered open/closed state to one disclosure (head + body).
function paintSummaryDisclosure(key) {
  const head = $(`summary-${key}-head`);
  const body = $(`summary-${key}-body`);
  const open = !!summaryOpen[key];
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
  if (key === 'steps') syncSummaryStepsTools(); // #202 — Expand all / Collapse all ride the section
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
  // "Reported" = a real terminal status (the web's `hasStatus`). No detail (basic
  // mode) or a still-pending row => no summary at all.
  if (!attrs || !status || status === 'pending') { hideResultSummary(); return; }
  if ($('test-result-row')) $('test-result-row').hidden = false;
  const label = STATUS_LABEL[status] || status;
  // The verdict is the library's `.status-label` chip — the glyph with its word,
  // the same chip (and the same statusIcon call) the run header wears one screen
  // up. It used to be a coloured word behind a dot, which made a fourth spelling
  // of a status this panel already had three forms of. `data-status` stays: it
  // is the machine-readable value a script asks the element for.
  const el = $('summary-status');
  el.className = `status-label ${TEST_STATE_TINT[normStatus(status)] || 'neutral'}`;
  el.dataset.status = status;
  const word = document.createElement('span');
  word.textContent = label;
  el.replaceChildren(statusIcon(status), word);
  const dur = humanDuration(attrs['run-time']);
  $('summary-duration').textContent = dur ? `· ${dur}` : '';
  renderSummaryFailure(attrs);
  renderSummaryMeta(attrs);
  renderSummaryStepsSection(attrs);
  // Each of the three hides its own block when it has nothing, so "all three
  // hidden" is the accordion standing empty — which a marked test reaches often
  // (a manual pass with no comment carries no message, no meta and no steps).
  // The verdict is already up in the header, so what belongs in the pane is the
  // empty state, not an accordion with no rows in it.
  const filled = ['summary-failure', 'summary-meta', 'summary-steps']
    .some((id) => $(id) && !$(id).hidden);
  box.hidden = !filled;
  paintSummaryEmpty(filled ? '' : 'bare');
  paintSectionMark(filled ? normStatus(status) : '');
}

// A landed status write makes the card stale — and a summary reading "● Passed"
// above a status line reading "failed ✓" is a lie, so the two are kept in step.
// `status` and `message` are the ONLY fields the panel can change, so they are
// patched into the prefetched detail and the card repainted: no re-read, and the
// same single render path. A write that only got QUEUED offline is deliberately
// left out — nothing was reported yet, and its status line says so.
function refreshResultSummary(record) {
  const attrs = state.testrunDetail?.data?.attributes;
  if (!attrs || !record) return;
  attrs.status = record.status;
  attrs.message = record.message || '';
  renderResultSummary();
}

// The message box. Title mirrors the web: "Failure" on a failed result, "Log"
// otherwise; the panel it sits in is tinted red / green the same way. Rendering
// also mirrors the web, and the split matters: a reporter (automated) message is
// assertion output whose newlines and indentation ARE the information, so it is
// printed verbatim as text (pre-wrap, no markdown pass); a manual message — every
// message the panel itself writes — is Markdown and goes through marked + the
// shared sanitizer, the same XSS boundary the steps use.
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
    const tmp = document.createElement('div');
    tmp.innerHTML = marked.parse(message, { async: false });
    sanitizeHtml(tmp); // shared/html-sanitize.js — the one XSS boundary
    // `.sections`, like the steps body above it: a message rendered inside the
    // panel's own chrome is a blob in a screen, not an article, so a heading in it
    // is a muted label and the screen's headings stay the screen's
    // (shared/components.css MARKDOWN).
    out.classList.add('markdown', 'sections');
    out.append(...tmp.childNodes);
  }
  paintSummaryDisclosure('failure');
}

// Meta = the testrun's non-system extras (web `metafields`): the reporter's
// `meta:{}` keys and anything typed into the web's Meta editor. The system
// entries (change/duration/substatus/testlink) are bookkeeping, never shown.
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

// Steps section. A manual testrun ships its steps inline on the detail; an
// automated one only advertises `sections.steps.count`, so the section renders
// with the count and the list is fetched on first expand — the web's behaviour.
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

// Lazy read of an automated testrun's steps. Same route the web uses
// (GET /testruns/{id}/steps -> { steps: [...] }); best-effort — a failure leaves
// a muted line instead of an error, the summary is never the tester's blocker.
async function loadSummarySteps() {
  const body = $('summary-steps-body');
  if (!body || summarySteps || summaryStepsFetch) return;
  const recordId = state.currentRecordId;
  if (!recordId) return;
  // The disclosure is already open and standing empty, so this one is drawn at
  // once rather than armed: there is no screen behind it for a placeholder to
  // flash over — a `.sk-lines` group is what opens, and the steps replace it.
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

// ---- reported steps: web-report parity (#202) -----------------------------
// The reported step payload is richer than `{title,status,duration,error,steps}`
// — `category`, `log` and `attachments` ride along too, and the web report
// (front nested-steps.js) consumes all of them. Field notes from the live
// contract (verified on prod, Api::TestrunsController#steps / #presign_step):
//   * `log` is stored and echoed verbatim, on BOTH the manual inline steps and
//     the lazy automated route.
//   * `attachments` exist ONLY on GET /testruns/{id}/steps: the reporter posts
//     `artifacts: [key]` and the server presigns each into
//     `{artifact,url,name,preview,display_url,type,public,needs_presign}`.
//     The manual step route permits only [status,title,message,pos], so a manual
//     step can never carry one.
//   * `duration` comes back as a STRING there ("900") — humanDuration coerces.

// Web parity, front nested-steps.js `steps` getter: one node per reported step,
// children = its sub-steps, plus an "Attachments" group node appended under any
// step that carries attachments (the parent's own list is nulled and the step is
// flagged `isImage`, so the group is the single place they render). The web's
// truthiness check is kept as a LENGTH check — an empty array would otherwise
// grow an empty group.
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

// Default expansion mirrors the web: `expandAll` there is
// `localStorage.getItem('expand-all-steps') === 'true'`, i.e. COLLAPSED until the
// tester asks for more — with Expand all / Collapse all on the section, and the
// choice sticky (per panel session here, like every other disclosure state).
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

// Web `isImage`: trust the server-derived MIME type, fall back to the name only
// when the payload carries none. SVG is excluded there and here.
function isImageAttachment(a) {
  const type = String(a?.type || '');
  if (type) return type.startsWith('image/') && !/svg/i.test(type);
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(String(a?.name || a?.url || ''));
}

// e2e-only: `stepShotHook` in chrome.storage.session (the stepRecCap /
// siteAccessHook precedent) redirects a thumbnail fetch to <hook>/<attachment
// name>. Real artifact URLs are presigned bucket links the harness cannot mint,
// so the hook swaps only the HOST — the panel still resolves the target from the
// attachment payload and still runs the whole fetch -> blob -> <img> path.
async function shotHookBase() {
  if (!hasChrome || !chrome.storage?.session) return '';
  try { return (await chrome.storage.session.get('stepShotHook')).stepShotHook || ''; } catch { return ''; }
}

// Which URL on an attachment payload is the one to SHOW. `display_url` is the
// product's own inline form (a presigned bucket link that needs no session);
// `url` is the app-host route behind the login, which fetchAsset carries the JWT
// to. The e2e hook wins over both — see shotHookBase.
async function attachmentSrc(att) {
  const base = await shotHookBase();
  if (base) return new URL(att?.name || '', base).toString();
  return att?.display_url || att?.url || '';
}

// A name link, the shape every non-image attachment takes (and the fallback for
// an image whose bytes never arrived).
function attachmentLink(att) {
  const el = document.createElement(att?.url ? 'a' : 'span');
  el.className = 'summary-step-att-link';
  if (att?.url) { el.href = att.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
  el.textContent = att?.name || 'attachment';
  el.title = el.textContent;
  return el;
}

// THE thumbnail — one builder for both places the panel shows an attached image:
// a reported step's screenshot (#202) and a file on the result's own list
// (#205). Button + <img>, the bytes fetched through shared/img-hydrate.js
// (CSP img-src carries no `https:` by design, #175, and is not widened), the
// lightbox on click, and the CALLER's own row shape when the fetch fails — CORS
// on the artifact host, an expired presign, a panel with no session, an offline
// one. Never a broken-image box.
function attachmentThumb(group, att, onFail) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'attachment-thumb';
  btn.title = `${att?.name || 'screenshot'} — click to enlarge`;
  const img = document.createElement('img');
  img.alt = att?.name || 'screenshot';
  btn.append(img);
  btn.addEventListener('click', () => openShotModal(img.src, att?.name || '', btn));
  attachmentSrc(att)
    .then((src) => ImgHydrate.load(group, src, img))
    .then((ok) => { if (!ok) onFail(btn); })
    .catch(() => onFail(btn)); // never leave an empty frame standing
  return btn;
}

function summaryAttachment(att) {
  if (!isImageAttachment(att)) return attachmentLink(att);
  return attachmentThumb(IMG_GROUP_SHOTS, att, (el) => el.replaceWith(attachmentLink(att)));
}

// The marker the web puts on a step that carries attachments (its
// `file-image-outline`), drawn from the panel's one icon set — the same glyph
// the Attach screenshot button wears, so the two read as the same thing.
function imageMarker() {
  return svgIcon('photo_camera', 13, 'summary-step-marker');
}

// One reported step: the collapse toggle, status glyph, monospace title, the
// coloured status word, duration, the step's own error line, its log block, and
// its children (sub-steps + the Attachments group) in a container the toggle
// hides. An Attachments group node renders NO step row — the web skips it the
// same way (`{{#unless node.model.attachments}}`) and shows only the files.
function summaryStepNode(node) {
  const group = document.createElement('div');
  group.className = 'summary-step-group';
  if (node?.attachments) {
    group.classList.add('summary-step-atts');
    for (const att of node.attachments) group.append(summaryAttachment(att));
    return group;
  }
  const row = document.createElement('div');
  row.className = 'summary-step';
  const kids = node?.children?.length ? document.createElement('div') : null;
  if (kids) {
    // Same chevron every collapsible row in the panel opens with (the disclosure
    // caret, the tree rows) — CSS rotates it 90° on aria-expanded.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn icon size-xs summary-step-toggle';
    toggle.append(svgIcon(CHEVRON_ICON, 14));
    const paint = (open) => {
      kids.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      Tooltip.set(toggle, open ? 'Collapse' : 'Expand');
    };
    paint(summaryStepsExpanded);
    toggle.addEventListener('click', () => paint(kids.hidden));
    row.append(toggle);
  }
  const dot = document.createElement('span');
  dot.className = 'summary-step-dot';
  dot.dataset.status = node?.status || '';
  paintStepMark(dot, node?.status, 14, 'radio_button_unchecked');
  const title = document.createElement('span');
  title.className = 'summary-step-title';
  title.textContent = node?.name || '(untitled step)';
  row.append(dot, title);
  if (node?.isImage) title.append(' ', imageMarker());
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
  group.append(row);
  if (node?.error) {
    const err = document.createElement('div');
    err.className = 'summary-step-error';
    err.textContent = String(node.error);
    group.append(err);
  }
  // The log hangs off the step itself, NOT off its children — so it stays
  // readable while the sub-steps are collapsed, exactly as the web renders it.
  if (node?.log) {
    const log = document.createElement('div');
    log.className = `summary-step-log${node.error ? ' is-failed' : ''}`;
    linkifyInto(log, String(node.log).trim());
    group.append(log);
  }
  if (kids) {
    kids.className = 'summary-step-kids';
    kids.hidden = !summaryStepsExpanded;
    for (const child of node.children) kids.append(summaryStepNode(child));
    group.append(kids);
  }
  return group;
}

// Expand all / Collapse all, the web's two controls on the steps box. Created
// lazily next to the disclosure head (absolutely placed on its right, like the
// web's), so no extra wiring is needed in app.js.
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

// The controls belong to an OPEN section with steps in it; anything else hides them.
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
    // Inside an already-open disclosure, so compact: the section is a few rows
    // tall and a centred block would push the rest of the test view off screen.
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

// ---- screenshot lightbox (#202) ------------------------------------------
// Owner decision: a modal over the panel, not a new tab. Native <dialog> like the
// finish-run confirm — Esc comes free (the `cancel` event), the backdrop is a
// click on the dialog element itself, and focus returns to the thumbnail that
// opened it.
let shotModalWired = false;
let shotModalOpener = null;

function wireShotModal(dlg) {
  if (shotModalWired) return;
  shotModalWired = true;
  dlg.addEventListener('close', () => {
    const opener = shotModalOpener;
    shotModalOpener = null;
    // Deferred on purpose: <dialog>'s own focus fixup runs around the close
    // event, so focusing INTO it loses the race and lands the caret on <body>.
    if (opener && opener.isConnected) setTimeout(() => opener.focus(), 0);
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
  const close = $('shot-modal-close');
  if (close) close.addEventListener('click', () => dlg.close());
}

function openShotModal(src, name, opener) {
  const dlg = $('shot-modal');
  const img = $('shot-modal-img');
  if (!dlg || !img || !src) return;
  wireShotModal(dlg);
  img.src = src;
  img.alt = name || 'screenshot';
  const cap = $('shot-modal-name');
  if (cap) cap.textContent = name || '';
  shotModalOpener = opener || null;
  dlg.showModal();
}

function closeShotModal() {
  const dlg = $('shot-modal');
  if (dlg && dlg.open) dlg.close();
  const img = $('shot-modal-img');
  if (img) img.removeAttribute('src'); // never point at a revoked blob
}

// Substatus dropdown (US4/FR-009). Shown only under JWT once the row has a real
// status AND the project defines replies for that status; otherwise absent. The
// current value is reflected from the v2 record's `substatus` (echoed read-only).
function renderSubstatus(record) {
  const wrap = $('test-substatus');
  const sel = $('substatus-select');
  if (!wrap || !sel) return;
  const status = record?.status;
  const group = runRepliesFor(status);
  const show = capabilities.jwt && !!record?.id && !!status && status !== 'pending' && group.length > 0;
  wrap.hidden = !show;
  if (!show) { sel.replaceChildren(); return; }
  sel.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.append(none);
  for (const r of group) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r;
    sel.append(o);
  }
  sel.value = group.includes(record.substatus) ? record.substatus : '';
}

// Assignee dropdown (M4 → custom listbox). JWT-only — hidden in basic mode
// exactly like priority (the write and the people list both need the session).
// Options are the project members + Unassigned; the current value is resolved
// from the record's `assigned_to` (an email on the v2 read — R8) back to the
// member id.
//
// A CUSTOM dropdown, not a <select> — the same call the project switcher made
// (#126): a native popup can only print plain option text, and this control
// needs a monogram per row plus a type-to-filter box, neither of which fits
// inside an OS-drawn menu once a project has more than a couple of members.
// `assignee-trigger` carries `dataset.userId` the way the project trigger
// carries `dataset.projectId` — the machine-readable value a script reads,
// since there is no `.value` to ask a button for.
//
// Single-select, on purpose: the v2 read this panel polls on (assignedUserId,
// below) folds a testrun's assignee down to ONE email, so anything this
// control let stick beyond one person would be silently unpicked by the very
// next sync tick. A row's monogram earns it the custom popup; it does not
// change what the field can hold.
let assigneeFilter = '';
let assigneeActiveId = null;

// The rows the dropdown offers for the current filter: Unassigned, then every
// project member, matched on name AND email.
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

// The closed-state label: the current assignee's `.user-cell` (monogram +
// name, shared/user-cell.js), or the person glyph + "Unassigned".
function paintAssigneeTrigger(record) {
  const trigger = $('assignee-trigger');
  const valueSlot = $('assignee-value');
  if (!trigger || !valueSlot) return;
  const id = assignedUserId(record);
  trigger.dataset.userId = id;
  const user = id ? (usersList || []).find((u) => String(u.id) === id) : null;
  valueSlot.replaceChildren(user ? UserCell.cell(user) : unassignedCell());
}

// The "Unassigned" row/label: same `.user-cell` shape as a real person, so it
// sits in the same column instead of reading as a stray line of text.
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

// Open-state keys are handled at document level (capture) so they work
// wherever focus sits, same as the project dropdown.
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

// Wire the dropdown once, from app init (the markup is static) — mirrors
// initProjectDropdown().
function initAssigneeDropdown() {
  $('assignee-trigger').addEventListener('click', onAssigneeTriggerClick);
  $('assignee-trigger').addEventListener('keydown', onAssigneeTriggerKey);
  $('assignee-filter').addEventListener('input', onAssigneeFilterInput);
}

// ---- assignee gate (#153) -------------------------------------------------
// Web parity: `AssignTo @disabled={{this.node.testRun.hasStatus}}` with exactly
// this tooltip (manual-run.hbs). `hasStatus` is `status && status !== 'pending'`,
// which is what displayStatus() already folds into 'untested' here — so an
// unassigned-or-pending row stays assignable and a graded one does not. The
// server accepts the write regardless (no check on its side), so the panel IS
// the gate, same as the finished-run lock.
//
// Deliberately independent of that lock (#152): a finished run does NOT gate
// assignee by itself — but its rows almost all carry a status, so they fall
// under THIS gate anyway, and each keeps its own honest reason.
const ASSIGN_GATE_REASON = "Can't re-assign already marked test";

function assigneeGateReason(record) {
  if (!record) return '';
  return displayStatus(record) === 'untested' ? '' : ASSIGN_GATE_REASON;
}

// Paint the gate onto the trigger + its inline reason. A hover-only tooltip is
// invisible on touch, so the reason is shown inline too (the applyActionGate
// pattern; that helper is button-shaped, and now so is this control).
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

// Map a record's assignee (email, v2 read shape) back to the member id for the
// dropdown value; '' when unassigned or unresolvable.
function assignedUserId(record) {
  const email = record?.assigned_to;
  if (!email) return '';
  const u = (usersList || []).find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase());
  return u ? String(u.id) : '';
}

// Brief green-ring confirmation on the trigger once the assign write lands.
function flashAssignee() {
  const trigger = $('assignee-trigger');
  if (!trigger) return;
  trigger.classList.remove('saved-flash');
  void trigger.offsetWidth; // reflow → restart the animation
  trigger.classList.add('saved-flash');
  setTimeout(() => trigger.classList.remove('saved-flash'), 1000);
}

// Optimistic assign/unassign with rollback + toast. Per-control busy (the
// trigger disables while in flight); serialized like substatus (a change
// mid-write is ignored and re-synced). The optimistic value is the chosen
// member's EMAIL — the shape the v2 read echoes — so the immediate refetch
// finds no diff (no self-toast). The read-only run-view row chip is repainted
// in place so Back shows it already.
let assignWriting = false;
async function onAssigneeChange(value) {
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return;
  if (assignWriting) { paintAssigneeTrigger(record); return; } // ignore + re-sync
  // #153: the trigger is already disabled when the row carries a result, so
  // this only catches a race (a status landed between the paint and the pick —
  // our own write, a colleague's poll tick). Re-sync the value and paint the
  // gate, so the refusal is explained rather than silent.
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
    // Not a bare `disabled = false`: a status may have landed while the assign
    // was in flight, and re-enabling past the #153 gate would undo it.
    applyAssigneeGate(record);
    syncEndWrite();
  }
}

// Optimistic substatus write with rollback + toast. Empty option clears via
// DELETE. The server's auto `change` audit extra is expected, never an error.
// Concurrent changes are serialized (Block 4): a change while a write is in flight
// is ignored and the select is re-synced to the record's state; an expired session
// shows the inline "Session expired" line instead of teleporting to Settings.
let substatusWriting = false;
async function onSubstatusChange() {
  const sel = $('substatus-select');
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return;
  if (substatusWriting) { sel.value = record.substatus || ''; return; }    // ignore + re-sync
  if (recordWriteLock(record)) { sel.value = record.substatus || ''; return; } // #152/#154 — locked, re-sync
  const value = sel.value;
  const prev = record.substatus || '';
  if (value === prev) return;
  substatusWriting = true;
  syncBeginWrite();
  record.substatus = value; // optimistic
  renderSubstatusMark(record); // …and so is its mark in the header card
  try {
    if (value) await TestomatAPI.setSubstatus(record.id, value);
    else await TestomatAPI.clearSubstatus(record.id);
  } catch (e) {
    record.substatus = prev;
    sel.value = prev;
    renderSubstatusMark(record);
    if (isAuthError(e)) setAuthExpiredLine('test-status');
    else toast(`Custom status not saved: ${e.message}`, { error: true });
  } finally {
    substatusWriting = false;
    syncEndWrite();
  }
}

// ---- full-page capture toggle (M2 PR-3) ----
// The "Full page" checkbox sits next to the test view's screenshot button and is
// persisted in settings (default false). Every capture path reads
// fullPageCaptureEnabled(); the second home it used to have (quick capture) went
// away with that screen.
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

// Render a gate onto a button + its inline reason paragraph. A hover-only tooltip
// is invisible on touch, so the reason is always shown inline as well. The
// button's own tooltip (a hotkey hint, say) is remembered once and restored when
// the gate lifts.
function applyActionGate(btnId, reasonId, msg) {
  const btn = $(btnId);
  if (!btn) return;
  if (btn.dataset.baseTip === undefined) btn.dataset.baseTip = Tooltip.get(btn);
  btn.disabled = !!msg;
  Tooltip.set(btn, msg || btn.dataset.baseTip);
  const reason = $(reasonId);
  if (reason) { reason.textContent = msg || ''; reason.hidden = !msg; }
}

// The three status buttons double as the result display: at rest they are
// outline (border + text only, none of them shouting), and the one that
// matches the record's current status takes the `.solid` fill — the same
// "this is the answer that was given" state components.css defines for
// STATUS buttons. Runs on every open, write and poll through
// updateTestActionsState.
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
  // #152/#154: a finished run — or an automated result — is read-only, and that
  // outranks every other gate here: "no saved result yet" invites a click that
  // can no longer create one. Per RECORD since #154, so the manual rows of a
  // mixed run open with every control live.
  const lock = typeof recordWriteLock === 'function' ? recordWriteLock(record) : '';
  // The three status buttons share ONE reason paragraph (they are one control in
  // three parts), so they are gated together rather than through applyActionGate.
  for (const id of ['btn-passed', 'btn-failed', 'btn-skipped']) applyActionGate(id, null, lock);
  const lockNote = $('status-lock-reason');
  if (lockNote) { lockNote.textContent = lock; lockNote.hidden = !lock; }
  paintStatusButtons(record?.status);
  // The comment rides the status write, so a locked run has nothing to do with
  // the text: read what is there, type nothing new.
  const comment = $('test-comment');
  if (comment) { comment.disabled = !!lock; Tooltip.set(comment, lock); }
  // Tri-state step circles write straight to the server (add_step) — same lock.
  // The v1 local checkboxes (basic mode) are local-only ticks and stay live.
  document.querySelectorAll('#test-steps .step-state').forEach((b) => {
    b.disabled = !!lock;
    Tooltip.set(b, lock);
  });
  // Substatus is a testrun_extras write; the select stays visible (the value is
  // worth reading) and simply refuses to change. Assignee is deliberately NOT
  // gated here — it is workflow metadata, tracked separately (#153).
  const substatus = $('substatus-select');
  if (substatus) { substatus.disabled = !!lock; Tooltip.set(substatus, lock); }
  // Both attach buttons share one gate: a missing result record id (evidence
  // attaches to a SAVED testrun result), NOT the status — a row can already carry
  // an id while still pending.
  const noResult = !record?.id;
  // #107: local-file upload is JWT-only like every other upload, so a PROVEN
  // degraded session disables it with the same wording the Finish-run gate uses
  // ('unknown' is still probing — never gate on that). #152 gave the screenshot
  // flow the same gate: it rides the very same JWT multipart upload, and used to
  // fail at the end of a capture instead of saying so up front.
  const degraded = TestomatAPI.jwtAvailable() === false;
  applyActionGate('btn-screenshot-annotate', 'screenshot-reason',
    lock ? lock
      : noResult ? 'No saved result yet — screenshots attach to a test result'
        : degraded ? `Attaching screenshots needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
          : '');
  applyActionGate('btn-attach-file', 'attach-file-reason',
    lock ? lock
      : noResult ? 'No saved result yet — files attach to a test result'
        : degraded ? `Attaching files needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
          : '');
}

// ---- Attachments & log disclosure (control-tower diet) ----
// Collapsed by default; the expanded state is remembered in memory for the
// session (module-level, reset on panel reload) and re-applied on every open.
let attachmentsOpen = false;

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

// A FAILED status keeps the tester on the test precisely to attach evidence, so
// open the disclosure for them — through the same toggle a click uses, so
// aria-expanded and the session memory stay coherent. One-way: an already-open
// (or deliberately re-collapsed) section is never fought.
function expandAttachmentsForFailure() {
  if (!attachmentsOpen) toggleAttachmentsDisclosure();
}

// Env facts + the evidence log link as testrun META keys (#116). They used to be
// appended to the FAILED comment; the Failure box now holds only what the tester
// typed, and Browser / OS / Viewport / URL / «Console & network log» land in the
// web test detail's own Meta section instead.
//
// Runs AFTER the status write, for two reasons: the meta keys hang off a testrun
// id that a not-yet-graded row only receives in the status response, and nothing
// here may endanger a status that already saved. So every failure is swallowed —
// worst case the result is saved without its meta.
//
// JWT-only, exactly like substatus: `writeStatus` itself rides the v2 token path
// and must keep working under login-blocked (US6), so a PROVEN-degraded session
// skips the whole block rather than throwing through it.
async function writeEnvMeta(record, status) {
  if (!record?.id) return;
  // #152/#154: env meta and the evidence log are side effects of a status write,
  // so a locked result silently skips both — the write they belong to can no
  // longer happen, and there is nothing here worth its own error. Scoped to the
  // OPEN run's records (recordFor): an offline-queue replay into another,
  // still-live run must keep writing its meta.
  const open = recordFor(record.id);
  if (open && typeof recordWriteLock === 'function' && recordWriteLock(open)) return;
  if (TestomatAPI.jwtAvailable() === false) return;
  const entries = await collectEnvMeta(state.settings);
  // The log stays a FAILED-only artifact (its own auto-attach toggle, its own
  // recorder gate) — only its destination moved. The two toggles are independent:
  // env-info OFF still lets the log key through, and vice versa.
  if (status === 'failed') {
    const url = await uploadEvidenceLog(record);
    if (url) entries.push(['Console & network log', url]);
  }
  if (!entries.length) return;
  try {
    await TestomatAPI.setTestrunMeta(record.id, entries);
  } catch { /* best effort — the status is already saved */ }
}

// Shared status-write core — extracted from clickStatus (checklist mode design)
// and reused by the run-view row buttons. Applies the optimistic record mutation
// (FR-009), runs the create-or-update API call, merges the saved record back
// keeping test_id, and then writes the env/evidence meta keys (#116 — the message
// itself is now the tester's text verbatim, for every status). `onOptimistic`
// paints the caller's view between the mutation and the round trip. Needs no JWT
// (v2 token path) → works under login-blocked (US6). Throws on API failure; the
// caller rolls back from its own snapshot.
async function writeStatus(record, status, comment, onOptimistic, opts = {}) {
  syncBeginWrite(); // pause livesync ticks; force an immediate refetch when this settles
  try {
    const message = comment;
    if (record) Object.assign(record, { status, message });
    if (onOptimistic) onOptimistic();
    let saved;
    try {
      // e2e write-failure hook fires before the real request so the whole enqueue
      // path is exercised deterministically (no dependence on a URL/id regex).
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
      // Offline queue (M4 cycle 2): a network / 401-403 «paused» failure on a
      // queueable record keeps the optimistic local status and queues it for
      // replay — no rollback, no error toast. `noQueue` replays bypass this so a
      // still-offline retry throws and the entry stays queued.
      if (!opts.noQueue && record && record.id != null
          && typeof OfflineQueue !== 'undefined' && OfflineQueue.qualifies(e)) {
        await OfflineQueue.enqueue({ recordId: record.id, runId: state.runId, status, comment, queuedAt: Date.now() });
        return { queued: true };
      }
      throw e;
    }
    // The row always exists (opened by record id) and keeps its test_id.
    if (saved && record) Object.assign(record, saved, { test_id: record.test_id });
    await writeEnvMeta(record, status); // #116 — after the id exists, never fatal
    return saved;
  } finally {
    syncEndWrite();
  }
}

// Test-view wrapper: the shared write plus its view-specific bits (status line,
// step-tick reset, actions state, substatus reset). BOTH test-view inputs land
// here — the big ✓/✗/− buttons (app.js) and the Cmd/Ctrl hotkeys (hotkeys.js) —
// so a click and a shortcut can never drift apart (#77).
// The write's own state, kept as DATA on its line rather than in words. A landed
// status no longer SAYS anything: the header chip, the solid button and the
// Summary dot each already state the verdict, and "failed ✓" printed in the
// saved-green under a red verdict was the panel talking over itself. What the
// line still spells out is what nothing else can show — Saving…, queued offline,
// and the errors. `data-write` is the same fact for whoever has to read it back
// (the panel itself, and the e2e harness, which used to key on the prose).
function setWriteState(kind) {
  const el = $('test-status');
  if (!el) return;
  if (kind) el.dataset.write = kind;
  else delete el.dataset.write;
}

async function clickStatus(status) {
  if (state.saving) return;
  const record = recordFor(state.currentRecordId);
  // #186: openTestView paints these controls SYNCHRONOUSLY (show + updateTestActionsState
  // before its first await), so one extra click is all it takes to reach them inside the
  // window where the run's archived answer is still in flight — no second round-trip
  // required. Same bounded wait the run view's row buttons use, then the lock check
  // below sees the real state. `state.saving` is claimed first because it is the
  // re-entrancy guard both inputs share, and it was set after this point.
  if (typeof awaitRunState === 'function' && typeof runStateProbe !== 'undefined' && runStateProbe) {
    state.saving = true;
    await awaitRunState();
    state.saving = false;
  }
  // #152/#154: BOTH test-view inputs land here, so this one check covers the
  // buttons (already disabled) and the Cmd/Ctrl hotkeys (which have no disabled
  // state of their own). A hotkey on a locked result must no-op VISIBLY, never
  // silently — hence the status line on top of the inline reason under the
  // buttons. Keyed on the RECORD: in a mixed run the very next test may write.
  const lock = typeof recordWriteLock === 'function' ? recordWriteLock(record) : '';
  if (lock) {
    setStatusLine('test-status', lock, 'error');
    updateTestActionsState();
    return;
  }
  const prev = record ? { ...record } : null;
  const typed = $('test-comment').value.trim();
  // #108 made leaving mid-write possible for the first time: the advance used to fire
  // only AFTER the write settled, whereas "Next test →" / N is available while it is
  // in flight (that is the whole point of the two-keystroke flow). So every
  // view-specific paint below is gated on still being on THIS record — the same
  // "moved on" guard openTestView uses — or a resolving write would stamp its status
  // line, substatus group and step-tick reset onto whatever test is open by then.
  // The write, the record mutation and the rollback are NOT gated: they are about
  // data, not the screen.
  const stillHere = () => String(state.currentRecordId) === String(record?.id);

  state.saving = true; // guard re-entrancy across the async env-info read below
  setStatusLine('test-status', `Saving ${status}…`);
  setWriteState('saving');
  try {
    const res = await writeStatus(record, status, typed, renderTestProgress);
    const queued = !!(res && res.queued);
    delete state.stepTicks[record?.id]; // leaving the test resets ticks (FR-005)
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
    if (!stillHere()) return; // tester already moved on — nothing left to paint here
    // Landed: the line says NOTHING. The verdict is already up in the header
    // card's chip, on the solid button and on the Summary dot — a fourth voice
    // under them, in the saved-green, was the panel reading its own result back
    // ("failed ✓" in green under a red chip). Queued offline still speaks: that
    // one is not on any other surface.
    setStatusLine('test-status', queued ? `${status} — queued offline, will sync when back online` : '', queued ? 'ok' : '');
    setWriteState(queued ? 'queued' : 'saved');
    // The result exists now, so the screen follows it: the Status section holds
    // what was reported and the four controls that only apply once a row HAS a
    // status (comment, custom status, assignee, attachments). Marking used to
    // leave them a scroll away under the steps.
    showTestSection('status');
    updateTestActionsState();
    renderSubstatus(record); // status changed -> offer that status's reply group
    renderSubstatusMark(record); // …and the mark is tinted BY that status
    applyAssigneeGate(record); // #153: status changed -> the row is no longer re-assignable
    if (!queued) refreshResultSummary(record); // #117: keep the summary card in step
    // #108: NO status navigates away — not a click, not a hotkey, not any status.
    // Marking used to auto-advance on pass/skip, which redirected the tester at the
    // exact moment the substatus / assignee / comment / attachment controls appear
    // (they render only once the row has a real status). Moving on is now an
    // explicit act: the persistent "Next test →" button or its hotkey. FAILED still
    // surfaces the evidence controls it needs instead of leaving them collapsed (#73).
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
      // Moved on: the inline line belongs to another test now, so the toast is the
      // only surface left — and an unsaved status must never be swallowed.
      toast(`Status not saved: ${e.message}`, { error: true });
    }
  } finally {
    state.saving = false;
  }
}

// The foot band's pager — `‹ 3 of 11 ›`. Position and both steps are the ARROW
// KEYS' own move: ±1 through the VISIBLE sequence (filter + search applied, the
// set the arrows already walk), no wrap, so each end goes dead rather than
// clicking to nothing. Disabled and not hidden: an edge that removes a button
// shifts the two beside it.
// The status-aware jump — next UNTESTED, over the rows already graded — is the N
// key and nextTest() below; a pager arrow cannot be that and still agree with
// the number between them.
function paintTestNav() {
  const pos = $('test-position');
  const prev = $('btn-prev-test');
  const next = $('btn-next-test');
  const order = visibleRecords();
  const at = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  // -1 means the open test is not in the visible set at all (a filter that no
  // longer matches it): no position to state, and nowhere to step.
  if (pos) pos.textContent = at === -1 ? '' : `${at + 1} of ${order.length}`;
  if (prev) prev.disabled = at <= 0;
  if (next) next.disabled = at === -1 || at >= order.length - 1;
}

// "Next test →" (#108) — the explicit move-on, the only thing that navigates in
// the test view besides the arrows. Walks the VISIBLE render sequence (filter +
// search applied) and lands on the next still-untested visible row, skipping what
// is already graded. Never re-opens the current test: it is reachable on an
// unmarked test now that the button is persistent, so the two dead ends are
// spelled out — nothing untested left anywhere → back to the run view; only THIS
// test left untested → say so and stay put.
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
