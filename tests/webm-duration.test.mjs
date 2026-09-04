#!/usr/bin/env node
// #152: the tester stops a screen recording and scrubs it. extension/shared/webm-duration.js writes
// the length into the finished file so the scrubber can move — and hands the bytes back untouched
// whenever the file is not shaped the way it expects, rather than corrupting a five-minute take.
// Run: node --test tests/webm-duration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { sharedPath, sourceOf } from './helpers/shared-harness.mjs';

// The file needs no globals at all, not even URL; its top-level `const` is the completion value.
const source = sourceOf(sharedPath('shared/webm-duration.js'));
const WebmDuration = runInNewContext(`${source}\nWebmDuration;`, {});

// The EBML pieces every fixture is built from. Each byte string was produced by running the module.
const HDR       = [0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x00, 0x00, 0x00, 0x00]; // EBML header, 4-byte body
const SEG_U     = [0x18, 0x53, 0x80, 0x67, 0xFF];                         // Segment, UNKNOWN size
const SEG_D     = [0x18, 0x53, 0x80, 0x67, 0x8C];                         // Segment, definite (12)
const TCS       = [0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40];             // TimecodeScale 1 000 000
const TCS_100K  = [0x2A, 0xD7, 0xB1, 0x83, 0x01, 0x86, 0xA0];             // TimecodeScale   100 000
const CLUSTER   = [0x1F, 0x43, 0xB6, 0x75, 0x80];                         // an empty Cluster
const CLUSTER_U = [0x1F, 0x43, 0xB6, 0x75, 0xFF];                         // a Cluster of UNKNOWN size
const INFO = (sizeByte) => [0x15, 0x49, 0xA9, 0x66, sizeByte];            // Info, 1-byte size vint
const INFO8 = (n) => [0x15, 0x49, 0xA9, 0x66, 0x01, 0, 0, 0, 0, 0, 0, n]; // Info, 8-byte size vint
const DUR8_4000  = [0x44, 0x89, 0x88, 0x40, 0xAF, 0x40, 0, 0, 0, 0, 0];   // f64(4000)
const DUR8_40000 = [0x44, 0x89, 0x88, 0x40, 0xE3, 0x88, 0, 0, 0, 0, 0];   // f64(40000)
const DUR8_ZERO  = [0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];            // reserved, unwritten
const DUR4_ZERO  = [0x44, 0x89, 0x84, 0, 0, 0, 0];                        // a float32 Duration
const DUR0       = [0x44, 0x89, 0x80];                                    // a zero-width Duration

// A live MediaRecorder take: unknown-size Segment, an Info with a scale and no Duration.
const STREAMED = [...HDR, ...SEG_U, ...INFO(0x87), ...TCS, ...CLUSTER];
// …and what the module makes of it: the Info size re-encoded to 8 bytes, Duration before the Cluster.
const PATCHED = [...HDR, ...SEG_U, ...INFO8(0x12), ...TCS, ...DUR8_4000, ...CLUSTER];

// patch() returns a vm-realm Uint8Array: deepEqual fails on prototype identity, so compare numbers.
const bytes = (arr) => new Uint8Array(arr);
const out = (arr, ms) => [...WebmDuration.patch(bytes(arr), ms)];

// Never assert "unchanged" alone — a dead call returns its input too. Every such row is paired with
// this one, which proves the same fixture family DOES get patched.
test('W0: the take a MediaRecorder streams comes back with a duration written into it', () => {
  assert.deepEqual(out(STREAMED, 4000), PATCHED);
  assert.notDeepEqual(out(STREAMED, 4000), STREAMED);
});

test('W1: the finished recording grows by the eleven bytes that say how long it is', () => {
  const patched = WebmDuration.patch(bytes(STREAMED), 4000);
  assert.equal(STREAMED.length, 31);
  assert.equal(patched.length, 49);
  assert.deepEqual([...patched], PATCHED);
});

test('W2: a take of zero milliseconds is handed back exactly as it came in', () => {
  assert.deepEqual(out(STREAMED, 0), STREAMED);
  assert.notDeepEqual(out(STREAMED, 4000), STREAMED); // the same fixture does patch
});

test('W3: a negative length is refused and nothing is rewritten', () => {
  assert.deepEqual(out(STREAMED, -1), STREAMED);
});

test('W4: a length that is not a number is refused, but the string "4000" is taken as 4000', () => {
  assert.deepEqual(out(STREAMED, NaN), STREAMED);
  assert.deepEqual(out(STREAMED, undefined), STREAMED);
  // `'4000' > 0` is true, so a caller that hands over a string still gets a patched file.
  assert.deepEqual(out(STREAMED, '4000'), PATCHED);
});

test('W5: a recording some other muxer wrote with a stated size is left alone', () => {
  const definite = [...HDR, ...SEG_D, ...INFO(0x87), ...TCS, ...CLUSTER];
  assert.deepEqual(out(definite, 4000), definite);
  assert.notDeepEqual(out(STREAMED, 4000), STREAMED); // the unknown-size sibling is patched
});

