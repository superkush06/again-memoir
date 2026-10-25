import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";
import { cappedDimensions } from "./capture-math.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaults = {
  playwrightModule:
    "C:/Users/prran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  browserExecutable: "C:/Program Files/Google/Chrome/Application/chrome.exe",
};

export interface CaptureManifest {
  source: string;
  baselineDepth: string;
  candidateDepth: string;
  background?: string;
  referenceOriginal?: string;
  baselineRoot: string;
  outputDir?: string;
  maxOutputEdge?: number;
  baselineMeshMaxEdge?: number;
  candidateMeshMaxEdge?: number;
  projection?: {
    near?: number;
    far?: number;
    fov?: number;
    strength?: number;
    cameraHeight?: number;
  };
  views?: { name: string; offset: [number, number, number] }[];
  playwrightModule?: string;
  browserExecutable?: string;
  provenance?: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes: Buffer | Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function parseCaptureManifest(value: unknown): CaptureManifest {
  if (!record(value)) throw new Error("Capture manifest must be an object");
  const allowed = new Set([
    "source",
    "baselineDepth",
    "candidateDepth",
    "background",
    "referenceOriginal",
    "baselineRoot",
    "outputDir",
    "maxOutputEdge",
    "baselineMeshMaxEdge",
    "candidateMeshMaxEdge",
    "projection",
    "views",
    "playwrightModule",
    "browserExecutable",
    "provenance",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unknown capture manifest field");
  for (const key of [
    "source",
    "baselineDepth",
    "candidateDepth",
    "baselineRoot",
  ]) {
    if (typeof value[key] !== "string" || !value[key].trim())
      throw new Error(`Missing ${key} path`);
  }
  for (const key of [
    "background",
    "referenceOriginal",
    "outputDir",
    "playwrightModule",
    "browserExecutable",
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].trim())
    )
      throw new Error(`${key} must be a nonempty path`);
  }
  for (const key of [
    "maxOutputEdge",
    "baselineMeshMaxEdge",
    "candidateMeshMaxEdge",
  ]) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 2 ||
        Number(value[key]) > 4096)
    )
      throw new Error(`${key} must be an integer from 2 to 4096`);
  }
  if (value.projection !== undefined) {
    if (
      !record(value.projection) ||
      Object.keys(value.projection).some(
        (key) =>
          !["near", "far", "fov", "strength", "cameraHeight"].includes(key),
      ) ||
      Object.values(value.projection).some(
        (item) => typeof item !== "number" || !Number.isFinite(item),
      )
    )
      throw new Error("Invalid projection options");
    if (
      value.projection.strength !== undefined &&
      value.projection.strength !== 1
    )
      throw new Error("Depth resolution experiment requires fixed strength 1");
  }
  if (value.views !== undefined) {
    if (!Array.isArray(value.views) || !value.views.length)
      throw new Error("views must be a nonempty array");
    const names = new Set<string>();
    for (const view of value.views) {
      if (
        !record(view) ||
        Object.keys(view).some((key) => !["name", "offset"].includes(key)) ||
        typeof view.name !== "string" ||
        !/^[a-z0-9][a-z0-9-]*$/.test(view.name) ||
        names.has(view.name) ||
        !Array.isArray(view.offset) ||
        view.offset.length !== 3 ||
        view.offset.some((n) => typeof n !== "number" || !Number.isFinite(n))
      )
        throw new Error(
          "Each view requires a unique filename-safe name and three finite translation values",
        );
      names.add(view.name);
    }
    const source = value.views.find((view) => view.name === "source-camera");
    if (!source || source.offset.some((n: number) => n !== 0))
      throw new Error("views must include source-camera with offset [0,0,0]");
  }
  if (value.provenance !== undefined && !record(value.provenance))
    throw new Error("provenance must be an object");
  return value as unknown as CaptureManifest;
}

