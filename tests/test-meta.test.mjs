#!/usr/bin/env node
// The test's WORKFLOW METADATA (extension/sidepanel/screens/test-meta.js): the custom status the
// project replies with, and the person the result is assigned to. Neither is the verdict — each is
// its own request, its own optimistic paint and its own gate — so these rows were the substatus and
// assignee half of tests/test-view-write.test.mjs until the pair became their own file; the status
// write, the step writes, the attach gates and the pager stayed there.
// Two things are easy to get quietly wrong. Both writers paint BEFORE the server answers, so every
// refusal has to put the face back — and the face is not the record: the Dropdown has already moved
// its closed label, and the trigger already shows the new monogram. And the assignee listbox is
// hand-built rather than an OS menu, so its cursor, its clamp and its Escape/Tab split are the
// panel's own code and not the platform's.
// Rows are the ticket's 63-75, 147-158. A lettered suffix is the companion case that drives the same
// path the other way, so a row asserting "nothing happened" cannot pass against a fixture where
// nothing could have happened anyway.
// Run: node --test tests/test-meta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeClock, makeDocument, el, event, plain, settle } from './helpers/panel-harness.mjs';

const ASSIGN_GATE = "Can't re-assign already marked test";
const NONE = '— none —';

// A promise this file resolves by hand: row 65 is about what a SECOND change does while the first
// one's request is still on the wire.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const rec = (id, over = {}) => ({ id, test_id: id * 100, test_title: `Test ${id}`, status: 'pending', ...over });

