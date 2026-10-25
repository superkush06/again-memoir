import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Memory, ReconstructionSpec } from '../src/types.js';
import { IsolatedReadinessScorer, runSceneInferenceJob, type InferenceDiagnostics } from './scene-inference.js';

/**
 * Worker output is discarded, so the depth device reaches the logs only over IPC.
 * Stub workers report fixed codes (and hostile strings) without loading a model.
 */
const geometry: ReconstructionSpec = { version: 1, kind: 'depth-mesh', sourceUrl: '/uploads/source.jpg', depthUrl: '/uploads/depth.png', width: 640, height: 480, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60 };
const memory = (id: string): Memory => ({ id, title: id, description: '', date: '', location: '', tags: [], source: 'upload', mediaType: 'image', url: '/uploads/source.jpg', thumbnailUrl: '' });
const sceneStub = (depth: object) => `
process.once('message', () => process.send({ ok: true, result: ${JSON.stringify(geometry)}, diagnostics: { elapsedMs: 5, peakRssBytes: 1000, ...${JSON.stringify(depth)} } }, () => process.exit(0)));
`;
const readinessStub = (depth: object) => `
process.on('message', message => {
  if (message.type === 'shutdown') process.exit(0);
  process.send({ id: message.id, ok: true, depth: ${JSON.stringify(depth)}, result: { version: 2, score: 0.9, ready: true, reasons: ['stub'], source: 'depth-anything-v2', threshold: 0.6, scoredAt: '2026-10-24T00:00:00.000Z', durationMs: 1 } });
});
process.send({ ready: true });
`;

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-depth-ipc-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('the scene worker reports its depth device and fallback, and only known codes are kept', () => withDirectory(async directory => {
  const cases: [object, Partial<InferenceDiagnostics>][] = [
    [{ depthDevice: 'webgpu' }, { depthDevice: 'webgpu' }],
    [{ depthDevice: 'cpu', depthFallback: 'webgpu-run-failed' }, { depthDevice: 'cpu', depthFallback: 'webgpu-run-failed' }],
    [{ depthDevice: 'Error: /Users/someone/.env', depthFallback: 'token=secret' }, {}],
  ];
  for (const [index, [sent, expected]] of cases.entries()) {
    const workerPath = path.join(directory, `scene-${index}.mjs`);
    await writeFile(workerPath, sceneStub(sent));
    let received: InferenceDiagnostics | undefined;
    await runSceneInferenceJob({ kind: 'depth', uploadsDir: directory, memory: memory(`m${index}`) }, { workerPath, timeoutMs: 10000, onDiagnostics: value => { received = value; } });
    assert.deepEqual(received, { elapsedMs: 5, peakRssBytes: 1000, ...expected });
  }
}));

test('the readiness batch logs the device its worker reported, dropping unknown values', () => withDirectory(async directory => {
  for (const [sent, expected] of [
    [{ depthDevice: 'cpu', depthFallback: 'webgpu-load-failed' }, { depthDevice: 'cpu', depthFallback: 'webgpu-load-failed' }],
    [{ depthDevice: 'gpu0 /dev/dri', depthFallback: 42 }, {}],
  ] as [object, object][]) {
    const workerPath = path.join(directory, `readiness-${JSON.stringify(expected).length}.mjs`);
    await writeFile(workerPath, readinessStub(sent));
    const logs: string[] = [];
    const scorer = new IsolatedReadinessScorer(path.join(directory, 'models'), {}, { workerPath, idleMs: 50, log: message => logs.push(message) });
    assert.equal((await scorer.score({ kind: 'image', bytes: Buffer.from('photo') })).score, 0.9);
    await scorer.close();
    const event = JSON.parse(logs.find(line => line.includes('readiness-inference'))!);
    assert.equal(event.scored, 1);
    assert.deepEqual({ depthDevice: event.depthDevice, depthFallback: event.depthFallback }, { depthDevice: undefined, depthFallback: undefined, ...expected });
  }
}));
