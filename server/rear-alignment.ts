import sharp from 'sharp';
import type { LocalSegmenter, SegmentedMask } from './world-completion.js';

interface MaskShape { mask: Uint8Array; box: [number, number, number, number]; kind: string }
function rows(mask: Uint8Array, width: number, height: number) {
  const output: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    let left = width, right = -1;
    for (let x = 0; x < width; x++) if (mask[y * width + x] >= 128) { left = Math.min(left, x); right = Math.max(right, x); }
    output.push([left, right]);
  }
  return output;
}

/** Register inferred bodies to original silhouettes one scanline at a time, retaining head/clothing colors. */
export function warpRearPixels(rgb: Uint8Array, width: number, height: number, target: MaskShape[], generated: MaskShape[], maskWidth: number, maskHeight: number) {
  if (rgb.length !== width * height * 3 || [...target, ...generated].some(item => item.mask.length !== maskWidth * maskHeight)) throw new Error('Rear registration dimensions do not match.');
  const result = Buffer.from(rgb), used = new Set<number>();
  let matches = 0;
  // The large, main subjects claim their closest generated counterparts before small background subjects.
  const ordered = [...target].sort((a, b) => b.mask.filter(Boolean).length - a.mask.filter(Boolean).length);
  for (const subject of ordered) {
    let best = -1, cost = Infinity;
    const targetArea = Math.max(.001, (subject.box[2] - subject.box[0]) * (subject.box[3] - subject.box[1]));
    for (const [i, candidate] of generated.entries()) {
      if (used.has(i) || candidate.kind !== subject.kind) continue;
      const area = Math.max(.001, (candidate.box[2] - candidate.box[0]) * (candidate.box[3] - candidate.box[1]));
      const score = Math.abs((subject.box[1] + subject.box[3] - candidate.box[1] - candidate.box[3]) / 2) + .4 * Math.abs((subject.box[0] + subject.box[2] - candidate.box[0] - candidate.box[2]) / 2) + .08 * Math.abs(Math.log(area / targetArea));
      if (score < cost) { cost = score; best = i; }
    }
    if (best < 0 || cost > .55) continue;
    used.add(best); matches++;
    const matched = generated[best], targetRows = rows(subject.mask, maskWidth, maskHeight), sourceRows = rows(matched.mask, maskWidth, maskHeight);
    const top = Math.max(0, Math.floor(subject.box[0] * height)), bottom = Math.min(height - 1, Math.ceil(subject.box[2] * height));
    for (let y = top; y <= bottom; y++) {
      const maskY = Math.min(maskHeight - 1, Math.floor((y + .5) / height * maskHeight));
      const [left, right] = targetRows[maskY]; if (right < left) continue;
      const fraction = Math.max(0, Math.min(1, ((y + .5) / height - subject.box[0]) / (subject.box[2] - subject.box[0])));
      const sourceY = (matched.box[0] + fraction * (matched.box[2] - matched.box[0])) * height;
      let sourceMaskY = Math.max(0, Math.min(maskHeight - 1, Math.floor(sourceY / height * maskHeight)));
      if (sourceRows[sourceMaskY][1] < sourceRows[sourceMaskY][0]) {
        let nearest = -1;
        for (let distance = 1; distance < maskHeight && nearest < 0; distance++) for (const candidate of [sourceMaskY - distance, sourceMaskY + distance]) if (candidate >= 0 && candidate < maskHeight && sourceRows[candidate][1] >= sourceRows[candidate][0]) { nearest = candidate; break; }
        if (nearest < 0) continue; sourceMaskY = nearest;
      }
      const [sourceLeft, sourceRight] = sourceRows[sourceMaskY];
      const sampleY = Math.min(height - 1, Math.max(0, Math.floor((sourceMaskY + .5) / maskHeight * height)));
      for (let x = Math.max(0, Math.floor(left / maskWidth * width)); x <= Math.min(width - 1, Math.ceil((right + 1) / maskWidth * width)); x++) {
        const maskX = Math.min(maskWidth - 1, Math.floor((x + .5) / width * maskWidth));
        if (subject.mask[maskY * maskWidth + maskX] < 128) continue;
        const u = Math.max(0, Math.min(1, ((x + .5) / width * maskWidth - left) / Math.max(1, right - left + 1)));
        // Sample within the detected body, never from foliage or sky outside its silhouette.
        const sampleX = Math.min(width - 1, Math.max(0, Math.floor((sourceLeft + .5 + u * Math.max(0, sourceRight - sourceLeft)) / maskWidth * width)));
        for (let channel = 0; channel < 3; channel++) result[(y * width + x) * 3 + channel] = rgb[(sampleY * width + sampleX) * 3 + channel];
      }
    }
  }
  return { pixels: result, matches };
}

export async function alignRearTexture(image: Buffer, targets: SegmentedMask[], maskWidth: number, maskHeight: number, segment: LocalSegmenter) {
  const generated = await segment(image, maskWidth, maskHeight);
  // Extra or missing instances make correspondence ambiguous, especially in crowded backgrounds.
  // Keep the generated photograph intact instead of mapping a bystander's body onto a main subject.
  const kinds = new Set([...targets, ...generated].map(item => item.subject.kind));
  if ([...kinds].some(kind => targets.filter(item => item.subject.kind === kind).length !== generated.filter(item => item.subject.kind === kind).length)) {
    return { image, matches: 0, detected: generated.length };
  }
  const decoded = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const shape = ({ mask, subject }: SegmentedMask): MaskShape => ({ mask, box: subject.box_2d.map(value => value / 1000) as [number, number, number, number], kind: subject.kind });
  const warped = warpRearPixels(decoded.data, decoded.info.width, decoded.info.height, targets.map(shape), generated.map(shape), maskWidth, maskHeight);
  return { image: await sharp(warped.pixels, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 } }).jpeg({ quality: 94 }).toBuffer(), matches: warped.matches, detected: generated.length };
}
