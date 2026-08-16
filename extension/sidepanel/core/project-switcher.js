// Project switcher (#103): the active project lives in the panel header, on every
// tab, instead of a Project ID field in Settings. Options come from the token's
// own project list (JWT `GET /api/projects`, `id` = the slug the v2 routes carry).
// The control is a custom dropdown with a type-to-filter input (#126) — a native
// <select> pops an OS-level menu that swallows the narrow panel.
// Switching rewrites `settings.projectId`, wipes every project-scoped piece of
// state and lands the active tab on its root — nothing of the old project leaks.
//
// Per-host model is untouched: the list belongs to the ACTIVE instance's token, so
// an instance switch re-resolves it (screens/settings.js `saveSettings`).

/* global TestomatAPI, $, state, hasChrome, hostOf, show, toast,
   openRunsView, openTcStudioView, fillSettingsForm, resetProjectScopedState,
   prefetchTabCounts, Tooltip */

// Row label: the title, plus the slug when they differ — two teams name projects
// alike, and the slug is what every API path and pasted URL actually carries.
const projectLabel = (p) => (p.title && p.title !== p.id ? `${p.title} (${p.id})` : p.id);

// Dropdown-only state (#126): the filter text and the keyboard-active row live
// for as long as the popup is open. The list itself is always `state.projects`.
let projectFilter = '';
let projectActiveId = null;

// The rows the dropdown offers. The saved project is always one of them, even
// before (or without) a list — the header must show the truth the panel is
// working against, never an empty box.
function projectRows() {
  const current = state.settings && state.settings.projectId;
  if (!current) return [];
  const list = state.projects.length ? state.projects : [{ id: current, title: '' }];
  return list.some((p) => p.id === current) ? list : [{ id: current, title: '' }, ...list];
}

// Type-to-filter (#126): matched on title AND slug, since either is what the
// tester remembers about a project.
function filteredProjectRows() {
  const q = projectFilter.trim().toLowerCase();
  const rows = projectRows();
  if (!q) return rows;
  return rows.filter((p) => `${p.title || ''} ${p.id}`.toLowerCase().includes(q));
}

// Paint the strip: the trigger carries the active project (label + a machine
// readable `dataset.projectId`, which is what the panel's own tests read).
// Hidden until a project is known.
function renderProjectBar() {
  const bar = $('project-bar');
  const trigger = $('project-trigger');
  const label = $('project-current');
  if (!bar || !trigger || !label) return;
  const current = state.settings && state.settings.projectId;
  if (!current) {
    closeProjectMenu();
    bar.hidden = true;
    label.textContent = '';
    delete trigger.dataset.projectId;
    renderProjectOpenLink();
    return;
  }
  const row = projectRows().find((p) => p.id === current);
  label.textContent = row ? projectLabel(row) : current;
  trigger.dataset.projectId = current;
  Tooltip.set(trigger, `Active project: ${label.textContent}`);
  renderProjectOpenLink();
  bar.hidden = false;
  // A list landing mid-open repaints the rows under the tester's cursor.
  if ($('project-menu') && !$('project-menu').hidden) renderProjectOptions();
}

// The strip's second control: the active project's page in the web app,
// `<active host>/projects/<slug>` — the same route every run/test URL the panel
// parses hangs under. Both halves come from the ACTIVE settings and it is
// repainted from renderProjectBar(), so a project switch (or an instance switch,
// which repaints the same way) repoints it. With nothing to link to it HIDES
// rather than point at a 404 — the same deal "New run ↗" makes (#118).
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
// A native <select> is unusable here: Chrome renders its popup at OS level, and
// in a narrow side panel that lands as a huge misplaced menu over everything.
// This is the same custom-listbox pattern the editor's priority picker uses (#34).

// Paint the option rows for the current filter; the active row is the keyboard
// cursor, the current project is the selected one.
function renderProjectOptions() {
  const list = $('project-list');
  if (!list) return;
  const current = state.settings && state.settings.projectId;
  const rows = filteredProjectRows();
  if (!rows.some((p) => p.id === projectActiveId)) projectActiveId = rows.length ? rows[0].id : null;
  list.replaceChildren(...rows.map((p) => {
    const li = document.createElement('li');
    li.id = `project-opt-${p.id}`;
    li.className = 'menu-option project-option';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', p.id === current ? 'true' : 'false');
    li.dataset.projectId = p.id;
    li.classList.toggle('active', p.id === projectActiveId);
    const title = document.createElement('span');
    title.className = 'project-option-title';
    title.textContent = p.title || p.id;
    li.append(title);
    if (p.title && p.title !== p.id) {
      const slug = document.createElement('span');
      slug.className = 'project-option-slug';
      slug.textContent = p.id;
      li.append(slug);
    }
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the filter
    li.addEventListener('click', () => pickProject(p.id));
    return li;
  }));
  const empty = $('project-empty');
  if (empty) empty.hidden = rows.length > 0;
  syncProjectActiveOption();
}

