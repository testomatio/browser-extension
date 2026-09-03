// One queue, in the order the tester acted. An action's packet needs the page's 400ms before it
// can say what changed, so entries wait — and a manual expectation typed in the meantime must not
// overtake the step it belongs to. Injected before content/step-recorder.js (background.js
// srInject). It owns no recording state: the reply comes back through `onReply` to the file that
// does.
const RecOutbox = (() => {
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

  return { make };
})();
