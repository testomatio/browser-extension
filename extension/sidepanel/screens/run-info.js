// The Run info card: the model behind it, the rows it prints and its disclosure. Its own file, not
// the run screen's — livesync repaints it, app.js toggles it and core/storage.js saves the choice.

/* global state, $, Fmt, Tooltip, UserCell, StatusIcons, viewerTimezone, assigneeUser,
   assigneeName, persistSession, paintRunState */

// ---- Run info (#112) ----
// Two sources, no extra fetch: Status/Tests/Created/Description ride the v2 detail
// (so they survive basic mode); Duration/Executed/Started/Build URL are JWT-only.

// A matching key counts only if what it holds is person-shaped: `assignee_ids: [3,7]`
// contributes nobody, and "assign_mode": "none" is a setting, not a tester called none.
const FLAT_SETTING_KEY = /(strategy|mode|policy|method|kind|type|option|enabled|state|status|auto|allow)/i;
const FLAT_NOBODY = /^(none|nobody|no[-_\s]?one|unassigned|not[-_\s]?assigned|n\/?a|null|nil|false|true|any|all|auto|everyone|manual)$/i;

// Open by default; the toggle persists the choice (core/storage.js, restored at
// boot). Only an explicit close reads as closed, so a profile predating the key opens.
let runInfoOpen = true;

