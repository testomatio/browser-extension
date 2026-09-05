#!/usr/bin/env node
// The annotator engine a tester draws on after a screenshot: arrows, boxes, a marker, numbered
// badges, text labels, a blur that hides a token, a crop — and the three ways out (Save, Keep
// original, Discard). Everything a tester blurred has to be gone from whatever leaves this file,
// so the redaction and the export rows are the ones that matter most.
// Run: node --test tests/annotate-core.test.mjs

// THE CANVAS IS REAL PIXELS. The 2d context here keeps an actual Uint8ClampedArray, and the base
// capture is a function of its ORIGINAL coordinates, so no two pixels agree. That buys three
// things a no-op stub cannot: a block average is a real computation (the blur rows), `toDataURL`
// is a digest of what is actually on the canvas (so a baked-in marquee CHANGES the export), and a
// crop genuinely moves the picture under the ops.

// TRAPS, each already paid for:
// - `create()` builds the toolbar synchronously but `hooks.ready` waits for `img.onload`; the fake
//   Image fires it from the `src` setter, and ignores the `src = ''` that `dropImg()` writes.
// - `snapshot()` spreads a null `crop` into `{}`, so a pushHistory before ready poisons the stack.
// - `Icons.elIn` is UNGUARDED — without the stub `buildChrome()` throws before anything is assertable.
// - `hooks.apply/keep/discard` bypass confirmDiscard/confirmKeep, so the exit rows go through the
//   buttons and the keydown listener instead.
// - Values built inside the vm realm carry that realm's prototypes: compare them with plain().
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { makeDocument, fire } from './helpers/mini-dom.mjs';
import { sharedPath, sourceOf, plain, settle } from './helpers/shared-harness.mjs';

// The fake Image reads its size out of the URL, so a row states the capture it is annotating.
const IMG = (w, h) => `data:image/png;base64,IMG:${w}x${h}`;
const BROKEN = 'data:image/png;base64,BROKEN';

// The base capture: every pixel differs from its neighbours, in ORIGINAL image coords.
const basePixel = (x, y) => [(x * 3) & 255, (y * 5) & 255, (x * 7 + y * 13) & 255, 255];

const digest = (buf, w, h) => createHash('sha1')
  .update(`${w}x${h}:`)
  .update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
  .digest('base64');

// '#rrggbb' and 'rgba(...)' are the only two inks this file paints with.
function ink(v) {
  const s = String(v);
  if (/^#[0-9a-f]{6}$/i.test(s)) {
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const p = m[1].split(',').map(Number);
    return [p[0] | 0, p[1] | 0, p[2] | 0, Math.round((p[3] === undefined ? 1 : p[3]) * 255)];
  }
  return [0, 0, 0, 255];
}

const NOOP = () => {};

// A style object the real one's two shapes both reach: plain properties AND setProperty('--swatch').
function styleObj() {
  const props = new Map();
  return {
    cssText: '',
    props,
    setProperty: (k, v) => props.set(k, String(v)),
  };
}

// ---- the painting canvas ----------------------------------------------------

