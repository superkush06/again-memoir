import sharp from 'sharp';
import type { Readiness3D } from '../src/types.js';
import type { RawDepthEstimator, RawDepthMap } from './depth-model.js';
import { fallbackQuality, imageFeatures, scoreWorldAnchor, type ImageQuality } from './image-quality.js';
import { videoSampleTimes, type VideoSampler } from './video-reconstruction.js';

/** The single pass/fail line for depth-scored memories. Items at or above it are filed into folders. */
export const READY_3D_THRESHOLD = 0.6;
/**
 * Conservative line for the heuristic fallback (no depth model). The old 16x16
 * statistics cannot tell a walkable scene from a close-up, so only clearly
 * strong anchors pass.
 */
export const HEURISTIC_READY_THRESHOLD = 0.72;
/** Depth is estimated on a copy this size (a multiple of the model's 14px patch). */
export const READINESS_INPUT_SIZE = 252;
/** Bump when the scoring rules change; memories scored by an older version are re-checked automatically. */
export const READINESS_VERSION = 2 as const;
/** Long edge of the grayscale copy used to measure blur. */
export const SHARPNESS_INPUT_SIZE = 512;

export type DepthMetrics = NonNullable<Readiness3D['metrics']>;
export type ReadinessInput =
  | { kind: 'image'; bytes: Buffer }
  | { kind: 'video'; file: string; poster?: Buffer };
/** Anything that can score a memory; the library depends on this boundary only. */
export interface Readiness3DScorer {
  score(input: ReadinessInput, quality?: ImageQuality): Promise<Readiness3D>;
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const round = (value: number, places = 3) => Number(value.toFixed(places));
const percentile = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/**
 * Measurements on raw relative inverse depth (larger = nearer). Everything is
 * scale-free so the same thresholds hold for any image size or model scale.
 */
export function analyzeDepth(map: RawDepthMap): DepthMetrics {
  const { width: w, height: h } = map;
  const count = w * h;
  if (!count || map.data.length < count) throw new Error('The depth map is empty or truncated.');
  const raw = Float32Array.from(map.data.subarray(0, count), value => (Number.isFinite(value) ? value : 0));
  const sorted = raw.slice().sort();
  const p2 = percentile(sorted, 0.02), p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95), p98 = percentile(sorted, 0.98);
  const span = p98 - p2;
  // Scale-relative "effectively zero": the model's units are arbitrary, so no fixed cutoff.
  const maxAbs = sorted.length ? Math.max(Math.abs(sorted[0]), Math.abs(sorted[sorted.length - 1])) : 0;
  const eps = maxAbs > 0 ? maxAbs * 1e-3 : Number.MIN_VALUE;
  // Robust near-to-far spread: 0 for a flat surface, near 1 when the far end recedes to the horizon.
  const depthRange = p95 > eps ? clamp((p95 - p5) / p95) : 0;
  const near = new Float32Array(count);
  for (let index = 0; index < count; index++) near[index] = span > eps ? clamp((raw[index] - p2) / span) : 0;

  // Layers: peaks in a smoothed nearness histogram; coverage: how many depth bands hold real content.
  const bins = 16; const histogram = new Array<number>(bins).fill(0);
  for (const value of near) histogram[Math.min(bins - 1, Math.floor(value * bins))]++;
  const smooth = histogram.map((value, index) => (histogram[index - 1] ?? 0) * 0.25 + value * 0.5 + (histogram[index + 1] ?? 0) * 0.25);
  const peaks: number[] = [];
  for (let index = 0; index < bins; index++) {
    const value = smooth[index];
    if (value < count * 0.03 || value <= (smooth[index - 1] ?? -1) || value < (smooth[index + 1] ?? -1)) continue;
    const previous = peaks.at(-1);
    // Merge with the previous peak unless a real valley separates them.
    if (previous !== undefined && Math.min(...smooth.slice(previous, index + 1)) > 0.85 * Math.min(value, smooth[previous])) {
      if (value > smooth[previous]) peaks[peaks.length - 1] = index;
      continue;
    }
    peaks.push(index);
  }
  const bands = new Array<number>(10).fill(0);
  for (const value of near) bands[Math.min(9, Math.floor(value * 10))]++;
  const depthCoverage = bands.filter(value => value >= count * 0.04).length / 10;

