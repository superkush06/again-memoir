import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export interface RgbImage {
  width: number;
  height: number;
  /** Interleaved, opaque, 8-bit sRGB samples. */
  data: Uint8Array;
}

export interface RegionMask {
  name: string;
  width: number;
  height: number;
  /** One byte per pixel; samples >= 128 select the pixel. */
  data: Uint8Array;
}

export interface Metrics {
  pixelCount: number;
  exactMatch: boolean;
  mae: number;
  rmse: number;
  /** Null represents the infinite PSNR of an exact match, never zero dB. */
  psnrDb: number | null;
  changedPixelFraction: number;
}

interface Manifest {
  view: "source-camera";
  alignmentVerified: true;
  reference: string;
  baseline: string;
  candidate: string;
  regions?: { name: string; mask: string }[];
  capture?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

const CHANGED_CHANNEL_THRESHOLD = 10;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function validateShape(
  image: { width: number; height: number; data: Uint8Array },
  channels: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !Number.isSafeInteger(image.width * image.height * channels) ||
    !(image.data instanceof Uint8Array) ||
    image.data.length !== image.width * image.height * channels
  ) {
    throw new Error(`${label}: invalid dimensions or sample buffer length`);
  }
}

function sameDimensions(
  reference: { width: number; height: number },
  other: { width: number; height: number },
  label: string,
): void {
  if (reference.width !== other.width || reference.height !== other.height) {
    throw new Error(
      `${label}: oriented dimensions must exactly match reference (${reference.width} x ${reference.height})`,
    );
  }
}

function compareRgb(
  reference: RgbImage,
  image: RgbImage,
  mask?: Uint8Array,
): Metrics {
  let absoluteError = 0;
  let squaredError = 0;
  let pixelCount = 0;
  let changedPixels = 0;
  for (let pixel = 0; pixel < reference.width * reference.height; pixel++) {
    if (mask && mask[pixel] < 128) continue;
    pixelCount++;
    let maxChannelError = 0;
    for (let channel = 0; channel < 3; channel++) {
      const index = pixel * 3 + channel;
      const error = Math.abs(reference.data[index] - image.data[index]);
      absoluteError += error;
      squaredError += error * error;
      maxChannelError = Math.max(maxChannelError, error);
    }
    if (maxChannelError > CHANGED_CHANNEL_THRESHOLD) changedPixels++;
  }
  if (!pixelCount)
    throw new Error("Region mask selects no pixels at threshold >= 128");
  const mse = squaredError / (pixelCount * 3 * 255 ** 2);
  return {
    pixelCount,
    exactMatch: squaredError === 0,
    mae: absoluteError / (pixelCount * 3 * 255),
    rmse: Math.sqrt(mse),
    psnrDb: mse === 0 ? null : -10 * Math.log10(mse),
    changedPixelFraction: changedPixels / pixelCount,
  };
}

function comparison(
  reference: RgbImage,
  baseline: RgbImage,
  candidate: RgbImage,
  mask?: Uint8Array,
) {
  const before = compareRgb(reference, baseline, mask);
  const after = compareRgb(reference, candidate, mask);
  return {
    baseline: before,
    candidate: after,
    candidateMinusBaseline: {
      mae: after.mae - before.mae,
      rmse: after.rmse - before.rmse,
      psnrDb:
        before.psnrDb === null || after.psnrDb === null
          ? null
          : after.psnrDb - before.psnrDb,
      changedPixelFraction:
        after.changedPixelFraction - before.changedPixelFraction,
      psnrDeltaDefined: before.psnrDb !== null && after.psnrDb !== null,
    },
  };
}

