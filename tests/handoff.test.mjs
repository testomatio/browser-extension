#!/usr/bin/env node
// #148: a desktop app launches this browser for the tester and leaves a small file next to the
// extension saying which Testomat.io instance and project to use, plus a live session — so the
// tester never pastes a token. extension/shared/handoff.js decides what it accepts from that file,
// what it persists, and what it quietly ignores. The tester can decline, and the same file can push
// a run into a panel that is already open.
// Run: node --test tests/handoff.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, chromeFake, plain } from './helpers/shared-harness.mjs';

// Never a real credential: this repository is public.
const JWT = 'eyJ.fake.jwt';
const TOKEN = 'tstmt_fake';
const FULL = { baseUrl: 'https://app.testomat.io', projectId: 'p1', jwt: JWT, app: 'Testeiya', at: 1700 };

// `offered` is a module-level tri-state with no reset, so every case gets its own load.
function loadHandoff(opts = {}) {
  const {
    file = FULL, badJson = false, fetchThrows = false, noGetURL = false, notFound = false,
    local = {}, session = {}, localFail = {}, sessionFail = {},
    hostSettings = {}, view = 'run', runId = null,
    runParts = () => ({ kind: 'run', id: '55' }),
    openRunFromUrl = () => true,
    withWindow = false,
  } = opts;

  const h = chromeFake({ local, session, localFail, sessionFail });
  if (noGetURL) delete h.chrome.runtime.getURL;

  const fetches = [];        // every handoff.json read, in order
  let body = file;
  const fetchStub = async (url, init) => {
    fetches.push({ url, init });
    if (fetchThrows) throw new Error('fetch failed');
    return {
      ok: !notFound && body !== null,
      json: async () => {
        if (badJson) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    };
  };

  const calls = { configure: [], session: [], commit: [], openRun: [], parse: [] };
  let fills = 0;
  let bars = 0;
  let runsViews = 0;

  const sandbox = {
    console,
    chrome: h.chrome,
    fetch: fetchStub,
    URL,
    TestomatAPI: {
      configure: (s) => calls.configure.push(plain(s)),
      useHandoffSession: (t) => calls.session.push(t),
    },
    // The panel-only free globals, copied in behaviour from the panel's own.
    hostOf: (baseUrl) => { try { return new URL(baseUrl).hostname || null; } catch { return null; } },
    state: { hostSettings, view, runId },
    commitSettings: async (settings, host) => calls.commit.push({ settings: plain(settings), host }),
    fillSettingsForm: () => { fills += 1; },
    renderProjectBar: () => { bars += 1; },
    openRunFromUrl: async (url) => { calls.openRun.push(url); return openRunFromUrl(url); },
    openRunsView: () => { runsViews += 1; },
    parseRunUrlParts: (raw) => { calls.parse.push(raw); return runParts(raw); },
  };
  if (withWindow) sandbox.window = {};

  const { value: Handoff } = loadInto(sandbox, [['shared/handoff.js', 'Handoff']]);
  return {
    Handoff, ...h, fetches, calls, sandbox,
    setFile: (next) => { body = next; },
    counts: () => ({ fills, bars, runsViews }),
  };
}

test('H1: no host file next to the extension means no offer, and nothing breaks', async () => {
  // A body is served all the same, so the refusal is the 404 itself and nothing downstream of it.
  const h = loadHandoff({ notFound: true });
  assert.equal(await h.Handoff.ready(), null);
  assert.equal(h.fetches.length, 1);
  assert.equal(await loadHandoff({ file: null }).Handoff.ready(), null);
  // The same panel with a file present does get one.
  assert.equal((await loadHandoff().Handoff.ready()).projectId, 'p1');
});

test('H2: in a context that cannot address the extension\'s own files, nothing is even read', async () => {
  const h = loadHandoff({ noGetURL: true });
  assert.equal(await h.Handoff.ready(), null);
  assert.equal(h.fetches.length, 0);
});

test('H3: a host file that is not valid JSON is ignored', async () => {
  assert.equal(await loadHandoff({ badJson: true }).Handoff.ready(), null);
  assert.equal(await loadHandoff({ fetchThrows: true }).Handoff.ready(), null);
});

test('H4: a host file with no session token in it is refused', async () => {
  const { jwt, ...noJwt } = FULL; // everything else, timestamp included, is in order
  assert.equal(await loadHandoff({ file: noJwt }).Handoff.ready(), null);
  assert.equal((await loadHandoff({ file: { ...noJwt, jwt: JWT } }).Handoff.ready()).jwt, JWT);
});

test('H5: a host file that names no project is refused', async () => {
  const { projectId, ...noProject } = FULL;
  assert.equal(await loadHandoff({ file: noProject }).Handoff.ready(), null);
  assert.equal(await loadHandoff({ file: { ...FULL, baseUrl: undefined } }).Handoff.ready(), null);
  assert.equal((await loadHandoff({ file: FULL }).Handoff.ready()).projectId, 'p1');
});

test('H6: a host that sends no project key is still accepted — the session reads one itself', async () => {
  const offer = await loadHandoff({ file: { ...FULL, projectToken: undefined } }).Handoff.ready();
  assert.equal(offer.projectId, 'p1');
  assert.equal(offer.projectToken, undefined);
});

test('H7: the host app\'s name is trimmed and the timestamp is read as a number', async () => {
  const offer = await loadHandoff({ file: { ...FULL, app: '  Testeiya  ', at: '1700' } }).Handoff.ready();
  assert.equal(offer.app, 'Testeiya');
  assert.equal(offer.at, 1700);
});

test('H8: a push with no readable timestamp counts as zero, and is then never offered at all', async () => {
  // decline() reads the file itself, so the timestamp it marks is the normalised one.
  for (const at of [undefined, 'x']) {
    const h = loadHandoff({ file: { ...FULL, at } });
    await h.Handoff.decline();
    assert.equal(h.local.data.handoffDeclinedAt, 0, String(at));
  }
  // Zero is at or below the "nothing declined yet" mark, so such a file never becomes an offer.
  assert.equal(await loadHandoff({ file: { ...FULL, at: undefined } }).Handoff.ready(), null);
  assert.equal((await loadHandoff({ file: { ...FULL, at: 1 } }).Handoff.ready()).at, 1);
});

// A-P1-3: a file may not name a plain-http instance either — the same refusal Save gives a typed
// address ('Instance URL must be https://'), so the session token never goes out in clear text.
test('H9: a host file naming an http instance is refused', async () => {
  const h = loadHandoff({ file: { ...FULL, baseUrl: 'http://app.testomat.io' } });
  assert.equal(await h.Handoff.ready(), null);
  assert.equal(h.Handoff.offer(), null);
  // A self-hosted instance on the tester's own machine is refused on the same terms.
  assert.equal(await loadHandoff({ file: { ...FULL, baseUrl: 'http://localhost:3000' } }).Handoff.ready(), null);
  // The same instance over https is the offer it always was.
  assert.equal((await loadHandoff({ file: FULL }).Handoff.ready()).baseUrl, 'https://app.testomat.io');
});

test('H10: a host file whose instance address is not an address at all connects to nothing', async () => {
  const h = loadHandoff({ file: { ...FULL, baseUrl: 'javascript:x' } });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.connect(), null);
  assert.equal(h.calls.commit.length, 0);
});

