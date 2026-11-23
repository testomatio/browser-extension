// Settings screen: fill the settings form, then validate and save the config.

/* global TestomatAPI, Handoff, Tooltip, EmptyState, askForProject, progressToast,
   SettingsForm, SettingsErase, capabilities, OfflineQueue, syncPollMs, syncAuthStopped,
   syncFetching */

// Delegates onto settings-form.js, kept as bare names because app.js and the erase paths call them.
function updateTokenHelpLink() { SettingsForm.updateTokenHelpLink(); }
function initSettingsSections() { SettingsForm.initSections(); }
function initThemeSwitch() { SettingsForm.initThemeSwitch(); }
function initHostHistoryDropdown() { SettingsForm.initHostHistoryDropdown(); }
function toggleSettingsAdvanced() { SettingsForm.toggleAdvanced(); }
function setSettingsFields(s) { SettingsForm.setFields(s); }
function populateHostHistory() { SettingsForm.populateHostHistory(); }

// The same onto settings-erase.js: app.js and project-pick.js call these bare names.
function disconnectInstance(opts) { return SettingsErase.disconnect(opts); }
function forgetInstance(opts) { return SettingsErase.forget(opts); }
function signOut() { return SettingsErase.signOut(); }
function takeRecorderWarning() { SettingsErase.takeWarning(); }

// Connect mode is the same form, restyled off data-mode; keyed on state.settings, not isConfigured().

let connectMode = null; // last applied — entering the screen focuses the field once

function renderConnection() {
  const card = $('connection-card');
  if (!card) return;
  const on = Handoff.credentialed(state.settings);
  card.hidden = !on;
  renderConnectionSource(on);
  if (!on) return;
  $('connection-host').textContent = hostOf(state.settings.baseUrl) || state.settings.baseUrl;
  // Connected with no project yet is a half-done first run: the pill says so and the tick goes grey.
  const ready = !!state.settings.projectId;
  card.dataset.state = ready ? 'ready' : 'pending';
  const pill = $('connection-state');
  if (pill) {
    pill.textContent = ready ? 'Connected' : 'Project not picked';
    pill.className = `badge ${ready ? 'passed' : 'neutral'} connection-state`;
  }
}

// Testers who never pasted a token here would otherwise read a handed-over card as their own sign-in.
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
  // The offer file is gone, so its browser closed; nothing of it was saved, so no project still opens.
  const ended = `${app[0].toUpperCase()}${app.slice(1)} has closed its session`;
  line.textContent = state.settings.apiToken
    ? `${ended}. Everything now uses your own sign-in.`
    : `${ended}. Authorize above to keep working.`;
}

// Diagnostics answer off state the panel already holds: nothing is fetched, nothing is sent.

// A value this Chrome build or worker cannot answer for; it costs one row, never the section.
const DIAG_MISSING = 'unavailable';

function diagnosticsVersion() {
  try { return chrome.runtime.getManifest().version || DIAG_MISSING; } catch { return DIAG_MISSING; }
}

// Mirrors v2TokenInHand() in api.js; an `eyJ` token is a session token, which v2 cannot use.
function diagnosticsCredential(s) {
  const handed = Handoff.offer();
  if (s.projectToken && s.projectTokenFor === s.projectId) return 'a handed-over project token';
  if (handed && handed.projectToken && handed.projectId === s.projectId) {
    return 'a handed-over project token';
  }
  if (s.apiToken && !s.apiToken.startsWith('eyJ')) return 'own General token';
  if (s.apiToken || s.handoff) return 'a key minted from the session';
  return 'no credential';
}

function diagnosticsAuth(s) {
  const jwt = TestomatAPI.jwtAvailable();
  const session = jwt === true ? 'session up'
    : jwt === false ? 'no session (v1 fallback)' : 'session not probed';
  return `${session}, ${diagnosticsCredential(s)}`;
}

// Both live in scripts index.html loads after this one, so they really can be missing.
function diagnosticsQueue() {
  if (typeof OfflineQueue === 'undefined') return DIAG_MISSING;
  const n = OfflineQueue.count();
  return n ? `${n} waiting` : 'empty';
}

