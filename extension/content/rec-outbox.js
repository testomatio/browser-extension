// One queue, in the order the tester acted: an entry waits out its packet window, so an expectation
// typed meanwhile cannot overtake the step it belongs to. The reply goes back through `onReply`.

/* global window */
(() => {
  'use strict';
  // Injected on demand, and a same-document re-inject runs the file again: without this the
  // second run throws before the recorder's own latch is ever reached.
  if (window.RecOutbox) return;
  // `sendMessage` and `setTimeout` arrive as arguments so a test drives the queue without a page,
  // and `frameClause` because which frame this is is the recorder's fact, not the queue's.
  function make({ sendMessage, frameClause = '', afterMs = 400, onReply, setTimeout: wait }) {
    const timer = wait || ((fn, ms) => setTimeout(fn, ms));

    // A Stop flush has to know its entry REACHED the worker, not merely that it was handed to
    // sendMessage — the editor reads and clears the state the moment the flush resolves.
    const inflight = new Set();

    // `replaces` (dblclick only) is a wire instruction: the exact single-click text this
    // action supersedes — the worker pops those trailing twins before appending.
    function send(entry) {
      if (!entry || !entry.text) return;
      // Onto BOTH strings: a `replaces` the worker can no longer match leaves the twins behind.
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

    // The window is about to die (a navigation, a Stop): what is queued leaves with the
    // packet it has rather than with the page.
    const flushOutbox = () => { for (const it of outbox.slice()) if (it.close) it.close(); };

    return { send, queueEntry, flushOutbox, inflight };
  }

  window.RecOutbox = { make };
})();
