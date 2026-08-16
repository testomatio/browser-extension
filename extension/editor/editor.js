// TC Studio test page (Amendment A1) — vanilla, zero-build.
//
// A standalone extension page serving both contexts by URL:
//   ?ctx=panel|tab   panel = side-panel document (Back shown);
//                    tab   = full browser tab (panel-only chrome omitted)
//   ?test=<uid>      read-only VIEW of an existing TC (#115) — nothing on the
//                    page to type into, Edit in its header to change that
//   ?test=<uid>&edit the same TC in the editor (title, body, priority → PATCH)
//   ?suite=<uid>     create a new TC bound to that suite (the same editor)
//   ?demo=1          local round-trip proof for the e2e harness (no API)
//
// The authoring engine is vendored OverType (raw-textarea markdown, its own
// toolbar); the Preview tab AND the read-only view both render through the same
// `marked` the panel uses. It reuses the panel's `TestomatAPI` global (plain
// <script> include) — same settings from chrome.storage, same v2 endpoints,
// same ApiError kinds.
//
// State handoff is by id only (never serialized content); a Save failure keeps
// the full editor state intact (spec FR-008). A successful Save — create or
// update — hands the page over to the read-only view of the test it wrote.

/* global TestomatAPI, OverType, Md, defaultToolbarButtons, Icons, PriorityIcons, TestType, Annotate, CaptureAnnotate, ensureSiteAccess, Tooltip, EmptyState, Sk, ImgHydrate, PanelLink */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rootEl = () => $('root');

  // The object URLs this page's rendered markdown holds (shared/img-hydrate.js).
  // One group: the read-only body and the Preview tab are the same render, and
  // only one of them is ever on screen.
  const PREVIEW_IMG_GROUP = 'editor-preview';

  // Icon names for the chrome buttons (Block 6 — no unicode); the paths live in
  // shared/icons.js (Material Symbols Rounded), the same set the panel draws from.
  const ICON_BACK = 'arrow_back';
  const ICON_ERROR = 'error';            // error toast (#82)
  const ICON_OPEN_IN_NEW = 'open_in_new'; // "Open in Testomat" (#113)
  const ICON_CAMERA = 'photo_camera';    // Attach screenshot
  const ICON_CLOSE = 'close';            // drop a staged screenshot, on the picture
  const ICON_RECORD = 'fiber_manual_record'; // Record steps
  const ICON_STOP = 'stop';                  // Stop recording
  const ICON_EDIT = 'edit';              // "Edit test case", in the view's header
  // The writing tab names the LANGUAGE it writes, the way the app's own editor
  // does — so it takes the markdown mark rather than the pencil. A pencil said
  // "editable", which the tab bar of an editor did not need saying, and it is
  // the same glyph as the Edit button one screen up, where it means something
  // else entirely.
  const ICON_MARKDOWN = 'markdown';      // the Markdown tab
  const ICON_PREVIEW = 'visibility';     // the Preview tab
  const ICON_TEMPLATE = 'description';   // the template picker's own mark
  const icon = (name, size = 20) => Icons.markup(name, size);

  // The vendored toolbar ships its own SVG per button — a second icon set inside
  // a product that has exactly one (shared/icons.js, Material Symbols Rounded).
  // The buttons are handed to OverType as data, so each one's `icon` is simply
  // REPLACED by name below and nothing about the vendored file is touched
  // (Constitution II). A name missing here leaves that button's own glyph in
  // place, so a future OverType button is never drawn blank.
  // The `md_*` names are the APP's own toolbar glyphs (shared/icons.js), so this
  // row reads like the one the same tester uses in the web app.
  // THE HEADINGS ARE THE EXCEPTION, and stay Material as a set of three. Only an
  // H2 was ever supplied from the app's set, and one app glyph between two
  // Material ones is the worst of both: the three sat at visibly different sizes
  // in a row whose whole job is to look like one control repeated. Three of one
  // set beats two of one and one of the other — so the trio moves together or
  // not at all, and today it does not move.
  const TOOLBAR_ICONS = {
    bold: 'md_bold',
    italic: 'md_italic',
    code: 'md_code',
    link: 'link',              // Material — no app glyph supplied
    h1: 'format_h1',           // Material — the trio stays one set (above)
    h2: 'format_h2',           // Material — ditto (an app H2 exists, unused)
    h3: 'format_h3',           // Material — ditto
    bulletList: 'md_list_bulleted',
    orderedList: 'md_list_numbered',
    quote: 'format_quote',     // Material — no app glyph supplied
  };

  // Priority (v2 enum, verified live). Order, icons and canon
  // colors come from the shared PriorityIcons module. `normal` is the
  // create-mode default.

  // ---- URL context (the old EditorContext) --------------------------------
  function parseContext() {
    const p = new URLSearchParams(location.search);
    return {
      ctx: p.get('ctx') === 'tab' ? 'tab' : 'panel',
      test: p.get('test'),
      suite: p.get('suite'),
      // `?test=<uid>&edit` — the SAME test, opened for writing instead of
      // reading. One flag rather than a second document: the two screens share
      // this page's chrome, its markdown pipeline and its guards, and the view's
      // Edit button is the only thing that sets it.
      edit: p.get('edit') != null,
      demo: p.get('demo') != null,
    };
  }

  // ---- theme: OverType ships 'solar' (light) + 'cave' (dark); follow the OS --
  // Both of those are somebody else's palette — solar paints a heading orange on
  // cream, cave paints it violet on navy — and this editor is a screen of THIS
  // product. So the theme is kept only for the parts nothing here has an opinion
  // about, and every colour that lands on the page is overridden with the token
  // that draws the same thing everywhere else. OverType injects these as CSS
  // custom properties into this document, so `var(--…)` resolves against
  // shared/tokens.css and the whole set follows the OS light/dark switch by
  // itself — which is also why one map serves both theme names.
  //
  // The syntax colours are the one deliberate design decision in here: a heading
  // and the markers around it (`###`, `**`, the list bullet) are ACCENT — indigo,
  // the product's own — with the marker a step lighter than the text it marks, so
  // the structure of the markdown reads at a glance without competing with the
  // words. Everything else is body text.
  //
  // The WORDS take --fg-strong, not the --fg the chrome around them wears. On
  // every other screen --fg is text sitting among controls, held one step off
  // full contrast so a dense panel does not glare; here the text IS the screen —
  // it is what the tester is writing — and at that step it reads as greyed out,
  // as though the field were disabled. The chrome (the bar, the tabs, the
  // toolbar) keeps --fg and so still recedes behind the writing, which is the
  // order this screen wants.
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
    // `###`, `**`, `*` — the marks in front of the words, and the SAME indigo as
    // the words they mark. They used to be a step lighter (the accent mixed
    // toward the background), on the theory that a mark is quieter than what it
    // marks. It is not how this product prints them — the app's own markdown
    // editor sets mark and heading in one colour — and a diluted glyph does not
    // read as "secondary", it reads as one that failed to load. Nothing in this
    // extension dims TEXT to rank it. (The vendored `opacity: 0.7` on
    // `.syntax-marker` is turned off in editor.css for the same reason: half of
    // that fade was not even ours to see.)
    syntaxMarker: 'var(--accent)',
    syntax: 'var(--muted)',
    cursor: 'var(--accent)',
    // The live preview's text sits ABOVE the (invisible) textarea whose native
    // selection actually paints this, so the highlight has to stay translucent
    // (the vendored default is accent at 40% alpha) — an opaque wash like
    // --row-active blots the coloured glyphs out instead of tinting behind them.
    selection: 'color-mix(in srgb, var(--accent) 35%, transparent)',
    listMarker: 'var(--accent)',
    // `raw-line` is not some inert leftover: it is the line the CURSOR IS ON,
    // re-drawn as the raw markdown behind it (overtype.min.js: `i&&d===n`). It
    // was the one piece of text this file dimmed, which put the faintest colour
    // on the page exactly where the tester is typing. It is the words, so it
    // takes what the words take.
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

  // The order the buttons stand in, read off the Testomat app's own markdown
  // toolbar: headings first (they open the sections of a test), then the two
  // character styles, then link, then the lists, then code — and quote last,
  // which is ours alone. The vendored file's order leads with bold and buries
  // the headings in the middle; the app's leads with the thing a test case is
  // actually built out of.
  // Only the buttons WE HAVE are placed here. The app's toolbar also carries a
  // table, H4, two insert-list controls and an overflow `⋯` — those are missing
  // BUTTONS, not missing icons: OverType has no such actions, so each would have
  // to be authored (a command + a markdown transform), which is a different job
  // from ordering and re-skinning the ones that exist.
  // A name not listed sorts to the end rather than vanishing, so a button added
  // by a future OverType still appears — visibly last, which is the point.
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

  // ---- toolbar: default button set minus the dropped ones --------------------
  // Dropped: viewMode (our Preview tab is the single preview, rendered through
  // `marked`) and taskList (`- [ ]` renders as a dead checkbox outside Steps in
  // both the web UI and the run panel — owner bug report 2026-07-22, R8.1).
  // The vendored UMD tail overwrites `window.OverType` with the CLASS and puts
  // the button array in the bare global `defaultToolbarButtons` — reading
  // `OverType.defaultToolbarButtons` yields undefined (that silent-skip bug hid
  // both drops until the e2e toolbar assert caught it). Check both homes.
  function filteredToolbarButtons() {
    const all = (typeof defaultToolbarButtons !== 'undefined' && Array.isArray(defaultToolbarButtons))
      ? defaultToolbarButtons
      : (Array.isArray(OverType.defaultToolbarButtons) ? OverType.defaultToolbarButtons : null);
    if (!all) return null; // fall back to OverType's default set
    return all
      .filter((b) => b && b.name !== 'viewMode' && b.name !== 'taskList')
      // …in the ORDER the Testomat app's own markdown toolbar puts them
      // (TOOLBAR_ORDER), not the vendored file's. A tester moves between the two
      // editors all day, and reaching for bold in a different place each time is
      // the whole cost of a toolbar that is merely similar.
      .sort((a, b) => orderOf(a.name) - orderOf(b.name))
      // …and re-iconed from the shared set. A COPY per button (the array is the
      // vendored module's own, and mutating it would re-skin every OverType on
      // the page, demo included); `name` is untouched, since it is what the
      // toolbar writes as `data-button` and what the e2e reads back.
      .map((b) => {
        const glyph = TOOLBAR_ICONS[b.name] && Icons.markup(TOOLBAR_ICONS[b.name], 20);
        return glyph ? { ...b, icon: glyph } : b;
      });
  }

  // ---- markdown preview: the panel's renderer, not a second one (shared/markdown.js)
  function renderPreviewInto(box, md) {
    // ONE renderer for the whole extension (shared/markdown.js): marked + the
    // sanitize pass live in there, so the Preview tab and the panel cannot drift.
    const tmp = Md.render(md);
    // …and the same image swap (#205): the CSP allows no remote <img>, so the
    // bytes are fetched and handed over as a blob: URL. Released FIRST — this
    // runs on every keystroke while the Preview tab is up, and the body about to
    // be dropped owns the last batch.
    ImgHydrate.release(PREVIEW_IMG_GROUP);
    ImgHydrate.hydrate(PREVIEW_IMG_GROUP, tmp); // detached: the raw src never reaches the document
    box.replaceChildren(...tmp.childNodes);
  }

  // Did the rendered body actually PUT anything on the page? A description can
  // be non-empty and still draw nothing — a lone HTML comment, or markup the
  // sanitizer takes out whole — and what is left then is a blank pane with
  // nothing to tell it apart from a failed load. So the "there is nothing here"
  // is decided by what the pane ended up with, not by the string it started
  // from. Text is the usual answer; a body that is only an image, a rule or a
  // table is still a body, so those count as content too.
  function paneHasContent(box) {
    return box.textContent.trim() !== ''
      || !!box.querySelector('img, svg, video, iframe, canvas, table, hr, input');
  }

  // ---- recorded-step insertion (step recorder) ----------------------------
  // Merge recorded lines into the `### Steps` (ordered) / `### Expected` (bullet)
  // sections of the current markdown, continuing any existing numbered/bulleted
  // items and dropping the template's empty placeholders. A missing section is
  // appended. Non-list lines inside a target section are not preserved (recorded
  // sections are lists) — acceptable for the template-seeded body.
  //
  // An item is `{text, subs}` — `subs` are the nested lines that belong to it
  // (`- Expected: …`, #78). They are parsed back out of the existing markdown too,
  // so re-recording into the same test never flattens a step's expected result.
  //
  // Since #160 this runs per recorded action, not once at Stop: the merge re-reads
  // the body every time, which is what makes a one-entry append behave like a batch.
  function fmtItems(items, ordered) {
    const out = [];
    items.forEach((it, i) => {
      const marker = ordered ? `${i + 1}.` : '-';
      out.push(`${marker} ${it.text}`);
      // Indent to THIS item's content column, or the sub-list starts a new top-level
      // list instead of nesting (`10.` needs one space more than `9.`).
      const pad = ' '.repeat(marker.length + 1);
      (it.subs || []).forEach((s) => out.push(`${pad}- ${s}`));
    });
    return out;
  }

  // The section as it stands: its bounds and the `{text, subs}` items parsed back
  // out of it. `hIdx === -1` = the test has no such heading yet.
  function sectionSlice(md, heading, ordered) {
    const lines = md.split('\n');
    const hRe = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'i');
    const hIdx = lines.findIndex((l) => hRe.test(l));
    if (hIdx === -1) return { lines, hIdx, end: -1, existing: [] };
    let end = lines.length;
    for (let i = hIdx + 1; i < lines.length; i++) { if (/^#{1,6}\s+\S/.test(lines[i])) { end = i; break; } }
    const itemRe = ordered ? /^\s*\d+\.\s+(.*\S.*)$/ : /^\s*[-*]\s+(.*\S.*)$/;
    const subRe = /^\s{2,}[-*]\s+(.*\S.*)$/; // indented bullet = a sub-line of the item above
    const existing = [];
    for (const l of lines.slice(hIdx + 1, end)) {
      const sub = l.match(subRe);
      if (sub && existing.length) { existing[existing.length - 1].subs.push(sub[1]); continue; }
      const m = l.match(itemRe);
      if (m) existing.push({ text: m[1], subs: [] });
    }
    return { lines, hIdx, end, existing };
  }

  const sectionHasItems = (md, heading, ordered) => sectionSlice(md, heading, ordered).existing.length > 0;

  // `leadSubs` (#160) belong to the LAST item already in the section: live
  // insertion delivers an expected result after the step it followed is in the body.
  function mergeSection(md, heading, items, ordered, leadSubs = []) {
    const { lines, hIdx, end, existing } = sectionSlice(md, heading, ordered);
    const fmt = (arr) => fmtItems(arr, ordered);
    if (hIdx === -1) {
      const block = [`### ${heading}`, '', ...fmt(items)];
      return `${md.replace(/\s+$/, '')}\n\n${block.join('\n')}`;
    }
    if (leadSubs.length && existing.length) existing[existing.length - 1].subs.push(...leadSubs);
    const rebuilt = ['', ...fmt([...existing, ...items])];
    const merged = [...lines.slice(0, hIdx + 1), ...rebuilt, '', ...lines.slice(end)];
    return merged.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }

  // Split the delivered entries in RECORDING ORDER (#78). An expected result belongs
  // to the step it followed, as the `- Expected: …` sub-bullet the panel renders
  // inline next to that step (sidepanel/screens/test-view.js `extractExpected`) —
  // the tester's own (typed on the indicator) and the automatic navigation ones
  // alike (#91: a flat section listed the same page title twice when the recording
  // legitimately passed it twice, and read as a duplicate). The flat
  // `### Expected` section is left for what has no step to attach to: an expected
  // recorded before the first step. Since #160 the entries arrive one at a time, so
  // "its step" is usually already in the body — `attachToPrior` says so, and those
  // leading expecteds become `leadSubs` of the last item instead of a flat entry.
  function splitRecorded(entries, attachToPrior) {
    const steps = [];
    const expected = [];
    const leadSubs = [];
    for (const e of entries) {
      const text = (e && e.text) || '';
      if (!text) continue;
      if (e.kind !== 'expected') { steps.push({ text, subs: [] }); continue; }
      if (steps.length) steps[steps.length - 1].subs.push(`Expected: ${text}`);
      else if (attachToPrior) leadSubs.push(`Expected: ${text}`);
      else expected.push(text);
    }
    return { steps, expected, leadSubs };
  }

  function insertRecorded(md, { steps, expected, leadSubs }) {
    let out = md;
    if (steps.length || leadSubs.length) out = mergeSection(out, 'Steps', steps, true, leadSubs);
    if (expected.length) out = mergeSection(out, 'Expected', expected.map((t) => ({ text: t, subs: [] })), false);
    return out;
  }

  // ---- toast (bottom, auto-hides) -----------------------------------------
  // `{ error: true }` renders the product's error notify (custom-notify.scss
  // `.error.alert`: red-tinted card + an alert icon) and escalates the live region
  // to `alert` so a reader interrupts instead of queueing — the same contract the
  // panel toast follows (#72/#81). Neutral toasts are unchanged.
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
      // `mark`, not `icon`: a local named `icon` shadows the icon() helper this
      // line calls, and every error toast on this page threw instead of showing.
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

  // ---- panel-ctx unsaved-edit persistence (data-loss guard) ----------------
  // In `tab` ctx a `beforeunload` handler guards navigation. The side panel is
  // our OWN document, though: closing it tears the page down WITHOUT a native
  // unload prompt (beforeunload can't show a dialog in a side panel and does not
  // fire reliably on panel close), so a `beforeunload` guard would silently drop
  // the edit. We therefore persist the dirty draft (title + content + priority)
  // to chrome.storage.session on input (throttled) and restore it when the
  // editor reopens on the same thing — mirroring the session-image handoff the
  // capture flow uses (shared/capture-annotate.js).
  // One draft per THING being written: a new test belongs to the suite it will
  // land in, an edit to the test it is changing. Keyed apart so an unsaved edit
  // of an existing case can never be restored into the new-test editor of its
  // suite (same screen, entirely different text).
  const editorDraftKey = ({ suite, test }) => (test
    ? `editorDraft:test:${test}`
    : `editorDraft:suite:${suite}`);
  function hasSession() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;
  }
  async function readEditorDraft(key) {
    if (!hasSession()) return null;
    try { const o = await chrome.storage.session.get(key); return (o && o[key]) || null; } catch { return null; }
  }
  function removeEditorDraft(key) {
    if (!hasSession()) return;
    try { chrome.storage.session.remove(key); } catch { /* best effort */ }
  }

  // ---- config: same settings the panel persists --------------------------
  // The page boots per open, so this is always the ACTIVE instance + project
  // (per-host settings / the #103 switcher) — kept for the web link below, which
  // must never carry a hardcoded host or slug.
  //
  // Returns `true`, or the sentence the message screen should carry — because
  // there are now two ways to have no settings and they are not the same news.
  // `chrome.storage` is GONE from under a page whose extension was reloaded or
  // updated while it was open (the dev loop; an auto-update in the field): the API
  // object is torn down, and reading `.local` off it threw a TypeError nothing
  // caught, which left this page blank with no way to tell what had happened. The
  // page cannot recover — it has to be opened again — so it says so.
  let activeSettings = null;
  const NEED_SETUP = 'Not configured — open the panel settings first.';
  // How many screenshots one unsaved test may hold. Each is a full JPEG living in
  // this page's memory until Save, and the row they sit in is 380px wide.
  const MAX_SHOTS = 10;
  const RELOADED = 'This page lost its link to the extension (it was reloaded or updated). Close it and open the test again.';
  function hasLocal() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }
  async function ensureConfigured() {
    if (!hasLocal()) return RELOADED;
    let settings = null;
    try { ({ settings } = await chrome.storage.local.get('settings')); } catch { return RELOADED; }
    if (!settings || !settings.baseUrl || !settings.apiToken || !settings.projectId) return NEED_SETUP;
    activeSettings = settings;
    TestomatAPI.configure(settings);
    return true;
  }

  // ---- read-only access probe (#155/#187) ---------------------------------
  // The panel's readonlyGate, on the client's own tri-state: this document has no panel `state`.
  const READONLY_BLOCK = 'Your access to this project is read-only — the panel can’t author tests here. '
    + 'Pick another project in the panel settings, or ask a project owner for access that can write.';

  async function readonlyGate() {
    if (TestomatAPI.readonlyAccess() === 'unknown') await TestomatAPI.validate().catch(() => null);
    return TestomatAPI.readonlyAccess() === true;
  }

  // ---- the web URL of a test (#113) ---------------------------------------
  // Verified against the product, not guessed from the issue: Rails
  // `Test#to_url` builds `/projects/<slug>/test/<public_uid>`
  // (testomatio/app/models/test.rb:479) and the Ember route `suites.test` maps
  // exactly that path (testomatio-front/app/router.js:38, under the
  // `/projects/<slug>/` rootURL of lines 10-13) — singular `test`, and the
  // PUBLIC UID, which is also the id v2 serializes (`basic_serializable.rb:13`)
  // and therefore the very id the panel already holds. Both halves come from the
  // active settings; either one missing means there is nothing to link to.
  function testWebUrl(uid, s = activeSettings) {
    if (!uid || !s || !s.baseUrl || !s.projectId) return null;
    const base = String(s.baseUrl).replace(/\/+$/, '');
    return `${base}/projects/${encodeURIComponent(s.projectId)}/test/${encodeURIComponent(uid)}`;
  }

  // ---- project templates (#104) -------------------------------------------
  // The "New Test" templates of the CURRENT project, read fresh on every create
  // open — the editor is its own document, booted per open from the settings in
  // storage, so a project switch (#103) can never serve the previous project's
  // templates (there is nothing cached to go stale).
  //
  // Best-effort by contract: an empty list or ANY failure (no session, offline,
  // no permission) falls back to an empty body — never a blocking error.
  async function loadTemplates() {
    try {
      const list = await TestomatAPI.listTemplates('test');
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  // The project's default (`is_default`) is what a new test starts from; with
  // none flagged, the first template — with no templates at all, an empty body.
  const pickDefaultTemplate = (list) => list.find((t) => t.isDefault) || list[0] || null;

  // One grey bar (shared/skeleton.js), marked away from screen readers: the
  // sentence they get is on the heading that holds it, see renderView().
  function skBar(cls, w) {
    const b = Sk.bar(cls, w);
    b.setAttribute('aria-hidden', 'true');
    return b;
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
  // This page IS the deepest step of the panel's Tests path — Tests / ‹suite› /
  // ‹the test›. The panel folds its tabs away for a drill-down and names the
  // path in its header instead; the page it hands over to has to say the same
  // thing in the same shape, or falling through into a document of its own is
  // where the tester loses the thread. The title beside the trail is the last
  // crumb (in create mode, the title FIELD is), so the trail stops at the suite.
  //
  // Where the suite comes from: the one-shot `tcReturn` openEditor() left in
  // sessionStorage — READ here, never consumed, because the panel's boot needs
  // it to land back on that suite's list. Absent (an old session, a direct URL),
  // the trail is just Tests and still works.
  // In ctx=tab there is no panel to go back to, so there is no trail at all.
  function tcReturn() {
    try { return JSON.parse(sessionStorage.getItem('tcReturn') || 'null'); } catch { return null; }
  }

  // Dropping the return breadcrumb is what makes the panel land on the TC tree
  // rather than on the suite this page came from.
  function toTestsRoot() {
    try { sessionStorage.removeItem('tcReturn'); } catch { /* best effort */ }
    location.href = '../sidepanel/index.html';
  }

  // Both handlers are the PAGE's own leave paths (the read-only view walks
  // straight out; the editor sends each of them through its unsaved-changes
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

  // The bar's flexible column: the trail over the page's title (or its title
  // field), so the header reads top-down as path → thing, with Back keeping its
  // place at the head of the row.
  function barMain(...kids) {
    const main = document.createElement('div');
    main.className = 'tc-bar-main';
    main.append(...kids);
    return main;
  }

  // ---- priority dropdown (custom listbox; <option> can't render SVG) ------
  // Returns { wrap, getPriority, setPriority }. `onChange` fires on every value
  // change (used to mark the editor dirty). Backed by the button's
  // dataset.priority — the save path reads it and getPriority() returns it.
  function buildPriorityControl(initial, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'tc-priority-wrap';

    const btn = document.createElement('button');
    btn.id = 'tc-priority';
    btn.type = 'button';
    btn.className = 'btn tc-priority size-sm';
    Tooltip.set(btn, 'Priority');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('ul');
    menu.id = 'tc-priority-menu';
    menu.className = 'menu tc-priority-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;

    const opts = new Map();
    for (const p of PriorityIcons.ORDER) {
      const li = document.createElement('li');
      li.className = 'menu-option';
      li.id = `tc-priority-opt-${p}`;
      li.setAttribute('role', 'option');
      li.dataset.priority = p;
      li.innerHTML = `${PriorityIcons.svg(p)}<span class="tc-priority-label">${p}</span>`;
      li.addEventListener('click', () => selectPriority(p));
      menu.append(li);
      opts.set(p, li);
    }

    let current = PriorityIcons.ORDER.includes(initial) ? initial : 'normal';
    let active = current;

    function renderButton() {
      btn.dataset.priority = current;
      // The closed face reads as a select — same surface as the template
      // picker beside it — so it carries a select's caret too, even though
      // what opens under it is the custom listbox native <option> can't draw
      // the priority icons in.
      btn.innerHTML = `${PriorityIcons.svg(current, 16)}<span class="tc-priority-label">${current}</span>${Icons.markup('keyboard_arrow_down', 16, { cls: 'tc-priority-caret' })}`;
    }

    function setActive(p) {
      active = p;
      for (const [pp, li] of opts) {
        li.classList.toggle('active', pp === p);
        li.setAttribute('aria-selected', pp === p ? 'true' : 'false');
      }
      btn.setAttribute('aria-activedescendant', opts.get(p).id);
    }

    function onDocClick(e) { if (!wrap.contains(e.target)) closeMenu(); }

    // Open-state keys handled at document level (capture) so Esc / arrows work
    // regardless of which element holds focus.
    function onDocKey(e) {
      if (menu.hidden) return;
      const key = e.key;
      if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ focus: true }); return; }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        const order = PriorityIcons.ORDER;
        const i = order.indexOf(active);
        setActive(key === 'ArrowDown' ? order[Math.min(i + 1, order.length - 1)] : order[Math.max(i - 1, 0)]);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') { e.preventDefault(); selectPriority(active); }
    }

    function openMenu() {
      if (!menu.hidden) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      setActive(current);
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }
    function closeMenu({ focus = false } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      if (focus) btn.focus();
    }

    // User pick (click / Enter-Space): mirrors a <select> change — fires only
    // when the value actually changes.
    function selectPriority(p) {
      const changed = p !== current;
      current = p;
      renderButton();
      closeMenu({ focus: true });
      if (changed) onChange && onChange();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });

    // Closed-state keys open the menu; open-state keys are handled by onDocKey.
    btn.addEventListener('keydown', (e) => {
      if (!menu.hidden) return;
      const key = e.key;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        openMenu();
      }
    });

    wrap.append(btn, menu);
    renderButton();

    return {
      wrap,
      getPriority: () => btn.dataset.priority,
      // Programmatic set (e2e / edit preselect): always marks dirty, like the
      // old __tc.setPriority; never opens the menu.
      setPriority: (p) => {
        if (!PriorityIcons.ORDER.includes(p)) return;
        current = p;
        renderButton();
        onChange && onChange();
      },
    };
  }

  // ---- the read-only view of an existing TC (#115) -------------------------
  // What a test SAYS, with nothing to fill in: rendered markdown through the
  // SAME marked+sanitize path as the editor's Preview tab — no OverType, no
  // Save, no priority dropdown, no recorder/screenshot tools. Writing is one
  // button away (Edit, in the header) rather than absent; this stays the screen
  // a test is read on, and the one a create and an update both land back on.
  //
  // `loading` draws this same screen with the two things that are still on the
  // wire — the title and the body — replaced by grey bars, and that is the whole
  // difference. It used to be a `notice` box reading "Loading test case…" in the
  // middle of an otherwise blank page: a screen that is not this one, thrown away
  // whole the moment the fetch lands. Everything ELSE on this page is already
  // known before the request goes out — the Back button, the trail, the header,
  // "Open in Testomat" (a URL built from the uid and the settings) — so it is
  // drawn for real straight away, and only what is genuinely absent is grey.
  //
  // No arming delay here, unlike the panel's placeholders (DELAY_MS in
  // sidepanel/core/skeleton.js): those guard against a flash of grey on a warm
  // tab, and this page has no warm path — it is a fresh document whose one fetch
  // is always a cold round trip, with nothing on screen to flash between.
  function renderView({ ctx, uid, title, markdown, priority, test, loading = false }) {
    const host = rootEl();
    host.replaceChildren();
    if (title) document.title = title; // names the browser tab in ctx=tab

    const wrap = document.createElement('div');
    wrap.className = 'tc-editor tc-view';

    const bar = document.createElement('header');
    bar.className = 'bar sticky tc-bar';
    bar.dataset.tipSide = 'bottom'; // every tip in this row opens over the view
    // Nothing to lose on this screen — no dirty state, so no guard dialog.
    const leave = () => { location.href = '../sidepanel/index.html'; };
    if (ctx === 'panel') {
      const backBtn = document.createElement('button');
      backBtn.id = 'tc-back';
      backBtn.className = 'icon-btn';
      Tooltip.set(backBtn, 'Back to suite');
      backBtn.setAttribute('aria-label', 'Back to suite');
      backBtn.innerHTML = icon(ICON_BACK);
      backBtn.addEventListener('click', leave);
      bar.append(backBtn);
    }

    const h = document.createElement('h1');
    h.id = 'tc-view-title';
    // The shared headline (size/face/weight) + what this bar adds to it.
    h.className = 'context-title tc-view-title';
    // The test's own MARKS before its name, in the order every row naming a test
    // opens with (core/views.js contextTitleMarks): how much it MATTERS, then
    // what it IS. Priority used to be a labelled chip at the far end of this row
    // — a second place to look for one of the two facts the title already
    // carries — and the type mark stood alone in front of the name; they are one
    // pair, so they are drawn as one.
    if (loading) {
      // The bars are silent to a screen reader (they say nothing a reader can
      // use), so the heading keeps the sentence the notice box used to carry.
      h.setAttribute('aria-label', 'Loading test case…');
      // …and the priority keeps its BOX while the read is out (the panel's own
      // trick, testPriorityMark): a mark that appeared afterwards would step the
      // whole title 24px sideways the moment the test landed.
      //
      // The two stand in ONE ROW, the way every placeholder in the panel's lists
      // does — a disc, then the bar for the name beside it. A row is what it
      // takes: `.skeleton` is a block (it has to be, it is a shape and not a
      // word), so a bar appended straight after the mark box dropped onto a line
      // of its own and the header opened as two grey lines stacked where the
      // title goes.
      const row = document.createElement('span');
      row.className = 'tc-view-title-sk';
      const slot = document.createElement('span');
      slot.className = 'prio';
      slot.append(skBar('circle'));
      row.append(slot, skBar('line', '58%'));
      h.append(row);
    } else {
      // An absent or unknown priority IS `normal` — the builder's own fallback,
      // and the priority the test actually runs at (shared/priority-icons.js).
      const prioMark = PriorityIcons.mark(priority);
      if (prioMark) { prioMark.id = 'tc-view-priority'; h.append(prioMark); }
      // Its custom emoji if the project gave it one, else the type-of-test
      // square the panel's lists open a test row with. The header of a
      // drill-down says what it is looking at with the same symbol the row it
      // was opened from used (shared/components.css: `.context-title >
      // .type-mark`). Absent record → just the name.
      const mark = test && typeof TestType !== 'undefined'
        ? (Icons.emoji(test.emoji, 'type-mark') || TestType.forRecord(test))
        : null;
      if (mark) h.append(mark);
      h.append(title || '(untitled)');
    }
    // Tests / ‹suite› over the test's own name — the same header the panel draws
    // one step up. In ctx=tab there is no panel to walk back into, so the title
    // stands alone.
    bar.append(ctx === 'panel'
      ? barMain(buildCrumbs({ onRoot: toTestsRoot, onSuite: leave }), h)
      : h);

    // Edit — the one thing this screen is missing, and the reason the row still
    // has an end to hang a control on now the priority moved into the title.
    // It re-opens THIS page with `&edit`, so the editor keeps the uid, the trail
    // and the tab it was opened in; Back out of it lands here again.
    // Drawn while `loading` too: it is a link to a page whose address is already
    // known from the uid in the URL, exactly like "Open in Testomat" beside it.
    const editBtn = document.createElement('button');
    editBtn.id = 'tc-edit';
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    Tooltip.set(editBtn, 'Edit test case');
    editBtn.setAttribute('aria-label', 'Edit test case');
    editBtn.innerHTML = icon(ICON_EDIT);
    editBtn.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('test', uid);
      q.delete('suite');
      q.set('edit', '1');
      location.href = `?${q.toString()}`;
    });
    bar.append(editBtn);

    // "Open in Testomat ↗" (#113): the same test on its own page in the web app,
    // where everything this editor does not do lives — an ANCHOR wearing the
    // icon-button skin (the #118 "New run ↗" precedent), opening a new tab. The
    // href is rebuilt from the active settings, and with nothing to link to it
    // hides rather than point at a 404.
    const openLink = document.createElement('a');
    openLink.id = 'tc-open-web';
    openLink.className = 'icon-btn tc-open-web';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    Tooltip.set(openLink, 'Open in Testomat');
    openLink.setAttribute('aria-label', 'Open in Testomat');
    openLink.innerHTML = icon(ICON_OPEN_IN_NEW);
    bar.append(openLink);
    const refreshWebLink = () => {
      const url = testWebUrl(uid);
      if (url) { openLink.href = url; openLink.hidden = false; }
      else { openLink.removeAttribute('href'); openLink.hidden = true; }
    };
    refreshWebLink();

    wrap.append(bar);

    const body = document.createElement('div');
    body.className = 'tc-body';
    const pane = document.createElement('div');
    // The id is what the e2e harness reads the rendered steps out of, so it goes
    // on the pane that HAS them — a placeholder answering to it would be an
    // empty body that passed for a loaded one.
    if (!loading) pane.id = 'tc-view-body';
    // `skeleton-rows` only while loading: it walks the pulse down the paragraph
    // groups so the body breathes as three blocks rather than as one grey slab.
    // `sections` is the OTHER reading of rendered markdown (shared/components.css):
    // a test body's `### Steps` / `### Expected` are its sections, set as muted
    // labels — not chapters printed larger than the title of the test above them.
    // The panel prints the same body the same way (#test-steps).
    pane.className = loading
      ? 'tc-preview-pane markdown sections skeleton-rows'
      : 'tc-preview-pane markdown sections';
    if (loading) {
      // Three paragraphs' worth: a test's steps run down the page, and a
      // placeholder that stops after four lines draws a horizon the real body
      // does not have.
      pane.setAttribute('aria-hidden', 'true');
      pane.append(Sk.lines(), Sk.lines(['92%', '76%', '84%']), Sk.lines(['88%', '94%', '58%']));
    } else {
      renderPreviewInto(pane, markdown);
      // A test with no body is a whole page of nothing, so it gets the block
      // empty state rather than the muted line it used to. The way out is the
      // header's own Edit button, which the sentence points at instead of
      // drawing a second control for it.
      // Asked of the rendered pane rather than of the markdown: a body that
      // renders away to nothing leaves the same empty page as no body at all.
      if (!paneHasContent(pane)) {
        pane.replaceChildren(EmptyState.build({
          className: 'tc-view-empty',
          icon: 'description',
          title: 'No description yet',
          text: 'This test case has no steps or description written for it. Edit it to write one.',
        }));
      }
    }
    body.append(pane);
    wrap.append(body);

    // (No "Read-only — edit this test in Testomat" strip any more: it was a line
    // of chrome across the foot of every test saying what the Edit button in the
    // header now DOES, and it stopped being true the moment that button shipped.)

    const toast = document.createElement('div');
    toast.id = 'tc-toast';
    toast.className = 'toast tc-toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    wrap.append(toast);

    host.append(wrap);

    // A placeholder is not a loaded page: `__tc.ready` is what the e2e harness
    // waits on, and setting it here would hand the tests a view with no title,
    // no markdown and no priority to read.
    if (loading) { wrap.setAttribute('aria-busy', 'true'); return; }

    // e2e hooks — same global as the create editor, distinguished by mode().
    window.__tc = {
      ready: true,
      ctx,
      mode: () => 'view',
      uid: () => uid,
      getTitle: () => title,
      getMarkdown: () => markdown,
      getPriority: () => priority,
      webUrl: () => testWebUrl(uid),
      // e2e hook (35-open-in-testomat): repoint the page at another instance /
      // project the way a settings change would, and re-render the link — the
      // only way to prove the href is settings-driven without a second instance.
      applySettings: (s) => { activeSettings = s; refreshWebLink(); },
    };
  }

  // ---- the authoring surface (create AND edit) ----------------------------
  // ONE screen, two jobs, told apart by `mode`:
  //   create — bound to a `suite`, POSTs a new test into it, seeds its body from
  //            the project's template, and has no uid until it saves;
  //   edit   — bound to an existing `uid`, PATCHes the three fields it owns
  //            (title, description, priority) and leaves the suite alone.
  // Everything between those two ends is the same object — the same title field,
  // the same OverType, the same recorder, the same unsaved-changes guard — so the
  // difference is carried in four places (the draft key, the save call, where a
  // bare leave lands, and the template picker being create-only) rather than in a
  // second copy of an 800-line screen.
  function renderEditor({
    ctx, mode = 'create', uid = null, test = null,
    suite, title, markdown, priority, dirty: initialDirty = false,
    templates = [], templateId: initialTemplateId = null,
  }) {
    const editing = mode === 'edit';
    // The page this screen was entered from and returns to: the test's own
    // read-only view, same uid, same ctx, minus the flag that opened the editor.
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
    let dirty = false;
    let previewing = false;
    // Annotated screenshots held until Save, then uploaded in the order they
    // were taken. A test case is a sequence of steps, and a bug is rarely one
    // picture — the camera appends, it does not replace what is already there.
    const pendingShots = [];
    let recording = false;   // step recorder active for this editor
    let recPollTimer = null;
    let recEnding = false;   // guards the drain against a poll/stop race
    let recStopping = false; // a Stop is running: its tail is not in the body yet
    let recBlind = false;    // recorder lost host access to the recorded tab (see REC_BLIND)
    let recManualPause = false; // tester paused it from the on-page indicator (#71)
    let recStepInserted = false; // a step of THIS recording is already in the body (#160)
    let recAnyInserted = false;  // …anything at all, so Stop knows it recorded something

    // Dirty tracking is centralized so the tab-ctx `beforeunload` guard can
    // mirror it — registered only while dirty, removed on save/discard. Panel
    // ctx has no reliable unload prompt, so it persists the draft to
    // storage.session instead (see the panel-ctx persistence note above); a
    // saved/discarded draft is cleared here so it never resurrects on reopen.
    const beforeUnloadHandler = (e) => { e.preventDefault(); e.returnValue = ''; };
    function markDirty() {
      if (dirty) return;
      dirty = true;
      if (ctx === 'tab') window.addEventListener('beforeunload', beforeUnloadHandler);
    }
    function clearDirty() {
      if (!dirty) return;
      dirty = false;
      // Kill any scheduled persist too, or a throttled write still in flight
      // re-creates the draft milliseconds after this removed it.
      clearTimeout(persistTimer);
      if (ctx === 'tab') window.removeEventListener('beforeunload', beforeUnloadHandler);
      if (ctx === 'panel') removeEditorDraft(draftKey);
    }

    // Panel-ctx only: throttled persist of the live draft to storage.session so
    // closing the side panel mid-edit never loses the unsaved content.
    let persistTimer = null;
    function persistDraftNow() {
      if (ctx !== 'panel' || !hasSession()) return;
      const draft = {
        title: titleInput.value,
        markdown: editor.getValue(),
        priority: priorityCtrl.getPriority(),
        suite: suite || null, test: uid || null, ts: Date.now(),
      };
      try { chrome.storage.session.set({ [draftKey]: draft }); } catch { /* best effort */ }
    }
    function schedulePersist() {
      if (ctx !== 'panel') return;
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistDraftNow, 400);
    }
    // A user edit marks the page dirty AND (panel ctx) schedules a persist.
    function onEdited() { markDirty(); schedulePersist(); }

    const host = rootEl();
    host.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'tc-editor';

    // header bar
    const bar = document.createElement('header');
    bar.className = 'bar sticky tc-bar';
    bar.dataset.tipSide = 'bottom'; // …the same, one row down the ladder

    if (ctx === 'panel') {
      // The arrow names what is BEHIND this screen, and that differs by mode: a
      // new test is being written into a suite, an edit was opened from the test
      // it is changing.
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

    // Title + its inline validation line (#82). The field sits in a column wrapper
    // so the message lands directly UNDER the input instead of overlapping the
    // Edit/Preview tabs; it is `hidden` while valid, so the row grows once when an
    // error appears (no permanently reserved gap on the common, valid path).
    //
    // It gets a ROW OF ITS OWN under the bar, and the full width of it. A test's
    // title is the longest single value on this page and it used to be squeezed
    // between the Back arrow and two buttons, which left it about half the panel
    // to say a whole sentence in — the header row keeps the things that are one
    // word wide (the way back, the trail, the priority) and the field keeps the
    // width.
    const titleField = document.createElement('div');
    titleField.className = 'tc-title-field';

    // A TEXTAREA, not an input: the shared `.autogrow` field (components.css) —
    // one control-height line that takes a second line when the sentence needs
    // one, instead of scrolling its own beginning out of sight. Enter is not a
    // newline (a title is one line of text, however it wraps): it moves on to the
    // body, the way Tab would out of a form field.
    const titleInput = document.createElement('textarea');
    titleInput.id = 'tc-title';
    titleInput.className = 'textarea autogrow size-md tc-title-input';
    titleInput.rows = 1;
    titleInput.placeholder = 'Test case title';
    titleInput.value = title || '';
    titleInput.addEventListener('input', () => { clearTitleError(); onEdited(); });
    // Enter leaves the title for the body it belongs to — the field WRAPS, but a
    // title is one line of text and a stray newline in it would travel to the
    // API. (Save normalises whatever a paste brings in, below.)
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
    // Tests / ‹suite› over the field the new test is being named in — the trail
    // the panel would be drawing if this screen had not moved into its own
    // document. BOTH crumbs leave through requestBack(), so the unsaved-changes
    // guard covers them exactly as it covers Back; they differ only in where the
    // leave lands. In ctx=tab there is no panel to walk back into and so no
    // trail: the flexible column is then just the space that pushes the priority
    // control to the end of the row.
    bar.append(ctx === 'panel'
      ? barMain(buildCrumbs({
        onRoot: () => requestBack(toTestsRoot),
        // The suite crumb goes to the SUITE, in every mode — unlike the arrow
        // beside it, which walks back one step (out of an edit, that is the
        // test's own view, which is not what this word says).
        onSuite: () => requestBack(toPanelHome),
      }))
      : Object.assign(document.createElement('span'), { className: 'bar-spacer' }));

    // Field-level error: the red ring + the message + focus land where the fix is,
    // which a bottom-of-page toast never did.
    function showTitleError(msg) {
      titleError.hidden = false; // unhide first: a hidden live region is not announced
      titleError.textContent = msg;
      titleInput.setAttribute('aria-invalid', 'true'); // also drives the red ring (editor.css)
      titleInput.setAttribute('aria-describedby', 'tc-title-error');
      titleInput.focus();
    }
    // Cleared by the FIRST keystroke — the tester should not have to re-Save to
    // learn the field is fine again.
    function clearTitleError() {
      if (titleError.hidden) return;
      titleError.hidden = true;
      titleError.textContent = '';
      titleInput.removeAttribute('aria-invalid');
      titleInput.removeAttribute('aria-describedby');
    }

    // The header's one remaining control: the priority dropdown — compact,
    // wearing the shared .btn skin; icon-only at 400px (the menu keeps its
    // labels). Defaults to normal; a change marks dirty (009).
    // Save left this row for the page's footer (see below), which is where a form
    // is committed: the tester writes down the page and the way to commit is
    // where the writing ends, not back up at the top of it.
    const priorityCtrl = buildPriorityControl(priority, onEdited);
    bar.append(priorityCtrl.wrap);

    // "Open in Testomat ↗" — the same anchor the read-only view ends its header
    // with (#113), on the same test, so walking into the editor does not lose
    // the way out to the web app. EDIT MODE ONLY: a create has no test to open
    // until it saves, and a link to a page that does not exist yet is worse than
    // no link (which is why `tc-open-web` is absent, not hidden, while creating).
    // It opens a new tab, so it takes an unsaved edit nowhere — no guard.
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
      // Built from the active settings, and with nothing to link to it hides
      // rather than point at a 404 — the view's own rule.
      if (url) openLink.href = url; else openLink.hidden = true;
      bar.append(openLink);
    }
    wrap.append(bar);

    // The title's own row, full width, directly under the bar.
    const titleRow = document.createElement('div');
    titleRow.className = 'tc-title-row';
    titleRow.append(titleField);
    wrap.append(titleRow);

    // Edit / Preview — the PANEL's tab bar (`.tabs.fill`, icon + label), not the
    // folder tabs this page used to draw. It is the same kind of switch the panel
    // makes at its top (Tests / Runs / Settings): two halves of one screen, named
    // and marked with a rule under the open one, so a tester walking from the
    // panel into this document meets the switcher they already know.
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
    // "Markdown", not "Edit": the pair names what each half SHOWS you — the
    // source, or the rendered article — which is the same pair, in the same
    // words, the app's own test editor puts at the top of this screen. "Edit"
    // named the mode instead, and sat opposite a tab that named a view.
    // (The id stays `tc-tab-edit`: it is what the e2e and the hotkeys address,
    // and this is a relabelling, not a new tab.)
    const editTab = buildTab('tc-tab-edit', 'Markdown', ICON_MARKDOWN, true);
    const previewTab = buildTab('tc-tab-preview', 'Preview', ICON_PREVIEW, false);
    tabs.append(editTab, previewTab);
    wrap.append(tabs);

    // The writing tools, in ONE row above the markdown: the template the body
    // starts from, the step recorder, and Attach screenshot. All three act on the
    // text being written, so the row belongs to the Edit tab alone — Preview
    // renders what they produced and has nothing for them to do (showPreview
    // hides it, which is also what stops it from drawing a second, dead strip of
    // chrome over the rendered test).
    const tools = document.createElement('div');
    tools.className = 'toolbar divided tc-tools';

    // Template picker (#104) — the project's own "New Test" templates, leading the
    // row. The shared `Dropdown` (shared/dropdown.js), like every other picker in
    // the extension: this used to be a native <select>, and its OS-drawn popup
    // opened as a full-width slab of system chrome beside the 380px panel rather
    // than under the 170px control it belongs to.
    // Hidden outright when the project has no test template (or the fetch failed):
    // an empty dropdown is worse than none, and the body simply starts empty.
    //
    // No "Template" label beside it any more. The word cost the row a control's
    // worth of width to repeat what the control's own first option already says
    // ("Test Template (default)"), and this row has three controls to fit in a
    // 380px panel. What it said is now carried where a label belongs on a control
    // that is already self-evident: the mark INSIDE the field (`.field-icon`, which
    // `Dropdown` places for us), the tooltip, and the aria-label a reader gets.
    //
    // `align: 'end'` because it sits at the END of the toolbar: the popup grows
    // leftwards off the trigger's right edge, where anchoring it left would send a
    // long template title straight off the panel.
    let templateId = initialTemplateId;
    const tmplDD = Dropdown.create({
      id: 'tc-template',
      className: 'tc-template-field',
      triggerClass: 'size-sm tc-template-trigger',
      label: 'Test template',
      icon: ICON_TEMPLATE,
      align: 'end',
      // Name the project's default in the option itself — the closed control
      // otherwise gives no hint that this is the project-wide starting point.
      options: templates.map((t) => ({
        value: t.id,
        label: (t.title || `Template ${t.id}`) + (t.isDefault ? ' (default)' : ''),
      })),
      value: templateId,
      // …and with no seed, the first template is what is shown — a select has no
      // empty state, and this control had none either.
      fallbackFirst: true,
      // Picking REPLACES the body: free while nothing has been authored, and a
      // question first once it has. (The helpers this leans on are declared below,
      // with the editor they read — none of them runs before a click.)
      onChange: (id) => {
        const next = templateById(id);
        if (!next) return;
        // Already exactly that template — nothing to do (and nothing to mark
        // dirty). It is NOT enough to compare ids: a restored draft leaves the
        // pick on the default while the body is the tester's own, and re-picking
        // it must still bring the template back.
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
    // Attach is the one tool here that can say what it does in a single glyph — a
    // camera — and it is what buys the row: the three of them (a template title,
    // a recorder whose label GROWS as it counts steps, and this) do not fit
    // across a 380px panel with "Attach screenshot" spelled out, and the row
    // breaking in two is the thing this pass set out to end. The words survive
    // where a label belongs on an icon button: the tooltip and the accessible
    // name.
    const attachBtn = document.createElement('button');
    attachBtn.id = 'tc-attach';
    attachBtn.type = 'button';
    attachBtn.className = 'btn icon size-sm tc-tool';
    attachBtn.innerHTML = icon(ICON_CAMERA, 16);
    attachBtn.setAttribute('aria-label', 'Attach screenshot');
    Tooltip.set(attachBtn, 'Attach screenshot — capture the active tab, mark it up, and attach it on Save');
    // The staged screenshots. A list, because there can be several — the camera
    // appends — and a list is what a screen reader should hear them as.
    const shotPreview = document.createElement('ul');
    shotPreview.id = 'tc-shot-preview';
    shotPreview.className = 'thumb-row tc-shot-preview';
    shotPreview.setAttribute('aria-label', 'Screenshots to attach on Save');
    shotPreview.hidden = true;
    // The row reads left to right as what the tester DOES: record the steps,
    // attach the screenshot. The template is not one of those — it is picked once,
    // before the writing starts, and never touched again — so it sits at the far
    // end of the row (`margin-inline-start: auto`, editor.css), off the two
    // buttons that get used over and over.
    tools.append(recBtn, recContinue, attachBtn, tmplField, shotPreview);
    wrap.append(tools);

    // body: OverType host + marked preview pane
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

    // The closing row (`.bar.footer`): what this screen is FOR — commit the test,
    // or leave without one. Both actions lead the row, primary first, under the
    // left edge of the field they act on; the header above is left to say where
    // the tester is and what the test is, which is the other half of the job.
    // Cancel is the same leave Back performs, guard and all — it is the way out
    // for the tab context too, which has no Back arrow to offer.
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

    // mount OverType (toolbar on, with the dropped-buttons filter).
    applyTheme();
    // OverType fires `onChange` while it lays in the initial `value`, and a
    // template seed arriving is not the tester typing: unarmed until the mount
    // returns, or a brand-new editor is dirty before it is even looked at — which
    // means an unsaved-changes dialog on the way back out of an untouched screen
    // and a persisted draft for a test nobody wrote. (A RESTORED draft is dirty on
    // purpose; that is `initialDirty`, applied further down.)
    let mounted = false;
    const opts = {
      toolbar: true,
      // OverType's own default is a code stack (SF Mono/Menlo/…); the raw
      // markdown a tester edits is body copy, not source, so it wears the
      // product's own mono face instead (--instance-font-family, set by
      // OverType from this option, reaches both the textarea and its own
      // live overlay — never the rendered Preview tab, which stays --font-sans).
      // The three metrics of the editing surface, all declared in editor.css
      // (`:root`) with the rest of the page's values — see the note there.
      // They MUST go through these options and not a stylesheet rule: OverType
      // lays a transparent textarea over a rendered overlay, and the two are
      // pinned to one `--instance-font-family` / `--instance-font-size` /
      // `--instance-line-height` (`.overtype-input, .overtype-preview`, a single
      // `!important` block in the vendored file). Sizing either layer on its own
      // would slide the caret off the glyphs it is standing in.
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
    // The vendored toolbar labels its buttons with the browser's own `title`
    // (overtype.min.js: `n.title = e.title`), which is the one thing left on
    // this page that would open an OS tooltip beside ours. Vendored code is
    // never edited (Constitution II), so the labels are MOVED here instead —
    // once, right after the mount that created them. `aria-label` is already on
    // each button, so nothing is lost by taking the attribute away.
    Tooltip.adopt(host);

    // ---- tab toggle ----
    // The open tab is said twice on purpose: in the class the tab bar paints
    // from, and in `aria-selected`, which is what a real tablist is read by.
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
      // The writing tools belong to the tab that writes (and stay away entirely
      // when the project has no template AND nothing else to show would be odd —
      // the row always has Record and Attach, so it only ever hides with Preview).
      tools.hidden = false;
      setTab(editTab, previewTab);
    }
    function showPreview() {
      previewing = true;
      renderPreviewInto(previewPane, editor.getValue());
      editHost.hidden = true;
      previewPane.hidden = false;
      tools.hidden = true;
      setTab(previewTab, editTab);
    }
    editTab.addEventListener('click', showEdit);
    previewTab.addEventListener('click', showPreview);

    // ---- template picker behaviour (#104) ----
    // Picking a template REPLACES the body. That is free while the body is still
    // "unauthored" — blank, or byte-equal to some template we offer (the seed, or
    // an earlier pick) — and destructive once the tester has typed, so the second
    // case asks first instead of silently eating the work.
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
    // Cancel must put the control back on what the body actually holds — the
    // pick already moved the closed face, and nothing else is going to move it
    // back. (`setValue` is the silent path, so this cannot re-enter onChange.)
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
    const canRecord = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

    // BLIND: the recorded tab moved to a page Chrome keeps extensions off
    // (chrome://, the Web Store, another extension), so no step reaches the worker.
    // Name the cause AND the fix — and say the recording is still running, because
    // the worker revives it by itself the moment the tab is back on the site.
    const REC_BLIND = 'Chrome doesn’t allow extensions on this page — steps are not being recorded. '
      + 'Go back to the site under test and recording resumes by itself.';

    // A manual pause (indicator Pause) is NOT the cap pause: say so on the Stop
    // button, and keep Continue hidden — the way out is Resume on the page, which
    // must not also hand out another cap.
    const REC_MANUAL_PAUSE = 'Paused from the page indicator — click Resume there to carry on recording.';

    // The leading ●/■ is an icon now (record vs stop); the label carries only words,
    // so textContent stays the plain sentence the e2e reads.
    // (The parameter is the icon's NAME — calling it `icon` shadowed the module's
    // own `icon()` helper, so this line called a string and threw on the FIRST
    // paint of the editor, taking everything after it down with it: the leave
    // guard, the key handler and the e2e hooks. Which is why Back did nothing —
    // its handler reached a `guard` that never got past its TDZ.)
    const setRecBtn = (name, label) => {
      recBtn.innerHTML = icon(name, 16);
      const span = document.createElement('span');
      span.textContent = label;
      recBtn.append(span);
    };

    // What the button says when nothing is wrong — a tip is a DESCRIPTION, so it
    // says what recording DOES rather than repeating the label under the pointer.
    const REC_TIP_OFF = 'Record what you do on the page as numbered steps';
    const REC_TIP_ON = 'Stop recording — the steps go into this test';

    function updateRecUi(count, paused, blind, manualPaused) {
      let tip = recording ? REC_TIP_ON : REC_TIP_OFF;
      if (blind) tip = REC_BLIND;
      else if (manualPaused) tip = REC_MANUAL_PAUSE;
      Tooltip.set(recBtn, tip);
      if (!recording) {
        setRecBtn(ICON_RECORD, 'Record steps');
        recBtn.classList.remove('recording');
        recContinue.hidden = true;
      } else if (manualPaused && !blind) {
        setRecBtn(ICON_STOP, `Stop recording (${count || 0}) — paused`);
        recBtn.classList.add('recording');
        recContinue.hidden = true;
      } else if (blind) {
        // Being blind is the more urgent fact, but a blind recorder can ALSO be at
        // the cap — keep Continue reachable so both blockers clear in any order.
        setRecBtn(ICON_STOP, `Stop (${count || 0}) — page not recordable`);
        recBtn.classList.add('recording');
        recContinue.hidden = !paused;
      } else if (paused) {
        setRecBtn(ICON_STOP, 'Stop');
        recBtn.classList.add('recording');
        recContinue.hidden = false;
      } else {
        setRecBtn(ICON_STOP, `Stop recording (${count || 0})`);
        recBtn.classList.add('recording');
        recContinue.hidden = true;
      }
    }

    function setMarkdown(md) {
      // A live insert (#160) lands while the editor is open — keep the caret put.
      const ta = editHost.querySelector('.overtype-input');
      const at = ta && document.activeElement === ta ? ta.selectionStart : -1;
      editor.setValue(md);
      if (at >= 0) { try { ta.setSelectionRange(at, at); } catch { /* re-rendered */ } }
      onEdited();
      if (previewing) renderPreviewInto(previewPane, md);
    }

    // The recording's single insertion point — the live poll and Stop's tail flush
    // both come through here (a future step-polish pass would sit right on it).
    function insertEntries(entries) {
      const md = editor.getValue();
      const parts = splitRecorded(entries, recStepInserted && sectionHasItems(md, 'Steps', true));
      if (!parts.steps.length && !parts.expected.length && !parts.leadSubs.length) return false;
      setMarkdown(insertRecorded(md, parts));
      if (parts.steps.length) recStepInserted = true;
      recAnyInserted = true;
      return true;
    }

    async function startRecording() {
      if (!canRecord) { showToast('Recording needs the extension context'); return; }
      // The tab the recorder will inject into (the SW resolves the same active
      // tab). Never a prompt: the only "no" left is a restricted page.
      const access = await ensureSiteAccess();
      if (!access.ok) { showToast(access.error); return; }
      const resp = await chrome.runtime.sendMessage({ type: 'STEPREC_START' }).catch(() => null);
      if (!resp || !resp.ok) { showToast((resp && resp.reason) || 'This page can’t be recorded'); return; }
      recording = true;
      recEnding = false;
      recBlind = false;
      recManualPause = false;
      recStepInserted = false;
      recAnyInserted = false;
      updateRecUi(0, false, false, false);
      clearInterval(recPollTimer);
      recPollTimer = setInterval(pollRec, 500);
    }

    // End the recording and insert the tail the live poll had not pulled yet (#160 —
    // the steps before it are in the body already). Called by the editor Stop button,
    // the poll (indicator Stop / recorded-tab close), and the leave interception.
    async function finishRecording(toastMsg) {
      if (recEnding) return;
      recEnding = true;
      recStopping = true;
      clearInterval(recPollTimer);
      recording = false;
      recBlind = false;
      recManualPause = false;
      updateRecUi(0, false, false, false);
      const resp = canRecord ? await chrome.runtime.sendMessage({ type: 'STEPREC_STOP' }).catch(() => null) : null;
      const inserted = insertEntries((resp && resp.entries) || []);
      recStopping = false;
      if (toastMsg) showToast(toastMsg);
      else if (!inserted && !recAnyInserted) showToast('No steps recorded');
    }

    // One message per tick: it carries the status AND the entries that are final,
    // which land in the open test right away (#160).
    async function pollRec() {
      if (!canRecord || !recording) return;
      const s = await chrome.runtime.sendMessage({ type: 'STEPREC_PULL' }).catch(() => null);
      if (!s) return;
      if (s.entries && s.entries.length) insertEntries(s.entries);
      if (s.recording === false) { finishRecording(); return; } // stopped on the page / tab closed
      // Toast once per blind stretch (the poll runs every 500ms); the button label
      // and its tooltip carry the warning for as long as it lasts.
      if (s.blind && !recBlind) showToast(REC_BLIND);
      recBlind = !!s.blind;
      recManualPause = !!s.manualPause;
      updateRecUi(s.count, s.paused, recBlind, recManualPause);
    }

    recBtn.addEventListener('click', () => { if (recording) finishRecording(); else startRecording(); });
    recContinue.addEventListener('click', async () => {
      if (!canRecord) return;
      await chrome.runtime.sendMessage({ type: 'STEPREC_CONTINUE' }).catch(() => {});
      updateRecUi(0, false, recBlind, recManualPause);
    });

    // ---- Attach screenshots (previews held until Save) -----------------------
    // The library's `.thumb-row` (components.css): the pictures themselves, each
    // carrying the one action a staged picture has. Rebuilt whole on every
    // change — the list is at most MAX_SHOTS long, and a diff would only be a
    // second place for its order to be wrong.
    function renderShotPreview() {
      shotPreview.replaceChildren();
      shotPreview.hidden = pendingShots.length === 0;
      if (!pendingShots.length) return;
      pendingShots.forEach((dataUrl, i) => {
        const cell = document.createElement('li');
        cell.className = 'thumb';
        const img = document.createElement('img');
        img.src = dataUrl;
        // The number is the picture's place in the row, which is the order they
        // will be attached in — the only thing a reader can check it against.
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
    // Focus cannot stay on a button that is gone: it lands on the next picture's
    // remove, or on the camera that made them when the last one goes.
    function dropShot(i) {
      if (i < 0 || i >= pendingShots.length) return;
      pendingShots.splice(i, 1);
      renderShotPreview();
      markDirty();
      const next = shotPreview.querySelector(`.thumb-remove[data-shot="${Math.min(i, pendingShots.length - 1)}"]`);
      (next || attachBtn).focus();
    }

    async function attachScreenshot() {
      if (attachBtn.disabled) return;
      // A held shot is a whole JPEG in this page's memory, so the row has a
      // ceiling; it is high enough that no real test case reaches it by accident.
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
        // `needsGrant` (#101): the worker's sentence already names the fix — a
        // toolbar click — so it is shown as it stands rather than prefixed with a
        // diagnostic. This page holds no SiteResume, so the retry is the tester's
        // second click on the camera, which is what that sentence asks for.
        if (!resp.ok) {
          showToast(resp.needsGrant ? resp.error : `Capture failed: ${resp.error || 'unknown'}`, { error: true });
          return;
        }
        const staged = await CaptureAnnotate.annotateImage(resp.dataUrl, resp.tabId, { toast: showToast });
        if (!staged) return; // Discard — nothing staged
        pendingShots.push(staged);
        renderShotPreview();
        markDirty(); // a pending shot is unsaved work → Save uploads it, guard protects it
      } finally {
        attachBtn.disabled = false;
      }
    }
    attachBtn.addEventListener('click', attachScreenshot);
    updateRecUi(0, false, false, false);

    // Hand the page over to the read-only view of the test just written — the
    // screen a saved test belongs on, whether this Save created it or changed
    // it. It also latches `done`, which is what makes a second Save (button or
    // Cmd+S) impossible: creating, that would be a duplicate TC.
    function handOverToView(id, saved) {
      done = true;
      clearInterval(recPollTimer);
      document.removeEventListener('keydown', onEditorKey);
      const p = new URLSearchParams(location.search);
      p.delete('suite');
      p.delete('edit');
      p.set('test', id);
      history.replaceState(null, '', `?${p.toString()}`); // a reload lands on the view
      renderView({ ctx, uid: id, ...saved });
    }

    // ---- save: writes the TC; returns its uid, or null on failure (FR-008) ---
    async function save() {
      if (saving || done) return null;
      // Claim the flag before the first await — the recorder drain below is one,
      // and a second chord must not slip past it into a duplicate POST.
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        // A running recorder is drained FIRST — its tail is not in the body yet,
        // and what is not in the body is not in the payload.
        if (recording) await finishRecording();
        const description = editor.getValue();
        // The title field wraps, and a paste can bring real newlines with it —
        // what goes to the API is one line either way.
        const t = titleInput.value.replace(/\s+/g, ' ').trim();
        const priority = priorityCtrl.getPriority();
        // Inline, at the field — NOT a toast (#82): the title sits at the top of
        // the page and the toast at the very bottom, so the old toast was easy
        // to miss.
        if (!t) { showTitleError('Title is required'); return null; }
        // The one line where the two modes part: a POST into the suite, or a
        // PATCH of the three fields this screen owns. The update deliberately
        // omits `suite_id` — sending it would MOVE the test (contract m3), and
        // this editor was opened to change its text, not where it lives.
        const written = editing
          ? await TestomatAPI.updateTest(uid, { title: t, description, priority })
          : await TestomatAPI.createTest({ title: t, suite_id: suite, description, priority });
        // Editing, the uid is known before the request and stays the uid whatever
        // the response echoes back.
        const id = (written && written.id) || (editing ? uid : null);
        // Upload the held screenshots to the (now-existing) test — best-effort,
        // the same JWT multipart route as Block 5, in the order they were taken.
        // A failure toasts but never fails Save, and the ones that did NOT land
        // stay staged: they are still unsaved work, and a second Save retries
        // exactly them.
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
              shotError = (e && e.message) || e;   // the last word on why, for the toast
            }
          }
          shotFailed = kept.length;
          pendingShots.splice(0, pendingShots.length, ...kept);
          renderShotPreview();
        }
        clearDirty();
        if (ctx === 'panel') removeEditorDraft(draftKey);
        // View first, then the toast — showToast targets the view's own element.
        // No id back (never seen on v2, but the TC exists): stay put and just
        // latch `done`, so a retry can never create a second copy.
        // The record handed on is the one this page already had (an edit knows
        // what it opened, and the mark in the header is drawn off it). For a
        // create there is none, and `test: {}` is not a missing record — it is
        // what the panel just wrote: a case typed by hand, with no code behind
        // it, which is exactly the `manual` kind TestType reads out of a record
        // carrying no state flags.
        const rec = (editing && test) ? { ...test, title: t, priority } : {};
        if (id) handOverToView(id, { title: t, markdown: description, priority, test: rec });
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
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }

    // ---- leave guards (the in-page dialog; tab ctx also keeps beforeunload) ----
    // Where a leave LANDS is the caller's, but it is held here so the guard's own
    // Save & leave / Discard go wherever the leave that opened them was headed.
    // Back and the suite crumb return to the panel as it stands (its boot walks
    // back into that suite's list from `tcReturn`); the Tests crumb drops that
    // breadcrumb first, so the panel lands on the tree instead.
    // A cancelled guard leaves the last target behind — harmless, because every
    // entry point sets it again before anything reads it.
    // In ctx=tab there is no panel to return to: this document IS the window the
    // editor was opened in, so leaving closes it.
    const toPanelHome = ctx === 'panel'
      ? () => { location.href = '../sidepanel/index.html'; }
      : () => { window.close(); };
    // …but an EDIT was not opened from the panel — it was opened from the test's
    // own read-only view, one flag ago in this same document, and that is the
    // page behind it in both contexts. (Closing the tab there would throw away
    // the test the tester came to read.)
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
    // ◀ while recording is intercepted ONCE: stop + insert (work is never silently
    // lost), stay in the editor. A later ◀ leaves normally (unsaved-changes dialog).
    // Otherwise unsaved changes open the three-outcome dialog; clean → leave now.
    function requestBack(to = goHome) {
      leaveTo = to;
      if (recording) { finishRecording('Recording stopped'); return; }
      if (dirty) openGuard(); else navigateBack();
    }

    // The dialog is built in BOTH contexts now. It used to be panel-only, because
    // the only in-page leaves were panel chrome (Back, the crumbs) and a tab had
    // `beforeunload` to catch the browser's own ways out. Cancel is an in-page
    // leave in a tab as well, and `beforeunload` does not fire for the
    // window.close() it performs — so the dialog is what stands behind it there
    // too, and the native prompt keeps guarding everything it always did.
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
    // Save & leave: navigate only on a successful save (failure keeps state, FR-008).
    gSave.addEventListener('click', async () => { closeGuard(); const id = await save(); if (id) navigateBack(); });
    gDiscard.addEventListener('click', () => { clearDirty(); navigateBack(); });
    gCancel.addEventListener('click', closeGuard);
    wrap.append(guard);

    // Cmd/Ctrl+S saves from anywhere on the page; Esc cancels the open dialog.
    // Named + removable: the read-only view that takes over after a create must
    // not keep a live Save chord pointing at this (detached) editor.
    function onEditorKey(e) {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault(); // always on the chord — else the browser Save dialog appears
        if (!saving) save();
        return;
      }
      if (e.key !== 'Escape') return;
      // Esc cancels whichever dialog is open — the template swap first, since it
      // is the one that can sit on top of an already-dirty editor.
      if (tmplGuard && !tmplGuard.hidden) {
        e.preventDefault(); closeTemplateGuard(); revertTemplateSelect(); return;
      }
      if (guard && !guard.hidden) { e.preventDefault(); closeGuard(); }
    }
    document.addEventListener('keydown', onEditorKey);

    // ---- e2e hooks (same shape as the React island) ----
    window.__tc = {
      ready: true,
      ctx,
      mode: () => (editing ? 'edit' : 'create'),
      // Creating, there is no uid until Save — which hands over to the view.
      uid: () => uid,
      // …and so no web url either: the hook exists only where the link does.
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
      // Template picker (#104): the offered list, the current pick, and a
      // user-equivalent pick (it goes through the same confirm path).
      templates: () => templates.map((t) => ({ id: t.id, title: t.title, isDefault: t.isDefault })),
      templateId: () => templateId,
      pickTemplate: (id) => tmplDD.pick(String(id)),
      recording: () => recording,
      // The Stop button flips `recording` at once but its tail insert is a round
      // trip away — a reader of the body has to wait for this to clear as well.
      recStopping: () => recStopping,
      recBlind: () => recBlind,
      // The whole staged row, and — for the readers that predate it — the newest
      // picture in it, which is the one an Apply just put there.
      pendingShots: () => pendingShots.slice(),
      pendingShot: () => (pendingShots.length ? pendingShots[pendingShots.length - 1] : null),
      // Append one, or clear the row with a falsy argument.
      stageShot: (dataUrl) => {
        if (dataUrl) pendingShots.push(dataUrl); else pendingShots.length = 0;
        renderShotPreview();
        markDirty();
      },
      dropShot: (i) => { dropShot(i); return pendingShots.length; },
    };

    // Restored a persisted panel-ctx draft: the content is already unsaved, so
    // reflect that (the draft itself stays in storage until save/discard).
    if (initialDirty) markDirty();
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
    // No corpus on the page anymore — the e2e harness supplies samples to
    // __roundtrip; with none set the pane just shows this placeholder.
    // Same typography as the real editor (it is the same editor, proving itself).
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

    // A real OverType set/get cycle per supplied sample ({ name, markdown }).
    // OverType edits raw markdown, so this is byte-identity for every construct.
    window.__roundtrip = async (samples) => (Array.isArray(samples) ? samples : []).map(({ name, markdown }) => {
      editor.setValue(markdown);
      return { name, input: markdown, output: editor.getValue() };
    });
  }

  // ---- boot ---------------------------------------------------------------
  async function boot() {
    // This page is served BOTH in the side panel and in a tab, and PanelLink sorts
    // that out itself (a tab never registers). It runs before every early return
    // below: a toolbar click while this page shows a message, the annotator or a
    // half-written test must not re-open the panel out from under it.
    if (typeof PanelLink !== 'undefined') PanelLink.init();
    // Annotator mode (M2 PR-2): editor.html?annotate=<key> hands the whole page
    // over to the annotator before any editor rendering (no OverType, no API).
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

    // Paint BEFORE the probe's round trip, not after it (#187) — and paint the
    // page's own chrome with its content as bars, not a notice box on a blank
    // page (see renderView's `loading`). Same call, same screen, so what
    // arrives replaces the bars in place instead of swapping one screen for
    // another.
    if (cx.test) renderView({ ctx: cx.ctx, uid: cx.test, loading: true });
    // Create mode's template seed rides along with the probe — loadTemplates swallows every failure.
    const templatesLoad = cx.suite ? loadTemplates() : null;

    // #187 — a direct load (restored tab, bookmark) never passed the Tests tab's own gate.
    if (await readonlyGate()) { renderMessage(READONLY_BLOCK, { back: panelCtx }); return; }

    // An existing test: one read, then either the screen that shows it or the
    // one that writes it (`&edit`). Same fetch either way — the editor opens on
    // the test's CURRENT text, which is the same text the view would render.
    if (cx.test) {
      try {
        const tc = await TestomatAPI.getTest(cx.test);
        if (cx.edit) {
          let title = (tc && tc.title) || '';
          let markdown = (tc && tc.description) || '';
          let priority = (tc && tc.priority) || 'normal';
          let restoredDirty = false;
          // Panel ctx: an unsaved edit of THIS test outranks what the server
          // still holds — closing the side panel mid-sentence is not a discard.
          if (panelCtx) {
            const draft = await readEditorDraft(editorDraftKey({ test: cx.test }));
            if (draft) {
              title = draft.title || '';
              if (draft.markdown != null) markdown = draft.markdown;
              priority = draft.priority || priority;
              restoredDirty = true;
            }
          }
          // No `templates`: a template SEEDS a body that has not been written
          // yet, and this one has — the picker would offer to replace the test.
          renderEditor({
            ctx: cx.ctx, mode: 'edit', uid: cx.test, test: tc || null,
            title, markdown, priority, dirty: restoredDirty,
          });
          return;
        }
        renderView({
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

    // create mode — bound to the suite in the URL; seed the initial markdown from
    // the PROJECT's default test template (#104; no templates → empty body).
    const templates = await templatesLoad;
    const initialTemplate = pickDefaultTemplate(templates);
    let title = '';
    let markdown = initialTemplate ? initialTemplate.body : '';
    let priority = 'normal';
    let restoredDirty = false;
    // Panel ctx: restore an unsaved new-test draft for this suite. The draft is
    // the tester's own text — it outranks the template seed.
    if (panelCtx) {
      const draft = await readEditorDraft(editorDraftKey({ suite: cx.suite }));
      if (draft) {
        title = draft.title || '';
        if (draft.markdown != null) markdown = draft.markdown;
        priority = draft.priority || 'normal';
        restoredDirty = true;
      }
    }
    renderEditor({
      ctx: cx.ctx, suite: cx.suite,
      title, markdown, priority, dirty: restoredDirty,
      templates, templateId: initialTemplate ? initialTemplate.id : null,
    });
  }

  boot();
})();
