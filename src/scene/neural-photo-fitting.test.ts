import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { fitNeuralHumanPhotographs, bakePhotographsToUv, poseAnatomicalHead, seedAnatomicalAppearance } from "./neural-photo-fitting";
import { orthographicPhotoProjection } from "./texture-projection";
import type { HumanAppearance } from "./human-appearance";
import type { VolumePixels } from "./volume";

const pixels = (sample: (y: number) => number[]): VolumePixels => ({ width: 64, height: 80,
  data: new Uint8Array(Array.from({ length: 64 * 80 }, (_, i) => [...sample(Math.floor(i / 64) / 79), 255]).flat()) });
const faceColor = [180, 110, 70], shirtColor = [31, 40, 56];
const source = pixels((y) => y < 0.41 ? faceColor : shirtColor);
const mask = pixels(() => [255, 255, 255]);
const front = pixels(() => [50, 80, 120]), back = pixels(() => [70, 55, 40]);
const appearance: HumanAppearance = { shirtColor: "#1f2838", skinColor: "#b46e46",
  pantsColor: "#30343a", shoeColor: "#222222", hairColor: "#141414",
  faceBox: [0.1, 0.25, 0.4, 0.75], torsoBox: [0.42, 0.1, 0.8, 0.9], sourceView: "front" };

function body() {
  const group = new THREE.Group();
  group.userData.appearance = "vertex-color";
  const part = (name: string, dimensions: number[], y: number) => {
    const geometry = new THREE.BoxGeometry(dimensions[0], dimensions[1], dimensions[2], 6, 12, 2);
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
    mesh.name = name; mesh.position.y = y; group.add(mesh);
  };
  part("head", [0.28, 0.28, 0.23], 1.62);
  part("neck", [0.12, 0.14, 0.12], 1.44);
  part("torso", [0.45, 0.52, 0.27], 1.14);
  part("legs", [0.35, 0.9, 0.23], 0.45);
  return group;
}

const samplePart = (group: THREE.Group, name: string, side: number, minY = -Infinity) => {
  const mesh = group.getObjectByName(name) as THREE.Mesh;
  const colors = mesh.geometry.getAttribute("color"), normal = mesh.geometry.getAttribute("normal");
  const position = mesh.geometry.getAttribute("position");
  const result: number[][] = [];
  for (let i = 0; i < colors.count; i++) if (normal.getZ(i) * side > 0.99 && position.getY(i) + mesh.position.y > minY)
    result.push([colors.getX(i), colors.getY(i), colors.getZ(i)]);
  return result;
};
const linear = (rgb: number[]) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace).toArray();
const includes = (values: number[][], color: number[]) => values.some((value) => value.every((v, c) => Math.abs(v - color[c]) < 1e-5));

test('correcting the facial chin does not move existing garment photograph details', async () => {
  const images: Uint8Array[] = [];
  for (const chin of [1.54, 1.46]) {
    const group = body(); group.userData.inputKind = 'anatomical-template';
    group.userData.anatomicalFit = { headPivot: [0, 1.4, 0], headFadeStartY: 1.3, headFadeEndY: 1.4,
      headChinY: chin, referenceHeight: 1.76, garmentPhotoChinY: 1.54, garmentPhotoCrownY: 1.76 };
    const shirt = group.getObjectByName('torso') as THREE.Mesh; shirt.name = 'Shirt';
    const result = await fitNeuralHumanPhotographs(group, { appearance, mask,
      source: pixels(y => y > .64 ? [40, 180, 70] : y > .5 ? [210, 190, 50] : shirtColor) });
    images.push(new Uint8Array(((shirt.material as THREE.MeshBasicMaterial).map as THREE.DataTexture).image.data));
    result.dispose?.();
    group.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.isMesh) {
      mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    } });
  }
  assert.deepEqual(images[0], images[1], 'facial fitting must not rescale a shirt graphic');
});

test("neural bodies keep learned geometry while original faces and cropped clothing override inferred views", async () => {
  const group = body();
  const originals = group.children.map((mesh) => Array.from((mesh as THREE.Mesh).geometry.getAttribute("position").array));
  const result = await fitNeuralHumanPhotographs(group, { source, mask, appearance, photographicBody: { front, back } });
  assert.equal(result.viewCount, 4);
  assert.ok(result.updatedVertices > 0);
  assert.ok(includes(samplePart(group, "head", 1), linear(faceColor)));
  assert.ok(includes(samplePart(group, "torso", 1, 1.2), linear(shirtColor)));
  assert.ok(includes(samplePart(group, "legs", 1), linear([50, 80, 120])), "cropped source shirt must not stretch onto the legs");
  assert.ok(includes(samplePart(group, "head", -1), linear([70, 55, 40])), "unobserved head retains the inferred back");
  group.children.forEach((mesh, i) => assert.deepEqual(Array.from((mesh as THREE.Mesh).geometry.getAttribute("position").array), originals[i]));
});

