import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from './app.js';
import type { ApifyActorRunner } from './apify.js';
import type { Memory } from '../src/types.js';

async function fixture(env: NodeJS.ProcessEnv = {}, seed: Memory[] = [], apify?: ApifyActorRunner) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memoir-integrations-'));
  const backend = await createBackend({ dataDir: directory, env, seed, apify });
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  const localFetch = globalThis.fetch;
  return {
    directory, backend,
    request: (route: string, init?: RequestInit) => localFetch(base + route, init),
    post: (route: string, body: unknown) => localFetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    async clean() {
      backend.rooms.wss.close();
      await new Promise<void>(resolve => backend.server.close(() => resolve()));
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('memoir-integrations-'));
      await rm(resolved, { recursive: true, force: true });
    },
  };
}

test('consented social imports preserve videos with thumbnails and accept image-only posts', async t => {
  const f = await fixture({ APIFY_TOKEN: 'test-token' });
  const videoUrl = 'https://media.example.test/clip.mp4';
  const thumbnailUrl = 'https://media.example.test/preview.jpg';
  const imageUrl = 'https://media.example.test/photo.jpg';
  let actorCalls = 0;
  // These unsupported media hosts fail the archive allow-list before any DNS or
  // network request. Only the actor response is mocked; import/persistence run.
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.match(String(input), /^https:\/\/api\.apify\.com\/v2\/acts\//);
    actorCalls++;
    return Response.json([
      { id: 'clip', videoUrl, displayUrl: thumbnailUrl, caption: 'A moving memory', url: 'https://www.instagram.com/p/clip/' },
      { id: 'photo', thumbnailUrl: imageUrl, caption: 'A still memory' },
    ]);
  });
  try {
    const response = await f.post('/api/integrations/apify/import', {
      source: 'instagram', profileUrl: 'https://www.instagram.com/example/', confirmOwnership: true, confirmConsent: true,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(actorCalls, 1);
    assert.equal(result.imported, 2);
    const [video, photo] = result.memories;
    assert.equal(video.mediaType, 'video');
    assert.equal(video.url, videoUrl);
    assert.equal(video.thumbnailUrl, thumbnailUrl);
    assert.equal(photo.mediaType, 'image');
    assert.equal(photo.url, imageUrl);
    assert.equal(photo.thumbnailUrl, imageUrl);
    assert.equal(video.sourceUrl, 'https://www.instagram.com/p/clip/');
    assert.equal(video.sourceAccount, 'https://www.instagram.com/example/');
    assert.ok(video.organization);
    const consents = JSON.parse(await readFile(path.join(f.directory, 'import-consents.json'), 'utf8'));
    assert.equal(consents.length, 1);
    assert.equal(video.consentId, consents[0].id);
    assert.equal(photo.consentId, consents[0].id);
    assert.equal(f.backend.store.get(video.id)?.mediaType, 'video');
  } finally { await f.clean(); }
});

test('social imports require both consent confirmations before contacting the provider', async t => {
  const f = await fixture({ APIFY_TOKEN: 'test-token' });
  let actorCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    actorCalls++;
    throw new Error('No provider request is expected without consent.');
  });
  try {
    for (const confirmations of [{}, { confirmOwnership: false, confirmConsent: true }, { confirmOwnership: true, confirmConsent: false }]) {
      const response = await f.post('/api/integrations/apify/import', {
        source: 'instagram', profileUrl: 'https://www.instagram.com/example/', ...confirmations,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(actorCalls, 0);
    assert.deepEqual(f.backend.store.list(), []);
    await assert.rejects(readFile(path.join(f.directory, 'import-consents.json')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('archive retries include YouTube memories without running a paid actor', async t => {
  const memory: Memory = {
    id: 'youtube-clip', title: 'YouTube clip', description: '', date: '', location: '', tags: [],
    source: 'youtube', mediaType: 'video', url: 'https://media.example.test/clip.mp4', thumbnailUrl: '',
  };
  const f = await fixture({}, [memory]);
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    providerCalls++;
    throw new Error('Archive retries must not call a paid actor.');
  });
  try {
    const response = await f.post('/api/integrations/apify/archive', {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.archived, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /YouTube clip: could not archive media/);
    assert.equal(providerCalls, 0);
    assert.equal(f.backend.store.get(memory.id)?.url, memory.url);
  } finally { await f.clean(); }
});

test('Google OAuth preserves onboarding and sources return destinations with one-use state', async t => {
  const f = await fixture({ GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', APP_ORIGIN: 'https://memoir.example' });
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    assert.equal(init?.method, 'POST');
    assert.ok(new URLSearchParams(String(init?.body)).get('code_verifier'));
    exchanges++;
    return Response.json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600 });
  });
  try {
    for (const [context, destination] of [['onboarding', '?google=connected&onboarding=google'], ['sources', '?google=connected']]) {
      const auth = await f.request(`/api/integrations/google/auth-url?context=${context}`);
      assert.equal(auth.status, 200);
      const cookie = auth.headers.get('set-cookie')!.split(';')[0];
      const authorization = new URL((await auth.json()).url);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('redirect_uri'), 'https://memoir.example/api/integrations/google/callback');
      const state = authorization.searchParams.get('state');
      assert.ok(state);
      const callback = `/api/integrations/google/callback?state=${state}&code=test-code`;
      const connected = await f.request(callback, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(connected.status, 302);
      assert.equal(connected.headers.get('location'), `https://memoir.example/${destination}`);
      const status = await (await f.request('/api/integrations', { headers: { Cookie: cookie } })).json();
      assert.equal(status.googlePhotos.connected, true);
      const replay = await f.request(callback, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(replay.status, 400);
    }
    assert.equal(exchanges, 2);
  } finally { await f.clean(); }
});

const albumEnv = { APIFY_TOKEN: 'test-token', APIFY_GOOGLE_PHOTOS_ACTOR: 'memoir/google-photos-shared-album' };
const albumPhoto = (position: number) => ({
  mediaKey: `AF1Qip${position}`, position, width: 3024, height: 4032, takenAt: '2026-10-23T23:04:46.244Z', timezoneOffsetMinutes: -420,
  // An unsupported host fails the archive allow-list before any network request.
  imageUrl: `https://media.example.test/${position}.jpg`, originalUrl: `https://media.example.test/${position}-original.jpg`,
  thumbnailUrl: `https://media.example.test/${position}-thumb.jpg`, albumTitle: 'Cal Hacks 13.0 Community Album', albumUrl: 'https://photos.app.goo.gl/album',
});

test('shared Google Photos albums import through the Apify actor with consent and provenance', async () => {
  const calls: { actorId: string; input: Record<string, unknown>; limit: number }[] = [];
  const f = await fixture(albumEnv, [], async (token, actorId, input, options) => {
    assert.equal(token, 'test-token');
    calls.push({ actorId, input, limit: options.limit });
    return [albumPhoto(0), albumPhoto(1), { mediaKey: 'broken', imageUrl: 'javascript:alert(1)' }];
  });
  try {
    const response = await f.post('/api/integrations/apify/google-photos-album', { albumUrl: 'https://photos.app.goo.gl/album', limit: 2, confirmConsent: true });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(calls, [{ actorId: 'memoir/google-photos-shared-album', input: { albumUrl: 'https://photos.app.goo.gl/album', maxItems: 2 }, limit: 2 }]);
    // Test media hosts fail the archive allow-list, so both photos fail retryably
    // instead of being kept by link (a later import dedupes them normally).
    assert.equal(result.imported, 0);
    assert.deepEqual(result.warnings, ['2 photos could not be downloaded. Import the album again to retry them.']);
    assert.deepEqual(result.job.items.map((item: { status: string; retryable: boolean }) => [item.status, item.retryable]), [['failed', true], ['failed', true]]);
    assert.deepEqual(result.job.items.map((item: { sourceId: string }) => item.sourceId), ['AF1Qip0', 'AF1Qip1'], 'invalid rows never reach the job');
    assert.deepEqual(f.backend.store.list(), [], 'nothing is kept by remote link');
    const consents = JSON.parse(await readFile(path.join(f.directory, 'import-consents.json'), 'utf8'));
    assert.equal(consents.length, 1);
    assert.equal(consents[0].source, 'google-photos');
    assert.equal(consents[0].accountUrl, 'https://photos.app.goo.gl/album');
    const switcher = await f.post('/api/integrations/apify/google-photos-album', { albumUrl: 'https://photos.google.com/u/1/share/AF1Qip?key=k', limit: 2, confirmConsent: true });
    assert.equal(switcher.status, 200);
    assert.equal(calls.at(-1)?.input.albumUrl, 'https://photos.google.com/share/AF1Qip?key=k', 'account-switcher links are normalized');
  } finally { await f.clean(); }
});

test('album photos already in the library are not fetched again', async () => {
  const kept: Memory = {
    id: `google-album-${createHash('sha256').update('AF1Qip0').digest('hex').slice(0, 20)}`, title: 'Kept', description: '', date: '', location: '', tags: [],
    source: 'google-photos', mediaType: 'image', url: 'https://media.example.test/kept.jpg', thumbnailUrl: '',
  };
  const f = await fixture(albumEnv, [kept], async () => [albumPhoto(0), albumPhoto(1)]);
  try {
    const result = await (await f.post('/api/integrations/apify/google-photos-album', { albumUrl: 'https://photos.app.goo.gl/album', limit: 2, confirmConsent: true })).json();
    assert.deepEqual(result.job.items.map((item: { sourceId: string }) => item.sourceId), ['AF1Qip1']);
  } finally { await f.clean(); }
});

test('shared album imports explain missing setup and refuse other links before running the actor', async () => {
  let runs = 0;
  const runner: ApifyActorRunner = async () => { runs++; return []; };
  const unconfigured = await fixture({ APIFY_TOKEN: 'test-token' }, [], runner);
  try {
    const response = await unconfigured.post('/api/integrations/apify/google-photos-album', { albumUrl: 'https://photos.app.goo.gl/album', confirmConsent: true });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /APIFY_GOOGLE_PHOTOS_ACTOR/);
  } finally { await unconfigured.clean(); }
  const f = await fixture(albumEnv, [], runner);
  try {
    for (const body of [
      { albumUrl: 'https://photos.app.goo.gl/album', confirmConsent: false },
      { albumUrl: 'https://photos.google.com/album/x', confirmConsent: true },
      { albumUrl: 'https://evil.example/share/x', confirmConsent: true },
      { albumUrl: 'http://photos.app.goo.gl/album', confirmConsent: true },
    ]) assert.equal((await f.post('/api/integrations/apify/google-photos-album', body)).status, 400);
    assert.equal(runs, 0);
    await assert.rejects(readFile(path.join(f.directory, 'import-consents.json')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});
