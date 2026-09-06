#!/usr/bin/env node
// extension/sidepanel/core/gates.js (#202, the third seam out of core/views.js): the two walls that
// take the panel away from the tester — the lockout a read-only project raises in front of every
// screen, and the basic-mode strip that names the web login the panel is missing.
// The module needs `state`, `capabilities`, `views`, `$`, a `jwtAvailable` probe and a document, plus
// the two painters it reaches back into core/views.js for — updateContextBar and setImmersive, spied
// here rather than run. That is the seam's value: the sentence, the fallback host and the sweep over
// eight sections can be falsified without a tab bar, a navigation model or eight screen openers.
// tests/views.test.mjs keeps its own rows (V52-V60) over the same behaviour as the panel performs it,
// through the bare delegates every screen calls. The duplication is deliberate: those say the panel
// still behaves, these say what the two walls actually are.
// TRAP: `URL` is NOT a vm-realm global — panel-harness.mjs splices it in. Without it baseUrlHost
// silently takes its catch branch and every host row would pass for the wrong reason, so G6 pins a
// real hostname coming back rather than only pinning the fallback.
// Run: node --test tests/gates.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, CORE_SRC, makeDocument, el } from './helpers/panel-harness.mjs';

// core/state.js:7, verbatim — the eight sections the lockout sweeps, in the order it walks them.
const VIEWS = ['settings', 'pick', 'runs', 'tcstudio', 'tclist', 'promote', 'run', 'test'];

const SETTINGS = { baseUrl: 'https://app.testomat.io', projectId: 'p1' };

// index.html:149 for the blocking panel, :158 for the eight sections, :117-135 for the header row
// and the strip — cut to the nodes these two walls touch and nothing else.
function load(opts = {}) {
  const o = {
    settings: SETTINGS, readonly: false, jwt: true, view: 'runs', banner: true, ...opts,
  };
  const doc = makeDocument([]);
  const node = {};
  const mk = (tag, id, props = {}) => { node[id] = el(tag, { id, ...props }); return node[id]; };

  const contextBar = mk('div', 'context-bar', { hidden: false });
  contextBar.append(mk('button', 'btn-back', { hidden: false }));
  const main = el('main');
  main.append(mk('section', 'readonly-block', { hidden: true }));
  for (const v of VIEWS) main.append(mk('section', `view-${v}`, { hidden: true }));
  doc.body.append(contextBar, main);
  if (o.banner) {
    const banner = mk('div', 'degraded-banner', { hidden: true });
    banner.append(el('span', { className: 'banner-text degraded-banner-text' })); // index.html:135
    doc.body.append(banner);
  }

  const state = { view: o.view, settings: o.settings };
  const calls = { context: [], immersive: [] };

  const h = loadScreen('gates', {
    dir: CORE_SRC,
    document: doc,
    globals: {
      state,
      capabilities: { readonly: o.readonly, jwt: o.jwt },
      views: VIEWS,
      $: (id) => doc.getElementById(id),
      TestomatAPI: { jwtAvailable: () => o.jwt },
      // core/views.js's two painters. They load AFTER this file and are only ever reached at paint
      // time, so the forward reference is what the load order makes safe — spied, never run.
      updateContextBar: (view) => { calls.context.push(view); },
      setImmersive: (on) => { calls.immersive.push(on); },
    },
    exported: 'Gates',
  });

  return {
    ...h,
    node,
    state,
    calls,
    gates: h.screen,
    // Which of the eight sections a tester can actually see right now.
    shown: () => VIEWS.filter((v) => !node[`view-${v}`].hidden),
    text: () => node['degraded-banner'].querySelector('.degraded-banner-text').textContent,
  };
}

// ---------- the seam itself ----------

test('G1 (#202): the two walls load with state, capabilities, views, $ and a jwt probe — nothing else', () => {
  const h = load();
  assert.deepEqual(Object.keys(h.gates).sort(),
    ['applyReadonlyBlock', 'baseUrlHost', 'dismissDegradedBanner', 'updateDegradedBanner']);
  h.gates.applyReadonlyBlock();
  assert.deepEqual(h.shown(), ['runs'], 'an unlocked project shows the view it is standing on');
});

// ---------- the read-only lockout ----------

test('G2 (#202): the lockout leaves not one of the eight screens standing behind it', () => {
  const h = load({ readonly: true, view: 'run' });
  h.gates.applyReadonlyBlock();
  assert.equal(h.node['readonly-block'].hidden, false, 'the blocking panel is what is left');
  assert.deepEqual(h.shown(), [], 'v2 refuses GET too, so there is nothing behind it to show');
  assert.equal(h.doc.body.dataset.readonly, 'true', 'and the flag an end-to-end run reads is set');
});

test('G3 (#202): Settings is the one screen the lockout has to leave reachable', () => {
  const h = load({ readonly: true, view: 'settings' });
  h.gates.applyReadonlyBlock();
  assert.equal(h.node['readonly-block'].hidden, true);
  assert.deepEqual(h.shown(), ['settings'], 'or the tester could not switch project or sign out');
  assert.equal(h.doc.body.dataset.readonly, 'true', 'the panel still knows the project is locked');
});

