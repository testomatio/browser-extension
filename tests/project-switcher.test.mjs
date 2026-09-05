#!/usr/bin/env node
// The project the panel is pointed at — extension/sidepanel/core/project-switcher.js — and the
// whole-screen version of the same list, extension/sidepanel/screens/project-pick.js, which shares
// this file's row builder and its filter (#183, part of the test epic).
// Three things are easy to get quietly wrong here.
// The ROW MODEL: the saved project is a row even before (or without) a list, and it goes in FRONT of
// the token's own list — a tester who cannot see the project they are on cannot switch off it.
// The LISTBOX: this control is NOT the shared Roving helper (extension/shared/roving.js). Focus never
// leaves the filter box, so the cursor is a `.active` class plus aria-activedescendant, and every key
// is caught at DOCUMENT level in the CAPTURE phase so the panel's own arrow/Enter handlers never see
// it. Nothing else in the panel is wired that way, so none of it is covered by tests/roving.test.mjs.
// The SWITCH ORDERING: a switch that writes the new project before it has finished draining and
// tearing down the old one lands the tester's next result on the wrong project. The rows below assert
// the SEQUENCE — what the world looked like at each step — not merely the storage it ends with.
// Run: node --test tests/project-switcher.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, SCREENS_SRC, makeDocument, el, event, fire, plain, settle }
  from './helpers/panel-harness.mjs';

// index.html's own two projects, near enough: a title that differs from the slug, and one that does not.
const CHECKOUT = { id: 'p1', title: 'Checkout', testsCount: 12 };
const BILLING = { id: 'p2', title: 'Billing', testsCount: 4 };
const PLAIN = { id: 'p3', title: 'p3' };

const SETTINGS = { baseUrl: 'https://a.io', projectId: 'p1', apiToken: 'TOKEN' };

// A promise this file resolves by hand: the ordering rows are about what has NOT happened yet while
// one step of the switch is still on the wire.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// index.html's shell (:26-71 for the header popup, :399-430 for the choose-a-project screen), cut to
// the nodes these two files touch. `#project-menu` is a SIBLING of `#project-dropdown` inside the bar,
// not a child of the trigger — which is the whole reason onProjectDocClick has to ask both.
function makePage() {
  const doc = makeDocument([]);
  const node = {};
  const mk = (tag, id, props = {}) => { node[key(id)] = el(tag, { id, ...props }); return node[key(id)]; };

  const bar = mk('div', 'project-bar', { hidden: true });
  const dd = mk('div', 'project-dropdown');
  const trigger = mk('button', 'project-trigger');
  trigger.setAttribute('aria-expanded', 'false'); // index.html:30 — the closed state is in the markup
  trigger.append(mk('span', 'project-current'));
  dd.append(trigger);
  const menu = mk('div', 'project-menu', { hidden: true });
  menu.append(mk('input', 'project-filter', { value: '' }), mk('ul', 'project-list'),
    mk('div', 'project-empty', { hidden: true }));
  bar.append(mk('span', 'project-bar-label'), dd, mk('a', 'project-open', { hidden: true }), menu);

  const pick = mk('section', 'view-pick', { hidden: true });
  pick.append(mk('input', 'pick-filter', { value: '' }), mk('button', 'pick-filter-clear', { hidden: true }),
    mk('ul', 'pick-list'), mk('div', 'pick-empty', { hidden: true }), mk('p', 'pick-status'),
    mk('span', 'pick-host'), mk('button', 'pick-disconnect'));

  doc.body.append(bar, pick);
  return { doc, node };
}

// core/state.js:97, verbatim — the switch writes per-host settings, so a bad address has to fall out
// of the host lookup the same way it does in the panel.
const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } };

function load(opts = {}) {
  const o = {
    settings: SETTINGS,
    projects: [CHECKOUT, BILLING],
    hostSettings: {},
    activeTab: 'runs',
    hasChrome: true,
    offer: null,      // Handoff.offer() — a live host connection, or none
    queue: null,      // null = no OfflineQueue global AT ALL, which is what the typeof guard is for
    ...opts,
  };
  const { doc, node } = makePage();

  // mini-dom has no layout, and the cursor scrolls the row it lands on — through syncProjectActiveOption,
  // which reaches a row this file built rather than one the fixture owns.
  const create = doc.createElement.bind(doc);
  const scrolls = [];
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = (arg) => { scrolls.push({ id: made.id, arg: plain(arg) }); };
    return made;
  };
  for (const n of Object.values(node)) n.scrollIntoView = () => {};

  const calls = {
    order: [],        // ONE ordered trace — the switch rows are about sequence, not totals
    scrolls,
    toasts: [],
    shows: [],
    lines: [],        // { id, text }
    tips: [],         // { id, tip } — Tooltip.set
    configured: [],   // Handoff.configure(settings)
    resets: [],       // what the world looked like AT teardown
    repaints: [],     // what the world looked like AT the bar repaint
    listProjects: 0,
    prefetches: 0,
  };

  // Reassignable after load(), so a row can hold one step of the switch open and look at the world
  // while it is still there.
  const on = {
    listProjects: async () => o.projects,
    replay: async () => {},
    prefetchTabCounts: async () => {},
    openRunsView: async () => {},
    openTcStudioView: async () => {},
  };

  const state = {
    settings: o.settings,
    projects: o.projects,
    hostSettings: o.hostSettings,
    activeTab: o.activeTab,
  };

  const step = (name, fn) => (...args) => { calls.order.push(name); return fn ? fn(...args) : undefined; };

  const globals = {
    state,
    hasChrome: o.hasChrome,
    hostOf,
    $: (id) => doc.getElementById(id),
    show: step('show', (view) => { calls.shows.push(view); }),
    toast: step('toast', (msg) => { calls.toasts.push(msg); }),
    setStatusLine: step('setStatusLine', (id, text) => { calls.lines.push({ id, text }); }),
    openRunsView: step('openRunsView', () => on.openRunsView()),
    openTcStudioView: step('openTcStudioView', () => on.openTcStudioView()),
    fillSettingsForm: step('fillSettingsForm'),
    // No openProjectPickView stub: screens/project-pick.js declares the real one, and its function
    // declaration lands on this same sandbox — which is the seam askForProject() runs on in the panel.
    disconnectInstance: step('disconnectInstance', (arg) => { calls.lines.push({ disconnect: plain(arg) }); }),
    // The teardown's own snapshot: what a queued result flushing right here would be stamped with,
    // and whether anything had already been written down.
    resetProjectScopedState: step('resetProjectScopedState', () => {
      calls.resets.push({
        projectId: state.settings && state.settings.projectId,
        writes: store.ops('local', 'set').length,
        removes: store.ops('local', 'remove').length,
      });
    }),
    prefetchTabCounts: step('prefetchTabCounts', () => { calls.prefetches += 1; return on.prefetchTabCounts(); }),
    Handoff: {
      offer: () => o.offer,
      configure: step('Handoff.configure', (s) => { calls.configured.push(plain(s)); }),
      // shared/handoff.js:39, verbatim — a token of the account's own, or a host that handed one over.
      credentialed: (s) => !!(s && s.baseUrl && (s.apiToken || s.handoff)),
    },
    // shared/tooltip.js writes onto the node it is handed; a bare recorder could not tell a tip that
    // landed on the right element from one that went nowhere.
    Tooltip: {
      set: (n, tip) => { if (n && n.dataset) { calls.tips.push({ id: n.id || n.className, tip }); n.dataset.tip = String(tip); } },
    },
    TestomatAPI: {
      listProjects: step('listProjects', () => { calls.listProjects += 1; return on.listProjects(); }),
    },
  };
  // Deliberately absent unless a row asks for it: switchProject's drain sits behind `typeof
  // OfflineQueue !== 'undefined'`, and `undefined` would not reproduce a context that genuinely lacks it.
  if (o.queue !== null) {
    globals.OfflineQueue = {
      count: step('OfflineQueue.count', () => o.queue),
      replay: step('OfflineQueue.replay', () => on.replay()),
    };
  }

  // index.html's order: core/project-switcher.js (:897) before screens/project-pick.js (:903), one
  // context, so the screen's `matchProjects` and `projectRowEl` are the real ones.
  const h = loadScreen('project-pick', {
    dir: SCREENS_SRC,
    before: [['project-switcher', CORE_SRC]],
    document: doc,
    globals,
    // Both files' module state is LEXICAL — never a sandbox property — so the completion value is
    // how it crosses back. Every row that can is still driven through behaviour instead.
    exported: `({
      projectLabel,
      pickRows,
      peek: () => ({ projectFilter, projectActiveId, pickFilter, pickActiveId }),
    })`,
  });
  const { store } = h;

  // The panel's own functions, traced in place: a call from inside switchProject is a global lookup,
  // so a wrapper on the sandbox is what switchProject actually reaches.
  for (const name of ['renderProjectBar', 'renderProjectOptions', 'persistActiveSettings',
    'closeProjectMenu', 'pickProject', 'switchProject', 'refreshProjects']) {
    const orig = h.sandbox[name];
    h.sandbox[name] = (...args) => {
      calls.order.push(name);
      if (name === 'renderProjectBar') {
        calls.repaints.push({ writes: store.ops('local', 'set').length, removes: store.ops('local', 'remove').length });
      }
      return orig(...args);
    };
  }
  // Focus is a step of its own in two rows: it must come back to the trigger on Escape and never on
  // Tab, and the pick screen must not focus a field the view switch has not unhidden yet.
  for (const id of ['project-filter', 'project-trigger', 'pick-filter']) {
    const n = node[key(id)];
    const f = n.focus.bind(n);
    n.focus = () => { calls.order.push(`focus:${id}`); f(); };
  }

  return {
    ...h,
    mod: h.screen,
    state, calls, on, node, doc, store, o,
    peek: () => h.screen.peek(),
    // Replace one module function with a recorder — the only way to ask "which callback did the row
    // get?" without letting the real one repaint the panel underneath the assertion.
    stub: (name, impl = () => undefined) => {
      const got = [];
      h.sandbox[name] = (...args) => { got.push(plain(args)); calls.order.push(name); return impl(...args); };
      return got;
    },
    // What the tester sees in the popup and on the screen.
    optionIds: () => node.projectList.children.map((li) => li.dataset.projectId),
    activeId: () => node.projectList.children.find((li) => li.classList.contains('active'))?.dataset.projectId ?? null,
    pickIds: () => node.pickList.children.map((li) => li.dataset.projectId),
    pickActive: () => node.pickList.children.find((li) => li.classList.contains('active'))?.dataset.projectId ?? null,
    at: (name) => calls.order.indexOf(name),
  };
}

