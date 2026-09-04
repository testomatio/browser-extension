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
// MD_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.MD_SRC || join(repoRoot, 'extension/editor/md-sections.js');
const source = readFileSync(SRC, 'utf8');

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

// ---- #146: the edges the 16 cases above do not reach ----

// A tester whose editor saves CRLF: the steps already in the section are read, so the recorder
// numbers on from them. In the app OverType normalises CRLF; a file the module is handed does not.
test('a body saved with Windows line endings keeps the steps it already had (#146)', () => {
  const lf = md('### Steps', '', '1. Open the site', '');
  assert.equal(
    MdSections.insert(lf, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', '2. Click Login', ''),
  );
  const crlf = '### Steps\r\n\r\n1. Open the site\r\n';
  assert.equal(MdSections.hasItems(crlf, 'Steps', STEPS), true);
  assert.deepEqual(plain(MdSections.items(crlf, 'Steps', STEPS).map((it) => it.text)), ['Open the site']);
  assert.match(MdSections.insert(crlf, 'Steps', [step('Click Login')], STEPS), /2\. Click Login/);
  // …and an expected result under a CRLF step is that step's, not a second step of its own.
  const subbed = '### Steps\r\n\r\n1. Open the site\r\n   - Expected: the home page\r\n';
  assert.deepEqual(plain(MdSections.items(subbed, 'Steps', STEPS).map((it) => it.subs)),
    [['Expected: the home page']]);
});

// An expected result recorded before its step exists has nothing to hang on and is dropped.
test.todo('an expected result recorded into a Steps section that holds only prose survives (#146)', () => {
  const withStep = md('### Steps', '', '1. Open the site', '');
  const opts = { ordered: true, leadSubs: ['Expected: the dashboard'] };
  assert.match(MdSections.insert(withStep, 'Steps', [step('Click Login')], opts), /Expected: the dashboard/);
  const proseOnly = md('### Steps', '', 'Log in as admin first.', '');
  assert.match(MdSections.insert(proseOnly, 'Steps', [step('Click Login')], opts), /Expected: the dashboard/);
});

// `slice` reads a missing body as '', and the append branch joins onto that same normalised body.
test('recording into a body that does not exist yet writes no literal null into the test (#146)', () => {
  const out = MdSections.insert(null, 'Steps', [step('Open the site')], STEPS);
  assert.equal(out, MdSections.insert('', 'Steps', [step('Open the site')], STEPS));
  assert.doesNotMatch(out, /null/);
});

test('recording into an empty body opens the section for it', () => {
  const out = MdSections.insert('', 'Steps', [step('Open the site')], STEPS);
  // The two leading blanks are the append join; kept as is — the section reads back the same.
  assert.equal(out, '\n\n### Steps\n\n1. Open the site');
  assert.deepEqual(plain(MdSections.items(out, 'Steps', STEPS).map((it) => it.text)), ['Open the site']);
});

test('a recording with no steps in it hands back the very same body', () => {
  const body = md('### Steps', '', '1. Open the site', '');
  assert.equal(MdSections.insert(body, 'Steps', [], {}), body); // the input string itself
  const prose = md('### Steps', '', 'Log in as admin first.', '');
  assert.equal(MdSections.insert(prose, 'Steps', [], { ordered: true, leadSubs: ['Expected: x'] }), prose);
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', '2. Click Login', ''),
  );
});

test('a test with two Steps sections takes the new step into the first one', () => {
  const body = md('### Steps', '', '1. Open the site', '', '### Steps', '', '1. A second list', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', '2. Click Login', '', '### Steps', '', '1. A second list', ''),
  );
  const cut = MdSections.slice(body, 'Steps', STEPS);
  assert.equal(cut.hIdx, 0);
  assert.equal(cut.end, 4);
});

test('a heading with brackets in its name is found, and a dot in the name is not a wildcard', () => {
  assert.equal(MdSections.slice(md('### Steps (v2)', '1. A'), 'Steps (v2)', STEPS).hIdx, 0);
  assert.equal(MdSections.slice(md('### axb', '1. x'), 'a.b', STEPS).hIdx, -1);
});

test('a heading typed in capitals is the same section', () => {
  assert.equal(MdSections.slice(md('### STEPS', '1. A'), 'Steps', STEPS).hIdx, 0);
  assert.equal(
    MdSections.insert(md('### STEPS', '', '1. Open the site', ''), 'Steps', [step('Click Login')], STEPS),
    md('### STEPS', '', '1. Open the site', '2. Click Login', ''),
  );
});

test('the section is found at any heading level, and one the recorder has to create is always ###', () => {
  assert.equal(MdSections.slice(md('# Steps', '1. A'), 'Steps', STEPS).hIdx, 0);
  assert.equal(MdSections.slice(md('###### Steps', '1. A'), 'Steps', STEPS).hIdx, 0);
  assert.equal(
    MdSections.insert(md('## Steps', '', '1. Open the site', ''), 'Steps', [step('Click Login')], STEPS),
    md('## Steps', '', '1. Open the site', '2. Click Login', ''),
  );
  assert.equal(
    MdSections.insert('# Login', 'Steps', [step('Open the site')], STEPS),
    md('# Login', '', '### Steps', '', '1. Open the site'),
  );
});

