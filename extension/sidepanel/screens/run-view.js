// Run view: the tests list with progress, status chips, search, suite sections and Finish run.

/* global TestomatAPI, Skeleton, Tooltip, EmptyState, TestType, PriorityIcons,
   CommentDrafts, WriteCore, byRecordId, Roving, StatusIcons, RunLock, RunInfo */

async function openRunView(runId, title) {
  // A read-only project is locked whole, gated before any state is touched.
  if (await readonlyGate()) { show('run'); return; }
  const runChanged = state.runId !== runId;
  // Back from a test, or Refresh on this run: it is already painted, so the re-read lands in place.
  const quiet = !runChanged && state.records.length > 0;
  // Suite prefs are per run for the session, reset only when a different run opens.
  if (runChanged) state.expandedSuites = {};
  state.runId = runId;
  if (title) state.runTitle = title;
  state.currentRecordId = null; // no row is open on this screen, by either path
  if (!quiet) {
    state.runStatus = null;
    state.runKind = null;
    state.substatusCounts = {}; // filled by the JSON:API read below
    state.runInfo = {};         // v2 detail below, JSON:API extras over it
    state.runFilter = 'all';
    state.runSearch = '';
    if ($('run-search')) $('run-search').value = '';
  }
  show('run');
  let sk = null;
  if (!quiet) {
    sk = Skeleton.show('run');
    setStatusLine('run-status', 'Loading tests…');
    if ($('run-meta-note')) $('run-meta-note').hidden = true;
    $('run-tests').replaceChildren();
    $('run-progress').replaceChildren(); // clear progress only — the Finish button is a sibling
    // Neither pill may describe the previous run while the new one loads.
    if ($('run-kind')) $('run-kind').hidden = true;
    if ($('run-state')) $('run-state').hidden = true;
    // Nor Run info or the chips, which would read as the new run's numbers; a reload keeps them.
    if (runChanged) {
      if ($('run-info')) $('run-info').hidden = true;
      if ($('run-info-body')) $('run-info-body').replaceChildren();
      if ($('run-filter')) $('run-filter').replaceChildren();
    }
  }
  try {
    // Independent legs: a failed meta fetch must not blank a fetchable checklist.
    const readInfo = capabilities.jwt === true;
    const [detailRes, recordsRes, infoRes, examplesRes] = await Promise.allSettled([
      TestomatAPI.getRun(runId),
      TestomatAPI.listTestruns(runId),
      readInfo ? TestomatAPI.getRunInfo(runId) : null,
      readInfo ? TestomatAPI.listTestrunExamples(runId) : null,
    ]);
    if (state.runId !== runId) return;
    if (recordsRes.status === 'rejected') throw recordsRes.reason;
    const detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
    const metaFailed = !detail;
    if (metaFailed) {
      state.runTitle = state.runTitle || 'Run';
      state.runStatus = null;
      state.runKind = null;
      state.runInfo = {};
    } else {
      state.runTitle = detail.clean_title || detail.title || state.runTitle;
      state.runStatus = detail.status || null; // 'running' while unfinished; terminal after finish
      state.runKind = detail.kind || null;     // v2 run detail carries `kind`
      state.runInfo = RunInfo.fromDetail(detail);
    }
    // Merged over the v2 base; null whenever the read was not part of the batch.
    const info = infoRes.status === 'fulfilled' ? infoRes.value : null;
    if (info) applyRunInfo(info);
    // show() painted the header off the passed-in title — repaint with the real one.
    refreshContextBar();
    // v2 returns newest-first; run order = creation order = id ASC.
    state.records = recordsRes.value.sort(byRecordId);
    // Best-effort like the info leg: a failed read leaves the parametrized rows bare.
    state.runExamples = (examplesRes.status === 'fulfilled' && examplesRes.value) || {};
    renderRunView();
    if ($('run-meta-note')) $('run-meta-note').hidden = !metaFailed;
    updateRunActions();      // hidden until the session probe confirms JWT
    startLiveSync();         // (re)start polling; also clears an auth-stop
    if (typeof OfflineQueue !== 'undefined') OfflineQueue.replay(); // run-open is a replay trigger
    loadSuiteEmoji(runId);   // fire-and-forget
    CommentDrafts.prune(runId); // …and so is dropping the drafts of results this run no longer has
    // Kept though fire-and-forget: a row write waits on it for the archived flag.
    runStateProbe = probeRunSession(runId, { infoRead: !!info });
  } catch (e) {
    handleApiError(e, 'run-status');
  } finally {
    if (sk) {
      Skeleton.hide(sk);
      // Both Run info measures need layout, so they are retaken now the card is back on screen.
      RunInfo.paint();
    }
  }
}

