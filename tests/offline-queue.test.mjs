#!/usr/bin/env node
// What extension/sidepanel/screens/offline-queue.js parks, replays and drops (#160): a result marked
// while the connection is down waits on this machine, replays oldest click first when it returns, and
// is dropped with a sentence if its run has meanwhile finished, been archived or turned out automated.
// Run: node --test tests/offline-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, settle } from './helpers/panel-harness.mjs';

// core/state.js's own one-liner. A stub that answered the whole URL would let the connection-stamp
// rows pass without the module ever comparing a host.
const hostOf = (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } };
// screens/run-view.js's own set — the drain asks it whether a run is closed.
const TERMINAL = new Set(['passed', 'failed', 'terminated', 'finished']);

const HERE = { baseUrl: 'https://a.io', projectId: 'p1' };
const ELSEWHERE = { baseUrl: 'https://b.io', projectId: 'p9' };

const OFFLINE_TIP = 'Saved offline — will sync when the connection returns';
const AUTH_TIP = 'Saved here — the token was rejected; authorize again in Settings to sync it';

// The panel globals offline-queue.js reads, all of them real enough to be driven. They live here and
// not in the harness: every screen has its own set, and the eight after this one land in parallel.
function load(opts = {}) {
  const o = {
    settings: { ...HERE },
    view: 'run',
    currentRecordId: null,
    jwt: true,
    readonly: false,
    hasChrome: true,
    rows: [],
    write: async () => {},
    getRun: async () => null,
    getRunInfo: async () => null,
    ...opts,
  };

  // index.html's shape, cut to what this screen touches: the banner, its Retry, the open-test badge
  // and the run list refreshQueueUI walks.
  const doc = makeDocument([]);
  const bannerText = el('span', { className: 'pending-banner-text' });
  const banner = el('div', { id: 'pending-banner', hidden: true }, bannerText);
  const retry = el('button', { id: 'pending-banner-retry' });
  const testQueued = el('span', { id: 'test-queued', hidden: true });
  // One line and no `.meta`, the shape rows took in #215 — the row itself hosts the mark.
  const list = el('ul', { id: 'run-tests' }, ...o.rows.map((id) => el('li', {
    className: 'test-row', dataset: { recordId: String(id) },
  }, el('span', { className: 'title' }, `test ${id}`))));
  doc.body.append(banner, retry, testQueued, list);

  const toasts = [];
  const writes = [];
  const repaints = [];
  const tips = [];
  const apiCalls = [];
  const calls = { $: 0 };
  const state = { settings: o.settings, view: o.view, currentRecordId: o.currentRecordId, runId: 'r1' };
  const capabilities = { jwt: o.jwt, readonly: o.readonly };
  const records = new Map(o.rows.map((id) => [String(id), { id }]));

  const globals = {
    state,
    capabilities,
    hasChrome: o.hasChrome,
    hostOf,
    isReadonlyError: (e) => !!e && e.kind === 'readonly',
    runStatusTerminal: (s) => TERMINAL.has(String(s || '').toLowerCase()),
    recordFor: (id) => records.get(String(id)) || null,
    runRowEl: (id) => doc.querySelector(`#run-tests li.test-row[data-record-id="${id}"]`),
    repaintRow: (li, r) => { repaints.push(String(r.id)); },
    toast: (msg, tOpts) => { toasts.push({ msg, ...(tOpts || {}) }); },
    // refreshQueueUI runs on every enqueue and every removal, so this one has to stay cheap.
    $: (id) => { calls.$ += 1; return doc.getElementById(id); },
    Tooltip: { set: (node, tip) => { tips.push({ node, tip }); } },
    writeStatus: async (record, status, comment, onOptimistic, wOpts) => {
      writes.push({ id: String(record.id), status, comment, opts: { ...wOpts } });
      return o.write(record, status, comment, onOptimistic, wOpts);
    },
    TestomatAPI: {
      getRun: async (id) => { apiCalls.push(['getRun', String(id)]); return o.getRun(String(id)); },
      getRunInfo: async (id) => { apiCalls.push(['getRunInfo', String(id)]); return o.getRunInfo(String(id)); },
    },
  };

  const h = loadScreen('offline-queue', {
    exported: 'OfflineQueue',
    globals,
    document: doc,
    local: o.local,
    session: o.session,
    sessionOnChanged: o.sessionOnChanged,
    now: o.now,
  });

  return {
    ...h,
    Q: h.screen,
    banner, bannerText, retry, testQueued, list,
    toasts, writes, repaints, tips, apiCalls, calls, state, capabilities,
    stored: () => h.store.data.offlineQueue,
    countOf: (name) => apiCalls.filter((c) => c[0] === name).length,
  };
}

