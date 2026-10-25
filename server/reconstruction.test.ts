import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Memory } from '../src/types.js';
import { SceneReconstructor, allowedReconstructionUrl, downloadReconstructionSource, type DepthEstimator } from './reconstruction.js';

const photo: Memory = { id: 'test-photo', title: 'A photo', description: '', date: '', location: '', tags: [], source: 'upload', mediaType: 'image', url: '/uploads/photo.jpg', thumbnailUrl: '/uploads/photo.jpg' };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-depth-'));
  const uploads = path.join(directory, 'uploads');
  await mkdir(uploads);
  await sharp({ create: { width: 640, height: 400, channels: 3, background: '#9c8864' } }).jpeg().toFile(path.join(uploads, 'photo.jpg'));
  return { uploads, cleanup: async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^memoir-depth-/);
    await rm(resolved, { recursive: true, force: true });
  } };
}

test('reconstruction saves the inferred depth and original photo, deduplicates requests, and reopens cache without inference', async () => {
  const { uploads, cleanup } = await fixture();
  let calls = 0;
  const estimator: DepthEstimator = async input => {
    calls++;
    assert.equal(input.width, 518); assert.equal(input.height, 324);
    assert.equal(input.data.length, input.width * input.height * 3);
    // Deliberately independent of the uniform source image: geometry must come from the estimator.
    return { data: Uint8Array.from([0, 32, 64, 96, 128, 160, 192, 255]), width: 4, height: 2, channels: 1 };
  };
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    const [first, simultaneous] = await Promise.all([reconstructor.reconstruct(photo), reconstructor.reconstruct({ ...photo, id: 'another-id', title: 'Changed title' })]);
    assert.deepEqual(first, simultaneous); assert.equal(calls, 1);
    assert.equal(first.mediaBasis, 'image'); assert.equal(first.width, 640); assert.equal(first.height, 400);
    assert.match(first.depthUrl, /^\/uploads\/reconstructions\/[a-f0-9]{32}-depth\.png$/);
    const depth = await sharp(path.join(uploads, first.depthUrl.replace('/uploads/', ''))).raw().toBuffer({ resolveWithObject: true });
    const values = Array.from({ length: 8 }, (_, pixel) => depth.data[pixel * depth.info.channels]);
    assert.deepEqual(values, [0, 32, 64, 96, 128, 160, 192, 255]);
    const source = await sharp(path.join(uploads, first.sourceUrl.replace('/uploads/', ''))).metadata();
    assert.equal(source.width, 640); assert.equal(source.height, 400);
    const reopened = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('A persisted cache must skip inference.'); } });
    assert.deepEqual(await reopened.reconstruct(photo), first);
    // A file replacement at the same upload URL cannot silently reuse stale geometry.
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#4488cc' } }).jpeg().toFile(path.join(uploads, 'photo.jpg'));
    const changed = await reconstructor.reconstruct(photo);
    assert.notEqual(changed.depthUrl, first.depthUrl); assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('model failure is actionable, creates no invented depth, and can retry successfully', async () => {
  const { uploads, cleanup } = await fixture();
  let calls = 0;
  const estimator: DepthEstimator = async () => {
    if (++calls === 1) throw new Error('Download failed with a provider secret that must not escape.');
    return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 };
  };
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    await assert.rejects(reconstructor.reconstruct(photo), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.match((error as Error).message, /Hugging Face/);
      assert.doesNotMatch((error as Error).message, /secret/); return true;
    });
    const retried = await reconstructor.reconstruct(photo);
    assert.equal(retried.kind, 'depth-mesh'); assert.equal(calls, 2);
    assert.ok((await readFile(path.join(uploads, retried.depthUrl.replace('/uploads/', '')))).length);
  } finally { await cleanup(); }
});

test('corrupt persisted reconstruction metadata is rebuilt instead of sent to a shared room', async () => {
  const { uploads, cleanup } = await fixture(); let calls = 0;
  try {
    const reconstructor = new SceneReconstructor(uploads, { estimator: async () => { calls++; return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 }; } });
    await reconstructor.reconstruct(photo);
    const filename = (await readdir(reconstructor.artifactDir)).find(name => name.endsWith('.json'))!;
    const metadataPath = path.join(reconstructor.artifactDir, filename);
    const saved = JSON.parse(await readFile(metadataPath, 'utf8'));
    saved.reconstruction.near = 1000;
    await writeFile(metadataPath, JSON.stringify(saved));
    const rebuilt = await reconstructor.reconstruct(photo);
    assert.equal(rebuilt.near, 2); assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('reconstruction rejects arbitrary remote URLs and local traversal before image decoding or inference', async () => {
  assert.equal(allowedReconstructionUrl('https://images.unsplash.com/photo-example?width=500'), true);
  for (const url of ['https://images.unsplash.com.evil.test/x', 'https://evil-images.unsplash.com/x', 'https://user:pass@images.unsplash.com/x', 'http://images.unsplash.com/x', 'https://images.unsplash.com:444/x', 'https://127.0.0.1/private', 'file:///etc/passwd']) {
    assert.equal(allowedReconstructionUrl(url), false, url);
    await assert.rejects(downloadReconstructionSource(url), /Archive or upload/);
  }
  const { uploads, cleanup } = await fixture();
  const reconstructor = new SceneReconstructor(uploads, { estimator: async () => { throw new Error('Inference must not run.'); } });
  try {
    for (const url of ['/uploads/../private.jpg', '/uploads/..%2fprivate.jpg', '/uploads/subdir/photo.jpg', '/uploads/C:\\private.jpg', '/uploads/photo.jpg?x=1']) {
      await assert.rejects(reconstructor.reconstruct({ ...photo, url }), /image path/);
    }
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/missing.jpg' }), /original photo is missing/);
    await writeFile(path.join(uploads, 'broken.jpg'), Buffer.from('this is not an image'));
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/broken.jpg' }), /valid photo/);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#112233' } }).jpeg().toFile(path.join(uploads, 'tiny.jpg'));
    await assert.rejects(reconstructor.reconstruct({ ...photo, url: '/uploads/tiny.jpg' }), /at least 16 pixels/);
    await assert.rejects(reconstructor.reconstruct({ ...photo, mediaType: 'video', url: 'https://example.com/movie.mp4' }), /Upload or archive this video/);
  } finally { await cleanup(); }
});

test('inference is serialized for different photos so concurrent viewers cannot allocate concurrent model runs', async () => {
  const { uploads, cleanup } = await fixture();
  let active = 0; let maximum = 0; let calls = 0;
  const estimator: DepthEstimator = async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return { data: Uint8Array.of(0, 255), width: 2, height: 1, channels: 1 };
  };
  try {
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#111111' } }).jpeg().toFile(path.join(uploads, 'second.jpg'));
    const reconstructor = new SceneReconstructor(uploads, { estimator });
    await Promise.all([reconstructor.reconstruct(photo), reconstructor.reconstruct({ ...photo, url: '/uploads/second.jpg' })]);
    assert.equal(calls, 2); assert.equal(maximum, 1);
  } finally { await cleanup(); }
});
