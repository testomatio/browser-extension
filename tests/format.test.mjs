#!/usr/bin/env node
// extension/sidepanel/core/format.js — how a duration reads to a tester. Rows 18-25 of #164,
// moved here unchanged when the function left screens/test-view.js (#197): they were always
// pure, and this file proves it — no document, no chrome, no state, no stub of any kind.
// The exact strings are a parity contract with the web (helpers/duration-to-human), so a
// wording change here is a change the tester sees in the run list and the result card at once.
// Run: node --test tests/format.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// CORE_SRC points the suite at a mutated COPY of core/, so a falsification run never edits
// the shipped file. `Fmt` is a top-level const: lexical, so only the completion value reaches us.
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const Fmt = runInNewContext(`${readFileSync(join(CORE_SRC, 'format.js'), 'utf8')}\nFmt;`, {});
const dur = (v) => Fmt.humanDuration(v);

test('18: a duration that is zero, negative or not a number at all prints nothing', () => {
  for (const v of [0, -5, NaN, null, '', undefined, 'later']) assert.equal(dur(v), '');
});

test('18a: …and every duration above zero does print, down to a single millisecond', () => {
  assert.equal(dur(1), '1ms');
  assert.equal(dur(0.4), '0ms'); // rounded, but still a figure: it ran
});

test('19: under a second is milliseconds', () => {
  assert.equal(dur(999), '999ms');
  assert.equal(dur(1000), '1s'); // the boundary belongs to seconds
});

test('20: the reported-steps route hands a STRING by design, and it formats the same', () => {
  assert.equal(dur('1500'), '1.5s');
  assert.equal(dur(1500), '1.5s');
});

test('21: a whole number of seconds loses its .0', () => {
  assert.equal(dur(2000), '2s');
  assert.equal(dur(2100), '2.1s'); // …and a tenth that is there stays
});

test('22: a whole minute is a minute, with no seconds hung off it', () => {
  assert.equal(dur(60000), '1m');
});

test('23: minutes and seconds', () => {
  assert.equal(dur(90000), '1m 30s');
});

test('24: one millisecond under the hour reads "59m 60s" — the rounding artifact, pinned', () => {
  assert.equal(dur(3599999), '59m 60s');
  // The neighbouring second, where the same arithmetic is unremarkable.
  assert.equal(dur(3599000), '59m 59s');
});

test('25: hours, with the minutes dropped when there are none', () => {
  assert.equal(dur(3600000), '1h');
  assert.equal(dur(3660000), '1h 1m');
  assert.equal(dur(7260000), '2h 1m');
});

// The run list hands SECONDS off the run serializer, so it multiplies before it asks — the one
// call in the panel that converts, and the reason both screens must share this function.
test('the run list\'s seconds-to-ms conversion lands on the same wording', () => {
  assert.equal(dur(95 * 1000), '1m 35s');
});
