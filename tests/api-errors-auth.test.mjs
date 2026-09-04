#!/usr/bin/env node
// extension/api.js: which sentence a refusal turns into, the read-only verdict, the credentials and
// the one boundary that decides a host named in server data gets no request. Rows 14-59, 82-83,
// 88-90 and 97-109 of #145. Run: node --test tests/api-errors-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  load, ok, fail, netFail, rejection, plain, TOKEN, JWT, BASE, jwtWith,
} from './helpers/api-harness.mjs';

const V2KEY = 'V2KEY';                       // a minted project key — a literal, never a real one
const keyDoc = (attrs) => ok({ data: { attributes: attrs } });
const loginOk = ok({ jwt: JWT });

// ---- error mapping — toError / ApiError (E-P2-1 still OPEN) ----

test('14: 401 is the one sentence about the token, whatever the body said', async () => {
  const h = load().configure();
  h.reply({ status: 401, json: { errors: ['nope'] } });
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 401);
  assert.equal(e.message, 'Token invalid or has no access');
});

test('15: a 403 reaching toError from the JSON:API is auth, not read-only', async () => {
  const h = load().configure();
  h.reply(loginOk, fail(403), loginOk, fail(403));
  const e = await rejection(h.mod.jwtRequest('/anything'));
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 403);
  assert.equal(e.message, 'Token invalid or has no access');
});

test('16: 404 says it may be the project, not the row', async () => {
  const h = load().configure();
  h.reply(fail(404));
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'notfound');
  assert.equal(e.message, 'Not found — or no access to this project');
});

test('17: a 500 body reaches the tester as a raw JSON dump', async () => {
  const h = load().configure();
  h.reply({ status: 500, json: { errors: [{ detail: 'boom' }] } });
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'http');
  // E-P2-1 OPEN: no formatter yet, so the tester reads the wire shape
  assert.equal(e.message, '{"errors":[{"detail":"boom"}]}');
});

test('18: a 500 the parser chokes on falls back to the status line', async () => {
  const h = load().configure();
  h.reply(fail(500));
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'http');
  assert.equal(e.message, 'HTTP 500');
});

test('19: a 429 honours Retry-After, twice, and then says what to do about it', async () => {
  const h = load().configure();
  h.reply(...Array.from({ length: 3 }, () => fail(429, { headers: { 'Retry-After': '5' } })));
  const e = await rejection(h.mod.validate());
  assert.equal(h.calls.length, 3);                 // the try, then TWO retries
  assert.deepEqual(h.waits(), [5000, 5000]);       // the header's seconds, both times
  assert.equal(e.kind, 'http');                    // NOT a new kind: the offline queue reads this
  assert.equal(e.status, 429);
  assert.equal(e.message, 'Too many requests — wait a minute, then try again');
});

test('19a: no Retry-After backs off 1s then 2s', async () => {
  const h = load().configure();
  h.reply(fail(429), fail(429), fail(429));
  await rejection(h.mod.validate());
  assert.deepEqual(h.waits(), [1000, 2000]);
});

test('19b: a Retry-After asking for an hour is clamped to 30s', async () => {
  const h = load().configure();
  h.reply(...Array.from({ length: 3 }, () => fail(429, { headers: { 'Retry-After': '3600' } })));
  await rejection(h.mod.validate());
  assert.deepEqual(h.waits(), [30000, 30000]);
});

test('19c: an HTTP-date Retry-After is read as a wait, and clamped the same way', async () => {
  const h = load().configure();
  const at = (secs) => new Date(Date.now() + secs * 1000).toUTCString();
  h.reply(fail(429, { headers: { 'Retry-After': at(4) } }), fail(429, { headers: { 'Retry-After': at(600) } }),
    fail(429, { headers: { 'Retry-After': at(-60) } }));
  await rejection(h.mod.validate());
  const [first, second] = h.waits();
  assert.ok(first > 2000 && first <= 4000, `${first}`); // ~4s, less whatever the row itself took
  assert.equal(second, 30000);                          // 10 minutes, clamped
});

test('19d: an unreadable Retry-After falls back to our own back-off', async () => {
  const h = load().configure();
  h.reply(...Array.from({ length: 3 }, () => fail(429, { headers: { 'Retry-After': 'soon' } })));
  await rejection(h.mod.validate());
  assert.deepEqual(h.waits(), [1000, 2000]);
});