test('W6: a duration slot already reserved in the file is filled in where it stands', () => {
  const reserved = [...HDR, ...SEG_U, ...INFO(0x92), ...TCS, ...DUR8_ZERO, ...CLUSTER];
  const patched = WebmDuration.patch(bytes(reserved), 4000);
  assert.equal(patched.length, reserved.length); // 42 in, 42 out — nothing re-encoded
  assert.deepEqual([...patched], [...HDR, ...SEG_U, ...INFO(0x92), ...TCS, ...DUR8_4000, ...CLUSTER]);
});

test('W7: a duration written as a four-byte float is not touched at all', () => {
  const float32 = [...HDR, ...SEG_U, ...INFO(0x8E), ...TCS, ...DUR4_ZERO, ...CLUSTER];
  assert.equal(float32.length, 38);
  assert.deepEqual(out(float32, 4000), float32);
  // The eight-byte sibling of the same file IS filled in, so this is a width decision, not silence.
  const float64 = [...HDR, ...SEG_U, ...INFO(0x92), ...TCS, ...DUR8_ZERO, ...CLUSTER];
  assert.notDeepEqual(out(float64, 4000), float64);
});

test('W8: an Info whose size is already eight bytes wide is re-encoded the same way', () => {
  const wide = [...HDR, ...SEG_U, ...INFO8(0x07), ...TCS, ...CLUSTER];
  assert.equal(wide.length, 38);
  assert.deepEqual(out(wide, 4000), PATCHED); // 49 bytes, byte for byte the ordinary result
});

test('W9: an Info with nothing in it still gets a duration, counted in the default scale', () => {
  const empty = [...HDR, ...SEG_U, ...INFO(0x80), ...CLUSTER];
  assert.equal(empty.length, 24);
  assert.deepEqual(out(empty, 4000), [...HDR, ...SEG_U, ...INFO8(0x0B), ...DUR8_4000, ...CLUSTER]);
});

test('W10: a file that counts in tenths of a millisecond gets ten times the number', () => {
  const fine = [...HDR, ...SEG_U, ...INFO(0x87), ...TCS_100K, ...CLUSTER];
  assert.deepEqual(out(fine, 4000),
    [...HDR, ...SEG_U, ...INFO8(0x12), ...TCS_100K, ...DUR8_40000, ...CLUSTER]);
});

test('W11: a file with no recording section in it is handed straight back', () => {
  assert.deepEqual(out(HDR, 4000), HDR);
});

test('W12: a recording section with no header block inside it is handed straight back', () => {
  const noInfo = [...HDR, ...SEG_U, ...CLUSTER];
  assert.deepEqual(out(noInfo, 4000), noInfo);
});

test('W13: a stream whose first chunk has no stated size stops the walk cold', () => {
  const openCluster = [...HDR, ...SEG_U, ...CLUSTER_U, ...INFO(0x87), ...TCS];
  assert.deepEqual(out(openCluster, 4000), openCluster);
});

test('W14: a header block that claims more bytes than the file holds changes nothing', () => {
  const overlong = [...HDR, ...SEG_U, ...INFO(0x9F), ...TCS]; // Info claims 31 bytes, 7 exist
  assert.deepEqual(out(overlong, 4000), overlong);
});

test('W15: an empty recording comes back empty rather than throwing', () => {
  assert.deepEqual(out([], 4000), []);
});

test('W16: bytes that are not a WebM file at all come back untouched', () => {
  assert.deepEqual(out([0x00, 0x00, 0x00], 4000), [0x00, 0x00, 0x00]);
});

test('W17: the recorder may hand over a buffer or a view and gets the same file back', () => {
  const view = bytes(STREAMED);
  const fromBuffer = WebmDuration.patch(view.buffer, 4000);
  const fromView = WebmDuration.patch(bytes(STREAMED), 4000);
  assert.deepEqual([...fromBuffer], PATCHED);
  assert.deepEqual([...fromView], PATCHED);
});

test('W18: an untouched result shares the caller\'s buffer, so writing to it writes to the input', () => {
  const a = bytes(HDR);
  const result = WebmDuration.patch(a.buffer, 4000); // unchanged: no Segment
  result[0] = 0x99;
  assert.equal(a[0], 0x99); // the return is a view over the caller's bytes, not a copy
  // Handing over the VIEW instead copies, so the same caller is safe that way round.
  const b = bytes(HDR);
  WebmDuration.patch(b, 4000)[0] = 0x99;
  assert.equal(b[0], 0x1A);
});

test('W19: a duration element with no bytes in its body is left as it is', () => {
  const zeroWidth = [...HDR, ...SEG_U, ...INFO(0x8A), ...TCS, ...DUR0, ...CLUSTER];
  assert.deepEqual(out(zeroWidth, 4000), zeroWidth);
});

test('W20: a header block sitting after the first chunk of video is still found', () => {
  const late = [...HDR, ...SEG_U, ...CLUSTER, ...INFO(0x87), ...TCS];
  assert.deepEqual(out(late, 4000),
    [...HDR, ...SEG_U, ...CLUSTER, ...INFO8(0x12), ...TCS, ...DUR8_4000]);
});
