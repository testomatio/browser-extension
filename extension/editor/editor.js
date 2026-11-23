/* global TestomatAPI, Handoff, OverType, Md, EditorIcons, ParamsGrid, EditorDraft, PriorityControl, EditorView, RecSession, defaultToolbarButtons, Icons, Annotate, CaptureAnnotate, ensureSiteAccess, Tooltip, Dropdown, ImgHydrate, PanelLink, TabIndent */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rootEl = () => $('root');

  // One group: the read-only body and the Preview tab are the same render, only one ever on screen.
  const PREVIEW_IMG_GROUP = 'editor-preview';
  // The strip keeps its own blobs: it outlives Preview rebuilds and is released on a ref change only.
  const STRIP_IMG_GROUP = 'editor-strip';

  const { icon, ICON_BACK, ICON_ERROR, ICON_OPEN_IN_NEW, ICON_CAMERA, ICON_CLOSE, ICON_RECORD, ICON_STOP,
    ICON_EDIT, ICON_MARKDOWN, ICON_PREVIEW, ICON_TEMPLATE } = EditorIcons;

  // A name missing here keeps that button's own glyph rather than drawing blank.
  const TOOLBAR_ICONS = {
    bold: 'md_bold',
    italic: 'md_italic',
    code: 'md_code',
    link: 'link',
    h1: 'format_h1',           // the headings stay Material as a set (only an app H2 exists)
    h2: 'format_h2',
    h3: 'format_h3',
    bulletList: 'md_list_bulleted',
    orderedList: 'md_list_numbered',
    quote: 'format_quote',
  };

  function parseContext() {
    const p = new URLSearchParams(location.search);
    return {
      ctx: p.get('ctx') === 'tab' ? 'tab' : 'panel',
      test: p.get('test'),
      suite: p.get('suite'),
      // `?test=<uid>&edit` — the same test opened for writing; the view's Edit button sets it.
      edit: p.get('edit') != null,
      demo: p.get('demo') != null,
    };
  }

  // OverType injects these as CSS custom properties, so `var(--…)` follows tokens.css and the OS.
  const EDITOR_COLORS = {
    bgPrimary: 'var(--bg)',
    bgSecondary: 'var(--bg)',
    text: 'var(--fg-strong)',
    textPrimary: 'var(--fg-strong)',
    textSecondary: 'var(--muted)',
    h1: 'var(--accent)',
    h2: 'var(--accent)',
    h3: 'var(--accent)',
    strong: 'var(--fg-strong)',
    em: 'var(--fg-strong)',
    del: 'var(--muted)',
    link: 'var(--accent)',
    code: 'var(--fg-strong)',
    codeBg: 'var(--surface-2)',
    blockquote: 'var(--muted)',
    hr: 'var(--border)',
    // Marks take the words' accent; editor.css cancels the vendored opacity, so nothing dims text.
    syntaxMarker: 'var(--accent)',
    syntax: 'var(--muted)',
    cursor: 'var(--accent)',
    // Translucent: the hidden textarea's selection paints under the overlay glyphs; opaque blots them.
    selection: 'color-mix(in srgb, var(--accent) 35%, transparent)',
    listMarker: 'var(--accent)',
    // `raw-line` is the line the cursor is on, redrawn as raw markdown (overtype.min.js).
    rawLine: 'var(--fg-strong)',
    border: 'var(--border)',
    hoverBg: 'var(--hover-overlay)',
    primary: 'var(--accent)',
    toolbarBg: 'var(--bg)',
    toolbarIcon: 'var(--fg)',
    toolbarHover: 'var(--card)',
    toolbarActive: 'var(--row-active)',
    placeholder: 'var(--muted)',
  };
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const themeName = () => (mql.matches ? 'cave' : 'solar');
  function applyTheme() { try { OverType.setTheme(themeName(), EDITOR_COLORS); } catch { /* pre-init */ } }
  mql.addEventListener('change', applyTheme);

  // The Testomat app's own toolbar order, so testers find the same button in both editors.
  const TOOLBAR_ORDER = [
    'h1', 'h2', 'h3',
    'bold', 'italic',
    'link',
    'orderedList', 'bulletList',
    'code',
    'quote',
  ];
  const orderOf = (name) => {
    const i = TOOLBAR_ORDER.indexOf(name);
    return i === -1 ? TOOLBAR_ORDER.length : i;
  };

  // The vendored UMD tail puts the class on window.OverType, the buttons in a bare global: check both.
  function filteredToolbarButtons() {
    const all = (typeof defaultToolbarButtons !== 'undefined' && Array.isArray(defaultToolbarButtons))
      ? defaultToolbarButtons
      : (Array.isArray(OverType.defaultToolbarButtons) ? OverType.defaultToolbarButtons : null);
    if (!all) return null; // fall back to OverType's default set
    return all
      // taskList: `- [ ]` renders as a dead checkbox outside Steps.
      .filter((b) => b && b.name !== 'viewMode' && b.name !== 'taskList')
      .sort((a, b) => orderOf(a.name) - orderOf(b.name))
      // A copy per button: the array is the vendored module's own, and mutating it re-skins every OverType.
      .map((b) => {
        const glyph = TOOLBAR_ICONS[b.name] && Icons.markup(TOOLBAR_ICONS[b.name], 20);
        return glyph ? { ...b, icon: glyph } : b;
      });
  }

  function renderPreviewInto(box, md) {
    const tmp = Md.render(md);
    // The CSP allows no remote <img>; released first, as this runs per keystroke and owns the last batch.
    ImgHydrate.release(PREVIEW_IMG_GROUP);
    ImgHydrate.hydrate(PREVIEW_IMG_GROUP, tmp); // detached: the raw src never reaches the document
    box.replaceChildren(...tmp.childNodes);
  }

  // OverType's mirror is character-aligned, so an inline <img> would shift lines: thumbnails get a row.
  const IMG_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)/g;

  // Our own regex rather than OverType's private one; first mention wins.
  function imageRefs(md) {
    const seen = new Map();
    for (const m of String(md || '').matchAll(IMG_REF_RE)) {
      if (!seen.has(m[2])) seen.set(m[2], m[1] || '');
    }
    return [...seen].map(([url, alt]) => ({ url, alt }));
  }

  // A closer, not a flag: whatever revokes the strip's blobs must take the overlay showing one with it.
  let closeImageLightbox = null;
  function openImageLightbox(src, alt) {
    const box = document.createElement('div');
    box.id = 'tc-lightbox';
    box.className = 'tc-lightbox';
    const shot = document.createElement('img');
    shot.src = src;
    shot.alt = alt || '';
    box.append(shot);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey);
      closeImageLightbox = null;
      box.remove();
    }
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(box);
    closeImageLightbox = close;
  }

  // A non-empty description can render to nothing (a lone HTML comment), so the pane decides emptiness.
  function paneHasContent(box) {
    return box.textContent.trim() !== ''
      || !!box.querySelector('img, svg, video, iframe, canvas, table, hr, input');
  }

  // `{ error: true }` makes the live region an `alert`, so a reader is interrupted instead of queued.
  let toastTimer = null;
  function showToast(msg, { error = false } = {}) {
    const el = $('tc-toast');
    if (!el) return;
    el.classList.toggle('error', !!error);
    el.setAttribute('role', error ? 'alert' : 'status');
    el.hidden = false;   // unhide first: a hidden live region is not announced
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;
    if (error) {
      // `mark`, not `icon`: a local `icon` here would shadow the icon() helper this line calls.
      const mark = document.createElement('span');
      mark.className = 'toast-icon';
      mark.innerHTML = icon(ICON_ERROR, 16);
      el.replaceChildren(mark, text);
    } else {
      el.replaceChildren(text);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; el.setAttribute('role', 'status'); }, 3500);
  }

  const { editorDraftKey, readEditorDraft, removeEditorDraft, readDraftShots, makeDirtyTracker } = EditorDraft;

  // `chrome.storage` vanishes when the extension reloads under an open page, so every read is guarded.
  let activeSettings = null;
  const NEED_SETUP = 'Not configured — open the panel settings first.';
  // Each staged screenshot is a full JPEG held in this page's memory until Save.
  const MAX_SHOTS = 10;
  const RELOADED = 'This page lost its link to the extension (it was reloaded or updated). Close it and open the test again.';
  function hasLocal() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }
  async function ensureConfigured() {
    if (!hasLocal()) return RELOADED;
    let settings = null;
    try { ({ settings } = await chrome.storage.local.get('settings')); } catch { return RELOADED; }
    if (!Handoff.credentialed(settings) || !settings.projectId) return NEED_SETUP;
    activeSettings = settings;
    await Handoff.ready(); // a handed-off config keeps its session token in the host's file
    Handoff.configure(settings);
    return true;
  }

  // The panel's readonlyGate on the client's own tri-state: this document has no panel `state`.
  const READONLY_BLOCK = 'Your access to this project is read-only — the panel can’t author tests here. '
    + 'Pick another project in the panel settings, or ask a project owner for access that can write.';

  async function readonlyGate() {
    if (TestomatAPI.readonlyAccess() === 'unknown') await TestomatAPI.validate().catch(() => null);
    return TestomatAPI.readonlyAccess() === true;
  }

  // Rails `Test#to_url` and Ember `suites.test` both map `/projects/<slug>/test/<public_uid>`.
  function testWebUrl(uid, s = activeSettings) {
    if (!uid || !s || !s.baseUrl || !s.projectId) return null;
    const base = String(s.baseUrl).replace(/\/+$/, '');
    return `${base}/projects/${encodeURIComponent(s.projectId)}/test/${encodeURIComponent(uid)}`;
  }

  // Best-effort: an empty list or any failure falls back to an empty body, never a blocking error.
  async function loadTemplates() {
    try {
      const list = await TestomatAPI.listTemplates('test');
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  const pickDefaultTemplate = (list) => list.find((t) => t.isDefault) || list[0] || null;

  // Best-effort: any failure answers '', so an unknown language never costs a non-BDD project templates.
  let projectInfoPromise = null;
  function projectInfoOnce() {
    if (!projectInfoPromise) projectInfoPromise = Promise.resolve().then(() => TestomatAPI.getProjectInfo());
    return projectInfoPromise;
  }
  async function loadProjectLang() {
    try {
      const doc = await projectInfoOnce();
      const attrs = (doc && doc.data && doc.data.attributes) || {};
      return String(attrs.lang || '').toLowerCase();
    } catch { return ''; }
  }
  // Shared by the create seed and both parameter blocks: one probe per document.
  let projectLangPromise = null;
  function projectLangOnce() {
    if (!projectLangPromise) projectLangPromise = loadProjectLang();
    return projectLangPromise;
  }

  function renderMessage(text, { back = false, error = false } = {}) {
    const host = rootEl();
    host.replaceChildren();
    const box = document.createElement('div');
    box.className = error ? 'notice error tc-msg' : 'notice tc-msg';
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
    if (back) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Back';
      b.addEventListener('click', () => { location.href = '../sidepanel/index.html'; });
      box.append(b);
    }
    host.append(box);
  }

  // Read here, never consumed: the panel's own boot needs `tcReturn` to land back on that suite.
  function tcReturn() {
    try { return JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { return null; }
  }

  // Dropping the breadcrumb lands the panel on the TC tree rather than the suite this page came from.
  function toTestsRoot() {
    try { sessionStorage.removeItem('tcReturn'); } catch { /* best effort */ }
    location.href = '../sidepanel/index.html';
  }

  // Both handlers are the page's guarded leave paths: a crumb must never quietly lose an edit.
  function buildCrumbs({ onRoot, onSuite }) {
    const ret = tcReturn();
    const nav = document.createElement('nav');
    nav.id = 'tc-crumbs';
    nav.className = 'crumbs';
    nav.setAttribute('aria-label', 'Breadcrumb');
    const crumb = (label, onClick, truncates = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb';
      b.textContent = label;
      // A crumb that gives up width keeps its word on hover and for a reader.
      if (truncates) { Tooltip.set(b, label); b.setAttribute('aria-label', label); }
      b.addEventListener('click', onClick);
      return b;
    };
    nav.append(crumb('Tests', onRoot));
    if (ret && ret.suiteId) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      nav.append(sep, crumb(ret.suiteTitle || 'Suite', onSuite, true));
    }
    return nav;
  }

  function barMain(...kids) {
    const main = document.createElement('div');
    main.className = 'tc-bar-main';
    main.append(...kids);
    return main;
  }

  const { buildPriorityControl } = PriorityControl;

  const { buildParamsControl } = ParamsGrid;

  const { renderView } = EditorView;

  const { createRecSession } = RecSession;
  // Members that read module state here are handed over to be called, never copied into the module.
  const VIEW_SHELL = {
    rootEl, barMain, buildCrumbs, toTestsRoot, renderPreviewInto, paneHasContent,
    testWebUrl, projectLang: projectLangOnce, onSettings: (s) => { activeSettings = s; },
  };

  // Create POSTs into `suite` and seeds from a template; edit PATCHes `uid` and leaves the suite alone.
  function renderEditor({
    ctx, mode = 'create', uid = null, test = null,
    suite, title, markdown, priority, dirty: initialDirty = false, savedId: restoredSavedId = null,
    templates = [], templateId: initialTemplateId = null, params = null, recorded = null,
    shots = [], shotsLost = 0,
  }) {
    const editing = mode === 'edit';
    const viewHref = () => {
      const q = new URLSearchParams(location.search);
      q.delete('edit');
      q.delete('suite');
      q.set('test', uid);
      return `?${q.toString()}`;
    };
    const draftKey = editorDraftKey(editing ? { test: uid } : { suite });
    let saving = false;
    let done = false;        // saved → the read-only view took over this page
    // The first Save's id: a second Save updates that test, which is what lets a failed Save be retried.
    let savedId = restoredSavedId;
    let previewing = false;
    // Annotated screenshots held until Save, uploaded in the order they were taken.
    const pendingShots = shots.slice(); // …starting with the ones a restored draft was holding
    let shotsRev = 0; // the strip's revision: the tracker writes the pictures only when it moves
    // The getters reach controls built long after the tracker.
    const { markDirty, clearDirty, schedulePersist, onEdited, isDirty } = makeDirtyTracker({
      ctx,
      draftKey,
      read: {
        title: () => titleInput.value,
        markdown: () => editor.getValue(),
        priority: () => priorityCtrl.getPriority(),
        suite: () => suite || null,
        test: () => uid || null,
        params: () => paramsCtl.draft(),
        recording: () => rec.draftShape(),
        shots: () => pendingShots,
        shotsRev: () => shotsRev,
        savedId: () => savedId,
        stripRefresh: () => scheduleStripRefresh(),
      },
    });

    const host = rootEl();
    host.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'tc-editor';

    const bar = document.createElement('header');
    bar.className = 'bar sticky tc-bar';
    bar.dataset.tipSide = 'bottom'; // every tip in this row opens over the editor

    if (ctx === 'panel') {
      const backLabel = editing ? 'Back to test' : 'Back to suite';
      const backBtn = document.createElement('button');
      backBtn.id = 'tc-back';
      backBtn.className = 'icon-btn';
      Tooltip.set(backBtn, backLabel);
      backBtn.setAttribute('aria-label', backLabel);
      backBtn.innerHTML = icon(ICON_BACK);
      backBtn.addEventListener('click', () => { requestBack(); });
      bar.append(backBtn);
    }

    // The validation line is `hidden` while valid, so the row grows only when an error appears.
    const titleField = document.createElement('div');
    titleField.className = 'tc-title-field';

    // A textarea, not an input: the shared `.autogrow` field wraps instead of scrolling its start away.
    const titleInput = document.createElement('textarea');
    titleInput.id = 'tc-title';
    titleInput.className = 'textarea autogrow size-md tc-title-input';
    titleInput.rows = 1;
    titleInput.placeholder = 'Test case title';
    titleInput.value = title || '';
    titleInput.addEventListener('input', () => { clearTitleError(); syncSaveEnabled(); onEdited(); });
    // Enter moves to the body: a stray newline in the title would travel to the API.
    titleInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const ta = editHost.querySelector('.overtype-input');
      if (ta) ta.focus();
    });

    const titleError = document.createElement('div');
    titleError.id = 'tc-title-error';
    titleError.className = 'tc-title-error';
    titleError.setAttribute('role', 'alert'); // announced the moment it is filled
    titleError.hidden = true;
    titleField.append(titleInput, titleError);
    // Both crumbs leave through requestBack(), so the unsaved-changes guard covers them like Back.
    bar.append(ctx === 'panel'
      ? barMain(buildCrumbs({
        onRoot: () => requestBack(toTestsRoot),
        // The suite crumb goes to the suite in every mode, unlike the back arrow, which walks back one step.
        onSuite: () => requestBack(toPanelHome),
      }))
      : Object.assign(document.createElement('span'), { className: 'bar-spacer' }));

    function showTitleError(msg) {
      titleError.hidden = false; // unhide first: a hidden live region is not announced
      titleError.textContent = msg;
      titleInput.setAttribute('aria-invalid', 'true'); // also drives the red ring (editor.css)
      titleInput.setAttribute('aria-describedby', 'tc-title-error');
      titleInput.focus();
    }
    function clearTitleError() {
      if (titleError.hidden) return;
      titleError.hidden = true;
      titleError.textContent = '';
      titleInput.removeAttribute('aria-invalid');
      titleInput.removeAttribute('aria-describedby');
    }

    const priorityCtrl = buildPriorityControl(priority, onEdited);
    bar.append(priorityCtrl.wrap);

    // Edit only: a create has no test to open until it saves; a new tab needs no leave guard.
    if (editing) {
      const openLink = document.createElement('a');
      openLink.id = 'tc-open-web';
      openLink.className = 'icon-btn tc-open-web';
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      Tooltip.set(openLink, 'Open in Testomat');
      openLink.setAttribute('aria-label', 'Open in Testomat');
      openLink.innerHTML = icon(ICON_OPEN_IN_NEW);
      const url = testWebUrl(uid);
      if (url) openLink.href = url; else openLink.hidden = true;
      bar.append(openLink);
    }
    wrap.append(bar);

    const titleRow = document.createElement('div');
    titleRow.className = 'tc-title-row';
    titleRow.append(titleField);
    wrap.append(titleRow);

    // The panel's own tab bar, so the switch is the one testers know from Tests / Runs / Settings.
    const tabs = document.createElement('nav');
    tabs.className = 'tabs fill tc-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Editor view');
    const buildTab = (id, label, name, active) => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.className = active ? 'tab active tc-tab' : 'tab tc-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.innerHTML = `${icon(name, 16)}<span class="tab-label">${label}</span>`;
      return b;
    };
    // The id stays `tc-tab-edit` though the label says Markdown: the e2e and hotkeys address it.
    const editTab = buildTab('tc-tab-edit', 'Markdown', ICON_MARKDOWN, true);
    const previewTab = buildTab('tc-tab-preview', 'Preview', ICON_PREVIEW, false);
    tabs.append(editTab, previewTab);
    wrap.append(tabs);

    // The tools act on the text, so the row belongs to the Markdown tab alone; showPreview hides it.
    const tools = document.createElement('div');
    tools.className = 'toolbar divided tc-tools';

    // The shared Dropdown, not a native <select> whose OS popup is a full-width slab.
    let templateId = initialTemplateId;
    const tmplDD = Dropdown.create({
      id: 'tc-template',
      className: 'tc-template-field',
      triggerClass: 'size-sm tc-template-trigger',
      label: 'Test template',
      icon: ICON_TEMPLATE,
      align: 'end',
      options: templates.map((t) => ({
        value: t.id,
        label: (t.title || `Template ${t.id}`) + (t.isDefault ? ' (default)' : ''),
      })),
      value: templateId,
      fallbackFirst: true,
      // Picking replaces the body: free while nothing is authored, a confirm once something is.
      onChange: (id) => {
        const next = templateById(id);
        if (!next) return;
        // Comparing ids is not enough: a restored draft leaves the default picked over the tester's own body.
        if (editor.getValue() === next.body) { templateId = next.id; return; }
        if (bodyIsUnauthored()) applyTemplate(next.id);
        else openTemplateGuard(next.id);
      },
    });
    const tmplField = tmplDD.el;
    tmplDD.hidden = templates.length === 0;
    Tooltip.set(tmplDD.trigger, 'Start the description from a project template');
    const recBtn = document.createElement('button');
    recBtn.id = 'tc-rec';
    recBtn.type = 'button';
    recBtn.className = 'btn size-sm tc-tool';
    const recContinue = document.createElement('button');
    recContinue.id = 'tc-rec-continue';
    recContinue.type = 'button';
    recContinue.className = 'btn size-sm tc-tool';
    recContinue.textContent = 'Continue';
    recContinue.hidden = true;
    Tooltip.set(recContinue, 'Carry on recording into this test');
    // A switch, not a checkbox: it applies on change to the next stop, with no Save to belong to.
    const polishLabel = document.createElement('label');
    polishLabel.className = 'choice tc-polish';
    const polishInput = document.createElement('input');
    polishInput.id = 'tc-polish';
    polishInput.type = 'checkbox';
    polishInput.className = 'switch';
    polishInput.setAttribute('role', 'switch');
    // The words in a span: the short row hides them, and the input keeps its name either way.
    const polishText = document.createElement('span');
    polishText.className = 'tc-polish-text';
    polishText.textContent = 'Polish with AI';
    polishInput.setAttribute('aria-label', 'Polish with AI');
    polishLabel.append(polishInput, polishText);
    Tooltip.set(polishLabel, 'Rewrite the recorded steps with Testomat AI when you stop recording');
    // One button both ways: it polishes an unpolished recording and undoes a polished one.
    const polishBtn = document.createElement('button');
    polishBtn.id = 'tc-polish-btn';
    polishBtn.type = 'button';
    polishBtn.className = 'btn size-sm tc-tool';
    polishBtn.hidden = true;
    const attachBtn = document.createElement('button');
    attachBtn.id = 'tc-attach';
    attachBtn.type = 'button';
    attachBtn.className = 'btn icon size-sm tc-tool';
    attachBtn.innerHTML = icon(ICON_CAMERA, 16);
    attachBtn.setAttribute('aria-label', 'Attach screenshot');
    Tooltip.set(attachBtn, 'Attach screenshot — capture the active tab, mark it up, and attach it on Save');
    const shotPreview = document.createElement('ul');
    shotPreview.id = 'tc-shot-preview';
    shotPreview.className = 'thumb-row tc-shot-preview';
    shotPreview.setAttribute('aria-label', 'Screenshots to attach on Save');
    shotPreview.hidden = true;
    // Repeated-use buttons hold the row's head; the AI switch and template sit at its tail.
    tools.append(recBtn, recContinue, polishBtn, attachBtn, polishLabel, tmplField, shotPreview);
    wrap.append(tools);

    // Measured, not a breakpoint: the width the row needs depends on which controls are showing.
    let toolsFitWidth = 0; // the width it was last fitted at, the observer's guard
    const fitTools = () => {
      if (!tools.clientWidth) return; // hidden on the Preview tab, and nothing to measure
      // Words back on first, or a panel dragged wider would keep the short row.
      tools.classList.remove('is-short');
      const line = [recBtn, recContinue, polishBtn, attachBtn, polishLabel, tmplField]
        .filter((el) => !el.hidden && el.offsetParent);
      // Centres, not tops: the shorter switch starts lower on the same line; reading also forces layout.
      const mid = (el) => el.offsetTop + el.offsetHeight / 2;
      if (line.length && line.some((el) => Math.abs(mid(el) - mid(line[0])) > 1)) {
        tools.classList.add('is-short');
      }
      toolsFitWidth = tools.clientWidth;
    };
    // The observer also fires for the width the fit itself settled at, hence the guard.
    new ResizeObserver(() => {
      if (tools.clientWidth && tools.clientWidth !== toolsFitWidth) fitTools();
    }).observe(tools);

    const body = document.createElement('div');
    body.className = 'tc-body';
    const editHost = document.createElement('div');
    editHost.id = 'editor';
    editHost.className = 'tc-edit-pane';
    const previewPane = document.createElement('div');
    previewPane.id = 'tc-preview';
    previewPane.className = 'tc-preview-pane markdown';
    previewPane.hidden = true;
    body.append(editHost, previewPane);
    wrap.append(body);

    // A band under the text: inside .tc-body it would hang off a pane that is 100% of that box.
    const strip = document.createElement('div');
    strip.id = 'tc-image-strip';
    strip.className = 'tc-image-strip';
    strip.hidden = true;
    const stripLabel = document.createElement('div');
    stripLabel.className = 'tc-image-strip-label';
    const stripRow = document.createElement('div');
    stripRow.className = 'tc-image-strip-row';
    // Only a thumbnail whose bytes arrived enlarges; a fallback chip stays the link it is.
    stripRow.addEventListener('click', (e) => {
      const shot = e.target.closest('img[data-loaded="true"]');
      if (shot) openImageLightbox(shot.src, shot.alt);
    });
    strip.append(stripLabel, stripRow);
    wrap.append(strip);

    const paramsCtl = buildParamsControl({ seed: params, onEdited });
    wrap.append(paramsCtl.section);

    // Cancel is the same leave Back performs, and the only way out in the tab context.
    const footer = document.createElement('footer');
    footer.className = 'bar footer tc-footer';
    footer.dataset.tipSide = 'top'; // nothing below this row to open a tip into

    const saveBtn = document.createElement('button');
    saveBtn.id = 'tc-save';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => { save(); });
    // Also what re-arms the button after a save attempt, in place of a bare `disabled = false`.
    function syncSaveEnabled() {
      saveBtn.disabled = saving || done || !titleInput.value.trim();
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'tc-cancel';
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { requestBack(); });
    footer.append(saveBtn, cancelBtn);
    wrap.append(footer);

    const toast = document.createElement('div');
    toast.id = 'tc-toast';
    toast.className = 'toast tc-toast';
    toast.setAttribute('role', 'status'); // the editor's only announcement surface
    toast.hidden = true;
    wrap.append(toast);

    host.append(wrap);

    applyTheme();
    // OverType fires `onChange` while laying in the initial value, so dirty tracking waits for the mount.
    let mounted = false;
    const opts = {
      toolbar: true,
      // Through the options, not a stylesheet: textarea and overlay share one font set or the caret slides.
      fontFamily: 'var(--font-md-editor)',
      fontSize: 'var(--fs-base)',
      lineHeight: 'var(--leading-md-editor)',
      value: markdown || '',
      placeholder: 'Write the test case in Markdown…',
      onChange: () => { if (mounted) onEdited(); },
    };
    const filtered = filteredToolbarButtons();
    if (filtered) opts.toolbarButtons = filtered;
    const [editor] = new OverType('#editor', opts);
    mounted = true;
    TabIndent.attach(host, editor.textarea); // Tab indents the caret's line; Esc, then Tab leaves the field
    // The vendored toolbar's native `title`s would open an OS tooltip beside ours, so they move here once.
    Tooltip.adopt(host);

    function setTab(open, closed) {
      open.classList.add('active');
      open.setAttribute('aria-selected', 'true');
      closed.classList.remove('active');
      closed.setAttribute('aria-selected', 'false');
    }
    function showEdit() {
      previewing = false;
      previewPane.hidden = true;
      editHost.hidden = false;
      strip.hidden = !stripRow.childElementCount; // the strip belongs to this tab
      tools.hidden = false;
      setTab(editTab, previewTab);
    }
    function showPreview() {
      previewing = true;
      renderPreviewInto(previewPane, editor.getValue());
      editHost.hidden = true;
      previewPane.hidden = false;
      strip.hidden = true;
      tools.hidden = true;
      setTab(previewTab, editTab);
    }
    editTab.addEventListener('click', showEdit);
    previewTab.addEventListener('click', showPreview);

    // Rebuilding refetches every picture, so only when the ordered set of refs moved, not per keystroke.
    let stripKey = null;
    let stripTimer = null;
    function refreshStrip() {
      const refs = imageRefs(editor.getValue());
      const key = refs.map((r) => r.url).join('\n');
      if (key === stripKey) return;
      stripKey = key;
      if (closeImageLightbox) closeImageLightbox();
      ImgHydrate.release(STRIP_IMG_GROUP);
      if (!refs.length) { stripRow.replaceChildren(); strip.hidden = true; return; }
      const built = document.createElement('div');
      for (const r of refs) {
        const shot = document.createElement('img');
        shot.setAttribute('src', r.url);
        shot.alt = r.alt;
        shot.title = r.alt || r.url;
        built.append(shot);
      }
      ImgHydrate.hydrate(STRIP_IMG_GROUP, built); // detached: the raw src never reaches the document
      stripRow.replaceChildren(...built.childNodes);
      stripLabel.textContent = `Images in this test · ${refs.length}`;
      strip.hidden = previewing;
    }
    function scheduleStripRefresh() {
      clearTimeout(stripTimer);
      stripTimer = setTimeout(refreshStrip, 400);
    }
    refreshStrip(); // the body the mount just laid in

    // "Unauthored" = blank, or byte-equal to a template we offer (the seed, or an earlier pick).
    const templateById = (id) => templates.find((t) => t.id === id) || null;
    function bodyIsUnauthored() {
      const cur = editor.getValue();
      if (!cur.trim()) return true;
      return templates.some((t) => t.body === cur);
    }
    function applyTemplate(id) {
      const t = templateById(id);
      if (!t) return;
      templateId = id;
      tmplDD.setValue(id);
      editor.setValue(t.body);
      if (previewing) renderPreviewInto(previewPane, editor.getValue());
      onEdited(); // a swapped body is an unsaved change like any other
    }
    // `setValue` is the silent path, so putting the pick back cannot re-enter onChange.
    function revertTemplateSelect() { if (templateId) tmplDD.setValue(templateId); }

    let tmplGuard = null;
    let tmplPending = null; // id awaiting the Replace confirmation
    if (templates.length) {
      tmplGuard = document.createElement('div');
      tmplGuard.id = 'tc-template-guard';
      tmplGuard.className = 'tc-guard';
      tmplGuard.hidden = true;
      const tBox = document.createElement('div');
      tBox.className = 'dialog tc-guard-box';
      const tMsg = document.createElement('p');
      tMsg.className = 'tc-guard-msg';
      tMsg.id = 'tc-template-guard-msg';
      const tActions = document.createElement('div');
      tActions.className = 'dialog-actions';
      const tReplace = document.createElement('button');
      tReplace.id = 'tc-template-replace';
      tReplace.className = 'btn primary';
      tReplace.textContent = 'Replace';
      const tCancel = document.createElement('button');
      tCancel.id = 'tc-template-cancel';
      tCancel.className = 'btn';
      tCancel.textContent = 'Cancel';
      tActions.append(tCancel, tReplace);
      tBox.append(tMsg, tActions);
      tmplGuard.append(tBox);
      wrap.append(tmplGuard);

      tReplace.addEventListener('click', () => {
        const id = tmplPending;
        closeTemplateGuard();
        if (id) applyTemplate(id);
      });
      tCancel.addEventListener('click', () => { closeTemplateGuard(); revertTemplateSelect(); });
    }
    function closeTemplateGuard() {
      tmplPending = null;
      if (tmplGuard) tmplGuard.hidden = true;
    }
    function openTemplateGuard(id) {
      const t = templateById(id);
      if (!tmplGuard || !t) return;
      tmplPending = id;
      const msg = $('tc-template-guard-msg');
      if (msg) msg.textContent = `Replace what you wrote with the “${t.title || 'selected'}” template?`;
      tmplGuard.hidden = false;
      const b = $('tc-template-replace');
      if (b) b.focus();
    }

    // Only words in the label, so textContent stays the plain sentence the e2e reads.
    const setRecBtn = (name, label) => {
      recBtn.innerHTML = icon(name, 16);
      const span = document.createElement('span');
      span.textContent = label;
      recBtn.append(span);
      // The short row hides the span, so the name has to live somewhere the icon can carry it.
      recBtn.setAttribute('aria-label', label);
      fitTools(); // `Stop recording (12)` is a good deal wider than `Record steps`
    };

    const rec = createRecSession({
      editor,
      getTitle: () => titleInput.value,
      showToast,
      api: TestomatAPI,
      chrome: typeof chrome !== 'undefined' ? chrome : null,
      // Creating, there is no test to polish against until Save — and no polish before then.
      testUid: editing ? uid : null,
      recorded,
      onPersist: () => schedulePersist(),
      ui: {
        rec: (v) => {
          recBtn.disabled = v.disabled;
          Tooltip.set(recBtn, v.tip);
          setRecBtn(v.active ? ICON_STOP : ICON_RECORD, v.label);
          recBtn.classList.toggle('recording', v.active);
          recContinue.hidden = v.continueHidden;
        },
        polish: (v) => {
          polishBtn.hidden = v.hidden;
          if (!v.hidden) { polishBtn.textContent = v.label; Tooltip.set(polishBtn, v.tip); }
          fitTools(); // one control more or less on the row is a different fit
        },
        polishRow: (hidden) => { polishLabel.hidden = hidden; },
        polishSwitch: (on) => { polishInput.checked = on; },
        // The textarea only while the caret is actually in it: an insert lands mid-typing.
        caret: () => {
          const ta = editHost.querySelector('.overtype-input');
          return ta && document.activeElement === ta ? ta : null;
        },
        edited: (md) => {
          onEdited();
          if (previewing) renderPreviewInto(previewPane, md);
        },
      },
    });

    recBtn.addEventListener('click', () => {
      if (rec.isRecording()) rec.runExclusive(() => rec.finish());
      else rec.start();
    });
    recContinue.addEventListener('click', () => { rec.continueRecording(); });
    polishBtn.addEventListener('click', () => {
      if (rec.isPolished()) { rec.undo(); return; }
      rec.runExclusive(() => rec.polish());
    });
    // The switch may move at any point in a recording — only where it stands at Stop counts.
    polishInput.addEventListener('change', () => { rec.setPolishOn(polishInput.checked); });
    rec.loadPolishPref();
    // A company without AI keeps the switch in view, but it explains instead of sending.
    if (TestomatAPI.jwtAvailable() !== false) {
      projectInfoOnce().then((doc) => rec.setAiStatus(RecFormat.aiStatusOf(doc)), () => {});
    }

    // Rebuilt whole: at most MAX_SHOTS rows, and a diff would be a second place to get their order wrong.
    function renderShotPreview() {
      shotsRev += 1; // the one place every change to the strip goes through
      shotPreview.replaceChildren();
      shotPreview.hidden = pendingShots.length === 0;
      if (!pendingShots.length) return;
      pendingShots.forEach((dataUrl, i) => {
        const cell = document.createElement('li');
        cell.className = 'thumb';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = `Screenshot ${i + 1} of ${pendingShots.length}, attached on Save`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-btn size-xs thumb-remove';
        remove.dataset.shot = String(i);
        remove.innerHTML = icon(ICON_CLOSE, 16);
        remove.setAttribute('aria-label', `Remove screenshot ${i + 1}`);
        Tooltip.set(remove, 'Remove this screenshot');
        remove.addEventListener('click', () => dropShot(i));
        cell.append(img, remove);
        shotPreview.append(cell);
      });
    }
    // Focus can't stay on a removed button: it moves to the next picture's remove, or the camera.
    function dropShot(i) {
      if (i < 0 || i >= pendingShots.length) return;
      pendingShots.splice(i, 1);
      renderShotPreview();
      markDirty();
      schedulePersist(); // the strip is the change here; nothing else will write the draft
      const next = shotPreview.querySelector(`.thumb-remove[data-shot="${Math.min(i, pendingShots.length - 1)}"]`);
      (next || attachBtn).focus();
    }

    async function attachScreenshot() {
      if (attachBtn.disabled) return;
      if (pendingShots.length >= MAX_SHOTS) {
        showToast(`${MAX_SHOTS} screenshots is the most one test can hold — save, or remove one first`, { error: true });
        return;
      }
      attachBtn.disabled = true;
      try {
        // Site access first (capture + overlay inject need it); never a prompt.
        const access = await ensureSiteAccess();
        if (!access.ok) { showToast(access.error, { error: true }); return; }
        const perm = await CaptureAnnotate.ensureCapturePermission();
        if (!perm.ok) { showToast(perm.error, { error: true }); return; }
        const resp = await CaptureAnnotate.captureTab({ fullPage: false });
        // `needsGrant`: the worker's sentence already names the fix, so it is shown as it stands.
        if (!resp.ok) {
          showToast(resp.needsGrant ? resp.error : `Capture failed: ${resp.error || 'unknown'}`, { error: true });
          return;
        }
        const staged = await CaptureAnnotate.annotateImage(resp.dataUrl, resp.tabId, { toast: showToast });
        if (!staged) return; // Discard — nothing staged
        pendingShots.push(staged);
        renderShotPreview();
        markDirty(); // a pending shot is unsaved work
        schedulePersist(); // …and a tester who stages one and closes the panel types nothing more
      } finally {
        attachBtn.disabled = false;
      }
    }
    attachBtn.addEventListener('click', attachScreenshot);
    renderShotPreview(); // a restored draft arrives with its strip already full
    rec.refresh();
    syncSaveEnabled(); // a create opens with no title, so Save opens greyed out

    // Session-only, so basic mode drops the block; BDD too: the body's Examples own the data.
    async function loadParams() {
      if (TestomatAPI.jwtAvailable() === false) { paramsCtl.disable(); return; }
      if ((await projectLangOnce()) === 'gherkin') { paramsCtl.disable(); return; }
      if (!editing) { paramsCtl.ready(); return; }
      try {
        const read = await TestomatAPI.getTestParams(uid);
        paramsCtl.load({
          headers: read.params,
          rows: read.examples.map((e) => ({ id: e.id, cells: e.data })),
        });
      } catch (e) {
        if ((e && e.kind === 'auth') || TestomatAPI.jwtAvailable() === false) { paramsCtl.disable(); return; }
        paramsCtl.ready();
        showToast(`Parameters couldn't be loaded: ${(e && e.message) || e}`, { error: true });
      }
    }
    // The same probe answers whether the AI switch has a session to work with.
    loadParams().then(rec.syncPolishVisible, rec.syncPolishVisible);

    // Latching `done` makes a second Save impossible; creating, that would be a duplicate TC.
    function handOverToView(id, saved) {
      done = true;
      rec.handOver();
      clearTimeout(stripTimer);
      if (closeImageLightbox) closeImageLightbox();
      ImgHydrate.release(STRIP_IMG_GROUP); // the view that takes over draws its own images
      document.removeEventListener('keydown', onEditorKey);
      const p = new URLSearchParams(location.search);
      p.delete('suite');
      p.delete('edit');
      p.set('test', id);
      history.replaceState(null, '', `?${p.toString()}`); // a reload lands on the view
      renderView({ shell: VIEW_SHELL, ctx, uid: id, ...saved });
    }

    async function save() {
      if (saving || done) return null;
      // Claim the flag before the first await, or a second chord slips past into a duplicate POST.
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        // A running recorder is drained first: what is not in the body is not in the payload.
        if (rec.isRecording()) await rec.runExclusive(() => rec.finish());
        // A polish already out is waited for, or Save sends the raw text just before the answer rewrites it.
        await rec.settle();
        const description = editor.getValue();
        // A paste can bring real newlines into the wrapping field; the API gets one line.
        const t = titleInput.value.replace(/\s+/g, ' ').trim();
        const priority = priorityCtrl.getPriority();
        if (!t) { showTitleError('Title is required'); return null; }
        // The grid is judged before anything is written: a row under a nameless column would be unreadable.
        const paramsWrite = paramsCtl.plan();
        if (!paramsWrite) return null;
        // Never `suite_id` on update, it would move the test; one already created here is updated on retry.
        const target = savedId || (editing ? uid : null);
        const written = target
          ? await TestomatAPI.updateTest(target, { title: t, description, priority })
          : await TestomatAPI.createTest({ title: t, suite_id: suite, description, priority });
        // Editing, the uid is known up front and stays whatever the response echoes.
        const id = (written && written.id) || target;
        savedId = id;
        // Best-effort: a failed upload toasts, and shots that did not land stay staged for the next Save.
        let shotError = null;
        let shotFailed = 0;
        if (pendingShots.length && id) {
          const stamp = Date.now();
          const kept = [];
          for (let i = 0; i < pendingShots.length; i++) {
            try {
              const blob = await (await fetch(pendingShots[i])).blob();
              await TestomatAPI.uploadTestAttachment(id, blob, `editor-shot-${id}-${stamp}-${i + 1}.jpg`);
            } catch (e) {
              kept.push(pendingShots[i]);
              shotError = (e && e.message) || e;
            }
          }
          shotFailed = kept.length;
          pendingShots.splice(0, pendingShots.length, ...kept);
          renderShotPreview();
        }
        // The test itself is saved either way; the parameters leg is best-effort, as the uploads are.
        const paramsError = id ? await paramsCtl.commit(id, paramsWrite) : null;
        // What did not land is only in this grid: keep the editor, draft and dirty flag for a second Save.
        if (paramsError) {
          // The draft has to learn the test exists, or a reload before the retry makes a second one.
          schedulePersist();
          showToast(`Saved — parameters couldn't be written (${paramsError})`, { error: true });
          return null;
        }
        clearDirty();
        removeEditorDraft(draftKey); // clearDirty only removes it when it was still dirty
        // For a create, `test: {}` is the `manual` kind TestType reads from a record without state flags.
        const record = (editing && test) ? { ...test, title: t, priority } : {};
        // View first, then the toast: showToast targets the view's own element.
        if (id) handOverToView(id, { title: t, markdown: description, priority, test: record });
        else done = true;
        if (shotError) {
          showToast(shotFailed > 1
            ? `Saved — ${shotFailed} screenshots couldn't attach (${shotError})`
            : `Saved — the screenshot couldn't attach (${shotError})`, { error: true });
        }
        else showToast('Saved ✓');
        return id;
      } catch (e) {
        showToast(`Save failed: ${(e && e.message) || e}`, { error: true }); // keep full editor state
        return null;
      } finally {
        saving = false;
        syncSaveEnabled(); // never back over an empty title
        saveBtn.textContent = 'Save';
      }
    }

    // Held here so the guard's Save & leave / Discard go where the leave was headed; a tab closes.
    const toPanelHome = ctx === 'panel'
      ? () => { location.href = '../sidepanel/index.html'; }
      : () => { window.close(); };
    // An edit returns to the test's own view in both contexts: closing the tab would lose the test.
    const goHome = editing ? () => { location.href = viewHref(); } : toPanelHome;
    let leaveTo = goHome;
    function navigateBack() { leaveTo(); }
    function closeGuard() { if (guard) guard.hidden = true; }
    function openGuard() {
      if (!guard) return;
      guard.hidden = false;
      const s = $('tc-guard-save');
      if (s) s.focus();
    }
    // A leave while recording is intercepted once: stop + insert, stay; a second goes through the dialog.
    function requestBack(to = goHome) {
      leaveTo = to;
      if (rec.isRecording()) { rec.runExclusive(() => rec.finish('Recording stopped')); return; }
      if (isDirty()) openGuard(); else navigateBack();
    }

    // Built in both contexts: `beforeunload` does not fire for the window.close() Cancel performs.
    const guard = document.createElement('div');
    guard.id = 'tc-guard';
    guard.className = 'tc-guard';
    guard.hidden = true;
    const guardBox = document.createElement('div');
    guardBox.className = 'dialog tc-guard-box';
    const guardMsg = document.createElement('p');
    guardMsg.className = 'tc-guard-msg';
    guardMsg.textContent = 'You have unsaved changes.';
    const guardActions = document.createElement('div');
    guardActions.className = 'dialog-actions';
    const gSave = document.createElement('button');
    gSave.id = 'tc-guard-save';
    gSave.className = 'btn primary';
    gSave.textContent = 'Save & leave';
    const gDiscard = document.createElement('button');
    gDiscard.id = 'tc-guard-discard';
    gDiscard.className = 'btn';
    gDiscard.textContent = 'Discard';
    const gCancel = document.createElement('button');
    gCancel.id = 'tc-guard-cancel';
    gCancel.className = 'btn';
    gCancel.textContent = 'Cancel';
    guardActions.append(gDiscard, gCancel, gSave);
    guardBox.append(guardMsg, guardActions);
    guard.append(guardBox);
    // Save & leave: navigate only on a successful save; a failure keeps the editor state.
    gSave.addEventListener('click', async () => { closeGuard(); const id = await save(); if (id) navigateBack(); });
    gDiscard.addEventListener('click', () => { clearDirty(); navigateBack(); });
    gCancel.addEventListener('click', closeGuard);
    wrap.append(guard);

    // Named and removable: the view that takes over must not keep a live Save chord on this editor.
    function onEditorKey(e) {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault(); // always on the chord — else the browser Save dialog appears
        if (!saving) save();
        return;
      }
      if (e.key !== 'Escape') return;
      // The template swap first: it is the dialog that can sit on top of an already-dirty editor.
      if (tmplGuard && !tmplGuard.hidden) {
        e.preventDefault(); closeTemplateGuard(); revertTemplateSelect(); return;
      }
      if (guard && !guard.hidden) { e.preventDefault(); closeGuard(); }
    }
    document.addEventListener('keydown', onEditorKey);

    window.__tc = {
      ready: true,
      ctx,
      mode: () => (editing ? 'edit' : 'create'),
      // Creating, there is no uid until Save — and so no web url either.
      uid: () => uid,
      ...(editing ? { webUrl: () => testWebUrl(uid) } : {}),
      getMarkdown: () => editor.getValue(),
      setMarkdown: (md) => {
        editor.setValue(md);
        onEdited();
        if (previewing) renderPreviewInto(previewPane, editor.getValue());
      },
      getTitle: () => titleInput.value,
      setTitle: (t) => { titleInput.value = t; clearTitleError(); syncSaveEnabled(); onEdited(); },
      getPriority: () => priorityCtrl.getPriority(),
      setPriority: (p) => priorityCtrl.setPriority(p),
      // The parameters grid as data: `{headers, rows:[{id, cells}], removed}`.
      getParams: () => paramsCtl.get(),
      setParams: (next) => paramsCtl.set(next),
      paramsAvailable: () => paramsCtl.available(),
      // `pickTemplate` is user-equivalent: it goes through the same confirm path.
      templates: () => templates.map((t) => ({ id: t.id, title: t.title, isDefault: t.isDefault })),
      templateId: () => templateId,
      pickTemplate: (id) => tmplDD.pick(String(id)),
      recording: () => rec.isRecording(),
      // Stop flips `recording` at once, but its insert and polish are round trips away; wait for this too.
      recStopping: () => rec.isBusy(),
      polishing: () => rec.polishOn(),
      setPolishing: (on) => rec.setPolishOn(on),
      lastPolishMessage: () => rec.lastPolishMessage(),
      // The button's current words, or null when it is not offered at all.
      polishBtnLabel: () => (polishBtn.hidden ? null : polishBtn.textContent),
      // What this editor still holds of a recording — what the draft would persist.
      recordingInDraft: () => {
        const d = rec.draftShape();
        return rec.hasRecording()
          ? { entries: d.entries.length, start: d.start, count: d.count, polished: d.polished }
          : null;
      },
      // A 30s wait is not something an e2e can sit through.
      setPolishTimeout: (ms) => rec.setPolishTimeout(ms),
      recBlind: () => rec.isBlind(),
      pendingShots: () => pendingShots.slice(),
      pendingShot: () => (pendingShots.length ? pendingShots[pendingShots.length - 1] : null),
      // Append one, or clear the row with a falsy argument.
      stageShot: (dataUrl) => {
        if (dataUrl) pendingShots.push(dataUrl); else pendingShots.length = 0;
        renderShotPreview();
        markDirty();
        schedulePersist(); // the stand drives staging through here — it must take the real path
      },
      dropShot: (i) => { dropShot(i); return pendingShots.length; },
    };

    // A restored draft is already unsaved content: it stays in storage until save or discard.
    if (initialDirty) markDirty();
    // Said now, while the shots can still be retaken — not at Save, when the test is written.
    if (shotsLost > 0) {
      showToast(shotsLost > 1
        ? `${shotsLost} staged screenshots couldn't be restored — take them again`
        : `A staged screenshot couldn't be restored — take it again`, { error: true });
    }
  }

  function renderDemo() {
    document.title = 'Test editor — demo';
    const host = rootEl();
    host.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'tc-editor';
    const hint = document.createElement('p');
    hint.className = 'hint tc-hint';
    hint.textContent = 'Test editor — demo (local, no API).';
    wrap.append(hint);
    const body = document.createElement('div');
    body.className = 'tc-body';
    const editHost = document.createElement('div');
    editHost.id = 'editor';
    editHost.className = 'tc-edit-pane';
    body.append(editHost);
    wrap.append(body);
    host.append(wrap);

    applyTheme();
    // The e2e harness supplies samples to __roundtrip; with none set the pane shows this placeholder.
    const demoOpts = {
      toolbar: true,
      fontFamily: 'var(--font-md-editor)',
      fontSize: 'var(--fs-base)',
      lineHeight: 'var(--leading-md-editor)',
      value: 'Test editor — demo (local, no API). The e2e harness supplies round-trip samples.',
    };
    const demoButtons = filteredToolbarButtons();
    if (demoButtons) demoOpts.toolbarButtons = demoButtons;
    const [editor] = new OverType('#editor', demoOpts);
    Tooltip.adopt(host); // the vendored toolbar's `title`s, same as the real editor

    // OverType edits raw markdown, so a set/get cycle per sample proves byte-identity.
    window.__roundtrip = async (samples) => (Array.isArray(samples) ? samples : []).map(({ name, markdown }) => {
      editor.setValue(markdown);
      return { name, input: markdown, output: editor.getValue() };
    });
  }

  async function boot() {
    // Before every early return: a toolbar click must not re-open the panel over this page.
    if (typeof PanelLink !== 'undefined') PanelLink.init();
    // `?annotate=<key>` hands the whole page to the annotator — no OverType, no API.
    const annotateKey = new URLSearchParams(location.search).get('annotate');
    if (annotateKey != null) { if (typeof Annotate !== 'undefined') Annotate.init(annotateKey); return; }

    const cx = parseContext();
    const panelCtx = cx.ctx === 'panel';

    if (cx.demo) { renderDemo(); return; }

    if (!cx.test && !cx.suite) {
      renderMessage('Nothing to show — open a test from Tests.', { back: panelCtx });
      return;
    }

    const configured = await ensureConfigured();
    if (configured !== true) {
      renderMessage(configured, { back: panelCtx });
      return;
    }

    // Painted before the probe, by the same call that renders the result, so bars are replaced in place.
    if (cx.test) renderView({ shell: VIEW_SHELL, ctx: cx.ctx, uid: cx.test, loading: true });
    // The template seed rides along with the probe — loadTemplates swallows every failure.
    const templatesLoad = cx.suite ? loadTemplates() : null;
    // Started at boot so the language read overlaps the other round trips.
    const projectLangLoad = (cx.suite || cx.test) ? projectLangOnce() : null;

    // A direct load (restored tab, bookmark) never passed the Tests tab's own gate.
    if (await readonlyGate()) { renderMessage(READONLY_BLOCK, { back: panelCtx }); return; }

    // One read serves both screens: the editor opens on the test's current text.
    if (cx.test) {
      try {
        const tc = await TestomatAPI.getTest(cx.test);
        if (cx.edit) {
          let title = (tc && tc.title) || '';
          let markdown = (tc && tc.description) || '';
          let priority = (tc && tc.priority) || 'normal';
          let params = null;
          let recorded = null;
          let restoredDirty = false;
          let shots = [];
          let shotsLost = 0;
          // An unsaved edit of this test outranks the server: a closed panel is not a discard.
          const key = editorDraftKey({ test: cx.test });
          const draft = await readEditorDraft(key);
          if (draft) {
            title = draft.title || '';
            if (draft.markdown != null) markdown = draft.markdown;
            priority = draft.priority || priority;
            params = draft.params || null;
            recorded = draft.recording || null;
            ({ shots, lost: shotsLost } = await readDraftShots(draft, key));
            restoredDirty = true;
          }
          // No `templates`: a template seeds an unwritten body, and this one is written.
          renderEditor({
            ctx: cx.ctx, mode: 'edit', uid: cx.test, test: tc || null,
            title, markdown, priority, params, recorded, dirty: restoredDirty, shots, shotsLost,
          });
          return;
        }
        renderView({
          shell: VIEW_SHELL,
          ctx: cx.ctx,
          uid: cx.test,
          title: (tc && tc.title) || '',
          markdown: (tc && tc.description) || '',
          priority: (tc && tc.priority) || 'normal',
          test: tc || null, // the header's mark reads its kind (or emoji) off it
        });
      } catch (e) {
        if (e && e.kind === 'notfound') {
          renderMessage('This test case was not found (it may have been deleted).',
            { back: panelCtx, error: true });
        } else {
          renderMessage(`Couldn't load this test case: ${(e && e.message) || e}`,
            { back: panelCtx, error: true });
        }
      }
      return;
    }

    // A BDD project gets no templates, as on the web; a failed probe reads as non-gherkin and keeps them.
    const gherkin = (await projectLangLoad) === 'gherkin';
    const templates = gherkin ? [] : await templatesLoad;
    const initialTemplate = pickDefaultTemplate(templates);
    let title = '';
    let markdown = initialTemplate ? initialTemplate.body : (gherkin ? 'Scenario: ' : '');
    let priority = 'normal';
    let params = null;
    let recorded = null;
    let restoredDirty = false;
    let shots = [];
    let shotsLost = 0;
    // A create whose test landed but whose parameters did not: the retry must update it.
    let savedId = null;
    // The restored draft is the tester's own text — it outranks the template seed.
    const key = editorDraftKey({ suite: cx.suite });
    const draft = await readEditorDraft(key);
    if (draft) {
      title = draft.title || '';
      if (draft.markdown != null) markdown = draft.markdown;
      priority = draft.priority || 'normal';
      params = draft.params || null;
      // The recording it held: its steps are in the body, and this still lets them be polished or put back.
      recorded = draft.recording || null;
      ({ shots, lost: shotsLost } = await readDraftShots(draft, key));
      savedId = draft.savedId || null;
      restoredDirty = true;
    }
    renderEditor({
      ctx: cx.ctx, suite: cx.suite, savedId,
      title, markdown, priority, params, recorded, dirty: restoredDirty, shots, shotsLost,
      templates, templateId: initialTemplate ? initialTemplate.id : null,
    });
  }

  boot();
})();