test('19e: a 429 that clears on the retry never reaches the tester', async () => {
  const h = load().configure();
  h.reply(fail(429), ok({ data: [] }));
  assert.deepEqual(plain(await h.mod.validate()), { data: [] });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.waits(), [1000]);
  assert.equal(h.mod.rateLimitedAt(), 0); // the 2xx cleared the stamp: live sync goes back to 20s
});

test('19f: the rate-limit stamp is what live sync slows itself on', async () => {
  const h = load().configure();
  assert.equal(h.mod.rateLimitedAt(), 0);
  h.reply(fail(429), fail(429), fail(429));
  const before = Date.now();
  await rejection(h.mod.validate());
  assert.ok(h.mod.rateLimitedAt() >= before, `${h.mod.rateLimitedAt()}`);
});

test('19g: a 429 is NOT the network error the offline queue takes a click on', async () => {
  const h = load().configure();
  h.reply(fail(429), fail(429), fail(429));
  const e = await rejection(h.mod.validate());
  // OfflineQueue.qualifies() is `kind === 'network' || kind === 'auth'` — a rate limit is neither.
  assert.equal(e.kind === 'network' || e.kind === 'auth', false);
});

test('19h: a rate-limited write is retried too — a 429 means it never ran', async () => {
  const h = load().configure();
  h.reply(fail(429), fail(429), ok({ data: {} }));
  await h.inner.request('/tests', { method: 'POST', body: { a: 1 } });
  assert.deepEqual(h.methods(), ['POST', 'POST', 'POST']);
  assert.deepEqual(h.waits(), [1000, 2000]);
});

test('20: a dead link is a network error, in those words', async () => {
  const h = load().configure();
  h.reply(netFail());
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'network');
  assert.equal(e.status, 0);
  assert.equal(e.message, 'Network error');
});

test('21: the budget running out says so — 30s on the ordinary path, 300s on the long one', async () => {
  const h = load().configure();
  h.hooks.timeoutSignal = () => AbortSignal.abort(); // no test waits 30 real seconds
  h.reply(netFail());
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'network');
  assert.equal(e.message, 'No answer in 30s — the request timed out');

  const long = load().configure({ apiToken: JWT }); // adopted, so no login round trip first
  long.hooks.timeoutSignal = () => AbortSignal.abort();
  long.reply(netFail());
  const le = await rejection(long.mod.polishRecordedSteps('steps', 't1'));
  assert.equal(le.message, 'No answer in 300s — the request timed out');
});

test('22: a caller cancelling reads as a network error, not as a timeout', async () => {
  const h = load().configure();
  const ac = new AbortController();
  ac.abort();
  h.reply(netFail());
  const e = await rejection(h.inner.rawFetch(`${BASE}/api/v2/p1/runs`, { signal: ac.signal }));
  assert.equal(e.kind, 'network');
  assert.equal(e.message, 'Network error');
});

