// The API client's pure normalisers (IIFE global `ApiNormalize`): the row shapes the panel draws,
// out of the three payload dialects the server answers in. Depends on nothing.

const ApiNormalize = (() => {
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

  return { normSuiteNode, orderSuiteTree, normEnv, normDashRun, normDashGroup, testrunExampleOf };
})();
