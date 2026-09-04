#!/usr/bin/env node
// What extension/sidepanel/screens/attachments.js puts on a test result and takes back off (#156): a
// file picked, dropped or screenshotted stays on screen without reopening the test, the bin on every
// tile either works or says why it cannot, and no gate is asked only once — the delete re-asks after
// the confirm dialog, the upload re-asks between files and at drop time, because the run can finish
// while the tester is still in the picker.
// Run: node --test tests/attachments.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, fire, plain, settle } from './helpers/panel-harness.mjs';

const HOST = 'app.testomat.io';
// The four gate sentences, spelled here exactly as the screen spells them: this file and
// test-view.js keep separate copies, and pinning them is what stops the wording drifting again.
const NO_RESULT_DEL = 'No saved result yet';
const NO_RESULT_UP = 'No saved result yet — files attach to a test result';
const NO_JWT_DEL = `Deleting needs an active ${HOST} web login — sign in there, then Refresh`;
const NO_JWT_UP = `Attaching files needs an active ${HOST} web login — sign in there, then Refresh`;
const NO_ID = 'This file carries no id here — remove it in the web app';
const RUN_LOCK = 'This run has finished — reopen it to write';

const file = (name, body = 'x') => new File([body], name, { type: 'text/plain' });
const fail = (message) => async () => { throw new Error(message); };

