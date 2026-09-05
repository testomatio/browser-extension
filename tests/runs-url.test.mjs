#!/usr/bin/env node
// The security seam of extension/sidepanel/screens/runs-url.js (rows 21-28, 72-73 and 84, and the
// status-line-versus-toast half of row 33, moved out of tests/runs-list.test.mjs by #195): what one
// pasted string is allowed to mean.
// The Runs search box does two jobs with one field, and both of them start here. A value is a LINK
// or it is a title the tester typed — and a link is resolved against the configured host AND the
// configured project before anything is fetched, so a run link on someone else's host is never
// opened, and a panel whose own base URL will not parse resolves nothing rather than falling back to
// a bare-host match. A bare id is 6-12 hex and nothing else. Everything a link is refused for is
// refused silently and identically: the one message every unresolvable link gets says only "Run not
// found", and it goes to the list's own line while the tester is looking at the list, because a
// toast is wiped by the next toast and a line is not (#126).
// Rows 111a-111f are new: the falsification run behind the move found the scheme gate, the host
// equality, the id's own alphabet, the message text and the module's load order pinned nowhere.
// The rows about what the SCREEN then does with an answer — the run it fetches, the settings screen
// it sends a foreign host to — stay in tests/runs-list.test.mjs, which now drives this module for
// real.
// Run: node --test tests/runs-url.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, SCREENS_SRC, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// The switchable directory, so row 111f reads whatever SCREENS_SRC points at; index.html and
// shared/handoff.js belong to neither switchable directory and are read where they ship.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

const BASE = 'https://app.testomat.io';
const HOST = 'app.testomat.io';
const PROJECT = 'my-project';

// `state`, `setStatusLine` and `toast` are the whole dependency list, and only the reporter reaches
// for the last two: no document, no API, no screen. `URL` comes from the harness, which installs it
// because a vm realm has none — without it every parser row below would take its catch branch and
// pass for the wrong reason.
function load(opts = {}) {
  const {
    view = 'runs',
    settings = { baseUrl: BASE, projectId: PROJECT },
    runsSearch = '',
  } = opts;
  const lines = [];   // { id, text, cls }
  const toasts = [];  // { msg, opts } — `opts` undefined is the missing {error:true}, a row of its own
  const state = { view, settings, runsSearch };
  const h = loadScreen('runs-url', {
    globals: {
      state,
      setStatusLine: (id, text, cls = '') => { lines.push({ id, text, cls }); },
      toast: (msg, toastOpts) => { toasts.push({ msg, opts: plain(toastOpts) }); },
    },
    exported: 'RunsUrl',
  });
  return { ...h, url: h.screen, state, lines, toasts };
}

// ---------- link or title: the first gate (rows 21, 72) ----------

test('21: a value with a space in it is never treated as a link — it is what the tester typed', () => {
  const h = load();
  assert.equal(h.url.looksLikeRunUrl('a b/projects/x/runs/1'), false);
  assert.equal(h.url.looksLikeRunUrl('/projects/x/runs/1'), true);
  assert.equal(h.url.looksLikeRunUrl('https://x'), true);
  assert.equal(h.url.looksLikeRunUrl(''), false);
  assert.equal(h.url.looksLikeRunUrl('Nightly regression'), false);
});

