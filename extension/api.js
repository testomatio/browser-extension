// Testomat API client: Public API v2 (raw token as Bearer, flat snake_case) plus the Web-UI JSON:API
// (JWT from POST /api/login) for what v2 lacks — the v2 attachments route 404s on prod.
//
// One credential covers both: an account session (a JWT from `/app-auth`, or one exchanged from a
// General token) opens the JSON:API directly AND can read any project's own v2 key on demand. So
// the tester signs in once and v2 keys are minted, never typed. A handed-off config
// (shared/handoff.js) is the same session arriving from a host app instead of a paste box.

/* global ApiErrors, ApiTransport, ApiPaging, ApiPeople, ApiNormalize, ApiAssets */

const TestomatAPI = (() => {
  let cfg = null; // { baseUrl, apiToken, projectId } (+ a handoff's projectToken/projectTokenFor)
  // v2 keys read off the projects endpoint, one per project. Memory-only and per boot: they are
  // the project's own credential, and nothing here needs them to outlive the panel.
  const v2Keys = new Map();
  const { signedAssets } = ApiAssets;
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
  // The host, so a tester reading either verdict below knows WHICH server refused them.
  const instanceHost = () => ApiErrors.instanceHost(cfg?.baseUrl);
  const READONLY_MESSAGE = (status) => ApiErrors.readonlyMessage(instanceHost(), status);
  const ROUTE_REFUSED = (status) => ApiErrors.routeRefused(instanceHost(), status);

  const { ApiError, toError } = ApiErrors;

  function configure(c) {
    const next = c ? { ...c, baseUrl: c.baseUrl?.replace(/\/+$/, '') } : null;
    // A minted key belongs to the account that minted it, so another instance or another
    // credential invalidates the lot. A project switch does not — this runs on every tab change.
    if (!next || next.baseUrl !== cfg?.baseUrl || next.apiToken !== cfg?.apiToken) {
      v2Keys.clear();
      signedAssets.clear(); // another instance signed nothing of ours
    }
    cfg = next;
    jwt = null;
    jwtUid = null;
    jwtAvailable = 'unknown';
    readonly = 'unknown'; // re-probed against the new instance/project
  }

  // The host's session token, adopted by login() instead of POST /api/login. Kept apart from
  // configure() so a project switch does not drop it.
  function useHandoffSession(token) {
    if (token !== handedJwt) { v2Keys.clear(); signedAssets.clear(); }
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

  const { rawFetch, LONG_TIMEOUT_MS } = ApiTransport;
  // When the instance last answered 429, after ApiTransport had already waited out its retries.
  // The panel's live sync reads it to slow its own polling instead of adding to the flood.
  const rateLimitedAt = () => ApiTransport.rateLimitedAt();

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

  // The cheapest read v2 has — validate()'s own call, shared so the corroboration cannot drift from it.
  const RUNS_PING = { query: { per_page: 1 } };
  // ONE in flight: racing 403s must not fire two probes, nor the probe's own 403 a third.
  let readonlyCheck = null;
  function projectIsReadonly() {
    if (!readonlyCheck) {
      readonlyCheck = request('/runs', { ...RUNS_PING, corroborate403: false })
        .then(() => false, (e) => e?.status === 403) // any other failure proves nothing — stay unlocked
        .finally(() => { readonlyCheck = null; });
    }
    return readonlyCheck;
  }

  async function request(path, { method = 'GET', body, query, corroborate403 = true } = {}) {
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
    // Only a plain read answering 403 too proves read-only: a proxy, WAF or SSO gateway refuses ONE route.
    if (res.status === 403) {
      // Already proven: what clears the flag is a 2xx below, so re-probing it buys nothing.
      if (readonly === true) throw new ApiError('readonly', 403, READONLY_MESSAGE(403));
      if (corroborate403 && await projectIsReadonly()) {
        readonly = true;
        throw new ApiError('readonly', 403, READONLY_MESSAGE(403));
      }
      throw new ApiError('auth', 403, ROUTE_REFUSED(403)); // the kind toError() gives a 403 anywhere else
    }
    if (!res.ok) throw await toError(res);
    readonly = false; // a v2 answer at all proves the project is not read-only
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  const { drain, pageResult, PAGE_GUARD, DASH_KEYS, GROUP_KEYS } = ApiPaging;
  const pagedData = (path, query) => drain(request, path, query);

  const validate = () => request('/runs', RUNS_PING);
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
  const { normSuiteNode, orderSuiteTree, normDashRun, normDashGroup, testrunExampleOf } = ApiNormalize;

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
  async function jwtSend(url, { method = 'GET', body, timeout } = {}) {
    const doReq = () => rawFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      timeout, // undefined leaves rawFetch's ordinary budget in place
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

  // ---- paged list results (#110) ------------------------------------------
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

  const { runInfoOf } = ApiPeople;

  const getRunInfo = (runId) => jwtRequest(`/runs/${encodeURIComponent(runId)}`).then(runInfoOf);

  // ---- parametrized run rows (#52) — JSON:API only ----
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
      timeout: LONG_TIMEOUT_MS, // the model runs server-side; timing it out loses the recorded steps
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
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}` },
          body: formData,
          timeout: LONG_TIMEOUT_MS, // a recording is megabytes, not a JSON row
        },
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
  // The 403 being EXPECTED here, it opts out of the read-only corroboration instead of provoking a probe.
  async function deleteAttachment(testrunId, attachmentId) {
    guardConfigured();
    const id = encodeURIComponent(String(attachmentId));
    try {
      return await request(`/attachments/${id}`, {
        method: 'DELETE', query: { testrun_id: testrunId }, corroborate403: false,
      });
    } catch (e) {
      const st = e && e.status;
      if (st !== 403 && st !== 404 && st !== 405) throw e;
    }
    return jwtRequest(`/attachments/${id}`, { method: 'DELETE' });
  }

  // The live session these three read: cfg's base URL, the JWT in hand and the login that mints it.
  const { assetUrl, fetchAsset, presignArtifact } = ApiAssets.create({
    baseUrl: () => cfg?.baseUrl,
    jwt: () => jwt,
    jwtAvailable: () => jwtAvailable,
    login,
    jwtRequest,
    rawFetch,
    timeout: LONG_TIMEOUT_MS,
  });

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
    // recheckAccess is the corroboration read on its own: the panel's read-only watch shares its
    // coalescing, and reads the VERDICT off readonlyAccess() — only a 2xx in there clears the flag.
    readonlyAccess: () => readonly, recheckAccess: projectIsReadonly, rateLimitedAt, ApiError,
  };
})();
