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
    getPropertyValue: (k) => props.get(k) || '',
    removeProperty: (k) => props.delete(k),
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
  el.__isCanvas = true;

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
    fillRect(x, y, w, h) {
      sync();
      const c = ink(state.fillStyle);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c);
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

  el.getContext = (kind) => {
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
  const path = sharedPath('shared/annotate-core.js');
  runInContext(sourceOf(path), context, { filename: path });
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
    Core,
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

test.todo('AC1 (#204): Save with a shape selected still bakes the selection marquee into the JPEG', () => {
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