test('23: without AbortSignal.any the caller signal alone travels, and nothing throws', async () => {
  const h = load().configure();
  delete h.sandbox.AbortSignal.any;
  const ac = new AbortController();
  h.reply(ok({ data: [] }));
  const res = await h.inner.rawFetch(`${BASE}/api/v2/p1/runs`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.equal(h.calls[0].signal, ac.signal);
});

// ---- request() and the read-only verdict (E-P0-1 / E-P0-3, fixed in #123) ----

test('24: a plain GET carries the bearer, no content type, and clears the read-only flag', async () => {
  const h = load().configure();
  h.reply(ok({ data: [] }));
  await h.inner.request('/runs');
  assert.equal(h.urls()[0], `${BASE}/api/v2/p1/runs`);
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal('Content-Type' in h.calls[0].headers, false);
  assert.equal(h.mod.readonlyAccess(), false);
});

test('25: a body brings the content type with it', async () => {
  const h = load().configure();
  h.reply(ok({ data: {} }));
  await h.inner.request('/tests', { method: 'POST', body: { a: 1 } });
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(h.calls[0].body, '{"a":1}');
});

test('26: null and undefined query values are dropped, false is kept', async () => {
  const h = load().configure();
  h.reply(ok({ data: [] }));
  await h.inner.request('/runs', { query: { page: 1, per_page: null, x: undefined, 'filter[archived]': false } });
  const q = new URL(h.urls()[0]).searchParams;
  assert.equal(q.get('page'), '1');
  assert.equal(q.get('filter[archived]'), 'false');
  assert.equal(q.has('per_page'), false);
  assert.equal(q.has('x'), false);
  assert.ok(h.urls()[0].includes('filter%5Barchived%5D=false'), h.urls()[0]);
});

test('27: 204 resolves null', async () => {
  const h = load().configure();
  h.reply({ status: 204 });
  assert.equal(await h.inner.request('/runs'), null);
});

test('28: a 200 the parser chokes on also resolves null', async () => {
  const h = load().configure();
  h.reply({ status: 200 });
  assert.equal(await h.inner.request('/runs'), null);
});

test('29: 403 corroborated by a plain read is the read-only verdict', async () => {
  const h = load().configure();
  h.reply(fail(403), fail(403));
  const e = await rejection(h.inner.request('/runs'));
  assert.equal(e.kind, 'readonly');
  assert.equal(
    e.message,
    'Your access to this project is read-only — app.testomat.io answered 403 to a plain read too',
  );
  assert.equal(h.mod.readonlyAccess(), true);
  assert.equal(h.calls.length, 2);
});

test('30: a 403 the plain read contradicts refuses the ROUTE, and leaves the panel unlocked', async () => {
  const h = load().configure();
  h.reply(fail(403), ok({ data: [] }));
  const e = await rejection(h.inner.request('/tests/t1'));
  assert.equal(e.kind, 'auth');
  assert.equal(
    e.message,
    'app.testomat.io refused this request (403) — the project itself still reads fine',
  );
  assert.equal(h.mod.readonlyAccess(), false);
});

test('31: three routes refused at once share ONE corroboration read', async () => {
  const h = load().configure();
  h.route('per_page=1', fail(403));
  h.route('/api/v2/', fail(403));
  const errs = await Promise.all(['/a', '/b', '/c'].map((p) => rejection(h.inner.request(p))));
  errs.forEach((e) => assert.equal(e.kind, 'readonly'));
  assert.equal(h.matching('per_page=1').length, 1);
  assert.equal(h.calls.length, 4);
});

test('32: opting out of the corroboration probes nothing and decides nothing', async () => {
  const h = load().configure();
  h.reply(fail(403));
  const e = await rejection(h.inner.request('/attachments/a1', { corroborate403: false }));
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 403);
  assert.equal(h.calls.length, 1);
  assert.equal(h.mod.readonlyAccess(), 'unknown');
});

test('33: deleteAttachment falls through a v2 403 to the JSON:API and does NOT lock the panel', async () => {
  const h = load().configure();
  h.reply(fail(403), loginOk, { status: 204 });
  assert.equal(await h.mod.deleteAttachment('t1', 'a1'), null);
  assert.notEqual(h.mod.readonlyAccess(), true);
  assert.equal(h.urls()[0], `${BASE}/api/v2/p1/attachments/a1?testrun_id=t1`);
  assert.equal(h.urls()[2], `${BASE}/api/p1/attachments/a1`);
  assert.equal(h.methods()[2], 'DELETE');
});

test('34: both legs missing surfaces the SECOND error — a delete no route took is not done', async () => {
  const h = load().configure();
  h.reply(fail(404), loginOk, fail(404), loginOk, fail(404));
  const e = await rejection(h.mod.deleteAttachment('t1', 'a1'));
  assert.equal(e.kind, 'notfound');
  // The first 404 was swallowed: the JSON:API leg is what actually ran and failed last.
  assert.equal(h.urls().at(-1), `${BASE}/api/p1/attachments/a1`);
});

test('35: once read-only is proven, opting out of the probe does not opt out of the verdict', async () => {
  const h = load().configure();
  h.reply(fail(403), fail(403));
  await rejection(h.inner.request('/runs'));
  assert.equal(h.mod.readonlyAccess(), true);
  h.clear().reply(fail(403));
  const e = await rejection(h.inner.request('/attachments/a1', { corroborate403: false }));
  assert.equal(e.kind, 'readonly');
  assert.equal(h.calls.length, 1);
});

test('36: a minted key that answers 401 stays cached, and nothing retries', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/api/projects/p1', keyDoc({ 'api-key': V2KEY }));
  h.route('/api/v2/', fail(401));
  assert.equal((await rejection(h.mod.validate())).kind, 'auth');
  assert.equal((await rejection(h.mod.validate())).kind, 'auth');
  // E-P1-4 OPEN: no rotation, so the second call re-uses the key the server just rejected
  assert.equal(h.matching('/api/projects/p1').length, 1);
  assert.equal(h.matching('/api/v2/').length, 2);
  h.matching('/api/v2/').forEach((c) => assert.equal(c.headers.Authorization, `Bearer ${V2KEY}`));
});

