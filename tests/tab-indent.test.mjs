#!/usr/bin/env node
// extension/editor/tab-indent.js: Tab / Shift+Tab move the caret's line; Esc then Tab leaves the field.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.TAB_SRC || join(repoRoot, 'extension/editor/tab-indent.js');
const source = readFileSync(SRC, 'utf8');

// A sandbox per row: `document.execCommand` answers what the row says, `Event` is a plain record.
function load({ execCommand = false } = {}) {
  const calls = { exec: [] };
  class Event { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } }
  const document = { execCommand: (...args) => { calls.exec.push(args); return execCommand; } };
  const TabIndent = runInNewContext(`${source}\nTabIndent;`, { document, Event });
  return { TabIndent, calls };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

// The textarea and its host, cut to what the module touches.
function field(value, start, end = start, over = {}) {
  const ta = {
    value, selectionStart: start, selectionEnd: end, readOnly: false, disabled: false,
    inputs: 0, rangeTexts: [], listeners: {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, a, b) { this.rangeTexts.push(text); this.value = this.value.slice(0, a) + text + this.value.slice(b); },
    dispatchEvent(ev) { if (ev.type === 'input') this.inputs += 1; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    ...over,
  };
  const host = { capture: null, addEventListener(type, fn, capture) { if (type === 'keydown') this.capture = { fn, capture }; } };
  return { ta, host };
}

function key(target, k, mods = {}) {
  const e = { target, key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  return e;
}
const press = (host, e) => { host.capture.fn(e); return e; };

// ---- the line arithmetic ----

test('1: Tab indents the whole line the caret is on by two spaces, and the caret rides along', () => {
  const { TabIndent } = load();
  const value = '1. Open\n- Expected: it opens\n2. Next';
  const caret = value.indexOf('Expected') + 3;
  assert.deepEqual(plain(TabIndent.lineEdit(value, caret, false)),
    { start: 8, end: 28, text: '  - Expected: it opens', caret: caret + 2 });
});

test('2: Shift+Tab takes two spaces off, and a caret inside them lands on the line start', () => {
  const { TabIndent } = load();
  const value = 'a\n    - b';
  assert.deepEqual(plain(TabIndent.lineEdit(value, value.length, true)),
    { start: 2, end: 9, text: '  - b', caret: 7 });
  assert.equal(TabIndent.lineEdit(value, 3, true).caret, 2);
});

test('3: a tab or a single space comes off too; a line with no indent is left alone', () => {
  const { TabIndent } = load();
  assert.equal(TabIndent.lineEdit('\t- b', 2, true).text, '- b');
  assert.equal(TabIndent.lineEdit(' - b', 2, true).text, '- b');
  assert.equal(TabIndent.lineEdit('- b', 2, true), null);
});

test('4: the first line, an empty first line and the last line without a newline', () => {
  const { TabIndent } = load();
  assert.deepEqual(plain(TabIndent.lineEdit('\nb', 0, false)), { start: 0, end: 0, text: '  ', caret: 2 });
  assert.deepEqual(plain(TabIndent.lineEdit('a\nb', 3, false)), { start: 2, end: 3, text: '  b', caret: 5 });
  assert.deepEqual(plain(TabIndent.lineEdit('', 0, false)), { start: 0, end: 0, text: '  ', caret: 2 });
});

// ---- the key handling ----

test('5: Tab with a bare caret indents in place, keeps focus and tells the editor', () => {
  const { TabIndent } = load();
  const { ta, host } = field('- a\n- b', 6);
  TabIndent.attach(host, ta);
  assert.equal(host.capture.capture, true, 'capture: before the editor\'s own keydown');
  const e = press(host, key(ta, 'Tab'));
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  assert.equal(ta.value, '- a\n  - b');
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [8, 8]);
  assert.equal(ta.inputs, 1);
});

test('6: Shift+Tab outdents; on a line with nothing to take off it still keeps focus and changes nothing', () => {
  const { TabIndent } = load();
  const { ta, host } = field('  - b', 5);
  TabIndent.attach(host, ta);
  press(host, key(ta, 'Tab', { shiftKey: true }));
  assert.equal(ta.value, '- b');
  assert.equal(ta.selectionStart, 3);
  const e = press(host, key(ta, 'Tab', { shiftKey: true }));
  assert.equal(e.prevented, true);
  assert.equal(ta.value, '- b');
  assert.equal(ta.inputs, 1, 'no input event for a change that did not happen');
});

test('7: a selection is the editor\'s own — the key goes on to it untouched', () => {
  const { TabIndent } = load();
  const { ta, host } = field('- a\n- b', 0, 7);
  TabIndent.attach(host, ta);
  const e = press(host, key(ta, 'Tab'));
  assert.deepEqual([e.prevented, e.stopped], [false, false]);
  assert.equal(ta.value, '- a\n- b');
});

test('8: Esc then Tab leaves the field — even over a selection — and the next Tab indents again', () => {
  const { TabIndent } = load();
  const { ta, host } = field('- a', 3, 3);
  TabIndent.attach(host, ta);
  const esc = press(host, key(ta, 'Escape'));
  assert.deepEqual([esc.prevented, esc.stopped], [false, false], 'Esc still reaches the dialogs');
  ta.selectionStart = 0;
  const out = press(host, key(ta, 'Tab'));
  assert.equal(out.prevented, false, 'the browser moves focus');
  assert.equal(out.stopped, true, 'and the editor does not indent the selection instead');
  assert.equal(ta.value, '- a');
  ta.selectionStart = 3;
  assert.equal(press(host, key(ta, 'Tab')).prevented, true);
  assert.equal(ta.value, '  - a');
});

test('9: any other key between Esc and Tab cancels the way out; Shift alone does not', () => {
  const { TabIndent } = load();
  const { ta, host } = field('- a', 3);
  TabIndent.attach(host, ta);
  press(host, key(ta, 'Escape'));
  press(host, key(ta, 'x'));
  assert.equal(press(host, key(ta, 'Tab')).prevented, true);
  press(host, key(ta, 'Escape'));
  press(host, key(ta, 'Shift', { shiftKey: true }));
  assert.equal(press(host, key(ta, 'Tab', { shiftKey: true })).prevented, false, 'Esc, Shift+Tab goes back out');
});

test('10: leaving the field forgets the Esc', () => {
  const { TabIndent } = load();
  const { ta, host } = field('- a', 3);
  TabIndent.attach(host, ta);
  press(host, key(ta, 'Escape'));
  ta.listeners.blur();
  assert.equal(press(host, key(ta, 'Tab')).prevented, true);
});

test('11: a chord, a read-only field and a key from elsewhere are not ours', () => {
  const { TabIndent } = load();
  for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const { ta, host } = field('- a', 3);
    TabIndent.attach(host, ta);
    assert.equal(press(host, key(ta, 'Tab', mods)).prevented, false, JSON.stringify(mods));
  }
  for (const over of [{ readOnly: true }, { disabled: true }]) {
    const { ta, host } = field('- a', 3, 3, over);
    TabIndent.attach(host, ta);
    assert.equal(press(host, key(ta, 'Tab')).prevented, false, JSON.stringify(over));
    assert.equal(ta.value, '- a');
  }
  const { ta, host } = field('- a', 3);
  TabIndent.attach(host, ta);
  assert.equal(press(host, key({ id: 'title' }, 'Tab')).prevented, false);
});

test('12: the browser\'s insertText carries the edit when it can, so undo keeps the step', () => {
  const { TabIndent, calls } = load({ execCommand: true });
  const { ta, host } = field('- b', 3);
  TabIndent.attach(host, ta);
  press(host, key(ta, 'Tab'));
  assert.deepEqual(plain(calls.exec), [['insertText', false, '  - b']]);
  assert.deepEqual(ta.rangeTexts, [], 'no second write behind it');
  const fallback = load({ execCommand: false });
  const f = field('- b', 3);
  fallback.TabIndent.attach(f.host, f.ta);
  press(f.host, key(f.ta, 'Tab'));
  assert.deepEqual(f.ta.rangeTexts, ['  - b']);
});