// index.html's shape (:645-679), cut to the nodes these two controls touch. `true` = hidden in
// markup. There is no `test-status` here and no write-state attribute: the metadata writers speak on
// the shared line through setAuthExpiredLine and otherwise toast.
const NODES = [
  ['div', 'test-substatus', true], ['span', 'test-substatus-mark', true],
  ['div', 'test-assignee', true], ['p', 'assignee-reason', true],
];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// The panel globals test-meta.js reads, all of them real enough to be driven. There is no `chrome`
// in this list, no OfflineQueue and no WriteCore: this pair stores nothing, queues nothing and never
// goes through the verdict's write core.
function load(opts = {}) {
  const o = {
    recordId: 7,
    records: null,        // default: one untested record, id 7
    jwt: true,            // capabilities.jwt
    lock: '',             // recordWriteLock()'s answer
    users: [],            // usersList
    replies: {},          // runRepliesFor(status)
    dropdown: true,       // a panel where TestMeta.initSubstatus already ran
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    node[key(id)] = n;
    doc.body.append(n);
  }
  // The assignee listbox is a real subtree: onAssigneeDocClick asks the wrapper whether the click
  // landed inside it, so a flat fixture would answer "outside" for every option.
  const dd = el('div', { id: 'assignee-dd' });
  const trigger = el('button', { id: 'assignee-trigger' });
  const value = el('span', { id: 'assignee-value' });
  const menu = el('div', { id: 'assignee-menu' });
  menu.hidden = true;
  const filter = el('input', { id: 'assignee-filter', value: '' });
  const list = el('ul', { id: 'assignee-list' });
  const empty = el('div', { id: 'assignee-empty' });
  empty.hidden = true;
  trigger.append(value);
  menu.append(filter, list, empty);
  dd.append(trigger, menu);
  node.testAssignee.append(dd, node.assigneeReason);
  Object.assign(node, { assigneeDd: dd, assigneeTrigger: trigger, assigneeValue: value,
    assigneeMenu: menu, assigneeFilter: filter, assigneeList: list, assigneeEmpty: empty });

  // scrollIntoView is the one member mini-dom does not have that this module calls, and the cursor
  // rows go through it on every move.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = () => {};
    return made;
  };
  for (const n of Object.values(node)) n.scrollIntoView = () => {};

  const calls = {
    toasts: [],
    authLines: [],
    beginWrites: 0,
    endWrites: 0,
    substatus: [],      // { op, id, value }
    assign: [],         // { id, value }
    ddOptions: [],      // { options, value }
    ddValues: [],
  };

  // Reassignable after load(), so a row can answer the second call differently from the first or
  // change the world from inside a call the module is awaiting.
  const on = {
    setSubstatus: async () => ({}),
    clearSubstatus: async () => ({}),
    assignTestrun: async () => ({}),
  };

  const state = {
    currentRecordId: o.recordId,
    records: o.records || [rec(7)],
  };

  // The substatus control the module reaches for by id — the Dropdown's public face, not its DOM.
  const control = {
    trigger: el('button', { id: 'substatus-select' }),
    disabled: false,
    value: '',
    options: [],
    setOptions: (next, sOpts = {}) => {
      control.options = plain(next);
      calls.ddOptions.push({ options: plain(next), value: sOpts.value });
      if ('value' in sOpts) control.value = sOpts.value;
    },
    setValue: (v) => { control.value = v; calls.ddValues.push(v); },
  };

  const globals = {
    state,
    capabilities: { jwt: o.jwt, readonly: false },
    usersList: o.users,
    $: (id) => doc.getElementById(id),
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); },
    isAuthError: (e) => e?.kind === 'auth',
    setAuthExpiredLine: (id) => { calls.authLines.push(id); },
    // core/state.js:79's own, stringified on both sides.
    recordFor: (id) => state.records.find((r) => String(r.id) === String(id)),
    // run-view.js:253 — one reason for every row here; the per-record scoping is that screen's.
    recordWriteLock: () => o.lock,
    displayStatus: (r) => (r?.status && r.status !== 'pending' ? r.status : 'untested'),
    runRepliesFor: (status) => o.replies[status] || [],
    syncBeginWrite: () => { calls.beginWrites += 1; },
    syncEndWrite: () => { calls.endWrites += 1; },
    Icons: {
      el: (name, size = 16, ...cls) => {
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        n.classList.add(...cls.filter(Boolean));
        return n;
      },
    },
    // The real one writes data-tip on the node it is given (shared/tooltip.js:257,267); a recorder
    // alone could not tell a tip that landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
      get: (n) => (n && n.dataset ? (n.dataset.tip || '') : ''),
    },
    UserCell: {
      cell: (user) => {
        const box = el('span', { className: 'user-cell', dataset: { email: user?.email || '' } });
        box.textContent = user?.name || user?.email || '';
        return box;
      },
    },
    Dropdown: {
      of: (id) => (id === 'substatus-select' && o.dropdown ? control : null),
      create: () => ({ el: el('div') }),
    },
    TestomatAPI: {
      setSubstatus: async (id, v) => { calls.substatus.push({ op: 'set', id, value: v }); return on.setSubstatus(id, v); },
      clearSubstatus: async (id) => { calls.substatus.push({ op: 'clear', id, value: null }); return on.clearSubstatus(id); },
      assignTestrun: async (id, v) => { calls.assign.push({ id, value: v }); return on.assignTestrun(id, v); },
    },
  };

  const clock = fakeClock();
  const h = loadScreen('test-meta', { globals, document: doc, clock, exported: 'TestMeta' });

  return {
    ...h,
    mod: h.screen,
    state, calls, on, node, doc, clock,
    // What the tester sees under the cursor in the listbox.
    activeOption: () => node.assigneeList.querySelector('.active')?.id ?? null,
    optionIds: () => node.assigneeList.children.map((li) => li.dataset.userId),
  };
}

// ---------- the read-only custom-status mark ----------
// Not in #164's table and driven by nothing until now: the extraction published it, and a mutation
// that dropped its JWT gate left the whole suite green.

test('the mark carries the row\'s own status as its tint, plus the value and a tooltip', () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.mod.renderSubstatusMark(h.state.records[0]);
  const el = h.node.testSubstatusMark;
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'Blocked');
  assert.equal(el.className, 'badge custom-status failed'); // the STATUS tints it, not the value
  assert.equal(el.dataset.tip, 'Custom status: Blocked');
});

