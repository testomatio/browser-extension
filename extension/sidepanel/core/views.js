// Core views: the view switcher (show), tab navigation, the contextual header
// row, in-tab back navigation, toasts and status lines.

/* global TestomatAPI, Handoff, Icons, Roving, Skeleton, Sk, loadRunsCount, loadTestsCount, Tooltip,
   PriorityIcons, refreshProjects, refreshRuns, openRunView, openTestView,
   openTcStudioView, refreshTcList, openTestSuitePicker */

// ---------- tab model ----------
// `promote` is the suite picker's historical view name (see tc-studio.js).
const TAB_OF_VIEW = {
  tcstudio: 'tests', tclist: 'tests', promote: 'tests',
  runs: 'runs', run: 'runs', test: 'runs',
  // `pick` is the choose-a-project screen: it stands BEFORE the tabs (nothing is scoped yet)
  // and hides them, but it is the Settings tab it belongs to — the one tab reachable unconfigured.
  settings: 'settings', pick: 'settings',
};
const TABS = ['tests', 'runs', 'settings'];
// A tab's landing view: the contextual row (Back + title) is hidden there.
const ROOT_VIEWS = new Set(['tcstudio', 'runs', 'settings', 'pick']);
// Where a tab stands before it has stood anywhere — the section `aria-controls` names
// until state.tabViews remembers one of its own (openTabView lands on these same three).
const TAB_ROOT = { tests: 'tcstudio', runs: 'runs', settings: 'settings' };

// ---------- view switching ----------

function show(view) {
  // Before the switch, not after: the screens that load raise their own
  // placeholder immediately after calling this.
  Skeleton.bootDone();
  Skeleton.hide();
  state.view = view;
  const tab = TAB_OF_VIEW[view] || 'runs';
  state.activeTab = tab;
  state.tabViews[tab] = view;
  document.body.dataset.view = view; // CSS + e2e hook
  for (const v of views) $(`view-${v}`).hidden = v !== view;
  // AFTER the loop above: it focuses the token field, which a still-hidden
  // section cannot take.
  if (typeof applyConnectMode === 'function') applyConnectMode();
  focusShownView(view);
  updateContextBar(view);
  updateTabBar();
  applyReadonlyBlock();   // #155: a read-only project shows the lockout, not the view
  updateDegradedBanner(); // slim degraded strip is per-view (runs/run only)
  if (typeof updatePendingBanner === 'function') updatePendingBanner(); // offline-queue pending strip
  // Guarded: evidence.js loads after core and may be absent in a test context.
  if (typeof onViewShown === 'function') onViewShown(view);
  persistSession();
}

// The caret follows the switch only where the switch took it away — nothing focused, or a field
// in a section this call just hid. A screen that focuses one of its own (project-pick) keeps it.
function focusShownView(view) {
  const at = document.activeElement;
  const lost = !at || at === document.body
    || views.some((v) => { const s = $(`view-${v}`); return s.hidden && s.contains(at); });
  if (lost) $(`view-${view}`)?.focus();
}

// The LAST crumb of the path, printed as the screen's title, not as a link.
// Empty on a tab root (the row is hidden there).
function contextTitleFor(view) {
  if (view === 'run') return state.runTitle || 'Run';
  if (view === 'test') return state.testTitle || 'Test';
  if (view === 'tclist') return state.tcSuiteTitle || 'Suite';
  if (view === 'promote') return 'Choose suite';
  return '';
}

// Marks set at the head of the title, in list-row order: priority, then type.
// A run carries none — its kind and status are pills right under this row.
function contextTitleMarks(view) {
  if (view === 'tclist') return [treeIcon(FILE_ICON, 'file-icon', state.tcSuiteEmoji)];
  if (view === 'test') {
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return [
      testPriorityMark(rec),
      rec && typeof TestType !== 'undefined' ? TestType.forRecord(rec) : null,
    ];
  }
  return [];
}

