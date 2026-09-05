#!/usr/bin/env node
// extension/sidepanel/screens/tc-quick-bar.js — the "Add new test" bar pinned under the TC list, as
// the tester meets it: one title typed and Enter, or the Bulk switch and a whole pasted list going
// out in a single request. Rows 40-63b of #163, moved here unchanged when they left
// tests/tc-studio.test.mjs (#196).
// Two things here are easy to get quietly wrong, so most of this file is about them. The bar's text
// follows the switch: the quick field is the FIRST line of the list, and the lines under it wait in
// memory for Bulk to come back. And a create in flight leaves the fields READ-ONLY rather than
// disabled, because a title on the wire is still the tester's to read.
// The module is loaded the way index.html loads it — before screens/tc-studio.js — so the screen's
// own `loadTcList` and `resetTcSearch` are late-bound names here, recorded rather than run. That
// back-edge is the seam this file pins: rows 54, 55 and 59 assert what the bar ASKS the screen for
// and in what order, and tests/tc-studio.test.mjs's row 59b drives the real module through the real
// list to assert what the screen then draws.
// Rows 45b, 62b, 63c, 63d and 63e are new: the falsification run behind the move found five things
// pinned nowhere at all — a quick field of nothing but spaces carried into Bulk as a blank first
// line, a reset that never unticks the switch, the two guards a half-built bar leans on, the load
// order, and every call site.
// Run: node --test tests/tc-quick-bar.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, SCREENS_SRC, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// SCREENS_SRC so a falsification run reads whatever it points at; index.html belongs to no
// switchable directory and is read where it ships, as tests/run-info.test.mjs:567 reads it.
function raw(f) {
  return readFileSync(join(SCREENS_SRC, f), 'utf8');
}

