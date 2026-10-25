import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Memory, Readiness3D } from '../src/types.js';
import type { RawDepthEstimator, RawDepthMap } from './depth-model.js';
import { analyzeDepth, DepthReadinessScorer, HEURISTIC_READY_THRESHOLD, measureSharpness, READINESS_VERSION, READY_3D_THRESHOLD, scoreDepthReadiness, type Readiness3DScorer } from './depth-readiness.js';
import type { ImageQuality } from './image-quality.js';
import { archivePlannedBatch, type ImportCandidate, type PlannedImport } from './import-pipeline.js';
import { LibraryService } from './library.js';
import { MemoryStore } from './store.js';

const W = 84; const H = 112;
const map = (fn: (x: number, y: number) => number): RawDepthMap => {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = fn(x, y);
  return { data, width: W, height: H };
};
// Raw inverse depth: larger is nearer. Deterministic ripple instead of random noise.
const ripple = (x: number, y: number) => 0.01 * Math.sin(x * 1.7 + y * 0.9);
/** Sky, two receding buildings, and a ground plane rising smoothly to the camera. */
const layeredScene = map((x, y) => {
  const horizon = H * 0.35;
  if (y >= horizon) return 0.4 + 3.6 * ((y - horizon) / (H - horizon)) ** 1.5 + ripple(x, y);
  if (x < W * 0.35 && y > H * 0.08) return 1.6 + ripple(x, y);
  if (x > W * 0.65 && y > H * 0.15) return 0.9 + ripple(x, y);
  return 0.05 + ripple(x, y) * 0.1;
});
const flatWall = map((x, y) => 2 + ripple(x, y));
/** A face or plate filling the middle of the frame in front of a distant background. */
const closeUpBlob = map((x, y) => (((x - W / 2) / (W * 0.42)) ** 2 + ((y - H * 0.45) / (H * 0.4)) ** 2 <= 1 ? 4 + ripple(x, y) : 0.3 + 0.2 * (y / H) + ripple(x, y)));

const goodQuality: ImageQuality = {
  sharpness: 0.5, exposure: 0.8, composition: 0.6, subjectQuality: 0.6, visualAppeal: 0.5, wideScene: 0.5, depthVariation: 0.5,
  visibleGround: 0.5, openSpace: 0.5, stableGeometry: 0.5, screenshotLikelihood: 0, obstruction: 0.2,
};

test('a deep layered scene passes with readable reasons', () => {
  const metrics = analyzeDepth(layeredScene);
  assert.ok(metrics.depthRange > 0.9, `range ${metrics.depthRange}`);
  assert.ok(metrics.groundPlane >= 0.75, `ground ${metrics.groundPlane}`);
  assert.ok(metrics.closeOccluder < 0.2, `occluder ${metrics.closeOccluder}`);
  assert.ok(metrics.depthLayers >= 2, `layers ${metrics.depthLayers}`);
  const result = scoreDepthReadiness(metrics, goodQuality);
  assert.equal(result.ready, true, `score ${result.score}`);
  assert.ok(result.score >= READY_3D_THRESHOLD);
  assert.ok(result.reasons.includes('clear foreground-to-background depth'));
  assert.ok(result.reasons.includes('visible ground you could walk on'));
});

test('a flat wall fails as one flat surface', () => {
  const metrics = analyzeDepth(flatWall);
  assert.ok(metrics.flatness > 0.9, `flatness ${metrics.flatness}`);
  assert.ok(metrics.depthRange < 0.05);
  const result = scoreDepthReadiness(metrics, goodQuality);
  assert.equal(result.ready, false);
  assert.equal(result.reasons[0], 'shallow depth range');
  assert.ok(result.reasons.includes('mostly one flat surface (wall, document, or screen)'));
});

test('a close-up blob filling the frame fails', () => {
  const metrics = analyzeDepth(closeUpBlob);
  assert.ok(metrics.closeOccluder > 0.45, `occluder ${metrics.closeOccluder}`);
  const result = scoreDepthReadiness(metrics, goodQuality);
  assert.equal(result.ready, false, `score ${result.score}`);
  assert.ok(result.reasons.includes('close-up fills the frame'));
});

