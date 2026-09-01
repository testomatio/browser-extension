// WebM duration patch (IIFE global `WebmDuration`). MediaRecorder streams its file, so the
// Segment carries an unknown size and Info carries NO Duration — every player then treats the
// take as an endless stream: the scrubber sits at the end and seeking misbehaves. The recorder
// KNOWS how long it ran, so the missing element is written in right after the take is a Blob.
//
// EBML in the small: an element is <id vint><size vint><body>. Only three landmarks matter —
// Segment (0x18538067), its Info (0x1549A966), and inside it TimecodeScale (0x2AD7B1) and
// Duration (0x4489, a float in TimecodeScale units). Anything unexpected returns the ORIGINAL
// bytes: a take that plays without a scrubber beats one that does not play at all.

const WebmDuration = (() => {
  const ID_SEGMENT = 0x18538067;
  const ID_INFO = 0x1549a966;
  const ID_TIMECODESCALE = 0x2ad7b1;
  const ID_DURATION = 0x4489;

  // An EBML id is read WITH its marker bits (ids compare as written); a size vint WITHOUT them.
  function readVint(bytes, at, keepMarker) {
    const first = bytes[at];
    if (first === undefined) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x100 >> len))) len += 1;
    if (len > 8 || at + len > bytes.length) return null;
    let value = keepMarker ? first : first & (0xff >> len);
    let unknown = !keepMarker && (first & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i += 1) {
      value = value * 256 + bytes[at + i];
      if (!keepMarker && bytes[at + i] !== 0xff) unknown = false;
    }
    return { value, len, unknown };
  }

  function readUint(bytes, at, len) {
    let v = 0;
    for (let i = 0; i < len; i += 1) v = v * 256 + bytes[at + i];
    return v;
  }

  // <element id><size> reader; body sits at `at + idLen + sizeLen`.
  function readElement(bytes, at) {
    const id = readVint(bytes, at, true);
    if (!id) return null;
    const size = readVint(bytes, at + id.len, false);
    if (!size) return null;
    return { id: id.value, bodyAt: at + id.len + size.len, bodyLen: size.value, sizeAt: at + id.len, sizeLen: size.len, unknown: size.unknown };
  }

  // The Duration element, ready to append: 0x44 0x89, an 8-byte size vint is overkill — a
  // one-byte 0x88 says "8 bytes of float64" and floats are how every muxer writes it.
  function durationElement(units) {
    const out = new Uint8Array(11);
    out[0] = 0x44; out[1] = 0x89; out[2] = 0x88;
    new DataView(out.buffer).setFloat64(3, units);
    return out;
  }

  /** The same bytes with Duration written into Segment>Info; the input when anything is off. */
  function patch(buffer, ms) {
    const bytes = new Uint8Array(buffer);
    try {
      if (!(ms > 0)) return bytes;
      // Top level: EBML header, then the Segment.
      let at = 0;
      let segment = null;
      while (at < bytes.length) {
        const el = readElement(bytes, at);
        if (!el) return bytes;
        if (el.id === ID_SEGMENT) { segment = el; break; }
        at = el.bodyAt + el.bodyLen;
      }
      if (!segment) return bytes;
      // A DEFINITE Segment size would need re-encoding too — MediaRecorder never writes one,
      // and guessing on a file some other muxer made is how a take gets corrupted.
      if (!segment.unknown) return bytes;
      // Inside the Segment: the Info element.
      at = segment.bodyAt;
      let info = null;
      while (at < bytes.length) {
        const el = readElement(bytes, at);
        if (!el || el.unknown) return bytes;
        if (el.id === ID_INFO) { info = el; break; }
        at = el.bodyAt + el.bodyLen;
      }
      if (!info) return bytes;
      // Inside Info: the scale Duration counts in, and whether a Duration already stands.
      let scale = 1000000;
      at = info.bodyAt;
      const infoEnd = info.bodyAt + info.bodyLen;
      while (at < infoEnd) {
        const el = readElement(bytes, at);
        if (!el || el.unknown) return bytes;
        if (el.id === ID_TIMECODESCALE) scale = readUint(bytes, el.bodyAt, el.bodyLen) || scale;
        if (el.id === ID_DURATION && el.bodyLen === 8) {
          const out = bytes.slice();
          new DataView(out.buffer).setFloat64(el.bodyAt, (ms * 1000000) / scale);
          return out;
        }
        if (el.id === ID_DURATION) return bytes; // an odd width — leave the file alone
        at = el.bodyAt + el.bodyLen;
      }
      // No Duration: Info grows by 11 bytes, and its size is re-encoded as an 8-byte vint so
      // the new length always fits without touching anything after the (unknown-size) Segment.
      const dur = durationElement((ms * 1000000) / scale);
      const newLen = info.bodyLen + dur.length;
      const sizeVint = new Uint8Array(8);
      sizeVint[0] = 0x01; // 8-byte vint marker
      for (let i = 7; i >= 1; i -= 1) sizeVint[i] = (newLen / 2 ** ((7 - i) * 8)) & 0xff;
      const out = new Uint8Array(bytes.length - info.sizeLen + 8 + dur.length);
      out.set(bytes.subarray(0, info.sizeAt), 0);
      out.set(sizeVint, info.sizeAt);
      out.set(bytes.subarray(info.bodyAt, infoEnd), info.sizeAt + 8);
      out.set(dur, info.sizeAt + 8 + info.bodyLen);
      out.set(bytes.subarray(infoEnd), info.sizeAt + 8 + info.bodyLen + dur.length);
      return out;
    } catch {
      return bytes;
    }
  }

  return { patch };
})();
