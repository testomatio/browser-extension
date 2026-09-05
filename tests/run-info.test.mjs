#!/usr/bin/env node
// The Run info card of extension/sidepanel/screens/run-info.js (#161 rows 14-28b plus this file's
// own 89-96a, moved out of tests/run-view.test.mjs by #194): what the panel makes of a run detail,
// the rows it prints from it, and the disclosure a tester's choice outlives the panel through.
// Three things here are easy to get quietly wrong, so most of this file is about them. The model
// reads TWO payloads that spell the same field differently and must never write null over what the
// other one found; a stamp is printed in the ACCOUNT PROFILE's zone in en-US wording, not the
// machine's; and ciBuildLink is this codebase's reference safe-href — server data reaching an
// `href`, so `javascript:`, `data:` and a scheme-relative URL each have to come back as no link
// at all rather than as a link that looks harmless.
// Rows 137-141 are new: the falsification run behind the move found the disclosure accessor, the
// status pill repainted with the card, the persisted key's spelling, the load order and every call
// site pinned nowhere at all. tests/run-view.test.mjs keeps what the SCREEN does with this card
// (row 136 — opening a run fills it) and drives the real module to do it.
// Run: node --test tests/run-info.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, SCREENS_SRC, makeDocument, el, fire, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The two switchable directories, so rows 140-141 read whatever SCREENS_SRC / CORE_SRC point at;
// index.html belongs to neither and is read where it ships, as tests/run-lock.test.mjs:134 reads it.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

// formatTimeIn falls back to the MACHINE zone when the profile zone is junk (row 18). Pinned to a
// zone that is neither UTC nor the repo's own, so the fallback is distinguishable from a honoured
// timeZone argument rather than accidentally equal to it. Set before anything formats a date.
process.env.TZ = 'Asia/Tokyo';

// The REAL formatter, not a stub: the Duration row asserts what a tester reads, and a fake would
// let it pass against a wording the panel never prints (tests/format.test.mjs).
const Fmt = runInNewContext(`${readFileSync(join(CORE_SRC, 'format.js'), 'utf8')}\nFmt;`, {});

// index.html:521-530, cut to the three nodes this module touches.
const NODES = [['div', 'run-info', true], ['button', 'run-info-head', false], ['dl', 'run-info-body', false]];
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

const rec = (id, over = {}) => ({ id, test_id: id, test_title: `Test ${id}`, status: 'pending', ...over });

