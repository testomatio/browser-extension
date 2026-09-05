#!/usr/bin/env node
// What extension/sidepanel/screens/settings.js does for the tester (#187): this is where they paste a
// token, point the extension at their Testomat instance, set the recording preferences — and, at the
// bottom, erase it all again. Saving is not a write: the token is checked against the real server
// first, and the refusal is spelled out in the tester's own words with the Advanced fold opened for
// them when the problem is down there.
// Two things here are expensive to get wrong. The save gauntlet must never store a credential the
// server refused, and it must never leave the previous host's project slugs in the switcher. And the
// three erase paths — Forget, Disconnect, Sign out — make a promise the tester has to be able to
// trust: STORAGE IS WRITTEN FIRST and the in-memory copy follows only on success, so a rejected write
// leaves the panel unchanged instead of half-erased. That ordering, not the end state, is the
// contract, so the rows below assert the whole sequence; a test that only reads the final storage
// cannot tell a correct order from a lucky one. `HOST_SCOPED_KEYS` is the other half of the promise —
// it is what stops a Forget leaving the tester's queued results behind on the machine.
// Rows 1-75 are the ticket's; a lettered suffix is the companion case that drives the same path the
// other way, so a row asserting "nothing happened" cannot pass against a stub that never worked.
// Run: node --test tests/settings.test.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadScreen, fakeChrome, fakeClock, makeDocument, el, fire, plain, settle, rejection,
  ApiError, SCREENS_SRC, CORE_SRC,
} from './helpers/panel-harness.mjs';

// The REAL toggle readers, not look-alikes: "absent -> ON" for three of them and "absent -> OFF" for
// the other two is the whole of rows 4-6, and a hand-written stub would let the form's defaults pass
// against a rule the panel does not have. SCREENS_SRC / CORE_SRC keep a falsification run pointed at
// its mutated copy.
const fromSource = (path, names) => runInNewContext(
  `${readFileSync(path, 'utf8')}\n({ ${names.join(', ')} });`, { URL },
);
const { envInfoEnabled, envFullUrlEnabled } = fromSource(
  join(CORE_SRC, 'env-info.js'), ['envInfoEnabled', 'envFullUrlEnabled'],
);
const { hostOf, isReadonlyError } = fromSource(
  join(CORE_SRC, 'state.js'), ['hostOf', 'isReadonlyError'],
);
const {
  evidenceAutoStartEnabled, evidenceAutoAttachEnabled, evidenceCaptureBodiesEnabled,
} = fromSource(join(SCREENS_SRC, 'evidence.js'),
  ['evidenceAutoStartEnabled', 'evidenceAutoAttachEnabled', 'evidenceCaptureBodiesEnabled']);

const DEFAULT = 'https://app.testomat.io';
const WARN_KEY = 'signOutRecorderWarning';
const REQUIRED = 'Instance and access token are required';
const NOT_HTTPS = 'Instance URL must be https://';
const NOT_URL = 'Instance is not a valid URL';
const BAD_WINDOW = 'Log window must be between 10 and 600 seconds';

// index.html's accordion, in its own order; the first two are open there, the rest folded.
const SECTIONS = ['connection', 'failure', 'recorder', 'appearance', 'advanced', 'credentials'];
const OPEN = new Set(['connection', 'failure']);

const camel = (id) => id.replace(/-(\w)/g, (_, c) => c.toUpperCase());

