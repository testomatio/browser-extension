// The annotator's pure geometry (IIFE global `AnnotGeometry`): the boxes, curves, hit tests and
// grips the Select tool in shared/annotate-core.js is built on. Nothing here touches a canvas, a
// document or `chrome.*` — a value goes in and a value comes out. That is the point of the split:
// the maths a tester's click lands on is checkable without building a toolbar first.
//
// EVERYTHING IS NATURAL PIXELS. The canvas is natural-resolution but CSS-scaled; converting a CSS
// tolerance into natural px (`natPerCss`) stays with the caller, which hands the answer in as `pad`.
//
// THE ENV BAG. Three facts live on the caller's canvas and cannot be derived here, so `opBox`,
// `hitsOp` and `hitTest` take them as one object:
//   measure(text, size) — the width of that label drawn bold at that size (the caller's
//                         ctx.measureText; a canvas is the one thing this file may not reach for);
//   textSize            — the size a label carrying no `size` of its own is drawn at;
//   numberRadius        — the radius a badge carrying no `r` of its own is drawn at;
//   pad                 — the grab tolerance in natural px (hit tests only).
// A caller that forgets the bag gets a TypeError, not a quietly wrong box.

const AnnotGeometry = (() => {
  'use strict';

  const WIDTH = 3;          // the M weight; legacy ops with no width fall back to it
  const HL_WIDTH = 6;       // × the stroke weight

  const opWidth = (op) => op.width || WIDTH;

  function ellipseOf(op) {
    return {
      cx: (op.x1 + op.x2) / 2,
      cy: (op.y1 + op.y2) / 2,
      rx: Math.abs(op.x2 - op.x1) / 2,
      ry: Math.abs(op.y2 - op.y1) / 2,
    };
  }

  // `cx, cy`: quadratic control point, absent on straight arrows and on ops stored
  // before the bend handle existed.
  const curved = (op) => op.cx != null && op.cy != null;
  // The point at t=0.5 — the bend handle has to sit ON the drawn curve.
  function arrowMid(op) {
    if (!curved(op)) return { x: (op.x1 + op.x2) / 2, y: (op.y1 + op.y2) / 2 };
    return {
      x: 0.25 * op.x1 + 0.5 * op.cx + 0.25 * op.x2,
      y: 0.25 * op.y1 + 0.5 * op.cy + 0.25 * op.y2,
    };
  }
  // Inverse of arrowMid: the control point that puts the curve THROUGH (px, py), so
  // the handle drags the curve, not a point twice as far away.
  const arrowCtrl = (op, px, py) => ({
    cx: 2 * px - (op.x1 + op.x2) / 2,
    cy: 2 * py - (op.y1 + op.y2) / 2,
  });
  // Flattened shaft: one source of truth for the stroke, the hit test and the bbox.
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

  // Shared by the fill and the hit test. Points along the shaft's END tangent —
  // on a curve that is the direction out of the control point, not out of the tail.
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

  // ---- hit-testing (Select tool) -----------------------------------------
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

  // Height ≈ size × 1.25 down from (x, y): the label is drawn with textBaseline 'top'.
  function textBox(op, env) {
    const size = op.size || env.textSize;
    const w = env.measure(op.text || '', size);
    return { x1: op.x, y1: op.y, x2: op.x + w, y2: op.y + size * 1.25 };
  }
  // Axis-aligned bbox of any op, natural coords, no padding.
  function opBox(op, env) {
    if (op.tool === 'text') return textBox(op, env);
    if (op.tool === 'number') {
      const r = op.r || env.numberRadius;
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
    // A bent arrow leaves its end-to-end box, so the bbox comes off the curve as drawn.
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

  function hitsPath(op, x, y, env) {
    const pts = op.pts || [];
    const tol = env.pad + (opWidth(op) * (op.tool === 'highlight' ? HL_WIDTH : 1)) / 2;
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= tol;
    for (let i = 1; i < pts.length; i++) {
      if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return true;
    }
    return false;
  }

  function hitsOp(op, x, y, env) {
    if (op.tool === 'arrow') {
      const tol = env.pad + opWidth(op) / 2;
      const pts = arrowPath(op);   // two points when it is straight
      for (let i = 1; i < pts.length; i++) {
        if (distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= tol) return true;
      }
      return inTriangle(x, y, arrowHead(op));
    }
    if (op.tool === 'line') return distToSeg(x, y, op.x1, op.y1, op.x2, op.y2) <= env.pad + opWidth(op) / 2;
    if (op.tool === 'pen' || op.tool === 'highlight') return hitsPath(op, x, y, env);
    if (op.tool === 'rect' || op.tool === 'ellipse') return inBox(x, y, opBox(op, env), env.pad); // inside OR near an edge
    if (op.tool === 'pixelate') return inBox(x, y, opBox(op, env), 0);     // inside the region
    if (op.tool === 'text') return inBox(x, y, textBox(op, env), 0);
    if (op.tool === 'number') {
      const r = op.r || env.numberRadius;
      return Math.hypot(x - op.x, y - op.y) <= r + env.pad / 2;
    }
    return false;
  }
  // Topmost first: the last op drawn sits on top, so it wins the click.
  function hitTest(ops, x, y, env) {
    for (let i = ops.length - 1; i >= 0; i--) if (hitsOp(ops[i], x, y, env)) return i;
    return null;
  }
  function translateOp(op, dx, dy) {
    if (op.pts) { for (const p of op.pts) { p.x += dx; p.y += dy; } return; }
    if (op.tool === 'text' || op.tool === 'number') { op.x += dx; op.y += dy; return; }
    op.x1 += dx; op.y1 += dy; op.x2 += dx; op.y2 += dy;
    if (curved(op)) { op.cx += dx; op.cy += dy; }   // the bend travels with the arrow
  }

  // ---- selection handles ---------------------------------------------------
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
  // A corner grip writes the coordinate pair it is named for, so the opposite corner stays.
  function moveHandle(op, id, x, y) {
    if (id === 'bend') { Object.assign(op, arrowCtrl(op, x, y)); return; }
    if (id === 'a') { op.x1 = x; op.y1 = y; return; }
    if (id === 'b') { op.x2 = x; op.y2 = y; return; }
    if (id.includes('x1')) op.x1 = x; else op.x2 = x;
    if (id.includes('y1')) op.y1 = y; else op.y2 = y;
  }
  // Diagonals are read off the shape as it stands, so a box dragged right-to-left fits.
  function handleCursor(op, h) {
    if (h.id === 'bend') return 'crosshair';
    if (h.id === 'a' || h.id === 'b') return 'move';
    const flipped = (op.x2 - op.x1) * (op.y2 - op.y1) < 0;
    const main = h.id === 'x1y1' || h.id === 'x2y2';
    return (main !== flipped) ? 'nwse-resize' : 'nesw-resize';
  }

  // WIDTH and HL_WIDTH ride along so the drawing code reads the same two numbers the boxes and
  // the grab tolerances are built from — one definition, not two that can drift apart.
  return {
    WIDTH,
    HL_WIDTH,
    rectOf,
    distToSeg,
    inTriangle,
    ellipseOf,
    curved,
    arrowMid,
    arrowCtrl,
    arrowPath,
    headLen,
    arrowHead,
    opBox,
    inBox,
    hitsOp,
    hitTest,
    translateOp,
    handlesOf,
    moveHandle,
    handleCursor,
  };
})();
