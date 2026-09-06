// The three erase paths — Forget instance, Disconnect, Sign out — and the warning a failed recorder
// stop leaves for the next panel. screens/settings.js delegates; app.js wires three of them to buttons.

/* global $, state, hasChrome, hostOf, setStatusLine, ConfirmDialog, Handoff, Theme, ViewMode,
   setSettingsFields, populateHostHistory, updateTokenHelpLink, syncTokenField */

// ---------- forget / sign out (#177) ----------
// Save writes the token three ways — `settings`, `hostSettings[host]` and a
// `hostHistory` row — so an exit has to remove all three.

// Cold boot after an erase: init() re-reads storage, so every in-memory copy of
// the erased data dies with the document. A late `set({session})` holds no credential.
const reloadPanel = () => location.reload();

// Everything scoped to ONE instance — `offlineQueue` holds results (with the raw
// tester comment) that never reached the server.
const HOST_SCOPED_KEYS = ['settings', 'session', 'offlineQueue'];

// A timeout is a FAILURE, not a success — the recorder may still be holding the
// buffer we promised to erase.
const EVIDENCE_WIPE_MS = 5000;

// PAGE sessionStorage, like `tcReturn`: not an area the erase claims to wipe, holds
// no credential, and dies with the browser — which is when the buffer dies too.
const EVIDENCE_WIPE_WARN_KEY = 'signOutRecorderWarning';
const evidenceWipeWarning = (why, lead) => `${lead} — but the console & network `
  + `recording could not be stopped: ${why}. Assume its log is still on this machine until you `
  + `restart the browser.`;