// ---------- 1-11: the row model, which is pure ----------

test('1: a project reads as its title with the slug behind it, and as the slug alone when they agree', () => {
  const h = load();
  assert.equal(h.mod.projectLabel({ id: 'p1', title: 'Checkout' }), 'Checkout (p1)');
  assert.equal(h.mod.projectLabel({ id: 'p1', title: 'p1' }), 'p1');
  assert.equal(h.mod.projectLabel({ id: 'p1' }), 'p1');
});

test('2: a handoff whose host has closed its browser is pinned to the one project it left behind', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', handoff: true, apiToken: '' }, offer: null });
  assert.equal(h.fn.projectPinned(), true);
});

test('3: the same handoff with its host still there is not pinned — the session reads every project', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', handoff: true, apiToken: '' }, offer: { app: 'Testeiya' } });
  assert.equal(h.fn.projectPinned(), false);
});

test('4: a connection carrying the tester’s own token is never pinned, host offer or not', () => {
  assert.equal(load({ settings: { handoff: true, apiToken: 'TOKEN' } }).fn.projectPinned(), false);
  assert.equal(load({ settings: null }).fn.projectPinned(), false);
  assert.equal(load({ settings: { apiToken: 'TOKEN' } }).fn.projectPinned(), false);
});

test('5: the saved project leads the rows even when the token’s list has never heard of it', () => {
  const h = load({ settings: { ...SETTINGS, projectId: 'p9' } });
  assert.deepEqual(plain(h.fn.projectRows()), [{ id: 'p9', title: '' }, CHECKOUT, BILLING]);
});

test('5b: a saved project the list DOES carry is not doubled, and keeps the list’s own title', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.projectRows()), [CHECKOUT, BILLING]);
});

test('6: with no project chosen yet the rows are the token’s list exactly as it stands', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  assert.deepEqual(plain(h.fn.projectRows()), [CHECKOUT, BILLING]);
  assert.equal(h.fn.projectRows(), h.state.projects); // the list itself, untouched
  assert.deepEqual(plain(load({ settings: null }).fn.projectRows()), [CHECKOUT, BILLING]);
});

test('7: a saved project and no list at all is still one row — the tester can see where they are', () => {
  const h = load({ settings: { ...SETTINGS, projectId: 'p9' }, projects: [] });
  assert.deepEqual(plain(h.fn.projectRows()), [{ id: 'p9', title: '' }]);
});

test('8: the filter is trimmed and case-blind, and matches the title AND the slug', () => {
  const h = load();
  const rows = [CHECKOUT, BILLING];
  assert.deepEqual(plain(h.fn.matchProjects(rows, '  CHECK ')), [CHECKOUT]);
  assert.deepEqual(plain(h.fn.matchProjects(rows, 'P2')), [BILLING]);   // the slug alone
  assert.deepEqual(plain(h.fn.matchProjects(rows, 'zzz')), []);
});

test('9: an empty filter is no filter — every row stands', () => {
  const h = load();
  const rows = [CHECKOUT, BILLING];
  assert.equal(h.fn.matchProjects(rows, ''), rows);
  assert.equal(h.fn.matchProjects(rows, null), rows);
  assert.equal(h.fn.matchProjects(rows, undefined), rows);
  assert.equal(h.fn.matchProjects(rows, '   '), rows); // trimmed to nothing
});

test('10: a row with no title is matched on its slug rather than throwing on the missing one', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.matchProjects([{ id: 'p1' }], 'p1')), [{ id: 'p1' }]);
});

test('11: a project named in the tester’s own alphabet is matched the same way', () => {
  const h = load();
  const rows = [{ id: 'pay', title: 'Платіжний шлюз' }, CHECKOUT];
  assert.deepEqual(plain(h.fn.matchProjects(rows, 'платіж')), [rows[0]]);
  assert.deepEqual(plain(h.fn.matchProjects(rows, 'ПЛАТІЖ')), [rows[0]]);
});

