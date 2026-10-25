export interface WorldObstacle {
  kind?: "box";
  x: number;
  z: number;
  radiusX: number;
  radiusZ: number;
  minY: number;
  maxY: number;
}
type Point = { x: number; y: number; z: number };
export function insideObstacle(
  point: Point,
  obstacle: WorldObstacle,
  eyeHeight = point.y,
) {
  if (eyeHeight < obstacle.minY || eyeHeight - 0.45 > obstacle.maxY)
    return false;
  const x = (point.x - obstacle.x) / (obstacle.radiusX + 0.18);
  const z = (point.z - obstacle.z) / (obstacle.radiusZ + 0.18);
  return obstacle.kind === "box"
    ? Math.abs(x) < 1 - 1e-9 && Math.abs(z) < 1 - 1e-9
    : x * x + z * z < 1 - 1e-9;
}
/** Resolve the shallowest wall penetration so walking along a facade slides. */
export function moveOutsideObstacle(point: Point, obstacle: WorldObstacle) {
  if (!insideObstacle(point, obstacle)) return;
  const rx = obstacle.radiusX + 0.18,
    rz = obstacle.radiusZ + 0.18;
  const dx = point.x - obstacle.x,
    dz = point.z - obstacle.z;
  if (obstacle.kind === "box") {
    if (rx - Math.abs(dx) < rz - Math.abs(dz))
      point.x = obstacle.x + (dx < 0 ? -rx : rx);
    else point.z = obstacle.z + (dz < 0 ? -rz : rz);
    return;
  }
  const x = dx / rx,
    z = dz / rz,
    distance = Math.hypot(x, z);
  if (distance < 0.001) point.z = obstacle.z + rz;
  else {
    point.x = obstacle.x + (x / distance) * rx;
    point.z = obstacle.z + (z / distance) * rz;
  }
}