// Without a proven session the archived flag lands after the render, so a write awaits this probe.
let runStateProbe = null;

// Bounded: no fetch here has a timeout, and a hung probe would park the write forever.
const PROBE_WAIT_MS = 2000;
const awaitRunState = () => (runStateProbe
  ? Promise.race([runStateProbe, sleep(PROBE_WAIT_MS)]).catch(() => {})
  : Promise.resolve());

// Resolves once the run detail lands; assignee names are detached, as a write must not wait on them.
async function probeRunSession(runId, { infoRead = false } = {}) {
  await loadProjectInfo();
  if (state.runId !== runId) return;
  capabilities.jwt = TestomatAPI.jwtAvailable() === true;
  applyCapabilities();
  updateRunActions();
  if (!capabilities.jwt) return;
  // Awaited before the paint below, the one repaint the examples and substatuses share.
  const gotExamples = infoRead ? false : await refreshRunExamples(runId);
  if (state.runId !== runId) return;
  // Row marks are JWT-gated, so the first (pre-probe) paint carried none.
  if ((gotExamples || state.records.some((r) => r.substatus)) && state.view === 'run') renderRunSections();
  if (!infoRead && await refreshRunInfo(runId)) { paintRunProgress(); RunInfo.render(); RunLock.applyRunLock(); }
  if (state.runId !== runId) return;
  probeRunAssignees(runId); // detached: a write must not wait on it
}

// Unconditional: the viewer's profile timezone rides the same record as the assignees.
async function probeRunAssignees(runId) {
  await loadProjectUsers();
  if (state.runId === runId && state.view === 'run') { renderRunSections(); RunInfo.render(); }
}

// One JSON:API read for the counters and the Run info fields v2 omits; a failure keeps the last paint.
async function refreshRunInfo(runId) {
  if (!capabilities.jwt) return false;
  try {
    const info = await TestomatAPI.getRunInfo(runId);
    if (state.runId !== runId) return false;
    applyRunInfo(info);
    return true;
  } catch {
    return false;
  }
}

// True only when the map came back non-empty, i.e. there is a chip for the caller to paint.
async function refreshRunExamples(runId) {
  if (!capabilities.jwt) return false;
  try {
    const map = await TestomatAPI.listTestrunExamples(runId);
    if (state.runId !== runId) return false;
    state.runExamples = map || {};
    return Object.keys(state.runExamples).length > 0;
  } catch {
    return false;
  }
}

// Basic mode only: with no JSON:API read, the panel would never learn a colleague finished the run.
async function refreshRunFinished(runId) {
  if (capabilities.jwt) return;
  try {
    const detail = await TestomatAPI.getRun(runId);
    if (!detail || state.runId !== runId) return;
    state.runStatus = detail.status || null;
    applyRunInfo(RunInfo.fromDetail(detail)); // the v2 half of Run info rides along
  } catch { /* keep what we had */ }
}

// Replaced only when the payload carried them: null = didn't say, while an un-archive (false) lands.
function applyRunInfo({ substatusCounts, isArchived, ...extras }) {
  if (substatusCounts) state.substatusCounts = substatusCounts;
  if (isArchived != null) state.runInfo.isArchived = isArchived;
  Object.assign(state.runInfo, extras); // merged over the v2 base fields
}

const RUN_LIVE_STATUSES = new Set(['running', 'launching']);

