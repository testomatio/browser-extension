#!/usr/bin/env node
// What extension/sidepanel/screens/evidence.js does for the tester (#157): while they work through a
// run the panel can keep the last minute of the tested tab's console errors and failed requests. The
// chip counts them, a hover card shows the newest six, each row attaches itself to the comment as a
// quoted snippet, and marking the test Failed uploads the whole window as a readable .txt beside the
// result. The background recorder is the source of truth; this file is its face.
// Two things here are easy to break and expensive to lose. The 2-second poll repaints the whole list,
// and a row the tester opened has to still be open afterwards — the verdict comes from evUi.expanded,
// not from the DOM. And a recording belongs to the testrun it was STARTED in: evUi.recordId is the
// recorder's own copy, so a panel reload still knows which screen owns the session and walking off
// that screen ends it.
// Rows 1-64 are the ticket's; a lettered suffix is the companion case that drives the same path the
// other way, so a row asserting "nothing happened" cannot pass against a stub that never worked.
// Run: node --test tests/evidence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

// evTime reads getHours/getMinutes/getSeconds — LOCAL time. Pinned here so the ticket's own UTC
// stamps are the ones asserted; the row also carries a clock-agnostic form beside them.
process.env.TZ = 'UTC';

const NOW = Date.UTC(2026, 8, 3, 14, 6, 9); // what the panel's clock reads
const TS = Date.UTC(2026, 8, 3, 14, 5, 9);  // one minute earlier: every fixture entry's stamp
const AT = '14:05:09';
const SITE = 'https://shop.example.com';
const UPLOADED = 'https://cdn.example/evidence.txt';
const NO_TEST = 'Open a test to record its console & network log';
const ATTACHED = 'Log snippet added to the comment';

// new Date() stamps the .txt header and Date.now() names the upload and ages every card row. The
// one-argument form stays real, because that is the entry timestamp evTime formats.
class PinnedDate extends Date {
  constructor(...args) { if (!args.length) super(NOW); else super(...args); }
  static now() { return NOW; }
}

// The two host objects the sandbox has no realm copy of.
class FakeBlob {
  constructor(parts, opts) { this.text = parts.join(''); this.type = opts && opts.type; }
}
class FakeEvent {
  constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); }
}

const con = (over = {}) => ({ kind: 'console', level: 'error', text: 'boom', ts: TS, ...over });
const net = (over = {}) => ({ kind: 'network', status: 500, method: 'GET', url: `${SITE}/api/y`, ts: TS, ...over });

// index.html's shape, cut to the nodes this screen touches; the hidden ones start hidden there too.
const IDS = ['rec-slot', 'evidence-toggle', 'evidence-errors', 'evidence-section', 'evidence-head',
  'evidence-count', 'evidence-body', 'evidence-list', 'test-comment', 'test-title'];
const TAG = {
  'evidence-toggle': 'button', 'evidence-head': 'button', 'evidence-errors': 'span',
  'evidence-count': 'span', 'evidence-list': 'ul', 'test-comment': 'textarea', 'test-title': 'h2',
};
const HIDDEN = new Set(['rec-slot', 'evidence-toggle', 'evidence-errors', 'evidence-section',
  'evidence-count', 'evidence-body']);
