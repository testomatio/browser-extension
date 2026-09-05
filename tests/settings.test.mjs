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

// ============================================================================
// Connect mode and the three handoff sentences (rows 18-25)
// ============================================================================

test('18: a credentialed instance with a project reads Connected on a ready card', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 't', projectId: 'p1' } });
  h.fn.renderConnection();
  assert.equal(h.node.connectionCard.hidden, false);
  assert.equal(h.node.connectionCard.dataset.state, 'ready');
  assert.equal(h.node.connectionHost.textContent, 'a.io');
  assert.equal(h.node.connectionState.textContent, 'Connected');
  assert.equal(h.node.connectionState.className, 'badge passed connection-state');
});

test('19: credentialed with no project yet is a half-done first run, and the pill says so', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 't', projectId: '' } });
  h.fn.renderConnection();
  assert.equal(h.node.connectionCard.hidden, false);
  assert.equal(h.node.connectionCard.dataset.state, 'pending');
  assert.equal(h.node.connectionState.textContent, 'Project not picked');
  assert.equal(h.node.connectionState.className, 'badge neutral connection-state');
});

test('19a: nothing saved hides the card, and nothing else on it is repainted', () => {
  const h = load({ settings: null });
  h.fn.renderConnection();
  assert.equal(h.node.connectionCard.hidden, true);
  assert.equal(h.node.connectionHost.textContent, '');
  assert.equal(h.node.connectionSource.hidden, true);
});

test('19b: a page without the connection card renders it without throwing', () => {
  const h = load({ without: ['connection-card'], settings: { baseUrl: 'https://a.io', apiToken: 't' } });
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.hidden, true); // renderConnectionSource never ran either
});

test('20: a live handoff says whose sign-in it is and what Disconnect costs', () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', handoff: true, handoffApp: 'Runner CLI', projectId: 'p1' },
    offer: { app: 'Runner CLI' },
  });
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.hidden, false);
  assert.equal(h.node.connectionSource.textContent,
    'Signed in by Runner CLI. Disconnect stops it signing you in again — '
    + 'open the run from there to come back.');
});

test('21: once the offer is gone, a tester with a token of their own is told it still works', () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', handoff: true, handoffApp: 'runner CLI', apiToken: 'mine' },
    offer: null,
  });
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.textContent,
    'Runner CLI has closed its session. Everything now uses your own sign-in.');
});

test('22: with the offer gone and no token of their own, the tester is pointed at Authorize', () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', handoff: true, handoffApp: 'Runner CLI' },
    offer: null,
  });
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.textContent,
    'Runner CLI has closed its session. Authorize above to keep working.');
});

test('22a: an offer that named no app is still named, rather than left as a blank', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', handoff: true }, offer: null });
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.textContent,
    'The app that opened this browser has closed its session. Authorize above to keep working.');
});

test('23: a connection the tester made themselves says nothing about a handoff', () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 't' } });
  h.node.connectionSource.hidden = false;
  h.fn.renderConnection();
  assert.equal(h.node.connectionSource.hidden, true);
  assert.equal(h.node.connectionSource.textContent, '');
});

test('24: entering the connect screen promotes the form and puts the caret in the token box', () => {
  const h = load({ view: 'settings', settings: null });
  h.fn.applyConnectMode();
  assert.equal(h.node.viewSettings.dataset.mode, 'connect');
  assert.equal(h.doc.body.dataset.connect, 'true');
  assert.equal(h.node.connectHero.hidden, false);
  assert.equal(h.node.btnSaveSettings.textContent, 'Connect');
  assert.equal(h.doc.activeElement, h.node.setToken);
});

test('24a: a configured panel gets the full form back, hero away and the Save wording restored', () => {
  const h = load({ ...CONFIGURED, view: 'settings' });
  h.fn.applyConnectMode();
  assert.equal(h.node.viewSettings.dataset.mode, 'full');
  assert.equal(h.doc.body.dataset.connect, 'false');
  assert.equal(h.node.connectHero.hidden, true);
  assert.equal(h.node.btnSaveSettings.textContent, 'Save & validate');
  assert.equal(h.doc.activeElement, null);
});

test('24b: another view with nothing saved is not the connect screen', () => {
  const h = load({ view: 'runs', settings: null });
  h.fn.applyConnectMode();
  assert.equal(h.node.viewSettings.dataset.mode, 'full');
  assert.equal(h.doc.activeElement, null);
});

