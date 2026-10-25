import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { parseNeuralAsset } from './neural-asset';
import { registeredFaceOf, warpFacePixel } from './registered-face';
import { poseAnatomicalHead } from './neural-photo-fitting';
import type { PhotoBox } from './human-appearance';

const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

const calibration = () => ({ version: 1, preposed: true, strategy: 'landmark-bounded-registration',
  sourceSize: [1200, 900], pixelsPerMeter: 1000, offsetPixels: [580, 1930],
  sourceBox: [.2, .4, .6, .7], landmarkErrorPixels: 2.5 });

/** A deliberately offset model exercises the real loader's grounding and
 * centering transforms, rather than assuming GLB and world coordinates match. */
function fixture() {
  const geometry = new THREE.BoxGeometry(.6, 2, .4).translate(.1, .9, .3);
  const positions = geometry.getAttribute('position').array as Float32Array;
  const colors = new Float32Array(positions.length).fill(.5);
  const indices = geometry.index!.array as Uint16Array;
  const binary = new Uint8Array(positions.byteLength + colors.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
  binary.set(new Uint8Array(colors.buffer), positions.byteLength);
  binary.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), positions.byteLength + colors.byteLength);
  const json = { asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0], extras: { photoFaceFit: calibration() } }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: colors.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + colors.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-.2, -.1, .1], max: [.4, 1.9, .5] },
      { bufferView: 1, componentType: 5126, count: colors.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2 }] }] };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const buffer = new ArrayBuffer(28 + jsonLength + binaryLength), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonLength).fill(32); new Uint8Array(buffer, 20, text.length).set(text);
  view.setUint32(20 + jsonLength, binaryLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(buffer, 28 + jsonLength, binary.length).set(binary);
  geometry.dispose();
  return buffer;
}

test('face calibration survives actual model height normalization, grounding, centering and world placement', async () => {
  const yaw = .37;
  const loaded = await parseNeuralAsset(fixture(), { url: '/uploads/reconstructions/face-test.glb',
    model: 'makehuman', inputKind: 'anatomical-template', appearance: 'vertex-color', upAxis: 'y', frontYaw: yaw }, 1.76);
  try {
    const group = loaded.group;
    group.position.set(4, .7, -12); group.rotation.set(.05, 1.2, -.02); group.scale.setScalar(1.3);
    group.updateMatrixWorld(true);
    const registered = registeredFaceOf(group)!;
    assert.ok(registered);
    let rawScene: THREE.Object3D | undefined;
    group.traverse(object => { if (object.userData.photoFaceFit) rawScene = object; });
    const rootFromRaw = group.matrixWorld.clone().invert().multiply(rawScene!.matrixWorld);
    const sourcePoint = new THREE.Vector3(.02, 1.6, .16);
    const rootPoint = sourcePoint.clone().applyMatrix4(rootFromRaw);
    assert.ok(rootPoint.distanceTo(sourcePoint) > .1, 'the test must exercise nonidentity loader transforms');
    const camera = registered.camera(registered.sourceBox), projected = camera.project(rootPoint);
    // This anatomical point corresponds to source pixel (600, 330), independent
    // of how the complete body was centered or positioned inside the world.
    close(projected.u, (600 / 1200 - .4) / .3);
    close(projected.v, (330 / 900 - .2) / .4);
    close(projected.depth, .16);
    close(camera.direction.x, Math.sin(yaw)); close(camera.direction.y, 0); close(camera.direction.z, Math.cos(yaw));
    const farther = sourcePoint.clone(); farther.z -= .04;
    close(camera.project(farther.applyMatrix4(rootFromRaw)).depth, .12);
    assert.equal(registered.landmarkErrorPixels, 2.5);
    assert.equal(registered.strategy, 'landmark-bounded-registration');
  } finally { loaded.dispose(); }
});

test('face and neck crops sample the same original pixel without stretching or flipping the image', () => {
  const group = new THREE.Group(); group.userData.photoFaceFit = calibration();
  const fit = registeredFaceOf(group)!;
  const point = new THREE.Vector3(.02, 1.6, .16);
  for (const box of [[0, 0, 1, 1], [.2, .4, .6, .7], [.35, .45, .55, .65]] as PhotoBox[]) {
    const projected = fit.camera(box).project(point);
    close((box[1] + projected.u * (box[3] - box[1])) * 1200, 600);
    close((box[0] + projected.v * (box[2] - box[0])) * 900, 330);
  }
  const camera = fit.camera(fit.sourceBox);
  assert.ok(camera.project(point.clone().add(new THREE.Vector3(0, .01, 0))).v < camera.project(point).v,
    'moving upward on the face moves upward in image rows');
  assert.ok(camera.project(new THREE.Vector3(-.5, 1.6, .16)).u < 0,
    'points outside the crop remain outside, so visibility can reject them');
  fit.sourceBox[0] = 0;
  assert.equal(group.userData.photoFaceFit.sourceBox[0], .2, 'callers cannot overwrite authored crop metadata');
});

