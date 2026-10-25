import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { capturePosePhotographs } from "./posed-human-photographs";

test("shape comparisons retain fitted pixels after the previous body's materials are disposed", () => {
  const map = new THREE.DataTexture(new Uint8Array([209, 75, 36, 255]), 1, 1);
  map.colorSpace = THREE.SRGBColorSpace;
  map.repeat.set(2, 3);
  map.offset.set(0.1, 0.2);
  const original = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  const source = new THREE.Group(),
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(), original);
  mesh.name = "Shirt";
  source.add(mesh);
  source.userData.humanPoseFitted = true;
  const capture = capturePosePhotographs(source);
  const target = new THREE.Group(),
    neutral = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const next = new THREE.Mesh(mesh.geometry.clone(), neutral);
  next.name = "Shirt";
  target.add(next);
  const installed = capture(target),
    material = next.material as THREE.MeshBasicMaterial;
  assert.notEqual(material, original);
  assert.notEqual(material.map, map);
  assert.deepEqual(Array.from(material.map!.image.data), [209, 75, 36, 255]);
  assert.equal(material.map!.colorSpace, THREE.SRGBColorSpace);
  assert.deepEqual(material.map!.repeat.toArray(), [2, 3]);
  assert.equal(target.userData.humanPoseFitted, true);
  // Real selection sequence: A is removed after B is installed. Selecting C
  // later still reads the initial photographic cache, never B's ownership.
  map.dispose();
  original.dispose();
  const third = new THREE.Group(),
    thirdNeutral = neutral.clone();
  const finalMesh = new THREE.Mesh(mesh.geometry.clone(), thirdNeutral);
  finalMesh.name = "Shirt";
  third.add(finalMesh);
  const finalInstalled = capture(third),
    finalMaterial = finalMesh.material as THREE.MeshBasicMaterial;
  assert.notEqual(finalMaterial, material);
  assert.notEqual(finalMaterial.map, material.map);
  assert.notEqual(finalMaterial.map, map);
  let finalReleased = 0;
  finalMaterial.map!.addEventListener("dispose", () => finalReleased++);
  let released = 0;
  material.map!.addEventListener("dispose", () => released++);
  installed.dispose();
  installed.dispose();
  assert.equal(released, 1);
  assert.equal(finalReleased, 0, "disposing B cannot release C's texture");
  assert.deepEqual(
    Array.from(finalMaterial.map!.image.data),
    [209, 75, 36, 255],
  );
  assert.deepEqual(finalMaterial.map!.offset.toArray(), [0.1, 0.2]);
  assert.equal(next.material, neutral);
  finalInstalled.dispose();
  finalInstalled.dispose();
  assert.equal(finalReleased, 1);
  assert.equal(finalMesh.material, thirdNeutral);
  neutral.dispose();
  thirdNeutral.dispose();
  finalMesh.geometry.dispose();
  mesh.geometry.dispose();
  next.geometry.dispose();
});