// The panel globals run-info.js reads. paintRunState belongs to screens/run-view.js and stays
// there, so it is a recorder: what this module owes it is THAT it repaints with the card.
function load(opts = {}) {
  const o = {
    runInfo: {},
    records: [],
    without: [],   // ids to leave out of the page
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const [tag, id, hidden] of NODES) {
    if (o.without.includes(id)) continue;
    const n = el(tag, { id });
    if (hidden) n.hidden = true;
    if (id === 'run-info-head') n.setAttribute('aria-expanded', 'true');
    node[key(id)] = n;
    doc.body.append(n);
  }
  // The three members mini-dom does not have and this module reaches for. Layout is STATED here
  // (a browser measures it): zero-by-zero means the description fits, which is the branch that
  // leaves the "Show more" button off — row 96 states an overflow and gets the button instead.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const made = create(tag);
    made.scrollHeight = 0;
    made.clientHeight = 0;
    made.after = (...nodes) => {
      const parent = made.parentElement;
      if (!parent) return;
      const at = parent.childNodes.indexOf(made);
      for (const [i, n] of nodes.entries()) parent.insertBefore(n, parent.childNodes[at + 1 + i] ?? null);
    };
    return made;
  };
  // spinnerEl() builds its two circles in the SVG namespace; mini-dom has one namespace only.
  doc.createElementNS = (ns, tag) => {
    const made = doc.createElement(tag);
    made.dataset.ns = ns;
    return made;
  };

  const calls = {
    durations: [],  // every ms handed to humanDuration
    persists: 0,
    runStates: 0,   // screens/run-view.js's paintRunState, repainted with the card
  };

  const state = { runInfo: o.runInfo, records: o.records };

  // shared/user-cell.js's own normalize, verbatim in behaviour: a string with an @ is an address, a
  // record is name+email+avatar, anything naming nobody is null. Rows 14, 16 and 28 are ABOUT it.
  const normalize = (user) => {
    if (!user) return null;
    if (typeof user === 'string') {
      const s = user.trim();
      if (!s) return null;
      return s.includes('@') ? { name: '', email: s } : { name: s, email: '' };
    }
    if (typeof user !== 'object') return null;
    const name = String(user.name || user.username || user.title || '').trim();
    const email = String(user.email || '').trim();
    if (!name && !email) return null;
    return { name, email, avatar: String(user.avatar || user['avatar-url'] || user.avatarUrl || '').trim() };
  };

  const globals = {
    state,
    $: (id) => doc.getElementById(id),
    persistSession: () => { calls.persists += 1; },
    // The real core/format.js, recorded on the way through. The ARGUMENT is the point of row 23:
    // this module holds SECONDS and has to multiply, so an unconverted 90 prints '0.09s'.
    Fmt: { humanDuration: (ms) => { calls.durations.push(ms); return Fmt.humanDuration(ms); } },
    viewerTimezone: () => o.timezone ?? null,
    assigneeUser: (email) => (o.members || {})[String(email).toLowerCase()] || null,
    assigneeName: (email) => {
      const resolved = ((o.members || {})[String(email).toLowerCase()] || {}).name;
      if (resolved) return resolved;
      const at = String(email).indexOf('@');
      return at > 0 ? String(email).slice(0, at) : String(email);
    },
    // screens/run-view.js's own, recorded: it stayed with the screen this module came out of.
    paintRunState: () => { calls.runStates += 1; },
    // shared/icons.js's own el: `cls` is handed to classList.add one token per argument, and the
    // real one throws on a token with a space — the arity is the contract, so the stub keeps it.
    Icons: {
      el: (name, size = 16, ...cls) => {
        const n = el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } });
        n.classList.add(...cls.filter(Boolean));
        return n;
      },
      emoji: () => null,
    },
    // The real one writes data-tip on the node it is given; a recorder alone could not tell a tip
    // that landed on the right element from one that went nowhere. (shared/tooltip.js:257)
    Tooltip: {
      set: (n, tip) => {
        if (n && n.dataset) { if (tip) n.dataset.tip = String(tip); else delete n.dataset.tip; }
        return n;
      },
    },
    // A stub, deliberately: the rows below assert what Run info COMPOSES around a cell — 'Created
    // by <person><date>' is one row — and the real cell's monogram would rewrite every one of those
    // strings without testing anything of this module. shared/user-cell.js has its own suite.
    UserCell: {
      normalize,
      cell: (user) => {
        const u = normalize(user);
        if (!u) return null;
        const box = el('span', { className: 'user-cell' });
        const name = el('span', { className: 'user-name' });
        const at = u.email.indexOf('@');
        name.textContent = u.name || (at > 0 ? u.email.slice(0, at) : u.email);
        box.append(name);
        box.dataset.email = u.email;
        return box;
      },
    },
  };

  const h = loadScreen('run-info', {
    globals,
    document: doc,
    // index.html's own order: core/status-icons.js stands ahead of every screen, and the status
    // cell and the CI link draw their glyphs through it. The REAL one — a stub would make rows 21
    // and 90 test the stub (#194).
    before: [['status-icons', CORE_SRC]],
    // RunInfo is a lexical const: invisible as a sandbox property, reachable only off the completion
    // value, the same seam tests/md-sections.test.mjs uses.
    exported: 'RunInfo',
  });

  return {
    ...h,
    mod: h.screen,
    state, calls, node, doc,
    // The card as a plain [label, text] list — the order is half of what these rows assert.
    infoRows: () => {
      const out = [];
      const kids = node.runInfoBody.children;
      for (let i = 0; i < kids.length; i += 2) out.push([kids[i].textContent, kids[i + 1].textContent]);
      return out;
    },
    infoLabels: () => node.runInfoBody.querySelectorAll('dt').map((dt) => dt.textContent),
    infoValue: (label) => {
      const kids = node.runInfoBody.children;
      for (let i = 0; i < kids.length; i += 2) if (kids[i].textContent === label) return kids[i + 1];
      return null;
    },
  };
}


