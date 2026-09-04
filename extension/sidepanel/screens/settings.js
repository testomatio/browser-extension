// Settings screen: fill the settings form, then validate and save the config.

/* global TestomatAPI, Handoff, Tooltip, EmptyState, Theme, ViewMode, askForProject, progressToast */

// ---------- settings ----------

// Prefilled into the Advanced Instance field when nothing is stored (#83) — a real
// field value, not a placeholder, so Save works untouched.
const DEFAULT_BASE_URL = 'https://app.testomat.io';

// The origin comes from the Base URL FIELD (live, not the saved config), so the
// token-help link tracks what the user is typing.
function tokenHelpBase() {
  const raw = ($('set-baseurl').value || '').trim().replace(/\/+$/, '');
  if (raw) {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { /* fall through */ }
  }
  return DEFAULT_BASE_URL;
}
// The app name rides along so the tester can see, on Testomat.io's own page, what they are
// authorizing — and so the grant is revocable by name later.
const AUTH_APP_NAME = 'Testomat.io Extension';

function updateTokenHelpLink() {
  const a = $('token-help-link');
  if (a) a.href = `${tokenHelpBase()}/account/access_tokens`;
  const auth = $('token-authorize-link');
  if (auth) {
    auth.href = `${tokenHelpBase()}/app-auth?app_name=${encodeURIComponent(AUTH_APP_NAME)}`;
  }
}

// Does NOT touch the host dropdown or the header project switcher (#103).
function setSettingsFields(s) {
  s = s || {};
  // Nothing stored -> show the default instance rather than an empty box (#83).
  $('set-baseurl').value = s.baseUrl || DEFAULT_BASE_URL;
  $('set-token').value = s.apiToken || '';
  // Env-info toggle: absent -> ON.
  $('set-env-info').checked = envInfoEnabled(s);
  // Full-URL opt-in (#177): absent -> OFF, i.e. the URL meta key is trimmed.
  $('set-env-full-url').checked = envFullUrlEnabled(s);
  // Blank shows the 60s placeholder default.
  $('set-evidence-window').value = s.evidenceWindowSec != null ? s.evidenceWindowSec : '';
  // Arm the recorder on opening a testrun: absent -> OFF, like the step recorder's row.
  $('set-evidence-autostart').checked = evidenceAutoStartEnabled(s);
  // Auto-attach on FAIL: absent -> ON.
  $('set-evidence-autoattach').checked = evidenceAutoAttachEnabled(s);
  // Response-body capture for failed requests (#95): absent -> ON.
  $('set-evidence-bodies').checked = evidenceCaptureBodiesEnabled(s);
  // Never record entered values (#176): absent -> OFF, i.e. values ARE recorded
  // (masked) — deliberately the inverse of the other toggles' default.
  $('set-rec-never-values').checked = stepRecNeverValuesEnabled(s);
}

// Absent -> OFF, explicit `true` -> ON. Mirrored to a top-level key on save: the
// recorder is a content script, and `settings` holds the token (#175).
function stepRecNeverValuesEnabled(settings) {
  return !!(settings && settings.stepRecNeverValues === true);
}

// Wire it once, from app init — the mount is static markup, the control is not.
function initHostHistoryDropdown() {
  const mount = $('set-host-history-mount');
  if (!mount || Dropdown.of('set-host-history')) return;
  const dd = Dropdown.create({
    id: 'set-host-history',
    className: 'host-history-dd',
    label: 'Instance history',
    icon: 'language',
    placeholder: 'Pick a saved instance',
    onChange: onInstanceHostPicked,
  });
  dd.hidden = true; // until there are two hosts to choose between
  mount.append(dd.el);
}

// Offered only when at least two hosts exist; the active host is preselected.
function populateHostHistory() {
  const dd = Dropdown.of('set-host-history');
  if (!dd) return;
  const hosts = state.hostHistory || [];
  if (hosts.length < 2) { dd.setOptions([]); dd.hidden = true; return; }
  const active = hostOf($('set-baseurl').value) || (state.settings && hostOf(state.settings.baseUrl));
  dd.setOptions(hosts.map((h) => ({ value: h, label: h })), { value: active });
  dd.hidden = false;
}

// ---------- appearance ----------
// Applying and persisting a theme is shared/theme.js's job (it runs on the editor
// page too); this is only the control that shows which of the three is on.

function paintThemeSwitch() {
  const group = $('theme-switch');
  if (!group) return;
  const mode = Theme.get();
  for (const b of group.querySelectorAll('[data-theme-mode]')) {
    b.setAttribute('aria-pressed', b.dataset.themeMode === mode ? 'true' : 'false');
  }
}