// The panel globals attachments.js reads, all of them real enough to be driven. They live here and
// not in the harness: every screen has its own set, and the screens beside this one land in parallel.
function load(opts = {}) {
  const o = {
    view: 'test',
    recordId: 7,
    records: [{ id: 7 }],  // `lock` on a row is what recordWriteLock answers for it
    server: null,          // state.testrunDetail's attachments; null = no detail fetched at all
    jwt: true,             // what TestomatAPI.jwtAvailable() answers
    controls: true,        // the Attach button and its <input> present in the DOM
    ...opts,
  };

  // index.html's shape, cut to the four nodes this screen touches: the file grid, the count chip
  // beside the fold's name, the Attach button and the hidden <input type=file> behind it.
  const doc = makeDocument([]);
  const list = el('ul', { id: 'attachment-list', className: 'attachment-list file-grid', hidden: true });
  const chip = el('span', { id: 'attachments-count', className: 'counter', hidden: true });
  const attachBtn = el('button', { id: 'btn-attach-file', disabled: false });
  const fileInput = el('input', { id: 'attach-file-input', type: 'file' });
  doc.body.append(list, chip);
  if (o.controls) doc.body.append(attachBtn, fileInput);

  const calls = {
    toasts: [],      // { msg, error? }
    progress: [],    // the progress-toast sentences, in order
    lines: [],       // { id, text, cls }
    confirms: [],    // { message, label }
    uploads: [],     // { recordId, name, file, btnDisabled } — the button's state AS the call ran
    deletes: [],     // { recordId, attId }
    releases: [],    // { group, kept } — the list's children AS ImgHydrate.release ran
    tiles: [],       // { att, group } handed to fileTileItem
    counters: [],    // the numbers paintCounter painted
    actionsState: 0,
    picker: 0,       // input.click() — the native file dialog
    // Only the acts whose ORDER a row asserts; every other stub records into its own list above.
    order: [],
  };
  const tips = new Map();

  // Keyed by the fixture's record id, not by the row's own: replaceRecord() puts a DIFFERENT object
  // at the same key, which is what a structural sync does under an upload loop.
  const key = String(o.recordId);
  const records = new Map(o.records.map((r) => [String(r.id), r]));
  const record = () => records.get(key) || null;

  // Reassignable after load(), so a test can flip the gate from inside a stub — the confirm dialog
  // and the upload are exactly where the run finishes under the tester.
  const on = {
    confirm: async () => true,
    upload: async (recordId, f) => ({ url: `https://h/attachments/${f.name}` }),
    del: async () => ({}),
    progress: () => {},  // a toast layer that can itself fail — the only way to reach the `finally`
  };

  const state = {
    view: o.view,
    currentRecordId: o.recordId,
    testrunDetail: o.server === null ? null : { data: { attributes: { attachments: o.server } } },
  };

  // The native dialog and the value write are both observable acts here — mini-dom has neither.
  let inputValue = '';
  fileInput.files = [];
  fileInput.click = () => { calls.picker += 1; };
  Object.defineProperty(fileInput, 'value', {
    configurable: true,
    get: () => inputValue,
    set: (v) => { inputValue = String(v); calls.order.push(`value:${inputValue}`); },
  });

  const globals = {
    // The vm realm has neither, and the module never constructs one — but the files a pick or a
    // drop carries are real ones, so the realm has to know the names.
    File,
    Blob,
    state,
    recordFor: (id) => records.get(String(id)) || null,
    recordWriteLock: (rec) => (rec && rec.lock) || '',
    $: (id) => doc.getElementById(id),
    toast: (msg, tOpts) => { calls.toasts.push({ msg, ...(tOpts || {}) }); },
    setStatusLine: (id, text, cls) => {
      calls.order.push(`line:${text}`);
      calls.lines.push({ id, text, cls });
    },
    progressToast: (msg) => { calls.progress.push(msg); on.progress(msg); },
    // The real one re-drives the gate, which is what puts the Attach button back — a stub that only
    // counted could not tell a restored button from one left disabled for good.
    updateTestActionsState: () => { calls.actionsState += 1; attachBtn.disabled = false; },
    Tooltip: { set: (node, tip) => { tips.set(node, tip); } },
    ImgHydrate: {
      release: (group) => {
        calls.order.push('release');
        calls.releases.push({ group, kept: list.children.map((n) => n.className) });
      },
    },
    // attTileItem overwrites li.className immediately, so the stub needs nothing clever — but it
    // records what it was handed, because the image group is the argument that matters.
    fileTileItem: (att, group) => {
      calls.tiles.push({ att: plain(att), group });
      return el('li', { className: 'tile' }, el('span', { className: 'tile-name' }, att.name));
    },
    IMG_GROUP_ATTS: 'result-attachments',
    svgIcon: (name, size) => el('span', { className: 'md-icon', dataset: { icon: name, size: String(size) } }),
    confirmDialog: async (message, label) => {
      calls.order.push('confirm');
      calls.confirms.push({ message, label });
      return on.confirm(message, label);
    },
    baseUrlHost: () => HOST,
    paintCounter: (node, n) => { calls.counters.push(n); node.textContent = String(n); },
    TestomatAPI: {
      jwtAvailable: () => o.jwt,
      uploadAttachment: async (recordId, f, name) => {
        calls.order.push(`upload:${name}`);
        calls.uploads.push({ recordId, name, file: f, btnDisabled: attachBtn.disabled });
        return on.upload(recordId, f, name);
      },
      deleteAttachment: async (recordId, attId) => {
        calls.order.push(`delete:${attId}`);
        calls.deletes.push({ recordId, attId });
        return on.del(recordId, attId);
      },
    },
  };

  const h = loadScreen('attachments', { globals, document: doc });

  return {
    ...h,
    state,
    calls,
    on,
    list,
    chip,
    attachBtn,
    fileInput,
    record,
    replaceRecord: (rec) => { records.set(key, rec); },
    jwt: (v) => { o.jwt = v; },
    tipOf: (node) => tips.get(node),
    rows: () => plain(h.fn.attRows()),
    serverRows: () => plain(state.testrunDetail?.data?.attributes?.attachments),
    // The zone inside the <li> attDropzone() builds — every drag row drives this node.
    zone: () => h.fn.attDropzone().querySelector('.attachment-dropzone'),
    names: () => list.children.map((li) => li.textContent.trim()),
  };
}

// ---------- the id a delete has to work with (rows 1-8) ----------

test('1: a numeric server id becomes the string a delete can send', () => {
  assert.equal(load().fn.attId({ id: 42 }), '42');
});

test('2: a row that names its id attachment_id is read just the same', () => {
  const h = load();
  assert.equal(h.fn.attId({ attachment_id: 'x' }), 'x');
  // The `id` key wins when both are there — the fallback is a fallback.
  assert.equal(h.fn.attId({ id: 'first', attachment_id: 'second' }), 'first');
});

