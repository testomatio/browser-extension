#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInto, plain, settle } from './helpers/shared-harness.mjs';

// loadInto() resolves this via sharedPath(), so SHARED_MODULES can swap in a mutated copy.
const RECORDER = 'offscreen/recorder.js';
const WEBM = 'shared/webm-duration.js';

// Written out, not read off the module: a mutation that moves a cap must make a row fail.
const TIME_CAP = 300000;
const SIZE_CAP = 50 * 1024 * 1024;

const NOW = 1_700_000_000_000;

// castFrame's chain, the decode, rec.stop()'s callbacks and the arrayBuffer await land in turn.
const flush = () => settle(6);

// No Blob in a vm context: without this every finished take lands in a silent catch.
class FakeBlob {
  constructor(parts = [], opts = {}) {
    this.parts = parts
      .flatMap((p) => (p instanceof FakeBlob ? p.parts : [p]))
      .map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))
      .filter((p) => p && p.length);
    this.size = this.parts.reduce((n, p) => n + p.length, 0);
    this.type = opts.type || '';
    this.flat = null;
  }

  get bytes() {
    if (!this.flat) {
      this.flat = new Uint8Array(this.size);
      let at = 0;
      for (const p of this.parts) { this.flat.set(p, at); at += p.length; }
    }
    return this.flat;
  }

  async arrayBuffer() { return this.bytes.slice().buffer; }
}

// A distinct first byte per tag proves the parts were concatenated in MediaRecorder's order.
const chunk = (n, tag = 0) => { const u = new Uint8Array(n); u[0] = tag; return u; };

// Base64 whose first four bytes carry the picture's size, so the bitmap stub reads the real frame.
function frame(w, h) {
  const u = new Uint8Array(8);
  const dv = new DataView(u.buffer);
  dv.setUint16(0, w); dv.setUint16(2, h);
  return Buffer.from(u).toString('base64');
}

// Reads the frame's first four bytes, so a row that defers the decode still answers the real size.
function readBitmap(blob) {
  const b = blob.bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const img = { width: dv.getUint16(0), height: dv.getUint16(2), closed: 0, close: () => { img.closed += 1; } };
  return img;
}

// Chrome's atob throws on non-base64; a row needs that, not a silent empty string.
function atob(s) {
  const str = String(s);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str) || str.length % 4 !== 0) {
    throw new Error('The string to be decoded is not correctly encoded.');
  }
  return Buffer.from(str, 'base64').toString('binary');
}

// No setInterval in a vm realm, and the five-minute cap needs a clock a row turns by hand.
function makeTimers() {
  const live = new Map();
  const cleared = [];
  const made = [];
  let seq = 0;
  return {
    live,
    cleared,
    made,
    setInterval: (fn, ms) => { seq += 1; made.push({ id: seq, ms }); live.set(seq, fn); return seq; },
    clearInterval: (id) => { cleared.push(id); live.delete(id); },
    tick: (times = 1) => { for (let i = 0; i < times; i += 1) for (const fn of [...live.values()]) fn(); },
  };
}