test('11b: the popup’s own filter box narrows the rows through the same two functions', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'bill';
  h.fn.onProjectFilterInput();
  assert.deepEqual(h.optionIds(), ['p2']);
  assert.equal(h.peek().projectFilter, 'bill');
  assert.equal(h.activeId(), 'p2'); // the first match takes the cursor
});

// ---------- 12-18: the bar the tester reads the project off ----------

test('12: no project and nothing to pick from hides the whole bar and leaves no stale slug behind', () => {
  const h = load({ settings: null, projects: [] });
  h.node.projectTrigger.dataset.projectId = 'stale';
  h.node.projectBar.hidden = false;
  h.fn.renderProjectBar();
  assert.equal(h.node.projectBar.hidden, true);
  assert.equal(h.node.projectCurrent.textContent, '');
  assert.equal('projectId' in h.node.projectTrigger.dataset, false);
  assert.equal(h.node.projectOpen.hidden, true); // the link went with it
});

test('13: a list but no project turns the trigger into the picker, and the e2e slug stays absent', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  h.fn.renderProjectBar();
  assert.equal(h.node.projectBar.hidden, false);
  assert.equal(h.node.projectCurrent.textContent, 'Choose a project');
  assert.equal('projectId' in h.node.projectTrigger.dataset, false);
  assert.equal(h.node.projectTrigger.dataset.tip, 'Choose a project');
});

test('13b: with a project the trigger carries its label and the slug the panel’s own e2e reads', () => {
  const h = load();
  h.fn.renderProjectBar();
  assert.equal(h.node.projectCurrent.textContent, 'Checkout (p1)');
  assert.equal(h.node.projectTrigger.dataset.projectId, 'p1');
  assert.equal(h.node.projectTrigger.getAttribute('aria-disabled'), 'false');
  assert.equal(h.node.projectTrigger.dataset.tip, 'Active project: Checkout (p1)');
});

test('13c: a saved project the list does not carry is still named, by its slug', () => {
  const h = load({ settings: { ...SETTINGS, projectId: 'p9' }, projects: [] });
  h.fn.renderProjectBar();
  assert.equal(h.node.projectCurrent.textContent, 'p9');
  assert.equal(h.node.projectTrigger.dataset.projectId, 'p9');
});

test('14: pinned, the trigger says so in the tooltip and stays hoverable — aria-disabled, never disabled', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', projectId: 'p1', handoff: true }, offer: null });
  h.fn.renderProjectBar();
  assert.equal(h.node.projectTrigger.getAttribute('aria-disabled'), 'true');
  assert.equal(h.node.projectTrigger.disabled, undefined); // a disabled button swallows the hover
  assert.equal(h.node.projectTrigger.dataset.tip,
    'Project chosen by the app that opened this browser — switch it there');
});

test('14b: an offer that is still live is not a pin at all — the bar stays the tester’s to use', () => {
  // projectPinned() IS `!Handoff.offer()`, so a pinned bar is by definition one with no offer left to
  // read a name off: the tooltip's app name can only ever be the fallback wording. Pinned here.
  const h = load({ settings: { baseUrl: 'https://a.io', projectId: 'p1', handoff: true }, offer: { app: 'Testeiya' } });
  h.fn.renderProjectBar();
  assert.equal(h.node.projectTrigger.getAttribute('aria-disabled'), 'false');
  assert.equal(h.node.projectTrigger.dataset.tip, 'Active project: Checkout (p1)');
});

test('15: a list landing while the popup is open repaints the rows under the tester’s cursor', () => {
  const h = load({ projects: [CHECKOUT] });
  h.fn.openProjectMenu();
  assert.deepEqual(h.optionIds(), ['p1']);
  h.state.projects = [CHECKOUT, BILLING, PLAIN];
  h.calls.order.length = 0;
  h.fn.renderProjectBar();
  assert.deepEqual(h.optionIds(), ['p1', 'p2', 'p3']);
  assert.ok(h.calls.order.includes('renderProjectOptions'));
});

test('15b: a closed popup is left alone — the rows are rebuilt on open, not on every repaint', () => {
  const h = load({ projects: [CHECKOUT] });
  h.calls.order.length = 0;
  h.fn.renderProjectBar();
  assert.equal(h.calls.order.includes('renderProjectOptions'), false);
  assert.deepEqual(h.optionIds(), []);
});

test('16: the open-in-Testomat link points at the active project, slug and all escaped', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', projectId: 'p 1', apiToken: 'TOKEN' } });
  h.fn.renderProjectOpenLink();
  assert.equal(h.node.projectOpen.href, 'https://a.io/projects/p%201');
  assert.equal(h.node.projectOpen.hidden, false);
});

test('17: with nothing to link to the link HIDES rather than point at a 404', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  h.node.projectOpen.href = 'https://a.io/projects/old';
  h.node.projectOpen.hidden = false;
  h.fn.renderProjectOpenLink();
  assert.equal(h.node.projectOpen.getAttribute('href'), null);
  assert.equal(h.node.projectOpen.hidden, true);
  // No settings at all is the same answer, not a throw.
  const bare = load({ settings: null });
  bare.fn.renderProjectOpenLink();
  assert.equal(bare.node.projectOpen.hidden, true);
});

test('18: the link echoes the instance address verbatim — the scheme is gated where the address is set', () => {
  // #183 called an http:// href here an open bug on the handoff path. It does not reproduce: a host
  // file naming an http instance is refused outright (shared/handoff.js:56-58, pinned by
  // tests/handoff.test.mjs H9) and Save refuses a typed one (screens/settings.js:323-327), so no
  // http baseUrl reaches state.settings. What this function owes is a link to the instance the
  // tester is actually on, which is what is asserted here.
  const h = load({ settings: { baseUrl: 'http://localhost:3000', projectId: 'p1', apiToken: 'TOKEN' } });
  h.fn.renderProjectOpenLink();
  assert.equal(h.node.projectOpen.href, 'http://localhost:3000/projects/p1');
  assert.equal(h.node.projectOpen.hidden, false);
});

// ---------- 19-23: one row, shared by both surfaces ----------

const rowOf = (h, p, over = {}) => h.fn.projectRowEl(p, {
  current: 'p1', activeId: null, idPrefix: 'project-opt-', className: 'menu-option project-option',
  onPick: () => {}, ...over,
});

test('19: a row is an option with both lines and a grouped count, and the count keeps the raw figure in its tip', () => {
  const h = load();
  const li = rowOf(h, { id: 'p1', title: 'Checkout', testsCount: 1234 });
  assert.equal(li.tagName, 'LI');
  assert.equal(li.id, 'project-opt-p1');
  assert.equal(li.className, 'menu-option project-option');
  assert.equal(li.getAttribute('role'), 'option');
  assert.equal(li.dataset.projectId, 'p1');
  assert.equal(li.querySelector('.project-option-title').textContent, 'Checkout');
  assert.equal(li.querySelector('.project-option-slug').textContent, 'p1');
  assert.equal(li.querySelector('.row-count').textContent, '1 234'); // grouped, with a plain space
  assert.equal(li.querySelector('.row-count').dataset.tip, '1234 tests');
});

