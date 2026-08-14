// Auto env-info captured on a status write (cycle 008a, M2 Evidence Kit).
// Client-side only, collected at click time — no new permission or storage key;
// the toggle rides on the existing `settings` object.
//
// Since #116 the facts no longer land in the comment as an `Env:` line: they are
// written as testrun META keys (Browser / OS / Viewport / URL), so the Failure
// box holds only the actual failure. test-view.js writeStatus is the only
// consumer. The collector is status-agnostic — the meta write covers passed and
// skipped too, which the comment line never did.
//
// These keys are UPLOADED on every status write, so they are user-facing: adding
// or renaming one changes what a tester sees leave their browser.

// Toggle: absent/undefined -> ON (the A2 undefined-rule);
// explicit `false` -> OFF.
function envInfoEnabled(settings) {
  return !(settings && settings.envInfoOnFail === false);
}

// Full-URL toggle (#177): absent/undefined -> OFF, the INVERSE of the
// undefined-rule above and deliberately so. A query string routinely carries a
// password-reset token, a signed link or a session id, and whatever lands here is
// visible to everyone with project access — so the safe value is the one you get
// without deciding.
function envFullUrlEnabled(settings) {
  return !!(settings && settings.envFullUrl === true);
}

// Always REBUILT from `origin + pathname`, never short-circuited back to the raw
// string: `origin` also drops `user:pass@` userinfo, which is the same class of
// secret as a query token. The trailing `(query trimmed)` marks a value that lost
// something — compared against the parsed href, so a URL with nothing to lose
// stays unmarked.
// Anything unparseable is passed through; envActiveTabUrl only yields http(s).
function envTrimUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return raw; }
  const trimmed = `${u.origin}${u.pathname}`;
  return trimmed === u.href ? trimmed : `${trimmed} (query trimmed)`;
}

// UA-string fallbacks — used only when UA-Client-Hints is unavailable. Edge/Opera
// are checked before Chrome (their UA strings also carry a `Chrome/` token).
function uaBrowser(ua) {
  for (const [re, name] of [
    [/\bEdg\/(\d+)/, 'Edge'], [/\bOPR\/(\d+)/, 'Opera'],
    [/\bChrome\/(\d+)/, 'Chrome'], [/\bFirefox\/(\d+)/, 'Firefox'],
    [/Version\/(\d+)[\d.]*\s+Safari/, 'Safari'],
  ]) { const m = ua.match(re); if (m) return `${name} ${m[1]}`; }
  return 'Unknown';
}

function uaOs(ua) {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(ua)) return 'iOS';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

// Browser brand + major. Prefers UA-Client-Hints (low-entropy brands expose only
// the major version, which is exactly what we want); the panel's own UA equals
// the tested tab's UA.
function envBrowser() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length) {
    const real = brands.filter((b) => b && !/not.?a.?brand/i.test(b.brand));
    const pick = real.find((b) => /edge/i.test(b.brand))
      || real.find((b) => /opr|opera/i.test(b.brand))
      || real.find((b) => /chrome/i.test(b.brand))
      || real.find((b) => /chromium/i.test(b.brand))
      || real[0];
    if (pick) return `${pick.brand.replace(/^(Google|Microsoft)\s+/, '')} ${pick.version}`.trim();
  }
  return uaBrowser(navigator.userAgent);
}

// OS name: UA-CH platform ("macOS"/"Windows"/"Linux"/…), else a UA-string parse.
function envOs() {
  return navigator.userAgentData?.platform || uaOs(navigator.userAgent);
}

// Active tab URL via resolveSiteTab — the same verdict every page-touching feature
// uses. '' for anything but an http(s) tab we can read (a restricted page, no
// tab), so the URL segment is simply omitted rather than failing the comment.
async function envActiveTabUrl() {
  try {
    if (typeof resolveSiteTab !== 'function') return '';
    const site = await resolveSiteTab();
    return site.state === 'ok' ? site.tab.url : '';
  } catch { return ''; }
}

// The env facts as `[key, value]` meta pairs (#116) — the shape the testrun-meta
// write takes. Empty array when the toggle is off, so the caller skips the write
// entirely. `URL` is simply omitted when the active tab is not a readable http(s)
// page: the same graceful degradation the `Env:` line had, one key short rather
// than a failed write.
async function collectEnvMeta(settings) {
  if (!envInfoEnabled(settings)) return [];
  const entries = [
    ['Browser', envBrowser()],
    ['OS', envOs()],
    ['Viewport', `${screen.width}×${screen.height}`],
  ];
  const url = await envActiveTabUrl();
  if (url) entries.push(['URL', envFullUrlEnabled(settings) ? url : envTrimUrl(url)]);
  return entries;
}