function load(opts = {}) {
  const { now = NOW, mimes = ['video/webm;codecs=vp9'], webm = 'spy' } = opts;

  let clock = now;
  const calls = [];                 // every stubbed chrome call, in order
  const sent = [];                  // every chrome.runtime.sendMessage payload
  const recorders = [];             // every MediaRecorder ever constructed
  const canvases = [];              // every document.createElement('canvas')
  const ports = [];                 // every chrome.runtime.connect
  const urls = [];                  // every URL.createObjectURL, in order
  const revoked = [];               // every URL.revokeObjectURL argument
  const patches = [];               // every WebmDuration.patch, as {ms, size}
  const bitmaps = [];               // every createImageBitmap, as the blob's size
  const imgs = [];                  // every bitmap it handed back, so a row can see it closed
  const timers = makeTimers();
  let lastErrorReads = 0;
  let urlSeq = 0;

  // The knobs a row turns: a row overrides one after load(), and the stubs read them live.
  const hooks = {
    getUserMedia: null,             // set to throw, or to hand back a stream of your own
    stopThrows: false,              // Chrome refusing a stop on an already-dead recorder
    finalChunk: 2048,               // the last dataavailable rec.stop() flushes, the way Chrome does
    negotiated: null,               // what rec.mimeType reports back after the constructor
    disconnectThrows: false,        // a port whose other end is already gone
    sendFails: false,               // the worker asleep: sendMessage rejects
    bitmap: null,                   // set to take createImageBitmap over
    revokeThrows: () => false,      // a URL that was never ours
  };

  const makeTrack = (kind) => {
    const t = {
      kind,
      stopped: 0,
      framesRequested: 0,
      listeners: {},
      stop: () => { t.stopped += 1; },
      requestFrame: () => { t.framesRequested += 1; },
      addEventListener: (type, fn) => { (t.listeners[type] = t.listeners[type] || []).push(fn); },
      fire: (type) => (t.listeners[type] || []).forEach((fn) => fn()),
    };
    return t;
  };

  const makeStream = (tag, kinds = ['video']) => {
    const tracks = kinds.map(makeTrack);
    return {
      tag,
      tracks,
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    };
  };

  // Chrome fires the final chunk, then onstop, each in its own task; firing them sync hides the race.
  class FakeRecorder {
    static isTypeSupported(m) { return mimes.includes(m); }

    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.mimeType = hooks.negotiated != null ? hooks.negotiated : ((options && options.mimeType) || '');
      this.state = 'inactive';
      this.log = [];
      recorders.push(this);
    }

    start(slice) { this.log.push(['start', slice]); this.state = 'recording'; }

    pause() { this.log.push(['pause']); this.state = 'paused'; }

    resume() { this.log.push(['resume']); this.state = 'recording'; }

    stop() {
      this.log.push(['stop']);
      if (hooks.stopThrows) throw new Error('the recorder is already stopped');
      this.state = 'inactive';
      setImmediate(() => this.emit(hooks.finalChunk, 0xff));
      setImmediate(() => { if (this.onstop) this.onstop(); });
    }

    // A 0-byte dataavailable is what Chrome flushes with nothing buffered; the module must drop it.
    emit(size, tag = 0) {
      if (this.ondataavailable) this.ondataavailable({ data: new FakeBlob(size ? [chunk(size, tag)] : []) });
    }
  }

  const runtime = {
    get lastError() { lastErrorReads += 1; return undefined; },
    sendMessage: async (msg) => {
      calls.push({ name: 'runtime.sendMessage', arg: plain(msg) });
      sent.push(plain(msg));
      if (hooks.sendFails) throw new Error('Could not establish connection');
      return { ok: true };
    },
    connect: (info) => {
      calls.push({ name: 'runtime.connect', arg: plain(info) });
      const port = {
        name: info && info.name,
        posted: [],
        disconnects: 0,
        msgFns: [],
        discFns: [],
        postMessage: (m) => port.posted.push(plain(m)),
        onMessage: { addListener: (fn) => port.msgFns.push(fn) },
        onDisconnect: { addListener: (fn) => port.discFns.push(fn) },
        disconnect: () => {
          port.disconnects += 1;
          if (hooks.disconnectThrows) throw new Error('Attempting to use a disconnected port object');
        },
      };
      ports.push(port);
      return port;
    },
    onMessage: { addListener: (fn) => { runtime.onMessage.fns.push(fn); }, fns: [] },
  };

  const ctxOps = [];
  const makeCanvas = () => {
    const ctx = {
      ops: ctxOps,
      _fillStyle: '',
      get fillStyle() { return ctx._fillStyle; },
      set fillStyle(v) { ctx._fillStyle = v; ctxOps.push(['fillStyle', v]); },
      fillRect: (...a) => ctxOps.push(['fillRect', ...a]),
      drawImage: (img, ...a) => ctxOps.push(['drawImage', img.width, img.height, ...a]),
    };
    const canvas = {
      width: 0,
      height: 0,
      contexts: [],
      streams: [],
      getContext: (kind) => { canvas.contexts.push(kind); return ctx; },
      captureStream: (fps) => {
        const s = makeStream(`canvas-${canvases.length}`);
        s.fps = fps;
        canvas.streams.push(s);
        return s;
      },
    };
    canvases.push(canvas);
    return canvas;
  };

  const spyPatch = (buf, ms) => {
    const src = new Uint8Array(buf);
    patches.push({ ms, size: src.length });
    return src;
  };
  const growPatch = (buf, ms) => {
    const src = new Uint8Array(buf);
    patches.push({ ms, size: src.length });
    // A marker byte, so a row can prove the patched bytes are what the take is wrapped around.
    const out = new Uint8Array(src.length + 1);
    out.set(src, 0);
    out[src.length] = 0xd9;
    return out;
  };
  const throwPatch = (buf, ms) => { patches.push({ ms, size: new Uint8Array(buf).length }); throw new Error('not a webm'); };

  const sandbox = {
    console,
    chrome: { runtime },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    atob,
    Blob: FakeBlob,
    MediaRecorder: FakeRecorder,
    createImageBitmap: async (blob) => {
      bitmaps.push(blob.size);
      const img = hooks.bitmap ? await hooks.bitmap(blob) : readBitmap(blob);
      imgs.push(img);
      return img;
    },
    document: { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { tag }) },
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          calls.push({ name: 'getUserMedia', arg: plain(constraints) });
          if (hooks.getUserMedia) return hooks.getUserMedia(plain(constraints));
          return makeStream('tab');
        },
      },
    },
    URL: {
      createObjectURL: (blob) => {
        urlSeq += 1;
        const u = `blob:take-${urlSeq}`;
        // The bytes only for a take small enough to hold: the size-cap rows mint fifty-megabyte ones.
        urls.push({ url: u, size: blob.size, type: blob.type, head: blob.size <= 1024 ? [...blob.bytes] : null });
        return u;
      },
      revokeObjectURL: (u) => { if (hooks.revokeThrows(u)) throw new Error('not ours'); revoked.push(u); },
    },
  };
  if (webm !== 'real') sandbox.WebmDuration = { patch: webm === 'throws' ? throwPatch : (webm === 'grow' ? growPatch : spyPatch) };

  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }

    static now() { return clock; }
  }
  sandbox.Date = FakeDate;

  // webm-duration.js loads first, and its lexical const shadows the sandbox spy as in the page.
  const specs = webm === 'real' ? [WEBM, [RECORDER, PICK]] : [[RECORDER, PICK]];
  const { values } = loadInto(sandbox, specs);
  const st = values[values.length - 1];

  const listener = () => {
    assert.equal(runtime.onMessage.fns.length, 1, 'recorder.js should register exactly one listener');
    return runtime.onMessage.fns[0];
  };

  return {
    st,
    hooks,
    calls,
    sent,
    recorders,
    canvases,
    ports,
    urls,
    revoked,
    patches,
    bitmaps,
    imgs,
    ctxOps,
    timers,
    flush,
    makeStream,
    lastErrorReads: () => lastErrorReads,
    now: () => clock,
    advance: (ms) => { clock += ms; return clock; },
    rec: (i = 0) => recorders[i],
    port: (i = 0) => ports[i],
    files: () => sent.filter((m) => m && m.type === 'SCREENREC_FILE').map((m) => m.file),

    // `answer` resolves undefined for a cmd the listener never answers, so a row can always await it.
    call(msg, sender = {}) {
      let resolve;
      const answer = new Promise((r) => { resolve = r; });
      const ret = listener()(msg, sender, (r) => resolve(plain(r)));
      if (ret !== true) resolve(undefined);
      return { ret, answer };
    },
    send(cmd, extra = {}) { return this.call({ type: 'SCREENREC_OFF', cmd, ...extra }).answer; },

    // A frame down the pipe the module opened for itself, not the broadcast fallback.
    frameIn(b64, i = 0) { ports[i].msgFns.forEach((fn) => fn({ cmd: 'frame', data: b64 })); },
    portMsg(m, i = 0) { ports[i].msgFns.forEach((fn) => fn(m)); },
    portGone(i = 0) { ports[i].discFns.forEach((fn) => fn()); },
  };
}

