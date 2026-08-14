// Evidence page hook (#123) — the MAIN-world half of the recorder. Runs IN the
// page (world: 'MAIN'), so it has the page's own `fetch`, `XMLHttpRequest` and
// `console` to patch and NO chrome.* API at all; everything it observes leaves
// through window.postMessage to evidence/relay.js (ISOLATED world), which is the
// only side that can talk to the service worker.
//
// Replaces the chrome.debugger/CDP session the recorder used to own. This file owns
// EXACTLY: fetch + XHR from this frame (incl. the response-body snippet of a
// failure) and the console side (console.error/warn, uncaught errors, unhandled
// rejections, CSP violations, failed resource loads). Everything else in the tab
// is chrome.webRequest's job in the worker — the two never see the same request.
//
// Non-negotiable: this code runs inside the page under test. Every patch is a
// pass-through wrapped in try/catch — a bug here must never break the site.

(() => {
  'use strict';

  // One hook per document. A same-document re-inject (the worker retries when a
  // registration is missing) must be a no-op, or the wrappers would nest.
  if (window.__testomatEvHooked) return;
  window.__testomatEvHooked = true;

  const CHANNEL = '__testomat_evidence__';
  const BODY_CAP = 16 * 1024;   // parity with the CDP recorder's EVIDENCE_BODY_CAP
  const TEXT_CAP = 4000;        // one console line can be a whole stack dump
  const FLUSH_MS = 200;         // batch window (a busy page fires hundreds of rows)
  const FLUSH_MAX = 40;
  const STACK_LINES = 6;        // message + the frames that place the throw (#163)
  const DEDUP_MS = 1000;        // window in which a console.error owns the same failure

  let off = false;              // the worker told us this recording is over
  let captureBodies = null;     // null = the relay has not answered yet
  let reAnnounced = false;      // the one re-`ready` for a relay that loaded late
  const bodyWaiters = [];       // body reads parked until it does
  let queue = [];
  let flushTimer = null;
  let inConsole = false;        // re-entrancy guard around the console patch

  // ---- channel -----------------------------------------------------------

  function send(payload) {
    try { window.postMessage({ source: CHANNEL, ...payload }, '*'); } catch { /* page killed us */ }
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return;
    const events = queue;
    queue = [];
    send({ events });
  }

  function post(ev) {
    if (off) return;
    queue.push(ev);
    if (queue.length >= FLUSH_MAX) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  // The relay answers `ready` with the body-capture config and forwards the
  // worker's "stop" — both arrive on the same DOM channel. A page CAN forge
  // these (MAIN and ISOLATED share only the DOM); the worst case is a page
  // muting or un-muting its own evidence log — its own, and nobody else's, which
  // is why the forgery is accepted here rather than fought.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CHANNEL || !d.control) return;
    // `off` is a two-way switch, not a kill: a recording that ends mutes this
    // hook, and a NEW recording on the same never-navigated document has to
    // un-mute it — the re-inject cannot, the double-init guard eats it.
    if (typeof d.off === 'boolean') {
      off = d.off;
      if (off) { queue = []; return; }
      reAnnounced = false; // a fresh recording wants a fresh hello
    }
    // The relay may have loaded AFTER us, in which case our `ready` was posted
    // into a document nobody was listening in. Its unprompted config is the
    // proof it is there now — say hello once more so the worker learns this
    // frame's fetch/XHR is patched (and stops double-listing it via webRequest).
    if (!reAnnounced) { reAnnounced = true; send({ events: [{ t: 'ready', ts: Date.now(), url: location.href }] }); }
    if (typeof d.captureBodies === 'boolean') {
      captureBodies = d.captureBodies;
      const waiting = bodyWaiters.splice(0, bodyWaiters.length);
      for (const fn of waiting) { try { fn(captureBodies); } catch { /* never the page's problem */ } }
    }
  });

  // Body capture is a privacy switch (#95), so a read NEVER guesses: it waits
  // for the relay's answer (which is one storage read away, ordered long before
  // any response can land) and gives up if it never comes.
  function wantBody() {
    if (captureBodies != null) return Promise.resolve(captureBodies);
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      bodyWaiters.push(settle);
      setTimeout(() => settle(false), 3000);
    });
  }

  // ---- shared helpers ----------------------------------------------------

  const abs = (u) => { try { return new URL(String(u), document.baseURI).href; } catch { return String(u); } };
  const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function argText(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'object') {
      try {
        const j = JSON.stringify(a);
        // '{}' for a DOM node / class instance — String() is the readable form.
        return j && j !== '{}' ? j : String(a);
      } catch { return String(a); }
    }
    return String(a);
  }

  const argsText = (args) => cap(Array.prototype.map.call(args, argText).join(' ').trim(), TEXT_CAP);

  // First stack frame that is NOT this file — where the tester's code actually
  // called console.error. Our own frames carry the chrome-extension:// url even
  // though we run in the page's world.
  function callSite() {
    let stack = '';
    try { stack = new Error().stack || ''; } catch { return {}; }
    for (const line of stack.split('\n').slice(1)) {
      if (line.includes('chrome-extension://')) continue;
      const m = line.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
      if (m) return { url: m[1], line: Number(m[2]) };
    }
    return {};
  }

  // A stack is a snippet here, not a dump: the message plus the frames that place
  // the throw. DevTools keeps the rest.
  const trimStack = (s) => cap(String(s || '').split('\n').slice(0, STACK_LINES).join('\n').trim(), TEXT_CAP);

  // The identity two rows of the SAME failure share: the first line, without the
  // prefix the browser (or we) put in front of it.
  const headLine = (text) => String(text || '').split('\n')[0]
    .replace(/^Uncaught\s*(?:\(in promise\)\s*)?/, '')
    .replace(/^Unhandled promise rejection:\s*/, '')
    .trim();

  const errorHeads = [];  // [{ ts, head }] of the recent console.error rows

  function rememberError(text) {
    const head = headLine(text);
    if (head) errorHeads.push({ ts: Date.now(), head });
    if (errorHeads.length > 50) errorHeads.splice(0, errorHeads.length - 50);
  }

  // Dedup rule (#163): drop the uncaught row when a console.error with the same
  // first line arrived within DEDUP_MS — frameworks log the error, then rethrow it.
  function loggedAlready(text) {
    const head = headLine(text);
    if (!head) return false;
    const cutoff = Date.now() - DEDUP_MS;
    while (errorHeads.length && errorHeads[0].ts < cutoff) errorHeads.shift();
    return errorHeads.some((r) => r.head === head);
  }

  // A rejection carries no filename/lineno of its own — the reason's stack is the
  // only place its location survives.
  function stackLoc(err) {
    const stack = err && typeof err.stack === 'string' ? err.stack : '';
    const m = stack.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
    return m ? { url: m[1], line: Number(m[2]), col: Number(m[3]) } : {};
  }

  function pushConsole(level, text, loc) {
    if (level === 'error') rememberError(text);
    post({ t: 'console', ts: Date.now(), level, text,
      url: (loc && loc.url) || null, line: (loc && loc.line) || null, col: (loc && loc.col) || null });
  }

  // An uncaught exception / unhandled rejection (#163): what DevTools shows in
  // red and no console call ever produced. Its own kind so the panel can label
  // it `uncaught.error` instead of blaming console.error for it.
  const pushException = (text, loc) =>
    post({ t: 'exception', ts: Date.now(), level: 'error', text,
      url: (loc && loc.url) || null, line: (loc && loc.line) || null, col: (loc && loc.col) || null });

  // A row the BROWSER would have produced (the CDP recorder got these from
  // Log.entryAdded): a failed resource load, a CSP refusal. Kept as kind 'log'
  // so the panel keeps labelling them `log.error`, not `console.error`.
  const pushLog = (level, text, url) => post({ t: 'log', ts: Date.now(), level, text: cap(text, TEXT_CAP), url: url || null });

  function pushNet(e) {
    post({ t: 'net', ts: e.started, kind: 'network', method: e.method, url: e.url,
      resourceType: e.resourceType, status: e.status, errorText: e.errorText || null,
      mimeType: e.mimeType || null, durationMs: Math.max(0, Date.now() - e.started),
      bodySnippet: e.bodySnippet || null, bodyTruncated: !!e.bodyTruncated, bodySkipped: !!e.bodySkipped });
  }

  // A failure is what carries a body: >= 400 (parity with the CDP recorder) or a
  // network-level error. Anything else is logged without one.
  const isFailure = (status, errorText) => !!errorText || (status != null && status >= 400);

  // ---- console -----------------------------------------------------------

  function patchConsole(name, level) {
    const orig = console[name];
    if (typeof orig !== 'function') return;
    console[name] = function (...args) {
      if (!off && !inConsole) {
        inConsole = true;
        try { pushConsole(level, argsText(args), callSite()); } catch { /* never break console */ }
        inConsole = false;
      }
      return orig.apply(this, args);
    };
  }

  try { patchConsole('error', 'error'); } catch { /* noop */ }
  try { patchConsole('warn', 'warning'); } catch { /* noop */ }

  // Capture phase, because a failed <img>/<script>/<link> fires an `error` event
  // on the ELEMENT that does not bubble — this is what recovers the browser's
  // "Failed to load resource" rows the CDP recorder used to get for free.
  window.addEventListener('error', (e) => {
    if (off) return;
    try {
      const el = e.target;
      if (el && el !== window && el.nodeType === 1) {
        const src = el.src || el.href || '';
        pushLog('error', `Failed to load resource: ${abs(src) || el.tagName.toLowerCase()}`, abs(src) || null);
        return;
      }
      // Uncaught exception (#163): Chrome already says "Uncaught …" in `message`,
      // other engines do not — the row reads like DevTools either way.
      const err = e.error;
      const body = err ? trimStack(err.stack || `${err.name}: ${err.message}`) : (e.message || 'Uncaught error');
      const text = /^Uncaught\b/.test(body) ? body : `Uncaught ${body}`;
      if (loggedAlready(text)) return;
      pushException(cap(text, TEXT_CAP), { url: e.filename || null, line: e.lineno || null, col: e.colno || null });
    } catch { /* noop */ }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    if (off) return;
    try {
      const r = e.reason;
      const body = r instanceof Error ? trimStack(r.stack || `${r.name}: ${r.message}`) : argText(r);
      const text = cap(`Unhandled promise rejection: ${body}`, TEXT_CAP);
      if (loggedAlready(text)) return;
      pushException(text, stackLoc(r));
    } catch { /* noop */ }
  });

  // CSP rows the page would otherwise swallow (issue scope item 2).
  document.addEventListener('securitypolicyviolation', (e) => {
    if (off) return;
    try {
      pushLog('error', `CSP refused ${e.blockedURI || '(inline)'} — violated ${e.violatedDirective || e.effectiveDirective || 'policy'}`,
        e.sourceFile || e.documentURI || null);
    } catch { /* noop */ }
  });

  // ---- fetch -------------------------------------------------------------

  // Read at most BODY_CAP bytes off a CLONE, then cancel: a 200 MB failed
  // download must not be pulled into memory to log 16 KB of it.
  async function readCapped(res) {
    try {
      const clone = res.clone();
      if (!clone.body || !clone.body.getReader) {
        const t = await clone.text();
        return { text: t.slice(0, BODY_CAP), truncated: t.length > BODY_CAP };
      }
      const reader = clone.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size > BODY_CAP) { try { await reader.cancel(); } catch { /* already closed */ } break; }
      }
      const buf = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) { buf.set(c, at); at += c.length; }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return { text: text.slice(0, BODY_CAP), truncated: text.length > BODY_CAP };
    } catch { return null; }
  }

  async function finishFetch(entry, res) {
    // A no-cors response reports status 0 with nothing readable — recording it
    // as "status 0" would invent an error the page never saw.
    if (res.type === 'opaque' || res.type === 'opaqueredirect') {
      entry.status = null;
      pushNet(entry);
      return;
    }
    entry.status = res.status;
    try { entry.mimeType = res.headers.get('content-type') || null; } catch { /* noop */ }
    if (isFailure(entry.status, null)) {
      if (await wantBody()) {
        const body = await readCapped(res);
        if (body) { entry.bodySnippet = body.text; entry.bodyTruncated = body.truncated; }
      } else {
        entry.bodySkipped = true; // the panel prints "(body capture disabled)"
      }
    }
    pushNet(entry);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function fetch(...args) {
      if (off) return origFetch.apply(this, args);
      const entry = { started: Date.now(), method: 'GET', url: '', resourceType: 'fetch', status: null };
      try {
        const input = args[0];
        const init = args[1];
        if (typeof Request !== 'undefined' && input instanceof Request) {
          entry.method = input.method || 'GET';
          entry.url = input.url;
        } else {
          entry.url = abs(input && input.url ? input.url : input);
        }
        if (init && init.method) entry.method = String(init.method);
        entry.method = String(entry.method || 'GET').toUpperCase();
      } catch { /* keep the defaults — never fail the page's fetch */ }
      let p;
      try { p = origFetch.apply(this, args); } catch (e) {
        try { entry.errorText = String((e && e.message) || e); entry.status = 0; pushNet(entry); } catch { /* noop */ }
        throw e;
      }
      return p.then(
        // finishFetch is async and deliberately NOT awaited (the page must get
        // its response now) — so its rejection has to die here, or the page
        // would see an unhandledrejection we then dutifully recorded.
        (res) => { try { finishFetch(entry, res).catch(() => {}); } catch { /* noop */ } return res; },
        (err) => {
          try {
            entry.errorText = String((err && err.message) || err) || 'network error';
            entry.status = 0;
            pushNet(entry);
          } catch { /* noop */ }
          throw err;
        },
      );
    };
  }

  // ---- XMLHttpRequest ----------------------------------------------------

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function open(method, url, ...rest) {
      try {
        this.__testomatEv = { method: String(method || 'GET').toUpperCase(), url: abs(url), resourceType: 'xhr', status: null };
      } catch { /* noop */ }
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XHR.prototype.send = function send(...args) {
      const entry = this.__testomatEv;
      if (entry && !off) {
        entry.started = Date.now();
        const xhr = this;
        const fail = (text) => { entry.errorText = text; };
        try {
          xhr.addEventListener('error', () => fail('net::ERR_FAILED'));
          xhr.addEventListener('timeout', () => fail('timeout'));
          xhr.addEventListener('abort', () => fail('aborted'));
          xhr.addEventListener('loadend', () => {
            try {
              entry.status = xhr.status;
              try { entry.mimeType = xhr.getResponseHeader('content-type') || null; } catch { /* noop */ }
              if (!isFailure(entry.status, entry.errorText)) { pushNet(entry); return; }
              wantBody().then((yes) => {
                try {
                  if (!yes) { entry.bodySkipped = true; pushNet(entry); return; }
                  // Only a text-ish responseType can be read back without
                  // touching the page's own copy of a blob/arraybuffer.
                  const rt = xhr.responseType;
                  let text = null;
                  if (rt === '' || rt === 'text') text = xhr.responseText;
                  else if (rt === 'json' && xhr.response != null) { try { text = JSON.stringify(xhr.response); } catch { text = null; } }
                  if (text != null) {
                    entry.bodyTruncated = text.length > BODY_CAP;
                    entry.bodySnippet = text.slice(0, BODY_CAP);
                  }
                  pushNet(entry);
                } catch { /* noop */ }
              }).catch(() => { /* never surface as an unhandledrejection */ });
            } catch { /* noop */ }
          });
        } catch { /* noop */ }
      }
      return origSend.apply(this, args);
    };
  }

  // The handshake: announce the hook so the worker knows the patch owns this
  // frame's fetch/XHR from now on, and so the relay answers with the config.
  // Sent immediately (not batched) — the answer gates every body read.
  send({ events: [{ t: 'ready', ts: Date.now(), url: location.href }] });

  // A pagehide must not lose the last batch (a failed request right before a
  // navigation is exactly the one the tester wants).
  window.addEventListener('pagehide', flush, true);
})();
