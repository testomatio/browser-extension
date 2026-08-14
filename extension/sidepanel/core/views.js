// Core views: the view switcher (show), the three-tab navigation, the contextual
// header row, settings open, in-tab back navigation, and the toast plus
// status-line helpers.

/* global TestomatAPI, Icons, Skeleton, Sk, loadRunsCount, loadTestsCount, Tooltip,
   PriorityIcons, refreshProjects, refreshRuns, openRunView, openTestView,
   openTcStudioView, openTcListView, openTestSuitePicker */

// ---------- tab model ----------
// Three tabs group the working views. Tests hosts the TC tree, a suite's TC list
// and the suite picker (`promote` — historical name, see tc-studio.js); Runs
// hosts the run list and the run/test views; Settings is its own tab. show()
// derives the active tab from the view and remembers each tab's last view, so a
// tab click reopens exactly where that tab was left.
const TAB_OF_VIEW = {
  tcstudio: 'tests', tclist: 'tests', promote: 'tests',
  runs: 'runs', run: 'runs', test: 'runs',
  settings: 'settings',
};
const TABS = ['tests', 'runs', 'settings'];
// Root views are a tab's landing view — the contextual row (Back + title) is
// hidden there: nothing to go back to inside the tab, and the tab names it.
const ROOT_VIEWS = new Set(['tcstudio', 'runs', 'settings']);

// ---------- view switching ----------

function show(view) {
  // A view is about to be painted, so both placeholders are spent: the boot one
  // has nothing left to stand in for, and a per-view one belongs to the screen
  // being left. Before the switch, not after — the screens that load raise their
  // own placeholder immediately after calling this.
  Skeleton.bootDone();
  Skeleton.hide();
  state.view = view;
  const tab = TAB_OF_VIEW[view] || 'runs';
  state.activeTab = tab;
  state.tabViews[tab] = view; // per-tab memory for the next tab click
  document.body.dataset.view = view; // exposes the active view to CSS/queries
  for (const v of views) $(`view-${v}`).hidden = v !== view;
  // First-run connect screen: derived from the view + whether anything is saved,
  // so it is re-decided on EVERY view change — a first Save lands on the runs
  // view with the tab bar back, with nothing to reset by hand. AFTER the loop
  // above: it focuses the token field, which a still-hidden section cannot take.
  if (typeof applyConnectMode === 'function') applyConnectMode();
  updateContextBar(view);
  updateTabBar();
  applyReadonlyBlock();   // #155: a read-only project shows the lockout, not the view
  updateDegradedBanner(); // slim degraded strip is per-view (runs/run only)
  if (typeof updatePendingBanner === 'function') updatePendingBanner(); // offline-queue pending strip
  // Evidence recorder UI reflects per-view (run/test only); guarded — evidence.js
  // loads after core and may be absent in a minimal test context.
  if (typeof onViewShown === 'function') onViewShown(view);
  persistSession();
}

// What the contextual row names — the open run, the open test, or the suite a
// Tests sub-view is bound to. This is the LAST crumb of the path, printed as the
// screen's title rather than as a link: it is the page you are on.
// Empty on a tab root (the row is hidden there).
function contextTitleFor(view) {
  if (view === 'run') return state.runTitle || 'Run';
  if (view === 'test') return state.testTitle || 'Test';
  if (view === 'tclist') return state.tcSuiteTitle || 'Suite';
  if (view === 'promote') return 'Choose suite';
  return '';
}

// The MARK of that thing, set at the head of its name. Falling through to a
// suite or a test hands the panel over to one row of chrome, and until now that
// row said only the words: the same suite that was a marked row in the tree a
// moment ago arrived as a bare line of text. It keeps its mark here — the suite
// glyph (or the custom emoji the project gave it), the test's own type mark —
// so the header answers "what am I looking at" with the same symbol the list
// answered it with.
//
// A run keeps its words alone: its kind and status are already spelled out as
// pills right under this row, and a third mark for the same thing would only
// repeat them. Absent-safe everywhere — a missing mark just leaves the name.
// MARKS, plural, because a test carries two of them and they are the two a list
// row carries before its title: how much it MATTERS, then what it IS. Same
// order here, so the header opens the way every row naming a test opens.
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