// State, caps and pushFile are lexical and exist only here; `typeof` lets a copy lacking one load.
const FNS = ['pickMime', 'elapsedMs', 'reset', 'armRecorder', 'castConnect', 'castFrame',
  'castFrameNow', 'finish', 'start', 'pause', 'trimSwap', 'pushFile'];
const CAPS = ['REC_TIME_CAP_MS', 'REC_SIZE_CAP', 'REC_CHUNK_MS'];
const READS = ['rec', 'mode', 'stream', 'chunks', 'bytes', 'castCanvas', 'castTrack', 'castFrames',
  'castErr', 'framePort', 'capTimer', 'finishing', 'trimParts'];
const WRITES = ['startedAt', 'pausedAt', 'pausedMs'];
const safe = (n) => `typeof ${n} === 'undefined' ? undefined : ${n}`;
const PICK = `({
  fns: { ${FNS.map((n) => `${n}: ${safe(n)}`).join(', ')} },
  caps: { ${CAPS.map((n) => `${n}: ${safe(n)}`).join(', ')} },
  ${READS.map((n) => `get ${n}() { return ${safe(n)}; }`).join(',\n  ')},
  ${WRITES.map((n) => `get ${n}() { return ${safe(n)}; }, set ${n}(v) { ${n} = v; }`).join(',\n  ')},
})`;

// A tab recording, armed and running, the way cmd:'start' leaves it.
async function recording(opts = {}) {
  const h = load(opts);
  const res = await h.send('start', { streamId: 'stream-1' });
  assert.deepEqual(res, { ok: true, mimeType: 'video/webm;codecs=vp9' }, 'the fixture should be recording');
  return h;
}

// A cast recording with its canvas built, the way the first screencast frame leaves it.
async function casting(opts = {}) {
  const h = load(opts);
  await h.send('cast-start');
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.equal(h.recorders.length, 1, 'the fixture should have armed on its first frame');
  return h;
}

test('34: a Chrome that supports none of the three codecs leaves the choice to it', () => {
  const h = load({ mimes: [] });
  assert.equal(h.st.fns.pickMime(), '');
  h.st.fns.armRecorder(h.makeStream('s'));
  assert.equal(h.rec().options, undefined, 'no mimeType means no options object at all');
});

test('34b: VP9 is taken where Chrome has it, and VP8 where it only has that', () => {
  assert.equal(load({ mimes: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] }).st.fns.pickMime(),
    'video/webm;codecs=vp9');
  assert.equal(load({ mimes: ['video/webm;codecs=vp8', 'video/webm'] }).st.fns.pickMime(), 'video/webm;codecs=vp8');
  assert.equal(load({ mimes: ['video/webm'] }).st.fns.pickMime(), 'video/webm');
});

test('1: a clock that never started reads zero, not the epoch', () => {
  const h = load();
  assert.equal(h.st.startedAt, 0);
  assert.equal(h.st.fns.elapsedMs(), 0);
});

test('2: a recording that ran ten seconds and never paused reads ten seconds', () => {
  const h = load();
  h.st.startedAt = NOW - 10000;
  assert.equal(h.st.fns.elapsedMs(), 10000);
});

test('3: three seconds spent paused are not three seconds of the tester’s five minutes', () => {
  const h = load();
  h.st.startedAt = NOW - 10000;
  h.st.pausedAt = NOW - 3000;
  assert.equal(h.st.fns.elapsedMs(), 7000);
});

test('4: two pauses and two resumes leave the clock counting only the running time', async () => {
  const h = await recording();
  h.advance(1000);
  await h.send('pause', { on: true });
  h.advance(2000);
  await h.send('pause', { on: false });
  h.advance(1000);
  await h.send('pause', { on: true });
  h.advance(3000);
  await h.send('pause', { on: false });
  h.advance(1000);
  assert.equal(h.st.pausedMs, 5000);
  assert.equal(h.st.fns.elapsedMs(), 3000);
});

test('4b: a clock that was paused longer than it ran reads zero, never a negative length', () => {
  const h = load();
  h.st.startedAt = NOW - 4000;
  h.st.pausedMs = 9000;
  assert.equal(h.st.fns.elapsedMs(), 0);
});

test('5: arming a second recorder clears the interval still ticking on the first', () => {
  const h = load();
  h.st.fns.armRecorder(h.makeStream('a'));
  const first = h.st.capTimer;
  assert.equal(h.timers.cleared.length, 0);
  h.st.fns.armRecorder(h.makeStream('b'));
  assert.deepEqual(h.timers.cleared, [first], 'the first interval must be cleared, not orphaned');
  assert.notEqual(h.st.capTimer, first);
  assert.equal(h.timers.live.size, 1, 'exactly one cap interval may be ticking');
});

test('5b: arming starts the recorder on one-second slices and starts the clock with it', () => {
  const h = load();
  h.st.fns.armRecorder(h.makeStream('a'));
  assert.deepEqual(h.rec().log, [['start', 1000]]);
  assert.equal(h.st.startedAt, NOW);
  assert.deepEqual(h.timers.made, [{ id: 1, ms: 1000 }], 'the cap is ticked every second, not timed out once');
});

test('5c: the mime Chrome negotiated outranks the one we asked for', () => {
  const h = load();
  h.hooks.negotiated = 'video/webm;codecs=vp8';
  assert.equal(h.st.fns.armRecorder(h.makeStream('a')), 'video/webm;codecs=vp8');
});

test('26b: the frame pipe is opened once, under the name the worker looks for', () => {
  const h = load();
  h.st.fns.castConnect();
  h.st.fns.castConnect();
  assert.deepEqual(h.calls.filter((c) => c.name === 'runtime.connect').map((c) => c.arg),
    [{ name: 'screenrec-frames' }]);
  assert.equal(h.ports.length, 1);
});

test('26c: the pipe carries frames and ignores anything else on it', async () => {
  const h = load();
  await h.send('cast-start');
  h.portMsg({ cmd: 'hello' });
  h.portMsg(null);
  await h.flush();
  assert.equal(h.bitmaps.length, 0, 'only cmd:frame is a frame');
  h.frameIn(frame(640, 480));
  await h.flush();
  assert.equal(h.bitmaps.length, 1);
});

