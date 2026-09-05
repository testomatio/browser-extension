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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, fakeChrome, fakeClock, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

// The REAL trim from core/env-info.js, not a look-alike: PRIVACY.md's promise is that file's
// wording, and a stub would let row 17 pass against a marker the panel never writes.
// CORE_SRC points the suite at a mutated COPY of core/, so a falsification run never edits it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = process.env.CORE_SRC || join(repoRoot, 'extension/sidepanel/core');
const envTrimUrl = runInNewContext(`${readFileSync(join(CORE_SRC, 'env-info.js'), 'utf8')}\nenvTrimUrl;`, { URL });

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
    envTrimUrl,
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

test('5b (#292): the location trims only for the caller that hands it a policy, and only the URL', () => {
  const h = load();
  const at = { url: `${SITE}/reset?token=abc123`, line: 42, col: 7 };
  // The two uploading callers pass envTrimUrl. The line and column are not an address: they stay.
  assert.equal(h.fn.evLoc(at, envTrimUrl), `${SITE}/reset (query trimmed):42:7`);
  // No policy handed in — the on-screen call — and the address comes back exactly as the page wrote it.
  assert.equal(h.fn.evLoc(at), `${SITE}/reset?token=abc123:42:7`);
  // A bare filename is not a URL at all: envTrimUrl hands it straight back, so row 5 holds either way.
  assert.equal(h.fn.evLoc({ url: 'a.js', line: 5, col: 7 }, envTrimUrl), 'a.js:5:7');
  assert.equal(h.fn.evLoc({ url: 'a.js' }, envTrimUrl), 'a.js');
  assert.equal(h.fn.evLoc({}, envTrimUrl), ''); // nothing to trim is still nothing to print
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

test('10b (#292): the snippet Attach writes trims the request URL — the comment is uploaded too', () => {
  const h = load();
  // Was the full address, in a comment that goes to the server with the result.
  assert.equal(
    h.fn.evEntrySnippet(net({ url: `${SITE}/pay?token=abc123&card=4111` })),
    `> \`[500 GET ${SITE}/pay (query trimmed) ${AT}]\``,
  );
  // The transport-failure form quotes the same trimmed address, not a second raw one beside it.
  assert.equal(
    h.fn.evEntrySnippet(net({ url: `${SITE}/pay?token=abc123`, status: undefined, errorText: 'net::ERR_FAILED' })),
    `> \`[ERR GET ${SITE}/pay (query trimmed) net::ERR_FAILED ${AT}]\``,
  );
  // A URL with nothing to cut is quoted whole, with no marker hung on it — row 9 still holds.
  assert.equal(h.fn.evEntrySnippet(net({ url: `${SITE}/pay` })), `> \`[500 GET ${SITE}/pay ${AT}]\``);
  // The console branch quotes the message and the label ONLY: it carries no address to leak, whatever
  // the entry knows about its source. #292 read it as a second leak; it never was one.
  assert.equal(
    h.fn.evEntrySnippet(con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })),
    `> \`[console.error ${AT}] boom\``,
  );
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

test('15 (#269): a snapshot with no window still writes a number into the uploaded .txt', () => {
  const h = load();
  const win = (txt) => txt.split('\n').find((l) => l.startsWith('Window:'));
  // uploadEvidenceLog hands evBuildTxt `snap.status || {}`, so this is a shape it really gets.
  // Was: 'Window: last undefineds · 0 entries · …', in a file uploaded onto the result.
  assert.match(win(h.fn.evBuildTxt('Run A', 'Test B', [], {})), /^Window: last \d+s · 0 entries · /);
  // The stand-in is the panel's own kept window, not a figure invented for the header.
  h.state.settings = { evidenceWindowSec: 90 };
  assert.match(win(h.fn.evBuildTxt('Run A', 'Test B', [], {})), /^Window: last 90s · /);
  // …and a status that DOES carry one is still quoted as it came, fallback or no fallback.
  assert.match(win(h.fn.evBuildTxt('Run A', 'Test B', [], { windowSec: 120 })), /^Window: last 120s · /);
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

test('17 (#266): the uploaded .txt trims a request URL to its path, as PRIVACY.md promises', () => {
  const h = load();
  const txt = h.fn.evBuildTxt('R', 'T', [net({ url: `${SITE}/pay?token=abc123&card=4111` })],
    { tabUrl: `${SITE}/reset?token=abc123`, windowSec: 60 });
  // This file is uploaded onto the result, where everyone with project access reads it.
  assert.ok(!txt.includes('token=abc123'), txt);
  // …and what stands in its place still names the request, marked as cut.
  assert.ok(txt.includes(`URL: ${SITE}/reset (query trimmed)`), txt);
  assert.ok(txt.includes(`500 GET ${SITE}/pay (query trimmed)`), txt);
  // A URL with nothing to cut is written whole, with no marker hung on it.
  const clean = h.fn.evBuildTxt('R', 'T', [net({ url: `${SITE}/pay` })], { tabUrl: `${SITE}/cart`, windowSec: 60 });
  assert.ok(clean.includes(`URL: ${SITE}/cart\n`), clean);
  assert.ok(clean.includes(`500 GET ${SITE}/pay\n`), clean);
  assert.ok(!clean.includes('query trimmed'), clean);
});

test('17b (#292): the uploaded .txt trims a CONSOLE row\'s source as well, and keeps its line:col', () => {
  const h = load();
  const txt = h.fn.evBuildTxt('R', 'T', [con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })],
    { windowSec: 60 });
  // Was the whole address — in the one file whose own header promises every address in it is trimmed.
  assert.ok(!txt.includes('token=abc123'), txt);
  assert.ok(txt.includes(`[${AT}] console.error: boom (${SITE}/reset (query trimmed):42:7)`), txt);
  // What the tester needs to FIND the line survives the cut: the line and column are still there.
  const clean = h.fn.evBuildTxt('R', 'T', [con({ url: 'a.js', line: 5 })], { windowSec: 60 });
  assert.ok(clean.includes(`[${AT}] console.error: boom (a.js:5)`), clean);
  assert.ok(!clean.includes('query trimmed'), clean); // a bundle filename is not a URL to trim
  // A row with no source at all still ends after its message, with no empty bracket hung on it.
  assert.ok(h.fn.evBuildTxt('R', 'T', [con()], { windowSec: 60 })
    .includes(`[${AT}] console.error: boom\n`), 'no source, no parenthesis');
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

test('21 (#268): a data: URL on the card keeps the scheme that says what it is', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  // Was: 'text/plain,hi' — a payload the tester read as a path the site under test served.
  assert.equal(h.fn.evShortUrl('data:text/plain,hi'), 'data:text/plain,hi');
  // The same for every host-less scheme: what new URL calls the "path" there is not an address.
  assert.equal(h.fn.evShortUrl('blob:https://shop.example.com/9f2-4e'), 'blob:https://shop.example.com/9f2-4e');
  assert.equal(h.fn.evShortUrl('file:///tmp/report.html'), 'file:///tmp/report.html');
  // A request that HAS a host is still shortened the same way it always was.
  assert.equal(h.fn.evShortUrl(`${SITE}/api/x?y=1`), '/api/x?y=1');
  assert.equal(h.fn.evShortUrl('https://cdn.other/z'), 'cdn.other/z');
  // …and a payload longer than the card still goes through the same shortener.
  assert.equal(h.fn.evShortUrl(`data:image/png;base64,${'A'.repeat(400)}`).length, 200);
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
  // state.settings starts life as null (core/state.js) and Number(null) is a finite 0, so an
  // unguarded clamp floored it at 10 while the recorder kept 60. The row below is the whole rule.
  h.state.settings = null;
  assert.equal(h.fn.evWindowSeconds(), 60);
});

// The three ways the value can be missing, every one of which the recorder answers 60 for: the
// settings not loaded yet, the key never written, and the null stored for an out-of-range entry.
test('23 (#264): every way the window can go missing quotes the recorder\'s 60s, not 10s', () => {
  const h = load({ settings: null });
  assert.equal(h.fn.evWindowSeconds(), 60, 'nothing loaded yet — the panel a tester opens cold');
  h.state.settings = { evidenceWindowSec: null };
  assert.equal(h.fn.evWindowSeconds(), 60, 'settings.js stores null when what was typed is refused');
  h.state.settings = { baseUrl: 'https://app.testomat.io' };
  assert.equal(h.fn.evWindowSeconds(), 60, 'the key never written at all');
  // A 0 the tester actually typed is a VALUE, not a gap: the `!= null` guard must not swallow it,
  // and the recorder floors it at 10 the same way.
  h.state.settings = { evidenceWindowSec: 0 };
  assert.equal(h.fn.evWindowSeconds(), 10);
  h.state.settings = { evidenceWindowSec: '0' };
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

// ---------- which testrun a recording belongs to (rows 29-32) ----------

test('29: the tester is told what ended the recording, unless naming it would mean the test title', () => {
  const h = load();
  assert.equal(h.fn.evStoppedMessage('target_closed'), 'Recording stopped — the recorded tab was closed');
  assert.equal(h.fn.evStoppedMessage('panel-closed'), 'Recording stopped — the panel was closed');
  assert.equal(h.fn.evStoppedMessage('left-testrun'), 'Recording stopped');
  assert.equal(h.fn.evStoppedMessage(undefined), 'Recording stopped');
});

test('30: a live session whose testrun is not the screen on show has been left behind', () => {
  const h = load({ view: 'run' });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  assert.equal(h.fn.evLeftBoundTestrun(), true);
  // Back on the test it started in, it has not been left at all.
  h.state.view = 'test';
  assert.equal(h.fn.evLeftBoundTestrun(), false);
  // …and a screen with no recording under it is never "left", wherever the tester is.
  h.evUi.recording = false;
  h.state.view = 'run';
  assert.equal(h.fn.evLeftBoundTestrun(), false);
});

test('31: a panel reload passes through the run view on its way back — that is not leaving', () => {
  const h = load({ view: 'run', booting: true });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  assert.equal(h.fn.evLeftBoundTestrun(), false);
  // The same screen once the boot has finished IS a departure.
  h.state.booting = false;
  assert.equal(h.fn.evLeftBoundTestrun(), true);
});

test('32: the bound testrun is compared stringified — a numeric id and its string are one testrun', () => {
  const h = load({ currentRecordId: 7 });
  h.evUi.recording = true;
  h.evUi.recordId = '7';
  assert.equal(h.fn.evLeftBoundTestrun(), false);
  // A genuinely different testrun on the same screen still ends the session.
  h.state.currentRecordId = 8;
  assert.equal(h.fn.evLeftBoundTestrun(), true);
});

// ---------- status and the Rec toggle (rows 33-39) ----------

const RECORDING = { recording: true, tabId: 7, recordId: '55', tabTitle: 'Shop', tabUrl: `${SITE}/cart` };

test('33: a stopped recorder leaves no live error count standing on the chip', async () => {
  const h = load({ reply: (m) => (m.type === 'EVIDENCE_LIST'
    ? { ok: true, status: { recording: true }, entries: [con(), net()] }
    : { ok: true, status: { recording: false } }) });
  h.fn.applyEvidenceStatus(RECORDING);
  await settle();
  assert.equal(h.evUi.errors.length, 2);
  assert.equal(h.node.evidenceErrors.textContent, '2');
  assert.equal(h.node.evidenceErrors.hidden, false);

  h.fn.applyEvidenceStatus({ recording: false });
  assert.deepEqual(plain(h.evUi.errors), []);
  assert.equal(h.calls.card.close, 1);          // and the card the pointer may be resting in shuts
  assert.equal(h.node.evidenceErrors.hidden, true);
  assert.equal(h.node.evidenceErrors.textContent, '');
});

test('33b: a status that does not stop the recording leaves the rows where they are', async () => {
  const h = load({ reply: (m) => (m.type === 'EVIDENCE_LIST'
    ? { ok: true, status: { recording: true }, entries: [con(), net()] }
    : { ok: true, status: { recording: false } }) });
  h.fn.applyEvidenceStatus(RECORDING);
  await settle();
  h.fn.applyEvidenceStatus({ ...RECORDING, tabTitle: 'Shop — cart' });
  assert.equal(h.evUi.errors.length, 2);
  assert.equal(h.calls.card.close, 0);
  assert.equal(h.node.evidenceToggle.getAttribute('aria-label'), 'Rec — recording Shop — cart, 2 errors caught, click to stop');
});

test('33c: the chip counts the RECORDING, so rows left over from an ended one show no figure', () => {
  const h = load();
  // The second line of defence behind the clear in applyEvidenceStatus: whatever is still in the
  // list, an idle chip must read as "nothing has been recorded", never as "recorded, 2 errors".
  h.evUi.errors = [con(), net()];
  h.fn.renderEvidenceToggle();
  assert.equal(h.node.evidenceErrors.hidden, true);
  assert.equal(h.node.evidenceErrors.textContent, '');
  assert.equal(h.node.evidenceToggle.getAttribute('aria-label'),
    'Rec — record the console & network log from the tab under test');

  // The identical rows under a live recording are exactly what the chip is for.
  h.evUi.recording = true;
  h.evUi.tabTitle = 'Shop';
  h.fn.renderEvidenceToggle();
  assert.equal(h.node.evidenceErrors.hidden, false);
  assert.equal(h.node.evidenceErrors.textContent, '2');
  assert.equal(h.node.evidenceToggle.getAttribute('aria-label'), 'Rec — recording Shop, 2 errors caught, click to stop');

  // One error is singular, and the chip belongs to the test view alone.
  h.evUi.errors = [con()];
  h.fn.renderEvidenceToggle();
  assert.equal(h.node.evidenceToggle.getAttribute('aria-label'), 'Rec — recording Shop, 1 error caught, click to stop');
  h.state.view = 'run';
  h.fn.renderEvidenceToggle();
  assert.equal(h.node.evidenceToggle.hidden, true);
  assert.equal(h.node.recSlot.hidden, true); // the slot follows it, so the tabs row loses no width
});

test('34: an answer with no status at all resets the screen instead of throwing', () => {
  const h = load();
  h.fn.applyEvidenceStatus(RECORDING);
  assert.equal(h.evUi.recording, true);
  h.fn.applyEvidenceStatus(undefined);
  assert.deepEqual(
    [h.evUi.recording, h.evUi.tabId, h.evUi.recordId, h.evUi.tabTitle, h.evUi.tabUrl],
    [false, null, null, '', ''],
  );
  assert.equal(h.node.evidenceToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(h.node.evidenceToggle.getAttribute('aria-label'),
    'Rec — record the console & network log from the tab under test');
});

test('35: Rec off the test view, or with no testrun to belong to, says so and starts nothing', async () => {
  for (const opts of [{ view: 'run' }, { currentRecordId: null }]) {
    const h = load(opts);
    await h.fn.onEvidenceToggle();
    assert.deepEqual(h.calls.toasts, [{ msg: NO_TEST }], JSON.stringify(opts));
    assert.deepEqual(h.types(), [], JSON.stringify(opts));
    assert.deepEqual(h.calls.disabledAt, [], JSON.stringify(opts)); // it never reached the resolver
    assert.equal(h.node.evidenceToggle.disabled, false);
  }
  // The identical click inside an open test does start a session.
  const open = load({ reply: () => ({ ok: true, status: RECORDING }) });
  await open.fn.onEvidenceToggle();
  assert.deepEqual(open.calls.sends[0], { type: 'EVIDENCE_TOGGLE', tabId: 7, recordId: '55' });
});

test('36: a page Chrome keeps extensions off is named, and the button comes back', async () => {
  const h = load({ site: { state: 'system-page', tab: null, origin: null, error: 'That page cannot be recorded' } });
  await h.fn.onEvidenceToggle();
  assert.deepEqual(h.calls.toasts, [{ msg: 'That page cannot be recorded', error: true }]);
  assert.deepEqual(h.types(), []);
  assert.equal(h.store.ops('local', 'set').length, 0); // not even the body-capture flag was written
  assert.deepEqual(h.calls.disabledAt, [true]);        // held down while the resolver ran…
  assert.equal(h.node.evidenceToggle.disabled, false); // …and released by the finally
});

test('37: a start writes the page\'s flag BEFORE the toggle, so the hook cannot ask too early', async () => {
  const h = load({ reply: (m) => (m.type === 'EVIDENCE_TOGGLE'
    ? { ok: true, status: RECORDING }
    : { ok: true, status: { recording: true }, entries: [] }) });
  await h.fn.onEvidenceToggle();
  await settle();
  assert.deepEqual(h.calls.order, [
    'resolveSiteTab', 'storage.set', 'send:EVIDENCE_TOGGLE',
    // The status is applied before the toast, and the poll it starts asks for its first figure
    // straight away rather than waiting the 2 s out.
    'card.attach', 'card.update', 'send:EVIDENCE_LIST', 'toast', 'card.update',
  ]);
  assert.deepEqual(h.calls.sends[0], { type: 'EVIDENCE_TOGGLE', tabId: 7, recordId: '55' });
  assert.deepEqual(h.store.ops('local', 'set').map((c) => c.arg), [{ evidenceCaptureBodies: true }]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording Shop' }]);
});

test('37b: a recorder that answers without a tab title still names something', async () => {
  const h = load({ reply: () => ({ ok: true, status: { recording: true, tabId: 7, recordId: '55' } }) });
  await h.fn.onEvidenceToggle();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording tab' }]);
});

test('38: the stop carries the testrun on SHOW, not the one the session was bound to', async () => {
  const h = load({ currentRecordId: '55' });
  h.evUi.recording = true;
  h.evUi.recordId = '99'; // a session started in another testrun and restored across a reload
  await h.fn.onEvidenceToggle();
  assert.deepEqual(h.calls.sends[0], { type: 'EVIDENCE_TOGGLE', tabId: null, recordId: '55' });
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording stopped' }]);
  assert.deepEqual(h.calls.disabledAt, []); // stopping never resolves a tab
});

test('39: a recorder that refuses says why and then re-reads the truth from the worker', async () => {
  const h = load({ reply: () => ({ ok: false, error: 'x' }) });
  await h.fn.onEvidenceToggle();
  await settle();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recorder: x', error: true }]);
  assert.deepEqual(h.types(), ['EVIDENCE_TOGGLE', 'EVIDENCE_STATUS']);
  // A STOP the worker never answered is named too, rather than passing for a success.
  const gone = load({ reply: () => undefined });
  gone.evUi.recording = true;
  await gone.fn.onEvidenceToggle();
  await settle();
  assert.deepEqual(gone.calls.toasts, [{ msg: 'Recorder: unavailable', error: true }]);
  assert.deepEqual(gone.types(), ['EVIDENCE_TOGGLE', 'EVIDENCE_STATUS']);
});

test('39 (#267): a recorder that refused is toasted as an error, not as a confirmation', async () => {
  const h = load({ reply: () => ({ ok: false, error: 'x' }) });
  await h.fn.onEvidenceToggle();
  await settle();
  // Was the ordinary confirmation style, in the very place a success is announced.
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recorder: x', error: true }]);
  // A page Chrome keeps extensions off is the same news, and carries the same flag.
  const off = load({ site: { state: 'system-page', tab: null, origin: null, error: 'That page cannot be recorded' } });
  await off.fn.onEvidenceToggle();
  assert.deepEqual(off.calls.toasts, [{ msg: 'That page cannot be recorded', error: true }]);
  // …while a start that WORKED stays a plain confirmation: the flag is the failure's, not the flow's.
  const ok = load({ reply: () => ({ ok: true, status: RECORDING }) });
  await ok.fn.onEvidenceToggle();
  assert.deepEqual(ok.calls.toasts, [{ msg: 'Recording Shop' }]);
});

test('39c (#265): an unanswered START says "Recorder: unavailable", like an unanswered stop', async () => {
  // chrome.runtime.sendMessage resolves to undefined when nothing answered, and the start path read
  // `r.unrecordable` one line above the `!r` guard the stop path already enjoyed.
  const h = load({ reply: () => undefined });
  await h.fn.onEvidenceToggle();
  await settle();
  // Was: "Recorder error: Cannot read properties of undefined (reading 'unrecordable')".
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recorder: unavailable', error: true }]);
  // …and the refresh the TypeError used to skip runs, so the chip stops showing what it last had.
  assert.deepEqual(h.types(), ['EVIDENCE_TOGGLE', 'EVIDENCE_STATUS']);
  assert.equal(h.node.evidenceToggle.disabled, false);
  // The answer that DOES carry `unrecordable` still reaches its own sentence, not this one.
  const off = load({ site: { state: 'system-page', tab: null, origin: null, error: 'That page cannot be recorded' } });
  await off.fn.onEvidenceToggle();
  assert.deepEqual(off.calls.toasts, [{ msg: 'That page cannot be recorded', error: true }]);
  assert.deepEqual(off.types(), []);
});

test('39b: a throw inside the flow is a sentence, and the button is released all the same', async () => {
  const h = load({ resolveSiteTab: async () => { throw new Error('tabs query failed'); } });
  await h.fn.onEvidenceToggle();
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recorder error: tabs query failed', error: true }]);
  assert.equal(h.node.evidenceToggle.disabled, false);
  assert.deepEqual(h.types(), []);
});

test('39d (#291): a throw is toasted as an error too — the last exit #267 did not reach', async () => {
  // A worker that answers `ok` with no status: the confirmation one line below reads
  // r.status.recording and throws. A second real way into this catch, next to 39b's.
  const h = load({ reply: () => ({ ok: true }) });
  await h.fn.onEvidenceToggle();
  await settle();
  // Was the plain confirmation style, in the very slot `Recording stopped` uses — so the failure read
  // as "done", and a reader's screen reader queued it as a status instead of interrupting.
  assert.equal(h.calls.toasts.length, 1);
  assert.equal(h.calls.toasts[0].error, true);
  assert.ok(h.calls.toasts[0].msg.startsWith('Recorder error: '), h.calls.toasts[0].msg);
  assert.equal(h.node.evidenceToggle.disabled, false); // …and the button still comes back
  // All four exits of the handler now agree, and only a success stays a plain confirmation.
  const ok = load({ reply: () => ({ ok: true, status: RECORDING }) });
  await ok.fn.onEvidenceToggle();
  assert.deepEqual(ok.calls.toasts, [{ msg: 'Recording Shop' }]);
});

// ---------- starting by itself, and the 2 s poll (rows 40-48) ----------

const AUTO = { evidenceAutoStart: true };
const started = (m) => (m.type === 'EVIDENCE_TOGGLE'
  ? { ok: true, status: { recording: true, tabId: 7, recordId: '55', tabTitle: 'Shop' } }
  : { ok: true, status: { recording: true }, entries: [] });

test('40: entering a testrun arms the recorder — but only with the setting on and nothing running', async () => {
  const off = load({ settings: {}, reply: started });
  await off.fn.evAutoStartOnTestView();
  assert.deepEqual(off.types(), []);

  const busy = load({ settings: AUTO, reply: started });
  busy.evUi.recording = true;
  await busy.fn.evAutoStartOnTestView();
  assert.deepEqual(busy.types(), []);

  const noRun = load({ settings: AUTO, currentRecordId: null, reply: started });
  await noRun.fn.evAutoStartOnTestView();
  assert.deepEqual(noRun.types(), []);

  const away = load({ settings: AUTO, view: 'run', reply: started });
  await away.fn.evAutoStartOnTestView();
  assert.deepEqual(away.types(), []);

  // All four conditions met, driven identically: the session starts and the poll begins.
  const on = load({ settings: AUTO, reply: started });
  await on.fn.evAutoStartOnTestView();
  await settle();
  assert.deepEqual(on.calls.sends[0], { type: 'EVIDENCE_TOGGLE', tabId: 7, recordId: '55' });
  assert.equal(on.evUi.recording, true);
  assert.deepEqual(on.clock.arms(), [2000]);
});

test('41: Back and straight forward again inside one round trip starts ONE session, not two', async () => {
  const h = load({ settings: AUTO, reply: started });
  const first = h.fn.evAutoStartOnTestView();
  const second = h.fn.evAutoStartOnTestView();
  await first;
  await second;
  await settle();
  // A second toggle would have STOPPED the first one's session, which is the whole point.
  assert.deepEqual(h.types().filter((t) => t === 'EVIDENCE_TOGGLE'), ['EVIDENCE_TOGGLE']);
  // One entry on its own still starts one, so the row above is not counting a stub that never sends.
  const alone = load({ settings: AUTO, reply: started });
  await alone.fn.evAutoStartOnTestView();
  assert.deepEqual(alone.types().filter((t) => t === 'EVIDENCE_TOGGLE'), ['EVIDENCE_TOGGLE']);
});

test('41b: the question is re-asked after EVERY await — a tester gone by the flag write starts nothing', async () => {
  // Left between resolving the tab and writing the page's flag.
  let a = null;
  a = load({ settings: AUTO, reply: started, resolveSiteTab: async () => { a.state.view = 'run'; return a.site; } });
  a.site = { state: 'ok', tab: { id: 7 }, origin: SITE, error: null };
  await a.fn.evAutoStartOnTestView();
  assert.deepEqual(a.types(), []);
  assert.equal(a.store.ops('local', 'set').length, 0);

  // Left between the flag write and the toggle: the flag is out, the session is not.
  let b = null;
  b = load({ settings: AUTO, reply: started, onMirror: () => { b.state.currentRecordId = '56'; } });
  await b.fn.evAutoStartOnTestView();
  assert.deepEqual(b.types(), []);
  assert.equal(b.store.ops('local', 'set').length, 1);
});

test('42: a session that lands after the tester walked off is still applied, then ended by the poll', async () => {
  let h = null;
  h = load({
    settings: AUTO,
    onSend: (m) => { if (m.type === 'EVIDENCE_TOGGLE') h.state.view = 'run'; },
    reply: started,
  });
  await h.fn.evAutoStartOnTestView();
  await settle();
  // Only a LIVE session can be the one the poll then stops — the stop is the proof it was applied.
  assert.deepEqual(h.calls.sends, [
    { type: 'EVIDENCE_TOGGLE', tabId: 7, recordId: '55' },
    { type: 'EVIDENCE_STOP', reason: 'left-testrun' },
  ]);
  assert.equal(h.evUi.recording, false);
  assert.equal(h.clock.count(), 0); // and the 2 s timer it armed went with it

  // The same start with the tester still on the test keeps the session and polls instead.
  const stay = load({ settings: AUTO, reply: started });
  await stay.fn.evAutoStartOnTestView();
  await settle();
  assert.deepEqual(stay.types(), ['EVIDENCE_TOGGLE', 'EVIDENCE_LIST']);
  assert.equal(stay.evUi.recording, true);
});

test('43: an automatic start is silent in both outcomes — a toast on every test opened is noise', async () => {
  const ok = load({ settings: AUTO, reply: started });
  await ok.fn.evAutoStartOnTestView();
  await settle();
  assert.deepEqual(ok.calls.toasts, []);

  const blocked = load({ settings: AUTO, site: { state: 'system-page', tab: null, origin: null, error: 'That page cannot be recorded' } });
  await blocked.fn.evAutoStartOnTestView();
  assert.deepEqual(blocked.calls.toasts, []);
  assert.deepEqual(blocked.types(), []);
  // The tester's OWN click on that same page does say it — the silence belongs to the auto-start.
  await blocked.fn.onEvidenceToggle();
  assert.deepEqual(blocked.calls.toasts, [{ msg: 'That page cannot be recorded', error: true }]);
});

test('44: a poll that finds the tester gone clears the chip FIRST and only then tells the worker', async () => {
  const h = load({ view: 'run' });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  await h.fn.pollEvidenceErrors();
  assert.deepEqual(h.calls.sends, [{ type: 'EVIDENCE_STOP', reason: 'left-testrun' }]);
  // Cleared before the round trip, so the screen being left cannot hold a live chip meanwhile.
  assert.deepEqual(h.calls.recordingAt, [{ type: 'EVIDENCE_STOP', recording: false }]);
  assert.equal(h.evUi.recording, false);

  // The same poll on the testrun the session belongs to asks for the list instead.
  const home = load({ reply: () => ({ ok: true, status: { recording: true }, entries: [con()] }) });
  home.evUi.recording = true;
  home.evUi.recordId = '55';
  await home.fn.pollEvidenceErrors();
  assert.deepEqual(home.types(), ['EVIDENCE_LIST']);
  assert.equal(home.evUi.errors.length, 1);
});

test('45: a recorder that stopped underneath us wins — its rows never reach the screen', async () => {
  const h = load({ reply: () => ({ ok: true, status: { recording: false }, entries: [con({ text: 'B' })] }) });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  h.evUi.errors = [con({ text: 'A' })];
  await h.fn.pollEvidenceErrors();
  assert.deepEqual(h.types(), ['EVIDENCE_LIST']);
  assert.equal(h.evUi.recording, false);
  assert.deepEqual(plain(h.evUi.errors), []); // B never lands, and A goes with the stop

  // A poll the worker could not answer changes nothing at all.
  const lost = load({ reply: () => ({ ok: false, error: 'no-extension' }) });
  lost.evUi.recording = true;
  lost.evUi.recordId = '55';
  lost.evUi.errors = [con({ text: 'A' })];
  await lost.fn.pollEvidenceErrors();
  assert.equal(lost.evUi.recording, true);
  assert.deepEqual(plain(lost.evUi.errors).map((e) => e.text), ['A']);
});

test('46: the recording gets ONE 2 s poll, and the count does not wait 2 s for its first figure', async () => {
  const h = load({ reply: () => ({ ok: true, status: { recording: true }, entries: [con(), net()] }) });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  h.fn.syncEvidencePolling();
  await settle();
  assert.deepEqual(h.clock.arms(), [2000]);
  // The immediate first poll, and it asks for the errors ONLY: the section is an error log, and a
  // full console would bury the two rows the tester came for under every info line the page wrote.
  assert.deepEqual(h.calls.sends, [{ type: 'EVIDENCE_LIST', errorsOnly: true }]);
  assert.equal(h.evUi.errors.length, 2);

  h.fn.syncEvidencePolling(); // a second sync must not stack a second timer
  assert.equal(h.clock.count(), 1);
  assert.deepEqual(h.clock.arms(), [2000]);

  await h.clock.tick();
  await settle();
  assert.deepEqual(h.types(), ['EVIDENCE_LIST', 'EVIDENCE_LIST']);
});

test('47: the timer belongs to the recording — a stop takes it away', async () => {
  const h = load({ reply: () => ({ ok: true, status: { recording: true }, entries: [] }) });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  h.fn.syncEvidencePolling();
  await settle();
  assert.equal(h.clock.count(), 1);

  h.evUi.recording = false;
  h.fn.syncEvidencePolling();
  assert.equal(h.clock.count(), 0);
  assert.equal(h.evUi.pollTimer, null);
  assert.deepEqual(h.clock.cleared.length, 1);
  // A tick after the stop reaches nothing: no further round trip is made.
  const before = h.calls.sends.length;
  await h.clock.tick();
  await settle();
  assert.equal(h.calls.sends.length, before);
});

test('48: leaving the test retires the rows the tester had open — a later recording opens none of them', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.expanded.add('console:1:boom');
  h.state.view = 'run';
  h.fn.updateEvidenceSection();
  assert.equal(h.node.evidenceSection.hidden, true);
  assert.equal(h.evUi.expanded.size, 0);

  // On the test, with the recording still live, the same call keeps them.
  const stay = load();
  stay.evUi.recording = true;
  stay.evUi.expanded.add('console:1:boom');
  stay.fn.updateEvidenceSection();
  assert.equal(stay.node.evidenceSection.hidden, false);
  assert.equal(stay.evUi.expanded.size, 1);

  // The fold itself belongs to the test view, not to the recording: idle it is still on show.
  const idle = load();
  idle.evUi.expanded.add('console:1:boom');
  idle.fn.updateEvidenceSection();
  assert.equal(idle.node.evidenceSection.hidden, false);
  assert.equal(idle.evUi.expanded.size, 0); // …but the keys retire with the session that made them
});

// ---------- the list (rows 49-52) ----------

const many = (n) => Array.from({ length: n }, (_, i) => con({ text: `e${i}`, ts: TS + i }));

test('49: a page that logged 250 errors draws the last 100 — the figure still counts them all', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.sectionOpen = true;
  h.evUi.errors = many(250);
  h.fn.renderEvidenceList();
  assert.equal(h.rows().length, 100);
  assert.equal(h.rows()[0].querySelector('.ev-text').textContent, `console.error · e150 · ${AT}`);
  assert.equal(h.rows()[99].querySelector('.ev-text').textContent, `console.error · e249 · ${AT}`);
  assert.equal(h.node.evidenceCount.textContent, '250');
});

test('49b: a row the tester opened is still open after the 2 s repaint', async () => {
  const entries = many(4);
  const h = load({ reply: () => ({ ok: true, status: { recording: true }, entries }) });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  h.evUi.sectionOpen = true;
  await h.fn.pollEvidenceErrors();
  const open = (i) => h.rows()[i].classList.contains('expanded');
  assert.deepEqual([open(0), open(1), open(2), open(3)], [false, false, false, false]);

  const head = h.rows()[2].querySelector('.ev-row-head');
  fire(head, 'click');
  assert.equal(open(2), true);
  assert.equal(h.rows()[2].querySelector('.ev-details').hidden, false);

  await h.clock.tick(); // …nothing armed yet, but the poll is what the interval calls
  await h.fn.pollEvidenceErrors();
  assert.deepEqual([open(0), open(1), open(2), open(3)], [false, false, true, false]);
  assert.equal(h.rows()[2].querySelector('.ev-details').hidden, false);

  // Clicking it shut survives the repaint just as well — the verdict is the set, not the DOM.
  fire(h.rows()[2].querySelector('.ev-row-head'), 'click');
  await h.fn.pollEvidenceErrors();
  assert.equal(open(2), false);
  assert.equal(h.evUi.expanded.size, 0);
});

test('49c: the Attach button on a row does not also fold the row open', async () => {
  const entries = [con()];
  const h = load({ reply: () => ({ ok: true, status: { recording: true }, entries }) });
  h.evUi.recording = true;
  h.evUi.recordId = '55';
  h.evUi.sectionOpen = true;
  await h.fn.pollEvidenceErrors();
  const row = h.rows()[0];
  const head = row.querySelector('.ev-row-head');
  // The click really lands on the button inside the head, the way a pointer delivers it.
  fire(head, 'click', { target: row.querySelector('.ev-attach') });
  assert.equal(row.classList.contains('expanded'), false);
  // …while the same click anywhere else in the head does open it.
  fire(head, 'click');
  assert.equal(row.classList.contains('expanded'), true);
});

test('50: idle carries NO figure — a "0" beside the name would read as "recorded, and clean"', () => {
  const h = load();
  h.evUi.sectionOpen = true;
  h.evUi.errors = [con(), net()]; // stale rows from a session that has ended
  h.fn.renderEvidenceList();
  assert.equal(h.node.evidenceCount.hidden, true);
  assert.equal(h.node.evidenceCount.textContent, '');
  assert.deepEqual(h.calls.counters, []); // paintCounter is never even asked for a figure
  assert.deepEqual(h.calls.empties.map((e) => e.icon), ['fiber_manual_record']);
  const hint = h.rows()[0].querySelector('.empty-text').textContent;
  assert.ok(hint.startsWith('Not recording. Click Rec at the top of the panel'), hint);
  assert.ok(hint.includes('the last 60s are kept'), hint);
});

test('51: an empty errors-only log is a TICK, not a shrug — the page behaved', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.sectionOpen = true;
  h.fn.renderEvidenceList();
  assert.equal(h.node.evidenceCount.hidden, false);
  assert.equal(h.node.evidenceCount.textContent, '0');
  assert.deepEqual(h.calls.empties.map((e) => e.icon), ['check_circle']);
  assert.equal(h.rows()[0].querySelector('.empty-text').textContent, 'No console or network errors captured yet.');
  // The moment one error arrives, the tick gives way to the row.
  h.evUi.errors = [con()];
  h.fn.renderEvidenceList();
  assert.equal(h.node.evidenceCount.textContent, '1');
  assert.equal(h.rows()[0].querySelector('.ev-text').textContent, `console.error · boom · ${AT}`);
});

test('52: a folded section costs nothing to repaint — the count still moves', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.errors = [con(), net()];
  const sentinel = el('li', { id: 'sentinel' });
  h.node.evidenceList.append(sentinel);
  h.fn.renderEvidenceList();
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0], sentinel);        // the list was never touched
  assert.equal(h.node.evidenceCount.textContent, '2'); // the head's figure was

  // Unfolding it draws the rows over the sentinel, so the row above is not asserting a dead call.
  h.evUi.sectionOpen = true;
  h.fn.renderEvidenceList();
  assert.equal(h.rows().length, 2);
  assert.equal(h.rows()[0].className, 'evidence-row ev-con');
});

// The dt/dd pairs of an expanded row, read back by their own label.
const detailsOf = (box) => {
  const dt = box.querySelectorAll('dt').map((n) => n.textContent);
  const dd = box.querySelectorAll('dd').map((n) => n.textContent);
  return Object.fromEntries(dt.map((k, i) => [k, dd[i]]));
};

test('52b (#292): the expanded row on SCREEN keeps the address whole — that is what finds the bug', () => {
  const h = load();
  // DELIBERATE, not the leak #292 left behind: this card never leaves the browser, and a tester
  // looking at their own page needs the address that reopens it, query string and all.
  const con1 = detailsOf(h.fn.evDetails(con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })));
  assert.equal(con1.Location, `${SITE}/reset?token=abc123:42:7`);
  const net1 = detailsOf(h.fn.evDetails(net({ url: `${SITE}/pay?token=abc123&card=4111` })));
  assert.equal(net1.URL, `${SITE}/pay?token=abc123&card=4111`);
  // …and the row the LIST paints is that same untrimmed one, not a second rendering.
  h.evUi.recording = true;
  h.evUi.sectionOpen = true;
  h.evUi.errors = [con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })];
  h.fn.renderEvidenceList();
  assert.equal(detailsOf(h.rows()[0].querySelector('.ev-details')).Location,
    `${SITE}/reset?token=abc123:42:7`);
  // The one-line row text is on screen too, and keeps the query for the same reason.
  assert.equal(h.fn.evRowText(net({ url: `${SITE}/pay?token=abc123` })),
    `500 GET ${SITE}/pay?token=abc123 · ${AT}`);
});