// ---------- the Run info model (rows 14-21, 89-90) ----------

test('14: the v2 detail is kept verbatim — the authoritative count, and only plans that NAME one', () => {
  const h = load();
  const info = plain(h.mod.fromDetail({
    total_tests: 12, tests_count: 9, env: 'chrome, firefox',
    plans: [{ title: 'P' }, 77], description: '  hi  ',
  }));
  assert.deepEqual(info, {
    status: null, testsCount: 12, createdAt: null, description: 'hi',
    envs: ['chrome', 'firefox'], plans: ['P'],
  });
});

test('14a: a payload that says nothing about people leaves those keys OFF, never null', () => {
  const h = load();
  const bare = plain(h.mod.fromDetail({ tests_count: 3, status: 'running', created_at: 'x' }));
  assert.deepEqual(Object.keys(bare).sort(), ['createdAt', 'description', 'status', 'testsCount']);
  // Named, and the three land — so the absence above is a decision, not an empty payload path.
  const full = plain(h.mod.fromDetail({
    tests_count: 3, executed_by: 'ann@x.io', author: 'Bo', assigned_to: 'cy@x.io',
  }));
  assert.deepEqual(full.executedBy, { name: '', email: 'ann@x.io' });
  assert.deepEqual(full.createdBy, { name: 'Bo', email: '' });
  assert.deepEqual(full.assignees, [{ name: '', email: 'cy@x.io' }]);
});

test('15: env arrives as a list on one route and a comma string on another — both come back a list', () => {
  const h = load();
  assert.deepEqual(plain(h.mod.envList(['x', null, '  '])), ['x']);
  assert.deepEqual(plain(h.mod.envList('a, b ,')), ['a', 'b']);
  assert.deepEqual(plain(h.mod.envList(null)), []);
  assert.deepEqual(plain(h.mod.envList('')), []);
});

test('15a: a plan is whatever names it; a bare id contributes nothing rather than "4831"', () => {
  const h = load();
  assert.deepEqual(plain(h.mod.planList([' Smoke ', { clean_title: 'Reg' }, { name: 'N' }, 4831, null])),
    ['Smoke', 'Reg', 'N']);
  assert.deepEqual(plain(h.mod.planList({ title: 'One' })), ['One'], 'a lone plan is not a list yet');
  assert.deepEqual(plain(h.mod.planList(null)), []);
});

test('16: the id list and the mode setting are not people, and neither is the word `none`', () => {
  const h = load();
  const out = plain(h.mod.flatPeople({
    assignee_ids: [3, 7], assign_mode: 'none', assigned_to: 'Ольга', assignees: ['none', 'bob@x.io'],
  }, /assign/));
  assert.deepEqual(out, [{ name: 'Ольга', email: '' }, { name: '', email: 'bob@x.io' }]);
});

test('16a: a key the pattern does not name is skipped whatever it holds', () => {
  const h = load();
  assert.deepEqual(plain(h.mod.flatPeople({ owner: 'Ann' }, /assign/)), []);
  assert.deepEqual(plain(h.mod.flatPeople({ owner: 'Ann' }, /owner/)), [{ name: 'Ann', email: '' }]);
  assert.deepEqual(plain(h.mod.flatPeople(null, /assign/)), []);
});

test('17: a stamp is printed in the viewer\'s PROFILE zone, in the web\'s own wording', () => {
  const h = load();
  assert.equal(h.mod.formatTimeIn('2026-09-03T14:05:00Z', 'UTC'), 'Sep 3, 2026 2:05 PM');
  assert.equal(h.mod.formatTimeIn('2026-09-03T14:05:00Z', 'America/New_York'), 'Sep 3, 2026 10:05 AM');
});

