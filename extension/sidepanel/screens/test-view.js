// Test view: render steps (tri-state or local checkboxes), example substitution,
// status writes, the priority icon, and the substatus dropdown.

/* global TestomatAPI, TestomatParams, Md, PriorityIcons, CommentDrafts, WriteCore, TestSummary,
   renderPendingAnnotation, Skeleton, Tooltip, EmptyState, UserCell, Icons,
   ImgHydrate, progressToast, hideToast */

// The description body's object-URL group (shared/img-hydrate.js) — repainted and released
// on its own occasion. The summary card's four are its own (screens/test-summary.js).
const IMG_GROUP_DESC = 'test-description';

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
  // A pending draft save carries its OWN record id, so leaving mid-keystroke still
  // commits the text to the test it was typed in — flushed before this open repaints.
  CommentDrafts.flush();
  $('test-comment').value = record.message || '';
  CommentDrafts.restore(record); // …and an unsent draft comes back on a result that has no message yet
  $('test-steps').replaceChildren();
  ImgHydrate.release(IMG_GROUP_DESC); // #205 — the images that body was holding go with it
  // This line belongs to the WRITE (Saving…/queued/error); only a failed read speaks here.
  setStatusLine('test-status', '');
  setWriteState('');
  if ($('example-badge')) $('example-badge').hidden = true;
  if ($('test-substatus')) $('test-substatus').hidden = true;
  renderSubstatusMark(null); // never let the previous test's custom status linger
  if ($('test-assignee')) $('test-assignee').hidden = true;
  TestSummary.hide(); // #117: never let the previous test's result flash here
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
    TestSummary.render();
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
    const res = await WriteCore.writeStatus(record, status, typed, renderTestProgress);
    const queued = !!(res && res.queued);
    delete state.stepTicks[record?.id]; // leaving the test resets ticks
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateTestMarker();
    if (!stillHere()) { hideToast(); return; } // tester already moved on — nothing left to paint here
    // Landed: the line says NOTHING (the verdict is already on three surfaces).
    // #106: a token the server rejected is not "offline", and telling the tester to wait for a
    // connection that is already there costs them the session. Same queue — an honest sentence.
    const queuedLine = res && res.reason === 'auth'
      ? `${status} — saved here, but the token was rejected; authorize again in Settings`
      : `${status} — queued offline, will sync when back online`;
    setStatusLine('test-status', queued ? queuedLine : '', queued ? 'ok' : '');
    setWriteState(queued ? 'queued' : 'saved');
    // The controls below only apply once a row HAS a status, so the screen follows it.
    showTestSection('status');
    updateTestActionsState();
    renderSubstatus(record); // status changed -> offer that status's reply group
    renderSubstatusMark(record);
    applyAssigneeGate(record); // #153: status changed -> the row is no longer re-assignable
    if (!queued) TestSummary.refresh(record); // #117: keep the summary card in step
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