test("a back-view photograph restores only the neural body's back and leaves its inferred front face intact", async () => {
  const group = body();
  await fitNeuralHumanPhotographs(group, { source, mask, appearance: { ...appearance, sourceView: "back", yaw: Math.PI },
    photographicBody: { front, back } });
  assert.ok(includes(samplePart(group, "head", -1), linear(faceColor)));
  assert.ok(includes(samplePart(group, "head", 1), linear([50, 80, 120])));
  assert.equal(group.userData.photoFit.originalView, "back");
});

test("empty source masks and PBR assets cannot overwrite learned photographic colors", async () => {
  const group = body();
  const empty = pixels(() => [0, 0, 0]);
  await fitNeuralHumanPhotographs(group, { source, mask: empty, appearance, photographicBody: { front, back } });
  assert.equal(includes(samplePart(group, "head", 1), linear(faceColor)), false);
  assert.ok(includes(samplePart(group, "head", 1), linear([50, 80, 120])));
  const pbr = body(); pbr.userData.appearance = "pbr";
  assert.deepEqual(await fitNeuralHumanPhotographs(pbr, { source, mask, appearance }), { updatedVertices: 0, viewCount: 0 });
  assert.ok(samplePart(pbr, "head", 1).every((rgb) => rgb.every((v) => v === 1)));
});

test("source shirt pixels cannot smear across bare arms already identified by the body atlas", async () => {
  const group = body();
  for (const side of [-1, 1]) {
    const geometry = new THREE.BoxGeometry(0.045, 0.32, 0.23, 4, 8, 2);
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 3).fill(1), 3));
    const arm = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
    arm.name = `arm${side}`; arm.position.set(side * 0.26, 1.2, 0); group.add(arm);
  }
  const armColor = [180, 110, 70];
  const atlas: VolumePixels = { width: 128, height: 80,
    data: new Uint8Array(Array.from({ length: 128 * 80 }, (_, i) => {
      const u = (i % 128) / 127;
      const color = u > 0.05 && u < 0.2 || u > 0.8 && u < 0.95 ? armColor
        : u >= 0.25 && u <= 0.75 ? shirtColor : [130, 130, 130];
      return [...color, 255];
    }).flat()) };
  await fitNeuralHumanPhotographs(group, { source, mask,
    appearance: { ...appearance, torsoBox: [0.42, 0, 0.8, 1] },
    photographicBody: { front: atlas, back: atlas } });
  for (const side of [-1, 1]) {
    const values = samplePart(group, `arm${side}`, 1);
    assert.ok(includes(values, linear(armColor)), "the inferred skin remains visible");
    assert.equal(includes(values, linear(shirtColor)), false, "the original shirt cannot replace a bare arm");
  }
});

test("authored UV baking preserves photo detail between sparse vertices and releases its own resources", async () => {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.2 + uv.getX(i) * 0.25, 0.4 + uv.getY(i) * 0.3);
  const originalUv = Array.from(uv.array);
  const original = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const mesh = new THREE.Mesh(geometry, original); mesh.name = "Head";
  const group = new THREE.Group(); group.add(mesh);
  const image: VolumePixels = { width: 64, height: 64,
    data: new Uint8Array(Array.from({ length: 64 * 64 }, (_, i) => {
      const x = i % 64;
      return x >= 28 && x <= 35 ? [12, 201, 87, 255] : [32, 41, 58, 255];
    }).flat()) };
  const before = Array.from(geometry.getAttribute("position").array);
  const fitted = await bakePhotographsToUv(group, [{ image, edgeFeather: 0.05,
    camera: orthographicPhotoProjection({ left: -1, right: 1, bottom: -1, top: 1 }) }], 64);
  assert.equal(fitted.uvMaps, 1);
  const material = mesh.material as THREE.MeshBasicMaterial, texture = material.map as THREE.DataTexture;
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(material.toneMapped, false);
  const packedCenter = new THREE.Vector2(0.325, 0.55).applyMatrix3(texture.matrix);
  assert.ok(Math.abs(packedCenter.x - 0.5) < 1e-6 && Math.abs(packedCenter.y - 0.5) < 1e-6,
    "a small authored head island receives the full texture area");
  const center = (32 * 64 + 32) * 4, edge = (32 * 64 + 10) * 4;
  assert.deepEqual(Array.from(texture.image.data.slice(center, center + 3)), [12, 201, 87],
    "the detail has no mesh vertex, but survives in the UV map");
  assert.deepEqual(Array.from(texture.image.data.slice(edge, edge + 3)), [32, 41, 58]);
  const boundary = (32 * 64) * 4;
  assert.deepEqual(Array.from(texture.image.data.slice(boundary, boundary + 3)), [255, 0, 0],
    "the crop border blends to the prior material while interior photo detail stays exact");
  assert.deepEqual(Array.from(geometry.getAttribute("position").array), before);
  assert.deepEqual(Array.from(geometry.getAttribute("uv").array), originalUv, "packing preserves authored UV coordinates");
  let texturesDisposed = 0, materialsDisposed = 0, originalDisposed = 0;
  texture.addEventListener("dispose", () => texturesDisposed++);
  material.addEventListener("dispose", () => materialsDisposed++);
  original.addEventListener("dispose", () => originalDisposed++);
  fitted.dispose(); fitted.dispose();
  assert.equal(mesh.material, original);
  assert.equal(texturesDisposed, 1); assert.equal(materialsDisposed, 1); assert.equal(originalDisposed, 0);
});

