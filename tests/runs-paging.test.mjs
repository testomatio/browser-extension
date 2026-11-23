#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, SCREENS_SRC, plain } from './helpers/panel-harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// SCREENS_SRC is switchable; index.html belongs to neither and is read where it ships.
const raw = (dir, f) => readFileSync(join(dir, f), 'utf8');

const run = (id, over = {}) => ({ id, type: 'run', title: `Run ${id}`, status: 'passed', ...over });
const group = (id, over = {}) => ({ id, type: 'rungroup', title: `Group ${id}`, ...over });

// `state` is the module's only global; every key here is one runs-list.js writes.
function load(opts = {}) {
  const state = {
    listMode: 'dashboard',
    dashItems: [],
    lastRuns: [],
    lastGroups: [],
    childrenCache: {},
    subgroupsCache: {},
    groupPaging: {},
    listPaging: {},
    v2RunsPaging: {},
    v2GroupsPaging: {},
    ...opts,
  };
  const h = loadScreen('runs-paging', { globals: { state }, exported: 'RunsPaging' });
  return { ...h, paging: h.screen, state };
}

test('1: the server states the page size and the row total, and the page count is derived from them', () => {
  const h = load();
  assert.deepEqual(plain(h.paging.v2Cursor({ meta: { page: 2, per_page: 50, total: 180 } }, 2)),
    { page: 2, perPage: 50, total: 180, totalPages: 4 });
});

test('1b: the page the SERVER reports is the one Load more counts from, not the one we asked for', () => {
  const h = load();
  // v2 keeps its own page in meta, and a request can be clamped: page 9 of a 3-page list answers 3.
  const clamped = h.paging.v2Cursor({ meta: { page: 3, per_page: 50, total: 150 } }, 9);
  assert.equal(plain(clamped).page, 3);
  assert.equal(h.paging.hasNextPage(clamped), false); // asking again would re-read the same last page

  // Only when the server states nothing does the asked-for page stand in.
  assert.equal(plain(h.paging.v2Cursor({ meta: { per_page: 50, total: 150 } }, 2)).page, 2);
});

test('2: a server that sends no meta at all never offers Load more — the page size is what arrived', () => {
  const h = load();
  const cursor = h.paging.v2Cursor({ data: Array.from({ length: 30 }, (_, i) => run(`r${i}`)) }, 1);
  assert.deepEqual(plain(cursor), { page: 1, perPage: 30, total: null, totalPages: null });
  assert.equal(h.paging.hasNextPage(cursor), false);
  // The same shape with a meta does offer it, so the false above is a decision and not a stub.
  assert.equal(h.paging.hasNextPage(h.paging.v2Cursor({ meta: { page: 1, per_page: 30, total: 90 }, data: [] }, 1)), true);
});

test('3: an empty page still divides — perPage falls to 1 rather than to zero', () => {
  const h = load();
  assert.deepEqual(plain(h.paging.v2Cursor({ data: [] }, 3)), { page: 3, perPage: 1, total: null, totalPages: null });
  // With a total present the |1 is what keeps the ceil finite instead of Infinity.
  assert.equal(h.paging.v2Cursor({ meta: { total: 7 }, data: [] }, 1).totalPages, 7);
});

test('93a: the page size is the server\'s word, then what arrived, then 1 — in that order', () => {
  const h = load();
  const rows = (n) => Array.from({ length: n }, (_, i) => run(`r${i}`));
  // The server's own number outranks the short page it sent with it: 200/50 is 4 pages, not 2.
  assert.deepEqual(plain(h.paging.v2Cursor({ meta: { per_page: 50, total: 200 }, data: rows(20) }, 1)),
    { page: 1, perPage: 50, total: 200, totalPages: 4 });
  // A per_page of 0 is no answer at all, so the rows that arrived are the size.
  assert.equal(plain(h.paging.v2Cursor({ meta: { per_page: 0, total: 200 }, data: rows(20) }, 1)).perPage, 20);
  // Neither: the 1 that keeps the division finite.
  assert.equal(plain(h.paging.v2Cursor({ meta: { total: 200 }, data: [] }, 1)).perPage, 1);
  // A partial last page still counts as a page — 201 rows of 50 is 5, never 4.
  assert.equal(plain(h.paging.v2Cursor({ meta: { per_page: 50, total: 201 } }, 1)).totalPages, 5);
  // And a total the page size already covers is one page, never zero: a total of 0 still has a page.
  assert.equal(plain(h.paging.v2Cursor({ meta: { per_page: 50, total: 0 } }, 1)).totalPages, 1);
});

