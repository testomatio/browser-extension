// The full-page shot's double-compose guard (IIFE global `FullpageTrim`): `overshoot` is the
// arithmetic on its own, `trimToDocument` the re-encode that acts on it.

const FullpageTrim = (() => {
  // #158 belt to the clip's braces: a misbehaving Chrome composes the page TWICE, stacked — cut
  // back to the document height. Scale from the WIDTH ratio, not devicePixelRatio, so zoom is absorbed.
  const FULLPAGE_SLACK = 4;     // px of rounding we forgive outright
  const FULLPAGE_TOLERANCE = 1.1; // ...and the share of the document beyond it

  // How tall one page SHOULD be at the bitmap's scale, how tall it may be before it is two, and
  // whether this bitmap is over that. An unusable clip leaves `trims` false, never a NaN cut.
  function overshoot(bmpW, bmpH, clip) {
    const scale = bmpW / clip.width;
    const expected = Math.round(clip.height * scale);
    const limit = Math.max(expected + FULLPAGE_SLACK, Math.round(expected * FULLPAGE_TOLERANCE));
    return { expected, limit, trims: scale > 0 && expected > 0 && bmpH > limit };
  }

  async function trimToDocument(dataUrl, clip) {
    if (!clip || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
      return { dataUrl, trimmed: false };
    }
    let bmp = null;
    try {
      bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const { expected, trims } = overshoot(bmp.width, bmp.height, clip);
      if (!trims) return { dataUrl, trimmed: false };
      const canvas = new OffscreenCanvas(bmp.width, expected);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      // Chunked: fromCharCode.apply blows the argument limit on a megabyte of JPEG.
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, trimmed: true };
    } catch {
      return { dataUrl, trimmed: false }; // never lose the shot over the guard
    } finally {
      try { bmp?.close(); } catch { /* best effort */ }
    }
  }

  return { trimToDocument, overshoot, FULLPAGE_SLACK, FULLPAGE_TOLERANCE };
})();