// Bound once on the GROUP (the buttons are static markup). The subscription keeps
// this in step when the theme is changed from the editor tab instead.
function initThemeSwitch() {
  const group = $('theme-switch');
  if (!group) return;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-mode]');
    if (btn) Theme.set(btn.dataset.themeMode);
  });
  Theme.onChange(paintThemeSwitch);
  paintThemeSwitch();
}

// ---------- section folds ----------
// One delegated click keeps `aria-expanded` (head) and `hidden` (body) in step.
// Advanced is the ONE exception — its own handler writes a variable, not the DOM.
function initSettingsSections() {
  const group = $('settings-sections');
  if (!group) return;
  group.addEventListener('click', (e) => {
    const head = e.target.closest('.settings-section-title > .disclosure-head');
    if (!head || head.id === 'settings-advanced-head') return; // Advanced: see below
    const body = document.getElementById(head.getAttribute('aria-controls'));
    if (!body) return;
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
  });
}

// ---------- Advanced collapse (#146) ----------
// In-memory only: nothing is persisted, the state is recomputed from the saved
// instance every time Settings is entered.

let advancedOpen = false;

function paintSettingsAdvanced() {
  const head = $('settings-advanced-head');
  const body = $('settings-advanced-body');
  if (head) head.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false');
  if (body) body.hidden = !advancedOpen;
}

function toggleSettingsAdvanced() {
  advancedOpen = !advancedOpen;
  paintSettingsAdvanced();
}

// Used when a save fails on the Instance field, so that field is on screen.
function openSettingsAdvanced() {
  advancedOpen = true;
  paintSettingsAdvanced();
}

// A saved non-default (self-hosted) instance opens the section; nothing saved yet
// counts as default.
function syncSettingsAdvanced() {
  const saved = ((state.settings && state.settings.baseUrl) || '').trim().replace(/\/+$/, '');
  advancedOpen = saved !== '' && saved !== DEFAULT_BASE_URL;
  paintSettingsAdvanced();
}

// ---------- first-run connect screen ----------
// The SAME form (same ids, same handler) in a presentational switch — CSS keys off
// `data-mode` and `data-connect`. Keyed on `state.settings`, NOT isConfigured().

let connectMode = null; // last applied — entering the screen focuses the field once

// The connected instance as a card; it stands where the token box used to be
// (syncTokenField says why that box is gone).
function renderConnection() {
  const card = $('connection-card');
  if (!card) return;
  const on = Handoff.credentialed(state.settings);
  card.hidden = !on;
  renderConnectionSource(on);
  if (!on) return;
  $('connection-host').textContent = hostOf(state.settings.baseUrl) || state.settings.baseUrl;
  // Connected but no project yet is a half-done first run (#11) — the pill says which,
  // and the card's tick goes grey with it rather than calling the run done.
  const ready = !!state.settings.projectId;
  card.dataset.state = ready ? 'ready' : 'pending';
  const pill = $('connection-state');
  if (pill) {
    pill.textContent = ready ? 'Connected' : 'Project not picked';
    pill.className = `badge ${ready ? 'passed' : 'neutral'} connection-state`;
  }
}

// A handed-over connection: whose it is, and what leaving it costs. Testers who never pasted a
// token here would otherwise read the card as their own sign-in.
function renderConnectionSource(on) {
  const line = $('connection-source');
  if (!line) return;
  if (!on || !state.settings.handoff) { line.hidden = true; return; }
  line.hidden = false;
  const app = state.settings.handoffApp || (Handoff.offer() || {}).app
    || 'the app that opened this browser';
  if (Handoff.offer()) {
    line.textContent = `Signed in by ${app}. Disconnect stops it signing you in again — `
      + 'open the run from there to come back.';
    return;
  }
  // The file is gone, so that browser was closed — and nothing of its was written down, so
  // there is no project left that it still opens.
  const ended = `${app[0].toUpperCase()}${app.slice(1)} has closed its session`;
  line.textContent = state.settings.apiToken
    ? `${ended}. Everything now uses your own sign-in.`
    : `${ended}. Authorize above to keep working.`;
}

// The full form has NO token field — a saved credential can be neither edited nor
// verified. It returns for one case: a host we hold no token for.
function syncTokenField() {
  const section = $('view-settings');
  if (!section) return;
  const host = settingsFormHost();
  const known = !!(host && (state.hostSettings[host]
    || (state.settings && hostOf(state.settings.baseUrl) === host)));
  section.dataset.token = known ? 'off' : 'on';
}

