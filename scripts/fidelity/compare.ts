import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const readJson = async (path: string): Promise<any> =>
  JSON.parse(await readFile(path, "utf8"));
const optionalJson = async (path: string) =>
  readJson(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

export interface CompareOptions {
  port?: number;
  inventory?: string;
  ablationRoot?: string;
}
type FileMap = Map<string, string>;

export async function comparisonData(options: CompareOptions = {}) {
  const inventoryPath = resolve(
    options.inventory ??
      join(repository, ".local/photo-scene-test-results.json"),
  );
  const ablationRoot = resolve(
    options.ablationRoot ?? join(repository, ".local/depth-fidelity-v1"),
  );
  const inventory = await readJson(inventoryPath);
  const regions = await readJson(join(here, "cafe-regions.json"));
  if (!Array.isArray(inventory.items) || !Array.isArray(regions.photos))
    throw new Error("Photo inventory or reviewed regions are invalid");
  const files: FileMap = new Map();
  const asset = async (path: string | undefined) => {
    if (!path) return null;
    const absolute = resolve(path);
    try {
      if (!(await stat(absolute)).isFile()) return null;
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const id = createHash("sha256").update(absolute).digest("hex").slice(0, 24);
    files.set(`/asset/${id}`, absolute);
    return `/asset/${id}`;
  };
  const variants = [
    {
      id: "depth-256",
      label: "Depth 256 · baseline",
      description: "Saved 256×192 depth surface using the frozen renderer.",
      kind: "baseline",
    },
    {
      id: "depth-384",
      label: "Depth 384 · retained detail",
      description:
        "Same prediction retained at 518×389, nearest-sampled to a 384×288 mesh; same frozen renderer.",
      kind: "candidate",
    },
    {
      id: "plane",
      label: "Flat plane · control",
      description:
        "The source texture on a flat plane; a registration/filtering control, not a 3D reconstruction.",
      kind: "control",
    },
  ];
  const photos = [];
  for (const item of inventory.items) {
    if (!Number.isInteger(item.index) || item.index < 1)
      throw new Error("Invalid photo index in inventory");
    const folder = join(
      ablationRoot,
      `case-${String(item.index).padStart(2, "0")}`,
      "captures",
    );
    const [capture, global, regional, plane] = await Promise.all([
      optionalJson(join(folder, "capture-report.json")),
      optionalJson(join(folder, "global-scores.json")),
      optionalJson(join(folder, "evaluation-regions.json")),
      optionalJson(join(folder, "plane-scores.json")),
    ]);
    const scoreValid = (report: any) =>
      report?.view === "source-camera" && report?.alignmentVerified === true;
    const crops = (
      regions.photos.find((photo: any) => photo.index === item.index)
        ?.regions ?? []
    ).map((r: any) => ({ id: r.id, box: r.box, description: r.description }));
    const runs: Record<string, any> = {};
    for (const [id, prefix, key, scores] of [
      ["depth-256", "baseline", "baseline", global],
      ["depth-384", "candidate", "candidate", global],
      ["plane", "plane", "baseline", plane],
    ] as const) {
      const views: Record<string, string | null> = {};
      for (const view of ["source-camera", "left-8cm", "right-8cm"])
        views[view] = await asset(join(folder, `${prefix}-${view}.png`));
      const regionScores =
        id === "plane" || !scoreValid(regional)
          ? {}
          : Object.fromEntries(
              (regional.regions ?? []).map((r: any) => [r.name, r[key]]),
            );
      runs[id] = {
        views,
        global: scoreValid(scores) ? (scores.global?.[key] ?? null) : null,
        regions: regionScores,
        geometry: capture?.metadata?.variants?.[prefix] ?? null,
      };
    }
    photos.push({
      index: item.index,
      title:
        item.title ??
        `${String(item.index).padStart(2, "0")} · ${item.filename}`,
      filename: item.filename,
      description: item.visibleDescription ?? "",
      thumbnail: await asset(item.thumbnailPath),
      original: await asset(item.originalPath),
      reference: await asset(join(folder, "source-reference.png")),
      crops,
      runs,
      provenance: capture
        ? {
            experiment: capture.experiment,
            generatedAt: capture.generatedAt,
            dimensions: {
              width: capture.metadata?.width,
              height: capture.metadata?.height,
            },
            browserBundleSha256: capture.browserBundleSha256,
            inputHashes: Object.fromEntries(
              Object.entries(capture.inputs ?? {}).map(
                ([key, value]: [string, any]) => [key, value.sha256],
              ),
            ),
            projection: capture.metadata?.projection,
            views: capture.configuration?.views,
            frozenImplementation: Object.fromEntries(
              Object.entries(capture.frozenImplementation ?? {}).map(
                ([key, value]: [string, any]) => [key, value.sha256],
              ),
            ),
            reports: {
              capture: await asset(join(folder, "capture-report.json")),
              global: await asset(join(folder, "global-scores.json")),
              regions: await asset(join(folder, "evaluation-regions.json")),
              plane: await asset(join(folder, "plane-scores.json")),
            },
          }
        : null,
    });
  }
  const measuredCount = photos.filter(
    (photo) =>
      photo.runs["depth-256"].views["source-camera"] &&
      photo.runs["depth-384"].views["source-camera"] &&
      photo.runs["depth-256"].global &&
      photo.runs["depth-384"].global,
  ).length;
  return {
    files,
    data: {
      title: "Photo fidelity comparisons",
      total: photos.length,
      measuredCount,
      inventorySnapshot: inventory.updatedAt ?? null,
      resultsReport: await asset(
        join(repository, "docs/depth-resolution-results.md"),
      ),
      variants,
      photos,
    },
  };
}

export async function serveComparison(options: CompareOptions = {}) {
  const port = options.port ?? 5181;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Port must be an integer from 1024 to 65535");
  const { data, files } = await comparisonData(options);
  const staticFiles: Record<string, string> = {
    "/": "compare.html",
    "/compare-client.js": "compare-client.js",
    "/compare.css": "compare.css",
  };
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("Read-only viewer");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/data") {
        response.writeHead(200, {
          "content-type": types[".json"],
          "cache-control": "no-store",
        });
        response.end(
          request.method === "HEAD" ? undefined : JSON.stringify(data),
        );
        return;
      }
      const path = staticFiles[url.pathname]
        ? join(here, staticFiles[url.pathname])
        : files.get(url.pathname);
      if (!path) {
        response.writeHead(404).end("Unavailable asset");
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        "content-type":
          types[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error: any) {
      response
        .writeHead(error.code === "ENOENT" ? 404 : 500, {
          "content-type": "text/plain",
        })
        .end("Saved comparison asset could not be read");
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    measuredCount: data.measuredCount,
    total: data.total,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options: CompareOptions = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!value || !["--port", "--inventory", "--ablation-root"].includes(key))
      throw new Error(
        "Usage: npx tsx scripts/fidelity/compare.ts [--port 5181] [--inventory inventory.json] [--ablation-root directory]",
      );
    if (key === "--port") options.port = Number(value);
    else if (key === "--inventory") options.inventory = value;
    else options.ablationRoot = value;
  }
  serveComparison(options)
    .then(({ server, ...info }) => {
      process.stdout.write(`${JSON.stringify(info)}\n`);
      const stop = () => server.close(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error) => {
      process.stderr.write(`Comparison viewer failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