// Priority: the JWT detail first, else the v2 record; absent/unknown IS `normal`
// (shared/priority-icons.js). A pending read holds the slot so the title cannot shift.
function testPriorityMark(rec) {
  if (typeof PriorityIcons === 'undefined') return null;
  const p = state.testrunDetail?.data?.attributes?.test?.priority || rec?.priority || '';
  if (!p && state.testDetailPending) {
    const slot = document.createElement('span');
    slot.className = 'prio';
    if (typeof Sk !== 'undefined') slot.append(Sk.bar('circle')); // cut to 12px by .prio's own rule
    return slot;
  }
  return PriorityIcons.mark(p);
}

// The path to the open view, root-first, stopping at its PARENT (the title is the
// last crumb). Same targets goBack() walks, so trail and arrow agree on "up".
const CONTEXT_TRAILS = {
  run: () => [{ label: 'Runs', open: openRunsView }],
  test: () => [
    { label: 'Runs', open: openRunsView },
    { label: state.runTitle || 'Run', open: () => openRunView(state.runId, state.runTitle) },
  ],
  tclist: () => [{ label: 'Tests', open: openTcStudioView }],
  promote: () => [{ label: 'Tests', open: openTcStudioView }],
};

// Crumbs after the root give up width first; what they lose comes back as a
// tooltip and as their accessible name.
function renderContextCrumbs(view) {
  const nav = $('context-crumbs');
  if (!nav) return;
  const trail = (CONTEXT_TRAILS[view] || (() => []))();
  nav.hidden = !trail.length;
  nav.replaceChildren();
  trail.forEach((crumb, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.setAttribute('aria-hidden', 'true'); // the list is already a nav
      sep.textContent = '/';
      nav.append(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb';
    btn.textContent = crumb.label;
    if (i) { Tooltip.set(btn, crumb.label); btn.setAttribute('aria-label', crumb.label); }
    btn.addEventListener('click', crumb.open);
    nav.append(btn);
  });
}

// The way out to the web app for whatever this row names. The routes are the
// product's own (Ember), and every id here IS the public uid v2 serializes.

const CONTEXT_WEB_TARGET = {
  run: () => (state.runId ? ['run', `runs/${encodeURIComponent(state.runId)}`] : null),
  test: () => {
    // #203: links to the TESTRUN record, not the test case — a parametrized run
    // has many records sharing one test_id, which cannot name the row on screen.
    if (state.runId && state.currentRecordId) {
      return ['test', `runs/${encodeURIComponent(state.runId)}/test/${encodeURIComponent(state.currentRecordId)}`];
    }
    // No run around the record: the test CASE page (singular route, #113).
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return rec && rec.test_id ? ['test', `test/${encodeURIComponent(rec.test_id)}`] : null;
  },
  tclist: () => (state.tcSuiteId ? ['suite', `suite/${encodeURIComponent(state.tcSuiteId)}`] : null),
};

// With no target — the suite picker, a locked project, an id that is not known
// yet — it HIDES rather than point at a 404.
function renderContextOpenLink(view) {
  const a = $('context-open');
  if (!a) return;
  const s = state.settings || {};
  const target = capabilities.readonly ? null : (CONTEXT_WEB_TARGET[view] || (() => null))();
  if (!target || !s.baseUrl || !s.projectId) {
    a.removeAttribute('href');
    a.hidden = true;
    return;
  }
  const [noun, path] = target;
  const base = String(s.baseUrl).replace(/\/+$/, '');
  a.href = `${base}/projects/${encodeURIComponent(s.projectId)}/${path}`;
  const label = `Open this ${noun} in Testomat`;
  Tooltip.set(a, label);
  a.setAttribute('aria-label', label);
  a.hidden = false;
}

// The Rec chip MOVES between the tabs row and the contextual row instead of living in
// one — its own visibility rule (screens/evidence.js) decides which views show it.
function homeRecSlot(contextual) {
  const slot = $('rec-slot');
  const host = contextual ? $('context-bar') : $('header-top');
  if (slot && host && slot.parentElement !== host) host.append(slot);
}

// The same move for the one Refresh (#27): on a drill-down the two rows above fold
// away, so the button rides along into the only chrome left instead of going
// unreachable. Its listener survives the move, and it keeps its seat left of the open-link.
function homeRefreshButton(contextual) {
  const btn = $('btn-refresh');
  const host = contextual ? $('context-bar') : $('project-bar');
  const before = contextual ? $('context-open') : $('project-open');
  if (btn && host && before && btn.parentElement !== host) host.insertBefore(btn, before);
}

// Contextual header row (#127): outside a tab root it is the panel's only chrome —
// the project strip and the tab row fold away (immersive), hence the trail here.
function updateContextBar(view) {
  const contextual = !ROOT_VIEWS.has(view);
  $('context-bar').hidden = !contextual;
  $('btn-back').hidden = !contextual; // redundant with the row, kept explicit
  const title = $('context-title');
  const name = contextual ? contextTitleFor(view) : '';
  const marks = contextual ? contextTitleMarks(view) : [];
  title.replaceChildren(...[...marks, name].filter(Boolean));
  renderContextCrumbs(contextual ? view : null);
  renderContextOpenLink(contextual ? view : null);
  setImmersive(contextual);
  // Measured AFTER the row is shown — a hidden box reports nothing cut. The NAME
  // alone, not the row's text, whose leading mark the reader can already see.
  Tooltip.set(title, title.scrollHeight > title.clientHeight + 1 ? name : '');
}

// The one writer of the immersive flag — CSS folds the two rows above away on it.
function setImmersive(on) {
  document.body.dataset.immersive = on ? 'true' : 'false';
  homeRecSlot(on);
  homeRefreshButton(on);
}

// Repaint for a title that settles after the view opened (a run detail landing late).
function refreshContextBar() { updateContextBar(state.view); }

// First-launch gate: until settings are configured, only Settings is reachable.
function updateTabBar() {
  const configured = isConfigured(); // token AND a resolved project (#103)
  for (const tab of TABS) {
    const btn = $(`tab-${tab}`);
    if (!btn) continue;
    const active = state.activeTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    const disabled = !configured && tab !== 'settings';
    btn.disabled = disabled;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    Tooltip.set(btn, disabled ? 'Configure settings first' : '');
    // One tab stop for the whole bar, the arrows between the three: the tablist convention, and
    // three stops fewer on the way to the screen.
    btn.setAttribute('tabindex', active ? '0' : '-1');
    // Three tabs over eight sections, so the panel a tab names is the one it would show right
    // now. A disabled tab names none — it cannot open one.
    if (disabled) btn.removeAttribute('aria-controls');
    else btn.setAttribute('aria-controls', `view-${state.tabViews[tab] || TAB_ROOT[tab]}`);
  }
  // Wired once per container and free on every later call (shared/roving.js). Roving.item() is
  // NOT used here: it writes role="button" over the role="tab" the markup already carries.
  Roving.attach($('tabbar'), { selector: '.tab', orientation: 'horizontal' });
}

// Three-state by design: a number (0 included) SHOWS the chip, unknown — nothing
// fetched yet, or a server that sent no total — HIDES it. The bar may not guess.
function setTabCount(tab, n) {
  const el = $(`tab-${tab}-count`);
  if (!el) return;
  const known = Number.isFinite(n) && n >= 0;
  el.hidden = !known;
  if (known) paintCounter(el, n);
  else el.textContent = '';
}
// A declaration, not a const arrow: state.js reaches for it through `typeof`,
// and `typeof` is not TDZ-safe for a lexical binding in another classic script.
function resetTabCounts() { for (const t of TABS) setTabCount(t, null); }

// Re-painting the same value is silent — a count that did not move must not blink.
// Replaying the keyframe needs the class off, a layout read, then the class back on.
function paintCounter(el, text) {
  if (!el || el.textContent === String(text)) return;
  el.textContent = String(text);
  el.classList.remove('settled');
  void el.offsetWidth; // forces the restart — see above
  el.classList.add('settled');
}

// The flash is ONE-SHOT. A CSS animation replays whenever its element comes back from
// `display:none`, so a class left sitting there re-fades every counter on screen after
// each Back — the filter chips, and the tab chips the immersive fold takes away and
// gives back — a beat behind the rest of the screen. One delegated listener drops it on
// the way out; paintCounter puts it back for the next value that actually moved.
function initCounterFade() {
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'counter-in') e.target.classList.remove('settled');
  });
}