async function normalizedImage(path: string) {
  const bytes = await readFile(path);
  const metadata = await sharp(bytes).metadata();
  if ((metadata.pages ?? 1) !== 1)
    throw new Error(`${path}: only single images are supported`);
  if (metadata.hasAlpha && !(await sharp(bytes).stats()).isOpaque)
    throw new Error(`${path}: image must be fully opaque`);
  const png = await sharp(bytes)
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    data: png.data,
    width: png.info.width,
    height: png.info.height,
    input: {
      path,
      sha256: sha256(bytes),
      normalizedPngSha256: sha256(png.data),
    },
  };
}

async function coverageStats(png: Buffer) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let covered = 0,
    partial = 0,
    intensity = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const sample = data[i * info.channels];
    if (sample >= 128) covered++;
    if (sample > 0 && sample < 255) partial++;
    intensity += sample;
  }
  const count = info.width * info.height;
  return {
    pixelCount: count,
    uncoveredPixelFraction: 1 - covered / count,
    partialCoveragePixelFraction: partial / count,
    meanWhiteCoverage: intensity / (count * 255),
    thresholdInclusive: 128,
  };
}

export async function captureManifest(manifestPath: string) {
  const manifestAbsolute = resolve(manifestPath);
  const manifestBytes = await readFile(manifestAbsolute);
  const manifest = parseCaptureManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const local = (path: string) => resolve(dirname(manifestAbsolute), path);
  const outputDir = local(manifest.outputDir ?? "captures");
  const baselineRoot = local(manifest.baselineRoot);
  const frozenFiles = {
    surface: join(baselineRoot, "src/scene/photo-surface.ts"),
    projection: join(baselineRoot, "src/scene/reconstruction.ts"),
    clean: join(baselineRoot, "src/scene/photo-depth.ts"),
  };
  const source = await normalizedImage(local(manifest.source));
  const background = await normalizedImage(
    local(manifest.background ?? manifest.source),
  );
  const original = await normalizedImage(
    local(manifest.referenceOriginal ?? manifest.source),
  );
  const baselineDepth = await normalizedImage(local(manifest.baselineDepth));
  const candidateDepth = await normalizedImage(local(manifest.candidateDepth));
  const outputSize = cappedDimensions(
    source.width,
    source.height,
    manifest.maxOutputEdge ?? 960,
  );
  if (
    Math.abs(original.width / original.height - source.width / source.height) >
    0.001
  )
    throw new Error(
      "Reference original and served source must have the same aspect ratio; automatic crop/registration is not allowed",
    );
  const projection = {
    near: 2,
    far: 12,
    fov: 60,
    strength: 1,
    cameraHeight: 1.6,
    ...manifest.projection,
  };
  if (!(
    projection.near > 0 &&
    projection.far > projection.near &&
    projection.fov > 0 &&
    projection.fov < 150 &&
    projection.strength === 1
  ))
    throw new Error("Invalid projection or non-unit strength");
  const views = manifest.views ?? [
    { name: "source-camera", offset: [0, 0, 0] },
    { name: "left-08cm", offset: [-0.08, 0, 0] },
    { name: "right-08cm", offset: [0.08, 0, 0] },
  ];
  const browserConfig = {
    ...outputSize,
    baselineMeshMaxEdge: manifest.baselineMeshMaxEdge ?? 256,
    candidateMeshMaxEdge: manifest.candidateMeshMaxEdge ?? 384,
    projection,
    views,
  };
  const frozenHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(frozenFiles).map(async ([key, path]) => [
        key,
        { path, sha256: sha256(await readFile(path)) },
      ]),
    ),
  );
  const bundle = await build({
    entryPoints: [join(here, "capture-client.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    logLevel: "silent",
    plugins: [
      {
        name: "frozen-photo-geometry",
        setup(context) {
          context.onResolve({ filter: /^fidelity-frozen-surface$/ }, () => ({
            path: frozenFiles.surface,
          }));
          context.onResolve({ filter: /^fidelity-frozen-clean$/ }, () => ({
            path: frozenFiles.clean,
          }));
        },
      },
    ],
  });
  const javascript = bundle.outputFiles[0].contents;
  const reference = await sharp(original.data)
    .resize(outputSize.width, outputSize.height, {
      fit: "fill",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
  const routes = new Map<
    string,
    { type: string; data: Buffer | Uint8Array | string }
  >([
    [
      "/",
      {
        type: "text/html",
        data: '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:black}canvas{display:block}</style></head><body><script type="module" src="/capture.js"></script></body></html>',
      },
    ],
    ["/capture.js", { type: "text/javascript", data: javascript }],
    [
      "/config.json",
      { type: "application/json", data: JSON.stringify(browserConfig) },
    ],
    ["/source-image", { type: "image/png", data: source.data }],
    ["/background-image", { type: "image/png", data: background.data }],
    ["/baseline-depth", { type: "image/png", data: baselineDepth.data }],
    ["/candidate-depth", { type: "image/png", data: candidateDepth.data }],
  ]);
  const server = createServer((request, response) => {
    const route = routes.get(request.url ?? "/");
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": route.type,
      "cache-control": "no-store",
    });
    response.end(route.data);
  });
  const playwrightModule = local(
    manifest.playwrightModule ?? defaults.playwrightModule,
  );
  const executablePath = local(
    manifest.browserExecutable ?? defaults.browserExecutable,
  );
  await stat(playwrightModule);
  await stat(executablePath);
  const playwright = await import(pathToFileURL(playwrightModule).href);
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  let browser: any;
  try {
    browser = await playwright.chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--force-color-profile=srgb",
      ],
    });
    const page = await browser.newPage({
      viewport: outputSize,
      deviceScaleFactor: 1,
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Local capture server failed");
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "load",
      timeout: 120000,
    });
    await page.waitForFunction(
      () =>
        Boolean(
          (window as any).fidelityCapture ||
          (window as any).fidelityCaptureError,
        ),
      undefined,
      { timeout: 120000 },
    );
    const error = await page.evaluate(
      () => (window as any).fidelityCaptureError,
    );
    if (error || pageErrors.length)
      throw new Error([error, ...pageErrors].filter(Boolean).join("\n"));
    const metadata = await page.evaluate(
      () => (window as any).fidelityCapture.metadata,
    );
    await mkdir(outputDir, { recursive: true });
    const protectedPaths = [
      manifestAbsolute,
      source.input.path,
      background.input.path,
      original.input.path,
      baselineDepth.input.path,
      candidateDepth.input.path,
    ].map((path) =>
      process.platform === "win32"
        ? resolve(path).toLowerCase()
        : resolve(path),
    );
    const save = async (
      filename: string,
      data: string | Buffer | Uint8Array,
    ) => {
      const path = join(outputDir, filename);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (protectedPaths.includes(key))
        throw new Error(`Output would overwrite input: ${path}`);
      await writeFile(path, data);
      return { path, sha256: sha256(data) };
    };
    const artifacts: Record<string, unknown> = {};
    artifacts.reference = await save("source-reference.png", reference);
    artifacts.textureSource = await save("texture-source.png", source.data);
    artifacts.textureBackground = await save(
      "texture-background.png",
      background.data,
    );
    const captures = [];
    for (const variant of ["baseline", "candidate", "plane"]) {
      for (const view of views) {
        for (const coverage of [false, true]) {
          const result = await page.evaluate(
            ({
              variant,
              view,
              coverage,
            }: {
              variant: string;
              view: string;
              coverage: boolean;
            }) =>
              (window as any).fidelityCapture.capture(variant, view, coverage),
            { variant, view: view.name, coverage },
          );
          if (!result.image.startsWith("data:image/png;base64,"))
            throw new Error("Canvas did not return PNG data");
          const bytes = Buffer.from(
            result.image.slice("data:image/png;base64,".length),
            "base64",
          );
          const file = await save(
            `${variant}-${view.name}${coverage ? "-coverage" : ""}.png`,
            bytes,
          );
          captures.push({
            ...result.metadata,
            ...file,
            ...(coverage ? { coverageStats: await coverageStats(bytes) } : {}),
          });
        }
      }
    }
    const captureReport = {
      schemaVersion: 1,
      experiment:
        "depth-resolution-only; same frozen photo surface, triangulation and speckle cleaning",
      generatedAt: new Date().toISOString(),
      inputManifest: { path: manifestAbsolute, sha256: sha256(manifestBytes) },
      inputs: {
        source: source.input,
        referenceOriginal: original.input,
        background: background.input,
        baselineDepth: baselineDepth.input,
        candidateDepth: candidateDepth.input,
      },
      frozenImplementation: frozenHashes,
      browserBundleSha256: sha256(javascript),
      browserVersion: await browser.version(),
      configuration: browserConfig,
      metadata,
      captures,
      artifacts,
      provenance: manifest.provenance ?? {},
      limitations: [
        "Isolated photographic depth-surface ablation, not the complete application world; body/object replacement and environment geometry are excluded.",
        "Both variants use identical frozen triangulation, cleaning, textures, projection and renderer. Only supplied depth and nearest-sampled mesh resolution differ.",
        "Input depth predictions must come from the same model pass to isolate retention/resampling; this tool records paths/hashes but cannot establish that independently.",
        "Reference original is explicitly resized once with Lanczos3 to the fixed output size. Plane control measures texture resampling/registration/color differences shared by the surface renders.",
        "Coverage images show white foreground only on black with no backing. White coverage can include MSAA edge pixels; threshold and mean are reported.",
        "Side views have no held-out ground-truth photograph and are for qualitative/coverage inspection only; do not compare their image errors to the front reference.",
        "Headless SwiftShader render timings include gl.finish and are diagnostic, not Quest or hardware GPU performance measurements.",
      ],
    };
    await save(
      "capture-report.json",
      `${JSON.stringify(captureReport, null, 2)}\n`,
    );
    const evaluatorManifest = {
      view: "source-camera",
      alignmentVerified: true,
      reference: "source-reference.png",
      baseline: "baseline-source-camera.png",
      candidate: "candidate-source-camera.png",
      capture: {
        width: outputSize.width,
        height: outputSize.height,
        camera: metadata.projection,
        canvasOnly: true,
        sourceCameraOffset: [0, 0, 0],
        report: "capture-report.json",
        alignmentBasis:
          "Shared source-frustum UV projection; caller must verify original/source crop equality; plane-control PNG available",
      },
      provenance: {
        ...manifest.provenance,
        experiment: captureReport.experiment,
        frozenImplementation: frozenHashes,
        baselineDepth: baselineDepth.input,
        candidateDepth: candidateDepth.input,
      },
    };
    await save(
      "evaluate.json",
      `${JSON.stringify(evaluatorManifest, null, 2)}\n`,
    );
    await save(
      "evaluate-plane-control.json",
      `${JSON.stringify({ ...evaluatorManifest, baseline: "plane-source-camera.png", candidate: "plane-source-camera.png" }, null, 2)}\n`,
    );
    return {
      outputDir,
      evaluateManifest: join(outputDir, "evaluate.json"),
      captureReport: join(outputDir, "capture-report.json"),
      captureCount: captures.length,
      dimensions: outputSize,
    };
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolveServer, reject) =>
      server.close((error) => (error ? reject(error) : resolveServer())),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3) {
    process.stderr.write(
      "Usage: npx tsx scripts/fidelity/capture.ts <capture.json>\n",
    );
    process.exitCode = 1;
  } else
    captureManifest(process.argv[2])
      .then((result) =>
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
      )
      .catch((error: unknown) => {
        process.stderr.write(
          `Capture failed: ${error instanceof Error ? error.stack : String(error)}\n`,
        );
        process.exitCode = 1;
      });
}
