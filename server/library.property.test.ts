import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc, { type Arbitrary } from 'fast-check';
import sharp from 'sharp';
import type { Memory } from '../src/types.js';
import { isAlbumWorldState } from '../src/album-world-validation.js';
import { parseGooglePickerLimit } from './integrations.js';
import { deriveEvents, LibraryService, scoreCover, scoreWorldAnchor, type AssetRecord, type ImageQuality } from './library.js';
import { MemoryStore } from './store.js';

const propertyOptions = { seed: 20261024, numRuns: 100 };
const unitInterval = fc.double({ min: 0, max: 1, noNaN: true });
const qualityArbitrary: Arbitrary<ImageQuality> = fc.record({
  sharpness: unitInterval,
  exposure: unitInterval,
  composition: unitInterval,
  subjectQuality: unitInterval,
  visualAppeal: unitInterval,
  wideScene: unitInterval,
  depthVariation: unitInterval,
  visibleGround: unitInterval,
  openSpace: unitInterval,
  stableGeometry: unitInterval,
  screenshotLikelihood: unitInterval,
  obstruction: unitInterval,
});

function memory(id: string, changes: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Memory ${id}`,
    description: '',
    date: '',
    location: '',
    tags: [],
    source: 'upload',
    mediaType: 'image',
    url: `/uploads/${id}.png`,
    thumbnailUrl: `/uploads/${id}.png`,
    ...changes,
  };
}

const baseQuality: ImageQuality = {
  sharpness: 0.5, exposure: 0.5, composition: 0.5, subjectQuality: 0.5, visualAppeal: 0.5,
  wideScene: 0.5, depthVariation: 0.5, visibleGround: 0.5, openSpace: 0.5, stableGeometry: 0.5,
  screenshotLikelihood: 0.1, obstruction: 0.2,
};

function capturedAtFor(day: number) {
  return new Date(Date.UTC(2026, 0, day + 1, 12)).toISOString();
}

async function fixture(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new MemoryStore(directory, []);
  await store.initialize();
  const library = new LibraryService(store);
  await library.initialize();
  return { directory, store, library };
}

async function patternedPng(index: number, color: [number, number, number]) {
  const width = 16; const height = 16; const channels = 3;
  const raw = Buffer.alloc(width * height * channels, 18);
  const cellX = (index % 4) * 4; const cellY = (Math.floor(index / 4) % 4) * 4;
  const marker = color.map(value => 128 + Math.floor(value / 2));
  for (let y = cellY; y < cellY + 4; y++) for (let x = cellX; x < cellX + 4; x++) {
    const offset = (y * width + x) * channels;
    raw[offset] = marker[0]; raw[offset + 1] = marker[1]; raw[offset + 2] = marker[2];
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

test('PBT: cover and world scores stay bounded and improve monotonically with positive evidence', () => {
  fc.assert(fc.property(qualityArbitrary, unitInterval, unitInterval, (quality, uniqueness, improvement) => {
    const cover = scoreCover(quality, uniqueness);
    const world = scoreWorldAnchor(quality);
    assert.ok(cover >= 0 && cover <= 1);
    assert.ok(world >= 0 && world <= 1);
    assert.ok(scoreCover({ ...quality, sharpness: Math.min(1, quality.sharpness + improvement) }, uniqueness) >= cover);
    assert.ok(scoreCover(quality, Math.min(1, uniqueness + improvement)) >= cover);
    assert.ok(scoreWorldAnchor({ ...quality, wideScene: Math.min(1, quality.wideScene + improvement) }) >= world);
  }), propertyOptions);
});

test('PBT: derived events are a deterministic location-free partition under input reordering', () => {
  const input = fc.array(fc.record({
    day: fc.integer({ min: 0, max: 40 }),
    visualGroup: fc.integer({ min: 0, max: 3 }),
    account: fc.integer({ min: 0, max: 4 }),
  }), { minLength: 1, maxLength: 30 });
  fc.assert(fc.property(input, rows => {
    const memories = rows.map((row, index) => {
      const capturedAt = capturedAtFor(row.day);
      return memory(`memory-${index}`, {
        title: `Moment group ${row.visualGroup}`,
        description: `Account chapter ${row.account}`,
        date: capturedAt.slice(0, 10),
        capturedAt,
        location: '',
        tags: [`group-${row.visualGroup}`, `account-${row.account}`],
        sourceAccount: `account-${row.account}`,
      });
    });
    const assets: AssetRecord[] = rows.map((row, index) => ({
      memoryId: `memory-${index}`,
      fileHash: index.toString(16).padStart(64, '0'),
      perceptualHash: index.toString(16).padStart(16, '0'),
      embedding: [0, 1, 2, 3].map(group => group === row.visualGroup ? 1 : 0),
      embeddingProvider: 'local-grid-v1',
      quality: baseQuality,
      importJobId: `job-${row.account}`,
      provenance: [{ source: 'upload', sourceId: `source-${index}`, importJobId: `job-${row.account}`, importedAt: capturedAtFor(row.day) }],
    }));
    const events = deriveEvents(memories, assets);
    assert.deepEqual(events, deriveEvents(memories.slice().reverse(), assets.slice().reverse()));
    assert.deepEqual(events.flatMap(event => event.memoryIds).sort(), memories.map(item => item.id).sort());
    assert.equal(new Set(events.flatMap(event => event.memoryIds)).size, memories.length);
    assert.ok(events.every(event => event.reasons.every(reason => [
      'same time window', 'similar visual content', 'shared caption terms', 'same source account', 'same selected batch',
    ].includes(reason))));
  }), { ...propertyOptions, numRuns: 75 });
});

test('PBT: duplicate batches converge to one durable canonical archive with complete provenance', async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({
      color: fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
      copies: fc.integer({ min: 2, max: 8 }),
    }),
    async ({ color, copies }) => {
      const { directory, store, library } = await fixture('memoir-pbt-dedup-');
      try {
        const bytes = await patternedPng(0, color);
        const job = await library.createJob('upload', copies);
        for (let index = 0; index < copies; index++) {
          await library.ingestBytes(job.id, `source-${index}`, memory(`candidate-${index}`), bytes, 'image/png');
        }
        const completed = await library.finishJob(job.id);
        assert.equal(store.list().length, 1);
        assert.equal(completed.processedItems, 1);
        assert.equal(completed.skippedItems, copies - 1);
        assert.equal(store.list()[0].provenance?.length, copies);
        assert.equal(new Set(store.list()[0].provenance?.map(item => item.sourceId)).size, copies);
        assert.equal((await readdir(path.join(directory, 'uploads'))).length, 1);

        const reopenedStore = new MemoryStore(directory, []);
        await reopenedStore.initialize();
        const reopened = new LibraryService(reopenedStore);
        await reopened.initialize();
        assert.equal(reopenedStore.list().length, 1);
        assert.equal(reopened.jobs()[0].status, 'ready');
        assert.equal(reopenedStore.list()[0].provenance?.length, copies);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  ), { ...propertyOptions, numRuns: 12 });
});

test('PBT: import through album sharing never widens the selected private subset', async () => {
  const colors = fc.array(
    fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
    { minLength: 2, maxLength: 7 },
  );
  await fc.assert(fc.asyncProperty(colors, async palette => {
    const { directory, store, library } = await fixture('memoir-pbt-flow-');
    try {
      const job = await library.createJob('google-photos', palette.length);
      for (let index = 0; index < palette.length; index++) {
        const bytes = await patternedPng(index, palette[index]);
        await library.ingestBytes(job.id, `google-${index}`, memory(`memory-${index}`, {
          source: 'google-photos', sourceAccount: 'Google Photos selection',
        }), bytes, 'image/png');
      }
      const completed = await library.finishJob(job.id);
      assert.equal(completed.status, 'ready');
      assert.equal(completed.processedItems, palette.length);
      assert.equal(completed.failedItems, 0);
      assert.equal(store.list().length, palette.length);

      const event = library.events().find(candidate => candidate.memoryIds.length === palette.length);
      assert.ok(event);
      assert.equal(new Set(event.memoryIds).size, palette.length);
      assert.ok(event.reasons.includes('same selected batch'));

      const album = library.albums().find(candidate => candidate.memoryIds.length === palette.length);
      assert.ok(album);
      assert.equal(album.type, 'suggested');
      assert.equal(album.privacy, 'private');
      assert.ok(album.memoryIds.includes(album.coverMemoryId));
      assert.ok(album.memoryIds.includes(album.worldAnchorMemoryId));

      const selected = [...new Set([album.worldAnchorMemoryId, ...album.memoryIds.filter((_id, index) => index % 2 === 0)])];
      const preview = library.sharePreview(album.id, selected);
      assert.ok(preview);
      assert.deepEqual(new Set(preview.memoryIds), new Set(selected));
      assert.ok(album.memoryIds.filter(id => !selected.includes(id)).every(id => !preview.memoryIds.includes(id)));

      const reopenedStore = new MemoryStore(directory, []);
      await reopenedStore.initialize();
      const reopened = new LibraryService(reopenedStore);
      await reopened.initialize();
      assert.deepEqual(reopened.album(album.id)?.memoryIds, album.memoryIds);
      assert.equal(reopened.jobs().find(candidate => candidate.id === job.id)?.status, 'ready');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }), { ...propertyOptions, numRuns: 12 });
});

test('PBT: album-world manifests accept bounded subsets and reject widening or hidden anchors', () => {
  const relatedIds = fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), { minLength: 2, maxLength: 30 });
  fc.assert(fc.property(relatedIds, values => {
    const relatedMemoryIds = values.map(value => `memory-${value}`);
    const [anchorMemoryId, currentMemoryId] = relatedMemoryIds;
    const valid = {
      albumId: 'album-property', worldId: 'world-property', anchorMemoryId, currentMemoryId,
      relatedMemoryIds, sharedMemoryIds: relatedMemoryIds, geometryNotice: 'Inferred geometry is approximate.',
    };
    assert.equal(isAlbumWorldState(valid), true);
    assert.equal(isAlbumWorldState({ ...valid, sharedMemoryIds: relatedMemoryIds.filter(id => id !== anchorMemoryId) }), false);
    assert.equal(isAlbumWorldState({ ...valid, sharedMemoryIds: [...relatedMemoryIds, 'outside-private-memory'] }), false);
    assert.equal(isAlbumWorldState({ ...valid, currentMemoryId: 'outside-private-memory' }), false);
  }), propertyOptions);
});

test('PBT: Google Picker limits preserve every valid bound and reject values outside the API contract', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 2000 }), limit => {
    assert.equal(parseGooglePickerLimit({ maxItemCount: limit }), limit);
  }), propertyOptions);
  fc.assert(fc.property(fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 2001, max: 1_000_000 })), limit => {
    assert.throws(() => parseGooglePickerLimit({ maxItemCount: limit }));
  }), propertyOptions);
});