// The chip IS the count's state — a visible one means a number is known.
const tabCountKnown = (tab) => { const el = $(`tab-${tab}-count`); return !!el && !el.hidden; };

// Fills only what is still UNKNOWN: the tab that loaded owns its own number (its
// paging cursor / suite tree), and a second, separately derived count must not win.
function prefetchTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count (#155)
  const epoch = state.projectEpoch; // a further switch mid-fetch discards these
  const jobs = [];
  if (!tabCountKnown('tests')) jobs.push(loadTestsCount(epoch));
  if (!tabCountKnown('runs')) jobs.push(loadRunsCount(epoch));
  return Promise.all(jobs);
}

// ---------- the panel-wide refresh ----------
// Re-entrancy is blocked, not queued: a second click while the first is in flight
// would duplicate every request it is still waiting on.
let refreshingAll = false;
async function refreshAll() {
  if (refreshingAll) return;
  refreshingAll = true;
  // Disabled + spun BEFORE the first await, so nothing reads it as idle mid-refresh.
  const btn = $('btn-refresh');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    await refreshProjects();       // best effort by contract; never throws
    await refreshCurrentView();
    await refreshTabCounts();
  } finally {
    refreshingAll = false;
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// Re-pull the open view WITHOUT navigating; each leg is that screen's own load path —
// its opener, or an in-place re-read where re-opening would throw away what the screen
// already holds (tclist, #27). Failures stay the screens' — those paths report them.
function refreshCurrentView() {
  const v = state.view;
  if (v === 'runs') return refreshRuns();
  if (v === 'run' && state.runId) return openRunView(state.runId, state.runTitle);
  if (v === 'test' && state.currentRecordId) return openTestView(state.currentRecordId);
  if (v === 'tcstudio') return openTcStudioView();
  if (v === 'tclist') return refreshTcList();
  if (v === 'promote') return openTestSuitePicker(); // the + New test picker
  // Settings holds no server data of its own.
  return Promise.resolve();
}

// Both counts unconditionally, minus the tests chip when the suite tree just
// derived it. The runs chip is a project total the runs list never derives.
function refreshTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count (#155)
  const epoch = state.projectEpoch; // a project switch mid-fetch discards these
  const jobs = [loadRunsCount(epoch)];
  if (state.view !== 'tcstudio') jobs.push(loadTestsCount(epoch));
  return Promise.all(jobs);
}

// ---------- filter chips: the row that sends its overflow to a menu ----------
// Measured, not guessed — the panel is user-resizable and counts change width, so
// there is no breakpoint: hide one chip at a time from the right, never "All".
const filterFitWidth = new WeakMap(); // last width each row was fitted at
const filterFitObserved = new WeakSet();
const filterMoreApi = new WeakMap(); // bar -> its trigger+menu, built once

// Built once per bar and reused across every fit — torn down and rebuilt while
// open, the menu would close itself out from under the pointer.
function ensureFilterMore(bar) {
  let api = filterMoreApi.get(bar);
  if (api) return api;

  const wrap = document.createElement('div');
  wrap.className = 'filter-more';
  wrap.hidden = true;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'btn secondary icon size-sm filter-more-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  // Both: a tip is only the accessible DESCRIPTION (shared/tooltip.js sets
  // aria-describedby), so a glyph-only button is announced as "button" without a name.
  trigger.setAttribute('aria-label', 'More filters');
  Tooltip.set(trigger, 'More filters');
  trigger.append(Icons.el('more_horiz', 16));

  const menu = document.createElement('ul');
  menu.className = 'menu filter-more-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  function onDocClick(e) { if (!wrap.contains(e.target)) close(); }
  function onDocKey(e) {
    if (menu.hidden || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close({ focus: true });
  }
  function open() {
    if (!menu.hidden) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onDocKey, true);
  }
  function close({ focus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
    if (focus) trigger.focus();
  }
  trigger.addEventListener('click', (e) => {
    e.stopPropagation(); // the doc-level close listener would swallow the toggle
    if (menu.hidden) open(); else close();
  });

  wrap.append(trigger, menu);
  api = { wrap, trigger, menu, close };
  filterMoreApi.set(bar, api);
  return api;
}

// One option per hidden chip. A pick clicks the real (hidden) chip, so it runs
// the exact listener and render path a visible chip would.
function renderFilterMore(bar, hiddenChips) {
  const { wrap, trigger, menu, close } = ensureFilterMore(bar);
  wrap.hidden = hiddenChips.length === 0;
  if (!hiddenChips.length) { close(); return; }
  menu.replaceChildren(...hiddenChips.map((chip) => {
    const li = document.createElement('li');
    li.className = 'menu-option';
    li.setAttribute('role', 'menuitem');
    li.setAttribute('aria-selected', String(chip.classList.contains('selected')));
    li.tabIndex = 0;
    const label = document.createElement('span');
    label.textContent = chip.querySelector('.filter-label')?.textContent || '';
    li.append(label);
    const counter = chip.querySelector('.counter');
    if (counter) li.append(counter.cloneNode(true));
    const pick = () => { chip.click(); close({ focus: true }); };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick();
    });
    return li;
  }));
  // The trigger stands in for what it hides, so it wears the selected state when
  // the chosen chip is one of them.
  const standingIn = hiddenChips.some((c) => c.classList.contains('selected'));
  trigger.classList.toggle('selected', standingIn);
  trigger.classList.toggle('secondary', !standingIn);
}