function attachCanvas(el, cfg, log) {
  let buf = new Uint8ClampedArray(0);
  let bw = 0;
  let bh = 0;
  el.width = 0;
  el.height = 0;
  // The element's box IS its bitmap here, so natPerCss() is 1 and a client point is a natural one.
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => el.width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => el.height });

  const sync = () => {
    const w = el.width | 0;
    const h = el.height | 0;
    if (w === bw && h === bh) return;
    bw = w; bh = h;
    buf = new Uint8ClampedArray(Math.max(0, w * h * 4));
  };
  const put = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return;
    const i = ((y | 0) * bw + (x | 0)) * 4;
    buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
  };
  const read = (x, y) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return [0, 0, 0, 0];
    const i = ((y | 0) * bw + (x | 0)) * 4;
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
  };
  el.__read = read;

  const state = { font: 'bold 10px x', strokeStyle: '#000000', fillStyle: '#000000' };
  const fontPx = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] || 10);

  const api = {
    clearRect(x, y, w, h) {
      sync();
      if (x <= 0 && y <= 0 && w >= bw && h >= bh) { buf.fill(0); return; }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, [0, 0, 0, 0]);
    },
    // The base image, or another canvas (that is how soften() copies a padded region out and back).
    drawImage(src, ...a) {
      sync();
      let sx = 0; let sy = 0; let sw; let sh; let dx; let dy; let dw; let dh;
      const srcW = src.__natW === undefined ? src.width : src.__natW;
      const srcH = src.__natH === undefined ? src.height : src.__natH;
      if (a.length >= 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
      else if (a.length >= 4) { [dx, dy, dw, dh] = a; sw = srcW; sh = srcH; }
      else { [dx, dy] = a; sw = srcW; sh = srcH; dw = sw; dh = sh; }
      const pick = src.__read || ((x, y) => basePixel(x, y));
      for (let j = 0; j < dh; j++) {
        const yy = sy + Math.floor((j * sh) / dh);
        for (let i = 0; i < dw; i++) put(dx + i, dy + j, pick(sx + Math.floor((i * sw) / dw), yy));
      }
    },
    getImageData(x, y, w, h) {
      sync();
      log.push(['getImageData', x, y, w, h]);
      const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const px = read(x + i, y + j);
          const k = (j * w + i) * 4;
          out[k] = px[0]; out[k + 1] = px[1]; out[k + 2] = px[2]; out[k + 3] = px[3];
        }
      }
      return { data: out, width: w, height: h };
    },
    putImageData(image, x, y) {
      sync();
      log.push(['putImageData', x, y, image.width, image.height]);
      for (let j = 0; j < image.height; j++) {
        for (let i = 0; i < image.width; i++) {
          const k = (j * image.width + i) * 4;
          put(x + i, y + j, [image.data[k], image.data[k + 1], image.data[k + 2], image.data[k + 3]]);
        }
      }
    },
    strokeRect(x, y, w, h) {
      sync();
      log.push(['strokeRect', x, y, w, h]);
      const c = ink(state.strokeStyle);
      for (let i = 0; i <= w; i++) { put(x + i, y, c); put(x + i, y + h, c); }
      for (let j = 0; j <= h; j++) { put(x, y + j, c); put(x + w, y + j, c); }
    },
    // Enough of a glyph run for a label to move pixels; the width matches measureText.
    fillText(t, x, y) {
      sync();
      log.push(['fillText', String(t), x, y]);
      const c = ink(state.fillStyle);
      const w = Math.round(String(t).length * fontPx() * 0.6);
      for (let i = 0; i < w; i++) put(x + i, y, c);
    },
    measureText(t) { return { width: String(t).length * fontPx() * 0.6 }; },
    moveTo(x, y) { log.push(['moveTo', x, y]); },
    lineTo(x, y) { log.push(['lineTo', x, y]); },
    arc(x, y, r) { log.push(['arc', x, y, r]); },
    setLineDash(d) { log.push(['setLineDash', Array.from(d)]); },
    toString: () => '[object CanvasRenderingContext2D]',
  };

  const ctx = new Proxy(api, {
    get(t, k) {
      if (k in t) return t[k];
      if (k in state) return state[k];
      return NOOP;              // every ctx call this engine makes that changes no pixel here
    },
    set(t, k, v) { state[k] = v; log.push(['set', k, v]); return true; },
    has() { return true; },     // 'filter' in ctx — the feature test soften() runs
  });

  el.getContext = () => {
    if (cfg.softenThrows && el.__buffer) throw new TypeError('no 2d context');
    return ctx;
  };
  el.toDataURL = (type = 'image/png', q) => {
    if (cfg.exportThrows) throw new Error('the canvas is tainted');
    log.push(['toDataURL', type, q]);
    sync();
    return `data:${type};base64,${digest(buf, bw, bh)}`;
  };
  el.toBlob = (cb, type) => {
    log.push(['toBlob', type]);
    cb(cfg.blob === undefined ? { type, size: 32 } : cfg.blob);
  };
  el.__bytes = () => { sync(); return digest(buf, bw, bh); };
  Object.defineProperty(el, '__natW', { configurable: true, get: () => el.width });
  Object.defineProperty(el, '__natH', { configurable: true, get: () => el.height });
  return el;
}

// ---- the sandbox ------------------------------------------------------------

function load(over = {}) {
  const cfg = { w: 800, h: 600, ...over };
  const doc = makeDocument(['div#root']);
  const mount = doc.getElementById('root');
  const log = [];
  log.calls = (name) => log.filter((r) => r[0] === name).map((r) => r.slice(1));
  log.sets = (key) => log.filter((r) => r[0] === 'set' && r[1] === key).map((r) => r[2]);
  log.clear = () => { log.length = 0; };

  let mainCanvas = null;
  const created = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = created(tag);
    node.style = styleObj();
    const name = String(tag).toLowerCase();
    if (name === 'input') { node.value = ''; node.select = () => { node.__selected = true; }; }
    if (name === 'canvas') {
      attachCanvas(node, cfg, log);
      if (mainCanvas) node.__buffer = true; else mainCanvas = node;   // the rest are soften's
    }
    return node;
  };

  const winListeners = [];
  const win = {
    addEventListener: (t, fn) => { winListeners.push({ t, fn }); },
    removeEventListener: (t, fn) => {
      const i = winListeners.findIndex((l) => l.t === t && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
  };

  class FakeImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
    // dropImg() writes src = '' after a hand-off: that must not fire a phantom second load.
    set src(v) {
      this.__src = v;
      if (!v) return;
      if (String(v).includes('BROKEN')) { if (this.onerror) this.onerror(); return; }
      const m = /IMG:(\d+)x(\d+)/.exec(String(v));
      this.naturalWidth = m ? Number(m[1]) : 100;
      this.naturalHeight = m ? Number(m[2]) : 100;
      if (this.onload) this.onload();
    }
    get src() { return this.__src; }
  }

  const clipboard = { writes: [] };
  const sandbox = {
    window: win,
    document: doc,
    Icons: { elIn: (d, name) => { const el = d.createElement('span'); el.dataset.icon = name; return el; } },
    Image: FakeImage,
    navigator: {
      clipboard: {
        async write(items) {
          clipboard.writes.push(items);
          if (cfg.clipboardRefuses) throw new Error('clipboard denied');
        },
      },
    },
    ClipboardItem: class { constructor(map) { this.map = map; } },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: (fn, ms) => { log.push(['setTimeout', ms]); return 1; },
    clearTimeout: NOOP,
    console,
  };
  const context = createContext(sandbox);
  // annot-geometry.js and annot-history.js first, exactly as both hosts load them: the core reads a
  // constant off each while it evaluates, and every box, grab, grip and undo below comes out of them.
  for (const rel of ['shared/annot-geometry.js', 'shared/annot-history.js', 'shared/annotate-core.js']) {
    const path = sharedPath(rel);
    runInContext(sourceOf(path), context, { filename: path });
  }
  const Core = sandbox.window.AnnotateCore;

  const calls = { applied: [], cancelled: [], discardAsked: 0, keepAsked: [], ready: null };
  const answers = { discard: true, keep: true };
  const handle = Core.create({
    mount,
    doc,
    dataUrl: cfg.dataUrl === undefined ? IMG(cfg.w, cfg.h) : cfg.dataUrl,
    onApply: (u) => { calls.applied.push(u); },
    onCancel: () => { calls.cancelled.push(true); },
    confirmDiscard: () => { calls.discardAsked += 1; return answers.discard; },
    confirmKeep: (hasBlur) => { calls.keepAsked.push(hasBlur); return answers.keep; },
    onReady: (hooks) => { calls.ready = hooks; },
  });

  const canvas = () => doc.getElementById('annot-canvas');
  return {
    hooks: handle.hooks,
    destroy: handle.destroy,
    doc,
    mount,
    calls,
    answers,
    log,
    clipboard,
    winListeners,
    ops: () => plain(handle.hooks.ops()),
    wrap: () => mount.querySelector('.annot'),
    canvas,
    bytes: () => canvas().__bytes(),
    btn: (id) => doc.getElementById(id),
    textEl: () => mount.querySelector('.annot-text-input'),
    key: (props) => fire(doc, 'keydown', props),
    fire,
  };
}