test('26d: a pipe the worker dropped is forgotten, and Chrome’s lastError read off with it', async () => {
  const h = load();
  await h.send('cast-start');
  assert.ok(h.st.framePort);
  const before = h.lastErrorReads();
  h.portGone();
  assert.equal(h.st.framePort, null);
  assert.ok(h.lastErrorReads() > before, 'an unread lastError leaks into the next call');
});

// A frame's decode is the pipeline's only await, so one decode at a time is all the chain buys.
test('6: frames arrive faster than they decode, and only one of them is ever decoding', async () => {
  const h = load();
  const gate = [];
  h.hooks.bitmap = (blob) => new Promise((r) => gate.push(() => r(readBitmap(blob))));
  await h.send('cast-start');
  h.frameIn(frame(1280, 720));
  h.frameIn(frame(640, 480));
  h.frameIn(frame(320, 240));
  await h.flush();
  assert.equal(gate.length, 1, 'three frames in one tick must not put three decodes in flight');
  gate[0]();
  await h.flush();
  assert.equal(gate.length, 2, 'the next frame only starts once the one before it is drawn');
  gate[1]();
  await h.flush();
  assert.equal(gate.length, 3);
  gate[2]();
  await h.flush();
  assert.equal(h.st.castFrames, 3);
});

test('6c: the canvas is fixed by the frame that ARRIVED first, not the one that decoded first', async () => {
  const h = load();
  const gate = [];
  h.hooks.bitmap = (blob) => new Promise((r) => gate.push(() => r(readBitmap(blob))));
  await h.send('cast-start');
  h.frameIn(frame(1280, 720));
  h.frameIn(frame(320, 240));
  await h.flush();
  // Answered in reverse: a slow first decode must still be the one the recording's size is built on.
  for (let i = 0; i < 2; i += 1) { [...gate].reverse().forEach((g) => g()); gate.length = 0; await h.flush(); }
  assert.equal(h.canvases.length, 1);
  assert.equal(h.canvases[0].width, 1280, 'a canvas sized by the wrong frame letterboxes the whole take');
  assert.equal(h.canvases[0].height, 720);
  assert.deepEqual(h.ctxOps.filter((o) => o[0] === 'drawImage').map((o) => [o[1], o[2]]),
    [[1280, 720], [320, 240]], 'and the frames reach the video in the order they were sent');
});

test('6b: ten frames in one tick still leave one recorder and one canvas', async () => {
  const h = load();
  await h.send('cast-start');
  for (let i = 0; i < 10; i += 1) h.frameIn(frame(800, 600));
  await h.flush();
  assert.equal(h.recorders.length, 1);
  assert.equal(h.canvases.length, 1);
  assert.equal(h.st.castFrames, 10);
  assert.equal(h.timers.live.size, 1, 'one recording, one cap interval');
});

test('7: a frame that finished decoding after the recording ended arms nothing', async () => {
  const h = load();
  let release;
  h.hooks.bitmap = () => new Promise((r) => { release = () => r({ width: 1280, height: 720, closed: 0, close() { this.closed += 1; } }); });
  await h.send('cast-start');
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.equal(h.recorders.length, 0, 'the decode is still in flight');
  await h.send('stop');           // nothing recorded yet: reset() and a null file
  release();
  await h.flush();
  assert.equal(h.bitmaps.length, 1, 'the frame DID decode — this is the mode check, not a failure');
  assert.equal(h.st.castErr, '');
  assert.equal(h.recorders.length, 0, 'mode is re-checked AFTER the decode');
  assert.equal(h.st.castFrames, 0);
  assert.equal(h.canvases.length, 0);
});

test('8: a frame that arrives while the tester has it paused is dropped before the decode', async () => {
  const h = await casting();
  await h.send('pause', { on: true });
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.equal(h.bitmaps.length, 1, 'the paused frame is not even decoded');
  assert.equal(h.st.castFrames, 1);
});

test('9: a frame whose bytes are not base64 is reported, not thrown, and the pipe survives', async () => {
  const h = await casting();
  h.frameIn('not base64 at all!');
  await h.flush();
  assert.equal(h.st.castErr, 'decode: The string to be decoded is not correctly encoded.');
  assert.equal(h.st.castFrames, 1, 'the bad frame is not counted');
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.equal(h.st.castFrames, 2, 'the chain kept running behind the failure');
  assert.deepEqual(await h.send('state'), {
    ok: true,
    recording: true,
    paused: false,
    ms: 0,
    bytes: 0,
    frames: 2,
    err: 'decode: The string to be decoded is not correctly encoded.',
  });
});

test('10: a later frame of another size is letterboxed onto the canvas the first frame fixed', async () => {
  const h = await casting();
  assert.equal(h.canvases[0].width, 1280);
  assert.equal(h.canvases[0].height, 720);
  h.ctxOps.length = 0;
  h.frameIn(frame(640, 640));
  await h.flush();
  assert.equal(h.canvases[0].width, 1280, 'a mid-stream resize breaks too many players');
  assert.equal(h.canvases[0].height, 720);
  assert.deepEqual(h.ctxOps, [
    ['fillStyle', '#000'],
    ['fillRect', 0, 0, 1280, 720],
    ['drawImage', 640, 640, 280, 0, 720, 720],
  ]);
});

test('10b: a frame of the very same size is drawn straight over, with no black fill', async () => {
  const h = await casting();
  h.ctxOps.length = 0;
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.deepEqual(h.ctxOps, [['drawImage', 1280, 720, 0, 0, 1280, 720]]);
});

test('10c: every drawn frame is pushed to the canvas track and its bitmap released', async () => {
  const h = await casting();
  const track = h.canvases[0].streams[0].tracks[0];
  assert.equal(track.framesRequested, 1);
  h.frameIn(frame(1280, 720));
  await h.flush();
  assert.equal(track.framesRequested, 2, 'a captureStream(0) track only moves when it is asked to');
  // Five minutes at thirty frames a second is nine thousand decoded pictures — every one is let go.
  assert.deepEqual(h.imgs.map((i) => i.closed), [1, 1]);
});

