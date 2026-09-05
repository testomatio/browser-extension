// The evidence ring buffer (IIFE global `EvBuffer`): the hundred lines that decide what the tester
// gets when they press "attach the log" — how long an entry is kept, what counts as an error, and
// whether a request chrome.webRequest saw and the same request the page hook saw come back as one
// row or two.
//
// Pure over its own state plus `Date.now`: nothing here touches `chrome`, so the worker's listeners,
// the settings read and the storage.session mirror stay in evidence/recorder.js. The requestId map
// and the mirror callback are handed IN rather than wrapped around push(), because the map's leak
// guard fires inside push — after the hard cap, before the mirror is scheduled.

const EvBuffer = (() => {
  const HARD_CAP = 1000;      // memory guard: absolute entry ceiling
  const NET_MAP_CAP = 3000;   // requestId->entry map leak guard
  const MERGE_MS = 10000;     // window for adopting a webRequest twin

  function clampWindow(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 60;
    return Math.min(600, Math.max(10, Math.round(n)));
  }

  // errorsOnly: console error/warn (incl. log + uncaught rows) + non-2xx/failed net.
  function isError(e) {
    if (e.kind === 'network') return e.errorText != null || (e.status != null && (e.status < 200 || e.status >= 300));
    return e.level === 'error' || e.level === 'warning';
  }

  function makeBuffer(opts = {}) {
    const hardCap = opts.hardCap != null ? opts.hardCap : HARD_CAP;
    const netMapCap = opts.netMapCap != null ? opts.netMapCap : NET_MAP_CAP;
    const mergeMs = opts.mergeMs != null ? opts.mergeMs : MERGE_MS;
    const netMap = opts.netMap || new Map();
    const onChange = opts.onChange || (() => {});
    // Mutable at runtime: a settings change rewrites it, and both the prune and the window follow.
    let windowSec = opts.windowSec != null ? opts.windowSec : 60;
    let buffer = [];

    function push(entry) {
      buffer.push(entry);
      // Prune to 2x the window (retroactive margin) then hard-cap the length.
      const cutoff = Date.now() - 2 * windowSec * 1000;
      if (buffer[0] && buffer[0].ts < cutoff) buffer = buffer.filter((e) => e.ts >= cutoff);
      if (buffer.length > hardCap) buffer = buffer.slice(buffer.length - hardCap);
      if (netMap.size > netMapCap) netMap.clear();
      onChange();
      return entry;
    }

    // Sorted by ts: the sources arrive on different latencies (webRequest is immediate, the
    // page hook batches ~200 ms), so append order is not time order.
    function windowEntries(now = Date.now()) {
      const cutoff = now - windowSec * 1000;
      return buffer.filter((e) => e.ts >= cutoff).sort((a, b) => a.ts - b.ts);
    }

    // The one place the sources can collide: the hook is installed but its `ready` had not
    // reached us when webRequest saw the same xhr. The richer page row overwrites in place.
    function adoptTwin(ev, ts) {
      for (let i = buffer.length - 1; i >= 0; i--) {
        const e = buffer[i];
        if (e.ts < ts - mergeMs) break;
        if (e.kind === 'network' && e.fromPage !== true && e.method === ev.method && e.url === ev.url) return e;
      }
      return null;
    }

    function pushPageNet(ev, ts) {
      const fields = {
        ts, kind: 'network', fromPage: true, method: ev.method || 'GET', url: ev.url || '',
        resourceType: ev.resourceType || 'fetch',
        status: ev.status != null ? ev.status : null, errorText: ev.errorText || null,
        mimeType: ev.mimeType || null, durationMs: ev.durationMs != null ? ev.durationMs : null,
      };
      if (ev.bodySnippet) { fields.bodySnippet = String(ev.bodySnippet); fields.bodyTruncated = !!ev.bodyTruncated; }
      if (ev.bodySkipped) fields.bodySkipped = true;
      const twin = adoptTwin(ev, ts);
      if (twin) { Object.assign(twin, fields, { ts: twin.ts }); onChange(); return; }
      push(fields);
    }

    return {
      push,
      windowEntries,
      isError,
      adoptTwin,
      pushPageNet,
      setWindowSec: (n) => { windowSec = n; },
      // The live array, not a copy: the mirror writes it and webRequest patches rows in place.
      entries: () => buffer,
      clear: () => { buffer = []; },
      load: (arr) => { buffer = arr; },
    };
  }

  return { HARD_CAP, NET_MAP_CAP, MERGE_MS, clampWindow, isError, makeBuffer };
})();