test('25: a repaint while the tester is already typing does not steal the caret back', () => {
  const h = load({ view: 'settings', settings: null });
  h.fn.applyConnectMode();
  h.doc.activeElement = null; // the tester moved on to another field
  h.fn.applyConnectMode();
  h.fn.applyConnectMode();
  assert.equal(h.doc.activeElement, null);
});

test('25a: leaving the connect screen and coming back focuses the token box again', () => {
  const h = load({ view: 'settings', settings: null });
  h.fn.applyConnectMode();
  h.doc.activeElement = null;
  h.state.settings = { baseUrl: 'https://a.io', apiToken: 't' };
  h.fn.applyConnectMode(); // out of connect mode
  h.state.settings = null;
  h.fn.applyConnectMode(); // and back in
  assert.equal(h.doc.activeElement, h.node.setToken);
});

// ============================================================================
// The save gauntlet (rows 35-52)
// ============================================================================

test('35: an empty Instance is an Advanced problem, so Advanced is unfolded with the error', async () => {
  const h = load({ baseUrl: '' });
  h.fill({ token: 'tok-1' });
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: REQUIRED, cls: 'error' });
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
  assert.equal(h.store.ops('local', 'set').length, 0);
  assert.deepEqual(h.calls.toasts, []); // never got as far as validating
});

test('36: a missing token is a Connection problem — unfolding Advanced would point at the wrong row', async () => {
  const h = load({ baseUrl: 'https://a.io' });
  h.fill({ token: '   ' });
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: REQUIRED, cls: 'error' });
  assert.equal(h.node.settingsAdvancedBody.hidden, true);
  assert.equal(h.store.ops('local', 'set').length, 0);
});

test('37: a plain http instance is refused, with the field it is about on screen', async () => {
  const h = load();
  h.fill({ baseUrl: 'http://a.io', token: 'tok-1' });
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: NOT_HTTPS, cls: 'error' });
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
  assert.equal(h.store.ops('local', 'set').length, 0);
});

test('38: an instance that is no URL at all is refused, with Advanced unfolded', async () => {
  const h = load();
  h.fill({ baseUrl: 'not a url', token: 'tok-1' });
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: NOT_URL, cls: 'error' });
  assert.equal(h.node.settingsAdvancedBody.hidden, false);
  assert.equal(h.store.ops('local', 'set').length, 0);
});

test('39: a Log window out of range stops the save before anything reaches the network', async () => {
  const h = load();
  h.fill({ ...OK_SAVE, window: '5' });
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: BAD_WINDOW, cls: 'error' });
  assert.equal(h.store.ops('local', 'set').length, 0);
  assert.equal(h.calls.listProjects, 0);
  assert.deepEqual(h.calls.toasts, []);
  // The Log window lives in Failure log, so Advanced stays as the tester left it.
  assert.equal(h.node.settingsAdvancedBody.hidden, true);
});

test('40: a token the server refuses is named as the token, and nothing is stored', async () => {
  const h = load({ projectList: () => { throw new ApiError('auth', 401, 'unauthorized'); } });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), {
    id: 'settings-status',
    msg: 'Token rejected by a.io — authorize there again and save the new token',
    cls: 'error',
  });
  assert.equal(h.store.ops('local', 'set').length, 0);
  assert.equal(h.calls.validate, 0);
  assert.equal(h.state.settings, null);
  assert.deepEqual(h.calls.toasts, ['Validating…']);
});

test('41: a network hiccup still saves, on the project this instance was last on', async () => {
  const h = load({
    hostSettings: { 'a.io': { baseUrl: 'https://a.io', apiToken: 'old', projectId: 'p1' } },
    hostHistory: ['a.io'],
    projects: [{ id: 'stale' }],
    projectList: () => { throw new ApiError('network', 0, 'offline'); },
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.equal(h.lineOf('settings-status').msg, ''); // the happy-path clear, not an error
  assert.equal(h.stored().settings.projectId, 'p1');
  assert.deepEqual(plain(h.state.projects), []); // never another host's slugs
  assert.equal(h.calls.validate, 1);
  assert.equal(h.calls.runsView, 1);
});

test('42: a network hiccup with no remembered project says so, and saves nothing', async () => {
  const h = load({ projectList: () => { throw new ApiError('network', 0, 'offline'); } });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), {
    id: 'settings-status',
    msg: "Couldn't load your projects from a.io — check the connection and save again",
    cls: 'error',
  });
  assert.equal(h.store.ops('local', 'set').length, 0);
  assert.equal(h.calls.validate, 0);
});

