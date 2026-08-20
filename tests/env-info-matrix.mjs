#!/usr/bin/env node
// Sample matrix for envOs()/envBrowser() (#12). Expectations describe the POST-FIX
// truth: a UA-CH platform that contradicts a desktop UA must not win.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repoRoot, 'extension/sidepanel/core/env-info.js'), 'utf8');

// env-info.js is a plain top-level script, so its declarations land on the sandbox.
function loadEnvInfo(navigator) {
  const sandbox = { navigator };
  runInNewContext(source, sandbox);
  return sandbox;
}

const WIN_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const WIN_EDGE = `${WIN_CHROME} Edg/138.0.0.0`;
const MAC_EDGE = `${MAC_CHROME} Edg/138.0.0.0`;
const LINUX_EDGE = `${LINUX_CHROME} Edg/138.0.0.0`;
const MAC_OPERA = `${MAC_CHROME} OPR/122.0.0.0`;
const CROS_CHROME =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MAC_HEADLESS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36';
const ANDROID_MOBILE =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const CHROME_BRANDS = [
  { brand: 'Not)A;Brand', version: '99' },
  { brand: 'Google Chrome', version: '138' },
  { brand: 'Chromium', version: '138' },
];
const EDGE_BRANDS = [
  { brand: 'Not)A;Brand', version: '99' },
  { brand: 'Microsoft Edge', version: '138' },
  { brand: 'Chromium', version: '138' },
];
const OPERA_BRANDS = [
  { brand: 'Not)A;Brand', version: '99' },
  { brand: 'Opera', version: '122' },
  { brand: 'Chromium', version: '138' },
];

const cases = [
  { name: 'win-chrome', uaData: { platform: 'Windows', brands: CHROME_BRANDS }, ua: WIN_CHROME, os: 'Windows', browser: 'Chrome 138' },
  { name: 'mac-chrome', uaData: { platform: 'macOS', brands: CHROME_BRANDS }, ua: MAC_CHROME, os: 'macOS', browser: 'Chrome 138' },
  { name: 'linux-chrome', uaData: { platform: 'Linux', brands: CHROME_BRANDS }, ua: LINUX_CHROME, os: 'Linux', browser: 'Chrome 138' },
  { name: 'win-edge', uaData: { platform: 'Windows', brands: EDGE_BRANDS }, ua: WIN_EDGE, os: 'Windows', browser: 'Edge 138' },
  { name: 'mac-edge', uaData: { platform: 'macOS', brands: EDGE_BRANDS }, ua: MAC_EDGE, os: 'macOS', browser: 'Edge 138' },
  { name: 'linux-edge', uaData: { platform: 'Linux', brands: EDGE_BRANDS }, ua: LINUX_EDGE, os: 'Linux', browser: 'Edge 138' },
  { name: 'mac-opera', uaData: { platform: 'macOS', brands: OPERA_BRANDS }, ua: MAC_OPERA, os: 'macOS', browser: 'Opera 122' },
  { name: 'cros-chrome', uaData: { platform: 'Chrome OS', brands: CHROME_BRANDS }, ua: CROS_CHROME, os: 'Chrome OS', browser: 'Chrome 138' },
  // Today's honest fallback: \bChrome\/ does not match inside HeadlessChrome/.
  { name: 'headless-no-hints', uaData: undefined, ua: MAC_HEADLESS, os: 'macOS', browser: 'Unknown' },
  { name: 'issue12-lying-android-linux', uaData: { platform: 'Android', brands: CHROME_BRANDS }, ua: LINUX_CHROME, os: 'Linux', browser: 'Chrome 138' },
  { name: 'lying-android-windows', uaData: { platform: 'Android', brands: CHROME_BRANDS }, ua: WIN_CHROME, os: 'Windows', browser: 'Chrome 138' },
  { name: 'real-android-consistent', uaData: { platform: 'Android', brands: CHROME_BRANDS }, ua: ANDROID_MOBILE, os: 'Android', browser: 'Chrome 138' },
  { name: 'ios-ua-fallback', uaData: undefined, ua: IPHONE_SAFARI, os: 'iOS', browser: 'Safari 17' },
  { name: 'linux-ua-fallback', uaData: undefined, ua: LINUX_CHROME, os: 'Linux', browser: 'Chrome 138' },
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const env = loadEnvInfo({ userAgent: testCase.ua, userAgentData: testCase.uaData });
  const actual = { os: env.envOs(), browser: env.envBrowser() };
  if (actual.os === testCase.os && actual.browser === testCase.browser) {
    passed += 1;
    console.log(`ok ${testCase.name}`);
  } else {
    failed += 1;
    console.log(
      `FAIL ${testCase.name}: expected OS=${testCase.os} Browser=${testCase.browser} ` +
        `got OS=${actual.os} Browser=${actual.browser}`,
    );
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
