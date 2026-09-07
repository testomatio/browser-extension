// The panel's scripts reach their markup by id, and only the browser notices when an id has nothing
// behind it: `$()` answers null and the screen quietly paints nothing. Read the shipped index.html
// and every script it loads, and hold the two together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelDir = join(repoRoot, 'extension/sidepanel');
const html = readFileSync(join(panelDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('review C P2-2 (1): every <script> tag in index.html names a file that exists', () => {
  assert.ok(scripts.length > 50, `${scripts.length} script tags read`);
  const missing = scripts.filter((s) => !existsSync(join(panelDir, s)));
  assert.deepEqual(missing, []);
});

test('review C P2-2 (2): every id a loaded script asks $() for is declared in index.html', () => {
  assert.ok(ids.size > 200, `${ids.size} ids read`);
  const misses = [];
  let seen = 0;
  for (const s of scripts) {
    const file = join(panelDir, s);
    if (!existsSync(file)) continue; // (1) reports that one
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\$\('([^']+)'\)/g)) {
      seen += 1;
      if (!ids.has(m[1])) misses.push(`${s}: ${m[1]}`);
    }
  }
  assert.ok(seen > 300, `${seen} literal lookups read`);
  assert.deepEqual(misses, []);
});