// ================= 1. Export and the three exits (AC1-AC11) =================

test('AC1: Save with a shape still selected hands back the picture without the selection marquee', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  const clean = h.hooks.exportDataUrl();
  h.hooks.select(150, 150);
  h.hooks.apply();
  assert.equal(h.calls.applied[0], clean, 'the uploaded JPEG must not carry the marquee');
});

test('AC2: exporting with a shape selected hands back a clean picture and puts the marquee back', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  const clean = h.hooks.exportDataUrl();
  assert.equal(h.hooks.select(150, 150), 0);
  const out = h.hooks.exportDataUrl();
  assert.equal(out, clean, 'the export is the picture without the selection');
  assert.equal(h.hooks.selected(), 0, 'the shape is still selected afterwards');
  assert.notEqual(h.bytes(), clean, 'the marquee is repainted on the canvas the tester is looking at');
});

test('AC3: Esc after a blur asks first, then discards and attaches nothing', () => {
  const h = load();
  h.hooks.add({ tool: 'pixelate', x1: 100, y1: 100, x2: 200, y2: 200 });

  h.answers.discard = false;
  h.key({ key: 'Escape' });
  assert.equal(h.calls.discardAsked, 1, 'the tester is asked before the work is thrown away');
  assert.deepEqual(h.calls.cancelled, [], 'saying no keeps the annotator open');
  assert.deepEqual(h.calls.applied, []);

  h.answers.discard = true;
  h.key({ key: 'Escape' });
  assert.equal(h.calls.discardAsked, 2);
  assert.equal(h.calls.cancelled.length, 1, 'saying yes discards');
  assert.deepEqual(h.calls.applied, [], 'Esc never hands back the un-blurred shot');
});

test('AC4: Esc with the colour menu open closes the menu and goes no further', () => {
  const h = load();
  h.btn('annot-color').click();
  assert.equal(h.btn('annot-color-menu').hidden, false);

  const ev = h.key({ key: 'Escape' });
  assert.equal(h.btn('annot-color-menu').hidden, true);
  assert.equal(ev.propagationStopped, true, 'the host page must not see this Esc');
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.calls.cancelled, []);
  assert.equal(h.calls.discardAsked, 0);
});

test('AC5: Esc with the keyboard card open hides the card and goes no further', () => {
  const h = load();
  assert.equal(h.hooks.help(true), true);
  const ev = h.key({ key: 'Escape' });
  assert.equal(h.btn('annot-help').hidden, true);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(h.calls.cancelled, []);
  assert.equal(h.calls.discardAsked, 0);
});

test('AC6: Esc with a shape selected only clears the selection', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(h.hooks.select(150, 150), 0);

  const ev = h.key({ key: 'Escape' });
  assert.equal(h.hooks.selected(), null);
  assert.equal(ev.propagationStopped, true);
  assert.deepEqual(h.calls.cancelled, []);
  assert.equal(h.calls.discardAsked, 0);
  assert.equal(h.ops().length, 1, 'the shape itself survives');
});

test('AC7: Esc on an untouched screenshot leaves at once, with nothing to ask about', () => {
  const h = load();
  h.key({ key: 'Escape' });
  assert.equal(h.calls.discardAsked, 0, 'there is no work to lose, so no dialog');
  assert.equal(h.calls.cancelled.length, 1);
  assert.deepEqual(h.calls.applied, []);
});

test('AC8: Keep original after a blur names the blur in the question, then hands back the raw shot', () => {
  const h = load();
  h.hooks.add({ tool: 'pixelate', x1: 100, y1: 100, x2: 200, y2: 200 });

  h.answers.keep = false;
  h.btn('annot-keep').click();
  assert.deepEqual(plain(h.calls.keepAsked), [true], 'the core says a blur is about to be un-hidden');
  assert.deepEqual(h.calls.applied, [], 'saying no keeps the annotator open');

  h.answers.keep = true;
  h.btn('annot-keep').click();
  assert.deepEqual(plain(h.calls.keepAsked), [true, true]);
  assert.deepEqual(h.calls.applied, [IMG(800, 600)], 'the RAW capture goes back, not the flattened one');
});

test('AC9: Keep original after a crop and nothing else still asks, without claiming a blur', () => {
  const h = load();
  assert.equal(h.hooks.applyCrop({ x1: 100, y1: 100, x2: 300, y2: 300 }), true);
  assert.deepEqual(plain(h.hooks.ops()), [], 'a crop is not an op');

  h.btn('annot-keep').click();
  assert.deepEqual(plain(h.calls.keepAsked), [false], 'work was done, so it asks — with no blur wording');
  assert.deepEqual(h.calls.applied, [IMG(800, 600)]);
});

