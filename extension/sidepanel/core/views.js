// The DOM half of navigation: show(), tabs, the contextual row, Back, and bare delegates.

/* global Fit, Gates, Handoff, NavModel, PanelToast, Roving, Skeleton, Sk, loadRunsCount,
   loadTestsCount, Tooltip, PriorityIcons, refreshProjects, refreshRuns, openRunView, openTestView,
   openTcStudioView, refreshTcList, openTestSuitePicker, StatusIcons */

// NavModel (core/nav-model.js, loaded first) decides; this file paints what it decided.

function show(view) {
  // Before the switch: the screens that load raise their own placeholder right after this call.
  Skeleton.bootDone();
  Skeleton.hide();
  state.view = view;
  const tab = NavModel.tabOfView(view);
  state.activeTab = tab;
  state.tabViews[tab] = view;
  document.body.dataset.view = view; // CSS + e2e hook
  for (const v of views) $(`view-${v}`).hidden = v !== view;
  // After the loop: it focuses the token field, which a still-hidden section cannot take.
  if (typeof applyConnectMode === 'function') applyConnectMode();
  focusShownView(view);
  updateContextBar(view);
  updateTabBar();
  applyReadonlyBlock();   // a read-only project shows the lockout, not the view
  updateDegradedBanner(); // slim degraded strip is per-view (runs/run only)
  if (typeof updatePendingBanner === 'function') updatePendingBanner(); // offline-queue pending strip
  // Guarded: evidence.js loads after core and may be absent in a test context.
  if (typeof onViewShown === 'function') onViewShown(view);
  persistSession();
}

// The caret follows only where the switch took it away: nothing focused, or a hidden section.
function focusShownView(view) {
  const at = document.activeElement;
  const lost = !at || at === document.body
    || views.some((v) => { const s = $(`view-${v}`); return s.hidden && s.contains(at); });
  if (lost) $(`view-${view}`)?.focus();
}

// A declaration delegate; `state` is the panel global the model refuses to read for itself.
function contextTitleFor(view) { return NavModel.contextTitleFor(view, state); }

// Marks at the head of the title, in list-row order: priority, then type; a run carries none.
function contextTitleMarks(view) {
  if (view === 'tclist') return [StatusIcons.treeIcon(StatusIcons.FILE, 'file-icon', state.tcSuiteEmoji)];
  if (view === 'test') {
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return [
      testPriorityMark(rec),
      rec && typeof TestType !== 'undefined' ? TestType.forRecord(rec) : null,
    ];
  }
  return [];
}

// A pending priority read holds the slot so the title cannot shift.
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

// Root-first, stopping at the parent; the same targets goBack() walks, so trail and arrow agree.
const CONTEXT_TRAILS = {
  run: () => [{ label: 'Runs', open: openRunsView }],
  test: () => [
    { label: 'Runs', open: openRunsView },
    { label: state.runTitle || 'Run', open: () => openRunView(state.runId, state.runTitle) },
  ],
  tclist: () => [{ label: 'Tests', open: openTcStudioView }],
  promote: () => [{ label: 'Tests', open: openTcStudioView }],
};

// Crumbs after the root give up width first; what they lose returns as tooltip and name.
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

// With no target (the suite picker, a locked project, an unknown id) it hides, not a 404.
function renderContextOpenLink(view) {
  const a = $('context-open');
  if (!a) return;
  const s = state.settings || {};
  // The record lookup is the test screen's and may be absent, so it is passed in, not reached for.
  const lookup = typeof recordFor === 'function' ? recordFor : null;
  const target = capabilities.readonly ? null : NavModel.webTarget(view, state, lookup);
  if (!target || !s.baseUrl || !s.projectId) {
    a.removeAttribute('href');
    a.hidden = true;
    return;
  }
  const [noun, path] = target;
  a.href = NavModel.webHref(s.baseUrl, s.projectId, path);
  const label = `Open this ${noun} in Testomat`;
  Tooltip.set(a, label);
  a.setAttribute('aria-label', label);
  a.hidden = false;
}

// The Rec chip moves between the tabs row and the contextual row; evidence.js decides visibility.
function homeRecSlot(contextual) {
  const slot = $('rec-slot');
  const host = contextual ? $('context-bar') : $('header-top');
  if (slot && host && slot.parentElement !== host) host.append(slot);
}

// On a drill-down the rows above fold away, so Refresh rides into the only chrome left.
function homeRefreshButton(contextual) {
  const btn = $('btn-refresh');
  const host = contextual ? $('context-bar') : $('project-bar');
  const before = contextual ? $('context-open') : $('project-open');
  if (btn && host && before && btn.parentElement !== host) host.insertBefore(btn, before);
}