// index.html's shape, cut to the nodes this screen touches. The heads really are buttons inside an
// <h3 class="settings-section-title"> wrapping an icon span, because the delegate matches on that
// exact descent and a flatter fixture would let row 16 pass against a selector that never matches.
function makePage(o) {
  const doc = makeDocument([]);
  const node = {};
  const mk = (tag, id, props = {}) => {
    const n = el(tag, { id, ...props });
    node[camel(id)] = n;
    return n;
  };

  const view = mk('section', 'view-settings');
  doc.body.append(view);
  view.append(mk('div', 'connect-hero', { hidden: true }));

  const group = mk('div', 'settings-sections', { className: 'accordion' });
  view.append(group);
  const body = {};
  for (const name of SECTIONS) {
    const item = el('div', { className: 'disclosure accordion-item' });
    const title = el('h3', { className: 'settings-section-title' });
    const head = mk('button', `settings-${name}-head`, { className: 'disclosure-head' });
    head.setAttribute('aria-expanded', OPEN.has(name) ? 'true' : 'false');
    head.setAttribute('aria-controls', `settings-${name}-body`);
    // The chevron the tester's click actually lands on — `closest` is what turns it into the head.
    node[`${camel(name)}Icon`] = el('span', { className: 'md-icon' });
    head.append(node[`${camel(name)}Icon`]);
    title.append(head);
    body[name] = mk('div', `settings-${name}-body`, { hidden: !OPEN.has(name) });
    item.append(title, body[name]);
    group.append(item);
  }

  const card = mk('div', 'connection-card', { hidden: true });
  card.append(mk('p', 'connection-host'), mk('span', 'connection-state', {
    className: 'badge passed connection-state',
  }), mk('button', 'btn-disconnect'));
  body.connection.append(
    card,
    mk('p', 'connection-source', { hidden: true }),
    mk('p', 'connection-status'),
    mk('a', 'token-authorize-link', { href: '' }),
    mk('input', 'set-token', { type: 'password', value: o.token }),
    mk('a', 'token-help-link', { href: '' }),
  );

  body.failure.append(
    mk('input', 'set-evidence-autostart', { type: 'checkbox', checked: false }),
    mk('input', 'set-evidence-autoattach', { type: 'checkbox', checked: true }),
    mk('input', 'set-evidence-bodies', { type: 'checkbox', checked: true }),
    mk('input', 'set-evidence-window', { type: 'number', value: o.window }),
    mk('input', 'set-env-info', { type: 'checkbox', checked: true }),
    mk('input', 'set-env-full-url', { type: 'checkbox', checked: false }),
  );
  body.recorder.append(mk('input', 'set-rec-never-values', { type: 'checkbox', checked: false }));

  const themes = mk('div', 'theme-switch');
  for (const mode of ['system', 'light', 'dark']) {
    const b = el('button', { className: 'segment', dataset: { themeMode: mode } });
    b.setAttribute('aria-pressed', mode === 'system' ? 'true' : 'false');
    node[`theme${mode[0].toUpperCase()}${mode.slice(1)}`] = b;
    themes.append(b);
  }
  body.appearance.append(themes);

  body.advanced.append(
    mk('div', 'set-host-history-mount'),
    mk('input', 'set-baseurl', { type: 'url', value: o.baseUrl }),
    mk('button', 'btn-forget-instance'),
    mk('p', 'settings-forget-status'),
  );
  body.credentials.append(mk('button', 'btn-sign-out'), mk('p', 'signout-status'));
  view.append(mk('button', 'btn-save-settings', { textContent: 'Save & validate' }),
    mk('p', 'settings-status'));

  for (const id of o.without) {
    const n = doc.getElementById(id);
    if (n) n.remove();
  }
  return { doc, node };
}

// `state` is an ACCESSOR bag, not a plain object: the erase paths' whole safety property is that
// storage is written before any of these four is touched, and only a recorded write can show that.
function makeState(o, order) {
  const bag = {
    view: o.view,
    settings: o.settings,
    hostSettings: o.hostSettings,
    hostHistory: o.hostHistory,
    projects: o.projects,
    booting: o.booting,
  };
  const label = (k, v) => {
    if (k === 'booting') return `state.booting=${v}`;
    if (k === 'settings' && v === null) return 'state.settings=null';
    return `state.${k}`;
  };
  const state = {};
  for (const k of Object.keys(bag)) {
    Object.defineProperty(state, k, {
      enumerable: true,
      get: () => bag[k],
      set: (v) => { bag[k] = v; order.push(label(k, v)); },
    });
  }
  return state;
}

