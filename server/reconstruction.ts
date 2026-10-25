import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import sharp from "sharp";
import type { Memory, ReconstructionSpec } from "../src/types.js";
import { isReconstructionSpec } from "../src/reconstruction-validation.js";
import { HttpError, isMediaBytes } from "./http.js";
import { publicAddress } from "./media.js";
import {
  ffmpegVideoSampler,
  VIDEO_CACHE_VERSION,
  videoSampleTimes,
  type VideoSampler,
} from "./video-reconstruction.js";
import {
  sharedDepthEstimator,
  type DepthEstimator,
  type DepthPixels,
} from "./depth-model.js";

const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_VERSION = "depth-anything-v2-small-fp32-518-v1";
export type { DepthEstimator, DepthPixels } from "./depth-model.js";

export function allowedReconstructionUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "images.unsplash.com" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

/** Only the bundled sample-photo CDN is fetched. DNS is validated and pinned per redirect. */
export async function downloadReconstructionSource(
  value: string,
  redirects = 0,
): Promise<Buffer> {
  if (!allowedReconstructionUrl(value))
    throw new HttpError(
      400,
      "Archive or upload this photo before turning it into 3D. Remote reconstruction supports only the sample-photo CDN.",
    );
  if (redirects > 3)
    throw new HttpError(
      502,
      "The sample photo redirected too many times. Upload the original photo instead.",
    );
  const url = new URL(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((address) => !publicAddress(address.address))
  )
    throw new HttpError(
      400,
      "The photo host did not resolve to a public address.",
    );
  const address = addresses.find((item) => item.family === 4) || addresses[0];
  const result = await new Promise<Buffer | URL>((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: address.address,
        family: address.family,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          Host: url.hostname,
          Accept: "image/jpeg,image/png,image/webp",
          "User-Agent": "Again/0.1",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.destroy();
          resolve(new URL(response.headers.location, url));
          return;
        }
        const mimeType = (response.headers["content-type"] || "")
          .split(";")[0]
          .toLowerCase()
          .trim();
        if (
          response.statusCode !== 200 ||
          !["image/jpeg", "image/png", "image/webp"].includes(mimeType)
        ) {
          response.destroy();
          reject(
            new HttpError(
              502,
              "The sample photo could not be downloaded. Upload the original photo instead.",
            ),
          );
          return;
        }
        if (Number(response.headers["content-length"] || 0) > MAX_BYTES) {
          response.destroy();
          reject(
            new HttpError(
              413,
              "Use a photo smaller than 15 MB for 3D reconstruction.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(
              new HttpError(
                413,
                "Use a photo smaller than 15 MB for 3D reconstruction.",
              ),
            );
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (!isMediaBytes(bytes, mimeType)) {
            reject(
              new HttpError(
                400,
                "The photo contents do not match their image format.",
              ),
            );
            return;
          }
          resolve(bytes);
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Photo download timed out.")),
      30000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  return result instanceof URL
    ? downloadReconstructionSource(result.href, redirects + 1)
    : result;
}

/** Single-view reconstruction: learned relative depth, not brightness or a recovered scan. */
export class SceneReconstructor {
  private readonly pending = new Map<string, Promise<ReconstructionSpec>>();
  private readonly estimator: DepthEstimator;
  private readonly videoSampler: VideoSampler;
  private inferenceQueue: Promise<unknown> = Promise.resolve();
  readonly artifactDir: string;
  constructor(
    readonly uploadsDir: string,
    options: {
      estimator?: DepthEstimator;
      modelCacheDir?: string;
      videoSampler?: VideoSampler;
    } = {},
  ) {
    this.artifactDir = path.join(uploadsDir, "reconstructions");
    this.estimator =
      options.estimator ||
      sharedDepthEstimator(
        options.modelCacheDir || path.join(path.dirname(uploadsDir), "models"),
      );
    this.videoSampler = options.videoSampler || ffmpegVideoSampler;
  }

  async reconstruct(memory: Memory): Promise<ReconstructionSpec> {
    // This lookup is source-specific, so metadata edits reuse the same geometry.
    const cacheVersion =
      memory.mediaType === "video"
        ? `${CACHE_VERSION}:${VIDEO_CACHE_VERSION}`
        : CACHE_VERSION;
    const sourceKey = createHash("sha256")
      .update(`${cacheVersion}:${memory.mediaType}:${memory.url}`)
      .digest("hex")
      .slice(0, 32);
    const existing = this.pending.get(sourceKey);
    if (existing) return existing;
    const operation = this.build(memory, sourceKey).finally(() =>
      this.pending.delete(sourceKey),
    );
    this.pending.set(sourceKey, operation);
    return operation;
  }

  private async sourceBytes(memory: Memory): Promise<Buffer> {
    if (memory.url.startsWith("/uploads/")) {
      // Catalog URLs are data, not trusted filesystem paths. Only flat, literal upload filenames are accepted.
      const filename = memory.url.slice("/uploads/".length);
      if (!/^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(filename))
        throw new HttpError(
          400,
          "This image path cannot be used for 3D reconstruction. Upload the original photo again.",
        );
      const file = path.join(this.uploadsDir, filename);
      try {
        if ((await stat(file)).size > MAX_BYTES)
          throw new HttpError(
            413,
            "Use a photo smaller than 15 MB for 3D reconstruction.",
          );
        return await readFile(file);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          404,
          "The original photo is missing. Upload it again to turn it into 3D.",
        );
      }
    }
    return downloadReconstructionSource(memory.url);
  }

  private async cached(
    sourceKey: string,
    fingerprint?: string,
  ): Promise<ReconstructionSpec | undefined> {
    try {
      const saved = JSON.parse(
        await readFile(
          path.join(this.artifactDir, `${sourceKey}.json`),
          "utf8",
        ),
      ) as { fingerprint: string; reconstruction: ReconstructionSpec };
      if (!/^[a-f0-9]{32}$/.test(saved.fingerprint)) return;
      if (fingerprint && saved.fingerprint !== fingerprint) return;
      const reconstruction = saved.reconstruction;
      const artifactPrefix = `/uploads/reconstructions/${saved.fingerprint}`;
      if (
        !isReconstructionSpec(reconstruction) ||
        reconstruction.sourceUrl !== `${artifactPrefix}-source.jpg` ||
        reconstruction.depthUrl !== `${artifactPrefix}-depth.png`
      )
        return;
      await Promise.all([
        stat(path.join(this.artifactDir, `${saved.fingerprint}-source.jpg`)),
        stat(path.join(this.artifactDir, `${saved.fingerprint}-depth.png`)),
      ]);
      if (reconstruction.video) {
        for (const [index, frame] of reconstruction.video.frames.entries()) {
          const key =
            index === 0
              ? saved.fingerprint
              : this.frameKey(saved.fingerprint, frame.time);
          if (
            frame.sourceUrl !== `/uploads/reconstructions/${key}-source.jpg` ||
            frame.depthUrl !== `/uploads/reconstructions/${key}-depth.png`
          )
            return;
          await Promise.all([
            stat(path.join(this.artifactDir, `${key}-source.jpg`)),
            stat(path.join(this.artifactDir, `${key}-depth.png`)),
          ]);
        }
      }
      return reconstruction;
    } catch {
      return undefined;
    }
  }

  private async build(
    memory: Memory,
    sourceKey: string,
  ): Promise<ReconstructionSpec> {
    await mkdir(this.artifactDir, { recursive: true });
    if (memory.mediaType === "video") return this.buildVideo(memory, sourceKey);
    // Immutable sample CDN URLs can be reused offline; local files are content-hashed to detect replacement.
    if (!memory.url.startsWith("/uploads/")) {
      const cached = await this.cached(sourceKey);
      if (cached) return cached;
    }
    let source: Buffer;
    try {
      source = await this.sourceBytes(memory);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "The photo could not be loaded for 3D. Check the connection or upload the original photo.",
      );
    }
    const fingerprint = createHash("sha256")
      .update(CACHE_VERSION)
      .update(source)
      .digest("hex")
      .slice(0, 32);
    const cached = await this.cached(sourceKey, fingerprint);
    if (cached) return cached;
    let width: number;
    let height: number;
    let texture: Buffer;
    let modelInput: { data: Buffer; width: number; height: number };
    try {
      const prepared = await sharp(source, {
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
        .toBuffer({ resolveWithObject: true });
      texture = prepared.data;
      width = prepared.info.width;
      height = prepared.info.height;
      if (width < 16 || height < 16) throw new Error("The photo is too small.");
      const rgb = await sharp(texture)
        .resize({
          width: 518,
          height: 518,
          fit: "inside",
          withoutEnlargement: true,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      modelInput = {
        data: rgb.data,
        width: rgb.info.width,
        height: rgb.info.height,
      };
    } catch {
      throw new HttpError(
        400,
        "Use a valid photo at least 16 pixels wide and high after resizing, with no more than 40 megapixels.",
      );
    }
    const infer = async () => {
      try {
        return await this.estimator(modelInput);
      } catch {
        throw new HttpError(
          503,
          "The depth model could not run. On first use the server downloads Depth Anything V2 from Hugging Face. Check the server internet connection and available memory, then retry.",
        );
      }
    };
    // Avoid simultaneous CPU inference/model allocations when several people select photos.
    const inference = this.inferenceQueue.catch(() => {}).then(infer);
    this.inferenceQueue = inference;
    const depth = await inference;
    if (
      !depth.width ||
      !depth.height ||
      depth.data.length !== depth.width * depth.height * depth.channels
    )
      throw new HttpError(
        503,
        "The depth model returned an invalid image. Retry the reconstruction.",
      );
    const depthPng = await sharp(Buffer.from(depth.data), {
      raw: {
        width: depth.width,
        height: depth.height,
        channels: depth.channels,
      },
    })
      .resize({
        width: 256,
        height: 256,
        fit: "inside",
        withoutEnlargement: true,
      })
      .grayscale()
      .png()
      .toBuffer();
    const prefix = `${fingerprint}`;
    const reconstruction: ReconstructionSpec = {
      version: 1,
      kind: "depth-mesh",
      sourceUrl: `/uploads/reconstructions/${prefix}-source.jpg`,
      depthUrl: `/uploads/reconstructions/${prefix}-depth.png`,
      width,
      height,
      depthSource: "depth-anything-v2",
      near: 2,
      far: 12,
      fov: 60,
      mediaBasis: "image",
    };
    if (!isReconstructionSpec(reconstruction))
      throw new HttpError(
        503,
        "The reconstruction metadata is invalid. Retry this photo.",
      );
    // Complete both artifacts before exposing metadata; a partial/failed build can be retried.
    await Promise.all([
      writeFile(path.join(this.artifactDir, `${prefix}-source.jpg`), texture),
      writeFile(path.join(this.artifactDir, `${prefix}-depth.png`), depthPng),
    ]);
    const metadataPath = path.join(this.artifactDir, `${sourceKey}.json`);
    await writeFile(
      `${metadataPath}.tmp`,
      JSON.stringify({ fingerprint, reconstruction }),
    );
    await rename(`${metadataPath}.tmp`, metadataPath);
    return reconstruction;
  }

  private frameKey(fingerprint: string, time: number) {
    return createHash("sha256")
      .update(`${fingerprint}:${time}`)
      .digest("hex")
      .slice(0, 32);
  }

  private async buildVideo(
    memory: Memory,
    sourceKey: string,
  ): Promise<ReconstructionSpec> {
    const filename = memory.url.slice("/uploads/".length);
    if (
      !memory.url.startsWith("/uploads/") ||
      !/^[A-Za-z0-9_-]+\.(?:mp4|webm|mov)$/i.test(filename)
    )
      throw new HttpError(
        422,
        "Upload or archive this video locally to immerse in it.",
      );
    const file = path.join(this.uploadsDir, filename);
    let bytes: Buffer;
    try {
      if ((await stat(file)).size > 50 * 1024 * 1024)
        throw new HttpError(
          413,
          "Use a video smaller than 50 MB for 3D reconstruction.",
        );
      bytes = await readFile(file);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        404,
        "The original video is missing. Upload it again to immerse in it.",
      );
    }
    // Hash the whole video: clips with identical opening frames can have different motion.
    const fingerprint = createHash("sha256")
      .update(CACHE_VERSION)
      .update(VIDEO_CACHE_VERSION)
      .update(bytes)
      .digest("hex")
      .slice(0, 32);
    const cached = await this.cached(sourceKey, fingerprint);
    if (cached?.video) return cached;
    const duration = await this.videoSampler.duration(file);
    const times = videoSampleTimes(duration);
    const frames = [];
    let width = 0,
      height = 0;
    for (const [index, time] of times.entries()) {
      const frame = await this.videoSampler.frame(file, time);
      const prepared = await sharp(frame, { limitInputPixels: 40_000_000 })
        .rotate()
        .flatten({ background: "#101722" })
        .resize({
          width: 512,
          height: 512,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
      if (prepared.info.width < 16 || prepared.info.height < 16)
        throw new HttpError(
          422,
          "Video frames must be at least 16 pixels wide and high.",
        );
      if (!index) {
        width = prepared.info.width;
        height = prepared.info.height;
      }
      if (prepared.info.width !== width || prepared.info.height !== height)
        throw new HttpError(
          422,
          "Video frame dimensions changed during playback. Export this video at a fixed resolution.",
        );
      const rgb = await sharp(prepared.data).removeAlpha().raw().toBuffer();
      const inference = this.inferenceQueue
        .catch(() => {})
        .then(() => this.estimator({ data: rgb, width, height }));
      this.inferenceQueue = inference;
      let depth: DepthPixels;
      try {
        depth = await inference;
      } catch {
        throw new HttpError(
          503,
          "The video depth model could not run. Check the server connection to Hugging Face and available memory, then retry.",
        );
      }
      if (
        !depth.width ||
        !depth.height ||
        depth.data.length !== depth.width * depth.height * depth.channels
      )
        throw new HttpError(
          503,
          "The depth model returned an invalid video frame. Retry the reconstruction.",
        );
      const depthPng = await sharp(Buffer.from(depth.data), {
        raw: {
          width: depth.width,
          height: depth.height,
          channels: depth.channels,
        },
      })
        .resize({
          width: 128,
          height: 128,
          fit: "inside",
          withoutEnlargement: true,
        })
        .grayscale()
        .png()
        .toBuffer();
      const key = index === 0 ? fingerprint : this.frameKey(fingerprint, time);
      await Promise.all([
        writeFile(
          path.join(this.artifactDir, `${key}-source.jpg`),
          prepared.data,
        ),
        writeFile(path.join(this.artifactDir, `${key}-depth.png`), depthPng),
      ]);
      frames.push({
        time,
        sourceUrl: `/uploads/reconstructions/${key}-source.jpg`,
        depthUrl: `/uploads/reconstructions/${key}-depth.png`,
      });
    }
    const reconstruction: ReconstructionSpec = {
      version: 1,
      kind: "depth-mesh",
      sourceUrl: frames[0].sourceUrl,
      depthUrl: frames[0].depthUrl,
      width,
      height,
      depthSource: "depth-anything-v2",
      near: 2,
      far: 12,
      fov: 60,
      mediaBasis: "video-sequence",
      video: { version: 1, duration, frames },
    };
    if (!isReconstructionSpec(reconstruction))
      throw new HttpError(
        503,
        "The video reconstruction metadata is invalid. Retry this video.",
      );
    const metadataPath = path.join(this.artifactDir, `${sourceKey}.json`);
    await writeFile(
      `${metadataPath}.tmp`,
      JSON.stringify({ fingerprint, reconstruction }),
    );
    await rename(`${metadataPath}.tmp`, metadataPath);
    return reconstruction;
  }
}