// A promise this file resolves by hand: the busy guard is only about what a second press does while
// the first is still on the wire.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The panel globals tc-quick-bar.js reads, all of them real enough to be driven. `loadTcList` and
// `resetTcSearch` are screens/tc-studio.js's own and are recorders here — the screen's file is not
// loaded, which is the point of the split.
function load(opts = {}) {
  const o = {
    suiteId: null,
    search: '',                      // state.tcSearch, the live filter over the TC list
    jwt: true,                       // what TestomatAPI.jwtAvailable() answers
    quickBar: true,                  // the four bar fields present in the DOM
    ...opts,
  };

  // index.html's shape (:509-513), cut to the four nodes this module touches.
  const doc = makeDocument([]);
  const node = {};
  if (o.quickBar) {
    Object.assign(node, {
      title: el('input', { id: 'tc-quick-title', value: '', hidden: false, readOnly: false, disabled: false }),
      titles: el('textarea', { id: 'tc-quick-titles', value: '', hidden: true, readOnly: false, disabled: false }),
      create: el('button', { id: 'tc-quick-create', disabled: true, textContent: 'Create' }),
      bulk: el('input', { id: 'tc-quick-bulk', type: 'checkbox', checked: false, disabled: false }),
    });
    // index.html's shape: the tip lives on the LABEL, because a disabled input answers no pointer.
    node.bulkLabel = el('label', { className: 'choice tc-quick-bulk', dataset: { tip: 'Add more' } }, node.bulk);
    doc.body.append(node.title, node.titles, node.create, node.bulkLabel);
  }
  doc.documentElement.scrollHeight = 4321;

  const calls = {
    order: [],          // one ordered trace, for the rows that assert "before", not merely "both"
    toasts: [],
    tips: [],
    scrolls: [],        // window.scrollTo arguments
    jwtAsked: 0,
    searchResets: 0,
    createTests: [],
    bulks: [],
    listLoads: [],      // { suiteId, opts, queryAtRead } — the screen's re-read, as the bar asks it
  };

  // Reassignable after load(), so a test can answer differently later, or change the world from
  // inside a call the bar is awaiting.
  const on = {
    createTest: async () => ({ id: 'made-1' }),
    bulk: async () => ({}),
    list: async () => {},
  };

  const state = { tcSuiteId: o.suiteId, tcSearch: o.search };

  const globals = {
    state,
    $: (id) => doc.getElementById(id),
    toast: (msg) => { calls.toasts.push(msg); calls.order.push('toast'); },
    baseUrlHost: () => 'app.testomat.io', // core/views.js's own — the lock names where to sign in
    // The real one writes data-tip on the node it is given; a recorder alone could not tell a tip
    // that landed on the right element from one that went nowhere. (shared/tooltip.js:257)
    Tooltip: {
      set: (n, tip) => {
        calls.tips.push(tip);
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    // screens/tc-studio.js:512-516 — everything of it the bar can observe is the query going away.
    resetTcSearch: () => {
      calls.searchResets += 1;
      calls.order.push('resetSearch');
      state.tcSearch = '';
    },
    // screens/tc-studio.js:525 — the query it finds is the whole point of the reset above.
    loadTcList: async (suiteId, listOpts = {}) => {
      calls.listLoads.push({ suiteId, opts: plain(listOpts), queryAtRead: state.tcSearch });
      calls.order.push('read');
      return on.list(suiteId, listOpts);
    },
    TestomatAPI: {
      jwtAvailable: () => { calls.jwtAsked += 1; return o.jwt; },
      createTest: async (attrs) => {
        calls.createTests.push(plain(attrs));
        calls.order.push('createTest');
        return on.createTest(attrs);
      },
      bulkCreateTests: async (id, titles) => {
        calls.bulks.push({ suiteId: id, titles: [...titles] });
        calls.order.push('bulk');
        return on.bulk(id, titles);
      },
    },
  };

  const win = {
    scrollTo: (arg) => { calls.scrolls.push(plain(arg)); calls.order.push('scroll'); },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // `TcQuickBar` is a top-level `const`: lexical, so only the completion value reaches us. The two
  // module `let`s are deliberately NOT named — the fields and the button are all the tester can see.
  const h = loadScreen('tc-quick-bar', {
    globals, document: doc, window: win, exported: 'TcQuickBar',
  });

  // app.js:65-70's own wiring; the module registers nothing at load, so the fixture stands in for
  // index.html and every row below drives real listeners. Unbound methods, exactly as app.js hands
  // them over — which row 63d is about.
  if (o.quickBar) {
    node.title.addEventListener('input', h.screen.onInput);
    node.title.addEventListener('keydown', h.screen.onKeydown);
    node.titles.addEventListener('input', h.screen.onInput);
    node.titles.addEventListener('keydown', h.screen.onKeydown);
    node.create.addEventListener('click', h.screen.submit);
    node.bulk.addEventListener('change', h.screen.onBulkToggle);
  }

  return {
    ...h,
    bar: h.screen,
    state,
    calls,
    on,
    node,
    doc,
    win,
    // The tester's own two acts on the bar.
    type: (fieldNode, value) => { fieldNode.value = value; fire(fieldNode, 'input'); },
    switchBulk: (on2) => { node.bulk.checked = on2; fire(node.bulk, 'change'); },
    // The web session answering differently later — it can lapse while the bar is open.
    setJwt: (v) => { o.jwt = v; },
  };
}

// ---------- the quick / bulk create bar (rows 40-63) ----------

test('40: a title is trimmed at the ends and collapsed in the middle, the way the web trims one', () => {
  const h = load();
  h.node.title.value = '  Log   in  ';
  assert.equal(h.bar.title(), 'Log in');
  h.node.title.value = '\tLog\nin\t';
  assert.equal(h.bar.title(), 'Log in');
  h.node.title.value = '   ';
  assert.equal(h.bar.title(), '');
});

test('41: a pasted list keeps its order and its duplicates, and drops only the blank lines', () => {
  const h = load();
  h.node.titles.value = 'a\n\n b \nb';
  assert.deepEqual([...h.bar.lines()], ['a', 'b', 'b']);
});

test('42: a list pasted from a Windows editor loses its carriage returns to the same trim', () => {
  const h = load();
  h.node.titles.value = 'a\r\nb';
  assert.deepEqual([...h.bar.lines()], ['a', 'b']);
});

test('43: an empty quick field has nothing to send, so Create is dead', () => {
  const h = load();
  h.type(h.node.title, '   ');
  assert.deepEqual([...h.bar.titles()], []);
  assert.equal(h.node.create.disabled, true);
  // One real word and the very same button is live.
  h.type(h.node.title, 'Login');
  assert.deepEqual([...h.bar.titles()], ['Login']);
  assert.equal(h.node.create.disabled, false);
});

test('44: a send already on the wire leaves Create dead however much is typed under it', () => {
  const h = load();
  h.type(h.node.title, 'Login');
  assert.equal(h.node.create.disabled, false);
  h.bar.setBusy(true);
  assert.equal(h.node.create.disabled, true);
  h.type(h.node.title, 'Login again');
  assert.equal(h.node.create.disabled, true);
  h.bar.setBusy(false);
  assert.equal(h.node.create.disabled, false);
});

test('45: Bulk takes the typed title with it as the first line, and hands the caret to the list', () => {
  const h = load();
  h.type(h.node.title, 'first');
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first');
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.title.hidden, true);
  assert.equal(h.node.titles.hidden, false);
  assert.equal(h.doc.activeElement, h.node.titles);
  // Nothing was parked on the way in: the round trip brings back that one line and no more.
  h.switchBulk(false);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first');
});

test('45b (#196): a quick field holding nothing but spaces carries no blank first line into Bulk', () => {
  const h = load();
  h.type(h.node.title, '   ');
  h.switchBulk(true);
  assert.equal(h.node.titles.value, '', 'a line of spaces is not a title anybody typed');
  // A padded one IS carried, and arrives trimmed — so the row above is about the emptiness, not
  // about the switch refusing to carry anything.
  h.switchBulk(false);
  h.type(h.node.title, '  first  ');
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first');
});

test('46: the lines the quick field could not show waited in memory for Bulk to come back', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);              // b and c park; the field shows a
  h.type(h.node.title, 'first');    // the tester renames the one line they can see
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'first\nb\nc');
});