test("authored head yaw turns the real nose direction while the neck seam and body remain attached", () => {
  const group = body();
  const previous = group.getObjectByName("head")!; group.remove(previous);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 1.4, 0.1, 0, 1.5, 0.1, 0.1, 1.6, 0.2, 0, 1.76, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const head = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); head.name = "Head"; group.add(head);
  const torso = group.getObjectByName("torso") as THREE.Mesh;
  const bodyBefore = Array.from(torso.geometry.getAttribute("position").array);
  const uvBefore = Array.from(geometry.getAttribute("uv").array);
  const fit = { headPivot: [0, 1.4, 0], headFadeStartY: 1.4, headFadeEndY: 1.5, headChinY: 1.5, referenceHeight: 1.76 };
  poseAnatomicalHead(group, Math.PI / 2, fit);
  const position = geometry.getAttribute("position");
  assert.ok(Math.abs(position.getX(0)) < 1e-6 && Math.abs(position.getZ(0) - 0.1) < 1e-6,
    "the neck attachment does not move");
  assert.ok(Math.abs(position.getX(2) - 0.2) < 1e-6 && Math.abs(position.getZ(2) + 0.1) < 1e-6,
    "+Z-facing anatomy turns toward +X");
  const firstPose = Array.from(position.array);
  poseAnatomicalHead(group, Math.PI / 2, fit);
  assert.deepEqual(Array.from(position.array), firstPose, "repeated fitting never adds another head turn");
  assert.deepEqual(Array.from(geometry.getAttribute("uv").array), uvBefore);
  assert.deepEqual(Array.from(torso.geometry.getAttribute("position").array), bodyBefore);
});

test("an anatomical template's unobserved surfaces retain the source monochrome palette", async () => {
  const group = new THREE.Group();
  for (const name of ["Head", "Skin", "Hair", "Shirt", "Pants", "Shoes", "Eyes"]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xdb9149 }));
    mesh.name = name; group.add(mesh);
  }
  const mono = { ...appearance, skinColor: "#878787", hairColor: "#222222", shirtColor: "#555555",
    pantsColor: "#323232", shoeColor: "#242424" };
  assert.equal(seedAnatomicalAppearance(group, mono), 7);
  // Even the asset's orange material must not tint an unobserved monochrome UV.
  const bake = await bakePhotographsToUv(group, [], 8);
  for (const mesh of group.children as THREE.Mesh[]) {
    const colors = mesh.geometry.getAttribute("color");
    for (let i = 0; i < colors.count; i++) assert.equal(colors.getX(i), colors.getY(i));
    const map = (mesh.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    const data = map.image.data;
    for (let i = 0; i < data.length; i += 4) {
      assert.equal(data[i], data[i + 1]); assert.equal(data[i + 1], data[i + 2]);
    }
  }
  bake.dispose();
});