test('screenshots fail even when the depth model hallucinates a deep scene', () => {
  const screenshot = { ...goodQuality, screenshotLikelihood: 0.8, sharpness: 0.9 };
  const deep = scoreDepthReadiness(analyzeDepth(layeredScene), screenshot);
  assert.equal(deep.ready, false, `score ${deep.score}`);
  assert.ok(deep.reasons.includes('looks like a screenshot'));
  assert.equal(scoreDepthReadiness(analyzeDepth(flatWall), screenshot).ready, false);
});

test('darkness and blur pull an otherwise deep scene below the line', () => {
  assert.equal(scoreDepthReadiness(analyzeDepth(layeredScene), { ...goodQuality, exposure: 0.08, sharpness: 0.1 }).ready, false);
});

test('analysis is deterministic and size-independent in shape', () => {
  assert.deepEqual(analyzeDepth(layeredScene), analyzeDepth(layeredScene));
  assert.throws(() => analyzeDepth({ data: new Float32Array(3), width: 4, height: 4 }), /truncated/);
  // Non-finite model output is treated as background, never NaN scores.
  const broken = analyzeDepth(map(() => Number.NaN));
  assert.ok(Object.values(broken).every(Number.isFinite));
  assert.equal(scoreDepthReadiness(broken, goodQuality).ready, false);
});

/** Camera pointed down at a table or box: everything is near, the top barely farther than the bottom. */
const lookingDown = map((x, y) => 3 + 0.35 * (y / H) + 0.4 * Math.sin(x / 9) * Math.cos(y / 11) + ripple(x, y));
/** A far vista: sky and a distant horizon fill the eye line; only a thin strip of ground is near. */
const farVista = map((x, y) => (y < H * 0.86 ? 0.02 + 0.01 * (y / H) + ripple(x, y) * 0.05 : 0.2 + 3.8 * ((y - H * 0.86) / (H * 0.14)) ** 1.4 + ripple(x, y)));

test('an eye-level scene keeps its eye-level metrics; the layered scene sits at a walkable distance', () => {
  const metrics = analyzeDepth(layeredScene);
  assert.ok((metrics.eyeLevelContent ?? 0) > 0.2, `eye ${metrics.eyeLevelContent}`);
  assert.ok((metrics.verticalRise ?? 0) > 0.4, `rise ${metrics.verticalRise}`);
  assert.ok((metrics.farthestBand ?? 1) < 0.2, `farthest ${metrics.farthestBand}`);
});

test('the camera pointed down at a nearby surface fails', () => {
  const metrics = analyzeDepth(lookingDown);
  assert.ok((metrics.verticalRise ?? 1) < 0.15, `rise ${metrics.verticalRise}`);
  assert.ok((metrics.farthestBand ?? 0) > 0.3, `farthest ${metrics.farthestBand}`);
  const result = scoreDepthReadiness(metrics, goodQuality);
  assert.equal(result.ready, false, `score ${result.score}`);
  assert.ok(result.reasons.some(reason => reason.startsWith('a nearby surface blocks the view')));
});

test('a far-away vista with little at eye level fails', () => {
  const metrics = analyzeDepth(farVista);
  assert.ok((metrics.eyeLevelContent ?? 1) < 0.03, `eye ${metrics.eyeLevelContent}`);
  const result = scoreDepthReadiness(metrics, goodQuality);
  assert.equal(result.ready, false, `score ${result.score}`);
  assert.ok(result.reasons.includes('mostly a far-away view with little at eye level'));
});

test('blur gate: a deep, eye-level scene still fails when the photo is blurry', () => {
  const metrics = analyzeDepth(layeredScene);
  assert.equal(scoreDepthReadiness({ ...metrics, detail: 1.1, edgeEnergy: 900 }, goodQuality).ready, true);
  const blurry = scoreDepthReadiness({ ...metrics, detail: 0.2, edgeEnergy: 90 }, goodQuality);
  assert.equal(blurry.ready, false, `score ${blurry.score}`);
  assert.equal(blurry.reasons[0], 'too blurry for stable geometry');
  // Contrast-normalized detail catches motion blur even when raw edge energy looks fine.
  assert.equal(scoreDepthReadiness({ ...metrics, detail: 0.4, edgeEnergy: 900 }, goodQuality).ready, false);
});

