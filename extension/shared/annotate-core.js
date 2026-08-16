// Annotator core (shared) — the DOM-agnostic tool/canvas engine behind both the
// editor-page annotator (editor/annotate.js) and the on-page overlay
// (overlay/annotate-overlay.js). It renders its toolbar + a viewport-fitted
// canvas into a MOUNT element it is given, handles all drawing, and reports
// Apply/Cancel via callbacks — it does NOT know about chrome.storage, tabs, or
// shadow roots. The consumer owns the handoff.
//
// The toolset is Jam-parity (#188): eleven tools on an icon rail — Select, Pen,
// Arrow, Line, Box, Ellipse, Highlight, Blur, Text, Number, Crop — over a shared
// ink (an eight-colour palette × three stroke weights) that a picked tool draws
// with AND a selected annotation is restyled by. Undo/redo, Copy, Download and a
// keyboard map (one letter per tool) sit on the same bar.
//
// What is FIXED and not themed: the ink. A palette colour is the same value in
// the swatch, on the canvas and in the exported JPEG — the picture is the
// contract, so those hexes are literals here, not tokens. The mosaic is real
// pixel destruction (block-aligned, so live preview == JPEG export). The
// un-blurred original is dropped from memory on Apply (privacy).
//
// Crop is state, not an op: `crop` is a rect in ORIGINAL image coordinates that
// render() blits from, so a crop is lossless and undoable — the base image is
// never rewritten, and ops shift with it. Undo is a bounded stack of {ops, crop}
// snapshots pushed before every mutation, so a move, a delete and a crop are all
// undoable; redo is the mirror stack, cleared by the next fresh mutation. The
// selection marquee is UI only and never reaches the export.
//
// Three outcomes (Block 5 — unified Cancel semantics):
//   Apply         → onApply(<flattened annotated JPEG>)
//   Keep original → onApply(<the original, un-annotated image>) — Esc and closing
//                   the overlay/tab map here; the consumer can't tell it from
//                   Apply (both hand back a dataURL), which is exactly the point:
//                   "keep" stages/uploads the raw shot instead of dropping it.
//   Discard       → onCancel() — returns nothing; the only path that drops the
//                   shot. confirmDiscard() guards it when annotations were drawn.
//
// AnnotateCore.create(opts) -> { hooks, destroy }
//   opts.mount          : element the toolbar + stage are rendered into
//   opts.doc            : document to bind keydown to (defaults to mount's)
//   opts.dataUrl        : the base image to annotate
//   opts.onApply(url)   : called with a dataURL to use (Apply OR Keep original)
//   opts.onCancel()     : called on Discard — nothing to hand back (async ok)
//   opts.confirmDiscard(): guard before discarding on Discard (default: allow)
//   opts.onReady(hooks) : called once the image is loaded and the canvas is live
//   hooks               : `__annot`-style test surface (same philosophy as __tc)
//   destroy()           : detach the global listeners (for the overlay teardown)