test("reviewed head crops keep atlas faces off an authored neck and retain subject-specific hair", async () => {
  const group = body(); group.userData.inputKind = "anatomical-template";
  group.userData.templateHeadYaw = 0;
  group.userData.anatomicalFit = { headPivot: [0, 1.4, 0], headFadeStartY: 1.4,
    headFadeEndY: 1.5, headChinY: 1.5, referenceHeight: 1.76 };
  group.userData.templateSourceFaceBox = [0.1, 0.25, 0.4, 0.75];
  group.userData.templateSourceNeckBox = [0.42, 0.35, 0.55, 0.65];
  const head = group.getObjectByName("head") as THREE.Mesh;
  head.geometry = new THREE.BoxGeometry(0.28, 0.42, 0.23, 6, 24, 2); head.position.y = 1.55;
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.2), new THREE.MeshBasicMaterial({ vertexColors: true }));
  hair.name = "Hair"; hair.position.set(0, 1.72, -0.03);
  hair.userData.sourceHair = true; hair.userData.preserveVertexColors = true;
  hair.geometry.setAttribute("color", new THREE.Float32BufferAttribute(
    new Float32Array(hair.geometry.getAttribute("position").count * 3).fill(0.012), 3));
  group.add(hair);
  // Geometry-only fixtures deliberately bypass the independently tested UV baker.
  group.traverse((object) => { const mesh = object as THREE.Mesh; if (mesh.isMesh) mesh.geometry.deleteAttribute("uv"); });
  const neckColor = [114, 78, 49], observedFaceDetail = [190, 60, 95], erroneousAtlasFace = [230, 23, 62];
  const photograph = pixels((y) => y < 0.41 ? observedFaceDetail : y < 0.6 ? neckColor : shirtColor);
  await fitNeuralHumanPhotographs(group, { source: photograph, mask,
    appearance: { ...appearance, faceBox: [0.1, 0.25, 0.6, 0.75] },
    photographicBody: { front: pixels(() => erroneousAtlasFace), back } });
  const position = head.geometry.getAttribute("position"), normal = head.geometry.getAttribute("normal");
  const colors = head.geometry.getAttribute("color"); const neckSamples: number[][] = [], faceSamples: number[][] = [];
  for (let i = 0; i < position.count; i++) {
    if (normal.getZ(i) < 0.99) continue;
    const y = position.getY(i) + head.position.y;
    const sample = [colors.getX(i), colors.getY(i), colors.getZ(i)];
    if (y < 1.5) neckSamples.push(sample); else faceSamples.push(sample);
  }
  assert.ok(includes(neckSamples, linear(neckColor)), "the original neck gets its own crop below the chin");
  assert.equal(includes(neckSamples, linear(erroneousAtlasFace)), false, "generated facial details never paint the neck");
  assert.equal(includes(neckSamples, linear(observedFaceDetail)), false, "the mouth cannot extend below the reviewed chin");
  assert.ok(includes(faceSamples, linear(observedFaceDetail)), "the reviewed crop still restores observed facial pixels");
  assert.ok(Array.from(hair.geometry.getAttribute("color").array).every((v) => Math.abs(v - 0.012) < 1e-6),
    "a grafted source-specific cap retains its learned colors");
  assert.deepEqual(group.userData.photoFit.sourceFaceBox, group.userData.templateSourceFaceBox);
});

test("authored landmarks follow loader scale and centering before a head turns", async () => {
  const owner = body();
  const oldHead = owner.getObjectByName("head")!; owner.remove(oldHead);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 1.4, 0.12, 0, 1.5, 0.12, 0.1, 1.6, 0.22, 0, 1.76, 0.02], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const head = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); head.name = "Head"; owner.add(head);
  owner.userData.anatomicalFit = { headPivot: [0, 1.4, 0.02], headFadeStartY: 1.4,
    headFadeEndY: 1.5, headChinY: 1.5, referenceHeight: 1.76 };
  owner.scale.setScalar(0.8); owner.position.set(0.03, 0.15, -0.05);
  const group = new THREE.Group(); group.userData.inputKind = "anatomical-template";
  group.userData.templateHeadYaw = Math.PI / 2; group.add(owner);
  group.traverse((object) => { const mesh = object as THREE.Mesh; if (mesh.isMesh) mesh.geometry.deleteAttribute("uv"); });
  await fitNeuralHumanPhotographs(group, { source, mask, appearance: { ...appearance, faceBox: undefined } });
  const position = geometry.getAttribute("position");
  assert.ok(Math.abs(position.getX(2) - 0.2) < 1e-6 && Math.abs(position.getZ(2) + 0.08) < 1e-6,
    "rotation remains about the authored neck after loader recentering");
  assert.ok(Math.abs(position.getX(0)) < 1e-6 && Math.abs(position.getZ(0) - 0.12) < 1e-6,
    "the neck attachment remains fixed in its authored coordinates");
  assert.ok(Math.abs(group.userData.photoFit.chin - 1.35) < 1e-6,
    "the chin uses the scene transform once, without an extra height fit");
});
