#!/usr/bin/env node
// The contract of extension/editor/view.js (#192): the read-only screen mounts and publishes
// `window.__tc` in the shape the e2e suite reads, the server link hides when there is no address,
// and the parameters table stays optional. A smoke contract, not a case sweep — cases V1-V3 of
// #192. Run: node --test tests/editor-view.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/mini-dom.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// VIEW_SRC runs the whole file against a mutated copy, so a falsification run never has to edit
// the shipped module and risk leaving it edited.
const SRC = process.env.VIEW_SRC || join(repoRoot, 'extension/editor/view.js');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// The real modules the view draws through, evaluated into the same context editor.html loads them
// into: a stub of the glyph table or of the grid's cell rule would let the two drift unnoticed.
const REAL = ['extension/shared/skeleton.js', 'extension/shared/priority-icons.js',
  'extension/shared/empty-state.js', 'extension/shared/test-type.js',
  'extension/editor/editor-icons.js', 'extension/editor/params-grid.js'];

// Only the SVG builder is stubbed: shared/icons.js is a path table behind createElementNS, and
// nothing here asserts a glyph's geometry.
function makeIcons(document) {
  return {
    markup: (name, size = 16, o = {}) => `<svg data-name="${name}" data-size="${size}" data-rotate="${o.rotate || 0}"></svg>`,
    el: (name, size = 16) => {
      const n = document.createElement('span');
      n.dataset.icon = name;
      n.dataset.size = String(size);
      return n;
    },
    emoji: (value, cls = '') => {
      if (!value) return null;
      const n = document.createElement('span');
      n.className = `${cls} emoji`.trim();
      n.textContent = String(value);
      return n;
    },
  };
}

// One sandbox per test: the view writes `window.__tc` and `document.title`, so a shared page would
// let one case read the previous one's render.
function load({ jwt = true, params = null, paramsError = null } = {}) {
  const document = makeDocument(['root']);
  const window = {};
  const calls = { getTestParams: [], projectLang: 0 };
  const Icons = makeIcons(document);
  const ctx = createContext({
    document,
    window,
    location: { search: '?test=t1', href: '' },
    URLSearchParams,
    console,
    Icons,
    Tooltip: { set: () => {} },
    TestomatAPI: {
      jwtAvailable: () => jwt,
      getTestParams: async (uid) => {
        calls.getTestParams.push(uid);
        if (paramsError) throw paramsError;
        return params || {};
      },
    },
  });
  window.Icons = Icons; // shared/empty-state.js reaches its mark through the window
  const shims = ['PriorityIcons', 'TestType', 'EmptyState']
    .map((n) => `var ${n} = window.${n};`).join('\n');
  const source = [...REAL.map(read), shims, readFileSync(SRC, 'utf8'), 'EditorView;'].join('\n');
  return { EditorView: runInContext(source, ctx), document, window, calls };
}

// The page members the view is handed rather than given a copy of. `testWebUrl` and `projectLang`
// are the two that read editor.js module state, so both are recorded here.
function makeShell(document, calls, over = {}) {
  return {
    rootEl: () => document.getElementById('root'),
    barMain: (...kids) => {
      const main = document.createElement('div');
      main.className = 'tc-bar-main';
      main.append(...kids);
      return main;
    },
    buildCrumbs: () => {
      const nav = document.createElement('nav');
      nav.className = 'crumbs';
      return nav;
    },
    toTestsRoot: () => {},
    renderPreviewInto: (box, md) => { box.textContent = String(md || ''); },
    paneHasContent: (box) => box.textContent.trim() !== '',
    testWebUrl: () => 'https://app.example/projects/p1/test/t1',
    projectLang: async () => { calls.projectLang += 1; return ''; },
    onSettings: (s) => { calls.settings = s; },
    ...over,
  };
}

const render = (env, opts = {}, shell = {}) => env.EditorView.renderView({
  ctx: 'panel',
  uid: 't1',
  title: 'Log in with a valid password',
  markdown: '### Steps\n\n1. Open the form',
  priority: 'high',
  test: { state: 'manual' },
  ...opts,
  shell: makeShell(env.document, env.calls, shell),
});