test('H11: a push the tester already declined is not offered again', async () => {
  const h = loadHandoff({ file: { ...FULL, at: 500 }, local: { handoffDeclinedAt: 500 } });
  assert.equal(await h.Handoff.ready(), null);
});

test('H12: a fresher push from the host is offered even after a decline', async () => {
  const h = loadHandoff({ file: { ...FULL, at: 501 }, local: { handoffDeclinedAt: 500 } });
  assert.equal((await h.Handoff.ready()).at, 501);
});

test('H13: a broken store must not swallow the offer', async () => {
  const h = loadHandoff({ file: { ...FULL, at: 500 }, local: { handoffDeclinedAt: 500 }, localFail: { get: true } });
  assert.equal((await h.Handoff.ready()).at, 500); // unreadable decline mark = no decline
});

test('H14: the file is read once per panel, however often the offer is asked for', async () => {
  const h = loadHandoff();
  const first = await h.Handoff.ready();
  const second = await h.Handoff.ready();
  assert.equal(h.fetches.length, 1);
  assert.equal(second, first);
});

test('H15: a host pushing a new file into a live panel gets it re-read', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  h.setFile({ ...FULL, at: 1800 });
  assert.equal((await h.Handoff.ready(true)).at, 1800);
  assert.equal(h.fetches.length, 2);
});