test('43: a token that reaches no project at all is a different sentence from a lost connection', async () => {
  const h = load({ projects: [{ id: 'stale' }], projectList: () => [] });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), {
    id: 'settings-status',
    msg: 'This token reaches no projects — ask for access to one, then save again',
    cls: 'error',
  });
  assert.equal(h.store.ops('local', 'set').length, 0);
});

test('44: an empty project list empties the switcher — the old host\'s slugs must not survive', async () => {
  const refused = load({ projects: [{ id: 'stale' }], projectList: () => [] });
  refused.fill(OK_SAVE);
  await refused.fn.saveSettings();
  assert.deepEqual(plain(refused.state.projects), []);
  // …and the same on the path that carries on because a project is remembered.
  const kept = load({
    projects: [{ id: 'stale' }],
    hostSettings: { 'a.io': { baseUrl: 'https://a.io', projectId: 'p1' } },
    hostHistory: ['a.io'],
    projectList: () => [],
  });
  kept.fill(OK_SAVE);
  await kept.fn.saveSettings();
  assert.deepEqual(plain(kept.state.projects), []);
  assert.equal(kept.stored().settings.projectId, 'p1');
});

test('45: several projects and no previous one save the token first, then ask for the pick', async () => {
  const h = load({ projectList: () => [{ id: 'a' }, { id: 'b' }] });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.order.filter((s) => ['local.set', 'askForProject', 'validate'].includes(s)),
    ['local.set', 'askForProject']);
  assert.equal(h.calls.validate, 0); // no project to validate against yet
  assert.equal(h.stored().settings.projectId, '');
  assert.deepEqual(plain(h.state.projects), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(h.calls.runsView, 0);
});

