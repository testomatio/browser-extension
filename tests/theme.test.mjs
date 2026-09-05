#!/usr/bin/env node
// extension/shared/theme.js (#180): dark mode, mirrored across the panel, the editor and the viewer.
// Two stores hold the answer — a localStorage mirror that paints the page in the same tick it opens,
// and chrome.storage, which is the authority and arrives a moment later. This file reconciles them.
// Both halves fail quietly when they break: lose the synchronous paint and a tester on dark mode
// gets a white flash on every open; lose the echo guard in adopt() and the panel and the editor
// rewrite each other's storage forever, each announcing a change that never happened.
// Run: node --test tests/theme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, chromeFake, settle } from './helpers/shared-harness.mjs';

const KEY = 'theme';

// theme.js does real work AT LOAD — it reads the mirror and paints before it returns — so the whole
// sandbox has to be standing before the script is evaluated, not patched in afterwards.
function loadTheme(opts = {}) {
  const {
    seed = null,          // what localStorage holds when the page opens
    getThrows = false,    // localStorage blocked by the browser
    setThrows = false,
    stored,               // what chrome.storage.local answers, a microtask later
    localFail = {},
    dark = false,         // the OS preference matchMedia reports
    chromeMode = 'full',  // 'full' | 'none' (no chrome at all) | 'storageless' (chrome, no storage.local)
  } = opts;

  // Every colorScheme write in order: the echo guard is asserted by the writes that DON'T happen.
  const paints = [];
  let scheme = 'untouched';
  const style = {
    get colorScheme() { return scheme; },
    set colorScheme(v) { scheme = v; paints.push(v); },
  };

  const mirror = { data: seed == null ? {} : { [KEY]: seed }, writes: [] };
  const localStorage = {
    getItem(k) {
      if (getThrows) throw new Error('localStorage is blocked');
      return k in mirror.data ? mirror.data[k] : null;
    },
    setItem(k, v) {
      mirror.writes.push([k, v]);
      if (setThrows) throw new Error('localStorage is blocked');
      mirror.data[k] = v;
    },
  };

  const media = [];
  const matchMedia = (q) => { media.push(q); return { matches: dark }; };

  const h = chromeFake({ local: stored === undefined ? {} : { [KEY]: stored }, localFail });
  const onChanged = { listeners: [], added: 0 };
  h.chrome.storage.onChanged = {
    addListener(fn) { onChanged.added += 1; onChanged.listeners.push(fn); },
  };

  const sandbox = {
    document: { documentElement: { style } },
    window: { localStorage, matchMedia },
  };
  if (chromeMode === 'full') sandbox.chrome = h.chrome;
  if (chromeMode === 'storageless') sandbox.chrome = { storage: { onChanged: h.chrome.storage.onChanged } };

  const { value } = loadInto(sandbox, [['shared/theme.js', 'Theme']]);
  return {
    Theme: value,
    paints,
    mirror,
    media,
    h,
    onChanged,
    scheme: () => scheme,
    // What Chrome does when the OTHER page writes: the value has already changed when this fires.
    fire: (changes, area = 'local') => onChanged.listeners.forEach((fn) => fn(changes, area)),
  };
}

// A recorded listener plus the modes it was handed, in order.
function watcher(impl = () => undefined) {
  const seen = [];
  const fn = (mode) => { seen.push(mode); return impl(mode); };
  fn.seen = seen;
  return fn;
}

// ---------- the mirror, painted before the page draws ----------

test('a tester on dark mode sees dark in the same tick the page opens, not after a round trip', () => {
  const t = loadTheme({ seed: 'dark' });
  // No await: this is the whole reason theme.js is loaded from <head>.
  assert.equal(t.scheme(), 'dark');
  assert.deepEqual(t.paints, ['dark']);
  assert.equal(t.Theme.get(), 'dark');
});

test('a mode no build ever shipped means system, which is the ABSENCE of a pin', () => {
  const t = loadTheme({ seed: 'sepia' });
  assert.equal(t.scheme(), '');
  assert.equal(t.Theme.get(), 'system');
});

test('a browser with localStorage blocked opens on system instead of failing to open', () => {
  const t = loadTheme({ getThrows: true });
  assert.equal(t.Theme.get(), 'system');
  assert.equal(t.scheme(), '');
});

// ---------- the authority, and the echo guard ----------

test('storage overrules a stale mirror, repaints, and rewrites the mirror', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'light' });
  const heard = watcher();
  t.Theme.onChange(heard);
  await settle();
  assert.equal(t.Theme.get(), 'light');
  assert.deepEqual(t.paints, ['dark', 'light']);
  assert.deepEqual(t.mirror.writes, [[KEY, 'light']]);
  assert.deepEqual(heard.seen, ['light']);
});

test('storage agreeing with the mirror changes nothing — no rewrite, no announcement', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'dark' });
  const heard = watcher();
  t.Theme.onChange(heard);
  await settle();
  assert.equal(t.Theme.get(), 'dark');
  assert.deepEqual(t.paints, ['dark']);   // the boot paint, and nothing after it
  assert.deepEqual(t.mirror.writes, []);  // the write that would echo back as an onChanged
  assert.deepEqual(heard.seen, []);
});

test('storage that never answers leaves the mirror’s colour in place', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'light', localFail: { get: true } });
  await settle();
  assert.equal(t.Theme.get(), 'dark');
  assert.deepEqual(t.paints, ['dark']);
});

// ---------- the other page changing it ----------

test('the editor switching to light follows through to this page without a reload', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'dark' });
  const heard = watcher();
  t.Theme.onChange(heard);
  await settle();
  t.fire({ [KEY]: { newValue: 'light' } }, 'local');
  assert.equal(t.Theme.get(), 'light');
  assert.deepEqual(heard.seen, ['light']);
});