test('18: a zone the profile made up falls back to the machine\'s, rather than throwing the row away', () => {
  const h = load();
  // The machine zone is pinned to Asia/Tokyo at the top of this file, so the fallback is legible.
  assert.equal(h.mod.formatTimeIn('2026-09-03T14:05:00Z', 'Not/AZone'), 'Sep 3, 2026 11:05 PM');
  assert.equal(h.mod.formatTimeIn('2026-09-03T14:05:00Z', null), 'Sep 3, 2026 11:05 PM');
});

test('19: an unparseable stamp is no row at all, and neither is a missing one', () => {
  const h = load();
  assert.equal(h.mod.formatTimeIn('not a date', 'UTC'), null);
  assert.equal(h.mod.time(null), null);
  assert.equal(h.mod.time(''), null);
  assert.equal(h.mod.time('not a date'), null);
});

test('19a: a stamp that DOES parse carries the raw ISO beside the printed text', () => {
  const h = load({ timezone: 'UTC' });
  const span = h.mod.time('2026-09-03T14:05:00Z');
  assert.equal(span.className, 'run-info-time');
  assert.equal(span.textContent, 'Sep 3, 2026 2:05 PM');
  assert.equal(span.dataset.time, '2026-09-03T14:05:00Z', 'zone- and locale-free');
  assert.equal(span.dataset.tip, '2026-09-03T14:05:00Z');
});

test('20: a CI build URL is http(s) or it is not a link — the regression lock on the scheme', () => {
  const h = load();
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil', 'ftp://x/y', '', null, 5,
    'build/9', ' javascript:alert(1) ', 'HTTPS-ish://x', 'jAvAsCrIpT:alert(1)']) {
    assert.equal(h.mod.ciBuildLink(url), null, String(url));
  }
});

test('21: a padded https URL is trimmed, opened in a new tab and never printed as the label', () => {
  const h = load();
  const a = h.mod.ciBuildLink('  https://ci.example/build/9  ');
  assert.equal(a.href, 'https://ci.example/build/9');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
  assert.equal(a.dataset.tip, 'https://ci.example/build/9', 'the raw URL is the tooltip');
  assert.ok(a.textContent.startsWith('Open CI build'), a.textContent);
  assert.equal(a.querySelector('.link-out-icon').dataset.icon, 'open_in_new');
  assert.equal(a.textContent.includes('ci.example'), false, 'and never the label');
  // http and an upper-case scheme are the same answer — the check is the SCHEME, not the spelling.
  assert.equal(h.mod.ciBuildLink('http://ci.example/9').href, 'http://ci.example/9');
  assert.equal(h.mod.ciBuildLink('HTTPS://ci.example/9').rel, 'noopener noreferrer');
});

test('89: a tag list is pills with the whole string on each tooltip; an empty list is no row', () => {
  const h = load();
  assert.equal(h.mod.tags([]), null);
  const box = h.mod.tags(['chrome', 'a-very-long-environment-name']);
  assert.equal(box.className, 'env-tags');
  assert.deepEqual(box.children.map((p) => p.className), ['badge env', 'badge env']);
  assert.deepEqual(box.children.map((p) => p.dataset.tip), ['chrome', 'a-very-long-environment-name']);
});

test('90: the status cell normalises the colour key but prints the word the server sent', () => {
  const h = load();
  const span = h.mod.statusCell('launching');
  assert.equal(span.dataset.status, 'running');
  assert.equal(span.textContent, 'launching');
});

// ---------- the Run info rows (rows 22-28, 91-96) ----------

// state.runInfo is what rows() reads; everything below states it directly.
const withInfo = (info, over = {}) => load({ runInfo: info, timezone: 'UTC', ...over });
const labelled = (h) => Object.fromEntries(h.mod.rows()
  .map(([label, value]) => [label, typeof value === 'string' ? value : value.textContent]));

test('22: the card prints the SERVER\'s total, not the number of rows loaded into the panel', () => {
  const h = withInfo({ testsCount: 180 }, { records: Array.from({ length: 50 }, (_, i) => rec(i + 1)) });
  assert.equal(labelled(h).Tests, '180');
  // …and never below the checklist: a run created moments ago has rows the count has not caught up to.
  h.state.runInfo = { testsCount: 0 };
  assert.equal(labelled(h).Tests, '50');
});

