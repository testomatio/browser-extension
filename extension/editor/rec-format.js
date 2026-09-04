// What the step recorder and the AI polish write into a test body (IIFE global `RecFormat`):
// recorded entries → items, items → markdown, the polish answer → items back. Pure, no DOM.

/* global MdSections */
const RecFormat = (() => {
  // ---- recorded-step insertion (step recorder) ----------------------------
  // An item is `{text, subs}` — the nested `- Expected: …` lines (#78). The section arithmetic
  // itself lives in md-sections.js, which splices rather than re-emits: everything the tester
  // wrote around the list stays as it is.
  const STEPS_OPTS = { ordered: true };

  // The one place that prefix is written: a tester who typed `Expected:` themselves — bulleted,
  // emphasised or in any case — must not be handed a second one.
  const asExpected = (s) => `Expected: ${String(s).replace(/^[\s*_-]*expected[*_\s]*:?[*_\s]*/i, '').trim()}`;

  // The heading the recorded steps join: whatever this body already calls its steps section, so
  // a test written in Ukrainian keeps its own `### Кроки`, and `Steps` when it has none.
  const stepsHeading = (md) => MdSections.findHeading(md, MdSections.STEPS_HEADING) || 'Steps';

  // #78/#91: an expected result belongs to the step it followed, as the `- Expected: …`
  // sub-bullet the panel renders inline (sidepanel/screens/test-view.js `extractExpected`).
  function splitRecorded(entries, attachToPrior) {
    const steps = [];
    const expected = [];
    const leadSubs = [];
    for (const e of entries) {
      const text = (e && e.text) || '';
      if (!text) continue;
      if (e.kind !== 'expected') { steps.push({ text, subs: [] }); continue; }
      if (steps.length) steps[steps.length - 1].subs.push(asExpected(text));
      else if (attachToPrior) leadSubs.push(asExpected(text));
      else expected.push(text); // its own `### Expected` bullet, written with no prefix at all
    }
    return { steps, expected, leadSubs };
  }

  // `heading` is resolved by the caller when it has to name the same section twice (rec-session
  // counts the items there BEFORE this insert); on its own the body decides.
  function insertRecorded(md, { steps, expected, leadSubs }, heading = stepsHeading(md)) {
    let out = md;
    if (steps.length || leadSubs.length) out = MdSections.insert(out, heading, steps, { ...STEPS_OPTS, leadSubs });
    // `Expected` stays English on purpose: nothing in the extension reads that section back — the
    // panel reads the `- Expected: …` sub-bullets above — and it only opens with no step before it.
    if (expected.length) out = MdSections.insert(out, 'Expected', expected.map((t) => ({ text: t, subs: [] })), { ordered: false });
    return out;
  }

  // ---- AI polish (#23): the recording's own items, rewritten in place --------
  // The server wraps the section in these markers inside `text`; `data.polished_steps` may
  // carry them too, so the same cut runs on whichever field answered.
  const POLISH_START = '<!-- ![START polished_steps]! -->';
  const POLISH_END = '<!-- ![END polished_steps]! -->';
  function polishedSection(res) {
    const raw = (res && res.steps) || (res && res.text) || '';
    const a = raw.indexOf(POLISH_START);
    const b = raw.indexOf(POLISH_END);
    return a !== -1 && b > a ? raw.slice(a + POLISH_START.length, b) : raw;
  }

  // `N. sentence`, each with any number of `Expected: …` sub-lines under it, bulleted or not and
  // emphasised or not — the prompt asks the model for `*Expected*:` (#65), a tester writes `- `.
  function parsePolishedItems(section) {
    const items = [];
    for (const line of String(section || '').split('\n')) {
      const num = line.match(/^\s*\d+[.)]\s+(.*\S.*)$/);
      if (num) { items.push({ text: num[1].trim(), subs: [] }); continue; }
      if (!items.length) continue;
      const sub = line.match(/^\s*(?:[-*+]\s+)?[*_]{0,2}(Expected\b.*)$/i);
      if (sub) items[items.length - 1].subs.push(asExpected(sub[1]));
    }
    return items;
  }

  // A refusal the instance explains itself (a 422: "Ai is not available in your subscription
  // plan") is worth more than our own wording — `ApiError.message` carries the JSON body.
  function serverMessage(e) {
    try {
      const j = JSON.parse((e && e.message) || '');
      const m = j && (j.error || j.details || j.message);
      if (m) return String(Array.isArray(m) ? m.join('; ') : m);
    } catch { /* not JSON — we have no better words than our own */ }
    return '';
  }

  return {
    STEPS_OPTS, stepsHeading, splitRecorded, insertRecorded,
    polishedSection, asExpected, parsePolishedItems, serverMessage,
  };
})();
