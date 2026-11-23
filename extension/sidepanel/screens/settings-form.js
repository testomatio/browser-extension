// The Settings form: what it paints from saved config, the numbers Save reads back, and its folds.

/* global $, state, hostOf, Dropdown, Theme, envInfoEnabled, envFullUrlEnabled,
   evidenceAutoStartEnabled, evidenceAutoAttachEnabled, evidenceCaptureBodiesEnabled,
   syncTokenField */

// A real field value, not a placeholder, so Save works untouched.
const DEFAULT_BASE_URL = 'https://app.testomat.io';

// Shown on Testomat.io's page so the tester sees what they authorize, and can revoke it by name.
const AUTH_APP_NAME = 'Testomat.io Extension';

// In-memory only: recomputed from the saved instance every time Settings is entered.
let advancedOpen = false;

const SettingsForm = {
  // From the live field, not the saved config, so the token-help link tracks what the user types.
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

  // Leaves the host dropdown and the header project switcher alone.
  setFields(s) {
    s = s || {};
    $('set-baseurl').value = s.baseUrl || DEFAULT_BASE_URL;
    $('set-token').value = s.apiToken || '';
    $('set-env-info').checked = envInfoEnabled(s);
    // Absent -> off: the URL meta key is trimmed unless the tester opts in.
    $('set-env-full-url').checked = envFullUrlEnabled(s);
    // Blank shows the 60s placeholder default.
    $('set-evidence-window').value = s.evidenceWindowSec != null ? s.evidenceWindowSec : '';
    $('set-evidence-autostart').checked = evidenceAutoStartEnabled(s);
    $('set-evidence-autoattach').checked = evidenceAutoAttachEnabled(s);
    $('set-evidence-bodies').checked = evidenceCaptureBodiesEnabled(s);
    // Absent -> off, so values are recorded (masked): deliberately the inverse of the other defaults.
    $('set-rec-never-values').checked = SettingsForm.neverValuesEnabled(s);
  },

  // Saved to a top-level key too: the recorder is a content script, and `settings` holds the token.
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

  populateHostHistory() {
    const dd = Dropdown.of('set-host-history');
    if (!dd) return;
    const hosts = state.hostHistory || [];
    if (hosts.length < 2) { dd.setOptions([]); dd.hidden = true; return; }
    const active = hostOf($('set-baseurl').value) || (state.settings && hostOf(state.settings.baseUrl));
    dd.setOptions(hosts.map((h) => ({ value: h, label: h })), { value: active });
    dd.hidden = false;
  },

  // The pick arrives as the argument: the trigger is a <button>, whose own `.value` is always ''.
  onInstanceHostPicked(host) {
    if (!host) return;
    const s = state.hostSettings[host] || { baseUrl: `https://${host}` };
    SettingsForm.setFields(s);
    SettingsForm.updateTokenHelpLink();
    syncTokenField(); // a host we hold no token for asks for one
  },

  paintThemeSwitch() {
    const group = $('theme-switch');
    if (!group) return;
    const mode = Theme.get();
    for (const b of group.querySelectorAll('[data-theme-mode]')) {
      b.setAttribute('aria-pressed', b.dataset.themeMode === mode ? 'true' : 'false');
    }
  },

  // The subscription keeps the switch in step when the theme changes from the editor tab.
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

  // One delegated click for every fold but Advanced, whose handler writes a variable, not the DOM.
  initSections() {
    const group = $('settings-sections');
    if (!group) return;
    group.addEventListener('click', (e) => {
      const head = e.target.closest('.settings-section-title > .disclosure-head');
      if (!head || head.id === 'settings-advanced-head') return;
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

  // A saved self-hosted instance opens the section; nothing saved yet counts as default.
  syncAdvanced() {
    const saved = ((state.settings && state.settings.baseUrl) || '').trim().replace(/\/+$/, '');
    advancedOpen = saved !== '' && saved !== DEFAULT_BASE_URL;
    SettingsForm.paintAdvanced();
  },

  evidenceWindowFromField() {
    const raw = $('set-evidence-window').value.trim();
    if (raw === '') return 60;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 10 || n > 600) return null;
    return n;
  },

  // Several projects and no previous pick leave '': the choice is the tester's.
  resolveProjectId(projects, previous) {
    if (previous && projects.some((p) => p.id === previous)) return previous;
    return projects.length === 1 ? projects[0].id : '';
  },
};