// The open test's priority, as the bare `.prio` glyph. Two sources, the richer
// first: the JSON:API detail the test view prefetches carries it under JWT, and
// the v2 record has it only when the run payload sent one.
// An absent or unknown priority IS `normal` — the builder's own fallback, and
// the same one every list in this panel draws with (shared/priority-icons.js):
// `normal` is the priority a test that was never given one actually runs at.
//
// WHILE THE READ THAT CARRIES IT IS STILL OUT, the slot is held open with the
// library's skeleton disc instead. The priority arrives one round trip after the
// row is first painted, and paging through a run made that visible as a flaw:
// the mark blinked and every letter of the title beside it stepped 24px sideways
// and back. A reserved box cannot do that — and it is the honest placeholder,
// where showing `normal` for a moment would be stating a priority the panel has
// not read yet.
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

// The path down to the open view, root-first and stopping at its PARENT (the
// title above is the last crumb). Every crumb is a real destination inside the
// tab — the same targets goBack() walks, so the trail and the arrow can never
// disagree about where "up" is.
const CONTEXT_TRAILS = {
  run: () => [{ label: 'Runs', open: openRunsView }],
  test: () => [
    { label: 'Runs', open: openRunsView },
    { label: state.runTitle || 'Run', open: () => openRunView(state.runId, state.runTitle) },
  ],
  tclist: () => [{ label: 'Tests', open: openTcStudioView }],
  promote: () => [{ label: 'Tests', open: openTcStudioView }],
};

// Paint the trail. The root crumb keeps its whole word (it is one short one and
// it names the tab the panel came from); the crumbs after it give up width
// first, and what they lose comes back as a tooltip and as their accessible
// name — a truncated run title still has to be identifiable.
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

// The way OUT of the panel for the thing this row names: the open suite, the
// open run or the open test, on its own page in the web app. The project strip
// carries the same control for the project (#project-open) and the test page for
// a test case (#113) — this is the one control for every contextual view, built
// here rather than three times over inside the views, because the row already
// knows which one is open.
//
// The routes are the PRODUCT's, not a guess at them:
//   run    /projects/<slug>/runs/<id>            — the shape the runs list already
//                                                  PARSES out of a pasted run URL
//                                                  (runs-list.js)
//   test   /projects/<slug>/runs/<id>/test/<id>  — the Ember `runs.show.test`
//                                                  route (front app/router.js:88)
//   suite  /projects/<slug>/suite/<uid>          — the Ember suite route, singular
// and every id the panel holds IS the public uid v2 serializes, so there is
// nothing to translate on the way into one.
const CONTEXT_WEB_TARGET = {
  run: () => (state.runId ? ['run', `runs/${encodeURIComponent(state.runId)}`] : null),
  test: () => {
    // The view shows a TESTRUN, so it links to one (#203): the record's page in the
    // run report, never the test case behind it — a parametrized run has many
    // records and one test_id, which cannot name the row on screen.
    if (state.runId && state.currentRecordId) {
      return ['test', `runs/${encodeURIComponent(state.runId)}/test/${encodeURIComponent(state.currentRecordId)}`];
    }
    // No run around the record: the test CASE page, the singular route of #113.
    const rec = typeof recordFor === 'function' ? recordFor(state.currentRecordId) : null;
    return rec && rec.test_id ? ['test', `test/${encodeURIComponent(rec.test_id)}`] : null;
  },
  tclist: () => (state.tcSuiteId ? ['suite', `suite/${encodeURIComponent(state.tcSuiteId)}`] : null),
};

// Repointed on every view change and on every settle of the row (a run detail
// landing late, a test opened from a row). With no target — the suite picker, a
// locked project, a view whose id is not known yet, an instance that is half
// configured — it HIDES rather than point at a 404, the deal every other link
// out of this panel makes.
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
  // The label names WHAT opens: three views share this one control, and "Open in
  // Testomat" on all of them says the least at exactly the moment it matters.
  const label = `Open this ${noun} in Testomat`;
  Tooltip.set(a, label);
  a.setAttribute('aria-label', label);
  a.hidden = false;
}

