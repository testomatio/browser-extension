// The parked take's record and its transitions; pure, the caller writes it and tells the listeners.

const SrecParked = (() => {
  // What the tester finds in their Downloads, so it is the local minute they recorded in, not a UTC one.
  function srecName(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `screen-recording-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
      + `-${p(now.getHours())}${p(now.getMinutes())}.webm`;
  }

  // `reason` falls back through the file's own: a cap ends the recording inside the offscreen document.
  function buildParked(file, st, reason, now = new Date()) {
    return {
      url: file.url,
      size: file.size,
      ms: file.ms || 0,
      reason: file.reason || reason || 'user',
      name: srecName(now),
      recordId: (st && st.recordId) || null,
      reviewed: false,
    };
  }

  // A merge, not a rebuild: a panel already holding the upload must not lose its claim to the review.
  function applyReviewed(parked) {
    return { ...parked, reviewed: true };
  }

  // A rebuild, so the claim is dropped: those were the bytes before the cut, and this file is not them.
  function applyTrimmed(parked, msg) {
    return {
      url: msg.url,
      size: msg.size || 0,
      ms: msg.ms || 0,
      reason: parked.reason,
      name: parked.name,
      recordId: parked.recordId,
      reviewed: true,
    };
  }

  return { srecName, buildParked, applyReviewed, applyTrimmed };
})();
