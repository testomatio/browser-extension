// What a secret is allowed to become in a step: everything typed is otherwise recorded verbatim,
// and a card, CVV or tax-id field is text/tel, never `type=password`. The label arrives as an argument.

/* global window */
(() => {
  'use strict';
  // Injected on demand, and a same-document re-inject runs the file again: without this the
  // second run throws before the recorder's own latch is ever reached.
  if (window.RecMask) return;
  // Split a developer string (`cardNumber`, `card_number`, `CARD-NUMBER`) into words once,
  // then match whole words only, so `shipping` never reads as a `pin`.
  const words = (s) => String(s || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z\d]+/g, ' ')
    .trim().toLowerCase();

  // Best-effort (Luhn below is the backstop). Entries are written the way `words()` leaves
  // them: `cardnumber` has no seam to split on, so the space in `card ?num` is load-bearing.
  const CARD_NUMBER_WORDS = /\b(card ?num(ber)?|cc ?(num(ber)?|no))\b/;
  const SENSITIVE_WORDS = /\b(card ?num(ber)?|card|cc ?(num(ber)?|no)|cvv|cvc|csc|security code|ssn|social security|passport|otp|passcode|one[- ]?time|exp(iry|iration)?|secret|token|api[- ]?key|pin|iban|routing|account number|tax id)\b/;
  // A revealed password is a `type=text` field (every show/hide eye flips it). Whole words,
  // not a `pass` prefix: `passport` is a government id, masked as "the value" above.
  const PASSWORD_WORDS = /\b(password|passwd|pwd|passphrase)\b/;
  // `card` ALONE is not a card number: a Kanban "Card title" is masked by the list above,
  // and calling that "the card number" would be a confident lie.
  const isCardNumber = (w) => CARD_NUMBER_WORDS.test(w)
    || (/\bcard\b/.test(w) && /\b(number|num|no|pan)\b/.test(w));
  // `autocomplete` is the one signal a site states on purpose rather than by habit.
  const SENSITIVE_AC = /^(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name|one-time-code|new-password|current-password)$/;

  // Spec token order is `section-*`, billing/shipping, the field name, a trailing
  // `webauthn` — so every remaining token is tested, not just the last.
  const acTokens = (el) => ((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase().split(/\s+/)
    .filter((t) => t && t !== 'billing' && t !== 'shipping' && !t.startsWith('section-'));

  // Every string this field could be known by, as one normalized word bag.
  const fieldWords = (el, labelText) => words([el.getAttribute && el.getAttribute('name'), el.id,
    el.placeholder, el.getAttribute && el.getAttribute('aria-label'), labelText && labelText(el)]
    .filter(Boolean).join(' '));

  // 13-19 digits passing Luhn IS a payment card whatever the field is called. `\s` and not
  // ' ': an auto-formatting card input separates groups with a NBSP as often as a space.
  function looksLikeCard(val) {
    const d = String(val).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0;
    for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  // null = the value is safe to record; otherwise the noun the step says INSTEAD of it.
  // Only two nouns are ever certain enough to name; everything else is "the value".
  const isPassword = (el, ac, w) => (el.type || '').toLowerCase() === 'password'
    || PASSWORD_WORDS.test(w) || ac.includes('new-password') || ac.includes('current-password');

  // `val` is handed in by a caller that reads it elsewhere — a contenteditable has no `.value`.
  function maskedAs(el, labelText, val = el.value) {
    const ac = acTokens(el);
    const entered = val == null ? '' : String(val);
    const w = fieldWords(el, labelText); // one DOM walk (labelText), read three times below
    if (isPassword(el, ac, w)) return 'the password';
    if (ac.includes('cc-number') || looksLikeCard(entered) || isCardNumber(w)) return 'the card number';
    if (ac.some((t) => SENSITIVE_AC.test(t)) || SENSITIVE_WORDS.test(w)) return 'the value';
    return null;
  }

  // Under the toggle every field reads alike but a password, which keeps its noun: no
  // value is written either way, and `type=password` is a certainty, not a heuristic.
  const maskedAllAs = (el, labelText) => (isPassword(el, acTokens(el), fieldWords(el, labelText))
    ? 'the password' : 'text');

  // ---- "Never record entered values" -----------------------------------------
  // Read from its OWN top-level key, never off `settings` — that object carries the API
  // token, which has no business in a tab's isolated world. Absent -> OFF.
  const NEVER_KEY = 'stepRecNeverValues';

  // `get()` answers null until the read lands: a value is never emitted on a guess, so a step
  // that beats the read waits on `read` rather than being recorded under a default.
  function watchFlag(storage) {
    let neverValues = null;
    const read = (storage && storage.local ? storage.local.get(NEVER_KEY) : Promise.reject())
      .then((r) => { neverValues = r[NEVER_KEY] === true; })
      .catch(() => { neverValues = false; });
    // A Save mid-recording takes effect on the next step, not the next injection.
    const onChanged = (changes, area) => {
      if (area === 'local' && changes[NEVER_KEY]) neverValues = changes[NEVER_KEY].newValue === true;
    };
    if (storage && storage.onChanged) storage.onChanged.addListener(onChanged);
    return {
      read,
      get: () => neverValues,
      stop: () => { if (storage && storage.onChanged) storage.onChanged.removeListener(onChanged); },
    };
  }

  window.RecMask = { words, isCardNumber, acTokens, fieldWords, looksLikeCard, maskedAs, maskedAllAs, watchFlag };
})();