  // Ground: in the lower third, nearness rises steadily toward the bottom edge (no single jump, which is a body or table edge).
  const groundTop = Math.floor((h * 2) / 3); const columns = 8; const groundColumns: boolean[] = [];
  for (let column = 0; column < columns; column++) {
    const x0 = Math.floor((column * w) / columns); const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * w) / columns));
    const rows: number[] = [];
    for (let y = groundTop; y < h; y++) { let sum = 0; for (let x = x0; x < x1; x++) sum += near[y * w + x]; rows.push(sum / (x1 - x0)); }
    const step = Math.max(1, Math.round(h / 84)); let rising = 0; let steps = 0; let jump = 0;
    for (let index = rows.length - 1; index - step >= 0; index -= step) {
      steps++; if (rows[index - step] < rows[index] - 0.002) rising++;
      jump = Math.max(jump, rows[index] - rows[index - step]);
    }
    const drop = rows.length ? rows[rows.length - 1] - rows[0] : 0;
    groundColumns.push(steps > 0 && rising / steps > 0.7 && drop > 0.08 && jump < 0.5 * drop);
  }
  const groundPlane = groundColumns.filter(Boolean).length / columns;

  // Close occluder: one near blob (excluding detected ground) that reaches the middle of the frame.
  const isNear = (index: number) => {
    if (near[index] <= 0.55) return false;
    const x = index % w; const y = (index - x) / w;
    return !(y >= groundTop && groundColumns[Math.min(columns - 1, Math.floor((x * columns) / w))]);
  };
  const seen = new Uint8Array(count); const central = new Uint8Array(count); let largest = 0;
  const inCenter = (x: number, y: number) => x > w * 0.3 && x < w * 0.7 && y > h * 0.25 && y < h * 0.75;
  for (let start = 0; start < count; start++) {
    if (seen[start] || !isNear(start)) continue;
    const stack = [start]; const members: number[] = []; let touchesCenter = false; seen[start] = 1;
    while (stack.length) {
      const index = stack.pop()!; members.push(index);
      const x = index % w; const y = (index - x) / w;
      if (inCenter(x, y)) touchesCenter = true;
      for (const next of [x > 0 ? index - 1 : -1, x < w - 1 ? index + 1 : -1, y > 0 ? index - w : -1, y < h - 1 ? index + w : -1]) {
        if (next >= 0 && !seen[next] && isNear(next)) { seen[next] = 1; stack.push(next); }
      }
    }
    if (!touchesCenter) continue;
    largest = Math.max(largest, members.length);
    for (const index of members) central[index] = 1;
  }
  let centerHits = 0; let centerTotal = 0;
  for (let y = Math.floor(h * 0.2); y < h * 0.7; y++) for (let x = Math.floor(w * 0.25); x < w * 0.75; x++) { centerTotal++; centerHits += central[y * w + x]; }
  const closeOccluder = Math.max(0.85 * (largest / count), centerTotal ? centerHits / centerTotal : 0);

  // Flatness: the largest share of the frame at roughly one (non-background) depth, on the raw scale.
  const window = 0.12 * Math.max(p98, eps); const floor = p2 + 0.1 * span;
  let start = 0; let flatPixels = 0;
  const foreground = sorted.filter(value => value > floor);
  for (let index = 0; index < foreground.length; index++) {
    while (foreground[index] - foreground[start] > window) start++;
    flatPixels = Math.max(flatPixels, index - start + 1);
  }
  // A frame with no measurable spread is one flat surface.
  const flatness = span <= eps || depthRange < 0.05 ? 1 : flatPixels / count;

  // Eye-level fit, on nearness relative to the nearest content (scale-free). A good
  // place to stand has content a few steps to a few dozen meters away along the eye
  // line, the floor rising toward the camera, and something far in the frame.
  const rel = (index: number) => (p98 > eps ? Math.min(1.5, Math.max(0, raw[index] / p98)) : 0);
  const bandMean = (y0: number, y1: number, x0 = 0, x1 = 1) => {
    let total = 0; let n = 0;
    for (let y = Math.floor(h * y0); y < Math.min(h, Math.ceil(h * y1)); y++) for (let x = Math.floor(w * x0); x < Math.min(w, Math.ceil(w * x1)); x++) { total += rel(y * w + x); n++; }
    return n ? total / n : 0;
  };
  const top = bandMean(0, 0.2); const upper = bandMean(0.2, 0.45); const lower = bandMean(0.55, 0.8); const bottom = bandMean(0.8, 1);
  let eyeMid = 0; let eyeTotal = 0;
  for (let y = Math.floor(h * 0.3); y < Math.min(h, Math.ceil(h * 0.7)); y++) for (let x = 0; x < w; x++) { const value = rel(y * w + x); eyeTotal++; if (value >= 0.12 && value <= 0.7) eyeMid++; }

  return {
    depthRange: round(depthRange), depthLayers: peaks.length, depthCoverage: round(depthCoverage),
    groundPlane: round(groundPlane), closeOccluder: round(clamp(closeOccluder)), flatness: round(clamp(flatness)),
    eyeLevelContent: round(eyeTotal ? eyeMid / eyeTotal : 0), verticalRise: round(Math.max(-1, Math.min(1, bottom - top))),
    farthestBand: round(clamp(Math.min(top, upper, lower, bottom))), centerNearness: round(clamp(bandMean(0.35, 0.65, 0.2, 0.8))),
    lowerBand: round(clamp(lower)),
  };
}

