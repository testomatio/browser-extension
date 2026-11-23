#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The module and the three globals it names — nothing else: it reads no state, no API and no $.
function load() {
  const doc = makeDocument([]);
  // spinnerEl() builds its two circles in the SVG namespace; mini-dom has one namespace only.
  doc.createElementNS = (ns, tag) => {
    const made = doc.createElement(tag);
    made.dataset.ns = ns;
    return made;
  };
  const marks = []; // every TestType.mark call, so a badge row can assert what was asked for
  const icons = []; // every Icons.el call as it arrived, so a row can assert the arguments

  const globals = {
    // Like the real el, one classList token per argument: the real one throws on a token with a space.
    Icons: {
      el: (name, size = 16, ...cls) => {
        icons.push({ name, size, cls: [...cls] });
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        for (const c of cls.filter(Boolean)) {
          if (/\s/.test(String(c))) throw new Error(`svgIcon: "${c}" is not one class token — classList.add throws on that`);
          n.classList.add(c);
        }
        return n;
      },
      // As in shared/icons.js: an empty value or an unresolved `:shortcode:` draws nothing.
      emoji: (value, cls = '') => {
        const s = String(value || '').trim();
        if (!s || /^:[a-z0-9_+-]+:$/i.test(s)) return null;
        const span = doc.createElement('span');
        span.className = `${cls} emoji`.trim();
        span.textContent = s;
        return span;
      },
    },
    // Writes data-tip like the real one, so a tip that lands on the wrong element shows.
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    TestType: {
      mark: (kind, opts) => {
        marks.push({ kind, text: !!(opts && opts.text) });
        return el('span', { className: 'type-mark', dataset: { kind, text: String(!!(opts && opts.text)) } });
      },
    },
  };

  const h = loadScreen('status-icons', { dir: CORE_SRC, document: doc, globals, exported: 'StatusIcons' });
  // StatusIcons is a lexical const, reachable only off the completion value, not as a sandbox property.
  return { i: h.screen, doc, marks, icons, globals };
}

// The real glyph table: a name that resolves to nothing draws an empty box no fixture would notice.
const PATHS = (() => {
  const win = {};
  runInNewContext(readFileSync(join(repoRoot, 'extension/shared/icons.js'), 'utf8'), { window: win });
  return win.Icons.PATHS;
})();

test('1: a launching run reads as running, and nothing at all reads as unknown', () => {
  const h = load();
  assert.equal(h.i.normStatus('launching'), 'running');
  assert.equal(h.i.normStatus(''), 'unknown');
  assert.equal(h.i.normStatus(undefined), 'unknown');
  assert.equal(h.i.normStatus('passed'), 'passed');
});

test('46 (#115): skipped and pending are told apart by their shape, not only their colour', () => {
  const h = load();
  const skipped = h.i.statusIcon('skipped');
  assert.notEqual(skipped.dataset.icon, h.i.statusIcon('pending').dataset.icon);
  assert.equal(skipped.dataset.icon, 'block');
  // The crossed ring fills the same 16px slot as the plain ring; the tint keys on data-status.
  assert.equal(skipped.dataset.size, '16');
  assert.equal(skipped.dataset.status, 'skipped');
  assert.ok(skipped.classList.contains('status-icon'));

  // The four never-run states share one ring; splitting skipped out must not tell them apart.
  const ring = ['pending', 'scheduled', 'queued', 'unknown'].map((s) => h.i.statusIcon(s).dataset.icon);
  assert.deepEqual(ring, Array(4).fill('status_record'));
  assert.ok(!ring.includes(skipped.dataset.icon), 'skipped fell back to the ring');
});