// ---------- attaching one row to the comment (rows 53-54) ----------

test('53: Attach drops the snippet into the comment and tells the draft-save it changed', () => {
  const h = load();
  const seen = [];
  h.node.testComment.addEventListener('input', (ev) => { seen.push({ type: ev.type, bubbles: ev.bubbles }); });

  h.fn.attachEvidenceEntry(con());
  assert.equal(h.node.testComment.value, `> \`[console.error ${AT}] boom\``);
  assert.deepEqual(h.calls.toasts, [{ msg: ATTACHED }]);

  // A second row appends under the first, on its own line — it never replaces what is there.
  h.fn.attachEvidenceEntry(net({ url: 'https://x/y' }));
  assert.equal(
    h.node.testComment.value,
    `> \`[console.error ${AT}] boom\`\n> \`[500 GET https://x/y ${AT}]\``,
  );
  // Without the bubbling `input` the comment-draft save never runs and the tester's text is lost.
  assert.deepEqual(seen, [{ type: 'input', bubbles: true }, { type: 'input', bubbles: true }]);
});

test('53b: text the tester typed themselves keeps its place above the snippet', () => {
  const h = load();
  h.node.testComment.value = 'Repro: click Buy twice';
  h.fn.attachEvidenceEntry(con());
  assert.equal(h.node.testComment.value, `Repro: click Buy twice\n> \`[console.error ${AT}] boom\``);
});

