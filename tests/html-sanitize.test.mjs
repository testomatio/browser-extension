#!/usr/bin/env node
// #149: a test's description is written by whoever can edit the project and can carry raw HTML.
// extension/shared/html-sanitize.js is the one place that strips it before the tester's panel draws
// it — so a description cannot run a script, move the tester somewhere, or reach back into the
// extension's own pages, which is how the host's session used to leak.
// Run: node --test tests/html-sanitize.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, pageGlobals, EXT_BASE } from './helpers/shared-harness.mjs';
import { makeDocument, el } from './helpers/mini-dom.mjs';

// html-sanitize.js declares two top-level consts, so it loads once per context; one context for the
// whole file is enough because sanitize() keeps no state between calls.
const { value: HtmlSanitize } = loadInto(pageGlobals(), [['shared/html-sanitize.js', 'HtmlSanitize']]);
const doc = makeDocument();

// A container holding the description as the panel would have parsed it, already sanitized.
function clean(html) {
  const box = doc.createElement('div');
  box.innerHTML = html;
  HtmlSanitize.sanitize(box);
  return box;
}
const tags = (box) => box.querySelectorAll('*').map((n) => n.tagName);
const attrOf = (box, sel, name) => {
  const node = box.querySelector(sel);
  return node ? node.getAttribute(name) : undefined;
};
// The href a description keeps, or null when the sanitizer took it away.
const hrefAfter = (value) => attrOf(clean(`<a href="${value}">click me</a>`), 'a', 'href');

test('S1: a description that carries a script tag loses the whole tag', () => {
  const box = clean('<p>before</p><script>alert(1)</script><p>after</p>');
  assert.deepEqual(tags(box), ['P', 'P']);
  assert.equal(box.textContent, 'beforeafter'); // the script body goes with it
});

const DROPPED = [
  ['a style block', '<style>body{display:none}</style>', 'STYLE'],
  ['an embedded frame', '<iframe src="https://evil.example"></iframe>', 'IFRAME'],
  ['an object', '<object data="https://evil.example/x.swf"></object>', 'OBJECT'],
  ['an embed', '<embed src="https://evil.example/x">', 'EMBED'],
  ['a preloading link', '<link rel="preload" href="https://evil.example/x">', 'LINK'],
  ['a refreshing meta', '<meta http-equiv="refresh" content="0;url=https://evil.example">', 'META'],
  ['a base tag that would retarget every link', '<base href="https://evil.example/">', 'BASE'],
  ['a form that would post somewhere', '<form action="https://evil.example"></form>', 'FORM'],
];
for (const [what, html, tag] of DROPPED) {
  test(`S2: ${what} in a description is removed entirely`, () => {
    const box = clean(`<p>kept</p>${html}`);
    assert.deepEqual(tags(box), ['P']);
    assert.equal(box.querySelector(tag.toLowerCase()), null);
  });
}

test('S3: an image that tries to run code on failure keeps the picture and loses the code', () => {
  const box = clean('<img src=x onerror="alert(1)">');
  assert.equal(attrOf(box, 'img', 'onerror'), null);
  // `x` resolves against the panel's own page, so the picture itself is allowed to load.
  assert.equal(attrOf(box, 'img', 'src'), 'x');
});

test('S4: a handler written in capitals is removed just the same', () => {
  assert.equal(attrOf(clean('<div ONCLICK="x">hi</div>'), 'div', 'onclick'), null);
  // …and the module lowercases the name itself, for a node some other code built by hand.
  const node = el('div');
  node.setAttribute('ONCLICK', 'x');
  const box = doc.createElement('div');
  box.append(node);
  HtmlSanitize.sanitize(box);
  assert.equal(node.getAttribute('ONCLICK'), null);
});

test('S5: a link that would run javascript stops being a link but keeps its words', () => {
  const box = clean('<a href="javascript:alert(1)">click me</a>');
  assert.equal(attrOf(box, 'a', 'href'), null);
  assert.equal(box.textContent, 'click me'); // the text a tester reads survives
});

test('S6: padding the javascript link with spaces does not get it through', () => {
  assert.equal(hrefAfter('  javascript:alert(1)'), null);
});

test('S7: writing JaVaScRiPt in mixed case does not get it through', () => {
  assert.equal(hrefAfter('JaVaScRiPt:alert(1)'), null);
});

test('S8: a link carrying a whole HTML page inside it is refused', () => {
  assert.equal(hrefAfter('data:text/html,hello'), null);
});

test('S9: a vbscript link is refused', () => {
  assert.equal(hrefAfter('vbscript:msgbox'), null);
});

test('S10: a link to the extension\'s own handoff file is refused', () => {
  // The host's session file sits next to the panel; a description that could link to it leaked it.
  assert.equal(hrefAfter('/handoff.json'), null);
});

test('S11: a link into the extension\'s own viewer page is refused', () => {
  assert.equal(hrefAfter('viewer/viewer.html?url=https://evil.example'), null);
});

test('S12: a link written without a scheme is refused', () => {
  assert.equal(hrefAfter('//evil.example/p'), null);
});

test('S13: a link to a heading further down the same description still works', () => {
  const box = clean('<a href="#top">back to the top</a>');
  assert.equal(attrOf(box, 'a', 'href'), '#top');
});

test('S14: something that only looks like an anchor is refused', () => {
  assert.equal(hrefAfter('##'), null);
  assert.equal(hrefAfter('#a#b'), null);
  assert.equal(hrefAfter('#top'), '#top'); // the real anchor beside them still works
});

