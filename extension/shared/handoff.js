// Host handoff (IIFE global `Handoff`) — how a desktop app that launched this browser with the
// extension loaded hands the panel a ready session instead of asking the tester to paste a token.
//
// The host drops `handoff.json` next to the manifest and opens the panel. A file, not a command
// line: `--load-extension` argv is readable by every process on the machine, and these are
// credentials. `chrome.runtime.getURL()` reads it back from any of our own documents.
//
// The file STAYS. `jwt` is memory-only in api.js, so a panel reload has nothing left to read
// unless the host's copy is still there; the host clears it when its browser closes. Disconnect
// cannot delete a file it does not own, so it leaves a tombstone and a newer push wins.
//
// Loaded by the panel, the editor and the viewer — all three configure the API for themselves.

/* global TestomatAPI, state, hostOf, commitSettings, openRunFromUrl, openRunsView,
   fillSettingsForm, renderProjectBar */

const Handoff = (() => {
  const FILE = 'handoff.json';
  // chrome.storage.local, and deliberately outside HOST_SCOPED_KEYS: Disconnect erases those and
  // reloads, and this is the one mark that has to survive that to stop the file re-connecting us.
  const DECLINED_KEY = 'handoffDeclinedAt';
  // chrome.storage.session — the `at` of the last run we opened, so a reload restores the tester's
  // own place instead of jumping back to whatever the host last asked for.
  const OPENED_KEY = 'handoffOpenedAt';

  // The offer this document is running on. `undefined` until read; null when there is none.
  // Held rather than re-read so `configure()` can stay synchronous — it sits on paths (a tab
  // switch) where an await would let a request go out between dropping one credential and
  // installing the next.
  let offered;

  const hasChromeStorage = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;

  // A settings object holds a usable credential when it carries the account's own token, or when a
  // host handed one over. Every document's "is this configured" check goes through here.
  const credentialed = (s) => !!(s && s.baseUrl && (s.apiToken || s.handoff));

  async function readFile() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return null;
    let doc;
    try {
      const res = await fetch(chrome.runtime.getURL(FILE), { cache: 'no-store' });
      if (!res.ok) return null;
      doc = await res.json();
    } catch {
      return null; // no host, no file — the ordinary case
    }
    if (!doc?.baseUrl || !doc.projectId || !doc.jwt || !doc.projectToken) return null;
    return { ...doc, app: String(doc.app || '').trim(), at: Number(doc.at) || 0 };
  }

  // A push the tester has already dismissed. Compared by `at`, so the host only has to write a
  // fresher file to offer the connection again.
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

  // Point the API at these settings — with the host's session token when they are a handoff's.
  // Every document that calls TestomatAPI.configure() calls this instead, settings of either kind:
  // pointing at an account token has to CLEAR a session handed over earlier, or a Save would keep
  // authenticating as whoever the host was.
  function configure(settings) {
    TestomatAPI.configure(settings);
    const h = settings?.handoff ? offer() : null;
    TestomatAPI.useHandoffSession(h?.jwt || null);
  }

  // ---- panel only ----------------------------------------------------------

  // Adopt the offer as the active connection. Persists everything but the session token: that one
  // belongs to the host, and api.js keeps it in memory alone.
  async function connect() {
    const h = offer();
    if (!h) return null;
    const host = hostOf(h.baseUrl);
    if (!host) return null;
    // Per-host preferences (evidence window, full-page capture…) are the tester's, not the host's.
    const prior = state.hostSettings[host] || {};
    const settings = {
      ...prior,
      baseUrl: h.baseUrl,
      projectId: h.projectId,
      projectToken: h.projectToken,
      handoff: true,
    };
    // An account token left beside a handoff would outlive the host's own session and silently
    // become the credential again.
    delete settings.apiToken;
    await commitSettings(settings, host);
    configure(settings);
    return h;
  }

  // The run the host asked for, opened once per push. Runs where the panel's own run intent does,
  // so the project switcher is up and openRunFromUrl has a connection to check against.
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

  // The host poking a panel that is already open. Reported back as a value, because the host is
  // waiting on it and a toast inside a side panel is not an answer it can read.
  async function apply() {
    const h = await ready(true);
    if (!h) return { ok: false, reason: 'no-offer' };
    await connect();
    fillSettingsForm();
    renderProjectBar();
    const run = await openRun();
    // The connect screen has no tabs to leave by, so a panel that was never signed in has to be
    // moved off it — where a Save lands, when the host named no run.
    if (!run && state.view === 'settings') openRunsView();
    return { ok: true, projectId: h.projectId, run };
  }

  // Disconnect, for a connection the panel did not choose: the file is the host's to delete, so
  // this marks the offer as answered instead.
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
