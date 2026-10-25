import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { depthStatus, DEPTH_MODEL_ID, sharedDepthEstimator, sharedRawDepthEstimator, type DepthEstimator, type RawDepthEstimator } from '../../server/depth-model.js';
import { useLocalModelCache } from '../../server/model-cache.js';
import { READINESS_INPUT_SIZE } from '../../server/depth-readiness.js';
import { gitCommit, machineInfo, peakFootprintBytes, photoFiles, sha256, writeFloat32, type DumpPhoto, type DumpRun } from './dump-format.js';

/**
 * Depth Anything V2 runner for the M5 suite. --device auto (the production default),
 * webgpu (prefer WebGPU, CPU fallback) and cpu with 4 threads call the production
 * estimators unchanged through DEPTH_DEVICE, and record the device each photo
 * actually ran on. coreml, or cpu with another thread count, is a compute probe
 * on the same ONNX weights.
 */
const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const input = value('--input'); const output = value('--output');
if (!input || !output) throw new Error('Usage: npx tsx scripts/m5/da2-runner.ts --input <photo-dir> --output <dump-dir> [--device auto|webgpu|cpu|coreml] [--threads 4] [--repeats 3]');
const device = value('--device', 'auto')!; const threads = Number(value('--threads', '4')); const repeats = Number(value('--repeats', '3'));
if (!['auto', 'webgpu', 'cpu', 'coreml'].includes(device)) throw new Error(`Unknown --device ${device}; use auto, webgpu, cpu or coreml.`);
if (args.includes('--threads') && device !== 'cpu') throw new Error('--threads applies only to --device cpu.');
const production = device === 'auto' || device === 'webgpu' || (device === 'cpu' && threads === 4);
if (production) { if (device === 'auto') delete process.env.DEPTH_DEVICE; else process.env.DEPTH_DEVICE = device; }
const modelCacheDir = process.env.MODEL_CACHE_DIR || path.resolve('data/models');

async function probeEstimators(): Promise<{ reconstruct: DepthEstimator; readiness: RawDepthEstimator }> {
  const { pipeline, RawImage, AutoImageProcessor } = await import('@huggingface/transformers');
  await useLocalModelCache(modelCacheDir);
  const estimate = await pipeline('depth-estimation', DEPTH_MODEL_ID, { dtype: 'fp32', device: device as never, cache_dir: modelCacheDir, ...(device === 'cpu' ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}) });
  const processor = await AutoImageProcessor.from_pretrained(DEPTH_MODEL_ID, { cache_dir: modelCacheDir }) as unknown as { (image: unknown): Promise<{ pixel_values: unknown }>; size: unknown };
  processor.size = { width: READINESS_INPUT_SIZE, height: READINESS_INPUT_SIZE };
  return {
    reconstruct: async image => (await estimate(new RawImage(image.data, image.width, image.height, 3)) as unknown as { depth: Awaited<ReturnType<DepthEstimator>> }).depth,
    readiness: async image => {
      const { predicted_depth } = await estimate.model(await processor(new RawImage(image.data, image.width, image.height, 3))) as { predicted_depth: { data: Float32Array; dims: number[] } };
      const [height, width] = predicted_depth.dims.slice(-2);
      return { data: Float32Array.from(predicted_depth.data), width, height };
    },
  };
}