test('10d: a first frame that reports no size at all still gets a 1280x720 canvas', async () => {
  const h = load();
  h.hooks.bitmap = () => ({ width: 0, height: 0, close() {} });
  await h.send('cast-start');
  h.frameIn(frame(0, 0));
  await h.flush();
  assert.equal(h.canvases[0].width, 1280);
  assert.equal(h.canvases[0].height, 720);
});

test('20b: the broadcast fallback feeds the same chain as the pipe', async () => {
  const h = load();
  await h.send('cast-start');
  await h.call({ type: 'SCREENREC_OFF', cmd: 'frame', data: frame(320, 240) }).answer;
  await h.flush();
  assert.equal(h.st.castFrames, 1, 'a frame that beat the connect still lands');
  assert.equal(h.canvases[0].width, 320);
});

test('11: a take that crosses fifty megabytes ends itself and pushes the file over', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(SIZE_CAP, 1);
  await h.flush();
  assert.deepEqual(h.rec().log, [['start', 1000], ['stop']]);
  assert.equal(h.files().length, 1);
  assert.equal(h.files()[0].reason, 'size');
  assert.equal(h.st.mode, null, 'the recording is over');
});

test('11b: a take one byte short of the cap keeps recording', async () => {
  const h = await recording();
  h.rec().emit(SIZE_CAP - 1, 1);
  await h.flush();
  assert.deepEqual(h.rec().log, [['start', 1000]]);
  assert.equal(h.files().length, 0);
  assert.equal(h.st.bytes, SIZE_CAP - 1);
});

test('18: the cap is checked AFTER the chunk lands, so a take ends one second over fifty megabytes', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(SIZE_CAP - 1, 1);
  h.rec().emit(4096, 2);           // one more second of video
  await h.flush();
  assert.equal(h.files()[0].size, SIZE_CAP - 1 + 4096, 'the panel’s "50 MB" is a floor, not a ceiling');
});

test('19: the five-minute cap fires on the tick that reaches it, not the one before', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(1024, 1);
  h.advance(TIME_CAP - 1);
  h.timers.tick();
  await h.flush();
  assert.equal(h.files().length, 0, 'one millisecond short is short');
  h.advance(1);
  h.timers.tick();
  await h.flush();
  assert.equal(h.files().length, 1);
  assert.equal(h.files()[0].reason, 'time');
  assert.equal(h.files()[0].ms, TIME_CAP);
});

test('19b: a recording left paused past the five minutes is never cut off by the clock', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(1024, 1);
  h.advance(1000);
  await h.send('pause', { on: true });
  h.advance(TIME_CAP * 2);
  h.timers.tick(3);
  await h.flush();
  assert.equal(h.files().length, 0, 'a pause does not spend the tester’s five minutes');
  assert.equal(h.rec().log.filter((c) => c[0] === 'stop').length, 0);
});

test('19c: the cap interval dies with the recording it was watching', async () => {
  const h = await recording();
  const id = h.st.capTimer;
  h.rec().emit(1024, 1);
  await h.send('stop');
  await h.flush();
  assert.deepEqual(h.timers.cleared, [id]);
  assert.equal(h.timers.live.size, 0, 'an interval outliving its take keeps calling finish forever');
});

test('17: the finished file carries the URL, the size, the length at entry and the reason', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  h.advance(8000);
  const answer = h.send('stop', { reason: 'user' });
  h.advance(5000);                 // the stop takes a moment; the length is the one at entry
  await h.flush();
  assert.deepEqual(await answer, { ok: true, file: { url: 'blob:take-1', size: 4096, ms: 8000, reason: 'user' } });
  assert.deepEqual(h.urls, [{ url: 'blob:take-1', size: 4096, type: 'video/webm', head: null }]);
  assert.deepEqual(h.patches, [{ ms: 8000, size: 4096 }]);
});

test('17b: the reason the worker stopped for reaches the file, and a bare stop is the tester’s own', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  // The worker parks the take under the file's reason, so dropping it would mislabel every stop.
  assert.equal((await h.send('stop', { reason: 'tab-gone' })).file.reason, 'tab-gone');

  const g = await recording();
  g.hooks.finalChunk = 0;
  g.rec().emit(4096, 1);
  assert.equal((await g.send('stop')).file.reason, 'user');
});

test('17c: the state is wiped BEFORE the file is handed back, never after', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  const file = await h.st.fns.finish('user');
  assert.ok(file.url);
  assert.equal(h.st.rec, null);
  assert.equal(h.st.mode, null);
  assert.equal(h.st.bytes, 0);
  assert.equal(h.st.finishing, null, 'a finishing that outlived its take would swallow the next one');
});

test('17d: the chunks reach the file in the order MediaRecorder handed them over', async () => {
  const h = await recording({ webm: 'grow' });
  h.hooks.finalChunk = 0;
  h.rec().emit(10, 1);
  h.rec().emit(20, 2);
  h.rec().emit(30, 3);
  const file = await h.st.fns.finish('user');
  assert.equal(file.size, 61, 'the patched bytes are what the take is wrapped around, not the raw ones');
  assert.deepEqual(h.patches, [{ ms: 0, size: 60 }]);
});

test('14: a cast stopped before its first frame hands nothing over and only drops its state', async () => {
  const h = load();
  await h.send('cast-start');
  assert.equal(h.st.mode, 'cast');
  assert.deepEqual(await h.send('stop', { reason: 'user' }), { ok: true, file: null });
  await h.flush();
  assert.equal(h.st.mode, null);
  assert.equal(h.st.framePort, null);
  assert.deepEqual(h.files(), [], 'there is nothing to park; the worker broadcasts an empty ending');
  assert.deepEqual(h.urls, []);
});

test('15: a recorder Chrome refuses to stop still hands the take over', async () => {
  const h = await recording();
  h.rec().emit(4096, 1);
  h.hooks.stopThrows = true;
  const file = await h.st.fns.finish('user');
  assert.equal(file.size, 4096, 'the take is never stranded because stop() threw');
  assert.equal(h.st.finishing, null);
});

test('16: a take the duration patcher chokes on is handed over raw', async () => {
  const h = await recording({ webm: 'throws' });
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  const file = await h.st.fns.finish('user');
  assert.equal(file.size, 4096, 'a take that plays without a scrubber beats one that does not play');
  assert.equal(h.patches.length, 1);
});

