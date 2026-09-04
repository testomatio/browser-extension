#!/usr/bin/env node
// What extension/sidepanel/screens/attachments.js puts on a test result and takes back off (#156): a
// file picked, dropped or screenshotted stays on screen without reopening the test, the bin on every
// tile either works or says why it cannot, and no gate is asked only once — the delete re-asks after
// the confirm dialog, the upload re-asks between files and at drop time, because the run can finish
// while the tester is still in the picker.
// Run: node --test tests/attachments.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, makeDocument, el, fire, plain, settle, rejection } from './helpers/panel-harness.mjs';

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
    // The tile and its group both come from screens/test-summary.js now (its own suite owns them).
    TestSummary: {
      fileTileItem: (att, group) => {
        calls.tiles.push({ att: plain(att), group });
        return el('li', { className: 'tile' }, el('span', { className: 'tile-name' }, att.name));
      },
      IMG_GROUP_ATTS: 'result-attachments',
    },
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

// ---------- the upload gate (rows 29-31) ----------

test('29: with no saved result there is nothing for a file to attach to', () => {
  const h = load();
  assert.equal(h.fn.attUploadLock(), '');
  h.replaceRecord(null);
  assert.equal(h.fn.attUploadLock(), NO_RESULT_UP);
  h.replaceRecord({ name: 'no id yet' });
  assert.equal(h.fn.attUploadLock(), NO_RESULT_UP);
});

test('30: a finished run is asked before the web session', () => {
  const h = load({ jwt: false });
  h.record().lock = RUN_LOCK;
  assert.equal(h.fn.attUploadLock(), RUN_LOCK);
  h.record().lock = '';
  assert.equal(h.fn.attUploadLock(), NO_JWT_UP);
});

test('31: a proven-gone web session gates uploads; one still being probed does not', () => {
  assert.equal(load({ jwt: false }).fn.attUploadLock(), NO_JWT_UP);
  assert.equal(load({ jwt: 'unknown' }).fn.attUploadLock(), '');
  assert.equal(load({ jwt: true }).fn.attUploadLock(), '');
});

// ---------- the empty state as a drop target (rows 32-37) ----------

test('32: a locked dropzone is a plain div — a focusable control that refuses itself is a trap', () => {
  const h = load({ jwt: false });
  const li = h.fn.attDropzone();
  assert.equal(li.className, 'attachment-empty');
  const zone = li.querySelector('.attachment-dropzone');
  assert.equal(zone.tagName, 'DIV');
  assert.equal(zone.type, undefined);
  assert.equal(zone.classList.contains('is-locked'), true);
  assert.equal(li.querySelector('.dropzone-title').textContent, 'No files attached to this result yet.');
  assert.equal(li.querySelector('.dropzone-hint').textContent, NO_JWT_UP);
  assert.equal(zone.listeners.size, 0); // no click, no drag — nothing to invite
});

test('33: an open dropzone is a button that says what to do with it', () => {
  const h = load();
  const li = h.fn.attDropzone();
  const zone = li.querySelector('.attachment-dropzone');
  assert.equal(zone.tagName, 'BUTTON');
  assert.equal(zone.type, 'button');
  assert.equal(zone.classList.contains('is-locked'), false);
  assert.equal(li.querySelector('.dropzone-title').textContent, 'Drop a file here');
  assert.equal(li.querySelector('.dropzone-hint').textContent, 'or click to browse — screenshots, logs, anything');
  // Clicking it opens the same native picker the Attach button does.
  fire(zone, 'click');
  assert.equal(h.calls.picker, 1);
});

test('34: a dragged link or a selection carries no file, and is told so', async () => {
  const h = load();
  fire(h.zone(), 'drop', { dataTransfer: { files: [] } });
  fire(h.zone(), 'drop', { dataTransfer: { types: ['text/uri-list'] } });
  fire(h.zone(), 'drop', {}); // a drop with no dataTransfer at all
  await settle();
  assert.deepEqual(h.calls.lines.map((l) => l.text), Array(3).fill('That drop carried no file'));
  assert.deepEqual(h.calls.lines.map((l) => l.cls), Array(3).fill('error'));
  assert.deepEqual(h.calls.uploads, []);

  // The same drive with a file in it does upload — otherwise the three rows above prove nothing.
  const good = load();
  fire(good.zone(), 'drop', { dataTransfer: { files: [file('a.png')] } });
  await settle();
  assert.deepEqual(good.calls.uploads.map((u) => u.name), ['a.png']);
});

