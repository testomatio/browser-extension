// How a desktop app that launched this browser hands the panel a ready session instead of a token.

/* global TestomatAPI, state, hostOf, commitSettings, openRunFromUrl, openRunsView,
   RunsUrl, fillSettingsForm, renderProjectBar */

const Handoff = (() => {
  // A file, not argv: any process can read `--load-extension` argv, and these are credentials.
  const FILE = 'handoff.json';
  // Not in HOST_SCOPED_KEYS: it must survive Disconnect's erase, or the file reconnects us.
  const DECLINED_KEY = 'handoffDeclinedAt';
  // The `at` of the last run opened, so a reload keeps the tester's place over the host's last ask.
  const OPENED_KEY = 'handoffOpenedAt';

  // Held so configure() stays sync: an await could let a request out between two credentials.
  let offered;

  const hasChromeStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

  const credentialed = (s) => !!(s && s.baseUrl && (s.apiToken || s.handoff));

  // The store writes `update_url` into what it installs, and only an unpacked copy can hold the file.
  const fromStore = () => { try { return !!chrome.runtime.getManifest?.().update_url; } catch { return false; } };

  async function readFile() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return null;
    if (fromStore()) return null; // asking anyway logs a red ERR_FILE_NOT_FOUND on every open
    let doc;
    try {
      const res = await fetch(chrome.runtime.getURL(FILE), { cache: 'no-store' });
      if (!res.ok) return null;
      doc = await res.json();
    } catch {
      return null; // no host, no file — the ordinary case
    }
    // `projectToken` is optional: the session can read a project's key itself.
    if (!doc?.baseUrl || !doc.projectId || !doc.jwt) return null;
    // https only, like Save: the session token and every later call would otherwise go in clear text.
    let scheme;
    try { scheme = new URL(doc.baseUrl).protocol; } catch { return null; }
    if (scheme !== 'https:') return null;
    return { ...doc, app: String(doc.app || '').trim(), at: Number(doc.at) || 0 };
  }

  // Compared by `at`, so the host only has to write a fresher file to offer the connection again.
  async function declined(h) {
    if (!hasChromeStorage()) return false;
    try {
      const at = Number((await chrome.storage.local.get(DECLINED_KEY))[DECLINED_KEY]) || 0;
      return h.at <= at;
    } catch {
      return false;
    }
  }

  // Read the file once per document; `reread` is the host pushing a new one into a live panel.
  async function ready(reread) {
    if (offered !== undefined && !reread) return offered;
    const h = await readFile();
    offered = h && !(await declined(h)) ? h : null;
    return offered;
  }

  /** The offer in hand — null until `ready()` has resolved at least once. */
  const offer = () => offered || null;

  // An account token must clear an earlier handed-over session, or Save stays signed in as the host.
  function configure(settings) {
    const h = settings?.handoff ? offer() : null;
    // The host's project key is memory-only (PRIVACY.md), so it is merged back here from the offer.
    TestomatAPI.configure(h?.projectToken
      ? { ...settings, projectToken: h.projectToken, projectTokenFor: h.projectId }
      : settings);
    TestomatAPI.useHandoffSession(h?.jwt || null);
  }

  // Persists all but the session token: that is the host's, and api.js keeps it in memory alone.
  async function connect() {
    const h = offer();
    if (!h) return null;
    const host = hostOf(h.baseUrl);
    if (!host) return null;
    // An offer is an overlay: when the host takes the file away, the tester's own token is still there.
    const prior = state.hostSettings[host] || {};
    const settings = {
      ...prior,
      baseUrl: h.baseUrl,
      projectId: h.projectId,
      // Never written down (PRIVACY.md); named so an older one is cleared, not left over a newer project.
      projectToken: undefined,
      projectTokenFor: undefined,
      handoff: true,
      // Kept because the card outlives the file: the tester must learn whose session just ended.
      handoffApp: h.app,
    };
    await commitSettings(settings, host);
    configure(settings);
    return h;
  }

  // Runs where the panel's own run intent does, so the switcher is up and there is a connection.
  async function openRun() {
    const h = offer();
    if (!h?.runUrl) return false;
    let opened = 0;
    try {
      opened = Number((await chrome.storage.session.get(OPENED_KEY))[OPENED_KEY]) || 0;
    } catch { /* no session storage — opening it again beats never opening it */ }
    if (h.at <= opened) return false;
    try { await chrome.storage.session.set({ [OPENED_KEY]: h.at }); } catch { /* best effort */ }
    // Consumed either way: a run that will not open is not worth re-trying on every reload.
    return openRunFromUrl(h.runUrl);
  }

  // Answered as a value: the host is waiting on it and cannot read a toast inside a side panel.
  async function apply() {
    const h = await ready(true);
    if (!h) return { ok: false, reason: 'no-offer' };
    await connect();
    fillSettingsForm();
    renderProjectBar();
    // A just-opened panel consumed the push at boot, so openRun() is false for the run it shows.
    const run = (await openRun()) || showingRun(h);
    // The connect screen has no tabs to leave by, so a never-signed-in panel is moved off it.
    if (!run && state.view === 'settings') openRunsView();
    return { ok: true, projectId: h.projectId, run };
  }

  // Opened by the panel's own boot, or still open from an earlier push the tester never left.
  function showingRun(h) {
    if (!h.runUrl || (state.view !== 'run' && state.view !== 'test')) return false;
    const parts = RunsUrl.parseParts(h.runUrl);
    return !!parts && parts.kind === 'run' && String(state.runId) === String(parts.id);
  }

  // The file is the host's to delete, so Disconnect marks the offer as answered instead.
  async function decline() {
    const h = await readFile();
    if (!h || !hasChromeStorage()) return;
    try { await chrome.storage.local.set({ [DECLINED_KEY]: h.at }); } catch { /* best effort */ }
    offered = null;
  }

  return { ready, offer, credentialed, configure, connect, openRun, apply, decline };
})();

// The host's entry point into a panel that is already open (a fresh one picks the file up at boot).
if (typeof window !== 'undefined') window.TestomatHandoff = Handoff;
