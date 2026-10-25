import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Memory, ReconstructionSpec } from '../src/types.js';
import { IsolatedReadinessScorer, runSceneInferenceJob } from './scene-inference.js';

/**
 * Stub batch worker: answers each score request, logs process lifetimes, and
 * misbehaves on request (via the image bytes) so the boundary can be tested
 * without loading the depth model.
 */
const stubWorker = `
import { appendFileSync } from 'node:fs';
const log = process.env.READINESS_STUB_LOG;
appendFileSync(log, 'spawn:' + process.pid + '\\n');
process.on('message', message => {
  if (message.type === 'shutdown') { appendFileSync(log, 'exit:' + process.pid + '\\n'); process.exit(0); }
  const tag = Buffer.from(message.input.bytes || []).toString();
  appendFileSync(log, 'score:' + tag + '\\n');
  if (tag === 'hang') return;
  if (tag === 'crash') process.exit(1);
  if (tag === 'garbage') { process.send({ id: message.id, ok: true, result: { score: 7 } }); return; }
  process.send({ id: message.id, ok: true, result: { version: 2, score: 0.9, ready: true, reasons: ['stub'], source: 'depth-anything-v2', threshold: 0.6, scoredAt: '2026-10-24T00:00:00.000Z', durationMs: 1 } });
});
process.send({ ready: true });
`;
const geometry: ReconstructionSpec = { version: 1, kind: 'depth-mesh', sourceUrl: '/uploads/source.jpg', depthUrl: '/uploads/depth.png', width: 640, height: 480, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60 };
const reconstructionStub = `
import { appendFileSync } from 'node:fs';
process.once('message', job => {
  appendFileSync(process.env.READINESS_STUB_LOG, 'reconstruct:' + job.memory.id + '\\n');
  process.send({ ok: true, result: ${JSON.stringify(geometry)} }, () => process.exit(0));
});
`;

async function fixture(options: { idleMs?: number; maxItemsPerProcess?: number; itemTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-readiness-'));
  const workerPath = path.join(directory, 'worker.mjs'); const reconstructionPath = path.join(directory, 'reconstruct.mjs');
  const log = path.join(directory, 'events');
  await writeFile(workerPath, stubWorker); await writeFile(reconstructionPath, reconstructionStub); await writeFile(log, '');
  const env = { READINESS_STUB_LOG: log };
  const scorer = new IsolatedReadinessScorer(path.join(directory, 'models'), env, { workerPath, idleMs: 200, ...options });
  return {
    directory, scorer, env, reconstructionPath,
    image: (tag: string) => ({ kind: 'image' as const, bytes: Buffer.from(tag) }),
    events: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => line.replace(/:\d+$/, '')),
    async clean() {
      await scorer.close();
      assert.ok(path.basename(directory).startsWith('memoir-readiness-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const memory = (id: string): Memory => ({ id, title: id, description: '', date: '', location: '', tags: [], source: 'upload', mediaType: 'image', url: '/uploads/source.jpg', thumbnailUrl: '' });

test('3D check: one worker process scores a whole batch, then exits when idle', async () => {
  const f = await fixture();
  try {
    for (const tag of ['a', 'b', 'c']) assert.equal((await f.scorer.score(f.image(tag))).ready, true);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(await f.events(), ['spawn', 'score:a', 'score:b', 'score:c', 'exit']);
  } finally { await f.clean(); }
});

test('3D check: the batch recycles its process after maxItemsPerProcess', async () => {
  const f = await fixture({ maxItemsPerProcess: 2 });
  try {
    for (const tag of ['a', 'b', 'c']) await f.scorer.score(f.image(tag));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(await f.events(), ['spawn', 'score:a', 'score:b', 'exit', 'spawn', 'score:c', 'exit']);
  } finally { await f.clean(); }
});

test('3D check never overlaps reconstruction: it holds the shared model lock for its batch', async () => {
  const f = await fixture();
  try {
    await f.scorer.score(f.image('a'));
    // Queued while the 3D batch is open: must start only after that process exits.
    const reconstruction = runSceneInferenceJob({ kind: 'depth', uploadsDir: f.directory, memory: memory('r1') }, { workerPath: f.reconstructionPath, env: f.env, timeoutMs: 10000 });
    assert.deepEqual(await reconstruction, geometry);
    const events = await f.events();
    assert.ok(events.indexOf('exit') < events.indexOf('reconstruct:r1'), events.join(','));
  } finally { await f.clean(); }
});

test('3D check falls back to the heuristic on crash, hang, or invalid output, and recovers', async () => {
  const f = await fixture({ itemTimeoutMs: 300 });
  try {
    for (const tag of ['crash', 'hang', 'garbage']) {
      const result = await f.scorer.score(f.image(tag));
      assert.equal(result.source, 'heuristic', tag);
      assert.equal(result.ready, false, tag);
    }
    assert.equal((await f.scorer.score(f.image('ok'))).source, 'depth-anything-v2');
  } finally { await f.clean(); }
});
