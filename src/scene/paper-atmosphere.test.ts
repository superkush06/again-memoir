import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildPaperAtmosphere } from "./paper-atmosphere";

test("paper atmosphere frames XR without covering the center", () => {
  const group = buildPaperAtmosphere({
    target: [0, 1.6, -5],
    front: [0, 1.6, 0],
    frontTarget: [0, 1.6, -5],
    side: [6, 1.8, -5],
    behind: [0, 1.8, -13],
    bounds: { min: [-5, 0, -12], max: [5, 4, 2] },
  });

  assert.equal(group.visible, false);
  assert.equal(group.children.length, 5);
  assert.equal(group.userData.worldLocked, true);
  assert.equal(
    group.children.some((child) => child.position.length() < 3),
    false,
  );

  for (const child of group.children) {
    const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false);
    assert.ok(material.opacity >= 0.2 && material.opacity <= 0.35);
  }
});
