#!/usr/bin/env node
// The splice contract of extension/editor/md-sections.js (#84): recording into a section a
// tester already wrote must add to it, never re-emit it. Run: node --test tests/md-sections.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repoRoot, 'extension/editor/md-sections.js'), 'utf8');

// md-sections.js is a plain script with no dependencies, so the sandbox is bare; its
// top-level `const` is lexical, not a global property — the script's completion value is it.
const MdSections = runInNewContext(`${source}\nMdSections;`, {});

// Values cross back from the vm realm, where Array/Object have their own prototypes: compare
// them as plain JSON rather than by identity.
const plain = (v) => JSON.parse(JSON.stringify(v));
const STEPS = { ordered: true };
const md = (...lines) => lines.join('\n');
const step = (text, subs = []) => ({ text, subs });

test('a bullet list keeps its lines and takes the new step as a third bullet', () => {
  const body = md('### Steps', '', '- Open the site', '- Click Login', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Submit')], STEPS),
    md('### Steps', '', '- Open the site', '- Click Login', '- Click Submit', ''),
  );
});

test('prose, a fence and an image survive; the step lands after them', () => {
  const body = md(
    '### Steps',
    '',
    'Log in as admin first.',
    '',
    '```sh',
    'npm run seed',
    '',
    '- not a step',
    '```',
    '',
    '![shot](img/a.png)',
    '',
    '## Expected',
    '',
    'A seeded project.',
  );
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Submit')], STEPS),
    md(
      '### Steps',
      '',
      'Log in as admin first.',
      '',
      '```sh',
      'npm run seed',
      '',
      '- not a step',
      '```',
      '',
      '![shot](img/a.png)',
      '',
      '1. Click Submit',
      '',
      '## Expected',
      '',
      'A seeded project.',
    ),
  );
});

test('a `1)` list survives and continues as `3)`', () => {
  const body = md('### Steps', '', '1) Open', '2) Click', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Submit')], STEPS),
    md('### Steps', '', '1) Open', '2) Click', '3) Submit', ''),
  );
});

test('a second-level bullet keeps its deeper indent', () => {
  const body = md('### Steps', '', '1. Open the site', '    - detail note', '2. Click Login', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Submit')], STEPS),
    md('### Steps', '', '1. Open the site', '    - detail note', '2. Click Login', '3. Submit', ''),
  );
});

test('a fenced block elsewhere in the document keeps its blank runs', () => {
  const body = md(
    '# Login',
    '',
    '## Description',
    '',
    '```js',
    'const a = 1;',
    '',
    '',
    'const b = 2;',
    '```',
    '',
    '### Steps',
    '',
    '1. Open the site',
    '',
    '',
    '### Expected',
    '',
    'Logged in.',
  );
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Login')], STEPS),
    md(
      '# Login',
      '',
      '## Description',
      '',
      '```js',
      'const a = 1;',
      '',
      '',
      'const b = 2;',
      '```',
      '',
      '### Steps',
      '',
      '1. Open the site',
      '2. Click Login',
      '',
      '',
      '### Expected',
      '',
      'Logged in.',
    ),
  );
});

test('an absent heading appends the section at the end', () => {
  const body = md('# Login', '', 'Some description.', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Open https://x')], STEPS),
    md('# Login', '', 'Some description.', '', '### Steps', '', '1. Open https://x'),
  );
  assert.equal(MdSections.hasItems(body, 'Steps', STEPS), false);
  assert.equal(MdSections.slice(body, 'Steps', STEPS).hIdx, -1);
});

test('an empty section takes the items right under its heading', () => {
  const body = md('### Steps', '', '### Expected', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Open the site')], STEPS),
    md('### Steps', '', '1. Open the site', '', '### Expected', ''),
  );
});

test('an unordered target with no items falls back to opts.ordered', () => {
  const body = md('### Expected', '');
  assert.equal(
    MdSections.insert(body, 'Expected', [step('A dashboard')], { ordered: false }),
    md('### Expected', '', '- A dashboard', ''),
  );
});

test('leadSubs land on the last item, above the new steps', () => {
  const body = md('### Steps', '', '1. Open the site', '2. Click Login', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [], { ordered: true, leadSubs: ['Expected: the dashboard'] }),
    md('### Steps', '', '1. Open the site', '2. Click Login', '   - Expected: the dashboard', ''),
  );
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Type admin', ['Expected: accepted'])], {
      ordered: true, leadSubs: ['Expected: the dashboard'],
    }),
    md(
      '### Steps',
      '',
      '1. Open the site',
      '2. Click Login',
      '   - Expected: the dashboard',
      '3. Type admin',
      '   - Expected: accepted',
      '',
    ),
  );
});

