import type { DepthEstimationPipeline } from "@huggingface/transformers";
import { useLocalModelCache } from "./model-cache.js";

export const DEPTH_MODEL_ID = "onnx-community/depth-anything-v2-small";

export type DepthPixels = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
};
/** An injectable boundary for deterministic tests; production always uses the learned depth model. */
export type DepthEstimator = (image: {
  data: Buffer;
  width: number;
  height: number;
}) => Promise<DepthPixels>;
/**
 * Raw (un-normalized) relative inverse depth: larger values are nearer. Unlike
 * DepthPixels it is not min-max stretched per image, so a flat wall stays flat.
 */
export type RawDepthMap = { data: Float32Array; width: number; height: number };
export type RawDepthEstimator = (image: {
  data: Buffer;
  width: number;
  height: number;
}) => Promise<RawDepthMap>;

/**
 * Where the shared depth session runs. On macOS, WebGPU runs the same fp32
 * weights with matching output and is faster (docs/m5-results.md), so `auto`
 * tries it first and falls back to CPU. Elsewhere it is unmeasured, and a host
 * without a GPU can expose a slow software adapter that never fails, so `auto`
 * stays on CPU; DEPTH_DEVICE=webgpu opts in there with the same CPU fallback.
 * DEPTH_DEVICE=cpu always uses the CPU.
 */
export type DepthDevice = "webgpu" | "cpu";
export function depthDevices(setting = process.env.DEPTH_DEVICE, platform: NodeJS.Platform = process.platform): DepthDevice[] {
  if (setting === "cpu") return ["cpu"];
  if (setting === "webgpu" || platform === "darwin") return ["webgpu", "cpu"];
  return ["cpu"];
}
/** A fixed code, never model error text: worker output may contain paths or provider responses. */
export type DepthFallback = `${DepthDevice}-${"load" | "run"}-failed`;
export const DEPTH_FALLBACKS: readonly DepthFallback[] = ["webgpu-load-failed", "webgpu-run-failed", "cpu-load-failed", "cpu-run-failed"];

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Keeps one session on the first device that works and moves to the next device,
 * for good, only when that device succeeds where the current one failed. An input
 * that fails everywhere therefore never costs the faster device. Callers must not
 * overlap run() calls; depth inference is serialized below.
 */
export class DeviceFallback<T> {
  private session?: Promise<{ device: DepthDevice; value: T }>;
  private readonly retired = new Set<DepthDevice>();
  private active?: DepthDevice;
  private fellBack?: DepthFallback;

