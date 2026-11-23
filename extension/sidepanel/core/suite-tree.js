// The suite tree's pure decisions: search filter, folder count, node mark, and hoisted suites.

// No global list: no DOM, no `chrome.*`, no `state`, no `TestomatAPI`; values in, values out.

const SuiteTree = {
  // A matching folder keeps its whole subtree; copies, so a cleared query restores tcSuites.
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

  // Summed over the roots only: a folder's `test_count` is already its subtree total.
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

  // Non-mutating: state.tcSuites keeps the server's order; `createdIds` is read, never written.
  hoist(list, createdIds) {
    const nodes = list || [];
    if (!createdIds.length || !nodes.length) return nodes;
    const rank = (n) => createdIds.indexOf(String(n.id));
    const fresh = nodes.filter((n) => rank(n) >= 0).sort((a, b) => rank(a) - rank(b));
    return fresh.length ? [...fresh, ...nodes.filter((n) => rank(n) < 0)] : nodes;
  },
};