test('46: read-only access is a VALID configuration, so the save stands', async () => {
  const h = load({
    projectList: () => [{ id: 'p1' }],
    validate: () => { throw new ApiError('readonly', 403, 'read only'); },
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.equal(h.stored().settings.projectId, 'p1');
  assert.equal(h.lineOf('settings-status').msg, '');
  assert.equal(h.calls.runsView, 1);
});

test('47: any other validation failure is reported verbatim, and nothing is stored', async () => {
  const h = load({
    projectList: () => [{ id: 'p1' }],
    validate: () => { throw new ApiError('http', 500, 'server exploded'); },
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.lineOf('settings-status'), {
    id: 'settings-status', msg: 'Validation failed: server exploded', cls: 'error',
  });
  assert.equal(h.store.ops('local', 'set').length, 0);
  assert.equal(h.state.settings, null);
  assert.equal(h.calls.runsView, 0);
});

test('48: the happy path commits, repaints the header, clears the line and lands on the runs view', async () => {
  const h = load({ projectList: () => [{ id: 'p1' }] });
  h.fill({ ...OK_SAVE, window: '120', neverValues: true });
  await h.fn.saveSettings();
  assert.deepEqual(
    h.order.filter((s) => ['local.set', 'renderProjectBar', 'status:settings-status', 'openRunsView'].includes(s)),
    ['local.set', 'renderProjectBar', 'status:settings-status', 'openRunsView'],
  );
  assert.deepEqual(h.lineOf('settings-status'), { id: 'settings-status', msg: '', cls: '' });
  assert.deepEqual(h.stored().settings, {
    baseUrl: 'https://a.io',
    apiToken: 'tok-1',
    projectId: 'p1',
    envInfoOnFail: true,
    envFullUrl: false,
    evidenceWindowSec: 120,
    evidenceAutoStart: false,
    evidenceAutoAttach: true,
    evidenceCaptureBodies: true,
    stepRecNeverValues: true,
  });
  // renderConnection ran on the way out: the card is the verdict, not a line under Save.
  assert.equal(h.node.connectionCard.dataset.state, 'ready');
});

test('48a: the token is checked WITHOUT a project first, then the project-scoped call is made', async () => {
  const h = load({
    hostSettings: { 'a.io': { baseUrl: 'https://a.io', projectId: 'p1' } },
    hostHistory: ['a.io'],
    projectList: () => [{ id: 'p1' }, { id: 'p2' }],
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.deepEqual(h.order.filter((s) => ['listProjects', 'validate', 'local.set'].includes(s)),
    ['listProjects', 'validate', 'local.set']);
  assert.equal(h.calls.configured.length, 2);
  assert.deepEqual(h.calls.configured[0],
    { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1' });
  assert.equal(h.calls.configured[1].projectId, 'p1');
});

test('49: a per-host preference this form cannot show survives the re-save', async () => {
  const h = load({
    hostSettings: { 'a.io': { baseUrl: 'https://a.io', projectId: 'p1', fullPageCapture: false } },
    hostHistory: ['a.io'],
    projectList: () => [{ id: 'p1' }],
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.equal(h.stored().settings.fullPageCapture, false);
});

test('49a: the ACTIVE instance is the fallback source for those preferences', async () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', apiToken: 'old', projectId: 'p1', fullPageCapture: true },
    hostSettings: {},
    hostHistory: [],
    projectList: () => [{ id: 'p1' }],
  });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.equal(h.stored().settings.fullPageCapture, true);
  assert.equal(h.stored().settings.projectId, 'p1');
});

test('49b: a first save for an unknown instance carries no stray per-host preference', async () => {
  const h = load({ projectList: () => [{ id: 'p1' }] });
  h.fill(OK_SAVE);
  await h.fn.saveSettings();
  assert.equal('fullPageCapture' in h.stored().settings, false);
});

test('50: landing on another project drops that project\'s state FIRST, before anything is written', async () => {
  const h = load({ settings: { baseUrl: 'https://a.io', apiToken: 't', projectId: 'old' } });
  await h.fn.commitSettings({ baseUrl: 'https://a.io', apiToken: 't', projectId: 'new' }, 'a.io');
  assert.deepEqual(h.order, [
    'resetProjectScopedState', 'state.settings', 'state.hostSettings', 'state.hostHistory', 'local.set',
  ]);
});

test('50a: staying on the same project, or arriving without one, drops nothing', async () => {
  const same = load({ settings: { baseUrl: 'https://a.io', projectId: 'p1' } });
  await same.fn.commitSettings({ baseUrl: 'https://a.io', projectId: 'p1' }, 'a.io');
  assert.equal(same.calls.reset, 0);
  const first = load({ settings: null });
  await first.fn.commitSettings({ baseUrl: 'https://a.io', projectId: 'p1' }, 'a.io');
  assert.equal(first.calls.reset, 0);
  const unpicked = load({ settings: { baseUrl: 'https://a.io', projectId: '' } });
  await unpicked.fn.commitSettings({ baseUrl: 'https://a.io', projectId: 'p2' }, 'a.io');
  assert.equal(unpicked.calls.reset, 0);
});

test('51: the commit writes the config, the per-host map, the history AND the two mirrored keys', async () => {
  const h = load();
  const settings = { baseUrl: 'https://a.io', projectId: 'p1', evidenceCaptureBodies: false, stepRecNeverValues: true };
  await h.fn.commitSettings(settings, 'a.io');
  assert.deepEqual(h.written(), [[
    'evidenceCaptureBodies', 'hostHistory', 'hostSettings', 'settings', 'stepRecNeverValues',
  ]]);
  const data = h.stored();
  assert.equal(data.evidenceCaptureBodies, false); // the relay reads this, never `settings`
  assert.equal(data.stepRecNeverValues, true);     // and so does the step recorder
  assert.deepEqual(data.hostSettings, { 'a.io': settings });
  assert.deepEqual(data.hostHistory, ['a.io']);
});

test('52: re-saving a known instance moves it to the front of the history without duplicating it', async () => {
  const h = load({ hostHistory: ['b.io', 'a.io', 'c.io'] });
  await h.fn.commitSettings({ baseUrl: 'https://a.io' }, 'a.io');
  assert.deepEqual(plain(h.state.hostHistory), ['a.io', 'b.io', 'c.io']);
  assert.deepEqual(h.stored().hostHistory, ['a.io', 'b.io', 'c.io']);
});

test('52a: with no chrome the panel still holds the config, it just persists nothing', async () => {
  const h = load({ hasChrome: false });
  await h.fn.commitSettings({ baseUrl: 'https://a.io', projectId: 'p1' }, 'a.io');
  assert.equal(h.state.settings.projectId, 'p1');
  assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
  assert.equal(h.store.ops('local', 'set').length, 0);
});

// ============================================================================
// The erase paths — the ordering is the safety property (rows 53-75)
// ============================================================================

test('53: a destructive control never retargets itself off a half-typed Instance field', () => {
  const h = load({ ...CONFIGURED, baseUrl: 'nonsense' });
  assert.equal(h.fn.settingsFormHost(), null);
});

test('54: an empty field means the instance the panel is on', () => {
  const h = load({ ...CONFIGURED, baseUrl: '   ' });
  assert.equal(h.fn.settingsFormHost(), 'a.io');
});

test('54a: an empty field with nothing saved targets nothing at all', () => {
  const h = load({ baseUrl: '', settings: null });
  assert.equal(h.fn.settingsFormHost(), null);
});

test('55: Forget on an unparsable instance says nothing was forgotten, and forgets nothing', async () => {
  const h = load({ ...CONFIGURED, baseUrl: 'nonsense' });
  await h.fn.forgetInstance();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status',
    msg: '"nonsense" is not a valid instance URL — nothing was forgotten',
    cls: 'error',
  });
  assert.deepEqual(h.order, ['status:settings-forget-status']);
  assert.equal(h.calls.confirms.length, 0);
});

test('55a: Forget with an empty field and nothing saved has nothing to forget', async () => {
  const h = load({ baseUrl: '', settings: null });
  await h.fn.forgetInstance();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status', msg: 'No instance to forget', cls: 'error',
  });
});

test('56: an instance we never held is never reported as erased', async () => {
  const h = load(CONFIGURED);
  await h.fn.forgetInstance({ host: 'z.io' });
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status', msg: 'Nothing saved for z.io', cls: 'error',
  });
  assert.equal(h.calls.confirms.length, 0);
  assert.equal(h.store.ops('local', 'set').length, 0);
});

