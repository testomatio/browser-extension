// Project switcher (#103). Options come from the ACTIVE instance token's own list
// (JWT `GET /api/projects`, `id` = the slug every v2 route carries).

/* global TestomatAPI, Handoff, $, state, hasChrome, hostOf, show, toast,
   openRunsView, openTcStudioView, fillSettingsForm, resetProjectScopedState,
   prefetchTabCounts, Tooltip, setStatusLine, openProjectPickView */

// Title plus the slug when they differ — two teams name projects alike.
const projectLabel = (p) => (p.title && p.title !== p.id ? `${p.title} (${p.id})` : p.id);

// Any session reaches every project the tester can see — it reads their keys as it goes. Only a
// connection left with nothing but ONE project's stored token is pinned, which is a handoff whose
// host has closed its browser and taken the session with it.
function projectPinned() {
  const s = state.settings;
  if (!s || !s.handoff || s.apiToken) return false;
  return !Handoff.offer();
}

// Popup-only state; the list itself is always `state.projects`.
let projectFilter = '';
let projectActiveId = null;

// The saved project is always among the rows, even before (or without) a list. With no project
// chosen yet, the rows are the token's list as it stands — the picker's (#11).
function projectRows() {
  const current = state.settings && state.settings.projectId;
  if (!current) return state.projects;
  const list = state.projects.length ? state.projects : [{ id: current, title: '' }];
  return list.some((p) => p.id === current) ? list : [{ id: current, title: '' }, ...list];
}

// Matched on title AND slug — either is what a tester remembers about a project. Shared with the
// choose-a-project screen (screens/project-pick.js), so both surfaces filter the same way.
function matchProjects(rows, filter) {
  const q = String(filter || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((p) => `${p.title || ''} ${p.id}`.toLowerCase().includes(q));
}

function filteredProjectRows() { return matchProjects(projectRows(), projectFilter); }

// The trigger carries the active project: label + `dataset.projectId`, which is
// what the panel's own e2e reads.
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
  // No project yet but a list to pick from: the trigger IS the picker (#11); `dataset.projectId`
  // (what the e2e reads) stays absent until a pick.
  const row = current ? projectRows().find((p) => p.id === current) : null;
  label.textContent = current ? (row ? projectLabel(row) : current) : 'Choose a project';
  if (current) trigger.dataset.projectId = current; else delete trigger.dataset.projectId;
  // aria-disabled, never `disabled`: a disabled button swallows the hover, and the tooltip is
  // the only place the reason fits.
  trigger.setAttribute('aria-disabled', projectPinned() ? 'true' : 'false');
  let hint = current ? `Active project: ${label.textContent}` : 'Choose a project';
  if (projectPinned()) {
    const app = (Handoff.offer() || {}).app || 'the app that opened this browser';
    hint = `Project chosen by ${app} — switch it there`;
  }
  Tooltip.set(trigger, hint);
  renderProjectOpenLink();
  bar.hidden = false;
  // A list landing mid-open repaints the rows under the tester's cursor.
  if ($('project-menu') && !$('project-menu').hidden) renderProjectOptions();
}

// The active project's page in the web app, `<active host>/projects/<slug>`. With
// nothing to link to it HIDES rather than point at a 404.
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

// ---- the dropdown (#126) -------------------------------------------------
// A native <select> is unusable here: Chrome renders its popup at OS level, which in
// a narrow side panel lands as a huge misplaced menu. Custom listbox instead (#34).

// ONE project row, for either surface — the popup's `.menu-option` here, the whole-screen picker's
// list row there (screens/project-pick.js). Only the SKIN differs: same two lines, same trailing
// count, same `dataset.projectId` the panel's own e2e reads.
function projectRowEl(p, { current, activeId, idPrefix, className, onPick }) {
  const li = document.createElement('li');
  li.id = `${idPrefix}${p.id}`;
  li.className = className;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', p.id === current ? 'true' : 'false');
  li.dataset.projectId = p.id;
  li.classList.toggle('active', p.id === activeId);
  // Two lines — title over slug — so neither clips the other (#10); the slug always renders, even when it equals the title, so no row comes up short (#30). The count rides at the trailing edge.
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
  // Shared trailing figure (`.row-count`, ROW TAIL in shared/components.css); a real 0 shows, an unknown count draws nothing.
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

// The filter input owns focus while the popup is open, so it is what carries
// aria-activedescendant.
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

// The menu hangs off the bar, not off the trigger, so BOTH boxes count as inside — otherwise a click on
// the filter or the list's scrollbar would read as outside and close the popup (full-width picker).
function onProjectDocClick(e) {
  const inside = ['project-dropdown', 'project-menu'].some((id) => $(id) && $(id).contains(e.target));
  if (!inside) closeProjectMenu();
}

// Handled at document level (capture) so they work wherever focus sits, and so the
// panel's own arrow/Enter handlers never see them.
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

// ±1 through the VISIBLE rows, clamped at the edges (no wrap).
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

// Closed-state keys open the popup; preventDefault also stops Enter/Space from
// firing the button's click (which would close it again).
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

// Best-effort: a failure (no session, offline) leaves the saved project as the only
// option and the panel keeps working — Settings' Save reports a bad token.
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
    // The stored session points at a run of the OLD project — drop it, or a reload
    // restores a run this project does not have.
    await chrome.storage.local.remove('session');
  } catch { /* best effort — a storage hiccup must not strand the switch */ }
}

async function switchProject(projectId) {
  const prev = state.settings;
  if (!prev || !projectId || projectId === prev.projectId) return;
  const first = !prev.projectId; // this connection's first pick — it lands on Runs (#11)
  // Drain first: a queued status carries a testrun id that means nothing in the next
  // project — replayed there it 404s and is dropped as unrecoverable.
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
  // The connect verdict lives in the Connection card now (renderConnection), so the
  // first pick only clears the line the save left behind.
  if (first) { setStatusLine('settings-status', ''); await openRunsView(); }
  else if (state.activeTab === 'settings') { fillSettingsForm(); show('settings'); }
  else if (state.activeTab === 'tests') await openTcStudioView();
  else await openRunsView();
  // Count the OTHER tab too — a blank chip reads as "empty project", not "not looked
  // at yet". Not awaited: the switch is done, the chips fill in behind it.
  prefetchTabCounts();
  const p = state.projects.find((x) => x.id === projectId);
  toast(`${first ? 'Connected to' : 'Switched to'} ${p ? (p.title || p.id) : projectId}`);
}

// Token in, project not: its own screen (screens/project-pick.js). The header popup used to stand in
// for it, which put the one thing there is to do on that screen inside a menu, over an empty panel.
function askForProject() {
  fillSettingsForm(); // the full form is what a Disconnect from there leaves behind
  openProjectPickView();
}

// Boot: paint the saved project, then fill the list in the background. A config without a project
// resolves one the way Save does — a lone project is taken, several are the tester's pick (#11).
// 'ready' | 'choose' | 'none' — none means nothing to run against, so init lands on Settings.
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
