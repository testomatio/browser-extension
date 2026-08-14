// Onboarding welcome checklist (M4): a first-run card at the top of Settings
// guiding token → project → first run. Each step auto-checks; the card disappears
// once all three complete or on an early ×-dismiss. Both states persist in
// chrome.storage.local. Existing (already-configured) users are seeded as done so
// the card never re-appears for someone already working.

/* global $, state, hasChrome */

const ONBOARDING_KEY = 'onboarding';

// In-memory source of truth, written through on every change. Shape:
// { token, project, run, dismissed } — the three step flags + the early dismiss.
let obState = { token: false, project: false, run: false, dismissed: false };

function persistOnboarding() {
  if (!hasChrome) return;
  chrome.storage.local.set({ [ONBOARDING_KEY]: obState });
}

// Seed once: from the persisted value if present, else (first feature run) from
// existing config + last session — a configured user has token+project done, and
// a session carrying a runId means they have opened a run. So an already-working
// user is fully seeded (all done) and never sees the card.
function onboardingInit(stored) {
  const saved = stored && stored[ONBOARDING_KEY];
  if (saved && typeof saved === 'object') {
    obState = {
      token: !!saved.token, project: !!saved.project,
      run: !!saved.run, dismissed: !!saved.dismissed,
    };
    return;
  }
  const configured = !!state.settings;
  obState = {
    token: configured,
    project: configured,
    run: !!(stored && stored.session && stored.session.runId), // seed step 3 from the last run
    dismissed: false,
  };
  persistOnboarding(); // durable seed so this one-time derivation is stable
}

const onboardingAllDone = () => obState.token && obState.project && obState.run;

// Token link → the ACTIVE instance host's access-tokens page (per-host model):
// the saved active instance, else the live Instance field, else the default app.
function onboardingTokenHref() {
  const active = state.settings && state.settings.baseUrl;
  const field = $('set-baseurl') ? $('set-baseurl').value : '';
  const raw = (active || field || '').trim().replace(/\/+$/, '');
  if (raw) {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}/account/access_tokens`; } catch { /* fall through */ }
  }
  return 'https://app.testomat.io/account/access_tokens';
}

function updateOnboardingTokenLink() {
  const a = $('onboarding-token-link');
  if (a) a.href = onboardingTokenHref();
}

// Reflect state into the card: hidden when dismissed or all done, else the three
// steps with their done marks. Safe from any view — the card lives in the settings
// section, so a call while it's offscreen just updates hidden DOM.
function renderOnboarding() {
  const card = $('onboarding-card');
  if (!card) return;
  if (obState.dismissed || onboardingAllDone()) { card.hidden = true; return; }
  card.hidden = false;
  $('onboarding-step-token').classList.toggle('done', obState.token);
  $('onboarding-step-project').classList.toggle('done', obState.project);
  $('onboarding-step-run').classList.toggle('done', obState.run);
  updateOnboardingTokenLink();
}

// Mark a step done (idempotent), persist, and re-reflect (hides on the last one).
function markOnboardingStep(step) {
  if (obState[step]) return;
  obState[step] = true;
  persistOnboarding();
  renderOnboarding();
}

function dismissOnboarding() {
  if (obState.dismissed) return;
  obState.dismissed = true;
  persistOnboarding();
  renderOnboarding();
}

const Onboarding = {
  init: onboardingInit,
  render: renderOnboarding,
  updateTokenLink: updateOnboardingTokenLink,
  markToken: () => markOnboardingStep('token'),
  markProject: () => markOnboardingStep('project'),
  markRun: () => markOnboardingStep('run'),
  dismiss: dismissOnboarding,
};