test('16b: the real duration patcher writes into the take, and its length is the one measured', async () => {
  const h = await recording({ webm: 'real' });
  h.hooks.finalChunk = 0;
  // An unknown-size Segment with TimecodeScale and no Duration — what a streamed take looks like.
  const take = new Uint8Array([
    0x18, 0x53, 0x80, 0x67, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40,
  ]);
  h.rec().ondataavailable({ data: new FakeBlob([take]) });
  h.advance(4000);
  const file = await h.st.fns.finish('user');
  assert.equal(file.size, take.length - 1 + 8 + 11, 'Info grew by a Duration and an 8-byte size vint');
});

test('12a: finish is ONE promise per take — a second caller gets the first one back', async () => {
  const h = await recording();
  h.rec().emit(4096, 1);
  const a = h.st.fns.finish('size');
  const b = h.st.fns.finish('time');
  assert.equal(a, b, 'two callers must not stop the recorder twice or mint two URLs');
  const [fa, fb] = await Promise.all([a, b]);
  assert.equal(fa, fb);
  assert.equal(fa.reason, 'size', 'the first reason is the take’s reason');
  await h.flush();
  assert.equal(h.rec().log.filter((c) => c[0] === 'stop').length, 1);
  assert.equal(h.urls.length, 1);
});

test('12b: the memo is dropped once the take is handed over, so nothing later is swallowed', async () => {
  const h = await recording();
  h.rec().emit(4096, 1);
  await h.st.fns.finish('user');
  assert.equal(h.st.finishing, null);
  assert.equal(await h.st.fns.finish('user'), null, 'nothing is recording any more');
  assert.equal(h.urls.length, 1);
});

// The flushed chunk lands while `finishing` stands: guard the cap, not the dataavailable handler.
test('12 (#206): a take that ends on the size cap reaches the worker exactly once', async () => {
  const h = await recording();
  h.hooks.finalChunk = 2048;
  h.rec().emit(SIZE_CAP, 1);
  await h.flush();
  assert.equal(h.files().length, 1);
  assert.equal(h.urls.length, 1, 'one URL, and no second delivery for the worker to revoke it over');
});

// That last dataavailable carries the take's tail: returning early on `finishing` would truncate it.
test('12f (#206): the chunk rec.stop() flushes is still part of the take handed over', async () => {
  const h = await recording();
  h.hooks.finalChunk = 2048;
  h.rec().emit(SIZE_CAP, 1);
  await h.flush();
  assert.deepEqual(h.files(), [{ url: 'blob:take-1', size: SIZE_CAP + 2048, ms: 0, reason: 'size' }]);
  assert.equal(h.patches.at(-1).size, SIZE_CAP + 2048, 'the tail reached the blob, not just the count');
});

test('12e (#206): the five-minute cap reaches the worker exactly once', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(1024, 1);
  h.advance(TIME_CAP);
  h.timers.tick();
  h.timers.tick();
  await h.flush();
  assert.equal(h.files().length, 1);
});

test('12g (#206): a Stop whose flushed tail crosses the cap is answered, never also pushed', async () => {
  const h = await recording();
  h.hooks.finalChunk = 2048;
  h.rec().emit(SIZE_CAP - 1024, 1);
  const answer = h.send('stop', { reason: 'user' });
  await h.flush();
  assert.equal((await answer).file.size, SIZE_CAP - 1024 + 2048, 'the tail is in the answered take');
  assert.deepEqual(h.files(), [], 'one door per stop; the cap does not open a second one');
});

// One take, two srecFinish calls: the second would revoke the URL the first parked.
test('13: a stop the worker asked for is ANSWERED, never also pushed', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  const answered = (await h.send('stop', { reason: 'user' })).file;
  await h.flush();
  assert.equal(answered.url, 'blob:take-1');
  assert.deepEqual(h.files(), [], 'one door per stop; the push is for takes that ended on their own');
});

test('32: a tab that closes under the recording keeps what was recorded and pushes it over', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  h.st.stream.tracks[0].fire('ended');
  await h.flush();
  assert.deepEqual(h.files(), [{ url: 'blob:take-1', size: 4096, ms: 0, reason: 'tab-gone' }]);
});

test('32b (#206): a closed tab whose flushed tail crosses the cap still pushes once', async () => {
  const h = await recording();
  h.hooks.finalChunk = 2048;
  h.rec().emit(SIZE_CAP - 1024, 1);
  h.st.stream.tracks[0].fire('ended');
  await h.flush();
  assert.deepEqual(h.files(), [{ url: 'blob:take-1', size: SIZE_CAP - 1024 + 2048, ms: 0, reason: 'tab-gone' }]);
});

// Both doors get the same take by contract; the worker tells them apart by comparing the url.
test('13b: one memoised finish, so both doors are handed the SAME take and one url', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  h.st.stream.tracks[0].fire('ended');       // door one: the push
  const answer = h.send('stop', { reason: 'tab-gone' });  // door two: the answer
  await h.flush();
  const answered = (await answer).file;
  assert.deepEqual(h.files(), [answered], 'the same file object, not a second take');
  assert.equal(h.urls.length, 1, 'and one url — which is why the worker can recognise it');
});

test('11c: a worker asleep when the file is pushed does not take the recorder page down with it', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.hooks.sendFails = true;
  h.rec().emit(SIZE_CAP, 1);
  await h.flush();
  assert.equal(h.sent.length, 1, 'the rejection is swallowed, not thrown at the page');
  assert.equal(h.st.mode, null);
});

test('11d: an empty chunk is not a chunk — it neither counts nor ends the take', async () => {
  const h = await recording();
  h.rec().emit(0);
  h.rec().ondataavailable({ data: null });
  assert.equal(h.st.bytes, 0);
  assert.equal(h.st.chunks.length, 0);
  assert.deepEqual(h.rec().log, [['start', 1000]]);
});