test('54: a panel with no comment box to attach to is not a crash', () => {
  const h = load({ without: ['test-comment'] });
  h.fn.attachEvidenceEntry(con());
  assert.deepEqual(h.calls.toasts, []); // silent: nothing was attached, so nothing is claimed
  // The same entry on a panel that HAS the box does toast, so the silence is the missing box.
  const box = load();
  box.fn.attachEvidenceEntry(con());
  assert.deepEqual(box.calls.toasts, [{ msg: ATTACHED }]);
});

// ---------- the upload on a failed test (rows 55-59) ----------

const SNAP = {
  ok: true,
  entries: [con(), net({ url: 'https://x/y', bodySnippet: '{"a":1}' })],
  status: { tabTitle: 'Shop', tabUrl: `${SITE}/cart`, windowSec: 60 },
};
const recorded = (m) => {
  if (m.type === 'EVIDENCE_STATUS') return { ok: true, status: { recording: true } };
  if (m.type === 'EVIDENCE_SNAPSHOT') return SNAP;
  return { ok: true, status: { recording: false } };
};

test('55: with no result to hang it on, or auto-attach off, the FAIL attaches nothing', async () => {
  const none = load({ reply: recorded });
  assert.equal(await none.fn.uploadEvidenceLog(null), '');
  assert.equal(await none.fn.uploadEvidenceLog({}), '');
  assert.equal(await none.fn.uploadEvidenceLog({ id: '' }), '');
  assert.deepEqual(none.types(), []);

  const off = load({ settings: { evidenceAutoAttach: false }, reply: recorded });
  assert.equal(await off.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(off.types(), []);
  assert.deepEqual(off.calls.uploads, []);

  // The same record with the gate open goes all the way to the upload.
  const on = load({ reply: recorded });
  assert.equal(await on.fn.uploadEvidenceLog({ id: '900' }), UPLOADED);
});

test('56: a recorder that is not recording is asked for no snapshot at all', async () => {
  const idle = load({ reply: (m) => (m.type === 'EVIDENCE_STATUS'
    ? { ok: true, status: { recording: false } } : recorded(m)) });
  assert.equal(await idle.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(idle.types(), ['EVIDENCE_STATUS']);

  const gone = load({ reply: (m) => (m.type === 'EVIDENCE_STATUS' ? { ok: false, error: 'no-extension' } : recorded(m)) });
  assert.equal(await gone.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(gone.types(), ['EVIDENCE_STATUS']);

  // A snapshot the worker could not build stops one step later, before any blob is made.
  const empty = load({ reply: (m) => (m.type === 'EVIDENCE_SNAPSHOT' ? { ok: false } : recorded(m)) });
  assert.equal(await empty.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(empty.types(), ['EVIDENCE_STATUS', 'EVIDENCE_SNAPSHOT']);
  assert.deepEqual(empty.calls.uploads, []);
});

test('57: the FAIL uploads the window as a named .txt, and hands back the URL the META key needs', async () => {
  const h = load({ reply: recorded });
  const url = await h.fn.uploadEvidenceLog({ id: '900', test_title: 'Test B' });
  assert.equal(url, UPLOADED);
  assert.deepEqual(h.types(), ['EVIDENCE_STATUS', 'EVIDENCE_SNAPSHOT']);
  assert.equal(h.calls.uploads.length, 1);
  const sent = h.calls.uploads[0];
  assert.equal(sent.id, '900');
  assert.equal(sent.name, `evidence-900-${NOW}.txt`);
  assert.equal(sent.blob.type, 'text/plain');
  // The run title comes from `state`, the test title from the record, the rows from the snapshot.
  assert.ok(sent.blob.text.startsWith('Console & network log — Run A / Test B\nRecorded tab: Shop\n'), sent.blob.text);
  assert.ok(sent.blob.text.includes('== Console (1) ==\n[14:05:09] console.error: boom'), sent.blob.text);
  assert.ok(sent.blob.text.includes('== Network (1) ==\n[14:05:09] 500 GET https://x/y\n    {"a":1}'), sent.blob.text);
  assert.equal(sent.blob.text, h.fn.evBuildTxt('Run A', 'Test B', SNAP.entries, SNAP.status));
});

test('57b: a record with no title of its own borrows the one on screen', async () => {
  const h = load({ testTitle: 'Checkout — guest', reply: recorded });
  await h.fn.uploadEvidenceLog({ id: '900' });
  assert.ok(h.calls.uploads[0].blob.text.startsWith('Console & network log — Run A / Checkout — guest\n'));
  // With neither, the artifact still names itself rather than printing an empty half.
  const bare = load({ reply: recorded, without: ['test-title'] });
  await bare.fn.uploadEvidenceLog({ id: '900' });
  assert.ok(bare.calls.uploads[0].blob.text.startsWith('Console & network log — Run A / Test\n'));
});

test('58: an upload that fails is non-fatal — the status write already landed', async () => {
  const broke = load({ reply: recorded, upload: () => { throw new Error('413 too large'); } });
  assert.equal(await broke.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(broke.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (413 too large)", error: true },
  ]);

  const silent = load({ reply: recorded, upload: () => ({}) });
  assert.equal(await silent.fn.uploadEvidenceLog({ id: '900' }), '');
  assert.deepEqual(silent.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (upload returned no url)", error: true },
  ]);
  // A landing upload says nothing at all: the sentence is the failure's, not the flow's.
  const ok = load({ reply: recorded });
  assert.equal(await ok.fn.uploadEvidenceLog({ id: '900' }), UPLOADED);
  assert.deepEqual(ok.calls.toasts, []);
});

test('58 (#267): a log that could not attach is toasted as an error, not as a confirmation', async () => {
  const h = load({ reply: recorded, upload: () => { throw new Error('413 too large'); } });
  await h.fn.uploadEvidenceLog({ id: '900' });
  // The status write landed and the evidence did not — the sentence saying so used to look
  // exactly like the sentences that mean everything went fine.
  assert.deepEqual(h.calls.toasts, [
    { msg: "Test marked failed — the console & network log couldn't attach (413 too large)", error: true },
  ]);
  // Those sentences are still unflagged: the upload that landed says nothing at all…
  const ok = load({ reply: recorded });
  await ok.fn.uploadEvidenceLog({ id: '900' });
  assert.deepEqual(ok.calls.toasts, []);
  // …and the one confirmation this screen does print stays a confirmation.
  const attached = load();
  attached.fn.attachEvidenceEntry(con());
  assert.deepEqual(attached.calls.toasts, [{ msg: ATTACHED }]);
});

// ---------- wiring, messaging and the card (rows 60-64) ----------

test('60: in the chain the dot keeps pulsing, so a "stopped" toast would contradict the screen', () => {
  const h = load({ settings: AUTO });
  h.fn.initEvidence();
  h.calls.toasts.length = 0;
  h.calls.listener({ type: 'EVIDENCE_STOPPED', reason: 'left-testrun' });
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.evUi.recording, false); // …but the status was applied all the same

  // Every other reason keeps its sentence, chain or no chain.
  h.calls.listener({ type: 'EVIDENCE_STOPPED', reason: 'target_closed' });
  h.calls.listener({ type: 'EVIDENCE_STOPPED', reason: 'panel-closed' });
  assert.deepEqual(h.calls.toasts, [
    { msg: 'Recording stopped — the recorded tab was closed' },
    { msg: 'Recording stopped — the panel was closed' },
  ]);
  // And a message that is not ours is not ours.
  h.calls.listener({ type: 'SOMETHING_ELSE', reason: 'target_closed' });
  h.calls.listener(null);
  assert.equal(h.calls.toasts.length, 2);
});

test('60b: nothing is chained without the setting, the test view AND a testrun — then it does say so', () => {
  const cases = [
    { settings: {} },                       // auto-start off: nothing will restart
    { settings: AUTO, view: 'run' },        // not on a test: nothing to start on
    { settings: AUTO, currentRecordId: null }, // no testrun to bind a new session to
  ];
  for (const opts of cases) {
    const h = load(opts);
    h.fn.initEvidence();
    h.calls.toasts.length = 0;
    h.calls.listener({ type: 'EVIDENCE_STOPPED', reason: 'left-testrun' });
    assert.deepEqual(h.calls.toasts, [{ msg: 'Recording stopped' }], JSON.stringify(opts));
  }
});

test('60c: init wires the Rec chip and the fold, and asks the worker what it is doing', async () => {
  const h = load({ reply: (m) => (m.type === 'EVIDENCE_TOGGLE'
    ? { ok: true, status: { recording: true, tabId: 7, recordId: '55', tabTitle: 'Shop' } }
    : { ok: true, status: { recording: false } }) });
  h.fn.initEvidence();
  await settle();
  assert.deepEqual(h.types(), ['EVIDENCE_STATUS']);

  h.click('evidenceHead');
  assert.equal(h.evUi.sectionOpen, true);
  assert.equal(h.node.evidenceHead.getAttribute('aria-expanded'), 'true');
  assert.equal(h.node.evidenceBody.hidden, false);

  h.click('evidenceToggle');
  await settle();
  assert.deepEqual(h.calls.sends[1], { type: 'EVIDENCE_TOGGLE', tabId: 7, recordId: '55' });
  assert.deepEqual(h.calls.toasts, [{ msg: 'Recording Shop' }]);
  // …and folding it shut again is the same click.
  h.click('evidenceHead');
  assert.equal(h.evUi.sectionOpen, false);
  assert.equal(h.node.evidenceBody.hidden, true);
});

test('61: outside the extension context every message answers instead of throwing', async () => {
  for (const opts of [{ hasChrome: false }, { runtime: false }]) {
    const h = load(opts);
    assert.deepEqual(plain(await h.fn.evSend({ type: 'EVIDENCE_STATUS' })), { ok: false, error: 'no-extension' },
      JSON.stringify(opts));
    assert.deepEqual(h.calls.sends, [], JSON.stringify(opts));
  }
  // A live context passes the worker's own answer straight back.
  const live = load({ reply: () => ({ ok: true, status: { recording: true } }) });
  assert.deepEqual(plain(await live.fn.evSend({ type: 'EVIDENCE_STATUS' })), { ok: true, status: { recording: true } });
});

test('62: a worker torn down mid-message hands its sentence back rather than throwing', async () => {
  const gone = load({ reply: () => Promise.reject(new Error('Receiving end does not exist')) });
  assert.deepEqual(plain(await gone.fn.evSend({ type: 'EVIDENCE_STATUS' })),
    { ok: false, error: 'Receiving end does not exist' });
  // A rejection that is not an Error at all still reads as a sentence.
  const odd = load({ reply: () => Promise.reject('boom') });
  assert.deepEqual(plain(await odd.fn.evSend({ type: 'EVIDENCE_STATUS' })), { ok: false, error: 'boom' });
});

test('63: on the card a console row drops its prefix while an uncaught throw keeps its word', () => {
  const h = load();
  h.evUi.tabUrl = `${SITE}/cart`;
  assert.equal(h.fn.evCardRowText({ kind: 'exception', text: 'boom' }), 'uncaught · boom');
  assert.equal(h.fn.evCardRowText({ kind: 'console', level: 'error', text: 'boom' }), 'boom');
  assert.equal(h.fn.evCardRowText(net({ url: `${SITE}/api/y` })), '500 GET /api/y');
});

test('64: the card is a glance at what just happened — the newest six, newest first, then "+N more"', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.tabTitle = 'Shop';
  h.evUi.errors = many(9);
  const box = h.fn.evRecordingCard();
  assert.equal(box.querySelector('.hovercard-title').textContent, 'Shop');
  assert.equal(box.querySelector('.hovercard-meta').textContent, '9 errors · last 60s');
  assert.deepEqual(
    box.querySelectorAll('.hovercard-row').map((r) => r.querySelector('.hovercard-text').textContent),
    ['e8', 'e7', 'e6', 'e5', 'e4', 'e3'],
  );
  assert.equal(box.querySelector('.hovercard-more').textContent, '+3 more');
  assert.equal(h.screen.EV_CARD_ROWS, 6);
});

test('64b: exactly six errors fit, and none of them is a "+0 more"', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.errors = many(6);
  const box = h.fn.evRecordingCard();
  assert.equal(box.querySelectorAll('.hovercard-row').length, 6);
  assert.equal(box.querySelector('.hovercard-more'), null);
  assert.equal(box.querySelector('.hovercard-meta').textContent, '6 errors · last 60s');
});

