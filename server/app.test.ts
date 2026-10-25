import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBackend } from './app.js';
import { keywordSearch } from './ai.js';
import { demoMemories } from './demo.js';
import { MemoryStore } from './store.js';
import { parseGooglePickerLimit } from './integrations.js';

test('Google Picker defaults to 2,000 explicitly selected items and rejects larger batches', () => {
  assert.equal(parseGooglePickerLimit({}), 2000);
  assert.equal(parseGooglePickerLimit({ maxItemCount: 50 }), 50);
  assert.throws(() => parseGooglePickerLimit({ maxItemCount: 2001 }));
  assert.throws(() => parseGooglePickerLimit({ maxItemCount: 0 }));
});

async function removeTestDirectory(directory: string) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^memoir-(store|http|room)-/);
  await rm(resolved, { recursive: true, force: true });
}

test('keyword search handles natural-language stopwords, synonyms, dates, and no matches', () => {
  assert.equal(keywordSearch('take me back to the ocean', demoMemories)[0].id, 'demo-coast');
  assert.equal(keywordSearch('2020 graduation', demoMemories)[0].id, 'demo-graduation');
  assert.equal(keywordSearch('purple spaceships', demoMemories).length, 0);
  assert.equal(keywordSearch('', demoMemories).length, 6);
});

test('catalog persists concurrent imports without losing records and deduplicates existing IDs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-store-'));
  try {
    const store = new MemoryStore(directory, []); await store.initialize();
    await Promise.all(demoMemories.map(memory => store.add([memory])));
    await store.add([demoMemories[0], demoMemories[0]]);
    const reopened = new MemoryStore(directory, []); await reopened.initialize();
    assert.equal(reopened.list().length, 6);
    const persisted = JSON.parse(await readFile(path.join(directory, 'memories.json'), 'utf8'));
    assert.equal(persisted.length, 6);
  } finally { await removeTestDirectory(directory); }
});

test('HTTP API persists real uploads and chapters, rejects invalid data, and labels fallback behavior', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-http-'));
  const backend = await createBackend({ dataDir: directory, env: {}, reconstruction: { reconstruct: async () => ({ version: 1, kind: 'depth-mesh', sourceUrl: '/uploads/source.jpg', depthUrl: '/uploads/depth.png', width: 640, height: 480, depthSource: 'depth-anything-v2', near: 2, far: 12, fov: 60 }) } });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const address = backend.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const post = (route: string, data: unknown) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.integrations.gemini.configured, false);
    assert.equal(health.integrations.googlePhotos.connected, false);
    const search = await (await post('/api/search', { query: 'mountains' })).json();
    assert.equal(search.mode, 'keyword'); assert.equal(search.memories[0].id, 'demo-mountains');
    assert.equal((await post('/api/search', { query: 123 })).status, 400);
    const scene = await (await post('/api/memories/demo-coast/scene', {})).json();
    assert.equal(scene.environment, 'beach'); assert.equal(scene.generatedBy, 'fallback');
    assert.equal(scene.reconstruction.kind, 'depth-mesh'); assert.equal(scene.reconstruction.depthSource, 'depth-anything-v2');
    assert.equal((await post('/api/memories/no-such-memory/scene', {})).status, 404);
    assert.equal((await fetch(`${url}/api/integrations/google/auth-url`)).status, 503);
    assert.equal((await fetch(`${url}/api/integrations/google/callback?state=forged&code=forged`)).status, 400);
    assert.equal((await post('/api/integrations/apify/import', { source: 'instagram', profileUrl: 'https://instagram.com/example' })).status, 503);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=', 'base64');
    const form = new FormData(); form.append('files', new Blob([png], { type: 'image/png' }), 'old-memory.png'); form.append('title', 'Our picnic'); form.append('tags', 'family,picnic');
    const uploaded = await fetch(`${url}/api/upload`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 201);
    const data = await uploaded.json(); assert.equal(data.memories[0].title, 'Our picnic');
    assert.equal((await fetch(url + data.memories[0].url)).status, 200);
    assert.match(data.statuses[0].status, /Archived, embedded, and grouped locally/);
    const analyzed = await (await post(`/api/memories/${data.memories[0].id}/analyze`, {})).json();
    assert.equal(analyzed.analyzed, false);
    assert.equal(analyzed.memory.title, 'Our picnic');
    assert.match(analyzed.status, /Configure Gemini/);
    assert.equal((await post('/api/memories/demo-coast/analyze', {})).status, 400);
    const malformed = new FormData(); malformed.append('files', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'fake.png');
    assert.equal((await fetch(`${url}/api/upload`, { method: 'POST', body: malformed })).status, 400);
    const chapter = await (await post('/api/chapters', { title: 'Summer', body: 'A picnic we remember.', memoryIds: [data.memories[0].id] })).json();
    assert.equal(chapter.title, 'Summer');
    assert.equal((await post('/api/chapters', { title: 'Invalid', memoryIds: ['missing'] })).status, 400);
    const changed = await (await post('/api/chapters', { ...chapter, body: 'Edited story.' })).json();
    assert.equal(changed.body, 'Edited story.');
    const chapters = await (await fetch(`${url}/api/chapters`)).json(); assert.equal(chapters.chapters.length, 1);
    const album = await (await post('/api/albums', { title: 'Coast and mountains', memoryIds: ['demo-coast', 'demo-mountains'], coverMemoryId: 'demo-coast', worldAnchorMemoryId: 'demo-mountains' })).json();
    assert.equal(album.privacy, 'private');
    assert.equal((await post(`/api/albums/${album.id}/share-preview`, { memoryIds: ['demo-coast'] })).status, 400);
    const preview = await (await post(`/api/albums/${album.id}/share-preview`, { memoryIds: ['demo-mountains'] })).json();
    assert.deepEqual(preview.memoryIds, ['demo-mountains']);
    assert.equal((await post(`/api/albums/${album.id}/share-preview`, { memoryIds: ['demo-family'] })).status, 400);
    const albumWorld = await (await post(`/api/albums/${album.id}/world`, {})).json();
    assert.equal(albumWorld.scene.memoryId, 'demo-mountains');
    assert.equal(albumWorld.scene.albumWorld.albumId, album.id);
    assert.match(albumWorld.scene.albumWorld.geometryNotice, /not metric/i);
    const cleared = await (await post('/api/account/clear-personal-data', { confirm: true })).json();
    assert.equal(cleared.cleared, true);
    assert.equal(backend.store.list().every(memory => memory.source === 'demo'), true);
    assert.equal((await readdir(path.join(directory, 'uploads'))).length, 0);
    assert.deepEqual((await (await fetch(`${url}/api/chapters`)).json()).chapters, []);
    const crossOrigin = await fetch(`${url}/api/search`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }) });
    assert.equal(crossOrigin.status, 403);
  } finally {
    backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await removeTestDirectory(directory);
  }
});