test('37: a base URL with no scheme throws a RAW TypeError, with no kind on it', async () => {
  const h = load().configure({ baseUrl: 'app.testomat.io' });
  const e = await rejection(h.inner.request('/runs'));
  assert.equal(e.name, 'TypeError'); // E-P2-2 OPEN: it reaches the panel unmapped
  assert.equal(e.kind, undefined);
  assert.equal(h.calls.length, 0);
});

test('38: the project slug rides into the v2 path unencoded, while the other two routes encode', async () => {
  const h = load().configure({ projectId: 'a b/c' });
  h.reply(ok({ data: [] }), loginOk, ok({ data: {} }), ok({ data: {} }));
  await h.inner.request('/runs');
  // E-P2-3 OPEN: the slash survives as a path separator here…
  assert.equal(new URL(h.urls()[0]).pathname, '/api/v2/a%20b/c/runs');
  await h.mod.getProjectInfo();
  assert.equal(new URL(h.urls().at(-1)).pathname, '/api/projects/a%20b%2Fc'); // …and not here
  await h.mod.getRun('x/y');
  assert.equal(new URL(h.urls().at(-1)).pathname, '/api/v2/a%20b/c/runs/x%2Fy');
});

// ---- credentials, guards and token minting ----

test('39: nothing configured is its own error kind, before any request', async () => {
  const h = load();
  h.mod.configure(null);
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'unconfigured');
  assert.equal(e.status, 0);
  assert.equal(e.message, 'Not configured');
  assert.equal(h.calls.length, 0);
});

test('40: trailing slashes are stripped off the instance URL', async () => {
  const h = load().configure({ baseUrl: 'https://x.io///' });
  h.reply(ok({ data: [] }));
  await h.mod.validate();
  assert.ok(h.urls()[0].startsWith('https://x.io/api/'), h.urls()[0]);
});

test('41: switching project and back keeps the minted keys — a tab change must not re-mint', async () => {
  const h = load();
  h.route('/api/projects/', keyDoc({ 'api-key': V2KEY }));
  h.route('/api/v2/', ok({ data: [] }));
  for (const projectId of ['p1', 'p2', 'p1']) {
    h.configure({ apiToken: JWT, projectId });
    await h.mod.validate();
  }
  assert.equal(h.matching('/api/projects/p1').length, 1);
  assert.equal(h.matching('/api/projects/p2').length, 1);
});

test('42: a different credential drops the minted keys, the signed hosts and the verdict', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/api/projects/p1', keyDoc({ 'api-key': V2KEY }));
  h.route('/artifacts/presign', ok({ url: 'https://bucket.s3/x?sig=abc' }));
  h.route('/api/v2/', fail(403));
  const signed = await h.mod.presignArtifact('https://bucket.s3/x');
  await rejection(h.mod.validate()); // 403 + 403 corroboration = the lockout
  assert.equal(h.mod.readonlyAccess(), true);

  h.configure({ apiToken: jwtWith({ user_id: 9 }) });
  assert.equal(h.mod.readonlyAccess(), 'unknown');
  assert.equal((await rejection(h.mod.fetchAsset(signed))).message, 'Off-instance asset refused');
  h.clear();
  await rejection(h.mod.validate());
  assert.equal(h.matching('/api/projects/p1').length, 1); // re-read, so the map was cleared
});

test('43: a fresh handoff session resets the session but NOT the read-only lockout', async () => {
  const h = load().configure();
  h.reply(fail(403), fail(403));
  await rejection(h.mod.validate());
  assert.equal(h.mod.readonlyAccess(), true);
  h.mod.useHandoffSession(JWT);
  assert.equal(h.mod.readonlyAccess(), true); // E-P2-5 OPEN: only configure() clears it
  assert.equal(h.mod.jwtAvailable(), 'unknown');
  assert.equal(h.mod.jwtUserId(), null);
});

test('44: an eyJ token is a session, so it is adopted and mints a key instead of being one', async () => {
  const h = load().configure({ apiToken: JWT });
  assert.equal(h.inner.v2TokenInHand(), null);
  h.reply(keyDoc({ 'api-key': V2KEY }), ok({ data: [] }));
  await h.mod.validate();
  assert.equal(h.urls()[0], `${BASE}/api/projects/p1`);
  assert.equal(h.matching('/api/login').length, 0);
  assert.equal(h.mod.jwtUserId(), '7');
});

