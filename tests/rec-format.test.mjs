#!/usr/bin/env node
// Recorded entries become items, items become markdown, and the polish answer becomes items again.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// RECFMT_SRC runs the suite on a mutated copy, so a mutation run never edits the shipped module.
const SRC = process.env.RECFMT_SRC || join(repoRoot, 'extension/editor/rec-format.js');
const source = readFileSync(SRC, 'utf8');

// insertRecorded sees MdSections as a lexical global, as editor.html loads them: one shared context.
const ctx = createContext({});
runInContext(readFileSync(join(repoRoot, 'extension/editor/md-sections.js'), 'utf8'), ctx);
const RecFormat = runInContext(`${source}\nRecFormat;`, ctx);
const {
  stepsHeading, splitRecorded, insertRecorded, polishedSection, asExpected, parsePolishedItems, serverMessage,
} = RecFormat;

// Values come back from the vm realm with its own prototypes, so compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const md = (...lines) => lines.join('\n');
const START = '<!-- ![START polished_steps]! -->';
const END = '<!-- ![END polished_steps]! -->';

test('the module publishes exactly the surface editor.js destructures', () => {
  // rec-session names the section once and hands it to insertRecorded, so count and insert agree.
  assert.deepEqual(Object.keys(RecFormat).sort(), [
    'STEPS_OPTS', 'aiRefused', 'aiStatusOf', 'asExpected', 'insertRecorded', 'parsePolishedItems',
    'polishedSection', 'serverMessage', 'splitRecorded', 'stepsHeading',
  ]);
  assert.deepEqual(plain(RecFormat.STEPS_OPTS), { ordered: true });
  assert.equal(asExpected('**Expected:** y'), 'Expected: y');
  assert.equal(stepsHeading('### Кроки\n\n1. Відкрити\n'), 'Кроки');
  assert.equal(stepsHeading('# T\n'), 'Steps'); // a body with no steps section at all
});

test('1: an expected result binds to the step before it', () => {
  const parts = splitRecorded([{ text: 'Click A' }, { kind: 'expected', text: 'a toast' }, { text: 'Click B' }], false);
  assert.deepEqual(plain(parts), {
    steps: [{ text: 'Click A', subs: ['Expected: a toast'] }, { text: 'Click B', subs: [] }],
    expected: [],
    leadSubs: [],
  });
});

test('2: an expected result with no step above it lands in its own Expected list', () => {
  assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: 'x' }], false)), {
    steps: [], expected: ['x'], leadSubs: [],
  });
});

test('3: the same entry attaches to the body when a step is already written there', () => {
  assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: 'x' }], true)), {
    steps: [], expected: [], leadSubs: ['Expected: x'],
  });
});

test('4: falsy text is dropped, and an entry with no text at all does not throw', () => {
  assert.deepEqual(plain(splitRecorded([{ text: '' }, { text: null }, {}], false)), {
    steps: [], expected: [], leadSubs: [],
  });
});

// Testers type the panel's own "Expected:" prefix too, so it is stripped before it is added.
test('5 (#245): an entry that already says "Expected:" is not prefixed twice', () => {
  const parts = splitRecorded([{ text: 'A' }, { kind: 'expected', text: 'Expected: y' }], false);
  assert.deepEqual(plain(parts.steps), [{ text: 'A', subs: ['Expected: y'] }]);
  for (const typed of ['Expected: y', 'expected: y', '**Expected:** y', '- Expected: y', '*Expected*  y']) {
    assert.deepEqual(
      plain(splitRecorded([{ text: 'A' }, { kind: 'expected', text: typed }], false).steps[0].subs),
      ['Expected: y'],
    );
    assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: typed }], true).leadSubs), ['Expected: y']);
  }
  // With nothing to attach to it goes in bare: a bullet under ### Expected carries no prefix.
  assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: 'Expected: y' }], false).expected), ['Expected: y']);
});

test('6: steps and their expected sub-lines become a numbered Steps section', () => {
  const parts = splitRecorded([{ text: 'Click A' }, { kind: 'expected', text: 'a toast' }, { text: 'Click B' }], false);
  assert.equal(
    insertRecorded('# T\n', parts),
    md('# T', '', '### Steps', '', '1. Click A', '   - Expected: a toast', '2. Click B'),
  );
});

