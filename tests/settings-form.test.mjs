#!/usr/bin/env node
// extension/sidepanel/screens/settings-form.js on its own (#203): the Settings form split out of the
// screen that saves it. These rows are the ones the module makes CHEAP — the two pure readers Save
// depends on, and the defaults a form with nothing stored comes up wearing. Everything else the form
// does (the dropdown, the theme switch, the folds, the whole save gauntlet) stays in
// tests/settings.test.mjs, which drives it through the screen and is unchanged by the split.
// Two of them are refusals, and a refusal is the expensive half: `evidenceWindowFromField` answers
// `null` for a number outside 10-600 so Save can show the tester the sentence and keep what they
// typed — a module that quietly clamped to 600 instead would look identical from the outside until
// somebody's 900-second log window silently became something else. And `neverValuesEnabled` answers
// `false` to the STRING 'true', because a truthy read of a stored string is how a privacy toggle
// turns itself on for a tester who never asked.
// Run: node --test tests/settings-form.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, SCREENS_SRC, CORE_SRC } from './helpers/panel-harness.mjs';

const DEFAULT = 'https://app.testomat.io';

// The REAL toggle readers, not look-alikes: "absent -> ON" for three of them and "absent -> OFF" for
// the other two IS the defaults row, and a hand-written stub would let the form pass against a rule
// the panel does not have. Only `$`, `Dropdown` and `Theme` below are stubs.
const fromSource = (path, names) => runInNewContext(
  `${readFileSync(path, 'utf8')}\n({ ${names.join(', ')} });`, { URL },
);
const { envInfoEnabled, envFullUrlEnabled } = fromSource(
  join(CORE_SRC, 'env-info.js'), ['envInfoEnabled', 'envFullUrlEnabled'],
);
const {
  evidenceAutoStartEnabled, evidenceAutoAttachEnabled, evidenceCaptureBodiesEnabled,
} = fromSource(join(SCREENS_SRC, 'evidence.js'),
  ['evidenceAutoStartEnabled', 'evidenceAutoAttachEnabled', 'evidenceCaptureBodiesEnabled']);

// Only the fields setFields writes, and only as index.html types them. mini-dom keeps `value` and
// `checked` as PROPERTIES, so a checkbox seeded here is what the module reads back.
const TEXTS = ['set-baseurl', 'set-token', 'set-evidence-window'];
const CHECKS = ['set-env-info', 'set-env-full-url', 'set-evidence-autostart',
  'set-evidence-autoattach', 'set-evidence-bodies', 'set-rec-never-values'];

function load(seed = {}) {
  const doc = makeDocument([]);
  for (const id of TEXTS) doc.body.append(el('input', { id, value: seed[id] != null ? seed[id] : '' }));
  for (const id of CHECKS) doc.body.append(el('input', { id, type: 'checkbox', checked: !!seed[id] }));

  const h = loadScreen('settings-form', {
    exported: 'SettingsForm',
    document: doc,
    globals: {
      $: (id) => doc.getElementById(id),
      // Nothing below calls into either; they stand where the module's `/* global */` says they do,
      // so a member that started reaching for one at LOAD time would fail here rather than silently.
      Dropdown: { of: () => null, create: () => { throw new Error('no dropdown in this fixture'); } },
      Theme: { get: () => 'system', set: () => {}, onChange: () => {} },
      envInfoEnabled,
      envFullUrlEnabled,
      evidenceAutoStartEnabled,
      evidenceAutoAttachEnabled,
      evidenceCaptureBodiesEnabled,
    },
  });
  return {
    form: h.screen,
    doc,
    field: (id) => doc.getElementById(id),
    // What the tester would see on the six switches after a paint.
    toggles: () => Object.fromEntries(CHECKS.map((id) => [id, doc.getElementById(id).checked])),
  };
}

// Reads the field the way Save does: through the DOM, not as an argument.
const windowOf = (raw) => {
  const h = load({ 'set-evidence-window': raw });
  return h.form.evidenceWindowFromField();
};

test('#203 the evidence window: blank means 60, a fraction rounds, and 10 and 600 are both inside', () => {
  assert.equal(windowOf(''), 60);
  assert.equal(windowOf('   '), 60); // whitespace is blank, not a bad number
  assert.equal(windowOf('59.6'), 60);
  assert.equal(windowOf('  120  '), 120);
  assert.equal(windowOf('10'), 10);
  assert.equal(windowOf('600'), 600);
});

test('#203 the evidence window: out of range or not a number is refused with null, never rewritten', () => {
  for (const raw of ['9', '601', '0', '-30', 'abc', '12abc', '1e9']) {
    assert.equal(windowOf(raw), null, `${raw} must be refused`);
  }
  // 9.6 rounds INTO range: rounding happens first, and 10 is what gets saved.
  assert.equal(windowOf('9.6'), 10);
  // The refusal leaves the field alone — Save shows a sentence, the tester keeps what they typed.
  const h = load({ 'set-evidence-window': '900' });
  assert.equal(h.form.evidenceWindowFromField(), null);
  assert.equal(h.field('set-evidence-window').value, '900');
});

test('#203 resolveProjectId: a reachable previous wins, a lone project needs no choosing, several leave it open', () => {
  const { form } = load();
  const many = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(form.resolveProjectId(many, 'b'), 'b');
  assert.equal(form.resolveProjectId([{ id: 'only' }], ''), 'only');
  assert.equal(form.resolveProjectId(many, ''), '');
  // A previous the new token cannot reach is not a pick — it falls through to the same three rules.
  assert.equal(form.resolveProjectId(many, 'gone'), '');
  assert.equal(form.resolveProjectId([{ id: 'only' }], 'gone'), 'only');
});

test('#203 never-values reads the boolean and nothing else: the string "true" is not true', () => {
  const { form } = load();
  assert.equal(form.neverValuesEnabled({ stepRecNeverValues: true }), true);
  assert.equal(form.neverValuesEnabled({ stepRecNeverValues: 'true' }), false);
  assert.equal(form.neverValuesEnabled({ stepRecNeverValues: 1 }), false);
  assert.equal(form.neverValuesEnabled({}), false);
  assert.equal(form.neverValuesEnabled(undefined), false);
  assert.equal(form.neverValuesEnabled(null), false);
});

test('#203 setFields({}) paints all seven defaults over whatever the form was showing', () => {
  // Every field seeded the WRONG way round, so a default that is merely left alone cannot pass.
  const h = load({
    'set-baseurl': 'https://self.host',
    'set-token': 'tok-1',
    'set-evidence-window': '300',
    'set-env-info': false,
    'set-env-full-url': true,
    'set-evidence-autostart': true,
    'set-evidence-autoattach': false,
    'set-evidence-bodies': false,
    'set-rec-never-values': true,
  });
  h.form.setFields({});
  assert.equal(h.field('set-baseurl').value, DEFAULT); // the default instance, not an empty box
  assert.equal(h.field('set-token').value, '');
  assert.equal(h.field('set-evidence-window').value, ''); // blank, so the 60s placeholder shows
  assert.deepEqual(h.toggles(), {
    'set-env-info': true,
    'set-env-full-url': false,
    'set-evidence-autostart': false,
    'set-evidence-autoattach': true,
    'set-evidence-bodies': true,
    'set-rec-never-values': false,
  });
});

test('#203 setFields with no argument at all is the same paint, not a crash', () => {
  const h = load({ 'set-baseurl': 'https://self.host', 'set-rec-never-values': true });
  h.form.setFields();
  assert.equal(h.field('set-baseurl').value, DEFAULT);
  assert.equal(h.field('set-rec-never-values').checked, false);
});