test('H16: before the file has been read there is no offer in hand', async () => {
  const h = loadHandoff();
  assert.equal(h.Handoff.offer(), null);
  await h.Handoff.ready();
  assert.equal(h.Handoff.offer().projectId, 'p1'); // and after, there is
});

test('H17: saving the tester\'s own token clears whatever session a host handed over', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  h.Handoff.configure({ baseUrl: 'https://app.testomat.io', apiToken: 'TOKEN' });
  assert.deepEqual(h.calls.session, [null]);
  assert.deepEqual(h.calls.configure, [{ baseUrl: 'https://app.testomat.io', apiToken: 'TOKEN' }]);
});

test('H18: a panel that configures a handoff before reading the file gets no session at all', async () => {
  // The ordering trap: every document awaits ready() first. Pinned so a caller that skips it is caught.
  const h = loadHandoff();
  h.Handoff.configure({ baseUrl: 'https://app.testomat.io', handoff: true });
  assert.deepEqual(h.calls.session, [null]);
  // …and the same call after ready() does install the host's session.
  await h.Handoff.ready();
  h.Handoff.configure({ baseUrl: 'https://app.testomat.io', handoff: true });
  assert.deepEqual(h.calls.session, [null, JWT]);
});

test('H19: with the offer in hand, a handoff config runs on the host\'s session', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  h.Handoff.configure({ baseUrl: 'https://app.testomat.io', handoff: true });
  assert.deepEqual(h.calls.session, [JWT]);
});

test('H20: with no offer there is nothing to adopt and nothing is saved', async () => {
  const h = loadHandoff({ file: null });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.connect(), null);
  assert.equal(h.calls.commit.length, 0);
  // The same panel with a file does save.
  const h2 = loadHandoff();
  await h2.Handoff.ready();
  assert.notEqual(await h2.Handoff.connect(), null);
  assert.equal(h2.calls.commit.length, 1);
});

test('H21: adopting the offer keeps the tester\'s own token and their settings for that host', async () => {
  const prior = { apiToken: 'own', theme: 'dark' };
  const h = loadHandoff({ hostSettings: { 'app.testomat.io': prior } });
  await h.Handoff.ready();
  await h.Handoff.connect();
  assert.deepEqual(h.calls.commit, [{
    host: 'app.testomat.io',
    settings: {
      apiToken: 'own',
      theme: 'dark',
      baseUrl: 'https://app.testomat.io',
      projectId: 'p1',
      handoff: true,
      handoffApp: 'Testeiya',
    },
  }]);
  assert.deepEqual(h.calls.session, [JWT]); // and the API is pointed at the host's session
});

// A-P1-3: PRIVACY.md says project keys are memory-only, so the one a host sent is kept out of what
// commitSettings writes to chrome.storage.local and merged back into the API config instead.
test('H22: a project key a host sent stays in memory and never reaches the disk', async () => {
  const h = loadHandoff({ file: { ...FULL, projectToken: TOKEN } });
  await h.Handoff.ready();
  await h.Handoff.connect();
  const { settings } = h.calls.commit[0];
  assert.equal('projectToken' in settings, false);
  assert.equal('projectTokenFor' in settings, false);
  assert.equal(settings.projectId, 'p1'); // the rest of the offer is saved as before
  // …and the API is still handed the key, out of the offer held in memory.
  const cfg = h.calls.configure.at(-1);
  assert.equal(cfg.projectToken, TOKEN);
  assert.equal(cfg.projectTokenFor, 'p1');
});