// The Rec chip lives in whichever chrome row is on screen: the tabs row on a
// root, the contextual row while the panel is immersed. It is a GLOBAL indicator
// — it stays up on every view for as long as a session records (Block 4) — so it
// may never go away with the row it happens to be sitting in. One container, one
// move, exactly as #127 left it.
function homeRecSlot(contextual) {
  const slot = $('rec-slot');
  const host = contextual ? $('context-bar') : $('header-top');
  if (slot && host && slot.parentElement !== host) host.append(slot);
}

// Contextual header row (#127): Back + where you are + what is open, and outside
// a tab root it is the panel's only chrome — the project strip and the tab row
// stand down so the run, the test or the suite gets the full height, the way the
// editor does in its own tab. That is also why the row carries a trail: with the
// tabs away, it is the only thing left naming the section fallen through from.
// Back navigates strictly inside the tab, so it lives and dies with this row.
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
  // A test name is a sentence and the row gives it three lines — when it does not
  // fit even so, the rest comes back on hover. Measured, not assumed: a tooltip
  // that only repeats what is already on screen is noise, so it is set only for
  // a title the clamp actually cut. (Read AFTER the row is shown, or it measures
  // a hidden box and finds nothing cut.)
  // (It opens downward like the rest of the row — #context-bar carries the side.)
  // The NAME, not the row's text: the mark beside it is a symbol, and a tooltip
  // that opened with an emoji in front of the title would be repeating the thing
  // the reader can already see.
  Tooltip.set(title, title.scrollHeight > title.clientHeight + 1 ? name : '');
}

// The one writer of the immersive flag — CSS folds the two rows above away on
// it, and the Rec chip follows the row that is left.
function setImmersive(on) {
  document.body.dataset.immersive = on ? 'true' : 'false';
  homeRecSlot(on);
}

// A title that settles AFTER the view opened (a run whose detail lands a moment
// later, a test row that renamed itself) repaints the row it is named in.
function refreshContextBar() { updateContextBar(state.view); }

// Reflect the active tab (highlight + aria-selected) and the first-launch gate:
// until settings are configured, only the Settings tab is reachable.
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
    Tooltip.set(btn, disabled ? 'Configure settings first' : ''); // gate reason on hover
  }
}

// The count chip in a tab (#127). Deliberately three-state, not two: a number
// SHOWS it, and both null (nobody has fetched that tab's data yet) and a server
// that returned no total HIDE it. A tab bar states what the project has — it may
// not guess, and "0" is a claim, not an absence. So the chip is absent until the
// tab's own view has loaded once, and it does not linger across a project switch
// (resetTabCounts, called from the same place the caches are dropped).
function setTabCount(tab, n) {
  const el = $(`tab-${tab}-count`);
  if (!el) return;
  const known = Number.isFinite(n) && n >= 0;
  el.hidden = !known;
  if (known) paintCounter(el, n); // fades in as it lands, like every other count
  else el.textContent = '';
}
// A declaration, not a const arrow: state.js reaches for it through `typeof`,
// and `typeof` is not TDZ-safe for a lexical binding in another classic script.
function resetTabCounts() { for (const t of TABS) setTabCount(t, null); }

// Write a figure into a `.counter` and, when it is a DIFFERENT figure, let it
// land: every count in this panel is painted before its number is known — a tab
// chip appearing, a filter chip resting at 0 while the nested run counts are
// still on the wire — and swapping the digits in place is a jump, since the row
// was already read at the old value and the new one arrives with nothing to say
// it is new. The counter's own box does not move with it (`min-width` in
// components.css holds two figures), so all that changes is the number.
//
// Re-painting the same value is silent — a search keystroke re-renders the chip
// row, and a count that did not move must not blink. Replaying a keyframe on an
// element that already carries the class needs the class off, a layout read, and
// the class back on: without the read the browser never sees it leave.
function paintCounter(el, text) {
  if (!el || el.textContent === String(text)) return;
  el.textContent = String(text);
  el.classList.remove('settled');
  void el.offsetWidth; // forces the restart — see above
  el.classList.add('settled');
}