  constructor(
    private readonly devices: () => DepthDevice[],
    private readonly create: (device: DepthDevice) => Promise<T>,
    private readonly dispose: (value: T) => Promise<unknown> | void = () => {},
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** The device of the loaded session, if any. */
  get device() {
    return this.active;
  }

  /** The loaded device and, if this process moved off a device, which one and when. */
  status(): { device?: DepthDevice; fallback?: DepthFallback } {
    return { ...(this.active ? { device: this.active } : {}), ...(this.fellBack ? { fallback: this.fellBack } : {}) };
  }

  /** Releasing a session must never replace the error being reported or undo a successful switch. */
  private async release(value: T) {
    try {
      await this.dispose(value);
    } catch {
      /* Best effort: the process exit releases native memory regardless. */
    }
  }

  get(): Promise<{ device: DepthDevice; value: T }> {
    this.session ??= this.load().catch((error) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  private async load() {
    const failures: [DepthDevice, unknown][] = [];
    for (const device of this.devices().filter((candidate) => !this.retired.has(candidate))) {
      try {
        const value = await this.create(device);
        if (failures.length) {
          this.fellBack = `${failures[0][0]}-load-failed`;
          this.log(`[depth] ${failures.map(([name, error]) => `${name} unavailable (${describe(error)})`).join("; ")}; using ${device}`);
        }
        this.active = device;
        return { device, value };
      } catch (error) {
        failures.push([device, error]);
      }
    }
    // Every device failed, so the cause is not the device (for example a missing model): retry all of them next time.
    throw failures.at(-1)?.[1] ?? new Error("No depth device is enabled.");
  }

  private fallbackAfter(device: DepthDevice) {
    const order = this.devices();
    return order.slice(order.indexOf(device) + 1).find((candidate) => !this.retired.has(candidate));
  }

  async run<R>(task: (value: T) => Promise<R>, accept: (result: R) => boolean = () => true): Promise<R> {
    const current = await this.get();
    let failure: unknown;
    try {
      const result = await task(current.value);
      if (accept(result)) return result;
      failure = new Error(`depth on ${current.device} was not finite`);
    } catch (error) {
      failure = error;
    }
    const next = this.fallbackAfter(current.device);
    if (!next) throw failure;
    let replacement: T;
    try {
      replacement = await this.create(next);
    } catch {
      throw failure;
    }
    let result: R;
    try {
      result = await task(replacement);
      if (!accept(result)) throw failure;
    } catch {
      await this.release(replacement);
      throw failure;
    }
    // The next device worked where the current one did not: switch for the rest of this process.
    this.retired.add(current.device);
    this.session = Promise.resolve({ device: next, value: replacement });
    this.active = next;
    this.fellBack = `${current.device}-run-failed`;
    this.log(`[depth] ${current.device} failed (${describe(failure)}); switched to ${next}`);
    await this.release(current.value);
    return result;
  }
}

type SharedModel = {
  sessions: DeviceFallback<DepthEstimationPipeline>;
  processors: Map<number, Promise<{ (image: unknown): Promise<{ pixel_values: unknown }>; size: unknown }>>;
};
const models = new Map<string, SharedModel>();
// One inference at a time across reconstruction and 3D scoring.
let inferenceQueue: Promise<unknown> = Promise.resolve();

/** The model weights are loaded once per cache directory and reused by every caller. */
async function createPipeline(cacheDir: string, device: DepthDevice) {
  const { pipeline } = await import("@huggingface/transformers");
  await useLocalModelCache(cacheDir);
  return pipeline("depth-estimation", DEPTH_MODEL_ID, {
    dtype: "fp32",
    device,
    cache_dir: cacheDir,
    ...(device === "cpu" ? { session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } } : {}),
  });
}

function shared(cacheDir: string) {
  let model = models.get(cacheDir);
  if (!model) {
    model = {
      sessions: new DeviceFallback(() => depthDevices(), (device) => createPipeline(cacheDir, device), (estimate) => estimate.dispose()),
      processors: new Map(),
    };
    models.set(cacheDir, model);
  }
  return model;
}

/** The device (and any fallback) of the shared depth session for this cache directory, once loaded. */
export function depthStatus(cacheDir: string): { device?: DepthDevice; fallback?: DepthFallback } {
  return models.get(cacheDir)?.sessions.status() ?? {};
}

/** The same status as worker diagnostics fields: fixed names only, safe to send over IPC. */
export function depthDiagnostics(cacheDir: string): { depthDevice?: DepthDevice; depthFallback?: DepthFallback } {
  const { device, fallback } = depthStatus(cacheDir);
  return { ...(device ? { depthDevice: device } : {}), ...(fallback ? { depthFallback: fallback } : {}) };
}

/** Accepts only known device names and fallback codes from another process. */
export function parseDepthDiagnostics(value: unknown): { depthDevice?: DepthDevice; depthFallback?: DepthFallback } {
  const item = (value && typeof value === "object" ? value : {}) as { depthDevice?: unknown; depthFallback?: unknown };
  return {
    ...(item.depthDevice === "webgpu" || item.depthDevice === "cpu" ? { depthDevice: item.depthDevice } : {}),
    ...(DEPTH_FALLBACKS.includes(item.depthFallback as DepthFallback) ? { depthFallback: item.depthFallback as DepthFallback } : {}),
  };
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = inferenceQueue.catch(() => {}).then(task);
  inferenceQueue = run;
  return run;
}

const finite = (data: ArrayLike<number>) => {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
};

/** Full-resolution normalized depth used for reconstruction meshes. */
export function sharedDepthEstimator(cacheDir: string): DepthEstimator {
  return (image) =>
    serialized(async () => {
      const { RawImage } = await import("@huggingface/transformers");
      const result = await shared(cacheDir).sessions.run(
        async (estimate) =>
          (await estimate(new RawImage(image.data, image.width, image.height, 3))) as unknown as {
            predicted_depth: { data: ArrayLike<number> };
            depth: DepthPixels;
          },
        (output) => finite(output.predicted_depth.data),
      );
      return result.depth;
    });
}

/**
 * Small, fast raw depth for scoring. It runs the same model session at
 * `inputSize` (a multiple of 14) instead of the processor's default 518px, via
 * a separate lightweight image processor; no second copy of the weights.
 */
export function sharedRawDepthEstimator(
  cacheDir: string,
  inputSize = 252,
): RawDepthEstimator {
  return (image) =>
    serialized(async () => {
      const { RawImage, AutoImageProcessor } = await import(
        "@huggingface/transformers"
      );
      const model = shared(cacheDir);
      let processor = model.processors.get(inputSize);
      if (!processor) {
        processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID, {
          cache_dir: cacheDir,
        }).then((loaded) => {
          const resized = loaded as unknown as { size: unknown };
          resized.size = { width: inputSize, height: inputSize };
          return loaded as never;
        });
        processor.catch(() => model.processors.delete(inputSize));
        model.processors.set(inputSize, processor);
      }
      const inputs = await (await processor)(
        new RawImage(image.data, image.width, image.height, 3),
      );
      const { predicted_depth } = await model.sessions.run(
        async (estimate) =>
          (await estimate.model(inputs)) as {
            predicted_depth: { data: Float32Array; dims: number[] };
          },
        (output) => finite(output.predicted_depth.data),
      );
      const [height, width] = predicted_depth.dims.slice(-2);
      return { data: Float32Array.from(predicted_depth.data), width, height };
    });
}
