// Test view: steps (tri-state or local checkboxes), example substitution, status writes, priority.

/* global TestomatAPI, TestomatParams, Md, PriorityIcons, CommentDrafts, WriteCore, TestSummary,
   TestMeta, TestGates, renderPendingAnnotation, Roving, Skeleton, EmptyState,
   ImgHydrate, progressToast, hideToast, StatusIcons, RunLock */

// The description body's object-URL group, released on its own; the summary card keeps its own four.
const IMG_GROUP_DESC = 'test-description';

async function openTestView(recordId) {
  if (capabilities.readonly) { show('test'); return; } // locked project
  const record = recordFor(recordId);
  if (!record) return;
  state.currentRecordId = record.id; // canonical id, even if called with a string
  state.testrunDetail = null;
  // Header holds the priority slot open until that read lands (views.js).
  state.testDetailPending = true;
  state.currentSteps = [];
  // v2 substitutes the title server-side; set before show() or the header paints the previous test.
  state.testTitle = record.test_title || `Test ${record.test_id}`;
  show('test');
  showTestSection('desc'); // every open starts on "what to do", never on the last test's section
  renderTestProgress();
  paintTestNav();
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
  $('test-title').textContent = state.testTitle;
  // A pending draft save carries its own record id, so it is flushed before the open repaints.
  CommentDrafts.flush();
  $('test-comment').value = record.message || '';
  CommentDrafts.restore(record); // …and an unsent draft comes back on a result that has no message yet
  $('test-steps').replaceChildren();
  ImgHydrate.release(IMG_GROUP_DESC); // the images that body was holding go with it
  // This line belongs to the write (Saving…/queued/error); only a failed read speaks here.
  setStatusLine('test-status', '');
  setWriteState('');
  if ($('example-badge')) $('example-badge').hidden = true;
  if ($('test-substatus')) $('test-substatus').hidden = true;
  TestMeta.renderSubstatusMark(null); // never let the previous test's custom status linger
  if ($('test-assignee')) $('test-assignee').hidden = true;
  TestSummary.hide(); // never let the previous test's result flash here
  TestGates.update();
  renderAttachmentList(); // never let the previous test's attachments linger
  renderPendingAnnotation(); // a kept annotation is offered on its own record only
  srecOnTestOpen(); // bind a page-started recording to this result, and take a parked file
  TestGates.applyAttachmentsDisclosure();
  TestGates.syncFullPageToggles();
  const sk = Skeleton.show('test');
  try {
    // The probe settles before rendering so steps draw once in the right mode; it never throws.
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
    TestSummary.render();
    renderPriority();
    TestMeta.renderSubstatus(record);
    TestMeta.renderSubstatusMark(record);
    TestMeta.renderAssignee(record);
    // Both need the settled session: prefetched attachments and the degraded gate.
    renderAttachmentList();
    TestGates.update();
  } catch (e) {
    if (String(state.currentRecordId) === String(record.id)) handleApiError(e, 'test-status');
  } finally {
    // A failed read must not leave the header pulsing, but only for the test still open.
    if (String(state.currentRecordId) === String(record.id) && state.testDetailPending) {
      state.testDetailPending = false;
      refreshContextBar();
    }
    Skeleton.hide(sk);
  }
}

// The open section belongs to the view, not the test, so a fresh test never opens on a stale one.
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
    if (tab) {
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      // One tab stop for the bar, the arrows between the three — the tablist convention.
      tab.setAttribute('tabindex', on ? '0' : '-1');
    }
    if (pane) pane.hidden = !on;
  }
  // Roving.item() is not used here: it writes role="button" over the markup's role="tab".
  Roving.attach($('test-sections'), { selector: '.tab', orientation: 'horizontal' });
}

// Step lists are the renderer's answer (Md.stepLists): the stylesheet numbers the same lists.
function stepListItems(container) {
  return Md.stepLists(container)
    .flatMap((list) => [...list.querySelectorAll(':scope > li')]); // top-level only
}

// Both spellings occur: fixtures write "Expected:", humans "Expected Result:".
const EXPECTED_LABEL = /^\s*expected(\s+results?)?\s*:/i;

// Read rendered text here, never textContent: a soft break is a <br> that glues two words together.
function textIn(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// Expected sub-bullets are removed from the DOM, so `pos` is snapshotted first (the web counts them).
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

// The body div owns min-width: 0 so a long title wraps; showdown's own checkbox gives way to ours.
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

// Web-runner `pos` = index among all <li>: nested ones count in it but get no control.
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

// The v2 description arrives unsubstituted (params and example ride the JSON:API detail).
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

// Under JWT params are known, so gate on parametrized; degraded, the placeholder is the only signal.
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
  // Hydrate first: CSP allows no remote <img>, and a root-relative one resolves against the extension.
  ImgHydrate.hydrate(IMG_GROUP_DESC, tmp);

  state.currentSteps = parseSteps(tmp);
  box.append(...tmp.childNodes);
  applyStepMode(record);
}

