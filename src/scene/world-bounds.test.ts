import assert from "node:assert/strict";
import test from "node:test";
import {
  insideWorldEnclosure,
  constrainToWorldEnclosure,
} from "./world-bounds";
test("walking cannot cross the round walls through rectangular navigation corners", () => {
  const point = { x: 20, y: 1.6, z: -29 };
  assert.equal(insideWorldEnclosure(point), false);
  constrainToWorldEnclosure(point);
  assert.ok(Math.hypot(point.x, point.z + 8) <= 24 + 1e-12);
  assert.equal(point.y, 1.6);
  assert.ok(Math.abs(point.x / (point.z + 8) - 20 / -21) < 1e-10);
});
test("valid walk and teleport destinations remain unchanged", () => {
  for (const point of [
    { x: 0, z: 0 },
    { x: 4, z: -7 },
    { x: -12, z: -14 },
  ]) {
    const original = { ...point };
    assert.equal(insideWorldEnclosure(point), true);
    constrainToWorldEnclosure(point);
    assert.deepEqual(point, original);
  }
});
test("invalid and distant teleport destinations are rejected", () => {
  assert.equal(insideWorldEnclosure({ x: Infinity, z: 0 }), false);
  assert.equal(insideWorldEnclosure({ x: 0, z: -33 }), false);
  assert.equal(insideWorldEnclosure({ x: 0, z: 17 }), false);
  assert.deepEqual(constrainToWorldEnclosure({ x: NaN, z: 2 }), { x: 0, z: 0 });
});
