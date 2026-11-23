// The editor's parameters grid; the read-only table under a test lives in view.js.

/* global EditorIcons, Tooltip, TestomatAPI */
const ParamsGrid = (() => {
  const { icon, ICON_CLOSE, ICON_ADD, ICON_MINUS, ICON_FOLD } = EditorIcons;

  // Params and example rows live on the JSON:API leg only, so the whole surface is session-only.
  const PARAM_MIN_COL = 1;
  const paramCells = (row) => (Array.isArray(row) ? row : (row && row.cells) || []);
  const paramText = (v) => String(v == null ? '' : v);
  const sameCells = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => v === b[i]);

  // Seeds come from a server read, a restored draft or an e2e hook, so each is squared off.
  function paramsModel(seed) {
    const headers = (seed && Array.isArray(seed.headers) ? seed.headers : []).map(paramText);
    const rows = (seed && Array.isArray(seed.rows) ? seed.rows : []).map((r) => ({
      id: !Array.isArray(r) && r && r.id != null ? String(r.id) : null,
      cells: paramCells(r).map(paramText),
    }));
    const width = Math.max(PARAM_MIN_COL, headers.length, ...rows.map((r) => r.cells.length));
    while (headers.length < width) headers.push('');
    for (const r of rows) while (r.cells.length < width) r.cells.push('');
    return { headers, rows, removed: (seed && Array.isArray(seed.removed) ? seed.removed.map(String) : []) };
  }
  const cloneParams = (m) => ({
    headers: m.headers.slice(),
    rows: m.rows.map((r) => ({ id: r.id, cells: r.cells.slice() })),
    removed: m.removed.slice(),
  });
  const paramsHaveData = (m) => m.rows.length > 0 || m.headers.some((h) => h.trim());

  // `onEdited` is the editor's dirty+persist tick, so every keystroke here counts as unsaved work.
  function buildParamsControl({ seed = null, onEdited }) {
    let model = paramsModel(seed);
    const fromDraft = !!seed;
    // Server copy, so Save writes only what changed; empty until a read lands, as for a create.
    let baseHeaders = [];
    let baseRows = new Map();
    let ready = !!seed;   // the draft may carry the grid only once it stands for something
    let available = true; // false in basic mode: no session, no rows
    // Which model row a planned write came from, held off the plan itself so it stays plain data.
    const planRows = new WeakMap();

    const section = document.createElement('section');
    section.className = 'tc-params';

    const head = document.createElement('button');
    head.id = 'tc-params-head';
    head.type = 'button';
    head.className = 'disclosure-head';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', 'tc-params-body');
    head.innerHTML = icon(ICON_FOLD, 16);
    head.append(Object.assign(document.createElement('span'), { textContent: 'Parameters' }));

    const count = document.createElement('span');
    count.id = 'tc-params-count';
    count.className = 'counter size-sm';
    count.hidden = true;
    head.append(count);

    const body = document.createElement('div');
    body.id = 'tc-params-body';
    body.className = 'disclosure-body';
    body.hidden = true;

    const hint = document.createElement('p');
    hint.className = 'hint tc-params-hint';
    hint.append('Columns are parameter names; each row runs as its own test. Write ');
    hint.append(Object.assign(document.createElement('code'), { textContent: '${name}' }));
    hint.append(' in the steps.');

    const grid = document.createElement('div');
    grid.id = 'tc-params-grid';
    grid.className = 'tc-params-grid';

    const error = document.createElement('div');
    error.id = 'tc-params-error';
    error.className = 'tc-params-error';
    error.setAttribute('role', 'alert'); // announced the moment it is filled
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'tc-params-actions';
    const addColBtn = document.createElement('button');
    addColBtn.id = 'tc-params-add-col';
    addColBtn.type = 'button';
    addColBtn.className = 'btn size-xs';
    addColBtn.innerHTML = `${icon(ICON_ADD, 16)}<span>Column</span>`;
    Tooltip.set(addColBtn, 'Add a parameter column');
    const dropColBtn = document.createElement('button');
    dropColBtn.id = 'tc-params-drop-col';
    dropColBtn.type = 'button';
    dropColBtn.className = 'btn size-xs';
    dropColBtn.innerHTML = `${icon(ICON_MINUS, 16)}<span>Column</span>`;
    Tooltip.set(dropColBtn, 'Remove the last column');
    actions.append(addColBtn, dropColBtn);

    body.append(hint, grid, error, actions);
    section.append(head, body);

    function setOpen(open) {
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.hidden = !open;
    }
    head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'));

    function clearError() {
      if (error.hidden) return;
      error.hidden = true;
      error.textContent = '';
    }
    // The fold is opened first: a message inside a closed block says nothing.
    function showError(msg, col = 0) {
      setOpen(true);
      error.hidden = false; // unhide first: a hidden live region is not announced
      error.textContent = msg;
      focusCell('head', col);
    }

    const cellAt = (row, col) => grid.querySelector(`input[data-row="${row}"][data-col="${col}"]`);
    function focusCell(row, col) {
      const el = cellAt(row, col);
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text input */ }
    }

    function input(value, cls, placeholder, row, col) {
      const el = document.createElement('input');
      el.type = 'text';
      el.className = cls;
      el.value = value;
      el.placeholder = placeholder;
      el.dataset.row = String(row);
      el.dataset.col = String(col);
      return el;
    }

    // Web parity: typing into the blank row makes it a row; that keystroke is already in the value.
    function promoteRow(col, value) {
      if (!value) return; // a paste of nothing is not a row
      const cells = model.headers.map(() => '');
      cells[col] = value;
      model.rows.push({ id: null, cells });
      render();
      focusCell(model.rows.length - 1, col);
      onEdited();
    }

    function removeRow(r) {
      const [gone] = model.rows.splice(r, 1);
      if (gone && gone.id) model.removed.push(gone.id);
      clearError();
      render();
      onEdited();
      // Focus cannot stay on a button that is gone: it lands on the next row's ✕, or on + Column.
      const next = grid.querySelector(`.tc-params-remove[data-row="${Math.min(r, model.rows.length - 1)}"]`);
      (next || addColBtn).focus();
    }

    function addColumn() {
      model.headers.push('');
      for (const row of model.rows) row.cells.push('');
      render();
      focusCell('head', model.headers.length - 1);
      onEdited();
    }
    // One column always stays, or there is nothing to name.
    function dropColumn() {
      if (model.headers.length <= PARAM_MIN_COL) return;
      model.headers.pop();
      for (const row of model.rows) row.cells.pop();
      clearError();
      render();
      onEdited();
    }
    addColBtn.addEventListener('click', addColumn);
    dropColBtn.addEventListener('click', dropColumn);

    // The cell under the ✕ column, so the grid's last track keeps its width on every row.
    const corner = () => Object.assign(document.createElement('span'), { className: 'tc-params-corner' });

    // Rebuilt whole: a grid this small gains nothing from a diff, and row order has one place to be right.
    function render() {
      grid.replaceChildren();
      grid.style.gridTemplateColumns = `repeat(${model.headers.length}, minmax(88px, 1fr)) var(--tc-params-gutter)`;
      // Names sit in their own box to stay put while values scroll; subgrid keeps the columns aligned.
      const headRow = document.createElement('div');
      headRow.className = 'tc-params-headrow';
      model.headers.forEach((value, col) => {
        const el = input(value, 'input size-sm tc-params-name', 'Parameter', 'head', col);
        el.addEventListener('input', () => { model.headers[col] = el.value; clearError(); onEdited(); });
        headRow.append(el);
      });
      headRow.append(corner());
      grid.append(headRow);
      model.rows.forEach((row, r) => {
        row.cells.forEach((value, col) => {
          const el = input(value, 'input size-sm', 'Value', r, col);
          el.addEventListener('input', () => { model.rows[r].cells[col] = el.value; clearError(); onEdited(); });
          el.addEventListener('keydown', (e) => onCellKey(e, r, col));
          grid.append(el);
        });
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'icon-btn size-xs tc-params-remove';
        drop.dataset.row = String(r);
        drop.innerHTML = icon(ICON_CLOSE, 16);
        drop.setAttribute('aria-label', 'Remove row');
        Tooltip.set(drop, 'Remove this row');
        drop.addEventListener('click', () => removeRow(r));
        grid.append(drop);
      });
      model.headers.forEach((_, col) => {
        const el = input('', 'input size-sm', 'Value', 'new', col);
        el.addEventListener('input', () => promoteRow(col, el.value));
        grid.append(el);
      });
      grid.append(corner()); // the blank row is not a row yet, so it carries no ✕
      count.hidden = model.rows.length === 0;
      count.textContent = String(model.rows.length);
      dropColBtn.disabled = model.headers.length <= PARAM_MIN_COL;
    }

    // Enter walks down the column; the blank row makes that always possible.
    function onCellKey(e, r, col) {
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      focusCell(r + 1 < model.rows.length ? r + 1 : 'new', col);
    }

    // What Save will write, or null when the grid is not sound (the message is on screen by then).
    function plan() {
      const empty = { headers: [], headersChanged: false, writes: [], deletes: [] };
      if (!available) return empty;
      const headers = model.headers.map((h) => h.trim());
      const rows = [];
      const deletes = model.removed.slice();
      for (const row of model.rows) {
        const cells = row.cells.map((c) => c.trim());
        // An emptied row is a row the tester took out; one that was never written just goes.
        if (cells.every((c) => !c)) { if (row.id) deletes.push(row.id); continue; }
        rows.push({ id: row.id, cells, row });
      }
      const lastIn = (arr) => arr.reduce((last, v, i) => (v ? i : last), -1);
      const lastHeader = lastIn(headers);
      // Trailing columns nobody used are spares, not parameters — they never travel.
      const width = Math.max(lastHeader, rows.reduce((w, r) => Math.max(w, lastIn(r.cells)), -1)) + 1;
      if (rows.length && lastHeader === -1) { showError('Name the parameters first'); return null; }
      const kept = headers.slice(0, width);
      const unnamed = kept.findIndex((h) => !h);
      if (unnamed !== -1) { showError('Every parameter needs a name', unnamed); return null; }
      // `${name}` resolves to the first column of that name; point at the second, the one to rename.
      const twice = kept.findIndex((h, i) => kept.indexOf(h) !== i);
      if (twice !== -1) { showError('Two parameters have the same name', twice); return null; }
      const writes = [];
      for (const r of rows) {
        const w = { kind: r.id ? 'update' : 'create', id: r.id, cells: r.cells.slice(0, width) };
        // Unchanged rows are skipped; the rest map to their write so a landed id finds its row.
        if (w.kind === 'update' && sameCells(baseRows.get(w.id), w.cells)) continue;
        planRows.set(w, r.row);
        writes.push(w);
      }
      return {
        headers: kept,
        headersChanged: !sameCells(kept, baseHeaders),
        writes,
        deletes,
      };
    }

    // A landed create hands its row the server id, or a second Save would create a duplicate example.
    function landedCreate(w, made) {
      const id = made && made.id ? String(made.id) : null;
      if (!id) return;
      const row = planRows.get(w);
      if (row) row.id = id;
      baseRows.set(id, w.cells.slice());
    }
    // A landed delete leaves the model (removed or emptied row), so a retry does not delete it again.
    function landedDelete(id) {
      const i = model.removed.indexOf(id);
      if (i !== -1) model.removed.splice(i, 1);
      for (const r of model.rows) if (r.id === id) r.id = null;
    }

    // Best-effort: returns the first failure, later writes still go, each landed leg moves the baseline.
    async function commit(uid, planned) {
      let failure = null;
      const fail = (e) => { if (!failure) failure = (e && e.message) || String(e); };
      if (planned.headersChanged) {
        try {
          await TestomatAPI.setTestParams(uid, planned.headers);
          baseHeaders = planned.headers.slice();
        } catch (e) { fail(e); }
      }
      for (const w of planned.writes) {
        try {
          if (w.kind === 'create') landedCreate(w, await TestomatAPI.createExample(uid, w.cells));
          else {
            await TestomatAPI.updateExample(w.id, w.cells);
            baseRows.set(w.id, w.cells.slice());
          }
        } catch (e) { fail(e); }
      }
      for (const id of planned.deletes) {
        try { await TestomatAPI.deleteExample(id); landedDelete(id); } catch (e) { fail(e); }
      }
      return failure;
    }

    render();
    if (fromDraft && paramsHaveData(model)) setOpen(true);

    return {
      section,
      plan,
      commit,
      // Server copy is the baseline even with a draft: what the tester typed outranks it.
      load(server) {
        baseHeaders = (server.headers || []).map(paramText);
        baseRows = new Map((server.rows || []).map((r) => [String(r.id), paramCells(r).map(paramText)]));
        if (!fromDraft) {
          model = paramsModel(server);
          render();
          if (paramsHaveData(model)) setOpen(true);
        }
        ready = true;
      },
      // No read to wait for (a create, or one that failed) — the grid stands for itself from here.
      ready: () => { ready = true; },
      // Basic mode: nothing to read the rows with and nothing to write them back.
      disable: () => { available = false; section.hidden = true; },
      available: () => available,
      draft: () => (ready && available ? cloneParams(model) : null),
      get: () => cloneParams(model),
      set: (next) => {
        model = paramsModel(next);
        clearError();
        render();
        if (paramsHaveData(model)) setOpen(true);
        onEdited();
      },
    };
  }

  return { paramsModel, cloneParams, paramsHaveData, paramText, buildParamsControl };
})();
