// Loading placeholders (IIFE global `Skeleton`): the panel's own shape, drawn in
// grey bars, while what belongs there is still on the wire.
//
// Two moments need it, and they are the two the panel spends waiting:
//
//   BOOT     opening the panel is token → projects → runs before a single row
//            can be painted. Until now that was a white rectangle for as long as
//            the round trips took — on a project with a few thousand tests, long
//            enough to read as a broken extension.
//   A TAB    Tests and Runs each fetch a container on entry (the suite tree, the
//            runs list), and a run or a suite fetches again on open. Between the
//            click and the answer the tab is simply empty.
//
// Every placeholder is composed from the components the real screen is made of —
// `.list` rows, `.toolbar`, `.filters`, `.bar`, `.tabs` — with `.skeleton` bars
// (shared/components.css) where the text and the icons go. That is the whole
// design: the placeholder is not a picture OF the screen, it is the screen with
// its content replaced, so a row that changes its padding or its columns changes
// here for free and there is nothing to keep in step.
//
// It is also why all of it is built here rather than written into index.html,
// the boot one included: a static copy in the markup plus a generated one in JS
// is two skeletons for one list, and the one nobody looks at is the one that
// drifts. index.html carries the empty `#boot-skeleton` container and nothing
// else.
//
// Mounted as a SIBLING of the list it stands in for, never inside it: `#runs-list`,
// `#run-tests` and `#tc-tree` are what the screens render into and what the e2e
// counts rows in, and a placeholder that filled them would be a row like any
// other to both.

/* global $, Sk */

