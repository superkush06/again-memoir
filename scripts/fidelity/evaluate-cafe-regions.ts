import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { evaluateManifest, parseManifest } from "./evaluate.js";

type Region = {
  id: string;
  box: number[];
  description: string;
  confidence: string;
};
type Photo = {
  index: number;
  memoryId: string;
  originalFilename: string;
  servedSourceSha256: string;
  regions: Region[];
};
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

/** Fixed reviewed rectangles; right/bottom bounds are exclusive. */
export function rectanglePixels(box: number[], width: number, height: number) {
  if (
    box.length !== 4 ||
    box.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    box[0] >= box[2] ||
    box[1] >= box[3]
  )
    throw new Error("Invalid normalized rectangle");
  return [
    Math.floor(box[0] * width),
    Math.floor(box[1] * height),
    Math.ceil(box[2] * width),
    Math.ceil(box[3] * height),
  ] as const;
}

async function coveragePixels(
  path: string,
  expectedHash: string,
  width: number,
  height: number,
) {
  const bytes = await readFile(path);
  if (hash(bytes) !== expectedHash)
    throw new Error(`Capture hash changed: ${path}`);
  const metadata = await sharp(bytes).metadata();
  if ((metadata.pages ?? 1) !== 1)
    throw new Error(`Multipage coverage image: ${path}`);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4)
    throw new Error(`Coverage dimensions differ: ${path}`);
  const result = new Uint8Array(width * height);
  for (let i = 0; i < result.length; i++) {
    const [r, g, b, a] = data.subarray(i * 4, i * 4 + 4);
    if (r !== g || r !== b || a !== 255)
      throw new Error(`Coverage must be opaque grayscale: ${path}`);
    result[i] = r;
  }
  return result;
}

function coverageInRectangle(
  data: Uint8Array,
  width: number,
  rect: readonly number[],
) {
  const [left, top, right, bottom] = rect;
  let covered = 0,
    partial = 0,
    total = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const sample = data[y * width + x];
      if (sample >= 128) covered++;
      if (sample > 0 && sample < 255) partial++;
      total += sample;
    }
  const pixelCount = (right - left) * (bottom - top);
  return {
    pixelCount,
    uncoveredPixelFraction: 1 - covered / pixelCount,
    partialCoveragePixelFraction: partial / pixelCount,
    meanWhiteCoverage: total / (255 * pixelCount),
  };
}