test('57: answering No to the confirm changes absolutely nothing', async () => {
  const h = load({ ...CONFIGURED, confirm: false });
  await h.fn.forgetInstance();
  assert.deepEqual(h.order, ['confirm']);
  assert.equal(h.state.settings.apiToken, 'tok-1');
  assert.deepEqual(plain(h.state.hostSettings), CONFIGURED.hostSettings);
  assert.equal(h.calls.reloads, 0);
  assert.equal(h.calls.status.length, 0);
});

test('58: forgetting the instance in use warns about the queued results too', async () => {
  const active = load({ ...CONFIGURED, confirm: false });
  await active.fn.forgetInstance();
  const msg = active.calls.confirms[0].message;
  assert.equal(active.calls.confirms[0].label, 'Forget');
  assert.match(msg, /^Forget a\.io\? Its saved token, project and preferences are deleted from this browser/);
  assert.match(msg, /any queued results still waiting to be sent/);
  assert.match(msg, /a running recording is stopped for you/);
  assert.match(msg, /Other instances are kept\.$/);
});

test('58a: forgetting an instance we are NOT on promises only what it can deliver', async () => {
  const h = load({
    ...CONFIGURED,
    hostSettings: { ...CONFIGURED.hostSettings, 'b.io': { baseUrl: 'https://b.io' } },
    confirm: false,
  });
  await h.fn.forgetInstance({ host: 'b.io' });
  const msg = h.calls.confirms[0].message;
  assert.match(msg, /^Forget b\.io\?/);
  assert.equal(/queued results/.test(msg), false);
  assert.equal(/running recording/.test(msg), false);
});

test('59: the erase writes STORAGE first and in-memory state only after, in one fixed order', async () => {
  const h = load({
    settings: { baseUrl: 'https://a.io', apiToken: 'tok-1', projectId: 'p1', handoff: true },
    hostSettings: { 'a.io': { baseUrl: 'https://a.io' }, 'b.io': { baseUrl: 'https://b.io' } },
    hostHistory: ['a.io', 'b.io'],
    baseUrl: 'https://a.io',
  });
  await h.fn.forgetInstance();
  assert.deepEqual(h.order, [
    'confirm',
    'state.booting=true',
    'send:EVIDENCE_WIPE',
    'local.set',
    'local.remove(settings,session,offlineQueue)',
    'session.clear',
    'Handoff.decline',
    'state.hostSettings',
    'state.hostHistory',
    'state.settings=null',
    'reload',
  ]);
  assert.deepEqual(h.stored().hostSettings, { 'b.io': { baseUrl: 'https://b.io' } });
  assert.deepEqual(h.stored().hostHistory, ['b.io']);
  assert.equal(h.state.settings, null);
  assert.equal(h.calls.reloads, 1);
});

test('59a: an instance with no handoff behind it declines no offer', async () => {
  const h = load(CONFIGURED);
  await h.fn.forgetInstance();
  assert.equal(h.calls.declines, 0);
  assert.equal(h.order.includes('local.remove(settings,session,offlineQueue)'), true);
});

test('59b: an older Chrome with no session area still finishes the erase', async () => {
  const h = load({ ...CONFIGURED, sessionArea: false });
  await h.fn.forgetInstance();
  assert.equal(h.order.includes('session.clear'), false);
  assert.equal(h.calls.reloads, 1);
});