const SettingsErase = {
  HOST_SCOPED_KEYS,

  // The host the FORM points at, else the active one. A NON-EMPTY field that does
  // not parse resolves to nothing — a destructive control must never retarget.
  formHost() {
    const typed = ($('set-baseurl').value || '').trim();
    if (typed) return hostOf(typed);
    return (state.settings && hostOf(state.settings.baseUrl)) || null;
  },

  // Storage is written FIRST and in-memory state follows only on success, so a
  // rejected write leaves the panel unchanged — never a silent half-erase.
  failed(what, e, statusId = 'settings-forget-status') {
    state.booting = false; // no erase happened — the session writer may run again
    setStatusLine(statusId,
      `Couldn't finish ${what}: ${e.message || e} — assume the data is still on this machine, try again`,
      'error');
  },

  // Forgets the instance the panel is ON, whatever the Instance field is showing;
  // it ends on the connect screen, since nothing is left to run.
  // `statusId` is the caller's: the choose-a-project screen (screens/project-pick.js) offers the
  // same Disconnect, and the Connection card's own line is on a page nobody can reach from there.
  disconnect({ statusId = 'connection-status' } = {}) {
    const host = (state.settings && hostOf(state.settings.baseUrl)) || SettingsErase.formHost();
    return SettingsErase.forget({ host, verb: 'Disconnect', statusId });
  },

  // `opts.host` targets an instance explicitly (Disconnect); with none, the host
  // the FORM points at — what the Advanced button means by "this".
  async forget(opts = {}) {
    const verb = opts.verb || 'Forget';
    const statusId = opts.statusId || 'settings-forget-status';
    const host = opts.host || SettingsErase.formHost();
    if (!host) {
      const typed = ($('set-baseurl').value || '').trim();
      setStatusLine(statusId, typed
        ? `"${typed}" is not a valid instance URL — nothing was forgotten`
        : 'No instance to forget', 'error');
      return;
    }
    // A half-typed Instance field is not a saved instance — never report a host
    // we never held as erased.
    const active = !!(state.settings && hostOf(state.settings.baseUrl) === host);
    if (!state.hostSettings[host] && !active) {
      setStatusLine(statusId, `Nothing saved for ${host}`, 'error');
      return;
    }
    const ok = await ConfirmDialog.ask(
      `${verb} ${host}? Its saved token, project and preferences are deleted from this browser`
      + (active ? ', together with its restored session, any queued results still waiting to be sent, '
        + 'and this session\'s recorded steps, captured log and unsaved drafts — a running recording '
        + 'is stopped for you' : '')
      + '. Other instances are kept.', verb);
    if (!ok) return;
    const hostSettings = { ...state.hostSettings };
    delete hostSettings[host];
    const hostHistory = (state.hostHistory || []).filter((h) => h !== host);
    if (active) state.booting = true; // quiet the session writer over the erase
    // #192: forgetting the ACTIVE instance also drops the session-scoped data
    // (steps, evidence buffer, drafts). The stop comes FIRST (#183); failure is HELD.
    let wipeError = null;
    if (active) { try { await SettingsErase.wipeRecording(); } catch (e) { wipeError = e; } }
    try {
      if (hasChrome) {
        await chrome.storage.local.set({ hostSettings, hostHistory });
        if (active) {
          await chrome.storage.local.remove(HOST_SCOPED_KEYS);
          if (chrome.storage.session) await chrome.storage.session.clear();
          // A host's offer is a file we cannot delete, and the reload below would take it straight
          // back — so leaving one is what makes Disconnect stick.
          if (state.settings && state.settings.handoff) await Handoff.decline();
        }
      }
    } catch (e) { SettingsErase.failed(`forgetting ${host}`, e, statusId); return; }
    state.hostSettings = hostSettings;
    state.hostHistory = hostHistory;
    // As before its first Save. A failed recorder stop rides the reload, like sign out's.
    if (active) {
      state.settings = null;
      if (wipeError) SettingsErase.leaveWarning(wipeError, 'Instance forgotten');
      reloadPanel();
      return;
    }
    setSettingsFields(state.settings || {}); // the form was showing the host we just erased
    populateHostHistory();
    updateTokenHelpLink();
    syncTokenField(); // the form points at the active host again
    setStatusLine(statusId, `${host} forgotten`, 'ok');
  },

  leaveWarning(e, lead) {
    try { sessionStorage.setItem(EVIDENCE_WIPE_WARN_KEY, evidenceWipeWarning(String((e && e.message) || e), lead)); }
    catch { /* sessionStorage unavailable — the erase still stands */ }
  },

  // One-shot. The erase that left this DID happen — what the user still has to know
  // is that the recording buffer may not be gone (`signOut` / `forgetInstance`).
  takeWarning() {
    let msg = null;
    try {
      msg = sessionStorage.getItem(EVIDENCE_WIPE_WARN_KEY);
      if (msg) sessionStorage.removeItem(EVIDENCE_WIPE_WARN_KEY);
    } catch { /* sessionStorage unavailable — nothing was stored either */ }
    if (msg) setStatusLine('settings-forget-status', msg, 'error');
  },

  // #183: `evidenceMirror` is only a copy of the worker's ring buffer — a RUNNING
  // recording writes it back ~2 s after a clear. Throws on anything but a clean wipe.
  async wipeRecording() {
    if (!hasChrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'EVIDENCE_WIPE' }).catch((e) => {
        // No worker to answer means no recording to stop — proceed, don't fail.
        if (/receiving end|Could not establish/i.test(String((e && e.message) || e))) return { ok: true };
        throw e;
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('the recorder did not answer in 5s')), EVIDENCE_WIPE_MS)),
    ]);
    if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || 'the recorder could not be stopped');
  },

  async signOut() {
    const ok = await ConfirmDialog.ask(
      'Sign out? Every saved token, instance, history entry, queued result, session, unsaved '
      + 'test draft, recorded step and captured log is deleted from this '
      + 'browser. A running recording is stopped for you. Site access stays — it is Chrome\'s own '
      + 'setting, under chrome://extensions → Details → Site access.', 'Sign out');
    if (!ok) return;
    state.booting = true; // quiet the session writer over the erase
    // BEFORE either clear(), or a live recorder re-mirrors its buffer over the wipe.
    // Its failure is HELD, not thrown — the token is the larger secret.
    let wipeError = null;
    try { await SettingsErase.wipeRecording(); } catch (e) { wipeError = e; }
    try {
      // clear(), not a key list: everything stored is a credential or scoped to one,
      // and that stays true for the next key someone adds. `session` too.
      if (hasChrome) {
        // Theme and the chosen surface (#208) are the only two keys that are neither
        // a credential nor scoped to one — carried ACROSS the wipe, not exempted.
        const theme = Theme.get();
        const surface = await ViewMode.mode();
        await chrome.storage.local.clear();
        if (chrome.storage.session) await chrome.storage.session.clear();
        if (theme !== 'system') await Theme.set(theme);
        if (surface !== 'sidepanel') await ViewMode.setMode(surface);
      }
    // A failed CLEAR still aborts, on Sign out's OWN status line — an error shown
    // inside Advanced's collapsed fold is an error nobody sees.
    } catch (e) { SettingsErase.failed('signing out', e, 'signout-status'); return; }
    state.settings = null;
    // The warning rides the reload instead of being shown in a doomed document.
    if (wipeError) SettingsErase.leaveWarning(wipeError, 'Signed out');
    reloadPanel();
  },
};
