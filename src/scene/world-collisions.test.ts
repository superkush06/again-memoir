import test from "node:test";
import assert from "node:assert/strict";
import {
  insideObstacle,
  moveOutsideObstacle,
  type WorldObstacle,
} from "./world-collisions";

test("building corners block walking and resolve to the nearest wall", () => {
  const building: WorldObstacle = {
    kind: "box",
    x: 9,
    z: -4,
    radiusX: 2,
    radiusZ: 3,
    minY: 0,
    maxY: 8,
  };
  const point = { x: 7.1, y: 1.6, z: -1.3 };
  assert.ok(insideObstacle(point, building));
  moveOutsideObstacle(point, building);
  assert.ok(!insideObstacle(point, building));
  assert.ok(Math.abs(point.x - 6.82) < 1e-8);
});
test("human collision retains round sliding and permits movement above a subject", () => {
  const body: WorldObstacle = {
    x: 0,
    z: 0,
    radiusX: 0.35,
    radiusZ: 0.2,
    minY: 0,
    maxY: 1.8,
  };
  const point = { x: 0, y: 1.6, z: 0 };
  moveOutsideObstacle(point, body);
  assert.equal(point.z, 0.38);
  assert.equal(insideObstacle({ x: 0, y: 3, z: 0 }, body), false);
});