test('a heading underlined with dashes is not a section the recorder can find', () => {
  const setext = md('Steps', '-----', '', '1. Open the site', '');
  assert.equal(MdSections.slice(setext, 'Steps', STEPS).hIdx, -1);
  assert.equal(
    MdSections.insert(setext, 'Steps', [step('Click Login')], STEPS),
    md('Steps', '-----', '', '1. Open the site', '', '### Steps', '', '1. Click Login'),
  );
  assert.equal(MdSections.slice(md('### Steps', '1. Open the site'), 'Steps', STEPS).hIdx, 0);
});

test('the section ends at the next heading, or at the end of the body', () => {
  const cut = MdSections.slice(md('### Steps', '1. A', '### Next', 'x'), 'Steps', STEPS);
  assert.equal(cut.hIdx, 0);
  assert.equal(cut.end, 2);
  const tail = MdSections.slice(md('### Steps', '1. A'), 'Steps', STEPS);
  assert.equal(tail.lines.length, 2);
  assert.equal(tail.end, tail.lines.length);
});

test('hasItems is true for a section with a list and false for one with only prose', () => {
  assert.equal(MdSections.hasItems(md('### Steps', '', '1. Open the site', ''), 'Steps', STEPS), true);
  assert.equal(MdSections.hasItems(md('### Steps', '', 'Log in as admin first.', ''), 'Steps', STEPS), false);
});

test('a code fence the tester never closed swallows the rest of the section', () => {
  const open = md('### Steps', '', '```', '1. not a step', '');
  assert.equal(MdSections.hasItems(open, 'Steps', STEPS), false);
  assert.equal(
    MdSections.insert(open, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '```', '1. not a step', '', '1. Click Login', ''),
  );
  const closed = md('### Steps', '', '```', 'x', '```', '', '1. Open the site', '');
  assert.equal(MdSections.hasItems(closed, 'Steps', STEPS), true);
});

test('a ~~~ fence, and one closed by a longer run of backticks, end where the tester ended them', () => {
  const tilde = md('### Steps', '', '~~~', '1. not a step', '~~~', '', '1. Open the site', '');
  assert.deepEqual(plain(MdSections.items(tilde, 'Steps', STEPS).map((it) => it.text)), ['Open the site']);
  const longer = md('### Steps', '', '```', '1. not a step', '`````', '', '1. Open the site', '');
  assert.deepEqual(plain(MdSections.items(longer, 'Steps', STEPS).map((it) => it.text)), ['Open the site']);
  // A shorter run does not close it, so everything after stays inside the fence.
  const shorter = md('### Steps', '', '````', '1. not a step', '```', '', '1. Open the site', '');
  assert.deepEqual(plain(MdSections.items(shorter, 'Steps', STEPS).map((it) => it.text)), []);
});

test('a ``` line whose info string holds a backtick is not a fence, so the step under it is found', () => {
  const body = md('### Steps', '', '``` `x`', '1. Open the site', '');
  assert.deepEqual(plain(MdSections.items(body, 'Steps', STEPS).map((it) => it.text)), ['Open the site']);
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '``` `x`', '1. Open the site', '2. Click Login', ''),
  );
});

test('a # note inside a code fence does not end the section', () => {
  const body = md('### Steps', '', '```', '# note', '```', '', '1. Open the site', '', '### Expected', 'Logged in.');
  const cut = MdSections.slice(body, 'Steps', STEPS);
  assert.equal(cut.end, 8);
  assert.deepEqual(plain(cut.items.map((it) => it.text)), ['Open the site']);
});

test('a recorded step with a newline inside it falls out of the list', () => {
  const body = md('### Steps', '', '1. Open the site', '');
  // Today the tail becomes prose; it should be refused or escaped before it reaches here.
  const out = MdSections.insert(body, 'Steps', [step('Type admin\nthen tab')], STEPS);
  assert.equal(out, md('### Steps', '', '1. Open the site', '2. Type admin', 'then tab', ''));
  assert.deepEqual(plain(MdSections.items(out, 'Steps', STEPS).map((it) => it.text)), ['Open the site', 'Type admin']);
});

test('a two-digit and a four-digit step number keep their expected results lined up', () => {
  const next = [step('Click Login', ['Expected: the form'])];
  assert.equal(
    MdSections.insert(md('### Steps', '', '10. Open the site', ''), 'Steps', next, STEPS),
    md('### Steps', '', '10. Open the site', '11. Click Login', '    - Expected: the form', ''),
  );
  assert.equal(
    MdSections.insert(md('### Steps', '', '999. Open the site', ''), 'Steps', next, STEPS),
    md('### Steps', '', '999. Open the site', '1000. Click Login', '      - Expected: the form', ''),
  );
});