function applyConnectMode() {
  const on = state.view === 'settings' && !state.settings;
  const section = $('view-settings');
  if (section) section.dataset.mode = on ? 'connect' : 'full';
  renderConnection();
  syncTokenField();
  document.body.dataset.connect = on ? 'true' : 'false';
  // `hidden`, so the hero never flashes in the full form between two repaints.
  const hero = $('connect-hero');
  if (hero) hero.hidden = !on;
  // The same form either way — only the button's word changes.
  const save = $('btn-save-settings');
  if (save) save.textContent = on ? 'Connect' : 'Save & validate';
  const entering = on && connectMode !== true;
  connectMode = on;
  // Once per entry, never on a repaint — focus must not be stolen back mid-typing.
  if (entering && $('set-token')) $('set-token').focus();
}

function fillSettingsForm() {
  setSettingsFields(state.settings || {});
  populateHostHistory();
  paintThemeSwitch();     // which of System / Light / Dark is on
  syncSettingsAdvanced(); // #146: open Advanced only for a self-hosted instance
  updateTokenHelpLink(); // reflect the (saved) base URL onto the token-help link
  renderConnection();    // the connected-instance card
  syncTokenField();      // …and whether the token box is needed at all
  if (typeof Onboarding !== 'undefined') Onboarding.render(); // welcome checklist
  takeRecorderWarning(); // #183/#192: an erase whose recorder wipe failed says so here
}

// One-shot. The erase that left this DID happen — what the user still has to know
// is that the recording buffer may not be gone (`signOut` / `forgetInstance`).
function takeRecorderWarning() {
  let msg = null;
  try {
    msg = sessionStorage.getItem(EVIDENCE_WIPE_WARN_KEY);
    if (msg) sessionStorage.removeItem(EVIDENCE_WIPE_WARN_KEY);
  } catch { /* sessionStorage unavailable — nothing was stored either */ }
  if (msg) setStatusLine('settings-forget-status', msg, 'error');
}

// No save yet — Save commits it. The header switcher is NOT repainted: the active
// project only changes once the new host is saved.
// The pick arrives as the argument: the trigger is a <button>, whose own `.value` is always ''.
function onInstanceHostPicked(host) {
  if (!host) return;
  const s = state.hostSettings[host] || { baseUrl: `https://${host}` };
  setSettingsFields(s);
  updateTokenHelpLink();
  syncTokenField(); // a host we hold no token for asks for one
}

// Read the evidence-window field: blank -> 60, out of 10-600 or non-numeric -> null (invalid).
function evidenceWindowFromField() {
  const raw = $('set-evidence-window').value.trim();
  if (raw === '') return 60;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 10 || n > 600) return null;
  return n;
}

// A still-reachable previous selection wins; a lone project needs no choosing; several with no
// previous one leave '' — the pick is the tester's (#11).
function resolveProjectId(projects, previous) {
  if (previous && projects.some((p) => p.id === previous)) return previous;
  return projects.length === 1 ? projects[0].id : '';
}