test('20: reset drops every field, stops every track and hangs the frame pipe up', async () => {
  const h = load();
  h.hooks.getUserMedia = async () => h.makeStream('tab', ['video', 'audio']);
  await h.send('cast-start');                 // opens the pipe
  const port = h.port();
  await h.send('start', { streamId: 's-1' }); // reset() runs first thing in start()
  h.rec().emit(4096, 1);
  h.advance(1000);
  await h.send('pause', { on: true });
  const timer = h.st.capTimer;
  const stream = h.st.stream;

  h.st.fns.reset();

  assert.equal(port.disconnects, 1, 'a port outliving its recording holds the worker awake');
  assert.deepEqual(h.timers.cleared.slice(-1), [timer]);
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1], 'every track, not just the video one');
  for (const field of ['rec', 'mode', 'stream', 'castCanvas', 'castTrack', 'framePort', 'capTimer']) {
    assert.equal(h.st[field], null, `${field} should be null`);
  }
  assert.deepEqual(plain(h.st.chunks), []);
  for (const field of ['bytes', 'castFrames', 'startedAt', 'pausedAt', 'pausedMs']) {
    assert.equal(h.st[field], 0, `${field} should be 0`);
  }
  assert.equal(h.st.castErr, '');
});

test('20c: a pipe whose other end is already gone does not take reset down with it', async () => {
  const h = load();
  await h.send('cast-start');
  h.hooks.disconnectThrows = true;
  h.st.fns.reset();
  assert.equal(h.st.framePort, null);
});

test('20d: reset on a page that never recorded anything is harmless', () => {
  const h = load();
  h.st.fns.reset();
  assert.equal(h.st.rec, null);
  assert.deepEqual(h.timers.cleared, []);
});

test('21: pausing a running recording stops the recorder and stops the clock', async () => {
  const h = await recording();
  h.advance(2000);
  assert.deepEqual(await h.send('pause', { on: true }), { ok: true, paused: true });
  assert.deepEqual(h.rec().log, [['start', 1000], ['pause']]);
  assert.equal(h.st.pausedAt, NOW + 2000);
});

test('21b: a second Pause on an already paused recording changes nothing', async () => {
  const h = await recording();
  h.advance(2000);
  await h.send('pause', { on: true });
  h.advance(3000);
  assert.deepEqual(await h.send('pause', { on: true }), { ok: true, paused: true });
  assert.equal(h.st.pausedAt, NOW + 2000, 'the pause must not restart at the second press');
  assert.deepEqual(h.rec().log, [['start', 1000], ['pause']]);
});

test('22: a cast paused before its first frame keeps the flag alone and does not crash', async () => {
  const h = load();
  await h.send('cast-start');
  assert.equal(h.st.rec, null);
  assert.deepEqual(await h.send('pause', { on: true }), { ok: true, paused: true });
  assert.equal(h.st.pausedAt, NOW);
});

test('23: resuming adds the paused span to the budget and starts the recorder again', async () => {
  const h = await recording();
  h.advance(2000);
  await h.send('pause', { on: true });
  h.advance(3000);
  assert.deepEqual(await h.send('pause', { on: false }), { ok: true, paused: false });
  assert.equal(h.st.pausedMs, 3000);
  assert.equal(h.st.pausedAt, 0);
  assert.deepEqual(h.rec().log, [['start', 1000], ['pause'], ['resume']]);
});

test('24: a Resume on a recording that was never paused is a no-op', async () => {
  const h = await recording();
  h.advance(2000);
  assert.deepEqual(await h.send('pause', { on: false }), { ok: true, paused: false });
  assert.equal(h.st.pausedMs, 0);
  assert.deepEqual(h.rec().log, [['start', 1000]]);
});

test('23b: a cast resumed before its first frame does not call resume on a recorder that is not there', async () => {
  const h = load();
  await h.send('cast-start');
  await h.send('pause', { on: true });
  h.advance(1500);
  await h.send('pause', { on: false });
  assert.equal(h.st.pausedMs, 1500);
  assert.equal(h.recorders.length, 0);
});

test('25: a cast that has not seen a frame yet still answers "recording"', async () => {
  const h = load();
  await h.send('cast-start');
  assert.deepEqual(await h.send('state'), {
    ok: true, recording: true, paused: false, ms: 0, bytes: 0, frames: 0, err: '',
  });
  assert.equal(h.st.rec, null, 'the answer is about the SESSION, not about the recorder object');
});

test('25b: a running take reports its clock, its bytes and its frames', async () => {
  const h = await casting();
  h.rec().emit(4096, 1);
  h.advance(7000);
  await h.send('pause', { on: true });
  h.advance(3000);
  assert.deepEqual(await h.send('state'), {
    ok: true, recording: true, paused: true, ms: 7000, bytes: 4096, frames: 1, err: '',
  });
});

test('25c: a page with nothing recording says so', async () => {
  const h = load();
  assert.deepEqual(await h.send('state'), {
    ok: true, recording: false, paused: false, ms: 0, bytes: 0, frames: 0, err: '',
  });
});

test('26: cast-start wipes what was there, opens the pipe, and only then calls itself recording', async () => {
  const h = await recording();
  h.rec().emit(4096, 1);
  const firstStream = h.st.stream;
  assert.deepEqual(await h.send('cast-start'), { ok: true });
  assert.equal(firstStream.tracks[0].stopped, 1, 'the tab stream is let go before the cast begins');
  assert.equal(h.st.bytes, 0);
  assert.equal(h.st.mode, 'cast');
  assert.ok(h.st.framePort, 'the pipe is open by the time mode says cast');
  assert.equal(h.ports.length, 1);
});

test('26e: casting twice hangs the first pipe up before opening the second', async () => {
  const h = load();
  await h.send('cast-start');
  await h.send('cast-start');
  assert.equal(h.ports.length, 2);
  assert.equal(h.port(0).disconnects, 1);
  assert.equal(h.port(1).disconnects, 0);
});

test('31: a Chrome that refuses the tab capture is reported, not thrown', async () => {
  const h = load();
  h.hooks.getUserMedia = async () => { throw new Error('Error starting tab capture'); };
  assert.deepEqual(await h.send('start', { streamId: 's-1' }),
    { ok: false, error: 'Error starting tab capture' });
  assert.equal(h.st.mode, null);
  assert.equal(h.recorders.length, 0);
});