test('35: a gate that closes mid-drag stops the drop — it is re-asked at drop time', async () => {
  const h = load();
  const zone = h.zone(); // built while the gate was open
  h.record().lock = RUN_LOCK;
  fire(zone, 'drop', { dataTransfer: { files: [file('a.png')] } });
  await settle();
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: RUN_LOCK, cls: 'error' }]);
  assert.deepEqual(h.calls.uploads, []);

  // A session that expired mid-drag is the half only THIS gate catches: the upload loop re-asks
  // recordWriteLock alone, so without the drop-time attUploadLock() the file would go up regardless.
  const gone = load();
  const zone2 = gone.zone();
  gone.jwt(false);
  fire(zone2, 'drop', { dataTransfer: { files: [file('a.png')] } });
  await settle();
  assert.deepEqual(gone.calls.lines, [{ id: 'test-status', text: NO_JWT_UP, cls: 'error' }]);
  assert.deepEqual(gone.calls.uploads, []);
});

test('36: the highlight is counted in and out, so it does not flicker off over the icon', () => {
  const h = load();
  const zone = h.zone();
  const over = () => zone.classList.contains('is-over');
  assert.equal(over(), false);

  fire(zone, 'dragenter');
  fire(zone, 'dragenter'); // crossing into a child
  fire(zone, 'dragleave'); // …and back out of it
  assert.equal(over(), true);
  fire(zone, 'dragleave');
  assert.equal(over(), false);
  // An unmatched leave must not push the count below zero, or the next enter would not light up.
  fire(zone, 'dragleave');
  fire(zone, 'dragenter');
  assert.equal(over(), true);
});

test('37: a drop resets the count and clears the highlight even when it uploads nothing', () => {
  const h = load();
  const zone = h.zone();
  const over = () => zone.classList.contains('is-over');

  fire(zone, 'dragenter');
  fire(zone, 'dragenter');
  fire(zone, 'drop', { dataTransfer: { files: [] } }); // the error path
  assert.equal(over(), false);
  // Proof the count went to 0 rather than staying at 2: one enter now lights it, one leave clears it.
  fire(zone, 'dragenter');
  assert.equal(over(), true);
  fire(zone, 'dragleave');
  assert.equal(over(), false);

  // The three preventDefaults the drag needs — without the dragover one the drop never fires.
  assert.equal(fire(zone, 'dragenter').defaultPrevented, true);
  const dt = { dropEffect: 'none' };
  assert.equal(fire(zone, 'dragover', { dataTransfer: dt }).defaultPrevented, true);
  assert.equal(dt.dropEffect, 'copy');
  assert.equal(fire(zone, 'dragover', {}).defaultPrevented, true); // no dataTransfer: still no throw
  assert.equal(fire(zone, 'drop', { dataTransfer: { files: [] } }).defaultPrevented, true);
});

// ---------- the list and the count chip (rows 38-42) ----------

test('38: off the test screen the list is emptied and hidden, with no dropzone built for it', () => {
  const h = load({ view: 'run', server: [{ name: 'a.png', url: 'U' }] });
  h.list.append(el('li', { className: 'stale' }));
  h.fn.renderAttachmentList();
  assert.equal(h.list.childNodes.length, 0);
  assert.equal(h.list.hidden, true);
  assert.equal(h.list.querySelector('.attachment-dropzone'), null);
  assert.deepEqual(h.calls.counters, []); // paintAttachmentCount(0) shows nothing

  // On the test screen the very same rows are drawn and the list comes back.
  const shown = load({ server: [{ name: 'a.png', url: 'U' }] });
  shown.fn.renderAttachmentList();
  assert.deepEqual(shown.names(), ['a.png']);
  assert.equal(shown.list.hidden, false);
});

test('39: an empty result never collapses — the list becomes the drop target instead', () => {
  const h = load();
  h.fn.renderAttachmentList();
  assert.equal(h.list.childNodes.length, 1);
  assert.equal(h.list.children[0].className, 'attachment-empty');
  assert.equal(h.list.querySelector('.attachment-dropzone').tagName, 'BUTTON');
  assert.equal(h.list.hidden, false);
  assert.equal(h.chip.hidden, true);

  // One real file and the dropzone is gone — the tiles take its place.
  h.fn.attRemember(7, { name: 'a.png', url: 'https://h/attachments/u1.png' });
  h.fn.renderAttachmentList();
  assert.equal(h.list.querySelector('.attachment-dropzone'), null);
  assert.deepEqual(h.list.children.map((li) => li.className), ['file-tile-item']);
  assert.deepEqual(h.calls.tiles.map((t) => t.group), ['result-attachments']);
  // Each tile carries a bin beside it, never inside it — .file-tile is a <button> already.
  assert.equal(h.list.children[0].querySelector('.attachment-del').tagName, 'BUTTON');
});