// The panel globals settings.js reads, all of them real enough to be driven. They live here and not
// in the harness: every screen has its own set.
function load(opts = {}) {
  const o = {
    view: 'settings',
    settings: null,        // state.settings — null is "never saved", the connect screen
    hostSettings: {},
    hostHistory: [],
    projects: [],
    booting: false,
    hasChrome: true,
    runtime: true,         // false — a chrome whose runtime cannot send
    sessionArea: true,     // false — an older Chrome with no storage.session at all
    baseUrl: DEFAULT,      // what #set-baseurl carries before anything runs
    token: '',
    window: '',            // #set-evidence-window
    without: [],           // ids to leave out of the page
    dropdown: true,        // false — no Dropdown mounted, so populateHostHistory bails
    confirm: true,         // what ConfirmDialog.ask answers
    projectList: null,     // (): projects, or a throw — TestomatAPI.listProjects
    validate: null,        // (): void, or a throw — TestomatAPI.validate
    reply: null,           // the worker's answer to EVIDENCE_WIPE
    theme: 'system',
    surface: 'sidepanel',
    offer: null,           // Handoff.offer()
    onboarding: false,     // load the REAL screens/onboarding.js beside this one
    sessionSeed: {},
    sessionThrows: false,
    fail: {},              // { set, remove, clear, sessionClear } — a storage op that rejects
    ...opts,
  };

  const { doc, node } = makePage(o);
  const order = [];
  const state = makeState(o, order);
  const store = fakeChrome();
  store.fails.set = o.fail.set || null;
  store.fails.remove = o.fail.remove || null;

  const calls = {
    order,
    lookups: [],       // every id `$` was asked for — how "render() ran" is seen without a stub
    status: [],        // setStatusLine(id, msg, cls)
    toasts: [],
    confirms: [],
    configured: [],    // Handoff.configure, both legs of the two-step validation
    sends: [],
    themeSet: [],
    surfaceSet: [],
    setOptions: [],
    listProjects: 0,
    validate: 0,
    declines: 0,
    reloads: 0,
    projectBar: 0,
    runsView: 0,
    askProject: 0,
    reset: 0,
    onboardingRender: 0,
    themeListeners: [],
  };

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
    get: store.chrome.storage.local.get,
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
    chromeStub.storage.session = {
      clear: async () => { order.push('session.clear'); if (o.fail.sessionClear) throw o.fail.sessionClear; },
    };
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

  // The shared Dropdown's surface, cut to the four members this screen touches. `of` answers nothing
  // until `create` has run, or initHostHistoryDropdown bails and rows 7-8 pass for the wrong reason.
  const registry = new Map();
  const Dropdown = {
    of: (id) => registry.get(id),
    create: (spec) => {
      const dd = {
        spec,
        hidden: false,
        options: null,
        value: undefined,
        el: el('div', { className: spec.className }),
        setOptions: (options, pick = {}) => {
          dd.options = options;
          dd.value = pick.value;
          calls.setOptions.push({ options: plain(options), value: pick.value });
        },
      };
      registry.set(spec.id, dd);
      return dd;
    },
  };

  const globals = {
    state,
    hasChrome: o.hasChrome,
    chrome: chromeStub,
    sessionStorage,
    location: { reload: () => { order.push('reload'); calls.reloads += 1; } },
    $: (id) => { calls.lookups.push(id); return doc.getElementById(id); },
    hostOf,
    isReadonlyError,
    envInfoEnabled,
    envFullUrlEnabled,
    evidenceAutoStartEnabled,
    evidenceAutoAttachEnabled,
    evidenceCaptureBodiesEnabled,
    Dropdown,
    setStatusLine: (id, msg, cls = '') => {
      order.push(`status:${id}`);
      calls.status.push({ id, msg, cls });
    },
    progressToast: (msg) => { calls.toasts.push(msg); },
    ConfirmDialog: {
      ask: async (message, label) => {
        order.push('confirm');
        calls.confirms.push({ message, label });
        return o.confirm;
      },
    },
    // core/state.js's own rule, and shared/handoff.js's: a handed-over connection is credentialed
    // without a token of the tester's own.
    Handoff: {
      credentialed: (s) => !!(s && s.baseUrl && (s.apiToken || s.handoff)),
      configure: (s) => { calls.configured.push(plain(s)); },
      offer: () => o.offer,
      decline: async () => { order.push('Handoff.decline'); calls.declines += 1; },
    },
    TestomatAPI: {
      listProjects: async () => {
        order.push('listProjects');
        calls.listProjects += 1;
        return o.projectList ? o.projectList() : [];
      },
      validate: async () => {
        order.push('validate');
        calls.validate += 1;
        if (o.validate) return o.validate();
        return undefined;
      },
    },
    Theme: {
      get: () => { order.push('Theme.get'); return o.theme; },
      set: async (v) => { order.push('Theme.set'); calls.themeSet.push(v); },
      onChange: (fn) => { calls.themeListeners.push(fn); },
    },
    ViewMode: {
      mode: async () => { order.push('ViewMode.mode'); return o.surface; },
      setMode: async (v) => { order.push('ViewMode.setMode'); calls.surfaceSet.push(v); },
    },
    resetProjectScopedState: () => { order.push('resetProjectScopedState'); calls.reset += 1; },
    renderProjectBar: () => { order.push('renderProjectBar'); calls.projectBar += 1; },
    openRunsView: () => { order.push('openRunsView'); calls.runsView += 1; },
    askForProject: () => { order.push('askForProject'); calls.askProject += 1; },
  };
  if (o.onboardingStub) globals.Onboarding = { render: () => { calls.onboardingRender += 1; } };

  const clock = fakeClock();
  const h = loadScreen('settings', {
    // The welcome checklist is reached through a `typeof` guard, so the REAL screen is what row 75
    // drives — a stub could not show that it renders nothing.
    before: o.onboarding ? ['onboarding'] : [],
    exported: '({ HOST_SCOPED_KEYS, DEFAULT_BASE_URL, AUTH_APP_NAME, EVIDENCE_WIPE_MS, EVIDENCE_WIPE_WARN_KEY })',
    document: doc, clock, store, globals,
  });
  if (o.dropdown) h.fn.initHostHistoryDropdown();

  return {
    ...h,
    doc, node, state, calls, order, store, clock, sess, Dropdown,
    dd: registry.get('set-host-history'),
    // The tester typing into the form before pressing Save.
    fill: (over = {}) => {
      const map = {
        baseUrl: 'setBaseurl', token: 'setToken', window: 'setEvidenceWindow',
      };
      for (const [k, id] of Object.entries(map)) if (k in over) node[id].value = over[k];
      const checks = {
        envInfo: 'setEnvInfo', envFullUrl: 'setEnvFullUrl', autostart: 'setEvidenceAutostart',
        autoattach: 'setEvidenceAutoattach', bodies: 'setEvidenceBodies',
        neverValues: 'setRecNeverValues',
      };
      for (const [k, id] of Object.entries(checks)) if (k in over) node[id].checked = over[k];
    },
    toggles: () => ({
      envInfo: node.setEnvInfo.checked,
      envFullUrl: node.setEnvFullUrl.checked,
      autostart: node.setEvidenceAutostart.checked,
      autoattach: node.setEvidenceAutoattach.checked,
      bodies: node.setEvidenceBodies.checked,
      neverValues: node.setRecNeverValues.checked,
    }),
    // The last thing written to one status line, which is what the tester is left looking at.
    lineOf: (id) => [...calls.status].reverse().find((s) => s.id === id) || null,
    stored: () => plain(store.data),
    // Every key the save actually persisted, which is the whole of row 51.
    written: () => store.ops('local', 'set').map((c) => Object.keys(c.arg).sort()),
  };
}