export async function evaluateCafeRegions(
  studyManifestPath: string,
  onlyIndex?: number,
) {
  const studyPath = resolve(studyManifestPath);
  const studyBytes = await readFile(studyPath);
  const study = JSON.parse(studyBytes.toString("utf8"));
  const specPath = fileURLToPath(
    new URL("./cafe-regions.json", import.meta.url),
  );
  const specBytes = await readFile(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const [width, height] = spec.evaluationDimensions as number[];
  if (
    width !== 960 ||
    height !== 720 ||
    spec.version !== 1 ||
    !Array.isArray(study.cases)
  )
    throw new Error(
      "Expected reviewed version-1 960x720 cafe specification and study cases",
    );
  const photos = (spec.photos as Photo[]).filter(
    (photo) => onlyIndex === undefined || photo.index === onlyIndex,
  );
  if (!photos.length)
    throw new Error("No reviewed cafe region set for that index");
  const outputs = [];
  for (const photo of photos) {
    const matches = study.cases.filter(
      (item: any) => item.index === photo.index,
    );
    if (matches.length !== 1)
      throw new Error(`Case ${photo.index}: missing or duplicate study case`);
    const item = matches[0];
    if (
      item.memoryId !== photo.memoryId ||
      item.filename !== photo.originalFilename ||
      item.servedSourceSha256 !== photo.servedSourceSha256 ||
      hash(await readFile(resolve(dirname(studyPath), item.sourcePath))) !==
        photo.servedSourceSha256
    )
      throw new Error(
        `Case ${photo.index}: reviewed source identity/hash does not match`,
      );
    const captureDir = join(
      dirname(studyPath),
      `case-${String(photo.index).padStart(2, "0")}`,
      "captures",
    );
    const reportPath = join(captureDir, "capture-report.json");
    const captureBytes = await readFile(reportPath);
    const capture = JSON.parse(captureBytes.toString("utf8"));
    if (
      capture.inputs?.source?.sha256 !== photo.servedSourceSha256 ||
      capture.configuration?.width !== width ||
      capture.configuration?.height !== height
    )
      throw new Error(
        `Case ${photo.index}: capture source or dimensions do not match reviewed regions`,
      );
    const baseManifest = parseManifest(
      await readJson(join(captureDir, "evaluate.json")),
    );
    if (
      baseManifest.reference !== "source-reference.png" ||
      baseManifest.baseline !== "baseline-source-camera.png" ||
      baseManifest.candidate !== "candidate-source-camera.png"
    )
      throw new Error("Unexpected source-camera capture filenames");
    const masksDir = join(captureDir, "region-masks");
    await mkdir(masksDir, { recursive: true });
    const names = new Set<string>();
    const regions = [];
    const details = [];
    for (const region of photo.regions) {
      if (!/^[a-z0-9-]+$/.test(region.id) || names.has(region.id))
        throw new Error("Invalid/duplicate region id");
      names.add(region.id);
      const rect = rectanglePixels(region.box, width, height);
      const data = Buffer.alloc(width * height);
      for (let y = rect[1]; y < rect[3]; y++)
        data.fill(255, y * width + rect[0], y * width + rect[2]);
      await sharp(data, { raw: { width, height, channels: 1 } })
        .png()
        .toFile(join(masksDir, `${region.id}.png`));
      regions.push({ name: region.id, mask: `region-masks/${region.id}.png` });
      details.push({ ...region, pixelBoundsExclusive: rect });
    }
    const roiManifest = {
      ...baseManifest,
      regions,
      provenance: {
        ...baseManifest.provenance,
        studyManifestSha256: hash(studyBytes),
        captureReportSha256: hash(captureBytes),
        regionSpecSha256: hash(specBytes),
        memoryId: photo.memoryId,
        reviewedSourceSha256: photo.servedSourceSha256,
        regionDefinitions: details,
      },
    };
    const manifestPath = join(captureDir, "evaluate-regions.json");
    await writeFile(manifestPath, json(roiManifest));
    const evaluation = await evaluateManifest(manifestPath);
    const evaluationPath = join(captureDir, "evaluation-regions.json");
    await writeFile(evaluationPath, json(evaluation));
    const coverage = [];
    let sharedCamera: string | undefined;
    for (const variant of ["baseline", "candidate", "plane"]) {
      const entry = capture.captures?.find(
        (entry: any) =>
          entry.variant === variant &&
          entry.view === "source-camera" &&
          entry.coverage === true,
      );
      if (!entry)
        throw new Error(
          `Case ${photo.index}: missing ${variant} source coverage`,
        );
      const camera = JSON.stringify([
        entry.cameraWorldMatrix,
        entry.cameraProjectionMatrix,
      ]);
      if (sharedCamera && sharedCamera !== camera)
        throw new Error("Source coverage cameras differ");
      sharedCamera = camera;
      const path = join(captureDir, `${variant}-source-camera-coverage.png`);
      const pixels = await coveragePixels(path, entry.sha256, width, height);
      coverage.push({
        variant,
        input: { path, sha256: entry.sha256 },
        global: coverageInRectangle(pixels, width, [0, 0, width, height]),
        regions: details.map((region) => ({
          name: region.id,
          ...coverageInRectangle(pixels, width, region.pixelBoundsExclusive),
        })),
      });
    }
    const coveragePath = join(captureDir, "coverage-regions.json");
    await writeFile(
      coveragePath,
      json({
        schemaVersion: 1,
        view: "source-camera",
        dimensions: { width, height },
        regionSpecSha256: hash(specBytes),
        captureReportSha256: hash(captureBytes),
        thresholdInclusive: 128,
        regionDefinitions: details,
        variants: coverage,
        limitations: [
          "Coverage is white foreground rasterization without the backing; it does not establish correct depth or topology.",
          "Threshold 128 follows capture.ts raster coverage accounting, not a quality acceptance threshold; mean white coverage also retains antialiasing values.",
          "Rectangles are diagnostic source-image regions, not semantic masks. No automatic acceptance verdict is produced.",
        ],
      }),
    );
    outputs.push({
      index: photo.index,
      regionCount: regions.length,
      manifestPath,
      evaluationPath,
      coveragePath,
    });
  }
  return { studyManifest: studyPath, regionSpec: specPath, outputs };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const index = args[1] === undefined ? undefined : Number(args[1]);
  if (args.length > 2 || (index !== undefined && ![1, 2, 3].includes(index))) {
    process.stderr.write(
      "Usage: npx tsx scripts/fidelity/evaluate-cafe-regions.ts [study-manifest.json] [1|2|3]\n",
    );
    process.exitCode = 1;
  } else {
    evaluateCafeRegions(
      args[0] ?? ".local/depth-fidelity-v1/manifest.json",
      index,
    )
      .then((result) => process.stdout.write(json(result)))
      .catch((error) => {
        process.stderr.write(
          `Cafe region evaluation failed: ${error.message}\n`,
        );
        process.exitCode = 1;
      });
  }
}