test('7: a lone expected result becomes an UNORDERED Expected section', () => {
  assert.equal(
    insertRecorded('# T\n', splitRecorded([{ kind: 'expected', text: 'ok' }], false)),
    md('# T', '', '### Expected', '', '- ok'),
  );
});

test('8: with both lists filled, Steps is written before Expected', () => {
  const parts = splitRecorded([{ text: 'Click A' }, { text: 'Click B' }], false);
  parts.expected.push('it works');
  assert.equal(
    insertRecorded('# T\n', parts),
    md('# T', '', '### Steps', '', '1. Click A', '2. Click B', '', '### Expected', '', '- it works'),
  );
});

test('9: nothing recorded leaves the body byte for byte as it was', () => {
  const body = md('# T', '', 'body');
  assert.equal(insertRecorded(body, { steps: [], expected: [], leadSubs: [] }), body);
});

// markdown.js reads a list under step|крок as steps; writing must match, or a second section grows.
test('10 (#246): a recorded step joins the Ukrainian ### Кроки section', () => {
  assert.equal(
    insertRecorded(md('### Кроки', '', '1. Відкрити', ''), splitRecorded([{ text: 'Клік' }], false)),
    md('### Кроки', '', '1. Відкрити', '2. Клік', ''),
  );
  // The heading the caller names wins over the body's, so rec-session's count and the write agree.
  assert.equal(
    insertRecorded(md('### Кроки', '', '1. Відкрити', ''), splitRecorded([{ text: 'Клік' }], false), 'Steps'),
    md('### Кроки', '', '1. Відкрити', '', '### Steps', '', '1. Клік'),
  );
  assert.equal(
    insertRecorded('# T\n', splitRecorded([{ text: 'Click A' }], false)),
    md('# T', '', '### Steps', '', '1. Click A'),
  );
});

test('11: the polish markers are cut off whichever field carried them', () => {
  assert.equal(polishedSection({ steps: `${START}\n1. A\n${END}` }), '\n1. A\n');
});

test('12: an answer with no markers is taken raw', () => {
  assert.equal(polishedSection({ text: '1. A' }), '1. A');
});

test('13: an empty steps field falls through to text', () => {
  assert.equal(polishedSection({ steps: '', text: 'T' }), 'T');
});

test('14: steps wins over text', () => {
  assert.equal(polishedSection({ steps: 'S', text: 'T' }), 'S');
});

test('15: no answer at all is an empty string, not a throw', () => {
  assert.equal(polishedSection(null), '');
  assert.equal(polishedSection({}), '');
});

test('16: END before START is not a cut — the raw string comes back with its markers', () => {
  // Markers left in are ignored by parsePolishedItems, so a numbered answer still parses.
  const reversed = `${END}\nnothing numbered here\n${START}`;
  assert.equal(polishedSection({ steps: reversed }), reversed);
  assert.deepEqual(plain(parsePolishedItems(polishedSection({ steps: reversed }))), []);
  const numbered = `${END}\n1. A\n${START}`;
  assert.equal(polishedSection({ steps: numbered }), numbered);
  assert.deepEqual(plain(parsePolishedItems(polishedSection({ steps: numbered }))), [{ text: 'A', subs: [] }]);
});

test('17: `2)` numbers count, and an emphasised sub-line is normalised', () => {
  assert.deepEqual(plain(parsePolishedItems('1. Click Login\n   - *Expected*: the form\n2) Type admin')), [
    { text: 'Click Login', subs: ['Expected: the form'] },
    { text: 'Type admin', subs: [] },
  ]);
});

test('18: a sub-line before any item is dropped', () => {
  assert.deepEqual(plain(parsePolishedItems('- Expected: x\n1. A')), [{ text: 'A', subs: [] }]);
});

test('19: bold markers around Expected are stripped', () => {
  assert.deepEqual(plain(parsePolishedItems('1. A\n**Expected:** y')), [{ text: 'A', subs: ['Expected: y'] }]);
});

test('20: an expected line with no colon and no bullet still counts', () => {
  assert.deepEqual(plain(parsePolishedItems('1. A\nExpected the thing')), [{ text: 'A', subs: ['Expected: the thing'] }]);
});

test('21: prose between two items is ignored, both items survive', () => {
  assert.deepEqual(plain(parsePolishedItems('1. A\nSome prose\n2. B')), [
    { text: 'A', subs: [] }, { text: 'B', subs: [] },
  ]);
});

