import assert from 'node:assert/strict';
import test from 'node:test';
import { createDepthGeometry } from './reconstruction.js';

function pixels(width: number, values: number[]) {
  return { width, height: values.length / width, data: values.flatMap(v => [v, v, v, 255]) };
}

test('estimated foreground and background occupy different depths', () => {
  const geometry = createDepthGeometry(pixels(2, [255, 0, 255, 0]), { near: 2, far: 12 });
  assert.deepEqual(Array.from(geometry.distances), [2, 12, 2, 12]);
  assert.equal(geometry.positions[2], -2);
  assert.equal(geometry.positions[5], -12);
});

test('depth projection preserves the source photograph from its original viewpoint', () => {
  const geometry = createDepthGeometry(pixels(3, [255, 128, 0, 200, 80, 20]), { near: 2, far: 12, fov: 60, aspect: 1.5 });
  const tangent = Math.tan(Math.PI / 6);
  for (let i = 0; i < 6; i++) {
    const distance = -geometry.positions[i * 3 + 2];
    const u = geometry.positions[i * 3] / (distance * tangent * 1.5) / 2 + .5;
    const v = (geometry.positions[i * 3 + 1] - 1.6) / (distance * tangent) / 2 + .5;
    assert.ok(Math.abs(u - geometry.uvs[i * 2]) < 1e-6);
    assert.ok(Math.abs(v - geometry.uvs[i * 2 + 1]) < 1e-6);
  }
});

test('silhouette discontinuities become fragments rather than stretched face triangles', () => {
  const flat = createDepthGeometry(pixels(2, [255, 255, 255, 255]));
  assert.equal(flat.indices.length, 6);
  const silhouette = createDepthGeometry(pixels(2, [255, 0, 255, 0]));
  assert.equal(silhouette.indices.length, 0);
  assert.equal(silhouette.edgeVertexIndices.length, 4);
});

test('depth strength expands the world behind a stable foreground plane', () => {
  const depth = pixels(2, [255, 0, 255, 0]);
  const shallow = createDepthGeometry(depth, { near: 2, far: 12, strength: .5 });
  const deep = createDepthGeometry(depth, { near: 2, far: 12, strength: 2 });
  assert.equal(shallow.distances[0], deep.distances[0]);
  assert.equal(shallow.distances[1], 7);
  assert.equal(deep.distances[1], 22);
  assert.ok(Math.abs(shallow.positions[3] / shallow.distances[1] - deep.positions[3] / deep.distances[1]) < 1e-6);
});

test('incomplete depth inputs fail before building geometry', () => {
  assert.throws(() => createDepthGeometry({ width: 2, height: 2, data: [255] }), /complete depth/);
  assert.throws(() => createDepthGeometry(pixels(2, [0, 0, 0, 0]), { near: 5, far: 2 }), /Invalid depth/);
  assert.throws(() => createDepthGeometry(pixels(2, [0, 0, 0, 0]), { far: Infinity }), /Invalid depth/);
});
