/** The visible depth samples and inferred rear surface share a boundary. Every
 * exposed grid edge is closed with a side wall, including holes in silhouettes. */
export interface VolumePixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}
export interface VolumeProjection {
  positions: Float32Array;
  uvs: Float32Array;
}
export interface VolumeResult {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  frontIndexCount: number;
  vertexCount: number;
  thickness: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const linear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

export function createClosedVolume(
  projected: VolumeProjection,
  mask: VolumePixels,
  source: VolumePixels,
  thickness = 0.7,
): VolumeResult {
  const { width: w, height: h } = mask;
  if (
    w < 3 ||
    h < 3 ||
    source.width !== w ||
    source.height !== h ||
    mask.data.length < w * h * 4 ||
    source.data.length < w * h * 4 ||
    projected.positions.length !== w * h * 3 ||
    projected.uvs.length !== w * h * 2 ||
    !Number.isFinite(thickness) ||
    thickness <= 0
  )
    throw new Error(
      "A matching source, projection and silhouette are required.",
    );
  const active = new Uint8Array((w - 1) * (h - 1));
  const used = new Set<number>();
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      // Requiring all corners avoids a second subject becoming joined at a diagonal.
      const corners = [i, i + 1, i + w, i + w + 1];
      if (corners.every((p) => Number(mask.data[p * 4]) >= 90)) {
        active[y * (w - 1) + x] = 1;
        corners.forEach((p) => used.add(p));
      }
    }
  if (used.size < 4) throw new Error("The silhouette has no enclosed area.");
  const original = Array.from(used).sort((a, b) => a - b);
  // Semantic silhouettes occasionally include a few background pixels. Keep
  // those estimates from turning a person's outer edge into a many-meter tent.
  const depthSamples = original
    .map((i) => -projected.positions[i * 3 + 2])
    .sort((a, b) => a - b);
  const medianDepth = depthSamples[Math.floor(depthSamples.length / 2)];
  const residualLimit = Math.min(0.2, thickness * 0.25);
  const lookup = new Map(original.map((id, i) => [id, i]));
  const n = original.length;
  const fronts: number[] = [];
  const backs: number[] = [];
  const sides: number[] = [];
  const edgeCounts = new Map<string, { a: number; b: number; count: number }>();
  const triangle = (a: number, b: number, c: number) => {
    fronts.push(a, b, c);
    backs.push(c + n, b + n, a + n);
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`;
      const edge = edgeCounts.get(key);
      if (edge) edge.count++;
      else edgeCounts.set(key, { a: from, b: to, count: 1 });
    }
  };
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++)
      if (active[y * (w - 1) + x]) {
        const i = y * w + x;
        const a = lookup.get(i)!;
        const b = lookup.get(i + 1)!;
        const c = lookup.get(i + w)!;
        const d = lookup.get(i + w + 1)!;
        triangle(a, c, b);
        triangle(b, c, d);
      }
  const boundary = new Set<number>();
  for (const edge of edgeCounts.values())
    if (edge.count === 1) {
      const { a, b } = edge;
      boundary.add(original[a]);
      boundary.add(original[b]);
      sides.push(b, a, a + n, b, a + n, b + n);
    }
  // An inward distance transform gives the rear of each disconnected silhouette
  // a rounded belly, while retaining the photograph's distinct arms, legs and gaps.
  const distance = new Float32Array(w * h).fill(1e6);
  for (const i of original) if (boundary.has(i)) distance[i] = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lookup.has(i)) {
        distance[i] = 0;
        continue;
      }
      if (x) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y) distance[i] = Math.min(distance[i], distance[i - w] + 1);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < h - 1) distance[i] = Math.min(distance[i], distance[i + w] + 1);
    }
  const maxDistance = Math.max(1, ...original.map((i) => distance[i]));
  const positions = new Float32Array(n * 6);
  const uvs = new Float32Array(n * 4);
  const colors = new Float32Array(n * 6);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // Row medians extend garment/material color around an object without painting
  // a second face or a mirrored copy of the photograph on its inferred back.
  const rowColors: number[][] = Array.from({ length: h }, () => []);
  for (let y = 0; y < h; y++) {
    const ids = original.filter((i) => Math.floor(i / w) === y);
    if (!ids.length) {
      rowColors[y] = [0.3, 0.3, 0.3];
      continue;
    }
    rowColors[y] = [0, 1, 2].map((c) => {
      const samples = ids
        .map((i) => Number(source.data[i * 4 + c]) / 255)
        .sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)];
    });
  }
  for (let j = 0; j < n; j++) {
    const i = original[j];
    const y = Math.floor(i / w);
    const roundness = Math.sqrt(distance[i] / maxDistance);
    const rearOffset = thickness * (0.18 + 0.92 * roundness);
    const observedDistance = -projected.positions[i * 3 + 2];
    // Relative depth locates separate subjects in the world, but its noisy edges
    // cannot describe the hidden thickness of a body. Smooth and retain a small
    // surface residual, then add a coherent rounded body in object space.
    let smoothedDepth = 0;
    let weight = 0;
    const x = i % w;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
        const neighbor = i + dy * w + dx;
        if (!lookup.has(neighbor)) continue;
        const sampleWeight = (3 - Math.abs(dx)) * (3 - Math.abs(dy));
        smoothedDepth +=
          Math.max(
            medianDepth - 0.5,
            Math.min(medianDepth + 0.5, -projected.positions[neighbor * 3 + 2]),
          ) * sampleWeight;
        weight += sampleWeight;
      }
    smoothedDepth /= Math.max(1, weight);
    const residual = Math.max(
      -residualLimit,
      Math.min(residualLimit, (smoothedDepth - medianDepth) * 0.4),
    );
    const clampedDistance = Math.max(
      0.1,
      medianDepth + residual - roundness * thickness * 0.2,
    );
    const scale = clampedDistance / observedDistance;
    for (let side = 0; side < 2; side++) {
      const dst = j + side * n;
      for (let c = 0; c < 3; c++) {
        // Rescale along the original camera ray to retain exactly the same pixel.
        const visibleValue =
          c === 1
            ? (projected.positions[i * 3 + c] - 1.6) * scale + 1.6
            : projected.positions[i * 3 + c] * scale;
        const value = visibleValue - (side && c === 2 ? rearOffset : 0);
        positions[dst * 3 + c] = value;
        min[c] = Math.min(min[c], value);
        max[c] = Math.max(max[c], value);
        const sourceColor = Number(source.data[i * 4 + c]) / 255;
        const nearby =
          rowColors[y][c] * 0.6 +
          rowColors[Math.max(0, y - 2)][c] * 0.2 +
          rowColors[Math.min(h - 1, y + 2)][c] * 0.2;
        colors[dst * 3 + c] = linear(
          side ? nearby * 0.93 + sourceColor * 0.07 : sourceColor,
        );
      }
      uvs[dst * 2] = projected.uvs[i * 2];
      uvs[dst * 2 + 1] = projected.uvs[i * 2 + 1];
    }
  }
  return {
    positions,
    uvs,
    colors,
    indices: new Uint32Array([...fronts, ...backs, ...sides]),
    frontIndexCount: fronts.length,
    vertexCount: n,
    thickness,
    bounds: { min, max },
  };
}

/** Subject-free fallback for old saved scenes. Connected near-depth regions are
 * split before inflation; this never substitutes a generic character model. */
export function depthSilhouettes(
  depth: VolumePixels,
  maximum = 6,
): VolumePixels[] {
  const { width: w, height: h } = depth;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < w * h; i++)
    histogram[Math.round(Number(depth.data[i * 4]))]++;
  let cumulative = 0;
  let threshold = 150;
  for (let value = 0; value < 256; value++) {
    cumulative += histogram[value];
    if (cumulative >= w * h * 0.65) {
      threshold = Math.max(90, value);
      break;
    }
  }
  const seen = new Uint8Array(w * h);
  const regions: number[][] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || Number(depth.data[start * 4]) < threshold) continue;
    const region = [start];
    seen[start] = 1;
    for (let q = 0; q < region.length; q++) {
      const i = region[q];
      const x = i % w;
      const y = Math.floor(i / w);
      const neighbors = [
        x ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ];
      for (const other of neighbors)
        if (
          other >= 0 &&
          !seen[other] &&
          Number(depth.data[other * 4]) >= threshold
        ) {
          seen[other] = 1;
          region.push(other);
        }
    }
    if (region.length >= w * h * 0.006 && region.length < w * h * 0.65)
      regions.push(region);
  }
  return regions
    .sort((a, b) => b.length - a.length)
    .slice(0, maximum)
    .map((region) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (const i of region) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
        data[i * 4 + 3] = 255;
      }
      return { width: w, height: h, data };
    });
}
