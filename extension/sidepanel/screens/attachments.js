// Local-file attachments on a test result (#107). A picked File IS a Blob, so it
// rides TestomatAPI.uploadAttachment; the button's gate lives in test-view.js.

/* global TestomatAPI, state, recordFor, recordWriteLock, $, toast, setStatusLine,
   updateTestActionsState, Tooltip, EmptyState, ImgHydrate, isImageAttachment,
   attachmentThumb, IMG_GROUP_ATTS */

// Uploads this PANEL SESSION made, keyed by record id: the server list refreshes
// only on reopen, so a just-picked file would otherwise vanish from it.
const attUploaded = new Map();

// ---- the list -----------------------------------------------------------

// Uploads surface on the JSON:API detail's `attachments`; the v2 `artifacts` field
// stays empty for them. probeSession prefetched it, so this costs no request.
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
    rows.push({ name, url, type: (a && a.type) || '', display_url: (a && a.display_url) || '' });
  };
  for (const a of attServerList()) push(a);
  for (const a of attUploaded.get(String(state.currentRecordId)) || []) push(a);
  return rows;
}

// A url-less row (an upload whose response carried none) still shows — the file
// DID land — just not clickable.
function attNameLink(a) {
  const el = document.createElement(a.url ? 'a' : 'span');
  el.className = 'attachment-link';
  if (a.url) { el.href = a.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
  el.textContent = a.name;
  Tooltip.set(el, a.name);
  return el;
}

// #205: an image row gets the same thumbnail and lightbox a step screenshot does
// (test-view.js owns both); one whose bytes never arrive drops back to a name row.
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

// An empty list says so in one compact line rather than collapsing — a list that
// disappears leaves "did that upload land?" unanswered.
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