test('45: the project own key is used as the bearer and cached for the next call', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(keyDoc({ 'api-key': V2KEY }), ok({ data: [] }), ok({ data: [] }));
  await h.mod.validate();
  await h.mod.validate();
  assert.equal(h.matching('/api/projects/p1').length, 1);
  assert.equal(h.matching('/api/v2/')[1].headers.Authorization, `Bearer ${V2KEY}`);
});

test('46: a role with no API key gets the sentence naming the way out', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(keyDoc({ title: 'Shop' }));
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 403);
  assert.equal(
    e.message,
    'This project has no API key for your role — ask an owner, or pick another project',
  );
});

test('47: the snake_case spelling of the key is taken too', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(keyDoc({ api_key: V2KEY }), ok({ data: [] }));
  await h.mod.validate();
  assert.equal(h.matching('/api/v2/')[0].headers.Authorization, `Bearer ${V2KEY}`);
});

test('48: a project token issued for ANOTHER project passes the configured guard, then fails the session one', async () => {
  const h = load().configure({ apiToken: undefined, projectToken: 'PT', projectTokenFor: 'p2' });
  assert.equal(h.inner.hasCredential(), true);
  const e = await rejection(h.mod.validate());
  assert.equal(e.kind, 'unconfigured');
  assert.equal(h.calls.length, 0);
});

// ---- session lifecycle — login / jwtSend (E-P1-6 still OPEN) ----

test('49: a General token is exchanged for a session at /api/login', async () => {
  const h = load().configure();
  h.reply(loginOk);
  await h.inner.login();
  assert.equal(h.urls()[0], `${BASE}/api/login`);
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(plain(h.body(0)), { api_token: TOKEN });
  assert.equal(h.mod.jwtAvailable(), true);
});

test('50: a login answering 200 with no jwt degrades the client', async () => {
  const h = load().configure();
  h.reply(ok({}));
  const e = await rejection(h.inner.login());
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 0);
  assert.equal(e.message, 'Login returned no JWT');
  assert.equal(h.mod.jwtAvailable(), false);
});

test('51: a refused login degrades the client', async () => {
  const h = load().configure();
  h.reply(fail(401));
  assert.equal((await rejection(h.inner.login())).kind, 'auth');
  assert.equal(h.mod.jwtAvailable(), false);
});

test('52: a login that never reaches the server degrades the client too', async () => {
  const h = load().configure();
  h.reply(netFail());
  assert.equal((await rejection(h.inner.login())).kind, 'network');
  assert.equal(h.mod.jwtAvailable(), false);
});

test('53: one optional route refusing a handed session degrades the WHOLE client', async () => {
  const h = load().configure({ apiToken: undefined });
  h.mod.useHandoffSession(JWT);
  h.reply(fail(403));
  const e = await rejection(h.mod.polishRecordedSteps('steps', 't1'));
  assert.equal(e.message, 'The session handed to this panel has expired — reconnect from the app that opened it');
  assert.equal(h.mod.jwtAvailable(), false); // E-P1-6 OPEN: a 403 on /prompts locks every other route out
  assert.equal(h.calls.length, 1); // the retry never leaves: the second login() throws first
});

test('54: the tester own expired session gets the sentence naming Settings', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(fail(403));
  const e = await rejection(h.mod.jwtRequest('/anything'));
  assert.equal(e.message, 'Your session has expired — authorize again in Settings');
  assert.equal(h.mod.jwtAvailable(), false);
});

test('55: a 401 on the JSON:API is retried once on a fresh session', async () => {
  const h = load().configure();
  h.reply(loginOk, ok({ data: [] }));
  await h.mod.jwtRequest('/warm');
  h.clear().reply(fail(401), loginOk, ok({ data: { id: '1' } }));
  const doc = await h.mod.jwtRequest('/suites/tree');
  assert.deepEqual(plain(doc), { data: { id: '1' } });
  assert.equal(h.matching('/api/login').length, 1);
  assert.equal(h.matching('/api/p1/suites/tree').length, 2);
});

