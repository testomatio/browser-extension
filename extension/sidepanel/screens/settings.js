// Settings screen: fill the settings form, then validate and save the config.

/* global TestomatAPI, Tooltip, EmptyState, Theme, ViewMode */

// ---------- settings ----------

// The instance every team project lives on. Prefilled into the (now Advanced,
// #83) Instance field when nothing is stored, so the one field down there is
// already right and Save works untouched — it is a real field value, not a
// placeholder, and it persists exactly as if the user had typed it.
const DEFAULT_BASE_URL = 'https://app.testomat.io';

// The token-help link deep-links to the access-tokens page of the configured
// host. Derive the origin from the Base URL FIELD (live, not the saved config)
// so the link tracks what the user is typing; fall back to app.testomat.io when
// the field is empty or not a valid URL.
function tokenHelpBase() {
  const raw = ($('set-baseurl').value || '').trim().replace(/\/+$/, '');
  if (raw) {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { /* fall through */ }
  }
  return DEFAULT_BASE_URL;
}
function updateTokenHelpLink() {
  const a = $('token-help-link');
  if (a) a.href = `${tokenHelpBase()}/account/access_tokens`;
}

// Write a settings object into the form fields (shared by first fill + instance
// switch). Does NOT touch the host dropdown (or the header project switcher — the
// project is not a form field since #103).
function setSettingsFields(s) {
  s = s || {};
  // Nothing stored -> show the default instance rather than an empty box (#83).
  $('set-baseurl').value = s.baseUrl || DEFAULT_BASE_URL;
  $('set-token').value = s.apiToken || '';
  // Env-info toggle (008a): absent -> ON (the A2 undefined-rule).
  $('set-env-info').checked = envInfoEnabled(s);
  // Full-URL opt-in (#177): absent -> OFF, i.e. the URL meta key is trimmed.
  $('set-env-full-url').checked = envFullUrlEnabled(s);
  // Evidence window (M2 PR-1): blank shows the 60s placeholder default.
  $('set-evidence-window').value = s.evidenceWindowSec != null ? s.evidenceWindowSec : '';
  // Evidence auto-attach on FAIL: absent -> ON (same undefined-rule).
  $('set-evidence-autoattach').checked = evidenceAutoAttachEnabled(s);
  // Response-body capture for failed requests (#95): absent -> ON.
  $('set-evidence-bodies').checked = evidenceCaptureBodiesEnabled(s);
  // Never record entered values (#176): absent -> OFF, i.e. values are recorded
  // (masked). The INVERSE of the A2 undefined-rule and deliberately so — the
  // recorder is worth having, so the safe-by-default answer here is the masking.
  $('set-rec-never-values').checked = stepRecNeverValuesEnabled(s);
}

// Toggle (#176): absent/undefined -> OFF; explicit `true` -> ON. Read
// here and mirrored to a top-level storage key on save — the recorder runs as a
// content script and must never read `settings`, which holds the token (#175).
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

// Instance history dropdown: offered only when at least two hosts exist (a real
// choice — a lone default host shows nothing). The active host is preselected.
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
// The colour scheme switch. Everything about applying and persisting a theme is
// shared/theme.js's (it runs on the editor page too); this is only the control
// that shows which of the three is on and hands a click to it.

function paintThemeSwitch() {
  const group = $('theme-switch');
  if (!group) return;
  const mode = Theme.get();
  for (const b of group.querySelectorAll('[data-theme-mode]')) {
    b.setAttribute('aria-pressed', b.dataset.themeMode === mode ? 'true' : 'false');
  }
}

// Bound once, on the GROUP: three segments, one listener, and it survives every
// repaint because the buttons are static markup. The subscription is what keeps
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
// Every settings section is an accordion item, and all of them fold the same
// way: the head carries `aria-expanded` + `aria-controls`, the body carries
// `hidden`, and one delegated click keeps the two in step. Which sections start
// open is decided in the markup (Connection and Failure log do) — the state is
// then the tester's for as long as the panel lives, and is deliberately not
// persisted, exactly like Advanced's.
//
// Advanced is the ONE exception and keeps its own handler below: its state is
// computed from the saved instance every time Settings is entered, so a click
// here has to write that variable rather than the DOM, or the next entry would
// disagree with the caret.
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
// The Instance field is noise for app.testomat.io — the section it lives in folds
// behind its heading. In-memory only, deliberately: nothing is persisted, the
// state is recomputed from the saved instance every time Settings is entered.
// Save & validate and its status line stay outside — they commit the whole form.

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

