#!/usr/bin/env node
// #151: every capture starts with "which tab is the site under test?". extension/shared/site-tab.js
// answers it — the active tab, or the last real site tab standing in when the tester wandered off to
// chrome://extensions, or the one sentence they read when there is genuinely nothing to work on. It
// also strips a URL to the origin the evidence recorder registers its script for.
// Also covers extension/shared/site-access.js, which is a shape mapping over the same answer.
// Run: node --test tests/site-tab.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, chromeFake, plain } from './helpers/shared-harness.mjs';

// No chrome at all: originOf and the copy are pure, and hasSession() guards on `typeof chrome`.
const pure = () => loadInto({ URL, console }, [['shared/site-tab.js', 'SiteTab']]).value;

// A fresh sandbox per case — a shared one would let one row's bound target leak into the next.
function load(opts = {}) {
  const h = chromeFake(opts);
  const sandbox = { URL, console, chrome: h.chrome };
  if (opts.viewMode) sandbox.ViewMode = opts.viewMode;
  const { value: SiteTab } = loadInto(sandbox, [['shared/site-tab.js', 'SiteTab']]);
  return { ...h, SiteTab };
}

const SHOP = { id: 7, url: 'https://shop.example.com/cart', windowId: 1, active: true };
const SYSTEM = { id: 3, url: 'chrome://extensions', windowId: 1, active: true };
const WIN = [{ id: 1 }];
const bound = (tabId = 7, origin = 'https://shop.example.com') => ({ siteTarget: { tabId, origin, at: 1 } });

// Pasted from the source, curly apostrophes and ellipsis included — retyping them is how this drifts.
const RESTRICTED = 'Chrome doesn’t allow extensions on this page (chrome://…, the Web Store, '
  + 'another extension’s page), so it can’t be used — switch to the site under test.';

test('T1: an ordinary page gives back the site it is on, without the path', () => {
  assert.equal(pure().originOf('https://a.example.com/x?y#z'), 'https://a.example.com');
});

test('T2: a site running on a port loses the port, so every port of it is covered', () => {
  // Chrome match patterns cannot carry a port, so recording localhost:3000 registers the hook on
  // every port of localhost. Deliberate — pinned so the loss stays deliberate.
  assert.equal(pure().originOf('http://localhost:3000/a'), 'http://localhost');
});

test('T3: an https site on a custom port loses the port too', () => {
  assert.equal(pure().originOf('https://a.example.com:8443/'), 'https://a.example.com');
});

test('T4: a link carrying a username and password keeps neither', () => {
  assert.equal(pure().originOf('https://user:pw@a.example.com/p'), 'https://a.example.com');
});

test('T5: a site typed in capitals comes back in lower case', () => {
  assert.equal(pure().originOf('HTTPS://A.Example.COM/'), 'https://a.example.com');
});

test('T6: a site with a non-Latin name comes back in the punycode form Chrome matches on', () => {
  assert.equal(pure().originOf('https://пример.укр/шлях'), 'https://xn--e1afmkfd.xn--j1amh');
});

test('T7: a site reached by its IPv6 address keeps its brackets', () => {
  assert.equal(pure().originOf('https://[::1]:8080/'), 'https://[::1]');
});

test('T8: anything that is not an ordinary web page has no site at all', () => {
  const S = pure();
  for (const url of ['chrome://extensions', 'file:///tmp/a.html', 'about:blank',
    'chrome-extension://abc/p.html', 'data:text/html,hi', 'not a url', '', null, undefined]) {
    assert.equal(S.originOf(url), null, String(url));
  }
  assert.equal(S.originOf('https://a.example.com/'), 'https://a.example.com'); // a real one still works
});

test('T9: the sentence a tester reads on a page Chrome keeps extensions off is exact', () => {
  assert.equal(pure().restrictedCopy(), RESTRICTED);
});

test('T10: the same sentence names whatever the tester was trying to do', () => {
  assert.equal(pure().restrictedCopy('recorded'), RESTRICTED.replace('used', 'recorded'));
  assert.equal(pure().restrictedCopy('captured'), RESTRICTED.replace('used', 'captured'));
});

test('T11: outside the extension there is no tab to find and the panel says so', async () => {
  const { value: SiteTab } = loadInto({ URL, console }, [['shared/site-tab.js', 'SiteTab']]);
  assert.deepEqual(plain(await SiteTab.resolveSiteTab()), {
    state: 'none', tab: null, origin: null, error: 'This feature needs the extension context',
  });
});

test('T12: the shop the tester is looking at is the answer, and is remembered for later', async () => {
  const h = load({ tabs: [SHOP], windows: WIN });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'ok');
  assert.equal(site.origin, 'https://shop.example.com');
  assert.equal(site.error, null);
  assert.equal('viaTarget' in site, false); // this one is the active tab, not a stand-in
  assert.equal(h.session.data.siteTarget.tabId, 7);
  assert.equal(h.session.data.siteTarget.origin, 'https://shop.example.com');
  assert.equal(typeof h.session.data.siteTarget.at, 'number');
});

