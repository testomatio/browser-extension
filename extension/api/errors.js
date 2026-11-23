const ApiErrors = (() => {
  // The host, so the tester knows which server refused them.
  const instanceHost = (baseUrl) => { try { return new URL(baseUrl).host; } catch { return 'the web app'; } };
  const readonlyMessage = (host, status) =>
    `Your access to this project is read-only — ${host} answered ${status} to a plain read too`;
  const routeRefused = (host, status) =>
    `${host} refused this request (${status}) — the project itself still reads fine`;
  // A 429 already waited out ApiTransport's two retries; never the body, a 429 body is a quota dump.
  const RATE_LIMITED = 'Too many requests — wait a minute, then try again';

  class ApiError extends Error {
    constructor(kind, status, detail) {
      super(detail || kind);
      this.kind = kind; // unconfigured | network | auth | readonly | notfound | http
      this.status = status;
    }
  }

  // v2 answers `{message}` or `{error}`, JSON:API `errors[]`; never the stringified body, a wire dump.
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  function readable(body) {
    if (typeof body === 'string') return text(body);
    if (!body || typeof body !== 'object') return '';
    const direct = text(body.message) || text(body.error);
    if (direct) return direct;
    const first = Array.isArray(body.errors) ? body.errors[0] : null;
    if (typeof first === 'string') return text(first);
    if (!first || typeof first !== 'object') return '';
    return text(first.detail) || text(first.title) || text(first.message);
  }

  async function toError(res) {
    if (res.status === 401 || res.status === 403) {
      return new ApiError('auth', res.status, 'Token invalid or has no access');
    }
    if (res.status === 404) {
      // A valid token without project membership also yields 404.
      return new ApiError('notfound', 404, 'Not found — or no access to this project');
    }
    // `http` and 429 on purpose: the offline queue reads `kind` and must not start queueing these.
    if (res.status === 429) return new ApiError('http', 429, RATE_LIMITED);
    let detail = '';
    try { detail = readable(await res.json()); } catch { /* empty or unparseable body */ }
    return new ApiError('http', res.status, detail || `HTTP ${res.status}`);
  }

  return { ApiError, toError, readable, instanceHost, readonlyMessage, routeRefused, RATE_LIMITED };
})();
