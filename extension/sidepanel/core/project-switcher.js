// Options come from the active instance token's list (`GET /api/projects`, `id` = the v2 slug).

/* global TestomatAPI, Handoff, $, state, hasChrome, hostOf, show, toast,
   openRunsView, openTcStudioView, fillSettingsForm, resetProjectScopedState,
   prefetchTabCounts, Tooltip, setStatusLine, openProjectPickView */

// Title plus the slug when they differ — two teams name projects alike.
const projectLabel = (p) => (p.title && p.title !== p.id ? `${p.title} (${p.id})` : p.id);

// Only a connection left with one project's stored token is pinned: a handoff whose host is gone.
function projectPinned() {
  const s = state.settings;
  if (!s || !s.handoff || s.apiToken) return false;
  return !Handoff.offer();
}

// Popup-only state; the list itself is always `state.projects`.
let projectFilter = '';
let projectActiveId = null;

// The saved project is always among the rows, even before (or without) a list.
function projectRows() {
  const current = state.settings && state.settings.projectId;
  if (!current) return state.projects;
  const list = state.projects.length ? state.projects : [{ id: current, title: '' }];
  return list.some((p) => p.id === current) ? list : [{ id: current, title: '' }, ...list];
}

// Matched on title and slug: either is what a tester remembers; screens/project-pick.js shares it.
function matchProjects(rows, filter) {
  const q = String(filter || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => `${p.title || ''} ${p.id}`.toLowerCase().includes(q));
}

function filteredProjectRows() { return matchProjects(projectRows(), projectFilter); }

// `dataset.projectId` on the trigger is what the panel's own e2e reads.
function renderProjectBar() {
  const bar = $('project-bar');
  const trigger = $('project-trigger');
  const label = $('project-current');
  if (!bar || !trigger || !label) return;
  const current = state.settings && state.settings.projectId;
  if (!current && !state.projects.length) {
    closeProjectMenu();
    bar.hidden = true;
    label.textContent = '';
    delete trigger.dataset.projectId;
    renderProjectOpenLink();
    return;
  }
  // No project yet but a list: the trigger is the picker, and `dataset.projectId` stays absent.
  const row = current ? projectRows().find((p) => p.id === current) : null;
  label.textContent = current ? (row ? projectLabel(row) : current) : 'Choose a project';
  if (current) trigger.dataset.projectId = current; else delete trigger.dataset.projectId;
  // aria-disabled, never `disabled`: a disabled button swallows the hover the tooltip needs.
  trigger.setAttribute('aria-disabled', projectPinned() ? 'true' : 'false');
  let hint = current ? `Active project: ${label.textContent}` : 'Choose a project';
  if (projectPinned()) {
    // A pin is an offer that is gone, so the name comes from `handoffApp`, written by connect().
    const app = state.settings.handoffApp || 'the app that opened this browser';
    hint = `Project chosen by ${app} — switch it there`;
  }
  Tooltip.set(trigger, hint);
  renderProjectOpenLink();
  bar.hidden = false;
  // A list landing mid-open repaints the rows under the tester's cursor.
  if ($('project-menu') && !$('project-menu').hidden) renderProjectOptions();
}

// With nothing to link to, the link hides rather than point at a 404.
function renderProjectOpenLink() {
  const a = $('project-open');
  if (!a) return;
  const s = state.settings || {};
  if (s.baseUrl && s.projectId) {
    a.href = `${s.baseUrl}/projects/${encodeURIComponent(s.projectId)}`;
    a.hidden = false;
  } else {
    a.removeAttribute('href');
    a.hidden = true;
  }
}

// Not a native <select>: Chrome draws its popup at OS level, huge and misplaced in a narrow panel.