// A rerun archived run is 'running' again, so the archived check is needed beside the finished one.
function updateRunActions() {
  const btn = $('btn-finish-run');
  if (!btn) return;
  const jwt = TestomatAPI.jwtAvailable(); // 'unknown' | true | false
  // `launching` counts as running: a run still starting is exactly one a tester may want to stop.
  const running = RUN_LIVE_STATUSES.has(state.runStatus) && !RunLock.runFinished() && !RunLock.runArchived();
  // Degraded stays visible but disabled with a reason, so the lost capability is legible.
  btn.hidden = !running || jwt === 'unknown';
  const degraded = running && jwt === false;
  btn.disabled = degraded;
  Tooltip.set(btn, degraded
    ? `Finish run needs an active ${baseUrlHost()} web login — sign in there, then Refresh`
    : '');
}

function displayStatus(record) {
  const s = record?.status;
  return s && s !== 'pending' ? s : 'untested';
}

// User-facing badge/label for an internal status key (class name keeps the key).
const statusLabel = (status) => (status === 'untested' ? 'pending' : status);

function progressNodes() {
  const total = state.records.length;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const r of state.records) {
    const s = displayStatus(r);
    if (counts[s] !== undefined) counts[s] += 1;
  }
  const done = counts.passed + counts.failed + counts.skipped;

  // Only the tallies that happened; the done/total figure always stands, zero included.
  const line = document.createElement('div');
  line.className = 'hint counts';
  const fraction = document.createElement('span');
  fraction.className = 'counts-done';
  fraction.textContent = `${done}/${total}`;
  line.append(fraction);
  for (const key of ['passed', 'failed', 'skipped']) {
    if (!counts[key]) continue;
    const part = document.createElement('span');
    part.className = `counts-part ${key}`;
    part.textContent = `${counts[key]} ${key}`;
    line.append(document.createTextNode(' · '), part);
  }
  const bar = document.createElement('div');
  bar.className = 'progress';
  for (const [key, cls] of [['passed', 'p'], ['failed', 'f'], ['skipped', 's']]) {
    const seg = document.createElement('div');
    seg.className = cls;
    seg.style.width = total ? `${(counts[key] / total) * 100}%` : '0';
    bar.append(seg);
  }
  return [line, bar];
}

// Sorted count desc, then name: the server's grouping order is not guaranteed and a jump flickers.
function appendSubstatusCounts(line) {
  if (!capabilities.jwt) return;
  const entries = Object.entries(state.substatusCounts || {})
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  if (!entries.length) return;
  const group = document.createElement('span');
  group.className = 'substatus-counts';
  Tooltip.set(group, 'Custom statuses set in this run');
  for (const [name, count] of entries) {
    const item = document.createElement('span');
    item.className = 'substatus-count';
    item.dataset.substatus = name;
    item.textContent = `${name}: ${count}`;
    // NBSP after the separator, so a wrap takes the `·` down with its counter.
    group.append(document.createTextNode(' · '), item);
  }
  line.append(group);
}

// The Finish run button is a sibling in the band, so a progress repaint never wipes it.
function paintRunProgress() {
  const nodes = progressNodes();
  appendSubstatusCounts(nodes[0]); // the .counts line — counters extend it inline
  $('run-progress').replaceChildren(...nodes);
}

function paintRunKind() {
  const el = $('run-kind');
  if (!el) return;
  const badge = StatusIcons.kindBadge(state.runKind);
  el.replaceChildren(...(badge ? [badge] : []));
  el.hidden = !badge;
}

// The fresher source first (JSON:API status, then v2); hidden when neither answered.
const RUN_STATE_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };
function paintRunState() {
  const el = $('run-state');
  if (!el) return;
  const status = state.runInfo?.status || state.runStatus || '';
  el.replaceChildren();
  el.hidden = !status;
  if (!status) return;
  el.className = `status-label ${RUN_STATE_TINT[StatusIcons.normStatus(status)] || 'neutral'}`;
  Tooltip.set(el, `Run status: ${status}`);
  const label = document.createElement('span');
  label.textContent = status;
  el.append(StatusIcons.statusIcon(status), label);
}

function renderRunHeader() {
  paintRunKind();
  paintRunState();
  paintRunProgress();
  // Not show('run'), which switches views: a poll tick would throw the tester out of their test.
  refreshContextBar();
}