function nextMessage(socket: WebSocket, predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error('Timed out waiting for room message')); }, 3000);
    const listener = (raw: Buffer) => { const message = JSON.parse(raw.toString()); if (predicate(message)) { clearTimeout(timeout); socket.off('message', listener); resolve(message); } };
    socket.on('message', listener);
  });
}
test('two room clients synchronize selection, enforce host authority, and hand off host after disconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-room-'));
  const backend = await createBackend({ dataDir: directory, env: {} });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(backend.server.address() as { port: number }).port}/ws`;
  const host = new WebSocket(url); const guest = new WebSocket(url);
  try {
    const [hostWelcome, guestWelcome] = await Promise.all([nextMessage(host, message => message.type === 'welcome'), nextMessage(guest, message => message.type === 'welcome')]);
    const created = nextMessage(host, message => message.type === 'room');
    host.send(JSON.stringify({ type: 'create', name: 'Host', device: 'desktop' }));
    const room = (await created).room;
    const joined = nextMessage(guest, message => message.type === 'room');
    guest.send(JSON.stringify({ type: 'join', code: room.code, name: 'Guest', device: 'vr' }));
    assert.equal((await joined).room.members.length, 2);
    const blocked = nextMessage(guest, message => message.type === 'error');
    guest.send(JSON.stringify({ type: 'select', memoryId: 'demo-coast' }));
    assert.match((await blocked).message, /host/);
    const selected = nextMessage(guest, message => message.type === 'room' && message.room.memoryId === 'demo-coast');
    host.send(JSON.stringify({ type: 'select', memoryId: 'demo-coast' }));
    assert.equal((await selected).room.hostId, hostWelcome.clientId);
    const handed = nextMessage(guest, message => message.type === 'room' && message.room.members.length === 1);
    host.close();
    assert.equal((await handed).room.hostId, guestWelcome.clientId);
  } finally {
    host.terminate(); guest.terminate(); backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await removeTestDirectory(directory);
  }
});

test('Apify requires both ownership confirmations before any actor call and never returns configured secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-http-'));
  const secret = 'unit-test-token-must-not-escape';
  const backend = await createBackend({ dataDir: directory, env: { APIFY_TOKEN: secret } });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  try {
    for (const input of [
      { source: 'instagram', profileUrl: 'https://www.instagram.com/example/', limit: 1 },
      { source: 'instagram', profileUrl: 'https://www.instagram.com/example/', limit: 1, confirmOwnership: true, confirmConsent: false },
      { source: 'instagram', profileUrl: 'https://www.instagram.com/example/', limit: 1, confirmOwnership: false, confirmConsent: true },
    ]) {
      const response = await fetch(`${url}/api/integrations/apify/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), new RegExp(secret));
    }
    assert.doesNotMatch(await (await fetch(`${url}/api/health`)).text(), new RegExp(secret));
  } finally {
    backend.rooms.wss.close();
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    await removeTestDirectory(directory);
  }
});