// Outside a tab root the contextual row is the only chrome: the strip and tab row fold away.
function updateContextBar(view) {
  const contextual = !NavModel.ROOT_VIEWS.has(view);
  $('context-bar').hidden = !contextual;
  $('btn-back').hidden = !contextual; // redundant with the row, kept explicit
  const title = $('context-title');
  const name = contextual ? contextTitleFor(view) : '';
  const marks = contextual ? contextTitleMarks(view) : [];
  title.replaceChildren(...[...marks, name].filter(Boolean));
  renderContextCrumbs(contextual ? view : null);
  renderContextOpenLink(contextual ? view : null);
  setImmersive(contextual);
  // Measured after the row is shown: a hidden box reports nothing cut. The name alone, no marks.
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
  const configured = isConfigured(); // token and a resolved project
  for (const tab of NavModel.TABS) {
    const btn = $(`tab-${tab}`);
    if (!btn) continue;
    const active = state.activeTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    const disabled = !configured && tab !== 'settings';
    btn.disabled = disabled;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    Tooltip.set(btn, disabled ? 'Configure settings first' : '');
    // One tab stop for the whole bar, arrows between the three: the tablist convention.
    btn.setAttribute('tabindex', active ? '0' : '-1');
    // A tab controls the section it would show right now; a disabled tab controls none.
    if (disabled) btn.removeAttribute('aria-controls');
    else btn.setAttribute('aria-controls', `view-${state.tabViews[tab] || NavModel.TAB_ROOT[tab]}`);
  }
  // Not Roving.item(): it writes role="button" over the markup's role="tab".
  Roving.attach($('tabbar'), { selector: '.tab', orientation: 'horizontal' });
}

// Three-state: a number (0 included) shows the chip, unknown hides it; the bar may not guess.
function setTabCount(tab, n) {
  const el = $(`tab-${tab}-count`);
  if (!el) return;
  const known = Number.isFinite(n) && n >= 0;
  el.hidden = !known;
  if (known) paintCounter(el, n);
  else el.textContent = '';
}
// A declaration: state.js reaches it through `typeof`, which is not TDZ-safe for a lexical binding.
function resetTabCounts() { for (const t of NavModel.TABS) setTabCount(t, null); }

// Same value is silent; a replay needs the class off, a layout read, then the class back on.
function paintCounter(el, text) {
  if (!el || el.textContent === String(text)) return;
  el.textContent = String(text);
  el.classList.remove('settled');
  void el.offsetWidth; // forces the restart — see above
  el.classList.add('settled');
}

// One-shot: an animation replays when its element leaves `display:none`, re-fading counters on Back.
function initCounterFade() {
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'counter-in') e.target.classList.remove('settled');
  });
}

// The chip is the count's state — a visible one means a number is known.
const tabCountKnown = (tab) => { const el = $(`tab-${tab}-count`); return !!el && !el.hidden; };

// Fills only what is unknown: the tab that loaded owns its number; a second count must not win.
function prefetchTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count
  const epoch = state.projectEpoch; // a further switch mid-fetch discards these
  const jobs = [];
  if (!tabCountKnown('tests')) jobs.push(loadTestsCount(epoch));
  if (!tabCountKnown('runs')) jobs.push(loadRunsCount(epoch));
  return Promise.all(jobs);
}

// Re-entrancy is blocked, not queued: a second click would duplicate every pending request.
let refreshingAll = false;
async function refreshAll() {
  if (refreshingAll) return;
  refreshingAll = true;
  // Disabled + spun before the first await, so nothing reads it as idle mid-refresh.
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

// Re-pull the open view without navigating; tclist re-reads in place to keep what it holds.
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

// Both counts, minus the tests chip when the suite tree just derived it.
function refreshTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count
  const epoch = state.projectEpoch; // a project switch mid-fetch discards these
  const jobs = [loadRunsCount(epoch)];
  if (state.view !== 'tcstudio') jobs.push(loadTestsCount(epoch));
  return Promise.all(jobs);
}

// Kept bare: runs-list.js and run-view.js call the first, app.js the second.
function fitFilterChips(bar) { Fit.filterChips(bar); }
function initActionLabelFit(root = document) { Fit.initActionLabels(root); }

// Kept as declarations: core/state.js reaches two of them through a `typeof` guard.
function applyReadonlyBlock() { Gates.applyReadonlyBlock(); }
function baseUrlHost() { return Gates.baseUrlHost(); }
function updateDegradedBanner() { Gates.updateDegradedBanner(); }
function dismissDegradedBanner() { Gates.dismissDegradedBanner(); }

// The same pull as the header's Refresh, so "Sign in there, then Refresh" means one thing.
function refreshFromDegradedBanner() { return refreshAll(); }

// Leaving Settings discards unsaved edits: the API is reconfigured from the saved settings.
function switchTab(tab) {
  if (!isConfigured() && tab !== 'settings') return;
  if (state.activeTab === 'settings' && tab !== 'settings' && state.settings) {
    Handoff.configure(state.settings);
  }
  if (tab === state.activeTab) return; // already here — keep the current view
  openTabView(tab);
}

// Openers are named one by one, not via a map: screen scripts load after this file.
function navStep(step) {
  if (!step) return;
  if (step.show) { show(step.show); return; }
  const args = step.args || [];
  if (step.open === 'settings') openSettingsView();
  else if (step.open === 'tcstudio') openTcStudioView();
  else if (step.open === 'runs') openRunsView();
  else if (step.open === 'run') openRunView(...args);
}

function openTabView(tab) { navStep(NavModel.nextViewForTab(tab, state)); }

// Open = refill the form from saved settings, discarding stale edits in the DOM.
function openSettingsView() {
  fillSettingsForm();
  show('settings');
}

function goBack() { navStep(NavModel.backTargetFor(state.view, state)); }

// Kept bare: every screen spells them this way.
function toastDuration(msg) { return PanelToast.duration(msg); }
function toast(msg, opts) { PanelToast.show(msg, opts); }
const progressToast = (msg) => PanelToast.progress(msg);
function hideToast() { PanelToast.hide(); }
function setStatusLine(id, msg, cls) { PanelToast.statusLine(id, msg, cls); }

// In-run auth failure: an inline link to Settings instead of losing the tester's place.
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