function renderTestProgress() {
  $('test-progress').replaceChildren(...progressNodes());
}

// Single-select; the counts are over the whole run, never narrowed by the search.
const RUN_STATUS_FILTERS = [
  ['all', 'All'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped'],
  ['untested', 'Pending'],
];
const RUN_FILTER_KEYS = new Set(RUN_STATUS_FILTERS.map(([k]) => k));
// Only the three that are a result are coloured; All and Pending stay neutral.
const RUN_FILTER_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

// A row still executing answers `running`, which has no chip, so it counts as Pending.
const chipStatusOf = (r) => {
  const s = displayStatus(r);
  return RUN_FILTER_KEYS.has(s) ? s : 'untested';
};

function runStatusCounts() {
  const counts = { all: state.records.length, passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const r of state.records) counts[chipStatusOf(r)] += 1;
  return counts;
}

const matchesRunFilter = (r) => state.runFilter === 'all' || chipStatusOf(r) === state.runFilter;

// Keyed by record id: a v2 numeric id indexes the JSON:API map's string keys unchanged.
const exampleOf = (r) => state.runExamples[r.id] || null;

// A parametrized row's example values are searched too: they alone separate rows sharing a title.
function matchesRunSearch(r) {
  const q = state.runSearch.trim().toLowerCase();
  if (!q) return true;
  if ((r.test_title || '').toLowerCase().includes(q)) return true;
  if ((r.suite_title || '').toLowerCase().includes(q)) return true;
  return (exampleOf(r)?.values || []).some((v) => v.toLowerCase().includes(q));
}

const rowVisible = (r) => matchesRunFilter(r) && matchesRunSearch(r);

const NO_SUITE = '__none__';
const suiteKeyOf = (r) => (r.suite_title ? r.suite_title : NO_SUITE);

// Structure is built from all records in first-appearance order; callers filter rows per section.
function suiteSections() {
  const order = [];
  const map = new Map();
  for (const r of state.records) {
    const k = suiteKeyOf(r);
    if (!map.has(k)) { map.set(k, { key: k, title: r.suite_title || null, rows: [] }); order.push(k); }
    map.get(k).rows.push(r);
  }
  return order.map((k) => map.get(k));
}

// /testruns carries suite_title only, so marks come off the suite tree by title; first one wins.
function indexSuiteEmoji(nodes, into) {
  for (const n of nodes || []) {
    if (n.title && n.emoji && !(n.title in into)) into[n.title] = n.emoji;
    indexSuiteEmoji(n.children, into);
  }
  return into;
}

const suiteEmojiOf = (title) => (title && state.suiteEmoji ? state.suiteEmoji[title] || null : null);

// Replaced wholesale so a removed mark disappears; a null prototype keeps "constructor" a plain key.
function rememberSuiteEmoji(roots) {
  state.suiteEmoji = indexSuiteEmoji(roots, Object.create(null));
}

// Painted in place: a full repaint would throw away the row a tester is part-way through.
async function loadSuiteEmoji(runId) {
  // The Tests tab may already hold the same tree — draw from it rather than wait.
  if (!state.suiteEmoji && state.tcSuites?.length) rememberSuiteEmoji(state.tcSuites);
  if (state.suiteEmoji) paintSuiteEmoji();
  let roots;
  try { roots = await TestomatAPI.getSuiteTree(); } catch { return; }
  if (state.runId !== runId) return; // a different run (or none) is on screen now
  rememberSuiteEmoji(roots);
  paintSuiteEmoji();
}

// A repaint that changes no icon leaves the DOM alone.
function paintSuiteEmoji() {
  for (const sec of document.querySelectorAll('#run-tests .suite-section')) {
    const slot = sec.querySelector('.suite-head .file-icon');
    if (!slot) continue;
    const next = StatusIcons.treeIcon(StatusIcons.FILE, 'file-icon', suiteEmojiOf(sec.dataset.suite));
    if ((slot.dataset.emoji || '') !== (next.dataset.emoji || '')) slot.replaceWith(next);
  }
}

// The traversal anchor; collapse is ignored (presentation only).
function orderedRecords() {
  const seq = [];
  for (const sec of suiteSections()) seq.push(...sec.rows);
  return seq;
}

const visibleRecords = () => orderedRecords().filter(rowVisible);
// The pager's sequence: the visible one plus the open test, which its new status may filter out.
const pagerRecords = () => orderedRecords()
  .filter((r) => rowVisible(r) || String(r.id) === String(state.currentRecordId));

// Updated, not rebuilt: the counts move on every mark and poll tick, under the eye.
function renderRunFilterChips() {
  const bar = $('run-filter');
  if (!bar) return;
  const counts = runStatusCounts();
  for (const [key, label] of RUN_STATUS_FILTERS) {
    let chip = bar.querySelector(`[data-filter="${key}"]`);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      // Whatever doesn't fit the row leaves it for the `⋯` menu (fitFilterChips).
      chip.className = 'btn secondary size-sm filter-chip';
      chip.dataset.filter = key;
      const text = document.createElement('span');
      text.className = 'filter-label';
      text.textContent = label;
      const count = document.createElement('span');
      count.className = `counter${RUN_FILTER_TINT[key] ? ` ${RUN_FILTER_TINT[key]}` : ''}`;
      chip.append(text, count);
      chip.addEventListener('click', () => setRunFilter(key));
      bar.append(chip);
    }
    const on = state.runFilter === key;
    chip.classList.toggle('selected', on);
    chip.classList.toggle('secondary', !on);
    chip.setAttribute('aria-pressed', String(on));
    paintCounter(chip.querySelector('.counter'), counts[key] ?? 0);
  }
  fitFilterChips(bar);
}

