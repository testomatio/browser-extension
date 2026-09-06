#!/usr/bin/env node
// extension/sidepanel/screens/settings-erase.js on its own (#203): Forget instance, Disconnect and
// Sign out, split out of the screen that also paints and saves the form. These rows are the ones the
// module makes CHEAP, and they are all the same row underneath — THE ORDER. Storage is written first
// and the in-memory copy follows only on success, so a rejected write leaves the panel unchanged
// rather than half-erased; a test that reads only the end state cannot tell a correct order from a
// lucky one, so every sequence below is asserted as a list. `HOST_SCOPED_KEYS` is the other half of
// the promise: drop `offlineQueue` from it and a Forget leaves the tester's queued results — with the
// raw comments they typed — sitting on a machine they were told was clean.
// The whole of Settings still drives these through the screen in tests/settings.test.mjs, which the
// split left untouched; what is cheaper here is reaching one path with four stubs instead of a page.
// Run: node --test tests/settings-erase.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadScreen, fakeChrome, fakeClock, makeDocument, el, plain, settle, rejection, CORE_SRC,
} from './helpers/panel-harness.mjs';

// The REAL hostOf, not a look-alike: "a non-empty field that does not parse resolves to nothing" is
// a rule about that function's refusal, and a stub returning the string back would pass the row while
// the panel retargeted a destructive button at whatever was half-typed.
const { hostOf } = runInNewContext(
  `${readFileSync(join(CORE_SRC, 'state.js'), 'utf8')}\n({ hostOf });`, { URL },
);

const WARN_KEY = 'signOutRecorderWarning';
const KEYS = ['settings', 'session', 'offlineQueue'];

// `state` is an ACCESSOR bag, not a plain object: the safety property is that storage is written
// before any of these is touched, and only a recorded write can show that.
function makeState(o, order) {
  const bag = {
    settings: o.settings, hostSettings: o.hostSettings, hostHistory: o.hostHistory, booting: false,
  };
  const label = (k, v) => {
    if (k === 'booting') return `state.booting=${v}`;
    if (k === 'settings' && v === null) return 'state.settings=null';
    return `state.${k}`;
  };
  const state = {};
  for (const k of Object.keys(bag)) {
    Object.defineProperty(state, k, {
      enumerable: true, get: () => bag[k], set: (v) => { bag[k] = v; order.push(label(k, v)); },
    });
  }
  return state;
}