test('56: the user_id claim survives a base64url payload carrying - and _', async () => {
  const token = jwtWith({ user_id: 42, z: '\u00ff\u00a0~' }); // the two bytes that make base64 + and /
  const payload = token.split('.')[1];
  assert.ok(payload.includes('-') && payload.includes('_'), payload);
  const h = load().configure({ apiToken: token });
  await h.inner.login();
  assert.equal(h.mod.jwtUserId(), '42');
});

test('57: an unreadable token is no identity at all, and no throw', () => {
  const h = load();
  assert.equal(h.inner.decodeJwtUserId('nodots'), null);
  assert.equal(h.inner.decodeJwtUserId('a.notjson.c'), null);
  assert.equal(h.inner.decodeJwtUserId(jwtWith({ sub: 'x' })), null);
});

test('58: the JSON:API project routes carry no /v2/', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok([]));
  await h.mod.jwtRequest('/suites/tree');
  assert.equal(h.urls()[0], `${BASE}/api/p1/suites/tree`);
});

test('59: the api-root routes carry no project slug', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ data: {} }));
  await h.mod.jwtRequestRoot('/projects/x');
  assert.equal(h.urls()[0], `${BASE}/api/projects/x`);
});

// ---- pure shapes that only a route can reach (rows 82-83, 88-90) ----

test('82: /suites/tree answering a data envelope is no tree at all', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ data: [{ id: 1, title: 'Root' }] }));
  assert.deepEqual(plain(await h.mod.getSuiteTree()), []);
});

test('83: positions failing leaves the tree in the server own order', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/suites/tree', ok([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]));
  h.route('/suites?page=1', fail(500));
  const tree = await h.mod.getSuiteTreeOrdered();
  assert.deepEqual(plain(tree).map((n) => n.id), ['a', 'b']);
  assert.equal(h.matching('/suites?page=1').length, 1);
});

test('88: bulk-created titles travel as JSON-quoted YAML scalars, appended', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ data: [] }));
  await h.mod.bulkCreateTests('s1', ['Login: admin', 'a "quoted" #tag']);
  assert.deepEqual(plain(h.body(0)), {
    append: true,
    suite: 's1',
    yaml: '- "Login: admin"\n- "a \\"quoted\\" #tag"\n',
  });
});

test('89: the templates route falling back to every kind is filtered back down', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({
    data: [
      { id: 1, attributes: { title: 'T', kind: 'test', body: 'b', 'is-default': true } },
      { id: 2, attributes: { title: 'S', kind: 'step' } },
    ],
  }));
  const out = plain(await h.mod.listTemplates('test'));
  assert.deepEqual(out, [{ id: '1', title: 'T', kind: 'test', body: 'b', isDefault: true }]);
  assert.equal(new URL(h.urls()[0]).searchParams.get('kind'), 'test');
});

test('90: the dasherized avatar key is read as the avatar', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ data: [{ id: 5, attributes: { 'avatar-url': 'x' } }] }));
  const [user] = plain(await h.mod.listProjectUsers());
  assert.deepEqual(user, { id: '5', name: '', email: '', avatar: 'x', timezone: null });
});

// ---- asset egress boundary and upload (A-P1-2 fixed in #121) ----

test('97: a root-relative asset resolves against the INSTANCE, never the document', () => {
  const h = load().configure();
  assert.equal(h.mod.assetUrl('/rails/active_storage/x.png'), `${BASE}/rails/active_storage/x.png`);
});

test('98: an empty asset path resolves to the instance root — callers must pre-check', () => {
  const h = load().configure();
  assert.equal(h.mod.assetUrl(''), `${BASE}/`);
});

test('99: with nothing configured there is no asset URL at all', () => {
  const h = load();
  h.mod.configure(null);
  assert.equal(h.mod.assetUrl('x'), '');
});

test('100: an off-instance asset gets NO request', async () => {
  const h = load().configure();
  const e = await rejection(h.mod.fetchAsset('https://evil.example/px.png'));
  assert.equal(e.kind, 'http');
  assert.equal(e.status, 0);
  assert.equal(e.message, 'Off-instance asset refused');
  assert.equal(h.calls.length, 0);
});

test('101: a host that merely STARTS with the instance name is off-instance', async () => {
  const h = load().configure();
  const e = await rejection(h.mod.fetchAsset('https://app.testomat.io.evil.com/x'));
  assert.equal(e.message, 'Off-instance asset refused');
  assert.equal(h.calls.length, 0);
});