function setRunFilter(key) {
  if (!RUN_FILTER_KEYS.has(key)) key = 'all';
  if (state.runFilter === key) return;
  state.runFilter = key;
  renderRunFilterChips();
  renderRunSections();
}

// The input drives state via its own listener, so typing must leave it untouched.
function syncRunSearch() {
  const input = $('run-search');
  const clear = $('run-search-clear');
  if (input && input.value !== state.runSearch) input.value = state.runSearch;
  if (clear) clear.hidden = state.runSearch === '';
}

// The list is rebuilt whole, so a run of hundreds cannot afford one rebuild per keystroke.
const RUN_SEARCH_MS = 250;
let runSearchTimer = null;

function onRunSearch() {
  state.runSearch = $('run-search').value;
  $('run-search-clear').hidden = state.runSearch.trim() === '';
  clearTimeout(runSearchTimer);
  runSearchTimer = setTimeout(renderRunSections, RUN_SEARCH_MS);
}

function clearRunSearch() {
  $('run-search').value = '';
  state.runSearch = '';
  $('run-search-clear').hidden = true;
  clearTimeout(runSearchTimer); // one deliberate act, not typing — and no stale redraw behind it
  renderRunSections();
  $('run-search').focus();
}

// Drawn as icons: an SVG centres geometrically where a text glyph drifts on font metrics.
const ROW_STATUS_BTNS = [
  ['passed', 'check', 'Mark passed'],
  ['failed', 'close', 'Mark failed'],
  ['skipped', 'remove', 'Mark skipped'],
];
const ROW_BTN_LABEL = Object.fromEntries(ROW_STATUS_BTNS.map(([status, , label]) => [status, label]));

// Each writes its own record — parametrized example rows are separate records.
function rowStatusButtons(r, li) {
  const group = document.createElement('span');
  group.className = 'row-actions';
  // A finished run, or an automated result, renders read-only.
  const lock = RunLock.recordWriteLock(r);
  for (const [status, icon, label] of ROW_STATUS_BTNS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn icon size-xs row-st';
    btn.dataset.status = status;
    // Out of the tab order, or a 200-test run has 600 stops; ←→ from the row reach these.
    btn.setAttribute('tabindex', '-1');
    btn.append(StatusIcons.svgIcon(icon, 14));
    btn.disabled = !!lock;
    Tooltip.set(btn, lock || label);
    btn.setAttribute('aria-label', label);
    if (r.status === status) btn.classList.add('active');
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); writeRowStatus(r, status, li); });
    group.append(btn);
  }
  return group;
}

