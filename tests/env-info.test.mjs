#!/usr/bin/env node
// What the panel writes down about the tester's machine when a result is saved (#153): the browser
// and OS names, the tested tab's own window size, and the address with the query cut off it. This
// file also IS the old tests/env-info-matrix.mjs — its fourteen sample rows now run in CI.
// Run: node --test tests/env-info.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvInfo, nav, plain, scripting } from './helpers/core-harness.mjs';

// ---- the sample UA strings, carried over from the matrix unchanged ----------

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
const IPAD_SAFARI =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WIN_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

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

// The panel with no page in front of it — enough to reach the pure helpers.
const bare = () => loadEnvInfo({ navigator: nav(WIN_CHROME, undefined) });
const on = (userAgent, userAgentData) => loadEnvInfo({ navigator: nav(userAgent, userAgentData) });

// ---- A: the two toggles ----------------------------------------------------

test('#153-1: a tester who never touched the setting gets the env info written', () => {
  const e = bare();
  assert.equal(e.envInfoEnabled(undefined), true);
  assert.equal(e.envInfoEnabled({}), true);
  assert.equal(e.envInfoEnabled({ envInfoOnFail: true }), true);
});

test('#153-2: a tester who switched it off gets nothing written', () => {
  assert.equal(bare().envInfoEnabled({ envInfoOnFail: false }), false);
});

test('#153-3: only the word "false" switches the env info off, not any falsy leftover', () => {
  const e = bare();
  assert.equal(e.envInfoEnabled({ envInfoOnFail: 0 }), true);
  assert.equal(e.envInfoEnabled({ envInfoOnFail: null }), true);
  assert.equal(e.envInfoEnabled({ envInfoOnFail: '' }), true);
});

test('#153-4: the full address is off until the tester asks for it — the deliberate opposite', () => {
  const e = bare();
  assert.equal(e.envFullUrlEnabled(undefined), false);
  assert.equal(e.envFullUrlEnabled({}), false);
  assert.equal(e.envFullUrlEnabled({ envFullUrl: 'yes' }), false, 'only the real switch counts');
});

test('#153-5: a tester who ticked "send the full URL" gets it', () => {
  assert.equal(bare().envFullUrlEnabled({ envFullUrl: true }), true);
});

// ---- B: the address the developer will read --------------------------------

test('#153-6: an ordinary page address goes out as it is, with no note added', () => {
  assert.equal(bare().envTrimUrl('https://a.io/checkout'), 'https://a.io/checkout');
});

test('#153-7: a bare host keeps its slash and still counts as untouched', () => {
  assert.equal(bare().envTrimUrl('https://a.io'), 'https://a.io/');
});

test('#153-8: a password-reset link loses its token and says so', () => {
  assert.equal(bare().envTrimUrl('https://a.io/reset?token=abc#f'),
    'https://a.io/reset (query trimmed)');
  // The fragment alone is cut too, by the same rebuild.
  assert.equal(bare().envTrimUrl('https://a.io/x#step-3'), 'https://a.io/x (query trimmed)');
});

test('#153-9: a login baked into the address is dropped, and the note is a little too eager', () => {
  // Nothing was queried, yet the line still reads "(query trimmed)" — pinned so a reword is deliberate.
  assert.equal(bare().envTrimUrl('https://u:p@a.io/x'), 'https://a.io/x (query trimmed)');
});

test('#153-10: an internal browser page comes out as the word "null"', () => {
  // Today's real answer. Unreachable in the panel (only readable http(s) tabs get this far), but
  // wrong on its face — the desired reading is the todo below.
  assert.equal(bare().envTrimUrl('chrome://extensions'), 'null (query trimmed)');
  // …and one whose path is not slash-led glues straight onto that word.
  assert.equal(bare().envTrimUrl('about:blank'), 'nullblank (query trimmed)');
});

test.todo('#153-10b: an internal browser page should keep its own name, not become "null"');

test('#153-11: something that is not an address at all is handed back untouched', () => {
  const e = bare();
  assert.equal(e.envTrimUrl('not a url'), 'not a url');
  assert.equal(e.envTrimUrl(''), '');
  assert.equal(e.envTrimUrl(undefined), undefined);
  // …while a real address in the same panel is rebuilt, so the pass-through is not the whole function.
  assert.equal(e.envTrimUrl('https://a.io/x?q=1'), 'https://a.io/x (query trimmed)');
});

test('#153-12: a path written in Cyrillic survives as the browser encodes it', () => {
  assert.equal(bare().envTrimUrl('https://a.io/п/ш?q=1'),
    'https://a.io/%D0%BF/%D1%88 (query trimmed)');
});

// ---- C: reading the browser and the OS off the UA string -------------------

test('#153-13: Edge is called Edge even though its UA also claims Chrome', () => {
  assert.equal(bare().uaBrowser(WIN_EDGE), 'Edge 138');
});

test('#153-14: Opera is called Opera for the same reason', () => {
  assert.equal(bare().uaBrowser(MAC_OPERA), 'Opera 122');
});