test('19b: the slug line renders even when it says exactly what the title says — no row comes up short', () => {
  const h = load();
  const li = rowOf(h, { id: 'p3', title: 'p3' });
  assert.equal(li.querySelector('.project-option-title').textContent, 'p3');
  assert.equal(li.querySelector('.project-option-slug').textContent, 'p3');
  // A row with no title at all falls back to the slug on the top line too.
  const bare = rowOf(h, { id: 'p4' });
  assert.equal(bare.querySelector('.project-option-title').textContent, 'p4');
  assert.equal(bare.querySelector('.project-option-slug').textContent, 'p4');
});

test('20: an empty project SHOWS its zero — a blank tail reads as "not counted yet"', () => {
  const h = load();
  const li = rowOf(h, { id: 'p1', title: 'Checkout', testsCount: 0 });
  assert.equal(li.querySelector('.row-count').textContent, '0');
});

test('21: a count nobody knows draws nothing at all', () => {
  const h = load();
  assert.equal(rowOf(h, { id: 'p1', testsCount: null }).querySelector('.row-count'), null);
  assert.equal(rowOf(h, { id: 'p1' }).querySelector('.row-count'), null);
  assert.equal(rowOf(h, { id: 'p1', testsCount: 'many' }).querySelector('.row-count'), null);
  assert.equal(rowOf(h, { id: 'p1', testsCount: Infinity }).querySelector('.row-count'), null);
});

test('22: the project the tester is on is the SELECTED row, and the cursor is a class of its own', () => {
  const h = load();
  assert.equal(rowOf(h, CHECKOUT).getAttribute('aria-selected'), 'true');
  assert.equal(rowOf(h, BILLING).getAttribute('aria-selected'), 'false');
  assert.equal(rowOf(h, BILLING).classList.contains('active'), false);
  assert.equal(rowOf(h, BILLING, { activeId: 'p2' }).classList.contains('active'), true);
});

test('23: pressing the mouse on a row keeps the caret in the filter box, and releasing it picks', () => {
  const h = load();
  const picked = [];
  const li = rowOf(h, BILLING, { onPick: (id) => picked.push(id) });
  const down = fire(li, 'mousedown');
  assert.equal(down.defaultPrevented, true);
  li.dispatchEvent({ type: 'click' });
  assert.deepEqual(picked, ['p2']);
});

// ---------- 24-27: the cursor ----------

test('24: a cursor the filter has just hidden moves to the first row still visible', () => {
  const h = load({ projects: [CHECKOUT, BILLING] });
  h.fn.openProjectMenu();
  assert.equal(h.peek().projectActiveId, 'p1');
  h.node.projectFilter.value = 'bill';
  h.fn.onProjectFilterInput();
  assert.equal(h.peek().projectActiveId, 'p2');
  assert.equal(h.activeId(), 'p2');
  assert.equal(h.node.projectFilter.getAttribute('aria-activedescendant'), 'project-opt-p2');
});

test('25: a filter that matches nobody empties the cursor and shows the empty state', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'zzz';
  h.fn.onProjectFilterInput();
  assert.deepEqual(h.optionIds(), []);
  assert.equal(h.peek().projectActiveId, null);
  assert.equal(h.node.projectEmpty.hidden, false);
  assert.equal(h.node.projectFilter.getAttribute('aria-activedescendant'), null);
});

test('25b: rows again, and the empty state goes back where it came from', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'zzz';
  h.fn.onProjectFilterInput();
  h.node.projectFilter.value = '';
  h.fn.onProjectFilterInput();
  assert.equal(h.node.projectEmpty.hidden, true);
  assert.deepEqual(h.optionIds(), ['p1', 'p2']);
});

test('26: the arrows STOP at the last row — no wrap back to the top', () => {
  const h = load({ projects: [CHECKOUT, BILLING, PLAIN] });
  h.fn.openProjectMenu();
  h.fn.moveProjectActive(1);
  h.fn.moveProjectActive(1);
  assert.equal(h.peek().projectActiveId, 'p3');
  h.fn.moveProjectActive(1);
  assert.equal(h.peek().projectActiveId, 'p3');
  assert.equal(h.activeId(), 'p3');
  // …and at the first row on the way back.
  h.fn.moveProjectActive(-1);
  h.fn.moveProjectActive(-1);
  h.fn.moveProjectActive(-1);
  assert.equal(h.peek().projectActiveId, 'p1');
  assert.equal(h.activeId(), 'p1');
});

test('27: an arrow pressed with the cursor on nothing lands on the first row, whichever way it points', () => {
  // The cursor is on nothing whenever the last render had no rows; a list landing behind an open
  // popup is how rows come back under it. Up, from there, must not walk off the top.
  const empty = { baseUrl: 'https://a.io', apiToken: 'TOKEN' };
  const h = load({ settings: empty, projects: [] });
  h.fn.openProjectMenu();
  assert.equal(h.peek().projectActiveId, null);
  h.state.projects = [CHECKOUT, BILLING];
  h.fn.moveProjectActive(-1);
  assert.equal(h.peek().projectActiveId, 'p1');

  const g = load({ settings: empty, projects: [] });
  g.fn.openProjectMenu();
  g.state.projects = [CHECKOUT, BILLING];
  g.fn.moveProjectActive(1);
  assert.equal(g.peek().projectActiveId, 'p1'); // and Down from nothing is the first row too
});

