// First-run project pick: same rows and filter as the switcher popup (core/project-switcher.js).

/* global $, state, hostOf, show, setStatusLine, matchProjects, projectRowEl,
   switchProject, disconnectInstance */

// Not the popup's variables: the two surfaces filter independently and this one resets on entry.
let pickFilter = '';
let pickActiveId = null;

// No saved project to fold in here, so the rows are the token's list as it stands.
const pickRows = () => matchProjects(state.projects, pickFilter);

// The filter owns focus for the whole screen, so it carries aria-activedescendant for the rows.
function syncPickActive() {
  const input = $('pick-filter');
  if (!input) return;
  const li = pickActiveId ? $(`pick-opt-${pickActiveId}`) : null;
  if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
  else input.removeAttribute('aria-activedescendant');
}

function renderPickRows() {
  const list = $('pick-list');
  if (!list) return;
  const rows = pickRows();
  if (!rows.some((p) => p.id === pickActiveId)) pickActiveId = rows.length ? rows[0].id : null;
  list.replaceChildren(...rows.map((p) => projectRowEl(p, {
    current: null, // nothing is the active project yet — that is the pick being made
    activeId: pickActiveId,
    idPrefix: 'pick-opt-',
    className: 'project-option',
    onPick: switchProject,
  })));
  const empty = $('pick-empty');
  if (empty) empty.hidden = rows.length > 0;
  syncPickActive();
}

// Clamped at the edges (no wrap), matching the popup.
function movePickActive(delta) {
  const rows = pickRows();
  if (!rows.length) return;
  const from = rows.findIndex((p) => p.id === pickActiveId);
  const to = from === -1 ? 0 : Math.min(Math.max(from + delta, 0), rows.length - 1);
  pickActiveId = rows[to].id;
  const list = $('pick-list');
  if (list) for (const li of list.children) li.classList.toggle('active', li.dataset.projectId === pickActiveId);
  syncPickActive();
}

function onPickFilterInput() {
  const input = $('pick-filter');
  pickFilter = input ? input.value : '';
  pickActiveId = null; // the first match becomes the cursor
  $('pick-filter-clear').hidden = pickFilter.trim() === '';
  renderPickRows();
}

function clearPickFilter() {
  pickFilter = '';
  pickActiveId = null;
  $('pick-filter').value = '';
  $('pick-filter-clear').hidden = true;
  renderPickRows();
  $('pick-filter').focus();
}

// Bound on the input, not the document: no other control here could mean the arrows.
function onPickFilterKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    movePickActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter' && pickActiveId) {
    e.preventDefault();
    switchProject(pickActiveId);
  }
}

// Reset on every entry: a filter left from a previous connection would hide rows.
function openProjectPickView() {
  pickFilter = '';
  pickActiveId = null;
  const input = $('pick-filter');
  if (input) input.value = '';
  $('pick-filter-clear').hidden = true;
  setStatusLine('pick-status', '');
  const host = $('pick-host');
  if (host) host.textContent = hostOf(state.settings && state.settings.baseUrl) || '';
  renderPickRows();
  show('pick');
  // After show(), which is what unhides the section — a hidden field cannot take focus.
  if (input) input.focus();
}

// Disconnect writes to this screen's status line: the Connection card's is unreachable from here.
function initProjectPick() {
  $('pick-filter').addEventListener('input', onPickFilterInput);
  $('pick-filter').addEventListener('keydown', onPickFilterKey);
  $('pick-filter-clear').addEventListener('click', clearPickFilter);
  $('pick-disconnect').addEventListener('click', () => disconnectInstance({ statusId: 'pick-status' }));
}
