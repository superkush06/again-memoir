import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createDepthGeometry } from '../src/scene/reconstruction.js';
import { inspectRawDepth, validateGeometryStats, type GeometryBenchmarkResult } from '../server/geometry-contract.js';
import { DEPTH_MODEL_ID, depthStatus, sharedRawDepthEstimator } from '../server/depth-model.js';
import { machineInfo, percentile } from './m5/dump-format.js';

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const input = value('--input');
if (!input) throw new Error('Usage: npm run benchmark:3d -- --input <photo-or-folder> [--output report.json]');
const output = value('--output');
const modelCacheDir = process.env.MODEL_CACHE_DIR || path.resolve('data/models');
const estimator = sharedRawDepthEstimator(modelCacheDir, 252);
const stat = await import('node:fs/promises');
const info = await stat.stat(input);
const files = info.isDirectory()
  ? (await readdir(input)).filter(file => /\.(jpe?g|png|webp|gif)$/i.test(file)).sort().map(file => path.join(input, file))
  : [input];
if (!files.length) throw new Error('No supported photos found.');
const prepare = async (file: string) => sharp(await readFile(file), { limitInputPixels: 40_000_000, animated: false }).rotate().resize({ width: 518, height: 518, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

// Load the model before timing, so the first photo is not charged for it.
const loadStarted = performance.now();
const warm = await prepare(files[0]);
await estimator({ data: warm.data, width: warm.info.width, height: warm.info.height });
const modelLoadMs = Math.round(performance.now() - loadStarted);
const warmDevice = depthStatus(modelCacheDir).device;
const devicesSeen = new Set([warmDevice]);

const results: GeometryBenchmarkResult[] = [];
for (const file of files) {
  const started = performance.now();
  try {
    const prepared = await prepare(file);
    const depth = await estimator({ data: prepared.data, width: prepared.info.width, height: prepared.info.height });
    const stats = inspectRawDepth(depth);
    const error = validateGeometryStats(stats);
    const range = Math.max(stats.range, Number.EPSILON);
    const rgba = new Uint8Array(depth.width * depth.height * 4);
    for (let i = 0; i < depth.width * depth.height; i++) {
      const normalized = Math.round(((depth.data[i] - stats.min) / range) * 255);
      rgba[i * 4] = Number.isFinite(normalized) ? Math.max(0, Math.min(255, normalized)) : 0;
      rgba[i * 4 + 3] = 255;
    }
    const mesh = error ? undefined : createDepthGeometry({ width: depth.width, height: depth.height, data: rgba });
    results.push({ backend: 'depth-anything-v2', input: file, elapsedMs: Math.round(performance.now() - started), stats, valid: !error && !!mesh, geometryVertices: mesh ? mesh.positions.length / 3 : undefined, geometryTriangles: mesh ? mesh.indices.length / 3 : undefined, error });
  } catch (error) {
    results.push({ backend: 'depth-anything-v2', input: file, elapsedMs: Math.round(performance.now() - started), stats: { width: 0, height: 0, min: 0, max: 0, range: 0, mean: 0, finiteRatio: 0, variance: 0 }, valid: false, error: error instanceof Error ? error.message : 'unknown error' });
  }
  devicesSeen.add(depthStatus(modelCacheDir).device);
  const latest = results.at(-1)!;
  console.log(`${latest.valid ? 'PASS' : 'FAIL'} ${path.basename(file)} ${latest.elapsedMs}ms${latest.error ? ` — ${latest.error}` : ''}`);
}
const times = results.map(result => result.elapsedMs);
// The device is part of the result: compare-models only pairs reports from the same tool that ran on one device throughout.
const { fallback } = depthStatus(modelCacheDir);
const device = devicesSeen.size > 1 ? 'mixed' : warmDevice;
const report = { version: 1, tool: 'benchmark-3d', createdAt: new Date().toISOString(), machine: machineInfo(), backend: 'depth-anything-v2', model: DEPTH_MODEL_ID, device, depthFallback: fallback, modelCacheDir, modelLoadMs, count: results.length, validCount: results.filter(result => result.valid).length, averageMs: times.reduce((sum, ms) => sum + ms, 0) / results.length, p95Ms: percentile(times, 0.95), results };
if (output) await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ chip: report.machine.chip, device, count: report.count, validCount: report.validCount, modelLoadMs, averageMs: Math.round(report.averageMs), p95Ms: Math.round(report.p95Ms), output: output || null }, null, 2));