test('27b: an arrow over an empty list is a no-op, not a crash', () => {
  const h = load({ projects: [], settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  h.fn.renderProjectOptions();
  h.fn.moveProjectActive(1);
  assert.equal(h.peek().projectActiveId, null);
});

test('27c: the cursor scrolls itself into view — the row below the fold is still reachable by keyboard', () => {
  const h = load({ projects: [CHECKOUT, BILLING, PLAIN] });
  h.fn.openProjectMenu();
  h.calls.scrolls.length = 0;
  h.fn.moveProjectActive(1);
  assert.deepEqual(h.calls.scrolls, [{ id: 'project-opt-p2', arg: { block: 'nearest' } }]);
});

// ---------- 28-37: the keys, and opening and closing ----------

test('28: Escape closes the popup and hands the caret back to the trigger, and no one else sees the key', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.calls.order.length = 0;
  const ev = fire(h.doc, 'keydown', { key: 'Escape' });
  assert.equal(h.node.projectMenu.hidden, true);
  assert.equal(h.node.projectTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.ok(h.calls.order.includes('focus:project-trigger'));
});

test('29: Tab closes the popup WITHOUT taking the caret back — focus is on its way somewhere', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.calls.order.length = 0;
  const ev = fire(h.doc, 'keydown', { key: 'Tab' });
  assert.equal(h.node.projectMenu.hidden, true);
  assert.equal(h.calls.order.includes('focus:project-trigger'), false);
  assert.equal(ev.defaultPrevented, false); // the browser's own Tab still runs
});

test('30: an arrow is swallowed whole — the panel’s own arrow handling must never see it', () => {
  const h = load({ projects: [CHECKOUT, BILLING] });
  h.fn.openProjectMenu();
  const down = fire(h.doc, 'keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.propagationStopped, true);
  assert.equal(h.peek().projectActiveId, 'p2');
  const up = fire(h.doc, 'keydown', { key: 'ArrowUp' });
  assert.equal(up.defaultPrevented, true);
  assert.equal(up.propagationStopped, true);
  assert.equal(h.peek().projectActiveId, 'p1');
});

test('31: Enter picks the row under the cursor, and that is a switch', () => {
  const h = load({ projects: [CHECKOUT, BILLING] });
  h.fn.openProjectMenu();
  h.fn.moveProjectActive(1);
  const switches = h.stub('switchProject');
  const ev = fire(h.doc, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(switches, [['p2']]);
  assert.equal(h.node.projectMenu.hidden, true); // pickProject closes first — the switch repaints views
});

test('31b: Enter with no cursor picks nothing, and still keeps the key to itself', () => {
  const h = load({ projects: [], settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  h.fn.openProjectMenu();
  assert.equal(h.peek().projectActiveId, null);
  const switches = h.stub('switchProject');
  const ev = fire(h.doc, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(switches, []);
});

test('32: with the popup closed the document-level keys do nothing at all', () => {
  const h = load();
  h.fn.renderProjectOptions();
  const before = h.peek().projectActiveId;
  for (const k of ['Escape', 'ArrowDown', 'Enter', 'Tab']) {
    const ev = event(h.doc, 'keydown', { key: k });
    h.fn.onProjectMenuKey(ev);
    assert.equal(ev.defaultPrevented, false, k);
    assert.equal(ev.propagationStopped, false, k);
  }
  assert.equal(h.peek().projectActiveId, before);
});

test('32b: closing takes both document listeners with it — a leaked capture handler eats the panel’s keys', () => {
  const h = load();
  h.fn.openProjectMenu();
  assert.equal(h.doc.listeners.get('click').length, 1);
  assert.equal(h.doc.listeners.get('keydown').length, 1);
  h.fn.closeProjectMenu();
  assert.equal(h.doc.listeners.get('click').length, 0);
  assert.equal(h.doc.listeners.get('keydown').length, 0);
  // A second close over a closed popup adds nothing and removes nothing.
  h.fn.closeProjectMenu();
  assert.equal(h.doc.listeners.get('click').length, 0);
});

test('33: Space on the closed trigger opens the popup instead of clicking the button shut again', () => {
  for (const k of [' ', 'Enter', 'ArrowDown', 'ArrowUp']) {
    const h = load();
    h.fn.initProjectDropdown();
    const ev = fire(h.node.projectTrigger, 'keydown', { key: k });
    assert.equal(ev.defaultPrevented, true, k);
    assert.equal(h.node.projectMenu.hidden, false, k);
  }
  const h = load();
  h.fn.initProjectDropdown();
  const ev = fire(h.node.projectTrigger, 'keydown', { key: 'a' });
  assert.equal(ev.defaultPrevented, false); // typing is not a way in
  assert.equal(h.node.projectMenu.hidden, true);
});

test('34: the same keys with the popup already open are the popup’s, not the trigger’s', () => {
  const h = load();
  h.fn.initProjectDropdown();
  h.fn.openProjectMenu();
  h.calls.order.length = 0;
  const ev = fire(h.node.projectTrigger, 'keydown', { key: ' ' });
  assert.equal(ev.defaultPrevented, false);
  assert.equal(h.calls.order.includes('renderProjectOptions'), false); // no second open
});

test('34b: clicking the trigger toggles, and the click never reaches the document’s own closer', () => {
  const h = load();
  h.fn.initProjectDropdown();
  const open = fire(h.node.projectTrigger, 'click');
  assert.equal(open.propagationStopped, true);
  assert.equal(h.node.projectMenu.hidden, false);
  const shut = fire(h.node.projectTrigger, 'click');
  assert.equal(shut.propagationStopped, true);
  assert.equal(h.node.projectMenu.hidden, true);
  assert.ok(h.calls.order.includes('focus:project-trigger'));
});

test('35: a click on the filter box or the list is INSIDE — the popup does not close under the tester', () => {
  const h = load();
  h.fn.openProjectMenu();
  for (const target of [h.node.projectFilter, h.node.projectList, h.node.projectMenu, h.node.projectTrigger]) {
    h.fn.onProjectDocClick({ target });
    assert.equal(h.node.projectMenu.hidden, false, target.id);
  }
  h.fn.onProjectDocClick({ target: h.doc.body });
  assert.equal(h.node.projectMenu.hidden, true);
});

test('36: a pinned connection cannot open the popup at all', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', projectId: 'p1', handoff: true }, offer: null });
  h.fn.openProjectMenu();
  assert.equal(h.node.projectMenu.hidden, true);
  assert.equal(h.node.projectTrigger.getAttribute('aria-expanded'), 'false');
  assert.equal((h.doc.listeners.get('click') || []).length, 0); // and nothing was listening for the way out
});

test('37: opening clears the last filter, puts the cursor on the project in use and focuses the box', () => {
  // The active project is deliberately NOT the first row: opening on rows[0] would answer this row
  // by accident on any list where the two happen to agree.
  const h = load({ projects: [BILLING, PLAIN, CHECKOUT] });
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'bill';
  h.fn.onProjectFilterInput();
  h.fn.closeProjectMenu();
  h.calls.order.length = 0;

  h.fn.openProjectMenu();
  assert.equal(h.peek().projectFilter, '');
  assert.equal(h.node.projectFilter.value, '');
  assert.deepEqual(h.optionIds(), ['p2', 'p3', 'p1']);
  assert.equal(h.peek().projectActiveId, 'p1');    // the ACTIVE project, not the first row
  assert.equal(h.activeId(), 'p1');
  assert.equal(h.node.projectMenu.hidden, false);
  assert.equal(h.node.projectTrigger.getAttribute('aria-expanded'), 'true');
  assert.ok(h.calls.order.includes('focus:project-filter'));
  // Focus lands AFTER the rows exist — a hidden, empty list cannot carry aria-activedescendant.
  assert.ok(h.calls.order.indexOf('renderProjectOptions') < h.calls.order.indexOf('focus:project-filter'));
  assert.equal(h.node.projectFilter.getAttribute('aria-activedescendant'), 'project-opt-p1');
});

test('37b: opening on a connection with no project yet leaves the cursor to the first row', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' } });
  h.fn.openProjectMenu();
  assert.equal(h.peek().projectActiveId, 'p1');
  assert.deepEqual(h.optionIds(), ['p1', 'p2']);
});

test('37c: an already-open popup is not re-opened — a second open would throw the filter away', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'bill';
  h.fn.onProjectFilterInput();
  h.fn.openProjectMenu();
  assert.equal(h.peek().projectFilter, 'bill');
  assert.deepEqual(h.optionIds(), ['p2']);
});

// ---------- 38-39: filling the list ----------

test('38: a connection with no credential asks for nothing and answers with an empty list', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io' } });
  assert.deepEqual(plain(await h.fn.refreshProjects()), []);
  assert.equal(h.calls.listProjects, 0);
  assert.deepEqual(plain(h.state.projects), [CHECKOUT, BILLING]); // untouched
});

test('39: a list that fails to load leaves the projects the panel already had exactly where they were', async () => {
  const h = load();
  h.on.listProjects = async () => { throw new Error('offline'); };
  assert.deepEqual(plain(await h.fn.refreshProjects()), []);
  assert.equal(h.calls.listProjects, 1);
  assert.deepEqual(plain(h.state.projects), [CHECKOUT, BILLING]);
  assert.equal(h.calls.order.includes('renderProjectBar'), false); // nothing changed, nothing repainted
});

test('39b: a list that lands replaces the projects and repaints the bar', async () => {
  const h = load();
  h.on.listProjects = async () => [PLAIN];
  assert.deepEqual(plain(await h.fn.refreshProjects()), [PLAIN]);
  assert.deepEqual(plain(h.state.projects), [PLAIN]);
  assert.ok(h.calls.order.includes('renderProjectBar'));
});

// ---------- 40-42: writing it down ----------

test('40: the write puts the settings and the host map down, then DROPS the old project’s session', async () => {
  const h = load({ hostSettings: { 'b.io': { baseUrl: 'https://b.io' } } });
  const settings = { baseUrl: 'https://a.io', projectId: 'p2', apiToken: 'TOKEN' };
  await h.fn.persistActiveSettings(settings);
  assert.deepEqual(plain(h.state.hostSettings), {
    'b.io': { baseUrl: 'https://b.io' },
    'a.io': settings,
  });
  const ops = h.store.calls.filter((c) => c.area === 'local').map((c) => c.op);
  assert.deepEqual(ops, ['set', 'remove']); // in this order, and both of them
  assert.deepEqual(plain(h.store.ops('local', 'set')[0].arg), { settings, hostSettings: plain(h.state.hostSettings) });
  assert.deepEqual(plain(h.store.ops('local', 'remove')[0].arg), 'session');
});

test('40b: outside Chrome nothing is written, and the host map is still brought up to date', async () => {
  const h = load({ hasChrome: false });
  const settings = { baseUrl: 'https://a.io', projectId: 'p2' };
  await h.fn.persistActiveSettings(settings);
  assert.deepEqual(plain(h.state.hostSettings), { 'a.io': settings });
  assert.equal(h.store.calls.length, 0);
});

test('41: a storage hiccup does not strand the switch — the write fails quietly', async () => {
  const h = load();
  h.store.fails.set = new Error('QUOTA');
  await h.fn.persistActiveSettings({ baseUrl: 'https://a.io', projectId: 'p2' }); // must not throw
  assert.deepEqual(h.store.ops('local', 'remove'), []); // the set threw before the session drop
  const g = load();
  g.store.fails.remove = new Error('QUOTA');
  await g.fn.persistActiveSettings({ baseUrl: 'https://a.io', projectId: 'p2' });
  assert.equal(g.store.ops('local', 'set').length, 1);
});

test('42: an instance address that is not an address writes no host entry, and still saves', async () => {
  const h = load();
  const settings = { baseUrl: 'garbage', projectId: 'p2' };
  await h.fn.persistActiveSettings(settings);
  assert.deepEqual(plain(h.state.hostSettings), {});
  assert.deepEqual(h.store.calls.filter((c) => c.area === 'local').map((c) => c.op), ['set', 'remove']);
  assert.deepEqual(plain(h.store.ops('local', 'set')[0].arg), { settings, hostSettings: {} });
});

// ---------- 43-51: the switch, and the order it happens in ----------

test('43: picking the project already in use does nothing whatsoever', async () => {
  const h = load();
  await h.fn.switchProject('p1');
  assert.deepEqual(h.calls.order, ['switchProject']);
  assert.equal(h.store.calls.length, 0);
});

test('44: a switch with nothing to switch — no slug, or no connection — is a no-op', async () => {
  const h = load();
  await h.fn.switchProject(null);
  await h.fn.switchProject('');
  assert.equal(h.store.calls.length, 0);
  const g = load({ settings: null });
  await g.fn.switchProject('p2');
  assert.equal(g.store.calls.length, 0);
  assert.equal(g.state.settings, null);
});

test('45: the queue is drained BEFORE anything moves, and the drain still sees the OLD project', async () => {
  const h = load({ queue: 2 });
  const d = deferred();
  let seenDuringDrain = null;
  h.on.replay = () => { seenDuringDrain = h.state.settings.projectId; return d.promise; };

  const p = h.fn.switchProject('p2');
  await settle();
  // Nothing has moved yet: the switch is parked on the drain.
  assert.deepEqual(h.calls.order, ['switchProject', 'OfflineQueue.count', 'OfflineQueue.replay']);
  assert.equal(seenDuringDrain, 'p1');            // a queued result flushing here lands on p1
  assert.equal(h.state.settings.projectId, 'p1');
  assert.equal(h.store.calls.length, 0);

  d.resolve();
  await p;
  assert.ok(h.at('OfflineQueue.replay') < h.at('Handoff.configure'));
  assert.equal(h.state.settings.projectId, 'p2');
});

test('45b: a drain that fails is swallowed — the tester is not held on the old project by it', async () => {
  const h = load({ queue: 1 });
  h.on.replay = async () => { throw new Error('still offline'); };
  await h.fn.switchProject('p2');
  assert.equal(h.state.settings.projectId, 'p2');
  assert.deepEqual(h.calls.toasts, ['Switched to Billing']);
});

test('45c: an empty queue is not drained, and a panel without the queue at all still switches', async () => {
  const h = load({ queue: 0 });
  await h.fn.switchProject('p2');
  assert.equal(h.calls.order.includes('OfflineQueue.replay'), false);
  assert.ok(h.calls.order.includes('OfflineQueue.count'));
  const g = load({ queue: null }); // no such global — the typeof guard's own branch
  await g.fn.switchProject('p2');
  assert.equal(g.state.settings.projectId, 'p2');
});

test('46: entries the drain could not clear do NOT stand in the tester’s way — each carries its own stamp', async () => {
  const h = load({ queue: 3 });
  h.on.replay = async () => {}; // replayed nothing; the count would still be 3
  await h.fn.switchProject('p2');
  assert.equal(h.state.settings.projectId, 'p2');
  assert.deepEqual(h.calls.toasts, ['Switched to Billing']);
  // Nothing asked the tester to confirm, and the count is never re-read after the drain.
  assert.equal(h.calls.order.filter((n) => n === 'OfflineQueue.count').length, 1);
});

test('47: the switch happens in ONE order — configure, tear down, write, repaint, open, count, say so', async () => {
  const h = load({ activeTab: 'runs' });
  await h.fn.switchProject('p2');
  assert.deepEqual(h.calls.order, [
    'switchProject',
    'Handoff.configure',
    'resetProjectScopedState',
    'persistActiveSettings',
    'renderProjectBar',
    'openRunsView',
    'prefetchTabCounts',
    'toast',
  ]);
  // …and the teardown ran before ANY of it was written down: a reload mid-switch cannot come back
  // to a run of the old project against the slug of the new one.
  assert.deepEqual(h.calls.resets, [{ projectId: 'p2', writes: 0, removes: 0 }]);
  // The bar is repainted only once the write has landed, session drop and all.
  assert.deepEqual(h.calls.repaints, [{ writes: 1, removes: 1 }]);
});

test('47b: the counts are fired and NOT waited for — the switch is over before the chips fill in', async () => {
  const h = load();
  const d = deferred();
  h.on.prefetchTabCounts = () => d.promise;
  await h.fn.switchProject('p2'); // would hang here if it were awaited
  assert.equal(h.calls.prefetches, 1);
  assert.deepEqual(h.calls.toasts, ['Switched to Billing']);
  d.resolve();
});

test('47c: a storage failure mid-switch still finishes the switch — in memory and on screen both', async () => {
  const h = load();
  h.store.fails.set = new Error('QUOTA');
  await h.fn.switchProject('p2'); // must not reject
  assert.equal(h.state.settings.projectId, 'p2');
  assert.deepEqual(h.calls.order, [
    'switchProject', 'Handoff.configure', 'resetProjectScopedState', 'persistActiveSettings',
    'renderProjectBar', 'openRunsView', 'prefetchTabCounts', 'toast',
  ]);
  assert.deepEqual(h.calls.toasts, ['Switched to Billing']);
});

test('48: the first pick of a connection clears the line Save left behind and lands on Runs', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' }, activeTab: 'settings' });
  await h.fn.switchProject('p1');
  assert.deepEqual(h.calls.lines, [{ id: 'settings-status', text: '' }]);
  assert.ok(h.at('setStatusLine') < h.at('openRunsView'));
  assert.equal(h.calls.order.includes('fillSettingsForm'), false); // the settings tab does not hold it
  assert.deepEqual(h.calls.toasts, ['Connected to Checkout']);
});

test('49: a later pick made from Settings stays on Settings, with the form refilled', async () => {
  const h = load({ activeTab: 'settings' });
  await h.fn.switchProject('p2');
  assert.ok(h.at('fillSettingsForm') < h.at('show'));
  assert.deepEqual(h.calls.shows, ['settings']);
  assert.equal(h.calls.order.includes('openRunsView'), false);
  assert.deepEqual(h.calls.lines, []);
  assert.deepEqual(h.calls.toasts, ['Switched to Billing']);
});

test('50: a pick made from the Tests tab reopens the Tests tab at its root', async () => {
  const h = load({ activeTab: 'tests' });
  await h.fn.switchProject('p2');
  assert.ok(h.calls.order.includes('openTcStudioView'));
  assert.equal(h.calls.order.includes('openRunsView'), false);
});

test('50b: every other tab goes back to Runs', async () => {
  for (const tab of ['runs', 'run', null, undefined]) {
    const h = load({ activeTab: tab });
    await h.fn.switchProject('p2');
    assert.ok(h.calls.order.includes('openRunsView'), String(tab));
  }
});

test('50c: the view opener is awaited — the counts are not fired at a half-painted screen', async () => {
  const h = load();
  const d = deferred();
  h.on.openRunsView = () => d.promise;
  const p = h.fn.switchProject('p2');
  await settle();
  assert.equal(h.calls.prefetches, 0);
  assert.deepEqual(h.calls.toasts, []);
  d.resolve();
  await p;
  assert.equal(h.calls.prefetches, 1);
});

test('51: a project the list has never heard of is named by its slug in the toast', async () => {
  const h = load();
  await h.fn.switchProject('p9');
  assert.deepEqual(h.calls.toasts, ['Switched to p9']);
  const g = load({ projects: [PLAIN] });
  await g.fn.switchProject('p3');
  assert.deepEqual(g.calls.toasts, ['Switched to p3']); // a title that IS the slug reads the same
});

test('51b: the switch carries every other setting across untouched, and configures the API with it', async () => {
  const h = load({ settings: { ...SETTINGS, evidenceWindowSec: 60 } });
  await h.fn.switchProject('p2');
  assert.deepEqual(plain(h.state.settings),
    { baseUrl: 'https://a.io', projectId: 'p2', apiToken: 'TOKEN', evidenceWindowSec: 60 });
  assert.deepEqual(h.calls.configured, [plain(h.state.settings)]);
});

// ---------- 52-55: what boot resolves ----------

test('52: a saved project is ready at once, and the list is fetched BEHIND the answer', async () => {
  const h = load();
  const d = deferred();
  h.on.listProjects = () => d.promise;
  assert.equal(await h.fn.initProjectSwitcher(), 'ready'); // would hang if the fetch were awaited
  assert.ok(h.at('renderProjectBar') < h.at('refreshProjects'));
  assert.equal(h.node.projectCurrent.textContent, 'Checkout (p1)');
  d.resolve([]);
  await settle();
});

test('53: a token whose account has no project at all leaves nothing to run against', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' }, projects: [] });
  h.on.listProjects = async () => [];
  assert.equal(await h.fn.initProjectSwitcher(), 'none');
  assert.equal(h.store.calls.length, 0);
});