function fitFilterChips(bar) {
  if (!bar) return;
  // Armed before measuring: a row rendered while its screen is hidden has no
  // width, and the observer is what brings it back the moment it is shown.
  observeFilterFit(bar);
  const chips = [...bar.querySelectorAll(':scope > .filter-chip[data-filter]')];
  if (!chips.length || !bar.clientWidth) return;
  const { wrap } = ensureFilterMore(bar);
  if (wrap.parentNode !== bar) bar.append(wrap); // trigger always trails the real chips

  // Re-fit from the wide state, never from wherever the last fit left it, or a
  // panel dragged WIDER keeps chips hidden that now have room.
  for (const chip of chips) chip.hidden = false;
  wrap.hidden = true;
  if (bar.scrollWidth <= bar.clientWidth) {
    renderFilterMore(bar, []);
    filterFitWidth.set(bar, bar.clientWidth);
    return;
  }

  // Bounded at index 1 — "All" (index 0) never goes.
  wrap.hidden = false;
  const hidden = [];
  let i = chips.length - 1;
  while (i > 0 && bar.scrollWidth > bar.clientWidth) {
    chips[i].hidden = true;
    hidden.unshift(chips[i]);
    i -= 1;
  }
  renderFilterMore(bar, hidden);
  filterFitWidth.set(bar, bar.clientWidth);
}

