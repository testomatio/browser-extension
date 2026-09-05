// The test's workflow metadata (IIFE global `TestMeta`): the custom status the project replies with
// and the person the result is assigned to. Neither is the verdict — each is written on its own
// request, gated on its own rule (a marked row is no longer re-assignable, a locked run refuses a
// custom status), and the verdict path only asks this to repaint. So it used to share one closure
// with the screen that marks a test, and a change to the assignee listbox meant editing that screen.
//
// The assignee is a hand-built listbox rather than the shared Dropdown, because an OS menu draws
// neither a monogram nor a filter box — hence the cursor, the keyboard block and the popup below.

/* global TestomatAPI, Dropdown, Tooltip, UserCell, Icons, state, capabilities, usersList, $,
   recordFor, RunLock, displayStatus, runRepliesFor, syncBeginWrite, syncEndWrite,
   isAuthError, setAuthExpiredLine, toast */

const TestMeta = (() => {
  // Read-only mark of the custom status (#109) — tinted by the row's STATUS, not
  // the value, and JWT-gated like the select that writes it.
  function renderSubstatusMark(record) {
    const el = $('test-substatus-mark');
    if (!el) return;
    const sub = typeof record?.substatus === 'string' ? record.substatus.trim() : '';
    const show = capabilities.jwt && !!sub;
    el.hidden = !show;
    el.className = `badge custom-status ${show ? displayStatus(record) : ''}`.trim();
    el.textContent = show ? sub : '';
    if (show) Tooltip.set(el, `Custom status: ${sub}`);
  }

  // JWT-only, and only once the row has a real status AND the project defines
  // replies for it. The empty row is how a custom status comes back off.
  const SUBSTATUS_NONE = '— none —';

  // Wired once from app init — the mount is static markup, the control is not.
  function initSubstatusDropdown() {
    const mount = $('substatus-mount');
    if (!mount || Dropdown.of('substatus-select')) return;
    mount.append(Dropdown.create({
      id: 'substatus-select',
      className: 'substatus-dd',
      labelledBy: 'substatus-label',
      label: 'Custom status',
      placeholder: SUBSTATUS_NONE,
      onChange: onSubstatusChange,
    }).el);
  }

  function renderSubstatus(record) {
    const wrap = $('test-substatus');
    const dd = Dropdown.of('substatus-select');
    if (!wrap || !dd) return;
    const status = record?.status;
    const group = runRepliesFor(status);
    const show = capabilities.jwt && !!record?.id && !!status && status !== 'pending' && group.length > 0;
    wrap.hidden = !show;
    if (!show) { dd.setOptions([]); return; }
    dd.setOptions(
      [{ value: '', label: SUBSTATUS_NONE }, ...group.map((r) => ({ value: r, label: r }))],
      { value: group.includes(record.substatus) ? record.substatus : '' });
  }

  // JWT-only, custom listbox (an OS menu draws no monogram or filter box). The v2
  // read folds the assignee to ONE email, so single-select — more would be unpicked.
  let assigneeFilter = '';
  let assigneeActiveId = null;

  function assigneeRows() {
    const rows = [{ id: '', name: 'Unassigned', email: '' }, ...(usersList || [])];
    const q = assigneeFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((u) => `${u.name || ''} ${u.email || ''}`.toLowerCase().includes(q));
  }

  function renderAssignee(record) {
    const wrap = $('test-assignee');
    const trigger = $('assignee-trigger');
    if (!wrap || !trigger) return;
    const show = capabilities.jwt && !!record?.id;
    wrap.hidden = !show;
    if (!show) { closeAssigneeMenu(); applyAssigneeGate(null); return; }
    paintAssigneeTrigger(record);
    if ($('assignee-menu') && !$('assignee-menu').hidden) renderAssigneeOptions();
    applyAssigneeGate(record); // #153 — a marked row is no longer re-assignable
  }

  function paintAssigneeTrigger(record) {
    const trigger = $('assignee-trigger');
    const valueSlot = $('assignee-value');
    if (!trigger || !valueSlot) return;
    const id = assignedUserId(record);
    trigger.dataset.userId = id;
    const user = id ? (usersList || []).find((u) => String(u.id) === id) : null;
    valueSlot.replaceChildren(user ? UserCell.cell(user) : unassignedCell());
  }

  // Same `.user-cell` shape as a real person, so it sits in the same column.
  function unassignedCell() {
    const cell = document.createElement('span');
    cell.className = 'user-cell';
    const mark = document.createElement('span');
    mark.className = 'avatar';
    mark.setAttribute('aria-hidden', 'true');
    mark.append(Icons.el('person', 12));
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = 'Unassigned';
    cell.append(mark, name);
    return cell;
  }

  // ---- the popup (search + rows) --------------------------------------------

  function renderAssigneeOptions() {
    const list = $('assignee-list');
    if (!list) return;
    const record = recordFor(state.currentRecordId);
    const current = assignedUserId(record);
    const rows = assigneeRows();
    if (!rows.some((u) => u.id === assigneeActiveId)) assigneeActiveId = rows.length ? rows[0].id : null;
    list.replaceChildren(...rows.map((u) => {
      const li = document.createElement('li');
      li.id = `assignee-opt-${u.id || 'none'}`;
      li.className = 'menu-option assignee-option';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', u.id === current ? 'true' : 'false');
      li.dataset.userId = u.id;
      li.classList.toggle('active', u.id === assigneeActiveId);
      li.append(u.id === '' ? unassignedCell() : UserCell.cell(u));
      li.append(Icons.el('check', 14, 'assignee-option-check'));
      li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the filter
      li.addEventListener('click', () => pickAssignee(u.id));
      return li;
    }));
    const empty = $('assignee-empty');
    if (empty) empty.hidden = rows.length > 0;
    syncAssigneeActiveOption();
  }

  function syncAssigneeActiveOption() {
    const input = $('assignee-filter');
    if (!input) return;
    const li = assigneeActiveId != null ? $(`assignee-opt-${assigneeActiveId || 'none'}`) : null;
    if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  function openAssigneeMenu() {
    const menu = $('assignee-menu');
    const trigger = $('assignee-trigger');
    if (!menu || !trigger || trigger.disabled || !menu.hidden) return;
    assigneeFilter = '';
    assigneeActiveId = assignedUserId(recordFor(state.currentRecordId));
    const input = $('assignee-filter');
    if (input) input.value = '';
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    renderAssigneeOptions();
    if (input) input.focus(); // typing filters straight away
    document.addEventListener('click', onAssigneeDocClick, true);
    document.addEventListener('keydown', onAssigneeMenuKey, true);
  }

  function closeAssigneeMenu({ focus = false } = {}) {
    const menu = $('assignee-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const trigger = $('assignee-trigger');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    document.removeEventListener('click', onAssigneeDocClick, true);
    document.removeEventListener('keydown', onAssigneeMenuKey, true);
  }

  function onAssigneeDocClick(e) {
    const dd = $('assignee-dd');
    if (dd && !dd.contains(e.target)) closeAssigneeMenu();
  }

  // Document-level capture, so the keys work wherever focus sits.
  function onAssigneeMenuKey(e) {
    const menu = $('assignee-menu');
    if (!menu || menu.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAssigneeMenu({ focus: true }); return; }
    if (e.key === 'Tab') { closeAssigneeMenu(); return; } // focus is leaving — let it
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveAssigneeActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (assigneeActiveId != null) pickAssignee(assigneeActiveId);
    }
  }

  function moveAssigneeActive(delta) {
    const rows = assigneeRows();
    if (!rows.length) return;
    const from = rows.findIndex((u) => u.id === assigneeActiveId);
    const to = from === -1 ? 0 : Math.min(Math.max(from + delta, 0), rows.length - 1);
    assigneeActiveId = rows[to].id;
    const list = $('assignee-list');
    if (list) for (const li of list.children) li.classList.toggle('active', li.dataset.userId === assigneeActiveId);
    syncAssigneeActiveOption();
  }

  function onAssigneeFilterInput() {
    const input = $('assignee-filter');
    assigneeFilter = input ? input.value : '';
    assigneeActiveId = null; // the first match becomes the cursor
    renderAssigneeOptions();
  }

  function onAssigneeTriggerClick(e) {
    e.stopPropagation(); // the doc-level close listener would swallow the toggle
    if ($('assignee-menu').hidden) openAssigneeMenu(); else closeAssigneeMenu({ focus: true });
  }

  function onAssigneeTriggerKey(e) {
    if (!$('assignee-menu').hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAssigneeMenu();
    }
  }

  function pickAssignee(value) {
    closeAssigneeMenu({ focus: true });
    onAssigneeChange(value);
  }

  // Wired once from app init — the markup is static.
  function initAssigneeDropdown() {
    $('assignee-trigger').addEventListener('click', onAssigneeTriggerClick);
    $('assignee-trigger').addEventListener('keydown', onAssigneeTriggerKey);
    $('assignee-filter').addEventListener('input', onAssigneeFilterInput);
  }

  // ---- assignee gate (#153) ----
  // Web parity (`AssignTo @disabled={{...hasStatus}}`). The server accepts the write
  // regardless — no check on its side — so the panel IS the gate.
  const ASSIGN_GATE_REASON = "Can't re-assign already marked test";

  function assigneeGateReason(record) {
    if (!record) return '';
    return displayStatus(record) === 'untested' ? '' : ASSIGN_GATE_REASON;
  }

  // A hover-only tooltip is invisible on touch, so the reason is shown inline too.
  function applyAssigneeGate(record) {
    const trigger = $('assignee-trigger');
    if (!trigger) return '';
    const reason = assigneeGateReason(record);
    trigger.disabled = !!reason;
    if (reason) closeAssigneeMenu();
    Tooltip.set(trigger, reason);
    const note = $('assignee-reason');
    if (note) { note.textContent = reason; note.hidden = !reason; }
    return reason;
  }

  // v2 echoes the assignee as an EMAIL — map it back to the member id.
  function assignedUserId(record) {
    const email = record?.assigned_to;
    if (!email) return '';
    const u = (usersList || []).find((x) => x.email && x.email.toLowerCase() === String(email).toLowerCase());
    return u ? String(u.id) : '';
  }

  function flashAssignee() {
    const trigger = $('assignee-trigger');
    if (!trigger) return;
    trigger.classList.remove('saved-flash');
    void trigger.offsetWidth; // reflow → restart the animation
    trigger.classList.add('saved-flash');
    setTimeout(() => trigger.classList.remove('saved-flash'), 1000);
  }

  // Optimistic, serialized like substatus. The optimistic value is the member's
  // EMAIL — the shape the v2 read echoes — so the immediate refetch finds no diff.
  let assignWriting = false;
  async function onAssigneeChange(value) {
    const record = recordFor(state.currentRecordId);
    if (!record?.id) return;
    if (assignWriting) { paintAssigneeTrigger(record); return; } // ignore + re-sync
    // #153: the trigger is already disabled — this only catches the status-landed race.
    if (assigneeGateReason(record)) { paintAssigneeTrigger(record); applyAssigneeGate(record); return; }
    const prevId = assignedUserId(record);
    if (value === prevId) return;
    const user = value ? (usersList || []).find((u) => String(u.id) === value) : null;
    const prevEmail = record.assigned_to || null;
    assignWriting = true;
    $('assignee-trigger').disabled = true;
    syncBeginWrite();
    record.assigned_to = user ? user.email : null; // optimistic (v2 read = email)
    paintAssigneeTrigger(record);
    try {
      await TestomatAPI.assignTestrun(record.id, value || null);
      flashAssignee();
    } catch (e) {
      record.assigned_to = prevEmail;
      paintAssigneeTrigger(record);
      if (isAuthError(e)) setAuthExpiredLine('test-status');
      else toast(`Assignee not saved: ${e.message}`, { error: true });
    } finally {
      assignWriting = false;
      // Not a bare `disabled = false`: a status may have landed and the #153 gate must hold.
      applyAssigneeGate(record);
      syncEndWrite();
    }
  }

  // Optimistic + serialized. The Dropdown has ALREADY moved its closed face to the
  // new value, so every path that refuses the change must put the face back.
  let substatusWriting = false;
  async function onSubstatusChange(value) {
    const dd = Dropdown.of('substatus-select');
    const record = recordFor(state.currentRecordId);
    if (!record?.id) return;
    const resync = () => dd.setValue(record.substatus || '');
    if (substatusWriting) { resync(); return; }                    // ignore + re-sync
    if (RunLock.recordWriteLock(record)) { resync(); return; }     // #152/#154 — locked, re-sync
    const prev = record.substatus || '';
    substatusWriting = true;
    syncBeginWrite();
    record.substatus = value; // optimistic
    renderSubstatusMark(record);
    try {
      if (value) await TestomatAPI.setSubstatus(record.id, value);
      else await TestomatAPI.clearSubstatus(record.id);
    } catch (e) {
      record.substatus = prev;
      dd.setValue(prev);
      renderSubstatusMark(record);
      if (isAuthError(e)) setAuthExpiredLine('test-status');
      else toast(`Custom status not saved: ${e.message}`, { error: true });
    } finally {
      substatusWriting = false;
      syncEndWrite();
    }
  }

  // The panel reaches the nine the ticket names; the rest are published because
  // tests/test-meta.test.mjs drives the listbox one keystroke at a time.
  return {
    initSubstatus: initSubstatusDropdown,
    renderSubstatus,
    renderSubstatusMark,
    initAssignee: initAssigneeDropdown,
    renderAssignee,
    applyAssigneeGate,
    assignedUserId,
    onAssigneeChange,
    onSubstatusChange,
    assigneeRows,
    assigneeGateReason,
    openAssigneeMenu,
    moveAssigneeActive,
    onAssigneeMenuKey,
    onAssigneeTriggerKey,
    onAssigneeFilterInput,
    // A getter, not the value: the cursor moves, and a copy taken at load would never follow it.
    get assigneeActiveId() { return assigneeActiveId; },
  };
})();
