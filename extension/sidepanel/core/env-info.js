// Uploaded as testrun meta on every write: a new or renamed key changes what leaves the browser.

// Toggle: absent/undefined -> on; explicit `false` -> off.
function envInfoEnabled(settings) {
  return !(settings && settings.envInfoOnFail === false);
}

// Full URL is off unless set, the inverse of the above: a query can carry a session id.
function envFullUrlEnabled(settings) {
  return !!(settings && settings.envFullUrl === true);
}

// Rebuilt from `origin + pathname`: `origin` also drops `user:pass@`, a secret like a query token.
function envTrimUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return raw; }
  // A scheme with no real origin (chrome://, about:, file:) reads "null": hand the address over as is.
  if (!u.origin || u.origin === 'null') return raw;
  const trimmed = `${u.origin}${u.pathname}`;
  return trimmed === u.href ? trimmed : `${trimmed} (query trimmed)`;
}

// UA-string fallback when Client Hints are missing; Edge/Opera first, their UAs carry `Chrome/` too.
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

// Prefers UA-Client-Hints; the panel's own UA equals the tested tab's UA.
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

// A mobile platform hint the UA does not confirm is a lie (extensions are desktop-only): UA wins.
function envOs() {
  const hinted = navigator.userAgentData?.platform;
  if (!hinted) return uaOs(navigator.userAgent);
  if (hinted === 'Android' || hinted === 'iOS') {
    const parsed = uaOs(navigator.userAgent);
    if (parsed !== hinted) return parsed === 'Unknown' ? 'Linux' : parsed;
  }
  return hinted;
}

// null for anything but a readable http(s) tab, so its keys are omitted, not failing the write.
async function envSiteTab() {
  try {
    if (typeof resolveSiteTab !== 'function') return null;
    const site = await resolveSiteTab();
    return site.state === 'ok' ? site.tab : null;
  } catch { return null; }
}

// Measured inside the tab: the panel's `screen` is the monitor; '' beats a wrong value.
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

// Empty when the toggle is off, so the caller skips the write entirely.
async function collectEnvMeta(settings) {
  if (!envInfoEnabled(settings)) return [];
  const entries = [
    ['Browser', envBrowser()],
    ['OS', envOs()],
  ];
  // Resolved once: two keys off one tab can never describe two different tabs.
  const tab = await envSiteTab();
  const viewport = tab ? await envTabViewport(tab) : '';
  if (viewport) entries.push(['Viewport', viewport]);
  const url = tab && tab.url ? tab.url : '';
  if (url) entries.push(['URL', envFullUrlEnabled(settings) ? url : envTrimUrl(url)]);
  return entries;
}