test('T13: on a Chrome page with nothing remembered the tester gets the one sentence', async () => {
  const h = load({ tabs: [SYSTEM], windows: WIN });
  const site = await h.SiteTab.resolveSiteTab({ verb: 'captured' });
  assert.equal(site.state, 'system-page');
  assert.equal(site.tab.id, 3);
  assert.equal(site.origin, null);
  assert.equal(site.error, RESTRICTED.replace('used', 'captured'));
});

test('T14: with the shop still open, a detour to a Chrome page still captures the shop', async () => {
  const h = load({
    tabs: [SYSTEM, { ...SHOP, active: false }], windows: WIN, session: bound(),
  });
  const site = await h.SiteTab.resolveSiteTab({ activate: true });
  assert.equal(site.state, 'ok');
  assert.equal(site.viaTarget, true);
  assert.equal(site.origin, 'https://shop.example.com');
  assert.deepEqual(plain(h.updates), [{ id: 7, props: { active: true } }]); // brought to the front
});

test('T15: without asking for it, standing in for the shop does not move the tester\'s tabs', async () => {
  const h = load({ tabs: [SYSTEM, { ...SHOP, active: false }], windows: WIN, session: bound() });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.viaTarget, true);
  assert.equal(h.updates.length, 0);
  // …while the very same setup with activate:true does move it.
  const h2 = load({ tabs: [SYSTEM, { ...SHOP, active: false }], windows: WIN, session: bound() });
  await h2.SiteTab.resolveSiteTab({ activate: true });
  assert.equal(h2.updates.length, 1);
});

test('T16: a shop left open in another window does not stand in for this one', async () => {
  const h = load({
    tabs: [SYSTEM, { ...SHOP, active: false, windowId: 2 }], windows: WIN, session: bound(),
  });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'system-page');
  assert.equal(h.session.data.siteTarget.tabId, 7); // still bound: the tab is fine, just elsewhere
});

test('T17: a remembered tab the tester has closed is forgotten instead of asked for again', async () => {
  const h = load({ tabs: [SYSTEM], windows: WIN, session: bound(), getFail: new Set([7]) });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'system-page');
  assert.equal('siteTarget' in h.session.data, false);
  assert.deepEqual(plain(h.session.removes), ['siteTarget']);
});

test('T18: a remembered tab that has since gone to a Chrome page is kept, not forgotten', async () => {
  const h = load({
    tabs: [SYSTEM, { id: 7, url: 'chrome://newtab', windowId: 1, active: false }],
    windows: WIN, session: bound(),
  });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'system-page');
  assert.equal(h.session.data.siteTarget.tabId, 7); // only the address failed; the binding stands
  assert.equal(h.session.removes.length, 0);
});

test('T19: when Chrome will not answer about this window, the last focused one answers instead', async () => {
  const h = load({
    tabs: [SHOP], windows: WIN, currentWindowId: 1,
    queryFail: (q) => q.windowId != null,
  });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'ok');
  assert.equal(site.origin, 'https://shop.example.com');
  assert.deepEqual(h.queries.map((q) => Object.keys(q).join('+')),
    ['active+windowId', 'active+lastFocusedWindow']);
});

test('T20: with no tab in front and nothing remembered, the tester is asked to focus the site', async () => {
  const h = load({ tabs: [], windows: WIN });
  assert.deepEqual(plain(await h.SiteTab.resolveSiteTab()), {
    state: 'none', tab: null, origin: null, error: 'No active tab — focus the site under test',
  });
});

test('T21: a Chrome page is never remembered as the site under test', async () => {
  const h = load({ tabs: [], windows: WIN });
  assert.equal(await h.SiteTab.rememberTab({ id: 5, url: 'chrome://x' }), false);
  assert.equal(h.session.sets.length, 0);
  // The same call with a real site does write.
  assert.equal(await h.SiteTab.rememberTab({ id: 5, url: 'https://shop.example.com/a' }), true);
  assert.equal(h.session.sets.length, 1);
});

test('T22: remembering the tab that is already remembered writes nothing', async () => {
  const h = load({ tabs: [], windows: WIN, session: bound() });
  assert.equal(await h.SiteTab.rememberTab({ id: 7, url: 'https://shop.example.com/other' }), true);
  assert.equal(h.session.sets.length, 0);
  // A different tab of the same shop is a different binding, and does write.
  assert.equal(await h.SiteTab.rememberTab({ id: 8, url: 'https://shop.example.com/a' }), true);
  assert.equal(h.session.sets.length, 1);
});

