// The Runs tab's paging arithmetic: the cursor a v2 index answers with, the fold of its two
// independently paged sources, and how much of the list is still missing. Over `state` alone.

/* global state */

const RunsPaging = {
  // v2 index response → paging cursor: totalPages is derived, because v2 reports a
  // row total and no page count.
  v2Cursor(res, page) {
    const meta = res?.meta || {};
    const perPage = Number(meta.per_page) || (res?.data || []).length || 1;
    const total = meta.total != null ? Number(meta.total) : null;
    return {
      page: Number(meta.page) || page,
      perPage,
      total,
      totalPages: total != null ? Math.max(1, Math.ceil(total / perPage)) : null,
    };
  },

  // v2 folds two independently paged sources: more rows exist while EITHER has a
  // next page.
  v2ListPaging(loading = false) {
    const r = state.v2RunsPaging || {};
    const g = state.v2GroupsPaging || {};
    const totals = [r.total, g.total];
    return {
      page: Math.max(r.page || 1, g.page || 1),
      total: totals.every((t) => t != null) ? totals.reduce((a, b) => a + b, 0) : null,
      totalPages: Math.max(r.totalPages || 1, g.totalPages || 1),
      loading,
    };
  },

  remainderOf(cursor, loadedCount) {
    if (!cursor || cursor.total == null) return null;
    return Math.max(0, cursor.total - loadedCount);
  },

  hasNextPage: (cursor) => !!cursor && cursor.totalPages != null && (cursor.page || 1) < cursor.totalPages,

  listCursor() {
    return state.listMode === 'dashboard' ? state.listPaging : RunsPaging.v2ListPaging(state.listPaging?.loading);
  },

  listLoadedCount: () =>
    (state.listMode === 'dashboard'
      ? state.dashItems.length
      : (state.lastRuns || []).length + (state.lastGroups || []).length),

  groupHasMore(groupId) {
    const p = state.groupPaging[String(groupId)];
    if (!p) return false;
    return RunsPaging.hasNextPage({ page: p.subsPage, totalPages: p.subsTotalPages })
      || RunsPaging.hasNextPage({ page: p.runsPage, totalPages: p.runsTotalPages });
  },

  groupRemainder(groupId) {
    const key = String(groupId);
    const p = state.groupPaging[key];
    if (!p || (p.subsTotal == null && p.runsTotal == null)) return null;
    const subs = RunsPaging.remainderOf({ total: p.subsTotal }, (state.subgroupsCache[key] || []).length);
    const runs = RunsPaging.remainderOf({ total: p.runsTotal }, (state.childrenCache[key] || []).length);
    if (subs == null && runs == null) return null;
    return (subs || 0) + (runs || 0);
  },
};
