#!/usr/bin/env node
// extension/sidepanel/core/open-run-intent.js (#201): the "Run in Extension" button on a Testomat
// run page. The tester presses it, Chrome opens the side panel, and the panel is meant to land on
// THAT run — not on the runs list, and not on whatever it was showing yesterday.
// The click survives the hop as one key in session storage, which makes both ways of getting it
// wrong silent. Spend the key twice — once at boot, once from the live onChanged the very same
// write fires — and the run re-opens under a tester who has already started working in it. Spend it
// too late and a click from ten minutes ago hijacks the panel they just opened by hand. So the key
// is removed BEFORE it is acted on, and it is removed even when it is too old to act on.
// The opener is an argument, not the `openRunFromUrl` global: that is what lets this file load with
// a storage fake and nothing else, instead of booting the whole panel.
// Run: node --test tests/open-run-intent.test.mjs
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome, CORE_SRC } from './helpers/panel-harness.mjs';
import { loadInto, settle } from './helpers/shared-harness.mjs';

const FILE = join(CORE_SRC, 'open-run-intent.js');
const KEY = 'openRunIntent';
const RUN_URL = 'https://app.testomat.io/projects/abc/runs/9f8e7d6c';
const NOW = 1_700_000_000_000;

// The sandbox is TWO names wide, and that is the point of the extract: `chrome` and `Date`. No
// document, no window, no panel globals — a stub that is not there cannot make a row pass wrongly.
function load(opts = {}) {
  const {
    now = NOW, session = {}, sessionOnChanged = true, noSession = false, opens = () => true,
  } = opts;
  const store = fakeChrome({ session, sessionOnChanged });
  if (noSession) delete store.chrome.storage.session; // a surface Chrome gave no session area

  // What the opener SEES when it runs, not merely that it ran: by then the key must already be gone.
  const calls = [];
  const openRun = (url) => {
    calls.push({ url, removes: store.ops('session', 'remove').length, stored: { ...store.session } });
    return opens(url);
  };

  const sandbox = {
    chrome: store.chrome,
    // The realm's own Date with one hand held still — the age check is most of this module.
    Date: new Proxy(Date, { get: (t, k) => (k === 'now' ? () => now : Reflect.get(t, k)) }),
  };
  const { value: OpenRunIntent } = loadInto(sandbox, [[FILE, 'OpenRunIntent']]);
  return { OpenRunIntent, store, calls, openRun };
}

const removedKeys = (h) => h.store.ops('session', 'remove').map((c) => c.arg);

// ---------- consume() ----------

test('OR1: a surface with no chrome.storage.session consumes nothing and asks the opener nothing', async () => {
  const h = load({ noSession: true });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(h.calls, []);
});

test('OR2: nothing stored is a false — and no removal, because there is no key to burn', async () => {
  const h = load();
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(removedKeys(h), []);
  assert.deepEqual(h.calls, []);
});

test('OR3: a fresh intent is removed BEFORE the opener runs — boot and the listener must not both run it', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW - 1000 } } });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, RUN_URL);
  assert.equal(h.calls[0].removes, 1, 'the opener ran with the removal already issued');
  assert.deepEqual(h.calls[0].stored, {}, '…and already landed — the store is empty, not merely called');
});

// The boolean is not decoration: app.js does `if (openedIntent) { return; }`, so an opener that
// cannot make sense of the URL must leave boot free to land on the restored session instead.
test('OR3b: an opener that refuses the URL makes consume() false — the key is still burnt', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW - 1000 } }, opens: () => false });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.equal(h.calls.length, 1, 'the opener was asked');
  assert.deepEqual(removedKeys(h), [KEY]);
});

test('OR4: a click 61 s old is refused, and burnt anyway so it cannot fire on the next connect', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW - 61_000 } } });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(removedKeys(h), [KEY]);
  assert.deepEqual({ ...h.store.session }, {});
});

// The edge of the window itself: 60000 ms is `>` not `>=`, so the last millisecond still counts as
// this click. A row either side of it is what stops the comparison drifting.
test('OR4b: a click exactly 60 s old is still this click, and opens', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW - 60_000 } } });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), true);
  assert.equal(h.calls.length, 1);
});

// The ticket reads this row the other way round — "Number(undefined) is NaN, so it IS consumed".
// It is not: `intent.at || 0` never lets `undefined` reach Number. 0 is the epoch, and the epoch is
// always older than 60 s, so an intent with no timestamp is refused like any other stale one.
test('OR5: an intent with no `at` is refused, not consumed — `|| 0` dates it to the epoch', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL } } });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(removedKeys(h), [KEY]);
});

test('OR6: an intent with no url is refused, and burnt on the way out', async () => {
  const h = load({ session: { [KEY]: { at: NOW } } });
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(removedKeys(h), [KEY]);
});

test('OR7: a session.get that rejects is a false, not a throw out of boot', async () => {
  const h = load();
  h.store.fails.sessionGet = new Error('storage unavailable');
  assert.equal(await h.OpenRunIntent.consume(h.openRun), false);
  assert.deepEqual(removedKeys(h), []);
  assert.deepEqual(h.calls, []);
});

// ---------- init() ----------

test('OR8: a panel left open answers the next click — an onChanged carrying a newValue consumes it', async () => {
  const h = load();
  h.OpenRunIntent.init(h.openRun);
  h.store.fireSessionChange({ [KEY]: { newValue: { url: RUN_URL, at: NOW } } });
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, RUN_URL);
  assert.deepEqual(removedKeys(h), [KEY]);
});

test('OR9: a removal — an onChanged carrying only an oldValue — wakes nothing at all', async () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW } } });
  h.OpenRunIntent.init(h.openRun);
  h.store.fireSessionChange({ [KEY]: { oldValue: { url: RUN_URL, at: NOW } } });
  await settle();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.store.ops('session', 'get'), [], 'the listener did not even open the store');
});

test('OR10: an older Chrome with no session.onChanged is a no-op, not a boot that throws', () => {
  const h = load({ sessionOnChanged: false });
  assert.doesNotThrow(() => h.OpenRunIntent.init(h.openRun));
});

// ---------- drop() ----------

test('OR11: drop() on a surface with no storage.session throws nothing', () => {
  const h = load({ noSession: true });
  assert.doesNotThrow(() => h.OpenRunIntent.drop());
});

test('OR11b: drop() burns a stored intent — Settings must not leave one to fire on a later connect', () => {
  const h = load({ session: { [KEY]: { url: RUN_URL, at: NOW } } });
  h.OpenRunIntent.drop();
  assert.deepEqual(removedKeys(h), [KEY]);
  assert.deepEqual({ ...h.store.session }, {});
});