test('3: an empty id is no id — the url is asked instead', () => {
  const h = load();
  assert.equal(h.fn.attId({ id: '', url: 'https://h/attachments/fromurl.png' }), 'fromurl');
  assert.equal(h.fn.attId({ id: '' }), '');
  // …and a real id short-circuits the url, so the two cannot be confused.
  assert.equal(h.fn.attId({ id: 9, url: 'https://h/attachments/fromurl.png' }), '9');
});

test('4: a session upload answers only with a url, so the uid inside it is the id', () => {
  assert.equal(load().fn.attId({ url: 'https://h/attachments/abc123.png' }), 'abc123');
});

test('5: the extension on that url is optional', () => {
  assert.equal(load().fn.attId({ url: 'https://h/attachments/abc123' }), 'abc123');
});

test('6: a dotted name keeps only its first segment — pinned as it is, not as it should be', () => {
  // The lazy group stops at the first extension-looking tail, so `a.tar.gz` addresses as `a.tar`.
  assert.equal(load().fn.attId({ url: 'https://h/attachments/a.tar.gz?x=1' }), 'a.tar');
  assert.equal(load().fn.attId({ url: 'https://h/attachments/plain.png?v=2#frag' }), 'plain');
});

test('7: a url that is not an attachments route names nothing', () => {
  const h = load();
  assert.equal(h.fn.attId({ url: 'https://h/files/abc.png' }), '');
  assert.equal(h.fn.attId({ url: 'https://h/attachmentsfoo/abc.png' }), '');
});

test('8: no row at all, and a row with nothing on it, are both unaddressable', () => {
  const h = load();
  assert.equal(h.fn.attId(null), '');
  assert.equal(h.fn.attId(undefined), '');
  assert.equal(h.fn.attId({}), '');
});

// ---------- the server fold and the row merge (rows 9-15) ----------

test('9: a runner artifact is not an attachment — it belongs to the summary card', () => {
  const h = load({ server: [{ name: 'a' }, { name: 'b', artifact: true }, { name: 'c', artifact: false }] });
  assert.deepEqual(plain(h.fn.attServerList()).map((a) => a.name), ['a', 'c']);
});

test('10: with no detail fetched the server list is empty rather than absent', () => {
  assert.deepEqual(plain(load().fn.attServerList()), []);
  assert.deepEqual(plain(load({ server: [] }).fn.attServerList()), []);
  // A detail whose attachments field is not an array is the same nothing, not a crash.
  const odd = load({ server: [] });
  odd.state.testrunDetail.data.attributes.attachments = 'nope';
  assert.deepEqual(plain(odd.fn.attServerList()), []);
});

test('11: a file uploaded this session and its server row are one row — the server one', () => {
  const h = load({ server: [{ name: 'shot.png', url: 'https://h/attachments/z9.png', id: 55 }] });
  h.fn.attRemember(7, { name: 'local-copy.png', url: 'https://h/attachments/z9.png' });
  const rows = h.rows();
  assert.equal(rows.length, 1);
  // Name AND id: the server row is canonical, and the session copy carries neither.
  assert.equal(rows[0].name, 'shot.png');
  assert.equal(rows[0].id, '55');
});

test('12: two url-less rows sharing a name collide into one', () => {
  const h = load({ server: [{ name: 'log.txt' }, { name: 'log.txt' }, { name: 'other.txt' }] });
  assert.deepEqual(h.rows().map((r) => r.name), ['log.txt', 'other.txt']);
  // The key is the url when there is one, so a named row and a url row never merge.
  const mixed = load({ server: [{ name: 'log.txt' }, { name: 'log.txt', url: 'https://h/attachments/q.txt' }] });
  assert.equal(mixed.rows().length, 2);
});

test('13: every row carries the same five fields, and an unnamed file is called attachment', () => {
  const h = load({ server: [{}] });
  assert.deepEqual(h.rows()[0], { name: 'attachment', url: '', id: '', type: '', display_url: '' });

  const full = load({
    server: [{ name: 'a.png', url: 'https://h/attachments/u1.png', id: 3, type: 'image/png', display_url: 'https://h/d/u1.png' }],
  });
  assert.deepEqual(full.rows()[0], {
    name: 'a.png', url: 'https://h/attachments/u1.png', id: '3', type: 'image/png', display_url: 'https://h/d/u1.png',
  });
});