// Open it and keep it open — used when a save fails on the Instance field, so the
// field the message is about is on screen rather than folded away.
function openSettingsAdvanced() {
  advancedOpen = true;
  paintSettingsAdvanced();
}

// Smart expand on entering Settings: a self-hosted instance is the only reason
// this section exists, so a saved non-default host opens it. Nothing saved yet
// (first run, the field prefilled with the default) counts as default.
function syncSettingsAdvanced() {
  const saved = ((state.settings && state.settings.baseUrl) || '').trim().replace(/\/+$/, '');
  advancedOpen = saved !== '' && saved !== DEFAULT_BASE_URL;
  paintSettingsAdvanced();
}

// ---------- first-run connect screen ----------
// Nothing saved means there is exactly ONE thing to do here, so the Settings view
// renders as a connect screen: the hero, the General token, Connect. Everything
// else on this form configures a panel that is already connected, so it waits —
// and so does the tab bar, whose other two tabs are disabled until then anyway.
//
// It stays the SAME form (same ids, same Save & validate handler): one place
// validates a token, not two. The whole switch is presentational — CSS keys off
// `data-mode` on the section and `data-connect` on the body.
//
// Keyed on `state.settings`, NOT isConfigured(): a saved config whose project
// failed to resolve is not a first run, and its way out (Forget instance / Sign
// out, the host history) lives in the full form.

let connectMode = null; // last applied — entering the screen focuses the field once

// The connected instance, as a card: the host the panel is on, and the way off
// it. It stands where the token box used to — see syncTokenField() for why that
// box is gone.
function renderConnection() {
  const card = $('connection-card');
  if (!card) return;
  const on = !!state.settings && !!state.settings.apiToken;
  card.hidden = !on;
  if (on) $('connection-host').textContent = hostOf(state.settings.baseUrl) || state.settings.baseUrl;
}

// The full form has NO token field: a saved credential is not information — a row
// of dots reads as an editable value that is impossible to edit or verify, and
// the two things a tester actually wants from it (which instance, how do I get
// out) are the card's. It comes back for exactly one case: the Instance field
// points at a host we hold no token for, which is a connection waiting to be made.
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
  // The hero belongs to this screen alone — it carries `hidden` so it never
  // flashes in the full form between two repaints.
  const hero = $('connect-hero');
  if (hero) hero.hidden = !on;
  // The button commits the same form either way; on the connect screen it is the
  // one action on screen, so it says what it does there.
  const save = $('btn-save-settings');
  if (save) save.textContent = on ? 'Connect' : 'Save & validate';
  const entering = on && connectMode !== true;
  connectMode = on;
  // One field, one job — put the caret in it on arrival (once per entry, never on
  // a repaint, so it can't steal focus back mid-typing).
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

// One-shot. The erase that left this DID happen — both storage areas for a sign
// out, both for Forget on the active instance (#192) — so the panel is at first
// launch and the token is gone; what the user still has to know is that the
// recording buffer may not be (`signOut` / `forgetInstance`, same file).
function takeRecorderWarning() {
  let msg = null;
  try {
    msg = sessionStorage.getItem(EVIDENCE_WIPE_WARN_KEY);
    if (msg) sessionStorage.removeItem(EVIDENCE_WIPE_WARN_KEY);
  } catch { /* sessionStorage unavailable — nothing was stored either */ }
  if (msg) setStatusLine('settings-forget-status', msg, 'error');
}

// Instance dropdown pick: restore that host's saved settings into the form. No
// save yet — Save commits it. The header switcher is NOT repainted: the active
// project only changes once the new host is saved.
function onInstanceHostPicked() {
  const host = $('set-host-history').value;
  if (!host) return;
  const s = state.hostSettings[host] || { baseUrl: `https://${host}` };
  setSettingsFields(s);
  updateTokenHelpLink();
  syncTokenField(); // a host we hold no token for asks for one
}

// Read + clamp the evidence-window field (blank -> 60, non-numeric -> 60).
function evidenceWindowFromField() {
  const raw = $('set-evidence-window').value.trim();
  if (raw === '') return 60;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(600, Math.max(10, n));
}

