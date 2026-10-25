import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { WorldCompleter, polygonMask, fillOcclusions, depthSubjects, alignPolygonToBox, blendOccludedPixels, type CompletionProvider } from './world-completion.js';
import type { ReconstructionSpec } from '../src/types.js';
import { HUMAN_POSE_LANDMARK_NAMES, type HumanPose, type WorldCompletion } from '../src/types.js';
import { POSE_CACHE_VERSION } from './pose-estimation.js';

test('full-image polygon masks and occlusion filling retain source colors without copying occluded subjects', () => {
  const mask = polygonMask(5, 3, [[400, 0], [600, 0], [600, 1000], [400, 1000]]);
  assert.deepEqual([...mask], [0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0]);
  const rgb = Uint8Array.from(Array.from({ length: 15 }, (_, i) => i % 5 === 2 ? [250, 0, 0] : [20, 80, 170]).flat());
  const completed = fillOcclusions(rgb, mask, 5, 3);
  for (let i = 0; i < 15; i++) assert.deepEqual([...completed.slice(i * 3, i * 3 + 3)], [20, 80, 170]);
});

test('depth fallback separates disconnected foreground volumes without inventing semantic labels', () => {
  const depth = new Uint8Array(100);
  for (let y = 2; y < 8; y++) for (const x of [2, 3, 6, 7]) depth[y * 10 + x] = 230;
  const subjects = depthSubjects(depth, 10, 10);
  assert.equal(subjects.length, 2);
  assert.equal(subjects[0].subject.kind, 'object');
  assert.deepEqual(subjects.map(value => value.mask.filter(Boolean).length), [12, 12]);
});

test('semantic polygon axes are matched to independent bounding boxes before constructing people', () => {
  const correct = { label: 'person', kind: 'person' as const, box_2d: [400, 50, 1000, 350] as [number, number, number, number], polygon: [[50, 400], [350, 400], [350, 1000], [50, 1000]] as [number, number][] };
  assert.deepEqual(alignPolygonToBox(correct), correct);
  const transposed = { ...correct, polygon: correct.polygon.map(([x, y]) => [y, x] as [number, number]) };
  assert.deepEqual(alignPolygonToBox(transposed), correct);
  const mask = polygonMask(10, 10, alignPolygonToBox(transposed).polygon);
  assert.equal(mask[2 * 10 + 5], 0); assert.equal(mask[8 * 10 + 2], 255);
});

test('actual Sharp feathering changes only the foreground pixels and keeps one mask sample per RGB pixel', async () => {
  const width = 64, height = 48;
  const source = Uint8Array.from(Array.from({ length: width * height }, () => [220, 30, 20]).flat());
  const generated = Uint8Array.from(Array.from({ length: width * height }, () => [15, 80, 200]).flat());
  const mask = polygonMask(width, height, [[250, 200], [750, 200], [750, 800], [250, 800]]);
  const result = await blendOccludedPixels(source, generated, mask, width, height, width, height);
  assert.deepEqual([...result.subarray((24 * width + 32) * 3, (24 * width + 32) * 3 + 3)], [15, 80, 200]);
  assert.deepEqual([...result.subarray((2 * width + 2) * 3, (2 * width + 2) * 3 + 3)], [220, 30, 20]);
  assert.deepEqual([...result.subarray((44 * width + 60) * 3, (44 * width + 60) * 3 + 3)], [220, 30, 20]);
  assert.equal(result.length, width * height * 3);
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-world-'));
  const uploads = path.join(directory, 'uploads'), artifacts = path.join(uploads, 'reconstructions');
  await mkdir(artifacts, { recursive: true });
  const key = 'a'.repeat(32);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3060a0' } }).jpeg().toFile(path.join(artifacts, `${key}-source.jpg`));
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#555555' } }).grayscale().png().toFile(path.join(artifacts, `${key}-depth.png`));
  const reconstruction: ReconstructionSpec = { version: 1, kind: 'depth-mesh', sourceUrl: `/uploads/reconstructions/${key}-source.jpg`, depthUrl: `/uploads/reconstructions/${key}-depth.png`, width: 64, height: 48, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60 };
  return { directory, uploads, artifacts, key, reconstruction, cleanup: async () => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.match(path.basename(resolved), /^memoir-world-/); await rm(resolved, { recursive: true, force: true }); } };
}

