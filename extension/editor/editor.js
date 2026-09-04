// TC Studio test page: read-only view (?test) + editor (&edit / ?suite), served both
// in the side panel and in a tab. Needs the panel's `TestomatAPI` global and OverType.

/* global TestomatAPI, Handoff, OverType, Md, EditorIcons, ParamsGrid, EditorDraft, PriorityControl, EditorView, RecSession, defaultToolbarButtons, Icons, Annotate, CaptureAnnotate, ensureSiteAccess, Tooltip, Dropdown, ImgHydrate, PanelLink */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rootEl = () => $('root');

  // One img-hydrate group: the read-only body and the Preview tab are the same render,
  // and only one of them is ever on screen.
  const PREVIEW_IMG_GROUP = 'editor-preview';
  // The Markdown tab's thumbnail strip (#51) keeps its OWN blobs: it stands while the Preview
  // pane is torn down and rebuilt, and it is released on a ref change rather than a keystroke.
  const STRIP_IMG_GROUP = 'editor-strip';

  // Icon names resolved by shared/icons.js (Material Symbols Rounded), in editor-icons.js so the
  // extracted modules draw the same glyphs. ICON_ADD/MINUS/FOLD are the parameters grid's alone.
  const { icon, ICON_BACK, ICON_ERROR, ICON_OPEN_IN_NEW, ICON_CAMERA, ICON_CLOSE, ICON_RECORD, ICON_STOP,
    ICON_EDIT, ICON_MARKDOWN, ICON_PREVIEW, ICON_TEMPLATE } = EditorIcons;

  // Re-skins the vendored toolbar from shared/icons.js by replacing each button's `icon`
  // as data; a name missing here keeps that button's own glyph rather than drawing blank.
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

  // Priority values are the v2 enum (verified live); order/icons/colors live in
  // shared/priority-icons.js.

  // ---- URL context ---------------------------------------------------------
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

  // ---- theme: OverType's 'solar' (light) / 'cave' (dark), repainted ---------
  // OverType injects these as CSS custom properties into this document, so `var(--…)`
  // resolves against shared/tokens.css and follows the OS switch — one map serves both.
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
    // Marks take the words' accent; editor.css also cancels the vendored
    // `.syntax-marker` opacity, so nothing here dims text to rank it.
    syntaxMarker: 'var(--accent)',
    syntax: 'var(--muted)',
    cursor: 'var(--accent)',
    // Must stay translucent: the native selection of the (invisible) textarea paints
    // UNDER the coloured overlay glyphs, and an opaque wash blots them out.
    selection: 'color-mix(in srgb, var(--accent) 35%, transparent)',
    listMarker: 'var(--accent)',
    // `raw-line` is the line the CURSOR is on, redrawn as raw markdown (overtype.min.js).
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

  // The order of the Testomat app's own markdown toolbar, so a tester moving between the
  // two editors reaches for the same button in the same place. Unlisted names sort last.
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

  // ---- toolbar: default button set minus the dropped ones -------------------
  // The vendored UMD tail overwrites `window.OverType` with the CLASS and leaves the button
  // array in the bare global `defaultToolbarButtons`, so both homes have to be checked.
  function filteredToolbarButtons() {
    const all = (typeof defaultToolbarButtons !== 'undefined' && Array.isArray(defaultToolbarButtons))
      ? defaultToolbarButtons
      : (Array.isArray(OverType.defaultToolbarButtons) ? OverType.defaultToolbarButtons : null);
    if (!all) return null; // fall back to OverType's default set
    return all
      // taskList: `- [ ]` renders as a dead checkbox outside Steps (owner bug report 2026-07-22).
      .filter((b) => b && b.name !== 'viewMode' && b.name !== 'taskList')
      .sort((a, b) => orderOf(a.name) - orderOf(b.name))
      // A copy per button: the array is the vendored module's own, and mutating it would
      // re-skin every OverType on the page. `name` is what the toolbar writes as data-button.
      .map((b) => {
        const glyph = TOOLBAR_ICONS[b.name] && Icons.markup(TOOLBAR_ICONS[b.name], 20);
        return glyph ? { ...b, icon: glyph } : b;
      });
  }

  // ---- markdown preview: the panel's renderer, not a second one (shared/markdown.js)
  function renderPreviewInto(box, md) {
    const tmp = Md.render(md);
    // #205: the CSP allows no remote <img>, so bytes are fetched as blob: URLs. Released
    // FIRST — this runs on every keystroke, and the body about to be dropped owns the last batch.
    ImgHydrate.release(PREVIEW_IMG_GROUP);
    ImgHydrate.hydrate(PREVIEW_IMG_GROUP, tmp); // detached: the raw src never reaches the document
    box.replaceChildren(...tmp.childNodes);
  }

  // ---- image strip (#51): the pictures a test references, listed under the Markdown tab --
  // OverType draws a transparent textarea over a character-aligned mirror, so an inline <img>
  // would slide every line under it out of place — the thumbnails go in a row of their own.
  const IMG_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)/g;

  // `{url, alt}` in the order the body names them, first mention wins. Our own regex rather
  // than OverType's private one.
  function imageRefs(md) {
    const seen = new Map();
    for (const m of String(md || '').matchAll(IMG_REF_RE)) {
      if (!seen.has(m[2])) seen.set(m[2], m[1] || '');
    }
    return [...seen].map(([url, alt]) => ({ url, alt }));
  }

  // Full size over the editor. Held as a closer, not a flag: whatever revokes the strip's
  // blobs — a rebuild, a Save handing the page over — has to take the overlay showing one with it.
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

  // A non-empty description can still render to nothing (a lone HTML comment, markup the
  // sanitizer takes out whole), so emptiness is decided by the pane, not by the string.
  function paneHasContent(box) {
    return box.textContent.trim() !== ''
      || !!box.querySelector('img, svg, video, iframe, canvas, table, hr, input');
  }

  // ---- toast (bottom, auto-hides) -----------------------------------------
  // `{ error: true }` escalates the live region to `alert` so a reader interrupts instead
  // of queueing — the same contract the panel toast follows (#72/#81).
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

  // The unsaved draft and the dirty tracking around it live in draft.js, with its own test file.
  const { editorDraftKey, readEditorDraft, removeEditorDraft, readDraftShots, makeDirtyTracker } = EditorDraft;

  // ---- config: same settings the panel persists --------------------------
  // `chrome.storage` is torn out from under a page whose extension reloaded or updated
  // while it was open, so every read is guarded — the page can't recover and says so.
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

  // ---- read-only access probe (#155/#187) ---------------------------------
  // The panel's readonlyGate on the client's own tri-state: this document has no panel `state`.
  const READONLY_BLOCK = 'Your access to this project is read-only — the panel can’t author tests here. '
    + 'Pick another project in the panel settings, or ask a project owner for access that can write.';

  async function readonlyGate() {
    if (TestomatAPI.readonlyAccess() === 'unknown') await TestomatAPI.validate().catch(() => null);
    return TestomatAPI.readonlyAccess() === true;
  }

  // ---- the web URL of a test (#113) ---------------------------------------
  // Verified against the product: Rails `Test#to_url` and the Ember route `suites.test`
  // both map `/projects/<slug>/test/<public_uid>` — singular `test`, the PUBLIC uid.
  function testWebUrl(uid, s = activeSettings) {
    if (!uid || !s || !s.baseUrl || !s.projectId) return null;
    const base = String(s.baseUrl).replace(/\/+$/, '');
    return `${base}/projects/${encodeURIComponent(s.projectId)}/test/${encodeURIComponent(uid)}`;
  }

  // ---- project templates (#104) -------------------------------------------
  // Best-effort by contract: an empty list or ANY failure (no session, offline, no
  // permission) falls back to an empty body — never a blocking error.
  async function loadTemplates() {
    try {
      const list = await TestomatAPI.listTemplates('test');
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  const pickDefaultTemplate = (list) => list.find((t) => t.isDefault) || list[0] || null;

  // ---- project language (#35) ---------------------------------------------
  // Same best-effort contract as loadTemplates: ANY failure (no session, offline, no
  // permission) answers '' — an unknown language must not cost a non-BDD project its
  // templates. Only a BDD project answers 'gherkin'.
  async function loadProjectLang() {
    try {
      const doc = await TestomatAPI.getProjectInfo();
      const attrs = (doc && doc.data && doc.data.attributes) || {};
      return String(attrs.lang || '').toLowerCase();
    } catch { return ''; }
  }
  // Shared by the create seed (#35) and both parameter blocks (#32) — one probe per document.
  let projectLangPromise = null;
  function projectLangOnce() {
    if (!projectLangPromise) projectLangPromise = loadProjectLang();
    return projectLangPromise;
  }

  // ---- a plain message screen (unconfigured / load error / stub) ----------
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

  // ---- breadcrumb trail (panel ctx only) ----------------------------------
  // The suite comes from the `tcReturn` entry openEditor() left in sessionStorage — read
  // here, never consumed: the panel's own boot needs it to land back on that suite's list.
  function tcReturn() {
    try { return JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { return null; }
  }

  // Dropping the return breadcrumb is what makes the panel land on the TC tree
  // rather than on the suite this page came from.
  function toTestsRoot() {
    try { sessionStorage.removeItem('tcReturn'); } catch { /* best effort */ }
    location.href = '../sidepanel/index.html';
  }

  // Both handlers are the page's own leave paths (the editor sends them through its
  // guard) — a crumb must never be a second, quieter way to lose an edit.
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

  // The bar's flexible column: the trail over the page's title (or its title field).
  function barMain(...kids) {
    const main = document.createElement('div');
    main.className = 'tc-bar-main';
    main.append(...kids);
    return main;
  }

  // The priority picker lives in priority-control.js, which has its own test file.
  const { buildPriorityControl } = PriorityControl;

  // The parameters grid lives in params-grid.js, which has its own test file.
  const { buildParamsControl } = ParamsGrid;

  // The read-only view of a test lives in view.js, which has its own test file.
  const { renderView } = EditorView;

  // The recording and its polish live in rec-session.js, which has its own test file.
  const { createRecSession } = RecSession;
  // The page chrome the view borrows, and the three members that read module state HERE:
  // they are handed over to be called, never copied into the module.
  const VIEW_SHELL = {
    rootEl, barMain, buildCrumbs, toTestsRoot, renderPreviewInto, paneHasContent,
    testWebUrl, projectLang: projectLangOnce, onSettings: (s) => { activeSettings = s; },
  };

  // ---- the authoring surface (create AND edit) ----------------------------
  // One screen, two modes: create POSTs into `suite` and seeds from a template; edit
  // PATCHes title/description/priority of `uid` and leaves the suite alone.
  function renderEditor({
    ctx, mode = 'create', uid = null, test = null,
    suite, title, markdown, priority, dirty: initialDirty = false,
    templates = [], templateId: initialTemplateId = null, params = null, recorded = null,
    shots = [], shotsLost = 0,
  }) {
    const editing = mode === 'edit';
    // The page this screen returns to: the test's own read-only view, minus `edit`.
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
    let previewing = false;
    // Annotated screenshots held until Save, uploaded in the order they were taken.
    const pendingShots = shots.slice(); // …starting with the ones a restored draft was holding
    let shotsRev = 0; // the strip's revision: the tracker writes the pictures only when it moves
    // The tracker owns `dirty`, the throttled write and the tab-ctx `beforeunload` guard; the
    // getters are how it reaches the controls below, which are built long after it.
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

    // Title + its inline validation line (#82), `hidden` while valid so the row grows
    // only when an error appears.
    const titleField = document.createElement('div');
    titleField.className = 'tc-title-field';

    // A textarea, not an input: the shared `.autogrow` field (components.css) wraps
    // instead of scrolling its own beginning out of sight.
    const titleInput = document.createElement('textarea');
    titleInput.id = 'tc-title';
    titleInput.className = 'textarea autogrow size-md tc-title-input';
    titleInput.rows = 1;
    titleInput.placeholder = 'Test case title';
    titleInput.value = title || '';
    titleInput.addEventListener('input', () => { clearTitleError(); onEdited(); });
    // Enter moves to the body: a title is one line of text, and a stray newline in it
    // would travel to the API.
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
    // BOTH crumbs leave through requestBack(), so the unsaved-changes guard covers them
    // exactly as it covers Back; they differ only in where the leave lands.
    bar.append(ctx === 'panel'
      ? barMain(buildCrumbs({
        onRoot: () => requestBack(toTestsRoot),
        // The suite crumb goes to the SUITE in every mode — unlike the arrow beside it,
        // which walks back one step (out of an edit, that is the test's own view).
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

    // Edit mode only (#113): a create has no test to open until it saves, so `tc-open-web`
    // is absent rather than hidden. It opens a new tab, so no leave guard is needed.
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

    // The panel's own tab bar (`.tabs.fill`, icon + label), so the switch is the one a
    // tester already knows from Tests / Runs / Settings.
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
    // The id stays `tc-tab-edit` though the label says Markdown — it is what the e2e
    // and the hotkeys address.
    const editTab = buildTab('tc-tab-edit', 'Markdown', ICON_MARKDOWN, true);
    const previewTab = buildTab('tc-tab-preview', 'Preview', ICON_PREVIEW, false);
    tabs.append(editTab, previewTab);
    wrap.append(tabs);

    // The writing tools all act on the text being written, so the row belongs to the
    // Markdown tab alone — showPreview hides it.
    const tools = document.createElement('div');
    tools.className = 'toolbar divided tc-tools';

    // Template picker (#104) on the shared `Dropdown`, not a native <select> whose OS popup
    // opens as a full-width slab; `align: 'end'` keeps a long title on the 380px panel.
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
      // Picking REPLACES the body — free while nothing has been authored, a confirm once
      // something has. (The helpers below are declared later; none runs before a click.)
      onChange: (id) => {
        const next = templateById(id);
        if (!next) return;
        // Comparing ids is NOT enough: a restored draft leaves the pick on the default
        // while the body is the tester's own, and re-picking it must still apply it.
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
    // #23: a SWITCH, not a checkbox — it writes itself on change and the recording that stops
    // next is already treated differently, so there is no Save for it to belong to.
    const polishLabel = document.createElement('label');
    polishLabel.className = 'choice tc-polish';
    const polishInput = document.createElement('input');
    polishInput.id = 'tc-polish';
    polishInput.type = 'checkbox';
    polishInput.className = 'switch';
    polishInput.setAttribute('role', 'switch');
    // The words in a SPAN, not a bare text node: the short row hides them (fitTools), and the
    // switch keeps the same name on the input either way.
    const polishText = document.createElement('span');
    polishText.className = 'tc-polish-text';
    polishText.textContent = 'Polish with AI';
    polishInput.setAttribute('aria-label', 'Polish with AI');
    polishLabel.append(polishInput, polishText);
    Tooltip.set(polishLabel, 'Rewrite the recorded steps with Testomat AI when you stop recording');
    // The same one button both ways: it polishes a recording that was not, and undoes one
    // that was. It exists only while this editor still holds a recording.
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
    // The buttons that get used over and over hold the HEAD of the row; the AI switch and the
    // template, both settings for what those buttons do, sit at its tail — one auto margin moves
    // the pair together (editor.css).
    tools.append(recBtn, recContinue, polishBtn, attachBtn, polishLabel, tmplField, shotPreview);
    wrap.append(tools);

    // The row wears its words only while they FIT: dragged narrower, the labels go and the
    // controls stand as icons rather than wrapping onto a second line. Measured, not a
    // breakpoint — how much width the row needs depends on which controls are showing.
    let toolsFitWidth = 0; // the width it was last fitted at, the observer's guard
    const fitTools = () => {
      if (!tools.clientWidth) return; // hidden on the Preview tab, and nothing to measure
      // Words back on FIRST, or a panel dragged wider would keep the short row.
      tools.classList.remove('is-short');
      const line = [recBtn, recContinue, polishBtn, attachBtn, polishLabel, tmplField]
        .filter((el) => !el.hidden && el.offsetParent);
      // Their CENTRES, not their tops: the row centres what it holds, so the switch — shorter
      // than the buttons — starts lower than they do while sitting on the same line. Reading
      // the geometry is also what forces the layout the line above just asked for.
      const mid = (el) => el.offsetTop + el.offsetHeight / 2;
      if (line.length && line.some((el) => Math.abs(mid(el) - mid(line[0])) > 1)) {
        tools.classList.add('is-short');
      }
      toolsFitWidth = tools.clientWidth;
    };
    // The observer also fires for the width the fit itself settled at, hence the guard — the
    // same shape the side panel's own rows use (sidepanel/core/views.js).
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

    // The referenced pictures (#51), a band under the text like the parameters one below it —
    // inside .tc-body it would hang off the bottom of a pane that is 100% of that box.
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

    // The parameters grid (#5), between the text and the footer: a band of its own, folded until
    // the test has something to run with. A restored draft seeds it — see loadParams below.
    const paramsCtl = buildParamsControl({ seed: params, onEdited });
    wrap.append(paramsCtl.section);

    // Cancel is the same leave Back performs, guard and all — and the only way out in the
    // tab context, which has no Back arrow.
    const footer = document.createElement('footer');
    footer.className = 'bar footer tc-footer';
    footer.dataset.tipSide = 'top'; // nothing below this row to open a tip into

    const saveBtn = document.createElement('button');
    saveBtn.id = 'tc-save';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => { save(); });

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
    // OverType fires `onChange` while it lays in the initial `value`, so dirty tracking
    // stays unarmed until the mount returns or an untouched editor opens dirty.
    let mounted = false;
    const opts = {
      toolbar: true,
      // These MUST go through the options, not a stylesheet: OverType pins its textarea and
      // its overlay to one --instance-font-* set, and sizing either alone slides the caret.
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
    // The vendored toolbar labels its buttons with the browser's own `title`, which would
    // open an OS tooltip beside ours — moved here once, right after the mount.
    Tooltip.adopt(host);

    // ---- tab toggle ----
    // The open tab is said twice: in the class the bar paints from, and in `aria-selected`.
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
      strip.hidden = !stripRow.childElementCount; // the strip belongs to this tab (#51)
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

    // ---- image strip (#51) ----
    // Rebuilding refetches every picture, so it happens only when the ORDERED set of refs
    // moved — not on the keystrokes between.
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

    // ---- template picker behaviour (#104) ----
    // "Unauthored" = blank, or byte-equal to some template we offer (the seed, or an
    // earlier pick).
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
    // The pick already moved the closed face; `setValue` is the silent path, so putting it
    // back cannot re-enter onChange.
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

    // ---- step recorder (message-driven; background owns the canonical state) --
    // The session itself is rec-session.js; what stays here is the half that touches the page —
    // the words it decides on, painted onto the two buttons and the switch.

    // The label carries only words, so textContent stays the plain sentence the e2e reads.
    // `name` must not be called `icon`: it would shadow the module's own icon() helper.
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
        // The textarea only while the caret is actually in it: an insert (#160) lands mid-typing.
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

    // ---- Attach screenshots (previews held until Save) -----------------------
    // Rebuilt whole on every change: at most MAX_SHOTS rows, and a diff would only be a
    // second place for their order to be wrong.
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
    // Focus cannot stay on a button that is gone: it lands on the next picture's remove,
    // or on the camera when the last one goes.
    function dropShot(i) {
      if (i < 0 || i >= pendingShots.length) return;
      pendingShots.splice(i, 1);
      renderShotPreview();
      markDirty();
      schedulePersist(); // the strip IS the change here — nothing else will write the draft
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
        // `needsGrant` (#101): the worker's sentence already names the fix (a toolbar
        // click), so it is shown as it stands rather than prefixed with a diagnostic.
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

    // ---- parameters: what the test already has (#5) --------------------------
    // Session-only, so basic mode drops the block whole rather than offering a grid that could not
    // be saved. Any other failure is said once and leaves an empty grid to write in.
    // BDD drops it too (#32): the body's Examples own the data — a grid write collides server-side.
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
    // …and the same probe answers whether the AI switch has a session to work with.
    loadParams().then(rec.syncPolishVisible, rec.syncPolishVisible);

    // Latching `done` is what makes a second Save (button or Cmd+S) impossible —
    // creating, that would be a duplicate TC.
    function handOverToView(id, saved) {
      done = true;
      rec.handOver();
      clearTimeout(stripTimer);
      if (closeImageLightbox) closeImageLightbox();
      ImgHydrate.release(STRIP_IMG_GROUP); // the view that takes over draws its own images (#51)
      document.removeEventListener('keydown', onEditorKey);
      const p = new URLSearchParams(location.search);
      p.delete('suite');
      p.delete('edit');
      p.set('test', id);
      history.replaceState(null, '', `?${p.toString()}`); // a reload lands on the view
      renderView({ shell: VIEW_SHELL, ctx, uid: id, ...saved });
    }

    // ---- save: writes the TC; returns its uid, or null on failure ------------
    async function save() {
      if (saving || done) return null;
      // Claim the flag before the first await (the recorder drain below is one), or a
      // second chord slips past it into a duplicate POST.
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        // A running recorder is drained FIRST — what is not in the body is not in the payload.
        if (rec.isRecording()) await rec.runExclusive(() => rec.finish());
        // …and a polish already out (Stop's, or the button's) is waited for, or Save would
        // send the raw text a moment before the answer rewrites it.
        await rec.settle();
        const description = editor.getValue();
        // A paste can bring real newlines into the wrapping field; what goes to the API
        // is one line either way.
        const t = titleInput.value.replace(/\s+/g, ' ').trim();
        const priority = priorityCtrl.getPriority();
        if (!t) { showTitleError('Title is required'); return null; }
        // The grid is judged BEFORE anything is written: a row under a nameless column would land
        // as a test nobody can read, so nothing goes out until the columns have names.
        const paramsWrite = paramsCtl.plan();
        if (!paramsWrite) return null;
        // The update deliberately omits `suite_id` — sending it would MOVE the test
        // (contract m3), and this editor changes its text, not where it lives.
        const written = editing
          ? await TestomatAPI.updateTest(uid, { title: t, description, priority })
          : await TestomatAPI.createTest({ title: t, suite_id: suite, description, priority });
        // Editing, the uid is known before the request and stays the uid whatever the
        // response echoes back.
        const id = (written && written.id) || (editing ? uid : null);
        // Best-effort: a failed upload toasts but never fails Save, and the shots that did
        // NOT land stay staged, so a second Save retries exactly them.
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
        // Same best-effort contract as the uploads: the test is saved either way, and a parameter
        // that could not be written is said in the toast instead of failing the Save.
        const paramsError = id ? await paramsCtl.commit(id, paramsWrite) : null;
        clearDirty();
        if (ctx === 'panel') removeEditorDraft(draftKey);
        // For a create, `test: {}` is not a missing record: it is the `manual` kind
        // TestType reads out of a record carrying no state flags.
        const rec = (editing && test) ? { ...test, title: t, priority } : {};
        // View first, then the toast — showToast targets the view's own element. With no
        // id back (never seen on v2) just latch `done`, so a retry can't create a copy.
        if (id) handOverToView(id, { title: t, markdown: description, priority, test: rec });
        else done = true;
        if (shotError) {
          showToast(shotFailed > 1
            ? `Saved — ${shotFailed} screenshots couldn't attach (${shotError})`
            : `Saved — the screenshot couldn't attach (${shotError})`, { error: true });
        }
        else if (paramsError) showToast(`Saved — parameters couldn't be written (${paramsError})`, { error: true });
        else showToast('Saved ✓');
        return id;
      } catch (e) {
        showToast(`Save failed: ${(e && e.message) || e}`, { error: true }); // keep full editor state
        return null;
      } finally {
        saving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }

    // ---- leave guards (the in-page dialog; tab ctx also keeps beforeunload) ----
    // The leave target is held here so the guard's own Save & leave / Discard go where the
    // leave that opened them was headed; in ctx=tab leaving closes this window.
    const toPanelHome = ctx === 'panel'
      ? () => { location.href = '../sidepanel/index.html'; }
      : () => { window.close(); };
    // …but an EDIT was opened from the test's own read-only view, in both contexts —
    // closing the tab there would throw away the test the tester came to read.
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
    // A leave while recording is intercepted ONCE: stop + insert (work is never silently
    // lost), stay in the editor. A second one leaves through the unsaved-changes dialog.
    function requestBack(to = goHome) {
      leaveTo = to;
      if (rec.isRecording()) { rec.runExclusive(() => rec.finish('Recording stopped')); return; }
      if (isDirty()) openGuard(); else navigateBack();
    }

    // Built in BOTH contexts: Cancel is an in-page leave in a tab too, and `beforeunload`
    // does not fire for the window.close() it performs.
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

    // Named + removable: the read-only view that takes over after a create must not keep
    // a live Save chord pointing at this (detached) editor.
    function onEditorKey(e) {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault(); // always on the chord — else the browser Save dialog appears
        if (!saving) save();
        return;
      }
      if (e.key !== 'Escape') return;
      // The template swap is checked first: it is the dialog that can sit on top of an
      // already-dirty editor.
      if (tmplGuard && !tmplGuard.hidden) {
        e.preventDefault(); closeTemplateGuard(); revertTemplateSelect(); return;
      }
      if (guard && !guard.hidden) { e.preventDefault(); closeGuard(); }
    }
    document.addEventListener('keydown', onEditorKey);

    // ---- e2e hooks ----
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
      setTitle: (t) => { titleInput.value = t; clearTitleError(); onEdited(); },
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
      // Stop flips `recording` at once, but its tail insert — and the polish behind it — are
      // round trips away; a reader of the body has to wait for this to clear as well.
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

    // A restored panel-ctx draft is already unsaved content (it stays in storage until
    // save/discard).
    if (initialDirty) markDirty();
    // Said now, while the shots can still be retaken — not at Save, when the test is written.
    if (shotsLost > 0) {
      showToast(shotsLost > 1
        ? `${shotsLost} staged screenshots couldn't be restored — take them again`
        : `A staged screenshot couldn't be restored — take it again`, { error: true });
    }
  }

  // ---- demo: local round-trip proof for the harness (no API) --------------
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
    // The e2e harness supplies the samples to __roundtrip; with none set the pane just
    // shows this placeholder.
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

    // A real OverType set/get cycle per sample ({ name, markdown }): it edits raw
    // markdown, so this is byte-identity for every construct.
    window.__roundtrip = async (samples) => (Array.isArray(samples) ? samples : []).map(({ name, markdown }) => {
      editor.setValue(markdown);
      return { name, input: markdown, output: editor.getValue() };
    });
  }

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    // Before every early return below: a toolbar click must not re-open the panel out from
    // under a message screen, the annotator or a half-written test (a tab never registers).
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

    // Painted BEFORE the probe's round trip (#187), and by the same call that renders the
    // result, so what arrives replaces the bars in place rather than swapping screens.
    if (cx.test) renderView({ shell: VIEW_SHELL, ctx: cx.ctx, uid: cx.test, loading: true });
    // The template seed rides along with the probe — loadTemplates swallows every failure.
    const templatesLoad = cx.suite ? loadTemplates() : null;
    // Started at boot so the language read (#35, #32) overlaps the other round trips.
    const projectLangLoad = (cx.suite || cx.test) ? projectLangOnce() : null;

    // #187 — a direct load (restored tab, bookmark) never passed the Tests tab's own gate.
    if (await readonlyGate()) { renderMessage(READONLY_BLOCK, { back: panelCtx }); return; }

    // One read serves both screens: the editor opens on the test's CURRENT text, which is
    // the same text the view would render.
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
          // An unsaved edit of THIS test outranks what the server still holds — closing
          // the side panel mid-sentence is not a discard.
          if (panelCtx) {
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
          }
          // No `templates`: a template SEEDS an unwritten body, and this one is written —
          // the picker would only offer to replace the test.
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

    // Create mode: the initial markdown is seeded from the project's default test
    // template (#104; no templates → empty body). A BDD project is the exception (#35):
    // there are no test templates there — the web app's test form hides its Use Template
    // button behind `project.isGherkin` and seeds a new body from code as `Scenario: `.
    // The server hands every project a default test template regardless, so without this
    // the picker would offer one the web never has and the body would open on a literal
    // `{{ title }}` no web user ever sees. A failed language probe reads as non-gherkin,
    // which keeps templates on offer instead of stripping them over a flaky round trip.
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
    // The restored draft is the tester's own text — it outranks the template seed.
    if (panelCtx) {
      const key = editorDraftKey({ suite: cx.suite });
      const draft = await readEditorDraft(key);
      if (draft) {
        title = draft.title || '';
        if (draft.markdown != null) markdown = draft.markdown;
        priority = draft.priority || 'normal';
        params = draft.params || null;
        // #23: the recording it was holding — the steps are already in the body, and this is
        // what still lets them be polished (or put back).
        recorded = draft.recording || null;
        ({ shots, lost: shotsLost } = await readDraftShots(draft, key));
        restoredDirty = true;
      }
    }
    renderEditor({
      ctx: cx.ctx, suite: cx.suite,
      title, markdown, priority, params, recorded, dirty: restoredDirty, shots, shotsLost,
      templates, templateId: initialTemplate ? initialTemplate.id : null,
    });
  }

  boot();
})();
