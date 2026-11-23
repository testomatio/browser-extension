#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, SCREENS_SRC, makeDocument, el, fire } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// index.html belongs to neither switchable directory, so it is read where it ships.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

// Only the dialog nodes: this module reads no state, no API and no screen.
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
  // mini-dom has no <dialog>: ask() drives showModal, open and close, so they are stubbed here.
  const order = []; // one ordered trace, for the rows that assert "before", not merely "both"
  const dlg = node.confirmDialog;
  dlg.open = false;
  dlg.showModal = () => { dlg.open = true; order.push('showModal'); };
  dlg.close = () => { dlg.open = false; order.push('close'); };
  // Every wiring in order: a teardown removing the wrong handler keeps the count, only names differ.
  for (const [name, n] of Object.entries(node)) {
    const [add, remove] = [n.addEventListener.bind(n), n.removeEventListener.bind(n)];
    n.addEventListener = (type, fn, opts) => { order.push(`+${name}:${type}`); return add(type, fn, opts); };
    n.removeEventListener = (type, fn, opts) => { order.push(`-${name}:${type}`); return remove(type, fn, opts); };
  }

  const h = loadScreen('dialog', {
    dir: CORE_SRC,
    document: doc,
    globals: { $: (id) => doc.getElementById(id) },
    // ConfirmDialog is a lexical const, reachable only off the completion value, not off the sandbox.
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

// showModal() throws on an open <dialog>; called after the wiring, that throw would leak listeners.
test('135: the dialog is shown before a single listener goes on', () => {
  const h = load();
  h.d.ask('Sign out?', 'Sign out');
  assert.deepEqual(h.order, ['showModal', '+confirmOk:click', '+confirmCancel:click', '+confirmDialog:cancel']);
  fire(h.node.confirmCancel, 'click');
  assert.deepEqual(h.order.slice(4), ['-confirmOk:click', '-confirmCancel:click', '-confirmDialog:cancel', 'close']);
});

// close() on an already-closed dialog fires a second close event, e.g. after the browser's own Esc.
test('136: a dialog already closed when the answer lands is not closed a second time', async () => {
  const h = load();
  const answer = h.d.ask('Finish run? Pending tests will be marked skipped.');
  h.node.confirmDialog.open = false; // closed out from under the pending ask
  fire(h.node.confirmOk, 'click');
  assert.equal(await answer, true, 'the answer still gets through');
  assert.deepEqual(h.order.filter((o) => o === 'close'), [], 'and nothing was closed twice');
  assert.deepEqual(wired(h), [0, 0, 0], 'the listeners came off all the same');
});

// The ids are late-bound: a renamed one throws only on use, and the fixture would keep passing.
test('137: the page carries the four nodes this module reaches for, and loads it before every caller', () => {
  const html = raw(repoRoot, 'extension/sidepanel/index.html');
  for (const id of ['confirm-dialog', 'confirm-message', 'confirm-ok', 'confirm-cancel']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('core/dialog.js') > 0, 'the module is loaded at all');
  // Callers only use it at runtime, but a core module must still load before its screens.
  for (const s of ['screens/settings-erase.js', 'screens/run-lock.js', 'screens/attachments.js']) {
    assert.ok(at('core/dialog.js') < at(s), `core/dialog.js stands before ${s}`);
  }
});

// The settings call sites run in no row above, so they are checked as text.
test('138: all four call sites ask ConfirmDialog by name, the unsuited settings screen included', () => {
  const callers = { 'run-lock.js': 1, 'settings-erase.js': 2, 'attachments.js': 1 };
  for (const [file, n] of Object.entries(callers)) {
    const src = raw(SCREENS_SRC, file);
    assert.equal(src.split('ConfirmDialog.ask(').length - 1, n, `${file} has ${n} call site(s)`);
    // The file's own `/* global … */` block, not merely the name somewhere in the file.
    assert.ok(/\/\* global ([\s\S]*?)\*\//.exec(src)[1].includes('ConfirmDialog'), `${file} declares the global`);
    assert.doesNotMatch(src, /\bconfirmDialog\b/, `${file} keeps no bare confirmDialog`);
  }
  assert.doesNotMatch(raw(CORE_SRC, 'dialog.js'), /\bconfirmDialog\b/);
});
