import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GEOMETRY_BACKENDS, type GeometryBackendName, type GeometryBenchmarkResult } from '../../server/geometry-contract.js';

type Result = GeometryBenchmarkResult & {
  id?: string; category?: string; sha256?: string; firstCallMs?: number;
  mesh?: { stretchedTriangles: number; cutRatio: number; stretchedRatio: number };
  readiness?: { score: number; ready: boolean; reasons: string[] };
};
type Report = {
  version: number; tool?: string; backend: GeometryBackendName; label?: string; model?: string; checkpointSha256?: string; device?: string;
  depthFallback?: string; settings?: { production?: boolean; fallback?: string }; machine?: { chip?: string }; modelLoadMs?: number; peakRssBytes?: number; peakFootprintBytes?: number; results: Result[];
};
type Gate = boolean | 'pending' | 'needs-judgment' | 'n/a';

const args = process.argv.slice(2);
const reports = args.flatMap((arg, index) => arg === '--report' && args[index + 1] ? [args[index + 1]] : []);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const output = value('--output');
const latencyBudgetMs = value('--latency-budget-ms') ? Number(value('--latency-budget-ms')) : undefined;
if (reports.length < 2) throw new Error('Usage: npx tsx scripts/m5/compare-models.ts --report baseline.json --report candidate.json [...] [--output comparison.json] [--latency-budget-ms 1500]\nThe first report is the baseline.');

const loaded = await Promise.all(reports.map(async file => JSON.parse(await readFile(file, 'utf8')) as Report));
for (const report of loaded) {
  if (report.version !== 1 || !GEOMETRY_BACKENDS.includes(report.backend) || !Array.isArray(report.results)) throw new Error(`Invalid benchmark report: ${report.backend || 'unknown'}`);
}
// Absolute paths differ between machines; the photo bytes do not.
const key = (result: Result) => result.sha256 || path.basename(result.input);
const keySets = loaded.map(report => new Set(report.results.map(key)));
const common = [...keySets[0]].filter(photo => keySets.every(set => set.has(photo)));
const allPhotos = new Set(keySets.flatMap(set => [...set]));
const name = (report: Report, index: number) => report.label || `${report.backend} #${index + 1}`;
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); const rank = p * (sorted.length - 1); const low = Math.floor(rank); return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low); };
const onCommon = (report: Report) => { const byKey = new Map(report.results.map(result => [key(result), result])); return common.map(photo => byKey.get(photo)!); };

const summaries = loaded.map((report, index) => {
  const results = onCommon(report); const valid = results.filter(result => result.valid);
  const times = results.map(result => result.elapsedMs);
  const flat = results.filter(result => result.category === 'flat-wall-or-screen' && result.readiness);
  const night = results.filter(result => result.category === 'night' && result.readiness);
  return {
    label: name(report, index), backend: report.backend, chip: report.machine?.chip, device: report.device,
    photoCount: results.length, validCount: valid.length, validityRate: valid.length / Math.max(results.length, 1),
    averageMs: times.reduce((sum, ms) => sum + ms, 0) / Math.max(times.length, 1), p95Ms: percentile(times, 0.95),
    firstCallAverageMs: results.every(result => result.firstCallMs !== undefined) ? results.reduce((sum, result) => sum + result.firstCallMs!, 0) / results.length : undefined,
    modelLoadMs: report.modelLoadMs, peakRssMb: report.peakRssBytes ? report.peakRssBytes / 2 ** 20 : undefined, peakFootprintMb: report.peakFootprintBytes ? report.peakFootprintBytes / 2 ** 20 : undefined,
    averageTriangles: valid.reduce((sum, result) => sum + (result.geometryTriangles || 0), 0) / Math.max(valid.length, 1),
    stretchedTriangles: results.every(result => result.mesh) ? results.reduce((sum, result) => sum + result.mesh!.stretchedTriangles, 0) : undefined,
    averageCutRatio: results.every(result => result.mesh) ? results.reduce((sum, result) => sum + result.mesh!.cutRatio, 0) / results.length : undefined,
    readyCount: results.every(result => result.readiness) ? results.filter(result => result.readiness!.ready).length : undefined,
    flatRejected: flat.length ? `${flat.filter(result => !result.readiness!.ready).length}/${flat.length}` : undefined,
    nightReady: night.length ? `${night.filter(result => result.readiness!.ready).length}/${night.length}` : undefined,
    allFinite: results.every(result => result.stats.finiteRatio >= 0.995 && Number.isFinite(result.stats.range)),
    pass: results.length === allPhotos.size && valid.length === results.length,
  };
});

