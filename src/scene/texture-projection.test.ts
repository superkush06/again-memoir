import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { orthographicPhotoProjection, projectionConfidence, rasterizePhotoVisibility,
  registerTurnaroundSilhouette, turnaroundForeground, overlayPhotographsOnVertexColors } from "./texture-projection";
import type { VolumePixels } from "./volume";

const camera = orthographicPhotoProjection({ left: -1, right: 1, bottom: -1, top: 1 });

test("an arm in front of a chest prevents the chest from receiving arm pixels", () => {
  const torso = new THREE.BoxGeometry(1.2, 1.5, 0.3);
  const arm = new THREE.CylinderGeometry(0.12, 0.12, 1.2, 20);
  const armMatrix = new THREE.Matrix4().makeTranslation(0.2, 0, 0.32);
  const visibility = rasterizePhotoVisibility([
    { geometry: torso }, { geometry: arm, matrix: armMatrix },
  ], camera);
  const normal = new THREE.Vector3(0, 0, 1);
  assert.equal(projectionConfidence(new THREE.Vector3(0.2, 0, 0.15), normal, camera, visibility), 0,
    "front-facing but occluded shirt must reject this photograph");
  assert.ok(projectionConfidence(new THREE.Vector3(-0.3, 0, 0.15), normal, camera, visibility) > 0.99);
  assert.ok(projectionConfidence(new THREE.Vector3(0.2, 0, 0.44), normal, camera, visibility) > 0.99);
  assert.equal(projectionConfidence(new THREE.Vector3(-0.3, 0, -0.15), normal, camera, visibility), 0);
  torso.dispose(); arm.dispose();
});

test("opposing cameras expose separate surfaces without mirroring a front photograph", () => {
  const front = camera.project(new THREE.Vector3(0.4, 0.3, 0.2));
  const rearCamera = orthographicPhotoProjection({ left: -1, right: 1, bottom: -1, top: 1 }, Math.PI);
  const rear = rearCamera.project(new THREE.Vector3(0.4, 0.3, -0.2));
  assert.ok(front.u > 0.5 && rear.u < 0.5);
  assert.equal(front.v, rear.v);
  assert.equal(projectionConfidence(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), camera), 0);
  assert.equal(projectionConfidence(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), rearCamera), 1);
});

const turnaround = (): VolumePixels => {
  const width = 100, height = 120;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const background = Math.round(110 + y * 0.15);
    const torso = x > 25 && x < 75 && y > 8 && y < 65;
    const legs = y >= 65 && y < 110 && (x > 25 && x < 44 || x > 56 && x < 75);
    const value = torso ? 190 : legs ? 35 : background;
    const offset = (y * width + x) * 4;
    data.set([value, value, value, 255], offset);
  }
  return { width, height, data };
};

test("turnaround masking removes studio background and leg gaps without recoloring monochrome clothes", () => {
  const image = turnaround();
  const before = Array.from(image.data);
  const field = turnaroundForeground(image, [0, 0.2, 1, 0.8]);
  assert.equal(field.contains(0.5, 0.4), true);
  assert.equal(field.contains(0.05, 0.4), false);
  assert.equal(field.contains(0.5, 0.8), false);
  assert.equal(field.contains(0.25, 0.8), true);
  assert.deepEqual(Array.from(image.data), before, "a matte must never alter source RGB");
});

test("silhouette registration keeps each inferred trouser leg on its corresponding mesh leg", () => {
  const geometry = new THREE.BoxGeometry(0.25, 1.6, 0.25);
  const visibility = rasterizePhotoVisibility([
    { geometry, matrix: new THREE.Matrix4().makeTranslation(-0.3, 0, 0) },
    { geometry, matrix: new THREE.Matrix4().makeTranslation(0.3, 0, 0) },
  ], camera);
  const field = turnaroundForeground(turnaround(), [0, 0.2, 1, 0.8]);
  const register = registerTurnaroundSilhouette(visibility, field);
  const left = register(0.35, 0.8), right = register(0.65, 0.8);
  assert.ok(left && right);
  assert.ok(left.u < 0.4 && right.u > 0.6);
  assert.equal(field.contains(left.u, left.v), true);
  assert.equal(field.contains(right.u, right.v), true);
  geometry.dispose();
});

test("an imported mesh receives exact source color on visible vertices and keeps unseen learned colors", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 0.4, 2, 2, 2);
  const position = geometry.getAttribute("position");
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(position.count * 3).fill(0.04), 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  const image: VolumePixels = { width: 4, height: 4,
    data: new Uint8Array(Array.from({ length: 16 }, () => [128, 64, 32, 255]).flat()) };
  const result = overlayPhotographsOnVertexColors(group, [{ image, camera }]);
  assert.ok(result.updatedVertices > 0);
  const expected = new THREE.Color().setRGB(128 / 255, 64 / 255, 32 / 255, THREE.SRGBColorSpace);
  const colors = geometry.getAttribute("color"), normals = geometry.getAttribute("normal");
  for (let i = 0; i < position.count; i++) {
    if (normals.getZ(i) > 0.99) {
      assert.ok(Math.abs(colors.getX(i) - expected.r) < 1e-6);
      assert.ok(Math.abs(colors.getY(i) - expected.g) < 1e-6);
      assert.ok(Math.abs(colors.getZ(i) - expected.b) < 1e-6);
    } else if (normals.getZ(i) < -0.99) {
      assert.ok(Math.abs(colors.getX(i) - 0.04) < 1e-6);
    }
  }
  geometry.dispose(); material.dispose();
});