const key = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// The panel globals evidence.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set, and the ones beside this land in parallel.
function load(opts = {}) {
  const o = {
    view: 'test',
    currentRecordId: '55',
    booting: false,
    settings: {},          // state.settings — `{}` is "configured, nothing customised"
    runTitle: 'Run A',
    testTitle: '',         // what #test-title carries
    hasChrome: true,
    runtime: true,         // false — a chrome whose runtime cannot send
    storage: true,         // false — a chrome with no storage area at all
    without: [],           // ids to leave out of the page
    site: { state: 'ok', tab: { id: 7 }, origin: SITE, error: null },
    reply: null,           // (msg) => the worker's answer; by default a stopped recorder
    onSend: null,          // runs as a message goes out — the seam for "the tester walked off"
    onMirror: null,        // runs as the capture-bodies flag is written, before the toggle
    upload: { url: UPLOADED },
    ...opts,
  };

  const doc = makeDocument([]);
  const node = {};
  for (const id of IDS) {
    if (o.without.includes(id)) continue;
    const n = el(TAG[id] || 'div', { id });
    if (HIDDEN.has(id)) n.hidden = true;
    if (id === 'test-comment') n.value = '';
    if (id === 'test-title') n.textContent = o.testTitle;
    node[key(id)] = n;
    doc.body.append(n);
  }

  const calls = {
    order: [],       // one ordered trace: "the flag, THEN the toggle, THEN the toast" is a row
    sends: [],
    toasts: [],
    uploads: [],
    counters: [],
    empties: [],
    sections: [],    // showTestSection('status')
    disabledAt: [],  // the Rec button's state each time the flow reaches the site resolver
    // Whether the screen still believed it was recording as each message left — the only way to see
    // that the local status is cleared BEFORE the stop goes out.
    recordingAt: [],
    card: { update: 0, close: 0 },
    listener: null,  // whatever initEvidence registered on chrome.runtime.onMessage
  };
  let live = null;   // evUi, once the screen has been loaded; read by the sendMessage stub

  const state = {
    view: o.view,
    currentRecordId: o.currentRecordId,
    booting: o.booting,
    settings: o.settings,
    runTitle: o.runTitle,
  };
  const store = fakeChrome();
  const card = {
    update: () => { calls.card.update += 1; calls.order.push('card.update'); },
    close: () => { calls.card.close += 1; calls.order.push('card.close'); },
  };

  const chromeStub = {};
  if (o.storage) {
    chromeStub.storage = {
      ...store.chrome.storage,
      local: {
        ...store.chrome.storage.local,
        set: async (arg) => {
          calls.order.push('storage.set');
          const out = store.chrome.storage.local.set(arg);
          if (o.onMirror) o.onMirror(arg);
          return out;
        },
      },
    };
  }
  chromeStub.runtime = { onMessage: { addListener: (fn) => { calls.listener = fn; } } };
  if (o.runtime) {
    chromeStub.runtime.sendMessage = async (msg) => {
      calls.sends.push(plain(msg));
      calls.order.push(`send:${msg.type}`);
      calls.recordingAt.push({ type: msg.type, recording: live ? live.recording : null });
      if (o.onSend) o.onSend(msg);
      return o.reply ? o.reply(msg) : { ok: true, status: { recording: false } };
    };
  }

  const globals = {
    state,
    hasChrome: o.hasChrome,
    Date: PinnedDate,
    Blob: FakeBlob,
    Event: FakeEvent,
    chrome: chromeStub,
    $: (id) => doc.getElementById(id),
    toast: (msg, tOpts) => { calls.toasts.push(tOpts ? { msg, ...tOpts } : { msg }); calls.order.push('toast'); },
    // core/views.js's own rule: repainting the same figure is silent.
    paintCounter: (n, value) => {
      calls.counters.push({ id: n && n.id, value: String(value) });
      if (!n || n.textContent === String(value)) return;
      n.textContent = String(value);
    },
    svgIcon: (name, size) => el('span', { className: 'icon', dataset: { icon: name, size: String(size) } }),
    showTestSection: (name) => { calls.sections.push(name); },
    resolveSiteTab: o.resolveSiteTab || (async (args) => {
      calls.order.push('resolveSiteTab');
      calls.disabledAt.push(node.evidenceToggle ? node.evidenceToggle.disabled : null);
      return o.site;
    }),
    Tooltip: { set: () => {} },
    HoverCard: { attach: () => { calls.order.push('card.attach'); return card; } },
    // shared/empty-state.js's shape, cut to what this screen asks of it.
    EmptyState: {
      build: ({ tag = 'div', icon, text, className = '', compact = false }) => {
        calls.empties.push({ icon, tag, className });
        const box = doc.createElement(tag);
        box.className = `empty${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`;
        box.dataset.icon = icon || '';
        const body = doc.createElement('p');
        body.className = 'empty-text';
        for (const part of [].concat(text)) if (part) body.append(part);
        box.append(body);
        return box;
      },
    },
    TestomatAPI: {
      uploadAttachment: async (id, blob, name) => {
        calls.uploads.push({ id: String(id), blob, name });
        calls.order.push('upload');
        return typeof o.upload === 'function' ? o.upload() : o.upload;
      },
    },
  };

  const clock = fakeClock();
  const h = loadScreen('evidence', {
    exported: '({ evUi, EV_CARD_ROWS, EV_BODY_DISABLED })',
    document: doc, clock, store, globals,
  });
  live = h.screen.evUi;

  return {
    ...h,
    state, calls, node, store, clock,
    // evUi is a lexical const: invisible as a sandbox property, reachable only off the completion
    // value. Everything state-driven in this file is asserted through it or through what it paints.
    evUi: h.screen.evUi,
    types: () => calls.sends.map((m) => m.type),
    rows: () => (node.evidenceList ? node.evidenceList.children : []),
    // The tester's own two clicks, through the listeners initEvidence registered.
    click: (name) => fire(node[name], 'click'),
  };
}

