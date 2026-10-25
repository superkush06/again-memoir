import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ImageQuality, AssetRecord } from './library.js';
import { deriveEvents, LibraryService, scoreCover, scoreWorldAnchor } from './library.js';
import { MemoryStore } from './store.js';
import type { Memory } from '../src/types.js';

const memory = (id: string, changes: Partial<Memory> = {}): Memory => ({
  id, title: id, description: '', date: '2026-10-24', location: '', tags: [], source: 'upload',
  mediaType: 'image', url: `/uploads/${id}.png`, thumbnailUrl: `/uploads/${id}.png`, ...changes,
});

const quality = (changes: Partial<ImageQuality> = {}): ImageQuality => ({
  sharpness: 0.5, exposure: 0.5, composition: 0.5, subjectQuality: 0.5, visualAppeal: 0.5,
  wideScene: 0.5, depthVariation: 0.5, visibleGround: 0.5, openSpace: 0.5, stableGeometry: 0.5,
  screenshotLikelihood: 0.1, obstruction: 0.2, ...changes,
});

const asset = (memoryId: string, embedding: number[], job = 'job-one'): AssetRecord => ({
  memoryId, fileHash: memoryId.padEnd(64, '0').slice(0, 64), perceptualHash: '0000000000000000', embedding,
  embeddingProvider: 'local-grid-v1', quality: quality(), importJobId: job,
  provenance: [{ source: 'upload', sourceId: memoryId, importJobId: job, importedAt: '2026-10-24T12:00:00.000Z' }],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-library-'));
  const store = new MemoryStore(directory, []); await store.initialize();
  const library = new LibraryService(store); await library.initialize();
  return { directory, store, library, close: () => rm(directory, { recursive: true, force: true }) };
}

test('import jobs resume completed item stages without duplicate memories', async () => {
  const { directory, store, library, close } = await fixture();
  try {
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#7691a8' } }).png().toBuffer();
    const job = await library.createJob('upload', 1);
    await library.ingestBytes(job.id, 'one.png', memory('one'), bytes, 'image/png');
    assert.equal(store.list().length, 1);
    const reopenedStore = new MemoryStore(directory, []); await reopenedStore.initialize();
    const reopened = new LibraryService(reopenedStore); await reopened.initialize();
    assert.equal(reopenedStore.list().length, 1);
    assert.equal(reopened.jobs()[0].status, 'ready');
    assert.equal(reopened.jobs()[0].items[0].stage, 'ready');
  } finally { await close(); }
});

test('identical imports keep one canonical memory, one archive, and both provenances', async () => {
  const { directory, store, library, close } = await fixture();
  try {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa7755' } }).png().toBuffer();
    const job = await library.createJob('upload', 2);
    await library.ingestBytes(job.id, 'first.png', memory('first'), bytes, 'image/png');
    await library.ingestBytes(job.id, 'second.png', memory('second'), bytes, 'image/png');
    const completed = await library.finishJob(job.id);
    assert.equal(store.list().length, 1);
    assert.equal(completed.processedItems, 1);
    assert.equal(completed.skippedItems, 1);
    assert.equal(store.list()[0].provenance?.length, 2);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 1);
  } finally { await close(); }
});

test('derived events are deterministic and do not require location metadata', () => {
  const memories = [
    memory('a', { title: 'Coastal walk', description: 'Wind and ocean', tags: ['weekend'], location: '' }),
    memory('b', { title: 'Ocean overlook', description: 'A windy weekend', tags: ['weekend'], location: '' }),
  ];
  const assets = [asset('a', [1, 0, 0]), asset('b', [0.99, 0.01, 0])];
  const first = deriveEvents(memories, assets); const second = deriveEvents(memories.slice().reverse(), assets.slice().reverse());
  assert.deepEqual(first, second);
  assert.equal(first[0].memoryIds.length, 2);
  assert.ok(first[0].reasons.includes('same time window'));
  assert.ok(first[0].reasons.includes('similar visual content'));
});

test('cover and world-anchor rankings favor different photographs when appropriate', () => {
  const portrait = quality({ sharpness: 0.98, exposure: 0.95, composition: 0.96, subjectQuality: 0.98, visualAppeal: 0.95, wideScene: 0.05, depthVariation: 0.1, visibleGround: 0.02, openSpace: 0.08, stableGeometry: 0.35, obstruction: 0.8 });
  const landscape = quality({ sharpness: 0.82, exposure: 0.78, composition: 0.72, subjectQuality: 0.55, visualAppeal: 0.76, wideScene: 0.98, depthVariation: 0.94, visibleGround: 0.9, openSpace: 0.92, stableGeometry: 0.9, obstruction: 0.08 });
  assert.ok(scoreCover(portrait, 1) > scoreCover(landscape, 1));
  assert.ok(scoreWorldAnchor(landscape) > scoreWorldAnchor(portrait));
});

test('album membership is validated and private share previews expose only selected members', async () => {
  const { store, library, close } = await fixture();
  try {
    await store.add([memory('one'), memory('two')]);
    await assert.rejects(library.createManual('Invalid', ['one', 'missing']), /Every album item/);
    const album = await library.createManual('Private trip', ['one', 'two'], 'one', 'two');
    assert.equal(album.privacy, 'private');
    const preview = library.sharePreview(album.id, ['two'])!;
    assert.deepEqual(preview.memoryIds, ['two']);
    assert.equal(preview.totalMedia, 1);
    assert.throws(() => library.sharePreview(album.id, ['missing']), /belong/);
    assert.throws(() => library.sharePreview(album.id, ['one']), /world anchor/);
    await assert.rejects(library.updateAlbum(album.id, { removeMemoryIds: ['two'], worldAnchorMemoryId: 'two' }), /belong/);
  } finally { await close(); }
});
