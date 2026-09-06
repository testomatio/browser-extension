// The two rows that measure themselves: the filter chips that send their overflow into a "…" menu,
// and the create buttons that drop a word when the field beside them runs out of room. Read by
// core/views.js, which keeps fitFilterChips and initActionLabelFit as bare delegates to this.

/* global Icons, Tooltip */

// Every helper below the state is a `const`, never a declaration: a top-level `function` would sit
// on the page's global object, where a mistyped call resolves to something instead of throwing.

// ---------- filter chips: the row that sends its overflow to a menu ----------
// Measured, not guessed — the panel is user-resizable and counts change width, so
// there is no breakpoint: hide one chip at a time from the right, never "All".
const filterFitWidth = new WeakMap(); // last width each row was fitted at
const filterFitObserved = new WeakSet();
const filterMoreApi = new WeakMap(); // bar -> its trigger+menu, built once

// The observer also fires for the width the fit itself changed, hence the width
// guard — without it the row would re-fit forever.
const observeFilterFit = (bar) => {
  if (filterFitObserved.has(bar)) return;
  filterFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== filterFitWidth.get(bar)) Fit.filterChips(bar);
  }).observe(bar);
};

// ---------- create-button labels ----------
// Measured on the FIELD beside the button, not the button: these rows never wrap and
// the search is all that shrinks. 144 = "Search suites…" plus magnifier and padding.
const LABEL_FIT_MIN_FIELD = 144;
const labelFitWidth = new WeakMap(); // last width each row was fitted at
const labelFitObserved = new WeakSet();

const shortenLabel = (btn, on) => {
  btn.classList.toggle('is-short', on);
  // Shortened, the full label still has to survive as the accessible name.
  if (on && btn.dataset.label) btn.setAttribute('aria-label', btn.dataset.label);
  else btn.removeAttribute('aria-label');
};

// Width guard for the same reason the filter row's has one.
const observeLabelFit = (bar) => {
  if (labelFitObserved.has(bar)) return;
  labelFitObserved.add(bar);
  new ResizeObserver(() => {
    if (bar.clientWidth && bar.clientWidth !== labelFitWidth.get(bar)) Fit.actionLabels(bar);
  }).observe(bar);
};

const Fit = {
  // Built once per bar and reused across every fit — torn down and rebuilt while
  // open, the menu would close itself out from under the pointer.
  ensureFilterMore(bar) {
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
  },

  // One option per hidden chip. A pick clicks the real (hidden) chip, so it runs
  // the exact listener and render path a visible chip would.
  renderFilterMore(bar, hiddenChips) {
    const { wrap, trigger, menu, close } = Fit.ensureFilterMore(bar);
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
  },

  filterChips(bar) {
    if (!bar) return;
    // Armed before measuring: a row rendered while its screen is hidden has no
    // width, and the observer is what brings it back the moment it is shown.
    observeFilterFit(bar);
    const chips = [...bar.querySelectorAll(':scope > .filter-chip[data-filter]')];
    if (!chips.length || !bar.clientWidth) return;
    const { wrap } = Fit.ensureFilterMore(bar);
    if (wrap.parentNode !== bar) bar.append(wrap); // trigger always trails the real chips

    // Re-fit from the wide state, never from wherever the last fit left it, or a
    // panel dragged WIDER keeps chips hidden that now have room.
    for (const chip of chips) chip.hidden = false;
    wrap.hidden = true;
    if (bar.scrollWidth <= bar.clientWidth) {
      Fit.renderFilterMore(bar, []);
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
    Fit.renderFilterMore(bar, hidden);
    filterFitWidth.set(bar, bar.clientWidth);
  },

  actionLabels(bar) {
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
  },

  // Arm every toolbar once at boot; the observers do the rest.
  initActionLabels(root = document) {
    const bars = new Set();
    for (const btn of root.querySelectorAll('.fit-label')) {
      const bar = btn.closest('.toolbar');
      if (bar) bars.add(bar);
    }
    for (const bar of bars) Fit.actionLabels(bar);
  },
};
