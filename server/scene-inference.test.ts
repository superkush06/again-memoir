import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Memory, ReconstructionSpec } from '../src/types.js';
import { runSceneInferenceJob } from './scene-inference.js';
import { createBackend } from './app.js';
import { LOCAL_OBJECT_MODEL_VERSION } from './local-object-detector.js';

const geometry: ReconstructionSpec = { version: 1, kind: 'depth-mesh', sourceUrl: '/uploads/source.jpg', depthUrl: '/uploads/depth.png', width: 640, height: 480, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60 };
const memory = (id: string): Memory => ({ id, title: id, description: '', date: '', location: '', tags: [], source: 'upload', mediaType: 'image', url: '/uploads/source.jpg', thumbnailUrl: '' });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-inference-'));
  const workerPath = path.join(directory, 'worker.mjs');
  await writeFile(workerPath, `
import {appendFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
process.once('message', job => {
  const id = job.memory.id;
  const events = path.join(job.uploadsDir, 'events');
  appendFileSync(events, 'start:' + id + '\\n');
  if (id === 'hang') { setInterval(() => {}, 1000); return; }
  if (id === 'exit') process.exit(1);
  if (id === 'invalid') { process.send({ok:true,result:{}}); return; }
  if (id === 'spam') { process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000); return; }
  if (id === 'reject') { process.send({ok:false,status:422,message:'Invalid video.'}, () => process.exit(1)); return; }
  writeFileSync(path.join(job.uploadsDir, 'started-' + id), 'yes');
  const end = Date.now() + (id === 'busy' ? 500 : 80);
  while (Date.now() < end) { Math.sqrt(Math.random()); }
  appendFileSync(events, 'end:' + id + '\\n');
  process.send({ok:true,result:${JSON.stringify(geometry)}}, () => process.exit(0));
});
`);
  return {
    directory, workerPath,
    run: (id: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) => runSceneInferenceJob({ kind: 'depth', uploadsDir: directory, memory: memory(id) }, { workerPath, timeoutMs: 10000, ...extra }),
    async clean() {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('memoir-inference-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('isolated inference serializes native process lifetimes and releases the parent event loop', async () => {
  const f = await fixture();
  try {
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 20);
    const results = await Promise.all([f.run('one'), f.run('two')]);
    clearTimeout(timer);
    assert.equal(timerRan, true);
    assert.deepEqual(results, [geometry, geometry]);
    assert.deepEqual((await readFile(path.join(f.directory, 'events'), 'utf8')).trim().split('\n'), ['start:one', 'end:one', 'start:two', 'end:two']);
  } finally { await f.clean(); }
});

test('isolated inference bounds stalled/outputting processes, rejects invalid metadata, and recovers its queue', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run('hang', { timeoutMs: 300 }), /processing limit/);
    await assert.rejects(f.run('spam', { maxOutputBytes: 256 }), /excessive diagnostic/);
    await assert.rejects(f.run('invalid'), /invalid metadata/);
    await assert.rejects(f.run('exit'), /stopped before completing/);
    await assert.rejects(f.run('reject'), (error: unknown) => error instanceof Error && error.message === 'Invalid video.' && 'status' in error && error.status === 422);
    assert.deepEqual(await f.run('recovery'), geometry);
  } finally { await f.clean(); }
});

test('production TypeScript worker loads without model inference and preserves safe input errors', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runSceneInferenceJob({ kind: 'depth', uploadsDir: f.directory, memory: { ...memory('invalid-source'), url: '/uploads/../private.jpg' } }, { env: {}, timeoutMs: 10000 }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 400 && /image path/.test(error.message));
  } finally { await f.clean(); }
});

test('video workers accept cached empty recognition and reject unavailable recognition without silently completing', async () => {
  const f = await fixture();
  try {
    const uploadsDir = path.join(f.directory, 'uploads');
    const artifacts = path.join(uploadsDir, 'reconstructions');
    await mkdir(artifacts, { recursive: true });
    const key = 'b'.repeat(32);
    const prefix = `/uploads/reconstructions/${key}`;
    const reconstruction: ReconstructionSpec = { ...geometry, sourceUrl: `${prefix}-source.jpg`, depthUrl: `${prefix}-depth.png`, mediaBasis: 'video-frame' };
    const world = { version: 1, generatedBy: 'depth-fallback', backgroundUrl: `${prefix}-background.jpg`, subjects: [], objectRecognition: { version: 1, status: 'complete', source: 'local-grounding-dino', modelVersion: LOCAL_OBJECT_MODEL_VERSION, detected: 0 } };
    const worldFile = path.join(artifacts, `${key}-world.json`);
    await writeFile(worldFile, JSON.stringify(world));
    await writeFile(path.join(artifacts, `${key}-background.jpg`), 'cached-image');
    let peak = 0;
    const complete = await runSceneInferenceJob({ kind: 'complete', uploadsDir, reconstruction }, { env: {}, timeoutMs: 10000, onDiagnostics: diagnostics => { peak = diagnostics.peakRssBytes; } });
    assert.equal(complete.completionUrl, `${prefix}-world.json`);
    assert.ok(peak > 0);
    const repeated = await runSceneInferenceJob({ kind: 'complete', uploadsDir, reconstruction }, { env: {}, timeoutMs: 10000, onDiagnostics: () => { throw new Error('diagnostic sink failed'); } });
    assert.equal(repeated.completionUrl, complete.completionUrl, 'a failing diagnostic sink must not crash the API or strand its queue');
    world.objectRecognition.status = 'unavailable';
    await writeFile(worldFile, JSON.stringify(world));
    await writeFile(path.join(artifacts, `${key}-objects-${LOCAL_OBJECT_MODEL_VERSION}.json`), JSON.stringify({ status: 'unavailable' }));
    await assert.rejects(runSceneInferenceJob({ kind: 'complete', uploadsDir, reconstruction }, { env: {}, timeoutMs: 10000 }), /Video object recognition is unavailable/);
  } finally { await f.clean(); }
});

test('HTTP health and media remain available during CPU work, and simultaneous scene requests reuse one job', async () => {
  const f = await fixture();
  const backend = await createBackend({
    dataDir: f.directory, env: {}, seed: [memory('busy')],
    reconstruction: { reconstruct: () => f.run('busy') },
  });
  await writeFile(path.join(backend.store.uploadsDir, 'sample.mp4'), Buffer.from('test-media'));
  await writeFile(path.join(backend.store.uploadsDir, 'source.jpg'), Buffer.from('fixture-original-image'));
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  const request = () => fetch(base + '/api/memories/busy/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    let completed = false;
    const first = request().then(result => { completed = true; return result; });
    const second = request();
    const deadline = Date.now() + 10000;
    while (true) {
      try { await readFile(path.join(f.directory, 'started-busy')); break; }
      catch { assert.ok(Date.now() < deadline, 'worker did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const [health, media] = await Promise.all([fetch(base + '/api/health'), fetch(base + '/uploads/sample.mp4', { headers: { Range: 'bytes=0-3' } })]);
    assert.equal(health.status, 200);
    assert.equal(media.status, 206);
    assert.equal(await media.text(), 'test');
    assert.equal(completed, false, 'health/media must finish while the worker is still busy');
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual((await readFile(path.join(f.directory, 'events'), 'utf8')).trim().split('\n'), ['start:busy', 'end:busy']);
  } finally {
    backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await f.clean();
  }
});