// Four stubs and nothing more: `chrome`, `sessionStorage`, `location` and `ConfirmDialog`. The rest
// are recorders the rows assert ON — a status line, a repaint, the theme carried across a wipe — not
// stand-ins for behaviour the module owns.
function load(opts = {}) {
  const o = {
    settings: { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1' },
    hostSettings: { 'a.io': { baseUrl: 'https://a.io' }, 'b.io': { baseUrl: 'https://b.io' } },
    hostHistory: ['a.io', 'b.io'],
    baseUrl: '',          // #set-baseurl — empty means "the instance the panel is on"
    hasChrome: true,
    runtime: true,        // false — a chrome whose runtime cannot send
    sessionArea: true,    // false — an older Chrome with no storage.session at all
    confirm: true,
    reply: null,          // the worker's answer to EVIDENCE_WIPE
    theme: 'system',
    surface: 'sidepanel',
    fail: {},             // { set, remove, clear } — a storage op that rejects
    sessionSeed: {},
    sessionThrows: false,
    ...opts,
  };

  const doc = makeDocument([]);
  doc.body.append(el('input', { id: 'set-baseurl', value: o.baseUrl }));
  const order = [];
  const state = makeState(o, order);
  const store = fakeChrome();
  store.fails.set = o.fail.set || null;
  store.fails.remove = o.fail.remove || null;

  const calls = { status: [], confirms: [], sends: [], themeSet: [], surfaceSet: [], repaints: [] };
  const sess = { ...o.sessionSeed };
  const sessionStorage = o.sessionThrows ? {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  } : {
    getItem: (k) => (k in sess ? sess[k] : null),
    setItem: (k, v) => { sess[k] = String(v); },
    removeItem: (k) => { delete sess[k]; },
  };

  const localArea = {
    set: async (arg) => { order.push('local.set'); return store.chrome.storage.local.set(arg); },
    remove: async (arg) => {
      order.push(`local.remove(${[].concat(arg).join(',')})`);
      return store.chrome.storage.local.remove(arg);
    },
    clear: async () => {
      order.push('local.clear');
      if (o.fail.clear) throw o.fail.clear;
      for (const k of Object.keys(store.data)) delete store.data[k];
    },
  };
  const chromeStub = { storage: { local: localArea } };
  if (o.sessionArea) {
    chromeStub.storage.session = { clear: async () => { order.push('session.clear'); } };
  }
  if (o.runtime) {
    chromeStub.runtime = {
      sendMessage: (msg) => {
        order.push(`send:${msg.type}`);
        calls.sends.push(plain(msg));
        return o.reply ? o.reply(msg) : Promise.resolve({ ok: true });
      },
    };
  }

  const clock = fakeClock();
  const h = loadScreen('settings-erase', {
    exported: 'SettingsErase',
    document: doc, clock, store,
    globals: {
      state,
      hasChrome: o.hasChrome,
      chrome: chromeStub,
      sessionStorage,
      location: { reload: () => { order.push('reload'); } },
      $: (id) => doc.getElementById(id),
      hostOf,
      setStatusLine: (id, msg, cls = '') => {
        order.push(`status:${id}`);
        calls.status.push({ id, msg, cls });
      },
      ConfirmDialog: {
        ask: async (message, label) => {
          order.push('confirm');
          calls.confirms.push({ message, label });
          return o.confirm;
        },
      },
      Handoff: { decline: async () => { order.push('Handoff.decline'); } },
      Theme: {
        get: () => { order.push('Theme.get'); return o.theme; },
        set: async (v) => { order.push('Theme.set'); calls.themeSet.push(v); },
      },
      ViewMode: {
        mode: async () => { order.push('ViewMode.mode'); return o.surface; },
        setMode: async (v) => { order.push('ViewMode.setMode'); calls.surfaceSet.push(v); },
      },
      // settings.js's own four, reached only when the host forgotten is NOT the active one.
      setSettingsFields: () => { calls.repaints.push('setSettingsFields'); },
      populateHostHistory: () => { calls.repaints.push('populateHostHistory'); },
      updateTokenHelpLink: () => { calls.repaints.push('updateTokenHelpLink'); },
      syncTokenField: () => { calls.repaints.push('syncTokenField'); },
    },
  });

  return {
    erase: h.screen, doc, state, order, calls, store, clock, sess,
    field: () => doc.getElementById('set-baseurl'),
    stored: () => plain(store.data),
    lineOf: (id) => [...calls.status].reverse().find((s) => s.id === id) || null,
  };
}

// ---------- the order, which IS the promise ----------

test('#203 Forget on the active instance runs one fixed sequence: storage first, memory last', async () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1', handoff: true },
  });
  await h.erase.forget();
  assert.deepEqual(h.order, [
    'confirm',
    'state.booting=true',
    'send:EVIDENCE_WIPE',       // the recorder is stopped BEFORE either write
    'local.set',
    'local.remove(settings,session,offlineQueue)',
    'session.clear',
    'Handoff.decline',
    'state.hostSettings',       // and only now does anything in memory move
    'state.hostHistory',
    'state.settings=null',
    'reload',
  ]);
  assert.deepEqual(h.stored().hostSettings, { 'b.io': { baseUrl: 'https://b.io' } });
  assert.deepEqual(h.stored().hostHistory, ['b.io']);
});