// ---------- formatting one entry (rows 1-5) ----------

test('1: the stamp on a row is the tester\'s own wall clock, zero-padded', () => {
  const h = load();
  assert.equal(h.fn.evTime(TS), AT);
  // Built from local parts instead of UTC, so the padding is asserted wherever the suite runs.
  assert.equal(h.fn.evTime(new Date(2026, 8, 3, 4, 5, 9).getTime()), '04:05:09');
  assert.equal(h.fn.evTime(new Date(2026, 8, 3, 23, 59, 59).getTime()), '23:59:59');
});

test('2: a message becomes one line, and a long one loses its tail to an ellipsis', () => {
  const h = load();
  assert.equal(h.fn.evOneLine('  a \n b  ', 4), 'a b');
  assert.equal(h.fn.evOneLine('abcdef', 4), 'abc…');
  assert.equal(h.fn.evOneLine(null), '');
  // The ellipsis replaces the last kept character, so the cap is the cap: 4 in, 4 out.
  assert.equal(h.fn.evOneLine('abcd', 4), 'abcd');
  assert.equal(h.fn.evOneLine('abcde', 4).length, 4);
});

test('3: a request that never got a status says ERR, and a status of 0 is a figure, not a dash', () => {
  const h = load();
  assert.equal(h.fn.evNetStatus({ errorText: 'net::ERR_FAILED' }), 'ERR');
  assert.equal(h.fn.evNetStatus({ status: 0 }), 0);
  assert.equal(h.fn.evNetStatus({}), '—');
  // A failure that DID carry a code keeps it — the errorText is not a blanket override.
  assert.equal(h.fn.evNetStatus({ errorText: 'net::ERR_FAILED', status: 500 }), 500);
});

test('4: an uncaught throw is not a console call, and never reads as one', () => {
  const h = load();
  assert.equal(h.fn.evLabel({ kind: 'exception', level: 'error' }), 'uncaught.error');
  assert.equal(h.fn.evLabel({ kind: 'log', level: 'warning' }), 'log.warning');
  assert.equal(h.fn.evLabel({ kind: 'console', level: 'error' }), 'console.error');
});

test('5: the location is source:line:col, and each part is dropped once it is missing', () => {
  const h = load();
  assert.equal(h.fn.evLoc({ url: 'a.js', line: 5, col: 0 }), 'a.js:5');
  assert.equal(h.fn.evLoc({ url: 'a.js' }), 'a.js');
  assert.equal(h.fn.evLoc({}), '');
  // The column only an uncaught row carries does print when it is really there.
  assert.equal(h.fn.evLoc({ url: 'a.js', line: 5, col: 7 }), 'a.js:5:7');
});

// ---------- the escaping that keeps a recorded page out of the comment (rows 6-8) ----------

test('6: a backtick written by the page cannot close the span it is quoted in', () => {
  const h = load();
  // The fence grows past the longest run inside, and CommonMark eats one pad space each end.
  assert.equal(h.fn.evInlineCode('`code`'), '`` `code` ``');
  // The fence still outgrows a run in the MIDDLE; the pad is only for a tick against the edge.
  assert.equal(h.fn.evInlineCode('a ``` b'), '````a ``` b````');
  // Nothing to escape: no pad, one tick — the growth is a reaction, not a habit.
  assert.equal(h.fn.evInlineCode('plain'), '`plain`');
});

test('7: a newline written by the page cannot end the quote from inside', () => {
  const h = load();
  assert.equal(h.fn.evInlineCode('a\nb  c'), '`a b c`');
  assert.equal(h.fn.evInlineCode('> quoted\n> lines'), '`> quoted > lines`');
});

