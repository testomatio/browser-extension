// Testomat API client: Public API v2 (raw token as Bearer, flat snake_case) plus the Web-UI JSON:API
// (JWT from POST /api/login) for what v2 lacks — the v2 attachments route 404s on prod.
//
// One credential covers both: an account session (a JWT from `/app-auth`, or one exchanged from a
// General token) opens the JSON:API directly AND can read any project's own v2 key on demand. So
// the tester signs in once and v2 keys are minted, never typed. A handed-off config
// (shared/handoff.js) is the same session arriving from a host app instead of a paste box.

const TestomatAPI = (() => {
  let cfg = null; // { baseUrl, apiToken, projectId } (+ a handoff's projectToken/projectTokenFor)
  // v2 keys read off the projects endpoint, one per project. Memory-only and per boot: they are
  // the project's own credential, and nothing here needs them to outlive the panel.
  const v2Keys = new Map();
  // The live session. Memory-only: it is either adopted from the tester's stored credential or
  // exchanged from their General token, and neither is worth a second copy on disk.
  let jwt = null;
  // A host app's session token. Memory-only like `jwt`, but it outlives configure(): it belongs to
  // the host that launched this browser, not to whichever project the panel is pointed at.
  let handedJwt = null;
  let jwtUid = null; // the JWT's own `user_id` claim — memory-only like the JWT
  // 'unknown' until the first login attempt, then true (session) | false (degraded).
  let jwtAvailable = 'unknown';
  // #155: v2 answers 403 to EVERY request — GET included — for read-only access (reader role,
  // company-readonly account, archived project), while a rejected token is a 401 instead.
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
    const next = c ? { ...c, baseUrl: c.baseUrl?.replace(/\/+$/, '') } : null;
    // A minted key belongs to the account that minted it, so another instance or another
    // credential invalidates the lot. A project switch does not — this runs on every tab change.
    if (!next || next.baseUrl !== cfg?.baseUrl || next.apiToken !== cfg?.apiToken) v2Keys.clear();
    cfg = next;
    jwt = null;
    jwtUid = null;
    jwtAvailable = 'unknown';
    readonly = 'unknown'; // re-probed against the new instance/project
  }

  // The host's session token, adopted by login() instead of POST /api/login. Kept apart from
  // configure() so a project switch does not drop it.
  function useHandoffSession(token) {
    if (token !== handedJwt) v2Keys.clear();
    handedJwt = token || null;
    jwt = null;
    jwtUid = null;
    jwtAvailable = 'unknown';
  }

  // A session token, not a v2 credential: `eyJ` is a JWT, whoever it came from.
  const isSessionToken = (t) => typeof t === 'string' && t.startsWith('eyJ');

  const NO_PROJECT_KEY = 'This project has no API key for your role — ask an owner, or pick '
    + 'another project';

  /** Whether there is anything at all to authenticate with. */
  const hasCredential = () => !!(cfg?.apiToken || cfg?.projectToken || handedJwt);

  // A v2 credential already in hand: the handoff's project token while the panel is on the project
  // it was issued for, one minted earlier, or a General token, which reaches every project.
  function v2TokenInHand() {
    if (cfg?.projectToken && cfg.projectTokenFor === cfg.projectId) return cfg.projectToken;
    const minted = v2Keys.get(cfg?.projectId);
    if (minted) return minted;
    if (cfg?.apiToken && !isSessionToken(cfg.apiToken)) return cfg.apiToken;
    return null;
  }

  // …and if there is none, the session reads the project's own key. That is what lets a tester who
  // has only signed in — no General token anywhere — use v2 at all.
  async function v2Token() {
    const inHand = v2TokenInHand();
    if (inHand) return inHand;
    const doc = await jwtRequestRoot(`/projects/${encodeURIComponent(cfg.projectId)}`);
    const attrs = doc?.data?.attributes || {};
    const key = attrs['api-key'] || attrs.api_key;
    // A role without API access answers the project fine and simply carries no key.
    if (!key) throw new ApiError('auth', 403, NO_PROJECT_KEY);
    v2Keys.set(cfg.projectId, key);
    return key;
  }

  async function rawFetch(url, opts) {
    try {
      return await fetch(url, opts);
    } catch {
      throw new ApiError('network', 0, 'Network error');
    }
  }

  function guardConfigured() {
    if (!cfg?.baseUrl || !hasCredential() || !cfg?.projectId) {
      throw new ApiError('unconfigured', 0, 'Not configured');
    }
  }

  // login + api-root routes carry no slug, so they need only the base URL and something to open a
  // session with — the tester's own credential (a session token, or a General token to exchange),
  // or the one a host handed us (the project picker runs before any slug is known).
  function guardSession() {
    if (!cfg?.baseUrl || !(cfg?.apiToken || handedJwt)) {
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
        Authorization: `Bearer ${await v2Token()}`,
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

  // Drain EVERY page of a v2 index; per_page 100 is the server cap. The end of the data is the only
  // stop (a short page, or `meta.total` reached) — PAGE_GUARD is a runaway guard, not a limit.
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
  // #110: `render_index` caps per_page at 100 (default 30) and answers meta {total, page, per_page}.
  // Both lists below are the DEGRADED (no-JWT) runs list source.
  const V2_RUNS_PER_PAGE = 50;
  const V2_GROUPS_PER_PAGE = 100;
  const listRuns = (page = 1, perPage = V2_RUNS_PER_PAGE) =>
    request('/runs', { query: { page, per_page: perPage, 'filter[archived]': false } });
  // Rungroups (folders), roots only — folded client-side by rungroup_id on the runs list (verified live).
  const listRunGroups = (page = 1, perPage = V2_GROUPS_PER_PAGE) =>
    request('/rungroups', { query: { page, per_page: perPage } });
  // One row fetched purely for `meta.total`: the v2 index counts runs only (no folders among the
  // rows, unlike /runs/dashboard) and honours the archived filter. null when the server has no total.
  const countRuns = () =>
    request('/runs', { query: { page: 1, per_page: 1, 'filter[archived]': false } })
      .then((r) => (r?.meta?.total != null ? Number(r.meta.total) : null));
  const getRun = (id) => request(`/runs/${encodeURIComponent(id)}`).then((r) => r?.data);
  // A run's test list IS its testrun records — web-created manual runs pre-create them.
  const listTestruns = (runId) => pagedData('/testruns', { run_id: runId });
  const getTestrun = (id) => request(`/testruns/${encodeURIComponent(id)}`).then((r) => r?.data);
  const getTest = (id) => request(`/tests/${encodeURIComponent(id)}`).then((r) => r?.data);

  // ---- TC Studio (M3) — suites + per-suite tests + create/update ----
  // GET /suites/tree (JWT) answers a BARE ARRAY of roots — no `data` envelope, camelCase keys, children
  // nested inline, leaves without a `children` key. A raw v2 token on this route answers 403.
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
  // Drains the JSON:API suites index — the ONE read carrying `position`, `data[].id` being the same public
  // uid as a tree node's. A FIXED 50 rows a page, `per_page` ignored (verified live), so none is sent.
  async function getSuitePositions() {
    const positions = new Map();
    const take = (doc) => {
      for (const s of Array.isArray(doc?.data) ? doc.data : []) {
        positions.set(String(s.id), Number(s.attributes?.position)); // NaN is fine — the sorter reads it as 0
      }
    };
    const first = await jwtRequest('/suites?page=1');
    take(first);
    // Page 1's `meta.total_pages` counts the rest; they go out at once, PAGE_GUARD being the runaway stop.
    const pages = Math.min(Number(first?.meta?.total_pages) || 1, PAGE_GUARD);
    const rest = await Promise.all(
      Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => jwtRequest(`/suites?page=${i + 2}`)),
    );
    rest.forEach(take);
    return positions;
  }
  // Every level in the web's order — `position` ascending, ties and unknown ids as the server sent them (#26).
  function orderSuiteTree(nodes, positions) {
    const pos = (n) => {
      const p = positions.get(String(n.id));
      return Number.isFinite(p) ? p : 0;
    };
    return (nodes || [])
      .map((n) => ({ ...n, children: orderSuiteTree(n.children, positions) }))
      .sort((a, b) => pos(a) - pos(b));
  }
  // The tree as the Tests tab and the pickers draw it. /suites/tree orders by `abs_position`, which the
  // web's drag-reorder leaves stale on the shifted siblings, so the rows are re-sorted by `position` —
  // the web's own key (#26). Both reads go out together, and positions failing leaves the server's order.
  async function getSuiteTreeOrdered() {
    const [roots, positions] = await Promise.all([getSuiteTree(), getSuitePositions().catch(() => null)]);
    return positions ? orderSuiteTree(roots, positions) : roots;
  }
  // Flat v2 POST; absent fields are omitted — title-only creates a root `file` suite.
  // `fileType` is 'folder' (grouping node) or 'file' (TC container).
  const createSuite = ({ title, parentId, fileType } = {}) => {
    const body = { title };
    if (parentId) body.parent_id = parentId;
    if (fileType) body.file_type = fileType;
    return request('/suites', { method: 'POST', body }).then((r) => r?.data);
  };
  // Subtree-wide. MUST send `suites[]=` — a bare `suites=<id>` yields a 500. Ordered created_at DESC.
  const getTestsBySuite = (suiteId) => pagedData('/tests', { 'suites[]': suiteId });
  // Flat payload; `suite_id` is REQUIRED — missing or unknown answers 404 "Suite is required".
  const createTest = (attrs) =>
    request('/tests', { method: 'POST', body: attrs }).then((r) => r?.data);
  // One web /bulk request creates the whole list in order, appended at the suite's end (verified live).
  // Titles go out as JSON-quoted YAML scalars, so ':' '#' '@' and quotes survive.
  const bulkCreateTests = (suiteId, titles) => jwtRequest('/bulk', {
    method: 'POST',
    body: { append: true, suite: suiteId, yaml: titles.map((t) => `- ${JSON.stringify(t)}`).join('\n') + '\n' },
  });
  // PATCH takes any SUBSET of the create payload; sending `suite_id` would MOVE the test, so the
  // editor never does. 404 for an unknown/deleted uid.
  const updateTest = (id, attrs) =>
    request(`/tests/${encodeURIComponent(id)}`, { method: 'PATCH', body: attrs })
      .then((r) => r?.data);

  // ---- test parameters + examples (#5) — JSON:API only, v2 serves neither ----
  // A test's `params` are the COLUMN NAMES; each example is one row, `data` positional to them.
  // The rows ride the test document as `included` resources (verified live on beta).
  async function getTestParams(uid) {
    const doc = await jwtRequest(`/tests/${encodeURIComponent(uid)}`);
    const attrs = doc?.data?.attributes || {};
    const examples = (doc?.included || [])
      .filter((n) => n.type === 'example')
      .map((n) => ({ id: String(n.id), data: (n.attributes && n.attributes.data) || [] }));
    return { params: Array.isArray(attrs.params) ? attrs.params : [], examples };
  }
  // ONLY `params` travels: title and description stay as they are (verified). `[]` clears them.
  const setTestParams = (uid, params) =>
    jwtRequest(`/tests/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      body: { data: { id: String(uid), type: 'test', attributes: { params } } },
    });
  // One row. Empty cells are KEPT server-side, so a half-filled row cannot slide its values under
  // the wrong column; an EMPTY `data` array is refused (400 "Data can't be empty"), and each cell
  // is truncated to 250 chars.
  async function createExample(uid, data) {
    const doc = await jwtRequest('/examples', {
      method: 'POST',
      body: {
        data: {
          type: 'example',
          attributes: { data },
          relationships: { test: { data: { type: 'test', id: String(uid) } } },
        },
      },
    });
    return { id: String(doc?.data?.id), data: doc?.data?.attributes?.data || [] };
  }
  const updateExample = (id, data) =>
    jwtRequest(`/examples/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { data: { id: String(id), type: 'example', attributes: { data } } },
    });
  const deleteExample = (id) =>
    jwtRequest(`/examples/${encodeURIComponent(id)}`, { method: 'DELETE' });

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

  // A session token is adopted, never exchanged — there is nothing to exchange it for. Once,
  // though: jwtSend re-enters login() on a 401/403, and handing back the same dead token would
  // both fail again and re-arm `jwtAvailable`, so nothing would ever degrade.
  const HANDED_EXPIRED = 'The session handed to this panel has expired — reconnect from the app '
    + 'that opened it';
  const OWN_EXPIRED = 'Your session has expired — authorize again in Settings';

  // Lazy token→session upgrade; any failure marks the session unavailable so callers can degrade.
  async function login() {
    guardSession();
    // A host's session outranks a stored one: it is what THIS browser was opened for.
    const session = handedJwt || (isSessionToken(cfg.apiToken) ? cfg.apiToken : null);
    if (session) {
      if (jwt === session) {
        jwtAvailable = false;
        throw new ApiError('auth', 401, handedJwt ? HANDED_EXPIRED : OWN_EXPIRED);
      }
      jwt = session;
      jwtUid = decodeJwtUserId(jwt);
      jwtAvailable = true;
      return jwt;
    }
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

  // The JWT's own `user_id` claim (base64url). null rather than throwing: this identity is
  // cosmetic (the viewer's profile timezone, #200), never an authorization decision.
  function decodeJwtUserId(token) {
    try {
      const payload = String(token).split('.')[1];
      if (!payload) return null;
      const id = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))?.user_id;
      return id == null ? null : String(id);
    } catch { return null; }
  }

  // Lazy login, then ONE re-login + retry on 401 or 403 — an expired JWT answers 403 here (unlike
  // v2, where 403 means read-only). `url` is prebuilt: the project base or the api root.
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

  // JSON:API on the API ROOT {baseUrl}/api — routes like /projects/{slug} sit OUTSIDE the project namespace.
  function jwtRequestRoot(path, opts) {
    guardSession();
    return jwtSend(`${cfg.baseUrl}/api${path}`, opts);
  }

  // `attributes.run-replies` groups the substatus options by status (the panel's substatus dropdown).
  function getProjectInfo() {
    guardConfigured();
    return jwtRequestRoot(`/projects/${encodeURIComponent(cfg.projectId)}`);
  }

  // Pending testruns auto-transition to skipped server-side; v2 counts lag, so callers re-read /testruns.
  function finishRun(runId) {
    return jwtRequest(`/runs/${encodeURIComponent(runId)}`, {
      method: 'PUT',
      body: { data: { id: String(runId), type: 'runs', attributes: { 'status-event': 'finish_manual' } } },
    });
  }

  // ---- dashboard parity (JWT, project base) — Phase 3 ----
  // The web endpoint unions top-level runs + root rungroups and applies the `.branched` scope v2
  // lacks. Attributes are dasherized; `env` on children arrives as an array (["Chrome"]).
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
      // Folder emoji: the v2 `/rungroups` row carries it; where this leg does not, null keeps the glyph.
      emoji: a.emoji || null,
    };
  }

  // ---- paged list results (#110) ------------------------------------------
  // Three meta dialects, verified live on prod: /runs/dashboard camelCase, perPage HARDCODED 30 (param
  // ignored); /runs?group_id= snake_case, per_page honoured (default 50); /rungroups?groupId= fixed at 30.
  const pageResult = (items, page, meta, keys) => ({
    items,
    page: Number(meta?.[keys.page] ?? page) || page,
    perPage: meta?.[keys.perPage] != null ? Number(meta[keys.perPage]) : null,
    total: meta?.[keys.total] != null ? Number(meta[keys.total]) : null,
    totalPages: meta?.[keys.totalPages] != null ? Number(meta[keys.totalPages]) : null,
  });
  const DASH_KEYS = { page: 'page', perPage: 'perPage', total: 'totalCount', totalPages: 'totalPages' };
  const GROUP_KEYS = { page: 'page', perPage: 'per_page', total: 'num', totalPages: 'total_pages' };

  async function fetchDashboardPage(page = 1) {
    const doc = await jwtRequest(`/runs/dashboard?page=${encodeURIComponent(page)}`);
    const items = (doc?.data || []).map((n) => (n.type === 'rungroup' ? normDashGroup(n) : normDashRun(n)));
    return pageResult(items, page, doc?.meta, DASH_KEYS);
  }
  // A group's child runs, one page. Omitted, `perPage` is 50 server-side — a caller that paged with
  // an explicit size MUST keep passing it so page 2 lines up.
  async function fetchGroupChildren(groupId, page = 1, perPage = null) {
    const per = perPage ? `&per_page=${encodeURIComponent(perPage)}` : '';
    const doc = await jwtRequest(`/runs?group_id=${encodeURIComponent(groupId)}&page=${encodeURIComponent(page)}${per}`);
    return pageResult((doc?.data || []).map(normDashRun), page, doc?.meta, GROUP_KEYS);
  }

  // ALL descendant runs at ANY depth via `nested=true` — feeds the filter-chip counts before any
  // group is expanded. Snake_case meta, default per_page 50.
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
  // The list serializer under-reports subgroup counts (runs-count reads 0 even with nested runs),
  // so counts are nulled here and the renderer hides the badge instead of showing a wrong number.
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

  // `path` is the ancestor chain root-first, excluding self — one request resolves a nested group's
  // whole chain for URL paste (verified live). [] when absent.
  async function getRunGroup(groupId) {
    const doc = await jwtRequest(`/rungroups/${encodeURIComponent(groupId)}`);
    const node = doc?.data;
    if (!node) throw new ApiError('notfound', 404, 'Group not found');
    const g = normDashGroup(node);
    const raw = node.attributes?.path;
    g.path = Array.isArray(raw) ? raw.map((p) => p?.id).filter((id) => id != null) : [];
    return g;
  }

  // Resolves the v2 `assigned_to` email to a name. `timezone` is the member's profile zone, already
  // IANA-mapped server-side — the panel stamps everything in the VIEWER's one (#200).
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

  // The JWT JSON:API PUT is the ONLY path that broadcasts the change to other web clients. Body MUST
  // be dasherized (flat → 400); the write value is the user id, while the read side echoes an email.
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

  // `id` is the project SLUG (the v2 base path), `attributes.title` the display name. per_page caps
  // at 200 — verified live, a bigger ask is clamped, not honoured — so every page is drained.
  const PROJECTS_PER_PAGE = 200;
  async function listProjects() {
    const all = [];
    let totalPages = Infinity;
    let total = Infinity;
    for (let page = 1; page <= PAGE_GUARD; page++) {
      let doc;
      try {
        doc = await jwtRequestRoot(`/projects?page=${page}&per_page=${PROJECTS_PER_PAGE}`);
      } catch (e) {
        // The FIRST page carries the verdict Settings validates the token on, so it must surface;
        // a tail dying mid-drain must not — the projects in hand beat an empty picker.
        if (page === 1) throw e;
        break;
      }
      const rows = Array.isArray(doc?.data) ? doc.data : [];
      all.push(...rows.map((n) => {
        const a = n.attributes || {};
        // `tests-count` rides along on the index (#10); null when the server sent none.
        return { id: String(n.id), title: a.title || '', testsCount: a['tests-count'] ?? null };
      }));
      const meta = doc?.meta || {};
      if (typeof meta.total_pages === 'number') totalPages = meta.total_pages;
      if (typeof meta.num === 'number') total = meta.num;
      if (rows.length < PROJECTS_PER_PAGE || page >= totalPages || all.length >= total) break;
    }
    return all;
  }

  // The fields v2 does not serialize at all, in ONE read: substatus counters (#109, keyed by the RAW
  // reply string), ci-build-url/duration/launched-at/finished-at (#112), is-archived (#186).
  function runInfoOf(doc) {
    const attrs = doc?.data?.attributes || {};
    const raw = attrs['substatuses-counts'];
    let substatusCounts = null; // null (not {}) = the payload carries no counters at all
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
      // null (not false) when omitted, so a write response cannot silently unlock an archived run.
      isArchived: attrs['is-archived'] == null ? null : !!attrs['is-archived'],
      ciBuildUrl: attrs['ci-build-url'] || null,
      duration: Number(attrs.duration) || 0, // seconds (RunSerializer), 0 while unfinished
      launchedAt: attrs['launched-at'] || null,
      finishedAt: attrs['finished-at'] || null,
      ...runPeopleOf(doc),
    };
  }

  // WHO — executed-by / created-by, read DEFENSIVELY: a person reaches this payload as a string, as a
  // record, or as a relationship into `included`, and no contract pins which. Absent → null.
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

  // Everyone a single value names — a person, a list, a JSON:API reference, or a list of those.
  function peopleOf(doc, value) {
    const list = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return list.map((v) => personOf(v) || personOf(includedRef(doc, v))).filter(Boolean);
  }

  // Safety net for key spellings we have not measured. A name-matching key can hold two things that
  // are NOT people: a setting ("assign-mode":"none" once drew a tester "none") and the word for nobody.
  const SETTING_KEY = /(strategy|mode|policy|method|kind|type|option|enabled|state|status|auto|allow)/i;
  const NOBODY = /^(none|nobody|no[-_\s]?one|unassigned|not[-_\s]?assigned|n\/?a|null|nil|false|true|any|all|auto|everyone|manual)$/i;
  function peopleByKey(doc, pattern) {
    const attrs = doc?.data?.attributes || {};
    const rels = doc?.data?.relationships || {};
    const out = [];
    const seen = new Set();
    const take = (people) => {
      for (const p of people) {
        // Address-less and with no letter in the "name": a bare id, not a person.
        if (!p.email && !/\p{L}/u.test(p.name)) continue;
        // …and neither is the payload's word for nobody; a real person keeps their address.
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

  // The run's OWN assignees — NOT the same set as the people its tests are assigned to.
  // undefined (not []) when the payload says nothing, so a merge cannot blank an earlier read.
  function runAssigneesOf(doc) {
    const found = peopleByKey(doc, /assign/i);
    return found.length ? found : undefined;
  }

  // Fallback patterns for the two single people, used only where the named spellings found nobody.
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
      // These are MERGED over the open run's info, so a write response that omits people must not blank it.
      if (found) people[field] = found;
    }
    const assignees = runAssigneesOf(doc);
    if (assignees) people.assignees = assignees;
    return people;
  }

  const getRunInfo = (runId) => jwtRequest(`/runs/${encodeURIComponent(runId)}`).then(runInfoOf);

  // ---- parametrized run rows (#52) — JSON:API only ----
  // `attributes.example` is the ARRAY of values, positional to `attributes.test.params`. A plain
  // OBJECT (param → value) is taken defensively, its own keys being the names then. null = not one.
  function testrunExampleOf(attrs) {
    const raw = attrs?.example;
    if (Array.isArray(raw)) {
      const values = raw.map((v) => String(v ?? '')); // numbers and booleans come through as values
      if (!values.some((v) => v !== '')) return null;
      const params = attrs?.test?.params;
      return { values, params: Array.isArray(params) ? params.map(String) : null };
    }
    if (raw && typeof raw === 'object') {
      const entries = Object.entries(raw).filter(([, v]) => v != null && String(v) !== '');
      if (!entries.length) return null;
      return { values: entries.map(([, v]) => String(v)), params: entries.map(([k]) => String(k)) };
    }
    return null;
  }

  // The example values of a run's rows, keyed by testrun id — what tells N same-titled rows of a
  // parametrized test apart. v2 `/testruns` serializes neither, so this is the only source.
  async function listTestrunExamples(runId) {
    const map = {};
    const take = (doc) => {
      for (const n of Array.isArray(doc?.data) ? doc.data : []) {
        const example = testrunExampleOf(n.attributes);
        if (example) map[String(n.id)] = example;
      }
    };
    const path = `/testruns?run_id=${encodeURIComponent(runId)}`;
    const first = await jwtRequest(`${path}&page=1`);
    take(first);
    // Page 1's `meta.total_pages` counts the rest; they go out at once, PAGE_GUARD being the runaway stop.
    const pages = Math.min(Number(first?.meta?.total_pages) || 1, PAGE_GUARD);
    const rest = await Promise.all(
      Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => jwtRequest(`${path}&page=${i + 2}`)),
    );
    rest.forEach(take);
    return map;
  }

  // The server also auto-writes a `change` audit extra alongside this — expected, not an error.
  function setSubstatus(testrunId, value) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/substatus`, {
      method: 'PUT', body: { value },
    });
  }
  function clearSubstatus(testrunId) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/substatus`, { method: 'DELETE' });
  }

  // #116: `bulk_update`, not create — only it inserts `source: :user`, and the web Meta section hides
  // `system` rows. `oldKey` === `key` makes the write a REPLACE instead of stacking a duplicate row.
  function setTestrunMeta(testrunId, entries) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/bulk_update`, {
      method: 'POST',
      body: { metafields: entries.map(([key, value]) => ({ key, value, oldKey: key })) },
    });
  }

  // Matching is by `pos` only — re-POSTing the same pos replaces the entry. The server does NOT
  // validate the status enum, so the caller must restrict it to passed|failed|skipped.
  function setStep(testrunId, { title, status, pos }) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/steps`, {
      method: 'POST',
      body: { step: { title, status, pos } },
    });
  }

  // ---- project templates (#104) — JSON:API (JWT, project base) -----------
  // `?kind=` FALLS BACK to every standard kind when nothing matches, hence the re-check below.
  // `attributes.document` stays null here (recombination needs a linking record) — `body` is the seed.
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

  // ---- AI prompts (#23) — the instance's own endpoint, JSON:API (JWT, project base) ----
  // The prompt lives SERVER-side: `message` is the recorded actions, the answer carries the
  // rewritten section in `data.polished_steps` (and the same text between markers in `text`).
  async function polishRecordedSteps(message, testId) {
    const doc = await jwtRequest('/prompts', {
      method: 'POST',
      body: { prompt: 'polish_recorded_steps', message, ...(testId ? { test_id: testId } : {}) },
    });
    return { text: (doc && doc.text) || '', steps: doc?.data?.polished_steps || '' };
  }

  // Multipart upload, one retry on a fresh JWT. The endpoint accepts any file (image OR text/plain —
  // verified live); `scope` is the owning collection, 'testruns' or 'tests'.
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

  // Removing one attachment from a result. TWO routes, because the two halves of this API
  // disagree about where attachments live: v2 documents
  // `DELETE /api/v2/{project}/attachments/{id}?testrun_id=…` (it is what the Testomat MCP server
  // calls), while the UPLOAD above had to fall back to the Web-UI route because v2's POST 404s on
  // prod. So v2 is asked first and a "route is not here" answer — 403 (a read-only v2 token answers
  // that to everything, #155), 404, 405 — hands over to the JSON:API the panel already writes with.
  // Only the SECOND failure reaches the caller: a delete that no route accepts must not read as done.
  async function deleteAttachment(testrunId, attachmentId) {
    guardConfigured();
    const id = encodeURIComponent(String(attachmentId));
    try {
      return await request(`/attachments/${id}`, { method: 'DELETE', query: { testrun_id: testrunId } });
    } catch (e) {
      const st = e && e.status;
      if (st !== 403 && st !== 404 && st !== 405) throw e;
    }
    return jwtRequest(`/attachments/${id}`, { method: 'DELETE' });
  }

  // #21: on a private bucket the server presigns only the first artifacts of a result and flags the
  // rest `needs_presign` — this mints the signed URL for one of those, on demand.
  async function presignArtifact(url) {
    const doc = await jwtRequest('/artifacts/presign', { method: 'POST', body: { url } });
    return (doc && doc.url) || '';
  }

  // ---- product assets (description images, result attachments) -------------
  // #205: content URLs come both absolute (`<instance>/attachments/{uid}.png`) and ROOT-RELATIVE
  // (`/rails/active_storage/…`) — a relative one resolves against the INSTANCE, never the document.
  function assetUrl(raw) {
    const base = cfg?.baseUrl ? `${cfg.baseUrl}/` : '';
    try { return new URL(String(raw), base || undefined).toString(); } catch { return ''; }
  }

  // SECURITY: the JWT rides along ONLY for the configured instance — a presigned bucket link carries
  // its own signature. `instanceOnly` refuses off-instance URLs: authored markdown can plant a beacon.
  async function fetchAsset(raw, { instanceOnly = false } = {}) {
    const url = assetUrl(raw);
    if (!url) throw new ApiError('http', 0, 'Unresolvable asset URL');
    const ours = !!cfg?.baseUrl && (url === cfg.baseUrl || url.startsWith(`${cfg.baseUrl}/`));
    if (instanceOnly && !ours) throw new ApiError('http', 0, 'Off-instance asset refused');
    const doGet = () => rawFetch(url, {
      credentials: 'omit',
      headers: ours && jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
    });
    // Basic mode (no session) still tries: a signed bucket link needs no login at all.
    if (ours && !jwt && jwtAvailable !== false) await login().catch(() => {});
    let res = await doGet();
    if (ours && jwt && (res.status === 401 || res.status === 403)) {
      await login().catch(() => {});
      res = await doGet();
    }
    return res;
  }

  return {
    configure, useHandoffSession, validate, listRuns, listRunGroups, countRuns, getRun, listTestruns,
    getTestrun, getTest, getSuiteTree, getSuiteTreeOrdered, createSuite, getTestsBySuite, createTest, bulkCreateTests, updateTest,
    getTestParams, setTestParams, createExample, updateExample, deleteExample,
    setStatus, setStep, uploadAttachment, uploadTestAttachment, deleteAttachment,
    assetUrl, fetchAsset, presignArtifact,
    jwtRequest, jwtRequestRoot, getProjectInfo, finishRun,
    fetchDashboardPage, fetchGroupChildren, fetchGroupRunsNested, fetchGroupSubgroups, getRunGroup,
    setSubstatus, clearSubstatus, setTestrunMeta, getRunInfo, runInfoOf, listTestrunExamples,
    listProjectUsers, listProjects, assignTestrun,
    listTemplates, polishRecordedSteps,
    jwtAvailable: () => jwtAvailable, jwtUserId: () => jwtUid,
    readonlyAccess: () => readonly, ApiError,
  };
})();