test('a nested bullet needs two spaces: with one it becomes a step of its own', () => {
  const two = md('### Steps', '', '1. Open the site', '  - Expected: the home page', '');
  assert.deepEqual(plain(MdSections.items(two, 'Steps', STEPS).map((it) => it.subs)), [['Expected: the home page']]);
  assert.equal(
    MdSections.insert(two, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', '  - Expected: the home page', '2. Click Login', ''),
  );
  // One space: a second item, and the whole section is a bullet list from then on.
  const one = md('### Steps', '', '1. Open the site', ' - Expected: the home page', '');
  assert.deepEqual(
    plain(MdSections.items(one, 'Steps', STEPS).map((it) => it.text)),
    ['Open the site', 'Expected: the home page'],
  );
  assert.equal(
    MdSections.insert(one, 'Steps', [step('Click Login')], STEPS),
    md('### Steps', '', '1. Open the site', ' - Expected: the home page', ' - Click Login', ''),
  );
});

test('a blank line between two steps stays where the tester put it', () => {
  const body = md('### Steps', '', '1. Open the site', '', '2. Click Login', '');
  assert.equal(
    MdSections.insert(body, 'Steps', [step('Type admin')], STEPS),
    md('### Steps', '', '1. Open the site', '', '2. Click Login', '3. Type admin', ''),
  );
});

test('polish aimed past the end of the list holds the gap and changes nothing', () => {
  const body = md('### Steps', '', '1. Open the site', '');
  const spec = {
    count: 1, next: [{ text: 'Open **the site**', subs: [] }], written: [{ text: 'Open the site', subs: [] }],
  };
  const past = MdSections.replaceItems(body, 'Steps', STEPS, { ...spec, start: 5 });
  assert.equal(past.touched, 0);
  assert.equal(past.md, body);
  assert.deepEqual(plain(past.items), [null]);
  const hit = MdSections.replaceItems(body, 'Steps', STEPS, { ...spec, start: 0 });
  assert.equal(hit.touched, 1);
  assert.equal(hit.md, md('### Steps', '', '1. Open **the site**', ''));
});

test('polish with fewer answers than steps rewrites what it has and keeps the rest', () => {
  const body = md('### Steps', '', '1. Open the site', '2. Click Login', '');
  const done = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0,
    count: 2,
    next: [{ text: 'Open **the site**', subs: [] }],
    written: [{ text: 'Open the site', subs: [] }, { text: 'Click Login', subs: [] }],
  });
  assert.equal(done.touched, 1);
  assert.equal(done.md, md('### Steps', '', '1. Open **the site**', '2. Click Login', ''));
  assert.deepEqual(plain(done.items), [
    { text: 'Open **the site**', subs: [] },
    { text: 'Click Login', subs: [] },
  ]);
});

test('polish with nothing to do, a negative start, or no request at all never throws', () => {
  const body = md('### Steps', '', '1. Open the site', '');
  for (const spec of [{ start: 0, count: 0 }, { start: -1, count: 1 }, undefined]) {
    const done = MdSections.replaceItems(body, 'Steps', STEPS, spec);
    assert.equal(done.md, body);
    assert.equal(done.touched, 0);
    assert.deepEqual(plain(done.items), []);
  }
  const real = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0, count: 1, next: [{ text: 'Open **the site**', subs: [] }], written: [{ text: 'Open the site', subs: [] }],
  });
  assert.equal(real.touched, 1);
});

test('a polish answer with no expected result keeps the one the recorder wrote', () => {
  const body = md('### Steps', '', '1. Click Login', '   - Expected: the login form', '');
  const written = [{ text: 'Click Login', subs: ['Expected: the login form'] }];
  const silent = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0, count: 1, written, next: [{ text: 'Click **Login**', subs: [] }],
  });
  assert.equal(silent.md, md('### Steps', '', '1. Click **Login**', '   - Expected: the login form', ''));
  assert.deepEqual(plain(silent.items), [{ text: 'Click **Login**', subs: ['Expected: the login form'] }]);
  const spoken = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 0, count: 1, written, next: [{ text: 'Click **Login**', subs: ['Expected: the form appears'] }],
  });
  assert.equal(spoken.md, md('### Steps', '', '1. Click **Login**', '   - Expected: the form appears', ''));
});

test('a code fence between two steps does not shift which step polish rewrites', () => {
  // The fenced `1.` is an example the tester pasted, not a step: it must not take an index.
  const body = md('### Steps', '', '1. Open the site', '', '```md', '1. an example', '```', '', '2. Click Login', '');
  const done = MdSections.replaceItems(body, 'Steps', STEPS, {
    start: 1, count: 1, next: [{ text: 'Click **Login**', subs: [] }], written: [{ text: 'Click Login', subs: [] }],
  });
  assert.equal(done.touched, 1);
  assert.equal(
    done.md,
    md('### Steps', '', '1. Open the site', '', '```md', '1. an example', '```', '', '2. Click **Login**', ''),
  );
});
