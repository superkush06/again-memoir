import sharp from 'sharp';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number, places = 4) => Number(value.toFixed(places));

export interface ImageQuality {
  sharpness: number;
  exposure: number;
  composition: number;
  subjectQuality: number;
  visualAppeal: number;
  wideScene: number;
  depthVariation: number;
  visibleGround: number;
  openSpace: number;
  stableGeometry: number;
  screenshotLikelihood: number;
  obstruction: number;
}

export function scoreWorldAnchor(quality: ImageQuality) {
  return round(clamp(
    quality.wideScene * 0.18 + quality.depthVariation * 0.19 + quality.visibleGround * 0.16 +
    quality.openSpace * 0.15 + quality.stableGeometry * 0.14 + quality.sharpness * 0.1 +
    (1 - quality.screenshotLikelihood) * 0.04 + (1 - quality.obstruction) * 0.04,
  ));
}

/** Cheap 16x16 image statistics: embedding, perceptual hash, and quality signals. */
export async function imageFeatures(bytes: Buffer): Promise<{ perceptualHash: string; embedding: number[]; quality: ImageQuality }> {
  const image = sharp(bytes, { failOn: 'error' }).rotate();
  const metadata = await image.metadata();
  const { data, info } = await image.clone().resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grayscale = await image.clone().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | BigInt(grayscale[y * 9 + x] > grayscale[y * 9 + x + 1] ? 1 : 0);
  }
  const cells: number[] = [];
  for (let cellY = 0; cellY < 4; cellY++) for (let cellX = 0; cellX < 4; cellX++) for (let channel = 0; channel < 3; channel++) {
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += data[((cellY * 4 + y) * info.width + cellX * 4 + x) * info.channels + channel] || 0;
    cells.push(sum / (16 * 255));
  }
  const mean = cells.reduce((sum, value) => sum + value, 0) / cells.length;
  const centered = cells.map(value => value - mean);
  const norm = Math.hypot(...centered) || 1;
  const embedding = centered.map(value => round(value / norm, 5));
  const luminance: number[] = [];
  const saturations: number[] = [];
  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    const r = data[pixel * info.channels] / 255; const g = data[pixel * info.channels + 1] / 255; const b = data[pixel * info.channels + 2] / 255;
    luminance.push(0.2126 * r + 0.7152 * g + 0.0722 * b); saturations.push(Math.max(r, g, b) - Math.min(r, g, b));
  }
  let gradient = 0; let edges = 0; let comparisons = 0;
  for (let y = 1; y < 16; y++) for (let x = 1; x < 16; x++) {
    const here = luminance[y * 16 + x]; const delta = Math.abs(here - luminance[y * 16 + x - 1]) + Math.abs(here - luminance[(y - 1) * 16 + x]);
    gradient += delta; if (delta > 0.28) edges++; comparisons++;
  }
  const average = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
  const variance = luminance.reduce((sum, value) => sum + (value - average) ** 2, 0) / luminance.length;
  const bottom = luminance.slice(16 * 10); const bottomMean = bottom.reduce((sum, value) => sum + value, 0) / bottom.length;
  const bottomVariance = bottom.reduce((sum, value) => sum + (value - bottomMean) ** 2, 0) / bottom.length;
  const aspect = (metadata.width || 1) / (metadata.height || 1);
  const edgeDensity = edges / Math.max(1, comparisons);
  const sharpness = clamp((gradient / Math.max(1, comparisons)) * 2.8);
  const exposure = clamp(1 - Math.abs(average - 0.52) / 0.52);
  const visualAppeal = clamp((saturations.reduce((sum, value) => sum + value, 0) / saturations.length) * 1.6 + Math.sqrt(variance) * 0.7);
  const screenshotLikelihood = clamp((edgeDensity > 0.42 ? 0.5 : 0) + (variance < 0.015 ? 0.3 : 0) + (aspect > 2.2 || aspect < 0.45 ? 0.2 : 0));
  return {
    perceptualHash: bits.toString(16).padStart(16, '0'), embedding,
    quality: {
      sharpness: round(sharpness), exposure: round(exposure), composition: round(clamp(0.55 + variance * 2)),
      subjectQuality: round(clamp(sharpness * 0.55 + exposure * 0.45)), visualAppeal: round(visualAppeal),
      wideScene: round(clamp((aspect - 0.7) / 1.1)), depthVariation: round(clamp(Math.sqrt(variance) * 3.4)),
      visibleGround: round(clamp(bottomMean * 0.45 + Math.sqrt(bottomVariance) * 2.4)), openSpace: round(clamp(1 - Math.sqrt(bottomVariance) * 2.8)),
      stableGeometry: round(clamp(sharpness * 0.6 + (1 - Math.abs(edgeDensity - 0.18) / 0.3) * 0.4)),
      screenshotLikelihood: round(screenshotLikelihood), obstruction: round(clamp(edgeDensity * 1.35)),
    },
  };
}

export const fallbackQuality: ImageQuality = {
  sharpness: 0.45, exposure: 0.5, composition: 0.45, subjectQuality: 0.4, visualAppeal: 0.4,
  wideScene: 0.35, depthVariation: 0.35, visibleGround: 0.3, openSpace: 0.35, stableGeometry: 0.35,
  screenshotLikelihood: 0.2, obstruction: 0.35,
};