test('malformed or unposed camera metadata cannot claim a registered face', () => {
  const invalid = [null, {}, { version: 2 }, { preposed: false }, { sourceSize: [1200] },
    { sourceSize: [0, 900] }, { sourceSize: [1200, Infinity] }, { sourceSize: ['1200', 900] },
    { pixelsPerMeter: NaN }, { pixelsPerMeter: 0 }, { pixelsPerMeter: 100001 },
    { offsetPixels: [0] }, { offsetPixels: [Infinity, 0] }, { offsetPixels: [0, 1e6] },
    { sourceBox: [0, 0, 1] }, { sourceBox: [-.1, 0, 1, 1] }, { sourceBox: [0, 0, NaN, 1] },
    { sourceBox: [.5, .2, .3, .8] }, { sourceBox: [0, 0, .001, .8] },
    { landmarkErrorPixels: -1 }, { landmarkErrorPixels: NaN }, { landmarkErrorPixels: 51 }];
  for (const change of invalid) {
    const group = new THREE.Group();
    group.userData.photoFaceFit = change === null || Object.keys(change).length === 0 ? change : { ...calibration(), ...change };
    assert.equal(registeredFaceOf(group), undefined, JSON.stringify(change));
  }
  const root = new THREE.Group(), scene = new THREE.Group(); root.add(scene);
  root.userData.photoFaceFit = { ...calibration(), preposed: false };
  scene.userData.photoFaceFit = calibration();
  assert.ok(registeredFaceOf(root), 'an invalid parent does not hide a valid GLB scene calibration');
});

test('the corrected neck blend rotates chin, mouth and eyes as one rigid face', () => {
  // Reviewed hm08 surface points: chin991, chinfront732, mouthcorners368/7128,
  // nose5054 and outercanthi21/6805. The old blend distorted these by 5.4cm.
  const points = [[0, 1.51572412, .11591253], [0, 1.51919571, .13435452],
    [-.02412821, 1.56481852, .14690744], [.02412821, 1.56481852, .14690744],
    [0, 1.59443344, .167175], [-.04290273, 1.63306319, .13397543], [.04290273, 1.63306319, .13397543]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  const head = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); head.name = 'Head';
  const group = new THREE.Group(); group.add(head);
  const fit = { headPivot: [0, 1.55754752, .02494845], headFadeStartY: 1.42572412,
    headFadeEndY: 1.50972412, headChinY: 1.51572412, referenceHeight: 1.76 };
  poseAnatomicalHead(group, 1, fit);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const before = new THREE.Vector3(...points[i]).distanceTo(new THREE.Vector3(...points[j]));
    const after = new THREE.Vector3().fromBufferAttribute(positions, i).distanceTo(new THREE.Vector3().fromBufferAttribute(positions, j));
    close(after, before);
  }
  geometry.dispose(); (head.material as THREE.Material).dispose();
});

test('residual texture alignment is local, preserves pixel coordinates and caps displacement', () => {
  const textureWarp = { centers: [[600, 330], [100, 100], [1100, 800]],
    coefficients: [[3, 4], [0, 0], [0, 0]], radiusPixels: 10, maxDisplacementPixels: 5 };
  assert.deepEqual(warpFacePixel({ textureWarp }, 600, 330), [603, 334]);
  assert.deepEqual(warpFacePixel({ textureWarp }, 1200, 900), [1200, 900], 'distant pixels retain source coordinates');
  const enormous = { ...textureWarp, centers: [[600, 330], [600, 330], [600, 330]],
    coefficients: [[300, 400], [300, 400], [300, 400]], maxDisplacementPixels: 6 };
  const capped = warpFacePixel({ textureWarp: enormous }, 600, 330);
  close(Math.hypot(capped[0] - 600, capped[1] - 330), 6);
  close(capped[0], 603.6); close(capped[1], 334.8);
  const group = new THREE.Group(); group.userData.photoFaceFit = { ...calibration(), textureWarp };
  const fit = registeredFaceOf(group)!;
  const projected = fit.camera([0, 0, 1, 1]).project(new THREE.Vector3(.02, 1.6, .16));
  close(projected.u * 1200, 603); close(projected.v * 900, 334); close(projected.depth, .16);
});

test('malformed texture residual fields leave source pixels unchanged', () => {
  const valid = { centers: [[1, 2], [3, 4], [5, 6]], coefficients: [[1, 0], [1, 0], [1, 0]],
    radiusPixels: 10, maxDisplacementPixels: 5 };
  for (const change of [{ centers: [] }, { coefficients: [[1, 0]] }, { radiusPixels: NaN },
    { radiusPixels: 0 }, { radiusPixels: 501 }, { maxDisplacementPixels: -1 },
    { maxDisplacementPixels: 21 }, { centers: [[NaN, 2], [3, 4], [5, 6]] },
    { coefficients: [[1, 0], [Infinity, 0], [1, 0]] }, { coefficients: [[1, 0], [1], [1, 0]] }]) {
    assert.deepEqual(warpFacePixel({ textureWarp: { ...valid, ...change } }, 20, 30), [20, 30]);
  }
});