test('40: the previews are released before the children they belong to are dropped', () => {
  const h = load({ server: [{ name: 'a.png', url: 'U' }] });
  h.list.append(el('li', { className: 'stale' }));
  h.fn.renderAttachmentList();
  assert.equal(h.calls.releases.length, 1);
  assert.equal(h.calls.releases[0].group, 'result-attachments');
  // The old children were still standing when release ran; they are gone once it returned.
  assert.deepEqual(h.calls.releases[0].kept, ['stale']);
  assert.deepEqual(h.list.children.map((li) => li.className), ['file-tile-item']);

  // A panel with no list at all returns before touching the group.
  const bare = load();
  bare.list.remove();
  bare.fn.renderAttachmentList();
  assert.deepEqual(bare.calls.releases, []);
});

test('41: an empty result has no count to report — the chip goes away and empties', () => {
  const h = load();
  h.fn.paintAttachmentCount(3);
  assert.equal(h.chip.hidden, false);
  assert.equal(h.chip.textContent, '3');

  h.fn.paintAttachmentCount(0);
  assert.equal(h.chip.hidden, true);
  assert.equal(h.chip.textContent, '');
  assert.deepEqual(h.calls.counters, [3]); // zero never reaches the counter paint

  // A fold with no chip on it does not throw.
  h.chip.remove();
  h.fn.paintAttachmentCount(2);
});

test('42: a count the fold can show is painted the way every other head counts', () => {
  const h = load();
  h.fn.paintAttachmentCount(3);
  assert.deepEqual(h.calls.counters, [3]);
  assert.equal(h.chip.hidden, false);
  // Rendering three rows paints the same three.
  const rendered = load({ server: [{ name: 'a', url: 'A' }, { name: 'b', url: 'B' }, { name: 'c', url: 'C' }] });
  rendered.fn.renderAttachmentList();
  assert.deepEqual(rendered.calls.counters, [3]);
  assert.equal(rendered.chip.hidden, false);
});

// ---------- picking a file (rows 43-45) ----------

test('43: a disabled Attach button does not open the picker behind it', () => {
  const h = load();
  h.attachBtn.disabled = true;
  h.fn.onAttachFileClick();
  assert.equal(h.calls.picker, 0);

  h.attachBtn.disabled = false;
  h.fn.onAttachFileClick();
  assert.equal(h.calls.picker, 1);

  // Neither node present: no button to read, no input to click, and no throw.
  const bare = load({ controls: false });
  bare.fn.onAttachFileClick();
  assert.equal(bare.calls.picker, 0);
});

test('44: the input is cleared before the upload starts, so the same file can be picked twice', async () => {
  const h = load();
  h.fn.initAttachments(); // driven through the real `change` listener, not by calling the handler
  h.fileInput.files = [file('a.png')];
  fire(h.fileInput, 'change');
  await settle();
  assert.equal(h.fileInput.value, '');
  // A same-value input fires no change, so a clear that came after the upload would lose the repeat.
  assert.deepEqual(h.calls.order.filter((x) => x.startsWith('value:') || x.startsWith('upload:')),
    ['value:', 'upload:a.png']);
  assert.deepEqual(h.calls.uploads.map((u) => u.name), ['a.png']);
});

test('45: a picker closed with nothing chosen uploads nothing', async () => {
  const h = load();
  h.fn.initAttachments();
  h.fileInput.files = [];
  fire(h.fileInput, 'change');
  await settle();
  // The list can be absent from the event too — `input.files || []` is the whole guard.
  h.fileInput.files = null;
  fire(h.fileInput, 'change');
  await settle();

  assert.deepEqual(h.calls.uploads, []);
  assert.deepEqual(h.calls.lines, []);
  // The handler DID run both times — the clear is the proof, so this is not an empty assertion.
  assert.deepEqual(h.calls.order, ['value:', 'value:']);
});

// ---------- the upload loop (rows 46-54) ----------

