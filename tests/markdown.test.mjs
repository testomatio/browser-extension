#!/usr/bin/env node
// #150: extension/shared/markdown.js turns the markdown a tester wrote into what they read in the
// panel, and marks the list under a "Steps" heading so the step rows know which list they are.
// Anything tag-shaped in a description is shown as text and never rendered — half the reason a
// description written by someone else cannot run code in the tester's panel.
// Run: node --test tests/markdown.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, pageGlobals, EXT_BASE } from './helpers/shared-harness.mjs';
import { makeDocument, el } from './helpers/mini-dom.mjs';

// ---- stage one: what reaches showdown ----
// A converter that echoes, so the string the escape stage produced is readable as itself; the real
// one would then turn it into HTML and the exact escaping would be lost.
function escapeStage() {
  const seen = [];        // every string handed to makeHtml, in order
  const exts = new Map(); // every extension registered at load
  let options = null;
  const showdown = {
    extension: (name, factory) => exts.set(name, factory),
    Converter: class { constructor(opts) { options = opts; } makeHtml(s) { seen.push(s); return s; } },
  };
  const doc = makeDocument();
  const sandbox = { document: doc, showdown, sanitizeHtml: () => {}, console };
  const { value: Md } = loadInto(sandbox, [['shared/markdown.js', 'Md']]);
  return { Md, doc, seen, exts, options: plain(options), escaped: (md) => { Md.render(md); return seen.pop(); } };
}
const stage = escapeStage();
const escaped = stage.escaped;

// ---- the whole pipeline ----
// showdown, then html-sanitize.js, then markdown.js — the order both HTML documents load them in.
function realStage() {
  const doc = makeDocument();
  doc.baseURI = EXT_BASE; // the sanitizer resolves an image address against it at call time
  const { value: Md } = loadInto(pageGlobals({ document: doc, console }), [
    'vendor/showdown.min.js',
    'shared/html-sanitize.js',
    ['shared/markdown.js', 'Md'],
  ]);
  return { Md, doc };
}
const real = realStage();
const html = (md) => real.Md.render(md).innerHTML;
const classesOf = (md, tag) => real.Md.render(md).querySelectorAll(tag).map((n) => n.className);