test('AC10: the e2e keep hook returns the raw original with no question — only the buttons ask', () => {
  const h = load();
  h.hooks.add({ tool: 'pixelate', x1: 100, y1: 100, x2: 200, y2: 200 });
  h.hooks.keep();
  assert.deepEqual(plain(h.calls.keepAsked), [], 'the hooks are the automation seam, not the tester');
  assert.deepEqual(h.calls.applied, [IMG(800, 600)]);
});

test('AC11: pressing Save twice hands the image back once', async () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  await h.hooks.apply();
  await h.hooks.apply();
  await settle();
  assert.equal(h.calls.applied.length, 1);
});

// ============ 2. Geometry, handles and hit-testing (AC22-AC29) ============

test('AC22: the bend grip lands where the tester dropped it, not twice as far away', () => {
  const h = load();
  h.hooks.add({ tool: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0 });
  assert.equal(h.hooks.select(50, 0), 0);
  assert.deepEqual(plain(h.hooks.handles()), [
    { id: 'a', x: 0, y: 0 }, { id: 'bend', x: 50, y: 0 }, { id: 'b', x: 100, y: 0 },
  ]);

  assert.equal(h.hooks.dragHandle('bend', 50, 40), true);
  const op = h.ops()[0];
  assert.equal(op.cx, 50);
  assert.equal(op.cy, 80, 'the control point is reflected so the CURVE passes through the grip');
  assert.deepEqual(plain(h.hooks.handles())[1], { id: 'bend', x: 50, y: 40 });
});

test('AC23: dragging a bent arrow carries its bend along with both ends', () => {
  const h = load();
  h.hooks.add({ tool: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0, cx: 50, cy: 80 });
  assert.equal(h.hooks.select(50, 40), 0);
  assert.equal(h.hooks.moveSelected(10, 20), true);

  const op = h.ops()[0];
  assert.deepEqual(
    { x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2, cx: op.cx, cy: op.cy },
    { x1: 10, y1: 20, x2: 110, y2: 20, cx: 60, cy: 100 },
  );
});

test('AC24: a corner grip moves its own two edges and leaves the opposite corner alone', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(h.hooks.select(150, 150), 0);
  assert.equal(h.hooks.dragHandle('x1y2', 40, 260), true);

  const op = h.ops()[0];
  assert.deepEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 40, y1: 100, x2: 200, y2: 260 });
});

test('AC25: the resize cursor follows the box as it stands, so one dragged right-to-left fits', () => {
  const cursorAt = (op, x, y) => {
    const h = load();
    h.hooks.setTool('select');
    h.hooks.add(op);
    assert.equal(h.hooks.select((op.x1 + op.x2) / 2, (op.y1 + op.y2) / 2), 0);
    h.fire(h.canvas(), 'pointermove', { clientX: x, clientY: y });
    return h.canvas().style.cursor;
  };
  const upright = { tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 };
  const flipped = { tool: 'rect', x1: 200, y1: 100, x2: 100, y2: 200 };

  assert.equal(cursorAt(upright, 100, 100), 'nwse-resize');
  assert.equal(cursorAt(upright, 200, 100), 'nesw-resize');
  assert.equal(cursorAt(flipped, 200, 100), 'nesw-resize', 'the same grip, the other diagonal');
  assert.equal(cursorAt(flipped, 100, 100), 'nwse-resize');
});

test('AC26: where a pen stroke crosses an earlier box, the click picks the stroke on top', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  h.hooks.add({ tool: 'pen', pts: [{ x: 120, y: 150 }, { x: 180, y: 150 }] });

  assert.equal(h.hooks.select(150, 150), 1, 'the last mark drawn is the one on top');
  h.hooks.deleteSelected();
  assert.equal(h.hooks.select(150, 150), 0, 'and the box underneath was reachable all along');
});

test('AC27: a blur is grabbed only from inside it — unlike a box, it has no grab margin', () => {
  const blur = load();
  blur.hooks.add({ tool: 'pixelate', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(blur.hooks.select(199, 150), 0, 'inside the region');
  assert.equal(blur.hooks.select(203, 150), null, 'three px outside is a miss');

  const box = load();
  box.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(box.hooks.select(203, 150), 0, 'a box the same size answers near its edge');
});

test('AC28: a single pen tap is still a dot, and is grabbed by how near the click lands', () => {
  const h = load();
  h.log.clear();
  h.hooks.add({ tool: 'pen', pts: [{ x: 100, y: 100 }] });

  assert.deepEqual(h.log.calls('lineTo'), [[100.01, 100]], 'a lone point is drawn as a dot');
  assert.equal(h.hooks.select(100, 100), 0);
  assert.equal(h.hooks.select(105, 100), 0, 'inside the grab tolerance');
  assert.equal(h.hooks.select(120, 100), null);
});

test('AC29: the marker owns the width it is painted at, not the width of its path', () => {
  const marquee = (tool) => {
    const h = load();
    h.hooks.add({ tool, pts: [{ x: 100, y: 100 }, { x: 200, y: 100 }] });
    h.log.clear();
    h.hooks.select(150, 100);
    return h.log.calls('strokeRect')[0];
  };
  // The marker is stroked six times its weight, so its box is padded by half of that.
  assert.deepEqual(marquee('highlight'), [87, 87, 126, 26]);
  assert.deepEqual(marquee('pen'), [94.5, 94.5, 111, 11]);

  const hl = load();
  hl.hooks.add({ tool: 'highlight', pts: [{ x: 100, y: 100 }, { x: 200, y: 100 }] });
  assert.equal(hl.hooks.select(150, 115), 0, 'a click on the painted band still grabs the marker');
  const pen = load();
  pen.hooks.add({ tool: 'pen', pts: [{ x: 100, y: 100 }, { x: 200, y: 100 }] });
  assert.equal(pen.hooks.select(150, 115), null, 'the same click misses a pen line');
});

// ================= 3. Crop and the undo stack (AC13-AC19) =================

test('AC13: a crop drag too short to mean anything is a mis-click, not a crop', () => {
  const h = load();
  const before = h.bytes();
  assert.equal(h.hooks.applyCrop({ x1: 0, y1: 0, x2: 5, y2: 5 }), false);
  assert.deepEqual(plain(h.hooks.crop()), { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(h.btn('annot-undo').disabled, true, 'nothing to undo — no history entry was made');
  assert.equal(h.bytes(), before, 'the picture is untouched');
});

test('AC14: cropping re-bases every mark onto the part the tester kept', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 110, y1: 110, x2: 150, y2: 150 });
  assert.equal(h.hooks.applyCrop({ x1: 100, y1: 100, x2: 300, y2: 300 }), true);

  assert.deepEqual(plain(h.hooks.crop()), { x: 100, y: 100, w: 200, h: 200 });
  assert.deepEqual(plain(h.hooks.natural()), { w: 200, h: 200 });
  const op = h.ops()[0];
  assert.deepEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 10, y1: 10, x2: 50, y2: 50 });
});