test('102: a bucket URL the instance signed is allowed, and carries no session header', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/artifacts/presign', ok({ url: 'https://bucket.s3/x?sig=abc' }));
  h.route('bucket.s3', ok({}));
  const signed = await h.mod.presignArtifact('https://bucket.s3/x');
  const res = await h.mod.fetchAsset(signed);
  assert.equal(res.status, 200);
  assert.equal(h.matching('bucket.s3').length, 1);
  assert.equal(h.matching('bucket.s3')[0].headers, undefined);
});

test('103: an instance asset carries the session and no cookies', async () => {
  const h = load().configure({ apiToken: JWT });
  await h.inner.login();
  h.reply(ok({}));
  await h.mod.fetchAsset('/attachments/x.png');
  assert.equal(h.calls[0].url, `${BASE}/attachments/x.png`);
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${JWT}`);
  assert.equal(h.calls[0].credentials, 'omit');
  assert.equal(h.calls[0].timeout, 300000);
});

test('104: with no session yet, one login is tried and its failure swallowed — the GET still goes out', async () => {
  const h = load().configure();
  h.reply(fail(500), ok({}));
  const res = await h.mod.fetchAsset('/attachments/x.png');
  assert.equal(res.status, 200);
  assert.deepEqual(h.urls(), [`${BASE}/api/login`, `${BASE}/attachments/x.png`]);
  assert.equal(h.calls[1].headers, undefined);
});

test('105: a 401 on an asset is retried once and then handed back AS IS — fetchAsset never throws', async () => {
  const h = load().configure({ apiToken: JWT });
  await h.inner.login();
  h.reply(fail(401), fail(401));
  const res = await h.mod.fetchAsset('/attachments/x.png');
  assert.equal(res.status, 401);
  assert.equal(h.matching('/attachments/x.png').length, 2);
});

test('106: pointing the panel at another instance un-vouches the signed hosts', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/artifacts/presign', ok({ url: 'https://bucket.s3/x?sig=abc' }));
  h.route('bucket.s3', ok({}));
  const signed = await h.mod.presignArtifact('https://bucket.s3/x');
  assert.equal((await h.mod.fetchAsset(signed)).status, 200);
  h.configure({ apiToken: JWT, baseUrl: 'https://other.testomat.io' });
  assert.equal((await rejection(h.mod.fetchAsset(signed))).message, 'Off-instance asset refused');
});

test('107: an upload is multipart on the JSON:API route, with the long budget and no content type', async () => {
  const h = load().configure();
  h.reply(loginOk, ok({ url: 'https://app.testomat.io/a.png' }));
  const blob = new Blob(['x'], { type: 'image/png' });
  const out = await h.mod.uploadAttachment('r1', blob, 'a.png');
  assert.deepEqual(plain(out), { url: 'https://app.testomat.io/a.png' });
  const up = h.calls[1];
  assert.equal(up.url, `${BASE}/api/p1/testruns/r1/attachment`);
  assert.equal(up.method, 'POST');
  assert.equal(up.timeout, 300000);
  assert.equal(up.headers.Authorization, `Bearer ${JWT}`);
  assert.equal('Content-Type' in up.headers, false);
  assert.ok(up.body instanceof FormData);
  assert.equal(up.body.get('file').name, 'a.png');
});

test('108: an upload refused on a stale session is retried once on a fresh one', async () => {
  const h = load().configure();
  h.reply(loginOk, fail(401), loginOk, ok({ url: 'https://app.testomat.io/a.png' }));
  const out = await h.mod.uploadAttachment('r1', new Blob(['x']), 'a.png');
  assert.deepEqual(plain(out), { url: 'https://app.testomat.io/a.png' });
  assert.equal(h.matching('/api/login').length, 2);
  assert.equal(h.matching('/attachment').length, 2);
});

test('109: the polish prompt names itself server-side and keeps the long budget', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ text: 'T', data: { polished_steps: 'S' } }), ok({}));
  assert.deepEqual(plain(await h.mod.polishRecordedSteps('did things', 't1')), { text: 'T', steps: 'S' });
  assert.equal(h.urls()[0], `${BASE}/api/p1/prompts`);
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].timeout, 300000);
  assert.deepEqual(plain(h.body(0)), { prompt: 'polish_recorded_steps', message: 'did things', test_id: 't1' });
  assert.deepEqual(plain(await h.mod.polishRecordedSteps('did things', 't1')), { text: '', steps: '' });
});