test('53b: a list that will not load is the same verdict — nothing to run against yet', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' }, projects: [] });
  h.on.listProjects = async () => { throw new Error('offline'); };
  assert.equal(await h.fn.initProjectSwitcher(), 'none');
});

test('54: a lone project is taken without asking, and written down the way Save writes it', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' }, projects: [] });
  h.on.listProjects = async () => [BILLING];
  assert.equal(await h.fn.initProjectSwitcher(), 'ready');
  assert.equal(h.state.settings.projectId, 'p2');
  assert.deepEqual(h.calls.configured, [plain(h.state.settings)]);
  assert.deepEqual(h.store.calls.filter((c) => c.area === 'local').map((c) => c.op), ['set', 'remove']);
  assert.deepEqual(plain(h.state.hostSettings), { 'a.io': plain(h.state.settings) });
  assert.equal(h.node.projectCurrent.textContent, 'Billing (p2)');
});

test('55: several projects and no saved one is the tester’s pick to make', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 'TOKEN' }, projects: [] });
  h.on.listProjects = async () => [CHECKOUT, BILLING, PLAIN];
  assert.equal(await h.fn.initProjectSwitcher(), 'choose');
  assert.equal(h.state.settings.projectId, undefined);
  assert.equal(h.store.calls.length, 0); // nothing decided, nothing written
});