test('H23: with no project key from the host, no stale one is left naming the project', async () => {
  const prior = { projectToken: 'old', projectTokenFor: 'p0' };
  const h = loadHandoff({ hostSettings: { 'app.testomat.io': prior } });
  await h.Handoff.ready();
  await h.Handoff.connect();
  const { settings } = h.calls.commit[0];
  assert.equal('projectToken' in settings, false); // both were overwritten with undefined
  assert.equal('projectTokenFor' in settings, false);
});

test('H24: a push that names no run opens nothing and marks nothing as consumed', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), false);
  assert.equal(h.session.sets.length, 0);
  assert.equal(h.calls.openRun.length, 0);
  // The same panel, with a run named, does open it and does write.
  const h2 = loadHandoff({ file: { ...FULL, runUrl: 'https://app.testomat.io/projects/p1/runs/55' } });
  await h2.Handoff.ready();
  assert.equal(await h2.Handoff.openRun(), true);
  assert.equal(h2.session.sets.length, 1);
});

const RUN_FILE = { ...FULL, at: 901, runUrl: 'https://app.testomat.io/projects/p1/runs/55' };

test('H25: a run the panel already opened for this push is not opened again', async () => {
  const h = loadHandoff({ file: { ...RUN_FILE, at: 900 }, session: { handoffOpenedAt: 900 } });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), false);
  assert.equal(h.calls.openRun.length, 0);
});

test('H26: a newer push opens its run once and records that it did', async () => {
  const h = loadHandoff({ file: RUN_FILE, session: { handoffOpenedAt: 900 } });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), true);
  assert.equal(h.session.data.handoffOpenedAt, 901);
  assert.deepEqual(plain(h.calls.openRun), ['https://app.testomat.io/projects/p1/runs/55']);
});

test('H27: when the panel cannot read what it opened last, it opens the run rather than never', async () => {
  const h = loadHandoff({ file: RUN_FILE, session: { handoffOpenedAt: 900 }, sessionFail: { get: true } });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), true);
  assert.deepEqual(plain(h.calls.openRun), ['https://app.testomat.io/projects/p1/runs/55']);
});

test('H28: when the panel cannot record what it opened, it still opens the run', async () => {
  const h = loadHandoff({ file: RUN_FILE, sessionFail: { set: true } });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), true);
  assert.equal(h.session.sets.length, 1); // attempted, and the rejection swallowed
});

test('H29: a run that will not open is not retried on every reload', async () => {
  const h = loadHandoff({ file: RUN_FILE, openRunFromUrl: () => false });
  await h.Handoff.ready();
  assert.equal(await h.Handoff.openRun(), false);
  assert.equal(h.session.data.handoffOpenedAt, 901); // consumed all the same
  assert.equal(await h.Handoff.openRun(), false);
  assert.equal(h.calls.openRun.length, 1); // and not asked for a second time
});

test('H30: a host poking a panel after its file is gone is told there is no offer', async () => {
  const h = loadHandoff({ file: null });
  assert.deepEqual(plain(await h.Handoff.apply()), { ok: false, reason: 'no-offer' });
  assert.equal(h.counts().fills, 0);
});

test('H31: a fresh push naming a run connects the panel, redraws it and opens the run', async () => {
  const h = loadHandoff({ file: RUN_FILE });
  const out = await h.Handoff.apply();
  assert.deepEqual(plain(out), { ok: true, projectId: 'p1', run: true });
  assert.deepEqual(h.counts(), { fills: 1, bars: 1, runsViews: 0 });
  assert.equal(h.calls.commit.length, 1);
});