test('a degraded session hides it — the mark is JWT-gated like the select that writes it', () => {
  const h = load({ jwt: false, records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.mod.renderSubstatusMark(h.state.records[0]);
  assert.equal(h.node.testSubstatusMark.hidden, true);
  assert.equal(h.node.testSubstatusMark.textContent, '');
  assert.equal(h.node.testSubstatusMark.className, 'badge custom-status');
});

test('a value of nothing but spaces is no value at all', () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: '   ' })] });
  h.mod.renderSubstatusMark(h.state.records[0]);
  assert.equal(h.node.testSubstatusMark.hidden, true);
  // …and a row that never had one is the same, without throwing on the missing key.
  h.mod.renderSubstatusMark(rec(8));
  assert.equal(h.node.testSubstatusMark.hidden, true);
});

// ---------- assignee and substatus writes (rows 63-75, 157-158) ----------

test('63: a custom status is written and shown before the server answers', async () => {
  const h = load({ records: [rec(7, { status: 'failed' })], replies: { failed: ['Needs investigation'] } });
  const done = h.mod.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Needs investigation'); // optimistic
  assert.equal(h.node.testSubstatusMark.textContent, 'Needs investigation');
  await done;
  assert.deepEqual(h.calls.substatus, [{ op: 'set', id: 7, value: 'Needs investigation' }]);
  assert.equal(h.calls.beginWrites, 1);
  assert.equal(h.calls.endWrites, 1);
});

test('64: the empty row is how a custom status comes back OFF', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Needs investigation' })] });
  await h.mod.onSubstatusChange('');
  assert.deepEqual(h.calls.substatus, [{ op: 'clear', id: 7, value: null }]);
  assert.equal(h.state.records[0].substatus, '');
});

test('65: a second change while the first is in flight is ignored, and the face re-synced', async () => {
  const h = load({ records: [rec(7, { status: 'failed' })] });
  const held = deferred();
  h.on.setSubstatus = async () => held.promise;
  const first = h.mod.onSubstatusChange('Needs investigation');
  await settle();
  const second = h.mod.onSubstatusChange('Blocked');
  await settle();
  assert.deepEqual(h.calls.substatus.map((c) => c.value), ['Needs investigation']);
  assert.deepEqual(h.calls.ddValues, ['Needs investigation']); // put back to what the record holds
  held.resolve({});
  await Promise.all([first, second]);
});

test('66: a locked result refuses the change and re-syncs the face', async () => {
  const h = load({ lock: 'Run is finished — results are read-only', records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  await h.mod.onSubstatusChange('Needs investigation');
  assert.deepEqual(h.calls.substatus, []);
  assert.deepEqual(h.calls.ddValues, ['Blocked']);
  assert.equal(h.state.records[0].substatus, 'Blocked');
});

test('67: an expired token rolls the custom status back and speaks on the LINE, not a toast', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.on.setSubstatus = async () => { throw new h.ApiError('auth', 401, 'token rejected'); };
  await h.mod.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Blocked');
  assert.deepEqual(h.calls.ddValues, ['Blocked']);
  assert.deepEqual(h.calls.authLines, ['test-status']);
  assert.deepEqual(h.calls.toasts, []);
});

test('67b: …every other failure is a toast, and no auth line', async () => {
  const h = load({ records: [rec(7, { status: 'failed', substatus: 'Blocked' })] });
  h.on.setSubstatus = async () => { throw new h.ApiError('http', 500, 'server said no'); };
  await h.mod.onSubstatusChange('Needs investigation');
  assert.equal(h.state.records[0].substatus, 'Blocked');
  assert.deepEqual(h.calls.authLines, []);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Custom status not saved: server said no', error: true }]);
});

test('68: assigning writes the member id and shows the member\'s EMAIL straight away', async () => {
  const h = load({ users: [{ id: '12', name: 'Ann', email: 'A@x.io' }] });
  const done = h.mod.onAssigneeChange('12');
  assert.equal(h.state.records[0].assigned_to, 'A@x.io'); // the shape the v2 read echoes back
  assert.equal(h.node.assigneeTrigger.disabled, true);
  await done;
  assert.deepEqual(h.calls.assign, [{ id: 7, value: '12' }]);
  assert.equal(h.node.assigneeTrigger.dataset.userId, '12');
  assert.equal(h.node.assigneeTrigger.disabled, false);
  assert.equal(h.node.assigneeTrigger.classList.contains('saved-flash'), true);
  await h.clock.tick();
  assert.equal(h.node.assigneeTrigger.classList.contains('saved-flash'), false);
});

test('68b: a rejected assign puts the previous member back and toasts', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }, { id: '9', name: 'Bo', email: 'b@x.io' }],
    records: [rec(7, { assigned_to: 'b@x.io' })],
  });
  h.on.assignTestrun = async () => { throw new h.ApiError('http', 500, 'nope'); };
  await h.mod.onAssigneeChange('12');
  assert.equal(h.state.records[0].assigned_to, 'b@x.io');
  assert.equal(h.node.assigneeTrigger.dataset.userId, '9');
  assert.deepEqual(h.calls.toasts, [{ msg: 'Assignee not saved: nope', error: true }]);
  assert.deepEqual(h.calls.authLines, []); // …and no auth line: the token was fine, the write was not
});