test('23: duration arrives in SECONDS and is handed to humanDuration in milliseconds', () => {
  const h = withInfo({ duration: 90 });
  assert.equal(labelled(h).Duration, '1m 30s');
  assert.deepEqual(h.calls.durations, [90000]);
});

test('24: a run still going has no duration to print', () => {
  const h = withInfo({ duration: 0 });
  assert.equal('Duration' in labelled(h), false);
  assert.deepEqual(h.calls.durations, []);
});

test('25: a finished run shows the executed span, and no separate Started row beside it', () => {
  const h = withInfo({ launchedAt: '2026-09-03T14:05:00Z', finishedAt: '2026-09-03T14:35:00Z' });
  const rows = labelled(h);
  assert.equal(rows.Executed, 'Sep 3, 2026 2:05 PM→Sep 3, 2026 2:35 PM');
  assert.equal('Started' in rows, false);
  // A live run has only the start, which is the row the span replaced.
  h.state.runInfo = { launchedAt: '2026-09-03T14:05:00Z' };
  const live = labelled(h);
  assert.equal(live.Started, 'Sep 3, 2026 2:05 PM');
  assert.equal('Executed' in live, false);
});

test('26: "Created by <person>, <date>" is ONE row — the date does not repeat itself below', () => {
  const h = withInfo({ createdBy: { name: 'Ann', email: 'ann@x.io' }, createdAt: '2026-09-03T14:05:00Z' });
  const rows = labelled(h);
  assert.equal(rows['Created by'], 'AnnSep 3, 2026 2:05 PM');
  assert.equal('Created' in rows, false);
  // Nobody named → the date alone, under its own label.
  h.state.runInfo = { createdAt: '2026-09-03T14:05:00Z' };
  const anon = labelled(h);
  assert.equal(anon.Created, 'Sep 3, 2026 2:05 PM');
  assert.equal('Created by' in anon, false);
});

test('27: a description is server data, printed as text — no element comes out of it', () => {
  const h = withInfo({ description: '<script>alert(1)</script>' });
  h.mod.render();
  const dd = h.infoValue('Description');
  assert.equal(dd.querySelectorAll('script').length, 0);
  assert.equal(dd.textContent, '<script>alert(1)</script>');
  assert.ok(dd.classList.contains('run-info-desc'));
  assert.ok(dd.querySelector('.run-info-desc-text').classList.contains('is-clamped'));
});

test('28: one person named twice is one cell — the key is the ADDRESS, whatever its case', () => {
  const h = withInfo({ assignees: ['Bob@X.io'] }, { records: [rec(1, { assigned_to: { name: 'Bob', email: 'bob@x.io' } })] });
  const box = h.mod.assignees();
  assert.deepEqual(box.children.map((c) => c.textContent), ['Bob']);
  assert.equal(box.children[0].dataset.email, 'Bob@X.io', 'the first spelling seen is the one kept');
});

test('28a: the ticket\'s "one by email, one by name" is TWO cells — the key is not a human', () => {
  // Following the code, not row 28's wording: `(u.email || u.name).toLowerCase()` cannot know that
  // 'Bob' and 'bob@x.io' are the same tester, and the comment above it says "keyed by address".
  const h = withInfo({ assignees: ['Bob'] }, { records: [rec(1, { assigned_to: 'bob@x.io' })] });
  assert.deepEqual(h.mod.assignees().children.map((c) => c.textContent), ['Bob', 'bob']);
  // …and a NAME is folded by the same rule the address is: two spellings of one are one cell.
  const named = withInfo({ assignees: ['Ann', 'ANN'] });
  assert.deepEqual(named.mod.assignees().children.map((c) => c.textContent), ['Ann']);
});

test('28b: nobody assigned anywhere is no row at all', () => {
  const h = withInfo({}, { records: [rec(1)] });
  assert.equal(h.mod.assignees(), null);
  assert.equal('Assigned to' in labelled(h), false);
});

