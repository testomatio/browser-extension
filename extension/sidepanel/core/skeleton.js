// Loading placeholders (IIFE global `Skeleton`), composed from the real screens' own
// components. Mounted as a SIBLING of the list, never inside it — the e2e counts rows there.

/* global $, Sk */

const Skeleton = (() => {
  // Bars come from shared/skeleton.js; this file is only the PLANS — which shape
  // each panel view puts up, and when.
  const { el, bar, lines } = Sk;

  // Varied widths: a stack of equal bars reads as a barcode rather than a list.
  const TITLE_W = ['72%', '54%', '66%', '47%', '61%', '77%', '58%', '69%'];
  // Enough rows to reach the bottom of a side panel; overshooting costs nothing.
  const ROWS = 9;
  const TREE_ROWS = 5; // suite roots; two of them carry children (see treeRows)

  const pick = (arr, i) => arr[i % arr.length];

  // ---------- rows, one per list the panel draws ----------

  // Runs list (screens/runs-list.js runRow): one line — status glyph + title.
  function runsRow(i) {
    const li = el('li');
    const head = el('div', 'list-head');
    head.append(bar('circle'), bar('line', pick(TITLE_W, i)));
    li.append(head);
    return li;
  }

  // Run view checklist (screens/run-view.js testRow). The bar goes IN a `.title`:
  // a row's line is 20px tall whatever it carries, where a bare bar is 13px.
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

  // Suite tree (screens/tc-studio.js tcNode). The count is a LINE, not a chip —
  // the real row's is plain text at the trailing edge (`.row-count`).
  function treeRow(i, { folder = true } = {}) {
    const li = el('li', 'tc-item');
    const row = el('div', 'list-row tc-row list-head');
    const lead = bar('circle'); // the chevron column: drawn for a folder, kept blank for a file
    if (!folder) lead.style.visibility = 'hidden';
    row.append(lead);
    row.append(bar('circle'), bar('line', pick(TITLE_W, i)), bar('line sm row-count', '16px'));
    li.append(row);
    return li;
  }

  // Two roots come back open, their files indented in the tree's own `.tc-children`.
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

  // The runs toolbar: search + "New run" (Refresh lives in the project strip).
  // 96px is that button measured at the width this panel opens at.
  function toolbar() {
    const row = el('div', 'toolbar runs-bar');
    row.append(bar('control sm fill'), bar('control sm', '96px'));
    return row;
  }

  // Four chips where the runs list draws six: the rest go to the overflow menu at
  // panel widths (fitFilterChips), and the taller guess would move every row under it.
  // A filter chip is a `.btn.size-sm` on BOTH screens (buildFilterChip in runs-list.js,
  // renderRunFilterChips in run-view.js) and never the 20px `.chip`, which is what used
  // to lift every row below this one by 8px when the real row landed.
  function filters() {
    const row = el('div', 'filters');
    for (const w of ['58px', '70px', '64px', '76px']) row.append(bar('control sm', w));
    return row;
  }

  // The run screen WHOLE — its card and its controls paint empty (every field of the
  // summary is [hidden] until the read lands, the chip row is built from the records),
  // so a placeholder over the list alone leaves an empty box above it, which reads as a
  // screen that failed rather than one loading. `hides` takes the real two away meanwhile.
  function runScreen() {
    const box = el('div', 'sk-run');

    const card = el('div', 'card run-summary');
    // The real row hangs Finish off `margin-left: auto`; a bar has no margin of its own.
    const stateRow = el('div', 'run-state-row');
    stateRow.append(bar('chip', '64px'), bar('chip', '72px'), el('span', 'bar-spacer'),
      bar('control sm', '84px'));
    // #run-progress is an id on an unstyled div, so this is progressNodes() itself: the
    // counts LINE (its own line box, which is where the height comes from — hence an
    // inline bar) over the real 5px track, both keeping the margins their classes give.
    const progress = el('div');
    const counts = el('div', 'hint counts');
    counts.append(bar('line sm inline', '26px'));
    const track = el('div', 'progress');
    track.append(bar('fill'));
    progress.append(counts, track);
    // Run info drawn OPEN — its fold is remembered, but open is the default and the common
    // case. Its own three classes, so the foot bleeds and the head bleeds exactly as there.
    const foot = el('div', 'disclosure card-foot run-info');
    const head = el('div', 'disclosure-head');
    head.append(bar('circle'), bar('line', '54px'));
    // The five rows a live run shows: Status, Tests, Started, Assigned to, Created.
    const kv = el('dl', 'disclosure-body kv rows');
    for (const w of ['110px', '24px', '140px', '120px', '140px']) {
      const dt = el('dt');
      dt.append(bar('line sm', '52px'));
      const dd = el('dd');
      dd.append(bar('line sm', w));
      kv.append(dt, dd);
    }
    foot.append(head, kv);
    card.append(stateRow, progress, foot);

    // Same blocks in the same order as the screen behind it, in the screen's own classes:
    // card, search, chips, checklist — so the real paint lands on these pixels.
    box.append(card, bar('control sm fill'), filters(), listOf(testRow, ROWS));
    return box;
  }

  // ---------- what each view puts up while it loads ----------
  // `anchor` is the element the placeholder is inserted BEFORE — the container the
  // screen renders into. `hides` (optional) are the elements it stands IN FOR: hidden
  // while it is up, shown again when it comes down, for a block that would otherwise sit
  // there empty beside the placeholder. A view missing from here gets no placeholder.
  const PLANS = {
    runs: { anchor: 'runs-list', build: () => listOf(runsRow, ROWS) },
    run: { anchor: 'run-header', hides: ['run-header', 'run-controls'], build: runScreen },
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

  // ---------- when a placeholder is drawn ----------
  // A NAVIGATION draws its own at once. The screen it left is already gone, so a
  // clock buys nothing: what it bought was an empty view that fills 150ms later,
  // which reads as a flash of nothing rather than as speed. Only the boot still
  // waits (paintBoot) — there the panel is the placeholder, and a fast open should
  // land on the real thing having drawn none.
  const DELAY_MS = 250; // boot only

  // At most one placeholder on screen, `{ view, node }` — the handle a caller holds.
  let pending = null;

  // Hand back a HANDLE: a stranded fetch settles AFTER a newer one put its own
  // placeholder up, and the handle is what stops it taking down the winner's screen.
  function show(view) {
    hide();
    const plan = PLANS[view];
    if (!plan || !$(plan.anchor)) return null;
    const handle = { view, node: null };
    pending = handle;
    mount(handle, plan);
    return handle;
  }

  // The blocks the placeholder stands in for. Nothing is remembered on the way in:
  // what a plan hides is a block the screen shows at every other moment.
  function setHidden(plan, on) {
    for (const id of plan?.hides || []) {
      const node = $(id);
      if (node) node.hidden = on;
    }
  }

  // The screen has opened with nothing in it — draw it.
  function mount(handle, plan) {
    const anchor = $(plan.anchor);
    if (!anchor) return;
    handle.node = plan.build();
    handle.node.classList.add('skeleton-enter');
    // Silent to a screen reader: the view's own status line already announces the load.
    handle.node.setAttribute('aria-hidden', 'true');
    anchor.before(handle.node);
    setHidden(plan, true);
  }

  // With a handle: only while it is still the one in hand. Without: take down whatever
  // is up (a view change invalidates any). Both paths give the hidden blocks back.
  function hide(handle) {
    if (!pending || (handle && handle !== pending)) return;
    if (pending.node) pending.node.remove();
    setHidden(PLANS[pending.view], false);
    pending = null;
  }

  // ---------- boot ----------

  // The one placeholder still on a clock — only a boot that is really a wait draws one.
  let bootTimer = 0;
  function paintBoot() {
    if (bootTimer || !$('boot-skeleton')) return; // idempotent: a second boot arms nothing
    bootTimer = setTimeout(drawBoot, DELAY_MS);
  }

  // The whole panel. Which tab the boot lands on is not known yet (the last session
  // is still being read out of storage), so it draws the runs list.
  function drawBoot() {
    bootTimer = 0;
    const host = $('boot-skeleton');
    if (!host || host.firstChild) return;
    host.classList.add('skeleton-enter');

    // The spacer stands in for the dropdown container's flex:1, which is what pushes
    // the two square controls to the gutter on the real strip.
    const project = el('div', 'bar project-bar');
    project.append(bar('line sm', '46px'), bar('control sm', '140px'),
      el('span', 'bar-spacer'), bar('control sm square'), bar('control sm square'));

    // `.sticky` is not just looks: the real row's bottom rule is an absolutely
    // positioned ::after, and .bar.sticky is what it positions against.
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

  // Both halves matter: the flag brings the real header back, and the container goes
  // for good — a boot happens once per panel open.
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
