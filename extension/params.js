// Parametrized-test placeholder substitution — an EXACT mirror of the product's own
// `descriptionWithExample.js`, down to the non-"0" rule and the DOUBLE QUOTES it wraps values in.

const TestomatParams = (() => {
  // Unchanged when there is nothing to substitute, so callers can render the raw placeholders + a badge.
  function substitute(text, params, example) {
    if (typeof text !== 'string' || !text) return text || '';
    if (!Array.isArray(params) || !Array.isArray(example)) return text;
    let description = text;
    for (let i in params) {
      if (typeof params[i] === 'string' && params[i].trim() !== '' && params[i].trim() !== '0') {
        let param = params[i];
        description = description.replace(new RegExp(`\\$\{${param}\}`, 'g'), '"' + example[i] + '"');
        description = description.replace(new RegExp(`\{\{${param}\}\}`, 'g'), '"' + example[i] + '"');
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
