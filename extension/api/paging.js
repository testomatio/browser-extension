// The API client's pagination (IIFE global `ApiPaging`): how much of a list the tester actually sees,
// and the three meta dialects behind a page. Depends on an injected `request` fn and ApiErrors.

/* global ApiErrors */

const ApiPaging = (() => {
  const { ApiError } = ApiErrors;

  // Drain EVERY page of a v2 index. 100 is what we ASK for, never a promise: sibling routes are
  // capped at 30 and 50, and a stop measured against our own number ends the drain on page 1.
  const PAGE_GUARD = 1000;
  async function drain(request, path, query = {}) {
    const all = [];
    let pageSize = null; // the SERVER's page size: `meta.per_page`, else the first page's own length
    for (let page = 1; page <= PAGE_GUARD; page++) {
      const res = await request(path, { query: { ...query, page, per_page: 100 } });
      const items = res?.data || [];
      all.push(...items);
      const meta = res?.meta || {};
      // The server's own account of the drain, wherever it keeps one.
      if (meta.has_more === false) return all;
      if (Number.isFinite(meta.total_pages) && page >= meta.total_pages) return all;
      if (Number.isFinite(meta.total) && all.length >= meta.total) return all;
      if (Number.isFinite(meta.per_page)) pageSize = meta.per_page;
      else if (pageSize === null && items.length) pageSize = items.length;
      // Only THEN a short page, and short against the size the server actually paged with.
      if (pageSize !== null && items.length < pageSize) return all;
      if (!items.length) return all; // a page past the end, whatever `has_more` claimed
    }
    // Returning the pile here would grade a truncated run as a whole one.
    throw new ApiError('http', 0, `${path} is too long to drain — over ${PAGE_GUARD} pages`);
  }

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

  return { drain, pageResult, PAGE_GUARD, DASH_KEYS, GROUP_KEYS };
})();
