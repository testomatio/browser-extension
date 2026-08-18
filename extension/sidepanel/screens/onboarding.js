// Onboarding checklist: a first-run Settings card for token → project → first run.
// Already-configured users are seeded as done, so it never appears for them.

/* global $, state, hasChrome */

const ONBOARDING_KEY = 'onboarding';

// { token, project, run, dismissed } — the three step flags + the early dismiss.
let obState = { token: false, project: false, run: false, dismissed: false };

function persistOnboarding() {
  if (!hasChrome) return;
  chrome.storage.local.set({ [ONBOARDING_KEY]: obState });
}

// Seeded once from the persisted value, else derived from the existing config +
// last session — so an already-working user starts fully done.
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

// The ACTIVE instance's access-tokens page: the saved instance, else the live
// Instance field, else app.testomat.io.
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

// Safe to call from any view — the card lives in the settings section, so an
// offscreen call just updates hidden DOM.
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

// Idempotent; the last step hides the card.
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
