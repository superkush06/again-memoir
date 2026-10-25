import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectRawDepth, normalizeBackend, validateGeometryStats } from '../../server/geometry-contract.js';
import { DepthReadinessScorer, READINESS_INPUT_SIZE } from '../../server/depth-readiness.js';
import type { RawDepthMap } from '../../server/depth-model.js';
import photoSet from './photo-set.json' with { type: 'json' };
import { buildMesh, MESH_LONG_EDGE, resample, toInverse } from './depth-mesh.js';
import { median, percentile, readFloat32, sha256, steadyMs, type DumpRun } from './dump-format.js';

/**
 * Scores any backend's dump with the production mesh builder and readiness gate,
 * on one shared grid, and writes a runner-format report (version 1) with extras.
 */
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dumpDir = value('--dump'); const output = value('--output'); const photosDir = value('--photos');
if (!dumpDir || !output) throw new Error('Usage: npx tsx scripts/m5/score-depth.ts --dump <dump-dir> --output <report.json> [--photos <photo-dir>]');
const categories = new Map(photoSet.photos.map(photo => [photo.sha256, photo.category]));
// Dump entries are plain file names inside the dump directory.
const inDump = (file: string) => path.join(dumpDir, path.basename(file));
const dimension = (value: unknown, label: string) => { if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 16384) throw new Error(`Invalid ${label}: ${value}`); return value as number; };

function meshStats(map: RawDepthMap) {
  const { grid, mesh } = buildMesh(map);
  const possible = Math.max(1, 2 * (grid.width - 1) * (grid.height - 1)); const kept = mesh.indices.length / 3;
  // Kept triangles past half the renderer's own cut threshold: the rubber-sheet silhouettes seen in VR.
  // A blurry model can split one sheet into many small steps, so grazing triangles (surface within
  // 10° of the view ray from the eye at y=1.6) are counted too, as an independent check.
  let stretched = 0; let grazing = 0; const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
    const d = [mesh.distances[a / 3], mesh.distances[b / 3], mesh.distances[c / 3]];
    const closest = Math.min(...d);
    if (Math.max(...d) - closest > 0.5 * Math.max(0.24, closest * 0.12)) stretched++;
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]; const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const ray = [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - 1.6, (p[a + 2] + p[b + 2] + p[c + 2]) / 3];
    const cosine = Math.abs(n[0] * ray[0] + n[1] * ray[1] + n[2] * ray[2]) / (Math.hypot(...n) * Math.hypot(...ray) || 1);
    if (cosine < Math.cos((80 * Math.PI) / 180)) grazing++;
  }
  return { gridWidth: grid.width, gridHeight: grid.height, vertices: mesh.positions.length / 3, triangles: kept, cutTriangles: possible - kept, cutRatio: 1 - kept / possible, stretchedTriangles: stretched, stretchedRatio: kept ? stretched / kept : 0, grazingTriangles: grazing, grazingRatio: kept ? grazing / kept : 0 };
}

const run = JSON.parse(await readFile(path.join(dumpDir, 'run.json'), 'utf8')) as DumpRun;
const results = [];
for (const photo of run.photos) {
  const source = photosDir ? path.join(photosDir, path.basename(photo.input)) : photo.input;
  const bytes = await readFile(source);
  if (sha256(bytes) !== photo.sha256) throw new Error(`${photo.id}: ${source} is not the photo this dump was made from.`);
  if (photo.kind !== 'inverse' && photo.kind !== 'metric') throw new Error(`${photo.id}: unknown depth kind ${photo.kind}`);
  const width = dimension(photo.width, `${photo.id} width`); const height = dimension(photo.height, `${photo.id} height`);
  const depth: RawDepthMap = { data: toInverse(await readFloat32(inDump(photo.depthFile), width * height), photo.kind), width, height };
  const stats = inspectRawDepth(depth);
  const error = validateGeometryStats(stats);
  const mesh = error ? undefined : meshStats(depth);
  // Readiness runs the production scorer; only the depth source is swapped. DA2 supplies its own 252px raw map.
  const readinessMap: RawDepthMap = photo.readinessFile
    ? { data: await readFloat32(inDump(photo.readinessFile), dimension(photo.readinessWidth, 'readinessWidth') * dimension(photo.readinessHeight, 'readinessHeight')), width: photo.readinessWidth!, height: photo.readinessHeight! }
    : resample({ ...depth, data: depth.data.map(v => (Number.isFinite(v) ? v : 0)) }, READINESS_INPUT_SIZE, READINESS_INPUT_SIZE, 'bilinear');
  const readiness = await new DepthReadinessScorer({ estimator: async () => readinessMap }).score({ kind: 'image', bytes });
  // The scorer never throws: it falls back to image heuristics. A heuristic score must not pass as this model's.
  if (readiness.source !== 'depth-anything-v2') throw new Error(`${photo.id}: readiness fell back to ${readiness.source} (${readiness.reasons[0]}); the depth map was not scored.`);
  results.push({
    backend: normalizeBackend(run.backend), id: photo.id, category: categories.get(photo.sha256) || 'uncategorized', input: path.resolve(source), sha256: photo.sha256,
    elapsedMs: Math.round(steadyMs(photo.inferenceMs)), firstCallMs: photo.inferenceMs[0], readinessMs: photo.readinessMs ? Math.round(steadyMs(photo.readinessMs)) : undefined,
    stats, valid: !error && !!mesh, geometryVertices: mesh?.vertices, geometryTriangles: mesh?.triangles, mesh,
    readiness: { score: readiness.score, ready: readiness.ready, source: readiness.source, reasons: readiness.reasons }, error,
  });
  console.log(`${!error && mesh ? 'PASS' : 'FAIL'} ${photo.id} ${results.at(-1)!.elapsedMs}ms ready=${readiness.ready} (${readiness.score}) stretched=${mesh?.stretchedTriangles ?? '-'} cut=${mesh ? (mesh.cutRatio * 100).toFixed(1) + '%' : '-'}${error ? ` — ${error}` : ''}`);
}

const steady = results.map(result => result.elapsedMs);
const readinessTimes = results.flatMap(result => (result.readinessMs === undefined ? [] : [result.readinessMs]));
const report = {
  version: 1, backend: normalizeBackend(run.backend), label: run.label, dump: path.resolve(dumpDir), model: run.model, checkpoint: run.checkpoint, checkpointSha256: run.checkpointSha256, license: run.license,
  device: run.device, settings: run.settings, machine: run.machine, commit: run.commit, createdAt: run.createdAt, scoredAt: new Date().toISOString(),
  meshLongEdge: MESH_LONG_EDGE, modelLoadMs: run.modelLoadMs, peakRssBytes: run.peakRssBytes, peakDeviceBytes: run.peakDeviceBytes, peakFootprintBytes: run.peakFootprintBytes,
  count: results.length, validCount: results.filter(result => result.valid).length,
  averageMs: steady.reduce((sum, ms) => sum + ms, 0) / steady.length, p50Ms: median(steady), p95Ms: percentile(steady, 0.95),
  firstCallAverageMs: results.reduce((sum, result) => sum + result.firstCallMs, 0) / results.length,
  readinessAverageMs: readinessTimes.length ? readinessTimes.reduce((sum, ms) => sum + ms, 0) / readinessTimes.length : undefined,
  readinessP95Ms: readinessTimes.length ? percentile(readinessTimes, 0.95) : undefined,
  results,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ label: report.label, count: report.count, validCount: report.validCount, averageMs: Math.round(report.averageMs), p95Ms: Math.round(report.p95Ms), modelLoadMs: report.modelLoadMs, output }, null, 2));
