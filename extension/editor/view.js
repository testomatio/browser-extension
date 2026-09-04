// The read-only view of a test case (IIFE global `EditorView`): its header, the rendered
// description and the parameters table under it. Its own file — one screen, its own test file.

/* global EditorIcons, ParamsGrid, TestomatAPI, Icons, PriorityIcons, TestType, EmptyState, Sk, Tooltip */
const EditorView = (() => {
  // The same icon names editor.js uses, resolved by shared/icons.js.
  const { icon, ICON_BACK, ICON_OPEN_IN_NEW, ICON_EDIT } = EditorIcons;
  // The grid's own cell-to-string rule, so the read-only table prints a value the way the
  // editable one does.
  const { paramText } = ParamsGrid;

  // Silent to screen readers: the sentence they get is on the heading that holds it (renderView).
  function skBar(cls, w) {
    const b = Sk.bar(cls, w);
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  // The read-only table under a test's description. Optional by contract: no session, no parameters,
  // a failed read or a BDD project (#32 — the body's Examples already show this data) draw nothing.
  // `projectLang` is editor.js's memoised probe, handed in so this never starts a second one.
  async function appendParamsTable(pane, uid, { projectLang }) {
    if (!uid || TestomatAPI.jwtAvailable() === false) return;
    if ((await projectLang()) === 'gherkin') return;
    let read = null;
    try { read = await TestomatAPI.getTestParams(uid); } catch (e) { console.debug('parameters unavailable', e); return; }
    const rows = read.examples || [];
    const headers = (read.params || []).map(paramText);
    if (!headers.length && !rows.length) return;
    // A row is never narrowed to fit the header list: a value with no column left still shows.
    const width = Math.max(headers.length, ...rows.map((r) => r.data.length));
    while (headers.length < width) headers.push('');

    const section = document.createElement('section');
    section.className = 'tc-params-view';
    const title = document.createElement('h3');
    title.textContent = 'Parameters';
    const count = document.createElement('span');
    count.className = 'counter size-sm';
    count.textContent = String(rows.length);
    title.append(' ', count);

    const table = document.createElement('table');
    table.className = 'tc-params-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const name of headers) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = name;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (let i = 0; i < width; i++) {
        const td = document.createElement('td');
        td.textContent = paramText(row.data[i]);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    section.append(title, table);
    pane.append(section);
  }

  // ---- the read-only view of an existing TC (#115) -------------------------
  // `loading` is this same screen with only the title and body as grey bars — and no
  // arming delay (unlike sidepanel/core/skeleton.js): a fresh document has no warm path.
  // `shell` is editor.js: the chrome the editor screen shares, plus the three members that read
  // module state over there (`testWebUrl`, `projectLang`, `onSettings`) and are called, not copied.
  function renderView({
    ctx, uid, title, markdown, priority, test, loading = false,
    shell: { rootEl, barMain, buildCrumbs, toTestsRoot, renderPreviewInto, paneHasContent,
      testWebUrl, projectLang, onSettings },
  }) {
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
    h.className = 'context-title tc-view-title';
    // The test's own marks before its name, in the order every row naming a test opens
    // with (core/views.js contextTitleMarks): how much it matters, then what it is.
    if (loading) {
      // The bars say nothing a screen reader can use, so the heading carries the sentence.
      h.setAttribute('aria-label', 'Loading test case…');
      // The priority keeps its BOX while the read is out, or the title steps 24px sideways
      // when the mark lands; `.skeleton` is a block, hence the row wrapper around the two.
      const row = document.createElement('span');
      row.className = 'tc-view-title-sk';
      const slot = document.createElement('span');
      slot.className = 'prio';
      slot.append(skBar('circle'));
      row.append(slot, skBar('line', '58%'));
      h.append(row);
    } else {
      // An absent or unknown priority IS `normal` — shared/priority-icons.js falls back to it.
      const prioMark = PriorityIcons.mark(priority);
      if (prioMark) { prioMark.id = 'tc-view-priority'; h.append(prioMark); }
      // Its custom emoji if the project gave it one, else the type-of-test square the
      // panel's lists open a test row with. Absent record → just the name.
      const mark = test && typeof TestType !== 'undefined'
        ? (Icons.emoji(test.emoji, 'type-mark') || TestType.forRecord(test))
        : null;
      if (mark) h.append(mark);
      h.append(title || '(untitled)');
    }
    // In ctx=tab there is no panel to walk back into, so the title stands alone.
    bar.append(ctx === 'panel'
      ? barMain(buildCrumbs({ onRoot: toTestsRoot, onSuite: leave }), h)
      : h);

    // Re-opens THIS page with `&edit`, so the editor keeps the uid, the trail and the tab
    // it was opened in. Drawn while `loading` too: its address is known from the uid.
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

    // "Open in Testomat ↗" (#113): an anchor wearing the icon-button skin. The href is
    // rebuilt from the active settings; with nothing to link to it hides, not 404s.
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
    // The id goes on the pane that HAS the steps: a placeholder answering to it would be
    // an empty body the e2e harness reads as a loaded one.
    if (!loading) pane.id = 'tc-view-body';
    // `sections` (shared/components.css) prints `### Steps` / `### Expected` as muted
    // labels rather than chapters — the same way the panel prints the same body.
    pane.className = loading
      ? 'tc-preview-pane markdown sections skeleton-rows'
      : 'tc-preview-pane markdown sections';
    if (loading) {
      pane.setAttribute('aria-hidden', 'true');
      pane.append(Sk.lines(), Sk.lines(['92%', '76%', '84%']), Sk.lines(['88%', '94%', '58%']));
    } else {
      renderPreviewInto(pane, markdown);
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

    const toast = document.createElement('div');
    toast.id = 'tc-toast';
    toast.className = 'toast tc-toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    wrap.append(toast);

    host.append(wrap);

    // A placeholder is not a loaded page: `__tc.ready` is what the e2e harness waits on.
    if (loading) { wrap.setAttribute('aria-busy', 'true'); return; }

    // The parameters table lands INSIDE the scrolling pane, under the description it belongs to
    // (#5). It arrives a round trip late, and says nothing at all when there is nothing to say.
    appendParamsTable(pane, uid, { projectLang });

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
      // e2e hook (35-open-in-testomat): repoint at another instance/project the way a
      // settings change would, then re-render the link.
      applySettings: (s) => { onSettings(s); refreshWebLink(); },
    };
  }

  return { renderView, appendParamsTable };
})();