/**
 * Blur on a ~512px grayscale copy: per-tile Laplacian energy, normalized by the
 * tile's own contrast so dark or low-contrast scenes are not mistaken for blur.
 * Flat tiles (sky, black night) are ignored. Motion and focus blur both drive
 * `detail` down; sharp photos sit well above ~0.6.
 */
export async function measureSharpness(bytes: Buffer): Promise<{ detail: number; edgeEnergy: number }> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate()
    .resize(SHARPNESS_INPUT_SIZE, SHARPNESS_INPUT_SIZE, { fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width; const h = info.height; const channels = info.channels;
  const at = (x: number, y: number) => data[(y * w + x) * channels];
  const tiles = 8; const energies: number[] = []; const ratios: number[] = [];
  for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {
    let sum = 0; let sum2 = 0; let lap2 = 0; let n = 0;
    for (let y = Math.max(1, Math.floor((ty * h) / tiles)); y < Math.min(h - 1, Math.floor(((ty + 1) * h) / tiles)); y++) {
      for (let x = Math.max(1, Math.floor((tx * w) / tiles)); x < Math.min(w - 1, Math.floor(((tx + 1) * w) / tiles)); x++) {
        const value = at(x, y); const lap = 4 * value - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
        lap2 += lap * lap; sum += value; sum2 += value * value; n++;
      }
    }
    if (!n) continue;
    const variance = sum2 / n - (sum / n) ** 2;
    if (variance <= 60) continue; // flat sky / black: no evidence either way
    energies.push(lap2 / n); ratios.push(lap2 / n / (variance + 1));
  }
  if (!energies.length) return { detail: 0, edgeEnergy: 0 };
  const p75 = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.round(0.75 * (sorted.length - 1)))]; };
  return { detail: round(p75(ratios)), edgeEnergy: round(p75(energies), 1) };
}

/** Linear ramp from 0 at `from` to 1 at `to` (works in either direction). */
const ramp = (value: number, from: number, to: number) => clamp((value - from) / (to - from));

/**
 * 3D readiness needs a mix of things, all at once:
 *  - an eye-level depth fit: content a few steps to a few dozen meters around a
 *    standing viewer and a floor to stand on; not a close-up filling the lens,
 *    not the camera pointed down at a surface, not a far-away vista;
 *  - a sharp photo (real blur measured at ~512px, including motion blur);
 *  - enough light, and not a screenshot.
 * Each part multiplies the score, so failing any one of them fails the photo.
 */
