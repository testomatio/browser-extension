// The four decisions the Tests tab's suite tree is made of: which nodes a search keeps, what a
// folder's count badge says, which mark a node carries, and which suites ride at the top.

// No `/* global */` list, the way core/format.js has none: this file reads no DOM, no `chrome.*`,
// no `state` and no `TestomatAPI` — a value goes in and a value comes out.

const SuiteTree = {
  // A matching folder keeps its WHOLE subtree; one kept only for a descendant shows
  // just the branch leading there. Returns copies — a cleared query restores tcSuites.
  filter(roots, query) {
    const q = query.trim().toLowerCase();
    if (!q) return roots;
    const keep = (n) => {
      const self = (n.title || '').toLowerCase().includes(q);
      const kids = (n.children || []).map(keep).filter(Boolean);
      if (!self && !kids.length) return null;
      return { ...n, children: self ? (n.children || []) : kids };
    };
    return (roots || []).map(keep).filter(Boolean);
  },

  // Every test case in the project (#127). Summed over the ROOTS only — a folder's
  // `test_count` is already its subtree total, so descending would double-count.
  testCount: (roots) =>
    (roots || []).reduce((n, s) => n + (Number(s.test_count) || 0), 0),

  // null when the tree is empty or the node is absent — both mean "draw the glyph".
  emojiOf(nodes, id) {
    for (const n of nodes || []) {
      if (String(n.id) === String(id)) return n.emoji || null;
      const found = SuiteTree.emojiOf(n.children, id);
      if (found) return found;
    }
    return null;
  },

  // Non-mutating — state.tcSuites keeps the server's order; only the drawing moves.
  // `createdIds` is the caller's live array, newest first; it is read, never written.
  hoist(list, createdIds) {
    const nodes = list || [];
    if (!createdIds.length || !nodes.length) return nodes;
    const rank = (n) => createdIds.indexOf(String(n.id));
    const fresh = nodes.filter((n) => rank(n) >= 0).sort((a, b) => rank(a) - rank(b));
    return fresh.length ? [...fresh, ...nodes.filter((n) => rank(n) < 0)] : nodes;
  },
};
