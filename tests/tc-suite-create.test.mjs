#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { loadScreen, SCREENS_SRC, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// A promise this file resolves by hand: the in-flight rows are only about which answer lands second.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const folder = (id, title, children = [], extra = {}) =>
  ({ id, title, file_type: 'folder', children, ...extra });
const file = (id, title, extra = {}) => ({ id, title, file_type: 'file', ...extra });

function load(opts = {}) {
  const o = { expanded: {}, suites: [], ...opts };

  // index.html's shape, cut to the one node this module mounts into.
  const doc = makeDocument([]);
  const node = { tree: el('ul', { id: 'tc-tree' }) };
  doc.body.append(node.tree);

  const calls = {
    order: [],        // one ordered trace, for the rows that assert "before", not merely "both"
    toasts: [],
    tips: [],         // every tip painted, in order
    scrolledInto: 0,  // scrollIntoView on a freshly built row
    treeReads: 0,     // getSuiteTreeOrdered
    createSuites: [],
    renders: [],      // the roots renderSuiteTree was handed
    resets: 0,        // resetTcTreeSearch
    emojiIndex: [],   // the roots handed to rememberSuiteEmoji
  };

  // mini-dom has none, and it is a real act here: the row scrolls itself in.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollIntoView = () => { calls.scrolledInto += 1; };
    return made;
  };

  // Reassignable after load(), so a row can answer the second create differently from the first.
  const on = {
    createSuite: async () => ({ id: 'new-1' }),
    orderedTree: async () => o.serverTree ?? [],
  };

  const state = { tcExpanded: o.expanded, tcSuites: o.suites };

  const globals = {
    state,
    $: (id) => doc.getElementById(id),
    toast: (msg) => { calls.toasts.push(msg); calls.order.push('toast'); },
    // Writes data-tip like the real one, so a tip that lands on the wrong element shows.
    Tooltip: {
      set: (n, tip) => {
        calls.tips.push(tip);
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    StatusIcons: {
      svgIcon: (name) => el('span', { className: 'md-icon', dataset: { icon: name } }),
      treeIcon: (name, cls) => el('span', { className: `tree-icon ${cls}`, dataset: { icon: name } }),
      treeSlot: () => el('span', { className: 'tree-icon' }),
      CHEVRON: 'chevron_right',
      FOLDER: 'tree_folder',
      FILE: 'tree_suite',
    },
    // Recorders: the module is asserted on what it asks for and in which order, not on what gets drawn.
    resetTcTreeSearch: () => { calls.resets += 1; calls.order.push('reset'); },
    rememberSuiteEmoji: (roots) => { calls.emojiIndex.push(plain(roots)); calls.order.push('emoji'); },
    renderSuiteTree: (roots) => { calls.renders.push(plain(roots)); calls.order.push('render'); },
    TestomatAPI: {
      createSuite: async (payload) => {
        calls.createSuites.push(plain(payload));
        calls.order.push('createSuite');
        return on.createSuite(payload);
      },
      getSuiteTreeOrdered: async () => { calls.treeReads += 1; calls.order.push('tree'); return on.orderedTree(); },
    },
  };

  const h = loadScreen('tc-suite-create', { globals, document: doc, exported: 'TcSuiteCreate' });

  return {
    ...h,
    mod: h.screen,
    state,
    calls,
    on,
    node,
    doc,
    newRow: () => doc.querySelector('.tc-new-suite'),
    newInput: () => doc.querySelector('.tc-new-suite .tree-input'),
    // What a folder row's pill does: open the row as the first child of that folder's <ul>.
    mountInto: (ul) => (r) => { ul.prepend(r); r.scrollIntoView({ block: 'nearest' }); },
  };
}

test('68: a blank name is not a suite — the row waits instead of sending it', async () => {
  const h = load();
  h.mod.openRoot('file');
  h.newInput().value = '   ';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.createSuites, []);
  assert.ok(h.newRow(), 'the row stays open for a real name');
  // The same row, a real name, and it goes.
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.createSuites, [{ title: 'Checkout', parentId: null, fileType: 'file' }]);
});

