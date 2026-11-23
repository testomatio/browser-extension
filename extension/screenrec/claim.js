// Every open panel hears of a parked take, but only one may upload it: the first to ask.

const SrecClaim = (() => {
  // How long one panel document owns the upload: a panel closed mid-upload must not strand the take.
  const SREC_CLAIM_MS = 2 * 60 * 1000;

  // The holder may always re-claim; anyone else waits the TTL out.
  function claimOk(parked, by, now, ttl = SREC_CLAIM_MS) {
    if (!parked) return false;
    const held = parked.claim;
    return !(held && held.by !== by && now - held.at < ttl);
  }

  // A merge, not a rebuild: only who holds the take changes, the take itself is the tester's bytes.
  function applyClaim(parked, by, now) {
    return { ...parked, claim: { by, at: now } };
  }

  // Deleted, not nulled: a null claim would still read as held.
  function dropClaim(parked, by) {
    if (!parked || !parked.claim || parked.claim.by !== by) return null;
    const rest = { ...parked };
    delete rest.claim;
    return rest;
  }

  // A claim reads, checks and stamps across awaits — one at a time, or two panels both find it free.
  let chain = Promise.resolve();

  // Rejections are swallowed: a claim that throws must not strand the panel behind it.
  function serialize(fn) {
    chain = chain.then(fn).catch(() => {});
    return chain;
  }

  return { SREC_CLAIM_MS, claimOk, applyClaim, dropClaim, serialize };
})();