test('60: HOST_SCOPED_KEYS is the promise that queued results do not survive a Forget', async () => {
  const h = load(CONFIGURED);
  assert.deepEqual(plain(h.screen.HOST_SCOPED_KEYS), ['settings', 'session', 'offlineQueue']);
  await h.fn.forgetInstance();
  const removed = h.store.ops('local', 'remove');
  assert.equal(removed.length, 1);
  assert.deepEqual(plain(removed[0].arg), ['settings', 'session', 'offlineQueue']);
});

test('61: a storage write that is refused leaves the panel exactly as it was', async () => {
  const h = load({ ...CONFIGURED, fail: { set: new Error('quota exceeded') } });
  await h.fn.forgetInstance();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status',
    msg: "Couldn't finish forgetting a.io: quota exceeded — assume the data is still on this machine, try again",
    cls: 'error',
  });
  assert.equal(h.state.booting, false); // the session writer may run again
  assert.equal(h.state.settings.apiToken, 'tok-1');
  assert.deepEqual(plain(h.state.hostSettings), CONFIGURED.hostSettings);
  assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
  assert.equal(h.calls.reloads, 0);
  assert.deepEqual(h.order.filter((s) => s.startsWith('state.')), ['state.booting=true', 'state.booting=false']);
});

test('61a: the host-scoped removal failing is the same guarantee, not a half-erase', async () => {
  const h = load({ ...CONFIGURED, fail: { remove: new Error('disk gone') } });
  await h.fn.forgetInstance();
  assert.match(h.lineOf('settings-forget-status').msg, /^Couldn't finish forgetting a\.io: disk gone/);
  assert.equal(h.state.settings.apiToken, 'tok-1');
  assert.deepEqual(plain(h.state.hostSettings), CONFIGURED.hostSettings);
  assert.equal(h.calls.reloads, 0);
});

test('61b: a failure with no message still names something the tester can act on', async () => {
  const h = load({ ...CONFIGURED, fail: { set: 'the disk is full' } });
  await h.fn.forgetInstance();
  assert.equal(h.lineOf('settings-forget-status').msg,
    "Couldn't finish forgetting a.io: the disk is full — assume the data is still on this machine, try again");
});

test('62: a recorder that will not stop does not hold up the erase — the warning rides the reload', async () => {
  const h = load({ ...CONFIGURED, reply: async () => ({ ok: false, error: 'busy' }) });
  await h.fn.forgetInstance();
  assert.equal(h.calls.reloads, 1);
  assert.equal(h.state.settings, null);
  assert.equal(h.sess[WARN_KEY],
    'Instance forgotten — but the console & network recording could not be stopped: busy. '
    + 'Assume its log is still on this machine until you restart the browser.');
  assert.equal(h.calls.status.length, 0); // the doomed document prints nothing
});

test('62a: a clean recorder stop leaves no warning behind for the next panel', async () => {
  const h = load(CONFIGURED);
  await h.fn.forgetInstance();
  assert.equal(h.sess[WARN_KEY], undefined);
});

test('63: forgetting an instance we are not on refills the form instead of reloading', async () => {
  const h = load({
    ...CONFIGURED,
    hostSettings: { ...CONFIGURED.hostSettings, 'b.io': { baseUrl: 'https://b.io', apiToken: 'tok-b' } },
    hostHistory: ['b.io', 'a.io'],
    baseUrl: 'https://b.io',
  });
  await h.fn.forgetInstance();
  assert.equal(h.calls.reloads, 0);
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status', msg: 'b.io forgotten', cls: 'ok',
  });
  assert.equal(h.node.setBaseurl.value, 'https://a.io'); // back to the active instance
  assert.equal(h.node.viewSettings.dataset.token, 'off');
  assert.deepEqual(plain(h.state.hostHistory), ['a.io']);
  assert.equal(h.state.settings.apiToken, 'tok-1'); // the panel keeps running on a.io
  // Nothing session-scoped is touched: it belongs to the instance still in use.
  assert.equal(h.store.ops('local', 'remove').length, 0);
  assert.equal(h.order.includes('send:EVIDENCE_WIPE'), false);
  assert.equal(h.order.includes('state.booting=true'), false);
});

test('64: Disconnect takes back the instance the panel is ON, whatever the field shows', async () => {
  const h = load({
    ...CONFIGURED,
    hostSettings: { ...CONFIGURED.hostSettings, 'b.io': { baseUrl: 'https://b.io' } },
    hostHistory: ['a.io', 'b.io'],
    baseUrl: 'https://b.io',
    confirm: false,
  });
  await h.fn.disconnectInstance();
  assert.equal(h.calls.confirms[0].label, 'Disconnect');
  assert.match(h.calls.confirms[0].message, /^Disconnect a\.io\?/);
  assert.match(h.calls.confirms[0].message, /any queued results still waiting to be sent/);
});