// The pending appendParamsTable() is fire-and-forget inside renderView; two ticks is past both of
// its awaits, which is where a test can see whether the table arrived.
const settle = () => new Promise((r) => setImmediate(r));

test('the module publishes exactly the surface editor.js destructures', () => {
  assert.deepEqual(Object.keys(load().EditorView).sort(), ['appendParamsTable', 'renderView']);
});

test('V1: the view mounts — bar, title, body and toast, under #root', () => {
  const env = load();
  render(env);
  const root = env.document.getElementById('root');
  const wrap = root.querySelector('.tc-editor.tc-view');
  assert.equal(wrap.parentElement, root);
  assert.equal(env.document.title, 'Log in with a valid password'); // names the browser tab
  assert.equal(wrap.getAttribute('aria-busy'), null);
  // The header's marks in the order a test row opens with: priority, then what kind it is.
  const h = wrap.querySelector('#tc-view-title');
  assert.equal(h.querySelector('#tc-view-priority').dataset.priority, 'high');
  assert.equal(h.querySelector('.type-mark').dataset.type, 'manual');
  assert.equal(h.textContent.includes('Log in with a valid password'), true);
  // `#tc-view-body` is the id the e2e harness reads the description off.
  assert.equal(wrap.querySelector('#tc-view-body').textContent, '### Steps\n\n1. Open the form');
  assert.equal(wrap.querySelector('#tc-toast').hidden, true);
  assert.ok(wrap.querySelector('#tc-edit'));
  assert.ok(wrap.querySelector('#tc-back')); // ctx=panel has somewhere to go back to
});

// The e2e hook is a contract, not an implementation detail: the suite reads every member below.
test('V1: renderView publishes window.__tc in the shape the e2e suite reads', () => {
  const env = load();
  render(env);
  const tc = env.window.__tc;
  assert.deepEqual(Object.keys(tc).sort(), ['applySettings', 'ctx', 'getMarkdown', 'getPriority',
    'getTitle', 'mode', 'ready', 'uid', 'webUrl']);
  assert.equal(tc.ready, true);
  assert.equal(tc.ctx, 'panel');
  for (const k of ['mode', 'uid', 'getTitle', 'getMarkdown', 'getPriority', 'webUrl', 'applySettings']) {
    assert.equal(typeof tc[k], 'function', k);
  }
  assert.equal(tc.mode(), 'view');
  assert.equal(tc.uid(), 't1');
  assert.equal(tc.getTitle(), 'Log in with a valid password');
  assert.equal(tc.getMarkdown(), '### Steps\n\n1. Open the form');
  assert.equal(tc.getPriority(), 'high');
  assert.equal(tc.webUrl(), 'https://app.example/projects/p1/test/t1');
});

test('V1: a loading placeholder is not a loaded page — no __tc, no body id', () => {
  const env = load();
  render(env, { loading: true, title: undefined, test: null });
  const wrap = env.document.getElementById('root').querySelector('.tc-view');
  assert.equal(env.window.__tc, undefined);
  assert.equal(wrap.getAttribute('aria-busy'), 'true');
  assert.equal(wrap.querySelector('#tc-view-body'), null);
  // The bars say nothing a reader can use, so the heading carries the sentence.
  assert.equal(wrap.querySelector('#tc-view-title').getAttribute('aria-label'), 'Loading test case…');
  assert.equal(wrap.querySelectorAll('.skeleton').length > 0, true);
  assert.ok(wrap.querySelector('#tc-edit')); // its address is known from the uid alone
});

