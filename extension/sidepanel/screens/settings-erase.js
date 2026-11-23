// The three erase paths (Forget instance, Disconnect, Sign out) and the warning a failed stop leaves.

/* global $, state, hasChrome, hostOf, setStatusLine, ConfirmDialog, Handoff, Theme, ViewMode,
   setSettingsFields, populateHostHistory, updateTokenHelpLink, syncTokenField */

// Save stores the token in settings, hostSettings[host] and hostHistory; an exit removes all three.

// Cold boot after an erase, so every in-memory copy of the erased data dies with the document.
const reloadPanel = () => location.reload();

// Everything scoped to one instance; offlineQueue holds unsent results with raw tester comments.
const HOST_SCOPED_KEYS = ['settings', 'session', 'offlineQueue'];

// A timeout is a failure: the recorder may still hold the buffer we promised to erase.
const EVIDENCE_WIPE_MS = 5000;

// Page sessionStorage: holds no credential and dies with the browser, which is when the buffer dies.
const EVIDENCE_WIPE_WARN_KEY = 'signOutRecorderWarning';

// The two recorders an erase stops, each in the words its warning uses.
const RECORDER_WIPES = [
  { type: 'EVIDENCE_WIPE', what: 'the console & network recording', left: 'its log', short: 'console & network' },
  { type: 'SCREENREC_WIPE', what: 'the screen recording', left: 'its video', short: 'screen' },
];
const evidenceWipeWarning = (failed, lead) => {
  const tail = 'still on this machine until you restart the browser.';
  if (failed.length === 1) {
    const [f] = failed;
    return `${lead} — but ${f.what} could not be stopped: ${f.why}. Assume ${f.left} is ${tail}`;
  }
  const whys = failed.map((f) => `${f.short}: ${f.why}`).join('; ');
  return `${lead} — but neither recording could be stopped (${whys}). Assume the log and the video are ${tail}`;
};

