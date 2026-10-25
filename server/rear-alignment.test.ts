import test from 'node:test';
import assert from 'node:assert/strict';
import { alignRearTexture, warpRearPixels } from './rear-alignment.js';
import sharp from 'sharp';
import type { SegmentedMask } from './world-completion.js';

test('rear body registration moves inferred head and clothing pixels into the source silhouette without sampling its background', () => {
  const width = 24, height = 24;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set([20, 140, 30], i * 3); // Green foliage around the inferred body.
  const generated = new Uint8Array(width * height), target = new Uint8Array(width * height);
  for (let y = 2; y < 22; y++) for (let x = 15; x < 20; x++) {
    generated[y * width + x] = 255;
    rgb.set(y < 8 ? [40, 25, 15] : [210, 120, 170], (y * width + x) * 3);
  }
  for (let y = 4; y < 24; y++) for (let x = 3; x < 9; x++) target[y * width + x] = 255;
  const result = warpRearPixels(rgb, width, height,
    [{ mask: target, kind: 'person', box: [4 / 24, 3 / 24, 1, 9 / 24] }],
    [{ mask: generated, kind: 'person', box: [2 / 24, 15 / 24, 22 / 24, 20 / 24] }], width, height);
  assert.equal(result.matches, 1);
  const pixel = (x: number, y: number) => [...result.pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
  assert.deepEqual(pixel(5, 5), [40, 25, 15]);
  assert.deepEqual(pixel(5, 16), [210, 120, 170]);
  assert.deepEqual(pixel(0, 0), [20, 140, 30]);
});

test('one inferred person cannot be assigned to two source people', () => {
  const mask = new Uint8Array(16).fill(255), rgb = new Uint8Array(48).fill(100);
  const shape = { mask, kind: 'person', box: [0, 0, 1, 1] as [number, number, number, number] };
  assert.equal(warpRearPixels(rgb, 4, 4, [shape, shape], [shape], 4, 4).matches, 1);
});

test('ambiguous inferred instance counts preserve the original rear photograph without warping or recompression', async () => {
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#c08050' } }).png().toBuffer();
  const person: SegmentedMask = { subject: { label: 'person', kind: 'person', box_2d: [0, 0, 1000, 1000], polygon: [] }, mask: new Uint8Array(256).fill(255) };
  const object: SegmentedMask = { ...person, subject: { ...person.subject, label: 'chair', kind: 'object' } };
  for (const targets of [[person], [person, object]]) {
    const result = await alignRearTexture(image, targets, 16, 16, async () => [person, person]);
    assert.equal(result.matches, 0); assert.equal(result.detected, 2);
    assert.equal(result.image, image);
  }
});
