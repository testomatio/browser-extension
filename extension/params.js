// Parametrized-test placeholder substitution (US2). Pure: no DOM, no API.
// EXACT mirror of the product frontend helper
// `testomatio-front/app/helpers/descriptionWithExample.js:11-17`: for each
// param name that is a non-empty, non-"0" string, global-replace `${name}` and
// `{{name}}` with the positionally-aligned example value WRAPPED IN DOUBLE
// QUOTES — byte-identical to what the web runner renders. `params` (aligned
// name array, from `attributes.test.params`) and `example` (positional value
// array, from `attributes.example`) align by index.

const TestomatParams = (() => {
  // Substitute example values into raw markdown. Returns `text` unchanged when
  // there is nothing to substitute (no params/example) so callers can render
  // raw placeholders + a badge in degraded/missing-data modes (FR-007).
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

  // True when `text` still carries a raw `${..}` or `{{..}}` placeholder — the
  // signal that substitution could not run (missing example row / degraded).
  const RAW_PLACEHOLDER = /\$\{[^}]+\}|\{\{[^}]+\}\}/;
  const hasPlaceholder = (text) => typeof text === 'string' && RAW_PLACEHOLDER.test(text);

  // A test is parametrized iff it has at least one usable (non-empty, non-"0")
  // param name — the same acceptance test the substitution loop uses.
  const isParametrized = (params) =>
    Array.isArray(params) && params.some(
      (p) => typeof p === 'string' && p.trim() !== '' && p.trim() !== '0');

  return { substitute, hasPlaceholder, isParametrized };
})();
