// Shared markdown renderer (IIFE global `Md`) — the web runner's exact pipeline:
// escape, strip comments, showdown, sanitize. Load after vendor/showdown.min.js.

const Md = (() => {
  // A "Steps"-like heading, in the two languages a test body is written in here.
  const STEPS_HEADING = /step|крок/i;
  // …and the class its lists are stamped with: the ONE thing that tells the
  // stylesheet a numbered list is the STEPS. CSS cannot work that out alone.
  const STEPS_CLASS = 'md-steps';

  // Verbatim from the web (app/helpers/html-markdown.js): `<br>` and a leading
  // `>` survive, every other angle bracket becomes text — raw HTML never renders.
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`/g, '&#96;')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/^(&gt;)+/gm, (match) => match.replace(/&gt;/g, '>'));
  }

  // Fenced and inline code pass through untouched; the gaps between are escaped.
  function htmlMarkdown(str = '') {
    if (typeof str !== 'string') str = str == null ? '' : String(str);
    const parts = [];
    const codeBlockRegex = /```[\s\S]*?```|`[^`]+`/g;
    let lastIndex = 0;
    let match;
    while ((match = codeBlockRegex.exec(str)) !== null) {
      parts.push(escapeHtml(str.slice(lastIndex, match.index)));
      parts.push(match[0]);
      lastIndex = match.index + match[0].length;
    }
    parts.push(escapeHtml(str.slice(lastIndex)));
    return parts.join('');
  }

  // The web's `strip-comments` extension. Escaping ran first, so an HTML comment
  // arrives as `&lt;!-- … --&gt;`.
  showdown.extension('strip-comments', () => [
    { type: 'lang', regex: /&lt;!--[\s\S]*?--&gt;/g, replace: '' },
  ]);

  // One converter, the web's options (testomatio-front config/environment.js).
  const converter = new showdown.Converter({
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

  // A test's STEPS: every top-level list between a "Steps"-like heading and the
  // next heading. The panel's step rows and the stylesheet read the same lists.
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

  // markdown -> sanitized detached <div>. Never a node already in the document,
  // never one that skipped shared/html-sanitize.js.
  function render(md) {
    const box = document.createElement('div');
    box.innerHTML = converter.makeHtml(htmlMarkdown(md || ''));
    sanitizeHtml(box); // shared/html-sanitize.js — the one XSS boundary
    // AFTER the sanitizer, never before: adding this class on the way in would
    // let author markup name itself the steps.
    stepLists(box).forEach((list) => list.classList.add(STEPS_CLASS));
    return box;
  }

  // …and the common ending: replace whatever `target` holds with the rendering.
  function into(target, md) {
    target.replaceChildren(...render(md).childNodes);
  }

  return { render, into, stepLists, STEPS_CLASS };
})();
