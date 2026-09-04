// The test-parameters grid (IIFE global `ParamsGrid`): the model a seed is squared off into, and
// the folded control that renders it. The read-only table under a test stays in the editor.

/* global Icons, Tooltip, TestomatAPI */
const ParamsGrid = (() => {
  // The same icon names editor.js uses, resolved by shared/icons.js.
  const ICON_CLOSE = 'close';
  const ICON_ADD = 'add';
  const ICON_MINUS = 'remove';
  const ICON_FOLD = 'chevron_right';
  const icon = (name, size = 20) => Icons.markup(name, size);

  // ---- test parameters (#5) ------------------------------------------------
  // A test's parameters are COLUMN NAMES (`params` on the test) over example ROWS (one record each,
  // `data` positional to the columns); a step names one with `${name}`, and every row runs as its
  // own test. Both live on the JSON:API leg alone, so the whole surface is session-only.
  const PARAM_MIN_COL = 1;
  const paramCells = (row) => (Array.isArray(row) ? row : (row && row.cells) || []);
  const paramText = (v) => String(v == null ? '' : v);
  const sameCells = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => v === b[i]);

  // Any seed — a server read, a restored draft, an e2e hook — squared off: one column at the
  // minimum, and every row exactly as wide as the header list.
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

  // The editor's grid: header inputs over value rows, folded behind a disclosure. `onEdited` is the
  // editor's own dirty+persist tick, so every keystroke in here counts as unsaved work.
  function buildParamsControl({ seed = null, onEdited }) {
    let model = paramsModel(seed);
    const fromDraft = !!seed;
    // What the server holds, so Save writes only what actually changed. Empty until a read lands —
    // which is also what a create starts from.
    let baseHeaders = [];
    let baseRows = new Map();
    let ready = !!seed;   // the draft may carry the grid only once it stands for something
    let available = true; // false in basic mode: no session, no rows

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

    // The blank row is web parity: typing into it is what makes it a row, and the grid grows
    // another blank one under it. The keystroke that promoted it is already in the value.
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
    // The LAST column goes, values and all; one column always stays, or there is nothing to name.
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

    // Rebuilt whole on every change: a grid this small has nothing to gain from a diff, and one
    // rebuild is one place for the row order to be right.
    function render() {
      grid.replaceChildren();
      grid.style.gridTemplateColumns = `repeat(${model.headers.length}, minmax(88px, 1fr)) var(--tc-params-gutter)`;
      // The names ride in a box of their own so they can stay put while the values scroll under them;
      // the grid's own tracks reach through it (subgrid, editor.css), so the columns still line up.
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

    // Enter walks DOWN the column the tester is in — the blank row makes that always possible.
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
        rows.push({ id: row.id, cells });
      }
      const lastIn = (arr) => arr.reduce((last, v, i) => (v ? i : last), -1);
      const lastHeader = lastIn(headers);
      // Trailing columns nobody used are spares, not parameters — they never travel.
      const width = Math.max(lastHeader, rows.reduce((w, r) => Math.max(w, lastIn(r.cells)), -1)) + 1;
      if (rows.length && lastHeader === -1) { showError('Name the parameters first'); return null; }
      const kept = headers.slice(0, width);
      const unnamed = kept.findIndex((h) => !h);
      if (unnamed !== -1) { showError('Every parameter needs a name', unnamed); return null; }
      const writes = rows.map((r) => ({
        kind: r.id ? 'update' : 'create', id: r.id, cells: r.cells.slice(0, width),
      })).filter((w) => w.kind === 'create' || !sameCells(baseRows.get(w.id), w.cells));
      return {
        headers: kept,
        headersChanged: !sameCells(kept, baseHeaders),
        writes,
        deletes,
      };
    }

    // Sequential and best-effort, like the screenshot uploads: the first failure is what gets
    // reported, and the writes behind it still go out. Returns that message, or null.
    async function commit(uid, planned) {
      let failure = null;
      const fail = (e) => { if (!failure) failure = (e && e.message) || String(e); };
      if (planned.headersChanged) {
        try { await TestomatAPI.setTestParams(uid, planned.headers); } catch (e) { fail(e); }
      }
      for (const w of planned.writes) {
        try {
          if (w.kind === 'create') await TestomatAPI.createExample(uid, w.cells);
          else await TestomatAPI.updateExample(w.id, w.cells);
        } catch (e) { fail(e); }
      }
      for (const id of planned.deletes) {
        try { await TestomatAPI.deleteExample(id); } catch (e) { fail(e); }
      }
      return failure;
    }

    render();
    if (fromDraft && paramsHaveData(model)) setOpen(true);

    return {
      section,
      plan,
      commit,
      // What the server holds is the BASELINE even when the grid came back from a draft: the draft
      // is what the tester typed and outranks the server copy, exactly like title and markdown.
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