test('91: a person named only by address is resolved through the project members for their name', () => {
  const h = withInfo({ executedBy: 'ann@x.io' }, { members: { 'ann@x.io': { name: 'Ann Lee', email: 'ann@x.io' } } });
  assert.equal(labelled(h)['Executed by'], 'Ann Lee');
  // What the PAYLOAD said wins over the members map.
  h.state.runInfo = { executedBy: { name: 'A. Lee', email: 'ann@x.io' } };
  assert.equal(labelled(h)['Executed by'], 'A. Lee');
  // Nobody in the map and no name: the address's local part, the way the assignee chip falls back.
  const bare = withInfo({ executedBy: 'zoe@x.io' });
  assert.equal(labelled(bare)['Executed by'], 'zoe');
  assert.equal(bare.mod.user(null), null);
});

test('92: the card\'s rows come out in the web\'s own order', () => {
  const h = withInfo({
    status: 'passed', duration: 90, testsCount: 4, envs: ['chrome'], plans: ['Smoke'],
    launchedAt: '2026-09-03T14:05:00Z', finishedAt: '2026-09-03T14:35:00Z',
    executedBy: 'ann@x.io', assignees: ['bo@x.io'], ciBuildUrl: 'https://ci.example/9',
    createdBy: 'Cy', createdAt: '2026-09-01T10:00:00Z', description: 'why',
  });
  // Spread first: the array comes out of the vm realm with its own prototype, which deepEqual reads.
  assert.deepEqual([...h.mod.rows()].map(([label]) => label), [
    'Status', 'Duration', 'Tests', 'Environment', 'Test plan', 'Executed',
    'Executed by', 'Assigned to', 'Build URL', 'Created by', 'Description',
  ]);
  // …and the painted card is that same list in that same order, not merely the model's.
  h.mod.render();
  assert.deepEqual(h.infoLabels(), [
    'Status', 'Duration', 'Tests', 'Environment', 'Test plan', 'Executed',
    'Executed by', 'Assigned to', 'Build URL', 'Created by', 'Description',
  ]);
});

test('96: a description too tall for its clamp grows a Show more, and the button says which way', () => {
  const h = withInfo({ description: 'a very long session report' });
  h.mod.render();
  const text = h.node.runInfoBody.querySelector('.run-info-desc-text');
  assert.equal(h.node.runInfoBody.querySelector('.run-info-desc-more'), null, 'it fits, so no button');
  text.scrollHeight = 400; // what a browser would measure for a report that overflows its clamp
  text.clientHeight = 60;
  h.mod.paint();
  const more = h.node.runInfoBody.querySelector('.run-info-desc-more');
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  fire(more, 'click');
  assert.equal(more.textContent, 'Show less');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(text.classList.contains('is-clamped'), false);
  fire(more, 'click');
  assert.equal(more.textContent, 'Show more');
  assert.ok(text.classList.contains('is-clamped'));
  // A second measure does not stack a second button on top of the first.
  h.mod.paint();
  assert.equal(h.node.runInfoBody.querySelectorAll('.run-info-desc-more').length, 1);
});

test('96a: a closed card measures nothing — a hidden body has no layout to read', () => {
  const h = withInfo({ description: 'x' });
  h.mod.render();
  h.mod.toggle(); // closed
  const text = h.node.runInfoBody.querySelector('.run-info-desc-text');
  text.scrollHeight = 400;
  text.clientHeight = 60;
  h.mod.paint();
  assert.equal(h.node.runInfoBody.querySelector('.run-info-desc-more'), null);
  // The people measure is the same gate — a stacked list cannot be found in a hidden body either.
  h.state.runInfo = { assignees: ['ann@x.io'] };
  h.mod.render();
  assert.equal(h.node.runInfoBody.querySelector('.user-cells.is-stacked'), null);
});

test('93: a run whose meta never loaded gets no empty card — the section hides itself', () => {
  const h = withInfo({});
  h.mod.render();
  assert.equal(h.node.runInfo.hidden, true);
  assert.deepEqual(h.infoRows(), []);
  // One field is enough to bring it back, so the hide is about content and not about the call.
  h.state.runInfo = { status: 'running' };
  h.mod.render();
  assert.equal(h.node.runInfo.hidden, false);
  assert.deepEqual(h.infoLabels(), ['Status']);
});