test('H32: a host asking about the run its panel is already showing is told yes', async () => {
  // The panel consumed this push at boot, so openRun() answers false for the run it is showing.
  const h = loadHandoff({
    file: RUN_FILE, session: { handoffOpenedAt: 901 }, view: 'run', runId: '55',
  });
  const out = await h.Handoff.apply();
  assert.deepEqual(plain(out), { ok: true, projectId: 'p1', run: true });
  assert.equal(h.calls.openRun.length, 0);
});

test('H33: a panel still on the connect screen with no run named is moved off it', async () => {
  const h = loadHandoff({ file: FULL, view: 'settings' });
  const out = await h.Handoff.apply();
  assert.deepEqual(plain(out), { ok: true, projectId: 'p1', run: false });
  assert.equal(h.counts().runsViews, 1);
  // With a run to show, the panel is left where the run put it.
  const h2 = loadHandoff({ file: RUN_FILE, view: 'settings' });
  await h2.Handoff.apply();
  assert.equal(h2.counts().runsViews, 0);
});

test('H34: a link to a single test is not the run the host is asking about', async () => {
  const h = loadHandoff({
    file: RUN_FILE, session: { handoffOpenedAt: 901 }, view: 'run', runId: '55',
    runParts: () => ({ kind: 'test', id: '55' }),
  });
  assert.deepEqual(plain(await h.Handoff.apply()), { ok: true, projectId: 'p1', run: false });
});

test('H35: a run numbered 7 in the panel is the run numbered "7" in the host\'s link', async () => {
  const h = loadHandoff({
    file: RUN_FILE, session: { handoffOpenedAt: 901 }, view: 'run', runId: 7,
    runParts: () => ({ kind: 'run', id: '7' }),
  });
  assert.deepEqual(plain(await h.Handoff.apply()), { ok: true, projectId: 'p1', run: true });
});

test('H36: declining after the host\'s file is gone leaves the live offer standing', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  h.setFile(null);
  await h.Handoff.decline();
  assert.equal(h.Handoff.offer().projectId, 'p1'); // nothing was cleared
  assert.equal(h.local.sets.length, 0);
});

test('H37: declining marks the push as answered and drops the offer', async () => {
  const h = loadHandoff();
  await h.Handoff.ready();
  await h.Handoff.decline();
  assert.equal(h.local.data.handoffDeclinedAt, 1700);
  assert.equal(h.Handoff.offer(), null);
});

test('H38: a connection counts as set up with the tester\'s own token or with a host\'s session', () => {
  const { Handoff } = loadHandoff();
  assert.equal(Handoff.credentialed({ baseUrl: 'x' }), false);
  assert.equal(Handoff.credentialed({ baseUrl: 'x', apiToken: 't' }), true);
  assert.equal(Handoff.credentialed({ baseUrl: 'x', handoff: true }), true);
  assert.equal(Handoff.credentialed(null), false);
  assert.equal(Handoff.credentialed({ apiToken: 't' }), false); // an instance is required too
});

test('H39: the host\'s entry point is published on the page, and a page without one still loads', () => {
  const withWindow = loadHandoff({ withWindow: true });
  assert.equal(withWindow.sandbox.window.TestomatHandoff, withWindow.Handoff);
  assert.equal(typeof loadHandoff().Handoff.ready, 'function'); // no window, still loaded
});

test('H40: a project key the host sent is named with its own project, so a switch cannot send it', async () => {
  // api.js sends the key only while `projectTokenFor` is the open project, so the name travels
  // with it through configure() — a switch elsewhere mints that project's key instead.
  const h = loadHandoff({ file: { ...FULL, projectToken: TOKEN } });
  await h.Handoff.ready();
  await h.Handoff.connect();
  assert.equal(h.calls.configure.at(-1).projectTokenFor, 'p1');
  h.Handoff.configure({ baseUrl: 'https://app.testomat.io', projectId: 'p2', handoff: true });
  const moved = h.calls.configure.at(-1);
  assert.equal(moved.projectId, 'p2');
  assert.equal(moved.projectToken, TOKEN);
  assert.equal(moved.projectTokenFor, 'p1'); // still p1's key, and no longer the open project's
});