test('46: one file uploads, is remembered against the result and lands on screen at once', async () => {
  const h = load();
  h.on.upload = async () => ({ url: 'https://h/attachments/u1.png' });
  const f = file('a.png');

  await h.fn.attUploadFiles([f]);
  assert.equal(h.calls.uploads.length, 1);
  assert.equal(h.calls.uploads[0].recordId, 7);
  assert.equal(h.calls.uploads[0].name, 'a.png');
  assert.equal(h.calls.uploads[0].file, f); // the File itself rides the call — it IS the Blob
  assert.deepEqual(h.rows(), [{
    name: 'a.png', url: 'https://h/attachments/u1.png', id: 'u1', type: '', display_url: '',
  }]);
  assert.equal(h.calls.releases.length, 1); // rendered once, for the one file
  assert.deepEqual(h.names(), ['a.png']);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: '1 file attached ✓', cls: 'ok' }]);

  // An answer with no url at all is still remembered — the row is there, simply unaddressable.
  const bare = load();
  bare.on.upload = async () => undefined;
  await bare.fn.attUploadFiles([file('b.png')]);
  assert.deepEqual(bare.rows(), [{ name: 'b.png', url: '', id: '', type: '', display_url: '' }]);
  assert.deepEqual(bare.calls.lines, [{ id: 'test-status', text: '1 file attached ✓', cls: 'ok' }]);
});

test('47: one file failing toasts that file and the rest still go', async () => {
  const h = load();
  h.on.upload = async (recordId, f) => {
    if (f.name === 'a.png') throw new Error('413 too large');
    return { url: 'https://h/attachments/u2.png' };
  };
  await h.fn.attUploadFiles([file('a.png'), file('b.png')]);
  assert.deepEqual(h.calls.uploads.map((u) => u.name), ['a.png', 'b.png']);
  assert.deepEqual(h.calls.toasts, [{ msg: 'a.png: upload failed — 413 too large', error: true }]);
  assert.deepEqual(h.rows().map((r) => r.name), ['b.png']);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: '1 of 2 files attached', cls: 'error' }]);

  // Both landing reads as the plain success sentence — the row above is the difference.
  const both = load();
  await both.fn.attUploadFiles([file('a.png'), file('b.png')]);
  assert.deepEqual(both.calls.lines, [{ id: 'test-status', text: '2 files attached ✓', cls: 'ok' }]);
});

test('48: a run finishing between two files stops at the boundary and reports both halves', async () => {
  const h = load();
  h.on.upload = async () => { h.record().lock = RUN_LOCK; return { url: 'https://h/attachments/u1.png' }; };
  await h.fn.attUploadFiles([file('a.png'), file('b.png')]);
  // The gate is re-asked before EACH file, so the second one is never started.
  assert.deepEqual(h.calls.uploads.map((u) => u.name), ['a.png']);
  assert.deepEqual(h.calls.progress, ['Uploading a.png (1/2)…']);
  assert.deepEqual(h.calls.lines, [{
    id: 'test-status', text: `1 of 2 files attached — ${RUN_LOCK}`, cls: 'error',
  }]);
  assert.deepEqual(h.rows().map((r) => r.name), ['a.png']); // what did land stays on screen
});

test('49: a run already finished when the picker closes never starts a single upload', async () => {
  const h = load();
  h.record().lock = RUN_LOCK;
  await h.fn.attUploadFiles([file('a.png')]);
  assert.deepEqual(h.calls.uploads, []);
  assert.deepEqual(h.calls.progress, []);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: RUN_LOCK, cls: 'error' }]);
  assert.equal(h.calls.actionsState, 1); // the button still comes back
});

test('50: the only file failing leaves the line blank — the toast is the whole report', async () => {
  const h = load();
  h.on.upload = fail('network down');
  await h.fn.attUploadFiles([file('a.png')]);
  assert.deepEqual(h.calls.toasts, [{ msg: 'a.png: upload failed — network down', error: true }]);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: '', cls: '' }]);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(h.calls.releases, []); // nothing landed, so nothing was repainted
});

test('51: several files count themselves off; a single one has nothing to count', async () => {
  const h = load();
  await h.fn.attUploadFiles([file('a.png'), file('b.png'), file('c.png')]);
  assert.deepEqual(h.calls.progress, [
    'Uploading a.png (1/3)…', 'Uploading b.png (2/3)…', 'Uploading c.png (3/3)…',
  ]);
  assert.deepEqual(h.calls.lines, [{ id: 'test-status', text: '3 files attached ✓', cls: 'ok' }]);

  const one = load();
  await one.fn.attUploadFiles([file('a.png')]);
  assert.deepEqual(one.calls.progress, ['Uploading a.png…']);
});