// Same model, weights and device on different chips: the pure hardware change (M3 -> M5). Reports that do not
// name their device (older benchmark-3d runs) or changed device mid-run are never paired.
const hardware = loaded.flatMap((a, i) => loaded.slice(i + 1).flatMap((b, offset) => {
  const j = i + 1 + offset;
  // A runtime fallback (or a report from another tool, which times different work) is never a hardware comparison.
  const fellBack = (report: Report) => /-run-failed$/.test(report.settings?.fallback ?? report.depthFallback ?? '');
  if (!common.length || !a.device || !b.device || a.device === 'mixed' || b.device === 'mixed' || fellBack(a) || fellBack(b)) return [];
  if ((a.tool ?? 'm5-suite') !== (b.tool ?? 'm5-suite')) return [];
  if (a.backend !== b.backend || a.model !== b.model || a.device !== b.device || a.machine?.chip === b.machine?.chip) return [];
  if (a.checkpointSha256 && b.checkpointSha256 && a.checkpointSha256 !== b.checkpointSha256) return [];
  const [slow, fast] = summaries[i].averageMs >= summaries[j].averageMs ? [i, j] : [j, i];
  return [{ slower: summaries[slow].label, slowerChip: summaries[slow].chip, faster: summaries[fast].label, fasterChip: summaries[fast].chip, averageSpeedup: summaries[slow].averageMs / summaries[fast].averageMs, p95Speedup: summaries[slow].p95Ms / summaries[fast].p95Ms, modelLoadSpeedup: (summaries[slow].modelLoadMs ?? NaN) / (summaries[fast].modelLoadMs ?? NaN) }];
}));

// Acceptance gates from scripts/m5/runner-format.md, each candidate against the first (baseline) report.
const baseline = onCommon(loaded[0]);
const gates = loaded.slice(1).map((report, offset) => {
  const index = offset + 1; const results = onCommon(report); const summary = summaries[index];
  const scored = results.every(result => result.readiness) && baseline.every(result => result.readiness);
  const finiteDepth: Gate = summary.allFinite && results.every(result => result.stats.range > 0);
  const validMeshForReady: Gate = scored ? results.every((result, i) => !(result.readiness!.ready || baseline[i].readiness!.ready) || result.valid) : 'n/a';
  const noMoreStretched: Gate = summary.stretchedTriangles !== undefined && summaries[0].stretchedTriangles !== undefined ? summary.stretchedTriangles <= summaries[0].stretchedTriangles : 'n/a';
  const flatRejection: Gate = scored ? results.every((result, i) => result.category !== 'flat-wall-or-screen' || baseline[i].readiness!.ready || !result.readiness!.ready) : 'n/a';
  const latency: Gate = latencyBudgetMs === undefined ? 'needs-judgment' : summary.p95Ms <= latencyBudgetMs;
  const automated = [finiteDepth, validMeshForReady, noMoreStretched, flatRejection].every(gate => gate === true) && latency !== false;
  return { candidate: summary.label, finiteDepth, validMeshForReady, noMoreStretched, flatRejection, blindQuest: 'pending' as Gate, latency, passesAutomatedGates: automated };
});

const fastest = [...summaries].sort((a, b) => a.averageMs - b.averageMs)[0];
const bestValid = [...summaries].sort((a, b) => b.validityRate - a.validityRate || a.averageMs - b.averageMs)[0];
const awaitingQuest = gates.filter(gate => gate.passesAutomatedGates).map(gate => gate.candidate);
const result = {
  version: 1, comparedAt: new Date().toISOString(), reports: reports.map(file => path.resolve(file)),
  commonPhotoCount: common.length, missingFromSome: allPhotos.size - common.length, summaries, hardware, gates,
  fastest: fastest.label, bestValid: bestValid.label,
  // A blind Quest review is required before any replacement, so the production default never changes automatically.
  recommendation: loaded[0].backend,
  awaitingBlindQuestReview: awaitingQuest,
};
if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
const ms = (value?: number) => (value === undefined ? '-' : Math.round(value));
console.table(summaries.map(summary => ({ model: summary.label, chip: summary.chip, valid: `${summary.validCount}/${summary.photoCount}`, avgMs: ms(summary.averageMs), p95Ms: ms(summary.p95Ms), loadMs: ms(summary.modelLoadMs), rssMb: ms(summary.peakRssMb), footprintMb: ms(summary.peakFootprintMb), stretched: summary.stretchedTriangles ?? '-', cutPct: summary.averageCutRatio === undefined ? '-' : (summary.averageCutRatio * 100).toFixed(1), ready: summary.readyCount ?? '-', flatRejected: summary.flatRejected ?? '-', nightReady: summary.nightReady ?? '-' })));
if (hardware.length) console.table(hardware.map(row => ({ slower: row.slowerChip, faster: row.fasterChip, avgSpeedup: row.averageSpeedup.toFixed(2) + 'x', p95Speedup: row.p95Speedup.toFixed(2) + 'x', loadSpeedup: Number.isFinite(row.modelLoadSpeedup) ? row.modelLoadSpeedup.toFixed(2) + 'x' : '-' })));
if (gates.length) console.table(gates.map(({ candidate, finiteDepth, validMeshForReady, noMoreStretched, flatRejection, blindQuest, latency }) => ({ candidate, finiteDepth, validMeshForReady, noMoreStretched, flatRejection, blindQuest, latency })));
console.log(JSON.stringify({ commonPhotoCount: result.commonPhotoCount, missingFromSome: result.missingFromSome, fastest: result.fastest, recommendation: result.recommendation, awaitingBlindQuestReview: awaitingQuest, output: output || null }, null, 2));