test('a change in the session area is not the theme and is ignored', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'dark' });
  const heard = watcher();
  t.Theme.onChange(heard);
  await settle();
  t.fire({ [KEY]: { newValue: 'light' } }, 'session');
  assert.equal(t.Theme.get(), 'dark');
  assert.deepEqual(heard.seen, []);
});

test('some other key changing in local storage is not the theme either', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'dark' });
  const heard = watcher();
  t.Theme.onChange(heard);
  await settle();
  t.fire({ token: { newValue: 'x' } }, 'local');
  t.fire({ viewMode: { newValue: 'window' } }, 'local');
  assert.equal(t.Theme.get(), 'dark');
  assert.deepEqual(heard.seen, []);
});

test('a theme cleared out of storage falls back to system', async () => {
  const t = loadTheme({ seed: 'dark', stored: 'dark' });
  await settle();
  t.fire({ [KEY]: { newValue: undefined } }, 'local');
  assert.equal(t.Theme.get(), 'system');
  assert.equal(t.scheme(), '');
});

// ---------- the tester making the change here ----------

test('the page paints first and persists after, so a failed write still shows the choice', async () => {
  const t = loadTheme({ localFail: { set: true } });
  await settle();
  await t.Theme.set('dark');
  assert.equal(t.Theme.get(), 'dark');
  assert.equal(t.scheme(), 'dark');
  assert.deepEqual(t.mirror.writes, [[KEY, 'dark']]);
});

test('choosing the mode already on screen repaints nothing but still writes it down', async () => {
  const t = loadTheme();
  await settle();
  const heard = watcher();
  t.Theme.onChange(heard);
  await t.Theme.set('dark');
  await t.Theme.set('dark');
  assert.deepEqual(t.paints, ['', 'dark']);            // the boot's system paint, then one switch
  assert.deepEqual(heard.seen, ['dark']);              // announced once, not twice
  assert.deepEqual(t.mirror.writes, [[KEY, 'dark']]);
  // The storage write is outside the guard on purpose: a first run has nothing stored yet.
  assert.equal(t.h.local.sets.length, 2);
});

test('a mode the UI could not have produced is clamped to system', async () => {
  const t = loadTheme({ seed: 'dark' });
  await settle();
  await t.Theme.set('junk');
  assert.equal(t.Theme.get(), 'system');
  assert.equal(t.scheme(), '');
});

test('a mirror that refuses the write does not stop the tester changing the theme', async () => {
  const t = loadTheme({ setThrows: true });
  await settle();
  await t.Theme.set('dark');
  assert.equal(t.Theme.get(), 'dark');
  assert.equal(t.scheme(), 'dark');
});

// ---------- the subscribers ----------

test('one listener that throws does not silence the ones after it', async () => {
  const t = loadTheme();
  await settle();
  const first = watcher();
  const bad = watcher(() => { throw new Error('a subscriber blew up'); });
  const last = watcher();
  t.Theme.onChange(first);
  t.Theme.onChange(bad);
  t.Theme.onChange(last);
  await t.Theme.set('dark');
  assert.deepEqual(first.seen, ['dark']);
  assert.deepEqual(bad.seen, ['dark']);
  assert.deepEqual(last.seen, ['dark']);
});

test('unsubscribing really stops the callbacks', async () => {
  const t = loadTheme();
  await settle();
  const heard = watcher();
  const off = t.Theme.onChange(heard);
  await t.Theme.set('dark');
  off();
  await t.Theme.set('light');
  assert.deepEqual(heard.seen, ['dark']);
});

// ---------- the concrete answer the on-page overlay needs ----------

test('on system, the answer is whatever the OS says right now', async () => {
  assert.equal(loadTheme({ dark: true }).Theme.resolved(), 'dark');
  assert.equal(loadTheme({ dark: false }).Theme.resolved(), 'light');
});

test('a mode the tester picked outranks the OS, which is not even consulted', () => {
  const t = loadTheme({ seed: 'light', dark: true });
  assert.equal(t.Theme.resolved(), 'light');
  assert.deepEqual(t.media, []);
  const d = loadTheme({ seed: 'dark', dark: false });
  assert.equal(d.Theme.resolved(), 'dark');
  assert.deepEqual(d.media, []);
});

test('the OS is asked the one query tokens.css is written against', () => {
  const t = loadTheme({ dark: true });
  t.Theme.resolved();
  assert.deepEqual(t.media, ['(prefers-color-scheme: dark)']);
});

// ---------- pages the extension APIs are not available on ----------

test('a page with no chrome at all still opens in the tester’s colour', () => {
  const t = loadTheme({ seed: 'dark', chromeMode: 'none' });
  assert.equal(t.Theme.get(), 'dark');
  assert.equal(t.scheme(), 'dark');
});

test('without extension storage nothing is subscribed to and nothing is written', async () => {
  const t = loadTheme({ seed: 'dark', chromeMode: 'storageless' });
  await settle();
  assert.equal(t.onChanged.added, 0);
  await t.Theme.set('light');
  assert.equal(t.Theme.get(), 'light');
  assert.deepEqual(t.mirror.writes, [[KEY, 'light']]);
});

test('with extension storage, exactly one cross-page subscription is registered', async () => {
  const t = loadTheme();
  await settle();
  assert.equal(t.onChanged.added, 1);
});

test('the key and the three modes are the contract every page shares', () => {
  const t = loadTheme();
  assert.equal(t.Theme.KEY, KEY);
  assert.deepEqual([...t.Theme.MODES], ['system', 'light', 'dark']);
});