test('#203 a storage write the browser refuses moves NOTHING in memory, and unquiets the writer', async () => {
  for (const fail of [{ set: new Error('quota exceeded') }, { remove: new Error('disk gone') }]) {
    const h = load({ fail });
    await h.erase.forget();
    // Two touches only, and they cancel out: booting up over the erase, then back down.
    assert.deepEqual(h.order.filter((s) => s.startsWith('state.')),
      ['state.booting=true', 'state.booting=false']);
    assert.equal(h.state.booting, false); // the session writer may run again
    assert.equal(h.state.settings.apiToken, 'tok-1');
    assert.deepEqual(plain(h.state.hostSettings), {
      'a.io': { baseUrl: 'https://a.io' }, 'b.io': { baseUrl: 'https://b.io' },
    });
    assert.deepEqual(plain(h.state.hostHistory), ['a.io', 'b.io']);
    assert.equal(h.order.includes('reload'), false);
    assert.match(h.lineOf('settings-forget-status').msg,
      /^Couldn't finish forgetting a\.io: .* — assume the data is still on this machine, try again$/);
  }
});

// `failed` is on the published surface with a default nobody in the repo reaches: both callers work
// out a statusId first. A default no row pins is one that drifts, and this one decides WHERE the
// tester is told the erase did not happen — on the Forget line, not somewhere they never look.
test('#203 an erase failure with no line named goes to the Forget line, the default nobody exercises', () => {
  const h = load();
  h.erase.failed('forgetting a.io', new Error('disk gone'));
  assert.equal(h.lineOf('signout-status'), null);
  assert.match(h.lineOf('settings-forget-status').msg,
    /^Couldn't finish forgetting a\.io: disk gone — assume the data is still on this machine, try again$/);
  assert.equal(h.lineOf('settings-forget-status').cls, 'error');
});

test('#203 HOST_SCOPED_KEYS is exactly the three keys, and exactly what a Forget removes', async () => {
  const h = load();
  assert.deepEqual(plain(h.erase.HOST_SCOPED_KEYS), KEYS);
  await h.erase.forget();
  const removed = h.store.ops('local', 'remove');
  assert.equal(removed.length, 1);
  assert.deepEqual(plain(removed[0].arg), KEYS); // `offlineQueue`: the queued results go too
});

test('#203 forgetting an instance we are not on writes storage, then repaints — and reloads nothing', async () => {
  const h = load({ baseUrl: 'https://b.io' });
  await h.erase.forget();
  assert.deepEqual(h.order, ['confirm', 'local.set', 'state.hostSettings', 'state.hostHistory',
    'status:settings-forget-status']);
  assert.deepEqual(h.calls.repaints,
    ['setSettingsFields', 'populateHostHistory', 'updateTokenHelpLink', 'syncTokenField']);
  assert.deepEqual(h.lineOf('settings-forget-status'),
    { id: 'settings-forget-status', msg: 'b.io forgotten', cls: 'ok' });
  // Nothing session-scoped is touched: it belongs to the instance still in use.
  assert.equal(h.store.ops('local', 'remove').length, 0);
});

// ---------- what the tester is asked before any of it happens ----------

test('#203 only the active instance promises the queued results and the recording as well', async () => {
  const on = load({ confirm: false });
  await on.erase.forget();
  assert.equal(on.calls.confirms[0].label, 'Forget');
  assert.match(on.calls.confirms[0].message, /any queued results still waiting to be sent/);
  assert.match(on.calls.confirms[0].message, /a running recording is stopped for you/);

  const off = load({ confirm: false, baseUrl: 'https://b.io' });
  await off.erase.forget();
  assert.equal(/queued results/.test(off.calls.confirms[0].message), false);
  assert.equal(/running recording/.test(off.calls.confirms[0].message), false);
  // A No is the whole answer: nothing is written, nothing moves.
  assert.deepEqual(off.order, ['confirm']);
});

test('#203 Disconnect targets the instance the panel is ON, whatever the field shows', async () => {
  const h = load({ baseUrl: 'https://b.io', confirm: false });
  await h.erase.disconnect();
  assert.equal(h.calls.confirms[0].label, 'Disconnect');
  assert.match(h.calls.confirms[0].message, /^Disconnect a\.io\?/);
  // …and it reports on the caller's line, which is the point of the option.
  const pick = load({ settings: null, hostSettings: {}, baseUrl: 'https://z.io' });
  await pick.erase.disconnect({ statusId: 'pick-status' });
  assert.deepEqual(pick.lineOf('pick-status'),
    { id: 'pick-status', msg: 'Nothing saved for z.io', cls: 'error' });
  assert.equal(pick.lineOf('connection-status'), null);
});

// ---------- which host a destructive button is aimed at ----------

test('#203 a half-typed instance targets NOTHING — a destructive control never retargets itself', async () => {
  const h = load({ baseUrl: 'nonsense' });
  assert.equal(h.erase.formHost(), null);
  await h.erase.forget();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status',
    msg: '"nonsense" is not a valid instance URL — nothing was forgotten',
    cls: 'error',
  });
  assert.deepEqual(h.order, ['status:settings-forget-status']); // not even a confirm
});

test('#203 an empty field means the active instance, and with none it means nothing at all', () => {
  assert.equal(load({ baseUrl: '   ' }).erase.formHost(), 'a.io');
  assert.equal(load({ baseUrl: '', settings: null }).erase.formHost(), null);
  assert.equal(load({ baseUrl: 'https://b.io' }).erase.formHost(), 'b.io');
});

// ---------- the recorder stop ----------

