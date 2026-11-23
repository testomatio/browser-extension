// What the step recorder and the AI polish write into a test body; pure, no DOM.

/* global MdSections */
const RecFormat = (() => {
  const STEPS_OPTS = { ordered: true };

  // The one place the prefix is written: a tester's own `Expected:`, in any form, must not double it.
  const asExpected = (s) => `Expected: ${String(s).replace(/^[\s*_-]*expected[*_\s]*:?[*_\s]*/i, '').trim()}`;

  // The body's own steps heading (a Ukrainian test keeps `### Кроки`), else `Steps`.
  const stepsHeading = (md) => MdSections.findHeading(md, MdSections.STEPS_HEADING) || 'Steps';

  // An expected result is its step's `- Expected:` sub-bullet, as test-view.js `extractExpected` reads.
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

  // Callers pass `heading` when they name the section twice (rec-session counts items before this).
  function insertRecorded(md, { steps, expected, leadSubs }, heading = stepsHeading(md)) {
    let out = md;
    if (steps.length || leadSubs.length) out = MdSections.insert(out, heading, steps, { ...STEPS_OPTS, leadSubs });
    // `Expected` stays English: nothing reads it back, and it opens only with no step before it.
    if (expected.length) out = MdSections.insert(out, 'Expected', expected.map((t) => ({ text: t, subs: [] })), { ordered: false });
    return out;
  }

  // The server wraps the section in these markers, in whichever field answered.
  const POLISH_START = '<!-- ![START polished_steps]! -->';
  const POLISH_END = '<!-- ![END polished_steps]! -->';
  function polishedSection(res) {
    const raw = (res && res.steps) || (res && res.text) || '';
    const a = raw.indexOf(POLISH_START);
    const b = raw.indexOf(POLISH_END);
    return a !== -1 && b > a ? raw.slice(a + POLISH_START.length, b) : raw;
  }

  // The prompt asks the model for `*Expected*:` sub-lines, a tester writes `- Expected:`; take both.
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

  // The instance's own refusal text beats our wording; `ApiError.message` carries the JSON body.
  function serverMessage(e) {
    try {
      const j = JSON.parse((e && e.message) || '');
      const m = j && (j.error || j.details || j.message);
      if (m) return String(Array.isArray(m) ? m.join('; ') : m);
    } catch { /* not JSON — an ApiError may already carry the server's sentence as text */ }
    const said = e && e.kind === 'http' && typeof e.message === 'string' ? e.message.trim() : '';
    return said && !/^HTTP \d+$/.test(said) ? said : '';
  }

  // 'none' (the instance has no AI), 'off' (not for this company), 'on' or 'unknown'.
  function aiStatusOf(doc) {
    const a = (doc && doc.data && doc.data.attributes) || {};
    const cs = a['company-settings'] || a.company_settings;
    if (!cs || typeof cs !== 'object') return 'unknown';
    const has = (k) => k in cs || k.replace(/_/g, '-') in cs;
    const pick = (k) => (k in cs ? cs[k] : cs[k.replace(/_/g, '-')]);
    if (pick('ai_hidden') === true) return 'none';
    // Present but not true is no AI: a company with no subscription is answered null, not false.
    if (!has('ai_enabled')) return 'unknown';
    return pick('ai_enabled') === true ? 'on' : 'off';
  }

  // What the server says, instead of a rewrite, when the company has no AI.
  function aiRefused(res, e) {
    if (e) return e.status === 422 && /not available in your subscription plan|ai is not enabled/i.test(serverMessage(e));
    return /^\s*AI is disabled\s*$/i.test((res && (res.steps || res.text)) || '');
  }

  return {
    STEPS_OPTS, stepsHeading, splitRecorded, insertRecorded,
    polishedSection, asExpected, parsePolishedItems, serverMessage, aiStatusOf, aiRefused,
  };
})();