async function saveSettings() {
  const settings = {
    baseUrl: $('set-baseurl').value.trim().replace(/\/+$/, ''),
    apiToken: $('set-token').value.trim(),
    projectId: '', // resolved below from the token's own project list (#103)
    envInfoOnFail: $('set-env-info').checked,
    // Send the URL untrimmed (#177).
    envFullUrl: $('set-env-full-url').checked,
    // Blank -> 60; null when what was typed is out of range, refused below.
    evidenceWindowSec: evidenceWindowFromField(),
    // Start the recorder on entering a testrun, bound to it (absent -> OFF).
    evidenceAutoStart: $('set-evidence-autostart').checked,
    evidenceAutoAttach: $('set-evidence-autoattach').checked,
    // Read response bodies of failed requests (#95).
    evidenceCaptureBodies: $('set-evidence-bodies').checked,
    // Drop every value the step recorder sees (#176).
    stepRecNeverValues: $('set-rec-never-values').checked,
  };
  if (!settings.baseUrl || !settings.apiToken) {
    // #146: only an empty INSTANCE is an Advanced problem — a missing token is
    // in Connection, and unfolding Advanced for it would point at the wrong row.
    if (!settings.baseUrl) openSettingsAdvanced();
    setStatusLine('settings-status', 'Instance and access token are required', 'error');
    return;
  }
  let host;
  try {
    const u = new URL(settings.baseUrl);
    // Instance is https-only (host access is granted per https origin).
    if (u.protocol !== 'https:') {
      openSettingsAdvanced(); // #146: show the field the error is about
      setStatusLine('settings-status', 'Instance URL must be https://', 'error');
      return;
    }
    host = u.hostname;
  } catch {
    openSettingsAdvanced(); // #146: show the field the error is about
    setStatusLine('settings-status', 'Instance is not a valid URL', 'error');
    return;
  }
  // Refused, never rewritten behind the tester's back — the field keeps what was typed.
  if (settings.evidenceWindowSec === null) {
    setStatusLine('settings-status', 'Log window must be between 10 and 600 seconds', 'error');
    return;
  }
  // Preserve per-host prefs not shown in this form (e.g. fullPageCapture) across
  // a re-save.
  const prior = state.hostSettings[host]
    || ((state.settings && hostOf(state.settings.baseUrl) === host) ? state.settings : null);
  if (prior && prior.fullPageCapture != null) settings.fullPageCapture = prior.fullPageCapture;
  // The project THIS host was last on — kept if the token can still reach it.
  const previousProject = (prior && prior.projectId) || '';
  // #198: `<all_urls>` covers whatever instance the tester types, so there is no
  // host grant left to ask for before the network validate.
  progressToast('Validating…');
  // Two-step validation (#103). The token's own project list first — that route
  // carries no slug, so it IS the token check an "invalid token" must report.
  Handoff.configure({ baseUrl: settings.baseUrl, apiToken: settings.apiToken, projectId: previousProject });
  let projects = null;
  try {
    projects = await TestomatAPI.listProjects();
  } catch (e) {
    if (e.kind === 'auth') {
      setStatusLine('settings-status',
        `Token rejected by ${host} — authorize there again and save the new token`, 'error');
      return;
    }
    projects = null; // network / server hiccup: the remembered project can still carry us
  }
  if (projects && projects.length) {
    state.projects = projects;
    settings.projectId = resolveProjectId(projects, previousProject);
  } else {
    // Never leave the previous host's projects in the switcher — it would offer
    // slugs that do not exist where we now point.
    state.projects = [];
    settings.projectId = previousProject;
    if (!settings.projectId) {
      setStatusLine('settings-status', projects
        ? 'This token reaches no projects — ask for access to one, then save again'
        : `Couldn't load your projects from ${host} — check the connection and save again`, 'error');
      return;
    }
  }
  // Several projects and no previous one: the token is in, the project is the tester's pick (#11).
  if (!settings.projectId) {
    await commitSettings(settings, host);
    askForProject();
    return;
  }
  // Then the project-scoped v2 call the panel actually runs on.
  Handoff.configure(settings);
  try {
    await TestomatAPI.validate();
  } catch (e) {
    // #155: v2 answers 403 for read-only access — a VALID config the panel must
    // save, so it can say so instead of reporting a failed validation.
    if (!isReadonlyError(e)) {
      setStatusLine('settings-status', `Validation failed: ${e.message}`, 'error');
      return;
    }
  }
  await commitSettings(settings, host);
  renderProjectBar(); // the header switcher now carries this host's project list
  // The verdict belongs to the Connection card (#connection-state), not to a line
  // under Save — clear whatever this save put there on its way through.
  setStatusLine('settings-status', '');
  renderConnection();
  openRunsView(); // a first save lands on a fresh runs view (and enables the tabs)
}

// What Save persists once the token is in — with or without a project chosen yet (#11).
async function commitSettings(settings, host) {
  // Landing on another project is a project switch — drop everything scoped to
  // the one we are leaving, same as the header switcher does.
  const wasOn = state.settings && state.settings.projectId;
  if (wasOn && wasOn !== settings.projectId) resetProjectScopedState();
  state.settings = settings;
  // Per-host map + history (most-recent-first, deduped) so an instance switch
  // needs no re-entry.
  state.hostSettings = { ...state.hostSettings, [host]: settings };
  state.hostHistory = [host, ...state.hostHistory.filter((h) => h !== host)];
  if (!hasChrome) return;
  await chrome.storage.local.set({
    settings,
    hostSettings: state.hostSettings,
    hostHistory: state.hostHistory,
    // Mirrored top-level so the in-page relay never reads `settings` (#175).
    evidenceCaptureBodies: settings.evidenceCaptureBodies,
    // Same reason for the step recorder's content script (#176).
    stepRecNeverValues: settings.stepRecNeverValues,
  });
}

// ---------- forget / sign out (#177) ----------
// Save writes the token three ways — `settings`, `hostSettings[host]` and a
// `hostHistory` row — so an exit has to remove all three.

// The host the FORM points at, else the active one. A NON-EMPTY field that does
// not parse resolves to nothing — a destructive control must never retarget.
function settingsFormHost() {
  const typed = ($('set-baseurl').value || '').trim();
  if (typed) return hostOf(typed);
  return (state.settings && hostOf(state.settings.baseUrl)) || null;
}

