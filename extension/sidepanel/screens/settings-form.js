// The Settings FORM: what it paints from the saved config, the two numbers Save reads back out of
// it, and the three controls that only rearrange it — instance history, theme switch, the folds.
// screens/settings.js drives all of it; app.js wires four of these to static markup at init.

/* global $, state, hostOf, Dropdown, Theme, envInfoEnabled, envFullUrlEnabled,
   evidenceAutoStartEnabled, evidenceAutoAttachEnabled, evidenceCaptureBodiesEnabled,
   syncTokenField */

// Prefilled into the Advanced Instance field when nothing is stored (#83) — a real
// field value, not a placeholder, so Save works untouched.
const DEFAULT_BASE_URL = 'https://app.testomat.io';

// The app name rides along so the tester can see, on Testomat.io's own page, what they are
// authorizing — and so the grant is revocable by name later.
const AUTH_APP_NAME = 'Testomat.io Extension';

// ---------- Advanced collapse (#146) ----------
// In-memory only: nothing is persisted, the state is recomputed from the saved
// instance every time Settings is entered.
let advancedOpen = false;

const SettingsForm = {
  // The origin comes from the Base URL FIELD (live, not the saved config), so the
  // token-help link tracks what the user is typing.
  tokenHelpBase() {
    const raw = ($('set-baseurl').value || '').trim().replace(/\/+$/, '');
    if (raw) {
      try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { /* fall through */ }
    }
    return DEFAULT_BASE_URL;
  },

  updateTokenHelpLink() {
    const a = $('token-help-link');
    if (a) a.href = `${SettingsForm.tokenHelpBase()}/account/access_tokens`;
    const auth = $('token-authorize-link');
    if (auth) {
      auth.href = `${SettingsForm.tokenHelpBase()}/app-auth?app_name=${encodeURIComponent(AUTH_APP_NAME)}`;
    }
  },

  // Does NOT touch the host dropdown or the header project switcher (#103).
  setFields(s) {
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
    $('set-rec-never-values').checked = SettingsForm.neverValuesEnabled(s);
  },

  // Absent -> OFF, explicit `true` -> ON. Mirrored to a top-level key on save: the
  // recorder is a content script, and `settings` holds the token (#175).
  neverValuesEnabled(settings) {
    return !!(settings && settings.stepRecNeverValues === true);
  },

  // Wire it once, from app init — the mount is static markup, the control is not.
  initHostHistoryDropdown() {
    const mount = $('set-host-history-mount');
    if (!mount || Dropdown.of('set-host-history')) return;
    const dd = Dropdown.create({
      id: 'set-host-history',
      className: 'host-history-dd',
      label: 'Instance history',
      icon: 'language',
      placeholder: 'Pick a saved instance',
      onChange: SettingsForm.onInstanceHostPicked,
    });
    dd.hidden = true; // until there are two hosts to choose between
    mount.append(dd.el);
  },

  // Offered only when at least two hosts exist; the active host is preselected.
  populateHostHistory() {
    const dd = Dropdown.of('set-host-history');
    if (!dd) return;
    const hosts = state.hostHistory || [];
    if (hosts.length < 2) { dd.setOptions([]); dd.hidden = true; return; }
    const active = hostOf($('set-baseurl').value) || (state.settings && hostOf(state.settings.baseUrl));
    dd.setOptions(hosts.map((h) => ({ value: h, label: h })), { value: active });
    dd.hidden = false;
  },

  // No save yet — Save commits it. The header switcher is NOT repainted: the active
  // project only changes once the new host is saved.
  // The pick arrives as the argument: the trigger is a <button>, whose own `.value` is always ''.
  onInstanceHostPicked(host) {
    if (!host) return;
    const s = state.hostSettings[host] || { baseUrl: `https://${host}` };
    SettingsForm.setFields(s);
    SettingsForm.updateTokenHelpLink();
    syncTokenField(); // a host we hold no token for asks for one
  },

  // ---------- appearance ----------
  // Applying and persisting a theme is shared/theme.js's job (it runs on the editor
  // page too); this is only the control that shows which of the three is on.

  paintThemeSwitch() {
    const group = $('theme-switch');
    if (!group) return;
    const mode = Theme.get();
    for (const b of group.querySelectorAll('[data-theme-mode]')) {
      b.setAttribute('aria-pressed', b.dataset.themeMode === mode ? 'true' : 'false');
    }
  },

  // Bound once on the GROUP (the buttons are static markup). The subscription keeps
  // this in step when the theme is changed from the editor tab instead.
  initThemeSwitch() {
    const group = $('theme-switch');
    if (!group) return;
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-mode]');
      if (btn) Theme.set(btn.dataset.themeMode);
    });
    Theme.onChange(SettingsForm.paintThemeSwitch);
    SettingsForm.paintThemeSwitch();
  },

  // ---------- section folds ----------
  // One delegated click keeps `aria-expanded` (head) and `hidden` (body) in step.
  // Advanced is the ONE exception — its own handler writes a variable, not the DOM.
  initSections() {
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
  },

  paintAdvanced() {
    const head = $('settings-advanced-head');
    const body = $('settings-advanced-body');
    if (head) head.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false');
    if (body) body.hidden = !advancedOpen;
  },

  toggleAdvanced() {
    advancedOpen = !advancedOpen;
    SettingsForm.paintAdvanced();
  },

  // Used when a save fails on the Instance field, so that field is on screen.
  openAdvanced() {
    advancedOpen = true;
    SettingsForm.paintAdvanced();
  },

  // A saved non-default (self-hosted) instance opens the section; nothing saved yet
  // counts as default.
  syncAdvanced() {
    const saved = ((state.settings && state.settings.baseUrl) || '').trim().replace(/\/+$/, '');
    advancedOpen = saved !== '' && saved !== DEFAULT_BASE_URL;
    SettingsForm.paintAdvanced();
  },

  // Read the evidence-window field: blank -> 60, out of 10-600 or non-numeric -> null (invalid).
  evidenceWindowFromField() {
    const raw = $('set-evidence-window').value.trim();
    if (raw === '') return 60;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 10 || n > 600) return null;
    return n;
  },

  // A still-reachable previous selection wins; a lone project needs no choosing; several with no
  // previous one leave '' — the pick is the tester's (#11).
  resolveProjectId(projects, previous) {
    if (previous && projects.some((p) => p.id === previous)) return previous;
    return projects.length === 1 ? projects[0].id : '';
  },
};
