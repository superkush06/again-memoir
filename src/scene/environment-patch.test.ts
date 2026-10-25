import test from "node:test";
import assert from "node:assert/strict";
import { selectGroundPatch } from "./environment-patch";
import { buildPhotoEnvironment } from "./photo-environment";
import type { VolumePixels } from "./volume";
import * as THREE from "three";

test("floor patch excludes large clothing regions and retains the visible floor color", () => {
  const source: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  const mask: VolumePixels = { width: 100, height: 100, data: new Uint8Array(40000) };
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4;
    (source.data as Uint8Array).set(x < 85 ? [240, 20, 50, 255] : [112, 96, 84, 255], i);
    (mask.data as Uint8Array).set([x < 85 ? 255 : 0, 0, 0, 255], i);
  }
  const patch = selectGroundPatch(source, mask);
  assert.equal(patch.reliable, true);
  assert.ok(patch.region[0] >= 0.85);
  assert.deepEqual(patch.color, [112, 96, 84]);
});

test("unknown floor never projects filled human pixels across the ground", () => {
  const source: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(150) };
  const mask: VolumePixels = { width: 32, height: 32, data: new Uint8Array(4096).fill(255) };
  assert.equal(selectGroundPatch(source, mask).reliable, false);
  const result = buildPhotoEnvironment({ source, excludedMask: mask, textureSource: "source-inpaint" });
  const floor = result.group.getObjectByName("Photographic ground with metre-scale detail") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  assert.equal(floor.material.uniforms.photoWeight.value, 0);
  assert.equal(floor.material.uniforms.detailWeight.value, 0);
  result.dispose();
});
