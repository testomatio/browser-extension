// The web runner's pipeline (escape, strip comments, showdown, sanitize); load after showdown.

const Md = (() => {
  // A "Steps"-like heading, in the two languages a test body is written in here.
  const STEPS_HEADING = /step|крок/i;
  // …and its lists' class: the one thing that tells the stylesheet a numbered list is the steps.
  const STEPS_CLASS = 'md-steps';

  // Verbatim from the web (app/helpers/html-markdown.js): only `<br>` and a leading `>` survive.
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

  // The web's `strip-comments`; escaping ran first, so a comment arrives as `&lt;!-- … --&gt;`.
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

  // Every top-level list between a "Steps"-like heading and the next heading.
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

  // Never a node already in the document, never one that skipped shared/html-sanitize.js.
  function render(md) {
    const box = document.createElement('div');
    box.innerHTML = converter.makeHtml(htmlMarkdown(md || ''));
    sanitizeHtml(box); // shared/html-sanitize.js — the one XSS boundary
    // After the sanitizer: added on the way in, author markup could name itself the steps.
    stepLists(box).forEach((list) => list.classList.add(STEPS_CLASS));
    return box;
  }

  function into(target, md) {
    target.replaceChildren(...render(md).childNodes);
  }

  return { render, into, stepLists, STEPS_CLASS };
})();
