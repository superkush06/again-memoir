import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pipeline, RawImage } from "@huggingface/transformers";

// A local, depth-only experiment. The live reconstruction/scene caches are read-only.
// Usage: npx tsx scripts/fidelity/prepare-depth-ablation.ts <repo-root> <output-directory> [1,2,3]
const [rootArgument, outputArgument, selected = "1,2,3"] =
  process.argv.slice(2);
if (!rootArgument || !outputArgument || !/^\d+(,\d+)*$/.test(selected)) {
  throw new Error(
    "Supply repository root, a new experiment output directory, and optional comma-separated album indices.",
  );
}
const root = path.resolve(rootArgument);
const output = path.resolve(outputArgument);
if (
  output === root ||
  output === path.join(root, "data") ||
  output.startsWith(path.join(root, "data") + path.sep)
) {
  throw new Error(
    "Experiment outputs must be outside the live data directory.",
  );
}
const report = JSON.parse(
  await readFile(
    path.join(root, ".local/photo-scene-test-results.json"),
    "utf8",
  ),
);
const indices = [...new Set(selected.split(",").map(Number))];
const items = indices.map((index) => {
  const item = report.items.find(
    (value: { index: number }) => value.index === index,
  );
  if (!item?.scenePath || !item?.originalPath)
    throw new Error(
      `Photo ${index} needs a saved baseline scene and original.`,
    );
  return item;
});
await mkdir(output, { recursive: true });
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const localArtifact = (url: string) => {
  if (!/^\/uploads\/reconstructions\/[A-Za-z0-9_-]+\.(jpg|png|json)$/.test(url))
    throw new Error("Expected a local reconstruction artifact.");
  return path.join(root, "data", url.slice(1));
};
const modelId = "onnx-community/depth-anything-v2-small";
const modelDir = path.join(root, "data/models");
const weight = path.join(modelDir, modelId, "onnx/model.onnx");
const modelSha256 = sha(await readFile(weight));
const started = performance.now();
const estimator = await pipeline("depth-estimation", modelId, {
  cache_dir: modelDir,
  local_files_only: true,
  dtype: "fp32",
  device: "cpu",
  session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
});
console.log(
  JSON.stringify({
    stage: "model-loaded",
    elapsedMs: Math.round(performance.now() - started),
    modelId,
    modelSha256,
  }),
);
const results: unknown[] = [];
try {
  for (const item of items) {
    const caseStarted = performance.now();
    const directory = path.join(
      output,
      `case-${String(item.index).padStart(2, "0")}`,
    );
    await mkdir(directory, { recursive: true });
    const scene = JSON.parse(await readFile(item.scenePath, "utf8"));
    const reconstruction = scene.reconstruction;
    const sourceFile = localArtifact(reconstruction.sourceUrl);
    const cachedDepthFile = localArtifact(reconstruction.depthUrl);
    const source = await readFile(sourceFile);
    const original = await readFile(item.workingPath || item.originalPath);
    // Match the production JPEG preparation exactly, independently from the existing cache.
    const preparedOriginal = await sharp(original, {
      limitInputPixels: 40_000_000,
      animated: false,
    })
      .rotate()
      .flatten({ background: "#101722" })
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer();
    if (sha(source) !== sha(preparedOriginal))
      throw new Error(
        `Photo ${item.index}: served source does not match original preparation; resolve registration first.`,
      );
    const rgb = await sharp(source)
      .resize({
        width: 518,
        height: 518,
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    console.log(
      JSON.stringify({
        stage: "inference-start",
        index: item.index,
        input: [rgb.info.width, rgb.info.height],
      }),
    );
    const predicted = await estimator(
      new RawImage(rgb.data, rgb.info.width, rgb.info.height, 3),
    );
    const depth = predicted.depth;
    const raw = () =>
      sharp(Buffer.from(depth.data), {
        raw: {
          width: depth.width,
          height: depth.height,
          channels: depth.channels as 1 | 2 | 3 | 4,
        },
      });
    // Same learned prediction, two artifact policies. Never upsample low-res cached depth.
    const baseline = await raw()
      .resize({
        width: 256,
        height: 256,
        fit: "inside",
        withoutEnlargement: true,
      })
      .grayscale()
      .png()
      .toBuffer();
    const candidate = await raw()
      .resize({
        width: 518,
        height: 518,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "nearest",
      })
      .grayscale()
      .png()
      .toBuffer();
    const cached = await readFile(cachedDepthFile);
    const before = await sharp(baseline)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const saved = await sharp(cached)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let mismatchPixels: number | null = null;
    let maxDepthError: number | null = null;
    if (
      before.info.width === saved.info.width &&
      before.info.height === saved.info.height
    ) {
      mismatchPixels = 0;
      maxDepthError = 0;
      for (let i = 0; i < before.data.length; i++) {
        const error = Math.abs(before.data[i] - saved.data[i]);
        if (error) mismatchPixels++;
        maxDepthError = Math.max(maxDepthError, error);
      }
    }
    const sourcePath = path.join(directory, "source.jpg");
    const baselineDepthPath = path.join(directory, "depth-baseline-256.png");
    const candidateDepthPath = path.join(directory, "depth-candidate-518.png");
    await Promise.all([
      writeFile(sourcePath, source),
      writeFile(baselineDepthPath, baseline),
      writeFile(candidateDepthPath, candidate),
      copyFile(
        cachedDepthFile,
        path.join(directory, "depth-cached-baseline.png"),
      ),
    ]);
    let backgroundPath: string | undefined;
    if (reconstruction.completionUrl) {
      const world = JSON.parse(
        await readFile(localArtifact(reconstruction.completionUrl), "utf8"),
      );
      if (world.backgroundUrl) {
        backgroundPath = path.join(directory, "background.jpg");
        await copyFile(localArtifact(world.backgroundUrl), backgroundPath);
      }
    }
    const capture = {
      source: sourcePath,
      referenceOriginal: path.resolve(item.workingPath || item.originalPath),
      baselineDepth: baselineDepthPath,
      candidateDepth: candidateDepthPath,
      ...(backgroundPath ? { background: backgroundPath } : {}),
      baselineRoot: path.join(root, ".local/photo-scene-baseline"),
      baselineMeshMaxEdge: 256,
      candidateMeshMaxEdge: 384,
      projection: {
        near: reconstruction.near,
        far: reconstruction.far,
        fov: reconstruction.fov,
        strength: 1,
        cameraHeight: 1.6,
      },
      views: [
        { name: "source-camera", offset: [0, 0, 0] },
        { name: "left-8cm", offset: [-0.08, 0, 0] },
        { name: "right-8cm", offset: [0.08, 0, 0] },
      ],
      maxOutputEdge: 960,
      outputDir: path.join(directory, "captures"),
    };
    await writeFile(
      path.join(directory, "capture.json"),
      JSON.stringify(capture, null, 2) + "\n",
    );
    const details = {
      index: item.index,
      memoryId: item.memoryId,
      filename: item.filename,
      originalPath: path.resolve(item.workingPath || item.originalPath),
      originalSha256: sha(original),
      servedSourceSha256: sha(source),
      originalPreparationMatches: true,
      sourcePath,
      baselineDepthPath,
      candidateDepthPath,
      backgroundPath,
      predictedDimensions: [depth.width, depth.height],
      modelInputDimensions: [rgb.info.width, rgb.info.height],
      cachedBaselineComparison: {
        dimensionsMatch: mismatchPixels !== null,
        mismatchPixels,
        maxDepthError,
        exactPixels: mismatchPixels === 0,
      },
      hashes: {
        baseline: sha(baseline),
        candidate: sha(candidate),
        cachedBaseline: sha(cached),
      },
      elapsedMs: Math.round(performance.now() - caseStarted),
      rssBytes: process.memoryUsage().rss,
    };
    results.push(details);
    await writeFile(
      path.join(directory, "preparation.json"),
      JSON.stringify(details, null, 2) + "\n",
    );
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          modelId,
          modelSha256,
          preprocessing: "production-1600jpeg92-input518-fp32-cpu",
          cases: results,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ stage: "case-complete", ...details }));
  }
} finally {
  await estimator.dispose();
}