test('AC15: undoing a crop brings back the whole shot with the mark where it was', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 110, y1: 110, x2: 150, y2: 150 });
  h.hooks.applyCrop({ x1: 100, y1: 100, x2: 300, y2: 300 });
  h.hooks.undo();

  assert.deepEqual(plain(h.hooks.crop()), { x: 0, y: 0, w: 800, h: 600 });
  assert.deepEqual(plain(h.hooks.natural()), { w: 800, h: 600 });
  const op = h.ops()[0];
  assert.deepEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 110, y1: 110, x2: 150, y2: 150 },
    'a snapshot is already in its own crop coords — restoring must not shift it a second time');
});

test('AC16: redoing the crop puts the mark back in the cropped picture', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 110, y1: 110, x2: 150, y2: 150 });
  h.hooks.applyCrop({ x1: 100, y1: 100, x2: 300, y2: 300 });
  h.hooks.undo();
  h.hooks.redo();

  assert.deepEqual(plain(h.hooks.crop()), { x: 100, y: 100, w: 200, h: 200 });
  const op = h.ops()[0];
  assert.deepEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 10, y1: 10, x2: 50, y2: 50 });
});

test('AC17: a crop drag off the edge of the picture is clamped to the picture in force', () => {
  const h = load();
  h.hooks.applyCrop({ x1: 100, y1: 100, x2: 300, y2: 300 });
  assert.equal(h.hooks.applyCrop({ x1: -50, y1: -50, x2: 5000, y2: 5000 }), true);

  assert.deepEqual(plain(h.hooks.crop()), { x: 100, y: 100, w: 200, h: 200 },
    'clamped to the CURRENT canvas, and composed onto the crop already in force');
});

// Drawing after an undo forks the history: what the tester undid is gone for good, and the Redo
// arrow must say so. Without this the redone mark comes back on top of the one drawn instead of it.
test('AC16b: drawing after an undo throws away what was undone, and greys out Redo', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 10, y1: 10, x2: 20, y2: 20 });
  h.hooks.add({ tool: 'rect', x1: 30, y1: 30, x2: 40, y2: 40 });
  h.hooks.undo();
  h.hooks.add({ tool: 'ellipse', x1: 50, y1: 50, x2: 60, y2: 60 });

  assert.equal(h.btn('annot-redo').disabled, true, 'there is nothing left to redo');
  h.hooks.redo();
  assert.deepEqual(h.ops().map((o) => o.tool), ['rect', 'ellipse'], 'the undone mark does not come back');
});

// Redo on a fresh editor is the reflex press of a tester who has drawn nothing yet.
test('AC16c: Redo is greyed out and does nothing until something has been undone', () => {
  const h = load();
  assert.equal(h.btn('annot-redo').disabled, true);
  h.hooks.redo();
  assert.deepEqual(h.ops(), []);
  h.hooks.add({ tool: 'rect', x1: 10, y1: 10, x2: 20, y2: 20 });
  assert.equal(h.btn('annot-redo').disabled, true, 'drawing is not something to redo');
  h.hooks.undo();
  assert.equal(h.btn('annot-redo').disabled, false);
  h.hooks.redo();
  assert.equal(h.btn('annot-redo').disabled, true, 'and it is spent once it has been pressed');
});

// A snapshot has to own its points, not borrow them: moving the stroke afterwards would otherwise
// drag the snapshot along, and Undo would put the stroke back exactly where it already is.
test('AC18b: undoing a dragged pen stroke puts every one of its points back', () => {
  const h = load();
  h.hooks.add({ tool: 'pen', pts: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }] });
  h.hooks.select(20, 20);
  h.hooks.moveSelected(100, 5);

  h.hooks.undo();
  assert.deepEqual(plain(h.ops()[0].pts), [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }]);
});