test('#203 the recorder wipe: a clean ok resolves, a refusal carries its own reason up', async () => {
  await load({ reply: async () => ({ ok: true }) }).erase.wipeRecording();
  const busy = load({ reply: async () => ({ ok: false, error: 'busy' }) });
  assert.equal((await rejection(busy.erase.wipeRecording())).message, 'busy');
  // A refusal with no reason, and the STRING 'true', which is not an ok — both fail loudly rather
  // than passing for a wipe that never happened.
  for (const reply of [async () => ({ ok: false }), async () => null, async () => ({ ok: 'true' })]) {
    const h = load({ reply });
    assert.equal((await rejection(h.erase.wipeRecording())).message,
      'the recorder could not be stopped');
  }
});

test('#203 no worker to answer is no recording to stop; any other messaging failure is a failure', async () => {
  for (const why of ['Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received: receiving end']) {
    await load({ reply: async () => { throw new Error(why); } }).erase.wipeRecording();
  }
  const dead = load({ reply: async () => { throw new Error('extension context invalidated'); } });
  assert.equal((await rejection(dead.erase.wipeRecording())).message,
    'extension context invalidated');
});

test('#203 a recorder that never answers FAILS at five seconds — a timeout is not a wipe', async () => {
  const h = load({ reply: () => new Promise(() => {}) });
  const p = rejection(h.erase.wipeRecording());
  await settle();
  assert.deepEqual(h.clock.arms(), [5000]); // the number the promise is worth
  await h.clock.tick();
  assert.equal((await p).message, 'the recorder did not answer in 5s');
});

test('#203 a recorder that will not stop does not hold up the erase — the warning rides the reload', async () => {
  const h = load({ reply: async () => ({ ok: false, error: 'busy' }) });
  await h.erase.forget();
  assert.equal(h.order.includes('reload'), true);
  assert.equal(h.state.settings, null);
  assert.equal(h.sess[WARN_KEY],
    'Instance forgotten — but the console & network recording could not be stopped: busy. '
    + 'Assume its log is still on this machine until you restart the browser.');
  assert.deepEqual(h.calls.status, []); // the doomed document prints nothing
});

// ---------- sign out ----------

test('#203 Sign out reads theme and surface BEFORE the clear, and writes them back after', async () => {
  const h = load({ theme: 'dark', surface: 'tab' });
  await h.erase.signOut();
  assert.deepEqual(h.order, [
    'confirm',
    'state.booting=true',
    'send:EVIDENCE_WIPE',
    'Theme.get',       // both reads stand ahead of the clear, or they read the wiped store
    'ViewMode.mode',
    'local.clear',
    'session.clear',
    'Theme.set',
    'ViewMode.setMode',
    'state.settings=null',
    'reload',
  ]);
  assert.deepEqual(h.calls.themeSet, ['dark']);
  assert.deepEqual(h.calls.surfaceSet, ['tab']);
  assert.deepEqual(h.stored(), {});
});

test('#203 Sign out writes back neither default — nothing to carry across means nothing restored', async () => {
  const h = load({ theme: 'system', surface: 'sidepanel' });
  await h.erase.signOut();
  assert.deepEqual(h.calls.themeSet, []);
  assert.deepEqual(h.calls.surfaceSet, []);
  assert.equal(h.order.includes('reload'), true);
});

test('#203 a clear that is refused aborts on Sign out\'s OWN line, with every token still in place', async () => {
  const h = load({ fail: { clear: new Error('storage locked') } });
  await h.erase.signOut();
  assert.deepEqual(h.lineOf('signout-status'), {
    id: 'signout-status',
    msg: "Couldn't finish signing out: storage locked — assume the data is still on this machine, try again",
    cls: 'error',
  });
  assert.equal(h.lineOf('settings-forget-status'), null);
  assert.equal(h.state.settings.apiToken, 'tok-1');
  assert.equal(h.state.booting, false);
  assert.equal(h.order.includes('reload'), false);
});

// ---------- the warning the next panel picks up ----------

test('#203 the warning an erase left behind is printed once and then really gone', () => {
  const h = load({ sessionSeed: { [WARN_KEY]: 'Signed out — but the recorder could not be stopped' } });
  h.erase.takeWarning();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status',
    msg: 'Signed out — but the recorder could not be stopped',
    cls: 'error',
  });
  assert.equal(h.sess[WARN_KEY], undefined); // removed, not merely read
  h.calls.status.length = 0;
  h.erase.takeWarning(); // a second entry into Settings says nothing
  assert.deepEqual(h.calls.status, []);
});

test('#203 a browser that refuses sessionStorage neither throws nor invents a warning', () => {
  const h = load({ sessionThrows: true });
  h.erase.takeWarning();
  assert.deepEqual(h.calls.status, []);
  h.erase.leaveWarning(new Error('busy'), 'Signed out'); // the write side, same guarantee
});