// The chip IS the count's state — a visible one means a number is known.
const tabCountKnown = (tab) => { const el = $(`tab-${tab}-count`); return !!el && !el.hidden; };

// Fill the counts of the tabs that nobody loaded. A project switch repoints the
// whole panel but lands on ONE tab, so only that tab's view fetches — the other
// chip would stay blank until the tester happened to visit it, and the bar's job
// is to say what the project holds, on arrival, not eventually.
// Deliberately only fills what is still UNKNOWN: the tab that did load owns its
// own number (from its own paging cursor / suite tree), and a second, separately
// derived count must never overwrite it. Fire-and-forget by design — the switch
// has already painted; a count is allowed to land a moment later.
function prefetchTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count (#155)
  const epoch = state.projectEpoch; // a further switch mid-fetch discards these
  const jobs = [];
  if (!tabCountKnown('tests')) jobs.push(loadTestsCount(epoch));
  if (!tabCountKnown('runs')) jobs.push(loadRunsCount(epoch));
  return Promise.all(jobs);
}

// ---------- the panel-wide refresh ----------
// Refresh moved out of the runs toolbar and into the project strip (the panel's
// topmost row, far right). Up there it is scoped by the project beside it — the
// same thing every tab under it is scoped by — so it stopped meaning "re-fetch
// this list" and started meaning what a refresh in a browser means: pull
// everything on screen again. Three parts, in the order they matter:
//   1. the project list itself (a project added since the panel opened),
//   2. the open view's own data,
//   3. both tab counts.
// Re-entrancy is blocked rather than queued: a second click while the first is
// in flight would duplicate every request it is still waiting on.
let refreshingAll = false;
async function refreshAll() {
  if (refreshingAll) return;
  refreshingAll = true;
  // Disabled + spun BEFORE the first await, so a click that returns has already
  // put the button in flight — nothing can read it as idle mid-refresh.
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

// Re-pull what the open view is showing, WITHOUT navigating: the runs list
// refreshes in place (its filter and expanded groups live in state, and
// refreshRuns is built to keep them), and every other view re-runs its own
// opener — which is already that screen's "load this from the server" path and
// lands back on the same screen it was called from.
// Failures are the screens' own to report: each opener already writes its status
// line and toasts, so nothing is swallowed here.
function refreshCurrentView() {
  const v = state.view;
  if (v === 'runs') return refreshRuns();
  if (v === 'run' && state.runId) return openRunView(state.runId, state.runTitle);
  if (v === 'test' && state.currentRecordId) return openTestView(state.currentRecordId);
  if (v === 'tcstudio') return openTcStudioView();
  if (v === 'tclist' && state.tcSuiteId) return openTcListView(state.tcSuiteId, state.tcSuiteTitle);
  if (v === 'promote') return openTestSuitePicker(); // the + New test picker, re-fetched in place
  // Settings holds no server data of its own — the project list refreshed above
  // is the whole of what a refresh can mean there.
  return Promise.resolve();
}

// Both counts, unconditionally — the opposite of prefetchTabCounts(), which
// fills only what is unknown. A refresh is a statement that everything on screen
// may be stale, and the tab a tester is NOT standing on is exactly where a stale
// number survives longest.
// Skips the count the view refresh above just recomputed: the suite tree sets
// its own tab's chip from the rows it drew, and a second count derived a
// different way would only make the number flicker. The runs chip is NOT such a
// count — it is the project's run total, which the runs list never derives, so a
// refresh must re-read it whichever tab is open.
function refreshTabCounts() {
  if (capabilities.readonly) return Promise.resolve(); // a locked project has nothing to count (#155)
  const epoch = state.projectEpoch; // a project switch mid-fetch discards these
  const jobs = [loadRunsCount(epoch)];
  if (state.view !== 'tcstudio') jobs.push(loadTestsCount(epoch));
  return Promise.all(jobs);
}

// ---------- filter chips: the row that sends its overflow to a menu ----------
// A `.filters` row (shared/components.css) is a plain row of `.filter-chip`
// buttons, each sized to its own word — not the equal-cell grid this used to
// be. What doesn't fit at the panel's current width does not shrink or lose
// its word either: it leaves the row entirely and waits behind a `⋯` trigger
// (`.filter-more`), in the order it would have appeared. Built and measured
// here so both screens that own a filters row (runs list, run view) share one
// implementation.
//
// Measured, not guessed: the panel is user-resizable and the counts change
// width as runs load (5000 is wider than 30), so there is no breakpoint to
// write — only `bar.scrollWidth > bar.clientWidth`, re-read after every hide.
//
// One chip at a time, rightmost first: that is where these rows put their
// rarest answers — Scheduled and Terminated, Skipped and Pending. "All" never
// goes — it is the row's default and the first thing measured, so it is
// always among the ones that already fit.
const filterFitWidth = new WeakMap(); // last width each row was fitted at
const filterFitObserved = new WeakSet();
const filterMoreApi = new WeakMap(); // bar -> its trigger+menu, built once

// The overflow trigger and its menu: built once per bar and reused across
// every fit — torn down and rebuilt while open, it would close itself out
// from under the pointer. Mirrors the editor's priority dropdown (a plain
// button + `.menu`, no type-to-filter) rather than the project switcher's
// fuller listbox — this one only ever holds a handful of rows.
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
  // Both, and they are not the same thing: a tip is the accessible DESCRIPTION
  // (shared/tooltip.js holds it as `aria-describedby`), so a control whose whole
  // face is a glyph still needs a NAME of its own — without one this button is
  // announced as "button" and nothing else.
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

// One option per hidden chip. A pick does not duplicate setRunsFilter/
// setRunFilter — it just clicks the real (hidden) chip, so it runs through
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
  // The trigger stands in for whatever it is hiding, so it has to say when the
  // true answer is one of them — same wash a visible chosen chip wears, and it
  // swaps its secondary intent out for the state exactly as a chip does.
  const standingIn = hiddenChips.some((c) => c.classList.contains('selected'));
  trigger.classList.toggle('selected', standingIn);
  trigger.classList.toggle('secondary', !standingIn);
}