function diagnosticsSync() {
  if (typeof syncPollMs === 'undefined') return DIAG_MISSING;
  // The auth stop outranks the interval: naming a period the loop never uses would be a lie.
  if (syncAuthStopped) return 'stopped after an auth refusal';
  return `every ${Math.round(syncPollMs / 1000)}s${syncFetching ? ', fetching now' : ''}`;
}

async function diagnosticsStorage() {
  try {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    return Number.isFinite(bytes) ? `${Math.round(bytes / 1024)} KB` : DIAG_MISSING;
  } catch { return DIAG_MISSING; }
}

// Any reply proves the worker is awake; the step recorder's status message would end its recording.
async function diagnosticsWorker() {
  try {
    if (await chrome.runtime.sendMessage({ type: 'SCREENREC_STATUS' })) return 'answering';
  } catch { /* the worker is gone */ }
  return 'not answering';
}

// Every getter answers a string, so an unreachable value costs its own row only.
async function diagnosticRows() {
  const s = state.settings || {};
  return [
    ['Version', diagnosticsVersion()],
    ['Instance', hostOf(s.baseUrl) || 'not configured'],
    ['Project', s.projectId || 'not picked'],
    ['Auth', diagnosticsAuth(s)],
    ['Access', capabilities.readonly ? 'read-only' : 'read/write'],
    ['Queue', diagnosticsQueue()],
    ['Live sync', diagnosticsSync()],
    ['Storage used', await diagnosticsStorage()],
    ['Worker', await diagnosticsWorker()],
  ];
}

async function renderDiagnostics() {
  const list = $('diagnostics-rows');
  if (!list) return;
  const cells = [];
  for (const [label, value] of await diagnosticRows()) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    cells.push(dt, dd);
  }
  // One swap once every value is in hand, so the section is never caught half-painted.
  list.replaceChildren(...cells);
}

// Read back off the painted rows: a text built from settings would leak the next credential key added.
function diagnosticsText() {
  const list = $('diagnostics-rows');
  if (!list) return '';
  const cells = list.querySelectorAll('dt, dd');
  const lines = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    lines.push(`${cells[i].textContent}: ${cells[i + 1].textContent}`);
  }
  return lines.join('\n');
}

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(diagnosticsText());
    setStatusLine('diagnostics-copy-status', 'Copied');
  } catch {
    setStatusLine('diagnostics-copy-status', 'Clipboard refused — select the rows above instead', 'error');
  }
}

// The token field shows only for a host we hold no token for: a saved one is never edited.
function syncTokenField() {
  const section = $('view-settings');
  if (!section) return;
  const host = SettingsErase.formHost();
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
  const save = $('btn-save-settings');
  if (save) save.textContent = on ? 'Connect' : 'Save & validate';
  const entering = on && connectMode !== true;
  connectMode = on;
  // Once per entry, never on a repaint — focus must not be stolen back mid-typing.
  if (entering && $('set-token')) $('set-token').focus();
}

function fillSettingsForm() {
  SettingsForm.setFields(state.settings || {});
  SettingsForm.populateHostHistory();
  SettingsForm.paintThemeSwitch();
  SettingsForm.syncAdvanced();
  SettingsForm.updateTokenHelpLink();
  renderConnection();
  syncTokenField();
  renderDiagnostics();   // async: the worker round trip and the storage size land a tick later
  takeRecorderWarning();
}

