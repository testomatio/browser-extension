#!/usr/bin/env node
// extension/api.js: the pagination drain and the fan-outs — how much of a list the tester actually
// sees. Rows 1-13 and 91-96 of #145. Run: node --test tests/api-paging.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, page, ok, fail, rejection, JWT, plain } from './helpers/api-harness.mjs';

// n index rows; the drain only ever counts them.
const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}` }));
const drained = (h) => h.matching('/api/v2/');

// ---- pagedData, through listTestruns (E-P0-2, fixed in #124 — regression) ----

test('1: three pages drain whole, and every URL asks for page N of 100', async () => {
  const h = load().configure();
  h.reply(page(rows(100)), page(rows(100, 100)), page(rows(40, 200)));
  const out = await h.mod.listTestruns('r1');
  assert.equal(out.length, 240);
  assert.equal(drained(h).length, 3);
  h.urls().forEach((u, i) => {
    const q = new URL(u).searchParams;
    assert.equal(q.get('per_page'), '100');
    assert.equal(q.get('page'), String(i + 1));
  });
});

test('2: a server that caps at 50 still drains — the stop is the SERVER page size', async () => {
  const h = load().configure();
  h.reply(page(rows(50), { per_page: 50 }), page(rows(50, 50), { per_page: 50 }), page(rows(12, 100), { per_page: 50 }));
  const out = await h.mod.listTestruns('r1');
  assert.equal(out.length, 112); // pre-#124 this stopped at 50 — the ask, not the answer
  assert.equal(drained(h).length, 3);
});

test('3: with no meta at all the stop is the first page own length', async () => {
  const h = load().configure();
  h.reply(page(rows(30)), page(rows(30, 30)), page(rows(7, 60)));
  assert.equal((await h.mod.listTestruns('r1')).length, 67);
  assert.equal(drained(h).length, 3);
});

test('4: meta.has_more false ends the drain on a full page', async () => {
  const h = load().configure();
  h.reply(page(rows(100), { has_more: false }));
  assert.equal((await h.mod.listTestruns('r1')).length, 100);
  assert.equal(drained(h).length, 1);
});

test('5: meta.total_pages ends it even though page 2 came back full', async () => {
  const h = load().configure();
  h.reply(page(rows(100), { total_pages: 2 }), page(rows(100, 100), { total_pages: 2 }));
  assert.equal((await h.mod.listTestruns('r1')).length, 200);
  assert.equal(drained(h).length, 2);
});

test('6: meta.total ends it once the pile reaches the count', async () => {
  const h = load().configure();
  h.reply(page(rows(100), { total: 150 }), page(rows(50, 100), { total: 150 }));
  assert.equal((await h.mod.listTestruns('r1')).length, 150);
  assert.equal(drained(h).length, 2);
});

test('7: an empty first page is one request and an empty list', async () => {
  const h = load().configure();
  h.reply(page([]));
  assert.deepEqual(plain(await h.mod.listTestruns('r1')), []);
  assert.equal(drained(h).length, 1);
});

test('8: a body with no data key is the same empty list, not a crash', async () => {
  const h = load().configure();
  h.reply(ok(null));
  assert.deepEqual(plain(await h.mod.listTestruns('r1')), []);
  assert.equal(drained(h).length, 1);
});

test('9: a list that never ends throws instead of grading a truncated pile', async () => {
  const h = load().configure();
  h.route('/testruns', { status: 200, json: { data: rows(100) }, delay: 0 });
  const e = await rejection(h.mod.listTestruns('r1'));
  assert.equal(e.kind, 'http');
  assert.equal(e.message, '/testruns is too long to drain — over 1000 pages');
  assert.equal(drained(h).length, 1000); // pre-#124 this returned the pile
});

test('10: meta.per_page as a STRING is read as no meta at all', async () => {
  const h = load().configure();
  // Honoured, "50" would have stopped the drain on page 1 at 30 rows; the own-length seed keeps it going.
  h.reply(page(rows(30), { per_page: '50' }), page(rows(30, 30)), page(rows(7, 60)));
  assert.equal((await h.mod.listTestruns('r1')).length, 67);
  assert.equal(drained(h).length, 3);
});

test('11: a server that over-delivers a page is not a short page, so the drain goes on', async () => {
  const h = load().configure();
  h.reply(page(rows(100), { per_page: 100 }), page(rows(120, 100), { per_page: 100 }), page([]));
  assert.equal((await h.mod.listTestruns('r1')).length, 220);
  assert.equal(drained(h).length, 3);
});

test('12: listTestruns carries run_id, then the page params', async () => {
  const h = load().configure();
  h.reply(page(rows(1), { has_more: false }));
  await h.mod.listTestruns('r9');
  assert.equal(h.urls()[0], 'https://app.testomat.io/api/v2/p1/testruns?run_id=r9&page=1&per_page=100');
});

test('13: getTestsBySuite sends the bracketed key — a bare suites= 500s', async () => {
  const h = load().configure();
  h.reply(page(rows(1), { has_more: false }));
  await h.mod.getTestsBySuite('s1');
  assert.equal(new URL(h.urls()[0]).searchParams.get('suites[]'), 's1');
  assert.ok(h.urls()[0].includes('suites%5B%5D=s1'), h.urls()[0]);
});

// ---- the fan-outs (E-P1-3 and E-P2-4 still OPEN) ----

// One request per page, page 1 alone announcing how many there are; page 2 answers LAST on purpose.
const suitePage = (rec) => {
  const p = Number(new URL(rec.url).searchParams.get('page'));
  const json = { data: [{ id: `s${p}`, attributes: { position: 10 - p } }] };
  if (p === 1) json.meta = { total_pages: 6 };
  return { status: 200, json, delay: p === 2 ? 4 : 1 };
};

test('91: getSuitePositions fires pages 2..6 in ONE Promise.all — nothing caps it', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/suites?page=', suitePage);
  const positions = await h.inner.getSuitePositions();
  assert.equal(h.matching('/suites?page=').length, 6);
  assert.equal(h.maxInFlight(), 5); // E-P1-3 OPEN: total_pages 1000 would fire 999 at once
  assert.equal(positions.size, 6);
  assert.equal(positions.get('s2'), 8); // the last to answer still lands in the map
  assert.equal(positions.get('s6'), 4);
});

test('92: listTestrunExamples fans the same way, once per open run', async () => {
  const h = load().configure({ apiToken: JWT });
  h.route('/testruns?run_id=', (rec) => {
    const p = Number(new URL(rec.url).searchParams.get('page'));
    const json = { data: [{ id: `tr${p}`, attributes: { example: [`v${p}`] } }] };
    if (p === 1) json.meta = { total_pages: 6 };
    return { status: 200, json, delay: p === 2 ? 4 : 1 };
  });
  const map = await h.mod.listTestrunExamples('r1');
  assert.equal(h.matching('/testruns?run_id=').length, 6);
  assert.equal(h.maxInFlight(), 5); // E-P1-3 OPEN
  assert.deepEqual(Object.keys(plain(map)).sort(), ['tr1', 'tr2', 'tr3', 'tr4', 'tr5', 'tr6']);
  assert.deepEqual(plain(map).tr2, { values: ['v2'], params: null });
});

test('93: fetchGroupRunsNested pages on a hardcoded 50, not on PAGE_GUARD', async () => {
  const h = load().configure({ apiToken: JWT });
  const runRows = (n, from) => rows(n, from).map((r) => ({ ...r, type: 'run', attributes: { status: 'passed' } }));
  h.reply(ok({ data: runRows(50, 0) }), ok({ data: runRows(20, 50) })); // E-P2-4 OPEN: page <= 100
  const out = await h.mod.fetchGroupRunsNested('g1');
  assert.equal(out.length, 70);
  assert.equal(h.matching('nested=true').length, 2);
});

test('94: listProjects lets page 1 fail loudly — Settings validates the token on it', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(fail(500));
  const e = await rejection(h.mod.listProjects());
  assert.equal(e.kind, 'http');
  assert.equal(e.status, 500);
});

test('95: a tail dying mid-drain keeps the projects already in hand', async () => {
  const h = load().configure({ apiToken: JWT });
  h.reply(ok({ data: rows(200).map((r) => ({ id: r.id, attributes: { title: r.id } })) }), fail(500));
  const out = await h.mod.listProjects();
  assert.equal(out.length, 200);
  assert.equal(h.matching('/projects?page=').length, 2);
});

test('96: the projects drain asks for 200 a page and stops on meta.num', async () => {
  const h = load().configure({ apiToken: JWT });
  const proj = (n, from) => rows(n, from).map((r) => ({ id: r.id, attributes: { title: r.id, 'tests-count': 3 } }));
  const meta = { num: 250, total_pages: 2 };
  h.reply(ok({ data: proj(200, 0), meta }), ok({ data: proj(50, 200), meta }));
  const out = await h.mod.listProjects();
  assert.equal(out.length, 250);
  assert.deepEqual(plain(out[0]), { id: 't0', title: 't0', testsCount: 3 });
  const urls = h.matching('/projects?page=').map((c) => c.url);
  assert.equal(urls.length, 2);
  urls.forEach((u) => assert.equal(new URL(u).searchParams.get('per_page'), '200'));
});