test('a new step lands after the last item\'s own sub-lines', () => {
  const body = md('### Steps', '', '1. Open the site', '   - Expected: the home page', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', '   - Expected: the home page', '2. Click Login', ''),
  );
});

test('items() reads text, subs and markers back out', () => {
  const body = md('### Steps', '', 'Some prose.', '', '1) Open the site', '   - Expected: the home page', '2) Click');
  const items = MdSections.items(body, 'Steps', STEPS);
  assert.equal(items.length, 2);
  assert.deepEqual(plain(items.map((it) => it.text)), ['Open the site', 'Click']);
  assert.deepEqual(plain(items[0].subs), ['Expected: the home page']);
  assert.equal(items[0].marker, '1)');
  assert.equal(items[0].endLine, 5);
  assert.equal(items[1].number, 2);
});

test('polish rewrites only its own items and keeps their markers', () => {
  const body = md(
    '### Steps',
    '',
    '1. Written by hand',
    '2. Click the Login button',
    '   - Expected: Login form',
    '3. Type admin',
    '',
    'A note after the list.',
  );
  const written = [
    { text: 'Click the Login button', subs: ['Expected: Login form'] },
    { text: 'Type admin', subs: [] },
  ];
  const next = [
    { text: 'Click **Login**', subs: ['Expected: the login form appears'] },
    { text: 'Type the admin name', subs: [] },
  ];
  const done = MdSections.replaceItems(body, 'Steps', STEPS, { start: 1, count: 2, next, written });
  assert.equal(done.touched, 2);
  assert.equal(
    done.md,
    md(
      '### Steps',
      '',
      '1. Written by hand',
      '2. Click **Login**',
      '   - Expected: the login form appears',
      '3. Type the admin name',
      '',
      'A note after the list.',
    ),
  );
  assert.deepEqual(plain(done.items), [
    { text: 'Click **Login**', subs: ['Expected: the login form appears'] },
    { text: 'Type the admin name', subs: [] },
  ]);
});

test('polish leaves a hand-edited item alone', () => {
  const body = md('### Steps', '', '1. Click the Login link', '2. Type admin', '');
  const written = [{ text: 'Click the Login button', subs: [] }, { text: 'Type admin', subs: [] }];
  const next = [{ text: 'Click **Login**', subs: [] }, { text: 'Type the admin name', subs: [] }];
  const done = MdSections.replaceItems(body, 'Steps', STEPS, { start: 0, count: 2, next, written });
  assert.equal(done.touched, 1);
  assert.equal(done.md, md('### Steps', '', '1. Click the Login link', '2. Type the admin name', ''));
  assert.deepEqual(plain(done.items), [
    { text: 'Click the Login link', subs: [] },
    { text: 'Type the admin name', subs: [] },
  ]);
});

test('polish that touches nothing returns the body unchanged', () => {
  const body = md('### Steps', '', '1. Click the Login link', '');
  const done = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0, count: 1, next: [{ text: 'Click Login', subs: [] }], written: [{ text: 'something else', subs: [] }],
  });
  assert.equal(done.touched, 0);
  assert.equal(done.md, body);
  assert.equal(MdSections.replaceItems(body, 'Missing', STEPS, { start: 0, count: 1 }).md, body);
});

test('polish holds the numbering when the tester deleted an item', () => {
  const body = md('### Steps', '', '1. Type admin', '');
  const written = [{ text: 'Click Login', subs: [] }, { text: 'Type admin', subs: [] }];
  const next = [{ text: 'Click **Login**', subs: [] }, { text: 'Type the admin name', subs: [] }];
  const done = MdSections.replaceItems(body, 'Steps', STEPS, { start: 0, count: 2, next, written });
  assert.equal(done.touched, 0);
  assert.deepEqual(plain(done.items), [{ text: 'Type admin', subs: [] }, null]);
});

test('polish keeps a bullet list a bullet list', () => {
  const body = md('### Steps', '', '- Click the Login button', '');
  const done = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0,
    count: 1,
    next: [{ text: 'Click **Login**', subs: ['Expected: the form'] }],
    written: [{ text: 'Click the Login button', subs: [] }],
  });
  assert.equal(done.md, md('### Steps', '', '- Click **Login**', '  - Expected: the form', ''));
});