const rowTitle = (r) => r.test_title || (r.test_id ? `Test ${r.test_id}` : 'Untitled test');

// The row itself carries no tooltip — what a mark cannot spell out hangs on the mark.
function statusTip(r) {
  const sub = typeof r?.substatus === 'string' ? r.substatus.trim() : '';
  return [
    statusLabel(displayStatus(r)),
    capabilities.jwt && sub ? sub : '',
  ].filter(Boolean).join(' · ');
}

// Priority is drawn on every row: no priority still runs at `normal`, not unknown.
function testRow(r) {
  const li = document.createElement('li');
  li.className = 'test-row';
  li.dataset.recordId = r.id;
  li.append(statusMark(r));
  const prio = typeof PriorityIcons !== 'undefined' ? PriorityIcons.mark(r.priority) : null;
  if (prio) li.append(prio);
  const type = typeof TestType !== 'undefined' ? TestType.forRecord(r) : null;
  if (type) li.append(type);
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = rowTitle(r);
  li.append(title);
  const example = exampleChip(r);
  if (example) li.append(example);
  // Fixed right cell (flex:none) — a constant column however long the title is.
  li.append(rowStatusButtons(r, li));
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker on (re)render
  li.addEventListener('click', () => openTestView(r.id));
  return Roving.item(li);
}

// Roving never sees ←→, so stepping into a row's status buttons is a second delegated listener.
const RUN_ROW_SELECTOR = 'li.test-row, .suite-head';

// A write lock kills all three, and a row with nothing live has nothing to step into.
const rowCells = (li) => [...li.querySelectorAll('.row-actions .row-st')].filter((b) => !b.disabled);

function onRunRowArrow(ev) {
  if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
  const node = ev.target;
  if (!node || typeof node.matches !== 'function') return;
  const cell = node.matches('.row-actions .row-st') ? node : null;
  // A suite head is neither, and answers ←→ with nothing: Enter is what folds it.
  if (!cell && !node.matches('li.test-row')) return;
  const li = cell ? node.closest('li.test-row') : node;
  if (!li) return;
  const cells = rowCells(li);
  if (!cell) {
    if (ev.key !== 'ArrowRight' || !cells.length) return;
    ev.preventDefault();
    cells[0].focus();
    return;
  }
  const at = cells.indexOf(cell);
  if (at < 0) return;
  ev.preventDefault();
  // Clamped at both ends, as Roving is; ← off the first cell is the way back to the row.
  if (ev.key === 'ArrowRight') cells[Math.min(at + 1, cells.length - 1)].focus();
  else if (at === 0) li.focus();
  else cells[at - 1].focus();
}

// The <ul> outlives every replaceChildren(), so the walk is delegated once; per render it would stack.
const cellsWired = new WeakSet();

function wireRunRowCells(ul) {
  if (!ul || cellsWired.has(ul)) return;
  cellsWired.add(ul);
  ul.addEventListener('keydown', onRunRowArrow);
}

// A chip, not the status mark: flashRowSaved flashes the mark on every write, and this is no result.
function exampleChip(r) {
  const example = exampleOf(r);
  if (!example?.values?.length) return null;
  const { values, params } = example;
  const span = document.createElement('span');
  span.className = 'example';
  span.textContent = values.join(', ');
  const aligned = Array.isArray(params) && params.length === values.length;
  Tooltip.set(span, aligned ? values.map((v, i) => `${params[i]}: ${v}`).join(' · ') : span.textContent);
  return span;
}

// Swapped, not recoloured: starting/finishing swaps the form (a glyph for a loader).
function statusMark(r) {
  // The label, not the key: `pending` is what a person sees, and what the CSS and the e2e read.
  const mark = StatusIcons.statusIcon(statusLabel(displayStatus(r)));
  mark.classList.add('row-status');
  Tooltip.set(mark, statusTip(r)); // the word behind the colour (+ the custom status)
  return mark;
}

function repaintRow(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) mark.replaceWith(statusMark(r));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => b.classList.toggle('active', r.status === b.dataset.status));
  RunLock.applyRowLock(li); // a repaint (own write or livesync) re-asserts the lock
  repaintRowSubstatus(li, r);
  if (typeof OfflineQueue !== 'undefined') OfflineQueue.decorateRow(li, r.id); // «queued» marker follows the queue
}

