// Annotator core (shared) — the DOM-agnostic tool/canvas engine behind both the
// editor-page annotator (editor/annotate.js) and the on-page overlay
// (overlay/annotate-overlay.js). It renders its toolbar + a viewport-fitted
// canvas into a MOUNT element it is given, handles all drawing (arrow/box/
// pixelate/text/undo), and reports Apply/Cancel via callbacks — it does NOT know
// about chrome.storage, tabs, or shadow roots. The consumer owns the handoff.
//
// Tools: fixed stroke #dc2626 3px, real pixel-destroying mosaic (block-aligned
// so live preview == JPEG export), text label sized max(16, W/50), a Select tool
// (click to hit-test, drag to move, Delete to remove — issue #68), undo, JPEG
// quality 0.85. The un-blurred original is dropped from memory on Apply
// (privacy). Undo is a bounded snapshot stack, so a move/delete is undoable too;
// the selection marquee is UI only and never reaches the export.
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

  const STROKE = '#dc2626';
  const WIDTH = 3;
  const BLOCK = 12;         // pixelate mosaic block ≈ 12px at natural scale
  const JPEG_Q = 0.85;
  const HIT_CSS = 8;        // select-tool grab tolerance, in CSS px (scaled to natural)
  const HISTORY_MAX = 50;   // bounded undo snapshot stack
  const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function create(opts) {
    const doc = opts.doc || (opts.mount && opts.mount.ownerDocument) || document;
    const mount = opts.mount;
    const onApply = opts.onApply || (() => {});
    const onCancel = opts.onCancel || (() => {});
    const confirmDiscard = opts.confirmDiscard || (() => true);

    let canvas = null;
    let ctx = null;
    let img = null;           // the base image (dropped after Apply)
    let W = 0;
    let H = 0;
    const ops = [];           // vector list {tool, x1, y1, x2, y2}
    const history = [];       // undo: deep copies of ops[] before each mutation
    let selected = null;      // index into ops while the Select tool holds one
    let tool = 'arrow';
    let done = false;         // guards double Apply/Cancel
    let stage = null;
    let wrap = null;
    const toolBtns = {};
    let onKeyDown = null;

    // ---- rendering --------------------------------------------------------
    function render(previewOp) {
      ctx.clearRect(0, 0, W, H);
      if (img) ctx.drawImage(img, 0, 0, W, H);
      const list = previewOp ? ops.concat([previewOp]) : ops;
      for (const op of list) drawOp(op);
      if (selected != null) drawSelection();   // marquee last, above every op
    }

    function drawOp(op) {
      if (op.tool === 'pixelate') pixelate(op);
      else if (op.tool === 'rect') strokeRect(op);
      else if (op.tool === 'arrow') strokeArrow(op);
      else if (op.tool === 'text') drawText(op);
    }

    // Text label: bold #dc2626, size scales with the image so it reads the same
    // at any resolution. Op is {tool:'text', x, y, text} in natural coords.
    function textSize() { return Math.max(16, Math.round(W / 50)); }
    function drawText(op) {
      if (!op.text) return;
      ctx.save();
      ctx.fillStyle = STROKE;
      ctx.font = `bold ${textSize()}px ${TEXT_FONT}`;
      ctx.textBaseline = 'top';
      ctx.fillText(op.text, op.x, op.y);
      ctx.restore();
    }

    function strokeRect(op) {
      const x = Math.min(op.x1, op.x2);
      const y = Math.min(op.y1, op.y2);
      ctx.save();
      ctx.strokeStyle = STROKE;
      ctx.lineWidth = WIDTH;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(x, y, Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
      ctx.restore();
    }

    // The arrowhead triangle in natural coords — one source of truth for both
    // the fill below and the select tool's hit test.
    const HEAD = Math.max(10, WIDTH * 4);     // arrowhead length in natural px
    function arrowHead(op) {
      const ang = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
      return [
        [op.x2, op.y2],
        [op.x2 - HEAD * Math.cos(ang - Math.PI / 6), op.y2 - HEAD * Math.sin(ang - Math.PI / 6)],
        [op.x2 - HEAD * Math.cos(ang + Math.PI / 6), op.y2 - HEAD * Math.sin(ang + Math.PI / 6)],
      ];
    }

    function strokeArrow(op) {
      const { x1, y1, x2, y2 } = op;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      // Shaft stops short of the tip so the solid head is not double-drawn.
      const bx = x2 - (HEAD * 0.9) * (dx / len);
      const by = y2 - (HEAD * 0.9) * (dy / len);
      const tri = arrowHead(op);
      ctx.save();
      ctx.strokeStyle = STROKE;
      ctx.fillStyle = STROKE;
      ctx.lineWidth = WIDTH;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tri[0][0], tri[0][1]);
      ctx.lineTo(tri[1][0], tri[1][1]);
      ctx.lineTo(tri[2][0], tri[2][1]);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Real pixel destruction: read the region as it stands (base + prior ops),
    // replace each mosaic block with its uniform average, write back. Blocks are
    // aligned to the region origin, so every full block is a single flat colour —
    // this is exactly what toDataURL then encodes (live preview == export).
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
      const size = textSize();
      ctx.save();
      ctx.font = `bold ${size}px ${TEXT_FONT}`;
      const w = ctx.measureText(op.text || '').width;
      ctx.restore();
      return { x1: op.x, y1: op.y, x2: op.x + w, y2: op.y + size * 1.25 };
    }
    // Axis-aligned bbox of any op, natural coords, no padding.
    function opBox(op) {
      if (op.tool === 'text') return textBox(op);
      return {
        x1: Math.min(op.x1, op.x2), y1: Math.min(op.y1, op.y2),
        x2: Math.max(op.x1, op.x2), y2: Math.max(op.y1, op.y2),
      };
    }
    const inBox = (x, y, b, pad) => x >= b.x1 - pad && x <= b.x2 + pad && y >= b.y1 - pad && y <= b.y2 + pad;

    function hitsOp(op, x, y) {
      if (op.tool === 'arrow') {
        return distToSeg(x, y, op.x1, op.y1, op.x2, op.y2) <= hitPad() + WIDTH / 2
          || inTriangle(x, y, arrowHead(op));
      }
      if (op.tool === 'rect') return inBox(x, y, opBox(op), hitPad());  // inside OR near an edge
      if (op.tool === 'pixelate') return inBox(x, y, opBox(op), 0);     // inside the region
      if (op.tool === 'text') return inBox(x, y, textBox(op), 0);
      return false;
    }
    // Topmost first: the last op drawn sits on top, so it wins the click.
    function hitTest(x, y) {
      for (let i = ops.length - 1; i >= 0; i--) if (hitsOp(ops[i], x, y)) return i;
      return null;
    }
    function translateOp(op, dx, dy) {
      if (op.tool === 'text') { op.x += dx; op.y += dy; return; }
      op.x1 += dx; op.y1 += dy; op.x2 += dx; op.y2 += dy;
    }

    // Selection marquee: white underlay + dark dash so it reads on any
    // screenshot. Drawn after every op and never exported (see exportJpeg).
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
      ctx.restore();
    }

    // ---- history ----------------------------------------------------------
    // Undo is a bounded stack of deep copies pushed BEFORE every mutating
    // action (add, move-commit, delete): ops.pop() could only ever undo an add.
    const snapshot = () => ops.map((o) => ({ ...o }));
    function pushHistory(snap) {
      history.push(snap || snapshot());
      if (history.length > HISTORY_MAX) history.shift();
    }

    // ---- pointer drawing --------------------------------------------------
    let drag = null;
    let moveDrag = null;      // { x, y, before, moved } while dragging the selection
    function toNatural(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    }
    function onDown(e) {
      if (tool === 'undo') return;
      if (tool === 'select') { onSelectDown(e); return; }
      // preventDefault: the click's default action would move focus off the just-
      // opened input, whose empty-blur handler would instantly cancel it.
      if (tool === 'text') { e.preventDefault(); openTextInput(e); return; } // a click, not a drag
      canvas.setPointerCapture?.(e.pointerId);
      const p = toNatural(e);
      drag = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }

    // Select tool: a hit selects (and arms a move), empty space deselects. The
    // pre-move snapshot is taken here but only committed on a real move (onUp).
    function onSelectDown(e) {
      const p = toNatural(e);
      const i = hitTest(p.x, p.y);
      selected = i;
      if (i != null) {
        canvas.setPointerCapture?.(e.pointerId);
        moveDrag = { x: p.x, y: p.y, before: snapshot(), moved: false };
      }
      render();
    }

    // ---- text tool --------------------------------------------------------
    // A click opens a positioned inline <input> over the click point (CSS coords);
    // Enter (or a non-empty blur) commits {tool:'text', x, y, text} in NATURAL
    // coords, Esc (or an empty blur) cancels. Only one input is open at a time.
    let textInput = null;     // { input, x, y } while editing
    function openTextInput(e) {
      removeTextInput();
      const p = toNatural(e);
      const rect = canvas.getBoundingClientRect();
      const input = doc.createElement('input');
      input.type = 'text';
      input.className = 'annot-text-input';
      input.style.left = `${e.clientX}px`;
      input.style.top = `${e.clientY}px`;
      // Match the on-screen size of the committed label (natural size × CSS scale).
      const cssSize = Math.max(11, textSize() * (rect.width / (canvas.width || 1)));
      input.style.font = `bold ${cssSize}px ${TEXT_FONT}`;
      input.style.color = STROKE;
      // Live inside the mount (not document.body) so the overlay's shadow root
      // styles it and page CSS cannot leak in; position:fixed keeps viewport coords.
      wrap.append(input);
      textInput = { input, x: p.x, y: p.y };
      input.addEventListener('keydown', onTextKey);
      input.addEventListener('blur', onTextBlur);
      // Deferred focus: survive any focus juggling the opening click still does.
      requestAnimationFrame(() => { if (textInput && textInput.input === input) input.focus(); });
    }
    function onTextKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelText(); }
    }
    function onTextBlur() {
      if (!textInput) return;
      if (textInput.input.value.trim()) commitText(); else cancelText();
    }
    function commitText() {
      if (!textInput) return;
      const { x, y, input } = textInput;
      const text = input.value;
      removeTextInput();
      if (text && text.trim()) { pushHistory(); ops.push({ tool: 'text', x, y, text }); render(); }
    }
    function cancelText() { removeTextInput(); }
    function removeTextInput() {
      if (!textInput) return;
      const { input } = textInput;
      input.removeEventListener('keydown', onTextKey);
      input.removeEventListener('blur', onTextBlur);
      input.remove();
      textInput = null;
    }
    function onMove(e) {
      if (moveDrag) {
        const p = toNatural(e);
        const dx = p.x - moveDrag.x;
        const dy = p.y - moveDrag.y;
        moveDrag.x = p.x; moveDrag.y = p.y;
        if (dx || dy) { moveDrag.moved = true; translateOp(ops[selected], dx, dy); render(); }
        return;
      }
      if (tool === 'select') {  // hover affordance: 'move' cursor over a hit
        const p = toNatural(e);
        canvas.classList.toggle('over', hitTest(p.x, p.y) != null);
        return;
      }
      if (!drag) return;
      const p = toNatural(e);
      drag.x2 = p.x; drag.y2 = p.y;
      render({ tool, ...drag });
    }
    function onUp() {
      if (moveDrag) {
        // One drag == one undo step: the snapshot lands on release, and only if
        // the op actually moved (a plain selecting click must not add a step).
        if (moveDrag.moved) pushHistory(moveDrag.before);
        moveDrag = null;
        render();
        return;
      }
      if (!drag) return;
      const op = { tool, x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 };
      drag = null;
      // Ignore a zero-length click (no real gesture).
      if (Math.hypot(op.x2 - op.x1, op.y2 - op.y1) >= 2) { pushHistory(); ops.push(op); }
      render();
    }

    // ---- tools / actions --------------------------------------------------
    function setTool(t) {
      tool = t;
      selected = null;   // a selection never survives a tool switch (Backspace vs the text input)
      moveDrag = null;
      for (const id of ['arrow', 'rect', 'pixelate', 'text', 'select']) {
        const b = toolBtns[id];
        if (b) b.classList.toggle('active', id === t);
      }
      if (canvas) {
        canvas.classList.toggle('pick', t === 'select');  // cursor: default (vs crosshair)
        canvas.classList.remove('over');
      }
      if (ctx && W) render();
    }

    function undo() {
      if (!history.length) return;
      ops.splice(0, ops.length, ...history.pop());
      selected = null;
      render();
    }

    function deleteSelected() {
      if (selected == null || !ops[selected]) return false;
      pushHistory();
      ops.splice(selected, 1);
      selected = null;
      render();
      return true;
    }

    // The marquee lives on the canvas, so it must be off it while the pixels are
    // read back: re-render clean, encode, restore the selection.
    function exportJpeg() {
      const sel = selected;
      if (sel != null) { selected = null; render(); }
      const url = canvas.toDataURL('image/jpeg', JPEG_Q);
      if (sel != null) { selected = sel; render(); }
      return url;
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

    // Keep original: hand back the ORIGINAL un-annotated image (annotations are
    // dropped, the shot is kept). Same callback as Apply — the consumer treats a
    // returned dataURL identically (owner-approved: keep stages/uploads the raw
    // shot). Esc + overlay/tab close route here.
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

    // Discard button: confirm only when annotations were actually drawn.
    function requestDiscard() {
      if (ops.length && !confirmDiscard()) return;
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

    function buildChrome() {
      mount.replaceChildren();
      wrap = doc.createElement('div');
      wrap.className = 'annot';

      const bar = doc.createElement('header');
      // `bar` is the shared page-chrome row on the editor page; in the overlay's
      // shadow root, which that stylesheet cannot reach, `annot-bar` carries the
      // whole shape instead.
      bar.className = 'bar sticky annot-bar';
      // `icon` is a Material Symbols name from shared/icons.js — injected into the
      // page alongside this file, and loaded before it on the editor page. The
      // tool buttons used to lead with a unicode glyph; the label text is unchanged.
      const mkBtn = (id, label, title, cls, icon) => {
        const b = doc.createElement('button');
        b.id = id;
        // `btn` is the shared control (shared/components.css) on the editor PAGE;
        // in the in-page overlay, which lives in a shadow root that stylesheet
        // cannot reach, `annot-btn` carries the whole skin instead. One markup,
        // both hosts.
        b.className = `btn annot-btn${cls ? ` ${cls}` : ''}`;
        b.type = 'button';
        const mark = icon && Icons.elIn(doc, icon, 16);
        if (mark) b.append(mark);
        const span = doc.createElement('span');
        span.textContent = label;
        b.append(span);
        // The tip is the one thing this toolbar cannot draw the same way in both
        // hosts. On the editor PAGE the extension's own tooltip is loaded, so it
        // gets `data-tip`; in the in-page overlay this file is injected alone,
        // into a shadow root the engine's hit-testing cannot see through, and
        // the browser's `title` is the only label left that works there.
        if (title) {
          if (typeof Tooltip !== 'undefined') Tooltip.set(b, title);
          else b.title = title;
        }
        return b;
      };
      const arrow = mkBtn('annot-arrow', 'Arrow', 'Arrow', '', 'north_east');
      const rect = mkBtn('annot-rect', 'Box', 'Box', '', 'crop_square');
      const pix = mkBtn('annot-pixelate', 'Pixelate', 'Pixelate (hide sensitive area)', '', 'blur_on');
      const text = mkBtn('annot-text', 'Text', 'Text (click the image, type, Enter)', '', 'title');
      const select = mkBtn('annot-select', 'Select', 'Select an annotation: drag to move, Delete to remove', '', 'select_all');
      const undoBtn = mkBtn('annot-undo', 'Undo', 'Undo the last change (a move and a delete count too)', '', 'undo');
      const spacer = doc.createElement('div');
      spacer.className = 'annot-spacer';
      const discardBtn = mkBtn('annot-discard', 'Discard', 'Discard the screenshot — attach nothing', 'danger');
      const keepBtn = mkBtn('annot-keep', 'Keep original', 'Close and keep the original, un-annotated screenshot');
      const applyBtn = mkBtn('annot-apply', 'Apply', 'Flatten and return the annotated image', 'primary');
      bar.append(arrow, rect, pix, text, select, undoBtn, spacer, discardBtn, keepBtn, applyBtn);
      toolBtns.arrow = arrow; toolBtns.rect = rect; toolBtns.pixelate = pix;
      toolBtns.text = text; toolBtns.select = select;

      stage = doc.createElement('div');
      stage.id = 'annot-stage';
      stage.className = 'annot-stage';
      canvas = doc.createElement('canvas');
      canvas.id = 'annot-canvas';
      canvas.className = 'annot-canvas';
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      stage.append(canvas);

      wrap.append(bar, stage);
      mount.append(wrap);

      arrow.addEventListener('click', () => setTool('arrow'));
      rect.addEventListener('click', () => setTool('rect'));
      pix.addEventListener('click', () => setTool('pixelate'));
      text.addEventListener('click', () => setTool('text'));
      select.addEventListener('click', () => setTool('select'));
      undoBtn.addEventListener('click', undo);
      discardBtn.addEventListener('click', requestDiscard);
      keepBtn.addEventListener('click', keepResult);
      applyBtn.addEventListener('click', applyResult);

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      window.addEventListener('resize', fitCanvas);
      // Esc = Keep original (non-destructive: the shot is preserved, no confirm)
      // — unless something is selected, where it only drops the selection (and
      // stops there, so the host's Esc handling does not fire either).
      // Delete/Backspace removes the selection (never while the text input owns
      // the keyboard, which a tool switch already rules out).
      onKeyDown = (e) => {
        if (e.key === 'Escape') {
          if (selected != null) { e.preventDefault(); e.stopPropagation(); selected = null; render(); return; }
          e.preventDefault();
          keepResult();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null && !textInput) {
          e.preventDefault();
          deleteSelected();
        }
      };
      doc.addEventListener('keydown', onKeyDown);
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
      ops: () => ops.map((o) => ({ ...o })),
      setTool,
      add: (op) => {
        const t = op.tool || tool;
        pushHistory();
        if (t === 'text') ops.push({ tool: 'text', x: op.x, y: op.y, text: op.text });
        else ops.push({ tool: t, x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 });
        render();
      },
      undo,
      // Editing (#68) in the same natural coords: select hit-tests topmost-first
      // and returns the index (null = empty space, i.e. a deselecting click).
      select: (x, y) => { selected = hitTest(x, y); render(); return selected; },
      selected: () => selected,
      moveSelected: (dx, dy) => {
        if (selected == null) return false;
        pushHistory();
        translateOp(ops[selected], dx, dy);
        render();
        return true;
      },
      deleteSelected,
      pixelAt: (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data),
      exportDataUrl: () => exportJpeg(),
      apply: () => applyResult(),
      keep: () => keepResult(),        // hand back the original un-annotated shot
      discard: () => discardResult(),  // hand back nothing (drop the shot)
      cancel: () => discardResult(),   // back-compat alias: old cancel == discard
    };

    function destroy() {
      try { doc.removeEventListener('keydown', onKeyDown); } catch { /* noop */ }
      try { window.removeEventListener('resize', fitCanvas); } catch { /* noop */ }
      try { removeTextInput(); } catch { /* noop */ }
    }

    // ---- boot -------------------------------------------------------------
    buildChrome();
    setTool('arrow');
    img = new Image();
    img.onload = () => {
      W = img.naturalWidth || img.width;
      H = img.naturalHeight || img.height;
      canvas.width = W;
      canvas.height = H;
      fitCanvas();
      render();
      hooks.ready = true;
      if (opts.onReady) opts.onReady(hooks);
    };
    img.onerror = () => fail('Could not load the captured image.');
    img.src = opts.dataUrl;

    return { hooks, destroy };
  }

  return { create };
})();
