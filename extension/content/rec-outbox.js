// One queue in the tester's order, so an expectation typed meanwhile cannot overtake its step.

/* global window */
(() => {
  'use strict';
  // A same-document re-inject runs the file again; without this the second run throws.
  if (window.RecOutbox) return;
  // `sendMessage` and `setTimeout` are injected so a test drives the queue without a page.
  function make({ sendMessage, frameClause = '', afterMs = 400, onReply, setTimeout: wait }) {
    const timer = wait || ((fn, ms) => setTimeout(fn, ms));

    // A Stop flush must know its entry reached the worker: the editor clears state once it resolves.
    const inflight = new Set();

    // `replaces` (dblclick only): the single-click text this supersedes; the worker pops those twins.
    function send(entry) {
      if (!entry || !entry.text) return;
      // Onto both strings: a `replaces` the worker can no longer match leaves the twins behind.
      if (frameClause) {
        entry.text += frameClause;
        if (entry.replaces) entry.replaces += frameClause;
      }
      const p = sendMessage({ type: 'STEPREC_ADD', entry })
        .then((r) => { if (r && onReply) onReply(r); })
        .catch(() => { /* worker asleep / gone — the poll recovers */ });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }

    const outbox = [];
    const drain = () => { while (outbox.length && outbox[0].ready) send(outbox.shift().entry); };

    function queueEntry(entry, close) {
      const item = { entry, ready: !close };
      outbox.push(item);
      if (!close) { drain(); return; }
      item.close = () => {
        if (item.ready) return;
        item.ready = true;
        try { close(entry); } catch { /* a packet is never worth a lost step */ }
        drain();
      };
      timer(item.close, afterMs);
    }

    // The window is about to die: queued entries leave with the packet they have, not with the page.
    const flushOutbox = () => { for (const it of outbox.slice()) if (it.close) it.close(); };

    return { send, queueEntry, flushOutbox, inflight };
  }

  window.RecOutbox = { make };
})();
