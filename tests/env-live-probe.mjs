#!/usr/bin/env node
// Reads what the panel's env-info would report in a real branded browser on a real OS (#12).
// A blank page is a valid stand-in: platform/brand client hints are browser-global, not
// per-document, and branded Chrome 137+ refuses --load-extension.
// The page must be a SECURE context though — navigator.userAgentData is undefined on
// about:blank/http, which would silently measure the UA-string fallback instead.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANNELS = ['chrome', 'msedge'];
const EXPECTED_OS = ['Windows', 'macOS', 'Linux'];

const channel = process.env.BROWSER_CHANNEL;
const expectOs = process.env.EXPECT_OS;

if (!CHANNELS.includes(channel)) {
  console.error(`BROWSER_CHANNEL must be one of ${CHANNELS.join(' | ')}, got: ${channel ?? '(unset)'}`);
  process.exit(1);
}
if (!EXPECTED_OS.includes(expectOs)) {
  console.error(`EXPECT_OS must be one of ${EXPECTED_OS.join(' | ')}, got: ${expectOs ?? '(unset)'}`);
  process.exit(1);
}

const { chromium } = await import('playwright');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envInfoSource = readFileSync(join(repoRoot, 'extension/sidepanel/core/env-info.js'), 'utf8');

const browser = await chromium.launch({ channel, headless: false });

try {
  const page = await browser.newPage();
  // Empty https page fulfilled locally: a secure context without a server or network.
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('https://env-probe.local/');
  // Plain top-level script: injecting it makes envOs/envBrowser page globals.
  await page.addScriptTag({ content: envInfoSource });

  const info = await page.evaluate(() => ({
    os: envOs(),
    browser: envBrowser(),
    uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    ua: navigator.userAgent,
  }));
  console.log(JSON.stringify(info, null, 2));

  const browserPattern = channel === 'msedge' ? /^Edge \d+$/ : /^Chrome \d+$/;
  const problems = [];
  if (info.uaDataPlatform === null) {
    problems.push('UA client hints unavailable — this run measured the UA-string fallback, not the hints path');
  }
  if (info.os !== expectOs) problems.push(`OS: expected "${expectOs}", got "${info.os}"`);
  if (!browserPattern.test(info.browser)) {
    problems.push(`Browser: expected ${browserPattern} for channel "${channel}", got "${info.browser}"`);
  }

  if (problems.length) {
    console.error(`\nenv-live-probe FAILED on ${channel}:\n  ${problems.join('\n  ')}`);
    console.error(`evidence: ${JSON.stringify(info)}`);
    process.exitCode = 1;
  } else {
    console.log(`\nenv-live-probe ok: ${channel} on ${expectOs} reported OS="${info.os}" Browser="${info.browser}"`);
  }
} finally {
  await browser.close();
}