test('semantic masks and generated color textures persist, concurrent requests charge image generation once, and cache reopens offline', async () => {
  const fixtureData = await fixture(); const { uploads, artifacts, key, reconstruction, cleanup } = fixtureData;
  let semanticCalls = 0, imageCalls = 0;
  const provider: CompletionProvider = {
    async segment() { semanticCalls++; return [{ label: 'Blue jacket', kind: 'person', box_2d: [100, 200, 900, 800], polygon: [[200, 100], [800, 100], [800, 900], [200, 900]] }]; },
    async textures() { imageCalls++; return sharp({ create: { width: 128, height: 48, channels: 3, background: '#4080c0' } }).png().toBuffer(); },
  };
  try {
    const completer = new WorldCompleter(uploads, { provider, localSegmenter: false, poseEstimator: false });
    const [first, duplicate] = await Promise.all([completer.complete(reconstruction), completer.complete(reconstruction)]);
    assert.deepEqual(first, duplicate); assert.equal(semanticCalls, 1); assert.equal(imageCalls, 1);
    const world = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(world.generatedBy, 'gemini'); assert.equal(world.textureSource, 'gemini'); assert.equal(world.subjects.length, 1);
    assert.match(world.rearAtlasUrl, /-rear\.jpg$/);
    const rear = await sharp(path.join(artifacts, `${key}-rear.jpg`)).metadata(); assert.equal(rear.width, 64); assert.equal(rear.height, 48);
    const offline = new WorldCompleter(uploads, { poseEstimator: false, provider: { segment: async () => { throw new Error('Must use cache'); }, textures: async () => { throw new Error('Must use cache'); } } });
    assert.deepEqual(await offline.complete(reconstruction), first);
  } finally { await cleanup(); }
});

test('provider outage remains color-preserving local completion and corrupt cache cannot repeat an image charge', async () => {
  const { uploads, artifacts, key, reconstruction, cleanup } = await fixture();
  let imageCalls = 0;
  const provider: CompletionProvider = { segment: async () => { throw new Error('unavailable'); }, textures: async () => { imageCalls++; throw new Error('unavailable secret token'); } };
  try {
    const completer = new WorldCompleter(uploads, { provider, localSegmenter: false, poseEstimator: false });
    await completer.complete(reconstruction);
    const world = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(world.generatedBy, 'depth-fallback'); assert.equal(world.textureSource, 'source-inpaint'); assert.equal(world.rearAtlasUrl, undefined);
    await writeFile(path.join(artifacts, `${key}-world.json`), JSON.stringify({ ...world, backgroundUrl: 'https://evil.test/photo.jpg' }));
    await completer.complete(reconstruction); assert.equal(imageCalls, 1);
    await assert.rejects(completer.complete({ ...reconstruction, sourceUrl: '/uploads/reconstructions/../../private.jpg' }), /validated local/);
  } finally { await cleanup(); }
});

test('local instance masks preserve separate people when cloud segmentation fails and reopen without model inference', async () => {
  const { uploads, artifacts, key, reconstruction, cleanup } = await fixture();
  let calls = 0;
  const localSegmenter = async (_image: Buffer, width: number, height: number) => {
    calls++;
    return [150, 450, 750].map(left => {
      const polygon = [[left, 100], [left + 170, 100], [left + 170, 900], [left, 900]];
      return { subject: { label: 'person', kind: 'person' as const, box_2d: [100, left, 900, left + 170] as [number, number, number, number], polygon: polygon as [number, number][] }, mask: polygonMask(width, height, polygon) };
    });
  };
  try {
    const completer = new WorldCompleter(uploads, { provider: { segment: async () => { throw new Error('Unavailable'); }, textures: async () => { throw new Error('Unavailable'); } }, localSegmenter, poseEstimator: false });
    const completed = await completer.complete(reconstruction);
    const world = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(world.generatedBy, 'local-segmentation'); assert.equal(world.subjects.length, 3);
    assert.ok(world.subjects.every((subject: { kind: string }) => subject.kind === 'person'));
    assert.deepEqual(await completer.complete(reconstruction), completed); assert.equal(calls, 1);
  } finally { await cleanup(); }
});