// The observer also fires for the width the fit itself changed, hence the width
// guard — without it the row would re-fit forever.
function observeFilterFit(bar) {
  if (filterFitObserved.has(bar)) return;
  filterFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== filterFitWidth.get(bar)) fitFilterChips(bar);
  }).observe(bar);
}

// ---------- create-button labels ----------
// Measured on the FIELD beside the button, not the button: these rows never wrap and
// the search is all that shrinks. 144 = "Search suites…" plus magnifier and padding.
const LABEL_FIT_MIN_FIELD = 144;
const labelFitWidth = new WeakMap(); // last width each row was fitted at
const labelFitObserved = new WeakSet();

function shortenLabel(btn, on) {
  btn.classList.toggle('is-short', on);
  // Shortened, the full label still has to survive as the accessible name.
  if (on && btn.dataset.label) btn.setAttribute('aria-label', btn.dataset.label);
  else btn.removeAttribute('aria-label');
}

function fitActionLabels(bar) {
  if (!bar) return;
  // Armed before measuring, like the filter row: a hidden toolbar has no width.
  observeLabelFit(bar);
  const btns = [...bar.querySelectorAll('.fit-label')];
  const field = bar.querySelector('.field');
  if (!btns.length || !field || !bar.clientWidth) return;
  // Both words back on first, or a panel dragged WIDER keeps the short label.
  for (const btn of btns) shortenLabel(btn, false);
  // Reading clientWidth is what forces the layout the toggle above just changed.
  if (field.clientWidth < LABEL_FIT_MIN_FIELD) for (const btn of btns) shortenLabel(btn, true);
  labelFitWidth.set(bar, bar.clientWidth);
}