// V2 — the only branch in the block worth pinning, and the proof that the module CALLS editor.js's
// testWebUrl rather than rebuilding the address: the link carries whatever that function returned.
test('V2: no address means the link hides, an address means it shows', () => {
  const env = load();
  render(env, {}, { testWebUrl: () => null });
  const link = env.document.getElementById('root').querySelector('#tc-open-web');
  assert.equal(link.hidden, true);
  assert.equal(link.getAttribute('href'), null);
  assert.equal(env.window.__tc.webUrl(), null);

  const ok = load();
  render(ok, {}, { testWebUrl: (uid) => `https://elsewhere.test/${uid}` });
  const shown = ok.document.getElementById('root').querySelector('#tc-open-web');
  assert.equal(shown.hidden, false);
  assert.equal(shown.getAttribute('href'), 'https://elsewhere.test/t1');
});

test('V2: applySettings hands the settings back to editor.js and re-renders the link', () => {
  const env = load();
  let settings = null;
  render(env, {}, {
    testWebUrl: () => (settings ? `${settings.baseUrl}/t1` : null),
    onSettings: (s) => { settings = s; env.calls.settings = s; },
  });
  const link = env.document.getElementById('root').querySelector('#tc-open-web');
  assert.equal(link.hidden, true);
  env.window.__tc.applySettings({ baseUrl: 'https://second.test' });
  assert.deepEqual(env.calls.settings, { baseUrl: 'https://second.test' });
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute('href'), 'https://second.test/t1');
});

// V3 — the table is optional by contract. Nothing appended, nothing thrown, nothing said.
test('V3: no session appends no table, and never starts the language probe', async () => {
  const env = load({ jwt: false });
  const pane = env.document.createElement('div');
  const shell = makeShell(env.document, env.calls);
  await env.EditorView.appendParamsTable(pane, 't1', { projectLang: shell.projectLang });
  assert.equal(pane.childNodes.length, 0);
  assert.deepEqual(env.calls.getTestParams, []);
  assert.equal(env.calls.projectLang, 0);
});

test('V3: no uid appends no table', async () => {
  const env = load();
  const pane = env.document.createElement('div');
  const shell = makeShell(env.document, env.calls);
  await env.EditorView.appendParamsTable(pane, null, { projectLang: shell.projectLang });
  assert.equal(pane.childNodes.length, 0);
  assert.deepEqual(env.calls.getTestParams, []);
});

test('V3: a project with no parameters at all appends no table', async () => {
  const env = load({ params: { params: [], examples: [] } });
  const pane = env.document.createElement('div');
  const shell = makeShell(env.document, env.calls);
  await env.EditorView.appendParamsTable(pane, 't1', { projectLang: shell.projectLang });
  assert.deepEqual(env.calls.getTestParams, ['t1']);
  assert.equal(pane.childNodes.length, 0);
});

test('V3: a BDD project and a failed read are both silent', async () => {
  const bdd = load({ params: { params: ['email'], examples: [] } });
  const bddPane = bdd.document.createElement('div');
  await bdd.EditorView.appendParamsTable(bddPane, 't1', { projectLang: async () => 'gherkin' });
  assert.equal(bddPane.childNodes.length, 0);
  assert.deepEqual(bdd.calls.getTestParams, []); // the language answers before the round trip

  const failed = load({ paramsError: new Error('403') });
  const pane = failed.document.createElement('div');
  const shell = makeShell(failed.document, failed.calls);
  await failed.EditorView.appendParamsTable(pane, 't1', { projectLang: shell.projectLang });
  assert.equal(pane.childNodes.length, 0);
});

test('V3: parameters that exist are drawn, through the language probe the view was handed', async () => {
  const env = load({ params: { params: ['email', 'plan'], examples: [{ data: ['a@b.c', 'pro'] }] } });
  render(env);
  await settle();
  const pane = env.document.getElementById('root').querySelector('#tc-view-body');
  const table = pane.querySelector('.tc-params-table');
  assert.deepEqual(table.querySelectorAll('th').map((th) => th.textContent), ['email', 'plan']);
  assert.deepEqual(table.querySelectorAll('td').map((td) => td.textContent), ['a@b.c', 'pro']);
  assert.equal(pane.querySelector('.tc-params-view h3').textContent, 'Parameters 1');
  // The probe stays editor.js's — the view calls the one it was handed, once, and memoises nothing.
  assert.equal(env.calls.projectLang, 1);
});