test('cached pose enrichment preserves reviewed assets, makes no cloud calls, and reuses the versioned result', async () => {
  const { uploads, artifacts, key, reconstruction, cleanup } = await fixture();
  const pose: HumanPose = { version: 1, source: 'mediapipe-pose', model: 'pose-landmarker-full', confidence: .9, observedFraction: 1,
    sourceBox: [.1, .2, .9, .8], landmarks: HUMAN_POSE_LANDMARK_NAMES.map(name => ({ name, image: [.5, .4, 0], world: [0, 0, 0], visibility: .9, presence: .9 })) };
  const maskUrl = `/uploads/reconstructions/${key}-mask-0.png`;
  const neuralAsset = { url: `/uploads/reconstructions/${key}-reviewed.glb`, model: 'makehuman' as const, upAxis: 'y' as const, frontYaw: 0, appearance: 'pbr' as const, inputKind: 'anatomical-template' as const, sourceFaceBox: [.1, .3, .3, .7] as [number, number, number, number] };
  const world: WorldCompletion = { version: 1, generatedBy: 'local-segmentation', textureSource: 'source-inpaint', backgroundUrl: `/uploads/reconstructions/${key}-source.jpg`, subjects: [{ id: 'reviewed-person', label: 'person', kind: 'person', box: [0, 0, 1, 1], maskUrl, neuralAsset }] };
  let calls = 0;
  try {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } }).grayscale().png().toFile(path.join(artifacts, `${key}-mask-0.png`));
    await writeFile(path.join(artifacts, `${key}-world.json`), JSON.stringify(world));
    const completer = new WorldCompleter(uploads, { localSegmenter: false, poseModelVariant: 'full',
      provider: { segment: async () => { throw new Error('Cloud must not be called'); }, textures: async () => { throw new Error('Cloud must not be called'); } },
      poseEstimator: async () => { calls++; return [{ pose, maskUrl }, { pose, maskUrl }]; } });
    await completer.complete(reconstruction);
    const enriched = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(enriched.subjects.length, 1);
    assert.deepEqual(enriched.subjects[0].neuralAsset, neuralAsset);
    assert.equal(enriched.subjects[0].maskUrl, maskUrl);
    assert.deepEqual(enriched.subjects[0].humanPose, pose);
    assert.equal(enriched.poseEstimation.matched, 1);
    await completer.complete(reconstruction);
    assert.equal(calls, 1);
    const upgraded = new WorldCompleter(uploads, { localSegmenter: false, poseModelVariant: 'heavy',
      poseEstimator: async () => { calls++; return [{ pose: { ...pose, model: 'pose-landmarker-heavy' }, maskUrl }]; } });
    await upgraded.complete(reconstruction);
    assert.equal(calls, 2, 'Changing the selected model upgrades cached poses once.');
    const upgradedWorld = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(upgradedWorld.poseEstimation.model, 'pose-landmarker-heavy');
    assert.deepEqual(upgradedWorld.subjects[0].neuralAsset, neuralAsset);
    await upgraded.complete(reconstruction); assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('transient local pose unavailability backs off and retries without invalidating existing world assets', async () => {
  const { uploads, artifacts, key, reconstruction, cleanup } = await fixture();
  const world: WorldCompletion = { version: 1, generatedBy: 'local-segmentation', backgroundUrl: `/uploads/reconstructions/${key}-source.jpg`, subjects: [] };
  let calls = 0;
  try {
    await writeFile(path.join(artifacts, `${key}-world.json`), JSON.stringify(world));
    const completer = new WorldCompleter(uploads, { localSegmenter: false, poseEstimator: async () => { if (++calls === 1) throw new Error('Runtime missing'); return []; } });
    await completer.complete(reconstruction);
    const failed = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(failed.poseEstimation.status, 'unavailable');
    assert.equal(failed.backgroundUrl, world.backgroundUrl);
    await completer.complete(reconstruction); assert.equal(calls, 1);
    await utimes(path.join(artifacts, `${key}-${POSE_CACHE_VERSION}-attempt.json`), new Date(0), new Date(0));
    await completer.complete(reconstruction); assert.equal(calls, 2);
    const repaired = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(repaired.poseEstimation.status, 'complete');
  } finally { await cleanup(); }
});

test('an invalid optional pose upgrade cannot replace a valid world or enter cloud generation', async () => {
  const { uploads, artifacts, key, reconstruction, cleanup } = await fixture();
  const pose: HumanPose = { version: 1, source: 'mediapipe-pose', model: 'pose-landmarker-full', confidence: .9, observedFraction: 1,
    sourceBox: [.1, .2, .9, .8], landmarks: HUMAN_POSE_LANDMARK_NAMES.map(name => ({ name, image: [.5, .4, 0], world: [0, 0, 0], visibility: .9, presence: .9 })) };
  const maskUrl = `/uploads/reconstructions/${key}-mask-0.png`;
  const world: WorldCompletion = { version: 1, generatedBy: 'local-segmentation', backgroundUrl: `/uploads/reconstructions/${key}-source.jpg`, subjects: [
    { id: 'keep-person', label: 'keep clothing', kind: 'person', box: [0,0,1,1], maskUrl, humanPose: pose },
  ] };
  let cloudCalls = 0;
  try {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } }).grayscale().png().toFile(path.join(artifacts, `${key}-mask-0.png`));
    await writeFile(path.join(artifacts, `${key}-world.json`), JSON.stringify(world));
    const invalid = structuredClone(pose); invalid.landmarks[0].world[0] = Number.NaN;
    const completer = new WorldCompleter(uploads, { localSegmenter: false,
      provider: { segment: async () => { cloudCalls++; return []; }, textures: async () => { cloudCalls++; throw new Error('Must not regenerate'); } },
      poseEstimator: async () => [{ pose: invalid, maskUrl }] });
    await completer.complete(reconstruction);
    const retained = JSON.parse(await readFile(path.join(artifacts, `${key}-world.json`), 'utf8'));
    assert.equal(cloudCalls, 0);
    assert.equal(retained.poseEstimation.status, 'unavailable');
    assert.equal(retained.poseEstimation.detected, 1);
    assert.equal(retained.poseEstimation.matched, 1);
    assert.deepEqual(retained.subjects, world.subjects);
    assert.equal(retained.backgroundUrl, world.backgroundUrl);
  } finally { await cleanup(); }
});