// Width guard for the same reason the filter row's has one.
function observeLabelFit(bar) {
  if (labelFitObserved.has(bar)) return;
  labelFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== labelFitWidth.get(bar)) fitActionLabels(bar);
  }).observe(bar);
}

// Arm every toolbar once at boot; the observers do the rest.
function initActionLabelFit(root = document) {
  const bars = new Set();
  for (const btn of root.querySelectorAll('.fit-label')) {
    const bar = btn.closest('.toolbar');
    if (bar) bars.add(bar);
  }
  for (const bar of bars) fitActionLabels(bar);
}

// ---------- read-only lockout (#155) ----------
// v2 refuses every request on a read-only project, GET included, so there is nothing
// to show: one blocking panel, with Settings and the project switcher the way out.
function applyReadonlyBlock() {
  const blocked = !!capabilities.readonly && state.view !== 'settings';
  document.body.dataset.readonly = capabilities.readonly ? 'true' : 'false';
  const block = $('readonly-block');
  if (block) block.hidden = !blocked;
  for (const v of views) $(`view-${v}`).hidden = blocked || v !== state.view;
  if (!blocked) { updateContextBar(state.view); return; }
  // Nothing is open behind the block, so Back and the title would both be lying —
  // and with the row gone the panel is not immersed in anything either.
  $('context-bar').hidden = true;
  $('btn-back').hidden = true;
  setImmersive(false);
}

function baseUrlHost() {
  try { return new URL(state.settings.baseUrl).hostname; } catch { return 'the web app'; }
}

// Degraded-mode strip on the runs + run views. Dismissal is in-memory only: it
// lasts the panel session and resets on reload.
let degradedBannerDismissed = false;
function updateDegradedBanner() {
  const banner = $('degraded-banner');
  if (!banner) return;
  const degraded = TestomatAPI.jwtAvailable() === false; // only once degradation is proven
  const onRunViews = state.view === 'runs' || state.view === 'run';
  // #155: under the read-only lockout there is no basic mode to explain.
  const showit = degraded && onRunViews && !degradedBannerDismissed && !capabilities.readonly;
  banner.hidden = !showit;
  if (!showit) return;
  const txt = banner.querySelector('.degraded-banner-text');
  if (txt) {
    txt.textContent = 'Basic mode — steps are local-only; finish run, priority and custom statuses '
      + `need an active ${baseUrlHost()} web login. Sign in there, then Refresh.`;
  }
}

function dismissDegradedBanner() { degradedBannerDismissed = true; updateDegradedBanner(); }

// The same panel-wide pull the header's Refresh does, so the banner's own
// "Sign in there, then Refresh" means one thing wherever it is pressed.
function refreshFromDegradedBanner() { return refreshAll(); }

// Leaving Settings discards unsaved form edits — the API is reconfigured from the
// SAVED settings. A tab click never resets that tab's in-memory screen state.
function switchTab(tab) {
  if (!isConfigured() && tab !== 'settings') return;
  if (state.activeTab === 'settings' && tab !== 'settings' && state.settings) {
    Handoff.configure(state.settings);
  }
  if (tab === state.activeTab) return; // already here — keep the current view
  openTabView(tab);
}

// Views holding in-memory state (an open run/test, a suite's TC list) are re-shown
// without a reset; container views reload from storage/server.
function openTabView(tab) {
  if (tab === 'settings') { openSettingsView(); return; }
  const remembered = state.tabViews[tab];
  if (tab === 'tests') {
    // The picker is a transient step of + New test — re-entry lands on the tree.
    if (remembered === 'tclist' && state.tcSuiteId) show('tclist');
    else openTcStudioView();
  } else { // runs
    if ((remembered === 'run' || remembered === 'test') && state.runId) show(remembered);
    else openRunsView();
  }
}

// Open = refill the form from saved settings, discarding stale edits in the DOM.
function openSettingsView() {
  fillSettingsForm();
  show('settings');
}

