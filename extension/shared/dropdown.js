// Dropdown (IIFE global `Dropdown`) — this extension's <select>.
//
// A native `<select>` is the one form control the design system could not reach.
// Chrome draws its popup at OS LEVEL: in a 380px side panel that lands as a
// huge menu placed beside the panel rather than under the field, in the OS's
// own font and the OS's own colours (a light box on a dark panel), and it can
// print nothing but plain option text — no icon per row, no muted second
// column, no monogram, no type-to-filter box. Every one of those is something a
// picker in this product actually needs.
//
// Three controls had already escaped it by hand-rolling the same listbox — the
// project switcher (#126), the assignee picker (M4) and the editor's priority
// chip (#34). This is that object, ONCE, so the fourth is a call instead of a
// fourth copy, and so the three native selects that were left (the editor's
// template picker, the panel's custom-status and the instance history) all
// close, open, filter and answer the arrow keys identically.
//
//   FACE      the closed control is the library's field face — the same border,
//             height, radius, hover, focus ring and disabled wash `.input` and
//             `.select` wear (components.css → FIELDS). It is a `<button>`, so
//             `disabled` is the real attribute and a gate's tooltip works on it.
//   VALUE     lives on the trigger as `dataset.value`, the convention the
//             project switcher set (`dataset.projectId`): a button has no
//             `.value` to ask, so the dataset is the machine-readable one.
//   CHANGE    `onChange` fires on a USER pick only, and only when the value
//             actually moves — a native select's `change`. `setValue()` is the
//             programmatic path and is silent, like assigning `select.value`.
//   POPUP     the shared `.menu` + `.menu-option` (components.css → MENU), so
//             the page holding it must not trap it in a stacking context of its
//             own — see the note on `.project-bar` in the panel's stylesheet.
//
// `Dropdown.of(id)` hands the controller back from anywhere. The panel is built
// on globals and `$('id')` lookups, so a registry keyed by the trigger's id is
// how a screen (or an e2e) reaches a control it did not construct, without
// threading the object through three modules to get there.

(() => {
  const registry = new Map(); // trigger id → controller

  const CARET = 'keyboard_arrow_down';
  const CHECK = 'check';

  // A row's label, for the default renderer and for the closed face.
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
    fallbackFirst = false,    // no value → the first row, the way a select has no empty state
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

    // The mark that says what KIND of thing is being picked, inside the field's
    // own border rather than as a label beside it — `.field-icon` is that
    // component already (components.css → FIELDS).
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

    // A popup that filtered down to nothing still has to SAY so — an empty box
    // under the cursor reads as the control being broken.
    const empty = window.EmptyState
      ? EmptyState.build({ compact: true, icon: 'search_off', text: emptyText, className: 'dropdown-empty' })
      : document.createElement('div');
    empty.hidden = true;
    menu.append(empty);

    root.append(trigger, menu);

    // ---- state -------------------------------------------------------------
    // `current` is the chosen value; `active` is the keyboard cursor, which only
    // lives as long as the popup is open. `query` is the filter text.
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
    // The label is always WRAPPED, never a bare text node: the face is a flex row
    // (a custom row can be an icon plus a word), and only an element child can
    // ellipsize inside one.
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
        // No option answers the current value: the placeholder is what the
        // control says instead, dimmed, so an unchosen field never reads as a
        // chosen one whose label happens to be blank.
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
        // The tick the OS menu drew for the chosen row, kept: the wash alone is
        // easy to read as hover. Shown by CSS on `aria-selected`, so it holds
        // its column in every row and nothing shifts as the choice moves.
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

    // Whatever holds focus while the popup is open is what points a screen
    // reader at the active row — the filter box when there is one, else the
    // trigger itself.
    function syncActive() {
      const owner = filterInput || trigger;
      // Read the row out of the LIST, not out of the document: an editor screen
      // that was torn down and rebuilt leaves a detached copy of these ids behind
      // for a moment, and getElementById would happily hand one back.
      const i = visibleRows().findIndex((o) => String(o.value) === String(active));
      const li = i === -1 ? null : list.children[i];
      if (li) { owner.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
      else owner.removeAttribute('aria-activedescendant');
    }

    // ±1 through the VISIBLE rows, clamped at the edges (no wrap) — the same
    // rule the panel's lists answer arrows with.
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

    // Open-state keys are handled at document level (capture) so they work
    // wherever focus sits, and so the screen's own arrow/Enter handlers never
    // see the keys that belong to the popup.
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
      // Space picks only where it is not also typing: with a filter box open it
      // is a character, and swallowing it would make the box refuse spaces.
      if (e.key === 'Enter' || (!filterInput && (e.key === ' ' || e.key === 'Spacebar'))) {
        e.preventDefault();
        e.stopPropagation();
        if (active != null) pick(active);
      }
    }

    // A user pick: close first (a change often repaints the screen under it),
    // then report — and only when the value actually moved, like `change`.
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

    // Closed-state keys open the popup; preventDefault also stops Enter/Space
    // from firing the button's own click, which would close it again.
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

      /** The chosen value ('' when nothing is). */
      get value() { return current; },
      /** The option object behind it, or null. */
      get selected() { return rowFor(current); },
      /** Every option currently offered. */
      get options() { return rows.slice(); },

      /** Replace the option list. Keeps the current value when it survives the
       *  swap, else falls back to `value` (or the first row when `fallbackFirst`
       *  — what a native select does, having no empty state to fall back to). */
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

      /** Choose as a tester would: sets the value AND reports the change. */
      pick,

      /** Close the popup if it is open (a screen swap, a gate landing). */
      close,

      get disabled() { return trigger.disabled; },
      set disabled(v) {
        trigger.disabled = !!v;
        if (v) close();
      },

      // The root is what carries the layout, the trigger is what carries the id
      // a caller looks the control up by — so hiding has to move both, or
      // `document.getElementById(id).hidden` would answer for a control that is
      // demonstrably off the screen.
      get hidden() { return root.hidden; },
      set hidden(v) {
        root.hidden = !!v;
        trigger.hidden = !!v;
        if (v) close();
      },

      /** Drop it from the registry — for a control whose host is being torn
       *  down and rebuilt (the editor mounts a fresh screen per test). */
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

  /** The controller behind a trigger id — how a screen (or an e2e) reaches a
   *  control it did not build. */
  const of = (id) => registry.get(typeof id === 'string' ? id : (id && id.id)) || null;

  window.Dropdown = { create, of };
})();
