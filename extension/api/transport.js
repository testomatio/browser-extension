/* global ApiErrors */

const ApiTransport = (() => {
  const { ApiError } = ApiErrors;

  // A request that never answers hangs the panel for its whole life, holding every write flag with it.
  const REQUEST_TIMEOUT_MS = 30000;
  // Minutes, not seconds: a 50 MB recording on a slow link, or server-side model work, needs them.
  const LONG_TIMEOUT_MS = 300000;

  // A 429 was not processed, so replaying is safe for any method; nothing above rawFetch retries one.
  const RATE_LIMIT_BACKOFF_MS = [1000, 2000]; // two retries, then the refusal reaches the tester
  // A server may ask for an hour; honour it only up to a wait a tester can sit through.
  const RETRY_AFTER_MAX_MS = 30000;

  // Read by live sync to slow its polling; a 2xx clears it, proof the instance answers again.
  let rateLimitedAt = 0;

  // `Retry-After` is either a count of seconds or an HTTP-date. Anything else is no ask at all.
  function retryAfterMs(raw) {
    if (!raw) return null;
    const secs = Number(String(raw).trim());
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at - Date.now() : null;
  }

  function rateLimitWait(res, attempt) {
    const asked = retryAfterMs(res.headers?.get?.('Retry-After'));
    if (asked === null) return RATE_LIMIT_BACKOFF_MS[attempt];
    return Math.min(Math.max(asked, 0), RETRY_AFTER_MAX_MS);
  }

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  async function sendOnce(url, { timeout = REQUEST_TIMEOUT_MS, signal, ...opts } = {}) {
    const budget = AbortSignal.timeout(timeout);
    // Without AbortSignal.any the caller's own signal wins: cancelling has no other way to happen.
    const combined = !signal ? budget
      : (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, budget]) : signal);
    try {
      return await fetch(url, { ...opts, signal: combined });
    } catch {
      // A timeout wears the same network error as a dead link, so the offline queue still takes the click.
      if (budget.aborted) {
        throw new ApiError('network', 0, `No answer in ${Math.round(timeout / 1000)}s — the request timed out`);
      }
      throw new ApiError('network', 0, 'Network error');
    }
  }

  async function rawFetch(url, opts = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await sendOnce(url, opts);
      if (res.status !== 429) {
        if (res.ok) rateLimitedAt = 0;
        return res;
      }
      rateLimitedAt = Date.now();
      // Out of retries: the 429 goes back as it came and toError() turns it into the sentence.
      if (attempt >= RATE_LIMIT_BACKOFF_MS.length) return res;
      await sleep(rateLimitWait(res, attempt));
    }
  }

  return {
    rawFetch,
    rateLimitedAt: () => rateLimitedAt,
    REQUEST_TIMEOUT_MS,
    LONG_TIMEOUT_MS,
    RETRY_AFTER_MAX_MS,
    RATE_LIMIT_BACKOFF_MS,
  };
})();