test('65: Disconnect from the choose-a-project screen reports on THAT screen\'s line', async () => {
  const h = load({ settings: null, hostSettings: {}, baseUrl: 'https://b.io' });
  await h.fn.disconnectInstance({ statusId: 'pick-status' });
  assert.deepEqual(h.lineOf('pick-status'), {
    id: 'pick-status', msg: 'Nothing saved for b.io', cls: 'error',
  });
  assert.equal(h.lineOf('connection-status'), null);
});

test('65a: with nothing saved anywhere, Disconnect defaults to the Connection card\'s own line', async () => {
  const h = load({ settings: null, hostSettings: {}, baseUrl: '' });
  await h.fn.disconnectInstance();
  assert.deepEqual(h.lineOf('connection-status'), {
    id: 'connection-status', msg: 'No instance to forget', cls: 'error',
  });
});

test('66: a recorder that answers cleanly lets the wipe resolve', async () => {
  const h = load({ reply: async () => ({ ok: true }) });
  await h.fn.wipeEvidenceRecording();
  assert.deepEqual(h.calls.sends, [{ type: 'EVIDENCE_WIPE' }]);
});

test('67: a recorder that refuses hands its own reason up, so the tester reads it', async () => {
  const h = load({ reply: async () => ({ ok: false, error: 'busy' }) });
  assert.equal((await rejection(h.fn.wipeEvidenceRecording())).message, 'busy');
});

test('67a: a refusal with no reason still fails loudly rather than passing for a wipe', async () => {
  for (const reply of [async () => ({ ok: false }), async () => null, async () => ({ ok: 'true' })]) {
    const h = load({ reply });
    assert.equal((await rejection(h.fn.wipeEvidenceRecording())).message,
      'the recorder could not be stopped');
  }
});

test('68: no worker to answer means no recording to stop, so the erase proceeds', async () => {
  for (const why of ['Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received: receiving end']) {
    const h = load({ reply: async () => { throw new Error(why); } });
    await h.fn.wipeEvidenceRecording();
  }
});

test('68a: any other messaging failure is a failure, not a silent success', async () => {
  const h = load({ reply: async () => { throw new Error('extension context invalidated'); } });
  assert.equal((await rejection(h.fn.wipeEvidenceRecording())).message,
    'extension context invalidated');
});

test('69: a recorder that never answers is a FAILURE after five seconds, not a success', async () => {
  const h = load({ reply: () => new Promise(() => {}) });
  const p = rejection(h.fn.wipeEvidenceRecording());
  await settle();
  assert.deepEqual(h.clock.arms(), [5000]);
  assert.equal(h.screen.EVIDENCE_WIPE_MS, 5000);
  await h.clock.tick();
  assert.equal((await p).message, 'the recorder did not answer in 5s');
});

test('69a: with no runtime to ask, there is no recorder and no failure', async () => {
  await load({ runtime: false }).fn.wipeEvidenceRecording();
  await load({ hasChrome: false }).fn.wipeEvidenceRecording();
});

