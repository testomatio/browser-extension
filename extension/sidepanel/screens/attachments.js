// Local-file attachments on a test result (#107). A picked File IS a Blob, so it
// rides TestomatAPI.uploadAttachment; the button's gate lives in test-gates.js.

/* global TestomatAPI, state, recordFor, RunLock, $, toast, setStatusLine, progressToast,
   TestGates, Tooltip, ImgHydrate, TestSummary,
   ConfirmDialog, paintCounter, StatusIcons */

// Uploads this PANEL SESSION made, keyed by record id: the server list refreshes
// only on reopen, so a just-picked file would otherwise vanish from it.
const attUploaded = new Map();

// ---- the list -----------------------------------------------------------

// Uploads surface on the JSON:API detail's `attachments`; the v2 `artifacts` field
// stays empty for them. probeSession prefetched it, so this costs no request.
// #21: runner artifacts share that array — they render in the summary's own section.
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

// What a DELETE has to address. The server row carries an id; a session upload's response is
// `{url}` alone, so the instance-hosted form of that url (`<instance>/attachments/<uid>.ext`)
// is read for one. No id ⇒ the row is not addressable and its bin says so rather than lying.
function attId(a) {
  const raw = a && (a.id != null ? a.id : a.attachment_id);
  if (raw != null && raw !== '') return String(raw);
  const m = /\/attachments\/([^/?#]+?)(?:\.[a-z0-9]+)?(?:[?#]|$)/i.exec(String((a && a.url) || ''));
  return m ? m[1] : '';
}

// Server rows first (canonical name/url), de-duplicated by url. A session upload's
// response is `{url}` alone, so its name's extension decides the type (#205).
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

// #21 draws every file the panel lists as the same tile, so an attachment is that tile plus
// the one thing a MANUAL upload has that a runner artifact does not: it can be taken off the
// result. The bin is a SIBLING of the tile, never a child — .file-tile is itself a <button>.
function attTileItem(a) {
  const li = TestSummary.fileTileItem(a, TestSummary.IMG_GROUP_ATTS);
  li.className = 'file-tile-item';
  li.append(attDeleteBtn(a));
  return li;
}

// ---- removing one ---------------------------------------------------------

// The bin in a tile's corner. Present on every tile, so the tester never hunts for it, and
// disabled with the reason in its place when this particular file cannot be deleted — a lock,
// or a row the server gave no id to (a delete has nothing to name then).
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

// One place both the button and the click re-ask: the second time is what counts, because the
// confirm dialog is interactive and the run can finish under it (#187, the upload's rule).
function attDeleteLock(a) {
  const record = recordFor(state.currentRecordId);
  // The sentences are shared (screens/test-gates.js); the ORDER is this path's own — a result that
  // does not exist yet is answered before a lock, and the missing id after both.
  const copy = TestGates.gateReason({ need: 'delete' });
  if (!record || !record.id) return copy.noResult;
  const lock = RunLock.recordWriteLock(record);
  if (lock) return lock;
  if (TestomatAPI.jwtAvailable() === false) return copy.degraded;
  if (!a.id) return 'This file carries no id here — remove it in the web app';
  return '';
}

// Dropped from BOTH sources the list merges, or the next repaint brings it straight back.
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

// Server-side and for everyone — hence the confirm. The row stays put on a refusal: the panel
// only forgets what the server said it dropped.
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

// ---- the empty state: a drop target ---------------------------------------

// '' = a file can be attached right now, else why not. The SAME three reasons the
// Attach file button is gated on (screens/test-gates.js owns that copy) — the dropzone
// must never invite a drop the upload would then refuse.
function attUploadLock() {
  const record = recordFor(state.currentRecordId);
  const copy = TestGates.gateReason({ need: 'file' });
  if (!record?.id) return copy.noResult;
  const lock = RunLock.recordWriteLock(record);
  if (lock) return lock;
  // 'unknown' is still probing and must never gate (#107).
  if (TestomatAPI.jwtAvailable() === false) return copy.degraded;
  return '';
}

// An empty list is the ONE place the tester is already looking for "where does the file
// go", so it answers with somewhere to put it rather than a sentence. Click opens the
// same native picker the button does; a drop rides the same upload path.
function attDropzone() {
  const li = document.createElement('li');
  li.className = 'attachment-empty';
  const lock = attUploadLock();

  // A <button> when it acts (keyboard + focus ring for free), a plain <div> when the
  // gate holds — a focusable control that refuses itself is a trap.
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

  // dragleave fires on every CHILD the pointer crosses, so the highlight is counted in
  // and out rather than toggled — otherwise it flickers off over the icon and the text.
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
    // Dragged TEXT or a link carries no files: say so instead of failing silently.
    if (!files.length) { setStatusLine('test-status', 'That drop carried no file', 'error'); return; }
    // Re-checked at drop time: the drag outlives the render that drew this zone (#187).
    const stopped = attUploadLock();
    if (stopped) { setStatusLine('test-status', stopped, 'error'); return; }
    attUploadFiles(files);
  });
  return li;
}

// An empty list never collapses — a list that disappears leaves "did that upload
// land?" unanswered — and while it is empty it doubles as the drop target.
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

// Beside the fold's name, the way every other head counts what it holds. Zero shows NOTHING —
// an empty result has no count to report, and the dropzone below already says so.
function paintAttachmentCount(n) {
  const chip = $('attachments-count');
  if (!chip) return;
  chip.hidden = !n;
  if (n) paintCounter(chip, n);
  else chip.textContent = '';
}

// ---- picking + uploading -------------------------------------------------

function onAttachFileClick() {
  const btn = $('btn-attach-file');
  if (btn?.disabled) return; // gated (no result record / basic mode) or an upload in flight
  const input = $('attach-file-input');
  if (input) input.click(); // the native picker; multi-select is on the element
}

// The input is cleared IMMEDIATELY: a same-value input fires no `change`, so this
// is what lets the same file be picked twice, and voids a duplicate event.
function onAttachFilePicked(ev) {
  const input = ev.target;
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) attUploadFiles(files);
}

// One file at a time: a failure toasts THAT file and the loop carries on. The
// endpoint de-duplicates by MD5 per record, so a repeat pick is cheap.
async function attUploadFiles(files) {
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return; // the gate should have caught this; never upload blind
  const btn = $('btn-attach-file');
  if (btn) btn.disabled = true;
  let done = 0;
  let stopped = ''; // the lock reason that ended the loop early, if one landed
  try {
    for (let i = 0; i < files.length; i++) {
      // #187: the picker outlives the click-time gate, and a slow pick the lock itself.
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
  // A lock that landed mid-pick reports BOTH halves.
  if (stopped && done) setStatusLine('test-status', `${done} of ${files.length} files attached — ${stopped}`, 'error');
  else if (stopped) setStatusLine('test-status', stopped, 'error');
  else if (done === files.length) setStatusLine('test-status', `${done} ${noun} attached ✓`, 'ok');
  else if (done) setStatusLine('test-status', `${done} of ${files.length} files attached`, 'error');
  else setStatusLine('test-status', '', '');
}

// ---- wiring --------------------------------------------------------------

function initAttachments() {
  const btn = $('btn-attach-file');
  const input = $('attach-file-input');
  if (btn) btn.addEventListener('click', onAttachFileClick);
  if (input) input.addEventListener('change', onAttachFilePicked);
}