test('72: a bare id can never look like a link, so the two jobs of the one field cannot collide', () => {
  const h = load();
  for (const id of ['9f8e7d', '9F8E7D6C', 'abcdef012345']) {
    assert.equal(h.url.looksLikeRunId(id), true);
    assert.equal(h.url.looksLikeRunUrl(id), false);
  }
  // And a link is never mistaken for an id.
  assert.equal(h.url.looksLikeRunId(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`), false);
});

// 111a: `looksLikeRunUrl` is two tests ORed, and only the FIRST is about the scheme — the second
// admits any string carrying the run path, whatever precedes it, because that is the bare
// `host/projects/…/runs/…` shape copied out of an address bar. So a hostile scheme is refused only
// when it carries no run path, and one that DOES carry it is refused a step later, by the host that
// falls out of parsing it. Both halves of that are pinned here: nothing about a `javascript:` or
// `data:` payload ever resolves to a run on this panel's host.
test('111a: a scheme that is not http(s) never resolves — refused at the gate, or by its own host', () => {
  const h = load();
  // No run path: not a link at all, so the field treats it as a title and nothing is fetched.
  for (const v of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
    'chrome-extension://abc/index.html', 'vbscript:msgbox(1)']) {
    assert.equal(h.url.looksLikeRunUrl(v), false, v);
    assert.equal(h.url.parse(v), null, v);
  }
  // WITH a run path the shape test admits them — and every one still resolves to nothing, because
  // the authority `https://` + the value parses out is the scheme's own text and not this host.
  for (const [v, host] of [
    ['javascript:/projects/abc/runs/1', 'javascript'],
    ['data:/projects/abc/runs/1', 'data'],
    ['ftp://h/projects/abc/runs/1', 'ftp'],
  ]) {
    assert.equal(h.url.looksLikeRunUrl(v), true, v);
    assert.equal(plain(h.url.parseParts(v)).host, host, v);
    assert.equal(h.url.parse(v), null, v);
  }
  // A payload that puts the CONFIGURED host after the scheme does not even parse: what stands
  // where the port belongs is `alert(1)`, and a URL with an invalid port throws.
  const smuggled = `javascript:alert(1)//${HOST}/projects/${PROJECT}/runs/9f8e7d6c`;
  assert.equal(h.url.looksLikeRunUrl(smuggled), true);
  assert.equal(h.url.parseParts(smuggled), null);
  assert.equal(h.url.parse(smuggled), null);
  // http and https, in any case, do pass the gate — so the falses above are the scheme, not the shape.
  for (const v of ['HTTPS://app.testomat.io/x', 'http://app.testomat.io/x']) {
    assert.equal(h.url.looksLikeRunUrl(v), true, v);
  }
});

// 111g: a link copied out of a CI log or a chat message arrives with a newline or a space stuck to
// it, and every one of these three trims its input before it looks. Row 28 pins the id's trim; the
// link's two were pinned nowhere, and without them a padded paste is silently a title search — the
// one case row 21 is otherwise all about, since padding is whitespace too.
test('111g: a link pasted with whitespace around it is still a link; whitespace INSIDE it is not', () => {
  const h = load();
  const link = `${BASE}/projects/${PROJECT}/runs/9f8e7d6c`;
  for (const pad of [(v) => ` ${v}`, (v) => `${v} `, (v) => `  ${v}  `, (v) => `${v}\n`,
    (v) => `\n${v}`, (v) => `\t${v}\t`, (v) => `${v}\r\n`]) {
    const padded = pad(link);
    assert.equal(h.url.looksLikeRunUrl(padded), true, JSON.stringify(padded));
    assert.equal(plain(h.url.parseParts(padded)).host, HOST, JSON.stringify(padded));
    assert.deepEqual(plain(h.url.parse(padded)), { kind: 'run', id: '9f8e7d6c' }, JSON.stringify(padded));
  }
  // The bare `host/projects/…` shape pads the same way, and a folder link with it too.
  assert.deepEqual(plain(h.url.parse(`  ${HOST}/projects/${PROJECT}/runs/groups/12\n`)),
    { kind: 'group', id: '12' });
  // A space in the MIDDLE is still what the tester typed, and is never parsed at all.
  assert.equal(h.url.looksLikeRunUrl(`${BASE}/projects/${PROJECT}/runs/9f8 e7d6c`), false);
  assert.equal(h.url.parse(`${BASE}/projects/${PROJECT} /runs/9f8e7d6c`), null);
});

// ---------- what the link itself says (rows 22-24, 73) ----------

test('22: the folder shape is read first, so /runs/groups/12 is a folder and not a run called "groups"', () => {
  const h = load();
  assert.deepEqual(plain(h.url.parseParts(`${HOST}/projects/abc/runs/groups/12`)),
    { host: HOST, projectId: 'abc', kind: 'group', id: '12' });
  // Without the groups segment the SAME path is a run, so the order above is a decision.
  assert.deepEqual(plain(h.url.parseParts(`${HOST}/projects/abc/runs/12`)),
    { host: HOST, projectId: 'abc', kind: 'run', id: '12' });
});

test('23: the web app’s "Copy url" slugs the run segment, and the panel cuts it back to the id', () => {
  const h = load();
  assert.equal(h.url.parseParts('https://h/projects/abc/runs/9f8e7d6c-my-title').id, '9f8e7d6c');
  assert.equal(h.url.parseParts('https://h/projects/abc/runs/9f8e7d6c').id, '9f8e7d6c');
});

test('24: something that is not a URL, and a project link with no run in it, resolve to nothing', () => {
  const h = load();
  assert.equal(h.url.parseParts('not a url'), null);
  assert.equal(h.url.parseParts('https://h/projects/abc'), null);
  assert.equal(h.url.parseParts(''), null);
  assert.equal(h.url.parseParts(null), null);
});

test('73: a link copied from deep inside a run still opens the run, and the id survives the query', () => {
  const h = load();
  assert.equal(h.url.parseParts(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c/tests/42`).id, '9f8e7d6c');
  assert.equal(h.url.parseParts(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c?tab=all#top`).id, '9f8e7d6c');
  assert.equal(h.url.parseParts(`${BASE}/projects/${PROJECT}/runs/groups/12/whatever`).kind, 'group');
});

// 111b: the host a link is judged by is the URL's own hostname, not the text around it. Every shape
// below puts the configured host somewhere in the string while the AUTHORITY is somewhere else, and
// each of them is a way a foreign link gets opened if the host is ever read off the raw text.
test('111b: the host is read from the parsed authority, never from where the text happens to say it', () => {
  const h = load();
  const host = (v) => { const p = h.url.parseParts(v); return p && p.host; };
  // userinfo: everything before the @ is a credential, and the host is what follows it.
  assert.equal(host(`https://${HOST}@evil.example/projects/abc/runs/1`), 'evil.example');
  // the configured host as a path segment, a query value, a fragment, and a subdomain suffix.
  assert.equal(host(`https://evil.example/${HOST}/projects/abc/runs/1`), 'evil.example');
  assert.equal(host(`https://evil.example/projects/abc/runs/1?h=${HOST}`), 'evil.example');
  assert.equal(host(`https://evil.example/projects/abc/runs/1#${HOST}`), 'evil.example');
  assert.equal(host(`https://${HOST}.evil.example/projects/abc/runs/1`), `${HOST}.evil.example`);
  // A scheme-relative paste has no scheme, so the `https://` prefix goes on the FRONT of it and the
  // authority it names is preserved rather than swallowed.
  assert.equal(host(`//evil.example/projects/abc/runs/1`), 'evil.example');
  // A port is not part of the hostname, so the same host on another port reads as the same host —
  // pinned as it stands today, not as an aspiration.
  assert.equal(host(`https://${HOST}:8443/projects/abc/runs/1`), HOST);
  // A trailing dot and a capitalised host are the SAME authority to a URL, only one of which the
  // hostname getter folds — the other is a distinct host and stays one.
  assert.equal(host(`https://APP.TESTOMAT.IO/projects/abc/runs/1`), HOST);
  assert.equal(host(`https://${HOST}./projects/abc/runs/1`), `${HOST}.`);
});

// ---------- resolved against this panel's own host and project (rows 25-27) ----------

test('25: a run link on a FOREIGN host is never resolved against the project this panel is connected to', () => {
  const h = load();
  assert.equal(h.url.parse(`https://evil.example/projects/${PROJECT}/runs/9f8e7d6c`), null);
  // The identical path on the CONFIGURED host does resolve, so the null above is the host check.
  assert.deepEqual(plain(h.url.parse(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`)),
    { kind: 'run', id: '9f8e7d6c' });
});

test('26: the right host with the wrong project is not this panel’s run either', () => {
  const h = load();
  assert.equal(h.url.parse(`${BASE}/projects/someone-else/runs/9f8e7d6c`), null);
  assert.deepEqual(plain(h.url.parse(`${BASE}/projects/${PROJECT}/runs/groups/12`)),
    { kind: 'group', id: '12' });
});

test('27: a panel whose own base URL will not parse resolves nothing — never a bare-host match', () => {
  const h = load({ settings: { baseUrl: 'not a url', projectId: PROJECT } });
  assert.equal(h.url.parse(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`), null);
  // The same link with the base URL repaired resolves, so the branch above was really reached.
  h.state.settings = { baseUrl: BASE, projectId: PROJECT };
  assert.deepEqual(plain(h.url.parse(`${BASE}/projects/${PROJECT}/runs/9f8e7d6c`)),
    { kind: 'run', id: '9f8e7d6c' });
});

// 111c: the two comparisons the whole seam rests on are EQUALITY, both ways round. A prefix test in
// either place opens a foreign host or a stranger's project, and neither is reachable through rows
// 25-27, where the wrong values share no prefix with the right ones.
test('111c: a host or a project that merely STARTS WITH the configured one is not it', () => {
  const h = load();
  const link = (host, project) => `https://${host}/projects/${project}/runs/9f8e7d6c`;
  // The configured host as a prefix of, and as a suffix of, the link's host.
  assert.equal(h.url.parse(link(`${HOST}.evil.example`, PROJECT)), null);
  assert.equal(h.url.parse(link(`evil-${HOST}`, PROJECT)), null);
  assert.equal(h.url.parse(link('app.testomat', PROJECT)), null);          // a prefix of the real host
  // …and the same for the project id, in both directions.
  assert.equal(h.url.parse(link(HOST, `${PROJECT}-staging`)), null);
  assert.equal(h.url.parse(link(HOST, 'my')), null);
  assert.equal(h.url.parse(link(HOST, `x-${PROJECT}`)), null);
  // A base URL carrying a path or a port of its own contributes only its hostname, so the panel
  // still resolves its own links — the nulls above are the comparison and not a broken baseline.
  h.state.settings = { baseUrl: `${BASE}/some/prefix`, projectId: PROJECT };
  assert.deepEqual(plain(h.url.parse(link(HOST, PROJECT))), { kind: 'run', id: '9f8e7d6c' });
  // The PORT half of that sentence, asserted rather than assumed: a self-hosted instance on a
  // non-default port compares by hostname, and a link never carries one — reading the port in
  // would leave every such install unable to open its own runs, with this suite green.
  h.state.settings = { baseUrl: `https://${HOST}:8443`, projectId: PROJECT };
  assert.deepEqual(plain(h.url.parse(link(HOST, PROJECT))), { kind: 'run', id: '9f8e7d6c' });
  // An empty or absent baseUrl parses as nothing at all, so nothing resolves.
  h.state.settings = { baseUrl: '', projectId: PROJECT };
  assert.equal(h.url.parse(link(HOST, PROJECT)), null);
  h.state.settings = { projectId: PROJECT };
  assert.equal(h.url.parse(link(HOST, PROJECT)), null);
});

// ---------- a bare id (rows 28, 84) ----------

test('28: a bare run id is 6 to 12 hex characters, case-blind — anything else is a title search', () => {
  const h = load();
  assert.equal(h.url.looksLikeRunId('9F8E7D6C'), true);
  assert.equal(h.url.looksLikeRunId('abcde'), false);          // five is too short
  assert.equal(h.url.looksLikeRunId('zzzzzz'), false);         // six, but not hex
  assert.equal(h.url.looksLikeRunId('1234567890123'), false);  // thirteen is too long
  assert.equal(h.url.looksLikeRunId('  9f8e7d  '), true);      // a trimmed paste still reads
});

// 111d: the id test is what decides a query is worth a /runs/{id} read, so its edges are the edges of
// a request. Row 28 pins the two lengths and one non-hex word; the anchors, the inner space and the
// empty input are what stop a title that CONTAINS an id from being probed as one.
test('111d: the id is the WHOLE query — an id inside a sentence, or beside one, is a title', () => {
  const h = load();
  for (const v of ['run 9f8e7d', '9f8e7d run', '9f8e7d/9f8e7d', '9f8e 7d6c', 'deadbeefX',
    '0x9f8e7d', '9f8e7d;drop', '', ' ', null, undefined, 0, false]) {
    assert.equal(h.url.looksLikeRunId(v), false, JSON.stringify(v));
  }
  // Whitespace AROUND it is trimmed, whatever kind — a line copied out of a CI log brings its own.
  assert.equal(h.url.looksLikeRunId('9f8e7d\n'), true);
  assert.equal(h.url.looksLikeRunId('\t9f8e7d '), true);
  // The two boundary lengths are in, and one either side is out.
  assert.equal(h.url.looksLikeRunId('abcdef'), true);
  assert.equal(h.url.looksLikeRunId('abcdef123456'), true);
  assert.equal(h.url.looksLikeRunId('abcde'), false);
  assert.equal(h.url.looksLikeRunId('abcdef1234567'), false);
  // A number the caller never stringified is read as its digits, which are hex.
  assert.equal(h.url.looksLikeRunId(123456), true);
});

test('84: only an id-shaped query is probed, and it is probed trimmed', () => {
  const h = load();
  h.state.runsSearch = '  9f8e7d  ';
  assert.equal(h.url.searchRunId(), '9f8e7d');
  h.state.runsSearch = 'nightly';
  assert.equal(h.url.searchRunId(), null);
  h.state.runsSearch = '';
  assert.equal(h.url.searchRunId(), null);
  // The query itself is left as the tester typed it — the trim is on the way OUT only.
  h.state.runsSearch = '  9f8e7d  ';
  h.url.searchRunId();
  assert.equal(h.state.runsSearch, '  9f8e7d  ');
});

// ---------- the one message every refusal gets (row 33, the reporter half) ----------

test('33: the refusal goes to the list’s own line while the list is up, and to a toast otherwise', () => {
  const h = load();
  h.url.reportNotFound();
  assert.deepEqual(h.lines, [{ id: 'runs-status', text: 'Run not found', cls: 'error' }]);
  assert.deepEqual(h.toasts, []);   // a toast is wiped by the next one; the line is not

  // The same miss while the tester is NOT on the runs list can only be a toast — a line on a
  // hidden view would be invisible — and it is marked as an error.
  for (const view of ['run', 'test', 'settings']) {
    h.lines.length = 0;
    h.toasts.length = 0;
    h.state.view = view;
    h.url.reportNotFound();
    assert.deepEqual(h.lines, [], view);
    assert.deepEqual(h.toasts, [{ msg: 'Run not found', opts: { error: true } }], view);
  }
});

// 111e: the message is deliberately blunt (#106) and offers no project switch, and it is the DEFAULT
// rather than the only thing the reporter can say — a caller with a better reason may pass one, and
// row 33 above would not notice if the default were rewritten to it.
test('111e: the message is exactly "Run not found", and a caller may say something else instead', () => {
  const h = load();
  assert.equal(h.url.NOT_FOUND, 'Run not found');
  h.url.reportNotFound('No access to that run');
  assert.deepEqual(h.lines, [{ id: 'runs-status', text: 'No access to that run', cls: 'error' }]);
  h.state.view = 'run';
  h.url.reportNotFound('No access to that run');
  assert.deepEqual(h.toasts, [{ msg: 'No access to that run', opts: { error: true } }]);
});

// ---------- the module's own seam (row 111f) ----------

// 111f: this module publishes ONE global and it has to be evaluated before the screen that calls it.
// A bare name left behind in runs-list.js would resolve against nothing and throw only under a
// tester's finger; a script tag below its caller would do the same at boot. shared/handoff.js is the
// one caller that CANNOT be preceded — index.html loads it far earlier, for the viewer and the
// editor, which do not load this module at all — so its call stays late-bound on purpose.
test('111f: the module stands alone, ahead of the screen, and behind the one caller it cannot precede', () => {
  const module = raw(SCREENS_SRC, 'runs-url.js');
  const caller = raw(SCREENS_SRC, 'runs-list.js');
  const NAMES = ['NOT_FOUND', 'reportNotFound', 'looksLikeRunUrl', 'parseParts', 'parse',
    'looksLikeRunId', 'searchRunId'];
  const OLD = ['RUN_NOT_FOUND', 'reportRunNotFound', 'looksLikeRunUrl', 'parseRunUrlParts',
    'parseRunsUrl', 'looksLikeRunId', 'runsSearchRunId'];

  // Every name on the surface, and no top-level function declaration: a `function` in a classic
  // script lands on globalThis, and a bare name left behind would still resolve.
  for (const n of NAMES) assert.match(module, new RegExp(`\\n  ${n}[:(]`), n);
  assert.equal(/^(async )?function /m.test(module), false);
  // The parsers are the pure half: only the reporter names the two panel writers, and neither the
  // DOM nor the API is reachable from here at all.
  assert.match(module, /\/\* global state, setStatusLine, toast \*\//);
  for (const n of ['document', 'TestomatAPI', '$(', 'renderList', 'chrome']) {
    assert.equal(module.includes(n), false, n);
  }
  // …and the two panel writers are CALLED from exactly one place each, the reporter.
  for (const n of ['setStatusLine', 'toast']) {
    assert.equal(module.split(new RegExp(`${n}\\(`)).length - 1, 1, n);
  }

  // The caller says RunsUrl.<name> at every call site and answers to no bare old name any more.
  // NOT_FOUND is the exception: nothing names it, because the reporter's default is how it is read.
  assert.match(caller, /\/\* global [^*]*\bRunsUrl\b/);
  for (const n of NAMES.filter((x) => x !== 'NOT_FOUND')) {
    assert.match(caller, new RegExp(`RunsUrl\\.${n}\\b`), n);
  }
  for (const n of OLD) assert.equal(new RegExp(`(?<!\\.)\\b${n}\\b`).test(caller), false, n);

  // The out-of-panel caller (#195): handoff.js is read where it ships, and it too says the module's
  // name — under-supplied in the viewer and the editor exactly as it was before the move.
  const handoff = raw(join(repoRoot, 'extension/shared'), 'handoff.js');
  assert.match(handoff, /\/\* global [^*]*\bRunsUrl\b/);
  assert.match(handoff, /RunsUrl\.parseParts\(/);
  assert.equal(/(?<!\.)\bparseRunUrlParts\b/.test(handoff), false);
  for (const page of ['viewer/viewer.html', 'editor/editor.html']) {
    assert.equal(readFileSync(join(repoRoot, 'extension', page), 'utf8').includes('runs-url.js'), false, page);
  }

  // …and index.html evaluates the module before runs-list.js. Read where it ships: it is in neither
  // switchable directory. handoff.js stands EARLIER, which is why its call is made at runtime.
  const html = raw(join(repoRoot, 'extension/sidepanel'), 'index.html');
  const at = (src) => html.indexOf(`<script src="${src}">`);
  assert.ok(at('screens/runs-url.js') > 0, 'index.html loads screens/runs-url.js');
  assert.ok(at('screens/runs-url.js') < at('screens/runs-list.js'), 'runs-url.js is evaluated first');
  assert.ok(at('../shared/handoff.js') < at('screens/runs-url.js'), 'handoff.js stands earlier');
});
