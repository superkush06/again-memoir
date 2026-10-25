import assert from 'node:assert/strict';
import { createDepthGeometry } from '../src/scene/reconstruction.js';
import { isReconstructionSpec } from '../src/reconstruction-validation.js';
import { selectGeometryBackend } from '../server/geometry-contract.js';
import { parseDevices, selectDevice } from './quest-deploy.mjs';

const width = 48; const height = 36;
const depth = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4;
  const foreground = x > 14 && x < 34 && y > 8 && y < 31;
  depth[i] = foreground ? 220 : Math.round(60 + 110 * (y / height));
  depth[i + 3] = 255;
}

const selected = selectGeometryBackend({ requested: 'depth-pro' });
assert.equal(selected, 'depth-pro');
const reconstruction = {
  version: 1 as const, kind: 'depth-mesh' as const,
  sourceUrl: '/uploads/reconstructions/sim-source.jpg',
  depthUrl: '/uploads/reconstructions/sim-depth.png',
  width: 640, height: 480, depthSource: 'depth-anything-v2' as const,
  near: 2, far: 12, fov: 60,
};
assert.equal(isReconstructionSpec(reconstruction), true, 'candidate output must become a safe reconstruction descriptor');
const mesh = createDepthGeometry({ width, height, data: depth });
assert.ok(mesh.positions.length === width * height * 3);
assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0);
assert.ok(Array.from(mesh.positions).every(Number.isFinite));
assert.ok(Array.from(mesh.indices).every(index => index >= 0 && index < width * height));

const devices = parseDevices('emulator unauthorized\nquest2 device\n');
assert.deepEqual(devices, [{ id: 'emulator', state: 'unauthorized' }, { id: 'quest2', state: 'device' }]);
assert.equal(selectDevice(devices, 'quest2'), 'quest2');
console.log(JSON.stringify({ ok: true, stages: ['candidate-selected', 'reconstruction-validated', 'mesh-created', 'quest-device-selected'], backend: selected, vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, questDevice: 'quest2' }, null, 2));