test('8: a fenced body opens and closes past the longest backtick run it contains', () => {
  const h = load();
  assert.equal(h.fn.evFence('a\n```\nb'), '````\na\n```\nb\n````');
  assert.equal(h.fn.evFence('plain'), '```\nplain\n```'); // the floor is three, not one
});

// ---------- snippets, row keys, icons (rows 9-13) ----------

test('9: a failed request drops into the comment as a quote plus its fenced body', () => {
  const h = load();
  const entry = net({ url: 'https://x/y', bodySnippet: '{"a":1}', bodyTruncated: true });
  assert.equal(
    h.fn.evEntrySnippet(entry),
    `> \`[500 GET https://x/y ${AT}]\`\n\n\`\`\`\n{"a":1}\n… (truncated)\n\`\`\``,
  );
  // A transport failure names itself inside the same quote.
  assert.equal(
    h.fn.evEntrySnippet(net({ url: 'https://x/y', status: undefined, errorText: 'net::ERR_FAILED' })),
    `> \`[ERR GET https://x/y net::ERR_FAILED ${AT}]\``,
  );
  // No body captured: the quote stands alone, with no empty fence under it.
  assert.equal(h.fn.evEntrySnippet(net({ url: 'https://x/y' })), `> \`[500 GET https://x/y ${AT}]\``);
});

test('10: a console row is one quoted line, and a novel of a message is cut to 200', () => {
  const h = load();
  assert.equal(h.fn.evEntrySnippet(con()), `> \`[console.error ${AT}] boom\``);
  const long = h.fn.evEntrySnippet(con({ text: 'x'.repeat(500) }));
  assert.ok(long.endsWith('…`'), long.slice(-20));
  assert.equal(long, `> \`[console.error ${AT}] ${'x'.repeat(199)}…\``);
  assert.equal(long.split('\n').length, 1);
});

test('11: a body the recorder cut is marked as cut, wherever it goes', () => {
  const h = load();
  const snippet = h.fn.evEntrySnippet(net({ bodySnippet: 'abc', bodyTruncated: true }));
  assert.ok(snippet.endsWith('```\nabc\n… (truncated)\n```'), snippet);
  // The same body NOT flagged carries no marker — the flag is what prints it.
  assert.ok(!h.fn.evEntrySnippet(net({ bodySnippet: 'abc' })).includes('(truncated)'));
});

test('12: a row keeps the same key across the 2 s repaint, redirect hops apart', () => {
  const h = load();
  assert.equal(h.fn.evKey({ kind: 'network', ts: 1, requestId: 'r1' }), 'network:1:r1');
  assert.equal(h.fn.evKey({ kind: 'network', ts: 1, method: 'GET', url: 'u' }), 'network:1:GET u');
  assert.equal(h.fn.evKey({ kind: 'console', ts: 2, text: 'x' }), 'console:2:x');
  // Two hops of one redirect share ts, method and url — only the requestId tells them apart.
  const hop = (requestId) => h.fn.evKey({ kind: 'network', ts: 1, method: 'GET', url: 'u', requestId });
  assert.notEqual(hop('r1'), hop('r2'));
});

test('13: the icon and the severity that colours it never disagree', () => {
  const h = load();
  assert.deepEqual(plain(h.fn.evIcon({ kind: 'network', errorText: 'e' })), { name: 'block', kind: 'error' });
  assert.deepEqual(plain(h.fn.evIcon({ kind: 'network' })), { name: 'language', kind: 'net' });
  assert.deepEqual(plain(h.fn.evIcon({ kind: 'console', level: 'warning' })), { name: 'warning', kind: 'warning' });
  assert.deepEqual(plain(h.fn.evIcon({ kind: 'exception', level: 'error' })), { name: 'error', kind: 'error' });
});

// ---------- the .txt that leaves the browser (rows 14-17) ----------

test('14: the log reads as a document — header, Console, Network, bodies indented under their request', () => {
  const h = load();
  const entries = [
    con({ text: 'boom', url: 'a.js', line: 5 }),
    net({ url: 'https://x/y', resourceType: 'xhr', bodySnippet: '{"a":1}', bodyTruncated: true }),
  ];
  assert.equal(
    h.fn.evBuildTxt('Run A', 'Test B', entries, { tabTitle: 'Shop', tabUrl: `${SITE}/cart`, windowSec: 60 }),
    [
      'Console & network log — Run A / Test B',
      'Recorded tab: Shop',
      `URL: ${SITE}/cart`,
      'Window: last 60s · 2 entries · 2026-09-03T14:06:09.000Z',
      '',
      '== Console (1) ==',
      `[${AT}] console.error: boom (a.js:5)`,
      '',
      '== Network (1) ==',
      `[${AT}] 500 GET https://x/y [xhr]`,
      '    {"a":1}',
      '    … (truncated)',
      '',
    ].join('\n'),
  );
});