// The substatus writer's twin is 67/67b. This one had only the toast half, so collapsing the split
// to an unconditional toast left the suite green — an expired token would shout instead of telling
// the tester where to sign in, the way every other write path does.
test('68c: an expired token speaks on the LINE, not a toast — the same split the substatus makes', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }, { id: '9', name: 'Bo', email: 'b@x.io' }],
    records: [rec(7, { assigned_to: 'b@x.io' })],
  });
  h.on.assignTestrun = async () => { throw new h.ApiError('auth', 401, 'token rejected'); };
  await h.mod.onAssigneeChange('12');
  assert.equal(h.state.records[0].assigned_to, 'b@x.io'); // rolled back either way
  assert.deepEqual(h.calls.authLines, ['test-status']);
  assert.deepEqual(h.calls.toasts, []);
});

test('69: the empty value UNASSIGNS — a null id and a null email', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }],
    records: [rec(7, { assigned_to: 'A@x.io' })],
  });
  await h.mod.onAssigneeChange('');
  assert.deepEqual(h.calls.assign, [{ id: 7, value: null }]);
  assert.equal(h.state.records[0].assigned_to, null);
});

test('70: picking the member who already holds it writes nothing', async () => {
  const h = load({
    users: [{ id: '12', name: 'Ann', email: 'A@x.io' }],
    records: [rec(7, { assigned_to: 'a@X.io' })], // the same address, cased the other way
  });
  await h.mod.onAssigneeChange('12');
  assert.deepEqual(h.calls.assign, []);
});

test('71: a row that already has a verdict is no longer re-assignable', async () => {
  const h = load({ users: [{ id: '12', name: 'Ann', email: 'A@x.io' }], records: [rec(7, { status: 'failed' })] });
  await h.mod.onAssigneeChange('12');
  assert.deepEqual(h.calls.assign, []);
  assert.equal(h.node.assigneeTrigger.disabled, true);
  assert.equal(h.node.assigneeReason.textContent, ASSIGN_GATE);
  assert.equal(h.node.assigneeReason.hidden, false);
  assert.equal(h.node.assigneeTrigger.dataset.tip, ASSIGN_GATE);
});

test('72: the echoed email maps back to a member id, case-insensitively', () => {
  const h = load({ users: [{ id: '9', name: 'Ann', email: 'A@x.io' }] });
  assert.equal(h.mod.assignedUserId({ assigned_to: 'a@X.io' }), '9');
});

test('73: an unassigned row, an unknown address and no member list all answer ""', () => {
  const h = load({ users: [{ id: '9', email: 'A@x.io' }] });
  assert.equal(h.mod.assignedUserId({}), '');
  assert.equal(h.mod.assignedUserId({ assigned_to: 'stranger@x.io' }), '');
  h.fn.usersList = null;
  assert.equal(h.mod.assignedUserId({ assigned_to: 'A@x.io' }), '');
});