// One project row for either surface; only the skin differs, same `dataset.projectId` the e2e reads.
function projectRowEl(p, { current, activeId, idPrefix, className, onPick }) {
  const li = document.createElement('li');
  li.id = `${idPrefix}${p.id}`;
  li.className = className;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', p.id === current ? 'true' : 'false');
  li.dataset.projectId = p.id;
  li.classList.toggle('active', p.id === activeId);
  // Two lines so neither clips the other; the slug always renders, so no row comes up short.
  const lines = document.createElement('div');
  lines.className = 'project-option-lines';
  const title = document.createElement('span');
  title.className = 'project-option-title';
  title.textContent = p.title || p.id;
  lines.append(title);
  const slug = document.createElement('span');
  slug.className = 'project-option-slug';
  slug.textContent = p.id;
  lines.append(slug);
  li.append(lines);
  // A real 0 count shows; an unknown count draws nothing.
  if (p.testsCount != null && Number.isFinite(Number(p.testsCount))) {
    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = Number(p.testsCount).toLocaleString('en-US').replace(/,/g, ' ');
    Tooltip.set(count, `${Number(p.testsCount)} tests`);
    li.append(count);
  }
  li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the filter
  li.addEventListener('click', () => onPick(p.id));
  return li;
}

// The active row is the keyboard cursor; the current project is the selected one.
function renderProjectOptions() {
  const list = $('project-list');
  if (!list) return;
  const current = state.settings && state.settings.projectId;
  const rows = filteredProjectRows();
  if (!rows.some((p) => p.id === projectActiveId)) projectActiveId = rows.length ? rows[0].id : null;
  list.replaceChildren(...rows.map((p) => projectRowEl(p, {
    current,
    activeId: projectActiveId,
    idPrefix: 'project-opt-',
    className: 'menu-option project-option',
    onPick: pickProject,
  })));
  const empty = $('project-empty');
  if (empty) empty.hidden = rows.length > 0;
  syncProjectActiveOption();
}

// The filter input owns focus while open, so it carries aria-activedescendant.
function syncProjectActiveOption() {
  const input = $('project-filter');
  if (!input) return;
  const li = projectActiveId ? $(`project-opt-${projectActiveId}`) : null;
  if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  else input.removeAttribute('aria-activedescendant');
}

function openProjectMenu() {
  const menu = $('project-menu');
  const trigger = $('project-trigger');
  if (!menu || !trigger || !menu.hidden || projectPinned()) return;
  projectFilter = '';
  projectActiveId = state.settings ? state.settings.projectId : null; // open on the active one
  const input = $('project-filter');
  if (input) input.value = '';
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  renderProjectOptions();
  if (input) input.focus(); // typing filters straight away
  document.addEventListener('click', onProjectDocClick, true);
  document.addEventListener('keydown', onProjectMenuKey, true);
}

function closeProjectMenu({ focus = false } = {}) {
  const menu = $('project-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const trigger = $('project-trigger');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }
  document.removeEventListener('click', onProjectDocClick, true);
  document.removeEventListener('keydown', onProjectMenuKey, true);
}

// Both boxes count as inside, or a click on the filter or the scrollbar would close the popup.
function onProjectDocClick(e) {
  const inside = ['project-dropdown', 'project-menu'].some((id) => $(id) && $(id).contains(e.target));
  if (!inside) closeProjectMenu();
}

// Document-level capture, so the panel's own arrow/Enter handlers never see these keys.
function onProjectMenuKey(e) {
  const menu = $('project-menu');
  if (!menu || menu.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeProjectMenu({ focus: true }); return; }
  if (e.key === 'Tab') { closeProjectMenu(); return; } // focus is leaving — let it
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveProjectActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (projectActiveId) pickProject(projectActiveId);
  }
}

// Through the visible rows only, clamped at the edges (no wrap).
function moveProjectActive(delta) {
  const rows = filteredProjectRows();
  if (!rows.length) return;
  const from = rows.findIndex((p) => p.id === projectActiveId);
  const to = from === -1 ? 0 : Math.min(Math.max(from + delta, 0), rows.length - 1);
  projectActiveId = rows[to].id;
  const list = $('project-list');
  if (list) for (const li of list.children) li.classList.toggle('active', li.dataset.projectId === projectActiveId);
  syncProjectActiveOption();
}