test('55b: the choose-a-project screen is what "choose" opens, with the settings form behind it', () => {
  const h = load();
  h.fn.askForProject();
  assert.deepEqual(h.calls.order, ['fillSettingsForm', 'setStatusLine', 'show', 'focus:pick-filter']);
  assert.deepEqual(h.calls.shows, ['pick']);
  assert.ok(h.at('fillSettingsForm') < h.at('show')); // the form is what a Disconnect from there leaves behind
});

test('55c: the dropdown is wired once, to the three controls it owns', () => {
  const h = load();
  h.fn.initProjectDropdown();
  assert.deepEqual([...h.node.projectTrigger.listeners.keys()], ['click', 'keydown']);
  assert.deepEqual([...h.node.projectFilter.listeners.keys()], ['input']);
  h.node.projectFilter.value = 'bill';
  fire(h.node.projectFilter, 'input');
  assert.equal(h.peek().projectFilter, 'bill');
});

// ---------- P1-P15: the whole-screen version of the same list ----------

test('P1: the choose-a-project screen folds in NO saved project — that pick is what it is there for', () => {
  const h = load({ settings: { ...SETTINGS, projectId: 'p9' } });
  assert.deepEqual(plain(h.fn.projectRows()), [{ id: 'p9', title: '' }, CHECKOUT, BILLING]);
  assert.deepEqual(plain(h.mod.pickRows()), [CHECKOUT, BILLING]);
});