test('74: a marked row states the reason it cannot be re-assigned', () => {
  const h = load();
  assert.equal(h.mod.applyAssigneeGate({ status: 'failed' }), ASSIGN_GATE);
  assert.equal(h.mod.assigneeGateReason({ status: 'failed' }), ASSIGN_GATE);
  assert.equal(h.mod.assigneeGateReason({ status: 'passed' }), ASSIGN_GATE);
});

test('75: pending folds to untested, and no record at all is not a gate', () => {
  const h = load();
  assert.equal(h.mod.assigneeGateReason({ status: 'pending' }), '');
  assert.equal(h.mod.assigneeGateReason({}), '');
  assert.equal(h.mod.assigneeGateReason(null), '');
});

test('157: the reply group is offered with the empty row first, and the record\'s own value picked', () => {
  const h = load({
    records: [rec(7, { status: 'failed', substatus: 'Blocked' })],
    replies: { failed: ['Blocked', 'Needs investigation'] },
  });
  h.mod.renderSubstatus(h.state.records[0]);
  assert.equal(h.node.testSubstatus.hidden, false);
  assert.deepEqual(h.calls.ddOptions, [{
    options: [{ value: '', label: NONE }, { value: 'Blocked', label: 'Blocked' },
      { value: 'Needs investigation', label: 'Needs investigation' }],
    value: 'Blocked',
  }]);
});

test('157b: a value the project no longer replies with falls back to the empty row', () => {
  const h = load({
    records: [rec(7, { status: 'failed', substatus: 'Retired' })],
    replies: { failed: ['Blocked'] },
  });
  h.mod.renderSubstatus(h.state.records[0]);
  assert.equal(h.calls.ddOptions[0].value, '');
});

test('158: no reply group, no JWT and a pending row each hide the control and clear it', () => {
  for (const [why, opts] of [
    ['no reply group', { records: [rec(7, { status: 'failed' })], replies: {} }],
    ['no jwt', { jwt: false, records: [rec(7, { status: 'failed' })], replies: { failed: ['Blocked'] } }],
    ['pending', { records: [rec(7)], replies: { pending: ['Blocked'] } }],
    ['no result id', { records: [rec(7, { status: 'failed' })], replies: { failed: ['Blocked'] } }],
  ]) {
    const h = load(opts);
    const record = why === 'no result id' ? { ...h.state.records[0], id: null } : h.state.records[0];
    h.mod.renderSubstatus(record);
    assert.equal(h.node.testSubstatus.hidden, true, why);
    assert.deepEqual(h.calls.ddOptions, [{ options: [], value: undefined }], why);
  }
});

// ---------- the assignee listbox keyboard (rows 147-156) ----------

// Member ids are STRINGS everywhere below because the read builds them that way (api.js:481) and
// the cursor compares them with `===` — a number would never match the row it is sitting on.
test('147: the list always opens with Unassigned above the members', () => {
  const h = load({ users: [{ id: '1', name: 'Ann' }] });
  assert.deepEqual(plain(h.mod.assigneeRows()), [
    { id: '', name: 'Unassigned', email: '' }, { id: '1', name: 'Ann' },
  ]);
});

test('148: the filter matches a name or an address, and Unassigned is filterable too', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'brian@x.io' }] });
  h.mod.openAssigneeMenu();
  h.node.assigneeFilter.value = 'AN';
  h.mod.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['1', '2']); // Ann by name, Brian by address
  h.node.assigneeFilter.value = 'una';
  h.mod.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['']);
});

test('149: a filter that matches nobody empties the list and shows the empty state', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.mod.openAssigneeMenu();
  assert.equal(h.node.assigneeEmpty.hidden, true);
  h.node.assigneeFilter.value = 'zz';
  h.mod.onAssigneeFilterInput();
  assert.deepEqual(plain(h.mod.assigneeRows()), []);
  assert.deepEqual(h.optionIds(), []);
  assert.equal(h.node.assigneeEmpty.hidden, false);
});

