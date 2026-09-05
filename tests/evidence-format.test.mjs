#!/usr/bin/env node
// The escaping layer of extension/sidepanel/screens/evidence-format.js (#157 rows 1-17, moved out of
// tests/evidence.test.mjs by #193): everything a recorded page's own text passes through on its way
// into the tester's markdown comment and into the .txt uploaded onto a failed result. The panel that
// paints it is tests/evidence.test.mjs; this file is only the words.
// The two escapers are the point. A backtick or a newline the page wrote must never close the span
// it is quoted in, and the .txt must never carry a query string — everyone with project access reads
// both. Every other row here pins a layout a tester or a reader is already used to.
// Run: node --test tests/evidence-format.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, plain, SCREENS_SRC, CORE_SRC } from './helpers/panel-harness.mjs';

// The REAL trim from core/env-info.js, not a look-alike: PRIVACY.md's promise is that file's
// wording, and a stub would let row 17 pass against a marker the panel never writes.
// CORE_SRC points the suite at a mutated COPY of core/, so a falsification run never edits it.
const envTrimUrl = runInNewContext(`${readFileSync(join(CORE_SRC, 'env-info.js'), 'utf8')}\nenvTrimUrl;`, { URL });

// buildTxt's window falls back to the panel's own evWindowSeconds, which stays in evidence.js and is
// reached from here as a late-bound global. The real one, read out of the screen the same way, so
// row 15 cannot pass against a figure the panel would never compute; SCREENS_SRC is honoured too.
const screenSrc = readFileSync(join(SCREENS_SRC, 'evidence.js'), 'utf8');

// evTime reads getHours/getMinutes/getSeconds — LOCAL time. Pinned here so the ticket's own UTC
// stamps are the ones asserted; the row also carries a clock-agnostic form beside them.
process.env.TZ = 'UTC';

const NOW = Date.UTC(2026, 8, 3, 14, 6, 9); // what the panel's clock reads
const TS = Date.UTC(2026, 8, 3, 14, 5, 9);  // one minute earlier: every fixture entry's stamp
const AT = '14:05:09';
const SITE = 'https://shop.example.com';

// new Date() stamps the .txt header. The one-argument form stays real, because that is the entry
// timestamp the row stamp is formatted from.
class PinnedDate extends Date {
  constructor(...args) { if (!args.length) super(NOW); else super(...args); }
}

const con = (over = {}) => ({ kind: 'console', level: 'error', text: 'boom', ts: TS, ...over });
const net = (over = {}) => ({ kind: 'network', status: 500, method: 'GET', url: `${SITE}/api/y`, ts: TS, ...over });

// One module, its two late-bound globals, and the `state` the second of them reads. A fresh context
// per row: the window row rewrites the settings, and no other row may inherit that.
function load() {
  const state = { settings: {} };
  const evWindowSeconds = runInNewContext(`${screenSrc}\nevWindowSeconds;`, { state });
  const h = loadScreen('evidence-format', {
    exported: 'EvidenceFormat',
    globals: { envTrimUrl, evWindowSeconds, Date: PinnedDate },
  });
  // EvidenceFormat is a lexical const: invisible as a sandbox property, reachable only off the
  // completion value, the same seam tests/md-sections.test.mjs uses.
  return { f: h.screen, state };
}

// ---------- formatting one entry (rows 1-5) ----------

test('1: the stamp on a row is the tester\'s own wall clock, zero-padded', () => {
  const h = load();
  assert.equal(h.f.time(TS), AT);
  // Built from local parts instead of UTC, so the padding is asserted wherever the suite runs.
  assert.equal(h.f.time(new Date(2026, 8, 3, 4, 5, 9).getTime()), '04:05:09');
  assert.equal(h.f.time(new Date(2026, 8, 3, 23, 59, 59).getTime()), '23:59:59');
});

test('2: a message becomes one line, and a long one loses its tail to an ellipsis', () => {
  const h = load();
  assert.equal(h.f.oneLine('  a \n b  ', 4), 'a b');
  assert.equal(h.f.oneLine('abcdef', 4), 'abc…');
  assert.equal(h.f.oneLine(null), '');
  // The ellipsis replaces the last kept character, so the cap is the cap: 4 in, 4 out.
  assert.equal(h.f.oneLine('abcd', 4), 'abcd');
  assert.equal(h.f.oneLine('abcde', 4).length, 4);
});

test('3: a request that never got a status says ERR, and a status of 0 is a figure, not a dash', () => {
  const h = load();
  assert.equal(h.f.netStatus({ errorText: 'net::ERR_FAILED' }), 'ERR');
  assert.equal(h.f.netStatus({ status: 0 }), 0);
  assert.equal(h.f.netStatus({}), '—');
  // A failure that DID carry a code keeps it — the errorText is not a blanket override.
  assert.equal(h.f.netStatus({ errorText: 'net::ERR_FAILED', status: 500 }), 500);
});