const RunInfo = {
  // A real accessor, not a data property: app.js writes it at boot and core/storage.js reads it
  // on every save, while the paint below reads the module `let` those two have to reach.
  get open() { return runInfoOpen; },
  set open(value) { runInfoOpen = value; },

  // The v2 half of the fields. Kept verbatim; formatting/skipping happens at render.
  fromDetail(detail) {
    const info = {
      status: detail.status || null,
      // v2 show merges response_test_counts — `total_tests` is the authoritative
      // count there (`tests_count` is the pre-merge value on the same payload).
      testsCount: Number(detail.total_tests ?? detail.tests_count),
      createdAt: detail.created_at || null,
      description: typeof detail.description === 'string' ? detail.description.trim() : '',
    };
    // The spellings seen first, then any key that MEANS the same thing; a key that
    // says nothing is left off — never written as null over what a read already found.
    const executedBy = UserCell.normalize(detail.executed_by ?? detail.launched_by ?? detail.user)
      || RunInfo.flatPeople(detail, /^(executed|launched|started|ran)(_by)?$/)[0];
    const createdBy = UserCell.normalize(detail.created_by ?? detail.author ?? detail.owner)
      || RunInfo.flatPeople(detail, /^(created_by|creator|author|owner)$/)[0];
    const assignees = RunInfo.flatPeople(detail, /assign/);
    if (executedBy) info.executedBy = executedBy;
    if (createdBy) info.createdBy = createdBy;
    if (assignees.length) info.assignees = assignees;
    // Both are v2's own fields (`to_response_hash` serves env + plans, verified live),
    // so they survive basic mode. Written only when the payload said something.
    const envs = RunInfo.envList(detail.env);
    const plans = RunInfo.planList(detail.plans ?? detail.plan ?? detail.test_plans ?? detail.test_plan);
    if (envs.length) info.envs = envs;
    if (plans.length) info.plans = plans;
    return info;
  },

  // v2 sends env as an array on some routes and as one comma-joined string on others.
  envList(env) {
    const raw = Array.isArray(env) ? env : String(env ?? '').split(',');
    return raw.map((one) => String(one ?? '').trim()).filter(Boolean);
  },

  // Nothing pins the plan shape on the flat payload — a title, a record, or a bare
  // id — so an entry that does not NAME a plan contributes nothing, not "4831".
  planList(plans) {
    const out = [];
    for (const one of Array.isArray(plans) ? plans : (plans == null ? [] : [plans])) {
      const title = typeof one === 'string' ? one.trim()
        : String(one?.title || one?.clean_title || one?.name || '').trim();
      if (title) out.push(title);
    }
    return out;
  },

  flatPeople(obj, pattern) {
    const out = [];
    for (const [key, value] of Object.entries(obj || {})) {
      if (!pattern.test(key) || /(^|_)ids?$|count/i.test(key)) continue;
      if (FLAT_SETTING_KEY.test(key)) continue;
      for (const one of Array.isArray(value) ? value : [value]) {
        const u = UserCell.normalize(one);
        if (!u) continue;
        if (!u.email && !/\p{L}/u.test(u.name)) continue;
        if (!u.email && FLAT_NOBODY.test(u.name.trim())) continue;
        out.push(u);
      }
    }
    return out;
  },

  // Web parity (#200): the ACCOUNT PROFILE timezone, not the machine's. `lll` is
  // `MMM D, YYYY h:mm A` — en-US adds a comma before the hour, so parts are assembled.
  formatTimeIn(iso, timeZone) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', timeZone ? { ...opts, timeZone } : opts).formatToParts(d);
    } catch { parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d); }
    const p = {};
    for (const part of parts) p[part.type] = part.value;
    return `${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
  },

  // null on an absent or unparseable value, which drops the whole row.
  time(iso) {
    if (!iso) return null;
    const text = RunInfo.formatTimeIn(iso, viewerTimezone());
    if (!text) return null;
    const span = document.createElement('span');
    span.className = 'run-info-time';
    span.dataset.time = iso; // the raw stamp, zone- and locale-free
    Tooltip.set(span, iso);
    span.textContent = text;
    return span;
  },

  // Only http(s): the value is server data, and `javascript:` is the hole an href must not open.
  ciBuildLink(url) {
    const raw = typeof url === 'string' ? url.trim() : '';
    if (!/^https?:\/\//i.test(raw)) return null;
    const a = document.createElement('a');
    a.className = 'run-info-link';
    a.href = raw;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    Tooltip.set(a, raw);       // the raw URL is a tooltip, never the label (#112)
    a.append('Open CI build ', StatusIcons.svgIcon('open_in_new', 14, 'link-out-icon'));
    return a;
  },

  // The whole string rides the tooltip: a pill too long for the panel is cut, not widened.
  tags(list) {
    if (!list.length) return null;
    const box = document.createElement('span');
    box.className = 'env-tags';
    for (const name of list) {
      const pill = document.createElement('span');
      pill.className = 'badge env';
      pill.textContent = name;
      Tooltip.set(pill, name);
      box.append(pill);
    }
    return box;
  },

  statusCell(status) {
    const span = document.createElement('span');
    span.className = 'status-text';
    span.dataset.status = StatusIcons.normStatus(status);
    span.append(StatusIcons.statusIcon(status));
    const label = document.createElement('span');
    label.textContent = status;
    span.append(label);
    return span;
  },

  // Resolved through the project's members: only that read carries the AVATAR (the
  // run payload names people, it does not describe them). What the payload said wins.
  user(person) {
    const u = UserCell.normalize(person);
    if (!u) return null;
    const member = u.email ? assigneeUser(u.email) : null;
    return UserCell.cell({
      name: u.name || member?.name || assigneeName(u.email),
      email: u.email || member?.email || '',
      avatar: u.avatar || member?.avatar || '',
    });
  },

  // The union of both places the answer lives: a run can be handed to a tester who
  // holds no row, and a row to somebody the run itself never named. Keyed by address.
  assignees() {
    const people = [...(state.runInfo?.assignees || []), ...state.records.map((r) => r.assigned_to)];
    const seen = new Set();
    const cells = [];
    for (const person of people) {
      const u = UserCell.normalize(person);
      if (!u) continue;
      const key = (u.email || u.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = RunInfo.user(u);
      if (cell) cells.push(cell);
    }
    if (cells.length === 0) return null;
    const box = document.createElement('span');
    box.className = 'user-cells';
    box.append(...cells);
    return box;
  },

  // A MEASUREMENT, not a head count (the panel is resizable): the list wraps, so a
  // box taller than one of its cells is one that did not fit. Needs a VISIBLE body.
  measurePeople() {
    const body = $('run-info-body');
    if (!body || body.hidden) return;
    for (const box of body.querySelectorAll('.user-cells:not(.is-stacked)')) {
      const first = box.firstElementChild;
      if (!first) continue;
      if (box.getBoundingClientRect().height > first.getBoundingClientRect().height + 1) {
        box.classList.add('is-stacked');
      }
    }
  },

  // #159: a reporter can write a whole session report here, so the value renders clamped.
  description(text) {
    const el = document.createElement('div');
    el.className = 'run-info-desc-text is-clamped';
    el.textContent = text;
    return el;
  },

  descExpander(text) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'link-btn run-info-desc-more';
    more.textContent = 'Show more';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const clamped = text.classList.toggle('is-clamped');
      more.textContent = clamped ? 'Show more' : 'Show less';
      more.setAttribute('aria-expanded', clamped ? 'false' : 'true');
    });
    return more;
  },

  // Needs the section open — a hidden body has no layout to measure.
  measureDesc() {
    const body = $('run-info-body');
    if (!body || body.hidden) return;
    const text = body.querySelector('.run-info-desc-text');
    if (!text || !text.classList.contains('is-clamped')) return;
    if (text.scrollHeight <= text.clientHeight + 1) return; // sub-pixel line heights
    if (!text.parentElement.querySelector('.run-info-desc-more')) {
      text.after(RunInfo.descExpander(text));
    }
  },

  // Ordered [label, value] pairs; a null/empty value drops its row entirely.
  rows() {
    const info = state.runInfo || {};
    const started = RunInfo.time(info.launchedAt);
    const finished = RunInfo.time(info.finishedAt);
    const rows = [];
    if (info.status) rows.push(['Status', RunInfo.statusCell(info.status)]);
    // Duration is SECONDS here (RunSerializer), ms in Fmt.humanDuration; 0 while unfinished.
    if (info.duration > 0) rows.push(['Duration', Fmt.humanDuration(info.duration * 1000)]);
    // Never below the checklist: the server's count trails the rows after a run is created.
    const tests = Math.max(Number(info.testsCount) || 0, state.records.length);
    if (tests > 0) rows.push(['Tests', String(tests)]);
    // The web's own order: Environment then Test plan, under Tests.
    const envs = RunInfo.tags(info.envs || []);
    if (envs) rows.push(['Environment', envs]);
    if (info.plans && info.plans.length) rows.push(['Test plan', info.plans.join(', ')]);
    // Web parity: a finished run shows the executed span, a live one just its start.
    if (started && finished) {
      const span = document.createDocumentFragment();
      // Bare glyph: the row is a flex line (`.kv.rows`), so the gap is the cell's own.
      span.append(started, '→', finished);
      rows.push(['Executed', span]);
    } else if (started) {
      rows.push(['Started', started]);
    }
    const executedBy = RunInfo.user(info.executedBy);
    if (executedBy) rows.push(['Executed by', executedBy]);
    const assignees = RunInfo.assignees();
    if (assignees) rows.push(['Assigned to', assignees]);
    const link = RunInfo.ciBuildLink(info.ciBuildUrl);
    if (link) rows.push(['Build URL', link]);
    // One row — the web's "Created by <person>, <date>"; nobody named → the date alone.
    const created = RunInfo.time(info.createdAt);
    const createdBy = RunInfo.user(info.createdBy);
    if (createdBy) {
      const made = document.createDocumentFragment();
      made.append(createdBy);
      if (created) made.append(created);
      rows.push(['Created by', made]);
    } else if (created) {
      rows.push(['Created', created]);
    }
    if (info.description) rows.push(['Description', RunInfo.description(info.description)]);
    return rows;
  },

  render() {
    const box = $('run-info');
    const body = $('run-info-body');
    if (!box || !body) return;
    paintRunState(); // the same fields feed the card's status pill — repaint together
    const rows = RunInfo.rows();
    box.hidden = rows.length === 0; // nothing read (meta failed) → no empty section
    body.replaceChildren();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (typeof value === 'string') dd.textContent = value;
      else dd.append(value);
      if (label === 'Description') dd.classList.add('run-info-desc');
      body.append(dt, dd);
    }
    RunInfo.paint();
  },

  paint() {
    const head = $('run-info-head');
    const body = $('run-info-body');
    if (head) head.setAttribute('aria-expanded', runInfoOpen ? 'true' : 'false');
    if (body) body.hidden = !runInfoOpen;
    // Both measures need a VISIBLE body — a hidden one has no layout to read.
    RunInfo.measurePeople();
    RunInfo.measureDesc();
  },

  toggle() {
    runInfoOpen = !runInfoOpen;
    RunInfo.paint();
    persistSession(); // the user's choice outlives this panel (#112)
  },
};
