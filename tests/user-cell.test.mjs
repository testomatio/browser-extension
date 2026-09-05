#!/usr/bin/env node
// #181: a PERSON, printed — extension/shared/user-cell.js. Wherever a run or a test names who ran it
// or who it is assigned to, the tester sees a circle of initials and a name. The server sends that
// person in half a dozen shapes (a bare string, an address, a record with `username`, one with
// `avatar-url`), and this file is what turns every one of them into the same cell.
// Three things here are worth reading twice. The INITIALS are split on non-letters, so `j.doe` is
// two initials and not "j."; they come back lower-case, because it is CSS that shouts them. The
// PHOTO never goes out on a bare fetch: it goes through TestomatAPI.fetchAsset with `instanceOnly`,
// which is what keeps an avatar host named in server data from getting a request at all — an avatar
// that cannot be fetched simply leaves the monogram standing. And the cell NEVER re-reads the
// document: a repaint that threw the cell away leaves the swap landing on a detached node.
// Run: node --test tests/user-cell.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle } from './helpers/shared-harness.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

// A response shaped like the one api.js's fetchAsset hands back: `ok`, a `headers.get` and a blob.
const response = (type, body = 'PNGBYTES') => ({
  ok: true,
  status: 200,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
  blob: async () => ({ type, body }),
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// `photos` is a module-level cache keyed by URL, so every row gets its OWN load — otherwise the
// second test reads the first one's stubbed avatar back out of it.
function load({ api = true, tooltip = true, fetchAsset = async () => response('image/png') } = {}) {
  const doc = makeDocument();
  const calls = { fetches: [], tips: [], minted: [], revoked: [] };
  const sandbox = {
    window: {},
    document: doc,
    // Absent in a bare vm context; a counting stub is how the object-URL ledger is read.
    URL: {
      createObjectURL: (blob) => {
        calls.minted.push(blob);
        return `blob:photo/${calls.minted.length}`;
      },
      revokeObjectURL: (url) => { calls.revoked.push(url); },
    },
  };
  if (api) {
    sandbox.TestomatAPI = {
      fetchAsset: (url, opts) => {
        calls.fetches.push({ url, opts: { ...opts } });
        return fetchAsset(url, opts);
      },
    };
  }
  if (tooltip) {
    sandbox.Tooltip = {
      set: (node, tip) => {
        calls.tips.push({ node, tip });
        if (node && node.dataset) node.dataset.tip = String(tip);
      },
    };
  }
  loadInto(sandbox, ['shared/user-cell.js']);
  return { U: sandbox.window.UserCell, doc, calls };
}

const { U } = load();
const avatarOf = (cell) => cell.querySelector('.avatar');
const nameOf = (cell) => cell.querySelector('.user-name');

// ---- the shapes a person arrives in ------------------------------------------------------------

test('1: a value naming nobody is nobody — null, blank, whitespace and a number alike', () => {
  for (const nothing of [null, undefined, '', '   ', 42, true, []]) {
    assert.equal(U.normalize(nothing), null, `${JSON.stringify(nothing)} should name nobody`);
  }
});

test('2: a bare address is an address, and carries no avatar key at all', () => {
  assert.deepEqual(plain(U.normalize('qa@x.io')), { name: '', email: 'qa@x.io' });
  assert.deepEqual(Object.keys(plain(U.normalize('qa@x.io'))), ['name', 'email']);
});

test('3: a bare string with no @ in it is a name', () => {
  assert.deepEqual(plain(U.normalize('Ann Lee')), { name: 'Ann Lee', email: '' });
  assert.deepEqual(plain(U.normalize('  Ann Lee  ')), { name: 'Ann Lee', email: '' });
});

test('4: a record names its person by whichever of name, username or title arrived', () => {
  assert.deepEqual(plain(U.normalize({ username: 'ann', 'avatar-url': ' u ' })),
    { name: 'ann', email: '', avatar: 'u' });
  assert.deepEqual(plain(U.normalize({ title: 'QA Bot' })), { name: 'QA Bot', email: '', avatar: '' });
  assert.deepEqual(plain(U.normalize({ name: 'Ann', username: 'ann' })).name, 'Ann'); // name wins
  assert.deepEqual(plain(U.normalize({ avatarUrl: 'u', email: 'a@b' })),
    { name: '', email: 'a@b', avatar: 'u' });
});

test('5: a photo with no name and no address is not a person — the row is dropped', () => {
  assert.equal(U.normalize({ avatarUrl: 'u' }), null);
  assert.equal(U.normalize({ name: '   ', email: '  ' }), null);
});

// ---- what the tester reads beside the circle ---------------------------------------------------

test('6: with no name, the address is shown by its local part', () => {
  assert.equal(U.displayName('qa@x.io'), 'qa');
});

test('7: an address that BEGINS with @ is shown whole rather than as an empty name', () => {
  assert.equal(U.displayName('@x.io'), '@x.io');
});

test('8: a person with both a name and an address is shown by the name', () => {
  assert.equal(U.displayName({ name: 'Ann', email: 'a@b' }), 'Ann');
  assert.equal(U.displayName(null), '');
});

// ---- the circle ---------------------------------------------------------------------------------

test('9: a dotted login is two initials, not a letter and a dot — and the JS leaves them lower-case', () => {
  assert.equal(U.initials('j.doe'), 'jd'); // CSS shouts them; nothing here upper-cases
});

// Two words is the common case and hides the rule. Three tells you which two letters are taken:
// the first of the first word and the first of the SECOND, never the last.
test('9b: a three-part name is read from its first two words, not its first and last', () => {
  assert.equal(U.initials('Ann Marie Lee'), 'AM');
  assert.equal(U.initials('Jean de la Fontaine'), 'Jd');
});

test('10: one word gives its first two letters', () => {
  assert.equal(U.initials('Ann'), 'An');
});

test('11: a one-letter name gives the one letter', () => {
  assert.equal(U.initials('A'), 'A');
});

test('12: a name that is nothing but punctuation falls back to a question mark', () => {
  assert.equal(U.initials('...'), '?');
});

test('13: a name in Cyrillic is initialled by its own letters', () => {
  assert.equal(U.initials('Олена Ковальчук'), 'ОК');
});

test('14: a name with no spaces in it at all takes its first two characters', () => {
  assert.equal(U.initials('张伟'), '张伟');
});

test('15: a plus-addressed account is split on the plus, not shown as one blob', () => {
  assert.equal(U.initials('qa+ci@x.io'), 'qc');
});

test('16: a record naming nobody still gets a circle to stand in — a question mark', () => {
  assert.equal(U.initials({}), '?');
  assert.equal(U.initials(null), '?');
});

// ---- the photo, and the one road it may travel --------------------------------------------------

test('17: a photo served over plain http is never fetched — the monogram stays', async () => {
  const h = load();
  const cell = h.U.cell({ name: 'Ann', avatar: 'http://x/a.png' });
  await settle();
  assert.deepEqual(h.calls.fetches, []);
  assert.equal(avatarOf(cell).textContent, 'An');
  assert.equal(avatarOf(cell).classList.contains('has-photo'), false);
});

test('18: an inline data: photo is not fetched either', async () => {
  const h = load();
  const cell = h.U.cell({ name: 'Ann', avatar: 'data:image/png;base64,QQ==' });
  await settle();
  assert.deepEqual(h.calls.fetches, []);
  assert.equal(avatarOf(cell).textContent, 'An');
});

test('19: an avatar on somebody else’s server goes through the API with instanceOnly, and a refusal leaves the initials', async () => {
  const h = load({ fetchAsset: async (url, opts) => { throw new Error(`refused ${url} ${!!opts.instanceOnly}`); } });
  const cell = h.U.cell({ name: 'Ann', avatar: 'https://gravatar.com/x' });
  await settle();
  // The refusal is fetchAsset's to make; what this file owes is the flag that asks for it.
  assert.deepEqual(plain(h.calls.fetches), [{ url: 'https://gravatar.com/x', opts: { instanceOnly: true } }]);
  assert.equal(avatarOf(cell).textContent, 'An');
  assert.deepEqual(h.calls.minted, []);
});

test('20: an avatar the instance does serve is minted as a blob and swapped in over the initials', async () => {
  const h = load();
  const cell = h.U.cell({ name: 'Ann Lee', avatar: 'https://a.io/u/1.png' });
  assert.equal(avatarOf(cell).textContent, 'AL'); // the monogram is what is drawn first
  await settle();
  assert.equal(h.calls.minted.length, 1);
  assert.equal(plain(h.calls.minted[0]).type, 'image/png');
  const img = avatarOf(cell).querySelector('img');
  assert.equal(img.getAttribute('src'), 'blob:photo/1');
  assert.equal(img.getAttribute('alt'), null); // empty alt: the name beside it is the label
  assert.equal(avatarOf(cell).textContent, ''); // the initials were replaced, not appended to
  assert.equal(avatarOf(cell).classList.contains('has-photo'), true);
});

test('21: the sign-in PAGE a signed-out fetch gets back is not a photo — the monogram stays', async () => {
  const h = load({ fetchAsset: async () => response('text/html') });
  const cell = h.U.cell({ name: 'Ann', avatar: 'https://a.io/u/1.png' });
  await settle();
  assert.deepEqual(h.calls.minted, []);
  assert.equal(avatarOf(cell).textContent, 'An');
  assert.equal(avatarOf(cell).classList.contains('has-photo'), false);
});

// 21b's refusal has no content-type, so the type check alone would also reject it. This one calls
// itself an image: the STATUS has to be believed on its own, or an error page is drawn as a face.
test('21c: a refusal that claims to be an image is still a refusal', async () => {
  const h = load({ fetchAsset: async () => ({
    ok: false,
    status: 403,
    headers: { get: () => 'image/png' },
    blob: async () => ({ type: 'image/png' }),
  }) });
  const cell = h.U.cell({ name: 'Ann Lee', avatar: 'https://x.test/a.png' });
  await settle();
  assert.deepEqual(h.calls.minted, [], 'nothing is minted from a page that refused us');
  assert.equal(avatarOf(cell).textContent, 'AL', 'the monogram stands instead of a stranger\u2019s face');
});

test('21b: a 404 or a 403 on the avatar leaves the monogram rather than an empty circle', async () => {
  const h = load({ fetchAsset: async () => ({ ok: false, status: 403, headers: { get: () => null } }) });
  const cell = h.U.cell({ name: 'Ann', avatar: 'https://a.io/u/1.png' });
  await settle();
  assert.deepEqual(h.calls.minted, []);
  assert.equal(avatarOf(cell).textContent, 'An');
});

test('22: a fetch that blows up outright does not take the row with it', async () => {
  const h = load({ fetchAsset: async () => { throw new Error('offline'); } });
  const cell = h.U.cell({ name: 'Ann', avatar: 'https://a.io/u/1.png' });
  await settle();
  assert.equal(avatarOf(cell).textContent, 'An');
});

test('23: the same face on twenty rows is fetched once — the cache is keyed by URL', async () => {
  const h = load();
  const url = 'https://a.io/u/1.png';
  const cells = [h.U.cell({ name: 'Ann', avatar: url }), h.U.cell({ name: 'Ann', avatar: url }),
    h.U.cell({ name: 'Ann', avatar: url })];
  await settle();
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.minted.length, 1);
  // …and every one of the three cells got the one blob.
  for (const c of cells) assert.equal(avatarOf(c).querySelector('img').getAttribute('src'), 'blob:photo/1');
});

test('24: on a page that never loaded the API this file still draws — the photo is simply skipped', async () => {
  const h = load({ api: false });
  const cell = h.U.cell({ name: 'Ann', avatar: 'https://a.io/u/1.png' });
  await settle();
  assert.equal(avatarOf(cell).textContent, 'An');
  assert.deepEqual(h.calls.minted, []);
});

// ---- the cell -----------------------------------------------------------------------------------

test('25: a value naming nobody builds no cell — the caller drops the whole row', () => {
  const h = load();
  assert.equal(h.U.cell(null), null);
  assert.equal(h.U.cell({ avatarUrl: 'u' }), null);
});

test('26: a named person is a circle the screen reader skips plus the name, with both in the tooltip', () => {
  const h = load();
  const cell = h.U.cell({ name: 'Ann', email: 'a@b' });
  assert.equal(cell.tagName, 'SPAN');
  assert.equal(cell.className, 'user-cell');
  assert.equal(avatarOf(cell).getAttribute('aria-hidden'), 'true'); // the name beside it is the label
  assert.equal(avatarOf(cell).textContent, 'An');
  assert.equal(nameOf(cell).textContent, 'Ann');
  assert.deepEqual(plain(h.calls.tips.map((t) => t.tip)), ['Ann · a@b']);
  assert.equal(h.calls.tips[0].node, cell);
});

test('26b: with no tooltip machinery on the page the cell is built all the same', () => {
  const h = load({ tooltip: false });
  const cell = h.U.cell({ name: 'Ann', email: 'a@b' });
  assert.equal(nameOf(cell).textContent, 'Ann');
});

test('27: an address-only person is named by its local part in the row AND in the tooltip', () => {
  const h = load();
  const cell = h.U.cell({ email: 'a@b' });
  assert.equal(nameOf(cell).textContent, 'a');
  assert.equal(avatarOf(cell).textContent, 'a');
  assert.deepEqual(plain(h.calls.tips.map((t) => t.tip)), ['a · a@b']);
});

test('27b: a person with a name and no address gets a one-part tooltip, not a dangling separator', () => {
  const h = load();
  h.U.cell('Ann Lee');
  assert.deepEqual(plain(h.calls.tips.map((t) => t.tip)), ['Ann Lee']);
});

test('28: a photo landing after the panel repainted swaps into a node nobody is looking at, and throws nothing', async () => {
  const gate = deferred();
  const h = load({ fetchAsset: () => gate.promise });
  const box = h.doc.createElement('div');
  box.append(h.U.cell({ name: 'Ann', avatar: 'https://a.io/u/1.png' }));
  const orphan = box.querySelector('.avatar');
  box.replaceChildren(); // the repaint: the cell is gone before the bytes arrive
  gate.resolve(response('image/png'));
  await settle();
  assert.equal(box.childNodes.length, 0);
  assert.equal(orphan.querySelector('img').getAttribute('src'), 'blob:photo/1');
  assert.equal(orphan.classList.contains('has-photo'), true);
});

test('29: fifty different faces mint fifty object URLs and revoke none — this file has no release()', async () => {
  const h = load();
  for (let i = 0; i < 50; i += 1) h.U.cell({ name: `P${i}`, avatar: `https://a.io/u/${i}.png` });
  await settle();
  assert.equal(h.calls.minted.length, 50);
  assert.deepEqual(h.calls.revoked, []);
  // ImgHydrate has a ledger and a release(); the surface here is the four functions and no more.
  assert.deepEqual(Object.keys(plain(h.U) || {}).sort(), []); // functions do not survive JSON
  assert.deepEqual(Object.keys(h.U).sort(), ['cell', 'displayName', 'initials', 'normalize']);
});
