// Everything typed is recorded verbatim, and a card or CVV field is text/tel, never `type=password`.

/* global window */
(() => {
  'use strict';
  // A same-document re-inject runs the file again; without this the second run throws.
  if (window.RecMask) return;
  // Whole words only, so `shipping` never reads as a `pin`.
  const words = (s) => String(s || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z\d]+/g, ' ')
    .trim().toLowerCase();

  // `cardnumber` has no seam to split on, so the space in `card ?num` is load-bearing.
  const CARD_NUMBER_WORDS = /\b(card ?num(ber)?|cc ?(num(ber)?|no))\b/;
  const SENSITIVE_WORDS = /\b(card ?num(ber)?|card|card ?holder|name on card|cc ?(num(ber)?|no|name)|cvv2?|cvc2?|csc|security code|ssn|social security|passport|otp|passcode|one[- ]?time|exp(iry|iration)?|mm yy(yy)?|valid thru|valid through|secret|token|api[- ]?key|pin|iban|routing|account number|tax id)\b/;
  // A revealed password is `type=text`; whole words, since `passport` is a government id.
  const PASSWORD_WORDS = /\b(password|passwd|pwd|passphrase)\b/;
  // `card` alone is not a card number: calling a Kanban "Card title" that would be a lie.
  const isCardNumber = (w) => CARD_NUMBER_WORDS.test(w)
    || (/\bcard\b/.test(w) && /\b(number|num|no|pan)\b/.test(w));
  // `autocomplete` is the one signal a site states on purpose rather than by habit.
  const SENSITIVE_AC = /^(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name|one-time-code|new-password|current-password)$/;

  // Spec token order ends in the field name or a trailing `webauthn`, so every token is tested.
  const acTokens = (el) => ((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase().split(/\s+/)
    .filter((t) => t && t !== 'billing' && t !== 'shipping' && !t.startsWith('section-'));

  const fieldWords = (el, labelText) => words([el.getAttribute && el.getAttribute('name'), el.id,
    el.placeholder, el.getAttribute && el.getAttribute('aria-label'), labelText && labelText(el)]
    .filter(Boolean).join(' '));

  // 13-19 digits passing Luhn is a card; `\s` since card inputs separate groups with a NBSP too.
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

  // null = safe to record, else the noun the step says instead; only two nouns are certain enough.
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

  // Under the toggle every field reads alike but a password: `type=password` is a certainty.
  const maskedAllAs = (el, labelText) => (isPassword(el, acTokens(el), fieldWords(el, labelText))
    ? 'the password' : 'text');

  // Its own key, never off `settings`: that object carries the API token, which has no place in a tab.
  const NEVER_KEY = 'stepRecNeverValues';

  // `get()` answers null until the read lands: a step that beats it waits on `read`, not a default.
  function watchFlag(storage, onChange) {
    let neverValues = null;
    // Guarded: `read` gates every recorded step, and a watcher that throws must not poison it.
    const tell = () => { try { if (onChange) onChange(neverValues); } catch { /* not the flag's problem */ } };
    const read = (storage && storage.local ? storage.local.get(NEVER_KEY) : Promise.reject())
      .then((r) => { neverValues = r[NEVER_KEY] === true; })
      .catch(() => { neverValues = false; })
      .then(tell);
    // A Save mid-recording takes effect on the next step, not the next injection.
    const onChanged = (changes, area) => {
      if (area !== 'local' || !changes[NEVER_KEY]) return;
      const next = changes[NEVER_KEY].newValue === true;
      if (next === neverValues) return;
      neverValues = next;
      tell();
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
