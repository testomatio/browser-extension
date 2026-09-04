#!/usr/bin/env node
// The formatting contract of extension/editor/rec-format.js (#192): recorded entries become
// items, items become markdown through md-sections, and the polish answer becomes items again.
// Cases numbered as in #192. Run: node --test tests/rec-format.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// RECFMT_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.RECFMT_SRC || join(repoRoot, 'extension/editor/rec-format.js');
const source = readFileSync(SRC, 'utf8');

// `insertRecorded` reaches MdSections as a lexical global, exactly the way editor.html loads the
// two scripts — so the sandbox is one context with md-sections evaluated into it first.
const ctx = createContext({});
runInContext(readFileSync(join(repoRoot, 'extension/editor/md-sections.js'), 'utf8'), ctx);
const RecFormat = runInContext(`${source}\nRecFormat;`, ctx);
const {
  stepsHeading, splitRecorded, insertRecorded, polishedSection, asExpected, parsePolishedItems, serverMessage,
} = RecFormat;

// Values cross back from the vm realm, where Array/Object have their own prototypes: compare
// them as plain JSON rather than by identity.
const plain = (v) => JSON.parse(JSON.stringify(v));
const md = (...lines) => lines.join('\n');
const START = '<!-- ![START polished_steps]! -->';
const END = '<!-- ![END polished_steps]! -->';

test('the module publishes exactly the surface editor.js destructures', () => {
  // `stepsHeading` joined the surface with #246: rec-session names the section ONCE per call and
  // hands the same name to `insertRecorded`, so its count and the insert cannot disagree.
  assert.deepEqual(Object.keys(RecFormat).sort(), [
    'STEPS_OPTS', 'asExpected', 'insertRecorded', 'parsePolishedItems',
    'polishedSection', 'serverMessage', 'splitRecorded', 'stepsHeading',
  ]);
  assert.deepEqual(plain(RecFormat.STEPS_OPTS), { ordered: true });
  assert.equal(asExpected('**Expected:** y'), 'Expected: y');
  assert.equal(stepsHeading('### Кроки\n\n1. Відкрити\n'), 'Кроки');
  assert.equal(stepsHeading('# T\n'), 'Steps'); // a body with no steps section at all
});

// ===================== splitRecorded: entries → items =======================

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

// The prefix is the panel's own wording, so a tester types it as often as not. It is written in
// ONE place (`asExpected`) and stripped first, however it was emphasised or bulleted.
test('5 (#245): an entry that already says "Expected:" is not prefixed twice', () => {
  const parts = splitRecorded([{ text: 'A' }, { kind: 'expected', text: 'Expected: y' }], false);
  assert.deepEqual(plain(parts.steps), [{ text: 'A', subs: ['Expected: y'] }]);
  // Every spelling #245 lists, on the step branch and on the leadSubs branch alike.
  for (const typed of ['Expected: y', 'expected: y', '**Expected:** y', '- Expected: y', '*Expected*  y']) {
    assert.deepEqual(
      plain(splitRecorded([{ text: 'A' }, { kind: 'expected', text: typed }], false).steps[0].subs),
      ['Expected: y'],
    );
    assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: typed }], true).leadSubs), ['Expected: y']);
  }
  // …and an expected result with nothing to attach to still goes in bare: it becomes a bullet
  // under `### Expected`, which carries no prefix to double in the first place.
  assert.deepEqual(plain(splitRecorded([{ kind: 'expected', text: 'Expected: y' }], false).expected), ['Expected: y']);
});

// ===================== insertRecorded: items → markdown =====================

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

// shared/markdown.js renders a list as the STEPS when its heading matches `step|крок`; writing
// has to know the same two words, or a Ukrainian test grows a second section instead of a step.
test('10 (#246): a recorded step joins the Ukrainian ### Кроки section', () => {
  assert.equal(
    insertRecorded(md('### Кроки', '', '1. Відкрити', ''), splitRecorded([{ text: 'Клік' }], false)),
    md('### Кроки', '', '1. Відкрити', '2. Клік', ''),
  );
  // The heading the caller names wins over the one the body would suggest — rec-session resolves
  // it once, before the insert, so its item count and this write cannot name different sections.
  assert.equal(
    insertRecorded(md('### Кроки', '', '1. Відкрити', ''), splitRecorded([{ text: 'Клік' }], false), 'Steps'),
    md('### Кроки', '', '1. Відкрити', '', '### Steps', '', '1. Клік'),
  );
  // A body with no steps section of any name still opens the English one, as it always did.
  assert.equal(
    insertRecorded('# T\n', splitRecorded([{ text: 'Click A' }], false)),
    md('# T', '', '### Steps', '', '1. Click A'),
  );
});

// ===================== polishedSection: answer → section ====================

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
  // #192 predicted an empty parse here; that only holds when the answer has no `N.` line of its
  // own. Markers left in are ignored by parsePolishedItems, so a numbered answer still parses.
  const reversed = `${END}\nnothing numbered here\n${START}`;
  assert.equal(polishedSection({ steps: reversed }), reversed);
  assert.deepEqual(plain(parsePolishedItems(polishedSection({ steps: reversed }))), []);
  const numbered = `${END}\n1. A\n${START}`;
  assert.equal(polishedSection({ steps: numbered }), numbered);
  assert.deepEqual(plain(parsePolishedItems(polishedSection({ steps: numbered }))), [{ text: 'A', subs: [] }]);
});

// ===================== parsePolishedItems: section → items ==================

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

// ===================== serverMessage: the instance's own words ==============

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
  // #192's own row cannot tell the three fields apart — with `error:null` every order answers
  // 'x'. These two pin the order the contract names.
  assert.equal(serverMessage({ message: '{"error":"E","details":["d"],"message":"M"}' }), 'E');
  assert.equal(serverMessage({ message: '{"details":["d"],"message":"M"}' }), 'd');
});