test('14b: an untitled run and an untitled test still name themselves, and a failure says why', () => {
  const h = load();
  const txt = h.fn.evBuildTxt('', '', [net({ url: 'https://x/y', status: undefined, errorText: 'net::ERR_FAILED' })], { windowSec: 60 });
  assert.ok(txt.startsWith('Console & network log — Run / Test\n'), txt.split('\n')[0]);
  assert.ok(txt.includes(`[${AT}] ERR GET https://x/y — net::ERR_FAILED`), txt);
  assert.ok(!txt.includes('URL:'), 'no tab URL was recorded, so no URL line'); // the header is 3 lines here
});

test('15: nothing captured is still a readable file — both sections say (none)', () => {
  const h = load();
  const txt = h.fn.evBuildTxt('Run A', 'Test B', [], { windowSec: 60 });
  assert.ok(txt.includes('Recorded tab: —'), txt);
  assert.ok(txt.includes('== Console (0) ==\n(none)\n'), txt);
  assert.ok(txt.includes('== Network (0) ==\n(none)\n'), txt);
  // …and the (none) really is a stand-in: an entry in either section takes its place.
  const one = h.fn.evBuildTxt('Run A', 'Test B', [con()], { windowSec: 60 });
  assert.ok(!one.includes('== Console (0) ==\n(none)'), one);
  assert.ok(one.includes('== Network (0) ==\n(none)'), one);
});

test('16: a body the tester switched off is named as switched off, not as an empty one', () => {
  const h = load();
  const off = h.fn.evBuildTxt('R', 'T', [net({ url: 'https://x/y', bodySkipped: true })], { windowSec: 60 });
  assert.ok(off.includes(`[${AT}] 500 GET https://x/y\n    (body capture disabled)\n`), off);
  assert.equal(h.screen.EV_BODY_DISABLED, '(body capture disabled)');
  // A request with neither a body nor the flag gets no line under it at all.
  const bare = h.fn.evBuildTxt('R', 'T', [net({ url: 'https://x/y' })], { windowSec: 60 });
  assert.ok(bare.endsWith(`== Network (1) ==\n[${AT}] 500 GET https://x/y\n`), bare);
});

// ---------- what the hover card says (rows 18-22) ----------

test('18: a request to the site under test is shown by its path — the origin is not the news', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  assert.equal(h.fn.evShortUrl(`${SITE}/api/x?y=1`), '/api/x?y=1');
});

test('19: a request that LEFT the recorded site keeps its host, because that is the news', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  assert.equal(h.fn.evShortUrl('https://cdn.other/z'), 'cdn.other/z');
  // With no recorded tab to compare against, every host is foreign.
  h.evUi.tabUrl = '';
  assert.equal(h.fn.evShortUrl(`${SITE}/api/x`), 'shop.example.com/api/x');
});

test('20: the site root is a slash, not an empty cell', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  assert.equal(h.fn.evShortUrl(SITE), '/');
  assert.equal(h.fn.evShortUrl(`${SITE}/`), '/');
});

test('21: a string that is no URL at all comes back as it came', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  assert.equal(h.fn.evShortUrl('/rel/path'), '/rel/path');
  assert.equal(h.fn.evShortUrl(''), '');
  assert.equal(h.fn.evShortUrl(undefined), '');
});

test('22: a row is aged, not clocked — inside a trailing window the age is the fact', () => {
  const h = load();
  assert.equal(h.fn.evAge(NOW - 30_000), '30s');
  assert.equal(h.fn.evAge(NOW - 3_599_000), '1h'); // 59.98 minutes rounds to 60, and 60 to one hour
  assert.equal(h.fn.evAge(NOW - 7_200_000), '2h');
  assert.equal(h.fn.evAge(NOW + 5_000), '0s');     // a clock skew is not a negative age
  assert.equal(h.fn.evAge(NOW - 60_000), '1m');
});