test('4: an uncaught throw is not a console call, and never reads as one', () => {
  const h = load();
  assert.equal(h.f.label({ kind: 'exception', level: 'error' }), 'uncaught.error');
  assert.equal(h.f.label({ kind: 'log', level: 'warning' }), 'log.warning');
  assert.equal(h.f.label({ kind: 'console', level: 'error' }), 'console.error');
});

test('5: the location is source:line:col, and each part is dropped once it is missing', () => {
  const h = load();
  assert.equal(h.f.loc({ url: 'a.js', line: 5, col: 0 }), 'a.js:5');
  assert.equal(h.f.loc({ url: 'a.js' }), 'a.js');
  assert.equal(h.f.loc({}), '');
  // The column only an uncaught row carries does print when it is really there.
  assert.equal(h.f.loc({ url: 'a.js', line: 5, col: 7 }), 'a.js:5:7');
});

test('5b (#292): the location trims only for the caller that hands it a policy, and only the URL', () => {
  const h = load();
  const at = { url: `${SITE}/reset?token=abc123`, line: 42, col: 7 };
  // The two uploading callers pass envTrimUrl. The line and column are not an address: they stay.
  assert.equal(h.f.loc(at, envTrimUrl), `${SITE}/reset (query trimmed):42:7`);
  // No policy handed in — the on-screen call — and the address comes back exactly as the page wrote it.
  assert.equal(h.f.loc(at), `${SITE}/reset?token=abc123:42:7`);
  // A bare filename is not a URL at all: envTrimUrl hands it straight back, so row 5 holds either way.
  assert.equal(h.f.loc({ url: 'a.js', line: 5, col: 7 }, envTrimUrl), 'a.js:5:7');
  assert.equal(h.f.loc({ url: 'a.js' }, envTrimUrl), 'a.js');
  assert.equal(h.f.loc({}, envTrimUrl), ''); // nothing to trim is still nothing to print
});

// ---------- the escaping that keeps a recorded page out of the comment (rows 6-8) ----------

test('6: a backtick written by the page cannot close the span it is quoted in', () => {
  const h = load();
  // The fence grows past the longest run inside, and CommonMark eats one pad space each end.
  assert.equal(h.f.inlineCode('`code`'), '`` `code` ``');
  // The fence still outgrows a run in the MIDDLE; the pad is only for a tick against the edge.
  assert.equal(h.f.inlineCode('a ``` b'), '````a ``` b````');
  // Nothing to escape: no pad, one tick — the growth is a reaction, not a habit.
  assert.equal(h.f.inlineCode('plain'), '`plain`');
});

test('7: a newline written by the page cannot end the quote from inside', () => {
  const h = load();
  assert.equal(h.f.inlineCode('a\nb  c'), '`a b c`');
  assert.equal(h.f.inlineCode('> quoted\n> lines'), '`> quoted > lines`');
});

test('8: a fenced body opens and closes past the longest backtick run it contains', () => {
  const h = load();
  assert.equal(h.f.fence('a\n```\nb'), '````\na\n```\nb\n````');
  assert.equal(h.f.fence('plain'), '```\nplain\n```'); // the floor is three, not one
});

// ---------- snippets, row keys, icons (rows 9-13) ----------

test('9: a failed request drops into the comment as a quote plus its fenced body', () => {
  const h = load();
  const entry = net({ url: 'https://x/y', bodySnippet: '{"a":1}', bodyTruncated: true });
  assert.equal(
    h.f.entrySnippet(entry),
    `> \`[500 GET https://x/y ${AT}]\`\n\n\`\`\`\n{"a":1}\n… (truncated)\n\`\`\``,
  );
  // A transport failure names itself inside the same quote.
  assert.equal(
    h.f.entrySnippet(net({ url: 'https://x/y', status: undefined, errorText: 'net::ERR_FAILED' })),
    `> \`[ERR GET https://x/y net::ERR_FAILED ${AT}]\``,
  );
  // No body captured: the quote stands alone, with no empty fence under it.
  assert.equal(h.f.entrySnippet(net({ url: 'https://x/y' })), `> \`[500 GET https://x/y ${AT}]\``);
});

test('10: a console row is one quoted line, and a novel of a message is cut to 200', () => {
  const h = load();
  assert.equal(h.f.entrySnippet(con()), `> \`[console.error ${AT}] boom\``);
  const long = h.f.entrySnippet(con({ text: 'x'.repeat(500) }));
  assert.ok(long.endsWith('…`'), long.slice(-20));
  assert.equal(long, `> \`[console.error ${AT}] ${'x'.repeat(199)}…\``);
  assert.equal(long.split('\n').length, 1);
});