test('150: the cursor clamps at the last row instead of wrapping', () => {
  const h = load({
    users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'b@x.io' }],
    records: [rec(7, { assigned_to: 'b@x.io' })],
  });
  h.mod.openAssigneeMenu();
  assert.equal(h.activeOption(), 'assignee-opt-2');
  h.mod.moveAssigneeActive(1);
  assert.equal(h.activeOption(), 'assignee-opt-2');
  assert.equal(h.node.assigneeFilter.getAttribute('aria-activedescendant'), 'assignee-opt-2');
  // …and one step the other way does move, so the clamp is a clamp and not a dead control.
  h.mod.moveAssigneeActive(-1);
  assert.equal(h.activeOption(), 'assignee-opt-1');
});

test('151: with no cursor yet, either direction lands on the first row', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  assert.equal(h.mod.assigneeActiveId, null);
  h.mod.moveAssigneeActive(-1);
  assert.equal(h.mod.assigneeActiveId, '');
});

test('152: Escape closes the menu and hands focus back to the trigger', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.mod.openAssigneeMenu();
  const ev = event(h.doc, 'keydown', { key: 'Escape' });
  h.mod.onAssigneeMenuKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(h.doc.activeElement, h.node.assigneeTrigger);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  // …and the document-level listeners the open registered are gone with it.
  assert.equal(h.doc.listeners.get('keydown').length, 0);
  assert.equal(h.doc.listeners.get('click').length, 0);
});

test('153: Tab closes the menu but is NOT swallowed — focus is leaving on purpose', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  h.mod.openAssigneeMenu();
  const ev = event(h.doc, 'keydown', { key: 'Tab' });
  h.mod.onAssigneeMenuKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(ev.propagationStopped, false);
});

test('154: Enter on the cursor row assigns that member', async () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }, { id: '2', name: 'Bo', email: 'b@x.io' }] });
  h.mod.openAssigneeMenu();
  h.mod.moveAssigneeActive(1); // off Unassigned, onto Ann
  const ev = event(h.doc, 'keydown', { key: 'Enter' });
  h.mod.onAssigneeMenuKey(ev);
  await settle();
  assert.deepEqual(h.calls.assign, [{ id: 7, value: '1' }]);
  assert.equal(h.node.assigneeMenu.hidden, true);
  assert.equal(ev.defaultPrevented, true);
});

test('155: Space opens the closed trigger and keeps the page from scrolling', () => {
  const h = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  const ev = event(h.node.assigneeTrigger, 'keydown', { key: ' ' });
  h.mod.onAssigneeTriggerKey(ev);
  assert.equal(h.node.assigneeMenu.hidden, false);
  assert.equal(ev.defaultPrevented, true);
  // …a key with no meaning here leaves both alone.
  const h2 = load({ users: [{ id: '1', name: 'Ann', email: 'a@x.io' }] });
  const other = event(h2.node.assigneeTrigger, 'keydown', { key: 'x' });
  h2.mod.onAssigneeTriggerKey(other);
  assert.equal(h2.node.assigneeMenu.hidden, true);
  assert.equal(other.defaultPrevented, false);
});

test('156: typing in the filter moves the cursor to the first match', () => {
  const h = load({
    users: [{ id: '1', name: 'Zoe', email: 'zoe@x.io' }, { id: '2', name: 'Zack', email: 'zack@x.io' }],
    records: [rec(7, { assigned_to: 'zack@x.io' })],
  });
  h.mod.openAssigneeMenu();
  assert.equal(h.activeOption(), 'assignee-opt-2'); // the member the row already holds
  h.node.assigneeFilter.value = 'z'; // both still match, so only the reset can move the cursor
  h.mod.onAssigneeFilterInput();
  assert.deepEqual(h.optionIds(), ['1', '2']);
  assert.equal(h.activeOption(), 'assignee-opt-1');
});
