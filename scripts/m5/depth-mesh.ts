import { createDepthGeometry } from '../../src/scene/reconstruction.js';
import type { RawDepthMap } from '../../server/depth-model.js';

/** Production samples retained photo depth at up to 384px on the long edge before meshing. */
export const MESH_LONG_EDGE = 384;

/**
 * Metric depth becomes inverse depth so every backend matches DA2's larger-is-nearer
 * convention. Infinite depth (sky) is a valid far plane, 0; only NaN stays invalid.
 */
export const toInverse = (data: Float32Array, kind: string) => kind === 'metric' ? data.map(depth => (depth === Infinity ? 0 : depth > 0 && Number.isFinite(depth) ? 1 / depth : NaN)) : data;

export function resample(map: RawDepthMap, width: number, height: number, mode: 'nearest' | 'bilinear'): RawDepthMap {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = ((x + 0.5) * map.width) / width - 0.5; const sy = ((y + 0.5) * map.height) / height - 0.5;
    const at = (px: number, py: number) => map.data[Math.min(map.height - 1, Math.max(0, py)) * map.width + Math.min(map.width - 1, Math.max(0, px))];
    if (mode === 'nearest') { data[y * width + x] = at(Math.round(sx), Math.round(sy)); continue; }
    const x0 = Math.floor(sx); const y0 = Math.floor(sy); const fx = sx - x0; const fy = sy - y0;
    data[y * width + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
  return { data, width, height };
}

/** Min-max to 8-bit like the production depth pipeline, then the production mesh builder. */
export function buildMesh(map: RawDepthMap) {
  const scale = MESH_LONG_EDGE / Math.max(map.width, map.height);
  const grid = scale < 1 ? resample(map, Math.round(map.width * scale), Math.round(map.height * scale), 'nearest') : map;
  let min = Infinity; let max = -Infinity;
  for (const value of grid.data) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  const rgba = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let i = 0; i < grid.width * grid.height; i++) { rgba[i * 4] = Number.isFinite(grid.data[i]) ? Math.round(((grid.data[i] - min) / Math.max(max - min, Number.EPSILON)) * 255) : 0; rgba[i * 4 + 3] = 255; }
  return { grid, mesh: createDepthGeometry({ width: grid.width, height: grid.height, data: rgba, channels: 4 } as never) };
}
