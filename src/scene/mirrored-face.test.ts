import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mirroredFaceView } from './mirrored-face';

const source = { width: 1000, height: 1000, data: new Uint8Array(4_000_000) };
const mask = { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
const metadata = () => ({
  version: 1, preposed: true, rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  headPivot: [0, 1.55, .025], pixelsPerMeter: 1000,
  canonicalChinY: 1.52,
  offsetPixels: [500, 2000], sourceSize: [1000, 1000], sourceBox: [.1, .2, .9, .8],
});
function fixture(yaw = 0) {
  const root = new THREE.Group(), scene = new THREE.Group();
  root.add(scene);
  const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(yaw));
  const fit = metadata();
  fit.rotation = [0, 1, 2].map(row => [0, 1, 2].map(column => rotation.elements[column * 3 + row]));
  scene.userData.photoFaceFit = fit;
  return { root, scene, fit, rotation };
}

test('mirrored profile projection samples the corresponding observed facial point after loader transforms', () => {
  const { root, scene, fit, rotation } = fixture(Math.PI / 3);
  root.position.set(20, 4, -8);
  root.rotation.y = -.5;
  scene.scale.setScalar(.98);
  scene.position.set(.02, 0, -.05);
  const view = mirroredFaceView(root, source, mask)!;
  assert.ok(view);
  const pivot = new THREE.Vector3().fromArray(fit.headPivot);
  const left = new THREE.Vector3(-.045, .13, .12).applyMatrix3(rotation).add(pivot);
  const right = new THREE.Vector3(.045, .13, .12).applyMatrix3(rotation).add(pivot);
  const rawToRoot = new THREE.Matrix4().multiplyMatrices(root.matrixWorld.clone().invert(), scene.matrixWorld);
  const projected = view.camera.project(right.clone().applyMatrix4(rawToRoot));
  const sourceU = (left.x * fit.pixelsPerMeter + fit.offsetPixels[0]) / source.width;
  const sourceV = (-left.y * fit.pixelsPerMeter + fit.offsetPixels[1]) / source.height;
  assert.ok(Math.abs(projected.u - (sourceU - .2) / .6) < 1e-10);
  assert.ok(Math.abs(projected.v - (sourceV - .1) / .8) < 1e-10);
  assert.ok(Math.abs(projected.depth - left.z) < 1e-10);
  assert.ok(view.camera.direction.x > .85 && view.camera.direction.z < -.49,
    'the camera must face the formerly unseen cheek');
  assert.equal(view.image, source, 'original source RGB is retained');
  assert.equal(view.mask, mask);
});

test('inferred texture cannot paint a second face on the neck, skull, hair, or clothing', () => {
  const { root, rotation, fit } = fixture(.8);
  const view = mirroredFaceView(root, source, mask)!;
  const pivot = new THREE.Vector3().fromArray(fit.headPivot);
  const posed = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).sub(pivot).applyMatrix3(rotation).add(pivot);
  const accepts = (point: THREE.Vector3) => view.acceptSample!([100, 90, 80], point, [100, 90, 80]);
  assert.equal(accepts(posed(.04, 1.68, .145)), true);
  assert.equal(accepts(posed(0, 1.525, .14)), true, 'the complete chin must receive a matching face color');
  assert.equal(accepts(posed(0, 1.50, .14)), false, 'neck must stay untouched');
  assert.equal(accepts(posed(0, 1.68, .01)), false, 'rear skull must stay untouched');
  assert.equal(accepts(posed(.14, 1.68, .145)), false, 'lateral surfaces outside the face stay untouched');
  for (const name of ['Head', 'Eyes', 'Eye']) {
    const mesh = new THREE.Mesh(); mesh.name = name;
    assert.equal(view.meshFilter!(mesh), true);
  }
  for (const name of ['Hair', 'Shirt', 'Skin', 'HeadAccessory', 'Eyebrows']) {
    const mesh = new THREE.Mesh(); mesh.name = name;
    assert.equal(view.meshFilter!(mesh), false);
  }
});

test('invalid face metadata cannot produce a mirrored view', () => {
  for (const corrupt of [
    (fit: ReturnType<typeof metadata>) => { fit.rotation[0][0] = -1; },
    (fit: ReturnType<typeof metadata>) => { fit.rotation[0][1] = .5; },
    (fit: ReturnType<typeof metadata>) => { fit.headPivot[0] = NaN; },
    (fit: ReturnType<typeof metadata>) => { fit.canonicalChinY = NaN; },
    (fit: ReturnType<typeof metadata>) => { fit.sourceBox[2] = fit.sourceBox[0]; },
    (fit: ReturnType<typeof metadata>) => { fit.pixelsPerMeter = 0; },
    (fit: ReturnType<typeof metadata>) => { fit.sourceSize[0] = 1200; },
  ]) {
    const { root, fit } = fixture(); corrupt(fit);
    assert.equal(mirroredFaceView(root, source, mask), undefined);
  }
  assert.equal(mirroredFaceView(new THREE.Group(), source, mask), undefined);
});

test('downsampled source images retain original-pixel calibration', () => {
  const { root, fit } = fixture();
  fit.sourceSize = [1205, 926];
  const resized = { width: 1200, height: 922, data: new Uint8Array(1200 * 922 * 4) };
  const view = mirroredFaceView(root, resized, mask)!;
  assert.ok(view, 'rounding a downsampled image by less than a pixel is allowed');
  const projected = view.camera.project(new THREE.Vector3(.04, 1.68, .145));
  assert.ok(Math.abs(projected.u - ((460 / 1205 - .2) / .6)) < 1e-10);
  assert.ok(Math.abs(projected.v - ((320 / 926 - .1) / .8)) < 1e-10);
});

test('mirror projection applies the bounded registration warp at the reflected photo coordinate', () => {
  const { root, scene } = fixture();
  scene.userData.photoFaceFit.textureWarp = {
    centers: [[460, 320], [0, 0], [1000, 1000]],
    coefficients: [[4, -3], [0, 0], [0, 0]], radiusPixels: 20, maxDisplacementPixels: 5,
  };
  const view = mirroredFaceView(root, source, mask)!;
  const projected = view.camera.project(new THREE.Vector3(.04, 1.68, .145));
  assert.ok(Math.abs(projected.u - ((.464 - .2) / .6)) < 1e-10);
  assert.ok(Math.abs(projected.v - ((.317 - .1) / .8)) < 1e-10);
});