test('64c: a clean page says so, and the foot changes with the screen the tester is on', () => {
  const h = load();
  h.evUi.recording = true;
  const clean = h.fn.evRecordingCard();
  assert.equal(clean.querySelector('.hovercard-meta').textContent, 'No errors yet · last 60s');
  assert.equal(clean.querySelectorAll('.hovercard-row').length, 0);
  assert.equal(clean.querySelector('.link-btn').textContent, 'Open the console & network log');

  // Off the test view there is no list to open, so the foot says what to do instead.
  h.state.view = 'run';
  const away = h.fn.evRecordingCard();
  assert.equal(away.querySelector('.link-btn'), null);
  assert.equal(away.querySelector('.hovercard-foot').textContent, 'Open a test to attach these — click Rec to stop.');
});

test('64d: the link on the card lands the tester on the rows, in the tab that holds them', () => {
  const h = load();
  h.evUi.recording = true;
  h.evUi.errors = many(2);
  const box = h.fn.evRecordingCard();
  fire(box.querySelector('.link-btn'), 'click');
  // The fold lives in the Status tab, which a test does not open on: the tab is switched FIRST.
  assert.deepEqual(h.calls.sections, ['status']);
  assert.equal(h.evUi.sectionOpen, true);
  assert.equal(h.calls.card.close, 1);
});