// Every row that is not about the status itself queues a passing one.
const enqueue = (h, entry) => h.Q.enqueue({ status: 'passed', ...entry });

// ---------- queueability, the seam and the connection stamp (rows 1-13) ----------

test('1: a dropped connection and a rejected token both park the result', () => {
  const { Q } = load();
  assert.equal(Q.qualifies({ kind: 'network' }), true);
  assert.equal(Q.qualifies({ kind: 'auth' }), true);
});

test('2: a 404, a read-only project and no error at all keep their honest toast instead', () => {
  const { Q } = load();
  for (const e of [{ kind: 'notfound' }, { kind: 'readonly' }, undefined, null]) {
    assert.equal(Q.qualifies(e), false, `${JSON.stringify(e)} must not queue`);
  }
});

test('3: the queued reason normalises — auth stays auth, any other truthy value is network', async () => {
  const h = load();
  await enqueue(h, { recordId: 1, reason: 'auth' });
  await enqueue(h, { recordId: 2, reason: 'offline' });
  await enqueue(h, { recordId: 3, reason: '' });
  await enqueue(h, { recordId: 4 });
  await enqueue(h, { recordId: 5, reason: false });
  assert.equal(h.Q.reason(1), 'auth');
  assert.equal(h.Q.reason(2), 'network');
  assert.equal(h.Q.reason(3), null);
  assert.equal(h.Q.reason(4), null);
  assert.equal(h.Q.reason(5), null);
});

test('4: the forced-failure flag makes a real ApiError, so callers cannot tell it from the live one', async () => {
  const h = load({ session: { forceWriteFail: 'auth' } });
  await h.Q.init();
  const e = h.Q.forcedError();
  assert.ok(e instanceof h.ApiError);
  assert.ok(e instanceof Error);
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 403);
  assert.equal(e.message, 'forced offline (e2e)');

  const net = load({ session: { forceWriteFail: 'anything-else' } });
  await net.Q.init();
  assert.equal(net.Q.forcedError().kind, 'network');
  assert.equal(net.Q.forcedError().status, 0);
});

test('5: with no flag set the seam is inert', async () => {
  const h = load();
  await h.Q.init();
  assert.equal(h.Q.forcedError(), null);
  assert.equal(h.store.ops('session', 'get').length, 1); // it was read, and it answered nothing
});

test('6: a storage.session change keeps the flag live without a second storage read', async () => {
  const h = load();
  await h.Q.init();
  const reads = h.store.ops('session', 'get').length;

  h.store.fireSessionChange({ forceWriteFail: { newValue: 'network' } });
  assert.equal(h.Q.forcedError().kind, 'network');
  assert.equal(h.store.ops('session', 'get').length, reads);

  h.store.fireSessionChange({ forceWriteFail: { newValue: undefined } });
  assert.equal(h.Q.forcedError(), null);
  assert.equal(h.store.ops('session', 'get').length, reads);
});

test('7: an entry carries the connection it was written on', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io/projects/x', projectId: 'p1' }, now: 1700 });
  await h.Q.enqueue({ recordId: 5, runId: 'r1', status: 'failed', comment: 'flaky' });
  assert.deepEqual(h.stored(), {
    5: {
      recordId: 5, runId: 'r1', status: 'failed', comment: 'flaky',
      queuedAt: 1700, reason: null, host: 'a.io', projectId: 'p1',
    },
  });
});

test('8: a second click on the same row replaces the first — one entry, the later status', async () => {
  const h = load();
  await enqueue(h, { recordId: 5, status: 'failed', queuedAt: 10 });
  await enqueue(h, { recordId: 5, status: 'passed', queuedAt: 20 });
  assert.equal(h.Q.count(), 1);
  assert.equal(h.stored()[5].status, 'passed');
  assert.equal(h.stored()[5].queuedAt, 20);
});

test('9: an enqueue with no stamp takes Date.now(); one that brings a stamp keeps it', async () => {
  const h = load({ now: 1_700_000_000_000 });
  await enqueue(h, { recordId: 5 });
  await enqueue(h, { recordId: 6, queuedAt: 42 });
  assert.equal(h.stored()[5].queuedAt, 1_700_000_000_000);
  assert.equal(h.stored()[6].queuedAt, 42);
});

test('10: a missing comment is stored as empty text, a real one verbatim', async () => {
  const h = load();
  await enqueue(h, { recordId: 5, comment: undefined });
  await enqueue(h, { recordId: 6, comment: 'saw a 500' });
  assert.equal(h.stored()[5].comment, '');
  assert.equal(h.stored()[6].comment, 'saw a 500');
});