function onProjectFilterInput() {
  const input = $('project-filter');
  projectFilter = input ? input.value : '';
  projectActiveId = null; // the first match becomes the cursor
  renderProjectOptions();
}

function onProjectTriggerClick(e) {
  e.stopPropagation(); // the doc-level close listener would swallow the toggle
  if ($('project-menu').hidden) openProjectMenu(); else closeProjectMenu({ focus: true });
}

// preventDefault also stops Enter/Space firing the button's click, which would close it again.
function onProjectTriggerKey(e) {
  if (!$('project-menu').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openProjectMenu();
  }
}

// Close first: the switch repaints whole views.
function pickProject(projectId) {
  closeProjectMenu({ focus: true });
  switchProject(projectId);
}

// Wire the dropdown once, from app init (the markup is static).
function initProjectDropdown() {
  $('project-trigger').addEventListener('click', onProjectTriggerClick);
  $('project-trigger').addEventListener('keydown', onProjectTriggerKey);
  $('project-filter').addEventListener('input', onProjectFilterInput);
}

// Best-effort: a failure leaves the saved project as the only option; Save reports a bad token.
async function refreshProjects() {
  if (!Handoff.credentialed(state.settings)) return [];
  let projects;
  try { projects = await TestomatAPI.listProjects(); } catch { return []; }
  state.projects = projects;
  renderProjectBar();
  return projects;
}

// Writes the same two keys Save does, so a reload restores what is on screen.
async function persistActiveSettings(settings) {
  const host = hostOf(settings.baseUrl);
  if (host) state.hostSettings = { ...state.hostSettings, [host]: settings };
  if (!hasChrome) return;
  try {
    await chrome.storage.local.set({ settings, hostSettings: state.hostSettings });
    // The stored session points at a run of the old project; a reload must not restore it.
    await chrome.storage.local.remove('session');
  } catch { /* best effort — a storage hiccup must not strand the switch */ }
}

async function switchProject(projectId) {
  const prev = state.settings;
  if (!prev || !projectId || projectId === prev.projectId) return;
  const first = !prev.projectId; // this connection's first pick — it lands on Runs
  // Drain first: a queued status's testrun id 404s in the next project and is dropped.
  if (typeof OfflineQueue !== 'undefined' && OfflineQueue.count()) {
    try { await OfflineQueue.replay(); } catch { /* nothing more we can do here */ }
  }
  const settings = { ...prev, projectId };
  state.settings = settings;
  Handoff.configure(settings); // also drops the old project's JWT
  resetProjectScopedState();
  await persistActiveSettings(settings);
  renderProjectBar();
  // Stay on the tab the tester is on, but at its root: the open run/test is gone.
  if (first) { setStatusLine('settings-status', ''); await openRunsView(); }
  else if (state.activeTab === 'settings') { fillSettingsForm(); show('settings'); }
  else if (state.activeTab === 'tests') await openTcStudioView();
  else await openRunsView();
  // Count the other tab too: a blank chip reads as an empty project. Not awaited.
  prefetchTabCounts();
  const p = state.projects.find((x) => x.id === projectId);
  toast(`${first ? 'Connected to' : 'Switched to'} ${p ? (p.title || p.id) : projectId}`);
}

// Token in, project not: its own screen (screens/project-pick.js), not a menu over an empty panel.
function askForProject() {
  fillSettingsForm(); // the full form is what a Disconnect from there leaves behind
  openProjectPickView();
}

// A config without a project takes a lone one, else the tester picks; 'none' lands on Settings.
async function initProjectSwitcher() {
  renderProjectBar();
  if (state.settings && state.settings.projectId) {
    refreshProjects(); // background: the dropdown fills in when it lands
    return 'ready';
  }
  const projects = await refreshProjects();
  if (!projects.length) return 'none';
  if (projects.length > 1) return 'choose';
  const settings = { ...state.settings, projectId: projects[0].id };
  state.settings = settings;
  Handoff.configure(settings);
  await persistActiveSettings(settings);
  renderProjectBar();
  return 'ready';
}