test('69d (#196): a create names the folder as the parent, keeps it open, and re-reads the tree', async () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  h.on.orderedTree = async () => [folder('f1', 'Checkout', [file('new-1', 'Guest checkout')])];
  const kids = el('ul');
  h.node.tree.append(kids);

  // The pair a folder row wears, opening into that folder — screens/tc-studio.js's own call.
  const pills = h.mod.addButtons((fileType) => h.mod.open({
    parentId: 'f1', fileType, mount: h.mountInto(kids),
  }));
  h.node.tree.append(pills);
  fire(h.node.tree.querySelectorAll('button')[0], 'click'); // the "Suite" pill
  h.newInput().value = '  Guest checkout  ';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  assert.deepEqual(h.calls.createSuites, [{ title: 'Guest checkout', parentId: 'f1', fileType: 'file' }]);
  assert.deepEqual([...h.mod.justCreated], ['new-1']);
  assert.equal(h.state.tcExpanded.f1, true);
  assert.equal(h.calls.resets, 1);
  assert.equal(h.calls.treeReads, 1);
  assert.equal(h.calls.emojiIndex.length, 1);
  // Remember the id and drop the filter before the re-read; redraw only once the node is in state.
  assert.deepEqual(h.calls.order, ['createSuite', 'reset', 'tree', 'emoji', 'render']);
  assert.deepEqual(h.calls.renders, [[folder('f1', 'Checkout', [file('new-1', 'Guest checkout')])]]);
  assert.deepEqual(plain(h.state.tcSuites), [folder('f1', 'Checkout', [file('new-1', 'Guest checkout')])]);
});

test('69b: the tick creates the same suite the Enter key does, and a folder row asks for a folder', async () => {
  const h = load({ suites: [folder('f1', 'Checkout')] });
  const kids = el('ul');
  h.node.tree.append(kids);
  const pills = h.mod.addButtons((fileType) => h.mod.open({
    parentId: 'f1', fileType, mount: h.mountInto(kids),
  }));
  h.node.tree.append(pills);
  fire(h.node.tree.querySelectorAll('button')[1], 'click'); // the "Folder" pill
  assert.equal(h.newInput().placeholder, 'Enter folder name');
  h.newInput().value = 'Payments';
  fire(h.newRow().querySelector('.tc-new-suite-ok'), 'click');
  await settle();
  assert.deepEqual(h.calls.createSuites, [{ title: 'Payments', parentId: 'f1', fileType: 'folder' }]);
});

