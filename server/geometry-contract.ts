import type { RawDepthMap } from './depth-model.js';

/** Names are deliberately broader than the current default so an M5 runner can be plugged in without changing the app API. */
export const GEOMETRY_BACKENDS = ['depth-anything-v2', 'depth-pro', 'moge', 'vggt', 'vggt-omega', 'sam-3d-body', 'hunyuanworld', 'hunyuan3d', 'colmap-gsplat', 'external'] as const;
export type GeometryBackendName = typeof GEOMETRY_BACKENDS[number];

export type GeometryStats = {
  width: number;
  height: number;
  min: number;
  max: number;
  range: number;
  mean: number;
  finiteRatio: number;
  variance: number;
};

export type GeometryBenchmarkResult = {
  backend: GeometryBackendName;
  input: string;
  elapsedMs: number;
  stats: GeometryStats;
  valid: boolean;
  geometryVertices?: number;
  geometryTriangles?: number;
  error?: string;
};

export function normalizeBackend(value: string | undefined): GeometryBackendName {
  return GEOMETRY_BACKENDS.includes(value as GeometryBackendName)
    ? value as GeometryBackendName
    : 'depth-anything-v2';
}

/** Keep the fast, stable path as the default; use an M5 backend only explicitly. */
export function selectGeometryBackend(options: { requested?: string; highQuality?: boolean; m5Available?: boolean } = {}): GeometryBackendName {
  const requested = normalizeBackend(options.requested);
  if (options.requested && GEOMETRY_BACKENDS.includes(options.requested as GeometryBackendName)) return requested;
  return options.highQuality && options.m5Available ? 'external' : 'depth-anything-v2';
}

export function inspectRawDepth(depth: RawDepthMap): GeometryStats {
  if (!Number.isInteger(depth.width) || !Number.isInteger(depth.height) || depth.width < 2 || depth.height < 2 || depth.data.length < depth.width * depth.height) {
    throw new Error('Depth map is truncated or too small.');
  }
  let min = Infinity; let max = -Infinity; let sum = 0; let sumSquares = 0; let finite = 0;
  for (let i = 0; i < depth.width * depth.height; i++) {
    const value = depth.data[i];
    if (!Number.isFinite(value)) continue;
    finite++; min = Math.min(min, value); max = Math.max(max, value); sum += value; sumSquares += value * value;
  }
  const count = depth.width * depth.height;
  const mean = finite ? sum / finite : 0;
  return { width: depth.width, height: depth.height, min: finite ? min : 0, max: finite ? max : 0, range: finite ? max - min : 0, mean, finiteRatio: finite / count, variance: finite ? Math.max(0, sumSquares / finite - mean * mean) : 0 };
}

export function validateGeometryStats(stats: GeometryStats): string | undefined {
  if (![stats.width, stats.height, stats.min, stats.max, stats.range, stats.mean, stats.finiteRatio, stats.variance].every(Number.isFinite)) return 'non-finite geometry statistics';
  if (stats.width < 2 || stats.height < 2) return 'geometry is too small';
  if (stats.finiteRatio < 0.995) return 'depth contains too many non-finite values';
  if (stats.range <= 0) return 'depth has no usable variation';
  return undefined;
}

