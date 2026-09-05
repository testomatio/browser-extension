// The parked take's record and its transitions (IIFE global `SrecParked`). A finished screen
// recording waits in chrome.storage.session as one object; what that object's fields are, and what
// the review's yes or its cut does to them, is decided here rather than inside the worker's message
// switch, where it sat between chrome.debugger calls and the broadcasts.
//
// Pure: the clock is the only outside thing any of these read, and it arrives as `now`. Nothing here
// touches chrome, storage or the panel — the caller writes the record and tells whoever is listening.
//
// Loaded by the service worker only, ahead of screenrec/session.js.

const SrecParked = (() => {
  // What the tester finds in their Downloads, so it is the LOCAL minute they recorded in, not a UTC one.
  function srecName(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `screen-recording-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
      + `-${p(now.getHours())}${p(now.getMinutes())}.webm`;
  }

  // The record itself. `reason` falls back through the file's own, because a cap ends the recording
  // inside the offscreen document and only the file it pushes knows that.
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
