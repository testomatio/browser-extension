// Settings screen: fill the settings form, then validate and save the config.

/* global TestomatAPI, Handoff, Tooltip, EmptyState, askForProject, progressToast,
   SettingsForm, SettingsErase, capabilities, OfflineQueue, syncPollMs, syncAuthStopped,
   syncFetching */

// One-line delegates onto screens/settings-form.js. app.js wires the first five to static
// markup by these bare names, and the erase paths below repaint the form through the last two.
function updateTokenHelpLink() { SettingsForm.updateTokenHelpLink(); }
function initSettingsSections() { SettingsForm.initSections(); }
function initThemeSwitch() { SettingsForm.initThemeSwitch(); }
function initHostHistoryDropdown() { SettingsForm.initHostHistoryDropdown(); }
function toggleSettingsAdvanced() { SettingsForm.toggleAdvanced(); }
function setSettingsFields(s) { SettingsForm.setFields(s); }
function populateHostHistory() { SettingsForm.populateHostHistory(); }

// The same onto screens/settings-erase.js. app.js wires the first three to the destructive buttons
// by these bare names, and screens/project-pick.js offers the same Disconnect on its own line.
function disconnectInstance(opts) { return SettingsErase.disconnect(opts); }
function forgetInstance(opts) { return SettingsErase.forget(opts); }
function signOut() { return SettingsErase.signOut(); }
function takeRecorderWarning() { SettingsErase.takeWarning(); }

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

// ---------- Diagnostics ----------
// The first questions a "it does not work" report opens with, answered off state the panel already
// holds: nothing is fetched, nothing is sent, and Copy reads the painted rows back out.

// A value this build of Chrome, or this worker, cannot answer for. One row's text, never the section.
const DIAG_MISSING = 'unavailable';

function diagnosticsVersion() {
  try { return chrome.runtime.getManifest().version || DIAG_MISSING; } catch { return DIAG_MISSING; }
}

// WHICH credential the v2 leg is holding, named — mirrors v2TokenInHand() in api.js off the
// settings the panel handed it. `eyJ` is a session token, which v2 itself cannot use.
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

// Both of these live in scripts index.html loads AFTER this one, so they really can be missing.
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

// A reply — any reply — is the proof: the worker had to be awake to send one. The screen recorder's
// door, and only it: the step recorder's ends an orphaned recording, which is no way to ask a question.
async function diagnosticsWorker() {
  try {
    if (await chrome.runtime.sendMessage({ type: 'SCREENREC_STATUS' })) return 'answering';
  } catch { /* the worker is gone */ }
  return 'not answering';
}

// Label/value pairs in the order a report reads them. Every getter answers a string, so an
// unreachable value costs its own row and leaves the other eight standing.
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

// Read BACK off the painted rows, deliberately: a text built from the settings object would leak the
// next credential key somebody adds, and a token has to be rendered before it can be copied.
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

// The full form has NO token field — a saved credential can be neither edited nor
// verified. It returns for one case: a host we hold no token for.
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
  // The same form either way — only the button's word changes.
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
  SettingsForm.paintThemeSwitch(); // which of System / Light / Dark is on
  SettingsForm.syncAdvanced();     // #146: open Advanced only for a self-hosted instance
  SettingsForm.updateTokenHelpLink(); // reflect the (saved) base URL onto the token-help link
  renderConnection();    // the connected-instance card
  syncTokenField();      // …and whether the token box is needed at all
  renderDiagnostics();   // async: the worker round trip and the storage size land a tick later
  if (typeof Onboarding !== 'undefined') Onboarding.render(); // welcome checklist
  takeRecorderWarning(); // #183/#192: an erase whose recorder wipe failed says so here
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
    evidenceWindowSec: SettingsForm.evidenceWindowFromField(),
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
    if (!settings.baseUrl) SettingsForm.openAdvanced();
    setStatusLine('settings-status', 'Instance and access token are required', 'error');
    return;
  }
  let host;
  try {
    const u = new URL(settings.baseUrl);
    // Instance is https-only (host access is granted per https origin).
    if (u.protocol !== 'https:') {
      SettingsForm.openAdvanced(); // #146: show the field the error is about
      setStatusLine('settings-status', 'Instance URL must be https://', 'error');
      return;
    }
    host = u.hostname;
  } catch {
    SettingsForm.openAdvanced(); // #146: show the field the error is about
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
    settings.projectId = SettingsForm.resolveProjectId(projects, previousProject);
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