/** Pure source-view comparison; never resizes, aligns, fits colors or accepts a candidate. */
export function evaluateRgb(
  reference: RgbImage,
  baseline: RgbImage,
  candidate: RgbImage,
  regions: RegionMask[] = [],
) {
  for (const [label, image] of [
    ["reference", reference],
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    validateShape(image, 3, label);
    sameDimensions(reference, image, label);
  }
  const names = new Set<string>();
  for (const region of regions) {
    if (!region.name.trim() || names.has(region.name))
      throw new Error("Region names must be nonempty and unique");
    names.add(region.name);
    validateShape(region, 1, `region ${region.name}`);
    sameDimensions(reference, region, `region ${region.name}`);
  }
  return {
    dimensions: { width: reference.width, height: reference.height },
    global: comparison(reference, baseline, candidate),
    regions: regions.map((region) => ({
      name: region.name,
      ...comparison(reference, baseline, candidate, region.data),
    })),
  };
}

export function parseManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new Error("Manifest must be a JSON object");
  const allowed = new Set([
    "view",
    "alignmentVerified",
    "reference",
    "baseline",
    "candidate",
    "regions",
    "capture",
    "provenance",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Manifest contains an unsupported field");
  if (value.view !== "source-camera" || value.alignmentVerified !== true) {
    throw new Error(
      "Manifest requires view='source-camera' and alignmentVerified=true; off-axis or unverified captures are not comparable",
    );
  }
  for (const field of ["reference", "baseline", "candidate"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim())
      throw new Error(`Manifest requires a nonempty ${field} file path`);
  }
  for (const field of ["capture", "provenance"] as const) {
    if (value[field] !== undefined && !isRecord(value[field]))
      throw new Error(`${field} must be a JSON object`);
  }
  if (value.regions !== undefined) {
    if (!Array.isArray(value.regions))
      throw new Error("regions must be an array");
    const names = new Set<string>();
    for (const region of value.regions) {
      if (
        !isRecord(region) ||
        Object.keys(region).some((key) => !["name", "mask"].includes(key)) ||
        typeof region.name !== "string" ||
        !region.name.trim() ||
        typeof region.mask !== "string" ||
        !region.mask.trim() ||
        names.has(region.name)
      ) {
        throw new Error(
          "Each region requires a unique nonempty name and a mask file path",
        );
      }
      names.add(region.name);
    }
  }
  return value as unknown as Manifest;
}

async function loadImage(path: string) {
  const bytes = await readFile(path);
  const metadata = await sharp(bytes).metadata();
  if ((metadata.pages ?? 1) !== 1)
    throw new Error(`${path}: multi-page/animated images are not supported`);
  if (metadata.hasAlpha && !(await sharp(bytes).stats()).isOpaque)
    throw new Error(
      `${path}: image and mask pixels must be fully opaque; transparency cannot hide errors`,
    );
  const decoded = await sharp(bytes)
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4)
    throw new Error(`${path}: could not decode RGB plus alpha`);
  const { width, height } = decoded.info;
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (decoded.data[pixel * 4 + 3] !== 255)
      throw new Error(
        `${path}: image and mask pixels must be fully opaque; transparency cannot hide errors`,
      );
    rgb[pixel * 3] = decoded.data[pixel * 4];
    rgb[pixel * 3 + 1] = decoded.data[pixel * 4 + 1];
    rgb[pixel * 3 + 2] = decoded.data[pixel * 4 + 2];
  }
  return {
    image: { width, height, data: rgb },
    file: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

export async function evaluateManifest(manifestPath: string) {
  const path = resolve(manifestPath);
  const bytes = await readFile(path);
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")));
  const imagePath = (name: string) => resolve(dirname(path), name);
  const [reference, baseline, candidate] = await Promise.all([
    loadImage(imagePath(manifest.reference)),
    loadImage(imagePath(manifest.baseline)),
    loadImage(imagePath(manifest.candidate)),
  ]);
  const regions = await Promise.all(
    (manifest.regions ?? []).map(async (region) => {
      const loaded = await loadImage(imagePath(region.mask));
      // Require grayscale mask pixels to make the >= 128 selection rule unambiguous.
      const data = new Uint8Array(loaded.image.width * loaded.image.height);
      for (let pixel = 0; pixel < data.length; pixel++) {
        const [r, g, b] = loaded.image.data.subarray(pixel * 3, pixel * 3 + 3);
        if (r !== g || r !== b)
          throw new Error(
            `${region.name}: mask must contain grayscale pixels (equal RGB channels)`,
          );
        data[pixel] = r;
      }
      return {
        mask: {
          name: region.name,
          width: loaded.image.width,
          height: loaded.image.height,
          data,
        },
        file: { name: region.name, ...loaded.file },
      };
    }),
  );
  return {
    schemaVersion: 1,
    view: manifest.view,
    alignmentVerified: manifest.alignmentVerified,
    colorSpace: "8-bit sRGB",
    changedPixelThreshold: {
      maxChannelErrorGreaterThan: CHANGED_CHANNEL_THRESHOLD,
      normalized: CHANGED_CHANNEL_THRESHOLD / 255,
    },
    maskThresholdInclusive: 128,
    inputs: {
      manifest: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      reference: reference.file,
      baseline: baseline.file,
      candidate: candidate.file,
      masks: regions.map((region) => region.file),
    },
    ...(manifest.capture ? { capture: manifest.capture } : {}),
    ...(manifest.provenance ? { provenance: manifest.provenance } : {}),
    ...evaluateRgb(
      reference.image,
      baseline.image,
      candidate.image,
      regions.map((region) => region.mask),
    ),
    limitations: [
      "Alignment is asserted by the caller, not verified by these metrics. Use clean source-camera canvas captures, not browser UI screenshots or off-axis views.",
      "Source-view image similarity cannot establish correct geometry, pose, hidden surfaces, or novel-view fidelity.",
      "These are 8-bit sRGB pixel errors, not linear-light, perceptual, SSIM, or LPIPS measurements. No candidate is automatically accepted.",
      "Exact matches have infinite PSNR, serialized as null with exactMatch=true. PSNR deltas involving exact matches are undefined and serialized as null.",
    ],
  };
}

async function main(args: string[]) {
  if (args.length !== 1 && !(args.length === 3 && args[1] === "--output")) {
    throw new Error(
      "Usage: npx tsx scripts/fidelity/evaluate.ts <manifest.json> [--output <report.json>]",
    );
  }
  if (!args[0] || args[0].startsWith("--") || (args.length === 3 && !args[2]))
    throw new Error("Manifest and output paths must be nonempty");
  const report = await evaluateManifest(args[0]);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args[2]) {
    const target = resolve(args[2]);
    const canonical = async (name: string) => {
      const actual = await realpath(name).catch(() => resolve(name));
      return process.platform === "win32" ? actual.toLowerCase() : actual;
    };
    const inputs = [
      report.inputs.manifest.path,
      report.inputs.reference.path,
      report.inputs.baseline.path,
      report.inputs.candidate.path,
      ...report.inputs.masks.map((mask) => mask.path),
    ];
    const targetKey = await canonical(target);
    if ((await Promise.all(inputs.map(canonical))).includes(targetKey))
      throw new Error(
        "Output path must not overwrite a manifest, input image, or mask",
      );
    await writeFile(target, json, "utf8");
  }
  process.stdout.write(json);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `Fidelity evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
