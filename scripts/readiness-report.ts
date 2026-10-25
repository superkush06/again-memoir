/**
 * Read-only 3D-readiness report for the archived library: scores every local
 * photo/video with the production scorer and prints timing and pass/fail, without
 * writing anything. Use it to sanity-check READY_3D_THRESHOLD.
 *
 *   npm run readiness:report [-- data-dir]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Memory } from '../src/types.js';
import { sharedRawDepthEstimator } from '../server/depth-model.js';
import { DepthReadinessScorer, READY_3D_THRESHOLD } from '../server/depth-readiness.js';
import { imageFeatures } from '../server/image-quality.js';
import { ffmpegVideoSampler } from '../server/video-reconstruction.js';

const dataDir = path.resolve(process.argv[2] || process.env.DATA_DIR || 'data');
const uploads = path.join(dataDir, 'uploads');
const memories = (JSON.parse(await readFile(path.join(dataDir, 'memories.json'), 'utf8')) as Memory[])
  .filter(memory => memory.source !== 'demo' && memory.url.startsWith('/uploads/'));
const estimator = sharedRawDepthEstimator(path.join(dataDir, 'models'));
const scorer = new DepthReadinessScorer({ estimator, videoSampler: ffmpegVideoSampler });

const loadStarted = performance.now();
// Warm the shared model once so per-photo timings reflect inference, not loading.
await estimator({ data: Buffer.alloc(14 * 14 * 3, 128), width: 14, height: 14 }).catch(error => {
  console.warn(`Depth model unavailable (${(error as Error).message}); scores below use the heuristic fallback.`);
});
const loadMs = performance.now() - loadStarted;

const rows: { file: string; score: number; ready: boolean; source: string; ms: number; reasons: string[]; metrics?: Record<string, number> }[] = [];
const started = performance.now();
for (const memory of memories) {
  const file = path.join(uploads, path.basename(memory.url));
  const result = memory.mediaType === 'video'
    ? await scorer.score({ kind: 'video', file })
    : await readFile(file).then(async bytes => scorer.score({ kind: 'image', bytes }, (await imageFeatures(bytes)).quality));
  rows.push({ file: path.basename(file), score: result.score, ready: result.ready, source: result.source, ms: result.durationMs, reasons: result.reasons, metrics: result.metrics });
}
const totalMs = performance.now() - started;

rows.sort((a, b) => b.score - a.score);
console.log(`\n3D readiness: threshold ${READY_3D_THRESHOLD} · ${rows.filter(row => row.ready).length}/${rows.length} ready\n`);
for (const row of rows) {
  const m = row.metrics;
  const metrics = m ? `range ${m.depthRange.toFixed(2)} layers ${m.depthLayers} cover ${m.depthCoverage.toFixed(1)} ground ${m.groundPlane.toFixed(2)} occl ${m.closeOccluder.toFixed(2)} flat ${m.flatness.toFixed(2)}` : '(heuristic)';
  console.log(`${row.ready ? 'PASS' : 'fail'}  ${row.score.toFixed(3)}  ${String(row.ms).padStart(4)}ms  ${row.file.slice(-24)}  ${metrics}\n      ${row.reasons.join('; ')}`);
}
const times = rows.map(row => row.ms).sort((a, b) => a - b);
console.log(`\nModel load/warm-up: ${Math.round(loadMs)}ms`);
console.log(`Scoring: ${rows.length} items in ${Math.round(totalMs)}ms total · per item median ${times[Math.floor(times.length / 2)] ?? 0}ms, max ${times.at(-1) ?? 0}ms (includes decode + resize + depth + analysis)`);