test('AC18: the undo stack stops at fifty steps, and the marks below it are stranded', () => {
  const h = load({ w: 60, h: 40 });
  for (let i = 0; i < 60; i += 1) h.hooks.add({ tool: 'rect', x1: i, y1: i, x2: i + 5, y2: i + 5 });
  assert.equal(h.ops().length, 60);

  let steps = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const before = h.ops().length;
    h.hooks.undo();
    if (h.ops().length === before) break;
    steps += 1;
  }
  assert.equal(steps, 50);
  assert.equal(h.ops().length, 10, 'the first ten marks can never be undone again');
  assert.equal(h.btn('annot-undo').disabled, true);
});

test.todo('AC19 (#317): restyling floods the undo history — ten taps should still be one step back', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(h.hooks.select(150, 150), 0);
  for (let i = 0; i < 10; i += 1) h.btn(i % 2 === 0 ? 'annot-size-l' : 'annot-size-s').click();
  assert.equal(h.ops()[0].width, 2);

  h.hooks.undo();
  assert.equal(h.ops()[0].width, 3, 'one undo should take the tester back past the restyling');
});

// ========== 4. Labels, badges and the ink they carry (AC12, AC20-AC21, AC33-AC43) ==========

// Pick the Text tool and click the picture: that is the only way the input opens.
function openLabel(h, x, y, value) {
  h.hooks.setTool('text');
  h.fire(h.canvas(), 'pointerdown', { clientX: x, clientY: y, pointerId: 1 });
  const input = h.textEl();
  assert.ok(input, 'the click should have opened a text input');
  input.value = value;
  return input;
}

test('AC12: badge numbers are read off the badges on screen, so deleting one leaves a gap', () => {
  const h = load();
  h.hooks.add({ tool: 'number', x: 50, y: 50 });
  h.hooks.add({ tool: 'number', x: 100, y: 50 });
  h.hooks.add({ tool: 'number', x: 150, y: 50 });
  assert.deepEqual(h.ops().map((o) => o.n), [1, 2, 3]);

  assert.equal(h.hooks.select(100, 50), 1);
  h.hooks.deleteSelected();
  h.hooks.add({ tool: 'number', x: 200, y: 50 });
  assert.deepEqual(h.ops().map((o) => o.n), [1, 3, 4], 'the next badge continues the highest number');
});

test('AC20: a colour the palette does not carry is ignored, and a colour name is understood', () => {
  const h = load();
  assert.equal(h.hooks.color(), '#dc2626');
  h.hooks.setColor('#123456');
  assert.equal(h.hooks.color(), '#dc2626', 'an ink off the palette leaves the current one alone');
  h.hooks.setColor('green');
  assert.equal(h.hooks.color(), '#16a34a');
  h.hooks.setColor('#2563eb');
  assert.equal(h.hooks.color(), '#2563eb');
});

test('AC21: an unknown stroke weight is ignored, and the thickest one has nothing above it', () => {
  const h = load();
  assert.equal(h.hooks.width(), 3);
  h.hooks.setWidth(99);
  assert.equal(h.hooks.width(), 3);

  h.hooks.setWidth('l');
  assert.equal(h.hooks.width(), 6);
  h.key({ key: ']' });
  assert.equal(h.hooks.width(), 6);
  h.key({ key: '[' });
  assert.equal(h.hooks.width(), 3);
});

test('AC33: a label of nothing but spaces is not a label; a typed space is kept as typed', () => {
  const h = load();
  h.fire(openLabel(h, 100, 100, '   '), 'keydown', { key: 'Enter' });
  assert.deepEqual(h.ops(), [], 'blank is nothing to add');

  h.fire(openLabel(h, 200, 200, ' hi '), 'keydown', { key: 'Enter' });
  assert.equal(h.ops().length, 1);
  assert.equal(h.ops()[0].text, ' hi ', 'the spaces the tester typed are part of the label');
});

test('AC34: emptying a label deletes it, and the delete can be taken back', () => {
  const h = load();
  h.hooks.add({ tool: 'text', x: 100, y: 100, text: 'hello', size: 20 });
  assert.equal(h.hooks.editTextAt(102, 102), true);

  const input = h.textEl();
  input.value = '';
  h.fire(input, 'blur');
  assert.deepEqual(h.ops(), [], 'a retype to nothing is a delete');

  h.hooks.undo();
  assert.equal(h.ops()[0].text, 'hello');
});

test('AC35: reopening a label and typing the same words costs the tester no undo step', () => {
  const h = load();
  h.hooks.add({ tool: 'text', x: 100, y: 100, text: 'hello', size: 20 });
  h.hooks.editTextAt(102, 102);

  const input = h.textEl();
  assert.equal(input.__selected, true, 'a retype opens on the whole label, so typing replaces it');
  input.value = 'hello';
  h.fire(input, 'keydown', { key: 'Enter' });
  assert.equal(h.ops()[0].text, 'hello');

  h.hooks.undo();
  assert.deepEqual(h.ops(), [], 'one undo reaches the add, so the retype added no step');
});

test('AC36: retyping a label that was deleted out from under the input just re-draws', () => {
  const h = load();
  h.hooks.add({ tool: 'text', x: 100, y: 100, text: 'hello', size: 20 });
  h.hooks.editTextAt(102, 102);
  const input = h.textEl();

  h.hooks.deleteSelected();
  input.value = 'new';
  assert.doesNotThrow(() => h.fire(input, 'keydown', { key: 'Enter' }));
  assert.deepEqual(h.ops(), [], 'the label stays deleted, and nothing is re-added');
});