test('94: the disclosure remembers the tester\'s choice, and says so to a reader', () => {
  const h = withInfo({ status: 'running' });
  h.mod.render();
  assert.equal(h.node.runInfoHead.getAttribute('aria-expanded'), 'true');
  assert.equal(h.node.runInfoBody.hidden, false);
  h.mod.toggle();
  assert.equal(h.node.runInfoHead.getAttribute('aria-expanded'), 'false');
  assert.equal(h.node.runInfoBody.hidden, true);
  assert.equal(h.calls.persists, 1, 'and the choice outlives this panel');
  h.mod.toggle();
  assert.equal(h.node.runInfoBody.hidden, false);
  assert.equal(h.calls.persists, 2);
});

test('95: a page without the card is not an error — the test view shares the run screen', () => {
  const h = withInfo({ status: 'running' }, { without: ['run-info', 'run-info-body', 'run-info-head'] });
  assert.doesNotThrow(() => h.mod.render());
  assert.doesNotThrow(() => h.mod.paint());
});

// ---------- the seams the move opened (rows 137-141) ----------

test('137 (#194): `open` is a real accessor — what app.js writes is what the paint reads', () => {
  const h = withInfo({ status: 'running' });
  // The default is OPEN: a profile predating the key must not find the card shut.
  assert.equal(h.mod.open, true);
  h.mod.render();
  assert.equal(h.node.runInfoBody.hidden, false);
  // app.js:152's own write. A data property beside a module `let` would leave this unread.
  h.mod.open = false;
  h.mod.paint();
  assert.equal(h.node.runInfoBody.hidden, true);
  assert.equal(h.node.runInfoHead.getAttribute('aria-expanded'), 'false');
  assert.equal(h.calls.persists, 0, 'a restored session is not a choice being made again');
  // …and the other direction: what the tester toggles is what core/storage.js then reads back.
  h.mod.toggle();
  assert.equal(h.mod.open, true);
  h.mod.toggle();
  assert.equal(h.mod.open, false);
  assert.equal(h.calls.persists, 2);
});

test('138 (#194): rendering the card repaints the run-state pill with it', () => {
  const h = withInfo({ status: 'running' });
  h.mod.render();
  assert.equal(h.calls.runStates, 1, 'the same fields feed both');
  // A card with nothing to print still repaints it — the pill is not conditional on the rows.
  h.state.runInfo = {};
  h.mod.render();
  assert.equal(h.calls.runStates, 2);
  // …and a page without the card asks for neither.
  const bare = withInfo({ status: 'running' }, { without: ['run-info'] });
  bare.mod.render();
  assert.equal(bare.calls.runStates, 0);
});

test('139 (#194): every row label and the whole vocabulary, verbatim', () => {
  const h = withInfo({
    status: 'passed', duration: 90, testsCount: 4, envs: ['chrome'], plans: ['Smoke'],
    launchedAt: '2026-09-03T14:05:00Z', executedBy: 'ann@x.io', assignees: ['bo@x.io'],
    ciBuildUrl: 'https://ci.example/9', createdAt: '2026-09-01T10:00:00Z', description: 'why',
  });
  // The live-run spelling: `Started` and `Created`, with nobody named.
  assert.deepEqual([...h.mod.rows()].map(([label]) => label), [
    'Status', 'Duration', 'Tests', 'Environment', 'Test plan', 'Started',
    'Executed by', 'Assigned to', 'Build URL', 'Created', 'Description',
  ]);
  // The whole set of labels this card can ever print — a renamed one shows up here or nowhere.
  h.state.runInfo = { ...h.state.runInfo, finishedAt: '2026-09-03T14:35:00Z', createdBy: 'Cy' };
  const all = new Set([...h.mod.rows()].map(([label]) => label));
  assert.deepEqual([...all].sort(), ['Assigned to', 'Build URL', 'Created by', 'Description',
    'Duration', 'Environment', 'Executed', 'Executed by', 'Status', 'Test plan', 'Tests'].sort());
  assert.equal(all.has('Started'), false, 'a finished run says Executed instead');
  assert.equal(all.has('Created'), false, 'and Created by instead');
});