function fitFilterChips(bar) {
  if (!bar) return;
  // Armed before the measurement, not after it: a row rendered while its screen
  // is still hidden has no width to measure against, and the observer is what
  // brings it back the moment it is shown.
  observeFilterFit(bar);
  const chips = [...bar.querySelectorAll(':scope > .filter-chip[data-filter]')];
  if (!chips.length || !bar.clientWidth) return;
  const { wrap } = ensureFilterMore(bar);
  if (wrap.parentNode !== bar) bar.append(wrap); // trigger always trails the real chips

  // Every chip back first, always: re-fit from the wide state, never from
  // wherever the last fit left it, or a panel dragged WIDER would keep chips
  // hidden that now have the room to come back.
  for (const chip of chips) chip.hidden = false;
  wrap.hidden = true;
  if (bar.scrollWidth <= bar.clientWidth) {
    renderFilterMore(bar, []);
    filterFitWidth.set(bar, bar.clientWidth);
    return;
  }

  // Reserve the trigger's own width, then give chips up from the right, one at
  // a time, until the rest fit. Bounded at index 1 — "All" (index 0) never goes.
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

// One observer per row, attached on its first fit. It fires for the width the
// hide/show above just changed too, hence the width guard — otherwise the row
// would re-fit itself forever.
function observeFilterFit(bar) {
  if (filterFitObserved.has(bar)) return;
  filterFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== filterFitWidth.get(bar)) fitFilterChips(bar);
  }).observe(bar);
}

// ---------- create-button labels ----------
// Every toolbar in the panel ends in the same control: a plus and the errand it
// does — "New run" on Runs, "New test" on Tests and inside a suite. They say it
// the same way because they do the same kind of thing, and the one that used to
// read just "Test" said it differently only because its row is the crowded one.
// So the row gives the first word up instead of the button being written short:
// both words ship in the markup (`.fit-label`, shared/components.css) and this
// picks between them.
//
// The measurement is the FIELD beside it, not the button. These rows never wrap
// and the search is the only thing in them that shrinks, so the button is never
// clipped — what a long label costs comes out of the search box. Below the width
// its own placeholder needs, the box has stopped being a search box, and the
// button's first word is the cheapest thing left in the row to give up. 144 is
// that floor: "Search suites…" at the small step, plus its magnifier and the
// padding around it.
const LABEL_FIT_MIN_FIELD = 144;
const labelFitWidth = new WeakMap(); // last width each row was fitted at
const labelFitObserved = new WeakSet();

