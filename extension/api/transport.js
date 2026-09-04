// The one place the API client reaches the network (IIFE global `ApiTransport`): the timeout budget
// every request gets, and the two network failures a tester can read. Depends on ApiErrors.

/* global ApiErrors */

const ApiTransport = (() => {
  const { ApiError } = ApiErrors;

  // A request that never answers hangs the panel for its whole life, holding every write flag with it.
  const REQUEST_TIMEOUT_MS = 30000;
  // Minutes, not seconds: a 50 MB recording on a slow link, or server-side model work, needs them.
  const LONG_TIMEOUT_MS = 300000;

  async function rawFetch(url, { timeout = REQUEST_TIMEOUT_MS, signal, ...opts } = {}) {
    const budget = AbortSignal.timeout(timeout);
    // Without AbortSignal.any the caller's own signal wins: cancelling has no other way to happen.
    const combined = !signal ? budget
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, budget]) : signal);
    try {
      return await fetch(url, { ...opts, signal: combined });
    } catch {
      // A timeout wears the SAME network error a dead link does, so the offline queue still takes the click.
      if (budget.aborted) {
        throw new ApiError('network', 0, `No answer in ${Math.round(timeout / 1000)}s — the request timed out`);
      }
      throw new ApiError('network', 0, 'Network error');
    }
  }

  return { rawFetch, REQUEST_TIMEOUT_MS, LONG_TIMEOUT_MS };
})();
