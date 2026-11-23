// MAIN-world half of the evidence recorder: patches fetch/XHR/console and must never break the site.

(() => {
  'use strict';

  // A same-document re-inject (a worker retry) must be a no-op, or the wrappers would nest.
  if (window.__testomatEvHooked) return;
  window.__testomatEvHooked = true;

  const CHANNEL = '__testomat_evidence__';
  const BODY_CAP = 16 * 1024;   // parity with the CDP recorder's EVIDENCE_BODY_CAP
  const TEXT_CAP = 4000;        // one console line can be a whole stack dump
  const FLUSH_MS = 200;         // batch window (a busy page fires hundreds of rows)
  const FLUSH_MAX = 40;
  const STACK_LINES = 6;        // message + the frames that place the throw
  const DEDUP_MS = 1000;        // window in which a console.error owns the same failure

  let tok = null;               // the relay's per-document token; without it our batches are page noise
  let off = false;              // the worker told us this recording is over
  let captureBodies = null;     // null = the relay has not answered yet
  let reAnnounced = false;      // the one re-`ready` for a relay that loaded late
  const bodyWaiters = [];       // body reads parked until it does
  let queue = [];
  let flushTimer = null;
  let inConsole = false;        // re-entrancy guard around the console patch

  function send(payload) {
    const msg = { source: CHANNEL, ...payload };
    if (tok) msg.tok = tok; // the first hello predates the token, and is refused on purpose
    try { window.postMessage(msg, '*'); } catch { /* page killed us */ }
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

  // A page can forge this channel, but at worst it mutes its own evidence log, so it is accepted.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== CHANNEL || !d.control) return;
    if (typeof d.tok === 'string') tok = d.tok;
    // `off` is two-way: a new recording on this document must un-mute it, since re-injects are no-ops.
    if (typeof d.off === 'boolean') {
      off = d.off;
      if (off) { queue = []; return; }
      reAnnounced = false; // a fresh recording wants a fresh hello
    }
    // The relay may have missed our `ready` by loading late; its unprompted config proves it is here.
    if (!reAnnounced) { reAnnounced = true; send({ events: [{ t: 'ready', ts: Date.now(), url: location.href }] }); }
    if (typeof d.captureBodies === 'boolean') {
      captureBodies = d.captureBodies;
      const waiting = bodyWaiters.splice(0, bodyWaiters.length);
      for (const fn of waiting) { try { fn(captureBodies); } catch { /* never the page's problem */ } }
    }
  });

  // Body capture is a privacy switch, so a read never guesses: it waits for the relay or gives up.
  function wantBody() {
    if (captureBodies != null) return Promise.resolve(captureBodies);
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      bodyWaiters.push(settle);
      setTimeout(() => settle(false), 3000);
    });
  }

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

  // Our own frames carry a chrome-extension:// url even though we run in the page's world.
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

  // A snippet, not a dump: the message plus the frames that place the throw.
  const trimStack = (s) => cap(String(s || '').split('\n').slice(0, STACK_LINES).join('\n').trim(), TEXT_CAP);

  // Two rows of the same failure share the first line, minus the browser's (or our) prefix.
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

  // Frameworks log the error, then rethrow it: a matching console.error owns the uncaught row.
  function loggedAlready(text) {
    const head = headLine(text);
    if (!head) return false;
    const cutoff = Date.now() - DEDUP_MS;
    while (errorHeads.length && errorHeads[0].ts < cutoff) errorHeads.shift();
    return errorHeads.some((r) => r.head === head);
  }

  // A rejection has no filename/lineno; the reason's stack is the only place its location survives.
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

  // Its own kind, so the panel labels it `uncaught.error` instead of blaming console.error.
  const pushException = (text, loc) =>
    post({ t: 'exception', ts: Date.now(), level: 'error', text,
      url: (loc && loc.url) || null, line: (loc && loc.line) || null, col: (loc && loc.col) || null });

  // A browser-made row (failed load, CSP refusal), kind 'log' so the panel labels it `log.error`.
  const pushLog = (level, text, url) => post({ t: 'log', ts: Date.now(), level, text: cap(text, TEXT_CAP), url: url || null });

  function pushNet(e) {
    post({ t: 'net', ts: e.started, kind: 'network', method: e.method, url: e.url,
      resourceType: e.resourceType, status: e.status, errorText: e.errorText || null,
      mimeType: e.mimeType || null, durationMs: Math.max(0, Date.now() - e.started),
      bodySnippet: e.bodySnippet || null, bodyTruncated: !!e.bodyTruncated, bodySkipped: !!e.bodySkipped });
  }

  // Only a failure carries a body: >= 400, or a network-level error.
  const isFailure = (status, errorText) => !!errorText || (status != null && status >= 400);

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

  // Capture phase: a failed <img>/<script>/<link> fires a non-bubbling `error` on the element.
  window.addEventListener('error', (e) => {
    if (off) return;
    try {
      const el = e.target;
      if (el && el !== window && el.nodeType === 1) {
        const src = el.src || el.href || '';
        pushLog('error', `Failed to load resource: ${abs(src) || el.tagName.toLowerCase()}`, abs(src) || null);
        return;
      }
      // Chrome puts "Uncaught" in `message` and other engines do not; read like DevTools either way.
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

  // CSP rows the page would otherwise swallow.
  document.addEventListener('securitypolicyviolation', (e) => {
    if (off) return;
    try {
      pushLog('error', `CSP refused ${e.blockedURI || '(inline)'} — violated ${e.violatedDirective || e.effectiveDirective || 'policy'}`,
        e.sourceFile || e.documentURI || null);
    } catch { /* noop */ }
  });

  // At most BODY_CAP off a clone, then cancel: a 200 MB failed download must not be pulled in.
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
    // A no-cors response reports status 0; logging that would invent an error the page never saw.
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
        // Not awaited, so the page gets its response now; its rejection must die here.
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
                  // Only a text-ish responseType reads back without touching the page's blob/buffer.
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

  // Sent at once, not batched: the relay's config answer gates every body read.
  send({ events: [{ t: 'ready', ts: Date.now(), url: location.href }] });

  // A failed request right before a navigation is exactly the one the tester wants.
  window.addEventListener('pagehide', flush, true);
})();