test('M1: a script a description author typed reaches the renderer as words, not as a tag', () => {
  assert.equal(escaped('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('M2: an image rigged to run code on failure is words too', () => {
  assert.equal(escaped('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('M3: ordinary ampersands and less-thans in prose survive as themselves', () => {
  assert.equal(escaped('Use A & B < C'), 'Use A &amp; B &lt; C');
});

test('M4: a line break typed as a tag is the one tag that still works', () => {
  assert.equal(escaped('line one<br>line two'), 'line one<br>line two');
});

test('M5: the line break works in capitals and with a slash too', () => {
  assert.equal(escaped('line<BR />two'), 'line<br>two');
});

test('M6: a quoted line stays a quote', () => {
  assert.equal(escaped('> quoted'), '> quoted');
});

test('M7: a quote inside a quote keeps both markers', () => {
  assert.equal(escaped('>> nested quote'), '>> nested quote');
});

test('M8: a greater-than in the middle of a sentence is not turned into a quote', () => {
  assert.equal(escaped('text > not a quote'), 'text &gt; not a quote');
});

test('M9: code the tester wrapped in backticks is left exactly as typed', () => {
  assert.equal(escaped('`a < b`'), '`a < b`');
});

test('M10: a fenced block is left exactly as typed', () => {
  assert.equal(escaped('```js\nif (a<b) {}\n```'), '```js\nif (a<b) {}\n```');
});

test('M11: one lonely backtick opens nothing, so the whole line is escaped', () => {
  assert.equal(escaped('a ` b < c'), 'a &#96; b &lt; c');
});

test('M12: two code spans keep their contents and the words between them are escaped', () => {
  assert.equal(escaped('`a` and `b` < c'), '`a` and `b` &lt; c');
});

test('M13: an empty pair of backticks is not a code span', () => {
  assert.equal(escaped('``'), '&#96;&#96;');
});

test('M14: a backtick standing outside any code span becomes text', () => {
  assert.equal(escaped('a ` b'), 'a &#96; b');
});

test('M15: a comment the author hid in the description is escaped and then dropped', () => {
  const out = escaped('<!-- secret -->');
  assert.equal(out, '&lt;!-- secret --&gt;');
  const [rule] = stage.exts.get('strip-comments')();
  assert.equal(out.replace(rule.regex, rule.replace), '');
  assert.equal(html('<!-- secret -->'), ''); // and nothing of it reaches the panel
});

test('M16: an unfinished comment is not dropped, so the tester sees what they typed', () => {
  const out = escaped('<!-- unfinished');
  const [rule] = stage.exts.get('strip-comments')();
  assert.equal(out.replace(rule.regex, rule.replace), '&lt;!-- unfinished');
});

test('M17: an empty description, or one that is not text at all, renders without throwing', () => {
  assert.equal(escaped(null), '');
  assert.equal(escaped(undefined), '');
  assert.equal(escaped(42), '42');
});

test('M18: a link the author pointed at javascript keeps its words and loses its address', () => {
  const box = real.Md.render('[x](javascript:alert(1))');
  const a = box.querySelector('a');
  assert.equal(a.textContent, 'x');
  assert.equal(a.getAttribute('href'), null);
});

test('M19: writing the javascript link with an HTML entity does not smuggle it through', () => {
  assert.equal(escaped('[x](java&#115;cript:alert(1))'), '[x](java&amp;#115;cript:alert(1))');
  assert.equal(real.Md.render('[x](java&#115;cript:alert(1))').querySelector('a').getAttribute('href'), null);
});

test('M20: full-width lookalike brackets are shown as the characters they are', () => {
  assert.equal(escaped('＜script＞'), '＜script＞');
  assert.equal(html('＜script＞'), '<p>＜script＞</p>');
});

test('M21: a numbered list under a Steps heading is marked as the steps', () => {
  assert.deepEqual(classesOf('### Steps\n\n1. a\n2. b', 'ol'), ['md-steps']);
});

test('M22: the Ukrainian Steps heading marks its list the same way', () => {
  assert.deepEqual(classesOf('## Кроки\n\n- a', 'ul'), ['md-steps']);
});

test('M23: a list under some other heading is left alone', () => {
  assert.deepEqual(classesOf('### Setup\n\n- a\n\n### Steps\n\n- b', 'ul'), ['', 'md-steps']);
});

test('M24: every list under the Steps heading is marked, and the walk stops at the next heading', () => {
  const md = '### Steps\n\npara one\n\n- a\n\npara two\n\n- b\n\n### Result\n\n- c';
  assert.deepEqual(classesOf(md, 'ul'), ['md-steps', 'md-steps', '']);
});

test('M25: a sub-list inside a step is not itself marked as the steps', () => {
  assert.deepEqual(classesOf('### Steps\n\n- a\n    - a1\n- b', 'ul'), ['md-steps', '']);
});

test('M26: a description with no Steps heading has no steps and nothing is marked', () => {
  const box = real.Md.render('## Notes\n\n- a');
  assert.equal(real.Md.stepLists(box).length, 0);
  assert.deepEqual(box.querySelectorAll('ul').map((n) => n.className), ['']);
  // The same call on a description that does name its steps finds the one list.
  assert.equal(real.Md.stepLists(real.Md.render('## Steps\n\n- a')).length, 1);
});

test('M27: an author who types the steps class by hand cannot make their own list the steps', () => {
  const box = real.Md.render('<h2 class="md-steps">Steps</h2>\n\n- a');
  assert.equal(box.querySelector('h2'), null);              // it never became a heading
  assert.match(box.textContent, /<h2 class="md-steps">Steps<\/h2>/); // the tester sees what they typed
  assert.deepEqual(box.querySelectorAll('ul').map((n) => n.className), ['']);
  // A real heading, in the same renderer, does mark its list.
  assert.deepEqual(classesOf('## Steps\n\n- a', 'ul'), ['md-steps']);
});

test('M28: a rendered description is built off the page and never touches the document', () => {
  const before = real.doc.querySelectorAll('*').length;
  const box = real.Md.render('# hi\n\n- a');
  assert.equal(box.parentNode, null);
  assert.equal(box.tagName, 'DIV');
  assert.equal(real.doc.querySelectorAll('*').length, before);
});

test('M29: rendering into a panel slot replaces everything that was in it', () => {
  const target = real.doc.createElement('section');
  target.append(el('p', null, 'old1'), el('p', null, 'old2'), el('p', null, 'old3'));
  real.Md.into(target, '### Steps\n\n- a');
  assert.equal(target.querySelectorAll('p').length, 0);
  assert.equal(target.innerHTML, real.Md.render('### Steps\n\n- a').innerHTML);
});

test('M30: the renderer is built with exactly the options the web runner uses', () => {
  assert.deepEqual(stage.options, {
    openLinksInNewWindow: true,
    parseImgDimensions: true,
    simplifiedAutoLink: true,
    simpleLineBreaks: true,
    tables: true,
    literalMidWordUnderscores: true,
    tasklists: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
    extensions: ['strip-comments'],
  });
});