test('140 (#194): the page carries the card and loads the module ahead of every screen that asks', () => {
  const html = raw(repoRoot, 'extension/sidepanel/index.html');
  for (const id of ['run-info', 'run-info-head', 'run-info-body']) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at('screens/run-info.js') > 0, 'the module is loaded at all');
  // core/status-icons.js is its one load-order dependency; every other name it reads is late-bound.
  assert.ok(at('core/status-icons.js') < at('screens/run-info.js'), 'after the glyphs it draws with');
  for (const s of ['screens/run-view.js', 'screens/livesync.js', 'app.js']) {
    assert.ok(at('screens/run-info.js') < at(s), `screens/run-info.js stands before ${s}`);
  }
  // core/storage.js is the one caller it does NOT stand before — a core file reaching forward into
  // a screen, exactly as it did when this name lived in run-view.js. Late-bound, unchanged.
  assert.ok(at('core/storage.js') < at('screens/run-info.js'));
});

test('141 (#194): every call site asks RunInfo by name, and the saved key keeps its spelling', () => {
  const callers = {
    [join(SCREENS_SRC, 'run-view.js')]: 6,
    [join(SCREENS_SRC, 'livesync.js')]: 1,
    [join(CORE_SRC, 'storage.js')]: 1,
    [join(repoRoot, 'extension/sidepanel/app.js')]: 2, // neither directory — read where it ships
  };
  // Every name the module took, as a CALL: a bare one here throws only under a tester's finger.
  const OLD = /(^|[^.\w])(runInfoFromDetail|envList|planList|flatPeople|formatTimeIn|runInfoTime|ciBuildLink|runInfoTags|runInfoStatus|runInfoUser|runInfoAssignees|measureRunInfoPeople|runInfoDescription|runInfoDescExpander|measureRunInfoDesc|runInfoRows|renderRunInfo|paintRunInfo|toggleRunInfo)\s*\(/;
  for (const [file, n] of Object.entries(callers)) {
    const src = readFileSync(file, 'utf8');
    const code = src.replace(/\/\/.*$/gm, ''); // two files name the module in a trailing comment too
    assert.equal((code.match(/\bRunInfo\.\w+/g) || []).length, n, `${file} names RunInfo ${n} time(s)`);
    assert.doesNotMatch(code, OLD, `${file} calls no bare old name`);
    // The bare `let` is gone too: an assignment to it would now build a stray global in silence.
    assert.doesNotMatch(code, /(^|[^.\w])runInfoOpen\s*=[^=]/, `${file} assigns no bare runInfoOpen`);
  }
  // The `/* global … */` block of the two screens that have one; core/storage.js has none, and
  // reads `state`, `hasChrome` and `hostOf` just as bare.
  for (const file of [join(SCREENS_SRC, 'run-view.js'), join(SCREENS_SRC, 'livesync.js'),
    join(repoRoot, 'extension/sidepanel/app.js')]) {
    assert.ok(/\/\* global ([\s\S]*?)\*\//.exec(readFileSync(file, 'utf8'))[1].includes('RunInfo'),
      `${file} declares the global`);
  }
  // The persisted KEY, not the module's name for it: renaming it loses every profile's choice.
  assert.match(raw(CORE_SRC, 'storage.js'), /\brunInfoOpen:\s*RunInfo\.open\b/);
  // app.js hands the head the method itself, unbound — which is only safe because nothing in the
  // module says `this`. One `this.` in there and every click on the card would throw.
  assert.match(readFileSync(join(repoRoot, 'extension/sidepanel/app.js'), 'utf8'),
    /addEventListener\('click', RunInfo\.toggle\)/);
  assert.doesNotMatch(raw(SCREENS_SRC, 'run-info.js').replace(/\/\/.*$/gm, ''), /\bthis\b/);
});