test('11: an entry from an older build carries no stamp and still counts as this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({}), true);
  assert.equal(h.fn.queueEntryActive({ host: 'a.io', projectId: 'p1' }), true);
});

test('12: an entry written on another instance is not this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({ host: 'b.io', projectId: 'p1' }), false);
});

test('13: an entry written on another project is not this connection', () => {
  const h = load();
  assert.equal(h.fn.queueEntryActive({ host: 'a.io', projectId: 'p2' }), false);
});

// ---------- the store (rows 14-16) ----------

test('14: the count is the whole queue; the active count is the share this connection can sync', async () => {
  const h = load();
  await enqueue(h, { recordId: 1 });
  await enqueue(h, { recordId: 2 });
  h.state.settings = { ...ELSEWHERE };
  await enqueue(h, { recordId: 3 });
  h.state.settings = { ...HERE };
  assert.equal(h.Q.count(), 3);
  assert.equal(h.fn.queueCountActive(), 2);
});

test('15: removing an id that is not queued answers false and writes nothing', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  h.store.clear();

  assert.equal(await h.Q.remove('nope'), false);
  assert.equal(h.store.ops('local', 'set').length, 0);

  // The same call for an id that IS queued both answers true and persists — without this half the
  // assertion above would pass against a store that never writes at all.
  assert.equal(await h.Q.remove(5), true);
  assert.equal(h.store.ops('local', 'set').length, 1);
  assert.deepEqual(h.stored(), {});
});

test('16: a storage write that rejects is swallowed, and the in-memory queue still changed', async () => {
  const h = load();
  h.store.fails.set = new Error('QUOTA_BYTES exceeded');

  await enqueue(h, { recordId: 5, status: 'failed' }); // must not throw
  assert.equal(h.Q.has(5), true);
  assert.equal(h.stored(), undefined); // nothing reached storage

  h.store.fails.set = null;
  await enqueue(h, { recordId: 6, status: 'failed' });
  assert.deepEqual(Object.keys(h.stored()), ['5', '6']);
});

// ---------- the pending banner (rows 38-42) ----------

test('38: one pending change on a run view', async () => {
  const h = load({ view: 'run' });
  await enqueue(h, { recordId: 1 });
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);
  assert.equal(h.bannerText.textContent, '1 change pending');
});

test('39: three pending changes', async () => {
  const h = load({ view: 'run' });
  for (const i of [1, 2, 3]) await enqueue(h, { recordId: i });
  h.Q.refreshUI();
  assert.equal(h.bannerText.textContent, '3 changes pending');
});

test('40: a change for another connection gets its own clause, not an inflated count', async () => {
  const h = load({ view: 'runs' });
  h.state.settings = { ...ELSEWHERE };
  await enqueue(h, { recordId: 1 });
  h.state.settings = { ...HERE };
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);
  assert.equal(h.bannerText.textContent, '1 change waiting for another project or instance');
});

test('41: both clauses, joined', async () => {
  const h = load({ view: 'test' });
  for (const i of [1, 2]) await enqueue(h, { recordId: i });
  h.state.settings = { ...ELSEWHERE };
  for (const i of [3, 4, 5]) await enqueue(h, { recordId: i });
  h.state.settings = { ...HERE };
  h.Q.refreshUI();
  assert.equal(
    h.bannerText.textContent,
    '2 changes pending · 3 changes waiting for another project or instance',
  );
});

test('42: settings is not a view the banner belongs on, whatever is waiting', async () => {
  const h = load({ view: 'run' });
  for (const i of [1, 2]) await enqueue(h, { recordId: i });
  h.state.settings = { ...ELSEWHERE };
  for (const i of [3, 4, 5]) await enqueue(h, { recordId: i });
  h.state.settings = { ...HERE };

  h.Q.refreshUI();
  assert.equal(h.banner.hidden, false);

  h.state.view = 'settings';
  h.Q.refreshUI();
  assert.equal(h.banner.hidden, true);
});

// ---------- the row markers (rows 43-50) ----------

const row = (...kids) => el('li', { className: 'test-row', dataset: { recordId: '5' } }, ...kids);

test('43: a one-line row with no .meta hosts the mark itself, and only the queued row wears one', async () => {
  // Driven by the refresh the enqueue itself runs, over the real #run-tests list.
  const h = load({ rows: [5, 6] });
  await enqueue(h, { recordId: 5 });

  const [five, six] = h.list.children;
  const mark = five.querySelector('.queued-mark');
  assert.ok(mark);
  assert.equal(mark.tagName, 'SPAN');
  assert.equal(mark.className, 'badge outline queued-mark');
  assert.equal(mark.textContent, 'queued');
  assert.equal(mark.parentElement, five);
  assert.equal(five.childNodes.at(-1), mark); // appended, because there is no actions cell
  assert.equal(six.querySelector('.queued-mark'), null);
});

