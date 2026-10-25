export const MEMORY_WORLD_CENTER_Z = -8;
export const MEMORY_WORLD_RADIUS = 24;
/** A 24m walking radius stays inside the flat facets of the 25m enclosing room. */
export function insideWorldEnclosure(point: { x: number; z: number }): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.z) &&
    Math.hypot(point.x, point.z - MEMORY_WORLD_CENTER_Z) <= MEMORY_WORLD_RADIUS
  );
}
export function constrainToWorldEnclosure<T extends { x: number; z: number }>(
  point: T,
): T {
  const dz = point.z - MEMORY_WORLD_CENTER_Z;
  const distance = Math.hypot(point.x, dz);
  if (!Number.isFinite(distance)) {
    point.x = 0;
    point.z = 0;
  } else if (distance > MEMORY_WORLD_RADIUS) {
    point.x *= MEMORY_WORLD_RADIUS / distance;
    point.z = MEMORY_WORLD_CENTER_Z + (dz * MEMORY_WORLD_RADIUS) / distance;
  }
  return point;
}