const OK_SAVE = { baseUrl: 'https://a.io', token: 'tok-1' };

// A configured panel: the token is in, the project is picked, the host is remembered.
const CONFIGURED = {
  settings: { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1' },
  hostSettings: { 'a.io': { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1' } },
  hostHistory: ['a.io'],
  baseUrl: 'https://a.io',
};

// ============================================================================
// The form, the history dropdown and the folds (rows 1-17)
// ============================================================================

test('1: the token-help link follows the origin of what is being typed, path and all dropped', () => {
  const h = load({ baseUrl: 'https://a.io/x/' });
  assert.equal(h.fn.tokenHelpBase(), 'https://a.io');
  h.fill({ baseUrl: '  https://self.host:8443/sub/  ' });
  assert.equal(h.fn.tokenHelpBase(), 'https://self.host:8443');
});

test('2: an empty or unparsable Instance field falls back to app.testomat.io', () => {
  const h = load({ baseUrl: '' });
  assert.equal(h.fn.tokenHelpBase(), DEFAULT);
  h.fill({ baseUrl: 'not a url' });
  assert.equal(h.fn.tokenHelpBase(), DEFAULT);
  h.fill({ baseUrl: '///' }); // trailing slashes stripped down to nothing
  assert.equal(h.fn.tokenHelpBase(), DEFAULT);
  assert.equal(h.screen.DEFAULT_BASE_URL, DEFAULT);
});

test('2a: the field, not the saved config, is what the help link tracks', () => {
  const h = load({ ...CONFIGURED, baseUrl: 'https://typing.io' });
  assert.equal(h.fn.tokenHelpBase(), 'https://typing.io');
});

test('3: both token links are repointed at the instance in the field', () => {
  const h = load({ baseUrl: 'https://self.host' });
  h.fn.updateTokenHelpLink();
  assert.equal(h.node.tokenHelpLink.href, 'https://self.host/account/access_tokens');
  assert.equal(h.node.tokenAuthorizeLink.href,
    'https://self.host/app-auth?app_name=Testomat.io%20Extension');
  assert.equal(h.screen.AUTH_APP_NAME, 'Testomat.io Extension');
});

test('3a: a page without the two links is repointed without throwing', () => {
  const h = load({ without: ['token-help-link', 'token-authorize-link'] });
  h.fn.updateTokenHelpLink();
  assert.equal(h.node.tokenHelpLink.href, ''); // detached, so nothing was written to it
});

test('4: an empty config paints the default instance and the seven toggle defaults', () => {
  const h = load({ baseUrl: 'https://stale.io', token: 'stale', window: '99' });
  h.fill({ envInfo: false, autoattach: false, bodies: false, neverValues: true, autostart: true });
  h.fn.setSettingsFields({});
  assert.equal(h.node.setBaseurl.value, DEFAULT);
  assert.equal(h.node.setToken.value, '');
  assert.equal(h.node.setEvidenceWindow.value, '');
  assert.deepEqual(h.toggles(), {
    envInfo: true, envFullUrl: false, autostart: false,
    autoattach: true, bodies: true, neverValues: false,
  });
});

test('5: no config at all paints exactly what an empty one does', () => {
  const h = load({ baseUrl: 'https://stale.io', token: 'stale' });
  h.fn.setSettingsFields(undefined);
  assert.equal(h.node.setBaseurl.value, DEFAULT);
  assert.equal(h.node.setToken.value, '');
  assert.deepEqual(h.toggles(), {
    envInfo: true, envFullUrl: false, autostart: false,
    autoattach: true, bodies: true, neverValues: false,
  });
});

test('5a: a saved config paints back every value the tester chose, off ones included', () => {
  const h = load();
  h.fn.setSettingsFields({
    baseUrl: 'https://self.host', apiToken: 'tok-9', evidenceWindowSec: 120,
    envInfoOnFail: false, envFullUrl: true, evidenceAutoStart: true,
    evidenceAutoAttach: false, evidenceCaptureBodies: false, stepRecNeverValues: true,
  });
  assert.equal(h.node.setBaseurl.value, 'https://self.host');
  assert.equal(h.node.setToken.value, 'tok-9');
  assert.equal(h.node.setEvidenceWindow.value, 120);
  assert.deepEqual(h.toggles(), {
    envInfo: false, envFullUrl: true, autostart: true,
    autoattach: false, bodies: false, neverValues: true,
  });
});

test('5b: a stored window of 0 is a value, not an absence — it is not swapped for the blank', () => {
  const h = load();
  h.fn.setSettingsFields({ evidenceWindowSec: 0 });
  assert.equal(h.node.setEvidenceWindow.value, 0);
});

test('6: only an explicit true switches "never record entered values" on', () => {
  const h = load();
  assert.equal(h.fn.stepRecNeverValuesEnabled({ stepRecNeverValues: 'true' }), false);
  assert.equal(h.fn.stepRecNeverValuesEnabled({ stepRecNeverValues: 1 }), false);
  assert.equal(h.fn.stepRecNeverValuesEnabled({ stepRecNeverValues: true }), true);
  assert.equal(h.fn.stepRecNeverValuesEnabled({}), false);
  assert.equal(h.fn.stepRecNeverValuesEnabled(undefined), false);
});

test('7: one instance is nothing to choose between, so the history control is emptied and hidden', () => {
  const h = load({ hostHistory: ['a.io'] });
  h.fn.populateHostHistory();
  assert.deepEqual(plain(h.dd.options), []);
  assert.equal(h.dd.hidden, true);
});

test('7a: with no history at all the control is still emptied rather than left showing yesterday', () => {
  const h = load({ hostHistory: [] });
  h.dd.hidden = false;
  h.fn.populateHostHistory();
  assert.deepEqual(plain(h.dd.options), []);
  assert.equal(h.dd.hidden, true);
});

test('7b: a page that never mounted the control is populated without throwing', () => {
  const h = load({ dropdown: false, hostHistory: ['a.io', 'b.io'] });
  h.fn.populateHostHistory();
  assert.equal(h.calls.setOptions.length, 0);
});

test('8: three instances are offered in history order, with the one in the field preselected', () => {
  const h = load({ hostHistory: ['a.io', 'b.io', 'c.io'], baseUrl: 'https://b.io' });
  h.fn.populateHostHistory();
  assert.equal(h.dd.hidden, false);
  assert.deepEqual(plain(h.dd.options), [
    { value: 'a.io', label: 'a.io' },
    { value: 'b.io', label: 'b.io' },
    { value: 'c.io', label: 'c.io' },
  ]);
  assert.equal(h.dd.value, 'b.io');
});

test('8a: a blank field falls back to the saved instance for the preselection', () => {
  const h = load({ hostHistory: ['a.io', 'b.io'], baseUrl: '', settings: { baseUrl: 'https://b.io' } });
  h.fn.populateHostHistory();
  assert.equal(h.dd.value, 'b.io');
});

test('9: picking a saved instance refills the whole form from what was stored for it', () => {
  const h = load({
    ...CONFIGURED,
    hostSettings: {
      'a.io': { baseUrl: 'https://a.io', apiToken: 'tok-1' },
      'b.io': { baseUrl: 'https://b.io', apiToken: 'tok-b', evidenceWindowSec: 30, envFullUrl: true },
    },
  });
  h.fn.onInstanceHostPicked('b.io');
  assert.equal(h.node.setBaseurl.value, 'https://b.io');
  assert.equal(h.node.setToken.value, 'tok-b');
  assert.equal(h.node.setEvidenceWindow.value, 30);
  assert.equal(h.node.setEnvFullUrl.checked, true);
  assert.equal(h.node.tokenHelpLink.href, 'https://b.io/account/access_tokens');
  assert.equal(h.node.viewSettings.dataset.token, 'off'); // a host we hold a token for
});

test('10: picking an instance we hold nothing for resets the form and brings the token box back', () => {
  const h = load({ ...CONFIGURED, hostHistory: ['a.io', 'c.io'] });
  h.fn.onInstanceHostPicked('c.io');
  assert.equal(h.node.setBaseurl.value, 'https://c.io');
  assert.equal(h.node.setToken.value, '');
  assert.deepEqual(h.toggles(), {
    envInfo: true, envFullUrl: false, autostart: false,
    autoattach: true, bodies: true, neverValues: false,
  });
  assert.equal(h.node.viewSettings.dataset.token, 'on');
});

test('11: an empty pick changes nothing — the form keeps what the tester was typing', () => {
  const h = load({ ...CONFIGURED, baseUrl: 'https://typing.io' });
  h.fn.onInstanceHostPicked('');
  h.fn.onInstanceHostPicked(undefined);
  assert.equal(h.node.setBaseurl.value, 'https://typing.io');
  assert.equal(h.node.viewSettings.dataset.token, undefined); // syncTokenField never ran
});

test('12: the token box stays away for an instance we already hold a token for', () => {
  const h = load({ ...CONFIGURED, baseUrl: 'https://a.io' });
  h.fn.syncTokenField();
  assert.equal(h.node.viewSettings.dataset.token, 'off');
  // …and for the ACTIVE instance even when the per-host map has no row of its own.
  const bare = load({ settings: { baseUrl: 'https://a.io', apiToken: 't' }, baseUrl: 'https://a.io' });
  bare.fn.syncTokenField();
  assert.equal(bare.node.viewSettings.dataset.token, 'off');
});

test('13: the token box comes back for an instance we hold nothing for', () => {
  const h = load({ ...CONFIGURED, baseUrl: 'https://new.io' });
  h.fn.syncTokenField();
  assert.equal(h.node.viewSettings.dataset.token, 'on');
  // A field that parses to no host at all counts as unknown too.
  h.fill({ baseUrl: 'nonsense' });
  h.fn.syncTokenField();
  assert.equal(h.node.viewSettings.dataset.token, 'on');
});

test('13a: a page without the settings section syncs the token box without throwing', () => {
  const h = load({ without: ['view-settings'] });
  h.fn.syncTokenField();
  assert.equal(h.node.viewSettings.dataset.token, undefined);
});

test('14: a saved self-hosted instance opens Advanced, because that is where its field is', () => {
  const h = load({ settings: { baseUrl: 'https://self.host/' } });
  h.fn.syncSettingsAdvanced();
  assert.equal(h.node.settingsAdvancedHead.getAttribute('aria-expanded'), 'true');
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
});

test('15: the default instance, or nothing saved at all, leaves Advanced folded', () => {
  for (const settings of [{ baseUrl: DEFAULT }, { baseUrl: `${DEFAULT}/` }, { baseUrl: '' }, null]) {
    const h = load({ settings });
    h.fn.openSettingsAdvanced(); // opened by a previous failed save
    h.fn.syncSettingsAdvanced();
    assert.equal(h.node.settingsAdvancedHead.getAttribute('aria-expanded'), 'false');
    assert.equal(h.node.settingsAdvancedBody.hidden, true);
  }
});

test('15a: the Advanced fold is in-memory only and flips both ways', () => {
  const h = load();
  h.fn.toggleSettingsAdvanced();
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
  h.fn.toggleSettingsAdvanced();
  assert.equal(h.node.settingsAdvancedBody.hidden, true);
  h.fn.openSettingsAdvanced();
  h.fn.openSettingsAdvanced(); // opening an open fold is not a toggle
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
  assert.equal(h.store.ops('local', 'set').length, 0); // nothing persisted, by design
});

test('16: clicking a section head flips its arrow and its body together', () => {
  const h = load();
  h.fn.initSettingsSections();
  fire(h.node.settingsRecorderHead, 'click', { bubbles: true });
  assert.equal(h.node.settingsRecorderHead.getAttribute('aria-expanded'), 'true');
  assert.equal(h.node.settingsRecorderBody.hidden, false);
  fire(h.node.settingsRecorderHead, 'click', { bubbles: true });
  assert.equal(h.node.settingsRecorderHead.getAttribute('aria-expanded'), 'false');
  assert.equal(h.node.settingsRecorderBody.hidden, true);
});

test('16a: a click on the chevron inside the head still folds the section', () => {
  const h = load();
  h.fn.initSettingsSections();
  fire(h.node.recorderIcon, 'click', { bubbles: true });
  assert.equal(h.node.settingsRecorderBody.hidden, false);
});

test('16b: a click that is on no head at all folds nothing', () => {
  const h = load();
  h.fn.initSettingsSections();
  fire(h.node.setRecNeverValues, 'click', { bubbles: true });
  assert.equal(h.node.settingsRecorderBody.hidden, true);
  assert.equal(h.node.settingsConnectionBody.hidden, false);
});

test('17: Advanced is left to its own handler — the delegate does not touch it', () => {
  const h = load();
  h.fn.initSettingsSections();
  fire(h.node.settingsAdvancedHead, 'click', { bubbles: true });
  assert.equal(h.node.settingsAdvancedHead.getAttribute('aria-expanded'), 'false');
  assert.equal(h.node.settingsAdvancedBody.hidden, true);
});

test('17a: a page with no accordion wires nothing and throws nothing', () => {
  const h = load({ without: ['settings-sections'] });
  h.fn.initSettingsSections();
  assert.equal(h.doc.getElementById('settings-sections'), null);
});

// ---------- the theme control ----------

test('T1: the theme switch presses exactly the mode that is live', () => {
  const h = load({ theme: 'dark' });
  h.fn.paintThemeSwitch();
  assert.deepEqual(['system', 'light', 'dark'].map(
    (m) => h.node[`theme${m[0].toUpperCase()}${m.slice(1)}`].getAttribute('aria-pressed'),
  ), ['false', 'false', 'true']);
});

test('T2: clicking a segment sets that theme, and the switch repaints when it changes elsewhere', () => {
  const h = load({ theme: 'system' });
  h.fn.initThemeSwitch();
  assert.equal(h.node.themeSystem.getAttribute('aria-pressed'), 'true');
  fire(h.node.themeLight, 'click', { bubbles: true });
  assert.deepEqual(h.calls.themeSet, ['light']);
  assert.equal(h.calls.themeListeners.length, 1); // the editor tab's changes land here too
});

test('T2a: a click beside the segments sets no theme, and a page without the switch wires none', () => {
  const h = load();
  h.fn.initThemeSwitch();
  fire(h.node.themeSwitch, 'click', { bubbles: true });
  assert.deepEqual(h.calls.themeSet, []);
  const bare = load({ without: ['theme-switch'] });
  bare.fn.initThemeSwitch();
  bare.fn.paintThemeSwitch();
  assert.equal(bare.calls.themeListeners.length, 0);
});

// ============================================================================
// The two pure validators (rows 26-34)
// ============================================================================

test('26: a blank Log window means the 60-second default, not an error', () => {
  const h = load({ window: '' });
  assert.equal(h.fn.evidenceWindowFromField(), 60);
});

test('27: a Log window out of range or not a number is REFUSED, never silently rewritten', () => {
  const h = load();
  for (const raw of ['5', '9', '601', '9999', 'abc', '-30', '0', '1e9']) {
    h.fill({ window: raw });
    assert.equal(h.fn.evidenceWindowFromField(), null, `expected ${raw} to be refused`);
    assert.equal(h.node.setEvidenceWindow.value, raw); // the field keeps what was typed
  }
});

test('28: the 10 and 600 bounds are inclusive', () => {
  const h = load();
  h.fill({ window: '10' });
  assert.equal(h.fn.evidenceWindowFromField(), 10);
  h.fill({ window: '600' });
  assert.equal(h.fn.evidenceWindowFromField(), 600);
});

test('29: a fractional window rounds to the nearest second', () => {
  const h = load();
  h.fill({ window: '59.6' });
  assert.equal(h.fn.evidenceWindowFromField(), 60);
  h.fill({ window: '10.4' });
  assert.equal(h.fn.evidenceWindowFromField(), 10);
  h.fill({ window: '9.6' }); // rounds INTO range: 10 is a real value, not a clamp
  assert.equal(h.fn.evidenceWindowFromField(), 10);
});

test('30: spaces around the number are the tester pasting, not a bad value', () => {
  const h = load();
  h.fill({ window: '  120  ' });
  assert.equal(h.fn.evidenceWindowFromField(), 120);
  h.fill({ window: '   ' });
  assert.equal(h.fn.evidenceWindowFromField(), 60);
});

test('31: a previous project the token can still reach keeps the panel where it was', () => {
  const h = load();
  assert.equal(h.fn.resolveProjectId([{ id: 'a' }, { id: 'b' }], 'b'), 'b');
});

test('32: a lone project needs no choosing', () => {
  const h = load();
  assert.equal(h.fn.resolveProjectId([{ id: 'a' }], 'zz'), 'a');
  assert.equal(h.fn.resolveProjectId([{ id: 'a' }], ''), 'a');
});

test('33: several projects and no reachable previous one leave the pick to the tester', () => {
  const h = load();
  assert.equal(h.fn.resolveProjectId([{ id: 'a' }, { id: 'b' }], 'zz'), '');
  assert.equal(h.fn.resolveProjectId([{ id: 'a' }, { id: 'b' }], ''), '');
});

test('34: no projects resolve to no project', () => {
  const h = load();
  assert.equal(h.fn.resolveProjectId([], 'a'), '');
});