test('14: a file just uploaded is listed without the server list being re-read', () => {
  const h = load();
  assert.deepEqual(h.rows(), []);
  h.fn.attRemember(7, { name: 'a.png', url: 'https://h/attachments/u1.png' });
  assert.deepEqual(h.rows(), [{
    name: 'a.png', url: 'https://h/attachments/u1.png', id: 'u1', type: '', display_url: '',
  }]);
});

test('15: that memory is per result — opening another test does not inherit it', () => {
  const h = load();
  h.fn.attRemember(7, { name: 'a.png', url: 'https://h/attachments/u1.png' });
  assert.equal(h.rows().length, 1);
  h.state.currentRecordId = 8;
  assert.deepEqual(h.rows(), []);
  // …and coming back to 7 still finds it: nothing was consumed on the way out.
  h.state.currentRecordId = 7;
  assert.equal(h.rows().length, 1);
});

// ---------- the delete gate (rows 16-21) ----------

const ROW = { name: 'a.png', id: 'u1', url: 'https://h/attachments/u1.png' };

test('16: with no saved result there is nothing to delete from', () => {
  const h = load();
  assert.equal(h.fn.attDeleteLock(ROW), '');
  h.replaceRecord(null);
  assert.equal(h.fn.attDeleteLock(ROW), NO_RESULT_DEL);
  h.replaceRecord({ name: 'a row with no result id yet' });
  assert.equal(h.fn.attDeleteLock(ROW), NO_RESULT_DEL);
});

test('17: a finished run outranks every other reason', () => {
  const h = load({ jwt: false });
  h.record().lock = RUN_LOCK;
  // Both the login and the missing id would otherwise answer; the lock is asked first.
  assert.equal(h.fn.attDeleteLock({ name: 'a.png', id: '' }), RUN_LOCK);
  h.record().lock = '';
  assert.equal(h.fn.attDeleteLock(ROW), NO_JWT_DEL);
});

test('18: a web session the panel knows is gone names the host to sign in to', () => {
  const h = load({ jwt: false });
  assert.equal(h.fn.attDeleteLock(ROW), NO_JWT_DEL);
  // Ahead of the row's own missing id: signing in again is the thing the tester can act on.
  assert.equal(h.fn.attDeleteLock({ name: 'a.png', id: '' }), NO_JWT_DEL);
});

test('19: a session still being probed never gates', () => {
  assert.equal(load({ jwt: 'unknown' }).fn.attDeleteLock(ROW), '');
  assert.equal(load({ jwt: true }).fn.attDeleteLock(ROW), '');
  assert.equal(load({ jwt: null }).fn.attDeleteLock(ROW), '');
});

test('20: a row the server gave no id to says so instead of failing on click', () => {
  const h = load();
  assert.equal(h.fn.attDeleteLock({ name: 'a.png', id: '' }), NO_ID);
  assert.equal(h.fn.attDeleteLock({ name: 'a.png' }), NO_ID);
});

test('21: a bin that cannot act is disabled, wears the reason and takes no click', async () => {
  const locked = load({ jwt: false });
  const off = locked.fn.attDeleteBtn(ROW);
  assert.equal(off.disabled, true);
  assert.equal(locked.tipOf(off), NO_JWT_DEL);
  assert.equal(off.getAttribute('aria-label'), 'Delete a.png');
  assert.equal(off.listeners.size, 0);
  fire(off, 'click');
  await settle();
  assert.deepEqual(locked.calls.confirms, []);

  // The same bin with the gate open: enabled, the tooltip says what it does, and it acts.
  const open = load();
  const live = open.fn.attDeleteBtn(ROW);
  assert.equal(live.disabled, false);
  assert.equal(open.tipOf(live), 'Delete a.png');
  assert.equal(live.listeners.get('click').length, 1);
  fire(live, 'click');
  await settle();
  assert.equal(open.calls.confirms.length, 1);
});

// ---------- the delete flow (rows 22-28) ----------

test('22: a gate that still holds at click time is a toast, not a dialog', async () => {
  const h = load({ jwt: false });
  await h.fn.onDeleteAttachment(ROW);
  assert.deepEqual(h.calls.toasts, [{ msg: NO_JWT_DEL }]);
  assert.deepEqual(h.calls.confirms, []);
  assert.deepEqual(h.calls.deletes, []);
});

