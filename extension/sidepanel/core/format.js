// Value formatting the panel's screens share (IIFE global `Fmt`). Nothing here reads the DOM,
// the API or `state` — it takes a value and answers the string a tester reads, so `node --test`
// covers it with no stubs at all (tests/format.test.mjs).
//
// It lives in core/ because two screens show the same figure from different sources: the run
// list's Run info has seconds off the run serializer, the test view's result card milliseconds
// off a result. One function, one wording, whichever screen asks.

const Fmt = (() => {
  // pretty-ms parity with the web (helpers/duration-to-human).
  function humanDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return `${Math.round(n)}ms`;
    const secs = n / 1000;
    if (secs < 60) return `${String(secs.toFixed(1)).replace(/\.0$/, '')}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) {
      const rest = Math.round(secs - mins * 60);
      return rest ? `${mins}m ${rest}s` : `${mins}m`;
    }
    const hours = Math.floor(mins / 60);
    const restMin = mins % 60;
    return restMin ? `${hours}h ${restMin}m` : `${hours}h`;
  }

  return { humanDuration };
})();