test('70: Sign out carries the theme and the surface ACROSS the wipe, and reloads last', async () => {
  const h = load({ ...CONFIGURED, theme: 'dark', surface: 'tab' });
  await h.fn.signOut();
  assert.deepEqual(h.order, [
    'confirm',
    'state.booting=true',
    'send:EVIDENCE_WIPE',
    'Theme.get',
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

test('70a: Sign out asks first, and No leaves every token where it is', async () => {
  const h = load({ ...CONFIGURED, confirm: false });
  await h.fn.signOut();
  assert.match(h.calls.confirms[0].message, /^Sign out\? Every saved token, instance, history entry/);
  assert.equal(h.calls.confirms[0].label, 'Sign out');
  assert.deepEqual(h.order, ['confirm']);
  assert.equal(h.state.settings.apiToken, 'tok-1');
});

test('71: a clear that is refused aborts on Sign out\'s OWN line, not inside a folded section', async () => {
  const h = load({ ...CONFIGURED, fail: { clear: new Error('storage locked') } });
  await h.fn.signOut();
  assert.deepEqual(h.lineOf('signout-status'), {
    id: 'signout-status',
    msg: "Couldn't finish signing out: storage locked — assume the data is still on this machine, try again",
    cls: 'error',
  });
  assert.equal(h.lineOf('settings-forget-status'), null);
  assert.equal(h.state.settings.apiToken, 'tok-1');
  assert.equal(h.state.booting, false);
  assert.equal(h.calls.reloads, 0);
});

test('72: the two defaults are not written back — nothing to carry across means nothing to restore', async () => {
  const h = load({ ...CONFIGURED, theme: 'system', surface: 'sidepanel' });
  await h.fn.signOut();
  assert.deepEqual(h.calls.themeSet, []);
  assert.deepEqual(h.calls.surfaceSet, []);
  assert.equal(h.calls.reloads, 1);
});

test('72a: Sign out with a recorder that will not stop still erases, and leaves the warning', async () => {
  const h = load({ ...CONFIGURED, reply: async () => ({ ok: false, error: 'busy' }) });
  await h.fn.signOut();
  assert.deepEqual(h.stored(), {});
  assert.equal(h.calls.reloads, 1);
  assert.equal(h.sess[WARN_KEY],
    'Signed out — but the console & network recording could not be stopped: busy. '
    + 'Assume its log is still on this machine until you restart the browser.');
});

test('72b: with no chrome there is nothing to clear, and Sign out still ends on the connect screen', async () => {
  const h = load({ ...CONFIGURED, hasChrome: false });
  await h.fn.signOut();
  assert.equal(h.order.includes('local.clear'), false);
  assert.equal(h.state.settings, null);
  assert.equal(h.calls.reloads, 1);
});

test('73: the warning an erase left behind is printed once and then gone', () => {
  const h = load({ sessionSeed: { [WARN_KEY]: 'Signed out — but the recorder could not be stopped' } });
  h.fn.takeRecorderWarning();
  assert.deepEqual(h.lineOf('settings-forget-status'), {
    id: 'settings-forget-status',
    msg: 'Signed out — but the recorder could not be stopped',
    cls: 'error',
  });
  assert.equal(h.sess[WARN_KEY], undefined);
  assert.equal(h.screen.EVIDENCE_WIPE_WARN_KEY, WARN_KEY);
  h.calls.status.length = 0;
  h.fn.takeRecorderWarning(); // a second entry into Settings says nothing
  assert.deepEqual(h.calls.status, []);
});

test('73a: no warning stored means no line at all, not an empty one', () => {
  const h = load();
  h.fn.takeRecorderWarning();
  assert.deepEqual(h.calls.status, []);
});

test('74: a browser that refuses sessionStorage neither throws nor invents a warning', () => {
  const h = load({ sessionThrows: true });
  h.fn.takeRecorderWarning();
  assert.deepEqual(h.calls.status, []);
  h.fn.leaveRecorderWarning(new Error('busy'), 'Signed out'); // the write side, same guarantee
});

test('75: the welcome checklist is still called on every fill, and still renders nothing', () => {
  const h = load({ ...CONFIGURED, onboarding: true });
  h.fn.fillSettingsForm();
  assert.equal(h.calls.lookups.includes('onboarding-card'), true);
  assert.equal(h.doc.getElementById('onboarding-card'), null);
  assert.equal(h.doc.getElementById('onboarding-step-token'), null);
});

test('75a: with no checklist loaded at all, filling the form is unaffected', () => {
  const h = load({ ...CONFIGURED, onboardingStub: true });
  h.fn.fillSettingsForm();
  assert.equal(h.calls.onboardingRender, 1);
  const bare = load(CONFIGURED);
  bare.fn.fillSettingsForm();
  assert.equal(bare.node.setBaseurl.value, 'https://a.io');
});

test('75b: filling the form paints the fields, the history, the card and the token box in one pass', () => {
  const h = load({
    settings: { baseUrl: 'https://self.host', apiToken: 'tok-1', projectId: 'p1' },
    hostSettings: { 'self.host': { baseUrl: 'https://self.host' }, 'b.io': { baseUrl: 'https://b.io' } },
    hostHistory: ['self.host', 'b.io'],
    baseUrl: '',
    theme: 'light',
  });
  h.fn.fillSettingsForm();
  assert.equal(h.node.setBaseurl.value, 'https://self.host');
  assert.equal(h.dd.hidden, false);
  assert.equal(h.node.themeLight.getAttribute('aria-pressed'), 'true');
  assert.equal(h.node.settingsAdvancedBody.hidden, false); // self-hosted opens Advanced
  assert.equal(h.node.tokenHelpLink.href, 'https://self.host/account/access_tokens');
  assert.equal(h.node.connectionCard.dataset.state, 'ready');
  assert.equal(h.node.viewSettings.dataset.token, 'off');
});
