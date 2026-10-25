import type { MemoryObjectCategory } from "../src/memory-objects.js";

export type SilhouetteBox = [top: number, left: number, bottom: number, right: number];
export type SilhouettePoint = [x: number, y: number];
export type SilhouetteCrop = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

function validateGeometry(box: SilhouetteBox, crop: SilhouetteCrop, output: Size) {
  if (
    ![...box, crop.left, crop.top, crop.width, crop.height, output.width, output.height].every(Number.isFinite) ||
    box[2] <= box[0] || box[3] <= box[1] || crop.width <= 0 || crop.height <= 0 ||
    !Number.isInteger(output.width) || !Number.isInteger(output.height) ||
    output.width < 1 || output.height < 1
  ) throw new RangeError("A silhouette needs finite, non-empty image and object bounds.");
}

/** This SlimSAM ONNX export supports foreground/background point labels 1/0.
 * Unlike Meta's separate ONNX wrapper, it does not encode point labels 2/3 as
 * box corners. Spread positive seeds to discourage a screen/logo-only mask. */
export function silhouettePrompts(
  box: SilhouetteBox,
  crop: SilhouetteCrop,
  output: Size,
  category?: MemoryObjectCategory,
): { input_points: [SilhouettePoint[]]; input_labels: [number[]] } {
  validateGeometry(box, crop, output);
  const [top, left, bottom, right] = box;
  const width = right - left, height = bottom - top;
  const sx = output.width / crop.width, sy = output.height / crop.height;
  const points: SilhouettePoint[] = [], labels: number[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number, label: 0 | 1) => {
    if (x < crop.left || x >= crop.left + crop.width || y < crop.top || y >= crop.top + crop.height) return;
    const point: SilhouettePoint = [
      Math.min(output.width - 1, Math.max(0, (x - crop.left) * sx)),
      Math.min(output.height - 1, Math.max(0, (y - crop.top) * sy)),
    ];
    const mappedX = crop.left + point[0] / sx, mappedY = crop.top + point[1] / sy;
    if (label === 0 && mappedX >= left && mappedX < right && mappedY >= top && mappedY < bottom) return;
    // Clamping very small crops must not create contradictory labels for a pixel.
    const key = `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key); points.push(point); labels.push(label);
  };
  for (const fraction of category === "laptop" ? [0.25, 0.5, 0.75, 0.85] : [0.25, 0.5, 0.75])
    add(left + width / 2, top + height * fraction, 1);
  // Only real pixels outside the confirmed box can be negative examples. Do not
  // clamp an unavailable outside point back onto an object touching a crop edge.
  add(left - width * 0.15, top + height / 2, 0);
  add(right + width * 0.15, top + height / 2, 0);
  add(left + width / 2, top - height * 0.15, 0);
  add(left + width / 2, bottom + height * 0.15, 0);
  return { input_points: [points], input_labels: [labels] };
}

export type SilhouetteChannel = { score: number; data: Uint8Array | Uint8ClampedArray };
export type SilhouetteReason = "accepted" | "quality" | "invalid-mask" | "empty" | "spill" | "sparse" | "partial";
export type SilhouetteAudit = {
  channel: number;
  score: number;
  reason: SilhouetteReason;
  selected?: boolean;
  foreground?: number;
  retained?: number;
  outsideFraction?: number;
  widthCoverage?: number;
  heightCoverage?: number;
};

/** Keep only observed foreground in the largest connected component, matching
 * the contour tracer. Disconnected noise must not make a part mask seem whole. */
function largestComponent(mask: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let largest: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let head = 0, tail = 1;
    queue[0] = i; seen[i] = 1;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      for (const next of [x ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    if (tail > largest.length) largest = Array.from(queue.subarray(0, tail));
  }
  const result = new Uint8Array(mask.length);
  for (const i of largest) result[i] = 1;
  return { mask: result, indices: largest };
}

/** Select a learned silhouette without inventing foreground. Model IoU is a
 * quality estimate, not proof of whole-object coverage; a high-scoring screen
 * can still omit the keyboard. Keep conservative spill/quality checks, then
 * prefer masks covering more of the independently detected object extent. */
export function selectObjectSilhouette(input: {
  channels: SilhouetteChannel[];
  width: number;
  height: number;
  box: SilhouetteBox;
  crop: SilhouetteCrop;
  category?: MemoryObjectCategory;
  minimumScore?: number;
  maximumSpill?: number;
  minimumAreaCoverage?: number;
  minimumWidthCoverage?: number;
  minimumHeightCoverage?: number;
}): { mask?: Uint8Array; channel?: number; audit: SilhouetteAudit[] } {
  const { width, height, box, crop } = input;
  validateGeometry(box, crop, { width, height });
  const [top, left, bottom, right] = box;
  const bw = right - left, bh = bottom - top, sx = width / crop.width, sy = height / crop.height;
  const targetWidth = Math.max(0, Math.min(width, (right - crop.left) * sx) - Math.max(0, (left - crop.left) * sx));
  const targetHeight = Math.max(0, Math.min(height, (bottom - crop.top) * sy) - Math.max(0, (top - crop.top) * sy));
  const audit: SilhouetteAudit[] = [];
  const viable: { mask: Uint8Array; channel: number; extent: number; score: number }[] = [];
  for (const [channel, candidate] of input.channels.entries()) {
    const entry: SilhouetteAudit = { channel, score: candidate.score, reason: "accepted" };
    audit.push(entry);
    if (!Number.isFinite(candidate.score) || candidate.score < (input.minimumScore ?? 0.7)) { entry.reason = "quality"; continue; }
    if (candidate.data.length !== width * height) { entry.reason = "invalid-mask"; continue; }
    let foreground = 0, outside = 0;
    const bounded = new Uint8Array(width * height);
    for (let i = 0; i < bounded.length; i++) {
      if (!candidate.data[i]) continue;
      foreground++;
      const x = crop.left + (i % width + 0.5) / sx;
      const y = crop.top + (Math.floor(i / width) + 0.5) / sy;
      if (x < left - bw * 0.1 || x > right + bw * 0.1 || y < top - bh * 0.1 || y > bottom + bh * 0.1) outside++;
      if (x >= left && x < right && y >= top && y < bottom) bounded[i] = 1;
    }
    entry.foreground = foreground;
    entry.outsideFraction = foreground ? outside / foreground : 0;
    if (!foreground) { entry.reason = "empty"; continue; }
    if (outside / foreground > (input.maximumSpill ?? 0.12)) { entry.reason = "spill"; continue; }
    const retained = largestComponent(bounded, width, height);
    entry.retained = retained.indices.length;
    if (retained.indices.length < Math.max(8, targetWidth * targetHeight * (input.minimumAreaCoverage ?? 0.12))) { entry.reason = "sparse"; continue; }
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (const i of retained.indices) {
      const x = i % width, y = Math.floor(i / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    entry.widthCoverage = Math.min(1, (maxX - minX + 1) / targetWidth);
    entry.heightCoverage = Math.min(1, (maxY - minY + 1) / targetHeight);
    if (entry.widthCoverage < (input.minimumWidthCoverage ?? 0.5) || entry.heightCoverage < (input.minimumHeightCoverage ?? (input.category === "laptop" ? 0.7 : 0.5))) {
      entry.reason = "partial"; continue;
    }
    viable.push({ mask: retained.mask, channel, extent: entry.widthCoverage * entry.heightCoverage, score: candidate.score });
  }
  viable.sort((a, b) => b.extent - a.extent || b.score - a.score);
  const selected = viable[0];
  if (!selected) return { audit };
  audit[selected.channel].selected = true;
  return { mask: selected.mask, channel: selected.channel, audit };
}
