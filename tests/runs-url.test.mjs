#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, SCREENS_SRC, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// SCREENS_SRC is switchable; index.html and shared/handoff.js are read where they ship.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

const BASE = 'https://app.testomat.io';
const HOST = 'app.testomat.io';
const PROJECT = 'my-project';

// A vm realm has no `URL`; the harness installs it, or every parser row passes for the wrong reason.
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

// A run path admits any scheme; a hostile one is then refused by the host that parsing yields.
test('111a: a scheme that is not http(s) never resolves — refused at the gate, or by its own host', () => {
  const h = load();
  // No run path: not a link at all, so the field treats it as a title and nothing is fetched.
  for (const v of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
    'chrome-extension://abc/index.html', 'vbscript:msgbox(1)']) {
    assert.equal(h.url.looksLikeRunUrl(v), false, v);
    assert.equal(h.url.parse(v), null, v);
  }
  // With a run path the shape test admits them; the authority parsed out is not this host.
  for (const [v, host] of [
    ['javascript:/projects/abc/runs/1', 'javascript'],
    ['data:/projects/abc/runs/1', 'data'],
    ['ftp://h/projects/abc/runs/1', 'ftp'],
  ]) {
    assert.equal(h.url.looksLikeRunUrl(v), true, v);
    assert.equal(plain(h.url.parseParts(v)).host, host, v);
    assert.equal(h.url.parse(v), null, v);
  }
  // With the configured host after the scheme, `alert(1)` sits where the port belongs, so it throws.
  const smuggled = `javascript:alert(1)//${HOST}/projects/${PROJECT}/runs/9f8e7d6c`;
  assert.equal(h.url.looksLikeRunUrl(smuggled), true);
  assert.equal(h.url.parseParts(smuggled), null);
  assert.equal(h.url.parse(smuggled), null);
  // http and https, in any case, do pass the gate — so the falses above are the scheme, not the shape.
  for (const v of ['HTTPS://app.testomat.io/x', 'http://app.testomat.io/x']) {
    assert.equal(h.url.looksLikeRunUrl(v), true, v);
  }
});

// A link copied from a CI log or chat arrives padded; untrimmed, it would silently be a title search.
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
  // A space in the middle is still what the tester typed, and is never parsed at all.
  assert.equal(h.url.looksLikeRunUrl(`${BASE}/projects/${PROJECT}/runs/9f8 e7d6c`), false);
  assert.equal(h.url.parse(`${BASE}/projects/${PROJECT} /runs/9f8e7d6c`), null);
});

test('22: the folder shape is read first, so /runs/groups/12 is a folder and not a run called "groups"', () => {
  const h = load();
  assert.deepEqual(plain(h.url.parseParts(`${HOST}/projects/abc/runs/groups/12`)),
    { host: HOST, projectId: 'abc', kind: 'group', id: '12' });
  // Without the groups segment the same path is a run, so the order above is a decision.
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

// Each shape puts the configured host in the text while the authority is elsewhere.
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
  // A scheme-relative paste gets `https:` in front, so the authority it names is preserved.
  assert.equal(host(`//evil.example/projects/abc/runs/1`), 'evil.example');
  // A port is not part of the hostname, so another port reads as the same host, as it stands today.
  assert.equal(host(`https://${HOST}:8443/projects/abc/runs/1`), HOST);
  // Capitals and a trailing dot both name this host; the getter folds only the capitals.
  assert.equal(host(`https://APP.TESTOMAT.IO/projects/abc/runs/1`), HOST);
  assert.equal(host(`https://${HOST}./projects/abc/runs/1`), `${HOST}.`);
});

test('25: a run link on a FOREIGN host is never resolved against the project this panel is connected to', () => {
  const h = load();
  assert.equal(h.url.parse(`https://evil.example/projects/${PROJECT}/runs/9f8e7d6c`), null);
  // The identical path on the configured host does resolve, so the null above is the host check.
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

// Both comparisons are equality: a prefix test would open a foreign host or a stranger's project.
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
  // A base URL with a path or port contributes only its hostname, so the panel resolves its own links.
  h.state.settings = { baseUrl: `${BASE}/some/prefix`, projectId: PROJECT };
  assert.deepEqual(plain(h.url.parse(link(HOST, PROJECT))), { kind: 'run', id: '9f8e7d6c' });
  // A link never carries the port, so reading it in would break every self-hosted install on one.
  h.state.settings = { baseUrl: `https://${HOST}:8443`, projectId: PROJECT };
  assert.deepEqual(plain(h.url.parse(link(HOST, PROJECT))), { kind: 'run', id: '9f8e7d6c' });
  // An empty or absent baseUrl parses as nothing at all, so nothing resolves.
  h.state.settings = { baseUrl: '', projectId: PROJECT };
  assert.equal(h.url.parse(link(HOST, PROJECT)), null);
  h.state.settings = { projectId: PROJECT };
  assert.equal(h.url.parse(link(HOST, PROJECT)), null);
});

test('28: a bare run id is 6 to 12 hex characters, case-blind — anything else is a title search', () => {
  const h = load();
  assert.equal(h.url.looksLikeRunId('9F8E7D6C'), true);
  assert.equal(h.url.looksLikeRunId('abcde'), false);          // five is too short
  assert.equal(h.url.looksLikeRunId('zzzzzz'), false);         // six, but not hex
  assert.equal(h.url.looksLikeRunId('1234567890123'), false);  // thirteen is too long
  assert.equal(h.url.looksLikeRunId('  9f8e7d  '), true);      // a trimmed paste still reads
});

