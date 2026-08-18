// Dropdown (IIFE global `Dropdown`) — this extension's <select>: a `<button>` face plus the
// shared `.menu`, so the host must not trap the popup in a stacking context of its own.

(() => {
  const registry = new Map(); // trigger id → controller

  const CARET = 'keyboard_arrow_down';
  const CHECK = 'check';

  const labelOf = (opt) => (opt && opt.label != null ? String(opt.label) : String(opt && opt.value || ''));

  function create({
    id,                       // the trigger's id — also the registry key
    className = '',           // extra classes on the root (the positioning anchor)
    triggerClass = '',        // extra classes on the closed face (e.g. `size-sm`)
    label = '',               // accessible name for the trigger AND the listbox
    labelledBy = '',          // …or point at an existing label element instead
    placeholder = '',         // the closed face when no option is chosen
    options = [],
    value = '',
    fallbackFirst = false,    // no value → the first row; a select has no empty state
    icon = '',                // optional mark INSIDE the field, `.field-icon`
    align = 'start',          // which edge the popup is anchored to
    filter = false,           // type-to-filter box above the rows
    filterPlaceholder = 'Search…',
    filterLabel = '',
    emptyText = 'No match',
    renderOption = null,      // (opt) => Node — a row that is more than its label
    onChange = null,
  } = {}) {
    if (!id) throw new Error('Dropdown.create needs an id');

    const root = document.createElement('div');
    root.className = `dropdown${className ? ` ${className}` : ''}`;

    // `.field-icon` (components.css → FIELDS): the mark sits inside the field's border.
    if (icon && window.Icons) {
      const mark = Icons.el(icon, 16, 'field-icon');
      if (mark) root.append(mark);
    }

    const listId = `${id}-list`;
    const trigger = document.createElement('button');
    trigger.id = id;
    trigger.type = 'button';
    trigger.className = `dropdown-trigger${triggerClass ? ` ${triggerClass}` : ''}`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);
    if (labelledBy) trigger.setAttribute('aria-labelledby', labelledBy);
    else if (label) trigger.setAttribute('aria-label', label);

    const face = document.createElement('span');
    face.className = 'dropdown-value';
    trigger.append(face);
    if (window.Icons) {
      const caret = Icons.el(CARET, 16, 'dropdown-caret');
      if (caret) trigger.append(caret);
    }

    const menu = document.createElement('div');
    menu.className = `menu dropdown-menu${align === 'end' ? ' align-end' : ''}`;
    menu.hidden = true;

    let filterInput = null;
    if (filter) {
      filterInput = document.createElement('input');
      filterInput.id = `${id}-filter`;
      filterInput.className = 'input size-sm dropdown-filter';
      filterInput.type = 'text';
      filterInput.autocomplete = 'off';
      filterInput.spellcheck = false;
      filterInput.placeholder = filterPlaceholder;
      filterInput.setAttribute('aria-label', filterLabel || filterPlaceholder);
      filterInput.setAttribute('aria-controls', listId);
      menu.append(filterInput);
    }

    const list = document.createElement('ul');
    list.id = listId;
    list.className = 'menu-list dropdown-list';
    list.setAttribute('role', 'listbox');
    if (label) list.setAttribute('aria-label', label);
    menu.append(list);

    // A popup filtered down to nothing must SAY so — an empty box reads as broken.
    const empty = window.EmptyState
      ? EmptyState.build({ compact: true, icon: 'search_off', text: emptyText, className: 'dropdown-empty' })
      : document.createElement('div');
    empty.hidden = true;
    menu.append(empty);

    root.append(trigger, menu);

    // ---- state -------------------------------------------------------------
    // `active` is the keyboard cursor, alive only while the popup is open.
    let rows = [];
    let current = '';
    let active = null;
    let query = '';

    const visibleRows = () => {
      if (!filter) return rows;
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((o) => `${labelOf(o)} ${o.value}`.toLowerCase().includes(q));
    };
    const rowFor = (v) => rows.find((o) => String(o.value) === String(v)) || null;
    const optId = (i) => `${id}-opt-${i}`;

    // ---- the closed face ---------------------------------------------------
    // Always WRAPPED, never a bare text node: only an element child ellipsizes in a flex row.
    function faceText(s) {
      const span = document.createElement('span');
      span.className = 'dropdown-value-text';
      span.textContent = s;
      return span;
    }

    function paintFace() {
      const opt = rowFor(current);
      trigger.dataset.value = current;
      face.replaceChildren();
      if (opt) {
        face.classList.remove('placeholder');
        face.append(renderOption ? renderOption(opt) : faceText(labelOf(opt)));
      } else {
        // Dimmed placeholder, so an unchosen field never reads as a chosen blank one.
        face.classList.add('placeholder');
        face.append(faceText(placeholder));
      }
    }

    // ---- the rows ----------------------------------------------------------
    function paintRows() {
      const shown = visibleRows();
      if (!shown.some((o) => String(o.value) === String(active))) {
        active = shown.length ? String(shown[0].value) : null;
      }
      list.replaceChildren(...shown.map((opt, i) => {
        const li = document.createElement('li');
        li.id = optId(i);
        li.className = 'menu-option dropdown-option';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(opt.value) === String(current) ? 'true' : 'false');
        li.dataset.value = opt.value;
        li.classList.toggle('active', String(opt.value) === String(active));

        const body = renderOption ? renderOption(opt) : null;
        if (body) li.append(body);
        else {
          const text = document.createElement('span');
          text.className = 'dropdown-option-label';
          text.textContent = labelOf(opt);
          li.append(text);
        }
        // Shown by CSS on `aria-selected`, and built into EVERY row so the column never shifts.
        if (window.Icons) {
          const tick = Icons.el(CHECK, 14, 'dropdown-option-check');
          if (tick) li.append(tick);
        }
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus where it is
        li.addEventListener('click', () => pick(opt.value));
        return li;
      }));
      empty.hidden = shown.length > 0;
      syncActive();
    }

    // `aria-activedescendant` goes on whatever holds focus: the filter box, else the trigger.
    function syncActive() {
      const owner = filterInput || trigger;
      // Read the row out of the LIST, not the document: a torn-down editor screen leaves
      // a detached copy of these ids behind, and getElementById would hand one back.
      const i = visibleRows().findIndex((o) => String(o.value) === String(active));
      const li = i === -1 ? null : list.children[i];
      if (li) { owner.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
      else owner.removeAttribute('aria-activedescendant');
    }

    // ±1 through the VISIBLE rows, clamped at the edges (no wrap).
    function move(delta) {
      const shown = visibleRows();
      if (!shown.length) return;
      const from = shown.findIndex((o) => String(o.value) === String(active));
      const to = from === -1 ? 0 : Math.min(Math.max(from + delta, 0), shown.length - 1);
      active = String(shown[to].value);
      for (const li of list.children) li.classList.toggle('active', li.dataset.value === active);
      syncActive();
    }

    // ---- open / close ------------------------------------------------------
    function open() {
      if (!menu.hidden || trigger.disabled) return;
      query = '';
      active = current || null;
      if (filterInput) filterInput.value = '';
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      paintRows();
      if (filterInput) filterInput.focus(); // typing filters straight away
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }

    function close({ focus = false } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      (filterInput || trigger).removeAttribute('aria-activedescendant');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      if (focus) trigger.focus();
    }

    function onDocClick(e) { if (!root.contains(e.target)) close(); }

    // Document-level capture: works wherever focus sits, and the screen's own
    // arrow/Enter handlers never see the keys that belong to the popup.
    function onDocKey(e) {
      if (menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ focus: true }); return; }
      if (e.key === 'Tab') { close(); return; } // focus is leaving — let it
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      // Space picks only where it is not also a character — a filter box must take spaces.
      if (e.key === 'Enter' || (!filterInput && (e.key === ' ' || e.key === 'Spacebar'))) {
        e.preventDefault();
        e.stopPropagation();
        if (active != null) pick(active);
      }
    }

    // Close first (a change often repaints the screen under it), then report — and
    // only when the value actually moved, like a native `change`.
    function pick(v) {
      const opt = rowFor(v);
      if (!opt) return;
      const changed = String(opt.value) !== String(current);
      current = String(opt.value);
      paintFace();
      close({ focus: true });
      if (changed && onChange) onChange(current, opt);
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation(); // the doc-level close listener would swallow the toggle
      if (menu.hidden) open(); else close({ focus: true });
    });

    // preventDefault also stops Enter/Space firing the button's own click, which would
    // close the popup again.
    trigger.addEventListener('keydown', (e) => {
      if (!menu.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        open();
      }
    });

    if (filterInput) {
      filterInput.addEventListener('input', () => {
        query = filterInput.value;
        active = null; // the first match becomes the cursor
        paintRows();
      });
    }

    const api = {
      el: root,
      trigger,
      menu,

      get value() { return current; },
      get selected() { return rowFor(current); },
      get options() { return rows.slice(); },

      /** Keeps the current value when it survives the swap, else `value`, else the
       *  first row when `fallbackFirst` (a native select has no empty state). */
      setOptions(next, { value: want, fallbackFirst: first = fallbackFirst } = {}) {
        rows = (next || []).map((o) => (
          o && typeof o === 'object' ? { ...o, value: String(o.value) } : { value: String(o), label: String(o) }
        ));
        const wanted = want != null ? String(want) : current;
        current = rowFor(wanted) ? wanted : (first && rows.length ? String(rows[0].value) : '');
        paintFace();
        if (!menu.hidden) paintRows();
        return api;
      },

      /** Programmatic set — silent, like assigning to `select.value`. */
      setValue(v) {
        const next = v == null ? '' : String(v);
        current = rowFor(next) ? next : '';
        paintFace();
        if (!menu.hidden) paintRows();
        return api;
      },

      /** Sets the value AND reports the change, unlike setValue. */
      pick,

      close,

      get disabled() { return trigger.disabled; },
      set disabled(v) {
        trigger.disabled = !!v;
        if (v) close();
      },

      // The id is on the TRIGGER and the layout on the root, so hiding must move both —
      // else `getElementById(id).hidden` answers false for a control that is off screen.
      get hidden() { return root.hidden; },
      set hidden(v) {
        root.hidden = !!v;
        trigger.hidden = !!v;
        if (v) close();
      },

      /** Drop it from the registry — the editor mounts a fresh screen per test. */
      destroy() {
        close();
        if (registry.get(id) === api) registry.delete(id);
        root.remove();
      },
    };

    api.setOptions(options, { value });
    registry.set(id, api);
    return api;
  }

  /** The controller behind a trigger id — how a screen reaches a control it did not build. */
  const of = (id) => registry.get(typeof id === 'string' ? id : (id && id.id)) || null;

  window.Dropdown = { create, of };
})();