export function scoreDepthReadiness(metrics: DepthMetrics, quality: ImageQuality, threshold = READY_3D_THRESHOLD) {
  const range = ramp(metrics.depthRange, 0.45, 0.85);
  const layers = 0.5 * clamp((metrics.depthLayers - 1) / 2) + 0.5 * clamp((metrics.depthCoverage * 10 - 2) / 5);
  const flat = ramp(metrics.flatness, 0.4, 0.7);
  const occluder = ramp(metrics.closeOccluder, 0.3, 0.45);
  const centerClose = metrics.centerNearness === undefined ? 0 : ramp(metrics.centerNearness, 0.5, 0.6);
  const tooClose = Math.max(occluder, centerClose);
  const lookDown = metrics.verticalRise === undefined || metrics.farthestBand === undefined ? 0
    : ramp(metrics.verticalRise, 0.25, 0.15) * ramp(metrics.farthestBand, 0.22, 0.3);
  const vista = metrics.eyeLevelContent === undefined || metrics.lowerBand === undefined ? 0
    : ramp(metrics.eyeLevelContent, 0.06, 0.02) * ramp(metrics.lowerBand, 0.45, 0.35);
  const depthFit = clamp(0.35 + 0.3 * range + 0.05 * layers + 0.3 * metrics.groundPlane)
    * (1 - tooClose) * (1 - 0.9 * lookDown) * (1 - 0.85 * vista) * (1 - 0.9 * flat);

  const sharpness = metrics.detail !== undefined && metrics.edgeEnergy !== undefined
    ? Math.min(ramp(metrics.detail, 0.45, 0.6), ramp(metrics.edgeEnergy, 100, 350))
    : clamp(quality.sharpness / 0.2); // no full-resolution blur measurement available
  const exposure = clamp(quality.exposure / 0.3);
  const screenshot = ramp(quality.screenshotLikelihood, 0.3, 0.7);
  const blurGate = metrics.detail !== undefined ? sharpness : 0.5 + 0.5 * sharpness;
  const score = round(clamp(depthFit * blurGate * (0.4 + 0.6 * exposure) * (1 - 0.6 * screenshot)));
  const ready = score >= threshold;

  const good: string[] = []; const bad: string[] = [];
  if (range >= 0.85) good.push('clear foreground-to-background depth'); else if (range < 0.5) bad.push('shallow depth range');
  if (metrics.depthLayers >= 3 || metrics.depthCoverage >= 0.7) good.push('several distinct depth layers');
  if (metrics.groundPlane >= 0.6) good.push('visible ground you could walk on'); else if (metrics.groundPlane < 0.25) bad.push('no visible ground plane');
  if (tooClose >= 0.5) bad.push('close-up fills the frame'); else if (metrics.closeOccluder < 0.1) good.push('open view with nothing blocking the scene');
  if (lookDown >= 0.5) bad.push('a nearby surface blocks the view (camera pointed down or through a window)');
  if (vista >= 0.5) bad.push('mostly a far-away view with little at eye level');
  else if ((metrics.eyeLevelContent ?? 0) >= 0.3) good.push('scene sits at eye level around you');
  if (flat >= 0.5) bad.push('mostly one flat surface (wall, document, or screen)');
  if (exposure < 0.6) bad.push('too dark to reconstruct reliably');
  if (sharpness < 0.6) bad.push('too blurry for stable geometry');
  if (screenshot >= 0.5) bad.push('looks like a screenshot');
  return { score, ready, reasons: ready ? [...good, ...bad] : [...bad, ...good] };
}

/** Fallback when the depth model is unavailable: the existing world-anchor heuristic with a stricter line. */
export function heuristicReadiness(quality: ImageQuality, cause: string, threshold = HEURISTIC_READY_THRESHOLD) {
  const anchor = scoreWorldAnchor(quality);
  const score = round(clamp(anchor * (quality.screenshotLikelihood >= 0.5 ? 0.6 : 1)));
  const ready = score >= threshold;
  const reasons = [
    `${cause}; estimated from image statistics only`,
    ready ? 'strong wide-scene signals' : 'not enough evidence of a walkable scene',
  ];
  if (quality.screenshotLikelihood >= 0.5) reasons.push('looks like a screenshot');
  return { score, ready, reasons };
}

