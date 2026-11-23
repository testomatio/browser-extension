const ApiPeople = (() => {
  // Fields v2 does not serialize, in one read; substatus counters are keyed by the raw reply string.
  function runInfoOf(doc) {
    const attrs = doc?.data?.attributes || {};
    const raw = attrs['substatuses-counts'];
    let substatusCounts = null; // null (not {}) = the payload carries no counters at all
    if (raw && typeof raw === 'object') {
      substatusCounts = {};
      for (const [key, val] of Object.entries(raw)) {
        const n = Number(val);
        if (key && Number.isFinite(n) && n > 0) substatusCounts[key] = n;
      }
    }
    return {
      substatusCounts,
      status: attrs.status || null,
      // null (not false) when omitted, so a write response cannot silently unlock an archived run.
      isArchived: attrs['is-archived'] == null ? null : !!attrs['is-archived'],
      ciBuildUrl: attrs['ci-build-url'] || null,
      duration: Number(attrs.duration) || 0, // seconds (RunSerializer), 0 while unfinished
      launchedAt: attrs['launched-at'] || null,
      finishedAt: attrs['finished-at'] || null,
      ...runPeopleOf(doc),
    };
  }

  // A person arrives as a string, a record, or a relationship into `included`; no contract pins which.
  const PERSON_KEYS = {
    executedBy: ['executed-by', 'launched-by', 'user'],
    createdBy: ['created-by', 'author', 'owner'],
  };

  function personOf(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const s = value.trim();
      if (!s) return null;
      return s.includes('@') ? { name: '', email: s } : { name: s, email: '' };
    }
    if (typeof value !== 'object') return null;
    const a = value.attributes || value; // a JSON:API resource, or a flat record
    const name = String(a.name || a.username || a.title || '').trim();
    const email = String(a.email || '').trim();
    return name || email ? { name, email } : null;
  }

  const includedRef = (doc, ref) =>
    (ref && (doc?.included || []).find((n) => n.type === ref.type && String(n.id) === String(ref.id))) || null;

  function includedPerson(doc, rel) {
    const ref = rel?.data;
    if (!ref || Array.isArray(ref)) return null;
    return personOf(includedRef(doc, ref));
  }

  function peopleOf(doc, value) {
    const list = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return list.map((v) => personOf(v) || personOf(includedRef(doc, v))).filter(Boolean);
  }

  // A name-matching key can hold a setting ("assign-mode":"none") or the word for nobody, not people.
  const SETTING_KEY = /(strategy|mode|policy|method|kind|type|option|enabled|state|status|auto|allow)/i;
  const NOBODY = /^(none|nobody|no[-_\s]?one|unassigned|not[-_\s]?assigned|n\/?a|null|nil|false|true|any|all|auto|everyone|manual)$/i;
  function peopleByKey(doc, pattern) {
    const attrs = doc?.data?.attributes || {};
    const rels = doc?.data?.relationships || {};
    const out = [];
    const seen = new Set();
    const take = (people) => {
      for (const p of people) {
        // Address-less and with no letter in the "name": a bare id, not a person.
        if (!p.email && !/\p{L}/u.test(p.name)) continue;
        if (!p.email && NOBODY.test(p.name.trim())) continue;
        const key = (p.email || p.name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    };
    for (const [key, value] of Object.entries(attrs)) {
      if (pattern.test(key) && !/(^|[-_])ids?$|count/i.test(key) && !SETTING_KEY.test(key)) {
        take(peopleOf(doc, value));
      }
    }
    for (const [key, rel] of Object.entries(rels)) {
      if (pattern.test(key) && !SETTING_KEY.test(key)) take(peopleOf(doc, rel?.data));
    }
    return out;
  }

  // undefined (not []) when the payload says nothing, so a merge cannot blank an earlier read.
  function runAssigneesOf(doc) {
    const found = peopleByKey(doc, /assign/i);
    return found.length ? found : undefined;
  }

  const PERSON_PATTERNS = {
    executedBy: /^(executed|launched|started|ran)([-_]?by)?$|^user$/i,
    createdBy: /^(created[-_]?by|creator|author|owner)$/i,
  };

  function runPeopleOf(doc) {
    const attrs = doc?.data?.attributes || {};
    const rels = doc?.data?.relationships || {};
    const people = {};
    for (const [field, keys] of Object.entries(PERSON_KEYS)) {
      let found = null;
      for (const key of keys) {
        found = personOf(attrs[key]) || includedPerson(doc, rels[key]);
        if (found) break;
      }
      if (!found) [found] = peopleByKey(doc, PERSON_PATTERNS[field]);
      // Merged over the open run's info, so a write response that omits people must not blank it.
      if (found) people[field] = found;
    }
    const assignees = runAssigneesOf(doc);
    if (assignees) people.assignees = assignees;
    return people;
  }

  return { runInfoOf, personOf, includedRef, includedPerson, peopleOf, peopleByKey,
    runAssigneesOf, runPeopleOf };
})();