test('23: a dismissed confirm removes nothing', async () => {
  const h = load({ server: [{ name: 'a.png', url: 'https://h/attachments/u1.png', id: 'u1' }] });
  h.on.confirm = async () => false;
  await h.fn.onDeleteAttachment(h.rows()[0]);
  assert.deepEqual(plain(h.calls.confirms), [{
    message: 'Delete a.png? It is removed from this result for everyone.', label: 'Delete',
  }]);
  assert.deepEqual(h.calls.deletes, []);
  assert.deepEqual(h.calls.lines, []);
  assert.equal(h.rows().length, 1);
});

test('24: a run that finishes under the open dialog stops the delete on the far side of it', async () => {
  const h = load({ server: [{ name: 'a.png', url: 'https://h/attachments/u1.png', id: 'u1' }] });
  const a = h.rows()[0];
  assert.equal(h.fn.attDeleteLock(a), ''); // open when the dialog goes up
  h.on.confirm = async () => { h.record().lock = RUN_LOCK; return true; };

  await h.fn.onDeleteAttachment(a);
  assert.deepEqual(h.calls.deletes, []);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: RUN_LOCK, cls: 'error' }]);
  assert.deepEqual(h.calls.progress, []); // the "Deleting…" plaque never went up
  assert.equal(h.rows().length, 1);
});

test('25: a confirmed delete names the id attRows derived, forgets the row and repaints', async () => {
  // No `id` field on the server row at all: the only name the delete has is the one dug out of
  // the url, so a test that hand-built its row would never exercise it.
  const h = load({ server: [{ name: 'a.png', url: 'https://h/attachments/u1.png' }] });
  const a = h.rows()[0];
  assert.equal(a.id, 'u1');

  await h.fn.onDeleteAttachment(a);
  assert.deepEqual(h.calls.progress, ['Deleting a.png…']);
  assert.deepEqual(plain(h.calls.deletes), [{ recordId: 7, attId: 'u1' }]);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: 'Attachment deleted ✓', cls: 'ok' }]);
  assert.deepEqual(h.rows(), []);
  // The order the tester sees: ask, delete, repaint, then say so.
  assert.deepEqual(h.calls.order, ['confirm', 'delete:u1', 'release', 'line:Attachment deleted ✓']);
});

test('26: a refused delete keeps the row — the panel only forgets what the server dropped', async () => {
  const h = load({ server: [{ name: 'a.png', url: 'https://h/attachments/u1.png' }] });
  h.on.del = fail('403 forbidden');
  await h.fn.onDeleteAttachment(h.rows()[0]);
  assert.deepEqual(h.calls.lines, [{
    id: 'test-status', text: 'a.png: delete failed — 403 forbidden', cls: 'error',
  }]);
  assert.equal(h.rows().length, 1);
  assert.equal(h.serverRows().length, 1);
});

test('27: forgetting a row drops it from the session memory AND from the server list', () => {
  const h = load({ server: [{ name: 'a.png', url: 'U' }, { name: 'b.png', url: 'V' }] });
  h.fn.attRemember(7, { name: 'a.png', url: 'U' });
  assert.equal(h.rows().length, 2);

  h.fn.attForget(7, { url: 'U' });
  assert.deepEqual(h.rows().map((r) => r.name), ['b.png']);
  assert.deepEqual(h.serverRows().map((a) => a.name), ['b.png']);
  // Dropping it from one source only would let the next repaint bring it straight back.
  assert.deepEqual(h.rows().map((r) => r.name), ['b.png']);
});

test('28: a row with no url is forgotten by name', () => {
  const h = load({ server: [{ name: 'a.png' }, { name: 'b.png' }] });
  h.fn.attRemember(7, { name: 'a.png' });
  h.fn.attForget(7, { name: 'a.png' });
  assert.deepEqual(h.rows().map((r) => r.name), ['b.png']);
  assert.deepEqual(h.serverRows().map((a) => a.name), ['b.png']);
  // A url on the row switches the match back to the url, so a same-named neighbour survives.
  const byUrl = load({ server: [{ name: 'a.png', url: 'U' }, { name: 'a.png', url: 'V' }] });
  byUrl.fn.attForget(7, { name: 'a.png', url: 'V' });
  assert.deepEqual(byUrl.serverRows().map((a) => a.url), ['U']);
});
