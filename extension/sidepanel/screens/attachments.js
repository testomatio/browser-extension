// Local-file attachments on a test result; the button's gate lives in test-gates.js.

/* global TestomatAPI, state, recordFor, RunLock, $, toast, setStatusLine, progressToast,
   TestGates, Tooltip, ImgHydrate, TestSummary,
   ConfirmDialog, paintCounter, StatusIcons */

// This panel session's uploads by record id: the server list refreshes only on reopen.
const attUploaded = new Map();

// Uploads live on the JSON:API detail's `attachments`; v2 `artifacts` stays empty for them.
function attServerList() {
  const list = state.testrunDetail?.data?.attributes?.attachments;
  return Array.isArray(list) ? list.filter((a) => !(a && a.artifact === true)) : [];
}

function attRemember(recordId, entry) {
  const key = String(recordId);
  const list = attUploaded.get(key) || [];
  list.push(entry);
  attUploaded.set(key, list);
}

// A session upload's response is `{url}` alone, so the id is read from `/attachments/<uid>.ext`.
function attId(a) {
  const raw = a && (a.id != null ? a.id : a.attachment_id);
  if (raw != null && raw !== '') return String(raw);
  const m = /\/attachments\/([^/?#]+?)(?:\.[a-z0-9]+)?(?:[?#]|$)/i.exec(String((a && a.url) || ''));
  return m ? m[1] : '';
}

// Server rows first (canonical name and url), de-duplicated by url.
function attRows() {
  const rows = [];
  const seen = new Set();
  const push = (a) => {
    const name = (a && a.name) || 'attachment';
    const url = (a && a.url) || '';
    const key = url || `name:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      name,
      url,
      id: attId(a),
      type: (a && a.type) || '',
      display_url: (a && a.display_url) || '',
    });
  };
  for (const a of attServerList()) push(a);
  for (const a of attUploaded.get(String(state.currentRecordId)) || []) push(a);
  return rows;
}

// The bin is a sibling of the tile, never a child: .file-tile is itself a <button>.
function attTileItem(a) {
  const li = TestSummary.fileTileItem(a, TestSummary.IMG_GROUP_ATTS);
  li.className = 'file-tile-item';
  li.append(attDeleteBtn(a));
  return li;
}

// On every tile, disabled with the reason when this file cannot be deleted.
function attDeleteBtn(a) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn icon size-xs attachment-del';
  btn.append(StatusIcons.svgIcon('delete', 14));
  const lock = attDeleteLock(a);
  btn.disabled = !!lock;
  btn.setAttribute('aria-label', `Delete ${a.name}`);
  Tooltip.set(btn, lock || `Delete ${a.name}`);
  if (!lock) btn.addEventListener('click', () => onDeleteAttachment(a));
  return btn;
}

// Asked again after the confirm: the run can finish while the dialog is open.
function attDeleteLock(a) {
  const record = recordFor(state.currentRecordId);
  // Shared sentences (test-gates.js), own order: no result before a lock, the missing id after both.
  const copy = TestGates.gateReason({ need: 'delete' });
  if (!record || !record.id) return copy.noResult;
  const lock = RunLock.recordWriteLock(record);
  if (lock) return lock;
  if (TestomatAPI.jwtAvailable() === false) return copy.degraded;
  if (!a.id) return 'This file carries no id here — remove it in the web app';
  return '';
}

// Dropped from both sources the list merges, or the next repaint brings it straight back.
function attForget(recordId, a) {
  const key = String(recordId);
  const same = (x) => (a.url ? (x && x.url) === a.url : (x && x.name) === a.name);
  const mine = attUploaded.get(key);
  if (mine) attUploaded.set(key, mine.filter((x) => !same(x)));
  const server = state.testrunDetail?.data?.attributes?.attachments;
  if (Array.isArray(server)) {
    state.testrunDetail.data.attributes.attachments = server.filter((x) => !same(x));
  }
}

// Deletes for everyone, hence the confirm; the panel forgets only what the server dropped.
async function onDeleteAttachment(a) {
  const record = recordFor(state.currentRecordId);
  const lock = attDeleteLock(a);
  if (lock) { toast(lock); return; }
  const ok = await ConfirmDialog.ask(`Delete ${a.name}? It is removed from this result for everyone.`, 'Delete');
  if (!ok) return;
  const again = attDeleteLock(a); // the dialog outlived the gate
  if (again) { setStatusLine('test-status', again, 'error'); return; }
  progressToast(`Deleting ${a.name}…`);
  try {
    await TestomatAPI.deleteAttachment(record.id, a.id);
    attForget(record.id, a);
    renderAttachmentList();
    setStatusLine('test-status', 'Attachment deleted ✓', 'ok');
  } catch (e) {
    setStatusLine('test-status', `${a.name}: delete failed — ${e.message}`, 'error');
  }
}

// Same reasons as the Attach file button: the dropzone must never invite a drop the upload refuses.
function attUploadLock() {
  const record = recordFor(state.currentRecordId);
  const copy = TestGates.gateReason({ need: 'file' });
  if (!record?.id) return copy.noResult;
  const lock = RunLock.recordWriteLock(record);
  if (lock) return lock;
  // 'unknown' is still probing and must never gate.
  if (TestomatAPI.jwtAvailable() === false) return copy.degraded;
  return '';
}

// An empty list answers "where does the file go" with a place to drop it.
function attDropzone() {
  const li = document.createElement('li');
  li.className = 'attachment-empty';
  const lock = attUploadLock();

  // A plain <div> when locked: a focusable control that refuses itself is a trap.
  const zone = document.createElement(lock ? 'div' : 'button');
  zone.className = `attachment-dropzone${lock ? ' is-locked' : ''}`;
  if (!lock) zone.type = 'button';

  const mark = document.createElement('span');
  mark.className = 'dropzone-mark';
  mark.append(StatusIcons.svgIcon('upload_file', 20));

  const body = document.createElement('div');
  body.className = 'dropzone-body';
  const title = document.createElement('p');
  title.className = 'dropzone-title';
  title.textContent = lock ? 'No files attached to this result yet.' : 'Drop a file here';
  const hint = document.createElement('p');
  hint.className = 'dropzone-hint';
  hint.textContent = lock || 'or click to browse — screenshots, logs, anything';
  body.append(title, hint);
  zone.append(mark, body);
  li.append(zone);
  if (lock) return li;

  zone.addEventListener('click', onAttachFileClick);

  // dragleave fires on every child crossed, so the highlight is counted, not toggled, or it flickers.
  let depth = 0;
  const paint = (on) => zone.classList.toggle('is-over', on);
  zone.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    depth += 1;
    paint(true);
  });
  zone.addEventListener('dragover', (ev) => {
    ev.preventDefault(); // without this the drop never fires
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) paint(false);
  });
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    depth = 0;
    paint(false);
    const files = Array.from(ev.dataTransfer?.files || []);
    // Dragged text or a link carries no files: say so instead of failing silently.
    if (!files.length) { setStatusLine('test-status', 'That drop carried no file', 'error'); return; }
    // Re-checked at drop time: the drag outlives the render that drew this zone.
    const stopped = attUploadLock();
    if (stopped) { setStatusLine('test-status', stopped, 'error'); return; }
    attUploadFiles(files);
  });
  return li;
}

// An empty list never collapses: a vanished list leaves "did that upload land?" unanswered.
function renderAttachmentList() {
  const ul = $('attachment-list');
  if (!ul) return;
  ImgHydrate.release(TestSummary.IMG_GROUP_ATTS); // the previews about to be dropped own these
  const onTest = state.view === 'test';
  const rows = onTest ? attRows() : [];
  // Off the test screen the list is hidden anyway — no dropzone is built for it.
  ul.replaceChildren(...(rows.length ? rows.map(attTileItem) : onTest ? [attDropzone()] : []));
  ul.hidden = !onTest;
  paintAttachmentCount(rows.length);
}

// Zero shows nothing: the dropzone below already says the result is empty.
function paintAttachmentCount(n) {
  const chip = $('attachments-count');
  if (!chip) return;
  chip.hidden = !n;
  if (n) paintCounter(chip, n);
  else chip.textContent = '';
}

function onAttachFileClick() {
  const btn = $('btn-attach-file');
  if (btn?.disabled) return; // gated (no result record / basic mode) or an upload in flight
  const input = $('attach-file-input');
  if (input) input.click(); // the native picker; multi-select is on the element
}

// Cleared at once: a same-value input fires no `change`, so the same file can be picked twice.
function onAttachFilePicked(ev) {
  const input = ev.target;
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) attUploadFiles(files);
}

// The endpoint de-duplicates by MD5 per record, so a repeat pick is cheap.
async function attUploadFiles(files) {
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return; // the gate should have caught this; never upload blind
  const btn = $('btn-attach-file');
  if (btn) btn.disabled = true;
  let done = 0;
  let stopped = ''; // the lock reason that ended the loop early, if one landed
  try {
    for (let i = 0; i < files.length; i++) {
      // The picker outlives the click-time gate, so the lock is re-asked per file.
      stopped = RunLock.recordWriteLock(recordFor(record.id) || record); // by id: a structural sync apply replaces the row
      if (stopped) break; // at a file boundary — never half-way through an upload
      const f = files[i];
      progressToast(files.length === 1
        ? `Uploading ${f.name}…`
        : `Uploading ${f.name} (${i + 1}/${files.length})…`);
      try {
        const res = await TestomatAPI.uploadAttachment(record.id, f, f.name);
        attRemember(record.id, { name: f.name, url: (res && res.url) || '' });
        done += 1;
        renderAttachmentList(); // each file lands visibly, not only at the end
      } catch (e) {
        toast(`${f.name}: upload failed — ${e.message}`, { error: true });
      }
    }
  } finally {
    TestGates.update(); // restore the gate-driven disabled state
  }
  const noun = files.length === 1 ? 'file' : 'files';
  // A lock that landed mid-pick reports both halves.
  if (stopped && done) setStatusLine('test-status', `${done} of ${files.length} files attached — ${stopped}`, 'error');
  else if (stopped) setStatusLine('test-status', stopped, 'error');
  else if (done === files.length) setStatusLine('test-status', `${done} ${noun} attached ✓`, 'ok');
  else if (done) setStatusLine('test-status', `${done} of ${files.length} files attached`, 'error');
  else setStatusLine('test-status', '', '');
}

function initAttachments() {
  const btn = $('btn-attach-file');
  const input = $('attach-file-input');
  if (btn) btn.addEventListener('click', onAttachFileClick);
  if (input) input.addEventListener('change', onAttachFilePicked);
}