test('#153-15: a headless Chrome is not recognised, and says Unknown rather than guessing', () => {
  const e = bare();
  assert.equal(e.uaBrowser(MAC_HEADLESS), 'Unknown');
  assert.equal(e.uaBrowser(MAC_CHROME), 'Chrome 138', 'an ordinary Chrome is still recognised');
});

test('#153-16: Safari on a phone is read past the Mobile build number in the middle', () => {
  assert.equal(bare().uaBrowser(IPHONE_SAFARI), 'Safari 17');
});

test('#153-17: an empty UA string is Unknown', () => {
  assert.equal(bare().uaBrowser(''), 'Unknown');
  assert.equal(bare().uaBrowser(WIN_FIREFOX), 'Firefox 128', 'a browser it does know still lands');
});

test('#153-18: each operating system is named from its own UA marker', () => {
  const e = bare();
  assert.equal(e.uaOs(WIN_CHROME), 'Windows');
  assert.equal(e.uaOs(IPHONE_SAFARI), 'iOS', 'an iPhone UA also says "like Mac OS X"');
  assert.equal(e.uaOs(IPAD_SAFARI), 'iOS');
  assert.equal(e.uaOs(MAC_CHROME), 'macOS');
  assert.equal(e.uaOs(ANDROID_MOBILE), 'Android');
  assert.equal(e.uaOs(CROS_CHROME), 'Chrome OS', 'a Chromebook UA also says Linux');
  assert.equal(e.uaOs(LINUX_CHROME), 'Linux');
  assert.equal(e.uaOs('something else entirely'), 'Unknown');
});

// ---- D: what the browser volunteers, and when it is not believed -----------

test('#153-19: the browser name loses its vendor prefix', () => {
  assert.equal(on(WIN_CHROME, { platform: 'Windows', brands: CHROME_BRANDS }).envBrowser(),
    'Chrome 138');
  assert.equal(on(WIN_EDGE, { platform: 'Windows', brands: EDGE_BRANDS }).envBrowser(), 'Edge 138');
});

test('#153-20: a browser that volunteers only the decoy brand is read off its UA string instead',
  () => {
    const decoy = [{ brand: 'Not)A;Brand', version: '99' }];
    assert.equal(on(MAC_OPERA, { platform: 'macOS', brands: decoy }).envBrowser(), 'Opera 122');
    assert.equal(on(WIN_CHROME, { platform: 'Windows', brands: [] }).envBrowser(), 'Chrome 138');
  });

test('#153-21: a browser that volunteers nothing at all is read off its UA string', () => {
  assert.equal(on(WIN_EDGE, undefined).envBrowser(), 'Edge 138');
});

test('#153-22: a desktop Linux that claims to be Android is not believed', () => {
  assert.equal(on(LINUX_CHROME, { platform: 'Android', brands: CHROME_BRANDS }).envOs(), 'Linux');
});

test('#153-23: the same claim over an unreadable UA still lands on Linux, never on Android', () => {
  assert.equal(on('a browser nobody has heard of', { platform: 'Android', brands: CHROME_BRANDS })
    .envOs(), 'Linux');
});

test('#153-24: a real Android, where the UA agrees, keeps its name', () => {
  assert.equal(on(ANDROID_MOBILE, { platform: 'Android', brands: CHROME_BRANDS }).envOs(), 'Android');
});

// ---- D2: the fourteen sample rows, carried over from tests/env-info-matrix.mjs ----

const MATRIX = [
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

for (const row of MATRIX) {
  test(`#153 sample ${row.name}: reported as ${row.browser} on ${row.os}`, () => {
    const e = on(row.ua, row.uaData);
    assert.equal(e.envOs(), row.os);
    assert.equal(e.envBrowser(), row.browser);
  });
}

// ---- E: the tested tab and its window size ---------------------------------

const okTab = (url = 'https://a.io/x?t=1') => ({ state: 'ok', tab: { id: 7, url } });
const viewport = (w, h) => scripting([{ result: [w, h] }]);

test('#153-25: the window size is the tested tab\'s own, rounded to whole pixels', async () => {
  const s = viewport(1280.4, 720.6);
  const e = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: s.chrome });
  assert.equal(await e.envTabViewport({ id: 7 }), '1280×721');
  assert.deepEqual(plain(s.calls), [{ target: { tabId: 7 } }], 'measured inside that very tab');
});

test('#153-26: a window size the page could not answer is left out, never guessed', async () => {
  const junk = scripting([{ result: ['a', 'b'] }]);
  const e = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: junk.chrome });
  assert.equal(await e.envTabViewport({ id: 7 }), '');
  assert.equal(await loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: viewport(800, 600).chrome })
    .envTabViewport({ id: 7 }), '800×600', 'a good answer in the same shape does come through');
});