// The filter input owns focus while the popup is open, so it is what points a
// screen reader at the active row.
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
  if (!menu || !trigger || !menu.hidden) return;
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

function onProjectDocClick(e) {
  const dd = $('project-dropdown');
  if (dd && !dd.contains(e.target)) closeProjectMenu();
}

// Open-state keys are handled at document level (capture) so they work wherever
// focus sits, and so the panel's own arrow/Enter handlers never see them.
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

// ±1 through the VISIBLE rows, clamped at the edges (no wrap) — same rule as the
// test-view arrows.
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

// A pick closes first — the switch repaints whole views — then repoints the
// panel. `switchProject()` itself ignores a pick of the active project.
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

// Fetch the token's projects into state and repaint. Best-effort by design: a
// failure (no session, offline) leaves the saved project as the only option and
// the panel keeps working on it — Settings' Save is where a bad token is reported.
async function refreshProjects() {
  if (!state.settings || !state.settings.apiToken) return [];
  let projects;
  try { projects = await TestomatAPI.listProjects(); } catch { return []; }
  state.projects = projects;
  renderProjectBar();
  return projects;
}

// Persist the active settings + their per-host entry (the switcher writes the same
// two keys Save does, so a reload restores the project that is on screen).
async function persistActiveSettings(settings) {
  const host = hostOf(settings.baseUrl);
  if (host) state.hostSettings = { ...state.hostSettings, [host]: settings };
  if (!hasChrome) return;
  try {
    await chrome.storage.local.set({ settings, hostSettings: state.hostSettings });
    // The stored session points at a run of the OLD project — drop it so a reload
    // before the next persist can't restore a run this project doesn't have.
    await chrome.storage.local.remove('session');
  } catch { /* best effort — a storage hiccup must not strand the switch */ }
}

async function switchProject(projectId) {
  const prev = state.settings;
  if (!prev || !projectId || projectId === prev.projectId) return;
  // Drain first: a queued status belongs to the project we are leaving, and its
  // testrun id means nothing in the next one — replayed there it would 404 and be
  // dropped as unrecoverable. Best effort; still-offline entries just stay queued.
  if (typeof OfflineQueue !== 'undefined' && OfflineQueue.count()) {
    try { await OfflineQueue.replay(); } catch { /* nothing more we can do here */ }
  }
  const settings = { ...prev, projectId };
  state.settings = settings;
  TestomatAPI.configure(settings); // also drops the old project's JWT
  resetProjectScopedState();
  await persistActiveSettings(settings);
  renderProjectBar();
  // Stay on the tab the tester is on, but at its root: the open run/test is gone.
  if (state.activeTab === 'settings') { fillSettingsForm(); show('settings'); }
  else if (state.activeTab === 'tests') await openTcStudioView();
  else await openRunsView();
  // …and count the OTHER tab too. The view above filled its own chip; the tab
  // the tester is not standing on would otherwise show nothing until visited,
  // which reads as "empty project" rather than "not looked yet". Not awaited:
  // the switch is done, the toast is owed now, the chips fill in behind it.
  prefetchTabCounts();
  const p = state.projects.find((x) => x.id === projectId);
  toast(`Switched to ${p ? (p.title || p.id) : projectId}`);
}

// Boot: paint the saved project immediately, then fill the list in the background.
// A stored config with NO project (hand-edited, or a token saved before its list
// could load) resolves one silently — returns false when even that is impossible,
// so init can drop the tester on Settings instead of a wall of 404s.
async function initProjectSwitcher() {
  renderProjectBar();
  if (state.settings && state.settings.projectId) {
    refreshProjects(); // background: the dropdown fills in when it lands
    return true;
  }
  const projects = await refreshProjects();
  if (!projects.length) return false;
  const settings = { ...state.settings, projectId: projects[0].id };
  state.settings = settings;
  TestomatAPI.configure(settings);
  await persistActiveSettings(settings);
  renderProjectBar();
  return true;
}
