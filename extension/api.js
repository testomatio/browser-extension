// Testomat API client — the one place in the extension that talks to an instance.
// Reads/writes: Public API v2, raw user token as Bearer (flat snake_case JSON).
// Uploads only: Web-UI JSON:API endpoint with a JWT from POST /api/login
// (v2 attachments route is not deployed on prod — verified live, it 404s).

const TestomatAPI = (() => {
  let cfg = null; // { baseUrl, apiToken, projectId }
  let jwt = null; // memory-only (never chrome.storage); JSON:API + uploads
  let jwtUid = null; // the JWT's own `user_id` claim — memory-only like the JWT
  // Session-upgrade state: 'unknown' until the first
  // login attempt, then true (session available) | false (degraded).
  let jwtAvailable = 'unknown';
  // Read-only access (#155): v2 answers 403 to EVERY request — GET included —
  // for a reader-role member, a company-readonly account or an archived project
  // (Api::V2::BaseController#set_project!, 'Read-only users cannot access this
  // API'), while a rejected token is a 401. So a v2 403 is not an auth failure
  // to send the tester to Settings with: it is the one signal that says this
  // project is read-only, and the panel locks itself out of it on this flag.
  let readonly = 'unknown'; // 'unknown' until a v2 call answers | true | false
  const READONLY_MESSAGE = 'Your access to this project is read-only';

  class ApiError extends Error {
    constructor(kind, status, detail) {
      super(detail || kind);
      this.kind = kind; // unconfigured | network | auth | readonly | notfound | http
      this.status = status;
    }
  }

  function configure(c) {
    cfg = c ? { ...c, baseUrl: c.baseUrl?.replace(/\/+$/, '') } : null;
    jwt = null;
    jwtUid = null;
    jwtAvailable = 'unknown';
    readonly = 'unknown'; // re-probed against the new instance/project
  }

  async function rawFetch(url, opts) {
    try {
      return await fetch(url, opts);
    } catch {
      throw new ApiError('network', 0, 'Network error');
    }
  }

  function guardConfigured() {
    if (!cfg?.baseUrl || !cfg?.apiToken || !cfg?.projectId) {
      throw new ApiError('unconfigured', 0, 'Not configured');
    }
  }

  // Session-only guard: login + api-root routes carry any slug in the path, so
  // they need just the base URL + token (the project picker runs before a slug
  // is known). Project-scoped callers keep guarding with guardConfigured().
  function guardSession() {
    if (!cfg?.baseUrl || !cfg?.apiToken) {
      throw new ApiError('unconfigured', 0, 'Not configured');
    }
  }

  async function toError(res) {
    if (res.status === 401 || res.status === 403) {
      return new ApiError('auth', res.status, 'Token invalid or has no access');
    }
    if (res.status === 404) {
      // Valid token without project membership also yields 404 (research R6).
      return new ApiError('notfound', 404, 'Not found — or no access to this project');
    }
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* empty body */ }
    return new ApiError('http', res.status, detail || `HTTP ${res.status}`);
  }

  async function request(path, { method = 'GET', body, query } = {}) {
    guardConfigured();
    const url = new URL(`${cfg.baseUrl}/api/v2/${cfg.projectId}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== null && v !== undefined) url.searchParams.set(k, v);
      }
    }
    const res = await rawFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // #155: 403 here means read-only access, never a bad token (that is a 401).
    if (res.status === 403) { readonly = true; throw new ApiError('readonly', 403, READONLY_MESSAGE); }
    if (!res.ok) throw await toError(res);
    readonly = false; // a v2 answer at all proves the project is not read-only
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  // Drain EVERY page of a v2 index (per_page 100 = the server cap). Callers get
  // a complete list, so no "Load more" is needed for them (#110 audit): the
  // run's test list and a suite's TCs are always fully loaded. The end of the
  // data is the ONLY stop: a short page, or `meta.total` reached. The page
  // ceiling below is a runaway guard, not a limit — a fixed one (it used to be
  // 50) silently truncates any run past 100 × ceiling and reports the remainder
  // as if it never existed.
  const PAGE_GUARD = 1000;
  async function pagedData(path, query = {}) {
    const all = [];
    let total = Infinity;
    for (let page = 1; page <= PAGE_GUARD; page++) {
      const res = await request(path, { query: { ...query, page, per_page: 100 } });
      const items = res?.data || [];
      all.push(...items);
      if (typeof res?.meta?.total === 'number') total = res.meta.total;
      if (items.length < 100 || all.length >= total) break;
    }
    return all;
  }

  const validate = () => request('/runs', { query: { per_page: 1 } });
  // v2 index pages (#110): `render_index` caps per_page at 100 (default 30) and
  // answers `meta: {total, page, per_page}` — enough to know whether a tail
  // exists. Both lists below are the DEGRADED (no-JWT) runs list source.
  const V2_RUNS_PER_PAGE = 50;
  const V2_GROUPS_PER_PAGE = 100;
  const listRuns = (page = 1, perPage = V2_RUNS_PER_PAGE) =>
    request('/runs', { query: { page, per_page: perPage, 'filter[archived]': false } });
  // Rungroups (folders). Folded client-side by rungroup_id on the runs list
  // (verified live). Roots-only, paged the same way.
  const listRunGroups = (page = 1, perPage = V2_GROUPS_PER_PAGE) =>
    request('/rungroups', { query: { page, per_page: perPage } });
  // How many runs the project HOLDS — the figure the web app's own Runs heading
  // carries. One row is fetched purely to read `meta.total` off it; the v2 index
  // counts runs only (no folders among the rows, unlike /runs/dashboard) and
  // honours the same archived filter the panel's list does, so the number is
  // comparable with what the list can eventually show. null when the server
  // reports no total — the caller must not guess one.
  const countRuns = () =>
    request('/runs', { query: { page: 1, per_page: 1, 'filter[archived]': false } })
      .then((r) => (r?.meta?.total != null ? Number(r.meta.total) : null));
  const getRun = (id) => request(`/runs/${encodeURIComponent(id)}`).then((r) => r?.data);
  // The run's test list IS its testrun records: web-created manual runs
  // pre-create them (checklist) — same source the web runner uses.
  const listTestruns = (runId) => pagedData('/testruns', { run_id: runId });
  const getTestrun = (id) => request(`/testruns/${encodeURIComponent(id)}`).then((r) => r?.data);
  const getTest = (id) => request(`/tests/${encodeURIComponent(id)}`).then((r) => r?.data);

  // ---- TC Studio (M3) — suites + per-suite tests + create/update ----
  // Every shape below was verified against a live instance, not inferred.
  // Suite tree: built by the SERVER (#114) — JSON:API (JWT) GET /suites/tree
  // returns a BARE ARRAY of roots (no `data` envelope), ordered by
  // `abs_position`, scoped to the current branch, children nested inline; leaf
  // nodes omit the `children` key entirely. Keys are camelCase there, so they
  // are normalized here to the snake_case node the renderer speaks. No v2
  // fallback: after #103 the general token always yields a JWT (a raw v2 token
  // on this route answers 403).
  function normSuiteNode(n) {
    return {
      id: n.id,
      title: n.title || '',
      file_type: n.fileType === 'folder' ? 'folder' : 'file',
      test_count: n.testCount ?? 0,
      emoji: n.emoji || null,
      children: (n.children || []).map(normSuiteNode),
    };
  }
  async function getSuiteTree() {
    const roots = await jwtRequest('/suites/tree');
    return Array.isArray(roots) ? roots.map(normSuiteNode) : [];
  }
  // Create a suite/folder — flat v2 POST. Omit absent fields (title-only creates
  // a root `file` suite). `parentId` nests under a folder; `fileType` is 'folder'
  // (grouping node) or 'file' (TC container). Response echoes id/file_type/
  // parent_id (011 research R1, live-smoked). Still the v2 Bearer path — only
  // the tree re-read that follows a create is JWT.
  const createSuite = ({ title, parentId, fileType } = {}) => {
    const body = { title };
    if (parentId) body.parent_id = parentId;
    if (fileType) body.file_type = fileType;
    return request('/suites', { method: 'POST', body }).then((r) => r?.data);
  };
  // Per-suite TCs (subtree-wide). MUST send the `suites[]=` array param — a bare
  // `suites=<id>` string yields a 500 (research R1). Ordered created_at DESC.
  const getTestsBySuite = (suiteId) => pagedData('/tests', { 'suites[]': suiteId });
  // Create a TC — flat payload, `suite_id` REQUIRED (missing/unknown → 404
  // "Suite is required"). attrs: {title, suite_id, description, priority}.
  const createTest = (attrs) =>
    request('/tests', { method: 'POST', body: attrs }).then((r) => r?.data);
  // No updateTest: the panel creates and reads test cases, it never edits them
  // (#115 — editing lives in the web app).

  // POST-create on first result, PUT afterwards (confirmed in T004 smoke).
  function setStatus({ testrunId, runId, testId, status, message }) {
    const payload = { status, message: message || undefined };
    if (testrunId) {
      return request(`/testruns/${encodeURIComponent(testrunId)}`, { method: 'PUT', body: payload })
        .then((r) => r?.data);
    }
    return request('/testruns', {
      method: 'POST',
      body: { run_id: runId, test_id: testId, ...payload },
    }).then((r) => r?.data);
  }

  // Lazy token->session upgrade. Any failure (http or network) marks the
  // session unavailable so callers can degrade (US6 / FR-012).
  async function login() {
    guardSession();
    let res;
    try {
      res = await rawFetch(`${cfg.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_token: cfg.apiToken }),
      });
    } catch (e) { jwtAvailable = false; throw e; }
    if (!res.ok) { jwtAvailable = false; throw await toError(res); }
    jwt = (await res.json().catch(() => null))?.jwt;
    if (!jwt) { jwtAvailable = false; throw new ApiError('auth', 0, 'Login returned no JWT'); }
    jwtUid = decodeJwtUserId(jwt);
    jwtAvailable = true;
    return jwt;
  }

  // Who the session belongs to, read from the JWT's own payload (claims are
  // `{ user_id, ... }`, auth_controller). Base64url, and a token this cannot parse
  // yields null instead of throwing: the identity is cosmetic here (the viewer's
  // profile timezone, #200), never an authorization decision.
  function decodeJwtUserId(token) {
    try {
      const payload = String(token).split('.')[1];
      if (!payload) return null;
      const id = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))?.user_id;
      return id == null ? null : String(id);
    } catch { return null; }
  }

  // Shared JSON:API send with the session JWT. Lazy-logs in on the first call;
  // on 401 AND 403 (expired JWT -> 403, per contract) re-logs in once and
  // retries once, then surfaces the failure. `url` is prebuilt so callers can
  // target either the per-project base or the api root (see jwtRequestRoot).
  async function jwtSend(url, { method = 'GET', body } = {}) {
    const doReq = () => rawFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!jwt) await login();
    let res = await doReq();
    if (res.status === 401 || res.status === 403) {
      await login();
      res = await doReq();
    }
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  // JSON:API (web) request on the PROJECT base {baseUrl}/api/{project}.
  function jwtRequest(path, opts) {
    guardConfigured();
    return jwtSend(`${cfg.baseUrl}/api/${cfg.projectId}${path}`, opts);
  }

  // JSON:API request on the API ROOT base {baseUrl}/api — for project-level
  // routes like /projects/{slug} that sit OUTSIDE the per-project namespace
  // (substatus options ride on the project's `run-replies` attribute there).
  function jwtRequestRoot(path, opts) {
    guardSession();
    return jwtSend(`${cfg.baseUrl}/api${path}`, opts);
  }

  // Project info (JWT, api root): `attributes.run-replies` groups the substatus
  // options by status; consumed by the panel's substatus dropdown (US4).
  function getProjectInfo() {
    guardConfigured();
    return jwtRequestRoot(`/projects/${encodeURIComponent(cfg.projectId)}`);
  }

  // Finalize a manual run (US3). Pending testruns auto-transition to skipped
  // server-side; v2 counts lag, so callers re-read /testruns afterwards.
  function finishRun(runId) {
    return jwtRequest(`/runs/${encodeURIComponent(runId)}`, {
      method: 'PUT',
      body: { data: { id: String(runId), type: 'runs', attributes: { 'status-event': 'finish_manual' } } },
    });
  }

  // ---- dashboard parity (JWT, project base) — Phase 3 ----
  // The web runs page reads a dedicated endpoint that unions top-level runs +
  // root rungroups (web order) and applies the `.branched` scope v2 lacks.
  // Attributes are dasherized JSON:API — normalized to the shapes the runs
  // renderer already uses. `env` on children arrives as an array (["Chrome"]).
  const normEnv = (env) => (Array.isArray(env) ? env.filter(Boolean).join(', ') : env || '');

  function normDashRun(node) {
    const a = node.attributes || {};
    return {
      type: 'run', id: node.id, status: a.status, title: a.title,
      kind: a.kind, env: normEnv(a.env), rungroup_id: a['rungroup-id'] || null,
    };
  }
  function normDashGroup(node) {
    const a = node.attributes || {};
    return {
      type: 'rungroup', id: node.id, status: a.status, title: a.title,
      kind: a.kind, runs_count: a['runs-count'] ?? null, tests_count: a['tests-count'] ?? null,
      archived_at: a['archived-at'] || null,
      // The custom mark a project may have given this folder, which the runs
      // list draws instead of the folder glyph. The v2 `/rungroups` row carries
      // it (003 research R1); this JSON:API leg is expected to serialize the
      // same attribute, and where it does not the field is simply null and the
      // row keeps its glyph — never a guess.
      emoji: a.emoji || null,
    };
  }

  // ---- paged list results (#110) ------------------------------------------
  // Every list fetcher below answers a PAGE, not "the list": `{items, page,
  // perPage, total, totalPages}` with null where the server says nothing. The
  // runs list turns a `page < totalPages` into its "Load more" control instead
  // of silently truncating at page 1 (issue #110).
  //
  // The three server dialects, verified live on prod 2026-07-30:
  //   * `/runs/dashboard`     -> camelCase meta {page, perPage, totalCount, totalPages};
  //                              perPage is HARDCODED 30 server-side
  //                              (RunsDashboardListService#paginate) — a
  //                              per_page/perPage param is ignored.
  //   * `/runs?group_id=`     -> snake_case meta {page, per_page, num, total_pages};
  //                              `num` is the total, per_page defaults to 50 and
  //                              IS honoured (runs_controller#index).
  //   * `/rungroups?groupId=` -> snake_case meta {num, total_pages} only; the
  //                              controller pages the children WITHOUT `.per()`,
  //                              so the size is Kaminari's default 30 and a
  //                              per_page param is ignored (rungroups_controller#index).
  const pageResult = (items, page, meta, keys) => ({
    items,
    page: Number(meta?.[keys.page] ?? page) || page,
    perPage: meta?.[keys.perPage] != null ? Number(meta[keys.perPage]) : null,
    total: meta?.[keys.total] != null ? Number(meta[keys.total]) : null,
    totalPages: meta?.[keys.totalPages] != null ? Number(meta[keys.totalPages]) : null,
  });
  const DASH_KEYS = { page: 'page', perPage: 'perPage', total: 'totalCount', totalPages: 'totalPages' };
  const GROUP_KEYS = { page: 'page', perPage: 'per_page', total: 'num', totalPages: 'total_pages' };

  // Page N of the web dashboard list (interleaved runs + root rungroups). Uses
  // the JWT wrapper's 401/403 re-login+retry. Base is the project jwtRequest.
  async function fetchDashboardPage(page = 1) {
    const doc = await jwtRequest(`/runs/dashboard?page=${encodeURIComponent(page)}`);
    const items = (doc?.data || []).map((n) => (n.type === 'rungroup' ? normDashGroup(n) : normDashRun(n)));
    return pageResult(items, page, doc?.meta, DASH_KEYS);
  }
  // A group's child runs (JWT), one page. Same controller as dashboard; `env` is
  // an array. `perPage` is optional — omitted the server uses 50; a caller that
  // paged with an explicit size MUST keep passing it so page 2 lines up.
  async function fetchGroupChildren(groupId, page = 1, perPage = null) {
    const per = perPage ? `&per_page=${encodeURIComponent(perPage)}` : '';
    const doc = await jwtRequest(`/runs?group_id=${encodeURIComponent(groupId)}&page=${encodeURIComponent(page)}${per}`);
    return pageResult((doc?.data || []).map(normDashRun), page, doc?.meta, GROUP_KEYS);
  }

  // ALL descendant runs of a group at ANY depth (JWT) — the `nested=true` scope
  // (research R8). Feeds the filter-chip counts before any group is expanded, so
  // counters reflect every run right after load. A separate cache from the lazy
  // direct-child loads above. Pages through the snake_case meta (`total_pages`,
  // `page`; default per_page 50). Rows normalized like the dashboard's runs.
  async function fetchGroupRunsNested(groupId) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const doc = await jwtRequest(
        `/runs?group_id=${encodeURIComponent(groupId)}&nested=true&page=${page}`,
      );
      const rows = doc?.data || [];
      all.push(...rows.map(normDashRun));
      const totalPages = doc?.meta?.total_pages;
      if (totalPages != null ? page >= totalPages : rows.length < 50) break;
    }
    return all;
  }

  // ---- nested rungroups (JWT, project base) — Phase 4 ----
  // A group's DIRECT child subgroups (folders), for the recursive tree. The list
  // serializer under-reports counts for subgroup rows (runs-count reads 0 even
  // with nested runs — smoke R7), so counts are nulled and the renderer hides the
  // badge rather than showing a misleading number.
  async function fetchGroupSubgroups(groupId, page = 1) {
    const doc = await jwtRequest(`/rungroups?groupId=${encodeURIComponent(groupId)}&page=${encodeURIComponent(page)}`);
    const items = (doc?.data || []).map((n) => {
      const g = normDashGroup(n);
      g.runs_count = null;
      g.tests_count = null;
      return g;
    });
    return pageResult(items, page, doc?.meta, GROUP_KEYS); // per_page absent here
  }

  // Rungroup detail (JWT). Returns the normalized group PLUS `path`: the ancestor
  // chain root-first (excludes self), mapped to ids — one request resolves a
  // nested group's whole chain for URL paste (verified live). [] when absent.
  async function getRunGroup(groupId) {
    const doc = await jwtRequest(`/rungroups/${encodeURIComponent(groupId)}`);
    const node = doc?.data;
    if (!node) throw new ApiError('notfound', 404, 'Group not found');
    const g = normDashGroup(node);
    const raw = node.attributes?.path;
    g.path = Array.isArray(raw) ? raw.map((p) => p?.id).filter((id) => id != null) : [];
    return g;
  }

  // Project members (JWT, project base). Normalized to {id,name,email,avatar,timezone}
  // (avatar may be absent → null); consumed by the run view's assignee chip to
  // resolve the v2 `assigned_to` email to a name. `timezone` is the member's profile
  // zone, already mapped to IANA by the server (user_serializer) — the panel formats
  // its stamps in the VIEWER's one (#200). Best-effort caller (degrades).
  async function listProjectUsers() {
    const doc = await jwtRequest('/users');
    const rows = Array.isArray(doc?.data) ? doc.data : [];
    return rows.map((n) => {
      const a = n.attributes || {};
      return {
        id: String(n.id), name: a.name || '', email: a.email || '',
        avatar: a.avatar || a['avatar-url'] || null, timezone: a.timezone || null,
      };
    });
  }

  // (Un)assign a testrun to a project user (M4). Web JWT JSON:API PUT — the ONLY
  // path that broadcasts the change to other web clients (v2 flat variant doesn't).
  // Body MUST be dasherized JSON:API (flat → 400, known rake, research R6-A); the
  // write value is the user **id** (read side echoes an email — R8). `userId` null
  // sends `assigned-to: null` → unassign.
  function assignTestrun(testrunId, userId) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}`, {
      method: 'PUT',
      body: {
        data: {
          id: String(testrunId),
          type: 'testrun',
          attributes: { 'assigned-to': userId == null || userId === '' ? null : String(userId) },
        },
      },
    });
  }

  // Project list (JWT, api root). The JSON:API /projects returns every project
  // the token can reach; `id` is the project SLUG (the v2 base path) and
  // `attributes.title` the display name. Feeds the settings project picker;
  // needs only the base URL + token (no slug yet). ApiError kinds surface as-is.
  async function listProjects() {
    const doc = await jwtRequestRoot('/projects');
    const rows = Array.isArray(doc?.data) ? doc.data : [];
    return rows.map((n) => ({ id: String(n.id), title: (n.attributes || {}).title || '' }));
  }

  // Everything the open run needs from the JSON:API (JWT) run detail, in ONE read:
  //   * the custom-status counters (#109) — the v2 run payload has no equivalent
  //     (only passed/failed/skipped counts). The run serializer emits
  //     `substatuses_counts` under its `detail` param and the show route always
  //     passes it (runs_controller#show). Shape: {"<substatus>": n} keyed by the RAW
  //     reply string — `set_key_transform :dash` dasherizes attribute NAMES only,
  //     never the values inside one. Zero/blank entries are dropped.
  //   * the Run info fields v2 does not serialize (#112): `ci-build-url`, `duration`
  //     (SECONDS), `launched-at`, `finished-at`. Status/tests/created/description
  //     come from the v2 detail run-view already reads, so those stay available in
  //     basic mode; only these four are session-only.
  //   * `is-archived` (#186) — the run's archived flag (`RunSerializer`), which the
  //     v2 payload does not carry at all. It rides this same read, so the archived
  //     write lock costs no extra fetch either; basic mode simply cannot see it.
  // One request feeds all of it — the run info costs no extra fetch on top of #109.
  //
  // Split in two so the run document a WRITE already answered with (finishRun)
  // can be folded in the same way, without re-reading the run. `substatusCounts`
  // is null — not {} — when the payload carries no counters attribute at all
  // (they are `detail`-gated in the serializer), so a caller can tell "no
  // substatus in this run" from "this payload doesn't say" and keep what it has.
  function runInfoOf(doc) {
    const attrs = doc?.data?.attributes || {};
    const raw = attrs['substatuses-counts'];
    let substatusCounts = null;
    if (raw && typeof raw === 'object') {
      substatusCounts = {};
      for (const [key, val] of Object.entries(raw)) {
        const n = Number(val);
        if (key && Number.isFinite(n) && n > 0) substatusCounts[key] = n;
      }
    }
    return {
      substatusCounts,
      status: attrs.status || null,
      // #186: the ONLY archived signal the panel has — the v2 run payload carries
      // no such flag. null (not false) when the payload omits it, so a write
      // response that skips the attribute cannot silently unlock an archived run.
      isArchived: attrs['is-archived'] == null ? null : !!attrs['is-archived'],
      ciBuildUrl: attrs['ci-build-url'] || null,
      duration: Number(attrs.duration) || 0, // seconds (RunSerializer), 0 while unfinished
      launchedAt: attrs['launched-at'] || null,
      finishedAt: attrs['finished-at'] || null,
      ...runPeopleOf(doc),
    };
  }

  // WHO — the two people the web run page names beside the dates: the tester who
  // executed the run and the one who created it.
  //
  // Read DEFENSIVELY, because a person reaches a JSON:API payload in more than
  // one shape and this one is not pinned by a contract: an attribute holding a
  // string (a name or an email), an attribute holding a record, or a proper
  // relationship pointing into `included`. Every shape is normalized to
  // `{name, email}` (shared/user-cell.js does the same reading on the render
  // side) and an absent person is simply null — the row is then skipped, exactly
  // like an empty Build URL. Nothing here can fail a run info read.
  const PERSON_KEYS = {
    executedBy: ['executed-by', 'launched-by', 'user'],
    createdBy: ['created-by', 'author', 'owner'],
  };

  // A `{name, email}` out of whatever `value` is, or null.
  function personOf(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const s = value.trim();
      if (!s) return null;
      return s.includes('@') ? { name: '', email: s } : { name: s, email: '' };
    }
    if (typeof value !== 'object') return null;
    const a = value.attributes || value; // a JSON:API resource, or a flat record
    const name = String(a.name || a.username || a.title || '').trim();
    const email = String(a.email || '').trim();
    return name || email ? { name, email } : null;
  }

  // A resource out of `included`, by its {type, id} reference.
  const includedRef = (doc, ref) =>
    (ref && (doc?.included || []).find((n) => n.type === ref.type && String(n.id) === String(ref.id))) || null;

  // The `included` user a relationship points at, by {type, id}.
  function includedPerson(doc, rel) {
    const ref = rel?.data;
    if (!ref || Array.isArray(ref)) return null;
    return personOf(includedRef(doc, ref));
  }

  // Everyone a single value names — one person, a list of them, a JSON:API
  // reference, or a list of those.
  function peopleOf(doc, value) {
    const list = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return list.map((v) => personOf(v) || personOf(includedRef(doc, v))).filter(Boolean);
  }

  // …and everyone the payload names under a key that MEANS what we are asking
  // for. The lists above name the spellings we have seen on prod; this is the
  // safety net under them, because the panel cannot smoke-test every deployment
  // and a field that silently reads empty on one of them is worse than a field
  // that guesses. A key is a candidate when its name matches, and it counts only
  // if what it holds is person-shaped — `assigned-to` holding a record or an
  // address answers, `assignee-ids` holding [3, 7] does not, and neither does a
  // count. So a wrong guess yields nothing rather than a row reading "12".
  //
  // Two things a matching key can hold that are NOT people, and both printed as
  // one before these guards: a SETTING about assigning ("assign-mode": "none" is
  // a strategy, and the panel drew it as a tester called "none", monogram NO),
  // and the word a payload uses for nobody. So a key whose name reads like a
  // switch is not a people list, and a bare word that means "nobody" is not a
  // name. Both tests are cheap and neither can drop a real person: somebody
  // actually assigned arrives with an address, or under a key from the named
  // lists above, which never reach here.
  const SETTING_KEY = /(strategy|mode|policy|method|kind|type|option|enabled|state|status|auto|allow)/i;
  const NOBODY = /^(none|nobody|no[-_\s]?one|unassigned|not[-_\s]?assigned|n\/?a|null|nil|false|true|any|all|auto|everyone|manual)$/i;
  function peopleByKey(doc, pattern) {
    const attrs = doc?.data?.attributes || {};
    const rels = doc?.data?.relationships || {};
    const out = [];
    const seen = new Set();
    const take = (people) => {
      for (const p of people) {
        // A bare id that happened to arrive as a string is not a person: without
        // an address, a "name" with no letter in it is a number wearing a hat.
        if (!p.email && !/\p{L}/u.test(p.name)) continue;
        // …and neither is the word for nobody, which only a nameless-address-less
        // person could not be: a real tester keeps their name even if it is "Nil".
        if (!p.email && NOBODY.test(p.name.trim())) continue;
        const key = (p.email || p.name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
    };
    for (const [key, value] of Object.entries(attrs)) {
      if (pattern.test(key) && !/(^|[-_])ids?$|count/i.test(key) && !SETTING_KEY.test(key)) {
        take(peopleOf(doc, value));
      }
    }
    for (const [key, rel] of Object.entries(rels)) {
      if (pattern.test(key) && !SETTING_KEY.test(key)) take(peopleOf(doc, rel?.data));
    }
    return out;
  }

  // WHO IT IS ON — the run's own assignees, which the web names beside the
  // dates and which are NOT the same set as the people its tests are assigned
  // to: a run can be handed to a tester who has not been given a single row yet.
  // A LIST, because every spelling of the key takes a plural. Undefined — not []
  // — when the payload says nothing at all, so a merge cannot blank a set an
  // earlier read found.
  function runAssigneesOf(doc) {
    const found = peopleByKey(doc, /assign/i);
    return found.length ? found : undefined;
  }

  // The fallback patterns for the two single people, used only where the named
  // spellings above found nobody.
  const PERSON_PATTERNS = {
    executedBy: /^(executed|launched|started|ran)([-_]?by)?$|^user$/i,
    createdBy: /^(created[-_]?by|creator|author|owner)$/i,
  };

  function runPeopleOf(doc) {
    const attrs = doc?.data?.attributes || {};
    const rels = doc?.data?.relationships || {};
    const people = {};
    for (const [field, keys] of Object.entries(PERSON_KEYS)) {
      let found = null;
      for (const key of keys) {
        found = personOf(attrs[key]) || includedPerson(doc, rels[key]);
        if (found) break;
      }
      if (!found) [found] = peopleByKey(doc, PERSON_PATTERNS[field]);
      // Only a payload that actually named somebody writes the field: these
      // extras are MERGED over the open run's info (applyRunInfo), and a write
      // response that omits people must not blank the two rows the read filled.
      if (found) people[field] = found;
    }
    const assignees = runAssigneesOf(doc);
    if (assignees) people.assignees = assignees;
    return people;
  }

  const getRunInfo = (runId) => jwtRequest(`/runs/${encodeURIComponent(runId)}`).then(runInfoOf);

  // Substatus write/clear (US4). The server also auto-writes a `change` audit
  // extra — expected, not an error.
  function setSubstatus(testrunId, value) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/substatus`, {
      method: 'PUT', body: { value },
    });
  }
  function clearSubstatus(testrunId) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/substatus`, { method: 'DELETE' });
  }

  // Custom testrun META keys (#116) — same controller as substatus, but the
  // `bulk_update` route, chosen over plain create for TWO server reasons that are
  // not obvious and were both verified live on prod:
  //  * SOURCE. The web Meta section renders only extras whose source is NOT
  //    `system` (Ember testrun.js `metafields`), and the section counter uses the
  //    same rule. `POST /testrun_extras` cannot set source — the controller
  //    permits key+value only, so the column keeps its `system` default — and
  //    `PUT /testrun_extras/:key` hardcodes `source: :system`. Only bulk_update
  //    inserts `source: :user`, i.e. only bulk_update produces a row the Meta
  //    section will show.
  //  * IDEMPOTENCE. Sending `oldKey` equal to `key` makes the write a REPLACE:
  //    the server soft-deletes the previous row for that key instead of adding a
  //    second one. Without it every re-mark of the same test would stack another
  //    duplicate row into Meta.
  // One request carries all the keys. `entries` is [[key, value], …].
  function setTestrunMeta(testrunId, entries) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/bulk_update`, {
      method: 'POST',
      body: { metafields: entries.map(([key, value]) => ({ key, value, oldKey: key })) },
    });
  }

  // Server-persisted step result (US1). Matching is by `pos` only; re-POSTing
  // the same pos replaces the entry (contract m1). The server does NOT validate
  // the status enum — the caller must restrict it to passed|failed|skipped.
  function setStep(testrunId, { title, status, pos }) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/steps`, {
      method: 'POST',
      body: { step: { title, status, pos } },
    });
  }

  // ---- project templates (#104) — JSON:API (JWT, project base) -----------
  // The per-project "New Test" templates managed in Testomat, the same endpoint
  // the web frontend reads. Replaces the extension's own local Settings blob.
  //
  // TWO server behaviours the caller must know (Api::TemplatesController#index,
  // verified live on prod):
  //  * `?kind=` is a filter that FALLS BACK: when nothing matches the kind the
  //    controller returns every standard kind instead (test+suite+defect+meta+
  //    code+notification-*), and for a Gherkin project the BDD kinds. A project
  //    with no test template would therefore hand us a defect body — so the kind
  //    is re-checked here and non-matching rows are dropped.
  //  * `attributes.document` (the recombined body) stays null on this route.
  //    Recombination needs a linking RECORD (`?test_id=`/`?suite_id=`…), which a
  //    not-yet-created test has none of — `attributes.body` is the seed.
  // Rows are normalized to {id,title,kind,body,isDefault}; `is-default` marks the
  // project's default (the server keeps at most one per kind).
  async function listTemplates(kind = 'test') {
    const doc = await jwtRequest(`/templates?kind=${encodeURIComponent(kind)}`);
    const rows = Array.isArray(doc?.data) ? doc.data : [];
    return rows.map((n) => {
      const a = n.attributes || {};
      return {
        id: String(n.id),
        title: a.title || '',
        kind: a.kind || '',
        body: a.body || '',
        isDefault: !!a['is-default'],
      };
    }).filter((t) => t.kind === kind);
  }

  // JSON:API multipart upload; retries once with a fresh JWT on auth failure. The
  // endpoint accepts any file (image OR text/plain — R1, verified live). `scope`
  // is the owning collection: 'testruns' (screenshots + evidence .txt) or 'tests'
  // (Block 5 — the promoted capture's screenshot; research 2026-07-23).
  async function uploadTo(scope, id, blob, filename) {
    guardConfigured();
    const doUpload = async () => {
      const formData = new FormData();
      formData.append('file', blob, filename);
      return rawFetch(
        `${cfg.baseUrl}/api/${cfg.projectId}/${scope}/${encodeURIComponent(id)}/attachment`,
        { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: formData },
      );
    };
    if (!jwt) await login();
    let res = await doUpload();
    if (res.status === 401 || res.status === 403) {
      await login();
      res = await doUpload();
    }
    if (!res.ok) throw await toError(res);
    return res.json(); // { url }
  }
  const uploadAttachment = (testrunId, blob, filename) => uploadTo('testruns', testrunId, blob, filename);
  const uploadTestAttachment = (testId, blob, filename) => uploadTo('tests', testId, blob, filename);

  // ---- product assets (description images, result attachments) -------------
  // Where a URL out of test CONTENT actually points. Two forms are live on prod
  // (measured 2026-08-13, #205): the description editor embeds the app-host
  // route `https://<instance>/attachments/{uid}.png`, and an older body carries
  // the ROOT-RELATIVE `/rails/active_storage/blobs/redirect/{signed}/{name}`.
  // A relative one is resolved against the configured INSTANCE, never against
  // the document — `chrome-extension://…/rails/…` is the 404 that rendered the
  // dev's image-only description as a blank box.
  function assetUrl(raw) {
    const base = cfg?.baseUrl ? `${cfg.baseUrl}/` : '';
    try { return new URL(String(raw), base || undefined).toString(); } catch { return ''; }
  }

  // …and fetching it. The session JWT rides along ONLY when the URL is the
  // configured instance: `/attachments/{uid}` is a session route (signed out it
  // answers 302 → the sign-in page, measured), while a presigned bucket link
  // carries its own signature and has no business seeing our token — the same
  // line shared/user-cell.js draws for avatars. Cookies never go either way
  // (`credentials: 'omit'`); the header is the whole authorization story.
  //
  // `instanceOnly` is the caller saying WHERE the URL came from, and it is a
  // security decision, not a convenience. A URL out of an API payload (an
  // attachment's `display_url`, a step artifact) was named by the product and
  // may live in its bucket. A URL out of AUTHORED MARKDOWN is a different animal:
  // `![](https://evil.example/px)` is a tracking beacon anyone with edit rights on
  // a test can plant, the one `img-src` was declared to stop (the e2e suite asserts
  // the CSP refusal), and "the extension talks only to the configured instance" is a
  // non-negotiable (constitution IV). So markdown images are fetched from the
  // instance or not at all — off-instance ones are REFUSED here, before any
  // request, and the caller shows the link instead.
  async function fetchAsset(raw, { instanceOnly = false } = {}) {
    const url = assetUrl(raw);
    if (!url) throw new ApiError('http', 0, 'Unresolvable asset URL');
    const ours = !!cfg?.baseUrl && (url === cfg.baseUrl || url.startsWith(`${cfg.baseUrl}/`));
    if (instanceOnly && !ours) throw new ApiError('http', 0, 'Off-instance asset refused');
    const doGet = () => rawFetch(url, {
      credentials: 'omit',
      headers: ours && jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
    });
    // A panel in basic mode (no session) still tries: a signed bucket link needs
    // no login at all, and the caller degrades honestly on whatever comes back.
    if (ours && !jwt && jwtAvailable !== false) await login().catch(() => {});
    let res = await doGet();
    if (ours && jwt && (res.status === 401 || res.status === 403)) {
      await login().catch(() => {});
      res = await doGet();
    }
    return res;
  }

  return {
    configure, validate, listRuns, listRunGroups, countRuns, getRun, listTestruns,
    getTestrun, getTest, getSuiteTree, createSuite, getTestsBySuite, createTest,
    setStatus, setStep, uploadAttachment, uploadTestAttachment,
    assetUrl, fetchAsset,
    jwtRequest, jwtRequestRoot, getProjectInfo, finishRun,
    fetchDashboardPage, fetchGroupChildren, fetchGroupRunsNested, fetchGroupSubgroups, getRunGroup,
    setSubstatus, clearSubstatus, setTestrunMeta, getRunInfo, runInfoOf,
    listProjectUsers, listProjects, assignTestrun,
    listTemplates,
    jwtAvailable: () => jwtAvailable, jwtUserId: () => jwtUid,
    readonlyAccess: () => readonly, ApiError,
  };
})();
