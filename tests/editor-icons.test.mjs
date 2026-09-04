#!/usr/bin/env node
// The editor page's glyph names live in one file so two screens cannot drift onto different
// glyphs (#192). Run: node --test tests/editor-icons.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.EDICONS_SRC || join(repoRoot, 'extension/editor/editor-icons.js');

// `icon` closes over the page's Icons global, so the sandbox carries a spy for it.
function load() {
  const calls = [];
  const sandbox = { Icons: { markup: (...a) => { calls.push(a); return `<i>${a[0]}</i>`; } } };
  const EditorIcons = runInNewContext(`${readFileSync(SRC, 'utf8')}\nEditorIcons;`, sandbox);
  return { EditorIcons, calls };
}

test('every glyph the editor draws is named here, and nowhere else', () => {
  const { EditorIcons } = load();
  assert.deepEqual(Object.keys(EditorIcons).sort(), [
    'ICON_ADD', 'ICON_BACK', 'ICON_CAMERA', 'ICON_CLOSE', 'ICON_EDIT', 'ICON_ERROR', 'ICON_FOLD',
    'ICON_MARKDOWN', 'ICON_MINUS', 'ICON_OPEN_IN_NEW', 'ICON_PREVIEW', 'ICON_RECORD', 'ICON_STOP',
    'ICON_TEMPLATE', 'icon',
  ]);
  // The four the parameters grid draws, pinned by value: params-grid.js held its own copies of
  // these until they drifted apart was a real possibility (#192 PR 2).
  assert.equal(EditorIcons.ICON_CLOSE, 'close');
  assert.equal(EditorIcons.ICON_ADD, 'add');
  assert.equal(EditorIcons.ICON_MINUS, 'remove');
  assert.equal(EditorIcons.ICON_FOLD, 'chevron_right');
});

test('icon() draws at 20px unless a size is asked for', () => {
  const { EditorIcons, calls } = load();
  assert.equal(EditorIcons.icon('add'), '<i>add</i>');
  assert.deepEqual([...calls[0]], ['add', 20]);
  EditorIcons.icon('close', 16);
  assert.deepEqual([...calls[1]], ['close', 16]);
});
