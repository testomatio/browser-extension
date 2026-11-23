/* global ApiErrors, ApiTransport, ApiPaging, ApiPeople, ApiNormalize, ApiAssets */

const TestomatAPI = (() => {
  let cfg = null; // { baseUrl, apiToken, projectId } (+ a handoff's projectToken/projectTokenFor)
  // Memory-only: a v2 key is the project's own credential and need not outlive the panel.
  const v2Keys = new Map();
  const { signedAssets } = ApiAssets;
  // Memory-only: adopted or exchanged from the stored credential, neither worth a second copy on disk.
  let jwt = null;
  // Memory-only, but outlives configure(): it belongs to the host app, not to the current project.
  let handedJwt = null;
  let jwtUid = null; // the JWT's own `user_id` claim — memory-only like the JWT
  // 'unknown' until the first login attempt, then true (session) | false (degraded).
  let jwtAvailable = 'unknown';
  // v2 answers 403 to every request (GET too) for read-only access, while a rejected token is a 401.
  let readonly = 'unknown'; // 'unknown' until a v2 call answers | true | false
  // The host, so the tester knows which server refused them.
  const instanceHost = () => ApiErrors.instanceHost(cfg?.baseUrl);
  const READONLY_MESSAGE = (status) => ApiErrors.readonlyMessage(instanceHost(), status);
  const ROUTE_REFUSED = (status) => ApiErrors.routeRefused(instanceHost(), status);

  const { ApiError, toError } = ApiErrors;

  function configure(c) {
    const next = c ? { ...c, baseUrl: c.baseUrl?.replace(/\/+$/, '') } : null;
    // Another instance or credential invalidates minted keys; a project switch (any tab change) doesn't.
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

  // Kept apart from configure() so a project switch does not drop the host's session.
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

  const hasCredential = () => !!(cfg?.apiToken || cfg?.projectToken || handedJwt);

  function v2TokenInHand() {
    if (cfg?.projectToken && cfg.projectTokenFor === cfg.projectId) return cfg.projectToken;
    const minted = v2Keys.get(cfg?.projectId);
    if (minted) return minted;
    if (cfg?.apiToken && !isSessionToken(cfg.apiToken)) return cfg.apiToken;
    return null;
  }

  // Else the session reads the project's own key: that is what lets a sign-in-only tester use v2.
  async function v2Token() {
    const inHand = v2TokenInHand();
    if (inHand) return inHand;
    const key = (await keyFromTokens()) || (await keyFromProject());
    // A role without API access has no token there and no key inside the project.
    if (!key) throw new ApiError('auth', 403, NO_PROJECT_KEY);
    v2Keys.set(cfg.projectId, key);
    return key;
  }

  // A 404 from /api/tokens/<slug> means no token, or a server without the route.
  async function keyFromTokens() {
    try {
      const doc = await jwtRequestRoot(`/tokens/${encodeURIComponent(cfg.projectId)}`);
      return doc?.api_key || null;
    } catch (e) {
      if (e?.kind === 'notfound') return null;
      throw e;
    }
  }

  // An older self-hosted server still carries the key inside the project.
  async function keyFromProject() {
    const doc = await jwtRequestRoot(`/projects/${encodeURIComponent(cfg.projectId)}`);
    const attrs = doc?.data?.attributes || {};
    return attrs['api-key'] || attrs.api_key || null;
  }

  const { rawFetch, LONG_TIMEOUT_MS } = ApiTransport;
  // Live sync reads it to slow its polling instead of adding to the flood.
  const rateLimitedAt = () => ApiTransport.rateLimitedAt();

  function guardConfigured() {
    if (!cfg?.baseUrl || !hasCredential() || !cfg?.projectId) {
      throw new ApiError('unconfigured', 0, 'Not configured');
    }
  }

  // Login and api-root routes carry no slug: the project picker runs before any slug is known.
  function guardSession() {
    if (!cfg?.baseUrl || !(cfg?.apiToken || handedJwt)) {
      throw new ApiError('unconfigured', 0, 'Not configured');
    }
  }

  // The cheapest v2 read, shared with validate() so the corroboration cannot drift from it.
  const RUNS_PING = { query: { per_page: 1 } };
  // One in flight: racing 403s must not fire two probes, nor the probe's own 403 a third.
  let readonlyCheck = null;
  function projectIsReadonly() {
    if (!readonlyCheck) {
      // `remint: false`: a read-only project 403s on every key, so re-minting per probe would churn forever.
      readonlyCheck = request('/runs', { ...RUNS_PING, corroborate403: false, remint: false })
        .then(() => false, (e) => e?.status === 403) // any other failure proves nothing — stay unlocked
        .finally(() => { readonlyCheck = null; });
    }
    return readonlyCheck;
  }

  async function request(path, opts = {}) {
    const { method = 'GET', body, query, corroborate403 = true, remint = true } = opts;
    guardConfigured();
    const url = new URL(`${cfg.baseUrl}/api/v2/${cfg.projectId}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== null && v !== undefined) url.searchParams.set(k, v);
      }
    }
    const token = await v2Token();
    // Only a key we minted can be replaced without asking anybody, so only it is retried silently.
    const minted = v2Keys.get(cfg.projectId) === token;
    // A rotated project key leaves open panels with a dead one; replay once, `remint: false` stops a loop.
    const rotateKey = () => {
      // Only if nobody re-minted underneath us: a sibling request's fresh key is not ours to discard.
      if (v2Keys.get(cfg.projectId) === token) v2Keys.delete(cfg.projectId);
      return request(path, { ...opts, remint: false });
    };
    const res = await rawFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // A rejected key is a 401 here (read-only is the 403 below): the unambiguous rotation signal.
    if (res.status === 401 && remint && minted) return rotateKey();
    // Only a plain read answering 403 too proves read-only: a proxy, WAF or SSO gateway refuses one route.
    if (res.status === 403) {
      // Already proven: what clears the flag is a 2xx below, so re-probing it buys nothing.
      if (readonly === true) throw new ApiError('readonly', 403, READONLY_MESSAGE(403));
      if (corroborate403 && await projectIsReadonly()) {
        readonly = true;
        throw new ApiError('readonly', 403, READONLY_MESSAGE(403));
      }
      // One route refused us: retry like a 401, after corroboration, or read-only projects re-mint forever.
      if (remint && minted) return rotateKey();
      throw new ApiError('auth', 403, ROUTE_REFUSED(403)); // the kind toError() gives a 403 anywhere else
    }
    if (!res.ok) throw await toError(res);
    readonly = false; // a v2 answer at all proves the project is not read-only
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  const { drain, mapLimit, pageResult, PAGE_GUARD, FANOUT_LIMIT, DASH_KEYS, GROUP_KEYS } = ApiPaging;
  const pagedData = (path, query) => drain(request, path, query);

  const validate = () => request('/runs', RUNS_PING);
  // `render_index` caps per_page at 100 (default 30) and answers meta {total, page, per_page}.
  const V2_RUNS_PER_PAGE = 50;
  const V2_GROUPS_PER_PAGE = 100;
  const listRuns = (page = 1, perPage = V2_RUNS_PER_PAGE) =>
    request('/runs', { query: { page, per_page: perPage, 'filter[archived]': false } });
  // Rungroups (folders), roots only, folded client-side by rungroup_id on the runs list.
  const listRunGroups = (page = 1, perPage = V2_GROUPS_PER_PAGE) =>
    request('/rungroups', { query: { page, per_page: perPage } });
  // One row for `meta.total`: the v2 index counts runs only and honours the archived filter.
  const countRuns = () =>
    request('/runs', { query: { page: 1, per_page: 1, 'filter[archived]': false } })
      .then((r) => (r?.meta?.total != null ? Number(r.meta.total) : null));
  const getRun = (id) => request(`/runs/${encodeURIComponent(id)}`).then((r) => r?.data);
  // A run's test list is its testrun records; web-created manual runs pre-create them.
  const listTestruns = (runId) => pagedData('/testruns', { run_id: runId });
  const getTestrun = (id) => request(`/testruns/${encodeURIComponent(id)}`).then((r) => r?.data);
  const getTest = (id) => request(`/tests/${encodeURIComponent(id)}`).then((r) => r?.data);

  const { normSuiteNode, orderSuiteTree, normDashRun, normDashGroup, testrunExampleOf } = ApiNormalize;

  async function getSuiteTree() {
    const roots = await jwtRequest('/suites/tree');
    return Array.isArray(roots) ? roots.map(normSuiteNode) : [];
  }
  // The only read carrying `position`; a fixed 50 rows a page, `per_page` ignored, so none is sent.
  async function getSuitePositions() {
    const positions = new Map();
    const take = (doc) => {
      for (const s of Array.isArray(doc?.data) ? doc.data : []) {
        positions.set(String(s.id), Number(s.attributes?.position)); // NaN is fine — the sorter reads it as 0
      }
    };
    const first = await jwtRequest('/suites?page=1');
    take(first);
    const pages = Math.min(Number(first?.meta?.total_pages) || 1, PAGE_GUARD);
    const rest = await mapLimit(
      Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => i + 2),
      FANOUT_LIMIT,
      (p) => jwtRequest(`/suites?page=${p}`),
    );
    rest.forEach(take);
    return positions;
  }
  // /suites/tree orders by `abs_position`, which drag-reorder leaves stale, so re-sort by `position`.
  async function getSuiteTreeOrdered() {
    const [roots, positions] = await Promise.all([getSuiteTree(), getSuitePositions().catch(() => null)]);
    return positions ? orderSuiteTree(roots, positions) : roots;
  }
  // Absent fields are omitted: title-only creates a root `file` suite.
  const createSuite = ({ title, parentId, fileType } = {}) => {
    const body = { title };
    if (parentId) body.parent_id = parentId;
    if (fileType) body.file_type = fileType;
    return request('/suites', { method: 'POST', body }).then((r) => r?.data);
  };
  // Must send `suites[]=`: a bare `suites=<id>` yields a 500. Ordered created_at desc.
  const getTestsBySuite = (suiteId) => pagedData('/tests', { 'suites[]': suiteId });
  // `suite_id` is required: missing or unknown answers 404 "Suite is required".
  const createTest = (attrs) =>
    request('/tests', { method: 'POST', body: attrs }).then((r) => r?.data);
  // Titles go out as JSON-quoted YAML scalars, so ':' '#' '@' and quotes survive.
  const bulkCreateTests = (suiteId, titles) => jwtRequest('/bulk', {
    method: 'POST',
    body: { append: true, suite: suiteId, yaml: titles.map((t) => `- ${JSON.stringify(t)}`).join('\n') + '\n' },
  });
  // PATCH takes any subset of the create payload; sending `suite_id` would move the test.
  const updateTest = (id, attrs) =>
    request(`/tests/${encodeURIComponent(id)}`, { method: 'PATCH', body: attrs })
      .then((r) => r?.data);

  // `params` are the column names; each example is a row, `data` positional, riding as `included`.
  async function getTestParams(uid) {
    const doc = await jwtRequest(`/tests/${encodeURIComponent(uid)}`);
    const attrs = doc?.data?.attributes || {};
    const examples = (doc?.included || [])
      .filter((n) => n.type === 'example')
      .map((n) => ({ id: String(n.id), data: (n.attributes && n.attributes.data) || [] }));
    return { params: Array.isArray(attrs.params) ? attrs.params : [], examples };
  }
  // Only `params` travels: title and description stay as they are. `[]` clears them.
  const setTestParams = (uid, params) =>
    jwtRequest(`/tests/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      body: { data: { id: String(uid), type: 'test', attributes: { params } } },
    });
  // Empty cells are kept so values can't slide columns; an empty `data` is refused, cells cut at 250.
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

  // POST creates on the first result, PUT afterwards.
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

  // Adopted once: jwtSend re-enters login() on 401/403, and the same dead token would never degrade.
  const HANDED_EXPIRED = 'The session handed to this panel has expired — reconnect from the app '
    + 'that opened it';
  const OWN_EXPIRED = 'Your session has expired — authorize again in Settings';

  // Lazy token→session upgrade; any failure marks the session unavailable so callers can degrade.
  async function login() {
    guardSession();
    // A host's session outranks a stored one: it is what this browser was opened for.
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

  // null rather than throwing: this identity is cosmetic (profile timezone), never an authorization.
  function decodeJwtUserId(token) {
    try {
      const payload = String(token).split('.')[1];
      if (!payload) return null;
      const id = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))?.user_id;
      return id == null ? null : String(id);
    } catch { return null; }
  }

  // One re-login + retry on 401 or 403: an expired JWT answers 403 here, unlike v2 (read-only).
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

  // JSON:API request on the project base {baseUrl}/api/{project}.
  function jwtRequest(path, opts) {
    guardConfigured();
    return jwtSend(`${cfg.baseUrl}/api/${cfg.projectId}${path}`, opts);
  }

  // JSON:API on the api root {baseUrl}/api: routes like /projects/{slug} sit outside the project.
  function jwtRequestRoot(path, opts) {
    guardSession();
    return jwtSend(`${cfg.baseUrl}/api${path}`, opts);
  }

  // `attributes.run-replies` groups the substatus options by status (the panel's substatus dropdown).
  function getProjectInfo() {
    guardConfigured();
    return jwtRequestRoot(`/projects/${encodeURIComponent(cfg.projectId)}`);
  }

  // Pending testruns auto-skip server-side; v2 counts lag, so callers re-read /testruns.
  function finishRun(runId) {
    return jwtRequest(`/runs/${encodeURIComponent(runId)}`, {
      method: 'PUT',
      body: { data: { id: String(runId), type: 'runs', attributes: { 'status-event': 'finish_manual' } } },
    });
  }

  async function fetchDashboardPage(page = 1) {
    const doc = await jwtRequest(`/runs/dashboard?page=${encodeURIComponent(page)}`);
    const items = (doc?.data || []).map((n) => (n.type === 'rungroup' ? normDashGroup(n) : normDashRun(n)));
    return pageResult(items, page, doc?.meta, DASH_KEYS);
  }
  // Omitted, `perPage` is 50 server-side: a caller that paged with a size must keep passing it.
  async function fetchGroupChildren(groupId, page = 1, perPage = null) {
    const per = perPage ? `&per_page=${encodeURIComponent(perPage)}` : '';
    const doc = await jwtRequest(`/runs?group_id=${encodeURIComponent(groupId)}&page=${encodeURIComponent(page)}${per}`);
    return pageResult((doc?.data || []).map(normDashRun), page, doc?.meta, GROUP_KEYS);
  }

  // All descendant runs at any depth via `nested=true`, for filter-chip counts before any group opens.
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

  // The list serializer under-reports subgroup counts, so they are nulled and the badge hidden.
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

  // `path` is the ancestor chain root-first, excluding self; one request resolves it for URL paste.
  async function getRunGroup(groupId) {
    const doc = await jwtRequest(`/rungroups/${encodeURIComponent(groupId)}`);
    const node = doc?.data;
    if (!node) throw new ApiError('notfound', 404, 'Group not found');
    const g = normDashGroup(node);
    const raw = node.attributes?.path;
    g.path = Array.isArray(raw) ? raw.map((p) => p?.id).filter((id) => id != null) : [];
    return g;
  }

  // `timezone` is the member's IANA profile zone; the panel stamps everything in the viewer's own.
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

  // Only this PUT broadcasts to web clients; dasherized body (flat → 400), user id in, email out.
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

  // per_page caps at 200 (a bigger ask is clamped), so every page is drained; `id` is the slug.
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
        // Page 1 carries the verdict Settings validates on; a tail failing mid-drain keeps the ones in hand.
        if (page === 1) throw e;
        break;
      }
      const rows = Array.isArray(doc?.data) ? doc.data : [];
      all.push(...rows.map((n) => {
        const a = n.attributes || {};
        // `tests-count` rides along on the index; null when the server sent none.
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

  // Example values tell same-titled parametrized rows apart; v2 `/testruns` serializes neither.
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
    const pages = Math.min(Number(first?.meta?.total_pages) || 1, PAGE_GUARD);
    const rest = await mapLimit(
      Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => i + 2),
      FANOUT_LIMIT,
      (p) => jwtRequest(`${path}&page=${p}`),
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

  // `bulk_update` inserts `source: :user` (web hides `system` rows); `oldKey` === `key` replaces.
  function setTestrunMeta(testrunId, entries) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/testrun_extras/bulk_update`, {
      method: 'POST',
      body: { metafields: entries.map(([key, value]) => ({ key, value, oldKey: key })) },
    });
  }

  // The server does not validate the status enum, so the caller restricts it; the same `pos` replaces.
  function setStep(testrunId, { title, status, pos }) {
    return jwtRequest(`/testruns/${encodeURIComponent(testrunId)}/steps`, {
      method: 'POST',
      body: { step: { title, status, pos } },
    });
  }

  // `?kind=` falls back to every standard kind when nothing matches, hence the re-check below.
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

  // The prompt lives server-side; the answer carries the rewritten section in `data.polished_steps`.
  async function polishRecordedSteps(message, testId) {
    const doc = await jwtRequest('/prompts', {
      method: 'POST',
      body: { prompt: 'polish_recorded_steps', message, ...(testId ? { test_id: testId } : {}) },
      timeout: LONG_TIMEOUT_MS, // the model runs server-side; timing it out loses the recorded steps
    });
    return { text: (doc && doc.text) || '', steps: doc?.data?.polished_steps || '' };
  }

  // The endpoint accepts any file, image or text/plain; `scope` is 'testruns' or 'tests'.
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

  // v2 first; a 403/404/405 hands over to the JSON:API route, and only that failure reaches the caller.
  async function deleteAttachment(testrunId, attachmentId) {
    guardConfigured();
    const id = encodeURIComponent(String(attachmentId));
    try {
      // `remint: false`: the 403 here is the route answering, not the key; rotating wastes a trip.
      return await request(`/attachments/${id}`, {
        method: 'DELETE', query: { testrun_id: testrunId }, corroborate403: false, remint: false,
      });
    } catch (e) {
      const st = e && e.status;
      if (st !== 403 && st !== 404 && st !== 405) throw e;
    }
    return jwtRequest(`/attachments/${id}`, { method: 'DELETE' });
  }

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
    // recheckAccess shares the corroboration's coalescing; only a 2xx clears readonlyAccess().
    readonlyAccess: () => readonly, recheckAccess: projectIsReadonly, rateLimitedAt, ApiError,
  };
})();
