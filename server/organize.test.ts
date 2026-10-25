import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from './store.js';
import { organizeMemory } from './organize.js';

test('import organization is explainable and Apify consent is persisted separately', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-store-'));
  try {
    const store = new MemoryStore(directory, []);
    await store.initialize();
    const [memory] = await store.add([{ id: 'instagram-test', title: 'Test', date: '2026-10-24', location: 'CalHacks', description: 'A test post', tags: [' #Demo ', 'Demo'], source: 'instagram', mediaType: 'image', url: '/uploads/test.jpg', thumbnailUrl: '/uploads/test.jpg' }]);
    assert.equal(memory.organization?.label, 'CalHacks');
    assert.deepEqual(memory.organization?.folderPath, ['CalHacks']);
    assert.deepEqual(memory.tags, ['#demo', 'demo']);
    const consent = await store.recordConsent({ source: 'instagram', accountUrl: 'https://www.instagram.com/example/', statement: 'I confirm this is my own account.' });
    assert.match(consent.id, /^[0-9a-f-]{36}$/);
    const savedConsents = JSON.parse(await readFile(path.join(directory, 'import-consents.json'), 'utf8'));
    assert.equal(savedConsents[0].id, consent.id);
    const reopened = new MemoryStore(directory, []);
    await reopened.initialize();
    assert.equal(reopened.list()[0].consentId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder taxonomy prefers holidays, locations, and exact broad category names', () => {
  const base = { id: 'x', title: 'x', description: '', date: '2025-10-31', location: '', tags: [], source: 'upload' as const, mediaType: 'image' as const, url: '', thumbnailUrl: '' };
  assert.equal(organizeMemory({ ...base, title: 'Costume night' }).organization?.folderPath?.[0], 'Halloween 2025');
  assert.equal(organizeMemory({ ...base, title: 'Airport', date: '2025-06-01', location: 'California' }).organization?.folderPath?.[0], 'California');
  assert.equal(organizeMemory({ ...base, title: 'Friends at dinner', date: '2025-06-01' }).organization?.folderPath?.[0], 'Friends');
  assert.equal(organizeMemory({ ...base, title: 'A normal day', date: '2025-06-01' }).organization?.folderPath?.[0], 'Everyday moments');
});