/* global chrome, Icons, Tooltip */
window.AnnotateCore = (() => {
  'use strict';

  // ---- fixed ink ---------------------------------------------------------
  // Eight colours, the Jam set mapped onto this product's ramps. These are
  // LITERALS on purpose: a swatch, the live canvas and the exported JPEG must be
  // the same colour, and an exported picture cannot follow a theme.
  const PALETTE = [
    { id: 'red', hex: '#dc2626', label: 'Red' },
    { id: 'orange', hex: '#ea580c', label: 'Orange' },
    { id: 'yellow', hex: '#eab308', label: 'Yellow' },
    { id: 'green', hex: '#16a34a', label: 'Green' },
    { id: 'blue', hex: '#2563eb', label: 'Blue' },
    { id: 'purple', hex: '#9333ea', label: 'Purple' },
    { id: 'black', hex: '#171717', label: 'Black' },
    { id: 'white', hex: '#ffffff', label: 'White' },
  ];
  const STROKE = PALETTE[0].hex;   // red — the annotator's long-standing default
  const WIDTH = 3;                 // the M weight, and the default every legacy op falls back to
  const WEIGHTS = [
    { id: 's', w: 2, label: 'S', tip: 'Thin stroke' },
    { id: 'm', w: WIDTH, label: 'M', tip: 'Medium stroke' },
    { id: 'l', w: 6, label: 'L', tip: 'Thick stroke' },
  ];

  const BLOCK = 12;         // the destroying pass: mosaic block ≈ 12px at natural scale
  const BLUR_R = 10;        // …and the softening pass over it, in the same units
  const JPEG_Q = 0.85;
  const HIT_CSS = 8;        // select-tool grab tolerance, in CSS px (scaled to natural)
  const HISTORY_MAX = 50;   // bounded undo snapshot stack
  const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const HL_ALPHA = 0.35;    // highlighter: a marker lays ink ON the picture…
  const HL_WIDTH = 6;       // …six times the stroke weight, like a real chisel tip
  const MIN_CROP = 16;      // a crop drag under this (natural px) is a mis-click
  const FLASH_MS = 2400;    // how long Copy/Download report back on the bar
  // Step badge: a mark ON the screenshot, not a stamp over it. The radius is a
  // fraction of the image width (so it reads the same at any resolution) with a
  // floor for tiny shots, and it scales with the stroke weight exactly as the
  // text label's size does — S/M/L is the badge's size control.
  const NUM_DIV = 110;
  const NUM_MIN = 9;
  const HANDLE_CSS = 9;      // the selection grip, in CSS px (scaled to natural)
  const HANDLE_HIT_CSS = 12; // …and how close the pointer has to be to grab one
  // The freehand tools draw with the TOOL under the pointer, in the ink it is
  // about to lay down; the geometric ones keep the crosshair, because a glyph
  // would cover the exact corner the drag has to start on.
  const CURSOR_GLYPH = { pen: 'draw', highlight: 'ink_highlighter' };
  const CURSOR_PX = 28;      // a cursor image the OS will still draw at 1:1

  // One row per tool: the rail order, the icon, the letter that picks it, and the
  // sentence the tooltip says. `id` is also the op's `tool` — 'pixelate' keeps its
  // old id (the stored ops and the e2e hooks name it) under Jam's word, "Blur".
  const TOOLS = [
    { id: 'select', label: 'Select', icon: 'arrow_selector_tool', key: 'v', tip: 'Select an annotation: drag to move, double-click a label to retype it, Delete to remove' },
    { id: 'pen', label: 'Pen', icon: 'draw', key: 'p', tip: 'Draw freehand' },
    { id: 'arrow', label: 'Arrow', icon: 'north_east', key: 'a', tip: 'Point at something' },
    { id: 'line', label: 'Line', icon: 'horizontal_rule', key: 'l', tip: 'Straight line, no head' },
    { id: 'rect', label: 'Box', icon: 'crop_square', key: 'r', tip: 'Box an area' },
    { id: 'ellipse', label: 'Ellipse', icon: 'radio_button_unchecked', key: 'o', tip: 'Circle an area' },
    { id: 'highlight', label: 'Highlight', icon: 'ink_highlighter', key: 'h', tip: 'Marker: translucent ink over the picture' },
    { id: 'pixelate', label: 'Blur', icon: 'blur_on', key: 'b', tip: 'Blur (destroys the pixels — hide sensitive data)' },
    { id: 'text', label: 'Text', icon: 'title', key: 't', tip: 'Text (click the image, type, Enter)' },
    { id: 'number', label: 'Number', icon: 'counter_1', key: 'n', tip: 'Numbered step marker — click to drop 1, 2, 3…; S/M/L sizes the badge' },
    { id: 'crop', label: 'Crop', icon: 'crop', key: 'c', tip: 'Crop: drag the part worth keeping (undoable)' },
  ];
  // The tools that draw with a colour (Blur and Crop have no ink of their own).
  const INKED = new Set(['pen', 'arrow', 'line', 'rect', 'ellipse', 'highlight', 'text', 'number']);
  // The tools whose gesture is a free path rather than a two-point drag. Text and
  // Number are clicks; everything else left over is a drag.
  const FREEHAND = new Set(['pen', 'highlight']);

  function create(opts) {
    const doc = opts.doc || (opts.mount && opts.mount.ownerDocument) || document;
    const mount = opts.mount;
    const onApply = opts.onApply || (() => {});
    const onCancel = opts.onCancel || (() => {});
    const confirmDiscard = opts.confirmDiscard || (() => true);

    let canvas = null;
    let ctx = null;
    let img = null;           // the base image (dropped after Apply)
    let W = 0;                // canvas size == the CROP size, not the image's
    let H = 0;
    let crop = null;          // {x, y, w, h} in ORIGINAL image coords
    const ops = [];           // vector list, in canvas (cropped) coords
    const history = [];       // undo: {ops, crop} snapshots taken before each mutation
    const future = [];        // redo: the mirror stack, cleared by a fresh mutation
    let selected = null;      // index into ops while the Select tool holds one
    let tool = 'arrow';
    let color = STROKE;
    let weight = WIDTH;
    let done = false;         // guards double Apply/Cancel
    let stage = null;
    let wrap = null;
    let helpBox = null;
    let flash = null;
    let flashTimer = null;
    const toolBtns = {};
    const swatchBtns = {};
    const weightBtns = {};
    let redoBtn = null;
    let undoBtn = null;
    let deleteBtn = null;
    let inkBtn = null;        // the ink in force, and what opens the eight
    let inkMenu = null;
    let onKeyDown = null;

    const opColor = (op) => op.color || STROKE;
    const opWidth = (op) => op.width || WIDTH;

    // ---- rendering --------------------------------------------------------
    function render(previewOp) {
      ctx.clearRect(0, 0, W, H);
      // The crop is a source rect on the untouched base image — cropping never
      // rewrites pixels, which is what makes it undoable.
      if (img && crop) ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      const preview = previewOp && previewOp.tool !== 'crop' ? previewOp : null;
      const list = preview ? ops.concat([preview]) : ops;
      // A label being retyped is drawn by its input, not here — otherwise the old
      // wording sits under the new one.
      const editing = textInput && textInput.edit;
      for (const op of list) if (op !== editing) drawOp(op);
      if (previewOp && previewOp.tool === 'crop') drawCropPreview(previewOp);
      // Marquee last, above every op — but not around the label the input has
      // taken over, which carries its own frame.
      if (selected != null && ops[selected] !== editing) drawSelection();
    }

    function drawOp(op) {
      if (op.tool === 'pixelate') pixelate(op);
      else if (op.tool === 'rect') strokeRect(op);
      else if (op.tool === 'ellipse') strokeEllipse(op);
      else if (op.tool === 'arrow') strokeArrow(op);
      else if (op.tool === 'line') strokeLine(op);
      else if (op.tool === 'pen' || op.tool === 'highlight') strokePath(op);
      else if (op.tool === 'text') drawText(op);
      else if (op.tool === 'number') drawNumber(op);
    }

    // Text label: bold, size scales with the image so it reads the same at any
    // resolution, and with the stroke weight so S/M/L mean something here too.
    // Op is {tool:'text', x, y, text, color, size} in natural coords; `size` is
    // frozen at commit, so a later weight change cannot reflow an existing label.
    function textSize() { return Math.max(16, Math.round(W / 50)); }
    function textSizeFor(op) { return op.size || textSize(); }
    function drawText(op) {
      if (!op.text) return;
      ctx.save();
      ctx.fillStyle = opColor(op);
      ctx.font = `bold ${textSizeFor(op)}px ${TEXT_FONT}`;
      ctx.textBaseline = 'top';
      ctx.fillText(op.text, op.x, op.y);
      ctx.restore();
    }

    // Numbered step marker: a filled disc in the current ink with the numeral
    // knocked out of it. `r` is frozen at drop time, like the text size.
    function numberRadius() {
      return Math.max(NUM_MIN, Math.round((W / NUM_DIV) * (weight / WIDTH)));
    }
    function numberRadiusFor(op) { return op.r || numberRadius(); }
    function drawNumber(op) {
      const r = numberRadiusFor(op);
      const ink = opColor(op);
      const label = String(op.n);
      ctx.save();
      ctx.beginPath();
      ctx.arc(op.x, op.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      // A white disc needs an edge to exist at all on a light screenshot; the
      // numeral flips to the ink for the same reason.
      ctx.lineWidth = Math.max(1, r / 8);
      ctx.strokeStyle = ink === '#ffffff' ? '#171717' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = ink === '#ffffff' ? '#171717' : '#ffffff';
      // Two digits already crowd the disc and three overflow it, so the numeral
      // steps down instead of growing the badge — a run of steps has to stay one
      // size from 1 to 100.
      const fit = label.length > 2 ? 0.85 : label.length > 1 ? 1.05 : 1.25;
      ctx.font = `bold ${Math.round(r * fit)}px ${TEXT_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, op.x, op.y + r * 0.06);
      ctx.restore();
    }

    function strokeRect(op) {
      const x = Math.min(op.x1, op.x2);
      const y = Math.min(op.y1, op.y2);
      ctx.save();
      ctx.strokeStyle = opColor(op);
      ctx.lineWidth = opWidth(op);
      ctx.lineJoin = 'miter';
      ctx.strokeRect(x, y, Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
      ctx.restore();
    }

    // The ellipse inscribed in the drag rect — the shape Jam's Ellipse draws, and
    // the one that reads as "circle this" over a screenshot.
    function ellipseOf(op) {
      return {
        cx: (op.x1 + op.x2) / 2,
        cy: (op.y1 + op.y2) / 2,
        rx: Math.abs(op.x2 - op.x1) / 2,
        ry: Math.abs(op.y2 - op.y1) / 2,
      };
    }
    function strokeEllipse(op) {
      const e = ellipseOf(op);
      if (e.rx < 0.5 || e.ry < 0.5) return;
      ctx.save();
      ctx.strokeStyle = opColor(op);
      ctx.lineWidth = opWidth(op);
      ctx.beginPath();
      ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    function strokeLine(op) {
      ctx.save();
      ctx.strokeStyle = opColor(op);
      ctx.lineWidth = opWidth(op);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      ctx.restore();
    }

    // Pen and Highlight are one path op with two skins: the pen is opaque at the
    // stroke weight, the marker is translucent, six times as wide, and multiplied
    // into the picture so the pixels under it stay readable — which is the whole
    // point of a highlighter.
    function strokePath(op) {
      const pts = op.pts || [];
      if (!pts.length) return;
      const marker = op.tool === 'highlight';
      ctx.save();
      ctx.strokeStyle = opColor(op);
      ctx.lineWidth = opWidth(op) * (marker ? HL_WIDTH : 1);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (marker) {
        ctx.globalAlpha = HL_ALPHA;
        ctx.globalCompositeOperation = 'multiply';
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);  // a dot is still a mark
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    // An arrow BENDS. `cx, cy` is a quadratic control point, absent on a straight
    // one and on every arrow drawn before the bend handle existed — so a stored
    // op keeps meaning exactly what it meant.
    const curved = (op) => op.cx != null && op.cy != null;
    // Where the curve actually passes at t=0.5 — which is where the bend handle
    // has to sit, so the handle is ON the line the tester sees.
    function arrowMid(op) {
      if (!curved(op)) return { x: (op.x1 + op.x2) / 2, y: (op.y1 + op.y2) / 2 };
      return {
        x: 0.25 * op.x1 + 0.5 * op.cx + 0.25 * op.x2,
        y: 0.25 * op.y1 + 0.5 * op.cy + 0.25 * op.y2,
      };
    }
    // …and the control point that puts the curve THROUGH (px, py): the inverse of
    // the line above, so dragging the handle drags the curve itself, not a
    // control point sitting twice as far away as the hand expects.
    const arrowCtrl = (op, px, py) => ({
      cx: 2 * px - (op.x1 + op.x2) / 2,
      cy: 2 * py - (op.y1 + op.y2) / 2,
    });
    // The shaft, flattened to points — ONE source of truth for the stroke, the
    // hit test and the bounding box, so a curved arrow is grabbable exactly where
    // it is drawn.
    function arrowPath(op, n = 24) {
      if (!curved(op)) return [{ x: op.x1, y: op.y1 }, { x: op.x2, y: op.y2 }];
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        pts.push({
          x: u * u * op.x1 + 2 * u * t * op.cx + t * t * op.x2,
          y: u * u * op.y1 + 2 * u * t * op.cy + t * t * op.y2,
        });
      }
      return pts;
    }

    // The arrowhead triangle in natural coords — one source of truth for both
    // the fill below and the select tool's hit test. It grows with the stroke,
    // and it points along the shaft's END tangent, which on a curve is the
    // direction out of the control point rather than out of the tail.
    function headLen(op) { return Math.max(10, opWidth(op) * 4); }
    function arrowHead(op) {
      const head = headLen(op);
      const fromX = curved(op) ? op.cx : op.x1;
      const fromY = curved(op) ? op.cy : op.y1;
      const ang = Math.atan2(op.y2 - fromY, op.x2 - fromX);
      return [
        [op.x2, op.y2],
        [op.x2 - head * Math.cos(ang - Math.PI / 6), op.y2 - head * Math.sin(ang - Math.PI / 6)],
        [op.x2 - head * Math.cos(ang + Math.PI / 6), op.y2 - head * Math.sin(ang + Math.PI / 6)],
      ];
    }

    function strokeArrow(op) {
      const head = headLen(op);
      const tri = arrowHead(op);
      // Shaft stops short of the tip so the solid head is not double-drawn —
      // measured back along the END tangent, the same direction the head points.
      const fromX = curved(op) ? op.cx : op.x1;
      const fromY = curved(op) ? op.cy : op.y1;
      const dx = op.x2 - fromX;
      const dy = op.y2 - fromY;
      const len = Math.hypot(dx, dy) || 1;
      const bx = op.x2 - (head * 0.9) * (dx / len);
      const by = op.y2 - (head * 0.9) * (dy / len);
      const ink = opColor(op);
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.fillStyle = ink;
      ctx.lineWidth = opWidth(op);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      if (curved(op)) ctx.quadraticCurveTo(op.cx, op.cy, bx, by);
      else ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tri[0][0], tri[0][1]);
      ctx.lineTo(tri[1][0], tri[1][1]);
      ctx.lineTo(tri[2][0], tri[2][1]);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Blur, in two passes, because the two things asked of it pull apart:
    //
    //   DESTROY   the region is first averaged into flat mosaic blocks. This is
    //             the privacy half and it is not negotiable — a plain gaussian
    //             is a reversible convolution, and "hide sensitive data" cannot
    //             rest on how hard the reversal is. After this pass the original
    //             pixels are gone from the canvas, and the canvas is the export.
    //   SOFTEN    then the flattened region is redrawn through `filter: blur()`,
    //             so what ships is the smooth frosted panel a reader expects
    //             rather than a Minecraft square — no information comes back,
    //             the blocks are only interpolated between.
    //
    // Both passes run inside render(), so the live preview IS what toDataURL
    // encodes. The blur reads a padded source so the region's edge mixes with the
    // real pixels around it, then paints clipped to the region: a hard edge on
    // the rectangle, no dark rim where a transparent outside bled in.
    function pixelate(op) {
      const x0 = Math.round(Math.min(op.x1, op.x2));
      const y0 = Math.round(Math.min(op.y1, op.y2));
      const w = Math.round(Math.max(op.x1, op.x2)) - x0;
      const h = Math.round(Math.max(op.y1, op.y2)) - y0;
      if (w < 1 || h < 1) return;
      const cx = Math.max(0, x0);
      const cy = Math.max(0, y0);
      const cw = Math.min(w - (cx - x0), W - cx);
      const ch = Math.min(h - (cy - y0), H - cy);
      if (cw < 1 || ch < 1) return;
      const region = ctx.getImageData(cx, cy, cw, ch);
      const d = region.data;
      for (let by = 0; by < ch; by += BLOCK) {
        for (let bx = 0; bx < cw; bx += BLOCK) {
          const bw = Math.min(BLOCK, cw - bx);
          const bh = Math.min(BLOCK, ch - by);
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          let n = 0;
          for (let yy = 0; yy < bh; yy++) {
            for (let xx = 0; xx < bw; xx++) {
              const i = ((by + yy) * cw + (bx + xx)) * 4;
              r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
            }
          }
          r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n); a = Math.round(a / n);
          for (let yy = 0; yy < bh; yy++) {
            for (let xx = 0; xx < bw; xx++) {
              const i = ((by + yy) * cw + (bx + xx)) * 4;
              d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
            }
          }
        }
      }
      ctx.putImageData(region, cx, cy);
      soften(cx, cy, cw, ch);
    }

    // The second pass. `filter` is a canvas-2d feature (Chrome 123+ is the floor
    // here); where it is missing the mosaic simply stays, which is the picture
    // this tool shipped with and still hides what it has to.
    function soften(cx, cy, cw, ch) {
      const pad = Math.min(BLUR_R * 2, cx, cy, W - (cx + cw), H - (cy + ch));
      const sx = cx - pad;
      const sy = cy - pad;
      const sw = cw + pad * 2;
      const sh = ch + pad * 2;
      let buf = null;
      try {
        buf = doc.createElement('canvas');
        buf.width = sw;
        buf.height = sh;
        const bctx = buf.getContext('2d');
        if (!bctx || !('filter' in bctx)) return;
        bctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
        ctx.filter = `blur(${BLUR_R}px)`;
        ctx.drawImage(buf, sx, sy);
        ctx.restore();
      } catch { /* no filter support: the mosaic stands on its own */ }
    }

    // Crop preview: everything OUTSIDE the drag is scrimmed, so the gesture reads
    // as "this is what survives". UI only — it never reaches the export.
    function drawCropPreview(op) {
      const b = rectOf(op);
      ctx.save();
      ctx.fillStyle = 'rgba(23, 23, 23, 0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.fill('evenodd');
      const s = natPerCss();
      ctx.setLineDash([]);
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.restore();
    }

    // ---- geometry / hit-testing (Select tool, #68) ------------------------
    // The canvas is at natural resolution but CSS-scaled to fit the stage, so
    // tolerances are converted CSS px -> natural px: the grab zone then feels
    // the same on screen whatever the capture resolution.
    function natPerCss() {
      if (!canvas) return 1;
      const r = canvas.getBoundingClientRect();
      return (r.width && canvas.width / r.width) || 1;
    }
    function hitPad() { return HIT_CSS * natPerCss(); }

    const rectOf = (op) => ({
      x1: Math.min(op.x1, op.x2), y1: Math.min(op.y1, op.y2),
      x2: Math.max(op.x1, op.x2), y2: Math.max(op.y1, op.y2),
    });

    function distToSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      if (!l2) return Math.hypot(px - x1, py - y1);
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    // Same-side test against the three edges (winding-agnostic).
    function inTriangle(px, py, t) {
      const side = (ax, ay, bx, by) => (ax - px) * (by - py) - (bx - px) * (ay - py);
      const d1 = side(t[0][0], t[0][1], t[1][0], t[1][1]);
      const d2 = side(t[1][0], t[1][1], t[2][0], t[2][1]);
      const d3 = side(t[2][0], t[2][1], t[0][0], t[0][1]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    }

    // Text bbox: measured width at the committed font, height ≈ size × 1.25
    // from (x, y) — the label is drawn with textBaseline 'top'.
    function textBox(op) {
      const size = textSizeFor(op);
      ctx.save();
      ctx.font = `bold ${size}px ${TEXT_FONT}`;
      const w = ctx.measureText(op.text || '').width;
      ctx.restore();
      return { x1: op.x, y1: op.y, x2: op.x + w, y2: op.y + size * 1.25 };
    }
    // Axis-aligned bbox of any op, natural coords, no padding.
    function opBox(op) {
      if (op.tool === 'text') return textBox(op);
      if (op.tool === 'number') {
        const r = numberRadiusFor(op);
        return { x1: op.x - r, y1: op.y - r, x2: op.x + r, y2: op.y + r };
      }
      if (op.pts && op.pts.length) {
        const xs = op.pts.map((p) => p.x);
        const ys = op.pts.map((p) => p.y);
        // The marker is drawn far wider than its path, so its box has to own that.
        const pad = opWidth(op) * (op.tool === 'highlight' ? HL_WIDTH : 1) / 2;
        return {
          x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad,
          x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad,
        };
      }
      // A bent arrow leaves its own end-to-end box, so the box is taken off the
      // curve as drawn (the head is inside it — it is drawn back from the tip).
      if (op.tool === 'arrow' && curved(op)) {
        const pts = arrowPath(op);
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const pad = headLen(op) / 2;
        return {
          x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad,
          x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad,
        };
      }
      return rectOf(op);
    }
    const inBox = (x, y, b, pad) => x >= b.x1 - pad && x <= b.x2 + pad && y >= b.y1 - pad && y <= b.y2 + pad;

    function hitsPath(op, x, y) {
      const pts = op.pts || [];
      const tol = hitPad() + (opWidth(op) * (op.tool === 'highlight' ? HL_WIDTH : 1)) / 2;
      if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= tol;
      for (let i = 1; i < pts.length; i++) {
        if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return true;
      }
      return false;
    }

    function hitsOp(op, x, y) {
      if (op.tool === 'arrow') {
        const tol = hitPad() + opWidth(op) / 2;
        const pts = arrowPath(op);   // two points when it is straight
        for (let i = 1; i < pts.length; i++) {
          if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return true;
        }
        return inTriangle(x, y, arrowHead(op));
      }
      if (op.tool === 'line') return distToSeg(x, y, op.x1, op.y1, op.x2, op.y2) <= hitPad() + opWidth(op) / 2;
      if (op.tool === 'pen' || op.tool === 'highlight') return hitsPath(op, x, y);
      if (op.tool === 'rect' || op.tool === 'ellipse') return inBox(x, y, opBox(op), hitPad()); // inside OR near an edge
      if (op.tool === 'pixelate') return inBox(x, y, opBox(op), 0);     // inside the region
      if (op.tool === 'text') return inBox(x, y, textBox(op), 0);
      if (op.tool === 'number') {
        const r = numberRadiusFor(op);
        return Math.hypot(x - op.x, y - op.y) <= r + hitPad() / 2;
      }
      return false;
    }
    // Topmost first: the last op drawn sits on top, so it wins the click.
    function hitTest(x, y) {
      for (let i = ops.length - 1; i >= 0; i--) if (hitsOp(ops[i], x, y)) return i;
      return null;
    }
    function translateOp(op, dx, dy) {
      if (op.pts) { for (const p of op.pts) { p.x += dx; p.y += dy; } return; }
      if (op.tool === 'text' || op.tool === 'number') { op.x += dx; op.y += dy; return; }
      op.x1 += dx; op.y1 += dy; op.x2 += dx; op.y2 += dy;
      if (curved(op)) { op.cx += dx; op.cy += dy; }   // the bend travels with the arrow
    }

    // ---- selection handles -------------------------------------------------
    // A shape that can only be MOVED is a shape that has to be deleted and drawn
    // again to be a little bigger — which loses its place on the picture. So the
    // geometric ops carry grips:
    //
    //   Box · Ellipse · Blur   the four corners; the one dragged writes the pair
    //                          of coordinates it is made of, so the opposite
    //                          corner stays put whichever way the shape was drawn
    //   Line                   its two ends
    //   Arrow                  its two ends AND a bend in the middle, which is
    //                          the one grip that changes the SHAPE rather than
    //                          the size: an arrow that has to reach around a
    //                          dialog is the ordinary case in a screenshot
    //
    // Freehand ink, a label and a step badge have none: a path is its own shape,
    // and the other two are sized by the weight.
    function handlesOf(op) {
      if (!op) return [];
      if (op.tool === 'rect' || op.tool === 'ellipse' || op.tool === 'pixelate') {
        return [
          { id: 'x1y1', x: op.x1, y: op.y1 },
          { id: 'x2y1', x: op.x2, y: op.y1 },
          { id: 'x2y2', x: op.x2, y: op.y2 },
          { id: 'x1y2', x: op.x1, y: op.y2 },
        ];
      }
      if (op.tool === 'line') return [{ id: 'a', x: op.x1, y: op.y1 }, { id: 'b', x: op.x2, y: op.y2 }];
      if (op.tool === 'arrow') {
        const m = arrowMid(op);
        return [
          { id: 'a', x: op.x1, y: op.y1 },
          { id: 'bend', x: m.x, y: m.y },
          { id: 'b', x: op.x2, y: op.y2 },
        ];
      }
      return [];
    }
    // Write one grip's new position back into the op.
    function moveHandle(op, id, x, y) {
      if (id === 'bend') { Object.assign(op, arrowCtrl(op, x, y)); return; }
      if (id === 'a') { op.x1 = x; op.y1 = y; return; }
      if (id === 'b') { op.x2 = x; op.y2 = y; return; }
      if (id.includes('x1')) op.x1 = x; else op.x2 = x;
      if (id.includes('y1')) op.y1 = y; else op.y2 = y;
    }
    // The grip under the pointer, if any — grips win over the shape's body, so a
    // corner is always grabbable even when the shape is small.
    function handleAt(op, x, y) {
      const tol = HANDLE_HIT_CSS * natPerCss();
      for (const h of handlesOf(op)) if (Math.hypot(x - h.x, y - h.y) <= tol) return h;
      return null;
    }
    // What the pointer says a grip will do. The two diagonals are read off the
    // shape as it stands, so a box dragged right-to-left still names the corner
    // the hand is actually on.
    function handleCursor(op, h) {
      if (h.id === 'bend') return 'crosshair';
      if (h.id === 'a' || h.id === 'b') return 'move';
      const flipped = (op.x2 - op.x1) * (op.y2 - op.y1) < 0;
      const main = h.id === 'x1y1' || h.id === 'x2y2';
      return (main !== flipped) ? 'nwse-resize' : 'nesw-resize';
    }

    // Selection marquee: white underlay + dark dash so it reads on any
    // screenshot, then the grips on top. Drawn after every op and never exported
    // (see exportJpeg).
    function drawSelection() {
      const op = ops[selected];
      if (!op) return;
      const s = natPerCss();
      const b = opBox(op);
      const pad = 4 * s;
      const x = b.x1 - pad;
      const y = b.y1 - pad;
      const w = (b.x2 - b.x1) + pad * 2;
      const h = (b.y2 - b.y1) + pad * 2;
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([6 * s, 4 * s]);
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = '#171717'; // neutral-900 — fixed marquee ink, not a theme token
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      // The grips: a filled square in the marquee's own two inks, so the picture
      // under them cannot swallow one. Same fixed colours, same reason.
      const g = HANDLE_CSS * s;
      ctx.lineWidth = 1.5 * s;
      for (const hd of handlesOf(op)) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.strokeStyle = '#171717';
        ctx.beginPath();
        // The bend is round — it changes the line's shape, where a square corner
        // changes its size, and one look has to tell them apart.
        if (hd.id === 'bend') ctx.arc(hd.x, hd.y, g / 2, 0, Math.PI * 2);
        else ctx.rect(hd.x - g / 2, hd.y - g / 2, g, g);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- history ----------------------------------------------------------
    // Undo is a bounded stack of {ops, crop} states pushed BEFORE every mutating
    // action (add, move-commit, delete, restyle, crop): ops.pop() could only ever
    // undo an add, and a crop is not in ops at all. Redo is the mirror stack — a
    // fresh mutation clears it, which is the one rule every editor shares.
    const copyOps = () => ops.map((o) => (o.pts ? { ...o, pts: o.pts.map((p) => ({ ...p })) } : { ...o }));
    const snapshot = () => ({ ops: copyOps(), crop: { ...crop } });
    function restore(snap) {
      ops.splice(0, ops.length, ...snap.ops);
      selected = null;
      // The snapshot's ops are already in the snapshot's crop coordinates, so this
      // resizes WITHOUT the shift a fresh crop applies.
      resizeToCrop(snap.crop);
    }
    function pushHistory(snap) {
      history.push(snap || snapshot());
      if (history.length > HISTORY_MAX) history.shift();
      future.length = 0;
      syncHistoryBtns();
    }
    function syncHistoryBtns() {
      if (undoBtn) undoBtn.disabled = !history.length;
      if (redoBtn) redoBtn.disabled = !future.length;
      if (deleteBtn) deleteBtn.disabled = selected == null;
    }

    // ---- crop -------------------------------------------------------------
    // `crop` is a window on the ORIGINAL image. Two ways in: resize the canvas to
    // a crop whose coordinates the ops are ALREADY in (boot, undo/redo), or move
    // the window and drag the ops along with it (the crop tool).
    function resizeToCrop(next) {
      crop = { ...next };
      W = crop.w;
      H = crop.h;
      canvas.width = W;
      canvas.height = H;
      fitCanvas();
      render();
    }
    function shiftToCrop(next) {
      const prev = crop;
      if (prev) {
        const dx = prev.x - next.x;
        const dy = prev.y - next.y;
        if (dx || dy) for (const op of ops) translateOp(op, dx, dy);
      }
      resizeToCrop(next);
    }
    // Commit a crop drawn in CANVAS coords: it composes with the crop already in
    // force, and is clamped to it (a drag off the edge cannot grow the picture).
    function applyCrop(box) {
      const x1 = Math.max(0, Math.round(Math.min(box.x1, box.x2)));
      const y1 = Math.max(0, Math.round(Math.min(box.y1, box.y2)));
      const x2 = Math.min(W, Math.round(Math.max(box.x1, box.x2)));
      const y2 = Math.min(H, Math.round(Math.max(box.y1, box.y2)));
      const w = x2 - x1;
      const h = y2 - y1;
      if (w < MIN_CROP || h < MIN_CROP) { render(); return false; }
      pushHistory();
      shiftToCrop({ x: crop.x + x1, y: crop.y + y1, w, h });
      return true;
    }

    // ---- pointer drawing --------------------------------------------------
    let drag = null;
    let moveDrag = null;      // { x, y, before, moved } while dragging the selection
    let sizeDrag = null;      // { id, before, moved } while dragging one of its grips
    function toNatural(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    }
    // The style every new op is born with. Blur and Crop carry none — one has no
    // ink, the other is not an op at all.
    const inkFor = (t) => (INKED.has(t) ? { color, width: weight } : {});

    function onDown(e) {
      if (tool === 'select') { onSelectDown(e); return; }
      // preventDefault: the click's default action would move focus off the just-
      // opened input, whose empty-blur handler would instantly cancel it.
      if (tool === 'text') { e.preventDefault(); openTextInput(e); return; } // a click, not a drag
      if (tool === 'number') { e.preventDefault(); dropNumber(e); return; }  // a click too
      canvas.setPointerCapture?.(e.pointerId);
      const p = toNatural(e);
      if (FREEHAND.has(tool)) { drag = { pts: [{ x: p.x, y: p.y }] }; return; }
      drag = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }

    // Select + double-click on a label reopens it as the input that wrote it.
    // (The two clicks under it have already selected it and armed a move that
    // never moved — that arming is dropped here, so the retype starts clean.)
    function onDblClick(e) {
      if (tool !== 'select') return;
      const p = toNatural(e);
      const i = hitTest(p.x, p.y);
      if (i == null || ops[i].tool !== 'text') return;
      e.preventDefault();
      moveDrag = null;
      editText(i);
    }

    // Select tool: a grip resizes, a hit selects (and arms a move), empty space
    // deselects. The pre-drag snapshot is taken here but only committed on a real
    // move (onUp) — a plain selecting click must not add an undo step.
    function onSelectDown(e) {
      const p = toNatural(e);
      // A grip belongs to the CURRENT selection and beats everything under it:
      // a corner sits on top of its own shape, and often on top of another.
      const held = selected != null ? handleAt(ops[selected], p.x, p.y) : null;
      if (held) {
        canvas.setPointerCapture?.(e.pointerId);
        sizeDrag = { id: held.id, before: snapshot(), moved: false };
        return;
      }
      const i = hitTest(p.x, p.y);
      selected = i;
      if (i != null) {
        canvas.setPointerCapture?.(e.pointerId);
        moveDrag = { x: p.x, y: p.y, before: snapshot(), moved: false };
        syncInkToSelection();
      }
      syncHistoryBtns();
      render();
    }

    // ---- number tool ------------------------------------------------------
    // The counter is DERIVED, never stored: undoing a badge has to give its
    // number back, and a separate counter would drift the moment it did.
    function nextNumber() {
      let max = 0;
      for (const op of ops) if (op.tool === 'number' && op.n > max) max = op.n;
      return max + 1;
    }
    function dropNumber(e) {
      const p = toNatural(e);
      pushHistory();
      ops.push({ tool: 'number', x: p.x, y: p.y, n: nextNumber(), r: numberRadius(), ...inkFor('number') });
      render();
    }

    // ---- text tool --------------------------------------------------------
    // A click opens a positioned inline <input> over the click point (CSS coords);
    // Enter (or a non-empty blur) commits {tool:'text', x, y, text} in NATURAL
    // coords, Esc (or an empty blur) cancels. Only one input is open at a time.
    //
    // The SAME input retypes a label already on the picture — Select, then
    // double-click it. Text is the one op whose content is not its geometry, so
    // it is the one op that cannot be corrected by dragging: without this, fixing
    // a typo means deleting the label and drawing it again in the right place.
    // `edit` is the op the input stands in for, and while it stands in for one
    // the canvas stops drawing that op (there would otherwise be two of it).
    let textInput = null;     // { input, x, y, size, edit } while editing

    // Place the input over a point in NATURAL canvas coords, in the ink and at
    // the on-screen size the committed label has (natural size × the CSS scale).
    function mkTextInput({ x, y, size, ink, value, edit }) {
      removeTextInput();
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / (canvas.width || 1);
      const input = doc.createElement('input');
      input.type = 'text';
      input.className = 'annot-text-input';
      input.style.left = `${rect.left + x * scale}px`;
      input.style.top = `${rect.top + y * scale}px`;
      input.style.font = `bold ${Math.max(11, size * scale)}px ${TEXT_FONT}`;
      input.style.color = ink;
      if (value) input.value = value;
      // Live inside the mount (not document.body) so the overlay's shadow root
      // styles it and page CSS cannot leak in; position:fixed keeps viewport coords.
      wrap.append(input);
      textInput = { input, x, y, size, edit: edit || null };
      input.addEventListener('keydown', onTextKey);
      input.addEventListener('blur', onTextBlur);
      // Deferred focus: survive any focus juggling the opening click still does.
      // A retype opens on the whole label selected, so typing replaces it.
      requestAnimationFrame(() => {
        if (!textInput || textInput.input !== input) return;
        input.focus();
        if (edit) input.select();
      });
    }
    function openTextInput(e) {
      const p = toNatural(e);
      mkTextInput({ x: p.x, y: p.y, size: Math.round(textSize() * (weight / WIDTH)), ink: color });
    }
    // Reopen a committed label as the input that wrote it.
    function editText(i) {
      const op = ops[i];
      if (!op || op.tool !== 'text') return false;
      selected = i;
      syncHistoryBtns();
      mkTextInput({ x: op.x, y: op.y, size: textSizeFor(op), ink: opColor(op), value: op.text, edit: op });
      render();
      return true;
    }
    function onTextKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelText(); }
      else e.stopPropagation();   // a letter being TYPED must not pick a tool
    }
    function onTextBlur() {
      if (!textInput) return;
      // A retype always commits: emptying an existing label is a real edit
      // (below), where emptying a NEW one is just a click that changed its mind.
      if (textInput.edit || textInput.input.value.trim()) commitText(); else cancelText();
    }
    function commitText() {
      if (!textInput) return;
      const { x, y, size, edit, input } = textInput;
      const text = input.value;
      const body = text && text.trim() ? text : '';
      removeTextInput();
      if (edit) {
        const i = ops.indexOf(edit);
        if (i < 0) { render(); return; }        // deleted under the input
        // Retyped to nothing, the label is gone — the same as deleting it, and
        // as undoable. Anything else is one undo step for the new wording.
        if (!body) {
          pushHistory();
          ops.splice(i, 1);
          selected = null;
          syncHistoryBtns();
        } else if (body !== edit.text) {
          pushHistory();
          edit.text = body;
        }
        render();
        return;
      }
      if (body) {
        pushHistory();
        ops.push({ tool: 'text', x, y, text, size, ...inkFor('text') });
        render();
      }
    }
    // Cancelling a retype puts the label back on the canvas it was lifted off.
    function cancelText() {
      const wasEdit = !!(textInput && textInput.edit);
      removeTextInput();
      if (wasEdit) render();
    }
    function removeTextInput() {
      if (!textInput) return;
      const { input } = textInput;
      input.removeEventListener('keydown', onTextKey);
      input.removeEventListener('blur', onTextBlur);
      input.remove();
      textInput = null;
    }

    function onMove(e) {
      if (sizeDrag) {
        const p = toNatural(e);
        sizeDrag.moved = true;
        moveHandle(ops[selected], sizeDrag.id, p.x, p.y);
        render();
        return;
      }
      if (moveDrag) {
        const p = toNatural(e);
        const dx = p.x - moveDrag.x;
        const dy = p.y - moveDrag.y;
        moveDrag.x = p.x; moveDrag.y = p.y;
        if (dx || dy) { moveDrag.moved = true; translateOp(ops[selected], dx, dy); render(); }
        return;
      }
      if (tool === 'select') {
        // Hover affordance: the grip's own cursor over a grip, 'move' over a hit
        // (the class), the plain pointer over the picture.
        const p = toNatural(e);
        const held = selected != null ? handleAt(ops[selected], p.x, p.y) : null;
        canvas.style.cursor = held ? handleCursor(ops[selected], held) : '';
        canvas.classList.toggle('over', !held && hitTest(p.x, p.y) != null);
        return;
      }
      if (!drag) return;
      const p = toNatural(e);
      if (drag.pts) {
        // Thin the path: a pointer emits far more samples than the curve needs,
        // and every one of them would be stored and re-stroked.
        const last = drag.pts[drag.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5) drag.pts.push({ x: p.x, y: p.y });
        render({ tool, pts: drag.pts, ...inkFor(tool) });
        return;
      }
      drag.x2 = p.x; drag.y2 = p.y;
      render({ tool, ...drag, ...inkFor(tool) });
    }

    function onUp() {
      if (sizeDrag) {
        // One drag == one undo step, and only if the grip actually went anywhere.
        if (sizeDrag.moved) pushHistory(sizeDrag.before);
        sizeDrag = null;
        render();
        return;
      }
      if (moveDrag) {
        // One drag == one undo step: the snapshot lands on release, and only if
        // the op actually moved (a plain selecting click must not add a step).
        if (moveDrag.moved) pushHistory(moveDrag.before);
        moveDrag = null;
        render();
        return;
      }
      if (!drag) return;
      const gesture = drag;
      drag = null;
      if (gesture.pts) {
        // A single tap still leaves a dot; anything shorter than that is nothing.
        if (gesture.pts.length) { pushHistory(); ops.push({ tool, pts: gesture.pts, ...inkFor(tool) }); }
        render();
        return;
      }
      if (tool === 'crop') { applyCrop(gesture); return; }
      const op = { tool, x1: gesture.x1, y1: gesture.y1, x2: gesture.x2, y2: gesture.y2, ...inkFor(tool) };
      // Ignore a zero-length click (no real gesture).
      if (Math.hypot(op.x2 - op.x1, op.y2 - op.y1) >= 2) { pushHistory(); ops.push(op); }
      render();
    }

    // ---- tools / ink ------------------------------------------------------
    function setTool(t) {
      if (!TOOLS.some((x) => x.id === t)) return;
      tool = t;
      selected = null;   // a selection never survives a tool switch (Backspace vs the text input)
      moveDrag = null;
      sizeDrag = null;
      removeTextInput();
      closeInkMenu();
      for (const spec of TOOLS) {
        const b = toolBtns[spec.id];
        if (!b) continue;
        // `selected` is the LIBRARY's chosen-control class (components.css) —
        // the same state a picked filter or a picked view wears everywhere else.
        b.classList.toggle('selected', spec.id === t);
        b.setAttribute('aria-pressed', spec.id === t ? 'true' : 'false');
      }
      if (canvas) {
        canvas.classList.toggle('pick', t === 'select');  // cursor: default (vs crosshair)
        canvas.classList.toggle('crop', t === 'crop');
        canvas.classList.remove('over');
      }
      paintCursor();
      syncHistoryBtns();
      if (ctx && W) render();
    }

    // ---- the drawing cursor -------------------------------------------------
    // The freehand tools put the TOOL in the hand, in the ink it is about to lay
    // down: the colour is then under the pointer, where the drawing is, instead
    // of only up on the bar. Built from the same Material path the tool's own
    // button wears (shared/icons.js), so the cursor and the button cannot drift.
    function cursorFor(t) {
      const name = CURSOR_GLYPH[t];
      const path = name && typeof Icons !== 'undefined' && Icons.PATHS ? Icons.PATHS[name] : null;
      if (!path) return '';
      const box = Icons.boxOf ? Icons.boxOf(name) : '0 -960 960 960';
      // A halo in the opposite ink, so the glyph survives both a white dialog and
      // a dark screenshot — the same rule the white step badge follows.
      const halo = color === '#ffffff' ? '#171717' : '#ffffff';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_PX}" height="${CURSOR_PX}" viewBox="${box}">`
        + `<path d="${path}" fill="${color}" stroke="${halo}" stroke-width="72"`
        + ' stroke-linejoin="round" paint-order="stroke"/></svg>';
      // Both glyphs are drawn nib-down-left, and the nib is where the ink lands.
      return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 2 ${CURSOR_PX - 3}, crosshair`;
    }
    function paintCursor() {
      if (!canvas) return;
      canvas.style.cursor = cursorFor(tool);   // '' hands it back to the CSS classes
    }

    // Picking a colour or a weight while an annotation is selected RESTYLES it —
    // the same gesture Jam has, and the reason the ink lives outside the ops.
    function restyleSelected() {
      const op = ops[selected];
      if (!op || !INKED.has(op.tool)) return false;
      pushHistory();
      op.color = color;
      if (op.tool !== 'number') op.width = weight;
      if (op.tool === 'text') op.size = Math.round(textSize() * (weight / WIDTH));
      if (op.tool === 'number') op.r = numberRadius();
      render();
      return true;
    }
    // …and selecting one adopts ITS ink, so the next shape continues the thought.
    function syncInkToSelection() {
      const op = ops[selected];
      if (!op || !INKED.has(op.tool)) return;
      color = opColor(op);
      if (op.width) weight = op.width;
      paintInkBtns();
    }
    function paintInkBtns() {
      // The trigger IS the current ink — a swatch that says what the next stroke
      // will be, which is the whole reason the row folded into one control.
      if (inkBtn) {
        const c = PALETTE.find((p) => p.hex === color);
        inkBtn.style.setProperty('--swatch', color);
        tip(inkBtn, `Colour: ${c ? c.label : color} (1 – ${PALETTE.length})`);
      }
      for (const c of PALETTE) {
        const b = swatchBtns[c.id];
        if (b) {
          b.classList.toggle('active', c.hex === color);
          b.setAttribute('aria-pressed', c.hex === color ? 'true' : 'false');
        }
      }
      for (const s of WEIGHTS) {
        const b = weightBtns[s.id];
        if (b) {
          b.classList.toggle('active', s.w === weight);
          b.setAttribute('aria-pressed', s.w === weight ? 'true' : 'false');
        }
      }
    }
    function setColor(hexOrId) {
      const found = PALETTE.find((c) => c.id === hexOrId || c.hex === hexOrId);
      color = found ? found.hex : color;
      paintInkBtns();
      paintCursor();   // the pen in the hand is the ink it draws with
      if (textInput) textInput.input.style.color = color;
      restyleSelected();
    }
    function setWeight(idOrPx) {
      const found = WEIGHTS.find((s) => s.id === idOrPx || s.w === idOrPx);
      weight = found ? found.w : weight;
      paintInkBtns();
      restyleSelected();
    }

    function undo() {
      if (!history.length) return;
      future.push(snapshot());
      restore(history.pop());
      syncHistoryBtns();
    }
    function redo() {
      if (!future.length) return;
      history.push(snapshot());
      restore(future.pop());
      syncHistoryBtns();
    }

    function deleteSelected() {
      if (selected == null || !ops[selected]) return false;
      pushHistory();
      ops.splice(selected, 1);
      selected = null;
      syncHistoryBtns();
      render();
      return true;
    }

    // ---- export / hand-off ------------------------------------------------
    // The marquee lives on the canvas, so it must be off it while the pixels are
    // read back: re-render clean, encode, restore the selection.
    function withCleanCanvas(fn) {
      const sel = selected;
      if (sel != null) { selected = null; render(); }
      const out = fn();
      if (sel != null) { selected = sel; render(); }
      return out;
    }
    function exportJpeg() {
      return withCleanCanvas(() => canvas.toDataURL('image/jpeg', JPEG_Q));
    }

    function say(text) {
      if (!flash) return;
      flash.textContent = text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { if (flash) flash.textContent = ''; }, FLASH_MS);
    }

    // Copy: PNG, because that is the only image type the clipboard reliably takes.
    // It can still be refused (no focus, no permission) — the bar says which.
    // The marquee is taken off by hand rather than through withCleanCanvas:
    // toBlob is asynchronous, so the selection has to stay off the canvas until
    // the encoder has actually answered.
    async function copyImage() {
      const sel = selected;
      if (sel != null) { selected = null; render(); }
      try {
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!blob) throw new Error('encode failed');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        say('Copied to the clipboard');
      } catch {
        say("The browser wouldn't let this page copy — use Download");
      } finally {
        if (sel != null) { selected = sel; render(); }
      }
    }

    // Download: a real anchor click, so the browser owns the save dialog and the
    // image never leaves the machine.
    function downloadImage() {
      try {
        const a = doc.createElement('a');
        a.href = exportJpeg();
        a.download = 'annotated-screenshot.jpg';
        wrap.append(a);
        a.click();
        a.remove();
        say('Saved to your downloads');
      } catch {
        say('Could not save the image');
      }
    }

    function dropImg() {
      try { if (img) img.src = ''; } catch { /* noop */ }
      img = null;
    }

    // Apply: flatten the annotations and hand back the merged JPEG. Drops the
    // un-blurred original from memory before reporting back (privacy).
    async function applyResult() {
      if (done) return;
      done = true;
      selected = null;              // never flatten the selection marquee
      const resultDataUrl = exportJpeg();
      dropImg();
      await onApply(resultDataUrl);
    }

    // Keep original: hand back the ORIGINAL un-annotated image (annotations AND
    // the crop are dropped, the shot is kept). Same callback as Apply — the
    // consumer treats a returned dataURL identically (owner-approved: keep
    // stages/uploads the raw shot). Esc + overlay/tab close route here.
    async function keepResult() {
      if (done) return;
      done = true;
      dropImg();
      await onApply(opts.dataUrl);
    }

    // Discard: return nothing (the only path that drops the shot).
    async function discardResult() {
      if (done) return;
      done = true;
      dropImg();
      await onCancel();
    }

    // Discard button: confirm only when work was actually done (a crop counts —
    // it is as destructive to lose as a drawing).
    function requestDiscard() {
      if ((ops.length || history.length) && !confirmDiscard()) return;
      discardResult();
    }

    // ---- layout -----------------------------------------------------------
    function fitCanvas() {
      if (!stage || !W) return;
      const availW = stage.clientWidth - 16;
      const availH = stage.clientHeight - 16;
      const scale = Math.min(availW / W, availH / H, 1) || 1;
      canvas.style.width = `${Math.max(1, Math.round(W * scale))}px`;
      canvas.style.height = `${Math.max(1, Math.round(H * scale))}px`;
    }

    // ---- chrome -----------------------------------------------------------
    // `icon` is a Material Symbols name from shared/icons.js — injected into the
    // page alongside this file, and loaded before it on the editor page.
    //
    // One tooltip in both hosts: shared/tooltip.js is loaded on the editor page
    // and injected with this file into the overlay, where it is mounted INTO the
    // shadow root (a document-level hit test only ever finds the shadow host).
    // The browser's `title` is the last resort — an injection that lost the
    // tooltip must still say what its buttons do.
    function tip(el, text) {
      if (!text) return;
      if (typeof Tooltip !== 'undefined') Tooltip.set(el, text);
      else el.title = text;
    }

    function mkBtn(id, label, title, cls, icon) {
      const b = doc.createElement('button');
      b.id = id;
      // `btn` is the shared control (shared/components.css) in BOTH hosts now —
      // the overlay's shadow root is handed that stylesheet at injection time, so
      // this toolbar is made of library buttons rather than of a copy of them.
      // `annot-btn` is left as the hook this file's own layout rules aim at.
      b.className = `btn annot-btn${cls ? ` ${cls}` : ''}`;
      b.type = 'button';
      const mark = icon && Icons.elIn(doc, icon, 16);
      if (mark) b.append(mark);
      if (label) {
        const span = doc.createElement('span');
        span.textContent = label;
        b.append(span);
      } else {
        b.setAttribute('aria-label', title || id);   // icon-only: the tip IS the name
      }
      tip(b, title);
      return b;
    }

    function mkGroup(...kids) {
      const g = doc.createElement('div');
      g.className = 'annot-group';
      g.append(...kids);
      return g;
    }
    function mkSep() {
      const s = doc.createElement('span');
      s.className = 'annot-sep';
      s.setAttribute('aria-hidden', 'true');
      return s;
    }

    // The eleven tools, icon-only: at this count a word per button is a second
    // toolbar, and the letter in the tip is the label that actually gets learnt.
    function mkToolRail() {
      const rail = doc.createElement('div');
      rail.className = 'annot-group';
      rail.setAttribute('role', 'toolbar');
      rail.setAttribute('aria-label', 'Annotation tools');
      for (const spec of TOOLS) {
        const b = mkBtn(`annot-${spec.id}`, '', `${spec.label} (${spec.key.toUpperCase()}) — ${spec.tip}`, 'icon', spec.icon);
        b.addEventListener('click', () => setTool(spec.id));
        toolBtns[spec.id] = b;
        rail.append(b);
      }
      return rail;
    }

    // The ink, as ONE control: a swatch showing the colour in force, which opens
    // the eight over it. Eleven tools, eight swatches and three weights did not
    // fit a 380px bar without wrapping it onto a second line, and seven of those
    // eight swatches are, at any moment, answering a question nobody asked. The
    // colours themselves stay inline `--swatch` values: they are data (the ink
    // that will be in the picture), not a theme decision.
    //
    // A hand-built popover rather than shared/dropdown.js: this file is injected
    // into a page on its own, so it has no dependency to call, and a menu with a
    // row of swatches in it is not the field-with-a-list that component builds.
    function mkInkPicker() {
      const wrap = doc.createElement('div');
      wrap.className = 'annot-ink';   // position: relative — the menu hangs off it

      inkBtn = doc.createElement('button');
      inkBtn.type = 'button';
      inkBtn.id = 'annot-color';
      inkBtn.className = 'swatch annot-ink-trigger';
      inkBtn.setAttribute('aria-haspopup', 'true');
      inkBtn.setAttribute('aria-expanded', 'false');
      inkBtn.setAttribute('aria-label', 'Colour');

      inkMenu = doc.createElement('div');
      inkMenu.className = 'menu annot-ink-menu';
      inkMenu.id = 'annot-color-menu';
      inkMenu.hidden = true;
      const row = doc.createElement('div');
      row.className = 'swatch-row';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Annotation colour');
      for (const c of PALETTE) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.id = `annot-color-${c.id}`;
        b.className = 'swatch';
        b.dataset.color = c.id;
        b.style.setProperty('--swatch', c.hex);
        b.setAttribute('aria-label', c.label);
        tip(b, c.label);
        // Picking is an answer, so the menu closes on it — and the keyboard goes
        // back to the control that opened it, never to nothing.
        b.addEventListener('click', () => { setColor(c.hex); closeInkMenu(true); });
        swatchBtns[c.id] = b;
        row.append(b);
      }
      inkMenu.append(row);
      inkBtn.addEventListener('click', () => (inkMenu.hidden ? openInkMenu() : closeInkMenu(true)));
      wrap.append(inkBtn, inkMenu);
      return wrap;
    }
    function openInkMenu() {
      if (!inkMenu) return;
      inkMenu.hidden = false;
      inkBtn.setAttribute('aria-expanded', 'true');
      const chosen = inkMenu.querySelector('.swatch.active') || inkMenu.querySelector('.swatch');
      if (chosen) chosen.focus();
    }
    function closeInkMenu(refocus) {
      if (!inkMenu || inkMenu.hidden) return;
      inkMenu.hidden = true;
      inkBtn.setAttribute('aria-expanded', 'false');
      if (refocus) inkBtn.focus();
    }

    function mkWeights() {
      const seg = doc.createElement('div');
      seg.className = 'segmented annot-segmented';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Stroke weight');
      for (const s of WEIGHTS) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.id = `annot-size-${s.id}`;
        b.className = 'segment annot-segment';
        b.textContent = s.label;
        tip(b, s.tip);
        b.addEventListener('click', () => setWeight(s.w));
        weightBtns[s.id] = b;
        seg.append(b);
      }
      return seg;
    }

    // The keyboard map, spelled out — every letter below is bound in onKeyDown,
    // and this list is built from the SAME TOOLS table, so it cannot go stale.
    function mkHelp() {
      const box = doc.createElement('div');
      box.className = 'annot-help';
      box.id = 'annot-help';
      box.hidden = true;
      const h = doc.createElement('h2');
      h.textContent = 'Keyboard';
      const dl = doc.createElement('dl');
      const rows = [
        ...TOOLS.map((t) => [t.key.toUpperCase(), t.label]),
        ['Double-click', 'Retype a text label (Select)'],
        ['1 – 8', 'Pick a colour'],
        ['[ / ]', 'Thinner / thicker stroke'],
        ['⌘/Ctrl Z', 'Undo'],
        ['⇧⌘/Ctrl Z', 'Redo'],
        ['Delete', 'Remove the selected annotation'],
        ['⌘/Ctrl ⏎', 'Apply'],
        ['Esc', 'Keep the original'],
        ['?', 'This list'],
      ];
      for (const [k, v] of rows) {
        const dt = doc.createElement('dt');
        dt.textContent = k;
        const dd = doc.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
      box.append(h, dl);
      return box;
    }
    function toggleHelp(force) {
      if (!helpBox) return;
      helpBox.hidden = force == null ? !helpBox.hidden : !force;
    }

    function buildChrome() {
      mount.replaceChildren();
      wrap = doc.createElement('div');
      wrap.className = 'annot';

      const bar = doc.createElement('header');
      // `bar` is the shared page-chrome row on the editor page; in the overlay's
      // shadow root, which that stylesheet cannot reach, `annot-bar` carries the
      // whole shape instead.
      bar.className = 'bar sticky annot-bar';

      undoBtn = mkBtn('annot-undo', '', 'Undo (⌘/Ctrl Z) — a move, a delete and a crop count too', 'icon', 'undo');
      redoBtn = mkBtn('annot-redo', '', 'Redo (⇧⌘/Ctrl Z)', 'icon', 'redo');
      deleteBtn = mkBtn('annot-delete', '', 'Remove the selected annotation (Delete)', 'icon', 'delete');
      const copyBtn = mkBtn('annot-copy', '', 'Copy the image to the clipboard', 'icon', 'content_copy');
      const saveBtn = mkBtn('annot-download', '', 'Download the image', 'icon', 'download');
      const helpBtn = mkBtn('annot-help-toggle', '', 'Keyboard shortcuts (?)', 'icon', 'keyboard');

      flash = doc.createElement('span');
      flash.className = 'annot-flash';
      flash.id = 'annot-flash';
      flash.setAttribute('role', 'status');

      const spacer = doc.createElement('div');
      spacer.className = 'annot-spacer';
      const discardBtn = mkBtn('annot-discard', 'Discard', 'Discard the screenshot — attach nothing', 'danger');
      const keepBtn = mkBtn('annot-keep', 'Keep original', 'Close and keep the raw screenshot — the annotations AND the crop are dropped (Esc)');
      const applyBtn = mkBtn('annot-apply', 'Apply', 'Flatten and return the annotated image (⌘/Ctrl ⏎)', 'primary');

      bar.append(
        mkToolRail(), mkSep(),
        mkInkPicker(), mkWeights(), mkSep(),
        mkGroup(undoBtn, redoBtn, deleteBtn), mkSep(),
        mkGroup(copyBtn, saveBtn, helpBtn),
        flash, spacer,
        mkGroup(discardBtn, keepBtn, applyBtn),
      );

      stage = doc.createElement('div');
      stage.id = 'annot-stage';
      stage.className = 'annot-stage';
      canvas = doc.createElement('canvas');
      canvas.id = 'annot-canvas';
      canvas.className = 'annot-canvas';
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      helpBox = mkHelp();
      stage.append(canvas, helpBox);

      wrap.append(bar, stage);
      mount.append(wrap);

      undoBtn.addEventListener('click', undo);
      redoBtn.addEventListener('click', redo);
      deleteBtn.addEventListener('click', deleteSelected);
      copyBtn.addEventListener('click', copyImage);
      saveBtn.addEventListener('click', downloadImage);
      helpBtn.addEventListener('click', () => toggleHelp());
      discardBtn.addEventListener('click', requestDiscard);
      keepBtn.addEventListener('click', keepResult);
      applyBtn.addEventListener('click', applyResult);

      // Anywhere else in the overlay closes the ink menu. On `wrap` and in the
      // capture phase: in the on-page overlay a document-level listener sees the
      // shadow HOST as the target and could not tell inside from outside.
      wrap.addEventListener('pointerdown', (e) => {
        if (!inkMenu || inkMenu.hidden) return;
        if (!(e.target && e.target.closest && e.target.closest('.annot-ink'))) closeInkMenu();
      }, true);

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('dblclick', onDblClick);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      window.addEventListener('resize', fitCanvas);
      doc.addEventListener('keydown', onKey);
      onKeyDown = onKey;
    }

    // ---- keyboard ---------------------------------------------------------
    // One letter per tool, the digits for the palette, the brackets for the
    // weight — the map Jam trained testers on. Nothing here fires while the text
    // input owns the keyboard (its own keydown stops the event before this).
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (inkMenu && !inkMenu.hidden) { e.preventDefault(); e.stopPropagation(); closeInkMenu(true); return; }
        if (!helpBox.hidden) { e.preventDefault(); e.stopPropagation(); toggleHelp(false); return; }
        if (selected != null) { e.preventDefault(); e.stopPropagation(); selected = null; syncHistoryBtns(); render(); return; }
        e.preventDefault();
        keepResult();
        return;
      }
      if (mod && (e.key === 'Enter' || e.key === 'NumpadEnter')) { e.preventDefault(); applyResult(); return; }
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;   // every binding below is a bare key
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null && !textInput) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (textInput) return;
      if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
      if (e.key === '[') { e.preventDefault(); stepWeight(-1); return; }
      if (e.key === ']') { e.preventDefault(); stepWeight(1); return; }
      const digit = Number(e.key);
      if (digit >= 1 && digit <= PALETTE.length) { e.preventDefault(); setColor(PALETTE[digit - 1].hex); return; }
      const spec = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (spec) { e.preventDefault(); setTool(spec.id); }
    }
    function stepWeight(dir) {
      const i = WEIGHTS.findIndex((s) => s.w === weight);
      const next = WEIGHTS[Math.max(0, Math.min(WEIGHTS.length - 1, (i < 0 ? 1 : i) + dir))];
      if (next) setWeight(next.w);
    }

    function fail(text) {
      mount.replaceChildren();
      const box = doc.createElement('div');
      box.className = 'annot-msg';
      const p = doc.createElement('p');
      p.textContent = text;
      box.append(p);
      mount.append(box);
    }

    // ---- e2e hooks (same philosophy as the editor's window.__tc) ----------
    // `add`/`undo` run the SAME ops list + render as a pointer gesture, in natural
    // canvas coordinates; `pixelAt` reads the live canvas (pre-JPEG) so the block
    // invariant is asserted losslessly.
    const hooks = {
      ready: false,
      natural: () => ({ w: W, h: H }),
      ops: () => copyOps(),
      tool: () => tool,
      setTool,
      // The ink, readable and settable — `setColor` takes a palette id or a hex,
      // `setWidth` an id ('s'|'m'|'l') or the pixel weight.
      palette: () => PALETTE.map((c) => ({ ...c })),
      color: () => color,
      width: () => weight,
      setColor,
      setWidth: setWeight,
      // The step badge's radius at the ink in force — the weight sizes it.
      badgeRadius: () => numberRadius(),
      add: (op) => {
        const t = op.tool || tool;
        pushHistory();
        const ink = INKED.has(t) ? { color: op.color || color, width: op.width || weight } : {};
        if (t === 'text') ops.push({ tool: 'text', x: op.x, y: op.y, text: op.text, size: op.size, ...ink });
        else if (t === 'number') ops.push({ tool: 'number', x: op.x, y: op.y, n: op.n || nextNumber(), r: op.r || numberRadius(), ...ink });
        else if (op.pts) ops.push({ tool: t, pts: op.pts.map((p) => ({ ...p })), ...ink });
        // `cx, cy` rides along when it is given: a bent arrow is the same op with
        // a control point, and a test has to be able to make one.
        else {
          const bend = op.cx != null && op.cy != null ? { cx: op.cx, cy: op.cy } : {};
          ops.push({ tool: t, x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2, ...bend, ...ink });
        }
        render();
      },
      undo,
      redo,
      // Editing (#68) in the same natural coords: select hit-tests topmost-first
      // and returns the index (null = empty space, i.e. a deselecting click).
      select: (x, y) => {
        selected = hitTest(x, y);
        if (selected != null) syncInkToSelection();
        syncHistoryBtns();
        render();
        return selected;
      },
      selected: () => selected,
      // Select + double-click, without a mouse: reopen the label at (x, y).
      editTextAt: (x, y) => {
        const i = hitTest(x, y);
        return i != null && ops[i].tool === 'text' ? editText(i) : false;
      },
      moveSelected: (dx, dy) => {
        if (selected == null) return false;
        pushHistory();
        translateOp(ops[selected], dx, dy);
        render();
        return true;
      },
      // The grips of whatever is selected, and dragging one — the pointer gesture
      // without a pointer (see handlesOf/moveHandle).
      handles: () => (selected == null ? [] : handlesOf(ops[selected]).map((h) => ({ ...h }))),
      dragHandle: (id, x, y) => {
        if (selected == null) return false;
        const has = handlesOf(ops[selected]).some((h) => h.id === id);
        if (!has) return false;
        pushHistory();
        moveHandle(ops[selected], id, x, y);
        render();
        return true;
      },
      deleteSelected,
      // Crop, in canvas coords — the same commit the drag makes on release.
      crop: () => ({ ...crop }),
      applyCrop: (box) => applyCrop(box),
      pixelAt: (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data),
      exportDataUrl: () => exportJpeg(),
      copy: () => copyImage(),
      download: () => downloadImage(),
      help: (on) => { toggleHelp(on); return !helpBox.hidden; },
      apply: () => applyResult(),
      keep: () => keepResult(),        // hand back the original un-annotated shot
      discard: () => discardResult(),  // hand back nothing (drop the shot)
      cancel: () => discardResult(),   // back-compat alias: old cancel == discard
    };

    function destroy() {
      try { doc.removeEventListener('keydown', onKeyDown); } catch { /* noop */ }
      try { window.removeEventListener('resize', fitCanvas); } catch { /* noop */ }
      try { removeTextInput(); } catch { /* noop */ }
      try { clearTimeout(flashTimer); } catch { /* noop */ }
    }

    // ---- boot -------------------------------------------------------------
    buildChrome();
    setTool('arrow');
    paintInkBtns();
    syncHistoryBtns();
    img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      resizeToCrop({ x: 0, y: 0, w: iw, h: ih });   // sizes the canvas and renders
      hooks.ready = true;
      if (opts.onReady) opts.onReady(hooks);
    };
    img.onerror = () => fail('Could not load the captured image.');
    img.src = opts.dataUrl;

    return { hooks, destroy };
  }

  return { create, PALETTE, WEIGHTS, TOOLS };
})();