test('85: a running test draws the two-circle ring, not a glyph — and both measure the same slot', () => {
  const h = load();
  const spinner = h.i.statusIcon('launching');
  assert.equal(spinner.className, 'spinner');
  assert.equal(spinner.dataset.status, 'running', 'launching folds into running here too');
  assert.equal(spinner.dataset.tip, 'running');
  assert.deepEqual(spinner.children.map((c) => c.className), ['spinner-track', 'spinner-head']);
  assert.equal(spinner.children[1].getAttribute('stroke-dasharray'), '25 75');
  assert.equal(spinner.children[0].getAttribute('stroke-dasharray'), null);
  // Every other status is a glyph, so the ring branch is a decision, not the only path.
  const glyph = h.i.statusIcon('passed');
  assert.equal(glyph.dataset.icon, 'status_passed');
  assert.ok(glyph.classList.contains('status-icon'));
  assert.equal(glyph.dataset.status, 'passed');
});

test('87: a project emoji replaces the suite glyph and says so through data-emoji', () => {
  const h = load();
  const plainIcon = h.i.treeIcon('tree_suite', 'file-icon', null);
  assert.equal(plainIcon.className, 'tree-icon file-icon');
  assert.equal(plainIcon.dataset.emoji, undefined);
  assert.equal(plainIcon.children[0].dataset.icon, 'tree_suite');
  const marked = h.i.treeIcon('tree_suite', 'file-icon', '🔥');
  assert.equal(marked.dataset.emoji, '🔥');
  assert.equal(marked.textContent, '🔥');
  // An unresolved shortcode is not a mark — it falls back to the glyph, carrying no data-emoji.
  const shortcode = h.i.treeIcon('tree_suite', 'file-icon', ':fire:');
  assert.equal(shortcode.dataset.emoji, undefined);
  assert.equal(shortcode.children[0].dataset.icon, 'tree_suite');
});

test('88: an unfoldable row keeps the empty slot, so its title lines up with a foldable sibling', () => {
  const h = load();
  const slot = h.i.treeSlot();
  assert.equal(slot.className, 'tree-icon');
  assert.deepEqual(slot.childNodes, []);
});

test('86: three kinds are a run kind; a rungroup\'s own kind draws no badge', () => {
  const h = load();
  for (const k of ['manual', 'AUTOMATED', 'Mixed']) assert.equal(h.i.runKind(k), k.toLowerCase());
  for (const k of ['multienv', '', null, undefined, 5]) assert.equal(h.i.runKind(k), null, String(k));
  const badge = h.i.kindBadge('mixed');
  assert.equal(badge.dataset.kind, 'mixed');
  assert.equal(badge.dataset.text, 'true', 'the header badge carries its word');
  assert.equal(badge.dataset.tip, 'mixed run');
  assert.equal(h.i.kindBadge('multienv'), null);
});

test('132: the vocabulary is these eight names, and every one resolves to a real glyph', () => {
  const h = load();
  assert.deepEqual(plain(h.i.STATUS), {
    passed: 'status_passed', failed: 'status_failed', skipped: 'block', terminated: 'status_terminated',
  });
  assert.equal(h.i.NEUTRAL, 'status_record');
  assert.equal(h.i.FOLDER, 'tree_folder');
  assert.equal(h.i.FILE, 'tree_suite');
  assert.equal(h.i.CHEVRON, 'chevron_right');
  assert.equal(h.i.ACCOUNT, 'person');
  // shared/icons.js is read raw: no fixture stands in for it, so nothing else would catch a drift.
  const names = [...Object.values(plain(h.i.STATUS)), h.i.NEUTRAL, h.i.FOLDER, h.i.FILE, h.i.CHEVRON, h.i.ACCOUNT];
  assert.deepEqual(names.filter((n) => !PATHS[n]), []);
});

// Joined tokens pass every stubbing suite but throw in the browser: classList.add refuses a space.
test('133: svgIcon passes each class on as its own argument, never one joined token', () => {
  const h = load();
  const icon = h.i.svgIcon('add', 14, 'spin', 'load-more-spinner');
  assert.deepEqual(h.icons.at(-1), { name: 'add', size: 14, cls: ['spin', 'load-more-spinner'] });
  assert.equal(icon.className, 'md-icon spin load-more-spinner');
  // The bare call is the same seam, so the row is about the arity and not about two classes.
  h.i.svgIcon('add');
  assert.deepEqual(h.icons.at(-1), { name: 'add', size: 16, cls: [] });
});