test('AC37: Esc inside a label input backs out of the retype and never leaves the annotator', () => {
  const h = load();
  h.hooks.add({ tool: 'text', x: 100, y: 100, text: 'hello', size: 20 });
  h.hooks.editTextAt(102, 102);

  const input = h.textEl();
  input.value = 'changed';
  const ev = h.fire(input, 'keydown', { key: 'Escape', bubbles: true });

  assert.equal(ev.propagationStopped, true, 'the annotator-wide Esc handler must not see it');
  assert.deepEqual(h.calls.cancelled, []);
  assert.equal(h.calls.discardAsked, 0);
  assert.equal(h.textEl(), null);
  assert.equal(h.ops()[0].text, 'hello', 'the label is back on the canvas it was lifted off');
});

test('AC38: a letter typed into a label input is typing, not a tool shortcut', () => {
  const h = load();
  const input = openLabel(h, 100, 100, '');

  const ev = h.fire(input, 'keydown', { key: 'r', bubbles: true });
  assert.equal(ev.propagationStopped, true);
  assert.equal(h.hooks.tool(), 'text');

  h.key({ key: 'r' });
  assert.equal(h.hooks.tool(), 'text', 'the shortcut map stands down while the input is open');
});

test('AC40: a label saved without a size is drawn at the size the picture asks for', () => {
  const h = load({ w: 1500, h: 600 });
  h.hooks.add({ tool: 'text', x: 100, y: 100, text: 'abc' });
  assert.equal(h.hooks.ops()[0].size, undefined);

  assert.equal(h.hooks.select(150, 130), 0, 'at 1500 px wide the label is 30 px tall');
  assert.equal(h.hooks.select(150, 145), null);

  h.hooks.applyCrop({ x1: 0, y1: 0, x2: 500, y2: 400 });
  assert.equal(h.hooks.select(150, 130), null, 'the crop makes the same label render smaller');
  assert.equal(h.hooks.select(120, 110), 0);
});

test('AC41: the badge is sized off the picture and the weight, and frozen where it was dropped', () => {
  const h = load({ w: 800, h: 600 });
  assert.equal(h.hooks.badgeRadius(), 9, 'the default weight sits on the floor');
  h.hooks.setWidth('l');
  assert.equal(h.hooks.badgeRadius(), 15);

  h.hooks.add({ tool: 'number', x: 100, y: 100 });
  assert.equal(h.ops()[0].r, 15);
  h.hooks.applyCrop({ x1: 0, y1: 0, x2: 200, y2: 200 });
  assert.equal(h.ops()[0].r, 15, 'the badge does not reflow when the picture is cropped');
  assert.equal(h.hooks.badgeRadius(), 9, 'though a badge dropped now would be smaller');
});

test('AC42: a white badge draws its ring and its numeral dark, so it exists on a light shot', () => {
  const badge = (colour) => {
    const h = load();
    if (colour) h.hooks.setColor(colour);
    h.hooks.add({ tool: 'number', x: 100, y: 100 });
    h.log.clear();
    h.hooks.setTool('number');   // one clean re-render, nothing else on the canvas
    return { fills: h.log.sets('fillStyle'), strokes: h.log.sets('strokeStyle') };
  };
  assert.deepEqual(badge(null), { fills: ['#dc2626', '#ffffff'], strokes: ['#ffffff'] });
  assert.deepEqual(badge('white'), { fills: ['#ffffff', '#171717'], strokes: ['#171717'] });
});

test('AC43: a badge that reaches 10 and 100 shrinks its numeral instead of growing the disc', () => {
  const h = load();
  h.hooks.add({ tool: 'number', x: 100, y: 100, n: 1 });
  h.hooks.add({ tool: 'number', x: 200, y: 100, n: 10 });
  h.hooks.add({ tool: 'number', x: 300, y: 100, n: 100 });

  h.log.clear();
  h.hooks.setTool('number');
  assert.deepEqual(h.log.sets('font').map((f) => /(\d+)px/.exec(f)[1]), ['11', '9', '8']);
  assert.deepEqual(h.ops().map((o) => o.r), [9, 9, 9], 'a run of steps stays one size');
});

// ====== 5. Redaction, the clipboard, boot and teardown (AC30-AC32, AC39, AC44-AC50) ======

test('AC30: a blur dragged off the edge still hides the part of it that is on the picture', () => {
  const h = load({ w: 200, h: 200 });
  h.log.clear();
  assert.doesNotThrow(() => h.hooks.add({ tool: 'pixelate', x1: -40, y1: 50, x2: 60, y2: 100 }));
  assert.deepEqual(h.log.calls('getImageData'), [[0, 50, 60, 50]], 'clipped to the canvas');

  assert.deepEqual(plain(h.hooks.pixelAt(2, 52)), plain(h.hooks.pixelAt(10, 60)), 'one flat block');
  assert.notDeepEqual(plain(h.hooks.pixelAt(2, 52)), plain(h.hooks.pixelAt(14, 52)), 'the next block over');

  const off = load({ w: 200, h: 200 });
  off.log.clear();
  assert.doesNotThrow(() => off.hooks.add({ tool: 'pixelate', x1: -100, y1: 50, x2: -50, y2: 100 }));
  assert.deepEqual(off.log.calls('getImageData'), [], 'wholly off the picture: nothing to read back');
});

test('AC31: when the browser cannot soften the mosaic, the mosaic alone still hides the data', () => {
  const h = load({ w: 200, h: 200, softenThrows: true });
  assert.doesNotThrow(() => h.hooks.add({ tool: 'pixelate', x1: 50, y1: 50, x2: 150, y2: 150 }));

  const block = plain(h.hooks.pixelAt(52, 52));
  assert.deepEqual(plain(h.hooks.pixelAt(60, 60)), block, 'the block is one flat colour');
  assert.notDeepEqual(block, basePixel(52, 52), 'and the pixel that was under it is gone');
});