test('#153-27: a tab that refuses to be measured leaves the size out', async () => {
  const boom = scripting(new Error('Cannot access contents of the page'));
  const e = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: boom.chrome });
  assert.equal(await e.envTabViewport({ id: 7 }), '');
  assert.equal(boom.calls.length, 1, 'it really was attempted');
});

test('#153-28: with no tab to measure, nothing is measured', async () => {
  const s = viewport(1200, 800);
  const e = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: s.chrome });
  assert.equal(await e.envTabViewport(null), '');
  assert.equal(await e.envTabViewport({}), '');
  assert.equal(await e.envTabViewport({ id: null }), '');
  assert.deepEqual(s.calls, [], 'no tab id, no injection');
  assert.equal(await e.envTabViewport({ id: 0 }), '1200×800', 'tab id 0 is a real tab');
});

test('#153-29: a browser that cannot run scripts in tabs leaves the size out', async () => {
  const noScripting = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: { storage: {} } });
  assert.equal(await noScripting.envTabViewport({ id: 7 }), '');
  const noChrome = loadEnvInfo({ navigator: nav(WIN_CHROME) });
  assert.equal(await noChrome.envTabViewport({ id: 7 }), '');
  const worked = loadEnvInfo({ navigator: nav(WIN_CHROME), chrome: viewport(1024, 768).chrome });
  assert.equal(await worked.envTabViewport({ id: 7 }), '1024×768');
});

test('#153-E1: only a readable page counts as the tested tab', async () => {
  const tab = { id: 7, url: 'https://a.io/x' };
  assert.deepEqual(plain(await loadEnvInfo({
    navigator: nav(WIN_CHROME), resolveSiteTab: async () => ({ state: 'ok', tab }),
  }).envSiteTab()), tab);
  for (const state of ['blocked', 'none', 'internal']) {
    assert.equal(await loadEnvInfo({
      navigator: nav(WIN_CHROME), resolveSiteTab: async () => ({ state }),
    }).envSiteTab(), null);
  }
});

// ---- F: the meta the write actually carries --------------------------------

// The panel over a live tab: browser and OS from the UA hints, the tab from resolveSiteTab.
function panel(over = {}) {
  const s = over.scripting || viewport(1200, 800);
  const seen = [];
  const sandbox = {
    navigator: nav(WIN_CHROME, { platform: 'Windows', brands: CHROME_BRANDS }),
    chrome: s.chrome,
  };
  if (!over.noSiteTab) {
    sandbox.resolveSiteTab = async () => {
      seen.push(1);
      if (over.throws) throw new Error('the tab went away');
      return over.site === undefined ? okTab() : over.site;
    };
  }
  return { ...loadEnvInfo(sandbox), seen, scripting: s };
}

test('#153-30: with the setting off nothing is collected, so nothing is written', async () => {
  const p = panel();
  assert.deepEqual(plain(await p.collectEnvMeta({ envInfoOnFail: false })), []);
  assert.deepEqual(p.seen, [], 'the tab is not even looked up');
  assert.equal((await p.collectEnvMeta({})).length, 4, 'and with the setting on, four lines');
});

test('#153-31: the four lines the developer reads, in that order', async () => {
  assert.deepEqual(plain(await panel().collectEnvMeta({})), [
    ['Browser', 'Chrome 138'],
    ['OS', 'Windows'],
    ['Viewport', '1200×800'],
    ['URL', 'https://a.io/x (query trimmed)'],
  ]);
});

test('#153-32: a tester who asked for the full address gets the query string too', async () => {
  const rows = plain(await panel().collectEnvMeta({ envFullUrl: true }));
  assert.deepEqual(rows[3], ['URL', 'https://a.io/x?t=1']);
});

test('#153-33: on a page the panel cannot see, the machine still goes out and the tab does not',
  async () => {
    assert.deepEqual(plain(await panel({ site: { state: 'blocked' } }).collectEnvMeta({})), [
      ['Browser', 'Chrome 138'],
      ['OS', 'Windows'],
    ]);
  });

test('#153-34: a tab that disappears mid-collect does not sink the whole write', async () => {
  const p = panel({ throws: true });
  assert.deepEqual(plain(await p.collectEnvMeta({})), [['Browser', 'Chrome 138'], ['OS', 'Windows']]);
});

test('#153-35: a panel whose page has no tab resolver at all still reports the machine', async () => {
  assert.deepEqual(plain(await panel({ noSiteTab: true }).collectEnvMeta({})),
    [['Browser', 'Chrome 138'], ['OS', 'Windows']]);
});

test('#153-36: a tab that would not be measured still contributes its address', async () => {
  const p = panel({ scripting: scripting(new Error('blocked')) });
  assert.deepEqual(plain(await p.collectEnvMeta({})), [
    ['Browser', 'Chrome 138'],
    ['OS', 'Windows'],
    ['URL', 'https://a.io/x (query trimmed)'],
  ]);
});

test('#153-37: the tab is looked up once, so the size and the address are the same tab\'s',
  async () => {
    const p = panel();
    await p.collectEnvMeta({});
    assert.equal(p.seen.length, 1);
  });