test('52: with no saved result the loop never uploads blind', async () => {
  const h = load();
  h.replaceRecord(null);
  await h.fn.attUploadFiles([file('a.png')]);
  assert.deepEqual(h.calls.uploads, []);
  assert.deepEqual(h.calls.progress, []);
  assert.deepEqual(h.calls.lines, []);
  assert.equal(h.calls.actionsState, 0); // it returns ahead of the try, so nothing is restored
  assert.equal(h.attachBtn.disabled, false); // …and nothing was disabled to restore

  const noId = load();
  noId.replaceRecord({ name: 'a row with no result id yet' });
  await noId.fn.attUploadFiles([file('a.png')]);
  assert.deepEqual(noId.calls.uploads, []);
});

test('53: the Attach button is held down for the whole batch and always handed back', async () => {
  const h = load();
  await h.fn.attUploadFiles([file('a.png'), file('b.png')]);
  assert.deepEqual(h.calls.uploads.map((u) => u.btnDisabled), [true, true]);
  assert.equal(h.attachBtn.disabled, false);
  assert.equal(h.calls.actionsState, 1);

  // The same on the failing path: the button must not stay dead because an upload was refused.
  const bad = load();
  bad.on.upload = fail('nope');
  await bad.fn.attUploadFiles([file('a.png')]);
  assert.equal(bad.calls.uploads[0].btnDisabled, true);
  assert.equal(bad.attachBtn.disabled, false);
  assert.equal(bad.calls.actionsState, 1);

  // And with no button in the DOM at all the batch still runs to the end.
  const bare = load({ controls: false });
  await bare.fn.attUploadFiles([file('a.png')]);
  assert.equal(bare.calls.uploads.length, 1);
  assert.equal(bare.calls.actionsState, 1);

  // The `finally` is not decoration. A throw from OUTSIDE the per-file catch — here the toast layer
  // itself — still hands the button back, and is not swallowed into a success sentence on the way.
  const thrown = load();
  thrown.on.progress = () => { throw new Error('toast layer gone'); };
  const e = await rejection(thrown.fn.attUploadFiles([file('a.png')]));
  assert.equal(e.message, 'toast layer gone');
  assert.equal(thrown.attachBtn.disabled, false);
  assert.equal(thrown.calls.actionsState, 1);
  assert.deepEqual(thrown.calls.lines, []);
  assert.deepEqual(thrown.calls.uploads, []);
});

test('54: a structural sync replacing the record mid-loop is still the row the gate is read from', async () => {
  const h = load();
  const original = h.record();
  h.on.upload = async () => {
    // What a poll's apply does: the row is REPLACED, not mutated — the loop's own reference goes stale.
    h.replaceRecord({ id: 7, lock: RUN_LOCK });
    return { url: 'https://h/attachments/u1.png' };
  };
  await h.fn.attUploadFiles([file('a.png'), file('b.png')]);
  assert.equal(original.lock, undefined); // the object the loop opened with never learned of the lock
  assert.deepEqual(h.calls.uploads.map((u) => u.name), ['a.png']);
  assert.deepEqual(h.calls.lines, [{
    id: 'test-status', text: `1 of 2 files attached — ${RUN_LOCK}`, cls: 'error',
  }]);
});

// ---------- the wiring (row 55) ----------

test('55: the two listeners are registered, and a panel missing either node does not throw', async () => {
  const h = load();
  h.fn.initAttachments();
  assert.equal(h.attachBtn.listeners.get('click').length, 1);
  assert.equal(h.fileInput.listeners.get('change').length, 1);

  // Driven, not counted: the click opens the picker and the change starts the upload.
  fire(h.attachBtn, 'click');
  assert.equal(h.calls.picker, 1);
  h.fileInput.files = [file('a.png')];
  fire(h.fileInput, 'change');
  await settle();
  assert.deepEqual(h.calls.uploads.map((u) => u.name), ['a.png']);

  const bare = load({ controls: false });
  bare.fn.initAttachments(); // neither node in the DOM
  assert.equal(bare.attachBtn.listeners.size, 0);
  assert.equal(bare.fileInput.listeners.size, 0);
});