test('10b (#292): the snippet Attach writes trims the request URL — the comment is uploaded too', () => {
  const h = load();
  // Was the full address, in a comment that goes to the server with the result.
  assert.equal(
    h.f.entrySnippet(net({ url: `${SITE}/pay?token=abc123&card=4111` })),
    `> \`[500 GET ${SITE}/pay (query trimmed) ${AT}]\``,
  );
  // The transport-failure form quotes the same trimmed address, not a second raw one beside it.
  assert.equal(
    h.f.entrySnippet(net({ url: `${SITE}/pay?token=abc123`, status: undefined, errorText: 'net::ERR_FAILED' })),
    `> \`[ERR GET ${SITE}/pay (query trimmed) net::ERR_FAILED ${AT}]\``,
  );
  // A URL with nothing to cut is quoted whole, with no marker hung on it — row 9 still holds.
  assert.equal(h.f.entrySnippet(net({ url: `${SITE}/pay` })), `> \`[500 GET ${SITE}/pay ${AT}]\``);
  // The console branch quotes the message and the label ONLY: it carries no address to leak, whatever
  // the entry knows about its source. #292 read it as a second leak; it never was one.
  assert.equal(
    h.f.entrySnippet(con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })),
    `> \`[console.error ${AT}] boom\``,
  );
});

test('11: a body the recorder cut is marked as cut, wherever it goes', () => {
  const h = load();
  const snippet = h.f.entrySnippet(net({ bodySnippet: 'abc', bodyTruncated: true }));
  assert.ok(snippet.endsWith('```\nabc\n… (truncated)\n```'), snippet);
  // The same body NOT flagged carries no marker — the flag is what prints it.
  assert.ok(!h.f.entrySnippet(net({ bodySnippet: 'abc' })).includes('(truncated)'));
});

test('12: a row keeps the same key across the 2 s repaint, redirect hops apart', () => {
  const h = load();
  assert.equal(h.f.key({ kind: 'network', ts: 1, requestId: 'r1' }), 'network:1:r1');
  assert.equal(h.f.key({ kind: 'network', ts: 1, method: 'GET', url: 'u' }), 'network:1:GET u');
  assert.equal(h.f.key({ kind: 'console', ts: 2, text: 'x' }), 'console:2:x');
  // Two hops of one redirect share ts, method and url — only the requestId tells them apart.
  const hop = (requestId) => h.f.key({ kind: 'network', ts: 1, method: 'GET', url: 'u', requestId });
  assert.notEqual(hop('r1'), hop('r2'));
});

test('13: the icon and the severity that colours it never disagree', () => {
  const h = load();
  assert.deepEqual(plain(h.f.icon({ kind: 'network', errorText: 'e' })), { name: 'block', kind: 'error' });
  assert.deepEqual(plain(h.f.icon({ kind: 'network' })), { name: 'language', kind: 'net' });
  assert.deepEqual(plain(h.f.icon({ kind: 'console', level: 'warning' })), { name: 'warning', kind: 'warning' });
  assert.deepEqual(plain(h.f.icon({ kind: 'exception', level: 'error' })), { name: 'error', kind: 'error' });
});

// ---------- the .txt that leaves the browser (rows 14-17) ----------