/** Same preparation as server/reconstruction.ts (1600px texture, 518px model input) and the readiness scorer (252px). */
async function prepare(bytes: Buffer) {
  const texture = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate().flatten({ background: '#101722' }).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  const model = await sharp(texture).resize({ width: 518, height: 518, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ready = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().flatten({ background: '#000000' }).resize(READINESS_INPUT_SIZE, READINESS_INPUT_SIZE, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { model: { data: model.data, width: model.info.width, height: model.info.height }, ready: { data: ready.data, width: ready.info.width, height: ready.info.height } };
}

const files = await photoFiles(input);
if (!files.length) throw new Error('No supported photos found.');
await mkdir(output, { recursive: true });
const prepared = await Promise.all(files.map(async file => { const bytes = await readFile(file); return { file, bytes, ...(await prepare(bytes)) }; }));

const loadStarted = performance.now();
const { reconstruct, readiness } = production
  ? { reconstruct: sharedDepthEstimator(modelCacheDir), readiness: sharedRawDepthEstimator(modelCacheDir, READINESS_INPUT_SIZE) }
  : await probeEstimators();
// Model load (plus the first, shape-dependent call) is reported separately and never counted as inference.
await reconstruct(prepared[0].model); await readiness(prepared[0].ready);
const modelLoadMs = Math.round(performance.now() - loadStarted);
const deviceNow = () => (production ? depthStatus(modelCacheDir).device ?? device : device);
const usedDevice = deviceNow();

const time = async <T>(task: () => Promise<T>) => { const started = performance.now(); const result = await task(); return { result, ms: performance.now() - started }; };
const photos: DumpPhoto[] = [];
for (const photo of prepared) {
  const id = path.parse(photo.file).name;
  const inferenceMs: number[] = []; const readinessMs: number[] = [];
  let depth: Awaited<ReturnType<DepthEstimator>> | undefined; let raw: Awaited<ReturnType<RawDepthEstimator>> | undefined;
  for (let run = 0; run <= repeats; run++) {
    const recon = await time(() => reconstruct(photo.model)); inferenceMs.push(recon.ms); depth = recon.result;
    const ready = await time(() => readiness(photo.ready)); readinessMs.push(ready.ms); raw = ready.result;
  }
  if (depth!.channels !== 1) throw new Error(`Expected single-channel depth, got ${depth!.channels} channels.`);
  await writeFloat32(path.join(output, `${id}.depth.f32`), depth!.data);
  await writeFloat32(path.join(output, `${id}.ready.f32`), raw!.data);
  photos.push({ id, input: photo.file, sha256: sha256(photo.bytes), depthFile: `${id}.depth.f32`, width: depth!.width, height: depth!.height, kind: 'inverse', readinessFile: `${id}.ready.f32`, readinessWidth: raw!.width, readinessHeight: raw!.height, inferenceMs: inferenceMs.map(Math.round), readinessMs: readinessMs.map(Math.round), device: deviceNow() });
  console.log(`${id} ${Math.round(Math.min(...inferenceMs.slice(1)))}ms reconstruction, ${Math.round(Math.min(...readinessMs.slice(1)))}ms readiness`);
}

// A production fallback during the timed loop would mix devices in one report: flag it instead of mislabelling it.
// The warm-up device counts too: a fallback during the first photo's timed calls must not look like a clean run.
const devicesUsed = [...new Set([usedDevice, ...photos.map(photo => photo.device)])];
const mixed = devicesUsed.length > 1;
if (mixed) console.warn(`Depth device changed during the run (${devicesUsed.join(' -> ')}); this report is flagged and not used for hardware comparisons.`);
const run: DumpRun = {
  version: 1, backend: 'depth-anything-v2', label: production ? `depth-anything-v2 (production ${device}: ${mixed ? devicesUsed.join(' -> ') : usedDevice})` : `depth-anything-v2 (probe ${device}${device === 'cpu' ? `, ${threads} threads` : ''})`,
  model: DEPTH_MODEL_ID, checkpoint: 'onnx/model.onnx fp32',
  checkpointSha256: sha256(await readFile(path.join(modelCacheDir, DEPTH_MODEL_ID, 'onnx/model.onnx')).catch(() => Buffer.alloc(0))),
  device: mixed ? 'mixed' : usedDevice, settings: { production, requestedDevice: device, fallback: depthStatus(modelCacheDir).fallback, devicesUsed, threads: devicesUsed.includes('cpu') ? threads : undefined, repeats, modelInput: '518 inside (1600px JPEG texture)', readinessInput: READINESS_INPUT_SIZE },
  machine: machineInfo(), commit: gitCommit(), createdAt: new Date().toISOString(), modelLoadMs,
  peakRssBytes: process.resourceUsage().maxRSS * 1024, peakFootprintBytes: peakFootprintBytes(), photos,
};
await writeFile(path.join(output, 'run.json'), JSON.stringify(run, null, 2) + '\n');
console.log(`Wrote ${photos.length} depth dumps to ${output} (model load ${modelLoadMs}ms).`);