// The id test decides whether a query earns a /runs/{id} read, so its edges are a request's edges.
test('111d: the id is the WHOLE query — an id inside a sentence, or beside one, is a title', () => {
  const h = load();
  for (const v of ['run 9f8e7d', '9f8e7d run', '9f8e7d/9f8e7d', '9f8e 7d6c', 'deadbeefX',
    '0x9f8e7d', '9f8e7d;drop', '', ' ', null, undefined, 0, false]) {
    assert.equal(h.url.looksLikeRunId(v), false, JSON.stringify(v));
  }
  // Whitespace around it is trimmed, whatever kind: a line copied out of a CI log brings its own.
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
  // The query itself is left as the tester typed it; the trim is on the way out only.
  h.state.runsSearch = '  9f8e7d  ';
  h.url.searchRunId();
  assert.equal(h.state.runsSearch, '  9f8e7d  ');
});

test('33: the refusal goes to the list’s own line while the list is up, and to a toast otherwise', () => {
  const h = load();
  h.url.reportNotFound();
  assert.deepEqual(h.lines, [{ id: 'runs-status', text: 'Run not found', cls: 'error' }]);
  assert.deepEqual(h.toasts, []);   // a toast is wiped by the next one; the line is not

  // Off the runs list it can only be a toast, since a line on a hidden view is invisible.
  for (const view of ['run', 'test', 'settings']) {
    h.lines.length = 0;
    h.toasts.length = 0;
    h.state.view = view;
    h.url.reportNotFound();
    assert.deepEqual(h.lines, [], view);
    assert.deepEqual(h.toasts, [{ msg: 'Run not found', opts: { error: true } }], view);
  }
});

// Deliberately blunt, with no project switch offered; a caller with a better reason may pass one.
test('111e: the message is exactly "Run not found", and a caller may say something else instead', () => {
  const h = load();
  assert.equal(h.url.NOT_FOUND, 'Run not found');
  h.url.reportNotFound('No access to that run');
  assert.deepEqual(h.lines, [{ id: 'runs-status', text: 'No access to that run', cls: 'error' }]);
  h.state.view = 'run';
  h.url.reportNotFound('No access to that run');
  assert.deepEqual(h.toasts, [{ msg: 'No access to that run', opts: { error: true } }]);
});

// handoff.js loads far earlier (viewer and editor too), so its call is late-bound on purpose.
test('111f: the module stands alone, ahead of the screen, and behind the one caller it cannot precede', () => {
  const module = raw(SCREENS_SRC, 'runs-url.js');
  const caller = raw(SCREENS_SRC, 'runs-list.js');
  const NAMES = ['NOT_FOUND', 'reportNotFound', 'looksLikeRunUrl', 'parseParts', 'parse',
    'looksLikeRunId', 'searchRunId'];
  const OLD = ['RUN_NOT_FOUND', 'reportRunNotFound', 'looksLikeRunUrl', 'parseRunUrlParts',
    'parseRunsUrl', 'looksLikeRunId', 'runsSearchRunId'];

  // A top-level `function` in a classic script lands on globalThis, so a bare name would still resolve.
  for (const n of NAMES) assert.match(module, new RegExp(`\\n  ${n}[:(]`), n);
  assert.equal(/^(async )?function /m.test(module), false);
  // The parsers are the pure half: only the reporter names the panel writers; no DOM, no API.
  assert.match(module, /\/\* global state, setStatusLine, toast \*\//);
  for (const n of ['document', 'TestomatAPI', '$(', 'renderList', 'chrome']) {
    assert.equal(module.includes(n), false, n);
  }
  // …and the two panel writers are called from exactly one place each, the reporter.
  for (const n of ['setStatusLine', 'toast']) {
    assert.equal(module.split(new RegExp(`${n}\\(`)).length - 1, 1, n);
  }

  // NOT_FOUND is named nowhere: the reporter's default is how it is read.
  assert.match(caller, /\/\* global [^*]*\bRunsUrl\b/);
  for (const n of NAMES.filter((x) => x !== 'NOT_FOUND')) {
    assert.match(caller, new RegExp(`RunsUrl\\.${n}\\b`), n);
  }
  for (const n of OLD) assert.equal(new RegExp(`(?<!\\.)\\b${n}\\b`).test(caller), false, n);

  // handoff.js is read where it ships, and it too names the module.
  const handoff = raw(join(repoRoot, 'extension/shared'), 'handoff.js');
  assert.match(handoff, /\/\* global [^*]*\bRunsUrl\b/);
  assert.match(handoff, /RunsUrl\.parseParts\(/);
  assert.equal(/(?<!\.)\bparseRunUrlParts\b/.test(handoff), false);
  for (const page of ['viewer/viewer.html', 'editor/editor.html']) {
    assert.equal(readFileSync(join(repoRoot, 'extension', page), 'utf8').includes('runs-url.js'), false, page);
  }

  // index.html loads it before runs-list.js; handoff.js loads earlier, so it calls at runtime.
  const html = raw(join(repoRoot, 'extension/sidepanel'), 'index.html');
  const at = (src) => html.indexOf(`<script src="${src}">`);
  assert.ok(at('screens/runs-url.js') > 0, 'index.html loads screens/runs-url.js');
  assert.ok(at('screens/runs-url.js') < at('screens/runs-list.js'), 'runs-url.js is evaluated first');
  assert.ok(at('../shared/handoff.js') < at('screens/runs-url.js'), 'handoff.js stands earlier');
});
