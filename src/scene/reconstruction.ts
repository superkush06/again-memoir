import * as THREE from 'three';

export interface DepthPixels { width: number; height: number; data: ArrayLike<number> }
export interface ProjectionOptions { near?: number; far?: number; fov?: number; aspect?: number; strength?: number }

/** Deproject the estimated inverse-depth image. White is close; black is distant.
 * Moving each pixel along its camera ray preserves the photograph at its source viewpoint.
 * Triangles across occlusion boundaries are deliberately omitted instead of stretching faces.
 */
export function createDepthGeometry(depth: DepthPixels, options: ProjectionOptions = {}) {
  const { width, height, data } = depth;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || data.length < width * height * 4) throw new Error('A complete depth image of at least 2 × 2 pixels is required.');
  const near = options.near ?? 2;
  const far = options.far ?? 12;
  const fov = options.fov ?? 60;
  const strength = options.strength ?? 1;
  const aspect = options.aspect ?? width / height;
  if (![near, far, fov, aspect, strength].every(Number.isFinite) || !(near > 0 && far > near && fov > 0 && fov < 150 && aspect > 0 && strength > 0)) throw new Error('Invalid depth projection.');
  const positions = new Float32Array(width * height * 3);
  const uvs = new Float32Array(width * height * 2);
  const distances = new Float32Array(width * height);
  const indices: number[] = [];
  const edges = new Set<number>();
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const u = x / (width - 1);
      const v = y / (height - 1);
      const inverseDepth = Math.min(1, Math.max(0, Number(data[i * 4]) / 255));
      const distance = near + (1 / (inverseDepth / near + (1 - inverseDepth) / far) - near) * strength;
      distances[i] = distance;
      positions[i * 3] = (u * 2 - 1) * halfHeight * aspect * distance;
      positions[i * 3 + 1] = (1 - v * 2) * halfHeight * distance + 1.6;
      positions[i * 3 + 2] = -distance;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = 1 - v;
    }
  }
  const triangle = (a: number, b: number, c: number) => {
    const closest = Math.min(distances[a], distances[b], distances[c]);
    const spread = Math.max(distances[a], distances[b], distances[c]) - closest;
    // Relative threshold tolerates distant sloping surfaces while cutting foreground silhouettes.
    if (spread > Math.max(.24 * strength, closest * .12)) { edges.add(a); edges.add(b); edges.add(c); }
    else indices.push(a, b, c);
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = y * width + x;
      triangle(a, a + width, a + 1);
      triangle(a + 1, a + width, a + width + 1);
    }
  }
  return { positions, uvs, indices: new Uint32Array(indices), distances, edgeVertexIndices: new Uint32Array(edges) };
}

export { buildReconstruction } from './volume-world';
export type { Reconstruction, ReconstructionInput } from './volume-world';