// The custom status rides the status mark's tooltip, so reconciling it rewrites that.
function repaintRowSubstatus(li, r) {
  const mark = li.querySelector('.row-status');
  if (mark) Tooltip.set(mark, statusTip(r));
}

// May be absent — rows live only once the run view has rendered.
function runRowEl(recordId) {
  return document.querySelector(`#run-tests li.test-row[data-record-id="${String(recordId)}"]`);
}

// The lock outranks the busy flag: releasing a write must never re-enable a locked row.
function setRowButtonsBusy(li, busy) {
  const lock = RunLock.recordWriteLock(recordFor(li.dataset.recordId));
  li.querySelectorAll('.row-actions .row-st').forEach((b) => { b.disabled = busy || !!lock; });
}

// The class is toggled off first so a rapid re-write restarts the flash.
function flashRowSaved(li) {
  const badge = li.querySelector('.row-status');
  if (!badge) return;
  badge.classList.remove('saved-flash');
  void badge.offsetWidth; // reflow → restart the animation
  badge.classList.add('saved-flash');
  setTimeout(() => badge.classList.remove('saved-flash'), 1000);
}

function refreshSuiteFraction(li) {
  const sec = li.closest('.suite-section');
  const frac = sec && sec.querySelector('.suite-frac');
  if (!sec || !frac) return;
  const key = sec.dataset.suite;
  const rows = state.records.filter((r) => suiteKeyOf(r) === key);
  const done = rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${rows.length}`;
}

async function writeRowStatus(record, status, li) {
  if (!record || record.status === status) return;
  const btn = li.querySelector(`.row-actions .row-st[data-status="${status}"]`);
  // Claim the row before any await: two fast clicks inside the probe window would both get through.
  setRowButtonsBusy(li, true);
  // Paint in the click's own turn: behind the probe await it would lag up to 2s.
  if (btn) btn.classList.add('busy');
  // Wait for the archived answer rather than write into a run we were about to lock.
  if (runStateProbe) await awaitRunState();
  // Catches the race where the lock landed between the render and the click.
  const lock = RunLock.recordWriteLock(record);
  if (lock) {
    if (btn) btn.classList.remove('busy'); // RunLock.applyRunLock repaints in place, so the spinner would strand
    RunLock.applyRunLock({ force: true }); toast(lock); return;
  }
  const prev = { ...record };
  state.inlineWrites += 1;
  try {
    const res = await WriteCore.writeStatus(record, status, ''); // no comment / no view-specific bits at run level
    if (btn) btn.classList.remove('busy');
    repaintRow(li, record);          // repaint reflects the queued marker too (decorateRow)
    if (!(res && res.queued)) flashRowSaved(li); // green flash only when the write actually landed
    paintRunProgress();
    renderRunFilterChips();
    refreshSuiteFraction(li);
  } catch (e) {
    if (btn) btn.classList.remove('busy');
    Object.assign(record, prev);
    handleApiError(e, 'run-status', { inlineAuth: true }); // stay in the run on an expired session
    if (!isAuthError(e)) toast(`Status not saved: ${e.message}`, { error: true });
  } finally {
    state.inlineWrites -= 1;
    setRowButtonsBusy(li, false);
  }
}

// Collapsed by default so a huge run is not a wall of rows; one suite, a filter or a toggle opens.
function suiteSection(sec, rows, single) {
  const li = document.createElement('li');
  li.className = 'suite-section tree-node';
  li.dataset.suite = sec.key;
  const pref = state.expandedSuites[sec.key];
  const filterActive = state.runFilter !== 'all' || state.runSearch.trim() !== '';
  const expanded = filterActive ? true : (pref !== undefined ? pref : single);
  if (!expanded) li.classList.add('collapsed');
  const head = document.createElement('div');
  head.className = 'list-row list-head suite-head tree-row has-chevron';
  // A head that folds a section has to say whether it is open: the chevron is a picture.
  head.setAttribute('aria-expanded', String(expanded));
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = sec.title || 'No suite';
  const frac = document.createElement('span');
  // `.row-count` is the shared trailing figure; `.suite-frac` stays as the hook.
  frac.className = 'row-count suite-frac';
  const done = sec.rows.filter((r) => displayStatus(r) !== 'untested').length;
  frac.textContent = `${done}/${sec.rows.length}`;
  // A project's custom emoji draws instead (suiteEmojiOf — absent until the tree lands).
  head.append(StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron'),
    StatusIcons.treeIcon(StatusIcons.FILE, 'file-icon', suiteEmojiOf(sec.title)), title, frac);
  head.addEventListener('click', () => toggleSuite(sec.key, li));
  li.append(Roving.item(head));
  const rowsUl = document.createElement('ul');
  rowsUl.className = 'suite-rows tree-children';
  // The class hides the rows; `hidden` also takes them out of the arrow walk and a reader's way.
  rowsUl.hidden = !expanded;
  for (const r of rows) rowsUl.append(testRow(r));
  li.append(rowsUl);
  return li;
}

function toggleSuite(key, li) {
  const collapsed = li.classList.toggle('collapsed');
  state.expandedSuites[key] = !collapsed; // explicit pref overrides the default
  const rowsUl = li.querySelector(':scope > .suite-rows');
  if (rowsUl) rowsUl.hidden = collapsed;
  const head = li.querySelector(':scope > .suite-head');
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
}

// An actually empty run — nearly always one created outside the web UI.
function runNoTestsEmpty() {
  const s = state.settings || {};
  const actions = [];
  if (s.baseUrl && s.projectId && state.runId) {
    // The same `<host>/projects/<slug>/runs/<id>` shape RunsUrl.looksLikeRunUrl parses.
    const a = document.createElement('a');
    a.className = 'btn size-sm';
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}/runs/${encodeURIComponent(state.runId)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // A <span> label, not a text node: the leading-icon padding rule cannot see a text node.
    const label = document.createElement('span');
    label.textContent = 'Open in Testomat';
    a.append(label, StatusIcons.svgIcon('north_east', 16));
    actions.push(a);
  }
  return EmptyState.build({
    tag: 'li',
    icon: 'checklist',
    title: 'No tests in this run',
    text: 'Runs created outside the web UI can start out with an empty checklist.',
    actions,
  });
}

function runNoMatchEmpty() {
  const actions = [];
  if (state.runSearch.trim()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Clear search';
    b.addEventListener('click', clearRunSearch);
    actions.push(b);
  }
  if (state.runFilter !== 'all') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn size-sm';
    b.textContent = 'Show all tests';
    b.addEventListener('click', () => setRunFilter('all'));
    actions.push(b);
  }
  return EmptyState.build({
    tag: 'li',
    live: true, // it took over the status line's announcement
    icon: state.runSearch.trim() ? 'find_in_page' : 'filter_list_off',
    title: 'No tests match',
    text: state.runSearch.trim()
      ? 'No test or suite title in this run matches what you typed.'
      : 'No test in this run carries that status.',
    actions,
  });
}

function renderRunSections() {
  const ul = $('run-tests');
  // Before the empty-state return: the keyboard must not depend on which draw came first.
  Roving.attach(ul, { selector: RUN_ROW_SELECTOR });
  wireRunRowCells(ul);
  ul.replaceChildren();
  setStatusLine('run-status', '');
  if (!state.records.length) { ul.append(runNoTestsEmpty()); return; }
  let shown = 0;
  const secs = suiteSections();
  const single = secs.length === 1; // a lone suite renders expanded by default
  for (const sec of secs) {
    const rows = sec.rows.filter(rowVisible);
    if (!rows.length) continue;
    ul.append(suiteSection(sec, rows, single));
    shown += rows.length;
  }
  if (!shown) ul.append(runNoMatchEmpty());
}

function renderRunView() {
  renderRunHeader();
  RunInfo.render();
  renderRunFilterChips();
  syncRunSearch();
  renderRunSections();
  RunLock.applyRunLock({ force: true }); // the run-level note and the Finish/test-view gates
}
