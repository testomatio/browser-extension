// Mounted as a sibling of the list, never inside it: the e2e counts rows there.

/* global $, Sk */

const Skeleton = (() => {
  // Bars come from shared/skeleton.js; this file holds the plans: which shape each view puts up.
  const { el, bar, lines } = Sk;

  // Varied widths: a stack of equal bars reads as a barcode rather than a list.
  const TITLE_W = ['72%', '54%', '66%', '47%', '61%', '77%', '58%', '69%'];
  // Enough rows to reach the bottom of a side panel; overshooting costs nothing.
  const ROWS = 9;
  const TREE_ROWS = 5; // suite roots; two of them carry children (see treeRows)

  const pick = (arr, i) => arr[i % arr.length];

  // Runs list (screens/runs-list.js runRow): one line — status glyph + title.
  function runsRow(i) {
    const li = el('li');
    const head = el('div', 'list-head');
    head.append(bar('circle'), bar('line', pick(TITLE_W, i)));
    li.append(head);
    return li;
  }

  // The bar goes in a `.title`: a row's line is 20px tall whatever it carries, a bare bar 13px.
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

  // The count is a line, not a chip: the real row's is plain text at the trailing edge.
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

  const listOf = (row, n) => {
    const ul = el('ul', 'list is-static skeleton-rows');
    for (let i = 0; i < n; i += 1) ul.append(row(i));
    return ul;
  };

  // 96px is the "New run" button measured at the width this panel opens at.
  function toolbar() {
    const row = el('div', 'toolbar runs-bar');
    row.append(bar('control sm fill'), bar('control sm', '96px'));
    return row;
  }

  // Four chips, not six: the rest overflow at panel widths, and a taller guess would move every row.
  function filters() {
    const row = el('div', 'filters');
    for (const w of ['58px', '70px', '64px', '76px']) row.append(bar('control sm', w));
    return row;
  }

  // The run screen whole: a placeholder over the list alone leaves an empty card that reads as failed.
  function runScreen() {
    const box = el('div', 'sk-run');

    const card = el('div', 'card run-summary');
    // The real row hangs Finish off `margin-left: auto`; a bar has no margin of its own.
    const stateRow = el('div', 'run-state-row');
    stateRow.append(bar('chip', '64px'), bar('chip', '72px'), el('span', 'bar-spacer'),
      bar('control sm', '84px'));
    // The counts line (its own line box gives the height, hence an inline bar) over the 5px track.
    const progress = el('div');
    const counts = el('div', 'hint counts');
    counts.append(bar('line sm inline', '26px'));
    const track = el('div', 'progress');
    track.append(bar('fill'));
    progress.append(counts, track);
    // Run info drawn open: its fold is remembered, but open is the default and the common case.
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

    // The same blocks in the screen's order and classes, so the real paint lands on these pixels.
    box.append(card, bar('control sm fill'), filters(), listOf(testRow, ROWS));
    return box;
  }

  // Inserted before `anchor`; `hides` are blocks it stands in for, hidden only while it is up.
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

  // A navigation draws its own at once: a clock only buys a flash of empty view. Boot still waits.
  const DELAY_MS = 250; // boot only

  // At most one placeholder on screen, `{ view, node }` — the handle a caller holds.
  let pending = null;

  // A stranded fetch settles after a newer one; the handle stops it taking down the winner's screen.
  function show(view) {
    hide();
    const plan = PLANS[view];
    if (!plan || !$(plan.anchor)) return null;
    const handle = { view, node: null };
    pending = handle;
    mount(handle, plan);
    return handle;
  }

  // Nothing is remembered on the way in: a hidden block is one the screen shows at every other moment.
  function setHidden(plan, on) {
    for (const id of plan?.hides || []) {
      const node = $(id);
      if (node) node.hidden = on;
    }
  }

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

  // With a handle, only while it is still the one in hand; without, whatever is up.
  function hide(handle) {
    if (!pending || (handle && handle !== pending)) return;
    if (pending.node) pending.node.remove();
    setHidden(PLANS[pending.view], false);
    pending = null;
  }

  // The one placeholder still on a clock — only a boot that is really a wait draws one.
  let bootTimer = 0;
  function paintBoot() {
    if (bootTimer || !$('boot-skeleton')) return; // idempotent: a second boot arms nothing
    bootTimer = setTimeout(drawBoot, DELAY_MS);
  }

  // The boot tab is not known yet (the session is still being read), so it draws the runs list.
  function drawBoot() {
    bootTimer = 0;
    const host = $('boot-skeleton');
    if (!host || host.firstChild) return;
    host.classList.add('skeleton-enter');

    // The spacer stands in for the dropdown's flex:1, which pushes the square controls to the gutter.
    const project = el('div', 'bar project-bar');
    project.append(bar('line sm', '46px'), bar('control sm', '140px'),
      el('span', 'bar-spacer'), bar('control sm square'), bar('control sm square'));

    // `.sticky` is not just looks: the real row's bottom rule is an ::after positioned against it.
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

  // The flag brings the real header back, and the container goes for good: one boot per open.
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