/** Banded test texture: sharp and well exposed for the image-quality signals. Tint picks the stub depth map. */
async function scenePng(tint: 'red' | 'blue' | 'green', w = 96, h = 128) {
  const color = { red: [230, 60, 40], blue: [40, 60, 230], green: [40, 220, 60] }[tint];
  // Fine 12px texture at every size, like real photo detail (big flat blocks read as low-detail).
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const base = 70 + (Math.floor(y / 16) % 2) * 60 + ((Math.floor(x / 12) + Math.floor(y / 12)) % 2) * 40;
    for (let c = 0; c < 3; c++) data[(y * w + x) * 3 + c] = Math.min(255, base * 0.6 + color[c] * 0.4);
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
/** Red images look like walkable scenes, blue ones like close-ups, green ones like walls. */
const tintEstimator = (calls: { width: number; height: number }[] = []): RawDepthEstimator => async image => {
  calls.push({ width: image.width, height: image.height });
  let red = 0; let green = 0; let blue = 0;
  for (let index = 0; index < image.data.length; index += 3) { red += image.data[index]; green += image.data[index + 1]; blue += image.data[index + 2]; }
  return red > blue && red > green ? layeredScene : blue > green ? closeUpBlob : flatWall;
};
const fixedClock = { now: () => 0, clock: () => new Date('2026-10-24T12:00:00.000Z') };

test('the scorer downsizes to ~252px, uses the injected estimator, and is deterministic', async () => {
  const calls: { width: number; height: number }[] = [];
  const scorer = new DepthReadinessScorer({ estimator: tintEstimator(calls), ...fixedClock });
  // Drawn at full resolution: an upscaled small image is genuinely blurry and now fails the blur gate.
  const big = await scenePng('red', 1200, 1600);
  const first = await scorer.score({ kind: 'image', bytes: big });
  assert.deepEqual(calls[0], { width: 189, height: 252 });
  assert.equal(first.source, 'depth-anything-v2');
  assert.equal(first.ready, true);
  assert.equal(first.threshold, READY_3D_THRESHOLD);
  assert.deepEqual(await scorer.score({ kind: 'image', bytes: big }), first);
  assert.equal((await scorer.score({ kind: 'image', bytes: await scenePng('blue') })).ready, false);
});

test('when the depth model cannot load, the heuristic fallback is used conservatively and never throws', async () => {
  const scorer = new DepthReadinessScorer({ estimator: async () => { throw new Error('Cannot find module onnxruntime-node'); }, ...fixedClock });
  const result = await scorer.score({ kind: 'image', bytes: await scenePng('red') });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.threshold, HEURISTIC_READY_THRESHOLD);
  assert.equal(result.metrics, undefined);
  assert.match(result.reasons[0], /Depth model unavailable/);
  assert.equal(result.ready, false, 'a mediocre heuristic score never passes');
  const strong = await scorer.score({ kind: 'image', bytes: await scenePng('red') }, { ...goodQuality, wideScene: 1, depthVariation: 1, visibleGround: 1, openSpace: 1, stableGeometry: 1, sharpness: 1, obstruction: 0 });
  assert.equal(strong.ready, true, 'only clearly strong anchors pass the fallback');
  const garbage = await new DepthReadinessScorer({ estimator: tintEstimator() }).score({ kind: 'image', bytes: Buffer.from('not an image') });
  assert.equal(garbage.source, 'heuristic');
  assert.equal(garbage.ready, false);
});