// ---------- the three settings gates (rows 23-28) ----------

test('23: the kept window mirrors the recorder\'s clamp — 10 to 600, rounded, 60 by default', () => {
  const h = load({ settings: {} });
  assert.equal(h.fn.evWindowSeconds(), 60);
  const at = (evidenceWindowSec) => { h.state.settings = { evidenceWindowSec }; return h.fn.evWindowSeconds(); };
  assert.equal(at(5), 10);
  assert.equal(at('abc'), 60);
  assert.equal(at(1000), 600);
  assert.equal(at(45.6), 46);
  assert.equal(at(60), 60);
  h.state.settings = undefined;
  assert.equal(h.fn.evWindowSeconds(), 60);
  // TODAY, and NOT what the recorder answers: state.settings starts life as null (core/state.js),
  // and Number(null) is a finite 0, so the clamp floors it at 10. See the todo at the end.
  h.state.settings = null;
  assert.equal(h.fn.evWindowSeconds(), 10);
});

test('24: auto-attach is on until the tester explicitly turns it off', () => {
  const h = load();
  assert.equal(h.fn.evidenceAutoAttachEnabled(undefined), true);
  assert.equal(h.fn.evidenceAutoAttachEnabled({}), true);
  assert.equal(h.fn.evidenceAutoAttachEnabled({ evidenceAutoAttach: false }), false);
  assert.equal(h.fn.evidenceAutoAttachEnabled({ evidenceAutoAttach: 0 }), true); // a falsy 0 is not "off"
});

test('25: body capture follows the same absent-means-on rule', () => {
  const h = load();
  assert.equal(h.fn.evidenceCaptureBodiesEnabled(undefined), true);
  assert.equal(h.fn.evidenceCaptureBodiesEnabled({}), true);
  assert.equal(h.fn.evidenceCaptureBodiesEnabled({ evidenceCaptureBodies: false }), false);
  assert.equal(h.fn.evidenceCaptureBodiesEnabled({ evidenceCaptureBodies: 0 }), true);
});

test('26: auto-start is the one that defaults OFF — a recorder nobody switched on is the surprise', () => {
  const h = load();
  assert.equal(h.fn.evidenceAutoStartEnabled(undefined), false);
  assert.equal(h.fn.evidenceAutoStartEnabled({}), false);
  assert.equal(h.fn.evidenceAutoStartEnabled({ evidenceAutoStart: true }), true);
  assert.equal(h.fn.evidenceAutoStartEnabled({ evidenceAutoStart: 'yes' }), false); // only the boolean
  // The three gates really do disagree on the same empty settings object.
  assert.deepEqual(
    [h.fn.evidenceAutoAttachEnabled({}), h.fn.evidenceCaptureBodiesEnabled({}), h.fn.evidenceAutoStartEnabled({})],
    [true, true, false],
  );
});

test('27: the flag the tested page reads is its OWN key — the token in `settings` never goes near it', async () => {
  const h = load({ settings: {} });
  await h.fn.mirrorCaptureBodiesForRelay();
  assert.deepEqual(h.store.ops('local', 'set').map((c) => c.arg), [{ evidenceCaptureBodies: true }]);
  assert.deepEqual(Object.keys(h.store.data), ['evidenceCaptureBodies']);

  const off = load({ settings: { evidenceCaptureBodies: false, apiToken: 'secret' } });
  await off.fn.mirrorCaptureBodiesForRelay();
  assert.deepEqual(off.store.ops('local', 'set').map((c) => c.arg), [{ evidenceCaptureBodies: false }]);
  assert.equal(JSON.stringify(off.store.data).includes('secret'), false);
});

test('28: a storage that refuses the write is not a crash the Rec click carries', async () => {
  const h = load();
  h.store.fails.set = new Error('storage unavailable');
  await h.fn.mirrorCaptureBodiesForRelay(); // swallowed whole
  assert.equal(h.store.ops('local', 'set').length, 1);
  // A build with no storage area does not even reach for it.
  const bare = load({ storage: false });
  await bare.fn.mirrorCaptureBodiesForRelay();
  assert.equal(bare.store.ops('local', 'set').length, 0);
  const noChrome = load({ hasChrome: false });
  await noChrome.fn.mirrorCaptureBodiesForRelay();
  assert.equal(noChrome.store.ops('local', 'set').length, 0);
});