// Back navigates only INSIDE the active tab; tab roots hide the arrow entirely.
function goBack() {
  const v = state.view;
  if (v === 'tclist') openTcStudioView();
  else if (v === 'promote') openTcStudioView(); // cancel the + New test suite picker
  else if (v === 'test') openRunView(state.runId, state.runTitle);
  else if (v === 'run') openRunsView();
  // tcstudio / runs / settings are tab roots — back is hidden, nothing to do.
}

// Auto-hide scales with message length so long messages stay readable.
function toastDuration(msg) {
  const over = Math.max(0, String(msg).length - 40);
  return Math.min(8000, 3500 + over * 50);
}

// Drawn from `Icons` (shared/icons.js), not the screens' `svgIcon` alias: this file
// is core, and icons.js is the first script the page loads.
const ALERT_ICON = 'error';
const PROGRESS_ICON = 'progress_activity';

// A new toast always replaces the previous one. Error toasts mirror the product's
// error notify (custom-notify.scss `.error.alert`) and still auto-hide.
// `{ progress: true }` is the running-job plaque: a spinner, no auto-hide, and it stands
// until the next toast or hideToast() — a timer would take it down mid-work.
function toast(msg, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const el = $('toast');
  const isError = !!opts.error;
  const progress = !!opts.progress;
  const ms = opts.ms != null ? opts.ms : toastDuration(msg);
  clearTimeout(toast._t);
  el.classList.toggle('error', isError);
  el.classList.toggle('progress', progress);
  // Set BEFORE the content lands: a live region is only read for changes made while
  // it is in the tree. alert interrupts, status waits; reverted when the toast hides.
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = false;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  el.replaceChildren(text);
  if (isError || progress) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    const mark = Icons.el(isError ? ALERT_ICON : PROGRESS_ICON, 16);
    if (progress) mark.classList.add('spin'); // the shared rotation (SPIN, shared/components.css)
    icon.append(mark);
    el.prepend(icon);
  }
  // Optional inline action (`{ action: { label, onClick } }`) — no caller today;
  // kept because the component layer ships and documents `.toast-action`.
  if (opts.action && typeof opts.action.onClick === 'function') {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'btn size-xs toast-action';
    act.textContent = opts.action.label || 'OK';
    act.addEventListener('click', () => {
      clearTimeout(toast._t);
      el.hidden = true;
      opts.action.onClick();
    });
    el.append(act);
  }
  if (isError) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-btn size-xs toast-dismiss';
    Tooltip.set(x, 'Dismiss');
    x.setAttribute('aria-label', 'Dismiss');
    x.append(Icons.el('close', 16));
    x.addEventListener('click', () => { clearTimeout(toast._t); el.hidden = true; });
    el.append(x);
  }
  // A step of a running job holds; everything else auto-hides.
  if (!progress) toast._t = setTimeout(() => { el.hidden = true; el.setAttribute('role', 'status'); }, ms);
}

// What the panel is DOING right now — the bottom plaque, never an inline status line: the
// line sits under the fold on a long screen, and a job that dies leaves it standing forever.
const progressToast = (msg) => toast(msg, { progress: true });

// Takes down whatever is up. The end of a job whose ANSWER is a status line (or nothing at
// all) calls this; an answer that is itself a toast just replaces the plaque.
function hideToast() {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toast._t);
  el.hidden = true;
  el.classList.remove('progress');
  el.setAttribute('role', 'status');
}

// A screen printing its own line is a job that has ANSWERED, so the running-job plaque goes
// with it — the one rule that keeps a progress toast from outliving its work, wherever the
// flow happens to end. A flow that ends printing nothing calls hideToast() itself.
function setStatusLine(id, msg, cls = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = `status-line ${cls}`.trim();
  hideToast();
}

// In-run auth failure: an inline link to Settings instead of teleporting the
// tester there and losing their place in the run.
function setAuthExpiredLine(id) {
  const el = $(id);
  if (!el) return;
  el.className = 'status-line error';
  el.replaceChildren(document.createTextNode('Session expired — '));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn inline-auth-link';
  btn.textContent = 'open Settings to re-authenticate';
  btn.addEventListener('click', () => switchTab('settings'));
  el.append(btn);
}