test('G4 (#202): with nothing open behind it the lockout takes the header row down as well', () => {
  const h = load({ readonly: true, view: 'run' });
  h.gates.applyReadonlyBlock();
  assert.equal(h.node['context-bar'].hidden, true, 'Back and the title would both be lying');
  assert.equal(h.node['btn-back'].hidden, true);
  assert.deepEqual(h.calls.immersive, [false], 'and the panel is not immersed in anything either');
  assert.deepEqual(h.calls.context, [], 'there is no title to repaint while the block is up');
});

test('G5 (#202): unlocking hands the open screen and its header row straight back', () => {
  const h = load({ readonly: true, view: 'run' });
  h.gates.applyReadonlyBlock();

  h.fn.capabilities.readonly = false;
  h.gates.applyReadonlyBlock();
  assert.equal(h.node['readonly-block'].hidden, true);
  assert.deepEqual(h.shown(), ['run'], 'the screen the tester was on, and only it');
  assert.equal(h.doc.body.dataset.readonly, 'false');
  assert.deepEqual(h.calls.context, ['run'], 'the header row was repainted on the way out');
});

// ---------- where the tester has to sign in ----------

test('G6 (#202): the host is the saved base URL cut to its hostname — scheme, port and path gone', () => {
  assert.equal(load({ settings: { baseUrl: 'https://a.io' } }).gates.baseUrlHost(), 'a.io');
  assert.equal(load({ settings: { baseUrl: 'https://staging.testomat.io:8443/app?x=1' } })
    .gates.baseUrlHost(), 'staging.testomat.io');
  assert.equal(load({ settings: { baseUrl: 'http://localhost:3000/' } }).gates.baseUrlHost(), 'localhost');
});

test('G7 (#202): nothing saved, or nothing parseable, and the answer is "the web app"', () => {
  for (const baseUrl of ['', '   ', 'app.testomat.io', 'not a url', undefined, null]) {
    assert.equal(load({ settings: { baseUrl } }).gates.baseUrlHost(), 'the web app', String(baseUrl));
  }
  assert.equal(load({ settings: null }).gates.baseUrlHost(), 'the web app', 'and with no settings at all');
});

// ---------- the basic-mode strip ----------

test('G8 (#202): the strip says exactly what basic mode costs, and where to go and undo it', () => {
  const h = load({ jwt: false, settings: { baseUrl: 'https://a.io' } });
  h.gates.updateDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, false);
  assert.equal(h.text(),
    'Basic mode — steps are local-only; finish run, priority and custom statuses '
    + 'need an active a.io web login. Sign in there, then Refresh.');
});

test('G9 (#336): with nothing saved the sentence reads "the web app web login", and that is a gap', () => {
  const h = load({ jwt: false, settings: null });
  h.gates.updateDegradedBanner();
  assert.match(h.text(), /an active the web app web login/);
});

test('G10 (#202): the strip waits for a PROVEN missing login and never appears on a maybe', () => {
  for (const jwt of [true, undefined, null, 0, '']) {
    const h = load({ jwt, view: 'runs' });
    h.gates.updateDegradedBanner();
    assert.equal(h.node['degraded-banner'].hidden, true, `jwtAvailable() === ${String(jwt)}`);
  }
});

test('G11 (#202): the strip belongs to the two run screens, and nowhere else carries it', () => {
  for (const view of ['runs', 'run']) {
    const h = load({ jwt: false, view });
    h.gates.updateDegradedBanner();
    assert.equal(h.node['degraded-banner'].hidden, false, view);
  }
  for (const view of ['settings', 'pick', 'tcstudio', 'tclist', 'promote', 'test']) {
    const h = load({ jwt: false, view });
    h.gates.updateDegradedBanner();
    assert.equal(h.node['degraded-banner'].hidden, true, view);
  }
});

test('G12 (#155): under the lockout there is no basic mode to explain, so the strip stays down', () => {
  const h = load({ jwt: false, readonly: true, view: 'runs' });
  h.gates.updateDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, true);
});

test('G13 (#202): dismissing takes the strip down on the spot, and keeps it down all session', () => {
  const h = load({ jwt: false, view: 'runs' });
  h.gates.updateDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, false);

  h.gates.dismissDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, true, 'the repaint is part of the dismissal');
  h.state.view = 'run';
  h.gates.updateDegradedBanner();
  h.state.view = 'runs';
  h.gates.updateDegradedBanner();
  assert.equal(h.node['degraded-banner'].hidden, true, 'and it does not come back on the next screen');
});

test('G14 (#202): the dismissal is in memory only — the next panel session carries the strip again', () => {
  const first = load({ jwt: false, view: 'runs' });
  first.gates.dismissDegradedBanner();
  assert.equal(first.node['degraded-banner'].hidden, true);

  const second = load({ jwt: false, view: 'runs' });
  second.gates.updateDegradedBanner();
  assert.equal(second.node['degraded-banner'].hidden, false, 'nothing about it was written down');
});

test('G15 (#202): a page with no strip in it is not a crash — the two walls stand apart', () => {
  const h = load({ jwt: false, view: 'runs', banner: false });
  h.gates.updateDegradedBanner();
  h.gates.applyReadonlyBlock();
  assert.deepEqual(h.shown(), ['runs'], 'the lockout did its own half regardless');
});