test('AC32: exporting twice with a blur on the picture gives the same bytes both times', () => {
  const h = load();
  h.hooks.add({ tool: 'pixelate', x1: 100, y1: 100, x2: 200, y2: 200 });
  const first = h.hooks.exportDataUrl();
  const inside = plain(h.hooks.pixelAt(105, 105));

  h.hooks.setTool('pen');   // a whole fresh frame, redrawn from the untouched capture
  assert.equal(h.hooks.exportDataUrl(), first, 'the blur is never applied on top of itself');
  assert.deepEqual(plain(h.hooks.pixelAt(105, 105)), inside);
});

test('AC39: Delete removes the selected mark, and the removal can be taken back', () => {
  const h = load();
  h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
  assert.equal(h.hooks.select(150, 150), 0);

  h.key({ key: 'Delete' });
  assert.deepEqual(h.ops(), []);
  h.hooks.undo();
  assert.equal(h.ops().length, 1);

  assert.equal(h.hooks.select(150, 150), 0);
  h.key({ key: 'Backspace' });
  assert.deepEqual(h.ops(), [], 'Backspace is the same key on a laptop');
});

test('AC44: a bogus crop op handed to the add hook is stored but never drawn or grabbed', () => {
  const h = load();
  const before = h.hooks.exportDataUrl();
  h.hooks.add({ tool: 'crop', x1: 10, y1: 10, x2: 100, y2: 100 });

  assert.equal(h.ops().length, 1);
  assert.equal(h.ops()[0].tool, 'crop');
  assert.equal(h.hooks.select(50, 50), null, 'nothing there to grab');
  assert.equal(h.hooks.exportDataUrl(), before, 'and nothing there to see');
  assert.deepEqual(plain(h.hooks.crop()), { x: 0, y: 0, w: 800, h: 600 }, 'nor does it crop anything');
});

test('AC45: a refused clipboard says so and points at Download, and gives the selection back', async () => {
  const copied = load();
  await copied.hooks.copy();
  assert.equal(copied.btn('annot-flash').textContent, 'Copied to the clipboard');

  const refused = "The browser wouldn't let this page copy — use Download";
  for (const cfg of [{ blob: null }, { clipboardRefuses: true }]) {
    const h = load(cfg);
    h.hooks.add({ tool: 'rect', x1: 100, y1: 100, x2: 200, y2: 200 });
    const clean = h.bytes();
    assert.equal(h.hooks.select(150, 150), 0);

    await h.hooks.copy();
    assert.equal(h.btn('annot-flash').textContent, refused);
    assert.equal(h.hooks.selected(), 0);
    assert.notEqual(h.bytes(), clean, 'the marquee is back on the canvas');
    assert.equal(h.clipboard.writes.length, cfg.blob === null ? 0 : 1);
  }
});

test('AC46: a download the browser will not encode says so and leaves no anchor behind', () => {
  const ok = load();
  ok.hooks.download();
  assert.equal(ok.btn('annot-flash').textContent, 'Saved to your downloads');
  assert.deepEqual(ok.wrap().querySelectorAll('a'), [], 'the anchor is taken back out of the page');

  const h = load({ exportThrows: true });
  assert.doesNotThrow(() => h.hooks.download());
  assert.equal(h.btn('annot-flash').textContent, 'Could not save the image');
  assert.deepEqual(h.wrap().querySelectorAll('a'), []);
});

test('AC47: a capture that will not decode says so instead of showing an empty stage', () => {
  const h = load({ dataUrl: BROKEN });
  assert.equal(h.hooks.ready, false);
  assert.equal(h.calls.ready, null);
  assert.equal(h.mount.textContent, 'Could not load the captured image.');
  assert.equal(h.mount.querySelector('.annot'), null, 'the toolbar is not left half-built');
});

test('AC48: closing the annotator takes its keyboard, its resize hook and its input away', () => {
  const h = load();
  h.hooks.help(true);
  h.key({ key: 'Escape' });
  assert.equal(h.btn('annot-help').hidden, true, 'the annotator is listening at this point');
  openLabel(h, 100, 100, 'half typed');

  h.destroy();
  assert.equal(h.textEl(), null, 'the half-typed label input is off the page');
  assert.equal(h.winListeners.filter((l) => l.t === 'resize').length, 0);

  h.hooks.help(true);
  h.key({ key: 'Escape' });
  assert.equal(h.btn('annot-help').hidden, false, 'and it has stopped listening');
  assert.deepEqual(h.calls.cancelled, []);
});

test('AC49: the tallest full-page shot the worker can produce opens and is annotatable', () => {
  // background.js clamps a full-page capture to FULLPAGE_MAX_HEIGHT (16384) and says it clipped.
  const h = load({ w: 120, h: 16384 });
  assert.equal(h.hooks.ready, true);
  assert.deepEqual(plain(h.hooks.natural()), { w: 120, h: 16384 });
  assert.equal(h.mount.querySelector('.annot-msg'), null, 'no failure plaque');
  assert.ok(h.hooks.exportDataUrl().startsWith('data:image/jpeg;base64,'));
});

test('AC50: the shortcut keys answer even with a page input focused — the annotator covers the page', () => {
  const h = load();
  const pageInput = h.doc.createElement('input');
  h.doc.body.append(pageInput);
  pageInput.focus();
  assert.equal(h.doc.activeElement, pageInput);

  h.key({ key: 'r' });
  assert.equal(h.hooks.tool(), 'rect', 'the on-page host is fixed, inset 0, at the top z-index');
  h.key({ key: '3' });
  assert.equal(h.hooks.color(), '#eab308');
  h.key({ key: ']' });
  assert.equal(h.hooks.width(), 6);
});