function shortenLabel(btn, on) {
  btn.classList.toggle('is-short', on);
  // The word left is the object, not the errand, so the button has to carry the
  // whole of it for a screen reader. Its tooltip, where it has one, is its own
  // sentence and is left alone.
  if (on && btn.dataset.label) btn.setAttribute('aria-label', btn.dataset.label);
  else btn.removeAttribute('aria-label');
}

function fitActionLabels(bar) {
  if (!bar) return;
  // Armed before the measurement, like the filter row: a toolbar rendered while
  // its screen is still hidden has no width, and the observer is what brings it
  // back the moment it is shown.
  observeLabelFit(bar);
  const btns = [...bar.querySelectorAll('.fit-label')];
  const field = bar.querySelector('.field');
  if (!btns.length || !field || !bar.clientWidth) return;
  // Both words back on first, always — never fitted from wherever the last fit
  // left it, or a panel dragged WIDER again would keep the short word it took at
  // its narrowest.
  for (const btn of btns) shortenLabel(btn, false);
  // Reading clientWidth is what forces the layout the toggle above just changed.
  if (field.clientWidth < LABEL_FIT_MIN_FIELD) for (const btn of btns) shortenLabel(btn, true);
  labelFitWidth.set(bar, bar.clientWidth);
}

// One observer per row, attached on its first fit; the width guard is there for
// the same reason the filter row's is.
function observeLabelFit(bar) {
  if (labelFitObserved.has(bar)) return;
  labelFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== labelFitWidth.get(bar)) fitActionLabels(bar);
  }).observe(bar);
}

// Arm every toolbar that has one, once, at boot — the observers do the rest,
// including the first honest measurement of a row whose screen is still hidden.
function initActionLabelFit(root = document) {
  const bars = new Set();
  for (const btn of root.querySelectorAll('.fit-label')) {
    const bar = btn.closest('.toolbar');
    if (bar) bars.add(bar);
  }
  for (const bar of bars) fitActionLabels(bar);
}

// ---------- read-only lockout (#155) ----------
// Read-only access to a project (reader role, company-readonly, or an archived
// project) is not a browsing mode: v2 refuses every request there, GET included,
// so the panel has nothing honest to show and does not pretend otherwise. Every
// working view is replaced by one blocking panel naming the reason; Settings and
// the project switcher above it stay reachable, which is the whole way out —
// switch to a project the tester can actually work in.
// Deliberately symmetric — it paints BOTH states from `capabilities.readonly`,
// so the same call that locks the panel unlocks it once a switch lands on a
// project the tester can work in.
function applyReadonlyBlock() {
  const blocked = !!capabilities.readonly && state.view !== 'settings';
  document.body.dataset.readonly = capabilities.readonly ? 'true' : 'false';
  const block = $('readonly-block');
  if (block) block.hidden = !blocked;
  for (const v of views) $(`view-${v}`).hidden = blocked || v !== state.view;
  if (!blocked) { updateContextBar(state.view); return; }
  // Nothing is open behind the block, so the Back arrow and the run/suite title
  // would both be lying. And with the row gone the panel is not immersed in
  // anything either — the project switcher above is the whole way out of a
  // locked project, so the chrome comes back with the block.
  $('context-bar').hidden = true;
  $('btn-back').hidden = true;
  setImmersive(false);
}

// Host label from the configured base URL, for degraded-mode copy.
function baseUrlHost() {
  try { return new URL(state.settings.baseUrl).hostname; } catch { return 'the web app'; }
}