test('videos are scored on one sampled middle frame, falling back to the poster', async () => {
  const frame = await scenePng('red'); const times: number[] = [];
  const sampler = { duration: async () => 10, frame: async (_file: string, time: number) => { times.push(time); return frame; } };
  const scored = await new DepthReadinessScorer({ estimator: tintEstimator(), videoSampler: sampler }).score({ kind: 'video', file: '/tmp/clip.mp4' });
  assert.equal(times.length, 1, 'one frame only');
  assert.ok(Math.abs(scored.sampledAt! - times[0]) < 0.001);
  assert.ok(times[0] > 2 && times[0] < 8, 'a frame from the middle of the clip');
  assert.equal(scored.ready, true);
  const noFfmpeg = { duration: async () => { throw new Error('ffprobe missing'); }, frame: async () => frame };
  const poster = await new DepthReadinessScorer({ estimator: tintEstimator(), videoSampler: noFfmpeg }).score({ kind: 'video', file: '/tmp/clip.mp4', poster: await scenePng('blue') });
  assert.equal(poster.source, 'depth-anything-v2'); assert.equal(poster.ready, false); assert.equal(poster.sampledAt, undefined);
  const nothing = await new DepthReadinessScorer({ estimator: tintEstimator(), videoSampler: noFfmpeg }).score({ kind: 'video', file: '/tmp/clip.mp4' });
  assert.equal(nothing.source, 'heuristic'); assert.equal(nothing.ready, false);
  assert.match(nothing.reasons[0], /No video frame could be sampled/);
});

const memory = (id: string, changes: Partial<Memory> = {}): Memory => ({
  id, title: 'Sunset hike', description: '', date: '2025-06-01', location: '', tags: [], source: 'upload', mediaType: 'image', url: '', thumbnailUrl: '', ...changes,
});
async function fixture(readiness: Readiness3DScorer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-readiness-'));
  const store = new MemoryStore(directory, []); await store.initialize();
  const library = new LibraryService(store, { readiness }); await library.initialize();
  return { directory, store, library, close: () => rm(directory, { recursive: true, force: true }) };
}
const candidate = (id: string, bytes: Buffer): ImportCandidate => ({ sourceId: `src-${id}`, memory: memory(id), fetch: async () => ({ bytes, mimeType: 'image/png' }) });
async function importBatch(library: LibraryService, candidates: ImportCandidate[]) {
  const planned = candidates.map(item => item.memory);
  const job = await library.planImport('upload', planned, { mode: 'local', reason: 'not_configured', kept: 0, renamed: 0, rejected: 0 });
  return archivePlannedBatch(library, { job, candidates } satisfies PlannedImport);
}
const folderByKind = (library: LibraryService, kind: 'root' | 'all') => library.folders().find(folder => folder.kind === kind)!;
const outdoors = (library: LibraryService) => library.folders().find(folder => folder.name === 'Outdoors')!;

test('Pictures and categories hold only 3D-ready items; All memories holds everything', async () => {
  const { store, library, close } = await fixture(new DepthReadinessScorer({ estimator: tintEstimator() }));
  try {
    const { job } = await importBatch(library, [candidate('scene', await scenePng('red')), candidate('selfie', await scenePng('blue')), candidate('wall', await scenePng('green'))]);
    assert.equal(job.status, 'ready'); assert.equal(job.processedItems, 3);
    assert.ok(job.items.every(item => item.stage === 'ready'));
    assert.equal(store.get('scene')!.readiness3d!.ready, true);
    assert.equal(store.get('selfie')!.readiness3d!.ready, false);
    assert.equal(store.get('wall')!.readiness3d!.ready, false);
    assert.deepEqual(folderByKind(library, 'root').memoryIds, ['scene']);
    assert.deepEqual(outdoors(library).memoryIds, ['scene']);
    assert.deepEqual([...folderByKind(library, 'all').memoryIds].sort(), ['scene', 'selfie', 'wall']);
    for (const folder of library.folders()) assert.equal(folder.pendingMemoryIds, undefined, 'nothing pending after the job');
    const contents = library.folderContents(outdoors(library).id)!;
    assert.deepEqual(contents.items.map(item => item.id), ['scene']);
  } finally { await close(); }
});