// Cold boot after an erase: init() re-reads storage, so every in-memory copy of
// the erased data dies with the document. A late `set({session})` holds no credential.
const reloadPanel = () => location.reload();

// Everything scoped to ONE instance — `offlineQueue` holds results (with the raw
// tester comment) that never reached the server.
const HOST_SCOPED_KEYS = ['settings', 'session', 'offlineQueue'];

// Storage is written FIRST and in-memory state follows only on success, so a
// rejected write leaves the panel unchanged — never a silent half-erase.
function eraseFailed(what, e, statusId = 'settings-forget-status') {
  state.booting = false; // no erase happened — the session writer may run again
  setStatusLine(statusId,
    `Couldn't finish ${what}: ${e.message || e} — assume the data is still on this machine, try again`,
    'error');
}

// Forgets the instance the panel is ON, whatever the Instance field is showing;
// it ends on the connect screen, since nothing is left to run.
// `statusId` is the caller's: the choose-a-project screen (screens/project-pick.js) offers the
// same Disconnect, and the Connection card's own line is on a page nobody can reach from there.
function disconnectInstance({ statusId = 'connection-status' } = {}) {
  const host = (state.settings && hostOf(state.settings.baseUrl)) || settingsFormHost();
  return forgetInstance({ host, verb: 'Disconnect', statusId });
}

// `opts.host` targets an instance explicitly (Disconnect); with none, the host
// the FORM points at — what the Advanced button means by "this".
async function forgetInstance(opts = {}) {
  const verb = opts.verb || 'Forget';
  const statusId = opts.statusId || 'settings-forget-status';
  const host = opts.host || settingsFormHost();
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
  const ok = await confirmDialog(
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
  if (active) { try { await wipeEvidenceRecording(); } catch (e) { wipeError = e; } }
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
  } catch (e) { eraseFailed(`forgetting ${host}`, e, statusId); return; }
  state.hostSettings = hostSettings;
  state.hostHistory = hostHistory;
  // As before its first Save. A failed recorder stop rides the reload, like sign out's.
  if (active) {
    state.settings = null;
    if (wipeError) leaveRecorderWarning(wipeError, 'Instance forgotten');
    reloadPanel();
    return;
  }
  setSettingsFields(state.settings || {}); // the form was showing the host we just erased
  populateHostHistory();
  updateTokenHelpLink();
  syncTokenField(); // the form points at the active host again
  setStatusLine(statusId, `${host} forgotten`, 'ok');
}

// A timeout is a FAILURE, not a success — the recorder may still be holding the
// buffer we promised to erase.
const EVIDENCE_WIPE_MS = 5000;

// PAGE sessionStorage, like `tcReturn`: not an area the erase claims to wipe, holds
// no credential, and dies with the browser — which is when the buffer dies too.
const EVIDENCE_WIPE_WARN_KEY = 'signOutRecorderWarning';
const evidenceWipeWarning = (why, lead) => `${lead} — but the console & network `
  + `recording could not be stopped: ${why}. Assume its log is still on this machine until you `
  + `restart the browser.`;

function leaveRecorderWarning(e, lead) {
  try { sessionStorage.setItem(EVIDENCE_WIPE_WARN_KEY, evidenceWipeWarning(String((e && e.message) || e), lead)); }
  catch { /* sessionStorage unavailable — the erase still stands */ }
}

// #183: `evidenceMirror` is only a copy of the worker's ring buffer — a RUNNING
// recording writes it back ~2 s after a clear. Throws on anything but a clean wipe.
async function wipeEvidenceRecording() {
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
}

async function signOut() {
  const ok = await confirmDialog(
    'Sign out? Every saved token, instance, history entry, queued result, session, unsaved '
    + 'test draft, recorded step and captured log is deleted from this '
    + 'browser. A running recording is stopped for you. Site access stays — it is Chrome\'s own '
    + 'setting, under chrome://extensions → Details → Site access.', 'Sign out');
  if (!ok) return;
  state.booting = true; // quiet the session writer over the erase
  // BEFORE either clear(), or a live recorder re-mirrors its buffer over the wipe.
  // Its failure is HELD, not thrown — the token is the larger secret.
  let wipeError = null;
  try { await wipeEvidenceRecording(); } catch (e) { wipeError = e; }
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
  } catch (e) { eraseFailed('signing out', e, 'signout-status'); return; }
  state.settings = null;
  // The warning rides the reload instead of being shown in a doomed document.
  if (wipeError) leaveRecorderWarning(wipeError, 'Signed out');
  reloadPanel();
}
