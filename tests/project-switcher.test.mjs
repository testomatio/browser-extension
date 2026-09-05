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

