/* global ApiErrors */

const ApiPaging = (() => {
  const { ApiError } = ApiErrors;

  // 100 is what we ask for, not a promise: sibling routes cap at 30 and 50.
  const PAGE_GUARD = 1000;
  async function drain(request, path, query = {}) {
    const all = [];
    let pageSize = null; // the server's page size: `meta.per_page`, else the first page's own length
    for (let page = 1; page <= PAGE_GUARD; page++) {
      const res = await request(path, { query: { ...query, page, per_page: 100 } });
      const items = res?.data || [];
      all.push(...items);
      const meta = res?.meta || {};
      if (meta.has_more === false) return all;
      if (Number.isFinite(meta.total_pages) && page >= meta.total_pages) return all;
      if (Number.isFinite(meta.total) && all.length >= meta.total) return all;
      if (Number.isFinite(meta.per_page)) pageSize = meta.per_page;
      else if (pageSize === null && items.length) pageSize = items.length;
      // Only then a short page, short against the size the server actually paged with.
      if (pageSize !== null && items.length < pageSize) return all;
      if (!items.length) return all; // a page past the end, whatever `has_more` claimed
    }
    // Returning the pile here would grade a truncated run as a whole one.
    throw new ApiError('http', 0, `${path} is too long to drain — over ${PAGE_GUARD} pages`);
  }

  // A large project announces hundreds of pages; six at a time keeps the Tests tab from hanging.
  const FANOUT_LIMIT = 6;
  // Results keep the order of `items`, not of completion: a late page must land in its own slot.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // /runs/dashboard: camelCase, perPage fixed 30; /runs: snake_case, default 50; /rungroups: fixed 30.
  const pageResult = (items, page, meta, keys) => ({
    items,
    page: Number(meta?.[keys.page] ?? page) || page,
    perPage: meta?.[keys.perPage] != null ? Number(meta[keys.perPage]) : null,
    total: meta?.[keys.total] != null ? Number(meta[keys.total]) : null,
    totalPages: meta?.[keys.totalPages] != null ? Number(meta[keys.totalPages]) : null,
  });
  const DASH_KEYS = { page: 'page', perPage: 'perPage', total: 'totalCount', totalPages: 'totalPages' };
  const GROUP_KEYS = { page: 'page', perPage: 'per_page', total: 'num', totalPages: 'total_pages' };

  return { drain, mapLimit, pageResult, PAGE_GUARD, FANOUT_LIMIT, DASH_KEYS, GROUP_KEYS };
})();
