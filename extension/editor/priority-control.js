// The test's priority picker (IIFE global `PriorityControl`): a custom listbox, because a native
// <option> cannot render the priority glyph. Its own file — one widget, its own test file.

/* global PriorityIcons, Icons, Tooltip */
const PriorityControl = (() => {
  // ---- priority dropdown (custom listbox; <option> can't render SVG) ------
  // Backed by the button's dataset.priority — the save path reads it too.
  function buildPriorityControl(initial, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'tc-priority-wrap';

    const btn = document.createElement('button');
    btn.id = 'tc-priority';
    btn.type = 'button';
    btn.className = 'btn tc-priority size-sm';
    Tooltip.set(btn, 'Priority');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('ul');
    menu.id = 'tc-priority-menu';
    menu.className = 'menu tc-priority-menu';
    menu.setAttribute('role', 'listbox');
    // The open list takes the caret — focusable, never in the tab order — so it is the element that
    // can name an option in aria-activedescendant, and the button says which list it opens.
    menu.setAttribute('tabindex', '-1');
    menu.setAttribute('aria-label', 'Priority');
    menu.hidden = true;
    btn.setAttribute('aria-controls', menu.id);

    const opts = new Map();
    for (const p of PriorityIcons.ORDER) {
      const li = document.createElement('li');
      li.className = 'menu-option';
      li.id = `tc-priority-opt-${p}`;
      li.setAttribute('role', 'option');
      li.dataset.priority = p;
      li.innerHTML = `<span class="tc-priority-ico">${PriorityIcons.svg(p)}</span><span class="tc-priority-label">${p}</span>`;
      li.addEventListener('click', () => selectPriority(p));
      menu.append(li);
      opts.set(p, li);
    }

    let current = PriorityIcons.ORDER.includes(initial) ? initial : 'normal';
    let active = current;

    function renderButton() {
      btn.dataset.priority = current;
      btn.innerHTML = `<span class="tc-priority-ico">${PriorityIcons.svg(current, 16)}</span><span class="tc-priority-label">${current}</span>${Icons.markup('keyboard_arrow_down', 16, { cls: 'tc-priority-caret' })}`;
    }

    function setActive(p) {
      active = p;
      for (const [pp, li] of opts) {
        li.classList.toggle('active', pp === p);
        li.setAttribute('aria-selected', pp === p ? 'true' : 'false');
      }
      menu.setAttribute('aria-activedescendant', opts.get(p).id);
    }

    function onDocClick(e) { if (!wrap.contains(e.target)) closeMenu(); }

    // Open-state keys are handled at document level (capture) so Esc / arrows work
    // regardless of which element holds focus.
    function onDocKey(e) {
      if (menu.hidden) return;
      const key = e.key;
      if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ focus: true }); return; }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        const order = PriorityIcons.ORDER;
        const i = order.indexOf(active);
        setActive(key === 'ArrowDown' ? order[Math.min(i + 1, order.length - 1)] : order[Math.max(i - 1, 0)]);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') { e.preventDefault(); selectPriority(active); }
    }

    function openMenu() {
      if (!menu.hidden) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      setActive(current);
      menu.focus(); // named its active option first, so the move announces the highlight with it
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }
    function closeMenu({ focus = false } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      menu.removeAttribute('aria-activedescendant');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      if (focus) btn.focus();
    }

    function selectPriority(p) {
      const changed = p !== current;
      current = p;
      renderButton();
      closeMenu({ focus: true });
      if (changed) onChange && onChange();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });

    // Closed-state keys open the menu; open-state keys are handled by onDocKey.
    btn.addEventListener('keydown', (e) => {
      if (!menu.hidden) return;
      const key = e.key;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        openMenu();
      }
    });

    wrap.append(btn, menu);
    renderButton();

    return {
      wrap,
      getPriority: () => btn.dataset.priority,
      // The e2e hook's set, like its setTitle and setMarkdown: always marks dirty, never opens
      // the menu. Not a preselect — an editor's starting value arrives as this function's argument.
      setPriority: (p) => {
        if (!PriorityIcons.ORDER.includes(p)) return;
        current = p;
        renderButton();
        onChange && onChange();
      },
    };
  }

  return { buildPriorityControl };
})();