const Skeleton = (() => {
  // The bars themselves come from shared/skeleton.js — the editor draws the
  // same ones on its own page, and a second copy of `.skeleton line` assembly
  // is a second thing to keep in step. This file is the PLANS: which shape each
  // panel view puts up, and when.
  const { el, bar, lines } = Sk;

  // Rows never all end on the same pixel — real titles don't, and a stack of
  // equal bars reads as a barcode rather than as a list. One cycle of widths,
  // walked down the rows; long enough that the repeat is not a pattern.
  const TITLE_W = ['72%', '54%', '66%', '47%', '61%', '77%', '58%', '69%'];
  // Enough rows to reach the bottom of a side panel at its usual height. A
  // placeholder that stops halfway down draws a horizon the real list does not
  // have, and the eye reads that as "this is all there is" rather than as a
  // load. Overshooting costs nothing — the rows are replaced whole.
  const ROWS = 9;
  const TREE_ROWS = 5; // suite roots; two of them carry children (see treeRows)

  const pick = (arr, i) => arr[i % arr.length];

  // ---------- rows, one per list the panel draws ----------

  // Runs list (screens/runs-list.js runRow): one line — status glyph + title.
  // It stands in for a one-line row, so it is one line itself: a placeholder
  // that is taller than what replaces it makes the whole list step up the moment
  // the real rows land, which is the one thing a skeleton exists to prevent.
  function runsRow(i) {
    const li = el('li');
    const head = el('div', 'list-head');
    head.append(bar('circle'), bar('line', pick(TITLE_W, i)));
    li.append(head);
    return li;
  }

  // Run view checklist (screens/run-view.js testRow): one line — the status and
  // type marks, the title, and the three 24px ✓/✗/– buttons in the fixed right
  // cell. The bar goes IN a `.title` rather than standing as the line itself: a
  // row's line is 20px tall whatever it carries (`.list .title`, LIST in
  // shared/components.css), and a bare 13px bar left the placeholder short of
  // the row it stands in for — which the whole list then made up in one step the
  // moment the real rows landed.
  function testRow(i) {
    const li = el('li', 'test-row');
    const title = el('div', 'title');
    title.append(bar('line', pick(TITLE_W, i)));
    li.append(bar('circle'), bar('circle'), title);
    const actions = el('div', 'row-actions');
    for (let n = 0; n < 3; n += 1) actions.append(bar('control xs square'));
    li.append(actions);
    return li;
  }

  // Suite tree (screens/tc-studio.js tcNode): a dense row of chevron + folder
  // icon + title + the test count. The count is a LINE, not a chip: it is plain
  // text at the row's trailing edge now (`.row-count`), and a placeholder still
  // drawing a pill would promise a box the real row no longer has.
  function treeRow(i, { folder = true } = {}) {
    const li = el('li', 'tc-item');
    const row = el('div', 'list-row tc-row list-head');
    if (folder) row.append(bar('circle'));
    // It stands in the real slot as well as wearing its shape: `.row-count` is
    // what pushes the figure to the row's trailing edge, and a bar that stopped
    // halfway across would move the moment the tree landed.
    row.append(bar('circle'), bar('line', pick(TITLE_W, i)), bar('line sm row-count', '16px'));
    li.append(row);
    return li;
  }

  // A tree is not a flat list, and a placeholder that ignored that would jump
  // when the real one arrived: two of the roots come back open, with their files
  // indented under them in the tree's own `.tc-children`.
  function treeRows(ul) {
    for (let i = 0; i < TREE_ROWS; i += 1) {
      const li = treeRow(i);
      if (i === 1 || i === 3) {
        const kids = el('ul', 'tc-children');
        kids.append(treeRow(i + 1, { folder: false }), treeRow(i + 2, { folder: false }));
        li.append(kids);
      }
      ul.append(li);
    }
  }

  // A suite's test list (screens/tc-studio.js renderTcList): one line, no meta.
  function tcRow(i) {
    const li = el('li');
    const head = el('div', 'list-head');
    head.append(bar('line', pick(TITLE_W, i)));
    li.append(head);
    return li;
  }

  // ---------- the blocks a screen is assembled from ----------

  const listOf = (row, n) => {
    const ul = el('ul', 'list is-static skeleton-rows');
    for (let i = 0; i < n; i += 1) ul.append(row(i));
    return ul;
  };

  // The runs toolbar: the search field and "New run". Refresh is NOT here — it
  // is the project strip's control now (see drawBoot), and a placeholder that
  // still drew a square between these two would promise a button the real row no
  // longer has. `.runs-bar` for the same reason the screen wears it — the row
  // does not wrap, the search gives up the width instead.
  // 96 is that button measured at the width this panel opens at, where it reads
  // "New run" in full (it gives the first word up only in a dragged-narrow pane —
  // fitActionLabels, core/views.js); a placeholder is not told which, so it draws
  // the one the panel almost always shows.
  function toolbar() {
    const row = el('div', 'toolbar runs-bar');
    row.append(bar('control sm fill'), bar('control sm', '96px'));
    return row;
  }

  // The status filter chips under it. Four, where the runs list draws six: the
  // real row wraps to a second line in a narrow panel and gives up two of its
  // words to climb back onto one (fitFilterChips, core/views.js). A placeholder
  // cannot know which of those it is about to become, and drawing the taller
  // guess would move every row under it when the answer arrived — so it draws
  // the line it is sure of.
  function filters() {
    const row = el('div', 'filters');
    for (const w of ['58px', '70px', '64px', '76px']) row.append(bar('chip', w));
    return row;
  }

  // ---------- what each view puts up while it loads ----------
  // `anchor` is the element the placeholder is inserted BEFORE — always the
  // container the screen renders into, so the bars land exactly where the rows
  // will. A view missing from here simply gets no placeholder.
  const PLANS = {
    runs: { anchor: 'runs-list', build: () => listOf(runsRow, ROWS) },
    run: { anchor: 'run-tests', build: () => listOf(testRow, ROWS) },
    tcstudio: { anchor: 'tc-tree', build: tree },
    promote: { anchor: 'promote-tree', build: tree },
    tclist: { anchor: 'tc-list', build: () => listOf(tcRow, ROWS) },
    test: { anchor: 'test-steps', build: lines },
  };

  function tree() {
    const ul = el('ul', 'list tc-tree is-static skeleton-rows');
    treeRows(ul);
    return ul;
  }

  // ---------- when a placeholder is worth drawing ----------
  // NOT immediately. A tab whose data is already warm — a small project, a
  // cached response, a second visit — answers inside a couple of hundred
  // milliseconds, and a placeholder there is a flash of grey between two painted
  // screens: it draws attention to a wait that was never felt, and the eye is
  // made to follow rows that jump the moment they arrive. Worse than nothing.
  //
  // So every placeholder is armed rather than shown, and a load that beats the
  // clock cancels it having never drawn a pixel. 250ms is where a panel stops
  // reading as instant — below it the answer lands inside the same glance, above
  // it the tester is waiting and wants to see that something is coming.
  const DELAY_MS = 250;

  // At most one placeholder is ever pending or on screen: the panel shows one
  // view at a time, and a second one left behind a tab switch would be a screen
  // the tester never gets back to.
  // { view, node } — `node` stays null while it is only armed, which is the whole
  // difference between "waiting to see if this is slow" and "this is slow".
  let pending = null;
  let timer = 0;

  // Arm the placeholder for `view` and hand back a HANDLE. A load takes it down
  // in a `finally`, and by then it may not be its own placeholder any more: a
  // project switch (or any second entry to the tab) strands the fetch that is
  // still in flight, and that stranded fetch settles AFTER the new one has armed
  // a placeholder of its own. Passing the handle back to hide() is what stops the
  // loser of that race from taking down the winner's screen.
  function show(view) {
    hide();
    const plan = PLANS[view];
    if (!plan || !$(plan.anchor)) return null;
    const handle = { view, node: null };
    pending = handle;
    timer = setTimeout(() => { timer = 0; mount(handle, plan); }, DELAY_MS);
    return handle;
  }

  // The clock ran out — this load is a wait, so draw it.
  function mount(handle, plan) {
    const anchor = $(plan.anchor);
    if (!anchor || pending !== handle) return; // the view moved on under the timer
    handle.node = plan.build();
    handle.node.classList.add('skeleton-enter');
    // Silent to a screen reader: the view's own status line already says
    // "Loading runs…" through a live region, and a dozen empty rows announced
    // beside it is noise, not information.
    handle.node.setAttribute('aria-hidden', 'true');
    anchor.before(handle.node);
  }

  // With a handle: take down that placeholder, and only while it is still the one
  // in hand. Without one: take down whatever is up — which is show()'s
  // (core/views.js) business, since a view change invalidates any of them. Either
  // way it disarms first: the common case is a load that finished inside the
  // delay, where there is nothing on screen to remove and the whole point is that
  // there never was.
  function hide(handle) {
    if (!pending || (handle && handle !== pending)) return;
    clearTimeout(timer);
    timer = 0;
    if (pending.node) pending.node.remove();
    pending = null;
  }

  // ---------- boot ----------

  // Arm the boot placeholder on the same clock as every other one: a panel whose
  // token, projects and runs all land inside the delay opens straight onto the
  // real thing, and the tester never sees a grey panel resolve into a list. Only
  // a boot that is genuinely a wait draws one.
  let bootTimer = 0;
  function paintBoot() {
    if (bootTimer || !$('boot-skeleton')) return; // idempotent: a second boot arms nothing
    bootTimer = setTimeout(drawBoot, DELAY_MS);
  }

  // The whole panel: the project strip and the tab row that are hidden until the
  // token resolves, over the content of the tab the boot is most likely to land
  // on. It cannot know which tab that is — the last session is still being read
  // out of storage when this draws — so it draws the runs list, which is the
  // default landing view and the shape both list tabs share.
  function drawBoot() {
    bootTimer = 0;
    const host = $('boot-skeleton');
    if (!host || host.firstChild) return;
    host.classList.add('skeleton-enter');

    // Label, project name, then the two square controls pinned right (Refresh
    // and the link out) — the spacer stands in for the dropdown container's
    // flex:1, which is what pushes them to the gutter on the real strip.
    const project = el('div', 'bar project-bar');
    project.append(bar('line sm', '46px'), bar('control sm', '140px'),
      el('span', 'bar-spacer'), bar('control sm square'), bar('control sm square'));

    // `.sticky` comes along with the tab row for a reason beyond looks: the
    // real row's bottom rule is an absolutely-positioned ::after, and .bar.sticky
    // is what it positions against.
    const tabs = el('div', 'bar sticky stretch header-top');
    const nav = el('nav', 'tabs fill sk-tabs');
    for (const w of ['44px', '38px', '58px']) {
      const tab = el('span', 'tab');
      tab.append(bar('circle'), bar('line', w));
      nav.append(tab);
    }
    tabs.append(nav);

    const body = el('div', 'sk-main');
    body.append(toolbar(), filters(), listOf(runsRow, ROWS));

    host.append(project, tabs, body);
  }

  // The placeholder has done its job the moment a real view can be painted —
  // whether it was drawn or is still only armed, which is the fast boot the delay
  // above exists for. Both halves matter: the flag brings the real header back,
  // and the container goes for good, since a boot happens once per panel open.
  function bootDone() {
    clearTimeout(bootTimer);
    bootTimer = 0;
    if (!document.body.dataset.booting) return;
    delete document.body.dataset.booting;
    const host = $('boot-skeleton');
    if (host) host.remove();
  }

  return { paintBoot, bootDone, show, hide };
})();