test('44: a row that still has its .meta puts the mark inside it', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const meta = el('span', { className: 'meta' });
  const li = row(el('span', { className: 'title' }), meta);

  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelector('.queued-mark').parentElement, meta);
});

test('45: decorating twice leaves one mark', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const li = row();

  h.Q.decorateRow(li, 5);
  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelectorAll('.queued-mark').length, 1);
});

test('46: once the entry is gone the mark goes with it', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const li = row();
  h.Q.decorateRow(li, 5);
  assert.ok(li.querySelector('.queued-mark'));

  await h.Q.remove(5);
  h.Q.decorateRow(li, 5);
  assert.equal(li.querySelector('.queued-mark'), null);
});

test('47: the mark goes in front of the row actions, never after them', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  const actions = el('span', { className: 'row-actions' });
  const li = row(el('span', { className: 'title' }), actions);

  h.Q.decorateRow(li, 5);
  const mark = li.querySelector('.queued-mark');
  assert.equal(mark.nextElementSibling, actions);
  assert.equal(mark.previousElementSibling.className, 'title');
});

test('48: a row that is not on screen is not an error', async () => {
  const h = load();
  await enqueue(h, { recordId: 5 });
  assert.doesNotThrow(() => h.Q.decorateRow(null, 5));
});

test('49: the open test shows its queued badge, with the wording its reason earned', async () => {
  const h = load({ view: 'test', currentRecordId: 5 });
  await enqueue(h, { recordId: 5, reason: 'network' });
  h.Q.updateTestMarker();
  assert.equal(h.testQueued.hidden, false);
  assert.equal(h.tips.at(-1).tip, OFFLINE_TIP);

  await enqueue(h, { recordId: 5, reason: 'auth' });
  h.Q.updateTestMarker();
  assert.equal(h.tips.at(-1).tip, AUTH_TIP);
});

test('50: a badge queued for another record leaves the open one alone', async () => {
  const h = load({ view: 'test', currentRecordId: 5 });
  await enqueue(h, { recordId: 6 });
  h.Q.updateTestMarker();
  assert.equal(h.testQueued.hidden, true);
});

// ---------- boot (rows 51-53) ----------

test('51a: a corrupt string in storage boots an empty queue', async () => {
  const h = load({ local: { offlineQueue: 'garbage' } });
  await h.Q.init();
  assert.equal(h.Q.count(), 0);

  const good = load({ local: { offlineQueue: { 5: { recordId: 5, status: 'passed', queuedAt: 1 } } } });
  await good.Q.init();
  assert.equal(good.Q.count(), 1);
  assert.equal(good.Q.has(5), true);
});

test('51b: an ARRAY passes the object gate, and its indexes become the record keys', async () => {
  const h = load({
    local: { offlineQueue: [{ recordId: 'a', status: 'passed', queuedAt: 1 }, { recordId: 'b', status: 'passed', queuedAt: 2 }] },
    view: 'run',
  });
  await h.Q.init();
  assert.equal(h.Q.count(), 2);
  assert.equal(h.Q.has(0), true);  // the array index, not the recordId
  assert.equal(h.Q.has('a'), false);
  assert.equal(h.bannerText.textContent, '2 changes pending');
});

test('52: storage that will not answer boots an empty queue rather than throwing', async () => {
  const h = load({ local: { offlineQueue: { 5: { recordId: 5, status: 'passed', queuedAt: 1 } } } });
  h.store.fails.get = new Error('storage unavailable');
  await h.Q.init(); // must not throw
  assert.equal(h.Q.count(), 0);

  // The same seed without the failure does load, so the row above is not asserting a store that
  // never answers anything.
  h.store.fails.get = null;
  await h.Q.init();
  assert.equal(h.Q.count(), 1);
});

test('53: an older Chrome with no session onChanged still finishes init and still wires online', async () => {
  const h = load({ sessionOnChanged: false });
  await h.Q.init(); // must not throw
  assert.deepEqual(h.window.typesOf(), ['online']);
  assert.equal(h.store.sessionListeners.length, 0);

  await enqueue(h, { recordId: 1 });
  h.window.fire('online');
  await settle();
  assert.deepEqual(h.writes.map((w) => w.id), ['1']);
  assert.equal(h.Q.count(), 0);
});