test('4: "there is more" needs a page COUNT — an unknown one is not a promise of another page', () => {
  const h = load();
  assert.equal(h.paging.hasNextPage({ page: 1, totalPages: null }), false);
  assert.equal(h.paging.hasNextPage({ page: 1, totalPages: 2 }), true);
  assert.equal(h.paging.hasNextPage(null), false);
  // The last page is not a next page either.
  assert.equal(h.paging.hasNextPage({ page: 2, totalPages: 2 }), false);
  // `n < null` reads null as 0, so only a negative page, which a server may send, needs the `!= null`.
  assert.equal(h.paging.hasNextPage({ page: -1, totalPages: null }), false);
});

// groupHasMore builds this for a never-paged folder; the |1 is why such a folder offers page 2.
test('93b: a cursor that states no page of its own is read as page 1, not as no page', () => {
  const h = load();
  assert.equal(h.paging.hasNextPage({ totalPages: 3 }), true);
  assert.equal(h.paging.hasNextPage({ totalPages: 1 }), false);
});

test('5: the remainder never goes negative, and an unknown total has no remainder to state', () => {
  const h = load();
  assert.equal(h.paging.remainderOf({ total: 180 }, 200), 0);
  assert.equal(h.paging.remainderOf({ total: null }, 5), null);
  assert.equal(h.paging.remainderOf(null, 5), null);
  assert.equal(h.paging.remainderOf({ total: 180 }, 30), 150);
});

test('6: the two v2 sources fold into one cursor, and the total is null unless BOTH report one', () => {
  const h = load({
    v2RunsPaging: { page: 1, total: 10, totalPages: 4 },
    v2GroupsPaging: { page: 2, total: null, totalPages: 1 },
  });
  assert.deepEqual(plain(h.paging.v2ListPaging()), { page: 2, total: null, totalPages: 4, loading: false });
  // Both reporting: the totals add, which is the branch the null above is chosen over.
  h.state.v2GroupsPaging = { page: 2, total: 3, totalPages: 1 };
  assert.deepEqual(plain(h.paging.v2ListPaging(true)), { page: 2, total: 13, totalPages: 4, loading: true });
});

// A swap is invisible in dashboard mode, where the numbers happen to agree.
test('93c: the list cursor and the loaded count each follow the mode the list is actually in', () => {
  const h = load({
    listMode: 'dashboard',
    listPaging: { page: 2, total: 40, totalPages: 4, loading: true },
    dashItems: [run('a'), group('g')],
    lastRuns: [run('x')],
    lastGroups: [],
    v2RunsPaging: { page: 1, total: 5, totalPages: 2 },
    v2GroupsPaging: { page: 1, total: 5, totalPages: 3 },
  });
  // Dashboard: the one cursor the page fetch wrote, and the one flat list of rows.
  assert.deepEqual(plain(h.paging.listCursor()), { page: 2, total: 40, totalPages: 4, loading: true });
  assert.equal(h.paging.listLoadedCount(), 2);

  // v2: the fold of both cursors, `loading` carried across so the pressed button stays disabled.
  h.state.listMode = 'v2';
  assert.deepEqual(plain(h.paging.listCursor()), { page: 1, total: 10, totalPages: 3, loading: true });
  assert.equal(h.paging.listLoadedCount(), 1);
  h.state.lastGroups = [group('g1'), group('g2')];
  assert.equal(h.paging.listLoadedCount(), 3);

  // Nothing fetched yet: the absent flag falls to `false`, so the button is not stuck on `undefined`.
  h.state.listPaging = {};
  assert.equal(plain(h.paging.listCursor()).loading, false);
  h.state.lastRuns = null;
  h.state.lastGroups = null;
  assert.equal(h.paging.listLoadedCount(), 0);
});