/** A complete heuristic Readiness3D record, for callers that could not run the scorer at all. */
export function heuristicReadiness3d(quality: ImageQuality, cause: string, threshold = HEURISTIC_READY_THRESHOLD): Readiness3D {
  return { version: READINESS_VERSION, ...heuristicReadiness(quality, cause, threshold), source: 'heuristic', threshold, scoredAt: new Date().toISOString(), durationMs: 0 };
}

type ScorerOptions = {
  /** The raw depth boundary. Omit for heuristic-only scoring (tests, or no model available). */
  estimator?: RawDepthEstimator;
  videoSampler?: VideoSampler;
  threshold?: number;
  heuristicThreshold?: number;
  log?: (message: string) => void;
  now?: () => number;
  clock?: () => Date;
};

/** Depth-based 3D readiness. Never throws for bad inputs: anything unscorable falls back to the heuristic. */
export class DepthReadinessScorer implements Readiness3DScorer {
  private readonly threshold: number;
  private readonly heuristicThreshold: number;
  private readonly now: () => number;
  private readonly clock: () => Date;
  constructor(private readonly options: ScorerOptions = {}) {
    this.threshold = options.threshold ?? READY_3D_THRESHOLD;
    this.heuristicThreshold = options.heuristicThreshold ?? HEURISTIC_READY_THRESHOLD;
    this.now = options.now || (() => performance.now());
    this.clock = options.clock || (() => new Date());
  }

  async score(input: ReadinessInput, quality?: ImageQuality): Promise<Readiness3D> {
    const started = this.now();
    let frame: Buffer | undefined; let sampledAt: number | undefined; let unavailable = 'Depth model unavailable';
    if (input.kind === 'image') frame = input.bytes;
    else {
      try {
        if (!this.options.videoSampler) throw new Error('No video sampler.');
        const times = videoSampleTimes(await this.options.videoSampler.duration(input.file));
        sampledAt = times[Math.floor(times.length / 2)];
        frame = await this.options.videoSampler.frame(input.file, sampledAt);
      } catch {
        sampledAt = undefined; frame = input.poster;
        unavailable = frame ? unavailable : 'No video frame could be sampled';
      }
    }
    let measured = quality;
    if (frame && (!measured || input.kind === 'video')) measured = await imageFeatures(frame).then(value => value.quality).catch(() => measured);
    measured ||= fallbackQuality;
    let result: Readiness3D | undefined;
    if (frame && this.options.estimator) {
      const rgb = await sharp(frame, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().flatten({ background: '#000000' })
        .resize(READINESS_INPUT_SIZE, READINESS_INPUT_SIZE, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        .catch(() => { unavailable = 'The image could not be decoded for depth'; return undefined; });
      if (rgb) {
        try {
          const depthMetrics = analyzeDepth(await this.options.estimator({ data: rgb.data, width: rgb.info.width, height: rgb.info.height }));
          const sharp512 = await measureSharpness(frame).catch(() => undefined);
          const metrics: DepthMetrics = { ...depthMetrics, ...(sharp512 || {}) };
          const scored = scoreDepthReadiness(metrics, measured, this.threshold);
          result = this.finish({ ...scored, source: 'depth-anything-v2', threshold: this.threshold, metrics }, started, sampledAt);
        } catch { /* Model missing or failed (e.g. onnxruntime not installed): fall back below. */ }
      }
    }
    if (!result) {
      const scored = heuristicReadiness(measured, unavailable, this.heuristicThreshold);
      result = this.finish({ ...scored, source: 'heuristic', threshold: this.heuristicThreshold }, started, sampledAt);
    }
    this.options.log?.(`[3d-check] ${input.kind} scored ${result.score.toFixed(3)} ${result.ready ? 'ready' : 'not ready'} via ${result.source} in ${result.durationMs}ms`);
    return result;
  }

  private finish(value: Omit<Readiness3D, 'version' | 'scoredAt' | 'durationMs' | 'sampledAt'>, started: number, sampledAt?: number): Readiness3D {
    return {
      version: READINESS_VERSION, ...value, ...(sampledAt !== undefined ? { sampledAt: round(sampledAt, 3) } : {}),
      scoredAt: this.clock().toISOString(), durationMs: Math.max(0, Math.round(this.now() - started)),
    };
  }
}
