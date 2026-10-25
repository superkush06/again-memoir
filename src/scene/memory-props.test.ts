import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  MEMORY_OBJECT_CATEGORIES,
  type MemoryObjectSpec,
} from "../memory-objects";
import { buildMemoryProp, placeMemoryProp } from "./memory-props";

const source = { width: 4, height: 4, data: new Uint8Array(64) };
for (let y = 0; y < 4; y++)
  for (let x = 0; x < 4; x++)
    source.data.set([x * 50, y * 50, 160, 255], (y * 4 + x) * 4);
const object: MemoryObjectSpec = {
  category: "drink-can",
  confidence: 0.95,
  color: "#cf231b",
  dimensions: [0.067, 0.123, 0.067],
};

test("all common props have complete centered metric bounds and photographed color", () => {
  for (const category of MEMORY_OBJECT_CATEGORIES) {
    const dimensions: [number, number, number] = [0.3, 0.4, 0.12];
    const prop = buildMemoryProp({
      id: category,
      label: category,
      object: { ...object, category, dimensions },
      source,
      box: [0.25, 0.25, 0.75, 0.75],
    });
    const bounds = new THREE.Box3().setFromObject(prop.group);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    assert.ok(center.length() < 1e-6, `${category} grab pivot stays centered`);
    size
      .toArray()
      .forEach((dimension, i) =>
        assert.ok(
          Math.abs(dimension - dimensions[i]) < 1e-6,
          `${category} dimension ${i}`,
        ),
      );
    let colored = false;
    const textures = new Set<THREE.Texture>();
    prop.group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      assert.equal(node.castShadow, true);
      assert.equal(node.receiveShadow, true);
      assert.ok(
        Array.from(node.geometry.getAttribute("position").array).every(
          Number.isFinite,
        ),
      );
      for (const mat of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
        colored ||= mat.color.getHexString() === "cf231b";
        if (mat.map) textures.add(mat.map);
      }
    });
    assert.ok(colored, `${category} retains inferred source material color`);
    assert.equal(
      textures.size,
      1,
      `${category} shares its own crop across details`,
    );
    const texture = [...textures][0] as THREE.DataTexture;
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.deepEqual(
      Array.from(texture.image.data.slice(0, 4)),
      [50, 100, 160, 255],
      "front crop retains RGB and correct +Y orientation",
    );
    prop.dispose();
  }
});

test("moving and disposing one prop does not affect another object's resources", () => {
  const make = (id: string) =>
    buildMemoryProp({ id, label: id, object, source, box: [0, 0, 1, 1] });
  const first = make("first"),
    second = make("second");
  const world = new THREE.Group(),
    controller = new THREE.Group();
  world.add(first.group, second.group, controller);
  first.group.position.set(1, 2, -3);
  world.updateMatrixWorld(true);
  controller.attach(first.group);
  controller.position.set(0, 1, 0);
  world.updateMatrixWorld(true);
  assert.deepEqual(
    first.group.getWorldPosition(new THREE.Vector3()).toArray(),
    [1, 3, -3],
  );
  assert.deepEqual(second.group.position.toArray(), [0, 0, 0]);
  const resources = (group: THREE.Group) => {
    const result = new Set<
      THREE.BufferGeometry | THREE.Material | THREE.Texture
    >();
    group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      result.add(node.geometry);
      for (const mat of Array.isArray(node.material)
        ? node.material
        : [node.material]) {
        result.add(mat);
        if (mat instanceof THREE.MeshStandardMaterial && mat.map)
          result.add(mat.map);
      }
    });
    return result;
  };
  const a = resources(first.group),
    b = resources(second.group);
  assert.ok([...a].every((resource) => !b.has(resource)));
  let disposed = 0;
  a.forEach((resource) =>
    resource.addEventListener("dispose", () => {
      disposed++;
    }),
  );
  first.dispose();
  first.dispose();
  assert.equal(disposed, a.size);
  assert.equal(first.group.parent, null);
  assert.equal(second.group.parent, world);
  second.dispose();
});

test("placement keeps the photographed center and bounded physical size despite background depth", () => {
  const box: [number, number, number, number] = [0.53, 0.63, 0.63, 0.69];
  const depth = { width: 40, height: 30, data: new Uint8Array(40 * 30 * 4) };
  for (const backgroundDepth of [0, 128, 255]) {
    depth.data.fill(backgroundDepth);
    const placement = placeMemoryProp({
      box,
      depth,
      object,
      cameraHeight: 1.1,
    });
    const [x, y, z] = placement.position;
    const halfHeight = Math.tan(Math.PI / 6);
    const u = 0.5 + x / ((-z * 2 * halfHeight * 4) / 3);
    const v = 0.5 - (y - 1.1) / (-z * 2 * halfHeight);
    assert.ok(Math.abs(u - 0.66) < 1e-9);
    assert.ok(Math.abs(v - 0.58) < 1e-9);
    assert.ok(placement.scale >= 0.75 && placement.scale <= 1.5);
    const apparentHeight =
      (object.dimensions[1] * placement.scale) / (-z * 2 * halfHeight);
    assert.ok(
      Math.abs(apparentHeight - 0.1) < 1e-9,
      "projected full 3D object matches photographed size",
    );
    assert.ok(
      -z < 2,
      "far background does not send a hand-held object many metres away",
    );
  }
});

test("placement excludes background samples outside the object mask and handles orientation", () => {
  const depth = { width: 10, height: 10, data: new Uint8Array(400) };
  const mask = { width: 10, height: 10, data: new Uint8Array(400) };
  const box: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];
  const rotated: MemoryObjectSpec = {
    ...object,
    category: "phone",
    dimensions: [0.075, 0.15, 0.01],
    rotation: [0, 0, Math.PI / 2],
  };
  for (let y = 3; y <= 6; y++)
    for (let x = 3; x <= 6; x++) {
      mask.data[(y * 10 + x) * 4] = 255;
      depth.data[(y * 10 + x) * 4] = 230;
    }
  const masked = placeMemoryProp({ box, depth, mask, object: rotated });
  const uniform = placeMemoryProp({
    box,
    depth: { ...depth, data: new Uint8Array(400).fill(230) },
    object: rotated,
  });
  assert.deepEqual(masked, uniform);
  assert.ok(masked.position.every(Number.isFinite));
  const built = buildMemoryProp({
    id: "rotated-phone",
    label: "phone",
    object: rotated,
    source,
    box,
  });
  const size = new THREE.Box3()
    .setFromObject(built.group)
    .getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 0.15) < 1e-6);
  assert.ok(Math.abs(size.y - 0.075) < 1e-6);
  built.dispose();
});