// Resolve which project the saved token lands on (#103). Precedence mirrors
// testeiya: a still-reachable previous selection wins, otherwise the first project
// of the list. Returns the settings' projectId, or '' when nothing can be resolved.
function resolveProjectId(projects, previous) {
  if (previous && projects.some((p) => p.id === previous)) return previous;
  return projects.length ? projects[0].id : '';
}

async function saveSettings() {
  const settings = {
    baseUrl: $('set-baseurl').value.trim().replace(/\/+$/, ''),
    apiToken: $('set-token').value.trim(),
    projectId: '', // resolved below from the token's own project list (#103)
    // Env-info on failed comments (008a); persisted explicitly once saved.
    envInfoOnFail: $('set-env-info').checked,
    // Send the URL untrimmed (#177); persisted explicitly once saved.
    envFullUrl: $('set-env-full-url').checked,
    // Evidence recorder window (M2 PR-1): blank -> 60, clamp 10-600.
    evidenceWindowSec: evidenceWindowFromField(),
    // Auto-attach the evidence log on FAIL; persisted explicitly once saved.
    evidenceAutoAttach: $('set-evidence-autoattach').checked,
    // Read response bodies of failed requests (#95); persisted explicitly once saved.
    evidenceCaptureBodies: $('set-evidence-bodies').checked,
    // Drop every value the step recorder sees (#176); persisted explicitly once saved.
    stepRecNeverValues: $('set-rec-never-values').checked,
  };
  if (!settings.baseUrl || !settings.apiToken) {
    // #146: only an empty INSTANCE is an Advanced problem — a missing token is
    // in Connection, and unfolding Advanced for it would point at the wrong row.
    if (!settings.baseUrl) openSettingsAdvanced();
    setStatusLine('settings-status', 'Instance and General token are required', 'error');
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
  // Preserve per-host prefs not shown in this form (e.g. fullPageCapture) so a
  // re-save doesn't drop them.
  const prior = state.hostSettings[host]
    || ((state.settings && hostOf(state.settings.baseUrl) === host) ? state.settings : null);
  if (prior && prior.fullPageCapture != null) settings.fullPageCapture = prior.fullPageCapture;
  // The project THIS host was last on — the silent migration of a pre-#103 config
  // (its stored projectId simply becomes the switcher's selected value) and, on a
  // re-save, the selection to keep if the token can still reach it.
  const previousProject = (prior && prior.projectId) || '';
  // No host grant to ask for since #198: `<all_urls>` covers whatever instance the
  // tester types, so the save goes straight to the network validate.
  setStatusLine('settings-status', 'Validating…');
  // Two-step validation since #103. First the token's own project list (JWT api
  // root — the route carries no slug, which is precisely what we are resolving):
  // that IS the token check, and it is what an "invalid token" must report.
  TestomatAPI.configure({ baseUrl: settings.baseUrl, apiToken: settings.apiToken, projectId: previousProject });
  let projects = null;
  try {
    projects = await TestomatAPI.listProjects();
  } catch (e) {
    if (e.kind === 'auth') {
      setStatusLine('settings-status',
        `Token rejected by ${host} — create a new General token there and save again`, 'error');
      return;
    }
    projects = null; // network / server hiccup: the remembered project can still carry us
  }
  if (projects && projects.length) {
    state.projects = projects;
    settings.projectId = resolveProjectId(projects, previousProject);
  } else {
    // No list for THIS host — never leave the previous host's projects in the
    // switcher, or it would offer slugs that do not exist where we now point.
    state.projects = [];
    settings.projectId = previousProject;
    if (!settings.projectId) {
      setStatusLine('settings-status', projects
        ? 'This token reaches no projects — ask for access to one, then save again'
        : `Couldn't load your projects from ${host} — check the connection and save again`, 'error');
      return;
    }
  }
  // Then the project-scoped v2 call the panel actually runs on.
  TestomatAPI.configure(settings);
  try {
    await TestomatAPI.validate();
  } catch (e) {
    // #155: v2 403s every request for read-only access. That is a VALID config
    // pointed at a project this member cannot work in — saving it is what lets
    // the panel say so (and lets the switcher move on), so it is not a failure.
    if (!isReadonlyError(e)) {
      setStatusLine('settings-status', `Validation failed: ${e.message}`, 'error');
      return;
    }
  }
  // Landing on another project (host switch, or the old one is gone) is a project
  // switch — drop everything scoped to the one we are leaving, same as the header
  // switcher does.
  const wasOn = state.settings && state.settings.projectId;
  if (wasOn && wasOn !== settings.projectId) resetProjectScopedState();
  state.settings = settings;
  // Per-host map + history (most-recent-first, deduped) so an instance switch
  // restores this host's token/project/prefs with no re-entry.
  state.hostSettings = { ...state.hostSettings, [host]: settings };
  state.hostHistory = [host, ...state.hostHistory.filter((h) => h !== host)];
  if (hasChrome) {
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
  renderProjectBar(); // the header switcher now carries this host's project list
  setStatusLine('settings-status', 'Connected ✓', 'ok');
  openRunsView(); // a first save lands on a fresh runs view (and enables the tabs)
}

// ---------- forget / sign out (#177) ----------
// Save writes the token three ways — `settings`, `hostSettings[host]` and a
// `hostHistory` row — and until now nothing removed any of them: uninstalling was
// the only exit, so a handed-over laptop kept a live project credential. These two
// controls are that exit. The model is the AI-key cleanup in core/storage.js.

// The instance these controls act on: the host the FORM points at (an instance
// picked from the history dropdown is what the user is looking at), else the
// active one. A NON-EMPTY field that does not parse resolves to nothing instead
// of falling back — on a destructive control, a half-typed `acme.internal` must
// never quietly target whatever instance happens to be active.
function settingsFormHost() {
  const typed = ($('set-baseurl').value || '').trim();
  if (typed) return hostOf(typed);
  return (state.settings && hostOf(state.settings.baseUrl)) || null;
}

// Cold boot after an erase: init() re-reads storage, so every module's in-memory
// copy of the erased data dies with the document. Honest and total, where
// hand-resetting a dozen caches would silently miss the next one added. It is
// also all we have against the one race left: `state.booting` narrows the window
// but is no barrier — persistSession reads its guards at CALL time, so a
// `set({session})` already dispatched can still land on top of the wipe. It
// carries view/run ids and no credential, and the reloaded panel (unconfigured,
// so persistSession never runs again) leaves it inert.
const reloadPanel = () => location.reload();

// Named once, used by both controls: everything scoped to ONE instance. `session`
// restores its run; `offlineQueue` holds results (with the raw tester comment)
// that never reached the server.
const HOST_SCOPED_KEYS = ['settings', 'session', 'offlineQueue'];

// Nothing may be reported as erased that was not. Storage is written FIRST and
// in-memory state follows only on success, so a rejected write leaves the panel
// unchanged with the reason on screen — never a silent half-erase. A retry is
// safe: every step here is idempotent.
function eraseFailed(what, e, statusId = 'settings-forget-status') {
  state.booting = false; // no erase happened — the session writer may run again
  setStatusLine(statusId,
    `Couldn't finish ${what}: ${e.message || e} — assume the data is still on this machine, try again`,
    'error');
}

// Disconnect (the Connection card): forget the instance the panel is ON, whatever
// the Instance field down in Advanced happens to be showing. It ends where the
// panel began — the connect screen, one empty token field — because forgetting the
// active host leaves nothing to run.
function disconnectInstance() {
  const host = (state.settings && hostOf(state.settings.baseUrl)) || settingsFormHost();
  return forgetInstance({ host, verb: 'Disconnect', statusId: 'connection-status' });
}

// `opts.host` targets an instance explicitly (Disconnect); with none, it is the
// one the FORM points at — which is what the Advanced button means by "this".
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
  // #192: the memory-backed area is scoped to no instance, but forgetting the
  // ACTIVE one resets the panel anyway and that data — recorded steps with typed
  // values, the evidence buffer with its response-body snippets, unsaved editor
  // drafts, pending screenshot hand-offs — belongs to the session being reset.
  // Forgetting an INACTIVE instance leaves every bit of it alone: it belongs to
  // the session the user is still in. The stop comes FIRST for #183's reason (a
  // running recorder re-mirrors its buffer over the clear ~2 s later), and its
  // failure is HELD rather than thrown, exactly as in sign out: the token is
  // standing access to the project, the buffer is logs.
  let wipeError = null;
  if (active) { try { await wipeEvidenceRecording(); } catch (e) { wipeError = e; } }
  try {
    if (hasChrome) {
      await chrome.storage.local.set({ hostSettings, hostHistory });
      if (active) {
        await chrome.storage.local.remove(HOST_SCOPED_KEYS);
        if (chrome.storage.session) await chrome.storage.session.clear();
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

// A wedged worker must not hang sign out forever; a timeout is a FAILURE, not a
// success — the recorder may still be holding the buffer we promised to erase.
const EVIDENCE_WIPE_MS = 5000;

// The warning a failed wipe leaves behind, and the one-shot breadcrumb that
// carries it across the reload. PAGE sessionStorage, like `tcReturn`: not one of
// the extension areas sign out claims to erase, holds no credential, and dies
// with the browser — which is also when the un-erased buffer dies. Shared with
// Forget-on-the-active-instance since #192, so `lead` names the erase that DID
// happen; the WHOLE message is stored and the reader paints what it finds.
const EVIDENCE_WIPE_WARN_KEY = 'signOutRecorderWarning';
const evidenceWipeWarning = (why, lead) => `${lead} — but the console & network `
  + `recording could not be stopped: ${why}. Assume its log is still on this machine until you `
  + `restart the browser.`;

function leaveRecorderWarning(e, lead) {
  try { sessionStorage.setItem(EVIDENCE_WIPE_WARN_KEY, evidenceWipeWarning(String((e && e.message) || e), lead)); }
  catch { /* sessionStorage unavailable — the erase still stands */ }
}

// #183: the evidence ring buffer lives in the service worker, and
// `evidenceMirror` is only its copy — a recording still RUNNING writes that copy
// back ~2 s after the clear. So the recording is stopped and the key removed
// FIRST, and this throws on anything but a clean wipe so signOut can report it.
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
    + 'browser. A running recording is stopped for you. Allowed websites are kept — remove '
    + 'them under Allowed websites.', 'Sign out');
  if (!ok) return;
  state.booting = true; // quiet the session writer over the erase
  // Attempted BEFORE either clear(), or a live recorder re-mirrors its buffer
  // over the wipe. Its failure is HELD, not thrown: a token is standing access to
  // the project and the buffer is logs, so refusing to erase the token because
  // the log wipe failed would sacrifice the larger secret for the smaller one.
  let wipeError = null;
  try { await wipeEvidenceRecording(); } catch (e) { wipeError = e; }
  try {
    // clear(), not a list of keys: the finding IS that a key nobody remembered
    // kept a token. Everything the panel stores is either a credential or scoped
    // to one, so a whole-area wipe is correct today AND for the next key someone
    // adds. `session` too — memory-backed, but it outlives a sign out and holds
    // the recorded steps (typed values, titles, URLs), the evidence ring buffer
    // with its response-body snippets, unsaved editor drafts and pending
    // screenshot hand-offs.
    if (hasChrome) {
      // The colour scheme is one of TWO keys here that are neither a credential
      // nor scoped to one — it is how this browser is set up to look, and a sign
      // out that silently threw it back to the OS default would read as a bug in
      // the theme, not as part of the erase. The chosen SURFACE (#208) is the
      // other, and reads the same way: the panel would come back docked in a
      // window the tester deliberately left behind. Both are carried across the
      // wipe rather than exempted from it: clear() stays a whole-area wipe, which
      // is the point.
      const theme = Theme.get();
      const surface = await ViewMode.mode();
      await chrome.storage.local.clear();
      if (chrome.storage.session) await chrome.storage.session.clear();
      if (theme !== 'system') await Theme.set(theme);
      if (surface !== 'sidepanel') await ViewMode.setMode(surface);
    }
  // A failed CLEAR still aborts — and it says so on Sign out's OWN status line
  // (#signout-status), not on Forget's down in Advanced: the redesign gave the
  // section its own line, and an error about signing out that surfaces inside a
  // collapsed fold is an error nobody sees.
  } catch (e) { eraseFailed('signing out', e, 'signout-status'); return; }
  state.settings = null;
  // The erase happened, so the panel must still cold-boot to first launch — the
  // warning rides across that reload instead of being shown in a doomed document.
  if (wipeError) leaveRecorderWarning(wipeError, 'Signed out');
  reloadPanel();
}