test('items being scored are pending in Pictures and categories but already listed in All memories', async () => {
  let release!: () => void; let scoringStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { scoringStarted = resolve; });
  const inner = new DepthReadinessScorer({ estimator: tintEstimator() });
  const slow: Readiness3DScorer = { score: async (input, quality) => { scoringStarted(); await gate; return inner.score(input, quality); } };
  const { store, library, close } = await fixture(slow);
  try {
    const running = importBatch(library, [candidate('scene', await scenePng('red'))]);
    await started;
    assert.ok(store.get('scene'), 'archived before the 3D check');
    assert.equal(store.get('scene')!.readiness3d, undefined);
    const root = folderByKind(library, 'root'); const all = folderByKind(library, 'all');
    assert.deepEqual(root.memoryIds, []); assert.deepEqual(root.pendingMemoryIds, ['scene']);
    assert.deepEqual(outdoors(library).memoryIds, []); assert.deepEqual(outdoors(library).pendingMemoryIds, ['scene']);
    assert.deepEqual(all.memoryIds, ['scene']); assert.equal(all.pendingMemoryIds, undefined);
    assert.equal(library.jobs()[0].items[0].status, 'processing');
    assert.equal(library.jobs()[0].currentStage, 'embedded', 'progress sits at the 3D check');
    release(); await running;
    assert.deepEqual(folderByKind(library, 'root').memoryIds, ['scene']);
    assert.equal(folderByKind(library, 'root').pendingMemoryIds, undefined);
  } finally { await close(); }
});

test('an estimator that throws during import falls back to the heuristic without failing the job', async () => {
  const { store, library, close } = await fixture(new DepthReadinessScorer({ estimator: async () => { throw new Error('onnxruntime missing'); } }));
  try {
    const { job } = await importBatch(library, [candidate('scene', await scenePng('red'))]);
    assert.equal(job.status, 'ready'); assert.equal(job.failedItems, 0);
    const readiness = store.get('scene')!.readiness3d!;
    assert.equal(readiness.source, 'heuristic'); assert.equal(readiness.ready, false);
    assert.deepEqual(folderByKind(library, 'all').memoryIds, ['scene'], 'nothing silently disappears');
    assert.deepEqual(folderByKind(library, 'root').memoryIds, []);
    // A scorer that rejects outright is caught too.
    const broken = await fixture({ score: async () => { throw new Error('boom'); } });
    try {
      const result = await importBatch(broken.library, [candidate('x', await scenePng('red'))]);
      assert.equal(result.job.status, 'ready');
      assert.equal(broken.store.get('x')!.readiness3d!.source, 'heuristic');
    } finally { await broken.close(); }
  } finally { await close(); }
});

test('dedup is unchanged: one archived file, one score, one folder reference', async () => {
  let scored = 0;
  const inner = new DepthReadinessScorer({ estimator: tintEstimator() });
  const { directory, store, library, close } = await fixture({ score: (input, quality) => { scored++; return inner.score(input, quality); } });
  try {
    const bytes = await scenePng('red');
    await importBatch(library, [candidate('first', bytes), { ...candidate('second', bytes), sourceId: 'src-second' }]);
    await importBatch(library, [{ ...candidate('third', bytes), sourceId: 'src-third' }]);
    assert.equal(store.list().length, 1); assert.equal(scored, 1);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 1);
    for (const folder of library.folders()) {
      assert.equal(new Set(folder.memoryIds).size, folder.memoryIds.length);
      if (folder.memoryIds.length) assert.deepEqual(folder.memoryIds, ['first']);
    }
    assert.equal(store.get('first')!.provenance!.length, 3);
  } finally { await close(); }
});

