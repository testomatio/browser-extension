// Env info collected client-side at status-write time, written as testrun META keys.
// They are UPLOADED on every write: a new or renamed key changes what leaves the browser.

// Toggle: absent/undefined -> ON; explicit `false` -> OFF.
function envInfoEnabled(settings) {
  return !(settings && settings.envInfoOnFail === false);
}

// Full-URL toggle (#177): absent/undefined -> OFF, deliberately the INVERSE of the
// rule above — a query string can carry a session id, and project members see it.
function envFullUrlEnabled(settings) {
  return !!(settings && settings.envFullUrl === true);
}

// Always REBUILT from `origin + pathname`, never the raw string: `origin` also drops
// `user:pass@` userinfo, the same class of secret as a query token.
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
    // Mobile Safari interleaves `Mobile/15E148` between the version and `Safari/`.
    [/Version\/(\d+)[\d.]*.*\bSafari\//, 'Safari'],
  ]) { const m = ua.match(re); if (m) return `${name} ${m[1]}`; }
  return 'Unknown';
}

function uaOs(ua) {
  if (/Windows NT/.test(ua)) return 'Windows';
  // iOS before macOS: every iOS UA carries "like Mac OS X".
  if (/(iPhone|iPad|iPod)/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

// Prefers UA-Client-Hints (low-entropy brands expose only the major version);
// the panel's own UA equals the tested tab's UA.
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
// A mobile platform hint the UA string does not confirm is the #12 lie — extensions
// run on desktop only — so the UA parse wins; those builds are Linux when it is Unknown.
function envOs() {
  const hinted = navigator.userAgentData?.platform;
  if (!hinted) return uaOs(navigator.userAgent);
  if (hinted === 'Android' || hinted === 'iOS') {
    const parsed = uaOs(navigator.userAgent);
    if (parsed !== hinted) return parsed === 'Unknown' ? 'Linux' : parsed;
  }
  return hinted;
}

// The site tab via resolveSiteTab. null for anything but a readable http(s) tab, so the
// keys read off it are omitted rather than failing the write.
async function envSiteTab() {
  try {
    if (typeof resolveSiteTab !== 'function') return null;
    const site = await resolveSiteTab();
    return site.state === 'ok' ? site.tab : null;
  } catch { return null; }
}

// Measured INSIDE the tab: the panel's own `screen` is the monitor, not the window a
// layout bug reproduced in. '' whenever the read cannot be trusted — a missing value
// beats a wrong one.
async function envTabViewport(tab) {
  const tabId = tab && tab.id != null ? tab.id : null;
  if (tabId == null) return '';
  if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => [window.innerWidth, window.innerHeight],
    });
    const [w, h] = Array.isArray(res?.result) ? res.result : [];
    if (!Number.isFinite(w) || !Number.isFinite(h)) return '';
    return `${Math.round(w)}×${Math.round(h)}`;
  } catch { return ''; }
}

// The env facts as `[key, value]` meta pairs — the shape the testrun-meta write
// takes. Empty when the toggle is off, so the caller skips the write entirely.
async function collectEnvMeta(settings) {
  if (!envInfoEnabled(settings)) return [];
  const entries = [
    ['Browser', envBrowser()],
    ['OS', envOs()],
  ];
  // Resolved ONCE: two keys off one tab can never describe two different tabs.
  const tab = await envSiteTab();
  const viewport = tab ? await envTabViewport(tab) : '';
  if (viewport) entries.push(['Viewport', viewport]);
  const url = tab && tab.url ? tab.url : '';
  if (url) entries.push(['URL', envFullUrlEnabled(settings) ? url : envTrimUrl(url)]);
  return entries;
}
