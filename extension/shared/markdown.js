// Shared markdown renderer (IIFE global `Md`). ONE `marked` configuration and
// ONE way into the document for the whole extension: the panel's step body and
// failure log (sidepanel/screens/test-view.js) and the editor's Preview tab
// (editor/editor.js) all come through here. Each of them used to call
// `marked.parse(md, { async: false })` and then `sanitizeHtml()` on its own —
// three copies of a renderer that MUST agree, since a tester reads the same
// test body in all three places, and three chances to forget the sanitize call
// on the way in.
//
// `render()` hands back a DETACHED <div>, already sanitized, for the caller to
// take the children out of: the panel needs that div to read its steps out of
// before it appends anything (parseSteps), and returning an HTML string would
// have put the innerHTML assignment — the XSS boundary — back in the callers.
//
// Zero-build classic script (MV3 CSP: no inline scripts), same plain-IIFE-global
// style as shared/html-sanitize.js. Load AFTER vendor/marked.min.js and
// shared/html-sanitize.js, before any caller.

const Md = (() => {
  // A "Steps"-like heading, in the two languages a test body is written in here.
  const STEPS_HEADING = /step|крок/i;
  // …and the class the lists under it are stamped with. It is the ONE thing that
  // tells the stylesheet a numbered list is the STEPS — which CSS cannot work
  // out on its own, since the answer is the TEXT of a heading two elements back.
  // Without it every `1. 2. 3.` in a body — a list of accounts, a list of URLs —
  // came out wearing the steps' numbered coins and their rail.
  const STEPS_CLASS = 'md-steps';

  const OPTIONS = {
    async: false,
    // A single newline is a line break, not a space. Plain markdown folds soft
    // breaks into one running paragraph, so a body written one step per line
    // ("line 1 / line 2 / line 3") reads as "line 1 line 2 line 3" the moment
    // it is rendered — the Markdown tab and the Preview tab of the same editor
    // showing two different documents. Testomat's own web editor keeps those
    // breaks; a test body is a list of things to do, and the author's lines are
    // the list. Blank-line paragraphs, lists and headings are unaffected.
    breaks: true,
  };

  // The lists that hold a test's STEPS: every top-level list between a
  // "Steps"-like heading and the next heading. One walk, one heuristic — the
  // panel parses its tickable step rows out of exactly these lists
  // (sidepanel/screens/test-view.js) and the stylesheet numbers exactly these
  // lists, and the two must never disagree about which list is the steps.
  function stepLists(container) {
    const headings = [...container.querySelectorAll('h1,h2,h3,h4')];
    const heading = headings.find((h) => STEPS_HEADING.test(h.textContent));
    if (!heading) return [];
    const lists = [];
    let node = heading.nextElementSibling;
    while (node && !/^H[1-4]$/.test(node.tagName)) {
      if (node.tagName === 'UL' || node.tagName === 'OL') lists.push(node);
      node = node.nextElementSibling;
    }
    return lists;
  }

  // markdown -> sanitized detached <div>. Never returns a node that is already
  // in the document, and never one that skipped shared/html-sanitize.js.
  function render(md) {
    const box = document.createElement('div');
    box.innerHTML = marked.parse(md || '', OPTIONS);
    sanitizeHtml(box); // shared/html-sanitize.js — the one XSS boundary
    // AFTER the sanitizer, never before: this class is ours to add, and adding
    // it to author markup on the way in would let a body name itself the steps.
    stepLists(box).forEach((list) => list.classList.add(STEPS_CLASS));
    return box;
  }

  // …and the common ending: replace whatever `target` holds with the rendering.
  function into(target, md) {
    target.replaceChildren(...render(md).childNodes);
  }

  return { render, into, stepLists, OPTIONS, STEPS_CLASS };
})();