test('31b: start asks Chrome for the tab it was handed, with no audio', async () => {
  const h = await recording();
  assert.deepEqual(h.calls.filter((c) => c.name === 'getUserMedia').map((c) => c.arg), [{
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-1' } },
  }]);
  assert.equal(h.st.mode, 'tab');
});

test('30: revoking a URL that was never ours is swallowed and still answered', async () => {
  const h = load();
  h.hooks.revokeThrows = () => true;
  assert.deepEqual(await h.send('revoke', { url: 'blob:someone-else' }), { ok: true });
  assert.deepEqual(h.revoked, []);
});

test('30b: revoking a take the worker refused to park lets its bytes go', async () => {
  const h = load();
  assert.deepEqual(await h.send('revoke', { url: 'blob:take-1' }), { ok: true });
  assert.deepEqual(h.revoked, ['blob:take-1']);
});

test('33: a cmd the page does not know is left unanswered, so the worker reads null', () => {
  const h = load();
  const { ret } = h.call({ type: 'SCREENREC_OFF', cmd: 'teleport' });
  assert.equal(ret, undefined, 'answering would make the worker believe the page understood');
});

test('33b: a message that is not ours is left alone even when it carries a cmd we know', async () => {
  const h = await recording();
  h.rec().emit(4096, 1);
  assert.equal(h.call({ type: 'SCREENREC_EVENT', event: 'review' }).ret, undefined);
  assert.equal(h.call({ type: 'SCREENREC_FILE', cmd: 'stop', reason: 'user' }).ret, undefined);
  assert.equal(h.call(null).ret, undefined);
  await h.flush();
  assert.deepEqual(h.rec().log, [['start', 1000]], 'another channel’s traffic must not stop the take');
});

test('33c: every synchronous cmd answers before it returns, and only start and stop keep the port open', async () => {
  const h = await recording();
  h.hooks.finalChunk = 0;
  h.rec().emit(4096, 1);
  for (const cmd of ['trim-begin', 'trim-chunk', 'trim-swap', 'revoke', 'cast-start', 'frame', 'pause', 'state']) {
    const arg = cmd === 'trim-chunk' ? { b64: '' } : {};
    assert.equal(h.call({ type: 'SCREENREC_OFF', cmd, ...arg }).ret, false, `${cmd} should answer synchronously`);
  }
  assert.equal(h.call({ type: 'SCREENREC_OFF', cmd: 'start', streamId: 's' }).ret, true);
  assert.equal(h.call({ type: 'SCREENREC_OFF', cmd: 'stop' }).ret, true);
  await h.flush();
});

test('27: three streamed parts come back as one take, patched, with the old URL revoked', async () => {
  const h = load({ webm: 'grow' });
  const parts = ['AAECAwQF', 'BgcICQoL', 'DA0ODxAR'];   // 6 bytes each, in order
  assert.deepEqual(await h.send('trim-begin'), { ok: true });
  for (const b64 of parts) assert.deepEqual(await h.send('trim-chunk', { b64 }), { ok: true });
  assert.deepEqual(await h.send('trim-swap', { oldUrl: 'blob:original', ms: 4200 }),
    { ok: true, url: 'blob:take-1', size: 19 });
  assert.deepEqual(h.patches, [{ ms: 4200, size: 18 }]);
  assert.deepEqual(h.revoked, ['blob:original'], 'the untrimmed take dies with the swap');
  assert.deepEqual(plain(h.st.trimParts), [], 'the parts are let go the moment they are merged');
});

test('27b: the parts are concatenated in the order they were streamed, byte for byte', async () => {
  const h = load();
  await h.send('trim-begin');
  await h.send('trim-chunk', { b64: Buffer.from([1, 2, 3]).toString('base64') });
  await h.send('trim-chunk', { b64: Buffer.from([4, 5, 6]).toString('base64') });
  assert.deepEqual(plain(h.st.trimParts), [{ 0: 1, 1: 2, 2: 3 }, { 0: 4, 1: 5, 2: 6 }]);
  await h.send('trim-swap', { oldUrl: '', ms: 0 });
  // A cut reassembled out of order is a file no player opens — read the take's own bytes back.
  assert.deepEqual(h.urls, [{ url: 'blob:take-1', size: 6, type: 'video/webm', head: [1, 2, 3, 4, 5, 6] }]);
});

test('27c: a swap with no old URL to replace revokes nothing', async () => {
  const h = load();
  await h.send('trim-begin');
  await h.send('trim-chunk', { b64: 'AAEC' });
  await h.send('trim-swap', { ms: 1000 });
  assert.deepEqual(h.revoked, []);
});

test('27d: a swap whose patch throws still hands the raw cut back', async () => {
  const h = load({ webm: 'throws' });
  await h.send('trim-begin');
  await h.send('trim-chunk', { b64: 'AAECAwQF' });
  assert.deepEqual(await h.send('trim-swap', { oldUrl: 'blob:original', ms: 1000 }),
    { ok: true, url: 'blob:take-1', size: 6 });
});

// Only the review guards a swap with no chunks, so here it mints a real URL over an empty file.
test('28: a swap with nothing streamed to it answers with a valid URL over a 0-byte take', async () => {
  const h = load();
  assert.deepEqual(await h.send('trim-swap', { oldUrl: 'blob:original', ms: 1000 }),
    { ok: true, url: 'blob:take-1', size: 0 });
  assert.deepEqual(h.revoked, ['blob:original'], 'and the original is gone either way');
});

test('29: a trim that is begun and abandoned holds a whole copy of the export until the next one', async () => {
  const h = load();
  await h.send('trim-begin');
  for (const b64 of ['AAECAwQF', 'BgcICQoL', 'DA0ODxAR']) await h.send('trim-chunk', { b64 });
  assert.equal(h.st.trimParts.length, 3, 'the tester closed the review; the bytes stay');
  await h.send('trim-begin');
  assert.equal(h.st.trimParts.length, 0, 'only the next begin lets them go');
});

// ---- the caps as the panel quotes them --------------------------------------------

test('the two caps are the numbers the panel tells the tester', () => {
  const h = load();
  assert.deepEqual(plain(h.st.caps), { REC_TIME_CAP_MS: TIME_CAP, REC_SIZE_CAP: SIZE_CAP, REC_CHUNK_MS: 1000 });
});
