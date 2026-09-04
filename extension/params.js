// Parametrized-test placeholder substitution — an EXACT mirror of the product's own
// `descriptionWithExample.js`, down to the non-"0" rule and the DOUBLE QUOTES it wraps values in.

const TestomatParams = (() => {
  // A column name is whatever the parameters grid let the tester type: `price(usd)` would compile
  // to a capture group and `a.b` would match `axb`, so it is escaped before it becomes a pattern.
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Unchanged when there is nothing to substitute, so callers can render the raw placeholders + a badge.
  function substitute(text, params, example) {
    if (typeof text !== 'string' || !text) return text || '';
    if (!Array.isArray(params) || !Array.isArray(example)) return text;
    let description = text;
    for (let i in params) {
      if (typeof params[i] === 'string' && params[i].trim() !== '' && params[i].trim() !== '0') {
        // A cell this row does not have stays a raw placeholder — an incomplete row must read as
        // incomplete, not as a test that says "undefined". An empty cell is a value, and substitutes.
        if (example[i] == null) continue;
        let param = escapeRe(params[i]);
        // The braces are escaped too: unescaped, a column named `2` reads as the quantifier
        // `{2}` and the placeholder is never found.
        description = description.replace(new RegExp(`\\$\\{${param}\\}`, 'g'), '"' + example[i] + '"');
        description = description.replace(new RegExp(`\\{\\{${param}\\}\\}`, 'g'), '"' + example[i] + '"');
      }
    }
    return description;
  }

  // A raw `${..}`/`{{..}}` left in the text means substitution could not run (missing example row).
  const RAW_PLACEHOLDER = /\$\{[^}]+\}|\{\{[^}]+\}\}/;
  const hasPlaceholder = (text) => typeof text === 'string' && RAW_PLACEHOLDER.test(text);

  // Parametrized iff at least one param name is usable — the same test the substitution loop uses.
  const isParametrized = (params) =>
    Array.isArray(params) && params.some(
      (p) => typeof p === 'string' && p.trim() !== '' && p.trim() !== '0');

  return { substitute, hasPlaceholder, isParametrized };
})();
