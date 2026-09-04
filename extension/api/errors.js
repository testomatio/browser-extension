// The API client's error type and the sentences a refusal shows the tester (IIFE global `ApiErrors`):
// which wording is which refusal. Depends on nothing — toError() takes a `res`-shaped object.

const ApiErrors = (() => {
  // The host, so a tester reading either verdict below knows WHICH server refused them.
  const instanceHost = (baseUrl) => { try { return new URL(baseUrl).host; } catch { return 'the web app'; } };
  const readonlyMessage = (host, status) =>
    `Your access to this project is read-only — ${host} answered ${status} to a plain read too`;
  const routeRefused = (host, status) =>
    `${host} refused this request (${status}) — the project itself still reads fine`;
  // A 429 already waited out ApiTransport's two retries by the time it gets here, so the tester is
  // told to wait rather than to click again straight away. Never the body: a 429 body is a quota dump.
  const RATE_LIMITED = 'Too many requests — wait a minute, then try again';

  class ApiError extends Error {
    constructor(kind, status, detail) {
      super(detail || kind);
      this.kind = kind; // unconfigured | network | auth | readonly | notfound | http
      this.status = status;
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
    // `http` and 429 on purpose: the offline queue reads `kind` and must not start queueing these.
    if (res.status === 429) return new ApiError('http', 429, RATE_LIMITED);
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* empty body */ }
    return new ApiError('http', res.status, detail || `HTTP ${res.status}`);
  }

  return { ApiError, toError, instanceHost, readonlyMessage, routeRefused, RATE_LIMITED };
})();
