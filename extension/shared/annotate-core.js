// Annotator core: the DOM-agnostic toolbar + canvas engine behind editor/annotate.js and
// overlay/annotate-overlay.js — it knows nothing of chrome.storage, tabs or shadow roots.

/* global chrome, AnnotGeometry, AnnotHistory, Icons, Tooltip */
window.AnnotateCore = (() => {
  'use strict';

  // ---- fixed ink ---------------------------------------------------------
  // Literal hexes, not theme tokens: swatch, canvas and exported JPEG must match.
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
  const STROKE = PALETTE[0].hex;
  // The M weight, and the marker's multiplier: read off AnnotGeometry so the ink this file paints
  // and the boxes that file measures can never drift apart.
  const WIDTH = AnnotGeometry.WIDTH;
  const WEIGHTS = [
    { id: 's', w: 2, label: 'S', tip: 'Thin stroke' },
    { id: 'm', w: WIDTH, label: 'M', tip: 'Medium stroke' },
    { id: 'l', w: 6, label: 'L', tip: 'Thick stroke' },
  ];

  const BLOCK = 12;         // mosaic block, natural px
  const BLUR_R = 10;        // blur radius, same units
  const JPEG_Q = 0.85;
  const HIT_CSS = 8;        // select-tool grab tolerance, in CSS px (scaled to natural)
  // Read here, at load, so a host that forgot annot-history.js throws now, not on the first undo.
  const HISTORY_MAX = AnnotHistory.HISTORY_MAX;
  const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const HL_ALPHA = 0.35;
  const HL_WIDTH = AnnotGeometry.HL_WIDTH;
  const MIN_CROP = 16;      // natural px; a shorter crop drag is a mis-click
  const FLASH_MS = 2400;
  // Badge radius is a fraction of the image width, so it reads the same at any resolution.
  const NUM_DIV = 110;
  const NUM_MIN = 9;
  const HANDLE_CSS = 9;      // CSS px (scaled to natural)
  const HANDLE_HIT_CSS = 12;
  // Freehand only: a glyph cursor would cover the corner a geometric drag starts on.
  // Drawn here rather than lifted from the toolbar glyphs: a cursor wants a slim
  // silhouette and a nib that sits exactly on the pixel the ink lands on. The art is
  // a 32x32 box, nib down-left; `tip` is the hotspot in that same box.
  const CURSOR_ART = {
    // A fineliner: tapered nib, straight barrel, domed cap.
    pen: {
      tip: [4, 28],
      path: 'M4 28 7.18 20.58 7.68 18.24 18.64 7.28A4.3 4.3 0 0 1 24.72 13.36L13.76 24.32 11.42 24.82Z',
    },
    // A marker: slanted chisel edge, a collar of daylight, then a fatter barrel.
    highlight: {
      tip: [5, 27.2],
      path: 'M1.62 25.98 5.21 19.63 12.57 26.99 8.38 28.42Z'
          + 'M7.33 17.51 17.58 7.26A5.2 5.2 0 0 1 24.94 14.62L14.69 24.87Z',
    },
  };
  const CURSOR_PX = 28;      // the OS still draws a cursor image this size at 1:1

  // `id` is also the op's `tool`: 'pixelate' keeps that id (stored ops and the e2e
  // hooks name it) while the UI calls it Blur.
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
  const INKED = new Set(['pen', 'arrow', 'line', 'rect', 'ellipse', 'highlight', 'text', 'number']);
  const FREEHAND = new Set(['pen', 'highlight']);

  function create(opts) {
    const doc = opts.doc || (opts.mount && opts.mount.ownerDocument) || document;
    const mount = opts.mount;
    const onApply = opts.onApply || (() => {});
    const onCancel = opts.onCancel || (() => {});
    const confirmDiscard = opts.confirmDiscard || (() => true);
    // Called with `hasBlur`: the core decides when to ask, the consumer owns the wording.
    const confirmKeep = opts.confirmKeep || (() => true);

    let canvas = null;
    let ctx = null;
    let img = null;           // the base image (dropped after Apply)
    let W = 0;                // canvas size == the CROP size, not the image's
    let H = 0;
    let crop = null;          // {x, y, w, h} in ORIGINAL image coords
    const ops = [];           // vector list, in canvas (cropped) coords
    let selected = null;      // index into ops
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
    let inkBtn = null;
    let inkMenu = null;
    let onKeyDown = null;

    const opColor = (op) => op.color || STROKE;
    const opWidth = (op) => op.width || WIDTH;

    // ---- rendering --------------------------------------------------------
    function render(previewOp) {
      ctx.clearRect(0, 0, W, H);
      // A source rect on the untouched base image — cropping never rewrites pixels.
      if (img && crop) ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      const preview = previewOp && previewOp.tool !== 'crop' ? previewOp : null;
      const list = preview ? ops.concat([preview]) : ops;
      // A label being retyped is drawn by its input, not here (else two of it).
      const editing = textInput && textInput.edit;
      for (const op of list) if (op !== editing) drawOp(op);
      if (previewOp && previewOp.tool === 'crop') drawCropPreview(previewOp);
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

    // Size scales with the image and the weight, and is frozen at commit — a later
    // weight change cannot reflow an existing label.
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

    // `r` is frozen at drop time, like the text size.
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
      // A white disc needs an edge to exist on a light screenshot; the numeral flips too.
      ctx.lineWidth = Math.max(1, r / 8);
      ctx.strokeStyle = ink === '#ffffff' ? '#171717' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = ink === '#ffffff' ? '#171717' : '#ffffff';
      // The numeral steps down instead of growing the badge — a run of steps stays one size.
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

    function strokeEllipse(op) {
      const e = AnnotGeometry.ellipseOf(op);
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

    // The marker multiplies into the picture, so the pixels under it stay readable.
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

    function strokeArrow(op) {
      const curved = AnnotGeometry.curved(op);
      const head = AnnotGeometry.headLen(op);
      const tri = AnnotGeometry.arrowHead(op);
      // Shaft stops short of the tip so the solid head is not double-drawn.
      const fromX = curved ? op.cx : op.x1;
      const fromY = curved ? op.cy : op.y1;
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
      if (curved) ctx.quadraticCurveTo(op.cx, op.cy, bx, by);
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

    // Mosaic FIRST and destructively: a gaussian alone is a reversible convolution, so
    // privacy cannot rest on it. Runs in render(), so the preview IS what toDataURL gives.
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

    // `ctx.filter` is canvas-2d (Chrome 123+); without it the mosaic alone still hides
    // the data. The padded source keeps a transparent outside from bleeding a rim in.
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

    // UI only — the scrim never reaches the export.
    function drawCropPreview(op) {
      const b = AnnotGeometry.rectOf(op);
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
    // The canvas is natural-resolution but CSS-scaled, so tolerances convert CSS px ->
    // natural px: the grab zone feels the same whatever the capture resolution.
    function natPerCss() {
      if (!canvas) return 1;
      const r = canvas.getBoundingClientRect();
      return (r.width && canvas.width / r.width) || 1;
    }
    function hitPad() { return HIT_CSS * natPerCss(); }
    // A label's width is the one measurement AnnotGeometry cannot take for itself.
    const measure = (text, size) => {
      ctx.save();
      ctx.font = `bold ${size}px ${TEXT_FONT}`;
      const w = ctx.measureText(text).width;
      ctx.restore();
      return w;
    };
    // The rest of what a box or a grab needs off THIS canvas: the sizes a label and a badge fall
    // back to when the op carries none, and the grab tolerance in natural px.
    const geoEnv = () => ({ measure, textSize: textSize(), numberRadius: numberRadius(), pad: hitPad() });

    // ---- selection handles -------------------------------------------------
    function handleAt(op, x, y) {
      const tol = HANDLE_HIT_CSS * natPerCss();
      for (const h of AnnotGeometry.handlesOf(op)) if (Math.hypot(x - h.x, y - h.y) <= tol) return h;
      return null;
    }

    // White underlay + dark dash so the marquee reads on any screenshot; never exported.
    function drawSelection() {
      const op = ops[selected];
      if (!op) return;
      const s = natPerCss();
      const b = AnnotGeometry.opBox(op, geoEnv());
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
      const g = HANDLE_CSS * s;
      ctx.lineWidth = 1.5 * s;
      for (const hd of AnnotGeometry.handlesOf(op)) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.strokeStyle = '#171717';
        ctx.beginPath();
        // Round for the bend, square for a size grip — one look has to tell them apart.
        if (hd.id === 'bend') ctx.arc(hd.x, hd.y, g / 2, 0, Math.PI * 2);
        else ctx.rect(hd.x - g / 2, hd.y - g / 2, g, g);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- history ----------------------------------------------------------
    // The stack itself is AnnotHistory's; what stays here is the editor state it cannot see —
    // the live ops array it splices, the crop in force, and the selection a restore drops.
    const copyOps = () => AnnotHistory.copyOps(ops);
    const hist = AnnotHistory.makeHistory({
      ops,
      getCrop: () => crop,
      restoreCrop: (next) => { selected = null; resizeToCrop(next); },
      onChange: () => syncHistoryBtns(),
      max: HISTORY_MAX,
    });
    const snapshot = () => hist.snapshot();
    const pushHistory = (snap) => hist.push(snap);
    function syncHistoryBtns() {
      if (undoBtn) undoBtn.disabled = !hist.canUndo();
      if (redoBtn) redoBtn.disabled = !hist.canRedo();
      if (deleteBtn) deleteBtn.disabled = selected == null;
    }

    // ---- crop -------------------------------------------------------------
    // `crop` is a window on the ORIGINAL image. Two ways in: resize to a crop the ops
    // are ALREADY in (boot, undo/redo), or move the window and drag the ops with it.
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
        if (dx || dy) for (const op of ops) AnnotGeometry.translateOp(op, dx, dy);
      }
      resizeToCrop(next);
    }
    // Canvas coords: composes with the crop in force and is clamped to it.
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
    let moveDrag = null;
    let sizeDrag = null;
    function toNatural(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    }
    const inkFor = (t) => (INKED.has(t) ? { color, width: weight } : {});

    function onDown(e) {
      if (tool === 'select') { onSelectDown(e); return; }
      // preventDefault: the click's default action would move focus off the just-
      // opened input, whose empty-blur handler would instantly cancel it.
      if (tool === 'text') { e.preventDefault(); openTextInput(e); return; }
      if (tool === 'number') { e.preventDefault(); dropNumber(e); return; }
      canvas.setPointerCapture?.(e.pointerId);
      const p = toNatural(e);
      if (FREEHAND.has(tool)) { drag = { pts: [{ x: p.x, y: p.y }] }; return; }
      drag = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }

    // The two clicks under it armed a move that never moved; dropping it here starts
    // the retype clean.
    function onDblClick(e) {
      if (tool !== 'select') return;
      const p = toNatural(e);
      const i = AnnotGeometry.hitTest(ops, p.x, p.y, geoEnv());
      if (i == null || ops[i].tool !== 'text') return;
      e.preventDefault();
      moveDrag = null;
      editText(i);
    }

    // The pre-drag snapshot is taken here but committed only on a real move (onUp):
    // a plain selecting click must not add an undo step.
    function onSelectDown(e) {
      const p = toNatural(e);
      // A grip belongs to the CURRENT selection and beats everything under it.
      const held = selected != null ? handleAt(ops[selected], p.x, p.y) : null;
      if (held) {
        canvas.setPointerCapture?.(e.pointerId);
        sizeDrag = { id: held.id, before: snapshot(), moved: false };
        return;
      }
      const i = AnnotGeometry.hitTest(ops, p.x, p.y, geoEnv());
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
    // The counter is DERIVED, never stored — a stored one would drift on undo.
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
    // The input is placed in CSS coords but commits in NATURAL ones. `edit` is the op
    // it stands in for; while it does, render() skips that op (there would be two).
    let textInput = null;

    // Placed at NATURAL coords, sized natural × the CSS scale so it matches the label.
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
      // A retype always commits — emptying an existing label is a real edit (below).
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
        // Retyped to nothing == deleted, and as undoable.
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
        AnnotGeometry.moveHandle(ops[selected], sizeDrag.id, p.x, p.y);
        render();
        return;
      }
      if (moveDrag) {
        const p = toNatural(e);
        const dx = p.x - moveDrag.x;
        const dy = p.y - moveDrag.y;
        moveDrag.x = p.x; moveDrag.y = p.y;
        if (dx || dy) { moveDrag.moved = true; AnnotGeometry.translateOp(ops[selected], dx, dy); render(); }
        return;
      }
      if (tool === 'select') {
        const p = toNatural(e);
        const held = selected != null ? handleAt(ops[selected], p.x, p.y) : null;
        canvas.style.cursor = held ? AnnotGeometry.handleCursor(ops[selected], held) : '';
        canvas.classList.toggle('over', !held && AnnotGeometry.hitTest(ops, p.x, p.y, geoEnv()) != null);
        return;
      }
      if (!drag) return;
      const p = toNatural(e);
      if (drag.pts) {
        // Thin the path: a pointer emits far more samples than the curve needs.
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
        // One drag == one undo step, and only if the op actually moved.
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
      selected = null;   // a selection never survives a tool switch
      moveDrag = null;
      sizeDrag = null;
      removeTextInput();
      closeInkMenu();
      for (const spec of TOOLS) {
        const b = toolBtns[spec.id];
        if (!b) continue;
        // `selected` is the shared chosen-control class (components.css).
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
    // The pen and the marker wear their own art (CURSOR_ART), inked in the chosen colour.
    function cursorFor(t) {
      const art = CURSOR_ART[t];
      if (!art) return '';
      // A halo in the opposite ink, so the glyph survives a white dialog and a dark shot.
      const halo = color === '#ffffff' ? '#171717' : '#ffffff';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_PX}" height="${CURSOR_PX}" viewBox="0 0 32 32">`
        + `<path d="${art.path}" fill="${color}" stroke="${halo}" stroke-width="2.2"`
        + ' stroke-linejoin="round" stroke-linecap="round" paint-order="stroke"/></svg>';
      // The nib is where the ink lands, so the hotspot rides it.
      const k = CURSOR_PX / 32;
      const hx = Math.round(art.tip[0] * k);
      const hy = Math.round(art.tip[1] * k);
      return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hx} ${hy}, crosshair`;
    }
    function paintCursor() {
      if (!canvas) return;
      canvas.style.cursor = cursorFor(tool);   // '' hands it back to the CSS classes
    }

    // Picking a colour or a weight while something is selected RESTYLES it.
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
      paintCursor();
      if (textInput) textInput.input.style.color = color;
      restyleSelected();
    }
    function setWeight(idOrPx) {
      const found = WEIGHTS.find((s) => s.id === idOrPx || s.w === idOrPx);
      weight = found ? found.w : weight;
      paintInkBtns();
      restyleSelected();
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
    // The marquee lives on the canvas — it must be off it while pixels are read back.
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

    // PNG: the only image type the clipboard reliably takes, and it can still be refused.
    // The marquee comes off by hand, not via withCleanCanvas — toBlob is async.
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

    // A real anchor click: the browser owns the save dialog, the image never leaves.
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

    // Drops the un-blurred original from memory before reporting back (privacy).
    async function applyResult() {
      if (done) return;
      done = true;
      // The marquee comes off inside exportJpeg — clearing it here would leave nothing to hide.
      const resultDataUrl = exportJpeg();
      dropImg();
      await onApply(resultDataUrl);
    }

    // Hands the ORIGINAL shot back through the SAME onApply as Apply — deliberate: the
    // consumer stages the raw shot instead of dropping it. requestKeep and the hook route here.
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

    // Confirm only when work was actually done — a crop counts (there is something to undo).
    function requestDiscard() {
      if ((ops.length || hist.canUndo()) && !confirmDiscard()) return;
      discardResult();
    }

    // Keeping the original is a loss too: it un-hides every blur, so it asks on the same trigger.
    function requestKeep() {
      if ((ops.length || hist.canUndo()) && !confirmKeep(ops.some((o) => o.tool === 'pixelate'))) return;
      keepResult();
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
    // icons.js must load before this file in both hosts; Tooltip can be missing after
    // an injection, so the browser's `title` is the fallback.
    function tip(el, text) {
      if (!text) return;
      if (typeof Tooltip !== 'undefined') Tooltip.set(el, text);
      else el.title = text;
    }

    function mkBtn(id, label, title, cls, icon) {
      const b = doc.createElement('button');
      b.id = id;
      // `btn` is the shared control (shared/components.css); the overlay's shadow root
      // is handed that stylesheet at injection. `annot-btn` is this file's layout hook.
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

    // Icon-only: eleven labelled buttons would be a second toolbar.
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

    // Hand-built popover, not shared/dropdown.js: this file is injected on its own and
    // has no dependency to call. `--swatch` stays inline — it is ink data, not a theme.
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
        // Focus goes back to the control that opened the menu, never to nothing.
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
        ['⌘/Ctrl ⏎', 'Save'],
        ['Esc', 'Discard'],
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
      // `bar` is the shared page-chrome row on the editor page; in the overlay's shadow
      // root, which that stylesheet cannot reach, `annot-bar` carries the shape.
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
      const discardBtn = mkBtn('annot-discard', 'Discard', 'Discard the screenshot — attach nothing (Esc)', 'danger');
      const keepBtn = mkBtn('annot-keep', 'Keep original', 'Close and keep the raw screenshot — the annotations AND the crop are dropped');
      const applyBtn = mkBtn('annot-apply', 'Save', 'Flatten and return the annotated image (⌘/Ctrl ⏎)', 'primary');

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

      undoBtn.addEventListener('click', hist.undo);
      redoBtn.addEventListener('click', hist.redo);
      deleteBtn.addEventListener('click', deleteSelected);
      copyBtn.addEventListener('click', copyImage);
      saveBtn.addEventListener('click', downloadImage);
      helpBtn.addEventListener('click', () => toggleHelp());
      discardBtn.addEventListener('click', requestDiscard);
      keepBtn.addEventListener('click', requestKeep);
      applyBtn.addEventListener('click', applyResult);

      // On `wrap` and in the capture phase: a document-level listener sees the shadow
      // HOST as the target and could not tell inside from outside.
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
    // Nothing here fires while the text input owns the keyboard (its keydown stops it).
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (inkMenu && !inkMenu.hidden) { e.preventDefault(); e.stopPropagation(); closeInkMenu(true); return; }
        if (!helpBox.hidden) { e.preventDefault(); e.stopPropagation(); toggleHelp(false); return; }
        if (selected != null) { e.preventDefault(); e.stopPropagation(); selected = null; syncHistoryBtns(); render(); return; }
        e.preventDefault();
        // The reflex key must never attach an un-redacted shot, so it discards (asking first).
        requestDiscard();
        return;
      }
      if (mod && (e.key === 'Enter' || e.key === 'NumpadEnter')) { e.preventDefault(); applyResult(); return; }
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); (e.shiftKey ? hist.redo : hist.undo)(); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); hist.redo(); return; }
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
    // Natural canvas coords, same ops list + render as a pointer gesture; `pixelAt`
    // reads the live canvas (pre-JPEG), so the block invariant is lossless.
    const hooks = {
      ready: false,
      natural: () => ({ w: W, h: H }),
      ops: () => copyOps(),
      tool: () => tool,
      setTool,
      // setColor takes a palette id or a hex; setWidth an id ('s'|'m'|'l') or the px weight.
      palette: () => PALETTE.map((c) => ({ ...c })),
      color: () => color,
      width: () => weight,
      setColor,
      setWidth: setWeight,
      badgeRadius: () => numberRadius(),
      add: (op) => {
        const t = op.tool || tool;
        pushHistory();
        const ink = INKED.has(t) ? { color: op.color || color, width: op.width || weight } : {};
        if (t === 'text') ops.push({ tool: 'text', x: op.x, y: op.y, text: op.text, size: op.size, ...ink });
        else if (t === 'number') ops.push({ tool: 'number', x: op.x, y: op.y, n: op.n || nextNumber(), r: op.r || numberRadius(), ...ink });
        else if (op.pts) ops.push({ tool: t, pts: op.pts.map((p) => ({ ...p })), ...ink });
        // `cx, cy` rides along when given — a bent arrow is the same op with a control point.
        else {
          const bend = op.cx != null && op.cy != null ? { cx: op.cx, cy: op.cy } : {};
          ops.push({ tool: t, x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2, ...bend, ...ink });
        }
        render();
      },
      undo: hist.undo,
      redo: hist.redo,
      // Returns the index, or null for empty space (a deselecting click).
      select: (x, y) => {
        selected = AnnotGeometry.hitTest(ops, x, y, geoEnv());
        if (selected != null) syncInkToSelection();
        syncHistoryBtns();
        render();
        return selected;
      },
      selected: () => selected,
      // Select + double-click, without a mouse: reopen the label at (x, y).
      editTextAt: (x, y) => {
        const i = AnnotGeometry.hitTest(ops, x, y, geoEnv());
        return i != null && ops[i].tool === 'text' ? editText(i) : false;
      },
      moveSelected: (dx, dy) => {
        if (selected == null) return false;
        pushHistory();
        AnnotGeometry.translateOp(ops[selected], dx, dy);
        render();
        return true;
      },
      handles: () => (selected == null ? [] : AnnotGeometry.handlesOf(ops[selected]).map((h) => ({ ...h }))),
      dragHandle: (id, x, y) => {
        if (selected == null) return false;
        const has = AnnotGeometry.handlesOf(ops[selected]).some((h) => h.id === id);
        if (!has) return false;
        pushHistory();
        AnnotGeometry.moveHandle(ops[selected], id, x, y);
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
      keep: () => keepResult(),
      discard: () => discardResult(),
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
      resizeToCrop({ x: 0, y: 0, w: iw, h: ih });
      hooks.ready = true;
      if (opts.onReady) opts.onReady(hooks);
    };
    img.onerror = () => fail('Could not load the captured image.');
    img.src = opts.dataUrl;

    return { hooks, destroy };
  }

  return { create, PALETTE, WEIGHTS, TOOLS };
})();