function applyStepMode(record) {
  if (capabilities.jwt && record?.id) renderTriState(record);
  else renderLocalCheckboxes(record);
}

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

// Web-runner cycle: first click => passed, then passed -> failed -> skipped; no unset write.
const STEP_OPTIONS = ['passed', 'failed', 'skipped'];
// `unset` is the caller's choice: the ring control draws nothing, the summary dot a ring.
const STEP_ICON = { passed: 'check', failed: 'close', skipped: 'remove' };

function paintStepMark(el, status, size, unset = '') {
  const name = STEP_ICON[status] || unset;
  el.replaceChildren(...(name ? [StatusIcons.svgIcon(name, size)] : []));
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
  // Catches the race past the disabled circles; an automated testrun drops step writes with a 200.
  if (RunLock.recordWriteLock(record)) return;
  const prev = s.state;
  const next = STEP_OPTIONS[(STEP_OPTIONS.indexOf(prev) + 1) % STEP_OPTIONS.length];
  s.state = next;
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

// Priority rides the JSON:API detail (v2 omits it) and lands late; this only says the read is in.
function renderPriority() {
  state.testDetailPending = false;
  refreshContextBar();
}

// `data-write` is what the panel and the e2e harness read back, instead of keying on the prose.
function setWriteState(kind) {
  const el = $('test-status');
  if (!el) return;
  if (kind) el.dataset.write = kind;
  else delete el.dataset.write;
}

async function clickStatus(status) {
  if (state.saving) return;
  const record = recordFor(state.currentRecordId);
  // A click can land while the run's archived answer is in flight; `state.saving` is the guard.
  if (typeof awaitRunState === 'function' && typeof runStateProbe !== 'undefined' && runStateProbe) {
    state.saving = true;
    await awaitRunState();
    state.saving = false;
  }
  // Covers the hotkeys too, which have no disabled state: a locked result must no-op visibly.
  const lock = typeof RunLock !== 'undefined' ? RunLock.recordWriteLock(record) : '';
  if (lock) {
    setStatusLine('test-status', lock, 'error');
    TestGates.update();
    return;
  }
  const prev = record ? { ...record } : null;
  const typed = $('test-comment').value.trim();
  // The tester can leave mid-write, so view paints below check stillHere(); the write itself does not.
  const stillHere = () => String(state.currentRecordId) === String(record?.id);

  state.saving = true; // guard re-entrancy across the async env-info read below
  progressToast(`Saving ${status}…`);
  setWriteState('saving');
  try {
    const res = await WriteCore.writeStatus(record, status, typed, renderTestProgress);
    const queued = !!(res && res.queued);
    delete state.stepTicks[record?.id]; // leaving the test resets ticks
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
    if (!stillHere()) { hideToast(); return; } // tester already moved on — nothing left to paint here
    // A rejected token is not "offline": waiting for a connection that is there costs the session.
    const queuedLine = res && res.reason === 'auth'
      ? `${status} — saved here, but the token was rejected; authorize again in Settings`
      : `${status} — queued offline, will sync when back online`;
    setStatusLine('test-status', queued ? queuedLine : '', queued ? 'ok' : '');
    setWriteState(queued ? 'queued' : 'saved');
    // The controls below apply only once a row has a status, so the screen follows it.
    showTestSection('status');
    TestGates.update();
    TestMeta.renderSubstatus(record); // status changed -> offer that status's reply group
    TestMeta.renderSubstatusMark(record);
    TestMeta.applyAssigneeGate(record); // status changed -> the row is no longer re-assignable
    if (!queued) TestSummary.refresh(record);
    // No status navigates away: moving on is an explicit act ("Next test →" or its hotkey).
    if (status === 'failed') TestGates.expandForFailure();
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

// Disabled, not hidden: an edge that removed a button would shift the two beside it.
function paintTestNav() {
  const pos = $('test-position');
  const prev = $('btn-prev-test');
  const next = $('btn-next-test');
  const order = pagerRecords(); // the open test keeps its place after a status takes it out of the filter
  const at = order.findIndex((r) => String(r.id) === String(state.currentRecordId));
  // -1 = the open test is not in the run at all.
  if (pos) pos.textContent = at === -1 ? '' : `${at + 1} of ${order.length}`;
  if (prev) prev.disabled = at <= 0;
  if (next) next.disabled = at === -1 || at >= order.length - 1;
}

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