test('T23: a storage hiccup while remembering does not break the toolbar click', async () => {
  const h = load({ tabs: [], windows: WIN, sessionFail: { set: true } });
  assert.equal(await h.SiteTab.rememberTab({ id: 5, url: 'https://shop.example.com/a' }), false);
  assert.equal(h.session.sets.length, 1); // it was attempted, and the rejection was swallowed
});

test('T24: closing some other tab never unbinds the site the tester moved to', async () => {
  const h = load({ tabs: [], windows: WIN, session: bound() });
  assert.equal(await h.SiteTab.forgetTab(9), false);
  assert.equal(h.session.data.siteTarget.tabId, 7);
  assert.equal(h.session.removes.length, 0);
});

test('T25: closing the bound tab unbinds it', async () => {
  const h = load({ tabs: [], windows: WIN, session: bound() });
  assert.equal(await h.SiteTab.forgetTab(7), true);
  assert.equal('siteTarget' in h.session.data, false);
});

test('T26: forgetting without naming a tab unbinds whatever was bound', async () => {
  const h = load({ tabs: [], windows: WIN, session: bound() });
  assert.equal(await h.SiteTab.forgetTab(null), true);
  assert.equal('siteTarget' in h.session.data, false);
});

test('T27: with the panel in its own window, the site is looked for in the normal one', async () => {
  const h = load({
    tabs: [{ ...SHOP, windowId: 3 }], windows: [{ id: 9 }], currentWindowId: 9,
    viewMode: { isPanelWindow: async () => true, normalWindowId: async () => 3 },
  });
  const site = await h.SiteTab.resolveSiteTab();
  assert.equal(site.state, 'ok');
  assert.equal(h.queries[0].windowId, 3); // window 9 is ours, so it was skipped
});

test('T28: the editor page has no window mode at all and still resolves without throwing', async () => {
  const h = load({ tabs: [SHOP], windows: WIN });
  assert.equal((await h.SiteTab.resolveSiteTab()).state, 'ok');
  assert.equal(h.queries[0].windowId, 1);
  // …and with no window to be had either, it falls straight to the last focused one.
  const h2 = load({ tabs: [SHOP], windows: [], currentWindowId: 1 });
  assert.equal((await h2.SiteTab.resolveSiteTab()).state, 'ok');
  assert.deepEqual(h2.queries.map((q) => Object.keys(q).join('+')), ['active+lastFocusedWindow']);
});

test('T29: a stand-in tab that is already in front is not activated again', async () => {
  const h = load({
    tabs: [SHOP], windows: WIN, session: bound(), queryFail: () => true,
  });
  const site = await h.SiteTab.resolveSiteTab({ activate: true });
  assert.equal(site.viaTarget, true);
  assert.equal(h.updates.length, 0); // it is the tab in front already
});

test('T30: a stand-in tab that refuses to come forward is still the answer', async () => {
  const h = load({
    tabs: [SYSTEM, { ...SHOP, active: false }], windows: WIN, session: bound(), updateFail: true,
  });
  const site = await h.SiteTab.resolveSiteTab({ activate: true });
  assert.equal(site.state, 'ok');
  assert.equal(site.tab.id, 7);
  assert.equal(h.updates.length, 1); // it was asked, and the refusal was swallowed
});

// ---- shared/site-access.js: the same answer, in the shape its callers read ----

function loadAccess(site) {
  const calls = [];
  const sandbox = { console, resolveSiteTab: async (...args) => { calls.push(args); return site; } };
  const { value: SiteAccess } = loadInto(sandbox, [['shared/site-access.js', 'SiteAccess']]);
  return { SiteAccess, calls };
}

test('T31: when the site is there, the caller is told yes and handed the tab', async () => {
  const tab = { id: 7 };
  const { SiteAccess } = loadAccess({ state: 'ok', tab, origin: 'https://shop.example.com', error: null });
  assert.deepEqual(plain(await SiteAccess.ensureSiteAccess()), {
    ok: true, state: 'ok', tab: { id: 7 }, origin: 'https://shop.example.com',
  });
});

test('T32: when there is no site, the caller is told no and the tab is null, never missing', async () => {
  const restricted = loadAccess({ state: 'system-page', tab: { id: 3 }, origin: null, error: RESTRICTED });
  assert.deepEqual(plain(await restricted.SiteAccess.ensureSiteAccess()), {
    ok: false, state: 'system-page', tab: { id: 3 }, error: RESTRICTED,
  });
  // A state that names no tab at all still answers with null: the callers read `.tab` unguarded.
  const none = loadAccess({ state: 'none', error: 'No active tab — focus the site under test' });
  const out = await none.SiteAccess.ensureSiteAccess();
  assert.equal(out.tab, null);
  assert.equal('tab' in out, true);
  assert.deepEqual(plain(out),
    { ok: false, state: 'none', tab: null, error: 'No active tab — focus the site under test' });
});