test('22: an indented item is an item, and its text is trimmed', () => {
  assert.deepEqual(plain(parsePolishedItems('  1. indented')), [{ text: 'indented', subs: [] }]);
});

test('23: an empty or missing section is an empty list', () => {
  assert.deepEqual(plain(parsePolishedItems('')), []);
  assert.deepEqual(plain(parsePolishedItems(null)), []);
});

test('24: a 422 body speaks for itself, verbatim', () => {
  assert.equal(
    serverMessage({ message: '{"error":"Ai is not available in your subscription plan"}' }),
    'Ai is not available in your subscription plan',
  );
});

test('25: a details array is joined into one sentence', () => {
  assert.equal(serverMessage({ message: '{"details":["a","b"]}' }), 'a; b');
});

test('26: a non-JSON body, no error and an empty error all give the empty string', () => {
  assert.equal(serverMessage({ message: 'not json' }), '');
  assert.equal(serverMessage(null), '');
  assert.equal(serverMessage({}), '');
});

test('27: precedence is error, then details, then message', () => {
  assert.equal(serverMessage({ message: '{"error":null,"message":"x"}' }), 'x');
  // With error:null every order answers 'x', so these two pin the order the contract names.
  assert.equal(serverMessage({ message: '{"error":"E","details":["d"],"message":"M"}' }), 'E');
  assert.equal(serverMessage({ message: '{"details":["d"],"message":"M"}' }), 'd');
});

test('27a: an ApiError already carries the server\'s sentence as text — that is its own words too', () => {
  // extension/api/errors.js reads the body into `message` before the editor ever sees it.
  assert.equal(serverMessage({ kind: 'http', status: 422, message: 'Ai is not available in your subscription plan' }),
    'Ai is not available in your subscription plan');
  assert.equal(serverMessage({ kind: 'http', status: 422, message: 'HTTP 422' }), ''); // nothing was said
  assert.equal(serverMessage({ kind: 'network', message: 'Failed to fetch' }), ''); // not the server talking
});

const project = (cs) => ({ data: { attributes: cs === undefined ? {} : { 'company-settings': cs } } });

test('aiStatusOf: the project says whether this company has AI, and whether the instance has any', () => {
  const { aiStatusOf } = RecFormat;
  assert.equal(aiStatusOf(project({ ai_enabled: true, ai_hidden: false })), 'on');
  assert.equal(aiStatusOf(project({ ai_enabled: false, ai_hidden: false })), 'off');
  assert.equal(aiStatusOf(project({ ai_enabled: false, ai_hidden: true })), 'none');
  assert.equal(aiStatusOf(project({ 'ai-enabled': false })), 'off'); // keys dasherised too
  // Seen on prod: a company with no subscription is answered null — no AI, not "unknown".
  assert.equal(aiStatusOf(project({ ai_enabled: null, ai_hidden: false })), 'off');
  assert.equal(aiStatusOf(project({ ai_enabled: 'yes' })), 'off'); // anything but true sends nothing
});

test('aiStatusOf: an older server, or no answer at all, is unknown — never a guess', () => {
  const { aiStatusOf } = RecFormat;
  for (const doc of [project(), project({}), project({ ai_hidden: false }), project('x'), null, {}]) {
    assert.equal(aiStatusOf(doc), 'unknown');
  }
});

test('aiRefused: the plan refusal, the switched-off company, and nothing else', () => {
  const { aiRefused } = RecFormat;
  const err = (status, error) => ({ status, message: JSON.stringify({ error }) });
  const apiErr = (status, message) => ({ kind: 'http', status, message }); // what the editor really gets
  assert.equal(aiRefused(null, apiErr(422, 'Ai is not available in your subscription plan')), true);
  assert.equal(aiRefused(null, apiErr(422, 'HTTP 422')), false);
  assert.equal(aiRefused(null, err(422, 'Ai is not available in your subscription plan')), true);
  assert.equal(aiRefused(null, err(422, 'AI is not enabled for this project')), true);
  assert.equal(aiRefused(null, err(422, 'Prompt is too long')), false);
  assert.equal(aiRefused(null, err(500, 'Ai is not available in your subscription plan')), false);
  assert.equal(aiRefused({ text: 'AI is disabled' }), true);
  assert.equal(aiRefused({ steps: '1. AI is disabled on the settings page' }), false);
  assert.equal(aiRefused({}), false);
});