test('rescore checks existing memories in one background job with pending state', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let block = false;
  const inner = new DepthReadinessScorer({ estimator: tintEstimator() });
  const { store, library, close } = await fixture({ score: async (input, quality) => { calls++; if (block) await gate; return inner.score(input, quality); } });
  try {
    await importBatch(library, [candidate('scene', await scenePng('red')), candidate('selfie', await scenePng('blue'))]);
    // Simulate memories imported before the 3D check existed.
    await store.updateMany(['scene', 'selfie'].map(id => ({ id, changes: { readiness3d: undefined } })));
    assert.deepEqual(folderByKind(library, 'root').memoryIds, []);
    block = true; calls = 0;
    const { job, started } = await library.startRescore3d({ onlyMissing: true });
    assert.equal(started, true); assert.equal(job.kind, 'rescore-3d'); assert.equal(job.totalItems, 2);
    const again = await library.startRescore3d();
    assert.equal(again.started, false); assert.equal(again.job.id, job.id, 'one job at a time');
    assert.deepEqual([...folderByKind(library, 'root').pendingMemoryIds!].sort(), ['scene', 'selfie']);
    const running = library.runRescore3d(job.id);
    release(); const finished = await running;
    assert.equal(calls, 2);
    assert.equal(finished.status, 'ready'); assert.equal(finished.processedItems, 2);
    assert.deepEqual(folderByKind(library, 'root').memoryIds, ['scene']);
    assert.deepEqual([...folderByKind(library, 'all').memoryIds].sort(), ['scene', 'selfie']);
    assert.equal(folderByKind(library, 'root').pendingMemoryIds, undefined);
    const readiness: Readiness3D = store.get('selfie')!.readiness3d!;
    assert.ok(readiness.reasons.includes('close-up fills the frame'));
    const none = await library.startRescore3d({ onlyMissing: true });
    assert.equal(none.job.totalItems, 0);
    assert.equal((await library.runRescore3d(none.job.id)).status, 'ready');
  } finally { await close(); }
});

test('POST /api/library/rescore-3d starts one background job visible in import jobs', async () => {
  const { createBackend } = await import('./app.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-rescore-api-'));
  const backend = await createBackend({ dataDir: directory, env: {}, seed: [], readiness: new DepthReadinessScorer({ estimator: tintEstimator() }), reconstruction: { reconstruct: async () => { throw new Error('unused'); } } });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  try {
    const form = new FormData();
    form.append('files', new Blob([await scenePng('red')], { type: 'image/png' }), 'scene.png');
    const uploaded = await (await fetch(`${url}/api/upload`, { method: 'POST', body: form })).json();
    assert.equal(uploaded.memories[0].readiness3d.ready, true, 'uploads are 3D-checked in the import job');
    assert.ok(uploaded.job.items.every((item: { stage: string }) => item.stage === 'ready'));
    const response = await fetch(`${url}/api/library/rescore-3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    assert.equal(job.kind, 'rescore-3d'); assert.equal(job.totalItems, 1);
    let latest = job;
    for (let attempt = 0; attempt < 50 && latest.status !== 'ready'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      latest = ((await (await fetch(`${url}/api/import-jobs`)).json()).jobs as { id: string; status: string }[]).find(value => value.id === job.id);
    }
    assert.equal(latest.status, 'ready');
    assert.equal((await fetch(`${url}/api/library/rescore-3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"onlyMissing":"yes"}' })).status, 400);
  } finally {
    backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('measured sharpness drops when the same photo is blurred, and the scorer rejects the blurred copy', async () => {
  const sharpPhoto = await scenePng('red', 900, 1200);
  const blurred = await sharp(sharpPhoto).blur(8).png().toBuffer();
  const [a, b] = [await measureSharpness(sharpPhoto), await measureSharpness(blurred)];
  assert.ok(a.detail > b.detail * 3, `detail ${a.detail} vs ${b.detail}`);
  const scorer = new DepthReadinessScorer({ estimator: tintEstimator(), ...fixedClock });
  const crisp = await scorer.score({ kind: 'image', bytes: sharpPhoto });
  const soft = await scorer.score({ kind: 'image', bytes: blurred });
  assert.equal(crisp.ready, true, `crisp ${crisp.score}`);
  assert.equal(crisp.version, READINESS_VERSION);
  assert.equal(soft.ready, false, `soft ${soft.score}`);
  assert.ok(soft.reasons.includes('too blurry for stable geometry'));
});