const SettingsErase = {
  HOST_SCOPED_KEYS,

  // The host the form points at, else the active one; an unparsable field never retargets an erase.
  formHost() {
    const typed = ($('set-baseurl').value || '').trim();
    if (typed) return hostOf(typed);
    return (state.settings && hostOf(state.settings.baseUrl)) || null;
  },

  // Storage is written first and memory follows on success, so a rejected write is never a half-erase.
  failed(what, e, statusId = 'settings-forget-status') {
    state.booting = false; // no erase happened — the session writer may run again
    setStatusLine(statusId,
      `Couldn't finish ${what}: ${e.message || e} — assume the data is still on this machine, try again`,
      'error');
  },

  // The instance the panel is on, whatever the field shows; `statusId` lets project-pick.js reuse it.
  disconnect({ statusId = 'connection-status' } = {}) {
    const host = (state.settings && hostOf(state.settings.baseUrl)) || SettingsErase.formHost();
    return SettingsErase.forget({ host, verb: 'Disconnect', statusId });
  },

  // With no `opts.host`, the host the form points at: what the Advanced button means by "this".
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
    // A half-typed Instance field is not a saved instance: never report a host we never held as erased.
    const active = !!(state.settings && hostOf(state.settings.baseUrl) === host);
    if (!state.hostSettings[host] && !active) {
      setStatusLine(statusId, `Nothing saved for ${host}`, 'error');
      return;
    }
    const ok = await ConfirmDialog.ask(
      `${verb} ${host}? Its saved token, project and preferences are deleted from this browser`
      + (active ? ', together with its restored session, any queued results still waiting to be sent, '
        + 'and this session\'s recorded steps, captured log, screen recording and unsaved drafts — a '
        + 'running recording is stopped for you' : '')
      + '. Other instances are kept.', verb);
    if (!ok) return;
    const hostSettings = { ...state.hostSettings };
    delete hostSettings[host];
    const hostHistory = (state.hostHistory || []).filter((h) => h !== host);
    if (active) state.booting = true; // quiet the session writer over the erase
    // The recorder stops before any clear, or it re-mirrors its buffer; its failure is held, not thrown.
    let wipeError = null;
    if (active) { try { await SettingsErase.wipeRecording(); } catch (e) { wipeError = e; } }
    try {
      if (hasChrome) {
        await chrome.storage.local.set({ hostSettings, hostHistory });
        if (active) {
          await chrome.storage.local.remove(HOST_SCOPED_KEYS);
          if (chrome.storage.session) await chrome.storage.session.clear();
          // A host's offer is a file we cannot delete and the reload would take it back, so decline it.
          if (state.settings && state.settings.handoff) await Handoff.decline();
        }
      }
    } catch (e) { SettingsErase.failed(`forgetting ${host}`, e, statusId); return; }
    state.hostSettings = hostSettings;
    state.hostHistory = hostHistory;
    // A failed recorder stop rides the reload, like sign out's.
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

  // `e.failed` names each recorder that would not stop; a bare error is the log recorder's.
  leaveWarning(e, lead) {
    const failed = (e && e.failed) || [{ ...RECORDER_WIPES[0], why: String((e && e.message) || e) }];
    try { sessionStorage.setItem(EVIDENCE_WIPE_WARN_KEY, evidenceWipeWarning(failed, lead)); }
    catch { /* sessionStorage unavailable — the erase still stands */ }
  },

  // One-shot: the erase did happen, but the recording buffer may not be gone.
  takeWarning() {
    let msg = null;
    try {
      msg = sessionStorage.getItem(EVIDENCE_WIPE_WARN_KEY);
      if (msg) sessionStorage.removeItem(EVIDENCE_WIPE_WARN_KEY);
    } catch { /* sessionStorage unavailable — nothing was stored either */ }
    if (msg) setStatusLine('settings-forget-status', msg, 'error');
  },

  // evidenceMirror only copies the worker's buffer: a running recording rewrites it ~2 s after a clear.
  async wipeOne(type) {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type }).catch((e) => {
        // No worker to answer means no recording to stop — proceed, don't fail.
        if (/receiving end|Could not establish/i.test(String((e && e.message) || e))) return { ok: true };
        throw e;
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('the recorder did not answer in 5s')), EVIDENCE_WIPE_MS)),
    ]);
    if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || 'the recorder could not be stopped');
  },

  // Both at once, so 5 s at most; the error's `failed` lists every recorder that would not stop.
  async wipeRecording() {
    if (!hasChrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const results = await Promise.allSettled(RECORDER_WIPES.map((w) => SettingsErase.wipeOne(w.type)));
    const failed = RECORDER_WIPES
      .map((w, i) => (results[i].status === 'rejected'
        ? { ...w, why: String((results[i].reason && results[i].reason.message) || results[i].reason) } : null))
      .filter(Boolean);
    if (!failed.length) return;
    const err = new Error(failed[0].why);
    err.failed = failed;
    throw err;
  },

  async signOut() {
    const ok = await ConfirmDialog.ask(
      'Sign out? Every saved token, instance, history entry, queued result, session, unsaved '
      + 'test draft, recorded step, captured log and screen recording is deleted from this '
      + 'browser. A running recording is stopped for you. Site access stays — it is Chrome\'s own '
      + 'setting, under chrome://extensions → Details → Site access.', 'Sign out');
    if (!ok) return;
    state.booting = true; // quiet the session writer over the erase
    // Before either clear(), or a live recorder re-mirrors its buffer over the wipe.
    let wipeError = null;
    try { await SettingsErase.wipeRecording(); } catch (e) { wipeError = e; }
    try {
      // clear(), not a key list: everything stored is a credential or scoped to one, next keys included.
      if (hasChrome) {
        // Theme and surface are neither credentials nor scoped to one, so they are carried across the wipe.
        const theme = Theme.get();
        const surface = await ViewMode.mode();
        await chrome.storage.local.clear();
        if (chrome.storage.session) await chrome.storage.session.clear();
        if (theme !== 'system') await Theme.set(theme);
        if (surface !== 'sidepanel') await ViewMode.setMode(surface);
      }
    // A failed clear aborts on Sign out's own line: an error inside Advanced's collapsed fold goes unseen.
    } catch (e) { SettingsErase.failed('signing out', e, 'signout-status'); return; }
    state.settings = null;
    // The warning rides the reload instead of being shown in a doomed document.
    if (wipeError) SettingsErase.leaveWarning(wipeError, 'Signed out');
    reloadPanel();
  },
};