test('47: leaving Bulk keeps the first line in the field and parks the rest', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);
  assert.equal(h.node.title.value, 'a');
  assert.equal(h.node.titles.value, '');
  assert.equal(h.node.title.hidden, false);
  assert.equal(h.node.titles.hidden, true);
  assert.equal(h.doc.activeElement, h.node.title);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, 'a\nb\nc', 'b and c really were parked');
});

test('48: leaving an empty Bulk list parks nothing and leaves an empty field', () => {
  const h = load();
  h.switchBulk(true);
  h.switchBulk(false);
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.create.disabled, true);
  h.switchBulk(true);
  assert.equal(h.node.titles.value, '', 'nothing was parked to come back');
});

test('49: Enter in the quick field creates, and the key never reaches the panel', async () => {
  const h = load({ suiteId: 's1' });
  h.type(h.node.title, 'Login');
  const ev = fire(h.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

test('50: a modifier held with Enter in the quick field is somebody elses shortcut', async () => {
  for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    const h = load({ suiteId: 's1' });
    h.type(h.node.title, 'Login');
    const ev = fire(h.node.title, 'keydown', { key: 'Enter', [mod]: true });
    await settle();
    assert.deepEqual(h.calls.createTests, [], mod);
    assert.equal(ev.defaultPrevented, false, mod);
  }
  // The same key with no modifier on it does create.
  const bare = load({ suiteId: 's1' });
  bare.type(bare.node.title, 'Login');
  fire(bare.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(bare.calls.createTests.length, 1);
});

test('51: in Bulk a bare Enter is a newline, not a send', async () => {
  const h = load({ suiteId: 's1' });
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb');
  const ev = fire(h.node.titles, 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.bulks, []);
  assert.equal(ev.defaultPrevented, false);
  // The same key with Cmd held, in the same box, does send it.
  fire(h.node.titles, 'keydown', { key: 'Enter', metaKey: true });
  await settle();
  assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b'] }]);
});

test('52: in Bulk it is Cmd or Ctrl with Enter that sends the list', async () => {
  for (const mod of ['metaKey', 'ctrlKey']) {
    const h = load({ suiteId: 's1' });
    h.switchBulk(true);
    h.type(h.node.titles, 'a\nb');
    const ev = fire(h.node.titles, 'keydown', { key: 'Enter', [mod]: true });
    await settle();
    assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b'] }], mod);
    assert.equal(ev.defaultPrevented, true, mod);
  }
});

test('53: every other key is just typing', async () => {
  const h = load({ suiteId: 's1' });
  h.type(h.node.title, 'Login');
  for (const key of ['a', 'Escape', 'Tab', 'ArrowDown']) {
    const ev = fire(h.node.title, 'keydown', { key });
    assert.equal(ev.defaultPrevented, false, key);
  }
  await settle();
  assert.deepEqual(h.calls.createTests, []);
  // Enter into the very same field does create, so the four above are the key check.
  fire(h.node.title, 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(h.calls.createTests.length, 1);
});

test('54: one title creates one test in the open suite, then the bar clears and the list re-reads', async () => {
  const h = load({ suiteId: 's1' });
  h.type(h.node.title, '  Log   in  ');
  fire(h.node.create, 'click');
  await settle();

  assert.deepEqual(h.calls.createTests, [{ title: 'Log in', suite_id: 's1' }]);
  assert.deepEqual(h.calls.bulks, []);
  assert.equal(h.node.title.value, '');
  // The screen's re-read, asked QUIETLY: the rows are still up, so no placeholder goes over them.
  assert.deepEqual(h.calls.listLoads.map((c) => [c.suiteId, c.opts]), [['s1', { quiet: true }]]);
  assert.deepEqual(h.calls.scrolls, [{ top: 4321 }]);
  assert.equal(h.doc.activeElement, h.node.title, 'the caret goes back for the next title');
  assert.equal(h.node.create.textContent, 'Create');
  // The whole order, once: create, then the query dropped, then the read, then the scroll.
  assert.deepEqual(h.calls.order, ['createTest', 'resetSearch', 'read', 'scroll']);
});

test('55: a whole pasted list is one request, not one per line', async () => {
  const h = load({ suiteId: 's1' });
  h.switchBulk(true);
  h.type(h.node.titles, 'a\n\nb\nc');
  fire(h.node.create, 'click');
  await settle();

  assert.deepEqual(h.calls.bulks, [{ suiteId: 's1', titles: ['a', 'b', 'c'] }]);
  assert.deepEqual(h.calls.createTests, []);
  assert.equal(h.node.titles.value, '');
  assert.deepEqual(h.calls.listLoads.map((c) => [c.suiteId, c.opts]), [['s1', { quiet: true }]]);
  // And what it cleared is really gone: coming back out of Bulk finds nothing parked.
  h.switchBulk(false);
  assert.equal(h.node.title.value, '');
});

test('56: with no suite open there is nothing to create in', async () => {
  const h = load({ suiteId: null });
  h.type(h.node.title, 'Login');
  await h.bar.submit();
  assert.deepEqual(h.calls.createTests, []);
  assert.deepEqual(h.calls.listLoads, []);
  // The identical press once a suite is open does create.
  h.state.tcSuiteId = 's1';
  await h.bar.submit();
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

test('57: a second press while the first create is on the wire sends nothing', async () => {
  const h = load({ suiteId: 's1' });
  const answer = deferred();
  h.on.createTest = () => answer.promise;
  h.type(h.node.title, 'Login');
  const first = h.bar.submit();
  await settle();
  assert.equal(h.node.create.disabled, true);
  await h.bar.submit();
  assert.equal(h.calls.createTests.length, 1);
  answer.resolve({ id: 'made-1' });
  await first;
  // Once it lands the button is live again, and the next press really does go out.
  h.type(h.node.title, 'Logout');
  await h.bar.submit();
  assert.equal(h.calls.createTests.length, 2);
});

test('58: a create the server refused keeps the typed titles, lets the button go and gives the caret back', async () => {
  const h = load({ suiteId: 's1' });
  h.on.createTest = async () => { throw new Error('422 title taken'); };
  h.type(h.node.title, 'Login');
  await h.bar.submit();

  assert.deepEqual(h.calls.toasts, ['422 title taken']);
  assert.equal(h.node.title.value, 'Login');
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.create.disabled, false);
  assert.equal(h.node.create.textContent, 'Create');
  assert.equal(h.doc.activeElement, h.node.title);
  assert.deepEqual(h.calls.listLoads, [], 'nothing was made, so there is nothing to read back');
  // A refusal never drops the query either — the reset is on the success path alone.
  assert.deepEqual(h.calls.order, ['createTest', 'toast']);
});

test('58b: a refused bulk keeps the whole pasted list in the box', async () => {
  const h = load({ suiteId: 's1' });
  h.on.bulk = async () => { throw new Error('Bulk needs a web session'); };
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  await h.bar.submit();
  assert.deepEqual(h.calls.toasts, ['Bulk needs a web session']);
  assert.equal(h.node.titles.value, 'a\nb\nc');
  assert.equal(h.doc.activeElement, h.node.titles);
});

test('59: a live search would hide the very row just made, so it is dropped before the re-read', async () => {
  const h = load({ suiteId: 's1', search: 'checkout' });
  h.type(h.node.title, 'Login');
  await h.bar.submit();

  assert.equal(h.calls.searchResets, 1);
  assert.equal(h.calls.listLoads[0].queryAtRead, '', 'the query was dropped BEFORE the rows came back');
  assert.ok(h.calls.order.indexOf('resetSearch') < h.calls.order.indexOf('read'));
  // What the screen then draws over that cleared query is tests/tc-studio.test.mjs's row 59b.
});

test('60: a suite opened while the create was in flight is not scrolled and does not lose its caret', async () => {
  const h = load({ suiteId: 's1' });
  h.on.createTest = async () => { h.state.tcSuiteId = 's2'; return { id: 'made-1' }; };
  h.type(h.node.title, 'Login');
  await h.bar.submit();
  assert.deepEqual(h.calls.scrolls, []);
  assert.equal(h.doc.activeElement, null);
  // The re-read still goes out, and names the suite the create was FOR — the screen drops it.
  assert.deepEqual(h.calls.listLoads.map((c) => c.suiteId), ['s1']);
  // The same create with the tester still on that suite scrolls to the end and takes the caret back.
  const stayed = load({ suiteId: 's1' });
  stayed.type(stayed.node.title, 'Login');
  await stayed.bar.submit();
  assert.deepEqual(stayed.calls.scrolls, [{ top: 4321 }]);
  assert.equal(stayed.doc.activeElement, stayed.node.title);
});

test('61: a title in flight is still the testers to read — the fields go read-only, not disabled', () => {
  const h = load();
  h.bar.setBusy(true);
  assert.equal(h.node.title.readOnly, true);
  assert.equal(h.node.titles.readOnly, true);
  assert.equal(h.node.title.disabled, false);
  assert.equal(h.node.titles.disabled, false);
  assert.equal(h.node.bulk.disabled, true);
  assert.equal(h.node.create.textContent, 'Creating…');
  h.bar.setBusy(false);
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.titles.readOnly, false);
  assert.equal(h.node.bulk.disabled, false);
  assert.equal(h.node.create.textContent, 'Create');
});

test('62: every suite open starts the bar clean — quick mode, both fields empty, nothing parked', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb\nc');
  h.switchBulk(false);            // b and c are parked
  h.type(h.node.title, 'a');
  h.bar.setBusy(true);

  h.bar.reset();
  assert.equal(h.node.title.value, '');
  assert.equal(h.node.titles.value, '');
  assert.equal(h.node.bulk.checked, false);
  assert.equal(h.node.title.hidden, false);
  assert.equal(h.node.titles.hidden, true);
  assert.equal(h.node.title.readOnly, false);
  assert.equal(h.node.create.textContent, 'Create');
  assert.equal(h.node.create.disabled, true);
  // The parked lines are gone too: Bulk comes back to an empty box.
  h.switchBulk(true);
  assert.equal(h.node.titles.value, '');
});

test('62b (#196): the reset comes back FROM Bulk — the switch is unticked, not merely left alone', () => {
  const h = load();
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb');
  assert.equal(h.node.bulk.checked, true);

  h.bar.reset();
  assert.equal(h.node.bulk.checked, false, 'a ticked switch over a quick field would lie about the mode');
  assert.equal(h.node.title.hidden, false);
  assert.equal(h.node.titles.hidden, true);
  assert.equal(h.node.titles.value, '');
});

test('63: a panel drawn without the bar is not a crash', () => {
  load({ quickBar: false }).bar.reset();
  // Half a bar is not one either — the reset wants both fields before it touches anything.
  const half = load();
  half.type(half.node.title, 'Login');
  half.node.titles.remove();
  half.bar.reset();
  assert.equal(half.node.title.value, 'Login');
  // And with the whole bar in the page it really does clear it, so the two above are not stubs.
  const full = load();
  full.type(full.node.title, 'Login');
  full.bar.reset();
  assert.equal(full.node.title.value, '');
});

test('63e (#196): a bar missing its button or its switch is read, not crashed into', () => {
  const h = load();
  h.type(h.node.title, 'Login');
  assert.equal(h.node.create.disabled, false);
  h.node.create.remove();
  assert.doesNotThrow(() => h.bar.sync(), 'nothing to press is still something to work out');
  h.node.bulk.remove();
  assert.equal(h.bar.bulkOn(), false, 'no switch reads as quick mode');
  assert.deepEqual([...h.bar.titles()], ['Login'], 'so the quick field is still what it would send');
});

// ---------- the switch nobody gates (#263) ----------

test('63b: Bulk is not offered on a token-only connection, and the session is re-asked at submit (#263)', async () => {
  // bulkCreateTests goes through jwtRequest and needs an active web session; createTest does not.
  const none = load({ suiteId: 's1', jwt: false });
  none.bar.reset();
  assert.equal(none.node.bulk.disabled, true);
  assert.match(none.node.bulkLabel.dataset.tip, /web login/);

  // The same bar WITH a session offers it, and keeps its ordinary tip — so the row above is not
  // asserting a switch that is disabled whatever happens.
  const h = load({ suiteId: 's1', jwt: true });
  h.bar.reset();
  assert.equal(h.node.bulk.disabled, false);
  assert.equal(h.node.bulkLabel.dataset.tip, 'Add more');

  // Still probing is not a refusal: an 'unknown' answer must never take the switch away.
  const probing = load({ suiteId: 's1', jwt: 'unknown' });
  probing.bar.reset();
  assert.equal(probing.node.bulk.disabled, false);

  // And the session can lapse after the bar was drawn: the submit asks again and sends nothing.
  h.switchBulk(true);
  h.type(h.node.titles, 'a\nb');
  h.setJwt(false);
  await h.bar.submit();
  assert.deepEqual(h.calls.bulks, []);
  assert.match(h.calls.toasts.at(-1), /web login/);

  // The single-title path never needed the web session and still does not.
  h.switchBulk(false);
  h.type(h.node.title, 'Login');
  await h.bar.submit();
  assert.deepEqual(h.calls.createTests, [{ title: 'Login', suite_id: 's1' }]);
});

// ---------- the seam itself (rows 63c-63d, #196) ----------

test('63c (#196): the page carries the bar and loads it ahead of both callers', () => {
  const html = readFileSync(join(repoRoot, 'extension/sidepanel/index.html'), 'utf8');
  for (const id of ['tc-quick-title', 'tc-quick-titles', 'tc-quick-create', 'tc-quick-bulk']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('screens/tc-quick-bar.js') > 0, 'the module is loaded at all');
  for (const s of ['screens/tc-studio.js', 'app.js']) {
    assert.ok(at('screens/tc-quick-bar.js') < at(s), `screens/tc-quick-bar.js stands before ${s}`);
  }
  // Every name it reads is late-bound, so nothing has to stand before IT — including the screen it
  // calls back into for the re-read. That inversion is deliberate: the tree render owns the screen,
  // this file owns one widget on it, and `loadTcList` resolves under a tester's finger, not at load.
  assert.ok(at('screens/tc-studio.js') > at('screens/tc-quick-bar.js'));
  const globals = /\/\* global ([\s\S]*?)\*\//.exec(raw('tc-quick-bar.js'))[1];
  for (const name of ['loadTcList', 'resetTcSearch']) assert.ok(globals.includes(name), name);
});

test('63d (#196): every call site asks TcQuickBar by name, and nothing answers to the old ones', () => {
  const callers = {
    [join(SCREENS_SRC, 'tc-studio.js')]: 1,
    [join(repoRoot, 'extension/sidepanel/app.js')]: 6, // neither directory — read where it ships
  };
  // Every name the module took, as a CALL: a bare one here throws only under a tester's finger.
  const OLD = /(^|[^.\w])(tcQuickBulkOn|tcQuickTitle|tcQuickLines|tcQuickTitles|tcBulkLock|syncTcQuickCreate|setTcQuickBusy|resetTcQuickBar|onTcQuickBulkToggle|onTcQuickInput|onTcQuickKeydown|submitTcQuick)\s*[(,)]/;
  for (const [f, n] of Object.entries(callers)) {
    const src = readFileSync(f, 'utf8');
    const code = src.replace(/\/\/.*$/gm, ''); // both files name the bar in a comment too
    assert.equal((code.match(/\bTcQuickBar\.\w+/g) || []).length, n, `${f} names TcQuickBar ${n} time(s)`);
    assert.doesNotMatch(code, OLD, `${f} names no bare old name`);
    assert.ok(/\/\* global ([\s\S]*?)\*\//.exec(src)[1].includes('TcQuickBar'), `${f} declares the global`);
  }
  // The two module `let`s are private: a bare assignment in a caller would build a stray global.
  for (const f of Object.keys(callers)) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /(^|[^.\w])(tcQuickParked|tcQuickBusy)\s*=[^=]/, f);
  }
  // app.js hands the fields the methods themselves, unbound — which is only safe because nothing in
  // the module says `this`. One `this.` in there and every keystroke in the bar would throw.
  assert.match(readFileSync(join(repoRoot, 'extension/sidepanel/app.js'), 'utf8'),
    /addEventListener\('click', TcQuickBar\.submit\)/);
  assert.doesNotMatch(raw('tc-quick-bar.js').replace(/\/\/.*$/gm, ''), /\bthis\b/);
});