test('70: a create the server refused keeps the row, the typed name and both buttons', async () => {
  const h = load();
  h.on.createSuite = async () => { throw new Error('403 not allowed'); };
  h.mod.openRoot('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  assert.deepEqual(h.calls.toasts, ['403 not allowed']);
  assert.ok(h.newRow());
  assert.equal(h.newInput().value, 'Checkout');
  assert.equal(h.newRow().querySelector('.tc-new-suite-ok').disabled, false);
  assert.equal(h.newRow().querySelector('.tc-new-suite-cancel').disabled, false);
  assert.equal(h.calls.treeReads, 0);
  assert.deepEqual(h.calls.renders, [], 'a refused create redraws nothing');
  assert.deepEqual([...h.mod.justCreated], []);
  // The buttons really are live again: the retry goes out on the same row.
  h.on.createSuite = async () => ({ id: 'new-1' });
  fire(h.newRow().querySelector('.tc-new-suite-ok'), 'click');
  await settle();
  assert.equal(h.calls.createSuites.length, 2);
});

test('71: focus leaving the row while a create is in flight does not take the row away', async () => {
  const h = load();
  const answer = deferred();
  h.on.createSuite = () => answer.promise;
  h.mod.openRoot('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();

  const row = h.newRow().querySelector('.tree-input-row');
  fire(row, 'focusout', { relatedTarget: null });
  assert.ok(h.newRow(), 'a create owns its row until it answers');
  answer.resolve({ id: 'new-1' });
  await settle();

  // With nothing in flight the very same event dismisses the row.
  const idle = load();
  idle.mod.openRoot('file');
  fire(idle.newRow().querySelector('.tree-input-row'), 'focusout', { relatedTarget: null });
  assert.equal(idle.newRow(), null);
});

test('71b: tabbing onto the tick is still inside the row, so the row stays', () => {
  const h = load();
  const outside = el('input', { id: 'tc-tree-search' });
  h.doc.body.append(outside);
  h.mod.openRoot('file');
  const row = h.newRow().querySelector('.tree-input-row');
  fire(row, 'focusout', { relatedTarget: row.querySelector('.tc-new-suite-ok') });
  assert.ok(h.newRow());
  fire(row, 'focusout', { relatedTarget: outside });
  assert.equal(h.newRow(), null);
});

test('72: Escape puts the row away, and so does the cross', () => {
  const h = load();
  h.mod.openRoot('file');
  const ev = fire(h.newInput(), 'keydown', { key: 'Escape' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(h.newRow(), null);

  h.mod.openRoot('file');
  fire(h.newRow().querySelector('.tc-new-suite-cancel'), 'click');
  assert.equal(h.newRow(), null);
});

test('73: only one inline row at a time — opening a second takes the first away', () => {
  const h = load();
  h.mod.openRoot('file');
  const first = h.newRow();
  first.querySelector('.tree-input').value = 'half typed';
  h.mod.openRoot('folder');
  assert.deepEqual(h.node.tree.querySelectorAll('.tc-new-suite').length, 1);
  assert.notEqual(h.newRow(), first);
  assert.equal(h.newInput().value ?? '', '');
  assert.equal(h.newInput().placeholder, 'Enter folder name');
});

test('73b: the row mounts at the top of the tree and scrolls itself into view', () => {
  const h = load();
  h.node.tree.append(el('li', { className: 'tc-item' }));
  const before = h.calls.scrolledInto;
  h.mod.openRoot('file');
  assert.equal(h.node.tree.children[0].className.includes('tc-new-suite'), true);
  assert.equal(h.calls.scrolledInto, before + 1);
  assert.equal(h.doc.activeElement, h.newInput());
});

test('68b (#196): a create that answers no id still lands — the row goes, the tree comes back', async () => {
  const h = load();
  const name = async (title) => {
    h.mod.openRoot('file');
    h.newInput().value = title;
    fire(h.newInput(), 'keydown', { key: 'Enter' });
    await settle();
  };
  h.on.createSuite = async () => undefined; // an older instance answering 204
  await name('Checkout');
  assert.deepEqual([...h.mod.justCreated], [], 'nothing to hoist without an id');
  assert.deepEqual(h.calls.order, ['createSuite', 'reset', 'tree', 'emoji', 'render']);
  // An object with no id is the same nothing: `'undefined'` in the hoist list would pin a stray row.
  h.on.createSuite = async () => ({ title: 'Checkout' });
  await name('Checkout');
  assert.deepEqual([...h.mod.justCreated], []);
  // …and an answer that does carry one puts it at the head, newest first.
  h.on.createSuite = async () => ({ id: 7 });
  await name('Payments');
  assert.deepEqual([...h.mod.justCreated], ['7'], 'and stringified, the way the tree compares ids');
});

// The array is what the tree is hoisted by, so its order is the order they ride at the top in.
test('69e (#196): a second suite made this visit goes ahead of the first, not behind it', async () => {
  const h = load();
  for (const [id, title] of [['a1', 'Alpha'], ['b2', 'Beta'], ['c3', 'Gamma']]) {
    h.on.createSuite = async () => ({ id });
    h.mod.openRoot('file');
    h.newInput().value = title;
    fire(h.newInput(), 'keydown', { key: 'Enter' });
    await settle();
  }
  assert.deepEqual([...h.mod.justCreated], ['c3', 'b2', 'a1']);
  assert.deepEqual(h.calls.createSuites.map((c) => c.title), ['Alpha', 'Beta', 'Gamma']);
});

test('68c (#196): a root create expands nothing — there is no parent to keep open', async () => {
  const h = load();
  h.mod.openRoot('folder');
  h.newInput().value = 'Payments';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(h.calls.createSuites, [{ title: 'Payments', parentId: null, fileType: 'folder' }]);
  assert.deepEqual(h.state.tcExpanded, {});
});

test('70b (#196): Enter pressed twice sends one create, not two', async () => {
  const h = load();
  const answer = deferred();
  h.on.createSuite = () => answer.promise;
  h.mod.openRoot('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.equal(h.newRow().querySelector('.tc-new-suite-ok').disabled, true, 'the tick is out too');
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  fire(h.newRow().querySelector('.tc-new-suite-ok'), 'click');
  await settle();
  assert.equal(h.calls.createSuites.length, 1);
  answer.resolve({ id: 'new-1' });
  await settle();
});

test('72b (#196): Enter is taken from the page, and every other key is left to the field', () => {
  const h = load();
  h.mod.openRoot('file');
  h.newInput().value = 'Checkout';
  assert.equal(fire(h.newInput(), 'keydown', { key: 'Enter' }).defaultPrevented, true);
  // The row survived the create it just sent, so the same field answers the next key.
  assert.equal(fire(h.newInput(), 'keydown', { key: 'a' }).defaultPrevented, false);
  assert.equal(fire(h.newInput(), 'keydown', { key: ' ' }).defaultPrevented, false);
  assert.ok(h.newRow(), 'and no other key dismissed it');
});

test('73c (#196): close() with nothing open is a no-op, and it really sweeps the whole document', () => {
  const h = load();
  h.mod.close();
  assert.equal(h.newRow(), null);
  // A row outside the tree — the sweep is document-wide on purpose, not scoped to #tc-tree.
  const elsewhere = el('ul');
  h.doc.body.append(elsewhere);
  h.mod.open({ parentId: null, fileType: 'file', mount: (r) => elsewhere.prepend(r) });
  assert.ok(h.newRow());
  h.mod.close();
  assert.equal(h.newRow(), null);
  assert.deepEqual(h.doc.querySelectorAll('.tc-new-suite'), []);
});

test('73d (#196): the row is a named field between a type mark and two labelled buttons', () => {
  const h = load();
  h.mod.openRoot('folder');
  const row = h.newRow().querySelector('.tree-input-row');
  const input = h.newInput();
  assert.equal(input.type, 'text');
  assert.equal(input.autocomplete, 'off');
  assert.equal(input.getAttribute('aria-label'), 'New folder name');
  assert.equal(row.querySelector('.tc-new-suite-ok').getAttribute('aria-label'), 'Create folder');
  assert.deepEqual(h.calls.tips, ['Create folder', 'Cancel']);
  // A folder carries a chevron of its own; a suite gets the empty slot that lines the titles up.
  assert.equal(row.children[0].className, 'tree-icon chevron');
  assert.equal(row.children[1].dataset.icon, 'tree_folder');

  const s = load();
  s.mod.openRoot('file');
  const srow = s.newRow().querySelector('.tree-input-row');
  assert.equal(s.newInput().placeholder, 'Enter suite name');
  assert.equal(s.newInput().getAttribute('aria-label'), 'New suite name');
  assert.equal(srow.querySelector('.tc-new-suite-ok').getAttribute('aria-label'), 'Create suite');
  assert.equal(srow.children[0].className, 'tree-icon');
  assert.equal(srow.children[1].dataset.icon, 'tree_suite');
});

test('73e (#196): the tick and the cross hold the fields focus, or their own click would never land', () => {
  const h = load();
  h.mod.openRoot('file');
  const row = h.newRow().querySelector('.tree-input-row');
  for (const cls of ['.tc-new-suite-ok', '.tc-new-suite-cancel']) {
    assert.equal(fire(row.querySelector(cls), 'mousedown').defaultPrevented, true, cls);
  }
});

test('73f (#196): the pair wears the hover pill by default, and whatever class the caller names', () => {
  const h = load();
  const opened = [];
  const frag = h.mod.addButtons((fileType) => opened.push(fileType));
  const box = el('div');
  box.append(frag);
  const pair = box.querySelectorAll('button');
  assert.deepEqual(pair.map((b) => b.textContent), ['Suite', 'Folder']);
  assert.deepEqual(pair.map((b) => b.className), ['btn size-xs tc-new', 'btn size-xs tc-new']);
  assert.deepEqual(h.calls.tips, ['New test suite here', 'New folder here']);
  // A click opens for the file type its own button carries, and never reaches the row underneath.
  const ev = fire(pair[1], 'click');
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(opened, ['folder']);

  // The empty state's skin: same pair, the class it asked for.
  const other = el('div');
  other.append(h.mod.addButtons(() => {}, 'btn size-sm tc-add'));
  assert.deepEqual(other.querySelectorAll('button').map((b) => b.className),
    ['btn size-sm tc-add', 'btn size-sm tc-add']);
});

// Assert the identity: a copy would clear nothing and no other row would notice.
test('73g (#196): justCreated is one array — the screen clears what this module writes', async () => {
  const h = load();
  const shared = h.mod.justCreated;
  h.on.createSuite = async () => ({ id: 'new-1' });
  h.mod.openRoot('file');
  h.newInput().value = 'Checkout';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual([...shared], ['new-1'], 'the submit wrote to the array the caller holds');
  assert.equal(h.mod.justCreated, shared, 'and never swapped it for another');

  // openTcStudioView's own line, spelled from outside the module.
  h.mod.justCreated.length = 0;
  assert.deepEqual([...shared], []);

  // The next create writes to that same array again, so the clearing was not a swap either.
  h.mod.openRoot('file');
  h.newInput().value = 'Payments';
  fire(h.newInput(), 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual([...shared], ['new-1']);
  assert.equal(h.mod.justCreated, shared);
});

const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('73h (#196): index.html loads the module before both of its callers', () => {
  const html = read('extension/sidepanel/index.html');
  const at = (src) => html.indexOf(`src="${src}"`);
  assert.ok(at('screens/tc-suite-create.js') > 0, 'the page loads it at all');
  assert.ok(at('screens/tc-suite-create.js') < at('screens/tc-studio.js'), 'before the screen that draws its buttons');
  assert.ok(at('screens/tc-suite-create.js') < at('app.js'), 'before the init that opens it at the root');
  assert.ok(at('core/status-icons.js') < at('screens/tc-suite-create.js'), 'after the glyphs it draws with');
  // The root pair app.js wires, and the list the row mounts into.
  for (const id of ['tc-add-suite-root', 'tc-add-folder-root', 'tc-tree']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }

  // Its callbacks load after this module, which works only because nothing here runs at load.
  const studio = read('extension/sidepanel/screens/tc-studio.js');
  for (const back of ['function renderSuiteTree(', 'function resetTcTreeSearch(']) {
    assert.ok(studio.includes(back), back);
  }
  const bare = runInNewContext(`${readFileSync(join(SCREENS_SRC, 'tc-suite-create.js'), 'utf8')}\nTcSuiteCreate;`, {});
  assert.deepEqual(Object.keys(bare).sort(), ['addButtons', 'close', 'justCreated', 'open', 'openRoot']);
  // Built in the other realm, so compare it as plain JSON — never by identity or deepStrictEqual.
  assert.deepEqual(plain(bare.justCreated), []);
});

test('73i (#196): nothing answers to the five old names, and every caller names the module instead', () => {
  const mod = readFileSync(join(SCREENS_SRC, 'tc-suite-create.js'), 'utf8');
  const studio = read('extension/sidepanel/screens/tc-studio.js');
  const app = read('extension/sidepanel/app.js');
  for (const gone of ['tcJustCreated', 'closeSuiteInput', 'openSuiteInput', 'suiteAddButtons', 'openRootSuiteInput']) {
    for (const [where, src] of [['the module', mod], ['tc-studio.js', studio], ['app.js', app]]) {
      assert.equal(src.includes(gone), false, `${gone} still in ${where}`);
    }
  }
  // An object literal, not top-level functions: those land on globalThis and would keep old names alive.
  assert.equal(/^function /m.test(mod), false);
  assert.equal(/\bthis\b/.test(mod), false, 'no `this`, so app.js may hand openRoot around unbound');
  assert.equal(studio.match(/TcSuiteCreate\./g).length, 8);
  assert.equal(app.match(/TcSuiteCreate\./g).length, 2);
  for (const [where, src] of [['tc-studio.js', studio], ['app.js', app]]) {
    assert.ok(/\/\* global[^*]*TcSuiteCreate/s.test(src), `${where} declares the global`);
  }
});