test('14: the log reads as a document — header, Console, Network, bodies indented under their request', () => {
  const h = load();
  const entries = [
    con({ text: 'boom', url: 'a.js', line: 5 }),
    net({ url: 'https://x/y', resourceType: 'xhr', bodySnippet: '{"a":1}', bodyTruncated: true }),
  ];
  assert.equal(
    h.f.buildTxt('Run A', 'Test B', entries, { tabTitle: 'Shop', tabUrl: `${SITE}/cart`, windowSec: 60 }),
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
  const txt = h.f.buildTxt('', '', [net({ url: 'https://x/y', status: undefined, errorText: 'net::ERR_FAILED' })], { windowSec: 60 });
  assert.ok(txt.startsWith('Console & network log — Run / Test\n'), txt.split('\n')[0]);
  assert.ok(txt.includes(`[${AT}] ERR GET https://x/y — net::ERR_FAILED`), txt);
  assert.ok(!txt.includes('URL:'), 'no tab URL was recorded, so no URL line'); // the header is 3 lines here
});

test('15: nothing captured is still a readable file — both sections say (none)', () => {
  const h = load();
  const txt = h.f.buildTxt('Run A', 'Test B', [], { windowSec: 60 });
  assert.ok(txt.includes('Recorded tab: —'), txt);
  assert.ok(txt.includes('== Console (0) ==\n(none)\n'), txt);
  assert.ok(txt.includes('== Network (0) ==\n(none)\n'), txt);
  // …and the (none) really is a stand-in: an entry in either section takes its place.
  const one = h.f.buildTxt('Run A', 'Test B', [con()], { windowSec: 60 });
  assert.ok(!one.includes('== Console (0) ==\n(none)'), one);
  assert.ok(one.includes('== Network (0) ==\n(none)'), one);
});

test('15 (#269): a snapshot with no window still writes a number into the uploaded .txt', () => {
  const h = load();
  const win = (txt) => txt.split('\n').find((l) => l.startsWith('Window:'));
  // EvidenceUpload.log hands buildTxt `snap.status || {}`, so this is a shape it really gets.
  // Was: 'Window: last undefineds · 0 entries · …', in a file uploaded onto the result.
  assert.match(win(h.f.buildTxt('Run A', 'Test B', [], {})), /^Window: last \d+s · 0 entries · /);
  // The stand-in is the panel's own kept window, not a figure invented for the header.
  h.state.settings = { evidenceWindowSec: 90 };
  assert.match(win(h.f.buildTxt('Run A', 'Test B', [], {})), /^Window: last 90s · /);
  // …and a status that DOES carry one is still quoted as it came, fallback or no fallback.
  assert.match(win(h.f.buildTxt('Run A', 'Test B', [], { windowSec: 120 })), /^Window: last 120s · /);
});

test('16: a body the tester switched off is named as switched off, not as an empty one', () => {
  const h = load();
  const off = h.f.buildTxt('R', 'T', [net({ url: 'https://x/y', bodySkipped: true })], { windowSec: 60 });
  assert.ok(off.includes(`[${AT}] 500 GET https://x/y\n    (body capture disabled)\n`), off);
  assert.equal(h.f.BODY_DISABLED, '(body capture disabled)');
  // A request with neither a body nor the flag gets no line under it at all.
  const bare = h.f.buildTxt('R', 'T', [net({ url: 'https://x/y' })], { windowSec: 60 });
  assert.ok(bare.endsWith(`== Network (1) ==\n[${AT}] 500 GET https://x/y\n`), bare);
});

test('17 (#266): the uploaded .txt trims a request URL to its path, as PRIVACY.md promises', () => {
  const h = load();
  const txt = h.f.buildTxt('R', 'T', [net({ url: `${SITE}/pay?token=abc123&card=4111` })],
    { tabUrl: `${SITE}/reset?token=abc123`, windowSec: 60 });
  // This file is uploaded onto the result, where everyone with project access reads it.
  assert.ok(!txt.includes('token=abc123'), txt);
  // …and what stands in its place still names the request, marked as cut.
  assert.ok(txt.includes(`URL: ${SITE}/reset (query trimmed)`), txt);
  assert.ok(txt.includes(`500 GET ${SITE}/pay (query trimmed)`), txt);
  // A URL with nothing to cut is written whole, with no marker hung on it.
  const clean = h.f.buildTxt('R', 'T', [net({ url: `${SITE}/pay` })], { tabUrl: `${SITE}/cart`, windowSec: 60 });
  assert.ok(clean.includes(`URL: ${SITE}/cart\n`), clean);
  assert.ok(clean.includes(`500 GET ${SITE}/pay\n`), clean);
  assert.ok(!clean.includes('query trimmed'), clean);
});

test('17b (#292): the uploaded .txt trims a CONSOLE row\'s source as well, and keeps its line:col', () => {
  const h = load();
  const txt = h.f.buildTxt('R', 'T', [con({ url: `${SITE}/reset?token=abc123`, line: 42, col: 7 })],
    { windowSec: 60 });
  // Was the whole address — in the one file whose own header promises every address in it is trimmed.
  assert.ok(!txt.includes('token=abc123'), txt);
  assert.ok(txt.includes(`[${AT}] console.error: boom (${SITE}/reset (query trimmed):42:7)`), txt);
  // What the tester needs to FIND the line survives the cut: the line and column are still there.
  const clean = h.f.buildTxt('R', 'T', [con({ url: 'a.js', line: 5 })], { windowSec: 60 });
  assert.ok(clean.includes(`[${AT}] console.error: boom (a.js:5)`), clean);
  assert.ok(!clean.includes('query trimmed'), clean); // a bundle filename is not a URL to trim
  // A row with no source at all still ends after its message, with no empty bracket hung on it.
  assert.ok(h.f.buildTxt('R', 'T', [con()], { windowSec: 60 })
    .includes(`[${AT}] console.error: boom\n`), 'no source, no parenthesis');
});
