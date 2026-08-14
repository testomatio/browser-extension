// Local-file attachments on a test result (#107): the "Attach file" button next
// to the screenshot flow, the native picker behind it, and the list of everything
// already uploaded onto the open result.
//
// There is no second upload contract here on purpose — a picked File IS a Blob,
// so it goes straight into TestomatAPI.uploadAttachment, the same JWT multipart
// POST /testruns/{id}/attachment the screenshot (hotkeys.js) and the evidence .txt
// (evidence.js) ride.
//
// The button's gate lives in test-view.js `updateTestActionsState()` (one place
// decides what the test view can do); this file owns the picking, the upload loop
// and the list.

/* global TestomatAPI, state, recordFor, recordWriteLock, $, toast, setStatusLine,
   updateTestActionsState, Tooltip, EmptyState, ImgHydrate, isImageAttachment,
   attachmentThumb, IMG_GROUP_ATTS */

// Uploads this PANEL SESSION made, keyed by record id. The server list only
// refreshes when the test view is reopened (probeSession prefetches the JSON:API
// detail once), so without this the file the tester just picked would vanish from
// the list until they navigated away and back.
const attUploaded = new Map();

// ---- the list -----------------------------------------------------------

// Server truth for the open result. Uploads surface on the JSON:API testrun
// detail's `attachments` (the v2 `artifacts` field stays empty for them — an
// asymmetry the e2e suite asserts), and probeSession already fetched
// it into state.testrunDetail, so the list costs no extra request.
function attServerList() {
  const list = state.testrunDetail?.data?.attributes?.attachments;
  return Array.isArray(list) ? list : [];
}

function attRemember(recordId, entry) {
  const key = String(recordId);
  const list = attUploaded.get(key) || [];
  list.push(entry);
  attUploaded.set(key, list);
}

// Server rows first (they carry the canonical name/url), then anything this
// session uploaded that the prefetched detail predates. De-duplicated by url so a
// reopen — where the server now knows about the session upload — shows one row.
// `type`/`display_url` ride along for #205: the first says whether the row is an
// IMAGE, the second is the presigned link its thumbnail is fetched from. A
// session upload knows neither — its response is `{url}` alone — so the name's
// extension decides, exactly as it does for a step artifact without a type.
function attRows() {
  const rows = [];
  const seen = new Set();
  const push = (a) => {
    const name = (a && a.name) || 'attachment';
    const url = (a && a.url) || '';
    const key = url || `name:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ name, url, type: (a && a.type) || '', display_url: (a && a.display_url) || '' });
  };
  for (const a of attServerList()) push(a);
  for (const a of attUploaded.get(String(state.currentRecordId)) || []) push(a);
  return rows;
}

// The name, the shape a non-image row is entirely made of and an image row wears
// beside its thumbnail. A url-less row can only come from an upload whose
// response carried none — still worth showing (the file DID land), just not
// clickable.
function attNameLink(a) {
  const el = document.createElement(a.url ? 'a' : 'span');
  el.className = 'attachment-link';
  if (a.url) { el.href = a.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
  el.textContent = a.name;
  Tooltip.set(el, a.name);
  return el;
}

// #205: an image attached to the result is shown, not just named — the same
// thumbnail a reported step's screenshot gets, opening the same lightbox
// (test-view.js owns both). Everything else stays a name row. A thumbnail whose
// bytes never arrive drops back to exactly that row, paperclip included.
function attRow(a) {
  const li = document.createElement('li');
  li.className = 'attachment-row';
  if (isImageAttachment(a)) {
    li.classList.add('is-image');
    li.append(attachmentThumb(IMG_GROUP_ATTS, a, (el) => {
      el.remove();
      li.classList.remove('is-image');
    }));
  }
  li.append(attNameLink(a));
  return li;
}

// The list is only drawn on the test view, and only ever holds a handful of
// rows. When it holds none it says so in one compact line rather than
// collapsing: the two Attach buttons sit right above it, and a list that
// disappears leaves "did that upload land?" unanswered — which is exactly the
// question a tester asks after picking a file.
function renderAttachmentList() {
  const ul = $('attachment-list');
  if (!ul) return;
  ImgHydrate.release(IMG_GROUP_ATTS); // the thumbnails about to be dropped own these
  const onTest = state.view === 'test';
  const rows = onTest ? attRows() : [];
  ul.replaceChildren(...(rows.length
    ? rows.map(attRow)
    : [EmptyState.build({
      tag: 'li',
      compact: true,
      className: 'attachment-empty',
      icon: 'upload_file',
      text: 'No files attached to this result yet.',
    })]));
  ul.hidden = !onTest;
}

// ---- picking + uploading -------------------------------------------------

function onAttachFileClick() {
  const btn = $('btn-attach-file');
  if (btn?.disabled) return; // gated (no result record / basic mode) or an upload in flight
  const input = $('attach-file-input');
  if (input) input.click(); // the native picker; multi-select is on the element
}

// `change` from the hidden input. The FileList is snapshotted and the input
// cleared IMMEDIATELY: that lets the same file be picked twice in a row (a
// same-value input fires no change otherwise) and makes any duplicate change
// event a no-op instead of a second upload.
function onAttachFilePicked(ev) {
  const input = ev.target;
  const files = Array.from(input.files || []);
  input.value = '';
  if (files.length) attUploadFiles(files);
}

// One file at a time, deliberately: a failure toasts THAT file and the loop
// carries on (#107 — one rejected file must not cost the tester the other
// eleven), and the status line can report honest progress. The endpoint also
// de-duplicates by MD5 per record, so a repeat pick is cheap rather than wrong.
async function attUploadFiles(files) {
  const record = recordFor(state.currentRecordId);
  if (!record?.id) return; // the gate should have caught this; never upload blind
  const btn = $('btn-attach-file');
  if (btn) btn.disabled = true;
  let done = 0;
  let stopped = ''; // the lock reason that ended the loop early, if one landed
  try {
    for (let i = 0; i < files.length; i++) {
      // #187 — the picker outlives the click-time gate, and a slow pick outlives the lock itself.
      stopped = recordWriteLock(recordFor(record.id) || record); // by id: a structural sync apply replaces the row
      if (stopped) break; // at a file boundary — never half-way through an upload
      const f = files[i];
      setStatusLine('test-status', files.length === 1
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
    updateTestActionsState(); // restore the gate-driven disabled state
  }
  const noun = files.length === 1 ? 'file' : 'files';
  // A lock that landed mid-pick reports BOTH halves; with nothing uploaded the reason is the whole story.
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