test('92: a folder has more when EITHER half has, and the remainder is the two added together', () => {
  const h = load({
    subgroupsCache: { g1: [group('a')] },
    childrenCache: { g1: [run('r1'), run('r2')] },
  });
  assert.equal(h.paging.groupHasMore('never-opened'), false);
  h.state.groupPaging.g1 = { subsPage: 1, subsTotalPages: 1, runsPage: 1, runsTotalPages: 1, subsTotal: 1, runsTotal: 2 };
  assert.equal(h.paging.groupHasMore('g1'), false);
  assert.equal(h.paging.groupRemainder('g1'), 0);
  h.state.groupPaging.g1 = { subsPage: 1, subsTotalPages: 3, runsPage: 1, runsTotalPages: 1, subsTotal: 5, runsTotal: 2 };
  assert.equal(h.paging.groupHasMore('g1'), true);
  assert.equal(h.paging.groupRemainder('g1'), 4);              // 5-1 subgroups, 2-2 runs
  h.state.groupPaging.g1 = { subsPage: 1, subsTotalPages: 1, runsPage: 1, runsTotalPages: 9, subsTotal: null, runsTotal: 6 };
  assert.equal(h.paging.groupHasMore('g1'), true);
  assert.equal(h.paging.groupRemainder('g1'), 4);              // an unknown half counts as nothing left
  h.state.groupPaging.g1 = { subsPage: 1, subsTotalPages: 2, runsPage: 1, runsTotalPages: 2, subsTotal: null, runsTotal: null };
  assert.equal(h.paging.groupRemainder('g1'), null);           // neither total known: no number to state
  assert.equal(h.paging.groupRemainder('never-opened'), null);
});

// Measuring the runs against the subgroup cache is the mistake pinned here.
test('93d: each half is counted against its own cache, and a numeric folder id finds it', () => {
  const h = load({
    subgroupsCache: { 7: [group('a'), group('b')] },
    childrenCache: { 7: [run('r1')] },
    groupPaging: { 7: { subsPage: 1, subsTotalPages: 1, runsPage: 1, runsTotalPages: 1, subsTotal: 9, runsTotal: 4 } },
  });
  assert.equal(h.paging.groupRemainder(7), 10);   // 9-2 subgroups + 4-1 runs, and never the other way round
  assert.equal(h.paging.groupHasMore(7), false);
  // A folder with no cache at all still measures against 0 rather than throwing.
  h.state.groupPaging[7].runsTotalPages = 2;
  assert.equal(h.paging.groupHasMore(7), true);
  h.state.subgroupsCache = {};
  h.state.childrenCache = {};
  assert.equal(h.paging.groupRemainder(7), 13);
});

// A bare name left in runs-list.js, or a script tag below its caller, throws only at runtime.
test('93e: the module stands alone and stands ahead of the screen that calls it', () => {
  const module = raw(SCREENS_SRC, 'runs-paging.js');
  const caller = raw(SCREENS_SRC, 'runs-list.js');
  const NAMES = ['v2Cursor', 'v2ListPaging', 'remainderOf', 'hasNextPage',
    'listCursor', 'listLoadedCount', 'groupHasMore', 'groupRemainder'];

  // A top-level `function` in a classic script lands on globalThis, so a bare name would still resolve.
  for (const n of NAMES) assert.match(module, new RegExp(`\\n  ${n}[:(]`), n);
  assert.equal(/^(async )?function /m.test(module), false);
  // No DOM, no API, no screen — `state` is the whole dependency list.
  assert.match(module, /\/\* global state \*\//);
  for (const n of ['document', 'TestomatAPI', '$(', 'toast', 'renderList']) {
    assert.equal(module.includes(n), false, n);
  }

  // The caller says RunsPaging.<name> and answers to no bare name any more.
  assert.match(caller, /\/\* global [^*]*\bRunsPaging\b/);
  for (const n of NAMES) {
    assert.match(caller, new RegExp(`RunsPaging\\.${n}\\b`), n);
    assert.equal(new RegExp(`(?<!RunsPaging\\.)\\b${n}\\b`).test(caller), false, n);
  }

  // …and index.html evaluates the module first. Read where it ships: it is in neither directory.
  const html = raw(join(repoRoot, 'extension/sidepanel'), 'index.html');
  const at = (f) => html.indexOf(`<script src="screens/${f}.js">`);
  assert.ok(at('runs-paging') > 0, 'index.html loads screens/runs-paging.js');
  assert.ok(at('runs-paging') < at('runs-list'), 'runs-paging.js is evaluated before runs-list.js');
});
