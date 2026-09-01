// Choose-a-project screen: step two of the first run — the token is in, no project is
// resolved yet. The header switcher's popup used to stand in for this pick, which put the
// one thing there is to do inside a menu, floating over an empty panel. Same rows and the
// same filter as that popup (core/project-switcher.js owns both), given the whole screen.

/* global $, state, hostOf, show, setStatusLine, matchProjects, projectRowEl,
   switchProject, disconnectInstance */

// Screen-only state; the list itself is always `state.projects`. Deliberately NOT the
// popup's two variables: the two surfaces filter independently, and this one resets on entry.
let pickFilter = '';
let pickActiveId = null;

// No saved project to fold in here — that is what this screen is for — so the rows are the
// token's list as it stands.
const pickRows = () => matchProjects(state.projects, pickFilter);

// The keyboard cursor is the ROW's `.active`, and the filter owns focus for the whole
// screen, so it is what carries aria-activedescendant.
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

// ±1 through the VISIBLE rows, clamped at the edges (no wrap) — the popup's deal.
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

// Bound on the INPUT rather than at document level: this screen has no other control the
// arrows could mean, and the panel's own hotkeys are inert outside the test view.
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

// Entered fresh every time: a filter left over from a previous connection would hide rows
// the tester never typed at.
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

// Wire it once, from app init (the markup is static). The Disconnect writes to THIS
// screen's status line: the Connection card's own is on a page nobody can reach from here.
function initProjectPick() {
  $('pick-filter').addEventListener('input', onPickFilterInput);
  $('pick-filter').addEventListener('keydown', onPickFilterKey);
  $('pick-filter-clear').addEventListener('click', clearPickFilter);
  $('pick-disconnect').addEventListener('click', () => disconnectInstance({ statusId: 'pick-status' }));
}