test('P2: its rows are the popup’s rows in the screen’s own skin, and picking one switches straight away', () => {
  const h = load();
  const switches = h.stub('switchProject');
  h.fn.renderPickRows();
  const [first] = h.node.pickList.children;
  assert.equal(first.id, 'pick-opt-p1');
  assert.equal(first.className, 'project-option active'); // no `menu-option` — that skin is the popup's
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.getAttribute('aria-selected'), 'false'); // nothing is the active project yet
  assert.equal(first.querySelector('.row-count').textContent, '12');
  first.dispatchEvent({ type: 'click' });
  assert.deepEqual(switches, [['p1']]);
});

test('P3: a filter that matches nobody empties the cursor and shows the screen’s own empty state', () => {
  const h = load();
  h.node.pickFilter.value = 'zzz';
  h.fn.onPickFilterInput();
  assert.deepEqual(h.pickIds(), []);
  assert.equal(h.peek().pickActiveId, null);
  assert.equal(h.node.pickEmpty.hidden, false);
  assert.equal(h.node.pickFilter.getAttribute('aria-activedescendant'), null);
});

test('P4: the arrows STOP at the ends here too', () => {
  const h = load({ projects: [CHECKOUT, BILLING, PLAIN] });
  h.fn.renderPickRows();
  h.fn.movePickActive(1);
  h.fn.movePickActive(1);
  h.fn.movePickActive(1);
  assert.equal(h.peek().pickActiveId, 'p3');
  assert.equal(h.pickActive(), 'p3');
  h.fn.movePickActive(-1);
  h.fn.movePickActive(-1);
  h.fn.movePickActive(-1);
  assert.equal(h.peek().pickActiveId, 'p1');
  h.fn.movePickActive(-1);
  assert.equal(h.peek().pickActiveId, 'p1');
});

test('P4b: an arrow over an empty screen is a no-op', () => {
  const h = load({ projects: [] });
  h.fn.renderPickRows();
  h.fn.movePickActive(1);
  assert.equal(h.peek().pickActiveId, null);
});

test('P5: typing narrows the rows, offers the clear button and puts the cursor on the first match', () => {
  const h = load();
  h.node.pickFilter.value = 'bill';
  h.fn.onPickFilterInput();
  assert.deepEqual(h.pickIds(), ['p2']);
  assert.equal(h.node.pickFilterClear.hidden, false);
  assert.equal(h.peek().pickActiveId, 'p2');
  assert.equal(h.node.pickFilter.getAttribute('aria-activedescendant'), 'pick-opt-p2');
});

test('P6: whitespace is not a search — the clear button stays away', () => {
  const h = load();
  h.node.pickFilter.value = '   ';
  h.fn.onPickFilterInput();
  assert.equal(h.node.pickFilterClear.hidden, true);
  assert.deepEqual(h.pickIds(), ['p1', 'p2']); // and nothing is filtered out either
});

test('P7: clearing empties the box, brings every row back and leaves the caret where it can type', () => {
  const h = load();
  h.node.pickFilter.value = 'bill';
  h.fn.onPickFilterInput();
  h.calls.order.length = 0;
  h.fn.clearPickFilter();
  assert.equal(h.peek().pickFilter, '');
  assert.equal(h.node.pickFilter.value, '');
  assert.equal(h.node.pickFilterClear.hidden, true);
  assert.deepEqual(h.pickIds(), ['p1', 'p2']);
  assert.ok(h.calls.order.includes('focus:pick-filter'));
});

test('P8: the arrows are typed at the filter box and walk the list from there', () => {
  const h = load({ projects: [CHECKOUT, BILLING] });
  h.fn.initProjectPick();
  h.fn.renderPickRows();
  const down = fire(h.node.pickFilter, 'keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(h.peek().pickActiveId, 'p2');
  const up = fire(h.node.pickFilter, 'keydown', { key: 'ArrowUp' });
  assert.equal(up.defaultPrevented, true);
  assert.equal(h.peek().pickActiveId, 'p1');
});

test('P9: Enter takes the row under the cursor', () => {
  const h = load();
  h.fn.initProjectPick();
  h.fn.renderPickRows();
  h.fn.movePickActive(1);
  const switches = h.stub('switchProject');
  const ev = fire(h.node.pickFilter, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(switches, [['p2']]);
});

test('P10: Enter with nothing under the cursor takes nothing, and lets the key through', () => {
  const h = load({ projects: [] });
  h.fn.initProjectPick();
  h.fn.renderPickRows();
  const switches = h.stub('switchProject');
  const ev = fire(h.node.pickFilter, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(switches, []);
  // A key the screen does not own is left alone too.
  const other = fire(h.node.pickFilter, 'keydown', { key: 'a' });
  assert.equal(other.defaultPrevented, false);
});

test('P11: the screen is entered FRESH — a filter left by the last visit would hide rows nobody typed at', () => {
  const h = load();
  h.node.pickFilter.value = 'bill';
  h.fn.onPickFilterInput();
  h.fn.movePickActive(1);
  h.fn.openProjectPickView();
  assert.equal(h.peek().pickFilter, '');
  assert.equal(h.node.pickFilter.value, '');
  assert.equal(h.node.pickFilterClear.hidden, true);
  assert.deepEqual(h.pickIds(), ['p1', 'p2']);
  assert.equal(h.peek().pickActiveId, 'p1');
  assert.deepEqual(h.calls.lines, [{ id: 'pick-status', text: '' }]);
});

test('P12: the footer names the instance, and the caret goes in only AFTER the screen is on', () => {
  const h = load();
  h.fn.openProjectPickView();
  assert.equal(h.node.pickHost.textContent, 'a.io');
  assert.deepEqual(h.calls.shows, ['pick']);
  assert.ok(h.at('show') < h.at('focus:pick-filter')); // a hidden field cannot take focus
});

test('P13: an instance address that is not an address leaves the footer blank rather than break the screen', () => {
  const h = load({ settings: { baseUrl: 'garbage', apiToken: 'TOKEN' } });
  h.fn.openProjectPickView();
  assert.equal(h.node.pickHost.textContent, '');
  const bare = load({ settings: null });
  bare.fn.openProjectPickView();
  assert.equal(bare.node.pickHost.textContent, '');
});

test('P14: the two surfaces filter independently — the header popup keeps what the tester typed there', () => {
  const h = load();
  h.fn.openProjectMenu();
  h.node.projectFilter.value = 'check';
  h.fn.onProjectFilterInput();

  h.node.pickFilter.value = 'bill';
  h.fn.onPickFilterInput();
  assert.equal(h.peek().projectFilter, 'check');
  assert.deepEqual(h.optionIds(), ['p1']);
  assert.deepEqual(h.pickIds(), ['p2']);

  h.fn.openProjectPickView();               // and the screen's own reset leaves the popup alone
  assert.equal(h.peek().projectFilter, 'check');
  assert.equal(h.peek().pickFilter, '');
});

test('P15: Disconnect from this screen speaks on THIS screen’s line — the Connection card is unreachable from here', () => {
  const h = load();
  h.fn.initProjectPick();
  assert.deepEqual([...h.node.pickFilter.listeners.keys()], ['input', 'keydown']);
  fire(h.node.pickDisconnect, 'click');
  assert.deepEqual(h.calls.lines, [{ disconnect: { statusId: 'pick-status' } }]);
});
