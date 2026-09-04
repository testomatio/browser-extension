// The result summary card (IIFE global `TestSummary`): everything the last run left BEHIND the
// verdict — the failure body, the artifacts, the environment meta and the reported step tree — plus
// the file tiles those lean on. The verdict path reads none of it; it only asks this to repaint. So
// the card is a subject of its own, and it used to share one closure with the screen that marks a
// test: a change to how a step log linkifies meant editing that screen.
//
// It is also the panel's ONE file-tile shape, so screens/attachments.js draws a manual upload with
// the same `fileTileItem` and releases the same group — hence this file loads before it.

/* global TestomatAPI, Md, Fmt, Sk, EmptyState, ImgHydrate, Tooltip, state, hasChrome, $,
   svgIcon, statusIcon, normStatus, treeSlot, CHEVRON_ICON, paintStepMark */

const TestSummary = (() => {
  // Object-URL groups (shared/img-hydrate.js) — four, because each is repainted and released
  // on its own occasion. The description body's own group stays with the screen that draws it.
  const IMG_GROUP_SHOTS = 'summary-shots';
  const IMG_GROUP_ATTS = 'result-attachments';
  const IMG_GROUP_ARTIFACTS = 'summary-artifacts';
  const IMG_GROUP_FAILURE = 'summary-failure';

  // ---- result summary (#117) ----
  // JWT-only; JSON:API attribute keys are DASHERIZED (`run-time`). `steps` is
  // serialized only for a manual testrun — an automated one uses the lazy GET.

  // Remembered for the panel session (module-level), like the Attachments one.
  const summaryOpen = { failure: true, artifacts: true, meta: false, steps: false };

  const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };
  // Mirrors the run header's RUN_STATE_TINT; anything else is neutral.
  const TEST_STATE_TINT = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

  // Per-open state, cleared by hideResultSummary.
  let summarySteps = null;
  let summaryStepsFetch = null;

  // `kind` is 'unreported' | 'bare' (falsy clears): "mark it and this fills in" vs
  // "it IS marked and the run carried nothing behind the verdict".
  function paintSummaryEmpty(kind) {
    const host = $('test-summary-empty');
    if (!host) return;
    if (!kind) { host.replaceChildren(); return; }
    EmptyState.into(host, kind === 'bare' ? {
      icon: 'checklist',
      title: 'Nothing behind this result',
      text: 'No failure message, environment meta or reported steps came with it.',
    } : {
      icon: 'checklist',
      title: 'Nothing reported yet',
      text: 'Mark a result above to see its failure, environment meta and step outcomes here.',
    });
  }

  // Driven by what the tab actually HOLDS, not by the existence of a verdict: a
  // marked test with an empty summary must not wear a dot.
  function paintSectionMark(status) {
    const tab = $('tab-test-summary');
    if (!tab) return;
    const existing = tab.querySelector('.status-dot');
    if (!status) { if (existing) existing.remove(); return; }
    const dot = existing || document.createElement('span');
    dot.className = 'status-dot';
    dot.dataset.status = status;
    if (!existing) tab.append(dot);
  }

  function hideResultSummary() {
    const box = $('test-summary');
    if (box) box.hidden = true;
    if ($('test-result-row')) $('test-result-row').hidden = true;
    paintSummaryEmpty('unreported');
    paintSectionMark('');
    if ($('summary-message')) $('summary-message').replaceChildren();
    if ($('summary-artifacts-body')) $('summary-artifacts-body').replaceChildren();
    if ($('summary-meta-body')) $('summary-meta-body').replaceChildren();
    if ($('summary-steps-body')) $('summary-steps-body').replaceChildren();
    summarySteps = null;
    summaryStepsFetch = null;
    ImgHydrate.release(IMG_GROUP_SHOTS);
    ImgHydrate.release(IMG_GROUP_ARTIFACTS);
    ImgHydrate.release(IMG_GROUP_FAILURE);
    syncSummaryStepsTools();
  }

  function paintSummaryDisclosure(key) {
    const head = $(`summary-${key}-head`);
    const body = $(`summary-${key}-body`);
    const open = !!summaryOpen[key];
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (body) body.hidden = !open;
    if (key === 'steps') syncSummaryStepsTools();
  }

  function toggleSummaryDisclosure(key) {
    summaryOpen[key] = !summaryOpen[key];
    paintSummaryDisclosure(key);
    if (key === 'steps' && summaryOpen.steps) loadSummarySteps(); // lazy for automated
  }

  function renderResultSummary() {
    const box = $('test-summary');
    if (!box) return;
    const attrs = state.testrunDetail?.data?.attributes;
    const status = attrs?.status;
    // "Reported" = the web's `hasStatus`: a real, non-pending status.
    if (!attrs || !status || status === 'pending') { hideResultSummary(); return; }
    if ($('test-result-row')) $('test-result-row').hidden = false;
    const label = STATUS_LABEL[status] || status;
    // `data-status` stays: the machine-readable value a script reads off the element.
    const el = $('summary-status');
    el.className = `status-label ${TEST_STATE_TINT[normStatus(status)] || 'neutral'}`;
    el.dataset.status = status;
    const word = document.createElement('span');
    word.textContent = label;
    el.replaceChildren(statusIcon(status), word);
    const dur = Fmt.humanDuration(attrs['run-time']);
    $('summary-duration').textContent = dur ? `· ${dur}` : '';
    renderSummaryFailure(attrs);
    renderSummaryArtifacts(attrs);
    renderSummaryMeta(attrs);
    renderSummaryStepsSection(attrs);
    // All four hidden = an empty accordion, which a bare manual pass reaches often.
    const filled = ['summary-failure', 'summary-artifacts', 'summary-meta', 'summary-steps']
      .some((id) => $(id) && !$(id).hidden);
    box.hidden = !filled;
    paintSummaryEmpty(filled ? '' : 'bare');
    paintSectionMark(filled ? normStatus(status) : '');
  }

  // `status` and `message` are the ONLY fields the panel can change, so they are
  // patched into the prefetched detail instead of costing a re-read.
  function refreshResultSummary(record) {
    const attrs = state.testrunDetail?.data?.attributes;
    if (!attrs || !record) return;
    attrs.status = record.status;
    attrs.message = record.message || '';
    renderResultSummary();
  }

  // The split matters: a reporter message is assertion output whose whitespace IS
  // the information (verbatim text); a manual one is Markdown through the sanitizer.
  function renderSummaryFailure(attrs) {
    const wrap = $('summary-failure');
    const out = $('summary-message');
    if (!wrap || !out) return;
    const message = typeof attrs.message === 'string' ? attrs.message.trim() : '';
    wrap.hidden = !message;
    ImgHydrate.release(IMG_GROUP_FAILURE); // the <img>s about to be dropped own these
    out.replaceChildren();
    if (!message) return;
    const failed = attrs.status === 'failed';
    $('summary-failure-title').textContent = failed ? 'Failure' : 'Log';
    out.className = `summary-message ${failed ? 'is-failed' : 'is-ok'}`;
    if (attrs.automated) {
      out.classList.add('code', 'is-raw');
      out.textContent = message; // pre-wrap; reporter output is not markdown
    } else {
      const tmp = Md.render(message); // shared/markdown.js — parse + sanitize
      // Hydrate BEFORE the body reaches the document, like every other Md.render site:
      // the CSP allows no remote <img>, so an unhydrated one is a broken box.
      ImgHydrate.hydrate(IMG_GROUP_FAILURE, tmp);
      // `.sections`: headings inside the panel's chrome render as muted labels.
      out.classList.add('markdown', 'sections');
      out.append(...tmp.childNodes);
    }
    paintSummaryDisclosure('failure');
  }

  // #21: on a private bucket the server presigns only the first artifacts of a result
  // and flags the tail — signed once per URL here ('' remembers a refusal).
  const artifactPresigned = new Map();

  async function artifactSigned(a) {
    if (!a?.needs_presign || !a.url) return a;
    if (!artifactPresigned.has(a.url)) {
      let signed = '';
      try { signed = await TestomatAPI.presignArtifact(a.url); } catch { /* stays raw */ }
      artifactPresigned.set(a.url, signed);
    }
    const url = artifactPresigned.get(a.url);
    // A refusal keeps the raw URL: the link still opens, and a thumbnail that fails on
    // it drops back to that same link rather than a broken box.
    return url ? { ...a, url, display_url: url } : a;
  }

  // Web parity: the web's Summary lists EVERY file on the result — runner artifacts and manual
  // uploads alike (one `attachments` array, told apart by the `artifact` flag) — so this fold
  // does too. attachments.js still keeps its own fold to the manual ones.
  function renderSummaryArtifacts(attrs) {
    const wrap = $('summary-artifacts');
    const body = $('summary-artifacts-body');
    if (!wrap || !body) return;
    const rows = (Array.isArray(attrs.attachments) ? attrs.attachments : [])
      .filter((a) => a && (a.url || a.name));
    wrap.hidden = rows.length === 0;
    if (!rows.length) {
      ImgHydrate.release(IMG_GROUP_ARTIFACTS); // the thumbnails about to be dropped own these
      body.replaceChildren();
      return;
    }
    $('summary-artifacts-count').textContent = String(rows.length);
    paintSummaryDisclosure('artifacts');
    paintSummaryArtifacts(rows);
  }

  // Async because of the presign: a tile is built only once its URL is final, so the
  // preview, the viewer and the way out never start on one that is about to change.
  async function paintSummaryArtifacts(rows) {
    const recordId = state.currentRecordId;
    const resolved = await Promise.all(rows.map((a) => artifactSigned(a)));
    const body = $('summary-artifacts-body');
    if (!body || String(state.currentRecordId) !== String(recordId)) return; // moved on
    ImgHydrate.release(IMG_GROUP_ARTIFACTS);
    body.replaceChildren(...resolved.map((a) => fileTileItem(a, IMG_GROUP_ARTIFACTS, attachmentHref(a))));
  }

  // Meta = the testrun's non-system `extras` (web `metafields`); the system entries
  // (change/duration/substatus/testlink) are bookkeeping, never shown.
  function renderSummaryMeta(attrs) {
    const wrap = $('summary-meta');
    const body = $('summary-meta-body');
    if (!wrap || !body) return;
    const rows = (Array.isArray(attrs.extras) ? attrs.extras : [])
      .filter((e) => e && e.source !== 'system' && e.key);
    wrap.hidden = rows.length === 0;
    body.replaceChildren();
    if (!rows.length) return;
    $('summary-meta-count').textContent = String(rows.length);
    for (const e of rows) {
      const dt = document.createElement('dt');
      dt.textContent = e.key;
      const dd = document.createElement('dd');
      dd.textContent = e.value == null ? '' : String(e.value);
      body.append(dt, dd);
    }
    paintSummaryDisclosure('meta');
  }

  // Automated: only `sections.steps.count` is advertised, the list is fetched on first expand.
  function renderSummaryStepsSection(attrs) {
    const wrap = $('summary-steps');
    if (!wrap) return;
    const inline = Array.isArray(attrs.steps) ? attrs.steps : null;
    const advertised = Number(attrs.sections?.steps?.count) || 0;
    summarySteps = inline && inline.length ? inline : null;
    const count = summarySteps ? summarySteps.length : advertised;
    wrap.hidden = count === 0;
    if (!count) return;
    $('summary-steps-count').textContent = String(count);
    paintSummaryDisclosure('steps');
    if (summarySteps) paintSummarySteps();
    else if (summaryOpen.steps) loadSummarySteps();
  }

  // Same route the web uses: GET /testruns/{id}/steps -> { steps: [...] }. Best-effort.
  async function loadSummarySteps() {
    const body = $('summary-steps-body');
    if (!body || summarySteps || summaryStepsFetch) return;
    const recordId = state.currentRecordId;
    if (!recordId) return;
    // Drawn at once rather than armed: nothing behind it for a placeholder to flash over.
    body.replaceChildren(Sk.lines(['76%', '58%', '68%']));
    summaryStepsFetch = TestomatAPI.jwtRequest(`/testruns/${encodeURIComponent(recordId)}/steps`);
    try {
      const doc = await summaryStepsFetch;
      if (String(state.currentRecordId) !== String(recordId)) return; // moved on
      summarySteps = Array.isArray(doc?.steps) ? doc.steps : [];
      paintSummarySteps();
    } catch {
      if (String(state.currentRecordId) === String(recordId)) body.textContent = "Couldn't load the reported steps";
    } finally {
      summaryStepsFetch = null;
    }
  }

  // ---- reported steps: web-report parity (#202) ----
  // Live contract: `attachments` exist ONLY on GET /testruns/{id}/steps (the manual
  // route permits [status,title,message,pos]); `duration` comes back a STRING there.

  // Web parity (front nested-steps.js): attachments move into a child "Attachments"
  // group so they render in one place. Length check, or an empty array grows a group.
  function summaryStepTree(steps) {
    return (Array.isArray(steps) ? steps : []).map((step) => {
      const node = {
        name: step?.title,
        category: step?.category, // carried like the web's transform; not rendered
        duration: step?.duration,
        attachments: step?.attachments,
        log: step?.log,
        error: step?.error,
        status: step?.status,
        children: null,
        isImage: false,
      };
      if (Array.isArray(step?.steps) && step.steps.length) node.children = summaryStepTree(step.steps);
      if (Array.isArray(step?.attachments) && step.attachments.length) {
        if (!node.children) node.children = [];
        node.children.push({ name: 'Attachments', attachments: step.attachments, children: null });
        node.attachments = null;
        node.isImage = true;
      }
      return node;
    });
  }

  // Web default: collapsed until the tester asks. Sticky per panel session.
  let summaryStepsExpanded = false;

  // http(s) URLs inside a step log become real links — built as anchor NODES around
  // text nodes, never through innerHTML: the log is reporter output, i.e. untrusted.
  const LOG_URL_RE = /https?:\/\/[^\s<>"']+/g;

  function linkifyInto(el, text) {
    const s = String(text);
    let last = 0;
    for (const m of s.matchAll(LOG_URL_RE)) {
      let href = m[0];
      const trail = href.match(/[.,;:!?)\]}'"]+$/); // trailing punctuation is prose, not URL
      if (trail) href = href.slice(0, -trail[0].length);
      if (!href) continue;
      if (m.index > last) el.append(s.slice(last, m.index));
      const a = document.createElement('a');
      a.href = href;
      a.textContent = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.append(a);
      last = m.index + href.length;
    }
    if (last < s.length) el.append(s.slice(last));
  }

  // Web `isImage`: trust the server MIME type, the name only as fallback; SVG excluded.
  function isImageAttachment(a) {
    const type = String(a?.type || '');
    if (type) return type.startsWith('image/') && !/svg/i.test(type);
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(String(a?.name || a?.url || ''));
  }

  // #21: EITHER tell, not MIME-first like the image test — a bucket serves a screencast as
  // `application/octet-stream` often enough that the extension has to be able to answer alone.
  function isVideoAttachment(a) {
    if (String(a?.type || '').startsWith('video/')) return true;
    return /\.(webm|mp4|mov|m4v|ogv)(?:$|[?#])/i.test(String(a?.name || a?.url || ''));
  }

  // The tile badge: what the file IS, in the few letters an 88px card fits.
  function fileExt(a) {
    const m = String(a?.name || a?.url || '').match(/\.([a-z0-9]{1,5})(?:$|[?#])/i);
    return m ? m[1].toUpperCase() : '';
  }

  // e2e-only hook: real artifact URLs are presigned bucket links the harness cannot
  // mint, so `stepShotHook` swaps only the HOST and the whole fetch path still runs.
  async function shotHookBase() {
    if (!hasChrome || !chrome.storage?.session) return '';
    try { return (await chrome.storage.session.get('stepShotHook')).stepShotHook || ''; } catch { return ''; }
  }

  // `display_url` is the presigned inline form (no session); `url` is the app-host
  // route behind the login, which fetchAsset carries the JWT to.
  // The instance's own URL first: `display_url` is already a storage link the server put in
  // the data, and the bytes are the same file — its own address redirects there authorized.
  async function attachmentSrc(att) {
    const base = await shotHookBase();
    if (base) return new URL(att?.name || '', base).toString();
    return att?.url || att?.display_url || '';
  }

  // `display_url` is the inline form of an IMAGE; for any other type the server answers a
  // file-type icon there, so the file itself only ever comes from `url`.
  const attachmentHref = (att) => (isImageAttachment(att) ? att?.display_url || att?.url : att?.url) || '';

  // An href out of server data, resolved then checked: attachment urls come root-relative too, and
  // a relative one resolves against chrome-extension://. `javascript:` is the hole it must not open.
  const linkHref = (raw) => {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url) return '';
    const abs = typeof TestomatAPI !== 'undefined' && TestomatAPI.assetUrl
      ? TestomatAPI.assetUrl(url) : url;
    return /^https?:\/\//i.test(abs) ? abs : '';
  };

  function attachmentLink(att) {
    const url = linkHref(att?.url);
    const el = document.createElement(url ? 'a' : 'span');
    el.className = 'summary-step-att-link';
    if (url) { el.href = url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    el.textContent = att?.name || 'attachment';
    el.title = el.textContent;
    return el;
  }

  // Bytes go through shared/img-hydrate.js because CSP img-src carries no `https:`
  // by design (#175). `onFail` gives the caller's own row shape — never a broken box.
  function attachmentThumb(group, att, onFail) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attachment-thumb';
    btn.title = `${att?.name || 'screenshot'} — click to enlarge`;
    const img = document.createElement('img');
    img.alt = att?.name || 'screenshot';
    btn.append(img);
    btn.addEventListener('click', () => openFileViewer(att));
    attachmentSrc(att)
      .then((src) => ImgHydrate.load(group, src, img))
      .then((ok) => { if (!ok) onFail(btn); })
      .catch(() => onFail(btn));
    return btn;
  }

  // A step's video keeps the tree's one-line density (no tile), but its click opens the
  // same viewer the tiles use instead of handing the tester a new tab.
  function attachmentPlay(att) {
    const url = attachmentHref(att);
    if (!url) return attachmentLink(att);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'summary-step-att-link is-play';
    btn.title = att?.name || 'attachment';
    btn.append(svgIcon('play_arrow', 12), document.createTextNode(att?.name || 'attachment'));
    btn.addEventListener('click', () => openFileViewer(att, url));
    return btn;
  }

  function summaryAttachment(att) {
    if (isImageAttachment(att)) {
      return attachmentThumb(IMG_GROUP_SHOTS, att, (el) => el.replaceWith(attachmentLink(att)));
    }
    return isVideoAttachment(att) ? attachmentPlay(att) : attachmentLink(att);
  }

  // ---- file tiles (#21) ----
  // One shape everywhere the panel LISTS files: an image shows itself, a video and any other
  // file show a card. Which one a tile is lives in `data-kind`, and the click reads it back —
  // an image whose bytes never arrive becomes a 'file' card and opens in a tab like one.

  function paintTilePreview(host, kind, att) {
    host.replaceChildren();
    if (kind === 'image') {
      const img = document.createElement('img');
      img.alt = att?.name || 'screenshot';
      host.append(img);
      return;
    }
    const badge = document.createElement('span');
    badge.className = 'file-tile-badge';
    badge.textContent = fileExt(att) || 'FILE';
    host.append(svgIcon(kind === 'video' ? 'play_arrow' : 'description', 24), badge);
  }

  function fileTile(att, group, resolvedUrl) {
    const url = resolvedUrl || attachmentHref(att);
    const name = att?.name || 'attachment';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-tile';
    btn.dataset.kind = isImageAttachment(att) ? 'image' : (isVideoAttachment(att) ? 'video' : 'file');
    Tooltip.set(btn, name);
    const preview = document.createElement('span');
    preview.className = 'file-tile-preview';
    paintTilePreview(preview, btn.dataset.kind, att);
    const label = document.createElement('span');
    label.className = 'file-tile-name';
    label.textContent = name;
    btn.append(preview, label);
    if (btn.dataset.kind === 'image') {
      const fail = () => { btn.dataset.kind = 'file'; paintTilePreview(preview, 'file', att); };
      attachmentSrc(att)
        .then((src) => ImgHydrate.load(group, src, preview.querySelector('img')))
        .then((ok) => { if (!ok) fail(); })
        .catch(fail);
    }
    btn.addEventListener('click', () => openFileViewer(att, url));
    return btn;
  }

  // Both file grids are <ul>s, so the tile travels inside an <li>.
  function fileTileItem(att, group, resolvedUrl) {
    const li = document.createElement('li');
    li.append(fileTile(att, group, resolvedUrl));
    return li;
  }

  // The web's `file-image-outline` marker, in the panel's own icon set.
  function imageMarker() {
    return svgIcon('photo_camera', 13, 'summary-step-marker');
  }

  // A step block is a TREE NODE, drawn with the library's own tree parts: a chevron
  // slot, then a glyph slot, then the title — the shape the runs list and TC studio
  // already wear, so the three lists rule at the same columns.
  // An Attachments group node renders NO step row — the web skips it the same way
  // (`{{#unless node.model.attachments}}`) and shows only the files.
  function summaryStepNode(node) {
    const group = document.createElement('div');
    group.className = 'summary-step-group tree-node';
    // The row rule hangs off `.summary-step-self`, so a step's own log stays ABOVE
    // the line that closes it and its children start below.
    const self = document.createElement('div');
    self.className = 'summary-step-self';
    group.append(self);
    if (node?.attachments) {
      // The files hang off the block the way a log does, so the rule that closes the
      // block still starts at the same column as every other row's.
      const atts = document.createElement('div');
      atts.className = 'summary-step-atts';
      for (const att of node.attachments) atts.append(summaryAttachment(att));
      self.append(atts);
      return group;
    }
    const row = document.createElement('div');
    row.className = 'summary-step tree-row has-chevron';
    const kids = node?.children?.length ? document.createElement('div') : null;
    if (kids) {
      // A bare chevron in the tree's 20px slot — still a real button, so it keeps its
      // place in the tab order. CSS rotates it 90° on aria-expanded.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-icon chevron summary-step-toggle';
      toggle.append(svgIcon(CHEVRON_ICON, 16));
      const paint = (open) => {
        kids.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        Tooltip.set(toggle, open ? 'Collapse' : 'Expand');
      };
      paint(summaryStepsExpanded);
      toggle.addEventListener('click', () => paint(kids.hidden));
      row.append(toggle);
    } else {
      row.append(treeSlot()); // a leaf still pays for the chevron column, or the marks below it stagger
    }
    const dot = document.createElement('span');
    dot.className = 'tree-icon summary-step-dot';
    dot.dataset.status = node?.status || '';
    paintStepMark(dot, node?.status, 16, 'radio_button_unchecked');
    const title = document.createElement('span');
    title.className = 'summary-step-title';
    title.textContent = node?.name || '(untitled step)';
    row.append(dot, title);
    if (node?.isImage) title.append('\u00a0', imageMarker()); // NBSP: the mark rides the last word instead of wrapping alone
    if (node?.status) {
      const word = document.createElement('span');
      word.className = 'summary-step-status';
      word.dataset.status = node.status;
      word.textContent = node.status;
      row.append(word);
    }
    const dur = Fmt.humanDuration(node?.duration);
    if (dur) {
      const d = document.createElement('span');
      d.className = 'summary-step-duration';
      d.textContent = dur;
      row.append(d);
    }
    self.append(row);
    if (node?.error) {
      const err = document.createElement('div');
      err.className = 'summary-step-error';
      err.textContent = String(node.error);
      self.append(err);
    }
    // The log hangs off the step, not its children — readable while sub-steps are collapsed.
    if (node?.log) {
      const log = document.createElement('div');
      log.className = `summary-step-log${node.error ? ' is-failed' : ''}`;
      linkifyInto(log, String(node.log).trim());
      self.append(log);
    }
    if (kids) {
      // A `.tree-children` and nothing more: the open subtree is the library's own
      // container, so it drops the same guide a folder does in the runs list and
      // takes the same 28px step in — and folding it away takes the line with it.
      kids.className = 'summary-step-kids tree-children';
      kids.hidden = !summaryStepsExpanded;
      for (const child of node.children) kids.append(summaryStepNode(child));
      group.append(kids);
    }
    return group;
  }

  // Created lazily beside the disclosure head, so app.js needs no extra wiring.
  function summaryStepsTools() {
    const wrap = $('summary-steps');
    const head = $('summary-steps-head');
    if (!wrap || !head) return null;
    let tools = wrap.querySelector('.summary-steps-tools');
    if (tools) return tools;
    tools = document.createElement('div');
    tools.className = 'summary-steps-tools';
    const mk = (id, icon, label, expanded) => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.className = 'btn icon size-xs';
      b.append(svgIcon(icon, 16));
      b.setAttribute('aria-label', label);
      Tooltip.set(b, label);
      b.addEventListener('click', () => {
        summaryStepsExpanded = expanded;
        paintSummarySteps();
      });
      return b;
    };
    tools.append(mk('summary-steps-expand', 'keyboard_arrow_down', 'Expand all', true),
      mk('summary-steps-collapse', 'keyboard_arrow_up', 'Collapse all', false));
    head.after(tools);
    return tools;
  }

  function syncSummaryStepsTools() {
    const tools = summaryStepsTools();
    if (tools) tools.hidden = !summaryOpen.steps || !(summarySteps && summarySteps.length);
  }

  function paintSummarySteps() {
    const body = $('summary-steps-body');
    if (!body) return;
    ImgHydrate.release(IMG_GROUP_SHOTS); // the <img>s about to be dropped own these
    body.replaceChildren();
    if (!summarySteps || !summarySteps.length) {
      // Compact: a centred block would push the rest of the test view off screen.
      body.append(EmptyState.build({
        compact: true,
        icon: 'format_list_numbered',
        text: 'No reported steps',
      }));
      syncSummaryStepsTools();
      return;
    }
    for (const node of summaryStepTree(summarySteps)) body.append(summaryStepNode(node));
    syncSummaryStepsTools();
  }

  // ---- file viewer (#21) ----
  // Out of the panel entirely (at ~400px a video is a postage stamp), but not into a window of
  // its own either: on macOS a popup cannot float over a fullscreen browser. The worker draws
  // the viewer INTO the page under test instead (background.js openFileOverlay).

  function openFileViewer(att, resolvedUrl) {
    const url = resolvedUrl || attachmentHref(att);
    if (!url) return;
    if (!hasChrome || !chrome.runtime?.sendMessage) { window.open(url, '_blank', 'noopener'); return; }
    chrome.runtime
      // `mime`, not `type`: the message's own `type` is what the worker routes on.
      .sendMessage({ type: 'OPEN_FILE_OVERLAY', url, name: att?.name || '', mime: att?.type || '' })
      .catch(() => { window.open(url, '_blank', 'noopener'); });
  }

  // The panel itself reaches only the first four and the two screens/attachments.js needs; the
  // rest are named because tests/test-summary.test.mjs drives them one at a time.
  return {
    render: renderResultSummary,
    refresh: refreshResultSummary,
    hide: hideResultSummary,
    toggleDisclosure: toggleSummaryDisclosure,
    paintSteps: paintSummarySteps,
    stepTree: summaryStepTree,
    isImage: isImageAttachment,
    isVideo: isVideoAttachment,
    href: attachmentHref,
    src: attachmentSrc,
    fileExt,
    linkifyInto,
    fileTile,
    fileTileItem,
    openFileViewer,
    attachmentLink,
    attachmentThumb,
    artifactSigned,
    shotHookBase,
    renderSummaryFailure,
    renderSummaryArtifacts,
    renderSummaryMeta,
    renderSummaryStepsSection,
    loadSummarySteps,
    IMG_GROUP_ATTS,
  };
})();
