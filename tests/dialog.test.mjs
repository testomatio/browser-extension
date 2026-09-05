#!/usr/bin/env node
// The one confirm dialog of extension/sidepanel/core/dialog.js (rows 81 and 81a, moved out of
// tests/run-view.test.mjs by #194): the sentence a tester reads before Finish run, Sign out, Erase
// an instance or Delete an attachment, and the promise that carries their answer back.
// The whole point is that "no" has three spellings — the Cancel button, Esc and a click on the
// backdrop — and all three have to mean the same no; a dialog that answered true to any of them
// would finish a run nobody agreed to finish. And the listeners are per-ASK: three go on at the top
// and the same three come off on the way out, or the second confirm resolves the first one too.
// Rows 134-138 are new: the falsification run behind the move found the OK button, the caller's own
// label, the already-closed guard and the whole settings screen pinned nowhere — every caller's
// suite stubs this away, and screens/settings.js has no suite at all.
// Run: node --test tests/dialog.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, SCREENS_SRC, makeDocument, el, fire } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The two switchable directories, so rows 137-138 read whatever CORE_SRC / SCREENS_SRC point at;
// index.html belongs to neither and is read where it ships, as tests/views.test.mjs:323 reads it.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

// index.html:818-824 — the dialog, its message, and the two buttons. Nothing else: this module
// reads no state, no API and no screen.
const NODES = [['dialog', 'confirm-dialog'], ['p', 'confirm-message'],
  ['button', 'confirm-ok'], ['button', 'confirm-cancel']];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function load() {
  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id] of NODES) {
    node[key(id)] = el(tag, { id });
    doc.body.append(node[key(id)]);
  }
  // <dialog>'s own three members; mini-dom has no dialog element, and ask() drives all of
  // them — showModal to open it, `open` to decide whether close() is still needed.
  const order = []; // one ordered trace, for the rows that assert "before", not merely "both"
  const dlg = node.confirmDialog;
  dlg.open = false;
  dlg.showModal = () => { dlg.open = true; order.push('showModal'); };
  dlg.close = () => { dlg.open = false; order.push('close'); };
  // Every wiring in order, not merely a count: a teardown that removes the wrong handler leaves the
  // count right and the listener on, and only the names tell those two apart.
  for (const [name, n] of Object.entries(node)) {
    const [add, remove] = [n.addEventListener.bind(n), n.removeEventListener.bind(n)];
    n.addEventListener = (type, fn, opts) => { order.push(`+${name}:${type}`); return add(type, fn, opts); };
    n.removeEventListener = (type, fn, opts) => { order.push(`-${name}:${type}`); return remove(type, fn, opts); };
  }

  const h = loadScreen('dialog', {
    dir: CORE_SRC,
    document: doc,
    globals: { $: (id) => doc.getElementById(id) },
    // ConfirmDialog is a lexical const: invisible as a sandbox property, reachable only off the
    // completion value, the same seam tests/md-sections.test.mjs uses.
    exported: 'ConfirmDialog',
  });
  return { d: h.screen, node, doc, order };
}

// The three live wirings a pending ask() holds, and none once it has answered.
const wired = (h) => [
  h.node.confirmOk.listeners.get('click')?.length ?? 0,
  h.node.confirmCancel.listeners.get('click')?.length ?? 0,
  h.node.confirmDialog.listeners.get('cancel')?.length ?? 0,
];

// ---------- the sentence and the two buttons (rows 81, 81a) ----------

test('81: the dialog wears the message and the label, and lets go of both buttons on the way out', async () => {
  const h = load();
  const answer = h.d.ask('Finish run? Pending tests will be marked skipped.');
  assert.equal(h.node.confirmMessage.textContent, 'Finish run? Pending tests will be marked skipped.');
  assert.equal(h.node.confirmOk.textContent, 'Finish run', 'the default label');
  assert.equal(h.node.confirmDialog.open, true);
  assert.deepEqual(wired(h), [1, 1, 1]);
  fire(h.node.confirmCancel, 'click');
  assert.equal(await answer, false, 'Cancel is a no');
  assert.deepEqual(wired(h), [0, 0, 0], 'torn down');
  assert.equal(h.node.confirmDialog.open, false, 'and closed');
});

test('81a: Esc on the dialog reads as a cancel, not as a confirmation', async () => {
  const h = load();
  const answer = h.d.ask('Finish run? Pending tests will be marked skipped.');
  // Esc and a click on the backdrop reach a <dialog> as the same one event.
  fire(h.node.confirmDialog, 'cancel');
  assert.equal(await answer, false);
  assert.deepEqual(wired(h), [0, 0, 0], 'and it let go of all three');
  assert.equal(h.node.confirmDialog.open, false);
});