async function saveSettings() {
  const settings = {
    baseUrl: $('set-baseurl').value.trim().replace(/\/+$/, ''),
    apiToken: $('set-token').value.trim(),
    projectId: '', // resolved below from the token's own project list
    envInfoOnFail: $('set-env-info').checked,
    envFullUrl: $('set-env-full-url').checked,
    // Blank -> 60; null when what was typed is out of range, refused below.
    evidenceWindowSec: SettingsForm.evidenceWindowFromField(),
    evidenceAutoStart: $('set-evidence-autostart').checked,
    evidenceAutoAttach: $('set-evidence-autoattach').checked,
    evidenceCaptureBodies: $('set-evidence-bodies').checked,
    stepRecNeverValues: $('set-rec-never-values').checked,
  };
  if (!settings.baseUrl || !settings.apiToken) {
    // Only an empty instance is an Advanced problem: the token row lives in Connection.
    if (!settings.baseUrl) SettingsForm.openAdvanced();
    setStatusLine('settings-status', 'Instance and access token are required', 'error');
    return;
  }
  let host;
  try {
    const u = new URL(settings.baseUrl);
    // Instance is https-only (host access is granted per https origin).
    if (u.protocol !== 'https:') {
      SettingsForm.openAdvanced(); // show the field the error is about
      setStatusLine('settings-status', 'Instance URL must be https://', 'error');
      return;
    }
    host = u.hostname;
  } catch {
    SettingsForm.openAdvanced(); // show the field the error is about
    setStatusLine('settings-status', 'Instance is not a valid URL', 'error');
    return;
  }
  // Refused, never rewritten behind the tester's back — the field keeps what was typed.
  if (settings.evidenceWindowSec === null) {
    setStatusLine('settings-status', 'Log window must be between 10 and 600 seconds', 'error');
    return;
  }
  // Keep per-host prefs this form does not show (e.g. fullPageCapture) across a re-save.
  const prior = state.hostSettings[host]
    || ((state.settings && hostOf(state.settings.baseUrl) === host) ? state.settings : null);
  if (prior && prior.fullPageCapture != null) settings.fullPageCapture = prior.fullPageCapture;
  // The project this host was last on, kept if the token can still reach it.
  const previousProject = (prior && prior.projectId) || '';
  // `<all_urls>` covers any instance typed, so no host grant is asked for before validating.
  progressToast('Validating…');
  // Project list first: that route carries no slug, so it is the token check "invalid token" reports.
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
    settings.projectId = SettingsForm.resolveProjectId(projects, previousProject);
  } else {
    // Never leave the previous host's projects in the switcher: their slugs do not exist here.
    state.projects = [];
    settings.projectId = previousProject;
    if (!settings.projectId) {
      setStatusLine('settings-status', projects
        ? 'This token reaches no projects — ask for access to one, then save again'
        : `Couldn't load your projects from ${host} — check the connection and save again`, 'error');
      return;
    }
  }
  // Several projects and no previous one: the token is in, the project is the tester's pick.
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
    // v2 answers 403 for read-only access: a valid config, saved so the panel can say so.
    if (!isReadonlyError(e)) {
      setStatusLine('settings-status', `Validation failed: ${e.message}`, 'error');
      return;
    }
  }
  await commitSettings(settings, host);
  renderProjectBar(); // the header switcher now carries this host's project list
  // The verdict belongs to the Connection card, not a line under Save, so clear that line.
  setStatusLine('settings-status', '');
  renderConnection();
  openRunsView(); // a first save lands on a fresh runs view (and enables the tabs)
}

// What Save persists once the token is in, with or without a project chosen yet.
async function commitSettings(settings, host) {
  // Landing on another project is a project switch: drop everything scoped to the one being left.
  const wasOn = state.settings && state.settings.projectId;
  if (wasOn && wasOn !== settings.projectId) resetProjectScopedState();
  state.settings = settings;
  // Per-host map and recent-first history, so an instance switch needs no re-entry.
  state.hostSettings = { ...state.hostSettings, [host]: settings };
  state.hostHistory = [host, ...state.hostHistory.filter((h) => h !== host)];
  if (!hasChrome) return;
  await chrome.storage.local.set({
    settings,
    hostSettings: state.hostSettings,
    hostHistory: state.hostHistory,
    // Mirrored top-level so the in-page relay never reads `settings`.
    evidenceCaptureBodies: settings.evidenceCaptureBodies,
    // Same reason for the step recorder's content script.
    stepRecNeverValues: settings.stepRecNeverValues,
  });
}
