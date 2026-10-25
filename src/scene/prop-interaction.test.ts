import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PropInteraction } from "./prop-interaction";

function fixture(movable = true) {
  const world = new THREE.Group(),
    group = new THREE.Group(),
    hand = new THREE.Group();
  group.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.3, 0.1),
      new THREE.MeshBasicMaterial(),
    ),
  );
  group.position.set(0, 1, -2);
  world.add(group, hand);
  const prop = { id: "phone-1", label: "Phone", group, movable };
  const interaction = new PropInteraction([prop]);
  return { world, group, hand, prop, interaction };
}

test("grabbing and releasing preserve location and orientation while following a moved controller", () => {
  const { world, group, hand, prop, interaction } = fixture();
  hand.position.set(1, 1, 0);
  const initial = group.getWorldPosition(new THREE.Vector3());
  assert.ok(interaction.grab(prop, hand));
  assert.ok(
    group.getWorldPosition(new THREE.Vector3()).distanceTo(initial) < 1e-9,
  );
  hand.position.x += 0.7;
  const held = group.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(held.x - 0.7) < 1e-9);
  interaction.release(hand);
  assert.equal(group.parent, world);
  assert.ok(
    group.getWorldPosition(new THREE.Vector3()).distanceTo(held) < 1e-9,
  );
  interaction.reset();
  assert.ok(group.position.distanceTo(initial) < 1e-9);
});

test("video props cannot be selected or grabbed, and one object cannot be held twice", () => {
  const locked = fixture(false);
  const ray = new THREE.Raycaster(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, -1),
  );
  assert.equal(locked.interaction.pick(ray), undefined);
  assert.equal(locked.interaction.grab(locked.prop, locked.hand), false);
  const photo = fixture();
  assert.equal(photo.interaction.pick(ray)?.prop, photo.prop);
  assert.equal(photo.interaction.pick(ray, 1), undefined);
  assert.equal(photo.interaction.grab(photo.prop, photo.hand), true);
  assert.equal(photo.interaction.grab(photo.prop, new THREE.Group()), false);
});

test("release corrects floor penetration and cleanup returns held props before world disposal", () => {
  const { world, group, hand, prop, interaction } = fixture();
  interaction.grab(prop, hand);
  hand.position.y = -5;
  interaction.releaseAll();
  assert.equal(group.parent, world);
  assert.ok(new THREE.Box3().setFromObject(group).min.y >= 0.0149);
  assert.equal(interaction.holding(hand), undefined);
});
