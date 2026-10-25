import type { VolumePixels } from "./volume";

export interface EnvironmentPatch {
  region: [number, number, number, number];
  color: [number, number, number];
  reliable: boolean;
}

/** Look for a small continuous floor material, excluding people and inpainted holes.
 * A garment, date stamp or propagated silhouette must never tile over the room. */
export function selectGroundPatch(source: VolumePixels, excluded?: VolumePixels): EnvironmentPatch {
  let best: { score: number; patch: EnvironmentPatch } | undefined;
  const maskAt = (u: number, v: number) => {
    if (!excluded) return false;
    const x = Math.min(excluded.width - 1, Math.floor(u * excluded.width));
    const y = Math.min(excluded.height - 1, Math.floor(v * excluded.height));
    return Number(excluded.data[(y * excluded.width + x) * 4]) > 30;
  };
  const pixel = (u: number, v: number) => {
    const x = Math.min(source.width - 1, Math.floor(u * source.width));
    const y = Math.min(source.height - 1, Math.floor(v * source.height));
    const i = (y * source.width + x) * 4;
    return [0, 1, 2].map(c => Number(source.data[i + c]));
  };
  for (let row = 0; row < 5; row++) for (let col = 0; col < 13; col++) {
    const left = 0.02 + col * 0.075, top = 0.73 + row * 0.045;
    const samples: number[][] = [];
    let blocked = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const u = left + (x + 0.5) / 8 * 0.07, v = top + (y + 0.5) / 8 * 0.05;
      if (maskAt(u, v)) blocked++;
      samples.push(pixel(u, v));
    }
    if (blocked > 1) continue;
    const color = [0, 1, 2].map(c => samples.reduce((s, p) => s + p[c], 0) / samples.length) as [number, number, number];
    const variance = samples.reduce((s, p) => s + p.reduce((n, v, c) => n + (v - color[c]) ** 2, 0), 0) / (samples.length * 3);
    // Strong contrast is evidence of a scene feature, not repeatable material.
    if (variance > 450) continue;
    const score = variance + blocked * 100 + (1 - top) * 4;
    if (!best || score < best.score) best = { score, patch: { region: [left, top, left + 0.07, top + 0.05], color, reliable: true } };
  }
  if (best) return best.patch;
  // No visible floor evidence: a muted source-derived color is a better
  // completion than stretching body/clothing pixels across a giant plane.
  const samples: number[][] = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) {
    const u = (x + 0.5) / 20, v = 0.7 + (y + 0.5) / 12 * 0.29;
    if (!maskAt(u, v)) samples.push(pixel(u, v));
  }
  const color = [0, 1, 2].map(c => {
    const values = samples.map(p => p[c]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 100;
  }) as [number, number, number];
  return { region: [0.02, 0.94, 0.09, 0.99], color, reliable: false };
}