// ===================== shipped bugs, carried over unfixed =====================

// Every row below asserts what the tester should get; each fails against today's file. The numbers
// stay as placeholders — the issues are described in the PR, not filed from here.

// 11: nothing on this path caps the body. A recorded page can post fabricated rows with a
// megabyte-long bodySnippet and the whole of it lands in the tester's comment.
// 23 (#264) was one of these and is fixed — it reads as a rule up with the settings gates now.

// 59 (#107): the offline queue replays a parked FAIL through writeStatus -> writeEnvMeta -> here, and
// a queue entry carries no snapshot. What gets uploaded is the recorder's buffer at REPLAY time —
// whatever page the tester happens to be on now — filed under the result of a test failed hours ago.
test.todo('59 (#107): a replayed FAIL attaches the log captured when it was marked, not the one now', async () => {
  const atFailTime = [con({ text: 'the error the tester saw' })];
  const rightNow = [con({ text: 'an unrelated page open at replay time' })];
  const h = load({ reply: (m) => {
    if (m.type === 'EVIDENCE_STATUS') return { ok: true, status: { recording: true } };
    if (m.type === 'EVIDENCE_SNAPSHOT') return { ok: true, entries: rightNow, status: { windowSec: 60 } };
    return { ok: true, status: { recording: false } };
  } });
  await h.fn.uploadEvidenceLog({ id: '900', test_title: 'T', queuedAt: NOW - 3_600_000, entries: atFailTime });
  assert.ok(h.calls.uploads[0].blob.text.includes('the error the tester saw'), h.calls.uploads[0].blob.text);
});