// Degraded/login-blocked banner (Block 4): a slim, dismissible strip on the runs
// + run views naming what basic mode disables and how to restore it. Dismissal is
// remembered for the panel session (in-memory; reset on reload, like the
// attachments disclosure).
let degradedBannerDismissed = false;
function updateDegradedBanner() {
  const banner = $('degraded-banner');
  if (!banner) return;
  const degraded = TestomatAPI.jwtAvailable() === false; // only once degradation is proven
  const onRunViews = state.view === 'runs' || state.view === 'run';
  // #155: under the read-only lockout there is no basic mode to explain — the
  // blocking panel is the only thing this project has to say.
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

// Banner Refresh re-attempts the session upgrade — the same panel-wide pull the
// header's Refresh does, so "Sign in there, then Refresh" means one thing
// wherever the tester presses it.
function refreshFromDegradedBanner() { return refreshAll(); }

// A tab click reopens that tab's remembered view (its root the first time).
// Leaving Settings discards unsaved form edits — the API is reconfigured from the
// saved settings, exactly like the old back-cancel. Switching never resets a
// tab's in-memory screen state (the runs stack, the open run/test, the TC tree).
function switchTab(tab) {
  if (!isConfigured() && tab !== 'settings') return; // gated until configured
  if (state.activeTab === 'settings' && tab !== 'settings' && state.settings) {
    TestomatAPI.configure(state.settings);
  }
  if (tab === state.activeTab) return; // already here — keep the current view
  openTabView(tab);
}

// Land on a tab's remembered view. Views that hold in-memory state (an open
// run/test, a suite's TC list) are re-shown without a reset; container views
// reload cheaply from storage/server.
function openTabView(tab) {
  if (tab === 'settings') { openSettingsView(); return; }
  const remembered = state.tabViews[tab];
  if (tab === 'tests') {
    // The suite picker (promote) is a transient step of + New test — re-entering the
    // tab lands on the tree, not a stale picker.
    if (remembered === 'tclist' && state.tcSuiteId) show('tclist');
    else openTcStudioView();
  } else { // runs
    if ((remembered === 'run' || remembered === 'test') && state.runId) show(remembered);
    else openRunsView();
  }
}

// Settings is a tab now: open = refill the form from saved settings (discarding
// any stale edits left in the DOM) and show it.
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

// Auto-hide duration scales with the message length so long messages stay
// readable: a 3.5s floor plus ~50ms per character past 40, capped at 8s.
function toastDuration(msg) {
  const over = Math.max(0, String(msg).length - 40);
  return Math.min(8000, 3500 + over * 50);
}

// The error-toast icon (#82), mirroring the product's error notify. Drawn straight
// from `Icons` (shared/icons.js) rather than the screens' `svgIcon` alias: this
// file is core, and icons.js is the first script the page loads.
const ALERT_ICON = 'error';

// A transient notification. A new toast always replaces the previous one. Error
// toasts (`{ error: true }`) wear the product's error notify — a red-tinted card
// with an alert icon (custom-notify.scss `.error.alert`) — and carry a dismiss ×;
// they still auto-hide, never sooner than the scaled duration. A numeric second
// arg is accepted for back-compat (an explicit duration in ms).
function toast(msg, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  const el = $('toast');
  const isError = !!opts.error;
  const ms = opts.ms != null ? opts.ms : toastDuration(msg);
  clearTimeout(toast._t);
  el.classList.toggle('error', isError);
  // Announce before the content lands: a live region is only read when the change
  // happens while it is in the tree, and an error interrupts (alert) where an
  // ordinary toast waits its turn (status). Reverted when this toast hides.
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = false;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  el.replaceChildren(text);
  if (isError) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.append(Icons.el(ALERT_ICON, 16));
    el.prepend(icon);
  }
  // Optional inline action (`{ action: { label, onClick } }`) — the `.toast-action`
  // of the component layer. No caller since #198 took the site-access offer out;
  // the affordance stays because the library ships and documents it.
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
  toast._t = setTimeout(() => { el.hidden = true; el.setAttribute('role', 'status'); }, ms);
}

function setStatusLine(id, msg, cls = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = `status-line ${cls}`.trim();
}

// In-run auth failure (a session that expired mid-write): render an inline status
// line with a button that switches to the Settings tab, instead of teleporting
// the tester there and losing their place (Block 4).
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
