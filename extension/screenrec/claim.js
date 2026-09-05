// Who owns the upload of a parked take (IIFE global `SrecClaim`). The finished file is announced to
// every open panel document, and exactly one of them may upload it: the first to ask holds it, and
// holds it for two minutes, so a panel closed mid-upload cannot strand the take for good.
//
// Pure but for `serialize`: the clock arrives as `now`, and the three deciders only read a record and
// hand back the next one. Nothing here touches chrome or storage — the caller reads the take, writes
// what comes back and answers the panel.
//
// Loaded by the service worker only, ahead of screenrec/session.js.

const SrecClaim = (() => {
  // How long one panel document owns the upload: a panel closed mid-upload must not strand the take.
  const SREC_CLAIM_MS = 2 * 60 * 1000;

  // The panel already holding it may always take it again; anyone else waits the TTL out. Nothing
  // parked is nothing to claim.
  function claimOk(parked, by, now, ttl = SREC_CLAIM_MS) {
    if (!parked) return false;
    const held = parked.claim;
    return !(held && held.by !== by && now - held.at < ttl);
  }

  // A merge, not a rebuild: only who holds the take changes, the take itself is the tester's bytes.
  function applyClaim(parked, by, now) {
    return { ...parked, claim: { by, at: now } };
  }

  // Deleted, not nulled: a null claim would still read as held. null back means nothing to write —
  // a panel cannot release a take another one is holding.
  function dropClaim(parked, by) {
    if (!parked || !parked.claim || parked.claim.by !== by) return null;
    const rest = { ...parked };
    delete rest.claim;
    return rest;
  }

  // A claim reads, checks and stamps across awaits — one at a time, or two panels both find it free.
  let chain = Promise.resolve();

  // One queue for every caller, and a swallowed rejection: a claim that throws must not strand the
  // panel behind it in the line.
  function serialize(fn) {
    chain = chain.then(fn).catch(() => {});
    return chain;
  }

  return { SREC_CLAIM_MS, claimOk, applyClaim, dropClaim, serialize };
})();