// ---------- what nothing else pinned (rows 134-136) ----------

// 134: the four callers each stub this module in their own suite, so before this row nothing drove
// the OK button through the real code — the answer a tester CONSENTS to was pinned nowhere.
test('134: OK answers true, and a caller\'s own word replaces the default label', async () => {
  const h = load();
  const answer = h.d.ask('Delete shot.png? It is removed from this result for everyone.', 'Delete');
  assert.equal(h.node.confirmMessage.textContent, 'Delete shot.png? It is removed from this result for everyone.');
  assert.equal(h.node.confirmOk.textContent, 'Delete', 'not the Finish run default');
  fire(h.node.confirmOk, 'click');
  assert.equal(await answer, true);
  assert.deepEqual(wired(h), [0, 0, 0], 'the same three come off on this exit too');
  assert.equal(h.node.confirmDialog.open, false);
});

// 135: showModal() can throw — a <dialog> already open answers InvalidStateError. Called BEFORE the
// promise exists, that throw reaches the caller with nothing wired; called after, three listeners leak.
test('135: the dialog is shown before a single listener goes on', () => {
  const h = load();
  h.d.ask('Sign out?', 'Sign out');
  assert.deepEqual(h.order, ['showModal', '+confirmOk:click', '+confirmCancel:click', '+confirmDialog:cancel']);
  fire(h.node.confirmCancel, 'click');
  // Each name comes off the node it went on: a teardown removing the wrong handler counts the same.
  assert.deepEqual(h.order.slice(4), ['-confirmOk:click', '-confirmCancel:click', '-confirmDialog:cancel', 'close']);
});

// 136: the guard is not decoration — a dialog can be gone before the answer lands (the browser's own
// Esc closes it, a colleague's screen change unmounts it), and close() on a closed one is a second
// `close` event the panel never asked for.
test('136: a dialog already closed when the answer lands is not closed a second time', async () => {
  const h = load();
  const answer = h.d.ask('Finish run? Pending tests will be marked skipped.');
  h.node.confirmDialog.open = false; // closed out from under the pending ask
  fire(h.node.confirmOk, 'click');
  assert.equal(await answer, true, 'the answer still gets through');
  assert.deepEqual(h.order.filter((o) => o === 'close'), [], 'and nothing was closed twice');
  assert.deepEqual(wired(h), [0, 0, 0], 'the listeners came off all the same');
});

// ---------- the wiring no suite could see (rows 137-138) ----------

// The four ids are late-bound: a renamed one throws only when a tester presses Finish run, and the
// fixture above would go on passing. index.html is read raw — no fixture stands in for it.
test('137: the page carries the four nodes this module reaches for, and loads it before every caller', () => {
  const html = raw(repoRoot, 'extension/sidepanel/index.html');
  for (const id of ['confirm-dialog', 'confirm-message', 'confirm-ok', 'confirm-cancel']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('core/dialog.js') > 0, 'the module is loaded at all');
  // settings.js is the earliest of the three, and every one of them calls at runtime anyway —
  // but a core module standing after its screens is the load-order inversion #194 came to remove.
  for (const s of ['screens/settings.js', 'screens/run-view.js', 'screens/attachments.js']) {
    assert.ok(at('core/dialog.js') < at(s), `core/dialog.js stands before ${s}`);
  }
});

// 138: screens/settings.js has no suite in this repo, so its two call sites — Erase instance and
// Sign out, the panel's two most destructive acts — are reachable by NO row above. Read as text,
// they are: a bare `confirmDialog` there would sail through the whole test run.
test('138: all four call sites ask ConfirmDialog by name, the unsuited settings screen included', () => {
  const callers = { 'run-view.js': 1, 'settings.js': 2, 'attachments.js': 1 };
  for (const [file, n] of Object.entries(callers)) {
    const src = raw(SCREENS_SRC, file);
    assert.equal(src.split('ConfirmDialog.ask(').length - 1, n, `${file} has ${n} call site(s)`);
    // The file's own `/* global … */` block, not merely the name somewhere in the file.
    assert.ok(/\/\* global ([\s\S]*?)\*\//.exec(src)[1].includes('ConfirmDialog'), `${file} declares the global`);
    assert.doesNotMatch(src, /\bconfirmDialog\b/, `${file} keeps no bare confirmDialog`);
  }
  // And nothing declares one either: the module is the only home the name has now.
  assert.doesNotMatch(raw(CORE_SRC, 'dialog.js'), /\bconfirmDialog\b/);
});