test('S15: an ordinary web link survives and opens in a new tab, cut off from the panel', () => {
  const box = clean('<a href="https://app.testomat.io/x">the run</a>');
  const a = box.querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://app.testomat.io/x');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener');
});

test('S16: a mailto link survives', () => {
  assert.equal(hrefAfter('mailto:qa@x.io'), 'mailto:qa@x.io');
});

test('S17: an ftp link is refused', () => {
  assert.equal(hrefAfter('ftp://x/y'), null);
});

test('S18: a drawing that links out through xlink loses that link too', () => {
  const box = clean('<svg><use xlink:href="javascript:x"></use></svg>');
  assert.equal(attrOf(box, 'use', 'xlink:href'), null);
});

test('S19: a stray button that would submit to javascript loses its target', () => {
  const box = clean('<button formaction="javascript:x">go</button>');
  assert.equal(attrOf(box, 'button', 'formaction'), null);
  assert.equal(box.querySelector('button').textContent, 'go');
});

test('S20: a picture stored on the tester\'s own instance still loads', () => {
  const box = clean('<img src="/rails/active_storage/x.png">');
  assert.equal(attrOf(box, 'img', 'src'), '/rails/active_storage/x.png');
  assert.equal(new URL('/rails/active_storage/x.png', EXT_BASE).pathname, '/rails/active_storage/x.png');
});

test('S21: a picture pulled from a stranger\'s server is left in place here, on purpose', () => {
  // https is a safe scheme, so the sanitizer keeps it; the block that matters is the downstream
  // fetch that refuses to leave the instance. Pinned so nobody patches the wrong layer.
  assert.equal(attrOf(clean('<img src="https://evil.example/px.png">'), 'img', 'src'),
    'https://evil.example/px.png');
});

test('S22: a picture whose address is code, or a whole file inline, is refused', () => {
  assert.equal(attrOf(clean('<img src="javascript:x">'), 'img', 'src'), null);
  assert.equal(attrOf(clean('<img src="data:image/svg+xml,<svg/>">'), 'img', 'src'), null);
});

test('S23: a video poster pointing at code is refused, and an object is gone altogether', () => {
  assert.equal(attrOf(clean('<video poster="javascript:x"></video>'), 'video', 'poster'), null);
  assert.equal(clean('<object data="https://evil.example/x"></object>').querySelector('object'), null);
});

test('S24: the three attributes a scheme check cannot judge are dropped whatever they hold', () => {
  const box = clean('<img srcset="https://evil.example/a.png 1x"><a href="https://x.io/p"'
    + ' ping="https://evil.example/track">t</a><div srcdoc="<script>alert(1)</script>">d</div>');
  assert.equal(attrOf(box, 'img', 'srcset'), null);
  assert.equal(attrOf(box, 'a', 'ping'), null);
  assert.equal(attrOf(box, 'div', 'srcdoc'), null);
  assert.equal(attrOf(box, 'a', 'href'), 'https://x.io/p'); // the ordinary link beside them stays
  // On an <iframe> the whole element goes first, so its srcdoc never gets that far.
  assert.equal(clean('<iframe srcdoc="<script>alert(1)</script>"></iframe>').querySelector('iframe'), null);
});

test('S25: five handlers hidden among thirty-five ordinary attributes all go, and only they', () => {
  const on = ['onclick', 'onerror', 'onload', 'onmouseover', 'ONFOCUS'];
  const plain = Array.from({ length: 35 }, (_, i) => `data-a${i}`);
  const html = `<p ${[...on, ...plain].map((n) => `${n}="v${n}"`).join(' ')}>x</p>`;
  const p = clean(html).querySelector('p');
  for (const name of on) assert.equal(p.getAttribute(name.toLowerCase()), null, name);
  for (const name of plain) assert.equal(p.getAttribute(name), `v${name}`, name);
  assert.equal(p.attributes.length, 35);
});

test('S26: a javascript link buried six elements deep is found all the same', () => {
  const box = clean('<div><span><em><b><i><a href="javascript:x">deep</a></i></b></em></span></div>');
  assert.equal(attrOf(box, 'a', 'href'), null);
  assert.equal(box.textContent, 'deep');
});

test('S27: a link to a lookalike domain is kept here — the instance check is elsewhere', () => {
  // The `а` is Cyrillic. It is a valid https URL, so this layer keeps it; only the fetch that
  // refuses to leave the instance can tell the two apart.
  const url = 'https://аpp.testomat.io/x';
  assert.equal(hrefAfter(url), url);
});

test('S28: a link with a null byte in it, and a huge one, are handled without throwing', () => {
  assert.equal(hrefAfter('https://x.io/%00'), 'https://x.io/%00');
  const huge = `https://x.io/${'a'.repeat(100000)}`;
  assert.equal(hrefAfter(huge), huge);
});

test('S29: an empty description is left exactly as it is', () => {
  const box = doc.createElement('div');
  HtmlSanitize.sanitize(box);
  assert.equal(box.childNodes.length, 0);
  assert.equal(box.innerHTML, '');
  // The same call on a description that does hold something still changes it.
  assert.equal(clean('<a href="javascript:x">t</a>').querySelector('a').getAttribute('href'), null);
});

test('S30: a link with nowhere to go is not turned into a new-tab link', () => {
  const a = clean('<a>just words</a>').querySelector('a');
  assert.equal(a.getAttribute('target'), null);
  assert.equal(a.getAttribute('rel'), null);
  // …while the one right beside it that does have an address gets both.
  assert.equal(clean('<a href="https://x.io/p">go</a>').querySelector('a').target, '_blank');
});
