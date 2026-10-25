import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { inspectRawDepth, normalizeBackend, selectGeometryBackend, validateGeometryStats } from './geometry-contract.js';

test('backend policy stays fast by default and is explicit about M5 quality backends', () => {
  assert.equal(selectGeometryBackend(), 'depth-anything-v2');
  assert.equal(selectGeometryBackend({ highQuality: true, m5Available: true }), 'external');
  assert.equal(normalizeBackend('not-a-model'), 'depth-anything-v2');
  assert.equal(normalizeBackend('moge'), 'moge');
});

test('depth inspection is finite and deterministic for every finite generated map', () => {
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 18 }), fc.integer({ min: 2, max: 18 }),
    fc.array(fc.float({ min: -100, max: 100, noNaN: true }), { minLength: 4, maxLength: 324 }),
    (width, height, values) => {
      const data = Float32Array.from({ length: width * height }, (_, i) => values[i % values.length]);
      const stats = inspectRawDepth({ width, height, data });
      assert.equal(stats.finiteRatio, 1);
      assert.ok(Number.isFinite(stats.range));
      assert.deepEqual(stats, inspectRawDepth({ width, height, data }));
    },
  ));
});

test('invalid depth results never pass the geometry gate', () => {
  assert.equal(validateGeometryStats({ width: 10, height: 10, min: 1, max: 1, range: 0, mean: 1, finiteRatio: 1, variance: 0 }), 'depth has no usable variation');
  assert.equal(validateGeometryStats({ width: 10, height: 10, min: 0, max: 1, range: 1, mean: 0.5, finiteRatio: 0.2, variance: 1 }), 'depth contains too many non-finite values');
});

